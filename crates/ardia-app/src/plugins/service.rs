use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use ardia_state::{TabId, WindowId};
use ardia_ui::plugins::model::{
    Anchor, CommandView, ConsentOwner, ConsentRequest, ConsentVerb, HostAction, InputBoxRequest,
    PageBarButton, PageBarMatch, PanelContent, PluginHost, PluginNode, PluginPageState,
    PluginPopover, QuickPickRequest, SidePanelCard, SidePanelState, SidebarViewEntry,
    SiteSwitchRow, SurfaceKind, SurfaceMount, ToolbarEntry, ToolbarUpdate,
};
use ardia_ui::plugins::nodes::{
    check_plugin_node, input_box_options_of, plugin_web_url, quick_pick_items_of,
    quick_pick_options_of, toolbar_update_of,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::consent::{ConsentContext, consent_lines};
use super::folders::{Listing, PluginFolders};
use super::manifest::{CommandAction, Network, PanelMode, PluginManifest, page_panel_of};
use super::process::{self, Kind, Launch, Running, SandboxSpec};
use super::records::{PluginRecord, read_records, switch_origin, write_records};
use super::secrets::{PluginSecrets, is_secret_key};
use super::workspace::{self, Redaction, Sent};

const RESTART_DELAYS_MS: [u64; 5] = [1000, 2000, 4000, 8000, 16000];
const CRASH_WINDOW: Duration = Duration::from_secs(600);
pub const CRASH_LIMIT: usize = 5;
const STOP_GRACE: Duration = Duration::from_secs(3);
const STOPPING_NOTICE: Duration = Duration::from_millis(120);
const TOAST_GAP: Duration = Duration::from_millis(1500);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const CHANNEL_PROTOCOL: i64 = 2;
const LEGACY_CHANNEL_PROTOCOL: i64 = 1;
pub const PROMPT_BUSY: &str = "Another plugin prompt is open.";
const MAX_STORAGE_BYTES: usize = 2 << 20;
const STORAGE_VALUE_BYTES: usize = 256 * 1024;
const STORAGE_KEYS: usize = 1000;
const MAX_OPEN_URLS: usize = 10;
pub const PANEL_PARAM: &str = "ardiaPanel";

pub trait PluginEnv: Send + Sync {
    fn notify(&self);
    fn window_eligible(&self, window: &WindowId) -> bool;
    fn focused_window(&self) -> Option<WindowId>;
    fn open_url(&self, window: &WindowId, url: &str, activate: bool) -> Option<TabId>;
    fn toast(&self, window: &WindowId, title: &str, message: Option<&str>);
    fn toast_with_icon(
        &self,
        window: &WindowId,
        title: &str,
        message: Option<&str>,
        icon: Option<&str>,
    ) {
        let _ = icon;
        self.toast(window, title, message);
    }
    fn host_action(&self, action: HostAction, window: &WindowId, tab: &TabId);
    fn tab_url(&self, tab: &TabId) -> Option<String>;
    fn tab_window(&self, tab: &TabId) -> Option<WindowId>;
    fn app_version(&self) -> String;
    fn control_on(&self) -> bool;
    fn open_plugin_settings(&self, name: &str);
    fn confirm(
        &self,
        window: &WindowId,
        title: String,
        message: String,
        confirm: String,
        destructive: bool,
        answer: Box<dyn FnOnce(Option<bool>) + Send>,
    );
    fn state(&self) -> Option<Arc<ardia_state::BrowserState>>;
    fn dispatch(&self, action: ardia_state::Action) -> Result<Option<TabId>, String>;
    fn watch_state(&self, changed: Box<dyn Fn() + Send + Sync>);
    fn control(&self, method: &str, params: Value, done: ControlDone);
    fn evaluate(&self, tab: &TabId, script: &str, done: Box<dyn FnOnce(Option<Value>) + Send>);
    fn on_main(&self, job: Box<dyn FnOnce() + Send>);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProcessState {
    Starting,
    Running { run: u64 },
    Waiting { failures: usize },
    Crashed(String),
    Exited,
    Failed(String),
}

struct Supervised {
    hash: String,
    token: u64,
    failures: Vec<Instant>,
    run: Option<u64>,
    running: Option<Arc<Running>>,
    ready: bool,
    state: ProcessState,
}

#[derive(Clone, Debug)]
struct Mounted {
    plugin: String,
    view: String,
    kind: SurfaceKind,
    window: WindowId,
    context: Map<String, Value>,
    sent_run: Option<u64>,
}

#[derive(Clone, Debug)]
struct SidePanel {
    plugin: String,
    panel: String,
    generation: u64,
    hidden: bool,
}

struct Prompt {
    plugin: String,
    run: u64,
    reply: Value,
}

pub type ControlDone = Box<dyn FnOnce(Result<Value, (String, String)>) + Send>;

type Subscription = (Vec<String>, HashMap<String, Sent>);

type MountedEntry = ((String, String), Mounted);

type CallDone = Box<dyn FnOnce(Result<Value, String>) + Send>;

struct Call {
    plugin: String,
    run: u64,
    done: CallDone,
}

#[derive(Default)]
struct State {
    listings: BTreeMap<String, Listing>,
    records: BTreeMap<String, PluginRecord>,
    supervised: HashMap<String, Supervised>,
    trees: HashMap<(String, String), PluginNode>,
    mounted: HashMap<(String, String), Mounted>,
    toolbar_state: HashMap<(String, String), ToolbarUpdate>,
    side_panels: HashMap<WindowId, SidePanel>,
    retained: HashMap<WindowId, Vec<SidePanel>>,
    popovers: HashMap<WindowId, PluginPopover>,
    command_views: HashMap<WindowId, CommandView>,
    quick_pick: Option<(QuickPickRequest, Prompt)>,
    input_box: Option<(InputBoxRequest, Prompt)>,
    consent: Option<ConsentRequest>,
    calls: HashMap<String, Call>,
    last_toast: HashMap<String, Instant>,
    storage: HashMap<String, Map<String, Value>>,
    subscriptions: HashMap<(String, u64), Subscription>,
    flushing: bool,
    page_reads: HashMap<String, (WindowId, TabId, Instant)>,
    gestures: HashMap<String, WindowId>,
    next_run: u64,
    next_token: u64,
    next_prompt: u64,
    next_call: u64,
    next_generation: u64,
    next_consent: u64,
    stopped: bool,
    candidates: BTreeMap<String, Listing>,
    unsaved: Option<String>,
    page_contexts: HashMap<TabId, page_contexts::HandedContext>,
    update_retries: official_updates::UpdateRetries,
    installs: HashMap<String, official_install::OfficialInstall>,
    official_source: Option<PathBuf>,
    official_download: Option<Arc<dyn super::official::Download>>,
    programs: HashMap<String, program_links::ProgramsEntry>,
    program_places: Option<Result<super::programs::Places, String>>,
    next_program_request: u64,
    programs_swept: bool,
    program_jobs: Option<std::sync::mpsc::Sender<program_links::ProgramJob>>,
}

pub struct PluginService {
    me: Weak<PluginService>,
    folders: PluginFolders,
    env: Arc<dyn PluginEnv>,
    secrets: PluginSecrets,
    state: Mutex<State>,
}

pub const FAILURE_ICON: &str = "exclamationmark.triangle";
const MESSAGE_LIMIT: usize = 200;

fn clipped(text: &str) -> String {
    text.chars().take(MESSAGE_LIMIT).collect()
}

fn failure(code: &str, message: impl Into<String>) -> Value {
    json!({ "error": { "code": code, "message": message.into() } })
}

fn ok(result: Value) -> Value {
    json!({ "result": result })
}

fn text_of(value: Option<&Value>, max: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.chars().take(max).collect())
}

fn usable_id(id: &Value) -> bool {
    match id {
        Value::Number(n) => n.as_i64().is_some_and(|n| n.abs() <= 9_007_199_254_740_991),
        Value::String(s) => s.len() <= 256,
        _ => false,
    }
}

impl State {
    fn active(&self, name: &str) -> Option<&PluginManifest> {
        let listing = self.listings.get(name)?;
        let manifest = listing.read.manifest.as_ref()?;
        let hash = listing.hash.as_ref()?;
        let record = self.records.get(name)?;
        let approves = |h: &Option<String>| h.as_ref() == Some(hash);
        (record.enabled && (approves(&record.approved) || approves(&record.previous)))
            .then_some(manifest)
    }

    fn active_names(&self) -> Vec<String> {
        self.listings
            .keys()
            .filter(|n| self.active(n).is_some())
            .cloned()
            .collect()
    }

    fn ready_run(&self, name: &str) -> Option<u64> {
        let manifest = self.active(name)?;
        let entry = self.supervised.get(name)?;
        let ProcessState::Running { run } = entry.state else {
            return None;
        };
        (manifest.main.is_none() || entry.ready).then_some(run)
    }

    fn running_of(&self, name: &str, run: u64) -> Option<Arc<Running>> {
        let entry = self.supervised.get(name)?;
        (entry.run == Some(run))
            .then(|| entry.running.clone())
            .flatten()
    }

    fn values_for(&self, name: &str) -> Map<String, Value> {
        let Some(manifest) = self
            .listings
            .get(name)
            .and_then(|l| l.read.manifest.as_ref())
        else {
            return Map::new();
        };
        let record = self.records.get(name);
        manifest
            .contributes
            .settings
            .rows
            .iter()
            .filter(|r| r.type_name() != "secret")
            .map(|r| {
                (
                    r.key.clone(),
                    r.value_of(record.and_then(|rec| rec.values.get(&r.key))),
                )
            })
            .collect()
    }
}

pub const LOGIN_PATH_LINE: &str = "Adds ~/.local/bin to your PATH in your shell's login file";

fn program_place_lines(
    lines: Vec<ardia_ui::plugins::model::ConsentLine>,
    places: Option<&Result<super::programs::Places, String>>,
) -> Vec<ardia_ui::plugins::model::ConsentLine> {
    let note = match places {
        Some(Ok(places)) if places.confined.is_none() => return lines,
        Some(Ok(places)) => format!(
            "Puts its programs in {}. Your shell's login file isn't changed",
            places.bin_dir.display()
        ),
        Some(Err(reason)) => format!("Its programs don't go on PATH here: {reason}"),
        None => format!(
            "Its programs don't go on PATH here: {}",
            program_links::NO_PLACES
        ),
    };
    lines
        .into_iter()
        .map(|mut line| {
            if line.text == LOGIN_PATH_LINE {
                line.text = note.clone();
            }
            line
        })
        .collect()
}

impl PluginService {
    pub fn new(folders: PluginFolders, env: Arc<dyn PluginEnv>) -> Arc<Self> {
        let secrets = PluginSecrets::isolated(folders.data_dir.clone());
        Self::with_secrets(folders, env, secrets)
    }

    pub fn with_secrets(
        folders: PluginFolders,
        env: Arc<dyn PluginEnv>,
        secrets: PluginSecrets,
    ) -> Arc<Self> {
        let service = Arc::new_cyclic(|me| PluginService {
            me: me.clone(),
            folders,
            env,
            secrets,
            state: Mutex::new(State::default()),
        });
        let me = Arc::downgrade(&service);
        service.env.watch_state(Box::new(move || {
            if let Some(service) = me.upgrade() {
                service.state_changed();
            }
        }));
        service
    }

    pub fn folders(&self) -> &PluginFolders {
        &self.folders
    }

    pub fn start(&self) {
        let listings = self.folders.list();
        let records = read_records(&self.folders.data_dir);
        let eager: Vec<String> = {
            let mut state = self.state.lock();
            state.listings = listings.into_iter().map(|l| (l.name.clone(), l)).collect();
            state.records = records;
            state.stopped = false;
            state
                .active_names()
                .into_iter()
                .filter(|n| state.active(n).is_some_and(PluginManifest::runs_eagerly))
                .collect()
        };
        for name in eager {
            self.supervise(&name);
        }
        self.reconcile_programs();
        self.reconcile_official();
        self.env.notify();
    }

    pub fn rescan(&self) {
        let listings = self.folders.list();
        let gone: Vec<String> = {
            let mut state = self.state.lock();
            state.listings = listings.into_iter().map(|l| (l.name.clone(), l)).collect();
            #[expect(
                clippy::needless_collect,
                reason = "the names are copied so state can be read inside the filter"
            )]
            let names: Vec<String> = state.supervised.keys().cloned().collect();
            names
                .into_iter()
                .filter(|n| {
                    let hash = state.listings.get(n).and_then(|l| l.hash.clone());
                    state.active(n).is_none()
                        || state
                            .supervised
                            .get(n)
                            .is_some_and(|s| Some(&s.hash) != hash.as_ref())
                })
                .collect()
        };
        for name in gone {
            self.stop_process(&name);
        }
        self.reconcile_programs();
        self.drop_stale_page_contexts();
        self.reconcile_official();
        self.env.notify();
    }

    pub fn stop_all(&self) {
        let names: Vec<String> = {
            let mut state = self.state.lock();
            state.stopped = true;
            state.supervised.keys().cloned().collect()
        };
        for name in names {
            self.stop_process(&name);
        }
    }

    pub fn process_state(&self, name: &str) -> Option<ProcessState> {
        self.state
            .lock()
            .supervised
            .get(name)
            .map(|s| s.state.clone())
    }

    pub fn listings(&self) -> Vec<(String, bool, Vec<String>)> {
        let state = self.state.lock();
        state
            .listings
            .values()
            .map(|l| {
                (
                    l.name.clone(),
                    state.active(&l.name).is_some(),
                    l.read.problems.clone(),
                )
            })
            .collect()
    }

    fn launch_spec(
        &self,
        listing: &Listing,
        manifest: &PluginManifest,
        approved: &str,
    ) -> Result<Launch, String> {
        let folder = self.folders.approved_folder(listing, approved)?;
        let data = self
            .folders
            .data_folder(&listing.name)
            .ok_or("its data folder couldn't be made")?;
        let resolve = |p: &std::path::Path| {
            process::resolved(p).unwrap_or_else(|| p.to_string_lossy().into_owned())
        };
        let plugin = resolve(&folder);
        let (launched, program, arguments, kind, network) = if let Some(main) = &manifest.main {
            let host =
                process::host_binary().ok_or("Ardia's plugin host is missing from the app")?;
            let entry = folder.join(&main.entry);
            if !entry.is_file() {
                return Err(format!(
                    "its entry {} wasn't found, or isn't a script file inside the plugin's folder",
                    main.entry
                ));
            }
            let host = host.to_string_lossy().into_owned();
            (
                host.clone(),
                host,
                vec![
                    "host".into(),
                    "--entry".into(),
                    main.entry.clone(),
                    "--memory-mb".into(),
                    main.memory_mb.to_string(),
                ],
                Kind::Script,
                false,
            )
        } else if let Some(sidecar) = &manifest.sidecar {
            let first = &sidecar.run[0];
            let launched = process::local_program(first, &folder).ok_or_else(|| {
                format!("{first} wasn't found, or isn't a program file inside the plugin's folder")
            })?;
            let local = !first.starts_with('/') && first.contains('/');
            let program = if local {
                folder.join(first).to_string_lossy().into_owned()
            } else {
                launched.clone()
            };
            (
                launched,
                program,
                sidecar.run[1..].to_vec(),
                Kind::Program,
                manifest.permissions.network != Network::Off,
            )
        } else {
            return Err("it names no program".into());
        };
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        let data_path = resolve(&data);
        Ok(Launch {
            name: listing.name.clone(),
            sandbox: SandboxSpec {
                home: resolve(&home),
                app_data: resolve(&self.folders.data_dir),
                config: resolve(&self.folders.config_dir),
                plugin,
                data: data_path,
                program,
                network,
                kind,
            },
            launched,
            arguments,
            cwd: folder,
            env: process::helper_environment(&listing.name, &data),
            log: data.join("plugin.log"),
        })
    }

    pub fn supervise(&self, name: &str) {
        let token = {
            let mut state = self.state.lock();
            if state.stopped {
                return;
            }
            let Some(hash) = state.listings.get(name).and_then(|l| l.hash.clone()) else {
                return;
            };
            if state.active(name).is_none() {
                return;
            }
            if state.supervised.get(name).is_some_and(|s| s.hash == hash) {
                return;
            }
            state.next_token += 1;
            let token = state.next_token;
            state.supervised.insert(
                name.to_owned(),
                Supervised {
                    hash,
                    token,
                    failures: Vec::new(),
                    run: None,
                    running: None,
                    ready: false,
                    state: ProcessState::Starting,
                },
            );
            token
        };
        self.launch(name, token);
    }

    fn launch(&self, name: &str, token: u64) {
        let prepared = {
            let mut state = self.state.lock();
            let Some(entry) = state.supervised.get(name) else {
                return;
            };
            if entry.token != token {
                return;
            }
            let approved = entry.hash.clone();
            let listing = state.listings.get(name).cloned();
            let manifest = state.active(name).cloned();
            state.next_run += 1;
            let run = state.next_run;
            if let Some(entry) = state.supervised.get_mut(name) {
                entry.state = ProcessState::Starting;
                entry.ready = false;
            }
            listing.zip(manifest).map(|(l, m)| (l, m, approved, run))
        };
        let Some((listing, manifest, approved, run)) = prepared else {
            return;
        };
        let spec = self.launch_spec(&listing, &manifest, &approved);
        let started = spec.and_then(|launch| {
            let lines = self.me.clone();
            let exits = self.me.clone();
            let line_name = name.to_owned();
            let exit_name = name.to_owned();
            process::spawn(
                &launch,
                move |line| {
                    if let Some(service) = lines.upgrade() {
                        service.handle_line(&line_name, run, &line);
                    }
                },
                move |code, signal| {
                    if let Some(service) = exits.upgrade() {
                        service.process_exited(&exit_name, run, code, signal);
                    }
                },
            )
        });
        let sidecar_ready = manifest.main.is_none();
        {
            let mut state = self.state.lock();
            let Some(entry) = state.supervised.get_mut(name).filter(|e| e.token == token) else {
                if let Ok(running) = &started {
                    running.terminate(Duration::ZERO);
                }
                return;
            };
            match started {
                Ok(running) => {
                    ardia_telemetry::counts::count("plugin_process_starts");
                    entry.run = Some(run);
                    entry.running = Some(running);
                    entry.state = ProcessState::Running { run };
                    entry.ready = sidecar_ready;
                }
                Err(reason) => {
                    log::warn!("[plugins] {name} couldn't start: {reason}");
                    entry.state = ProcessState::Failed(reason);
                }
            }
        }
        if sidecar_ready {
            self.flush_mounts(name);
        }
        self.env.notify();
    }

    fn process_exited(&self, name: &str, run: u64, code: Option<i32>, signal: Option<i32>) {
        let restart = {
            let mut state = self.state.lock();
            let stopped = state.stopped;
            let Some(entry) = state.supervised.get_mut(name) else {
                return;
            };
            if entry.run != Some(run) {
                return;
            }
            entry.running = None;
            entry.ready = false;
            let clean = code == Some(0) && signal.is_none();
            let mut restart = None;
            if clean || stopped {
                entry.state = ProcessState::Exited;
            } else {
                ardia_telemetry::counts::count("plugin_process_crashes");
                let now = Instant::now();
                entry
                    .failures
                    .retain(|t| now.duration_since(*t) < CRASH_WINDOW);
                entry.failures.push(now);
                let reason = match (signal, code) {
                    (Some(signal), _) => format!("stopped by signal {signal}"),
                    (None, Some(code)) => format!("exited with status {code}"),
                    _ => "exited".to_owned(),
                };
                if entry.failures.len() >= CRASH_LIMIT {
                    entry.state = ProcessState::Crashed(reason);
                } else {
                    let delay = RESTART_DELAYS_MS
                        [(entry.failures.len() - 1).min(RESTART_DELAYS_MS.len() - 1)];
                    entry.state = ProcessState::Waiting {
                        failures: entry.failures.len(),
                    };
                    restart = Some((entry.token, Duration::from_millis(delay)));
                }
            }
            let dropped: Vec<String> = state
                .calls
                .iter()
                .filter(|(_, c)| c.plugin == name && c.run == run)
                .map(|(id, _)| id.clone())
                .collect();
            let calls: Vec<Call> = dropped
                .iter()
                .filter_map(|id| state.calls.remove(id))
                .collect();
            for mounted in state.mounted.values_mut().filter(|m| m.plugin == name) {
                mounted.sent_run = None;
            }
            drop(state);
            for call in calls {
                (call.done)(Err(format!("{name} stopped.")));
            }
            restart
        };
        if let Some((token, delay)) = restart {
            let me = self.me.clone();
            let name = name.to_owned();
            std::thread::spawn(move || {
                std::thread::sleep(delay);
                if let Some(service) = me.upgrade() {
                    service.launch(&name, token);
                }
            });
        }
        self.env.notify();
    }

    pub fn stop_process(&self, name: &str) {
        let (running, main) = {
            let mut state = self.state.lock();
            let main = state
                .listings
                .get(name)
                .and_then(|l| l.read.manifest.as_ref())
                .is_some_and(|m| m.main.is_some());
            let Some(entry) = state.supervised.remove(name) else {
                return;
            };
            state.trees.retain(|(plugin, _), _| plugin != name);
            (entry.running, main)
        };
        if let Some(running) = running {
            std::thread::spawn(move || {
                if main {
                    let notice = json!({ "event": "plugin.stopping", "time": ardia_state::store::now_ms(), "data": {} });
                    if running.send(&notice.to_string()) {
                        std::thread::sleep(STOPPING_NOTICE);
                    }
                }
                running.terminate(STOP_GRACE);
            });
        }
    }

    pub fn ensure_activated(&self, name: &str) {
        let running = {
            let state = self.state.lock();
            state.active(name).is_some_and(|m| m.needs_host())
                && state.supervised.get(name).is_some_and(|e| {
                    matches!(
                        e.state,
                        ProcessState::Running { .. }
                            | ProcessState::Starting
                            | ProcessState::Waiting { .. }
                    )
                })
        };
        if !running {
            let exited = self
                .state
                .lock()
                .supervised
                .get(name)
                .is_some_and(|e| matches!(e.state, ProcessState::Exited));
            if exited {
                self.state.lock().supervised.remove(name);
            }
            self.supervise(name);
        }
    }

    fn send_to(&self, name: &str, run: u64, line: &str) -> bool {
        let running = self.state.lock().running_of(name, run);
        running.is_some_and(|r| r.send(line))
    }

    fn send_ready(&self, name: &str, message: &Value) -> bool {
        let run = self.state.lock().ready_run(name);
        run.is_some_and(|run| self.send_to(name, run, &message.to_string()))
    }

    fn flush_mounts(&self, name: &str) {
        let (run, pending): (Option<u64>, Vec<MountedEntry>) = {
            let state = self.state.lock();
            let run = state.ready_run(name);
            let pending = state
                .mounted
                .iter()
                .filter(|((plugin, _), m)| plugin == name && run.is_some() && m.sent_run != run)
                .map(|(k, m)| (k.clone(), m.clone()))
                .collect();
            (run, pending)
        };
        let Some(run) = run else {
            return;
        };
        for ((plugin, surface), mounted) in pending {
            let mut context = Map::new();
            context.insert("windowId".into(), Value::String(mounted.window.to_string()));
            context.extend(mounted.context.clone());
            let message = json!({ "surface": "mount", "surfaceId": surface, "viewId": mounted.view, "kind": mounted.kind.wire(), "context": context });
            if self.send_to(&plugin, run, &message.to_string())
                && let Some(entry) = self.state.lock().mounted.get_mut(&(plugin, surface))
            {
                entry.sent_run = Some(run);
            }
        }
    }

    fn reply(&self, name: &str, run: u64, id: &Value, body: Value) {
        let mut line = Map::new();
        line.insert("id".into(), id.clone());
        if let Value::Object(fields) = body {
            line.extend(fields);
        }
        self.send_to(name, run, &Value::Object(line).to_string());
    }

    fn accepts(&self, name: &str, run: u64) -> bool {
        let state = self.state.lock();
        !state.stopped
            && state
                .supervised
                .get(name)
                .is_some_and(|e| e.run == Some(run))
    }

    pub fn handle_line(&self, name: &str, run: u64, line: &str) {
        if !self.accepts(name, run) {
            return;
        }
        let Ok(doc) = serde_json::from_str::<Value>(line) else {
            return self.reply(
                name,
                run,
                &Value::Null,
                failure("bad_request", "The line isn't JSON."),
            );
        };
        let Some(fields) = doc.as_object() else {
            return self.reply(
                name,
                run,
                &Value::Null,
                failure("bad_request", "A request is a JSON object."),
            );
        };
        let id = fields.get("id").cloned().unwrap_or(Value::Null);
        if !usable_id(&id) {
            return self.reply(name, run, &Value::Null, failure("bad_request", "A request needs an id: a safe integer, or a well-formed string of at most 256 UTF-8 bytes."));
        }
        let Some(method) = fields.get("method").and_then(Value::as_str) else {
            return self.reply(
                name,
                run,
                &id,
                failure("bad_request", "A request needs a method."),
            );
        };
        let params = match fields.get("params") {
            None => Map::new(),
            Some(Value::Object(params)) => params.clone(),
            Some(_) => {
                return self.reply(
                    name,
                    run,
                    &id,
                    failure("bad_request", "params must be an object."),
                );
            }
        };
        let manifest = self.state.lock().active(name).cloned();
        let Some(manifest) = manifest else {
            return self.reply(name, run, &id, failure("refused", "This plugin is off."));
        };
        if let Some(body) = self.answer(name, run, &manifest, &id, method, &params) {
            self.reply(name, run, &id, body);
        }
    }

    fn window_for(&self, plugin: &str, given: Option<&Value>) -> Option<WindowId> {
        if let Some(given) = given.and_then(Value::as_str) {
            let window = WindowId::new(given);
            return self.env.window_eligible(&window).then_some(window);
        }
        let gesture = self.state.lock().gestures.get(plugin).cloned();
        gesture
            .filter(|w| self.env.window_eligible(w))
            .or_else(|| self.env.focused_window())
    }

    fn note_gesture(&self, plugin: &str, window: &WindowId) {
        let tab = self
            .env
            .state()
            .and_then(|s| s.active_tab(window.as_str()).map(|t| t.id.clone()));
        let mut state = self.state.lock();
        state.gestures.insert(plugin.to_owned(), window.clone());
        if let Some(tab) = tab {
            state
                .page_reads
                .insert(plugin.to_owned(), (window.clone(), tab, Instant::now()));
        }
    }

    fn answer(
        &self,
        name: &str,
        run: u64,
        m: &PluginManifest,
        id: &Value,
        method: &str,
        params: &Map<String, Value>,
    ) -> Option<Value> {
        Some(match method {
            "hello" => ok(json!({
                "app": "Ardia",
                "version": self.env.app_version(),
                "protocol": if m.main.is_some() { CHANNEL_PROTOCOL } else { LEGACY_CHANNEL_PROTOCOL },
                "plugin": name,
                "values": self.state.lock().values_for(name),
            })),
            "values" => ok(Value::Object(self.state.lock().values_for(name))),
            "ready" => {
                let marked = {
                    let mut state = self.state.lock();
                    match state.supervised.get_mut(name) {
                        Some(entry) if entry.run == Some(run) => {
                            entry.ready = true;
                            true
                        }
                        _ => false,
                    }
                };
                if !marked {
                    return Some(failure("refused", "This run of the plugin has ended."));
                }
                self.reply(name, run, id, ok(json!({ "ok": true })));
                self.flush_mounts(name);
                self.env.notify();
                return None;
            }
            "ui.showQuickPick" => return self.ask_quick_pick(name, run, id, params),
            "ui.showInputBox" => return self.ask_input_box(name, run, id, params),
            "ui.showConfirm" => return self.confirm(name, run, m, id, params),
            "ui.showToast" => self.toast(name, params),
            "surface.render" => self.render(name, m, params),
            "surface.close" => self.close_surface(name, params),
            "toolbar.update" => self.toolbar_update(name, m, params),
            "panel.open" | "panel.close" => self.panel_method(name, method, params),
            "storage.get" | "storage.set" | "storage.delete" | "storage.keys" => {
                self.storage(name, m, method, params)
            }
            "open" => self.open_tabs(name, m, params),
            "page.open" => self.page_open(name, m, params),
            "result" => self.answer_call(name, run, params),
            "page.post" => self.page_post(name, m, params),
            "net.fetch" => return self.net_fetch(name, run, m, id, params),
            "secrets.get" | "secrets.set" | "secrets.delete" => {
                self.secrets_method(name, m, method, params)
            }
            "windows" => match (&m.permissions.tabs, self.env.state()) {
                (None, _) => failure("refused", "windows needs the tabs permission."),
                (_, None) => failure("failed", "Ardia isn't ready."),
                (_, Some(state)) => ok(workspace::windows_listing(&state, m.permissions.full_urls)),
            },
            "run" => return self.run_method(name, run, m, id, params),
            "workspace" => self.workspace_method(m),
            "apply" => self.apply_method(m, params),
            "state.subscribe" => self.subscribe_state(name, run, m, params),
            "state.intent" => self.state_intent(m, params),
            "tabs.readActivePage" => return self.read_active_page(name, run, m, id),
            _ => failure("unknown_method", format!("There's no method {method}.")),
        })
    }

    fn ask_quick_pick(
        &self,
        name: &str,
        run: u64,
        id: &Value,
        params: &Map<String, Value>,
    ) -> Option<Value> {
        let Some(items) = params.get("items").and_then(quick_pick_items_of) else {
            return Some(failure(
                "bad_request",
                "items is a list of up to 500 { id, title } with unique ids.",
            ));
        };
        let Some(window) = self.window_for(name, params.get("windowId")) else {
            return Some(failure("no_window", "No window to ask in."));
        };
        ardia_telemetry::counts::count("plugin_ui_prompts");
        let options = quick_pick_options_of(params.get("options").unwrap_or(&Value::Null));
        {
            let mut state = self.state.lock();
            if state.quick_pick.is_some() || state.input_box.is_some() {
                return Some(failure("failed", PROMPT_BUSY));
            }
            state.next_prompt += 1;
            let request = QuickPickRequest {
                id: state.next_prompt,
                plugin: name.to_owned(),
                plugin_title: state.active(name).map(|m| m.title.clone()),
                window,
                items,
                options,
            };
            state.quick_pick = Some((
                request,
                Prompt {
                    plugin: name.to_owned(),
                    run,
                    reply: id.clone(),
                },
            ));
        }
        self.env.notify();
        None
    }

    fn ask_input_box(
        &self,
        name: &str,
        run: u64,
        id: &Value,
        params: &Map<String, Value>,
    ) -> Option<Value> {
        let source = params
            .get("options")
            .filter(|o| o.is_object())
            .cloned()
            .unwrap_or_else(|| Value::Object(params.clone()));
        let Some(options) = input_box_options_of(&source) else {
            return Some(failure("bad_request", "showInputBox needs a title."));
        };
        let Some(window) = self.window_for(name, params.get("windowId")) else {
            return Some(failure("no_window", "No window to ask in."));
        };
        ardia_telemetry::counts::count("plugin_ui_prompts");
        {
            let mut state = self.state.lock();
            if state.quick_pick.is_some() || state.input_box.is_some() {
                return Some(failure("failed", PROMPT_BUSY));
            }
            state.next_prompt += 1;
            let request = InputBoxRequest {
                id: state.next_prompt,
                plugin: name.to_owned(),
                plugin_title: state.active(name).map(|m| m.title.clone()),
                window,
                options,
            };
            state.input_box = Some((
                request,
                Prompt {
                    plugin: name.to_owned(),
                    run,
                    reply: id.clone(),
                },
            ));
        }
        self.env.notify();
        None
    }

    fn confirm(
        &self,
        name: &str,
        run: u64,
        m: &PluginManifest,
        id: &Value,
        params: &Map<String, Value>,
    ) -> Option<Value> {
        let options = params
            .get("options")
            .and_then(Value::as_object)
            .unwrap_or(params);
        let Some(title) = text_of(options.get("title"), 120) else {
            return Some(failure("bad_request", "showConfirm needs a title."));
        };
        let Some(window) = self.window_for(name, params.get("windowId")) else {
            return Some(failure("no_window", "No window to ask in."));
        };
        let me = self.me.clone();
        let (plugin, reply_id) = (name.to_owned(), id.clone());
        self.env.confirm(
            &window,
            format!("{}: {title}", m.title),
            text_of(options.get("message"), 600).unwrap_or_default(),
            text_of(options.get("confirmTitle"), 30).unwrap_or_else(|| "OK".into()),
            options.get("destructive") == Some(&Value::Bool(true)),
            Box::new(move |answer| {
                if let Some(service) = me.upgrade() {
                    let body = match answer {
                        Some(confirmed) => ok(json!({ "confirmed": confirmed })),
                        None => failure("no_window", "No visible window to show the dialog."),
                    };
                    service.reply(&plugin, run, &reply_id, body);
                }
            }),
        );
        None
    }

    fn toast(&self, name: &str, params: &Map<String, Value>) -> Value {
        let Some(title) = text_of(params.get("title"), 120) else {
            return failure("bad_request", "showToast needs a title.");
        };
        let now = Instant::now();
        if self
            .state
            .lock()
            .last_toast
            .get(name)
            .is_some_and(|last| now.duration_since(*last) < TOAST_GAP)
        {
            return failure("failed", "Toasts from one plugin come at most every 1.5 s.");
        }
        let Some(window) = self.window_for(name, params.get("windowId")) else {
            return failure("no_window", "No window to show it in.");
        };
        self.state.lock().last_toast.insert(name.to_owned(), now);
        let options = params.get("options").and_then(Value::as_object);
        let message = text_of(params.get("message"), 300)
            .or_else(|| text_of(params.get("detail"), 300))
            .or_else(|| text_of(options.and_then(|o| o.get("message")), 300));
        self.env.toast(&window, &title, message.as_deref());
        ok(json!({ "ok": true }))
    }

    fn render(&self, name: &str, m: &PluginManifest, params: &Map<String, Value>) -> Value {
        ardia_telemetry::counts::count("plugin_surface_renders");
        let surface = params
            .get("surfaceId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let targets: Vec<String> = {
            let state = self.state.lock();
            if state
                .mounted
                .contains_key(&(name.to_owned(), surface.to_owned()))
            {
                vec![surface.to_owned()]
            } else if m.view_ids().iter().any(|v| v == surface) {
                state
                    .mounted
                    .iter()
                    .filter(|((plugin, _), mounted)| plugin == name && mounted.view == surface)
                    .map(|((_, id), _)| id.clone())
                    .collect()
            } else {
                Vec::new()
            }
        };
        if targets.is_empty() {
            return failure(
                "refused",
                format!(
                    "This plugin has no open surface {}.",
                    surface.chars().take(40).collect::<String>()
                ),
            );
        }
        let tree = match check_plugin_node(params.get("tree").unwrap_or(&Value::Null)) {
            Ok(tree) => tree,
            Err(problem) => return failure("bad_request", format!("tree {problem}.")),
        };
        {
            let mut state = self.state.lock();
            for target in targets {
                state.trees.insert((name.to_owned(), target), tree.clone());
            }
        }
        self.env.notify();
        ok(json!({ "ok": true }))
    }

    fn close_surface(&self, name: &str, params: &Map<String, Value>) -> Value {
        let Some(surface) = params.get("surfaceId").and_then(Value::as_str) else {
            return failure("bad_request", "surface.close needs a surfaceId.");
        };
        let mut closed = 0;
        {
            let mut state = self.state.lock();
            let mounted = state
                .mounted
                .get(&(name.to_owned(), surface.to_owned()))
                .cloned();
            let view_of = |m: &Mounted| m.view.clone();
            let matches_view = |view: &str| {
                mounted
                    .as_ref()
                    .map_or(view == surface, |m| view_of(m) == view)
            };
            let windows: Vec<WindowId> = state
                .command_views
                .iter()
                .filter(|(_, v)| v.plugin == name && matches_view(&v.view))
                .map(|(w, _)| w.clone())
                .collect();
            for w in windows {
                state.command_views.remove(&w);
                closed += 1;
            }
            let windows: Vec<WindowId> = state
                .popovers
                .iter()
                .filter(|(_, p)| p.plugin == name && matches_view(&p.view))
                .map(|(w, _)| w.clone())
                .collect();
            for w in windows {
                state.popovers.remove(&w);
                closed += 1;
            }
            let panel_ids: Vec<(WindowId, String)> = state
                .side_panels
                .iter()
                .filter(|(_, side)| side.plugin == name && !side.hidden)
                .map(|(w, side)| (w.clone(), side.panel.clone()))
                .collect();
            for (window, panel) in panel_ids {
                let spec = state
                    .active(name)
                    .and_then(|m| m.contributes.panels.iter().find(|p| p.id == panel).cloned());
                let view = spec
                    .as_ref()
                    .map(|s| s.view.clone().unwrap_or_else(|| s.id.clone()));
                let hit = match &mounted {
                    Some(m) => {
                        m.context.get("panelId").and_then(Value::as_str) == Some(panel.as_str())
                    }
                    None => {
                        view.as_deref() == Some(surface)
                            || spec.as_ref().is_some_and(|s| s.id == surface)
                    }
                };
                if hit {
                    Self::close_side_panel_in(&mut state, &window, Some(name));
                    closed += 1;
                }
            }
        }
        self.env.notify();
        ok(json!({ "ok": true, "closed": closed }))
    }

    fn toolbar_update(&self, name: &str, m: &PluginManifest, params: &Map<String, Value>) -> Value {
        let item = params
            .get("itemId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !m.contributes.toolbar.iter().any(|t| t.id == item) {
            return failure(
                "refused",
                format!(
                    "This plugin declares no toolbar item {}.",
                    item.chars().take(40).collect::<String>()
                ),
            );
        }
        let Some(update) = toolbar_update_of(params.get("update").unwrap_or(&Value::Null)) else {
            return failure(
                "bad_request",
                "update takes icon, label, badge, tooltip and tone.",
            );
        };
        {
            let mut state = self.state.lock();
            let slot = state
                .toolbar_state
                .entry((name.to_owned(), item.to_owned()))
                .or_default();
            if update.icon.is_some() {
                slot.icon = update.icon;
            }
            if update.label.is_some() {
                slot.label = update.label;
            }
            if update.badge.is_some() {
                slot.badge = update.badge;
            }
            if update.tooltip.is_some() {
                slot.tooltip = update.tooltip;
            }
            if update.tone.is_some() {
                slot.tone = update.tone;
            }
        }
        self.env.notify();
        ok(json!({ "ok": true }))
    }

    fn panel_method(&self, name: &str, method: &str, params: &Map<String, Value>) -> Value {
        let Some(panel) = params.get("panelId").and_then(Value::as_str) else {
            return failure("bad_request", format!("{method} needs a panelId."));
        };
        let Some(window) = self.window_for(name, params.get("windowId")) else {
            return failure("no_window", "No window for the panel.");
        };
        let outcome = if method == "panel.open" {
            self.open_panel(&window, name, panel)
        } else {
            self.close_panel(&window, name, panel)
        };
        match outcome {
            Ok(tab) => {
                let mut result = json!({ "ok": true, "windowId": window.to_string() });
                if let Some(tab) = tab {
                    result["tabId"] = Value::String(tab.to_string());
                }
                ok(result)
            }
            Err(reason) => failure("failed", reason),
        }
    }

    pub fn open_panel(
        &self,
        window: &WindowId,
        name: &str,
        panel_id: &str,
    ) -> Result<Option<TabId>, String> {
        if !self.env.window_eligible(window) {
            return Err("That window can't show plugins.".into());
        }
        let (panel, page_panel) = {
            let state = self.state.lock();
            let m = state
                .active(name)
                .ok_or_else(|| format!("{name} has no panel {panel_id}."))?;
            let panel = m
                .contributes
                .panels
                .iter()
                .find(|p| p.id == panel_id)
                .cloned()
                .ok_or_else(|| format!("{name} has no panel {panel_id}."))?;
            (
                panel,
                page_panel_of(&m.contributes.panels).map(|p| p.id.clone()),
            )
        };
        ardia_telemetry::counts::count("plugin_panel_opens");
        if panel.mode == PanelMode::Sidecar {
            {
                let mut state = self.state.lock();
                let key_matches = |p: &SidePanel| p.plugin == name && p.panel == panel_id;
                let living = state
                    .side_panels
                    .get(window)
                    .filter(|p| !p.hidden && key_matches(p))
                    .map(|p| p.generation)
                    .or_else(|| {
                        state
                            .retained
                            .get(window)
                            .and_then(|r| r.iter().find(|p| key_matches(p)).map(|p| p.generation))
                    });
                let generation = match living {
                    Some(g) => g,
                    None => {
                        state.next_generation += 1;
                        state.next_generation
                    }
                };
                let side = SidePanel {
                    plugin: name.to_owned(),
                    panel: panel_id.to_owned(),
                    generation,
                    hidden: false,
                };
                if panel.retain_context {
                    let kept = state.retained.entry(window.clone()).or_default();
                    kept.retain(|p| !key_matches(p));
                    kept.push(side.clone());
                }
                state.side_panels.insert(window.clone(), side);
            }
            if panel.view.is_some() || panel.file.is_some() {
                self.ensure_activated(name);
            }
            self.env.notify();
            return Ok(None);
        }
        let path = if page_panel.as_deref() == Some(panel.id.as_str()) {
            String::new()
        } else {
            format!("?{PANEL_PARAM}={}", panel.id)
        };
        Ok(self
            .env
            .open_url(window, &format!("ardia://{name}{path}"), true))
    }

    fn close_side_panel_in(state: &mut State, window: &WindowId, plugin: Option<&str>) {
        let Some(current) = state.side_panels.get(window).cloned() else {
            return;
        };
        if current.hidden || plugin.is_some_and(|p| p != current.plugin) {
            return;
        }
        let retained = state.retained.get(window).is_some_and(|r| {
            r.iter()
                .any(|p| p.plugin == current.plugin && p.panel == current.panel)
        });
        if retained {
            if let Some(side) = state.side_panels.get_mut(window) {
                side.hidden = true;
            }
        } else {
            state.side_panels.remove(window);
        }
    }

    fn close_panel(
        &self,
        window: &WindowId,
        name: &str,
        panel_id: &str,
    ) -> Result<Option<TabId>, String> {
        let mut state = self.state.lock();
        let open = state
            .side_panels
            .get(window)
            .is_some_and(|s| !s.hidden && s.plugin == name && s.panel == panel_id);
        if !open {
            return Err(format!(
                "{panel_id} isn't open as a side panel in that window."
            ));
        }
        Self::close_side_panel_in(&mut state, window, Some(name));
        drop(state);
        self.env.notify();
        Ok(None)
    }

    fn storage_path(&self, name: &str) -> Option<PathBuf> {
        self.folders
            .data_folder(name)
            .map(|f| f.join("storage.json"))
    }

    fn storage_data(&self, name: &str) -> Result<Map<String, Value>, String> {
        if let Some(cached) = self.state.lock().storage.get(name) {
            return Ok(cached.clone());
        }
        let path = self
            .storage_path(name)
            .ok_or("The plugin's storage couldn't be opened.")?;
        let data = match std::fs::read_to_string(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
            Err(error) => return Err(format!("The plugin's storage couldn't be read: {error}")),
            Ok(text) => {
                match serde_json::from_str::<Value>(&text) {
                    Ok(Value::Object(data)) => data,
                    Ok(_) => return Err(
                        "The plugin's storage file isn't a JSON object, so Ardia leaves it alone."
                            .into(),
                    ),
                    Err(_) => {
                        return Err(
                            "The plugin's storage file isn't valid JSON, so Ardia leaves it alone."
                                .into(),
                        );
                    }
                }
            }
        };
        self.state
            .lock()
            .storage
            .insert(name.to_owned(), data.clone());
        Ok(data)
    }

    fn storage(
        &self,
        name: &str,
        m: &PluginManifest,
        method: &str,
        params: &Map<String, Value>,
    ) -> Value {
        if !m.permissions.storage {
            return failure("refused", format!("{method} needs the storage permission."));
        }
        let mut data = match self.storage_data(name) {
            Ok(data) => data,
            Err(message) => return failure("failed", message),
        };
        if method == "storage.keys" {
            return ok(Value::Array(
                data.keys().cloned().map(Value::String).collect(),
            ));
        }
        let Some(key) = params.get("key").and_then(Value::as_str).filter(|k| {
            !k.is_empty() && k.len() <= 128 && k.bytes().all(|b| (0x21..=0x7e).contains(&b))
        }) else {
            return failure(
                "bad_request",
                "key is 1 to 128 printable ASCII characters without spaces.",
            );
        };
        match method {
            "storage.get" => return ok(data.get(key).cloned().unwrap_or(Value::Null)),
            "storage.delete" => {
                data.remove(key);
            }
            _ => {
                let value = params.get("value").cloned().unwrap_or(Value::Null);
                if value.to_string().len() > STORAGE_VALUE_BYTES {
                    return failure("bad_request", "value is over 256 KB.");
                }
                if !data.contains_key(key) && data.len() >= STORAGE_KEYS {
                    return failure("bad_request", "storage holds at most 1000 keys.");
                }
                data.insert(key.to_owned(), value);
            }
        }
        let text = Value::Object(data.clone()).to_string();
        if text.len() > MAX_STORAGE_BYTES {
            return failure("bad_request", "storage holds at most 2 MB.");
        }
        let Some(path) = self.storage_path(name) else {
            return failure("failed", "The plugin's storage couldn't be opened.");
        };
        let staged = path.with_extension("json.saving");
        if std::fs::write(&staged, &text)
            .and_then(|_| std::fs::rename(&staged, &path))
            .is_err()
        {
            return failure("failed", "The plugin's storage couldn't be saved.");
        }
        if method == "storage.set" {
            ardia_telemetry::counts::count("plugin_storage_writes");
        }
        self.state.lock().storage.insert(name.to_owned(), data);
        ok(json!({ "ok": true }))
    }

    fn open_tabs(&self, name: &str, m: &PluginManifest, params: &Map<String, Value>) -> Value {
        if !(m.permissions.commands || m.permissions.tabs.as_deref() == Some("write")) {
            return failure(
                "refused",
                "open needs the commands permission or tabs: write.",
            );
        }
        let Some(urls) = params
            .get("urls")
            .and_then(Value::as_array)
            .filter(|u| !u.is_empty() && u.len() <= MAX_OPEN_URLS)
        else {
            return failure(
                "bad_request",
                format!("open takes urls: a list of 1 to {MAX_OPEN_URLS} http or https addresses."),
            );
        };
        let mut checked = Vec::new();
        for (i, url) in urls.iter().enumerate() {
            match url.as_str().and_then(plugin_web_url) {
                Some(url) => checked.push(url),
                None => {
                    ardia_telemetry::counts::count("plugin_url_refusals_open");
                    return failure(
                        "bad_request",
                        format!("urls[{i}] isn't an http or https address with a host."),
                    );
                }
            }
        }
        let Some(window) = self.env.focused_window() else {
            return failure("no_window", "No window to open the tabs in.");
        };
        let activate = params.get("activate") == Some(&Value::Bool(true));
        let tabs: Vec<Value> = checked
            .iter()
            .enumerate()
            .filter_map(|(i, url)| self.env.open_url(&window, url, activate && i == 0))
            .map(|t| Value::String(t.to_string()))
            .collect();
        let _ = name;
        ok(json!({ "ok": true, "tabs": tabs }))
    }

    fn page_open(&self, name: &str, m: &PluginManifest, params: &Map<String, Value>) -> Value {
        if m.page.is_none() {
            return failure("refused", "This plugin has no page.");
        }
        let path = match params.get("path") {
            None => String::new(),
            Some(Value::String(p)) if super::manifest::is_page_path(p) => p.clone(),
            Some(_) => {
                return failure(
                    "bad_request",
                    "page.open's path is /like/this?q=1, at most 512 characters.",
                );
            }
        };
        if params.get("context") == Some(&Value::Bool(true)) && m.permissions.tabs.is_none() {
            return failure(
                "refused",
                "Handing the page a tab needs the tabs permission.",
            );
        }
        let Some(window) = self.env.focused_window() else {
            return failure("no_window", "No window to open the page in.");
        };
        match self
            .env
            .open_url(&window, &format!("ardia://{name}{path}"), true)
        {
            Some(tab) => {
                ardia_telemetry::counts::count("plugin_page_opens");
                ok(json!({ "tabId": tab.to_string(), "windowId": window.to_string() }))
            }
            None => failure("failed", "The page couldn't open."),
        }
    }

    fn net_fetch(
        &self,
        name: &str,
        run: u64,
        m: &PluginManifest,
        id: &Value,
        params: &Map<String, Value>,
    ) -> Option<Value> {
        let allowed: Vec<String> = match &m.permissions.network {
            Network::Off => {
                return Some(failure(
                    "refused",
                    "net.fetch needs the network permission.",
                ));
            }
            Network::Any => vec!["*".into()],
            Network::Hosts(hosts) => hosts.clone(),
        };
        let Some(url) = params
            .get("url")
            .and_then(Value::as_str)
            .and_then(plugin_web_url)
        else {
            return Some(failure(
                "bad_request",
                "url isn't an http or https address with a host.",
            ));
        };
        let host = url
            .split_once("://")
            .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default())
            .map(|authority| {
                authority
                    .rsplit_once(':')
                    .map_or(authority, |(h, _)| h)
                    .to_ascii_lowercase()
            })
            .unwrap_or_default();
        if !url.to_ascii_lowercase().starts_with("https:") && host != "127.0.0.1" {
            ardia_telemetry::counts::count("plugin_net_refusals");
            return Some(failure(
                "refused",
                "net.fetch reaches only https addresses.",
            ));
        }
        let covered = allowed.iter().any(|pattern| {
            pattern == "*"
                || *pattern == host
                || pattern
                    .strip_prefix("*.")
                    .is_some_and(|domain| host.ends_with(&format!(".{domain}")))
        });
        if !covered {
            ardia_telemetry::counts::count("plugin_net_refusals");
            return Some(failure(
                "refused",
                format!("{host} isn't one of the hosts this plugin may reach."),
            ));
        }
        let method = params
            .get("method")
            .and_then(Value::as_str)
            .map_or_else(|| "GET".to_owned(), str::to_uppercase);
        if !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].contains(&method.as_str())
        {
            return Some(failure(
                "bad_request",
                "method is one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS.",
            ));
        }
        let mut headers: Vec<(String, String)> = Vec::new();
        if let Some(given) = params.get("headers") {
            let Some(fields) = given.as_object().filter(|f| f.len() <= 50) else {
                return Some(failure(
                    "bad_request",
                    "headers is an object of header names to text.",
                ));
            };
            for (key, value) in fields {
                let lower = key.to_ascii_lowercase();
                let forbidden = [
                    "host",
                    "cookie",
                    "cookie2",
                    "connection",
                    "content-length",
                    "transfer-encoding",
                    "keep-alive",
                    "upgrade",
                    "te",
                    "trailer",
                    "expect",
                    "origin",
                    "referer",
                ]
                .contains(&lower.as_str())
                    || lower.starts_with("proxy-")
                    || lower.starts_with("sec-");
                if forbidden {
                    return Some(failure("bad_request", format!("Ardia sets {key} itself.")));
                }
                match value.as_str().filter(|v| !v.contains(['\r', '\n', '\0'])) {
                    Some(v) => headers.push((key.clone(), v.to_owned())),
                    None => {
                        return Some(failure(
                            "bad_request",
                            format!("headers.{key} must be text on one line."),
                        ));
                    }
                }
            }
        }
        let body = match params.get("body") {
            None => None,
            Some(Value::String(body)) if body.len() <= 512 * 1024 => {
                Some(body.clone().into_bytes())
            }
            Some(Value::String(_)) => return Some(failure("bad_request", "body is over 512 KB.")),
            Some(_) => {
                return Some(failure(
                    "bad_request",
                    "body is text; JSON.stringify an object first.",
                ));
            }
        };
        if body.is_some() && (method == "GET" || method == "HEAD") {
            return Some(failure(
                "bad_request",
                format!("A {method} request has no body."),
            ));
        }
        let Some(transport) = crate::net::shared() else {
            return Some(failure("failed", "Ardia's network client isn't available."));
        };
        ardia_telemetry::counts::count("plugin_net_fetches");
        let me = self.me.clone();
        let (plugin, reply_id) = (name.to_owned(), id.clone());
        std::thread::spawn(move || {
            let named: Vec<(&str, String)> = headers
                .iter()
                .map(|(k, v)| (k.as_str(), v.clone()))
                .collect();
            let body = match transport.send(&method, &url, &named, body) {
                Ok(reply) => ok(json!({
                    "status": reply.status,
                    "url": url,
                    "headers": reply.headers,
                    "body": reply.text(),
                })),
                Err(crate::net::NetError::TimedOut) => failure("failed", "The request timed out."),
                Err(crate::net::NetError::Unreachable(reason)) => failure("failed", reason),
            };
            if let Some(service) = me.upgrade() {
                service.reply(&plugin, run, &reply_id, body);
            }
        });
        None
    }

    fn secrets_method(
        &self,
        name: &str,
        m: &PluginManifest,
        method: &str,
        params: &Map<String, Value>,
    ) -> Value {
        if !m.permissions.secrets {
            return failure("refused", format!("{method} needs the secrets permission."));
        }
        let Some(key) = params
            .get("key")
            .and_then(Value::as_str)
            .filter(|k| is_secret_key(k))
        else {
            return failure("bad_request", "key is 1 to 64 letters, digits, - and _.");
        };
        let outcome = match method {
            "secrets.get" => self
                .secrets
                .get(name, key)
                .map(|v| v.map_or(Value::Null, Value::String)),
            "secrets.set" => match params.get("value").and_then(Value::as_str) {
                Some(value) if value.len() <= super::secrets::MAX_VALUE_BYTES => {
                    self.secrets.set(name, key, value).map(|_| {
                        ardia_telemetry::counts::count("plugin_secret_writes");
                        json!({ "ok": true })
                    })
                }
                _ => return failure("bad_request", "value is text of at most 16 KB."),
            },
            _ => self
                .secrets
                .delete(name, key)
                .map(|_| json!({ "ok": true })),
        };
        match outcome {
            Ok(value) => ok(value),
            Err(message) => failure("failed", message),
        }
    }

    fn run_method(
        &self,
        name: &str,
        run: u64,
        m: &PluginManifest,
        id: &Value,
        params: &Map<String, Value>,
    ) -> Option<Value> {
        if !m.permissions.commands {
            return Some(failure("refused", "run needs the commands permission."));
        }
        let me = self.me.clone();
        let (plugin, reply_id) = (name.to_owned(), id.clone());
        self.env.control(
            "run",
            Value::Object(params.clone()),
            Box::new(move |outcome| {
                if let Some(service) = me.upgrade() {
                    let body = match outcome {
                        Ok(value) => ok(value),
                        Err((code, message)) => failure(&code, message),
                    };
                    service.reply(&plugin, run, &reply_id, body);
                }
            }),
        );
        None
    }

    fn workspace_method(&self, m: &PluginManifest) -> Value {
        if !m.permissions.workspace {
            return failure("refused", "workspace needs the workspace permission.");
        }
        let Some(state) = self.env.state() else {
            return failure("failed", "Ardia isn't ready.");
        };
        let windows = workspace::windows_listing(&state, true);
        let groups: Vec<Value> = workspace::groups_rows(&state)
            .into_iter()
            .map(|(_, g)| g)
            .collect();
        ok(json!({ "windows": windows, "groups": groups }))
    }

    fn apply_method(&self, m: &PluginManifest, params: &Map<String, Value>) -> Value {
        let Some(ops) = params
            .get("ops")
            .and_then(Value::as_array)
            .filter(|o| !o.is_empty() && o.len() <= 50)
        else {
            return failure(
                "bad_request",
                "apply takes ops: a list of 1 to 50 operations.",
            );
        };
        let tab_only = ops.iter().all(|op| {
            matches!(
                op.get("op").and_then(Value::as_str),
                Some("open" | "tab.close" | "tab.activate")
            ) && op.get("group").is_none()
                && op.get("profile").is_none()
        });
        if !(m.permissions.workspace
            || (tab_only && m.permissions.tabs.as_deref() == Some("write")))
        {
            return failure(
                "refused",
                "apply needs the workspace permission, or tabs: write for open, tab.close and tab.activate.",
            );
        }
        let Some(state) = self.env.state() else {
            return failure("failed", "Ardia isn't ready.");
        };
        let planned = match workspace::apply_ops(
            &state,
            ops,
            self.env.focused_window(),
            !m.permissions.workspace,
        ) {
            Ok(planned) => planned,
            Err((code, message)) => return failure(code, message),
        };
        let mut results = Vec::new();
        for op in planned {
            match op {
                workspace::Op::Open {
                    window,
                    urls,
                    activate,
                } => {
                    let tabs: Vec<Value> = urls
                        .iter()
                        .enumerate()
                        .filter_map(|(i, url)| {
                            self.env
                                .dispatch(workspace::open_tab_action(
                                    &window,
                                    url,
                                    activate && i == 0,
                                ))
                                .ok()
                                .flatten()
                        })
                        .map(|t| Value::String(t.to_string()))
                        .collect();
                    results.push(json!({ "tabs": tabs }));
                }
                workspace::Op::Actions(actions) => {
                    if let Err(message) = self.dispatch_all(actions) {
                        return failure("failed", message);
                    }
                    results.push(json!({}));
                }
            }
        }
        let full = m.permissions.full_urls;
        let mut result = json!({ "ok": true, "results": results });
        if !full && let Some(list) = result.get_mut("results").and_then(Value::as_array_mut) {
            for entry in list {
                if let Some(tabs) = entry.get_mut("tabs").and_then(Value::as_array_mut) {
                    tabs.retain(|t| t.is_string());
                }
            }
        }
        ok(result)
    }

    fn dispatch_all(&self, actions: Vec<ardia_state::Action>) -> Result<(), String> {
        let mut created: Option<ardia_state::GroupId> = None;
        for action in actions {
            let action = match action {
                ardia_state::Action::UpdateGroup { group, patch }
                    if group.as_str() == "__new__" =>
                {
                    match &created {
                        Some(group) => ardia_state::Action::UpdateGroup {
                            group: group.clone(),
                            patch,
                        },
                        None => continue,
                    }
                }
                other => other,
            };
            let first_tab = match &action {
                ardia_state::Action::CreateGroup { tabs, .. } => tabs.first().cloned(),
                _ => None,
            };
            self.env.dispatch(action)?;
            if let (Some(tab), Some(state)) = (first_tab, self.env.state()) {
                created = state.group_of(tab.as_str()).map(|g| g.id.clone());
            }
        }
        Ok(())
    }

    fn state_intent(&self, m: &PluginManifest, params: &Map<String, Value>) -> Value {
        if let Some(key) = params.keys().find(|k| *k != "intent" && *k != "args") {
            return failure(
                "bad_request",
                format!(
                    "state.intent takes intent and args, not {}.",
                    key.chars().take(40).collect::<String>()
                ),
            );
        }
        let intent = params
            .get("intent")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let granted = m
            .permissions
            .state
            .as_ref()
            .is_some_and(|s| s.intents.iter().any(|i| i == intent));
        if workspace::INTENTS.iter().any(|(n, _)| *n == intent) && !granted {
            ardia_telemetry::counts::count("plugin_state_intent_refusals");
            return failure(
                "refused",
                format!("This plugin's permissions.state.intents don't list {intent}."),
            );
        }
        let empty = Map::new();
        let args = match params.get("args") {
            None => &empty,
            Some(Value::Object(args)) => args,
            Some(_) => return failure("bad_request", format!("{intent}'s args are an object.")),
        };
        let Some(state) = self.env.state() else {
            return failure("failed", "Ardia isn't ready.");
        };
        match workspace::intent_actions(&state, intent, args) {
            Err((code, message)) => {
                ardia_telemetry::counts::count("plugin_state_intent_refusals");
                failure(code, message)
            }
            Ok(actions) => match self.dispatch_all(actions) {
                Ok(()) => {
                    ardia_telemetry::counts::count("plugin_state_intents");
                    ok(json!({ "ok": true }))
                }
                Err(message) => failure("failed", message),
            },
        }
    }

    fn subscribe_state(
        &self,
        name: &str,
        run: u64,
        m: &PluginManifest,
        params: &Map<String, Value>,
    ) -> Value {
        if let Some(key) = params.keys().find(|k| *k != "topics" && *k != "resync") {
            return failure(
                "bad_request",
                format!(
                    "state.subscribe takes topics and resync, not {}.",
                    key.chars().take(40).collect::<String>()
                ),
            );
        }
        let Some(given) = params
            .get("topics")
            .and_then(Value::as_array)
            .filter(|t| t.len() <= 8)
        else {
            return failure(
                "bad_request",
                "state.subscribe needs topics: a list of tabs, workspace, navigation, downloads.",
            );
        };
        let mut topics: Vec<String> = Vec::new();
        for (i, topic) in given.iter().enumerate() {
            match topic
                .as_str()
                .filter(|t| super::manifest::STATE_TOPICS.contains(t))
            {
                Some(t) if !topics.iter().any(|k| k == t) => topics.push(t.to_owned()),
                Some(_) => {}
                None => {
                    return failure(
                        "bad_request",
                        format!("topics[{i}] isn't one of tabs, workspace, navigation, downloads."),
                    );
                }
            }
        }
        let granted: Vec<String> = m
            .permissions
            .state
            .as_ref()
            .map(|s| s.events.clone())
            .unwrap_or_default();
        let refused: Vec<&String> = topics.iter().filter(|t| !granted.contains(t)).collect();
        if !refused.is_empty() {
            ardia_telemetry::counts::count("plugin_state_subscribe_refusals");
            return failure(
                "refused",
                format!(
                    "This plugin's permissions.state.events don't list {}.",
                    refused
                        .iter()
                        .map(|t| t.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
        }
        let resync_all = params.get("resync") == Some(&Value::Bool(true));
        {
            let mut state = self.state.lock();
            let key = (name.to_owned(), run);
            if resync_all && state.subscriptions.contains_key(&key) {
                ardia_telemetry::counts::count("plugin_state_resyncs");
            }
            if topics.is_empty() {
                state.subscriptions.remove(&key);
            } else {
                let entry = state
                    .subscriptions
                    .entry(key)
                    .or_insert_with(|| (Vec::new(), HashMap::new()));
                entry.1.retain(|t, _| topics.contains(t) && !resync_all);
                entry.0 = topics.clone();
            }
        }
        self.state_changed();
        ok(json!({ "ok": true, "topics": topics }))
    }

    fn state_changed(&self) {
        {
            let mut state = self.state.lock();
            if state.subscriptions.is_empty() || state.flushing {
                return;
            }
            state.flushing = true;
        }
        let me = self.me.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            if let Some(service) = me.upgrade() {
                service.flush_state();
            }
        });
    }

    fn flush_state(&self) {
        let started = Instant::now();
        let snapshot = self.env.state();
        let lines: Vec<(String, u64, String)> = {
            let mut state = self.state.lock();
            state.flushing = false;
            let Some(browser) = snapshot else {
                return;
            };
            let keys: Vec<(String, u64)> = state.subscriptions.keys().cloned().collect();
            let mut out = Vec::new();
            for key in keys {
                let Some(m) = state.active(&key.0).cloned() else {
                    state.subscriptions.remove(&key);
                    continue;
                };
                let redaction = Redaction {
                    urls: m.permissions.tabs.is_some(),
                    full: m.permissions.full_urls,
                };
                let Some((topics, sent)) = state.subscriptions.get_mut(&key) else {
                    continue;
                };
                for topic in topics.iter().filter(|t| *t == "tabs" || *t == "workspace") {
                    let rows = workspace::rows_for(topic, &browser, redaction);
                    let (frame, signatures) = workspace::diff_frame(topic, rows, sent.get(topic));
                    sent.insert(topic.clone(), signatures);
                    if let Some(frame) = frame {
                        out.push((
                            key.0.clone(),
                            key.1,
                            workspace::wire_line(topic, ardia_state::store::now_ms(), &frame),
                        ));
                    }
                }
            }
            out
        };
        let sent = lines
            .into_iter()
            .filter(|(name, run, line)| self.send_to(name, *run, line))
            .count();
        crate::telemetry::note_plugin_state_events(sent);
        if started.elapsed() > Duration::from_millis(16) {
            ardia_telemetry::counts::count("plugin_state_flushes_slow");
        }
    }

    fn read_active_page(
        &self,
        name: &str,
        run: u64,
        m: &PluginManifest,
        id: &Value,
    ) -> Option<Value> {
        if !m.permissions.active_page {
            return Some(failure(
                "refused",
                "tabs.readActivePage needs the activePage permission.",
            ));
        }
        let gesture = self.state.lock().page_reads.get(name).cloned();
        let Some((window, tab, at)) =
            gesture.filter(|(_, _, at)| at.elapsed() < Duration::from_secs(30))
        else {
            return Some(failure(
                "refused",
                "tabs.readActivePage works only just after you use the plugin (a command, menu, toolbar button or its view).",
            ));
        };
        let _ = at;
        let Some(state) = self.env.state() else {
            return Some(failure("failed", "Ardia isn't ready."));
        };
        let current = state.active_tab(window.as_str()).cloned();
        let Some(page) =
            current.filter(|t| t.id == tab && workspace::eligible_tab(&state, t.id.as_str()))
        else {
            return Some(failure(
                "refused",
                "The page changed since you used the plugin.",
            ));
        };
        if !(page.url.starts_with("http://") || page.url.starts_with("https://")) {
            return Some(failure(
                "refused",
                "There's no page in that window the plugin may read.",
            ));
        }
        let url = if m.permissions.full_urls {
            page.url.clone()
        } else {
            workspace::minimized_url(&page.url)
        };
        let title = page
            .custom_title
            .clone()
            .unwrap_or_else(|| page.title.clone());
        let me = self.me.clone();
        let (plugin, reply_id, tab_id) = (name.to_owned(), id.clone(), page.id.clone());
        let script = "(() => ({ text: (document.body ? document.body.innerText : \"\").slice(0, 200000), selection: String(window.getSelection ? window.getSelection() : \"\").slice(0, 20000), lang: document.documentElement.lang || \"\" }))()";
        self.env.evaluate(
            &page.id,
            script,
            Box::new(move |read| {
                let Some(service) = me.upgrade() else {
                    return;
                };
                let body = match read.filter(|r| r.get("text").is_some_and(Value::is_string)) {
                    None => failure("failed", "The page didn't answer."),
                    Some(read) => {
                        ardia_telemetry::counts::count("plugin_page_reads");
                        ok(json!({
                        "tabId": tab_id.to_string(),
                        "url": url,
                        "title": title,
                        "text": read["text"],
                        "selection": read.get("selection").filter(|s| s.is_string()).cloned().unwrap_or(json!("")),
                        "lang": read.get("lang").and_then(Value::as_str).map(|l| l.chars().take(35).collect::<String>()).unwrap_or_default(),
                    }))
                    }
                };
                service.reply(&plugin, run, &reply_id, body);
            }),
        );
        None
    }

    fn page_post(&self, name: &str, m: &PluginManifest, params: &Map<String, Value>) -> Value {
        let has_page = m.contributes.panels.iter().any(|p| p.file.is_some());
        if !has_page {
            return failure("refused", "This plugin has no page.");
        }
        let view = match params.get("view") {
            None => None,
            Some(Value::String(view)) => Some(view.clone()),
            Some(_) => {
                return failure(
                    "bad_request",
                    "view must be the id a page message came with",
                );
            }
        };
        let Some(message) = params.get("message") else {
            return failure("bad_request", "page.post needs a message");
        };
        let json = message.to_string();
        if json.len() > super::page_view::MAX_TO_PAGE {
            return failure("bad_request", "a message to a page can be at most 256 KB");
        }
        let plugin = name.to_owned();
        self.env.on_main(Box::new(move || {
            super::page_view::post(&plugin, view.as_deref(), &json);
        }));
        ok(json!({ "ok": true }))
    }

    fn page_message(&self, name: &str, line: String) {
        self.ensure_activated(name);
        let run = self.state.lock().supervised.get(name).and_then(|e| e.run);
        if let Some(run) = run {
            self.send_to(name, run, &line);
        }
    }

    fn answer_call(&self, name: &str, run: u64, params: &Map<String, Value>) -> Value {
        let Some(id) = params.get("call").and_then(Value::as_str) else {
            return failure("bad_request", "result needs the call's id.");
        };
        let call = {
            let mut state = self.state.lock();
            match state.calls.get(id) {
                Some(call) if call.plugin == name && call.run == run => state.calls.remove(id),
                _ => None,
            }
        };
        let Some(call) = call else {
            return failure(
                "bad_request",
                format!("There's no call {id} waiting for this plugin."),
            );
        };
        if let Some(error) = params.get("error") {
            (call.done)(Err(error.as_str().map_or_else(
                || "The tool failed.".to_owned(),
                |e| e.chars().take(500).collect(),
            )));
        } else if let Some(result) = params.get("result") {
            (call.done)(Ok(result.clone()));
        } else {
            return failure("bad_request", "result needs a result or an error.");
        }
        ok(json!({ "ok": true }))
    }

    fn call_plugin(&self, name: &str, body: Map<String, Value>, timeout: Duration, done: CallDone) {
        self.call_plugin_as(name, body, json!({ "kind": "command" }), timeout, done);
    }

    fn call_plugin_as(
        &self,
        name: &str,
        body: Map<String, Value>,
        caller: Value,
        timeout: Duration,
        done: CallDone,
    ) -> Option<String> {
        let Some(run) = self.state.lock().ready_run(name) else {
            done(Err(format!("{name}'s helper isn't running.")));
            return None;
        };
        let id = {
            let mut state = self.state.lock();
            state.next_call += 1;
            format!("c{}", state.next_call)
        };
        let done: CallDone = if body.contains_key("tool") {
            ardia_telemetry::counts::count("plugin_tool_calls");
            Box::new(move |outcome: Result<Value, String>| {
                if outcome.is_err() {
                    ardia_telemetry::counts::count("plugin_tool_failures");
                }
                done(outcome)
            })
        } else {
            done
        };
        let mut line = Map::new();
        line.insert("call".into(), Value::String(id.clone()));
        line.extend(body);
        line.insert("caller".into(), caller);
        line.insert("deadline".into(), json!(timeout.as_millis() as u64));
        self.state.lock().calls.insert(
            id.clone(),
            Call {
                plugin: name.to_owned(),
                run,
                done,
            },
        );
        if !self.send_to(name, run, &Value::Object(line).to_string()) {
            if let Some(call) = self.state.lock().calls.remove(&id) {
                (call.done)(Err(format!("Couldn't reach {name}.")));
            }
            return None;
        }
        let me = self.me.clone();
        let plugin = name.to_owned();
        let watched = id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            let Some(service) = me.upgrade() else {
                return;
            };
            let call = service.state.lock().calls.remove(&watched);
            if let Some(call) = call {
                service.send_to(
                    &plugin,
                    call.run,
                    &json!({ "call": watched, "cancel": true }).to_string(),
                );
                (call.done)(Err(format!(
                    "{plugin} didn't answer in {} s.",
                    timeout.as_secs()
                )));
            }
        });
        Some(id)
    }

    pub fn cancel_call(&self, id: &str) -> bool {
        let call = self.state.lock().calls.remove(id);
        let Some(call) = call else {
            return false;
        };
        self.send_to(
            &call.plugin,
            call.run,
            &json!({ "call": id, "cancel": true }).to_string(),
        );
        (call.done)(Err(
            "The call was cancelled before the plugin answered.".into()
        ));
        true
    }

    fn wait_ready(&self, name: &str, deadline: Instant) -> bool {
        self.ensure_activated(name);
        while Instant::now() < deadline {
            if self.state.lock().ready_run(name).is_some() {
                return true;
            }
            if matches!(
                self.process_state(name),
                Some(ProcessState::Crashed(_) | ProcessState::Failed(_))
            ) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    pub fn run_plugin_command(&self, name: &str, command: &str, window: &WindowId) -> bool {
        self.run_plugin_command_with(name, command, window, Map::new())
    }

    pub fn run_plugin_command_with(
        &self,
        name: &str,
        command: &str,
        window: &WindowId,
        context: Map<String, Value>,
    ) -> bool {
        if !self.env.window_eligible(window) {
            return false;
        }
        let Some((m, spec)) = ({
            let state = self.state.lock();
            state.active(name).and_then(|m| {
                m.contributes
                    .commands
                    .iter()
                    .find(|c| c.name == command)
                    .cloned()
                    .map(|c| (m.clone(), c))
            })
        }) else {
            return false;
        };
        self.note_gesture(name, window);
        ardia_telemetry::counts::count("plugin_commands_run");
        match &spec.action {
            CommandAction::Open {
                split,
                context: hands_context,
                side,
                side_setting,
                path,
            } => {
                let side = self.chosen_side(name, side, side_setting.as_deref());
                self.open_page_with(window, name, path, split.then_some(side), *hands_context);
            }
            CommandAction::View(view) => {
                self.state.lock().command_views.insert(
                    window.clone(),
                    CommandView {
                        plugin: name.to_owned(),
                        view: view.clone(),
                        title: spec.title.clone(),
                        icon: spec.icon.clone(),
                        command: spec.name.clone(),
                    },
                );
                self.env.notify();
            }
            CommandAction::Panel(panel) => {
                if let Err(reason) = self.open_panel(window, name, panel) {
                    self.env.toast_with_icon(
                        window,
                        &format!("{}: {} didn't work", m.title, spec.title),
                        Some(&clipped(&reason)),
                        Some(FAILURE_ICON),
                    );
                }
            }
            CommandAction::Tool { .. } | CommandAction::Handler => {
                self.ensure_activated(name);
                let mut body = Map::new();
                match &spec.action {
                    CommandAction::Tool { tool, input } => {
                        body.insert("tool".into(), Value::String(tool.clone()));
                        body.insert("input".into(), Value::Object(input.clone()));
                    }
                    _ => {
                        body.insert("kind".into(), Value::String("command".into()));
                        body.insert("name".into(), Value::String(spec.name.clone()));
                        let mut shown = shown_command_context(&m.permissions, &context);
                        shown.insert("windowId".into(), Value::String(window.to_string()));
                        body.insert("context".into(), Value::Object(shown));
                    }
                }
                let env = Arc::clone(&self.env);
                let window = window.clone();
                let command_icon = Some(spec.icon.clone()).filter(|i| !i.is_empty());
                let (title, command_title) = (m.title, spec.title.clone());
                self.call_plugin(
                    name,
                    body,
                    COMMAND_TIMEOUT,
                    Box::new(move |outcome| match outcome {
                        Err(message) => env.toast_with_icon(
                            &window,
                            &format!("{title}: {command_title} didn't work"),
                            Some(&clipped(&message)),
                            Some(FAILURE_ICON),
                        ),
                        Ok(result) => {
                            if let Some(message) = result
                                .get("message")
                                .and_then(Value::as_str)
                                .filter(|m| !m.trim().is_empty())
                            {
                                env.toast_with_icon(
                                    &window,
                                    &clipped(message),
                                    None,
                                    command_icon.as_deref(),
                                );
                            }
                        }
                    }),
                );
            }
        }
        true
    }

    pub fn request_consent(&self, name: &str, owner: ConsentOwner) -> bool {
        let moves_profiles = self.never_chosen_profiles();
        let request = {
            let state = self.state.lock();
            if state.consent.is_some() {
                return false;
            }
            let Some(listing) = state
                .candidates
                .get(name)
                .or_else(|| state.listings.get(name))
            else {
                return false;
            };
            let (Some(m), Some(hash)) = (listing.read.manifest.as_ref(), listing.hash.clone())
            else {
                return false;
            };
            let record = state.records.get(name);
            let verb = if !m.official {
                ConsentVerb::TurnOn
            } else if record
                .and_then(|r| r.approved.as_ref())
                .is_some_and(|a| *a != hash)
            {
                ConsentVerb::Update
            } else {
                ConsentVerb::Install
            };
            let context = ConsentContext {
                control_off: !self.env.control_on(),
                official: listing.official,
                moves_profiles,
                installed: record.is_some_and(|r| r.installed),
            };
            ConsentRequest {
                id: state.next_consent + 1,
                name: name.to_owned(),
                hash,
                owner,
                title: Some(m.title.clone()),
                icon: m.icon.clone(),
                description: Some(m.description.clone()).filter(|d| !d.is_empty()),
                verb,
                changed: false,
                lines: program_place_lines(
                    consent_lines(m, context),
                    state.program_places.as_ref(),
                ),
            }
        };
        {
            let mut state = self.state.lock();
            state.next_consent = request.id;
            state.consent = Some(request);
        }
        self.env.notify();
        true
    }

    fn enable(&self, name: &str, hash: &str) -> bool {
        let settings = self.env.state().map(|b| b.settings.clone());
        let file_keys = super::defaults::file_keys(&self.folders.config_dir);
        let patch = {
            let mut state = self.state.lock();
            let matches = state
                .listings
                .get(name)
                .is_some_and(|l| l.hash.as_deref() == Some(hash) && l.read.manifest.is_some());
            if !matches {
                return false;
            }
            let default_values = state
                .listings
                .get(name)
                .and_then(|l| l.read.manifest.as_ref())
                .map(PluginManifest::default_values)
                .unwrap_or_default();
            let defaults = state
                .listings
                .get(name)
                .and_then(|l| l.read.manifest.as_ref())
                .map(|m| m.contributes.settings.defaults.clone())
                .unwrap_or_default();
            let records_before = state.records.clone();
            let before = state.records.get(name).cloned().unwrap_or_default();
            let kept = before.enabled && before.approved.as_deref() == Some(hash);
            if before.enabled && !kept {
                super::defaults::splice_applied(&mut state.records, name);
            }
            let plan = match (&settings, kept) {
                (Some(settings), false) => super::defaults::plan_enable(
                    &defaults,
                    &state.records,
                    name,
                    &before.applied,
                    settings,
                    &file_keys,
                ),
                _ => super::defaults::Plan {
                    patch: Vec::new(),
                    applied: before.applied,
                },
            };
            let record = state.records.entry(name.to_owned()).or_default();
            let previous = record.approved.clone().filter(|a| a != hash);
            record.enabled = true;
            record.approved = Some(hash.to_owned());
            record.previous = previous;
            record.applied = plan.applied;
            record.updated = None;
            for (key, value) in default_values {
                record.values.entry(key).or_insert(value);
            }
            if write_records(&self.folders.data_dir, &state.records).is_err() {
                state.records = records_before;
                state.unsaved = Some(name.to_owned());
                drop(state);
                self.env.notify();
                return false;
            }
            if state.unsaved.as_deref() == Some(name) {
                state.unsaved = None;
            }
            plan.patch
        };
        self.apply_settings_patch(patch);
        ardia_telemetry::counts::count("plugin_enables");
        let eager = self
            .state
            .lock()
            .active(name)
            .is_some_and(PluginManifest::runs_eagerly);
        if eager {
            self.supervise(name);
        }
        self.reconcile_programs();
        true
    }

    pub(super) fn apply_settings_patch(&self, patch: Vec<(String, Value)>) {
        if patch.is_empty() {
            return;
        }
        if let Err(error) = self.env.dispatch(ardia_state::Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch(patch),
            from_sync: false,
        }) {
            log::warn!("[plugins] a plugin's settings defaults weren't applied: {error}");
        }
    }

    pub fn turn_plugin_off(&self, name: &str) -> bool {
        let settings = self.env.state().map(|b| b.settings.clone());
        let file_keys = super::defaults::file_keys(&self.folders.config_dir);
        let patch = {
            let mut state = self.state.lock();
            if !state.records.contains_key(name) {
                return false;
            }
            let was_enabled = state.records.get(name).is_some_and(|r| r.enabled);
            let patch = match (&settings, was_enabled) {
                (Some(settings), true) => {
                    super::defaults::plan_disable(&state.records, name, settings, &file_keys)
                }
                _ => Vec::new(),
            };
            let records_before = state.records.clone();
            if was_enabled {
                super::defaults::splice_applied(&mut state.records, name);
            }
            if let Some(record) = state.records.get_mut(name) {
                record.enabled = false;
                if was_enabled {
                    record.applied.clear();
                }
            }
            if write_records(&self.folders.data_dir, &state.records).is_err() {
                state.records = records_before;
                return false;
            }
            ardia_telemetry::counts::count("plugin_disables");
            state.mounted.retain(|(plugin, _), _| plugin != name);
            state.toolbar_state.retain(|(plugin, _), _| plugin != name);
            state.side_panels.retain(|_, p| p.plugin != name);
            state
                .retained
                .values_mut()
                .for_each(|r| r.retain(|p| p.plugin != name));
            state.popovers.retain(|_, p| p.plugin != name);
            state.command_views.retain(|_, v| v.plugin != name);
            patch
        };
        self.apply_settings_patch(patch);
        self.drop_stale_page_contexts();
        let plugin = name.to_owned();
        self.env
            .on_main(Box::new(move || super::page_view::release_plugin(&plugin)));
        self.stop_process(name);
        self.reconcile_programs();
        self.env.notify();
        true
    }

    fn page_bar_match(&self, state: &State, url: &str) -> Option<PageBarMatch> {
        let origin = switch_origin(url)?;
        state.active_names().into_iter().find_map(|name| {
            let m = state.active(&name)?;
            let bar = m.contributes.page_bar.as_ref()?;
            let on = state
                .records
                .get(&name)
                .is_some_and(|r| r.site_switch(&bar.site_switch, &origin));
            on.then(|| PageBarMatch {
                plugin: name.clone(),
                url: url.to_owned(),
                at: 0,
                buttons: bar
                    .buttons
                    .iter()
                    .filter_map(|b| {
                        if b == "|" {
                            Some(PageBarButton::Divider)
                        } else {
                            HostAction::parse(b).map(PageBarButton::Action)
                        }
                    })
                    .collect(),
            })
        })
    }
}

