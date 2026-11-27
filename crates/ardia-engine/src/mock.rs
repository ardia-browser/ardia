use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};

use crate::BrowserEngine;
use crate::commands::*;
use crate::error::{EngineError, EngineResult};
use crate::events::{EngineEvent, EventBus};
use crate::policy::{DefaultPolicy, HostPolicy, NewBrowserWindow};
use crate::reply::{Reply, Responder};
use crate::services::{SecretValue, ServiceArgs, ServiceName, parse_service_reply, wipe_value};
use crate::types::*;

pub type ServiceHandler = Arc<dyn Fn(&str, &Value) -> EngineResult<Value> + Send + Sync>;
pub type Evaluator = Arc<dyn Fn(EngineTabId, &str) -> EngineResult<Option<Value>> + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub enum MockCall {
    Run(Vec<String>),
    Quit,
    PageScript(Option<String>),
    Global(GlobalCommand),
    Profile(EngineProfileId, ProfileCommand),
    Window(EngineWindowId, WindowCommand),
    Tab(EngineTabId, TabCommand),
    TabAction(EngineTabId, TabAction),
    Service {
        name: String,
        profile_dir: String,
        args: Value,
    },
    Evaluate(EngineTabId, String),
    DevTools(EngineTabId, String, Option<Value>),
    ScrollObserver(bool),
    ChooseFilesToOpen(Option<EngineWindowId>),
    ExtensionActionStates(EngineTabId),
}

enum LeaveAsker {
    Tab(Responder<bool>),
    Window(EngineWindowId),
}

#[derive(Clone, Debug)]
struct MockProfile {
    info: ProfileInfo,
    extensions: BTreeMap<String, String>,
    off_the_record: Option<EngineProfileId>,
    released: bool,
}

#[derive(Clone, Debug, Default)]
struct MockWindow {
    info: WindowInfo,
    tabs: Vec<EngineTabId>,
    pinned: BTreeSet<EngineTabId>,
    active: Option<EngineTabId>,
    closed: bool,
}

#[derive(Clone, Debug, Default)]
struct MockTab {
    info: TabInfo,
    window: Option<EngineWindowId>,
    history: Vec<NavigationEntry>,
    index: usize,
    shown: bool,
    pip: bool,
    capture: bool,
    page_calls: Vec<(String, String, String)>,
    password_prompt: Option<PasswordPrompt>,
    autofill_prompt: Option<AutofillPrompt>,
}

#[derive(Default)]
struct MockState {
    started: bool,
    quit: bool,
    next_id: u64,
    next_chrome_tab: i32,
    page_script: Option<String>,
    default_profile: Option<EngineProfileId>,
    profiles: BTreeMap<EngineProfileId, MockProfile>,
    windows: BTreeMap<EngineWindowId, MockWindow>,
    tabs: BTreeMap<EngineTabId, MockTab>,
    calls: Vec<MockCall>,
    scroll_observer: bool,
    auto_pip: bool,
    video_upscaling: bool,
    pages_pick_display_media: bool,
    tracing: bool,
    extension_popups: BTreeMap<String, String>,
    leave_prompts: BTreeMap<EngineTabId, LeaveAsker>,
    chosen_files: Vec<PathBuf>,
    icons: HashMap<String, Vec<u8>>,
    icon_fetches: Vec<(EngineProfileId, String)>,
}

impl MockState {
    fn mint(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn profile(&self, id: EngineProfileId) -> EngineResult<&MockProfile> {
        self.profiles
            .get(&id)
            .filter(|p| !p.info.destroyed && !p.released)
            .ok_or(EngineError::UnknownProfile(id))
    }

    fn window(&mut self, id: EngineWindowId) -> EngineResult<&mut MockWindow> {
        self.windows
            .get_mut(&id)
            .filter(|w| !w.closed)
            .ok_or(EngineError::UnknownWindow(id))
    }

    fn tab(&mut self, id: EngineTabId) -> EngineResult<&mut MockTab> {
        self.tabs
            .get_mut(&id)
            .filter(|t| !t.info.closed)
            .ok_or(EngineError::UnknownTab(id))
    }

    fn require_started(&self) -> EngineResult<()> {
        if self.started && !self.quit {
            Ok(())
        } else {
            Err(EngineError::NotStarted)
        }
    }

    fn add_profile(&mut self, name: &str, off_the_record: bool) -> EngineProfileId {
        let id = EngineProfileId::from_raw(self.mint()).expect("ids start at one");
        let path = if off_the_record {
            format!("/mock/{name}/OTR")
        } else {
            format!("/mock/{name}")
        };
        self.profiles.insert(
            id,
            MockProfile {
                info: ProfileInfo {
                    name: name.to_owned(),
                    path,
                    off_the_record,
                    ..ProfileInfo::default()
                },
                extensions: BTreeMap::new(),
                off_the_record: None,
                released: false,
            },
        );
        id
    }

    fn add_window(&mut self, frame: Rect) -> EngineWindowId {
        let id = EngineWindowId::from_raw(self.mint()).expect("ids start at one");
        let window_number = id.get() as i64;
        self.windows.insert(
            id,
            MockWindow {
                info: WindowInfo {
                    frame,
                    visible: true,
                    window_number,
                    ..WindowInfo::default()
                },
                ..MockWindow::default()
            },
        );
        id
    }

    fn add_tab(
        &mut self,
        window: EngineWindowId,
        url: &str,
        profile: EngineProfileId,
        foreground: bool,
        out: &mut Vec<EngineEvent>,
    ) -> EngineTabId {
        let id = EngineTabId::from_raw(self.mint()).expect("ids start at one");
        self.next_chrome_tab += 1;
        let mut tab = MockTab {
            info: TabInfo {
                tab_id: self.next_chrome_tab,
                browser_id: window.get() as i32,
                profile: Some(profile),
                zoom_factor: 1.0,
                pinch_scale: 1.0,
                ..TabInfo::default()
            },
            window: Some(window),
            ..MockTab::default()
        };
        if !url.is_empty() {
            tab.history.push(NavigationEntry {
                url: url.to_owned(),
                title: title_for(url),
                committed: true,
                current: true,
            });
        }
        self.tabs.insert(id, tab);
        if let Some(entry) = self.windows.get_mut(&window) {
            entry.tabs.push(id);
            if foreground || entry.active.is_none() {
                entry.active = Some(id);
            }
        }
        out.push(EngineEvent::TabInserted {
            window,
            tab: id,
            opener: None,
            disposition: if foreground {
                "foreground".into()
            } else {
                "background".into()
            },
        });
        if foreground {
            out.push(EngineEvent::TabActivated { window, tab: id });
        }
        if !url.is_empty() {
            self.finish_load(id, out);
        }
        id
    }

    fn finish_load(&mut self, id: EngineTabId, out: &mut Vec<EngineEvent>) {
        let Some(tab) = self.tabs.get_mut(&id) else {
            return;
        };
        let Some(entry) = tab.history.get(tab.index).cloned() else {
            return;
        };
        for (n, item) in tab.history.iter_mut().enumerate() {
            item.current = n == tab.index;
        }
        tab.info.loading = true;
        out.push(EngineEvent::LoadingChanged {
            tab: id,
            loading: true,
        });
        tab.info.url = entry.url.clone();
        tab.info.committed_origin = origin_of(&entry.url);
        tab.info.committed_document_count += 1;
        tab.info.committed_http_status = 200;
        out.push(EngineEvent::UrlChanged {
            tab: id,
            url: entry.url.clone(),
        });
        out.push(EngineEvent::DocumentCommitted { tab: id });
        tab.info.title = entry.title.clone();
        out.push(EngineEvent::TitleChanged {
            tab: id,
            title: entry.title,
        });
        tab.info.can_go_back = tab.index > 0;
        tab.info.can_go_forward = tab.index + 1 < tab.history.len();
        out.push(EngineEvent::NavigationStateChanged {
            tab: id,
            can_go_back: tab.info.can_go_back,
            can_go_forward: tab.info.can_go_forward,
        });
        tab.info.progress = 1.0;
        out.push(EngineEvent::ProgressChanged {
            tab: id,
            progress: 1.0,
        });
        tab.info.loading = false;
        out.push(EngineEvent::LoadingChanged {
            tab: id,
            loading: false,
        });
    }

    fn remove_tab(&mut self, id: EngineTabId, out: &mut Vec<EngineEvent>) {
        let Some(tab) = self.tabs.get_mut(&id) else {
            return;
        };
        if tab.info.closed {
            return;
        }
        out.push(EngineEvent::TabWillClose { tab: id });
        tab.info.closed = true;
        let window = tab.window.take();
        if let Some(window) = window
            && let Some(entry) = self.windows.get_mut(&window)
        {
            entry.tabs.retain(|t| *t != id);
            entry.pinned.remove(&id);
            if entry.active == Some(id) {
                entry.active = entry.tabs.last().copied();
            }
            out.push(EngineEvent::TabRemoved { window, tab: id });
            if let Some(next) = entry.active {
                out.push(EngineEvent::TabActivated { window, tab: next });
            }
        }
    }
}

fn title_for(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .filter(|host| !host.is_empty())
        .unwrap_or(url)
        .to_owned()
}

fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    (!host.is_empty()).then(|| format!("{scheme}://{host}"))
}

fn fake_view(tab: EngineTabId, devtools: bool) -> NativeViewHandle {
    NativeViewHandle(
        ((tab.get() << 4) | u64::from(devtools) << 3 | 0x1) as usize as *mut std::ffi::c_void,
    )
}

pub struct MockBrowserEngine {
    bus: EventBus,
    state: Mutex<MockState>,
    policy: RwLock<Arc<dyn HostPolicy>>,
    services: RwLock<HashMap<String, ServiceHandler>>,
    evaluator: RwLock<Option<Evaluator>>,
}

impl Default for MockBrowserEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for MockBrowserEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = self.state.lock();
        f.debug_struct("MockBrowserEngine")
            .field("started", &state.started)
            .field("windows", &state.windows.len())
            .field("tabs", &state.tabs.len())
            .finish()
    }
}

