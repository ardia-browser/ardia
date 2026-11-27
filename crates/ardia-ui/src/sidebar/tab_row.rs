use std::sync::Arc;

use crate::scale::px;
use ardia_state::TabId;
use ardia_state::splits::SplitView;
use ardia_state::tabs::Tab;
use ardia_state::unread::{tab_unread, title_without_unread};
use ardia_theme::layout::sidebar;
use gpui::{
    AnyElement, ElementId, FontWeight, IntoElement, MouseButton, MouseDownEvent, ParentElement,
    Pixels, SharedString, Styled, div, prelude::*,
};

use crate::msg::{MenuTarget, Msg, RenameTarget};
use crate::primitives::controls::{IconButton, spinner, tooltip};
use crate::primitives::fade_label::fade_label;
use crate::primitives::favicon::render_favicon;
use crate::primitives::hairline::gradient_hairline;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::outer_glow::outer_glow;
use crate::primitives::unread::unread_count;
use crate::sidebar::away_title;
use crate::sidebar::drag::{self, DragKind, DropContext, DropSpot, Ghost, RowTarget};
use crate::sidebar::drag_motion;
use crate::sidebar::hover_card;
use crate::sidebar::list_motion;
use crate::sidebar::row_look::{self, RowFill};
use crate::window::chrome::{Chrome, TabDrag, tab_title};

pub const ROW_GROUP: &str = "tab-row";
pub const SLEEPING_TITLE_OPACITY: f32 = row_look::SLEEPING_TITLE_OPACITY;
pub const TITLE_GAP: f32 = 7.0;
pub const STATUS_GAP: f32 = 6.0;
pub const STATUS_GLYPH_FRAME: (f32, f32) = (18.0, 16.0);

pub fn row_id(prefix: &str, id: &str) -> ElementId {
    ElementId::Name(SharedString::from(format!("{prefix}:{id}")))
}

pub fn row_shell(
    id: ElementId,
    c: &Chrome,
    selected: bool,
    secondary: bool,
    indent: f32,
) -> gpui::Stateful<gpui::Div> {
    row_base(id, c, selected, secondary, indent, true)
}

fn painted(
    row: gpui::Stateful<gpui::Div>,
    c: &Chrome,
    fill: RowFill,
    hoverable: bool,
) -> gpui::Stateful<gpui::Div> {
    painted_with(row, c, fill, hoverable, None)
}

pub fn frame_pump() -> AnyElement {
    gpui::canvas(
        |_, window, _| window.request_animation_frame(),
        |_, _, _, _| {},
    )
    .absolute()
    .size_0()
    .into_any_element()
}

fn painted_with(
    row: gpui::Stateful<gpui::Div>,
    c: &Chrome,
    fill: RowFill,
    hoverable: bool,
    fade: Option<f32>,
) -> gpui::Stateful<gpui::Div> {
    let glow = if fill.glow {
        row_look::selected_glow(c)
    } else {
        Vec::new()
    };
    let faded_hover = match (fade, fill.hover, hoverable) {
        (Some(level), Some(hover), true) if level > 0.0 => Some(hover.opacity(level)),
        _ => None,
    };
    row.when_some(fill.rest.or(faded_hover), |this, color| this.bg(color))
        .when_some(fill.border, |this, hairline| {
            this.child(row_hairline(hairline))
        })
        .when(!glow.is_empty(), |this| {
            this.child(outer_glow(px(row_look::chrome_radius()), glow))
        })
        .when(hoverable, |this| {
            this.when_some(fill.hover.filter(|_| fade.is_none()), |this, hover| {
                this.hover(move |style| style.bg(hover))
            })
            .when_some(fill.pressed, |this, pressed| {
                this.active(move |style| style.bg(pressed))
            })
        })
}

pub fn row_hairline(hairline: row_look::Hairline) -> AnyElement {
    if hairline.top == hairline.bottom {
        return selection_hairline(hairline.top, hairline.width).into_any_element();
    }
    gradient_hairline(
        hairline.top,
        hairline.bottom,
        px(hairline.width),
        px(row_look::chrome_radius()),
    )
}

pub fn selection_hairline(color: gpui::Hsla, width: f32) -> gpui::Div {
    div()
        .absolute()
        .inset_0()
        .rounded(px(row_look::chrome_radius()))
        .border(px(width))
        .border_color(color)
}

pub fn row_base(
    id: ElementId,
    c: &Chrome,
    selected: bool,
    secondary: bool,
    indent: f32,
    hoverable: bool,
) -> gpui::Stateful<gpui::Div> {
    let row = div()
        .id(id)
        .group(ROW_GROUP)
        .relative()
        .flex_none()
        .h(px(sidebar::row_height()))
        .pl(px(sidebar::ROW_CONTENT_LEFT + indent))
        .pr(px(sidebar::ROW_TRAILING))
        .rounded(px(row_look::chrome_radius()))
        .flex()
        .items_center()
        .gap(px(TITLE_GAP));
    painted(
        row,
        c,
        row_look::row_fill(c, selected, secondary && !selected),
        hoverable,
    )
}

