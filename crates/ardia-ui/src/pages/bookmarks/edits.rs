use std::sync::Arc;

use ardia_state::bookmarks::{BookmarkNode, BookmarkTree, MAX_BOOKMARK_DEPTH};
pub use ardia_state::bookmarks::{BookmarkPlace as Place, RemovedBookmarks};
use ardia_state::{Action, BookmarkId, BrowserStore, Outcome, ProfileId};

pub fn folder_children(tree: &BookmarkTree, folder: &str) -> Vec<BookmarkId> {
    tree.children(folder).to_vec()
}

pub fn child_index(tree: &BookmarkTree, id: &str) -> Option<usize> {
    let parent = tree.get(id)?.parent()?.clone();
    tree.children(parent.as_str()).iter().position(|c| c == id)
}

pub fn ancestor_titles(tree: &BookmarkTree, id: &str) -> Vec<String> {
    tree.ancestors(id)
        .iter()
        .filter_map(|a| tree.get(a.as_str()).map(|n| n.title().to_owned()))
        .collect()
}

pub fn folder_links(tree: &BookmarkTree, folder: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut stack: Vec<(BookmarkId, usize)> = tree
        .children(folder)
        .iter()
        .rev()
        .map(|c| (c.clone(), 0))
        .collect();
    while let Some((id, depth)) = stack.pop() {
        match tree.get(id.as_str()) {
            Some(BookmarkNode::Url { url, title, .. }) => out.push((url.clone(), title.clone())),
            Some(BookmarkNode::Folder { children, .. }) if depth < MAX_BOOKMARK_DEPTH => {
                stack.extend(children.iter().rev().map(|c| (c.clone(), depth + 1)));
            }
            _ => {}
        }
    }
    out
}

pub fn folder_has_links(tree: &BookmarkTree, folder: &str) -> bool {
    let mut stack: Vec<(&BookmarkId, usize)> =
        tree.children(folder).iter().map(|c| (c, 0)).collect();
    while let Some((id, depth)) = stack.pop() {
        match tree.get(id.as_str()) {
            Some(BookmarkNode::Url { .. }) => return true,
            Some(BookmarkNode::Folder { children, .. }) if depth < MAX_BOOKMARK_DEPTH => {
                stack.extend(children.iter().map(|c| (c, depth + 1)));
            }
            _ => {}
        }
    }
    false
}

pub fn links_of(tree: &BookmarkTree, ids: &[BookmarkId]) -> Vec<(String, String)> {
    ids.iter()
        .flat_map(|id| match tree.get(id.as_str()) {
            Some(BookmarkNode::Url { url, title, .. }) => vec![(url.clone(), title.clone())],
            Some(BookmarkNode::Folder { .. }) => folder_links(tree, id.as_str()),
            None => Vec::new(),
        })
        .collect()
}

fn apply(store: &Arc<BrowserStore>, action: Action) -> Option<Outcome> {
    match store.dispatch(action) {
        Ok(outcome) => Some(outcome),
        Err(problem) => {
            log::debug!("bookmark edit changed nothing: {problem}");
            None
        }
    }
}

pub fn rename(
    store: &Arc<BrowserStore>,
    profile: &ProfileId,
    id: &BookmarkId,
    title: &str,
) -> bool {
    apply(
        store,
        Action::RenameBookmark {
            profile: profile.clone(),
            id: id.clone(),
            title: title.to_owned(),
        },
    )
    .is_some()
}

pub fn update(
    store: &Arc<BrowserStore>,
    profile: &ProfileId,
    id: &BookmarkId,
    title: &str,
    url: Option<&str>,
) -> bool {
    apply(
        store,
        Action::UpdateBookmark {
            profile: profile.clone(),
            id: id.clone(),
            title: Some(title.to_owned()),
            url: url.map(str::to_owned),
        },
    )
    .is_some()
}

pub fn add_folder(
    store: &Arc<BrowserStore>,
    profile: &ProfileId,
    parent: &BookmarkId,
    index: Option<usize>,
    title: &str,
) -> Option<BookmarkId> {
    apply(
        store,
        Action::AddBookmarkFolder {
            profile: profile.clone(),
            parent: Some(parent.clone()),
            title: title.to_owned(),
            index,
        },
    )?
    .bookmark
}

pub fn add_folder_to_bar(
    store: &Arc<BrowserStore>,
    profile: &ProfileId,
    title: &str,
) -> Option<BookmarkId> {
    apply(
        store,
        Action::AddBookmarkFolder {
            profile: profile.clone(),
            parent: None,
            title: title.to_owned(),
            index: None,
        },
    )?
    .bookmark
}

pub fn add_url_to_bar(
    store: &Arc<BrowserStore>,
    profile: &ProfileId,
    title: &str,
    url: &str,
) -> Option<BookmarkId> {
    apply(
        store,
        Action::AddBookmarkAt {
            profile: profile.clone(),
            parent: None,
            index: None,
            title: title.to_owned(),
            url: url.to_owned(),
        },
    )?
    .bookmark
}

pub fn add_url(
    store: &Arc<BrowserStore>,
    profile: &ProfileId,
    parent: &BookmarkId,
    index: Option<usize>,
    title: &str,
    url: &str,
) -> Option<BookmarkId> {
    apply(
        store,
        Action::AddBookmarkAt {
            profile: profile.clone(),
            parent: Some(parent.clone()),
            index,
            title: title.to_owned(),
            url: url.to_owned(),
        },
    )?
    .bookmark
}

pub fn move_many(
    store: &Arc<BrowserStore>,
    profile: &ProfileId,
    ids: &[BookmarkId],
    parent: &BookmarkId,
    index: Option<usize>,
) -> bool {
    apply(
        store,
        Action::MoveBookmarks {
            profile: profile.clone(),
            ids: ids.to_vec(),
            parent: parent.clone(),
            index,
        },
    )
    .is_some()
}