impl MockBrowserEngine {
    pub fn new() -> Self {
        Self::with_bus(EventBus::new())
    }

    pub fn with_bus(bus: EventBus) -> Self {
        let engine = Self {
            bus,
            state: Mutex::new(MockState::default()),
            policy: RwLock::new(Arc::new(DefaultPolicy::new())),
            services: RwLock::new(HashMap::new()),
            evaluator: RwLock::new(None),
        };
        engine.install_builtin_services();
        engine
    }

    pub fn started() -> Self {
        let engine = Self::new();
        engine.run_with_args(&[]).expect("the mock always starts");
        engine
    }

    fn install_builtin_services(&self) {
        let empty_folder = |title: &str| json!({ "id": title, "title": title, "children": [] });
        let tree = json!({ "bar": empty_folder("Bookmarks Bar"), "other": empty_folder("Other Bookmarks") });
        self.set_service_handler("ac_bookmarks_tree", move |_, _| Ok(tree.clone()));
        self.set_service_handler("ac_bookmarks_watch", |_, _| Ok(json!({ "ok": true })));
        self.set_service_handler("ac_history_query", |_, _| Ok(json!({ "entries": [] })));
        self.set_service_handler("ac_history_watch", |_, _| Ok(json!({ "ok": true })));
        self.set_service_handler("ac_downloads_list", |_, _| Ok(json!({ "downloads": [] })));
        self.set_service_handler("ac_extensions_list", |_, _| Ok(json!({ "extensions": [] })));
        self.set_service_handler("ac_search_engines_list", |_, _| {
            Ok(json!({ "list": { "engines": [] } }))
        });
    }

    pub fn set_service_handler(
        &self,
        name: &str,
        handler: impl Fn(&str, &Value) -> EngineResult<Value> + Send + Sync + 'static,
    ) {
        self.services
            .write()
            .insert(name.to_owned(), Arc::new(handler));
    }

    pub fn remove_service_handler(&self, name: &str) {
        self.services.write().remove(name);
    }

    pub fn set_evaluator(
        &self,
        evaluator: impl Fn(EngineTabId, &str) -> EngineResult<Option<Value>> + Send + Sync + 'static,
    ) {
        *self.evaluator.write() = Some(Arc::new(evaluator));
    }

    pub fn calls(&self) -> Vec<MockCall> {
        self.state.lock().calls.clone()
    }

    pub fn take_calls(&self) -> Vec<MockCall> {
        std::mem::take(&mut self.state.lock().calls)
    }

    pub fn page_script(&self) -> Option<String> {
        self.state.lock().page_script.clone()
    }

    pub fn page_calls(&self, tab: EngineTabId) -> Vec<(String, String, String)> {
        self.state
            .lock()
            .tabs
            .get(&tab)
            .map(|t| t.page_calls.clone())
            .unwrap_or_default()
    }

    pub fn window_tabs(&self, window: EngineWindowId) -> Vec<EngineTabId> {
        self.state
            .lock()
            .windows
            .get(&window)
            .map(|w| w.tabs.clone())
            .unwrap_or_default()
    }

    pub fn active_tab(&self, window: EngineWindowId) -> Option<EngineTabId> {
        self.state
            .lock()
            .windows
            .get(&window)
            .and_then(|w| w.active)
    }

    pub fn is_pinned(&self, window: EngineWindowId, tab: EngineTabId) -> bool {
        self.state
            .lock()
            .windows
            .get(&window)
            .is_some_and(|w| w.pinned.contains(&tab))
    }

    pub fn live_tabs(&self) -> Vec<EngineTabId> {
        self.state
            .lock()
            .tabs
            .iter()
            .filter(|(_, t)| !t.info.closed)
            .map(|(id, _)| *id)
            .collect()
    }

    pub fn set_extension_popup(&self, extension_id: &str, url: Option<&str>) {
        let mut state = self.state.lock();
        match url {
            Some(url) => state
                .extension_popups
                .insert(extension_id.to_owned(), url.to_owned()),
            None => state.extension_popups.remove(extension_id),
        };
    }

    pub fn set_asks_before_leaving(&self, tab: EngineTabId, asks: bool) -> EngineResult<()> {
        self.state.lock().tab(tab)?.info.asks_before_leaving = asks;
        Ok(())
    }

    pub fn leave_prompts(&self) -> Vec<EngineTabId> {
        self.state.lock().leave_prompts.keys().copied().collect()
    }

    pub fn answer_leave_prompt(&self, tab: EngineTabId, leave: bool) -> bool {
        let asker = self.state.lock().leave_prompts.remove(&tab);
        match asker {
            None => false,
            Some(LeaveAsker::Tab(responder)) => {
                responder.send(Ok(leave));
                true
            }
            Some(LeaveAsker::Window(window)) if leave => {
                if let Ok(entry) = self.state.lock().tab(tab) {
                    entry.info.asks_before_leaving = false;
                }
                let _ = self.window_command(window, WindowCommand::Close);
                true
            }
            Some(LeaveAsker::Window(window)) => {
                self.bus
                    .publish(EngineEvent::WindowCloseCancelled { window });
                true
            }
        }
    }

    pub fn set_icon(&self, url: &str, bytes: Vec<u8>) {
        self.state.lock().icons.insert(url.to_owned(), bytes);
    }

    pub fn icon_fetches(&self) -> Vec<(EngineProfileId, String)> {
        self.state.lock().icon_fetches.clone()
    }

    pub fn set_page(&self, tab: EngineTabId, url: &str, loading: bool) -> EngineResult<()> {
        let mut state = self.state.lock();
        let entry = state.tab(tab)?;
        entry.info.url = url.to_owned();
        entry.info.loading = loading;
        Ok(())
    }

    pub fn set_chosen_files(&self, paths: impl IntoIterator<Item = PathBuf>) {
        self.state.lock().chosen_files = paths.into_iter().collect();
    }

    pub fn emit(&self, event: EngineEvent) {
        self.bus.publish(event);
    }

    fn run_service(
        &self,
        name: &str,
        profile_dir: &str,
        args_json: &str,
        secret: bool,
    ) -> EngineResult<Value> {
        let name = ServiceName::new(name)?;
        if name.is_secret() && !secret {
            return Err(EngineError::bad_argument(format!(
                "{} carries secrets: use call_service_secret",
                name.as_str()
            )));
        }
        let args = ServiceArgs::json(args_json)?;
        let mut parsed: Value = serde_json::from_str(args.as_str())
            .map_err(|error| EngineError::bad_argument(error.to_string()))?;
        self.record(MockCall::Service {
            name: name.as_str().to_owned(),
            profile_dir: profile_dir.to_owned(),
            args: if secret {
                json!("<secret>")
            } else {
                parsed.clone()
            },
        });
        let handler = self.services.read().get(name.as_str()).cloned();
        let answer = match handler {
            Some(handler) => handler(profile_dir, &parsed)
                .and_then(|value| parse_service_reply(name.as_str(), Some(&value.to_string()))),
            None => Err(EngineError::MissingService(name.as_str().to_owned())),
        };
        if secret {
            wipe_value(&mut parsed);
        }
        answer
    }

    pub fn simulate_page_message(
        &self,
        tab: EngineTabId,
        kind: &str,
        json: &str,
        frame_id: &str,
        main_frame: bool,
    ) -> EngineResult<()> {
        let origin = {
            let mut state = self.state.lock();
            state.tab(tab)?.info.committed_origin.clone()
        };
        self.bus.publish(EngineEvent::PageMessage {
            tab,
            message: PageMessage {
                kind: kind.into(),
                json: json.into(),
                frame_id: frame_id.into(),
                main_frame,
                origin,
            },
        });
        Ok(())
    }

    pub fn simulate_password_prompt(
        &self,
        tab: EngineTabId,
        prompt: PasswordPrompt,
    ) -> EngineResult<()> {
        let window = {
            let mut state = self.state.lock();
            let entry = state.tab(tab)?;
            entry.password_prompt = Some(prompt.clone());
            entry.window.ok_or(EngineError::UnknownTab(tab))?
        };
        self.bus.publish(EngineEvent::PasswordPrompt {
            window,
            tab,
            prompt,
        });
        Ok(())
    }

    pub fn simulate_renderer_crash(&self, tab: EngineTabId) -> EngineResult<()> {
        self.state.lock().tab(tab)?.info.loading = false;
        self.bus.publish(EngineEvent::RendererGone {
            tab,
            status: "crashed".into(),
            code: 11,
        });
        Ok(())
    }

    pub fn simulate_audio(&self, tab: EngineTabId, audible: bool) -> EngineResult<()> {
        let muted = {
            let mut state = self.state.lock();
            let entry = state.tab(tab)?;
            entry.info.audible = audible;
            entry.info.muted
        };
        self.bus.publish(EngineEvent::AudioChanged {
            tab,
            audible,
            muted,
        });
        Ok(())
    }

    pub fn simulate_capture(&self, tab: EngineTabId, capturing: bool) -> EngineResult<()> {
        self.state.lock().tab(tab)?.capture = capturing;
        self.bus.publish(EngineEvent::MediaAccessChanged {
            tab,
            access: MediaAccess {
                screen: capturing,
                ..MediaAccess::default()
            },
        });
        Ok(())
    }

    pub fn simulate_new_browser(
        &self,
        profile: Option<EngineProfileId>,
        kind: NewBrowserKind,
    ) -> Option<EngineWindowId> {
        let policy = self.policy.read().clone();
        let decision = policy.new_browser_window(profile, kind);
        let window = match decision {
            NewBrowserWindow::Refuse => return None,
            NewBrowserWindow::Use(window) => {
                return self
                    .state
                    .lock()
                    .windows
                    .get(&window)
                    .filter(|w| !w.closed)
                    .map(|_| window);
            }
            NewBrowserWindow::Create => self
                .state
                .lock()
                .add_window(Rect::new(0.0, 0.0, 1360.0, 860.0)),
        };
        self.bus.publish(EngineEvent::WindowCreatedByEngine {
            window,
            profile,
            kind,
        });
        Some(window)
    }

