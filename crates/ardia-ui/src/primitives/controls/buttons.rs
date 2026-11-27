use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use crate::scale::px;
use ardia_theme::tokens::{
    CLOSE_ON_ART, DISABLED_OPACITY, FontWeight as Weight, IconButtonSize, TypeSize, capsule,
    hairline, pill_height, radius, space,
};
use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, FontFeatures, FontWeight, Hsla, IntoElement,
    MouseButton, ParentElement, RenderOnce, SharedString, Stateful, Styled, TextRun,
    TimedTransformation, Transformation, Window, canvas, div, point, prelude::*, relative, svg,
};

use crate::icon_picker::symbols::SymbolWeight;
use crate::look::Palette;
use crate::primitives::hover_fill::{
    Interaction, press_motion, press_state, resolve_interaction, track_press,
};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::tokens::press_scale::{
    CONTROL as CONTROL_PRESS_SCALE, ICON as ICON_PRESS_SCALE,
};
use ardia_state::settings::PressMotion;

use super::*;

pub const BORDER_WIDTH: f32 = hairline::PANEL * 2.0;
pub const ROW_GLYPH: f32 = 13.0;
pub const PUSH_HEIGHT: f32 = 22.0;
pub const PUSH_GLYPH: f32 = 11.0;
pub const PUSH_GLYPH_BOX: f32 = 13.0;
pub const STEPPER_WIDTH: f32 = 24.0;
pub const STEPPER_HEIGHT: f32 = 20.0;
pub const STEPPER_GLYPH: f32 = 10.0;
pub const STEPPER_GLYPH_BOX: f32 = 12.0;
pub const CHIP_DIM: f32 = 0.85;
pub const CHIP_GLYPH: f32 = 10.5;
pub const CHIP_GLYPH_BOX: f32 = 14.0;
pub const PANEL_CLOSE_BOX: f32 = 22.0;
pub const PANEL_CLOSE_GLYPH: f32 = 9.0;
pub const PANEL_CLOSE_GLYPH_BOX: f32 = 14.0;
pub const ART_CLOSE_BOX: f32 = 22.0;
pub const ART_CLOSE_GLYPH: f32 = 11.0;
pub const HUD_CLOSE_BOX: f32 = 23.0;
pub const HUD_CLOSE_GLYPH: f32 = 10.0;

fn weight(token: Weight) -> FontWeight {
    FontWeight(f32::from(token.value()))
}

fn fill_layer(color: Hsla, corner: f32) -> Div {
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .rounded(px(corner))
        .bg(color)
}

fn border_layer(color: Hsla, width: f32, corner: f32) -> Div {
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .rounded(px(corner))
        .border(px(width))
        .border_color(color)
}

fn hover_fill(shown: Interaction, color: Hsla, corner: f32) -> Option<Div> {
    (shown.fill > 0.0).then(|| fill_layer(color.opacity(shown.fill), corner))
}

