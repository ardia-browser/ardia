use std::path::Path;
use std::sync::Arc;

use ardia_state::store::{BrowserStore, Interest, Subscription};
use ardia_state::{BrowserState, Topics};
use ardia_telemetry::{AppInfo, Config, Poster, SharingSource, counts};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::net::Transport;

pub struct NetPoster(Arc<dyn Transport>);

impl Poster for NetPoster {
    fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> u16 {
        let headers: Vec<(&str, String)> = headers
            .iter()
            .map(|(name, value)| (*name, (*value).to_owned()))
            .collect();
        self.0
            .send("POST", url, &headers, Some(body.to_vec()))
            .map_or(0, |reply| reply.status)
    }
}

pub fn os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let name = c"kern.osproductversion";
        let mut buffer = [0u8; 64];
        let mut size = buffer.len();
        let ok = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } == 0;
        if ok {
            let text = String::from_utf8_lossy(&buffer[..size])
                .trim_end_matches('\0')
                .trim()
                .to_owned();
            return Some(text).filter(|t| !t.is_empty());
        }
    }
    None
}

pub fn boot_time_ms() -> Option<i64> {
    #[cfg(target_os = "macos")]
    {
        let name = c"kern.boottime";
        let mut value = libc::timeval {
            tv_sec: 0,
            tv_usec: 0,
        };
        let mut size = std::mem::size_of::<libc::timeval>();
        let ok = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut value as *mut libc::timeval).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } == 0;
        if ok && value.tv_sec > 0 {
            return Some(value.tv_sec * 1000 + i64::from(value.tv_usec) / 1000);
        }
    }
    None
}

pub fn memory_gb() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let name = c"hw.memsize";
        let mut value: u64 = 0;
        let mut size = std::mem::size_of::<u64>();
        let ok = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut value as *mut u64).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } == 0;
        if ok && value > 0 {
            return Some(value.div_ceil(1 << 30));
        }
    }
    None
}

pub fn app_info(scratch: bool) -> AppInfo {
    AppInfo {
        app_version: crate::system_probe::app_version()
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned()),
        app_build: Some("gpui".to_owned()),
        os_version: os_version(),
        dev: cfg!(debug_assertions),
        isolated: scratch,
        engine_version: None,
        process_start: Some(ardia_telemetry::ids::now_ms()),
        boot_time: boot_time_ms(),
        ..AppInfo::default()
    }
}

pub fn start(data_dir: &Path, scratch: bool) {
    let info = app_info(scratch);
    let url = ardia_telemetry::test_endpoint(
        scratch,
        std::env::var(ardia_telemetry::TEST_ENDPOINT_ENV)
            .ok()
            .as_deref(),
    );
    let poster = crate::net::shared().map(|net| Arc::new(NetPoster(net)) as Arc<dyn Poster>);
    counts::register_source(|consent| {
        let fields = crate::webkit::telemetry::take();
        if ardia_telemetry::still_valid(consent) {
            fields
        } else {
            Map::new()
        }
    });
    counts::register_source(|_| {
        let taken = crate::theme_preset_counts::take();
        Map::from_iter([
            (
                "theme_presets_edited".to_owned(),
                json!(taken.theme_presets_edited),
            ),
            (
                "theme_presets_reset".to_owned(),
                json!(taken.theme_presets_reset),
            ),
        ])
    });
    ardia_telemetry::consent::on_period_change(|| {
        crate::webkit::telemetry::set_allowed(ardia_telemetry::consent_now().is_some());
    });
    let mut launch_props = Map::new();
    launch_props.insert("memory_gb".into(), json!(memory_gb()));
    launch_props.extend(crate::telemetry_events::hardware_props());
    ardia_telemetry::start(Config {
        data_dir: data_dir.to_path_buf(),
        info,
        url,
        poster,
        continuing: false,
        launch_props,
    });
    crate::webkit::telemetry::set_allowed(ardia_telemetry::consent_now().is_some());
    ardia_telemetry::crash::install_panic_hook();
    if let Some(client) = ardia_telemetry::client() {
        let existing = crate::onboarding_doc::read(data_dir).is_some_and(|o| o.completed);
        ardia_telemetry::daily::start_daily(client, existing, None);
    }
    if let Some(client) = ardia_telemetry::client() {
        client.every(
            ardia_telemetry::HOUR,
            Some(ardia_telemetry::HOUR),
            crate::telemetry_snapshot::hourly,
        );
    }
}

