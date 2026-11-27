use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use ardia_engine::EngineEvent;
use ardia_state::BrowserState;
use ardia_telemetry::{Consent, consent_now, still_valid};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::coordinator::AppCoordinator;

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;
const FIRST_MEMORY_SAMPLE: Duration = Duration::from_secs(10 * 60);
const LAUNCH_SETTLE: Duration = Duration::from_secs(3);
const MAX_PAGE_PROCESS_EVENTS: u32 = 30;
const GONE_REASONS: [&str; 7] = [
    "abnormal",
    "killed",
    "crashed",
    "oom",
    "launchFailed",
    "integrity",
    "unknown",
];
const HANG_BUCKETS: [(i64, &str); 4] = [
    (5_000, "renderer_unresponsive_under_5s"),
    (30_000, "renderer_unresponsive_5_30s"),
    (120_000, "renderer_unresponsive_30s_2m"),
    (i64::MAX, "renderer_unresponsive_over_2m"),
];

static STARTED_AT: AtomicI64 = AtomicI64::new(0);
static COORDINATOR: Mutex<Option<Weak<AppCoordinator>>> = Mutex::new(None);
static MARKS: Mutex<LaunchMarks> = Mutex::new(LaunchMarks::new());
static LAUNCH_SENT: AtomicBool = AtomicBool::new(false);
static PAGE_GONE: Mutex<PageGone> = Mutex::new(PageGone {
    shared: 0,
    local: 0,
    gone_this_session: 0,
});
static HANGS: Mutex<Hangs> = Mutex::new(Hangs {
    open: None,
    taken: None,
});
static MAIN_WORK: Mutex<Option<(i64, f64, f64)>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Usage {
    pub page_ins: i64,
    pub block_reads: i64,
    pub cpu_ms: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Mark {
    at: i64,
    usage: Option<Usage>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct LaunchMarks {
    main: Option<Mark>,
    engine: Option<Mark>,
    first_window: Option<i64>,
}

impl LaunchMarks {
    const fn new() -> Self {
        LaunchMarks {
            main: None,
            engine: None,
            first_window: None,
        }
    }
}

struct PageGone {
    shared: u32,
    local: u32,
    gone_this_session: u32,
}

struct Hangs {
    open: Option<HashMap<String, (i64, String)>>,
    taken: Option<HashMap<&'static str, u64>>,
}

pub fn now_ms() -> i64 {
    ardia_telemetry::ids::now_ms()
}

pub fn resource_usage() -> Option<Usage> {
    #[cfg(unix)]
    {
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } == 0 {
            let ms = |t: libc::timeval| t.tv_sec * 1000 + i64::from(t.tv_usec) / 1000;
            return Some(Usage {
                page_ins: usage.ru_majflt,
                block_reads: usage.ru_inblock,
                cpu_ms: ms(usage.ru_utime) + ms(usage.ru_stime),
            });
        }
    }
    None
}

pub fn process_start_ms() -> Option<i64> {
    #[cfg(target_os = "macos")]
    {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let read = unsafe {
            libc::proc_pidinfo(
                libc::getpid(),
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if read == size && info.pbi_start_tvsec > 0 {
            return Some(info.pbi_start_tvsec as i64 * 1000 + info.pbi_start_tvusec as i64 / 1000);
        }
    }
    None
}

pub fn mark_main() {
    MARKS.lock().main.get_or_insert(Mark {
        at: now_ms(),
        usage: resource_usage(),
    });
}

pub fn mark_engine_started() {
    MARKS.lock().engine.get_or_insert(Mark {
        at: now_ms(),
        usage: resource_usage(),
    });
}

pub fn mark_first_window() {
    let first = {
        let mut marks = MARKS.lock();
        let first = marks.first_window.is_none();
        marks.first_window.get_or_insert(now_ms());
        first
    };
    if first && let Some(client) = ardia_telemetry::client() {
        let consent = consent_now();
        client.every(LAUNCH_SETTLE, None, move || send_launch(consent.as_ref()));
    }
}

fn sysctl_string(name: &std::ffi::CStr) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mut size = 0usize;
        if unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
            || size == 0
        {
            return None;
        }
        let mut buffer = vec![0u8; size];
        if unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return None;
        }
        let text = String::from_utf8_lossy(&buffer[..size])
            .trim_end_matches('\0')
            .trim()
            .to_owned();
        return Some(text).filter(|t| !t.is_empty());
    }
    #[allow(unreachable_code)]
    {
        let _ = name;
        None
    }
}

fn sysctl_number(name: &std::ffi::CStr) -> Option<i64> {
    #[cfg(target_os = "macos")]
    {
        let mut value: i32 = 0;
        let mut size = std::mem::size_of::<i32>();
        let ok = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut value as *mut i32).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } == 0;
        return ok.then_some(i64::from(value));
    }
    #[allow(unreachable_code)]
    {
        let _ = name;
        None
    }
}

pub fn chip_name(chip: &str) -> String {
    let head = chip.split(" @ ").next().unwrap_or("");
    head.replace("(R)", "")
        .replace("(TM)", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[allow(deprecated)]
pub fn running_image_uuid() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        const LC_UUID: u32 = 0x1b;
        const HEADER_64: usize = 32;
        let header = unsafe { libc::_dyld_get_image_header(0) };
        if header.is_null() {
            return None;
        }
        let commands = unsafe { (*header).ncmds };
        let mut at = unsafe { header.cast::<u8>().add(HEADER_64) };
        for _ in 0..commands {
            let (cmd, size) = unsafe {
                (
                    at.cast::<u32>().read_unaligned(),
                    at.cast::<u32>().add(1).read_unaligned(),
                )
            };
            if cmd == LC_UUID {
                let mut bytes = [0u8; 16];
                unsafe { std::ptr::copy_nonoverlapping(at.add(8), bytes.as_mut_ptr(), 16) };
                return Some(uuid::Uuid::from_bytes(bytes).hyphenated().to_string());
            }
            if size == 0 {
                return None;
            }
            at = unsafe { at.add(size as usize) };
        }
    }
    None
}

