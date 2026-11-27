use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*,
};

use crate::look::Palette;
use crate::msg::Msg;
use crate::primitives::controls::{MenuRow, PopUp, popover, separator};
use crate::scale::px;
use crate::settings::SettingsWindowView;
use crate::settings::panes::{
    GROUP_RADIUS, POPUP_HEIGHT, ROW_MIN_HEIGHT, ROW_PAD_X, ROW_PAD_Y, SECTION_TOP, menu_command,
};

use super::COMMAND;

pub fn command(verb: &str, argument: &str) -> Msg {
    Msg::Command(SharedString::from(if argument.is_empty() {
        format!("{COMMAND}{verb}")
    } else {
        format!("{COMMAND}{verb}:{argument}")
    }))
}

pub fn flash_fill(p: &Palette) -> gpui::Hsla {
    if p.dark {
        gpui::hsla(211.0 / 360.0, 1.0, 0.52, 0.22)
    } else {
        gpui::hsla(211.0 / 360.0, 1.0, 0.5, 0.16)
    }
}

pub fn section_header(
    view: &SettingsWindowView,
    anchor: Option<&'static str>,
    title: &'static str,
    description: Option<&'static str>,
) -> AnyElement {
    section_header_with(view, anchor, title, description, None)
}

pub fn section_header_with(
    view: &SettingsWindowView,
    anchor: Option<&'static str>,
    title: &'static str,
    description: Option<&'static str>,
    action: Option<AnyElement>,
) -> AnyElement {
    let p = view.look.p;
    let flashing = anchor.is_some_and(|id| view.flashing(id));
    let glow = anchor.map_or(0.0, |id| view.flash_glow(id));
    div()
        .when_some(anchor, |this, id| {
            this.debug_selector(move || format!("setting:{id}"))
        })
        .mt(px(SECTION_TOP))
        .mb(px(6.))
        .px(px(6.))
        .rounded(px(GROUP_RADIUS))
        .when(flashing, |this| this.bg(flash_fill(&p).opacity(glow)))
        .flex()
        .items_end()
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(16.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(title),
                )
                .when_some(description, |this, detail| {
                    this.child(
                        div()
                            .mt(px(4.))
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(p.text_secondary)
                            .child(detail),
                    )
                }),
        )
        .children(action)
        .into_any_element()
}

pub struct RowSpec {
    pub id: SharedString,
    pub anchor: Option<&'static str>,
    pub icon: Option<AnyElement>,
    pub title: Option<AnyElement>,
    pub description: Option<SharedString>,
    pub controls: Vec<AnyElement>,
}

impl RowSpec {
    pub fn new(id: impl Into<SharedString>) -> RowSpec {
        RowSpec {
            id: id.into(),
            anchor: None,
            icon: None,
            title: None,
            description: None,
            controls: Vec::new(),
        }
    }

    pub fn anchor(mut self, anchor: &'static str) -> RowSpec {
        self.anchor = Some(anchor);
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> RowSpec {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> RowSpec {
        let title: SharedString = title.into();
        self.title = Some(
            div()
                .text_size(px(13.))
                .line_height(px(16.))
                .child(title)
                .into_any_element(),
        );
        self
    }

    pub fn title_element(mut self, title: impl IntoElement) -> RowSpec {
        self.title = Some(title.into_any_element());
        self
    }

    pub fn description(mut self, description: Option<impl Into<SharedString>>) -> RowSpec {
        self.description = description.map(Into::into);
        self
    }

    pub fn control(mut self, control: impl IntoElement) -> RowSpec {
        self.controls.push(control.into_any_element());
        self
    }

    pub fn render(self, view: &SettingsWindowView) -> AnyElement {
        let p = view.look.p;
        let flashing = self.anchor.is_some_and(|id| view.flashing(id));
        let glow = self.anchor.map_or(0.0, |id| view.flash_glow(id));
        let selector = self.id.clone();
        div()
            .id(self.id)
            .debug_selector(move || selector.to_string())
            .min_h(px(ROW_MIN_HEIGHT))
            .px(px(ROW_PAD_X))
            .py(px(ROW_PAD_Y))
            .flex()
            .items_center()
            .gap(px(12.))
            .when(flashing, |this| this.bg(flash_fill(&p).opacity(glow)))
            .children(self.icon)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .children(self.title)
                    .when_some(self.description, |this, text| {
                        this.child(
                            div()
                                .mt(px(2.))
                                .text_size(px(11.))
                                .line_height(px(14.))
                                .text_color(p.text_secondary)
                                .child(text),
                        )
                    }),
            )
            .when(!self.controls.is_empty(), |this| {
                this.child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .children(self.controls),
                )
            })
            .into_any_element()
    }
}

pub fn group(p: &Palette, rows: Vec<AnyElement>) -> AnyElement {
    crate::primitives::list::group(p, rows).into_any_element()
}

pub fn block(rows: Vec<&'static str>, element: AnyElement) -> crate::settings::panes::Block {
    crate::settings::panes::Block { rows, element }
}

#[derive(Clone)]
pub struct Choice {
    pub label: SharedString,
    pub checked: bool,
    pub separator_before: bool,
    pub enabled: bool,
    pub destructive: bool,
    pub icon: Option<crate::primitives::icons::Icon>,
    pub msg: Msg,
}

