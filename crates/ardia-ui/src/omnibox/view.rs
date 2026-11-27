use std::time::Duration;

use crate::scale::px;
use ardia_state::model::EffectiveLayout;
use ardia_state::omnibox::site_search::SearchScope;
use ardia_state::omnibox::suggest::Suggestion;
use ardia_state::tabs::SecurityState;
use ardia_state::windows::WindowKind;
use ardia_theme::layout::{sidebar, toolbar};
use ardia_theme::{FieldSurface, RgbaColor};
use gpui::{
    Animation, AnimationExt, AnyElement, FontWeight, Hsla, IntoElement, KeyDownEvent, MouseButton,
    ParentElement, SharedString, Styled, div, prelude::*,
};

use crate::look::Look;
use crate::msg::Msg;
use crate::omnibox::frame::{
    Frame, UrlAnchor, Variant, centred_frame, dropdown_frame, field_frame,
};
use crate::omnibox::labels::{destination_label, removable_url, row_hint, suggestion_labels};
use crate::omnibox::pulse::{
    FILL_DARK, FILL_LIGHT, REST, RING_DARK, RING_LIGHT, RING_WIDTH, RISE_MS, SETTLE_MS,
    brand_color_for, pulse_ink,
};
use crate::omnibox::{CommandPanel, PanelKey, PanelMsg, other_open_tabs};
use crate::popovers::context_menu::{MenuEntry, MenuItem, entries_menu, sections};
use crate::primitives::controls::{IconButton, shadow, tooltip};
use crate::primitives::favicon::{favicon_of, render_favicon};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::{AcceptCompletion, Backspace, InputStyle};
use crate::primitives::theme_bridge::hsla;
use crate::window::chrome::Chrome;
use crate::window::layout::{ARC_FIELD_GAP, ARC_FIELD_ROW, Rect};

pub const ICON_SLOT: f32 = 18.0;
pub const LEADING_ICON: f32 = 18.0;
pub const PANEL_ROW: f32 = 55.0;
pub const HERO_ROW: f32 = 60.0;
pub const PANEL_ICON_LEFT: f32 = 21.0;
pub const HERO_ICON_LEFT: f32 = 18.0;
pub const FIELD_RIGHT: f32 = 18.0;
pub const PANEL_GAP: f32 = 6.5;
pub const HERO_GAP: f32 = 8.0;
pub const DROPDOWN_ROW: f32 = 44.0;
pub const DROPDOWN_LEFT: f32 = 13.0;
pub const DROPDOWN_RIGHT: f32 = 9.0;
pub const DROPDOWN_GAP: f32 = 9.0;
pub const SITE_CONTROLS_GLYPH: f32 = 15.0;
pub const SITE_CONTROLS_BOX: f32 = 26.0;
pub const BOTTOM_LEFT: f32 = 14.0;
pub const BOTTOM_HERO_LEFT: f32 = 13.0;
pub const BOTTOM_RIGHT: f32 = 13.0;
pub const BOTTOM_HERO_RIGHT: f32 = 15.0;
pub const BOTTOM_HEIGHT: f32 = 52.0;
pub const BOTTOM_HERO_HEIGHT: f32 = 43.0;
pub const BOTTOM_HERO_BELOW: f32 = 8.0;
pub const MIC_GLYPH: f32 = 14.0;
pub const MIC_BOX: f32 = 30.0;
pub const MIC_RADIUS: f32 = 7.0;
pub const CHIP_HEIGHT: f32 = 32.0;
pub const CHIP_LEFT: f32 = 9.0;
pub const CHIP_RIGHT: f32 = 12.0;
pub const CHIP_GAP: f32 = 5.0;
pub const CHIP_GLYPH: f32 = 10.0;
pub const CHIP_GLYPH_BOX: f32 = 14.0;
pub const GO_BEFORE: f32 = 8.0;
pub const GO_MIN_WIDTH: f32 = 99.0;
pub const GO_HEIGHT: f32 = 32.0;
pub const GO_PAD_X: f32 = 16.0;
pub const GO_GAP: f32 = 6.0;
pub const GO_GLYPH: f32 = 11.0;
pub const GO_GLYPH_BOX: f32 = 14.0;
pub const GO_GLYPH_ALPHA: f32 = 0x99 as f32 / 255.0;
pub const GO_HOVER_OPACITY: f32 = 0.9;
pub const GO_PRESSED_OPACITY: f32 = 0.78;
pub const LIST_X: f32 = 8.0;
pub const DROPDOWN_LIST_X: f32 = 6.0;
pub const LIST_BELOW: f32 = 2.0;
pub const DROPDOWN_LIST_BELOW: f32 = 6.0;
pub const ROW_HEIGHT: f32 = 36.0;
pub const ROW_GAP_Y: f32 = 2.0;
pub const ROW_RADIUS: f32 = 8.0;
pub const ROW_PAD_X: f32 = 13.0;
pub const ROW_GAP: f32 = 11.0;
pub const ROW_ICON: f32 = 13.0;
pub const ROW_CALC_ICON: f32 = 14.0;
pub const ROW_ICON_BOX: f32 = 16.0;
pub const REMOVE_BOX: f32 = 22.0;
pub const REMOVE_GLYPH: f32 = 10.0;
pub const REMOVE_RADIUS: f32 = 6.0;
pub const SELECTED_ALPHA_DARK: f32 = 0.56;
pub const SELECTED_ALPHA_LIGHT: f32 = 0.3;
pub const SCOPE_HEIGHT: f32 = 26.0;
pub const SCOPE_HERO_HEIGHT: f32 = 28.0;
pub const SCOPE_RADIUS: f32 = 8.0;
pub const SCOPE_LEFT: f32 = 7.0;
pub const SCOPE_RIGHT: f32 = 9.0;
pub const SCOPE_GAP: f32 = 6.0;
pub const SCOPE_FAVICON: f32 = 14.0;
pub const SCOPE_MAX_WIDTH: f32 = 220.0;
pub const HERO_RADIUS: f32 = 20.0;
pub const DROPDOWN_RADIUS: f32 = 12.0;
pub const HAIRLINE: f32 = 0.5;
pub const HERO_INSET: f32 = 0.5;
pub const DIALOG_SHADOW_Y: f32 = 10.0;
pub const DIALOG_SHADOW_BLUR: f32 = 24.0;
pub const FONT_PANEL: f32 = 13.0;
pub const HERO_FIELD_LIFT: f32 = -1.0;
pub const FIELD_LIFT: f32 = -0.5;
pub const FONT_TITLE: f32 = 15.0;
pub const FONT_HERO: f32 = 17.0;
pub const FONT_SMALL: f32 = 12.0;
pub const GLASS_REST_FILL: f32 = 0.076;
pub const GLASS_RIM: f32 = 0.13;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlassState {
    Rest,
    Lit,
    Pressed,
    Active,
}

