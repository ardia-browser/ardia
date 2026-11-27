use ardia_theme::RgbaColor;
use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, App, ClickEvent, FontWeight, Hsla, IntoElement, ParentElement, SharedString,
    Styled, Window, div, prelude::*,
};

use crate::look::Look;
use crate::primitives::controls::shadow;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::scale::px;

pub const COLUMN: f32 = 432.0;
pub const COLUMN_PAD: f32 = 32.0;
pub const TITLE_BAR: f32 = 46.0;
pub const PREVIEW_BELOW: f32 = 880.0;
pub const SECTION_GAP: f32 = 64.0;
pub const PEEK_OPACITY: f32 = 0.28;
pub const PANE_MARGIN: f32 = 16.0;
pub const PANE_PAD: f32 = 40.0;
pub const MOCK_ASPECT: f32 = 1.42;
pub const MOCK_MAX_WIDTH: f32 = 760.0;
pub const BAR_HEIGHT: f32 = 84.0;
pub const BUTTON_HEIGHT: f32 = 36.0;
pub const CONTENT_WIDTH: f32 = 368.0;
pub const TILE_WIDTH: f32 = (CONTENT_WIDTH - space::M * 3.0) / 4.0;
pub const DISABLED_OPACITY: f32 = 0.4;
pub const SECTION_SCROLL_MS: f32 = 600.0;
pub const PREVIEW_SWAP_MS: f32 = 400.0;

#[derive(Clone, Copy, Debug)]
pub struct Ink {
    pub dark: bool,
    pub title: Hsla,
    pub subtitle: Hsla,
    pub row: Hsla,
    pub row_border: Hsla,
    pub row_subtitle: Hsla,
    pub primary: Hsla,
    pub primary_hover: Hsla,
    pub primary_text: Hsla,
    pub button: Hsla,
    pub button_hover: Hsla,
    pub button_text: Hsla,
    pub outlined_hover: Hsla,
    pub no_thanks_border: Hsla,
    pub no_thanks_text: Hsla,
    pub icon_container: Hsla,
    pub tile: Hsla,
    pub tile_lit: Hsla,
    pub tile_border: Hsla,
    pub tile_border_selected: Hsla,
    pub progress_track: Hsla,
    pub separator: Hsla,
    pub ring_fill: Hsla,
    pub ring_border: Hsla,
    pub ring_on: Hsla,
    pub stage: Hsla,
    pub card: Hsla,
    pub tile_shadow: Hsla,
    pub selected_shadow: Hsla,
    pub pane_shadow: Hsla,
    pub steps: Hsla,
    pub flow_glyph: Hsla,
    pub glass: bool,
    pub glass_rest: Hsla,
    pub glass_active: Hsla,
}

fn w(alpha: f32) -> Hsla {
    hsla(RgbaColor::white(alpha))
}

fn b(alpha: f32) -> Hsla {
    hsla(RgbaColor::black(alpha))
}

impl Ink {
    pub fn of(look: &Look) -> Ink {
        let roles = &look.theme.roles;
        let dark = look.dark;
        let common = |ink: Ink| Ink {
            primary_text: hsla(roles.on_primary),
            separator: hsla(roles.divider),
            ring_fill: hsla(roles.ring_radio_fill),
            ring_border: hsla(roles.ring_radio_border),
            ring_on: hsla(roles.ring_radio_on),
            stage: hsla(roles.card),
            glass: look.glass,
            glass_rest: hsla(crate::primitives::glass::control_glass_tint(
                &look.theme,
                crate::primitives::glass::GlassState::Rest,
                crate::primitives::glass::GlassLook::of_look(look).tint,
            )),
            glass_active: hsla(crate::primitives::glass::control_glass_tint(
                &look.theme,
                crate::primitives::glass::GlassState::Active,
                crate::primitives::glass::GlassLook::of_look(look).tint,
            )),
            ..ink
        };
        if dark {
            common(Ink {
                dark,
                title: w(1.0),
                subtitle: w(0.6),
                row: w(0.08),
                row_border: w(0.16),
                row_subtitle: w(0.6),
                primary: w(0.85),
                primary_hover: w(0.9),
                primary_text: b(1.0),
                button: w(0.08),
                button_hover: w(0.1),
                button_text: w(1.0),
                outlined_hover: w(0.03),
                no_thanks_border: w(0.2),
                no_thanks_text: w(0.5),
                icon_container: w(0.15),
                tile: w(0.06),
                tile_lit: w(0.1),
                tile_border: w(0.07),
                tile_border_selected: w(0.34),
                progress_track: w(0.12),
                separator: w(0.1),
                ring_fill: w(0.1),
                ring_border: w(0.25),
                ring_on: w(1.0),
                stage: hsla(RgbaColor::hex(0x161616)),
                card: hsla(RgbaColor::hex(0x161616)),
                tile_shadow: b(0.3),
                selected_shadow: b(0.4),
                pane_shadow: b(0.35),
                steps: w(0.3),
                flow_glyph: w(0.75),
                glass: false,
                glass_rest: w(0.0),
                glass_active: w(0.0),
            })
        } else {
            common(Ink {
                dark,
                title: b(1.0),
                subtitle: b(0.53),
                row: b(0.015),
                row_border: b(0.08),
                row_subtitle: b(0.6),
                primary: b(0.85),
                primary_hover: b(0.9),
                primary_text: w(1.0),
                button: b(0.08),
                button_hover: b(0.1),
                button_text: b(1.0),
                outlined_hover: b(0.03),
                no_thanks_border: b(0.1),
                no_thanks_text: b(0.5),
                icon_container: b(0.03),
                tile: w(0.9),
                tile_lit: b(0.035),
                tile_border: b(0.06),
                tile_border_selected: b(0.3),
                progress_track: b(0.08),
                separator: b(0.1),
                ring_fill: b(0.05),
                ring_border: b(0.25),
                ring_on: b(1.0),
                stage: w(1.0),
                card: w(1.0),
                tile_shadow: b(0.06),
                selected_shadow: b(0.1),
                pane_shadow: b(0.08),
                steps: b(0.3),
                flow_glyph: b(0.6),
                glass: false,
                glass_rest: w(0.0),
                glass_active: w(0.0),
            })
        }
    }
}