impl Choice {
    pub fn new(label: impl Into<SharedString>, checked: bool, msg: Msg) -> Choice {
        Choice {
            label: label.into(),
            checked,
            separator_before: false,
            enabled: true,
            destructive: false,
            icon: None,
            msg,
        }
    }

    pub fn after_separator(mut self, separated: bool) -> Choice {
        self.separator_before = separated;
        self
    }

    pub fn enabled(mut self, enabled: bool) -> Choice {
        self.enabled = enabled;
        self
    }

    pub fn icon(mut self, icon: crate::primitives::icons::Icon) -> Choice {
        self.icon = Some(icon);
        self
    }
}

pub fn menu_list(
    view: &SettingsWindowView,
    id: &str,
    width: f32,
    items: Vec<Choice>,
) -> AnyElement {
    let p = view.look.p;
    let menu_id = SharedString::from(format!("popup-menu:{id}"));
    let selector = menu_id.clone();
    popover(menu_id, false, width, &p)
        .debug_selector(move || selector.to_string())
        .children(items.into_iter().enumerate().flat_map(|(index, item)| {
            let emit = view.emit.clone();
            let msg = item.msg;
            let mut out: Vec<AnyElement> = Vec::new();
            if item.separator_before && index > 0 {
                out.push(separator(&p).into_any_element());
            }
            let mut row = MenuRow::new(
                SharedString::from(format!("popup-item:{id}:{index}")),
                item.label,
                &p,
            );
            if let Some(glyph) = item.icon {
                row = row.icon(glyph);
            }
            out.push(
                row.checked(item.checked)
                    .disabled(!item.enabled)
                    .destructive(item.destructive)
                    .on_click(move |_, window, cx| {
                        emit.send(Msg::CloseOverlays, window, cx);
                        emit.send(msg.clone(), window, cx);
                    })
                    .into_any_element(),
            );
            out
        }))
        .into_any_element()
}

pub fn popup(
    view: &SettingsWindowView,
    id: &str,
    min_width: f32,
    disabled: bool,
    items: Vec<Choice>,
) -> AnyElement {
    popup_styled(view, id, min_width, disabled, items, true)
}

pub fn sheet_popup(
    view: &SettingsWindowView,
    id: &str,
    min_width: f32,
    items: Vec<Choice>,
) -> AnyElement {
    popup_styled(view, id, min_width, false, items, false)
}

pub fn popup_styled(
    view: &SettingsWindowView,
    id: &str,
    min_width: f32,
    disabled: bool,
    items: Vec<Choice>,
    native: bool,
) -> AnyElement {
    let p = view.look.p;
    let label = items
        .iter()
        .find(|item| item.checked)
        .map(|item| item.label.clone())
        .unwrap_or_default();
    let open = view.menu.as_deref() == Some(id) && !disabled;
    let selector = format!("popup:{id}");
    div()
        .relative()
        .child(
            div().debug_selector(move || selector).child(
                PopUp::new(SharedString::from(format!("popup:{id}")), label, &p)
                    .min_width(min_width)
                    .native(native)
                    .disabled(disabled)
                    .on_click(crate::primitives::pop_up_menu::opener(
                        &view.host,
                        &view.emit,
                        items
                            .iter()
                            .map(|item| {
                                crate::primitives::pop_up_menu::PopUpChoice::new(
                                    item.label.clone(),
                                    item.checked,
                                    vec![item.msg.clone()],
                                )
                                .separated(item.separator_before)
                                .enabled(item.enabled)
                            })
                            .collect(),
                        Msg::Command(menu_command(id)),
                    )),
            ),
        )
        .when(open, |this| {
            this.child(
                gpui::deferred(
                    div()
                        .absolute()
                        .top(px(POPUP_HEIGHT + 2.))
                        .right_0()
                        .child(menu_list(view, id, min_width.max(160.), items)),
                )
                .with_priority(2),
            )
        })
        .into_any_element()
}

pub fn anchored_menu(
    view: &SettingsWindowView,
    id: &str,
    trigger: AnyElement,
    width: f32,
    items: Vec<Choice>,
) -> AnyElement {
    let open = view.menu.as_deref() == Some(id);
    div()
        .relative()
        .child(trigger)
        .when(open, |this| {
            this.child(
                gpui::deferred(
                    div()
                        .absolute()
                        .top(px(26.))
                        .right_0()
                        .child(menu_list(view, id, width, items)),
                )
                .with_priority(2),
            )
        })
        .into_any_element()
}

pub fn field(
    view: &SettingsWindowView,
    input: &gpui::Entity<crate::primitives::text_input::TextInput>,
    selector: &'static str,
) -> AnyElement {
    crate::primitives::controls::field_box(&view.look.p)
        .debug_selector(move || selector.into())
        .w_full()
        .h(px(22.))
        .child(div().flex_1().min_w_0().child(input.clone()))
        .into_any_element()
}

pub fn form_field(view: &SettingsWindowView, label: &'static str, body: AnyElement) -> AnyElement {
    let p = view.look.p;
    div()
        .child(
            div()
                .mt(px(12.))
                .mb(px(4.))
                .text_size(px(11.))
                .text_color(p.text_secondary)
                .child(label),
        )
        .child(body)
        .into_any_element()
}
