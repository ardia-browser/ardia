use std::rc::Rc;
use std::sync::Arc;

use ardia_theme::layout::panel;
use ardia_theme::tokens::{popover_width, radius, space};
use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, Hsla, Image, IntoElement, ParentElement,
    SharedString, Styled, Window, div, img, prelude::*, rgb,
};

use crate::icon_picker::symbols::{SymbolWeight, symbol};
use crate::primitives::appear::{OriginX, Rise, rise};
use crate::primitives::controls::{
    Checkbox, CloseButton, CloseLook, PillButton, glass_panel, tooltip,
};
use crate::primitives::glass::GlassState;
use crate::primitives::glass_states::{
    GLASS_CONTROL_GROUP, GlassBacking, GlassStates, stateful_glass,
};
use crate::primitives::shapes::IconTile;
use crate::primitives::tokens::{line_height, type_size};
use crate::scale::px;
use crate::window::chrome::Chrome;

pub type Click = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
pub type Change = Rc<dyn Fn(bool, &mut Window, &mut App)>;

pub const SITE_PANEL_WIDTH: f32 = 288.0;
pub const SITE_GAP: f32 = space::M;
pub const ACTION_HEIGHT: f32 = 40.0;
pub const CAPTION_HEIGHT: f32 = 44.0;
pub const EXTENSION_HEIGHT: f32 = 36.0;
pub const SECTION_TOP: f32 = space::XL;
pub const SECTION_GAP: f32 = space::M;
pub const SETTING_HEIGHT: f32 = 42.0;
pub const SETTING_BADGE: f32 = 26.0;
pub const FOOTER_CONTROL: f32 = 26.0;
pub const PERMISSION_WIDTH: f32 = popover_width::S;
pub const EXTERNAL_APP_WIDTH: f32 = popover_width::M;
pub const BLOCKED_POPUPS_WIDTH: f32 = popover_width::L;
pub const DEVICE_CHOOSER_WIDTH: f32 = popover_width::M;
pub const ENGINE_OFFER_WIDTH: f32 = popover_width::S;
pub const HIDDEN_ELEMENTS_WIDTH: f32 = popover_width::L;
pub const ZOOM_WIDTH: f32 = 236.0;
pub const UNAVAILABLE_OPACITY: f32 = 0.4;
pub const PANEL_CLOSE_SIZE: f32 = 22.0;
pub const PANEL_CLOSE_GLYPH: f32 = 7.0;
pub const PANEL_CLOSE_OFFSET: f32 = panel::INSET - (PANEL_CLOSE_SIZE - PANEL_CLOSE_GLYPH) / 2.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SiteTokens {
    pub tile: Hsla,
    pub tile_hover: Hsla,
    pub tile_pressed: Hsla,
    pub tile_stroke: Hsla,
    pub icon_tile: Hsla,
    pub well: Hsla,
    pub certificate_well: Hsla,
}

pub fn site_tokens(dark: bool) -> SiteTokens {
    let ink = if dark { 1.0 } else { 0.0 };
    let shade = |alpha: f32| gpui::hsla(0.0, 0.0, ink, alpha);
    if dark {
        SiteTokens {
            tile: shade(0.07),
            tile_hover: shade(0.11),
            tile_pressed: shade(0.16),
            tile_stroke: shade(0.08),
            icon_tile: shade(0.1),
            well: shade(0.06),
            certificate_well: shade(0.05),
        }
    } else {
        SiteTokens {
            tile: shade(0.0525),
            tile_hover: shade(0.0825),
            tile_pressed: shade(0.12),
            tile_stroke: shade(0.06),
            icon_tile: shade(0.06),
            well: shade(0.04),
            certificate_well: shade(0.04),
        }
    }
}

pub fn caution() -> Hsla {
    rgb(0xF2B33D).into()
}

pub struct CardBadge {
    pub label: &'static str,
    pub fill: u32,
}

