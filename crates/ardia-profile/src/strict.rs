use std::time::{Duration, Instant};

use serde_json::Value;

use crate::names::FrameSlot;
use crate::record::FrameTimes;

pub const ENV: &str = "ARDIA_STRICT";
pub const LOCK_WAIT_LIMIT: Duration = Duration::from_millis(2);
pub const FRAME_LIMIT_US: u64 = 8_000;
pub const FRAME_ALLOC_LIMIT: u64 = 5_000;
pub const COMPILED: bool = cfg!(debug_assertions);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Blocking {
    File,
    Network,
    Ipc,
    Keychain,
    LockWait,
    ImageDecode,
}

impl Blocking {
    pub const fn name(self) -> &'static str {
        match self {
            Blocking::File => "file_io",
            Blocking::Network => "network",
            Blocking::Ipc => "ipc",
            Blocking::Keychain => "keychain",
            Blocking::LockWait => "lock_wait",
            Blocking::ImageDecode => "image_decode",
        }
    }
}

#[cfg(debug_assertions)]
pub use checks::{CountingAlloc, set_enabled};

#[cfg(debug_assertions)]
mod checks {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::backtrace::Backtrace;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::panic::Location;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU8, Ordering::Relaxed};
    use std::time::{Duration, Instant};

    use serde_json::{Map, Value, json};

    use super::{Blocking, FRAME_ALLOC_LIMIT, FRAME_LIMIT_US, LOCK_WAIT_LIMIT};
    use crate::names::{FrameMetric, FrameSlot};
    use crate::record::{self, FrameTimes};

    const UNSET: u8 = 0;
    const ON: u8 = 1;
    const OFF: u8 = 2;
    const MAX_FINDINGS: usize = 256;
    const MAX_FRAME_SPANS: usize = 64;
    const REPORTED_SPANS: usize = 3;

    static STATE: AtomicU8 = AtomicU8::new(UNSET);

    struct Finding {
        kind: &'static str,
        site: &'static Location<'static>,
        count: u64,
        worst_us: u64,
        detail: String,
    }

    #[derive(Clone, Default)]
    struct SlowFrame {
        count: u64,
        worst_us: u64,
        logged_us: u64,
        phase: &'static str,
        spans: Vec<(&'static str, u64)>,
        allocations: u64,
    }

    #[derive(Clone, Default)]
    struct HeavyFrame {
        count: u64,
        worst: u64,
        logged: u64,
    }

    struct Ledger {
        findings: Vec<Finding>,
        slow: [SlowFrame; FrameSlot::COUNT],
        heavy: [HeavyFrame; FrameSlot::COUNT],
    }

    static LEDGER: Mutex<Option<Ledger>> = Mutex::new(None);

    thread_local! {
        static MAIN_ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
        static FRAME_SPANS: RefCell<VecDeque<(&'static str, u64, u64)>> = const { RefCell::new(VecDeque::new()) };
    }

    pub fn set_enabled(on: bool) {
        STATE.store(if on { ON } else { OFF }, Relaxed);
    }

    pub fn enabled() -> bool {
        match STATE.load(Relaxed) {
            ON => true,
            OFF => false,
            _ => {
                let on = std::env::var(super::ENV).map_or(true, |v| v.trim() != "0");
                set_enabled(on);
                on
            }
        }
    }

    fn with_ledger<R>(f: impl FnOnce(&mut Ledger) -> R) -> Option<R> {
        let mut slot = LEDGER.lock().ok()?;
        let ledger = slot.get_or_insert_with(|| Ledger {
            findings: Vec::new(),
            slow: Default::default(),
            heavy: Default::default(),
        });
        Some(f(ledger))
    }

    fn note(kind: Blocking, site: &'static Location<'static>, us: u64) {
        let first = with_ledger(|ledger| {
            if let Some(known) = ledger
                .findings
                .iter_mut()
                .find(|f| f.kind == kind.name() && f.site == site)
            {
                known.count += 1;
                known.worst_us = known.worst_us.max(us);
                return false;
            }
            if ledger.findings.len() >= MAX_FINDINGS {
                return false;
            }
            ledger.findings.push(Finding {
                kind: kind.name(),
                site,
                count: 1,
                worst_us: us,
                detail: record::current_span()
                    .map(|span| format!("inside {}", span.name()))
                    .unwrap_or_default(),
            });
            true
        });
        if first == Some(true) {
            log::warn!(
                target: "ardia::strict",
                "main thread blocked: {} at {}:{}{}\n{}",
                kind.name(),
                site.file(),
                site.line(),
                if us > 0 {
                    format!(" ({:.1} ms)", us as f64 / 1_000.0)
                } else {
                    String::new()
                },
                Backtrace::force_capture()
            );
        }
    }

    #[track_caller]
    pub fn blocking(kind: Blocking) {
        if enabled() && record::on_main() {
            note(kind, Location::caller(), 0);
        }
    }

    #[track_caller]
    pub fn waited(kind: Blocking, started: Instant) {
        let waited = started.elapsed();
        if waited > LOCK_WAIT_LIMIT && enabled() && record::on_main() {
            note(kind, Location::caller(), waited.as_micros() as u64);
        }
    }

    #[track_caller]
    pub fn lock<T>(acquire: impl FnOnce() -> T) -> T {
        let started = Instant::now();
        let guard = acquire();
        waited(Blocking::LockWait, started);
        guard
    }

    pub fn note_span(name: &'static str, start_ns: u64, elapsed: Duration) {
        if !enabled() {
            return;
        }
        let us = elapsed.as_micros() as u64;
        FRAME_SPANS.with(|spans| {
            if let Ok(mut spans) = spans.try_borrow_mut() {
                if spans.len() >= MAX_FRAME_SPANS {
                    spans.pop_front();
                }
                spans.push_back((name, start_ns, us));
            }
        });
    }

    pub fn alloc_mark() -> u64 {
        MAIN_ALLOCATIONS.with(Cell::get)
    }

    fn spans_since(start_ns: u64) -> Vec<(&'static str, u64)> {
        let mut found: Vec<(&'static str, u64)> = FRAME_SPANS.with(|spans| {
            spans
                .try_borrow_mut()
                .map(|mut spans| {
                    let kept = spans
                        .iter()
                        .filter(|(_, at, _)| *at >= start_ns)
                        .map(|(name, _, us)| (*name, *us))
                        .collect();
                    spans.clear();
                    kept
                })
                .unwrap_or_default()
        });
        found.sort_by_key(|(_, us)| std::cmp::Reverse(*us));
        found.truncate(REPORTED_SPANS);
        found
    }

    pub fn frame(slot: FrameSlot, times: &FrameTimes, allocations_before: u64) {
        if !enabled() {
            return;
        }
        let allocations = alloc_mark().saturating_sub(allocations_before);
        let total = times.paint_end.saturating_duration_since(times.started);
        let total_us = total.as_micros() as u64;
        let spans = spans_since(record::ns_at(times.started));
        let phases = [
            (
                FrameMetric::Layout,
                times
                    .prepaint_start
                    .saturating_duration_since(times.started),
            ),
            (
                FrameMetric::Prepaint,
                times
                    .prepaint_end
                    .saturating_duration_since(times.prepaint_start),
            ),
            (
                FrameMetric::Paint,
                times.paint_end.saturating_duration_since(times.paint_start),
            ),
        ];
        let phase = phases
            .iter()
            .max_by_key(|(_, took)| *took)
            .map_or("frame", |(metric, _)| metric.name());
        let index = slot as usize;
        let report = with_ledger(|ledger| {
            let mut slow_line = None;
            if total_us > FRAME_LIMIT_US {
                let slow = &mut ledger.slow[index];
                slow.count += 1;
                if total_us > slow.worst_us {
                    slow.worst_us = total_us;
                    slow.phase = phase;
                    slow.spans.clone_from(&spans);
                    slow.allocations = allocations;
                }
                if total_us >= slow.logged_us.saturating_mul(3) / 2 {
                    slow.logged_us = total_us;
                    slow_line = Some(total_us);
                }
            }
            let mut heavy_line = None;
            if allocations > FRAME_ALLOC_LIMIT {
                let heavy = &mut ledger.heavy[index];
                heavy.count += 1;
                heavy.worst = heavy.worst.max(allocations);
                if allocations >= heavy.logged.saturating_mul(3) / 2 {
                    heavy.logged = allocations;
                    heavy_line = Some(allocations);
                }
            }
            (slow_line, heavy_line)
        });
        let Some((slow_line, heavy_line)) = report else {
            return;
        };
        let named = spans
            .iter()
            .map(|(name, us)| format!("{name} {:.1} ms", *us as f64 / 1_000.0))
            .collect::<Vec<_>>()
            .join(", ");
        if let Some(us) = slow_line {
            log::warn!(
                target: "ardia::strict",
                "slow frame: {} window {:.1} ms (budget {} ms), mostly {}{}",
                slot.name(),
                us as f64 / 1_000.0,
                FRAME_LIMIT_US / 1_000,
                phase,
                if named.is_empty() {
                    String::new()
                } else {
                    format!("; slowest spans: {named}")
                }
            );
        }
        if let Some(count) = heavy_line {
            log::warn!(
                target: "ardia::strict",
                "allocation-heavy frame: {} window made {count} allocations (limit {FRAME_ALLOC_LIMIT}), mostly {}",
                slot.name(),
                phase
            );
        }
    }

    pub fn snapshot_json() -> Value {
        let on = enabled();
        with_ledger(|ledger| {
            let findings: Vec<Value> = ledger
                .findings
                .iter()
                .map(|f| {
                    json!({
                        "kind": f.kind,
                        "site": format!("{}:{}", f.site.file(), f.site.line()),
                        "count": f.count,
                        "worst_ms": f.worst_us as f64 / 1_000.0,
                        "detail": f.detail,
                    })
                })
                .collect();
            let mut frames = Map::new();
            for slot in FrameSlot::ALL {
                let slow = &ledger.slow[*slot as usize];
                let heavy = &ledger.heavy[*slot as usize];
                if slow.count == 0 && heavy.count == 0 {
                    continue;
                }
                frames.insert(
                    slot.name().into(),
                    json!({
                        "slow": slow.count,
                        "worst_ms": slow.worst_us as f64 / 1_000.0,
                        "worst_phase": slow.phase,
                        "worst_spans": slow.spans.iter().map(|(name, us)| json!({"span": name, "ms": *us as f64 / 1_000.0})).collect::<Vec<_>>(),
                        "worst_allocations": slow.allocations,
                        "allocation_heavy": heavy.count,
                        "most_allocations": heavy.worst,
                    }),
                );
            }
            json!({
                "compiled": true,
                "enabled": on,
                "limits": {
                    "frame_ms": FRAME_LIMIT_US as f64 / 1_000.0,
                    "lock_wait_ms": LOCK_WAIT_LIMIT.as_secs_f64() * 1_000.0,
                    "frame_allocations": FRAME_ALLOC_LIMIT,
                },
                "findings": findings,
                "frames": frames,
            })
        })
        .unwrap_or_else(|| json!({"compiled": true, "enabled": on}))
    }

    #[cfg(test)]
    pub fn reset_for_tests() {
        if let Ok(mut slot) = LEDGER.lock() {
            *slot = None;
        }
        FRAME_SPANS.with(|spans| {
            if let Ok(mut spans) = spans.try_borrow_mut() {
                spans.clear();
            }
        });
    }

    pub struct CountingAlloc;

    #[inline]
    fn count() {
        if record::on_main_for_alloc() {
            let _ = MAIN_ALLOCATIONS.try_with(|n| n.set(n.get() + 1));
        }
    }

    unsafe impl GlobalAlloc for CountingAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            count();
            unsafe { System.alloc(layout) }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            count();
            unsafe { System.alloc_zeroed(layout) }
        }

        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            count();
            unsafe { System.realloc(ptr, layout, new_size) }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }
    }
}

