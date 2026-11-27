use crate::ids::{ProfileId, TabId, WindowId};
use crate::json::{self, Fields};
use crate::macros::string_enum;
use crate::model::{Frame, Millis, TabLayout};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::VecDeque;

string_enum!(WindowKind {
    Main = "main",
    Incognito = "private",
    LittleArdia = "small",
    Settings = "settings",
    Import = "import",
    Onboarding = "onboarding",
} default Main);

impl WindowKind {
    pub const fn is_saved(self) -> bool {
        matches!(self, WindowKind::Main)
    }

    pub const fn has_tabs(self) -> bool {
        matches!(
            self,
            WindowKind::Main | WindowKind::Incognito | WindowKind::LittleArdia
        )
    }

    pub const fn shows_sidebar(self) -> bool {
        matches!(self, WindowKind::Main | WindowKind::Incognito)
    }
}

fn saved_kind<'de, D: Deserializer<'de>>(deserializer: D) -> Result<WindowKind, D::Error> {
    let _ = Value::deserialize(deserializer)?;
    Ok(WindowKind::Main)
}

fn active_tabs<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<IndexMap<ProfileId, TabId>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(value
        .as_object()
        .map(|fields| {
            fields
                .iter()
                .filter_map(|(profile, tab)| {
                    Some((ProfileId::new(profile), TabId::new(tab.as_str()?)))
                })
                .collect()
        })
        .unwrap_or_default())
}

fn frame<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Frame>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(Frame::deserialize(value).ok())
}

#[derive(Clone, Debug, PartialEq)]
pub enum Popover {
    SiteControls,
    Zoom,
    Downloads,
    Extensions,
    Share,
    Cast,
    History,
    BlockedPopups,
    Prompt { index: usize },
    ProfileMenu,
    Custom(String),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum CommandBarPlacementState {
    #[default]
    Field,
    Centred,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NewTabTarget {
    List,
    Group(crate::ids::GroupId),
    Into(TabId),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CommandBarState {
    pub open: bool,
    pub initial_text: String,
    pub new_tab: Option<NewTabTarget>,
    pub placement: CommandBarPlacementState,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PeekCard {
    pub tab_id: TabId,
    pub source_tab_id: Option<TabId>,
    pub click_px: Option<[f32; 2]>,
}

string_enum!(ToastKind { Info = "info", Undo = "undo", Error = "error" } default Info);

#[derive(Clone, Debug, PartialEq)]
pub struct Toast {
    pub id: u64,
    pub kind: ToastKind,
    pub message: String,
    pub action: Option<String>,
    pub icon: Option<String>,
    pub created_at: Millis,
    pub expires_at: Option<Millis>,
}

pub const MAX_TOASTS: usize = 3;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WindowChrome {
    pub engine_window: Option<String>,
    pub sidebar_peeking: bool,
    pub pager_offset: f32,
    pub selection: Vec<TabId>,
    pub selection_anchor: Option<TabId>,
    pub popover: Option<Popover>,
    pub command_bar: CommandBarState,
    pub peek: Option<PeekCard>,
    pub toasts: VecDeque<Toast>,
    pub downloads_open: bool,
    pub link_pointer: Option<[f64; 2]>,
    pub link_app: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWindow {
    pub id: WindowId,
    #[serde(default, deserialize_with = "saved_kind")]
    pub kind: WindowKind,
    pub profile_id: ProfileId,
    pub tab_ids: Vec<TabId>,
    #[serde(default, deserialize_with = "active_tabs")]
    pub active_tab_ids: IndexMap<ProfileId, TabId>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient_option"
    )]
    pub tab_layout: Option<TabLayout>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient_option"
    )]
    pub auto_hide_tabs: Option<bool>,
    #[serde(default, deserialize_with = "frame")]
    pub frame: Option<Frame>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "frame"
    )]
    pub restored_frame: Option<Frame>,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub maximized: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::option_millis"
    )]
    pub full_screen: Option<Millis>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub display: Option<String>,
    #[serde(default, deserialize_with = "json::millis")]
    pub created_at: Millis,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub opens_behind: Option<WindowId>,
    #[serde(skip)]
    pub chrome: WindowChrome,
    #[serde(flatten)]
    pub extra: Fields,
}