    pub fn simulate_reserved_key(&self, chord: &KeyChord) -> bool {
        let policy = self.policy.read().clone();
        policy.is_reserved_key(chord)
    }

    pub fn simulate_window_close_request(&self, window: EngineWindowId) -> bool {
        let policy = self.policy.read().clone();
        let close = policy.window_should_close(window);
        if close {
            let _ = self.window_command(window, WindowCommand::Close);
        } else {
            self.bus
                .publish(EngineEvent::WindowCloseCancelled { window });
        }
        close
    }

    pub fn simulate_key(&self, window: EngineWindowId, event: &KeyEvent) -> (bool, bool) {
        let policy = self.policy.read().clone();
        let pre = policy.pre_handle_key(window, event);
        let handled = !pre && policy.handle_key(window, event);
        (pre, handled)
    }

    pub fn simulate_context_menu(
        &self,
        tab: EngineTabId,
        target: ContextMenuTarget,
    ) -> Vec<ContextMenuItem> {
        let policy = self.policy.read().clone();
        policy.context_menu_items(tab, &target)
    }

    fn record(&self, call: MockCall) {
        self.state.lock().calls.push(call);
    }

    fn publish_all(&self, events: Vec<EngineEvent>) {
        for event in events {
            self.bus.publish(event);
        }
    }

    fn page_owner(&self, view: NativeViewHandle) -> Option<(EngineTabId, bool)> {
        let state = self.state.lock();
        state
            .tabs
            .iter()
            .filter(|(_, t)| !t.info.closed)
            .find_map(|(id, t)| {
                if fake_view(*id, false) == view {
                    Some((*id, false))
                } else if t.info.has_dev_tools && fake_view(*id, true) == view {
                    Some((*id, true))
                } else {
                    None
                }
            })
    }
}

impl BrowserEngine for MockBrowserEngine {
    fn backend(&self) -> EngineBackend {
        EngineBackend::Mock
    }

    fn events(&self) -> &EventBus {
        &self.bus
    }

    fn set_policy(&self, policy: Arc<dyn HostPolicy>) {
        *self.policy.write() = policy;
    }

    fn run_with_args(&self, args: &[String]) -> EngineResult<i32> {
        {
            let mut state = self.state.lock();
            if state.started && !state.quit {
                return Err(EngineError::AlreadyRunning);
            }
            state.started = true;
            state.quit = false;
            state.calls.push(MockCall::Run(args.to_vec()));
            if state.default_profile.is_none() {
                let id = state.add_profile("Default", false);
                state.default_profile = Some(id);
            }
        }
        self.bus.publish(EngineEvent::Started);
        Ok(0)
    }

    fn is_started(&self) -> bool {
        let state = self.state.lock();
        state.started && !state.quit
    }

    fn quit(&self) -> EngineResult<()> {
        let mut events = Vec::new();
        {
            let mut state = self.state.lock();
            state.require_started()?;
            state.calls.push(MockCall::Quit);
            let open: Vec<EngineTabId> = state
                .tabs
                .iter()
                .filter(|(_, t)| !t.info.closed)
                .map(|(id, _)| *id)
                .collect();
            for tab in open {
                state.remove_tab(tab, &mut events);
            }
            for (id, window) in state.windows.iter_mut().filter(|(_, w)| !w.closed) {
                window.closed = true;
                events.push(EngineEvent::WindowClosed { window: *id });
            }
            state.quit = true;
        }
        events.push(EngineEvent::WillShutDown);
        self.publish_all(events);
        Ok(())
    }

    fn query(&self, query: EngineQuery) -> EngineResult<Value> {
        let state = self.state.lock();
        Ok(match query {
            EngineQuery::ChromiumVersion => json!("0.0.0.0-mock"),
            EngineQuery::KeepAliveState => json!(if state.started { "mock" } else { "" }),
            EngineQuery::PictureInPictureCloses => json!(""),
            EngineQuery::VideoUpscalingState => json!({ "enabled": state.video_upscaling }),
            EngineQuery::DesktopCaptureAudio => json!({ "system": false, "application": false }),
            EngineQuery::PagesPickDisplayMedia => json!(state.pages_pick_display_media),
            EngineQuery::IsTracing => json!(state.tracing),
            EngineQuery::TestExternalLaunches | EngineQuery::TestChooserEvents => json!([]),
        })
    }

    fn set_page_script(&self, script: Option<&str>) -> EngineResult<()> {
        let mut state = self.state.lock();
        state.page_script = script.map(str::to_owned);
        state
            .calls
            .push(MockCall::PageScript(script.map(str::to_owned)));
        Ok(())
    }

    fn global(&self, command: GlobalCommand) -> EngineResult<()> {
        command.validate()?;
        let mut state = self.state.lock();
        match &command {
            GlobalCommand::SetAutoPictureInPicture { enabled } => state.auto_pip = *enabled,
            GlobalCommand::SetVideoUpscaling { enabled } => state.video_upscaling = *enabled,
            GlobalCommand::SetPagesPickDisplayMedia { enabled } => {
                state.pages_pick_display_media = *enabled
            }
            GlobalCommand::AllowDesktopCapture { tab, .. } => {
                state.tab(*tab)?;
            }
            _ => {}
        }
        drop(state);
        if let Some(prompt) = command.settles() {
            self.bus.settle_prompt(&prompt);
        }
        self.state.lock().calls.push(MockCall::Global(command));
        Ok(())
    }

    fn begin_tracing(&self) -> Reply<bool> {
        let mut state = self.state.lock();
        let started = !state.tracing;
        state.tracing = true;
        Reply::ok(started)
    }

    fn end_tracing(&self, keep: bool) -> Reply<Option<String>> {
        let mut state = self.state.lock();
        let was = std::mem::replace(&mut state.tracing, false);
        Reply::ok((was && keep).then(|| "/mock/trace.json".to_owned()))
    }

    fn default_profile(&self) -> EngineResult<EngineProfileId> {
        let state = self.state.lock();
        state.require_started()?;
        state.default_profile.ok_or(EngineError::NotStarted)
    }

    fn load_profile(&self, directory_name: &str) -> Reply<EngineProfileId> {
        if directory_name.is_empty()
            || directory_name.contains(['/', '\\'])
            || directory_name.starts_with('.')
        {
            return Reply::err(EngineError::bad_argument(
                "a profile is a folder name inside the data folder",
            ));
        }
        let mut state = self.state.lock();
        if let Err(error) = state.require_started() {
            return Reply::err(error);
        }
        let existing = state
            .profiles
            .iter()
            .find(|(_, p)| {
                p.info.name == directory_name && !p.info.off_the_record && !p.info.destroyed
            })
            .map(|(id, _)| *id);
        let id = existing.unwrap_or_else(|| state.add_profile(directory_name, false));
        if let Some(profile) = state.profiles.get_mut(&id) {
            profile.released = false;
        }
        Reply::ok(id)
    }

    fn off_the_record_profile(&self, profile: EngineProfileId) -> Reply<EngineProfileId> {
        let mut state = self.state.lock();
        let (name, existing) = match state.profile(profile) {
            Ok(p) if p.info.off_the_record => {
                return Reply::err(EngineError::bad_argument("that profile is already private"));
            }
            Ok(p) => (p.info.name.clone(), p.off_the_record),
            Err(error) => return Reply::err(error),
        };
        if let Some(existing) = existing
            && state.profile(existing).is_ok()
        {
            return Reply::ok(existing);
        }
        let id = state.add_profile(&name, true);
        if let Some(original) = state.profiles.get_mut(&profile) {
            original.off_the_record = Some(id);
        }
        Reply::ok(id)
    }

    fn delete_profile(&self, profile: EngineProfileId) -> Reply<bool> {
        let mut events = Vec::new();
        let deleted = {
            let mut state = self.state.lock();
            if state.default_profile == Some(profile) {
                false
            } else if state.profile(profile).is_err() {
                return Reply::err(EngineError::UnknownProfile(profile));
            } else {
                let tabs: Vec<EngineTabId> = state
                    .tabs
                    .iter()
                    .filter(|(_, t)| !t.info.closed && t.info.profile == Some(profile))
                    .map(|(id, _)| *id)
                    .collect();
                for tab in tabs {
                    state.remove_tab(tab, &mut events);
                }
                if let Some(entry) = state.profiles.get_mut(&profile) {
                    entry.info.destroyed = true;
                }
                true
            }
        };
        self.publish_all(events);
        Reply::ok(deleted)
    }

    fn profile_info(&self, profile: EngineProfileId) -> EngineResult<ProfileInfo> {
        Ok(self.state.lock().profile(profile)?.info.clone())
    }

    fn profile_command(
        &self,
        profile: EngineProfileId,
        command: ProfileCommand,
    ) -> EngineResult<()> {
        let mut state = self.state.lock();
        state.profile(profile)?;
        let entry = state.profiles.get_mut(&profile).expect("checked above");
        match &command {
            ProfileCommand::Release => entry.released = true,
            ProfileCommand::SetFlag { flag, on } => match flag {
                ProfileFlag::PasswordsOffered => entry.info.passwords_offered = *on,
                ProfileFlag::AddressesAutofilled => entry.info.addresses_autofilled = *on,
                ProfileFlag::CardsAutofilled => entry.info.cards_autofilled = *on,
                ProfileFlag::PreloadPages => entry.info.preload_pages = *on,
            },
            ProfileCommand::UnloadComponentExtension { extension_id } => {
                entry.extensions.remove(extension_id);
            }
            _ => {}
        }
        state.calls.push(MockCall::Profile(profile, command));
        Ok(())
    }

    fn load_component_extension(
        &self,
        profile: EngineProfileId,
        path: &str,
    ) -> EngineResult<Option<String>> {
        let mut state = self.state.lock();
        state.profile(profile)?;
        if path.is_empty() {
            return Ok(None);
        }
        let id: String = path.bytes().fold(String::from("mock"), |mut id, b| {
            id.push(char::from(b'a' + b % 16));
            id
        });
        let id: String = id.chars().take(32).collect();
        state
            .profiles
            .get_mut(&profile)
            .expect("checked above")
            .extensions
            .insert(id.clone(), path.to_owned());
        Ok(Some(id))
    }

