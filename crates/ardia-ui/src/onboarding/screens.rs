use std::collections::HashSet;

use ardia_state::omnibox::url::host_of;
use ardia_state::{BrowserState, WindowId};
use ardia_theme::ProfileColor;
use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, Context, FontWeight, IntoElement, ParentElement, SharedString, Styled, Window, div,
    img, prelude::*,
};
use serde_json::{Map, Value, json};

use super::OnboardingWindowView;
use super::copy::{self, Choice};
use super::flow::{self, QuestionId, Source};
use super::plugins_step;
use super::parts::{self, Ink, Segment, TILE_WIDTH};
use super::source::SourceTile;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::site_icons::site_icon;
use crate::primitives::theme_bridge::hsla;
use crate::scale::px;

const TABS_MORE: [&str; 4] = [
    "balancedTopApps",
    "peekModifier",
    "undoReopensClosedTab",
    "cmdClickCreatesTabGroup",
];

pub fn pinned_hosts(state: &BrowserState, window: &WindowId) -> HashSet<String> {
    let Some(w) = state.window(window.as_str()) else {
        return HashSet::new();
    };
    let in_pinned_group: HashSet<&str> = state
        .groups
        .values()
        .filter(|g| g.pinned && g.profile_id == w.profile_id)
        .flat_map(|g| g.tab_ids.iter().map(|id| id.as_str()))
        .collect();
    state
        .tabs
        .values()
        .filter(|t| {
            t.profile_id == w.profile_id
                && (t.pin.is_some() || in_pinned_group.contains(t.id.as_str()))
        })
        .map(|t| host_of(t.pinned_url.as_deref().unwrap_or(&t.url)))
        .filter(|h| !h.is_empty())
        .collect()
}

pub fn preselected_sites(visits: &[(String, u32)], pinned: &HashSet<String>) -> Vec<String> {
    let mut by_host: Vec<(String, u64)> = Vec::new();
    for (url, count) in visits {
        let host = host_of(url);
        if host.is_empty() {
            continue;
        }
        match by_host.iter_mut().find(|(h, _)| *h == host) {
            Some((_, total)) => *total += u64::from(*count),
            None => by_host.push((host, u64::from(*count))),
        }
    }
    let mut picks: Vec<(&str, u64)> = copy::PINNABLE_SITES
        .iter()
        .filter(|site| !pinned.contains(&host_of(site.url)))
        .map(|site| {
            let host = host_of(site.url);
            let total = by_host
                .iter()
                .find(|(h, _)| *h == host)
                .map_or(0, |(_, n)| *n);
            (site.id, total)
        })
        .filter(|(_, total)| *total >= 3)
        .collect();
    picks.sort_by_key(|pick| std::cmp::Reverse(pick.1));
    picks
        .into_iter()
        .take(4)
        .map(|(id, _)| id.to_owned())
        .collect()
}

pub fn ctrl_tab_answer(order: &str, view: &str) -> Option<&'static str> {
    if order == "recent" {
        Some("switcher")
    } else if view == "none" {
        Some("step")
    } else {
        None
    }
}

pub fn ctrl_tab_patch(answer: &str, view: &str) -> Map<String, Value> {
    if answer == "step" {
        flow::patch(&[
            ("tabSwitcherOrder", json!("inOrder")),
            ("tabSwitcherView", json!("none")),
        ])
    } else {
        let view = if view == "none" { "thumbnails" } else { view };
        flow::patch(&[
            ("tabSwitcherOrder", json!("recent")),
            ("tabSwitcherView", json!(view)),
        ])
    }
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

pub(crate) fn section_layout(
    title: &str,
    subtitle: Option<&str>,
    tag: Option<String>,
    body: Vec<AnyElement>,
    ink: &Ink,
) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(space::XXXL))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(space::ML))
                .child(parts::step_title(title, subtitle, ink))
                .when_some(tag, |this, tag| this.child(parts::tag(tag, ink))),
        )
        .when(!body.is_empty(), |this| {
            this.child(div().flex().flex_col().gap(px(space::XL)).children(body))
        })
        .into_any_element()
}

impl OnboardingWindowView {
    pub(crate) fn pick(&mut self, id: QuestionId, value: &'static str, cx: &mut Context<Self>) {
        let flow_cx = self.context();
        let (patch, live) = match id {
            QuestionId::Tabs => (flow::patch(&[("tabLayout", json!(value))]), true),
            QuestionId::Address => (flow::patch(&[("addressBar", json!(value))]), true),
            QuestionId::Cmdl => (flow::patch(&[("commandBarPlacement", json!(value))]), true),
            QuestionId::NewTab => (flow::patch(&[("newTabOpens", json!(value))]), false),
            QuestionId::NewTabPosition => (
                flow::patch(&[
                    ("newTabPosition", json!(value)),
                    (
                        "newTabButtonPosition",
                        json!(if value == "top" { "top" } else { "bottom" }),
                    ),
                ]),
                false,
            ),
            QuestionId::CtrlTab => {
                let view = self.flow.resolve_str("tabSwitcherView", &flow_cx);
                (ctrl_tab_patch(value, &view), true)
            }
            QuestionId::Tidy => {
                let current = self
                    .flow
                    .resolve_f64("cleanUpInactiveTabsAfterMinutes", &flow_cx);
                let minutes = if value == "keep" {
                    Value::Null
                } else {
                    json!(current.unwrap_or(copy::TIDY_AFTER[0].0))
                };
                (
                    flow::patch(&[("cleanUpInactiveTabsAfterMinutes", minutes)]),
                    false,
                )
            }
            QuestionId::Quit => (
                flow::patch(&[("restoreSession", json!(value == "true"))]),
                false,
            ),
            QuestionId::Windows => (
                flow::patch(&[("shareTabsAcrossWindows", json!(value == "true"))]),
                false,
            ),
            QuestionId::Appearance => (flow::patch(&[("appearance", json!(value))]), true),
            QuestionId::SiteColor => (
                flow::patch(&[("extendWebsiteColor", json!(value == "true"))]),
                true,
            ),
            QuestionId::Style => (flow::patch(&[("interfaceStyle", json!(value))]), true),
            QuestionId::Links => (
                flow::patch(&[("openLinksInLittleArdia", json!(value == "true"))]),
                false,
            ),
            QuestionId::Engine => (flow::patch(&[("searchEngine", json!(value))]), false),
            _ => return,
        };
        self.change(patch, live, cx);
    }