fn pick(
    c: &Chrome,
    tab: &Tab,
) -> impl Fn(&MouseDownEvent, &mut gpui::Window, &mut gpui::App) + 'static {
    let emit = c.emit.clone();
    let id = tab.id.clone();
    let key = c.window.id.as_str().to_owned();
    let was_active = c.is_active(&tab.id);
    move |event, window, cx| {
        hover_card::dismiss(&key, window, cx);
        let toggle = event.modifiers.platform || event.modifiers.control;
        crate::press_telemetry::note_press_started(
            event.click_count < 2 && !toggle && !event.modifiers.shift && !was_active,
            window.is_window_active(),
        );
        if event.click_count == 2 {
            emit.send(Msg::Rename(Some(RenameTarget::Tab(id.clone()))), window, cx);
            return;
        }
        if event.modifiers.alt && event.modifiers.shift && !event.modifiers.platform {
            emit.send(Msg::PickTabIntoGroup(id.clone()), window, cx);
            return;
        }
        emit.send(
            Msg::PickTab {
                tab: id.clone(),
                toggle,
                range: event.modifiers.shift,
            },
            window,
            cx,
        );
    }
}

fn menu(
    c: &Chrome,
    tab: &Tab,
) -> impl Fn(&MouseDownEvent, &mut gpui::Window, &mut gpui::App) + 'static {
    let emit = c.emit.clone();
    let id = tab.id.clone();
    let key = c.window.id.as_str().to_owned();
    move |event, window, cx| {
        cx.stop_propagation();
        hover_card::dismiss(&key, window, cx);
        emit.send(
            Msg::Menu(Some((MenuTarget::Tab(id.clone()), event.position))),
            window,
            cx,
        );
    }
}

fn middle_close(
    c: &Chrome,
    tab: &Tab,
) -> impl Fn(&MouseDownEvent, &mut gpui::Window, &mut gpui::App) + 'static {
    let emit = c.emit.clone();
    let id = tab.id.clone();
    move |_, window, cx| emit.send(Msg::CloseTab(id.clone()), window, cx)
}

pub fn drag_payload(c: &Chrome, tab: &Tab) -> TabDrag {
    TabDrag {
        tab: tab.id.clone(),
        title: tab_title(tab),
        favicon: c.favicon(tab),
        p: *c.p,
    }
}

pub fn shown_title(c: &Chrome, tab: &Tab) -> String {
    let title = tab.display_title();
    if tab.custom_title.as_deref().is_some_and(|t| !t.is_empty()) {
        return title;
    }
    let unread = tab_unread(&c.state.settings, tab);
    title_without_unread(&title, unread.as_ref()).to_owned()
}

pub fn title_element(c: &Chrome, tab: &Tab, active: bool) -> AnyElement {
    if c.renaming_tab(&tab.id) {
        return div()
            .flex_1()
            .min_w_0()
            .debug_selector(|| "rename-input".into())
            .child(c.rename_input.clone())
            .into_any_element();
    }
    let color = row_look::title_color(c, active);
    let marks = row_look::row_marks(c.state, tab);
    let size = row_look::title_size(c);
    let height = c.points(if row_look::quiet(c) { 17. } else { 18. });
    let resettable = !matches!(&tab.pin, Some(pin) if pin.is_tile());
    if let Some(away) = resettable
        .then(|| away_title::row_away_title(tab))
        .flatten()
    {
        return away_title::away_label(
            &away,
            away_title::AwayLabel {
                color,
                size,
                weight: FontWeight::NORMAL,
                height,
                struck: marks.struck,
                max_width: (c.layout.sidebar_width
                    - 2.0 * sidebar::INSET
                    - sidebar::ROW_CONTENT_LEFT
                    - sidebar::ROW_TRAILING
                    - row_look::icon_size(c)
                    - TITLE_GAP)
                    .max(0.0),
            },
        );
    }
    let label = fade_label(SharedString::from(shown_title(c, tab)), color, size)
        .weight(FontWeight::NORMAL)
        .line_height(height);
    div()
        .flex_1()
        .min_w_0()
        .relative()
        .flex()
        .items_center()
        .when(marks.struck, |this| this.opacity(SLEEPING_TITLE_OPACITY))
        .child(label)
        .when(marks.struck, |this| {
            this.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .top(px(height / 2.0))
                    .h(px(1.))
                    .bg(color),
            )
        })
        .into_any_element()
}

fn icon_slot(c: &Chrome, tab: &Tab, active: bool) -> AnyElement {
    let slot = SharedString::from(format!("tab-icon:{}", tab.id.as_str()));
    div()
        .debug_selector(move || slot.to_string())
        .flex_none()
        .relative()
        .child(icon_face(c, tab, active))
        .children(
            crate::content::peek_overlay::peek_mark(c, &tab.id, row_look::icon_size(c)).map(
                |mark| {
                    let key = SharedString::from(format!("peek-mark:{}", tab.id.as_str()));
                    div().debug_selector(move || key.to_string()).child(mark)
                },
            ),
        )
        .into_any_element()
}

fn icon_face(c: &Chrome, tab: &Tab, active: bool) -> AnyElement {
    let marks = row_look::row_marks(c.state, tab);
    let size = row_look::icon_size(c);
    let favicon = div()
        .flex_none()
        .relative()
        .when(marks.icon_dimmed(), |this| {
            this.opacity(row_look::SLEEPING_ICON_OPACITY)
        })
        .child(render_favicon(&c.favicon(tab), size, c.p))
        .children(
            row_look::marked_engine(c, tab, size)
                .map(|engine| row_look::engine_mark(c, engine, size)),
        );
    let resettable =
        !matches!(&tab.pin, Some(pin) if pin.is_tile()) && hover_card::away_from_pin(tab);
    if !resettable {
        return favicon.into_any_element();
    }
    let ink = if active {
        c.p.text_selected
    } else {
        c.p.text_tab
    };
    let group = SharedString::from(format!("reset:{}", tab.id.as_str()));
    let tip = match crate::keybindings::hint(c.state, "returnToPinnedUrl") {
        Some(keys) => format!("Back to Pinned URL {keys}"),
        None => "Back to Pinned URL".to_owned(),
    };
    div()
        .id(row_id("reset", tab.id.as_str()))
        .group(group.clone())
        .flex_none()
        .relative()
        .size(px(size))
        .tooltip(tooltip(tip.into(), c.p))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(
            c.emit
                .click(Msg::Store(ardia_state::Action::ReturnToPinnedUrl {
                    tab: tab.id.clone(),
                })),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .group_hover(group.clone(), |style| style.opacity(0.))
                .child(favicon),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .opacity(0.)
                .group_hover(group, |style| style.opacity(1.))
                .child(icon(Icon::Undo, c.points(11.), ink)),
        )
        .into_any_element()
}

