use super::*;

impl Tx<'_> {
    pub(super) fn tidy_tabs(
        &mut self,
        window: &WindowId,
        profile: Option<&ProfileId>,
    ) -> Result<(), ActionError> {
        self.tidy_in(window, profile, crate::tidy::TidyScope::Tabs)
    }

    pub(super) fn tidy_in(
        &mut self,
        window: &WindowId,
        profile: Option<&ProfileId>,
        scope: crate::tidy::TidyScope,
    ) -> Result<(), ActionError> {
        self.require_window(window)?;
        let plan = crate::tidy::tidy_plan_in(self.s, window.as_str(), profile, scope)
            .ok_or(ActionError::Invalid("there is nothing to tidy"))?;
        if !plan.closes.is_empty() {
            let shown = self.s.active_tab(window.as_str()).map(|t| t.id.clone());
            let closing: Vec<TabId> = plan.closes.iter().map(|(id, _)| id.clone()).collect();
            self.remove_tabs(&closing, true);
            let keeper = shown.and_then(|shown| {
                plan.closes
                    .iter()
                    .find(|(id, _)| *id == shown)
                    .map(|(_, keeper)| keeper.clone())
            });
            if let Some(keeper) = keeper.filter(|k| self.s.tabs.contains_key(k)) {
                self.switch_to(&keeper);
            }
        }
        for (tab, group) in plan.files {
            self.add_to_group(group, vec![tab])?;
        }
        for (tabs, name) in plan.new_groups {
            self.create_group(&tabs, &name)?;
        }
        Ok(())
    }

    fn restore_tidy_closes(&mut self, tidied: &crate::tidy::Tidied) -> Vec<(TabId, TabId)> {
        let entries: Vec<crate::closed::ClosedTab> = tidied
            .closed
            .iter()
            .filter(|id| !self.s.tabs.contains_key(*id))
            .filter_map(|id| {
                self.s
                    .closed
                    .tabs
                    .iter()
                    .find(|c| c.tab_id.as_ref() == Some(id))
                    .cloned()
            })
            .collect();
        if entries.is_empty() {
            return Vec::new();
        }
        let gone: HashSet<EntryId> = entries.iter().map(|e| e.id.clone()).collect();
        self.closed_mut().tabs.retain(|c| !gone.contains(&c.id));
        let mut restored = Vec::new();
        for entry in entries {
            let Some(old) = entry.tab_id.clone() else {
                continue;
            };
            let index = tidied.order.iter().position(|t| *t == old);
            if let Ok(new) = self.new_tab(
                &tidied.window,
                NewTab {
                    background: true,
                    index,
                    ..NewTab::restoring(entry.tab)
                },
            ) {
                restored.push((old, new));
            }
        }
        restored
    }

    pub(super) fn untidy_tabs(&mut self, tidied: &crate::tidy::Tidied) -> Result<(), ActionError> {
        self.require_window(&tidied.window)?;
        if !crate::tidy::can_undo_tidy(self.s, tidied) {
            return Err(ActionError::Invalid("the tidy can't be undone"));
        }
        let restored = self.restore_tidy_closes(tidied);
        let present: Vec<TabId> = tidied
            .moved
            .iter()
            .filter(|id| {
                self.s
                    .tabs
                    .get(*id)
                    .is_some_and(|t| t.window_id == tidied.window)
            })
            .cloned()
            .collect();
        if present.is_empty() && restored.is_empty() {
            return Ok(());
        }
        if !present.is_empty() {
            self.remove_from_groups(present.clone())?;
        }
        let pins = tidied.scope == crate::tidy::TidyScope::Pins;
        if pins {
            for id in &present {
                let home = tidied
                    .homes
                    .iter()
                    .find(|(h, _)| h == id)
                    .and_then(|(_, home)| home.clone());
                if let Some(t) = self.tab_mut(id) {
                    t.pin = Some(TabPin::Row);
                    if home.is_some() {
                        t.pinned_url = home;
                    }
                }
            }
        }
        let mapped = crate::tidy::Tidied {
            order: tidied
                .order
                .iter()
                .map(|id| {
                    restored
                        .iter()
                        .find(|(old, _)| old == id)
                        .map_or_else(|| id.clone(), |(_, new)| new.clone())
                })
                .collect(),
            moved: tidied
                .moved
                .iter()
                .cloned()
                .chain(restored.iter().map(|(_, new)| new.clone()))
                .collect(),
            ..tidied.clone()
        };
        if let Some(order) = crate::tidy::untidied_order(self.s, &mapped)
            && let Some(w) = self.window_mut(&tidied.window)
        {
            w.tab_ids = order;
        }
        self.reorder_window(&tidied.window);
        Ok(())
    }
}