impl GlassState {
    fn gain(self) -> f32 {
        match self {
            GlassState::Rest => 1.0,
            GlassState::Lit => 2.0,
            GlassState::Pressed => 3.0,
            GlassState::Active => 6.0,
        }
    }
}

pub fn glass_tint(resting: RgbaColor, state: GlassState) -> RgbaColor {
    RgbaColor::new(
        resting.r,
        resting.g,
        resting.b,
        (GLASS_REST_FILL * state.gain()).min(1.0),
    )
}

fn glass_fill(c: &Chrome, radius: f32, state: GlassState) -> AnyElement {
    let shared = match state {
        GlassState::Rest => crate::primitives::glass::GlassState::Rest,
        GlassState::Lit => crate::primitives::glass::GlassState::Lit,
        GlassState::Pressed => crate::primitives::glass::GlassState::Pressed,
        GlassState::Active => crate::primitives::glass::GlassState::Active,
    };
    crate::primitives::glass::control_glass_on_surface(c.look, radius, shared).into_any_element()
}

pub fn field_font(variant: Variant) -> f32 {
    match variant {
        Variant::Hero => FONT_HERO,
        Variant::Floating | Variant::Dropdown => FONT_TITLE,
        Variant::Panel => FONT_PANEL,
    }
}

pub fn field_lift(variant: Variant) -> f32 {
    if variant.hero() {
        HERO_FIELD_LIFT
    } else {
        FIELD_LIFT
    }
}

pub fn field_style(look: &Look, variant: Variant) -> InputStyle {
    InputStyle {
        text: look.p.text,
        placeholder: look.p.placeholder,
        caret: hsla(look.theme.caret_color(FieldSurface::NtpBarSolid)),
        selection: look.p.selection,
        font_size: field_font(variant),
        weight: FontWeight::NORMAL,
    }
}

pub fn field_row_height(variant: Variant, compact: bool) -> f32 {
    match variant {
        Variant::Hero => HERO_ROW,
        Variant::Dropdown => DROPDOWN_ROW,
        Variant::Floating => PANEL_ROW,
        Variant::Panel => PANEL_ROW - 2.0 * toolbar::compact_lift(toolbar::row(compact)),
    }
}

fn role(c: &Chrome, pick: impl Fn(&ardia_theme::ColorRoles) -> RgbaColor) -> Hsla {
    hsla(pick(&c.look.theme.roles))
}

fn selected_fill(c: &Chrome) -> Hsla {
    match c.look.theme.power_up_color {
        Some(color) => hsla(color).opacity(if c.look.dark {
            SELECTED_ALPHA_DARK
        } else {
            SELECTED_ALPHA_LIGHT
        }),
        None => role(c, |r| r.command_bar_selected),
    }
}

fn incognito(c: &Chrome) -> bool {
    c.window.kind == WindowKind::Incognito
}

