use std::panic::{AssertUnwindSafe, catch_unwind};
use std::rc::Rc;
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use ardia_state::{BrowserState, WindowId};
use futures::StreamExt;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use futures::future::LocalBoxFuture;
use gpui::App;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Imp, NSObject, Sel};
use objc2::{AnyThread, ClassType, DefinedClass, class, define_class, msg_send, sel};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
use parking_lot::Mutex;

use super::{
    MISSING_JAVASCRIPT, NOT_READY, REPLY_DEADLINE, ScriptError, ScriptReply, ScriptRequest,
    ScriptResult, TIMED_OUT, clean_id,
};
use crate::coordinator::AppCoordinator;

struct MainCommand(Option<Retained<AnyObject>>);

unsafe impl Send for MainCommand {}

enum Answer {
    Resume(MainCommand),
    Wait(std::sync::mpsc::Sender<ScriptResult>),
}

struct Pending {
    request: ScriptRequest,
    answer: Answer,
}

impl Answer {
    fn give(self, result: ScriptResult) {
        match self {
            Answer::Resume(MainCommand(command)) => finish(command.as_deref(), result),
            Answer::Wait(sender) => {
                let _ = sender.send(result);
            }
        }
    }
}

static QUEUE: Mutex<Option<UnboundedSender<Pending>>> = Mutex::new(None);

fn coordinator_cell() -> &'static OnceLock<Weak<AppCoordinator>> {
    static COORDINATOR: OnceLock<Weak<AppCoordinator>> = OnceLock::new();
    &COORDINATOR
}

fn coordinator() -> Option<Arc<AppCoordinator>> {
    coordinator_cell().get().and_then(Weak::upgrade)
}

fn state() -> Option<Arc<BrowserState>> {
    coordinator().map(|c| c.store().snapshot())
}

fn guarded<T>(fallback: T, body: impl FnOnce() -> T) -> T {
    catch_unwind(AssertUnwindSafe(body)).unwrap_or_else(|_| {
        log::warn!("an AppleScript request failed inside Ardia");
        fallback
    })
}

fn ns(text: &str) -> Retained<NSString> {
    NSString::from_str(text)
}

fn native_window<T>(id: &str, act: impl FnOnce(*mut AnyObject) -> T) -> Option<T> {
    let coordinator = coordinator()?;
    let engine_window = coordinator.engine_window(&WindowId::new(id))?;
    let native = coordinator.hosted_native_window(engine_window)?;
    let pointer = native.handle().as_ptr().cast::<AnyObject>();
    (!pointer.is_null()).then(|| act(pointer))
}

fn front_to_back(state: &BrowserState) -> Vec<WindowId> {
    let Some(coordinator) = coordinator() else {
        return Vec::new();
    };
    let ids: Vec<(usize, WindowId)> = state
        .window_order
        .iter()
        .filter_map(|id| {
            let engine_window = coordinator.engine_window(id)?;
            let native = coordinator.hosted_native_window(engine_window)?;
            Some((native.handle().as_ptr() as usize, id.clone()))
        })
        .collect();
    if ids.is_empty() {
        return Vec::new();
    }
    let ordered: Retained<NSArray<AnyObject>> = unsafe {
        let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
        msg_send![&*app, orderedWindows]
    };
    ordered
        .iter()
        .filter_map(|window| {
            let pointer = Retained::as_ptr(&window) as usize;
            ids.iter()
                .find(|(p, _)| *p == pointer)
                .map(|(_, id)| id.clone())
        })
        .collect()
}

fn ordered_windows(state: &BrowserState) -> Vec<WindowId> {
    super::scripted_windows(state, &front_to_back(state))
}

