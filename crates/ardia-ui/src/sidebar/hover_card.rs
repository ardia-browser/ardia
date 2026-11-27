use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::scale::px;
use ardia_state::TabId;
use ardia_state::model::SidebarSide;
use ardia_state::tabs::Tab;
use ardia_theme::motion::{CubicBezier, HOVER_CARD_DELAY_MS, HOVER_CARD_FADE_MS};
use gpui::{
    AnchoredPositionMode, Animation, AnimationExt, AnyElement, App, Bounds, FontWeight, Hsla,
    IntoElement, MouseButton, ParentElement, Pixels, Point, Styled, Window, anchored, canvas,
    deferred, div, point, prelude::*,
};

use crate::msg::{Emit, Msg};
use crate::primitives::fade_label::fade_label;
use crate::primitives::favicon::render_favicon;
use crate::primitives::glass_states::{
    GLASS_CONTROL_GROUP, GlassBacking, GlassStates, stateful_glass,
};
use crate::primitives::icons::{Icon, icon};
use crate::sidebar::row_look;
use crate::window::chrome::{Chrome, tab_title};

pub const WIDTH: f32 = 264.0;
pub const GAP: f32 = 8.0;
pub const PAD: f32 = 10.0;
pub const HEADER: f32 = 18.0;
pub const WINDOW_MARGIN: f32 = 8.0;
pub const LEAVE_TOWARD_MS: u64 = ardia_theme::motion::HOVER_CARD_LEAVE_TOWARD_MS;
pub const ACTION_HEIGHT: f32 = 44.0;
pub const ACTION_GAP: f32 = 4.0;
pub const PANEL_RADIUS: f32 = 12.0;
pub const TILE_RADIUS: f32 = 8.0;
pub const CAPTION_RISE: f32 = 1.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Shown {
    pub tab: TabId,
    pub anchor: Bounds<Pixels>,
    pub generation: u64,
}

#[derive(Clone, Debug, Default)]
pub struct CardState {
    pub generation: u64,
    pub leave_generation: u64,
    pub pending: Option<TabId>,
    pub pointer_moved: bool,
    pub shown: Option<Shown>,
    pub leaving: Option<Shown>,
    pub card_hovered: bool,
    pub anchors: HashMap<TabId, Bounds<Pixels>>,
}

thread_local! {
    static CARDS: RefCell<HashMap<String, CardState>> = RefCell::new(HashMap::new());
}

fn with_state<R>(window: &str, f: impl FnOnce(&mut CardState) -> R) -> R {
    CARDS.with(|cards| f(cards.borrow_mut().entry(window.to_owned()).or_default()))
}

pub fn shown_tab(window: &str) -> Option<TabId> {
    with_state(window, |s| s.shown.as_ref().map(|shown| shown.tab.clone()))
}

fn fade() -> impl Fn(f32) -> f32 {
    |t| CubicBezier::HOVER_CARD.ease(f64::from(t)) as f32
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub side: SidebarSide,
    pub window_width: f32,
    pub sidebar_edge: f32,
}

pub fn card_origin(anchor: Bounds<Pixels>, frame: Frame, scale: f32) -> (f32, f32) {
    card_origin_sized(anchor, frame, scale, WIDTH)
}

pub fn card_origin_sized(
    anchor: Bounds<Pixels>,
    frame: Frame,
    scale: f32,
    width: f32,
) -> (f32, f32) {
    let left = f32::from(anchor.origin.x);
    let right = f32::from(anchor.right());
    let center = f32::from(anchor.center().y);
    let gap = GAP * scale;
    let top = (center - (PAD + HEADER / 2.0) * scale)
        .round()
        .max(WINDOW_MARGIN * scale);
    match frame.side {
        SidebarSide::Right => {
            let edge = left.min(frame.sidebar_edge);
            (edge - gap - width * scale, top)
        }
        SidebarSide::Left => (right.max(frame.sidebar_edge) + gap, top),
    }
}

