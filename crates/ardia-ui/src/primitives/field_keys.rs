use std::time::{Duration, Instant};

pub const HELD_ESCAPE_GAP: Duration = Duration::from_millis(1200);

const MODIFIER_KEYS: &[&str] = &[
    "alt",
    "altgraph",
    "capslock",
    "control",
    "ctrl",
    "fn",
    "fnlock",
    "hyper",
    "meta",
    "cmd",
    "numlock",
    "os",
    "scrolllock",
    "shift",
    "super",
    "symbol",
    "symbollock",
    "platform",
    "function",
];

pub fn is_modifier_key(key: &str) -> bool {
    MODIFIER_KEYS
        .iter()
        .any(|modifier| modifier.eq_ignore_ascii_case(key))
}

fn is_escape(key: &str) -> bool {
    key.eq_ignore_ascii_case("escape")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HeldEscape {
    down_at: Option<Instant>,
}

impl HeldEscape {
    pub const RELEASED: Self = HeldEscape { down_at: None };

    pub fn key_down(&mut self, key: &str, now: Instant, repeat: Option<bool>) -> bool {
        if is_escape(key) {
            let held = match repeat {
                Some(repeat) => repeat,
                None => self
                    .down_at
                    .is_some_and(|at| now.saturating_duration_since(at) < HELD_ESCAPE_GAP),
            };
            self.down_at = Some(now);
            return held;
        }
        if !is_modifier_key(key) {
            *self = Self::RELEASED;
        }
        false
    }

    pub fn key_up(&mut self, key: &str) {
        if is_escape(key) {
            *self = Self::RELEASED;
        }
    }

    pub fn release(&mut self) {
        *self = Self::RELEASED;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repeating_escape_counts_as_held() {
        let now = Instant::now();
        let mut state = HeldEscape::default();
        assert!(!state.key_down("escape", now, Some(false)));
        assert!(state.key_down("escape", now, Some(true)));
    }

    #[test]
    fn without_repeat_info_a_quick_second_escape_counts_as_held() {
        let now = Instant::now();
        let mut state = HeldEscape::default();
        assert!(!state.key_down("escape", now, None));
        assert!(state.key_down("escape", now + Duration::from_millis(300), None));
        assert!(!state.key_down("escape", now + Duration::from_millis(2000), None));
    }

    #[test]
    fn other_keys_release_but_modifiers_do_not() {
        let now = Instant::now();
        let mut state = HeldEscape::default();
        state.key_down("escape", now, None);
        assert!(!state.key_down("shift", now, None));
        assert!(state.key_down("escape", now, None));
        assert!(!state.key_down("a", now, None));
        assert!(!state.key_down("escape", now, None));
        state.key_up("escape");
        assert_eq!(state, HeldEscape::RELEASED);
    }
}