pub struct ScriptId {
    id: String,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "ArdiaScriptWindow"]
    #[ivars = ScriptId]
    pub struct ScriptWindow;

    impl ScriptWindow {
        #[unsafe(method_id(uniqueID))]
        fn unique_id(&self) -> Retained<NSString> {
            ns(&self.ivars().id)
        }

        #[unsafe(method_id(objectSpecifier))]
        fn object_specifier(&self) -> Option<Retained<AnyObject>> {
            window_specifier(&self.ivars().id)
        }

        #[unsafe(method_id(name))]
        fn name(&self) -> Retained<NSString> {
            let id = &self.ivars().id;
            ns(&guarded(String::new(), || {
                state().map(|s| super::window_name(&s, id)).unwrap_or_default()
            }))
        }

        #[unsafe(method(orderedIndex))]
        fn ordered_index(&self) -> isize {
            let id = &self.ivars().id;
            guarded(0, || {
                let Some(state) = state() else { return 0 };
                ordered_windows(&state)
                    .iter()
                    .position(|w| w.as_str() == id)
                    .map_or(0, |i| i as isize + 1)
            })
        }

        #[unsafe(method_id(activeTab))]
        fn active_tab(&self) -> Option<Retained<ScriptTab>> {
            let id = &self.ivars().id;
            guarded(None, || {
                let state = state()?;
                super::active_tab(&state, id).map(|tab| ScriptTab::with_id(tab.as_str()))
            })
        }

        #[unsafe(method_id(URL))]
        fn url(&self) -> Retained<NSString> {
            let id = &self.ivars().id;
            ns(&guarded(String::new(), || {
                state()
                    .and_then(|s| s.active_tab(id).map(|t| t.url.clone()))
                    .unwrap_or_default()
            }))
        }

        #[unsafe(method(activeTabIndex))]
        fn active_tab_index(&self) -> isize {
            let id = &self.ivars().id;
            guarded(0, || {
                let Some(state) = state() else { return 0 };
                let active = super::active_tab(&state, id);
                super::window_tabs(&state, id)
                    .iter()
                    .position(|t| Some(t) == active.as_ref())
                    .map_or(0, |i| i as isize + 1)
            })
        }

        #[unsafe(method(setActiveTabIndex:))]
        fn set_active_tab_index(&self, index: isize) {
            submit(current_command(), ScriptRequest::SetActiveTabIndex {
                window: self.ivars().id.clone(),
                index,
            });
        }

        #[unsafe(method_id(activeProfile))]
        fn active_profile(&self) -> Option<Retained<ScriptProfile>> {
            let id = &self.ivars().id;
            guarded(None, || {
                let state = state()?;
                let window = state.window(id)?;
                if window.kind == ardia_state::windows::WindowKind::Incognito
                    || window.profile_id.is_incognito()
                {
                    return None;
                }
                Some(ScriptProfile::with_id(window.profile_id.as_str()))
            })
        }

        #[unsafe(method(incognito))]
        fn incognito(&self) -> bool {
            let id = &self.ivars().id;
            guarded(false, || {
                state()
                    .and_then(|s| {
                        s.window(id)
                            .map(|w| w.kind == ardia_state::windows::WindowKind::Incognito)
                    })
                    .unwrap_or(false)
            })
        }

        #[unsafe(method(isVisible))]
        fn is_visible(&self) -> bool {
            let id = &self.ivars().id;
            guarded(false, || {
                native_window(id, |w| unsafe {
                    let shown: bool = msg_send![w, isVisible];
                    shown
                })
                .unwrap_or(false)
            })
        }

        #[unsafe(method(isMiniaturized))]
        fn is_miniaturized(&self) -> bool {
            let id = &self.ivars().id;
            guarded(false, || {
                native_window(id, |w| unsafe {
                    let minimized: bool = msg_send![w, isMiniaturized];
                    minimized
                })
                .unwrap_or(false)
            })
        }

        #[unsafe(method(setIsMiniaturized:))]
        fn set_is_miniaturized(&self, on: bool) {
            let id = &self.ivars().id;
            guarded((), || {
                native_window(id, |w| unsafe {
                    let nobody: *mut AnyObject = std::ptr::null_mut();
                    if on {
                        let _: () = msg_send![w, miniaturize: nobody];
                    } else {
                        let _: () = msg_send![w, deminiaturize: nobody];
                    }
                });
            })
        }

        #[unsafe(method(isZoomed))]
        fn is_zoomed(&self) -> bool {
            let id = &self.ivars().id;
            guarded(false, || {
                native_window(id, |w| unsafe {
                    let zoomed: bool = msg_send![w, isZoomed];
                    zoomed
                })
                .unwrap_or(false)
            })
        }

        #[unsafe(method(setIsZoomed:))]
        fn set_is_zoomed(&self, on: bool) {
            let id = &self.ivars().id;
            guarded((), || {
                native_window(id, |w| unsafe {
                    let zoomed: bool = msg_send![w, isZoomed];
                    if zoomed != on {
                        let nobody: *mut AnyObject = std::ptr::null_mut();
                        let _: () = msg_send![w, zoom: nobody];
                    }
                });
            })
        }

        #[unsafe(method_id(appleScriptTabs))]
        fn apple_script_tabs(&self) -> Retained<NSArray<ScriptTab>> {
            let id = &self.ivars().id;
            let tabs = guarded(Vec::new(), || {
                state().map(|s| super::window_tabs(&s, id)).unwrap_or_default()
            });
            let objects: Vec<Retained<ScriptTab>> =
                tabs.iter().map(|t| ScriptTab::with_id(t.as_str())).collect();
            NSArray::from_retained_slice(&objects)
        }

        #[unsafe(method_id(valueInAppleScriptTabsWithUniqueID:))]
        fn tab_with_id(&self, wanted: &NSString) -> Option<Retained<ScriptTab>> {
            let id = &self.ivars().id;
            let wanted = wanted.to_string();
            guarded(None, || {
                let state = state()?;
                super::window_tabs(&state, id)
                    .iter()
                    .any(|t| t.as_str() == wanted)
                    .then(|| ScriptTab::with_id(&wanted))
            })
        }

        #[unsafe(method(handleCloseScriptCommand:))]
        fn handle_close(&self, command: &AnyObject) -> *mut AnyObject {
            submit(
                retained(command),
                ScriptRequest::CloseWindow {
                window: self.ivars().id.clone(),
            })
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "ArdiaScriptTab"]
    #[ivars = ScriptId]
    pub struct ScriptTab;

    impl ScriptTab {
        #[unsafe(method_id(uniqueID))]
        fn unique_id(&self) -> Retained<NSString> {
            ns(&self.ivars().id)
        }

        #[unsafe(method_id(objectSpecifier))]
        fn object_specifier(&self) -> Option<Retained<AnyObject>> {
            tab_specifier(&self.ivars().id)
        }

        #[unsafe(method_id(title))]
        fn title(&self) -> Retained<NSString> {
            let id = &self.ivars().id;
            ns(&guarded(String::new(), || {
                state().map(|s| super::tab_title(&s, id)).unwrap_or_default()
            }))
        }

        #[unsafe(method_id(URL))]
        fn url(&self) -> Retained<NSString> {
            let id = &self.ivars().id;
            ns(&guarded(String::new(), || {
                state()
                    .and_then(|s| s.tab(id).map(|t| t.url.clone()))
                    .unwrap_or_default()
            }))
        }

        #[unsafe(method(setURL:))]
        fn set_url(&self, url: Option<&NSString>) {
            submit(current_command(), ScriptRequest::SetUrl {
                tab: self.ivars().id.clone(),
                url: url.map(|u| u.to_string()).unwrap_or_default(),
            });
        }

        #[unsafe(method(loading))]
        fn loading(&self) -> bool {
            let id = &self.ivars().id;
            guarded(false, || {
                state().and_then(|s| s.tab(id).map(|t| t.live.loading)).unwrap_or(false)
            })
        }

        #[unsafe(method(isPinned))]
        fn is_pinned(&self) -> bool {
            let id = &self.ivars().id;
            guarded(false, || {
                state().and_then(|s| s.tab(id).map(|t| t.pin.is_some())).unwrap_or(false)
            })
        }

        #[unsafe(method(isFocused))]
        fn is_focused(&self) -> bool {
            let id = &self.ivars().id;
            guarded(false, || {
                state()
                    .and_then(|s| {
                        let window = super::tab_window(&s, id)?;
                        Some(super::active_tab(&s, window.as_str())?.as_str() == id)
                    })
                    .unwrap_or(false)
            })
        }

        #[unsafe(method(handleCloseScriptCommand:))]
        fn handle_close(&self, command: &AnyObject) -> *mut AnyObject {
            submit(
                retained(command),
                ScriptRequest::CloseTab { tab: self.ivars().id.clone() })
        }

        #[unsafe(method(handleReloadScriptCommand:))]
        fn handle_reload(&self, command: &AnyObject) -> *mut AnyObject {
            submit(
                retained(command),
                ScriptRequest::Reload { tab: self.ivars().id.clone() })
        }

        #[unsafe(method(handleGoBackScriptCommand:))]
        fn handle_back(&self, command: &AnyObject) -> *mut AnyObject {
            submit(
                retained(command),
                ScriptRequest::Back { tab: self.ivars().id.clone() })
        }

        #[unsafe(method(handleGoForwardScriptCommand:))]
        fn handle_forward(&self, command: &AnyObject) -> *mut AnyObject {
            submit(
                retained(command),
                ScriptRequest::Forward { tab: self.ivars().id.clone() })
        }

        #[unsafe(method(handleFocusScriptCommand:))]
        fn handle_focus(&self, command: &AnyObject) -> *mut AnyObject {
            submit(
                retained(command),
                ScriptRequest::FocusTab { tab: self.ivars().id.clone() })
        }

        #[unsafe(method(handleExecuteScriptCommand:))]
        fn handle_execute(&self, command: &AnyObject) -> *mut AnyObject {
            let code = guarded(None, || unsafe {
                let arguments: Option<Retained<NSDictionary<NSString, AnyObject>>> =
                    msg_send![command, evaluatedArguments];
                let value = arguments?.objectForKey(&ns("javascript"))?;
                value.downcast::<NSString>().ok().map(|s| s.to_string())
            });
            let Some(code) = code else {
                set_error(command, &ScriptError::failed(MISSING_JAVASCRIPT));
                return std::ptr::null_mut();
            };
            submit(retained(command), ScriptRequest::Execute { tab: self.ivars().id.clone(), code })
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "ArdiaScriptProfile"]
    #[ivars = ScriptId]
    pub struct ScriptProfile;

    impl ScriptProfile {
        #[unsafe(method_id(uniqueID))]
        fn unique_id(&self) -> Retained<NSString> {
            ns(&self.ivars().id)
        }

        #[unsafe(method_id(objectSpecifier))]
        fn object_specifier(&self) -> Option<Retained<AnyObject>> {
            app_specifier("appleScriptProfiles", &self.ivars().id)
        }

        #[unsafe(method_id(name))]
        fn name(&self) -> Retained<NSString> {
            let id = &self.ivars().id;
            ns(&guarded(String::new(), || {
                state().and_then(|s| s.profile(id).map(|p| p.name.clone())).unwrap_or_default()
            }))
        }

        #[unsafe(method(orderedIndex))]
        fn ordered_index(&self) -> isize {
            let id = &self.ivars().id;
            guarded(0, || {
                state()
                    .and_then(|s| s.profile_order.iter().position(|p| p.as_str() == id))
                    .map_or(0, |i| i as isize + 1)
            })
        }

        #[unsafe(method_id(appleScriptTabs))]
        fn apple_script_tabs(&self) -> Retained<NSArray<ScriptTab>> {
            let id = &self.ivars().id;
            let tabs = guarded(Vec::new(), || {
                state()
                    .map(|s| super::profile_tabs(&s, id, &ordered_windows(&s)))
                    .unwrap_or_default()
            });
            let objects: Vec<Retained<ScriptTab>> =
                tabs.iter().map(|t| ScriptTab::with_id(t.as_str())).collect();
            NSArray::from_retained_slice(&objects)
        }

        #[unsafe(method(handleFocusScriptCommand:))]
        fn handle_focus(&self, command: &AnyObject) -> *mut AnyObject {
            submit(
                retained(command),
                ScriptRequest::FocusProfile { profile: self.ivars().id.clone() })
        }
    }
);

impl ScriptWindow {
    pub fn with_id(id: &str) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ScriptId { id: id.to_owned() });
        unsafe { msg_send![super(this), init] }
    }
}

