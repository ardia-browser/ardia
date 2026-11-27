use crate::ids::{ProfileId, TabId, WindowId};
use crate::json::{self, Fields};
use crate::macros::string_enum;
use crate::model::{LiveItem, Millis, PageEngine, TabPage, TabPin, page_from_disk, pin_from_disk};
use crate::omnibox::url::{app_url_origin, display_host};
use ardia_theme::{IconTheme, RgbaColor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

fn zoom<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(value
        .as_f64()
        .filter(|z| z.is_finite() && *z > 0.0)
        .unwrap_or(1.0))
}

const fn one() -> f64 {
    1.0
}

fn serialize_page<S: Serializer>(page: &TabPage, serializer: S) -> Result<S::Ok, S::Error> {
    page.saved(false).serialize(serializer)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FindState {
    pub open: bool,
    pub query: String,
    pub count: Option<u32>,
    pub active: u32,
    pub replace: bool,
}

string_enum!(SecurityState { Unknown = "unknown", Secure = "secure", Insecure = "insecure", Dangerous = "dangerous", Internal = "internal" } default Unknown);
string_enum!(PermissionKind {
    Camera = "camera",
    Microphone = "microphone",
    Location = "location",
    Notifications = "notifications",
    Clipboard = "clipboard",
    Midi = "midi",
    Usb = "usb",
    Bluetooth = "bluetooth",
    Serial = "serial",
    Hid = "hid",
    ExternalApp = "externalApp",
    Downloads = "downloads",
    Other = "other",
} default Other);
string_enum!(AutofillKind { Address = "address", CreditCard = "creditCard", Password = "password" } default Address);

#[derive(Clone, Debug, PartialEq)]
pub enum SitePrompt {
    SavePassword {
        origin: String,
        username: String,
    },
    Autofill {
        kind: AutofillKind,
    },
    Permission {
        kind: PermissionKind,
        origin: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TabLive {
    pub engine_tab_id: Option<String>,
    pub loading: bool,
    pub progress: f32,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub audible: bool,
    pub theme_color: Option<RgbaColor>,
    pub icon_theme: Option<IconTheme>,
    pub security: SecurityState,
    pub unread_count: u32,
    pub blocked_requests: u32,
    pub blocked_popups: Vec<String>,
    pub prompts: Vec<SitePrompt>,
    pub find: FindState,
    pub peek: bool,
    pub fullscreen: bool,
    pub navigation: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: TabId,
    pub window_id: WindowId,
    pub profile_id: ProfileId,
    pub url: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub title: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub favicon: Option<String>,
    #[serde(default, deserialize_with = "pin_from_disk")]
    pub pin: Option<TabPin>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub muted: bool,
    #[serde(
        default = "one",
        deserialize_with = "zoom",
        serialize_with = "json::serialize_f64"
    )]
    pub zoom: f64,
    #[serde(default, deserialize_with = "json::lenient")]
    pub custom_title: Option<String>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub custom_icon: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub tile_letters: Option<String>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub pinned_url: Option<String>,
    #[serde(
        default,
        deserialize_with = "page_from_disk",
        serialize_with = "serialize_page"
    )]
    pub page: TabPage,
    #[serde(default, deserialize_with = "json::lenient")]
    pub opener_id: Option<TabId>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub link_opener_id: Option<TabId>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient_option"
    )]
    pub live_item: Option<LiveItem>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub pin_key: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient_option"
    )]
    pub engine: Option<PageEngine>,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub chrome_opened: bool,
    #[serde(default, deserialize_with = "json::millis")]
    pub created_at: Millis,
    #[serde(default, deserialize_with = "json::millis")]
    pub last_active_at: Millis,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::option_millis"
    )]
    pub restored_at: Option<Millis>,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub unseen: bool,
    #[serde(skip)]
    pub live: TabLive,
    #[serde(flatten)]
    pub extra: Fields,
}

pub fn same_page_key(a: &str, b: &str) -> bool {
    let key = |url: &str| {
        let page = url.split_once('#').map_or(url, |(page, _)| page);
        page.strip_suffix('/').unwrap_or(page).to_owned()
    };
    key(a) == key(b)
}

