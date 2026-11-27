use std::cell::RefCell;
use std::collections::HashMap;

use ardia_state::{TabId, WindowId};

use crate::sidebar::strip_layout::{STRIP_HEIGHT, Slot};

pub const INCOMING_REACH: f32 = 24.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl ScreenRect {
    pub fn contains(&self, point: (f32, f32)) -> bool {
        point.0 >= self.x
            && point.0 < self.x + self.w
            && point.1 >= self.y
            && point.1 < self.y + self.h
    }
}

#[derive(Clone, Debug, Default)]
pub struct CrossDrag {
    pub tab: Option<TabId>,
    pub from: Option<WindowId>,
    pub point: Option<(f32, f32)>,
    pub windows: HashMap<WindowId, ScreenRect>,
    pub inserts: HashMap<WindowId, usize>,
    pub external: HashMap<WindowId, ((f32, f32), std::time::Instant)>,
}

thread_local! {
    static CROSS: RefCell<CrossDrag> = RefCell::new(CrossDrag::default());
}

pub fn with<R>(f: impl FnOnce(&mut CrossDrag) -> R) -> R {
    CROSS.with(|c| f(&mut c.borrow_mut()))
}

pub fn note_bounds(window: &WindowId, rect: ScreenRect) {
    with(|c| {
        c.windows.insert(window.clone(), rect);
    });
}

pub fn moved(window: &WindowId, tab: &TabId, point: (f32, f32)) -> bool {
    with(|c| {
        let was_over = c.point.and_then(|p| over(c, p));
        c.tab = Some(tab.clone());
        c.from = Some(window.clone());
        c.point = Some(point);
        let now_over = over(c, point);
        let entered = now_over.as_ref().filter(|w| *w != window);
        if entered.is_some() && entered != was_over.as_ref().filter(|w| *w != window) {
            crate::primitives::haptics::reorder_tick();
        }
        was_over != now_over || now_over.as_ref().is_some_and(|w| w != window)
    })
}

fn over(c: &CrossDrag, point: (f32, f32)) -> Option<WindowId> {
    c.windows
        .iter()
        .find(|(_, rect)| rect.contains(point))
        .map(|(id, _)| id.clone())
}

pub fn incoming(window: &WindowId) -> Option<(f32, f32)> {
    with(|c| {
        let point = c.point?;
        if c.from.as_ref() == Some(window) || c.tab.is_none() {
            return None;
        }
        let rect = c.windows.get(window)?;
        rect.contains(point)
            .then_some((point.0 - rect.x, point.1 - rect.y))
    })
}

pub const EXTERNAL_LINGER: std::time::Duration = std::time::Duration::from_millis(200);

pub fn external_moved(window: &WindowId, point: (f32, f32)) {
    with(|c| {
        c.external
            .insert(window.clone(), (point, std::time::Instant::now()));
    });
}

pub fn external(window: &WindowId) -> Option<(f32, f32)> {
    with(|c| {
        let (point, at) = c.external.get(window).copied()?;
        if at.elapsed() > EXTERNAL_LINGER {
            c.external.remove(window);
            return None;
        }
        Some(point)
    })
}

pub fn external_dropped(window: &WindowId) -> Option<usize> {
    with(|c| {
        c.external.remove(window);
        c.inserts.get(window).copied()
    })
}

pub fn set_insert(window: &WindowId, index: Option<usize>) {
    with(|c| match index {
        Some(i) => {
            c.inserts.insert(window.clone(), i);
        }
        None => {
            c.inserts.remove(window);
        }
    });
}

pub struct Landing {
    pub tab: TabId,
    pub window: WindowId,
    pub index: Option<usize>,
}

pub fn finish(window: &WindowId) -> Option<Landing> {
    with(|c| {
        if c.from.as_ref() != Some(window) {
            return None;
        }
        let tab = c.tab.take();
        let point = c.point.take();
        c.from = None;
        let target = point.and_then(|p| over(c, p)).filter(|w| w != window);
        let index = target.as_ref().and_then(|w| c.inserts.get(w).copied());
        c.inserts.clear();
        Some(Landing {
            tab: tab?,
            window: target?,
            index,
        })
    })
}

pub fn incoming_index(
    slots: &[Slot],
    x: Option<f32>,
    y: f32,
    pinned_group: &dyn Fn(&TabId) -> bool,
) -> Option<usize> {
    let x = x?;
    if y > STRIP_HEIGHT + INCOMING_REACH {
        return None;
    }
    let mut index = slots.iter().filter(|s| s.left + s.width / 2.0 < x).count();
    while index < slots.len() && slots[index].tabs.first().is_some_and(pinned_group) {
        index += 1;
    }
    Some(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drag_over_another_window_lands_there() {
        let a = WindowId::new("a");
        let b = WindowId::new("b");
        note_bounds(
            &a,
            ScreenRect {
                x: 0.0,
                y: 0.0,
                w: 500.0,
                h: 400.0,
            },
        );
        note_bounds(
            &b,
            ScreenRect {
                x: 600.0,
                y: 0.0,
                w: 500.0,
                h: 400.0,
            },
        );
        let tab = TabId::new("t");
        moved(&a, &tab, (100.0, 20.0));
        assert_eq!(incoming(&b), None);
        assert!(moved(&a, &tab, (700.0, 20.0)));
        assert_eq!(incoming(&b), Some((100.0, 20.0)));
        assert_eq!(incoming(&a), None);
        set_insert(&b, Some(2));
        let landing = finish(&a).and_then(|l| Some((l.tab, l.window, l.index?)));
        assert_eq!(landing, Some((tab, b.clone(), 2)));
        assert_eq!(incoming(&b), None);
    }

    #[test]
    fn external_drags_hover_briefly_and_land_at_the_insert() {
        let w = WindowId::new("x");
        external_moved(&w, (10.0, 5.0));
        assert_eq!(external(&w), Some((10.0, 5.0)));
        set_insert(&w, Some(3));
        assert_eq!(external_dropped(&w), Some(3));
        assert_eq!(external(&w), None);
    }

    #[test]
    fn the_insert_point_skips_pinned_groups() {
        let slots: Vec<Slot> = (0..3)
            .map(|i| Slot {
                tabs: vec![TabId::new(format!("t{i}"))],
                width: 100.0,
                left: i as f32 * 104.0,
            })
            .collect();
        let none = |_: &TabId| false;
        assert_eq!(incoming_index(&slots, Some(10.0), 20.0, &none), Some(0));
        assert_eq!(incoming_index(&slots, Some(160.0), 20.0, &none), Some(2));
        assert_eq!(incoming_index(&slots, Some(160.0), 90.0, &none), None);
        let first = |t: &TabId| t.as_str() == "t0";
        assert_eq!(incoming_index(&slots, Some(10.0), 20.0, &first), Some(1));
    }
}