pub fn card_badge(network: &str) -> CardBadge {
    let (label, fill) = match network {
        "visa" => ("VISA", 0x1A1F71),
        "mastercard" => ("", 0x1C1C1E),
        "amex" => ("AMEX", 0x2E77BC),
        "discover" => ("DISC", 0xFF6000),
        "diners" => ("DC", 0x0079BE),
        "jcb" => ("JCB", 0x0B7A3E),
        "unionpay" => ("UP", 0xD7282F),
        _ => ("", 0x8E8E93),
    };
    CardBadge { label, fill }
}

pub fn network_badge(host: &dyn crate::host::UiHost, network: &str) -> AnyElement {
    let badge = card_badge(network);
    let ring = 10.0;
    let white = gpui::white();
    let frame = div()
        .w(px(28.))
        .h(px(19.))
        .rounded(px(radius::CONTROL))
        .bg(rgb(badge.fill))
        .flex()
        .flex_row()
        .items_center()
        .justify_center();
    if network == "mastercard" {
        return frame
            .child(
                div()
                    .size(px(ring))
                    .rounded_full()
                    .bg(rgb(0xEB001B))
                    .mr(px(-space::XS)),
            )
            .child(
                div()
                    .size(px(ring))
                    .rounded_full()
                    .bg(rgb(0xF79E1B))
                    .opacity(0.9),
            )
            .into_any_element();
    }
    if !badge.label.is_empty() {
        return frame
            .child(
                div()
                    .text_size(px(type_size::BADGE))
                    .line_height(px(line_height::BADGE))
                    .font_weight(FontWeight::EXTRA_BOLD)
                    .when(network == "visa", |this| this.italic())
                    .text_color(white)
                    .child(badge.label),
            )
            .into_any_element();
    }
    frame
        .child(symbol(
            host,
            "creditcard.fill",
            10.,
            14.,
            SymbolWeight::Regular,
            white,
        ))
        .into_any_element()
}

pub fn sym(c: &Chrome, name: &str, size: f32, frame: f32, color: Hsla) -> AnyElement {
    symbol(
        c.host.as_ref(),
        name,
        size,
        frame,
        SymbolWeight::Regular,
        color,
    )
}

pub fn sym_weight(
    c: &Chrome,
    name: &str,
    size: f32,
    frame: f32,
    weight: SymbolWeight,
    color: Hsla,
) -> AnyElement {
    symbol(c.host.as_ref(), name, size, frame, weight, color)
}

pub fn appear(id: impl Into<ElementId>, element: impl IntoElement, upward: bool) -> AnyElement {
    appear_from(id, element, OriginX::Left, upward)
}

pub fn appear_from(
    id: impl Into<ElementId>,
    element: impl IntoElement,
    origin: OriginX,
    upward: bool,
) -> AnyElement {
    rise(id, element, Rise::popover(origin, upward))
}

pub fn prompt_icon(c: &Chrome, name: &str) -> AnyElement {
    let p = c.p;
    IconTile::holding(sym(c, name, 13., 28., p.icon), p)
        .fill(site_tokens(p.dark).icon_tile)
        .into_any_element()
}

pub struct PromptBody {
    pub icons: Vec<&'static str>,
    pub image: Option<Arc<Image>>,
    pub title: SharedString,
    pub message: Option<SharedString>,
    pub detail: Vec<AnyElement>,
    pub buttons: Vec<AnyElement>,
}

pub fn prompt_body(c: &Chrome, body: PromptBody) -> AnyElement {
    let p = c.p;
    div()
        .p(px(panel::INSET))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(space::ML))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .gap(px(space::S))
                        .when_some(body.image, |this, image| {
                            this.child(img(image).size(px(32.)))
                        })
                        .children(body.icons.iter().map(|name| prompt_icon(c, name))),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(space::XS))
                        .child(
                            div()
                                .text_size(px(type_size::BODY))
                                .line_height(px(line_height::BODY))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(p.text)
                                .child(body.title),
                        )
                        .when_some(body.message, |this, message| {
                            this.child(
                                div()
                                    .text_size(px(type_size::SMALL))
                                    .line_height(px(line_height::SMALL))
                                    .text_color(p.text_secondary)
                                    .child(message),
                            )
                        }),
                )
                .children(body.detail),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(space::M))
                .mt(px(space::XL))
                .child(div().flex_1())
                .children(body.buttons),
        )
        .into_any_element()
}

