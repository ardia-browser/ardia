use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::DownloadId;
use ardia_state::downloads::{Download, DownloadState};
use ardia_state::history::HistoryEntry;
use ardia_state::windows::WindowKind;
use ardia_state::{Action, ProfileId};
use gpui::{AnyWindowHandle, AppContext, Focusable, TestAppContext, WindowHandle};
use serde_json::json;

use super::support::Browser;
use crate::mock::MockUiHost;
use crate::settings::SettingsWindowView;
use crate::settings::data::SettingsQuery;
use crate::{UiHost, bind_global_keybindings, open_settings_window};

const FRAMES: u32 = 40;

fn frame_cost(cx: &mut TestAppContext, window: AnyWindowHandle) -> Duration {
    for _ in 0..5 {
        cx.update_window(window, |_, w, cx| {
            w.refresh();
            w.draw(cx).clear(cx);
        })
        .unwrap();
    }
    let mut samples = Vec::new();
    for _ in 0..FRAMES {
        let spent = cx
            .update_window(window, |_, w, cx| {
                w.refresh();
                let at = Instant::now();
                w.draw(cx).clear(cx);
                at.elapsed()
            })
            .unwrap();
        samples.push(spent);
    }
    samples.sort();
    samples[samples.len() / 2]
}

fn report(name: &str, n: usize, cost: Duration) {
    println!("PERF\t{name}\t{n}\t{:.1}", cost.as_secs_f64() * 1e6);
}

fn profile(browser: &Browser) -> ProfileId {
    browser
        .state()
        .tab(browser.active().as_str())
        .unwrap()
        .profile_id
        .clone()
}

fn download(i: usize) -> Download {
    let name = format!("file-{i}.pdf");
    Download {
        id: DownloadId::new(format!("d{i}")),
        url: format!("https://files.example/{name}"),
        path: format!("/nowhere/{name}"),
        filename: name,
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

fn history_case(cx: &mut TestAppContext, n: usize, query: &str) -> Duration {
    let browser = Browser::open(cx);
    let profile = profile(&browser);
    let now = ardia_state::store::now_ms();
    let entries = (0..n)
        .map(|i| HistoryEntry {
            url: format!("https://site{}.example/page/{i}", i % 97),
            title: format!("Page number {i} about things"),
            favicon: None,
            visits: 1,
            last_visit: now - (i as i64) * 600_000,
            visit_times: Vec::new(),
        })
        .collect();
    browser.act(cx, Action::ReplaceHistory { profile, entries });
    let url = if query.is_empty() {
        "ardia://history".to_owned()
    } else {
        format!("ardia://history?q={query}")
    };
    browser.new_tab(cx, &url);
    browser.redraw(cx);
    assert!(browser.bounds(cx, "history-list").is_some());
    frame_cost(cx, browser.handle.into())
}

fn bookmarks_case(cx: &mut TestAppContext, n: usize, query: &str) -> Duration {
    let browser = Browser::open(cx);
    let profile = profile(&browser);
    for i in 0..n {
        browser.host.dispatch(Action::AddBookmark {
            profile: profile.clone(),
            parent: None,
            title: format!("Bookmark {i}"),
            url: format!("https://site{}.example/b/{i}", i % 89),
        });
    }
    cx.run_until_parked();
    let url = if query.is_empty() {
        "ardia://bookmarks".to_owned()
    } else {
        format!("ardia://bookmarks?q={query}")
    };
    browser.new_tab(cx, &url);
    browser.redraw(cx);
    frame_cost(cx, browser.handle.into())
}

fn downloads_case(cx: &mut TestAppContext, n: usize) -> Duration {
    let browser = Browser::open(cx);
    for i in 0..n {
        browser.host.dispatch(Action::UpsertDownload {
            download: Box::new(download(i)),
        });
    }
    cx.run_until_parked();
    browser.new_tab(cx, "ardia://downloads");
    browser.redraw(cx);
    assert!(browser.bounds(cx, "downloads-page").is_some());
    frame_cost(cx, browser.handle.into())
}

fn tab_menu_case(cx: &mut TestAppContext, tabs: usize) -> Duration {
    let browser = Browser::open(cx);
    for i in 0..tabs {
        browser.new_tab(cx, &format!("https://site{i}.example/"));
    }
    let tab = browser.active();
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.handle(
                crate::msg::Msg::Menu(Some((
                    crate::msg::MenuTarget::Tab(tab),
                    gpui::point(gpui::px(400.), gpui::px(60.)),
                ))),
                window,
                cx,
            )
        })
        .expect("open");
    browser.redraw(cx);
    frame_cost(cx, browser.handle.into())
}

fn idle_browser_case(cx: &mut TestAppContext) -> Duration {
    let browser = Browser::open(cx);
    browser.redraw(cx);
    frame_cost(cx, browser.handle.into())
}

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
    (host, handle)
}

fn settings_profile(host: &MockUiHost) -> ProfileId {
    ProfileId::from(host.store().snapshot().settings.default_profile_id.clone())
}

fn send(cx: &mut TestAppContext, handle: WindowHandle<SettingsWindowView>, command: &str) {
    let command = gpui::SharedString::from(command.to_owned());
    handle
        .update(cx, |view, window, cx| {
            view.handle(crate::msg::Msg::Command(command), window, cx)
        })
        .expect("open");
    cx.run_until_parked();
}