    fn sleep_idle_profile(
        &self,
        profile: EngineProfileId,
        hosted_tabs: &[EngineTabId],
    ) -> EngineResult<Option<String>> {
        let state = self.state.lock();
        state.profile(profile)?;
        let stray = state.tabs.iter().any(|(id, t)| {
            !t.info.closed && t.info.profile == Some(profile) && !hosted_tabs.contains(id)
        });
        Ok(stray.then(|| "tab".to_owned()))
    }

    fn unload_idle_profile(&self, profile: EngineProfileId) -> EngineResult<String> {
        let mut state = self.state.lock();
        state.profile(profile)?;
        let busy = state
            .tabs
            .values()
            .any(|t| !t.info.closed && t.info.profile == Some(profile));
        if busy {
            return Ok("busy".into());
        }
        state
            .profiles
            .get_mut(&profile)
            .expect("checked above")
            .released = true;
        Ok("released".into())
    }

    fn fetch_icon(
        &self,
        profile: EngineProfileId,
        url: &str,
        max_bytes: usize,
    ) -> Reply<Option<Vec<u8>>> {
        let mut state = self.state.lock();
        if let Err(error) = state.profile(profile) {
            return Reply::err(error);
        }
        state.icon_fetches.push((profile, url.to_owned()));
        if let Some(icon) = state.icons.get(url) {
            return Reply::ok((icon.len() <= max_bytes).then(|| icon.clone()));
        }
        let icon: Vec<u8> = b"\x89PNG\r\n\x1a\nmock"
            .iter()
            .copied()
            .chain(url.bytes())
            .collect();
        Reply::ok((icon.len() <= max_bytes).then_some(icon))
    }

    fn clear_browsing_data(
        &self,
        profile: EngineProfileId,
        kinds: &[BrowsingDataKind],
        since_ms: Option<f64>,
    ) -> Reply<()> {
        let mut state = self.state.lock();
        if let Err(error) = state.profile(profile) {
            return Reply::err(error);
        }
        if kinds.contains(&BrowsingDataKind::History) {
            let cutoff_all = since_ms.is_none();
            for tab in state
                .tabs
                .values_mut()
                .filter(|t| t.info.profile == Some(profile) && cutoff_all)
            {
                let keep = tab.history.get(tab.index).cloned();
                tab.history = keep.into_iter().collect();
                tab.index = 0;
                tab.info.can_go_back = false;
                tab.info.can_go_forward = false;
            }
        }
        Reply::ok(())
    }

    fn create_window(&self, frame: Rect) -> EngineResult<EngineWindowId> {
        if !frame.is_valid() {
            return Err(EngineError::bad_argument(
                "the window frame must be finite and not negative",
            ));
        }
        let mut state = self.state.lock();
        state.require_started()?;
        Ok(state.add_window(frame))
    }

    fn window_info(&self, window: EngineWindowId) -> EngineResult<WindowInfo> {
        Ok(self.state.lock().window(window)?.info.clone())
    }

    fn native_window_handle(&self, window: EngineWindowId) -> EngineResult<NativeWindow> {
        self.state.lock().window(window)?;
        Ok(NativeWindow::borrowed(NativeWindowHandle(
            ((window.get() << 4) | 0x2) as usize as *mut std::ffi::c_void,
        )))
    }

    fn window_host_view(&self, window: EngineWindowId) -> EngineResult<NativeView> {
        self.state.lock().window(window)?;
        Ok(NativeView::borrowed(NativeViewHandle(
            ((window.get() << 4) | 0x4) as usize as *mut std::ffi::c_void,
        )))
    }

    fn window_command(&self, window: EngineWindowId, command: WindowCommand) -> EngineResult<()> {
        let mut events = Vec::new();
        {
            let mut state = self.state.lock();
            state.window(window)?;
            match &command {
                WindowCommand::ActivateTab { tab } => {
                    let entry = state.window(window)?;
                    if !entry.tabs.contains(tab) {
                        return Err(EngineError::UnknownTab(*tab));
                    }
                    if entry.active != Some(*tab) {
                        entry.active = Some(*tab);
                        events.push(EngineEvent::TabActivated { window, tab: *tab });
                    }
                }
                WindowCommand::PlaceTab { tab, index, pinned } => {
                    let entry = state.window(window)?;
                    let Some(at) = entry.tabs.iter().position(|t| t == tab) else {
                        return Err(EngineError::UnknownTab(*tab));
                    };
                    entry.tabs.remove(at);
                    let index = (*index).clamp(0, entry.tabs.len() as i32) as usize;
                    entry.tabs.insert(index, *tab);
                    if *pinned {
                        entry.pinned.insert(*tab);
                    } else {
                        entry.pinned.remove(tab);
                    }
                }
                WindowCommand::SetActiveProfile { profile } => {
                    if let Some(profile) = profile {
                        state.profile(*profile)?;
                    }
                    state.window(window)?.info.active_profile = *profile;
                }
                WindowCommand::PrepareProfile { profile } => {
                    state.profile(*profile)?;
                }
                WindowCommand::ShowInactive => state.window(window)?.info.visible = true,
                WindowCommand::SetActedFullScreen { on } => {
                    state.window(window)?.info.acted_full_screen = *on
                }
                WindowCommand::SetInternal { on } => state.window(window)?.info.internal = *on,
                WindowCommand::SetAutomation { on } => state.window(window)?.info.automation = *on,
                WindowCommand::Close => {
                    let tabs = state.window(window)?.tabs.clone();
                    let asking = tabs.iter().copied().find(|tab| {
                        state
                            .tabs
                            .get(tab)
                            .is_some_and(|entry| entry.info.asks_before_leaving)
                    });
                    if let Some(tab) = asking {
                        state.leave_prompts.insert(tab, LeaveAsker::Window(window));
                        state.calls.push(MockCall::Window(window, command.clone()));
                        drop(state);
                        self.publish_all(events);
                        return Ok(());
                    }
                    for tab in tabs {
                        state.remove_tab(tab, &mut events);
                    }
                    let entry = state.window(window)?;
                    entry.closed = true;
                    entry.info.visible = false;
                    events.push(EngineEvent::WindowClosed { window });
                }
            }
            state.calls.push(MockCall::Window(window, command));
        }
        self.publish_all(events);
        Ok(())
    }

    fn open_tab(&self, window: EngineWindowId, request: OpenTab) -> EngineResult<EngineTabId> {
        let mut events = Vec::new();
        let tab = {
            let mut state = self.state.lock();
            state.require_started()?;
            state.window(window)?;
            state.profile(request.profile)?;
            state.add_tab(
                window,
                &request.url,
                request.profile,
                request.foreground,
                &mut events,
            )
        };
        self.publish_all(events);
        Ok(tab)
    }

    fn open_extension_view(
        &self,
        window: EngineWindowId,
        url: &str,
        profile: EngineProfileId,
        kind: ExtensionViewKind,
    ) -> EngineResult<Option<EngineTabId>> {
        if !url.starts_with("chrome-extension://") {
            return Ok(None);
        }
        let mut events = Vec::new();
        let tab = {
            let mut state = self.state.lock();
            state.window(window)?;
            state.profile(profile)?;
            let tab = state.add_tab(
                window,
                url,
                profile,
                kind == ExtensionViewKind::Popup,
                &mut events,
            );
            state.tab(tab)?.info.temporary = true;
            tab
        };
        self.publish_all(events);
        Ok(Some(tab))
    }

    fn restore_tab(
        &self,
        window: EngineWindowId,
        state_text: Option<&str>,
        profile: EngineProfileId,
        foreground: bool,
    ) -> EngineResult<Option<EngineTabId>> {
        let urls: Vec<String> = match state_text {
            Some(text) => match serde_json::from_str::<Value>(text) {
                Ok(Value::Array(items)) => items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect(),
                Ok(Value::String(url)) => vec![url],
                _ => return Ok(None),
            },
            None => vec![String::new()],
        };
        let Some(last) = urls.last().cloned() else {
            return Ok(None);
        };
        let mut events = Vec::new();
        let tab = {
            let mut state = self.state.lock();
            state.window(window)?;
            state.profile(profile)?;
            let tab = state.add_tab(window, "", profile, foreground, &mut events);
            let entry = state.tab(tab)?;
            entry.history = urls
                .iter()
                .filter(|url| !url.is_empty())
                .map(|url| NavigationEntry {
                    url: url.clone(),
                    title: title_for(url),
                    committed: true,
                    current: false,
                })
                .collect();
            entry.index = entry.history.len().saturating_sub(1);
            if !last.is_empty() {
                state.finish_load(tab, &mut events);
            }
            tab
        };
        self.publish_all(events);
        Ok(Some(tab))
    }

    fn duplicate_tab(
        &self,
        window: EngineWindowId,
        source: EngineTabId,
        profile: EngineProfileId,
        foreground: bool,
    ) -> EngineResult<Option<EngineTabId>> {
        let mut events = Vec::new();
        let tab = {
            let mut state = self.state.lock();
            let (history, index) = {
                let original = state.tab(source)?;
                (original.history.clone(), original.index)
            };
            state.window(window)?;
            state.profile(profile)?;
            let tab = state.add_tab(window, "", profile, foreground, &mut events);
            let entry = state.tab(tab)?;
            entry.history = history;
            entry.index = index;
            state.finish_load(tab, &mut events);
            tab
        };
        self.publish_all(events);
        Ok(Some(tab))
    }

