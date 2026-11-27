use ardia_state::ProfileId;
use gpui::TestAppContext;

use super::support::Browser;
use crate::msg::Msg;
use crate::profiles::layer::{PeopleMsg, ProfilePlace};

fn send(browser: &Browser, cx: &mut TestAppContext, msg: Msg) {
    browser
        .handle
        .update(cx, |view, window, cx| view.handle(msg, window, cx))
        .expect("the window is open");
    cx.run_until_parked();
}

fn people<R>(
    browser: &Browser,
    cx: &mut TestAppContext,
    read: impl FnOnce(&crate::profiles::layer::PeopleLayer) -> R,
) -> R {
    let layer = browser.view(cx, |view| view.people.clone());
    layer.read_with(cx, |layer, _| read(layer))
}

#[gpui::test]
fn new_profile_opens_the_sheet_and_creates_and_switches(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    send(&browser, cx, Msg::command("newProfile"));
    assert!(people(&browser, cx, |layer| layer.creating()));
    assert!(browser.bounds(cx, "create-profile").is_some());
    browser.typed(cx, "Work");
    browser.keys(cx, "enter");
    let state = browser.state();
    assert_eq!(state.profile_order.len(), 2);
    let created = state.profile_order.last().cloned().expect("a new profile");
    assert_eq!(
        state.profile(created.as_str()).map(|p| p.name.as_str()),
        Some("Work")
    );
    assert_eq!(
        state
            .window(browser.window.as_str())
            .map(|w| w.profile_id.clone()),
        Some(created)
    );
    assert!(!people(&browser, cx, |layer| layer.is_open()));
}

#[gpui::test]
fn escape_cancels_the_create_sheet(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    send(&browser, cx, Msg::command("newProfile"));
    browser.keys(cx, "escape");
    assert!(!people(&browser, cx, |layer| layer.is_open()));
    assert_eq!(browser.state().profile_order.len(), 1);
}

#[gpui::test]
fn rename_sheet_commits_a_trimmed_name(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let id = ProfileId::default_profile();
    send(&browser, cx, Msg::People(PeopleMsg::Rename(id.clone())));
    assert_eq!(
        people(&browser, cx, |layer| layer.renaming().cloned()),
        Some(id.clone())
    );
    browser.typed(cx, "  Home  ");
    browser.keys(cx, "enter");
    assert_eq!(
        browser.state().profile(id.as_str()).map(|p| p.name.clone()),
        Some("Home".to_owned())
    );
}

#[gpui::test]
fn icon_picker_searches_and_sets_the_profile_icon(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let id = ProfileId::default_profile();
    send(
        &browser,
        cx,
        Msg::People(PeopleMsg::OpenIconPicker {
            profile: id.clone(),
            place: ProfilePlace::Sidebar,
        }),
    );
    assert_eq!(
        people(&browser, cx, |layer| layer.picking_for().cloned()),
        Some(id.clone())
    );
    assert!(browser.bounds(cx, "icon-picker").is_some());
    assert!(browser.bounds(cx, "icon-grid").is_some());
    browser.typed(cx, "rocket");
    browser.keys(cx, "enter");
    assert_eq!(
        browser
            .state()
            .profile(id.as_str())
            .and_then(|p| p.icon.clone()),
        Some("🚀".to_owned())
    );
    assert!(!people(&browser, cx, |layer| layer.is_open()));
}

#[gpui::test]
fn app_menu_commands_reach_the_window(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        ardia_state::Action::SetPopover {
            window: browser.window.clone(),
            popover: Some(ardia_state::windows::Popover::Custom(
                "command:newProfile".into(),
            )),
        },
    );
    browser.redraw(cx);
    assert!(people(&browser, cx, |layer| layer.creating()));
    assert_eq!(
        browser
            .state()
            .window(browser.window.as_str())
            .and_then(|w| w.chrome.popover.clone()),
        None
    );
}

#[gpui::test]
fn sharing_links_the_new_profile_to_the_chosen_data(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    send(&browser, cx, Msg::command("newProfile"));
    let layer = browser.view(cx, |view| view.people.clone());
    layer.update(cx, |layer, cx| layer.set_share(true, cx));
    browser.typed(cx, "Shared");
    browser.keys(cx, "enter");
    let state = browser.state();
    let created = state.profile_order.last().cloned().expect("a profile");
    let profile = state.profile(created.as_str()).expect("created");
    assert_eq!(
        profile.data_id.as_deref(),
        Some(ProfileId::default_profile().as_str())
    );
}
