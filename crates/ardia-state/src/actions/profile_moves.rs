use super::*;

impl Tx<'_> {
    pub(super) fn move_tabs_to_profile(
        &mut self,
        tabs: &[TabId],
        profile: &ProfileId,
        before: Option<&TabId>,
        background: bool,
    ) -> Result<(), ActionError> {
        if !self.s.profiles.contains_key(profile) || profile.is_incognito() {
            return Err(ActionError::Invalid("no such profile"));
        }
        let mut last = None;
        for id in tabs {
            let Some(tab) = self.s.tabs.get(id).cloned() else {
                continue;
            };
            if tab.profile_id == *profile || tab.profile_id.is_incognito() {
                continue;
            }
            let Some(window) = self.s.windows.get(&tab.window_id).cloned() else {
                continue;
            };
            if window.kind == WindowKind::Incognito {
                continue;
            }
            let loaded = tab.page.has_page();
            let old_index = window.tab_ids.iter().position(|t| t == id);
            self.remove_tabs(std::slice::from_ref(id), false);
            let w = self.require_window(&window.id)?;
            let index = before
                .filter(|b| *b != id)
                .and_then(|b| w.tab_ids.iter().position(|t| t == b))
                .or(old_index.map(|i| i.min(w.tab_ids.len())));
            let mut snapshot = tab.snapshot();
            snapshot.profile_id = profile.clone();
            let moved = self.new_tab(
                &window.id,
                NewTab {
                    profile: Some(profile.clone()),
                    background: true,
                    index,
                    snapshot: Some(Box::new(snapshot)),
                    ..NewTab::default()
                },
            )?;
            if loaded && let Some(t) = self.tab_mut(&moved) {
                t.page = TabPage::LOADED;
            }
            self.reorder_window(&window.id);
            last = Some(moved);
        }
        if let Some(last) = last.filter(|_| !background) {
            self.switch_to(&last);
        }
        Ok(())
    }
}
