pub(crate) mod folder_art;
pub(crate) mod glyphs;
pub(crate) mod motion;
mod panel;

use std::sync::Arc;

use crate::scale::px;
use ardia_state::group_names::{Member, group_label};
use ardia_state::groups::{self, GroupColor, TabGroup};
use ardia_state::{Action, GroupId, GroupPatch, TabId};
use ardia_theme::RgbaColor;
use ardia_theme::layout::sidebar;
use gpui::{
    AnyElement, App, FontWeight, Hsla, IntoElement, MouseButton, ParentElement, RenderOnce,
    SharedString, Styled, Window, div, prelude::*,
};

pub use folder_art::{FolderPalette, folder_art, folder_palette, group_tint};

use crate::msg::{MenuTarget, Msg, RenameTarget};
use crate::primitives::controls::IconButton;
use crate::primitives::fade_label::fade_label;
use crate::primitives::favicon::{favicon_of, render_favicon, resolve_favicon};
use crate::primitives::icons::Icon;
use crate::primitives::theme_bridge::hsla;
use crate::sidebar::list_motion;
use crate::sidebar::model::{
    Entry, entry_height, entry_holds, head_gap, kept_children, members_pad_bottom, shows_extra_tabs,
};
use crate::sidebar::tab_row::{row_id, split_row, tab_row};
use crate::window::chrome::{Chrome, TabDrag};
use motion::group_ui;

pub const GROUP_HEADER: &str = "group-header";
pub const GROUP_INNER_RADIUS: f32 = sidebar::GROUP_RADIUS - sidebar::GROUP_BORDER;
pub const TITLE_GAP: f32 = sidebar::DIA_ROW_TITLE_GAP;
pub const TITLE_TRAILING: f32 = 8.0;
pub const TITLE_BOX_GAP: f32 = sidebar::ROW_TITLE_GAP;
pub const HOVER_SLOT: f32 = 22.0;
pub const CHEVRON_BOX: f32 = 10.0;
pub const SHARED_MARK_GAP: f32 = 4.0;
const NO_GROUP_ICON: &str = "symbol:square.stack.fill";

pub fn group_surface(color: Option<GroupColor>, neutral: (Hsla, Hsla)) -> (Hsla, Hsla, bool) {
    if color == Some(GroupColor::NoColor) {
        return (Hsla::transparent_black(), Hsla::transparent_black(), false);
    }
    match group_tint(color) {
        Some(tint) => (hsla(tint).opacity(0.16), hsla(tint).opacity(0.3), true),
        None => (neutral.0, neutral.1, false),
    }
}

pub fn group_title_color(dark: bool, high_contrast: bool) -> Hsla {
    hsla(match (dark, high_contrast) {
        (true, _) => RgbaColor::WHITE,
        (false, true) => RgbaColor::BLACK,
        (false, false) => RgbaColor::hexa(0x000000D9),
    })
}

pub fn has_own_icon(icon: Option<&str>) -> bool {
    icon.is_some_and(|icon| !icon.trim().is_empty() && icon != NO_GROUP_ICON)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SharedMark {
    Shared,
    Waiting,
    Error,
}

pub const SHARED_MARK_FRAME: (f32, f32) = (16.0, 10.0);
pub const SHARED_MARK_POINTS: f32 = 10.0;

impl SharedMark {
    pub fn symbol(self) -> &'static str {
        match self {
            SharedMark::Shared => "person.2.fill",
            SharedMark::Waiting => "icloud.and.arrow.down",
            SharedMark::Error => "exclamationmark.icloud",
        }
    }

    fn fallback(self) -> Icon {
        match self {
            SharedMark::Shared => Icon::PersonPair,
            SharedMark::Waiting | SharedMark::Error => Icon::Warning,
        }
    }
}

