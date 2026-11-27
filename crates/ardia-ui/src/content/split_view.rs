use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use crate::scale::px;
use ardia_state::model::Orientation;
use ardia_state::splits::{SplitSide, SplitSlot, SplitView};
use ardia_state::windows::BrowserWindow;
use ardia_state::{Action, BrowserState, SplitId, TabId};
use gpui::{
    AnyElement, App, CursorStyle, DragMoveEvent, FontWeight, Hsla, IntoElement, MouseButton,
    ParentElement, RenderOnce, SharedString, Styled, Window, div, prelude::*,
};

use crate::msg::Msg;
use crate::primitives::controls::EmptyDrag;
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::{Chrome, TabDrag};
use crate::window::layout::Rect;

pub const MIN_PANE: f64 = 0.12;
pub const MIN_PANE_POINTS: f32 = 220.0;
pub const HANDLE_SLOP: f32 = 2.0;
pub const HANDLE_THICKNESS: f32 = 4.0;
pub const HANDLE_LENGTH: f32 = 36.0;
pub const HANDLE_HOVER_OPACITY: f32 = 0.32;
pub const HANDLE_DRAG_OPACITY: f32 = 0.55;
pub const FOCUS_RING_WIDTH: f32 = 2.0;
pub const FOCUS_RING_GAP: f32 = 1.0;
pub const PANE_GROUP: &str = "split-pane";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DividerKind {
    Root(usize),
    Stack,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Divider {
    pub kind: DividerKind,
    pub rect: Rect,
    pub vertical: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SplitHandleDrag {
    pub split: SplitId,
    pub divider: DividerKind,
}

#[derive(Clone, Debug, PartialEq)]
struct HandleGrab {
    split: SplitId,
    divider: DividerKind,
    sizes: Vec<f64>,
    pointer: f32,
}

thread_local! {
    static HANDLE_GRAB: std::cell::RefCell<Option<HandleGrab>> = const { std::cell::RefCell::new(None) };
}

fn cut(total: f32, sizes: &[f64], gap: f32) -> Vec<(f32, f32)> {
    let free = (total - gap * sizes.len().saturating_sub(1) as f32).max(0.0);
    let mut at = 0.0;
    let mut used = 0.0;
    sizes
        .iter()
        .enumerate()
        .map(|(index, share)| {
            let size = if index + 1 == sizes.len() {
                free - used
            } else {
                (free * *share as f32).round()
            };
            let out = (at, size);
            at += size + gap;
            used += size;
            out
        })
        .collect()
}

pub fn split_geometry(
    split: &SplitView,
    width: f32,
    height: f32,
    gap: f32,
) -> (Vec<(TabId, Rect)>, Vec<Divider>) {
    let horizontal = split.orientation == Orientation::Horizontal;
    let sizes: Vec<f64> = split.slots.iter().map(|slot| slot.size()).collect();
    let main = cut(if horizontal { width } else { height }, &sizes, gap);
    let mut panes = Vec::new();
    let mut dividers = Vec::new();
    for (index, (slot, (start, size))) in split.slots.iter().zip(main).enumerate() {
        let slot_rect = if horizontal {
            Rect::new(start, 0.0, size, height)
        } else {
            Rect::new(0.0, start, width, size)
        };
        match slot {
            SplitSlot::Pane { tab_id, .. } => panes.push((tab_id.clone(), slot_rect)),
            SplitSlot::Stack {
                stack, stack_sizes, ..
            } => {
                let inner = cut(
                    if horizontal { slot_rect.h } else { slot_rect.w },
                    stack_sizes,
                    gap,
                );
                for (tab, (s, z)) in stack.iter().zip(inner.iter().copied()) {
                    let rect = if horizontal {
                        Rect::new(slot_rect.x, s, slot_rect.w, z)
                    } else {
                        Rect::new(s, slot_rect.y, z, slot_rect.h)
                    };
                    panes.push((tab.clone(), rect));
                }
                let first = inner.first().map_or(0.0, |(_, z)| *z);
                dividers.push(Divider {
                    kind: DividerKind::Stack,
                    vertical: !horizontal,
                    rect: if horizontal {
                        Rect::new(slot_rect.x, first, slot_rect.w, gap)
                    } else {
                        Rect::new(first, slot_rect.y, gap, slot_rect.h)
                    },
                });
            }
        }
        if index + 1 < split.slots.len() {
            dividers.push(Divider {
                kind: DividerKind::Root(index),
                vertical: horizontal,
                rect: if horizontal {
                    Rect::new(start + size, 0.0, gap, height)
                } else {
                    Rect::new(0.0, start + size, width, gap)
                },
            });
        }
    }
    (panes, dividers)
}

pub fn pane_rects(split: &SplitView, width: f32, height: f32, gap: f32) -> Vec<(TabId, Rect)> {
    split_geometry(split, width, height, gap).0
}

pub fn handle_rect(divider: &Divider) -> Rect {
    let r = divider.rect;
    if divider.vertical {
        Rect::new(r.x - HANDLE_SLOP, r.y, r.w + 2.0 * HANDLE_SLOP, r.h)
    } else {
        Rect::new(r.x, r.y - HANDLE_SLOP, r.w, r.h + 2.0 * HANDLE_SLOP)
    }
}

pub fn handle_rects(split: &SplitView, width: f32, height: f32, gap: f32) -> Vec<(usize, Rect)> {
    split_geometry(split, width, height, gap)
        .1
        .iter()
        .filter_map(|d| match d.kind {
            DividerKind::Root(index) => Some((index, handle_rect(d))),
            DividerKind::Stack => None,
        })
        .collect()
}

pub fn resize_shares(
    sizes: &[f64],
    a: usize,
    delta: f32,
    total: f32,
    gap: f32,
) -> Option<Vec<f64>> {
    let b = a.checked_add(1).filter(|b| *b < sizes.len())?;
    if !delta.is_finite() {
        return None;
    }
    let free = f64::from((total - gap * sizes.len().saturating_sub(1) as f32).max(1.0));
    let points: Vec<f64> = sizes.iter().map(|share| share * free).collect();
    let pair = points[a] + points[b];
    let min = f64::from(MIN_PANE_POINTS).min(points[a]).min(points[b]);
    let left = (points[a] + f64::from(delta)).max(min).min(pair - min);
    let mut next = points;
    next[a] = left;
    next[b] = pair - left;
    Some(next.into_iter().map(|p| p / free).collect())
}

fn stack_sizes_of(split: &SplitView) -> Option<[f64; 2]> {
    split.slots.iter().find_map(|slot| match slot {
        SplitSlot::Stack { stack_sizes, .. } => Some(*stack_sizes),
        SplitSlot::Pane { .. } => None,
    })
}

fn divider_sizes(split: &SplitView, divider: DividerKind) -> Vec<f64> {
    match divider {
        DividerKind::Root(_) => split.slots.iter().map(|slot| slot.size()).collect(),
        DividerKind::Stack => stack_sizes_of(split).map(Vec::from).unwrap_or_default(),
    }
}

pub fn evened(split: &SplitView, divider: DividerKind) -> Option<Action> {
    match divider {
        DividerKind::Root(index) => even_pair(split, index).map(|sizes| Action::ResizeSplit {
            split: split.id.clone(),
            sizes,
        }),
        DividerKind::Stack => stack_sizes_of(split).map(|_| Action::RestackSplit {
            split: split.id.clone(),
            stack_sizes: [0.5, 0.5],
        }),
    }
}

pub fn dragged(
    split: &SplitId,
    divider: DividerKind,
    start: &[f64],
    delta: f32,
    total: f32,
    gap: f32,
) -> Option<Action> {
    match divider {
        DividerKind::Root(index) => {
            resize_shares(start, index, delta, total, gap).map(|sizes| Action::ResizeSplit {
                split: split.clone(),
                sizes,
            })
        }
        DividerKind::Stack => resize_shares(start, 0, delta, total, gap)
            .filter(|sizes| sizes.len() == 2)
            .map(|sizes| Action::RestackSplit {
                split: split.clone(),
                stack_sizes: [sizes[0], sizes[1]],
            }),
    }
}

pub fn even_pair(split: &SplitView, handle: usize) -> Option<Vec<f64>> {
    let mut sizes: Vec<f64> = split.slots.iter().map(|slot| slot.size()).collect();
    let next = handle.checked_add(1).filter(|next| *next < sizes.len())?;
    let half = (sizes[handle] + sizes[next]) / 2.0;
    sizes[handle] = half;
    sizes[next] = half;
    Some(sizes)
}

pub fn resized(split: &SplitView, handle: usize, fraction: f64) -> Option<Vec<f64>> {
    let sizes: Vec<f64> = split.slots.iter().map(|slot| slot.size()).collect();
    let next_slot = handle.checked_add(1).filter(|next| *next < sizes.len())?;
    if !fraction.is_finite() {
        return None;
    }
    let before: f64 = sizes[..handle].iter().sum();
    let after = before + sizes[handle] + sizes[next_slot];
    let low = before + MIN_PANE;
    let high = after - MIN_PANE;
    if low > high {
        return None;
    }
    let boundary = fraction.clamp(low, high);
    let mut next = sizes;
    next[handle] = boundary - before;
    next[next_slot] = after - boundary;
    Some(next)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneDropSide {
    Left,
    Right,
    Top,
    Bottom,
    Center,
}

impl PaneDropSide {
    pub const EDGES: [PaneDropSide; 4] = [
        PaneDropSide::Left,
        PaneDropSide::Right,
        PaneDropSide::Top,
        PaneDropSide::Bottom,
    ];
    pub const ALL: [PaneDropSide; 5] = [
        PaneDropSide::Left,
        PaneDropSide::Right,
        PaneDropSide::Top,
        PaneDropSide::Bottom,
        PaneDropSide::Center,
    ];

    pub fn vertical(self) -> bool {
        matches!(self, PaneDropSide::Top | PaneDropSide::Bottom)
    }

    pub fn leading(self) -> bool {
        matches!(self, PaneDropSide::Left | PaneDropSide::Top)
    }

    pub fn glyph(self, stacked: bool) -> Icon {
        match self {
            PaneDropSide::Left => Icon::HalfLeft,
            PaneDropSide::Right => Icon::HalfRight,
            PaneDropSide::Top => Icon::HalfTop,
            PaneDropSide::Bottom => Icon::HalfBottom,
            PaneDropSide::Center if stacked => Icon::SwapVertical,
            PaneDropSide::Center => Icon::SwapHorizontal,
        }
    }

    pub fn label(self, short: bool) -> &'static str {
        match (self, short) {
            (PaneDropSide::Left, false) => "Add left split",
            (PaneDropSide::Right, false) => "Add right split",
            (PaneDropSide::Top, false) => "Add top split",
            (PaneDropSide::Bottom, false) => "Add bottom split",
            (PaneDropSide::Center, false) => "Swap panes",
            (PaneDropSide::Left, true) => "Left",
            (PaneDropSide::Right, true) => "Right",
            (PaneDropSide::Top, true) => "Top",
            (PaneDropSide::Bottom, true) => "Bottom",
            (PaneDropSide::Center, true) => "Swap",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PaneDrop {
    pub tab: TabId,
    pub side: PaneDropSide,
}

pub const EDGE_BAND_SHARE: f32 = 0.25;
pub const EDGE_BAND_MIN: f32 = 48.0;
pub const EDGE_BAND_MAX: f32 = 180.0;
pub const HELD_SLACK: f32 = 16.0;
pub const DROP_PREVIEW_INSET: f32 = 6.0;
pub const DROP_PREVIEW_RADIUS: f32 = 20.0;
pub const DROP_PREVIEW_FADE: Duration = Duration::from_millis(100);

fn edge_band(length: f32) -> f32 {
    (length * EDGE_BAND_SHARE)
        .clamp(EDGE_BAND_MIN, EDGE_BAND_MAX)
        .min(length / 2.0)
}

fn contains(rect: Rect, x: f32, y: f32) -> bool {
    x >= rect.x && x <= rect.right() && y >= rect.y && y <= rect.bottom()
}

pub fn pane_side_at(
    pane: Rect,
    x: f32,
    y: f32,
    sides: &[PaneDropSide],
    held: Option<PaneDropSide>,
) -> Option<PaneDropSide> {
    let mut best: Option<(PaneDropSide, f32)> = None;
    for side in sides.iter().copied().filter(|s| *s != PaneDropSide::Center) {
        let depth = match side {
            PaneDropSide::Left => x - pane.x,
            PaneDropSide::Right => pane.right() - x,
            PaneDropSide::Top => y - pane.y,
            _ => pane.bottom() - y,
        };
        let band = edge_band(if side.vertical() { pane.h } else { pane.w });
        if band <= 0.0 {
            continue;
        }
        let slack = match held {
            Some(h) if h == side => -HELD_SLACK,
            Some(PaneDropSide::Center) => HELD_SLACK,
            _ => 0.0,
        };
        let reach = (depth + slack) / band;
        if reach <= 1.0 && best.is_none_or(|(_, r)| reach < r) {
            best = Some((side, reach));
        }
    }
    best.map(|(side, _)| side).or_else(|| {
        sides
            .contains(&PaneDropSide::Center)
            .then_some(PaneDropSide::Center)
    })
}

pub fn pane_drop_target(
    panes: &[(TabId, Rect)],
    x: f32,
    y: f32,
    current: Option<&PaneDrop>,
    sides: &[PaneDropSide],
) -> Option<PaneDrop> {
    let (tab, pane) = panes.iter().find(|(_, pane)| contains(*pane, x, y))?;
    let held = current.filter(|c| &c.tab == tab).map(|c| c.side);
    pane_side_at(*pane, x, y, sides, held).map(|side| PaneDrop {
        tab: tab.clone(),
        side,
    })
}

pub fn drop_preview_rect(pane: Rect, side: PaneDropSide) -> Rect {
    let inset = DROP_PREVIEW_INSET;
    let whole = Rect::new(
        pane.x + inset,
        pane.y + inset,
        pane.w - inset * 2.0,
        pane.h - inset * 2.0,
    );
    match side {
        PaneDropSide::Center => whole,
        PaneDropSide::Top | PaneDropSide::Bottom => {
            let h = pane.h / 2.0 - inset * 1.5;
            let y = if side == PaneDropSide::Top {
                whole.y
            } else {
                pane.bottom() - inset - h
            };
            Rect::new(whole.x, y, whole.w, h)
        }
        _ => {
            let w = pane.w / 2.0 - inset * 1.5;
            let x = if side == PaneDropSide::Left {
                whole.x
            } else {
                pane.right() - inset - w
            };
            Rect::new(x, whole.y, w, whole.h)
        }
    }
}

pub fn stacked_panes(a: Rect, b: Rect) -> bool {
    let dy = (a.y + a.h / 2.0 - (b.y + b.h / 2.0)).abs();
    let dx = (a.x + a.w / 2.0 - (b.x + b.w / 2.0)).abs();
    dy > dx
}

pub struct DropRules {
    pub sides: &'static [PaneDropSide],
    pub candidates: Vec<(TabId, Rect)>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DropContext {
    pub droppable: HashSet<TabId>,
    pub recent: Vec<TabId>,
}

impl DropContext {
    pub fn new(state: &BrowserState, window: &BrowserWindow) -> Self {
        let mut tabs: Vec<_> = window
            .tab_ids
            .iter()
            .filter_map(|id| state.tab(id.as_str()))
            .filter(|t| t.profile_id == window.profile_id)
            .collect();
        tabs.sort_by_key(|t| std::cmp::Reverse(t.last_active_at));
        let recent: Vec<TabId> = tabs.into_iter().map(|t| t.id.clone()).collect();
        DropContext {
            droppable: recent.iter().cloned().collect(),
            recent,
        }
    }

    pub fn fallback_for(&self, dragged: &TabId) -> Option<&TabId> {
        self.recent.iter().find(|id| *id != dragged)
    }
}

pub fn drop_rules(
    ctx: &DropContext,
    panes: &[(TabId, Rect)],
    dragged: &TabId,
) -> Option<DropRules> {
    if !ctx.droppable.contains(dragged) {
        return None;
    }
    if let [(alone, rect)] = panes
        && alone == dragged
    {
        let fallback = ctx.fallback_for(dragged)?;
        return Some(DropRules {
            sides: &PaneDropSide::EDGES,
            candidates: vec![(fallback.clone(), *rect)],
        });
    }
    let own_pane = panes.len() > 1 && panes.iter().any(|(t, _)| t == dragged);
    if panes.len() >= 3 && !own_pane {
        return None;
    }
    let candidates: Vec<(TabId, Rect)> = panes
        .iter()
        .filter(|(t, _)| t != dragged)
        .cloned()
        .collect();
    (!candidates.is_empty()).then_some(DropRules {
        sides: if own_pane {
            &PaneDropSide::ALL
        } else {
            &PaneDropSide::EDGES
        },
        candidates,
    })
}

pub fn split_side(side: PaneDropSide) -> Option<SplitSide> {
    match side {
        PaneDropSide::Left => Some(SplitSide::Left),
        PaneDropSide::Right => Some(SplitSide::Right),
        PaneDropSide::Top => Some(SplitSide::Top),
        PaneDropSide::Bottom => Some(SplitSide::Bottom),
        PaneDropSide::Center => None,
    }
}

pub fn note_drop(dragged: &TabId, target: &PaneDrop, panes: &[(TabId, Rect)]) {
    let member = panes.iter().any(|(tab, _)| tab == dragged);
    match split_side(target.side) {
        None => ardia_telemetry::counts::count("split_pane_drag_swaps"),
        Some(_) if member => ardia_telemetry::counts::count("split_pane_drag_redocks"),
        Some(SplitSide::Top | SplitSide::Bottom) => {
            ardia_telemetry::counts::count("split_stacked_drops")
        }
        Some(_) => {}
    }
}

pub fn drop_actions(dragged: &TabId, target: &PaneDrop) -> Vec<Action> {
    match split_side(target.side) {
        None => vec![Action::SwapPanes {
            a: dragged.clone(),
            b: target.tab.clone(),
        }],
        Some(side) => vec![Action::DropIntoSplit {
            tab: dragged.clone(),
            anchor: target.tab.clone(),
            side,
        }],
    }
}

#[derive(Default)]
struct HeldDrop {
    dragged: Option<TabId>,
    target: Option<PaneDrop>,
    on_page: bool,
    landing: LandingPresence,
}

pub type Landing = (Rect, PaneDropSide, bool);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LandingPresence {
    shown: Option<Landing>,
    showing: bool,
    from: f32,
    since: Option<std::time::Instant>,
}

impl LandingPresence {
    pub fn aim(&mut self, landing: Option<Landing>, now: std::time::Instant) {
        let showing = landing.is_some();
        if showing != self.showing || self.since.is_none() && showing {
            self.from = self.appear(now);
            self.since = Some(now);
            self.showing = showing;
        }
        if let Some(landing) = landing {
            self.shown = Some(landing);
        }
    }

    pub fn appear(&self, now: std::time::Instant) -> f32 {
        let Some(since) = self.since else {
            return 0.0;
        };
        let t = (now.saturating_duration_since(since).as_secs_f32()
            / DROP_PREVIEW_FADE.as_secs_f32())
        .clamp(0.0, 1.0);
        let (to, eased) = if self.showing {
            (1.0, 1.0 - (1.0 - t).powi(3))
        } else {
            (0.0, t * t)
        };
        self.from + (to - self.from) * eased
    }

    pub fn visible(&self, now: std::time::Instant) -> Option<(Landing, f32)> {
        let appear = self.appear(now);
        if !self.showing && appear <= 0.0 {
            return None;
        }
        self.shown.map(|landing| (landing, appear))
    }

    pub fn moving(&self, now: std::time::Instant) -> bool {
        self.since
            .is_some_and(|since| now.saturating_duration_since(since) < DROP_PREVIEW_FADE)
    }
}

#[derive(IntoElement)]
struct PaneDropTargets {
    panes: Vec<(TabId, Rect)>,
    ctx: Arc<DropContext>,
    emit: crate::msg::Emit,
    window_key: String,
    tears_off: bool,
    area: Rect,
}

thread_local! {
    static STRIP_DRAGS: std::cell::RefCell<std::collections::HashMap<String, TabId>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

pub fn note_strip_drag(window: &str, tab: &TabId) {
    STRIP_DRAGS.with(|d| d.borrow_mut().insert(window.to_owned(), tab.clone()));
}

fn strip_drag(window: &str) -> Option<TabId> {
    STRIP_DRAGS.with(|d| d.borrow().get(window).cloned())
}

fn clear_strip_drag(window: &str) {
    STRIP_DRAGS.with(|d| d.borrow_mut().remove(window));
}

struct DropAim<'a> {
    ctx: &'a DropContext,
    panes: &'a [(TabId, Rect)],
    area: Rect,
    key: &'a str,
}

impl DropAim<'_> {
    fn apply(
        &self,
        held: &gpui::Entity<HeldDrop>,
        drag: TabId,
        (x, y): (f32, f32),
        cx: &mut App,
    ) -> bool {
        let (px_, py_) = (x - self.area.x, y - self.area.y);
        let inside = px_ >= 0.0 && py_ >= 0.0 && px_ <= self.area.w && py_ <= self.area.h;
        let rules = drop_rules(self.ctx, self.panes, &drag).filter(|_| inside);
        let on_page = rules.is_some();
        let next = rules.and_then(|rules| {
            let current = held.read(cx).target.clone();
            pane_drop_target(&rules.candidates, px_, py_, current.as_ref(), rules.sides)
        });
        let changed = {
            let now = held.read(cx);
            now.target != next || now.on_page != on_page || now.dragged.as_ref() != Some(&drag)
        };
        let paged = crate::sidebar::drag::note_page(self.key, on_page, next.is_some());
        if changed {
            held.update(cx, |held, cx| {
                held.dragged = Some(drag);
                held.target = next;
                held.on_page = on_page;
                cx.notify();
            });
        }
        changed || paged
    }
}

impl RenderOnce for PaneDropTargets {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let held = window.use_keyed_state("pane-drop-held", cx, |_, _| HeldDrop::default());
        let now = std::time::Instant::now();
        if !cx.has_active_drag() {
            clear_strip_drag(&self.window_key);
        }
        if !cx.has_active_drag()
            && (held.read(cx).dragged.is_some() || held.read(cx).target.is_some())
        {
            held.update(cx, |held, _| {
                held.dragged = None;
                held.target = None;
                held.on_page = false;
            });
        }
        if cx.has_active_drag()
            && held.read(cx).dragged.is_none()
            && let Some(drag) = crate::sidebar::drag::live_drag(&self.window_key)
                .or_else(|| strip_drag(&self.window_key))
        {
            let pointer = window.mouse_position();
            let aim = DropAim {
                ctx: &self.ctx,
                panes: &self.panes,
                area: self.area,
                key: &self.window_key,
            };
            if aim.apply(&held, drag, crate::scale::logical_point(pointer), cx) {
                window.refresh();
            }
        }
        let landing = {
            let now = held.read(cx);
            now.target.clone().and_then(|target| {
                let rules = now
                    .dragged
                    .as_ref()
                    .and_then(|d| drop_rules(&self.ctx, &self.panes, d))?;
                let pane = rules.candidates.iter().find(|(t, _)| *t == target.tab)?.1;
                let from = now
                    .dragged
                    .as_ref()
                    .filter(|_| self.panes.len() > 1)
                    .and_then(|d| self.panes.iter().find(|(t, _)| t == d))
                    .map(|(_, r)| *r);
                Some((
                    drop_preview_rect(pane, target.side),
                    target.side,
                    from.is_some_and(|from| stacked_panes(from, pane)),
                ))
            })
        };
        let shown = held.update(cx, |held, _| {
            held.landing.aim(landing, now);
            held.landing.visible(now)
        });
        if held.read(cx).landing.moving(now) {
            window.request_animation_frame();
        }
        let panes = self.panes.clone();
        let move_ctx = Arc::clone(&self.ctx);
        let move_held = held.clone();
        let drop_held = held.clone();
        let drop_ctx = Arc::clone(&self.ctx);
        let drop_panes = self.panes.clone();
        let emit = self.emit.clone();
        let move_key = self.window_key.clone();
        let tears_off = self.tears_off;
        let area = self.area;
        let dragging = cx.has_active_drag();
        div()
            .id("pane-drop-targets")
            .absolute()
            .inset_0()
            .when(dragging, |this| {
                this.on_drag_move(move |event: &DragMoveEvent<TabDrag>, window, cx| {
                    let drag = event.drag(cx).tab.clone();
                    let at = crate::scale::logical_point(event.event.position);
                    let aim = DropAim {
                        ctx: &move_ctx,
                        panes: &panes,
                        area,
                        key: &move_key,
                    };
                    if aim.apply(&move_held, drag, at, cx) {
                        window.refresh();
                    }
                })
                .on_drop(move |drag: &TabDrag, window, cx| {
                    let (target, on_page) = {
                        let held = drop_held.read(cx);
                        (held.target.clone(), held.on_page)
                    };
                    drop_held.update(cx, |held, _| {
                        held.dragged = None;
                        held.target = None;
                        held.on_page = false;
                    });
                    let actions = target
                        .filter(|_| drop_rules(&drop_ctx, &drop_panes, &drag.tab).is_some())
                        .map(|target| {
                            note_drop(&drag.tab, &target, &drop_panes);
                            drop_actions(&drag.tab, &target)
                        })
                        .unwrap_or_default();
                    crate::primitives::haptics::tick_for_swaps(&actions);
                    if !actions.is_empty() {
                        emit.send(Msg::Stores(actions), window, cx);
                    } else if on_page && tears_off && drop_ctx.recent.len() > 1 {
                        emit.send(
                            Msg::MoveTabsToWindow {
                                tabs: vec![drag.tab.clone()],
                                window: None,
                            },
                            window,
                            cx,
                        );
                    }
                })
            })
            .when_some(shown, |this, ((rect, side, stacked), appear)| {
                this.child(drop_preview(rect, side, stacked).opacity(appear))
            })
    }
}

pub fn drop_preview(rect: Rect, side: PaneDropSide, stacked: bool) -> gpui::Stateful<gpui::Div> {
    let short = rect.w < 160.0;
    let labelled = rect.w >= 96.0 && rect.h >= 40.0;
    div()
        .id("pane-drop-preview")
        .debug_selector(|| "pane-drop-preview".into())
        .absolute()
        .left(px(rect.x))
        .top(px(rect.y))
        .w(px(rect.w))
        .h(px(rect.h))
        .rounded(px(DROP_PREVIEW_RADIUS))
        .bg(gpui::Rgba {
            r: 18.0 / 255.0,
            g: 20.0 / 255.0,
            b: 28.0 / 255.0,
            a: 0.58,
        })
        .border(px(1.5))
        .border_color(gpui::white().opacity(0.85))
        .shadow(vec![crate::primitives::controls::shadow(
            gpui::black().opacity(0.3),
            2.,
            12.,
        )])
        .flex()
        .items_center()
        .justify_center()
        .px(px(12.))
        .child(
            div()
                .w(px(22.))
                .h(px(18.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(side.glyph(stacked), 16., gpui::white())),
        )
        .when(labelled, |this| {
            this.child(
                div()
                    .ml(px(6.))
                    .min_w_0()
                    .truncate()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(gpui::white())
                    .child(side.label(short)),
            )
        })
}

pub fn card_panes(panes: Vec<(TabId, Rect)>, toolbar: f32) -> Vec<(TabId, Rect)> {
    panes
        .into_iter()
        .map(|(tab, rect)| {
            let rect = if rect.y <= 0.5 {
                Rect::new(rect.x, 0.0, rect.w, rect.h + rect.y + toolbar)
            } else {
                Rect::new(rect.x, rect.y + toolbar, rect.w, rect.h)
            };
            (tab, rect)
        })
        .collect()
}

pub fn page_drop_targets(c: &Chrome, panes: Vec<(TabId, Rect)>) -> AnyElement {
    let toolbar = c.layout.toolbar.max(0.0);
    let page = c.layout.page();
    div()
        .absolute()
        .left_0()
        .top(px(-toolbar))
        .w(px(page.w))
        .h(px(page.h + toolbar))
        .child(card_drop_targets(c, card_panes(panes, toolbar)))
        .into_any_element()
}

fn card_drop_targets(c: &Chrome, panes: Vec<(TabId, Rect)>) -> AnyElement {
    let ctx = DropContext::new(c.state, c.window);
    let page = c.layout.page();
    let toolbar = c.layout.toolbar.max(0.0);
    PaneDropTargets {
        panes,
        ctx: Arc::new(ctx),
        emit: c.emit.clone(),
        window_key: c.window.id.as_str().to_owned(),
        tears_off: c.window.kind != ardia_state::windows::WindowKind::Incognito,
        area: Rect::new(page.x, page.y - toolbar, page.w, page.h + toolbar),
    }
    .into_any_element()
}

pub fn focus_ring_corners(
    ring: Rect,
    window: [f32; 2],
    framed: bool,
    radius: f32,
    outset: f32,
) -> gpui::Corners<f32> {
    if framed {
        let r = if radius > 0.0 { radius + outset } else { 0.0 };
        return gpui::Corners {
            top_left: r,
            top_right: r,
            bottom_left: r,
            bottom_right: r,
        };
    }
    let r = crate::window::layout::WINDOW_CORNER_RADIUS;
    let touches = |a: f32, b: f32| (a - b).abs() < 0.5;
    let left = touches(ring.x, 0.0);
    let top = touches(ring.y, 0.0);
    let right = touches(ring.x + ring.w, window[0]);
    let bottom = touches(ring.y + ring.h, window[1]);
    let at = |a: bool, b: bool| if a && b { r } else { 0.0 };
    gpui::Corners {
        top_left: at(left, top),
        top_right: at(right, top),
        bottom_left: at(left, bottom),
        bottom_right: at(right, bottom),
    }
}

pub fn focus_ring_metrics(gap: f32, framed: bool) -> (f32, f32) {
    let room = if framed { gap / 2.0 } else { 0.0 };
    let width = if framed {
        FOCUS_RING_WIDTH.min(room)
    } else {
        FOCUS_RING_WIDTH
    };
    let outset = (FOCUS_RING_WIDTH + FOCUS_RING_GAP).min(room);
    (width, outset)
}

pub fn card_fill(
    card: gpui::Stateful<gpui::Div>,
    c: &Chrome,
    rect: Rect,
    fill: Hsla,
) -> gpui::Stateful<gpui::Div> {
    let split = c.active.and_then(|tab| c.state.split_of(tab.id.as_str()));
    let Some(split) = split else {
        return card.bg(fill);
    };
    let radius = c.layout.frame.radius;
    let toolbar = c.layout.toolbar.max(0.0);
    let page_h = (rect.h - toolbar).max(0.0);
    let panes = card_panes(
        pane_rects(split, rect.w, page_h, c.layout.frame.split_gap),
        toolbar,
    );
    card.children(panes.into_iter().map(|(tab, pane)| {
        div()
            .id(SharedString::from(format!("pane-card:{tab}")))
            .absolute()
            .left(px(pane.x))
            .top(px(pane.y))
            .w(px(pane.w))
            .h(px(pane.h))
            .rounded(px(radius))
            .bg(fill)
    }))
}

fn handle_drag_start(split: &SplitId, divider: DividerKind, sizes: Vec<f64>, pointer: f32) {
    HANDLE_GRAB.with(|grab| {
        *grab.borrow_mut() = Some(HandleGrab {
            split: split.clone(),
            divider,
            sizes,
            pointer,
        });
    });
}

fn handle_drag_grab(split: &SplitId, divider: DividerKind) -> Option<(Vec<f64>, f32)> {
    HANDLE_GRAB.with(|grab| {
        grab.borrow()
            .as_ref()
            .filter(|g| &g.split == split && g.divider == divider)
            .map(|g| (g.sizes.clone(), g.pointer))
    })
}

fn divider_handle(
    c: &Chrome,
    split: &SplitView,
    divider: Divider,
    page: Rect,
    mark: Hsla,
) -> gpui::Stateful<gpui::Div> {
    let gap = c.layout.frame.split_gap;
    let rect = handle_rect(&divider);
    let vertical = divider.vertical;
    let kind = divider.kind;
    let key = match kind {
        DividerKind::Root(index) => index,
        DividerKind::Stack => usize::MAX,
    };
    let group = SharedString::from(format!("split-handle-{key}"));
    let drag = SplitHandleDrag {
        split: split.id.clone(),
        divider: kind,
    };
    let start_split = split.id.clone();
    let start_sizes = divider_sizes(split, kind);
    let move_split = split.id.clone();
    let even_split = split.clone();
    let emit = c.emit.clone();
    let even_emit = c.emit.clone();
    let origin = if vertical {
        page.x + rect.x
    } else {
        page.y + rect.y
    };
    let total = if vertical { page.w } else { page.h };
    div()
        .id(("split-handle", key))
        .debug_selector(move || match kind {
            DividerKind::Root(index) => format!("split-handle-{index}"),
            DividerKind::Stack => "split-handle-stack".to_owned(),
        })
        .group(group.clone())
        .absolute()
        .left(px(rect.x))
        .top(px(rect.y))
        .w(px(rect.w))
        .h(px(rect.h))
        .flex()
        .items_center()
        .justify_center()
        .cursor(if vertical {
            CursorStyle::ResizeLeftRight
        } else {
            CursorStyle::ResizeUpDown
        })
        .child(
            div()
                .id(("split-handle-mark", key))
                .w(px(if vertical {
                    HANDLE_THICKNESS
                } else {
                    HANDLE_LENGTH
                }))
                .h(px(if vertical {
                    HANDLE_LENGTH
                } else {
                    HANDLE_THICKNESS
                }))
                .rounded_full()
                .bg(mark)
                .opacity(0.0)
                .group_hover(group.clone(), |style| style.opacity(HANDLE_HOVER_OPACITY))
                .group_active(group, |style| style.opacity(HANDLE_DRAG_OPACITY)),
        )
        .on_click(move |event, window, cx| {
            if event.click_count() != 2 {
                return;
            }
            if let Some(action) = evened(&even_split, kind) {
                ardia_telemetry::counts::count("split_divider_resets");
                even_emit.send(Msg::Store(action), window, cx);
            }
        })
        .on_drag(drag, move |_, offset, _, cx| {
            let (x, y) = crate::scale::logical_point(offset);
            let pointer = origin + if vertical { x } else { y };
            handle_drag_start(&start_split, kind, start_sizes.clone(), pointer);
            cx.new(|_| EmptyDrag)
        })
        .on_drag_move(move |event: &DragMoveEvent<SplitHandleDrag>, window, cx| {
            let drag = event.drag(cx).clone();
            if drag.divider != kind || drag.split != move_split {
                return;
            }
            let Some((sizes, pointer)) = handle_drag_grab(&drag.split, kind) else {
                return;
            };
            let (x, y) = crate::scale::logical_point(event.event.position);
            let delta = if vertical { x } else { y } - pointer;
            if let Some(action) = dragged(&drag.split, kind, &sizes, delta, total, gap) {
                emit.send(Msg::Store(action), window, cx);
            }
        })
}

pub fn split_view(
    c: &Chrome,
    split: &SplitView,
    page: Rect,
    radius: f32,
    panes: Vec<(TabId, Rect, AnyElement)>,
) -> AnyElement {
    let p = c.p;
    let ring: Hsla = c
        .look
        .theme
        .power_up_color
        .map_or(p.accent, crate::primitives::theme_bridge::hsla);
    let toolbar = c.layout.toolbar.max(0.0);
    let framed = c.layout.frame.inset > 0.0;
    let window_size = [c.layout.width, c.layout.height];
    let gap = c.layout.frame.split_gap;
    let (ring_width, outset) = focus_ring_metrics(gap, framed);
    let dividers = split_geometry(split, page.w, page.h, gap).1;
    let rects: Vec<(TabId, Rect)> = panes.iter().map(|(t, r, _)| (t.clone(), *r)).collect();
    let active_rect = rects.iter().find(|(t, _)| c.is_active(t)).map(|(_, r)| *r);
    let mark = p.mark;
    div()
        .id("split-view")
        .debug_selector(|| "split-view".into())
        .absolute()
        .left(px(page.x))
        .top(px(page.y))
        .w(px(page.w))
        .h(px(page.h))
        .children(panes.into_iter().map(|(tab, rect, content)| {
            let emit = c.emit.clone();
            let focus = tab.clone();
            div()
                .id(SharedString::from(format!("pane:{tab}")))
                .group(PANE_GROUP)
                .absolute()
                .left(px(rect.x))
                .top(px(rect.y))
                .w(px(rect.w))
                .h(px(rect.h))
                .rounded_b(px(radius))
                .when(rect.y > 0.5 || toolbar <= 0.0, |this| {
                    this.rounded_t(px(radius))
                })
                .overflow_hidden()
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    emit.send(
                        Msg::Store(Action::ActivateTab { tab: focus.clone() }),
                        window,
                        cx,
                    );
                })
                .child(crate::content::toolbar::lower_pane(c, &tab, rect, content))
        }))
        .children(
            dividers
                .into_iter()
                .map(|divider| divider_handle(c, split, divider, page, mark)),
        )
        .when_some(active_rect, |this, rect| {
            let pane = card_panes(vec![(TabId::new(""), rect)], toolbar)[0].1;
            let pane = Rect::new(pane.x, pane.y - toolbar, pane.w, pane.h);
            let ring_box = Rect::new(
                pane.x - outset,
                pane.y - outset,
                pane.w + 2.0 * outset,
                pane.h + 2.0 * outset,
            );
            let corners = focus_ring_corners(
                Rect::new(
                    page.x + ring_box.x,
                    page.y + ring_box.y,
                    ring_box.w,
                    ring_box.h,
                ),
                window_size,
                framed,
                radius,
                outset,
            );
            this.child(
                div()
                    .id("split-focus-ring")
                    .debug_selector(|| "split-focus-ring".into())
                    .absolute()
                    .left(px(ring_box.x))
                    .top(px(ring_box.y))
                    .w(px(ring_box.w))
                    .h(px(ring_box.h))
                    .rounded_tl(px(corners.top_left))
                    .rounded_tr(px(corners.top_right))
                    .rounded_bl(px(corners.bottom_left))
                    .rounded_br(px(corners.bottom_right))
                    .border(px(ring_width))
                    .border_color(ring),
            )
        })
        .child(page_drop_targets(c, rects.clone()))
        .child(crate::content::pane_drag::pane_drag_layer(
            rects,
            page,
            [c.layout.width, c.layout.height],
            Arc::new(DropContext::new(c.state, c.window)),
            c.emit.clone(),
            c.active
                .map(|tab| crate::content::drag_card::DragCard::new(c, &tab.id)),
        ))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::WindowId;
    use ardia_state::splits::even_slots;

    fn two() -> SplitView {
        SplitView::new(
            SplitId::new("s"),
            WindowId::new("w"),
            Orientation::Horizontal,
            even_slots(&[TabId::new("a"), TabId::new("b")]),
        )
    }

    #[test]
    fn panes_share_the_page_with_a_gap_between_them() {
        let rects = pane_rects(&two(), 1000.0, 600.0, 9.0);
        assert_eq!(rects.len(), 2);
        assert_eq!(rects[0].1, Rect::new(0.0, 0.0, 496.0, 600.0));
        assert_eq!(rects[1].1, Rect::new(505.0, 0.0, 495.0, 600.0));
        let handles = handle_rects(&two(), 1000.0, 600.0, 9.0);
        assert_eq!(handles, vec![(0, Rect::new(494.0, 0.0, 13.0, 600.0))]);
    }

    #[test]
    fn panes_snap_to_whole_points_like_the_old_cut() {
        let rects = pane_rects(&two(), 1274.5, 851.0, 4.0);
        assert_eq!(rects[0].1, Rect::new(0.0, 0.0, 635.0, 851.0));
        assert_eq!(rects[1].1, Rect::new(639.0, 0.0, 635.5, 851.0));
    }

    #[test]
    fn a_stack_gets_its_own_divider() {
        let split = SplitView::new(
            SplitId::new("s"),
            WindowId::new("w"),
            Orientation::Horizontal,
            vec![
                SplitSlot::Pane {
                    size: 0.5,
                    tab_id: TabId::new("a"),
                },
                SplitSlot::Stack {
                    size: 0.5,
                    stack: [TabId::new("b"), TabId::new("c")],
                    stack_sizes: [0.5, 0.5],
                },
            ],
        );
        let (panes, dividers) = split_geometry(&split, 1000.0, 600.0, 4.0);
        assert_eq!(panes[1].1, Rect::new(502.0, 0.0, 498.0, 298.0));
        assert_eq!(panes[2].1, Rect::new(502.0, 302.0, 498.0, 298.0));
        assert_eq!(
            dividers,
            vec![
                Divider {
                    kind: DividerKind::Root(0),
                    rect: Rect::new(498.0, 0.0, 4.0, 600.0),
                    vertical: true,
                },
                Divider {
                    kind: DividerKind::Stack,
                    rect: Rect::new(502.0, 298.0, 498.0, 4.0),
                    vertical: false,
                },
            ]
        );
        assert_eq!(
            evened(&split, DividerKind::Stack),
            Some(Action::RestackSplit {
                split: SplitId::new("s"),
                stack_sizes: [0.5, 0.5],
            })
        );
    }

    #[test]
    fn dragging_a_divider_follows_the_pointer_and_keeps_220_points() {
        let sizes = resize_shares(&[0.5, 0.5], 0, 100.0, 1004.0, 4.0).expect("resizes");
        assert!((sizes[0] - 0.6).abs() < 1e-9, "{sizes:?}");
        let clamped = resize_shares(&[0.5, 0.5], 0, 900.0, 1004.0, 4.0).expect("resizes");
        assert!((clamped[1] - 0.22).abs() < 1e-9, "{clamped:?}");
        assert!(resize_shares(&[0.5, 0.5], 1, 10.0, 1004.0, 4.0).is_none());
        assert!(resize_shares(&[0.5, 0.5], 0, f32::NAN, 1004.0, 4.0).is_none());
    }

    #[test]
    fn the_focus_ring_is_round_all_round_in_a_frame_and_follows_the_window_without_one() {
        let framed = focus_ring_corners(
            Rect::new(10.0, 10.0, 100.0, 100.0),
            [800.0, 600.0],
            true,
            10.0,
            3.0,
        );
        assert_eq!(
            (
                framed.top_left,
                framed.top_right,
                framed.bottom_left,
                framed.bottom_right
            ),
            (13.0, 13.0, 13.0, 13.0)
        );
        let flush = focus_ring_corners(
            Rect::new(400.0, 0.0, 400.0, 600.0),
            [800.0, 600.0],
            false,
            0.0,
            0.0,
        );
        let r = crate::window::layout::WINDOW_CORNER_RADIUS;
        assert_eq!(
            (
                flush.top_left,
                flush.top_right,
                flush.bottom_left,
                flush.bottom_right
            ),
            (0.0, r, 0.0, r)
        );
    }

    #[test]
    fn drop_targets_cover_the_card_toolbar_included() {
        let panes = card_panes(
            vec![
                (TabId::new("a"), Rect::new(0.0, 0.0, 400.0, 300.0)),
                (TabId::new("b"), Rect::new(0.0, 309.0, 400.0, 291.0)),
            ],
            40.0,
        );
        assert_eq!(panes[0].1, Rect::new(0.0, 0.0, 400.0, 340.0));
        assert_eq!(panes[1].1, Rect::new(0.0, 349.0, 400.0, 291.0));
    }

    #[test]
    fn a_tab_dragged_over_its_own_page_splits_with_the_last_used_tab() {
        let ctx = DropContext {
            droppable: [TabId::new("a"), TabId::new("b"), TabId::new("c")]
                .into_iter()
                .collect(),
            recent: vec![TabId::new("a"), TabId::new("c"), TabId::new("b")],
        };
        let page = Rect::new(0.0, 0.0, 1000.0, 600.0);
        let rules = drop_rules(&ctx, &[(TabId::new("a"), page)], &TabId::new("a"))
            .expect("a fallback pane");
        assert_eq!(rules.candidates, vec![(TabId::new("c"), page)]);
        assert!(!rules.sides.contains(&PaneDropSide::Center));
        let alone = DropContext {
            droppable: [TabId::new("a")].into_iter().collect(),
            recent: vec![TabId::new("a")],
        };
        assert!(drop_rules(&alone, &[(TabId::new("a"), page)], &TabId::new("a")).is_none());
    }

    #[test]
    fn the_landing_fades_in_fast_and_out_on_its_own_curve() {
        let now = std::time::Instant::now();
        let mut presence = LandingPresence::default();
        let landing = (Rect::new(6.0, 6.0, 100.0, 100.0), PaneDropSide::Left, false);
        presence.aim(Some(landing), now);
        assert_eq!(presence.visible(now).map(|(_, a)| a), Some(0.0));
        let half = now + DROP_PREVIEW_FADE / 2;
        let rising = presence.visible(half).expect("shown").1;
        assert!(rising > 0.8 && rising < 1.0, "{rising}");
        let shown = now + DROP_PREVIEW_FADE;
        presence.aim(None, shown);
        let falling = presence
            .visible(shown + DROP_PREVIEW_FADE / 2)
            .expect("fading")
            .1;
        assert!((falling - 0.75).abs() < 0.01, "{falling}");
        assert!(presence.visible(shown + DROP_PREVIEW_FADE).is_none());
    }

    #[test]
    fn resizing_moves_one_boundary_and_keeps_a_minimum_pane() {
        let sizes = resized(&two(), 0, 0.7).expect("resizes");
        assert!((sizes[0] - 0.7).abs() < 1e-9 && (sizes[1] - 0.3).abs() < 1e-9);
        let clamped = resized(&two(), 0, 0.99).expect("resizes");
        assert!((clamped[1] - MIN_PANE).abs() < 1e-9);
        assert!(resized(&two(), 1, 0.5).is_none());
        assert!(resized(&two(), 0, f64::NAN).is_none());
        assert!(resized(&two(), usize::MAX, 0.5).is_none());
    }
}
