use ardia_theme::tokens::{TypeSize, radius, space};
use gpui::{
    AnyElement, FontWeight, IntoElement, ObjectFit, ParentElement, SharedString, Styled, div, img,
    prelude::*,
};

use crate::host_data::{ExtensionInstallView, ExtensionList};
use crate::msg::Msg;
use crate::popovers::panel::{pill, primary_pill};
use crate::primitives::controls::{Checkbox, shadow};
use crate::scale::px;
use crate::window::chrome::Chrome;

pub const DIALOG_WIDTH: f32 = 420.0;
pub const EXTENSION_ICON: f32 = 36.0;
pub const PERMISSIONS_MAX_HEIGHT: f32 = 180.0;
pub const PIN_LIST_MAX_HEIGHT: f32 = 300.0;
pub const NO_PERMISSIONS: &str = "This extension requires no special permissions.";
pub const PIN_SUBTITLE: &str = "Pinned extensions appear in the toolbar, next to the address.";

fn dialog(
    c: &Chrome,
    id: &'static str,
    dismiss: Msg,
    body: Vec<AnyElement>,
    actions: Vec<AnyElement>,
) -> AnyElement {
    let p = c.p;
    let scrim = p.shadow.opacity(0.25);
    div()
        .id(id)
        .debug_selector(move || id.into())
        .absolute()
        .inset_0()
        .occlude()
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .id("dialog-scrim")
                .absolute()
                .inset_0()
                .bg(scrim)
                .on_click(c.emit.click(dismiss)),
        )
        .child(
            div()
                .id("dialog-surface")
                .relative()
                .w(px(DIALOG_WIDTH))
                .p(px(space::XXL))
                .rounded(px(radius::SHEET))
                .bg(p.popover_fill)
                .border(px(0.5))
                .border_color(p.popover_border)
                .shadow(vec![shadow(p.shadow, 10., 24.)])
                .text_color(p.text)
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .flex()
                .flex_col()
                .children(body)
                .child(
                    div()
                        .mt(px(space::XL))
                        .flex()
                        .items_center()
                        .gap(px(space::M))
                        .child(div().flex_1())
                        .children(actions),
                ),
        )
        .into_any_element()
}

fn title(
    text: String,
    subtitle: Option<&'static str>,
    glyph: Option<AnyElement>,
    c: &Chrome,
) -> AnyElement {
    let p = c.p;
    div()
        .flex()
        .items_center()
        .gap(px(space::L))
        .children(glyph)
        .child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(TypeSize::Title.points()))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(SharedString::from(text)),
                )
                .when_some(subtitle, |this, subtitle| {
                    this.child(
                        div()
                            .mt(px(space::S))
                            .text_size(px(TypeSize::Small.points()))
                            .text_color(p.text_secondary)
                            .child(subtitle),
                    )
                }),
        )
        .into_any_element()
}

fn send(
    c: &Chrome,
    msg: Msg,
) -> impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static {
    let emit = c.emit.clone();
    move |_, window, cx| emit.send(msg.clone(), window, cx)
}

