use super::*;

impl Tx<'_> {
    pub(super) fn clear_unpinned(&mut self, window: &WindowId) -> Result<usize, ActionError> {
        let w = self.require_window(window)?;
        let view: Vec<TabId> = w
            .tab_ids
            .iter()
            .filter(|t| {
                self.s
                    .tabs
                    .get(*t)
                    .is_some_and(|t| t.profile_id == w.profile_id)
            })
            .cloned()
            .collect();
        let unpinned: Vec<TabId> = view
            .iter()
            .filter(|t| !self.s.in_pinned_container(t.as_str()))
            .cloned()
            .collect();
        let active = w.active_tab().cloned();
        let with_panes = |ids: Vec<TabId>| -> HashSet<TabId> {
            let mut out: HashSet<TabId> = ids.iter().cloned().collect();
            for id in &ids {
                if let Some(split) = self.s.split_of(id.as_str()) {
                    out.extend(split.tab_ids());
                }
            }
            out
        };
        let playing = |id: &TabId| self.s.tabs.get(id).is_some_and(|t| t.live.audible);
        let kept = with_panes(
            view.iter()
                .filter(|t| Some(*t) == active.as_ref() || playing(t))
                .cloned()
                .collect(),
        );
        let mut cleared: Vec<TabId> = unpinned
            .iter()
            .filter(|t| !kept.contains(*t))
            .cloned()
            .collect();
        if cleared.is_empty() && active.as_ref().is_some_and(|a| unpinned.contains(a)) {
            let still_playing = with_panes(view.iter().filter(|t| playing(t)).cloned().collect());
            let selected: Vec<TabId> = unpinned
                .iter()
                .filter(|t| !still_playing.contains(*t))
                .cloned()
                .collect();
            if !selected
                .iter()
                .all(|t| self.s.tabs[t].url.is_empty() && self.s.split_of(t.as_str()).is_none())
            {
                cleared = selected;
            }
        }
        self.close_undoably(window, cleared, true)
    }

    pub(super) fn close_duplicate_tabs(&mut self, window: &WindowId) -> Result<usize, ActionError> {
        self.require_window(window)?;
        let duplicates = crate::duplicate_tabs::duplicate_tab_ids(self.s, window.as_str());
        self.close_undoably(window, duplicates, false)
    }

    fn close_undoably(
        &mut self,
        window: &WindowId,
        cleared: Vec<TabId>,
        refill: bool,
    ) -> Result<usize, ActionError> {
        if cleared.is_empty() {
            return Ok(0);
        }
        let w = self.require_window(window)?;
        let active = w.active_tab().cloned();
        let groups_before: Vec<TabGroup> = self
            .s
            .groups
            .values()
            .filter(|g| g.window_id == *window && g.profile_id == w.profile_id)
            .map(|g| (**g).clone())
            .collect();
        let splits_before: Vec<SplitView> = self
            .s
            .splits
            .values()
            .filter(|s| s.tab_ids().iter().any(|t| cleared.contains(t)))
            .map(|s| (**s).clone())
            .collect();
        let order_before = w.tab_ids.clone();
        let selected = active.filter(|a| cleared.contains(a));
        let entries = self.remove_tabs(&cleared, true);
        if refill
            && self.s.windows.get(window).is_some_and(|w| {
                !w.tab_ids.iter().any(|t| {
                    self.s
                        .tabs
                        .get(t)
                        .is_some_and(|t| t.profile_id == w.profile_id && !t.page.is_asleep())
                })
            })
        {
            let _ = self.new_tab(window, NewTab::default());
        }
        let snapshot = ClearedTabs {
            window_id: window.clone(),
            profile_id: w.profile_id.clone(),
            closed_entry_ids: entries.iter().map(|e| e.id.clone()).collect(),
            entries,
            tab_order: order_before,
            groups: groups_before,
            splits: splits_before,
            selected,
            fingerprint: 0,
            cleared_at: self.now,
        };
        Arc::make_mut(&mut self.s.cleared).insert(window.clone(), snapshot);
        Ok(cleared.len())
    }

    pub(super) fn undo_clear(&mut self, window: &WindowId) -> Result<usize, ActionError> {
        let snapshot = self
            .s
            .cleared
            .get(window)
            .cloned()
            .ok_or(ActionError::Invalid("there is nothing to undo"))?;
        if !snapshot
            .closed_entry_ids
            .iter()
            .all(|id| self.s.closed.tabs.iter().any(|c| c.id == *id))
        {
            Arc::make_mut(&mut self.s.cleared).shift_remove(window);
            return Err(ActionError::Invalid(
                "those tabs were already reopened or forgotten",
            ));
        }
        Arc::make_mut(&mut self.s.cleared).shift_remove(window);
        let closed = self.closed_mut();
        closed
            .tabs
            .retain(|c| !snapshot.closed_entry_ids.contains(&c.id));
        let mut restored = Vec::new();
        for entry in &snapshot.entries {
            let original = entry
                .tab_id
                .clone()
                .filter(|id| !self.s.tabs.contains_key(id));
            let index = original
                .as_ref()
                .and_then(|id| snapshot.tab_order.iter().position(|t| t == id));
            let Ok(new) = self.new_tab(
                window,
                NewTab {
                    background: true,
                    index,
                    ..NewTab::restoring(entry.tab.clone())
                },
            ) else {
                continue;
            };
            let wake = entry
                .tab_id
                .as_ref()
                .filter(|_| !entry.tab.url.is_empty())
                .map(|id| {
                    crate::model::restore_id(&TabId::new(
                        entry.restore_from.as_deref().unwrap_or(id.as_str()),
                    ))
                });
            if let Some(t) = self.tab_mut(&new) {
                t.page = TabPage {
                    kind: PageKind::Idle,
                    wake,
                };
                t.unseen = false;
            }
            let id = match original {
                Some(original) => self.rename_tab_id(&new, original),
                None => new,
            };
            restored.push(id);
        }
        let back: HashSet<TabId> = restored
            .iter()
            .filter(|t| {
                self.s
                    .tabs
                    .get(*t)
                    .is_some_and(|tab| tab.pin.is_none() && tab.window_id == *window)
            })
            .cloned()
            .collect();
        let mut groups = (*self.s.groups).clone();
        for g in &snapshot.groups {
            let members: Vec<TabId> = g
                .tab_ids
                .iter()
                .filter(|t| back.contains(*t))
                .cloned()
                .collect();
            if members.is_empty() {
                continue;
            }
            match groups.get_mut(&g.id) {
                Some(current) if current.window_id == *window => {
                    let current = Arc::make_mut(current);
                    for t in members {
                        if !current.tab_ids.contains(&t) {
                            current.tab_ids.push(t);
                        }
                    }
                }
                Some(_) => {}
                None => {
                    let parent = g
                        .parent_id
                        .clone()
                        .filter(|p| groups.get(p).is_some_and(|p| p.window_id == *window));
                    groups.insert(
                        g.id.clone(),
                        Arc::new(TabGroup {
                            tab_ids: members,
                            parent_id: parent,
                            ..g.clone()
                        }),
                    );
                }
            }
        }
        self.set_groups(groups);
        for split in &snapshot.splits {
            let usable = split.tab_ids().iter().all(|t| {
                self.s.tabs.get(t).is_some_and(|tab| {
                    tab.window_id == *window && tab.profile_id == snapshot.profile_id
                }) && self.s.split_of(t.as_str()).is_none()
            });
            if usable && !self.s.splits.contains_key(&split.id) {
                self.splits_mut()
                    .insert(split.id.clone(), Arc::new(split.clone()));
            }
        }
        if let Some(w) = self.window_mut(window) {
            let order = &snapshot.tab_order;
            w.tab_ids
                .sort_by_key(|t| order.iter().position(|o| o == t).unwrap_or(usize::MAX));
        }
        self.reorder_window(window);
        if let Some(selected) = snapshot
            .selected
            .filter(|s| self.s.tabs.get(s).is_some_and(|t| t.window_id == *window))
        {
            self.activate(&selected);
        }
        Ok(restored.len())
    }

    pub(super) fn rename_tab_id(&mut self, from: &TabId, to: TabId) -> TabId {
        let Some(mut tab) = self.s.tabs.get(from).map(|t| (**t).clone()) else {
            return from.clone();
        };
        tab.id = to.clone();
        let tabs = Arc::make_mut(&mut self.s.tabs);
        tabs.shift_remove(from);
        tabs.insert(to.clone(), Arc::new(tab.clone()));
        if let Some(w) = self.window_mut(&tab.window_id) {
            for t in w.tab_ids.iter_mut().filter(|t| *t == from) {
                *t = to.clone();
            }
            for active in w.active_tab_ids.values_mut().filter(|a| *a == from) {
                *active = to.clone();
            }
        }
        self.note_tab(&to, Topics::TABS, false);
        to
    }

    pub(super) fn restore_tab(
        &mut self,
        entry: &ClosedTab,
        requested: Option<&WindowId>,
    ) -> Result<TabId, ActionError> {
        self.closed_mut().remove(entry.id.as_str());
        let wake = entry
            .tab_id
            .as_ref()
            .filter(|_| !entry.tab.url.is_empty())
            .map(|id| {
                crate::model::restore_id(&TabId::new(
                    entry.restore_from.as_deref().unwrap_or(id.as_str()),
                ))
            });
        if entry.small && !entry.tab.profile_id.is_incognito() {
            let profile =
                Some(entry.tab.profile_id.clone()).filter(|p| self.s.profiles.contains_key(p));
            let window = self.open_window(WindowKind::LittleArdia, profile, None, None)?;
            let first = self.s.windows[&window]
                .tab_ids
                .first()
                .cloned()
                .ok_or(ActionError::Invalid("Little Ardia has no page"))?;
            let snapshot = entry.tab.clone();
            if let Some(t) = self.tab_mut(&first) {
                t.url = snapshot.url;
                t.title = snapshot.title;
                t.favicon = snapshot.favicon;
                t.muted = snapshot.muted;
                t.zoom = snapshot.zoom;
                t.page = TabPage {
                    kind: PageKind::Idle,
                    wake,
                };
            }
            return Ok(first);
        }
        if let Some(tile) = entry
            .tab_id
            .as_ref()
            .filter(|id| entry.pinned_tile && self.s.tabs.get(*id).is_some_and(|t| t.is_pinned()))
            .cloned()
        {
            if let Some(t) = self.tab_mut(&tile).filter(|t| !t.page.has_page()) {
                t.url = entry.tab.url.clone();
                t.title = entry.tab.title.clone();
                t.favicon = entry.tab.favicon.clone();
                t.muted = entry.tab.muted;
                t.page = TabPage {
                    kind: PageKind::Idle,
                    wake: Some(crate::model::restore_id(&TabId::new(
                        entry.restore_from.as_deref().unwrap_or(tile.as_str()),
                    ))),
                };
            }
            self.activate(&tile);
            return Ok(tile);
        }
        let fits = |w: &BrowserWindow| {
            w.kind == WindowKind::Main
                || (w.kind == WindowKind::Incognito
                    && entry.tab.profile_id.is_incognito()
                    && w.profile_id == entry.tab.profile_id)
        };
        let original = self
            .s
            .windows
            .get(&entry.window_id)
            .filter(|w| fits(w))
            .map(|w| w.id.clone());
        let chosen = original
            .or_else(|| {
                requested
                    .filter(|w| self.s.windows.get(*w).is_some_and(|w| fits(w)))
                    .cloned()
            })
            .or_else(|| self.s.main_window_for(None).cloned());
        let window = match chosen {
            Some(w) => w,
            None if entry.tab.profile_id.is_incognito() => {
                return Err(ActionError::Invalid("that private window is gone"));
            }
            None => self.open_window(
                WindowKind::Main,
                Some(entry.tab.profile_id.clone()),
                None,
                None,
            )?,
        };
        let profile_ok = entry.tab.profile_id.is_incognito()
            || self.s.profiles.contains_key(&entry.tab.profile_id);
        let index = if window == entry.window_id && profile_ok {
            entry.profile_index.map_or(Some(entry.index), |pi| {
                self.index_for_profile_index(&window, &entry.tab.profile_id, pi)
            })
        } else {
            None
        };
        let mut snapshot = TabSnapshot {
            pin: None,
            ..entry.tab.clone()
        };
        if !profile_ok {
            snapshot.profile_id = self.s.windows[&window].profile_id.clone();
        }
        let id = self.new_tab(
            &window,
            NewTab {
                index,
                ..NewTab::restoring(snapshot)
            },
        )?;
        if let Some(t) = self.tab_mut(&id) {
            t.page = TabPage {
                kind: PageKind::Idle,
                wake,
            };
        }
        if let Some(info) = &entry.group {
            let existing = self
                .s
                .groups
                .get(&info.id)
                .filter(|g| g.window_id == window)
                .map(|g| g.id.clone());
            match existing {
                Some(group) => {
                    if let Some(g) = self.group_mut(&group) {
                        g.tab_ids.push(id.clone());
                    }
                }
                None => {
                    let gid = if self.s.groups.contains_key(&info.id) {
                        self.ids.group()
                    } else {
                        info.id.clone()
                    };
                    let profile = self.s.tabs[&id].profile_id.clone();
                    let mut group = TabGroup::new(
                        gid.clone(),
                        window.clone(),
                        profile,
                        vec![id.clone()],
                        self.now,
                    );
                    group.name = info.name.clone();
                    group.icon = info.icon.clone();
                    group.color = info.color;
                    group.pinned = info.pinned;
                    Arc::make_mut(&mut self.s.groups).insert(gid, Arc::new(group));
                    self.out.changes.note(Topics::GROUPS, false);
                }
            }
            self.reorder_window(&window);
        }
        self.activate(&id);
        Ok(id)
    }

    pub(super) fn index_for_profile_index(
        &self,
        window: &WindowId,
        profile: &ProfileId,
        profile_index: usize,
    ) -> Option<usize> {
        let w = self.s.windows.get(window)?;
        let mut seen = 0;
        for (i, id) in w.tab_ids.iter().enumerate() {
            if self
                .s
                .tabs
                .get(id)
                .is_some_and(|t| &t.profile_id == profile)
            {
                if seen == profile_index {
                    return Some(i);
                }
                seen += 1;
            }
        }
        Some(w.tab_ids.len())
    }

    pub(super) fn restore_window(&mut self, entry: &ClosedWindow) -> Result<WindowId, ActionError> {
        self.closed_mut().remove(entry.id.as_str());
        let fallback = ProfileId::new(&self.s.settings.default_profile_id);
        let profile_ok = |p: &ProfileId| {
            if self.s.profiles.contains_key(p) {
                p.clone()
            } else {
                fallback.clone()
            }
        };
        let profile_id = entry
            .window
            .profile_id
            .as_ref()
            .map_or_else(|| fallback.clone(), profile_ok);
        let id = self.ids.window();
        let mut w = BrowserWindow::new(id.clone(), WindowKind::Main, profile_id.clone(), self.now);
        w.frame = entry.window.frame;
        w.restored_frame = entry.window.restored_frame;
        w.maximized = entry.window.maximized;
        w.tab_layout = entry.window.tab_layout;
        w.auto_hide_tabs = entry.window.auto_hide_tabs;
        let mut made = Vec::with_capacity(entry.tabs.len());
        let tabs = Arc::make_mut(&mut self.s.tabs);
        for closed in &entry.tabs {
            let snapshot = TabSnapshot {
                profile_id: profile_ok(&closed.snapshot.profile_id),
                ..closed.snapshot.clone()
            };
            let mut tab = Tab::new(
                self.ids.tab(),
                id.clone(),
                snapshot.profile_id.clone(),
                "",
                self.now,
            );
            tab.apply_snapshot(snapshot, self.now);
            tab.page = TabPage {
                kind: PageKind::Idle,
                wake: closed
                    .tab_id
                    .as_ref()
                    .filter(|_| !tab.url.is_empty())
                    .map(crate::model::restore_id),
            };
            if closed.active || !w.active_tab_ids.contains_key(&tab.profile_id) {
                w.active_tab_ids
                    .insert(tab.profile_id.clone(), tab.id.clone());
            }
            made.push(tab.id.clone());
            tabs.insert(tab.id.clone(), Arc::new(tab));
        }
        for t in &made {
            self.note_tab(t, Topics::TABS, false);
        }
        w.tab_ids = order_sections(&made, &self.s.tabs, &self.s.groups);
        Arc::make_mut(&mut self.s.windows).insert(id.clone(), Arc::new(w));
        Arc::make_mut(&mut self.s.window_order).push(id.clone());
        Arc::make_mut(&mut self.s.focus_order).insert(0, id.clone());
        self.note_window(&id, Topics::WINDOWS | Topics::FOCUS);
        let mut groups = (*self.s.groups).clone();
        let mut renamed: Vec<(GroupId, GroupId)> = Vec::new();
        for g in &entry.groups {
            let members: Vec<TabId> = g
                .tab_indexes
                .iter()
                .filter_map(|i| made.get(*i).cloned())
                .collect();
            let Some(first) = members.first().and_then(|t| self.s.tabs.get(t)) else {
                continue;
            };
            let gid = if groups.contains_key(&g.id) {
                self.ids.group()
            } else {
                g.id.clone()
            };
            let mut group = TabGroup::new(
                gid.clone(),
                id.clone(),
                first.profile_id.clone(),
                members,
                g.created_at,
            );
            group.name = g.name.clone();
            group.icon = g.icon.clone();
            group.color = g.color;
            group.collapsed = g.collapsed;
            renamed.push((g.id.clone(), gid.clone()));
            groups.insert(gid, Arc::new(group));
        }
        for g in &entry.groups {
            let mapped = |old: &GroupId| {
                renamed
                    .iter()
                    .find(|(o, _)| o == old)
                    .map(|(_, n)| n.clone())
            };
            if let (Some(gid), Some(parent)) =
                (mapped(&g.id), g.parent_id.as_ref().and_then(mapped))
                && let Some(group) = groups.get_mut(&gid)
            {
                Arc::make_mut(group).parent_id = Some(parent);
            }
        }
        self.set_groups(groups);
        let mut taken: HashSet<TabId> = HashSet::new();
        for shape in entry.splits.clone().unwrap_or_default() {
            let view = shape.into_view(self.ids.split(), id.clone());
            let panes: Option<Vec<TabId>> = view
                .tab_ids()
                .iter()
                .map(|t| {
                    t.as_str()
                        .parse::<usize>()
                        .ok()
                        .and_then(|i| made.get(i).cloned())
                })
                .collect();
            let Some(panes) =
                panes.filter(|p| p.len() >= 2 && p.iter().all(|t| !taken.contains(t)))
            else {
                continue;
            };
            if panes
                .iter()
                .any(|t| self.s.tabs[t].profile_id != self.s.tabs[&panes[0]].profile_id)
            {
                continue;
            }
            taken.extend(panes.iter().cloned());
            let view = view.with_pane_ids(&panes).normalized();
            self.splits_mut().insert(view.id.clone(), Arc::new(view));
        }
        self.adopt_parked_pins(&id, &profile_id);
        self.reorder_window(&id);
        let w = self.s.windows[&id].clone();
        let pin = entry.active_pin.as_ref().and_then(|key| {
            w.tab_ids
                .iter()
                .find(|t| {
                    self.s.in_pinned_container(t.as_str())
                        && self.s.tabs[*t].pin_key() == key.as_str()
                })
                .cloned()
        });
        let shown = pin
            .or_else(|| w.active_tab().cloned())
            .or_else(|| w.tab_ids.first().cloned());
        match shown {
            Some(shown) => self.activate(&shown),
            None => {
                self.new_tab(&id, NewTab::default())?;
            }
        }
        self.out.window = Some(id.clone());
        Ok(id)
    }

    pub(super) fn restore_entry(
        &mut self,
        id: &EntryId,
        requested: Option<&WindowId>,
    ) -> Result<(), ActionError> {
        let closed = Arc::clone(&self.s.closed);
        if let Some(entry) = closed
            .tabs
            .iter()
            .chain(closed.cleaned_tabs.iter())
            .find(|c| c.id == *id)
        {
            self.restore_tab(entry, requested)?;
        } else if let Some(entry) = closed.windows.iter().find(|c| c.id == *id) {
            self.restore_window(entry)?;
        } else if let Some(entry) = closed
            .groups
            .iter()
            .chain(closed.deleted_groups.iter())
            .find(|c| c.id == *id)
        {
            self.restore_group(entry, requested)?;
        } else {
            return Err(ActionError::Invalid(
                "that entry is no longer in recently closed",
            ));
        }
        Ok(())
    }

    pub(super) fn reopen(&mut self, window: Option<&WindowId>) -> Result<(), ActionError> {
        let id = self
            .s
            .newest_closed(window)
            .map(|e| e.id().clone())
            .ok_or(ActionError::Invalid("nothing was closed recently"))?;
        let closed = Arc::clone(&self.s.closed);
        match closed.newest(|e| e.id() == &id) {
            Some(ClosedEntry::Tab(entry)) => self.restore_tab(entry, window).map(|_| ()),
            Some(ClosedEntry::Window(entry)) => self.restore_window(entry).map(|_| ()),
            Some(ClosedEntry::Group(entry)) => self.restore_group(entry, window).map(|_| ()),
            None => Err(ActionError::Invalid("nothing was closed recently")),
        }
    }

    pub(super) fn clear_recently_closed(&mut self, window: Option<&WindowId>) -> usize {
        let gone = crate::closed::recently_closed_to_clear(self.s, window);
        if gone.is_empty() {
            return 0;
        }
        let closed = self.closed_mut();
        closed.tabs.retain(|c| !gone.contains(&c.id));
        closed.windows.retain(|c| !gone.contains(&c.id));
        closed.groups.retain(|c| !gone.contains(&c.id));
        gone.len()
    }
}
