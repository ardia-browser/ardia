use gpui::{AnyElement, Hsla, IntoElement, ParentElement, Styled, div, prelude::*, relative, rgb};

use crate::look::Palette;
use crate::primitives::icons::{Icon, icon};
use crate::scale::px;

pub const CHROME_RADIUS: f32 = 10.0;
pub const TILE_RADIUS: f32 = 8.0;
pub const CARD_INNER_RADIUS: f32 = 11.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub scale: f32,
    pub pad: f32,
    pub gap: f32,
    pub side: SideWidth,
    pub side_top: f32,
    pub side_field_top: f32,
    pub bar: f32,
    pub bar_gap: f32,
    pub tab: f32,
    pub tabs_left: f32,
    pub side_field: f32,
    pub toolbar: f32,
    pub toolbar_field: f32,
    pub nav: (f32, f32),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SideWidth {
    Points(f32),
    Share(f32),
}

pub const SMALL: Geometry = Geometry {
    scale: 0.4,
    pad: 6.,
    gap: 8.,
    side: SideWidth::Points(36.),
    side_top: 4.,
    side_field_top: 4.,
    bar: 4.,
    bar_gap: 4.,
    tab: 7.,
    tabs_left: 12.,
    side_field: 8.,
    toolbar: 13.,
    toolbar_field: 7.,
    nav: (14., 4.),
};

pub const MEDIUM: Geometry = Geometry {
    scale: 0.4,
    pad: 6.,
    gap: 4.,
    side: SideWidth::Share(0.26),
    side_top: 8.,
    side_field_top: 4.,
    bar: 5.,
    bar_gap: 4.,
    tab: 7.,
    tabs_left: 12.,
    side_field: 8.,
    toolbar: 13.,
    toolbar_field: 7.,
    nav: (14., 4.),
};

pub const LARGE: Geometry = Geometry {
    scale: 0.5,
    pad: 8.,
    gap: 4.,
    side: SideWidth::Share(0.26),
    side_top: 10.,
    side_field_top: 4.,
    bar: 7.,
    bar_gap: 4.,
    tab: 10.,
    tabs_left: 24.,
    side_field: 10.,
    toolbar: 16.,
    toolbar_field: 9.,
    nav: (18., 5.),
};

pub const TAB_ROWS: [f32; 4] = [1., 0.85, 0.95, 0.7];
pub const TOP_TAB_ROWS: [f32; 4] = [1., 1., 1., 1.];
pub const SHORT_TAB_ROWS: [f32; 3] = [1., 0.8, 0.9];
const SWITCHER_CARDS: [bool; 3] = [false, true, false];
const SWITCHER_ROWS: [f32; 4] = [0.8, 0.65, 0.9, 0.55];
const SWITCHER_ROW_LIT: usize = 1;
const SWITCHER_ROW: f32 = 9.;
const RESULT_LINES: [f32; 2] = [0.9, 0.6];
const PAGE_LINES: [f32; 5] = [0.9, 0.75, 0.85, 0.6, 0.8];
const PREVIEW_SCALE: f32 = 0.5;
const GAP: f32 = 4.;
const SWITCHER_CARD: f32 = 24.;
const COMMAND_FIELD: f32 = 10.;
const LINE: f32 = 4.;
const LIT_BORDER: f32 = 1.5;
const LIT_ALPHA: f32 = 0x33 as f32 / 255.;
const FAINT_ALPHA: f32 = 0x59 as f32 / 255.;
const PAGE_PAD: f32 = 6.;
const BELOW_TOOLBAR: f32 = 22.;
const SCROLL_MARK: f32 = 10.;
const STRIP: f32 = 3.;
const STRIP_TOP: f32 = 3.;
const STRIP_INSET: f32 = 3.;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    pub window: Hsla,
    pub bar: Hsla,
    pub page: Hsla,
    pub field: Option<Hsla>,
    pub accent: Option<Hsla>,
    pub edge: Option<Hsla>,
    pub closed: Option<Hsla>,
}

