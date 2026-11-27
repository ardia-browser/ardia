use crate::scale::px;
use ardia_state::model::Orientation;
use ardia_state::settings::PeekButtons;
use ardia_state::splits::MAX_SPLIT_PANES;
use ardia_state::tabs::Tab;
use ardia_state::{Action, BrowserState, TabId};
use std::rc::Rc;

use gpui::{
    AnyElement, App, Hsla, IntoElement, MouseButton, ParentElement, PinchEvent, SharedString,
    Styled, Window, div, prelude::*,
};

use crate::content::peek_motion::{Affine, PeekFrame, StageGeometry, stage_geometry, stage_input};

use crate::little_ardia::small_chrome::{
    SMALL_BAR_BUTTON, SMALL_BAR_GAP, SMALL_FIELD_GAP, SMALL_FIELD_HEIGHT, SMALL_INSET,
    SMALL_WINDOW_RADIUS, SmallButton, buttons_width, page_label, shaped_small_button, small_button,
    small_window_frame,
};
use crate::msg::Msg;
use crate::primitives::controls::shadow;
use crate::primitives::icons::Icon;
use crate::primitives::theme_bridge::{ThemedFill, rgba, themed_fill, vibrancy_under};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const PEEK_BAR: f32 = ardia_theme::layout::LITTLE_ARDIA_BAR_HEIGHT;
pub const SIDE_GAP: f32 = 8.0;
pub const SIDE_ROOM: f32 = SMALL_BAR_BUTTON + 2.0 * SIDE_GAP;
pub const INSET_FRACTION: f32 = 0.055;
pub const MIN_INSET: f32 = 16.0;
pub const SCRIM_DARK: f32 = 0.45;
pub const SCRIM_LIGHT: f32 = 0.25;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PeekGeometry {
    pub card: Rect,
    pub rest: Rect,
}

pub fn side_room(buttons: PeekButtons) -> (f32, f32) {
    match buttons {
        PeekButtons::Left => (SIDE_ROOM, 0.0),
        PeekButtons::Right => (0.0, SIDE_ROOM),
        PeekButtons::Top => (0.0, 0.0),
    }
}

pub fn peek_geometry(
    width: f32,
    height: f32,
    page_top: f32,
    inset: f32,
    buttons: PeekButtons,
) -> PeekGeometry {
    let page_w = width.max(1.0);
    let page_h = (height - page_top).max(1.0);
    let ix = MIN_INSET.max((width * INSET_FRACTION).round());
    let iy = MIN_INSET.max((height * INSET_FRACTION).round());
    let (room_left, room_right) = side_room(buttons);
    let left = ix.max(room_left);
    let right = ix.max(room_right);
    let room_w = (width - left - right - 2.0 * inset).max(1.0);
    let room_h = (height - 2.0 * iy - PEEK_BAR - inset).max(1.0);
    let k = (room_w / page_w).min(room_h / page_h).clamp(0.05, 1.0);
    let rest_w = page_w * k;
    let rest_h = page_h * k;
    let card_w = rest_w + 2.0 * inset;
    let card_h = rest_h + PEEK_BAR + inset;
    let card = Rect::new(
        left + (width - left - right - card_w) / 2.0,
        (height - card_h) / 2.0,
        card_w,
        card_h,
    );
    let rest = Rect::new(card.x + inset, card.y + PEEK_BAR, rest_w, rest_h);
    PeekGeometry { card, rest }
}

pub fn peek_label(tab: &Tab) -> String {
    let host = crate::little_ardia::small_chrome::page_host_label(&tab.url);
    if tab.url.is_empty() || host.is_empty() {
        "Peek".to_owned()
    } else {
        format!("Peek: {host}")
    }
}

pub fn split_full(state: &BrowserState, source: Option<&TabId>) -> bool {
    source
        .and_then(|s| state.split_of(s.as_str()))
        .is_some_and(|split| split.tab_ids().len() >= MAX_SPLIT_PANES)
}

