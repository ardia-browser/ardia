use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use ardia_state::{GroupId, TabId};
use ardia_theme::layout::sidebar;
use gpui::{
    AnchoredPositionMode, AnyElement, App, Bounds, IntoElement, ParentElement, Pixels, Point,
    Window, anchored, deferred, div, point, size,
};

use crate::scale::px;
use crate::sidebar::drag::{DropSpot, SplitHalf, with_drag};

pub const ROOM_OMEGA: f32 = 90.0;
pub const MORPH_OMEGA: f32 = std::f32::consts::TAU / 0.1;
pub const REST_PROGRESS: f32 = 0.998;
pub const LIFT_SLOP: f32 = 10.0;
pub const AWAY_SLOP: f32 = 40.0;
pub const SETTLE_LIMIT_MS: u64 = 600;
pub const PANE_INSET: f32 = 4.0;
pub const PANE_GAP: f32 = 4.0;
pub const SCROLL_EDGE: f32 = 28.0;

pub fn edge_scroll_speed(y: f32, top: f32, height: f32, edge: f32) -> f32 {
    if y < top + edge {
        -((top + edge - y) / 4.0).ceil()
    } else if y > top + height - edge {
        ((y - (top + height - edge)) / 4.0).ceil()
    } else {
        0.0
    }
}