fn pip_button(c: &Chrome, tab: &Tab) -> Option<AnyElement> {
    if !c.host.media_pip_open(&tab.id) {
        return None;
    }
    let (w, h) = STATUS_GLYPH_FRAME;
    let host = std::sync::Arc::clone(c.host);
    let id = tab.id.clone();
    Some(
        div()
            .id(row_id("pip", tab.id.as_str()))
            .flex_none()
            .ml(px(STATUS_GAP - TITLE_GAP))
            .w(px(c.points(w)))
            .h(px(c.look.icon_points(h)))
            .flex()
            .items_center()
            .justify_center()
            .tooltip(tooltip("Exit Picture in Picture".into(), c.p))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(move |_, _, _| host.toggle_media_pip(id.clone()))
            .child(icon(Icon::PictureInPicture, c.points(12.), c.p.text_tab))
            .into_any_element(),
    )
}

fn speaker(c: &Chrome, tab: &Tab) -> Option<AnyElement> {
    let mute = ardia_state::mute::mute_state(c.state, tab);
    if !tab.live.audible && mute.is_none() {
        return None;
    }
    let muted = mute.is_some();
    let (w, h) = STATUS_GLYPH_FRAME;
    Some(
        div()
            .id(row_id("mute", tab.id.as_str()))
            .debug_selector(|| "row-mute".into())
            .flex_none()
            .ml(px(STATUS_GAP - TITLE_GAP))
            .w(px(c.points(w)))
            .h(px(c.look.icon_points(h)))
            .flex()
            .items_center()
            .justify_center()
            .active(|s| s.scale(crate::primitives::tokens::press_scale::ICON))
            .tooltip(tooltip(ardia_state::mute::mute_title(mute).into(), c.p))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(
                c.emit
                    .click(Msg::Stores(ardia_state::mute::toggle_mute(c.state, tab))),
            )
            .child(icon(
                if muted {
                    Icon::SpeakerSlash
                } else {
                    Icon::Speaker
                },
                c.points(12.),
                c.p.text_tab,
            ))
            .into_any_element(),
    )
}

pub struct CloseControl {
    pub glyph: Icon,
    pub tooltip: String,
}

pub fn close_control(c: &Chrome, tab: &Tab) -> CloseControl {
    let shortcut = |title: &str| match crate::keybindings::hint(c.state, "closeTab") {
        Some(keys) => format!("{title} {keys}"),
        None => title.to_owned(),
    };
    if !c.state.in_pinned_container(tab.id.as_str()) {
        return CloseControl {
            glyph: Icon::XMark,
            tooltip: shortcut("Close Tab"),
        };
    }
    if !tab.page.has_page() {
        CloseControl {
            glyph: Icon::XMark,
            tooltip: "Remove Pinned Tab".to_owned(),
        }
    } else {
        CloseControl {
            glyph: Icon::Minus,
            tooltip: shortcut("Unload Tab"),
        }
    }
}

pub fn close_button(c: &Chrome, tab: &Tab) -> IconButton {
    let control = close_control(c, tab);
    IconButton::new(row_id("close", tab.id.as_str()), control.glyph, c.p)
        .glyph(row_look::CLOSE_GLYPH)
        .square(row_look::CLOSE_BOX, row_look::close_radius())
        .centres_ink()
        .color(c.p.icon)
        .fills(c.p.toolbar_hover, c.p.toolbar_pressed)
        .tooltip(control.tooltip, c.p)
        .on_click(c.emit.click(Msg::CloseTab(tab.id.clone())))
}

fn close_slot(c: &Chrome, tab: &Tab, active: bool, renaming: bool) -> AnyElement {
    let loading = tab.live.loading;
    let unread = tab_unread(&c.state.settings, tab);
    let ink = if active {
        c.p.text_selected
    } else {
        c.p.text_tab
    };
    let status = loading || unread.is_some();
    let hovered = row_look::is_hovered(c.window.id.as_str(), tab.id.as_str());
    div()
        .flex_none()
        .relative()
        .self_stretch()
        .flex()
        .items_center()
        .justify_end()
        .when(!renaming && hovered, |this| {
            this.min_w(px(row_look::CLOSE_BOX))
        })
        .when(status, |this| {
            this.child(
                div()
                    .flex()
                    .items_center()
                    .when(!renaming, |d| {
                        d.group_hover(ROW_GROUP, |style| style.opacity(0.))
                    })
                    .when(loading, |d| {
                        d.child(
                            div()
                                .mr(px(row_look::SPACE_XXS))
                                .child(spinner(sidebar::SPINNER_SIZE, c.p.text_secondary)),
                        )
                    })
                    .when_some(unread, |d, unread| {
                        d.child(unread_count(&unread, Some(ink), c.p.dark))
                    }),
            )
        })
        .when(!renaming && hovered, |this| {
            this.child(
                div()
                    .debug_selector(|| "row-close".into())
                    .absolute()
                    .right_0()
                    .top_0()
                    .bottom_0()
                    .flex()
                    .opacity(0.)
                    .group_hover(ROW_GROUP, |style| style.opacity(1.))
                    .items_center()
                    .child(close_button(c, tab)),
            )
        })
        .into_any_element()
}