    fn adopt_tab(&self, window: EngineWindowId, tab: EngineTabId) -> EngineResult<Adoption> {
        let mut events = Vec::new();
        let adoption = {
            let mut state = self.state.lock();
            state.window(window)?;
            let from = state.tab(tab)?.window;
            if from == Some(window) {
                Adoption::Adopted
            } else {
                if let Some(from) = from
                    && let Some(old) = state.windows.get_mut(&from)
                {
                    old.tabs.retain(|t| *t != tab);
                    old.pinned.remove(&tab);
                    if old.active == Some(tab) {
                        old.active = old.tabs.last().copied();
                    }
                    events.push(EngineEvent::TabRemoved { window: from, tab });
                }
                state.tab(tab)?.window = Some(window);
                state.tab(tab)?.info.browser_id = window.get() as i32;
                state.window(window)?.tabs.push(tab);
                events.push(EngineEvent::TabInserted {
                    window,
                    tab,
                    opener: None,
                    disposition: "adopted".into(),
                });
                Adoption::Adopted
            }
        };
        self.publish_all(events);
        Ok(adoption)
    }

    fn can_adopt_tab(&self, window: EngineWindowId, tab: EngineTabId) -> EngineResult<Adoption> {
        let mut state = self.state.lock();
        state.window(window)?;
        let entry = state.tab(tab)?;
        Ok(if entry.info.discarded || entry.pip {
            Adoption::Busy
        } else {
            Adoption::Adopted
        })
    }

    fn tabs_for_profile(
        &self,
        window: EngineWindowId,
        profile: EngineProfileId,
    ) -> EngineResult<Vec<EngineTabId>> {
        let mut state = self.state.lock();
        let tabs = state.window(window)?.tabs.clone();
        Ok(tabs
            .into_iter()
            .filter(|t| {
                state
                    .tabs
                    .get(t)
                    .is_some_and(|tab| tab.info.profile == Some(profile))
            })
            .collect())
    }

    fn chrome_window_id(
        &self,
        window: EngineWindowId,
        profile: EngineProfileId,
    ) -> EngineResult<i32> {
        let mut state = self.state.lock();
        state.window(window)?;
        state.profile(profile)?;
        Ok((window.get() * 1000 + profile.get()) as i32)
    }

    fn execute_chrome_command(
        &self,
        window: EngineWindowId,
        command: i32,
        profile: EngineProfileId,
    ) -> EngineResult<bool> {
        let mut state = self.state.lock();
        state.window(window)?;
        state.profile(profile)?;
        Ok(command > 0)
    }

    fn tab_info(&self, tab: EngineTabId) -> EngineResult<TabInfo> {
        Ok(self.state.lock().tab(tab)?.info.clone())
    }

    fn native_view_handle(&self, tab: EngineTabId) -> EngineResult<NativeView> {
        self.state.lock().tab(tab)?;
        Ok(NativeView::borrowed(fake_view(tab, false)))
    }

    fn devtools_view_handle(&self, tab: EngineTabId) -> EngineResult<Option<NativeView>> {
        let open = self.state.lock().tab(tab)?.info.has_dev_tools;
        Ok(open.then(|| NativeView::borrowed(fake_view(tab, true))))
    }

    fn navigation_entries(&self, tab: EngineTabId) -> EngineResult<Vec<NavigationEntry>> {
        Ok(self.state.lock().tab(tab)?.history.clone())
    }

    fn security_info(&self, tab: EngineTabId) -> EngineResult<SecurityInfo> {
        let mut state = self.state.lock();
        let url = state.tab(tab)?.info.url.clone();
        let level = if url.starts_with("https://") {
            SecurityLevel::Secure
        } else if url.starts_with("http://") {
            SecurityLevel::Insecure
        } else if url.is_empty() || url == "about:blank" {
            SecurityLevel::None
        } else {
            SecurityLevel::Local
        };
        Ok(SecurityInfo {
            level,
            origin: origin_of(&url),
            url,
            ..SecurityInfo::default()
        })
    }

    fn password_prompt(&self, tab: EngineTabId) -> EngineResult<Option<PasswordPrompt>> {
        Ok(self.state.lock().tab(tab)?.password_prompt.clone())
    }

    fn autofill_prompt(&self, tab: EngineTabId) -> EngineResult<Option<AutofillPrompt>> {
        Ok(self.state.lock().tab(tab)?.autofill_prompt.clone())
    }

    fn tab_command(&self, tab: EngineTabId, command: TabCommand) -> EngineResult<()> {
        command.validate()?;
        let mut events = Vec::new();
        {
            let mut state = self.state.lock();
            let window = state.tab(tab)?.window;
            match &command {
                TabCommand::LoadUrl { url, .. } => {
                    let entry = state.tab(tab)?;
                    let keep = if entry.history.is_empty() {
                        0
                    } else {
                        entry.index + 1
                    };
                    entry.history.truncate(keep);
                    entry.history.push(NavigationEntry {
                        url: url.clone(),
                        title: title_for(url),
                        committed: true,
                        current: true,
                    });
                    entry.index = entry.history.len() - 1;
                    entry.info.discarded = false;
                    state.finish_load(tab, &mut events);
                }
                TabCommand::GoBack | TabCommand::GoForward | TabCommand::GoToOffset { .. } => {
                    let offset = match command {
                        TabCommand::GoBack => -1,
                        TabCommand::GoForward => 1,
                        TabCommand::GoToOffset { offset } => offset,
                        _ => 0,
                    };
                    let entry = state.tab(tab)?;
                    let target = entry.index as i64 + i64::from(offset);
                    if target >= 0 && (target as usize) < entry.history.len() && offset != 0 {
                        entry.index = target as usize;
                        state.finish_load(tab, &mut events);
                    }
                }
                TabCommand::Reload | TabCommand::ReloadIgnoringCache | TabCommand::LoadIfNeeded => {
                    let entry = state.tab(tab)?;
                    let needed =
                        !matches!(command, TabCommand::LoadIfNeeded) || entry.info.discarded;
                    entry.info.discarded = false;
                    if needed {
                        state.finish_load(tab, &mut events);
                    }
                }
                TabCommand::Stop => {
                    let entry = state.tab(tab)?;
                    if entry.info.loading {
                        entry.info.loading = false;
                        events.push(EngineEvent::LoadingChanged {
                            tab,
                            loading: false,
                        });
                    }
                }
                TabCommand::Focus => events.push(EngineEvent::FocusGained { tab }),
                TabCommand::Close | TabCommand::CloseNow => state.remove_tab(tab, &mut events),
                TabCommand::Find { text, .. } => {
                    let entry = state.tab(tab)?;
                    let haystack =
                        format!("{} {}", entry.info.title, entry.info.url).to_lowercase();
                    let needle = text.to_lowercase();
                    let count = if needle.is_empty() {
                        0
                    } else {
                        haystack.matches(&needle).count() as i32
                    };
                    events.push(EngineEvent::FindMatches {
                        tab,
                        matches: FindMatches {
                            count,
                            active: i32::from(count > 0),
                            final_update: true,
                        },
                    });
                }
                TabCommand::StopFinding => {}
                TabCommand::SetMuted { muted } => {
                    let entry = state.tab(tab)?;
                    entry.info.muted = *muted;
                    events.push(EngineEvent::AudioChanged {
                        tab,
                        audible: entry.info.audible,
                        muted: *muted,
                    });
                }
                TabCommand::SetZoom { factor } => {
                    let entry = state.tab(tab)?;
                    entry.info.zoom_factor = *factor;
                    events.push(EngineEvent::ZoomChanged { tab, zoom: *factor });
                }
                TabCommand::ZoomStep { direction } => {
                    let entry = state.tab(tab)?;
                    let zoom = if *direction == 0 {
                        1.0
                    } else {
                        (entry.info.zoom_factor * 1.1f64.powi(*direction)).clamp(0.25, 5.0)
                    };
                    entry.info.zoom_factor = zoom;
                    events.push(EngineEvent::ZoomChanged { tab, zoom });
                }
                TabCommand::SetFrozen { frozen } => state.tab(tab)?.info.frozen = *frozen,
                TabCommand::ResolveUnresponsive { .. } => {
                    events.push(EngineEvent::Responsive { tab })
                }
                TabCommand::ShowDevTools
                | TabCommand::ShowDevToolsPanel { .. }
                | TabCommand::CloseDevTools => {
                    let open = !matches!(command, TabCommand::CloseDevTools);
                    let entry = state.tab(tab)?;
                    if entry.info.has_dev_tools != open {
                        entry.info.has_dev_tools = open;
                        if let Some(window) = window {
                            events.push(EngineEvent::DevToolsChanged { window, tab, open });
                        }
                    }
                }
                TabCommand::ExecuteJavaScript { code, frame } => state.tab(tab)?.page_calls.push((
                    "executeJavaScript".into(),
                    frame.clone().unwrap_or_default(),
                    code.clone(),
                )),
                TabCommand::CallPage { kind, json } => {
                    state
                        .tab(tab)?
                        .page_calls
                        .push((kind.clone(), String::new(), json.clone()))
                }
                TabCommand::CallFrame { frame, kind, json } => {
                    state
                        .tab(tab)?
                        .page_calls
                        .push((kind.clone(), frame.clone(), json.clone()))
                }
                TabCommand::ExitPictureInPicture => {
                    let entry = state.tab(tab)?;
                    if std::mem::replace(&mut entry.pip, false) {
                        events.push(EngineEvent::PipChanged {
                            tab,
                            state: PipState {
                                active: false,
                                closed_by: Some("host".into()),
                                ..PipState::default()
                            },
                        });
                    }
                }
                TabCommand::ResolvePasswordPrompt { .. } => state.tab(tab)?.password_prompt = None,
                TabCommand::ResolveAutofillPrompt { .. } => state.tab(tab)?.autofill_prompt = None,
                TabCommand::NoteShown { shown } => state.tab(tab)?.shown = *shown,
                TabCommand::SetTemporary { temporary } => {
                    state.tab(tab)?.info.temporary = *temporary
                }
                TabCommand::SetTemporarySource {
                    source: Some(source),
                } => {
                    state.tab(*source)?;
                }
                _ => {}
            }
            state.calls.push(MockCall::Tab(tab, command));
        }
        self.publish_all(events);
        Ok(())
    }