static SUGGESTS: Mutex<[u64; 4]> = Mutex::new([0; 4]);
const SUGGEST_FIELDS: [&str; 4] = [
    "search_suggest_ok",
    "search_suggest_blocked",
    "search_suggest_failed",
    "search_suggest_throttled",
];

pub fn suggest_outcome(status: u64, blocked: bool) -> usize {
    if status == 200 {
        0
    } else if blocked {
        1
    } else {
        2
    }
}

pub fn note_search_suggest(outcome: usize, consent: Option<&Consent>) {
    ardia_telemetry::counted(consent, || {
        if let Some(slot) = SUGGESTS.lock().get_mut(outcome) {
            *slot += 1;
        }
    });
}

pub fn take_search_suggests() -> Map<String, Value> {
    let taken = std::mem::take(&mut *SUGGESTS.lock());
    SUGGEST_FIELDS
        .iter()
        .zip(taken)
        .map(|(field, n)| ((*field).to_owned(), json!(n)))
        .collect()
}

const TAB_FLOORS: [usize; 8] = [0, 10, 25, 50, 100, 250, 500, 1000];

pub fn tabs_floor(tabs: usize) -> usize {
    TAB_FLOORS
        .iter()
        .rev()
        .find(|step| tabs >= **step)
        .copied()
        .unwrap_or(0)
}

pub fn thermal_label(state: isize) -> Option<&'static str> {
    ["nominal", "fair", "serious", "critical"]
        .get(usize::try_from(state).ok()?)
        .copied()
}

fn thermal_state() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        let info: *mut AnyObject =
            unsafe { objc2::msg_send![objc2::class!(NSProcessInfo), processInfo] };
        if info.is_null() {
            return None;
        }
        let state: isize = unsafe { objc2::msg_send![info, thermalState] };
        return thermal_label(state);
    }
    #[allow(unreachable_code)]
    None
}

pub fn freeze_context(fields: &mut Map<String, Value>) {
    if let Some(coordinator) = coordinator() {
        let state = coordinator.store().snapshot();
        fields.insert("tabs_floor".into(), json!(tabs_floor(state.tabs.len())));
        fields.insert("windows".into(), json!(state.windows.len()));
        fields.insert(
            "layout".into(),
            json!(
                if state.settings.tab_layout == ardia_state::model::TabLayout::Top {
                    "top"
                } else {
                    "sidebar"
                }
            ),
        );
        fields.insert(
            "sync_on".into(),
            json!(coordinator.bridge.lock().sync_status.enabled),
        );
    }
    fields.insert("memory_pressure".into(), json!(memory_pressure()));
    fields.insert("thermal".into(), json!(thermal_state()));
    fields.insert(
        "on_battery".into(),
        json!(crate::system_state::read().on_battery),
    );
    let thread = fields
        .get("freeze_thread")
        .and_then(Value::as_str)
        .unwrap_or("main")
        .to_owned();
    fields.insert("signature".into(), json!(format!("none_{thread}")));
}

pub fn note_sync_status(was: (bool, bool), now: (bool, bool)) {
    let ((was_loaded, was_on), (loaded, on)) = (was, now);
    if !(was_loaded && loaded) || was_on == on {
        return;
    }
    let mut props = Map::from_iter([("on".to_owned(), json!(on))]);
    if on {
        props.insert("sync_core".into(), json!("rust"));
    }
    ardia_telemetry::capture("sync_toggled", props);
}

pub fn memory_pressure() -> Option<&'static str> {
    pressure_label(sysctl_number(c"kern.memorystatus_vm_pressure_level")?)
}