#[cfg(debug_assertions)]
#[inline]
pub fn enabled() -> bool {
    checks::enabled()
}

#[cfg(not(debug_assertions))]
#[inline(always)]
pub const fn enabled() -> bool {
    false
}

#[cfg(debug_assertions)]
#[track_caller]
#[inline]
pub fn blocking(kind: Blocking) {
    checks::blocking(kind);
}

#[cfg(not(debug_assertions))]
#[inline(always)]
pub fn blocking(_kind: Blocking) {}

#[cfg(debug_assertions)]
#[track_caller]
#[inline]
pub fn waited(kind: Blocking, started: Instant) {
    checks::waited(kind, started);
}

#[cfg(not(debug_assertions))]
#[inline(always)]
pub fn waited(_kind: Blocking, _started: Instant) {}

#[cfg(debug_assertions)]
#[track_caller]
#[inline]
pub fn lock<T>(acquire: impl FnOnce() -> T) -> T {
    checks::lock(acquire)
}

#[cfg(not(debug_assertions))]
#[inline(always)]
pub fn lock<T>(acquire: impl FnOnce() -> T) -> T {
    acquire()
}

#[cfg(debug_assertions)]
#[inline]
pub fn alloc_mark() -> u64 {
    checks::alloc_mark()
}

#[cfg(not(debug_assertions))]
#[inline(always)]
pub const fn alloc_mark() -> u64 {
    0
}