impl ScriptTab {
    pub fn with_id(id: &str) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ScriptId { id: id.to_owned() });
        unsafe { msg_send![super(this), init] }
    }
}

impl ScriptProfile {
    pub fn with_id(id: &str) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ScriptId { id: id.to_owned() });
        unsafe { msg_send![super(this), init] }
    }
}

fn class_description(class: &AnyClass) -> Option<Retained<AnyObject>> {
    unsafe {
        msg_send![
            class!(NSScriptClassDescription),
            classDescriptionForClass: class
        ]
    }
}

fn unique_id_specifier(
    container_class: &AnyClass,
    container: Option<&AnyObject>,
    key: &str,
    id: &str,
) -> Option<Retained<AnyObject>> {
    let description = class_description(container_class)?;
    let class = AnyClass::get(c"NSUniqueIDSpecifier")?;
    unsafe {
        let allocated: objc2::rc::Allocated<AnyObject> = msg_send![class, alloc];
        msg_send![
            allocated,
            initWithContainerClassDescription: &*description,
            containerSpecifier: container,
            key: &*ns(key),
            uniqueID: &*ns(id)
        ]
    }
}

fn app_class() -> Option<&'static AnyClass> {
    unsafe {
        let app: Option<Retained<AnyObject>> = msg_send![class!(NSApplication), sharedApplication];
        app.map(|app| app.class())
    }
}

