use std::cell::Cell;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU8, AtomicU32, AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use crate::hist::Histogram;
use crate::names::{FrameMetric, FrameSlot, Span};
use crate::trace;

pub const ENABLED: bool = cfg!(feature = "enabled");
pub const FRAME_BUDGET_US: u64 = 16_667;
pub const STALL_FLOOR_US: u64 = 250_000;
pub const CULPRIT_FLOOR_US: u64 = 8_000;
const INPUT_LATENCY_CAP_NS: u64 = 250_000_000;
const OPEN_EXPIRY_NS: u64 = 60_000_000_000;
const NO_SPAN: u8 = u8::MAX;
const OFF_MAIN: u8 = u8::MAX - 1;
const MAX_LABELS: usize = 512;
const MAX_ACTIONS: usize = 32;
const MAX_HANGS: usize = 16;
pub const MAX_HANG_EVENTS: usize = 5;
pub const STALL_LIMITS_US: [u64; 5] = [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000];
pub const STALL_NAMES: [&str; 6] = ["250_500ms", "500ms_1s", "1_2s", "2_5s", "5_10s", "over_10s"];

pub(crate) static SPANS: [Histogram; Span::COUNT] = [const { Histogram::new() }; Span::COUNT];
pub(crate) static FRAMES: [[Histogram; FrameMetric::COUNT]; FrameSlot::COUNT] =
    [const { [const { Histogram::new() }; FrameMetric::COUNT] }; FrameSlot::COUNT];

pub(crate) struct SlotStats {
    pub frames: AtomicU64,
    pub late: AtomicU64,
    pub dropped: AtomicU64,
    last_end_ns: AtomicU64,
    chain: AtomicU32,
    input_ns: AtomicU64,
}

impl SlotStats {
    const fn new() -> Self {
        Self {
            frames: AtomicU64::new(0),
            late: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            last_end_ns: AtomicU64::new(0),
            chain: AtomicU32::new(0),
            input_ns: AtomicU64::new(0),
        }
    }
}

pub(crate) static SLOTS: [SlotStats; FrameSlot::COUNT] =
    [const { SlotStats::new() }; FrameSlot::COUNT];
pub(crate) static STALLS: [AtomicU64; 6] = [const { AtomicU64::new(0) }; 6];
pub(crate) static LONGEST_STALL_US: AtomicU64 = AtomicU64::new(0);
pub(crate) static BUSY_SINCE_NS: AtomicU64 = AtomicU64::new(0);
static CURRENT_SPAN: AtomicU8 = AtomicU8::new(NO_SPAN);
static CULPRIT: AtomicU32 = AtomicU32::new(0);
static CULPRIT_US: AtomicU64 = AtomicU64::new(0);
static KEY_STARTED_NS: AtomicU64 = AtomicU64::new(0);
pub(crate) static LAST_ACTIVE_NS: AtomicU64 = AtomicU64::new(0);
static BASE: OnceLock<Instant> = OnceLock::new();

thread_local! {
    static ON_MAIN: Cell<bool> = const { Cell::new(false) };
}

#[inline]
pub fn base() -> Instant {
    *BASE.get_or_init(Instant::now)
}

#[inline]
pub fn now_ns() -> u64 {
    ns_at(Instant::now())
}

#[inline]
pub fn ns_at(at: Instant) -> u64 {
    u64::try_from(at.saturating_duration_since(base()).as_nanos())
        .unwrap_or(u64::MAX)
        .max(1)
}

pub fn mark_main_thread() {
    base();
    ON_MAIN.with(|on| on.set(true));
}

#[inline]
pub(crate) fn on_main() -> bool {
    ON_MAIN.with(Cell::get)
}

