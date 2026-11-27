use std::sync::Arc;

use ardia_engine::PermissionResult;
use ardia_state::omnibox::url::{display_host, host_of};
use ardia_state::tabs::{AutofillKind, PermissionKind, SitePrompt, Tab};
use gpui::Image;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PermissionAsk {
    pub id: String,
    pub origin: String,
    pub permissions: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PasswordAsk {
    pub origin: String,
    pub username: String,
    pub usernames: Vec<String>,
    pub password_length: u32,
    pub federation: Option<String>,
    pub update: bool,
}

impl PasswordAsk {
    pub fn key(&self) -> String {
        format!(
            "{}|{}|{}",
            self.origin,
            self.username,
            if self.update { "update" } else { "save" }
        )
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AutofillChange {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AutofillAsk {
    pub id: i64,
    pub kind: String,
    pub title: String,
    pub message: String,
    pub accept: String,
    pub decline: String,
    pub footer: Option<String>,
    pub lines: Vec<String>,
    pub changes: Vec<AutofillChange>,
    pub new_label: Option<String>,
    pub old_label: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ExternalAppAsk {
    pub id: String,
    pub title: String,
    pub message: Option<String>,
    pub icon: Option<Arc<Image>>,
    pub remember: Option<String>,
}

impl PartialEq for ExternalAppAsk {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.title == other.title
            && self.message == other.message
            && self.remember == other.remember
            && self.icon.as_ref().map(Arc::as_ptr) == other.icon.as_ref().map(Arc::as_ptr)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct VerificationAsk {
    pub token: String,
    pub app: String,
    pub host: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DeviceOptionView {
    pub name: String,
    pub connected: bool,
    pub paired: bool,
    pub signal: i32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DeviceAsk {
    pub id: i32,
    pub title: String,
    pub ok_label: String,
    pub cancel_label: String,
    pub no_options_text: String,
    pub scanning_text: String,
    pub refreshing: bool,
    pub can_refresh: bool,
    pub adapter_off: bool,
    pub unauthorized: bool,
    pub both_buttons_enabled: bool,
    pub show_signal: bool,
    pub options: Vec<DeviceOptionView>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EngineOfferAsk {
    pub site: String,
    pub host: String,
    pub can_remember: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlockedPopupItem {
    pub id: String,
    pub url: String,
    pub origin: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SitePage {
    pub permission: Option<PermissionAsk>,
    pub password: Option<PasswordAsk>,
    pub autofill: Option<AutofillAsk>,
    pub external_app: Option<ExternalAppAsk>,
    pub verification: Option<VerificationAsk>,
    pub device: Option<DeviceAsk>,
    pub engine_offer: Option<EngineOfferAsk>,
    pub popups: Vec<BlockedPopupItem>,
}

impl SitePage {
    pub fn is_empty(&self) -> bool {
        *self == SitePage::default()
    }

    pub fn from_prompts(tab: &Tab) -> SitePage {
        let mut page = SitePage::default();
        for (index, prompt) in tab.live.prompts.iter().enumerate() {
            match prompt {
                SitePrompt::Permission { kind, origin } if page.permission.is_none() => {
                    page.permission = Some(PermissionAsk {
                        id: format!("{}#{index}", tab.id),
                        origin: origin.clone(),
                        permissions: vec![permission_name(*kind).to_owned()],
                    });
                }
                SitePrompt::SavePassword { origin, username } => {
                    page.password = Some(PasswordAsk {
                        origin: origin.clone(),
                        username: username.clone(),
                        ..PasswordAsk::default()
                    });
                }
                SitePrompt::Autofill { kind } => {
                    page.autofill = Some(AutofillAsk {
                        id: index as i64,
                        kind: match kind {
                            AutofillKind::CreditCard => "saveCard",
                            AutofillKind::Address => "saveAddress",
                            AutofillKind::Password => "password",
                        }
                        .to_owned(),
                        title: match kind {
                            AutofillKind::CreditCard => "Save card?",
                            AutofillKind::Address => "Save address?",
                            AutofillKind::Password => "Save password?",
                        }
                        .to_owned(),
                        accept: "Save".to_owned(),
                        decline: "No Thanks".to_owned(),
                        lines: vec![host_of(&tab.url)],
                        ..AutofillAsk::default()
                    });
                }
                SitePrompt::Permission { .. } => {}
            }
        }
        page
    }
}

pub fn permission_name(kind: PermissionKind) -> &'static str {
    match kind {
        PermissionKind::Camera => "camera",
        PermissionKind::Microphone => "microphone",
        PermissionKind::Location => "location",
        PermissionKind::Notifications => "notifications",
        PermissionKind::Clipboard => "clipboard",
        PermissionKind::Midi => "midi",
        PermissionKind::Usb => "usb",
        PermissionKind::Bluetooth => "bluetooth",
        PermissionKind::Serial => "serial",
        PermissionKind::Hid => "hid",
        PermissionKind::ExternalApp => "externalApp",
        PermissionKind::Downloads => "multipleDownloads",
        PermissionKind::Other => "other",
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SettingValue {
    Allow,
    Block,
    #[default]
    Ask,
    Default,
}

impl SettingValue {
    pub fn parse(text: &str) -> SettingValue {
        match text {
            "allow" => SettingValue::Allow,
            "block" => SettingValue::Block,
            "default" => SettingValue::Default,
            _ => SettingValue::Ask,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SettingValue::Allow => "allow",
            SettingValue::Block => "block",
            SettingValue::Ask => "ask",
            SettingValue::Default => "default",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SiteSetting {
    pub value: SettingValue,
    pub is_default: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SiteSettings {
    pub entries: Vec<(String, SiteSetting)>,
}

impl SiteSettings {
    pub fn get(&self, kind: &str) -> Option<SiteSetting> {
        self.entries
            .iter()
            .find(|(name, _)| name == kind)
            .map(|(_, setting)| *setting)
    }

    pub fn from_json(value: &serde_json::Value) -> SiteSettings {
        let Some(map) = value.as_object() else {
            return SiteSettings::default();
        };
        SiteSettings {
            entries: map
                .iter()
                .filter_map(|(name, entry)| {
                    let value = entry.get("value")?.as_str()?;
                    Some((
                        name.clone(),
                        SiteSetting {
                            value: SettingValue::parse(value),
                            is_default: entry
                                .get("isDefault")
                                .and_then(serde_json::Value::as_bool)
                                .unwrap_or(true),
                        },
                    ))
                })
                .collect(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SecurityLevel {
    Secure,
    Mixed,
    Insecure,
    CertificateError,
    Local,
    #[default]
    None,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CertificateView {
    pub subject_common_name: String,
    pub subject_display_name: String,
    pub subject_organizations: Vec<String>,
    pub issuer_common_name: String,
    pub issuer_display_name: String,
    pub issuer_organizations: Vec<String>,
    pub valid_from: f64,
    pub valid_until: f64,
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SecurityView {
    pub level: SecurityLevel,
    pub protocol: Option<String>,
    pub certificate: Option<CertificateView>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SiteBlocker {
    pub enabled: bool,
    pub allowed: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct HiddenElement {
    pub filter: String,
    pub host: String,
    pub selector: String,
    pub session: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct HiddenList {
    pub host: String,
    pub elements: Vec<HiddenElement>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlockerList {
    pub id: String,
    pub title: String,
    pub category: String,
    pub enabled: bool,
    pub default_on: bool,
    pub filters: u64,
    pub failed: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlockerStats {
    pub ready: bool,
    pub enabled: bool,
    pub network_filters: u64,
    pub cosmetic_filters: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ContentBlockerView {
    pub enabled: bool,
    pub version: String,
    pub lists: Vec<BlockerList>,
    pub allowed_hosts: Vec<String>,
    pub stats: BlockerStats,
}

impl ContentBlockerView {
    pub fn allows(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        self.allowed_hosts
            .iter()
            .any(|directive| blocker_covers(directive, &host))
    }

    pub fn site_blocker(&self, host: &str) -> SiteBlocker {
        SiteBlocker {
            enabled: self.enabled,
            allowed: self.allows(host),
        }
    }
}

pub fn blocker_covers(directive: &str, host: &str) -> bool {
    !directive.contains('/') && (host == directive || host.ends_with(&format!(".{directive}")))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReloadBlocker {
    On,
    Off,
    OffInSettings,
    Unavailable,
}

impl ReloadBlocker {
    pub fn of(view: Option<&ContentBlockerView>, host: &str) -> ReloadBlocker {
        match view {
            None => ReloadBlocker::Unavailable,
            Some(view) if !view.stats.ready => ReloadBlocker::Unavailable,
            Some(view) if !view.enabled => ReloadBlocker::OffInSettings,
            Some(view) if view.allows(host) => ReloadBlocker::Off,
            Some(_) => ReloadBlocker::On,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ContentBlockerCommand {
    SetEnabled(bool),
    SetListEnabled { id: String, enabled: bool },
    AddList(String),
    RemoveList(String),
    SetAllowed { host: String, allowed: bool },
    RemoveAllowed(String),
    Refresh,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TranslateLanguage {
    pub id: String,
    pub name: String,
    pub current: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TranslateView {
    pub available: bool,
    pub source: Option<String>,
    pub translated: bool,
    pub never: bool,
    pub source_name: String,
    pub target_name: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SitePanel {
    pub settings: Option<SiteSettings>,
    pub security: Option<SecurityView>,
    pub blocker: Option<SiteBlocker>,
    pub cleared: Option<String>,
    pub hidden: Option<HiddenList>,
    pub translate: TranslateView,
    pub video: bool,
    pub pip: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SelectionRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PageSelection {
    pub text: String,
    pub rect: SelectionRect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PopupsAnswer {
    AlwaysDeny,
    OnlyOnce,
    AlwaysAllow,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SiteAnswer {
    ExternalApp {
        open: bool,
        remember: bool,
    },
    Verification {
        accept: bool,
    },
    Popups(PopupsAnswer),
    OpenPopup(String),
    ChooseDevice {
        chooser: i32,
        index: i32,
    },
    CancelDevice(i32),
    RescanDevices(i32),
    BluetoothSettings(i32),
    EngineOffer {
        accept: bool,
        remember: bool,
    },
    SetPermission {
        kind: String,
        value: SettingValue,
    },
    SetBlocking(bool),
    ClearData,
    RestoreHidden(Vec<String>),
    HideElement,
    Translate,
    ShowOriginal,
    NeverTranslate(bool),
    SearchSelection {
        text: String,
        platform: bool,
        shift: bool,
        alt: bool,
    },
    TranslateTo(String),
    ToggleTranslation,
    DismissSelection,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SitePermission {
    pub kind: &'static str,
    pub title: &'static str,
    pub icon: &'static str,
    pub badge: &'static str,
    pub choices: &'static [SettingValue],
}

const ASK_ALLOW_BLOCK: &[SettingValue] =
    &[SettingValue::Ask, SettingValue::Allow, SettingValue::Block];
const ALLOW_BLOCK: &[SettingValue] = &[SettingValue::Allow, SettingValue::Block];

pub const SITE_PERMISSIONS: [SitePermission; 7] = [
    SitePermission {
        kind: "camera",
        title: "Camera",
        icon: "video",
        badge: "video.fill",
        choices: ASK_ALLOW_BLOCK,
    },
    SitePermission {
        kind: "microphone",
        title: "Microphone",
        icon: "mic",
        badge: "mic.fill",
        choices: ASK_ALLOW_BLOCK,
    },
    SitePermission {
        kind: "location",
        title: "Location",
        icon: "location",
        badge: "location.fill",
        choices: ASK_ALLOW_BLOCK,
    },
    SitePermission {
        kind: "notifications",
        title: "Notifications",
        icon: "bell",
        badge: "bell.fill",
        choices: ASK_ALLOW_BLOCK,
    },
    SitePermission {
        kind: "popups",
        title: "Pop-ups and Redirects",
        icon: "macwindow.on.rectangle",
        badge: "macwindow.on.rectangle",
        choices: ALLOW_BLOCK,
    },
    SitePermission {
        kind: "sound",
        title: "Sound",
        icon: "speaker.wave.2",
        badge: "speaker.wave.2.fill",
        choices: ALLOW_BLOCK,
    },
    SitePermission {
        kind: "autoplay",
        title: "Autoplay",
        icon: "play.rectangle",
        badge: "play.rectangle.fill",
        choices: ALLOW_BLOCK,
    },
];

pub fn choice_title(kind: &str, value: SettingValue) -> &'static str {
    if kind == "sound" {
        return if value == SettingValue::Block {
            "Muted"
        } else {
            "Allowed"
        };
    }
    match value {
        SettingValue::Allow => "Allowed",
        SettingValue::Block => "Blocked",
        _ => "Ask",
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SiteSound {
    pub site_muted: bool,
    pub sound_blocked: bool,
}

pub fn effective_value(
    kind: &str,
    settings: Option<&SiteSettings>,
    autoplay_everywhere: bool,
) -> Option<SettingValue> {
    let setting = settings.and_then(|s| s.get(kind));
    if kind == "autoplay" && setting.is_some_and(|s| s.is_default) && autoplay_everywhere {
        return Some(SettingValue::Block);
    }
    setting.map(|s| s.value)
}

pub fn permission_value(
    kind: &str,
    settings: Option<&SiteSettings>,
    sound: SiteSound,
    autoplay_everywhere: bool,
) -> Option<SettingValue> {
    if kind == "sound" {
        return Some(if sound.site_muted || sound.sound_blocked {
            SettingValue::Block
        } else {
            SettingValue::Allow
        });
    }
    effective_value(kind, settings, autoplay_everywhere)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InUse {
    pub camera: bool,
    pub microphone: bool,
    pub sound: bool,
    pub autoplay: bool,
}

pub const WEBKIT_SITE_SETTINGS: [&str; 10] = [
    "camera",
    "microphone",
    "location",
    "notifications",
    "popups",
    "javascript",
    "images",
    "cookies",
    "autoplay",
    "clipboard",
];

pub fn site_permissions_for(webkit: bool) -> impl Iterator<Item = &'static SitePermission> {
    SITE_PERMISSIONS
        .iter()
        .filter(move |p| !webkit || p.kind == "sound" || WEBKIT_SITE_SETTINGS.contains(&p.kind))
}

pub fn featured_permissions(settings: &SiteSettings, in_use: InUse) -> Vec<&'static str> {
    SITE_PERMISSIONS
        .iter()
        .filter(|p| {
            let customised = !settings.get(p.kind).is_none_or(|s| s.is_default);
            let used = match p.kind {
                "camera" => in_use.camera,
                "microphone" => in_use.microphone,
                "sound" => in_use.sound,
                "autoplay" => in_use.autoplay,
                _ => false,
            };
            customised || used
        })
        .map(|p| p.kind)
        .collect()
}

pub fn blocker_label(blocker: Option<SiteBlocker>, blocked: u32) -> String {
    match blocker {
        None => "…".to_owned(),
        Some(b) if !b.enabled => "Off in Settings".to_owned(),
        Some(b) if b.allowed => "Off for this site".to_owned(),
        Some(_) if blocked > 0 => format!("On · {blocked} blocked on this page"),
        Some(_) => "On".to_owned(),
    }
}

pub fn site_origin(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let lower = trimmed.get(..8).unwrap_or(trimmed).to_ascii_lowercase();
    let scheme = if lower.starts_with("https://") {
        "https"
    } else if lower.starts_with("http://") {
        "http"
    } else {
        return None;
    };
    let host = host_of(trimmed);
    if host.is_empty() {
        return None;
    }
    let rest = &trimmed[scheme.len() + 3..];
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let port = authority
        .rsplit_once(':')
        .filter(|(_, port)| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()))
        .map(|(_, port)| port)
        .filter(|port| !matches!((scheme, *port), ("https", "443") | ("http", "80")));
    Some(match port {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

pub fn host_or_origin(origin: &str) -> String {
    let host = host_of(origin);
    if host.is_empty() {
        origin.to_owned()
    } else {
        host
    }
}

pub fn security_display_origin(origin: &str) -> String {
    let lower = origin.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        let host = host_of(origin);
        if !host.is_empty() {
            return display_host(&host);
        }
    }
    origin.to_owned()
}

struct Describe {
    icon: &'static str,
    noun: Option<&'static str>,
    question: Option<fn(&str) -> String>,
}

fn describe(kind: &str) -> Option<Describe> {
    let noun = |icon, noun| Describe {
        icon,
        noun: Some(noun),
        question: None,
    };
    let ask = |icon, question: fn(&str) -> String| Describe {
        icon,
        noun: None,
        question: Some(question),
    };
    Some(match kind {
        "camera" => noun("video", "camera"),
        "microphone" => noun("mic", "microphone"),
        "cameraPanTiltZoom" => noun("video", "camera's pan, tilt and zoom"),
        "screen" => ask("rectangle.on.rectangle", |s| {
            format!("Allow {s} to share your screen?")
        }),
        "location" => noun("location", "location"),
        "notifications" => ask("bell", |s| format!("Allow {s} to send you notifications?")),
        "clipboard" => noun("doc.on.clipboard", "clipboard"),
        "midi" => noun("pianokeys", "MIDI devices"),
        "multipleDownloads" => ask("arrow.down.circle", |s| {
            format!("Allow {s} to download multiple files?")
        }),
        "localFonts" => noun("textformat", "fonts"),
        "idleDetection" => ask("person.crop.circle.badge.clock", |s| {
            format!("Allow {s} to know when you're actively using this device?")
        }),
        "storageAccess" => ask("externaldrive", |s| {
            format!("Allow {s} to use cookies and site data while embedded?")
        }),
        "diskQuota" => ask("internaldrive", |s| {
            format!("Allow {s} to store files on your device?")
        }),
        "windowManagement" => noun(
            "macwindow.on.rectangle",
            "displays to open and place windows",
        ),
        "fileSystem" => noun("folder", "files"),
        "keyboardLock" => noun("keyboard", "keyboard"),
        "pointerLock" => noun("cursorarrow", "mouse pointer"),
        "protectedMedia" => ask("lock.shield", |s| {
            format!("Allow {s} to play protected content?")
        }),
        "protocolHandler" => ask("envelope", |s| format!("Make {s} your default mail app?")),
        "sensors" => noun("gyroscope", "motion sensors"),
        "localNetwork" => noun("network", "devices on your local network"),
        "vr" => noun("visionpro", "virtual reality devices"),
        "ar" => noun("visionpro", "augmented reality data"),
        "handTracking" => noun("hand.raised", "hand tracking"),
        "identityProvider" => ask("person.badge.key", |s| {
            format!("Allow {s} to sign you in with an identity provider?")
        }),
        "webAppInstallation" => ask("app.badge", |s| format!("Allow {s} to install web apps?")),
        "capturedSurfaceControl" => ask("rectangle.on.rectangle", |s| {
            format!("Allow {s} to scroll and zoom the tab you share?")
        }),
        _ => return None,
    })
}

fn word_list(words: &[&str]) -> String {
    match words {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionCopy {
    pub icons: Vec<&'static str>,
    pub question: String,
}

pub fn describe_permission(request: &PermissionAsk) -> PermissionCopy {
    let site = security_display_origin(&request.origin);
    let kinds: Vec<(&str, Option<Describe>)> = request
        .permissions
        .iter()
        .map(|kind| (kind.as_str(), describe(kind)))
        .collect();
    let mut icons: Vec<&'static str> = Vec::new();
    for (_, described) in &kinds {
        let icon = described.as_ref().map_or("questionmark.circle", |d| d.icon);
        if !icons.contains(&icon) {
            icons.push(icon);
        }
    }
    if let [
        (
            _,
            Some(Describe {
                question: Some(question),
                ..
            }),
        ),
    ] = kinds.as_slice()
    {
        return PermissionCopy {
            icons,
            question: question(&site),
        };
    }
    let nouns: Vec<&str> = kinds
        .iter()
        .map(|(kind, described)| match described {
            Some(Describe {
                noun: Some(noun), ..
            }) => Some(*noun),
            Some(_) => None,
            None => Some(*kind),
        })
        .collect::<Option<Vec<_>>>()
        .unwrap_or_default();
    if !nouns.is_empty() && nouns.len() == kinds.len() {
        return PermissionCopy {
            icons,
            question: format!("Allow {site} to access your {}?", word_list(&nouns)),
        };
    }
    let uses: Vec<&str> = kinds
        .iter()
        .map(|(kind, described)| described.as_ref().and_then(|d| d.noun).unwrap_or(kind))
        .collect();
    PermissionCopy {
        icons,
        question: format!("Allow {site} to use {}?", word_list(&uses)),
    }
}

pub fn password_title(ask: &PasswordAsk) -> String {
    if ask.update {
        "Update saved password?".to_owned()
    } else {
        format!("Save password for {}?", host_or_origin(&ask.origin))
    }
}

pub fn password_message(ask: &PasswordAsk) -> String {
    if ask.update {
        format!("It will be auto-filled on {}", host_or_origin(&ask.origin))
    } else {
        "That way, it'll be auto-filled next time".to_owned()
    }
}

pub fn password_username_line(ask: &PasswordAsk, username: &str) -> String {
    if !username.is_empty() {
        return username.to_owned();
    }
    match &ask.federation {
        Some(federation) => format!("Signed in with {}", host_or_origin(federation)),
        None => "No username".to_owned(),
    }
}

pub fn password_dots(length: u32) -> String {
    "•".repeat(length.min(16) as usize)
}

pub fn password_choices(ask: &PasswordAsk) -> &[String] {
    if ask.update && ask.usernames.len() > 1 {
        &ask.usernames
    } else {
        &[]
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutofillSection {
    pub label: Option<String>,
    pub lines: Vec<String>,
}

pub fn autofill_sections(ask: &AutofillAsk) -> Vec<AutofillSection> {
    if ask.kind != "updateAddress" {
        return vec![AutofillSection {
            label: None,
            lines: ask.lines.clone(),
        }];
    }
    let values = |to: bool| -> Vec<String> {
        ask.changes
            .iter()
            .map(|c| if to { c.to.clone() } else { c.from.clone() })
            .filter(|v| !v.is_empty())
            .collect()
    };
    match &ask.new_label {
        Some(new_label) if !new_label.is_empty() => vec![
            AutofillSection {
                label: Some(new_label.clone()),
                lines: values(true),
            },
            AutofillSection {
                label: ask.old_label.clone(),
                lines: values(false),
            },
        ],
        _ => vec![AutofillSection {
            label: None,
            lines: values(true),
        }],
    }
}

pub fn autofill_icon(ask: &AutofillAsk) -> &'static str {
    if ask.kind == "saveCard" {
        "creditcard.fill"
    } else {
        "mappin.and.ellipse"
    }
}

pub fn verification_copy(app: &str, host: &str) -> (String, String) {
    let clipped = |text: &str, max: usize| {
        if text.chars().count() > max {
            let cut: String = text.chars().take(max - 1).collect();
            format!("{}…", cut.trim_end())
        } else {
            text.to_owned()
        }
    };
    let name = clipped(app, 40);
    let lead = if host.is_empty() {
        String::new()
    } else {
        format!("{} shows a two-factor setup code. ", clipped(host, 64))
    };
    (
        format!("Set Up Verification Code in {name}?"),
        format!("{lead}{name} fills its codes from now on."),
    )
}

pub fn popup_title(url: &str) -> String {
    let lower = url.to_ascii_lowercase();
    let stripped = if lower.starts_with("https://") {
        &url[8..]
    } else if lower.starts_with("http://") {
        &url[7..]
    } else {
        url
    };
    if stripped.is_empty() {
        "about:blank".to_owned()
    } else {
        stripped.to_owned()
    }
}

pub fn hidden_element_title(selector: &str) -> String {
    let last = selector
        .split('>')
        .flat_map(|part| part.split_whitespace())
        .rfind(|part| !part.is_empty())
        .unwrap_or(selector);
    let mut title = last.to_owned();
    if let Some(start) = title.find(":nth-of-type(")
        && let Some(end) = title[start..].find(')')
    {
        let digits = &title[start + 13..start + end];
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            title = format!("{} #{digits}{}", &title[..start], &title[start + end + 1..]);
        }
    }
    let title = title.replace('\\', "");
    if title.is_empty() {
        selector.to_owned()
    } else {
        title
    }
}

pub fn hiding_host(url: &str) -> Option<String> {
    site_origin(url)?;
    let host = host_of(url).to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    host.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        .then_some(host)
}

pub fn covers_host(rule_host: &str, host: &str) -> bool {
    host == rule_host || host.ends_with(&format!(".{rule_host}"))
}

pub fn parse_hiding_filter(filter: &str, session: bool) -> Option<HiddenElement> {
    let (host, selector) = filter.split_once("##")?;
    let host_ok = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
    let selector_ok = !selector.is_empty()
        && !selector.starts_with(['+', '^', ' ', '\t', '\n'])
        && !selector.contains("/*")
        && !selector.chars().any(|c| {
            matches!(c, '{' | '}' | '\u{7f}' | '\u{85}' | '\u{2028}' | '\u{2029}') || c < ' '
        });
    (host_ok && selector_ok).then(|| HiddenElement {
        filter: filter.to_owned(),
        host: host.to_owned(),
        selector: selector.to_owned(),
        session,
    })
}

pub fn hidden_subtitle(list: Option<&HiddenList>) -> String {
    match list {
        None => "…".to_owned(),
        Some(list) if list.elements.is_empty() => "Nothing hidden on this site".to_owned(),
        Some(list) => {
            let count = list.elements.len();
            format!(
                "{count} element{} hidden on every visit",
                if count == 1 { "" } else { "s" }
            )
        }
    }
}

pub fn certificate_fingerprint(sha256: &str) -> String {
    let hex: String = sha256.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let pairs: Vec<String> = hex
        .as_bytes()
        .chunks(2)
        .map(|pair| String::from_utf8_lossy(pair).into_owned())
        .collect();
    let joined = pairs.join(" ");
    let cut: String = joined.chars().take(47).collect();
    format!("{cut}…")
}

pub fn quoted_selection(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > 40 {
        let cut: String = text.chars().take(40).collect();
        let cut = cut.split_whitespace().collect::<Vec<_>>().join(" ");
        format!("{}…", cut.trim_end())
    } else {
        collapsed
    }
}

pub const SELECTION_BAR_HEIGHT: f32 = 26.0 + 2.0 * 4.0;
pub const SELECTION_GAP: f32 = 6.0;
pub const SELECTION_SHOW_DELAY_MS: u64 = 150;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SelectionPlace {
    pub x: f32,
    pub y: f32,
    pub above: bool,
}

pub fn selection_place(
    rect: SelectionRect,
    zoom: f32,
    area: (f32, f32),
    width: f32,
) -> Option<SelectionPlace> {
    let top = rect.y * zoom;
    let bottom = (rect.y + rect.height) * zoom;
    if bottom < 0.0 || top > area.1 {
        return None;
    }
    let above = top - SELECTION_GAP - SELECTION_BAR_HEIGHT >= 4.0;
    let y = if above {
        top - SELECTION_GAP - SELECTION_BAR_HEIGHT
    } else {
        (bottom + SELECTION_GAP).min(area.1 - SELECTION_BAR_HEIGHT - 4.0)
    };
    let center = (rect.x + rect.width / 2.0) * zoom;
    let x = (center - width / 2.0).min(area.0 - width - 8.0).max(8.0);
    Some(SelectionPlace { x, y, above })
}

pub const PROMPT_INPUT_DELAY_MS: u64 = 500;

pub fn prompt_input_allowed(
    visible_at_ms: u64,
    activated_at_ms: u64,
    previous_input_ms: u64,
    now_ms: u64,
) -> bool {
    let settled = visible_at_ms.max(activated_at_ms) + PROMPT_INPUT_DELAY_MS;
    now_ms >= settled && now_ms.saturating_sub(previous_input_ms) >= PROMPT_INPUT_DELAY_MS
}

pub const ZOOM_BUBBLE_CLOSE_MS: u64 = 1500;

pub fn zoom_icon(zoom: f64) -> &'static str {
    if (zoom - 1.0).abs() < 0.001 {
        "magnifyingglass"
    } else if zoom > 1.0 {
        "plus.magnifyingglass"
    } else {
        "minus.magnifyingglass"
    }
}

pub fn zoom_percent(zoom: f64) -> String {
    format!("{}%", (zoom * 100.0).round() as i64)
}

pub fn permission_result(accept: bool) -> PermissionResult {
    if accept {
        PermissionResult::Accept
    } else {
        PermissionResult::Deny
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(kinds: &[&str]) -> PermissionAsk {
        PermissionAsk {
            id: "p".into(),
            origin: "https://meet.example".into(),
            permissions: kinds.iter().map(|k| (*k).to_owned()).collect(),
        }
    }

    #[test]
    fn permission_questions_follow_the_old_wording() {
        assert_eq!(
            describe_permission(&ask(&["camera"])).question,
            "Allow meet.example to access your camera?"
        );
        assert_eq!(
            describe_permission(&ask(&["camera", "microphone"])).question,
            "Allow meet.example to access your camera and microphone?"
        );
        assert_eq!(
            describe_permission(&ask(&["camera", "microphone"])).icons,
            vec!["video", "mic"]
        );
        assert_eq!(
            describe_permission(&ask(&["notifications"])).question,
            "Allow meet.example to send you notifications?"
        );
        assert_eq!(
            describe_permission(&ask(&["notifications", "camera"])).question,
            "Allow meet.example to use notifications and camera?"
        );
        assert_eq!(
            describe_permission(&ask(&["weird"])).question,
            "Allow meet.example to access your weird?"
        );
        assert_eq!(
            describe_permission(&ask(&["weird"])).icons,
            vec!["questionmark.circle"]
        );
    }

    #[test]
    fn site_settings_values_and_titles() {
        let settings = SiteSettings::from_json(&serde_json::json!({
            "camera": {"value": "allow", "isDefault": false},
            "autoplay": {"value": "allow", "isDefault": true},
            "popups": {"value": "block", "isDefault": true}
        }));
        assert_eq!(
            permission_value("camera", Some(&settings), SiteSound::default(), false),
            Some(SettingValue::Allow)
        );
        assert_eq!(
            permission_value("autoplay", Some(&settings), SiteSound::default(), true),
            Some(SettingValue::Block)
        );
        assert_eq!(
            permission_value(
                "sound",
                None,
                SiteSound {
                    site_muted: true,
                    sound_blocked: false
                },
                false
            ),
            Some(SettingValue::Block)
        );
        assert_eq!(choice_title("sound", SettingValue::Block), "Muted");
        assert_eq!(choice_title("camera", SettingValue::Default), "Ask");
        assert_eq!(
            featured_permissions(
                &settings,
                InUse {
                    microphone: true,
                    ..InUse::default()
                }
            ),
            vec!["camera", "microphone"]
        );
    }

    #[test]
    fn blocker_and_origin_copy() {
        assert_eq!(blocker_label(None, 3), "…");
        assert_eq!(
            blocker_label(
                Some(SiteBlocker {
                    enabled: false,
                    allowed: false
                }),
                3
            ),
            "Off in Settings"
        );
        assert_eq!(
            blocker_label(
                Some(SiteBlocker {
                    enabled: true,
                    allowed: false
                }),
                3
            ),
            "On · 3 blocked on this page"
        );
        assert_eq!(
            site_origin("https://a.example:443/x?y").as_deref(),
            Some("https://a.example")
        );
        assert_eq!(
            site_origin("http://a.example:8080/x").as_deref(),
            Some("http://a.example:8080")
        );
        assert_eq!(site_origin("ardia://settings"), None);
    }

    #[test]
    fn password_and_autofill_copy() {
        let mut ask = PasswordAsk {
            origin: "https://login.example".into(),
            username: String::new(),
            password_length: 30,
            ..PasswordAsk::default()
        };
        assert_eq!(password_title(&ask), "Save password for login.example?");
        assert_eq!(password_username_line(&ask, ""), "No username");
        assert_eq!(password_dots(30).chars().count(), 16);
        ask.federation = Some("https://accounts.google.com".into());
        assert_eq!(
            password_username_line(&ask, ""),
            "Signed in with accounts.google.com"
        );
        ask.update = true;
        ask.usernames = vec!["a".into(), "b".into()];
        assert_eq!(password_title(&ask), "Update saved password?");
        assert_eq!(password_choices(&ask).len(), 2);
        let fill = AutofillAsk {
            kind: "updateAddress".into(),
            new_label: Some("New".into()),
            old_label: Some("Old".into()),
            changes: vec![AutofillChange {
                from: "1 Old St".into(),
                to: "2 New St".into(),
            }],
            ..AutofillAsk::default()
        };
        let sections = autofill_sections(&fill);
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].lines, vec!["2 New St".to_owned()]);
        assert_eq!(sections[1].label.as_deref(), Some("Old"));
    }

    #[test]
    fn hidden_elements_and_selection_math() {
        assert_eq!(
            hidden_element_title("div.main > ul li:nth-of-type(3)"),
            "li #3"
        );
        assert_eq!(
            hiding_host("https://www.Example.com/a").as_deref(),
            Some("example.com")
        );
        assert!(covers_host("example.com", "news.example.com"));
        assert!(!covers_host("example.com", "badexample.com"));
        assert!(parse_hiding_filter("example.com##.ad", false).is_some());
        assert!(parse_hiding_filter("example.com##{x}", false).is_none());
        let place = selection_place(
            SelectionRect {
                x: 100.0,
                y: 200.0,
                width: 50.0,
                height: 10.0,
            },
            1.0,
            (800.0, 600.0),
            90.0,
        )
        .expect("shown");
        assert!(place.above);
        assert_eq!(place.y, 200.0 - SELECTION_GAP - SELECTION_BAR_HEIGHT);
        assert_eq!(place.x, 125.0 - 45.0);
        assert!(
            selection_place(SelectionRect::default(), 1.0, (800.0, 600.0), 90.0)
                .is_some_and(|p| !p.above)
        );
        assert!(
            selection_place(
                SelectionRect {
                    y: 700.0,
                    ..SelectionRect::default()
                },
                1.0,
                (800.0, 600.0),
                90.0
            )
            .is_none()
        );
        assert_eq!(quoted_selection("a  b\nc"), "a b c");
    }

    #[test]
    fn prompt_guard_waits_after_showing_and_between_inputs() {
        assert!(!prompt_input_allowed(1000, 0, 0, 1300));
        assert!(prompt_input_allowed(1000, 0, 0, 1500));
        assert!(!prompt_input_allowed(1000, 1400, 0, 1600));
        assert!(!prompt_input_allowed(1000, 0, 1700, 1800));
    }

    #[test]
    fn blocker_views_answer_like_the_old_allow_list() {
        let view = ContentBlockerView {
            enabled: true,
            allowed_hosts: vec!["example.com".into()],
            stats: BlockerStats {
                ready: true,
                ..BlockerStats::default()
            },
            ..ContentBlockerView::default()
        };
        assert!(view.allows("news.Example.com"));
        assert!(!view.allows("badexample.com"));
        assert!(!blocker_covers("example.com/path", "example.com"));
        assert_eq!(
            ReloadBlocker::of(Some(&view), "example.com"),
            ReloadBlocker::Off
        );
        assert_eq!(
            ReloadBlocker::of(Some(&view), "other.org"),
            ReloadBlocker::On
        );
        assert_eq!(
            ReloadBlocker::of(None, "other.org"),
            ReloadBlocker::Unavailable
        );
        let off = ContentBlockerView {
            enabled: false,
            ..view
        };
        assert_eq!(
            ReloadBlocker::of(Some(&off), "other.org"),
            ReloadBlocker::OffInSettings
        );
        assert_eq!(
            off.site_blocker("example.com"),
            SiteBlocker {
                enabled: false,
                allowed: true
            }
        );
    }

    #[test]
    fn misc_copy() {
        assert_eq!(popup_title("https://ads.example/x"), "ads.example/x");
        assert_eq!(popup_title(""), "about:blank");
        assert_eq!(
            verification_copy("1Password", "github.com").0,
            "Set Up Verification Code in 1Password?"
        );
        assert_eq!(zoom_percent(1.1), "110%");
        assert_eq!(zoom_icon(0.9), "minus.magnifyingglass");
        assert_eq!(certificate_fingerprint("ab:cd:ef"), "ab cd ef…".to_owned());
    }
}
