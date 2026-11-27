use std::ffi::{c_char, c_void};

pub type Status = i32;

pub const OK: Status = 0;
pub const NOT_LOADED: Status = 1;
pub const NOT_STARTED: Status = 2;
pub const WRONG_THREAD: Status = 3;
pub const UNKNOWN_WINDOW: Status = 4;
pub const UNKNOWN_TAB: Status = 5;
pub const UNKNOWN_PROFILE: Status = 6;
pub const UNSUPPORTED: Status = 7;
pub const BAD_ARGUMENT: Status = 8;
pub const FAILED: Status = 9;
pub const ALREADY_RUNNING: Status = 10;
pub const NO_HOST: Status = 11;

pub const CREATE_WINDOW: u64 = u64::MAX;

pub type HostedVoidSuper = unsafe extern "C" fn(thunk: *mut c_void);
pub type HostedBoolSuper = unsafe extern "C" fn(thunk: *mut c_void) -> bool;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct HostedHookTable {
    pub size: u32,
    pub context: *mut c_void,
    pub send_event: unsafe extern "C" fn(
        context: *mut c_void,
        window: *mut c_void,
        event: *mut c_void,
        call_super: HostedVoidSuper,
        thunk: *mut c_void,
    ),
    pub key_down: unsafe extern "C" fn(
        context: *mut c_void,
        window: *mut c_void,
        event: *mut c_void,
        call_super: HostedVoidSuper,
        thunk: *mut c_void,
    ),
    pub make_first_responder: unsafe extern "C" fn(
        context: *mut c_void,
        window: *mut c_void,
        responder: *mut c_void,
        call_super: HostedBoolSuper,
        thunk: *mut c_void,
    ) -> bool,
    pub perform_key_equivalent: unsafe extern "C" fn(
        context: *mut c_void,
        window: *mut c_void,
        event: *mut c_void,
        call_super: HostedBoolSuper,
        thunk: *mut c_void,
    ) -> bool,
}

#[repr(C)]
pub struct BridgeHost {
    pub size: u32,
    pub context: *mut c_void,
    pub event: unsafe extern "C" fn(context: *mut c_void, json: *const c_char),
    pub decide: unsafe extern "C" fn(context: *mut c_void, json: *const c_char) -> i32,
    pub new_window:
        unsafe extern "C" fn(context: *mut c_void, profile: u64, kind: *const c_char) -> u64,
    pub answer: unsafe extern "C" fn(context: *mut c_void, json: *const c_char) -> *mut c_char,
    pub release_answer: unsafe extern "C" fn(context: *mut c_void, answer: *mut c_char),
    pub complete: unsafe extern "C" fn(
        context: *mut c_void,
        request: u64,
        status: i32,
        json: *const c_char,
        bytes: *const u8,
        length: usize,
    ),
}

unsafe extern "C" {
    pub fn ardia_bridge_install(host: *const BridgeHost) -> Status;
    pub fn ardia_bridge_is_main_thread() -> bool;
    pub fn ardia_bridge_check_classes(image: *const c_char) -> *mut c_char;
    pub fn ardia_bridge_engine_started() -> bool;
    pub fn ardia_bridge_release_confirms(close_anyway: bool, released: *mut u64) -> Status;
    pub fn ardia_bridge_run(argc: i32, argv: *const *const c_char, exit_code: *mut i32) -> Status;
    pub fn ardia_bridge_engine_call(json: *const c_char, out_json: *mut *mut c_char) -> Status;
    pub fn ardia_bridge_engine_async(json: *const c_char, request: u64) -> Status;
    pub fn ardia_bridge_profile_call(
        profile: u64,
        json: *const c_char,
        out_json: *mut *mut c_char,
    ) -> Status;
    pub fn ardia_bridge_profile_async(profile: u64, json: *const c_char, request: u64) -> Status;
    pub fn ardia_bridge_window_create(
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        out_window: *mut u64,
    ) -> Status;
    pub fn ardia_bridge_window_call(
        window: u64,
        json: *const c_char,
        out_json: *mut *mut c_char,
    ) -> Status;
    pub fn ardia_bridge_window_object(
        window: u64,
        which: u32,
        out_object: *mut *mut c_void,
    ) -> Status;
    pub fn ardia_bridge_tab_call(
        tab: u64,
        json: *const c_char,
        out_json: *mut *mut c_char,
    ) -> Status;
    pub fn ardia_bridge_tab_async(tab: u64, json: *const c_char, request: u64) -> Status;
    pub fn ardia_bridge_tab_view(tab: u64, which: u32, out_view: *mut *mut c_void) -> Status;
    pub fn ardia_bridge_tab_password(
        tab: u64,
        action: *const c_char,
        username: *const c_char,
        password: *const u8,
        length: usize,
    ) -> Status;
    pub fn ardia_bridge_page_view(view: *mut c_void, query: u32, out_answer: *mut bool) -> Status;
    pub fn ardia_bridge_set_scroll_observer(enabled: bool) -> Status;
    pub fn ardia_bridge_retain(object: *mut c_void);
    pub fn ardia_bridge_release(object: *mut c_void);
    pub fn ardia_bridge_free(text: *mut c_char);
    pub fn ardia_bridge_install_background_guard() -> Status;
    pub fn ardia_bridge_background_guard_installed() -> bool;
    pub fn ardia_bridge_window_levels(
        window: *mut c_void,
        asked: *mut i64,
        actual: *mut i64,
    ) -> Status;
    pub fn ardia_bridge_menu_install(json: *const c_char) -> Status;
    pub fn ardia_bridge_menu_build_describe(
        json: *const c_char,
        out_json: *mut *mut c_char,
    ) -> Status;
    pub fn ardia_bridge_alert(json: *const c_char, window: *mut c_void, request: u64) -> Status;
    pub fn ardia_bridge_alert_describe(json: *const c_char, out_json: *mut *mut c_char) -> Status;
    pub fn ardia_bridge_file_panel(
        json: *const c_char,
        window: *mut c_void,
        request: u64,
    ) -> Status;
    pub fn ardia_bridge_share(
        json: *const c_char,
        view: *mut c_void,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Status;
    pub fn ardia_bridge_workspace(json: *const c_char, out_json: *mut *mut c_char) -> Status;
    pub fn ardia_bridge_install_app_events(urls: bool, reopen: bool) -> Status;
    pub fn ardia_bridge_set_handoff(
        window: *mut c_void,
        url: *const c_char,
        title: *const c_char,
    ) -> Status;
    pub fn ardia_bridge_style_browser_window(window: *mut c_void) -> Status;
    pub fn ardia_bridge_hosted_hooks_install(hooks: *const HostedHookTable) -> Status;
    pub fn ardia_bridge_hosted_hooks_remove(restored: *mut u64) -> Status;
    pub fn ardia_bridge_hosted_hooks_installed() -> bool;
    pub fn ardia_bridge_hosted_window_attach(window: *mut c_void) -> Status;
    pub fn ardia_bridge_hosted_window_attach_engine(window: u64) -> Status;
    pub fn ardia_bridge_hosted_window_detach(window: *mut c_void) -> Status;
    pub fn ardia_bridge_hosted_window_attached(window: *mut c_void) -> bool;
    pub fn ardia_bridge_hosted_window_count() -> u64;
}
