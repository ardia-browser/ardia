use gpui::TestAppContext;

use crate::mock::HostCall;
use crate::msg::Msg;
use crate::site::model::{
    AutofillAsk, BlockedPopupItem, DeviceAsk, DeviceOptionView, EngineOfferAsk, ExternalAppAsk,
    HiddenElement, HiddenList, PageSelection, PasswordAsk, PermissionAsk, PopupsAnswer,
    SelectionRect, SettingValue, SiteBlocker, SiteSettings,
};
use crate::site::{SiteAnswer, SiteMsg, SitePage, SitePanel};
use crate::tests::support::Browser;
use ardia_state::windows::Popover;

fn web_browser(cx: &mut TestAppContext) -> (Browser, ardia_state::TabId) {
    let browser = Browser::open(cx);
    let tab = browser.new_tab(cx, "https://news.example/story");
    (browser, tab)
}

fn send(browser: &Browser, cx: &mut TestAppContext, msg: Msg) {
    browser
        .handle
        .update(cx, |view, window, cx| view.handle(msg, window, cx))
        .expect("open");
    cx.run_until_parked();
}

fn answers(browser: &Browser) -> Vec<SiteAnswer> {
    browser
        .host
        .calls()
        .into_iter()
        .filter_map(|call| match call {
            HostCall::SiteAnswer(_, answer) => Some(answer),
            _ => None,
        })
        .collect()
}

#[gpui::test]
fn permission_prompt_reads_and_answers_like_the_old_one(cx: &mut TestAppContext) {
    let (browser, tab) = web_browser(cx);
    browser.host.set_site_page(
        tab,
        Some(SitePage {
            permission: Some(PermissionAsk {
                id: "req-7".into(),
                origin: "https://meet.example".into(),
                permissions: vec!["camera".into(), "microphone".into()],
            }),
            ..SitePage::default()
        }),
    );
    browser.redraw(cx);
    assert!(browser.bounds(cx, "site-permission-prompt").is_some());
    browser.click(cx, "prompt-allow");
    assert!(browser.host.calls().iter().any(|call| matches!(
        call,
        HostCall::Permission { request, result: ardia_engine::PermissionResult::Accept, remember: true }
            if request == "req-7"
    )));
}

#[gpui::test]
fn password_update_offers_username_choices(cx: &mut TestAppContext) {
    let (browser, tab) = web_browser(cx);
    browser.host.set_site_page(
        tab,
        Some(SitePage {
            password: Some(PasswordAsk {
                origin: "https://login.example".into(),
                username: "ada".into(),
                usernames: vec!["ada".into(), "grace".into()],
                update: true,
                ..PasswordAsk::default()
            }),
            ..SitePage::default()
        }),
    );
    browser.redraw(cx);
    assert!(browser.bounds(cx, "password-never").is_none());
    browser.click(cx, "password-choice:1");
    browser.click(cx, "password-save");
    assert!(browser.host.calls().iter().any(|call| matches!(
        call,
        HostCall::Password { action, username: Some(name), .. } if action == "update" && name == "grace"
    )));
}

#[gpui::test]
fn autofill_external_app_and_engine_offer_answer(cx: &mut TestAppContext) {
    let (browser, tab) = web_browser(cx);
    browser.host.set_site_page(
        tab.clone(),
        Some(SitePage {
            autofill: Some(AutofillAsk {
                id: 9,
                kind: "saveCard".into(),
                title: "Save card?".into(),
                accept: "Save".into(),
                decline: "No Thanks".into(),
                lines: vec!["Visa •••• 4242".into()],
                ..AutofillAsk::default()
            }),
            external_app: Some(ExternalAppAsk {
                id: "x1".into(),
                title: "Open Zoom?".into(),
                remember: Some("Always allow zoom.us to open Zoom".into()),
                ..ExternalAppAsk::default()
            }),
            ..SitePage::default()
        }),
    );
    browser.redraw(cx);
    browser.click(cx, "autofill-fill");
    assert!(browser.host.calls().iter().any(|call| matches!(
        call,
        HostCall::Autofill { prompt: 9, action, .. } if action == "accept"
    )));
    browser.click(cx, "external-app-remember");
    browser.click(cx, "external-app-open");
    browser.host.set_site_page(
        tab,
        Some(SitePage {
            engine_offer: Some(EngineOfferAsk {
                site: "https://tv.example".into(),
                host: "tv.example".into(),
                can_remember: true,
            }),
            ..SitePage::default()
        }),
    );
    browser.redraw(cx);
    browser.click(cx, "engine-offer-remember");
    browser.click(cx, "engine-offer-stay");
    let answers = answers(&browser);
    assert!(answers.contains(&SiteAnswer::ExternalApp {
        open: true,
        remember: true
    }));
    assert!(answers.contains(&SiteAnswer::EngineOffer {
        accept: false,
        remember: true
    }));
}

