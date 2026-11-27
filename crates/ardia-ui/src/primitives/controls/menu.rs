use crate::scale::px;
use ardia_theme::layout::panel;
use gpui::{
    App, ClickEvent, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled,
    Window, div, prelude::*,
};

use crate::look::Palette;
use crate::primitives::icons::{Icon, icon};

use super::*;

#[derive(IntoElement)]
pub struct MenuRow {
    id: ElementId,
    glyph: Option<Icon>,
    title: SharedString,
    trailing: Option<SharedString>,
    destructive: bool,
    checked: bool,
    disabled: bool,
    selected: bool,
    detail: Option<SharedString>,
    p: Palette,
    on_click: Option<ClickHandler>,
    glass_fill: Option<gpui::Div>,
}

pub const MENU_ROW_DISABLED_OPACITY: f32 = 0.45;
pub const MENU_ROW_TEXT_PAD: f32 = 6.;
pub const MENU_ROW_DETAIL_SIZE: f32 = 11.;

pub fn menu_row_reserves_icon_slot(has_glyph: bool, checked: bool) -> bool {
    has_glyph || checked
}

impl MenuRow {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>, p: &Palette) -> Self {
        MenuRow {
            id: id.into(),
            glyph: None,
            title: title.into(),
            trailing: None,
            destructive: false,
            checked: false,
            disabled: false,
            selected: false,
            detail: None,
            p: *p,
            on_click: None,
            glass_fill: None,
        }
    }

    pub fn glass_fill(mut self, glass: gpui::Div) -> Self {
        self.glass_fill = Some(glass);
        self
    }

    pub fn icon(mut self, glyph: Icon) -> Self {
        self.glyph = Some(glyph);
        self
    }

    pub fn trailing(mut self, text: impl Into<SharedString>) -> Self {
        self.trailing = Some(text.into());
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

    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
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

impl RenderOnce for MenuRow {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let p = self.p;
        let ink = if self.destructive {
            p.destructive
        } else {
            p.text
        };
        let selector = self.id.to_string();
        let slot = menu_row_reserves_icon_slot(self.glyph.is_some(), self.checked);
        div().px(px(panel::ROW_INSET)).child(
            div()
                .debug_selector(move || selector)
                .id(self.id)
                .min_h(px(panel::ROW_HEIGHT))
                .when(self.disabled, |this| {
                    this.opacity(MENU_ROW_DISABLED_OPACITY)
                })
                .when(self.selected, |this| this.bg(p.row_selected))
                .px(px(panel::ROW_PADDING))
                .rounded(px(panel::ROW_RADIUS))
                .flex()
                .items_center()
                .gap(px(panel::ICON_GAP))
                .text_size(px(13.))
                .text_color(ink)
                .when(!self.disabled, |this| match self.glass_fill {
                    Some(glass) => this
                        .relative()
                        .group(crate::primitives::glass_states::GLASS_CONTROL_GROUP)
                        .child(glass)
                        .cursor_pointer(),
                    None => this
                        .hover(move |style| style.bg(p.menu_hover))
                        .active(move |style| style.bg(p.popover_row_pressed))
                        .cursor_pointer(),
                })
                .when_some(self.on_click.filter(|_| !self.disabled), |this, handler| {
                    this.on_click(move |event, window, cx| {
                        cx.stop_propagation();
                        handler(event, window, cx);
                    })
                })
                .when(slot, |this| {
                    this.child(
                        div()
                            .w(px(panel::ICON_SLOT))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .when_some(self.glyph, |this, glyph| {
                                this.child(icon(
                                    glyph,
                                    panel::ICON_SIZE,
                                    if self.destructive {
                                        p.destructive
                                    } else {
                                        p.icon
                                    },
                                ))
                            })
                            .when(self.checked && self.glyph.is_none(), |this| {
                                this.child(icon(Icon::Check, panel::ICON_SIZE, p.text))
                            }),
                    )
                })
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .py(px(MENU_ROW_TEXT_PAD))
                        .flex()
                        .flex_col()
                        .child(div().truncate().child(self.title))
                        .when_some(self.detail, |this, detail| {
                            this.child(
                                div()
                                    .text_size(px(MENU_ROW_DETAIL_SIZE))
                                    .text_color(p.text_secondary)
                                    .line_clamp(2)
                                    .child(detail),
                            )
                        }),
                )
                .when(self.checked && self.glyph.is_some(), |this| {
                    this.child(icon(Icon::Check, panel::ICON_SIZE, p.text))
                })
                .when_some(self.trailing, |this, text| {
                    this.child(
                        div()
                            .flex_none()
                            .text_size(px(12.))
                            .text_color(p.text_tertiary)
                            .child(text),
                    )
                }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_without_a_glyph_or_check_start_at_the_row_padding() {
        assert!(!menu_row_reserves_icon_slot(false, false));
        assert!(menu_row_reserves_icon_slot(true, false));
        assert!(menu_row_reserves_icon_slot(false, true));
        assert_eq!(MENU_ROW_DISABLED_OPACITY, 0.45);
    }
}
