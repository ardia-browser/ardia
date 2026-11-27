use ardia_state::DownloadId;
use ardia_state::downloads::{Download, DownloadState};
use ardia_state::{Action, ProfileId};
use gpui::{Modifiers, MouseButton, TestAppContext, VisualTestContext};

use super::support::Browser;
use crate::mock::HostCall;

fn profile(browser: &Browser) -> ProfileId {
    browser
        .state()
        .tab(browser.active().as_str())
        .unwrap()
        .profile_id
        .clone()
}

fn visit(browser: &Browser, cx: &mut TestAppContext, url: &str, title: &str) {
    let profile = profile(browser);
    browser.act(
        cx,
        Action::RecordVisit {
            profile,
            url: url.into(),
            title: title.into(),
            favicon: None,
        },
    );
}

fn history_urls(browser: &Browser) -> Vec<String> {
    let profile = profile(browser);
    browser
        .state()
        .history_of(&profile)
        .map(|history| history.entries().map(|e| e.url.clone()).collect())
        .unwrap_or_default()
}

fn hover(browser: &Browser, cx: &mut TestAppContext, selector: &'static str) {
    let bounds = browser.bounds(cx, selector).expect("on screen");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_move(bounds.center(), None, Modifiers::none());
    visual.run_until_parked();
}

fn open_history(browser: &Browser, cx: &mut TestAppContext) {
    browser.keys(cx, "cmd-y");
    browser.redraw(cx);
}

#[gpui::test]
fn history_lists_days_and_opens_rows_in_the_tab(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    visit(&browser, cx, "https://one.example/", "One");
    open_history(&browser, cx);
    let history = browser.active();
    assert!(browser.bounds(cx, "history-list").is_some());
    assert!(browser.bounds(cx, "history-clear-data").is_some());
    browser.click(cx, "history-link-0");
    assert!(browser.host.calls().iter().any(|call| matches!(call,
        HostCall::Navigate { tab, input, .. } if *tab == history && input == "https://one.example/")));
}

#[gpui::test]
fn the_empty_history_says_so(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    open_history(&browser, cx);
    assert!(browser.bounds(cx, "history-page").is_some());
    assert!(browser.bounds(cx, "history-list").is_none());
}

#[gpui::test]
fn selected_rows_are_deleted_after_confirming(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    visit(&browser, cx, "https://keep.example/", "Keep");
    visit(&browser, cx, "https://drop.example/", "Drop");
    open_history(&browser, cx);
    let first = {
        let profile = profile(&browser);
        let state = browser.state();
        let entries = crate::pages::history_model::entries_newest_first(
            state.history_of(&profile).map(|h| h.as_ref()),
        );
        entries[0].url.clone()
    };
    hover(&browser, cx, "history-link-0");
    browser.click(cx, "history-check-0");
    assert!(browser.bounds(cx, "history-delete-selection").is_some());
    browser.host.set_confirm_answer(false);
    browser.click(cx, "history-delete-selection");
    assert_eq!(history_urls(&browser).len(), 2, "Cancel keeps the pages");
    browser.host.set_confirm_answer(true);
    browser.click(cx, "history-delete-selection");
    let left = history_urls(&browser);
    assert_eq!(left.len(), 1);
    assert!(!left.contains(&first), "the checked page is gone");
    assert!(browser.host.calls().iter().any(|call| matches!(call,
        HostCall::Confirm { question, .. } if question.title == "Remove selected items?")));
    assert!(browser.bounds(cx, "history-clear-data").is_some());
}

#[gpui::test]
fn the_row_menu_removes_one_page_without_asking(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    visit(&browser, cx, "https://menu.example/", "Menu");
    open_history(&browser, cx);
    let row = browser.bounds(cx, "history-link-0").expect("a row");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_down(row.center(), MouseButton::Right, Modifiers::none());
    visual.simulate_mouse_up(row.center(), MouseButton::Right, Modifiers::none());
    visual.run_until_parked();
    assert!(browser.bounds(cx, "history-menu").is_some());
    browser.click(cx, "history-menu-Remove");
    assert!(history_urls(&browser).is_empty());
    assert!(
        !browser
            .host
            .calls()
            .iter()
            .any(|call| matches!(call, HostCall::Confirm { .. }))
    );
}

#[gpui::test]
fn clear_browsing_data_asks_the_host_for_the_last_hour(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    visit(&browser, cx, "https://recent.example/", "Recent");
    open_history(&browser, cx);
    browser.click(cx, "history-clear-data");
    assert!(browser.bounds(cx, "clear-data-dialog").is_some());
    browser.click(cx, "clear-data-confirm");
    let request = browser
        .host
        .calls()
        .into_iter()
        .find_map(|call| match call {
            HostCall::ClearBrowsingData { request, .. } => Some(request),
            _ => None,
        })
        .expect("the host clears data");
    assert!(request.history && request.site_data);
    assert_eq!(request.since, Some(request.started_at - 3_600_000));
    assert!(browser.bounds(cx, "clear-data-dialog").is_none());
    assert!(history_urls(&browser).is_empty());
}

