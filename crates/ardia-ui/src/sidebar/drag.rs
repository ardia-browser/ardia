use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::model::{Orientation, TabPin};
use ardia_state::tabs::Tab;
use ardia_state::{Action, GroupId, TabId};
use ardia_theme::RgbaColor;
use ardia_theme::color::{from_oklab, oklab};
use ardia_theme::layout::sidebar;
use gpui::{
    AnchoredPositionMode, AnimationExt, AnyElement, App, Bounds, Context, DragMoveEvent,
    FontWeight, Hsla, IntoElement, ParentElement, Pixels, Point, Render, Styled, Window, anchored,
    deferred, div, point, prelude::*,
};

use crate::look::Palette;
use crate::msg::{Emit, Msg};
use crate::primitives::controls::shadow;
use crate::primitives::fade_label::fade_label;
use crate::primitives::favicon::{Favicon, render_favicon};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::sidebar::drag_motion::{
    self, Lane, Metrics, Preview, Room, RoomKey, RowFrame, aim_preview, aim_rows, gap_beside,
    room_targets, split_hit,
};
use crate::sidebar::row_look::{self, SidebarTokens};
use crate::window::chrome::{Chrome, TabDrag};

pub const PIN_ZONE_HYSTERESIS: f32 = 6.0;
pub const PIN_ZONE_SLOP: f32 = 6.0;
pub const SPLIT_HOLD_MS: u64 = 250;
pub const SPLIT_REST_SLOP: f32 = 4.0;
pub const SPLIT_GAP: f32 = 14.0;
pub const EDGE_BAND: f32 = 16.0;
pub const EDGE_HOLD_MS: u64 = 550;
pub const EDGE_GLOW_WIDTH: f32 = 36.0;
pub const GHOST_OPACITY: f32 = 0.96;
pub const GHOST_STEP_DEEPER: f64 = 0.07;
pub const GHOST_STEP_LIGHTER: f64 = 0.015;
pub const TILE_GHOST_POINTER: f32 = 0.37;
pub const GHOST_CLIP_ROOM: f32 = 24.0;
pub const DRAG_GHOST_SHADOW: (f32, f32, f32, f32) = (0.45, 0.18, 10.0, 4.0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitHalf {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Left,
    Right,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DropSpot {
    BeforeRow(TabId),
    AfterRow(TabId),
    RowsEnd,
    Tile(usize),
    Folder(TabId, usize),
    Split(TabId, SplitHalf),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DragKind {
    Row,
    Tile,
    Group,
}

#[derive(Clone, Debug)]
struct SplitRest {
    target: TabId,
    at: Point<Pixels>,
    since: Instant,
    armed: bool,
}

#[derive(Clone, Debug, Default)]
pub struct DragState {
    pub dragging: Option<TabId>,
    pub kind: Option<DragKind>,
    pub spot: Option<DropSpot>,
    pub over_tiles: bool,
    pub edge: Option<Edge>,
    edge_since: Option<Instant>,
    edge_spent: bool,
    rest: Option<SplitRest>,
    pub order: Rc<Vec<TabId>>,
    pub external_at: Option<Instant>,
    pub pointer: Option<Point<Pixels>>,
    pub press: Option<Point<Pixels>>,
    pub grab: Point<Pixels>,
    pub lifted: bool,
    pub frames: Rc<Vec<RowFrame>>,
    pub source: Option<RowFrame>,
    pub gap: Option<DropSpot>,
    pub room: Room,
    pub preview: Option<Preview>,
    pub tiles: Option<Bounds<Pixels>>,
    pub pin_zone: bool,
    pub tile_target: Option<f32>,
    pub pin_gap: Option<drag_motion::Slide>,
    pub sidebar_px: Option<(f32, f32)>,
    pub lanes: Option<LaneTables>,
    pub scroll: Option<gpui::ScrollHandle>,
    pub scroll_base: f32,
    pub scrolling: bool,
    pub ghost: Option<Rc<Ghost>>,
    pub on_page: bool,
    pub page_target: bool,
    pub into: Option<ardia_state::GroupId>,
    pub hold: Option<FolderHold>,
    pub group: Option<ardia_state::GroupId>,
    pub group_members: Rc<HashSet<TabId>>,
    pub group_height: f32,
    pub folder: Option<(String, Rc<Vec<TabId>>)>,
}

pub fn begin_folder(window: &str, folder: &str, members: Vec<TabId>) {
    with_drag(window, |s| {
        s.folder = Some((folder.to_owned(), Rc::new(members)))
    });
}

pub fn dragged_folder(window: &str) -> Option<String> {
    with_drag(window, |s| {
        s.dragging.as_ref()?;
        s.folder.as_ref().map(|(id, _)| id.clone())
    })
}

pub fn begin_group(
    window: &str,
    group: &ardia_state::GroupId,
    members: HashSet<TabId>,
    height: f32,
) {
    with_drag(window, |s| {
        s.group = Some(group.clone());
        s.group_members = Rc::new(members);
        s.group_height = height;
    });
}

pub fn dragged_group(window: &str) -> Option<ardia_state::GroupId> {
    with_drag(window, |s| {
        s.dragging.as_ref()?;
        s.group.clone()
    })
}

pub const FOLDER_HOLD_MS: u64 = 400;
pub const FOLDER_REACH: f32 = 0.3;
pub const FOLDER_REACH_HELD: f32 = 0.45;

#[derive(Clone, Debug, PartialEq)]
pub struct FolderHold {
    pub head: TabId,
    pub since: Instant,
    pub ready: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TilePart {
    Gap,
    Centre,
    Before,
    After,
}

#[allow(clippy::too_many_arguments)]
pub fn tile_part(
    grid: Bounds<Pixels>,
    slot: usize,
    gap: Option<usize>,
    columns: usize,
    width: f32,
    pointer: Point<Pixels>,
    folders: bool,
    held: bool,
) -> (Option<usize>, TilePart) {
    let Some(gap) = gap.filter(|g| *g != slot) else {
        return (None, TilePart::Gap);
    };
    let index = if slot < gap { slot } else { slot - 1 };
    let columns = columns.max(1);
    let scale = f32::from(px(1.0));
    let tile_gap = sidebar::PINNED_TILE_GAP;
    let height = sidebar::pinned_tile_height();
    let x = (f32::from(pointer.x) - f32::from(grid.origin.x)) / scale;
    let y = (f32::from(pointer.y) - f32::from(grid.origin.y)) / scale;
    let mid = (slot % columns) as f32 * (width + tile_gap) + width / 2.0;
    let top = (slot / columns) as f32 * (height + tile_gap);
    let reach = if held {
        FOLDER_REACH_HELD
    } else {
        FOLDER_REACH
    };
    let centre = folders
        && (x - mid).abs() < width * reach
        && (y - (top + height / 2.0)).abs() <= (height + tile_gap) / 2.0;
    let part = if centre {
        TilePart::Centre
    } else if x < mid {
        TilePart::Before
    } else {
        TilePart::After
    };
    (Some(index), part)
}

pub const EXTERNAL_HOLD_MS: u64 = 400;

impl DragState {
    pub fn preview_moving(&self, now: Instant) -> bool {
        self.preview
            .as_ref()
            .is_some_and(|p| p.shown.moving(now) || p.to_left.moving(now))
    }

    pub fn live(&self) -> bool {
        self.dragging.is_some()
            || self
                .external_at
                .is_some_and(|at| at.elapsed() < Duration::from_millis(EXTERNAL_HOLD_MS))
    }
}

pub fn external_moved(
    window: &str,
    bounds: Bounds<Pixels>,
    pointer: Point<Pixels>,
    target: Option<&TabId>,
    win: &mut Window,
) {
    if !bounds.contains(&pointer) {
        return;
    }
    let changed = with_drag(window, |s| {
        let gap_above = target.is_some_and(|t| s.spot == Some(DropSpot::BeforeRow(t.clone())));
        let spot = match target {
            Some(tab) => row_spot(bounds, gap_above, pointer, tab),
            None => DropSpot::RowsEnd,
        };
        let changed = s.spot.as_ref() != Some(&spot) || !s.live();
        s.spot = Some(spot);
        s.over_tiles = false;
        s.external_at = Some(Instant::now());
        changed
    });
    if changed {
        win.refresh();
    }
}

pub fn external_live(c: &Chrome) -> bool {
    with_drag(c.window.id.as_str(), |s| s.dragging.is_none() && s.live())
}

pub fn external_index(window: &str, tab_ids: &[TabId]) -> Option<usize> {
    let spot = with_drag(window, |s| {
        let spot = s.spot.clone().filter(|_| s.live());
        if s.dragging.is_none() {
            s.spot = None;
            s.external_at = None;
        }
        spot
    });
    match spot? {
        DropSpot::BeforeRow(t) => tab_ids.iter().position(|id| *id == t),
        DropSpot::AfterRow(t) => tab_ids.iter().position(|id| *id == t).map(|i| i + 1),
        _ => None,
    }
}

thread_local! {
    static DRAGS: RefCell<HashMap<String, DragState>> = RefCell::new(HashMap::new());
}

pub fn with_drag<R>(window: &str, f: impl FnOnce(&mut DragState) -> R) -> R {
    DRAGS.with(|drags| f(drags.borrow_mut().entry(window.to_owned()).or_default()))
}

pub fn snapshot(c: &Chrome) -> DragState {
    with_drag(c.window.id.as_str(), |s| s.clone())
}

pub fn active(c: &Chrome) -> bool {
    with_drag(c.window.id.as_str(), |s| s.dragging.is_some())
}

pub fn is_dragged(c: &Chrome, tab: &TabId) -> bool {
    with_drag(c.window.id.as_str(), |s| {
        s.lifted && s.dragging.as_ref() == Some(tab)
    })
}

pub fn live_drag(window: &str) -> Option<TabId> {
    with_drag(window, |s| s.dragging.clone())
}

pub fn note_page(window: &str, on_page: bool, target: bool) -> bool {
    with_drag(window, |s| {
        let target = on_page && target;
        let changed = s.dragging.is_some() && (s.on_page != on_page || s.page_target != target);
        if s.dragging.is_some() {
            s.on_page = on_page;
            s.page_target = target;
        }
        changed
    })
}

pub fn into_group_band(top: f32, height: f32, y: f32) -> bool {
    (y - (top + height / 2.0)).abs() < height / 3.0
}

pub fn snapshot_into(window: &str) -> Option<ardia_state::GroupId> {
    with_drag(window, |s| s.into.clone())
}

pub fn note_into(window: &str, group: Option<ardia_state::GroupId>) -> bool {
    let changed = with_drag(window, |s| {
        if s.dragging.is_none() || s.into == group {
            return false;
        }
        s.into = group;
        true
    });
    if changed {
        note_drop_aim(window);
    }
    changed
}

pub fn end(window: &str) {
    with_drag(window, |s| *s = DragState::default());
    crate::primitives::haptics::forget_aim(&format!("sidebar:{window}"));
}

thread_local! {
    static PRESSES: RefCell<HashMap<String, Point<Pixels>>> = RefCell::new(HashMap::new());
}

pub fn note_press(window: &str, at: Point<Pixels>) {
    PRESSES.with(|p| p.borrow_mut().insert(window.to_owned(), at));
}

pub fn begin(
    window: &str,
    tab: &TabId,
    kind: DragKind,
    drops: &DropContext,
    grab: Point<Pixels>,
    ghost: &Ghost,
) {
    DROP_TABLES.with(|cell| *cell.borrow_mut() = None);
    drag_motion::clear_settle(window);
    let press = PRESSES.with(|p| p.borrow_mut().remove(window));
    crate::press_telemetry::note_drag_began();
    with_drag(window, |s| {
        *s = DragState {
            dragging: Some(tab.clone()),
            kind: Some(kind),
            order: drops.order.clone(),
            press,
            grab,
            lanes: Some((drops.pins.clone(), drops.groups.clone())),
            scroll: Some(crate::sidebar::scroll_edge::handle(&format!(
                "{window}:{}",
                drops.profile
            ))),
            ghost: Some(Rc::new(ghost.clone())),
            ..DragState::default()
        };
    });
}

type LaneTables = (
    Rc<HashMap<TabId, Option<TabPin>>>,
    Rc<HashMap<TabId, GroupId>>,
);

pub fn row_snapshot(
    rows: Vec<(TabId, f32, f32, f32)>,
    tab: &TabId,
    lanes: &LaneTables,
) -> (Vec<RowFrame>, Option<RowFrame>) {
    let (pins, groups) = lanes;
    let mut all: Vec<RowFrame> = rows
        .into_iter()
        .filter(|(id, ..)| {
            pins.contains_key(id) && !matches!(pins.get(id), Some(Some(pin)) if pin.is_tile())
        })
        .map(|(id, top, left, width)| RowFrame {
            lane: Lane {
                pinned: matches!(pins.get(&id), Some(Some(TabPin::Row))),
                group: groups.get(&id).cloned(),
            },
            splits: matches!(pins.get(&id), Some(None)),
            tab: id,
            top,
            left,
            width,
        })
        .collect();
    all.sort_by(|a, b| a.top.total_cmp(&b.top));
    let source = all
        .iter()
        .position(|f| &f.tab == tab)
        .map(|i| all.remove(i));
    (all, source)
}

fn lift(window: &str, s: &mut DragState) {
    s.lifted = true;
    let (Some(tab), Some(lanes)) = (s.dragging.clone(), s.lanes.clone()) else {
        return;
    };
    let members = s.group_members.clone();
    let placed = crate::sidebar::list_motion::row_frames(window);
    let block_top = s.group.as_ref().and_then(|g| {
        let key = TabId::from(format!("~group:{}", g.as_str()).as_str());
        placed
            .iter()
            .find(|(id, ..)| *id == key)
            .map(|(_, top, ..)| *top)
    });
    let height = s.group_height;
    let rows: Vec<_> = placed
        .into_iter()
        .filter(|(id, ..)| !members.contains(id))
        .map(|(id, top, left, width)| match block_top {
            Some(block) if top > block => (id, top - height, left, width),
            _ => (id, top, left, width),
        })
        .collect();
    let (frames, source) = row_snapshot(rows, &tab, &lanes);
    if source.is_some() && s.kind == Some(DragKind::Row) {
        s.room.start(RoomKey::Source, Metrics::now().pitch);
    }
    if s.kind == Some(DragKind::Group) {
        s.room.start(RoomKey::Source, s.group_height);
    }
    s.frames = Rc::new(frames);
    s.source = source;
    s.scroll_base = s.scroll_shift_now();
}

impl DragState {
    pub fn scroll_shift_now(&self) -> f32 {
        self.scroll
            .as_ref()
            .map_or(0.0, |h| f32::from(h.offset().y))
    }

    pub fn scrolled(&self) -> f32 {
        self.scroll_shift_now() - self.scroll_base
    }

    fn edge_speed(&self, pointer: Point<Pixels>) -> f32 {
        let Some(handle) = self.scroll.as_ref() else {
            return 0.0;
        };
        let view = handle.bounds();
        if view.size.height <= gpui::px(0.) || !view.contains(&pointer) {
            return 0.0;
        }
        drag_motion::edge_scroll_speed(
            f32::from(pointer.y),
            f32::from(view.origin.y),
            f32::from(view.size.height),
            f32::from(crate::scale::px(drag_motion::SCROLL_EDGE)),
        )
    }
}

fn auto_scroll(window: &str, win: &mut Window, cx: &mut App) {
    let start = with_drag(window, |s| {
        let go = s.lifted && !s.scrolling && s.pointer.is_some_and(|p| s.edge_speed(p) != 0.0);
        if go {
            s.scrolling = true;
        }
        go
    });
    if !start {
        return;
    }
    let key = window.to_owned();
    win.spawn(cx, async move |cx| {
        loop {
            cx.background_executor()
                .timer(Duration::from_millis(16))
                .await;
            let more = cx
                .update(|window, cx| {
                    let moved = with_drag(&key, |s| {
                        let speed = match (s.dragging.as_ref(), s.pointer) {
                            (Some(_), Some(p)) => s.edge_speed(p),
                            _ => 0.0,
                        };
                        let Some(handle) = s.scroll.clone().filter(|_| speed != 0.0) else {
                            s.scrolling = false;
                            return None;
                        };
                        let offset = handle.offset();
                        let floor = -f32::from(handle.max_offset().y);
                        let next = (f32::from(offset.y) - speed).clamp(floor.min(0.0), 0.0);
                        if (next - f32::from(offset.y)).abs() < f32::EPSILON {
                            s.scrolling = false;
                            return None;
                        }
                        handle.set_offset(point(offset.x, gpui::px(next)));
                        Some(())
                    });
                    if moved.is_some() {
                        retarget(&key, window, cx);
                        window.refresh();
                    }
                    moved.is_some()
                })
                .unwrap_or(false);
            if !more {
                break;
            }
        }
    })
    .detach();
}

pub fn retarget(window: &str, win: &mut Window, cx: &mut App) -> bool {
    let now = Instant::now();
    let m = Metrics::now();
    let mut hold: Option<bool> = None;
    let changed = with_drag(window, |s| {
        let Some(pointer) = s.pointer else {
            return false;
        };
        if s.dragging.is_none() {
            return false;
        }
        if !s.lifted {
            let lifted = s.press.is_none_or(|press| {
                let d = pointer - press;
                f32::from(d.x).hypot(f32::from(d.y))
                    > f32::from(crate::scale::px(drag_motion::LIFT_SLOP))
            });
            if !lifted {
                return false;
            }
            if !crate::primitives::virtual_list::painted_all(window) {
                win.refresh();
                return false;
            }
            lift(window, s);
        }
        let before = (
            s.spot.clone(),
            s.gap.clone(),
            s.preview.as_ref().map(|p| (p.tab.clone(), p.half)),
        );
        let (x, y) = (f32::from(pointer.x), f32::from(pointer.y) - s.scrolled());
        let away = s.sidebar_px.is_some_and(|(left, width)| {
            let slop = f32::from(crate::scale::px(drag_motion::AWAY_SLOP));
            x > left + width + slop || x < left - slop
        });
        let over_tiles = !away
            && s.kind != Some(DragKind::Group)
            && s.tiles.is_some_and(|b| {
                if s.pin_zone {
                    inside_zone(b, pointer)
                } else {
                    pointer.x >= b.origin.x
                        && pointer.x <= b.right()
                        && pointer.y >= b.origin.y
                        && over_pins(y, f32::from(b.bottom()), s.over_tiles)
                }
            });
        let collapse = (s.kind == Some(DragKind::Row) && s.source.is_some())
            || s.kind == Some(DragKind::Group);
        let mut armed: Option<(TabId, SplitHalf)> = None;
        if away || s.into.is_some() {
            s.rest = None;
            s.spot = None;
            s.gap = None;
            s.over_tiles = false;
        } else if over_tiles {
            s.rest = None;
            s.gap = None;
            if s.pin_zone {
                s.spot = Some(DropSpot::Tile(0));
            }
        } else {
            if s.over_tiles {
                s.over_tiles = false;
                if matches!(s.spot, Some(DropSpot::Tile(_) | DropSpot::Folder(..))) {
                    s.spot = None;
                }
            }
            let frames = s.frames.clone();
            let source = s.source.clone();
            let splits = s.kind == Some(DragKind::Row)
                && s.edge.is_none()
                && source.as_ref().is_some_and(|f| f.splits);
            let offered = splits
                .then(|| split_hit(&frames, source.as_ref(), s.gap.as_ref(), point(x, y), m))
                .flatten();
            let mut waiting = None;
            match offered {
                Some((target, half)) => {
                    let (ready, started) = match &s.rest {
                        Some(rest) if rest.target == target => {
                            let d = pointer - rest.at;
                            let still = f32::from(d.x).hypot(f32::from(d.y))
                                <= f32::from(crate::scale::px(SPLIT_REST_SLOP));
                            let ready = rest.armed
                                || (still
                                    && rest.since.elapsed()
                                        >= Duration::from_millis(SPLIT_HOLD_MS));
                            if ready || still {
                                (ready, false)
                            } else {
                                (false, true)
                            }
                        }
                        _ => (false, true),
                    };
                    if started {
                        s.rest = Some(SplitRest {
                            target: target.clone(),
                            at: pointer,
                            since: Instant::now(),
                            armed: false,
                        });
                        hold = Some(true);
                    }
                    if ready {
                        if let Some(rest) = s.rest.as_mut() {
                            rest.armed = true;
                        }
                        armed = Some((target, half));
                    } else {
                        waiting = Some(target);
                    }
                }
                None => s.rest = None,
            }
            if let Some((target, half)) = &armed {
                s.spot = Some(DropSpot::Split(target.clone(), *half));
            } else if !waiting.as_ref().is_some_and(|w| {
                !matches!(s.spot, Some(DropSpot::Split(..)))
                    && gap_beside(&frames, s.gap.as_ref(), w)
            }) {
                let spot = aim_rows(&frames, source.as_ref(), s.gap.as_ref(), y, m);
                s.gap = Some(spot.clone());
                s.spot = Some(spot);
            }
        }
        s.over_tiles = over_tiles;
        let pin_gap_to = if over_tiles && s.pin_zone {
            pin_slot_pitch()
        } else {
            0.0
        };
        let pin_gap_moved = s
            .pin_gap
            .get_or_insert_with(|| drag_motion::Slide::resting(0.0, drag_motion::ROOM_OMEGA))
            .aim(pin_gap_to, now);
        aim_preview(&mut s.preview, armed.as_ref().map(|(t, h)| (t, *h)), now);
        let targets = room_targets(s.gap.as_ref(), collapse, m);
        let moved = s.room.aim(&targets, now);
        let after = (
            s.spot.clone(),
            s.gap.clone(),
            s.preview.as_ref().map(|p| (p.tab.clone(), p.half)),
        );
        moved || pin_gap_moved || before != after
    });
    note_drop_aim(window);
    if hold == Some(true) {
        drag_motion::retarget_later(window, Duration::from_millis(SPLIT_HOLD_MS + 5), win, cx);
    }
    changed
}

pub fn point_moved(window: &str, pointer: Point<Pixels>, win: &mut Window, cx: &mut App) {
    let fresh = with_drag(window, |s| {
        let fresh = s.pointer != Some(pointer);
        s.pointer = Some(pointer);
        fresh
    });
    if fresh && retarget(window, win, cx) {
        win.refresh();
    }
    if fresh {
        auto_scroll(window, win, cx);
    }
}

pub fn row_spot(
    bounds: Bounds<Pixels>,
    gap_above: bool,
    pointer: Point<Pixels>,
    tab: &TabId,
) -> DropSpot {
    let pitch = px(sidebar::row_pitch());
    let top = if gap_above {
        bounds.origin.y + pitch
    } else {
        bounds.origin.y
    };
    let center = top + px(sidebar::row_height()) / 2.0;
    if pointer.y < center {
        DropSpot::BeforeRow(tab.clone())
    } else {
        DropSpot::AfterRow(tab.clone())
    }
}

pub fn in_split_band(row_top: Pixels, pointer: Point<Pixels>) -> bool {
    let height = px(sidebar::row_height());
    pointer.y > row_top + height * 0.25 && pointer.y < row_top + height * 0.75
}

pub fn inside_zone(zone: Bounds<Pixels>, pointer: Point<Pixels>) -> bool {
    let slop = crate::scale::px(PIN_ZONE_SLOP);
    pointer.x >= zone.origin.x - slop
        && pointer.x <= zone.right() + slop
        && pointer.y >= zone.origin.y - slop
        && pointer.y <= zone.bottom() + slop
}

pub fn over_pins(y: f32, list_top: f32, was_over: bool) -> bool {
    y < list_top
        + if was_over {
            PIN_ZONE_HYSTERESIS
        } else {
            -PIN_ZONE_HYSTERESIS
        }
}

pub fn edge_at(sidebar_x: f32, sidebar_w: f32, x: f32) -> Option<Edge> {
    if sidebar_w < EDGE_BAND * 3.0 {
        return None;
    }
    if x >= sidebar_x && x < sidebar_x + EDGE_BAND {
        Some(Edge::Left)
    } else if x <= sidebar_x + sidebar_w && x > sidebar_x + sidebar_w - EDGE_BAND {
        Some(Edge::Right)
    } else {
        None
    }
}

fn note_drop_aim(window: &str) {
    let aim = with_drag(window, |s| {
        s.lifted.then(|| match (&s.spot, &s.into) {
            (_, Some(group)) => Some(format!("into:{group:?}")),
            (Some(spot), None) => Some(format!("{spot:?}")),
            (None, None) => None,
        })
    });
    if let Some(aim) = aim {
        crate::primitives::haptics::note_aim(&format!("sidebar:{window}"), aim);
    }
}

fn set_spot(window: &str, spot: Option<DropSpot>, over_tiles: bool, win: &mut Window) {
    let changed = with_drag(window, |s| {
        let changed = s.spot != spot || s.over_tiles != over_tiles;
        s.spot = spot;
        s.over_tiles = over_tiles;
        changed
    });
    note_drop_aim(window);
    if changed {
        win.refresh();
    }
}

fn aim_edge(
    c_window: &str,
    emit: &Emit,
    sidebar: Option<(f32, f32)>,
    pointer: Point<Pixels>,
    win: &mut Window,
    cx: &mut App,
) {
    let Some((x, w)) = sidebar else {
        return;
    };
    let scale = crate::scale::current();
    let edge = edge_at(x * scale, w * scale, f32::from(pointer.x));
    let start = with_drag(c_window, |s| {
        if edge.is_none() {
            s.edge_spent = false;
        }
        let edge = edge.filter(|_| !s.edge_spent);
        if s.edge == edge {
            return None;
        }
        s.edge = edge;
        s.edge_since = edge.map(|_| Instant::now());
        Some(edge)
    });
    let Some(edge) = start else {
        return;
    };
    win.refresh();
    let Some(edge) = edge else {
        return;
    };
    let key = c_window.to_owned();
    let emit = emit.clone();
    win.spawn(cx, async move |cx| {
        cx.background_executor()
            .timer(Duration::from_millis(EDGE_HOLD_MS))
            .await;
        let _ = cx.update(|window, cx| {
            let fire = with_drag(&key, |s| {
                let held = s.edge == Some(edge)
                    && s.edge_since
                        .is_some_and(|t| t.elapsed() >= Duration::from_millis(EDGE_HOLD_MS));
                if held {
                    s.edge = None;
                    s.edge_since = None;
                    s.edge_spent = true;
                }
                held
            });
            if fire {
                emit.send(
                    Msg::command(match edge {
                        Edge::Left => "previousProfile",
                        Edge::Right => "nextProfile",
                    }),
                    window,
                    cx,
                );
                window.refresh();
            }
        });
    })
    .detach();
}

#[derive(Clone)]
pub struct RowTarget {
    pub window: String,
    pub emit: Emit,
    pub tab: TabId,
    pub sidebar: Option<(f32, f32)>,
    pub splits: bool,
}

impl RowTarget {
    pub fn new(c: &Chrome, tab: &Tab) -> Self {
        RowTarget {
            window: c.window.id.as_str().to_owned(),
            emit: c.emit.clone(),
            tab: tab.id.clone(),
            sidebar: c.layout.sidebar.map(|r| (r.x, r.w)),
            splits: tab.pin.is_none() && c.state.split_of(tab.id.as_str()).is_none(),
        }
    }

    pub fn moved(&self, event: &DragMoveEvent<TabDrag>, win: &mut Window, cx: &mut App) {
        let pointer = event.event.position;
        aim_edge(&self.window, &self.emit, self.sidebar, pointer, win, cx);
        note_sidebar(&self.window, self.sidebar);
        point_moved(&self.window, pointer, win, cx);
    }
}

pub fn note_sidebar(window: &str, sidebar: Option<(f32, f32)>) {
    let Some((x, w)) = sidebar else {
        return;
    };
    let scale = crate::scale::current();
    with_drag(window, |s| s.sidebar_px = Some((x * scale, w * scale)));
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Incoming {
    Before(TabId),
    End,
}

pub fn incoming_before(rows: &[(TabId, f32)], y: f32, row_height: f32) -> Incoming {
    rows.iter()
        .find(|(_, top)| top + row_height / 2.0 > y)
        .map_or(Incoming::End, |(id, _)| Incoming::Before(id.clone()))
}

pub fn incoming(c: &Chrome) -> Option<Incoming> {
    let (_, y) = crate::sidebar::strip_drag::incoming(&c.window.id)?;
    let drops = DropContext::new(c);
    let window = c.window.id.as_str();
    let rows: Vec<(TabId, f32)> = drops
        .order
        .iter()
        .filter(|id| !matches!(drops.pins.get(*id), Some(Some(pin)) if pin.is_tile()))
        .filter_map(|id| {
            crate::sidebar::list_motion::row_top(window, id)
                .map(|top| (id.clone(), crate::scale::points(Pixels::from(top))))
        })
        .collect();
    let spot = incoming_before(&rows, y, sidebar::row_height());
    let index = match &spot {
        Incoming::Before(id) => c.window.tab_ids.iter().position(|t| t == id),
        Incoming::End => None,
    };
    crate::sidebar::strip_drag::set_insert(&c.window.id, index);
    Some(spot)
}

pub fn note_window_bounds(c: &Chrome) -> AnyElement {
    let window = c.window.id.clone();
    gpui::canvas(
        move |_, w, _| {
            let b = w.bounds();
            crate::sidebar::strip_drag::note_bounds(
                &window,
                crate::sidebar::strip_drag::ScreenRect {
                    x: crate::scale::points(b.origin.x),
                    y: crate::scale::points(b.origin.y),
                    w: crate::scale::points(b.size.width),
                    h: crate::scale::points(b.size.height),
                },
            );
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_0()
    .into_any_element()
}

pub fn note_cross_move(
    window: &ardia_state::WindowId,
    event: &DragMoveEvent<TabDrag>,
    win: &mut Window,
    cx: &mut App,
) {
    let b = win.bounds();
    let at = (
        crate::scale::points(b.origin.x + event.event.position.x),
        crate::scale::points(b.origin.y + event.event.position.y),
    );
    let tab = event.drag(cx).tab.clone();
    if crate::sidebar::strip_drag::moved(window, &tab, at) {
        cx.refresh_windows();
    }
}

pub fn land_cross(window: &ardia_state::WindowId, emit: &Emit, win: &mut Window, cx: &mut App) {
    if let Some(landing) = crate::sidebar::strip_drag::finish(window) {
        end(window.as_str());
        emit.send(
            Msg::Stores(vec![
                Action::MoveTab {
                    tab: landing.tab.clone(),
                    window: landing.window,
                    index: landing.index.unwrap_or(usize::MAX),
                },
                Action::ActivateTab { tab: landing.tab },
            ]),
            win,
            cx,
        );
        cx.refresh_windows();
    }
}

pub const MAX_DROPPED_TABS: usize = 50;

pub fn dropped_file_urls(paths: &[std::path::PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|p| crate::window::page_overlays::file_url(p))
        .take(MAX_DROPPED_TABS)
        .collect()
}

fn is_web_drop(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    rest.and_then(|r| r.chars().next())
        .is_some_and(|c| c != '/' && !c.is_whitespace())
}

pub fn dropped_item_urls(items: &gpui::ExternalItems) -> Vec<String> {
    let files = dropped_file_urls(items.paths());
    let links = items
        .urls()
        .iter()
        .map(|url| url.trim().to_owned())
        .filter(|url| is_web_drop(url));
    let text = items.text().map(str::trim).and_then(|raw| {
        if raw.chars().any(char::is_whitespace) {
            None
        } else {
            ardia_state::omnibox::url::fixup_url(raw).filter(|url| is_web_drop(url))
        }
    });
    files
        .into_iter()
        .chain(links)
        .chain(text)
        .take(MAX_DROPPED_TABS)
        .collect()
}

pub fn items_drop(
    window: &ardia_state::WindowId,
    index: Option<usize>,
    items: &gpui::ExternalItems,
) -> Option<Msg> {
    urls_drop(window, index, dropped_item_urls(items))
}

fn urls_drop(
    window: &ardia_state::WindowId,
    index: Option<usize>,
    urls: Vec<String>,
) -> Option<Msg> {
    if urls.is_empty() {
        return None;
    }
    Some(Msg::Stores(
        urls.into_iter()
            .enumerate()
            .map(|(i, url)| Action::NewTab {
                window: window.clone(),
                tab: ardia_state::NewTab {
                    url: Some(url),
                    background: i > 0,
                    index: index.map(|at| at + i),
                    ..ardia_state::NewTab::default()
                },
            })
            .collect(),
    ))
}

pub fn file_drop(
    window: &ardia_state::WindowId,
    index: Option<usize>,
    paths: &gpui::ExternalPaths,
) -> Option<Msg> {
    urls_drop(window, index, dropped_file_urls(paths.paths()))
}

pub fn row_gaps(c: &Chrome, tab: &TabId) -> (bool, bool) {
    if let Some(Incoming::Before(id)) = incoming(c) {
        return (&id == tab, false);
    }
    with_drag(c.window.id.as_str(), |s| match &s.spot {
        _ if !s.live() => (false, false),
        Some(DropSpot::BeforeRow(t)) => (t == tab, false),
        Some(DropSpot::AfterRow(t)) => (false, t == tab),
        _ => (false, false),
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreviewLook {
    pub half: SplitHalf,
    pub shown: f32,
    pub to_left: f32,
    pub width: Option<f32>,
    pub moving: bool,
}

pub fn split_half(c: &Chrome, tab: &TabId) -> Option<PreviewLook> {
    let now = Instant::now();
    with_drag(c.window.id.as_str(), |s| {
        let p = s.preview.as_ref().filter(|p| &p.tab == tab)?;
        let shown = p.shown.value(now);
        let moving = p.shown.moving(now) || p.to_left.moving(now);
        (shown > 0.0 || moving).then(|| PreviewLook {
            half: p.half,
            shown,
            to_left: p.to_left.value(now),
            width: s.frames.iter().find(|f| &f.tab == tab).map(|f| f.width),
            moving,
        })
    })
}

pub fn gap_of(height: f32) -> AnyElement {
    div().flex_none().h(Pixels::from(height)).into_any_element()
}

pub fn split_halves(half: SplitHalf, fill: Hsla) -> AnyElement {
    let radius = row_look::chrome_radius();
    div()
        .absolute()
        .inset_0()
        .flex()
        .gap(px(SPLIT_GAP))
        .child(
            div()
                .flex_1()
                .rounded(px(radius))
                .when(half == SplitHalf::Left, |d| d.bg(fill)),
        )
        .child(
            div()
                .flex_1()
                .rounded(px(radius))
                .when(half == SplitHalf::Right, |d| d.bg(fill)),
        )
        .into_any_element()
}

#[derive(Clone)]
pub struct DropContext {
    pub window: String,
    pub emit: Emit,
    pub pins: Rc<HashMap<TabId, Option<TabPin>>>,
    pub groups: Rc<HashMap<TabId, GroupId>>,
    pub tiles: Rc<Vec<TabId>>,
    pub order: Rc<Vec<TabId>>,
    pub profile: ardia_state::ProfileId,
}

type TablesKey = (usize, usize, usize, String);

type DropTables = (
    Rc<HashMap<TabId, Option<TabPin>>>,
    Rc<HashMap<TabId, GroupId>>,
    Rc<Vec<TabId>>,
    Rc<Vec<TabId>>,
);

thread_local! {
    static DROP_TABLES: RefCell<Option<(TablesKey, DropTables)>> = const { RefCell::new(None) };
}

impl DropContext {
    pub fn first_row(&self) -> Option<&TabId> {
        self.order
            .iter()
            .find(|id| !matches!(self.pins.get(*id), Some(Some(pin)) if pin.is_tile()))
    }

    pub fn new(c: &Chrome) -> Self {
        let key: TablesKey = (
            Arc::as_ptr(&c.state.tabs) as usize,
            Arc::as_ptr(&c.state.groups) as usize,
            Arc::as_ptr(&c.state.windows) as usize,
            c.window.id.as_str().to_owned(),
        );
        let cached = DROP_TABLES.with(|cell| {
            cell.borrow()
                .as_ref()
                .filter(|(cached, _)| *cached == key)
                .map(|(_, tables)| tables.clone())
        });
        let (pins, groups, tiles, order) = match cached {
            Some(tables) => tables,
            None => {
                let tables = Self::tables(c);
                let previous = DROP_TABLES.with(|cell| {
                    cell.borrow()
                        .as_ref()
                        .filter(|(old, _)| old.3 == key.3)
                        .map(|(_, old)| (old.1.clone(), old.3.clone()))
                });
                if let Some((groups_before, before)) = previous {
                    if crate::sidebar::list_motion::order_changed(
                        (before.as_slice(), &*groups_before),
                        (tables.3.as_slice(), &*tables.1),
                    ) {
                        crate::sidebar::list_motion::note_list_change(c.window.id.as_str());
                    }
                    let closed =
                        crate::sidebar::list_motion::closed_rows(&before, &tables.3, |id| {
                            c.state.tab(id.as_str()).is_some()
                        });
                    crate::sidebar::list_motion::note_closes(c.window.id.as_str(), &closed);
                    let opened = crate::sidebar::list_motion::opened_rows(&before, &tables.3);
                    crate::sidebar::list_motion::note_opens(c.window.id.as_str(), &opened);
                }
                drag_motion::note_order(&key.3, &tables.3);
                DROP_TABLES.with(|cell| *cell.borrow_mut() = Some((key, tables.clone())));
                tables
            }
        };
        DropContext {
            window: c.window.id.as_str().to_owned(),
            emit: c.emit.clone(),
            pins,
            groups,
            tiles,
            order,
            profile: c.window.profile_id.clone(),
        }
    }

    fn tables(c: &Chrome) -> DropTables {
        let mut pins = HashMap::new();
        let mut groups = HashMap::new();
        let order = c.sections.ordered_tabs();
        for id in &order {
            if let Some(tab) = c.state.tab(id.as_str()) {
                pins.insert(id.clone(), tab.pin.clone());
            }
            if let Some(group) = c.state.group_of(id.as_str()) {
                groups.insert(id.clone(), group.id.clone());
            }
        }
        (
            Rc::new(pins),
            Rc::new(groups),
            Rc::new(
                crate::sidebar::folders::tile_cells(&c.sections.tiles)
                    .iter()
                    .filter_map(|cell| crate::sidebar::pinned_grid::cell_head(cell).cloned())
                    .collect(),
            ),
            Rc::new(order),
        )
    }

    pub fn drop(&self, drag: &TabDrag, win: &mut Window, cx: &mut App) {
        let state = with_drag(&self.window, |s| s.clone());
        if state.dragging.is_none() {
            return;
        }
        end(&self.window);
        crate::press_telemetry::note_drag_ended(
            self.drop_kind(&drag.tab, &state),
            state.spot.is_some(),
            state.lifted,
        );
        if !state.lifted {
            win.refresh();
            return;
        }
        settle_after(&self.window, &drag.tab, &state, false);
        for msg in self.messages(&drag.tab, &state) {
            self.emit.send(msg, win, cx);
        }
        win.refresh();
    }

    fn drop_kind(
        &self,
        tab: &TabId,
        state: &DragState,
    ) -> Option<crate::press_telemetry::SidebarDrop> {
        use crate::press_telemetry::SidebarDrop;
        let spot = state.spot.as_ref()?;
        if state.group.is_some() || state.folder.is_some() {
            return None;
        }
        Some(match spot {
            DropSpot::Split(_, SplitHalf::Left) => SidebarDrop::SplitLeft,
            DropSpot::Split(_, SplitHalf::Right) => SidebarDrop::SplitRight,
            _ if !self.pins.contains_key(tab) => SidebarDrop::OtherProfile,
            DropSpot::Tile(_) | DropSpot::Folder(..) => SidebarDrop::Tile,
            DropSpot::BeforeRow(_) | DropSpot::AfterRow(_) | DropSpot::RowsEnd => SidebarDrop::Gap,
        })
    }

    pub fn messages(&self, tab: &TabId, state: &DragState) -> Vec<Msg> {
        let Some(spot) = state.spot.clone() else {
            return Vec::new();
        };
        if let Some(group) = state.group.clone() {
            return self.group_messages(group, &spot, &state.group_members);
        }
        if let Some((_, members)) = state.folder.clone() {
            return folder_drop_messages(&self.tiles, &self.order, &spot, &members);
        }
        if !self.pins.contains_key(tab) && !matches!(spot, DropSpot::Split(..)) {
            let before = match &spot {
                DropSpot::BeforeRow(target) => Some(target.clone()),
                DropSpot::AfterRow(target) => next_after(&self.order, target, tab),
                DropSpot::Tile(index) | DropSpot::Folder(_, index) => {
                    self.tiles.get(*index).cloned()
                }
                DropSpot::RowsEnd | DropSpot::Split(..) => None,
            };
            return vec![Msg::Store(Action::MoveTabsToProfile {
                tabs: vec![tab.clone()],
                profile: self.profile.clone(),
                before,
                background: false,
            })];
        }
        let moving_pin = self.pins.get(tab).cloned().flatten();
        match spot {
            DropSpot::Folder(head, _) => vec![Msg::Store(Action::AddToTileFolder {
                tabs: vec![tab.clone()],
                onto: head,
                before: None,
            })],
            DropSpot::Tile(index) => {
                let cells: Vec<&TabId> = self.tiles.iter().filter(|t| *t != tab).collect();
                vec![Msg::DropTab {
                    tab: tab.clone(),
                    before: cells.get(index).map(|t| (*t).clone()),
                    group: None,
                    pin: Some(true),
                }]
            }
            DropSpot::Split(target, half) => {
                let tabs = match half {
                    SplitHalf::Left => vec![tab.clone(), target],
                    SplitHalf::Right => vec![target, tab.clone()],
                };
                vec![Msg::Store(Action::SplitTabs {
                    tabs,
                    orientation: Orientation::Horizontal,
                })]
            }
            DropSpot::RowsEnd => vec![Msg::DropTab {
                tab: tab.clone(),
                before: None,
                group: None,
                pin: Some(false),
            }],
            DropSpot::BeforeRow(target) | DropSpot::AfterRow(target) => {
                let after = matches!(state.spot, Some(DropSpot::AfterRow(_)));
                let before = if after {
                    next_after(&self.order, &target, tab)
                } else {
                    Some(target.clone())
                };
                let target_pin = self.pins.get(&target).cloned().flatten();
                let group = self.groups.get(&target).cloned();
                let mut out = Vec::new();
                let pin = match target_pin {
                    Some(TabPin::Row) => {
                        if moving_pin != Some(TabPin::Row) {
                            out.push(Msg::Store(Action::SetPin {
                                tab: tab.clone(),
                                pin: Some(TabPin::Row),
                            }));
                        }
                        None
                    }
                    _ => Some(false),
                };
                out.push(Msg::DropTab {
                    tab: tab.clone(),
                    before,
                    group,
                    pin,
                });
                out
            }
        }
    }
}

impl DropContext {
    pub fn group_messages(
        &self,
        group: ardia_state::GroupId,
        spot: &DropSpot,
        members: &HashSet<TabId>,
    ) -> Vec<Msg> {
        group_drop_messages(&self.order, &self.pins, &self.groups, group, spot, members)
    }
}

pub fn folder_drop_messages(
    tiles: &[TabId],
    order: &[TabId],
    spot: &DropSpot,
    members: &[TabId],
) -> Vec<Msg> {
    let outside = |id: &&TabId| !members.contains(*id);
    let (before, pin) = match spot {
        DropSpot::Tile(index) => (
            tiles.iter().filter(outside).nth(*index).cloned(),
            Some(true),
        ),
        DropSpot::BeforeRow(target) => (Some(target.clone()), Some(false)),
        DropSpot::AfterRow(target) => (
            order
                .iter()
                .skip_while(|id| *id != target)
                .skip(1)
                .find(outside)
                .cloned(),
            Some(false),
        ),
        DropSpot::RowsEnd => (None, Some(false)),
        _ => return Vec::new(),
    };
    members
        .iter()
        .map(|tab| Msg::DropTab {
            tab: tab.clone(),
            before: before.clone(),
            group: None,
            pin,
        })
        .collect()
}

pub fn group_drop_messages(
    order: &[TabId],
    pins: &HashMap<TabId, Option<TabPin>>,
    groups: &HashMap<TabId, GroupId>,
    group: ardia_state::GroupId,
    spot: &DropSpot,
    members: &HashSet<TabId>,
) -> Vec<Msg> {
    let (before, anchor) = match spot {
        DropSpot::BeforeRow(target) => (Some(target.clone()), Some(target.clone())),
        DropSpot::AfterRow(target) => {
            let after = order
                .iter()
                .skip_while(|id| *id != target)
                .skip(1)
                .find(|id| !members.contains(*id))
                .cloned();
            (after, Some(target.clone()))
        }
        DropSpot::RowsEnd => (None, None),
        _ => return Vec::new(),
    };
    let pinned = anchor
        .as_ref()
        .is_some_and(|t| matches!(pins.get(t), Some(Some(TabPin::Row))));
    let parent = anchor
        .as_ref()
        .and_then(|t| groups.get(t).cloned())
        .filter(|g| *g != group);
    vec![Msg::Store(Action::MoveGroup {
        group,
        before,
        pinned,
        parent,
    })]
}

pub fn settle_after(window: &str, tab: &TabId, state: &DragState, cancel: bool) {
    if !state.lifted {
        return;
    }
    let m = Metrics::now();
    let now = Instant::now();
    let mut room = state.room.clone();
    let rows = !cancel
        && matches!(
            state.spot,
            Some(DropSpot::BeforeRow(_) | DropSpot::AfterRow(_) | DropSpot::RowsEnd)
        );
    let to = if rows {
        drag_motion::slot_of(&state.frames, state.source.as_ref(), state.gap.as_ref(), m)
    } else if cancel {
        let targets = if state.source.is_some() && state.kind == Some(DragKind::Row) {
            vec![(RoomKey::Source, m.pitch)]
        } else if state.kind == Some(DragKind::Group) {
            vec![(RoomKey::Source, state.group_height)]
        } else {
            Vec::new()
        };
        room.aim(&targets, now);
        state.source.as_ref().map(|f| point(f.left, f.top))
    } else {
        None
    };
    let shift = state.scrolled();
    let to = to.map(|at| point(at.x, at.y + shift));
    let landing = match (to, state.pointer, state.ghost.as_ref()) {
        (Some(to), Some(pointer), Some(ghost))
            if state.kind != Some(DragKind::Tile)
                && (state.kind == Some(DragKind::Row) || rows) =>
        {
            Some(drag_motion::Landing {
                ghost: ghost.clone(),
                from: point(
                    f32::from(pointer.x - state.grab.x),
                    f32::from(pointer.y - state.grab.y),
                ),
                to,
                since: now,
            })
        }
        _ => None,
    };
    drag_motion::settle(
        window,
        drag_motion::Settle {
            source: tab.clone(),
            room,
            order: state.order.clone(),
            since: now,
            released: state.kind == Some(DragKind::Tile),
            landing,
            group: state.group.clone(),
        },
    );
}

pub fn next_after(order: &[TabId], target: &TabId, moving: &TabId) -> Option<TabId> {
    let at = order.iter().position(|t| t == target)?;
    order[at + 1..].iter().find(|t| *t != moving).cloned()
}

pub fn tile_slot(
    grid: Bounds<Pixels>,
    total: usize,
    width: f32,
    columns: usize,
    pointer: Point<Pixels>,
) -> usize {
    let gap = px(sidebar::PINNED_TILE_GAP);
    let height = px(sidebar::pinned_tile_height());
    let columns = columns.max(1);
    let rows = total.div_ceil(columns).max(1);
    let y = pointer.y - grid.origin.y + gap / 2.0;
    let x = pointer.x - grid.origin.x + gap / 2.0;
    let row = ((y / (height + gap)).floor().max(0.0) as usize).min(rows - 1);
    let column = ((x / (px(width) + gap)).floor().max(0.0) as usize).min(columns - 1);
    (row * columns + column).min(total.saturating_sub(1))
}

pub struct GridTarget {
    pub window: String,
    pub emit: Emit,
    pub sidebar: Option<(f32, f32)>,
    pub cells: usize,
    pub inner: f32,
    pub balanced: bool,
    pub heads: Rc<Vec<(TabId, bool)>>,
    pub folders: bool,
    pub can_folder: Rc<HashSet<TabId>>,
}

fn index_head(heads: &[(TabId, bool)], gap: Option<usize>, slot: usize) -> Option<TabId> {
    let gap = gap.filter(|g| *g != slot)?;
    let index = if slot < gap { slot } else { slot - 1 };
    heads.get(index).map(|(h, _)| h.clone())
}

impl GridTarget {
    pub fn moved(&self, event: &DragMoveEvent<TabDrag>, win: &mut Window, cx: &mut App) {
        let pointer = event.event.position;
        aim_edge(&self.window, &self.emit, self.sidebar, pointer, win, cx);
        note_sidebar(&self.window, self.sidebar);
        let total = self.cells + 1;
        let (columns, width) =
            crate::sidebar::pinned_grid::pin_grid(total, self.inner, self.balanced);
        with_drag(&self.window, |s| {
            s.tiles = Some(event.bounds);
            s.pin_zone = false;
            s.tile_target = Some(width);
        });
        point_moved(&self.window, pointer, win, cx);
        if !with_drag(&self.window, |s| {
            s.lifted && s.kind != Some(DragKind::Group)
        }) {
            return;
        }
        let was_over = with_drag(&self.window, |s| s.over_tiles);
        let bottom = f32::from(event.bounds.bottom());
        let inside_x = pointer.x >= event.bounds.origin.x && pointer.x <= event.bounds.right();
        let over = inside_x
            && pointer.y >= event.bounds.origin.y
            && over_pins(f32::from(pointer.y), bottom, was_over);
        if !over {
            if was_over {
                with_drag(&self.window, |s| {
                    s.over_tiles = false;
                    s.hold = None;
                    if matches!(s.spot, Some(DropSpot::Tile(_) | DropSpot::Folder(..))) {
                        s.spot = None;
                    }
                });
                win.refresh();
            }
            return;
        }
        let slot = tile_slot(event.bounds, total, width, columns, pointer);
        let dragged = event.drag(cx).tab.clone();
        let folders = self.folders && self.can_folder.contains(&dragged);
        let (gap, held) = with_drag(&self.window, |s| {
            let gap = match (&s.spot, s.over_tiles) {
                (Some(DropSpot::Tile(g) | DropSpot::Folder(_, g)), true) => Some(*g),
                _ => None,
            };
            (
                gap,
                s.hold.as_ref().filter(|h| h.ready).map(|h| h.head.clone()),
            )
        });
        let (index, part) = tile_part(
            event.bounds,
            slot,
            gap,
            columns,
            width,
            pointer,
            folders,
            index_head(&self.heads, gap, slot).is_some_and(|h| held.as_ref() == Some(&h)),
        );
        let spot = match (part, index, gap) {
            (TilePart::Centre, Some(index), Some(gap)) => {
                let Some((head, is_folder)) = self.heads.get(index).cloned() else {
                    return;
                };
                let (fresh, ready) = with_drag(&self.window, |s| {
                    let same = s.hold.as_ref().is_some_and(|h| h.head == head);
                    if !same {
                        s.hold = Some(FolderHold {
                            head: head.clone(),
                            since: Instant::now(),
                            ready: is_folder,
                        });
                    }
                    (!same, s.hold.as_ref().is_some_and(|h| h.ready))
                });
                if fresh && !ready {
                    arm_folder_later(&self.window, head.clone(), win, cx);
                }
                if ready {
                    DropSpot::Folder(head, gap)
                } else {
                    DropSpot::Tile(gap)
                }
            }
            (TilePart::Before, Some(index), _) => {
                with_drag(&self.window, |s| s.hold = None);
                DropSpot::Tile(index)
            }
            (TilePart::After, Some(index), _) => {
                with_drag(&self.window, |s| s.hold = None);
                DropSpot::Tile(index + 1)
            }
            _ => {
                with_drag(&self.window, |s| s.hold = None);
                DropSpot::Tile(gap.unwrap_or(slot))
            }
        };
        set_spot(&self.window, Some(spot), true, win);
    }
}

pub fn tile_gap_index(c: &Chrome) -> Option<usize> {
    with_drag(c.window.id.as_str(), |s| match s.spot {
        Some(DropSpot::Tile(index) | DropSpot::Folder(_, index)) if s.over_tiles => Some(index),
        _ => None,
    })
}

pub fn folder_target(c: &Chrome) -> Option<TabId> {
    with_drag(c.window.id.as_str(), |s| match &s.spot {
        Some(DropSpot::Folder(head, _)) if s.over_tiles => Some(head.clone()),
        _ => None,
    })
}

fn arm_folder_later(window: &str, head: TabId, win: &mut Window, cx: &mut App) {
    let key = window.to_owned();
    win.spawn(cx, async move |cx| {
        cx.background_executor()
            .timer(Duration::from_millis(FOLDER_HOLD_MS))
            .await;
        let _ = cx.update(|window, _| {
            let armed = with_drag(&key, |s| {
                let gap = match s.spot {
                    Some(DropSpot::Tile(g)) => g,
                    _ => return false,
                };
                match s.hold.as_mut() {
                    Some(hold) if hold.head == head && !hold.ready && s.over_tiles => {
                        hold.ready = true;
                        s.spot = Some(DropSpot::Folder(head.clone(), gap));
                        true
                    }
                    _ => false,
                }
            });
            if armed {
                window.refresh();
            }
        });
    })
    .detach();
}

fn tone_step(surface: RgbaColor, accent: RgbaColor, lightness: f64) -> RgbaColor {
    const ACCENT_SHARE: f64 = 0.32;
    const ACCENT_MIN_CHROMA: f64 = 0.02;
    const CHROMA_MAX: f64 = 0.07;
    const CHROMA_PER_LIGHTNESS: f64 = 0.3;
    let rgb = |c: RgbaColor| [f64::from(c.r), f64::from(c.g), f64::from(c.b)];
    let [l, a, b] = oklab(rgb(surface));
    let [_, pa, pb] = oklab(rgb(accent));
    let accent_chroma = pa.hypot(pb);
    let target = (l + lightness).clamp(0.0, 1.0);
    let own = a.hypot(b);
    let tinted = accent_chroma >= ACCENT_MIN_CHROMA;
    let wanted = if tinted {
        CHROMA_MAX
            .min(target * CHROMA_PER_LIGHTNESS)
            .min(own.max(accent_chroma * ACCENT_SHARE))
    } else {
        own
    };
    let (ua, ub) = if tinted {
        (pa / accent_chroma, pb / accent_chroma)
    } else if own > 1e-6 {
        (a / own, b / own)
    } else {
        (0.0, 0.0)
    };
    let at = |chroma: f64| from_oklab([target, ua * chroma, ub * chroma]);
    let in_gamut = |v: [f64; 3]| v.iter().all(|c| *c >= -1e-4 && *c <= 1.0 + 1e-4);
    let mut chroma = wanted;
    if !in_gamut(at(wanted)) {
        let (mut inside, mut outside) = (0.0, wanted);
        for _ in 0..16 {
            let mid = (inside + outside) / 2.0;
            if in_gamut(at(mid)) {
                inside = mid;
            } else {
                outside = mid;
            }
        }
        chroma = inside;
    }
    let [r, g, b] = at(chroma);
    RgbaColor {
        r: r.clamp(0.0, 1.0) as f32,
        g: g.clamp(0.0, 1.0) as f32,
        b: b.clamp(0.0, 1.0) as f32,
        a: 1.0,
    }
}

fn sidebar_tones(c: &Chrome) -> (RgbaColor, RgbaColor) {
    let theme = &c.look.theme;
    let [top, bottom] = theme.window_tint;
    let sidebar_color = if theme.custom.is_some() {
        top
    } else {
        RgbaColor {
            r: (top.r + bottom.r) / 2.0,
            g: (top.g + bottom.g) / 2.0,
            b: (top.b + bottom.b) / 2.0,
            a: 1.0,
        }
    };
    let accent = if theme.custom.is_some() {
        sidebar_color
    } else {
        theme.backdrop.tint.color
    };
    (
        theme.roles.tab_selected.over(sidebar_color.opaque()),
        accent,
    )
}

pub const MIN_PANE_TEXT_CONTRAST: f32 = 4.5;
const PANE_REACH: [f64; 5] = [1.0, 1.5, 2.0, 3.0, 4.0];

pub fn pane_steps(
    surface: RgbaColor,
    accent: RgbaColor,
    dark: bool,
    ink: RgbaColor,
) -> (RgbaColor, RgbaColor) {
    let (rest, hover) = if dark { (0.06, 0.09) } else { (-0.04, -0.06) };
    let readable = |step: f64| ink.contrast_ratio(tone_step(surface, accent, step));
    let sign = if readable(rest) >= MIN_PANE_TEXT_CONTRAST || readable(rest) >= readable(-rest) {
        1.0
    } else {
        -1.0
    };
    let reach = PANE_REACH
        .iter()
        .copied()
        .find(|k| readable(sign * k * rest) >= MIN_PANE_TEXT_CONTRAST)
        .unwrap_or(4.0);
    let at = |step: f64| tone_step(surface, accent, sign * (step + (reach - 1.0) * rest));
    (at(rest), at(hover))
}

pub fn active_pane_tones(c: &Chrome) -> (Hsla, Hsla) {
    let (selected, accent) = sidebar_tones(c);
    let (rest, hover) = pane_steps(selected, accent, c.p.dark, c.look.theme.roles.text_tab);
    (hsla(rest), hsla(hover))
}

pub fn ghost_fill(c: &Chrome) -> Hsla {
    let theme = &c.look.theme;
    let [top, bottom] = theme.window_tint;
    let sidebar_color = if theme.custom.is_some() {
        top
    } else {
        RgbaColor {
            r: (top.r + bottom.r) / 2.0,
            g: (top.g + bottom.g) / 2.0,
            b: (top.b + bottom.b) / 2.0,
            a: 1.0,
        }
    };
    let selected = theme.roles.tab_selected.over(sidebar_color.opaque());
    let accent = if theme.custom.is_some() {
        sidebar_color
    } else {
        theme.backdrop.tint.color
    };
    let ink = theme.row_selected_text;
    let light_ink = ink.contrast_ratio(RgbaColor::BLACK) > ink.contrast_ratio(RgbaColor::WHITE);
    let step = if light_ink {
        -GHOST_STEP_DEEPER
    } else {
        GHOST_STEP_LIGHTER
    };
    hsla(tone_step(selected, accent, step))
}

#[derive(Clone)]
pub enum GhostArt {
    Folder {
        id: gpui::SharedString,
        side: f32,
        palette: crate::sidebar::group_list::FolderPalette,
    },
    Mosaic(Vec<Vec<Favicon>>),
}

fn ghost_icon(ghost: &Ghost, tile: bool) -> AnyElement {
    match &ghost.art {
        Some(GhostArt::Folder { id, side, palette }) => {
            crate::sidebar::group_list::folder_art(id.clone(), false, *side, *palette)
                .into_any_element()
        }
        Some(GhostArt::Mosaic(rows)) if tile => {
            let cell = crate::sidebar::folders::MOSAIC_CELL;
            div()
                .size_full()
                .flex()
                .flex_col()
                .justify_around()
                .children(rows.iter().map(|row| {
                    div()
                        .flex()
                        .items_center()
                        .justify_around()
                        .children(row.iter().map(|favicon| {
                            div()
                                .flex_none()
                                .size(px(cell))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(render_favicon(favicon, cell, &ghost.p))
                        }))
                }))
                .into_any_element()
        }
        _ => render_favicon(&ghost.favicon, 16., &ghost.p),
    }
}

#[derive(Clone)]
pub struct Ghost {
    pub window: String,
    pub title: gpui::SharedString,
    pub favicon: Favicon,
    pub p: Palette,
    pub tokens: SidebarTokens,
    pub fill: Hsla,
    pub ink: Hsla,
    pub row_width: f32,
    pub tile_width: f32,
    pub kind: DragKind,
    pub title_size: f32,
    pub card: crate::content::drag_card::DragCard,
    pub art: Option<GhostArt>,
}

pub struct GhostView {
    pub ghost: Ghost,
    look: Option<GhostLook>,
    card: crate::content::drag_card::CardMotion,
}

impl std::fmt::Debug for Ghost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ghost").field("title", &self.title).finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct LookTarget {
    w: f32,
    h: f32,
    corner: f32,
    shift_x: f32,
    shift_y: f32,
    tile: f32,
    pane: f32,
}

#[derive(Clone, Copy, Debug)]
struct GhostLook {
    target: LookTarget,
    w: drag_motion::Slide,
    h: drag_motion::Slide,
    corner: drag_motion::Slide,
    shift_x: drag_motion::Slide,
    shift_y: drag_motion::Slide,
    tile: drag_motion::Slide,
    pane: drag_motion::Slide,
}

impl GhostLook {
    fn new(t: LookTarget) -> Self {
        let at = |v: f32| drag_motion::Slide::resting(v, drag_motion::MORPH_OMEGA);
        GhostLook {
            target: t,
            w: at(t.w),
            h: at(t.h),
            corner: at(t.corner),
            shift_x: at(t.shift_x),
            shift_y: at(t.shift_y),
            tile: at(t.tile),
            pane: at(t.pane),
        }
    }

    fn aim(&mut self, t: LookTarget, now: Instant) {
        if self.target == t {
            return;
        }
        self.target = t;
        self.w.aim(t.w, now);
        self.h.aim(t.h, now);
        self.corner.aim(t.corner, now);
        self.shift_x.aim(t.shift_x, now);
        self.shift_y.aim(t.shift_y, now);
        self.tile.aim(t.tile, now);
        self.pane.aim(t.pane, now);
    }

    fn moving(&self, now: Instant) -> bool {
        [
            self.w,
            self.h,
            self.corner,
            self.shift_x,
            self.shift_y,
            self.tile,
            self.pane,
        ]
        .iter()
        .any(|s| s.moving(now))
    }
}

impl Drop for GhostView {
    fn drop(&mut self) {
        let state = with_drag(&self.ghost.window, |s| s.clone());
        let inside = match (state.pointer, state.sidebar_px) {
            (Some(pointer), Some((left, width))) => {
                let x = f32::from(pointer.x);
                x >= left && x <= left + width
            }
            _ => false,
        };
        if let Some(tab) = state.dragging.as_ref().filter(|_| inside) {
            settle_after(&self.ghost.window, tab, &state, true);
        }
        end(&self.ghost.window);
    }
}

impl Ghost {
    pub fn view(&self) -> GhostView {
        GhostView {
            ghost: self.clone(),
            look: None,
            card: crate::content::drag_card::CardMotion::default(),
        }
    }
}

impl Ghost {
    pub fn new(c: &Chrome, tab: &Tab, kind: DragKind, row_width: f32, tile_width: f32) -> Self {
        Ghost {
            window: c.window.id.as_str().to_owned(),
            title: crate::window::chrome::tab_title(tab),
            favicon: c.favicon(tab),
            p: *c.p,
            tokens: row_look::tokens_of(c),
            fill: ghost_fill(c),
            ink: c.p.text_selected,
            row_width,
            tile_width,
            kind,
            title_size: row_look::title_size(c),
            card: crate::content::drag_card::DragCard::new(c, &tab.id),
            art: None,
        }
    }
}

pub fn ghost_face(
    ghost: &Ghost,
    w: f32,
    h: f32,
    radius: f32,
    tile: bool,
    lifted: f32,
) -> gpui::Div {
    let (dark_alpha, light_alpha, blur, y) = DRAG_GHOST_SHADOW;
    let alpha = if ghost.p.dark {
        dark_alpha
    } else {
        light_alpha
    };
    div()
        .w(px(w))
        .h(px(h))
        .rounded(px(radius))
        .shadow(vec![shadow(
            Hsla::black().opacity(alpha * lifted),
            y,
            blur * 2.0,
        )])
        .child(
            div()
                .size_full()
                .rounded(px(radius))
                .opacity(GHOST_OPACITY)
                .bg(ghost.fill)
                .border(px(0.5))
                .border_color(ghost.tokens.drag_border)
                .flex()
                .items_center()
                .overflow_hidden()
                .when(tile, |d| d.justify_center())
                .when(!tile, |d| {
                    d.pl(px(sidebar::ROW_CONTENT_LEFT))
                        .pr(px(sidebar::ROW_TRAILING))
                        .gap(px(row_look::SPACE_M))
                })
                .child(ghost_icon(ghost, tile))
                .when(!tile, |d| {
                    d.child(
                        fade_label(ghost.title.clone(), ghost.ink, ghost.title_size)
                            .weight(if ghost.kind == DragKind::Group {
                                FontWeight::MEDIUM
                            } else {
                                FontWeight::NORMAL
                            })
                            .line_height(18.),
                    )
                }),
        )
}

impl Render for GhostView {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        let ghost = &self.ghost;
        let m = Metrics::now();
        let state = with_drag(&ghost.window, |s| {
            (
                s.dragging.is_some(),
                s.lifted,
                s.over_tiles,
                s.spot.clone(),
                s.pointer,
                s.grab,
                s.frames.clone(),
                s.source.clone(),
                s.gap.clone(),
                s.scrolled(),
                s.on_page,
                s.page_target,
                s.tile_target,
                s.sidebar_px,
            )
        });
        let (
            dragging,
            lifted,
            over_tiles,
            spot,
            pointer,
            grab,
            frames,
            source,
            gap,
            scrolled,
            on_page,
            page_target,
            tile_target,
            sidebar_px,
        ) = state;
        let tile_kind = ghost.kind == DragKind::Tile;
        let tile_face = over_tiles
            || tile_kind
                && !matches!(
                    spot,
                    Some(DropSpot::BeforeRow(_) | DropSpot::AfterRow(_) | DropSpot::RowsEnd)
                );
        let pane = match (&spot, pointer) {
            (Some(DropSpot::Split(target, half)), Some(pointer)) => {
                frames.iter().find(|f| &f.tab == target).map(|f| {
                    let top = drag_motion::shown_top(f, &frames, source.as_ref(), gap.as_ref(), m);
                    let slot = drag_motion::pane_slot(f, top + scrolled, *half, m);
                    (slot, pointer - grab)
                })
            }
            _ => None,
        };
        let scale = crate::scale::current();
        let points = |v: Pixels| f32::from(v) / scale;
        let anchored_at = |w: f32, h: f32| {
            let lead = if tile_kind {
                w * TILE_GHOST_POINTER
            } else {
                w / 2.0
            };
            (points(grab.x) - lead, points(grab.y) - h / 2.0)
        };
        let base = if tile_kind {
            (
                ghost.tile_width,
                sidebar::pinned_tile_height(),
                sidebar::PINNED_TILE_RADIUS,
            )
        } else {
            (
                ghost.row_width,
                sidebar::row_height(),
                row_look::chrome_radius(),
            )
        };
        let target = if let Some((slot, origin)) = pane {
            LookTarget {
                w: points(slot.size.width),
                h: points(slot.size.height),
                corner: (row_look::chrome_radius() - drag_motion::PANE_INSET).max(0.0),
                shift_x: points(slot.origin.x - origin.x),
                shift_y: points(slot.origin.y - origin.y),
                tile: 0.0,
                pane: 1.0,
            }
        } else if tile_face != tile_kind {
            let (w, h, corner) = if tile_face {
                (
                    tile_target.unwrap_or(ghost.tile_width),
                    sidebar::pinned_tile_height(),
                    sidebar::PINNED_TILE_RADIUS,
                )
            } else {
                (
                    ghost.row_width,
                    sidebar::row_height(),
                    row_look::chrome_radius(),
                )
            };
            let (shift_x, shift_y) = anchored_at(w, h);
            LookTarget {
                w,
                h,
                corner,
                shift_x,
                shift_y,
                tile: if tile_face { 1.0 } else { 0.0 },
                pane: 0.0,
            }
        } else {
            LookTarget {
                w: base.0,
                h: base.1,
                corner: base.2,
                shift_x: 0.0,
                shift_y: 0.0,
                tile: if tile_kind { 1.0 } else { 0.0 },
                pane: 0.0,
            }
        };
        let look = self.look.get_or_insert_with(|| GhostLook::new(target));
        look.aim(target, now);
        let moving = look.moving(now);
        let tile_shown = look.tile.value(now) > 0.5;
        let pane_shown = look.pane.value(now);
        let hidden = !dragging || !lifted;
        self.card.aim(dragging && on_page && !page_target, now);
        if moving || self.card.moving(now) {
            window.request_animation_frame();
        }
        if dragging && on_page {
            let shown = self.card.progress(now).filter(|_| !page_target);
            return div().children(shown.map(|progress| {
                let pill = crate::content::drag_card::CardFrame {
                    x: 0.0,
                    y: 0.0,
                    w: look.w.value(now),
                    h: look.h.value(now),
                };
                let frame = crate::content::drag_card::card_frame(
                    pill,
                    [points(grab.x), points(grab.y)],
                    progress,
                );
                if progress <= 0.0 {
                    div()
                        .absolute()
                        .left(px(frame.x))
                        .top(px(frame.y))
                        .child(ghost_face(
                            ghost,
                            frame.w,
                            frame.h,
                            look.corner.value(now),
                            tile_shown,
                            1.0,
                        ))
                } else {
                    crate::content::drag_card::drag_card(&ghost.card, frame)
                }
            }));
        }
        let face = div()
            .absolute()
            .top(px(GHOST_CLIP_ROOM + look.shift_y.value(now)))
            .opacity(1.0 - pane_shown)
            .child(ghost_face(
                ghost,
                look.w.value(now),
                look.h.value(now),
                look.corner.value(now),
                tile_shown,
                1.0 - pane_shown,
            ));
        let origin_x = pointer.map(|p| points(p.x - grab.x));
        let clip = match (origin_x, sidebar_px, pane) {
            (Some(origin_x), Some((left, width)), None) => {
                Some((left / scale - origin_x, width / scale))
            }
            _ => None,
        };
        let (clip_left, clip_width) = clip.unwrap_or((
            look.shift_x.value(now).min(0.0) - GHOST_CLIP_ROOM,
            look.w.value(now) + look.shift_x.value(now).abs() + 2.0 * GHOST_CLIP_ROOM,
        ));
        div()
            .when(hidden, |d| d.invisible())
            .relative()
            .left(px(clip_left))
            .top(px(-GHOST_CLIP_ROOM))
            .w(px(clip_width.max(0.0)))
            .h(px(look.h.value(now)
                + look.shift_y.value(now).abs()
                + 2.0 * GHOST_CLIP_ROOM))
            .overflow_hidden()
            .child(face.left(px(look.shift_x.value(now) - clip_left)))
    }
}

pub const EDGE_GLOW_FILL: [(f32, f32); 4] = [(0.0, 0.0), (0.2, 1.0), (0.8, 1.0), (1.0, 0.0)];
pub const EDGE_GLOW_FADE: [(f32, f32); 5] = [
    (0.0, 1.0),
    (0.15, 0.75),
    (0.35, 0.42),
    (0.6, 0.15),
    (1.0, 0.0),
];

pub fn edge_fade(edge: Edge) -> Vec<(f32, f32)> {
    match edge {
        Edge::Left => EDGE_GLOW_FADE.to_vec(),
        Edge::Right => EDGE_GLOW_FADE
            .iter()
            .rev()
            .map(|(at, alpha)| (1.0 - at, *alpha))
            .collect(),
    }
}

pub fn edge_glow(c: &Chrome) -> Option<AnyElement> {
    let edge = with_drag(c.window.id.as_str(), |s| s.edge)?;
    let rect = c.layout.sidebar?;
    let color = row_look::tokens_of(c).edge_glow;
    let fade = edge_fade(edge);
    let x = match edge {
        Edge::Left => rect.x,
        Edge::Right => rect.x + rect.w - EDGE_GLOW_WIDTH,
    };
    Some(
        deferred(
            anchored()
                .position_mode(AnchoredPositionMode::Window)
                .position(point(px(x), px(rect.y)))
                .child(
                    div()
                        .w(px(EDGE_GLOW_WIDTH))
                        .h(px(rect.h))
                        .relative()
                        .child(
                            crate::primitives::gradient_fill::gradient_fill(color, &EDGE_GLOW_FILL)
                                .fade(&fade),
                        )
                        .with_animation(
                            "edge-glow",
                            gpui::Animation::new(Duration::from_millis(180)),
                            |d, t| d.opacity(t),
                        ),
                ),
        )
        .with_priority(1)
        .into_any_element(),
    )
}

pub fn pin_slot_zone(c: &Chrome) -> AnyElement {
    let tokens = row_look::tokens_of(c);
    let lit = with_drag(c.window.id.as_str(), |s| s.over_tiles);
    div()
        .w_full()
        .h(px(sidebar::pinned_tile_height()))
        .rounded(px(sidebar::PINNED_TILE_RADIUS))
        .border(px(1.5))
        .border_dashed()
        .border_color(tokens.drop_mark)
        .bg(hsla(c.look.theme.roles.drop_zone_fill))
        .opacity(if lit { 1.0 } else { 0.0 })
        .flex()
        .items_center()
        .justify_center()
        .child(icon(Icon::Pin, 13., tokens.drop_mark))
        .into_any_element()
}

pub fn pin_field_zone(c: &Chrome) -> Option<AnyElement> {
    if !c.sections.tiles.is_empty() {
        return None;
    }
    let window = c.window.id.as_str().to_owned();
    let (shown, lit) = with_drag(&window, |s| {
        (s.dragging.is_some() && s.lifted, s.over_tiles && s.pin_zone)
    });
    if !shown {
        return None;
    }
    let tokens = row_look::tokens_of(c);
    let emit = c.emit.clone();
    let sidebar = c.layout.sidebar.map(|r| (r.x, r.w));
    let drops = DropContext::new(c);
    Some(
        div()
            .id("pin-field-zone")
            .debug_selector(|| "pin-field-zone".into())
            .absolute()
            .inset_0()
            .rounded(px(row_look::chrome_radius()))
            .border(px(if lit { 1.5 } else { 1.0 }))
            .border_dashed()
            .border_color(if lit {
                tokens.drop_mark
            } else {
                tokens.drag_border
            })
            .bg(tokens.drag_silhouette)
            .flex()
            .items_center()
            .justify_center()
            .child(icon(
                Icon::Pin,
                13.,
                if lit {
                    tokens.drop_mark
                } else {
                    c.p.text_secondary
                },
            ))
            .on_drag_move::<TabDrag>(move |event, win, cx| {
                pin_zone_moved(
                    &window,
                    &emit,
                    sidebar,
                    event.bounds,
                    event.event.position,
                    win,
                    cx,
                )
            })
            .on_drop(move |drag: &TabDrag, win, cx| drops.drop(drag, win, cx))
            .into_any_element(),
    )
}

fn pin_zone_moved(
    window: &str,
    emit: &Emit,
    sidebar: Option<(f32, f32)>,
    zone: Bounds<Pixels>,
    pointer: Point<Pixels>,
    win: &mut Window,
    cx: &mut App,
) {
    aim_edge(window, emit, sidebar, pointer, win, cx);
    note_sidebar(window, sidebar);
    let width = f32::from(zone.size.width) / crate::scale::current();
    let placed = with_drag(window, |s| {
        let placed = s.tiles != Some(zone) || !s.pin_zone;
        s.tiles = Some(zone);
        s.pin_zone = true;
        s.tile_target = Some(width);
        placed
    });
    point_moved(window, pointer, win, cx);
    if placed && retarget(window, win, cx) {
        win.refresh();
    }
}

pub fn pin_slot_pitch() -> f32 {
    sidebar::pinned_tile_height() + sidebar::PINNED_TILE_GAP
}

fn pin_slot_shown(c: &Chrome) -> bool {
    !c.layout.sidebar_field
        && c.sections.tiles.is_empty()
        && with_drag(c.window.id.as_str(), |s| s.dragging.is_some() && s.lifted)
}

fn pin_gap_now(window: &str, now: Instant) -> (f32, bool) {
    with_drag(window, |s| {
        s.pin_gap
            .map_or((0.0, false), |g| (g.value(now), g.moving(now)))
    })
}

pub fn pin_slot_gap(c: &Chrome) -> Option<AnyElement> {
    if c.layout.sidebar_field || !c.sections.tiles.is_empty() {
        return None;
    }
    let (height, moving) = pin_gap_now(c.window.id.as_str(), Instant::now());
    (height > 0.0 || moving).then(|| {
        div()
            .flex_none()
            .h(px(height))
            .when(moving, |d| d.child(crate::sidebar::tab_row::frame_pump()))
            .into_any_element()
    })
}

pub fn pin_slot_overlay(c: &Chrome) -> Option<AnyElement> {
    if !pin_slot_shown(c) {
        return None;
    }
    let window = c.window.id.as_str().to_owned();
    let (gap, _) = pin_gap_now(&window, Instant::now());
    let lit = with_drag(&window, |s| s.over_tiles && s.pin_zone);
    let first_row_top = c.layout.first_row_top;
    let region_height = if lit {
        first_row_top + sidebar::pinned_tile_height()
    } else {
        first_row_top - sidebar::row_gap()
    };
    let tokens = row_look::tokens_of(c);
    let emit = c.emit.clone();
    let sidebar_rect = c.layout.sidebar.map(|r| (r.x, r.w));
    let drops = DropContext::new(c);
    Some(
        div()
            .absolute()
            .top_0()
            .left(px(sidebar::INSET))
            .right(px(sidebar::INSET))
            .child(
                div()
                    .id("pin-slot-region")
                    .debug_selector(|| "pin-slot-region".into())
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(region_height.max(0.0)))
                    .on_drag_move::<TabDrag>(move |event, win, cx| {
                        pin_zone_moved(
                            &window,
                            &emit,
                            sidebar_rect,
                            event.bounds,
                            event.event.position,
                            win,
                            cx,
                        )
                    })
                    .on_drop(move |drag: &TabDrag, win, cx| drops.drop(drag, win, cx)),
            )
            .child(
                div()
                    .debug_selector(|| "pin-slot-zone".into())
                    .absolute()
                    .left_0()
                    .right_0()
                    .top(px(first_row_top))
                    .h(px(sidebar::pinned_tile_height()))
                    .opacity((gap / pin_slot_pitch()).clamp(0.0, 1.0))
                    .rounded(px(sidebar::PINNED_TILE_RADIUS))
                    .border(px(1.5))
                    .border_dashed()
                    .border_color(tokens.drop_mark)
                    .bg(hsla(c.look.theme.roles.drop_zone_fill))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon(Icon::Pin, 13., tokens.drop_mark)),
            )
            .into_any_element(),
    )
}

pub fn row_ghost_width(c: &Chrome) -> f32 {
    (c.layout.sidebar_width - 2.0 * sidebar::INSET).max(0.0)
}

pub fn order(c: &Chrome) -> Rc<Vec<TabId>> {
    DropContext::new(c).order
}

#[cfg(test)]
mod tests {

    #[test]
    fn dropped_links_and_text_open_web_pages_only() {
        let items = gpui::ExternalItems {
            paths: Vec::new(),
            urls: vec![
                " https://example.com/a ".into(),
                "ftp://x.test/".into(),
                "https:///nohost".into(),
            ],
            text: Some("ardia.dev".into()),
        };
        let urls = dropped_item_urls(&items);
        assert_eq!(urls[0], "https://example.com/a");
        assert_eq!(urls.len(), 2);
        assert!(urls[1].contains("ardia.dev"));
        let prose = gpui::ExternalItems {
            paths: Vec::new(),
            urls: Vec::new(),
            text: Some("two words".into()),
        };
        assert!(dropped_item_urls(&prose).is_empty());
    }

    use super::*;
    use gpui::size;

    fn id(s: &str) -> TabId {
        TabId::from(s)
    }

    fn row_at(y: f32, h: f32) -> Bounds<Pixels> {
        Bounds::new(
            point(gpui::px(0.), gpui::px(y)),
            size(gpui::px(200.), gpui::px(h)),
        )
    }

    #[test]
    fn a_row_flips_its_gap_only_past_its_drawn_centre() {
        let tab = id("t");
        let plain = row_at(100., sidebar::row_height());
        assert_eq!(
            row_spot(plain, false, point(gpui::px(10.), gpui::px(110.)), &tab),
            DropSpot::BeforeRow(tab.clone())
        );
        assert_eq!(
            row_spot(plain, false, point(gpui::px(10.), gpui::px(120.)), &tab),
            DropSpot::AfterRow(tab.clone())
        );
        let gapped = row_at(100., sidebar::row_height() + sidebar::row_pitch());
        assert_eq!(
            row_spot(gapped, true, point(gpui::px(10.), gpui::px(120.)), &tab),
            DropSpot::BeforeRow(tab.clone())
        );
    }

    #[test]
    fn the_pin_zone_keeps_six_points_of_hysteresis() {
        assert!(over_pins(103., 100., true));
        assert!(!over_pins(103., 100., false));
        assert!(over_pins(93., 100., false));
    }

    #[test]
    fn the_field_pin_zone_reaches_six_points_past_its_edges() {
        let zone = row_at(46., 34.);
        assert!(inside_zone(zone, point(gpui::px(-6.), gpui::px(40.))));
        assert!(!inside_zone(zone, point(gpui::px(-7.), gpui::px(60.))));
        assert!(inside_zone(zone, point(gpui::px(100.), gpui::px(86.))));
        assert!(!inside_zone(zone, point(gpui::px(100.), gpui::px(87.))));
        assert!(!inside_zone(zone, point(gpui::px(100.), gpui::px(39.))));
    }

    #[test]
    fn a_collapsed_group_takes_tabs_in_its_headers_middle_third() {
        assert!(into_group_band(100.0, 36.0, 118.0));
        assert!(into_group_band(100.0, 36.0, 106.5));
        assert!(!into_group_band(100.0, 36.0, 105.0));
        assert!(!into_group_band(100.0, 36.0, 131.0));
    }

    #[test]
    fn a_tile_takes_a_folder_only_near_its_middle() {
        let grid = Bounds::new(point(px(0.0), px(0.0)), size(px(178.0), px(100.0)));
        let width = 55.0;
        let centre = point(
            px(width * 1.5 + sidebar::PINNED_TILE_GAP),
            px(sidebar::pinned_tile_height() / 2.0),
        );
        assert_eq!(
            tile_part(grid, 1, Some(0), 3, width, centre, true, false),
            (Some(0), TilePart::Centre)
        );
        assert_eq!(
            tile_part(grid, 1, Some(0), 3, width, centre, false, false).1,
            TilePart::After
        );
        assert_eq!(
            tile_part(grid, 1, Some(1), 3, width, centre, true, false),
            (None, TilePart::Gap)
        );
        let edge = point(px(width + sidebar::PINNED_TILE_GAP + 4.0), px(10.0));
        assert_eq!(
            tile_part(grid, 1, Some(0), 3, width, edge, true, false).1,
            TilePart::Before
        );
        let held_edge = point(
            px(width + sidebar::PINNED_TILE_GAP + width * 0.12),
            px(10.0),
        );
        assert_eq!(
            tile_part(grid, 1, Some(0), 3, width, held_edge, true, false).1,
            TilePart::Before
        );
        assert_eq!(
            tile_part(grid, 1, Some(0), 3, width, held_edge, true, true).1,
            TilePart::Centre
        );
    }

    #[test]
    fn a_dropped_group_lands_before_the_row_after_its_gap() {
        let order = vec![id("a"), id("g1"), id("g2"), id("b"), id("c")];
        let groups: HashMap<TabId, GroupId> = [(id("c"), ardia_state::GroupId::new("other"))]
            .into_iter()
            .collect();
        let pins = HashMap::new();
        let messages = |group: GroupId, spot: DropSpot, members: &HashSet<TabId>| {
            group_drop_messages(&order, &pins, &groups, group, &spot, members)
        };
        let members: HashSet<TabId> = [id("g1"), id("g2")].into_iter().collect();
        let group = ardia_state::GroupId::new("g");
        let after = messages(group.clone(), DropSpot::AfterRow(id("a")), &members);
        assert!(
            matches!(&after[..], [Msg::Store(Action::MoveGroup { before: Some(b), parent: None, pinned: false, .. })] if *b == id("b"))
        );
        let inside = messages(group.clone(), DropSpot::BeforeRow(id("c")), &members);
        assert!(
            matches!(&inside[..], [Msg::Store(Action::MoveGroup { parent: Some(p), .. })] if p.as_str() == "other")
        );
        let end = messages(group, DropSpot::RowsEnd, &members);
        assert!(matches!(
            &end[..],
            [Msg::Store(Action::MoveGroup {
                before: None,
                parent: None,
                ..
            })]
        ));
    }

    #[test]
    fn a_dragged_folder_moves_all_its_members_together() {
        let tiles = vec![id("a"), id("f1"), id("f2"), id("b")];
        let order = vec![id("a"), id("f1"), id("f2"), id("b"), id("r")];
        let members = vec![id("f1"), id("f2")];
        let first = folder_drop_messages(&tiles, &order, &DropSpot::Tile(0), &members);
        assert_eq!(first.len(), 2);
        assert!(first.iter().all(
            |m| matches!(m, Msg::DropTab { before: Some(b), pin: Some(true), .. } if *b == id("a"))
        ));
        let rows = folder_drop_messages(&tiles, &order, &DropSpot::RowsEnd, &members);
        assert!(rows.iter().all(|m| matches!(
            m,
            Msg::DropTab {
                before: None,
                pin: Some(false),
                ..
            }
        )));
    }

    #[test]
    fn the_split_band_is_the_rows_middle_half() {
        let top = gpui::px(0.);
        assert!(!in_split_band(top, point(gpui::px(0.), gpui::px(8.))));
        assert!(in_split_band(top, point(gpui::px(0.), gpui::px(17.))));
        assert!(!in_split_band(top, point(gpui::px(0.), gpui::px(26.))));
    }

    #[test]
    fn an_outside_drag_gap_lasts_only_while_the_drag_keeps_arriving() {
        let window = "external-test";
        with_drag(window, |s| {
            s.spot = Some(DropSpot::AfterRow(id("b")));
            s.external_at = Some(Instant::now());
        });
        assert!(with_drag(window, |s| s.live()));
        let order = vec![id("a"), id("b"), id("c")];
        assert_eq!(external_index(window, &order), Some(2));
        assert!(!with_drag(window, |s| s.live()));
        with_drag(window, |s| {
            s.spot = Some(DropSpot::BeforeRow(id("a")));
            s.external_at = Some(Instant::now() - Duration::from_millis(EXTERNAL_HOLD_MS + 50));
        });
        assert_eq!(external_index(window, &order), None);
    }

    #[test]
    fn the_right_edge_glow_fades_toward_the_list() {
        let right = edge_fade(Edge::Right);
        assert_eq!(right.first(), Some(&(0.0, 0.0)));
        assert_eq!(right.last(), Some(&(1.0, 1.0)));
        assert_eq!(edge_fade(Edge::Left)[1], (0.15, 0.75));
    }

    #[test]
    fn edges_are_sixteen_point_bands_inside_the_sidebar() {
        assert_eq!(edge_at(0., 200., 5.), Some(Edge::Left));
        assert_eq!(edge_at(0., 200., 195.), Some(Edge::Right));
        assert_eq!(edge_at(0., 200., 100.), None);
        assert_eq!(edge_at(0., 40., 5.), None);
    }

    #[test]
    fn dropped_files_become_file_urls() {
        let urls = dropped_file_urls(&[
            std::path::PathBuf::from("/tmp/a b.html"),
            std::path::PathBuf::from("relative.txt"),
        ]);
        assert_eq!(urls, vec!["file:///tmp/a%20b.html".to_owned()]);
    }

    #[test]
    fn a_tab_from_another_window_lands_before_the_row_under_it() {
        let rows = vec![(id("a"), 100.), (id("b"), 137.)];
        assert_eq!(incoming_before(&rows, 110., 34.), Incoming::Before(id("a")));
        assert_eq!(incoming_before(&rows, 130., 34.), Incoming::Before(id("b")));
        assert_eq!(incoming_before(&rows, 200., 34.), Incoming::End);
    }

    #[test]
    fn dropping_after_a_row_lands_before_the_next_one() {
        let order = vec![id("a"), id("b"), id("c")];
        assert_eq!(next_after(&order, &id("a"), &id("b")), Some(id("c")));
        assert_eq!(next_after(&order, &id("c"), &id("a")), None);
    }

    #[test]
    fn tile_slots_follow_the_grid() {
        let grid = row_at(0., 88.);
        assert_eq!(
            tile_slot(grid, 6, 62., 3, point(gpui::px(5.), gpui::px(5.))),
            0
        );
        assert_eq!(
            tile_slot(grid, 6, 62., 3, point(gpui::px(140.), gpui::px(60.))),
            5
        );
    }

    #[test]
    fn the_ghost_tone_stays_opaque_and_in_gamut() {
        let fill = tone_step(
            RgbaColor::hex(0x2A1E23),
            RgbaColor::hex(0x6E4BD8),
            -GHOST_STEP_DEEPER,
        );
        assert_eq!(fill.a, 1.0);
        assert!(fill.r <= 1.0 && fill.g >= 0.0);
    }
}