pub fn shared_mark(c: &Chrome, group: &TabGroup) -> Option<SharedMark> {
    if !group.pinned || group.parent_id.is_some() {
        return None;
    }
    let status = c.host.sync_status();
    if !status.loaded {
        c.host.refresh_sync_status();
        return None;
    }
    let folder = status
        .shared_folders
        .iter()
        .find(|f| f.profile_id == group.profile_id && f.group_key == group.pin_key())?;
    Some(match folder.state {
        _ if !folder.reachable => SharedMark::Error,
        crate::host_data::SharedFolderState::Error(_)
        | crate::host_data::SharedFolderState::Missing => SharedMark::Error,
        crate::host_data::SharedFolderState::Waiting(_) => SharedMark::Waiting,
        _ => SharedMark::Shared,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseControl {
    Close,
    Unload,
}

fn open_members(c: &Chrome, group: &TabGroup) -> Vec<TabId> {
    group
        .tab_ids
        .iter()
        .filter(|id| c.state.tab(id.as_str()).is_some_and(|t| t.page.has_page()))
        .cloned()
        .collect()
}

pub fn close_control(c: &Chrome, group: &TabGroup) -> Option<CloseControl> {
    let root = groups::root(&c.state.groups, group.id.as_str())?;
    let pinned = c.state.group(root.as_str()).is_some_and(|g| g.pinned);
    if !pinned {
        return Some(CloseControl::Close);
    }
    (!open_members(c, group).is_empty()).then_some(CloseControl::Unload)
}

pub fn label_of(c: &Chrome, group: &TabGroup) -> String {
    let tabs: Vec<_> = group
        .tab_ids
        .iter()
        .filter_map(|id| c.state.tab(id.as_str()))
        .collect();
    let members: Vec<Member> = tabs
        .iter()
        .map(|t| Member {
            url: &t.url,
            title: &t.title,
        })
        .collect();
    group_label(&group.name, &members)
}

pub(crate) fn folder_or_icon(
    c: &Chrome,
    id: &str,
    icon: Option<&str>,
    color: Option<GroupColor>,
    open: bool,
) -> AnyElement {
    let side = c.look.icon_points(sidebar::ROW_FAVICON);
    if let Some(icon) = icon.filter(|i| has_own_icon(Some(i))) {
        let favicon = c.resolve_favicon(favicon_of("", None, Some(icon), ""), &c.window.profile_id);
        return render_favicon(&favicon, side, c.p);
    }
    let theme = &c.look.theme;
    let profile_tint = theme.power_up_color.unwrap_or(theme.roles.accent);
    let palette = folder_art::cached_palette(
        group_tint(color),
        c.look.dark,
        profile_tint,
        c.state.settings.folder_style,
        &theme.window_tint,
    );
    folder_art(row_id("group-folder", id), open, side, palette).into_any_element()
}

fn ghost_folder_art(c: &Chrome, group: &TabGroup) -> Option<crate::sidebar::drag::GhostArt> {
    if group.icon.as_deref().is_some_and(|i| has_own_icon(Some(i))) {
        return None;
    }
    let theme = &c.look.theme;
    let profile_tint = theme.power_up_color.unwrap_or(theme.roles.accent);
    Some(crate::sidebar::drag::GhostArt::Folder {
        id: SharedString::from(format!("ghost-folder:{}", group.id)),
        side: c.look.icon_points(sidebar::ROW_FAVICON),
        palette: folder_art::cached_palette(
            group_tint(group.color),
            c.look.dark,
            profile_tint,
            c.state.settings.folder_style,
            &theme.window_tint,
        ),
    })
}

fn title(c: &Chrome, group: &TabGroup, label: SharedString) -> AnyElement {
    let color = group_title_color(c.look.dark, c.look.high_contrast);
    let mark = shared_mark(c, group);
    let height = c.points(18.);
    let measurer = fade_label(label.clone(), gpui::transparent_black(), c.points(13.))
        .weight(FontWeight::MEDIUM)
        .line_height(height)
        .hug();
    let shown = fade_label(label, color, c.points(13.))
        .weight(FontWeight::MEDIUM)
        .line_height(height)
        .cell_inset();
    div()
        .flex_1()
        .min_w_0()
        .h(px(height))
        .ml(px(TITLE_BOX_GAP))
        .flex()
        .items_center()
        .child(
            div()
                .relative()
                .flex_shrink(1.)
                .min_w_0()
                .h(px(height))
                .pr(px(TITLE_TRAILING))
                .flex()
                .items_center()
                .child(measurer)
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .debug_selector(|| "folder-title".into())
                        .child(shown),
                ),
        )
        .when_some(mark, |this, mark| {
            let tint = if mark == SharedMark::Error {
                c.p.destructive
            } else {
                color.alpha(0.5)
            };
            this.child(
                div()
                    .flex_none()
                    .mr(px(SHARED_MARK_GAP))
                    .w(px(SHARED_MARK_FRAME.0))
                    .h(px(SHARED_MARK_FRAME.1))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        crate::primitives::icons::symbol_icon(
                            mark.symbol(),
                            mark.fallback(),
                            SHARED_MARK_POINTS,
                            tint,
                        )
                        .weight(crate::icon_picker::symbols::SymbolWeight::Semibold)
                        .fit_within(SHARED_MARK_FRAME.0, SHARED_MARK_FRAME.1),
                    ),
            )
        })
        .child(Chevron {
            group: group.id.clone(),
            open: !group.collapsed,
            color: color.alpha(0.5),
        })
        .into_any_element()
}

pub fn header_hover_key(group: &str) -> GroupId {
    GroupId::new(format!("group-header:{group}"))
}

fn hover_slot(c: &Chrome, group: &TabGroup, renaming: bool) -> AnyElement {
    let over = close_control(c, group)
        .filter(|_| !renaming)
        .map(|control| {
            let (glyph, tip, msg) = match control {
                CloseControl::Close => (
                    Icon::XMark,
                    "Close Group",
                    Msg::Store(Action::CloseGroup {
                        group: group.id.clone(),
                    }),
                ),
                CloseControl::Unload => (
                    Icon::Minus,
                    "Unload Tabs",
                    Msg::Store(Action::SleepTabs {
                        tabs: open_members(c, group),
                    }),
                ),
            };
            IconButton::new(row_id("group-close", group.id.as_str()), glyph, c.p)
                .glyph(10.)
                .square(HOVER_SLOT, 6.)
                .color(c.p.icon)
                .fills(c.p.toolbar_hover, c.p.toolbar_pressed)
                .tooltip(tip, c.p)
                .on_click({
                    let click = c.emit.click(msg);
                    move |e, w, cx| {
                        cx.stop_propagation();
                        click(e, w, cx);
                    }
                })
                .into_any_element()
        });
    let rest = (!renaming)
        .then(|| MeetingLabel {
            host: Arc::clone(c.host),
            group: group.id.to_string(),
            p: *c.p,
        })
        .map(IntoElement::into_any_element);
    crate::sidebar::live_folders::HoverSwap {
        key: header_hover_key(group.id.as_str()),
        rest,
        over,
    }
    .into_any_element()
}

pub const WIGGLE_STEP_MS: u64 = 100;
pub const WIGGLE: [f32; 6] = [1.0, -1.0, 0.8, -0.6, 0.3, 0.0];
pub const WIGGLE_DEGREES: f32 = 4.0;

pub fn wiggle_value(elapsed_ms: f32) -> Option<f32> {
    let step = WIGGLE_STEP_MS as f32;
    let index = (elapsed_ms / step).floor().max(0.0) as usize;
    let to = *WIGGLE.get(index)?;
    let from = if index == 0 { 0.0 } else { WIGGLE[index - 1] };
    let t = (elapsed_ms - index as f32 * step) / step;
    let eased = if t < 0.5 {
        2.0 * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
    };
    Some(from + (to - from) * eased)
}

thread_local! {
    static WIGGLES: std::cell::RefCell<(crate::live::WiggleMarks, std::collections::HashMap<String, std::time::Instant>)> =
        std::cell::RefCell::new(Default::default());
}

#[derive(IntoElement)]
struct WiggleTitle {
    host: Arc<dyn crate::UiHost>,
    group: String,
    child: AnyElement,
}

impl RenderOnce for WiggleTitle {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        let minutes_left = self.host.live().and_then(|live| {
            let meeting = live.meeting_groups.get(&self.group)?;
            let end = meeting.end.filter(|_| meeting.ended_at.is_none())?;
            Some((end - now) as f64 / 60_000.0)
        });
        let started = WIGGLES.with(|cell| {
            let mut cell = cell.borrow_mut();
            let (marks, started) = &mut *cell;
            if let Some(left) = minutes_left
                && marks.due(&self.group, left)
            {
                started.insert(self.group.clone(), std::time::Instant::now());
            }
            started.get(&self.group).copied()
        });
        let value = started
            .and_then(|at| wiggle_value(at.elapsed().as_secs_f32() * 1000.0))
            .unwrap_or(0.0);
        if value != 0.0 || started.is_some_and(|at| at.elapsed().as_millis() < 600) {
            window.request_animation_frame();
        }
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .items_center()
            .rotate(gpui::radians((value * WIGGLE_DEGREES).to_radians()))
            .child(self.child)
    }
}

