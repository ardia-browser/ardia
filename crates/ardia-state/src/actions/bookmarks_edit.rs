use super::*;
use crate::bookmarks::{MAX_BOOKMARK_DEPTH, RemovedBookmarks};

impl Tx<'_> {
    fn bookmark_tree(&self, profile: &ProfileId) -> Option<&BookmarkTree> {
        let key = self.s.engine_profile(profile);
        self.s.bookmarks.get(&key).map(|tree| tree.as_ref())
    }

    fn require_bookmark(&self, profile: &ProfileId, id: &BookmarkId) -> Result<(), ActionError> {
        match self.bookmark_tree(profile) {
            Some(tree) if tree.get(id.as_str()).is_some() => Ok(()),
            _ => Err(BookmarkError::Missing.into()),
        }
    }

    fn folder_room(&self, profile: &ProfileId, parent: &BookmarkId, height: usize) -> bool {
        self.bookmark_tree(profile)
            .is_none_or(|tree| tree.depth_of(parent.as_str()) + 1 + height < MAX_BOOKMARK_DEPTH)
    }

    pub(super) fn rename_bookmark(
        &mut self,
        profile: ProfileId,
        id: BookmarkId,
        title: String,
    ) -> Result<(), ActionError> {
        self.require_bookmark(&profile, &id)?;
        self.bookmarks_mut(&profile).rename(id.as_str(), &title)?;
        Ok(())
    }

    pub(super) fn update_bookmark(
        &mut self,
        profile: ProfileId,
        id: BookmarkId,
        title: Option<String>,
        url: Option<String>,
    ) -> Result<(), ActionError> {
        self.require_bookmark(&profile, &id)?;
        let folder = self
            .bookmark_tree(&profile)
            .is_some_and(|tree| tree.is_folder(id.as_str()));
        let tree = self.bookmarks_mut(&profile);
        if let Some(title) = title {
            tree.rename(id.as_str(), &title)?;
        }
        if let Some(url) = url.filter(|_| !folder) {
            tree.set_url(id.as_str(), &url)?;
        }
        Ok(())
    }

    pub(super) fn add_bookmark_folder(
        &mut self,
        profile: ProfileId,
        parent: Option<BookmarkId>,
        title: String,
        index: Option<usize>,
    ) -> Result<(), ActionError> {
        let parent = parent.unwrap_or_else(|| self.bookmarks_mut(&profile).bar());
        if !self.folder_room(&profile, &parent, 0) {
            return Err(ActionError::Invalid(
                "bookmark folders can't nest that deep",
            ));
        }
        let now = self.now;
        let ids = self.ids;
        let made = self
            .bookmarks_mut(&profile)
            .add_folder(ids, &parent, index, &title, now)?;
        self.out.bookmark = Some(made);
        Ok(())
    }

    pub(super) fn add_bookmark_at(
        &mut self,
        profile: ProfileId,
        parent: Option<BookmarkId>,
        index: Option<usize>,
        title: String,
        url: String,
    ) -> Result<(), ActionError> {
        let now = self.now;
        let ids = self.ids;
        let tree = self.bookmarks_mut(&profile);
        let parent = parent.unwrap_or_else(|| tree.bar());
        let made = tree.add_url(ids, &parent, index, &title, &url, now)?;
        self.out.bookmark = Some(made);
        Ok(())
    }

    pub(super) fn move_bookmarks(
        &mut self,
        profile: ProfileId,
        ids: Vec<BookmarkId>,
        parent: BookmarkId,
        index: Option<usize>,
    ) -> Result<(), ActionError> {
        let height = self
            .bookmark_tree(&profile)
            .map(|tree| {
                ids.iter()
                    .filter(|id| tree.is_folder(id.as_str()))
                    .map(|id| tree.height_of(id.as_str()))
                    .max()
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        let folders = self
            .bookmark_tree(&profile)
            .is_some_and(|tree| ids.iter().any(|id| tree.is_folder(id.as_str())));
        if folders && !self.folder_room(&profile, &parent, height) {
            return Err(ActionError::Invalid(
                "bookmark folders can't nest that deep",
            ));
        }
        let moved = self
            .bookmarks_mut(&profile)
            .move_many(&ids, &parent, index)?;
        if moved == 0 {
            return Err(ActionError::Invalid(
                "nothing there can move into that folder",
            ));
        }
        Ok(())
    }

    pub(super) fn remove_bookmarks(
        &mut self,
        profile: ProfileId,
        ids: Vec<BookmarkId>,
    ) -> Result<(), ActionError> {
        let removable = self
            .bookmark_tree(&profile)
            .is_some_and(|tree| !tree.removal_of(&ids).places.is_empty());
        if !removable {
            return Err(BookmarkError::Missing.into());
        }
        self.bookmarks_mut(&profile).remove_many(&ids);
        Ok(())
    }

    pub(super) fn restore_bookmarks(
        &mut self,
        profile: ProfileId,
        removed: RemovedBookmarks,
    ) -> Result<(), ActionError> {
        if removed.places.is_empty() {
            return Ok(());
        }
        self.bookmarks_mut(&profile).restore_removed(&removed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::bookmarks::{BookmarkNode, MAX_BOOKMARK_DEPTH};
    use crate::ids::IdGen;
    use crate::{Action, BookmarkId, BrowserState, BrowserStore, ProfileId};

    fn store() -> (BrowserStore, ProfileId) {
        let store = BrowserStore::in_memory(BrowserState::default(), IdGen::with_launch("t"));
        let profile = ProfileId::new("default");
        (store, profile)
    }

    fn add(store: &BrowserStore, profile: &ProfileId, title: &str) -> BookmarkId {
        store
            .dispatch(Action::AddBookmarkAt {
                profile: profile.clone(),
                parent: None,
                index: None,
                title: title.into(),
                url: format!("https://{title}.example/"),
            })
            .unwrap()
            .bookmark
            .unwrap()
    }

    fn folder(
        store: &BrowserStore,
        profile: &ProfileId,
        parent: Option<BookmarkId>,
        title: &str,
    ) -> BookmarkId {
        store
            .dispatch(Action::AddBookmarkFolder {
                profile: profile.clone(),
                parent,
                title: title.into(),
                index: None,
            })
            .unwrap()
            .bookmark
            .unwrap()
    }

    fn titles(store: &BrowserStore, profile: &ProfileId, parent: &BookmarkId) -> Vec<String> {
        let state = store.snapshot();
        let tree = state.bookmarks_of(profile).unwrap();
        tree.children(parent.as_str())
            .iter()
            .map(|id| tree.get(id.as_str()).unwrap().title().to_owned())
            .collect()
    }

    fn bar(store: &BrowserStore, profile: &ProfileId) -> BookmarkId {
        store.snapshot().bookmarks_of(profile).unwrap().bar()
    }

    #[test]
    fn rename_and_update_change_only_what_they_name() {
        let (store, profile) = store();
        let a = add(&store, &profile, "a");
        let work = folder(&store, &profile, None, "Work");
        store
            .dispatch(Action::RenameBookmark {
                profile: profile.clone(),
                id: a.clone(),
                title: "Alpha".into(),
            })
            .unwrap();
        store
            .dispatch(Action::UpdateBookmark {
                profile: profile.clone(),
                id: a.clone(),
                title: None,
                url: Some("https://alpha.example/".into()),
            })
            .unwrap();
        store
            .dispatch(Action::UpdateBookmark {
                profile: profile.clone(),
                id: work.clone(),
                title: Some("Jobs".into()),
                url: Some("https://ignored.example/".into()),
            })
            .unwrap();
        let state = store.snapshot();
        let tree = state.bookmarks_of(&profile).unwrap();
        match tree.get(a.as_str()) {
            Some(BookmarkNode::Url { title, url, .. }) => {
                assert_eq!(title, "Alpha");
                assert_eq!(url, "https://alpha.example/");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(tree.get(work.as_str()).unwrap().title(), "Jobs");
    }

    #[test]
    fn edits_to_missing_ids_fail_and_change_nothing() {
        let (store, profile) = store();
        add(&store, &profile, "a");
        let before = store.snapshot();
        let missing = BookmarkId::new("nope");
        for action in [
            Action::RenameBookmark {
                profile: profile.clone(),
                id: missing.clone(),
                title: "x".into(),
            },
            Action::UpdateBookmark {
                profile: profile.clone(),
                id: missing.clone(),
                title: Some("x".into()),
                url: None,
            },
            Action::MoveBookmarks {
                profile: profile.clone(),
                ids: vec![missing.clone()],
                parent: bar(&store, &profile),
                index: None,
            },
            Action::RemoveBookmarks {
                profile: profile.clone(),
                ids: vec![missing.clone()],
            },
            Action::AddBookmarkFolder {
                profile: profile.clone(),
                parent: Some(missing),
                title: "x".into(),
                index: None,
            },
        ] {
            assert!(store.dispatch(action).is_err());
        }
        assert_eq!(
            before.bookmarks_of(&profile),
            store.snapshot().bookmarks_of(&profile)
        );
    }

    #[test]
    fn roots_never_move_or_leave() {
        let (store, profile) = store();
        let work = folder(&store, &profile, None, "Work");
        let state = store.snapshot();
        let tree = state.bookmarks_of(&profile).unwrap();
        let (bar, other) = (tree.bar(), tree.other());
        assert!(
            store
                .dispatch(Action::MoveBookmarks {
                    profile: profile.clone(),
                    ids: vec![other.clone()],
                    parent: work,
                    index: None,
                })
                .is_err()
        );
        assert!(
            store
                .dispatch(Action::RemoveBookmarks {
                    profile: profile.clone(),
                    ids: vec![bar.clone(), other.clone()],
                })
                .is_err()
        );
        let after = store.snapshot();
        let tree = after.bookmarks_of(&profile).unwrap();
        assert!(tree.get(bar.as_str()).is_some() && tree.get(other.as_str()).is_some());
    }

    #[test]
    fn folders_stop_at_the_depth_limit() {
        let (store, profile) = store();
        let mut parent = None;
        let mut made = 0;
        while let Ok(outcome) = store.dispatch(Action::AddBookmarkFolder {
            profile: profile.clone(),
            parent: parent.clone(),
            title: format!("level {made}"),
            index: None,
        }) {
            parent = outcome.bookmark;
            made += 1;
            assert!(made <= MAX_BOOKMARK_DEPTH);
        }
        assert_eq!(made, MAX_BOOKMARK_DEPTH - 1);
        let top = folder(&store, &profile, None, "Second");
        let child = folder(&store, &profile, Some(top.clone()), "Child");
        assert!(
            store
                .dispatch(Action::MoveBookmarks {
                    profile,
                    ids: vec![top],
                    parent: parent.unwrap(),
                    index: None,
                })
                .is_err()
        );
        let _ = child;
    }

    #[test]
    fn moves_keep_order_and_clamp_the_index() {
        let (store, profile) = store();
        let ids: Vec<BookmarkId> = ["a", "b", "c", "d"]
            .iter()
            .map(|t| add(&store, &profile, t))
            .collect();
        let bar = bar(&store, &profile);
        store
            .dispatch(Action::MoveBookmarks {
                profile: profile.clone(),
                ids: vec![ids[3].clone(), ids[0].clone()],
                parent: bar.clone(),
                index: Some(1),
            })
            .unwrap();
        assert_eq!(titles(&store, &profile, &bar), ["b", "d", "a", "c"]);
        store
            .dispatch(Action::MoveBookmarks {
                profile: profile.clone(),
                ids: vec![ids[1].clone()],
                parent: bar.clone(),
                index: Some(99),
            })
            .unwrap();
        assert_eq!(titles(&store, &profile, &bar), ["d", "a", "c", "b"]);
        let work = folder(&store, &profile, None, "Work");
        store
            .dispatch(Action::AddBookmarkAt {
                profile: profile.clone(),
                parent: Some(work.clone()),
                index: Some(42),
                title: "inside".into(),
                url: "https://inside.example/".into(),
            })
            .unwrap();
        assert!(
            store
                .dispatch(Action::MoveBookmarks {
                    profile: profile.clone(),
                    ids: vec![work.clone()],
                    parent: work.clone(),
                    index: None,
                })
                .is_err()
        );
        assert_eq!(titles(&store, &profile, &work), ["inside"]);
    }

    #[test]
    fn removed_bookmarks_come_back_in_their_places() {
        let (store, profile) = store();
        let ids: Vec<BookmarkId> = ["a", "b", "c", "d"]
            .iter()
            .map(|t| add(&store, &profile, t))
            .collect();
        let work = folder(&store, &profile, None, "Work");
        let inner = store
            .dispatch(Action::AddBookmarkAt {
                profile: profile.clone(),
                parent: Some(work.clone()),
                index: None,
                title: "inner".into(),
                url: "https://inner.example/".into(),
            })
            .unwrap()
            .bookmark
            .unwrap();
        let bar = bar(&store, &profile);
        let doomed = vec![ids[2].clone(), ids[0].clone(), work.clone(), inner];
        let removed = store
            .snapshot()
            .bookmarks_of(&profile)
            .unwrap()
            .removal_of(&doomed);
        assert_eq!(removed.places.len(), 3);
        store
            .dispatch(Action::RemoveBookmarks {
                profile: profile.clone(),
                ids: doomed,
            })
            .unwrap();
        assert_eq!(titles(&store, &profile, &bar), ["b", "d"]);
        store
            .dispatch(Action::RestoreBookmarks {
                profile: profile.clone(),
                removed,
            })
            .unwrap();
        assert_eq!(titles(&store, &profile, &bar), ["a", "b", "c", "d", "Work"]);
        assert_eq!(titles(&store, &profile, &work), ["inner"]);
    }
}