pub fn remove_many(
    store: &Arc<BrowserStore>,
    profile: &ProfileId,
    ids: &[BookmarkId],
) -> Option<RemovedBookmarks> {
    let removed = store
        .snapshot()
        .bookmarks_of(profile)
        .map(|tree| tree.removal_of(ids))?;
    if removed.places.is_empty() {
        return None;
    }
    apply(
        store,
        Action::RemoveBookmarks {
            profile: profile.clone(),
            ids: ids.to_vec(),
        },
    )?;
    Some(removed)
}

pub fn restore(store: &Arc<BrowserStore>, profile: &ProfileId, removed: RemovedBookmarks) -> bool {
    apply(
        store,
        Action::RestoreBookmarks {
            profile: profile.clone(),
            removed,
        },
    )
    .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::BrowserState;
    use ardia_state::ids::IdGen;

    fn store() -> (Arc<BrowserStore>, ProfileId, Vec<BookmarkId>) {
        let store = Arc::new(BrowserStore::in_memory(
            BrowserState::default(),
            IdGen::with_launch("bm-test"),
        ));
        let profile = ProfileId::new("default");
        let made = ["a", "b", "c", "d"]
            .iter()
            .map(|name| {
                apply(
                    &store,
                    Action::AddBookmarkAt {
                        profile: profile.clone(),
                        parent: None,
                        index: None,
                        title: (*name).to_owned(),
                        url: format!("https://{name}.example/"),
                    },
                )
                .and_then(|outcome| outcome.bookmark)
                .unwrap()
            })
            .collect();
        (store, profile, made)
    }

    fn bar(store: &Arc<BrowserStore>, profile: &ProfileId) -> BookmarkId {
        store.snapshot().bookmarks_of(profile).unwrap().bar()
    }

    fn titles(store: &Arc<BrowserStore>, profile: &ProfileId, folder: &BookmarkId) -> Vec<String> {
        let state = store.snapshot();
        let tree = state.bookmarks_of(profile).unwrap();
        tree.children(folder.as_str())
            .iter()
            .map(|id| tree.get(id.as_str()).unwrap().title().to_owned())
            .collect()
    }

    #[test]
    fn moving_several_keeps_their_order_at_the_drop_index() {
        let (store, profile, ids) = store();
        let bar = bar(&store, &profile);
        assert!(move_many(&store, &profile, &ids[..2], &bar, Some(2)));
        assert_eq!(titles(&store, &profile, &bar), ["c", "d", "a", "b"]);
        assert!(move_many(
            &store,
            &profile,
            &[ids[3].clone()],
            &bar,
            Some(0)
        ));
        assert_eq!(titles(&store, &profile, &bar), ["d", "c", "a", "b"]);
    }

    #[test]
    fn folders_never_move_into_themselves() {
        let (store, profile, _) = store();
        let bar = bar(&store, &profile);
        let outer = add_folder(&store, &profile, &bar, None, "outer").unwrap();
        let inner = add_folder(&store, &profile, &outer, None, "inner").unwrap();
        assert!(!move_many(
            &store,
            &profile,
            std::slice::from_ref(&outer),
            &inner,
            None
        ));
        let other = store.snapshot().bookmarks_of(&profile).unwrap().other();
        assert!(move_many(
            &store,
            &profile,
            &[outer.clone(), inner],
            &other,
            None
        ));
        assert_eq!(titles(&store, &profile, &other), ["outer"]);
        assert_eq!(titles(&store, &profile, &outer), ["inner"]);
    }

    #[test]
    fn removal_can_be_undone_in_place() {
        let (store, profile, made) = store();
        let bar = bar(&store, &profile);
        let folder = add_folder(&store, &profile, &bar, Some(1), "f").unwrap();
        add_url(
            &store,
            &profile,
            &folder,
            None,
            "inside",
            "https://in.example/",
        )
        .unwrap();
        let removed = remove_many(&store, &profile, &[folder.clone(), made[2].clone()]).unwrap();
        assert_eq!(removed.places.len(), 2);
        assert_eq!(titles(&store, &profile, &bar), ["a", "b", "d"]);
        assert!(restore(&store, &profile, removed));
        assert_eq!(titles(&store, &profile, &bar), ["a", "f", "b", "c", "d"]);
        assert_eq!(titles(&store, &profile, &folder), ["inside"]);
    }

    #[test]
    fn edits_change_title_and_address() {
        let (store, profile, made) = store();
        assert!(update(
            &store,
            &profile,
            &made[0],
            "Renamed",
            Some("https://new.example/")
        ));
        let state = store.snapshot();
        let tree = state.bookmarks_of(&profile).unwrap();
        match tree.get(made[0].as_str()).unwrap() {
            BookmarkNode::Url { title, url, .. } => {
                assert_eq!(title, "Renamed");
                assert_eq!(url, "https://new.example/");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn links_flatten_folders_in_order() {
        let (store, profile, made) = store();
        let bar = bar(&store, &profile);
        let folder = add_folder(&store, &profile, &bar, None, "f").unwrap();
        add_url(&store, &profile, &folder, None, "x", "https://x.example/").unwrap();
        let state = store.snapshot();
        let tree = state.bookmarks_of(&profile).unwrap();
        let links = links_of(tree, &[made[1].clone(), folder]);
        let urls: Vec<&str> = links.iter().map(|(u, _)| u.as_str()).collect();
        assert_eq!(urls, ["https://b.example/", "https://x.example/"]);
        assert_eq!(folder_links(tree, bar.as_str()).len(), 5);
        assert!(folder_has_links(tree, bar.as_str()));
    }
}
