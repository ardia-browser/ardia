use std::sync::Mutex;
use std::time::{Duration, Instant};

use ardia_engine::{EngineTabId, PageMessage};
use ardia_state::settings::{PeekModifier, SplitLinkModifier};
use ardia_state::splits::SplitSide;
use ardia_state::windows::WindowKind;
use ardia_state::{Action, BrowserState, TabId};
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;

pub const GESTURE_LIFETIME: Duration = Duration::from_secs(10);
pub const MAX_PEEK_URL: usize = 8192;

pub const KEY_SHIFT: u8 = 1;
pub const KEY_OPTION: u8 = 1 << 1;
pub const KEY_COMMAND: u8 = 1 << 2;
pub const KEY_CONTROL: u8 = 1 << 3;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MouseUp {
    pub at: Option<Instant>,
    pub keys: u8,
    pub seq: u64,
    pub used: u64,
    pub pressed_since: bool,
}

static MOUSE: Mutex<MouseUp> = Mutex::new(MouseUp {
    at: None,
    keys: 0,
    seq: 0,
    used: 0,
    pressed_since: false,
});

pub fn note_mouse_down() {
    if let Ok(mut mouse) = MOUSE.lock() {
        mouse.pressed_since = true;
    }
}

pub fn last_mouse_up() -> MouseUp {
    MOUSE.lock().map(|m| *m).unwrap_or_default()
}

pub fn spend_mouse_up() {
    if let Ok(mut mouse) = MOUSE.lock() {
        mouse.used = mouse.seq;
        mouse.at = None;
    }
}

pub fn note_mouse_up(keys: u8, at: Instant) {
    if let Ok(mut mouse) = MOUSE.lock() {
        mouse.at = Some(at);
        mouse.keys = keys;
        mouse.seq += 1;
        mouse.pressed_since = false;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkAction {
    Peek,
    Split,
}

pub fn key_flags(key: &str) -> u8 {
    match key {
        "alt" => KEY_OPTION,
        "shift" => KEY_SHIFT,
        "altShift" => KEY_OPTION | KEY_SHIFT,
        "altMeta" => KEY_OPTION | KEY_COMMAND,
        _ => 0,
    }
}

pub fn peek_key(modifier: PeekModifier) -> &'static str {
    match modifier {
        PeekModifier::Alt => "alt",
        PeekModifier::Shift => "shift",
        PeekModifier::Off => "off",
    }
}

pub fn split_key(modifier: SplitLinkModifier) -> &'static str {
    match modifier {
        SplitLinkModifier::Alt => "alt",
        SplitLinkModifier::AltShift => "altShift",
    }
}

pub fn link_action(key: &str, peek: &str, split: &str) -> Option<LinkAction> {
    if key_flags(key) == 0 {
        return None;
    }
    if key == peek {
        return Some(LinkAction::Peek);
    }
    if key == "altShift" || key == "altMeta" || key == split {
        return Some(LinkAction::Split);
    }
    None
}

pub fn peeks_other_sites(state: &BrowserState, tab: &TabId) -> bool {
    state.settings.peek_links_to_other_sites
        && state.tab(tab.as_str()).is_some_and(|t| t.pin.is_some())
}

pub fn peek_test_hooks() -> bool {
    std::env::var_os("ARDIA_TEST_INPUT").is_some_and(|v| v == "1")
}

pub fn peek_tracing() -> bool {
    std::env::var_os("ARDIA_PEEK_TRACE").is_some()
}

pub fn peek_config(state: &BrowserState, tab: &TabId) -> String {
    json!({
        "modifier": peek_key(state.settings.peek_modifier),
        "split": split_key(state.settings.split_link_modifier()),
        "trace": peek_tracing(),
        "otherSites": peeks_other_sites(state, tab),
    })
    .to_string()
}

