use ardia_theme::tokens::{hairline, radius};
use gpui::{
    AnyElement, App, Div, Hsla, IntoElement, ParentElement, RenderOnce, Styled, Window, div,
    prelude::*, relative,
};

use crate::look::Palette;
use crate::primitives::icons::{Icon, icon};
use crate::scale::px;

pub const THICK_DIVIDER: f32 = hairline::PANEL * 2.0;

#[derive(IntoElement)]
pub struct Divider {
    vertical: bool,
    length: Option<f32>,
    inset: f32,
    color: Hsla,
    thick: bool,
}

impl Divider {
    pub fn horizontal(p: &Palette) -> Self {
        Divider {
            vertical: false,
            length: None,
            inset: 0.0,
            color: p.divider,
            thick: false,
        }
    }

    pub fn vertical(p: &Palette) -> Self {
        Divider {
            vertical: true,
            ..Divider::horizontal(p)
        }
    }

    pub fn length(mut self, length: f32) -> Self {
        self.length = Some(length);
        self
    }

    pub fn inset(mut self, inset: f32) -> Self {
        self.inset = inset;
        self
    }

    pub fn color(mut self, color: Hsla) -> Self {
        self.color = color;
        self
    }

    pub fn thick(mut self) -> Self {
        self.thick = true;
        self
    }

    pub fn thickness(&self) -> f32 {
        if self.thick {
            THICK_DIVIDER
        } else {
            hairline::PANEL
        }
    }
}

impl RenderOnce for Divider {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let thickness = px(self.thickness());
        let line = div().flex_none().bg(self.color);
        if self.vertical {
            line.w(thickness)
                .my(px(self.inset))
                .map(|line| match self.length {
                    Some(length) => line.h(px(length)),
                    None => line.self_stretch(),
                })
        } else {
            line.h(thickness)
                .mx(px(self.inset))
                .when_some(self.length, |line, length| line.w(px(length)))
        }
    }
}

pub fn dot(size: f32, color: Hsla) -> Div {
    div()
        .flex_none()
        .size(px(size))
        .rounded(px(ardia_theme::tokens::capsule(size)))
        .bg(color)
        .flex()
        .items_center()
        .justify_center()
}

pub fn ringed_dot(size: f32, color: Hsla, ring: Hsla, ring_width: f32) -> Div {
    dot(size, color).border(px(ring_width)).border_color(ring)
}

pub const PROGRESS_TRACK_HEIGHT: f32 = 3.0;

#[derive(IntoElement)]
pub struct ProgressTrack {
    value: f32,
    height: f32,
    color: Hsla,
    track: Option<Hsla>,
}

pub fn progress_track(value: f32, p: &Palette) -> ProgressTrack {
    ProgressTrack {
        value,
        height: PROGRESS_TRACK_HEIGHT,
        color: p.accent,
        track: Some(p.progress_track),
    }
}