pub fn peek_split_tabs(
    state: &BrowserState,
    source: &TabId,
    peek: &TabId,
) -> (Vec<TabId>, Orientation) {
    match state.split_of(source.as_str()) {
        Some(split) => {
            let mut tabs = split.tab_ids();
            let at = tabs
                .iter()
                .position(|t| t == source)
                .map_or(tabs.len(), |i| i + 1);
            tabs.insert(at, peek.clone());
            (tabs, split.orientation)
        }
        None => (vec![source.clone(), peek.clone()], Orientation::Horizontal),
    }
}

pub fn peek_to_split(
    state: &BrowserState,
    window: &ardia_state::WindowId,
    source: &TabId,
    peek: &TabId,
) -> Msg {
    let (tabs, orientation) = peek_split_tabs(state, source, peek);
    Msg::Stores(vec![
        Action::PromotePeek {
            window: window.clone(),
        },
        Action::SplitTabs { tabs, orientation },
        Action::ActivateTab { tab: peek.clone() },
    ])
}

fn buttons(c: &Chrome, tab: &Tab) -> Vec<SmallButton> {
    let window = c.window.id.clone();
    let source = c
        .state
        .window(window.as_str())
        .and_then(|w| w.chrome.peek.as_ref())
        .and_then(|peek| peek.source_tab_id.clone());
    let open_as_tab = crate::content::find_bar::with_shortcut(
        "Open as Tab",
        crate::keybindings::hint(c.state, "openPeekAsTab").or_else(|| Some("⌘O".to_owned())),
    );
    let mut out = Vec::with_capacity(3);
    if let Some(source) = source {
        out.push(SmallButton {
            id: "peek-split".into(),
            glyph: Icon::Split,
            tooltip: "Open in Split View".into(),
            disabled: split_full(c.state, Some(&source)),
            msg: peek_to_split(c.state, &window, &source, &tab.id),
        });
    }
    out.push(SmallButton {
        id: "peek-open".into(),
        glyph: Icon::Expand,
        tooltip: open_as_tab,
        disabled: false,
        msg: Msg::Store(Action::PromotePeek {
            window: window.clone(),
        }),
    });
    out.push(SmallButton {
        id: "peek-close".into(),
        glyph: Icon::XMark,
        tooltip: "Close (Esc)".into(),
        disabled: false,
        msg: Msg::Store(Action::ClosePeek { window }),
    });
    out
}

fn color(rgb_alpha: (f32, f32)) -> Hsla {
    let (white, alpha) = rgb_alpha;
    gpui::hsla(0.0, 0.0, white, alpha)
}

pub type PeekPinch = Rc<dyn Fn(&PinchEvent, &mut Window, &mut App)>;

pub struct PeekShown {
    pub geometry: StageGeometry,
    pub frame: PeekFrame,
    pub on_pinch: Option<PeekPinch>,
}

pub const LEAST_SHOWN_OPACITY: f32 = 0.01;

fn placed(rest: Rect, transform: Affine) -> (Rect, f32) {
    let shown = transform.apply(rest);
    let x = shown.x + shown.w / 2.0 - rest.w / 2.0;
    let y = shown.y + shown.h / 2.0 - rest.h / 2.0;
    (Rect::new(x, y, rest.w, rest.h), transform.s)
}

fn pinchable(
    element: gpui::Stateful<gpui::Div>,
    on_pinch: Option<&PeekPinch>,
) -> gpui::Stateful<gpui::Div> {
    match on_pinch {
        Some(listener) => {
            let listener = Rc::clone(listener);
            element.on_pinch(move |event, window, cx| listener(event, window, cx))
        }
        None => element,
    }
}

pub fn resting_stage(c: &Chrome, page: Rect) -> PeekShown {
    let area = c.layout.card;
    let geometry = stage_geometry(stage_input(
        area,
        page,
        c.layout.frame.inset,
        c.layout.frame.radius,
        c.state.settings.peek_buttons,
        None,
    ));
    PeekShown {
        frame: PeekFrame::at_rest(&geometry),
        geometry,
        on_pinch: None,
    }
}