fn refresh_after(
    window: &mut Window,
    cx: &mut App,
    wait: Duration,
    then: impl FnOnce() -> bool + 'static,
) {
    window
        .spawn(cx, async move |cx| {
            cx.background_executor().timer(wait).await;
            if then() {
                let _ = cx.update(|window, _| window.refresh());
            }
        })
        .detach();
}

pub fn dismiss(window_key: &str, window: &mut Window, cx: &mut App) {
    let key = window_key.to_owned();
    let leaving = with_state(window_key, |s| {
        s.pending = None;
        s.card_hovered = false;
        s.generation += 1;
        let shown = s.shown.take()?;
        s.leaving = Some(shown);
        s.leave_generation += 1;
        Some(s.leave_generation)
    });
    let Some(leave) = leaving else {
        return;
    };
    window.refresh();
    refresh_after(
        window,
        cx,
        Duration::from_millis(HOVER_CARD_FADE_MS),
        move || {
            with_state(&key, |s| {
                if s.leave_generation == leave {
                    s.leaving = None;
                    true
                } else {
                    false
                }
            })
        },
    );
}

pub fn row_hovered(
    window_key: &str,
    tab: &TabId,
    hovered: bool,
    side: SidebarSide,
    window: &mut Window,
    cx: &mut App,
) {
    if hovered {
        if crate::window::hover_hold::hover_held(window_key) {
            return;
        }
        let showing_other = with_state(window_key, |s| {
            s.shown.as_ref().is_some_and(|shown| &shown.tab != tab)
        });
        if showing_other {
            dismiss(window_key, window, cx);
        }
        let generation = with_state(window_key, |s| {
            s.generation += 1;
            s.pending = Some(tab.clone());
            s.pointer_moved = false;
            s.generation
        });
        let key = window_key.to_owned();
        let target = tab.clone();
        refresh_after(
            window,
            cx,
            Duration::from_millis(HOVER_CARD_DELAY_MS),
            move || {
                let held = crate::window::hover_hold::hover_held(&key);
                with_state(&key, |s| {
                    if held
                        || s.generation != generation
                        || s.pending.as_ref() != Some(&target)
                        || !s.pointer_moved
                    {
                        return false;
                    }
                    let Some(anchor) = s.anchors.get(&target).copied() else {
                        return false;
                    };
                    s.pending = None;
                    s.leaving = None;
                    s.shown = Some(Shown {
                        tab: target.clone(),
                        anchor,
                        generation,
                    });
                    crate::press_telemetry::note_hover_card_shown();
                    true
                })
            },
        );
        return;
    }
    let shown = with_state(window_key, |s| {
        if s.pending.as_ref() == Some(tab) {
            s.pending = None;
            s.generation += 1;
        }
        s.shown.clone().filter(|shown| &shown.tab == tab)
    });
    let Some(shown) = shown else {
        return;
    };
    let mouse = window.mouse_position();
    let toward = match side {
        SidebarSide::Right => mouse.x <= shown.anchor.origin.x,
        SidebarSide::Left => mouse.x >= shown.anchor.right(),
    };
    if !toward {
        dismiss(window_key, window, cx);
        return;
    }
    let key = window_key.to_owned();
    let generation = shown.generation;
    let wait = Duration::from_millis(LEAVE_TOWARD_MS);
    window
        .spawn(cx, async move |cx| {
            cx.background_executor().timer(wait).await;
            let _ = cx.update(|window, cx| {
                let stale = with_state(&key, |s| {
                    !s.card_hovered && s.shown.as_ref().is_some_and(|x| x.generation == generation)
                });
                if stale {
                    dismiss(&key, window, cx);
                }
            });
        })
        .detach();
}

