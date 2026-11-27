use super::*;

impl Tx<'_> {
    pub(super) fn upsert_download(&mut self, download: Box<Download>) -> Result<(), ActionError> {
        Arc::make_mut(&mut self.s.downloads).upsert(*download);
        self.out.changes.note(Topics::DOWNLOADS, false);
        Ok(())
    }

    pub(super) fn remove_download(&mut self, id: String) -> Result<(), ActionError> {
        if Arc::make_mut(&mut self.s.downloads).remove(&id) {
            self.out.changes.note(Topics::DOWNLOADS, false);
        }
        Ok(())
    }

    pub(super) fn clear_downloads(&mut self) -> Result<(), ActionError> {
        if Arc::make_mut(&mut self.s.downloads).clear_inactive() > 0 {
            self.out.changes.note(Topics::DOWNLOADS, false);
        }
        Ok(())
    }

    pub(super) fn record_visit(
        &mut self,
        profile: ProfileId,
        url: String,
        title: String,
        favicon: Option<String>,
    ) -> Result<(), ActionError> {
        if profile.is_incognito() {
            return Ok(());
        }
        let now = self.now;
        self.history_mut(&profile)
            .record_visit(&url, &title, favicon.as_deref(), now);
        Ok(())
    }

    pub(super) fn remove_history(
        &mut self,
        profile: ProfileId,
        url: String,
    ) -> Result<(), ActionError> {
        self.history_mut(&profile).remove(&url);
        Ok(())
    }

    pub(super) fn remove_history_pages(
        &mut self,
        profile: ProfileId,
        urls: Vec<String>,
    ) -> Result<(), ActionError> {
        let history = self.history_mut(&profile);
        for url in &urls {
            history.remove(url);
        }
        Ok(())
    }

    pub(super) fn replace_history(
        &mut self,
        profile: ProfileId,
        entries: Vec<crate::history::HistoryEntry>,
    ) -> Result<(), ActionError> {
        if profile.is_incognito() {
            return Ok(());
        }
        *self.history_mut(&profile) = crate::history::History::from_entries(entries);
        Ok(())
    }

    pub(super) fn clear_history(
        &mut self,
        profile: ProfileId,
        since: Option<Millis>,
        until: Millis,
    ) -> Result<(), ActionError> {
        self.history_mut(&profile)
            .remove_between(since.unwrap_or(Millis::MIN), until.saturating_add(1));
        Ok(())
    }

    pub(super) fn add_bookmark(
        &mut self,
        profile: ProfileId,
        parent: Option<BookmarkId>,
        title: String,
        url: String,
    ) -> Result<(), ActionError> {
        let now = self.now;
        let ids = self.ids;
        let tree = self.bookmarks_mut(&profile);
        let parent = parent.unwrap_or_else(|| tree.bar());
        tree.add_url(ids, &parent, None, &title, &url, now)?;
        Ok(())
    }

    pub(super) fn remove_bookmark(
        &mut self,
        profile: ProfileId,
        id: BookmarkId,
    ) -> Result<(), ActionError> {
        self.bookmarks_mut(&profile).remove(id.as_str())?;
        Ok(())
    }

    pub(super) fn move_bookmark(
        &mut self,
        profile: ProfileId,
        id: BookmarkId,
        parent: BookmarkId,
        index: Option<usize>,
    ) -> Result<(), ActionError> {
        self.bookmarks_mut(&profile)
            .move_node(id.as_str(), &parent, index)?;
        Ok(())
    }

    pub(super) fn set_air_traffic(&mut self, config: AirTrafficConfig) -> Result<(), ActionError> {
        self.s.air_traffic = Arc::new(config);
        self.out.changes.note(Topics::AIR_TRAFFIC, false);
        Ok(())
    }
}