pub fn pressure_label(level: i64) -> Option<&'static str> {
    match level {
        1 => Some("normal"),
        2 => Some("warning"),
        4 => Some("critical"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2_metal::{MTLCreateSystemDefaultDevice, MTLDevice};

    type DisplayId = u32;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGGetActiveDisplayList(max: u32, displays: *mut DisplayId, count: *mut u32) -> i32;
        fn CGDisplayCopyDisplayMode(display: DisplayId) -> *mut std::ffi::c_void;
        fn CGDisplayModeGetWidth(mode: *mut std::ffi::c_void) -> usize;
        fn CGDisplayModeGetPixelWidth(mode: *mut std::ffi::c_void) -> usize;
        fn CGDisplayModeRelease(mode: *mut std::ffi::c_void);
    }

    #[link(name = "VideoToolbox", kind = "framework")]
    unsafe extern "C" {
        fn VTIsHardwareDecodeSupported(codec: u32) -> u8;
        fn VTRegisterSupplementalVideoDecoderIfAvailable(codec: u32);
    }

    const fn four_cc(code: [u8; 4]) -> u32 {
        u32::from_be_bytes(code)
    }

    pub fn gpu() -> Option<String> {
        MTLCreateSystemDefaultDevice().map(|device| device.name().to_string())
    }

    pub fn displays() -> (u32, f64) {
        let mut count = 0u32;
        unsafe { CGGetActiveDisplayList(0, std::ptr::null_mut(), &mut count) };
        let mut ids = vec![0u32; count as usize];
        unsafe { CGGetActiveDisplayList(count, ids.as_mut_ptr(), &mut count) };
        let scale = ids
            .iter()
            .take(count as usize)
            .filter_map(|id| {
                let mode = unsafe { CGDisplayCopyDisplayMode(*id) };
                if mode.is_null() {
                    return None;
                }
                let width = unsafe { CGDisplayModeGetWidth(mode) };
                let pixels = unsafe { CGDisplayModeGetPixelWidth(mode) };
                unsafe { CGDisplayModeRelease(mode) };
                (width > 0).then(|| pixels as f64 / width as f64)
            })
            .fold(0.0, f64::max);
        (count, scale)
    }

    pub fn hardware_decode() -> [(&'static str, bool); 4] {
        let vp9 = four_cc(*b"vp09");
        unsafe { VTRegisterSupplementalVideoDecoderIfAvailable(vp9) };
        let supported = |code: u32| unsafe { VTIsHardwareDecodeSupported(code) != 0 };
        [
            ("hw_decode_av1", supported(four_cc(*b"av01"))),
            ("hw_decode_vp9", supported(vp9)),
            ("hw_decode_hevc", supported(four_cc(*b"hvc1"))),
            ("hw_decode_h264", supported(four_cc(*b"avc1"))),
        ]
    }
}

pub fn hardware_props() -> Map<String, Value> {
    let mut props = Map::new();
    props.insert(
        "chip".into(),
        json!(
            sysctl_string(c"machdep.cpu.brand_string")
                .map(|c| chip_name(&c))
                .filter(|c| !c.is_empty())
        ),
    );
    #[cfg(target_os = "macos")]
    {
        props.insert("gpu".into(), json!(mac::gpu().map(|g| chip_name(&g))));
        let (displays, scale) = mac::displays();
        props.insert("displays".into(), json!(displays));
        props.insert("max_scale".into(), json!((scale * 100.0).round() / 100.0));
        for (field, supported) in mac::hardware_decode() {
            props.insert(field.into(), json!(supported));
        }
    }
    props
}

pub fn load_average() -> Option<f64> {
    #[cfg(unix)]
    {
        let mut loads = [0f64; 3];
        if unsafe { libc::getloadavg(loads.as_mut_ptr(), 3) } >= 1 && loads[0] >= 0.0 {
            return Some((loads[0] * 100.0).round() / 100.0);
        }
    }
    None
}

pub fn bucket(n: i64, edges: &[(i64, &'static str)], last: &'static str) -> &'static str {
    edges
        .iter()
        .find(|(max, _)| n <= *max)
        .map_or(last, |(_, label)| label)
}

pub fn ago(ms: i64) -> &'static str {
    bucket(
        ms,
        &[
            (MINUTE_MS, "<1m"),
            (10 * MINUTE_MS, "<10m"),
            (HOUR_MS, "<1h"),
            (8 * HOUR_MS, "<8h"),
            (DAY_MS, "<1d"),
            (7 * DAY_MS, "<7d"),
        ],
        "7d+",
    )
}

pub fn cold_nth_bucket(nth: Option<i64>) -> Option<&'static str> {
    match nth? {
        n if n < 1 => None,
        1 => Some("1"),
        2 => Some("2"),
        _ => Some("3+"),
    }
}

pub fn version_age_bucket(since: Option<i64>, at: i64) -> Option<&'static str> {
    let since = since.filter(|s| at >= *s)?;
    let age = at - since;
    Some(if age < DAY_MS {
        "<1d"
    } else if age < 2 * DAY_MS {
        "<2d"
    } else if age < 4 * DAY_MS {
        "<4d"
    } else if age < 7 * DAY_MS {
        "<7d"
    } else {
        "7d+"
    })
}

pub struct LaunchInput {
    pub t0: i64,
    pub main: Option<(i64, Option<Usage>)>,
    pub engine: Option<(i64, Option<Usage>)>,
    pub first_window: Option<i64>,
    pub tabs: usize,
    pub windows: usize,
    pub history: usize,
    pub oldest_visit: Option<i64>,
    pub boot_time: Option<i64>,
    pub session: ardia_telemetry::ClientSession,
    pub load_1m: Option<f64>,
    pub launched_hidden: bool,
}

pub fn launch_properties(input: &LaunchInput) -> Map<String, Value> {
    let t0 = input.t0;
    let ms = |at: Option<i64>| {
        at.map(|at| at - t0)
            .filter(|d| (0..10 * MINUTE_MS).contains(d))
    };
    let usage = |mark: Option<(i64, Option<Usage>)>| mark.and_then(|(_, usage)| usage);
    let session = &input.session;
    let mut props = Map::new();
    props.insert("launch_ms".into(), json!(ms(input.first_window)));
    props.insert("main_ms".into(), json!(ms(input.main.map(|m| m.0))));
    props.insert("engine_ms".into(), json!(ms(input.engine.map(|m| m.0))));
    props.insert("tabs".into(), json!(input.tabs));
    props.insert("windows".into(), json!(input.windows.min(10)));
    props.insert(
        "history".into(),
        json!(bucket(
            input.history as i64,
            &[
                (0, "0"),
                (99, "<100"),
                (999, "<1k"),
                (4_999, "<5k"),
                (19_999, "<20k"),
                (99_999, "<100k")
            ],
            "100k+"
        )),
    );
    props.insert(
        "history_oldest".into(),
        json!(
            input
                .oldest_visit
                .filter(|oldest| *oldest > 0 && *oldest <= t0)
                .map(|oldest| bucket(
                    t0 - oldest,
                    &[
                        (30 * DAY_MS, "<30d"),
                        (91 * DAY_MS, "<91d"),
                        (365 * DAY_MS, "<1y"),
                        (3 * 365 * DAY_MS, "<3y")
                    ],
                    "3y+"
                ))
        ),
    );
    props.insert(
        "cold".into(),
        json!(match (input.boot_time, session.last_launch_at) {
            (Some(boot), Some(last)) => Some(last < boot),
            _ => None,
        }),
    );
    props.insert("first_of_version".into(), json!(session.first_of_version));
    props.insert("cold_nth".into(), json!(cold_nth_bucket(session.cold_nth)));
    props.insert(
        "version_age".into(),
        json!(version_age_bucket(session.version_since, t0)),
    );
    props.insert(
        "update_prewarm".into(),
        json!(session.first_of_version.then_some("none")),
    );
    props.insert("update_prewarm_ago".into(), Value::Null);
    let since_quit = match (session.last_quit_at, session.last_launch_at) {
        (Some(quit), last) if last.is_none_or(|last| quit >= last) => ago(t0 - quit),
        (_, Some(_)) => "unclean",
        _ => "unknown",
    };
    props.insert("since_quit".into(), json!(since_quit));
    props.insert("load_1m".into(), json!(input.load_1m));
    for (prefix, mark) in [("main", input.main), ("engine", input.engine)] {
        let used = usage(mark);
        props.insert(
            format!("{prefix}_page_ins"),
            json!(used.map(|u| u.page_ins)),
        );
        props.insert(
            format!("{prefix}_block_reads"),
            json!(used.map(|u| u.block_reads)),
        );
        props.insert(format!("{prefix}_cpu_ms"), json!(used.map(|u| u.cpu_ms)));
    }
    props.insert("launched_hidden".into(), json!(input.launched_hidden));
    props.insert("launch_source".into(), Value::Null);
    props.insert(
        "since_boot".into(),
        json!(input.boot_time.map_or("unknown", |boot| bucket(
            t0 - boot,
            &[
                (2 * MINUTE_MS, "<2m"),
                (10 * MINUTE_MS, "<10m"),
                (HOUR_MS, "<1h"),
                (DAY_MS, "<1d")
            ],
            "1d+"
        ))),
    );
    props
}

