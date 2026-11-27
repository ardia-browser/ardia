use std::collections::HashMap;
use std::time::{Duration, Instant};

use ardia_state::GroupId;
use ardia_theme::motion::{CubicBezier, HOVER_CARD_FADE_MS};
use gpui::{App, Global};

pub const FOLD_MS: u64 = 150;
pub const FOLD_CURVE: CubicBezier = CubicBezier::new(0.33, 1.0, 0.68, 1.0);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transition {
    pub on: bool,
    pub at: Instant,
}

impl Transition {
    fn settled(on: bool) -> Self {
        Transition {
            on,
            at: Instant::now() - Duration::from_secs(1),
        }
    }

    pub fn progress(&self, ms: u64, curve: CubicBezier) -> (f32, bool) {
        let t = self.at.elapsed().as_secs_f64() / Duration::from_millis(ms).as_secs_f64();
        let moving = t < 1.0;
        let eased = curve.ease(t.clamp(0.0, 1.0)) as f32;
        (if self.on { eased } else { 1.0 - eased }, moving)
    }
}

#[derive(Clone, Debug)]
struct Hovered {
    group: GroupId,
    ancestors: Vec<GroupId>,
}

#[derive(Default)]
pub struct GroupUi {
    hovered: Vec<Hovered>,
    folds: HashMap<GroupId, Transition>,
    boxes: HashMap<GroupId, Transition>,
}

impl Global for GroupUi {}

impl GroupUi {
    pub fn set_hovered(&mut self, group: &GroupId, ancestors: Vec<GroupId>, hovered: bool) {
        self.hovered.retain(|h| &h.group != group);
        if hovered {
            self.hovered.push(Hovered {
                group: group.clone(),
                ancestors,
            });
        }
    }

    pub fn innermost(&self, group: &GroupId) -> bool {
        self.hovered.iter().any(|h| &h.group == group)
            && !self
                .hovered
                .iter()
                .any(|h| &h.group != group && h.ancestors.contains(group))
    }

    pub fn open(&mut self, group: &GroupId, open: bool) -> (f32, bool) {
        let entry = self
            .folds
            .entry(group.clone())
            .or_insert_with(|| Transition::settled(open));
        if entry.on != open {
            let (now, moving) = entry.progress(FOLD_MS, FOLD_CURVE);
            let elapsed = if moving {
                let left = if open { 1.0 - now } else { now };
                Duration::from_millis(FOLD_MS).mul_f32(1.0 - left.clamp(0.0, 1.0))
            } else {
                Duration::ZERO
            };
            *entry = Transition {
                on: open,
                at: Instant::now() - elapsed,
            };
        }
        entry.progress(FOLD_MS, FOLD_CURVE)
    }

    pub fn box_opacity(&mut self, group: &GroupId, shown: bool) -> (f32, bool) {
        let entry = self
            .boxes
            .entry(group.clone())
            .or_insert_with(|| Transition::settled(shown));
        if entry.on != shown {
            *entry = Transition {
                on: shown,
                at: Instant::now(),
            };
        }
        entry.progress(HOVER_CARD_FADE_MS, CubicBezier::HOVER_CARD)
    }
}

pub fn group_ui(cx: &mut App) -> &mut GroupUi {
    cx.default_global::<GroupUi>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_innermost_hovered_group_lights_its_box() {
        let mut ui = GroupUi::default();
        let outer = GroupId::new("outer");
        let inner = GroupId::new("inner");
        ui.set_hovered(&outer, Vec::new(), true);
        assert!(ui.innermost(&outer));
        ui.set_hovered(&inner, vec![outer.clone()], true);
        assert!(!ui.innermost(&outer));
        assert!(ui.innermost(&inner));
        ui.set_hovered(&inner, vec![outer.clone()], false);
        assert!(ui.innermost(&outer));
    }

    #[test]
    fn a_fold_starts_settled_and_moves_on_change() {
        let mut ui = GroupUi::default();
        let g = GroupId::new("g");
        assert_eq!(ui.open(&g, false), (0.0, false));
        let (open, moving) = ui.open(&g, true);
        assert!(moving);
        assert!(open < 0.5);
        assert_eq!(ui.box_opacity(&g, true), (1.0, false));
        let (shown, moving) = ui.box_opacity(&g, false);
        assert!(moving && shown > 0.9);
    }
}