static PAGE_BARS_COUNTED: Mutex<Option<HashMap<TabId, String>>> = Mutex::new(None);

fn note_page_bar_shown(state: &State, tab: &TabId, bar: &PageBarMatch) {
    let key = format!("{}|{}", bar.url, bar.plugin);
    {
        let mut counted = PAGE_BARS_COUNTED.lock();
        let counted = counted.get_or_insert_with(HashMap::new);
        if counted.get(tab) == Some(&key) {
            return;
        }
        counted.insert(tab.clone(), key);
    }
    let official = state.active(&bar.plugin).is_some_and(|m| m.official);
    ardia_telemetry::counts::count(if official {
        "plugin_page_bar_shown_official"
    } else {
        "plugin_page_bar_shown_other"
    });
    let Some(origin) = switch_origin(&bar.url) else {
        return;
    };
    let superseded = state.active_names().into_iter().any(|name| {
        name != bar.plugin
            && state.active(&name).is_some_and(|m| {
                m.contributes.page_bar.as_ref().is_some_and(|b| {
                    state
                        .records
                        .get(&name)
                        .is_some_and(|r| r.site_switch(&b.site_switch, &origin))
                })
            })
    });
    if superseded {
        ardia_telemetry::counts::count("plugin_page_bar_superseded");
    }
}

