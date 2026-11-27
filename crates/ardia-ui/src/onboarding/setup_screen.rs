use ardia_state::Action;
use ardia_state::actions::ProfilePatch;
use ardia_state::model::TabLayout;
use ardia_state::settings::SettingsPatch;
use ardia_theme::ProfileColor;
use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, SharedString, Styled,
    Subscription, Window, div, img, prelude::*,
};

use super::OnboardingWindowView;
use super::flow::{QuestionId, Step};
use super::parts::{self, BUTTON_HEIGHT};
use super::setup_code::{self, SetupChoices};
use super::source::app_icon;
use crate::primitives::icons::Icon;
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput, focus_input};
use crate::scale::px;

pub const CODE_FIELD_HEIGHT: f32 = 44.0;
pub const LINES_CARD_WIDTH: f32 = 260.0;

pub enum SetupCode {
    Entering {
        input: Entity<TextInput>,
        error: Option<&'static str>,
        _subscription: Subscription,
    },
    Applied(Vec<String>),
}

impl OnboardingWindowView {
    pub(crate) fn open_setup_code(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let ink = self.ink();
        let input = cx.new(|cx| {
            let mut input = TextInput::new(format!("{}…", setup_code::SETUP_CODE_PREFIX), cx);
            input.set_style(
                InputStyle {
                    text: ink.title,
                    placeholder: ink.steps,
                    caret: ink.title,
                    selection: ink.tile_border_selected,
                    font_size: 13.0,
                    weight: FontWeight::NORMAL,
                },
                cx,
            );
            input
        });
        let subscription = cx.subscribe_in(
            &input,
            window,
            |this, input, event: &InputEvent, window, cx| match event {
                InputEvent::Changed { .. } => {
                    if let Some(SetupCode::Entering { error, .. }) = &mut this.setup_code {
                        *error = None;
                    }
                    cx.notify();
                }
                InputEvent::Submit(_) if !input.read(cx).text().trim().is_empty() => {
                    this.apply_setup_code(window, cx);
                }
                _ => {}
            },
        );
        focus_input(&input, window, cx);
        self.setup_code = Some(SetupCode::Entering {
            input,
            error: None,
            _subscription: subscription,
        });
        cx.notify();
    }

    pub(crate) fn close_setup_code(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.setup_code = None;
        window.focus(&self.focus_handle_of(), cx);
        cx.notify();
    }

    pub(crate) fn apply_setup_code(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(SetupCode::Entering { input, .. }) = &self.setup_code else {
            return;
        };
        let text = input.read(cx).text().to_owned();
        match setup_code::decode(&text) {
            Ok(choices) => {
                self.apply_choices(&choices);
                let lines = setup_code::describe(&choices);
                self.adopt_choices(&choices, lines.clone());
                self.setup_code = Some(SetupCode::Applied(lines));
                window.focus(&self.focus_handle_of(), cx);
            }
            Err(problem) => {
                if let Some(SetupCode::Entering { error, .. }) = &mut self.setup_code {
                    *error = Some(problem);
                }
            }
        }
        cx.notify();
    }

    fn apply_choices(&mut self, choices: &SetupChoices) {
        let mut settings = choices.settings.clone();
        if let Some(layout) = settings
            .remove("tabLayout")
            .and_then(|v| serde_json::from_value::<TabLayout>(v).ok())
        {
            self.host.dispatch(Action::SetTabLayout {
                window: None,
                layout,
            });
            if let Some(window) = self.target.clone() {
                self.host.dispatch(Action::SetTabLayout {
                    window: Some(window),
                    layout,
                });
            }
        }
        if !settings.is_empty() {
            self.host.dispatch(Action::UpdateSettings {
                patch: SettingsPatch(settings.into_iter().collect()),
                from_sync: false,
            });
        }
        if let Some(color) = choices
            .color
            .as_deref()
            .and_then(|key| ProfileColor::ALL.into_iter().find(|c| c.key() == key))
        {
            self.host.dispatch(Action::UpdateProfile {
                profile: self.profile(),
                patch: ProfilePatch {
                    color: Some(color),
                    theme: Some(None),
                    ..ProfilePatch::default()
                },
            });
        }
        let pins: Vec<String> = choices
            .pins
            .clone()
            .unwrap_or_default()
            .into_iter()
            .filter(|pin| super::copy::PINNABLE_SITES.iter().any(|s| s.id == pin))
            .collect();
        if !pins.is_empty() {
            self.pin_sites(&pins);
        }
        self.state = self.host.store().snapshot();
    }

    fn adopt_choices(&mut self, choices: &SetupChoices, lines: Vec<String>) {
        for key in choices.settings.keys() {
            self.flow.draft.remove(key);
            self.flow.baseline.remove(key);
        }
        if choices.color.is_some() {
            self.flow.color_baseline = None;
            self.look_baseline = None;
        }
        if let Some(preset) = choices
            .preset
            .as_deref()
            .and_then(super::flow::Source::from_key)
        {
            self.flow.preset = preset;
        }
        self.flow.source = None;
        self.flow.prefill_preset = false;
        if let Some(pins) = &choices.pins {
            self.flow.extras.pins = Some(pins.clone());
        }
        self.flow.picked.retain(|(q, _)| *q != QuestionId::Source);
        self.flow.picked.push((QuestionId::Source, lines));
        if !self.flow.redo {
            self.host.save_onboarding(crate::host::OnboardingRecord {
                completed: false,
                step: Some(self.flow.step.key().to_owned()),
                source: None,
                preset: Some(self.flow.preset.key().to_owned()),
            });
        }
    }

