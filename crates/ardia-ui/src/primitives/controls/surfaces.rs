use std::cell::Cell;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_theme::layout::panel;
use ardia_theme::tokens::concentric;
use gpui::{
    AnyElement, AnyView, App, BoxShadow, Context, ElementId, FontWeight, Hsla, IntoElement,
    LiquidGlassStyle, MouseButton, ParentElement, Render, SharedString, Styled, VisualEffect,
    VisualEffectBlending, VisualEffectMaterial, VisualEffectState, Window, div, liquid_glass,
    point, prelude::*, visual_effect,
};

use crate::look::Palette;

pub fn shadow(color: Hsla, y: f32, blur: f32) -> BoxShadow {
    BoxShadow {
        color,
        offset: point(px(0.), px(y)),
        blur_radius: px(blur),
        spread_radius: px(0.),
        inset: false,
    }
}

pub const POPOVER_SHADOW_Y: f32 = 8.;
pub const POPOVER_SHADOW_RADIUS: f32 = 18.;

pub fn panel_shadows(p: &Palette) -> Vec<BoxShadow> {
    vec![shadow(
        p.popover_shadow,
        POPOVER_SHADOW_Y,
        POPOVER_SHADOW_RADIUS,
    )]
}

pub struct EmptyDrag;

impl Render for EmptyDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

pub const NATIVE_TOOLTIP_DELAY: Duration = Duration::from_millis(1530);
pub const NATIVE_TOOLTIP_WARM_DELAY: Duration = Duration::from_millis(270);
pub const GPUI_TOOLTIP_DELAY: Duration = Duration::from_millis(500);
pub const NATIVE_TOOLTIP_HEIGHT: f32 = 20.;
pub const NATIVE_TOOLTIP_PAD_X: f32 = 6.;
pub const NATIVE_TOOLTIP_RADIUS: f32 = 5.;
pub const NATIVE_TOOLTIP_TEXT: f32 = 11.;
pub const NATIVE_TOOLTIP_DROP: f32 = 19.;
pub const GPUI_TOOLTIP_NUDGE: f32 = 1.;
pub const NATIVE_TOOLTIP_FILL_DARK: u32 = 0x4a4a49;
pub const NATIVE_TOOLTIP_FILL_LIGHT: u32 = 0xe7e7e6;
pub const NATIVE_TOOLTIP_TEXT_DARK: u32 = 0xededec;
pub const NATIVE_TOOLTIP_TEXT_LIGHT: u32 = 0x464645;

thread_local! {
    static LAST_TOOLTIP_SHOWN: Cell<Option<Instant>> = const { Cell::new(None) };
}

pub fn tooltip_reveal_after(last_shown: Option<Instant>, now: Instant) -> Duration {
    let warm = last_shown.is_some_and(|at| now.saturating_duration_since(at) <= GPUI_TOOLTIP_DELAY);
    let wanted = if warm {
        NATIVE_TOOLTIP_WARM_DELAY
    } else {
        NATIVE_TOOLTIP_DELAY
    };
    wanted.saturating_sub(GPUI_TOOLTIP_DELAY)
}

pub fn native_tooltip_colors(dark: bool) -> (Hsla, Hsla) {
    if dark {
        (
            gpui::rgb(NATIVE_TOOLTIP_FILL_DARK).into(),
            gpui::rgb(NATIVE_TOOLTIP_TEXT_DARK).into(),
        )
    } else {
        (
            gpui::rgb(NATIVE_TOOLTIP_FILL_LIGHT).into(),
            gpui::rgb(NATIVE_TOOLTIP_TEXT_LIGHT).into(),
        )
    }
}

pub struct TooltipView {
    text: SharedString,
    fill: Hsla,
    color: Hsla,
    reveal_at: Instant,
    waiting: bool,
    beating: bool,
}

pub const TOOLTIP_HEARTBEAT: Duration = Duration::from_millis(200);

impl TooltipView {
    pub fn new(text: SharedString, dark: bool) -> Self {
        let now = Instant::now();
        let (fill, color) = native_tooltip_colors(dark);
        let wait = tooltip_reveal_after(LAST_TOOLTIP_SHOWN.with(Cell::get), now);
        TooltipView {
            text,
            fill,
            color,
            reveal_at: now + wait,
            waiting: false,
            beating: false,
        }
    }
}