pub fn url_anchor(c: &Chrome) -> UrlAnchor {
    let card = c.layout.card;
    let row = toolbar::row(c.state.settings.compact_toolbar);
    let sidebar_toggle =
        c.layout.layout != EffectiveLayout::TopStrip && c.window.kind.shows_sidebar();
    let active = c.active.map(|t| &t.id);
    let feed =
        crate::content::toolbar_extensions::feed_from_host(c.host.as_ref(), &c.window.id, active);
    let casting = active.is_some_and(|tab| feed.casting.contains(tab));
    let plan = crate::content::toolbar::plan(
        row,
        card.w,
        c.layout.frame.radius,
        sidebar_toggle,
        casting,
        feed.actions_of(&c.window.profile_id).len(),
    );
    UrlAnchor {
        left: card.x + plan.field_left,
        top: card.y,
        width: plan.field_width,
    }
}

pub fn sidebar_field_anchor(c: &Chrome) -> Option<UrlAnchor> {
    let shown = c.layout.sidebar?;
    Some(UrlAnchor {
        left: shown.x + sidebar::INSET,
        top: c.layout.first_row_top - ARC_FIELD_GAP - ARC_FIELD_ROW,
        width: (shown.w - 2.0 * sidebar::INSET).max(0.0),
    })
}

pub fn hero_rect(c: &Chrome) -> Rect {
    crate::ntp::geometry_with_heading(c.layout.page(), incognito(c)).bar
}

pub fn panel_frame(c: &Chrome, variant: Variant) -> Frame {
    let width = c.layout.width;
    match variant {
        Variant::Hero => {
            let bar = hero_rect(c);
            Frame {
                left: bar.x,
                top: bar.y,
                width: bar.w,
            }
        }
        Variant::Floating => centred_frame(c.layout.card, width),
        Variant::Dropdown => match sidebar_field_anchor(c) {
            Some(anchor) => dropdown_frame(anchor, c.layout.trailing, width),
            None => centred_frame(c.layout.card, width),
        },
        Variant::Panel => {
            let insecure = c.active.is_some_and(|t| {
                matches!(
                    t.live.security,
                    SecurityState::Insecure | SecurityState::Dangerous
                )
            });
            field_frame(url_anchor(c), insecure, width)
        }
    }
}

pub fn suggestion_icon(c: &Chrome, s: &Suggestion, tint: Hsla) -> AnyElement {
    let glyph = |name: Icon, size: f32| {
        div()
            .flex_none()
            .size(px(ROW_ICON_BOX))
            .flex()
            .items_center()
            .justify_center()
            .child(icon(name, size, tint))
            .into_any_element()
    };
    match s {
        Suggestion::Page {
            url,
            title,
            favicon,
            ..
        } => {
            let shown = favicon_of(url, favicon.as_deref(), None, title);
            render_favicon(
                &c.resolve_favicon(shown, &c.window.profile_id),
                ROW_ICON_BOX,
                c.p,
            )
        }
        Suggestion::Search { .. } => glyph(Icon::Search, ROW_ICON),
        Suggestion::Calc { .. } => glyph(Icon::EqualCircle, ROW_CALC_ICON),
        Suggestion::Action { .. } => glyph(Icon::Command, ROW_ICON),
        Suggestion::Provider {
            url, icon, title, ..
        } => {
            let shown = favicon_of(url, icon.as_deref(), None, title);
            render_favicon(
                &c.resolve_favicon(shown, &c.window.profile_id),
                ROW_ICON_BOX,
                c.p,
            )
        }
        Suggestion::Extension { id, .. } => {
            let list = c.host.extensions(&c.window.id);
            match list.find(id).and_then(|x| x.icon.clone()) {
                Some(image) => gpui::img(image)
                    .flex_none()
                    .size(px(ROW_ICON_BOX))
                    .into_any_element(),
                None => glyph(Icon::PuzzleExtension, ROW_ICON),
            }
        }
    }
}

fn leading_icon(c: &Chrome, variant: Variant, panel: Option<&CommandPanel>) -> AnyElement {
    let current = panel.and_then(|p| p.chosen());
    let typed = panel.is_some_and(|p| !p.typed().is_empty() || p.scope.is_some());
    let slot = div()
        .flex_none()
        .w(px(ICON_SLOT))
        .flex()
        .items_center()
        .justify_center();
    match current {
        Some(s)
            if typed
                && !matches!(s, Suggestion::Search { .. })
                && !(matches!(s, Suggestion::Provider { .. })
                    && panel.and_then(|p| p.scope.as_ref()).is_some_and(|scope| {
                        scope.kind == ardia_state::omnibox::site_search::ScopeKind::Provider
                    })) =>
        {
            slot.child(suggestion_icon(c, s, c.p.text))
                .into_any_element()
        }
        _ => {
            let glyph = if incognito(c) {
                Icon::Incognito
            } else {
                Icon::Search
            };
            let tint = if variant.hero() {
                c.p.text_secondary
            } else {
                c.p.text
            };
            slot.h(px(ICON_SLOT))
                .child(icon(glyph, LEADING_ICON, tint))
                .into_any_element()
        }
    }
}

