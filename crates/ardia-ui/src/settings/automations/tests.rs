use std::sync::Arc;

use ardia_state::air_traffic::{AirTrafficConfig, LinkCondition, OpenAs};
use ardia_state::link_routing::ConditionKind;
use ardia_state::windows::WindowKind;
use ardia_state::{ProfileId, RuleId};
use gpui::{Modifiers, TestAppContext, VisualTestContext, WindowHandle};

use super::calendar::{COUNTDOWN_OFF, access_line, countdown_patch, countdown_value};
use super::connect::ready;
use super::links::fallback_after_pick;
use super::rules::{RuleSheet, moved, saved_config};
use super::{Field, block_index};
use crate::live::{CalendarAccess, CalendarView};
use crate::mock::MockUiHost;
use crate::settings::SettingsWindowView;
use crate::settings::rows::Pane;
use crate::{UiHost, bind_global_keybindings, open_settings_window};

fn settings(cx: &mut TestAppContext) -> (Arc<MockUiHost>, WindowHandle<SettingsWindowView>) {
    cx.update(bind_global_keybindings);
    let host = MockUiHost::fresh();
    host.open_window(WindowKind::Main, Some("https://example.com"))
        .expect("a main window");
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_settings_window(shared, cx))
        .expect("settings open")
        .downcast::<SettingsWindowView>()
        .expect("a settings window");
    cx.run_until_parked();
    handle
        .update(cx, |view, _, cx| view.select(Pane::Automations, cx))
        .expect("open");
    cx.run_until_parked();
    (host, handle)
}

fn shows(
    cx: &mut TestAppContext,
    handle: WindowHandle<SettingsWindowView>,
    selector: &'static str,
) -> bool {
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    visual.debug_bounds(selector).is_some()
}

fn click(
    cx: &mut TestAppContext,
    handle: WindowHandle<SettingsWindowView>,
    selector: &'static str,
) {
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    let bounds = visual
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is on screen"));
    visual.simulate_click(bounds.center(), Modifiers::none());
    visual.run_until_parked();
}

fn run(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>, command: &str) {
    let command = command.to_owned();
    handle
        .update(cx, |view, window, cx| {
            super::run(view, &command, window, cx)
        })
        .expect("open");
    cx.run_until_parked();
}

fn type_into(
    cx: &mut TestAppContext,
    handle: WindowHandle<SettingsWindowView>,
    field: Field,
    text: &str,
) {
    let text = text.to_owned();
    handle
        .update(cx, |view, _, cx| {
            let input = view.automations.fields.get(field).clone();
            input.update(cx, |input, cx| input.set_text(text, false, cx));
        })
        .expect("open");
    cx.run_until_parked();
}

fn air(host: &MockUiHost) -> Arc<AirTrafficConfig> {
    host.store().snapshot().air_traffic.clone()
}

#[gpui::test]
fn the_pane_shows_the_old_sections_in_order(cx: &mut TestAppContext) {
    let (_, handle) = settings(cx);
    for selector in [
        "setting:automations.calendarAccess",
        "calendar-connect",
        "setting:automations.liveFolders",
        "live-folders-none",
        "account:github",
        "account:bitbucket",
        "account:notion",
        "account:confluence",
        "account:gdrive",
        "add-rule",
        "rules-none",
        "setting:automations.testLink",
        "test-link-field",
        "setting:automations.linkFallback",
        "setting:automations.appLinks",
    ] {
        assert!(shows(cx, handle, selector), "{selector}");
    }
    assert!(!shows(cx, handle, "setting:automations.meetingAlert"));
    assert!(!shows(cx, handle, "setting:automations.linkFallbackGroup"));
}

#[gpui::test]
fn add_rule_checks_the_site_and_saves_it(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    click(cx, handle, "add-rule");
    assert!(shows(cx, handle, "rule-save"));
    run(cx, handle, "automations:ruleKind:site");
    assert!(shows(cx, handle, "rule-text"));
    click(cx, handle, "rule-save");
    assert!(shows(cx, handle, "rule-error"));
    assert!(air(&host).rules.is_empty());
    type_into(cx, handle, Field::RuleText, "GitHub.com/ardia");
    click(cx, handle, "rule-save");
    assert!(!shows(cx, handle, "rule-save"));
    let config = air(&host);
    assert_eq!(config.rules.len(), 1);
    assert_eq!(
        config.rules[0].when,
        LinkCondition::Site("github.com".into())
    );
    assert!(config.rules[0].enabled);
    assert!(!shows(cx, handle, "rules-none"));
    let id = config.rules[0].id.as_str().to_owned();
    run(cx, handle, &format!("automations:ruleEnabled:{id}=false"));
    assert!(!air(&host).rules[0].enabled);
    run(cx, handle, &format!("automations:editRule:{id}"));
    assert!(shows(cx, handle, "rule-remove"));
    click(cx, handle, "rule-remove");
    assert!(air(&host).rules.is_empty());
}

#[gpui::test]
fn the_fallback_row_saves_and_offers_a_group_for_tabs(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx);
    let profile = host.store().snapshot().profile_order[0].clone();
    run(
        cx,
        handle,
        &format!("automations:fallback:{}", profile.as_str()),
    );
    let fallback = air(&host).fallback.clone().expect("a fallback");
    assert_eq!(fallback.profile_id, Some(profile));
    assert_eq!(fallback.open, OpenAs::Tab);
    assert!(air(&host).fallback_chosen);
    assert!(shows(cx, handle, "setting:automations.linkFallbackGroup"));
    run(cx, handle, "automations:fallbackOpen:window");
    assert_eq!(
        air(&host).fallback.as_ref().map(|f| f.open),
        Some(OpenAs::Window)
    );
    assert!(!shows(cx, handle, "setting:automations.linkFallbackGroup"));
    run(cx, handle, "automations:fallback:usual");
    assert!(air(&host).fallback.is_none());
    assert!(air(&host).fallback_chosen);
}