pub fn progress_fraction(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

impl ProgressTrack {
    pub fn height(mut self, height: f32) -> Self {
        self.height = height;
        self
    }

    pub fn color(mut self, color: Hsla) -> Self {
        self.color = color;
        self
    }

    pub fn no_track(mut self) -> Self {
        self.track = None;
        self
    }
}

impl RenderOnce for ProgressTrack {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let ends = px(ardia_theme::tokens::capsule(self.height));
        div()
            .relative()
            .w_full()
            .h(px(self.height))
            .rounded(ends)
            .overflow_hidden()
            .when_some(self.track, |this, track| this.bg(track))
            .child(
                div()
                    .h(px(self.height))
                    .w(relative(progress_fraction(self.value)))
                    .rounded(ends)
                    .bg(self.color),
            )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconTileSize {
    S,
    M,
    L,
}

impl IconTileSize {
    pub const fn metrics(self) -> (f32, f32) {
        match self {
            IconTileSize::S => (26.0, 13.0),
            IconTileSize::M => (28.0, 13.0),
            IconTileSize::L => (36.0, 18.0),
        }
    }
}

#[derive(IntoElement)]
pub struct IconTile {
    symbol: Option<Icon>,
    size: IconTileSize,
    fill: Hsla,
    glyph: Hsla,
    content: Option<AnyElement>,
}

impl IconTile {
    pub fn new(symbol: Icon, p: &Palette) -> Self {
        IconTile {
            symbol: Some(symbol),
            size: IconTileSize::M,
            fill: p.prompt_fill,
            glyph: p.icon,
            content: None,
        }
    }

    pub fn holding(content: impl IntoElement, p: &Palette) -> Self {
        IconTile {
            symbol: None,
            content: Some(content.into_any_element()),
            ..IconTile::new(Icon::Doc, p)
        }
    }

    pub fn size(mut self, size: IconTileSize) -> Self {
        self.size = size;
        self
    }

    pub fn fill(mut self, fill: Hsla) -> Self {
        self.fill = fill;
        self
    }

    pub fn glyph(mut self, glyph: Hsla) -> Self {
        self.glyph = glyph;
        self
    }
}

impl RenderOnce for IconTile {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let (side, glyph) = self.size.metrics();
        div()
            .flex_none()
            .size(px(side))
            .rounded(px(radius::TILE))
            .bg(self.fill)
            .flex()
            .items_center()
            .justify_center()
            .map(|tile| match self.symbol {
                Some(symbol) => tile.child(icon(symbol, glyph, self.glyph)),
                None => tile.children(self.content),
            })
    }
}

pub const HOVER_SLOT_WIDTH: f32 = ardia_theme::tokens::icon_button::S.box_size;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SlotWidth {
    Fixed(f32),
    Content,
}

#[derive(IntoElement)]
pub struct HoverSlot {
    hovered: bool,
    hover: Option<AnyElement>,
    rest: Option<AnyElement>,
    width: SlotWidth,
    reserve_always: bool,
    align_start: bool,
}

impl HoverSlot {
    pub fn new(hovered: bool) -> Self {
        HoverSlot {
            hovered,
            hover: None,
            rest: None,
            width: SlotWidth::Fixed(HOVER_SLOT_WIDTH),
            reserve_always: true,
            align_start: false,
        }
    }

    pub fn hover(mut self, hover: impl IntoElement) -> Self {
        self.hover = Some(hover.into_any_element());
        self
    }

    pub fn rest(mut self, rest: impl IntoElement) -> Self {
        self.rest = Some(rest.into_any_element());
        self
    }

    pub fn width(mut self, width: f32) -> Self {
        self.width = SlotWidth::Fixed(width);
        self
    }

    pub fn content_width(mut self) -> Self {
        self.width = SlotWidth::Content;
        self
    }

    pub fn reserve_on_hover(mut self) -> Self {
        self.reserve_always = false;
        self
    }

    pub fn align_start(mut self) -> Self {
        self.align_start = true;
        self
    }

    pub fn shows_hover(&self) -> bool {
        self.hovered && self.hover.is_some()
    }

    pub fn reserved_width(&self) -> Option<f32> {
        match self.width {
            SlotWidth::Fixed(width) if self.reserve_always || self.shows_hover() => Some(width),
            SlotWidth::Fixed(_) => Some(0.0),
            SlotWidth::Content => None,
        }
    }
}

impl RenderOnce for HoverSlot {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let showing = self.shows_hover();
        let reserved = self.reserved_width();
        let content = self.width == SlotWidth::Content;
        let measures_hover = content && (self.reserve_always || showing);
        let align_start = self.align_start;
        let layer = move |child: Div| {
            let child = child
                .col_start(1)
                .row_start(1)
                .h_full()
                .flex()
                .flex_row()
                .items_center();
            if align_start {
                child.justify_start()
            } else {
                child.justify_end()
            }
        };
        let rest = self.rest.map(|rest| {
            layer(div())
                .when(showing, |this| this.opacity(0.0).invisible())
                .child(rest)
        });
        let hover = self.hover.map(|hover| {
            layer(div())
                .when(!showing, |this| this.opacity(0.0).invisible())
                .child(hover)
        });
        div()
            .flex_none()
            .self_stretch()
            .grid()
            .grid_cols_max_content(1)
            .when_some(reserved, |this, width| this.min_w(px(width)))
            .map(|this| {
                if align_start {
                    this.justify_start()
                } else {
                    this.justify_end()
                }
            })
            .children(rest)
            .when(showing || measures_hover, |this| this.children(hover))
    }
}