pub fn single_line(text: &str) -> String {
    const BREAKS: [char; 7] = [
        '\r', '\n', '\u{2028}', '\u{2029}', '\u{0085}', '\u{000B}', '\u{000C}',
    ];
    if !text.contains(BREAKS) {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    for (i, piece) in text.split(BREAKS).enumerate() {
        let piece = if i == 0 {
            piece.trim_end()
        } else {
            piece.trim()
        };
        if piece.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(piece);
    }
    out.trim().to_owned()
}

fn url_label(url: &str) -> String {
    let rest = match url.find("://") {
        Some(at)
            if url[..at]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
                && url[..at].starts_with(|c: char| c.is_ascii_alphabetic()) =>
        {
            &url[at + 3..]
        }
        _ => url,
    };
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    rest.strip_suffix('/').unwrap_or(rest).to_owned()
}

impl Tab {
    pub fn new(
        id: TabId,
        window_id: WindowId,
        profile_id: ProfileId,
        url: impl Into<String>,
        now: Millis,
    ) -> Self {
        let url = url.into();
        let page = if url.is_empty() {
            TabPage::IDLE
        } else {
            TabPage::LOADED
        };
        Tab {
            id,
            window_id,
            profile_id,
            url,
            title: String::new(),
            favicon: None,
            pin: None,
            muted: false,
            zoom: 1.0,
            custom_title: None,
            custom_icon: None,
            tile_letters: None,
            pinned_url: None,
            page,
            opener_id: None,
            link_opener_id: None,
            live_item: None,
            pin_key: None,
            engine: None,
            chrome_opened: false,
            created_at: now,
            last_active_at: now,
            restored_at: None,
            unseen: false,
            live: TabLive::default(),
            extra: Fields::new(),
        }
    }

    pub fn apply_snapshot(&mut self, snapshot: TabSnapshot, now: Millis) {
        self.url = snapshot.url;
        self.title = snapshot.title;
        self.favicon = snapshot.favicon;
        self.pin = snapshot.pin;
        self.muted = snapshot.muted;
        self.zoom = snapshot.zoom;
        self.custom_title = snapshot.custom_title;
        self.custom_icon = snapshot.custom_icon;
        self.pinned_url = snapshot.pinned_url;
        self.engine = snapshot.engine;
        self.tile_letters = snapshot.tile_letters;
        self.profile_id = snapshot.profile_id;
        if let Some(last) = snapshot.last_active_at {
            self.last_active_at = last;
            self.restored_at = Some(now);
        }
        self.extra = snapshot.extra;
    }

    pub fn is_pinned(&self) -> bool {
        self.pin.is_some()
    }

    pub fn is_incognito(&self) -> bool {
        self.profile_id.is_incognito()
    }

    pub fn pin_key(&self) -> &str {
        self.pin_key.as_deref().unwrap_or(self.id.as_str())
    }

    pub fn pin_home(&self) -> &str {
        self.pinned_url
            .as_deref()
            .filter(|u| !u.is_empty())
            .unwrap_or(&self.url)
    }

    pub fn own_title(&self) -> String {
        let title = match self.custom_title.as_deref().filter(|t| !t.is_empty()) {
            Some(custom) => custom,
            None if is_placeholder_title(&self.title, &self.url) => "",
            None => &self.title,
        };
        single_line(title)
    }

    pub fn display_title(&self) -> String {
        let own = self.own_title();
        if !own.is_empty() {
            return own;
        }
        if !self.url.is_empty() {
            let label = url_label(&self.url);
            if !label.is_empty() {
                return label;
            }
        }
        "New Tab".to_owned()
    }

    pub fn label(&self) -> String {
        if let Some(custom) = self.custom_title.as_deref().filter(|t| !t.is_empty()) {
            return custom.to_owned();
        }
        if self.url.is_empty() {
            return "New Tab".to_owned();
        }
        if let Some(app) = app_url_origin(&self.url) {
            return app;
        }
        match url::Url::parse(&self.url) {
            Ok(parsed) if parsed.scheme() == "file" => {
                if !self.title.is_empty() {
                    return self.title.clone();
                }
                let name = parsed
                    .path_segments()
                    .and_then(|mut s| s.next_back())
                    .unwrap_or("");
                match percent_encoding::percent_decode_str(name).decode_utf8() {
                    Ok(decoded) => decoded.into_owned(),
                    Err(_) => self.url.clone(),
                }
            }
            Ok(parsed) => {
                let host = parsed.host_str().map(display_host).unwrap_or_default();
                let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
                if !host.is_empty() {
                    host
                } else if !self.title.is_empty() {
                    self.title.clone()
                } else {
                    self.url.clone()
                }
            }
            Err(_) => {
                if self.title.is_empty() {
                    self.url.clone()
                } else {
                    self.title.clone()
                }
            }
        }
    }

    pub fn tooltip(&self) -> String {
        if self.url.is_empty() {
            self.display_title()
        } else {
            format!("{}\n{}", self.display_title(), self.url)
        }
    }

    pub fn snapshot(&self) -> TabSnapshot {
        TabSnapshot {
            url: self.url.clone(),
            title: self.title.clone(),
            favicon: self.favicon.clone(),
            pin: self.pin.clone(),
            muted: self.muted,
            zoom: self.zoom,
            custom_title: self.custom_title.clone(),
            custom_icon: self.custom_icon.clone(),
            pinned_url: self.pinned_url.clone(),
            engine: self.engine,
            tile_letters: self.tile_letters.clone(),
            profile_id: self.profile_id.clone(),
            last_active_at: Some(self.last_active_at),
            extra: Fields::new(),
        }
    }

    pub fn row_is_valid(row: &Value) -> bool {
        let Some(fields) = row.as_object() else {
            return false;
        };
        json::own_id(fields.get("id"))
            && json::own_id(fields.get("windowId"))
            && json::own_id(fields.get("profileId"))
            && json::string(fields.get("url"))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSnapshot {
    pub url: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub title: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub favicon: Option<String>,
    #[serde(default, deserialize_with = "pin_from_disk")]
    pub pin: Option<TabPin>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub muted: bool,
    #[serde(
        default = "one",
        deserialize_with = "zoom",
        serialize_with = "json::serialize_f64"
    )]
    pub zoom: f64,
    #[serde(default, deserialize_with = "json::lenient")]
    pub custom_title: Option<String>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub custom_icon: Option<String>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub pinned_url: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient_option"
    )]
    pub engine: Option<PageEngine>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub tile_letters: Option<String>,
    pub profile_id: ProfileId,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::option_millis"
    )]
    pub last_active_at: Option<Millis>,
    #[serde(flatten)]
    pub extra: Fields,
}

