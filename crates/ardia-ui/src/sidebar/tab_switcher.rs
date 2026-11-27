use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::model::PageKind;
use ardia_state::settings::{TabSwitcherOrder, TabSwitcherView};
use ardia_state::tabs::Tab;
use ardia_state::{Action, BrowserState, Millis, TabId};
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, FontWeight, GlobalElementId, Hsla,
    InspectorElementId, IntoElement, KeyDownEvent, LayoutId, ModifiersChangedEvent, MouseButton,
    ParentElement, Pixels, SharedString, Styled, Window, div, prelude::*, rgba,
};

use crate::msg::{Emit, Msg};
use crate::primitives::controls::shadow;
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;

pub const COMMIT_ID: &str = "tabSwitcherCommit";
pub const MOUNT_AFTER: Duration = Duration::from_millis(70);
pub const SHOW_AFTER: Duration = Duration::from_millis(140);
pub const CARD: f32 = 168.0;
pub const SHOT_ASPECT: f32 = 1.6;
pub const GAP: f32 = 4.0;
pub const PAD: f32 = 8.0;
pub const LABEL: f32 = 30.0;
pub const LABEL_GAP: f32 = 6.0;
pub const LABEL_INSET: f32 = 2.0;
pub const CARD_INSET: f32 = 4.0;
pub const WINDOW_MARGIN: f32 = 80.0;
pub const MAX_CARDS: usize = 7;
pub const PANEL_RADIUS: f32 = 18.0;
pub const CARD_RADIUS: f32 = 12.0;
pub const PREVIEW_RADIUS: f32 = 8.0;
pub const RING_FOCUSED: f32 = 2.0;
pub const RING_REST: f32 = 1.0;
pub const ICON_PREVIEW: f32 = 30.0;
pub const ICON_LABEL: f32 = 13.0;
pub const ICON_GLOBE: f32 = 12.0;
pub const TITLE_SIZE: f32 = 12.0;
pub const LIST_WIDTH: f32 = 380.0;
pub const LIST_ROW: f32 = 40.0;
pub const LIST_MAX_ROWS: usize = 8;
pub const LIST_ICON: f32 = 16.0;
pub const LIST_GAP: f32 = 10.0;
pub const LIST_INSET: f32 = 10.0;
pub const LIST_LINE_GAP: f32 = 1.0;
pub const STALE_AFTER_MS: Millis = 12 * 60 * 60 * 1000;

pub fn shot_height() -> f32 {
    (CARD / SHOT_ASPECT).round()
}

pub fn row_height() -> f32 {
    shot_height() + LABEL + 2.0 * CARD_INSET
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PanelSize {
    pub count: usize,
    pub viewport: f32,
    pub width: f32,
    pub height: f32,
}

pub fn panel_size(list: bool, items: usize, window_width: f32, window_height: f32) -> PanelSize {
    let fits = if list {
        ((window_height - WINDOW_MARGIN - 2.0 * PAD) / LIST_ROW)
            .floor()
            .max(1.0) as usize
    } else {
        ((window_width - WINDOW_MARGIN - 2.0 * PAD + GAP) / (CARD + GAP))
            .floor()
            .max(1.0) as usize
    };
    let count = fits
        .min(if list { LIST_MAX_ROWS } else { MAX_CARDS })
        .min(items)
        .max(1);
    let viewport = if list {
        count as f32 * LIST_ROW
    } else {
        count as f32 * CARD + (count as f32 - 1.0) * GAP
    };
    let width = if list {
        LIST_WIDTH.min(window_width - WINDOW_MARGIN)
    } else {
        2.0 * PAD + viewport
    };
    let height = 2.0 * PAD + if list { viewport } else { row_height() };
    PanelSize {
        count,
        viewport,
        width,
        height,
    }
}

pub fn revealed_offset(index: usize, offset: f32, viewport: f32, size: f32, stride: f32) -> f32 {
    let left = index as f32 * stride;
    let right = left + size;
    if left < offset {
        left
    } else if right > offset + viewport {
        right - viewport
    } else {
        offset
    }
}

pub fn is_light(color: [f32; 3]) -> bool {
    let luminance = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2];
    luminance > 0.5
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SwitcherColors {
    pub fill: u32,
    pub focus_fill: u32,
    pub rest_ring: u32,
    pub blank_fill: u32,
    pub on_panel: u32,
    pub on_page: u32,
    pub on_dark: u32,
    pub title: u32,
}

pub fn switcher_colors(dark: bool) -> SwitcherColors {
    if dark {
        SwitcherColors {
            fill: 0x1C1C1EF2,
            focus_fill: 0xFFFFFF24,
            rest_ring: 0xFFFFFF1F,
            blank_fill: 0x3A3A3CFF,
            on_panel: 0xFFFFFFB3,
            on_page: 0x000000A6,
            on_dark: 0xFFFFFFB3,
            title: 0xFFFFFFFF,
        }
    } else {
        SwitcherColors {
            fill: 0xF2F2F7F2,
            focus_fill: 0x0000002E,
            rest_ring: 0x0000001A,
            blank_fill: 0xD1D1D6FF,
            on_panel: 0x000000A6,
            on_page: 0x000000A6,
            on_dark: 0xFFFFFFB3,
            title: 0x000000D9,
        }
    }
}

fn switchable(tab: &Tab) -> bool {
    tab.page.kind != PageKind::Asleep
}

fn append<'a>(
    root: &'a Tab,
    available: &HashMap<&TabId, &'a Tab>,
    children: &HashMap<TabId, Vec<&'a Tab>>,
    ordered: &mut Vec<&'a Tab>,
    seen: &mut HashSet<TabId>,
) {
    let mut stack = vec![root];
    while let Some(t) = stack.pop() {
        let Some(own) = available.get(&t.id).copied() else {
            continue;
        };
        if !seen.insert(own.id.clone()) {
            continue;
        }
        ordered.push(own);
        if let Some(next) = children.get(&own.id) {
            for child in next.iter().rev() {
                stack.push(child);
            }
        }
    }
}