pub const OMNIBOX_TIMEOUT: Duration = Duration::from_millis(1500);
pub const OMNIBOX_ROWS: usize = 8;
const OMNIBOX_QUERY: usize = 500;

pub fn omnibox_provider_id(plugin: &str, id: &str) -> String {
    format!("plugin:{plugin}:{id}")
}

fn omnibox_text(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(|s| {
            ardia_ui::plugins::nodes::clean(s)
                .chars()
                .filter(|c| {
                    !matches!(
                        c,
                        '\u{007f}'..='\u{009f}' | '\u{061c}' | '\u{200e}' | '\u{200f}'
                    )
                })
                .collect::<String>()
                .trim()
                .chars()
                .take(max)
                .collect()
        })
        .unwrap_or_default()
}

pub fn sanitized_rows(result: &Value) -> Vec<ardia_state::omnibox::providers::ProviderRow> {
    let raw = match result {
        Value::Array(list) => list.clone(),
        Value::Object(fields) => fields
            .get("suggestions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let mut rows = Vec::new();
    for value in raw {
        if rows.len() >= OMNIBOX_ROWS {
            break;
        }
        if !value.is_object() {
            continue;
        }
        let title = omnibox_text(value.get("title"), 120);
        let Some(url) = value
            .get("url")
            .and_then(Value::as_str)
            .and_then(plugin_web_url)
        else {
            continue;
        };
        if title.is_empty() {
            continue;
        }
        let subtitle = omnibox_text(value.get("subtitle"), 200);
        rows.push(ardia_state::omnibox::providers::ProviderRow {
            title,
            url,
            subtitle: (!subtitle.is_empty()).then_some(subtitle),
            icon: value
                .get("icon")
                .and_then(Value::as_str)
                .filter(|i| ardia_ui::plugins::nodes::is_symbol(i))
                .map(str::to_owned),
        });
    }
    rows
}

impl PluginHost for PluginService {
    fn window_eligible(&self, window: &WindowId) -> bool {
        self.env.window_eligible(window)
    }

    fn setting_rows(&self, plugin: &str) -> Vec<ardia_ui::plugins::model::SettingRow> {
        self.setting_rows_of(plugin)
    }

    fn set_setting(
        &self,
        plugin: &str,
        key: &str,
        value: ardia_ui::plugins::model::SettingValue,
    ) -> bool {
        self.set_setting_value(plugin, key, &value)
    }

    fn secret_row_is_set(&self, plugin: &str, key: &str) -> bool {
        self.secret_row_set(plugin, key)
    }

    fn set_secret_row(&self, plugin: &str, key: &str, value: Option<&str>) -> Result<(), String> {
        self.write_secret_row(plugin, key, value)
    }

    fn turn_on_approved(&self, plugin: &str) -> bool {
        self.turn_on_approved_plugin(plugin)
    }

    fn bar_actions(&self) -> Vec<ardia_ui::plugins::model::PluginBarAction> {
        self.plugin_bar_actions()
    }

    fn open_plugin_page(&self, window: &WindowId, plugin: &str) {
        self.open_page_of(window, plugin);
    }

    fn remove_plugin(&self, plugin: &str) -> bool {
        PluginService::remove_plugin(self, plugin)
    }

    fn surface_tree(&self, plugin: &str, instance: &str) -> Option<PluginNode> {
        self.state
            .lock()
            .trees
            .get(&(plugin.to_owned(), instance.to_owned()))
            .cloned()
    }

    fn mount_surface(&self, mount: SurfaceMount) {
        if !self.env.window_eligible(&mount.window) {
            return;
        }
        self.state.lock().mounted.insert(
            (mount.plugin.clone(), mount.instance.clone()),
            Mounted {
                plugin: mount.plugin.clone(),
                view: mount.view,
                kind: mount.kind,
                window: mount.window,
                context: mount.context,
                sent_run: None,
            },
        );
        self.ensure_activated(&mount.plugin);
        self.flush_mounts(&mount.plugin);
    }

    fn unmount_surface(&self, plugin: &str, instance: &str, window: &WindowId) {
        let removed = {
            let mut state = self.state.lock();
            let key = (plugin.to_owned(), instance.to_owned());
            if state.mounted.get(&key).is_none_or(|m| &m.window != window) {
                return;
            }
            state.mounted.remove(&key);
            state.trees.remove(&key);
            true
        };
        if removed {
            self.send_ready(
                plugin,
                &json!({ "surface": "unmount", "surfaceId": instance }),
            );
        }
    }

    fn fire(
        &self,
        plugin: &str,
        instance: &str,
        window: &WindowId,
        handler: &str,
        args: Vec<Value>,
        gesture: bool,
    ) -> bool {
        if handler.is_empty() || handler.len() > 200 || !self.env.window_eligible(window) {
            return false;
        }
        if gesture {
            self.note_gesture(plugin, window);
        }
        self.send_ready(plugin, &json!({ "surface": "event", "surfaceId": instance, "handlerId": handler, "args": args }))
    }

    fn open_url(&self, window: &WindowId, url: &str) {
        if let Some(url) = plugin_web_url(url) {
            self.env.open_url(window, &url, true);
        }
    }

    fn quick_pick(&self) -> Option<QuickPickRequest> {
        self.state
            .lock()
            .quick_pick
            .as_ref()
            .map(|(r, _)| r.clone())
    }

    fn resolve_quick_pick(&self, id: u64, picked: Option<Vec<String>>) {
        let taken = {
            let mut state = self.state.lock();
            match &state.quick_pick {
                Some((request, _)) if request.id == id => state.quick_pick.take(),
                _ => None,
            }
        };
        let Some((request, prompt)) = taken else {
            return;
        };
        let chosen = picked.map(|picked| {
            let known: Vec<&str> = request.items.iter().map(|i| i.id.as_str()).collect();
            let kept: Vec<String> = picked
                .into_iter()
                .filter(|p| known.contains(&p.as_str()))
                .collect();
            if request.options.can_pick_many {
                kept
            } else {
                kept.into_iter().take(1).collect()
            }
        });
        if chosen.is_some() {
            self.note_gesture(&prompt.plugin, &request.window);
        }
        self.reply(
            &prompt.plugin,
            prompt.run,
            &prompt.reply,
            ok(json!({ "picked": chosen })),
        );
        self.env.notify();
    }

    fn input_box(&self) -> Option<InputBoxRequest> {
        self.state.lock().input_box.as_ref().map(|(r, _)| r.clone())
    }

    fn resolve_input_box(&self, id: u64, value: Option<String>) {
        let taken = {
            let mut state = self.state.lock();
            match &state.input_box {
                Some((request, _)) if request.id == id => state.input_box.take(),
                _ => None,
            }
        };
        let Some((request, prompt)) = taken else {
            return;
        };
        if value.is_some() {
            self.note_gesture(&prompt.plugin, &request.window);
        }
        let value = value.map(|v| v.chars().take(10_000).collect::<String>());
        self.reply(
            &prompt.plugin,
            prompt.run,
            &prompt.reply,
            ok(json!({ "value": value })),
        );
        self.env.notify();
    }

    fn command_view(&self, window: &WindowId) -> Option<CommandView> {
        self.state.lock().command_views.get(window).cloned()
    }

    fn close_command_view(&self, window: &WindowId) {
        if self.state.lock().command_views.remove(window).is_some() {
            self.env.notify();
        }
    }

    fn popover(&self, window: &WindowId) -> Option<PluginPopover> {
        self.state.lock().popovers.get(window).cloned()
    }

    fn close_popover(&self, window: &WindowId) {
        if self.state.lock().popovers.remove(window).is_some() {
            self.env.notify();
        }
    }

    fn toolbar_items(&self) -> Vec<ToolbarEntry> {
        let state = self.state.lock();
        state
            .active_names()
            .into_iter()
            .flat_map(|plugin| {
                let items = state
                    .active(&plugin)
                    .map(|m| m.contributes.toolbar.clone())
                    .unwrap_or_default();
                let toolbar_state = &state.toolbar_state;
                items.into_iter().map(move |item| ToolbarEntry {
                    key: format!("{plugin}:{}", item.id),
                    state: toolbar_state
                        .get(&(plugin.clone(), item.id.clone()))
                        .cloned()
                        .unwrap_or_default(),
                    plugin: plugin.clone(),
                    id: item.id,
                    title: item.title,
                    icon: Some(item.icon),
                    tooltip: item.tooltip,
                })
            })
            .collect()
    }

    fn run_toolbar_item(&self, window: &WindowId, plugin: &str, item: &str, anchor: Anchor) {
        if !self.env.window_eligible(window) {
            return;
        }
        let Some(spec) = self
            .state
            .lock()
            .active(plugin)
            .and_then(|m| m.contributes.toolbar.iter().find(|t| t.id == item).cloned())
        else {
            return;
        };
        self.note_gesture(plugin, window);
        ardia_telemetry::counts::count("plugin_toolbar_runs");
        if let Some(command) = &spec.command {
            self.run_plugin_command(plugin, command, window);
            return;
        }
        {
            let mut state = self.state.lock();
            let open = state
                .popovers
                .get(window)
                .is_some_and(|p| p.plugin == plugin && p.item == item);
            if open {
                state.popovers.remove(window);
            } else if let Some(view) = spec.view {
                state.popovers.insert(
                    window.clone(),
                    PluginPopover {
                        plugin: plugin.to_owned(),
                        item: item.to_owned(),
                        view,
                        anchor,
                    },
                );
            }
        }
        self.env.notify();
    }

    fn side_panel(&self, window: &WindowId) -> SidePanelState {
        let state = self.state.lock();
        let card = |side: &SidePanel| {
            let manifest = state.active(&side.plugin);
            let spec =
                manifest.and_then(|m| m.contributes.panels.iter().find(|p| p.id == side.panel));
            SidePanelCard {
                plugin: side.plugin.clone(),
                panel: side.panel.clone(),
                generation: side.generation,
                title: spec
                    .map(|s| s.title.clone())
                    .or_else(|| manifest.map(|m| m.title.clone()))
                    .unwrap_or_else(|| side.plugin.clone()),
                icon: spec
                    .map(|s| s.icon.clone())
                    .filter(|i| !i.is_empty())
                    .or_else(|| manifest.and_then(|m| m.icon.clone()))
                    .unwrap_or_else(|| "puzzlepiece".into()),
                content: match spec {
                    None => PanelContent::Missing,
                    Some(spec) => match &spec.file {
                        Some(file) => PanelContent::File(
                            ardia_ui::plugins::nodes::plugin_file_url(&side.plugin, Some(file))
                                .unwrap_or_default(),
                        ),
                        None => PanelContent::Surface {
                            view: spec.view.clone().unwrap_or_else(|| spec.id.clone()),
                        },
                    },
                },
            }
        };
        SidePanelState {
            shown: state
                .side_panels
                .get(window)
                .filter(|p| !p.hidden)
                .map(card),
            retained: state
                .retained
                .get(window)
                .map(|r| r.iter().map(card).collect())
                .unwrap_or_default(),
        }
    }

    fn close_side_panel(&self, window: &WindowId, plugin: &str) {
        Self::close_side_panel_in(&mut self.state.lock(), window, Some(plugin));
        self.env.notify();
    }

    fn consent(&self) -> Option<ConsentRequest> {
        let mut request = self.state.lock().consent.clone()?;
        let state = self.state.lock();
        request.changed = state
            .candidates
            .get(&request.name)
            .or_else(|| state.listings.get(&request.name))
            .and_then(|l| l.hash.as_deref())
            != Some(request.hash.as_str());
        Some(request)
    }

    fn answer_consent(&self, owner: ConsentOwner, id: u64, confirm: bool) -> bool {
        let asked = {
            let state = self.state.lock();
            match &state.consent {
                Some(request) if request.id == id && request.owner == owner => request.clone(),
                _ => return false,
            }
        };
        let candidate = self.install_candidate(&asked.name, &asked.hash);
        if confirm {
            if candidate.is_some() {
                self.mark_installing(&asked.name);
            }
            if let Some(candidate) = &candidate
                && let Err(reason) = self.promote_candidate(candidate, &asked.hash)
            {
                self.close_install_consent(&asked.name, Err(reason));
                return false;
            }
            if !self.enable(&asked.name, &asked.hash) {
                if candidate.is_some() {
                    self.close_install_consent(
                        &asked.name,
                        Err(official_install::UNSAVED.to_owned()),
                    );
                }
                return false;
            }
        }
        self.state.lock().consent = None;
        self.env.notify();
        self.close_install_consent(
            &asked.name,
            if confirm {
                Ok(())
            } else {
                Err(super::official::FetchCode::Cancelled.reason().to_owned())
            },
        );
        true
    }

    fn site_switch_rows(&self, tab: &TabId) -> Vec<SiteSwitchRow> {
        let Some(origin) = self.env.tab_url(tab).and_then(|u| switch_origin(&u)) else {
            return Vec::new();
        };
        if self
            .env
            .tab_window(tab)
            .is_none_or(|w| !self.env.window_eligible(&w))
        {
            return Vec::new();
        }
        let state = self.state.lock();
        state
            .active_names()
            .into_iter()
            .flat_map(|plugin| {
                let switches = state
                    .active(&plugin)
                    .map(|m| m.contributes.site_switches.clone())
                    .unwrap_or_default();
                let record = state.records.get(&plugin);
                let origin = origin.clone();
                switches.into_iter().map(move |s| SiteSwitchRow {
                    on: record.is_some_and(|r| r.site_switch(&s.key, &origin)),
                    plugin: plugin.clone(),
                    key: s.key,
                    title: s.title,
                    icon: s.icon,
                })
            })
            .collect()
    }

    fn set_site_switch(&self, plugin: &str, key: &str, url: &str, on: bool) {
        let Some(origin) = switch_origin(url) else {
            return;
        };
        {
            let mut state = self.state.lock();
            let declared = state
                .active(plugin)
                .is_some_and(|m| m.contributes.site_switches.iter().any(|s| s.key == key));
            if !declared {
                return;
            }
            let Some(record) = state.records.get_mut(plugin) else {
                return;
            };
            record.set_site_switch(key, &origin, on);
            if let Err(error) = write_records(&self.folders.data_dir, &state.records) {
                log::warn!("[plugins] couldn't save plugins.json: {error}");
            }
        }
        self.env.notify();
    }

    fn sidebar_views(&self) -> Vec<SidebarViewEntry> {
        let state = self.state.lock();
        state
            .active_names()
            .into_iter()
            .flat_map(|plugin| {
                let views = state
                    .active(&plugin)
                    .map(|m| m.contributes.sidebar_views.clone())
                    .unwrap_or_default();
                views.into_iter().map(move |v| SidebarViewEntry {
                    plugin: plugin.clone(),
                    id: v.id,
                    title: v.title,
                    icon: v.icon,
                })
            })
            .collect()
    }

    fn page_bar(&self, window: &WindowId, tab: &TabId) -> Option<PageBarMatch> {
        if !self.env.window_eligible(window) {
            return None;
        }
        let url = self.env.tab_url(tab)?;
        let state = self.state.lock();
        let found = self.page_bar_match(&state, &url);
        if let Some(bar) = &found {
            note_page_bar_shown(&state, tab, bar);
        }
        found
    }

    fn run_host_action(&self, action: HostAction, window: &WindowId, tab: &TabId) {
        self.env.host_action(action, window, tab);
    }

    fn page(&self, tab: &TabId, name: &str) -> Option<PluginPageState> {
        let handed = self.shown_page_context(tab, name);
        let window = self.env.tab_window(tab);
        if window.is_none_or(|w| !self.env.window_eligible(&w)) {
            return Some(PluginPageState::PrivateWindow);
        }
        let url = self.env.tab_url(tab).unwrap_or_default();
        let panel_param = url
            .split_once('?')
            .and_then(|(_, q)| {
                q.split('&')
                    .find_map(|kv| kv.strip_prefix(&format!("{PANEL_PARAM}=")))
            })
            .map(str::to_owned);
        let state = self.state.lock();
        let Some(m) = state.active(name) else {
            let title = state
                .listings
                .get(name)
                .and_then(|l| l.read.manifest.as_ref())
                .map(|m| {
                    m.page
                        .as_ref()
                        .map_or_else(|| m.title.clone(), |p| p.title.clone())
                })
                .unwrap_or_else(|| name.to_owned());
            return Some(PluginPageState::Off { title });
        };
        let is_page =
            |p: &&super::manifest::PanelSpec| matches!(p.mode, PanelMode::Tab | PanelMode::Split);
        let view_panel = match &panel_param {
            Some(id) => m
                .contributes
                .panels
                .iter()
                .filter(is_page)
                .find(|p| &p.id == id && p.view.is_some() && p.file.is_none()),
            None if m
                .contributes
                .panels
                .iter()
                .filter(is_page)
                .any(|p| p.file.is_some()) =>
            {
                None
            }
            None => m
                .contributes
                .panels
                .iter()
                .filter(is_page)
                .find(|p| p.view.is_some()),
        };
        if let Some(panel) = view_panel {
            return Some(PluginPageState::Surface {
                view: panel.view.clone().unwrap_or_default(),
                panel: panel.id.clone(),
            });
        }
        let title = m
            .page
            .as_ref()
            .map_or_else(|| m.title.clone(), |p| p.title.clone());
        let Some(page) = &m.page else {
            return Some(PluginPageState::Off { title });
        };
        let process = state.supervised.get(name).map(|s| s.state.clone());
        if m.needs_host() {
            match process {
                Some(ProcessState::Crashed(_)) | Some(ProcessState::Failed(_)) => {
                    return Some(PluginPageState::Stopped { title });
                }
                Some(ProcessState::Running { .. }) => {}
                _ => return Some(PluginPageState::Starting { title }),
            }
        }
        Some(PluginPageState::File {
            url: ardia_ui::plugins::nodes::plugin_file_url(name, Some(&page.file))
                .unwrap_or_default(),
            context: handed,
        })
    }

    fn open_plugin_settings(&self, name: &str) {
        self.env.open_plugin_settings(name);
    }

    fn file_view(
        &self,
        window: &WindowId,
        plugin: &str,
        url: &str,
        key: &str,
        context: Option<String>,
    ) -> Option<ardia_engine::NativeViewHandle> {
        if !self.env.window_eligible(window) {
            return None;
        }
        let (listing, approved, offline) = {
            let state = self.state.lock();
            let m = state.active(plugin)?;
            let offline = m.permissions.network != Network::Any;
            (
                state.listings.get(plugin)?.clone(),
                state.records.get(plugin)?.approved.clone()?,
                offline,
            )
        };
        let folder = self.folders.approved_folder(&listing, &approved).ok()?;
        let me = self.me.clone();
        let target = plugin.to_owned();
        let spec = super::page_view::PageSpec {
            plugin: plugin.to_owned(),
            url: url.to_owned(),
            folder,
            offline,
            context,
            on_message: Arc::new(move |line| {
                if let Some(service) = me.upgrade() {
                    service.page_message(&target, line);
                }
            }),
        };
        super::page_view::view_for(key, &spec)
    }

    fn release_file_view(&self, key: &str) {
        super::page_view::release(key);
    }

    fn plugin_programs(&self) -> Vec<ardia_ui::plugins::model::PluginPrograms> {
        self.programs_view()
    }

    fn relink_programs(&self, plugin: &str) -> Result<(), String> {
        self.relink_plugin_programs(plugin)
    }

    fn omnibox_providers(
        &self,
        window: &WindowId,
    ) -> Vec<ardia_state::omnibox::providers::PluginProvider> {
        if !self.env.window_eligible(window) {
            return Vec::new();
        }
        let state = self.state.lock();
        state
            .active_names()
            .into_iter()
            .filter_map(|plugin| {
                state
                    .active(&plugin)
                    .filter(|m| m.main.is_some())
                    .map(|m| (plugin, m.contributes.omnibox.clone()))
            })
            .flat_map(|(plugin, specs)| {
                specs.into_iter().map(
                    move |spec| ardia_state::omnibox::providers::PluginProvider {
                        id: omnibox_provider_id(&plugin, &spec.id),
                        title: spec.title,
                        keyword: spec.keyword,
                        global: spec.global,
                    },
                )
            })
            .collect()
    }

    fn query_omnibox_provider(
        &self,
        id: &str,
        text: &str,
    ) -> futures::channel::oneshot::Receiver<Vec<ardia_state::omnibox::providers::ProviderRow>>
    {
        let (answer, rows) = futures::channel::oneshot::channel();
        let target = id
            .strip_prefix("plugin:")
            .and_then(|rest| rest.split_once(':'))
            .map(|(plugin, provider)| (plugin.to_owned(), provider.to_owned()))
            .filter(|(plugin, provider)| {
                self.state.lock().active(plugin).is_some_and(|m| {
                    m.main.is_some() && m.contributes.omnibox.iter().any(|o| o.id == *provider)
                })
            });
        let Some((plugin, provider)) = target else {
            let _ = answer.send(Vec::new());
            return rows;
        };
        let text: String = text.chars().take(OMNIBOX_QUERY).collect();
        ardia_telemetry::counts::count("plugin_omnibox_queries");
        let me = self.me.clone();
        std::thread::spawn(move || {
            let Some(service) = me.upgrade() else {
                return;
            };
            let deadline = Instant::now() + OMNIBOX_TIMEOUT;
            if answer.is_canceled() || !service.wait_ready(&plugin, deadline) {
                let _ = answer.send(Vec::new());
                return;
            }
            let (settled, outcome) = std::sync::mpsc::channel();
            let mut body = Map::new();
            body.insert("kind".into(), Value::String("omnibox".into()));
            body.insert("name".into(), Value::String(provider));
            body.insert("input".into(), Value::String(text));
            let left = deadline
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(1));
            let call = service.call_plugin_as(
                &plugin,
                body,
                json!({ "kind": "host" }),
                left,
                Box::new(move |result| {
                    let _ = settled.send(result);
                }),
            );
            loop {
                match outcome.recv_timeout(Duration::from_millis(20)) {
                    Ok(Ok(result)) => {
                        let _ = answer.send(sanitized_rows(&result));
                        return;
                    }
                    Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        let _ = answer.send(Vec::new());
                        return;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if answer.is_canceled() {
                            if let Some(id) = &call {
                                service.cancel_call(id);
                            }
                            return;
                        }
                    }
                }
            }
        });
        rows
    }

    fn has_plugin(&self, name: &str) -> bool {
        self.state.lock().listings.contains_key(name)
    }

    fn ask_consent(&self, name: &str, owner: ConsentOwner) -> bool {
        self.request_consent(name, owner)
    }

    fn turn_off(&self, name: &str) -> bool {
        self.turn_plugin_off(name)
    }

    fn run_command(&self, window: &WindowId, plugin: &str, command: &str) -> bool {
        self.run_plugin_command(plugin, command, window)
    }

    fn menu_entries(&self, slot: &str) -> Vec<ardia_ui::plugins::model::PluginMenuEntry> {
        let state = self.state.lock();
        let mut out = Vec::new();
        for plugin in state.active_names() {
            let Some(m) = state.active(&plugin) else {
                continue;
            };
            let entries = match slot {
                "group" => &m.contributes.menus_group,
                _ => &m.contributes.menus_tab,
            };
            for entry in entries {
                let Some(command) = m
                    .contributes
                    .commands
                    .iter()
                    .find(|c| c.name == entry.command)
                else {
                    continue;
                };
                out.push(ardia_ui::plugins::model::PluginMenuEntry {
                    plugin: plugin.clone(),
                    plugin_title: m.title.clone(),
                    plugin_icon: m.icon.clone(),
                    command: command.name.clone(),
                    title: entry.title.clone().unwrap_or_else(|| command.title.clone()),
                    icon: entry
                        .icon
                        .clone()
                        .or_else(|| (!command.icon.is_empty()).then(|| command.icon.clone())),
                    when: entry.when.clone(),
                    command_when: command.when.clone(),
                });
            }
        }
        out
    }

    fn run_menu_command(
        &self,
        window: &WindowId,
        plugin: &str,
        command: &str,
        context: Map<String, Value>,
    ) -> bool {
        ardia_telemetry::counts::count("plugin_menu_runs");
        self.run_plugin_command_with(plugin, command, window, context)
    }
}