fn history_shape(state: &BrowserState) -> (usize, Option<i64>) {
    let mut total = 0;
    let mut oldest: Option<i64> = None;
    for history in state.history.values() {
        total += history.len();
        for entry in history.entries() {
            if entry.last_visit > 0 {
                oldest = Some(oldest.map_or(entry.last_visit, |o| o.min(entry.last_visit)));
            }
        }
    }
    (total, oldest)
}

fn coordinator() -> Option<Arc<AppCoordinator>> {
    COORDINATOR.lock().as_ref().and_then(Weak::upgrade)
}

fn send_launch(consent: Option<&Consent>) {
    if LAUNCH_SENT.swap(true, Ordering::Relaxed) || !still_valid(consent) {
        return;
    }
    let Some(client) = ardia_telemetry::client() else {
        return;
    };
    let Some(session) = client.session_start() else {
        return;
    };
    let marks = *MARKS.lock();
    let info = client.info();
    let Some(t0) = process_start_ms().or(info.process_start) else {
        return;
    };
    let coordinator = coordinator();
    let state = coordinator.as_ref().map(|c| c.store().snapshot());
    let (history, oldest_visit) = state.as_deref().map(history_shape).unwrap_or_default();
    let input = LaunchInput {
        t0,
        main: marks.main.map(|m| (m.at, m.usage)),
        engine: marks.engine.map(|m| (m.at, m.usage)),
        first_window: marks.first_window,
        tabs: state.as_ref().map_or(0, |s| s.tabs.len()),
        windows: state.as_ref().map_or(0, |s| s.windows.len()),
        history,
        oldest_visit,
        boot_time: info.boot_time,
        session,
        load_1m: load_average(),
        launched_hidden: coordinator.as_ref().is_some_and(|c| c.config().background),
    };
    ardia_telemetry::capture_for("perf_launch", launch_properties(&input), consent);
}

const TOOLBAR_BOUNCE: Duration = Duration::from_millis(1000);

static TOOLBAR_SHOWN: Mutex<Option<HashMap<String, std::time::Instant>>> = Mutex::new(None);

pub fn note_toolbar_shown(tab: &str) {
    let now = std::time::Instant::now();
    let mut shown = TOOLBAR_SHOWN.lock();
    let shown = shown.get_or_insert_with(HashMap::new);
    shown.retain(|_, at| now.saturating_duration_since(*at) < TOOLBAR_BOUNCE);
    shown.insert(tab.to_owned(), now);
}

pub fn toolbar_hide_bounced(
    shown: &mut HashMap<String, std::time::Instant>,
    tab: &str,
    now: std::time::Instant,
) -> bool {
    shown.retain(|_, at| now.saturating_duration_since(*at) < TOOLBAR_BOUNCE);
    shown.remove(tab).is_some()
}

pub fn note_toolbar_hidden(tab: &str) {
    let bounced = {
        let mut shown = TOOLBAR_SHOWN.lock();
        toolbar_hide_bounced(
            shown.get_or_insert_with(HashMap::new),
            tab,
            std::time::Instant::now(),
        )
    };
    ardia_telemetry::counts::count("toolbar_scroll_hides");
    if bounced {
        ardia_telemetry::counts::count("toolbar_scroll_hide_bounces");
    }
}

pub fn top_apps_counts(state: &BrowserState) -> Map<String, Value> {
    Map::from_iter([
        ("profile_count".to_owned(), json!(state.profiles.len())),
        (
            "sharing_profiles".to_owned(),
            json!(
                state
                    .profiles
                    .values()
                    .filter(|profile| profile.share_top_apps)
                    .count()
            ),
        ),
    ])
}

pub fn top_apps_at_launch(
    state: &BrowserState,
    saved: &str,
    updated_from: Option<&str>,
) -> Map<String, Value> {
    let settled = state.persisted.top_apps_merged.as_str();
    let mut props = top_apps_counts(state);
    props.insert("merge_recorded".into(), json!(!saved.is_empty()));
    props.insert(
        "merge_recorded_this_launch".into(),
        json!(!settled.is_empty() && saved != settled),
    );
    props.insert(
        "merge_marker_cleared".into(),
        json!(!saved.is_empty() && settled.is_empty()),
    );
    props.insert("from_version".into(), json!(updated_from));
    props
}

