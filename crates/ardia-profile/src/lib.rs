mod hist;
mod names;
mod record;
pub mod report;
mod runloop;
pub mod strict;
pub mod trace;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

pub use hist::{BUCKETS, Histogram, Snapshot, bucket_of, bucket_range};
pub use names::{FrameMetric, FrameSlot, Span, field_name};
pub use record::{
    ActionRow, CommandGuard, ENABLED, FRAME_BUDGET_US, FrameTimes, Hang, Opening, STALL_FLOOR_US,
    SpanGuard, actions, command, current_span, hang_total, keystroke_began, keystroke_handled,
    main_busy_for, mark_main_thread, note_input, note_window_input, now_ns, recent_hangs, record,
    record_frame, record_since, span, static_bytes, window_opening,
};

pub const ENV: &str = "ARDIA_PROFILE";
pub const TELEMETRY_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    On,
    Summary,
    Trace,
}

impl Mode {
    pub fn from_env(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("1" | "summary" | "log") => Mode::Summary,
            Some("trace") => Mode::Trace,
            _ => Mode::On,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Mode::On => "on",
            Mode::Summary => "summary",
            Mode::Trace => "trace",
        }
    }

    fn tick(self) -> Duration {
        match self {
            Mode::On => Duration::from_secs(60),
            Mode::Summary => Duration::from_secs(10),
            Mode::Trace => Duration::from_secs(5),
        }
    }
}

pub type Sink = Arc<dyn Fn(&'static str, Map<String, Value>) + Send + Sync>;
pub type Consent = Arc<dyn Fn() -> bool + Send + Sync>;

struct Started {
    mode: Mode,
    at: Instant,
    trace_path: Option<PathBuf>,
}

static STARTED: OnceLock<Started> = OnceLock::new();
static TELEMETRY: Mutex<Option<(Consent, Sink)>> = Mutex::new(None);
static STOPPING: AtomicBool = AtomicBool::new(false);

pub fn start(mode: Mode, data_dir: Option<&Path>) -> bool {
    if !ENABLED {
        return false;
    }
    mark_main_thread();
    let at = Instant::now();
    let trace_path = (mode == Mode::Trace).then(|| {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        data_dir
            .map(Path::to_path_buf)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("profile-{stamp}.json"))
    });
    if STARTED
        .set(Started {
            mode,
            at,
            trace_path,
        })
        .is_err()
    {
        return false;
    }
    if mode == Mode::Trace {
        trace::start(trace::CAPACITY);
    }
    if strict::enabled() {
        log::info!(target: "ardia::strict", "strict mode on: main-thread blocking, frames over {} ms and allocation-heavy frames are logged (ARDIA_STRICT=0 silences)", strict::FRAME_LIMIT_US / 1_000);
    }
    let watching = runloop::install();
    let spawned = std::thread::Builder::new()
        .name("ardia-profile".into())
        .spawn(move || report_loop(mode, at));
    if let Err(problem) = spawned {
        log::warn!("profiling can't report: {problem}");
    }
    log::info!(
        "profiling {} (main-thread stalls {}{})",
        mode.name(),
        if watching { "watched" } else { "not watched" },
        crate::trace_path()
            .map(|p| format!(", trace at {}", p.display()))
            .unwrap_or_default()
    );
    true
}

pub fn mode() -> Option<Mode> {
    STARTED.get().map(|s| s.mode)
}

pub fn trace_path() -> Option<&'static Path> {
    STARTED.get().and_then(|s| s.trace_path.as_deref())
}

pub fn snapshot_json() -> Value {
    let started = STARTED.get();
    let mut snapshot = report::snapshot_json(
        started.map(|s| s.mode.name()).unwrap_or("off"),
        started.map(|s| s.at),
    );
    if let Some(fields) = snapshot.as_object_mut() {
        fields.insert("strict".into(), strict::snapshot_json());
    }
    snapshot
}

pub fn set_telemetry(consent: Consent, sink: Sink) {
    if let Ok(mut slot) = TELEMETRY.lock() {
        *slot = Some((consent, sink));
    }
}

pub fn flush() {
    if let Some(path) = trace_path()
        && let Err(problem) = trace::write(path)
    {
        log::warn!("the profile trace wasn't written: {problem}");
    }
}

pub fn stop() {
    STOPPING.store(true, Ordering::Relaxed);
    flush();
}

fn report_loop(mode: Mode, started: Instant) {
    let mut telemetry = report::Telemetry::new(started);
    let mut last_summary: Option<report::Totals> = None;
    let mut written = 0;
    let mut last_telemetry = Instant::now();
    while !STOPPING.load(Ordering::Relaxed) {
        std::thread::sleep(mode.tick());
        if mode == Mode::Summary {
            let now = report::totals();
            log::info!(target: "ardia::profile", "{}", report::summary_text(last_summary.as_ref(), &now, 10));
            last_summary = Some(now);
        }
        if mode == Mode::Trace && trace::pushed() != written {
            written = trace::pushed();
            flush();
        }
        if last_telemetry.elapsed() >= Duration::from_secs(60) {
            last_telemetry = Instant::now();
            send_telemetry(&mut telemetry, Instant::now(), TELEMETRY_INTERVAL);
        }
    }
}