fn scope_chip(c: &Chrome, scope: &SearchScope, large: bool) -> AnyElement {
    let mark = if scope.host.is_empty() {
        icon(Icon::TextSearch, SCOPE_FAVICON, c.p.text_secondary).into_any_element()
    } else {
        let url = format!("https://{}", scope.host);
        let shown = favicon_of(&url, None, None, &scope.name);
        render_favicon(
            &c.resolve_favicon(shown, &c.window.profile_id),
            SCOPE_FAVICON,
            c.p,
        )
    };
    div()
        .flex_none()
        .h(px(if large {
            SCOPE_HERO_HEIGHT
        } else {
            SCOPE_HEIGHT
        }))
        .rounded(px(SCOPE_RADIUS))
        .pl(px(SCOPE_LEFT))
        .pr(px(SCOPE_RIGHT))
        .gap(px(SCOPE_GAP))
        .flex()
        .items_center()
        .bg(c.p.row_selected)
        .child(mark)
        .child(
            div()
                .max_w(px(SCOPE_MAX_WIDTH))
                .truncate()
                .text_size(px(FONT_TITLE))
                .font_weight(FontWeight::MEDIUM)
                .text_color(c.p.text)
                .child(SharedString::from(scope.name.clone())),
        )
        .into_any_element()
}

fn scope_pulse(c: &Chrome, scope: &SearchScope, radius: f32) -> AnyElement {
    let neutral = c.look.theme.roles.text_primary;
    let fallback = c
        .look
        .theme
        .power_up_color
        .unwrap_or(c.look.theme.roles.accent);
    let ink = hsla(pulse_ink(
        brand_color_for(&scope.host),
        c.look.dark,
        neutral,
        fallback,
    ));
    let (fill, ring) = if c.look.dark {
        (FILL_DARK, RING_DARK)
    } else {
        (FILL_LIGHT, RING_LIGHT)
    };
    let total = RISE_MS + SETTLE_MS;
    let rise_share = RISE_MS as f32 / total as f32;
    div()
        .absolute()
        .inset_0()
        .rounded(px(radius))
        .bg(ink.alpha(fill))
        .border(px(RING_WIDTH))
        .border_color(ink.alpha(ring))
        .with_animation(
            SharedString::from(format!("scope-pulse:{}:{}", scope.name, scope.host)),
            Animation::new(Duration::from_millis(total)),
            move |pulse, t| {
                let glow = if t < rise_share {
                    let x = t / rise_share;
                    1.0 - (1.0 - x).powi(3)
                } else {
                    let x = (t - rise_share) / (1.0 - rise_share);
                    let eased = if x < 0.5 {
                        2.0 * x * x
                    } else {
                        1.0 - (-2.0 * x + 2.0).powi(2) / 2.0
                    };
                    1.0 + (REST - 1.0) * eased
                };
                pulse.opacity(glow)
            },
        )
        .into_any_element()
}

fn static_field(c: &Chrome, variant: Variant) -> AnyElement {
    div()
        .flex_1()
        .min_w_0()
        .truncate()
        .mt(px(field_lift(variant)))
        .h(px((field_font(variant) * 1.3).round()))
        .line_height(px((field_font(variant) * 1.3).round()))
        .text_size(px(field_font(variant)))
        .text_color(c.p.placeholder)
        .child(SharedString::from(crate::omnibox::placeholder(
            None,
            incognito(c),
        )))
        .into_any_element()
}

fn row_title(c: &Chrome, s: &Suggestion) -> AnyElement {
    let (title, accessory) = suggestion_labels(s);
    div()
        .flex_shrink(1.)
        .min_w_0()
        .overflow_hidden()
        .flex()
        .items_center()
        .whitespace_nowrap()
        .text_size(px(FONT_TITLE))
        .child(
            div()
                .flex_shrink(0.)
                .max_w_full()
                .truncate()
                .text_color(c.p.text)
                .child(SharedString::from(title)),
        )
        .when_some(accessory, |this, accessory| {
            this.child(
                div()
                    .flex_shrink(1.)
                    .min_w_0()
                    .truncate()
                    .text_color(c.p.text_secondary)
                    .child(SharedString::from(format!(" — {accessory}"))),
            )
        })
        .into_any_element()
}

