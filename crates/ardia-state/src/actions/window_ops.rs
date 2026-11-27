use super::*;

impl Tx<'_> {
    pub(super) fn is_last_main_window(&self, window: &WindowId) -> bool {
        self.s
            .windows
            .get(window)
            .is_some_and(|w| w.kind == WindowKind::Main)
            && self
                .s
                .windows
                .values()
                .all(|o| o.id == *window || o.kind != WindowKind::Main)
    }

    pub(super) fn closed_window_entry(
        &self,
        w: &BrowserWindow,
        keeps_last: bool,
    ) -> Option<ClosedWindow> {
        let regular: Vec<Arc<Tab>> = w
            .tab_ids
            .iter()
            .filter_map(|t| self.s.tabs.get(t))
            .filter(|t| !self.s.in_pinned_container(t.id.as_str()))
            .filter(|t| !crate::tab_share::shared_elsewhere(self.s, t))
            .cloned()
            .collect();
        let keeps = keeps_last
            && w.tab_ids
                .iter()
                .any(|t| self.s.tabs.get(t).is_some_and(|t| !t.url.is_empty()));
        if !keeps && regular.iter().all(|t| t.url.is_empty()) {
            return None;
        }
        let active: HashSet<&TabId> = w.active_tab_ids.values().collect();
        let index_of = |id: &TabId| regular.iter().position(|t| t.id == *id);
        let groups = self
            .s
            .groups
            .values()
            .filter(|g| g.window_id == w.id && !g.pinned)
            .map(|g| ClosedWindowGroup {
                id: g.id.clone(),
                name: g.name.clone(),
                icon: g.icon.clone(),
                color: g.color,
                collapsed: g.collapsed,
                pinned: false,
                created_at: g.created_at,
                parent_id: g.parent_id.clone(),
                tab_indexes: g.tab_ids.iter().filter_map(index_of).collect(),
                extra: Default::default(),
            })
            .collect();
        let splits: Vec<SplitShape> = self
            .s
            .splits
            .values()
            .filter(|s| s.window_id == w.id)
            .filter_map(|s| {
                let at: Option<Vec<TabId>> = s
                    .tab_ids()
                    .iter()
                    .map(|t| index_of(t).map(|i| TabId::new(i.to_string())))
                    .collect();
                at.map(|at| SplitShape::of(&s.with_pane_ids(&at)))
            })
            .collect();
        let shown = w.active_tab().and_then(|t| self.s.tabs.get(t));
        let active_pin = shown
            .filter(|t| keeps && self.s.in_pinned_container(t.id.as_str()))
            .map(|t| t.pin_key().to_owned());
        let engine_id = |t: &Tab| {
            if t.page.has_page() {
                Some(t.id.clone())
            } else {
                t.page.pending_restore().map(TabId::new)
            }
        };
        Some(ClosedWindow {
            kind: crate::closed::ClosedKind::Window,
            id: self.ids.entry("cw"),
            window: ClosedWindowFrame {
                profile_id: Some(w.profile_id.clone()),
                frame: w.frame,
                restored_frame: w.restored_frame,
                maximized: w.maximized,
                tab_layout: w.tab_layout,
                auto_hide_tabs: w.auto_hide_tabs,
                extra: Default::default(),
            },
            tabs: regular
                .iter()
                .map(|t| ClosedWindowTab {
                    snapshot: t.snapshot(),
                    active: active.contains(&t.id),
                    tab_id: engine_id(t),
                })
                .collect(),
            groups,
            splits: (!splits.is_empty()).then_some(splits),
            closed_at: self.now,
            last_window: keeps,
            active_pin,
            extra: Default::default(),
        })
    }

    pub(crate) fn close_window(&mut self, window: &WindowId, keeps_last: bool) {
        if self.s.windows.contains_key(window) {
            let back = crate::pin_share::return_shared_pages(self.s, window);
            self.out.changes.note_settled(self.s, &back);
            *self.s = back;
            self.hand_over_tabs(window);
        }
        let Some(w) = self.s.windows.get(window).cloned() else {
            return;
        };
        let focused = self.s.focus_order.first() == Some(window);
        match w.kind {
            WindowKind::Main => {
                let last = self.is_last_main_window(window);
                let entry = self.closed_window_entry(&w, last && keeps_last);
                if last && self.s.closed.windows.iter().any(|c| c.last_window) {
                    self.closed_mut().drop_last_window_marks();
                }
                if let Some(entry) = entry {
                    self.closed_mut().push_window(entry);
                }
                self.park_pins(&w);
            }
            WindowKind::LittleArdia => {
                let tabs = w.tab_ids.clone();
                self.remove_tabs(&tabs, true);
            }
            WindowKind::Incognito if self.s.closed.tabs.iter().any(|c| c.window_id == *window) => {
                self.closed_mut().tabs.retain(|c| c.window_id != *window);
            }
            _ => {}
        }
        let mut all: Vec<TabId> = w.tab_ids.clone();
        all.extend(w.chrome.peek.as_ref().map(|p| p.tab_id.clone()));
        let tabs = Arc::make_mut(&mut self.s.tabs);
        for id in &all {
            tabs.shift_remove(id);
        }
        for id in &all {
            self.note_tab(id, Topics::TABS, false);
        }
        if self.s.groups.values().any(|g| g.window_id == *window) {
            let groups: groups::Groups = self
                .s
                .groups
                .iter()
                .filter(|(_, g)| g.window_id != *window)
                .map(|(k, g)| (k.clone(), Arc::clone(g)))
                .collect();
            self.set_groups(groups);
        }
        if self.s.splits.values().any(|s| s.window_id == *window) {
            self.splits_mut().retain(|_, s| s.window_id != *window);
        }
        Arc::make_mut(&mut self.s.windows).shift_remove(window);
        Arc::make_mut(&mut self.s.window_order).retain(|w| w != window);
        Arc::make_mut(&mut self.s.focus_order).retain(|w| w != window);
        if self.s.cleared.contains_key(window) {
            Arc::make_mut(&mut self.s.cleared).shift_remove(window);
        }
        if focused && w.kind != WindowKind::Incognito {
            let next = self
                .s
                .focus_order
                .iter()
                .filter_map(|f| self.s.windows.get(f))
                .find(|o| o.kind != WindowKind::LittleArdia)
                .map(|o| o.profile_id.clone());
            if let Some(profile) = next
                .map(|p| {
                    if p.is_incognito() {
                        p.incognito_original()
                    } else {
                        p
                    }
                })
                .filter(|p| self.s.profiles.contains_key(p))
            {
                self.s.last_profile_id = Some(profile);
            }
        }
        self.note_window(window, Topics::WINDOWS | Topics::FOCUS);
        self.out.closed_windows.push(window.clone());
    }

    pub(super) fn open_last_window_or_new(&mut self) -> Result<WindowId, ActionError> {
        if let Some(open) = self.s.main_window_for(None).cloned() {
            self.focus_window(&open)?;
            self.out.window = Some(open.clone());
            return Ok(open);
        }
        match self
            .s
            .closed
            .windows
            .last()
            .filter(|c| c.last_window)
            .cloned()
        {
            Some(entry) => self.restore_window(&entry),
            None => self.open_window(WindowKind::Main, None, None, None),
        }
    }

    pub(super) fn park_pins(&mut self, w: &BrowserWindow) {
        let others_hold: HashSet<ProfileId> = self
            .s
            .windows
            .values()
            .filter(|o| o.id != w.id && o.kind == WindowKind::Main)
            .flat_map(|o| {
                o.tab_ids
                    .iter()
                    .filter_map(|t| self.s.tabs.get(t))
                    .filter(|t| t.is_pinned())
                    .map(|t| t.profile_id.clone())
            })
            .collect();
        let mut parked: Vec<(ProfileId, ParkedPins)> = Vec::new();
        for profile in w
            .tab_ids
            .iter()
            .filter_map(|t| self.s.tabs.get(t))
            .filter(|t| t.is_pinned())
            .map(|t| t.profile_id.clone())
        {
            if others_hold.contains(&profile)
                || profile.is_incognito()
                || parked.iter().any(|(p, _)| *p == profile)
            {
                continue;
            }
            let pinned_groups: Vec<&Arc<TabGroup>> = self
                .s
                .groups
                .values()
                .filter(|g| g.window_id == w.id && g.pinned && g.profile_id == profile)
                .collect();
            let tabs = w
                .tab_ids
                .iter()
                .filter_map(|t| self.s.tabs.get(t))
                .filter(|t| {
                    t.profile_id == profile
                        && (t.is_pinned()
                            || pinned_groups.iter().any(|g| g.tab_ids.contains(&t.id)))
                })
                .map(|t| ParkedTab {
                    snapshot: t.snapshot(),
                    id: t.pin_key().to_owned(),
                    group_id: pinned_groups
                        .iter()
                        .rev()
                        .find(|g| g.tab_ids.contains(&t.id))
                        .map(|g| g.pin_key().to_owned()),
                    restore_from: Some(t.id.to_string()),
                })
                .collect();
            let groups = pinned_groups
                .iter()
                .map(|g| ParkedGroup {
                    id: g.pin_key().to_owned(),
                    name: g.name.clone(),
                    icon: g.icon.clone(),
                    color: g.color,
                    collapsed: g.collapsed,
                    parent_id: g.parent_id.as_ref().map(|p| p.to_string()),
                })
                .collect();
            parked.push((
                profile,
                ParkedPins {
                    tabs,
                    groups,
                    splits: None,
                },
            ));
        }
        if parked.is_empty() {
            return;
        }
        let persisted = Arc::make_mut(&mut self.s.persisted);
        for (profile, pins) in parked {
            persisted.parked_pins.insert(profile, pins);
        }
        self.out.changes.note(Topics::PINS, false);
    }

    pub(super) fn adopt_parked_pins(&mut self, window: &WindowId, profile: &ProfileId) {
        let Some(parked) = self.s.persisted.parked_pins.get(profile).cloned() else {
            return;
        };
        Arc::make_mut(&mut self.s.persisted)
            .parked_pins
            .shift_remove(profile);
        self.out.changes.note(Topics::PINS, false);
        let mut made: Vec<(String, TabId)> = Vec::new();
        for (i, parked_tab) in parked.tabs.iter().enumerate() {
            let pin = parked_tab.snapshot.pin.clone();
            let snapshot = TabSnapshot {
                pin,
                ..parked_tab.snapshot.clone()
            };
            if let Ok(id) = self.new_tab(
                window,
                NewTab {
                    profile: Some(profile.clone()),
                    background: true,
                    index: Some(i),
                    ..NewTab::restoring(snapshot)
                },
            ) {
                if let Some(t) = self.tab_mut(&id) {
                    t.page = TabPage::ASLEEP;
                    t.pin_key = Some(parked_tab.id.clone());
                    t.unseen = false;
                }
                made.push((parked_tab.group_id.clone().unwrap_or_default(), id));
            }
        }
        for g in &parked.groups {
            let members: Vec<TabId> = made
                .iter()
                .filter(|(gid, _)| *gid == g.id)
                .map(|(_, t)| t.clone())
                .collect();
            if members.is_empty() {
                continue;
            }
            let id = self.ids.group();
            let mut group = TabGroup::new(
                id.clone(),
                window.clone(),
                profile.clone(),
                members,
                self.now,
            );
            group.name = g.name.clone();
            group.icon = g.icon.clone();
            group.color = g.color;
            group.collapsed = g.collapsed;
            group.pinned = true;
            group.pin_key = Some(g.id.clone());
            Arc::make_mut(&mut self.s.groups).insert(id, Arc::new(group));
            self.out.changes.note(Topics::GROUPS, false);
        }
        self.reorder_window(window);
    }

    pub(super) fn open_window(
        &mut self,
        kind: WindowKind,
        profile: Option<ProfileId>,
        url: Option<String>,
        frame: Option<Frame>,
    ) -> Result<WindowId, ActionError> {
        let id = self.ids.window();
        let base = profile
            .filter(|p| self.s.profiles.contains_key(p))
            .unwrap_or_else(|| self.s.last_active_profile());
        let profile_id = if kind == WindowKind::Incognito {
            ProfileId::incognito(&id, &base)
        } else {
            base
        };
        let mut w = BrowserWindow::new(id.clone(), kind, profile_id.clone(), self.now);
        w.frame = frame;
        Arc::make_mut(&mut self.s.windows).insert(id.clone(), Arc::new(w));
        Arc::make_mut(&mut self.s.window_order).push(id.clone());
        Arc::make_mut(&mut self.s.focus_order).insert(0, id.clone());
        self.note_window(&id, Topics::WINDOWS | Topics::FOCUS);
        if kind == WindowKind::Main {
            self.adopt_parked_pins(&id, &profile_id);
        }
        if kind.has_tabs() {
            let tab = self.new_tab(
                &id,
                NewTab {
                    url,
                    profile: Some(profile_id),
                    ..NewTab::default()
                },
            )?;
            self.activate(&tab);
        }
        self.out.window = Some(id.clone());
        Ok(id)
    }

    pub(super) fn focus_window(&mut self, window: &WindowId) -> Result<(), ActionError> {
        let w = self.require_window(window)?;
        let order = Arc::make_mut(&mut self.s.focus_order);
        order.retain(|id| id != window);
        order.insert(0, window.clone());
        if w.kind == WindowKind::Main && !w.profile_id.is_incognito() {
            self.s.last_profile_id = Some(w.profile_id.clone());
        }
        self.note_window(window, Topics::FOCUS);
        Ok(())
    }

    pub(super) fn switch_profile(
        &mut self,
        window: &WindowId,
        profile: &ProfileId,
    ) -> Result<(), ActionError> {
        let w = self.require_window(window)?;
        if !self.s.profiles.contains_key(profile) {
            return Err(ActionError::NoProfile(profile.to_string()));
        }
        if w.kind == WindowKind::Incognito {
            return Err(ActionError::Invalid("incognito windows keep their profile"));
        }
        if !w
            .tab_ids
            .iter()
            .any(|t| self.s.tabs.get(t).is_some_and(|t| &t.profile_id == profile))
        {
            if w.kind == WindowKind::Main {
                self.adopt_parked_pins(window, profile);
            }
            if !self.s.windows[window].tab_ids.iter().any(|t| {
                self.s
                    .tabs
                    .get(t)
                    .is_some_and(|t| &t.profile_id == profile && !t.is_pinned())
            }) {
                self.new_tab(
                    window,
                    NewTab {
                        profile: Some(profile.clone()),
                        background: true,
                        ..NewTab::default()
                    },
                )?;
            }
        }
        let active = self.s.windows[window]
            .active_tab_ids
            .get(profile)
            .cloned()
            .or_else(|| {
                self.s.windows[window]
                    .tab_ids
                    .iter()
                    .find(|t| {
                        self.s
                            .tabs
                            .get(*t)
                            .is_some_and(|t| &t.profile_id == profile)
                    })
                    .cloned()
            });
        if let Some(w) = self.window_mut(window) {
            w.profile_id = profile.clone();
        }
        if let Some(active) = active {
            self.activate(&active);
        }
        if w.kind == WindowKind::Main {
            self.s.last_profile_id = Some(profile.clone());
            self.out.changes.note(Topics::FOCUS, false);
        }
        Ok(())
    }

    pub(super) fn promote_little(&mut self, window: &WindowId) -> Result<TabId, ActionError> {
        let w = self.require_window(window)?;
        if w.kind != WindowKind::LittleArdia {
            return Err(ActionError::Invalid(
                "only Little Ardia windows open in Ardia",
            ));
        }
        let tab = w
            .tab_ids
            .first()
            .cloned()
            .ok_or(ActionError::Invalid("Little Ardia has no page"))?;
        let profile = self.s.tabs.get(&tab).map(|t| t.profile_id.clone());
        let target = match self.s.main_window_for(profile.as_ref()).cloned() {
            Some(target) => target,
            None => {
                let created = self.open_window(WindowKind::Main, profile, None, None)?;
                let blank: Vec<TabId> = self.s.windows[&created]
                    .tab_ids
                    .iter()
                    .filter(|t| {
                        self.s
                            .tabs
                            .get(*t)
                            .is_some_and(|t| t.url.is_empty() && !t.is_pinned())
                    })
                    .cloned()
                    .collect();
                self.remove_tabs(&blank, false);
                created
            }
        };
        let index = {
            let tw = self.require_window(&target)?;
            let t = self.require_tab(&tab)?;
            self.insertion_index(&tw, &t, false)
        };
        self.move_tab(&tab, &target, index)?;
        if self.s.windows.contains_key(window) {
            self.close_window(window, false);
        }
        self.focus_window(&target)?;
        Ok(tab)
    }

    pub(super) fn push_toast(&mut self, window: WindowId, toast: Toast) -> Result<(), ActionError> {
        let w = self
            .window_mut_as(&window, Topics::CHROME)
            .ok_or_else(|| ActionError::NoWindow(window.to_string()))?;
        w.push_toast(toast);
        Ok(())
    }

    pub(super) fn dismiss_toast(&mut self, window: WindowId, id: u64) -> Result<(), ActionError> {
        let w = self
            .window_mut_as(&window, Topics::CHROME)
            .ok_or_else(|| ActionError::NoWindow(window.to_string()))?;
        w.chrome.toasts.retain(|t| t.id != id);
        Ok(())
    }
}