pub fn install_dialog(c: &Chrome, install: &ExtensionInstallView) -> AnyElement {
    let p = c.p;
    let cancel = Msg::ResolveInstall {
        request: install.request_id.clone(),
        accepted: false,
    };
    let accept = Msg::ResolveInstall {
        request: install.request_id.clone(),
        accepted: true,
    };
    let glyph = install.icon.clone().map(|icon| {
        img(icon)
            .size(px(EXTENSION_ICON))
            .flex_none()
            .object_fit(ObjectFit::Contain)
            .into_any_element()
    });
    let mut body = vec![title(install.title(), None, glyph, c)];
    if install.permissions.is_empty() {
        body.push(
            div()
                .mt(px(space::XL))
                .text_size(px(TypeSize::Body.points()))
                .text_color(p.text_secondary)
                .child(NO_PERMISSIONS)
                .into_any_element(),
        );
    } else {
        body.push(
            div()
                .mt(px(space::XL))
                .mb(px(space::S))
                .text_size(px(TypeSize::Body.points()))
                .child("It can:")
                .into_any_element(),
        );
        body.push(
            div()
                .id("install-permissions")
                .max_h(px(PERMISSIONS_MAX_HEIGHT))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .children(install.permissions.iter().map(|warning| {
                    div()
                        .mb(px(space::XS))
                        .flex()
                        .gap(px(space::M))
                        .text_size(px(TypeSize::Body.points()))
                        .text_color(p.text_secondary)
                        .child("•")
                        .child(div().flex_1().child(SharedString::from(warning.clone())))
                }))
                .into_any_element(),
        );
    }
    dialog(
        c,
        "extension-install",
        cancel.clone(),
        body,
        vec![
            pill("install-cancel", "Cancel", p, send(c, cancel)),
            primary_pill("install-accept", install.action(), p, send(c, accept)),
        ],
    )
}

pub fn pin_dialog(c: &Chrome, list: &ExtensionList) -> AnyElement {
    let p = c.p;
    let enabled = list.menu();
    let mut body = vec![title(
        "Pin Extensions".to_owned(),
        Some(PIN_SUBTITLE),
        None,
        c,
    )];
    if enabled.is_empty() {
        body.push(
            div()
                .mt(px(space::L))
                .text_size(px(TypeSize::Body.points()))
                .text_color(p.text_tertiary)
                .child("No extensions are turned on.")
                .into_any_element(),
        );
    } else {
        body.push(
            div()
                .id("pin-list")
                .mt(px(space::L))
                .max_h(px(PIN_LIST_MAX_HEIGHT))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .children(enabled.into_iter().map(|item| {
                    let toggle = Msg::PinExtension {
                        extension: item.id.clone(),
                        pinned: !item.pinned,
                    };
                    let key = item.id.clone();
                    div()
                        .id(SharedString::from(format!("pin-row:{}", item.id)))
                        .debug_selector(move || format!("pin-row:{key}"))
                        .py(px(space::S))
                        .flex()
                        .items_center()
                        .gap(px(space::ML))
                        .cursor_pointer()
                        .on_click(send(c, toggle.clone()))
                        .child(
                            Checkbox::new(
                                SharedString::from(format!("pin-box:{}", item.id)),
                                item.pinned,
                                "",
                                p,
                            )
                            .on_toggle({
                                let emit = c.emit.clone();
                                move |_, window, cx| emit.send(toggle.clone(), window, cx)
                            }),
                        )
                        .children(item.icon.clone().map(|icon| {
                            img(icon)
                                .size(px(16.))
                                .flex_none()
                                .object_fit(ObjectFit::Contain)
                        }))
                        .child(
                            div()
                                .flex_1()
                                .truncate()
                                .text_size(px(TypeSize::Body.points()))
                                .child(SharedString::from(item.name.clone())),
                        )
                }))
                .into_any_element(),
        );
    }
    dialog(
        c,
        "pin-extensions",
        Msg::PinDialog(false),
        body,
        vec![primary_pill(
            "pin-done",
            "Done",
            p,
            send(c, Msg::PinDialog(false)),
        )],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_prompts_use_the_old_titles() {
        let mut install = ExtensionInstallView {
            request_id: "r".into(),
            name: "Dark Reader".into(),
            kind: String::new(),
            icon: None,
            permissions: Vec::new(),
        };
        assert_eq!(install.title(), "Add “Dark Reader”?");
        assert_eq!(install.action(), "Add Extension");
        install.kind = "re-enable".into();
        assert_eq!(install.title(), "Turn “Dark Reader” back on?");
        assert_eq!(install.action(), "Turn On");
        install.kind = "permissions".into();
        assert_eq!(install.title(), "“Dark Reader” needs new permissions");
        assert_eq!(install.action(), "Allow");
    }
}