fn suggestion_row(
    c: &Chrome,
    index: usize,
    s: &Suggestion,
    selected: bool,
    trailing: Option<String>,
) -> AnyElement {
    let hint = trailing.or_else(|| row_hint(s));
    let removable = removable_url(Some(s)).is_some();
    let group = SharedString::from(format!("suggestion-row-{index}"));
    let hover_fill = c.p.command_hover;
    let pick = c.emit.clone();
    let remove = c.emit.clone();
    let remove_shown = removable;
    div()
        .id(("suggestion", index))
        .debug_selector(move || format!("suggestion-{index}"))
        .group(group.clone())
        .h(px(ROW_HEIGHT))
        .my(px(ROW_GAP_Y))
        .rounded(px(ROW_RADIUS))
        .px(px(ROW_PAD_X))
        .gap(px(ROW_GAP))
        .flex()
        .items_center()
        .when(selected, |this| this.bg(selected_fill(c)))
        .when(!selected, |this| {
            this.hover(move |style| style.bg(hover_fill))
        })
        .on_click(move |_, window, cx| pick.send(Msg::Panel(PanelMsg::Pick(index)), window, cx))
        .child(suggestion_icon(c, s, c.p.text_secondary))
        .child(row_title(c, s))
        .child(div().flex_1())
        .when_some(hint, |this, hint| {
            this.child(
                div()
                    .flex_none()
                    .text_size(px(FONT_SMALL))
                    .text_color(c.p.text_tertiary)
                    .when(remove_shown, |this| {
                        if selected {
                            this.invisible()
                        } else {
                            this.group_hover(group.clone(), |style| style.opacity(0.))
                        }
                    })
                    .child(SharedString::from(hint)),
            )
        })
        .when(remove_shown, |this| {
            let hover = c.p.toolbar_hover;
            let pressed = c.p.toolbar_pressed;
            this.child(
                div()
                    .id(("suggestion-remove", index))
                    .flex_none()
                    .size(px(REMOVE_BOX))
                    .rounded(px(REMOVE_RADIUS))
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(!selected, |this| {
                        this.opacity(0.)
                            .group_hover(group.clone(), |style| style.opacity(1.))
                    })
                    .hover(move |style| style.bg(hover))
                    .active(move |style| style.bg(pressed))
                    .tooltip(tooltip("Remove from History".into(), c.p))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_mouse_up(MouseButton::Left, move |_, window, cx| {
                        cx.stop_propagation();
                        remove.send(Msg::Panel(PanelMsg::Remove(index)), window, cx);
                    })
                    .child(icon(Icon::XMark, REMOVE_GLYPH, c.p.text_secondary)),
            )
        })
        .into_any_element()
}

fn suggestion_list(c: &Chrome, panel: &CommandPanel, variant: Variant) -> Option<AnyElement> {
    if !panel.list_shown() {
        return None;
    }
    let dropdown = variant == Variant::Dropdown;
    let selected = panel.selected_index();
    let trailing = panel.tab_scope_hint();
    Some(
        div()
            .id("command-suggestions")
            .flex()
            .flex_col()
            .px(px(if dropdown { DROPDOWN_LIST_X } else { LIST_X }))
            .pb(px(if dropdown {
                DROPDOWN_LIST_BELOW
            } else {
                LIST_BELOW
            }))
            .children(panel.result.items.iter().enumerate().map(|(index, s)| {
                suggestion_row(
                    c,
                    index,
                    s,
                    index == selected,
                    (index == 0).then(|| trailing.clone()).flatten(),
                )
            }))
            .into_any_element(),
    )
}

fn add_chip(c: &Chrome) -> AnyElement {
    let p = *c.p;
    let glass = c.look.glass;
    let emit = c.emit.clone();
    let group = SharedString::new_static("command-add-chip");
    div()
        .id("command-add")
        .debug_selector(|| "command-add".into())
        .group(group.clone())
        .relative()
        .flex_none()
        .h(px(CHIP_HEIGHT))
        .rounded(px(CHIP_HEIGHT / 2.0))
        .pl(px(CHIP_LEFT))
        .pr(px(CHIP_RIGHT))
        .gap(px(CHIP_GAP))
        .flex()
        .items_center()
        .cursor_pointer()
        .when(glass, |this| {
            this.child(glass_fill(c, CHIP_HEIGHT / 2.0, GlassState::Rest))
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .opacity(0.)
                        .group_hover(group.clone(), |style| style.opacity(1.))
                        .child(glass_fill(c, CHIP_HEIGHT / 2.0, GlassState::Lit)),
                )
                .active(move |style| style.bg(p.toolbar_pressed))
        })
        .when(!glass, |this| {
            this.border(px(1.))
                .border_color(p.chip_border)
                .hover(move |style| style.bg(p.row_hover))
                .active(move |style| style.bg(p.toolbar_pressed))
        })
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |event, window, cx| {
            emit.send(
                Msg::Panel(PanelMsg::AddMenu(Some(event.position()))),
                window,
                cx,
            )
        })
        .child(
            div()
                .relative()
                .flex_none()
                .size(px(CHIP_GLYPH_BOX))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    icon(Icon::ArrowUpRight, CHIP_GLYPH, p.chip_text)
                        .weight(crate::icon_picker::symbols::SymbolWeight::Medium),
                ),
        )
        .child(
            div()
                .relative()
                .text_size(px(FONT_PANEL))
                .text_color(p.chip_text)
                .child("Open a tab or file"),
        )
        .into_any_element()
}

