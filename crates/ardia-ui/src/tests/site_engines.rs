use ardia_state::Action;
use ardia_state::model::PageEngine;
use ardia_state::settings::SettingsPatch;
use ardia_state::windows::Popover;
use gpui::TestAppContext;

use crate::mock::HostCall;
use crate::msg::{MenuTarget, Msg};
use crate::sidebar::row_look::{engine_mark_box, engine_mark_plate};
use crate::site::SiteMsg;
use crate::site::menus::SiteMenu;
use crate::tests::support::Browser;

fn send(browser: &Browser, cx: &mut TestAppContext, msg: Msg) {
    browser
        .handle
        .update(cx, |view, window, cx| view.handle(msg, window, cx))
        .expect("open");
    cx.run_until_parked();
}

fn rules(browser: &Browser, cx: &mut TestAppContext, site: &str, engine: &str) {
    browser.act(
        cx,
        Action::UpdateSettings {
            patch: SettingsPatch::new().set("websiteEngines", serde_json::json!({ site: engine })),
            from_sync: false,
        },
    );
}

fn webkit_browser(cx: &mut TestAppContext) -> Browser {
    Browser::open_with(cx, |host| host.set_webkit(true, false, false))
}

#[gpui::test]
fn engine_mark_shows_only_where_the_engine_differs(cx: &mut TestAppContext) {
    assert_eq!(engine_mark_box(16.0), 10.0);
    assert_ne!(engine_mark_plate(true), engine_mark_plate(false));
    let browser = webkit_browser(cx);
    let tab = browser.new_tab(cx, "https://app.example/inbox");
    browser.redraw(cx);
    assert!(browser.bounds(cx, "engine-mark:safari").is_none());
    rules(&browser, cx, "https://app.example", "webkit");
    browser.redraw(cx);
    assert!(browser.bounds(cx, "engine-mark:safari").is_some());
    let _ = tab;
    let plain = Browser::open(cx);
    let other = plain.new_tab(cx, "https://app.example/inbox");
    rules(&plain, cx, "https://app.example", "webkit");
    plain.redraw(cx);
    assert!(plain.bounds(cx, "engine-mark:safari").is_none());
    let _ = other;
}

#[gpui::test]
fn site_controls_offer_the_engine_choice(cx: &mut TestAppContext) {
    let browser = webkit_browser(cx);
    let tab = browser.new_tab(cx, "https://news.example/story");
    send(&browser, cx, Msg::TogglePopover(Popover::SiteControls));
    assert!(browser.bounds(cx, "site-engine").is_some());
    browser.click(cx, "site-engine");
    let menu = browser.view(cx, |view| view.ui.menu.clone());
    assert!(matches!(
        menu,
        Some((MenuTarget::Site(SiteMenu::Engine(ref known)), _)) if *known == tab
    ));
    let entries = browser.view(cx, |view| {
        let state = view.host.store().snapshot();
        let listed = state.tab(tab.as_str()).cloned().expect("tab");
        crate::site::menus::engine_titles(&state, &listed)
    });
    assert_eq!(
        entries,
        vec![
            ("Default (Chromium)".to_owned(), true),
            ("Chromium".to_owned(), false),
            ("WebKit".to_owned(), false)
        ]
    );
    send(
        &browser,
        cx,
        Msg::Site(SiteMsg::OpenIn(tab.clone(), Some(PageEngine::Webkit))),
    );
    send(&browser, cx, Msg::Site(SiteMsg::OpenIn(tab.clone(), None)));
    let calls = browser.host.calls();
    assert!(calls.contains(&HostCall::OpenPageIn(tab.clone(), PageEngine::Webkit)));
    assert!(calls.contains(&HostCall::ResetPageEngine(tab.clone())));
    send(&browser, cx, Msg::TogglePopover(Popover::SiteControls));
    send(&browser, cx, Msg::TogglePopover(Popover::SiteControls));
    browser.click(cx, "site-more");
    assert!(browser.bounds(cx, "site-other-engine").is_some());
    browser.click(cx, "site-other-engine");
    assert!(
        browser
            .host
            .calls()
            .contains(&HostCall::TogglePageEngine(tab.clone()))
    );
}

#[gpui::test]
fn streaming_sites_say_recommended_and_webkit_hides_site_settings(cx: &mut TestAppContext) {
    let browser = webkit_browser(cx);
    let tab = browser.new_tab(cx, "https://www.netflix.com/browse");
    let titles = browser.view(cx, |view| {
        let state = view.host.store().snapshot();
        let listed = state.tab(tab.as_str()).cloned().expect("tab");
        crate::site::menus::engine_titles(&state, &listed)
    });
    assert_eq!(titles[0], ("Recommended (WebKit)".to_owned(), true));
    send(&browser, cx, Msg::TogglePopover(Popover::SiteControls));
    browser.click(cx, "site-more");
    assert!(browser.bounds(cx, "site-settings").is_none());
    assert!(browser.bounds(cx, "site-other-engine").is_some());
}

#[gpui::test]
fn no_engine_rows_without_webkit(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.new_tab(cx, "https://news.example/story");
    send(&browser, cx, Msg::TogglePopover(Popover::SiteControls));
    assert!(browser.bounds(cx, "site-engine").is_none());
    browser.click(cx, "site-more");
    assert!(browser.bounds(cx, "site-other-engine").is_none());
    assert!(browser.bounds(cx, "site-settings").is_some());
}
