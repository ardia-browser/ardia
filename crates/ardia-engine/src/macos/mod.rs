mod decode;
pub mod dialogs;
mod ffi;
pub mod menu;
pub mod platform;

use std::collections::HashMap;
use std::ffi::{CString, c_char, c_void};
use std::marker::PhantomData;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::{Value, json};
use zeroize::{Zeroize, Zeroizing};

use crate::BrowserEngine;
use crate::abi::{self, AcEngineCall, AcEngineDispatch, ServiceRoute, c_string, text_of};
use crate::commands::*;
use crate::error::{EngineError, EngineResult};
use crate::events::EventBus;
use crate::launch::LaunchOptions;
use crate::loader::{EngineLibrary, LoaderEnvironment, Platform, describe_attempts};
use crate::policy::{DefaultPolicy, HostPolicy, NewBrowserWindow};
use crate::reply::{Completion, CompletionStatus, Finally, PendingRequests, Reply};
use crate::services::{SecretValue, ServiceArgs, ServiceName};
use crate::types::*;

pub use decode::decode_bridge_event;
pub use hosted::{
    HostedWindowHooks, HostedWindowRoutes, SuperCall, hosted_hooks_installed,
    install_hosted_window_hooks, style_browser_window,
};

pub(crate) static REQUESTS: LazyLock<PendingRequests> = LazyLock::new(PendingRequests::new);

struct MacShared {
    bus: EventBus,
    policy: RwLock<Arc<dyn HostPolicy>>,
}

struct HostSlot {
    shared: RwLock<Option<Arc<MacShared>>>,
}

static HOST: HostSlot = HostSlot {
    shared: RwLock::new(None),
};
static ACTIVE: AtomicBool = AtomicBool::new(false);
static HOST_INSTALLED: AtomicBool = AtomicBool::new(false);

pub(crate) fn ensure_bridge_host() -> EngineResult<()> {
    if HOST_INSTALLED.load(Ordering::Acquire) {
        return Ok(());
    }
    let host = bridge_host();
    let status = unsafe { ffi::ardia_bridge_install(&host) };
    if status != ffi::OK {
        return Err(status_error(status, || {
            EngineError::failed("the bridge refused its host")
        }));
    }
    HOST_INSTALLED.store(true, Ordering::Release);
    Ok(())
}

impl HostSlot {
    fn current(&self) -> Option<Arc<MacShared>> {
        self.shared.read().clone()
    }

    fn context(&'static self) -> *mut c_void {
        self as *const Self as *mut c_void
    }
}

fn shielded<T>(fallback: T, body: impl FnOnce() -> T) -> T {
    catch_unwind(AssertUnwindSafe(body)).unwrap_or(fallback)
}

unsafe extern "C" fn host_event(_: *mut c_void, json: *const c_char) {
    shielded((), || {
        if let (Some(shared), Some(json)) = (HOST.current(), text_of(json))
            && let Some(event) = decode_bridge_event(&json)
        {
            shared.bus.publish(event);
        }
    })
}

fn key_event(question: &Value) -> Option<KeyEvent> {
    question
        .get("event")
        .and_then(|event| serde_json::from_value(event.clone()).ok())
}

fn answer_question(shared: &MacShared, question: &Value) -> Option<bool> {
    let policy = shared.policy.read().clone();
    let window = question
        .get("window")
        .and_then(Value::as_u64)
        .and_then(EngineWindowId::from_raw);
    let tab = question
        .get("tab")
        .and_then(Value::as_u64)
        .and_then(EngineTabId::from_raw);
    let payload = question.get("payload").cloned().unwrap_or(Value::Null);
    Some(match question.get("question")?.as_str()? {
        "listening" => shared.bus.has_subscribers(),
        "reservedKey" => {
            let modifiers = Modifiers(
                question
                    .get("modifiers")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as u32,
            );
            ["key", "unshiftedKey"]
                .iter()
                .filter_map(|field| question.get(*field).and_then(Value::as_str))
                .any(|key| {
                    !key.is_empty() && policy.is_reserved_key(&KeyChord::new(key, modifiers))
                })
        }
        "reservedKeyEvent" => policy.is_reserved_key(&key_event(question)?.chord()),
        "windowShouldClose" => policy.window_should_close(window?),
        "preHandleKey" => policy.pre_handle_key(window?, &key_event(question)?),
        "handleKey" => policy.handle_key(window?, &key_event(question)?),
        "extensionActionPopup" => {
            shared.bus.has_subscribers() && policy.takes_extension_popup(tab, &payload)
        }
        "extensionActionShortcut" => {
            shared.bus.has_subscribers() && policy.takes_extension_shortcut(tab, &payload)
        }
        "validateMenuItem" => policy.menu_item_enabled(
            question.get("command")?.as_str()?,
            question.get("arg").and_then(Value::as_str),
        ),
        _ => return None,
    })
}

unsafe extern "C" fn host_decide(_: *mut c_void, json: *const c_char) -> i32 {
    shielded(-1, || {
        let (Some(shared), Some(json)) = (HOST.current(), text_of(json)) else {
            return -1;
        };
        let Ok(question) = serde_json::from_str::<Value>(&json) else {
            return -1;
        };
        answer_question(&shared, &question).map_or(-1, i32::from)
    })
}

unsafe extern "C" fn host_new_window(_: *mut c_void, profile: u64, kind: *const c_char) -> u64 {
    shielded(0, || {
        let Some(shared) = HOST.current() else {
            return 0;
        };
        let kind = NewBrowserKind::parse(&text_of(kind).unwrap_or_default());
        let policy = shared.policy.read().clone();
        match policy.new_browser_window(EngineProfileId::from_raw(profile), kind) {
            NewBrowserWindow::Refuse => 0,
            NewBrowserWindow::Create => ffi::CREATE_WINDOW,
            NewBrowserWindow::Use(window) => window.get(),
        }
    })
}

fn answer_json(shared: &MacShared, question: &Value) -> Option<Value> {
    let policy = shared.policy.read().clone();
    let tab = question
        .get("tab")
        .and_then(Value::as_u64)
        .and_then(EngineTabId::from_raw)?;
    match question.get("question")?.as_str()? {
        "contextMenuItems" => {
            let value = question
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let target = match question.get("on").and_then(Value::as_str)? {
                "selection" => ContextMenuTarget::Selection(value),
                "page" => ContextMenuTarget::Page(value),
                _ => return None,
            };
            serde_json::to_value(policy.context_menu_items(tab, &target)).ok()
        }
        "runContextMenu" => {
            policy.run_context_menu(tab, question.get("menu").unwrap_or(&Value::Null))
        }
        _ => None,
    }
}

unsafe extern "C" fn host_answer(_: *mut c_void, json: *const c_char) -> *mut c_char {
    shielded(std::ptr::null_mut(), || {
        let (Some(shared), Some(json)) = (HOST.current(), text_of(json)) else {
            return std::ptr::null_mut();
        };
        let Ok(question) = serde_json::from_str::<Value>(&json) else {
            return std::ptr::null_mut();
        };
        let answer = answer_json(&shared, &question).unwrap_or(Value::Null);
        CString::new(answer.to_string()).map_or(std::ptr::null_mut(), CString::into_raw)
    })
}

unsafe extern "C" fn host_release_answer(_: *mut c_void, answer: *mut c_char) {
    if !answer.is_null() {
        drop(unsafe { CString::from_raw(answer) });
    }
}

unsafe extern "C" fn host_complete(
    _: *mut c_void,
    request: u64,
    status: i32,
    json: *const c_char,
    bytes: *const u8,
    length: usize,
) {
    shielded((), || {
        let bytes = (!bytes.is_null())
            .then(|| unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec());
        REQUESTS.complete(
            request,
            Completion {
                status: CompletionStatus::from_raw(status),
                json: text_of(json),
                bytes,
            },
        );
    })
}

fn bridge_host() -> ffi::BridgeHost {
    ffi::BridgeHost {
        size: std::mem::size_of::<ffi::BridgeHost>() as u32,
        context: HOST.context(),
        event: host_event,
        decide: host_decide,
        new_window: host_new_window,
        answer: host_answer,
        release_answer: host_release_answer,
        complete: host_complete,
    }
}

pub(crate) fn take_text(text: *mut c_char) -> Option<String> {
    if text.is_null() {
        return None;
    }
    let copied = text_of(text);
    unsafe { ffi::ardia_bridge_free(text) };
    copied
}