fn dictate_button(c: &Chrome, id: &'static str) -> AnyElement {
    let glyph = hsla(c.look.theme.quiet_bar_glyph());
    let emit = c.emit.clone();
    if !c.look.glass {
        return IconButton::new(id, Icon::Mic, c.p)
            .square(MIC_BOX, MIC_RADIUS)
            .glyph(MIC_GLYPH)
            .color(glyph)
            .tooltip("Dictate", c.p)
            .on_click(move |_, window, cx| emit.send(Msg::Panel(PanelMsg::Dictate), window, cx))
            .into_any_element();
    }
    let pressed = c.p.toolbar_pressed;
    let group = SharedString::new_static(id);
    div()
        .id(id)
        .group(group.clone())
        .relative()
        .flex_none()
        .size(px(GO_HEIGHT))
        .rounded(px(GO_HEIGHT / 2.0))
        .flex()
        .items_center()
        .justify_center()
        .child(glass_fill(c, GO_HEIGHT / 2.0, GlassState::Rest))
        .child(
            div()
                .absolute()
                .inset_0()
                .opacity(0.)
                .group_hover(group, |style| style.opacity(1.))
                .child(glass_fill(c, GO_HEIGHT / 2.0, GlassState::Lit)),
        )
        .active(move |style| style.bg(pressed))
        .tooltip(tooltip("Dictate".into(), c.p))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| emit.send(Msg::Panel(PanelMsg::Dictate), window, cx))
        .child(div().relative().child(icon(Icon::Mic, MIC_GLYPH, glyph)))
        .into_any_element()
}

fn go_button(c: &Chrome, label: String, enabled: bool) -> AnyElement {
    let glass = c.look.glass;
    let quiet = hsla(c.look.theme.quiet_go_label());
    let text = match (enabled, glass) {
        (false, _) => quiet,
        (true, true) => c.p.text,
        (true, false) => c.p.on_go,
    };
    let glyph = if enabled {
        text.opacity(GO_GLYPH_ALPHA)
    } else {
        text
    };
    let emit = c.emit.clone();
    let pressed = c.p.toolbar_pressed;
    let group = SharedString::new_static("command-go");
    div()
        .id("command-go")
        .debug_selector(|| "command-go".into())
        .group(group.clone())
        .relative()
        .flex_none()
        .ml(px(GO_BEFORE))
        .min_w(px(GO_MIN_WIDTH))
        .h(px(GO_HEIGHT))
        .px(px(GO_PAD_X))
        .rounded(px(GO_HEIGHT / 2.0))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(GO_GAP))
        .when(!glass, |this| {
            this.bg(if enabled {
                c.p.go
            } else {
                hsla(c.look.theme.idle_go_fill())
            })
            .when(enabled, |this| {
                this.hover(|style| style.opacity(GO_HOVER_OPACITY))
                    .active(|style| style.opacity(GO_PRESSED_OPACITY))
            })
        })
        .when(glass, |this| {
            let state = if enabled {
                GlassState::Lit
            } else {
                GlassState::Rest
            };
            this.child(glass_fill(c, GO_HEIGHT / 2.0, state))
                .when(enabled, |this| {
                    this.child(
                        div()
                            .absolute()
                            .inset_0()
                            .opacity(0.)
                            .group_hover(group.clone(), |style| style.opacity(1.))
                            .child(glass_fill(c, GO_HEIGHT / 2.0, GlassState::Pressed)),
                    )
                    .active(move |style| style.bg(pressed))
                })
        })
        .when(enabled, |this| {
            this.cursor_pointer()
                .on_click(move |_, window, cx| emit.send(Msg::Panel(PanelMsg::Go), window, cx))
        })
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            div()
                .relative()
                .text_size(px(FONT_TITLE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(text)
                .child(SharedString::from(label)),
        )
        .child(
            div()
                .relative()
                .flex_none()
                .size(px(GO_GLYPH_BOX))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    icon(Icon::Return, GO_GLYPH, glyph)
                        .weight(crate::icon_picker::symbols::SymbolWeight::Medium),
                ),
        )
        .into_any_element()
}

fn bottom_row(
    c: &Chrome,
    variant: Variant,
    label: String,
    enabled: bool,
    live: bool,
) -> AnyElement {
    let hero = variant.hero();
    div()
        .flex_none()
        .flex()
        .items_center()
        .pl(px(if hero { BOTTOM_HERO_LEFT } else { BOTTOM_LEFT }))
        .pr(px(if hero {
            BOTTOM_HERO_RIGHT
        } else {
            BOTTOM_RIGHT
        }))
        .h(px(if hero {
            BOTTOM_HERO_HEIGHT
        } else {
            BOTTOM_HEIGHT
        }))
        .when(hero, |this| this.mb(px(BOTTOM_HERO_BELOW)))
        .child(add_chip(c))
        .child(div().flex_1())
        .child(dictate_button(
            c,
            if live { "command-mic" } else { "ntp-mic" },
        ))
        .child(go_button(c, label, enabled))
        .into_any_element()
}

