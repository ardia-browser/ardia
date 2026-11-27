use super::*;

impl Tx<'_> {
    pub(super) fn is_asleep(&self, id: &TabId) -> bool {
        self.s.tabs.get(id).is_some_and(|t| t.page.is_asleep())
    }

    pub(super) fn successor(
        &self,
        w: &BrowserWindow,
        profile: &ProfileId,
        closed: &TabId,
        gone: &HashSet<TabId>,
    ) -> Option<TabId> {
        if let Some(split) = self.s.split_of(closed.as_str()) {
            let other = split
                .tab_ids()
                .into_iter()
                .filter(|p| !gone.contains(p) && self.s.tabs.contains_key(p))
                .max_by_key(|p| self.s.tabs[p].last_active_at);
            if other.is_some() {
                return other;
            }
        }
        let order: Vec<&TabId> = w
            .tab_ids
            .iter()
            .filter(|t| {
                self.s
                    .tabs
                    .get(*t)
                    .is_some_and(|t| &t.profile_id == profile)
            })
            .collect();
        let pinned_closed = self.s.in_pinned_container(closed.as_str());
        let keep = self.keep_top_apps();
        let left: Vec<&TabId> = order
            .iter()
            .copied()
            .filter(|t| !gone.contains(*t))
            .filter(|t| !(keep && self.kept_with_top_app(t)))
            .filter(|t| !self.s.hidden_empty_card(&self.s.tabs[*t]))
            .collect();
        let regular: Vec<&TabId> = left
            .iter()
            .copied()
            .filter(|t| !self.s.in_pinned_container(t.as_str()) || self.s.tabs[*t].page.has_page())
            .collect();
        let pool: Vec<&TabId> = if regular.is_empty() && !pinned_closed {
            left.clone()
        } else {
            regular
        };
        let at = order.iter().position(|t| *t == closed).unwrap_or(0);
        let below: Vec<&TabId> = pool
            .iter()
            .copied()
            .filter(|t| order.iter().position(|o| o == t).unwrap_or(0) > at)
            .collect();
        let above: Vec<&TabId> = pool
            .iter()
            .copied()
            .filter(|t| order.iter().position(|o| o == t).unwrap_or(0) < at)
            .rev()
            .collect();
        match self.s.settings.after_closing_tab {
            AfterClosingTab::TabAbove => above.first().or(below.first()).map(|t| (*t).clone()),
            AfterClosingTab::TabBelow => below.first().or(above.first()).map(|t| (*t).clone()),
            AfterClosingTab::PreviouslyActive => {
                let nearest: Vec<&TabId> = below.iter().chain(above.iter()).copied().collect();
                let awake: Vec<&TabId> = nearest
                    .iter()
                    .copied()
                    .filter(|t| !self.is_asleep(t))
                    .collect();
                let pool = if awake.is_empty() { nearest } else { awake };
                let seen: Vec<&TabId> = pool
                    .iter()
                    .copied()
                    .filter(|t| !self.s.tabs[*t].unseen)
                    .collect();
                if seen.is_empty() {
                    pool.first().map(|t| (*t).clone())
                } else {
                    seen.iter()
                        .copied()
                        .max_by_key(|t| self.s.tabs[*t].last_active_at)
                        .cloned()
                }
            }
        }
    }

    pub(super) fn closed_entry(&self, tab: &Tab, batch: Option<&str>, small: bool) -> ClosedTab {
        let w = self.s.windows.get(&tab.window_id);
        let group = self.s.group_of(tab.id.as_str()).map(|g| g.info());
        let parents = group
            .as_ref()
            .map(|g| {
                groups::ancestors(&self.s.groups, g.id.as_str())
                    .iter()
                    .filter_map(|id| self.s.groups.get(id))
                    .map(|g| g.info())
                    .collect()
            })
            .unwrap_or_default();
        ClosedTab {
            kind: crate::closed::ClosedKind::Tab,
            id: self.ids.entry("ct"),
            tab: tab.snapshot(),
            tab_id: Some(tab.id.clone()),
            restore_from: tab.page.pending_restore().map(str::to_owned),
            close_batch: batch.map(str::to_owned),
            window_id: tab.window_id.clone(),
            index: w
                .and_then(|w| w.tab_ids.iter().position(|t| *t == tab.id))
                .unwrap_or(0),
            profile_index: self
                .s
                .profile_index(&tab.window_id, &tab.profile_id, &tab.id),
            group,
            parents,
            closed_at: self.now,
            pinned_tile: false,
            pin_key: tab.pin_key.clone(),
            small,
            extra: Default::default(),
        }
    }

    pub(super) fn unload_pinned(&mut self, id: &TabId) -> Option<ClosedTab> {
        let tab = self.s.tabs.get(id).cloned()?;
        self.settle_peeks(&HashSet::from([id.clone()]));
        let entry = (tab.page.has_page() && !tab.url.is_empty()).then(|| ClosedTab {
            pinned_tile: true,
            ..self.closed_entry(&tab, None, false)
        });
        let home = tab
            .pinned_url
            .clone()
            .filter(|h| !h.is_empty() && *h != tab.url);
        if let Some(t) = self.tab_mut(id) {
            let wake = if home.is_none() {
                t.page
                    .pending_restore()
                    .map(|key| crate::model::restore_id(&TabId::new(key)))
            } else {
                None
            };
            if let Some(home) = home {
                t.url = home;
            }
            t.page = TabPage {
                kind: PageKind::Asleep,
                wake,
            };
            t.live = Default::default();
        }
        entry
    }

    pub(crate) fn remove_tabs(&mut self, ids: &[TabId], record: bool) -> Vec<ClosedTab> {
        let gone: HashSet<TabId> = ids
            .iter()
            .filter(|id| self.s.tabs.contains_key(*id))
            .cloned()
            .collect();
        if gone.is_empty() {
            return Vec::new();
        }
        let batch = (gone.len() > 1).then(|| self.ids.next("batch"));
        let mut closed = Vec::new();
        let windows: Vec<Arc<BrowserWindow>> = self
            .s
            .windows
            .values()
            .filter(|w| w.tab_ids.iter().any(|t| gone.contains(t)))
            .cloned()
            .collect();
        for w in &windows {
            if record {
                for id in w.tab_ids.iter().filter(|t| gone.contains(*t)) {
                    let tab = &self.s.tabs[id];
                    if !tab.url.is_empty() || tab.is_pinned() {
                        closed.push(self.closed_entry(
                            tab,
                            batch.as_deref(),
                            w.kind == WindowKind::LittleArdia,
                        ));
                    }
                }
            }
            let successors: Vec<(ProfileId, Option<TabId>)> = w
                .active_tab_ids
                .iter()
                .filter(|(_, active)| gone.contains(*active))
                .map(|(p, active)| (p.clone(), self.successor(w, p, active, &gone)))
                .collect();
            if let Some(win) = self.window_mut(&w.id) {
                win.tab_ids.retain(|t| !gone.contains(t));
                win.chrome.selection.retain(|t| !gone.contains(t));
                for (profile, next) in successors {
                    match next {
                        Some(next) => {
                            win.active_tab_ids.insert(profile, next);
                        }
                        None => {
                            win.active_tab_ids.shift_remove(&profile);
                        }
                    }
                }
            }
        }
        self.settle_peeks(&gone);
        let tabs = Arc::make_mut(&mut self.s.tabs);
        for id in &gone {
            tabs.shift_remove(id);
        }
        let openers: Vec<(TabId, Option<TabId>)> = self
            .s
            .tabs
            .values()
            .filter(|t| t.opener_id.as_ref().is_some_and(|o| gone.contains(o)))
            .map(|t| (t.id.clone(), None))
            .collect();
        for (id, opener) in openers {
            if let Some(t) = self.tab_mut(&id) {
                t.opener_id = opener;
            }
        }
        for id in &gone {
            self.note_tab(id, Topics::TABS, false);
        }
        let groups = groups::leave_groups(&self.s.groups, &gone);
        if groups != *self.s.groups {
            self.set_groups(groups);
        }
        if self
            .s
            .splits
            .values()
            .any(|s| s.tab_ids().iter().any(|t| gone.contains(t)))
        {
            let splits = self.splits_mut();
            let ids: Vec<SplitId> = splits.keys().cloned().collect();
            for sid in ids {
                let view = splits[&sid].clone();
                if !view.tab_ids().iter().any(|t| gone.contains(t)) {
                    continue;
                }
                let rest = view.without_panes(&gone);
                if rest.pane_count() >= 2 {
                    splits.insert(sid, Arc::new(rest));
                } else {
                    splits.shift_remove(&sid);
                }
            }
        }
        for w in &windows {
            if let Some(active) = self
                .s
                .windows
                .get(&w.id)
                .and_then(|w| w.active_tab().cloned())
                && (self.s.tabs.get(&active).is_some_and(|t| t.page.is_asleep())
                    || Some(&active) != w.active_tab())
            {
                self.activate(&active);
            }
        }
        if record && !closed.is_empty() {
            self.closed_mut().push_tabs(closed.iter().cloned());
        }
        closed
    }

    pub(super) fn close_tabs(&mut self, ids: &[TabId], last_closes_window: bool) {
        self.close_tabs_recording(ids, last_closes_window, true);
    }

    pub(super) fn close_tabs_recording(
        &mut self,
        ids: &[TabId],
        last_closes_window: bool,
        record: bool,
    ) {
        let peeks: Vec<WindowId> = ids
            .iter()
            .filter_map(|id| self.s.tabs.get(id))
            .filter(|t| t.live.peek)
            .map(|t| t.window_id.clone())
            .collect();
        for window in peeks {
            let _ = self.close_peek(&window);
        }
        let (pinned, regular): (Vec<TabId>, Vec<TabId>) = ids
            .iter()
            .filter(|id| self.s.tabs.contains_key(*id))
            .cloned()
            .partition(|id| record && self.s.in_pinned_container(id.as_str()));
        self.close_pinned(&pinned);
        let gone: HashSet<&TabId> = regular.iter().collect();
        let keep = self.keep_top_apps();
        let mut emptied = Vec::new();
        for w in self.s.windows.values() {
            let view: Vec<&TabId> = w
                .tab_ids
                .iter()
                .filter(|t| {
                    self.s
                        .tabs
                        .get(*t)
                        .is_some_and(|t| t.profile_id == w.profile_id)
                })
                .collect();
            let kept_running = keep
                && view
                    .iter()
                    .any(|t| !gone.contains(t) && self.runs_kept_top_app(t));
            if view.iter().any(|t| gone.contains(t))
                && view.iter().all(|t| {
                    gone.contains(t)
                        || self.is_asleep(t)
                        || (kept_running && self.kept_with_top_app(t))
                })
            {
                let keeps_beside_top_apps = kept_running
                    && !view
                        .iter()
                        .filter(|t| gone.contains(*t))
                        .all(|t| self.is_empty_card(t));
                emptied.push((
                    w.id.clone(),
                    !keeps_beside_top_apps
                        && (last_closes_window || w.kind == WindowKind::LittleArdia),
                ));
            }
        }
        for (window, closes) in emptied {
            if closes {
                self.close_window(&window, false);
            } else {
                let _ = self.new_tab(&window, NewTab::default());
            }
        }
        self.remove_tabs(&regular, record);
    }

    pub(super) fn clean_up_tabs(&mut self, ids: &[TabId]) {
        let ids: Vec<TabId> = ids
            .iter()
            .filter(|id| self.s.tabs.contains_key(*id))
            .cloned()
            .collect();
        if ids.is_empty() {
            return;
        }
        let batch = (ids.len() > 1).then(|| self.ids.next("batch"));
        let entries: Vec<ClosedTab> = ids
            .iter()
            .filter_map(|id| self.s.tabs.get(id))
            .map(|tab| {
                let small = self
                    .s
                    .windows
                    .get(&tab.window_id)
                    .is_some_and(|w| w.kind == WindowKind::LittleArdia);
                self.closed_entry(tab, batch.as_deref(), small)
            })
            .collect();
        self.remove_tabs(&ids, false);
        self.closed_mut().push_cleaned(entries);
    }

    pub(super) fn is_tile(&self, id: &TabId) -> bool {
        self.s
            .tabs
            .get(id)
            .is_some_and(|t| t.pin.as_ref().is_some_and(TabPin::is_tile))
    }

    pub(super) fn pinned_panes(&self, ids: &[TabId]) -> Vec<TabId> {
        let mut out = ids.to_vec();
        for id in ids {
            for pane in self
                .s
                .split_of(id.as_str())
                .map(|s| s.tab_ids())
                .unwrap_or_default()
            {
                if self.s.in_pinned_container(pane.as_str()) {
                    push_unique(&mut out, &pane);
                }
            }
        }
        out
    }

    pub(super) fn with_top_app(&self, id: &TabId) -> bool {
        self.pinned_panes(std::slice::from_ref(id))
            .iter()
            .any(|p| self.is_tile(p))
    }

    pub(super) fn kept_with_top_app(&self, id: &TabId) -> bool {
        self.s.in_pinned_container(id.as_str()) && self.with_top_app(id)
    }

    fn runs_kept_top_app(&self, id: &TabId) -> bool {
        self.kept_with_top_app(id)
            && self.s.tabs.get(id).is_some_and(|t| {
                t.page.has_page() || matches!(t.page.kind, crate::model::PageKind::Frozen { .. })
            })
    }

    fn is_empty_card(&self, id: &TabId) -> bool {
        self.s
            .tabs
            .get(id)
            .is_some_and(|t| self.s.is_empty_card_tab(t))
    }

    pub(super) fn most_recent<'t>(&self, ids: impl Iterator<Item = &'t TabId>) -> Option<TabId> {
        let mut best: Option<&TabId> = None;
        for id in ids {
            let Some(tab) = self.s.tabs.get(id) else {
                continue;
            };
            let better = best
                .and_then(|b| self.s.tabs.get(b))
                .is_none_or(|b| (!tab.unseen, tab.last_active_at) > (!b.unseen, b.last_active_at));
            if better {
                best = Some(id);
            }
        }
        best.cloned()
    }

    pub(super) fn awake_first<'t>(&self, ids: Vec<&'t TabId>) -> Vec<&'t TabId> {
        let awake: Vec<&TabId> = ids.iter().copied().filter(|t| !self.is_asleep(t)).collect();
        if awake.is_empty() { ids } else { awake }
    }

    pub(super) fn other_pane(&self, id: &TabId, closing: &HashSet<TabId>) -> Option<TabId> {
        let panes = self
            .s
            .split_of(id.as_str())
            .map(|s| s.tab_ids())
            .unwrap_or_default();
        self.most_recent(panes.iter().filter(|p| !closing.contains(*p)))
    }

    pub(super) fn last_regular_tab(
        &self,
        w: &BrowserWindow,
        id: &TabId,
        closing: &HashSet<TabId>,
    ) -> Option<TabId> {
        let profile = self.s.tabs.get(id)?.profile_id.clone();
        let candidates: Vec<&TabId> = w
            .tab_ids
            .iter()
            .filter(|t| !closing.contains(*t) && !self.s.in_pinned_container(t.as_str()))
            .filter(|t| self.s.tabs.get(*t).is_some_and(|t| t.profile_id == profile))
            .collect();
        let panes = self
            .s
            .split_of(id.as_str())
            .map(|s| s.tab_ids())
            .unwrap_or_default();
        let partners: Vec<&TabId> = candidates
            .iter()
            .copied()
            .filter(|t| panes.contains(t))
            .collect();
        let pool = if partners.is_empty() {
            candidates
        } else {
            partners
        };
        self.most_recent(self.awake_first(pool).into_iter())
    }

    pub(super) fn last_live_pinned_tab(
        &self,
        w: &BrowserWindow,
        id: &TabId,
        closing: &HashSet<TabId>,
        skip_top_apps: bool,
    ) -> Option<TabId> {
        let profile = self.s.tabs.get(id)?.profile_id.clone();
        let live: Vec<&TabId> = w
            .tab_ids
            .iter()
            .filter(|t| !closing.contains(*t) && self.s.in_pinned_container(t.as_str()))
            .filter(|t| {
                self.s
                    .tabs
                    .get(*t)
                    .is_some_and(|t| t.profile_id == profile && t.page.has_page())
            })
            .filter(|t| !(skip_top_apps && self.kept_with_top_app(t)))
            .collect();
        self.most_recent(self.awake_first(live).into_iter())
    }

    pub(super) fn close_pinned(&mut self, asked: &[TabId]) {
        if asked.is_empty() {
            return;
        }
        let keep = self.keep_top_apps();
        let switched_away: Vec<TabId> = if keep {
            let tops: Vec<TabId> = asked
                .iter()
                .filter(|id| self.with_top_app(id))
                .cloned()
                .collect();
            self.pinned_panes(&tops)
        } else {
            Vec::new()
        };
        let leaving: HashSet<TabId> = switched_away.iter().cloned().collect();
        let rest: Vec<TabId> = asked
            .iter()
            .filter(|id| !leaving.contains(*id))
            .cloned()
            .collect();
        let unloading: Vec<TabId> = self
            .pinned_panes(&rest)
            .into_iter()
            .filter(|id| {
                self.s.in_pinned_container(id.as_str())
                    && !leaving.contains(id)
                    && !(keep && self.is_tile(id))
            })
            .collect();
        if unloading.is_empty() && switched_away.is_empty() {
            return;
        }
        let mut closing: HashSet<TabId> = asked.iter().cloned().collect();
        closing.extend(unloading.iter().cloned());
        closing.extend(switched_away.iter().cloned());
        let gone: HashSet<TabId> = unloading
            .iter()
            .chain(switched_away.iter())
            .cloned()
            .collect();
        let windows: Vec<Arc<BrowserWindow>> = self.s.windows.values().cloned().collect();
        let mut unloaded = Vec::new();
        for id in &unloading {
            if let Some(entry) = self.unload_pinned(id) {
                unloaded.push(entry);
            }
        }
        if !unloaded.is_empty() {
            self.closed_mut().push_tabs(unloaded);
        }
        let leaving_splits: HashSet<TabId> = unloading
            .iter()
            .filter(|id| {
                !self
                    .s
                    .split_of(id.as_str())
                    .is_some_and(|s| s.tab_ids().iter().all(|p| gone.contains(p)))
            })
            .cloned()
            .collect();
        let touched: Vec<SplitId> = self
            .s
            .splits
            .values()
            .filter(|s| s.tab_ids().iter().any(|t| leaving_splits.contains(t)))
            .map(|s| s.id.clone())
            .collect();
        for split in touched {
            let rest = self.s.splits[&split].without_panes(&leaving_splits);
            self.replace_split(&split, Some(rest));
        }
        for w in windows {
            for (profile, active) in w.active_tab_ids.iter().filter(|(_, a)| gone.contains(*a)) {
                let shown = *profile == w.profile_id;
                let row = (!self.with_top_app(active))
                    .then(|| {
                        self.other_pane(active, &closing)
                            .or_else(|| self.last_live_pinned_tab(&w, active, &closing, true))
                    })
                    .flatten();
                let replacement = row
                    .or_else(|| self.last_regular_tab(&w, active, &closing))
                    .or_else(|| self.last_live_pinned_tab(&w, active, &closing, keep));
                let replacement = match replacement {
                    Some(tab) => tab,
                    None => match self.new_tab(
                        &w.id,
                        NewTab {
                            profile: Some(profile.clone()),
                            background: !shown,
                            ..NewTab::default()
                        },
                    ) {
                        Ok(tab) => tab,
                        Err(_) => continue,
                    },
                };
                if shown {
                    self.activate(&replacement);
                } else if let Some(win) = self.window_mut(&w.id) {
                    win.active_tab_ids.insert(profile.clone(), replacement);
                }
            }
        }
    }
}