pub fn refusal(mouse: &MouseUp, flag: u8, now: Instant) -> Option<&'static str> {
    let Some(at) = mouse.at else {
        return Some("no left mouse-up yet");
    };
    if mouse.seq == mouse.used {
        return Some("that mouse-up already opened a peek");
    }
    if mouse.pressed_since {
        return Some("the mouse was pressed again since that mouse-up");
    }
    if now.saturating_duration_since(at) > GESTURE_LIFETIME {
        return Some("the last mouse-up is too old");
    }
    if mouse.keys != flag {
        return Some("the mouse-up's keys aren't the page's key alone");
    }
    None
}

fn http(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

pub fn click_px(data: &Value, main: bool) -> Option<[f32; 2]> {
    if !main {
        return None;
    }
    let at = |key: &str| {
        data.get(key)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(|v| v as f32)
    };
    Some([at("x")?, at("y")?])
}

pub fn decide(
    state: &BrowserState,
    tab: &TabId,
    data: &Value,
    main: bool,
    mouse: &MouseUp,
    now: Instant,
) -> Result<(LinkAction, String), &'static str> {
    let url = data
        .get("url")
        .and_then(Value::as_str)
        .filter(|u| u.len() <= MAX_PEEK_URL)
        .ok_or("no url")?;
    let key = data.get("key").and_then(Value::as_str).unwrap_or_default();
    let other_site = key == "site";
    let action = if other_site {
        peeks_other_sites(state, tab).then_some(LinkAction::Peek)
    } else {
        link_action(
            key,
            peek_key(state.settings.peek_modifier),
            split_key(state.settings.split_link_modifier()),
        )
    }
    .ok_or("that key opens nothing now")?;
    if other_site && !main {
        return Err("only the page itself peeks links to other sites");
    }
    if !http(url) {
        return Err("not http(s)");
    }
    if !other_site
        && !peek_test_hooks()
        && let Some(reason) = refusal(mouse, key_flags(key), now)
    {
        return Err(reason);
    }
    Ok((action, url.to_owned()))
}

#[cfg(target_os = "macos")]
pub fn watch_mouse() {
    use std::sync::Once;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};

    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let handler = RcBlock::new(|event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
            let shown = unsafe { event.as_ref() };
            match shown.r#type() {
                NSEventType::LeftMouseDown => note_mouse_down(),
                NSEventType::LeftMouseUp => {
                    let flags = shown.modifierFlags();
                    let mut keys = 0u8;
                    if flags.contains(NSEventModifierFlags::Shift) {
                        keys |= KEY_SHIFT;
                    }
                    if flags.contains(NSEventModifierFlags::Option) {
                        keys |= KEY_OPTION;
                    }
                    if flags.contains(NSEventModifierFlags::Command) {
                        keys |= KEY_COMMAND;
                    }
                    if flags.contains(NSEventModifierFlags::Control) {
                        keys |= KEY_CONTROL;
                    }
                    note_mouse_up(keys, Instant::now());
                }
                _ => {}
            }
            event.as_ptr()
        });
        let mask: u64 = (1 << NSEventType::LeftMouseDown.0) | (1 << NSEventType::LeftMouseUp.0);
        let monitor: Option<Retained<AnyObject>> = unsafe {
            msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: mask, handler: &*handler]
        };
        std::mem::forget(monitor);
        std::mem::forget(handler);
    });
}

#[cfg(not(target_os = "macos"))]
pub fn watch_mouse() {}

impl AppCoordinator {
    pub fn peek_page_message(&self, engine_tab: EngineTabId, message: &PageMessage) -> bool {
        if let Ok(mut holds) = crate::pointer_hold::HOLDS.lock()
            && holds.note(engine_tab, message)
        {
            return true;
        }
        match message.kind.as_str() {
            "hello" | "peekHello" => {
                watch_mouse();
                let state = self.store.snapshot();
                if let (Some(tab), Some(engine)) = (self.state_tab(engine_tab), self.engine()) {
                    let config = peek_config(&state, &tab);
                    let sent = if message.main_frame {
                        engine.call_page(engine_tab, "peekConfig", &config)
                    } else {
                        engine.call_frame(engine_tab, &message.frame_id, "peekConfig", &config)
                    };
                    match sent {
                        Ok(()) => log::debug!("peek config sent to frame {:?}", message.frame_id),
                        Err(problem) => log::debug!("peek config didn't reach the page: {problem}"),
                    }
                }
                message.kind == "peekHello"
            }
            "peek" => {
                self.peek_link(engine_tab, message);
                true
            }
            "peekTrace" => {
                log::debug!("peek trace {}", message.json);
                true
            }
            _ => false,
        }
    }