fn site_controls_button(c: &Chrome) -> AnyElement {
    let emit = c.emit.clone();
    IconButton::new("command-site-controls", Icon::Info, c.p)
        .square(SITE_CONTROLS_BOX, SITE_CONTROLS_BOX / 2.0)
        .glyph(SITE_CONTROLS_GLYPH)
        .color(c.p.text_secondary)
        .tooltip("Site Controls", c.p)
        .on_click(move |_, window, cx| emit.send(Msg::Panel(PanelMsg::SiteControls), window, cx))
        .into_any_element()
}

fn body(c: &Chrome, variant: Variant, panel: Option<&CommandPanel>) -> gpui::Div {
    let compact = c.state.settings.compact_toolbar;
    let hero = variant.hero();
    let dropdown = variant == Variant::Dropdown;
    let field = match panel {
        Some(panel) => div()
            .flex_1()
            .min_w_0()
            .mt(px(field_lift(variant)))
            .child(panel.input.clone())
            .into_any_element(),
        None => static_field(c, variant),
    };
    let scope = panel.and_then(|p| p.scope.as_ref());
    let (left, right, gap) = match variant {
        Variant::Dropdown => (DROPDOWN_LEFT, DROPDOWN_RIGHT, DROPDOWN_GAP),
        Variant::Hero => (HERO_ICON_LEFT, FIELD_RIGHT, HERO_GAP),
        _ => (PANEL_ICON_LEFT, FIELD_RIGHT, PANEL_GAP),
    };
    let field_row = div()
        .flex_none()
        .flex()
        .items_center()
        .h(px(field_row_height(variant, compact)))
        .pl(px(left))
        .pr(px(right))
        .gap(px(gap))
        .child(leading_icon(c, variant, panel))
        .when_some(scope, |this, scope| this.child(scope_chip(c, scope, hero)))
        .child(field)
        .when(
            dropdown && c.active.is_some_and(|t| !t.url.is_empty()),
            |this| this.child(site_controls_button(c)),
        );
    let label = destination_label(panel.and_then(|p| p.chosen()));
    let enabled = panel.is_some_and(|p| p.go_enabled()) || (!hero && panel.is_none());
    let hovered = c.emit.clone();
    let rows = div()
        .id("command-rows")
        .flex()
        .flex_col()
        .on_hover(move |over, window, cx| {
            hovered.send(Msg::Panel(PanelMsg::RowsHovered(*over)), window, cx)
        })
        .when_some(
            panel.and_then(|p| suggestion_list(c, p, variant)),
            |this, list| this.child(list),
        )
        .when(!dropdown, |this| {
            this.child(bottom_row(c, variant, label, enabled, panel.is_some()))
        });
    div().flex().flex_col().child(field_row).child(rows)
}

fn surface(c: &Chrome, variant: Variant) -> gpui::Div {
    let p = c.p;
    let black = gpui::black();
    let radius = if variant == Variant::Dropdown {
        DROPDOWN_RADIUS
    } else {
        HERO_RADIUS
    };
    let base = div()
        .rounded(px(radius))
        .bg(p.ntp_bar)
        .border(px(HAIRLINE))
        .border_color(p.ntp_bar_border);
    if variant.hero() {
        base.p(px(HERO_INSET)).shadow(vec![
            shadow(black.opacity(0.08), 0.5, 2.),
            shadow(black.opacity(0.04), 2., 1.),
        ])
    } else {
        base.shadow(vec![shadow(
            black.opacity(c.look.theme.roles.panel_shadow_opacity),
            DIALOG_SHADOW_Y,
            DIALOG_SHADOW_BLUR,
        )])
    }
}

pub fn hero_bar(c: &Chrome, bar: Rect) -> AnyElement {
    surface(c, Variant::Hero)
        .id("ntp-bar")
        .debug_selector(|| "ntp-bar".into())
        .absolute()
        .left(px(bar.x))
        .top(px(bar.y))
        .w(px(bar.w))
        .cursor_text()
        .on_click(c.emit.click(Msg::OpenCommandPanel {
            new_tab: false,
            text: None,
        }))
        .child(crate::onboarding::tour::probe(
            c.window.id.clone(),
            crate::onboarding::tour::Anchor::CommandBar,
        ))
        .child(body(c, Variant::Hero, None))
        .into_any_element()
}