pub(crate) fn status_error(status: ffi::Status, gone: impl FnOnce() -> EngineError) -> EngineError {
    match status {
        ffi::NOT_LOADED => EngineError::NotLoaded("the ArdiaCore classes aren't loaded".into()),
        ffi::NOT_STARTED => EngineError::NotStarted,
        ffi::WRONG_THREAD => EngineError::WrongThread,
        ffi::UNKNOWN_WINDOW | ffi::UNKNOWN_TAB | ffi::UNKNOWN_PROFILE => gone(),
        ffi::UNSUPPORTED => EngineError::Unsupported("do that with this engine build"),
        ffi::BAD_ARGUMENT => EngineError::bad_argument("the engine refused those arguments"),
        ffi::ALREADY_RUNNING => EngineError::AlreadyRunning,
        ffi::NO_HOST => EngineError::NotLoaded("the engine bridge has no host".into()),
        ffi::FAILED => EngineError::failed("the engine call failed"),
        other => EngineError::failed(format!("the engine bridge answered {other}")),
    }
}

fn unwrap_value(text: Option<String>) -> EngineResult<Value> {
    let Some(text) = text else {
        return Ok(Value::Null);
    };
    let wrapped: Value =
        serde_json::from_str(&text).map_err(|e| EngineError::BadReply(e.to_string()))?;
    Ok(wrapped.get("value").cloned().unwrap_or(Value::Null))
}

pub(crate) fn call_json(
    call: impl FnOnce(*const c_char, *mut *mut c_char) -> ffi::Status,
    request: &impl Serialize,
    secret: bool,
    gone: impl FnOnce() -> EngineError,
) -> EngineResult<Value> {
    let mut text =
        serde_json::to_string(request).map_err(|e| EngineError::bad_argument(e.to_string()))?;
    let encoded = c_string(&text, "the request");
    if secret {
        text.zeroize();
    }
    let encoded = encoded?;
    let mut out: *mut c_char = std::ptr::null_mut();
    let status = call(encoded.as_ptr(), &mut out);
    if secret {
        encoded.into_bytes_with_nul().zeroize();
    }
    let answer = take_text(out);
    if status != ffi::OK {
        return Err(status_error(status, gone));
    }
    unwrap_value(answer)
}

pub(crate) fn submit_async<T: Send + 'static>(
    submit: impl FnOnce(*const c_char, u64) -> ffi::Status,
    request: &impl Serialize,
    decode: impl FnOnce(Completion) -> EngineResult<T> + Send + 'static,
    gone: impl FnOnce() -> EngineError,
) -> Reply<T> {
    let text = match serde_json::to_string(request) {
        Ok(text) => text,
        Err(error) => return Reply::err(EngineError::bad_argument(error.to_string())),
    };
    let encoded = match c_string(&text, "the request") {
        Ok(encoded) => encoded,
        Err(error) => return Reply::err(error),
    };
    let (id, reply) = REQUESTS.register_reply(decode);
    let status = submit(encoded.as_ptr(), id);
    if status != ffi::OK {
        REQUESTS.withdraw(id);
        return Reply::err(status_error(status, gone));
    }
    reply
}

fn payload(completion: Completion) -> EngineResult<Value> {
    completion.into_json()
}

fn field<T: serde::de::DeserializeOwned>(value: &Value, name: &str) -> EngineResult<T> {
    serde_json::from_value(value.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|e| EngineError::BadReply(format!("{name}: {e}")))
}

fn typed<T: serde::de::DeserializeOwned>(value: Value) -> EngineResult<T> {
    serde_json::from_value(value).map_err(|e| EngineError::BadReply(e.to_string()))
}

fn tab_id(value: Value) -> EngineResult<Option<EngineTabId>> {
    Ok(value.as_u64().and_then(EngineTabId::from_raw))
}

pub fn is_main_thread() -> bool {
    unsafe { ffi::ardia_bridge_is_main_thread() }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(default)]
pub struct ClassCheck {
    pub missing: Vec<String>,
    pub foreign: Vec<String>,
}

impl ClassCheck {
    pub fn is_clean(&self) -> bool {
        self.missing.is_empty() && self.foreign.is_empty()
    }
}

pub fn class_check(library: Option<&EngineLibrary>) -> ClassCheck {
    let image = library
        .and_then(|library| CString::new(library.path().as_os_str().as_encoded_bytes()).ok());
    take_text(unsafe {
        ffi::ardia_bridge_check_classes(
            image
                .as_ref()
                .map_or(std::ptr::null(), |path| path.as_ptr()),
        )
    })
    .and_then(|text| serde_json::from_str(&text).ok())
    .unwrap_or_default()
}

pub fn missing_classes() -> Vec<String> {
    class_check(None).missing
}

fn preflight(library: &'static EngineLibrary) -> Result<(), String> {
    if library.set_event_sink().is_none() {
        return Err(format!("it has no {}", abi::SET_EVENT_SINK_SYMBOL));
    }
    let check = class_check(Some(library));
    if !check.missing.is_empty() {
        return Err(format!("it doesn't define {}", check.missing.join(", ")));
    }
    if !check.foreign.is_empty() {
        return Err(format!(
            "{} come from another image",
            check.foreign.join(", ")
        ));
    }
    Ok(())
}

#[allow(clippy::missing_safety_doc)]
pub unsafe fn retain_view(view: *mut c_void) -> Option<NativeView> {
    if view.is_null() {
        return None;
    }
    unsafe { ffi::ardia_bridge_retain(view) };
    Some(unsafe { NativeView::adopt_retained(NativeViewHandle(view), ownership()) })
}

#[allow(clippy::missing_safety_doc)]
pub unsafe fn retain_window(window: *mut c_void) -> Option<NativeWindow> {
    if window.is_null() {
        return None;
    }
    unsafe { ffi::ardia_bridge_retain(window) };
    Some(unsafe { NativeWindow::adopt_retained(NativeWindowHandle(window), ownership()) })
}

fn validate_profile_folder(name: &str) -> EngineResult<()> {
    let bad = name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']);
    if bad {
        Err(EngineError::bad_argument(
            "a profile is a folder name inside the data folder",
        ))
    } else {
        Ok(())
    }
}

pub struct MacEngine {
    shared: Arc<MacShared>,
    library: &'static EngineLibrary,
    dispatch: Option<AcEngineDispatch>,
    services: Mutex<HashMap<ServiceName, Option<AcEngineCall>>>,
    _main_thread_only: PhantomData<*const ()>,
}

impl std::fmt::Debug for MacEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MacEngine")
            .field("framework", &self.library.path())
            .field("dispatcher", &self.dispatch.is_some())
            .finish()
    }
}

impl MacEngine {
    #[allow(clippy::missing_safety_doc)]
    pub unsafe fn load() -> EngineResult<Self> {
        if !is_main_thread() {
            return Err(EngineError::WrongThread);
        }
        let library = unsafe {
            EngineLibrary::find_with(
                Platform::Mac,
                &LoaderEnvironment::current(Platform::Mac),
                preflight,
            )
        }
        .map_err(|attempts| EngineError::NotLoaded(describe_attempts(&attempts)))?;
        unsafe { Self::with_library(library) }
    }

    #[allow(clippy::missing_safety_doc)]
    pub unsafe fn with_library(library: &'static EngineLibrary) -> EngineResult<Self> {
        unsafe { Self::with_library_and_bus(library, EventBus::new()) }
    }

    #[allow(clippy::missing_safety_doc)]
    pub unsafe fn with_library_and_bus(
        library: &'static EngineLibrary,
        bus: EventBus,
    ) -> EngineResult<Self> {
        if !is_main_thread() {
            return Err(EngineError::WrongThread);
        }
        preflight(library).map_err(|problem| {
            EngineError::NotLoaded(format!("{}: {problem}", library.path().display()))
        })?;
        let set_sink = library.set_event_sink().expect("checked by the preflight");
        ensure_bridge_host()?;
        platform::install_background_guard_if_requested()?;
        if ACTIVE.swap(true, Ordering::AcqRel) {
            return Err(EngineError::AlreadyRunning);
        }
        let shared = Arc::new(MacShared {
            bus,
            policy: RwLock::new(Arc::new(DefaultPolicy::new())),
        });
        *HOST.shared.write() = Some(shared.clone());
        abi::install_service_sink(set_sink, shared.bus.clone());
        let engine = Self {
            shared,
            library,
            dispatch: library.dispatcher(),
            services: Mutex::new(HashMap::new()),
            _main_thread_only: PhantomData,
        };
        engine.set_page_script(Some(crate::PAGE_SCRIPT))?;
        Ok(engine)
    }

    pub fn framework_path(&self) -> &Path {
        self.library.path()
    }

    pub fn has_dispatcher(&self) -> bool {
        self.dispatch.is_some()
    }

    pub fn launch(&self, options: &LaunchOptions) -> EngineResult<i32> {
        if options.background {
            platform::install_background_guard()?;
        }
        self.run_with_args(&options.to_args())
    }

    pub fn resolves_service(&self, name: &str) -> bool {
        ServiceName::new(name).is_ok_and(|name| {
            name.is_registered()
                && (self.dispatch.is_some() || self.direct_service(&name).is_some())
        })
    }