pub fn attach_row_drag(
    row: gpui::Stateful<gpui::Div>,
    c: &Chrome,
    tab: &Tab,
    drops: &DropContext,
) -> gpui::Stateful<gpui::Div> {
    let payload = drag_payload(c, tab);
    let ghost = Ghost::new(
        c,
        tab,
        DragKind::Row,
        drag::row_ghost_width(c),
        sidebar::pinned_tile_height() * 1.5,
    );
    let key = c.window.id.as_str().to_owned();
    let press_key = key.clone();
    let begin_drops = drops.clone();
    let id = tab.id.clone();
    row.on_mouse_down(MouseButton::Left, move |event, _, _| {
        drag::note_press(&press_key, event.position)
    })
    .on_drag(payload, move |_, grab, window, cx| {
        drag::begin(&key, &id, DragKind::Row, &begin_drops, grab, &ghost);
        hover_card::dismiss(&key, window, cx);
        window.refresh();
        let mut ghost = ghost.clone();
        ghost.card = ghost.card.snapped(window);
        let ghost = ghost.view();
        cx.new(|_| ghost)
    })
    .on_drop({
        let drops = drops.clone();
        move |drag: &TabDrag, window, cx| drops.drop(drag, window, cx)
    })
}

pub fn row_wrapper(c: &Chrome, tab: &Tab, row: AnyElement) -> AnyElement {
    let pitch = f32::from(px(sidebar::row_pitch()));
    let room = drag_motion::row_room(c.window.id.as_str(), &tab.id).unwrap_or_else(|| {
        let (above, below) = drag::row_gaps(c, &tab.id);
        drag_motion::incoming_room(
            c.window.id.as_str(),
            &tab.id,
            if above { pitch } else { 0.0 },
            if below { pitch } else { 0.0 },
            std::time::Instant::now(),
        )
    });
    let collapse = room.hidden.then(|| room.collapse.unwrap_or(0.0));
    let target = RowTarget::new(c, tab);
    let drops = DropContext::new(c);
    let ghosts = (drops.first_row() == Some(&tab.id))
        .then(|| list_motion::ghosts_under(c.window.id.as_str(), &tab.id))
        .flatten();
    let sliding_down = !drag::active(c)
        && list_motion::offset(c.window.id.as_str(), &tab.id).is_some_and(|dy| dy < 0.0);
    div()
        .id(row_id("tabwrap", tab.id.as_str()))
        .when(sliding_down, |this| this.overflow_hidden())
        .flex_none()
        .flex()
        .flex_col()
        .when_some(collapse, |this, size| {
            this.h(Pixels::from(size))
                .mb(Pixels::from(
                    -(pitch - f32::from(px(sidebar::row_height()))),
                ))
                .overflow_hidden()
                .opacity(0.)
        })
        .when(room.moving, |this| this.child(frame_pump()))
        .on_drag_move::<TabDrag>(move |event, window, cx| target.moved(event, window, cx))
        .on_drop(move |drag: &TabDrag, window, cx| drops.drop(drag, window, cx))
        .on_drop({
            let emit = c.emit.clone();
            let window_id = c.window.id.clone();
            let index = c.window.tab_ids.iter().position(|t| t == &tab.id);
            move |paths: &gpui::ExternalPaths, window, cx| {
                if let Some(msg) = drag::file_drop(&window_id, index, paths) {
                    emit.send(msg, window, cx);
                }
            }
        })
        .on_drag_move::<gpui::ExternalItems>({
            let key = c.window.id.as_str().to_owned();
            let target = tab.id.clone();
            move |event, window, _| {
                drag::external_moved(
                    &key,
                    event.bounds,
                    event.event.position,
                    Some(&target),
                    window,
                )
            }
        })
        .on_drop({
            let emit = c.emit.clone();
            let window_id = c.window.id.clone();
            let shown = c.state.windows.get(&c.window.id).cloned();
            let fallback = c.window.tab_ids.iter().position(|t| t == &tab.id);
            move |items: &gpui::ExternalItems, window, cx| {
                let index = shown
                    .as_ref()
                    .and_then(|w| drag::external_index(window_id.as_str(), &w.tab_ids))
                    .or(fallback);
                if let Some(msg) = drag::items_drop(&window_id, index, items) {
                    emit.send(msg, window, cx);
                }
                window.refresh();
            }
        })
        .when(room.above > 0.0, |this| {
            this.child(drag::gap_of(room.above))
        })
        .child(list_motion::sliding(
            c.window.id.as_str(),
            &tab.id,
            &list_motion::origin_key(
                tab.profile_id.as_str(),
                c.state.group_of(tab.id.as_str()).map(|g| g.id.as_str()),
            ),
            !crate::sidebar::pager::paging(c.window.id.as_str()),
            div()
                .id(row_id("tabslide", tab.id.as_str()))
                .relative()
                .children(ghosts)
                .child(row)
                .when_some(
                    list_motion::appearing(c.window.id.as_str(), &tab.id),
                    |this, shown| this.opacity(shown).child(frame_pump()),
                )
                .into_any_element(),
        ))
        .when(room.below > 0.0, |this| {
            this.child(drag::gap_of(room.below))
        })
        .into_any_element()
}