#[cfg(debug_assertions)]
#[inline]
pub(crate) fn note_span(name: &'static str, start_ns: u64, elapsed: Duration) {
    checks::note_span(name, start_ns, elapsed);
}

#[cfg(debug_assertions)]
#[inline]
pub fn frame(slot: FrameSlot, times: &FrameTimes, allocations_before: u64) {
    checks::frame(slot, times, allocations_before);
}

#[cfg(not(debug_assertions))]
#[inline(always)]
pub fn frame(_slot: FrameSlot, _times: &FrameTimes, _allocations_before: u64) {}

#[cfg(debug_assertions)]
pub fn snapshot_json() -> Value {
    checks::snapshot_json()
}

#[cfg(not(debug_assertions))]
pub fn snapshot_json() -> Value {
    serde_json::json!({ "compiled": false, "enabled": false })
}

pub struct Mutex<T: ?Sized>(parking_lot::Mutex<T>);

impl<T> Mutex<T> {
    pub const fn new(value: T) -> Self {
        Mutex(parking_lot::const_mutex(value))
    }

    pub fn into_inner(self) -> T {
        self.0.into_inner()
    }
}

impl<T: ?Sized> Mutex<T> {
    #[cfg_attr(debug_assertions, track_caller)]
    #[inline]
    pub fn lock(&self) -> parking_lot::MutexGuard<'_, T> {
        lock(|| self.0.lock())
    }
}