pub fn shown_command_context(
    permissions: &crate::plugins::manifest::Permissions,
    context: &Map<String, Value>,
) -> Map<String, Value> {
    let named = |key: &str, exact: &str, suffix: &str| {
        key == exact
            || key.strip_suffix(suffix).is_some_and(|head| {
                !head.is_empty() && head.chars().all(|c| c.is_ascii_lowercase())
            })
    };
    let tabs = permissions.tabs.is_some();
    let mut out = Map::new();
    for (key, value) in context {
        if named(key, "url", "Url") {
            if let (Value::String(url), true) = (value, tabs) {
                let shown = if permissions.full_urls {
                    url.clone()
                } else {
                    crate::plugins::workspace::minimized_url(url)
                };
                out.insert(key.clone(), Value::String(shown));
            }
        } else if named(key, "title", "Title") {
            if let (Value::String(_), true) = (value, tabs) {
                out.insert(key.clone(), value.clone());
            }
        } else if matches!(key.as_str(), "selection" | "text" | "linkText") {
            if let (Value::String(text), true) = (value, permissions.active_page) {
                out.insert(
                    key.clone(),
                    Value::String(text.chars().take(20_000).collect()),
                );
            }
        } else if matches!(
            value,
            Value::Null | Value::String(_) | Value::Number(_) | Value::Bool(_)
        ) {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

mod official_install;
mod official_updates;
mod page_contexts;
mod program_links;
mod setting_rows;
mod settings_page;

#[cfg(test)]
mod tests;