pub fn note_top_apps_sharing_synced(state: &BrowserState, path: &'static str, on: bool) {
    let mut props = top_apps_counts(state);
    props.insert("path".into(), json!(path));
    props.insert("on".into(), json!(on));
    ardia_telemetry::capture("top_apps_sharing_synced", props);
}

fn send_top_apps_at_launch(coordinator: &AppCoordinator) {
    let Some(client) = ardia_telemetry::client() else {
        return;
    };
    let Some(session) = client.session_start() else {
        return;
    };
    let state = coordinator.store().snapshot();
    let saved = state.persisted.top_apps_merged.clone();
    let props = top_apps_at_launch(&state, &saved, session.updated_from.as_deref());
    ardia_telemetry::capture("top_apps_sharing", props);
}

pub fn session_ending() {
    if MARKS.lock().first_window.is_some() {
        send_launch(consent_now().as_ref());
    }
}

pub fn crash_owner() -> ardia_telemetry::native_crash::Owner {
    let executable = std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let bundle = executable
        .find(".app/Contents/")
        .map(|at| executable[..at + ".app".len()].to_owned())
        .unwrap_or_default();
    let info = std::fs::read(format!("{bundle}/Contents/Info.plist")).unwrap_or_default();
    let plist = String::from_utf8_lossy(&info);
    let helpers_dir = format!(
        "{bundle}/Contents/Frameworks/Chromium Framework.framework/Versions/Current/Helpers"
    );
    let helpers = std::fs::read_dir(&helpers_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".app")?.to_owned();
            let plist = std::fs::read(entry.path().join("Contents/Info.plist")).unwrap_or_default();
            Some((
                stem,
                plist_string(&String::from_utf8_lossy(&plist), "CFBundleIdentifier"),
            ))
        })
        .collect();
    ardia_telemetry::native_crash::Owner {
        executable,
        bundle,
        bundle_id: plist_string(&plist, "CFBundleIdentifier").unwrap_or_default(),
        version: plist_string(&plist, "CFBundleShortVersionString"),
        executable_uuid: running_image_uuid(),
        helpers,
    }
}

pub fn plist_string(plist: &str, key: &str) -> Option<String> {
    let at = plist.find(&format!("<key>{key}</key>"))?;
    let rest = &plist[at..];
    let open = rest.find("<string>")? + "<string>".len();
    let close = rest[open..].find("</string>")?;
    Some(rest[open..open + close].trim().to_owned()).filter(|s| !s.is_empty())
}