pub fn peek_overlay(c: &Chrome, tab: &Tab, body: AnyElement, shown: PeekShown) -> AnyElement {
    let p = c.p;
    let area = c.layout.card;
    let radius = c.layout.frame.radius;
    let placement = c.state.settings.peek_buttons;
    let g = shown.geometry;
    let f = shown.frame;
    let card = g.card;
    let frame = small_window_frame(p.dark);
    let window = c.window.id.clone();
    let emit = c.emit.clone();
    let dismiss = Msg::Store(Action::ClosePeek { window });
    let list = buttons(c, tab);
    let scrim = if p.dark { SCRIM_DARK } else { SCRIM_LIGHT };
    let vibrancy = vibrancy_under(p.dark);
    let fill = themed_fill(&c.look.treatment, [card.w, card.h], vibrancy);
    let tint: Hsla = rgba(c.look.treatment.base_tint).into();
    let bar_buttons = if placement == PeekButtons::Top {
        list.len()
    } else {
        0
    };
    let field_right = SMALL_INSET + buttons_width(bar_buttons) + SMALL_FIELD_GAP;
    let label = SharedString::from(peek_label(tab));
    let chrome_alpha = f.card_alpha * f.chrome_alpha;
    let chrome_shown = chrome_alpha >= LEAST_SHOWN_OPACITY;
    let scrim_shown = f.scrim_alpha >= LEAST_SHOWN_OPACITY;
    let (chrome_at, chrome_scale) = placed(card, f.card);
    let (page_at, page_scale) = placed(g.page, f.page);
    let page_scale_safe = page_scale.max(1e-3);
    let chrome = div()
        .id("peek-card")
        .debug_selector(|| "peek-card".into())
        .absolute()
        .left(px(chrome_at.x))
        .top(px(chrome_at.y))
        .w(px(card.w))
        .h(px(card.h))
        .when((chrome_scale - 1.0).abs() > 1e-4, |this| {
            this.scale(chrome_scale)
        })
        .opacity(chrome_alpha.clamp(0.0, 1.0))
        .rounded(px(SMALL_WINDOW_RADIUS))
        .when(chrome_shown, |this| {
            this.occlude()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        })
        .shadow(vec![shadow(
            gpui::black().opacity(frame.shadow_opacity),
            frame.shadow_y,
            frame.shadow_radius,
        )])
        .child(
            div()
                .absolute()
                .inset_0()
                .rounded(px(SMALL_WINDOW_RADIUS))
                .overflow_hidden()
                .bg(vibrancy)
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .rounded(px(SMALL_WINDOW_RADIUS))
                        .bg(tint),
                )
                .children(fill.layers.iter().map(|layer| {
                    div()
                        .absolute()
                        .inset_0()
                        .rounded(px(SMALL_WINDOW_RADIUS))
                        .bg(layer.background())
                }))
                .child(
                    div()
                        .id("peek-bar")
                        .debug_selector(|| "peek-bar".into())
                        .absolute()
                        .left_0()
                        .top_0()
                        .w_full()
                        .h(px(PEEK_BAR))
                        .child(
                            div()
                                .id("peek-label")
                                .absolute()
                                .left(px(SMALL_INSET))
                                .right(px(field_right))
                                .top(px((PEEK_BAR - SMALL_FIELD_HEIGHT) / 2.0))
                                .h(px(SMALL_FIELD_HEIGHT))
                                .tooltip(crate::primitives::controls::tooltip(label, p))
                                .child(page_label(c, tab, false)),
                        )
                        .when(bar_buttons > 0, |this| {
                            this.child(
                                div()
                                    .absolute()
                                    .right(px(SMALL_INSET))
                                    .top(px((PEEK_BAR - SMALL_BAR_BUTTON) / 2.0))
                                    .flex()
                                    .gap(px(SMALL_BAR_GAP))
                                    .children(
                                        buttons(c, tab)
                                            .into_iter()
                                            .map(|button| small_button(c, button)),
                                    ),
                            )
                        }),
                ),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .rounded(px(SMALL_WINDOW_RADIUS))
                .border(px(0.5))
                .border_color(color(frame.inner_rim)),
        )
        .child(
            div()
                .absolute()
                .left(px(-0.5))
                .top(px(-0.5))
                .right(px(-0.5))
                .bottom(px(-0.5))
                .rounded(px(SMALL_WINDOW_RADIUS + 0.5))
                .border(px(0.5))
                .border_color(color(frame.outer_rim)),
        );
    let chrome = pinchable(chrome, shown.on_pinch.as_ref());
    let side = (placement != PeekButtons::Top).then(|| {
        let left = if placement == PeekButtons::Left {
            card.x - SIDE_GAP - SMALL_BAR_BUTTON
        } else {
            card.right() + SIDE_GAP
        };
        div()
            .id("peek-side-buttons")
            .debug_selector(|| "peek-side-buttons".into())
            .absolute()
            .left(px(left))
            .top(px(card.y + (PEEK_BAR - SMALL_BAR_BUTTON) / 2.0))
            .flex()
            .flex_col()
            .gap(px(SIDE_GAP))
            .opacity(f.scrim_alpha.clamp(0.0, 1.0))
            .when(scrim_shown, |this| {
                this.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            })
            .children(list.into_iter().rev().map(|button| {
                div()
                    .size(px(SMALL_BAR_BUTTON))
                    .rounded_full()
                    .bg(p.popover_fill)
                    .border(px(0.5))
                    .border_color(p.popover_border)
                    .shadow(vec![shadow(p.shadow.opacity(0.5), 1., 4.)])
                    .child(shaped_small_button(c, button, SMALL_BAR_BUTTON / 2.0))
            }))
    });
    let page_layer = div()
        .id("peek-page")
        .debug_selector(|| "peek-page".into())
        .absolute()
        .left(px(page_at.x))
        .top(px(page_at.y))
        .w(px(g.page.w))
        .h(px(g.page.h))
        .when((page_scale - 1.0).abs() > 1e-4, |this| {
            this.scale(page_scale)
        })
        .opacity(f.card_alpha.clamp(0.0, 1.0))
        .rounded_tl(px(f.top_radius / page_scale_safe))
        .rounded_tr(px(f.top_radius / page_scale_safe))
        .rounded_bl(px(f.bottom_radius / page_scale_safe))
        .rounded_br(px(f.bottom_radius / page_scale_safe))
        .overflow_hidden()
        .bg(p.panel)
        .child(body)
        .child(page_fillets(
            PageFillets {
                card,
                page: g.page,
                rest: g.rest,
                top: f.top_radius / page_scale_safe,
                bottom: f.bottom_radius / page_scale_safe,
                fill,
            },
            f.chrome_alpha,
        ));
    let page_layer = pinchable(page_layer, shown.on_pinch.as_ref());
    div()
        .id("peek-overlay")
        .debug_selector(|| "peek-overlay".into())
        .absolute()
        .left(px(area.x))
        .top(px(area.y))
        .w(px(area.w))
        .h(px(area.h))
        .occlude()
        .child(
            div()
                .id("peek-scrim")
                .debug_selector(|| "peek-scrim".into())
                .absolute()
                .inset_0()
                .rounded(px(radius))
                .bg(gpui::black().opacity(scrim))
                .opacity(f.scrim_alpha.clamp(0.0, 1.0))
                .when(scrim_shown, |this| {
                    this.on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        emit.send(dismiss.clone(), window, cx);
                    })
                }),
        )
        .children(side)
        .child(chrome)
        .child(page_layer)
        .into_any_element()
}