#[gpui::test]
fn the_clear_command_opens_history_with_the_dialog(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.run_command("clearBrowsingData", window, cx)
        })
        .unwrap();
    cx.run_until_parked();
    browser.redraw(cx);
    assert_eq!(
        browser.state().tab(browser.active().as_str()).unwrap().url,
        "ardia://history"
    );
    assert!(browser.bounds(cx, "clear-data-dialog").is_some());
}

fn finished(id: &str, name: &str) -> Download {
    Download {
        id: DownloadId::new(id),
        url: format!("https://files.example/{name}"),
        filename: name.into(),
        path: format!("/nowhere/{name}"),
        state: DownloadState::Finished,
        paused: false,
        dangerous: None,
        received: 10.0,
        total: 10.0,
        speed: 0.0,
        mime_type: String::new(),
        profile: None,
        off_the_record: None,
        staging: None,
        start_time: None,
        extra: Default::default(),
    }
}

#[gpui::test]
fn the_downloads_page_lists_and_clears_downloads(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::UpsertDownload {
            download: Box::new(finished("d1", "report.pdf")),
        },
    );
    browser.new_tab(cx, "ardia://downloads");
    browser.redraw(cx);
    assert!(browser.bounds(cx, "downloads-page").is_some());
    assert!(browser.bounds(cx, "download-card").is_some());
    browser.click(cx, "downloads-clear-all");
    assert!(browser.state().downloads.items().is_empty());
    browser.redraw(cx);
    assert!(browser.bounds(cx, "download-card").is_none());
}

#[gpui::test]
fn view_all_downloads_opens_the_page(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser.act(
        cx,
        Action::UpsertDownload {
            download: Box::new(finished("d2", "notes.txt")),
        },
    );
    browser.redraw(cx);
    browser.click(cx, "downloads-button");
    browser.click(cx, "downloads-view-all");
    browser.redraw(cx);
    assert_eq!(
        browser.state().tab(browser.active().as_str()).unwrap().url,
        "ardia://downloads"
    );
    assert!(browser.bounds(cx, "downloads-page").is_some());
}

#[gpui::test]
fn row_controls_wait_for_hover(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    visit(&browser, cx, "https://hover.example/", "Hover");
    open_history(&browser, cx);
    assert!(browser.bounds(cx, "history-more-0").is_none());
    hover(&browser, cx, "history-link-0");
    assert!(browser.bounds(cx, "history-more-0").is_some());
}

#[gpui::test]
fn native_row_menus_run_the_chosen_item(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    visit(&browser, cx, "https://native.example/", "Native");
    open_history(&browser, cx);
    browser.host.set_menu_pick(Some(Some("remove".to_owned())));
    let row = browser.bounds(cx, "history-link-0").expect("a row");
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_down(row.center(), MouseButton::Right, Modifiers::none());
    visual.simulate_mouse_up(row.center(), MouseButton::Right, Modifiers::none());
    visual.run_until_parked();
    let shown = browser
        .host
        .calls()
        .into_iter()
        .find_map(|call| match call {
            HostCall::ShowMenu(items) => Some(items),
            _ => None,
        })
        .expect("a native menu");
    let titles: Vec<String> = shown.iter().map(|item| item.title.clone()).collect();
    assert_eq!(
        titles,
        [
            "Open in New Tab",
            "Open in Split View",
            "Open in",
            "",
            "Copy Link",
            "Copy Link as Markdown",
            "More from This Site",
            "",
            "Remove from History"
        ]
    );
    assert!(shown[5].alternate);
    assert!(history_urls(&browser).is_empty());
    assert!(browser.bounds(cx, "history-menu").is_none());
}

#[gpui::test]
fn native_download_menu_trashes_and_opens_when_done(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let mut active = finished("d3", "big.iso");
    active.state = DownloadState::Downloading;
    browser.act(
        cx,
        Action::UpsertDownload {
            download: Box::new(active),
        },
    );
    browser.new_tab(cx, "ardia://downloads");
    browser.redraw(cx);
    browser
        .host
        .set_menu_pick(Some(Some("whenDone".to_owned())));
    browser.click(cx, "download-more-d3");
    assert!(
        browser
            .host
            .calls()
            .contains(&HostCall::OpenWhenDone("d3".into()))
    );
}
