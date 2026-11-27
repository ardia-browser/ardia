use std::collections::HashSet;

use parking_lot::RwLock;
use serde_json::Value;

use crate::types::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NewBrowserWindow {
    Refuse,
    Create,
    Use(EngineWindowId),
}

pub trait HostPolicy: Send + Sync {
    fn new_browser_window(
        &self,
        profile: Option<EngineProfileId>,
        kind: NewBrowserKind,
    ) -> NewBrowserWindow {
        let _ = profile;
        match kind {
            NewBrowserKind::Normal | NewBrowserKind::Popup => NewBrowserWindow::Create,
            NewBrowserKind::App | NewBrowserKind::Devtools | NewBrowserKind::Other => {
                NewBrowserWindow::Refuse
            }
        }
    }

    fn is_reserved_key(&self, chord: &KeyChord) -> bool {
        let _ = chord;
        false
    }

    fn window_should_close(&self, window: EngineWindowId) -> bool {
        let _ = window;
        true
    }

    fn pre_handle_key(&self, window: EngineWindowId, event: &KeyEvent) -> bool {
        let _ = (window, event);
        false
    }

    fn handle_key(&self, window: EngineWindowId, event: &KeyEvent) -> bool {
        let _ = (window, event);
        false
    }

    fn takes_extension_popup(&self, tab: Option<EngineTabId>, popup: &Value) -> bool {
        let _ = popup;
        tab.is_some()
    }

    fn takes_extension_shortcut(&self, tab: Option<EngineTabId>, shortcut: &Value) -> bool {
        let _ = shortcut;
        tab.is_some()
    }

    fn context_menu_items(
        &self,
        tab: EngineTabId,
        target: &ContextMenuTarget,
    ) -> Vec<ContextMenuItem> {
        let _ = (tab, target);
        Vec::new()
    }

    fn run_context_menu(&self, tab: EngineTabId, menu: &Value) -> Option<Value> {
        let _ = (tab, menu);
        None
    }

    fn menu_item_enabled(&self, command: &str, arg: Option<&str>) -> bool {
        let _ = arg;
        command != "noop"
    }
}

#[derive(Debug, Default)]
pub struct DefaultPolicy {
    reserved: RwLock<HashSet<KeyChord>>,
}

impl DefaultPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_reserved_shortcuts(&self, chords: impl IntoIterator<Item = KeyChord>) {
        *self.reserved.write() = chords.into_iter().map(|chord| chord.normalized()).collect();
    }

    pub fn reserved_shortcut_count(&self) -> usize {
        self.reserved.read().len()
    }
}

impl HostPolicy for DefaultPolicy {
    fn is_reserved_key(&self, chord: &KeyChord) -> bool {
        self.reserved.read().contains(&chord.normalized())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_policy_creates_normal_and_popup_windows_only() {
        let policy = DefaultPolicy::new();
        assert_eq!(
            policy.new_browser_window(None, NewBrowserKind::Normal),
            NewBrowserWindow::Create
        );
        assert_eq!(
            policy.new_browser_window(None, NewBrowserKind::Popup),
            NewBrowserWindow::Create
        );
        assert_eq!(
            policy.new_browser_window(None, NewBrowserKind::App),
            NewBrowserWindow::Refuse
        );
        assert_eq!(
            policy.new_browser_window(None, NewBrowserKind::Devtools),
            NewBrowserWindow::Refuse
        );
        assert!(policy.window_should_close(EngineWindowId::from_raw(1).unwrap()));
        assert!(!policy.takes_extension_popup(None, &json!({})));
        assert!(policy.takes_extension_popup(EngineTabId::from_raw(1), &json!({})));
    }

    #[test]
    fn reserved_shortcuts_match_regardless_of_shift_spelling() {
        let policy = DefaultPolicy::new();
        policy.set_reserved_shortcuts([
            KeyChord::new("t", Modifiers::COMMAND),
            KeyChord::new("T", Modifiers::COMMAND),
        ]);
        assert_eq!(policy.reserved_shortcut_count(), 2);
        assert!(policy.is_reserved_key(&KeyChord::new("t", Modifiers::COMMAND)));
        assert!(policy.is_reserved_key(&KeyChord::new("t", Modifiers::COMMAND | Modifiers::SHIFT)));
        assert!(!policy.is_reserved_key(&KeyChord::new("t", Modifiers::CONTROL)));
        assert!(policy.is_reserved_key(&KeyChord::new(
            "t",
            Modifiers::COMMAND | Modifiers::CAPS_LOCK
        )));
    }
}
