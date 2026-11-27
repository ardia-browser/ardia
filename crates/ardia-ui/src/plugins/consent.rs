use std::sync::Arc;

use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, Context, FocusHandle, Hsla, IntoElement, KeyDownEvent, KeyUpEvent, ParentElement,
    Render, Styled, Window, div, prelude::*,
};

use super::dialog::{dialog_actions, dialog_frame, dialog_title};
use super::model::{ConsentOwner, ConsentRequest, ConsentVerb, PluginHost};
use super::surface::body;
use super::tokens::{dialog, icon_named, symbol};
use crate::look::Palette;
use crate::primitives::controls::{ButtonKind, PushButton};
use crate::primitives::icons::icon;
use crate::scale::px;

pub fn consent_words(verb: ConsentVerb) -> (&'static str, &'static str) {
    match verb {
        ConsentVerb::Install => ("Install", "Install"),
        ConsentVerb::Update => ("Update", "Update"),
        ConsentVerb::TurnOn => ("Turn on", "Turn On"),
    }
}

pub fn consent_title(request: &ConsentRequest) -> String {
    let (title, _) = consent_words(request.verb);
    format!(
        "{title} {}?",
        request.title.as_deref().unwrap_or(&request.name)
    )
}

pub const CHANGED_LINE: &str = "The plugin changed while this was open. Close this and try again.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsentButton {
    Cancel,
    Install,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ConsentKeys {
    pub selected: Option<ConsentButton>,
    pub space_down: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConsentPress {
    pub key: String,
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
    pub meta: bool,
}

pub fn consent_key_down(
    state: ConsentKeys,
    press: &ConsentPress,
    can_install: bool,
) -> (ConsentKeys, Option<ConsentButton>) {
    if press.alt || press.ctrl || press.meta {
        return (state, None);
    }
    match press.key.as_str() {
        "Escape" => (state, (!press.shift).then_some(ConsentButton::Cancel)),
        " " => {
            if press.shift || state.space_down {
                return (state, None);
            }
            let pressed = match state.selected {
                Some(ConsentButton::Install) if !can_install => None,
                other => other,
            };
            (
                ConsentKeys {
                    space_down: true,
                    ..state
                },
                pressed,
            )
        }
        "Tab" => {
            let order: &[ConsentButton] = if can_install {
                &[ConsentButton::Cancel, ConsentButton::Install]
            } else {
                &[ConsentButton::Cancel]
            };
            let at = state
                .selected
                .and_then(|s| order.iter().position(|b| *b == s));
            let len = order.len();
            let next = match at {
                None if press.shift => len - 1,
                None => 0,
                Some(at) if press.shift => (at + len - 1) % len,
                Some(at) => (at + 1) % len,
            };
            (
                ConsentKeys {
                    selected: order.get(next).copied(),
                    ..state
                },
                None,
            )
        }
        _ => (state, None),
    }
}

pub fn consent_key_up(state: ConsentKeys, key: &str) -> ConsentKeys {
    if key == " " {
        ConsentKeys {
            space_down: false,
            ..state
        }
    } else {
        state
    }
}

fn press_of(keystroke: &gpui::Keystroke) -> ConsentPress {
    let key = match keystroke.key.as_str() {
        "escape" => "Escape".to_owned(),
        "tab" => "Tab".to_owned(),
        "space" => " ".to_owned(),
        other => other.to_owned(),
    };
    ConsentPress {
        key,
        shift: keystroke.modifiers.shift,
        alt: keystroke.modifiers.alt,
        ctrl: keystroke.modifiers.control,
        meta: keystroke.modifiers.platform,
    }
}

pub struct ConsentView {
    plugins: Arc<dyn PluginHost>,
    pub request: ConsentRequest,
    pub keys: ConsentKeys,
    focus: FocusHandle,
    closed: bool,
    p: Palette,
}

impl ConsentView {
    pub fn new(
        plugins: Arc<dyn PluginHost>,
        request: ConsentRequest,
        p: Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        ConsentView {
            plugins,
            request,
            keys: ConsentKeys::default(),
            focus,
            closed: false,
            p,
        }
    }

    fn owner(&self) -> ConsentOwner {
        self.request.owner
    }

    pub fn answer(&mut self, confirm: bool, cx: &mut Context<Self>) {
        if self.closed || (confirm && self.request.changed) {
            return;
        }
        if self
            .plugins
            .answer_consent(self.owner(), self.request.id, confirm)
        {
            self.closed = true;
        }
        cx.notify();
    }

    fn key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let (next, press) = consent_key_down(
            self.keys,
            &press_of(&event.keystroke),
            !self.request.changed,
        );
        self.keys = next;
        match press {
            Some(ConsentButton::Cancel) => self.answer(false, cx),
            Some(ConsentButton::Install) => self.answer(true, cx),
            None => cx.notify(),
        }
    }

    fn key_up(&mut self, event: &KeyUpEvent, cx: &mut Context<Self>) {
        self.keys = consent_key_up(self.keys, &press_of(&event.keystroke).key);
        cx.notify();
    }
}