impl<T: ?Sized> std::ops::Deref for Mutex<T> {
    type Target = parking_lot::Mutex<T>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T: Default> Default for Mutex<T> {
    fn default() -> Self {
        Mutex::new(T::default())
    }
}

impl<T: ?Sized + std::fmt::Debug> std::fmt::Debug for Mutex<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

pub struct RwLock<T: ?Sized>(parking_lot::RwLock<T>);

impl<T> RwLock<T> {
    pub const fn new(value: T) -> Self {
        RwLock(parking_lot::const_rwlock(value))
    }

    pub fn into_inner(self) -> T {
        self.0.into_inner()
    }
}

impl<T: ?Sized> RwLock<T> {
    #[cfg_attr(debug_assertions, track_caller)]
    #[inline]
    pub fn read(&self) -> parking_lot::RwLockReadGuard<'_, T> {
        lock(|| self.0.read())
    }

    #[cfg_attr(debug_assertions, track_caller)]
    #[inline]
    pub fn write(&self) -> parking_lot::RwLockWriteGuard<'_, T> {
        lock(|| self.0.write())
    }
}

impl<T: ?Sized> std::ops::Deref for RwLock<T> {
    type Target = parking_lot::RwLock<T>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T: Default> Default for RwLock<T> {
    fn default() -> Self {
        RwLock::new(T::default())
    }
}

impl<T: ?Sized + std::fmt::Debug> std::fmt::Debug for RwLock<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use crate::record::{mark_main_thread, reset_for_tests};
    use crate::tests::GLOBALS;