pub fn report_native_crashes() {
    let Some(client) = ardia_telemetry::client() else {
        return;
    };
    let Some(dir) = ardia_telemetry::native_crash::reports_dir() else {
        return;
    };
    let owner = crash_owner();
    if owner.bundle.is_empty() {
        return;
    }
    let consent = consent_now();
    ardia_telemetry::native_crash::report_new(&client, &owner, &dir, consent.as_ref());
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Task {
    pub kind: String,
    pub memory: f64,
    pub cpu: f64,
    pub pid: Option<i64>,
    pub id: i64,
}

pub fn tasks_of(reply: &Value) -> Vec<Task> {
    let list = reply
        .as_array()
        .or_else(|| reply["tasks"].as_array())
        .cloned()
        .unwrap_or_default();
    list.iter()
        .map(|task| Task {
            kind: task["type"].as_str().unwrap_or("unknown").to_owned(),
            memory: task["memory"].as_f64().unwrap_or(0.0),
            cpu: task["cpu"].as_f64().unwrap_or(0.0),
            pid: task["pid"].as_i64(),
            id: task["id"].as_i64().unwrap_or(0),
        })
        .collect()
}

fn mb(bytes: f64) -> i64 {
    (bytes / 1_048_576.0).round() as i64
}

fn percent_of_core(percent: f64) -> f64 {
    (percent.min(10_000.0) * 10.0).round() / 10.0
}

pub fn process_cpu_fields(tasks: &[Task]) -> Map<String, Value> {
    let mut processes: Vec<(String, &'static str, f64)> = Vec::new();
    for task in tasks {
        let used = if task.cpu.is_finite() {
            task.cpu.max(0.0)
        } else {
            0.0
        };
        let key = match task.pid.filter(|p| *p > 0) {
            Some(pid) => format!("pid:{pid}"),
            None => format!("task:{}", task.id),
        };
        let kind = match task.kind.as_str() {
            "browser" => "browser",
            "gpu" => "gpu",
            "renderer" => "renderer",
            _ => "helper",
        };
        match processes.iter_mut().find(|(k, _, _)| *k == key) {
            Some(seen) => seen.2 = seen.2.max(used),
            None => processes.push((key, kind, used)),
        }
    }
    if !processes.iter().any(|(_, _, cpu)| *cpu > 0.0) {
        return Map::new();
    }
    let sum = |kind: &str| {
        processes
            .iter()
            .filter(|(_, k, _)| *k == kind)
            .map(|(_, _, c)| c)
            .sum::<f64>()
    };
    let renderer_max = processes
        .iter()
        .filter(|(_, k, _)| *k == "renderer")
        .map(|(_, _, c)| *c)
        .fold(0.0, f64::max);
    Map::from_iter([
        (
            "browser_cpu_now_pct".to_owned(),
            json!(percent_of_core(sum("browser"))),
        ),
        (
            "gpu_cpu_now_pct".to_owned(),
            json!(percent_of_core(sum("gpu"))),
        ),
        (
            "renderer_cpu_now_pct".to_owned(),
            json!(percent_of_core(sum("renderer"))),
        ),
        (
            "renderer_cpu_now_max_pct".to_owned(),
            json!(percent_of_core(renderer_max)),
        ),
        (
            "helper_cpu_now_pct".to_owned(),
            json!(percent_of_core(sum("helper"))),
        ),
    ])
}

pub fn memory_fields(tasks: &[Task]) -> Option<Map<String, Value>> {
    let (mut total, mut browser, mut gpu, mut renderers) = (0.0, 0.0, 0.0, 0);
    for task in tasks {
        let memory = task.memory.max(0.0);
        total += memory;
        match task.kind.as_str() {
            "browser" => browser += memory,
            "gpu" => gpu += memory,
            "renderer" => renderers += 1,
            _ => {}
        }
    }
    if total <= 0.0 {
        return None;
    }
    let mut props = process_cpu_fields(tasks);
    props.insert("total_mb".into(), json!(mb(total)));
    props.insert("browser_mb".into(), json!(mb(browser)));
    props.insert("gpu_mb".into(), json!(mb(gpu)));
    props.insert("renderer_processes".into(), json!(renderers));
    Some(props)
}

fn main_process_work(now: i64) -> Map<String, Value> {
    let Some((cpu_ms, wakeups)) = cpu_and_wakeups() else {
        return Map::new();
    };
    let before = MAIN_WORK.lock().replace((now, cpu_ms, wakeups));
    let Some((at, cpu_before, wakeups_before)) = before else {
        return Map::new();
    };
    let seconds = (now - at) as f64 / 1000.0;
    if seconds < 60.0 || cpu_ms < cpu_before {
        return Map::new();
    }
    Map::from_iter([
        (
            "browser_cpu_pct".to_owned(),
            json!((((cpu_ms - cpu_before) / (seconds * 1000.0)) * 1000.0).round() / 10.0),
        ),
        (
            "browser_wakeups_per_s".to_owned(),
            json!((((wakeups - wakeups_before) / seconds) * 10.0).round() / 10.0),
        ),
    ])
}

fn cpu_and_wakeups() -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
        let read = unsafe {
            libc::proc_pid_rusage(
                libc::getpid(),
                libc::RUSAGE_INFO_V4,
                (&mut info as *mut libc::rusage_info_v4).cast(),
            )
        };
        if read == 0 {
            let (numer, denom) = timebase();
            if denom == 0 {
                return None;
            }
            let ticks = (info.ri_user_time + info.ri_system_time) as f64;
            let cpu_ms = ticks * f64::from(numer) / f64::from(denom) / 1_000_000.0;
            let wakeups = (info.ri_pkg_idle_wkups + info.ri_interrupt_wkups) as f64;
            return Some((cpu_ms, wakeups));
        }
    }
    None
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn timebase() -> (u32, u32) {
    let mut timebase = libc::mach_timebase_info { numer: 0, denom: 0 };
    unsafe { libc::mach_timebase_info(&mut timebase) };
    (timebase.numer, timebase.denom)
}

fn take_hangs(consent: Option<&Consent>) -> Map<String, Value> {
    let taken = HANGS.lock().taken.take().unwrap_or_default();
    if !still_valid(consent) || taken.is_empty() {
        return Map::new();
    }
    let mut props = Map::new();
    for field in [
        "renderer_unresponsive",
        "renderer_unresponsive_exited",
        "renderer_unresponsive_under_5s",
        "renderer_unresponsive_5_30s",
        "renderer_unresponsive_30s_2m",
        "renderer_unresponsive_over_2m",
    ] {
        props.insert(field.into(), json!(taken.get(field).copied().unwrap_or(0)));
    }
    props
}

pub fn sample_memory() {
    let consent = consent_now();
    if !still_valid(consent.as_ref()) {
        return;
    }
    let Some(coordinator) = coordinator() else {
        return;
    };
    coordinator.post(move |coordinator| list_tasks(coordinator, consent, true));
}

fn list_tasks(coordinator: &AppCoordinator, consent: Option<Consent>, warm_up: bool) {
    let Some(engine) = coordinator.engine() else {
        return;
    };
    let reply = engine.call_service("ac_tasks_list", "", "{}");
    let tabs = coordinator.store().snapshot().tabs.len();
    let me = coordinator.weak();
    coordinator.spawn(async move {
        let tasks = reply
            .await
            .map(|reply| tasks_of(&reply))
            .unwrap_or_default();
        if warm_up {
            let _ = std::thread::Builder::new()
                .name("ardia-memory-sample".into())
                .spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    if let Some(coordinator) = me.upgrade() {
                        coordinator
                            .post(move |coordinator| list_tasks(coordinator, consent, false));
                    }
                });
            return;
        }
        send_memory(&tasks, tabs, consent.as_ref());
    });
}

fn send_memory(tasks: &[Task], tabs: usize, consent: Option<&Consent>) {
    if !still_valid(consent) {
        return;
    }
    let Some(mut props) = memory_fields(tasks) else {
        return;
    };
    props.extend(main_process_work(now_ms()));
    props.extend(take_hangs(consent));
    props.insert("tabs".into(), json!(tabs));
    let started = STARTED_AT.load(Ordering::Relaxed);
    props.insert(
        "uptime_hours".into(),
        json!(((now_ms() - started) as f64 / HOUR_MS as f64).round() as i64),
    );
    ardia_telemetry::capture_for("perf_memory", props, consent);
}

pub fn gone_reason(status: &str) -> &'static str {
    GONE_REASONS
        .iter()
        .find(|reason| **reason == status)
        .copied()
        .unwrap_or("unknown")
}