impl Render for TooltipView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        let shown = now >= self.reveal_at;
        if shown {
            LAST_TOOLTIP_SHOWN.with(|last| last.set(Some(now)));
            if !self.beating {
                self.beating = true;
                cx.spawn(async move |this, cx| {
                    loop {
                        cx.background_executor().timer(TOOLTIP_HEARTBEAT).await;
                        if this.update(cx, |_, _| ()).is_err() {
                            break;
                        }
                        LAST_TOOLTIP_SHOWN.with(|last| last.set(Some(Instant::now())));
                    }
                })
                .detach();
            }
        } else if !self.waiting {
            self.waiting = true;
            let wait = self.reveal_at.saturating_duration_since(now);
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(wait).await;
                this.update(cx, |_, cx| cx.notify()).ok();
            })
            .detach();
        }
        div()
            .pt(px(NATIVE_TOOLTIP_DROP - GPUI_TOOLTIP_NUDGE))
            .when(!shown, |this| this.opacity(0.))
            .child(
                div()
                    .h(px(NATIVE_TOOLTIP_HEIGHT))
                    .px(px(NATIVE_TOOLTIP_PAD_X))
                    .flex()
                    .items_center()
                    .rounded(px(NATIVE_TOOLTIP_RADIUS))
                    .bg(self.fill)
                    .text_size(px(NATIVE_TOOLTIP_TEXT))
                    .text_color(self.color)
                    .whitespace_nowrap()
                    .child(self.text.clone()),
            )
    }
}

pub fn tooltip(
    text: SharedString,
    p: &Palette,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let dark = p.dark;
    move |_, cx| {
        let text = text.clone();
        cx.new(|_| TooltipView::new(text, dark)).into()
    }
}

pub const POPOVER_MATERIAL: VisualEffectMaterial = VisualEffectMaterial::Menu;
pub const POPOVER_BORDER: f32 = 0.5;

pub fn material_layer(material: VisualEffectMaterial, radius: f32, border: f32) -> VisualEffect {
    visual_effect(material)
        .blending(VisualEffectBlending::WithinWindow)
        .state(VisualEffectState::Active)
        .absolute()
        .inset_0()
        .rounded(px(concentric(radius, border)))
}

pub fn popover_tint(dark: bool) -> Hsla {
    crate::primitives::theme_bridge::hsla(ardia_theme::tokens::roles(dark).popover_tint)
}

pub fn popover_material(radius: f32, p: &Palette) -> [AnyElement; 2] {
    [
        material_layer(POPOVER_MATERIAL, radius, POPOVER_BORDER).into_any_element(),
        div()
            .absolute()
            .inset_0()
            .rounded(px(concentric(radius, POPOVER_BORDER)))
            .bg(popover_tint(p.dark))
            .into_any_element(),
    ]
}

pub fn surface(glass: bool, radius: f32, p: &Palette) -> gpui::Div {
    if glass {
        div().rounded(px(radius))
    } else {
        div()
            .rounded(px(radius))
            .bg(p.popover_fill)
            .border(px(POPOVER_BORDER))
            .border_color(p.popover_border)
            .shadow(panel_shadows(p))
            .children(popover_material(radius, p))
    }
}

pub fn glass_panel(
    id: impl Into<ElementId>,
    glass: bool,
    radius: f32,
    p: &Palette,
) -> gpui::Stateful<gpui::Div> {
    let shell = div()
        .id(id)
        .relative()
        .occlude()
        .rounded(px(radius))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation());
    if glass {
        shell.child(
            liquid_glass()
                .id(crate::primitives::glass::PANEL_GLASS_ID)
                .absolute()
                .inset_0()
                .rounded(px(radius))
                .style(LiquidGlassStyle::Regular)
                .tint(gpui::Rgba::from(p.glass_panel_tint)),
        )
    } else {
        shell
            .bg(p.popover_fill)
            .border(px(POPOVER_BORDER))
            .border_color(p.popover_border)
            .shadow(panel_shadows(p))
            .children(popover_material(radius, p))
    }
}

