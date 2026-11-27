use ardia_state::TabId;
use ardia_state::actions::Action;
use gpui::TestAppContext;

use super::support::Browser;
use crate::msg::Msg;

fn opt_shift_click(browser: &Browser, cx: &mut TestAppContext, tab: &TabId) {
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(Msg::PickTabIntoGroup(tab.clone()), window, cx)
        })
        .expect("open");
    cx.run_until_parked();
}

#[gpui::test]
fn opt_shift_click_opens_a_tab_in_the_active_tabs_group(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let a = browser.active();
    let b = browser.new_tab(cx, "https://b.example");
    let c = browser.new_tab(cx, "https://c.example");
    browser.act(cx, Action::ActivateTab { tab: a.clone() });
    opt_shift_click(&browser, cx, &b);
    let state = browser.state();
    let group = state.group_of(b.as_str()).expect("a group formed").clone();
    assert!(group.tab_ids.contains(&a) && group.tab_ids.contains(&b));
    assert_eq!(browser.active(), b);
    opt_shift_click(&browser, cx, &c);
    let state = browser.state();
    assert_eq!(
        state.group_of(c.as_str()).map(|g| g.id.clone()),
        Some(group.id.clone()),
        "the next tab joins the same group"
    );
    assert_eq!(browser.active(), c);
}

#[gpui::test]
fn opt_shift_click_selects_a_range_when_turned_off(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let a = browser.active();
    let b = browser.new_tab(cx, "https://b.example");
    browser.act(
        cx,
        Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new()
                .set("optShiftClickOpensInGroup", false),
            from_sync: false,
        },
    );
    browser.act(cx, Action::ActivateTab { tab: a.clone() });
    opt_shift_click(&browser, cx, &b);
    let state = browser.state();
    assert!(state.group_of(b.as_str()).is_none());
    let selection = state
        .window(browser.window.as_str())
        .map(|w| w.chrome.selection.clone())
        .unwrap_or_default();
    assert!(
        selection.contains(&a) && selection.contains(&b),
        "{selection:?}"
    );
}