pub fn pill(
    c: &Chrome,
    id: impl Into<SharedString>,
    title: impl Into<SharedString>,
    primary: bool,
    on_click: Click,
) -> AnyElement {
    let id: SharedString = id.into();
    let selector = id.to_string();
    div()
        .debug_selector(move || selector)
        .child(
            PillButton::new(ElementId::Name(id), title, c.p)
                .primary(primary)
                .on_click(move |event, window, cx| on_click(event, window, cx)),
        )
        .into_any_element()
}

pub fn prompt_popover(
    c: &Chrome,
    id: impl Into<ElementId>,
    width: f32,
    body: AnyElement,
    close: Option<Click>,
) -> gpui::Stateful<gpui::Div> {
    let p = c.p;
    glass_panel(id, false, panel::RADIUS, p)
        .w(px(width))
        .relative()
        .text_color(p.text)
        .child(body)
        .when_some(close, |this, close| {
            this.child(
                div()
                    .absolute()
                    .top(px(PANEL_CLOSE_OFFSET))
                    .right(px(PANEL_CLOSE_OFFSET))
                    .child(
                        CloseButton::new("prompt-dismiss", CloseLook::Panel, p)
                            .on_click(move |event, window, cx| close(event, window, cx)),
                    ),
            )
        })
}

pub fn well(
    c: &Chrome,
    list: bool,
    gap: f32,
    fill: Option<Hsla>,
    children: Vec<AnyElement>,
) -> AnyElement {
    div()
        .rounded(px(radius::TILE))
        .when(!list, |this| this.px(px(space::ML)))
        .py(px(if list { space::XS } else { space::M }))
        .flex()
        .flex_col()
        .gap(px(gap))
        .bg(fill.unwrap_or(site_tokens(c.p.dark).well))
        .children(children)
        .into_any_element()
}

pub fn check_row(
    c: &Chrome,
    id: impl Into<SharedString>,
    value: bool,
    label: impl Into<SharedString>,
    on_change: Change,
) -> AnyElement {
    let p = c.p;
    let id: SharedString = id.into();
    let toggle = on_change.clone();
    div()
        .id(ElementId::Name(id.clone()))
        .debug_selector(move || id.to_string())
        .flex()
        .flex_row()
        .items_start()
        .gap(px(space::M))
        .cursor_pointer()
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            toggle(!value, window, cx)
        })
        .child(
            Checkbox::new("check-row-box", value, "", p)
                .on_toggle(move |next, window, cx| on_change(next, window, cx)),
        )
        .child(
            div()
                .flex_1()
                .text_size(px(type_size::SMALL))
                .line_height(px(line_height::BODY))
                .text_color(p.text)
                .child(label.into()),
        )
        .into_any_element()
}

pub struct PanelRow {
    pub id: SharedString,
    pub icon: Option<&'static str>,
    pub leading: Option<AnyElement>,
    pub icon_color: Option<Hsla>,
    pub title: SharedString,
    pub detail: Option<SharedString>,
    pub accessory: Vec<AnyElement>,
    pub on_click: Option<Click>,
    pub disabled: bool,
    pub destructive: bool,
    pub selected: bool,
    pub tooltip: Option<SharedString>,
    pub double_click: Option<Click>,
    pub glass_backing: GlassBacking,
}

impl PanelRow {
    pub fn new(id: impl Into<SharedString>, title: impl Into<SharedString>) -> Self {
        PanelRow {
            id: id.into(),
            icon: None,
            leading: None,
            icon_color: None,
            title: title.into(),
            detail: None,
            accessory: Vec::new(),
            on_click: None,
            disabled: false,
            destructive: false,
            selected: false,
            tooltip: None,
            double_click: None,
            glass_backing: GlassBacking::Native,
        }
    }

    pub fn on_surface(mut self) -> Self {
        self.glass_backing = GlassBacking::Surface;
        self
    }

    pub fn icon(mut self, icon: &'static str) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn icon_color(mut self, color: Hsla) -> Self {
        self.icon_color = Some(color);
        self
    }

    pub fn leading(mut self, leading: AnyElement) -> Self {
        self.leading = Some(leading);
        self
    }

