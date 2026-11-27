use ardia_state::settings::SettingsPatch;
use ardia_state::{Action, BookmarkId, ProfileId};
use std::sync::Arc;

use gpui::{TestAppContext, VisualTestContext};

use super::support::Browser;
use crate::UiHost;
use crate::pages::bookmarks::edits;

fn profile(browser: &Browser) -> ProfileId {
    browser
        .state()
        .tab(browser.active().as_str())
        .unwrap()
        .profile_id
        .clone()
}

fn show_bar(browser: &Browser, cx: &mut TestAppContext) {
    browser.act(
        cx,
        Action::UpdateSettings {
            patch: SettingsPatch::new().set("bookmarksBar", "always"),
            from_sync: false,
        },
    );
}

fn seed(browser: &Browser) -> BookmarkId {
    let profile = profile(browser);
    let store = browser.host.store();
    edits::add_url_to_bar(store, &profile, "Alpha", "https://alpha.example/").unwrap();
    edits::add_url_to_bar(store, &profile, "Beta", "https://beta.example/").unwrap();
    let folder = edits::add_folder_to_bar(store, &profile, "Work").unwrap();
    edits::add_url(
        store,
        &profile,
        &folder,
        None,
        "Inside",
        "https://inside.example/",
    )
    .unwrap();
    let other = store.snapshot().bookmarks_of(&profile).unwrap().other();
    edits::add_url(
        store,
        &profile,
        &other,
        None,
        "Elsewhere",
        "https://else.example/",
    )
    .unwrap();
    folder
}

fn bar_titles(browser: &Browser) -> Vec<String> {
    let state = browser.state();
    let tree = state.bookmarks_of(&profile(browser)).unwrap();
    tree.children(tree.bar().as_str())
        .iter()
        .map(|id| tree.get(id.as_str()).unwrap().title().to_owned())
        .collect()
}

#[gpui::test]
fn the_bar_shows_items_and_other_bookmarks_under_the_toolbar(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    assert!(browser.bounds(cx, "bookmarks-bar").is_none());
    seed(&browser);
    show_bar(&browser, cx);
    let bar = browser.bounds(cx, "bookmarks-bar").expect("the bar");
    let toolbar = browser.bounds(cx, "toolbar").expect("the toolbar");
    assert!(bar.top() >= toolbar.bottom() - gpui::px(1.));
    assert!(browser.bounds(cx, "bookmarks-bar-item:Alpha").is_some());
    assert!(browser.bounds(cx, "bookmarks-bar-item:Work").is_some());
}

#[gpui::test]
fn folders_open_cascading_menus_with_open_all(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    seed(&browser);
    show_bar(&browser, cx);
    browser.click(cx, "bookmarks-bar-item:Work");
    assert!(browser.bounds(cx, "bookmark-folder-menu:0").is_some());
    assert!(browser.bounds(cx, "bookmark-folder-row:Inside").is_some());
    assert!(
        browser
            .bounds(cx, "bookmark-folder-action:Open All in New Tabs")
            .is_some()
    );
    let tabs = browser.tab_count();
    browser.click(cx, "bookmark-folder-action:Open All in New Tabs");
    assert_eq!(browser.tab_count(), tabs + 1);
    let closed = cx.update(|cx| {
        crate::bookmarks_bar::ui_for(&browser.window, cx)
            .read(cx)
            .panels
            .is_empty()
    });
    assert!(closed, "the menu starts closing");
}

#[gpui::test]
fn clicking_a_bar_bookmark_opens_it_in_the_tab(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    seed(&browser);
    show_bar(&browser, cx);
    let tab = browser.active();
    browser.click(cx, "bookmarks-bar-item:Alpha");
    assert_eq!(
        browser.state().tab(tab.as_str()).unwrap().url,
        "https://alpha.example/"
    );
}

#[gpui::test]
fn dragging_on_the_bar_reorders(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    seed(&browser);
    show_bar(&browser, cx);
    let alpha = browser.bounds(cx, "bookmarks-bar-item:Alpha").unwrap();
    let work = browser.bounds(cx, "bookmarks-bar-item:Work").unwrap();
    let to = gpui::point(work.right() - gpui::px(2.), work.center().y);
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_down(
        alpha.center(),
        gpui::MouseButton::Left,
        gpui::Modifiers::none(),
    );
    for step in 1..=8 {
        let t = step as f32 / 8.0;
        let at = gpui::point(
            alpha.center().x + (to.x - alpha.center().x) * t,
            alpha.center().y,
        );
        visual.simulate_mouse_move(at, Some(gpui::MouseButton::Left), gpui::Modifiers::none());
    }
    visual.simulate_mouse_up(to, gpui::MouseButton::Left, gpui::Modifiers::none());
    visual.run_until_parked();
    assert_eq!(bar_titles(&browser), ["Beta", "Work", "Alpha"]);
}