pub fn tab_row(c: &Chrome, tab: &Arc<Tab>, depth: usize) -> AnyElement {
    let active = c.is_active(&tab.id);
    let selected = !active && c.is_selected(&tab.id);
    let renaming = c.renaming_tab(&tab.id);
    let indent = depth as f32 * sidebar::GROUP_INDENT;
    list_motion::note_row(
        c.window.id.as_str(),
        &tab.id,
        list_motion::RowSnap {
            title: SharedString::from(shown_title(c, tab)),
            favicon: c.favicon(tab),
            indent,
            hovered: row_look::is_hovered(c.window.id.as_str(), tab.id.as_str()),
            ink: row_look::title_color(c, false),
            hover: c.p.tab_hover,
            icon_size: row_look::icon_size(c),
            title_size: row_look::title_size(c),
            icon_ink: c.p.icon,
            palette: *c.p,
        },
    );
    let drops = DropContext::new(c);
    let split_half = drag::split_half(c, &tab.id);
    let row = div()
        .id(row_id("tab", tab.id.as_str()))
        .debug_selector({
            let id = tab.id.clone();
            move || format!("tab-row:{}", id.as_str())
        })
        .group(ROW_GROUP)
        .relative()
        .flex_none()
        .h(px(sidebar::row_height()))
        .when(active, |row| {
            row.child(crate::onboarding::tour::probe(
                c.window.id.clone(),
                crate::onboarding::tour::Anchor::Tabs,
            ))
        })
        .pl(px(sidebar::ROW_CONTENT_LEFT + indent))
        .pr(px(sidebar::ROW_TRAILING))
        .rounded(px(row_look::chrome_radius()))
        .flex()
        .items_center()
        .gap(px(TITLE_GAP));
    let (fade, fading) = row_look::hover_fade(c.window.id.as_str(), tab.id.as_str());
    let row = painted_with(
        row,
        c,
        row_look::row_fill(c, active, selected),
        !renaming,
        Some(fade),
    )
    .when(fading, |this| this.child(frame_pump()))
    .on_mouse_down(MouseButton::Left, pick(c, tab))
    .on_mouse_up(MouseButton::Left, |_, _, _| {
        crate::press_telemetry::note_press_released()
    })
    .on_mouse_down(MouseButton::Right, menu(c, tab))
    .on_mouse_down(MouseButton::Middle, middle_close(c, tab));
    let row = attach_row_drag(row, c, tab, &drops);
    let row = hover_card::attach(row, c, tab).map(|this| match split_half {
        None => this
            .child(icon_slot(c, tab, active))
            .children(pip_button(c, tab))
            .children(speaker(c, tab))
            .child(title_element(c, tab, active))
            .child(close_slot(c, tab, active, renaming)),
        Some(look) => this
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .items_center()
                    .gap(px(TITLE_GAP))
                    .opacity(1.0 - look.shown)
                    .child(icon_slot(c, tab, active))
                    .children(pip_button(c, tab))
                    .children(speaker(c, tab))
                    .child(title_element(c, tab, active))
                    .child(close_slot(c, tab, active, renaming)),
            )
            .child(split_preview(c, tab, look, active))
            .when(look.moving, |d| d.child(frame_pump())),
    });
    row_wrapper(c, tab, row.into_any_element())
}

pub const PANE_INSET: f32 = 4.0;
pub const PANE_GAP: f32 = 4.0;
pub const PREVIEW_MS: u64 = 120;

pub fn split_preview(c: &Chrome, tab: &Tab, look: drag::PreviewLook, active: bool) -> AnyElement {
    let half = look.half;
    let (rest, empty) = drag::active_pane_tones(c);
    let corner = (row_look::chrome_radius() - PANE_INSET).max(0.0);
    let height = sidebar::row_height() - PANE_INSET * 2.0;
    let pane = div()
        .flex_1()
        .min_w_0()
        .h(px(height))
        .rounded(px(corner))
        .bg(rest)
        .pl(px(6.))
        .pr(px(2.))
        .flex()
        .items_center()
        .gap(px(4.))
        .child(render_favicon(
            &c.favicon(tab),
            c.look.icon_points(14.),
            c.p,
        ))
        .child(fade_label(tab_title(tab), c.p.text_tab, c.points(12.)));
    let dragged = drag::snapshot(c)
        .dragging
        .and_then(|id| c.state.tab(id.as_str()).cloned());
    let slot = div()
        .flex_1()
        .min_w_0()
        .h(px(height))
        .rounded(px(corner))
        .bg(empty)
        .pl(px(6.))
        .pr(px(2.))
        .flex()
        .items_center()
        .gap(px(4.))
        .when_some(dragged, |d, moving| {
            d.child(render_favicon(
                &c.favicon(&moving),
                c.look.icon_points(14.),
                c.p,
            ))
            .child(fade_label(
                tab_title(&moving),
                c.p.text_selected,
                c.points(12.),
            ))
        });
    let frame = div()
        .absolute()
        .inset_0()
        .rounded(px(row_look::chrome_radius()))
        .when(!active, |d| d.bg(c.p.tab_selected))
        .opacity(look.shown);
    let Some(width) = look.width else {
        let (first, second) = match half {
            drag::SplitHalf::Left => (slot.into_any_element(), pane.into_any_element()),
            drag::SplitHalf::Right => (pane.into_any_element(), slot.into_any_element()),
        };
        return frame
            .p(px(PANE_INSET))
            .flex()
            .gap(px(PANE_GAP))
            .child(first)
            .child(second)
            .into_any_element();
    };
    let inset = f32::from(px(PANE_INSET));
    let gap = f32::from(px(PANE_GAP));
    let slot_w = ((width - inset * 2.0 - gap) / 2.0).max(0.0);
    let pitch = slot_w + gap;
    let place = |x: f32, d: gpui::Div| {
        d.absolute()
            .top(px(PANE_INSET))
            .left(Pixels::from(inset + x))
            .w(Pixels::from(slot_w))
            .flex_none()
    };
    frame
        .child(place((1.0 - look.to_left) * pitch, slot))
        .child(place(look.to_left * pitch, pane))
        .into_any_element()
}