    pub fn detail(mut self, detail: Option<impl Into<SharedString>>) -> Self {
        self.detail = detail.map(Into::into);
        self
    }

    pub fn accessory(mut self, accessory: AnyElement) -> Self {
        self.accessory.push(accessory);
        self
    }

    pub fn on_click(mut self, click: Click) -> Self {
        self.on_click = Some(click);
        self
    }

    pub fn on_double_click(mut self, click: Click) -> Self {
        self.double_click = Some(click);
        self
    }

    pub fn destructive(mut self, destructive: bool) -> Self {
        self.destructive = destructive;
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub fn tooltip(mut self, tip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tip.into());
        self
    }

    pub fn render(self, c: &Chrome) -> AnyElement {
        let p = *c.p;
        let tint = if self.destructive {
            p.destructive
        } else {
            p.text
        };
        let pressable = self.on_click.is_some() && !self.disabled;
        let selector = self.id.to_string();
        let leading = match (self.leading, self.icon) {
            (Some(leading), _) => Some(
                div()
                    .flex_none()
                    .size(px(panel::ICON_SLOT))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(leading)
                    .into_any_element(),
            ),
            (None, Some(icon)) => Some(sym(
                c,
                icon,
                panel::ICON_SIZE,
                panel::ICON_SLOT,
                self.icon_color
                    .unwrap_or(if self.destructive { tint } else { p.icon }),
            )),
            (None, None) => None,
        };
        let double = self.double_click;
        let click = self.on_click.filter(|_| pressable);
        div()
            .id(ElementId::Name(self.id))
            .debug_selector(move || selector)
            .min_h(px(panel::ROW_HEIGHT))
            .mx(px(panel::ROW_INSET))
            .px(px(panel::ROW_PADDING))
            .rounded(px(panel::ROW_RADIUS))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(panel::ICON_GAP))
            .when(self.disabled, |this| this.opacity(UNAVAILABLE_OPACITY))
            .when(self.selected, |this| this.bg(p.row_selected))
            .when(pressable && c.look.glass, |this| {
                this.cursor_pointer()
                    .relative()
                    .group(GLASS_CONTROL_GROUP)
                    .hover(|s| s.bg(gpui::transparent_black()))
                    .child(stateful_glass(
                        c.look,
                        panel::ROW_RADIUS,
                        GlassStates::ROW,
                        self.glass_backing,
                    ))
            })
            .when(pressable && !c.look.glass, |this| {
                this.cursor_pointer()
                    .hover(move |s| s.bg(p.row_hover))
                    .active(move |s| s.bg(p.popover_row_pressed))
            })
            .when_some(self.tooltip, |this, tip| this.tooltip(tooltip(tip, &p)))
            .when_some(click, |this, click| {
                this.on_click(move |event, window, cx| {
                    cx.stop_propagation();
                    if event.click_count() >= 2
                        && let Some(double) = double.as_ref()
                    {
                        double(event, window, cx);
                        return;
                    }
                    click(event, window, cx)
                })
            })
            .children(leading)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .py(px(space::S))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .truncate()
                            .text_size(px(type_size::BODY))
                            .text_color(tint)
                            .child(self.title),
                    )
                    .when_some(self.detail, |this, detail| {
                        this.child(
                            div()
                                .line_clamp(2)
                                .text_size(px(type_size::CAPTION))
                                .text_color(p.text_secondary)
                                .child(detail),
                        )
                    }),
            )
            .children(self.accessory)
            .into_any_element()
    }
}

pub fn panel_separator(c: &Chrome) -> AnyElement {
    div()
        .mx(px(space::XL))
        .my(px(panel::SEPARATOR_GAP))
        .h(px(0.5))
        .bg(c.p.divider)
        .into_any_element()
}

pub fn section_label(
    c: &Chrome,
    title: &'static str,
    top: f32,
    bottom: f32,
    accessory: Option<AnyElement>,
) -> AnyElement {
    let p = c.p;
    let label = div()
        .truncate()
        .text_size(px(type_size::CAPTION))
        .line_height(px(line_height::CAPTION))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(p.text_secondary)
        .child(title);
    div()
        .px(px(panel::INSET))
        .pt(px(top))
        .pb(px(bottom))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::S))
        .child(label.flex_1())
        .children(accessory)
        .into_any_element()
}