fn ring(on: bool, color: Hsla, child: AnyElement) -> AnyElement {
    div()
        .rounded(px(radius::CONTROL + dialog::RING * 2.))
        .border(px(dialog::RING))
        .p(px(dialog::RING))
        .m(px(-dialog::RING * 2.))
        .border_color(if on { color } else { gpui::transparent_black() })
        .child(child)
        .into_any_element()
}

impl Render for ConsentView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.p;
        if self.closed {
            return div().into_any_element();
        }
        let request = &self.request;
        let (_, button) = consent_words(request.verb);
        let glyph = icon_named(request.icon.as_deref().unwrap_or("puzzlepiece.fill"));
        let leading = div()
            .size(px(dialog::CONSENT_TITLE_ICON))
            .flex()
            .items_center()
            .justify_center()
            .child(icon(glyph, dialog::CONSENT_TITLE_GLYPH, p.icon))
            .into_any_element();
        let lines: Vec<AnyElement> = if request.changed {
            vec![
                body(CHANGED_LINE, p.text_secondary)
                    .min_w_0()
                    .whitespace_normal()
                    .into_any_element(),
            ]
        } else {
            request
                .lines
                .iter()
                .enumerate()
                .map(|(index, line)| {
                    div()
                        .flex()
                        .w_full()
                        .min_w_0()
                        .gap(px(space::M))
                        .child(
                            div()
                                .size(px(dialog::CONSENT_LINE_ICON))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(symbol(&line.icon, dialog::CONSENT_LINE_GLYPH, p.icon)),
                        )
                        .child(
                            body(line.text.clone(), p.text)
                                .flex_1()
                                .min_w_0()
                                .whitespace_normal()
                                .debug_selector(move || format!("plugin-consent-line-{index}")),
                        )
                        .into_any_element()
                })
                .collect()
        };
        let selected = self.keys.selected;
        let content = div()
            .id("plugin-consent-keys")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                view.key_down(event, cx);
                cx.stop_propagation();
            }))
            .on_key_up(cx.listener(|view, event: &KeyUpEvent, _, cx| view.key_up(event, cx)))
            .flex()
            .flex_col()
            .flex_shrink(1.0)
            .w_full()
            .min_w_0()
            .child(dialog_title(
                consent_title(request),
                request.description.clone().filter(|d| !d.is_empty()),
                Some(leading),
                &p,
            ))
            .child(
                div()
                    .id("plugin-consent-lines")
                    .debug_selector(|| "plugin-consent-lines".to_owned())
                    .flex_shrink(1.0)
                    .w_full()
                    .min_w_0()
                    .overflow_y_scroll()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .w_full()
                            .min_w_0()
                            .gap(px(space::S))
                            .p(px(space::M))
                            .children(lines),
                    ),
            )
            .child(dialog_actions(vec![
                ring(
                    selected == Some(ConsentButton::Cancel),
                    p.form_accent,
                    PushButton::new("plugin-consent-cancel", "Cancel", &p)
                        .on_click(cx.listener(|view, _, _, cx| view.answer(false, cx)))
                        .into_any_element(),
                ),
                ring(
                    selected == Some(ConsentButton::Install),
                    p.form_accent,
                    PushButton::new("plugin-consent-confirm", button, &p)
                        .kind(ButtonKind::Primary)
                        .disabled(request.changed)
                        .on_click(cx.listener(|view, _, _, cx| view.answer(true, cx)))
                        .into_any_element(),
                ),
            ]));
        dialog_frame(
            "plugin-consent",
            dialog::WIDTH_M,
            dialog::PAD,
            None,
            &p,
            content.into_any_element(),
            |_, _, _| {},
        )
    }
}