pub type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

pub const STEP_TITLE_TRACKING: f32 = -0.4;

pub fn step_title(title: &str, subtitle: Option<&str>, ink: &Ink) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(space::ML))
        .child(
            crate::primitives::tracked_text::tracked_text(
                SharedString::from(title.to_owned()),
                26.,
                32.,
                STEP_TITLE_TRACKING,
            )
            .weight(FontWeight::LIGHT)
            .color(ink.title),
        )
        .when_some(subtitle, |this, subtitle| {
            this.child(
                div()
                    .text_size(px(13.))
                    .line_height(px(18.))
                    .text_color(ink.subtitle)
                    .child(SharedString::from(subtitle.to_owned())),
            )
        })
        .into_any_element()
}

pub fn tag(title: impl Into<SharedString>, ink: &Ink) -> AnyElement {
    div()
        .flex()
        .child(
            div()
                .h(px(20.))
                .px(px(space::M))
                .rounded(px(10.))
                .bg(ink.button)
                .flex()
                .items_center()
                .text_size(px(11.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(ink.title)
                .child(title.into()),
        )
        .into_any_element()
}

pub fn section_label(title: impl Into<SharedString>, ink: &Ink) -> AnyElement {
    div()
        .h(px(18.))
        .flex()
        .items_center()
        .text_size(px(12.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink.subtitle)
        .child(title.into())
        .into_any_element()
}

pub fn card_symbol(name: &str, ink: &Ink) -> crate::primitives::icons::IconElement {
    crate::primitives::icons::symbol_icon(name.to_owned(), Icon::Puzzle, 13., ink.title)
}

pub const PRESS_SCALE: f32 = 0.98;
pub const CIRCLE_PRESS_SCALE: f32 = 0.96;

pub fn primary_button(
    id: impl Into<SharedString>,
    title: impl Into<SharedString>,
    arrow: bool,
    disabled: bool,
    ink: &Ink,
    on_click: Click,
) -> AnyElement {
    let ink = *ink;
    let id: SharedString = id.into();
    let selector = id.to_string();
    div()
        .id(id)
        .debug_selector(move || selector)
        .h(px(BUTTON_HEIGHT))
        .px(px(space::XXL))
        .rounded(px(BUTTON_HEIGHT / 2.))
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(space::S))
        .relative()
        .bg(ink.primary)
        .when(disabled, |this| this.opacity(DISABLED_OPACITY))
        .when(!disabled, |this| {
            this.cursor_pointer()
                .hover(move |s| s.bg(ink.primary_hover))
                .active(|s| s.scale(PRESS_SCALE))
                .on_click(on_click)
        })
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(ink.primary_text)
        .child(title.into())
        .when(arrow, |this| {
            this.child(icon(Icon::ArrowRight, 11., ink.primary_text))
        })
        .into_any_element()
}

pub fn secondary_button(
    id: impl Into<SharedString>,
    title: impl Into<SharedString>,
    filled: bool,
    ink: &Ink,
    on_click: Click,
) -> AnyElement {
    let ink = *ink;
    let id: SharedString = id.into();
    let selector = id.to_string();
    div()
        .id(id)
        .debug_selector(move || selector)
        .h(px(BUTTON_HEIGHT))
        .px(px(space::XL))
        .rounded(px(BUTTON_HEIGHT / 2.))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .relative()
        .when(ink.glass, |this| {
            this.child(glass_fill(BUTTON_HEIGHT / 2., None))
                .hover(move |s| s.bg(ink.outlined_hover))
        })
        .when(filled && !ink.glass, |this| {
            this.bg(ink.button).hover(move |s| s.bg(ink.button_hover))
        })
        .when(!filled && !ink.glass, |this| {
            this.border(px(1.))
                .border_color(ink.no_thanks_border)
                .hover(move |s| s.bg(ink.outlined_hover))
        })
        .text_size(px(13.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(if filled {
            ink.button_text
        } else {
            ink.no_thanks_text
        })
        .active(|s| s.scale(PRESS_SCALE))
        .on_click(on_click)
        .child(title.into())
        .into_any_element()
}

pub fn circle_button(
    id: impl Into<SharedString>,
    glyph: Icon,
    glyph_size: f32,
    ink: &Ink,
    on_click: Click,
) -> AnyElement {
    let ink = *ink;
    let id: SharedString = id.into();
    let selector = id.to_string();
    div()
        .id(id)
        .debug_selector(move || selector)
        .size(px(BUTTON_HEIGHT))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .relative()
        .when(ink.glass, |this| {
            this.child(glass_fill(BUTTON_HEIGHT / 2., None))
        })
        .when(!ink.glass, |this| {
            this.border(px(1.)).border_color(ink.no_thanks_border)
        })
        .cursor_pointer()
        .hover(move |s| s.bg(ink.outlined_hover))
        .active(|s| s.scale(CIRCLE_PRESS_SCALE))
        .on_click(on_click)
        .child(icon(glyph, glyph_size, ink.no_thanks_text))
        .into_any_element()
}

pub fn radio_ring(on: bool, ink: &Ink) -> AnyElement {
    div()
        .flex_none()
        .size(px(16.))
        .rounded_full()
        .bg(ink.ring_fill)
        .border(px(if on { 5. } else { 1.5 }))
        .border_color(if on { ink.ring_on } else { ink.ring_border })
        .into_any_element()
}

pub fn check_ring(on: bool, small: bool, ink: &Ink) -> AnyElement {
    let (side, glyph) = if small { (14., 8.) } else { (18., 10.) };
    div()
        .flex_none()
        .size(px(side))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .when(on, |this| {
            this.bg(ink.ring_on)
                .child(icon(Icon::Check, glyph, ink.primary_text))
        })
        .when(!on, |this| {
            this.bg(ink.ring_fill)
                .border(px(1.5))
                .border_color(ink.ring_border)
        })
        .into_any_element()
}

fn card_shadows(selected: bool, ink: &Ink) -> Vec<gpui::BoxShadow> {
    if selected {
        vec![shadow(ink.selected_shadow, 5., 14.)]
    } else {
        vec![shadow(ink.tile_shadow, 3., 10.)]
    }
}

pub fn option_radio(
    id: impl Into<SharedString>,
    title: &str,
    subtitle: &str,
    selected: bool,
    ink: &Ink,
    on_click: Click,
) -> AnyElement {
    let ink = *ink;
    let id: SharedString = id.into();
    let selector = id.to_string();
    let face = selector.clone();
    let card = div()
        .id(id)
        .debug_selector(move || face)
        .min_h(px(56.))
        .py(px(space::ML))
        .px(px(space::XL))
        .rounded(px(radius::PANEL))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::L))
        .border(px(1.))
        .border_color(ink.tile_border)
        .cursor_pointer()
        .on_click(on_click);
    let card = card_face(
        card,
        SharedString::from(format!("{selector}-face")),
        radius::PANEL,
        selected,
        selected,
        &ink,
    );
    card.child(radio_ring(selected, &ink))
        .child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .gap(px(space::XXS))
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(ink.title)
                        .child(SharedString::from(title.to_owned())),
                )
                .when(!subtitle.is_empty(), |this| {
                    this.child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(15.))
                            .text_color(ink.row_subtitle)
                            .child(SharedString::from(subtitle.to_owned())),
                    )
                }),
        )
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
pub fn option_check(
    id: impl Into<SharedString>,
    glyph: Option<crate::primitives::icons::IconElement>,
    title: &str,
    subtitle: &str,
    selected: bool,
    disabled: bool,
    ink: &Ink,
    on_click: Click,
) -> AnyElement {
    let ink = *ink;
    let id: SharedString = id.into();
    let selector = id.to_string();
    let face = selector.clone();
    let card = div()
        .id(id)
        .debug_selector(move || face)
        .py(px(space::M))
        .px(px(space::L))
        .rounded(px(radius::PANEL))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::L))
        .border(px(1.))
        .border_color(ink.tile_border);
    card_face(
        card,
        SharedString::from(format!("{selector}-face")),
        radius::PANEL,
        false,
        false,
        &ink,
    )
    .when(disabled, |this| this.opacity(0.5))
    .when(!disabled, |this| this.cursor_pointer().on_click(on_click))
    .when_some(glyph, |this, glyph| {
        this.child(
            div()
                .flex_none()
                .size(px(28.))
                .rounded(px(radius::TILE))
                .bg(ink.icon_container)
                .flex()
                .items_center()
                .justify_center()
                .child(glyph),
        )
    })
    .child(
        div()
            .flex_1()
            .flex()
            .flex_col()
            .gap(px(space::XXS))
            .min_w_0()
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(ink.title)
                    .child(SharedString::from(title.to_owned())),
            )
            .when(!subtitle.is_empty(), |this| {
                this.child(
                    div()
                        .text_size(px(12.))
                        .line_height(px(15.))
                        .text_color(ink.row_subtitle)
                        .line_clamp(2)
                        .child(SharedString::from(subtitle.to_owned())),
                )
            }),
    )
    .child(check_ring(selected, false, &ink))
    .into_any_element()
}