#[derive(Clone, Debug)]
pub struct PageFillets {
    pub card: Rect,
    pub page: Rect,
    pub rest: Rect,
    pub top: f32,
    pub bottom: f32,
    pub fill: ThemedFill,
}

pub fn card_fill_at(fillets: &PageFillets, at: [f32; 2]) -> gpui::Rgba {
    fillets.fill.color_at(
        [fillets.card.w, fillets.card.h],
        [at[0] - fillets.card.x, at[1] - fillets.card.y],
    )
}

fn fillet_path(
    origin: gpui::Point<gpui::Pixels>,
    corner: [f32; 2],
    away: [f32; 2],
    radius: f32,
) -> Option<gpui::Path> {
    let at = |x: f32, y: f32| origin + gpui::point(px(x), px(y));
    let mut path = gpui::PathBuilder::fill();
    path.move_to(at(corner[0], corner[1]));
    path.line_to(at(corner[0] + away[0] * radius, corner[1]));
    path.curve_to(
        at(corner[0], corner[1] + away[1] * radius),
        at(corner[0], corner[1]),
    );
    path.close();
    path.build().ok()
}

fn page_fillets(fillets: PageFillets, alpha: f32) -> impl IntoElement {
    gpui::canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            if alpha < LEAST_SHOWN_OPACITY {
                return;
            }
            let (w, h) = (fillets.page.w, fillets.page.h);
            let shown = Affine::mapping(fillets.page, fillets.rest);
            let card_point = |x: f32, y: f32| {
                [
                    shown.s * (fillets.page.x + x) + shown.tx,
                    shown.s * (fillets.page.y + y) + shown.ty,
                ]
            };
            let corners = [
                ([0.0, 0.0], [1.0, 1.0], fillets.top),
                ([w, 0.0], [-1.0, 1.0], fillets.top),
                ([w, h], [-1.0, -1.0], fillets.bottom),
                ([0.0, h], [1.0, -1.0], fillets.bottom),
            ];
            for (corner, away, radius) in corners {
                if radius <= 0.0 {
                    continue;
                }
                let mut color = card_fill_at(&fillets, card_point(corner[0], corner[1]));
                color.a *= alpha.clamp(0.0, 1.0);
                if let Some(path) = fillet_path(bounds.origin, corner, away, radius) {
                    window.paint_path(path, color);
                }
            }
        },
    )
    .absolute()
    .inset_0()
}