pub fn settings_consent(
    host: &Arc<dyn crate::host::UiHost>,
    p: Palette,
    window: &mut Window,
    cx: &mut gpui::App,
) -> Option<AnyElement> {
    let plugins = host.plugins()?;
    let request = plugins
        .consent()
        .filter(|r| r.owner == ConsentOwner::Settings)?;
    let key = gpui::SharedString::from(format!("plugin-consent:{}:{}", request.id, request.hash));
    let view = window.use_keyed_state(key, cx, move |window, cx| {
        ConsentView::new(plugins, request, p, window, cx)
    });
    Some(view.into_any_element())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(key: &str, shift: bool) -> ConsentPress {
        ConsentPress {
            key: key.into(),
            shift,
            ..ConsentPress::default()
        }
    }

    #[test]
    fn words_and_titles() {
        let request = ConsentRequest {
            id: 1,
            name: "notes".into(),
            hash: "h".into(),
            owner: ConsentOwner::Settings,
            title: Some("Notes".into()),
            icon: None,
            description: None,
            verb: ConsentVerb::TurnOn,
            changed: false,
            lines: Vec::new(),
        };
        assert_eq!(consent_title(&request), "Turn on Notes?");
        assert_eq!(consent_words(ConsentVerb::TurnOn).1, "Turn On");
        assert_eq!(consent_words(ConsentVerb::Update), ("Update", "Update"));
    }

    #[test]
    fn keys_cycle_with_tab_and_press_with_space_once() {
        let fresh = ConsentKeys::default();
        let (s, p) = consent_key_down(fresh, &press("Tab", false), true);
        assert_eq!((s.selected, p), (Some(ConsentButton::Cancel), None));
        let (s, _) = consent_key_down(s, &press("Tab", false), true);
        assert_eq!(s.selected, Some(ConsentButton::Install));
        let (s2, _) = consent_key_down(fresh, &press("Tab", true), true);
        assert_eq!(s2.selected, Some(ConsentButton::Install));
        let (held, pressed) = consent_key_down(s, &press(" ", false), true);
        assert_eq!(pressed, Some(ConsentButton::Install));
        assert_eq!(consent_key_down(held, &press(" ", false), true).1, None);
        let released = consent_key_up(held, " ");
        assert!(!released.space_down);
        assert_eq!(consent_key_down(s, &press(" ", false), false).1, None);
        assert_eq!(
            consent_key_down(fresh, &press("Escape", false), true).1,
            Some(ConsentButton::Cancel)
        );
        assert_eq!(
            consent_key_down(fresh, &press("Escape", true), true).1,
            None
        );
        let meta = ConsentPress {
            meta: true,
            ..press("Escape", false)
        };
        assert_eq!(consent_key_down(fresh, &meta, true).1, None);
        let (only, _) = consent_key_down(s, &press("Tab", false), false);
        assert_eq!(only.selected, Some(ConsentButton::Cancel));
    }
}