fn app_specifier(key: &str, id: &str) -> Option<Retained<AnyObject>> {
    unique_id_specifier(app_class()?, None, key, id)
}

fn window_specifier(id: &str) -> Option<Retained<AnyObject>> {
    app_specifier("appleScriptWindows", id)
}

fn tab_specifier(id: &str) -> Option<Retained<AnyObject>> {
    let window = state().and_then(|s| super::tab_window(&s, id))?;
    let container = window_specifier(window.as_str())?;
    unique_id_specifier(
        ScriptWindow::class(),
        Some(&container),
        "appleScriptTabs",
        id,
    )
}

fn set_error(command: &AnyObject, error: &ScriptError) {
    unsafe {
        let _: () = msg_send![command, setScriptErrorNumber: error.number()];
        let _: () = msg_send![command, setScriptErrorString: &*ns(error.message())];
    }
}

fn current_command() -> Option<Retained<AnyObject>> {
    unsafe { msg_send![class!(NSScriptCommand), currentCommand] }
}

fn retained(command: &AnyObject) -> Option<Retained<AnyObject>> {
    unsafe { Retained::retain(command as *const AnyObject as *mut AnyObject) }
}

fn submit(command: Option<Retained<AnyObject>>, request: ScriptRequest) -> *mut AnyObject {
    let Some(sender) = QUEUE.lock().clone() else {
        if let Some(command) = command.as_deref() {
            set_error(command, &ScriptError::failed(NOT_READY));
        }
        return std::ptr::null_mut();
    };
    if objc2::MainThreadMarker::new().is_some() {
        if let Some(command) = command.as_deref() {
            unsafe {
                let _: () = msg_send![command, suspendExecution];
            }
        }
        let pending = Pending {
            request,
            answer: Answer::Resume(MainCommand(command)),
        };
        if let Err(refused) = sender.unbounded_send(pending) {
            refused
                .into_inner()
                .answer
                .give(Err(ScriptError::failed(NOT_READY)));
        }
        return std::ptr::null_mut();
    }
    let (reply, answer) = std::sync::mpsc::channel();
    let pending = Pending {
        request,
        answer: Answer::Wait(reply),
    };
    let result = if sender.unbounded_send(pending).is_ok() {
        answer
            .recv_timeout(REPLY_DEADLINE + std::time::Duration::from_secs(1))
            .unwrap_or_else(|_| Err(ScriptError::failed(TIMED_OUT)))
    } else {
        Err(ScriptError::failed(NOT_READY))
    };
    match result {
        Ok(reply) => guarded(None, || reply_object(reply)).map_or(std::ptr::null_mut(), |value| {
            Retained::autorelease_return(value)
        }),
        Err(problem) => {
            if let Some(command) = command.as_deref() {
                set_error(command, &problem);
            }
            std::ptr::null_mut()
        }
    }
}