fn passwords_case(cx: &mut TestAppContext, n: usize) -> Duration {
    let (host, handle) = settings(cx);
    let profile = settings_profile(&host);
    host.set_settings_value(
        SettingsQuery::PasswordsUnlocked(profile.clone()),
        json!(true),
    );
    let rows: Vec<_> = (0..n)
        .map(|i| json!({"origin": format!("https://site{i}.example"), "username": format!("user{i}")}))
        .collect();
    host.set_settings_value(
        SettingsQuery::Passwords(profile),
        json!({ "passwords": rows }),
    );
    send(cx, handle, crate::settings::subpages::OPEN_PASSWORDS);
    frame_cost(cx, handle.into())
}

fn sites_case(cx: &mut TestAppContext, n: usize) -> Duration {
    let (host, handle) = settings(cx);
    let profile = settings_profile(&host);
    let origins: Vec<_> = (0..n).map(|i| format!("https://site{i}.example")).collect();
    host.set_settings_value(
        SettingsQuery::SiteOrigins(profile),
        json!({ "origins": origins }),
    );
    send(cx, handle, crate::settings::subpages::OPEN_SITES);
    frame_cost(cx, handle.into())
}

fn extensions_case(cx: &mut TestAppContext, n: usize) -> Duration {
    let (host, handle) = settings(cx);
    let profile = settings_profile(&host);
    let icon = format!("data:image/png;base64,{}", "iVBORw0KGgo".repeat(200));
    let rows: Vec<_> = (0..n)
        .map(|i| {
            json!({"id": format!("ext{i}"), "name": format!("Extension {i}"), "version": "1.0",
            "enabled": true, "icon": icon, "permissions": ["storage", "tabs"]})
        })
        .collect();
    host.set_settings_value(
        SettingsQuery::Extensions(profile),
        json!({ "extensions": rows }),
    );
    handle
        .update(cx, |view, _, cx| {
            view.go_to(crate::settings::rows::Pane::Profiles, cx);
            view.reveal("profiles.extensions", cx)
        })
        .expect("open");
    cx.run_until_parked();
    frame_cost(cx, handle.into())
}

fn pane_case(cx: &mut TestAppContext, pane: &str) -> Duration {
    let (_, handle) = settings(cx);
    handle
        .update(cx, |view, _, cx| {
            let pane = crate::settings::rows::Pane::ALL
                .into_iter()
                .find(|p| format!("{p:?}") == pane)
                .unwrap();
            view.go_to(pane, cx)
        })
        .expect("open");
    cx.run_until_parked();
    frame_cost(cx, handle.into())
}

fn settings_search_case(cx: &mut TestAppContext, query: &str) -> Duration {
    let (_, handle) = settings(cx);
    let search = handle.read_with(cx, |view, _| view.search.clone()).unwrap();
    let window: AnyWindowHandle = handle.into();
    cx.update_window(window, |_, w, cx| {
        let focus = search.read(cx).focus_handle(cx);
        w.focus(&focus, cx);
    })
    .unwrap();
    cx.simulate_input(window, query);
    cx.run_until_parked();
    frame_cost(cx, window)
}

fn whats_sent_case(cx: &mut TestAppContext) -> Duration {
    let (_, handle) = settings(cx);
    send(cx, handle, "settings:sub:open:crashDetails");
    frame_cost(cx, handle.into())
}

#[gpui::test]
#[ignore]
fn list_perf_history(cx: &mut TestAppContext) {
    for n in [100, 10_000] {
        let cost = history_case(cx, n, "");
        report("history", n, cost);
    }
    let cost = history_case(cx, 10_000, "page");
    report("history?q", 10_000, cost);
}

#[gpui::test]
#[ignore]
fn list_perf_bookmarks(cx: &mut TestAppContext) {
    for n in [50, 5_000] {
        let cost = bookmarks_case(cx, n, "");
        report("bookmarks", n, cost);
    }
    let cost = bookmarks_case(cx, 5_000, "bookmark");
    report("bookmarks?q", 5_000, cost);
}

#[gpui::test]
#[ignore]
fn list_perf_downloads(cx: &mut TestAppContext) {
    for n in [10, 1_000] {
        let cost = downloads_case(cx, n);
        report("downloads", n, cost);
    }
}

#[gpui::test]
#[ignore]
fn list_perf_idle_browser(cx: &mut TestAppContext) {
    let cost = idle_browser_case(cx);
    report("browser-idle", 0, cost);
    let cost = tab_menu_case(cx, 60);
    report("tab-menu", 60, cost);
}

#[gpui::test]
#[ignore]
fn list_perf_settings(cx: &mut TestAppContext) {
    for n in [10, 1_000] {
        let cost = passwords_case(cx, n);
        report("passwords", n, cost);
    }
    for n in [5, 500] {
        let cost = sites_case(cx, n);
        report("site-exceptions", n, cost);
    }
    for n in [5, 200] {
        let cost = extensions_case(cx, n);
        report("extensions", n, cost);
    }
    let cost = pane_case(cx, "Shortcuts");
    report("shortcuts-pane", 150, cost);
    let cost = pane_case(cx, "General");
    report("general-pane", 0, cost);
    let cost = settings_search_case(cx, "a");
    report("settings-search:a", 158, cost);
    let cost = whats_sent_case(cx);
    report("whats-sent", 239, cost);
}