pub fn recent_tab_ids(state: &BrowserState, window: &str, now: Millis) -> Vec<TabId> {
    let current = state.active_tab(window).map(|t| t.id.clone());
    let open: Vec<&Tab> = state
        .view_tabs(window, None)
        .into_iter()
        .map(|t| t.as_ref())
        .filter(|t| switchable(t) || Some(&t.id) == current.as_ref())
        .collect();
    let place: HashMap<&TabId, usize> = open
        .iter()
        .copied()
        .enumerate()
        .map(|(i, t)| (&t.id, i))
        .collect();
    let newer = |a: &&Tab, b: &&Tab| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| place[&b.id].cmp(&place[&a.id]))
    };
    let available: HashMap<&TabId, &Tab> = open.iter().copied().map(|t| (&t.id, t)).collect();
    let mut children: HashMap<TabId, Vec<&Tab>> = HashMap::new();
    let mut loose: Vec<&Tab> = Vec::new();
    for t in &open {
        if Some(&t.id) == current.as_ref() || !t.unseen {
            continue;
        }
        let parent = t
            .opener_id
            .as_ref()
            .filter(|o| **o != t.id)
            .and_then(|o| available.get(o));
        match parent {
            Some(parent) => children.entry(parent.id.clone()).or_default().push(t),
            None => loose.push(t),
        }
    }
    for list in children.values_mut() {
        list.sort_by(newer);
    }
    loose.sort_by(newer);
    let mut recent: Vec<&Tab> = open
        .iter()
        .copied()
        .filter(|t| Some(&t.id) != current.as_ref() && !t.unseen)
        .collect();
    recent.sort_by(|a, b| {
        b.last_active_at
            .cmp(&a.last_active_at)
            .then_with(|| newer(a, b))
    });
    let mut ordered: Vec<&Tab> = Vec::new();
    let mut seen: HashSet<TabId> = HashSet::new();
    if let Some(active) = current.as_ref().and_then(|c| available.get(c)) {
        append(active, &available, &children, &mut ordered, &mut seen);
    }
    for t in &recent {
        append(t, &available, &children, &mut ordered, &mut seen);
    }
    for t in &loose {
        append(t, &available, &children, &mut ordered, &mut seen);
    }
    let mut all = open.clone();
    all.sort_by(newer);
    for t in all {
        append(t, &available, &children, &mut ordered, &mut seen);
    }
    ordered
        .into_iter()
        .enumerate()
        .filter(|(i, t)| *i < 2 || now - t.last_active_at < STALE_AFTER_MS)
        .map(|(_, t)| t.id.clone())
        .collect()
}