pub const NATIVE_CORNER_INSIDE_FILLET: f32 = 0.6;

pub fn peek_native_corners(shown: &PeekFrame) -> gpui::Corners<gpui::Pixels> {
    let scale = shown.page.s.max(1e-3);
    let inside = if shown.chrome_alpha >= LEAST_SHOWN_OPACITY {
        NATIVE_CORNER_INSIDE_FILLET
    } else {
        1.0
    };
    let top = gpui::px(shown.top_radius / scale * inside);
    let bottom = gpui::px(shown.bottom_radius / scale * inside);
    gpui::Corners {
        top_left: top,
        top_right: top,
        bottom_right: bottom,
        bottom_left: bottom,
    }
}

pub fn peek_click_point(
    peek: &ardia_state::windows::PeekCard,
    page: Rect,
    scale_factor: f32,
) -> Option<[f32; 2]> {
    let [x, y] = peek.click_px?;
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    Some([
        (page.x + x / scale).clamp(page.x, page.right()),
        (page.y + y / scale).clamp(page.y, page.bottom()),
    ])
}

pub const PEEK_MARK_SCALE: f32 = 0.625;
pub const PEEK_MARK_PLATE: f32 = 1.5;
pub const PEEK_MARK_RADIUS: f32 = 3.5;

pub fn peek_opened_from<'a>(state: &'a BrowserState, source: &TabId) -> Option<&'a Tab> {
    state.windows.values().find_map(|w| {
        let peek = w.chrome.peek.as_ref()?;
        (peek.source_tab_id.as_ref() == Some(source))
            .then(|| state.tab(peek.tab_id.as_str()))
            .flatten()
            .map(|t| t.as_ref())
    })
}

