use ardia_state::Action;
use gpui::TestAppContext;

use super::support::Browser;
use crate::host::PageCommand;
use crate::mock::HostCall;
use crate::pages::reader::ReaderStatus;

#[gpui::test]
fn history_and_bookmarks_render_inside_the_page_slot(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let profile = browser
        .state()
        .tab(browser.active().as_str())
        .unwrap()
        .profile_id
        .clone();
    browser.act(
        cx,
        Action::RecordVisit {
            profile,
            url: "https://visited.example/".into(),
            title: "Visited".into(),
            favicon: None,
        },
    );
    browser.keys(cx, "cmd-y");
    let history = browser.active();
    assert_eq!(
        browser.state().tab(history.as_str()).unwrap().url,
        "ardia://history"
    );
    assert!(browser.bounds(cx, "history-page").is_some());
    assert!(browser.bounds(cx, "web-placeholder").is_none());
    let tabs = browser.tab_count();
    browser.keys(cx, "cmd-y");
    assert_eq!(browser.tab_count(), tabs, "History opens once per window");
    browser.new_tab(cx, "ardia://bookmarks");
    assert!(browser.bounds(cx, "bookmarks-page").is_some());
}

#[gpui::test]
fn reader_toggles_in_the_page_through_the_host(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.new_tab(cx, "https://reads.example/story");
    browser.host.set_reader(
        tab.clone(),
        ReaderStatus {
            available: true,
            active: false,
        },
    );
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.run_command("toggleReader", window, cx)
        })
        .unwrap();
    cx.run_until_parked();
    assert_eq!(
        browser.state().tab(tab.as_str()).unwrap().url,
        "https://reads.example/story",
        "Reader stays on the page, as in the old app"
    );
    assert!(browser.host.calls().contains(&HostCall::ToggleReader(tab)));
}

#[gpui::test]
fn file_and_print_commands_reach_the_host(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    for command in ["openFile", "print", "savePage", "printWithSystemDialog"] {
        browser
            .handle
            .update(cx, |view, window, cx| view.run_command(command, window, cx))
            .unwrap();
    }
    let calls = browser.host.calls();
    assert!(calls.contains(&HostCall::OpenFile(browser.window.clone())));
    for command in [
        PageCommand::Print,
        PageCommand::SavePage,
        PageCommand::PrintWithSystemDialog,
    ] {
        assert!(calls.contains(&HostCall::PageCommand {
            tab: tab.clone(),
            command
        }));
    }
}