fn reply_object(reply: ScriptReply) -> Option<Retained<AnyObject>> {
    match reply {
        ScriptReply::Done => None,
        ScriptReply::Window(window) => window_specifier(window.as_str()),
        ScriptReply::Tab(tab) => tab_specifier(tab.as_str()),
        ScriptReply::Text(text) => Some(ns(&text).into_super().into_super()),
    }
}

fn finish(command: Option<&AnyObject>, result: ScriptResult) {
    let Some(command) = command else {
        if let Err(problem) = result {
            log::debug!("an AppleScript change didn't apply: {}", problem.message());
        }
        return;
    };
    let value = match result {
        Ok(reply) => guarded(None, || reply_object(reply)),
        Err(problem) => {
            set_error(command, &problem);
            None
        }
    };
    unsafe {
        let _: () = msg_send![command, resumeExecutionWithResult: value.as_deref()];
    }
}

extern "C-unwind" fn app_windows(_this: &AnyObject, _sel: Sel) -> *mut AnyObject {
    let windows = guarded(Vec::new(), || {
        state().map(|s| ordered_windows(&s)).unwrap_or_default()
    });
    let objects: Vec<Retained<ScriptWindow>> = windows
        .iter()
        .map(|w| ScriptWindow::with_id(w.as_str()))
        .collect();
    Retained::autorelease_return(NSArray::from_retained_slice(&objects)).cast()
}