    fn direct_service(&self, name: &ServiceName) -> Option<AcEngineCall> {
        *self
            .services
            .lock()
            .entry(name.clone())
            .or_insert_with(|| self.library.service(name))
    }

    fn route(&self, name: &ServiceName) -> EngineResult<ServiceRoute> {
        if let Some(dispatch) = self.dispatch {
            return Ok(ServiceRoute::Dispatch(dispatch));
        }
        self.direct_service(name)
            .map(ServiceRoute::Direct)
            .ok_or_else(|| EngineError::MissingService(name.as_str().to_owned()))
    }

    fn engine_call(&self, request: &impl Serialize) -> EngineResult<Value> {
        call_json(
            |json, out| unsafe { ffi::ardia_bridge_engine_call(json, out) },
            request,
            false,
            || EngineError::NotStarted,
        )
    }

    fn engine_async<T: Send + 'static>(
        &self,
        request: &impl Serialize,
        decode: impl FnOnce(Completion) -> EngineResult<T> + Send + 'static,
    ) -> Reply<T> {
        submit_async(
            |json, id| unsafe { ffi::ardia_bridge_engine_async(json, id) },
            request,
            decode,
            || EngineError::NotStarted,
        )
    }

    fn profile_call(
        &self,
        profile: EngineProfileId,
        request: &impl Serialize,
    ) -> EngineResult<Value> {
        call_json(
            |json, out| unsafe { ffi::ardia_bridge_profile_call(profile.get(), json, out) },
            request,
            false,
            || EngineError::UnknownProfile(profile),
        )
    }

    fn profile_async<T: Send + 'static>(
        &self,
        profile: EngineProfileId,
        request: &impl Serialize,
        decode: impl FnOnce(Completion) -> EngineResult<T> + Send + 'static,
    ) -> Reply<T> {
        submit_async(
            |json, id| unsafe { ffi::ardia_bridge_profile_async(profile.get(), json, id) },
            request,
            decode,
            || EngineError::UnknownProfile(profile),
        )
    }

    fn window_call(&self, window: EngineWindowId, request: &impl Serialize) -> EngineResult<Value> {
        call_json(
            |json, out| unsafe { ffi::ardia_bridge_window_call(window.get(), json, out) },
            request,
            false,
            || EngineError::UnknownWindow(window),
        )
    }

    fn tab_call(
        &self,
        tab: EngineTabId,
        request: &impl Serialize,
        secret: bool,
    ) -> EngineResult<Value> {
        call_json(
            |json, out| unsafe { ffi::ardia_bridge_tab_call(tab.get(), json, out) },
            request,
            secret,
            || EngineError::UnknownTab(tab),
        )
    }

    fn tab_async<T: Send + 'static>(
        &self,
        tab: EngineTabId,
        request: &impl Serialize,
        decode: impl FnOnce(Completion) -> EngineResult<T> + Send + 'static,
    ) -> Reply<T> {
        submit_async(
            |json, id| unsafe { ffi::ardia_bridge_tab_async(tab.get(), json, id) },
            request,
            decode,
            || EngineError::UnknownTab(tab),
        )
    }

    fn retained_object(
        status: ffi::Status,
        object: *mut c_void,
        gone: impl FnOnce() -> EngineError,
    ) -> EngineResult<Option<*mut c_void>> {
        if status != ffi::OK {
            return Err(status_error(status, gone));
        }
        Ok((!object.is_null()).then_some(object))
    }

    fn require_main(&self) -> EngineResult<()> {
        if is_main_thread() {
            Ok(())
        } else {
            Err(EngineError::WrongThread)
        }
    }

    fn require_started(&self) -> EngineResult<()> {
        if self.is_started() {
            Ok(())
        } else {
            Err(EngineError::NotStarted)
        }
    }

    fn resolve_password(
        &self,
        tab: EngineTabId,
        action: PasswordPromptAction,
        username: Option<&str>,
        password: Option<&str>,
    ) -> EngineResult<()> {
        let action =
            serde_json::to_value(action).map_err(|e| EngineError::bad_argument(e.to_string()))?;
        let action = c_string(action.as_str().unwrap_or_default(), "the prompt action")?;
        let username = username
            .map(|name| c_string(name, "the username"))
            .transpose()?;
        let secret: Zeroizing<Vec<u8>> =
            Zeroizing::new(password.map(|p| p.as_bytes().to_vec()).unwrap_or_default());
        if secret.contains(&0) {
            return Err(EngineError::bad_argument("the password holds a NUL byte"));
        }
        let status = unsafe {
            ffi::ardia_bridge_tab_password(
                tab.get(),
                action.as_ptr(),
                username
                    .as_ref()
                    .map_or(std::ptr::null(), |name| name.as_ptr()),
                if password.is_some() {
                    secret.as_ptr()
                } else {
                    std::ptr::null()
                },
                secret.len(),
            )
        };
        if status == ffi::OK {
            Ok(())
        } else {
            Err(status_error(status, || EngineError::UnknownTab(tab)))
        }
    }
}

pub(crate) fn ownership() -> ObjectOwnership {
    ObjectOwnership {
        retain: ffi::ardia_bridge_retain,
        release: ffi::ardia_bridge_release,
    }
}

impl Drop for MacEngine {
    fn drop(&mut self) {
        tear_down(&self.shared.bus, &REQUESTS, abi::service_replies());
    }
}

fn tear_down(bus: &EventBus, requests: &PendingRequests, services: &PendingRequests) {
    let _inactive = Finally::new(|| ACTIVE.store(false, Ordering::Release));
    let _detached = Finally::new(|| {
        abi::SERVICE_SINK.detach();
        *HOST.shared.write() = None;
        bus.close();
    });
    let mut released = 0;
    if unsafe { ffi::ardia_bridge_release_confirms(false, &mut released) } == ffi::OK
        && released > 0
    {
        log::info!("kept {released} windows open that were waiting on a download answer");
    }
    let _services = Finally::new(|| {
        services.cancel_all();
    });
    requests.cancel_all();
}

impl BrowserEngine for MacEngine {
    fn backend(&self) -> EngineBackend {
        EngineBackend::Mac
    }

    fn events(&self) -> &EventBus {
        &self.shared.bus
    }

    fn set_policy(&self, policy: Arc<dyn HostPolicy>) {
        *self.shared.policy.write() = policy;
    }

