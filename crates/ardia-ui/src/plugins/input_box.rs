use std::sync::Arc;

use ardia_theme::tokens::{TypeSize, radius, space};
use gpui::{
    Context, Entity, FontWeight, IntoElement, ParentElement, Render, Styled, Subscription, Window,
    div, prelude::*,
};

use super::dialog::{dialog_actions, dialog_frame, dialog_title};
use super::model::{InputBoxRequest, PluginHost};
use super::surface::caption;
use super::tokens::dialog;
use crate::look::Palette;
use crate::primitives::controls::{ButtonKind, PushButton};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput, focus_input};
use crate::scale::px;

pub fn input_box_copy(request: &InputBoxRequest) -> (Option<String>, Option<String>, String) {
    let options = &request.options;
    let subtitle = options
        .message
        .clone()
        .or_else(|| request.plugin_title.clone());
    let asked_by = match (&options.message, &request.plugin_title) {
        (Some(_), Some(plugin)) => Some(format!("Asked by {plugin}")),
        _ => None,
    };
    let confirm = options.confirm_title.clone().unwrap_or_else(|| "OK".into());
    (subtitle, asked_by, confirm)
}

pub struct InputBoxView {
    plugins: Arc<dyn PluginHost>,
    pub request: InputBoxRequest,
    field: Entity<TextInput>,
    done: bool,
    p: Palette,
    _subscription: Subscription,
}

impl InputBoxView {
    pub fn new(
        plugins: Arc<dyn PluginHost>,
        request: InputBoxRequest,
        p: Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let style = InputStyle {
            text: p.text,
            placeholder: p.placeholder,
            caret: p.caret,
            selection: p.selection,
            font_size: TypeSize::Body.points(),
            weight: FontWeight::NORMAL,
        };
        let placeholder = request.options.placeholder.clone().unwrap_or_default();
        let value = request.options.value.clone().unwrap_or_default();
        let secure = request.options.password;
        let field = cx.new(|cx| {
            let mut input = TextInput::new(placeholder, cx);
            input.set_style(style, cx);
            input.set_text(value, true, cx);
            input.set_secure(secure, cx);
            input
        });
        focus_input(&field, window, cx);
        let subscription = cx.subscribe_in(&field, window, |view, input, event, _, cx| {
            let text = input.read(cx).text().to_owned();
            match event {
                InputEvent::Submit(_) => view.settle(Some(text), cx),
                InputEvent::Cancel => view.settle(None, cx),
                _ => {}
            }
        });
        InputBoxView {
            plugins,
            request,
            field,
            done: false,
            p,
            _subscription: subscription,
        }
    }

    pub fn settle(&mut self, value: Option<String>, cx: &mut Context<Self>) {
        if !self.done {
            self.done = true;
            self.plugins.resolve_input_box(self.request.id, value);
        }
        cx.notify();
    }
}

impl Render for InputBoxView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.p;
        if self.done {
            return div().into_any_element();
        }
        let (subtitle, asked_by, confirm) = input_box_copy(&self.request);
        let content = div()
            .flex()
            .flex_col()
            .child(dialog_title(
                self.request.options.title.clone(),
                subtitle,
                None,
                &p,
            ))
            .child(
                div()
                    .mt(px(space::M))
                    .flex()
                    .flex_col()
                    .gap(px(space::XS))
                    .child(
                        div()
                            .h(px(28.))
                            .px(px(space::M))
                            .rounded(px(radius::CONTROL + 2.))
                            .bg(p.field)
                            .border(px(1.))
                            .border_color(p.field_border)
                            .flex()
                            .items_center()
                            .child(self.field.clone()),
                    )
                    .when_some(asked_by, |this, asked| {
                        this.child(caption(asked, p.text_tertiary))
                    }),
            )
            .child(dialog_actions(vec![
                PushButton::new("input-box-cancel", "Cancel", &p)
                    .on_click(cx.listener(|view, _, _, cx| view.settle(None, cx)))
                    .into_any_element(),
                PushButton::new("input-box-confirm", confirm, &p)
                    .kind(ButtonKind::Primary)
                    .on_click(cx.listener(|view, _, _, cx| {
                        let text = view.field.read(cx).text().to_owned();
                        view.settle(Some(text), cx);
                    }))
                    .into_any_element(),
            ]));
        dialog_frame(
            "plugin-input-box",
            dialog::WIDTH_S,
            dialog::PAD,
            None,
            &p,
            content.into_any_element(),
            cx.listener(|view, _, _, cx| view.settle(None, cx)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::model::InputBoxOptions;
    use ardia_state::WindowId;

    #[test]
    fn copy_matches_the_old_dialog() {
        let mut request = InputBoxRequest {
            id: 1,
            plugin: "p".into(),
            plugin_title: Some("Notes".into()),
            window: WindowId::new("w"),
            options: InputBoxOptions {
                title: "Name".into(),
                ..InputBoxOptions::default()
            },
        };
        assert_eq!(
            input_box_copy(&request),
            (Some("Notes".into()), None, "OK".into())
        );
        request.options.message = Some("Pick one".into());
        request.options.confirm_title = Some("Rename".into());
        assert_eq!(
            input_box_copy(&request),
            (
                Some("Pick one".into()),
                Some("Asked by Notes".into()),
                "Rename".into()
            )
        );
    }
}