    fn lock_globals() -> std::sync::MutexGuard<'static, ()> {
        GLOBALS.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn findings() -> Vec<Value> {
        snapshot_json()["findings"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    #[test]
    fn main_thread_blocking_is_noted_once_per_call_site() {
        let _guard = lock_globals();
        reset_for_tests();
        checks::reset_for_tests();
        set_enabled(true);
        mark_main_thread();
        for _ in 0..3 {
            blocking(Blocking::File);
        }
        blocking(Blocking::Keychain);
        let found = findings();
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0]["kind"], "file_io");
        assert_eq!(found[0]["count"], 3);
        assert!(found[0]["site"].as_str().unwrap().contains("strict.rs"));
        let off_main = std::thread::spawn(|| blocking(Blocking::Network));
        off_main.join().unwrap();
        assert_eq!(findings().len(), 2, "background threads may block");
    }

    #[test]
    fn short_lock_waits_pass_and_long_ones_are_noted() {
        let _guard = lock_globals();
        checks::reset_for_tests();
        set_enabled(true);
        mark_main_thread();
        let mutex = std::sync::Mutex::new(0);
        drop(lock(|| mutex.lock()));
        assert!(findings().is_empty());
        waited(
            Blocking::LockWait,
            Instant::now() - Duration::from_millis(5),
        );
        let found = findings();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["kind"], "lock_wait");
        assert!(found[0]["worst_ms"].as_f64().unwrap() >= 5.0);
    }

    #[test]
    fn slow_frames_name_their_window_phase_and_spans() {
        let _guard = lock_globals();
        reset_for_tests();
        checks::reset_for_tests();
        set_enabled(true);
        mark_main_thread();
        let started = Instant::now();
        crate::record(crate::Span::SettingsQuery, Duration::from_millis(1));
        note_span(
            "settings.query",
            crate::record::ns_at(started) + 1,
            Duration::from_millis(6),
        );
        let times = FrameTimes {
            started,
            prepaint_start: started + Duration::from_millis(9),
            prepaint_end: started + Duration::from_millis(10),
            paint_start: started + Duration::from_millis(10),
            paint_end: started + Duration::from_millis(11),
        };
        frame(FrameSlot::Settings, &times, alloc_mark());
        let snapshot = snapshot_json();
        let settings = &snapshot["frames"]["settings"];
        assert_eq!(settings["slow"], 1);
        assert_eq!(settings["worst_phase"], "layout");
        assert_eq!(settings["worst_spans"][0]["span"], "settings.query");
        let fast = FrameTimes {
            started,
            prepaint_start: started,
            prepaint_end: started,
            paint_start: started,
            paint_end: started + Duration::from_millis(2),
        };
        frame(FrameSlot::Main, &fast, alloc_mark());
        assert!(snapshot_json()["frames"].get("main").is_none());
    }

    #[test]
    fn silenced_strict_mode_records_nothing() {
        let _guard = lock_globals();
        checks::reset_for_tests();
        set_enabled(false);
        mark_main_thread();
        blocking(Blocking::Ipc);
        assert!(findings().is_empty());
        assert_eq!(snapshot_json()["enabled"], false);
        set_enabled(true);
    }

    #[test]
    fn the_wrapped_locks_note_long_waits_on_the_main_thread() {
        let _guard = lock_globals();
        checks::reset_for_tests();
        set_enabled(true);
        mark_main_thread();
        let shared = std::sync::Arc::new(Mutex::new(0_u32));
        let held = shared.lock();
        let other = std::sync::Arc::clone(&shared);
        let (ready, wait) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let mut value = other.lock();
            ready.send(()).ok();
            std::thread::sleep(Duration::from_millis(20));
            *value += 1;
        });
        drop(held);
        wait.recv().ok();
        *shared.lock() += 1;
        holder.join().ok();
        assert_eq!(*shared.lock(), 2);
        let found = findings();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0]["kind"], "lock_wait");
        let state = RwLock::new(vec![1]);
        state.write().push(2);
        assert_eq!(state.read().len(), 2);
        assert!(state.try_read().is_some());
    }

    #[test]
    fn image_decodes_on_the_main_thread_are_noted() {
        let _guard = lock_globals();
        checks::reset_for_tests();
        set_enabled(true);
        mark_main_thread();
        drop(crate::span(crate::Span::ImageDecode));
        drop(crate::span(crate::Span::OmniboxQuery));
        let found = findings();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0]["kind"], "image_decode");
    }
}