extern "C-unwind" fn app_window_with_id(
    _this: &AnyObject,
    _sel: Sel,
    wanted: *mut AnyObject,
) -> *mut AnyObject {
    let wanted = unsafe { wanted.cast::<NSString>().as_ref() }.map(|s| s.to_string());
    let found = guarded(None, || {
        let wanted = clean_id(&wanted?)?;
        let state = state()?;
        super::scripted_windows(&state, &[])
            .iter()
            .any(|w| w.as_str() == wanted)
            .then(|| ScriptWindow::with_id(&wanted))
    });
    found.map_or(std::ptr::null_mut(), |w| {
        Retained::autorelease_return(w).cast()
    })
}

extern "C-unwind" fn app_profiles(_this: &AnyObject, _sel: Sel) -> *mut AnyObject {
    let profiles = guarded(Vec::new(), || {
        state()
            .map(|s| s.profile_order.iter().map(|p| p.to_string()).collect())
            .unwrap_or_default()
    });
    let objects: Vec<Retained<ScriptProfile>> =
        profiles.iter().map(|p| ScriptProfile::with_id(p)).collect();
    Retained::autorelease_return(NSArray::from_retained_slice(&objects)).cast()
}

extern "C-unwind" fn app_version(_this: &AnyObject, _sel: Sel) -> *mut AnyObject {
    let version = unsafe {
        let bundle: Retained<AnyObject> = msg_send![class!(NSBundle), mainBundle];
        let value: Option<Retained<AnyObject>> =
            msg_send![&*bundle, objectForInfoDictionaryKey: &*ns("CFBundleShortVersionString")];
        value
            .and_then(|v| v.downcast::<NSString>().ok())
            .unwrap_or_else(|| ns(""))
    };
    Retained::autorelease_return(version).cast()
}