pub fn split_row(
    c: &Chrome,
    split: &Arc<SplitView>,
    tabs: &[Arc<Tab>],
    depth: usize,
) -> AnyElement {
    let window = c.window.id.as_str();
    let group = tabs
        .first()
        .and_then(|t| c.state.group_of(t.id.as_str()))
        .map(|g| g.id.as_str().to_owned());
    list_motion::sliding(
        window,
        &TabId::from(format!("~split:{}", split.id.as_str()).as_str()),
        &list_motion::origin_key(c.window.profile_id.as_str(), group.as_deref()),
        !crate::sidebar::pager::paging(window),
        split_row_body(c, split, tabs, depth),
    )
    .into_any_element()
}

fn split_row_body(
    c: &Chrome,
    split: &Arc<SplitView>,
    tabs: &[Arc<Tab>],
    depth: usize,
) -> AnyElement {
    let active = tabs.iter().any(|t| c.is_active(&t.id));
    let indent = depth as f32 * sidebar::GROUP_INDENT;
    let p = *c.p;
    let count = tabs.len();
    row_shell(row_id("split", split.id.as_str()), c, active, false, indent)
        .gap(px(0.))
        .children(tabs.iter().enumerate().map(|(index, tab)| {
            let current = c.is_active(&tab.id);
            div()
                .id(row_id("pane", tab.id.as_str()))
                .flex_1()
                .min_w_0()
                .h_full()
                .flex()
                .items_center()
                .gap(px(6.))
                .when(index > 0, |this| {
                    this.pl(px(7.)).border_l(px(1.)).border_color(p.divider)
                })
                .when(index + 1 < count, |this| this.pr(px(5.)))
                .on_mouse_down(MouseButton::Left, pick(c, tab))
                .on_mouse_up(MouseButton::Left, |_, _, _| {
                    crate::press_telemetry::note_press_released()
                })
                .on_mouse_down(MouseButton::Right, menu(c, tab))
                .child(render_favicon(
                    &c.favicon(tab),
                    c.look.icon_points(sidebar::ROW_FAVICON),
                    c.p,
                ))
                .child(title_element(c, tab, current))
        }))
        .child(
            div()
                .flex_none()
                .opacity(0.)
                .group_hover(ROW_GROUP, |style| style.opacity(1.))
                .child(
                    IconButton::new(row_id("unsplit", split.id.as_str()), Icon::XMark, c.p)
                        .glyph(10.)
                        .square(sidebar::ROW_CLOSE_SLOT, 6.)
                        .on_click(c.emit.click(Msg::Store(ardia_state::Action::Unsplit {
                            split: split.id.clone(),
                        }))),
                ),
        )
        .into_any_element()
}

fn new_tab_tooltip(c: &Chrome) -> String {
    let title = match crate::keybindings::hint(c.state, "newTab") {
        Some(keys) => format!("New Tab {keys}"),
        None => "New Tab".to_owned(),
    };
    format!(
        "{title} — {}-click to open in Split View",
        if cfg!(target_os = "macos") {
            "⌥"
        } else {
            "Alt"
        }
    )
}

pub fn sliding_new_tab_row(c: &Chrome) -> AnyElement {
    list_motion::sliding(
        c.window.id.as_str(),
        &TabId::from(NEW_TAB_ROW_KEY),
        c.window.profile_id.as_str(),
        !crate::sidebar::pager::paging(c.window.id.as_str()),
        new_tab_row(c),
    )
    .into_any_element()
}

pub const NEW_TAB_ROW_KEY: &str = "~new-tab-row";

