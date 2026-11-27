use std::collections::HashSet;
use std::sync::Arc;

use ardia_state::GroupId;
use ardia_state::bookmarks::{BookmarkNode, BookmarkTree};
use ardia_state::tabs::TabSnapshot;
use ardia_state::windows::WindowKind;
use ardia_state::{
    Action, BookmarkId, BrowserState, GroupPatch, NewTab, ProfileId, TabId, WindowId,
};

use crate::host::UiHost;
use crate::pages::bookmarks::edits;

pub const ARC_HOLDER: &str = " (Arc)";
pub const MAX_DRAFT_LINKS: usize = 5000;

fn opens(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

fn page_key(url: &str) -> String {
    url.split('#').next().unwrap_or(url).to_owned()
}

pub fn makes_group(tree: &BookmarkTree, folder: &BookmarkId) -> bool {
    edits::folder_links(tree, folder.as_str())
        .iter()
        .any(|(url, _)| opens(url))
}

pub fn restorable_arc_holder(tree: &BookmarkTree, folder: &BookmarkId) -> bool {
    let Some(BookmarkNode::Folder {
        title,
        parent_id,
        children,
        ..
    }) = tree.get(folder.as_str())
    else {
        return false;
    };
    title.ends_with(ARC_HOLDER)
        && parent_id.as_ref() == Some(&tree.bar())
        && children.iter().any(|c| {
            matches!(tree.get(c.as_str()), Some(BookmarkNode::Folder { .. }))
                && makes_group(tree, c)
        })
}

fn pinned_pages(state: &BrowserState, profile: &ProfileId) -> HashSet<String> {
    let grouped: HashSet<&TabId> = state
        .groups
        .values()
        .filter(|g| g.pinned)
        .flat_map(|g| g.tab_ids.iter())
        .collect();
    state
        .tabs
        .values()
        .filter(|t| &t.profile_id == profile && (t.pin.is_some() || grouped.contains(&t.id)))
        .map(|t| page_key(&t.url))
        .collect()
}

fn main_window(
    state: &BrowserState,
    profile: &ProfileId,
    near: Option<&WindowId>,
) -> Option<WindowId> {
    if let Some(near) = near
        && state
            .window(near.as_str())
            .is_some_and(|w| w.kind == WindowKind::Main && &w.profile_id == profile)
    {
        return Some(near.clone());
    }
    state
        .focus_order
        .iter()
        .chain(state.window_order.iter())
        .find(|id| {
            state
                .window(id.as_str())
                .is_some_and(|w| w.kind == WindowKind::Main && &w.profile_id == profile)
        })
        .cloned()
}

fn snapshot(url: &str, title: &str, profile: &ProfileId) -> Option<TabSnapshot> {
    serde_json::from_value(serde_json::json!({
        "url": url,
        "title": title,
        "profileId": profile.as_str(),
    }))
    .ok()
}

fn new_tab_in(
    host: &Arc<dyn UiHost>,
    window: &WindowId,
    url: &str,
    title: &str,
    profile: &ProfileId,
) -> Option<TabId> {
    let before: HashSet<TabId> = host
        .store()
        .snapshot()
        .window(window.as_str())
        .map(|w| w.tab_ids.iter().cloned().collect())
        .unwrap_or_default();
    host.dispatch(Action::NewTab {
        window: window.clone(),
        tab: NewTab {
            background: true,
            snapshot: snapshot(url, title, profile).map(Box::new),
            ..NewTab::default()
        },
    });
    host.store()
        .snapshot()
        .window(window.as_str())?
        .tab_ids
        .iter()
        .find(|id| !before.contains(*id))
        .cloned()
}

fn newest_group(host: &Arc<dyn UiHost>, before: &HashSet<GroupId>) -> Option<GroupId> {
    host.store()
        .snapshot()
        .groups
        .keys()
        .find(|id| !before.contains(*id))
        .cloned()
}

pub struct Made {
    pub groups: Vec<GroupId>,
    pub carried: HashSet<BookmarkId>,
    pub skipped: usize,
    pub window: Option<WindowId>,
}

struct Planned {
    name: String,
    tabs: Vec<TabId>,
    children: Vec<Planned>,
}

struct Planner<'a> {
    host: &'a Arc<dyn UiHost>,
    tree: &'a BookmarkTree,
    window: &'a WindowId,
    profile: &'a ProfileId,
    seen: HashSet<String>,
    taken: usize,
    made: &'a mut Made,
}