#[allow(clippy::too_many_arguments)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileRing {
    pub ring: Option<(Hsla, f32)>,
    pub inner: Option<(Hsla, f32)>,
    pub fill: Hsla,
}

#[allow(clippy::too_many_arguments)]
pub fn select_tile(
    id: impl Into<SharedString>,
    title: &str,
    width: f32,
    height: f32,
    selected: bool,
    content: AnyElement,
    ink: &Ink,
    on_click: Click,
) -> AnyElement {
    ringed_tile(
        id, title, width, height, selected, None, content, ink, on_click,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn ringed_tile(
    id: impl Into<SharedString>,
    title: &str,
    width: f32,
    height: f32,
    selected: bool,
    ring: Option<TileRing>,
    content: AnyElement,
    ink: &Ink,
    on_click: Click,
) -> AnyElement {
    let ring = ring.filter(|_| selected);
    let ink = *ink;
    let id: SharedString = id.into();
    let selector = id.to_string();
    let face = selector.clone();
    let tile = div()
        .id(id)
        .debug_selector(move || face)
        .relative()
        .flex_none()
        .w(px(width))
        .h(px(height))
        .rounded(px(radius::PANEL))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(space::S))
        .border(px(1.))
        .border_color(if ring.is_some() {
            gpui::transparent_black()
        } else if selected {
            ink.tile_border_selected
        } else {
            ink.tile_border
        })
        .cursor_pointer()
        .on_click(on_click);
    let tile = card_face(
        tile,
        SharedString::from(format!("{selector}-face")),
        radius::PANEL,
        selected,
        selected,
        &ink,
    )
    .when_some(ring.filter(|_| !ink.glass), |this, r| this.bg(r.fill));
    tile.when_some(ring.and_then(|r| r.ring), |this, (color, width)| {
        this.child(
            div()
                .absolute()
                .top(px(-1.))
                .left(px(-1.))
                .right(px(-1.))
                .bottom(px(-1.))
                .rounded(px(radius::PANEL))
                .border(px(width))
                .border_color(color),
        )
    })
    .when_some(ring.and_then(|r| r.inner), |this, (color, width)| {
        this.child(
            div()
                .absolute()
                .inset_0()
                .rounded(px(radius::PANEL - 1.))
                .border(px(width))
                .border_color(color),
        )
    })
    .child(content)
    .child(
        div()
            .max_w(px(width - space::XS * 2.))
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(if selected { ink.title } else { ink.subtitle })
            .child(SharedString::from(title.to_owned())),
    )
    .when(selected, |this| {
        this.child(
            div()
                .absolute()
                .top(px(5.))
                .right(px(5.))
                .child(check_ring(true, true, &ink)),
        )
    })
    .into_any_element()
}

pub struct Segment {
    pub title: String,
    pub selected: bool,
    pub on_click: Click,
    pub image: Option<std::sync::Arc<gpui::Image>>,
}

pub fn option_row(id: &str, title: &str, segments: Vec<Segment>, ink: &Ink) -> AnyElement {
    let ink = *ink;
    div()
        .min_h(px(36.))
        .py(px(space::S))
        .px(px(space::L))
        .rounded(px(radius::PANEL))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::ML))
        .bg(ink.tile)
        .border(px(1.))
        .border_color(ink.tile_border)
        .shadow(card_shadows(false, &ink))
        .child(
            div()
                .flex_1()
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(ink.title)
                .child(SharedString::from(title.to_owned())),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .gap(px(space::XXS))
                .p(px(space::XXS))
                .rounded(px(radius::TILE))
                .bg(ink.button)
                .children(segments.into_iter().enumerate().map(|(index, segment)| {
                    let selected = segment.selected;
                    let name = format!("{id}:{index}");
                    let selector = name.clone();
                    let image = segment.image.clone();
                    div()
                        .id(SharedString::from(name))
                        .debug_selector(move || selector)
                        .h(px(if image.is_some() { 30. } else { 22. }))
                        .min_w(px(if image.is_some() { 30. } else { 34. }))
                        .px(px(if image.is_some() {
                            space::XXS
                        } else {
                            space::M
                        }))
                        .rounded(px(radius::TILE - space::XXS))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .when(selected, |this| {
                            this.bg(ink.card)
                                .border(px(1.))
                                .border_color(ink.row_border)
                        })
                        .when(!selected, |this| {
                            this.hover(move |s| s.bg(ink.outlined_hover))
                        })
                        .on_click(segment.on_click)
                        .text_size(px(11.))
                        .font_weight(if selected {
                            FontWeight::SEMIBOLD
                        } else {
                            FontWeight::MEDIUM
                        })
                        .text_color(if selected { ink.title } else { ink.subtitle })
                        .map(|this| match image {
                            Some(image) => this.child(gpui::img(image).size(px(26.))),
                            None => this.child(SharedString::from(segment.title)),
                        })
                })),
        )
        .into_any_element()
}