#[cfg(debug_assertions)]
#[inline]
pub(crate) fn on_main_for_alloc() -> bool {
    ON_MAIN.try_with(Cell::get).unwrap_or(false)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Culprit {
    Span(Span),
    Frame(FrameSlot),
    Label(u32),
}

impl Culprit {
    const SPAN: u32 = 1 << 16;
    const FRAME: u32 = 2 << 16;
    const LABEL: u32 = 3 << 16;

    fn encode(self) -> u32 {
        match self {
            Culprit::Span(span) => Self::SPAN | span as u32,
            Culprit::Frame(slot) => Self::FRAME | slot as u32,
            Culprit::Label(index) => Self::LABEL | index,
        }
    }

    fn decode(raw: u32) -> Option<Self> {
        let low = raw & 0xffff;
        match raw & !0xffff {
            Self::SPAN => Span::from_index(low as usize).map(Culprit::Span),
            Self::FRAME => FrameSlot::from_index(low as usize).map(Culprit::Frame),
            Self::LABEL => Some(Culprit::Label(low)),
            _ => None,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Culprit::Span(span) => span.name(),
            Culprit::Frame(slot) => slot.trace_name(FrameMetric::Frame),
            Culprit::Label(index) => label(index).unwrap_or("unknown"),
        }
    }
}

#[inline]
fn offer_culprit(culprit: Culprit, us: u64) {
    if us >= CULPRIT_FLOOR_US && on_main() && us > CULPRIT_US.load(Relaxed) {
        CULPRIT_US.store(us, Relaxed);
        CULPRIT.store(culprit.encode(), Relaxed);
    }
}

fn take_culprit() -> Option<Culprit> {
    CULPRIT_US.store(0, Relaxed);
    Culprit::decode(CULPRIT.swap(0, Relaxed))
}

static LABELS: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

fn intern(name: &'static str) -> Option<u32> {
    let mut labels = LABELS.lock().ok()?;
    if let Some(index) = labels.iter().position(|known| *known == name) {
        return Some(index as u32);
    }
    if labels.len() >= MAX_LABELS {
        return None;
    }
    labels.push(name);
    Some(labels.len() as u32 - 1)
}

fn label(index: u32) -> Option<&'static str> {
    LABELS.lock().ok()?.get(index as usize).copied()
}

#[must_use = "a span measures until it is dropped"]
pub struct SpanGuard {
    span: Span,
    start: Option<Instant>,
    previous: u8,
}

#[cfg_attr(debug_assertions, track_caller)]
#[inline]
pub fn span(span: Span) -> SpanGuard {
    #[cfg(debug_assertions)]
    if matches!(span, Span::ImageDecode | Span::FaviconDecode) {
        crate::strict::blocking(crate::strict::Blocking::ImageDecode);
    }
    if !ENABLED {
        return SpanGuard {
            span,
            start: None,
            previous: OFF_MAIN,
        };
    }
    let previous = if on_main() {
        CURRENT_SPAN.swap(span as u8, Relaxed)
    } else {
        OFF_MAIN
    };
    SpanGuard {
        span,
        start: Some(Instant::now()),
        previous,
    }
}

impl Drop for SpanGuard {
    #[inline]
    fn drop(&mut self) {
        let Some(start) = self.start else {
            return;
        };
        let end = Instant::now();
        if self.previous != OFF_MAIN {
            CURRENT_SPAN.store(self.previous, Relaxed);
            let us = end.saturating_duration_since(start).as_micros() as u64;
            if us >= STALL_FLOOR_US {
                blocked_main(ns_at(start), ns_at(end), us, self.span.name());
            }
        }
        finish(self.span, start, end);
    }
}

#[inline]
fn finish(span: Span, start: Instant, end: Instant) {
    let elapsed = end.saturating_duration_since(start);
    SPANS[span as usize].record(elapsed);
    offer_culprit(Culprit::Span(span), elapsed.as_micros() as u64);
    #[cfg(debug_assertions)]
    if on_main() {
        crate::strict::note_span(span.name(), ns_at(start), elapsed);
    }
    if trace::on() {
        trace::push(span.name(), ns_at(start), elapsed);
    }
}

#[inline]
pub fn record(span: Span, elapsed: Duration) {
    if !ENABLED {
        return;
    }
    let end = Instant::now();
    finish(span, end.checked_sub(elapsed).unwrap_or(end), end);
}

#[inline]
pub fn record_since(span: Span, start: Instant) {
    if !ENABLED {
        return;
    }
    finish(span, start, Instant::now());
}

pub fn current_span() -> Option<Span> {
    Span::from_index(CURRENT_SPAN.load(Relaxed) as usize)
}

#[must_use = "a command measures until it is dropped"]
pub struct CommandGuard {
    name: &'static str,
    span: SpanGuard,
}

pub fn command(name: &'static str) -> CommandGuard {
    CommandGuard {
        name,
        span: span(Span::Command),
    }
}

impl Drop for CommandGuard {
    fn drop(&mut self) {
        let Some(start) = self.span.start else {
            return;
        };
        let us = start.elapsed().as_micros() as u64;
        if us >= CULPRIT_FLOOR_US {
            if let Some(index) = intern(self.name) {
                offer_culprit(Culprit::Label(index), us + 1);
            }
            note_action(self.name, us);
        }
    }
}

pub fn keystroke_began() {
    if ENABLED {
        let now = now_ns();
        KEY_STARTED_NS.store(now, Relaxed);
        LAST_ACTIVE_NS.store(now, Relaxed);
    }
}

