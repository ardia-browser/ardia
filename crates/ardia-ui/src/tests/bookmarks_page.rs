use ardia_state::bookmarks::BookmarkNode;
use ardia_state::{BookmarkId, ProfileId};
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

fn seed(browser: &Browser) -> (BookmarkId, Vec<BookmarkId>) {
    let profile = profile(browser);
    let store = browser.host.store();
    let mut made = Vec::new();
    for name in ["Alpha", "Beta", "Gamma"] {
        made.push(
            edits::add_url_to_bar(
                store,
                &profile,
                name,
                &format!("https://{}.example/", name.to_lowercase()),
            )
            .unwrap(),
        );
    }
    let folder = edits::add_folder_to_bar(store, &profile, "Work").unwrap();
    (folder, made)
}

fn bar_titles(browser: &Browser) -> Vec<String> {
    let state = browser.state();
    let tree = state.bookmarks_of(&profile(browser)).unwrap();
    tree.children(tree.bar().as_str())
        .iter()
        .map(|id| tree.get(id.as_str()).unwrap().title().to_owned())
        .collect()
}

fn click(browser: &Browser, cx: &mut TestAppContext, selector: &'static str) {
    browser.click(cx, selector);
}

#[gpui::test]
fn the_bookmarks_page_lists_the_bar_beside_the_folder_tree(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    seed(&browser);
    browser.new_tab(cx, "ardia://bookmarks");
    assert!(browser.bounds(cx, "bookmarks-page").is_some());
    let tree = browser
        .bounds(cx, "bookmarks-tree")
        .expect("the folder tree");
    let list = browser.bounds(cx, "bookmarks-list").expect("the list");
    assert!(tree.right() <= list.left(), "the tree sits beside the list");
    assert!(browser.bounds(cx, "bookmark-row:Alpha").is_some());
    assert!(browser.bounds(cx, "bookmark-row:Work").is_some());
}

#[gpui::test]
fn deleting_a_row_offers_undo(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    seed(&browser);
    browser.new_tab(cx, "ardia://bookmarks");
    click(&browser, cx, "bookmark-row:Alpha");
    browser.keys(cx, "backspace");
    assert_eq!(bar_titles(&browser), ["Beta", "Gamma", "Work"]);
    assert!(browser.bounds(cx, "bookmarks-undo").is_some());
    browser.click(cx, "bookmarks-undo-action");
    assert_eq!(bar_titles(&browser), ["Alpha", "Beta", "Gamma", "Work"]);
}

#[gpui::test]
fn the_organize_menu_makes_a_new_folder(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    seed(&browser);
    browser.new_tab(cx, "ardia://bookmarks");
    click(&browser, cx, "bookmarks-organize");
    assert!(browser.bounds(cx, "bookmark-menu").is_some());
    click(&browser, cx, "bookmark-menu:New Folder…");
    assert!(browser.bounds(cx, "bookmark-dialog").is_some());
    assert!(browser.bounds(cx, "bookmark-folder-picker").is_some());
    browser.typed(cx, "Reading");
    browser.keys(cx, "enter");
    assert!(browser.bounds(cx, "bookmark-dialog").is_none());
    assert!(bar_titles(&browser).contains(&"Reading".to_owned()));
    let state = browser.state();
    let tree = state.bookmarks_of(&profile(&browser)).unwrap();
    let made =
        tree.children(tree.bar().as_str())
            .iter()
            .find_map(|id| match tree.get(id.as_str()) {
                Some(BookmarkNode::Folder { title, .. }) if title == "Reading" => Some(id.clone()),
                _ => None,
            });
    assert!(made.is_some());
}

#[gpui::test]
fn row_menus_edit_bookmarks(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    seed(&browser);
    browser.new_tab(cx, "ardia://bookmarks");
    let row = browser.bounds(cx, "bookmark-row:Alpha").unwrap();
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_event(gpui::MouseDownEvent {
        button: gpui::MouseButton::Right,
        position: row.center(),
        modifiers: gpui::Modifiers::none(),
        click_count: 1,
        first_mouse: false,
    });
    visual.run_until_parked();
    assert!(
        browser
            .bounds(cx, "bookmark-menu:Open in New Tab")
            .is_some()
    );
    assert!(browser.bounds(cx, "bookmark-menu:Edit…").is_some());
    click(&browser, cx, "bookmark-menu:Edit…");
    assert!(browser.bounds(cx, "bookmark-dialog").is_some());
    browser.keys(cx, "cmd-a");
    browser.typed(cx, "Renamed");
    browser.keys(cx, "enter");
    assert_eq!(bar_titles(&browser)[0], "Renamed");
}

fn drag(
    browser: &Browser,
    cx: &mut TestAppContext,
    from: gpui::Point<gpui::Pixels>,
    to: gpui::Point<gpui::Pixels>,
) {
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_mouse_down(from, gpui::MouseButton::Left, gpui::Modifiers::none());
    for step in 1..=6 {
        let t = step as f32 / 6.0;
        let at = gpui::point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
        visual.simulate_mouse_move(at, Some(gpui::MouseButton::Left), gpui::Modifiers::none());
    }
    visual.simulate_mouse_up(to, gpui::MouseButton::Left, gpui::Modifiers::none());
    visual.run_until_parked();
}

#[gpui::test]
fn dragging_moves_rows_into_folders_and_between_rows(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let (folder, _) = seed(&browser);
    browser.new_tab(cx, "ardia://bookmarks");
    let alpha = browser.bounds(cx, "bookmark-row:Alpha").unwrap();
    let work = browser.bounds(cx, "bookmark-row:Work").unwrap();
    drag(&browser, cx, alpha.center(), work.center());
    assert_eq!(bar_titles(&browser), ["Beta", "Gamma", "Work"]);
    let state = browser.state();
    let tree = state.bookmarks_of(&profile(&browser)).unwrap();
    assert_eq!(tree.children(folder.as_str()).len(), 1);
    let gamma = browser.bounds(cx, "bookmark-row:Gamma").unwrap();
    let beta = browser.bounds(cx, "bookmark-row:Beta").unwrap();
    drag(
        &browser,
        cx,
        gamma.center(),
        gpui::point(beta.center().x, beta.top() + gpui::px(4.)),
    );
    assert_eq!(bar_titles(&browser), ["Gamma", "Beta", "Work"]);
}