    pub(crate) fn setup_code_section(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let ink = self.ink();
        match self.setup_code.as_ref()? {
            SetupCode::Applied(_) => Some(super::screens::section_layout(
                "You're set up",
                Some(
                    "Ardia now looks the way you made it on ardia.dev. Search and privacy are still yours to choose, so those come next.",
                ),
                None,
                Vec::new(),
                &ink,
            )),
            SetupCode::Entering { input, error, .. } => {
                let input = input.clone();
                let error = *error;
                let focus_click = cx.listener(move |_, _: &gpui::ClickEvent, window, cx| {
                    focus_input(&input, window, cx)
                });
                let field_input = match self.setup_code.as_ref() {
                    Some(SetupCode::Entering { input, .. }) => input.clone(),
                    _ => return None,
                };
                let field = div()
                    .id("onboarding-setup-code-field")
                    .h(px(CODE_FIELD_HEIGHT))
                    .px(px(space::XL))
                    .rounded(px(radius::PANEL))
                    .bg(ink.row)
                    .when(error.is_some(), |this| {
                        this.border(px(1.)).border_color(ink.tile_border_selected)
                    })
                    .flex()
                    .items_center()
                    .font_family("Menlo")
                    .cursor_text()
                    .on_click(focus_click)
                    .child(div().flex_1().child(field_input));
                let note = div()
                    .text_size(px(12.))
                    .line_height(px(17.))
                    .text_color(if error.is_some() {
                        ink.title
                    } else {
                        ink.row_subtitle
                    })
                    .child(SharedString::from(error.unwrap_or(
                        "Search, privacy and default browser stay yours to pick here.",
                    )));
                Some(super::screens::section_layout(
                    "Have a setup code from ardia.dev?",
                    Some(
                        "Paste the code from the demo. It brings the layout, look and pinned apps you picked there.",
                    ),
                    None,
                    vec![field.into_any_element(), note.into_any_element()],
                    &ink,
                ))
            }
        }
    }

    pub(crate) fn setup_code_actions(&mut self, cx: &mut Context<Self>) -> Option<Vec<AnyElement>> {
        let ink = self.ink();
        match self.setup_code.as_ref()? {
            SetupCode::Applied(_) => {
                let go_on = self.listen(cx, |this, window, cx| {
                    this.setup_code = None;
                    let before = this.flow.section_index(&this.context());
                    this.flow.go_to(Step::SearchPrivacy, 0);
                    this.after_step(before, window, cx);
                });
                let review = self.listen(cx, |this, window, cx| {
                    this.setup_code = None;
                    let before = this.flow.section_index(&this.context());
                    this.flow.go_to(Step::Layout, 0);
                    this.after_step(before, window, cx);
                });
                Some(vec![
                    parts::primary_button(
                        "onboarding-setup-continue",
                        "Continue",
                        true,
                        false,
                        &ink,
                        go_on,
                    ),
                    parts::secondary_button(
                        "onboarding-setup-review",
                        "Review Each Step",
                        false,
                        &ink,
                        review,
                    ),
                ])
            }
            SetupCode::Entering { input, .. } => {
                let empty = input.read(cx).text().trim().is_empty();
                let back = self.listen(cx, |this, window, cx| this.close_setup_code(window, cx));
                let apply = self.listen(cx, |this, window, cx| this.apply_setup_code(window, cx));
                Some(vec![
                    parts::circle_button(
                        "onboarding-setup-back",
                        Icon::ChevronLeft,
                        12.,
                        &ink,
                        back,
                    ),
                    parts::primary_button(
                        "onboarding-setup-apply",
                        "Apply Code",
                        false,
                        empty,
                        &ink,
                        apply,
                    ),
                ])
            }
        }
    }

    pub(crate) fn setup_code_link(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let ink = self.ink();
        let open = self.listen(cx, |this, window, cx| this.open_setup_code(window, cx));
        div()
            .id("onboarding-setup-code-link")
            .debug_selector(|| "onboarding-setup-code-link".into())
            .ml_auto()
            .h(px(BUTTON_HEIGHT))
            .flex()
            .items_center()
            .cursor_pointer()
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(ink.subtitle)
            .hover(move |s| s.text_color(ink.title))
            .on_click(open)
            .child("Have a setup code?")
            .into_any_element()
    }

    pub(crate) fn setup_lines(&self, heading: &str, lines: &[String]) -> AnyElement {
        let ink = self.ink();
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(space::XXXL))
            .child(img(app_icon()).size(px(72.)))
            .child(
                div()
                    .w(px(LINES_CARD_WIDTH))
                    .p(px(space::XL))
                    .rounded(px(radius::SHEET))
                    .bg(ink.card)
                    .flex()
                    .flex_col()
                    .gap(px(space::M))
                    .child(
                        div()
                            .text_size(px(11.))
                            .line_height(px(14.))
                            .text_color(ink.subtitle)
                            .child(SharedString::from(heading.to_owned())),
                    )
                    .children(lines.iter().map(|line| {
                        div()
                            .flex()
                            .flex_row()
                            .items_start()
                            .gap(px(space::M))
                            .child(parts::check_ring(true, true, &ink))
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(px(12.))
                                    .line_height(px(17.))
                                    .text_color(ink.title)
                                    .child(SharedString::from(line.clone())),
                            )
                    })),
            )
            .into_any_element()
    }

    pub(crate) fn setup_code_preview(&self) -> Option<AnyElement> {
        match self.setup_code.as_ref()? {
            SetupCode::Applied(lines) => Some(self.setup_lines("From your code:", lines)),
            SetupCode::Entering { .. } => {
                let lines: Vec<String> =
                    setup_code::BRINGS.iter().map(|l| (*l).to_owned()).collect();
                Some(self.setup_lines("A code brings over:", &lines))
            }
        }
    }
}