fn property(
    dictionary: &NSDictionary<NSString, AnyObject>,
    key: &str,
) -> Option<Retained<AnyObject>> {
    dictionary.objectForKey(&ns(key))
}

fn id_of(object: &AnyObject, class: &AnyClass) -> Option<String> {
    let kind: bool = unsafe { msg_send![object, isKindOfClass: class] };
    if !kind {
        return None;
    }
    let id: Retained<NSString> = unsafe { msg_send![object, uniqueID] };
    Some(id.to_string())
}

fn create_request(command: &AnyObject) -> Result<ScriptRequest, ScriptError> {
    let (class_name, properties, location) = unsafe {
        let description: Option<Retained<AnyObject>> = msg_send![command, createClassDescription];
        let class_name: Option<Retained<NSString>> =
            description.and_then(|d| msg_send![&*d, className]);
        let properties: Option<Retained<NSDictionary<NSString, AnyObject>>> =
            msg_send![command, resolvedKeyDictionary];
        let arguments: Option<Retained<NSDictionary<NSString, AnyObject>>> =
            msg_send![command, arguments];
        let location = arguments.and_then(|a| a.objectForKey(&ns("Location")));
        (
            class_name.map(|c| c.to_string()).unwrap_or_default(),
            properties.unwrap_or_default(),
            location,
        )
    };
    let url = property(&properties, "URL")
        .and_then(|v| v.downcast::<NSString>().ok())
        .map(|s| s.to_string());
    match class_name.as_str() {
        "window" => {
            let incognito = property(&properties, "incognito")
                .and_then(|v| v.downcast::<NSNumber>().ok())
                .is_some_and(|n| n.as_bool());
            let profile = property(&properties, "activeProfile")
                .and_then(|p| id_of(&p, ScriptProfile::class()));
            Ok(ScriptRequest::NewWindow {
                url,
                incognito,
                profile,
            })
        }
        "tab" => {
            let positioned = location.as_ref().is_some_and(|l| {
                AnyClass::get(c"NSPositionalSpecifier")
                    .is_some_and(|c| unsafe { msg_send![&**l, isKindOfClass: c] })
            });
            let (container, index) = location
                .filter(|l| {
                    AnyClass::get(c"NSPositionalSpecifier")
                        .is_some_and(|c| unsafe { msg_send![&**l, isKindOfClass: c] })
                })
                .map(|l| unsafe {
                    let container: Option<Retained<AnyObject>> = msg_send![&*l, insertionContainer];
                    let index: isize = msg_send![&*l, insertionIndex];
                    (container, index)
                })
                .unwrap_or((None, -1));
            let window = container.and_then(|c| id_of(&c, ScriptWindow::class()));
            let window = window.or_else(|| positioned.then(String::new));
            Ok(ScriptRequest::NewTab {
                url,
                index: (window.is_some() && index >= 0).then_some(index),
                window,
            })
        }
        other => Err(ScriptError::Failed(format!(
            "Ardia can't make a new {}.",
            if other.is_empty() { "object" } else { other }
        ))),
    }
}

extern "C-unwind" fn perform_create(this: &AnyObject, _sel: Sel) -> *mut AnyObject {
    let failed: isize = unsafe { msg_send![this, scriptErrorNumber] };
    if failed != 0 {
        return std::ptr::null_mut();
    }
    match guarded(Err(ScriptError::failed(NOT_READY)), || create_request(this)) {
        Ok(request) => submit(retained(this), request),
        Err(problem) => {
            let failed: isize = unsafe { msg_send![this, scriptErrorNumber] };
            if failed == 0 {
                set_error(this, &problem);
            }
            std::ptr::null_mut()
        }
    }
}

fn own_method(class: &AnyClass, selector: Sel, imp: Imp, types: &std::ffi::CStr) -> bool {
    unsafe {
        objc2::ffi::class_replaceMethod(
            class as *const AnyClass as *mut AnyClass,
            selector,
            imp,
            types.as_ptr(),
        );
    }
    class
        .instance_method(selector)
        .is_some_and(|method| method.implementation() as usize == imp as usize)
}

