use std::sync::Arc;

use ardia_state::BrowserState;
use ardia_state::settings::Settings;
use serde_json::{Value, json};

use super::copy;
use super::flow::{Context, Effect, Flow, QuestionId, Source, Step, layout_tag};
use super::intro;
use super::screens::{ctrl_tab_answer, ctrl_tab_patch, preselected_sites, tidy_label};

fn cx() -> Context {
    let state = BrowserState::default();
    let mut cx = Context::of(&state, None);
    cx.glass = true;
    cx
}

fn ids(flow: &Flow, cx: &Context) -> Vec<QuestionId> {
    flow.sections(cx).into_iter().map(|(_, _, id)| id).collect()
}

#[test]
fn every_preset_value_is_a_valid_setting() {
    for source in Source::ALL {
        let mut settings = Settings::default();
        for (key, value) in source.preset() {
            assert!(
                settings.set(&key, &value).is_ok(),
                "{} {key} {value}",
                source.key()
            );
        }
    }
}

#[test]
fn fresh_flow_asks_the_whole_questionnaire_in_order() {
    let cx = cx();
    let flow = Flow::new();
    assert_eq!(
        ids(&flow, &cx),
        vec![
            QuestionId::Source,
            QuestionId::Tabs,
            QuestionId::Color,
            QuestionId::Style,
            QuestionId::Address,
            QuestionId::Cmdl,
            QuestionId::NewTab,
            QuestionId::NewTabPosition,
            QuestionId::CtrlTab,
            QuestionId::Tidy,
            QuestionId::Quit,
            QuestionId::Windows,
            QuestionId::TabsMore,
            QuestionId::Appearance,
            QuestionId::Frame,
            QuestionId::SiteColor,
            QuestionId::LookMore,
            QuestionId::Engine,
            QuestionId::Crash,
            QuestionId::Pins,
            QuestionId::Default,
            QuestionId::Links,
            QuestionId::Outro,
        ]
    );
}

#[test]
fn a_browser_preset_skips_the_questions_it_answers() {
    let cx = cx();
    let mut flow = Flow::new();
    flow.choose_source(Some(Source::Chrome));
    assert_eq!(
        ids(&flow, &cx),
        vec![
            QuestionId::Source,
            QuestionId::Color,
            QuestionId::Style,
            QuestionId::CtrlTab,
            QuestionId::Frame,
            QuestionId::Crash,
            QuestionId::Pins,
            QuestionId::Default,
            QuestionId::Outro,
        ]
    );
    let mut fresh = Flow::new();
    fresh.choose_source(Some(Source::Fresh));
    assert!(ids(&fresh, &cx).contains(&QuestionId::Tabs));
}

#[test]
fn top_tabs_drop_the_address_question() {
    let cx = cx();
    let mut flow = Flow::new();
    flow.change(super::flow::patch(&[("tabLayout", json!("top"))]));
    assert!(!ids(&flow, &cx).contains(&QuestionId::Address));
}

#[test]
fn style_question_needs_liquid_glass() {
    let mut cx = cx();
    cx.glass = false;
    assert!(!ids(&Flow::new(), &cx).contains(&QuestionId::Style));
}

#[test]
fn next_back_and_skip_walk_the_sections() {
    let cx = cx();
    let mut flow = Flow::new();
    flow.next(&cx);
    assert_eq!((flow.step, flow.sub), (Step::Source, 0));
    assert!(flow.is_first(&cx));
    flow.back(&cx);
    assert_eq!(flow.step, Step::Source);
    flow.choose_source(Some(Source::Fresh));
    let effects = flow.confirm(
        QuestionId::Source,
        flow.source_patch(&cx),
        vec!["Starting fresh".into()],
        &cx,
    );
    assert!(effects.is_empty());
    assert_eq!((flow.step, flow.sub), (Step::Layout, 0));
    flow.next(&cx);
    assert_eq!(flow.current(&cx), Some(QuestionId::Color));
    flow.back(&cx);
    flow.back(&cx);
    assert_eq!(flow.step, Step::Source);
    flow.go_to(Step::Layout, 0);
    flow.skip(true, &cx);
    assert_eq!((flow.step, flow.sub), (Step::Tabs, 0));
    flow.go_to(Step::Outro, 0);
    flow.next(&cx);
    assert!(flow.finished);
}

#[test]
fn live_previews_revert_on_skip_and_stay_on_confirm() {
    let cx = cx();
    let mut flow = Flow::new();
    flow.go_to(Step::Look, 0);
    let effects = flow.live(super::flow::patch(&[("appearance", json!("dark"))]), &cx);
    assert_eq!(
        effects,
        vec![Effect::Settings {
            values: super::flow::patch(&[("appearance", json!("dark"))]),
            from_sync: true
        }]
    );
    let (reverted, color) = flow.skip(false, &cx);
    assert_eq!(color, None);
    assert_eq!(
        reverted,
        vec![Effect::Settings {
            values: super::flow::patch(&[("appearance", json!("auto"))]),
            from_sync: true
        }]
    );
    assert!(!flow.draft.contains_key("appearance"));

    let mut kept = Flow::new();
    kept.go_to(Step::Layout, 0);
    kept.live(super::flow::patch(&[("tabLayout", json!("top"))]), &cx);
    let confirmed = kept.confirm(
        QuestionId::Tabs,
        super::flow::patch(&[("tabLayout", json!("top"))]),
        vec!["Tabs along the top".into()],
        &cx,
    );
    assert!(confirmed.contains(&Effect::WindowLayout(ardia_state::model::TabLayout::Top)));
    assert!(kept.baseline.is_empty());
    assert_eq!(kept.picked_lines(), vec!["Tabs along the top".to_owned()]);
}

