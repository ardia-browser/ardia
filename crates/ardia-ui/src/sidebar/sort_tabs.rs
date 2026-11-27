use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use ardia_state::group_names::site_key;
use ardia_state::windows::{ToastKind, WindowKind};
use ardia_state::{Action, BrowserState, GroupId, TabId, WindowId};
use gpui::SharedString;

use crate::msg::Msg;
use crate::popovers::context_menu::{MenuEntry, MenuItem};
use crate::primitives::icons::Icon;
use crate::sidebar::model::{self, Entry};

pub const SORT_MENU_ID: &str = "sortTabs";
pub const SORT_GROUP_PREFIX: &str = "sortGroupTabs:";
pub const UNDO_SORT_PREFIX: &str = "undoSortTabs:";
const SORT_SYMBOL: &str = "arrow.up.arrow.down";
const KEPT_RECORDS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortKey {
    Site,
    Title,
}

impl SortKey {
    pub const ALL: [SortKey; 2] = [SortKey::Site, SortKey::Title];

    pub fn arg(self) -> &'static str {
        match self {
            SortKey::Site => "site",
            SortKey::Title => "title",
        }
    }

    pub fn from_arg(arg: &str) -> Option<SortKey> {
        SortKey::ALL.into_iter().find(|key| key.arg() == arg)
    }

    fn title(self) -> &'static str {
        match self {
            SortKey::Site => "By Site",
            SortKey::Title => "By Title",
        }
    }

    fn icon(self) -> Icon {
        match self {
            SortKey::Site => Icon::Globe,
            SortKey::Title => Icon::TextFormat,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SortTarget {
    pub window: WindowId,
    pub group: Option<GroupId>,
}

impl SortTarget {
    pub fn window(window: &WindowId) -> Self {
        SortTarget {
            window: window.clone(),
            group: None,
        }
    }

    pub fn group(window: &WindowId, group: &GroupId) -> Self {
        SortTarget {
            window: window.clone(),
            group: Some(group.clone()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sorted {
    pub target: SortTarget,
    pub before: Vec<String>,
    pub after: Vec<String>,
    pub tabs: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SortPlan {
    pub order: Vec<TabId>,
    pub sorted: Sorted,
}

thread_local! {
    static RECORDS: RefCell<(u64, HashMap<u64, Sorted>)> = RefCell::new((0, HashMap::new()));
}

fn entry_key(entry: &Entry) -> String {
    match entry {
        Entry::Tab { tab, .. } => format!("tab:{}", tab.id),
        Entry::Split { split, .. } => format!("split:{}", split.id),
        Entry::Group { group, .. } => format!("group:{}", group.id),
    }
}

fn sorts(entry: &Entry) -> bool {
    !matches!(entry, Entry::Group { .. })
}

fn find_group(entries: &[Entry], group: &GroupId) -> Option<Vec<Entry>> {
    entries.iter().find_map(|entry| match entry {
        Entry::Group {
            group: g, children, ..
        } if g.id == *group => Some(children.clone()),
        Entry::Group { children, .. } => find_group(children, group),
        _ => None,
    })
}

fn entries_of(state: &BrowserState, target: &SortTarget) -> Option<Vec<Entry>> {
    let window = state.window(target.window.as_str())?;
    if window.kind == WindowKind::LittleArdia {
        return None;
    }
    let sections = model::sections(state, target.window.as_str());
    match &target.group {
        None => Some(sections.unpinned),
        Some(group) => {
            let g = state.group(group.as_str())?;
            if g.window_id != window.id || g.profile_id != window.profile_id {
                return None;
            }
            find_group(&sections.pinned, group).or_else(|| find_group(&sections.unpinned, group))
        }
    }
}

fn in_window_order(state: &BrowserState, window: &WindowId, ids: Vec<TabId>) -> Vec<TabId> {
    let wanted: HashSet<TabId> = ids.into_iter().collect();
    state
        .window(window.as_str())
        .map(|w| {
            w.tab_ids
                .iter()
                .filter(|t| wanted.contains(*t))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn collate(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase())
}

struct Keyed {
    at: usize,
    site: String,
    title: String,
}

fn sorted_slots(
    state: &BrowserState,
    window: &WindowId,
    entries: &[Entry],
    key: SortKey,
) -> Vec<usize> {
    let mut keyed: Vec<Keyed> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| sorts(entry))
        .map(|(at, entry)| {
            let first = in_window_order(state, window, entry.tab_ids())
                .into_iter()
                .next();
            let tab = first.and_then(|id| state.tab(id.as_str()));
            Keyed {
                at,
                site: tab.map(|t| site_key(t.pin_home())).unwrap_or_default(),
                title: tab.map(|t| t.display_title()).unwrap_or_default(),
            }
        })
        .collect();
    keyed.sort_by(|a, z| {
        let by_site = match key {
            SortKey::Site => a
                .site
                .is_empty()
                .cmp(&z.site.is_empty())
                .then_with(|| collate(&a.site, &z.site)),
            SortKey::Title => Ordering::Equal,
        };
        by_site
            .then_with(|| collate(&a.title, &z.title))
            .then_with(|| a.at.cmp(&z.at))
    });
    let mut next = keyed.into_iter();
    entries
        .iter()
        .enumerate()
        .map(|(at, entry)| {
            if sorts(entry) {
                next.next().map_or(at, |k| k.at)
            } else {
                at
            }
        })
        .collect()
}

fn tab_order(
    state: &BrowserState,
    window: &WindowId,
    entries: &[Entry],
    slots: &[usize],
) -> Vec<TabId> {
    slots
        .iter()
        .filter_map(|at| entries.get(*at))
        .flat_map(|entry| in_window_order(state, window, entry.tab_ids()))
        .collect()
}

pub fn sortable_count(state: &BrowserState, target: &SortTarget) -> usize {
    entries_of(state, target).map_or(0, |entries| entries.iter().filter(|e| sorts(e)).count())
}

pub fn sort_plan(state: &BrowserState, target: &SortTarget, key: SortKey) -> Option<SortPlan> {
    let entries = entries_of(state, target)?;
    if entries.iter().filter(|e| sorts(e)).count() < 2 {
        return None;
    }
    let slots = sorted_slots(state, &target.window, &entries, key);
    if slots.iter().enumerate().all(|(at, from)| at == *from) {
        return None;
    }
    let before: Vec<String> = entries.iter().map(entry_key).collect();
    let after: Vec<String> = slots.iter().map(|at| before[*at].clone()).collect();
    let tabs = entries
        .iter()
        .filter(|e| sorts(e))
        .map(|e| e.tab_ids().len())
        .sum();
    Some(SortPlan {
        order: tab_order(state, &target.window, &entries, &slots),
        sorted: Sorted {
            target: target.clone(),
            before,
            after,
            tabs,
        },
    })
}

pub fn can_sort(state: &BrowserState, target: &SortTarget, key: SortKey) -> bool {
    sort_plan(state, target, key).is_some()
}

pub fn undo_order(state: &BrowserState, sorted: &Sorted) -> Option<Vec<TabId>> {
    let entries = entries_of(state, &sorted.target)?;
    let now: Vec<String> = entries.iter().map(entry_key).collect();
    let live: HashSet<&String> = now.iter().collect();
    let was: HashSet<&String> = sorted.before.iter().collect();
    let kept: Vec<&String> = now.iter().filter(|e| was.contains(e)).collect();
    let back: Vec<&String> = sorted.before.iter().filter(|e| live.contains(e)).collect();
    let sorted_now: Vec<&String> = sorted.after.iter().filter(|e| live.contains(e)).collect();
    if kept != sorted_now || kept == back {
        return None;
    }
    let mut next = back.into_iter();
    let slots: Vec<usize> = now
        .iter()
        .map(|entry| {
            let wanted = if was.contains(entry) {
                next.next().unwrap_or(entry)
            } else {
                entry
            };
            now.iter().position(|e| e == wanted).unwrap_or(0)
        })
        .collect();
    Some(tab_order(state, &sorted.target.window, &entries, &slots))
}

pub fn can_undo_sort(state: &BrowserState, sorted: &Sorted) -> bool {
    undo_order(state, sorted).is_some()
}

fn remember(sorted: Sorted) -> u64 {
    RECORDS.with(|records| {
        let mut records = records.borrow_mut();
        records.0 += 1;
        let id = records.0;
        records.1.insert(id, sorted);
        records.1.retain(|kept, _| *kept + KEPT_RECORDS as u64 > id);
        id
    })
}

fn recalled(id: u64) -> Option<Sorted> {
    RECORDS.with(|records| records.borrow().1.get(&id).cloned())
}

fn sorted_message(tabs: usize) -> String {
    if tabs == 1 {
        "Sorted 1 Tab".to_owned()
    } else {
        format!("Sorted {tabs} Tabs")
    }
}

pub fn sort_messages(state: &BrowserState, target: &SortTarget, key: SortKey) -> Vec<Msg> {
    let Some(plan) = sort_plan(state, target, key) else {
        return Vec::new();
    };
    let message = sorted_message(plan.sorted.tabs);
    let undo = format!("{UNDO_SORT_PREFIX}{}", remember(plan.sorted));
    let mut toast = crate::popovers::toast::toast(
        message,
        ToastKind::Undo,
        Some(&undo),
        ardia_state::store::now_ms(),
    );
    toast.icon = Some(SORT_SYMBOL.to_owned());
    vec![
        Msg::Store(Action::ArrangeTabs {
            window: target.window.clone(),
            tabs: plan.order,
        }),
        Msg::Store(Action::PushToast {
            window: target.window.clone(),
            toast,
        }),
    ]
}

pub fn can_undo(state: &BrowserState, arg: &str) -> bool {
    arg.parse::<u64>()
        .ok()
        .and_then(recalled)
        .is_some_and(|sorted| can_undo_sort(state, &sorted))
}

pub fn undo_messages(state: &BrowserState, arg: &str) -> Vec<Msg> {
    let Some(sorted) = arg.parse::<u64>().ok().and_then(recalled) else {
        return Vec::new();
    };
    match undo_order(state, &sorted) {
        Some(order) => vec![Msg::Store(Action::ArrangeTabs {
            window: sorted.target.window.clone(),
            tabs: order,
        })],
        None => Vec::new(),
    }
}

pub fn group_command(arg: &str, window: &WindowId) -> Option<(SortTarget, SortKey)> {
    let (key, group) = arg.split_once(':')?;
    let key = SortKey::from_arg(key)?;
    (!group.is_empty()).then(|| (SortTarget::group(window, &GroupId::new(group)), key))
}

pub fn sort_menu(state: &BrowserState, target: &SortTarget, hints: bool) -> MenuEntry {
    let children: Vec<MenuEntry> = SortKey::ALL
        .into_iter()
        .map(|key| {
            let command = match &target.group {
                None => format!("{SORT_MENU_ID}:{}", key.arg()),
                Some(group) => format!("{SORT_GROUP_PREFIX}{}:{group}", key.arg()),
            };
            let shortcut = hints
                .then(|| crate::keybindings::hint(state, &format!("{SORT_MENU_ID}:{}", key.arg())))
                .flatten();
            MenuItem::new(
                SharedString::from(format!("{SORT_MENU_ID}:{}", key.arg())),
                key.title(),
            )
            .icon(key.icon())
            .enabled(can_sort(state, target, key))
            .shortcut(shortcut)
            .msg(Msg::Command(SharedString::from(command)))
            .entry()
        })
        .collect();
    let enabled = children
        .iter()
        .any(|child| matches!(child, MenuEntry::Item(item) if item.enabled));
    let mut menu = MenuEntry::submenu(
        SORT_MENU_ID,
        "Sort Tabs",
        Some(Icon::SwapVertical),
        children,
    );
    if let MenuEntry::Submenu(sub) = &mut menu {
        sub.enabled = enabled;
    }
    menu
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::actions::NewTab;
    use ardia_state::ids::IdGen;
    use ardia_state::store::BrowserStore;

    fn store_with(urls: &[(&str, &str)]) -> (BrowserStore, WindowId, Vec<TabId>) {
        let store = BrowserStore::in_memory(BrowserState::default(), IdGen::with_launch("s"));
        store
            .dispatch(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: None,
                frame: None,
            })
            .ok();
        let window = store
            .read(|state| state.windows.keys().next().cloned())
            .expect("a window");
        let blank: Vec<TabId> = store.read(|state| {
            state
                .window(window.as_str())
                .map(|w| w.tab_ids.clone())
                .unwrap_or_default()
        });
        let mut ids = Vec::new();
        for (url, title) in urls {
            let tab = store
                .dispatch(Action::NewTab {
                    window: window.clone(),
                    tab: NewTab {
                        url: Some((*url).to_owned()),
                        ..NewTab::default()
                    },
                })
                .expect("a tab")
                .tab
                .expect("a new tab");
            store
                .dispatch(Action::RenameTab {
                    tab: tab.clone(),
                    title: Some((*title).to_owned()),
                })
                .ok();
            ids.push(tab);
        }
        if !blank.is_empty() {
            store
                .dispatch(Action::CloseTabs {
                    tabs: blank,
                    last_closes_window: false,
                })
                .ok();
        }
        (store, window, ids)
    }

    fn unpinned(state: &BrowserState, window: &WindowId) -> Vec<TabId> {
        model::sections(state, window.as_str())
            .unpinned
            .iter()
            .flat_map(Entry::tab_ids)
            .collect()
    }

    fn apply(store: &BrowserStore, msgs: Vec<Msg>) {
        for msg in msgs {
            if let Msg::Store(action) = msg {
                store.dispatch(action).ok();
            }
        }
    }

    #[test]
    fn by_title_sorts_case_insensitively_and_undo_puts_the_old_order_back() {
        let (store, window, ids) = store_with(&[
            ("https://c.test/", "charlie"),
            ("https://a.test/", "Alpha"),
            ("https://b.test/", "bravo"),
        ]);
        let state = store.snapshot();
        let target = SortTarget::window(&window);
        assert_eq!(sortable_count(&state, &target), 3);
        let msgs = sort_messages(&state, &target, SortKey::Title);
        assert_eq!(msgs.len(), 2);
        let undo = msgs.iter().find_map(|m| match m {
            Msg::Store(Action::PushToast { toast, .. }) => {
                assert_eq!(toast.message, "Sorted 3 Tabs");
                assert_eq!(toast.icon.as_deref(), Some("arrow.up.arrow.down"));
                toast.action.clone()
            }
            _ => None,
        });
        apply(&store, msgs);
        let state = store.snapshot();
        assert_eq!(
            unpinned(&state, &window),
            vec![ids[1].clone(), ids[2].clone(), ids[0].clone()]
        );
        assert!(!can_sort(&state, &target, SortKey::Title));
        let arg = undo
            .and_then(|a| a.strip_prefix(UNDO_SORT_PREFIX).map(str::to_owned))
            .expect("an undo");
        apply(&store, undo_messages(&state, &arg));
        assert_eq!(unpinned(&store.snapshot(), &window), ids);
    }

    #[test]
    fn by_site_puts_tabs_without_a_site_last_and_breaks_ties_by_title() {
        let (store, window, ids) = store_with(&[
            ("https://www.zeta.test/b", "Beta"),
            ("about:blank", "Blank"),
            ("https://alpha.test/", "Zed"),
            ("https://zeta.test/a", "Alpha"),
        ]);
        let state = store.snapshot();
        let plan = sort_plan(&state, &SortTarget::window(&window), SortKey::Site).expect("a plan");
        assert_eq!(
            plan.order,
            vec![
                ids[2].clone(),
                ids[3].clone(),
                ids[0].clone(),
                ids[1].clone()
            ]
        );
    }

    #[test]
    fn a_hand_move_after_the_sort_takes_undo_away() {
        let (store, window, ids) = store_with(&[
            ("https://c.test/", "c"),
            ("https://a.test/", "a"),
            ("https://b.test/", "b"),
        ]);
        let state = store.snapshot();
        let plan = sort_plan(&state, &SortTarget::window(&window), SortKey::Title).expect("a plan");
        let sorted = plan.sorted.clone();
        store
            .dispatch(Action::ArrangeTabs {
                window: window.clone(),
                tabs: plan.order,
            })
            .expect("sorted");
        assert!(can_undo_sort(&store.snapshot(), &sorted));
        store
            .dispatch(Action::ArrangeTabs {
                window,
                tabs: vec![ids[2].clone(), ids[1].clone(), ids[0].clone()],
            })
            .expect("moved");
        assert!(!can_undo_sort(&store.snapshot(), &sorted));
    }

    #[test]
    fn groups_keep_their_slot_and_their_own_tabs_sort_from_the_group_menu() {
        let (store, window, ids) = store_with(&[
            ("https://d.test/", "d"),
            ("https://c.test/", "c"),
            ("https://b.test/", "b"),
            ("https://a.test/", "a"),
        ]);
        let group = store
            .dispatch(Action::CreateGroup {
                tabs: vec![ids[1].clone(), ids[2].clone()],
                name: "G".to_owned(),
            })
            .expect("a group");
        let _ = group;
        let state = store.snapshot();
        let group_id = state.groups.keys().next().cloned().expect("group id");
        let before: Vec<String> = entries_of(&state, &SortTarget::window(&window))
            .expect("entries")
            .iter()
            .map(entry_key)
            .collect();
        let group_slot = before
            .iter()
            .position(|k| k.starts_with("group:"))
            .expect("group entry");
        apply(
            &store,
            sort_messages(&state, &SortTarget::window(&window), SortKey::Title),
        );
        let state = store.snapshot();
        let after: Vec<String> = entries_of(&state, &SortTarget::window(&window))
            .expect("entries")
            .iter()
            .map(entry_key)
            .collect();
        assert_eq!(after[group_slot], before[group_slot]);
        let inner = SortTarget::group(&window, &group_id);
        assert_eq!(sortable_count(&state, &inner), 2);
        apply(&store, sort_messages(&state, &inner, SortKey::Title));
        let state = store.snapshot();
        let members = state
            .group(group_id.as_str())
            .expect("group")
            .tab_ids
            .clone();
        assert_eq!(members, vec![ids[2].clone(), ids[1].clone()]);
        assert_eq!(
            group_command(&format!("title:{group_id}"), &window),
            Some((inner, SortKey::Title))
        );
    }

    #[test]
    fn the_menu_greys_out_an_already_sorted_list() {
        let (store, window, _) = store_with(&[("https://a.test/", "a"), ("https://b.test/", "b")]);
        let state = store.snapshot();
        let MenuEntry::Submenu(menu) = sort_menu(&state, &SortTarget::window(&window), true) else {
            panic!("a submenu");
        };
        assert_eq!(menu.title.as_ref(), "Sort Tabs");
        let titles: Vec<(String, bool)> = menu
            .children
            .iter()
            .filter_map(|c| match c {
                MenuEntry::Item(item) => Some((item.title.to_string(), item.enabled)),
                _ => None,
            })
            .collect();
        assert_eq!(
            titles,
            vec![
                ("By Site".to_owned(), false),
                ("By Title".to_owned(), false)
            ]
        );
        assert!(!menu.enabled);
    }
}
