use super::*;

impl Tx<'_> {
    pub(super) fn reorder_window(&mut self, window: &WindowId) {
        let Some(w) = self.s.windows.get(window) else {
            return;
        };
        let ordered = order_sections(&w.tab_ids, &self.s.tabs, &self.s.groups);
        let placed = groups::place_groups(ordered, &self.s.groups, window);
        let placed = self.splits_contiguous(placed);
        if placed != w.tab_ids
            && let Some(w) = self.window_mut(window)
        {
            w.tab_ids = placed.clone();
        }
        let mut groups = (*self.s.groups).clone();
        groups::sync_group_order(&mut groups, window, &placed);
        if groups != *self.s.groups {
            self.set_groups(groups);
        }
    }

    pub(super) fn splits_contiguous(&self, mut tab_ids: Vec<TabId>) -> Vec<TabId> {
        let pinned_members = groups::pinned_group_members(&self.s.groups);
        for split in self.s.splits.values() {
            let panes = split.tab_ids();
            if !panes.iter().all(|p| tab_ids.contains(p)) {
                continue;
            }
            for rank in [1, 2] {
                let block: Vec<TabId> = tab_ids
                    .iter()
                    .filter(|t| {
                        panes.contains(t)
                            && self
                                .s
                                .tabs
                                .get(*t)
                                .is_some_and(|tab| section_rank(tab, &pinned_members) == rank)
                    })
                    .cloned()
                    .collect();
                if block.len() > 1 {
                    tab_ids = groups::place_block(&tab_ids, &block);
                }
            }
        }
        tab_ids
    }

    pub(super) fn with_split_partners(&self, ids: Vec<TabId>) -> Vec<TabId> {
        let mut out = ids.clone();
        for id in &ids {
            if let Some(split) = self.s.split_of(id.as_str()) {
                for pane in split.tab_ids() {
                    if self.lane_of(&pane) == self.lane_of(id) {
                        push_unique(&mut out, &pane);
                    }
                }
            }
        }
        out
    }

    pub(super) fn lane_of(&self, id: &TabId) -> u8 {
        self.s.tabs.get(id).map_or(2, |t| {
            section_rank(t, &groups::pinned_group_members(&self.s.groups))
        })
    }

    pub(super) fn join_lane(&mut self, anchor: &TabId, newcomers: &[TabId]) {
        let Some(lead) = self.s.tabs.get(anchor).cloned() else {
            return;
        };
        if lead.pin.as_ref().is_some_and(TabPin::is_tile) {
            return;
        }
        let row = lead.pin.as_ref().is_some_and(TabPin::is_row);
        let group = (!row)
            .then(|| self.s.group_of(anchor.as_str()).map(|g| g.id.clone()))
            .flatten();
        for id in newcomers.iter().filter(|t| *t != anchor) {
            let Some(tab) = self.s.tabs.get(id).cloned() else {
                continue;
            };
            if row {
                if !tab.pin.as_ref().is_some_and(TabPin::is_row) {
                    let _ = self.set_pin(id, Some(TabPin::Row));
                }
                continue;
            }
            if tab.pin.is_some() {
                let _ = self.set_pin(id, None);
            }
            if self.s.group_of(id.as_str()).map(|g| g.id.clone()) != group {
                let left = groups::leave_groups(&self.s.groups, &HashSet::from([id.clone()]));
                self.set_groups(left);
                if let Some(g) = group.as_ref().and_then(|g| self.group_mut(g)) {
                    g.tab_ids.push(id.clone());
                }
            }
        }
    }

    pub(super) fn first_regular(&self, w: &BrowserWindow, profile: &ProfileId) -> usize {
        w.tab_ids
            .iter()
            .position(|id| {
                self.s
                    .tabs
                    .get(id)
                    .is_some_and(|t| &t.profile_id == profile)
                    && !self.s.in_pinned_container(id.as_str())
            })
            .unwrap_or(w.tab_ids.len())
    }

    pub(super) fn outside_split(&self, w: &BrowserWindow, index: usize) -> usize {
        let (Some(before), Some(after)) = (
            index.checked_sub(1).and_then(|i| w.tab_ids.get(i)),
            w.tab_ids.get(index),
        ) else {
            return index;
        };
        match self.s.split_of(before.as_str()) {
            Some(split) if split.contains(after.as_str()) => split
                .tab_ids()
                .iter()
                .filter_map(|p| w.tab_ids.iter().position(|t| t == p))
                .max()
                .map_or(index, |i| i + 1),
            _ => index,
        }
    }

    pub(super) fn after_panes(&self, w: &BrowserWindow, tab: &TabId) -> usize {
        let panes = self
            .s
            .split_of(tab.as_str())
            .map_or_else(|| vec![tab.clone()], |s| s.tab_ids());
        panes
            .iter()
            .filter_map(|p| w.tab_ids.iter().position(|t| t == p))
            .max()
            .map_or(w.tab_ids.len(), |i| i + 1)
    }

    pub(super) fn insertion_index(&self, w: &BrowserWindow, tab: &Tab, background: bool) -> usize {
        let opener = tab
            .opener_id
            .as_ref()
            .and_then(|o| self.s.tabs.get(o))
            .filter(|o| o.window_id == w.id && o.profile_id == tab.profile_id);
        let index = match opener {
            Some(opener) if !self.s.in_pinned_container(opener.id.as_str()) => {
                let at = self.after_panes(w, &opener.id);
                if background {
                    self.after_family(w, tab, at, &opener.id)
                } else {
                    at
                }
            }
            Some(opener) => {
                let start = self.first_regular(w, &tab.profile_id);
                self.after_family(w, tab, start, &opener.id)
            }
            None => match self.s.settings.new_tab_position {
                NewTabPosition::Top => self.first_regular(w, &tab.profile_id),
                NewTabPosition::NextToCurrent => match w
                    .active_tab_ids
                    .get(&tab.profile_id)
                    .and_then(|a| self.s.tabs.get(a))
                {
                    Some(active) if !self.s.in_pinned_container(active.id.as_str()) => {
                        self.after_panes(w, &active.id)
                    }
                    _ => self.first_regular(w, &tab.profile_id),
                },
                NewTabPosition::Bottom => w.tab_ids.len(),
            },
        };
        self.outside_split(w, index)
    }

    pub(super) fn after_family(
        &self,
        w: &BrowserWindow,
        tab: &Tab,
        from: usize,
        opener: &TabId,
    ) -> usize {
        let mut family: HashSet<TabId> = HashSet::from([opener.clone()]);
        let group = self.s.group_of(opener.as_str()).map(|g| g.id.clone());
        let mut index = from;
        for (i, id) in w.tab_ids.iter().enumerate().skip(from) {
            let Some(t) = self.s.tabs.get(id) else {
                continue;
            };
            if t.profile_id != tab.profile_id {
                continue;
            }
            let in_family = t.opener_id.as_ref().is_some_and(|o| family.contains(o))
                && self.s.group_of(id.as_str()).map(|g| g.id.clone()) == group;
            if !in_family {
                break;
            }
            family.insert(id.clone());
            index = i + 1;
        }
        index
    }
}

impl Tx<'_> {
    pub(super) fn arrange_tabs(
        &mut self,
        window: &WindowId,
        tabs: &[TabId],
    ) -> Result<(), ActionError> {
        let w = self.require_window(window)?;
        let wanted: HashSet<&TabId> = tabs.iter().collect();
        if wanted.len() != tabs.len() || !tabs.iter().all(|t| w.tab_ids.contains(t)) {
            return Err(ActionError::Invalid("those tabs aren't all in this window"));
        }
        let mut next = tabs.iter();
        let arranged: Vec<TabId> = w
            .tab_ids
            .iter()
            .map(|t| {
                if wanted.contains(t) {
                    next.next().cloned().unwrap_or_else(|| t.clone())
                } else {
                    t.clone()
                }
            })
            .collect();
        if arranged == w.tab_ids {
            return Ok(());
        }
        if let Some(w) = self.window_mut(window) {
            w.tab_ids = arranged;
        }
        self.reorder_window(window);
        Ok(())
    }
}