impl TabSnapshot {
    pub fn row_is_valid(row: &Value) -> bool {
        row.as_object()
            .is_some_and(|f| json::string(f.get("url")) && json::string(f.get("profileId")))
    }
}

pub const BLANK_ADDRESS: &str = "about:blank";
pub const NEW_TAB_ADDRESS: &str = "ardia://newtab";

pub fn is_blank_address(url: &str) -> bool {
    url.is_empty() || url == BLANK_ADDRESS
}

pub fn is_placeholder_title(title: &str, url: &str) -> bool {
    title == BLANK_ADDRESS && (is_blank_address(url) || url.eq_ignore_ascii_case(NEW_TAB_ADDRESS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn real_tab() -> Value {
        json!({
            "createdAt": 1795624452665u64, "customIcon": null, "customTitle": null, "engine": "chromium", "favicon": "https://x/f.ico",
            "id": "tab-mwb3icp3gkxs-3", "lastActiveAt": 1795656501578u64, "muted": false, "openerId": null, "page": {"kind": "idle"},
            "pin": {"as": "tile"}, "pinnedUrl": "https://mail.example/", "profileId": "default", "restoredAt": 1795624452665u64,
            "title": "Inbox", "url": "https://mail.example/inbox", "windowId": "w-mwwc6vmmx98j-2p", "zoom": 1
        })
    }

    #[test]
    fn a_blank_page_title_never_shows_on_a_new_tab() {
        let titled = |url: &str, title: &str| {
            let mut tab = Tab::new(
                TabId::new("t"),
                WindowId::new("w"),
                ProfileId::default_profile(),
                url,
                0,
            );
            tab.title = title.into();
            tab
        };
        for url in ["", "about:blank", "ardia://newtab"] {
            assert_eq!(titled(url, "about:blank").own_title(), "", "{url}");
        }
        assert_eq!(titled("", "about:blank").display_title(), "New Tab");
        assert_eq!(
            titled("https://example.com/", "about:blank").own_title(),
            "about:blank"
        );
        assert!(is_blank_address(""));
        assert!(is_blank_address("about:blank"));
        assert!(!is_blank_address("https://example.com/"));
    }

    #[test]
    fn real_tab_rows_round_trip() {
        let tab: Tab = serde_json::from_value(real_tab()).unwrap();
        assert!(tab.is_pinned());
        assert_eq!(tab.engine, Some(PageEngine::Chromium));
        assert_eq!(tab.pin_home(), "https://mail.example/");
        let out = serde_json::to_value(&tab).unwrap();
        for key in [
            "id",
            "windowId",
            "profileId",
            "url",
            "title",
            "favicon",
            "pin",
            "muted",
            "zoom",
            "customTitle",
            "customIcon",
            "pinnedUrl",
            "page",
            "openerId",
            "createdAt",
            "lastActiveAt",
            "restoredAt",
            "engine",
        ] {
            assert_eq!(out[key], real_tab()[key], "{key}");
        }
        assert!(out.get("unseen").is_none() && out.get("chromeOpened").is_none());
    }

    #[test]
    fn broken_fields_fall_back_without_dropping_the_tab() {
        let tab: Tab = serde_json::from_value(json!({"id": "t", "windowId": "w", "profileId": "p", "url": "", "title": 4, "zoom": -2, "pin": {"as": "x"}, "engine": "gecko", "page": 9})).unwrap();
        assert_eq!(
            (tab.title.as_str(), tab.zoom, tab.pin.is_none(), tab.engine),
            ("", 1.0, true, None)
        );
        assert!(Tab::row_is_valid(
            &json!({"id": "t", "windowId": "w", "profileId": "p", "url": "x"})
        ));
        assert!(!Tab::row_is_valid(
            &json!({"id": "__proto__", "windowId": "w", "profileId": "p", "url": "x"})
        ));
        assert!(!Tab::row_is_valid(
            &json!({"id": "t", "windowId": "w", "profileId": "p"})
        ));
    }

    #[test]
    fn labels_and_titles_follow_the_sidebar_rules() {
        let mut tab = Tab::new(
            TabId::new("t"),
            WindowId::new("w"),
            ProfileId::default_profile(),
            "https://www.github.com/ardia",
            0,
        );
        assert_eq!(tab.label(), "github.com");
        assert_eq!(tab.display_title(), "github.com/ardia");
        tab.title = "Ardia\non GitHub".into();
        assert_eq!(tab.display_title(), "Ardia on GitHub");
        tab.custom_title = Some("Code".into());
        assert_eq!(tab.label(), "Code");
        let blank = Tab::new(
            TabId::new("b"),
            WindowId::new("w"),
            ProfileId::default_profile(),
            "",
            0,
        );
        assert_eq!(
            (blank.label().as_str(), blank.display_title().as_str()),
            ("New Tab", "New Tab")
        );
        let file = Tab::new(
            TabId::new("f"),
            WindowId::new("w"),
            ProfileId::default_profile(),
            "file:///Users/me/My%20Notes.txt",
            0,
        );
        assert_eq!(file.label(), "My Notes.txt");
        let app = Tab::new(
            TabId::new("a"),
            WindowId::new("w"),
            ProfileId::default_profile(),
            "ardia://settings/tabs",
            0,
        );
        assert_eq!(app.label(), "ardia://settings");
        assert_eq!(single_line("  a \r\n\r\n b  "), "a b");
        assert_eq!(single_line("plain  text"), "plain  text");
    }

    #[test]
    fn snapshots_keep_restorable_fields() {
        let tab: Tab = serde_json::from_value(real_tab()).unwrap();
        let snap = tab.snapshot();
        assert_eq!(snap.profile_id, tab.profile_id);
        assert_eq!(snap.last_active_at, Some(1795656501578));
        let value = serde_json::to_value(&snap).unwrap();
        assert!(TabSnapshot::row_is_valid(&value));
        let back: TabSnapshot = serde_json::from_value(value).unwrap();
        assert_eq!(back, snap);
    }
}