#[derive(IntoElement)]
struct MeetingLabel {
    host: Arc<dyn crate::UiHost>,
    group: String,
    p: crate::look::Palette,
}

thread_local! {
    static MEETING_TICK: std::cell::Cell<Option<std::time::Instant>> = const { std::cell::Cell::new(None) };
}

impl RenderOnce for MeetingLabel {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let live = self.host.live();
        let meeting = live
            .as_ref()
            .and_then(|l| l.meeting_groups.get(&self.group))
            .filter(|m| m.ended_at.is_none() && m.end.is_some());
        if meeting.is_some() {
            let due = MEETING_TICK.with(|t| {
                let now = std::time::Instant::now();
                let due = t.get().is_none_or(|at| now >= at);
                if due {
                    t.set(Some(now + std::time::Duration::from_secs(5)));
                }
                due
            });
            if due {
                window
                    .spawn(cx, async move |cx| {
                        cx.background_executor()
                            .timer(std::time::Duration::from_secs(5))
                            .await;
                        let _ = cx.update(|window, _| window.refresh());
                    })
                    .detach();
            }
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        div().children(
            live.as_ref()
                .and_then(|l| crate::live::views::meeting_time_label(&self.p, l, &self.group, now)),
        )
    }
}

fn header(c: &Chrome, group: &TabGroup, children: &[Entry], label: SharedString) -> AnyElement {
    let p = *c.p;
    let collapsed = group.collapsed;
    let renaming = matches!(&c.ui.rename, Some(RenameTarget::Group(id)) if *id == group.id);
    let shows_extra = collapsed && shows_extra_tabs(c.state, c.window.id.as_str(), group, children);
    let toggle = Msg::Store(Action::UpdateGroup {
        group: group.id.clone(),
        patch: if !collapsed || !shows_extra {
            GroupPatch {
                collapsed: Some(!collapsed),
                ..GroupPatch::default()
            }
        } else {
            GroupPatch {
                shown_tab_ids: Some(Vec::new()),
                ..GroupPatch::default()
            }
        },
    });
    let emit = c.emit.clone();
    let id = group.id.clone();
    let into_now = crate::sidebar::drag::snapshot(c).into.as_ref() == Some(&group.id);
    let lead = group
        .tab_ids
        .first()
        .and_then(|id| c.state.tab(id.as_str()))
        .cloned();
    let drag_source = lead.filter(|_| !renaming).map(|lead| {
        let mut ghost = crate::sidebar::drag::Ghost::new(
            c,
            &lead,
            crate::sidebar::drag::DragKind::Group,
            crate::sidebar::drag::row_ghost_width(c),
            sidebar::pinned_tile_height() * 1.5,
        );
        ghost.title = label.clone();
        ghost.art = ghost_folder_art(c, group);
        if let Some(icon) = group.icon.as_deref().filter(|i| has_own_icon(Some(i))) {
            ghost.favicon =
                c.resolve_favicon(favicon_of("", None, Some(icon), ""), &c.window.profile_id);
        }
        let members: std::collections::HashSet<TabId> = group.tab_ids.iter().cloned().collect();
        let height = crate::sidebar::model::entry_height(
            c.state,
            c.window.id.as_str(),
            &crate::sidebar::model::Entry::Group {
                group: Arc::new(group.clone()),
                depth: 0,
                count: children.len(),
                children: children.to_vec(),
            },
        );
        (
            crate::sidebar::tab_row::drag_payload(c, &lead),
            ghost,
            members,
            height,
            crate::sidebar::drag::DropContext::new(c),
        )
    });
    div()
        .id(row_id("group", group.id.as_str()))
        .debug_selector(|| "group-header".into())
        .group(GROUP_HEADER)
        .relative()
        .flex_none()
        .h(px(sidebar::row_height()))
        .pl(px(sidebar::ROW_CONTENT_LEFT))
        .pr(px(sidebar::ROW_TRAILING))
        .rounded(px(GROUP_INNER_RADIUS))
        .flex()
        .items_center()
        .when(!renaming, |this| this.on_click(c.emit.click(toggle)))
        .when_some(
            drag_source,
            |this, (payload, ghost, members, height, drops)| {
                let key = c.window.id.as_str().to_owned();
                let press_key = key.clone();
                let group_id = group.id.clone();
                let lead = payload.tab.clone();
                this.on_mouse_down(MouseButton::Left, move |event, _, _| {
                    crate::sidebar::drag::note_press(&press_key, event.position)
                })
                .on_drag(payload, move |_, grab, window, cx| {
                    crate::sidebar::drag::begin(
                        &key,
                        &lead,
                        crate::sidebar::drag::DragKind::Group,
                        &drops,
                        grab,
                        &ghost,
                    );
                    crate::sidebar::drag::begin_group(
                        &key,
                        &group_id,
                        members.clone(),
                        f32::from(px(height)),
                    );
                    window.refresh();
                    let mut ghost = ghost.clone();
                    ghost.card = ghost.card.snapped(window);
                    let ghost = ghost.view();
                    cx.new(|_| ghost)
                })
            },
        )
        .map(|this| group_panel_card(this, c, group, collapsed && !renaming))
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            cx.stop_propagation();
            emit.send(
                Msg::Menu(Some((MenuTarget::Group(id.clone()), event.position))),
                window,
                cx,
            );
        })
        .on_drag_move({
            let key = c.window.id.as_str().to_owned();
            let group = group.id.clone();
            let groups_now = std::sync::Arc::clone(&c.state.groups);
            move |event: &gpui::DragMoveEvent<TabDrag>, window, cx| {
                let bounds = event.bounds;
                let y = f32::from(event.event.position.y);
                let dragged_group = crate::sidebar::drag::dragged_group(&key);
                let nests = dragged_group.as_ref().is_none_or(|dragged| {
                    ardia_state::actions::can_move_group(&groups_now, dragged, None, Some(&group))
                });
                let over = (collapsed || dragged_group.is_some())
                    && nests
                    && crate::sidebar::drag::dragged_folder(&key).is_none()
                    && bounds.contains(&event.event.position)
                    && crate::sidebar::drag::into_group_band(
                        f32::from(bounds.origin.y),
                        f32::from(bounds.size.height),
                        y,
                    );
                let held = crate::sidebar::drag::snapshot_into(&key);
                let next = if over {
                    Some(group.clone())
                } else if held.as_ref() == Some(&group) {
                    None
                } else {
                    return;
                };
                if crate::sidebar::drag::note_into(&key, next) {
                    crate::sidebar::drag::retarget(&key, window, cx);
                    window.refresh();
                }
            }
        })
        .on_drop({
            let emit = c.emit.clone();
            let group = group.id.clone();
            let drops = crate::sidebar::drag::DropContext::new(c);
            let key = c.window.id.as_str().to_owned();
            move |drag: &TabDrag, window, cx| {
                if crate::sidebar::drag::snapshot_into(&key).as_ref() != Some(&group) {
                    drops.drop(drag, window, cx);
                    return;
                }
                let dragged_group = crate::sidebar::drag::dragged_group(&key);
                crate::sidebar::drag::end(&key);
                let msg = match dragged_group {
                    Some(dragged) => Msg::Store(Action::MoveGroup {
                        group: dragged,
                        before: None,
                        pinned: false,
                        parent: Some(group.clone()),
                    }),
                    None => Msg::DropTab {
                        tab: drag.tab.clone(),
                        before: None,
                        group: Some(group.clone()),
                        pin: None,
                    },
                };
                emit.send(msg, window, cx);
            }
        })
        .when(into_now, |this| this.bg(p.tab_pressed))
        .child(folder_or_icon(
            c,
            group.id.as_str(),
            group.icon.as_deref(),
            group.color,
            !collapsed || into_now,
        ))
        .child(if renaming {
            div()
                .flex_1()
                .min_w_0()
                .ml(px(TITLE_GAP))
                .debug_selector(|| "rename-input".into())
                .child(c.rename_input.clone())
                .into_any_element()
        } else {
            WiggleTitle {
                host: Arc::clone(c.host),
                group: group.id.to_string(),
                child: title(c, group, label),
            }
            .into_any_element()
        })
        .child(hover_slot(c, group, renaming))
        .into_any_element()
}

