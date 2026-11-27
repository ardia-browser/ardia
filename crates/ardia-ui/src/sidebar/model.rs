use std::collections::HashSet;
use std::sync::Arc;

use ardia_state::groups::{self, TabGroup};
use ardia_state::splits::SplitView;
use ardia_state::tabs::Tab;
use ardia_state::{BrowserState, GroupId, TabId};

#[derive(Clone, Debug)]
pub enum Entry {
    Tab {
        tab: Arc<Tab>,
        depth: usize,
    },
    Split {
        split: Arc<SplitView>,
        tabs: Vec<Arc<Tab>>,
        depth: usize,
    },
    Group {
        group: Arc<TabGroup>,
        depth: usize,
        count: usize,
        children: Vec<Entry>,
    },
}

impl Entry {
    pub fn tab_ids(&self) -> Vec<TabId> {
        match self {
            Entry::Tab { tab, .. } => vec![tab.id.clone()],
            Entry::Split { tabs, .. } => tabs.iter().map(|t| t.id.clone()).collect(),
            Entry::Group { children, .. } => children.iter().flat_map(Entry::tab_ids).collect(),
        }
    }

    pub fn rows(&self) -> usize {
        match self {
            Entry::Tab { .. } | Entry::Split { .. } => 1,
            Entry::Group {
                group, children, ..
            } => {
                1 + if group.collapsed {
                    0
                } else {
                    children.iter().map(Entry::rows).sum()
                }
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Sections {
    pub tiles: Vec<Arc<Tab>>,
    pub pinned: Vec<Entry>,
    pub unpinned: Vec<Entry>,
    pub generation: u64,
}

impl Sections {
    pub fn unpinned_count(&self) -> usize {
        self.unpinned.iter().map(|e| e.tab_ids().len()).sum()
    }

    pub fn ordered_tabs(&self) -> Vec<TabId> {
        let mut out: Vec<TabId> = self.tiles.iter().map(|t| t.id.clone()).collect();
        for entry in self.pinned.iter().chain(&self.unpinned) {
            out.extend(entry.tab_ids());
        }
        out
    }
}

fn group_chain(state: &BrowserState, tab: &str) -> Vec<GroupId> {
    let Some(innermost) = groups::innermost_group_of(&state.groups, tab) else {
        return Vec::new();
    };
    let mut chain = groups::ancestors(&state.groups, innermost.as_str());
    chain.reverse();
    chain.push(innermost);
    chain
}

struct Open {
    group: Arc<TabGroup>,
    depth: usize,
    children: Vec<Entry>,
}

fn close(stack: &mut Vec<Open>, out: &mut Vec<Entry>) {
    if let Some(open) = stack.pop() {
        let count = open
            .children
            .iter()
            .map(|e| e.tab_ids().len())
            .sum::<usize>();
        let entry = Entry::Group {
            group: open.group,
            depth: open.depth,
            count,
            children: open.children,
        };
        match stack.last_mut() {
            Some(parent) => parent.children.push(entry),
            None => out.push(entry),
        }
    }
}

fn push(stack: &mut [Open], out: &mut Vec<Entry>, entry: Entry) {
    match stack.last_mut() {
        Some(parent) => parent.children.push(entry),
        None => out.push(entry),
    }
}

fn build(state: &BrowserState, tabs: &[Arc<Tab>]) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut stack: Vec<Open> = Vec::new();
    let mut seen_splits: HashSet<String> = HashSet::new();
    for tab in tabs {
        let chain = group_chain(state, tab.id.as_str());
        let shared = stack
            .iter()
            .zip(&chain)
            .take_while(|(open, id)| &open.group.id == *id)
            .count();
        while stack.len() > shared {
            close(&mut stack, &mut out);
        }
        for id in &chain[shared..] {
            if let Some(group) = state.group(id.as_str()) {
                stack.push(Open {
                    group: Arc::clone(group),
                    depth: stack.len(),
                    children: Vec::new(),
                });
            }
        }
        let depth = stack.len();
        match state.split_of(tab.id.as_str()) {
            Some(split) => {
                if seen_splits.insert(split.id.to_string()) {
                    let members: Vec<Arc<Tab>> = split
                        .tab_ids()
                        .iter()
                        .filter_map(|id| state.tab(id.as_str()).cloned())
                        .collect();
                    push(
                        &mut stack,
                        &mut out,
                        Entry::Split {
                            split: Arc::clone(split),
                            tabs: members,
                            depth,
                        },
                    );
                }
            }
            None => push(
                &mut stack,
                &mut out,
                Entry::Tab {
                    tab: Arc::clone(tab),
                    depth,
                },
            ),
        }
    }
    while !stack.is_empty() {
        close(&mut stack, &mut out);
    }
    out
}

pub fn sections(state: &BrowserState, window: &str) -> Sections {
    sections_for(state, window, None)
}

struct SectionsMemo {
    windows: Arc<ardia_state::state::WindowMap>,
    tabs: Arc<ardia_state::state::TabMap>,
    groups: Arc<ardia_state::groups::Groups>,
    splits: Arc<ardia_state::state::SplitMap>,
    hides_empty_cards: bool,
    sections: std::rc::Rc<Sections>,
}

type SectionsKey = (String, Option<ardia_state::ProfileId>);

thread_local! {
    static SECTIONS: std::cell::RefCell<std::collections::HashMap<SectionsKey, SectionsMemo>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static GENERATION: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

pub fn sections_for(
    state: &BrowserState,
    window: &str,
    profile: Option<&ardia_state::ProfileId>,
) -> Sections {
    (*shared_sections_for(state, window, profile)).clone()
}

pub fn shared_sections(state: &BrowserState, window: &str) -> std::rc::Rc<Sections> {
    shared_sections_for(state, window, None)
}

pub fn shared_sections_for(
    state: &BrowserState,
    window: &str,
    profile: Option<&ardia_state::ProfileId>,
) -> std::rc::Rc<Sections> {
    let key = (window.to_owned(), profile.cloned());
    let cached = SECTIONS.with(|memo| {
        memo.borrow().get(&key).and_then(|m| {
            (Arc::ptr_eq(&m.windows, &state.windows)
                && Arc::ptr_eq(&m.tabs, &state.tabs)
                && Arc::ptr_eq(&m.groups, &state.groups)
                && Arc::ptr_eq(&m.splits, &state.splits)
                && m.hides_empty_cards == state.new_tab_opens_bar())
            .then(|| m.sections.clone())
        })
    });
    if let Some(sections) = cached {
        return sections;
    }
    let generation = GENERATION.with(|g| {
        g.set(g.get() + 1);
        g.get()
    });
    let sections = std::rc::Rc::new(Sections {
        generation,
        ..build_sections(state, window, profile)
    });
    SECTIONS.with(|memo| {
        let mut memo = memo.borrow_mut();
        memo.retain(|_, m| Arc::ptr_eq(&m.tabs, &state.tabs));
        memo.insert(
            key,
            SectionsMemo {
                windows: Arc::clone(&state.windows),
                tabs: Arc::clone(&state.tabs),
                groups: Arc::clone(&state.groups),
                splits: Arc::clone(&state.splits),
                hides_empty_cards: state.new_tab_opens_bar(),
                sections: sections.clone(),
            },
        );
    });
    sections
}

fn build_sections(
    state: &BrowserState,
    window: &str,
    profile: Option<&ardia_state::ProfileId>,
) -> Sections {
    let tabs: Vec<Arc<Tab>> = state
        .view_tabs(window, profile)
        .into_iter()
        .filter(|t| !t.live.peek && !state.hidden_empty_card(t))
        .cloned()
        .collect();
    let pinned_members = groups::pinned_group_members(&state.groups);
    let mut tiles = Vec::new();
    let mut pinned = Vec::new();
    let mut unpinned = Vec::new();
    for tab in tabs {
        match &tab.pin {
            Some(pin) if pin.is_tile() => tiles.push(tab),
            Some(_) => pinned.push(tab),
            None if pinned_members.contains(&tab.id) => pinned.push(tab),
            None => unpinned.push(tab),
        }
    }
    Sections {
        pinned: build(state, &pinned),
        unpinned: build(state, &unpinned),
        tiles,
        generation: 0,
    }
}

pub fn clearable(state: &BrowserState, window: &str) -> Vec<TabId> {
    clearable_in(&sections(state, window), state, window)
}

pub fn clearable_in(sections: &Sections, state: &BrowserState, window: &str) -> Vec<TabId> {
    let active = state.active_tab(window).map(|t| t.id.clone());
    sections
        .unpinned
        .iter()
        .flat_map(Entry::tab_ids)
        .filter(|id| Some(id) != active.as_ref())
        .filter(|id| state.tab(id.as_str()).is_some_and(|t| !t.live.audible))
        .collect()
}

pub fn entry_holds(entry: &Entry, tab: &TabId) -> bool {
    match entry {
        Entry::Tab { tab: t, .. } => &t.id == tab,
        Entry::Split { tabs, .. } => tabs.iter().any(|t| &t.id == tab),
        Entry::Group { group, .. } => group.tab_ids.contains(tab),
    }
}

fn page_active(state: &BrowserState, window: &str, group: &TabGroup) -> Option<TabId> {
    state
        .window(window)?
        .active_tab_ids
        .get(&group.profile_id)
        .cloned()
}

pub fn kept_children(
    state: &BrowserState,
    window: &str,
    group: &TabGroup,
    children: &[Entry],
) -> Vec<bool> {
    let mut held: Vec<TabId> = page_active(state, window, group).into_iter().collect();
    held.extend(group.shown_tab_ids.iter().flatten().cloned());
    children
        .iter()
        .map(|child| held.iter().any(|id| entry_holds(child, id)))
        .collect()
}

pub fn shows_extra_tabs(
    state: &BrowserState,
    window: &str,
    group: &TabGroup,
    children: &[Entry],
) -> bool {
    let active = page_active(state, window, group);
    let kept = kept_children(state, window, group, children);
    children
        .iter()
        .zip(kept)
        .filter(|(_, kept)| *kept)
        .any(|(child, _)| match active.as_ref() {
            Some(active) if entry_holds(child, active) => matches!(
                child,
                Entry::Group { group: inner, children: inner_children, .. }
                    if inner.collapsed && shows_extra_tabs(state, window, inner, inner_children)
            ),
            _ => true,
        })
}

pub fn head_gap(first: Option<&Entry>) -> f32 {
    if matches!(first, Some(Entry::Group { .. })) {
        ardia_theme::layout::sidebar::row_gap()
    } else {
        0.0
    }
}

pub fn members_pad_bottom(shown: usize) -> f32 {
    use ardia_theme::layout::sidebar;
    if shown > 0 {
        sidebar::GROUP_INSET - sidebar::GROUP_BORDER
    } else {
        0.0
    }
}

pub fn stack_height(heights: &[f32], first: Option<&Entry>) -> f32 {
    if heights.is_empty() {
        return 0.0;
    }
    let gap = ardia_theme::layout::sidebar::row_gap();
    head_gap(first)
        + heights.iter().sum::<f32>()
        + gap * (heights.len() - 1) as f32
        + members_pad_bottom(heights.len())
}

pub fn entry_height(state: &BrowserState, window: &str, entry: &Entry) -> f32 {
    use ardia_theme::layout::sidebar;
    match entry {
        Entry::Tab { .. } | Entry::Split { .. } => sidebar::row_height(),
        Entry::Group {
            group, children, ..
        } => {
            let shown: Vec<&Entry> = if group.collapsed {
                let kept = kept_children(state, window, group, children);
                children
                    .iter()
                    .zip(kept)
                    .filter(|(_, k)| *k)
                    .map(|(c, _)| c)
                    .collect()
            } else {
                children.iter().collect()
            };
            let heights: Vec<f32> = shown
                .iter()
                .map(|c| entry_height(state, window, c))
                .collect();
            sidebar::GROUP_BORDER * 2.0
                + sidebar::row_height()
                + stack_height(&heights, shown.first().copied())
        }
    }
}

pub fn grid_columns(count: usize, inner_width: f32) -> (usize, f32) {
    const MIN_TILE: f32 = 50.0;
    const GAP: f32 = ardia_theme::layout::sidebar::PINNED_TILE_GAP;
    let fit = (((inner_width + GAP) / (MIN_TILE + GAP)).floor() as usize).max(1);
    let columns = count.clamp(1, fit);
    let width = ((inner_width - GAP * (columns as f32 - 1.0)) / columns as f32 * 2.0).floor() / 2.0;
    (columns, width.max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::actions::{Action, NewTab};
    use ardia_state::ids::IdGen;
    use ardia_state::model::TabPin;
    use ardia_state::persistence::session::{LoadOptions, SessionData};
    use ardia_state::windows::WindowKind;

    struct World {
        state: BrowserState,
        ids: IdGen,
        now: i64,
    }

    impl World {
        fn new() -> World {
            World {
                state: BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 0),
                ids: IdGen::with_launch("model"),
                now: 1_000,
            }
        }

        fn act(&mut self, action: Action) -> ardia_state::Outcome {
            self.now += 1_000;
            self.state.apply(action, self.now, &self.ids).expect("acts")
        }
    }

    fn tab(world: &mut World, window: &ardia_state::WindowId, url: &str) -> TabId {
        world
            .act(Action::NewTab {
                window: window.clone(),
                tab: NewTab {
                    url: Some(url.into()),
                    ..NewTab::default()
                },
            })
            .tab
            .expect("a tab")
    }

    #[test]
    fn empty_cards_leave_the_sidebar_and_strip_when_new_tab_opens_the_bar() {
        let mut world = World::new();
        let window = world
            .act(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: Some("https://a.example".into()),
                frame: None,
            })
            .window
            .expect("a window");
        let card = tab(&mut world, &window, "");
        let listed = |w: &World| {
            let in_rows = shared_sections(&w.state, window.as_str())
                .unpinned
                .iter()
                .flat_map(Entry::tab_ids)
                .any(|id| id == card);
            let in_strip = crate::sidebar::strip_layout::strip_entries(&w.state, window.as_str())
                .into_iter()
                .flat_map(|e| match e {
                    crate::sidebar::strip_layout::Entry::Dock(ids) => ids,
                    crate::sidebar::strip_layout::Entry::Group { members, .. } => {
                        members.iter().flat_map(|m| m.tabs()).collect()
                    }
                    crate::sidebar::strip_layout::Entry::Member(m) => m.tabs(),
                })
                .any(|id| id == card);
            (in_rows, in_strip)
        };
        let setting = |w: &mut World, key: &str, value: serde_json::Value| {
            w.act(Action::UpdateSettings {
                patch: ardia_state::settings::SettingsPatch::new().set(key, value),
                from_sync: false,
            });
        };
        setting(&mut world, "newTabOpens", "page".into());
        assert_eq!(listed(&world), (true, true));
        setting(&mut world, "newTabOpens", "commandBar".into());
        assert_eq!(listed(&world), (false, false));
        setting(&mut world, "newTabOpens", "page".into());
        setting(&mut world, "minimalismMode", true.into());
        assert_eq!(listed(&world), (false, false));
    }

    #[test]
    fn sections_split_tiles_pins_groups_and_rows() {
        let mut world = World::new();
        let window = world
            .act(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: Some("https://a.example".into()),
                frame: None,
            })
            .window
            .expect("a window");
        let b = tab(&mut world, &window, "https://b.example");
        let c = tab(&mut world, &window, "https://c.example");
        let d = tab(&mut world, &window, "https://d.example");
        let e = tab(&mut world, &window, "https://e.example");
        let f = tab(&mut world, &window, "https://f.example");
        world.act(Action::SetPin {
            tab: b.clone(),
            pin: Some(TabPin::TILE),
        });
        world.act(Action::CreateGroup {
            tabs: vec![c.clone(), d.clone()],
            name: "Work".into(),
        });
        world.act(Action::SplitTabs {
            tabs: vec![e.clone(), f.clone()],
            orientation: ardia_state::model::Orientation::Horizontal,
        });
        let sections = sections(&world.state, window.as_str());
        assert_eq!(sections.tiles.len(), 1);
        assert_eq!(sections.tiles[0].id, b);
        assert!(sections.pinned.is_empty());
        let groups: Vec<&Entry> = sections
            .unpinned
            .iter()
            .filter(|e| matches!(e, Entry::Group { .. }))
            .collect();
        assert_eq!(groups.len(), 1);
        if let Entry::Group {
            count, children, ..
        } = groups[0]
        {
            assert!(*count >= 1);
            assert!(!children.is_empty());
        }
        let splits = sections
            .unpinned
            .iter()
            .filter(|e| matches!(e, Entry::Split { tabs, .. } if tabs.len() == 2))
            .count();
        assert_eq!(splits, 1);
        let all = sections.ordered_tabs();
        assert_eq!(all.iter().filter(|id| **id == c).count(), 1);
        assert!(all.contains(&e) && all.contains(&d) && all.contains(&f));
    }

    #[test]
    fn clearing_keeps_the_selected_and_audible_tabs() {
        let mut world = World::new();
        let window = world
            .act(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: Some("https://a.example".into()),
                frame: None,
            })
            .window
            .expect("a window");
        let b = tab(&mut world, &window, "https://b.example");
        let c = tab(&mut world, &window, "https://c.example");
        world.act(Action::UpdatePage {
            tab: b.clone(),
            update: ardia_state::PageUpdate {
                audible: Some(true),
                ..Default::default()
            },
        });
        let ids = clearable(&world.state, window.as_str());
        assert!(!ids.contains(&b));
        assert!(!ids.contains(&c));
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn pinned_grid_columns_follow_the_sidebar_width() {
        assert_eq!(grid_columns(5, 172.0), (3, 53.0));
        assert_eq!(grid_columns(2, 172.0), (2, 83.0));
        assert_eq!(grid_columns(8, 230.0), (4, 53.0));
        assert_eq!(grid_columns(0, 172.0).0, 1);
    }
}