pub fn page_process_gone_props(
    status: &str,
    code: i32,
    visible: bool,
    state: &BrowserState,
    session_min: i64,
    gone_this_session: u32,
    pressure: Option<&'static str>,
) -> Map<String, Value> {
    Map::from_iter([
        ("process".to_owned(), json!("renderer")),
        ("reason".to_owned(), json!(gone_reason(status))),
        ("exit_code".to_owned(), json!(code)),
        ("visible".to_owned(), json!(visible)),
        ("tabs".to_owned(), json!(state.tabs.len())),
        ("windows".to_owned(), json!(state.windows.len())),
        ("profiles".to_owned(), json!(state.profiles.len())),
        ("session_min".to_owned(), json!(session_min)),
        ("gone_this_session".to_owned(), json!(gone_this_session)),
        ("memory_pressure".to_owned(), json!(pressure)),
    ])
}

fn session_minutes() -> i64 {
    let start = process_start_ms().unwrap_or_else(|| STARTED_AT.load(Ordering::Relaxed));
    ((now_ms() - start).max(0) as f64 / MINUTE_MS as f64).round() as i64
}

fn tab_visible(state: &BrowserState, tab: &str) -> bool {
    state.windows.values().any(|window| {
        window
            .active_tab()
            .is_some_and(|active| active.as_str() == tab)
    })
}

impl AppCoordinator {
    pub(crate) fn note_telemetry_event(&self, event: &EngineEvent) {
        match event {
            EngineEvent::RendererGone { tab, status, code } => {
                if self.is_shutting_down() || self.engine_is_quitting() {
                    return;
                }
                let consent = consent_now();
                let sharing = still_valid(consent.as_ref());
                let gone = {
                    let mut gone = PAGE_GONE.lock();
                    if sharing {
                        gone.gone_this_session += 1;
                    }
                    let cap = if sharing {
                        &mut gone.shared
                    } else {
                        &mut gone.local
                    };
                    if *cap >= MAX_PAGE_PROCESS_EVENTS {
                        return;
                    }
                    *cap += 1;
                    gone.gone_this_session
                };
                let key = tab.to_string();
                close_hang(&key, true, consent.as_ref());
                let state = self.store().snapshot();
                let visible = self
                    .state_tab(*tab)
                    .is_some_and(|id| tab_visible(&state, id.as_str()));
                let props = page_process_gone_props(
                    status,
                    *code,
                    visible,
                    &state,
                    session_minutes(),
                    gone,
                    memory_pressure(),
                );
                ardia_telemetry::capture_for("page_process_gone", props, consent.as_ref());
            }
            EngineEvent::Unresponsive { tab } => {
                let consent = consent_now();
                if still_valid(consent.as_ref())
                    && let Some(epoch) = consent.as_ref().map(|c| c.epoch().to_owned())
                {
                    HANGS
                        .lock()
                        .open
                        .get_or_insert_with(HashMap::new)
                        .entry(tab.to_string())
                        .or_insert((now_ms(), epoch));
                }
            }
            EngineEvent::Responsive { tab } => {
                close_hang(&tab.to_string(), false, consent_now().as_ref())
            }
            EngineEvent::TabWillClose { tab } => {
                if let Some(open) = HANGS.lock().open.as_mut() {
                    open.remove(&tab.to_string());
                }
            }
            _ => {}
        }
    }
}

pub fn hang_bucket(ms: i64) -> &'static str {
    HANG_BUCKETS
        .iter()
        .find(|(limit, _)| ms < *limit)
        .map_or("renderer_unresponsive_over_2m", |(_, field)| field)
}

fn close_hang(tab: &str, exited: bool, consent: Option<&Consent>) {
    let mut hangs = HANGS.lock();
    let Some((at, epoch)) = hangs.open.as_mut().and_then(|open| open.remove(tab)) else {
        return;
    };
    if consent.map(Consent::epoch) != Some(epoch.as_str()) || !still_valid(consent) {
        return;
    }
    let taken = hangs.taken.get_or_insert_with(HashMap::new);
    *taken.entry("renderer_unresponsive").or_default() += 1;
    if exited {
        *taken.entry("renderer_unresponsive_exited").or_default() += 1;
    }
    *taken.entry(hang_bucket(now_ms() - at)).or_default() += 1;
}