    fn radios(
        &mut self,
        id: QuestionId,
        prefix: &'static str,
        choices: &[Choice],
        current: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ink = self.ink();
        let key = self.section_key(id);
        if self.active_question() == Some(id) {
            let settled = super::mock::preview_for(prefix, current);
            self.mock_focus.settle(&key, settled);
        }
        let active = self.active_question() == Some(id);
        div()
            .flex()
            .flex_col()
            .gap(px(space::M))
            .children(choices.iter().map(|choice| {
                let value = choice.value;
                let preview = super::mock::preview_for(prefix, value);
                let chosen_key = key.clone();
                let click = self.listen(cx, move |this, _, cx| {
                    this.pick(id, value, cx);
                    this.mock_focus.choose(&chosen_key, preview);
                    cx.notify();
                });
                let hover = cx.listener(move |this, on: &bool, _, cx| {
                    if let Some(preview) = preview
                        && active
                    {
                        this.mock_focus.hover(preview, *on);
                        cx.notify();
                    }
                });
                div()
                    .id(SharedString::from(format!(
                        "onboarding-hover-{prefix}-{value}"
                    )))
                    .on_hover(hover)
                    .child(parts::option_radio(
                        SharedString::from(format!("onboarding-{prefix}-{value}")),
                        choice.title,
                        choice.subtitle,
                        choice.value == current,
                        &ink,
                        click,
                    ))
                    .into_any_element()
            }))
            .into_any_element()
    }

    fn toggle(
        &self,
        key: &'static str,
        title: &str,
        subtitle: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ink = self.ink();
        let on = self.flow.resolve_bool(key, &self.context());
        let click = self.listen(cx, move |this, _, cx| {
            this.change(flow::patch(&[(key, json!(!on))]), false, cx)
        });
        parts::option_check(
            SharedString::from(format!("onboarding-{key}")),
            None,
            title,
            subtitle,
            on,
            false,
            &ink,
            click,
        )
    }

    fn segments(
        &self,
        key: &'static str,
        options: Vec<(Value, String)>,
        live: bool,
        cx: &mut Context<Self>,
    ) -> Vec<Segment> {
        let current = self.flow.resolve(key, &self.context());
        options
            .into_iter()
            .map(|(value, title)| {
                let selected = value == current;
                let chosen = value;
                Segment {
                    image: None,
                    title,
                    selected,
                    on_click: self.listen(cx, move |this, _, cx| {
                        this.change(flow::patch(&[(key, chosen.clone())]), live, cx)
                    }),
                }
            })
            .collect()
    }