    fn run_with_args(&self, args: &[String]) -> EngineResult<i32> {
        self.require_main()?;
        if args.is_empty() {
            return Err(EngineError::bad_argument(
                "the engine needs at least the program name",
            ));
        }
        let strings: Vec<CString> = args
            .iter()
            .map(|arg| c_string(arg, "an engine switch"))
            .collect::<EngineResult<_>>()?;
        let strings: &'static [CString] = Box::leak(strings.into_boxed_slice());
        let pointers: &'static [*const c_char] = Box::leak(
            strings
                .iter()
                .map(|s| s.as_ptr())
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        );
        let count = i32::try_from(pointers.len())
            .map_err(|_| EngineError::bad_argument("too many engine switches"))?;
        let mut exit_code = 0;
        let status = unsafe { ffi::ardia_bridge_run(count, pointers.as_ptr(), &mut exit_code) };
        if status != ffi::OK {
            return Err(status_error(status, || EngineError::NotStarted));
        }
        Ok(exit_code)
    }

    fn is_started(&self) -> bool {
        unsafe { ffi::ardia_bridge_engine_started() }
    }

    fn quit(&self) -> EngineResult<()> {
        self.engine_call(&json!({ "op": "quit" })).map(|_| ())
    }

    fn query(&self, query: EngineQuery) -> EngineResult<Value> {
        self.engine_call(&query)
    }

    fn set_page_script(&self, script: Option<&str>) -> EngineResult<()> {
        self.engine_call(&json!({ "op": "setPageScript", "script": script }))
            .map(|_| ())
    }

    fn global(&self, command: GlobalCommand) -> EngineResult<()> {
        command.validate()?;
        self.engine_call(&command)?;
        if let Some(prompt) = command.settles() {
            self.shared.bus.settle_prompt(&prompt);
        }
        Ok(())
    }

    fn begin_tracing(&self) -> Reply<bool> {
        self.engine_async(&json!({ "op": "beginTracing" }), |c| {
            field(&payload(c)?, "started")
        })
    }

    fn end_tracing(&self, keep: bool) -> Reply<Option<String>> {
        self.engine_async(&json!({ "op": "endTracing", "keep": keep }), |c| {
            field(&payload(c)?, "path")
        })
    }

    fn default_profile(&self) -> EngineResult<EngineProfileId> {
        let value = self.engine_call(&json!({ "op": "defaultProfile" }))?;
        value
            .as_u64()
            .and_then(EngineProfileId::from_raw)
            .ok_or(EngineError::NotStarted)
    }

    fn load_profile(&self, directory_name: &str) -> Reply<EngineProfileId> {
        if let Err(error) = validate_profile_folder(directory_name) {
            return Reply::err(error);
        }
        self.engine_async(
            &json!({ "op": "loadProfile", "directory": directory_name }),
            |c| {
                field::<u64>(&payload(c)?, "profile").and_then(|raw| {
                    EngineProfileId::from_raw(raw).ok_or(EngineError::BadReply("no profile".into()))
                })
            },
        )
    }

    fn off_the_record_profile(&self, profile: EngineProfileId) -> Reply<EngineProfileId> {
        self.profile_async(profile, &json!({ "op": "offTheRecord" }), |c| {
            field::<u64>(&payload(c)?, "profile").and_then(|raw| {
                EngineProfileId::from_raw(raw).ok_or(EngineError::BadReply("no profile".into()))
            })
        })
    }

    fn delete_profile(&self, profile: EngineProfileId) -> Reply<bool> {
        self.profile_async(profile, &json!({ "op": "delete" }), |c| {
            field(&payload(c)?, "deleted")
        })
    }

    fn profile_info(&self, profile: EngineProfileId) -> EngineResult<ProfileInfo> {
        typed(self.profile_call(profile, &json!({ "op": "info" }))?)
    }

    fn profile_command(
        &self,
        profile: EngineProfileId,
        command: ProfileCommand,
    ) -> EngineResult<()> {
        self.profile_call(profile, &command).map(|_| ())
    }

    fn load_component_extension(
        &self,
        profile: EngineProfileId,
        path: &str,
    ) -> EngineResult<Option<String>> {
        typed(self.profile_call(
            profile,
            &json!({ "op": "loadComponentExtension", "path": path }),
        )?)
    }

    fn sleep_idle_profile(
        &self,
        profile: EngineProfileId,
        hosted_tabs: &[EngineTabId],
    ) -> EngineResult<Option<String>> {
        typed(self.profile_call(
            profile,
            &json!({ "op": "sleepIdleProfile", "tabs": hosted_tabs }),
        )?)
    }

    fn unload_idle_profile(&self, profile: EngineProfileId) -> EngineResult<String> {
        typed(self.profile_call(profile, &json!({ "op": "unloadIdleProfile" }))?)
    }

    fn fetch_icon(
        &self,
        profile: EngineProfileId,
        url: &str,
        max_bytes: usize,
    ) -> Reply<Option<Vec<u8>>> {
        self.profile_async(
            profile,
            &json!({ "op": "fetchIcon", "url": url, "maxBytes": max_bytes }),
            |completion| {
                let bytes = completion.bytes.clone();
                let found: bool = field(&payload(completion)?, "bytes")?;
                Ok(if found {
                    Some(bytes.unwrap_or_default())
                } else {
                    None
                })
            },
        )
    }

    fn clear_browsing_data(
        &self,
        profile: EngineProfileId,
        kinds: &[BrowsingDataKind],
        since_ms: Option<f64>,
    ) -> Reply<()> {
        if since_ms.is_some_and(|since| !since.is_finite()) {
            return Reply::err(EngineError::bad_argument(
                "the start time must be a finite number",
            ));
        }
        self.profile_async(
            profile,
            &json!({ "op": "clearBrowsingData", "types": kinds, "sinceMs": since_ms }),
            |c| payload(c).map(|_| ()),
        )
    }

    fn create_window(&self, frame: Rect) -> EngineResult<EngineWindowId> {
        if !frame.is_valid() {
            return Err(EngineError::bad_argument(
                "the window frame must be finite and not negative",
            ));
        }
        let mut window = 0;
        let status = unsafe {
            ffi::ardia_bridge_window_create(
                frame.x,
                frame.y,
                frame.width,
                frame.height,
                &mut window,
            )
        };
        if status != ffi::OK {
            return Err(status_error(status, || EngineError::NotStarted));
        }
        EngineWindowId::from_raw(window)
            .ok_or_else(|| EngineError::failed("the engine made no window"))
    }

    fn window_info(&self, window: EngineWindowId) -> EngineResult<WindowInfo> {
        typed(self.window_call(window, &json!({ "op": "info" }))?)
    }

    fn native_window_handle(&self, window: EngineWindowId) -> EngineResult<NativeWindow> {
        let mut object = std::ptr::null_mut();
        let status = unsafe { ffi::ardia_bridge_window_object(window.get(), 0, &mut object) };
        let object = Self::retained_object(status, object, || EngineError::UnknownWindow(window))?
            .ok_or(EngineError::UnknownWindow(window))?;
        Ok(unsafe { NativeWindow::adopt_retained(NativeWindowHandle(object), ownership()) })
    }

    fn window_host_view(&self, window: EngineWindowId) -> EngineResult<NativeView> {
        let mut object = std::ptr::null_mut();
        let status = unsafe { ffi::ardia_bridge_window_object(window.get(), 1, &mut object) };
        let object = Self::retained_object(status, object, || EngineError::UnknownWindow(window))?
            .ok_or(EngineError::UnknownWindow(window))?;
        Ok(unsafe { NativeView::adopt_retained(NativeViewHandle(object), ownership()) })
    }

    fn window_command(&self, window: EngineWindowId, command: WindowCommand) -> EngineResult<()> {
        self.window_call(window, &command).map(|_| ())
    }

    fn open_tab(&self, window: EngineWindowId, request: OpenTab) -> EngineResult<EngineTabId> {
        let value = self.window_call(
            window,
            &json!({ "op": "openTab", "url": request.url, "profile": request.profile, "foreground": request.foreground }),
        )?;
        tab_id(value)?.ok_or_else(|| EngineError::failed("the engine opened no tab"))
    }

    fn open_extension_view(
        &self,
        window: EngineWindowId,
        url: &str,
        profile: EngineProfileId,
        kind: ExtensionViewKind,
    ) -> EngineResult<Option<EngineTabId>> {
        tab_id(self.window_call(
            window,
            &json!({ "op": "openExtensionView", "url": url, "profile": profile, "kind": kind }),
        )?)
    }

    fn restore_tab(
        &self,
        window: EngineWindowId,
        state: Option<&str>,
        profile: EngineProfileId,
        foreground: bool,
    ) -> EngineResult<Option<EngineTabId>> {
        tab_id(self.window_call(window, &json!({ "op": "restoreTab", "state": state, "profile": profile, "foreground": foreground }))?)
    }

    fn duplicate_tab(
        &self,
        window: EngineWindowId,
        source: EngineTabId,
        profile: EngineProfileId,
        foreground: bool,
    ) -> EngineResult<Option<EngineTabId>> {
        tab_id(self.window_call(window, &json!({ "op": "duplicateTab", "source": source, "profile": profile, "foreground": foreground }))?)
    }

    fn adopt_tab(&self, window: EngineWindowId, tab: EngineTabId) -> EngineResult<Adoption> {
        let value = self.window_call(window, &json!({ "op": "adoptTab", "tab": tab }))?;
        Ok(Adoption::from_raw(value.as_i64().unwrap_or(0)))
    }

    fn can_adopt_tab(&self, window: EngineWindowId, tab: EngineTabId) -> EngineResult<Adoption> {
        let value = self.window_call(window, &json!({ "op": "canAdoptTab", "tab": tab }))?;
        Ok(Adoption::from_raw(value.as_i64().unwrap_or(0)))
    }

    fn tabs_for_profile(
        &self,
        window: EngineWindowId,
        profile: EngineProfileId,
    ) -> EngineResult<Vec<EngineTabId>> {
        let value = self.window_call(
            window,
            &json!({ "op": "tabsForProfile", "profile": profile }),
        )?;
        Ok(value
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_u64)
                    .filter_map(EngineTabId::from_raw)
                    .collect()
            })
            .unwrap_or_default())
    }

    fn chrome_window_id(
        &self,
        window: EngineWindowId,
        profile: EngineProfileId,
    ) -> EngineResult<i32> {
        typed(self.window_call(
            window,
            &json!({ "op": "chromeWindowId", "profile": profile }),
        )?)
    }

    fn execute_chrome_command(
        &self,
        window: EngineWindowId,
        command: i32,
        profile: EngineProfileId,
    ) -> EngineResult<bool> {
        typed(self.window_call(
            window,
            &json!({ "op": "executeChromeCommand", "command": command, "profile": profile }),
        )?)
    }

    fn tab_info(&self, tab: EngineTabId) -> EngineResult<TabInfo> {
        typed(self.tab_call(tab, &json!({ "op": "info" }), false)?)
    }

    fn native_view_handle(&self, tab: EngineTabId) -> EngineResult<NativeView> {
        let mut view = std::ptr::null_mut();
        let status = unsafe { ffi::ardia_bridge_tab_view(tab.get(), 0, &mut view) };
        let view = Self::retained_object(status, view, || EngineError::UnknownTab(tab))?
            .ok_or_else(|| EngineError::failed("the tab has no page view yet"))?;
        Ok(unsafe { NativeView::adopt_retained(NativeViewHandle(view), ownership()) })
    }

    fn devtools_view_handle(&self, tab: EngineTabId) -> EngineResult<Option<NativeView>> {
        let mut view = std::ptr::null_mut();
        let status = unsafe { ffi::ardia_bridge_tab_view(tab.get(), 1, &mut view) };
        let view = Self::retained_object(status, view, || EngineError::UnknownTab(tab))?;
        Ok(view
            .map(|view| unsafe { NativeView::adopt_retained(NativeViewHandle(view), ownership()) }))
    }

    fn navigation_entries(&self, tab: EngineTabId) -> EngineResult<Vec<NavigationEntry>> {
        typed(self.tab_call(tab, &json!({ "op": "navigationEntries" }), false)?)
    }

    fn security_info(&self, tab: EngineTabId) -> EngineResult<SecurityInfo> {
        typed(self.tab_call(tab, &json!({ "op": "securityInfo" }), false)?)
    }

    fn password_prompt(&self, tab: EngineTabId) -> EngineResult<Option<PasswordPrompt>> {
        typed(self.tab_call(tab, &json!({ "op": "passwordPrompt" }), false)?)
    }

    fn autofill_prompt(&self, tab: EngineTabId) -> EngineResult<Option<AutofillPrompt>> {
        typed(self.tab_call(tab, &json!({ "op": "autofillPrompt" }), false)?)
    }

    fn tab_command(&self, tab: EngineTabId, command: TabCommand) -> EngineResult<()> {
        command.validate()?;
        match command {
            TabCommand::ResolvePasswordPrompt { action, username } => {
                self.resolve_password(tab, action, username.as_deref(), None)
            }
            command => self.tab_call(tab, &command, false).map(|_| ()),
        }
    }

    fn tab_action(&self, tab: EngineTabId, action: TabAction) -> EngineResult<bool> {
        typed(self.tab_call(tab, &action, false)?)
    }

    fn resolve_password_prompt(
        &self,
        tab: EngineTabId,
        action: PasswordPromptAction,
        username: Option<&str>,
        password: Option<&str>,
    ) -> EngineResult<()> {
        self.resolve_password(tab, action, username, password)
    }

    fn sleep_if_hidden(&self, tab: EngineTabId, seconds: f64) -> EngineResult<Vec<i32>> {
        if !(seconds.is_finite() && seconds >= 0.0) {
            return Err(EngineError::bad_argument(
                "sleep time must be a non-negative number",
            ));
        }
        typed(self.tab_call(
            tab,
            &json!({ "op": "sleepIfHidden", "seconds": seconds }),
            false,
        )?)
    }

    fn execute_extension_action(
        &self,
        tab: EngineTabId,
        extension_id: &str,
    ) -> EngineResult<String> {
        typed(self.tab_call(
            tab,
            &json!({ "op": "executeExtensionAction", "extensionId": extension_id }),
            false,
        )?)
    }

    fn extension_action_states(
        &self,
        tab: EngineTabId,
        extension_ids: &[String],
    ) -> EngineResult<ExtensionActionStates> {
        typed(self.tab_call(
            tab,
            &json!({ "op": "actionStates", "ids": extension_ids }),
            false,
        )?)
    }

    fn side_panel_url(&self, tab: EngineTabId, extension_id: &str) -> EngineResult<Option<String>> {
        typed(self.tab_call(
            tab,
            &json!({ "op": "sidePanelUrl", "extensionId": extension_id }),
            false,
        )?)
    }

    fn evaluate_js(&self, tab: EngineTabId, code: &str) -> Reply<Option<Value>> {
        self.tab_async(
            tab,
            &json!({ "op": "evaluate", "code": code }),
            |completion| {
                let answer: Option<String> = field(&payload(completion)?, "json")?;
                match answer {
                    None => Ok(None),
                    Some(text) => serde_json::from_str(&text)
                        .map(Some)
                        .map_err(|e| EngineError::BadReply(e.to_string())),
                }
            },
        )
    }

    fn cover_page(&self, tab: EngineTabId) -> Reply<bool> {
        self.tab_async(tab, &json!({ "op": "coverPage" }), |c| {
            field(&payload(c)?, "covered")
        })
    }

    fn uncover_page(&self, tab: EngineTabId, fade: bool) -> EngineResult<()> {
        self.tab_call(tab, &json!({ "op": "uncoverPage", "fade": fade }), false)
            .map(|_| ())
    }

    fn ask_before_leaving(&self, tab: EngineTabId) -> Reply<bool> {
        self.tab_async(tab, &json!({ "op": "askBeforeLeaving" }), |c| {
            field(&payload(c)?, "leave")
        })
    }

    fn choose_files_to_open(
        &self,
        window: Option<EngineWindowId>,
    ) -> Reply<Vec<std::path::PathBuf>> {
        let parent = match window.map(|window| self.native_window_handle(window)) {
            Some(Ok(parent)) => Some(parent),
            Some(Err(error)) => return Reply::err(error),
            None => None,
        };
        dialogs::FilePanel::open_files().show(parent.as_ref())
    }

    fn enter_pip(&self, tab: EngineTabId, click_time: f64) -> Reply<PipEntry> {
        if !click_time.is_finite() {
            return Reply::err(EngineError::bad_argument(
                "the click time must be a finite number",
            ));
        }
        self.tab_async(
            tab,
            &json!({ "op": "enterPip", "clickTime": click_time }),
            |c| typed(payload(c)?),
        )
    }

    fn devtools_call(
        &self,
        tab: EngineTabId,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Reply<Value> {
        if method.is_empty() || timeout.is_zero() {
            return Reply::err(EngineError::bad_argument(
                "a DevTools call needs a method and a timeout",
            ));
        }
        self.tab_async(
            tab,
            &json!({ "op": "devToolsCall", "method": method, "params": params, "timeoutSeconds": timeout.as_secs_f64() }),
            |c| Ok(payload(c)?.get("result").cloned().unwrap_or(Value::Null)),
        )
    }

    fn devtools_layout(&self, tab: EngineTabId, size: Size) -> EngineResult<DevToolsLayout> {
        if !(size.width.is_finite()
            && size.height.is_finite()
            && size.width >= 0.0
            && size.height >= 0.0)
        {
            return Err(EngineError::bad_argument(
                "the size must be finite and not negative",
            ));
        }
        typed(self.tab_call(
            tab,
            &json!({ "op": "devToolsLayout", "width": size.width, "height": size.height }),
            false,
        )?)
    }

    fn call_service(&self, name: &str, profile_dir: &str, args_json: &str) -> Reply<Value> {
        let prepared = (|| {
            self.require_main()?;
            self.require_started()?;
            let name = ServiceName::new(name)?;
            let args = ServiceArgs::json(args_json)?;
            Ok::<_, EngineError>((self.route(&name)?, name, args))
        })();
        match prepared {
            Ok((route, name, args)) => abi::call_service(route, &name, profile_dir, args),
            Err(error) => Reply::err(error),
        }
    }

    fn call_service_secret(
        &self,
        name: &str,
        profile_dir: &str,
        args_json: Zeroizing<String>,
    ) -> Reply<SecretValue> {
        let prepared = (|| {
            self.require_main()?;
            self.require_started()?;
            let name = ServiceName::new(name)?;
            let args = ServiceArgs::secret(args_json)?;
            Ok::<_, EngineError>((self.route(&name)?, name, args))
        })();
        match prepared {
            Ok((route, name, args)) => abi::call_service_secret(route, &name, profile_dir, args),
            Err(error) => Reply::err(error),
        }
    }

    fn page_view(&self, view: &NativeView, query: PageViewQuery) -> EngineResult<bool> {
        let view = view
            .live_object()
            .ok_or_else(|| EngineError::bad_argument("page views must come from the engine"))?;
        let code = match query {
            PageViewQuery::IsPageView => 0,
            PageViewQuery::TakeSwipes => 1,
            PageViewQuery::TakesSwipes => 2,
            PageViewQuery::IsEditingText => 3,
        };
        let mut answer = false;
        let status = unsafe { ffi::ardia_bridge_page_view(view, code, &mut answer) };
        if status != ffi::OK {
            return Err(status_error(status, || {
                EngineError::bad_argument("that isn't a view")
            }));
        }
        Ok(answer)
    }

    fn set_scroll_observer(&self, enabled: bool) -> EngineResult<()> {
        let status = unsafe { ffi::ardia_bridge_set_scroll_observer(enabled) };
        if status == ffi::OK {
            Ok(())
        } else {
            Err(status_error(status, || EngineError::NotStarted))
        }
    }
}

