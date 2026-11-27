use std::collections::{BTreeMap, HashMap};
use std::ffi::{c_char, c_void};
use std::marker::PhantomData;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, MutexGuard, Weak};
use std::thread::ThreadId;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};

use crate::BrowserEngine;
use crate::abi::{
    self, AcEngineDispatch, AcEngineReply, AcEngineSetEventSink, ServiceRoute, c_string, text_of,
};
use crate::commands::*;
use crate::error::{EngineError, EngineResult};
use crate::events::{EngineEvent, EventBus, PromptKey};
use crate::loader::EngineLibrary;
use crate::policy::{DefaultPolicy, HostPolicy};
use crate::reply::{Finally, Reply};
use crate::services::{SecretValue, ServiceArgs, ServiceName};
use crate::types::*;

pub const ARDIA_ENGINE_API_VERSION: u32 = 1;
pub const API_ENTRY_SYMBOL: &str = "ardia_engine_api";

pub type HostCallFn = unsafe extern "C" fn(
    verb: *const c_char,
    args_json: *const c_char,
    window: u64,
    reply: AcEngineReply,
    context: *mut c_void,
);
pub type SetSinkFn = AcEngineSetEventSink;
pub type TestGateFn = unsafe extern "C" fn() -> *const c_char;
pub type ApiEntry = unsafe extern "C" fn() -> *const ArdiaEngineApi;

#[repr(C)]
pub struct ArdiaEngineApi {
    pub version: u32,
    pub size: u32,
    pub set_event_sink: Option<SetSinkFn>,
    pub host_call: Option<HostCallFn>,
    pub engine_call: Option<AcEngineDispatch>,
    pub test_gate_refusal: Option<TestGateFn>,
}

pub type Done = Box<dyn FnOnce(EngineResult<Value>) + Send>;

pub fn standalone_api_entry(library: &EngineLibrary) -> EngineResult<ApiEntry> {
    library.api_entry().ok_or_else(|| {
        EngineError::NotLoaded(format!(
            "{} has no {API_ENTRY_SYMBOL}; its service-only calls need Chromium's own UI thread, so a standalone app can't drive it",
            library.path().display()
        ))
    })
}
pub type Sink = Arc<dyn Fn(&str, &str) + Send + Sync>;

pub trait DesktopTransport: Send + Sync + 'static {
    fn backend(&self) -> EngineBackend;
    fn has_host_calls(&self) -> bool;
    fn host_call(&self, verb: &str, args: &Value, window: u64, done: Done);
    fn engine_call(&self, name: &ServiceName, profile: &str, args: ServiceArgs) -> Reply<Value>;
    fn engine_call_secret(
        &self,
        name: &ServiceName,
        profile: &str,
        args: ServiceArgs,
    ) -> Reply<SecretValue>;
    fn install_sink(&self, sink: Sink) -> EngineResult<()>;
    fn remove_sink(&self) {}
    fn abandon_host_calls(&self);
}

static ATTACHMENT: Mutex<Option<(u64, Sink)>> = Mutex::new(None);
static NEXT_ATTACHMENT: AtomicU64 = AtomicU64::new(1);
static NEXT_TAB_KEY: AtomicU64 = AtomicU64::new(1);
static NEXT_TRANSPORT: AtomicU64 = AtomicU64::new(1);

fn fresh_tab_key() -> String {
    format!("t{}", NEXT_TAB_KEY.fetch_add(1, Ordering::Relaxed))
}

unsafe extern "C" fn desktop_event(
    context: *mut c_void,
    topic: *const c_char,
    json: *const c_char,
) {
    if topic.is_null() {
        return;
    }
    let attachment = context as usize as u64;
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let sink = ATTACHMENT
            .lock()
            .as_ref()
            .filter(|(current, _)| *current == attachment)
            .map(|(_, sink)| sink.clone());
        if let (Some(sink), Some(topic)) = (sink, text_of(topic)) {
            sink(&topic, &text_of(json).unwrap_or_else(|| "{}".into()));
        }
    }));
}

struct NativeLink {
    owner: ThreadId,
    set_sink: SetSinkFn,
    attachment: AtomicU64,
}

impl NativeLink {
    fn here(set_sink: SetSinkFn) -> Self {
        Self {
            owner: std::thread::current().id(),
            set_sink,
            attachment: AtomicU64::new(0),
        }
    }

    fn check(&self) -> EngineResult<()> {
        if std::thread::current().id() == self.owner {
            Ok(())
        } else {
            Err(EngineError::WrongThread)
        }
    }

    fn attach(&self, sink: Sink) -> EngineResult<()> {
        self.check()?;
        let id = {
            let mut slot = ATTACHMENT.lock();
            if slot.is_some() {
                return Err(EngineError::AlreadyRunning);
            }
            let id = NEXT_ATTACHMENT.fetch_add(1, Ordering::Relaxed);
            *slot = Some((id, sink));
            id
        };
        self.attachment.store(id, Ordering::Release);
        unsafe { (self.set_sink)(Some(desktop_event), id as usize as *mut c_void) };
        Ok(())
    }