pub fn panel_header(
    c: &Chrome,
    icon: AnyElement,
    title: impl Into<SharedString>,
    subtitle: Option<SharedString>,
) -> AnyElement {
    let p = c.p;
    let text_height = line_height::BODY
        + if subtitle.is_some() {
            line_height::CAPTION
        } else {
            0.0
        };
    let overhang = ((text_height - panel::ICON_SLOT) / 2.0).max(0.0);
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(panel::ICON_GAP))
        .px(px(panel::INSET))
        .pt(px(panel::INSET - overhang))
        .pb(px(panel::HEADER_GAP))
        .child(
            div()
                .flex_none()
                .size(px(panel::ICON_SLOT))
                .flex()
                .items_center()
                .justify_center()
                .child(icon),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .truncate()
                        .text_size(px(type_size::BODY))
                        .line_height(px(line_height::BODY))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.text)
                        .child(title.into()),
                )
                .when_some(subtitle, |this, subtitle| {
                    this.child(
                        div()
                            .truncate()
                            .text_size(px(type_size::CAPTION))
                            .line_height(px(line_height::CAPTION))
                            .text_color(p.text_secondary)
                            .child(subtitle),
                    )
                }),
        )
        .into_any_element()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileShape {
    Tile,
    Capsule,
}

fn tile_fill(t: SiteTokens, open: bool, quiet: bool) -> Option<Hsla> {
    match (open, quiet) {
        (true, _) => Some(t.tile_pressed),
        (false, true) => None,
        (false, false) => Some(t.tile),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileSpec {
    pub shape: TileShape,
    pub height: f32,
    pub open: bool,
    pub quiet: bool,
    pub stroke: bool,
}

impl TileSpec {
    pub fn tile(height: f32) -> Self {
        TileSpec {
            shape: TileShape::Tile,
            height,
            open: false,
            quiet: false,
            stroke: false,
        }
    }
}

pub fn tile(
    c: &Chrome,
    id: impl Into<SharedString>,
    spec: TileSpec,
    on_click: Option<Click>,
) -> gpui::Stateful<gpui::Div> {
    let TileSpec {
        shape,
        height,
        open,
        quiet,
        stroke,
    } = spec;
    let p = *c.p;
    let t = site_tokens(p.dark);
    let id: SharedString = id.into();
    let selector = id.to_string();
    let corner = match shape {
        TileShape::Tile => radius::TILE,
        TileShape::Capsule => height / 2.0,
    };
    let hover = if quiet { p.row_hover } else { t.tile_hover };
    let pressed = if quiet {
        p.popover_row_pressed
    } else {
        t.tile_pressed
    };
    let glass = c.look.glass;
    let glass_states = tile_glass_states(open, quiet, on_click.is_some());
    div()
        .id(ElementId::Name(id))
        .debug_selector(move || selector)
        .h(px(height))
        .rounded(px(corner))
        .when(glass, |this| {
            this.relative()
                .group(GLASS_CONTROL_GROUP)
                .when_some(glass_states, |this, states| {
                    this.child(stateful_glass(c.look, corner, states, GlassBacking::Native))
                })
        })
        .when(!glass, |this| {
            this.when_some(tile_fill(t, open, quiet), |this, fill| this.bg(fill))
                .when(stroke, |this| {
                    this.border(px(0.5)).border_color(t.tile_stroke)
                })
        })
        .when_some(on_click, |this, click| {
            this.cursor_pointer()
                .when(!glass, |this| {
                    this.hover(move |s| s.bg(hover))
                        .active(move |s| s.bg(pressed))
                })
                .on_click(move |event, window, cx| {
                    cx.stop_propagation();
                    click(event, window, cx)
                })
        })
}

pub fn tile_glass_states(open: bool, quiet: bool, pressable: bool) -> Option<GlassStates> {
    match (open, quiet, pressable) {
        (true, _, _) => Some(GlassStates::held(GlassState::Pressed)),
        (false, false, true) => Some(GlassStates::TILE),
        (false, false, false) => Some(GlassStates::held(GlassState::Rest)),
        (false, true, true) => Some(GlassStates::ROW),
        (false, true, false) => None,
    }
}

pub fn action_tile(
    c: &Chrome,
    id: &'static str,
    icon: &'static str,
    label: &'static str,
    active: bool,
    on_click: Click,
) -> AnyElement {
    let p = *c.p;
    div()
        .flex_1()
        .child(
            tile(
                c,
                id,
                TileSpec {
                    stroke: true,
                    ..TileSpec::tile(ACTION_HEIGHT)
                },
                Some(on_click),
            )
            .flex()
            .items_center()
            .justify_center()
            .tooltip(tooltip(label.into(), &p))
            .child(sym(
                c,
                icon,
                15.,
                22.,
                if active { p.accent } else { p.icon },
            )),
        )
        .into_any_element()
}

pub struct ExtensionCell {
    pub id: SharedString,
    pub name: SharedString,
    pub icon: Option<Arc<Image>>,
    pub symbol: &'static str,
    pub dimmed: bool,
    pub menu: Option<crate::msg::MenuTarget>,
}

pub fn extension_tile(c: &Chrome, cell: ExtensionCell, on_click: Click) -> AnyElement {
    let ExtensionCell {
        id,
        name,
        icon,
        symbol: symbol_name,
        dimmed,
        menu: on_context,
    } = cell;
    let p = *c.p;
    let emit = c.emit.clone();
    let body = tile(c, id, TileSpec::tile(EXTENSION_HEIGHT), Some(on_click))
        .flex()
        .items_center()
        .justify_center()
        .tooltip(tooltip(name, &p))
        .map(|this| match icon {
            Some(image) => this.child(
                img(image)
                    .size(px(18.))
                    .when(dimmed, |i| i.opacity(UNAVAILABLE_OPACITY)),
            ),
            None => this.child(sym(c, symbol_name, 14., 20., p.icon)),
        })
        .when_some(on_context, |this, target| {
            let emit = emit.clone();
            this.on_mouse_down(gpui::MouseButton::Right, move |event, window, cx| {
                cx.stop_propagation();
                emit.send(
                    crate::msg::Msg::Menu(Some((target.clone(), event.position))),
                    window,
                    cx,
                );
            })
        });
    div().flex_1().child(body).into_any_element()
}

pub fn grid_columns(action_count: usize) -> usize {
    if action_count == 3 { 3 } else { 4 }
}

pub fn tile_row(children: Vec<AnyElement>) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .gap(px(SITE_GAP))
        .px(px(panel::INSET))
        .children(children)
        .into_any_element()
}

pub fn tile_grid(columns: usize, cells: Vec<AnyElement>) -> AnyElement {
    let columns = columns.max(1);
    let mut rows: Vec<AnyElement> = Vec::new();
    let mut cells = cells.into_iter().peekable();
    while cells.peek().is_some() {
        let row: Vec<AnyElement> = cells.by_ref().take(columns).collect();
        let spacers = columns - row.len();
        rows.push(
            div()
                .flex()
                .flex_row()
                .gap(px(SITE_GAP))
                .children(row)
                .children((0..spacers).map(|_| div().flex_1()))
                .into_any_element(),
        );
    }
    div()
        .flex()
        .flex_col()
        .gap(px(SITE_GAP))
        .px(px(panel::INSET))
        .children(rows)
        .into_any_element()
}

pub fn setting_row(
    c: &Chrome,
    id: impl Into<SharedString>,
    icon: &'static str,
    title: impl Into<SharedString>,
    value: impl Into<SharedString>,
    on: bool,
    on_click: Option<Click>,
) -> AnyElement {
    let p = *c.p;
    let t = site_tokens(p.dark);
    let id: SharedString = id.into();
    let selector = id.to_string();
    let pressable = on_click.is_some();
    div()
        .id(ElementId::Name(id))
        .debug_selector(move || selector)
        .h(px(SETTING_HEIGHT))
        .mx(px(panel::ROW_INSET))
        .px(px(panel::ROW_PADDING))
        .rounded(px(panel::ROW_RADIUS))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(panel::ICON_GAP))
        .when_some(on_click, |this, click| {
            this.cursor_pointer()
                .map(|this| {
                    if c.look.glass {
                        this.relative()
                            .group(GLASS_CONTROL_GROUP)
                            .child(stateful_glass(
                                c.look,
                                panel::ROW_RADIUS,
                                GlassStates::ROW,
                                GlassBacking::Native,
                            ))
                    } else {
                        this.hover(move |s| s.bg(p.row_hover))
                            .active(move |s| s.bg(p.popover_row_pressed))
                    }
                })
                .on_click(move |event, window, cx| {
                    cx.stop_propagation();
                    click(event, window, cx)
                })
        })
        .child(
            div()
                .flex_none()
                .size(px(SETTING_BADGE))
                .rounded_full()
                .bg(if on { p.accent } else { t.tile_hover })
                .flex()
                .items_center()
                .justify_center()
                .child(sym_weight(
                    c,
                    icon,
                    12.,
                    18.,
                    SymbolWeight::Medium,
                    if on { p.on_accent } else { p.icon },
                )),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .truncate()
                        .text_size(px(type_size::BODY))
                        .line_height(px(line_height::BODY))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(p.text)
                        .child(title.into()),
                )
                .child(
                    div()
                        .truncate()
                        .text_size(px(type_size::CAPTION))
                        .line_height(px(line_height::CAPTION))
                        .text_color(p.text_secondary)
                        .child(value.into()),
                ),
        )
        .map(|this| {
            if pressable {
                this
            } else {
                this.cursor_default()
            }
        })
        .into_any_element()
}