pub fn session_tab_ids(
    state: &BrowserState,
    window: &str,
    session_start: Millis,
    now: Millis,
) -> Vec<TabId> {
    let active = state.active_tab(window).map(|t| t.id.clone());
    let recent = recent_tab_ids_unfiltered(state, window);
    let started = |id: &TabId| {
        state
            .tab(id.as_str())
            .is_some_and(|t| t.last_active_at >= session_start || t.created_at >= session_start)
    };
    let from_session: Vec<TabId> = recent
        .iter()
        .filter(|id| Some(*id) == active.as_ref() || started(id))
        .cloned()
        .collect();
    if from_session.len() >= 2 {
        return from_session;
    }
    recent
        .into_iter()
        .enumerate()
        .filter(|(i, id)| {
            *i < 2
                || state
                    .tab(id.as_str())
                    .is_some_and(|t| now - t.last_active_at < STALE_AFTER_MS)
        })
        .map(|(_, id)| id)
        .collect()
}

fn recent_tab_ids_unfiltered(state: &BrowserState, window: &str) -> Vec<TabId> {
    recent_tab_ids(state, window, Millis::MIN / 4)
}

pub fn in_order_tab_ids(state: &BrowserState, window: &str) -> Vec<TabId> {
    let active = state.active_tab(window).map(|t| t.id.clone());
    let sections = crate::sidebar::model::sections(state, window);
    let mut stops: Vec<TabId> = Vec::new();
    let mut groups_seen: HashSet<ardia_state::GroupId> = HashSet::new();
    for id in sections.ordered_tabs() {
        let Some(tab) = state.tab(id.as_str()) else {
            continue;
        };
        if Some(&id) != active.as_ref() && !switchable(tab) {
            continue;
        }
        if stops.contains(&id) {
            continue;
        }
        let owner = ardia_state::groups::innermost_group_of(&state.groups, id.as_str())
            .and_then(|g| state.groups.get(&g).cloned())
            .filter(|g| g.collapsed);
        let Some(group) = owner else {
            stops.push(id);
            continue;
        };
        if !groups_seen.insert(group.id.clone()) {
            continue;
        }
        let members: Vec<&Tab> = group
            .tab_ids
            .iter()
            .filter_map(|t| state.tab(t.as_str()).map(|t| t.as_ref()))
            .filter(|t| Some(&t.id) == active.as_ref() || switchable(t))
            .collect();
        let stop = if active
            .as_ref()
            .is_some_and(|a| members.iter().any(|m| m.id == *a))
        {
            active.clone()
        } else {
            members
                .iter()
                .max_by_key(|t| t.last_active_at)
                .map(|t| t.id.clone())
        };
        if let Some(stop) = stop
            && !stops.contains(&stop)
        {
            stops.push(stop);
        }
    }
    stops
}