pub fn new_tab_row(c: &Chrome) -> AnyElement {
    let p = *c.p;
    let tokens = row_look::tokens_of(c);
    let quiet = row_look::quiet(c);
    let emit = c.emit.clone();
    let hover = if quiet {
        tokens.quiet_hover
    } else {
        p.tab_hover
    };
    let pressed = if quiet {
        tokens.quiet_pressed
    } else {
        p.tab_pressed
    };
    let label_ink = if quiet {
        p.text_tab.alpha(tokens.quiet_faint_text)
    } else {
        tokens.new_tab_label
    };
    let hover_ink = if quiet {
        p.text_tab.alpha(tokens.quiet_text)
    } else {
        tokens.new_tab_label
    };
    let plus_ink = if quiet {
        label_ink
    } else {
        tokens.new_tab_icon
    };
    let plus_hover = if quiet {
        hover_ink
    } else {
        tokens.new_tab_icon
    };
    let show_tab_menu_button = c.state.settings.show_tab_menu_button;
    let end_room = drag_motion::end_room(c.window.id.as_str());
    let gap_end = match end_room {
        Some(height) => height,
        None => {
            let open = (drag::snapshot(c).live()
                && drag::snapshot(c).spot == Some(DropSpot::RowsEnd))
                || drag::incoming(c) == Some(drag::Incoming::End);
            if open {
                f32::from(px(sidebar::row_pitch()))
            } else {
                0.0
            }
        }
    };
    let end_sidebar = c.layout.sidebar.map(|r| (r.x, r.w));
    let cross_window = c.window.id.clone();
    let land_window = c.window.id.clone();
    let land_emit = c.emit.clone();
    let land_out_window = c.window.id.clone();
    let land_out_emit = c.emit.clone();
    let drops = DropContext::new(c);
    let end_key = c.window.id.as_str().to_owned();
    let new_tab_key = c.window.id.as_str().to_owned();
    let hover_key = c.window.id.as_str().to_owned();
    let (new_tab_fade, new_tab_fading) = row_look::hover_fade(&hover_key, "new-tab-row");
    let row_hovered = row_look::is_hovered(&hover_key, "new-tab-row");
    let size = row_look::icon_size(c);
    let plus = if quiet { c.points(10.) } else { c.points(13.) };
    div()
        .id("new-tab-wrap")
        .flex_none()
        .flex()
        .flex_col()
        .on_drag_move::<TabDrag>(move |event, window, cx| {
            drag::note_cross_move(&cross_window, event, window, cx);
            drag::note_sidebar(&end_key, end_sidebar);
            drag::point_moved(&end_key, event.event.position, window, cx);
        })
        .on_drop(move |drag: &TabDrag, window, cx| drops.drop(drag, window, cx))
        .on_drop({
            let emit = c.emit.clone();
            let window_id = c.window.id.clone();
            move |paths: &gpui::ExternalPaths, window, cx| {
                if let Some(msg) = drag::file_drop(&window_id, None, paths) {
                    emit.send(msg, window, cx);
                }
            }
        })
        .on_drag_move::<gpui::ExternalItems>({
            let key = c.window.id.as_str().to_owned();
            move |event, window, _| {
                drag::external_moved(&key, event.bounds, event.event.position, None, window)
            }
        })
        .on_drop({
            let emit = c.emit.clone();
            let window_id = c.window.id.clone();
            move |items: &gpui::ExternalItems, window, cx| {
                drag::external_index(window_id.as_str(), &[]);
                if let Some(msg) = drag::items_drop(&window_id, None, items) {
                    emit.send(msg, window, cx);
                }
                window.refresh();
            }
        })
        .on_mouse_up(MouseButton::Left, move |_, w, cx| {
            drag::land_cross(&land_window, &land_emit, w, cx)
        })
        .on_mouse_up_out(MouseButton::Left, move |_, w, cx| {
            drag::land_cross(&land_out_window, &land_out_emit, w, cx)
        })
        .child(drag::note_window_bounds(c))
        .when(gap_end > 0.0, |this| this.child(drag::gap_of(gap_end)))
        .children(drag_motion::landing_ghost(c.window.id.as_str()))
        .when(drag::external_live(c), |this| this.child(frame_pump()))
        .children(drag::edge_glow(c))
        .children(crate::sidebar::selected_pill::selected_row_pill(c))
        .child(
            div()
                .id("new-tab-row")
                .debug_selector(|| "new-tab-row".into())
                .on_hover(move |hovered, window, _| {
                    row_look::set_hovered(&hover_key, "new-tab-row", *hovered, window)
                })
                .group("new-tab-row")
                .relative()
                .flex_none()
                .h(px(sidebar::row_height()))
                .flex()
                .items_center()
                .rounded(px(row_look::chrome_radius()))
                .child(
                    div()
                        .id("new-tab-press")
                        .flex_1()
                        .h_full()
                        .pl(px(sidebar::ROW_CONTENT_LEFT))
                        .pr(px(new_tab_press_right(show_tab_menu_button)))
                        .rounded(px(row_look::chrome_radius()))
                        .flex()
                        .items_center()
                        .gap(px(TITLE_GAP))
                        .when(new_tab_fade > 0.0, |d| d.bg(hover.opacity(new_tab_fade)))
                        .when(new_tab_fading, |d| d.child(frame_pump()))
                        .active(move |style| style.bg(pressed))
                        .tooltip(tooltip(new_tab_tooltip(c).into(), c.p))
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            hover_card::dismiss(&new_tab_key, window, cx)
                        })
                        .on_click({
                            let emit = c.emit.clone();
                            move |event, window, cx| {
                                let msg = if event.modifiers().alt {
                                    Msg::command("openSplitPane")
                                } else {
                                    Msg::command("newTab")
                                };
                                emit.send(msg, window, cx);
                            }
                        })
                        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
                            cx.stop_propagation();
                            emit.send(
                                Msg::Menu(Some((MenuTarget::NewTab, event.position))),
                                window,
                                cx,
                            );
                        })
                        .child(
                            div()
                                .flex_none()
                                .size(px(size))
                                .relative()
                                .child(
                                    div()
                                        .absolute()
                                        .inset_0()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .group_hover("new-tab-row", |s| s.opacity(0.))
                                        .child(icon(Icon::Plus, plus, plus_ink)),
                                )
                                .child(
                                    div()
                                        .absolute()
                                        .inset_0()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .opacity(0.)
                                        .group_hover("new-tab-row", |s| s.opacity(1.))
                                        .child(icon(Icon::Plus, plus, plus_hover)),
                                ),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(row_look::title_size(c)))
                                .text_color(label_ink)
                                .group_hover("new-tab-row", move |s| s.text_color(hover_ink))
                                .whitespace_nowrap()
                                .child("New Tab"),
                        ),
                )
                .child(
                    div()
                        .absolute()
                        .right(px(sidebar::ROW_TRAILING))
                        .top_0()
                        .bottom_0()
                        .flex()
                        .items_center()
                        .when(show_tab_menu_button, |this| {
                            this.child(
                                div()
                                    .when(quiet, |d| {
                                        d.opacity(0.).group_hover("new-tab-row", |s| s.opacity(1.))
                                    })
                                    .child(
                                        IconButton::new("new-tab-overflow", Icon::ChevronDown, c.p)
                                            .glyph(10.)
                                            .square(
                                                row_look::CLOSE_BOX,
                                                crate::sidebar::row_look::close_radius(),
                                            )
                                            .color(if row_hovered {
                                                p.text_secondary
                                            } else {
                                                p.text_tertiary
                                            })
                                            .fills(p.toolbar_hover, p.toolbar_pressed)
                                            .tooltip("Open and recently closed tabs", c.p)
                                            .on_click({
                                                let emit = c.emit.clone();
                                                move |event, window, cx| {
                                                    let at = event.position();
                                                    emit.send(
                                                        Msg::Menu(Some((
                                                            MenuTarget::SidebarOverflow,
                                                            at,
                                                        ))),
                                                        window,
                                                        cx,
                                                    );
                                                }
                                            }),
                                    ),
                            )
                        }),
                ),
        )
        .into_any_element()
}