pub fn popover(
    id: impl Into<ElementId>,
    glass: bool,
    width: f32,
    p: &Palette,
) -> gpui::Stateful<gpui::Div> {
    glass_panel(id, glass, panel::RADIUS, p)
        .w(px(width))
        .flex()
        .flex_col()
        .py(px(panel::LIST_PADDING))
        .text_color(p.text)
}

pub fn separator(p: &Palette) -> impl IntoElement {
    div()
        .mx(px(panel::INSET))
        .my(px(panel::SEPARATOR_GAP))
        .h(px(0.5))
        .bg(p.divider)
}

pub fn section_label(text: impl Into<SharedString>, p: &Palette) -> impl IntoElement {
    div()
        .px(px(panel::INSET))
        .pt(px(6.))
        .pb(px(4.))
        .text_size(px(11.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(p.text_tertiary)
        .child(text.into())
}

pub const TOOLTIP_PAD_X: f32 = 6.5;
pub const TOOLTIP_PAD_Y: f32 = 5.;
pub const TOOLTIP_RING: f32 = 0.5;
pub const TOOLTIP_TEXT: f32 = 12.;
pub const TOOLTIP_SHADOW_Y: f32 = 1.;
pub const TOOLTIP_SHADOW_RADIUS: f32 = 4.;
pub const TOOLTIP_SHOW_DELAY_MS: u64 = 500;
pub const TOOLTIP_FADE_MS: u64 = 100;

pub fn tooltip_above_plate(text: impl Into<SharedString>, p: &Palette) -> gpui::Div {
    let radius = ardia_theme::tokens::radius::CONTROL;
    div()
        .p(px(TOOLTIP_RING))
        .rounded(px(radius + TOOLTIP_RING))
        .border(px(TOOLTIP_RING))
        .border_color(p.tooltip_ring)
        .shadow(vec![shadow(
            p.tooltip_shadow,
            TOOLTIP_SHADOW_Y,
            TOOLTIP_SHADOW_RADIUS,
        )])
        .child(
            div()
                .px(px(TOOLTIP_PAD_X))
                .py(px(TOOLTIP_PAD_Y))
                .rounded(px(radius))
                .bg(p.tooltip_fill)
                .border(px(1.))
                .border_color(p.panel_border)
                .text_size(px(TOOLTIP_TEXT))
                .font_weight(FontWeight::MEDIUM)
                .text_color(p.tooltip_text)
                .whitespace_nowrap()
                .child(text.into()),
        )
}

pub const CARD_SHADOW_Y: f32 = 6.;
pub const CARD_SHADOW_RADIUS: f32 = 16.;

pub fn hover_card(width: f32, p: &Palette) -> gpui::Div {
    hover_card_surface(p).w(px(width))
}

pub fn hover_card_surface(p: &Palette) -> gpui::Div {
    div()
        .rounded(px(panel::RADIUS))
        .bg(p.panel)
        .border(px(0.5))
        .border_color(p.panel_border)
        .shadow(vec![shadow(
            p.card_shadow,
            CARD_SHADOW_Y,
            CARD_SHADOW_RADIUS,
        )])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltips_wait_like_macos_and_warm_up_after_one_was_shown() {
        let now = Instant::now();
        assert_eq!(tooltip_reveal_after(None, now), Duration::from_millis(1030));
        assert_eq!(
            tooltip_reveal_after(Some(now - Duration::from_millis(600)), now),
            Duration::from_millis(1030)
        );
        assert_eq!(
            tooltip_reveal_after(Some(now - Duration::from_millis(16)), now),
            Duration::ZERO
        );
    }

    #[test]
    fn tooltip_plates_use_the_measured_system_colours() {
        let (dark_fill, dark_text) = native_tooltip_colors(true);
        let (light_fill, light_text) = native_tooltip_colors(false);
        assert!(dark_fill.l < 0.3 && dark_text.l > 0.9);
        assert!(light_fill.l > 0.9 && light_text.l < 0.3);
    }
}