pub fn symbol_tile(glyph: Icon, ink: &Ink) -> AnyElement {
    div()
        .m(px(space::XXS))
        .size(px(26.))
        .rounded(px(radius::TILE))
        .bg(ink.icon_container)
        .flex()
        .items_center()
        .justify_center()
        .child(icon(glyph, 13., ink.subtitle))
        .into_any_element()
}

pub fn choice_card(radius: f32, selected: bool, hovered: bool, ink: &Ink) -> gpui::Div {
    let lit = selected || hovered;
    div()
        .rounded(px(radius))
        .bg(if lit { ink.tile_lit } else { ink.tile })
        .border(px(1.))
        .border_color(if selected {
            ink.tile_border_selected
        } else {
            ink.tile_border
        })
        .shadow(card_shadows(selected, ink))
}

pub fn glass_fill(radius: f32, tint: Option<Hsla>) -> AnyElement {
    let glass = gpui::liquid_glass()
        .absolute()
        .inset_0()
        .rounded(px(radius))
        .style(gpui::LiquidGlassStyle::Regular);
    match tint {
        Some(color) => glass.tint(gpui::Rgba::from(color)).into_any_element(),
        None => glass.into_any_element(),
    }
}

pub fn card_glass(radius: f32, tint: Hsla) -> AnyElement {
    div()
        .absolute()
        .inset_0()
        .rounded(px(radius))
        .child(
            gpui::liquid_glass()
                .alpha(crate::primitives::glass::CONTROL_GLASS_STRENGTH)
                .absolute()
                .inset_0()
                .corner_radius(px(radius))
                .style(gpui::LiquidGlassStyle::Clear)
                .tint(gpui::Rgba::from(tint)),
        )
        .into_any_element()
}

pub fn card_face(
    el: gpui::Stateful<gpui::Div>,
    group: SharedString,
    radius: f32,
    raised: bool,
    lit: bool,
    ink: &Ink,
) -> gpui::Stateful<gpui::Div> {
    let ink = *ink;
    if ink.glass {
        let overlay = div()
            .absolute()
            .top(px(-1.))
            .left(px(-1.))
            .right(px(-1.))
            .bottom(px(-1.))
            .rounded(px(radius))
            .when(lit, |this| this.bg(ink.outlined_hover))
            .group_hover(group.clone(), move |s| s.bg(ink.outlined_hover));
        el.relative()
            .group(group)
            .child(card_glass(
                radius,
                if raised {
                    ink.glass_active
                } else {
                    ink.glass_rest
                },
            ))
            .child(overlay)
    } else {
        el.bg(if lit { ink.tile_lit } else { ink.tile })
            .shadow(card_shadows(raised, &ink))
            .hover(move |s| s.bg(ink.tile_lit))
    }
}