    fn resolve_password_prompt(
        &self,
        tab: EngineTabId,
        action: PasswordPromptAction,
        username: Option<&str>,
        password: Option<&str>,
    ) -> EngineResult<()> {
        if password.is_some_and(|password| password.contains('\0')) {
            return Err(EngineError::bad_argument("the password holds a NUL byte"));
        }
        self.tab_command(
            tab,
            TabCommand::ResolvePasswordPrompt {
                action,
                username: username.map(str::to_owned),
            },
        )
    }

    fn tab_action(&self, tab: EngineTabId, action: TabAction) -> EngineResult<bool> {
        let mut events = Vec::new();
        let answer = {
            let mut state = self.state.lock();
            state.tab(tab)?;
            let answer = match &action {
                TabAction::Discard => {
                    let entry = state.tab(tab)?;
                    if entry.info.discarded || entry.shown || entry.pip || entry.capture {
                        false
                    } else {
                        entry.info.discarded = true;
                        entry.info.discard_reason = Some("proactive".into());
                        events.push(EngineEvent::DiscardedChanged {
                            tab,
                            discarded: true,
                            reason: Some("proactive".into()),
                        });
                        true
                    }
                }
                TabAction::UnloadKeepingHistory => {
                    let entry = state.tab(tab)?;
                    let unloaded = !entry.shown;
                    if unloaded {
                        entry.info.discarded = true;
                    }
                    unloaded
                }
                TabAction::ShowCastDialog => true,
                TabAction::ShowAutofillSuggestions { .. } => false,
                TabAction::StopCapture => std::mem::replace(&mut state.tab(tab)?.capture, false),
                TabAction::HasLiveFrame { frame } => !frame.is_empty(),
                TabAction::ExecuteChromeCommand { command } => *command > 0,
                TabAction::ShareThisTabInsteadFor { capturer } => {
                    let capturing = state.tab(*capturer)?.capture;
                    capturing && *capturer != tab
                }
            };
            state.calls.push(MockCall::TabAction(tab, action));
            answer
        };
        self.publish_all(events);
        Ok(answer)
    }

    fn sleep_if_hidden(&self, tab: EngineTabId, seconds: f64) -> EngineResult<Vec<i32>> {
        let mut state = self.state.lock();
        let entry = state.tab(tab)?;
        if !seconds.is_finite() || seconds < 0.0 {
            return Err(EngineError::bad_argument(
                "sleep time must be a non-negative number",
            ));
        }
        Ok(if entry.info.discarded {
            Vec::new()
        } else if entry.shown {
            vec![1]
        } else if entry.capture {
            vec![2]
        } else {
            Vec::new()
        })
    }

    fn execute_extension_action(
        &self,
        tab: EngineTabId,
        extension_id: &str,
    ) -> EngineResult<String> {
        self.state.lock().tab(tab)?;
        Ok(if extension_id.is_empty() {
            "none".into()
        } else {
            "popup".into()
        })
    }

    fn extension_action_states(
        &self,
        tab: EngineTabId,
        extension_ids: &[String],
    ) -> EngineResult<ExtensionActionStates> {
        let mut state = self.state.lock();
        state.tab(tab)?;
        state.calls.push(MockCall::ExtensionActionStates(tab));
        Ok(extension_ids
            .iter()
            .map(|id| {
                (
                    id.clone(),
                    ExtensionActionState {
                        enabled: true,
                        title: id.clone(),
                        popup: state.extension_popups.get(id).cloned().map(Value::String),
                        ..ExtensionActionState::default()
                    },
                )
            })
            .collect())
    }

    fn side_panel_url(&self, tab: EngineTabId, extension_id: &str) -> EngineResult<Option<String>> {
        self.state.lock().tab(tab)?;
        Ok((!extension_id.is_empty())
            .then(|| format!("chrome-extension://{extension_id}/panel.html")))
    }

    fn evaluate_js(&self, tab: EngineTabId, code: &str) -> Reply<Option<Value>> {
        {
            let mut state = self.state.lock();
            if let Err(error) = state.tab(tab) {
                return Reply::err(error);
            }
            state.calls.push(MockCall::Evaluate(tab, code.to_owned()));
        }
        let evaluator = self.evaluator.read().clone();
        match evaluator {
            Some(evaluator) => Reply::ready(evaluator(tab, code)),
            None => Reply::ok(None),
        }
    }

    fn ask_before_leaving(&self, tab: EngineTabId) -> Reply<bool> {
        let mut state = self.state.lock();
        match state.tab(tab) {
            Ok(entry) if entry.info.asks_before_leaving => {
                let (responder, reply) = Reply::channel();
                state.leave_prompts.insert(tab, LeaveAsker::Tab(responder));
                reply
            }
            Ok(_) => Reply::ok(true),
            Err(error) => Reply::err(error),
        }
    }

    fn choose_files_to_open(&self, window: Option<EngineWindowId>) -> Reply<Vec<PathBuf>> {
        let mut state = self.state.lock();
        if let Some(window) = window
            && let Err(error) = state.window(window)
        {
            return Reply::err(error);
        }
        state.calls.push(MockCall::ChooseFilesToOpen(window));
        Reply::ok(std::mem::take(&mut state.chosen_files))
    }

    fn enter_pip(&self, tab: EngineTabId, click_time: f64) -> Reply<PipEntry> {
        let entered = {
            let mut state = self.state.lock();
            let entry = match state.tab(tab) {
                Ok(entry) => entry,
                Err(error) => return Reply::err(error),
            };
            if click_time <= 0.0 {
                false
            } else {
                !std::mem::replace(&mut entry.pip, true)
            }
        };
        if entered {
            self.bus.publish(EngineEvent::PipChanged {
                tab,
                state: PipState {
                    active: true,
                    ..PipState::default()
                },
            });
        }
        Reply::ok(PipEntry {
            route: if click_time > 0.0 {
                "video".into()
            } else {
                "refused".into()
            },
            opened: entered,
        })
    }

    fn devtools_call(
        &self,
        tab: EngineTabId,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Reply<Value> {
        let mut state = self.state.lock();
        if let Err(error) = state.tab(tab) {
            return Reply::err(error);
        }
        if timeout.is_zero() {
            return Reply::err(EngineError::failed("timed out"));
        }
        state
            .calls
            .push(MockCall::DevTools(tab, method.to_owned(), params.clone()));
        drop(state);
        let evaluator = self.evaluator.read().clone();
        let expression = params
            .as_ref()
            .and_then(|params| params.get("expression"))
            .and_then(Value::as_str);
        match (method, expression, evaluator) {
            ("Page.getFrameTree", _, _) => {
                Reply::ok(json!({ "frameTree": { "frame": { "id": format!("frame-{}", tab.get()) } } }))
            }
            ("Page.createIsolatedWorld", _, _) => {
                Reply::ok(json!({ "executionContextId": tab.get() + 1000 }))
            }
            ("Runtime.evaluate", Some(expression), Some(evaluator)) => {
                Reply::ready(evaluator(tab, expression).map(|value| {
                    json!({ "result": { "type": "object", "value": value.unwrap_or(Value::Null) } })
                }))
            }
            _ => Reply::ok(json!({ "method": method, "params": params.unwrap_or(Value::Null) })),
        }
    }

    fn devtools_layout(&self, tab: EngineTabId, size: Size) -> EngineResult<DevToolsLayout> {
        let open = self.state.lock().tab(tab)?.info.has_dev_tools;
        let full = Rect::new(0.0, 0.0, size.width.max(0.0), size.height.max(0.0));
        if !open {
            return Ok(DevToolsLayout {
                devtools: Rect::default(),
                page: full,
            });
        }
        let docked = (full.height / 3.0).round();
        Ok(DevToolsLayout {
            devtools: Rect::new(0.0, 0.0, full.width, docked),
            page: Rect::new(0.0, docked, full.width, full.height - docked),
        })
    }

    fn call_service(&self, name: &str, profile_dir: &str, args_json: &str) -> Reply<Value> {
        Reply::ready(self.run_service(name, profile_dir, args_json, false))
    }

    fn call_service_secret(
        &self,
        name: &str,
        profile_dir: &str,
        args_json: zeroize::Zeroizing<String>,
    ) -> Reply<SecretValue> {
        Reply::ready(
            self.run_service(name, profile_dir, &args_json, true)
                .map(SecretValue::new),
        )
    }

    fn page_view(&self, view: &NativeView, query: PageViewQuery) -> EngineResult<bool> {
        let owner = self.page_owner(view.handle());
        Ok(match query {
            PageViewQuery::IsPageView => owner.is_some_and(|(_, devtools)| !devtools),
            PageViewQuery::TakeSwipes | PageViewQuery::TakesSwipes => owner.is_some(),
            PageViewQuery::IsEditingText => false,
        })
    }

    fn set_scroll_observer(&self, enabled: bool) -> EngineResult<()> {
        let mut state = self.state.lock();
        state.scroll_observer = enabled;
        state.calls.push(MockCall::ScrollObserver(enabled));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;

    fn engine_with_window() -> (MockBrowserEngine, EngineWindowId, EngineProfileId) {
        let engine = MockBrowserEngine::started();
        let window = engine
            .create_window(Rect::new(0.0, 0.0, 1200.0, 800.0))
            .unwrap();
        let profile = engine.default_profile().unwrap();
        (engine, window, profile)
    }

    #[test]
    fn lifecycle_starts_once_and_quits_cleanly() {
        let engine = MockBrowserEngine::new();
        let events = engine.subscribe();
        assert_eq!(engine.default_profile(), Err(EngineError::NotStarted));
        assert_eq!(engine.run_with_args(&["--x".into()]), Ok(0));
        assert_eq!(engine.run_with_args(&[]), Err(EngineError::AlreadyRunning));
        assert!(engine.is_started());
        assert_eq!(engine.chromium_version().unwrap(), "0.0.0.0-mock");
        let window = engine
            .create_window(Rect::new(0.0, 0.0, 10.0, 10.0))
            .unwrap();
        let profile = engine.default_profile().unwrap();
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://a.test/".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        events.drain();
        engine.quit().unwrap();
        let drained = events.drain();
        assert_eq!(
            drained,
            vec![
                EngineEvent::TabWillClose { tab },
                EngineEvent::TabRemoved { window, tab },
                EngineEvent::WindowClosed { window },
                EngineEvent::WillShutDown,
            ]
        );
        assert!(!engine.is_started());
        assert_eq!(engine.tab_info(tab), Err(EngineError::UnknownTab(tab)));
        assert_eq!(engine.quit(), Err(EngineError::NotStarted));
    }

    #[test]
    fn opening_a_tab_reports_a_full_load() {
        let (engine, window, profile) = engine_with_window();
        let events = engine.subscribe();
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://ardia.dev/start".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        let drained = events.drain();
        assert_eq!(
            drained[0],
            EngineEvent::TabInserted {
                window,
                tab,
                opener: None,
                disposition: "foreground".into()
            }
        );
        assert_eq!(drained[1], EngineEvent::TabActivated { window, tab });
        assert!(drained.contains(&EngineEvent::UrlChanged {
            tab,
            url: "https://ardia.dev/start".into()
        }));
        assert!(drained.contains(&EngineEvent::TitleChanged {
            tab,
            title: "ardia.dev".into()
        }));
        assert_eq!(
            drained.last(),
            Some(&EngineEvent::LoadingChanged {
                tab,
                loading: false
            })
        );
        let info = engine.tab_info(tab).unwrap();
        assert_eq!(info.url, "https://ardia.dev/start");
        assert_eq!(info.committed_origin.as_deref(), Some("https://ardia.dev"));
        assert!(!info.loading);
        assert_eq!(
            engine.security_info(tab).unwrap().level,
            SecurityLevel::Secure
        );
    }

    #[test]
    fn history_moves_back_and_forward() {
        let (engine, window, profile) = engine_with_window();
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://one.test/".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        engine.load_url(tab, "https://two.test/", true).unwrap();
        engine.load_url(tab, "https://three.test/", true).unwrap();
        assert!(engine.tab_info(tab).unwrap().can_go_back);
        engine.go_back(tab).unwrap();
        engine.go_back(tab).unwrap();
        assert_eq!(engine.tab_info(tab).unwrap().url, "https://one.test/");
        engine.go_back(tab).unwrap();
        assert_eq!(engine.tab_info(tab).unwrap().url, "https://one.test/");
        engine.go_to_offset(tab, 2).unwrap();
        assert_eq!(engine.tab_info(tab).unwrap().url, "https://three.test/");
        engine.go_to_offset(tab, -1).unwrap();
        engine.load_url(tab, "https://four.test/", false).unwrap();
        let entries = engine.navigation_entries(tab).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.url.as_str()).collect::<Vec<_>>(),
            [
                "https://one.test/",
                "https://two.test/",
                "https://four.test/"
            ]
        );
        assert!(entries.last().unwrap().current);
        assert!(!engine.tab_info(tab).unwrap().can_go_forward);
    }