impl Planner<'_> {
    fn plan(&mut self, folder: &BookmarkId, depth: usize) -> Planned {
        let mut planned = Planned {
            name: self
                .tree
                .get(folder.as_str())
                .map(|n| n.title().to_owned())
                .unwrap_or_default(),
            tabs: Vec::new(),
            children: Vec::new(),
        };
        if depth > 64 {
            return planned;
        }
        for child in self.tree.children(folder.as_str()).to_vec() {
            match self.tree.get(child.as_str()) {
                Some(BookmarkNode::Folder { .. }) => {
                    let nested = self.plan(&child, depth + 1);
                    if !nested.tabs.is_empty() {
                        planned.tabs.extend(nested.tabs.iter().cloned());
                        planned.children.push(nested);
                    }
                }
                Some(BookmarkNode::Url { url, title, .. }) => {
                    if !opens(url) || self.seen.contains(&page_key(url)) {
                        continue;
                    }
                    if self.taken >= MAX_DRAFT_LINKS {
                        self.made.skipped += 1;
                        continue;
                    }
                    self.taken += 1;
                    self.seen.insert(page_key(url));
                    if let Some(tab) = new_tab_in(self.host, self.window, url, title, self.profile)
                    {
                        planned.tabs.push(tab);
                        self.made.carried.insert(child.clone());
                    }
                }
                None => {}
            }
        }
        planned
    }
}

fn make_group(
    host: &Arc<dyn UiHost>,
    planned: &Planned,
    collapsed: bool,
    pin: bool,
) -> Option<GroupId> {
    let before: HashSet<GroupId> = host.store().snapshot().groups.keys().cloned().collect();
    host.dispatch(Action::CreateGroup {
        tabs: planned.tabs.clone(),
        name: planned.name.clone(),
    });
    let group = newest_group(host, &before)?;
    host.dispatch(Action::UpdateGroup {
        group: group.clone(),
        patch: GroupPatch {
            pinned: pin.then_some(true),
            collapsed: Some(collapsed),
            ..GroupPatch::default()
        },
    });
    for child in &planned.children {
        make_group(host, child, collapsed, false);
    }
    Some(group)
}

pub fn add_folder_groups(
    host: &Arc<dyn UiHost>,
    near: Option<&WindowId>,
    profile: &ProfileId,
    folders: &[BookmarkId],
    collapsed: bool,
) -> Made {
    let mut made = Made {
        groups: Vec::new(),
        carried: HashSet::new(),
        skipped: 0,
        window: None,
    };
    let state = host.store().snapshot();
    let Some(tree) = state.bookmarks_of(profile).cloned() else {
        return made;
    };
    let window = match main_window(&state, profile, near) {
        Some(window) => window,
        None => {
            host.dispatch(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: Some(profile.clone()),
                url: None,
                frame: None,
            });
            match main_window(&host.store().snapshot(), profile, None) {
                Some(window) => window,
                None => return made,
            }
        }
    };
    made.window = Some(window.clone());
    let seen = pinned_pages(&state, profile);
    let mut plans = Vec::new();
    {
        let mut planner = Planner {
            host,
            tree: &tree,
            window: &window,
            profile,
            seen,
            taken: 0,
            made: &mut made,
        };
        for folder in folders {
            if !matches!(tree.get(folder.as_str()), Some(BookmarkNode::Folder { .. })) {
                continue;
            }
            planner.taken = 0;
            let planned = planner.plan(folder, 0);
            if !planned.tabs.is_empty() {
                plans.push(planned);
            }
        }
    }
    for planned in &plans {
        if let Some(group) = make_group(host, planned, collapsed, true) {
            host.dispatch(Action::SleepTabs {
                tabs: planned.tabs.clone(),
            });
            made.groups.push(group);
        }
    }
    made
}