fn register_create_command() -> bool {
    if AnyClass::get(c"ArdiaScriptCreateCommand").is_some() {
        return true;
    }
    let Some(superclass) = AnyClass::get(c"NSCreateCommand") else {
        return false;
    };
    let Some(mut builder) = ClassBuilder::new(c"ArdiaScriptCreateCommand", superclass) else {
        return false;
    };
    unsafe {
        builder.add_method(
            sel!(performDefaultImplementation),
            perform_create as extern "C-unwind" fn(_, _) -> _,
        );
    }
    builder.register();
    true
}

type Getter = extern "C-unwind" fn(&AnyObject, Sel) -> *mut AnyObject;
type Lookup = extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> *mut AnyObject;

fn extend_application() -> bool {
    let Some(class) = app_class() else {
        return false;
    };
    let getters: [(Sel, Getter); 3] = [
        (sel!(appleScriptWindows), app_windows),
        (sel!(appleScriptProfiles), app_profiles),
        (sel!(version), app_version),
    ];
    let mut owned = true;
    for (selector, getter) in getters {
        let imp = unsafe { std::mem::transmute::<Getter, Imp>(getter) };
        owned &= own_method(class, selector, imp, c"@@:");
    }
    let lookup: Lookup = app_window_with_id;
    let imp = unsafe { std::mem::transmute::<Lookup, Imp>(lookup) };
    owned &= own_method(
        class,
        sel!(valueInAppleScriptWindowsWithUniqueID:),
        imp,
        c"@@:@",
    );
    owned
}

pub type LocalSpawn = Rc<dyn Fn(LocalBoxFuture<'static, ()>)>;
pub type Deadline = Rc<dyn Fn(Duration) -> LocalBoxFuture<'static, ()>>;

pub fn register() -> bool {
    let _ = (
        ScriptWindow::class(),
        ScriptTab::class(),
        ScriptProfile::class(),
    );
    let created = register_create_command();
    let extended = extend_application();
    if !(created && extended) {
        log::warn!(
            "AppleScript support is incomplete (create command {created}, application keys {extended})"
        );
    }
    created && extended
}

pub fn serve(coordinator: &Arc<AppCoordinator>, spawn: LocalSpawn, deadline: Deadline) {
    let _ = coordinator_cell().set(Arc::downgrade(coordinator));
    let (sender, mut receiver) = unbounded::<Pending>();
    *QUEUE.lock() = Some(sender);
    let weak = Arc::downgrade(coordinator);
    let runner = spawn.clone();
    spawn(Box::pin(async move {
        while let Some(Pending { request, answer }) = receiver.next().await {
            let Some(coordinator) = weak.upgrade() else {
                answer.give(Err(ScriptError::failed(NOT_READY)));
                continue;
            };
            let work = guarded(None, || Some(super::run(&coordinator, request)));
            let Some(work) = work else {
                answer.give(Err(ScriptError::failed(NOT_READY)));
                continue;
            };
            let late = deadline(REPLY_DEADLINE);
            runner(Box::pin(async move {
                let result = match futures::future::select(work, late).await {
                    futures::future::Either::Left((result, _)) => result,
                    futures::future::Either::Right(_) => Err(ScriptError::failed(TIMED_OUT)),
                };
                answer.give(result);
            }));
        }
    }));
}

pub fn install(cx: &mut App, coordinator: Arc<AppCoordinator>) {
    if objc2::MainThreadMarker::new().is_none() {
        return;
    }
    register();
    let executor = cx.foreground_executor().clone();
    let timers = cx.background_executor().clone();
    serve(
        &coordinator,
        Rc::new(move |task| executor.spawn(task).detach()),
        Rc::new(move |wait| {
            let timer = timers.timer(wait);
            Box::pin(timer)
        }),
    );
    log::info!("AppleScript support installed");
}