fn send_telemetry(telemetry: &mut report::Telemetry, now: Instant, interval: Duration) -> usize {
    let wired = TELEMETRY.lock().ok().and_then(|slot| slot.clone());
    let Some((consent, sink)) = wired else {
        telemetry.tick(false, now, interval);
        return 0;
    };
    let sharing = consent();
    let events = telemetry.tick(sharing, now, interval);
    let sent = events.len();
    for (name, fields) in events {
        sink(name, fields);
    }
    sent
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    pub(crate) static GLOBALS: Mutex<()> = Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        GLOBALS.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn modes_come_from_the_environment() {
        assert_eq!(Mode::from_env(None), Mode::On);
        assert_eq!(Mode::from_env(Some("0")), Mode::On);
        assert_eq!(Mode::from_env(Some("1")), Mode::Summary);
        assert_eq!(Mode::from_env(Some("trace")), Mode::Trace);
    }

    #[test]
    fn spans_land_in_their_histogram_and_track_the_current_span() {
        let _guard = lock();
        record::reset_for_tests();
        mark_main_thread();
        {
            let _outer = span(Span::OmniboxQuery);
            assert_eq!(current_span(), Some(Span::OmniboxQuery));
            {
                let _inner = span(Span::FaviconDecode);
                assert_eq!(current_span(), Some(Span::FaviconDecode));
            }
            assert_eq!(current_span(), Some(Span::OmniboxQuery));
        }
        assert_eq!(current_span(), None);
        record(Span::EngineReply, Duration::from_millis(3));
        let totals = report::totals();
        assert_eq!(totals.spans[Span::OmniboxQuery as usize].count, 1);
        assert_eq!(totals.spans[Span::FaviconDecode as usize].count, 1);
        let reply = totals.spans[Span::EngineReply as usize];
        assert_eq!(reply.count, 1);
        assert_eq!(reply.max_us, 3_000);
    }

    fn frame(slot: FrameSlot, window: u64, start: Instant, phases_ms: [u64; 3]) -> Instant {
        let prepaint_start = start + Duration::from_millis(phases_ms[0]);
        let prepaint_end = prepaint_start + Duration::from_millis(phases_ms[1]);
        let paint_end = prepaint_end + Duration::from_millis(phases_ms[2]);
        record_frame(
            slot,
            window,
            FrameTimes {
                started: start,
                prepaint_start,
                prepaint_end,
                paint_start: prepaint_end,
                paint_end,
            },
        );
        paint_end
    }

    #[test]
    fn frames_split_into_phases_and_count_late_and_dropped_frames() {
        let _guard = lock();
        record::reset_for_tests();
        let mut at = Instant::now();
        for _ in 0..5 {
            frame(FrameSlot::Settings, 9, at, [2, 1, 1]);
            at += Duration::from_micros(FRAME_BUDGET_US);
        }
        at += Duration::from_micros(FRAME_BUDGET_US);
        frame(FrameSlot::Settings, 9, at, [20, 1, 1]);
        let totals = report::totals();
        let index = FrameSlot::Settings as usize;
        assert_eq!(totals.frame_counts[index], [6, 1, 2]);
        let layout = totals.frames[index][FrameMetric::Layout as usize];
        assert_eq!(layout.count, 6);
        assert_eq!(layout.max_us, 20_000);
        assert_eq!(
            totals.frames[index][FrameMetric::Frame as usize].max_us,
            22_000
        );
        assert_eq!(totals.frame_counts[FrameSlot::Main as usize], [0, 0, 0]);
    }

    #[test]
    fn a_window_open_is_timed_to_its_first_frame() {
        let _guard = lock();
        record::reset_for_tests();
        let opening = window_opening(FrameSlot::Settings);
        std::thread::sleep(Duration::from_millis(5));
        opening.opened(77);
        frame(FrameSlot::Settings, 12, Instant::now(), [1, 1, 1]);
        assert_eq!(
            report::totals().spans[Span::FirstFrameSettings as usize].count,
            0,
            "another window's frame doesn't end the wait"
        );
        frame(FrameSlot::Settings, 77, Instant::now(), [1, 1, 1]);
        frame(FrameSlot::Settings, 77, Instant::now(), [1, 1, 1]);
        let totals = report::totals();
        assert_eq!(totals.spans[Span::OpenSettingsWindow as usize].count, 1);
        let first = totals.spans[Span::FirstFrameSettings as usize];
        assert_eq!(first.count, 1);
        assert!(first.max_us >= 5_000);
    }

    #[test]
    fn a_long_main_thread_turn_is_a_stall_named_after_its_slowest_span() {
        let _guard = lock();
        record::reset_for_tests();
        mark_main_thread();
        record::main_busy_began(now_ns());
        record(Span::SessionSave, Duration::from_millis(30));
        record(Span::OmniboxQuery, Duration::from_millis(300));
        record::main_busy_ended(now_ns() + 450_000_000);
        let hangs = recent_hangs();
        assert_eq!(hangs.len(), 1);
        assert_eq!(hangs[0].culprit, "omnibox.query");
        assert!(hangs[0].us >= 450_000);
        let totals = report::totals();
        assert_eq!(totals.stalls, [1, 0, 0, 0, 0, 0]);
        record::main_busy_began(now_ns());
        record::main_busy_ended(now_ns() + 1_000_000);
        assert_eq!(recent_hangs().len(), 1, "a short turn isn't a stall");
        record::main_busy_began(now_ns());
        keystroke_began();
        keystroke_handled(Some("workspace::NewTab"));
        record::main_busy_ended(now_ns() + 2_500_000_000);
        assert_eq!(report::totals().stalls, [1, 0, 0, 1, 0, 0]);
        assert_eq!(actions()[0].name, "workspace::NewTab");
    }

    #[test]
    fn a_slow_main_thread_span_is_a_stall_even_when_nested_run_loops_split_its_turn() {
        let _guard = lock();
        record::reset_for_tests();
        mark_main_thread();
        {
            let _open = span(Span::OpenSettingsWindow);
            {
                let _inner = span(Span::SettingsQuery);
                std::thread::sleep(Duration::from_millis(260));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let hangs = recent_hangs();
        assert_eq!(
            hangs.len(),
            1,
            "the outer span covers the inner one: one stall"
        );
        assert_eq!(hangs[0].culprit, "settings.query");
        record::main_busy_began(hangs[0].at_ns + 1);
        record::main_busy_ended(hangs[0].at_ns + 400_000_000);
        assert_eq!(
            recent_hangs().len(),
            1,
            "the turn holding it isn't counted again"
        );
        let off_main = std::thread::spawn(|| {
            let _span = span(Span::SyncCycle);
            std::thread::sleep(Duration::from_millis(260));
        });
        off_main.join().unwrap();
        assert_eq!(
            recent_hangs().len(),
            1,
            "background work isn't a main-thread stall"
        );
    }

    #[test]
    fn nothing_is_submitted_while_sharing_is_off() {
        let _guard = lock();
        record::reset_for_tests();
        let started = Instant::now();
        let mut telemetry = report::Telemetry::new(started);
        record(Span::OmniboxQuery, Duration::from_millis(4));
        record::note_stall(now_ns(), 900_000, "sync.cycle");
        let later = started + Duration::from_secs(7_200);
        assert!(
            telemetry
                .tick(false, started, TELEMETRY_INTERVAL)
                .is_empty()
        );
        assert!(telemetry.tick(false, later, TELEMETRY_INTERVAL).is_empty());
        let sent = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let seen = sent.clone();
        set_telemetry(
            Arc::new(|| false),
            Arc::new(move |name, _| seen.lock().unwrap().push(name)),
        );
        record::note_stall(now_ns(), 900_000, "sync.cycle");
        assert_eq!(send_telemetry(&mut telemetry, later, Duration::ZERO), 0);
        assert!(sent.lock().unwrap().is_empty());
        let on_at = later + Duration::from_secs(1);
        assert!(
            telemetry.tick(true, on_at, TELEMETRY_INTERVAL).is_empty(),
            "turning sharing on sends nothing from before, it starts a baseline"
        );
        record(Span::OmniboxQuery, Duration::from_millis(6));
        record::note_stall(record::ns_at(on_at) + 1, 500_000, "omnibox.query");
        let events = telemetry.tick(true, on_at + TELEMETRY_INTERVAL, TELEMETRY_INTERVAL);
        let names: Vec<&str> = events.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, ["app_freeze", "perf_gpui", "perf_omnibox"]);
        let freeze = &events[0].1;
        assert_eq!(freeze["freeze_duration"], "400ms_1s");
        assert_eq!(freeze["activity"], "omnibox.query");
        let omnibox = &events[2].1;
        assert_eq!(omnibox["samples"], 1);
        assert_eq!(omnibox["max_ms"], 6.0);
        let perf = &events[1].1;
        assert_eq!(perf["main_stall_500ms_1s"], 1);
        assert_eq!(perf["main_stall_250_500ms"], 0);
        assert!(perf.get("omnibox_query_count").is_none());
        assert!(telemetry.tick(false, on_at, TELEMETRY_INTERVAL).is_empty());
        *TELEMETRY.lock().unwrap() = None;
    }

    #[test]
    fn telemetry_carries_numbers_and_known_names_only() {
        let _guard = lock();
        record::reset_for_tests();
        let before = report::totals();
        record(Span::SettingsQuery, Duration::from_millis(12));
        frame(FrameSlot::Main, 3, Instant::now(), [3, 2, 1]);
        let after = report::totals();
        let fields = report::perf_event(&before, &after, TELEMETRY_INTERVAL);
        assert_eq!(fields["settings_query_count"], 1);
        assert_eq!(fields["settings_query_max_ms"], 12.0);
        assert_eq!(fields["frame_main_frames"], 1);
        assert_eq!(fields["frame_main_layout_max_ms"], 3.0);
        assert_eq!(fields["interval_s"], 3_600);
        for (key, value) in &fields {
            assert!(value.is_number(), "{key} is a number");
            assert!(
                key.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            );
        }
    }

    #[test]
    fn the_snapshot_has_a_stable_shape() {
        let _guard = lock();
        record::reset_for_tests();
        record(Span::ControlRequest, Duration::from_millis(2));
        let snapshot = snapshot_json();
        for key in [
            "enabled",
            "mode",
            "spans",
            "frames",
            "main_thread",
            "hangs",
            "actions",
            "trace",
            "memory_bytes",
            "strict",
        ] {
            assert!(snapshot.get(key).is_some(), "{key}");
        }
        assert_eq!(snapshot["spans"].as_object().unwrap().len(), Span::COUNT);
        assert_eq!(snapshot["spans"]["control.request"]["count"], 1);
        for field in [
            "count", "mean_ms", "p50_ms", "p90_ms", "p99_ms", "max_ms", "total_ms",
        ] {
            assert!(
                snapshot["spans"]["omnibox.query"][field].is_number(),
                "{field}"
            );
        }
        assert_eq!(
            snapshot["frames"].as_object().unwrap().len(),
            FrameSlot::COUNT
        );
        assert!(snapshot["frames"]["settings"]["input_to_frame"]["p99_ms"].is_number());
        assert!(snapshot["main_thread"]["stalls"]["over_10s"].is_number());
    }

    #[test]
    fn profiling_memory_stays_far_under_a_megabyte() {
        assert!(static_bytes() < 64 * 1024, "{}", static_bytes());
        let ring = trace::CAPACITY * std::mem::size_of::<trace::Event>();
        assert!(ring < 1024 * 1024, "{ring}");
    }

    #[test]
    fn the_summary_names_the_slow_parts() {
        let _guard = lock();
        record::reset_for_tests();
        let before = report::totals();
        record(Span::SessionRestore, Duration::from_millis(80));
        frame(FrameSlot::Settings, 5, Instant::now(), [30, 2, 1]);
        let text = report::summary_text(Some(&before), &report::totals(), 5);
        assert!(text.contains("frames settings: 1 drawn, 1 late"), "{text}");
        assert!(text.contains("session.restore"), "{text}");
    }
}

#[cfg(test)]
mod overhead {
    use super::*;

    #[test]
    #[ignore = "a timing measurement: cargo test --release -p ardia-profile -- --ignored --nocapture"]
    fn per_frame_and_per_span_cost() {
        let _guard = tests::GLOBALS.lock().unwrap_or_else(|e| e.into_inner());
        mark_main_thread();
        const ROUNDS: u32 = 2_000_000;
        let clock = Instant::now();
        for _ in 0..ROUNDS {
            std::hint::black_box(Instant::now());
        }
        let clock_ns = clock.elapsed().as_nanos() as f64 / f64::from(ROUNDS);
        let spans = Instant::now();
        for _ in 0..ROUNDS {
            let guard = span(std::hint::black_box(Span::OmniboxQuery));
            drop(guard);
        }
        let span_ns = spans.elapsed().as_nanos() as f64 / f64::from(ROUNDS);
        let frames = Instant::now();
        for n in 0..ROUNDS {
            let started = Instant::now();
            let prepaint_start = Instant::now();
            let prepaint_end = Instant::now();
            let paint_start = Instant::now();
            let paint_end = Instant::now();
            record_frame(
                FrameSlot::Main,
                std::hint::black_box(u64::from(n % 3) + 1),
                FrameTimes {
                    started,
                    prepaint_start,
                    prepaint_end,
                    paint_start,
                    paint_end,
                },
            );
        }
        let frame_ns = frames.elapsed().as_nanos() as f64 / f64::from(ROUNDS);
        println!(
            "Instant::now {clock_ns:.1} ns, span {span_ns:.1} ns, frame bookkeeping {frame_ns:.1} ns ({:.4}% of a 16.67 ms frame), static memory {} bytes",
            frame_ns / 16_666_667.0 * 100.0,
            static_bytes()
        );
    }
}