    pub(crate) fn section(&mut self, id: QuestionId, cx: &mut Context<Self>) -> AnyElement {
        let ink = self.ink();
        let fcx = self.context();
        let flow = &self.flow;
        match id {
            QuestionId::Source => self.source_section(cx),
            QuestionId::Tabs | QuestionId::Address | QuestionId::Cmdl => {
                let tag = Some(flow::layout_tag(flow, &fcx));
                let (title, subtitle, prefix, choices, current): (
                    String,
                    &str,
                    &str,
                    &[Choice],
                    String,
                ) = match id {
                    QuestionId::Address => (
                        "Where's the address bar?".into(),
                        "Your window changes as you pick.",
                        "address",
                        &copy::ADDRESS_CHOICES,
                        flow.resolve_str("addressBar", &fcx),
                    ),
                    QuestionId::Cmdl => {
                        let placement = flow.resolve_str("commandBarPlacement", &fcx);
                        (
                            "Where does ⌘L open?".into(),
                            "The command bar, for going anywhere.",
                            "cmdl",
                            &copy::CMDL_CHOICES,
                            if placement == "field" {
                                "field".into()
                            } else {
                                "centred".into()
                            },
                        )
                    }
                    _ => (
                        "Where do your tabs go?".into(),
                        "Your window changes as you pick.",
                        "tabs",
                        &copy::TAB_CHOICES,
                        flow.resolve_str("tabLayout", &fcx),
                    ),
                };
                let body = vec![self.radios(id, prefix, choices, &current, cx)];
                section_layout(&title, Some(subtitle), tag, body, &ink)
            }
            QuestionId::Color => self.color_section(cx),
            QuestionId::Style => {
                let style = flow.resolve_str("interfaceStyle", &fcx);
                let tint = flow.resolve_bool("glassTintWithTheme", &fcx);
                let amount = flow.resolve_f64("glassTintAmount", &fcx).unwrap_or(0.8);
                let mut body = vec![self.radios(id, "style", &copy::STYLE_CHOICES, &style, cx)];
                if style == "glass" {
                    let click = self.listen(cx, move |this, _, cx| {
                        this.change(
                            flow::patch(&[("glassTintWithTheme", json!(!tint))]),
                            true,
                            cx,
                        )
                    });
                    let mut glass = vec![parts::option_check(
                        "onboarding-glass-tint",
                        None,
                        "Tint the glass with your color",
                        "Buttons and fields take on your theme color",
                        tint,
                        false,
                        &ink,
                        click,
                    )];
                    if tint {
                        glass.push(self.slider(
                            "onboarding-tint-amount",
                            "Tint amount",
                            amount as f32,
                            None,
                            cx,
                            |fraction| {
                                flow::patch(&[(
                                    "glassTintAmount",
                                    json!((fraction as f64 * 100.0).round() / 100.0),
                                )])
                            },
                        ));
                    }
                    body.push(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(space::ML))
                            .children(glass)
                            .into_any_element(),
                    );
                }
                section_layout(
                    "Glass or classic?",
                    Some("Change it any time in Settings › Appearance."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::NewTab => {
                let current = flow.resolve_str("newTabOpens", &fcx);
                let body = vec![self.radios(id, "newtab", &copy::NEW_TAB_CHOICES, &current, cx)];
                section_layout(
                    "What does ⌘T open?",
                    Some("What you see when you open a tab."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::NewTabPosition => {
                let top = flow.resolve_str("tabLayout", &fcx) == "top";
                let choices = [
                    Choice {
                        value: "bottom",
                        title: if top { "On the right" } else { "At the bottom" },
                        subtitle: if top {
                            "After your other tabs, as in Dia"
                        } else {
                            "Under your other tabs, as in Dia"
                        },
                    },
                    Choice {
                        value: "top",
                        title: if top { "On the left" } else { "At the top" },
                        subtitle: if top {
                            "Before your other tabs, as in Arc"
                        } else {
                            "Above your other tabs, as in Arc"
                        },
                    },
                    Choice {
                        value: "nextToCurrent",
                        title: if top {
                            "Next to the current tab"
                        } else {
                            "Below the current tab"
                        },
                        subtitle: if top {
                            "Right after the tab you're on"
                        } else {
                            "Right under the tab you're on"
                        },
                    },
                ];
                let current = flow.resolve_str("newTabPosition", &fcx);
                let body = vec![self.radios(id, "newtabpos", &choices, &current, cx)];
                section_layout(
                    "Where do new tabs go?",
                    Some("Where a tab lands when you open it."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::CtrlTab => {
                let answer = ctrl_tab_answer(
                    &flow.resolve_str("tabSwitcherOrder", &fcx),
                    &flow.resolve_str("tabSwitcherView", &fcx),
                )
                .unwrap_or("");
                let body = vec![self.radios(id, "ctrltab", &copy::CTRL_TAB_CHOICES, answer, cx)];
                section_layout(
                    &format!("What does {} do?", copy::SWITCH_TABS_KEY),
                    Some("How you switch tabs from the keyboard."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::Tidy => {
                let tidy = flow.resolve_f64("cleanUpInactiveTabsAfterMinutes", &fcx);
                let current = if tidy.is_none() { "keep" } else { "tidy" };
                let mut body = vec![self.radios(id, "tidy", &copy::TIDY_CHOICES, current, cx)];
                if let Some(minutes) = tidy {
                    #[expect(
                        clippy::needless_collect,
                        reason = "options gains the current value before it is walked"
                    )]
                    let mut options: Vec<(Value, String)> = copy::TIDY_AFTER
                        .iter()
                        .map(|(value, title)| (json!(*value), tidy_label(*value, title)))
                        .collect();
                    if !copy::TIDY_AFTER.iter().any(|(value, _)| *value == minutes) {
                        options.push((json!(minutes), copy::duration_title(minutes)));
                    }
                    let options = options
                        .into_iter()
                        .map(|(value, title)| (normalize_number(value), title))
                        .collect();
                    let segments =
                        self.segments("cleanUpInactiveTabsAfterMinutes", options, false, cx);
                    body.push(parts::option_row(
                        "onboarding-tidy-after",
                        "Tidy after",
                        segments,
                        &ink,
                    ));
                }
                section_layout(
                    "What about old tabs?",
                    Some("Tabs you opened and forgot."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::Quit => {
                let current = value_text(&flow.resolve("restoreSession", &fcx));
                let body = vec![self.radios(id, "quit", &copy::QUIT_CHOICES, &current, cx)];
                section_layout(
                    "When you quit and come back?",
                    Some("What Ardia opens to."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::Windows => {
                let current = value_text(&flow.resolve("shareTabsAcrossWindows", &fcx));
                let body = vec![self.radios(id, "windows", &copy::WINDOW_CHOICES, &current, cx)];
                section_layout(
                    "Two windows, same tabs?",
                    Some("How windows share what's open."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::TabsMore => {
                let peek: Vec<(Value, String)> = copy::PEEK_WITH
                    .iter()
                    .map(|(v, t)| (json!(v), (*t).to_owned()))
                    .collect();
                let segments = self.segments("peekModifier", peek, false, cx);
                let body = vec![
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(space::M))
                        .child(self.toggle(
                            "balancedTopApps",
                            "Top Apps grow with the sidebar",
                            "Up to four across, as in Arc",
                            cx,
                        ))
                        .child(parts::option_row(
                            "onboarding-peek-with",
                            "Peek a link with",
                            segments,
                            &ink,
                        ))
                        .child(self.toggle(
                            "undoReopensClosedTab",
                            "⌘Z reopens closed tabs",
                            "Outside text fields, as in Arc",
                            cx,
                        ))
                        .child(self.toggle(
                            "cmdClickCreatesTabGroup",
                            "⌘-click on a link makes a tab group",
                            "Keeps related tabs together",
                            cx,
                        ))
                        .into_any_element(),
                ];
                section_layout(
                    "A few more tab habits",
                    Some("Small things Arc and Dia do differently."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::Appearance => {
                let current = flow.resolve_str("appearance", &fcx);
                let body =
                    vec![self.radios(id, "appearance", &copy::APPEARANCE_CHOICES, &current, cx)];
                section_layout(
                    "Light or dark?",
                    Some("Incognito windows are always dark."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::Frame => {
                let frame = frame_of(flow, &fcx);
                let mut cards: Vec<AnyElement> = copy::FRAME_CHOICES
                    .iter()
                    .map(|(value, title, subtitle)| {
                        let value = *value;
                        let click = self.listen(cx, move |this, _, cx| {
                            this.change(
                                flow::patch(&[
                                    ("pageFrame", json!(value)),
                                    ("borderlessMode", json!(false)),
                                ]),
                                true,
                                cx,
                            )
                        });
                        parts::option_radio(
                            SharedString::from(format!("onboarding-frame-{value}")),
                            title,
                            subtitle,
                            frame == value,
                            &ink,
                            click,
                        )
                    })
                    .collect();
                cards.push(
                    div()
                        .mt(px(space::M))
                        .child(self.slider(
                            "onboarding-frame-thickness",
                            "Thickness",
                            (frame / copy::FRAME_MAX) as f32,
                            Some(format!("{frame} pt")),
                            cx,
                            |fraction| {
                                flow::patch(&[
                                    (
                                        "pageFrame",
                                        json!((fraction as f64 * copy::FRAME_MAX).round()),
                                    ),
                                    ("borderlessMode", json!(false)),
                                ])
                            },
                        ))
                        .into_any_element(),
                );
                let body = vec![
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(space::ML))
                        .children(cards)
                        .into_any_element(),
                ];
                section_layout(
                    "How much frame?",
                    Some(
                        "The room between the page and the window. Change it any time in Settings › Appearance.",
                    ),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::SiteColor => {
                let current = value_text(&flow.resolve("extendWebsiteColor", &fcx));
                let body =
                    vec![self.radios(id, "sitecolor", &copy::SITE_COLOR_CHOICES, &current, cx)];
                section_layout(
                    "Let sites tint the tab bar?",
                    Some("Many sites have a color of their own."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::LookMore => {
                let bar: Vec<(Value, String)> = copy::BOOKMARKS_BAR
                    .iter()
                    .map(|(v, t)| (json!(v), (*t).to_owned()))
                    .collect();
                let segments = self.segments("bookmarksBar", bar, false, cx);
                let choices = self.host.app_icons();
                let icons = (choices.len() > 1).then(|| {
                    let current = self.host.current_app_icon().unwrap_or_else(|| choices[0].id.clone());
                    let chosen = self.flow.extras.app_icon.clone().unwrap_or(current);
                    let segments: Vec<Segment> = choices
                        .into_iter()
                        .map(|choice| {
                            let id = choice.id.clone();
                            Segment {
                                image: choice.preview,
                                title: choice.name,
                                selected: chosen == choice.id,
                                on_click: self.listen(cx, move |this, _, cx| {
                                    this.flow.extras.app_icon = Some(id.clone());
                                    cx.notify();
                                }),
                            }
                        })
                        .collect();
                    parts::option_row("onboarding-app-icon", "App icon", segments, &ink)
                });
                let body = vec![
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(space::M))
                        .children(icons)
                        .child(self.toggle(
                            "hideToolbarWhileScrolling",
                            "Hide toolbar while scrolling",
                            "Scroll up to bring it back",
                            cx,
                        ))
                        .child(parts::option_row(
                            "onboarding-bookmarks-bar",
                            "Bookmarks bar",
                            segments,
                            &ink,
                        ))
                        .into_any_element(),
                ];
                section_layout(
                    "A few finishing touches",
                    Some("All of these live in Settings too."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::Engine => self.engine_section(cx),
            QuestionId::Crash => {
                let share = self.share();
                let click = self.listen(cx, move |this, _, cx| {
                    this.flow.extras.share = Some(!share);
                    cx.notify();
                });
                let body = vec![parts::option_check(
                    "onboarding-share",
                    Some(parts::card_symbol("stethoscope", &ink)),
                    copy::SHARING_TOGGLE,
                    copy::SHARING_ROW,
                    share,
                    false,
                    &ink,
                    click,
                )];
                section_layout(copy::SHARING_TITLE, None, None, body, &ink)
            }
            QuestionId::Pins => self.pins_section(cx),
            QuestionId::Default => self.default_section(cx),
            QuestionId::Links => {
                let current = value_text(&flow.resolve("openLinksInLittleArdia", &fcx));
                let body = vec![self.radios(id, "links", &copy::LINK_CHOICES, &current, cx)];
                section_layout(
                    "Where do links from other apps open?",
                    Some("From Mail, Slack, Notes and the rest."),
                    None,
                    body,
                    &ink,
                )
            }
            QuestionId::Plugins => self.plugins_section(cx),
            QuestionId::Outro => self.outro_section(cx),
        }
    }

    fn slider(
        &self,
        id: &'static str,
        label: &str,
        value: f32,
        trailing: Option<String>,
        cx: &mut Context<Self>,
        to_patch: impl Fn(f32) -> Map<String, Value> + 'static,
    ) -> AnyElement {
        let ink = self.ink();
        let p = self.look.p;
        let weak = cx.weak_entity();
        div()
            .flex()
            .flex_col()
            .gap(px(space::S))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .text_size(px(12.))
                    .text_color(ink.subtitle)
                    .child(SharedString::from(label.to_owned()))
                    .children(trailing.map(|text| {
                        div()
                            .w(px(40.))
                            .text_right()
                            .child(SharedString::from(text))
                    })),
            )
            .child(div().debug_selector(move || id.into()).child(
                crate::primitives::controls::Slider::new(id, value.clamp(0.0, 1.0), &p).on_change(
                    move |fraction, _, cx| {
                        let patch = to_patch(fraction);
                        let _ = weak.update(cx, |this, cx| this.change(patch, true, cx));
                    },
                ),
            ))
            .into_any_element()
    }

    pub(crate) fn share(&self) -> bool {
        self.flow.extras.share.unwrap_or(if self.flow.redo {
            self.host.sharing()
        } else {
            true
        })
    }

    fn source_section(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if let Some(page) = self.setup_code_section(cx) {
            return page;
        }
        let ink = self.ink();
        let found: Vec<SourceTile> = self.tiles.iter().filter(|t| t.found).cloned().collect();
        let others: Vec<SourceTile> = self.tiles.iter().filter(|t| !t.found).cloned().collect();
        let selected = self.flow.source;
        let mut body = Vec::new();
        if !found.is_empty() {
            body.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::M))
                    .child(parts::section_label("Found on this Mac", &ink))
                    .child(self.source_grid(&found, selected, false, cx))
                    .into_any_element(),
            );
        }
        body.push(
            div()
                .flex()
                .flex_col()
                .gap(px(space::M))
                .child(parts::section_label(
                    if found.is_empty() {
                        "Browsers"
                    } else {
                        "Others"
                    },
                    &ink,
                ))
                .child(self.source_grid(&others, selected, true, cx))
                .into_any_element(),
        );
        section_layout(
            "Where are you coming from?",
            Some("Ardia sets itself up the way you're used to."),
            None,
            body,
            &ink,
        )
    }

    fn source_grid(
        &mut self,
        tiles: &[SourceTile],
        selected: Option<Source>,
        fresh: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ink = self.ink();
        #[expect(
            clippy::needless_collect,
            reason = "items gains the fresh-start tile before it is walked"
        )]
        let mut items: Vec<(Source, String, Option<SourceTile>)> = tiles
            .iter()
            .map(|t| (t.source, t.name.clone(), Some(t.clone())))
            .collect();
        if fresh {
            items.push((Source::Fresh, "Starting fresh".to_owned(), None));
        }
        div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(space::M))
            .children(items.into_iter().map(|(source, name, tile)| {
                let click = self.listen(cx, move |this, _, cx| {
                    this.flow.choose_source(Some(source));
                    this.save_source();
                    cx.notify();
                });
                let ring = if selected == Some(source) {
                    let image = tile.as_ref().and_then(|t| self.tile_image(t));
                    self.ring_of(image)
                } else {
                    None
                };
                parts::ringed_tile(
                    SharedString::from(format!("onboarding-source-{}", source.key())),
                    &name,
                    TILE_WIDTH,
                    super::source::SOURCE_TILE_HEIGHT,
                    selected == Some(source),
                    ring,
                    self.source_tile_content(tile.as_ref(), &ink),
                    &ink,
                    click,
                )
            }))
            .into_any_element()
    }

    fn save_source(&self) {
        if self.flow.redo {
            return;
        }
        self.host.save_onboarding(crate::host::OnboardingRecord {
            completed: false,
            step: Some(self.flow.step.key().to_owned()),
            source: self.flow.source.map(|s| s.key().to_owned()),
            preset: Some(self.flow.preset.key().to_owned()),
        });
    }

    fn color_section(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let ink = self.ink();
        let profile = self.profile();
        let chosen = self
            .state
            .profile(profile.as_str())
            .map(|p| p.color.preset());
        let swatches = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(space::XS))
            .children(ProfileColor::ALL.into_iter().map(|color| {
                let selected = chosen == Some(color);
                let click = self.listen(cx, move |this, _, cx| this.preview_color(color, cx));
                div()
                    .id(SharedString::from(format!(
                        "onboarding-color-{}",
                        color.key()
                    )))
                    .size(px(32.))
                    .rounded_full()
                    .p(px(3.))
                    .border(px(if selected { 2. } else { 0. }))
                    .border_color(ink.title)
                    .cursor_pointer()
                    .on_click(click)
                    .child(
                        div()
                            .size_full()
                            .rounded_full()
                            .bg(hsla(color.spec().swatch)),
                    )
            }));
        let editor = self.theme_editor_card(cx);
        let body = vec![
            div()
                .flex()
                .flex_col()
                .gap(px(space::XXXL))
                .child(swatches)
                .children(editor)
                .into_any_element(),
        ];
        section_layout(
            "Pick a color",
            Some("It tints the sidebar and the window."),
            None,
            body,
            &ink,
        )
    }

    fn engine_section(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let ink = self.ink();
        let fcx = self.context();
        let current = self.flow.resolve_str("searchEngine", &fcx);
        #[expect(
            clippy::needless_collect,
            reason = "the collect ends the borrow of self before the &mut self and cx calls below"
        )]
        let engines: Vec<_> = self
            .state
            .search_engines()
            .into_iter()
            .filter(|e| copy::ENGINES.contains(&e.id.as_str()) || e.id == current)
            .collect();
        let dark = self.look.dark;
        let grid = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(space::M))
            .children(engines.into_iter().map(|engine| {
                let id: &'static str = copy::ENGINES
                    .iter()
                    .find(|e| **e == engine.id)
                    .copied()
                    .unwrap_or("google");
                let url = format!("https://{}", engine.host());
                let logo = site_logo(&url, 18., dark, &ink);
                let known = copy::ENGINES.contains(&engine.id.as_str());
                let click = self.listen(cx, move |this, _, cx| {
                    if known {
                        this.pick(QuestionId::Engine, id, cx)
                    }
                });
                parts::select_tile(
                    SharedString::from(format!("onboarding-engine-{}", engine.id)),
                    &engine.name,
                    TILE_WIDTH,
                    64.,
                    engine.id == current,
                    logo,
                    &ink,
                    click,
                )
            }))
            .into_any_element();
        section_layout(
            "Search with what?",
            Some("For anything that isn't a website."),
            None,
            vec![grid],
            &ink,
        )
    }

    pub(crate) fn chosen_pins(&self) -> Vec<String> {
        if let Some(pins) = &self.flow.extras.pins {
            return pins.clone();
        }
        let pinned = self
            .target
            .as_ref()
            .map(|w| pinned_hosts(&self.state, w))
            .unwrap_or_default();
        let profile = self.profile();
        let visits: Vec<(String, u32)> = self
            .state
            .history_of(&profile)
            .map(|h| h.entries().map(|e| (e.url.clone(), e.visits)).collect())
            .unwrap_or_default();
        preselected_sites(&visits, &pinned)
    }

    fn pins_section(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let ink = self.ink();
        let selected = self.chosen_pins();
        let dark = self.look.dark;
        let grid = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(space::M))
            .children(copy::PINNABLE_SITES.iter().map(|site| {
                let on = selected.iter().any(|s| s == site.id);
                let id = site.id;
                let current = selected.clone();
                let click = self.listen(cx, move |this, _, cx| {
                    let mut pins = current.clone();
                    if pins.iter().any(|p| p == id) {
                        pins.retain(|p| p != id);
                    } else {
                        pins.push(id.to_owned());
                    }
                    this.flow.extras.pins = Some(pins);
                    cx.notify();
                });
                let logo = div()
                    .opacity(if on { 1.0 } else { 0.7 })
                    .child(site_logo(site.url, 22., dark, &ink))
                    .into_any_element();
                parts::select_tile(
                    SharedString::from(format!("onboarding-pin-{}", site.id)),
                    site.title,
                    80.,
                    70.,
                    on,
                    logo,
                    &ink,
                    click,
                )
            }))
            .into_any_element();
        section_layout(
            "Keep your favorite apps handy",
            Some("Pin the apps you use most. They stay put when you open Ardia."),
            None,
            vec![grid],
            &ink,
        )
    }

    fn default_section(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let ink = self.ink();
        let system = self.system;
        let redo = self.flow.redo;
        let extras = self.flow.extras.clone();
        let set_default = extras.set_default.unwrap_or(true);
        let trial = !redo && extras.trial.unwrap_or(false);
        let dock = extras.dock.unwrap_or(true);
        let login = extras.login.unwrap_or(system.login_enabled);
        let default_on = system.is_default || set_default;
        let toggle_default = self.listen(cx, move |this, _, cx| {
            if default_on {
                this.flow.extras.set_default = Some(false);
                this.flow.extras.trial = Some(!redo);
            } else {
                this.flow.extras.set_default = Some(true);
            }
            cx.notify();
        });
        let mut body = vec![parts::option_check(
            "onboarding-default",
            Some(parts::card_symbol("globe", &ink)),
            "Set Ardia as default browser",
            if system.is_default {
                "Ardia is already your default browser"
            } else {
                "Open links and web pages in Ardia"
            },
            default_on,
            system.is_default,
            &ink,
            toggle_default,
        )];
        if !default_on && !redo {
            let click = self.listen(cx, move |this, _, cx| {
                this.flow.extras.trial = Some(!trial);
                cx.notify();
            });
            body.push(parts::option_check(
                "onboarding-trial",
                Some(parts::card_symbol("calendar", &ink)),
                "Try it for seven days",
                "We'll check in to make sure you love it.",
                trial,
                false,
                &ink,
                click,
            ));
        }
        if system.dock_available && !system.in_dock {
            let click = self.listen(cx, move |this, _, cx| {
                this.flow.extras.dock = Some(!dock);
                cx.notify();
            });
            body.push(parts::option_check(
                "onboarding-dock",
                Some(parts::card_symbol("dock.rectangle", &ink)),
                "Add Ardia to Dock",
                "Quick access whenever you need it",
                dock,
                false,
                &ink,
                click,
            ));
        }
        let click = self.listen(cx, move |this, _, cx| {
            this.flow.extras.login = Some(!login);
            cx.notify();
        });
        body.push(parts::option_check(
            "onboarding-login",
            Some(parts::card_symbol("power", &ink)),
            "Open Ardia at login",
            "Ready when you sign in",
            login,
            false,
            &ink,
            click,
        ));
        let body = vec![
            div()
                .flex()
                .flex_col()
                .gap(px(space::M))
                .children(body)
                .into_any_element(),
        ];
        section_layout(
            "Make Ardia your default?",
            Some("Links from everywhere open here."),
            None,
            body,
            &ink,
        )
    }

    pub(crate) fn outro_shortcuts(&self) -> Vec<(String, &'static str)> {
        let mut shown: Vec<String> = Vec::new();
        copy::OUTRO_COMMANDS
            .iter()
            .filter_map(|(command, label)| {
                let keys = crate::keybindings::hint(&self.state, command)?;
                if shown.contains(&keys) {
                    return None;
                }
                shown.push(keys.clone());
                Some((keys, *label))
            })
            .collect()
    }

    fn outro_section(&mut self, _cx: &mut Context<Self>) -> AnyElement {
        let ink = self.ink();
        let rows = div()
            .flex()
            .flex_col()
            .gap(px(space::ML))
            .children(self.outro_shortcuts().into_iter().map(|(keys, label)| {
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(space::L))
                    .child(key_cap(&keys, &ink))
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(ink.subtitle)
                            .child(label),
                    )
            }))
            .into_any_element();
        section_layout(
            "Welcome to your new\nhome on the internet",
            Some("Everything you set up is saved. Change any of it later in Settings."),
            None,
            vec![rows],
            &ink,
        )
    }

    pub(crate) fn key_forward(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let fcx = self.context();
        match self.flow.current(&fcx) {
            Some(QuestionId::Source) if self.flow.source.is_none() => {}
            Some(QuestionId::Pins) => self.skip(true, window, cx),
            Some(QuestionId::Crash | QuestionId::Default) => self.skip(false, window, cx),
            Some(QuestionId::Outro) | None => {}
            Some(_) => self.forward(window, cx),
        }
    }

    pub(crate) fn forward(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let fcx = self.context();
        let Some(id) = self.flow.current(&fcx) else {
            return;
        };
        let flow = &self.flow;
        let s = |key: &str| flow.resolve_str(key, &fcx);
        let (patch, picked): (Map<String, Value>, Vec<String>) = match id {
            QuestionId::Source => {
                let Some(source) = flow.source else {
                    return;
                };
                let picked = if source == Source::Fresh {
                    vec!["Starting fresh".to_owned()]
                } else {
                    vec![format!(
                        "Coming from {}",
                        self.tiles
                            .iter()
                            .find(|t| t.source == source)
                            .map_or(source.name(), |t| t.name.as_str())
                    )]
                };
                (flow.source_patch(&fcx), picked)
            }
            QuestionId::Tabs => {
                let top = s("tabLayout") == "top";
                (
                    flow::pick(flow, &["tabLayout"], &fcx),
                    vec![
                        if top {
                            "Tabs along the top"
                        } else {
                            "Tabs in the sidebar"
                        }
                        .to_owned(),
                    ],
                )
            }
            QuestionId::Color => {
                let profile = self.profile();
                let picked = self
                    .state
                    .profile(profile.as_str())
                    .map(|p| (p.color.preset().spec().name, p.theme.is_some()))
                    .map(|(name, edited)| {
                        if edited {
                            vec![format!("{name} theme, edited")]
                        } else {
                            vec![format!("{name} theme")]
                        }
                    })
                    .unwrap_or_default();
                (Map::new(), picked)
            }
            QuestionId::Style => {
                let classic = s("interfaceStyle") == "classic";
                let tint = flow.resolve_bool("glassTintWithTheme", &fcx);
                let amount = flow.resolve_f64("glassTintAmount", &fcx).unwrap_or(0.8);
                ardia_telemetry::counts::count(if classic {
                    "onboarding_classic_picks"
                } else {
                    "onboarding_glass_picks"
                });
                if !classic && tint {
                    ardia_telemetry::counts::count("onboarding_tinted_glass_picks");
                }
                let picked = if classic {
                    vec!["Classic style".to_owned()]
                } else if tint {
                    vec![format!("Glass tinted {} %", (amount * 100.0).round())]
                } else {
                    Vec::new()
                };
                (
                    flow::pick(
                        flow,
                        &["interfaceStyle", "glassTintWithTheme", "glassTintAmount"],
                        &fcx,
                    ),
                    picked,
                )
            }
            QuestionId::Address => {
                let sidebar = s("addressBar") == "sidebar";
                (
                    flow::pick(flow, &["addressBar"], &fcx),
                    vec![
                        if sidebar {
                            "Address in the sidebar"
                        } else {
                            "Address in the toolbar"
                        }
                        .to_owned(),
                    ],
                )
            }
            QuestionId::Cmdl => {
                let centred = s("commandBarPlacement") != "field";
                (
                    flow::pick(flow, &["commandBarPlacement"], &fcx),
                    vec![
                        if centred {
                            "⌘L opens in the center"
                        } else {
                            "⌘L opens under the address"
                        }
                        .to_owned(),
                    ],
                )
            }
            QuestionId::NewTab => {
                let bar = s("newTabOpens") == "commandBar";
                (
                    flow::pick(flow, &["newTabOpens"], &fcx),
                    vec![
                        if bar {
                            "⌘T opens the command bar"
                        } else {
                            "⌘T opens the New Tab page"
                        }
                        .to_owned(),
                    ],
                )
            }
            QuestionId::NewTabPosition => (
                flow::pick(flow, &["newTabPosition", "newTabButtonPosition"], &fcx),
                Vec::new(),
            ),
            QuestionId::CtrlTab => {
                let picked = match ctrl_tab_answer(&s("tabSwitcherOrder"), &s("tabSwitcherView")) {
                    Some("step") => {
                        vec![format!("{} steps through your tabs", copy::SWITCH_TABS_KEY)]
                    }
                    Some(_) => vec![format!(
                        "{} opens the recent tabs switcher",
                        copy::SWITCH_TABS_KEY
                    )],
                    None => Vec::new(),
                };
                (
                    flow::pick(flow, &["tabSwitcherOrder", "tabSwitcherView"], &fcx),
                    picked,
                )
            }
            QuestionId::Tidy => {
                let tidy = flow.resolve_f64("cleanUpInactiveTabsAfterMinutes", &fcx);
                let picked = match tidy {
                    None => "Old tabs stay until you close them".to_owned(),
                    Some(minutes) => format!(
                        "Old tabs tidy up after {}",
                        tidy_label(minutes, copy::duration_title(minutes).as_str())
                    ),
                };
                (
                    flow::pick(flow, &["cleanUpInactiveTabsAfterMinutes"], &fcx),
                    vec![picked],
                )
            }
            QuestionId::Quit => {
                let restore = flow.resolve_bool("restoreSession", &fcx);
                (
                    flow::pick(flow, &["restoreSession"], &fcx),
                    if restore {
                        Vec::new()
                    } else {
                        vec!["Ardia starts fresh each launch".to_owned()]
                    },
                )
            }
            QuestionId::Windows => {
                let shared = flow.resolve_bool("shareTabsAcrossWindows", &fcx);
                (
                    flow::pick(flow, &["shareTabsAcrossWindows"], &fcx),
                    if shared {
                        vec!["Windows share their tabs".to_owned()]
                    } else {
                        Vec::new()
                    },
                )
            }
            QuestionId::TabsMore => (flow::touched_or_preset(flow, &TABS_MORE, &fcx), Vec::new()),
            QuestionId::Appearance => {
                let label = match s("appearance").as_str() {
                    "light" => "always light",
                    "dark" => "always dark",
                    _ => "automatic",
                };
                (
                    flow::pick(flow, &["appearance"], &fcx),
                    vec![format!("Appearance {label}")],
                )
            }
            QuestionId::Frame => (
                flow::pick(flow, &["pageFrame", "borderlessMode"], &fcx),
                copy::frame_picked(frame_of(flow, &fcx)),
            ),
            QuestionId::SiteColor => (flow::pick(flow, &["extendWebsiteColor"], &fcx), Vec::new()),
            QuestionId::LookMore => (
                {
                    if let (Some(chosen), Some(current)) = (flow.extras.app_icon.clone(), self.host.current_app_icon())
                        && chosen != current
                    {
                        self.host.set_app_icon(chosen);
                    }
                    flow::pick(flow, &["hideToolbarWhileScrolling", "bookmarksBar"], &fcx)
                },
                Vec::new(),
            ),
            QuestionId::Engine => {
                let current = s("searchEngine");
                let name = self
                    .state
                    .search_engines()
                    .into_iter()
                    .find(|e| e.id == current)
                    .map_or_else(|| "your engine".to_owned(), |e| e.name);
                (
                    flow::pick(flow, &["searchEngine"], &fcx),
                    vec![format!("Search with {name}")],
                )
            }
            QuestionId::Crash => {
                let share = self.share();
                if share != self.host.sharing() || !self.flow.redo {
                    let source = if self.flow.redo {
                        ardia_telemetry::SharingSource::Settings
                    } else {
                        ardia_telemetry::SharingSource::Onboarding
                    };
                    self.host.set_sharing(share, source, None);
                }
                (
                    Map::new(),
                    if share {
                        vec!["Sharing crash reports".to_owned()]
                    } else {
                        Vec::new()
                    },
                )
            }
            QuestionId::Pins => {
                let pins = self.chosen_pins();
                if !pins.is_empty() {
                    self.pin_sites(&pins);
                }
                let picked = match pins.len() {
                    0 => Vec::new(),
                    1 => vec!["1 app pinned".to_owned()],
                    n => vec![format!("{n} apps pinned")],
                };
                (Map::new(), picked)
            }
            QuestionId::Default => (Map::new(), self.apply_system()),
            QuestionId::Links => {
                let little = flow.resolve_bool("openLinksInLittleArdia", &fcx);
                (
                    flow::pick(flow, &["openLinksInLittleArdia"], &fcx),
                    vec![
                        if little {
                            "Links from other apps open in Little Ardia"
                        } else {
                            "Links from other apps open in a tab"
                        }
                        .to_owned(),
                    ],
                )
            }
            QuestionId::Plugins => {
                self.plugins_forward(window, cx);
                return;
            }
            QuestionId::Outro => {
                self.finish(window, cx);
                return;
            }
        };
        self.confirm(id, patch, picked, window, cx);
    }

    pub(crate) fn actions(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let ink = self.ink();
        let fcx = self.context();
        let Some(id) = self.flow.current(&fcx) else {
            return Vec::new();
        };
        if id == QuestionId::Source
            && let Some(actions) = self.setup_code_actions(cx)
        {
            return actions;
        }
        let mut out = Vec::new();
        if !self.flow.is_first(&fcx) {
            let back = self.listen(cx, |this, window, cx| this.back(window, cx));
            out.push(parts::circle_button(
                "onboarding-back",
                Icon::ChevronLeft,
                12.,
                &ink,
                back,
            ));
        }
        let title = match id {
            QuestionId::Pins => match self.chosen_pins().len() {
                0 => "Continue".to_owned(),
                1 => "Pin 1 Tab".to_owned(),
                n => format!("Pin {n} Tabs"),
            },
            QuestionId::Plugins => self.plugins_step.primary_title(&self.official_plugins(), self.plugin_consent_request().is_some()).to_owned(),
            QuestionId::Outro if self.flow.redo => "Done".to_owned(),
            QuestionId::Outro => "Get Started".to_owned(),
            _ => "Continue".to_owned(),
        };
        let disabled = (id == QuestionId::Source && self.flow.source.is_none())
            || (id == QuestionId::Plugins && self.plugins_step.phase == plugins_step::Phase::Working);
        let next = self.listen(cx, |this, window, cx| this.forward(window, cx));
        out.push(
            div()
                .debug_selector(|| "onboarding-next".into())
                .child(parts::primary_button(
                    "onboarding-next",
                    title,
                    id == QuestionId::Outro,
                    disabled,
                    &ink,
                    next,
                ))
                .into_any_element(),
        );
        if id == QuestionId::Outro && !self.flow.redo {
            let tour = self.listen(cx, |this, window, cx| this.finish_with_tour(window, cx));
            out.push(parts::secondary_button(
                "onboarding-tour",
                "Take the Tour",
                false,
                &ink,
                tour,
            ));
        }
        if id == QuestionId::Plugins {
            if !self.plugins_settled() {
                let skip = self.listen(cx, |this, window, cx| this.skip_plugins(window, cx));
                out.push(parts::secondary_button("onboarding-skip", "Skip", false, &ink, skip));
            }
        } else if id != QuestionId::Outro {
            let whole_step = matches!(id, QuestionId::Source | QuestionId::Pins);
            let skip = self.listen(cx, move |this, window, cx| {
                this.skip(whole_step, window, cx)
            });
            out.push(parts::secondary_button(
                "onboarding-skip",
                "Skip",
                false,
                &ink,
                skip,
            ));
        }
        if id == QuestionId::Source {
            out.push(self.setup_code_link(cx));
        }
        out
    }
}

fn normalize_number(value: Value) -> Value {
    match value.as_f64() {
        Some(n) => json!(n),
        None => value,
    }
}

pub fn tidy_label(minutes: f64, fallback: &str) -> String {
    if minutes != copy::TIDY_AFTER[0].0
        && let Some((_, title)) = copy::TIDY_AFTER.iter().find(|(value, _)| *value == minutes)
    {
        return (*title).to_owned();
    }
    let _ = fallback;
    copy::duration_title(minutes)
}

pub fn frame_of(flow: &flow::Flow, cx: &flow::Context) -> f64 {
    if flow.resolve_bool("borderlessMode", cx) {
        0.0
    } else {
        flow.resolve_f64("pageFrame", cx)
            .unwrap_or(copy::FRAME_DEFAULT)
    }
}

pub fn site_logo(url: &str, side: f32, dark: bool, ink: &Ink) -> AnyElement {
    match site_icon(url) {
        Some(found) => img(found.image(dark)).size(px(side)).into_any_element(),
        None => div()
            .size(px(side))
            .rounded(px(side / 4.))
            .bg(ink.icon_container)
            .flex()
            .items_center()
            .justify_center()
            .child(icon(Icon::Globe, side * 0.6, ink.subtitle))
            .into_any_element(),
    }
}

pub fn key_cap(keys: &str, ink: &Ink) -> AnyElement {
    div()
        .h(px(22.))
        .min_w(px(22.))
        .px(px(space::S))
        .rounded(px(radius::CONTROL + 1.))
        .bg(ink.button)
        .border(px(1.))
        .border_color(ink.row_border)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(12.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink.title)
        .child(SharedString::from(keys.to_owned()))
        .into_any_element()
}