pub fn command_panel(c: &Chrome, panel: &CommandPanel) -> AnyElement {
    let variant = panel.variant;
    let frame = panel_frame(c, variant);
    let radius = if variant == Variant::Dropdown {
        DROPDOWN_RADIUS
    } else {
        HERO_RADIUS
    };
    let keys = c.emit.clone();
    let tab_emit = c.emit.clone();
    let leave_emit = c.emit.clone();
    let leaves_scope = panel.scope.is_some() && panel.typed().is_empty();
    let menu = panel.add_menu.map(|at| add_menu(c, at));
    surface(c, variant)
        .id("command-panel")
        .debug_selector(|| "command-panel".into())
        .absolute()
        .left(px(frame.left))
        .top(px(frame.top))
        .w(px(frame.width))
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
        .capture_action(move |_: &AcceptCompletion, window, cx| {
            cx.stop_propagation();
            tab_emit.send(Msg::Panel(PanelMsg::Key(PanelKey::Tab)), window, cx);
        })
        .capture_action(move |_: &Backspace, window, cx| {
            if leaves_scope {
                cx.stop_propagation();
                leave_emit.send(Msg::Panel(PanelMsg::Key(PanelKey::LeaveScope)), window, cx);
            }
        })
        .on_key_down(move |event: &KeyDownEvent, window, cx| {
            if let Some(key) = panel_key(event) {
                cx.stop_propagation();
                keys.send(Msg::Panel(PanelMsg::Key(key)), window, cx);
            }
        })
        .child(
            div()
                .relative()
                .rounded(px(radius))
                .overflow_hidden()
                .when_some(panel.scope.as_ref(), |this, scope| {
                    this.child(scope_pulse(c, scope, radius))
                })
                .child(body(c, variant, Some(panel))),
        )
        .children(menu)
        .into_any_element()
}

pub fn panel_key(event: &KeyDownEvent) -> Option<PanelKey> {
    let stroke = &event.keystroke;
    let m = stroke.modifiers;
    match stroke.key.as_str() {
        "pageup" if !m.modified() => Some(PanelKey::PageUp),
        "pagedown" if !m.modified() => Some(PanelKey::PageDown),
        "tab" if m.shift && !m.control && !m.platform && !m.alt => Some(PanelKey::Previous),
        "n" if m.control && !m.platform && !m.alt && !m.shift => Some(PanelKey::Next),
        "p" if m.control && !m.platform && !m.alt && !m.shift => Some(PanelKey::Previous),
        "delete" if m.shift && !m.platform && !m.control && !m.alt => {
            Some(PanelKey::RemoveSelected)
        }
        "enter" if m.alt || m.control || (m.platform && m.shift) => Some(PanelKey::Enter {
            meta: m.platform,
            alt: m.alt,
            shift: m.shift,
            ctrl: m.control,
        }),
        _ => None,
    }
}

pub fn add_menu_entries(
    state: &ardia_state::BrowserState,
    window: &ardia_state::WindowId,
) -> Vec<MenuEntry> {
    let tabs: Vec<MenuEntry> = other_open_tabs(state, window)
        .into_iter()
        .map(|(tab, title)| {
            MenuItem::new(format!("tab:{}", tab.as_str()), title)
                .msg(Msg::Panel(PanelMsg::SwitchTo(tab)))
                .entry()
        })
        .collect();
    let files = vec![
        MenuItem::new("files", "Open File…")
            .symbol("doc")
            .msg(Msg::Panel(PanelMsg::OpenFile))
            .entry(),
    ];
    sections(vec![tabs, files])
}

fn add_menu(c: &Chrome, at: gpui::Point<gpui::Pixels>) -> AnyElement {
    let emit = c.emit.clone();
    div()
        .child(
            gpui::deferred(
                div()
                    .id("command-add-menu-catcher")
                    .absolute()
                    .size(px(100_000.))
                    .left(px(-50_000.))
                    .top(px(-50_000.))
                    .occlude()
                    .on_mouse_down(gpui::MouseButton::Left, move |_, window, cx| {
                        emit.send(Msg::Panel(PanelMsg::AddMenu(None)), window, cx);
                    }),
            )
            .with_priority(2),
        )
        .child(entries_menu(
            c,
            "command-add-menu",
            add_menu_entries(c.state, &c.window.id),
            at,
        ))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_rows_and_fonts_follow_the_old_tokens() {
        assert_eq!(field_row_height(Variant::Panel, false), 55.0);
        assert_eq!(field_row_height(Variant::Panel, true), 55.0 - 2.0 * 7.0);
        assert_eq!(field_row_height(Variant::Hero, false), 60.0);
        assert_eq!(field_row_height(Variant::Dropdown, false), 44.0);
        assert_eq!(field_font(Variant::Panel), 13.0);
        assert_eq!(field_font(Variant::Floating), 15.0);
        assert_eq!(field_font(Variant::Hero), 17.0);
        assert!((PANEL_ICON_LEFT + ICON_SLOT + PANEL_GAP + 2.5 - 48.0).abs() < 1e-4);
        assert!(
            (HERO_INSET * 2.0 + HERO_ROW + BOTTOM_HERO_HEIGHT + BOTTOM_HERO_BELOW + 0.0 - 112.0)
                .abs()
                < 1e-4
        );
    }

    #[test]
    fn glass_controls_brighten_with_their_state() {
        let resting = RgbaColor::new(1.0, 1.0, 1.0, 0.4);
        let rest = glass_tint(resting, GlassState::Rest);
        let lit = glass_tint(resting, GlassState::Lit);
        assert!((rest.a - GLASS_REST_FILL).abs() < 1e-6);
        assert!(lit.a > rest.a);
    }
}