fn hover_swap(shown: Interaction, rest: Hsla, color: Hsla, corner: f32) -> Vec<Div> {
    [
        (shown.fill < 1.0).then(|| fill_layer(rest.opacity(1.0 - shown.fill), corner)),
        hover_fill(shown, color, corner),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn scaled_glyph(
    glyph: Icon,
    side: f32,
    frame: f32,
    color: Hsla,
    scale: f32,
    weight: SymbolWeight,
) -> Div {
    div()
        .flex_none()
        .size(px(frame))
        .flex()
        .items_center()
        .justify_center()
        .map(|this| press_scaled(this, scale))
        .child(icon(glyph, side, color).weight(weight))
}

pub fn press_scaled<E: Styled>(element: E, scale: f32) -> E {
    if scale == 1.0 {
        element
    } else {
        element.scale(scale)
    }
}

fn interactive(
    id: ElementId,
    press_scale: Option<f32>,
    window: &mut Window,
    cx: &mut App,
    shown: impl FnOnce(bool, bool) -> bool,
    instant: bool,
) -> (Stateful<Div>, Interaction) {
    let state = press_state(&id, window, cx);
    let interaction = resolve_interaction(&state, shown, instant, window, cx);
    let element = track_press(div().id(id), &state, press_scale, cx);
    (element, interaction)
}

fn clicks(element: Stateful<Div>, handler: Option<ClickHandler>) -> Stateful<Div> {
    element
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .when_some(handler, |this, handler| {
            this.on_click(move |event, window, cx| {
                cx.stop_propagation();
                handler(event, window, cx);
            })
        })
}

#[derive(IntoElement)]
pub struct IconButton {
    id: ElementId,
    icon: Icon,
    glyph: f32,
    square: f32,
    radius: f32,
    color: Hsla,
    custom_color: bool,
    hover: Hsla,
    pressed: Hsla,
    toggled: Option<Hsla>,
    disabled: bool,
    disabled_color: Option<Hsla>,
    icon_disabled: Hsla,
    tip: Option<(SharedString, Palette)>,
    on_click: Option<ClickHandler>,
    on_context_menu: Option<ClickHandler>,
    symbol: Option<(Arc<dyn crate::host::UiHost>, SharedString)>,
    weight: SymbolWeight,
    centres_ink: bool,
}

impl IconButton {
    pub fn new(id: impl Into<ElementId>, icon: Icon, p: &Palette) -> Self {
        IconButton {
            id: id.into(),
            icon,
            glyph: ROW_GLYPH,
            square: 30.,
            radius: radius::TOOLBAR,
            color: p.icon,
            custom_color: false,
            hover: p.toolbar_hover,
            pressed: p.toolbar_pressed,
            toggled: None,
            disabled: false,
            disabled_color: None,
            icon_disabled: p.icon_disabled,
            tip: None,
            on_click: None,
            on_context_menu: None,
            symbol: None,
            weight: SymbolWeight::Regular,
            centres_ink: false,
        }
    }

    pub fn symbol(
        mut self,
        host: Arc<dyn crate::host::UiHost>,
        name: impl Into<SharedString>,
    ) -> Self {
        self.symbol = Some((host, name.into()));
        self
    }

    pub fn size(mut self, size: IconButtonSize) -> Self {
        self.square = size.box_size;
        self.glyph = size.glyph;
        self.radius = if size == ardia_theme::tokens::icon_button::TOOLBAR {
            radius::TOOLBAR
        } else {
            radius::CONTROL
        };
        self
    }

    pub fn capsule(mut self) -> Self {
        self.radius = capsule(self.square);
        self
    }

    pub fn disabled_color(mut self, color: Hsla) -> Self {
        self.disabled_color = Some(color);
        self
    }

    pub fn weight(mut self, weight: SymbolWeight) -> Self {
        self.weight = weight;
        self
    }

    pub fn centres_ink(mut self) -> Self {
        self.centres_ink = true;
        self
    }

    pub fn glyph(mut self, glyph: f32) -> Self {
        self.glyph = glyph;
        self
    }

    pub fn square(mut self, square: f32, radius: f32) -> Self {
        self.square = square;
        self.radius = radius;
        self
    }

    pub fn color(mut self, color: Hsla) -> Self {
        self.color = color;
        self.custom_color = true;
        self
    }

    pub fn fills(mut self, hover: Hsla, pressed: Hsla) -> Self {
        self.hover = hover;
        self.pressed = pressed;
        self
    }

    pub fn toggled(mut self, fill: Option<Hsla>) -> Self {
        self.toggled = fill;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn tooltip(mut self, text: impl Into<SharedString>, p: &Palette) -> Self {
        self.tip = Some((text.into(), *p));
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }

    pub fn on_context_menu(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_context_menu = Some(Rc::new(handler));
        self
    }

    pub fn ink(&self) -> Hsla {
        match (self.disabled, self.disabled_color, self.custom_color) {
            (false, _, _) => self.color,
            (true, Some(dimmed), _) => dimmed,
            (true, None, false) => self.icon_disabled,
            (true, None, true) => self.color.opacity(DISABLED_OPACITY),
        }
    }
}

impl RenderOnce for IconButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let enabled = !self.disabled;
        let ink = self.ink();
        let toggled = self.toggled.filter(|_| enabled);
        let (element, shown) = interactive(
            self.id,
            None,
            window,
            cx,
            |hovered, pressed| enabled && (hovered || pressed || toggled.is_some()),
            toggled.is_some(),
        );
        let fill = match toggled {
            Some(fill) if !shown.pressed => fill,
            _ if shown.pressed => self.pressed,
            _ => self.hover,
        };
        let context_menu = self.on_context_menu.filter(|_| enabled);
        clicks(element, self.on_click.filter(|_| enabled))
            .relative()
            .flex_none()
            .size(px(self.square))
            .flex()
            .items_center()
            .justify_center()
            .children(hover_fill(shown, fill, self.radius))
            .when_some(context_menu, |this, handler| {
                this.on_mouse_down(MouseButton::Right, move |event, window, cx| {
                    cx.stop_propagation();
                    let click = ClickEvent::Mouse(gpui::MouseClickEvent {
                        down: event.clone(),
                        up: gpui::MouseUpEvent {
                            button: event.button,
                            position: event.position,
                            modifiers: event.modifiers,
                            click_count: event.click_count,
                        },
                    });
                    handler(&click, window, cx);
                })
            })
            .when_some(self.tip, |this, (text, p)| this.tooltip(tooltip(text, &p)))
            .child(match self.symbol {
                Some((host, name)) => crate::icon_picker::symbols::symbol(
                    host.as_ref(),
                    &name,
                    self.glyph,
                    self.square,
                    self.weight,
                    ink,
                ),
                None => {
                    let glyph = icon(self.icon, self.glyph, ink).weight(self.weight);
                    if self.centres_ink {
                        glyph.centres_ink().into_any_element()
                    } else {
                        glyph.into_any_element()
                    }
                }
            })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextLook {
    Toolbar,
    Panel,
    Link,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextPlate {
    Toolbar,
    Hover,
    None,
}

#[derive(IntoElement)]
pub struct TextButton {
    id: ElementId,
    title: SharedString,
    plate: TextPlate,
    height: Option<f32>,
    pad: f32,
    pad_y: Option<f32>,
    size: TypeSize,
    weight: Weight,
    tone: Hsla,
    hover_tone: Option<Hsla>,
    underline_on_hover: bool,
    disabled: bool,
    p: Palette,
    on_click: Option<ClickHandler>,
}

impl TextButton {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>, p: &Palette) -> Self {
        TextButton {
            id: id.into(),
            title: title.into(),
            plate: TextPlate::Toolbar,
            height: None,
            pad: space::M,
            pad_y: None,
            size: TypeSize::Small,
            weight: Weight::Medium,
            tone: p.text,
            hover_tone: None,
            underline_on_hover: false,
            disabled: false,
            p: *p,
            on_click: None,
        }
    }

    pub fn look(mut self, look: TextLook) -> Self {
        let p = self.p;
        match look {
            TextLook::Toolbar => {
                self.plate = TextPlate::Toolbar;
                self.height = Some(26.0);
                self.weight = Weight::Medium;
                self.tone = p.text;
            }
            TextLook::Panel => {
                self.plate = TextPlate::Hover;
                self.height = Some(22.0);
                self.weight = Weight::Regular;
                self.tone = p.text_secondary;
            }
            TextLook::Link => {
                self.plate = TextPlate::None;
                self.height = None;
                self.weight = Weight::Medium;
                self.tone = p.accent;
            }
        }
        self.underline_on_hover = look == TextLook::Link;
        self.pad = space::M;
        self.size = TypeSize::Small;
        self
    }

    pub fn plate(mut self, plate: TextPlate) -> Self {
        self.plate = plate;
        self
    }

    pub fn height(mut self, height: f32) -> Self {
        self.height = Some(height);
        self
    }

    pub fn pad(mut self, pad: f32) -> Self {
        self.pad = pad;
        self
    }

    pub fn pad_y(mut self, pad_y: f32) -> Self {
        self.pad_y = Some(pad_y);
        self
    }

    pub fn text_size(mut self, size: TypeSize) -> Self {
        self.size = size;
        self
    }

    pub fn weight(mut self, weight: Weight) -> Self {
        self.weight = weight;
        self
    }

    pub fn tone(mut self, tone: Hsla) -> Self {
        self.tone = tone;
        self
    }

    pub fn hover_tone(mut self, tone: Hsla) -> Self {
        self.hover_tone = Some(tone);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for TextButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let enabled = !self.disabled;
        let plate = self.plate;
        let bounce = press_motion(cx) == PressMotion::Bounce;
        let (element, shown) = interactive(
            self.id,
            bounce.then_some(CONTROL_PRESS_SCALE),
            window,
            cx,
            |hovered, pressed| {
                enabled
                    && plate != TextPlate::None
                    && (hovered || (plate == TextPlate::Toolbar && pressed))
            },
            false,
        );
        let hovered_tone = self.hover_tone.filter(|_| shown.hovered);
        let ink = match (plate, enabled) {
            (TextPlate::None, _) | (_, true) => hovered_tone.unwrap_or(self.tone),
            (_, false) => self.p.icon_disabled,
        };
        let fill = if plate == TextPlate::Toolbar && shown.pressed {
            self.p.toolbar_pressed
        } else {
            self.p.toolbar_hover
        };
        let underline = self.underline_on_hover && shown.hovered;
        let body = div()
            .relative()
            .flex()
            .items_center()
            .when(plate != TextPlate::None, |this| this.px(px(self.pad)))
            .when_some(
                self.height.filter(|_| plate != TextPlate::None),
                |this, h| this.h(px(h)),
            )
            .when_some(
                self.pad_y.filter(|_| plate == TextPlate::None),
                |this, y| this.py(px(y)),
            )
            .children(hover_fill(shown, fill, radius::CONTROL))
            .text_size(px(self.size.points()))
            .font_weight(weight(self.weight))
            .text_color(ink)
            .whitespace_nowrap()
            .when(underline, |this| this.underline())
            .child(div().relative().child(self.title));
        clicks(element, self.on_click.filter(|_| enabled))
            .flex_none()
            .child(press_scaled(body, shown.scale))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PillTone {
    Prompt,
    Chip,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PillSize {
    M,
    L,
    Xl,
}

impl PillSize {
    pub const fn height(self) -> f32 {
        match self {
            PillSize::M => pill_height::M,
            PillSize::L => pill_height::L,
            PillSize::Xl => pill_height::XL,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PillLook {
    pub fill: Hsla,
    pub text: Hsla,
    pub dim: bool,
}

pub fn pill_look(
    p: &Palette,
    tone: PillTone,
    primary: bool,
    pressed: bool,
    hovered: bool,
) -> PillLook {
    let (fill, text, dim) = match (tone, primary) {
        (PillTone::Chip, true) => (p.text, p.on_go, pressed || hovered),
        (PillTone::Chip, false) => (
            if pressed {
                p.toolbar_pressed
            } else if hovered {
                p.toolbar_hover
            } else {
                p.url_pill
            },
            p.text,
            false,
        ),
        (PillTone::Prompt, true) => (
            if pressed {
                p.go_pressed
            } else if hovered {
                p.go_hover
            } else {
                p.go
            },
            p.on_go,
            false,
        ),
        (PillTone::Prompt, false) => (
            if pressed {
                p.prompt_fill_pressed
            } else if hovered {
                p.prompt_fill_hover
            } else {
                p.prompt_fill
            },
            p.text,
            false,
        ),
    };
    PillLook { fill, text, dim }
}

#[derive(IntoElement)]
pub struct PillButton {
    id: ElementId,
    title: SharedString,
    tone: PillTone,
    primary: bool,
    size: Option<PillSize>,
    height: Option<f32>,
    glyph: Option<Icon>,
    disabled: bool,
    p: Palette,
    on_click: Option<ClickHandler>,
}

impl PillButton {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>, p: &Palette) -> Self {
        PillButton {
            id: id.into(),
            title: title.into(),
            tone: PillTone::Prompt,
            primary: false,
            size: None,
            height: None,
            glyph: None,
            disabled: false,
            p: *p,
            on_click: None,
        }
    }

    pub fn chip(mut self) -> Self {
        self.tone = PillTone::Chip;
        self
    }

    pub fn primary(mut self, primary: bool) -> Self {
        self.primary = primary;
        self
    }

    pub fn size(mut self, size: PillSize) -> Self {
        self.size = Some(size);
        self
    }

    pub fn height(mut self, height: f32) -> Self {
        self.height = Some(height);
        self
    }

    pub fn icon(mut self, glyph: Icon) -> Self {
        self.glyph = Some(glyph);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }

    pub fn metrics(&self) -> (f32, f32) {
        match self.tone {
            PillTone::Chip => {
                let height = self
                    .height
                    .unwrap_or(self.size.unwrap_or(PillSize::M).height());
                (height, capsule(height))
            }
            PillTone::Prompt => match self.size {
                Some(size) => (size.height(), capsule(size.height())),
                None => (pill_height::PROMPT, radius::TILE),
            },
        }
    }
}

impl RenderOnce for PillButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let chip = self.tone == PillTone::Chip;
        let enabled = chip || !self.disabled;
        let (height, corner) = self.metrics();
        let (element, shown) = interactive(
            self.id,
            Some(CONTROL_PRESS_SCALE),
            window,
            cx,
            |hovered, pressed| enabled && (hovered || pressed),
            false,
        );
        let (pressed, hovered) = (enabled && shown.pressed, enabled && shown.hovered);
        let look = pill_look(&self.p, self.tone, self.primary, pressed, hovered);
        let rest = pill_look(&self.p, self.tone, self.primary, false, false);
        let body = div()
            .relative()
            .h(px(height))
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .children(hover_swap(shown, rest.fill, look.fill, corner))
            .text_color(look.text)
            .whitespace_nowrap()
            .map(|this| {
                if chip {
                    this.px(px(space::M))
                        .gap(px(space::XS))
                        .when(look.dim, |this| this.opacity(CHIP_DIM))
                        .text_size(px(TypeSize::Small.points()))
                        .font_weight(weight(Weight::Medium))
                        .when_some(self.glyph, |this, glyph| {
                            this.child(div().relative().child(scaled_glyph(
                                glyph,
                                CHIP_GLYPH,
                                CHIP_GLYPH_BOX,
                                look.text,
                                1.0,
                                SymbolWeight::Semibold,
                            )))
                        })
                } else {
                    this.px(px(space::L))
                        .text_size(px(TypeSize::Body.points()))
                        .font_weight(weight(Weight::Medium))
                }
            })
            .child(div().relative().child(self.title));
        clicks(element, self.on_click.filter(|_| enabled))
            .flex_none()
            .when(!enabled, |this| this.opacity(DISABLED_OPACITY))
            .child(press_scaled(body, shown.scale))
    }
}

#[derive(IntoElement)]
pub struct StepperButton {
    id: ElementId,
    glyph: Icon,
    width: f32,
    height: f32,
    disabled: bool,
    tip: SharedString,
    p: Palette,
    on_click: Option<ClickHandler>,
}

impl StepperButton {
    pub fn new(
        id: impl Into<ElementId>,
        glyph: Icon,
        tooltip: impl Into<SharedString>,
        p: &Palette,
    ) -> Self {
        StepperButton {
            id: id.into(),
            glyph,
            width: STEPPER_WIDTH,
            height: STEPPER_HEIGHT,
            disabled: false,
            tip: tooltip.into(),
            p: *p,
            on_click: None,
        }
    }

    pub fn size(mut self, width: f32, height: f32) -> Self {
        self.width = width;
        self.height = height;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for StepperButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let enabled = !self.disabled;
        let p = self.p;
        let (element, shown) = interactive(
            self.id,
            Some(ICON_PRESS_SCALE),
            window,
            cx,
            |hovered, pressed| enabled && (hovered || pressed),
            false,
        );
        let fill = if shown.pressed {
            p.control_pressed
        } else {
            p.control_hover
        };
        let tip = self.tip;
        clicks(element, self.on_click.filter(|_| enabled))
            .relative()
            .flex_none()
            .w(px(self.width))
            .h(px(self.height))
            .flex()
            .items_center()
            .justify_center()
            .when(!enabled, |this| this.opacity(DISABLED_OPACITY))
            .children(hover_swap(shown, p.control, fill, radius::CONTROL))
            .child(div().relative().child(scaled_glyph(
                self.glyph,
                STEPPER_GLYPH,
                STEPPER_GLYPH_BOX,
                p.icon,
                shown.scale,
                SymbolWeight::Semibold,
            )))
            .child(border_layer(
                p.control_border,
                BORDER_WIDTH,
                radius::CONTROL,
            ))
            .tooltip(tooltip(tip, &p))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CloseLook {
    Hud,
    Panel,
    Art { side: f32, corner: f32 },
}

impl CloseLook {
    pub fn art() -> Self {
        CloseLook::Art {
            side: ART_CLOSE_BOX,
            corner: capsule(ART_CLOSE_BOX),
        }
    }
}

#[derive(IntoElement)]
pub struct CloseButton {
    id: ElementId,
    look: CloseLook,
    tip: SharedString,
    p: Palette,
    on_click: Option<ClickHandler>,
}

impl CloseButton {
    pub fn new(id: impl Into<ElementId>, look: CloseLook, p: &Palette) -> Self {
        CloseButton {
            id: id.into(),
            look,
            tip: "Dismiss".into(),
            p: *p,
            on_click: None,
        }
    }

    pub fn tooltip(mut self, text: impl Into<SharedString>) -> Self {
        self.tip = text.into();
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for CloseButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let p = self.p;
        let look = self.look;
        let (element, shown) = interactive(
            self.id,
            Some(ICON_PRESS_SCALE),
            window,
            cx,
            move |hovered, pressed| match look {
                CloseLook::Panel => hovered,
                CloseLook::Art { .. } => hovered || pressed,
                CloseLook::Hud => false,
            },
            matches!(look, CloseLook::Hud),
        );
        let element = clicks(element, self.on_click)
            .relative()
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .tooltip(tooltip(self.tip, &p));
        match look {
            CloseLook::Panel => element
                .size(px(PANEL_CLOSE_BOX))
                .children(hover_fill(shown, p.toolbar_hover, radius::CONTROL))
                .child(div().relative().child(scaled_glyph(
                    Icon::XMark,
                    PANEL_CLOSE_GLYPH,
                    PANEL_CLOSE_GLYPH_BOX,
                    p.text_secondary,
                    shown.scale,
                    SymbolWeight::Semibold,
                ))),
            CloseLook::Art { side, corner } => {
                let fill = if shown.pressed {
                    CLOSE_ON_ART.pressed
                } else {
                    CLOSE_ON_ART.hover
                };
                element
                    .size(px(side))
                    .children(hover_swap(
                        shown,
                        crate::primitives::theme_bridge::hsla(CLOSE_ON_ART.rest),
                        crate::primitives::theme_bridge::hsla(fill),
                        corner,
                    ))
                    .child(div().relative().child(scaled_glyph(
                        Icon::XMark,
                        ART_CLOSE_GLYPH,
                        side,
                        crate::primitives::theme_bridge::hsla(CLOSE_ON_ART.glyph),
                        shown.scale,
                        SymbolWeight::Medium,
                    )))
            }
            CloseLook::Hud => {
                let corner = capsule(HUD_CLOSE_BOX);
                let fill = if shown.hovered {
                    p.hud_close_hover
                } else {
                    p.hud_close_fill
                };
                element
                    .size(px(HUD_CLOSE_BOX))
                    .rounded(px(corner))
                    .overflow_hidden()
                    .child(material_layer(
                        gpui::VisualEffectMaterial::HudWindow,
                        corner,
                        0.0,
                    ))
                    .child(fill_layer(fill, corner))
                    .child(div().relative().child(scaled_glyph(
                        Icon::XMark,
                        HUD_CLOSE_GLYPH,
                        HUD_CLOSE_BOX,
                        p.hud_close_glyph,
                        shown.scale,
                        SymbolWeight::Medium,
                    )))
                    .child(border_layer(p.hud_close_border, 1.0, corner))
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BadgeTone {
    Neutral,
    Accent,
    Chip,
    Now,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BadgeSize {
    S,
    M,
}

impl BadgeSize {
    pub const fn metrics(self) -> (f32, TypeSize, Weight) {
        match self {
            BadgeSize::S => (14.0, TypeSize::Badge, Weight::Bold),
            BadgeSize::M => (18.0, TypeSize::Tiny, Weight::Semibold),
        }
    }
}

pub const BADGE_FITTED_MIN_SCALE: f32 = 0.6;
const BADGE_SHRINK_SLACK: f32 = 1.0;

pub fn badge_fit(
    text_width: f32,
    room: f32,
    roomy_pad: f32,
    tight_pad: f32,
    min_scale: f32,
) -> (f32, f32) {
    if text_width + 2.0 * roomy_pad <= room {
        return (roomy_pad, 1.0);
    }
    let tight_room = room - 2.0 * tight_pad;
    if text_width <= tight_room {
        return (tight_pad, 1.0);
    }
    if text_width <= 0.0 {
        return (tight_pad, min_scale);
    }
    (
        tight_pad,
        ((tight_room - BADGE_SHRINK_SLACK) / text_width).max(min_scale),
    )
}

pub fn badge_look(p: &Palette, tone: BadgeTone) -> (Hsla, Hsla) {
    match tone {
        BadgeTone::Accent => (p.accent, p.on_accent),
        BadgeTone::Now => (p.destructive, p.on_accent),
        BadgeTone::Chip => (p.chip_fill, p.text_secondary),
        BadgeTone::Neutral => (p.badge_fill, p.text_tab),
    }
}

#[derive(IntoElement)]
pub struct Badge {
    text: SharedString,
    tone: BadgeTone,
    size: BadgeSize,
    outline: bool,
    ring: Option<Hsla>,
    fill: Option<Hsla>,
    color: Option<Hsla>,
    fit: Option<f32>,
    p: Palette,
}

impl Badge {
    pub fn new(text: impl Into<SharedString>, p: &Palette) -> Self {
        Badge {
            text: text.into(),
            tone: BadgeTone::Neutral,
            size: BadgeSize::M,
            outline: false,
            ring: None,
            fill: None,
            color: None,
            fit: None,
            p: *p,
        }
    }

    pub fn tone(mut self, tone: BadgeTone) -> Self {
        self.tone = tone;
        self
    }

    pub fn small(mut self) -> Self {
        self.size = BadgeSize::S;
        self
    }

    pub fn outline(mut self) -> Self {
        self.outline = true;
        self
    }

    pub fn ring(mut self, ring: Hsla) -> Self {
        self.ring = Some(ring);
        self
    }

    pub fn fill(mut self, fill: Hsla) -> Self {
        self.fill = Some(fill);
        self
    }

    pub fn color(mut self, color: Hsla) -> Self {
        self.color = Some(color);
        self
    }

    pub fn fit(mut self, room: f32) -> Self {
        self.fit = Some(room);
        self
    }
}

impl RenderOnce for Badge {
    fn render(self, window: &mut Window, _: &mut App) -> impl IntoElement {
        let (height, size, weight_token) = self.size.metrics();
        let (look_fill, look_ink) = badge_look(&self.p, self.tone);
        let ink = self
            .color
            .unwrap_or(if self.outline { look_fill } else { look_ink });
        let features = FontFeatures(Arc::new(vec![("tnum".into(), 1)]));
        let font_size = size.points();
        let (pad, scale) = match self.fit {
            Some(room) => {
                let mut font = window.text_style().font();
                font.weight = weight(weight_token);
                font.features = features.clone();
                let run = TextRun {
                    len: self.text.len(),
                    font,
                    color: ink,
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let measured = window
                    .text_system()
                    .shape_line(self.text.clone(), px(font_size), &[run], None)
                    .width;
                badge_fit(
                    crate::scale::points(measured),
                    room,
                    space::XS,
                    space::XXS,
                    BADGE_FITTED_MIN_SCALE,
                )
            }
            None => (space::XS, 1.0),
        };
        div()
            .flex_none()
            .h(px(height))
            .min_w(px(height))
            .rounded(px(capsule(height)))
            .px(px(pad))
            .flex()
            .items_center()
            .justify_center()
            .when(!self.outline, |this| {
                this.bg(self.fill.unwrap_or(look_fill))
            })
            .map(|this| match (self.outline, self.ring) {
                (true, _) => this.border(px(hairline::PANEL)).border_color(ink),
                (false, Some(ring)) => this.border(px(1.0)).border_color(ring),
                (false, None) => this,
            })
            .text_size(px(font_size * scale))
            .line_height(px(size.line_height()))
            .font_weight(weight(weight_token))
            .font_features(features)
            .text_color(ink)
            .whitespace_nowrap()
            .child(self.text)
    }
}

pub fn badge(text: impl Into<SharedString>, p: &Palette) -> Badge {
    Badge::new(text, p)
}

const SPINNER_SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 12 12\" fill=\"none\" stroke=\"#000\" stroke-width=\"1.5\"><circle cx=\"6\" cy=\"6\" r=\"4.75\" stroke-opacity=\"0.18\"/><circle cx=\"6\" cy=\"6\" r=\"4.75\" stroke-linecap=\"round\" stroke-dasharray=\"21.49 29.85\" transform=\"rotate(-90 6 6)\"/></svg>";

pub fn spinner(side: f32, color: Hsla) -> impl IntoElement {
    svg()
        .data(SPINNER_SVG.as_bytes())
        .flex_none()
        .size(px(side))
        .text_color(color)
        .with_timed_transformation(TimedTransformation::rotation(
            Duration::from_millis(ardia_theme::motion::SPINNER_PERIOD_MS),
            Transformation::default(),
        ))
}

pub fn progress_ring(side: f32, fraction: f32, track: Hsla, color: Hsla) -> impl IntoElement {
    let fraction = fraction.clamp(0.0, 1.0);
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let center = bounds.center();
            let radius =
                (f32::from(bounds.size.width.min(bounds.size.height)) / 2.0 - 1.25).max(1.0);
            let ring = |end: f32| {
                let mut builder = gpui::PathBuilder::stroke(px(1.5));
                let steps = 48;
                let count = ((steps as f32 * end).ceil() as usize).max(1);
                for step in 0..=count {
                    let angle = -std::f32::consts::FRAC_PI_2
                        + std::f32::consts::TAU * end * step as f32 / count as f32;
                    let at = point(
                        center.x + px(radius * angle.cos()),
                        center.y + px(radius * angle.sin()),
                    );
                    if step == 0 {
                        builder.move_to(at);
                    } else {
                        builder.line_to(at);
                    }
                }
                builder.build()
            };
            if let Ok(path) = ring(1.0) {
                window.paint_path(path, track);
            }
            if fraction > 0.0
                && let Ok(path) = ring(fraction)
            {
                window.paint_path(path, color);
            }
        },
    )
    .flex_none()
    .size(px(side))
}

pub fn progress_bar(fraction: f32, track: Hsla, color: Hsla) -> impl IntoElement {
    div()
        .relative()
        .w_full()
        .h(px(3.))
        .rounded_full()
        .bg(track)
        .child(
            div()
                .absolute()
                .left_0()
                .top_0()
                .h_full()
                .w(relative(fraction.clamp(0.0, 1.0)))
                .rounded_full()
                .bg(color),
        )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonKind {
    Plain,
    Primary,
    Destructive,
    Link,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PushLook {
    pub rest: Option<Hsla>,
    pub hover: Option<Hsla>,
    pub pressed: Option<Hsla>,
    pub ink: Hsla,
    pub border: bool,
}

pub fn push_look(p: &Palette, kind: ButtonKind) -> PushLook {
    match kind {
        ButtonKind::Plain | ButtonKind::Destructive => PushLook {
            rest: Some(p.control),
            hover: Some(p.control_hover),
            pressed: Some(p.control_pressed),
            ink: if kind == ButtonKind::Destructive {
                p.destructive
            } else {
                p.text
            },
            border: true,
        },
        ButtonKind::Primary => PushLook {
            rest: Some(p.form_accent),
            hover: None,
            pressed: Some(p.form_accent_pressed),
            ink: p.on_accent,
            border: false,
        },
        ButtonKind::Link => PushLook {
            rest: None,
            hover: None,
            pressed: None,
            ink: p.form_accent,
            border: false,
        },
    }
}

#[derive(IntoElement)]
pub struct PushButton {
    id: ElementId,
    label: SharedString,
    kind: ButtonKind,
    glyph: Option<Icon>,
    height: f32,
    disabled: bool,
    p: Palette,
    on_click: Option<ClickHandler>,
}

impl PushButton {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, p: &Palette) -> Self {
        PushButton {
            id: id.into(),
            label: label.into(),
            kind: ButtonKind::Plain,
            glyph: None,
            height: PUSH_HEIGHT,
            disabled: false,
            p: *p,
            on_click: None,
        }
    }

    pub fn kind(mut self, kind: ButtonKind) -> Self {
        self.kind = kind;
        self
    }

    pub fn icon(mut self, glyph: Icon) -> Self {
        self.glyph = Some(glyph);
        self
    }

    pub fn height(mut self, height: f32) -> Self {
        self.height = height;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for PushButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let enabled = !self.disabled;
        let kind = self.kind;
        let look = push_look(&self.p, kind);
        let link = kind == ButtonKind::Link;
        let swaps = look.border;
        let (element, shown) = interactive(
            self.id,
            enabled.then_some(CONTROL_PRESS_SCALE),
            window,
            cx,
            |hovered, pressed| enabled && swaps && (hovered || pressed),
            false,
        );
        let corner = radius::CONTROL;
        let layers: Vec<Div> = match (look.rest, kind) {
            (Some(rest), ButtonKind::Primary) => {
                let fill = match look.pressed {
                    Some(pressed) if shown.pressed && enabled => pressed,
                    _ => rest,
                };
                vec![fill_layer(fill, corner)]
            }
            (Some(rest), _) => {
                let swap = if shown.pressed {
                    look.pressed.unwrap_or(rest)
                } else {
                    look.hover.unwrap_or(rest)
                };
                hover_swap(shown, rest, swap, corner)
            }
            (None, _) => Vec::new(),
        };
        let underline = link && enabled && shown.hovered;
        let body = div()
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(space::XS))
            .when(!link, |this| {
                this.h(px(self.height))
                    .px(px(space::ML + if look.border { BORDER_WIDTH } else { 0.0 }))
            })
            .children(layers)
            .text_size(px(TypeSize::Body.points()))
            .text_color(look.ink)
            .whitespace_nowrap()
            .when(underline, |this| this.underline())
            .when_some(self.glyph, |this, glyph| {
                this.child(div().relative().child(scaled_glyph(
                    glyph,
                    PUSH_GLYPH,
                    PUSH_GLYPH_BOX,
                    look.ink,
                    1.0,
                    SymbolWeight::Regular,
                )))
            })
            .child(div().relative().child(self.label))
            .when(look.border, |this| {
                this.child(border_layer(self.p.control_border, BORDER_WIDTH, corner))
            });
        clicks(element, self.on_click.filter(|_| enabled))
            .flex_none()
            .when(!enabled, |this| this.opacity(DISABLED_OPACITY))
            .child(press_scaled(body, shown.scale))
    }
}

pub const KEY_CAP_HEIGHT: f32 = 24.0;
pub const KEY_CAP_MIN_WIDTH: f32 = 38.0;
pub const KEY_CAP_EDITING_RING: f32 = 1.5;
pub const KEY_CAP_EDITING_FILL: f32 = 0.2;

#[derive(IntoElement)]
pub struct KeyCap {
    keys: SharedString,
    editing: bool,
    empty: bool,
    hovered: bool,
    scale: f32,
    p: Palette,
}

impl KeyCap {
    pub fn new(keys: impl Into<SharedString>, p: &Palette) -> Self {
        KeyCap {
            keys: keys.into(),
            editing: false,
            empty: false,
            hovered: false,
            scale: 1.0,
            p: *p,
        }
    }

    pub fn editing(mut self, editing: bool) -> Self {
        self.editing = editing;
        self
    }

    pub fn empty(mut self, empty: bool) -> Self {
        self.empty = empty;
        self
    }

    pub fn hovered(mut self, hovered: bool) -> Self {
        self.hovered = hovered;
        self
    }

    pub fn scale(mut self, scale: f32) -> Self {
        self.scale = scale;
        self
    }

    pub fn colors(&self) -> (Hsla, Hsla, f32, Hsla) {
        let p = &self.p;
        let fill = if self.editing {
            p.form_accent.opacity(KEY_CAP_EDITING_FILL)
        } else if self.hovered {
            p.control_hover
        } else {
            p.control
        };
        let (ring, ring_width) = if self.editing {
            (p.form_accent, KEY_CAP_EDITING_RING)
        } else {
            (p.control_border, BORDER_WIDTH)
        };
        let ink = if self.editing {
            p.form_accent
        } else if self.empty {
            p.text_tertiary
        } else {
            p.text
        };
        (fill, ring, ring_width, ink)
    }
}

impl RenderOnce for KeyCap {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let (fill, ring, ring_width, ink) = self.colors();
        let scale = self.scale;
        div()
            .flex_none()
            .min_w(px(KEY_CAP_MIN_WIDTH * scale))
            .h(px(KEY_CAP_HEIGHT * scale))
            .px(px(space::M * scale))
            .rounded(px(radius::CONTROL * scale))
            .bg(fill)
            .border(px(ring_width))
            .border_color(ring)
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(TypeSize::Small.points() * scale))
            .font_weight(weight(Weight::Medium))
            .text_color(ink)
            .whitespace_nowrap()
            .child(self.keys)
    }
}

pub fn keycap(text: impl Into<SharedString>, p: &Palette) -> AnyElement {
    KeyCap::new(text, p).into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::look::Palette;

    fn palettes() -> [Palette; 2] {
        let state = ardia_state::BrowserState::from_session(
            ardia_state::persistence::session::SessionData::fresh(
                ardia_state::persistence::session::LoadOptions::default(),
            ),
            0,
        );
        [gpui::WindowAppearance::Dark, gpui::WindowAppearance::Light]
            .map(|appearance| crate::look::Look::new(&state, "missing", appearance).p)
    }

    #[test]
    fn push_buttons_follow_the_old_kinds() {
        for p in palettes() {
            let plain = push_look(&p, ButtonKind::Plain);
            assert_eq!(plain.rest, Some(p.control));
            assert_eq!(plain.hover, Some(p.control_hover));
            assert_eq!(plain.pressed, Some(p.control_pressed));
            assert_eq!(plain.ink, p.text);
            assert!(plain.border);
            assert_eq!(push_look(&p, ButtonKind::Destructive).ink, p.destructive);
            let primary = push_look(&p, ButtonKind::Primary);
            assert_eq!(primary.rest, Some(p.form_accent));
            assert_eq!(primary.hover, None);
            assert_eq!(primary.pressed, Some(p.form_accent_pressed));
            assert_eq!(primary.ink, p.on_accent);
            let link = push_look(&p, ButtonKind::Link);
            assert_eq!(link.rest, None);
            assert_eq!(link.ink, p.form_accent);
        }
        assert_eq!(PUSH_HEIGHT, 22.0);
        assert_eq!(BORDER_WIDTH, 1.0);
    }

    #[test]
    fn pills_pick_their_fill_by_tone_and_state() {
        for p in palettes() {
            assert_eq!(
                pill_look(&p, PillTone::Prompt, false, false, false).fill,
                p.prompt_fill
            );
            assert_eq!(
                pill_look(&p, PillTone::Prompt, false, false, true).fill,
                p.prompt_fill_hover
            );
            assert_eq!(
                pill_look(&p, PillTone::Prompt, false, true, true).fill,
                p.prompt_fill_pressed
            );
            assert_eq!(
                pill_look(&p, PillTone::Prompt, true, false, true).fill,
                p.go_hover
            );
            assert_eq!(
                pill_look(&p, PillTone::Prompt, true, true, true).text,
                p.on_go
            );
            assert_eq!(
                pill_look(&p, PillTone::Chip, false, false, false).fill,
                p.url_pill
            );
            assert_eq!(
                pill_look(&p, PillTone::Chip, false, true, true).fill,
                p.toolbar_pressed
            );
            let primary_chip = pill_look(&p, PillTone::Chip, true, false, true);
            assert_eq!(primary_chip.fill, p.text);
            assert!(primary_chip.dim);
            assert!(!pill_look(&p, PillTone::Chip, true, false, false).dim);
            let prompt = PillButton::new("pill", "Go", &p);
            assert_eq!(prompt.metrics(), (28.0, radius::TILE));
            assert_eq!(
                PillButton::new("pill", "Go", &p)
                    .size(PillSize::L)
                    .metrics(),
                (30.0, 15.0)
            );
            assert_eq!(
                PillButton::new("chip", "Go", &p).chip().metrics(),
                (24.0, 12.0)
            );
            assert_eq!(
                PillButton::new("chip", "Go", &p)
                    .chip()
                    .height(20.0)
                    .metrics(),
                (20.0, 10.0)
            );
        }
    }

    #[test]
    fn disabled_icon_buttons_use_the_disabled_ink_role() {
        for p in palettes() {
            let button = IconButton::new("b", Icon::XMark, &p).disabled(true);
            assert_eq!(button.ink(), p.icon_disabled);
            let tinted = IconButton::new("b", Icon::XMark, &p)
                .color(p.accent)
                .disabled(true);
            assert_eq!(tinted.ink(), p.accent.opacity(DISABLED_OPACITY));
            let dimmed = IconButton::new("b", Icon::XMark, &p)
                .disabled_color(p.text_tertiary)
                .disabled(true);
            assert_eq!(dimmed.ink(), p.text_tertiary);
            assert_eq!(IconButton::new("b", Icon::XMark, &p).ink(), p.icon);
        }
        let p = palettes()[0];
        let small = IconButton::new("b", Icon::XMark, &p).size(ardia_theme::tokens::icon_button::S);
        assert_eq!(
            (small.square, small.glyph, small.radius),
            (22.0, 10.0, radius::CONTROL)
        );
        let toolbar =
            IconButton::new("b", Icon::XMark, &p).size(ardia_theme::tokens::icon_button::TOOLBAR);
        assert_eq!(
            (toolbar.square, toolbar.glyph, toolbar.radius),
            (30.0, 15.0, radius::TOOLBAR)
        );
        assert_eq!(
            IconButton::new("b", Icon::XMark, &p)
                .square(24.0, 4.0)
                .capsule()
                .radius,
            12.0
        );
    }

    #[test]
    fn badges_fit_their_room_like_the_old_badge() {
        assert_eq!(badge_fit(10.0, 30.0, 4.0, 2.0, 0.6), (4.0, 1.0));
        assert_eq!(badge_fit(14.0, 20.0, 4.0, 2.0, 0.6), (2.0, 1.0));
        let (pad, scale) = badge_fit(20.0, 20.0, 4.0, 2.0, 0.6);
        assert_eq!(pad, 2.0);
        assert!((scale - 15.0 / 20.0).abs() < 1e-6);
        assert_eq!(badge_fit(100.0, 20.0, 4.0, 2.0, 0.6).1, 0.6);
        assert_eq!(
            BadgeSize::S.metrics(),
            (14.0, TypeSize::Badge, Weight::Bold)
        );
        assert_eq!(
            BadgeSize::M.metrics(),
            (18.0, TypeSize::Tiny, Weight::Semibold)
        );
        for p in palettes() {
            assert_eq!(
                badge_look(&p, BadgeTone::Neutral),
                (p.badge_fill, p.text_tab)
            );
            assert_eq!(badge_look(&p, BadgeTone::Accent), (p.accent, p.on_accent));
            assert_eq!(badge_look(&p, BadgeTone::Now), (p.destructive, p.on_accent));
            assert_eq!(
                badge_look(&p, BadgeTone::Chip),
                (p.chip_fill, p.text_secondary)
            );
        }
    }

    #[test]
    fn key_caps_show_editing_hover_and_empty_states() {
        let p = palettes()[1];
        let rest = KeyCap::new("⌘K", &p).colors();
        assert_eq!(rest, (p.control, p.control_border, 1.0, p.text));
        assert_eq!(
            KeyCap::new("", &p).hovered(true).colors().0,
            p.control_hover
        );
        assert_eq!(KeyCap::new("", &p).empty(true).colors().3, p.text_tertiary);
        let editing = KeyCap::new("", &p).editing(true).empty(true).colors();
        assert_eq!(
            editing,
            (
                p.form_accent.opacity(0.2),
                p.form_accent,
                1.5,
                p.form_accent
            )
        );
    }
}