thread_local! {
    static GROUP_PANELS: std::cell::RefCell<std::collections::HashMap<TabId, gpui::AnyView>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

pub fn group_panel_key(group: &GroupId) -> TabId {
    TabId::new(format!("group-panel:{}", group.as_str()))
}

fn group_panel_card(
    row: gpui::Stateful<gpui::Div>,
    c: &Chrome,
    group: &TabGroup,
    shows_panel: bool,
) -> gpui::Stateful<gpui::Div> {
    let hover_key = header_hover_key(group.id.as_str());
    let header_hover = move |hovered: &bool, window: &mut Window, cx: &mut App| {
        group_ui(cx).set_hovered(&hover_key, Vec::new(), *hovered);
        window.refresh();
    };
    if !shows_panel {
        return row.on_hover(header_hover);
    }
    let key = group_panel_key(&group.id);
    let state = c.state.clone();
    let host = Arc::clone(c.host);
    let emit = c.emit.clone();
    let p = *c.p;
    let glass = c.look.glass.then(|| c.look.clone());
    let group_id = group.id.clone();
    let build_key = key.clone();
    let also = move |hovered: &bool, window: &mut Window, cx: &mut App| {
        header_hover(hovered, window, cx);
        if !*hovered {
            return;
        }
        let rows = panel::panel_rows(&state, group_id.as_str());
        let favicons = rows
            .iter()
            .filter_map(|row| state.tab(row.id.as_str()))
            .map(|t| {
                let favicon = favicon_of(
                    &t.url,
                    t.favicon.as_deref(),
                    t.custom_icon.as_deref(),
                    &t.label(),
                );
                (
                    t.id.clone(),
                    resolve_favicon(favicon, host.as_ref(), &t.profile_id),
                )
            })
            .collect();
        let view =
            panel::GroupPanel::build(rows, favicons, emit.clone(), p, glass.clone(), window, cx);
        GROUP_PANELS.with(|panels| panels.borrow_mut().insert(build_key.clone(), view));
    };
    let body_key = key.clone();
    crate::sidebar::hover_card::attach_card(row, c, &key, panel::WIDTH, also, move || {
        GROUP_PANELS
            .with(|panels| panels.borrow().get(&body_key).cloned())
            .map_or_else(|| div().into_any_element(), |view| view.into_any_element())
    })
}

pub fn entry(c: &Chrome, entry: &Entry) -> AnyElement {
    match entry {
        Entry::Tab { tab, .. } => tab_row(c, tab, 0),
        Entry::Split { split, tabs, .. } => split_row(c, split, tabs, 0),
        Entry::Group {
            group, children, ..
        } => group_block(c, group, children),
    }
}

pub(crate) struct FoldMember {
    pub(crate) element: AnyElement,
    pub(crate) height: f32,
    pub(crate) kept: bool,
}

#[derive(IntoElement)]
pub(crate) struct GroupBlock {
    pub(crate) id: GroupId,
    pub(crate) ancestors: Vec<GroupId>,
    pub(crate) collapsed: bool,
    pub(crate) fill: Hsla,
    pub(crate) stroke: Hsla,
    pub(crate) at_rest: bool,
    pub(crate) header: AnyElement,
    pub(crate) members: Vec<FoldMember>,
    pub(crate) first_gap: [f32; 2],
    pub(crate) fold_sides: (f32, f32),
    pub(crate) pad_bottom: Option<f32>,
    pub(crate) pad_y: f32,
}

thread_local! {
    static NESTED_BAND: std::cell::Cell<Option<(f32, f32)>> = const { std::cell::Cell::new(None) };
}

pub fn group_block(c: &Chrome, group: &Arc<TabGroup>, children: &[Entry]) -> AnyElement {
    let (fill, stroke, at_rest) = group_surface(group.color, (c.p.group_box, c.p.group_stroke));
    let window = c.window.id.as_str();
    let kept = kept_children(c.state, window, group, children);
    let first_kept = children
        .iter()
        .zip(&kept)
        .find(|(_, k)| **k)
        .map(|(e, _)| e);
    let ancestors = groups::ancestors(&c.state.groups, group.id.as_str());
    let inherited = NESTED_BAND.with(std::cell::Cell::get);
    let band = (!group.collapsed
        && children.len() > 1
        && !crate::sidebar::drag_motion::busy(window)
        && crate::sidebar::drag::live_drag(window).is_none())
    .then(|| {
        if !ancestors.is_empty() {
            return inherited;
        }
        let item = format!("group:{}", group.id);
        let page = format!("{window}:{}", c.window.profile_id);
        crate::primitives::virtual_list::band(&format!("sidebar-rows:{page}"), &item).or_else(
            || crate::primitives::virtual_list::band(&format!("sidebar-pinned:{page}"), &item),
        )
    })
    .flatten();
    let active = c.active.map(|tab| tab.id.clone());
    let mut top = sidebar::GROUP_BORDER + sidebar::row_height() + head_gap(children.first());
    let members = children
        .iter()
        .zip(&kept)
        .map(|(child, kept)| {
            let height = entry_height(c.state, window, child);
            let member_top = top;
            let skip = crate::primitives::virtual_list::outside_band(band, top, height)
                && !active.as_ref().is_some_and(|tab| entry_holds(child, tab));
            top += height + sidebar::row_gap();
            FoldMember {
                element: if skip {
                    div().flex_none().h(px(height)).into_any_element()
                } else {
                    let below = band.map(|(lo, hi)| (lo - member_top, hi - member_top));
                    let outer = NESTED_BAND.with(|cell| cell.replace(below));
                    let element = entry(c, child);
                    NESTED_BAND.with(|cell| cell.set(outer));
                    element
                },
                height,
                kept: *kept,
            }
        })
        .collect();
    let label = SharedString::from(label_of(c, group));
    let profile = c.window.profile_id.as_str();
    let outer = list_motion::origin_key(profile, ancestors.first().map(|g| g.as_str()));
    let inner = list_motion::origin_key(profile, Some(group.id.as_str()));
    let block = GroupBlock {
        id: group.id.clone(),
        ancestors,
        collapsed: group.collapsed,
        fill,
        stroke,
        at_rest,
        header: div()
            .relative()
            .child(list_motion::origin_probe(window, &inner))
            .child(header(c, group, children, label))
            .into_any_element(),
        members,
        first_gap: [head_gap(children.first()), head_gap(first_kept)],
        fold_sides: (sidebar::GROUP_INDENT, sidebar::GROUP_INSET),
        pad_bottom: None,
        pad_y: sidebar::GROUP_BORDER,
    }
    .into_any_element();
    let block = match crate::sidebar::drag_motion::group_room(window, &group.id) {
        Some(room) => div()
            .flex_none()
            .opacity(0.)
            .when_some(room.height, |this, height| {
                this.h(gpui::Pixels::from(height)).overflow_hidden()
            })
            .when(room.moving, |this| {
                this.child(crate::sidebar::tab_row::frame_pump())
            })
            .child(block)
            .into_any_element(),
        None => block,
    };
    list_motion::sliding(
        window,
        &ardia_state::TabId::from(format!("~group:{}", group.id.as_str()).as_str()),
        &outer,
        !crate::sidebar::pager::paging(window),
        block,
    )
    .into_any_element()
}

#[derive(IntoElement)]
struct Chevron {
    group: GroupId,
    open: bool,
    color: Hsla,
}

impl RenderOnce for Chevron {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (open, _) = group_ui(cx).open(&self.group, self.open);
        glyphs::turned(
            glyphs::CHEVRON_DOWN,
            CHEVRON_BOX,
            self.color,
            -std::f32::consts::FRAC_PI_2 * (1.0 - open),
        )
    }
}