#[gpui::test]
fn device_chooser_selects_then_connects(cx: &mut TestAppContext) {
    let (browser, tab) = web_browser(cx);
    browser.host.set_site_page(
        tab,
        Some(SitePage {
            device: Some(DeviceAsk {
                id: 4,
                title: "news.example wants to pair".into(),
                options: vec![
                    DeviceOptionView {
                        name: "Keyboard".into(),
                        ..DeviceOptionView::default()
                    },
                    DeviceOptionView {
                        name: "Mouse".into(),
                        paired: true,
                        ..DeviceOptionView::default()
                    },
                ],
                can_refresh: true,
                ..DeviceAsk::default()
            }),
            ..SitePage::default()
        }),
    );
    browser.redraw(cx);
    browser.click(cx, "device-connect");
    assert!(answers(&browser).is_empty());
    browser.click(cx, "device:1");
    browser.click(cx, "device-connect");
    browser.click(cx, "device-rescan");
    let answers = answers(&browser);
    assert!(answers.contains(&SiteAnswer::ChooseDevice {
        chooser: 4,
        index: 1
    }));
    assert!(answers.contains(&SiteAnswer::RescanDevices(4)));
}

#[gpui::test]
fn site_controls_show_live_settings_and_expand(cx: &mut TestAppContext) {
    let (browser, tab) = web_browser(cx);
    browser.host.set_site_panel(
        tab.clone(),
        SitePanel {
            settings: Some(SiteSettings::from_json(&serde_json::json!({
                "camera": {"value": "allow", "isDefault": false},
                "location": {"value": "ask", "isDefault": true}
            }))),
            blocker: Some(SiteBlocker {
                enabled: true,
                allowed: false,
            }),
            ..SitePanel::default()
        },
    );
    send(&browser, cx, Msg::TogglePopover(Popover::SiteControls));
    assert!(browser.bounds(cx, "site-controls").is_some());
    assert!(browser.bounds(cx, "site-permission:camera").is_some());
    assert!(browser.bounds(cx, "site-permission:location").is_none());
    assert!(
        browser
            .host
            .calls()
            .iter()
            .any(|call| matches!(call, HostCall::RefreshSitePanel(known) if *known == tab))
    );
    browser.click(cx, "site-blocker");
    assert!(answers(&browser).contains(&SiteAnswer::SetBlocking(false)));
    browser.click(cx, "site-more");
    assert!(browser.bounds(cx, "site-other:location").is_some());
    assert!(browser.bounds(cx, "site-settings").is_some());
    browser.click(cx, "site-connection");
    assert!(browser.bounds(cx, "site-connection-row").is_some());
    assert!(browser.bounds(cx, "site-settings").is_none());
}

#[gpui::test]
fn permission_menu_sets_the_chosen_value(cx: &mut TestAppContext) {
    let (browser, tab) = web_browser(cx);
    browser.host.set_site_panel(
        tab.clone(),
        SitePanel {
            settings: Some(SiteSettings::from_json(&serde_json::json!({
                "camera": {"value": "allow", "isDefault": false}
            }))),
            ..SitePanel::default()
        },
    );
    send(&browser, cx, Msg::TogglePopover(Popover::SiteControls));
    browser.click(cx, "site-permission:camera");
    let entries = browser.view(cx, |view| view.ui.menu.clone());
    assert!(matches!(
        entries,
        Some((crate::msg::MenuTarget::Site(_), _))
    ));
    send(
        &browser,
        cx,
        Msg::Site(SiteMsg::Answer(
            tab,
            SiteAnswer::SetPermission {
                kind: "camera".into(),
                value: SettingValue::Block,
            },
        )),
    );
    assert!(answers(&browser).contains(&SiteAnswer::SetPermission {
        kind: "camera".into(),
        value: SettingValue::Block
    }));
}