pub struct Chip {
    pub id: &'static str,
    pub icon: &'static str,
    pub title: SharedString,
    pub color: Option<Hsla>,
    pub open: bool,
    pub quiet: bool,
    pub tooltip: Option<SharedString>,
}

pub fn chip_button(c: &Chrome, chip: Chip, on_click: Option<Click>) -> AnyElement {
    let p = *c.p;
    let quiet = chip.quiet;
    let tip = chip.tooltip.clone();
    tile(
        c,
        chip.id,
        TileSpec {
            open: chip.open,
            quiet,
            ..TileSpec::tile(FOOTER_CONTROL)
        },
        on_click,
    )
    .px(px(space::M))
    .flex()
    .flex_row()
    .items_center()
    .gap(px(space::XS))
    .when_some(tip, |this, tip| this.tooltip(tooltip(tip, &p)))
    .child(sym_weight(
        c,
        chip.icon,
        if quiet { 12. } else { 11. },
        if quiet { 16. } else { 14. },
        SymbolWeight::Medium,
        chip.color.unwrap_or(p.icon),
    ))
    .child(
        div()
            .truncate()
            .text_size(px(if quiet {
                type_size::BODY
            } else {
                type_size::SMALL
            }))
            .font_weight(FontWeight::MEDIUM)
            .text_color(chip.color.unwrap_or(p.text))
            .child(chip.title),
    )
    .into_any_element()
}

pub fn more_button(c: &Chrome, open: bool, on_click: Click) -> AnyElement {
    let p = *c.p;
    let label = if open {
        "Fewer Site Controls"
    } else {
        "More Site Controls"
    };
    tile(
        c,
        "site-more",
        TileSpec {
            shape: TileShape::Capsule,
            open,
            ..TileSpec::tile(FOOTER_CONTROL)
        },
        Some(on_click),
    )
    .w(px(FOOTER_CONTROL))
    .flex()
    .items_center()
    .justify_center()
    .tooltip(tooltip(label.into(), &p))
    .child(sym_weight(
        c,
        "ellipsis",
        12.,
        18.,
        SymbolWeight::Semibold,
        p.icon,
    ))
    .into_any_element()
}

pub fn click(f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Click {
    Rc::new(f)
}

pub fn emit_click(c: &Chrome, msgs: Vec<crate::msg::Msg>) -> Click {
    let emit = c.emit.clone();
    Rc::new(move |_, window, cx| {
        for msg in msgs.iter().cloned() {
            emit.send(msg, window, cx);
        }
    })
}
