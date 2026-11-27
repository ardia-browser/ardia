use std::collections::BTreeMap;
use std::ffi::c_void;
use std::fmt;
use std::num::NonZeroU64;

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

macro_rules! engine_id {
    ($name:ident, $prefix:literal) => {
        #[derive(
            Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(NonZeroU64);

        impl $name {
            pub const fn from_raw(raw: u64) -> Option<Self> {
                match NonZeroU64::new(raw) {
                    Some(raw) => Some(Self(raw)),
                    None => None,
                }
            }

            pub const fn get(self) -> u64 {
                self.0.get()
            }

            pub fn raw_or_zero(id: Option<Self>) -> u64 {
                id.map_or(0, Self::get)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!($prefix, "{}"), self.0)
            }
        }
    };
}

engine_id!(EngineWindowId, "window-");
engine_id!(EngineTabId, "tab-");
engine_id!(EngineProfileId, "profile-");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct NativeViewHandle(pub *mut c_void);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct NativeWindowHandle(pub *mut c_void);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ViewToken(u64);

impl ViewToken {
    pub const fn from_raw(raw: u64) -> Option<Self> {
        if raw == 0 { None } else { Some(Self(raw)) }
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl NativeViewHandle {
    pub const NULL: Self = Self(std::ptr::null_mut());

    pub const fn as_ptr(self) -> *mut c_void {
        self.0
    }

    pub fn is_null(self) -> bool {
        self.0.is_null()
    }

    pub fn token(self) -> ViewToken {
        ViewToken(self.0 as usize as u64)
    }
}

impl NativeWindowHandle {
    pub const NULL: Self = Self(std::ptr::null_mut());

    pub const fn as_ptr(self) -> *mut c_void {
        self.0
    }

    pub fn is_null(self) -> bool {
        self.0.is_null()
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ObjectOwnership {
    pub(crate) retain: unsafe extern "C" fn(*mut c_void),
    pub(crate) release: unsafe extern "C" fn(*mut c_void),
}

pub struct NativeView {
    handle: NativeViewHandle,
    ownership: Option<ObjectOwnership>,
}

impl NativeView {
    pub fn borrowed(handle: NativeViewHandle) -> Self {
        Self {
            handle,
            ownership: None,
        }
    }

    #[cfg(any(target_os = "macos", test))]
    pub(crate) unsafe fn adopt_retained(
        handle: NativeViewHandle,
        ownership: ObjectOwnership,
    ) -> Self {
        Self {
            handle,
            ownership: (!handle.is_null()).then_some(ownership),
        }
    }

    pub fn handle(&self) -> NativeViewHandle {
        self.handle
    }

    pub fn token(&self) -> ViewToken {
        self.handle.token()
    }

    pub fn is_owned(&self) -> bool {
        self.ownership.is_some()
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn live_object(&self) -> Option<*mut c_void> {
        self.ownership.map(|_| self.handle.as_ptr())
    }
}

impl Clone for NativeView {
    fn clone(&self) -> Self {
        if let Some(ownership) = self.ownership {
            unsafe { (ownership.retain)(self.handle.as_ptr()) };
        }
        Self {
            handle: self.handle,
            ownership: self.ownership,
        }
    }
}

impl Drop for NativeView {
    fn drop(&mut self) {
        if let Some(ownership) = self.ownership.take() {
            unsafe { (ownership.release)(self.handle.as_ptr()) };
        }
    }
}

impl fmt::Debug for NativeView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NativeView")
            .field("handle", &self.handle)
            .field("owned", &self.is_owned())
            .finish()
    }
}

pub struct NativeWindow {
    handle: NativeWindowHandle,
    ownership: Option<ObjectOwnership>,
}

impl NativeWindow {
    pub fn borrowed(handle: NativeWindowHandle) -> Self {
        Self {
            handle,
            ownership: None,
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) unsafe fn adopt_retained(
        handle: NativeWindowHandle,
        ownership: ObjectOwnership,
    ) -> Self {
        Self {
            handle,
            ownership: (!handle.is_null()).then_some(ownership),
        }
    }

    pub fn handle(&self) -> NativeWindowHandle {
        self.handle
    }

    pub fn is_owned(&self) -> bool {
        self.ownership.is_some()
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn live_object(&self) -> Option<*mut c_void> {
        self.ownership.map(|_| self.handle.as_ptr())
    }
}

impl Clone for NativeWindow {
    fn clone(&self) -> Self {
        if let Some(ownership) = self.ownership {
            unsafe { (ownership.retain)(self.handle.as_ptr()) };
        }
        Self {
            handle: self.handle,
            ownership: self.ownership,
        }
    }
}

impl Drop for NativeWindow {
    fn drop(&mut self) {
        if let Some(ownership) = self.ownership.take() {
            unsafe { (ownership.release)(self.handle.as_ptr()) };
        }
    }
}

impl fmt::Debug for NativeWindow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NativeWindow")
            .field("handle", &self.handle)
            .field("owned", &self.is_owned())
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineBackend {
    Mac,
    Linux,
    Windows,
    Mock,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn is_valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width >= 0.0
            && self.height >= 0.0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

impl Rgba {
    pub fn clamped(self) -> Self {
        let unit = |v: f64| {
            if v.is_finite() {
                v.clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        Self {
            r: unit(self.r),
            g: unit(self.g),
            b: unit(self.b),
            a: unit(self.a),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Adoption {
    Refused,
    Adopted,
    Busy,
}

impl Adoption {
    pub fn from_raw(raw: i64) -> Self {
        match raw {
            1 => Self::Adopted,
            2 => Self::Busy,
            _ => Self::Refused,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileFlag {
    PasswordsOffered,
    AddressesAutofilled,
    CardsAutofilled,
    PreloadPages,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowsingDataKind {
    Cache,
    Downloads,
    History,
    SiteData,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionViewKind {
    Popup,
    SidePanel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NewBrowserKind {
    Normal,
    Popup,
    App,
    Devtools,
    Other,
}

impl NewBrowserKind {
    pub fn parse(kind: &str) -> Self {
        match kind {
            "normal" => Self::Normal,
            "popup" => Self::Popup,
            "app" | "app_popup" => Self::App,
            "devtools" => Self::Devtools,
            _ => Self::Other,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionResult {
    Accept,
    Deny,
    Dismiss,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DevicePickerAction {
    Cancel,
    Refresh,
    Settings,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PageScrollAck {
    Begin,
    Update,
}

impl PageScrollAck {
    pub fn from_raw(raw: i64) -> Self {
        if raw == 0 { Self::Begin } else { Self::Update }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PageViewQuery {
    IsPageView,
    TakeSwipes,
    TakesSwipes,
    IsEditingText,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Modifiers(pub u32);

impl Modifiers {
    pub const NONE: Self = Self(0);
    pub const CAPS_LOCK: Self = Self(1 << 16);
    pub const SHIFT: Self = Self(1 << 17);
    pub const CONTROL: Self = Self(1 << 18);
    pub const OPTION: Self = Self(1 << 19);
    pub const COMMAND: Self = Self(1 << 20);
    pub const NUMERIC_PAD: Self = Self(1 << 21);
    pub const HELP: Self = Self(1 << 22);
    pub const FUNCTION: Self = Self(1 << 23);
    pub const DEVICE_INDEPENDENT: Self = Self(0xffff_0000);
    pub const CHORD: Self =
        Self(Self::SHIFT.0 | Self::CONTROL.0 | Self::OPTION.0 | Self::COMMAND.0 | Self::FUNCTION.0);

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub const fn intersection(self, other: Self) -> Self {
        Self(self.0 & other.0)
    }

    pub const fn chord(self) -> Self {
        self.intersection(Self::CHORD)
    }
}

impl std::ops::BitOr for Modifiers {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self {
        self.union(rhs)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyChord {
    pub key: String,
    pub modifiers: Modifiers,
}

impl KeyChord {
    pub fn new(key: impl Into<String>, modifiers: Modifiers) -> Self {
        Self {
            key: key.into(),
            modifiers: modifiers.chord(),
        }
    }

    pub fn normalized(&self) -> Self {
        let mut chars = self.key.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if c.is_ascii_uppercase() => Self {
                key: c.to_ascii_lowercase().to_string(),
                modifiers: self.modifiers.chord() | Modifiers::SHIFT,
            },
            _ => Self {
                key: self.key.to_lowercase(),
                modifiers: self.modifiers.chord(),
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyEventKind {
    Down,
    Up,
    FlagsChanged,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyEvent {
    pub kind: KeyEventKind,
    pub key_code: u16,
    pub characters: String,
    pub characters_ignoring_modifiers: String,
    pub modifiers: Modifiers,
    pub is_repeat: bool,
}

impl Default for KeyEvent {
    fn default() -> Self {
        Self {
            kind: KeyEventKind::Down,
            key_code: 0,
            characters: String::new(),
            characters_ignoring_modifiers: String::new(),
            modifiers: Modifiers::NONE,
            is_repeat: false,
        }
    }
}

impl KeyEvent {
    pub fn chord(&self) -> KeyChord {
        KeyChord::new(self.characters_ignoring_modifiers.clone(), self.modifiers).normalized()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileInfo {
    pub name: String,
    pub path: String,
    pub off_the_record: bool,
    pub destroyed: bool,
    pub passwords_offered: bool,
    pub addresses_autofilled: bool,
    pub cards_autofilled: bool,
    pub preload_pages: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowInfo {
    pub frame: Rect,
    pub active_profile: Option<EngineProfileId>,
    pub acted_full_screen: bool,
    pub internal: bool,
    pub automation: bool,
    pub visible: bool,
    pub window_number: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TabInfo {
    pub tab_id: i32,
    pub browser_id: i32,
    pub profile: Option<EngineProfileId>,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub progress: f64,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub closed: bool,
    pub audible: bool,
    pub muted: bool,
    pub discarded: bool,
    pub discard_reason: Option<String>,
    pub frozen: bool,
    pub temporary: bool,
    pub favicon_url: Option<String>,
    pub theme_color: Option<String>,
    pub committed_origin: Option<String>,
    pub committed_http_status: i32,
    pub committed_document_count: i32,
    pub initial_document_accessed: bool,
    pub committed_initial: bool,
    pub asks_before_leaving: bool,
    pub zoom_factor: f64,
    pub pinch_scale: f64,
    pub preferred_size: Size,
    pub media_capture_source_id: Option<String>,
    pub has_dev_tools: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTab {
    pub url: String,
    pub profile: EngineProfileId,
    pub foreground: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NavigationEntry {
    pub url: String,
    pub title: String,
    #[serde(deserialize_with = "lenient_bool")]
    pub committed: bool,
    #[serde(deserialize_with = "lenient_bool")]
    pub current: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecurityLevel {
    #[default]
    None,
    Insecure,
    Local,
    Secure,
    CertificateError,
    Mixed,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SecurityInfo {
    pub level: SecurityLevel,
    pub url: String,
    pub origin: Option<String>,
    pub certificate_errors: Vec<String>,
    pub mixed_content: Option<String>,
    #[serde(rename = "isEV", deserialize_with = "lenient_bool")]
    pub is_ev: bool,
    pub protocol: Option<String>,
    pub certificate: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FindMatches {
    pub count: i32,
    pub active: i32,
    pub final_update: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PasswordPrompt {
    pub state: String,
    pub origin: String,
    pub username: String,
    pub usernames: Vec<String>,
    pub password_length: Option<u32>,
    pub federation: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PasswordPromptAction {
    Save,
    Update,
    Never,
    Nope,
    Dismiss,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutofillPromptAction {
    Accept,
    Decline,
    Dismiss,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutofillPrompt {
    pub id: i64,
    pub kind: String,
    pub title: String,
    pub message: String,
    pub accept: String,
    pub decline: String,
    pub footer: Option<String>,
    pub field: Option<String>,
    pub lines: Vec<Value>,
    pub changes: Vec<Value>,
    #[serde(deserialize_with = "lenient_bool")]
    pub closed: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PermissionRequest {
    pub id: String,
    pub origin: String,
    pub permissions: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceOption {
    pub id: String,
    pub name: String,
    #[serde(deserialize_with = "lenient_bool")]
    pub connected: bool,
    #[serde(deserialize_with = "lenient_bool")]
    pub paired: bool,
    pub signal: Option<i32>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceChooser {
    pub id: i32,
    #[serde(deserialize_with = "lenient_bool")]
    pub open: bool,
    pub event: Option<String>,
    pub url: Option<String>,
    pub options: Vec<DeviceOption>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CastSink {
    pub id: String,
    pub name: String,
    pub status: String,
    pub state: String,
    pub icon: i32,
    pub modes: i32,
    pub route_id: String,
    pub issue: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CastDialog {
    pub id: i32,
    #[serde(deserialize_with = "lenient_bool")]
    pub open: bool,
    pub header: String,
    pub sinks: Vec<CastSink>,
    #[serde(deserialize_with = "lenient_bool")]
    pub casting_started: bool,
    #[serde(deserialize_with = "lenient_bool")]
    pub permission_rejected: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CastRoute {
    pub id: String,
    pub sink: String,
    pub source: String,
    pub description: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtensionActionState {
    #[serde(deserialize_with = "lenient_bool")]
    pub enabled: bool,
    pub title: String,
    pub badge_text: String,
    pub badge_color: Option<String>,
    pub badge_text_color: Option<String>,
    pub icon: Option<String>,
    pub popup: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtensionInstallPrompt {
    pub request_id: String,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub icon: String,
    pub permissions: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaAccess {
    #[serde(deserialize_with = "lenient_bool")]
    pub camera: bool,
    #[serde(deserialize_with = "lenient_bool")]
    pub microphone: bool,
    #[serde(deserialize_with = "lenient_bool")]
    pub screen: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PipKind {
    #[default]
    Video,
    Document,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PipState {
    #[serde(deserialize_with = "lenient_bool")]
    pub active: bool,
    #[serde(deserialize_with = "pip_kind")]
    pub kind: PipKind,
    pub closed_by: Option<String>,
    #[serde(rename = "auto", deserialize_with = "lenient_bool")]
    pub automatic: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TabOffer {
    pub id: String,
    pub url: String,
    pub foreground: bool,
    pub profile: String,
    pub opener: Option<EngineTabId>,
    pub wants_window: bool,
    pub popup: Option<Rect>,
    pub from_click: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DevToolsLayout {
    #[serde(rename = "devTools")]
    pub devtools: Rect,
    pub page: Rect,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PipEntry {
    pub route: String,
    pub opened: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BlockedPopup {
    pub id: String,
    pub url: String,
    pub origin: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContextMenuItem {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "on", content = "value")]
pub enum ContextMenuTarget {
    Selection(String),
    Page(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMessage {
    pub kind: String,
    pub json: String,
    pub frame_id: String,
    pub main_frame: bool,
    pub origin: Option<String>,
}

impl PageMessage {
    pub fn data(&self) -> Option<Value> {
        serde_json::from_str(&self.json).ok()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DownloadItem {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub path: String,
    pub state: String,
    #[serde(deserialize_with = "lenient_bool")]
    pub paused: bool,
    pub received: f64,
    pub total: f64,
    pub speed: f64,
    pub mime_type: String,
    #[serde(deserialize_with = "lenient_bool")]
    pub dangerous: bool,
    pub error: Option<String>,
    #[serde(deserialize_with = "lenient_bool")]
    pub off_the_record: bool,
    pub start_time: f64,
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum DownloadEvent {
    Changed {
        profile: Option<String>,
        item: Box<DownloadItem>,
    },
    Removed {
        profile: Option<String>,
        id: String,
        off_the_record: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct ServiceEvent {
    pub topic: String,
    pub profile: Option<String>,
    pub off_the_record: bool,
    pub payload: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ServiceTopic {
    BookmarksChanged,
    HistoryChanged,
    ExtensionsChanged,
    ExtensionsAction,
    ExtensionsSync,
    ContentBlockerChanged,
    TabsStrips,
    CliControl,
    CliDevTools,
    Other,
}

impl ServiceEvent {
    pub fn topic_kind(&self) -> ServiceTopic {
        match self.topic.as_str() {
            "bookmarks.changed" => ServiceTopic::BookmarksChanged,
            "history.changed" => ServiceTopic::HistoryChanged,
            "extensions.changed" => ServiceTopic::ExtensionsChanged,
            "extensions.action" => ServiceTopic::ExtensionsAction,
            "extensions.sync" => ServiceTopic::ExtensionsSync,
            "contentBlocker.changed" => ServiceTopic::ContentBlockerChanged,
            "tabs.strips" => ServiceTopic::TabsStrips,
            "cliControl" => ServiceTopic::CliControl,
            "cliDevTools" => ServiceTopic::CliDevTools,
            _ => ServiceTopic::Other,
        }
    }
}

pub type ExtensionActionStates = BTreeMap<String, ExtensionActionState>;

pub fn lenient_bool<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::Bool(value) => Ok(value),
        Value::Number(number) => Ok(number.as_f64().is_some_and(|n| n != 0.0)),
        Value::Null => Ok(false),
        Value::String(text) => Ok(matches!(text.as_str(), "true" | "1" | "yes")),
        other => Err(de::Error::custom(format!("expected a flag, got {other}"))),
    }
}

fn pip_kind<'de, D: Deserializer<'de>>(deserializer: D) -> Result<PipKind, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::String(kind) if kind == "document" => PipKind::Document,
        _ => PipKind::Video,
    })
}

pub(crate) fn decode<T: for<'de> Deserialize<'de> + Default>(value: Option<&Value>) -> T {
    value
        .and_then(|v| T::deserialize(v).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_reject_zero_and_round_trip() {
        assert!(EngineTabId::from_raw(0).is_none());
        let tab = EngineTabId::from_raw(42).unwrap();
        assert_eq!(tab.get(), 42);
        assert_eq!(tab.to_string(), "tab-42");
        assert_eq!(serde_json::to_value(tab).unwrap(), json!(42));
        assert_eq!(
            serde_json::from_value::<EngineTabId>(json!(42)).unwrap(),
            tab
        );
        assert!(serde_json::from_value::<EngineTabId>(json!(0)).is_err());
        assert_eq!(EngineTabId::raw_or_zero(None), 0);
        assert_eq!(std::mem::size_of::<Option<EngineTabId>>(), 8);
    }

    #[test]
    fn security_info_reads_engine_keys() {
        let info: SecurityInfo = serde_json::from_value(json!({
            "level": "certificateError",
            "url": "https://example.com/",
            "origin": "https://example.com",
            "certificateErrors": ["DATE_INVALID"],
            "mixedContent": null,
            "isEV": 1,
            "protocol": "TLS 1.3",
            "somethingNew": true
        }))
        .unwrap();
        assert_eq!(info.level, SecurityLevel::CertificateError);
        assert!(info.is_ev);
        assert_eq!(info.certificate_errors, vec!["DATE_INVALID"]);
        assert_eq!(info.extra.get("somethingNew"), Some(&json!(true)));
        let unknown: SecurityInfo = serde_json::from_value(json!({"level": "quantum"})).unwrap();
        assert_eq!(unknown.level, SecurityLevel::Unknown);
    }

    #[test]
    fn lenient_flags_accept_numbers_and_strings() {
        let access: MediaAccess =
            serde_json::from_value(json!({"camera": 1, "microphone": false, "screen": "true"}))
                .unwrap();
        assert_eq!(
            access,
            MediaAccess {
                camera: true,
                microphone: false,
                screen: true
            }
        );
        let pip: PipState = serde_json::from_value(
            json!({"active": 1, "kind": "document", "auto": 0, "closedBy": "user"}),
        )
        .unwrap();
        assert!(pip.active);
        assert_eq!(pip.kind, PipKind::Document);
        assert_eq!(pip.closed_by.as_deref(), Some("user"));
        assert!(serde_json::from_value::<MediaAccess>(json!({"camera": [1]})).is_err());
    }

    #[test]
    fn key_chords_normalize_shifted_letters() {
        let chord = KeyChord::new("T", Modifiers::COMMAND).normalized();
        assert_eq!(
            chord,
            KeyChord::new("t", Modifiers::COMMAND | Modifiers::SHIFT)
        );
        let event = KeyEvent {
            characters_ignoring_modifiers: "W".into(),
            modifiers: Modifiers::COMMAND | Modifiers::CAPS_LOCK,
            ..KeyEvent::default()
        };
        assert_eq!(
            event.chord(),
            KeyChord::new("w", Modifiers::COMMAND | Modifiers::SHIFT)
        );
        assert!(!Modifiers::COMMAND.chord().contains(Modifiers::CAPS_LOCK));
    }

    #[test]
    fn retained_views_balance_retain_and_release() {
        use std::sync::atomic::{AtomicIsize, Ordering};
        static COUNT: AtomicIsize = AtomicIsize::new(0);
        unsafe extern "C" fn retain(_: *mut c_void) {
            COUNT.fetch_add(1, Ordering::SeqCst);
        }
        unsafe extern "C" fn release(_: *mut c_void) {
            COUNT.fetch_sub(1, Ordering::SeqCst);
        }
        let ownership = ObjectOwnership { retain, release };
        let mut marker = 7u8;
        let handle = NativeViewHandle((&mut marker as *mut u8).cast());
        COUNT.store(1, Ordering::SeqCst);
        let view = unsafe { NativeView::adopt_retained(handle, ownership) };
        let copy = view.clone();
        assert_eq!(COUNT.load(Ordering::SeqCst), 2);
        drop(view);
        assert_eq!(copy.handle(), handle);
        drop(copy);
        assert_eq!(COUNT.load(Ordering::SeqCst), 0);
        let null = unsafe { NativeView::adopt_retained(NativeViewHandle::NULL, ownership) };
        assert!(!null.is_owned());
        drop(null);
        assert_eq!(COUNT.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn rect_and_color_validation() {
        assert!(Rect::new(0.0, 0.0, 10.0, 10.0).is_valid());
        assert!(!Rect::new(f64::NAN, 0.0, 10.0, 10.0).is_valid());
        assert!(!Rect::new(0.0, 0.0, -1.0, 10.0).is_valid());
        let color = Rgba {
            r: 2.0,
            g: -1.0,
            b: f64::NAN,
            a: 0.5,
        }
        .clamped();
        assert_eq!(
            color,
            Rgba {
                r: 1.0,
                g: 0.0,
                b: 0.0,
                a: 0.5
            }
        );
    }
}