impl RenderOnce for GroupBlock {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ui = group_ui(cx);
        let (open, moving) = ui.open(&self.id, !self.collapsed);
        let shown = ui.innermost(&self.id) || self.at_rest;
        let (opacity, fading) = ui.box_opacity(&self.id, shown);
        if moving || fading {
            window.request_animation_frame();
        }
        let gap = sidebar::row_gap();
        let any_kept = self.members.iter().any(|m| m.kept);
        let target_count = if self.collapsed {
            self.members.iter().filter(|m| m.kept).count()
        } else {
            self.members.len()
        };
        let pad_top = if self.collapsed && any_kept {
            self.first_gap[1]
        } else {
            self.first_gap[0]
        };
        let pad_bottom = self
            .pad_bottom
            .unwrap_or_else(|| members_pad_bottom(target_count));
        let folding = any_kept && (self.collapsed || moving);
        let shown_members: Vec<FoldMember> = if moving || !self.collapsed {
            self.members
        } else {
            self.members.into_iter().filter(|m| m.kept).collect()
        };
        let total = pad_top
            + pad_bottom
            + shown_members.iter().map(|m| m.height).sum::<f32>()
            + gap * shown_members.len().saturating_sub(1) as f32;
        let fold = (!shown_members.is_empty()).then(|| {
            div()
                .flex_none()
                .flex()
                .flex_col()
                .gap(px(gap))
                .pt(px(pad_top))
                .pb(px(pad_bottom))
                .pl(px(self.fold_sides.0))
                .pr(px(self.fold_sides.1))
                .children(shown_members.into_iter().map(|m| {
                    if folding && moving && !m.kept {
                        div()
                            .flex_none()
                            .h(px(m.height * open))
                            .mb(px(-gap * (1.0 - open)))
                            .opacity(open)
                            .overflow_hidden()
                            .child(m.element)
                            .into_any_element()
                    } else {
                        m.element
                    }
                }))
        });
        let fold = fold.map(|fold| {
            if moving && !folding {
                div()
                    .flex_none()
                    .h(px(total * open))
                    .opacity(open)
                    .overflow_hidden()
                    .child(fold)
                    .into_any_element()
            } else {
                fold.into_any_element()
            }
        });
        let id = self.id.clone();
        let ancestors = self.ancestors.clone();
        let (fill, stroke) = (self.fill, self.stroke);
        div()
            .id(row_id("group-block", self.id.as_str()))
            .relative()
            .flex()
            .flex_col()
            .py(px(self.pad_y))
            .rounded(px(sidebar::GROUP_RADIUS))
            .drag_over::<TabDrag>(move |style, _, _, _| style.bg(fill).border_color(stroke))
            .on_hover(move |hovered, window, cx| {
                group_ui(cx).set_hovered(&id, ancestors.clone(), *hovered);
                window.refresh();
            })
            .when(opacity > 0.0, |this| {
                this.child(
                    div()
                        .absolute()
                        .inset_0()
                        .rounded(px(sidebar::GROUP_RADIUS))
                        .bg(fill)
                        .border(px(sidebar::GROUP_BORDER))
                        .border_color(stroke)
                        .opacity(opacity),
                )
            })
            .child(self.header)
            .children(fold)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coloured_groups_carry_a_tint_at_rest() {
        let neutral = (Hsla::white().opacity(0.1), Hsla::white().opacity(0.1));
        let (fill, stroke, rest) = group_surface(Some(GroupColor::Blue), neutral);
        assert!(rest);
        assert!((fill.a - 0.16).abs() < 1e-4 && (stroke.a - 0.3).abs() < 1e-4);
        let (fill, _, rest) = group_surface(None, neutral);
        assert!(!rest);
        assert_eq!(fill, neutral.0);
        let (fill, stroke, rest) = group_surface(Some(GroupColor::NoColor), neutral);
        assert!(!rest && fill.a == 0.0 && stroke.a == 0.0);
        assert_eq!(group_tint(Some(GroupColor::NoColor)), None);
    }