pub fn step_from(ids: &[TabId], from: Option<&TabId>, delta: i32) -> usize {
    let n = ids.len() as i64;
    if n == 0 {
        return 0;
    }
    match from.and_then(|f| ids.iter().position(|id| id == f)) {
        Some(at) => (at as i64 + i64::from(delta)).rem_euclid(n) as usize,
        None if delta > 0 => 0,
        None => (n - 1) as usize,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Switcher {
    pub ids: Vec<TabId>,
    pub index: usize,
    pub view: TabSwitcherView,
    pub opened: Instant,
    pub offset: f32,
    pub hovered: Option<usize>,
    pub pointer_moved: bool,
}

impl Switcher {
    pub fn visible(&self, now: Instant) -> bool {
        self.view != TabSwitcherView::None
            && now.saturating_duration_since(self.opened) >= SHOW_AFTER
    }

    pub fn chosen(&self, now: Instant) -> Option<&TabId> {
        let pointed = self
            .hovered
            .filter(|_| self.visible(now) && self.pointer_moved)
            .filter(|i| *i < self.ids.len());
        self.ids.get(pointed.unwrap_or(self.index))
    }
}

thread_local! {
    static SWITCHERS: RefCell<HashMap<String, Switcher>> = RefCell::new(HashMap::new());
    static SESSION_START: Millis = ardia_state::store::now_ms();
}

pub fn is_open(window: &str) -> bool {
    SWITCHERS.with(|s| s.borrow().contains_key(window))
}

pub enum Step {
    Activate(TabId),
    Opened,
    Moved,
    Nothing,
}

pub fn step(state: &BrowserState, window: &str, backward: bool, now: Instant) -> Step {
    let delta = if backward { -1 } else { 1 };
    let moved = SWITCHERS.with(|s| {
        let mut s = s.borrow_mut();
        let open = s.get_mut(window)?;
        let n = open.ids.len().max(1) as i64;
        open.index = (open.index as i64 + i64::from(delta)).rem_euclid(n) as usize;
        open.pointer_moved = false;
        Some(())
    });
    if moved.is_some() {
        return Step::Moved;
    }
    let order = state.settings.tab_switcher_order;
    let view = state.settings.tab_switcher_view;
    ardia_telemetry::counts::count(if order == TabSwitcherOrder::Recent {
        "tab_switcher_uses_recent"
    } else {
        "tab_switcher_uses_in_order"
    });
    ardia_telemetry::counts::count(match view {
        TabSwitcherView::Thumbnails => "tab_switcher_uses_thumbnails",
        TabSwitcherView::CompactList => "tab_switcher_uses_compact_list",
        TabSwitcherView::None => "tab_switcher_uses_no_view",
    });
    let active = state.active_tab(window).map(|t| t.id.clone());
    if order == TabSwitcherOrder::InOrder && view == TabSwitcherView::None {
        let ids = in_order_tab_ids(state, window);
        let next = ids.get(step_from(&ids, active.as_ref(), delta)).cloned();
        return match next.filter(|n| Some(n) != active.as_ref()) {
            Some(next) => Step::Activate(next),
            None => Step::Nothing,
        };
    }
    let wall = ardia_state::store::now_ms();
    let ids = if order == TabSwitcherOrder::Recent {
        session_tab_ids(state, window, SESSION_START.with(|s| *s), wall)
    } else {
        in_order_tab_ids(state, window)
    };
    if ids.len() == 1 && Some(&ids[0]) != active.as_ref() {
        return Step::Activate(ids[0].clone());
    }
    if ids.len() < 2 {
        return Step::Nothing;
    }
    note_opened(state, window, &ids);
    let index = if order == TabSwitcherOrder::Recent {
        if backward { ids.len() - 1 } else { 1 }
    } else {
        step_from(&ids, active.as_ref(), delta)
    };
    SWITCHERS.with(|s| {
        s.borrow_mut().insert(
            window.to_owned(),
            Switcher {
                ids,
                index,
                view,
                opened: now,
                offset: f32::NAN,
                hovered: None,
                pointer_moved: false,
            },
        )
    });
    Step::Opened
}

fn note_opened(state: &BrowserState, window: &str, ids: &[TabId]) {
    let closed_left_out = state.window(window).map_or(0, |w| {
        w.tab_ids
            .iter()
            .filter_map(|id| state.tab(id.as_str()))
            .filter(|tab| tab.profile_id == w.profile_id && tab.page.is_asleep())
            .count()
    });
    let unseen_last = ids
        .iter()
        .take(2)
        .filter(|id| state.tab(id.as_str()).is_some_and(|tab| tab.unseen))
        .count();
    ardia_telemetry::counts::count("tab_switcher_opens");
    ardia_telemetry::counts::add("tab_switcher_closed_left_out", closed_left_out as u64);
    ardia_telemetry::counts::add("tab_switcher_unseen_last", unseen_last as u64);
}

pub fn commit(state: &BrowserState, window: &str, index: Option<usize>) -> Option<TabId> {
    let now = Instant::now();
    let open = SWITCHERS.with(|s| s.borrow_mut().remove(window))?;
    if !open.visible(now) && open.view != TabSwitcherView::None {
        ardia_telemetry::counts::count("tab_switcher_quick_switches");
    }
    let id = match index {
        Some(i) => open.ids.get(i).cloned(),
        None => open.chosen(now).cloned(),
    }?;
    let active = state.active_tab(window).map(|t| t.id.clone());
    let present = state
        .view_tabs(window, None)
        .iter()
        .any(|t| t.id == id && (switchable(t) || Some(&t.id) == active.as_ref()));
    (present && Some(&id) != active.as_ref()).then_some(id)
}

pub fn cancel(window: &str) {
    SWITCHERS.with(|s| s.borrow_mut().remove(window));
}

fn sync_tabs(state: &BrowserState, window: &str) {
    SWITCHERS.with(|s| {
        let mut s = s.borrow_mut();
        let Some(open) = s.get_mut(window) else {
            return;
        };
        let present: HashSet<TabId> = state
            .view_tabs(window, None)
            .into_iter()
            .map(|t| t.id.clone())
            .collect();
        if open.ids.iter().all(|id| present.contains(id)) {
            return;
        }
        let selected = open.ids.get(open.index).cloned();
        open.ids.retain(|id| present.contains(id));
        if open.ids.is_empty() {
            s.remove(window);
            return;
        }
        open.index = selected
            .and_then(|sel| open.ids.iter().position(|id| *id == sel))
            .unwrap_or_else(|| open.index.min(open.ids.len() - 1));
        open.hovered = None;
    });
}

struct Watcher {
    window: String,
    emit: Emit,
    animate: bool,
}

impl Element for Watcher {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let style = gpui::Style {
            position: gpui::Position::Absolute,
            ..gpui::Style::default()
        };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        if self.animate {
            window.request_animation_frame();
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        _cx: &mut App,
    ) {
        let key = self.window.clone();
        let emit = self.emit.clone();
        window.on_modifiers_changed(move |event: &ModifiersChangedEvent, window, cx| {
            let held = event.modifiers.control || event.modifiers.platform;
            if held || !is_open(&key) {
                return;
            }
            emit.send(Msg::command(COMMIT_ID), window, cx);
        });
        let key = self.window.clone();
        let emit = self.emit.clone();
        window.on_key_event(move |event: &KeyDownEvent, phase, window, cx| {
            if phase != gpui::DispatchPhase::Capture || !is_open(&key) {
                return;
            }
            match event.keystroke.key.as_str() {
                "escape" => {
                    cancel(&key);
                    cx.stop_propagation();
                    window.refresh();
                }
                "enter" => {
                    cx.stop_propagation();
                    emit.send(Msg::command(COMMIT_ID), window, cx);
                }
                _ => {}
            }
        });
    }
}

pub fn commit_message(state: &BrowserState, window: &str, index: Option<usize>) -> Option<Msg> {
    commit(state, window, index).map(|tab| Msg::Store(Action::ActivateTab { tab }))
}

fn backdrop(tab: &Tab, colors: &SwitcherColors) -> (Hsla, Hsla) {
    let theme = tab.live.theme_color.filter(|_| !tab.url.is_empty());
    match theme {
        Some(color) => {
            let fill = crate::primitives::theme_bridge::hsla(color).opacity(1.0);
            let rgb = gpui::Rgba::from(fill);
            let icon = if is_light([rgb.r, rgb.g, rgb.b]) {
                colors.on_page
            } else {
                colors.on_dark
            };
            (fill, rgba(icon).into())
        }
        None => {
            let fill: Hsla = rgba(colors.blank_fill).into();
            let rgb = gpui::Rgba::from(fill);
            let icon = if is_light([rgb.r, rgb.g, rgb.b]) {
                colors.on_page
            } else {
                colors.on_dark
            };
            (fill, rgba(icon).into())
        }
    }
}

fn tab_glyph(c: &Chrome, tab: &Tab, side: f32, color: Hsla) -> AnyElement {
    if tab.url.is_empty() && tab.custom_icon.is_none() {
        return div()
            .size(px(side))
            .flex()
            .items_center()
            .justify_center()
            .child(icon(Icon::Globe, ICON_GLOBE, color))
            .into_any_element();
    }
    crate::primitives::favicon::render_favicon(&c.favicon(tab), side, c.p)
}

fn row_hover(window_key: String, index: usize) -> impl Fn(&bool, &mut Window, &mut App) + 'static {
    move |hovered, window, _| {
        SWITCHERS.with(|s| {
            if let Some(open) = s.borrow_mut().get_mut(&window_key) {
                if *hovered {
                    if open.hovered.is_some() {
                        open.pointer_moved = true;
                        open.index = index;
                    }
                    open.hovered = Some(index);
                } else if open.hovered == Some(index) {
                    open.hovered = None;
                }
            }
        });
        window.refresh();
    }
}

fn card(c: &Chrome, tab: &Tab, index: usize, focused: bool, colors: &SwitcherColors) -> AnyElement {
    let (fill, glyph_color) = backdrop(tab, colors);
    let ring = if focused {
        c.p.accent
    } else {
        rgba(colors.rest_ring).into()
    };
    let title = SharedString::from(tab.display_title());
    let emit = c.emit.clone();
    let key = c.window.id.as_str().to_owned();
    let state_key = key.clone();
    div()
        .id(SharedString::from(format!("switcher-card:{}", tab.id)))
        .flex_none()
        .w(px(CARD))
        .p(px(CARD_INSET))
        .rounded(px(CARD_RADIUS))
        .when(focused, |this| this.bg(rgba(colors.focus_fill)))
        .on_hover(row_hover(key, index))
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            cx.stop_propagation();
            SWITCHERS.with(|s| {
                if let Some(open) = s.borrow_mut().get_mut(&state_key) {
                    open.index = index;
                    open.hovered = None;
                }
            });
            emit.send(Msg::command(COMMIT_ID), window, cx);
        })
        .child(
            div()
                .relative()
                .w(px(CARD - 2.0 * CARD_INSET))
                .h(px(shot_height()))
                .rounded(px(PREVIEW_RADIUS))
                .overflow_hidden()
                .bg(fill)
                .flex()
                .items_center()
                .justify_center()
                .child(tab_glyph(c, tab, ICON_PREVIEW, glyph_color))
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .rounded(px(PREVIEW_RADIUS))
                        .border(px(if focused { RING_FOCUSED } else { RING_REST }))
                        .border_color(ring),
                ),
        )
        .child(
            div()
                .h(px(LABEL))
                .px(px(LABEL_INSET))
                .flex()
                .items_center()
                .gap(px(LABEL_GAP))
                .child(tab_glyph(c, tab, ICON_LABEL, rgba(colors.on_panel).into()))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(TITLE_SIZE))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(rgba(colors.title))
                        .child(title),
                ),
        )
        .into_any_element()
}

