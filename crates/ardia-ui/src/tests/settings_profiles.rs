use std::sync::Arc;

use ardia_state::actions::ProfilePatch;
use ardia_state::settings::SettingsPatch;
use ardia_state::windows::WindowKind;
use ardia_state::{Action, ProfileId};
use gpui::{
    Modifiers, MouseButton, ScrollDelta, ScrollEvent, TestAppContext, VisualTestContext,
    WindowHandle, point, px,
};

use crate::mock::MockUiHost;
use crate::settings::SettingsWindowView;
use crate::tests::support::Browser;
use crate::{UiHost, bind_global_keybindings, open_settings_window};

fn settings(
    cx: &mut TestAppContext,
    prepare: impl FnOnce(&MockUiHost),
) -> (Arc<MockUiHost>, WindowHandle<SettingsWindowView>) {
    cx.update(bind_global_keybindings);
    let host = MockUiHost::fresh();
    host.open_window(WindowKind::Main, Some("https://example.com"))
        .expect("a main window");
    prepare(&host);
    let shared: Arc<dyn UiHost> = host.clone();
    let handle = cx
        .update(|cx| open_settings_window(shared, cx))
        .expect("settings open")
        .downcast::<SettingsWindowView>()
        .expect("a settings window");
    cx.run_until_parked();
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    let pane = visual
        .debug_bounds("settings-pane:Profiles")
        .expect("the Profiles pane is listed");
    visual.simulate_click(pane.center(), Modifiers::none());
    visual.run_until_parked();
    (host, handle)
}

fn add_profiles(host: &MockUiHost, names: &[&str]) {
    for name in names {
        host.dispatch(Action::CreateProfile {
            name: (*name).to_owned(),
            color: None,
            icon: None,
        });
    }
}

fn order_names(host: &MockUiHost) -> Vec<String> {
    let state = host.store().snapshot();
    state
        .profile_order
        .iter()
        .filter_map(|id| state.profile(id.as_str()).map(|p| p.name.clone()))
        .collect()
}

fn pill(id: &ProfileId) -> &'static str {
    Box::leak(format!("profile-pill:{id}").into_boxed_str())
}

#[gpui::test]
fn dragging_a_pill_past_its_neighbour_reorders_the_profiles(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx, |host| add_profiles(host, &["Work", "Side"]));
    let before = order_names(&host);
    let ids = host.store().snapshot().profile_order.clone();
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    let last = visual.debug_bounds(pill(&ids[2])).expect("the last pill");
    let first = visual.debug_bounds(pill(&ids[0])).expect("the first pill");
    let start = last.center();
    visual.simulate_mouse_down(start, MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    let mut x = start.x;
    while x > first.left() {
        x -= px(20.);
        visual.simulate_mouse_move(point(x, start.y), MouseButton::Left, Modifiers::none());
        visual.run_until_parked();
    }
    visual.simulate_mouse_up(point(x, start.y), MouseButton::Left, Modifiers::none());
    visual.run_until_parked();
    let after = order_names(&host);
    assert_eq!(after.len(), before.len());
    assert_eq!(after[0], before[2]);
    assert_eq!(&after[1..], &before[..2]);
}

#[gpui::test]
fn a_press_without_a_drag_picks_the_profile(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx, |host| add_profiles(host, &["Work"]));
    let ids = host.store().snapshot().profile_order.clone();
    let before = order_names(&host);
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    let target = visual.debug_bounds(pill(&ids[1])).expect("the second pill");
    visual.simulate_click(target.center(), Modifiers::none());
    visual.run_until_parked();
    let picked = handle
        .read_with(cx, |view, _| view.profile.clone())
        .expect("open");
    assert_eq!(picked, Some(ids[1].clone()));
    assert_eq!(order_names(&host), before);
}

#[gpui::test]
fn the_icon_row_opens_the_picker_and_removes_the_icon(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx, |_| {});
    let id = host.store().snapshot().profile_order[0].clone();
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    let add = visual
        .debug_bounds("profile-icon-change")
        .expect("Add… is shown");
    visual.simulate_click(add.center(), Modifiers::none());
    visual.run_until_parked();
    let picking = handle
        .read_with(cx, |view, cx| view.people.read(cx).picking_for().cloned())
        .expect("open");
    assert_eq!(picking, Some(id.clone()));
    handle
        .update(cx, |view, _, cx| {
            view.people.update(cx, |layer, cx| layer.close(cx))
        })
        .expect("open");
    host.dispatch(Action::UpdateProfile {
        profile: id.clone(),
        patch: ProfilePatch {
            icon: Some(Some("🐱".to_owned())),
            ..ProfilePatch::default()
        },
    });
    visual.run_until_parked();
    let remove = visual
        .debug_bounds("profile-icon-remove")
        .expect("Remove shows once there is an icon");
    visual.simulate_click(remove.center(), Modifiers::none());
    visual.run_until_parked();
    let icon = host
        .store()
        .snapshot()
        .profile(id.as_str())
        .and_then(|p| p.icon.clone());
    assert_eq!(icon, None);
}

#[gpui::test]
fn profiles_that_share_data_get_share_top_apps_rows(cx: &mut TestAppContext) {
    let (host, handle) = settings(cx, |host| {
        add_profiles(host, &["Side"]);
        let state = host.store().snapshot();
        host.dispatch(Action::ShareProfileData {
            profile: state.profile_order[1].clone(),
            with: state.profile_order[0].clone(),
        });
    });
    let ids = host.store().snapshot().profile_order.clone();
    let selector: &'static str =
        Box::leak(format!("toggle:shareTopApps:{}", ids[0]).into_boxed_str());
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    visual.run_until_parked();
    assert!(visual.debug_bounds("profile-shared-data").is_some());
    let content = visual
        .debug_bounds("settings-card")
        .expect("the settings card");
    visual.simulate_event(ScrollEvent {
        position: content.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(-4000.))),
        ..ScrollEvent::default()
    });
    visual.run_until_parked();
    let toggle = visual.debug_bounds(selector).expect("a Share Top Apps row");
    visual.simulate_click(toggle.center(), Modifiers::none());
    visual.run_until_parked();
    assert!(
        host.store()
            .snapshot()
            .profile(ids[0].as_str())
            .is_some_and(|p| p.share_top_apps)
    );
}

#[gpui::test]
fn new_tab_opens_the_saved_address(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::UpdateSettings {
            patch: SettingsPatch::new().set("newTabUrl", "start.example.org"),
            from_sync: false,
        },
    );
    let before = browser.tab_count();
    browser.keys(cx, "cmd-t");
    assert_eq!(browser.tab_count(), before + 1);
    let state = browser.state();
    let active = state
        .active_tab(browser.window.as_str())
        .expect("an active tab");
    assert_eq!(active.url, "https://start.example.org");
}

#[gpui::test]
fn the_thumb_sits_on_the_selected_pill(cx: &mut TestAppContext) {
    let (_host, handle) = settings(cx, |host| add_profiles(host, &["Work", "Side"]));
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    for _ in 0..3 {
        visual.run_until_parked();
        handle
            .update(&mut visual, |_, window, _| window.refresh())
            .expect("open");
    }
    visual.run_until_parked();
    let thumb = visual.debug_bounds("profile-thumb").expect("the thumb");
    let selected = handle
        .read_with(&visual, |view, _| {
            crate::settings::panes::selected_profile(view)
        })
        .expect("open")
        .expect("a selected profile");
    let pill = visual
        .debug_bounds(pill(&selected))
        .expect("the selected pill");
    assert_eq!(thumb.origin, pill.origin);
    assert_eq!(thumb.size.width, pill.size.width);
}
