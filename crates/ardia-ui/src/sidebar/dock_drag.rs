use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

use ardia_state::TabId;

use crate::sidebar::drag_motion::{ROOM_OMEGA, Slide};
use crate::sidebar::strip_layout::{PINNED_CELL, PINNED_SPACING, STRIP_HEIGHT};

pub const DOCK_LIFT_SLOP: f32 = 12.0;
pub const DOCK_PITCH: f32 = PINNED_CELL + PINNED_SPACING;

#[derive(Clone, Debug)]
pub struct DockDrag {
    pub from: usize,
    pub cells: Vec<Vec<TabId>>,
    pub start_x: Option<f32>,
    pub dx: f32,
    pub to: usize,
    pub lifted: bool,
    pub local: bool,
    shifts: Vec<Slide>,
}

#[derive(Clone, Debug)]
struct Landing {
    tab: TabId,
    slide: Slide,
}

#[derive(Default)]
struct Docks {
    drags: HashMap<String, DockDrag>,
    landings: HashMap<String, Landing>,
}

thread_local! {
    static DOCKS: RefCell<Docks> = RefCell::new(Docks::default());
}

pub fn drag_range(from: usize, count: usize) -> (f32, f32) {
    let last = count.saturating_sub(1);
    (
        -(from as f32) * DOCK_PITCH,
        (last.saturating_sub(from)) as f32 * DOCK_PITCH,
    )
}

pub fn dock_drop_index(from: usize, count: usize, dx: f32) -> usize {
    let left = from as f32 * DOCK_PITCH + dx;
    let right = left + PINNED_CELL;
    (0..count)
        .filter(|i| {
            let centre = *i as f32 * DOCK_PITCH + PINNED_CELL / 2.0;
            if *i < from {
                centre < left
            } else {
                *i > from && centre < right
            }
        })
        .count()
}

pub fn shift_of(index: usize, from: usize, to: usize) -> f32 {
    if from < to && index > from && index <= to {
        -DOCK_PITCH
    } else if to < from && index >= to && index < from {
        DOCK_PITCH
    } else {
        0.0
    }
}

pub fn begin(window: &str, from: usize, cells: Vec<Vec<TabId>>, local: bool, start_x: f32) {
    let count = cells.len();
    DOCKS.with(|d| {
        let mut d = d.borrow_mut();
        d.landings.remove(window);
        d.drags.insert(
            window.to_owned(),
            DockDrag {
                from,
                cells,
                start_x: Some(start_x),
                dx: 0.0,
                to: from,
                lifted: false,
                local,
                shifts: (0..count)
                    .map(|_| Slide::resting(0.0, ROOM_OMEGA))
                    .collect(),
            },
        );
    });
}

pub fn active(window: &str) -> bool {
    DOCKS.with(|d| d.borrow().drags.contains_key(window))
}

pub fn lifted(window: &str) -> bool {
    DOCKS.with(|d| d.borrow().drags.get(window).is_some_and(|drag| drag.lifted))
}

pub fn ghost_hidden(window: &str) -> bool {
    DOCKS.with(|d| {
        d.borrow()
            .drags
            .get(window)
            .is_some_and(|drag| !drag.lifted)
    })
}

pub fn moved(window: &str, x: f32, y: f32, now: Instant) -> bool {
    DOCKS.with(|d| {
        let mut d = d.borrow_mut();
        let Some(drag) = d.drags.get_mut(window) else {
            return false;
        };
        let start = *drag.start_x.get_or_insert(x);
        let count = drag.cells.len();
        let lifted = !drag.local && y > STRIP_HEIGHT + DOCK_LIFT_SLOP;
        let (lo, hi) = drag_range(drag.from, count);
        let dx = if lifted {
            drag.dx
        } else {
            (x - start).clamp(lo, hi)
        };
        let to = if lifted {
            drag.from
        } else {
            dock_drop_index(drag.from, count, dx)
        };
        let changed = dx != drag.dx || to != drag.to || lifted != drag.lifted;
        if !lifted && !drag.lifted && to != drag.to {
            crate::primitives::haptics::reorder_tick();
        }
        drag.dx = dx;
        drag.lifted = lifted;
        if to != drag.to || changed {
            drag.to = to;
            let from = drag.from;
            for (i, slide) in drag.shifts.iter_mut().enumerate() {
                if i != from {
                    slide.aim(shift_of(i, from, to), now);
                }
            }
        }
        changed
    })
}

pub fn cell_offset(window: &str, index: usize, lead: &TabId, now: Instant) -> (f32, bool, bool) {
    DOCKS.with(|d| {
        let d = d.borrow();
        if let Some(drag) = d.drags.get(window) {
            if index == drag.from {
                return (drag.dx, drag.lifted, false);
            }
            let slide = drag.shifts.get(index);
            return (
                slide.map_or(0.0, |s| s.value(now)),
                false,
                slide.is_some_and(|s| s.moving(now)),
            );
        }
        match d.landings.get(window).filter(|l| &l.tab == lead) {
            Some(landing) => (landing.slide.value(now), false, landing.slide.moving(now)),
            None => (0.0, false, false),
        }
    })
}