pub const LEGACY_WINDOW_KEYS: [&str; 3] = ["incognito", "sidebarOpen", "chromeWindow"];

impl BrowserWindow {
    pub fn new(id: WindowId, kind: WindowKind, profile_id: ProfileId, now: Millis) -> Self {
        BrowserWindow {
            id,
            kind,
            profile_id,
            tab_ids: Vec::new(),
            active_tab_ids: IndexMap::new(),
            tab_layout: None,
            auto_hide_tabs: None,
            frame: None,
            restored_frame: None,
            maximized: false,
            full_screen: None,
            display: None,
            created_at: now,
            opens_behind: None,
            chrome: WindowChrome::default(),
            extra: Fields::new(),
        }
    }

    pub fn active_tab(&self) -> Option<&TabId> {
        self.active_tab_ids.get(&self.profile_id)
    }

    pub fn is_full_screen(&self) -> bool {
        self.full_screen.is_some()
    }

    pub fn row_is_valid(row: &Value) -> bool {
        let Some(fields) = row.as_object() else {
            return false;
        };
        json::own_id(fields.get("id"))
            && json::own_id(fields.get("profileId"))
            && json::string_list(fields.get("tabIds"))
            && fields
                .get("activeTabIds")
                .and_then(Value::as_object)
                .is_some_and(|active| active.values().all(Value::is_string))
    }

    pub fn push_toast(&mut self, toast: Toast) {
        self.chrome.toasts.push_back(toast);
        while self.chrome.toasts.len() > MAX_TOASTS {
            self.chrome.toasts.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn both_shell_window_shapes_load_as_main_windows() {
        let webui: BrowserWindow = serde_json::from_value(json!({
            "activeTabIds": {"default": "tab-1", "p-2": "tab-2"}, "createdAt": 1795624452665u64, "frame": [0, 90, 1512, 859],
            "id": "w-1", "kind": "main", "profileId": "p-2", "tabIds": ["tab-1", "tab-2"]
        }))
        .unwrap();
        assert_eq!(webui.kind, WindowKind::Main);
        assert_eq!(webui.active_tab().map(TabId::as_str), Some("tab-2"));
        let native: BrowserWindow = serde_json::from_value(json!({
            "activeTabIds": {"default": "tab-1"}, "id": "w-2", "profileId": "default", "tabIds": ["tab-1"], "frame": null,
            "incognito": false, "sidebarOpen": true, "fullScreen": 1795624452665u64, "display": "UUID"
        }))
        .unwrap();
        assert_eq!(native.kind, WindowKind::Main);
        assert!(native.is_full_screen());
        assert_eq!(native.frame, None);
        assert!(native.extra.contains_key("sidebarOpen"));
        let out = serde_json::to_value(&webui).unwrap();
        assert_eq!(out["kind"], json!("main"));
        assert_eq!(out["frame"], json!([0, 90, 1512, 859]));
        assert!(out.get("maximized").is_none());
    }

    #[test]
    fn window_rows_need_ids_tab_lists_and_string_actives() {
        assert!(BrowserWindow::row_is_valid(
            &json!({"id": "w", "profileId": "p", "tabIds": [], "activeTabIds": {}})
        ));
        assert!(!BrowserWindow::row_is_valid(
            &json!({"id": "w", "profileId": "p", "tabIds": [1], "activeTabIds": {}})
        ));
        assert!(!BrowserWindow::row_is_valid(
            &json!({"id": "w", "profileId": "p", "tabIds": [], "activeTabIds": {"p": 3}})
        ));
        assert!(!BrowserWindow::row_is_valid(
            &json!({"id": "w", "profileId": "p", "tabIds": []})
        ));
    }

    #[test]
    fn toasts_queue_is_bounded() {
        let mut w = BrowserWindow::new(
            WindowId::new("w"),
            WindowKind::Main,
            ProfileId::default_profile(),
            0,
        );
        for id in 0..5 {
            w.push_toast(Toast {
                id,
                kind: ToastKind::Info,
                message: format!("{id}"),
                action: None,
                icon: None,
                created_at: 0,
                expires_at: None,
            });
        }
        assert_eq!(
            w.chrome.toasts.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        assert!(WindowKind::Main.is_saved() && !WindowKind::LittleArdia.is_saved());
        assert_eq!(WindowKind::Incognito.key(), "private");
    }
}