    #[test]
    fn the_meeting_wiggle_swings_through_its_keyframes() {
        assert_eq!(wiggle_value(0.0), Some(0.0));
        assert_eq!(wiggle_value(100.0), Some(-1.0 + 2.0));
        assert!((wiggle_value(150.0).expect("mid") - 0.0).abs() < 1e-5);
        assert_eq!(wiggle_value(500.0), Some(0.3));
        assert_eq!(wiggle_value(600.0), None);
    }

    #[test]
    fn own_icons_skip_the_placeholder_symbol() {
        assert!(has_own_icon(Some("🚀")));
        assert!(!has_own_icon(Some(NO_GROUP_ICON)));
        assert!(!has_own_icon(Some("")));
        assert!(!has_own_icon(None));
    }
}

#[cfg(test)]
mod ui_tests {
    use std::time::Duration;

    use ardia_state::{Action, GroupPatch};
    use gpui::{Modifiers, TestAppContext, VisualTestContext};

    use crate::tests::support::Browser;

    fn grouped(cx: &mut TestAppContext) -> (Browser, ardia_state::GroupId) {
        let browser = Browser::open(cx);
        let a = browser.new_tab(cx, "https://a.test/");
        let b = browser.new_tab(cx, "https://b.test/");
        browser.act(
            cx,
            Action::CreateGroup {
                tabs: vec![a, b],
                name: "Reading".into(),
            },
        );
        let group = browser
            .state()
            .groups
            .keys()
            .next()
            .cloned()
            .expect("a group");
        (browser, group)
    }