mod hosted {
    use std::cell::{Cell, RefCell};
    use std::ffi::c_void;
    use std::marker::PhantomData;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::ptr::NonNull;
    use std::rc::Rc;

    use super::{ffi, is_main_thread, status_error};
    use crate::error::{EngineError, EngineResult};
    use crate::types::{EngineWindowId, NativeWindow};

    pub trait HostedWindowRoutes: 'static {
        fn send_event(
            &self,
            window: NonNull<c_void>,
            event: NonNull<c_void>,
            call_super: SuperCall<'_, ()>,
        );

        fn key_down(
            &self,
            window: NonNull<c_void>,
            event: NonNull<c_void>,
            call_super: SuperCall<'_, ()>,
        );

        fn make_first_responder(
            &self,
            window: NonNull<c_void>,
            responder: Option<NonNull<c_void>>,
            call_super: SuperCall<'_, bool>,
        ) -> bool;

        fn perform_key_equivalent(
            &self,
            window: NonNull<c_void>,
            event: NonNull<c_void>,
            call_super: SuperCall<'_, bool>,
        ) -> bool;
    }

    pub struct SuperCall<'a, R: Copy> {
        invoke: unsafe extern "C" fn(*mut c_void) -> R,
        thunk: *mut c_void,
        done: &'a Cell<Option<R>>,
    }

    impl<R: Copy> SuperCall<'_, R> {
        pub fn call(self) -> R {
            if let Some(value) = self.done.get() {
                return value;
            }
            let value = unsafe { (self.invoke)(self.thunk) };
            self.done.set(Some(value));
            value
        }

        pub fn was_called(&self) -> bool {
            self.done.get().is_some()
        }
    }

    thread_local! {
        static ROUTES: RefCell<Option<Rc<dyn HostedWindowRoutes>>> = const { RefCell::new(None) };
    }

    fn current_routes() -> Option<Rc<dyn HostedWindowRoutes>> {
        ROUTES
            .try_with(|routes| routes.try_borrow().ok().and_then(|routes| routes.clone()))
            .ok()
            .flatten()
    }

    fn take_routes() {
        let routes = ROUTES
            .try_with(|routes| {
                routes
                    .try_borrow_mut()
                    .ok()
                    .and_then(|mut slot| slot.take())
            })
            .ok()
            .flatten();
        drop(routes);
    }

    fn route<R: Copy>(
        invoke: unsafe extern "C" fn(*mut c_void) -> R,
        thunk: *mut c_void,
        body: impl FnOnce(&dyn HostedWindowRoutes, SuperCall<'_, R>) -> R,
    ) -> R {
        let done = Cell::new(None);
        let routed = current_routes().and_then(|routes| {
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                body(
                    routes.as_ref(),
                    SuperCall {
                        invoke,
                        thunk,
                        done: &done,
                    },
                )
            }));
            if outcome.is_err() {
                log::error!("a hosted window input route panicked, so the window handled it");
            }
            outcome.ok()
        });
        routed.unwrap_or_else(|| {
            SuperCall {
                invoke,
                thunk,
                done: &done,
            }
            .call()
        })
    }

    unsafe extern "C" fn routed_send_event(
        _: *mut c_void,
        window: *mut c_void,
        event: *mut c_void,
        call_super: ffi::HostedVoidSuper,
        thunk: *mut c_void,
    ) {
        match (NonNull::new(window), NonNull::new(event)) {
            (Some(window), Some(event)) => route(call_super, thunk, |routes, call_super| {
                routes.send_event(window, event, call_super)
            }),
            _ => unsafe { call_super(thunk) },
        }
    }

    unsafe extern "C" fn routed_key_down(
        _: *mut c_void,
        window: *mut c_void,
        event: *mut c_void,
        call_super: ffi::HostedVoidSuper,
        thunk: *mut c_void,
    ) {
        match (NonNull::new(window), NonNull::new(event)) {
            (Some(window), Some(event)) => route(call_super, thunk, |routes, call_super| {
                routes.key_down(window, event, call_super)
            }),
            _ => unsafe { call_super(thunk) },
        }
    }

    unsafe extern "C" fn routed_make_first_responder(
        _: *mut c_void,
        window: *mut c_void,
        responder: *mut c_void,
        call_super: ffi::HostedBoolSuper,
        thunk: *mut c_void,
    ) -> bool {
        match NonNull::new(window) {
            Some(window) => route(call_super, thunk, |routes, call_super| {
                routes.make_first_responder(window, NonNull::new(responder), call_super)
            }),
            None => unsafe { call_super(thunk) },
        }
    }

    unsafe extern "C" fn routed_perform_key_equivalent(
        _: *mut c_void,
        window: *mut c_void,
        event: *mut c_void,
        call_super: ffi::HostedBoolSuper,
        thunk: *mut c_void,
    ) -> bool {
        match (NonNull::new(window), NonNull::new(event)) {
            (Some(window), Some(event)) => route(call_super, thunk, |routes, call_super| {
                routes.perform_key_equivalent(window, event, call_super)
            }),
            _ => unsafe { call_super(thunk) },
        }
    }

    fn hook_table() -> ffi::HostedHookTable {
        ffi::HostedHookTable {
            size: std::mem::size_of::<ffi::HostedHookTable>() as u32,
            context: std::ptr::null_mut(),
            send_event: routed_send_event,
            key_down: routed_key_down,
            make_first_responder: routed_make_first_responder,
            perform_key_equivalent: routed_perform_key_equivalent,
        }
    }

    fn checked(status: ffi::Status, gone: impl FnOnce() -> EngineError) -> EngineResult<()> {
        if status == ffi::OK {
            Ok(())
        } else {
            Err(status_error(status, gone))
        }
    }

    pub fn hosted_hooks_installed() -> bool {
        unsafe { ffi::ardia_bridge_hosted_hooks_installed() }
    }

    pub fn style_browser_window(window: &NativeWindow) -> EngineResult<()> {
        let object = window
            .live_object()
            .ok_or_else(|| EngineError::bad_argument("only a live AppKit window can be styled"))?;
        if !is_main_thread() {
            return Err(EngineError::WrongThread);
        }
        let status = unsafe { ffi::ardia_bridge_style_browser_window(object) };
        checked(status, || EngineError::bad_argument("that isn't a window"))
    }

    #[must_use = "dropping the hooks hands every hosted window its own input handling back"]
    pub struct HostedWindowHooks {
        active: Cell<bool>,
        _main_thread_only: PhantomData<*const ()>,
    }

    impl std::fmt::Debug for HostedWindowHooks {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("HostedWindowHooks")
                .field("active", &self.active.get())
                .finish()
        }
    }

    pub fn install_hosted_window_hooks(
        routes: impl HostedWindowRoutes,
    ) -> EngineResult<HostedWindowHooks> {
        if !is_main_thread() {
            return Err(EngineError::WrongThread);
        }
        if ROUTES.with_borrow(Option::is_some) || hosted_hooks_installed() {
            return Err(EngineError::AlreadyRunning);
        }
        ROUTES.with_borrow_mut(|slot| *slot = Some(Rc::new(routes)));
        let table = hook_table();
        let status = unsafe { ffi::ardia_bridge_hosted_hooks_install(&table) };
        if let Err(error) = checked(status, || {
            EngineError::failed("the hosted window hooks didn't install")
        }) {
            take_routes();
            return Err(error);
        }
        Ok(HostedWindowHooks {
            active: Cell::new(true),
            _main_thread_only: PhantomData,
        })
    }

    fn appkit_window(window: &NativeWindow) -> EngineResult<*mut c_void> {
        window
            .live_object()
            .ok_or_else(|| EngineError::bad_argument("only a live AppKit window can route input"))
    }

    impl HostedWindowHooks {
        pub fn attach(&self, window: &NativeWindow) -> EngineResult<()> {
            let object = appkit_window(window)?;
            checked(
                unsafe { ffi::ardia_bridge_hosted_window_attach(object) },
                || EngineError::bad_argument("that isn't a window"),
            )
        }

        pub fn attach_engine_window(&self, window: EngineWindowId) -> EngineResult<()> {
            checked(
                unsafe { ffi::ardia_bridge_hosted_window_attach_engine(window.get()) },
                || EngineError::UnknownWindow(window),
            )
        }

        pub fn detach(&self, window: &NativeWindow) -> EngineResult<()> {
            let object = appkit_window(window)?;
            checked(
                unsafe { ffi::ardia_bridge_hosted_window_detach(object) },
                || EngineError::bad_argument("that isn't a window"),
            )
        }

        pub fn is_attached(&self, window: &NativeWindow) -> bool {
            window
                .live_object()
                .is_some_and(|object| unsafe { ffi::ardia_bridge_hosted_window_attached(object) })
        }

        pub fn attached_count(&self) -> usize {
            usize::try_from(unsafe { ffi::ardia_bridge_hosted_window_count() })
                .unwrap_or(usize::MAX)
        }

        pub fn uninstall(self) -> EngineResult<u64> {
            self.remove()
        }

        fn remove(&self) -> EngineResult<u64> {
            if !self.active.replace(false) {
                return Ok(0);
            }
            let mut restored = 0;
            let status = unsafe { ffi::ardia_bridge_hosted_hooks_remove(&mut restored) };
            take_routes();
            checked(status, || {
                EngineError::failed("the hosted window hooks didn't come off")
            })
            .map(|()| restored)
        }
    }

    impl Drop for HostedWindowHooks {
        fn drop(&mut self) {
            if let Err(error) = self.remove() {
                log::warn!("the hosted window hooks didn't come off cleanly: {error}");
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::types::NativeWindowHandle;

        #[test]
        fn only_a_live_appkit_window_can_be_styled() {
            let token = NativeWindow::borrowed(NativeWindowHandle(0x22 as *mut c_void));
            assert!(matches!(
                style_browser_window(&token),
                Err(EngineError::BadArgument(_))
            ));
        }

        struct Routes {
            calls_super: u8,
            panics_after: bool,
            seen: Rc<Cell<u32>>,
            answer: bool,
        }

        impl Routes {
            fn passing(times: u8, seen: &Rc<Cell<u32>>) -> Self {
                Self {
                    calls_super: times,
                    panics_after: false,
                    seen: seen.clone(),
                    answer: false,
                }
            }

            fn run<R: Copy>(&self, call_super: SuperCall<'_, R>, fallback: R) -> R {
                self.seen.set(self.seen.get() + 1);
                if self.calls_super > 1 {
                    call_super.copied().call();
                }
                let value = if self.calls_super > 0 {
                    call_super.call()
                } else {
                    fallback
                };
                if self.panics_after {
                    panic!("a route broke");
                }
                value
            }
        }

        impl<R: Copy> SuperCall<'_, R> {
            fn copied(&self) -> Self {
                SuperCall {
                    invoke: self.invoke,
                    thunk: self.thunk,
                    done: self.done,
                }
            }
        }

        impl HostedWindowRoutes for Routes {
            fn send_event(
                &self,
                _: NonNull<c_void>,
                _: NonNull<c_void>,
                call_super: SuperCall<'_, ()>,
            ) {
                self.run(call_super, ())
            }

            fn key_down(
                &self,
                _: NonNull<c_void>,
                _: NonNull<c_void>,
                call_super: SuperCall<'_, ()>,
            ) {
                self.run(call_super, ())
            }

            fn make_first_responder(
                &self,
                _: NonNull<c_void>,
                _: Option<NonNull<c_void>>,
                call_super: SuperCall<'_, bool>,
            ) -> bool {
                self.run(call_super, self.answer)
            }

            fn perform_key_equivalent(
                &self,
                _: NonNull<c_void>,
                _: NonNull<c_void>,
                call_super: SuperCall<'_, bool>,
            ) -> bool {
                self.run(call_super, self.answer)
            }
        }

        unsafe extern "C" fn count_void(thunk: *mut c_void) {
            let count = unsafe { &*(thunk as *const Cell<u32>) };
            count.set(count.get() + 1);
        }

        unsafe extern "C" fn count_bool(thunk: *mut c_void) -> bool {
            let count = unsafe { &*(thunk as *const Cell<u32>) };
            count.set(count.get() + 1);
            true
        }

        fn thunk(count: &Cell<u32>) -> *mut c_void {
            count as *const Cell<u32> as *mut c_void
        }

        fn with_routes<R>(routes: Routes, body: impl FnOnce() -> R) -> R {
            ROUTES.with_borrow_mut(|slot| *slot = Some(Rc::new(routes)));
            let out = body();
            take_routes();
            out
        }

        fn fake() -> *mut c_void {
            NonNull::<u8>::dangling().as_ptr().cast()
        }

        #[test]
        fn unrouted_events_reach_the_window_exactly_once() {
            let supers = Cell::new(0);
            unsafe {
                routed_send_event(fake(), fake(), fake(), count_void, thunk(&supers));
                routed_key_down(fake(), fake(), fake(), count_void, thunk(&supers));
                assert!(routed_make_first_responder(
                    fake(),
                    fake(),
                    std::ptr::null_mut(),
                    count_bool,
                    thunk(&supers)
                ));
                assert!(routed_perform_key_equivalent(
                    fake(),
                    fake(),
                    fake(),
                    count_bool,
                    thunk(&supers)
                ));
            }
            assert_eq!(supers.get(), 4);
        }

        #[test]
        fn routes_decide_whether_the_window_sees_an_event() {
            let seen = Rc::new(Cell::new(0));
            let supers = Cell::new(0);
            with_routes(Routes::passing(0, &seen), || unsafe {
                routed_send_event(fake(), fake(), fake(), count_void, thunk(&supers));
                assert!(!routed_perform_key_equivalent(
                    fake(),
                    fake(),
                    fake(),
                    count_bool,
                    thunk(&supers)
                ));
            });
            assert_eq!((seen.get(), supers.get()), (2, 0));
            with_routes(Routes::passing(2, &seen), || unsafe {
                routed_key_down(fake(), fake(), fake(), count_void, thunk(&supers));
                assert!(routed_make_first_responder(
                    fake(),
                    fake(),
                    fake(),
                    count_bool,
                    thunk(&supers)
                ));
            });
            assert_eq!(
                (seen.get(), supers.get()),
                (4, 2),
                "a route that asks twice still reaches the window once"
            );
        }

        #[test]
        fn a_panicking_route_still_lets_the_window_handle_the_event_once() {
            let seen = Rc::new(Cell::new(0));
            let supers = Cell::new(0);
            let before = Routes {
                panics_after: true,
                ..Routes::passing(0, &seen)
            };
            with_routes(before, || unsafe {
                routed_send_event(fake(), fake(), fake(), count_void, thunk(&supers));
            });
            assert_eq!(supers.get(), 1);
            let after = Routes {
                panics_after: true,
                ..Routes::passing(1, &seen)
            };
            let answer = with_routes(after, || unsafe {
                routed_perform_key_equivalent(fake(), fake(), fake(), count_bool, thunk(&supers))
            });
            assert!(answer, "the window's own answer survives the panic");
            assert_eq!((seen.get(), supers.get()), (2, 2));
        }

        #[test]
        fn null_windows_and_events_skip_the_routes() {
            let seen = Rc::new(Cell::new(0));
            let supers = Cell::new(0);
            with_routes(Routes::passing(0, &seen), || unsafe {
                routed_send_event(
                    fake(),
                    std::ptr::null_mut(),
                    fake(),
                    count_void,
                    thunk(&supers),
                );
                routed_key_down(
                    fake(),
                    fake(),
                    std::ptr::null_mut(),
                    count_void,
                    thunk(&supers),
                );
                routed_make_first_responder(
                    fake(),
                    std::ptr::null_mut(),
                    fake(),
                    count_bool,
                    thunk(&supers),
                );
            });
            assert_eq!((seen.get(), supers.get()), (0, 3));
        }

        #[test]
        fn hooks_install_only_on_the_main_thread() {
            if is_main_thread() {
                return;
            }
            let seen = Rc::new(Cell::new(0));
            assert!(matches!(
                install_hosted_window_hooks(Routes::passing(1, &seen)),
                Err(EngineError::WrongThread)
            ));
            assert!(
                current_routes().is_none(),
                "a refused install keeps no routes"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_errors() {
        let tab = EngineTabId::from_raw(4).unwrap();
        assert_eq!(
            status_error(ffi::UNKNOWN_TAB, || EngineError::UnknownTab(tab)),
            EngineError::UnknownTab(tab)
        );
        assert_eq!(
            status_error(ffi::WRONG_THREAD, || unreachable!()),
            EngineError::WrongThread
        );
        assert_eq!(
            status_error(ffi::NOT_STARTED, || unreachable!()),
            EngineError::NotStarted
        );
        assert!(matches!(
            status_error(ffi::BAD_ARGUMENT, || unreachable!()),
            EngineError::BadArgument(_)
        ));
        assert!(matches!(
            status_error(ffi::NOT_LOADED, || unreachable!()),
            EngineError::NotLoaded(_)
        ));
        assert!(matches!(
            status_error(99, || unreachable!()),
            EngineError::Failed(_)
        ));
    }

    #[test]
    fn bridge_calls_off_the_main_thread_are_refused() {
        if is_main_thread() {
            return;
        }
        let tab = EngineTabId::from_raw(1).unwrap();
        let result = call_json(
            |json, out| unsafe { ffi::ardia_bridge_tab_call(tab.get(), json, out) },
            &json!({"op": "info"}),
            false,
            || EngineError::UnknownTab(tab),
        );
        assert_eq!(result, Err(EngineError::WrongThread));
        let reply = submit_async(
            |json, id| unsafe { ffi::ardia_bridge_tab_async(tab.get(), json, id) },
            &json!({"op": "evaluate", "code": "1"}),
            |c| c.into_json(),
            || EngineError::UnknownTab(tab),
        );
        assert_eq!(
            futures::executor::block_on(reply),
            Err(EngineError::WrongThread)
        );
        assert!(matches!(
            unsafe { MacEngine::load() },
            Err(EngineError::WrongThread)
        ));
    }

    #[test]
    fn questions_follow_the_policy() {
        struct Policy;
        impl HostPolicy for Policy {
            fn window_should_close(&self, window: EngineWindowId) -> bool {
                window.get() != 7
            }
            fn pre_handle_key(&self, _: EngineWindowId, event: &KeyEvent) -> bool {
                event.chord() == KeyChord::new("l", Modifiers::COMMAND)
            }
            fn is_reserved_key(&self, chord: &KeyChord) -> bool {
                chord.normalized() == KeyChord::new("w", Modifiers::COMMAND)
            }
            fn context_menu_items(
                &self,
                _: EngineTabId,
                target: &ContextMenuTarget,
            ) -> Vec<ContextMenuItem> {
                match target {
                    ContextMenuTarget::Selection(text) => vec![ContextMenuItem {
                        id: "copy".into(),
                        title: format!("Copy {text}"),
                    }],
                    ContextMenuTarget::Page(_) => Vec::new(),
                }
            }
        }
        let shared = MacShared {
            bus: EventBus::new(),
            policy: RwLock::new(Arc::new(Policy)),
        };
        let ask = |question: Value| answer_question(&shared, &question);
        assert_eq!(ask(json!({"question": "listening"})), Some(false));
        let _events = shared.bus.subscribe();
        assert_eq!(ask(json!({"question": "listening"})), Some(true));
        assert_eq!(
            ask(json!({"question": "windowShouldClose", "window": 7})),
            Some(false)
        );
        assert_eq!(
            ask(json!({"question": "windowShouldClose", "window": 8})),
            Some(true)
        );
        assert_eq!(ask(json!({"question": "windowShouldClose"})), None);
        let key = json!({"kind": "down", "keyCode": 37, "characters": "l", "charactersIgnoringModifiers": "l", "modifiers": Modifiers::COMMAND.0, "isRepeat": false});
        assert_eq!(
            ask(json!({"question": "preHandleKey", "window": 1, "event": key})),
            Some(true)
        );
        assert_eq!(
            ask(
                json!({"question": "reservedKey", "key": "W", "unshiftedKey": "w", "modifiers": Modifiers::COMMAND.0})
            ),
            Some(true)
        );
        assert_eq!(
            ask(
                json!({"question": "reservedKey", "key": "q", "unshiftedKey": "", "modifiers": Modifiers::COMMAND.0})
            ),
            Some(false)
        );
        assert_eq!(
            ask(json!({"question": "extensionActionPopup", "tab": 3, "payload": {}})),
            Some(true)
        );
        assert_eq!(
            ask(json!({"question": "extensionActionPopup", "tab": 0, "payload": {}})),
            Some(false)
        );
        assert_eq!(ask(json!({"question": "mystery"})), None);
        assert_eq!(
            ask(json!({"question": "validateMenuItem", "command": "newTab", "arg": null})),
            Some(true)
        );
        assert_eq!(
            ask(json!({"question": "validateMenuItem", "command": "noop"})),
            Some(false)
        );
        let items = answer_json(
            &shared,
            &json!({"question": "contextMenuItems", "tab": 2, "on": "selection", "value": "x"}),
        )
        .unwrap();
        assert_eq!(items, json!([{"id": "copy", "title": "Copy x"}]));
        assert_eq!(
            answer_json(
                &shared,
                &json!({"question": "runContextMenu", "tab": 2, "menu": {}})
            ),
            None
        );
        assert_eq!(
            answer_json(
                &shared,
                &json!({"question": "contextMenuItems", "tab": 0, "on": "page"})
            ),
            None
        );
    }

    static HOST_SLOT: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    #[test]
    fn the_new_window_policy_runs_without_holding_the_policy_lock() {
        struct Reentrant(std::sync::Weak<MacShared>);
        impl HostPolicy for Reentrant {
            fn new_browser_window(
                &self,
                _: Option<EngineProfileId>,
                kind: NewBrowserKind,
            ) -> NewBrowserWindow {
                let shared = self.0.upgrade().expect("the host is alive");
                let writable = shared.policy.try_write().is_some();
                if writable && kind == NewBrowserKind::Popup {
                    NewBrowserWindow::Create
                } else {
                    NewBrowserWindow::Refuse
                }
            }
        }
        let _slot = HOST_SLOT.lock();
        let shared = Arc::new_cyclic(|weak| MacShared {
            bus: EventBus::new(),
            policy: RwLock::new(Arc::new(Reentrant(weak.clone()))),
        });
        *HOST.shared.write() = Some(shared);
        let popup = CString::new("popup").unwrap();
        let answer = unsafe { host_new_window(std::ptr::null_mut(), 1, popup.as_ptr()) };
        *HOST.shared.write() = None;
        assert_eq!(answer, ffi::CREATE_WINDOW);
    }

    #[test]
    fn host_callbacks_survive_garbage_and_missing_engines() {
        let _slot = HOST_SLOT.lock();
        let garbage = CString::new("{not json").unwrap();
        unsafe {
            host_event(std::ptr::null_mut(), garbage.as_ptr());
            host_event(std::ptr::null_mut(), std::ptr::null());
            assert_eq!(host_decide(std::ptr::null_mut(), garbage.as_ptr()), -1);
            assert_eq!(
                host_new_window(std::ptr::null_mut(), 1, std::ptr::null()),
                0
            );
            let answer = host_answer(std::ptr::null_mut(), garbage.as_ptr());
            assert!(answer.is_null());
            host_release_answer(std::ptr::null_mut(), std::ptr::null_mut());
            host_complete(
                std::ptr::null_mut(),
                u64::MAX,
                0,
                std::ptr::null(),
                std::ptr::null(),
                0,
            );
        }
    }

    #[test]
    fn completions_resolve_registered_requests_once() {
        let (id, mut reply) = REQUESTS.register_reply(|c: Completion| Ok((c.status, c.bytes)));
        let json = CString::new("{\"bytes\":true}").unwrap();
        let bytes = [1u8, 2, 3];
        unsafe {
            host_complete(
                std::ptr::null_mut(),
                id,
                0,
                json.as_ptr(),
                bytes.as_ptr(),
                bytes.len(),
            );
            host_complete(
                std::ptr::null_mut(),
                id,
                2,
                std::ptr::null(),
                std::ptr::null(),
                0,
            );
        }
        assert_eq!(
            reply.try_take(),
            Some(Ok((CompletionStatus::Ok, Some(vec![1, 2, 3]))))
        );
    }

    #[test]
    fn profile_folders_must_be_plain_names() {
        for bad in ["", ".", "..", "a/b", "a\\b", "x\0"] {
            assert!(validate_profile_folder(bad).is_err(), "{bad:?}");
        }
        for good in ["Default", "Profile 1", "Work"] {
            assert!(validate_profile_folder(good).is_ok());
        }
    }

    #[test]
    fn a_panicking_waker_still_leaves_the_engine_inactive() {
        let _slot = HOST_SLOT.lock();
        let requests: &'static PendingRequests = Box::leak(Box::new(PendingRequests::new()));
        let services: &'static PendingRequests = Box::leak(Box::new(PendingRequests::new()));
        ACTIVE.store(true, Ordering::Release);
        let (_, before) = requests.register_reply(Completion::into_json);
        requests.register(|_| panic!("a custom waker panicked on wake"));
        let (_, after) = requests.register_reply(Completion::into_json);
        services.register(|_| panic!("a service waker panicked on wake"));
        let (_, service) = services.register_reply(Completion::into_json);
        let bus = EventBus::new();
        let outcome = catch_unwind(AssertUnwindSafe(|| tear_down(&bus, requests, services)));
        assert!(outcome.is_ok(), "waker panics stay inside teardown");
        assert!(!ACTIVE.load(Ordering::Acquire));
        assert!(requests.is_empty() && services.is_empty());
        assert_eq!(
            futures::executor::block_on(service),
            Err(EngineError::Cancelled)
        );
        assert_eq!(
            futures::executor::block_on(before),
            Err(EngineError::Cancelled)
        );
        assert_eq!(
            futures::executor::block_on(after),
            Err(EngineError::Cancelled)
        );
    }
}
