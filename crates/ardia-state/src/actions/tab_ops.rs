use super::*;

impl Tx<'_> {
    pub(crate) fn new_tab(
        &mut self,
        window: &WindowId,
        spec: NewTab,
    ) -> Result<TabId, ActionError> {
        let w = self.require_window(window)?;
        let profile = if w.kind == WindowKind::Incognito {
            w.profile_id.clone()
        } else {
            spec.profile
                .filter(|p| self.s.profiles.contains_key(p))
                .unwrap_or_else(|| w.profile_id.clone())
        };
        let id = self.ids.tab();
        let opener = spec
            .opener
            .clone()
            .filter(|_| w.kind != WindowKind::LittleArdia);
        let mut tab = Tab::new(id.clone(), window.clone(), profile.clone(), "", self.now);
        match spec.snapshot {
            Some(snapshot) => {
                tab.apply_snapshot(*snapshot, self.now);
                tab.profile_id = profile.clone();
                tab.page = TabPage::IDLE;
            }
            None => {
                tab.url = spec
                    .url
                    .as_deref()
                    .map(|u| self.resolve_url(u))
                    .unwrap_or_default();
                if !tab.url.is_empty() {
                    tab.page = TabPage::LOADED;
                }
            }
        }
        if spec.pin.is_some() {
            tab.pin = spec.pin;
        }
        if tab.pin.is_some() && tab.pinned_url.is_none() {
            tab.pinned_url = Some(tab.url.clone()).filter(|u| !u.is_empty());
        }
        tab.opener_id = spec.opener.clone();
        tab.link_opener_id = spec.opener;
        tab.unseen = spec.background;
        let index = spec.index.unwrap_or_else(|| {
            if tab.pin.is_some() {
                w.tab_ids
                    .iter()
                    .rposition(|t| self.s.tabs.get(t).is_some_and(|t| t.is_pinned()))
                    .map_or(0, |i| i + 1)
            } else {
                self.insertion_index(&w, &tab, spec.background)
            }
        });
        Arc::make_mut(&mut self.s.tabs).insert(id.clone(), Arc::new(tab));
        self.note_tab(&id, Topics::TABS, false);
        if let Some(w) = self.window_mut(window) {
            let at = index.min(w.tab_ids.len());
            w.tab_ids.insert(at, id.clone());
            w.active_tab_ids
                .entry(profile)
                .or_insert_with(|| id.clone());
        }
        self.reorder_window(window);
        if let Some(opener) = opener {
            self.group_with_opener(&id, &opener, spec.background);
        }
        if !spec.background {
            self.activate(&id);
        }
        self.out.tab = Some(id.clone());
        Ok(id)
    }

    fn group_with_opener(&mut self, id: &TabId, opener: &TabId, background: bool) {
        let (Some(tab), Some(source)) = (self.s.tabs.get(id), self.s.tabs.get(opener)) else {
            return;
        };
        if source.window_id != tab.window_id
            || source.profile_id != tab.profile_id
            || tab.pin.is_some()
        {
            return;
        }
        let profile = tab.profile_id.clone();
        let creates = background && self.s.settings.cmd_click_creates_tab_group;
        if self.s.in_pinned_container(opener.as_str()) {
            let gathered = self
                .s
                .groups
                .values()
                .find(|g| {
                    g.pinned_opener_id.as_ref() == Some(opener)
                        && g.profile_id == profile
                        && !g.tab_ids.is_empty()
                })
                .map(|g| g.id.clone());
            if let Some(group) = gathered {
                let _ = self.add_to_group(group, vec![id.clone()]);
            } else if creates && let Ok(group) = self.create_group(std::slice::from_ref(id), "") {
                self.mark_opener_group(&group, Some(opener.clone()));
            }
            return;
        }
        if let Some(existing) = self.s.group_of(opener.as_str()).map(|g| g.id.clone()) {
            let _ = self.add_to_group(existing, vec![id.clone()]);
        } else if creates && let Ok(group) = self.create_group(&[opener.clone(), id.clone()], "") {
            self.mark_opener_group(&group, None);
        }
    }

    fn mark_opener_group(&mut self, group: &GroupId, pinned_opener: Option<TabId>) {
        if let Some(g) = Arc::make_mut(&mut self.s.groups).get_mut(group) {
            let g = Arc::make_mut(g);
            g.auto_ungroup = true;
            g.pinned_opener_id = pinned_opener;
        }
    }

    pub(crate) fn activate(&mut self, id: &TabId) {
        let Some(tab) = self.s.tabs.get(id).cloned() else {
            return;
        };
        if tab.live.peek {
            return;
        }
        if let Some((next, holder)) = crate::pin_share::handed_off(self.s, id) {
            self.out.changes.note_settled(self.s, &next);
            *self.s = next;
            return self.activate(&holder);
        }
        let now = self.now;
        if let Some(t) = self.tab_mut_as(id, Topics::TABS, true) {
            t.unseen = false;
            t.last_active_at = now;
            if t.page.kind == PageKind::Asleep {
                t.page = TabPage {
                    kind: PageKind::Idle,
                    wake: t.page.wake.clone(),
                };
            }
        }
        let kind = self.s.windows.get(&tab.window_id).map(|w| w.kind);
        if let Some(w) = self.window_mut(&tab.window_id) {
            if kind != Some(WindowKind::Incognito) {
                w.profile_id = tab.profile_id.clone();
            }
            w.active_tab_ids.insert(tab.profile_id.clone(), id.clone());
            w.chrome.command_bar.open = false;
        }
        if kind == Some(WindowKind::Main)
            && self.s.last_profile_id.as_ref() != Some(&tab.profile_id)
            && !tab.profile_id.is_incognito()
        {
            self.s.last_profile_id = Some(tab.profile_id.clone());
            self.out.changes.note(Topics::FOCUS, false);
        }
    }

    pub(super) fn move_tab(
        &mut self,
        id: &TabId,
        window: &WindowId,
        index: usize,
    ) -> Result<(), ActionError> {
        let tab = self.require_listed_tab(id)?;
        let target = self.require_window(window)?;
        if target.kind == WindowKind::Incognito && !tab.profile_id.is_incognito()
            || (tab.profile_id.is_incognito() && target.id != tab.window_id)
        {
            return Err(ActionError::Invalid(
                "tabs can't move in or out of incognito windows",
            ));
        }
        let from = tab.window_id.clone();
        if from != *window {
            self.settle_peeks(&HashSet::from([id.clone()]));
            let gone = HashSet::from([id.clone()]);
            if let Some(split) = self.s.split_of(id.as_str()).cloned() {
                let rest = split.without_panes(&gone);
                let splits = self.splits_mut();
                if rest.pane_count() >= 2 {
                    splits.insert(split.id.clone(), Arc::new(rest))
                } else {
                    splits.shift_remove(&split.id)
                };
            }
            let left = groups::leave_groups(&self.s.groups, &gone);
            self.set_groups(left);
            let source = self.require_window(&from)?;
            let successor = (source.active_tab_ids.get(&tab.profile_id) == Some(id))
                .then(|| self.successor(&source, &tab.profile_id, id, &gone))
                .flatten();
            if let Some(w) = self.window_mut(&from) {
                w.tab_ids.retain(|t| t != id);
                match successor {
                    Some(next) => {
                        w.active_tab_ids.insert(tab.profile_id.clone(), next);
                    }
                    None => {
                        if w.active_tab_ids.get(&tab.profile_id) == Some(id) {
                            w.active_tab_ids.shift_remove(&tab.profile_id);
                        }
                    }
                }
            }
            if let Some(t) = self.tab_mut(id) {
                t.window_id = window.clone();
                t.opener_id = None;
            }
        }
        if let Some(w) = self.window_mut(window) {
            w.tab_ids.retain(|t| t != id);
            let at = index.min(w.tab_ids.len());
            w.tab_ids.insert(at, id.clone());
        }
        self.reorder_window(window);
        if from != *window {
            self.reorder_window(&from);
            if self
                .s
                .windows
                .get(&from)
                .is_some_and(|w| w.tab_ids.is_empty())
            {
                self.close_window(&from, false);
            }
            self.activate(id);
        }
        Ok(())
    }

    pub(super) fn set_pin(&mut self, id: &TabId, pin: Option<TabPin>) -> Result<(), ActionError> {
        let tab = self.require_listed_tab(id)?;
        if tab.profile_id.is_incognito() && pin.is_some() {
            return Err(ActionError::Invalid("incognito tabs can't be pinned"));
        }
        let home = pin.as_ref().map(|_| {
            tab.pinned_url
                .clone()
                .filter(|h| !h.is_empty())
                .unwrap_or_else(|| tab.url.clone())
        });
        if pin.is_some() {
            let gone = HashSet::from([id.clone()]);
            let left = groups::leave_groups(&self.s.groups, &gone);
            if left != *self.s.groups {
                self.set_groups(left);
            }
        }
        if let Some(t) = self.tab_mut(id) {
            t.pin = pin;
            t.pinned_url = home.filter(|h| !h.is_empty());
        }
        self.reorder_window(&tab.window_id);
        Ok(())
    }

    pub(super) fn navigate(&mut self, id: &TabId, input: &str) -> Result<(), ActionError> {
        let tab = self.require_tab(id)?;
        if !tab.page.has_page()
            && let Some(holder) = crate::pin_share::holder_of(self.s, id).map(|h| h.id.clone())
        {
            let shown = self
                .s
                .windows
                .get(&tab.window_id)
                .and_then(|w| w.active_tab())
                == Some(id);
            if !shown {
                return self.navigate(&holder, input);
            }
            self.activate(id);
            let here = self
                .s
                .tabs
                .get(&holder)
                .is_some_and(|h| h.window_id == tab.window_id && h.page.has_page());
            return if here {
                self.navigate(&holder, input)
            } else {
                Ok(())
            };
        }
        let url = self.resolve_url(input);
        if url.is_empty() {
            return Err(ActionError::Invalid("there is nothing to open"));
        }
        if !tab.url.is_empty() {
            self.forget_openers(&tab.window_id, &tab.profile_id);
        }
        if let Some(t) = self.tab_mut(id) {
            if t.url.is_empty() {
                t.url = url.clone();
            }
            t.page = TabPage::LOADED;
            t.chrome_opened = false;
            t.live.navigation = Some(url);
            t.live.loading = true;
            t.live.progress = 0.0;
        }
        self.out.tab = Some(id.clone());
        Ok(())
    }

    pub(super) fn switch_keeps_openers(&self, from: &TabId, to: &TabId) -> bool {
        let opener = |id: &TabId| self.s.tabs.get(id).and_then(|t| t.opener_id.clone());
        let (a, b) = (opener(from), opener(to));
        a == b || b.as_ref() == Some(from) || a.as_ref() == Some(to)
    }

    pub(super) fn forget_openers(&mut self, window: &WindowId, profile: &ProfileId) {
        let Some(w) = self.s.windows.get(window) else {
            return;
        };
        let ids: Vec<TabId> = w
            .tab_ids
            .iter()
            .filter(|t| {
                self.s
                    .tabs
                    .get(*t)
                    .is_some_and(|t| t.opener_id.is_some() && &t.profile_id == profile)
            })
            .cloned()
            .collect();
        for id in ids {
            if let Some(t) = self.tab_mut(&id) {
                t.opener_id = None;
            }
        }
    }

    pub(super) fn switch_to(&mut self, id: &TabId) {
        let Some(tab) = self.s.tabs.get(id).cloned() else {
            return;
        };
        let shown = self
            .s
            .windows
            .get(&tab.window_id)
            .and_then(|w| w.active_tab().cloned());
        self.activate(id);
        if shown.is_some_and(|shown| shown != *id && !self.switch_keeps_openers(&shown, id)) {
            self.forget_openers(&tab.window_id, &tab.profile_id);
        }
    }

    pub(super) fn update_page(
        &mut self,
        id: &TabId,
        update: PageUpdate,
    ) -> Result<(), ActionError> {
        let tab = self.require_tab(id)?;
        if !tab.live.peek && update.url.as_ref().is_some_and(|u| !same_page(u, &tab.url)) {
            self.settle_peeks(&HashSet::from([id.clone()]));
        }
        let persisted = update.url.as_ref().is_some_and(|u| *u != tab.url);
        let cosmetic = update.title.as_ref().is_some_and(|t| *t != tab.title)
            || update.favicon.as_ref().is_some_and(|f| *f != tab.favicon);
        let topics = if persisted || cosmetic {
            Topics::TABS | Topics::LIVE
        } else {
            Topics::LIVE
        };
        self.edit_tab(id, topics, !persisted, |t| {
            if let Some(url) = update.url {
                if url != t.url {
                    t.page.wake = None;
                }
                t.url = url;
                t.live.navigation = None;
                if !t.page.has_page() {
                    t.page.kind = PageKind::Loaded;
                }
            }
            if let Some(title) = update.title {
                t.title = title;
            }
            if let Some(favicon) = update.favicon {
                t.favicon = favicon;
            }
            let live = &mut t.live;
            if let Some(v) = update.loading {
                live.loading = v;
            }
            if let Some(v) = update.progress.filter(|p| p.is_finite()) {
                live.progress = v.clamp(0.0, 1.0);
            }
            if let Some(v) = update.can_go_back {
                live.can_go_back = v;
            }
            if let Some(v) = update.can_go_forward {
                live.can_go_forward = v;
            }
            if let Some(v) = update.audible {
                live.audible = v;
            }
            if let Some(v) = update.theme_color {
                live.theme_color = v;
            }
            if let Some(v) = update.icon_theme {
                live.icon_theme = v;
            }
            if let Some(v) = update.security {
                live.security = v;
            }
            if let Some(v) = update.unread_count {
                live.unread_count = v;
            }
            if let Some(v) = update.blocked_requests {
                live.blocked_requests = v;
            }
            if let Some(v) = update.engine_tab_id {
                live.engine_tab_id = v;
            }
            if let Some(v) = update.fullscreen {
                live.fullscreen = v;
            }
        })?;
        Ok(())
    }

    pub(super) fn sleep_tabs(&mut self, ids: &[TabId]) {
        let listed: Vec<&TabId> = ids.iter().filter(|id| self.is_listed(id)).collect();
        for id in listed {
            let active = self
                .s
                .tabs
                .get(id)
                .and_then(|t| self.s.windows.get(&t.window_id))
                .is_some_and(|w| w.active_tab() == Some(id));
            if active {
                continue;
            }
            if let Some(t) = self.tab_mut(id) {
                t.page = TabPage {
                    kind: PageKind::Asleep,
                    wake: t.page.wake.clone(),
                };
                t.live.loading = false;
            }
        }
    }

    pub(super) fn unload_top_app(&mut self, id: &TabId) {
        if !self.is_listed(id) {
            return;
        }
        let pages = crate::pin_share::open_pages(self.s, id);
        let ids = if pages.is_empty() {
            vec![id.clone()]
        } else {
            pages
        };
        let before = self.keeps_top_apps.replace(false);
        self.close_tabs(&ids, false);
        self.keeps_top_apps = before;
    }

    pub(super) fn forget_pages(&mut self, ids: &[TabId]) {
        let listed: Vec<&TabId> = ids.iter().filter(|id| self.is_listed(id)).collect();
        for id in listed {
            let loaded = self.s.tabs.get(id).is_some_and(|t| t.page.has_page());
            if !loaded {
                continue;
            }
            if let Some(t) = self.tab_mut(id) {
                t.page = TabPage {
                    kind: PageKind::Idle,
                    wake: t.page.wake.clone(),
                };
                t.live.loading = false;
            }
        }
    }

    pub(super) fn duplicate(&mut self, id: &TabId) -> Result<TabId, ActionError> {
        let tab = self.require_listed_tab(id)?;
        let window = tab.window_id.clone();
        let index = self
            .s
            .windows
            .get(&window)
            .and_then(|w| w.tab_ids.iter().position(|t| t == id))
            .map(|i| i + 1);
        let snapshot = TabSnapshot {
            pin: None,
            ..tab.snapshot()
        };
        let new = self.new_tab(
            &window,
            NewTab {
                index,
                ..NewTab::restoring(snapshot)
            },
        )?;
        if let Some(t) = self.tab_mut(&new) {
            t.page = TabPage::LOADED;
        }
        self.activate(&new);
        Ok(new)
    }

    pub(super) fn return_to_pinned(&mut self, id: &TabId) -> Result<(), ActionError> {
        let tab = self.require_tab(id)?;
        let home = tab
            .pinned_url
            .clone()
            .filter(|h| !h.is_empty())
            .ok_or(ActionError::Invalid("this tab has no pinned address"))?;
        if let Some(t) = self.tab_mut(id) {
            t.url = home;
            t.page = TabPage::LOADED;
        }
        Ok(())
    }

    pub(super) fn set_pinned_url(
        &mut self,
        id: &TabId,
        url: Option<String>,
    ) -> Result<(), ActionError> {
        let tab = self.require_tab(id)?;
        let next = url
            .clone()
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| tab.url.clone());
        if next.is_empty() || !self.s.in_pinned_container(id.as_str()) {
            return Err(ActionError::Invalid(
                "only a pinned tab has a pinned address",
            ));
        }
        let moves = url.is_some() && !crate::tabs::same_page_key(&tab.url, &next);
        if let Some(t) = self.tab_mut(id) {
            t.pinned_url = Some(next.clone());
            if moves {
                t.url = next;
                t.page = TabPage::LOADED;
            }
        }
        Ok(())
    }

    pub(super) fn cycle(&mut self, window: &WindowId, delta: i32) -> Result<(), ActionError> {
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
        if view.is_empty() {
            return Ok(());
        }
        let at = w
            .active_tab()
            .and_then(|a| view.iter().position(|t| t == a))
            .unwrap_or(0) as i64;
        let next = (at + i64::from(delta)).rem_euclid(view.len() as i64) as usize;
        self.switch_to(&view[next]);
        Ok(())
    }

    pub(super) fn select_at(
        &mut self,
        window: &WindowId,
        index: Option<usize>,
    ) -> Result<(), ActionError> {
        let w = self.require_window(window)?;
        let view: Vec<TabId> =
            w.tab_ids
                .iter()
                .filter(|t| {
                    self.s.tabs.get(*t).is_some_and(|t| {
                        t.profile_id == w.profile_id && !self.s.hidden_empty_card(t)
                    })
                })
                .cloned()
                .collect();
        let pick = match index {
            Some(i) => view.get(i),
            None => view.last(),
        };
        if let Some(id) = pick.cloned() {
            self.switch_to(&id);
        }
        Ok(())
    }
}