#[gpui::test]
fn blocked_popups_and_hidden_elements_panels(cx: &mut TestAppContext) {
    let (browser, tab) = web_browser(cx);
    browser.host.set_site_page(
        tab.clone(),
        Some(SitePage {
            popups: vec![BlockedPopupItem {
                id: "pop-1".into(),
                url: "https://ads.example/x".into(),
                origin: "https://news.example".into(),
            }],
            ..SitePage::default()
        }),
    );
    browser.host.set_site_panel(
        tab,
        SitePanel {
            hidden: Some(HiddenList {
                host: "news.example".into(),
                elements: vec![
                    HiddenElement {
                        filter: "news.example##.ad".into(),
                        host: "news.example".into(),
                        selector: ".ad".into(),
                        session: false,
                    },
                    HiddenElement {
                        filter: "news.example##.promo".into(),
                        host: "news.example".into(),
                        selector: ".promo".into(),
                        session: true,
                    },
                ],
            }),
            ..SitePanel::default()
        },
    );
    send(&browser, cx, Msg::TogglePopover(Popover::BlockedPopups));
    browser.click(cx, "popups-allow");
    assert!(answers(&browser).contains(&SiteAnswer::Popups(PopupsAnswer::AlwaysAllow)));
    send(
        &browser,
        cx,
        Msg::TogglePopover(Popover::Custom("hiddenElements".into())),
    );
    assert!(browser.bounds(cx, "site-hidden-elements").is_some());
    browser.click(cx, "hidden-show-all");
    assert!(answers(&browser).contains(&SiteAnswer::RestoreHidden(vec![
        "news.example##.ad".into(),
        "news.example##.promo".into()
    ])));
}

#[gpui::test]
fn zoom_bubble_opens_on_keyboard_zoom_and_closes_itself(cx: &mut TestAppContext) {
    let (browser, _tab) = web_browser(cx);
    send(&browser, cx, Msg::command("zoomIn"));
    let open = |browser: &Browser| {
        browser
            .state()
            .window(browser.window.as_str())
            .and_then(|w| w.chrome.popover.clone())
    };
    assert_eq!(open(&browser), Some(Popover::Zoom));
    assert!(browser.bounds(cx, "site-zoom-panel").is_some());
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(1600));
    cx.run_until_parked();
    assert_eq!(open(&browser), None);
}

#[gpui::test]
fn selection_search_bar_appears_after_its_delay(cx: &mut TestAppContext) {
    let (browser, tab) = web_browser(cx);
    browser.host.set_page_selection(
        tab,
        Some(PageSelection {
            text: "rust gpui".into(),
            rect: SelectionRect {
                x: 200.0,
                y: 200.0,
                width: 80.0,
                height: 16.0,
            },
        }),
    );
    send(&browser, cx, Msg::Site(SiteMsg::SelectionChanged));
    assert!(browser.bounds(cx, "selection-bar").is_none());
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(200));
    cx.run_until_parked();
    browser.redraw(cx);
    assert!(browser.bounds(cx, "selection-bar").is_some());
    let before = browser.tab_count();
    browser.click(cx, "selection-search");
    assert_eq!(browser.tab_count(), before + 1);
    assert!(browser.bounds(cx, "selection-bar").is_none());
}

#[gpui::test]
fn translate_rows_answer_and_open_the_language_menu(cx: &mut TestAppContext) {
    let (browser, tab) = web_browser(cx);
    browser.host.set_site_panel(
        tab,
        SitePanel {
            settings: Some(SiteSettings::default()),
            translate: crate::site::model::TranslateView {
                available: true,
                source: Some("fr".into()),
                translated: false,
                never: false,
                source_name: "French".into(),
                target_name: "English".into(),
            },
            ..SitePanel::default()
        },
    );
    send(&browser, cx, Msg::TogglePopover(Popover::SiteControls));
    browser.click(cx, "site-more");
    assert!(browser.bounds(cx, "site-never-translate").is_some());
    browser.click(cx, "site-translate-other");
    let menu = browser.view(cx, |view| view.ui.menu.clone());
    assert!(matches!(
        menu,
        Some((
            crate::msg::MenuTarget::Site(crate::site::menus::SiteMenu::Languages(_)),
            _
        ))
    ));
    send(&browser, cx, Msg::TogglePopover(Popover::SiteControls));
    browser.click(cx, "site-more");
    browser.click(cx, "site-translate");
    assert!(answers(&browser).contains(&SiteAnswer::Translate));
}