pub fn anchor_probe(window_key: &str, tab: &TabId) -> AnyElement {
    let key = window_key.to_owned();
    let tab = tab.clone();
    canvas(
        move |bounds, _, _| {
            with_state(&key, |s| {
                if s.pending.as_ref() == Some(&tab)
                    || s.shown.as_ref().is_some_and(|shown| shown.tab == tab)
                {
                    s.anchors.insert(tab.clone(), bounds);
                } else {
                    s.anchors.remove(&tab);
                }
            });
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
    .into_any_element()
}

pub fn frame_of(c: &Chrome) -> Frame {
    let side = c.state.settings.sidebar_side;
    let scale = crate::scale::current();
    let window_width = c.layout.width * scale;
    let sidebar_edge = match (c.layout.sidebar, side) {
        (Some(rect), SidebarSide::Right) => rect.x * scale,
        (Some(rect), SidebarSide::Left) => (rect.x + rect.w) * scale,
        (None, SidebarSide::Right) => window_width - c.layout.sidebar_width * scale,
        (None, SidebarSide::Left) => c.layout.sidebar_width * scale,
    };
    Frame {
        side,
        window_width,
        sidebar_edge,
    }
}

pub fn attach(
    row: gpui::Stateful<gpui::Div>,
    c: &Chrome,
    tab: &Arc<Tab>,
) -> gpui::Stateful<gpui::Div> {
    let key = c.window.id.as_str().to_owned();
    let id = tab.id.clone();
    if !c.state.settings.show_tab_hover_menu {
        return row
            .on_hover(move |hovered, window, _| {
                row_look::set_hovered(&key, id.as_str(), *hovered, window)
            })
            .tooltip(crate::primitives::controls::tooltip(
                row_look::plain_tooltip(tab).into(),
                c.p,
            ));
    }
    let side = c.state.settings.sidebar_side;
    let card = card_for(c, tab);
    row.on_hover(move |hovered, window, cx| {
        row_look::set_hovered(&key, id.as_str(), *hovered, window);
        row_hovered(&key, &id, *hovered, side, window, cx)
    })
    .on_mouse_move({
        let key = c.window.id.as_str().to_owned();
        let id = tab.id.clone();
        move |_, _, _| {
            with_state(&key, |s| {
                if s.pending.as_ref() == Some(&id) {
                    s.pointer_moved = true;
                }
            })
        }
    })
    .child(anchor_probe(c.window.id.as_str(), &tab.id))
    .children(card)
}

fn card_for(c: &Chrome, tab: &Arc<Tab>) -> Option<AnyElement> {
    let key = c.window.id.as_str();
    let (shown, leaving) = with_state(key, |s| {
        (
            s.shown.clone().filter(|x| x.tab == tab.id),
            s.leaving.clone().filter(|x| x.tab == tab.id),
        )
    });
    let (state, entering) = match (shown, leaving) {
        (Some(shown), _) => (shown, true),
        (None, Some(leaving)) => (leaving, false),
        (None, None) => return None,
    };
    let frame = frame_of(c);
    let scale = crate::scale::current();
    let player = c.host.shows_mini_player(&tab.id);
    let width = if player {
        crate::media::mini_player::WIDTH
    } else {
        WIDTH
    };
    let (x, y) = card_origin_sized(state.anchor, frame, scale, width);
    let body = player
        .then(|| crate::media::mini_player::hover_player(c, tab))
        .flatten()
        .unwrap_or_else(|| tab_card(c, tab));
    let hover_key = key.to_owned();
    let panel = div()
        .id(("hover-card", state.generation as usize))
        .debug_selector(|| "tab-hover-card".into())
        .occlude()
        .on_hover(move |hovered, window, cx| {
            with_state(&hover_key, |s| s.card_hovered = *hovered);
            if !*hovered {
                dismiss(&hover_key, window, cx);
            }
        })
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(body);
    let animated = if entering {
        panel
            .with_animation(
                ("hover-card-in", state.generation as usize),
                Animation::new(Duration::from_millis(HOVER_CARD_FADE_MS)).with_easing(fade()),
                |el, t| el.opacity(t),
            )
            .into_any_element()
    } else {
        panel
            .with_animation(
                ("hover-card-out", state.generation as usize),
                Animation::new(Duration::from_millis(HOVER_CARD_FADE_MS)).with_easing(fade()),
                |el, t| el.opacity(1.0 - t),
            )
            .into_any_element()
    };
    Some(
        deferred(
            anchored()
                .position_mode(AnchoredPositionMode::Window)
                .position(point(gpui::px(x), gpui::px(y)))
                .snap_to_window_with_margin(px(WINDOW_MARGIN))
                .child(animated),
        )
        .with_priority(2)
        .into_any_element(),
    )
}

pub fn attach_card(
    row: gpui::Stateful<gpui::Div>,
    c: &Chrome,
    key: &TabId,
    width: f32,
    also: impl Fn(&bool, &mut Window, &mut App) + 'static,
    body: impl FnOnce() -> AnyElement,
) -> gpui::Stateful<gpui::Div> {
    if !c.state.settings.show_tab_hover_menu {
        return row.on_hover(also);
    }
    let window_key = c.window.id.as_str().to_owned();
    let side = c.state.settings.sidebar_side;
    let id = key.clone();
    let card = card_shell(c, key, width, body);
    row.on_hover(move |hovered, window, cx| {
        also(hovered, window, cx);
        row_hovered(&window_key, &id, *hovered, side, window, cx)
    })
    .on_mouse_move({
        let window_key = c.window.id.as_str().to_owned();
        let id = key.clone();
        move |_, _, _| {
            with_state(&window_key, |s| {
                if s.pending.as_ref() == Some(&id) {
                    s.pointer_moved = true;
                }
            })
        }
    })
    .child(anchor_probe(c.window.id.as_str(), key))
    .children(card)
}

fn card_shell(
    c: &Chrome,
    key: &TabId,
    width: f32,
    body: impl FnOnce() -> AnyElement,
) -> Option<AnyElement> {
    let window_key = c.window.id.as_str();
    let (shown, leaving) = with_state(window_key, |s| {
        (
            s.shown.clone().filter(|x| &x.tab == key),
            s.leaving.clone().filter(|x| &x.tab == key),
        )
    });
    let (state, entering) = match (shown, leaving) {
        (Some(shown), _) => (shown, true),
        (None, Some(leaving)) => (leaving, false),
        (None, None) => return None,
    };
    let (x, y) = card_origin_sized(state.anchor, frame_of(c), crate::scale::current(), width);
    let hover_key = window_key.to_owned();
    let panel = div()
        .id(("live-hover-card", state.generation as usize))
        .debug_selector(|| "live-hover-card".into())
        .occlude()
        .on_hover(move |hovered, window, cx| {
            with_state(&hover_key, |s| s.card_hovered = *hovered);
            if !*hovered {
                dismiss(&hover_key, window, cx);
            }
        })
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(body());
    let animated = panel
        .with_animation(
            (
                if entering {
                    "live-card-in"
                } else {
                    "live-card-out"
                },
                state.generation as usize,
            ),
            Animation::new(Duration::from_millis(HOVER_CARD_FADE_MS)).with_easing(fade()),
            move |el, t| el.opacity(if entering { t } else { 1.0 - t }),
        )
        .into_any_element();
    Some(
        deferred(
            anchored()
                .position_mode(AnchoredPositionMode::Window)
                .position(point(gpui::px(x), gpui::px(y)))
                .snap_to_window_with_margin(px(WINDOW_MARGIN))
                .child(animated),
        )
        .with_priority(2)
        .into_any_element(),
    )
}

pub fn card_address(url: &str, full_url: bool) -> String {
    if url.is_empty() {
        return String::new();
    }
    if full_url {
        return ardia_state::omnibox::url::display_url(url);
    }
    let host = ardia_state::omnibox::url::host_of(url);
    if host.is_empty() {
        ardia_state::omnibox::url::display_url(url)
    } else {
        ardia_state::omnibox::url::display_host(&host)
    }
}

pub fn away_from_pin(tab: &Tab) -> bool {
    crate::sidebar::away_title::away_from_pin(tab)
}

#[derive(Clone, Copy)]
struct TileInk {
    rest: Hsla,
    hover: Hsla,
    pressed: Hsla,
    stroke: Hsla,
}

fn tile_ink(dark: bool) -> TileInk {
    let base = if dark { Hsla::white() } else { Hsla::black() };
    if dark {
        TileInk {
            rest: base.opacity(0.07),
            hover: base.opacity(0.11),
            pressed: base.opacity(0.16),
            stroke: base.opacity(0.08),
        }
    } else {
        TileInk {
            rest: base.opacity(0.0525),
            hover: base.opacity(0.0825),
            pressed: base.opacity(0.12),
            stroke: base.opacity(0.06),
        }
    }
}

fn tile_fill(tile: gpui::Stateful<gpui::Div>, c: &Chrome) -> gpui::Stateful<gpui::Div> {
    let tile = tile.relative().rounded(px(TILE_RADIUS));
    if c.look.glass {
        return tile.group(GLASS_CONTROL_GROUP).child(stateful_glass(
            c.look,
            TILE_RADIUS,
            GlassStates::TILE,
            GlassBacking::Surface,
        ));
    }
    let ink = tile_ink(c.p.dark);
    tile.bg(ink.rest)
        .border(px(0.5))
        .border_color(ink.stroke)
        .hover(move |style| style.bg(ink.hover))
        .active(move |style| style.bg(ink.pressed))
}

fn action_tile(
    c: &Chrome,
    key: &'static str,
    glyph: Icon,
    label: &'static str,
    active: bool,
    msgs: Vec<Msg>,
) -> AnyElement {
    let emit: Emit = c.emit.clone();
    let window_key = c.window.id.as_str().to_owned();
    div()
        .id(key)
        .debug_selector(move || format!("hover-card-{key}"))
        .flex_1()
        .min_w_0()
        .h(px(ACTION_HEIGHT))
        .map(|this| tile_fill(this, c))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(ACTION_GAP))
        .cursor_pointer()
        .on_click(move |_, window, cx| {
            crate::press_telemetry::note_hover_card_press(key == "reset");
            for msg in &msgs {
                emit.send(msg.clone(), window, cx);
            }
            dismiss(&window_key, window, cx);
        })
        .child(
            div()
                .w(px(18.))
                .h(px(16.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(glyph, 13., if active { c.p.accent } else { c.p.icon })),
        )
        .child(
            div()
                .text_size(px(crate::primitives::tokens::type_size::TINY))
                .line_height(px(crate::primitives::tokens::line_height::TINY))
                .relative()
                .top(px(-CAPTION_RISE))
                .text_color(c.p.text_secondary)
                .whitespace_nowrap()
                .child(label),
        )
        .into_any_element()
}

fn pip_tile(c: &Chrome, tab: &ardia_state::TabId, pip: bool) -> AnyElement {
    let host = Arc::clone(c.host);
    let id = tab.clone();
    let window_key = c.window.id.as_str().to_owned();
    div()
        .id("pip")
        .flex_1()
        .min_w_0()
        .h(px(ACTION_HEIGHT))
        .map(|this| tile_fill(this, c))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(ACTION_GAP))
        .cursor_pointer()
        .on_click(move |_, window, cx| {
            crate::press_telemetry::note_hover_card_press(false);
            host.toggle_media_pip(id.clone());
            dismiss(&window_key, window, cx);
        })
        .child(
            div()
                .w(px(18.))
                .h(px(16.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(Icon::PictureInPicture, 13., c.p.icon)),
        )
        .child(
            div()
                .text_size(px(crate::primitives::tokens::type_size::TINY))
                .line_height(px(crate::primitives::tokens::line_height::TINY))
                .relative()
                .top(px(-CAPTION_RISE))
                .text_color(c.p.text_secondary)
                .whitespace_nowrap()
                .child(if pip { "Exit PiP" } else { "PiP" }),
        )
        .into_any_element()
}

fn bookmark_of(c: &Chrome, tab: &Tab) -> Option<ardia_state::ids::BookmarkId> {
    c.state
        .bookmarks_of(&tab.profile_id)
        .filter(|_| !tab.url.is_empty())
        .and_then(|tree| tree.find_url(&tab.url).map(|node| node.id().clone()))
}

fn actions(c: &Chrome, tab: &Tab) -> Vec<AnyElement> {
    let mut out = Vec::new();
    let pinned = tab.pin.is_some();
    out.push(action_tile(
        c,
        "pin",
        if pinned { Icon::PinSlash } else { Icon::Pin },
        if pinned { "Unpin" } else { "Pin" },
        false,
        vec![Msg::Store(ardia_state::Action::SetPin {
            tab: tab.id.clone(),
            pin: if pinned {
                None
            } else {
                Some(ardia_state::model::TabPin::TILE)
            },
        })],
    ));
    if !tab.url.is_empty() && c.state.settings.show_bookmarks {
        let existing = bookmark_of(c, tab);
        let msg = match existing.clone() {
            Some(id) => Msg::Store(ardia_state::Action::RemoveBookmark {
                profile: tab.profile_id.clone(),
                id,
            }),
            None => Msg::Store(ardia_state::Action::AddBookmark {
                profile: tab.profile_id.clone(),
                parent: None,
                title: tab.display_title(),
                url: tab.url.clone(),
            }),
        };
        out.push(action_tile(
            c,
            "bookmark",
            if existing.is_some() {
                Icon::BookmarkFill
            } else {
                Icon::Bookmark
            },
            "Bookmark",
            existing.is_some(),
            vec![msg],
        ));
    }
    if !c.is_active(&tab.id) && !pinned {
        out.push(action_tile(
            c,
            "split",
            Icon::Split,
            "Split",
            false,
            vec![
                Msg::Store(ardia_state::Action::ActivateTab {
                    tab: tab.id.clone(),
                }),
                Msg::command("openSplitPane"),
            ],
        ));
    }
    let pip = c.host.media_pip_open(&tab.id);
    let video = pip
        || c.host
            .media_session(&tab.id)
            .is_some_and(|session| session.now.has_video);
    if video {
        out.push(pip_tile(c, &tab.id, pip));
    }
    if away_from_pin(tab) {
        out.push(action_tile(
            c,
            "reset",
            Icon::Undo,
            "Reset",
            false,
            vec![Msg::Store(ardia_state::Action::ReturnToPinnedUrl {
                tab: tab.id.clone(),
            })],
        ));
    }
    out
}

pub fn tab_card(c: &Chrome, tab: &Tab) -> AnyElement {
    if let Some(card) = crate::live::views::calendar_card(c, tab) {
        return card;
    }
    let p = c.p;
    let full_url = c.state.settings.show_full_url_in_tab_hover_menu;
    let address = card_address(&tab.url, full_url);
    let sleeping = tab.page.is_asleep();
    let pinned_line = (away_from_pin(tab))
        .then(|| tab.pinned_url.clone())
        .flatten()
        .map(|url| format!("Pinned: {}", ardia_state::omnibox::url::display_url(&url)));
    crate::primitives::controls::hover_card(WIDTH, p)
        .p(px(PAD))
        .flex()
        .flex_col()
        .child(
            div()
                .h(px(HEADER))
                .flex()
                .items_center()
                .gap(px(crate::sidebar::tab_row::TITLE_GAP))
                .child(render_favicon(&c.favicon(tab), c.look.icon_points(16.), p))
                .child(match crate::sidebar::away_title::away_title(tab) {
                    Some(away) => crate::sidebar::away_title::away_label(
                        &away,
                        crate::sidebar::away_title::AwayLabel {
                            color: p.text,
                            size: 13.,
                            weight: FontWeight::MEDIUM,
                            height: 18.,
                            struck: false,
                            max_width: WIDTH - 2.0 * PAD - 16.0,
                        },
                    ),
                    None => fade_label(tab_title(tab), p.text, 13.)
                        .weight(FontWeight::MEDIUM)
                        .line_height(18.)
                        .into_any_element(),
                }),
        )
        .when(!address.is_empty(), |this| {
            this.child(
                div()
                    .mt(px(row_look::SPACE_XS))
                    .text_size(px(11.))
                    .line_height(px(14.))
                    .text_color(p.text_secondary)
                    .when(full_url, |d| d.line_clamp(2))
                    .when(!full_url, |d| d.truncate())
                    .child(address),
            )
        })
        .when_some(pinned_line, |this, line| {
            this.child(
                div()
                    .mt(px(row_look::SPACE_XXS))
                    .text_size(px(11.))
                    .text_color(p.text_tertiary)
                    .truncate()
                    .child(line),
            )
        })
        .when(sleeping, |this| {
            this.child(
                div()
                    .mt(px(row_look::SPACE_XS))
                    .flex()
                    .items_center()
                    .gap(px(row_look::SPACE_XS))
                    .child(
                        div()
                            .size(px(14.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(Icon::MoonZzz, 10., p.text_tertiary)),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(p.text_tertiary)
                            .child("This tab needs to reload"),
                    ),
            )
        })
        .child(
            div()
                .mt(px(row_look::SPACE_M))
                .flex()
                .gap(px(ACTION_GAP))
                .children(actions(c, tab)),
        )
        .into_any_element()
}

pub fn point_of(x: f32, y: f32) -> Point<Pixels> {
    point(gpui::px(x), gpui::px(y))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::size;

    fn row(x: f32, y: f32) -> Bounds<Pixels> {
        Bounds::new(point_of(x, y), size(gpui::px(209.), gpui::px(34.)))
    }

    #[test]
    fn tile_captions_use_the_tiny_type_on_its_thirteen_point_line() {
        use crate::primitives::tokens::{line_height, type_size};
        assert_eq!(type_size::TINY, 10.0);
        assert_eq!(line_height::TINY, 13.0);
        let column = 16.0 + ACTION_GAP + line_height::TINY;
        assert_eq!((ACTION_HEIGHT - column) / 2.0, 5.5);
    }

    #[test]
    fn the_card_sits_eight_points_past_the_sidebar_edge_level_with_the_row_title() {
        let frame = Frame {
            side: SidebarSide::Left,
            window_width: 1200.,
            sidebar_edge: 221.,
        };
        let (x, y) = card_origin(row(6., 200.), frame, 1.);
        assert_eq!(x, 229.);
        assert_eq!(y, 200. + 17. - 19.);
    }

    #[test]
    fn a_right_sidebar_puts_the_card_on_its_left() {
        let frame = Frame {
            side: SidebarSide::Right,
            window_width: 1200.,
            sidebar_edge: 979.,
        };
        let (x, _) = card_origin(row(985., 100.), frame, 1.);
        assert_eq!(x, 979. - 8. - WIDTH);
    }

    #[test]
    fn the_card_never_rises_above_the_window_margin() {
        let frame = Frame {
            side: SidebarSide::Left,
            window_width: 1200.,
            sidebar_edge: 221.,
        };
        assert_eq!(card_origin(row(6., -30.), frame, 1.).1, WINDOW_MARGIN);
    }

    #[test]
    fn addresses_show_the_host_unless_the_full_url_is_asked_for() {
        assert_eq!(card_address("", false), "");
        assert!(!card_address("https://github.com/a/b", false).contains('/'));
        assert!(card_address("https://github.com/a/b", true).contains("/a/b"));
    }
}