pub fn moving(window: &str, now: Instant) -> bool {
    DOCKS.with(|d| {
        let d = d.borrow();
        d.drags
            .get(window)
            .is_some_and(|drag| drag.shifts.iter().any(|s| s.moving(now)))
            || d.landings.get(window).is_some_and(|l| l.slide.moving(now))
    })
}

pub fn cancel(window: &str) {
    DOCKS.with(|d| {
        d.borrow_mut().drags.remove(window);
    });
}

pub fn release(window: &str, now: Instant) -> Option<(Vec<TabId>, Option<TabId>)> {
    DOCKS.with(|d| {
        let mut d = d.borrow_mut();
        let drag = d.drags.remove(window)?;
        if drag.lifted {
            return None;
        }
        let moving = drag.cells.get(drag.from)?.clone();
        let lead = moving.first()?.clone();
        let residual = drag.from as f32 * DOCK_PITCH + drag.dx - drag.to as f32 * DOCK_PITCH;
        let mut slide = Slide::resting(residual, ROOM_OMEGA);
        slide.aim(0.0, now);
        d.landings
            .insert(window.to_owned(), Landing { tab: lead, slide });
        if drag.to == drag.from {
            return Some((Vec::new(), None));
        }
        let rest: Vec<&Vec<TabId>> = drag
            .cells
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != drag.from)
            .map(|(_, c)| c)
            .collect();
        let before = rest.get(drag.to).and_then(|c| c.first().cloned());
        Some((moving, before))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells(n: usize) -> Vec<Vec<TabId>> {
        (0..n)
            .map(|i| vec![TabId::new(format!("t{i}").as_str())])
            .collect()
    }

    #[test]
    fn a_cell_takes_a_new_slot_once_it_passes_a_neighbours_centre() {
        assert_eq!(dock_drop_index(0, 4, 0.0), 0);
        assert_eq!(dock_drop_index(0, 4, 20.0), 1);
        assert_eq!(dock_drop_index(0, 4, 56.0), 2);
        assert_eq!(dock_drop_index(3, 4, -90.0), 1);
        assert_eq!(drag_range(1, 4), (-DOCK_PITCH, 2.0 * DOCK_PITCH));
        assert_eq!(shift_of(1, 0, 2), -DOCK_PITCH);
        assert_eq!(shift_of(3, 0, 2), 0.0);
        assert_eq!(shift_of(1, 3, 1), DOCK_PITCH);
    }

    #[test]
    fn neighbours_slide_aside_and_the_cell_lands_on_the_spring() {
        let now = Instant::now();
        begin("dock-w", 0, cells(4), false, 100.0);
        assert!(ghost_hidden("dock-w"));
        moved("dock-w", 100.0, 20.0, now);
        moved("dock-w", 160.0, 20.0, now);
        let (shift, _, moving) = cell_offset(
            "dock-w",
            1,
            &TabId::new("t1"),
            now + std::time::Duration::from_millis(16),
        );
        assert!(moving && shift < 0.0 && shift > -DOCK_PITCH, "{shift}");
        let (dx, hidden, _) = cell_offset("dock-w", 0, &TabId::new("t0"), now);
        assert_eq!((dx, hidden), (60.0, false));
        let (moving_ids, before) = release("dock-w", now).expect("a drop in the dock");
        assert_eq!(moving_ids, vec![TabId::new("t0")]);
        assert_eq!(before, Some(TabId::new("t3")));
        let (left, _, landing) = cell_offset(
            "dock-w",
            2,
            &TabId::new("t0"),
            now + std::time::Duration::from_millis(16),
        );
        assert!(landing && left.abs() <= 12.0, "{left}");
        assert!(!active("dock-w"));
    }

    #[test]
    fn pulling_a_tile_below_the_strip_lifts_it_out_but_a_folder_stays() {
        let now = Instant::now();
        begin("dock-lift", 1, cells(3), false, 50.0);
        moved("dock-lift", 50.0, 20.0, now);
        moved("dock-lift", 50.0, STRIP_HEIGHT + DOCK_LIFT_SLOP + 1.0, now);
        assert!(lifted("dock-lift") && !ghost_hidden("dock-lift"));
        assert!(release("dock-lift", now).is_none());
        begin("dock-local", 1, cells(3), true, 50.0);
        moved("dock-local", 50.0, 20.0, now);
        moved("dock-local", 50.0, 200.0, now);
        assert!(!lifted("dock-local"));
        cancel("dock-local");
    }
}