pub fn peek_mark(c: &Chrome, source: &TabId, size: f32) -> Option<AnyElement> {
    let peeked = peek_opened_from(c.state, source)?;
    let glyph = (size * PEEK_MARK_SCALE).round();
    let side = glyph + 2.0 * PEEK_MARK_PLATE;
    Some(
        div()
            .absolute()
            .right(px(-side / 2.0))
            .bottom(px(-side / 3.0))
            .size(px(side))
            .p(px(PEEK_MARK_PLATE))
            .rounded(px(PEEK_MARK_RADIUS))
            .bg(c.p.popover_fill)
            .child(crate::primitives::favicon::render_favicon(
                &c.favicon(peeked),
                glyph,
                c.p,
            ))
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_peek_card_keeps_the_tab_shape_and_centres_it() {
        let g = peek_geometry(1313.0, 890.0, 41.0, 9.0, PeekButtons::Top);
        let k = g.rest.w / 1313.0;
        assert!((g.rest.h / (890.0 - 41.0) - k).abs() < 1e-4);
        assert!(k < 1.0 && k > 0.5);
        assert!((g.card.w - (g.rest.w + 18.0)).abs() < 1e-3);
        assert!((g.card.h - (g.rest.h + PEEK_BAR + 9.0)).abs() < 1e-3);
        assert!((g.card.x + g.card.w / 2.0 - 1313.0 / 2.0).abs() < 1e-3);
        assert!((g.card.y + g.card.h / 2.0 - 445.0).abs() < 1e-3);
        assert_eq!(g.rest.x, g.card.x + 9.0);
        assert_eq!(g.rest.y, g.card.y + PEEK_BAR);
        assert!(g.card.y >= (890.0f32 * INSET_FRACTION).round() - 1e-3);
    }

    #[test]
    fn the_click_point_lands_inside_the_page_in_points() {
        let page = Rect::new(200.0, 50.0, 1000.0, 800.0);
        let at = |x: f32, y: f32| {
            let peek = ardia_state::windows::PeekCard {
                tab_id: TabId::new("p"),
                source_tab_id: None,
                click_px: Some([x, y]),
            };
            peek_click_point(&peek, page, 2.0)
        };
        assert_eq!(at(400.0, 100.0), Some([400.0, 100.0]));
        assert_eq!(at(99_999.0, 0.0), Some([1200.0, 50.0]));
    }

    #[test]
    fn side_buttons_make_room_on_their_side() {
        let top = peek_geometry(1000.0, 700.0, 0.0, 9.0, PeekButtons::Top);
        let left = peek_geometry(1000.0, 700.0, 0.0, 9.0, PeekButtons::Left);
        assert!(left.card.x >= SIDE_ROOM - 1e-3);
        assert!(left.card.w <= top.card.w + 1e-3);
        let tiny = peek_geometry(60.0, 40.0, 0.0, 9.0, PeekButtons::Right);
        assert!(tiny.rest.w > 0.0 && tiny.rest.h > 0.0);
    }

    #[test]
    fn the_corner_colour_follows_the_card_gradient() {
        let rgba = |r: f32, a: f32| gpui::Rgba { r, g: r, b: r, a };
        let fill = ThemedFill {
            under: rgba(0.0, 1.0),
            layers: vec![crate::primitives::theme_bridge::AxialFill {
                angle: 180.0,
                stops: [0.0, 1.0],
                from: rgba(1.0, 0.5),
                to: rgba(0.0, 0.5),
                oklab: false,
            }],
        };
        let fillets = PageFillets {
            card: Rect::new(100.0, 50.0, 400.0, 300.0),
            page: Rect::new(109.0, 88.0, 382.0, 253.0),
            rest: Rect::new(109.0, 88.0, 382.0, 253.0),
            top: 10.0,
            bottom: 10.0,
            fill,
        };
        let top = card_fill_at(&fillets, [300.0, 50.0]);
        assert!((top.r - 0.5).abs() < 1e-4 && (top.a - 1.0).abs() < 1e-5);
        let bottom = card_fill_at(&fillets, [300.0, 350.0]);
        assert!(bottom.r.abs() < 1e-4);
    }

    #[test]
    fn the_label_reads_peek_and_the_host() {
        let mut tab = Tab::new(
            TabId::new("t"),
            ardia_state::WindowId::new("w"),
            ardia_state::ProfileId::new("p"),
            "",
            0,
        );
        assert_eq!(peek_label(&tab), "Peek");
        tab.url = "https://www.example.com/a".into();
        assert!(peek_label(&tab).starts_with("Peek: "));
    }
}