pub fn note_left_out(host: &Arc<dyn UiHost>, made: &Made) {
    let Some(window) = made.window.clone().filter(|_| made.skipped > 0) else {
        return;
    };
    host.dispatch(Action::PushToast {
        window,
        toast: crate::popovers::toast::toast(
            left_out_message(made.skipped),
            ardia_state::windows::ToastKind::Info,
            None,
            ardia_state::store::now_ms(),
        ),
    });
}

pub fn left_out_message(skipped: usize) -> String {
    let links = if skipped == 1 {
        "1 link".to_owned()
    } else {
        format!("{skipped} links")
    };
    format!("{links} left out\nA folder brings up to 5,000 links.")
}

pub fn carried_over(
    tree: &BookmarkTree,
    id: &BookmarkId,
    carried: &HashSet<BookmarkId>,
) -> (bool, Vec<BookmarkId>) {
    match tree.get(id.as_str()) {
        Some(BookmarkNode::Url { .. }) => {
            if carried.contains(id) {
                (true, vec![id.clone()])
            } else {
                (false, Vec::new())
            }
        }
        Some(BookmarkNode::Folder { children, .. }) => {
            let parts: Vec<(bool, Vec<BookmarkId>)> = children
                .iter()
                .map(|c| carried_over(tree, c, carried))
                .collect();
            if !children.is_empty() && parts.iter().all(|(whole, _)| *whole) {
                (true, vec![id.clone()])
            } else {
                (false, parts.into_iter().flat_map(|(_, ids)| ids).collect())
            }
        }
        None => (false, Vec::new()),
    }
}

pub fn restore_arc_folders(
    host: &Arc<dyn UiHost>,
    holder: &BookmarkId,
    near: Option<&WindowId>,
    profile: &ProfileId,
) -> Vec<GroupId> {
    let state = host.store().snapshot();
    let Some(tree) = state.bookmarks_of(profile).cloned() else {
        return Vec::new();
    };
    if !restorable_arc_holder(&tree, holder) {
        return Vec::new();
    }
    let folders: Vec<BookmarkId> = tree
        .children(holder.as_str())
        .iter()
        .filter(|c| {
            matches!(tree.get(c.as_str()), Some(BookmarkNode::Folder { .. }))
                && makes_group(&tree, c)
        })
        .cloned()
        .collect();
    let made = add_folder_groups(host, near, profile, &folders, true);
    note_left_out(host, &made);
    let doomed: Vec<BookmarkId> = folders
        .iter()
        .flat_map(|f| carried_over(&tree, f, &made.carried).1)
        .collect();
    let holder = holder.clone();
    edits::remove_many(host.store(), profile, &doomed);
    let emptied = host
        .store()
        .snapshot()
        .bookmarks_of(profile)
        .is_some_and(|tree| tree.children(holder.as_str()).is_empty());
    if emptied {
        edits::remove_many(host.store(), profile, std::slice::from_ref(&holder));
    }
    made.groups
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::ids::IdGen;

    #[test]
    fn arc_holders_and_carried_folders() {
        let ids = IdGen::with_launch("g");
        let mut tree = BookmarkTree::new("p", 0);
        let bar = tree.bar();
        let holder = tree.add_folder(&ids, &bar, None, "Space (Arc)", 0).unwrap();
        let space = tree.add_folder(&ids, &holder, None, "Work", 0).unwrap();
        let a = tree
            .add_url(&ids, &space, None, "a", "https://a.example/", 0)
            .unwrap();
        let b = tree
            .add_url(&ids, &space, None, "b", "https://b.example/", 0)
            .unwrap();
        assert!(restorable_arc_holder(&tree, &holder));
        assert!(!restorable_arc_holder(&tree, &space));
        assert!(makes_group(&tree, &space));
        let all = HashSet::from([a.clone(), b]);
        assert_eq!(
            carried_over(&tree, &space, &all),
            (true, vec![space.clone()])
        );
        let some = HashSet::from([a.clone()]);
        assert_eq!(carried_over(&tree, &space, &some), (false, vec![a]));
    }
}