    #[test]
    fn closing_tabs_and_windows_invalidates_their_ids() {
        let (engine, window, profile) = engine_with_window();
        let first = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://a.test/".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        let second = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://b.test/".into(),
                    profile,
                    foreground: false,
                },
            )
            .unwrap();
        assert_eq!(engine.active_tab(window), Some(first));
        engine.close(first).unwrap();
        assert_eq!(engine.active_tab(window), Some(second));
        assert_eq!(engine.go_back(first), Err(EngineError::UnknownTab(first)));
        assert!(matches!(
            block_on(engine.evaluate_js(first, "1")),
            Err(EngineError::UnknownTab(_))
        ));
        engine.close_window(window).unwrap();
        assert_eq!(
            engine.tab_info(second),
            Err(EngineError::UnknownTab(second))
        );
        assert_eq!(
            engine.window_info(window),
            Err(EngineError::UnknownWindow(window))
        );
        assert_eq!(
            engine.open_tab(
                window,
                OpenTab {
                    url: String::new(),
                    profile,
                    foreground: true
                }
            ),
            Err(EngineError::UnknownWindow(window))
        );
        let fresh = engine.create_window(Rect::default()).unwrap();
        assert!(fresh.get() > second.get());
    }

    #[test]
    fn tabs_move_between_windows() {
        let (engine, window, profile) = engine_with_window();
        let other = engine.create_window(Rect::default()).unwrap();
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://a.test/".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        let events = engine.subscribe();
        assert_eq!(engine.can_adopt_tab(other, tab), Ok(Adoption::Adopted));
        assert_eq!(engine.adopt_tab(other, tab), Ok(Adoption::Adopted));
        assert_eq!(
            events.drain(),
            vec![
                EngineEvent::TabRemoved { window, tab },
                EngineEvent::TabInserted {
                    window: other,
                    tab,
                    opener: None,
                    disposition: "adopted".into()
                },
            ]
        );
        assert_eq!(engine.tabs_for_profile(other, profile), Ok(vec![tab]));
        assert!(engine.tabs_for_profile(window, profile).unwrap().is_empty());
        let second = engine
            .open_tab(
                other,
                OpenTab {
                    url: "https://b.test/".into(),
                    profile,
                    foreground: false,
                },
            )
            .unwrap();
        engine.place_tab(other, second, 0, true).unwrap();
        assert_eq!(engine.window_tabs(other), vec![second, tab]);
        assert!(engine.is_pinned(other, second));
    }

    #[test]
    fn profiles_load_go_private_and_delete() {
        let (engine, window, _) = engine_with_window();
        let work = block_on(engine.load_profile("Profile 1")).unwrap();
        assert_eq!(block_on(engine.load_profile("Profile 1")).unwrap(), work);
        assert!(block_on(engine.load_profile("../escape")).is_err());
        let private = block_on(engine.off_the_record_profile(work)).unwrap();
        assert_eq!(
            block_on(engine.off_the_record_profile(work)).unwrap(),
            private
        );
        assert!(engine.profile_info(private).unwrap().off_the_record);
        assert!(block_on(engine.off_the_record_profile(private)).is_err());
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://w.test/".into(),
                    profile: work,
                    foreground: true,
                },
            )
            .unwrap();
        engine
            .set_profile_flag(work, ProfileFlag::PreloadPages, true)
            .unwrap();
        assert!(engine.profile_info(work).unwrap().preload_pages);
        assert_eq!(engine.sleep_idle_profile(work, &[]), Ok(Some("tab".into())));
        assert_eq!(engine.sleep_idle_profile(work, &[tab]), Ok(None));
        assert_eq!(engine.unload_idle_profile(work), Ok("busy".into()));
        assert_eq!(block_on(engine.delete_profile(work)), Ok(true));
        assert_eq!(engine.tab_info(tab), Err(EngineError::UnknownTab(tab)));
        assert_eq!(
            engine.profile_info(work),
            Err(EngineError::UnknownProfile(work))
        );
        let default = engine.default_profile().unwrap();
        assert_eq!(block_on(engine.delete_profile(default)), Ok(false));
    }

    #[test]
    fn services_route_through_handlers_and_validate_names() {
        let engine = MockBrowserEngine::started();
        let tree = block_on(engine.services("/mock/Default").bookmarks().tree()).unwrap();
        assert!(tree["bar"]["children"].as_array().unwrap().is_empty());
        engine.set_service_handler("ac_history_delete_urls", |_, args| {
            Ok(json!({ "deleted": args["urls"].as_array().unwrap().len() }))
        });
        let deleted = block_on(
            engine
                .services("/mock/Default")
                .history()
                .delete_urls(&["https://a".into(), "https://b".into()]),
        );
        assert_eq!(deleted, Ok(json!({ "deleted": 2 })));
        engine.set_service_handler("ac_passwords_reveal", |_, _| {
            Ok(json!({ "error": "locked" }))
        });
        assert_eq!(
            block_on(
                engine
                    .services("/mock/Default")
                    .passwords()
                    .reveal("https://a", "me")
            ),
            Err(EngineError::Service {
                service: "ac_passwords_reveal".into(),
                message: "locked".into()
            })
        );
        assert!(engine.calls().iter().any(
            |call| matches!(call, MockCall::Service { args, .. } if args == &json!("<secret>"))
        ));
        assert_eq!(
            block_on(engine.call_service("ac_nope", "", "{}")),
            Err(EngineError::MissingService("ac_nope".into()))
        );
        assert!(matches!(
            block_on(engine.call_service("system", "", "{}")),
            Err(EngineError::BadArgument(_))
        ));
        assert!(matches!(
            block_on(engine.call_service("ac_tasks_list", "", "[]")),
            Err(EngineError::BadArgument(_))
        ));
        assert!(matches!(
            block_on(engine.call_service("ac_passwords_reveal", "", "{}")),
            Err(EngineError::BadArgument(_))
        ));
    }

    #[test]
    fn devtools_pip_and_discard_follow_tab_state() {
        let (engine, window, profile) = engine_with_window();
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://v.test/".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        let events = engine.subscribe();
        assert!(engine.devtools_view_handle(tab).unwrap().is_none());
        engine.show_devtools(tab).unwrap();
        let devtools = engine.devtools_view_handle(tab).unwrap().unwrap();
        let layout = engine
            .devtools_layout(
                tab,
                Size {
                    width: 900.0,
                    height: 600.0,
                },
            )
            .unwrap();
        assert_eq!(layout.devtools, Rect::new(0.0, 0.0, 900.0, 200.0));
        assert_eq!(layout.page, Rect::new(0.0, 200.0, 900.0, 400.0));
        assert!(!devtools.handle().is_null());
        assert_eq!(
            engine.page_view(&devtools, PageViewQuery::IsPageView),
            Ok(false)
        );
        let page = engine.native_view_handle(tab).unwrap();
        assert_eq!(engine.page_view(&page, PageViewQuery::IsPageView), Ok(true));
        assert_eq!(
            engine.page_view(
                &NativeView::borrowed(NativeViewHandle::NULL),
                PageViewQuery::IsPageView
            ),
            Ok(false)
        );
        let entry = block_on(engine.enter_pip(tab, 12.5)).unwrap();
        assert!(entry.opened);
        assert_eq!(engine.can_adopt_tab(window, tab), Ok(Adoption::Busy));
        assert_eq!(engine.discard(tab), Ok(false));
        engine.exit_pip(tab).unwrap();
        assert_eq!(engine.discard(tab), Ok(true));
        assert_eq!(engine.discard(tab), Ok(false));
        let drained = events.drain();
        assert!(drained.contains(&EngineEvent::DevToolsChanged {
            window,
            tab,
            open: true
        }));
        assert!(
            drained
                .iter()
                .any(|e| matches!(e, EngineEvent::PipChanged { state, .. } if state.active))
        );
        assert!(drained.contains(&EngineEvent::DiscardedChanged {
            tab,
            discarded: true,
            reason: Some("proactive".into())
        }));
    }

    #[test]
    fn host_policy_answers_engine_questions() {
        struct Strict;
        impl HostPolicy for Strict {
            fn new_browser_window(
                &self,
                _: Option<EngineProfileId>,
                _: NewBrowserKind,
            ) -> NewBrowserWindow {
                NewBrowserWindow::Refuse
            }
            fn window_should_close(&self, _: EngineWindowId) -> bool {
                false
            }
            fn pre_handle_key(&self, _: EngineWindowId, event: &KeyEvent) -> bool {
                event.chord() == KeyChord::new("t", Modifiers::COMMAND)
            }
            fn context_menu_items(
                &self,
                _: EngineTabId,
                target: &ContextMenuTarget,
            ) -> Vec<ContextMenuItem> {
                match target {
                    ContextMenuTarget::Selection(text) => vec![ContextMenuItem {
                        id: "ask".into(),
                        title: format!("Ask about “{text}”"),
                    }],
                    ContextMenuTarget::Page(_) => Vec::new(),
                }
            }
        }
        let (engine, window, profile) = engine_with_window();
        assert!(
            engine
                .simulate_new_browser(Some(profile), NewBrowserKind::Normal)
                .is_some()
        );
        engine.set_policy(Arc::new(Strict));
        assert_eq!(
            engine.simulate_new_browser(Some(profile), NewBrowserKind::Normal),
            None
        );
        let events = engine.subscribe();
        assert!(!engine.simulate_window_close_request(window));
        assert_eq!(
            events.drain(),
            vec![EngineEvent::WindowCloseCancelled { window }]
        );
        let key = KeyEvent {
            characters_ignoring_modifiers: "t".into(),
            modifiers: Modifiers::COMMAND,
            ..KeyEvent::default()
        };
        assert_eq!(engine.simulate_key(window, &key), (true, false));
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://a.test/".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        let items = engine.simulate_context_menu(tab, ContextMenuTarget::Selection("rust".into()));
        assert_eq!(items[0].id, "ask");
    }

    #[test]
    fn page_channel_records_calls_and_delivers_messages() {
        let (engine, window, profile) = engine_with_window();
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://p.test/".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        engine
            .call_page(tab, "config", "{\"peek\":\"shift\"}")
            .unwrap();
        engine
            .call_frame(tab, "frame-1", "peekConfig", "{}")
            .unwrap();
        assert!(engine.call_frame(tab, "", "peekConfig", "{}").is_err());
        assert_eq!(
            engine.page_calls(tab),
            vec![
                (
                    "config".into(),
                    String::new(),
                    "{\"peek\":\"shift\"}".into()
                ),
                ("peekConfig".into(), "frame-1".into(), "{}".into()),
            ]
        );
        let events = engine.subscribe();
        engine
            .simulate_page_message(
                tab,
                "hello",
                "{\"url\":\"https://p.test/\"}",
                "frame-0",
                true,
            )
            .unwrap();
        match events.try_next() {
            Some(EngineEvent::PageMessage { message, .. }) => {
                assert_eq!(message.kind, "hello");
                assert_eq!(message.origin.as_deref(), Some("https://p.test"));
                assert_eq!(message.data().unwrap()["url"], json!("https://p.test/"));
            }
            other => panic!("unexpected {other:?}"),
        }
        engine.set_evaluator(|_, code| Ok(Some(json!(code.len()))));
        assert_eq!(block_on(engine.evaluate_js(tab, "1+1")), Ok(Some(json!(3))));
    }

    #[test]
    fn global_resolutions_are_validated_and_recorded() {
        let (engine, window, profile) = engine_with_window();
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://c.test/".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        engine
            .resolve_permission("req-1", PermissionResult::Accept, true)
            .unwrap();
        assert!(
            engine
                .resolve_permission("", PermissionResult::Deny, false)
                .is_err()
        );
        engine
            .allow_desktop_capture(
                "screen:1:0",
                tab,
                None,
                Some("https://c.test"),
                Some("system"),
            )
            .unwrap();
        engine.close(tab).unwrap();
        assert_eq!(
            engine.allow_desktop_capture("screen:1:0", tab, None, None, None),
            Err(EngineError::UnknownTab(tab))
        );
        engine.set_auto_pip(true).unwrap();
        engine.set_video_upscaling(true).unwrap();
        assert_eq!(
            engine.query(EngineQuery::VideoUpscalingState).unwrap()["enabled"],
            json!(true)
        );
        let globals = engine
            .calls()
            .into_iter()
            .filter(|c| matches!(c, MockCall::Global(_)))
            .count();
        assert_eq!(globals, 4);
    }

    #[test]
    fn password_secrets_never_land_in_the_call_log() {
        let (engine, window, profile) = engine_with_window();
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://login.test/".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        engine
            .simulate_password_prompt(
                tab,
                PasswordPrompt {
                    state: "pending".into(),
                    origin: "https://login.test".into(),
                    ..PasswordPrompt::default()
                },
            )
            .unwrap();
        assert!(engine.password_prompt(tab).unwrap().is_some());
        engine
            .resolve_password_prompt(tab, PasswordPromptAction::Save, Some("me"), Some("hunter2"))
            .unwrap();
        assert!(engine.password_prompt(tab).unwrap().is_none());
        assert!(!format!("{:?}", engine.calls()).contains("hunter2"));
    }

    fn open_page(engine: &MockBrowserEngine, window: EngineWindowId, url: &str) -> EngineTabId {
        let profile = engine.default_profile().unwrap();
        engine
            .open_tab(
                window,
                OpenTab {
                    url: url.into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap()
    }

    #[test]
    fn pages_that_ask_before_leaving_wait_for_an_answer() {
        let (engine, window, _) = engine_with_window();
        let tab = open_page(&engine, window, "https://form.example/");
        let mut quiet = engine.ask_before_leaving(tab);
        assert_eq!(quiet.try_take(), Some(Ok(true)));
        engine.set_asks_before_leaving(tab, true).unwrap();
        assert!(engine.tab_info(tab).unwrap().asks_before_leaving);
        let mut stay = engine.ask_before_leaving(tab);
        assert_eq!(stay.try_take(), None);
        assert_eq!(engine.leave_prompts(), vec![tab]);
        assert!(engine.answer_leave_prompt(tab, false));
        assert_eq!(stay.try_take(), Some(Ok(false)));
        let mut leave = engine.ask_before_leaving(tab);
        assert!(engine.answer_leave_prompt(tab, true));
        assert_eq!(leave.try_take(), Some(Ok(true)));
        assert!(!engine.answer_leave_prompt(tab, true));
        assert!(
            engine
                .set_asks_before_leaving(EngineTabId::from_raw(999).unwrap(), true)
                .is_err()
        );
    }

    #[test]
    fn closing_a_window_asks_each_page_that_wants_to() {
        let (engine, window, _) = engine_with_window();
        let calm = open_page(&engine, window, "https://calm.example/");
        let first = open_page(&engine, window, "https://draft.example/");
        let second = open_page(&engine, window, "https://upload.example/");
        engine.set_asks_before_leaving(first, true).unwrap();
        engine.set_asks_before_leaving(second, true).unwrap();
        let events = engine.subscribe();
        engine.close_window(window).unwrap();
        assert_eq!(engine.leave_prompts(), vec![first]);
        assert!(engine.answer_leave_prompt(first, false));
        assert_eq!(
            events.drain(),
            vec![EngineEvent::WindowCloseCancelled { window }]
        );
        assert!(engine.live_tabs().contains(&calm));
        engine.close_window(window).unwrap();
        assert!(engine.answer_leave_prompt(first, true));
        assert_eq!(engine.leave_prompts(), vec![second]);
        assert!(engine.answer_leave_prompt(second, true));
        assert!(engine.live_tabs().is_empty());
        assert!(
            events
                .drain()
                .contains(&EngineEvent::WindowClosed { window })
        );
    }

    #[test]
    fn the_open_panel_hands_back_the_chosen_files_once() {
        let (engine, window, _) = engine_with_window();
        engine.set_chosen_files([PathBuf::from("/tmp/a.html")]);
        let mut chosen = engine.choose_files_to_open(Some(window));
        assert_eq!(
            chosen.try_take(),
            Some(Ok(vec![PathBuf::from("/tmp/a.html")]))
        );
        let mut cancelled = engine.choose_files_to_open(None);
        assert_eq!(cancelled.try_take(), Some(Ok(Vec::new())));
        let mut gone = engine.choose_files_to_open(Some(EngineWindowId::from_raw(999).unwrap()));
        assert!(matches!(gone.try_take(), Some(Err(_))));
        assert!(
            engine
                .calls()
                .contains(&MockCall::ChooseFilesToOpen(Some(window)))
        );
    }

    #[test]
    fn icons_can_be_scripted_and_fetches_are_logged() {
        let (engine, _, profile) = engine_with_window();
        engine.set_icon("https://i.example/a.png", vec![1, 2, 3]);
        let mut scripted = engine.fetch_icon(profile, "https://i.example/a.png", 10);
        assert_eq!(scripted.try_take(), Some(Ok(Some(vec![1, 2, 3]))));
        let mut capped = engine.fetch_icon(profile, "https://i.example/a.png", 2);
        assert_eq!(capped.try_take(), Some(Ok(None)));
        assert_eq!(engine.icon_fetches().len(), 2);
    }
}