fn list_row(
    c: &Chrome,
    tab: &Tab,
    index: usize,
    focused: bool,
    colors: &SwitcherColors,
) -> AnyElement {
    let site = if tab.url.is_empty() {
        String::new()
    } else {
        ardia_state::omnibox::url::breadcrumb_host(&tab.url)
    };
    let emit = c.emit.clone();
    let key = c.window.id.as_str().to_owned();
    let state_key = key.clone();
    div()
        .id(SharedString::from(format!("switcher-row:{}", tab.id)))
        .h(px(LIST_ROW))
        .px(px(LIST_INSET))
        .rounded(px(CARD_RADIUS))
        .flex()
        .items_center()
        .gap(px(LIST_GAP))
        .when(focused, |this| this.bg(rgba(colors.focus_fill)))
        .on_hover(row_hover(key, index))
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            cx.stop_propagation();
            SWITCHERS.with(|s| {
                if let Some(open) = s.borrow_mut().get_mut(&state_key) {
                    open.index = index;
                    open.hovered = None;
                }
            });
            emit.send(Msg::command(COMMIT_ID), window, cx);
        })
        .child(tab_glyph(c, tab, LIST_ICON, rgba(colors.on_panel).into()))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(LIST_LINE_GAP))
                .child(
                    div()
                        .truncate()
                        .text_size(px(TITLE_SIZE))
                        .font_weight(if focused {
                            FontWeight::SEMIBOLD
                        } else {
                            FontWeight::MEDIUM
                        })
                        .text_color(rgba(colors.title))
                        .child(SharedString::from(tab.display_title())),
                )
                .when(!site.is_empty(), |this| {
                    this.child(
                        div()
                            .truncate()
                            .text_size(px(11.0))
                            .text_color(rgba(colors.on_panel))
                            .child(SharedString::from(site)),
                    )
                }),
        )
        .into_any_element()
}

