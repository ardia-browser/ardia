use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use serde_json::{Map, Value, json};

use crate::choice::{Saved, Shown, no_watch};
use crate::consent::{self, Consent};
use crate::context::AppInfo;
use crate::ids::{now_ms, utc_day, uuidv4, uuidv7};
use crate::local::{LocalReading, LocalStore};
use crate::sanitize::clean_properties;
use crate::store;
use crate::wire::{
    self, EVENTS_SCOPE, LOGS_SCOPE, Level, LogRecord, Outcome, QueuedEvent, event_record,
    log_record, logs_request,
};

pub const LOGS_URL: &str = "https://ardia.dev/otel/v1/logs";
pub const INGEST_KEY_HEADER: &str = "X-Ardia-Key";
pub const APP_INGEST_KEY: &str = "ak_app_41b5d0762fd8ade6949ac2ac";
pub const MAX_BODY_BYTES: usize = 500_000;
pub const QUEUE_DOC: &str = "telemetry-queue.json";
pub const QUEUE_VERSION: u64 = 1;
pub const MAX_EVENTS: usize = 1000;
pub const MAX_LOGS: usize = 200;
pub const BATCH_SIZE: usize = 100;
pub const FLUSH_DELAY: Duration = Duration::from_secs(30);
pub const URGENT_FLUSH_DELAY: Duration = Duration::from_secs(3);
pub const MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);
const FIRST_BACKOFF: Duration = Duration::from_secs(30);
const PERSIST_DELAY: Duration = Duration::from_secs(2);
const CHANNEL_CAPACITY: usize = 4096;
const QUIT_SAVE_DEADLINE: Duration = Duration::from_secs(1);
pub const LOCAL_KEEP_DAYS: i64 = 7;
pub const COUNT_EVENTS: [&str; 6] = [
    "usage_counts",
    "tab_presses",
    "perf_omnibox",
    "perf_memory",
    "telemetry_local_store",
    "password_import",
];