    fn peek_link(&self, engine_tab: EngineTabId, message: &PageMessage) {
        let Some(tab) = self.state_tab(engine_tab) else {
            return;
        };
        let Some(data) = message.data() else {
            return;
        };
        let state = self.store.snapshot();
        let mouse = MOUSE.lock().map(|m| *m).unwrap_or_default();
        let (action, url) = match decide(
            &state,
            &tab,
            &data,
            message.main_frame,
            &mouse,
            Instant::now(),
        ) {
            Ok(decided) => decided,
            Err(reason) => {
                log::debug!("a peek was refused: {reason}");
                return;
            }
        };
        if data.get("key").and_then(Value::as_str) != Some("site")
            && let Ok(mut held) = MOUSE.lock()
        {
            held.used = held.seq;
        }
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        let window = listed.window_id.clone();
        let little = state
            .window(window.as_str())
            .is_some_and(|w| w.kind == WindowKind::LittleArdia);
        let in_peek = listed.live.peek;
        match action {
            LinkAction::Split => {
                if let Err(problem) = self.dispatch_action(Action::OpenSplitPane {
                    window,
                    side: SplitSide::Right,
                    url: Some(url),
                }) {
                    log::debug!("a split link didn't open: {problem}");
                }
            }
            LinkAction::Peek if little || in_peek => {
                ardia_ui::UiHost::navigate(self, window, tab, url);
            }
            LinkAction::Peek => {
                let action = match click_px(&data, message.main_frame) {
                    Some(click_px) => Action::OpenPeekAt {
                        window,
                        url,
                        source: Some(tab),
                        click_px,
                    },
                    None => Action::OpenPeek {
                        window,
                        url,
                        source: Some(tab),
                    },
                };
                if let Err(problem) = self.dispatch_action(action) {
                    log::debug!("a peek didn't open: {problem}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_click_point_comes_from_the_main_frame_only() {
        let data = json!({ "x": 120.0, "y": 48.5 });
        assert_eq!(click_px(&data, true), Some([120.0, 48.5]));
        assert_eq!(click_px(&data, false), None);
        assert_eq!(click_px(&json!({ "x": -1.0, "y": 2.0 }), true), None);
        assert_eq!(click_px(&json!({ "x": "a" }), true), None);
    }

    #[test]
    fn keys_map_to_peek_and_split() {
        assert_eq!(
            link_action("shift", "shift", "altShift"),
            Some(LinkAction::Peek)
        );
        assert_eq!(
            link_action("altShift", "shift", "altShift"),
            Some(LinkAction::Split)
        );
        assert_eq!(link_action("alt", "shift", "altShift"), None);
        assert_eq!(link_action("", "shift", "altShift"), None);
    }

    #[test]
    fn a_peek_needs_a_fresh_real_mouse_up_with_its_key() {
        let now = Instant::now();
        let mut mouse = MouseUp {
            at: Some(now),
            keys: KEY_SHIFT,
            seq: 1,
            used: 0,
            pressed_since: false,
        };
        assert_eq!(refusal(&mouse, KEY_SHIFT, now), None);
        assert!(refusal(&mouse, KEY_OPTION, now).is_some());
        assert!(refusal(&mouse, KEY_SHIFT, now + Duration::from_secs(11)).is_some());
        mouse.used = 1;
        assert!(refusal(&mouse, KEY_SHIFT, now).is_some());
        mouse.used = 0;
        mouse.pressed_since = true;
        assert!(refusal(&mouse, KEY_SHIFT, now).is_some());
        assert!(refusal(&MouseUp::default(), KEY_SHIFT, now).is_some());
    }
}
