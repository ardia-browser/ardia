use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use ardia_state::actions::Action;

thread_local! {
    static REORDER_ON: Cell<bool> = const { Cell::new(true) };
    static PERFORMER: Cell<Option<fn()>> = const { Cell::new(None) };
    static TICKS: Cell<usize> = const { Cell::new(0) };
    static AIMS: RefCell<HashMap<String, Option<String>>> = RefCell::new(HashMap::new());
}

pub fn install_performer(perform: fn()) {
    PERFORMER.with(|cell| cell.set(Some(perform)));
}

pub fn set_reorder_haptics(on: bool) {
    REORDER_ON.with(|cell| cell.set(on));
}

pub fn reorder_ticks() -> usize {
    TICKS.with(Cell::get)
}

pub fn reorder_tick() {
    if !REORDER_ON.with(Cell::get) {
        return;
    }
    TICKS.with(|cell| cell.set(cell.get() + 1));
    if let Some(perform) = PERFORMER.with(Cell::get) {
        perform();
    }
}

pub fn note_aim(scope: &str, aim: Option<String>) {
    let tick = AIMS.with(|aims| {
        let mut aims = aims.borrow_mut();
        let tick = aims
            .get(scope)
            .is_some_and(|before| aim.is_some() && *before != aim);
        aims.insert(scope.to_owned(), aim);
        tick
    });
    if tick {
        reorder_tick();
    }
}

pub fn forget_aim(scope: &str) {
    AIMS.with(|aims| aims.borrow_mut().remove(scope));
}

pub fn tick_for_swaps(actions: &[Action]) {
    if actions
        .iter()
        .any(|action| matches!(action, Action::SwapPanes { .. }))
    {
        reorder_tick();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aims_tick_on_each_new_target_after_the_first() {
        set_reorder_haptics(true);
        let start = reorder_ticks();
        note_aim("w", Some("a".into()));
        assert_eq!(reorder_ticks(), start);
        note_aim("w", Some("a".into()));
        assert_eq!(reorder_ticks(), start);
        note_aim("w", Some("b".into()));
        assert_eq!(reorder_ticks(), start + 1);
        note_aim("w", None);
        assert_eq!(reorder_ticks(), start + 1);
        note_aim("w", Some("b".into()));
        assert_eq!(reorder_ticks(), start + 2);
        forget_aim("w");
        note_aim("w", Some("c".into()));
        assert_eq!(reorder_ticks(), start + 2);
    }

    #[test]
    fn the_setting_silences_every_tick() {
        set_reorder_haptics(false);
        let start = reorder_ticks();
        reorder_tick();
        note_aim("x", Some("a".into()));
        note_aim("x", Some("b".into()));
        tick_for_swaps(&[Action::SwapPanes {
            a: "a".into(),
            b: "b".into(),
        }]);
        assert_eq!(reorder_ticks(), start);
        set_reorder_haptics(true);
        tick_for_swaps(&[Action::SwapPanes {
            a: "a".into(),
            b: "b".into(),
        }]);
        assert_eq!(reorder_ticks(), start + 1);
        forget_aim("x");
    }
}