#[test]
fn source_patch_keeps_an_inferred_search_engine() {
    let mut cx = cx();
    let mut flow = Flow::new();
    flow.choose_source(Some(Source::Brave));
    assert_eq!(
        flow.source_patch(&cx).get("searchEngine"),
        Some(&json!("brave"))
    );
    cx.inferred.push("searchEngine".into());
    assert_eq!(flow.source_patch(&cx).get("searchEngine"), None);
    flow.choose_source(Some(Source::Fresh));
    assert!(flow.source_patch(&cx).is_empty());
}

#[test]
fn redo_prefills_from_current_settings_for_the_same_source() {
    let cx = cx();
    let mut flow = Flow::redo(Some(Source::Arc), None);
    assert!(!flow.prefill_preset);
    assert_eq!(flow.resolve("addressBar", &cx), cx.setting("addressBar"));
    flow.choose_source(Some(Source::Chrome));
    assert!(flow.prefill_preset);
    flow.choose_source(Some(Source::Arc));
    assert!(!flow.prefill_preset);
}

#[test]
fn resolve_prefers_draft_then_unchosen_preset_then_settings() {
    let mut cx = cx();
    let mut flow = Flow::new();
    flow.choose_source(Some(Source::Arc));
    assert_eq!(flow.resolve("addressBar", &cx), json!("sidebar"));
    cx.chosen.push("addressBar".into());
    assert_eq!(flow.resolve("addressBar", &cx), cx.setting("addressBar"));
    flow.change(super::flow::patch(&[("addressBar", json!("toolbar"))]));
    assert_eq!(flow.resolve("addressBar", &cx), json!("toolbar"));
}

#[test]
fn layout_tag_names_the_matching_browser() {
    let cx = cx();
    let mut flow = Flow::new();
    flow.choose_source(Some(Source::Arc));
    assert_eq!(layout_tag(&flow, &cx), "Arc-style");
    flow.change(super::flow::patch(&[
        ("addressBar", json!("toolbar")),
        ("commandBarPlacement", json!("field")),
    ]));
    assert_eq!(layout_tag(&flow, &cx), "Dia-style");
    flow.change(super::flow::patch(&[(
        "commandBarPlacement",
        json!("centred"),
    )]));
    assert_eq!(layout_tag(&flow, &cx), "Your mix");
}

#[test]
fn ctrl_tab_answers_map_to_switcher_settings() {
    assert_eq!(ctrl_tab_answer("recent", "none"), Some("switcher"));
    assert_eq!(ctrl_tab_answer("inOrder", "none"), Some("step"));
    assert_eq!(ctrl_tab_answer("inOrder", "thumbnails"), None);
    assert_eq!(
        ctrl_tab_patch("step", "compactList").get("tabSwitcherView"),
        Some(&json!("none"))
    );
    assert_eq!(
        ctrl_tab_patch("switcher", "none").get("tabSwitcherView"),
        Some(&json!("thumbnails"))
    );
    assert_eq!(
        ctrl_tab_patch("switcher", "compactList").get("tabSwitcherView"),
        Some(&json!("compactList"))
    );
}

#[test]
fn tidy_labels_match_the_old_copy() {
    assert_eq!(tidy_label(720.0, ""), "12 hours");
    assert_eq!(tidy_label(1440.0, ""), "1 day");
    assert_eq!(tidy_label(10080.0, ""), "1 week");
    assert_eq!(tidy_label(180.0, ""), "3 hours");
    assert_eq!(copy::frame_picked(9.0), Vec::<String>::new());
    assert_eq!(
        copy::frame_picked(0.0),
        vec!["Edge-to-edge page".to_owned()]
    );
    assert_eq!(copy::frame_picked(4.0), vec!["Page frame 4 pt".to_owned()]);
}

#[test]
fn pins_are_preselected_from_three_or_more_visits() {
    let visits = vec![
        ("https://github.com/a".to_owned(), 2),
        ("https://github.com/b".to_owned(), 2),
        ("https://mail.google.com/".to_owned(), 9),
        ("https://www.figma.com/".to_owned(), 1),
        ("https://linear.app/".to_owned(), 5),
    ];
    let none = Default::default();
    assert_eq!(
        preselected_sites(&visits, &none),
        vec!["gmail", "linear", "github"]
    );
    let pinned = ["github.com".to_owned()].into_iter().collect();
    assert_eq!(preselected_sites(&visits, &pinned), vec!["gmail", "linear"]);
}

#[test]
fn intro_cues_match_the_old_timeline() {
    assert!((intro::tagline_at() - 2.04).abs() < 1e-4);
    assert!((intro::exit_at() - 3.74).abs() < 1e-4);
    assert!((intro::end() - 4.39).abs() < 1e-4);
}

#[test]
fn context_reads_window_layout() {
    let state = Arc::new(BrowserState::default());
    let cx = Context::of(&state, None);
    assert_eq!(cx.setting("restoreSession"), Value::Bool(true));
}

#[test]
fn the_terminal_preview_shows_the_linked_command_once_installed() {
    use super::preview::terminal_lines;
    assert_eq!(
        terminal_lines(None, Some("0.7.0")),
        vec!["$ ardia tabs".to_owned()]
    );
    assert_eq!(
        terminal_lines(Some("ardia"), Some("0.7.0")),
        vec![
            "$ ardia --version".to_owned(),
            "ardia 0.7.0".to_owned(),
            "$ ardia tabs".to_owned()
        ]
    );
    assert_eq!(terminal_lines(Some("ardia"), None)[1], "ardia");
}
