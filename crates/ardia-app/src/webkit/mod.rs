pub mod autofill;
pub mod content_rules;
pub mod dropdown;
pub mod logins;
pub mod media;
#[cfg(all(test, target_os = "macos"))]
pub(crate) mod native_audit;
pub mod notification_hub;
pub mod notification_workers;
pub mod notifications;
pub mod site_answers;
pub mod passkeys;
pub mod services;
pub mod certs;
pub mod downloads;
pub mod page;
pub mod page_events;
pub mod page_text;
pub mod site_data;
pub mod site_settings;
pub mod retiring;
pub mod site_gate;
pub mod site_sync;
pub mod swap;
pub mod tabs;
pub mod telemetry;

use std::sync::Arc;

use ardia_state::TabId;

pub const ZOOM_LEVELS: [f64; 17] = [
    0.25, 0.333, 0.5, 0.667, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WebKitNavigation {
    pub url: String,
    pub committed_url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub loading: bool,
    pub theme_color: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum WebKitEvent {
    Navigation(WebKitNavigation),
    Progress(f64),
    Committed,
    Zoom(f64),
    Icons(Vec<String>),
    FindMatches(Option<u32>, u32),
    Page(page_events::PageEvent),
    Media {
        audible: bool,
    },
    Fullscreen(bool),
    OpenPopup {
        held: String,
        url: String,
        background: bool,
    },
    OpenUrl {
        url: String,
        background: bool,
    },
    WindowClose,
    Crashed,
    ProtectedMedia {
        key_system: String,
    },
    Unsaved(bool),
    Message(services::PageMessage),
}

pub type WebKitSink = Arc<dyn Fn(TabId, WebKitEvent) + Send + Sync>;

pub fn next_zoom(current: f64, direction: i32) -> f64 {
    match direction.signum() {
        1 => ZOOM_LEVELS
            .iter()
            .copied()
            .find(|level| *level > current + 0.001)
            .unwrap_or(current),
        -1 => ZOOM_LEVELS
            .iter()
            .copied()
            .rev()
            .find(|level| *level < current - 0.001)
            .unwrap_or(current),
        _ => 1.0,
    }
}
