use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use ardia_state::TabId;
use ardia_ui::host_data::HostTopics;
use ardia_ui::media::session::MediaCommand;
use serde_json::Value;

use super::services::{self, PageMessage, js_string};
use crate::coordinator::AppCoordinator;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SightAction {
    None,
    Open,
    Close,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AutoPip {
    seen: bool,
    auto_opened: bool,
    reported_active: bool,
}

impl Default for AutoPip {
    fn default() -> Self {
        AutoPip {
            seen: true,
            auto_opened: false,
            reported_active: false,
        }
    }
}

impl AutoPip {
    pub fn sight(&mut self, now_seen: bool, enabled: bool, playing: bool) -> SightAction {
        if now_seen == self.seen {
            return SightAction::None;
        }
        self.seen = now_seen;
        if !now_seen {
            if !enabled || !playing {
                return SightAction::None;
            }
            self.auto_opened = true;
            return SightAction::Open;
        }
        if !self.auto_opened && !self.reported_active {
            return SightAction::None;
        }
        self.auto_opened = false;
        SightAction::Close
    }

    pub fn reported(&mut self, active: bool) {
        if !active && self.reported_active {
            self.auto_opened = false;
        }
        self.reported_active = active;
    }
}

#[derive(Default)]
struct TabMedia {
    playing: HashSet<String>,
    rule: AutoPip,
}

#[derive(Default)]
struct Book {
    tabs: HashMap<TabId, TabMedia>,
}

static BOOK: Mutex<Option<Book>> = Mutex::new(None);

fn with_book<R>(run: impl FnOnce(&mut Book) -> R) -> R {
    let mut slot = BOOK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    run(slot.get_or_insert_with(Book::default))
}

pub fn media_script(action: &str, seconds: f64) -> String {
    let seconds = if seconds.is_finite() { seconds } else { 0.0 };
    format!(
        "window.__ardia && window.__ardia.media({}, {seconds})",
        js_string(action)
    )
}

pub fn pip_script(on: bool, automatic: bool) -> String {
    format!("window.__ardia ? window.__ardia.pictureInPicture({on}, {automatic}) : false")
}

#[cfg(target_os = "macos")]
mod sight {
    use std::sync::Once;

    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSString;

    use ardia_state::TabId;

    pub fn seen(tab: &TabId) -> bool {
        let Some(web) = crate::webkit::page::web_of(tab) else {
            return false;
        };
        unsafe {
            let hidden: bool = msg_send![&*web, isHiddenOrHasHiddenAncestor];
            if hidden {
                return false;
            }
            let window: Option<Retained<AnyObject>> = msg_send![&*web, window];
            let Some(window) = window else {
                return false;
            };
            if std::env::var_os("ARDIA_BACKGROUND").is_some_and(|v| !v.is_empty() && v != "0") {
                return true;
            }
            let state: usize = msg_send![&*window, occlusionState];
            let miniaturized: bool = msg_send![&*window, isMiniaturized];
            state & (1 << 1) != 0 && !miniaturized
        }
    }

    pub fn watch(changed: impl Fn() + 'static) {
        static ONCE: Once = Once::new();
        let changed = std::rc::Rc::new(changed);
        ONCE.call_once(|| {
            let Some(centers) = AnyClass::get(c"NSNotificationCenter") else {
                return;
            };
            unsafe {
                let center: Retained<AnyObject> = msg_send![centers, defaultCenter];
                for name in [
                    "NSWindowDidChangeOcclusionStateNotification",
                    "NSWindowDidMiniaturizeNotification",
                    "NSWindowDidDeminiaturizeNotification",
                    "NSApplicationDidResignActiveNotification",
                    "NSApplicationDidBecomeActiveNotification",
                ] {
                    let changed = changed.clone();
                    let block = RcBlock::new(move |_note: *mut AnyObject| changed());
                    let observer: Option<Retained<AnyObject>> = msg_send![
                        &*center,
                        addObserverForName: &*NSString::from_str(name),
                        object: std::ptr::null::<AnyObject>(),
                        queue: std::ptr::null::<AnyObject>(),
                        usingBlock: &*block
                    ];
                    std::mem::forget(observer);
                }
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod sight {
    use ardia_state::TabId;

    pub fn seen(_: &TabId) -> bool {
        true
    }

    pub fn watch(_: impl Fn() + 'static) {}
}

impl AppCoordinator {
    pub(crate) fn webkit_media_message(&self, tab: &TabId, message: &PageMessage) {
        match message.kind.as_str() {
            "nowPlaying" => {
                let page = ardia_engine::PageMessage {
                    kind: message.kind.clone(),
                    json: message.data.to_string(),
                    frame_id: message.frame.clone(),
                    main_frame: message.main_frame,
                    origin: message.origin.clone(),
                };
                self.media_page_message(tab, &page);
            }
            "media" => {
                let playing = message.data.get("playing").and_then(Value::as_bool) == Some(true);
                with_book(|book| {
                    let media = book.tabs.entry(tab.clone()).or_default();
                    if playing {
                        media.playing.insert(message.frame.clone());
                    } else {
                        media.playing.remove(&message.frame);
                    }
                });
                self.webkit_watch_sight();
                self.webkit_update_sight(tab);
            }
            "pip" => {
                let active = message.data.get("active").and_then(Value::as_bool) == Some(true);
                with_book(|book| {
                    book.tabs
                        .entry(tab.clone())
                        .or_default()
                        .rule
                        .reported(active)
                });
                let changed = self.bridge.lock().media.book.set_pip(tab, active);
                if changed {
                    self.signal.emit(HostTopics::PAGE);
                }
            }
            _ => {}
        }
    }

    fn webkit_selected_frame(&self, tab: &TabId) -> Option<String> {
        self.bridge
            .lock()
            .media
            .frames
            .get(tab)
            .map(|frames| frames.selected_frame().to_owned())
            .filter(|frame| !frame.is_empty())
    }

    pub(crate) fn webkit_media_command(&self, tab: &TabId, command: MediaCommand) -> bool {
        if !crate::webkit::page::has(tab) {
            return false;
        }
        let (action, seconds) = command.wire();
        let frame = self.webkit_selected_frame(tab);
        services::run(tab, frame.as_deref(), &media_script(action, seconds), None);
        true
    }

    pub(crate) fn webkit_set_pip(&self, tab: &TabId, on: bool, automatic: bool) -> bool {
        if !crate::webkit::page::has(tab) {
            return false;
        }
        let code = pip_script(on, automatic);
        if on {
            let frame = self.webkit_selected_frame(tab);
            let me = self.weak();
            let tab_again = tab.clone();
            services::run(
                tab,
                frame.as_deref(),
                &code,
                Some(Box::new(move |answer| {
                    let nothing = answer.as_ref().and_then(Value::as_str) == Some("nothingPlaying");
                    if nothing && automatic && me.upgrade().is_some() {
                        ardia_telemetry::counts::count("auto_pip_nothing_playing");
                    }
                    let _ = tab_again;
                })),
            );
        } else {
            let frames: Vec<String> = with_book(|book| {
                book.tabs
                    .get(tab)
                    .map(|media| media.playing.iter().cloned().collect())
                    .unwrap_or_default()
            });
            for frame in frames {
                services::run(tab, Some(&frame), &code, None);
            }
            services::run(tab, None, &code, None);
            if self.bridge.lock().media.book.set_pip(tab, false) {
                self.signal.emit(HostTopics::PAGE);
            }
        }
        true
    }

    fn webkit_watch_sight(&self) {
        let me = self.weak();
        sight::watch(move || {
            if let Some(c) = me.upgrade() {
                c.webkit_reconsider_sight();
            }
        });
    }

    pub(crate) fn webkit_reconsider_sight(&self) {
        let tabs: Vec<TabId> = with_book(|book| book.tabs.keys().cloned().collect());
        for tab in tabs {
            self.webkit_update_sight(&tab);
        }
    }

    fn webkit_update_sight(&self, tab: &TabId) {
        if !crate::webkit::page::has(tab) {
            return;
        }
        let enabled = self.store().snapshot().settings.auto_picture_in_picture;
        let seen = sight::seen(tab);
        let action = with_book(|book| {
            let media = book.tabs.entry(tab.clone()).or_default();
            let playing = !media.playing.is_empty();
            media.rule.sight(seen, enabled, playing)
        });
        match action {
            SightAction::Open => {
                self.webkit_set_pip(tab, true, true);
            }
            SightAction::Close => {
                self.webkit_set_pip(tab, false, false);
            }
            SightAction::None => {}
        }
    }

    pub(crate) fn webkit_media_committed(&self, tab: &TabId) {
        with_book(|book| {
            if let Some(media) = book.tabs.get_mut(tab) {
                media.playing.clear();
            }
        });
        self.reset_page_media(tab);
    }

    pub(crate) fn webkit_media_closed(&self, tab: &TabId) {
        with_book(|book| book.tabs.remove(tab));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_pip_opens_when_hidden_and_closes_when_seen() {
        let mut rule = AutoPip::default();
        assert_eq!(rule.sight(true, true, true), SightAction::None);
        assert_eq!(rule.sight(false, true, true), SightAction::Open);
        assert_eq!(rule.sight(true, true, true), SightAction::Close);
        assert_eq!(rule.sight(false, false, true), SightAction::None);
        assert_eq!(rule.sight(true, false, true), SightAction::None);
        rule.reported(true);
        assert_eq!(rule.sight(false, true, false), SightAction::None);
        assert_eq!(rule.sight(true, true, false), SightAction::Close);
    }

    #[test]
    fn scripts_call_the_page_bridge() {
        assert_eq!(
            media_script("seek", 3.5),
            "window.__ardia && window.__ardia.media(\"seek\", 3.5)"
        );
        assert!(media_script("play", f64::NAN).ends_with(", 0)"));
        assert_eq!(
            pip_script(true, false),
            "window.__ardia ? window.__ardia.pictureInPicture(true, false) : false"
        );
    }
}