pub fn start(coordinator: &Arc<AppCoordinator>, unclean: bool) {
    STARTED_AT.store(now_ms(), Ordering::Relaxed);
    *COORDINATOR.lock() = Some(Arc::downgrade(coordinator));
    send_top_apps_at_launch(coordinator);
    ardia_telemetry::consent::on_period_change(|| {
        let mut hangs = HANGS.lock();
        hangs.open = None;
        hangs.taken = None;
        *MAIN_WORK.lock() = None;
        let mut gone = PAGE_GONE.lock();
        gone.gone_this_session = 0;
    });
    let Some(client) = ardia_telemetry::client() else {
        return;
    };
    let first_crash_read = Duration::from_millis(if unclean { 1_000 } else { 5_000 });
    client.every(first_crash_read, None, report_native_crashes);
    client.every(
        ardia_telemetry::HOUR,
        Some(ardia_telemetry::HOUR),
        report_native_crashes,
    );
    client.every(
        FIRST_MEMORY_SAMPLE,
        Some(ardia_telemetry::HOUR),
        sample_memory,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_telemetry::{ClientSession, PreviousSession};

    fn session() -> ClientSession {
        ClientSession {
            previous: PreviousSession::Clean,
            updated_from: None,
            last_launch_at: Some(1_000),
            last_quit_at: Some(2_000),
            first_of_version: true,
            cold_nth: Some(4),
            version_since: Some(0),
        }
    }

    #[test]
    fn launch_properties_bucket_and_bound_every_mark() {
        let t0 = 100 * DAY_MS;
        let props = launch_properties(&LaunchInput {
            t0,
            main: Some((
                t0 + 40,
                Some(Usage {
                    page_ins: 3,
                    block_reads: 4,
                    cpu_ms: 50,
                }),
            )),
            engine: Some((t0 + 400, None)),
            first_window: Some(t0 + 20 * MINUTE_MS),
            tabs: 12,
            windows: 14,
            history: 1_500,
            oldest_visit: Some(t0 - 40 * DAY_MS),
            boot_time: Some(t0 - 5 * MINUTE_MS),
            session: session(),
            load_1m: Some(1.25),
            launched_hidden: true,
        });
        assert_eq!(props["main_ms"], 40);
        assert_eq!(props["engine_ms"], 400);
        assert_eq!(props["launch_ms"], Value::Null);
        assert_eq!(props["windows"], 10);
        assert_eq!(props["history"], "<5k");
        assert_eq!(props["history_oldest"], "<91d");
        assert_eq!(props["cold"], true);
        assert_eq!(props["cold_nth"], "3+");
        assert_eq!(props["version_age"], "7d+");
        assert_eq!(props["update_prewarm"], "none");
        assert_eq!(props["since_quit"], "7d+");
        assert_eq!(props["since_boot"], "<10m");
        assert_eq!(props["main_cpu_ms"], 50);
        assert_eq!(props["engine_cpu_ms"], Value::Null);
        assert_eq!(props["launched_hidden"], true);
    }

    #[test]
    fn memory_sums_tasks_and_counts_cpu_per_process() {
        let tasks = tasks_of(&json!([
            {"type": "browser", "memory": 200.0 * 1_048_576.0, "cpu": 12.34, "pid": 1, "id": 1},
            {"type": "gpu", "memory": 100.0 * 1_048_576.0, "cpu": 3.0, "pid": 2, "id": 2},
            {"type": "renderer", "memory": 50.0 * 1_048_576.0, "cpu": 40.0, "pid": 3, "id": 3},
            {"type": "renderer", "memory": 0.0, "cpu": 45.0, "pid": 3, "id": 4},
            {"type": "utility", "memory": 10.0 * 1_048_576.0, "cpu": 1.0, "pid": 5, "id": 5}
        ]));
        let props = memory_fields(&tasks).expect("memory");
        assert_eq!(props["total_mb"], 360);
        assert_eq!(props["browser_mb"], 200);
        assert_eq!(props["gpu_mb"], 100);
        assert_eq!(props["renderer_processes"], 2);
        assert_eq!(props["browser_cpu_now_pct"], 12.3);
        assert_eq!(props["renderer_cpu_now_pct"], 45.0);
        assert_eq!(props["renderer_cpu_now_max_pct"], 45.0);
        assert_eq!(props["helper_cpu_now_pct"], 1.0);
        assert!(memory_fields(&[]).is_none());
    }

    #[test]
    fn a_hide_within_a_second_of_showing_is_a_bounce() {
        let start = std::time::Instant::now();
        let mut shown = HashMap::from([("t1".to_owned(), start)]);
        assert!(toolbar_hide_bounced(
            &mut shown,
            "t1",
            start + Duration::from_millis(400)
        ));
        assert!(!toolbar_hide_bounced(
            &mut shown,
            "t1",
            start + Duration::from_millis(500)
        ));
        shown.insert("t2".to_owned(), start);
        assert!(!toolbar_hide_bounced(
            &mut shown,
            "t2",
            start + Duration::from_millis(1_200)
        ));
    }

    #[test]
    fn top_apps_at_launch_reports_counts_and_the_merge_marker() {
        let state = BrowserState::default();
        let props = top_apps_at_launch(&state, "", Some("0.2.48"));
        assert_eq!(props["profile_count"], json!(state.profiles.len()));
        assert_eq!(props["sharing_profiles"], 0);
        assert_eq!(props["merge_recorded"], false);
        assert_eq!(props["merge_recorded_this_launch"], false);
        assert_eq!(props["merge_marker_cleared"], false);
        assert_eq!(props["from_version"], "0.2.48");
        let cleared = top_apps_at_launch(&state, "m1", None);
        assert_eq!(cleared["merge_recorded"], true);
        assert_eq!(cleared["merge_marker_cleared"], true);
    }

    #[test]
    fn freeze_and_suggest_mappings_match_the_old_tables() {
        assert_eq!(tabs_floor(0), 0);
        assert_eq!(tabs_floor(24), 10);
        assert_eq!(tabs_floor(2000), 1000);
        assert_eq!(thermal_label(2), Some("serious"));
        assert_eq!(thermal_label(9), None);
        assert_eq!(suggest_outcome(200, false), 0);
        assert_eq!(suggest_outcome(429, true), 1);
        assert_eq!(suggest_outcome(500, false), 2);
        assert!(running_image_uuid().is_some_and(|id| id.len() == 36));
    }

    #[test]
    fn small_mappings_match_the_old_tables() {
        assert_eq!(
            chip_name("Intel(R) Core(TM) i9-13900H @ 2.60GHz"),
            "Intel Core i9-13900H"
        );
        assert_eq!(gone_reason("oom"), "oom");
        assert_eq!(gone_reason("weird"), "unknown");
        assert_eq!(hang_bucket(4_999), "renderer_unresponsive_under_5s");
        assert_eq!(hang_bucket(200_000), "renderer_unresponsive_over_2m");
        assert_eq!(pressure_label(2), Some("warning"));
        assert_eq!(
            plist_string(
                "<key>CFBundleIdentifier</key>\n<string>dev.ardia</string>",
                "CFBundleIdentifier"
            )
            .as_deref(),
            Some("dev.ardia")
        );
    }
}