pub fn keystroke_handled(action: Option<&'static str>) {
    if !ENABLED {
        return;
    }
    let started = KEY_STARTED_NS.swap(0, Relaxed);
    let (Some(name), true) = (action, started != 0) else {
        return;
    };
    let us = now_ns().saturating_sub(started) / 1_000;
    SPANS[Span::KeyAction as usize].record_us(us);
    note_action(name, us);
    if us >= CULPRIT_FLOOR_US
        && let Some(index) = intern(name)
    {
        offer_culprit(Culprit::Label(index), us + 1);
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ActionRow {
    pub name: &'static str,
    pub count: u64,
    pub total_us: u64,
    pub max_us: u64,
}

static ACTIONS: Mutex<[ActionRow; MAX_ACTIONS]> = Mutex::new(
    [ActionRow {
        name: "",
        count: 0,
        total_us: 0,
        max_us: 0,
    }; MAX_ACTIONS],
);

fn note_action(name: &'static str, us: u64) {
    let Ok(mut rows) = ACTIONS.lock() else {
        return;
    };
    if let Some(row) = rows.iter_mut().find(|row| row.name == name) {
        row.count += 1;
        row.total_us += us;
        row.max_us = row.max_us.max(us);
        return;
    }
    let Some(row) = rows
        .iter_mut()
        .min_by_key(|row| (row.count > 0, row.max_us))
    else {
        return;
    };
    if row.count == 0 || row.max_us < us {
        *row = ActionRow {
            name,
            count: 1,
            total_us: us,
            max_us: us,
        };
    }
}

pub fn actions() -> Vec<ActionRow> {
    let mut rows: Vec<ActionRow> = ACTIONS
        .lock()
        .map(|rows| rows.iter().copied().filter(|row| row.count > 0).collect())
        .unwrap_or_default();
    rows.sort_by_key(|row| std::cmp::Reverse(row.max_us));
    rows
}

#[derive(Clone, Copy, Debug)]
pub struct FrameTimes {
    pub started: Instant,
    pub prepaint_start: Instant,
    pub prepaint_end: Instant,
    pub paint_start: Instant,
    pub paint_end: Instant,
}

pub fn note_input(slot: FrameSlot) {
    if !ENABLED {
        return;
    }
    let now = now_ns();
    let _ = SLOTS[slot as usize]
        .input_ns
        .compare_exchange(0, now, Relaxed, Relaxed);
    LAST_ACTIVE_NS.store(now, Relaxed);
}

struct WindowSlot {
    window: AtomicU64,
    slot: AtomicU8,
}

static WINDOWS: [WindowSlot; 16] = [const {
    WindowSlot {
        window: AtomicU64::new(0),
        slot: AtomicU8::new(0),
    }
}; 16];

fn remember_window(window: u64, slot: FrameSlot) {
    let home = (window as usize) % WINDOWS.len();
    let entry = &WINDOWS[home];
    if entry.window.load(Relaxed) != window {
        entry.window.store(window, Relaxed);
        entry.slot.store(slot as u8, Relaxed);
    }
}

pub fn note_window_input(window: u64) {
    if !ENABLED || window == 0 {
        return;
    }
    let entry = &WINDOWS[(window as usize) % WINDOWS.len()];
    if entry.window.load(Relaxed) == window
        && let Some(slot) = FrameSlot::from_index(entry.slot.load(Relaxed) as usize)
    {
        note_input(slot);
    }
}

pub fn record_frame(slot: FrameSlot, window: u64, times: FrameTimes) {
    if !ENABLED {
        return;
    }
    remember_window(window, slot);
    let histograms = &FRAMES[slot as usize];
    let layout = times
        .prepaint_start
        .saturating_duration_since(times.started);
    let prepaint = times
        .prepaint_end
        .saturating_duration_since(times.prepaint_start);
    let paint = times.paint_end.saturating_duration_since(times.paint_start);
    let total = times.paint_end.saturating_duration_since(times.started);
    histograms[FrameMetric::Layout as usize].record(layout);
    histograms[FrameMetric::Prepaint as usize].record(prepaint);
    histograms[FrameMetric::Paint as usize].record(paint);
    histograms[FrameMetric::Frame as usize].record(total);
    let total_us = total.as_micros() as u64;
    let stats = &SLOTS[slot as usize];
    stats.frames.fetch_add(1, Relaxed);
    if total_us >= FRAME_BUDGET_US {
        stats.late.fetch_add(1, Relaxed);
    }
    let end_ns = ns_at(times.paint_end);
    let previous = stats.last_end_ns.swap(end_ns, Relaxed);
    let interval_us = end_ns.saturating_sub(previous) / 1_000;
    if previous != 0 && interval_us < FRAME_BUDGET_US * 6 {
        let chain = stats.chain.fetch_add(1, Relaxed) + 1;
        if chain >= 3 && interval_us * 2 > FRAME_BUDGET_US * 3 {
            let missed = (interval_us + FRAME_BUDGET_US / 2) / FRAME_BUDGET_US;
            stats.dropped.fetch_add(missed.saturating_sub(1), Relaxed);
        }
    } else {
        stats.chain.store(0, Relaxed);
    }
    let input = stats.input_ns.swap(0, Relaxed);
    if input != 0 && end_ns > input && end_ns - input <= INPUT_LATENCY_CAP_NS {
        histograms[FrameMetric::InputToFrame as usize].record_us((end_ns - input) / 1_000);
    }
    LAST_ACTIVE_NS.store(end_ns, Relaxed);
    offer_culprit(Culprit::Frame(slot), total_us);
    settle_opens(window, end_ns);
    if trace::on() {
        trace::push(
            slot.trace_name(FrameMetric::Frame),
            ns_at(times.started),
            total,
        );
        trace::push(
            slot.trace_name(FrameMetric::Layout),
            ns_at(times.started),
            layout,
        );
        trace::push(
            slot.trace_name(FrameMetric::Prepaint),
            ns_at(times.prepaint_start),
            prepaint,
        );
        trace::push(
            slot.trace_name(FrameMetric::Paint),
            ns_at(times.paint_start),
            paint,
        );
        if input != 0 && end_ns > input && end_ns - input <= INPUT_LATENCY_CAP_NS {
            trace::push(
                slot.trace_name(FrameMetric::InputToFrame),
                input,
                Duration::from_nanos(end_ns - input),
            );
        }
    }
}

struct PendingOpen {
    window: AtomicU64,
    started_ns: AtomicU64,
    slot: AtomicU8,
}

static OPENS: [PendingOpen; 8] = [const {
    PendingOpen {
        window: AtomicU64::new(0),
        started_ns: AtomicU64::new(0),
        slot: AtomicU8::new(0),
    }
}; 8];
static OPENS_LIVE: AtomicU32 = AtomicU32::new(0);

#[must_use = "say which window opened with Opening::opened"]
pub struct Opening {
    slot: FrameSlot,
    started_ns: u64,
    span: SpanGuard,
}

pub fn window_opening(slot: FrameSlot) -> Opening {
    Opening {
        slot,
        started_ns: if ENABLED { now_ns() } else { 0 },
        span: span(slot.open_span()),
    }
}

impl Opening {
    pub fn opened(self, window: u64) {
        let Opening {
            slot,
            started_ns,
            span,
        } = self;
        drop(span);
        if !ENABLED || window == 0 {
            return;
        }
        for open in &OPENS {
            if open
                .window
                .compare_exchange(0, window, Relaxed, Relaxed)
                .is_ok()
            {
                open.started_ns.store(started_ns, Relaxed);
                open.slot.store(slot as u8, Relaxed);
                OPENS_LIVE.fetch_add(1, Relaxed);
                return;
            }
        }
    }
}

fn settle_opens(window: u64, end_ns: u64) {
    if OPENS_LIVE.load(Relaxed) == 0 {
        return;
    }
    for open in &OPENS {
        let id = open.window.load(Relaxed);
        if id == 0 {
            continue;
        }
        let started = open.started_ns.load(Relaxed);
        let expired = end_ns.saturating_sub(started) > OPEN_EXPIRY_NS;
        if (id == window || expired)
            && open
                .window
                .compare_exchange(id, 0, Relaxed, Relaxed)
                .is_ok()
        {
            OPENS_LIVE.fetch_sub(1, Relaxed);
            if !expired && let Some(slot) = FrameSlot::from_index(open.slot.load(Relaxed) as usize)
            {
                let elapsed = Duration::from_nanos(end_ns.saturating_sub(started));
                SPANS[slot.first_frame_span() as usize].record(elapsed);
                if trace::on() {
                    trace::push(slot.first_frame_span().name(), started, elapsed);
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hang {
    pub at_ns: u64,
    pub us: u64,
    pub culprit: &'static str,
}

struct Hangs {
    recent: [Option<Hang>; MAX_HANGS],
    next: usize,
    total: u64,
    queued: Vec<Hang>,
    queued_ever: usize,
}

static HANGS: Mutex<Hangs> = Mutex::new(Hangs {
    recent: [None; MAX_HANGS],
    next: 0,
    total: 0,
    queued: Vec::new(),
    queued_ever: 0,
});

pub const HANG_EVENT_FLOOR_US: u64 = 400_000;

static REPORTED_UNTIL_NS: AtomicU64 = AtomicU64::new(0);

#[cold]
fn blocked_main(start_ns: u64, end_ns: u64, us: u64, name: &'static str) {
    if start_ns < REPORTED_UNTIL_NS.load(Relaxed) {
        return;
    }
    REPORTED_UNTIL_NS.fetch_max(end_ns, Relaxed);
    note_stall(start_ns, us, name);
}

pub(crate) fn main_busy_began(at_ns: u64) {
    BUSY_SINCE_NS.store(at_ns, Relaxed);
}

pub(crate) fn main_busy_ended(at_ns: u64) {
    let since = BUSY_SINCE_NS.swap(0, Relaxed);
    if since == 0 || at_ns <= since {
        take_culprit();
        return;
    }
    let us = (at_ns - since) / 1_000;
    SPANS[Span::MainBusy as usize].record_us(us);
    if us < STALL_FLOOR_US || since < REPORTED_UNTIL_NS.load(Relaxed) {
        if CULPRIT_US.load(Relaxed) != 0 {
            take_culprit();
        }
        return;
    }
    let culprit = take_culprit()
        .map(Culprit::name)
        .or_else(|| current_span().map(Span::name))
        .unwrap_or("unattributed");
    note_stall(since, us, culprit);
}

pub(crate) fn note_stall(at_ns: u64, us: u64, culprit: &'static str) {
    let bucket = STALL_LIMITS_US
        .iter()
        .position(|limit| us < *limit)
        .unwrap_or(STALL_LIMITS_US.len());
    STALLS[bucket].fetch_add(1, Relaxed);
    LONGEST_STALL_US.fetch_max(us, Relaxed);
    let hang = Hang { at_ns, us, culprit };
    if trace::on() {
        trace::push(culprit, at_ns, Duration::from_micros(us));
    }
    let Ok(mut hangs) = HANGS.lock() else {
        return;
    };
    let slot = hangs.next;
    hangs.recent[slot] = Some(hang);
    hangs.next = (slot + 1) % MAX_HANGS;
    hangs.total += 1;
    if us >= HANG_EVENT_FLOOR_US && hangs.queued_ever < MAX_HANG_EVENTS {
        hangs.queued_ever += 1;
        hangs.queued.push(hang);
    }
}

pub fn recent_hangs() -> Vec<Hang> {
    let Ok(hangs) = HANGS.lock() else {
        return Vec::new();
    };
    let mut list: Vec<Hang> = hangs.recent.iter().flatten().copied().collect();
    list.sort_by_key(|hang| std::cmp::Reverse(hang.at_ns));
    list
}

pub fn hang_total() -> u64 {
    HANGS.lock().map(|hangs| hangs.total).unwrap_or(0)
}

pub(crate) fn take_queued_hangs() -> Vec<Hang> {
    HANGS
        .lock()
        .map(|mut hangs| std::mem::take(&mut hangs.queued))
        .unwrap_or_default()
}

pub fn main_busy_for() -> Option<Duration> {
    let since = BUSY_SINCE_NS.load(Relaxed);
    (since != 0).then(|| Duration::from_nanos(now_ns().saturating_sub(since)))
}

pub fn static_bytes() -> usize {
    std::mem::size_of_val(&SPANS)
        + std::mem::size_of_val(&FRAMES)
        + std::mem::size_of_val(&SLOTS)
        + std::mem::size_of_val(&OPENS)
        + std::mem::size_of_val(&WINDOWS)
        + std::mem::size_of::<[ActionRow; MAX_ACTIONS]>()
        + std::mem::size_of::<[Option<Hang>; MAX_HANGS]>()
        + MAX_LABELS * std::mem::size_of::<&str>()
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    for histogram in SPANS.iter().chain(FRAMES.iter().flatten()) {
        histogram.reset();
    }
    for stats in &SLOTS {
        stats.frames.store(0, Relaxed);
        stats.late.store(0, Relaxed);
        stats.dropped.store(0, Relaxed);
        stats.last_end_ns.store(0, Relaxed);
        stats.chain.store(0, Relaxed);
        stats.input_ns.store(0, Relaxed);
    }
    for stall in &STALLS {
        stall.store(0, Relaxed);
    }
    LONGEST_STALL_US.store(0, Relaxed);
    REPORTED_UNTIL_NS.store(0, Relaxed);
    if let Ok(mut hangs) = HANGS.lock() {
        hangs.recent = [None; MAX_HANGS];
        hangs.total = 0;
        hangs.queued.clear();
        hangs.queued_ever = 0;
    }
}