pub fn critical(elapsed: Duration, omega: f32) -> f32 {
    let t = elapsed.as_secs_f32() * omega;
    (1.0 - (1.0 + t) * (-t).exp()).clamp(0.0, 1.0)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slide {
    pub from: f32,
    pub to: f32,
    pub since: Instant,
    pub omega: f32,
}

impl Slide {
    pub fn resting(value: f32, omega: f32) -> Self {
        Slide {
            from: value,
            to: value,
            since: Instant::now(),
            omega,
        }
    }

    pub fn progress(&self, now: Instant) -> f32 {
        if self.from == self.to {
            return 1.0;
        }
        let p = critical(now.saturating_duration_since(self.since), self.omega);
        if p >= REST_PROGRESS { 1.0 } else { p }
    }

    pub fn value(&self, now: Instant) -> f32 {
        self.from + (self.to - self.from) * self.progress(now)
    }

    pub fn moving(&self, now: Instant) -> bool {
        self.progress(now) < 1.0
    }

    pub fn aim(&mut self, to: f32, now: Instant) -> bool {
        if (self.to - to).abs() < f32::EPSILON {
            return false;
        }
        self.from = self.value(now);
        self.to = to;
        self.since = now;
        true
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RoomKey {
    Above(TabId),
    Below(TabId),
    End,
    Source,
}

#[derive(Clone, Debug, Default)]
pub struct Room {
    slides: HashMap<RoomKey, Slide>,
}

impl Room {
    pub fn aim(&mut self, targets: &[(RoomKey, f32)], now: Instant) -> bool {
        let mut changed = false;
        for (key, slide) in self.slides.iter_mut() {
            if !targets.iter().any(|(k, _)| k == key) {
                changed |= slide.aim(0.0, now);
            }
        }
        for (key, to) in targets {
            match self.slides.get_mut(key) {
                Some(slide) => changed |= slide.aim(*to, now),
                None => {
                    let mut slide = Slide::resting(0.0, ROOM_OMEGA);
                    changed |= slide.aim(*to, now);
                    self.slides.insert(key.clone(), slide);
                }
            }
        }
        self.slides
            .retain(|_, slide| slide.moving(now) || slide.to != 0.0);
        changed
    }

    pub fn start(&mut self, key: RoomKey, value: f32) {
        self.slides.insert(key, Slide::resting(value, ROOM_OMEGA));
    }

    pub fn value(&self, key: &RoomKey, now: Instant) -> f32 {
        self.slides.get(key).map_or(0.0, |s| s.value(now))
    }

    pub fn has(&self, key: &RoomKey) -> bool {
        self.slides.contains_key(key)
    }

    pub fn moving(&self, now: Instant) -> bool {
        self.slides.values().any(|s| s.moving(now))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lane {
    pub pinned: bool,
    pub group: Option<GroupId>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RowFrame {
    pub tab: TabId,
    pub top: f32,
    pub left: f32,
    pub width: f32,
    pub lane: Lane,
    pub splits: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Metrics {
    pub pitch: f32,
    pub height: f32,
}

impl Metrics {
    pub fn now() -> Self {
        Metrics {
            pitch: f32::from(px(sidebar::row_pitch())),
            height: f32::from(px(sidebar::row_height())),
        }
    }
}

pub fn shown_top(
    frame: &RowFrame,
    frames: &[RowFrame],
    source: Option<&RowFrame>,
    gap: Option<&DropSpot>,
    m: Metrics,
) -> f32 {
    let anchor = |tab: &TabId| frames.iter().find(|f| &f.tab == tab).map(|f| f.top);
    let opened = match gap {
        Some(DropSpot::BeforeRow(t)) => anchor(t).is_some_and(|top| top <= frame.top),
        Some(DropSpot::AfterRow(t)) => anchor(t).is_some_and(|top| top < frame.top),
        _ => false,
    };
    let mut dy = if opened { m.pitch } else { 0.0 };
    if gap.is_some() && source.is_some_and(|s| s.top < frame.top) {
        dy -= m.pitch;
    }
    frame.top + dy
}

pub fn aim_rows(
    frames: &[RowFrame],
    source: Option<&RowFrame>,
    gap: Option<&DropSpot>,
    y: f32,
    m: Metrics,
) -> DropSpot {
    let top = |f: &RowFrame| shown_top(f, frames, source, gap, m);
    let Some(at) = frames.iter().position(|f| top(f) + m.height / 2.0 > y) else {
        return DropSpot::RowsEnd;
    };
    let below = &frames[at];
    if at > 0 {
        let above = &frames[at - 1];
        if above.lane != below.lane {
            let seam = (top(above) + m.height + top(below)) / 2.0;
            if y < seam {
                return DropSpot::AfterRow(above.tab.clone());
            }
        }
    }
    DropSpot::BeforeRow(below.tab.clone())
}

pub fn split_hit(
    frames: &[RowFrame],
    source: Option<&RowFrame>,
    gap: Option<&DropSpot>,
    pointer: Point<f32>,
    m: Metrics,
) -> Option<(TabId, SplitHalf)> {
    frames.iter().find_map(|f| {
        let top = shown_top(f, frames, source, gap, m);
        let inside_x = pointer.x >= f.left && pointer.x <= f.left + f.width;
        let band = pointer.y > top + m.height * 0.25 && pointer.y < top + m.height * 0.75;
        (f.splits && inside_x && band).then(|| {
            let half = if pointer.x < f.left + f.width / 2.0 {
                SplitHalf::Left
            } else {
                SplitHalf::Right
            };
            (f.tab.clone(), half)
        })
    })
}

pub fn gap_beside(frames: &[RowFrame], gap: Option<&DropSpot>, tab: &TabId) -> bool {
    match gap {
        Some(DropSpot::BeforeRow(t)) => {
            if t == tab {
                return true;
            }
            let at = frames.iter().position(|f| &f.tab == tab);
            at.and_then(|i| frames.get(i + 1))
                .is_some_and(|next| &next.tab == t)
        }
        Some(DropSpot::AfterRow(t)) => t == tab,
        Some(DropSpot::RowsEnd) => frames.last().is_some_and(|f| &f.tab == tab),
        _ => false,
    }
}

pub fn room_targets(
    gap: Option<&DropSpot>,
    collapse_source: bool,
    m: Metrics,
) -> Vec<(RoomKey, f32)> {
    let mut out = Vec::new();
    match gap {
        Some(DropSpot::BeforeRow(t)) => out.push((RoomKey::Above(t.clone()), m.pitch)),
        Some(DropSpot::AfterRow(t)) => out.push((RoomKey::Below(t.clone()), m.pitch)),
        Some(DropSpot::RowsEnd) => out.push((RoomKey::End, m.pitch)),
        _ => {}
    }
    if collapse_source {
        out.push((RoomKey::Source, 0.0));
    }
    out
}

pub fn slot_of(
    frames: &[RowFrame],
    source: Option<&RowFrame>,
    gap: Option<&DropSpot>,
    m: Metrics,
) -> Option<Point<f32>> {
    let find = |tab: &TabId| frames.iter().find(|f| &f.tab == tab);
    let top = |f: &RowFrame| shown_top(f, frames, source, gap, m);
    match gap? {
        DropSpot::BeforeRow(t) => find(t).map(|f| point(f.left, top(f) - m.pitch)),
        DropSpot::AfterRow(t) => find(t).map(|f| point(f.left, top(f) + m.pitch)),
        DropSpot::RowsEnd => frames
            .last()
            .map(|f| point(f.left, top(f) + m.pitch))
            .or_else(|| source.map(|s| point(s.left, s.top))),
        _ => None,
    }
}

pub fn pane_slot(frame: &RowFrame, top: f32, half: SplitHalf, m: Metrics) -> Bounds<Pixels> {
    let inset = f32::from(px(PANE_INSET));
    let gap = f32::from(px(PANE_GAP));
    let slot = ((frame.width - inset * 2.0 - gap) / 2.0).max(0.0);
    let x = frame.left
        + inset
        + match half {
            SplitHalf::Left => 0.0,
            SplitHalf::Right => slot + gap,
        };
    Bounds::new(
        point(gpui::px(x), gpui::px(top + inset)),
        size(gpui::px(slot), gpui::px(m.height - inset * 2.0)),
    )
}

#[derive(Clone, Debug)]
pub struct Preview {
    pub tab: TabId,
    pub half: SplitHalf,
    pub shown: Slide,
    pub to_left: Slide,
}

pub fn aim_preview(
    preview: &mut Option<Preview>,
    armed: Option<(&TabId, SplitHalf)>,
    now: Instant,
) {
    let left = |h: SplitHalf| if h == SplitHalf::Left { 1.0 } else { 0.0 };
    match (preview.as_mut(), armed) {
        (Some(p), Some((tab, half))) if &p.tab == tab => {
            p.shown.aim(1.0, now);
            p.to_left.aim(left(half), now);
            p.half = half;
        }
        (_, Some((tab, half))) => {
            let mut shown = Slide::resting(0.0, MORPH_OMEGA);
            shown.aim(1.0, now);
            *preview = Some(Preview {
                tab: tab.clone(),
                half,
                shown,
                to_left: Slide::resting(left(half), MORPH_OMEGA),
            });
        }
        (Some(p), None) => {
            p.shown.aim(0.0, now);
        }
        (None, None) => {}
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RowRoom {
    pub above: f32,
    pub below: f32,
    pub collapse: Option<f32>,
    pub moving: bool,
    pub hidden: bool,
}

#[derive(Clone)]
pub struct Landing {
    pub ghost: Rc<crate::sidebar::drag::Ghost>,
    pub from: Point<f32>,
    pub to: Point<f32>,
    pub since: Instant,
}

#[derive(Clone)]
pub struct Settle {
    pub source: TabId,
    pub room: Room,
    pub order: Rc<Vec<TabId>>,
    pub since: Instant,
    pub released: bool,
    pub landing: Option<Landing>,
    pub group: Option<ardia_state::GroupId>,
}

thread_local! {
    static SETTLES: RefCell<HashMap<String, Settle>> = RefCell::new(HashMap::new());
}

pub fn settle(window: &str, settle: Settle) {
    SETTLES.with(|s| s.borrow_mut().insert(window.to_owned(), settle));
}

pub fn clear_settle(window: &str) {
    SETTLES.with(|s| s.borrow_mut().remove(window));
}

pub fn note_order(window: &str, order: &[TabId]) {
    SETTLES.with(|s| {
        if let Some(settle) = s.borrow_mut().get_mut(window)
            && settle.order.as_slice() != order
        {
            settle.released = true;
        }
    });
}

fn landing_progress(landing: &Landing, now: Instant) -> f32 {
    let p = critical(now.saturating_duration_since(landing.since), ROOM_OMEGA);
    if p >= REST_PROGRESS { 1.0 } else { p }
}

fn with_settle<R>(window: &str, f: impl FnOnce(&mut Settle, Instant) -> R) -> Option<R> {
    let now = Instant::now();
    SETTLES.with(|cell| {
        let mut map = cell.borrow_mut();
        let settle = map.get_mut(window)?;
        if now.saturating_duration_since(settle.since) >= Duration::from_millis(SETTLE_LIMIT_MS) {
            settle.released = true;
        }
        let landed = settle
            .landing
            .as_ref()
            .is_none_or(|l| landing_progress(l, now) >= 1.0);
        if settle.released && landed {
            map.remove(window);
            return None;
        }
        Some(f(settle, now))
    })
}

pub fn busy(window: &str) -> bool {
    with_drag(window, |s| s.dragging.is_some() && s.lifted)
        || SETTLES.with(|s| s.borrow().contains_key(window))
}

thread_local! {
    static INCOMING: RefCell<HashMap<(String, TabId), (Slide, Slide)>> = RefCell::new(HashMap::new());
}

pub fn incoming_room(window: &str, tab: &TabId, above: f32, below: f32, now: Instant) -> RowRoom {
    INCOMING.with(|cell| {
        let mut rooms = cell.borrow_mut();
        let key = (window.to_owned(), tab.clone());
        if above <= 0.0 && below <= 0.0 && !rooms.contains_key(&key) {
            return RowRoom::default();
        }
        let (up, down) = rooms.entry(key.clone()).or_insert_with(|| {
            (
                Slide::resting(0.0, ROOM_OMEGA),
                Slide::resting(0.0, ROOM_OMEGA),
            )
        });
        up.aim(above, now);
        down.aim(below, now);
        let room = RowRoom {
            above: up.value(now),
            below: down.value(now),
            moving: up.moving(now) || down.moving(now),
            ..RowRoom::default()
        };
        if !room.moving && above <= 0.0 && below <= 0.0 {
            rooms.remove(&key);
        }
        room
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GroupRoom {
    pub height: Option<f32>,
    pub moving: bool,
}

pub fn group_room(window: &str, group: &ardia_state::GroupId) -> Option<GroupRoom> {
    let live = with_drag(window, |s| {
        s.dragging.as_ref()?;
        if !s.lifted || s.group.as_ref() != Some(group) {
            return None;
        }
        let now = Instant::now();
        Some(GroupRoom {
            height: Some(s.room.value(&RoomKey::Source, now)),
            moving: s.room.moving(now),
        })
    });
    if live.is_some() {
        return live;
    }
    with_settle(window, |settle, now| {
        if settle.group.as_ref() != Some(group) {
            return None;
        }
        if settle.released {
            let landing = settle
                .landing
                .as_ref()
                .is_some_and(|l| landing_progress(l, now) < 1.0);
            return landing.then_some(GroupRoom {
                height: None,
                moving: true,
            });
        }
        Some(GroupRoom {
            height: Some(settle.room.value(&RoomKey::Source, now)),
            moving: true,
        })
    })
    .flatten()
}

pub fn row_room(window: &str, tab: &TabId) -> Option<RowRoom> {
    let live = with_drag(window, |s| {
        s.dragging.as_ref()?;
        let now = Instant::now();
        let mine = s.lifted && s.dragging.as_ref() == Some(tab);
        let source = mine && s.room.has(&RoomKey::Source);
        Some(RowRoom {
            above: s.room.value(&RoomKey::Above(tab.clone()), now),
            below: s.room.value(&RoomKey::Below(tab.clone()), now),
            collapse: source.then(|| s.room.value(&RoomKey::Source, now)),
            moving: s.room.moving(now) || s.preview_moving(now),
            hidden: mine,
        })
    });
    if live.is_some() {
        return live;
    }
    with_settle(window, |settle, now| {
        let landing = settle
            .landing
            .as_ref()
            .filter(|l| landing_progress(l, now) < 1.0);
        let hidden = &settle.source == tab && (landing.is_some() || !settle.released);
        if settle.released {
            return RowRoom {
                hidden,
                moving: landing.is_some(),
                ..RowRoom::default()
            };
        }
        let source = &settle.source == tab;
        RowRoom {
            above: settle.room.value(&RoomKey::Above(tab.clone()), now),
            below: settle.room.value(&RoomKey::Below(tab.clone()), now),
            collapse: source.then(|| settle.room.value(&RoomKey::Source, now)),
            moving: true,
            hidden,
        }
    })
}

pub fn end_room(window: &str) -> Option<f32> {
    let live = with_drag(window, |s| {
        s.dragging
            .as_ref()
            .map(|_| s.room.value(&RoomKey::End, Instant::now()))
    });
    live.or_else(|| {
        with_settle(window, |settle, now| {
            if settle.released {
                0.0
            } else {
                settle.room.value(&RoomKey::End, now)
            }
        })
    })
}

pub fn landing_ghost(window: &str) -> Option<AnyElement> {
    let (landing, p) = with_settle(window, |settle, now| {
        settle
            .landing
            .clone()
            .map(|l| {
                let p = landing_progress(&l, now);
                (l, p)
            })
            .filter(|(_, p)| *p < 1.0)
    })
    .flatten()?;
    let at = point(
        landing.from.x + (landing.to.x - landing.from.x) * p,
        landing.from.y + (landing.to.y - landing.from.y) * p,
    );
    Some(
        deferred(
            anchored()
                .position_mode(AnchoredPositionMode::Window)
                .position(point(gpui::px(at.x), gpui::px(at.y)))
                .child(
                    div()
                        .child(crate::sidebar::drag::ghost_face(
                            &landing.ghost,
                            landing.ghost.row_width,
                            sidebar::row_height(),
                            crate::sidebar::row_look::chrome_radius(),
                            false,
                            1.0,
                        ))
                        .child(crate::sidebar::tab_row::frame_pump()),
                ),
        )
        .with_priority(2)
        .into_any_element(),
    )
}

pub fn retarget_later(window_key: &str, after: Duration, win: &mut Window, cx: &mut App) {
    let key = window_key.to_owned();
    win.spawn(cx, async move |cx| {
        cx.background_executor().timer(after).await;
        let _ = cx.update(|window, cx| {
            if crate::sidebar::drag::retarget(&key, window, cx) {
                window.refresh();
            }
        });
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gap_for_a_tab_from_elsewhere_opens_and_closes_on_the_room_spring() {
        let now = Instant::now();
        let tab = TabId::new("incoming-gap");
        assert_eq!(incoming_room("w", &tab, 0.0, 0.0, now).above, 0.0);
        let opening = incoming_room("w", &tab, 36.0, 0.0, now);
        assert_eq!(opening.above, 0.0);
        assert!(opening.moving);
        let mid = incoming_room(
            "w",
            &tab,
            36.0,
            0.0,
            now + std::time::Duration::from_millis(16),
        )
        .above;
        assert!(mid > 0.0 && mid < 36.0, "{mid}");
        let open = incoming_room(
            "w",
            &tab,
            36.0,
            0.0,
            now + std::time::Duration::from_millis(300),
        );
        assert!((open.above - 36.0).abs() < 0.5 && !open.moving);
        incoming_room(
            "w",
            &tab,
            0.0,
            0.0,
            now + std::time::Duration::from_millis(316),
        );
        let closing = incoming_room(
            "w",
            &tab,
            0.0,
            0.0,
            now + std::time::Duration::from_millis(332),
        )
        .above;
        assert!(closing > 0.0 && closing < 36.0, "{closing}");
    }

    fn frame(id: &str, top: f32, pinned: bool) -> RowFrame {
        RowFrame {
            tab: TabId::from(id),
            top,
            left: 9.0,
            width: 200.0,
            lane: Lane {
                pinned,
                group: None,
            },
            splits: !pinned,
        }
    }

    fn m() -> Metrics {
        Metrics {
            pitch: 37.0,
            height: 34.0,
        }
    }

    #[test]
    fn the_room_spring_is_critically_damped_and_settles_in_about_a_tenth_of_a_second() {
        assert_eq!(critical(Duration::ZERO, ROOM_OMEGA), 0.0);
        let early = critical(Duration::from_millis(16), ROOM_OMEGA);
        assert!(early > 0.35 && early < 0.5, "{early}");
        assert!(critical(Duration::from_millis(100), ROOM_OMEGA) > REST_PROGRESS);
        let mut last = 0.0;
        for ms in 0..120 {
            let p = critical(Duration::from_millis(ms), ROOM_OMEGA);
            assert!(p >= last && p <= 1.0);
            last = p;
        }
    }

    #[test]
    fn a_retargeted_slide_starts_from_where_it_is() {
        let now = Instant::now();
        let mut slide = Slide::resting(0.0, ROOM_OMEGA);
        slide.aim(37.0, now);
        let mid = now + Duration::from_millis(16);
        let at = slide.value(mid);
        slide.aim(0.0, mid);
        assert!((slide.value(mid) - at).abs() < 1e-3);
    }

    #[test]
    fn the_first_aim_reads_the_rows_where_they_rest() {
        let frames = vec![frame("a", 0.0, false), frame("c", 74.0, false)];
        let source = frame("b", 37.0, false);
        assert_eq!(
            aim_rows(&frames, Some(&source), None, 60.0, m()),
            DropSpot::BeforeRow(TabId::from("c"))
        );
    }

    #[test]
    fn picking_up_a_row_opens_the_gap_where_it_was() {
        let frames = vec![frame("a", 0.0, false), frame("c", 74.0, false)];
        let source = frame("b", 37.0, false);
        let spot = aim_rows(&frames, Some(&source), None, 50.0, m());
        assert_eq!(spot, DropSpot::BeforeRow(TabId::from("c")));
        let gap = Some(&spot);
        assert_eq!(
            shown_top(&frames[1], &frames, Some(&source), gap, m()),
            74.0
        );
    }

    #[test]
    fn the_gap_only_moves_once_the_pointer_passes_the_shifted_centre() {
        let frames = vec![
            frame("a", 0.0, false),
            frame("b", 37.0, false),
            frame("c", 74.0, false),
        ];
        let gap = DropSpot::BeforeRow(TabId::from("b"));
        assert_eq!(
            aim_rows(&frames, None, Some(&gap), 60.0, m()),
            DropSpot::BeforeRow(TabId::from("b"))
        );
        assert_eq!(
            aim_rows(&frames, None, Some(&gap), 92.0, m()),
            DropSpot::BeforeRow(TabId::from("c"))
        );
        assert_eq!(
            aim_rows(&frames, None, Some(&gap), 200.0, m()),
            DropSpot::RowsEnd
        );
    }

    #[test]
    fn a_lane_change_splits_the_space_between_the_last_pinned_row_and_the_list() {
        let frames = vec![frame("p", 0.0, true), frame("l", 60.0, false)];
        assert_eq!(
            aim_rows(&frames, None, None, 40.0, m()),
            DropSpot::AfterRow(TabId::from("p"))
        );
        assert_eq!(
            aim_rows(&frames, None, None, 55.0, m()),
            DropSpot::BeforeRow(TabId::from("l"))
        );
    }

    #[test]
    fn split_bands_follow_the_shown_rows_and_skip_pinned_targets() {
        let frames = vec![frame("p", 0.0, true), frame("a", 37.0, false)];
        let pointer = |x: f32, y: f32| point(x, y);
        assert!(split_hit(&frames, None, None, pointer(50.0, 17.0), m()).is_none());
        assert_eq!(
            split_hit(&frames, None, None, pointer(50.0, 54.0), m()),
            Some((TabId::from("a"), SplitHalf::Left))
        );
        let gap = DropSpot::BeforeRow(TabId::from("a"));
        assert!(split_hit(&frames, None, Some(&gap), pointer(50.0, 54.0), m()).is_none());
        assert_eq!(
            split_hit(&frames, None, Some(&gap), pointer(180.0, 91.0), m()),
            Some((TabId::from("a"), SplitHalf::Right))
        );
    }

    #[test]
    fn moving_the_gap_closes_the_old_one_from_where_it_was() {
        let now = Instant::now();
        let mut room = Room::default();
        room.start(RoomKey::Source, 37.0);
        let first = room_targets(Some(&DropSpot::BeforeRow(TabId::from("c"))), true, m());
        assert!(room.aim(&first, now));
        let later = now + Duration::from_millis(16);
        let opened = room.value(&RoomKey::Above(TabId::from("c")), later);
        let closed = room.value(&RoomKey::Source, later);
        assert!((opened + closed - 37.0).abs() < 1e-3);
        let next = room_targets(Some(&DropSpot::BeforeRow(TabId::from("d"))), true, m());
        assert!(room.aim(&next, later));
        assert!((room.value(&RoomKey::Above(TabId::from("c")), later) - opened).abs() < 1e-3);
        let done = later + Duration::from_millis(200);
        assert_eq!(room.value(&RoomKey::Above(TabId::from("c")), done), 0.0);
        assert_eq!(room.value(&RoomKey::Above(TabId::from("d")), done), 37.0);
        assert!(!room.moving(done));
    }

    #[test]
    fn the_list_scrolls_faster_the_deeper_the_pointer_sits_in_its_edge() {
        assert_eq!(edge_scroll_speed(100.0, 0.0, 400.0, 28.0), 0.0);
        assert_eq!(edge_scroll_speed(27.0, 0.0, 400.0, 28.0), -1.0);
        assert_eq!(edge_scroll_speed(0.0, 0.0, 400.0, 28.0), -7.0);
        assert_eq!(edge_scroll_speed(399.0, 0.0, 400.0, 28.0), 7.0);
    }

    #[test]
    fn the_landing_slot_is_the_open_gap() {
        let frames = vec![frame("a", 0.0, false), frame("c", 74.0, false)];
        let source = frame("b", 37.0, false);
        let gap = DropSpot::BeforeRow(TabId::from("c"));
        assert_eq!(
            slot_of(&frames, Some(&source), Some(&gap), m()),
            Some(point(9.0, 37.0))
        );
    }

    #[test]
    fn the_waiting_split_row_keeps_an_adjacent_gap() {
        let frames = vec![frame("a", 0.0, false), frame("b", 37.0, false)];
        let before_b = DropSpot::BeforeRow(TabId::from("b"));
        assert!(gap_beside(&frames, Some(&before_b), &TabId::from("a")));
        assert!(gap_beside(&frames, Some(&before_b), &TabId::from("b")));
        assert!(!gap_beside(
            &frames,
            Some(&DropSpot::RowsEnd),
            &TabId::from("a")
        ));
    }
}