pub fn new_tab_press_right(show_tab_menu_button: bool) -> f32 {
    if show_tab_menu_button {
        sidebar::ROW_TRAILING + row_look::CLOSE_BOX + sidebar::ROW_TRAILING
    } else {
        sidebar::ROW_TRAILING * 2.0
    }
}

#[cfg(test)]
mod close_button_tests {
    use gpui::{Bounds, Modifiers, Pixels, TestAppContext, VisualTestContext, point, px};

    use crate::tests::support::Browser;

    fn row_bounds(
        browser: &Browser,
        cx: &mut TestAppContext,
        tab: &ardia_state::TabId,
    ) -> Bounds<Pixels> {
        let selector: &'static str =
            Box::leak(format!("tab-row:{}", tab.as_str()).into_boxed_str());
        browser.settle_rows(cx);
        browser.bounds(cx, selector).expect("the row is drawn")
    }

    fn point_at(browser: &Browser, cx: &mut TestAppContext, at: gpui::Point<Pixels>) {
        let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
        visual.simulate_mouse_move(at, None, Modifiers::none());
        visual.run_until_parked();
        browser.redraw(cx);
    }

    fn two_tabs(cx: &mut TestAppContext) -> (Browser, ardia_state::TabId, ardia_state::TabId) {
        let browser = Browser::open(cx);
        let first = browser.new_tab(cx, "https://a.test/");
        let second = browser.new_tab(cx, "https://b.test/");
        (browser, first, second)
    }

    #[gpui::test]
    fn the_close_button_shows_on_the_hovered_row_in_the_same_frame(cx: &mut TestAppContext) {
        let (browser, first, _) = two_tabs(cx);
        let row = row_bounds(&browser, cx, &first);
        point_at(&browser, cx, row.center());
        let close = browser
            .bounds(cx, "row-close")
            .expect("the hovered row shows its close button");
        assert!(row.contains(&close.center()));
        assert_eq!(row_bounds(&browser, cx, &first), row);
    }

    #[gpui::test]
    fn the_close_button_goes_when_the_pointer_leaves(cx: &mut TestAppContext) {
        let (browser, first, _) = two_tabs(cx);
        let row = row_bounds(&browser, cx, &first);
        point_at(&browser, cx, row.center());
        assert!(browser.bounds(cx, "row-close").is_some());
        point_at(&browser, cx, point(row.right() + px(400.), row.center().y));
        assert!(browser.bounds(cx, "row-close").is_none());
    }

    #[gpui::test]
    fn the_selected_row_shows_no_close_button_until_hovered(cx: &mut TestAppContext) {
        let (browser, _, second) = two_tabs(cx);
        assert_eq!(browser.active(), second);
        let row = row_bounds(&browser, cx, &second);
        point_at(&browser, cx, point(row.right() + px(400.), row.center().y));
        assert!(browser.bounds(cx, "row-close").is_none());
        point_at(&browser, cx, row.center());
        let close = browser
            .bounds(cx, "row-close")
            .expect("the hovered selected row shows it");
        assert!(row.contains(&close.center()));
    }

    #[gpui::test]
    fn a_row_being_renamed_shows_no_close_button(cx: &mut TestAppContext) {
        let (browser, first, _) = two_tabs(cx);
        let row = row_bounds(&browser, cx, &first);
        point_at(&browser, cx, row.center());
        let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
        visual.simulate_click(row.center(), Modifiers::none());
        visual.simulate_event(gpui::MouseDownEvent {
            button: gpui::MouseButton::Left,
            position: row.center(),
            modifiers: Modifiers::none(),
            click_count: 2,
            first_mouse: false,
        });
        visual.simulate_event(gpui::MouseUpEvent {
            button: gpui::MouseButton::Left,
            position: row.center(),
            modifiers: Modifiers::none(),
            click_count: 2,
        });
        visual.run_until_parked();
        browser.redraw(cx);
        assert!(browser.bounds(cx, "rename-input").is_some());
        assert!(browser.bounds(cx, "row-close").is_none());
    }
}