pub fn overlay(c: &Chrome) -> Option<AnyElement> {
    let key = c.window.id.as_str().to_owned();
    sync_tabs(c.state, &key);
    let now = Instant::now();
    let open = SWITCHERS.with(|s| s.borrow().get(&key).cloned())?;
    let visible = open.visible(now);
    let watcher = Watcher {
        window: key.clone(),
        emit: c.emit.clone(),
        animate: !visible && open.view != TabSwitcherView::None,
    };
    if !visible {
        return Some(div().child(watcher).into_any_element());
    }
    let list = open.view == TabSwitcherView::CompactList;
    let (width, height) = (c.layout.width, c.layout.height);
    let size = panel_size(list, open.ids.len(), width, height);
    let colors = switcher_colors(c.look.dark);
    let stride = if list { LIST_ROW } else { CARD + GAP };
    let item = if list { LIST_ROW } else { CARD };
    let start = if open.offset.is_nan() {
        0.0
    } else {
        open.offset
    };
    let offset = revealed_offset(open.index, start, size.viewport, item, stride);
    if (offset - start).abs() > f32::EPSILON || open.offset.is_nan() {
        SWITCHERS.with(|s| {
            if let Some(o) = s.borrow_mut().get_mut(&key) {
                o.offset = offset;
            }
        });
    }
    let items: Vec<AnyElement> = open
        .ids
        .iter()
        .enumerate()
        .filter_map(|(i, id)| {
            let tab = c.state.tab(id.as_str())?;
            let focused = i == open.index;
            Some(if list {
                list_row(c, tab, i, focused, &colors)
            } else {
                card(c, tab, i, focused, &colors)
            })
        })
        .collect();
    let strip = div()
        .absolute()
        .when(list, |this| this.left_0().right_0().top(px(-offset)))
        .when(!list, |this| this.top_0().bottom_0().left(px(-offset)))
        .flex()
        .when(list, |this| this.flex_col())
        .when(!list, |this| this.flex_row().gap(px(GAP)))
        .children(items);
    Some(
        div()
            .id("tab-switcher")
            .debug_selector(|| "tab-switcher".into())
            .absolute()
            .left(px((width - size.width) / 2.0))
            .top(px((height - size.height) / 2.0))
            .w(px(size.width))
            .h(px(size.height))
            .rounded(px(PANEL_RADIUS))
            .bg(rgba(colors.fill))
            .border(px(0.5))
            .border_color(c.p.popover_border)
            .shadow(vec![shadow(gpui::black().opacity(0.45), 14.0, 32.0)])
            .occlude()
            .child(watcher)
            .child(
                div()
                    .absolute()
                    .left(px(PAD))
                    .top(px(PAD))
                    .w(px(if list {
                        size.width - 2.0 * PAD
                    } else {
                        size.viewport
                    }))
                    .h(px(if list { size.viewport } else { row_height() }))
                    .overflow_hidden()
                    .child(strip),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cards_fit_the_window_up_to_seven() {
        let size = panel_size(false, 20, 1512.0, 900.0);
        assert_eq!(size.count, 7);
        assert_eq!(size.viewport, 7.0 * 168.0 + 6.0 * 4.0);
        assert_eq!(size.width, 16.0 + size.viewport);
        assert_eq!(size.height, 16.0 + row_height());
        assert_eq!(row_height(), 105.0 + 30.0 + 8.0);
        assert_eq!(panel_size(false, 3, 1512.0, 900.0).count, 3);
        assert_eq!(panel_size(false, 9, 500.0, 900.0).count, 2);
    }

    #[test]
    fn the_compact_list_fits_eight_rows() {
        let size = panel_size(true, 20, 1512.0, 900.0);
        assert_eq!(size.count, 8);
        assert_eq!(size.width, 380.0);
        assert_eq!(size.height, 16.0 + 320.0);
        assert_eq!(panel_size(true, 20, 1512.0, 300.0).count, 5);
    }

    #[test]
    fn the_focused_card_scrolls_into_view() {
        assert_eq!(revealed_offset(0, 50.0, 300.0, 168.0, 172.0), 0.0);
        assert_eq!(
            revealed_offset(3, 0.0, 512.0, 168.0, 172.0),
            3.0 * 172.0 + 168.0 - 512.0
        );
        assert_eq!(revealed_offset(1, 0.0, 512.0, 168.0, 172.0), 0.0);
    }

    #[test]
    fn steps_wrap_around() {
        let ids: Vec<TabId> = ["a", "b", "c"].into_iter().map(TabId::new).collect();
        assert_eq!(step_from(&ids, Some(&ids[2]), 1), 0);
        assert_eq!(step_from(&ids, Some(&ids[0]), -1), 2);
        assert_eq!(step_from(&ids, None, 1), 0);
        assert_eq!(step_from(&ids, None, -1), 2);
    }

    #[test]
    fn light_theme_colours_get_dark_icons() {
        assert!(is_light([1.0, 1.0, 1.0]));
        assert!(!is_light([0.1, 0.1, 0.1]));
    }
}