impl Look {
    pub fn settings(p: &Palette) -> Look {
        let dark = p.dark;
        Look {
            window: if dark {
                rgb(0x2A2A2C).into()
            } else {
                rgb(0xE9E9EB).into()
            },
            bar: if dark {
                gpui::hsla(0., 0., 1., 0.22)
            } else {
                gpui::hsla(0., 0., 0., 0.16)
            },
            page: if dark {
                gpui::hsla(0., 0., 1., 0.08)
            } else {
                gpui::hsla(0., 0., 1., 1.)
            },
            field: None,
            accent: Some(p.form_accent),
            edge: None,
            closed: Some(if dark {
                gpui::hsla(0., 0., 1., 0.25)
            } else {
                gpui::hsla(0., 0., 0., 0.2)
            }),
        }
    }

    pub fn plain(self) -> Look {
        Look {
            accent: None,
            ..self
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    Side,
    Top,
    Plain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Side,
    Toolbar,
}

pub struct MiniWindow {
    pub layout: Layout,
    pub right: bool,
    pub bars: Vec<f32>,
    pub accent_bar: Option<usize>,
    pub faint_bar: Option<usize>,
    pub closed_bar: Option<usize>,
    pub field: Option<Field>,
    pub field_lit: bool,
    pub look: Look,
    pub geometry: Geometry,
    pub overlay: Option<AnyElement>,
    pub body: Option<AnyElement>,
    pub corners: (f32, f32),
}

impl MiniWindow {
    pub fn new(layout: Layout, look: Look, geometry: Geometry) -> Self {
        MiniWindow {
            layout,
            right: false,
            bars: vec![1.; 3],
            accent_bar: None,
            faint_bar: None,
            closed_bar: None,
            field: None,
            field_lit: true,
            look,
            geometry,
            overlay: None,
            body: None,
            corners: (CARD_INNER_RADIUS, CARD_INNER_RADIUS),
        }
    }

    pub fn bars(mut self, bars: &[f32]) -> Self {
        self.bars = bars.to_vec();
        self
    }

    pub fn accent(mut self, index: usize) -> Self {
        self.accent_bar = Some(index);
        self
    }

    pub fn faint(mut self, index: usize) -> Self {
        self.faint_bar = Some(index);
        self
    }

    pub fn closed(mut self, index: usize) -> Self {
        self.closed_bar = Some(index);
        self
    }

    pub fn field(mut self, field: Field, lit: bool) -> Self {
        self.field = Some(field);
        self.field_lit = lit;
        self
    }

    pub fn right(mut self, right: bool) -> Self {
        self.right = right;
        self
    }

    pub fn overlay(mut self, overlay: AnyElement) -> Self {
        self.overlay = Some(overlay);
        self
    }

    pub fn corners(mut self, left: f32, right: f32) -> Self {
        self.corners = (left, right);
        self
    }

    pub fn body(mut self, body: AnyElement) -> Self {
        self.body = Some(body);
        self
    }

    fn chrome_radius(&self, height: f32) -> f32 {
        (CHROME_RADIUS * self.geometry.scale).min(height / 2.)
    }

    fn bar(&self, index: usize, width: f32, height: f32, flex: bool) -> gpui::Div {
        let look = self.look;
        let base = div().h(px(height)).rounded(px(if flex {
            self.chrome_radius(height)
        } else {
            height / 2.
        }));
        let base = if flex {
            base.flex_grow(1.).flex_basis(relative(width))
        } else {
            base.w(relative(width))
        };
        if Some(index) == self.closed_bar {
            return base
                .border(px(1.))
                .border_dashed()
                .border_color(look.closed.unwrap_or(look.bar));
        }
        let color = match (look.accent, self.accent_bar, self.faint_bar) {
            (Some(accent), Some(lit), _) if lit == index => accent,
            (Some(accent), _, Some(faint)) if faint == index => accent.opacity(FAINT_ALPHA),
            _ => look.bar,
        };
        base.bg(color)
    }

    fn field_box(&self, height: f32) -> gpui::Div {
        let look = self.look;
        let edge = look.accent.filter(|_| self.field_lit);
        div()
            .h(px(height))
            .rounded(px(self.chrome_radius(height)))
            .bg(look.field.unwrap_or(look.bar))
            .when_some(edge, |this, edge| this.border(px(1.)).border_color(edge))
    }

    pub fn render(self) -> AnyElement {
        let g = self.geometry;
        let look = self.look;
        let side = (self.layout == Layout::Side).then(|| {
            let column = div()
                .flex_none()
                .flex()
                .flex_col()
                .gap(px(g.bar_gap))
                .pt(px(if self.field == Some(Field::Side) {
                    g.side_field_top
                } else {
                    g.side_top
                }));
            let column = match g.side {
                SideWidth::Points(width) => column.w(px(width)),
                SideWidth::Share(share) => column.w(relative(share)),
            };
            column
                .when(self.field == Some(Field::Side), |this| {
                    this.child(self.field_box(g.side_field))
                })
                .children(
                    self.bars
                        .iter()
                        .enumerate()
                        .map(|(index, width)| self.bar(index, *width, g.bar, false)),
                )
        });
        let tabs = (self.layout == Layout::Top).then(|| {
            div()
                .flex_none()
                .h(px(g.tab))
                .flex()
                .gap(px(g.bar_gap))
                .pl(px(g.tabs_left))
                .children(
                    self.bars
                        .iter()
                        .enumerate()
                        .map(|(index, width)| self.bar(index, *width, g.tab, true)),
                )
        });
        let toolbar = (self.field == Some(Field::Toolbar)).then(|| {
            div()
                .flex_none()
                .h(px(g.toolbar))
                .flex()
                .items_center()
                .px(px(g.bar_gap))
                .gap(px(g.bar_gap))
                .border_b(px(1.))
                .border_color(look.field.unwrap_or(look.bar))
                .child(
                    div()
                        .w(px(g.nav.0))
                        .h(px(g.nav.1))
                        .rounded(px(g.nav.1 / 2.))
                        .bg(look.bar),
                )
                .child(self.field_box(g.toolbar_field).flex_1())
        });
        let page = match self.body {
            Some(body) => body,
            None => div()
                .relative()
                .flex_1()
                .min_w_0()
                .min_h_0()
                .flex()
                .flex_col()
                .rounded(px(CHROME_RADIUS * g.scale))
                .bg(look.page)
                .overflow_hidden()
                .when_some(look.edge, |this, edge| {
                    this.border(px(1.)).border_color(edge)
                })
                .children(toolbar)
                .when_some(self.overlay, |this, overlay| {
                    this.child(
                        div()
                            .absolute()
                            .size_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(overlay),
                    )
                })
                .into_any_element(),
        };
        let (left, right) = self.corners;
        let frame = div()
            .size_full()
            .p(px(g.pad))
            .gap(px(g.gap))
            .flex()
            .rounded_tl(px(left))
            .rounded_bl(px(left))
            .rounded_tr(px(right))
            .rounded_br(px(right))
            .bg(look.window);
        let frame = match (self.layout, self.right) {
            (Layout::Top, _) => frame.flex_col(),
            (_, true) => frame.flex_row_reverse(),
            _ => frame.flex_row(),
        };
        frame
            .children(side)
            .children(tabs)
            .child(page)
            .into_any_element()
    }
}

fn line(width: f32, color: Hsla) -> gpui::Div {
    div()
        .w(relative(width))
        .h(px(LINE))
        .rounded(px(LINE / 2.))
        .bg(color)
}

pub fn after_closing(p: &Palette, mode: &str, top: bool, right: bool) -> AnyElement {
    let accent = match mode {
        "tabAbove" => 1,
        "tabBelow" => 3,
        _ => 0,
    };
    let rows: &[f32] = if top { &TOP_TAB_ROWS } else { &TAB_ROWS };
    MiniWindow::new(
        if top { Layout::Top } else { Layout::Side },
        Look::settings(p),
        LARGE,
    )
    .right(right)
    .bars(rows)
    .accent(accent)
    .closed(2)
    .render()
}

pub fn switcher_order(p: &Palette, order: &str) -> AnyElement {
    let (faint, accent) = if order == "recent" { (2, 0) } else { (1, 2) };
    MiniWindow::new(Layout::Side, Look::settings(p), LARGE)
        .bars(&TAB_ROWS)
        .faint(faint)
        .accent(accent)
        .render()
}

pub fn switcher_view(p: &Palette, view: &str) -> AnyElement {
    let look = Look::settings(p);
    if view == "none" {
        return MiniWindow::new(Layout::Side, look, LARGE)
            .bars(&TAB_ROWS)
            .faint(1)
            .accent(2)
            .render();
    }
    let accent = p.form_accent;
    let lit_fill = accent.opacity(LIT_ALPHA);
    let corner = TILE_RADIUS * PREVIEW_SCALE;
    let overlay = if view == "thumbnails" {
        div()
            .w(relative(0.78))
            .flex()
            .gap(px(GAP))
            .p(px(GAP))
            .rounded(px(corner))
            .bg(look.window)
            .children(SWITCHER_CARDS.into_iter().map(move |focused| {
                div()
                    .flex_1()
                    .h(px(SWITCHER_CARD))
                    .rounded(px(corner * 0.75))
                    .border(px(LIT_BORDER))
                    .border_color(if focused {
                        accent
                    } else {
                        gpui::transparent_black()
                    })
                    .bg(if focused { lit_fill } else { look.bar })
            }))
            .into_any_element()
    } else {
        div()
            .w(relative(0.56))
            .flex()
            .flex_col()
            .gap(px(GAP / 2.))
            .p(px(GAP))
            .rounded(px(corner))
            .bg(look.window)
            .children(
                SWITCHER_ROWS
                    .into_iter()
                    .enumerate()
                    .map(move |(index, width)| {
                        let lit = index == SWITCHER_ROW_LIT;
                        div()
                            .h(px(SWITCHER_ROW))
                            .flex()
                            .items_center()
                            .px(px(GAP))
                            .rounded(px(corner * 0.5))
                            .border(px(LIT_BORDER / 1.5))
                            .border_color(if lit {
                                accent
                            } else {
                                gpui::transparent_black()
                            })
                            .when(lit, |this| this.bg(lit_fill))
                            .child(line(width, if lit { accent } else { look.bar }))
                    }),
            )
            .into_any_element()
    };
    MiniWindow::new(Layout::Side, look.plain(), LARGE)
        .bars(&TAB_ROWS)
        .overlay(overlay)
        .render()
}

fn field_of(address_bar: &str) -> Field {
    if address_bar == "sidebar" {
        Field::Side
    } else {
        Field::Toolbar
    }
}

pub fn address_bar(p: &Palette, address_bar: &str) -> AnyElement {
    MiniWindow::new(Layout::Side, Look::settings(p), LARGE)
        .bars(&SHORT_TAB_ROWS)
        .field(field_of(address_bar), true)
        .render()
}

pub fn command_bar(p: &Palette, placement: &str, address_bar: &str) -> AnyElement {
    let look = Look::settings(p);
    let field = field_of(address_bar);
    if placement == "field" {
        return MiniWindow::new(Layout::Side, look, LARGE)
            .bars(&SHORT_TAB_ROWS)
            .field(field, true)
            .render();
    }
    let overlay = div()
        .w(relative(0.7))
        .flex()
        .flex_col()
        .gap(px(GAP))
        .p(px(GAP))
        .rounded(px(TILE_RADIUS * PREVIEW_SCALE))
        .bg(look.window)
        .child(
            div()
                .h(px(COMMAND_FIELD))
                .rounded(px(COMMAND_FIELD / 2.))
                .border(px(LIT_BORDER / 1.5))
                .border_color(p.form_accent)
                .bg(look.page),
        )
        .children(
            RESULT_LINES
                .into_iter()
                .map(move |width| line(width, look.bar)),
        )
        .into_any_element();
    MiniWindow::new(Layout::Side, look, LARGE)
        .bars(&SHORT_TAB_ROWS)
        .field(field, false)
        .overlay(overlay)
        .render()
}

pub fn scroll_toolbar(p: &Palette, hides: bool) -> AnyElement {
    let look = Look::settings(p).plain();
    let text = div()
        .absolute()
        .size_full()
        .flex()
        .flex_col()
        .gap(px(GAP))
        .px(px(PAGE_PAD))
        .pt(px(if hides { STRIP_TOP } else { BELOW_TOOLBAR }))
        .when(hides, |this| {
            this.child(
                div()
                    .h(px(STRIP))
                    .mx(px(-PAGE_PAD + STRIP_INSET))
                    .mb(px(GAP))
                    .rounded(px(STRIP / 2.))
                    .bg(look.bar),
            )
        })
        .children(
            PAGE_LINES
                .into_iter()
                .map(move |width| line(width, look.bar)),
        )
        .when(hides, |this| {
            this.child(
                div()
                    .absolute()
                    .right(px(PAGE_PAD))
                    .bottom(px(PAGE_PAD))
                    .child(icon(Icon::ArrowDown, SCROLL_MARK, p.text_tertiary)),
            )
        })
        .into_any_element();
    let window = MiniWindow::new(Layout::Side, look, LARGE).bars(&SHORT_TAB_ROWS);
    let window = if hides {
        window
    } else {
        window.field(Field::Toolbar, true)
    };
    window.overlay(text).render()
}

pub fn tab_layout(p: &Palette, top: bool, right: bool) -> AnyElement {
    let rows: &[f32] = if top {
        &[1., 1., 1.]
    } else {
        &[1., 1., 1., 1.]
    };
    MiniWindow::new(
        if top { Layout::Top } else { Layout::Side },
        Look::settings(p),
        LARGE,
    )
    .right(right)
    .bars(rows)
    .accent(1)
    .render()
}

pub fn mode(dark: bool, corners: (f32, f32)) -> AnyElement {
    let (window, line, page): (Hsla, Hsla, Hsla) = if dark {
        (
            rgb(0x2B2226).into(),
            gpui::hsla(0., 0., 1., 0.2),
            rgb(0x1A1618).into(),
        )
    } else {
        (
            rgb(0xEDE6EA).into(),
            gpui::hsla(0., 0., 0., 0.12),
            rgb(0xFFFFFF).into(),
        )
    };
    MiniWindow::new(
        Layout::Side,
        Look {
            window,
            bar: line,
            page,
            field: None,
            accent: None,
            edge: None,
            closed: None,
        },
        MEDIUM,
    )
    .corners(corners.0, corners.1)
    .render()
}

pub fn style(look: &crate::look::Look, glass: bool) -> AnyElement {
    let p = &look.p;
    let (backdrop, tile, stroke): (Hsla, Hsla, Hsla) = if p.dark {
        (
            rgb(0x4A3A3E).into(),
            gpui::hsla(0., 0., 1., 0.1),
            gpui::hsla(0., 0., 1., 0.14),
        )
    } else {
        (
            rgb(0xE6CED2).into(),
            gpui::hsla(0., 0., 0., 0.05),
            gpui::hsla(0., 0., 0., 0.2),
        )
    };
    let tiles = div()
        .flex_1()
        .flex()
        .gap(px(8.))
        .p(px(4.))
        .children((0..3).map(move |index| {
            let tile_div = div()
                .relative()
                .flex_1()
                .h(px(30.))
                .rounded(px(TILE_RADIUS));
            if glass {
                let state = if index == 0 {
                    crate::primitives::glass::GlassState::Active
                } else {
                    crate::primitives::glass::GlassState::Rest
                };
                tile_div.child(crate::primitives::glass::control_glass_on_surface(
                    look,
                    TILE_RADIUS,
                    state,
                ))
            } else {
                tile_div.bg(tile).border(px(1.)).border_color(stroke)
            }
        }))
        .into_any_element();
    MiniWindow::new(
        Layout::Plain,
        Look {
            window: backdrop,
            bar: tile,
            page: tile,
            field: None,
            accent: None,
            edge: None,
            closed: None,
        },
        MEDIUM,
    )
    .body(tiles)
    .render()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_matches_the_old_tokens() {
        assert_eq!(LARGE.pad, 8.);
        assert_eq!(LARGE.bar, 7.);
        assert_eq!(LARGE.tabs_left, 24.);
        assert_eq!(SMALL.side, SideWidth::Points(36.));
        assert_eq!(MEDIUM.side, SideWidth::Share(0.26));
        assert_eq!(CHROME_RADIUS * LARGE.scale, 5.);
    }
}