#[gpui::test]
fn testing_a_link_reads_like_the_old_preview(cx: &mut TestAppContext) {
    let (_, handle) = settings(cx);
    handle
        .update(cx, |view, _, cx| view.reveal("automations.testLink", cx))
        .expect("open");
    click(cx, handle, "test-link-field");
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.simulate_input("github.com/ardia");
    visual.run_until_parked();
    let typed = handle
        .read_with(cx, |view, _| view.automations.test_typed.clone())
        .expect("open");
    assert_eq!(typed, "github.com/ardia");
    let preview = handle
        .read_with(cx, |view, _| {
            ardia_state::link_routing::preview_link(
                &view.state,
                &typed,
                &ardia_state::air_traffic::LinkSource::default(),
            )
        })
        .expect("open")
        .expect("a preview");
    assert_eq!(preview.title, "No rule catches it");
    assert!(
        preview
            .detail
            .starts_with("Ardia's usual routing. Opens in ")
    );
    assert!(preview.detail.contains("(used last)"));
}

#[gpui::test]
fn connect_sheets_open_per_account_and_close_on_cancel(cx: &mut TestAppContext) {
    let (_, handle) = settings(cx);
    click(cx, handle, "account:confluence");
    assert!(shows(cx, handle, "connect-site"));
    assert!(shows(cx, handle, "connect-user"));
    assert!(shows(cx, handle, "connect-token"));
    click(cx, handle, "connect-cancel");
    assert!(!shows(cx, handle, "connect-token"));
    click(cx, handle, "account:github");
    assert!(shows(cx, handle, "connect-client-id"));
    assert!(shows(cx, handle, "device-go"));
    type_into(cx, handle, Field::Token, "ghp_x");
    click(cx, handle, "connect-go");
    assert!(shows(cx, handle, "connect-error"));
}

#[test]
fn search_anchors_land_on_their_blocks() {
    assert_eq!(block_index("automations.calendarAccess"), Some(1));
    assert_eq!(block_index("automations.gdrive"), Some(6));
    assert_eq!(block_index("automations.appLinks"), Some(11));
    assert_eq!(block_index("automations.unknown"), None);
}

#[test]
fn rules_save_move_and_refuse_like_the_old_sheet() {
    let sheet = RuleSheet {
        editing: None,
        enabled: true,
        from: None,
        typing: true,
        kind: ConditionKind::Contains,
        profile: None,
        open: OpenAs::Tab,
        group: Some("g".into()),
        error: None,
    };
    let empty = AirTrafficConfig::default();
    assert_eq!(
        saved_config(&empty, &sheet, " ", "meet", || RuleId::new("a")),
        Err("Type the app's name or bundle ID, like com.tinyspeck.slackmacgap.".into())
    );
    let saved = saved_config(&empty, &sheet, "Slack", "meet.google.com", || {
        RuleId::new("a")
    })
    .expect("saved");
    assert_eq!(saved.rules[0].target.group_key, None);
    assert_eq!(
        saved.rules[0].from.as_ref().map(|a| a.name.as_str()),
        Some("Slack")
    );
    let two = saved_config(
        &saved,
        &RuleSheet {
            typing: false,
            kind: ConditionKind::Any,
            profile: Some(ProfileId::from("p".to_owned())),
            ..sheet
        },
        "",
        "",
        || RuleId::new("b"),
    )
    .expect("saved");
    assert_eq!(two.rules[1].target.group_key.as_deref(), Some("g"));
    let up = moved(&two, "b", true).expect("moved");
    assert_eq!(up.rules[0].id, "b");
    assert!(moved(&up, "b", true).is_none());
    assert!(moved(&up, "a", false).is_none());
}

#[test]
fn calendar_rows_read_like_the_old_section() {
    let mut view = CalendarView::default();
    assert_eq!(access_line(&view), "Not connected");
    view.access = CalendarAccess::Denied;
    assert!(access_line(&view).starts_with("Ardia isn't allowed"));
    view.access = CalendarAccess::FullAccess;
    view.calendars = vec![Default::default()];
    assert_eq!(access_line(&view), "Connected \u{b7} 1 calendar");
    let mut settings = ardia_state::live::CalendarSettings::default();
    assert_eq!(countdown_value(&settings), "60");
    settings.show_time_to_next = false;
    assert_eq!(countdown_value(&settings), COUNTDOWN_OFF);
    assert_eq!(countdown_patch("off").show_time_to_next, Some(false));
    assert_eq!(countdown_patch("15").countdown_lead, Some(15));
}

#[test]
fn fallback_picks_keep_the_group_only_for_the_same_profile() {
    let current = ardia_state::air_traffic::Target {
        profile_id: Some(ProfileId::from("a".to_owned())),
        open: OpenAs::Window,
        group_key: Some("g".into()),
    };
    let same = fallback_after_pick(Some(&current), "a").expect("a target");
    assert_eq!(same.group_key.as_deref(), Some("g"));
    assert_eq!(same.open, OpenAs::Window);
    let other = fallback_after_pick(Some(&current), "b").expect("a target");
    assert_eq!(other.group_key, None);
    assert_eq!(
        fallback_after_pick(None, "").map(|t| t.profile_id),
        Some(None)
    );
    assert_eq!(fallback_after_pick(Some(&current), "usual"), None);
    assert!(ready(ardia_state::live::LiveSourceId::Notion, |_| "x".into()));
    assert!(!ready(ardia_state::live::LiveSourceId::Bitbucket, |f| {
        if f == Field::User {
            String::new()
        } else {
            "x".into()
        }
    }));
}