pub fn started(coordinator: &Arc<crate::coordinator::AppCoordinator>) {
    let unclean = ardia_telemetry::client()
        .and_then(|client| client.session_start())
        .is_some_and(|session| session.previous == ardia_telemetry::PreviousSession::Unclean);
    crate::telemetry_events::start(coordinator, unclean);
}

pub fn shown(dir: &Path) -> Option<ardia_telemetry::choice::Shown> {
    ardia_telemetry::client()
        .filter(|client| client.data_dir() == dir)
        .map(|client| client.shown())
}

pub fn set_sharing(
    dir: &Path,
    on: bool,
    source: SharingSource,
    placement: Option<ardia_telemetry::AskPlacement>,
) -> bool {
    match ardia_telemetry::client().filter(|client| client.data_dir() == dir) {
        Some(client) => {
            client.set_sharing(on, source, placement);
            true
        }
        None => false,
    }
}

pub fn dismiss_ask(dir: &Path) -> bool {
    match ardia_telemetry::client().filter(|client| client.data_dir() == dir) {
        Some(client) => {
            client.dismiss_ask();
            true
        }
        None => false,
    }
}

pub fn replace_install_id(dir: &Path) -> Option<String> {
    ardia_telemetry::client()
        .filter(|client| client.data_dir() == dir)
        .map(|client| ardia_telemetry::reset_anonymous_id(&client))
}

pub fn note_plugin_state_events(sent: usize) {
    counts::add("plugin_state_events", sent as u64);
}

pub fn quit() {
    crate::telemetry_snapshot::session_ending();
    crate::telemetry_events::session_ending();
    ardia_telemetry::session_ending();
    ardia_telemetry::client::stop();
}

#[derive(Default)]
struct Seen {
    tabs: usize,
    windows: usize,
    full_screens: Vec<(String, bool)>,
    splits: Vec<String>,
}

pub fn watch_store(store: &BrowserStore) -> Subscription {
    let seen = Arc::new(Mutex::new(seen_of(&store.snapshot())));
    store.subscribe(
        Interest::Topics(Topics::TABS | Topics::WINDOWS | Topics::SPLITS),
        move |update| note_update(&mut seen.lock(), &update.state),
    )
}

fn seen_of(state: &BrowserState) -> Seen {
    Seen {
        tabs: state.tabs.len(),
        windows: state.windows.len(),
        full_screens: state
            .windows
            .iter()
            .map(|(id, w)| (id.as_str().to_owned(), w.is_full_screen()))
            .collect(),
        splits: state
            .splits
            .keys()
            .map(|id| id.as_str().to_owned())
            .collect(),
    }
}

fn note_update(seen: &mut Seen, state: &BrowserState) {
    let now = seen_of(state);
    counts::add("tabs_opened", now.tabs.saturating_sub(seen.tabs) as u64);
    counts::add(
        "windows_opened",
        now.windows.saturating_sub(seen.windows) as u64,
    );
    let entered = now
        .full_screens
        .iter()
        .filter(|(id, on)| {
            *on && seen
                .full_screens
                .iter()
                .any(|(was, before)| was == id && !before)
        })
        .count();
    counts::add("full_screens_entered", entered as u64);
    if ardia_telemetry::is_sharing() {
        for (id, split) in state.splits.iter() {
            if seen.splits.iter().any(|known| known == id.as_str()) {
                continue;
            }
            let mut props = Map::new();
            props.insert("panes".into(), json!(split.tab_ids().len()));
            props.insert(
                "orientation".into(),
                serde_json::to_value(split.orientation).unwrap_or(Value::Null),
            );
            ardia_telemetry::capture("split_view_opened", props);
        }
    }
    *seen = now;
}
