use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use ardia_engine::{EngineTabId, PageMessage};
use serde_json::Value;

#[derive(Debug, Default)]
pub struct PointerHolds {
    frames: HashMap<EngineTabId, HashSet<String>>,
}

impl PointerHolds {
    pub fn note(&mut self, tab: EngineTabId, message: &PageMessage) -> bool {
        match message.kind.as_str() {
            "hello" if message.main_frame => {
                self.frames.remove(&tab);
                false
            }
            "exclusive" => {
                let held = message
                    .data()
                    .as_ref()
                    .and_then(|data| data.get("pointerLock"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let frames = self.frames.entry(tab).or_default();
                if held {
                    frames.insert(message.frame_id.clone());
                } else {
                    frames.remove(&message.frame_id);
                }
                if frames.is_empty() {
                    self.frames.remove(&tab);
                }
                true
            }
            _ => false,
        }
    }

    pub fn forget(&mut self, tab: EngineTabId) {
        self.frames.remove(&tab);
    }

    pub fn holds(&self, tab: EngineTabId) -> bool {
        self.frames
            .get(&tab)
            .is_some_and(|frames| !frames.is_empty())
    }
}

pub static HOLDS: LazyLock<Mutex<PointerHolds>> =
    LazyLock::new(|| Mutex::new(PointerHolds::default()));

#[cfg(test)]
mod tests {
    use super::*;

    fn message(kind: &str, frame: &str, main: bool, json: &str) -> PageMessage {
        PageMessage {
            kind: kind.into(),
            json: json.into(),
            frame_id: frame.into(),
            main_frame: main,
            origin: None,
        }
    }

    fn tab() -> EngineTabId {
        EngineTabId::from_raw(7).expect("tab")
    }

    #[test]
    fn a_frame_holding_pointer_lock_holds_the_page_until_it_lets_go() {
        let mut holds = PointerHolds::default();
        let lock = r#"{"held":true,"pointerLock":true}"#;
        let free = r#"{"held":false,"pointerLock":false}"#;
        assert!(holds.note(tab(), &message("exclusive", "f1", false, lock)));
        assert!(holds.note(tab(), &message("exclusive", "main", true, lock)));
        assert!(holds.holds(tab()));
        holds.note(tab(), &message("exclusive", "f1", false, free));
        assert!(holds.holds(tab()));
        holds.note(tab(), &message("exclusive", "main", true, free));
        assert!(!holds.holds(tab()));
    }

    #[test]
    fn a_full_screen_element_alone_doesnt_hold_the_pointer() {
        let mut holds = PointerHolds::default();
        let full = r#"{"held":true,"pointerLock":false}"#;
        holds.note(tab(), &message("exclusive", "main", true, full));
        assert!(!holds.holds(tab()));
    }

    #[test]
    fn a_new_page_or_hostile_payload_clears_or_ignores_holds() {
        let mut holds = PointerHolds::default();
        holds.note(
            tab(),
            &message("exclusive", "main", true, r#"{"pointerLock":true}"#),
        );
        assert!(!holds.note(tab(), &message("hello", "main", true, "{}")));
        assert!(!holds.holds(tab()));
        for hostile in [
            "",
            "null",
            "[]",
            r#"{"pointerLock":"yes"}"#,
            r#"{"pointerLock":1}"#,
        ] {
            holds.note(tab(), &message("exclusive", "main", true, hostile));
            assert!(!holds.holds(tab()), "{hostile}");
        }
        holds.note(
            tab(),
            &message("exclusive", "f", false, r#"{"pointerLock":true}"#),
        );
        holds.forget(tab());
        assert!(!holds.holds(tab()));
    }
}