#[gpui::test]
fn bookmark_page_shows_the_added_dialog(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    browser
        .handle
        .update(cx, |view, window, cx| {
            view.run_command("bookmarkPage", window, cx)
        })
        .unwrap();
    cx.run_until_parked();
    assert!(browser.bounds(cx, "bookmark-dialog").is_some());
    assert!(browser.bounds(cx, "bookmark-folder-picker").is_some());
    assert_eq!(bar_titles(&browser).len(), 1);
    browser.click(cx, "bookmark-dialog-button:Remove");
    assert!(browser.bounds(cx, "bookmark-dialog").is_none());
    assert!(bar_titles(&browser).is_empty());
}

#[gpui::test]
fn add_to_sidebar_keeps_subfolders_as_nested_pinned_groups(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let profile = profile(&browser);
    let store = browser.host.store();
    let top = edits::add_folder_to_bar(store, &profile, "Trip").unwrap();
    edits::add_url(store, &profile, &top, None, "Map", "https://map.example/").unwrap();
    let inner = edits::add_folder(store, &profile, &top, None, "Hotels").unwrap();
    edits::add_url(store, &profile, &inner, None, "Inn", "https://inn.example/").unwrap();
    edits::add_url(
        store,
        &profile,
        &inner,
        None,
        "Lodge",
        "https://lodge.example/",
    )
    .unwrap();
    let host: Arc<dyn UiHost> = browser.host.clone();
    let made = crate::bookmarks_bar::groups::add_folder_groups(
        &host,
        Some(&browser.window),
        &profile,
        std::slice::from_ref(&top),
        false,
    );
    cx.run_until_parked();
    let state = browser.state();
    assert_eq!(made.groups.len(), 1);
    let outer = state.groups.get(&made.groups[0]).unwrap();
    assert_eq!(outer.name, "Trip");
    assert!(outer.pinned);
    assert_eq!(outer.tab_ids.len(), 3);
    let inner = state
        .groups
        .values()
        .find(|g| g.parent_id.as_ref() == Some(&outer.id))
        .expect("Hotels nests inside Trip");
    assert_eq!(inner.name, "Hotels");
    assert!(inner.pinned);
    assert_eq!(inner.tab_ids.len(), 2);
}

#[test]
fn export_toasts_reveal_the_written_file() {
    let command = format!(
        "{}{}",
        crate::popovers::toast::REVEAL_ACTION,
        "/tmp/Ardia Bookmarks.html"
    );
    assert_eq!(
        crate::popovers::toast::reveal_target(&command),
        Some("/tmp/Ardia Bookmarks.html")
    );
    assert_eq!(crate::popovers::toast::reveal_target("reveal:"), None);
    assert_eq!(crate::popovers::toast::reveal_target("undoClearTabs"), None);
}

#[gpui::test]
fn new_folder_asks_in_the_window_and_files_the_folder(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let profile = profile(&browser);
    show_bar(&browser, cx);
    seed(&browser);
    let bar = browser
        .state()
        .bookmarks_of(&profile)
        .map(|tree| tree.bar())
        .unwrap();
    browser
        .handle
        .update(cx, |view, window, cx| {
            let ctx = crate::bookmarks_bar::BarCtx::for_window(
                &view.host,
                &view.emit,
                &view.window_id,
                &view.look.p,
                false,
                cx,
            )
            .unwrap();
            crate::bookmarks_bar::dialog::prompt_new_folder(&ctx, bar.clone(), None, None, cx);
            let _ = window;
        })
        .unwrap();
    browser.redraw(cx);
    assert!(browser.bounds(cx, "bookmark-prompt").is_some());
    browser.typed(cx, "Reading");
    browser.keys(cx, "enter");
    browser.redraw(cx);
    assert!(browser.bounds(cx, "bookmark-prompt").is_none());
    assert!(bar_titles(&browser).contains(&"Reading".to_owned()));
}

#[gpui::test]
fn links_dropped_on_the_bar_become_bookmarks_at_the_spot(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    show_bar(&browser, cx);
    seed(&browser);
    let profile = profile(&browser);
    let bar = browser
        .state()
        .bookmarks_of(&profile)
        .map(|tree| tree.bar())
        .unwrap();
    browser
        .handle
        .update(cx, |view, _, cx| {
            let ctx = crate::bookmarks_bar::BarCtx::for_window(
                &view.host,
                &view.emit,
                &view.window_id,
                &view.look.p,
                false,
                cx,
            )
            .unwrap();
            crate::bookmarks_bar::set_spot(
                &ctx,
                Some(crate::bookmarks_bar::fit::Spot::Slot {
                    parent: bar.clone(),
                    slot: 1,
                }),
                None,
                0,
                cx,
            );
            let items = gpui::ExternalItems {
                paths: Vec::new(),
                urls: vec![
                    "https://dropped.example/a".to_owned(),
                    "javascript:alert(1)".to_owned(),
                ],
                text: Some("Dropped Page".to_owned()),
            };
            crate::bookmarks_bar::drop_links(&ctx, &items, cx);
        })
        .unwrap();
    assert_eq!(
        bar_titles(&browser),
        ["Alpha", "Dropped Page", "Beta", "Work"]
    );
}