    fn detach(&self) {
        let id = self.attachment.swap(0, Ordering::AcqRel);
        if id == 0 {
            return;
        }
        if self.check().is_ok() {
            unsafe { (self.set_sink)(None, std::ptr::null_mut()) };
        }
        let mut slot = ATTACHMENT.lock();
        if slot.as_ref().is_some_and(|(current, _)| *current == id) {
            *slot = None;
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ApiPrefix {
    version: u32,
    size: u32,
}

pub struct ApiTransport {
    api: &'static ArdiaEngineApi,
    backend: EngineBackend,
    link: NativeLink,
    instance: u64,
}

fn close_late_open(host_call: HostCallFn, owner: ThreadId, args: &Value, window: u64) -> Done {
    let key = args.get("key").and_then(Value::as_str).map(str::to_owned);
    let adopt = args.get("adopt").and_then(Value::as_str).map(str::to_owned);
    Box::new(move |answer| {
        if matches!(answer, Err(EngineError::Cancelled)) {
            return;
        }
        if std::thread::current().id() != owner {
            log::warn!("a tab opened after teardown answered off the main thread and stays open");
            return;
        }
        let mut calls = Vec::new();
        if let Some(key) = key {
            calls.push(("tab.close", json!({ "key": key }), window));
        }
        if answer.is_err()
            && let Some(adopt) = adopt
        {
            calls.push(("tab.discard", json!({ "adopt": adopt }), 0));
        }
        for (verb, args, window) in calls {
            let (Ok(verb), Ok(args)) = (
                c_string(verb, "the host verb"),
                c_string(&args.to_string(), "the host arguments"),
            ) else {
                continue;
            };
            unsafe {
                host_call(
                    verb.as_ptr(),
                    args.as_ptr(),
                    window,
                    abi::ignore_reply,
                    std::ptr::null_mut(),
                )
            };
        }
    })
}

impl ApiTransport {
    #[allow(clippy::missing_safety_doc)]
    pub unsafe fn new(api: *const ArdiaEngineApi, backend: EngineBackend) -> EngineResult<Self> {
        if api.is_null() || !api.is_aligned() {
            return Err(EngineError::NotLoaded(
                "the engine gave no API table".into(),
            ));
        }
        let prefix = unsafe { api.cast::<ApiPrefix>().read() };
        if prefix.version != ARDIA_ENGINE_API_VERSION {
            return Err(EngineError::NotLoaded(format!(
                "the engine speaks API version {}, this app speaks {ARDIA_ENGINE_API_VERSION}",
                prefix.version
            )));
        }
        if (prefix.size as usize) < std::mem::size_of::<ArdiaEngineApi>() {
            return Err(EngineError::NotLoaded(format!(
                "the engine API table is {} bytes, too small",
                prefix.size
            )));
        }
        let api: &'static ArdiaEngineApi = unsafe { &*api };
        let (Some(set_sink), Some(_), Some(_)) =
            (api.set_event_sink, api.host_call, api.engine_call)
        else {
            return Err(EngineError::NotLoaded(
                "the engine API table is missing calls".into(),
            ));
        };
        Ok(Self {
            api,
            backend,
            link: NativeLink::here(set_sink),
            instance: NEXT_TRANSPORT.fetch_add(1, Ordering::Relaxed),
        })
    }

    pub fn test_gate_refusal(&self) -> Option<String> {
        self.link.check().ok()?;
        let gate = self.api.test_gate_refusal?;
        text_of(unsafe { gate() }).filter(|text| !text.is_empty())
    }
}

impl Drop for ApiTransport {
    fn drop(&mut self) {
        self.link.detach();
        abi::abandon_host_calls(self.instance);
    }
}

impl DesktopTransport for ApiTransport {
    fn backend(&self) -> EngineBackend {
        self.backend
    }

    fn has_host_calls(&self) -> bool {
        true
    }

    fn host_call(&self, verb: &str, args: &Value, window: u64, done: Done) {
        if let Err(error) = self.link.check() {
            return done(Err(error));
        }
        let host_call = self
            .api
            .host_call
            .expect("checked when the table was accepted");
        let (verb_c, args_c) = match (
            c_string(verb, "the host verb"),
            c_string(&args.to_string(), "the host arguments"),
        ) {
            (Ok(verb), Ok(args)) => (verb, args),
            (Err(error), _) | (_, Err(error)) => return done(Err(error)),
        };
        let if_abandoned = (verb == "tab.create")
            .then(|| close_late_open(host_call, self.link.owner, args, window));
        abi::call_owned(
            self.instance,
            verb,
            done,
            if_abandoned,
            |reply, context| unsafe {
                host_call(verb_c.as_ptr(), args_c.as_ptr(), window, reply, context)
            },
        );
    }

    fn engine_call(&self, name: &ServiceName, profile: &str, args: ServiceArgs) -> Reply<Value> {
        if let Err(error) = self.link.check() {
            return Reply::err(error);
        }
        abi::call_service(
            ServiceRoute::Dispatch(
                self.api
                    .engine_call
                    .expect("checked when the table was accepted"),
            ),
            name,
            profile,
            args,
        )
    }

    fn engine_call_secret(
        &self,
        name: &ServiceName,
        profile: &str,
        args: ServiceArgs,
    ) -> Reply<SecretValue> {
        if let Err(error) = self.link.check() {
            return Reply::err(error);
        }
        abi::call_service_secret(
            ServiceRoute::Dispatch(
                self.api
                    .engine_call
                    .expect("checked when the table was accepted"),
            ),
            name,
            profile,
            args,
        )
    }

    fn install_sink(&self, sink: Sink) -> EngineResult<()> {
        self.link.attach(sink)
    }

    fn remove_sink(&self) {
        self.link.detach();
    }

    fn abandon_host_calls(&self) {
        abi::abandon_host_calls(self.instance);
    }
}

pub struct ServiceTransport {
    dispatch: AcEngineDispatch,
    backend: EngineBackend,
    link: NativeLink,
}

impl ServiceTransport {
    #[allow(clippy::missing_safety_doc)]
    pub unsafe fn new(
        dispatch: AcEngineDispatch,
        set_sink: AcEngineSetEventSink,
        backend: EngineBackend,
    ) -> Self {
        Self {
            dispatch,
            backend,
            link: NativeLink::here(set_sink),
        }
    }
}

impl Drop for ServiceTransport {
    fn drop(&mut self) {
        self.link.detach();
    }
}

impl DesktopTransport for ServiceTransport {
    fn backend(&self) -> EngineBackend {
        self.backend
    }

    fn has_host_calls(&self) -> bool {
        false
    }

    fn host_call(&self, _verb: &str, _args: &Value, _window: u64, done: Done) {
        done(Err(EngineError::Unsupported(
            "drive windows and tabs: this engine exposes services only",
        )))
    }

    fn engine_call(&self, name: &ServiceName, profile: &str, args: ServiceArgs) -> Reply<Value> {
        if let Err(error) = self.link.check() {
            return Reply::err(error);
        }
        abi::call_service(ServiceRoute::Dispatch(self.dispatch), name, profile, args)
    }

    fn engine_call_secret(
        &self,
        name: &ServiceName,
        profile: &str,
        args: ServiceArgs,
    ) -> Reply<SecretValue> {
        if let Err(error) = self.link.check() {
            return Reply::err(error);
        }
        abi::call_service_secret(ServiceRoute::Dispatch(self.dispatch), name, profile, args)
    }

    fn install_sink(&self, sink: Sink) -> EngineResult<()> {
        self.link.attach(sink)
    }

    fn remove_sink(&self) {
        self.link.detach();
    }

    fn abandon_host_calls(&self) {}
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Live,
    Opening {
        close: bool,
        show: bool,
    },
}

#[derive(Clone, Debug, Default)]
struct DesktopTab {
    key: String,
    window: Option<EngineWindowId>,
    info: TabInfo,
    discarded: bool,
    phase: Phase,
    frame: Option<Rect>,
    opener: Option<EngineTabId>,
    disposition: String,
    host_documents: u64,
    visibility: u64,
    show_request: VisibilityRequest,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct VisibilityRequest {
    tab: u64,
    window: u64,
}

#[derive(Clone, Debug)]
struct DesktopWindow {
    native: u64,
    active_profile: Option<EngineProfileId>,
    tabs: Vec<EngineTabId>,
    shown: Option<EngineTabId>,
    shows: u64,
}

#[derive(Default)]
struct DesktopState {
    next: u64,
    started: bool,
    profiles: BTreeMap<EngineProfileId, String>,
    windows: BTreeMap<EngineWindowId, DesktopWindow>,
    tabs: BTreeMap<EngineTabId, DesktopTab>,
    keys: HashMap<String, EngineTabId>,
}

impl DesktopState {
    fn mint(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    fn profile_named(&mut self, name: &str) -> EngineProfileId {
        if let Some((id, _)) = self.profiles.iter().find(|(_, n)| n.as_str() == name) {
            return *id;
        }
        let id = EngineProfileId::from_raw(self.mint()).expect("ids start at one");
        self.profiles.insert(id, name.to_owned());
        id
    }

    fn profile(&self, id: EngineProfileId) -> EngineResult<&str> {
        self.profiles
            .get(&id)
            .map(String::as_str)
            .ok_or(EngineError::UnknownProfile(id))
    }

    fn window(&self, id: EngineWindowId) -> EngineResult<&DesktopWindow> {
        self.windows.get(&id).ok_or(EngineError::UnknownWindow(id))
    }

    fn tab(&self, id: EngineTabId) -> EngineResult<&DesktopTab> {
        self.tabs.get(&id).ok_or(EngineError::UnknownTab(id))
    }

    fn request_visibility(&mut self, id: EngineTabId, show: bool) -> Option<VisibilityRequest> {
        let entry = self.tabs.get_mut(&id)?;
        entry.visibility += 1;
        let window = match entry.window.and_then(|w| self.windows.get_mut(&w)) {
            Some(window) if show => {
                window.shows += 1;
                window.shows
            }
            _ => 0,
        };
        let request = VisibilityRequest {
            tab: entry.visibility,
            window,
        };
        if show {
            entry.show_request = request;
        }
        Some(request)
    }

    fn is_current(&self, id: EngineTabId, request: VisibilityRequest, show: bool) -> bool {
        let Some(entry) = self.tabs.get(&id) else {
            return false;
        };
        entry.phase == Phase::Live
            && entry.visibility == request.tab
            && (!show
                || entry
                    .window
                    .and_then(|w| self.windows.get(&w))
                    .is_some_and(|window| window.shows == request.window))
    }

    fn live_tab(&self, id: EngineTabId) -> EngineResult<&DesktopTab> {
        let tab = self.tab(id)?;
        match tab.phase {
            Phase::Live => Ok(tab),
            Phase::Opening { .. } => Err(EngineError::failed("that tab is still opening")),
        }
    }

    fn open(
        &mut self,
        window: EngineWindowId,
        profile: EngineProfileId,
        foreground: bool,
    ) -> (EngineTabId, String) {
        let tab = EngineTabId::from_raw(self.mint()).expect("ids start at one");
        let key = fresh_tab_key();
        self.keys.insert(key.clone(), tab);
        self.tabs.insert(
            tab,
            DesktopTab {
                key: key.clone(),
                window: Some(window),
                info: TabInfo {
                    profile: Some(profile),
                    zoom_factor: 1.0,
                    pinch_scale: 1.0,
                    ..TabInfo::default()
                },
                phase: Phase::Opening {
                    close: false,
                    show: false,
                },
                disposition: if foreground {
                    "foreground".into()
                } else {
                    "background".into()
                },
                ..DesktopTab::default()
            },
        );
        (tab, key)
    }

    fn forget_tab(&mut self, id: EngineTabId, out: &mut Vec<EngineEvent>) {
        let Some(tab) = self.tabs.remove(&id) else {
            return;
        };
        self.keys.remove(&tab.key);
        out.push(EngineEvent::TabWillClose { tab: id });
        if tab.phase != Phase::Live {
            return;
        }
        if let Some(window) = tab.window
            && let Some(entry) = self.windows.get_mut(&window)
        {
            entry.tabs.retain(|t| *t != id);
            if entry.shown == Some(id) {
                entry.shown = None;
            }
            out.push(EngineEvent::TabRemoved { window, tab: id });
        }
    }
}

struct DeferredShow {
    key: String,
    native: u64,
    frame: Rect,
    request: VisibilityRequest,
}

enum Settled {
    Inserted { show: Option<DeferredShow> },
    Release,
    Gone,
}

fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme_ok = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !scheme_ok {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    (!host.is_empty()).then(|| {
        format!(
            "{}://{}",
            scheme.to_ascii_lowercase(),
            host.to_ascii_lowercase()
        )
    })
}

struct DesktopShared {
    bus: EventBus,
    policy: RwLock<Arc<dyn HostPolicy>>,
    state: Mutex<DesktopState>,
}

fn rect_of(value: Option<&Value>) -> Option<Rect> {
    let value = value?;
    let number = |field: &str| value.get(field).and_then(Value::as_f64);
    let rect = Rect::new(
        number("x")?,
        number("y")?,
        number("width")?,
        number("height")?,
    );
    rect.is_valid().then_some(rect)
}

impl DesktopShared {
    fn publish(&self, events: Vec<EngineEvent>) {
        for event in events {
            self.bus.publish(event);
        }
    }

    fn deliver(&self, topic: &str, json: &str) {
        match topic {
            "tab" => self.deliver_tab(json),
            "tab.opened" => self.deliver_offer(json),
            "engine" => {
                let payload: Value = serde_json::from_str(json).unwrap_or(Value::Null);
                let inner = payload
                    .get("topic")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !inner.is_empty() {
                    let body = payload.get("payload").cloned().unwrap_or_else(|| json!({}));
                    self.bus
                        .publish(abi::decode_service_event(inner, &body.to_string()));
                }
            }
            _ => self.bus.publish(abi::decode_service_event(topic, json)),
        }
    }

    fn deliver_offer(&self, json: &str) {
        let Ok(payload) = serde_json::from_str::<Value>(json) else {
            return;
        };
        let text = |field: &str| {
            payload
                .get(field)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let flag = |field: &str| payload.get(field).and_then(Value::as_bool).unwrap_or(false);
        let id = text("adopt");
        if id.is_empty() {
            return;
        }
        let opener = self.state.lock().keys.get(&text("opener")).copied();
        let offer = TabOffer {
            id,
            url: text("url"),
            foreground: flag("foreground"),
            profile: text("profile"),
            opener,
            wants_window: flag("window"),
            popup: rect_of(payload.get("popup")),
            from_click: flag("fromClick"),
        };
        self.bus.publish(EngineEvent::TabOffered { offer });
    }

    fn deliver_tab(&self, json: &str) {
        let Ok(payload) = serde_json::from_str::<Value>(json) else {
            return;
        };
        let key = payload
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let data = payload.get("data").cloned().unwrap_or_else(|| json!({}));
        let text = |field: &str| {
            data.get(field)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let flag = |field: &str| data.get(field).and_then(Value::as_bool).unwrap_or(false);
        let number = |field: &str| data.get(field).and_then(Value::as_f64).unwrap_or(0.0);
        let mut events = Vec::new();
        {
            let mut state = self.state.lock();
            let Some(&tab) = state.keys.get(key) else {
                return;
            };
            if name == "windowClose" {
                state.forget_tab(tab, &mut events);
                drop(state);
                return self.publish(events);
            }
            let entry = state
                .tabs
                .get_mut(&tab)
                .expect("keys and tabs stay in step");
            let window = entry.window;
            let quiet = entry.phase != Phase::Live;
            match name {
                "navigation" => {
                    let url = text("url");
                    let title = text("title");
                    let loading = flag("isLoading");
                    let (back, forward) = (flag("canGoBack"), flag("canGoForward"));
                    let theme = data
                        .get("themeColor")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    if loading && !entry.info.loading {
                        events.push(EngineEvent::LoadingChanged { tab, loading: true });
                    }
                    if url != entry.info.url {
                        entry.info.url = url.clone();
                        events.push(EngineEvent::UrlChanged { tab, url });
                    }
                    let committed = text("committedUrl");
                    let origin = match data.get("committedOrigin") {
                        None => origin_of(&committed),
                        Some(Value::String(origin)) if !origin.is_empty() && origin != "null" => {
                            Some(origin.clone())
                        }
                        Some(_) => None,
                    };
                    let documents = data.get("documentCount").and_then(Value::as_u64);
                    let new_document = match documents {
                        Some(count) => count != entry.host_documents,
                        None => origin.is_some() && origin != entry.info.committed_origin,
                    };
                    if documents.is_some() || !committed.is_empty() {
                        entry.info.committed_origin = origin;
                    }
                    if new_document {
                        entry.info.committed_document_count = match documents {
                            Some(count) => {
                                entry.host_documents = count;
                                count.min(i32::MAX as u64) as i32
                            }
                            None => entry.info.committed_document_count.saturating_add(1),
                        };
                        events.push(EngineEvent::DocumentCommitted { tab });
                    }
                    if title != entry.info.title {
                        entry.info.title = title.clone();
                        events.push(EngineEvent::TitleChanged { tab, title });
                    }
                    if (back, forward) != (entry.info.can_go_back, entry.info.can_go_forward) {
                        entry.info.can_go_back = back;
                        entry.info.can_go_forward = forward;
                        events.push(EngineEvent::NavigationStateChanged {
                            tab,
                            can_go_back: back,
                            can_go_forward: forward,
                        });
                    }
                    if theme != entry.info.theme_color {
                        entry.info.theme_color = theme.clone();
                        events.push(EngineEvent::ThemeColorChanged { tab, color: theme });
                    }
                    if let Some(status) = data.get("httpStatus").and_then(Value::as_i64) {
                        entry.info.committed_http_status = status.clamp(0, i32::MAX.into()) as i32;
                    }
                    if !loading && entry.info.loading {
                        events.push(EngineEvent::LoadingChanged {
                            tab,
                            loading: false,
                        });
                    }
                    entry.info.loading = loading;
                }
                "progress" => {
                    entry.info.progress = number("progress").clamp(0.0, 1.0);
                    events.push(EngineEvent::ProgressChanged {
                        tab,
                        progress: entry.info.progress,
                    });
                }
                "favicon" => events.push(EngineEvent::FaviconChanged {
                    tab,
                    url: Some(text("url")).filter(|u| !u.is_empty()),
                }),
                "status" => events.push(EngineEvent::StatusText {
                    tab,
                    text: text("text"),
                }),
                "zoom" => {
                    entry.info.zoom_factor = number("zoom");
                    entry.info.pinch_scale = data
                        .get("pinchScale")
                        .and_then(Value::as_f64)
                        .unwrap_or(1.0);
                    events.push(EngineEvent::ZoomChanged {
                        tab,
                        zoom: entry.info.zoom_factor,
                    });
                }
                "find" => events.push(EngineEvent::FindMatches {
                    tab,
                    matches: FindMatches {
                        count: number("count") as i32,
                        active: number("active") as i32,
                        final_update: flag("final"),
                    },
                }),
                "crashed" => events.push(EngineEvent::RendererGone {
                    tab,
                    status: text("status"),
                    code: number("code") as i32,
                }),
                "loadError" => events.push(EngineEvent::LoadFailed {
                    tab,
                    url: text("url"),
                    code: number("code") as i32,
                    description: text("text"),
                }),
                "fullscreen" => {
                    if let Some(window) = window {
                        events.push(EngineEvent::FullscreenChanged {
                            window,
                            tab,
                            fullscreen: flag("fullscreen"),
                        });
                    }
                }
                "discarded" => {
                    entry.discarded = true;
                    entry.info.discarded = true;
                    events.push(EngineEvent::DiscardedChanged {
                        tab,
                        discarded: true,
                        reason: Some(text("reason")).filter(|r| !r.is_empty()),
                    });
                }
                "ready" => {
                    if std::mem::take(&mut entry.discarded) {
                        entry.info.discarded = false;
                        events.push(EngineEvent::DiscardedChanged {
                            tab,
                            discarded: false,
                            reason: None,
                        });
                    }
                }
                "downloadNavigation" => events.push(EngineEvent::NavigationBecameDownload {
                    tab,
                    url: text("url"),
                }),
                "popupBlocked" => events.push(EngineEvent::PopupBlocked {
                    tab,
                    popup: BlockedPopup {
                        id: text("id"),
                        url: text("url"),
                        origin: text("origin"),
                    },
                }),
                "security" => events.push(EngineEvent::SecurityChanged { tab }),
                "media" => {
                    let audible = flag("audible");
                    let muted = data
                        .get("muted")
                        .and_then(Value::as_bool)
                        .unwrap_or(entry.info.muted);
                    entry.info.audible = audible;
                    entry.info.muted = muted;
                    events.push(EngineEvent::AudioChanged {
                        tab,
                        audible,
                        muted,
                    });
                }
                "unresponsive" => events.push(EngineEvent::Unresponsive { tab }),
                "responsive" => events.push(EngineEvent::Responsive { tab }),
                "focus" => events.push(EngineEvent::FocusGained { tab }),
                other => events.push(EngineEvent::Service(ServiceEvent {
                    topic: format!("tab.{other}"),
                    profile: None,
                    off_the_record: false,
                    payload: json!({ "tab": tab.get(), "data": data }),
                })),
            }
            if quiet {
                events.clear();
            }
        }
        self.publish(events);
    }

    fn settle(&self, tab: EngineTabId, answer: EngineResult<Value>) -> Settled {
        let mut events = Vec::new();
        let mut guard = self.state.lock();
        let state = &mut *guard;
        let Some(entry) = state.tabs.get_mut(&tab) else {
            return Settled::Release;
        };
        let Phase::Opening { close, show } = entry.phase else {
            return Settled::Gone;
        };
        let settled = match answer {
            Err(error) => {
                log::warn!("the desktop host couldn't open {tab}: {error}");
                state.forget_tab(tab, &mut events);
                Settled::Release
            }
            Ok(_) if close => {
                state.forget_tab(tab, &mut events);
                Settled::Release
            }
            Ok(answer) => {
                entry.phase = Phase::Live;
                if let Some(chrome) = answer.get("tab").and_then(Value::as_i64) {
                    entry.info.tab_id = chrome.clamp(i32::MIN.into(), i32::MAX.into()) as i32;
                }
                let window = entry.window.expect("opening tabs have a window");
                let key = entry.key.clone();
                let frame = entry.frame;
                let request = entry.show_request;
                let opener = entry.opener;
                let disposition = entry.disposition.clone();
                let native = state.windows.get_mut(&window).map_or(0, |w| {
                    if !w.tabs.contains(&tab) {
                        w.tabs.push(tab);
                    }
                    w.native
                });
                events.push(EngineEvent::TabInserted {
                    window,
                    tab,
                    opener,
                    disposition,
                });
                Settled::Inserted {
                    show: frame.filter(|_| show).map(|frame| DeferredShow {
                        key,
                        native,
                        frame,
                        request,
                    }),
                }
            }
        };
        drop(guard);
        self.publish(events);
        settled
    }

    fn still_wanted(&self, tab: EngineTabId, request: VisibilityRequest) -> bool {
        self.state.lock().is_current(tab, request, true)
    }

    fn note_shown(&self, tab: EngineTabId, request: VisibilityRequest, visible: bool) {
        let activated = {
            let mut state = self.state.lock();
            if !state.is_current(tab, request, visible) {
                return;
            }
            let Some(window) = state.tabs.get(&tab).and_then(|entry| entry.window) else {
                return;
            };
            let Some(entry) = state.windows.get_mut(&window) else {
                return;
            };
            match (visible, entry.shown == Some(tab)) {
                (true, false) => {
                    entry.shown = Some(tab);
                    Some(EngineEvent::TabActivated { window, tab })
                }
                (false, true) => {
                    entry.shown = None;
                    None
                }
                _ => None,
            }
        };
        if let Some(event) = activated {
            self.bus.publish(event);
        }
    }
}

pub struct DesktopEngine<T: DesktopTransport> {
    shared: Arc<DesktopShared>,
    transport: Arc<T>,
    owner: ThreadId,
    _stays_on_its_thread: PhantomData<MutexGuard<'static, ()>>,
}

impl<T: DesktopTransport> Drop for DesktopEngine<T> {
    fn drop(&mut self) {
        let _closed = Finally::new(|| self.shared.bus.close());
        let _abandoned = Finally::new(|| self.transport.abandon_host_calls());
        if self.on_owner().is_ok() {
            let _detached = Finally::new(|| self.transport.remove_sink());
            let open: Vec<(String, u64)> = {
                let mut state = self.shared.state.lock();
                state.keys.clear();
                let tabs = std::mem::take(&mut state.tabs);
                tabs.into_values()
                    .map(|tab| {
                        let native = tab
                            .window
                            .and_then(|w| state.windows.get(&w))
                            .map_or(0, |w| w.native);
                        (tab.key, native)
                    })
                    .collect()
            };
            for (key, native) in open {
                self.transport.host_call(
                    "tab.close",
                    &json!({ "key": key }),
                    native,
                    Box::new(quietly("tab.close")),
                );
            }
        }
    }
}

fn show_args(key: &str, frame: Option<Rect>) -> Value {
    let mut args = json!({ "key": key, "visible": frame.is_some() });
    if let Some(frame) = frame {
        args["x"] = json!(frame.x);
        args["y"] = json!(frame.y);
        args["width"] = json!(frame.width);
        args["height"] = json!(frame.height);
    }
    args
}

impl<T: DesktopTransport> DesktopEngine<T> {
    pub fn new(transport: T) -> EngineResult<Self> {
        Self::with_bus(transport, EventBus::new())
    }

    pub fn with_bus(transport: T, bus: EventBus) -> EngineResult<Self> {
        let shared = Arc::new(DesktopShared {
            bus,
            policy: RwLock::new(Arc::new(DefaultPolicy::new())),
            state: Mutex::new(DesktopState::default()),
        });
        let weak: Weak<DesktopShared> = Arc::downgrade(&shared);
        transport.install_sink(Arc::new(move |topic, json| {
            if let Some(shared) = weak.upgrade() {
                shared.deliver(topic, json);
            }
        }))?;
        Ok(Self {
            shared,
            transport: Arc::new(transport),
            owner: std::thread::current().id(),
            _stays_on_its_thread: PhantomData,
        })
    }

    fn on_owner(&self) -> EngineResult<()> {
        if std::thread::current().id() == self.owner {
            Ok(())
        } else {
            Err(EngineError::WrongThread)
        }
    }

    pub fn deliver(&self, topic: &str, json: &str) {
        self.shared.deliver(topic, json);
    }

    pub fn attach_window(&self, native: NativeWindowHandle) -> EngineResult<EngineWindowId> {
        self.on_owner()?;
        if native.is_null() {
            return Err(EngineError::bad_argument("attach a real host window"));
        }
        let mut state = self.shared.state.lock();
        let native = native.as_ptr() as usize as u64;
        if let Some((id, _)) = state.windows.iter().find(|(_, w)| w.native == native) {
            return Ok(*id);
        }
        let id = EngineWindowId::from_raw(state.mint()).expect("ids start at one");
        state.windows.insert(
            id,
            DesktopWindow {
                native,
                active_profile: None,
                tabs: Vec::new(),
                shown: None,
                shows: 0,
            },
        );
        Ok(id)
    }

    pub fn show_tab(&self, tab: EngineTabId, frame: Option<Rect>) -> EngineResult<()> {
        self.on_owner()?;
        if frame.is_some_and(|frame| !frame.is_valid()) {
            return Err(EngineError::bad_argument(
                "the page frame must be finite and not negative",
            ));
        }
        let (key, native, request) = {
            let mut state = self.shared.state.lock();
            let native = {
                let entry = state.tab(tab)?;
                let window = entry.window.ok_or(EngineError::UnknownTab(tab))?;
                state.window(window)?.native
            };
            let request = state
                .request_visibility(tab, frame.is_some())
                .expect("checked above");
            let entry = state.tabs.get_mut(&tab).expect("checked above");
            if frame.is_some() {
                entry.frame = frame;
            }
            if let Phase::Opening { close, .. } = entry.phase {
                entry.phase = Phase::Opening {
                    close,
                    show: frame.is_some(),
                };
                return Ok(());
            }
            (entry.key.clone(), native, request)
        };
        self.sync("tab.show", show_args(&key, frame), native)?;
        self.shared.note_shown(tab, request, frame.is_some());
        Ok(())
    }

    pub fn adopt_offer(&self, window: EngineWindowId, offer: &str) -> EngineResult<EngineTabId> {
        self.on_owner()?;
        self.require_host("adopt engine tabs")?;
        let native = self.shared.state.lock().window(window)?.native;
        let offered = self.take_offer(offer)?;
        let (tab, key) = {
            let mut state = self.shared.state.lock();
            let profile = state.profile_named(&offered.profile);
            let (tab, key) = state.open(window, profile, offered.foreground);
            let entry = state.tabs.get_mut(&tab).expect("just opened");
            entry.opener = offered.opener;
            entry.disposition = "adopted".into();
            entry.info.url = offered.url;
            (tab, key)
        };
        self.create(tab, json!({ "key": key, "adopt": offer }), native);
        Ok(tab)
    }

    pub fn refuse_offer(&self, offer: &str) -> EngineResult<()> {
        self.on_owner()?;
        self.require_host("refuse engine tabs")?;
        self.take_offer(offer)?;
        self.fire("tab.discard", json!({ "adopt": offer }), 0)
    }

    fn take_offer(&self, offer: &str) -> EngineResult<TabOffer> {
        match self
            .shared
            .bus
            .settle_prompt(&PromptKey::TabOffer(offer.to_owned()))
        {
            Some(EngineEvent::TabOffered { offer }) => Ok(offer),
            _ => Err(EngineError::bad_argument("that tab offer is gone")),
        }
    }

    fn create(&self, tab: EngineTabId, args: Value, native: u64) {
        let key = args["key"].as_str().unwrap_or_default().to_owned();
        let offer = args.get("adopt").and_then(Value::as_str).map(str::to_owned);
        let weak = Arc::downgrade(&self.shared);
        let transport = self.transport.clone();
        self.transport.host_call(
            "tab.create",
            &args,
            native,
            Box::new(move |answer| {
                if matches!(answer, Err(EngineError::Cancelled)) {
                    return;
                }
                let failed = answer.is_err();
                let shared = weak.upgrade();
                let settled = match &shared {
                    Some(shared) => shared.settle(tab, answer),
                    None => Settled::Release,
                };
                match (settled, shared) {
                    (Settled::Inserted { show: Some(show) }, Some(shared)) => {
                        if !shared.still_wanted(tab, show.request) {
                            return;
                        }
                        let shown = Arc::downgrade(&shared);
                        transport.host_call(
                            "tab.show",
                            &show_args(&show.key, Some(show.frame)),
                            show.native,
                            Box::new(move |result| match result {
                                Ok(_) => {
                                    if let Some(shared) = shown.upgrade() {
                                        shared.note_shown(tab, show.request, true);
                                    }
                                }
                                Err(error) => log::warn!("desktop host tab.show failed: {error}"),
                            }),
                        );
                    }
                    (Settled::Release, _) => {
                        transport.host_call(
                            "tab.close",
                            &json!({ "key": key }),
                            native,
                            Box::new(quietly("tab.close")),
                        );
                        if failed && let Some(offer) = offer {
                            transport.host_call(
                                "tab.discard",
                                &json!({ "adopt": offer }),
                                0,
                                Box::new(quietly("tab.discard")),
                            );
                        }
                    }
                    _ => {}
                }
            }),
        );
    }

    fn fire(&self, verb: &str, args: Value, window: u64) -> EngineResult<()> {
        self.on_owner()?;
        self.transport
            .host_call(verb, &args, window, Box::new(log_failure(verb)));
        Ok(())
    }

    fn sync(&self, verb: &str, args: Value, window: u64) -> EngineResult<Value> {
        self.on_owner()?;
        let slot: Arc<Mutex<Option<EngineResult<Value>>>> = Arc::new(Mutex::new(None));
        let filled = slot.clone();
        self.transport.host_call(
            verb,
            &args,
            window,
            Box::new(move |result| *filled.lock() = Some(result)),
        );
        let answer = slot.lock().take();
        answer.unwrap_or_else(|| {
            Err(EngineError::failed(format!(
                "the host answers {verb} later; use the async call"
            )))
        })
    }

    fn tab_call(
        &self,
        tab: EngineTabId,
        method: &str,
        mut args: Value,
    ) -> EngineResult<(Value, u64)> {
        let state = self.shared.state.lock();
        let entry = state.live_tab(tab)?;
        let native = entry
            .window
            .and_then(|w| state.windows.get(&w))
            .map_or(0, |w| w.native);
        args["key"] = json!(entry.key);
        args["method"] = json!(method);
        Ok((args, native))
    }

    fn require_host(&self, what: &'static str) -> EngineResult<()> {
        if self.transport.has_host_calls() {
            Ok(())
        } else {
            Err(EngineError::Unsupported(what))
        }
    }
}

fn quietly(verb: &str) -> impl FnOnce(EngineResult<Value>) + Send + 'static {
    let verb = verb.to_owned();
    move |result| {
        if let Err(error) = result {
            log::debug!("desktop host {verb} cleanup: {error}");
        }
    }
}

fn log_failure(verb: &str) -> impl FnOnce(EngineResult<Value>) + Send + 'static {
    let verb = verb.to_owned();
    move |result| {
        if let Err(error) = result {
            log::warn!("desktop host {verb} failed: {error}");
        }
    }
}

fn tab_method(command: &TabCommand) -> Option<(&'static str, Value)> {
    Some(match command {
        TabCommand::LoadUrl {
            url,
            user_initiated,
        } => (
            "loadUrl",
            json!({ "url": url, "userInitiated": user_initiated }),
        ),
        TabCommand::GoBack => ("goBack", json!({})),
        TabCommand::GoForward => ("goForward", json!({})),
        TabCommand::GoToOffset { offset } => ("goToOffset", json!({ "offset": offset })),
        TabCommand::Reload => ("reload", json!({})),
        TabCommand::ReloadIgnoringCache => ("forceReload", json!({})),
        TabCommand::Stop => ("stopLoading", json!({})),
        TabCommand::SetMuted { muted } => ("setMuted", json!({ "muted": muted })),
        TabCommand::Focus => ("focus", json!({})),
        TabCommand::Find { text, forward } => ("find", json!({ "text": text, "forward": forward })),
        TabCommand::StopFinding => ("stopFinding", json!({})),
        TabCommand::ZoomStep { direction } => ("zoomStep", json!({ "direction": direction })),
        TabCommand::ExecuteJavaScript { code, frame: None } => {
            ("executeJavaScript", json!({ "code": code }))
        }
        TabCommand::ShowDevTools => ("showDevTools", json!({})),
        TabCommand::ShowDevToolsPanel { panel } => ("showDevTools", json!({ "panel": panel })),
        TabCommand::OpenBlockedPopup { popup_id, always } => (
            "openBlockedPopup",
            json!({ "id": popup_id, "always": always }),
        ),
        TabCommand::SetFrozen { frozen } => ("setFrozen", json!({ "frozen": frozen })),
        TabCommand::ResolveUnresponsive { terminate } => {
            ("resolveUnresponsive", json!({ "terminate": terminate }))
        }
        _ => return None,
    })
}

impl<T: DesktopTransport> BrowserEngine for DesktopEngine<T> {
    fn backend(&self) -> EngineBackend {
        self.transport.backend()
    }

    fn events(&self) -> &EventBus {
        &self.shared.bus
    }

    fn set_policy(&self, policy: Arc<dyn HostPolicy>) {
        *self.shared.policy.write() = policy;
    }

    fn run_with_args(&self, _args: &[String]) -> EngineResult<i32> {
        self.on_owner()?;
        {
            let mut state = self.shared.state.lock();
            if state.started {
                return Err(EngineError::AlreadyRunning);
            }
            state.started = true;
            state.profile_named("");
        }
        self.shared.bus.publish(EngineEvent::Started);
        Ok(0)
    }

    fn is_started(&self) -> bool {
        self.shared.state.lock().started
    }

    fn quit(&self) -> EngineResult<()> {
        self.require_host("quit through the host")?;
        self.fire("app.quit", json!({}), 0)
    }

    fn query(&self, query: EngineQuery) -> EngineResult<Value> {
        match query {
            EngineQuery::ChromiumVersion | EngineQuery::KeepAliveState => {
                self.require_host("describe the engine")?;
                let info = self.sync("host.info", json!({}), 0)?;
                let field = if query == EngineQuery::ChromiumVersion {
                    "chromiumVersion"
                } else {
                    "keepAlive"
                };
                Ok(info
                    .get(field)
                    .cloned()
                    .unwrap_or(Value::String(String::new())))
            }
            _ => Err(EngineError::Unsupported(
                "answer that query on this platform",
            )),
        }
    }

    fn set_page_script(&self, _script: Option<&str>) -> EngineResult<()> {
        Err(EngineError::Unsupported(
            "swap the page script: the desktop host injects its own",
        ))
    }

    fn global(&self, command: GlobalCommand) -> EngineResult<()> {
        command.validate()?;
        Err(EngineError::Unsupported(
            "resolve engine prompts outside the desktop host",
        ))
    }

    fn default_profile(&self) -> EngineResult<EngineProfileId> {
        let mut state = self.shared.state.lock();
        if !state.started {
            return Err(EngineError::NotStarted);
        }
        Ok(state.profile_named(""))
    }

    fn load_profile(&self, directory_name: &str) -> Reply<EngineProfileId> {
        let mut state = self.shared.state.lock();
        if !state.started {
            return Reply::err(EngineError::NotStarted);
        }
        Reply::ok(state.profile_named(directory_name))
    }

    fn off_the_record_profile(&self, _profile: EngineProfileId) -> Reply<EngineProfileId> {
        Reply::err(EngineError::Unsupported(
            "open private profiles from the app on this platform",
        ))
    }

    fn delete_profile(&self, _profile: EngineProfileId) -> Reply<bool> {
        Reply::err(EngineError::Unsupported(
            "delete profiles from the app on this platform",
        ))
    }

    fn profile_info(&self, profile: EngineProfileId) -> EngineResult<ProfileInfo> {
        let state = self.shared.state.lock();
        let name = state.profile(profile)?.to_owned();
        Ok(ProfileInfo {
            path: name.clone(),
            name,
            ..ProfileInfo::default()
        })
    }

    fn profile_command(
        &self,
        profile: EngineProfileId,
        command: ProfileCommand,
    ) -> EngineResult<()> {
        let name = self.shared.state.lock().profile(profile)?.to_owned();
        match command {
            ProfileCommand::Release => {
                self.require_host("release profiles")?;
                self.fire("profile.release", json!({ "profile": name }), 0)
            }
            _ => Err(EngineError::Unsupported(
                "change that profile setting on this platform",
            )),
        }
    }

    fn load_component_extension(
        &self,
        _profile: EngineProfileId,
        _path: &str,
    ) -> EngineResult<Option<String>> {
        Err(EngineError::Unsupported(
            "load component extensions on this platform",
        ))
    }

    fn sleep_idle_profile(
        &self,
        _profile: EngineProfileId,
        _hosted_tabs: &[EngineTabId],
    ) -> EngineResult<Option<String>> {
        Err(EngineError::Unsupported(
            "put profiles to sleep on this platform",
        ))
    }

    fn unload_idle_profile(&self, _profile: EngineProfileId) -> EngineResult<String> {
        Err(EngineError::Unsupported("unload profiles on this platform"))
    }

    fn fetch_icon(
        &self,
        _profile: EngineProfileId,
        _url: &str,
        _max_bytes: usize,
    ) -> Reply<Option<Vec<u8>>> {
        Reply::err(EngineError::Unsupported("fetch icons on this platform"))
    }

    fn clear_browsing_data(
        &self,
        _profile: EngineProfileId,
        _kinds: &[BrowsingDataKind],
        _since_ms: Option<f64>,
    ) -> Reply<()> {
        Reply::err(EngineError::Unsupported(
            "clear browsing data through the host on this platform",
        ))
    }

    fn create_window(&self, _frame: Rect) -> EngineResult<EngineWindowId> {
        Err(EngineError::Unsupported(
            "create engine windows here: attach the app's window instead",
        ))
    }

    fn window_info(&self, window: EngineWindowId) -> EngineResult<WindowInfo> {
        let state = self.shared.state.lock();
        let entry = state.window(window)?;
        Ok(WindowInfo {
            active_profile: entry.active_profile,
            visible: true,
            window_number: entry.native as i64,
            ..WindowInfo::default()
        })
    }

    fn native_window_handle(&self, window: EngineWindowId) -> EngineResult<NativeWindow> {
        let native = self.shared.state.lock().window(window)?.native;
        Ok(NativeWindow::borrowed(NativeWindowHandle(
            native as usize as *mut c_void,
        )))
    }

    fn window_host_view(&self, window: EngineWindowId) -> EngineResult<NativeView> {
        let native = self.shared.state.lock().window(window)?.native;
        Ok(NativeView::borrowed(NativeViewHandle(
            native as usize as *mut c_void,
        )))
    }

    fn window_command(&self, window: EngineWindowId, command: WindowCommand) -> EngineResult<()> {
        self.on_owner()?;
        match command {
            WindowCommand::SetActiveProfile { profile } => {
                let mut state = self.shared.state.lock();
                if let Some(profile) = profile {
                    state.profile(profile)?;
                }
                state
                    .windows
                    .get_mut(&window)
                    .ok_or(EngineError::UnknownWindow(window))?
                    .active_profile = profile;
                Ok(())
            }
            WindowCommand::ActivateTab { tab } => {
                self.require_host("show tabs")?;
                let (key, native, frame, request) = {
                    let mut state = self.shared.state.lock();
                    let native = state.window(window)?.native;
                    let entry = state.live_tab(tab)?;
                    if entry.window != Some(window) {
                        return Err(EngineError::UnknownTab(tab));
                    }
                    let frame = entry.frame.ok_or_else(|| {
                        EngineError::bad_argument("show the tab with a frame before activating it")
                    })?;
                    let key = entry.key.clone();
                    let request = state.request_visibility(tab, true).expect("checked above");
                    (key, native, frame, request)
                };
                self.sync("tab.show", show_args(&key, Some(frame)), native)?;
                self.shared.note_shown(tab, request, true);
                Ok(())
            }
            WindowCommand::PlaceTab { tab, .. } => {
                let state = self.shared.state.lock();
                state.window(window)?;
                if state.tab(tab)?.window == Some(window) {
                    Ok(())
                } else {
                    Err(EngineError::UnknownTab(tab))
                }
            }
            WindowCommand::Close => {
                let tabs = self.shared.state.lock().window(window)?.tabs.clone();
                let opening: Vec<EngineTabId> = {
                    let state = self.shared.state.lock();
                    state
                        .tabs
                        .iter()
                        .filter(|(_, t)| t.window == Some(window) && t.phase != Phase::Live)
                        .map(|(id, _)| *id)
                        .collect()
                };
                for tab in tabs.into_iter().chain(opening) {
                    self.tab_command(tab, TabCommand::Close)?;
                }
                self.shared.state.lock().windows.remove(&window);
                self.shared
                    .bus
                    .publish(EngineEvent::WindowClosed { window });
                Ok(())
            }
            WindowCommand::PrepareProfile { profile } => {
                self.shared.state.lock().profile(profile).map(|_| ())
            }
            WindowCommand::ShowInactive
            | WindowCommand::SetActedFullScreen { .. }
            | WindowCommand::SetInternal { .. }
            | WindowCommand::SetAutomation { .. } => Err(EngineError::Unsupported(
                "change engine window state: the app owns its windows here",
            )),
        }
    }

    fn open_tab(&self, window: EngineWindowId, request: OpenTab) -> EngineResult<EngineTabId> {
        self.on_owner()?;
        self.require_host("open tabs")?;
        let (tab, key, native, profile) = {
            let mut state = self.shared.state.lock();
            let native = state.window(window)?.native;
            let profile = state.profile(request.profile)?.to_owned();
            let (tab, key) = state.open(window, request.profile, request.foreground);
            (tab, key, native, profile)
        };
        self.create(tab, json!({ "key": key, "url": request.url, "profile": profile, "background": !request.foreground }), native);
        Ok(tab)
    }

    fn open_extension_view(
        &self,
        _: EngineWindowId,
        _: &str,
        _: EngineProfileId,
        _: ExtensionViewKind,
    ) -> EngineResult<Option<EngineTabId>> {
        Err(EngineError::Unsupported(
            "open extension views on this platform",
        ))
    }

    fn restore_tab(
        &self,
        _: EngineWindowId,
        _: Option<&str>,
        _: EngineProfileId,
        _: bool,
    ) -> EngineResult<Option<EngineTabId>> {
        Err(EngineError::Unsupported(
            "restore tabs through the host on this platform",
        ))
    }

    fn duplicate_tab(
        &self,
        _: EngineWindowId,
        _: EngineTabId,
        _: EngineProfileId,
        _: bool,
    ) -> EngineResult<Option<EngineTabId>> {
        Err(EngineError::Unsupported(
            "duplicate tabs through the host on this platform",
        ))
    }

    fn adopt_tab(&self, window: EngineWindowId, tab: EngineTabId) -> EngineResult<Adoption> {
        self.on_owner()?;
        self.require_host("move tabs")?;
        let (key, from, native) = {
            let state = self.shared.state.lock();
            let native = state.window(window)?.native;
            let entry = state.live_tab(tab)?;
            (entry.key.clone(), entry.window, native)
        };
        if from == Some(window) {
            return Ok(Adoption::Adopted);
        }
        let answer = self.sync("tab.create", json!({ "key": key }), native)?;
        if answer.get("tab").is_none() {
            return Ok(Adoption::Refused);
        }
        let mut events = Vec::new();
        {
            let mut state = self.shared.state.lock();
            if let Some(from) = from
                && let Some(old) = state.windows.get_mut(&from)
            {
                old.tabs.retain(|t| *t != tab);
                if old.shown == Some(tab) {
                    old.shown = None;
                }
                events.push(EngineEvent::TabRemoved { window: from, tab });
            }
            if let Some(entry) = state.tabs.get_mut(&tab) {
                entry.window = Some(window);
            }
            state.request_visibility(tab, false);
            if let Some(entry) = state.windows.get_mut(&window) {
                entry.tabs.push(tab);
            }
            events.push(EngineEvent::TabInserted {
                window,
                tab,
                opener: None,
                disposition: "adopted".into(),
            });
        }
        self.shared.publish(events);
        Ok(Adoption::Adopted)
    }

    fn can_adopt_tab(&self, window: EngineWindowId, tab: EngineTabId) -> EngineResult<Adoption> {
        let state = self.shared.state.lock();
        state.window(window)?;
        let entry = state.tab(tab)?;
        Ok(if !self.transport.has_host_calls() {
            Adoption::Refused
        } else if entry.phase != Phase::Live {
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
        let state = self.shared.state.lock();
        Ok(state
            .window(window)?
            .tabs
            .iter()
            .copied()
            .filter(|tab| {
                state
                    .tabs
                    .get(tab)
                    .is_some_and(|entry| entry.info.profile == Some(profile))
            })
            .collect())
    }

    fn chrome_window_id(&self, _: EngineWindowId, _: EngineProfileId) -> EngineResult<i32> {
        Err(EngineError::Unsupported(
            "report Chrome window ids on this platform",
        ))
    }

    fn execute_chrome_command(
        &self,
        _: EngineWindowId,
        _: i32,
        _: EngineProfileId,
    ) -> EngineResult<bool> {
        Err(EngineError::Unsupported(
            "run Chrome commands on this platform",
        ))
    }

    fn tab_info(&self, tab: EngineTabId) -> EngineResult<TabInfo> {
        Ok(self.shared.state.lock().tab(tab)?.info.clone())
    }

    fn native_view_handle(&self, tab: EngineTabId) -> EngineResult<NativeView> {
        self.shared.state.lock().tab(tab)?;
        Err(EngineError::Unsupported(
            "hand out page views: place pages with show_tab",
        ))
    }

    fn devtools_view_handle(&self, tab: EngineTabId) -> EngineResult<Option<NativeView>> {
        self.shared.state.lock().tab(tab)?;
        Ok(None)
    }

    fn navigation_entries(&self, tab: EngineTabId) -> EngineResult<Vec<NavigationEntry>> {
        self.require_host("list navigation entries")?;
        let (args, native) = self.tab_call(tab, "navigationEntries", json!({}))?;
        let answer = self.sync("tab.call", args, native)?;
        Ok(answer
            .get("entries")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|e| serde_json::from_value(e.clone()).ok())
                    .collect()
            })
            .unwrap_or_default())
    }

    fn security_info(&self, tab: EngineTabId) -> EngineResult<SecurityInfo> {
        self.require_host("read page security")?;
        let (args, native) = self.tab_call(tab, "getSecurityInfo", json!({}))?;
        serde_json::from_value(self.sync("tab.call", args, native)?)
            .map_err(|e| EngineError::BadReply(e.to_string()))
    }

    fn password_prompt(&self, tab: EngineTabId) -> EngineResult<Option<PasswordPrompt>> {
        self.shared.state.lock().tab(tab)?;
        Ok(None)
    }

    fn autofill_prompt(&self, tab: EngineTabId) -> EngineResult<Option<AutofillPrompt>> {
        self.shared.state.lock().tab(tab)?;
        Ok(None)
    }

    fn tab_command(&self, tab: EngineTabId, command: TabCommand) -> EngineResult<()> {
        command.validate()?;
        self.on_owner()?;
        self.require_host("drive tabs")?;
        match command {
            TabCommand::Close | TabCommand::CloseNow => {
                let (key, native) = {
                    let mut guard = self.shared.state.lock();
                    let state = &mut *guard;
                    let entry = state
                        .tabs
                        .get_mut(&tab)
                        .ok_or(EngineError::UnknownTab(tab))?;
                    if let Phase::Opening { show, .. } = entry.phase {
                        entry.phase = Phase::Opening { close: true, show };
                        return Ok(());
                    }
                    let key = entry.key.clone();
                    let native = entry
                        .window
                        .and_then(|w| state.windows.get(&w))
                        .map_or(0, |w| w.native);
                    (key, native)
                };
                self.fire("tab.close", json!({ "key": key }), native)?;
                let mut events = Vec::new();
                self.shared.state.lock().forget_tab(tab, &mut events);
                self.shared.publish(events);
                Ok(())
            }
            TabCommand::NoteShown { shown } => {
                if !shown {
                    let (key, native, request) = {
                        let mut state = self.shared.state.lock();
                        let request = state
                            .request_visibility(tab, false)
                            .ok_or(EngineError::UnknownTab(tab))?;
                        let native = {
                            let entry = state.tab(tab)?;
                            entry
                                .window
                                .and_then(|w| state.windows.get(&w))
                                .map_or(0, |w| w.native)
                        };
                        let entry = state.tabs.get_mut(&tab).expect("checked above");
                        if let Phase::Opening { close, .. } = entry.phase {
                            entry.phase = Phase::Opening { close, show: false };
                            return Ok(());
                        }
                        (entry.key.clone(), native, request)
                    };
                    self.sync("tab.show", show_args(&key, None), native)?;
                    self.shared.note_shown(tab, request, false);
                }
                Ok(())
            }
            other => {
                let (method, args) = tab_method(&other).ok_or(EngineError::Unsupported(
                    "run that tab command on this platform",
                ))?;
                let (args, native) = self.tab_call(tab, method, args)?;
                self.fire("tab.call", args, native)
            }
        }
    }

    fn tab_action(&self, tab: EngineTabId, action: TabAction) -> EngineResult<bool> {
        self.require_host("run tab actions")?;
        let unload = match action {
            TabAction::Discard => false,
            TabAction::UnloadKeepingHistory => true,
            _ => {
                return Err(EngineError::Unsupported(
                    "run that tab action on this platform",
                ));
            }
        };
        let (args, native) = self.tab_call(tab, "discard", json!({ "unload": unload }))?;
        let answer = self.sync("tab.call", args, native)?;
        Ok(answer.get("outcome").and_then(Value::as_str) == Some("discarded"))
    }

    fn sleep_if_hidden(&self, tab: EngineTabId, seconds: f64) -> EngineResult<Vec<i32>> {
        if !(seconds.is_finite() && seconds >= 0.0) {
            return Err(EngineError::bad_argument(
                "sleep time must be a non-negative number",
            ));
        }
        self.require_host("put tabs to sleep")?;
        let (args, native) = self.tab_call(tab, "sleepIfHidden", json!({ "seconds": seconds }))?;
        let answer = self.sync("tab.call", args, native)?;
        let kept_by = answer
            .get("keptBy")
            .and_then(Value::as_array)
            .ok_or_else(|| EngineError::BadReply("sleepIfHidden sent no keptBy".into()))?;
        Ok(kept_by
            .iter()
            .filter_map(Value::as_i64)
            .map(|code| code.clamp(i32::MIN.into(), i32::MAX.into()) as i32)
            .collect())
    }

    fn execute_extension_action(&self, _: EngineTabId, _: &str) -> EngineResult<String> {
        Err(EngineError::Unsupported(
            "run extension actions on this platform",
        ))
    }

    fn extension_action_states(
        &self,
        _: EngineTabId,
        _: &[String],
    ) -> EngineResult<ExtensionActionStates> {
        Err(EngineError::Unsupported(
            "read extension actions on this platform",
        ))
    }

    fn side_panel_url(&self, _: EngineTabId, _: &str) -> EngineResult<Option<String>> {
        Err(EngineError::Unsupported(
            "read side panels on this platform",
        ))
    }

    fn evaluate_js(&self, tab: EngineTabId, code: &str) -> Reply<Option<Value>> {
        let prepared = self
            .on_owner()
            .and_then(|_| self.require_host("evaluate scripts"))
            .and_then(|_| self.tab_call(tab, "evaluate", json!({ "code": code })));
        let (args, native) = match prepared {
            Ok(target) => target,
            Err(error) => return Reply::err(error),
        };
        let (responder, reply) = Reply::channel();
        self.transport.host_call(
            "tab.call",
            &args,
            native,
            Box::new(move |result| {
                responder.send(result.and_then(|answer| {
                    match answer.get("result") {
                        Some(Value::String(json)) => serde_json::from_str(json)
                            .map(Some)
                            .map_err(|e| EngineError::BadReply(e.to_string())),
                        Some(Value::Null) | None => Ok(None),
                        Some(other) => {
                            Err(EngineError::BadReply(format!("evaluate answered {other}")))
                        }
                    }
                }))
            }),
        );
        reply
    }

    fn ask_before_leaving(&self, tab: EngineTabId) -> Reply<bool> {
        match self.shared.state.lock().tab(tab) {
            Ok(_) => Reply::ok(true),
            Err(error) => Reply::err(error),
        }
    }

    fn enter_pip(&self, _: EngineTabId, _: f64) -> Reply<PipEntry> {
        Reply::err(EngineError::Unsupported(
            "open picture in picture on this platform",
        ))
    }

    fn devtools_call(
        &self,
        tab: EngineTabId,
        _method: &str,
        _params: Option<Value>,
        _timeout: Duration,
    ) -> Reply<Value> {
        match self.shared.state.lock().tab(tab) {
            Ok(_) => Reply::err(EngineError::Unsupported("call DevTools on this platform")),
            Err(error) => Reply::err(error),
        }
    }

    fn call_service(&self, name: &str, profile_dir: &str, args_json: &str) -> Reply<Value> {
        let prepared = self
            .on_owner()
            .and_then(|_| Ok((ServiceName::new(name)?, ServiceArgs::json(args_json)?)));
        match prepared {
            Ok((name, args)) => self.transport.engine_call(&name, profile_dir, args),
            Err(error) => Reply::err(error),
        }
    }

    fn call_service_secret(
        &self,
        name: &str,
        profile_dir: &str,
        args_json: zeroize::Zeroizing<String>,
    ) -> Reply<SecretValue> {
        let prepared = self
            .on_owner()
            .and_then(|_| Ok((ServiceName::new(name)?, ServiceArgs::secret(args_json)?)));
        match prepared {
            Ok((name, args)) => self.transport.engine_call_secret(&name, profile_dir, args),
            Err(error) => Reply::err(error),
        }
    }

    fn page_view(&self, _: &NativeView, _: PageViewQuery) -> EngineResult<bool> {
        Err(EngineError::Unsupported(
            "inspect page views on this platform",
        ))
    }

    fn set_scroll_observer(&self, _: bool) -> EngineResult<()> {
        Err(EngineError::Unsupported(
            "observe page scrolling on this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::AcEngineEvent;
    use futures::executor::block_on;
    use std::ffi::CString;
    use std::sync::LazyLock;

    #[derive(Default)]
    struct FakeHost {
        calls: Mutex<Vec<(String, Value, u64)>>,
        sink: Mutex<Option<Sink>>,
        refuse: Mutex<Vec<String>>,
        defer: Mutex<bool>,
        deferred: Mutex<Vec<Done>>,
        defer_show: Mutex<bool>,
        shows: Mutex<Vec<Done>>,
        finish_on_close: Mutex<bool>,
        services: Mutex<Vec<(String, String, String)>>,
    }

    struct FakeTransport(Arc<FakeHost>);

    impl DesktopTransport for FakeTransport {
        fn backend(&self) -> EngineBackend {
            EngineBackend::Windows
        }

        fn has_host_calls(&self) -> bool {
            true
        }

        fn host_call(&self, verb: &str, args: &Value, window: u64, done: Done) {
            self.0
                .calls
                .lock()
                .push((verb.to_owned(), args.clone(), window));
            if self.0.refuse.lock().iter().any(|v| v == verb) {
                return done(Err(EngineError::Service {
                    service: verb.into(),
                    message: "no such tab".into(),
                }));
            }
            if verb == "tab.create" && *self.0.defer.lock() {
                self.0.deferred.lock().push(done);
                return;
            }
            if verb == "tab.show" && *self.0.defer_show.lock() {
                self.0.shows.lock().push(done);
                return;
            }
            if verb == "tab.close" && *self.0.finish_on_close.lock() {
                let pending: Vec<Done> = std::mem::take(&mut *self.0.deferred.lock());
                for finish in pending {
                    finish(Ok(json!({ "tab": 41 })));
                }
            }
            let method = args
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            done(Ok(match (verb, method) {
                ("tab.create", _) => json!({ "tab": 77 }),
                ("tab.call", "navigationEntries") => {
                    json!({ "entries": [{ "url": "https://a.test/", "title": "A", "committed": true, "current": true }] })
                }
                ("tab.call", "getSecurityInfo") => {
                    json!({ "level": "secure", "url": "https://a.test/" })
                }
                ("tab.call", "discard") => json!({ "outcome": "discarded" }),
                ("tab.call", "evaluate") => json!({ "result": "{\"n\":2}" }),
                ("tab.call", "sleepIfHidden") => json!({ "keptBy": [3, 4] }),
                ("host.info", _) => json!({ "chromiumVersion": "149.0.1.2" }),
                _ => json!({ "ok": true }),
            }))
        }

        fn engine_call(
            &self,
            name: &ServiceName,
            profile: &str,
            args: ServiceArgs,
        ) -> Reply<Value> {
            self.0.services.lock().push((
                name.as_str().into(),
                profile.into(),
                args.as_str().into(),
            ));
            Reply::ok(json!({ "ok": true }))
        }

        fn engine_call_secret(
            &self,
            name: &ServiceName,
            profile: &str,
            _args: ServiceArgs,
        ) -> Reply<SecretValue> {
            self.0
                .services
                .lock()
                .push((name.as_str().into(), profile.into(), "<secret>".into()));
            Reply::ok(SecretValue::new(json!({ "ok": true })))
        }

        fn install_sink(&self, sink: Sink) -> EngineResult<()> {
            *self.0.sink.lock() = Some(sink);
            Ok(())
        }

        fn abandon_host_calls(&self) {}
    }

    fn desktop() -> (
        DesktopEngine<FakeTransport>,
        Arc<FakeHost>,
        EngineWindowId,
        EngineProfileId,
    ) {
        let host = Arc::new(FakeHost::default());
        let engine = DesktopEngine::new(FakeTransport(host.clone())).unwrap();
        engine.run_with_args(&[]).unwrap();
        let window = engine
            .attach_window(NativeWindowHandle(0x5000 as *mut c_void))
            .unwrap();
        let profile = engine.default_profile().unwrap();
        (engine, host, window, profile)
    }

    fn send(host: &FakeHost, topic: &str, payload: Value) {
        let sink = host.sink.lock().clone().unwrap();
        sink(topic, &payload.to_string());
    }

    fn open(
        engine: &DesktopEngine<FakeTransport>,
        window: EngineWindowId,
        profile: EngineProfileId,
        foreground: bool,
    ) -> EngineTabId {
        engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://a.test/".into(),
                    profile,
                    foreground,
                },
            )
            .unwrap()
    }

    fn key_of(engine: &DesktopEngine<FakeTransport>, tab: EngineTabId) -> String {
        engine.shared.state.lock().tab(tab).unwrap().key.clone()
    }

    fn navigate(host: &FakeHost, key: &str, data: Value) {
        send(
            host,
            "tab",
            json!({ "key": key, "name": "navigation", "data": data }),
        );
    }

    #[test]
    fn tabs_open_with_keys_and_follow_host_events() {
        let (engine, host, window, profile) = desktop();
        let events = engine.subscribe();
        let tab = open(&engine, window, profile, true);
        let key = key_of(&engine, tab);
        let (verb, args, native) = host.calls.lock()[0].clone();
        assert_eq!(verb, "tab.create");
        assert_eq!(
            args,
            json!({ "key": key, "url": "https://a.test/", "profile": "", "background": false })
        );
        assert_eq!(native, 0x5000);
        assert_eq!(engine.tab_info(tab).unwrap().tab_id, 77);
        navigate(
            &host,
            &key,
            json!({ "url": "https://a.test/", "title": "A", "canGoBack": false, "canGoForward": false, "isLoading": true, "committedUrl": "https://a.test/" }),
        );
        navigate(
            &host,
            &key,
            json!({ "url": "https://a.test/", "title": "A", "canGoBack": true, "canGoForward": false, "isLoading": false, "committedUrl": "https://a.test/" }),
        );
        send(
            &host,
            "tab",
            json!({ "key": "unknown", "name": "progress", "data": { "progress": 0.5 } }),
        );
        send(
            &host,
            "tab",
            json!({ "key": key, "name": "zoom", "data": { "zoom": 1.25 } }),
        );
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
        assert!(
            !drained
                .iter()
                .any(|e| matches!(e, EngineEvent::TabActivated { .. })),
            "a tab that was never shown isn't active"
        );
        assert!(drained.contains(&EngineEvent::LoadingChanged { tab, loading: true }));
        assert_eq!(
            drained
                .iter()
                .filter(|e| matches!(e, EngineEvent::DocumentCommitted { .. }))
                .count(),
            1
        );
        assert_eq!(
            engine.tab_info(tab).unwrap().committed_origin.as_deref(),
            Some("https://a.test")
        );
        assert!(drained.contains(&EngineEvent::NavigationStateChanged {
            tab,
            can_go_back: true,
            can_go_forward: false
        }));
        assert!(drained.contains(&EngineEvent::LoadingChanged {
            tab,
            loading: false
        }));
        assert_eq!(
            drained
                .iter()
                .filter(|e| matches!(e, EngineEvent::UrlChanged { .. }))
                .count(),
            1
        );
        assert_eq!(
            drained.last(),
            Some(&EngineEvent::ZoomChanged { tab, zoom: 1.25 })
        );
    }

    #[test]
    fn documents_follow_the_host_counter_or_the_origin() {
        let (engine, host, window, profile) = desktop();
        let tab = open(&engine, window, profile, true);
        let key = key_of(&engine, tab);
        let events = engine.subscribe();
        let committed = |events: &crate::events::EventSubscription| {
            events
                .drain()
                .into_iter()
                .filter(|e| matches!(e, EngineEvent::DocumentCommitted { .. }))
                .count()
        };
        navigate(
            &host,
            &key,
            json!({ "url": "https://a.test/one", "committedUrl": "https://user@A.test/one?q#x" }),
        );
        assert_eq!(committed(&events), 1);
        navigate(
            &host,
            &key,
            json!({ "url": "https://a.test/two", "committedUrl": "https://a.test/two" }),
        );
        assert_eq!(
            committed(&events),
            0,
            "a same-origin URL change proves nothing"
        );
        navigate(
            &host,
            &key,
            json!({ "url": "about:blank", "committedUrl": "about:blank" }),
        );
        assert_eq!(committed(&events), 0, "opaque origins aren't guessed");
        assert_eq!(
            engine.tab_info(tab).unwrap().committed_origin,
            None,
            "an opaque commit doesn't keep the last site's origin"
        );
        navigate(
            &host,
            &key,
            json!({ "url": "https://b.test/", "committedUrl": "https://b.test/", "documentCount": 4 }),
        );
        assert_eq!(committed(&events), 1);
        navigate(
            &host,
            &key,
            json!({ "url": "https://b.test/#top", "committedUrl": "https://b.test/#top", "documentCount": 4 }),
        );
        assert_eq!(committed(&events), 0);
        navigate(
            &host,
            &key,
            json!({ "url": "https://b.test/", "committedUrl": "https://b.test/", "documentCount": 5, "committedOrigin": "https://b.test" }),
        );
        assert_eq!(committed(&events), 1, "a reload is a new document");
        let info = engine.tab_info(tab).unwrap();
        assert_eq!(info.committed_document_count, 5);
        assert_eq!(info.committed_origin.as_deref(), Some("https://b.test"));
        navigate(
            &host,
            &key,
            json!({ "url": "https://c.test/", "committedUrl": "https://c.test/", "documentCount": 6, "committedOrigin": null }),
        );
        assert_eq!(committed(&events), 1);
        assert_eq!(
            engine.tab_info(tab).unwrap().committed_origin,
            None,
            "a sandboxed document keeps its opaque origin"
        );
        assert_eq!(
            origin_of("HTTPS://X.Test:8443/p"),
            Some("https://x.test:8443".into())
        );
        assert_eq!(origin_of("file:///etc/hosts"), None);
        assert_eq!(origin_of("1http://x/"), None);
        assert_eq!(origin_of("blob:https://x.test/1"), None);
    }

    #[test]
    fn commands_map_onto_host_verbs() {
        let (engine, host, window, profile) = desktop();
        let tab = open(&engine, window, profile, true);
        engine.load_url(tab, "https://b.test/", true).unwrap();
        engine.reload_ignoring_cache(tab).unwrap();
        engine.find(tab, "rust", false).unwrap();
        engine.show_devtools_panel(tab, "console").unwrap();
        assert!(matches!(
            engine.set_zoom(tab, 1.5),
            Err(EngineError::Unsupported(_))
        ));
        let calls = host.calls.lock().clone();
        let methods: Vec<_> = calls
            .iter()
            .skip(1)
            .map(|(_, args, _)| args["method"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(methods, ["loadUrl", "forceReload", "find", "showDevTools"]);
        assert_eq!(calls[1].1["userInitiated"], json!(true));
        assert_eq!(calls[4].1["panel"], json!("console"));
        assert_eq!(engine.navigation_entries(tab).unwrap()[0].title, "A");
        assert_eq!(
            engine.security_info(tab).unwrap().level,
            SecurityLevel::Secure
        );
        assert_eq!(engine.discard(tab), Ok(true));
        assert_eq!(engine.sleep_if_hidden(tab, 5.0), Ok(vec![3, 4]));
        assert_eq!(
            block_on(engine.evaluate_js(tab, "1+1")),
            Ok(Some(json!({ "n": 2 })))
        );
        assert!(matches!(
            block_on(engine.devtools_call(tab, "Page.reload", None, Duration::from_secs(1))),
            Err(EngineError::Unsupported(_))
        ));
        assert_eq!(engine.chromium_version().unwrap(), "149.0.1.2");
    }

    #[test]
    fn activation_reuses_the_last_page_frame() {
        let (engine, host, window, profile) = desktop();
        let tab = open(&engine, window, profile, true);
        let key = key_of(&engine, tab);
        assert!(matches!(
            engine.activate_tab(window, tab),
            Err(EngineError::BadArgument(_))
        ));
        let events = engine.subscribe();
        let frame = Rect::new(10.0, 20.0, 800.0, 600.0);
        engine.show_tab(tab, Some(frame)).unwrap();
        assert_eq!(
            events.drain(),
            vec![EngineEvent::TabActivated { window, tab }]
        );
        engine.show_tab(tab, Some(frame)).unwrap();
        engine.activate_tab(window, tab).unwrap();
        assert!(
            events.drain().is_empty(),
            "showing the shown tab again changes nothing"
        );
        let last = host.calls.lock().last().cloned().unwrap();
        assert_eq!(last.0, "tab.show");
        assert_eq!(
            last.1,
            json!({ "key": key, "visible": true, "x": 10.0, "y": 20.0, "width": 800.0, "height": 600.0 })
        );
        engine.note_shown(tab, false).unwrap();
        engine.activate_tab(window, tab).unwrap();
        assert_eq!(
            events.drain(),
            vec![EngineEvent::TabActivated { window, tab }]
        );
        engine.note_shown(tab, false).unwrap();
        host.refuse.lock().push("tab.show".into());
        assert!(engine.activate_tab(window, tab).is_err());
        assert!(engine.show_tab(tab, Some(frame)).is_err());
        assert!(events.drain().is_empty());
    }

    #[test]
    fn closing_while_opening_closes_once_the_host_answers() {
        let (engine, host, window, profile) = desktop();
        *host.defer.lock() = true;
        let events = engine.subscribe();
        let tab = open(&engine, window, profile, true);
        assert!(events.drain().is_empty());
        assert!(engine.load_url(tab, "https://b.test/", true).is_err());
        engine
            .show_tab(tab, Some(Rect::new(0.0, 0.0, 100.0, 100.0)))
            .unwrap();
        engine.close(tab).unwrap();
        let done = host.deferred.lock().pop().unwrap();
        done(Ok(json!({ "tab": 9 })));
        assert_eq!(events.drain(), vec![EngineEvent::TabWillClose { tab }]);
        assert_eq!(host.calls.lock().last().unwrap().0, "tab.close");
        assert_eq!(engine.tab_info(tab), Err(EngineError::UnknownTab(tab)));
    }

    #[test]
    fn a_deferred_open_shows_its_frame_once_live() {
        let (engine, host, window, profile) = desktop();
        *host.defer.lock() = true;
        let tab = open(&engine, window, profile, false);
        engine
            .show_tab(tab, Some(Rect::new(1.0, 2.0, 3.0, 4.0)))
            .unwrap();
        let events = engine.subscribe();
        let done = host.deferred.lock().pop().unwrap();
        done(Ok(json!({ "tab": 5 })));
        assert_eq!(
            events.drain(),
            vec![
                EngineEvent::TabInserted {
                    window,
                    tab,
                    opener: None,
                    disposition: "background".into()
                },
                EngineEvent::TabActivated { window, tab }
            ]
        );
        let last = host.calls.lock().last().cloned().unwrap();
        assert_eq!(last.0, "tab.show");
        assert_eq!(last.1["width"], json!(3.0));
        let hidden = open(&engine, window, profile, true);
        host.refuse.lock().push("tab.show".into());
        engine
            .show_tab(hidden, Some(Rect::new(1.0, 2.0, 3.0, 4.0)))
            .unwrap();
        let done = host.deferred.lock().pop().unwrap();
        done(Ok(json!({ "tab": 6 })));
        assert_eq!(
            events.drain(),
            vec![EngineEvent::TabInserted {
                window,
                tab: hidden,
                opener: None,
                disposition: "foreground".into()
            }],
            "a refused show never announces activation"
        );
    }

    #[test]
    fn a_refused_tab_is_taken_back() {
        let (engine, host, window, profile) = desktop();
        host.refuse.lock().push("tab.create".into());
        let events = engine.subscribe();
        let tab = open(&engine, window, profile, false);
        let key = key_of_closed(&host);
        assert_eq!(events.drain(), vec![EngineEvent::TabWillClose { tab }]);
        assert_eq!(engine.tab_info(tab), Err(EngineError::UnknownTab(tab)));
        let (verb, args, native) = host.calls.lock().last().cloned().unwrap();
        assert_eq!(verb, "tab.close", "the host lets go of anything it bound");
        assert_eq!(args, json!({ "key": key }));
        assert_eq!(native, 0x5000);
    }

    fn key_of_closed(host: &FakeHost) -> String {
        host.calls
            .lock()
            .iter()
            .rev()
            .find(|(verb, _, _)| verb == "tab.create")
            .and_then(|(_, args, _)| args["key"].as_str().map(str::to_owned))
            .unwrap()
    }

    #[test]
    fn keys_never_repeat_across_engines() {
        let (first, first_host, window, profile) = desktop();
        let one = open(&first, window, profile, true);
        let first_key = key_of(&first, one);
        let events = first.subscribe();
        drop(first);
        assert!(events.is_finished(), "dropping the engine ends its stream");
        let (second, _, window, profile) = desktop();
        let two = open(&second, window, profile, true);
        assert_eq!(one.get(), two.get());
        assert_ne!(first_key, key_of(&second, two));
        let calls = first_host.calls.lock().clone();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].0, "tab.close");
        assert_eq!(calls[1].1, json!({ "key": first_key }));
    }

    #[test]
    fn teardown_closes_live_and_late_tabs() {
        let (engine, host, window, profile) = desktop();
        let live = open(&engine, window, profile, true);
        let live_key = key_of(&engine, live);
        *host.defer.lock() = true;
        let late = open(&engine, window, profile, true);
        let late_key = key_of(&engine, late);
        send(
            &host,
            "tab.opened",
            json!({ "adopt": "offered:20", "url": "x", "profile": "" }),
        );
        let adopted = engine.adopt_offer(window, "offered:20").unwrap();
        let adopted_key = key_of(&engine, adopted);
        drop(engine);
        let closed = |host: &FakeHost| {
            host.calls
                .lock()
                .iter()
                .filter(|(verb, _, _)| verb == "tab.close")
                .map(|(_, args, _)| args["key"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        let mut first = closed(&host);
        first.sort();
        let mut expected = vec![live_key, late_key.clone(), adopted_key.clone()];
        expected.sort();
        assert_eq!(first, expected);
        let mut deferred = std::mem::take(&mut *host.deferred.lock());
        let adopt_done = deferred.pop().unwrap();
        let late_done = deferred.pop().unwrap();
        late_done(Ok(json!({ "tab": 3 })));
        assert_eq!(
            closed(&host).last(),
            Some(&late_key),
            "a tab the host finished opening after teardown is closed again"
        );
        adopt_done(Err(EngineError::failed("the tab could not move")));
        let calls = host.calls.lock().clone();
        assert_eq!(calls[calls.len() - 2].1, json!({ "key": adopted_key }));
        assert_eq!(calls[calls.len() - 1].0, "tab.discard");
    }

    #[test]
    fn an_open_landing_during_teardown_is_closed_again() {
        let (engine, host, window, profile) = desktop();
        *host.defer.lock() = true;
        let opening = open(&engine, window, profile, true);
        let key = key_of(&engine, opening);
        *host.finish_on_close.lock() = true;
        drop(engine);
        let closes = host
            .calls
            .lock()
            .iter()
            .filter(|(verb, args, _)| verb == "tab.close" && args["key"] == json!(key))
            .count();
        assert_eq!(
            closes, 2,
            "once by teardown, once when the late open answered"
        );
    }

    #[test]
    fn an_opening_tab_cannot_take_the_window_back() {
        let (engine, host, window, profile) = desktop();
        let frame = Rect::new(0.0, 0.0, 10.0, 10.0);
        let picked = open(&engine, window, profile, true);
        engine.show_tab(picked, Some(frame)).unwrap();
        *host.defer.lock() = true;
        let late = open(&engine, window, profile, true);
        let late_key = key_of(&engine, late);
        engine.show_tab(late, Some(frame)).unwrap();
        engine.activate_tab(window, picked).unwrap();
        let events = engine.subscribe();
        let done = host.deferred.lock().pop().unwrap();
        done(Ok(json!({ "tab": 5 })));
        assert_eq!(
            events.drain(),
            vec![EngineEvent::TabInserted {
                window,
                tab: late,
                opener: None,
                disposition: "foreground".into()
            }]
        );
        assert!(
            !host
                .calls
                .lock()
                .iter()
                .any(|(verb, args, _)| verb == "tab.show" && args["key"] == json!(late_key)),
            "the user picked another tab after this one asked to be shown"
        );
        assert_eq!(
            engine.shared.state.lock().windows[&window].shown,
            Some(picked)
        );
        let hidden = open(&engine, window, profile, true);
        let hidden_key = key_of(&engine, hidden);
        engine.show_tab(hidden, Some(frame)).unwrap();
        engine.note_shown(hidden, false).unwrap();
        let done = host.deferred.lock().pop().unwrap();
        done(Ok(json!({ "tab": 6 })));
        assert!(
            !host
                .calls
                .lock()
                .iter()
                .any(|(verb, args, _)| verb == "tab.show" && args["key"] == json!(hidden_key)),
            "hiding an opening tab cancels its queued show"
        );
    }

    #[test]
    fn a_newer_visibility_request_wins_over_a_late_show() {
        let (engine, host, window, profile) = desktop();
        *host.defer.lock() = true;
        let tab = open(&engine, window, profile, true);
        engine
            .show_tab(tab, Some(Rect::new(0.0, 0.0, 10.0, 10.0)))
            .unwrap();
        let events = engine.subscribe();
        *host.defer_show.lock() = true;
        let done = host.deferred.lock().pop().unwrap();
        done(Ok(json!({ "tab": 8 })));
        let late_show = host.shows.lock().pop().expect("the deferred show went out");
        *host.defer_show.lock() = false;
        engine.note_shown(tab, false).unwrap();
        late_show(Ok(json!({ "ok": true })));
        assert_eq!(
            events.drain(),
            vec![EngineEvent::TabInserted {
                window,
                tab,
                opener: None,
                disposition: "foreground".into()
            }],
            "the hide came after the show was sent, so the late reply announces nothing"
        );
        let shared = engine.shared.clone();
        *host.defer.lock() = true;
        let other = open(&engine, window, profile, true);
        engine
            .show_tab(other, Some(Rect::new(0.0, 0.0, 10.0, 10.0)))
            .unwrap();
        let done = host.deferred.lock().pop().unwrap();
        let before = host.calls.lock().len();
        let Settled::Inserted { show: Some(show) } = shared.settle(other, Ok(json!({ "tab": 9 })))
        else {
            panic!("the open settles with its pending show");
        };
        drop(done);
        engine.note_shown(other, false).unwrap();
        assert!(!shared.still_wanted(other, show.request));
        assert_eq!(host.calls.lock().len(), before + 1);
    }

    #[test]
    fn closing_forgets_the_tab_and_tells_the_host() {
        let (engine, host, window, profile) = desktop();
        let tab = open(&engine, window, profile, true);
        let key = key_of(&engine, tab);
        let events = engine.subscribe();
        engine.close(tab).unwrap();
        assert_eq!(
            events.drain(),
            vec![
                EngineEvent::TabWillClose { tab },
                EngineEvent::TabRemoved { window, tab }
            ]
        );
        assert_eq!(host.calls.lock().last().unwrap().0, "tab.close");
        assert_eq!(engine.go_back(tab), Err(EngineError::UnknownTab(tab)));
        send(
            &host,
            "tab",
            json!({ "key": key, "name": "progress", "data": { "progress": 1 } }),
        );
        assert!(events.drain().is_empty());
        engine.close_window(window).unwrap();
        assert_eq!(
            engine.window_info(window),
            Err(EngineError::UnknownWindow(window))
        );
    }

    #[test]
    fn native_closes_and_offers_reach_the_app() {
        let (engine, host, window, profile) = desktop();
        let opener = open(&engine, window, profile, true);
        let events = engine.subscribe();
        send(
            &host,
            "tab",
            json!({ "key": key_of(&engine, opener), "name": "windowClose", "data": {} }),
        );
        assert_eq!(
            events.drain(),
            vec![
                EngineEvent::TabWillClose { tab: opener },
                EngineEvent::TabRemoved {
                    window,
                    tab: opener
                }
            ]
        );
        let source = open(&engine, window, profile, true);
        events.drain();
        send(
            &host,
            "tab.opened",
            json!({
                "adopt": "offered:12", "url": "https://popup.test/", "foreground": false, "window": true,
                "profile": "", "opener": key_of(&engine, source), "popup": { "x": 5, "y": 6, "width": 400, "height": 300 },
                "parent": "0", "fromClick": false
            }),
        );
        let offer = match events.drain().pop() {
            Some(EngineEvent::TabOffered { offer }) => offer,
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(offer.opener, Some(source));
        assert_eq!(offer.popup, Some(Rect::new(5.0, 6.0, 400.0, 300.0)));
        assert_eq!(
            engine.open_prompts(),
            vec![EngineEvent::TabOffered {
                offer: offer.clone()
            }]
        );
        let adopted = engine.adopt_offer(window, &offer.id).unwrap();
        let (verb, args, _) = host.calls.lock().last().cloned().unwrap();
        assert_eq!(verb, "tab.create");
        assert_eq!(
            args,
            json!({ "key": key_of(&engine, adopted), "adopt": "offered:12" })
        );
        let drained = events.drain();
        assert_eq!(
            drained,
            vec![EngineEvent::TabInserted {
                window,
                tab: adopted,
                opener: Some(source),
                disposition: "adopted".into()
            }],
            "adopting a background offer doesn't activate it"
        );
        assert!(engine.open_prompts().is_empty());
        assert!(engine.adopt_offer(window, &offer.id).is_err());
        send(
            &host,
            "tab.opened",
            json!({ "adopt": "offered:13", "url": "x", "profile": "" }),
        );
        engine.refuse_offer("offered:13").unwrap();
        assert_eq!(host.calls.lock().last().unwrap().0, "tab.discard");
        assert!(engine.refuse_offer("offered:13").is_err());
        send(
            &host,
            "tab.opened",
            json!({ "adopt": "offered:14", "url": "x", "profile": "" }),
        );
        host.refuse.lock().push("tab.create".into());
        let failed = engine.adopt_offer(window, "offered:14").unwrap();
        assert_eq!(
            engine.tab_info(failed),
            Err(EngineError::UnknownTab(failed))
        );
        let calls = host.calls.lock().clone();
        let (verb, args, _) = calls[calls.len() - 2].clone();
        assert_eq!(
            verb, "tab.close",
            "a failed adoption releases the native tab"
        );
        assert_eq!(args["key"], json!(key_of_closed(&host)));
        let (verb, args, _) = calls[calls.len() - 1].clone();
        assert_eq!(verb, "tab.discard", "and lets go of the offer");
        assert_eq!(args, json!({ "adopt": "offered:14" }));
    }

    #[test]
    fn engine_topics_unwrap_into_service_events() {
        let (engine, host, _, _) = desktop();
        let events = engine.subscribe();
        send(
            &host,
            "engine",
            json!({ "topic": "bookmarks.changed", "payload": { "profile": "Work" } }),
        );
        send(
            &host,
            "engine",
            json!({ "topic": "downloads.changed", "payload": { "download": { "id": "d1", "state": "complete" } } }),
        );
        send(&host, "engine", json!({ "nothing": true }));
        send(&host, "tabs.strips", json!({ "strips": [] }));
        let drained = events.drain();
        assert_eq!(drained.len(), 3);
        assert!(
            matches!(&drained[0], EngineEvent::Service(e) if e.topic == "bookmarks.changed" && e.profile.as_deref() == Some("Work"))
        );
        assert!(
            matches!(&drained[1], EngineEvent::Download(DownloadEvent::Changed { item, .. }) if item.id == "d1")
        );
        assert!(matches!(&drained[2], EngineEvent::Service(e) if e.topic == "tabs.strips"));
    }

    #[test]
    fn calls_from_another_thread_fail_cleanly() {
        let (engine, host, window, profile) = desktop();
        let tab = open(&engine, window, profile, true);
        let before = host.calls.lock().len();
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    assert_eq!(
                        engine.load_url(tab, "https://b.test/", true),
                        Err(EngineError::WrongThread)
                    );
                    assert_eq!(engine.close(tab), Err(EngineError::WrongThread));
                    assert_eq!(engine.close_window(window), Err(EngineError::WrongThread));
                    assert_eq!(
                        engine.open_tab(
                            window,
                            OpenTab {
                                url: "https://c.test/".into(),
                                profile,
                                foreground: false
                            }
                        ),
                        Err(EngineError::WrongThread)
                    );
                    assert_eq!(
                        block_on(engine.call_service("ac_tasks_list", "", "{}")),
                        Err(EngineError::WrongThread)
                    );
                    assert_eq!(
                        block_on(engine.evaluate_js(tab, "1")),
                        Err(EngineError::WrongThread)
                    );
                })
                .join()
                .unwrap();
        });
        assert_eq!(host.calls.lock().len(), before);
        assert!(engine.tab_info(tab).is_ok());
        assert!(engine.window_info(window).is_ok());
    }

    #[test]
    fn services_validate_before_the_transport() {
        let (engine, host, _, _) = desktop();
        assert_eq!(
            block_on(engine.call_service("ac_bookmarks_tree", "Work", "{}")),
            Ok(json!({ "ok": true }))
        );
        assert!(block_on(engine.call_service("../ac", "Work", "{}")).is_err());
        assert!(block_on(engine.call_service("ac_engine_set_event_sink", "Work", "{}")).is_err());
        assert!(block_on(engine.call_service("ac_x", "Work", "nope")).is_err());
        assert_eq!(host.services.lock().len(), 1);
        assert!(matches!(
            engine.create_window(Rect::default()),
            Err(EngineError::Unsupported(_))
        ));
        assert!(engine.attach_window(NativeWindowHandle::NULL).is_err());
        assert_eq!(
            engine
                .attach_window(NativeWindowHandle(0x5000 as *mut c_void))
                .unwrap()
                .get(),
            2
        );
    }

    static TABLE_CALLS: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
    static ATTACHING: Mutex<()> = Mutex::new(());
    static HELD_CALLS: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
    static HELD_OPENS: LazyLock<Mutex<Vec<(usize, AcEngineReply)>>> =
        LazyLock::new(|| Mutex::new(Vec::new()));

    unsafe extern "C" fn held_sink(_: Option<AcEngineEvent>, _: *mut c_void) {}

    unsafe extern "C" fn held_host(
        verb: *const c_char,
        args: *const c_char,
        window: u64,
        reply: AcEngineReply,
        context: *mut c_void,
    ) {
        let verb = text_of(verb).unwrap();
        HELD_CALLS
            .lock()
            .push(format!("{verb} {} {window}", text_of(args).unwrap()));
        if verb == "tab.create" {
            HELD_OPENS.lock().push((context as usize, reply));
            return;
        }
        let answer = CString::new("{\"ok\":true}").unwrap();
        unsafe { reply(context, answer.as_ptr()) };
    }

    const LEGACY_ENGINE: &str = r#"
#include <stdlib.h>
void ac_engine_set_event_sink(void *sink, void *context) { abort(); }
void ac_engine_call(const char *name, const char *profile, const char *args, void *reply, void *context) { abort(); }
"#;

    fn legacy_only_library() -> &'static EngineLibrary {
        let dir = std::env::temp_dir().join(format!("ardia-legacy-engine-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("legacy.c");
        let library = dir.join(if cfg!(target_os = "macos") {
            "liblegacy.dylib"
        } else {
            "liblegacy.so"
        });
        std::fs::write(&source, LEGACY_ENGINE).unwrap();
        let built = std::process::Command::new("cc")
            .args(["-shared", "-fPIC", "-o"])
            .arg(&library)
            .arg(&source)
            .status()
            .expect("a C compiler builds the stand-in engine");
        assert!(built.success());
        unsafe { EngineLibrary::open(&library) }.unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn a_services_only_engine_is_refused_before_its_sink_is_touched() {
        let library = legacy_only_library();
        assert!(library.dispatcher().is_some() && library.set_event_sink().is_some());
        match standalone_api_entry(library) {
            Err(EngineError::NotLoaded(problem)) => assert!(problem.contains(API_ENTRY_SYMBOL)),
            other => panic!(
                "a services-only engine was accepted: {:?}",
                other.map(|_| ())
            ),
        }
    }

    #[test]
    fn teardown_drains_unanswered_host_calls_and_closes_late_opens() {
        let _attached = ATTACHING.lock();
        let table = Box::leak(Box::new(ArdiaEngineApi {
            version: ARDIA_ENGINE_API_VERSION,
            size: std::mem::size_of::<ArdiaEngineApi>() as u32,
            set_event_sink: Some(held_sink),
            host_call: Some(held_host),
            engine_call: Some(table_engine),
            test_gate_refusal: None,
        }));
        let transport = unsafe { ApiTransport::new(table, EngineBackend::Linux) }.unwrap();
        let engine = DesktopEngine::new(transport).unwrap();
        let owner = engine.transport.instance;
        engine.run_with_args(&[]).unwrap();
        let window = engine
            .attach_window(NativeWindowHandle(0x91 as *mut c_void))
            .unwrap();
        let profile = engine.default_profile().unwrap();
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://late.test/".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        let key = engine.shared.state.lock().tab(tab).unwrap().key.clone();
        assert_eq!(abi::HOST_REPLIES.count(owner, false), 1);
        let transport = Arc::downgrade(&engine.transport);
        drop(engine);
        assert_eq!(abi::HOST_REPLIES.count(owner, false), 0);
        assert_eq!(abi::HOST_REPLIES.count(owner, true), 1);
        assert!(
            transport.upgrade().is_none(),
            "an unanswered open no longer keeps the transport alive"
        );
        let close = format!("tab.close {} 145", json!({ "key": key }));
        let closes = |calls: &[String]| calls.iter().filter(|c| **c == close).count();
        assert_eq!(
            closes(&HELD_CALLS.lock()),
            1,
            "teardown closes the key once"
        );
        let (context, reply) = HELD_OPENS.lock().pop().unwrap();
        let answer = CString::new("{\"tab\":9}").unwrap();
        unsafe { reply(context as *mut c_void, answer.as_ptr()) };
        assert_eq!(
            closes(&HELD_CALLS.lock()),
            2,
            "the open that landed after teardown is closed natively"
        );
        assert_eq!(abi::HOST_REPLIES.count(owner, true), 0);
        unsafe { reply(context as *mut c_void, answer.as_ptr()) };
        assert_eq!(closes(&HELD_CALLS.lock()), 2);
    }
    static TABLE_SINK: LazyLock<Mutex<Option<(AcEngineEvent, usize)>>> =
        LazyLock::new(|| Mutex::new(None));

    unsafe extern "C" fn table_sink(sink: Option<AcEngineEvent>, context: *mut c_void) {
        TABLE_CALLS.lock().push(format!("sink {}", sink.is_some()));
        *TABLE_SINK.lock() = sink.map(|sink| (sink, context as usize));
    }

    fn table_emit(topic: &str, json: &str, context: Option<usize>) {
        let (sink, installed) = TABLE_SINK.lock().unwrap();
        let topic = CString::new(topic).unwrap();
        let json = CString::new(json).unwrap();
        unsafe {
            sink(
                context.unwrap_or(installed) as *mut c_void,
                topic.as_ptr(),
                json.as_ptr(),
            )
        };
    }

    unsafe extern "C" fn table_host(
        verb: *const c_char,
        args: *const c_char,
        window: u64,
        reply: AcEngineReply,
        context: *mut c_void,
    ) {
        TABLE_CALLS.lock().push(format!(
            "host {} {} {window}",
            text_of(verb).unwrap(),
            text_of(args).unwrap()
        ));
        let answer = CString::new("{\"tab\":5}").unwrap();
        unsafe { reply(context, answer.as_ptr()) };
    }

    unsafe extern "C" fn table_engine(
        name: *const c_char,
        profile: *const c_char,
        _: *const c_char,
        reply: AcEngineReply,
        context: *mut c_void,
    ) {
        TABLE_CALLS.lock().push(format!(
            "engine {} {}",
            text_of(name).unwrap(),
            text_of(profile).unwrap()
        ));
        let answer = CString::new("{\"error\":\"unknown call\"}").unwrap();
        unsafe { reply(context, answer.as_ptr()) };
    }

    fn table(version: u32, size: u32, host_call: Option<HostCallFn>) -> &'static ArdiaEngineApi {
        Box::leak(Box::new(ArdiaEngineApi {
            version,
            size,
            set_event_sink: Some(table_sink),
            host_call,
            engine_call: Some(table_engine),
            test_gate_refusal: None,
        }))
    }

    #[test]
    fn api_tables_are_checked_attached_once_and_driven() {
        let _attached = ATTACHING.lock();
        let size = std::mem::size_of::<ArdiaEngineApi>() as u32;
        assert!(
            unsafe { ApiTransport::new(table(9, size, Some(table_host)), EngineBackend::Windows) }
                .is_err()
        );
        assert!(
            unsafe { ApiTransport::new(table(1, 8, Some(table_host)), EngineBackend::Windows) }
                .is_err()
        );
        assert!(
            unsafe { ApiTransport::new(table(1, size, None), EngineBackend::Windows) }.is_err()
        );
        assert!(unsafe { ApiTransport::new(std::ptr::null(), EngineBackend::Windows) }.is_err());
        #[repr(C, align(8))]
        struct ShortTable {
            version: u32,
            size: u32,
        }
        let short = Box::leak(Box::new(ShortTable {
            version: ARDIA_ENGINE_API_VERSION,
            size: 8,
        }));
        assert!(
            unsafe {
                ApiTransport::new(
                    (short as *const ShortTable).cast::<ArdiaEngineApi>(),
                    EngineBackend::Windows,
                )
            }
            .is_err(),
            "an older, shorter table is refused from its prefix alone"
        );
        let good = table(ARDIA_ENGINE_API_VERSION, size, Some(table_host));
        let transport = unsafe { ApiTransport::new(good, EngineBackend::Windows) }.unwrap();
        assert_eq!(transport.test_gate_refusal(), None);
        let engine = DesktopEngine::new(transport).unwrap();
        let second = unsafe { ApiTransport::new(good, EngineBackend::Windows) }.unwrap();
        assert!(matches!(
            DesktopEngine::new(second),
            Err(EngineError::AlreadyRunning)
        ));
        let events = engine.subscribe();
        engine.run_with_args(&[]).unwrap();
        let window = engine
            .attach_window(NativeWindowHandle(0x77 as *mut c_void))
            .unwrap();
        let profile = engine.default_profile().unwrap();
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: "https://t.test/".into(),
                    profile,
                    foreground: true,
                },
            )
            .unwrap();
        assert_eq!(engine.tab_info(tab).unwrap().tab_id, 5);
        assert_eq!(
            block_on(engine.call_service("ac_tasks_list", "", "{}")),
            Err(EngineError::MissingService("ac_tasks_list".into()))
        );
        events.drain();
        table_emit(
            "engine",
            "{\"topic\":\"history.changed\",\"payload\":{}}",
            None,
        );
        table_emit(
            "engine",
            "{\"topic\":\"history.changed\",\"payload\":{}}",
            Some(0),
        );
        table_emit(
            "engine",
            "{\"topic\":\"history.changed\",\"payload\":{}}",
            Some(0x1234),
        );
        let drained = events.drain();
        assert_eq!(drained.len(), 1);
        assert!(matches!(&drained[0], EngineEvent::Service(s) if s.topic == "history.changed"));
        let calls = TABLE_CALLS.lock().clone();
        assert_eq!(calls[0], "sink true");
        assert!(
            calls
                .iter()
                .any(|c| c.starts_with("host tab.create {") && c.ends_with(" 119"))
        );
        assert!(calls.contains(&"engine ac_tasks_list ".to_string()));
        let (stale_sink, stale_context) = TABLE_SINK.lock().unwrap();
        drop(engine);
        assert!(
            TABLE_SINK.lock().is_none(),
            "detaching clears the native sink"
        );
        assert_eq!(TABLE_CALLS.lock().last().unwrap(), "sink false");
        let third = unsafe { ApiTransport::new(good, EngineBackend::Windows) }.unwrap();
        let third = DesktopEngine::new(third).unwrap();
        let fresh = third.subscribe();
        let topic = CString::new("engine").unwrap();
        let json = CString::new("{\"topic\":\"history.changed\",\"payload\":{}}").unwrap();
        unsafe { stale_sink(stale_context as *mut c_void, topic.as_ptr(), json.as_ptr()) };
        assert!(
            fresh.drain().is_empty(),
            "a late event from the old attachment is dropped"
        );
        table_emit(
            "engine",
            "{\"topic\":\"history.changed\",\"payload\":{}}",
            None,
        );
        assert_eq!(fresh.drain().len(), 1);
    }
}