pub trait Poster: Send + Sync {
    fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> u16;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PostKind {
    Events,
    Logs,
    Daily,
}

#[derive(Clone, Debug, Default)]
pub struct CaptureOptions {
    pub urgent: bool,
    pub persist: bool,
    pub at: Option<i64>,
    pub uuid: Option<String>,
    pub raw: Option<Map<String, Value>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SharingSource {
    Settings,
    Onboarding,
    Ask,
    Watch,
    WatchEnded,
}

impl SharingSource {
    pub fn as_str(self) -> &'static str {
        match self {
            SharingSource::Settings => "settings",
            SharingSource::Onboarding => "onboarding",
            SharingSource::Ask => "ask",
            SharingSource::Watch => "watch",
            SharingSource::WatchEnded => "watch_ended",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AskPlacement {
    pub shown_tabs: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviousSession {
    Clean,
    Unclean,
    None,
}

impl PreviousSession {
    pub fn as_str(self) -> &'static str {
        match self {
            PreviousSession::Clean => "clean",
            PreviousSession::Unclean => "unclean",
            PreviousSession::None => "none",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientSession {
    pub previous: PreviousSession,
    pub updated_from: Option<String>,
    pub last_launch_at: Option<i64>,
    pub last_quit_at: Option<i64>,
    pub first_of_version: bool,
    pub cold_nth: Option<i64>,
    pub version_since: Option<i64>,
}

pub struct Config {
    pub data_dir: PathBuf,
    pub info: AppInfo,
    pub url: Option<String>,
    pub poster: Option<Arc<dyn Poster>>,
    pub continuing: bool,
    pub launch_props: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendRule {
    pub url: String,
    pub events: bool,
    pub daily: bool,
}

impl SendRule {
    pub fn new(info: &AppInfo, url_override: Option<&str>) -> SendRule {
        let url_override = url_override.filter(|url| !url.is_empty());
        let shipped = !info.dev && !info.isolated;
        SendRule {
            url: url_override.unwrap_or(LOGS_URL).to_owned(),
            events: url_override.is_some() || shipped,
            daily: url_override.is_some() || shipped,
        }
    }

    pub fn allows(&self, kind: PostKind) -> bool {
        match kind {
            PostKind::Daily => self.daily,
            PostKind::Events | PostKind::Logs => self.events,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DevState {
    pub queued_events: usize,
    pub queued_logs: usize,
    pub dropped_while_off: u64,
    pub dropped_full: u64,
    pub requests: u64,
    pub dry_runs: u64,
}

type Hook = Arc<dyn Fn() + Send + Sync>;

enum Msg {
    Event {
        record: QueuedEvent,
        epoch: String,
        persist: bool,
        urgent: bool,
        dedupe: bool,
    },
    Log {
        record: LogRecord,
        epoch: String,
    },
    Local {
        day: String,
        line: String,
    },
    SaveChoice(Vec<u8>),
    PeriodChanged,
    Flush,
    Schedule(Duration),
    Posted {
        generation: u64,
        status: u16,
    },
    Persist {
        ack: Option<SyncSender<bool>>,
    },
    Timer {
        first: Duration,
        every: Option<Duration>,
        hook: Hook,
    },
    State(SyncSender<DevState>),
    LocalReading(SyncSender<(LocalReading, u64)>),
    ClearLocal(SyncSender<()>),
    Shutdown(SyncSender<()>),
}

pub struct Client {
    dir: PathBuf,
    info: RwLock<AppInfo>,
    saved: Mutex<Saved>,
    session: Mutex<String>,
    upcoming_id: Mutex<Option<String>>,
    tx: SyncSender<Msg>,
    send: SendRule,
    poster: Option<Arc<dyn Poster>>,
    dropped_while_off: AtomicU64,
    dropped_full: AtomicU64,
    requests: AtomicU64,
    dry_runs: AtomicU64,
    posted_bytes: AtomicU64,
    posted_requests: AtomicU64,
    failed_posts: AtomicU64,
    session_start: Mutex<Option<ClientSession>>,
}

static CURRENT: RwLock<Option<Arc<Client>>> = RwLock::new(None);

pub fn client() -> Option<Arc<Client>> {
    CURRENT.read().clone()
}

pub fn start(config: Config) -> (Arc<Client>, ClientSession) {
    if let Some(old) = CURRENT.write().take() {
        old.shutdown();
    }
    let (tx, rx) = mpsc::sync_channel(CHANNEL_CAPACITY);
    let saved = Saved::read(&config.data_dir);
    let send = SendRule::new(&config.info, config.url.as_deref());
    let client = Arc::new(Client {
        dir: config.data_dir.clone(),
        info: RwLock::new(config.info),
        saved: Mutex::new(saved.clone()),
        session: Mutex::new(String::new()),
        upcoming_id: Mutex::new(None),
        tx: tx.clone(),
        send,
        poster: config.poster,
        dropped_while_off: AtomicU64::new(0),
        dropped_full: AtomicU64::new(0),
        requests: AtomicU64::new(0),
        dry_runs: AtomicU64::new(0),
        posted_bytes: AtomicU64::new(0),
        posted_requests: AtomicU64::new(0),
        failed_posts: AtomicU64::new(0),
        session_start: Mutex::new(None),
    });
    consent::set_period(saved.sharing(), saved.epoch().as_deref());
    let (jobs, job_rx) = mpsc::channel::<Job>();
    {
        let client = client.clone();
        let results = tx;
        let _ = std::thread::Builder::new()
            .name("ardia-telemetry-upload".into())
            .spawn(move || upload_loop(client, job_rx, results));
    }
    let worker = Worker::new(client.clone(), jobs);
    let _ = std::thread::Builder::new()
        .name("ardia-telemetry".into())
        .spawn(move || worker.run(rx));
    *CURRENT.write() = Some(client.clone());
    let session = client.begin_session(config.continuing);
    *client.session_start.lock() = Some(session.clone());
    (client, session)
}

pub fn stop() {
    if let Some(client) = CURRENT.write().take() {
        client.shutdown();
    }
}

struct Job {
    generation: u64,
    kind: PostKind,
    body: String,
}

fn upload_loop(client: Arc<Client>, jobs: Receiver<Job>, results: SyncSender<Msg>) {
    while let Ok(job) = jobs.recv() {
        let status = client.post(job.kind, job.body.as_bytes());
        if results
            .send(Msg::Posted {
                generation: job.generation,
                status,
            })
            .is_err()
        {
            break;
        }
    }
}

impl Client {
    pub fn data_dir(&self) -> &Path {
        &self.dir
    }

    pub fn info(&self) -> AppInfo {
        self.info.read().clone()
    }

    pub fn set_engine_version(&self, version: String) {
        self.info.write().engine_version = Some(version);
    }

    pub fn send_rule(&self) -> &SendRule {
        &self.send
    }

    pub fn shown(&self) -> Shown {
        self.saved.lock().shown()
    }

    pub fn saved_number(&self, field: &str) -> Option<i64> {
        self.saved.lock().number(field)
    }

    pub fn saved_text(&self, field: &str) -> Option<String> {
        self.saved.lock().text(field)
    }

    pub fn is_sharing(&self) -> bool {
        self.saved.lock().sharing()
    }

    pub fn session_id(&self) -> String {
        let mut session = self.session.lock();
        if session.is_empty() {
            *session = uuidv7();
        }
        session.clone()
    }

    pub fn session_start(&self) -> Option<ClientSession> {
        self.session_start.lock().clone()
    }

    pub fn post(&self, kind: PostKind, body: &[u8]) -> u16 {
        if !self.send.allows(kind) {
            self.dry_runs.fetch_add(1, Ordering::Relaxed);
            return 200;
        }
        let Some(poster) = &self.poster else {
            self.dry_runs.fetch_add(1, Ordering::Relaxed);
            return 200;
        };
        self.requests.fetch_add(1, Ordering::Relaxed);
        let status = poster.post(
            &self.send.url,
            &[
                ("Content-Type", "application/json"),
                (INGEST_KEY_HEADER, APP_INGEST_KEY),
            ],
            body,
        );
        self.posted_requests.fetch_add(1, Ordering::Relaxed);
        self.posted_bytes
            .fetch_add(body.len() as u64, Ordering::Relaxed);
        if !(200..300).contains(&status) {
            self.failed_posts.fetch_add(1, Ordering::Relaxed);
        }
        status
    }

    pub fn take_post_stats(&self) -> (u64, u64, u64) {
        (
            self.posted_bytes.swap(0, Ordering::Relaxed),
            self.posted_requests.swap(0, Ordering::Relaxed),
            self.failed_posts.swap(0, Ordering::Relaxed),
        )
    }

    pub fn local_reading(&self) -> Option<(LocalReading, u64)> {
        let (ask, answer) = mpsc::sync_channel(1);
        self.tx.send(Msg::LocalReading(ask)).ok()?;
        answer.recv_timeout(Duration::from_secs(3)).ok()
    }

    fn deliver(&self, msg: Msg) -> bool {
        match self.tx.try_send(msg) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                self.dropped_full.fetch_add(1, Ordering::Relaxed);
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    fn save(&self, patch: Map<String, Value>) {
        let (rotated, bytes, sharing, epoch) = {
            let mut saved = self.saved.lock();
            let rotated = saved.apply(patch);
            (rotated, saved.to_json(), saved.sharing(), saved.epoch())
        };
        consent::set_period(sharing, epoch.as_deref());
        if !self.deliver(Msg::SaveChoice(bytes.clone())) {
            let _ = store::write_atomic(&Saved::path(&self.dir), &bytes);
        }
        if rotated {
            let _ = self.tx.send(Msg::PeriodChanged);
        }
    }

    pub fn capture(
        &self,
        event: &'static str,
        props: &Map<String, Value>,
        consent: Option<&Consent>,
        options: CaptureOptions,
    ) -> bool {
        let sharing = consent::still_valid(consent);
        if !sharing && COUNT_EVENTS.contains(&event) {
            self.dropped_while_off.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let (install_id, watch) = {
            let saved = self.saved.lock();
            (saved.install_id(), saved.watch_report_now(now_ms()))
        };
        let at = options.at.unwrap_or_else(now_ms);
        let mut properties = self.info.read().context(&self.session_id(), watch);
        for (key, value) in clean_properties(props) {
            properties.insert(key, value);
        }
        if let Some(raw) = options.raw {
            for (key, value) in raw {
                properties.insert(key, value);
            }
        }
        let record = QueuedEvent {
            uuid: options.uuid.clone().unwrap_or_else(uuidv7),
            event: event.to_owned(),
            distinct_id: install_id.clone().unwrap_or_default(),
            timestamp: crate::ids::iso_timestamp(at),
            properties,
        };
        let mut line = Map::new();
        line.insert("at".into(), json!(at));
        line.insert("kind".into(), json!("event"));
        line.insert("sent".into(), json!(sharing));
        line.insert("event".into(), json!(event));
        line.insert("uuid".into(), json!(record.uuid));
        line.insert(
            "distinct_id".into(),
            if sharing {
                json!(install_id)
            } else {
                Value::Null
            },
        );
        line.insert(
            "properties".into(),
            Value::Object(record.properties.clone()),
        );
        self.deliver(Msg::Local {
            day: utc_day(at),
            line: Value::Object(line).to_string(),
        });
        if !sharing {
            self.dropped_while_off.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let epoch = consent.map(|c| c.epoch().to_owned()).unwrap_or_default();
        self.deliver(Msg::Event {
            record,
            epoch,
            persist: options.persist,
            urgent: options.urgent,
            dedupe: options.uuid.is_some(),
        })
    }

    pub fn log(
        &self,
        level: Level,
        message: &str,
        attributes: &Map<String, Value>,
        consent: Option<&Consent>,
    ) {
        let sharing = consent::still_valid(consent);
        let at = now_ms();
        let mut with_session = Map::new();
        for (key, value) in attributes {
            if matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_)) {
                with_session.insert(key.clone(), value.clone());
            }
        }
        with_session.insert("$session_id".into(), json!(self.session_id()));
        let mut line = Map::new();
        line.insert("at".into(), json!(at));
        line.insert("kind".into(), json!("log"));
        line.insert("sent".into(), json!(sharing));
        line.insert(
            "level".into(),
            json!(if level == Level::Error {
                "error"
            } else {
                "warn"
            }),
        );
        line.insert("message".into(), json!(message));
        line.insert("attributes".into(), Value::Object(with_session.clone()));
        self.deliver(Msg::Local {
            day: utc_day(at),
            line: Value::Object(line).to_string(),
        });
        if !sharing {
            return;
        }
        let epoch = consent.map(|c| c.epoch().to_owned()).unwrap_or_default();
        self.deliver(Msg::Log {
            record: log_record(level, message, &with_session, at),
            epoch,
        });
    }

    pub fn flush(&self) {
        self.deliver(Msg::Flush);
    }

    pub fn every(
        &self,
        first: Duration,
        every: Option<Duration>,
        hook: impl Fn() + Send + Sync + 'static,
    ) {
        let _ = self.tx.send(Msg::Timer {
            first,
            every,
            hook: Arc::new(hook),
        });
    }

    pub fn upcoming_install_id(&self) -> String {
        if let Some(id) = self.saved.lock().install_id() {
            return id;
        }
        self.upcoming_id.lock().get_or_insert_with(uuidv4).clone()
    }

    pub fn ensure_install_id(&self) -> String {
        if let Some(id) = self.saved.lock().install_id() {
            return id;
        }
        let id = self.upcoming_install_id();
        self.save(Map::from_iter([
            ("sharing".to_owned(), json!(false)),
            ("installId".to_owned(), json!(id)),
        ]));
        id
    }

    pub fn set_sharing(&self, on: bool, source: SharingSource, placement: Option<AskPlacement>) {
        let now = now_ms();
        let (sharing, install_id, ask_done, notice) = {
            let saved = self.saved.lock();
            (
                saved.sharing(),
                saved.install_id(),
                saved.number("askDoneAt"),
                saved.text("watchEndedNotice"),
            )
        };
        let mut patch = Map::new();
        patch.insert("decidedAt".into(), json!(now));
        patch.insert("askDoneAt".into(), json!(ask_done.unwrap_or(now)));
        if on == sharing {
            self.save(patch);
            return;
        }
        if !on {
            patch.insert("sharing".into(), json!(false));
            patch.insert("installId".into(), json!(install_id));
            patch.insert("context".into(), Value::Null);
            for (key, value) in no_watch(notice) {
                patch.insert(key, value);
            }
            self.save(patch);
            let props = Map::from_iter([("source".to_owned(), json!(source.as_str()))]);
            self.capture(
                "sharing_turned_off",
                &props,
                consent::consent_now().as_ref(),
                CaptureOptions::default(),
            );
            return;
        }
        let info = self.info();
        patch.insert("sharing".into(), json!(true));
        patch.insert(
            "installId".into(),
            json!(install_id.unwrap_or_else(|| self.upcoming_install_id())),
        );
        patch.insert("crashCursor".into(), json!(now));
        patch.insert("lastVersion".into(), json!(info.app_version));
        patch.insert("lastBuild".into(), json!(info.app_build));
        patch.insert("settingsDay".into(), Value::Null);
        patch.insert("sessionOpen".into(), json!(true));
        self.save(patch);
        let mut props = Map::from_iter([("source".to_owned(), json!(source.as_str()))]);
        if let Some(placement) = placement {
            props.insert("ask_place".into(), json!("new_tab_corner"));
            props.insert("ask_shown_tabs".into(), json!(placement.shown_tabs));
        }
        self.capture(
            "sharing_turned_on",
            &props,
            consent::consent_now().as_ref(),
            CaptureOptions::default(),
        );
    }

    pub fn dismiss_ask(&self) {
        self.save(Map::from_iter([("askDoneAt".to_owned(), json!(now_ms()))]));
    }

    pub fn replace_install_id(&self) -> String {
        let install_id = uuidv4();
        let (keeps_sharing, had_session) = {
            let saved = self.saved.lock();
            (
                saved.sharing() && saved.number("sharingUntil").is_none(),
                saved.text("sessionId").is_some(),
            )
        };
        let session = {
            let mut current = self.session.lock();
            *current = uuidv7();
            current.clone()
        };
        let mut patch = no_watch(None);
        patch.shift_remove("watchEndedNotice");
        patch.insert("sharing".into(), json!(keeps_sharing));
        patch.insert("installId".into(), json!(install_id));
        patch.insert(
            "sessionId".into(),
            if had_session {
                json!(session)
            } else {
                Value::Null
            },
        );
        patch.insert("context".into(), Value::Null);
        self.save(patch);
        install_id
    }

    pub fn save_fields(&self, patch: Map<String, Value>) {
        self.save(patch);
    }

    fn begin_session(&self, continuing: bool) -> ClientSession {
        let info = self.info();
        let saved = self.saved.lock().clone();
        if continuing {
            *self.session.lock() = saved.text("sessionId").unwrap_or_else(uuidv7);
            if saved.flag("sessionOpen") {
                self.save(Map::from_iter([
                    ("sessionOpen".to_owned(), json!(true)),
                    ("sessionId".to_owned(), json!(self.session_id())),
                ]));
            }
            let _ = self.tx.send(Msg::Schedule(Duration::from_secs(2)));
            return ClientSession {
                previous: PreviousSession::Clean,
                updated_from: None,
                last_launch_at: saved.number("lastLaunchAt"),
                last_quit_at: saved.number("lastQuitAt"),
                first_of_version: false,
                cold_nth: None,
                version_since: saved.number("versionSince"),
            };
        }
        let last_version = saved.text("lastVersion");
        let previous = match (&last_version, saved.flag("sessionOpen")) {
            (None, _) => PreviousSession::None,
            (Some(_), true) => PreviousSession::Unclean,
            (Some(_), false) => PreviousSession::Clean,
        };
        let updated_from = last_version
            .clone()
            .filter(|last| *last != info.app_version);
        let last_build = saved.text("lastBuild");
        let first_of_version = last_version.as_deref() != Some(info.app_version.as_str())
            || (last_build.is_some() && last_build != info.app_build);
        let started_at = info.process_start.unwrap_or_else(now_ms);
        let cohort = next_launch_cohort(
            saved.number("lastLaunchAt"),
            saved.number("versionSince"),
            saved.number("versionColdLaunches"),
            first_of_version,
            started_at,
            info.boot_time,
        );
        let mut patch = Map::new();
        patch.insert("sessionOpen".into(), json!(true));
        patch.insert("sessionId".into(), json!(self.session_id()));
        patch.insert("lastVersion".into(), json!(info.app_version));
        patch.insert("lastBuild".into(), json!(info.app_build));
        patch.insert("lastLaunchAt".into(), json!(started_at));
        patch.insert("versionSince".into(), json!(cohort.version_since));
        patch.insert(
            "versionColdLaunches".into(),
            json!(cohort.version_cold_launches),
        );
        let crash_floor = now_ms() - LOCAL_KEEP_DAYS * 86_400_000;
        if !saved.sharing() && saved.number("crashCursor").unwrap_or(0) < crash_floor {
            patch.insert("crashCursor".into(), json!(crash_floor));
        }
        self.save(patch);
        let delay = if previous == PreviousSession::Unclean {
            2
        } else {
            10
        };
        let _ = self.tx.send(Msg::Schedule(Duration::from_secs(delay)));
        ClientSession {
            previous,
            updated_from,
            last_launch_at: saved.number("lastLaunchAt"),
            last_quit_at: saved.number("lastQuitAt"),
            first_of_version,
            cold_nth: cohort.cold_nth,
            version_since: cohort.version_since,
        }
    }

    pub fn end_session(&self) -> bool {
        self.save(Map::from_iter([
            ("sessionOpen".to_owned(), json!(false)),
            ("sessionId".to_owned(), Value::Null),
            ("lastQuitAt".to_owned(), json!(now_ms())),
        ]));
        self.persist_now(QUIT_SAVE_DEADLINE)
    }

    pub fn persist_now(&self, deadline: Duration) -> bool {
        let (ack, landed) = mpsc::sync_channel(1);
        if self.tx.send(Msg::Persist { ack: Some(ack) }).is_err() {
            return false;
        }
        landed.recv_timeout(deadline).unwrap_or(false)
    }

    pub fn clear_local(&self) {
        let (ack, done) = mpsc::sync_channel(1);
        if self.tx.send(Msg::ClearLocal(ack)).is_ok() {
            let _ = done.recv_timeout(Duration::from_secs(2));
        }
    }

    pub fn dev_state(&self) -> DevState {
        let (ask, answer) = mpsc::sync_channel(1);
        let mut state = if self.tx.send(Msg::State(ask)).is_ok() {
            answer
                .recv_timeout(Duration::from_secs(2))
                .unwrap_or_default()
        } else {
            DevState::default()
        };
        state.dropped_while_off = self.dropped_while_off.load(Ordering::Relaxed);
        state.dropped_full = self.dropped_full.load(Ordering::Relaxed);
        state.requests = self.requests.load(Ordering::Relaxed);
        state.dry_runs = self.dry_runs.load(Ordering::Relaxed);
        state
    }

    fn shutdown(&self) {
        let (ack, done) = mpsc::sync_channel(1);
        if self.tx.send(Msg::Shutdown(ack)).is_ok() {
            let _ = done.recv_timeout(Duration::from_secs(3));
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaunchCohort {
    pub version_since: Option<i64>,
    pub version_cold_launches: Option<i64>,
    pub cold_nth: Option<i64>,
}

pub fn next_launch_cohort(
    last_launch_at: Option<i64>,
    version_since: Option<i64>,
    version_cold_launches: Option<i64>,
    first_of_version: bool,
    started_at: i64,
    boot_time: Option<i64>,
) -> LaunchCohort {
    let cold = match (boot_time, last_launch_at) {
        (Some(boot), Some(last)) => Some(last < boot),
        _ => None,
    };
    if first_of_version {
        let cold = cold == Some(true);
        return LaunchCohort {
            version_since: Some(started_at),
            version_cold_launches: Some(i64::from(cold)),
            cold_nth: cold.then_some(1),
        };
    }
    let count = version_cold_launches.map(|before| before + i64::from(cold == Some(true)));
    LaunchCohort {
        version_since,
        version_cold_launches: count,
        cold_nth: if cold == Some(true) { count } else { None },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lane {
    Events,
    Logs,
}

struct Drain {
    generation: u64,
    lane: Lane,
    size: usize,
    batch: Vec<u64>,
}

enum DrainEnd {
    Done,
    Failed,
}

struct Timer {
    due: Instant,
    every: Option<Duration>,
    hook: Hook,
}

struct Worker {
    client: Arc<Client>,
    jobs: Sender<Job>,
    events: VecDeque<(u64, QueuedEvent)>,
    logs: VecDeque<(u64, LogRecord)>,
    seq: u64,
    generation: u64,
    flush_due: Option<Instant>,
    retry_at: Option<Instant>,
    failures: u32,
    drain: Option<Drain>,
    persist_due: Option<Instant>,
    local: LocalStore,
    timers: Vec<Timer>,
}

impl Worker {
    fn new(client: Arc<Client>, jobs: Sender<Job>) -> Worker {
        let local = LocalStore::new(client.dir.join("Telemetry").join("local"));
        Worker {
            client,
            jobs,
            events: VecDeque::new(),
            logs: VecDeque::new(),
            seq: 0,
            generation: 0,
            flush_due: None,
            retry_at: None,
            failures: 0,
            drain: None,
            persist_due: None,
            local,
            timers: Vec::new(),
        }
    }

    fn queue_path(&self) -> PathBuf {
        self.client.dir.join(QUEUE_DOC)
    }

    fn sharing(&self) -> bool {
        self.client.saved.lock().sharing()
    }

    fn saved_epoch(&self) -> Option<String> {
        self.client.saved.lock().epoch()
    }

    fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    fn load_queue(&mut self) {
        let stored = stored_queue(&self.queue_path(), self.saved_epoch().as_deref());
        if self.sharing() {
            for event in stored.0 {
                let seq = self.next_seq();
                self.events.push_back((seq, event));
            }
            for log in stored.1 {
                let seq = self.next_seq();
                self.logs.push_back((seq, log));
            }
        } else if !stored.0.is_empty() || !stored.1.is_empty() || self.queue_path().exists() {
            self.persist();
        }
    }

    fn run(mut self, rx: Receiver<Msg>) {
        self.load_queue();
        self.local.prune(now_ms());
        loop {
            let next = [
                self.flush_due,
                self.persist_due,
                self.local.due(),
                self.timers.iter().map(|t| t.due).min(),
            ]
            .into_iter()
            .flatten()
            .min();
            let message = match next {
                Some(due) => {
                    let wait = due.saturating_duration_since(Instant::now());
                    match rx.recv_timeout(wait) {
                        Ok(message) => Some(message),
                        Err(RecvTimeoutError::Timeout) => None,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                None => match rx.recv() {
                    Ok(message) => Some(message),
                    Err(_) => break,
                },
            };
            if let Some(message) = message
                && !self.handle(message)
            {
                break;
            }
            self.run_due();
        }
    }

    fn run_due(&mut self) {
        let now = Instant::now();
        if self.persist_due.is_some_and(|due| due <= now) {
            self.persist();
        }
        if self.local.due().is_some_and(|due| due <= now) {
            self.local.flush();
        }
        if self.flush_due.is_some_and(|due| due <= now) {
            self.flush_due = None;
            self.start_flush();
        }
        let mut fired = Vec::new();
        for timer in &mut self.timers {
            if timer.due <= now {
                fired.push(timer.hook.clone());
                timer.due = timer.every.map_or(now, |every| now + every);
            }
        }
        self.timers
            .retain(|timer| timer.every.is_some() || timer.due > now);
        for hook in fired {
            hook();
        }
        self.local.prune_if_due(now_ms());
    }

    fn handle(&mut self, message: Msg) -> bool {
        match message {
            Msg::Event {
                record,
                epoch,
                persist,
                urgent,
                dedupe,
            } => {
                if !self.sharing() || self.saved_epoch().as_deref() != Some(epoch.as_str()) {
                    return true;
                }
                if dedupe
                    && self
                        .events
                        .iter()
                        .any(|(_, queued)| queued.uuid == record.uuid)
                {
                    self.schedule_persist(persist);
                    return true;
                }
                let seq = self.next_seq();
                self.events.push_back((seq, record));
                while self.events.len() > MAX_EVENTS {
                    self.events.pop_front();
                }
                self.schedule_persist(persist);
                self.schedule_flush(if urgent {
                    URGENT_FLUSH_DELAY
                } else {
                    FLUSH_DELAY
                });
            }
            Msg::Log { record, epoch } => {
                if !self.sharing() || self.saved_epoch().as_deref() != Some(epoch.as_str()) {
                    return true;
                }
                let seq = self.next_seq();
                self.logs.push_back((seq, record));
                while self.logs.len() > MAX_LOGS {
                    self.logs.pop_front();
                }
                self.schedule_persist(false);
                self.schedule_flush(FLUSH_DELAY);
            }
            Msg::Local { day, line } => self.local.record(day, line),
            Msg::SaveChoice(bytes) => {
                let _ = store::write_atomic(&Saved::path(&self.client.dir), &bytes);
            }
            Msg::PeriodChanged => {
                self.generation += 1;
                self.drain = None;
                self.failures = 0;
                self.retry_at = None;
                self.flush_due = None;
                self.events.clear();
                self.logs.clear();
                self.persist();
                if self.sharing() {
                    self.schedule_flush(FLUSH_DELAY);
                }
            }
            Msg::Flush => {
                self.flush_due = None;
                self.start_flush();
            }
            Msg::Schedule(delay) => self.schedule_flush(delay),
            Msg::Posted { generation, status } => self.posted(generation, status),
            Msg::Persist { ack } => {
                let landed = self.persist();
                self.local.flush();
                if let Some(ack) = ack {
                    let _ = ack.send(landed);
                }
            }
            Msg::Timer { first, every, hook } => self.timers.push(Timer {
                due: Instant::now() + first,
                every,
                hook,
            }),
            Msg::State(answer) => {
                let _ = answer.send(DevState {
                    queued_events: self.events.len(),
                    queued_logs: self.logs.len(),
                    ..DevState::default()
                });
            }
            Msg::LocalReading(answer) => {
                let queue_bytes = self
                    .events
                    .iter()
                    .map(|(_, record)| serde_json::to_vec(record).map_or(0, |b| b.len()))
                    .chain(
                        self.logs
                            .iter()
                            .map(|(_, record)| serde_json::to_vec(record).map_or(0, |b| b.len())),
                    )
                    .sum::<usize>() as u64;
                let _ = answer.send((self.local.take_reading(now_ms()), queue_bytes));
            }
            Msg::ClearLocal(ack) => {
                self.local.clear();
                let _ = ack.send(());
            }
            Msg::Shutdown(ack) => {
                self.persist();
                self.local.flush();
                let _ = ack.send(());
                return false;
            }
        }
        true
    }

    fn schedule_persist(&mut self, now: bool) {
        if now {
            self.persist();
        } else if self.persist_due.is_none() {
            self.persist_due = Some(Instant::now() + PERSIST_DELAY);
        }
    }

    fn persist(&mut self) -> bool {
        self.persist_due = None;
        let doc = json!({
            "events": self.events.iter().map(|(_, e)| e).collect::<Vec<_>>(),
            "logs": self.logs.iter().map(|(_, l)| l).collect::<Vec<_>>(),
            "epoch": self.saved_epoch(),
            "version": QUEUE_VERSION,
        });
        serde_json::to_vec(&doc)
            .ok()
            .is_some_and(|bytes| store::write_atomic(&self.queue_path(), &bytes).is_ok())
    }

    fn schedule_flush(&mut self, delay: Duration) {
        if !self.sharing() {
            return;
        }
        let mut due = Instant::now() + delay;
        if let Some(retry) = self.retry_at {
            due = due.max(retry);
        }
        if self.flush_due.is_some_and(|current| current <= due) {
            return;
        }
        self.flush_due = Some(due);
    }

    fn start_flush(&mut self) {
        if !self.sharing() || self.drain.is_some() {
            return;
        }
        self.drain = Some(Drain {
            generation: self.generation,
            lane: Lane::Events,
            size: BATCH_SIZE,
            batch: Vec::new(),
        });
        self.next_batch();
    }

    fn next_batch(&mut self) {
        loop {
            let Some(drain) = self.drain.as_mut() else {
                return;
            };
            let info = self.client.info();
            let resource = info.resource();
            let (ids, body) = match drain.lane {
                Lane::Events => {
                    let batch: Vec<&(u64, QueuedEvent)> =
                        self.events.iter().take(drain.size).collect();
                    let engine = info.engine_version;
                    let records: Vec<LogRecord> = batch
                        .iter()
                        .map(|(_, event)| {
                            let missing_engine = event
                                .properties
                                .get("engine_version")
                                .is_none_or(Value::is_null);
                            match (&engine, missing_engine) {
                                (Some(engine), true) => {
                                    let mut event = event.clone();
                                    event
                                        .properties
                                        .insert("engine_version".into(), json!(engine));
                                    event_record(&event)
                                }
                                _ => event_record(event),
                            }
                        })
                        .collect();
                    (
                        batch.iter().map(|(seq, _)| *seq).collect::<Vec<_>>(),
                        logs_request(&resource, EVENTS_SCOPE, &records),
                    )
                }
                Lane::Logs => {
                    let batch: Vec<&(u64, LogRecord)> = self.logs.iter().take(drain.size).collect();
                    let records: Vec<LogRecord> = batch.iter().map(|(_, l)| l.clone()).collect();
                    (
                        batch.iter().map(|(seq, _)| *seq).collect::<Vec<_>>(),
                        logs_request(&resource, LOGS_SCOPE, &records),
                    )
                }
            };
            if ids.is_empty() {
                if drain.lane == Lane::Events {
                    drain.lane = Lane::Logs;
                    drain.size = BATCH_SIZE;
                    continue;
                }
                self.finish(DrainEnd::Done);
                return;
            }
            if body.len() > MAX_BODY_BYTES && ids.len() > 1 {
                drain.size = ids.len().div_ceil(2);
                continue;
            }
            drain.batch = ids;
            let kind = if drain.lane == Lane::Events {
                PostKind::Events
            } else {
                PostKind::Logs
            };
            let job = Job {
                generation: drain.generation,
                kind,
                body,
            };
            if self.jobs.send(job).is_err() {
                self.finish(DrainEnd::Failed);
            }
            return;
        }
    }

    fn posted(&mut self, generation: u64, status: u16) {
        if generation != self.generation {
            return;
        }
        let Some(drain) = self.drain.as_mut() else {
            return;
        };
        let count = drain.batch.len();
        match wire::outcome(status, count) {
            Outcome::Retry => {
                self.finish(DrainEnd::Failed);
                return;
            }
            Outcome::Split => drain.size = count.div_ceil(2),
            Outcome::Sent | Outcome::Drop => {
                let sent: HashSet<u64> = drain.batch.drain(..).collect();
                match drain.lane {
                    Lane::Events => self.events.retain(|(seq, _)| !sent.contains(seq)),
                    Lane::Logs => self.logs.retain(|(seq, _)| !sent.contains(seq)),
                }
            }
        }
        self.next_batch();
    }

    fn finish(&mut self, end: DrainEnd) {
        self.drain = None;
        self.persist();
        match end {
            DrainEnd::Failed => {
                self.failures += 1;
                self.retry_at = Some(Instant::now() + backoff_after(self.failures));
                self.schedule_flush(Duration::ZERO);
            }
            DrainEnd::Done => {
                self.failures = 0;
                self.retry_at = None;
            }
        }
    }
}

pub fn backoff_after(failures: u32) -> Duration {
    FIRST_BACKOFF
        .saturating_mul(2u32.saturating_pow(failures.saturating_sub(1)))
        .min(MAX_BACKOFF)
}

fn stored_queue(path: &Path, epoch: Option<&str>) -> (Vec<QueuedEvent>, Vec<LogRecord>) {
    let Some(Value::Object(doc)) = store::read_json(path) else {
        return (Vec::new(), Vec::new());
    };
    if doc.get("version").and_then(Value::as_u64) != Some(QUEUE_VERSION)
        || doc.get("epoch").and_then(Value::as_str) != epoch
    {
        return (Vec::new(), Vec::new());
    }
    let list = |key: &str| {
        doc.get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let events = list("events")
        .into_iter()
        .filter(wire::is_event)
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect();
    let logs = list("logs")
        .into_iter()
        .filter(wire::is_log)
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect();
    (events, logs)
}