    fn collapse(browser: &Browser, cx: &mut TestAppContext, group: &ardia_state::GroupId) {
        browser.act(
            cx,
            Action::UpdateGroup {
                group: group.clone(),
                patch: GroupPatch {
                    collapsed: Some(true),
                    ..GroupPatch::default()
                },
            },
        );
    }

    #[gpui::test]
    fn clicking_a_group_header_folds_it(cx: &mut TestAppContext) {
        let (browser, group) = grouped(cx);
        browser.click(cx, "group-header");
        assert!(browser.state().groups[&group].collapsed);
        browser.click(cx, "group-header");
        assert!(!browser.state().groups[&group].collapsed);
    }

    #[gpui::test]
    fn resting_on_a_folded_group_opens_its_tab_panel(cx: &mut TestAppContext) {
        let (browser, group) = grouped(cx);
        let other = browser.new_tab(cx, "https://c.test/");
        browser.act(cx, Action::ActivateTab { tab: other });
        collapse(&browser, cx, &group);
        let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
        std::thread::sleep(Duration::from_millis(
            crate::sidebar::list_motion::SLIDE_MS + 60,
        ));
        visual.update(|window, _| window.refresh());
        visual.run_until_parked();
        let header = browser.bounds(cx, "group-header").expect("the header");
        visual.simulate_mouse_move(header.center(), None, Modifiers::none());
        visual.executor().advance_clock(Duration::from_millis(
            ardia_theme::motion::HOVER_CARD_DELAY_MS + 100,
        ));
        visual.run_until_parked();
        assert!(visual.debug_bounds("group-panel").is_some());
    }

    #[test]
    fn shared_folder_marks_use_the_old_symbols_and_frame() {
        assert_eq!(
            crate::sidebar::group_list::SharedMark::Shared.symbol(),
            "person.2.fill"
        );
        assert_eq!(
            crate::sidebar::group_list::SharedMark::Waiting.symbol(),
            "icloud.and.arrow.down"
        );
        assert_eq!(
            crate::sidebar::group_list::SharedMark::Error.symbol(),
            "exclamationmark.icloud"
        );
        assert_eq!(crate::sidebar::group_list::SHARED_MARK_FRAME, (16.0, 10.0));
        assert_eq!(crate::sidebar::group_list::SHARED_MARK_POINTS, 10.0);
    }
}
