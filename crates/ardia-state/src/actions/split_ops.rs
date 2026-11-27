use super::*;

impl Tx<'_> {
    pub(super) fn split_tabs(
        &mut self,
        tabs: &[TabId],
        orientation: Orientation,
    ) -> Result<SplitId, ActionError> {
        let unique: Vec<TabId> = tabs.iter().fold(Vec::new(), |mut acc, t| {
            push_unique(&mut acc, t);
            acc
        });
        if unique.len() < 2 || unique.len() > MAX_SPLIT_PANES {
            return Err(ActionError::Invalid("a split holds two to four tabs"));
        }
        let first = self.require_listed_tab(&unique[0])?;
        for t in &unique {
            let tab = self.require_listed_tab(t)?;
            if tab.window_id != first.window_id || tab.profile_id != first.profile_id {
                return Err(ActionError::Invalid(
                    "split tabs must share a window and profile",
                ));
            }
        }
        let gone: HashSet<TabId> = unique.iter().cloned().collect();
        let splits = self.splits_mut();
        let touched: Vec<SplitId> = splits
            .values()
            .filter(|s| s.tab_ids().iter().any(|t| gone.contains(t)))
            .map(|s| s.id.clone())
            .collect();
        for sid in touched {
            let rest = splits[&sid].without_panes(&gone);
            if rest.pane_count() >= 2 {
                splits.insert(sid, Arc::new(rest))
            } else {
                splits.shift_remove(&sid)
            };
        }
        self.join_lane(&unique[0], &unique);
        let id = self.ids.split();
        let view = SplitView::new(
            id.clone(),
            first.window_id.clone(),
            orientation,
            even_slots(&unique),
        );
        self.splits_mut().insert(id.clone(), Arc::new(view));
        push_unique(&mut self.out.changes.splits, &id);
        self.reorder_window(&first.window_id);
        self.activate(&unique[0]);
        self.out.split = Some(id.clone());
        Ok(id)
    }

    pub(super) fn open_split_pane(
        &mut self,
        window: &WindowId,
        side: SplitSide,
        url: Option<String>,
    ) -> Result<TabId, ActionError> {
        let w = self.require_window(window)?;
        let anchor = w
            .active_tab()
            .cloned()
            .ok_or(ActionError::Invalid("there is no tab to split"))?;
        let existing = self.s.split_of(anchor.as_str()).cloned();
        if !SplitView::can_insert(existing.as_deref(), anchor.as_str(), side) {
            return Err(ActionError::Invalid("this split is full"));
        }
        let lead = self.require_tab(&anchor)?;
        let tile = lead.pin.as_ref().is_some_and(TabPin::is_tile);
        let index = (!tile).then(|| self.after_panes(&w, &anchor));
        let pin = lead.pin.clone().filter(|p| p.is_row());
        let tab = self.new_tab(
            window,
            NewTab {
                url,
                profile: Some(lead.profile_id.clone()),
                opener: Some(anchor.clone()),
                background: true,
                index,
                pin,
                ..NewTab::default()
            },
        )?;
        self.join_lane(&anchor, std::slice::from_ref(&tab));
        let view = match &existing {
            Some(split) => split
                .inserted(&anchor, &tab, side)
                .ok_or(ActionError::Invalid("this split is full"))?,
            None => SplitView::paired(self.ids.split(), window.clone(), &anchor, &tab, side),
        };
        self.out.split = Some(view.id.clone());
        self.splits_mut().insert(view.id.clone(), Arc::new(view));
        self.reorder_window(window);
        self.activate(&tab);
        Ok(tab)
    }

    pub(super) fn drop_into_split(
        &mut self,
        tab: &TabId,
        anchor: &TabId,
        side: SplitSide,
    ) -> Result<(), ActionError> {
        if tab == anchor {
            return Err(ActionError::Invalid("a tab can't split with itself"));
        }
        let moving = self.require_listed_tab(tab)?;
        let target = self.require_listed_tab(anchor)?;
        if moving.window_id != target.window_id || moving.profile_id != target.profile_id {
            return Err(ActionError::Invalid(
                "split tabs must share a window and profile",
            ));
        }
        let window = target.window_id.clone();
        let existing = self.s.split_of(anchor.as_str()).cloned();
        if let Some(split) = existing
            .as_ref()
            .filter(|split| split.contains(tab.as_str()))
        {
            let moved = split
                .moved_pane(tab, anchor, side)
                .ok_or(ActionError::Invalid("that pane can't move"))?;
            self.replace_split(&split.id, Some(moved));
            self.reorder_window(&window);
            self.activate(tab);
            return Ok(());
        }
        if !SplitView::can_insert(existing.as_deref(), anchor.as_str(), side) {
            return Err(ActionError::Invalid("this split is full"));
        }
        if let Some(own) = self.s.split_of(tab.as_str()).cloned() {
            let rest = own.without_panes(&HashSet::from([tab.clone()]));
            self.replace_split(&own.id, Some(rest));
        }
        self.join_lane(anchor, std::slice::from_ref(tab));
        let view = match &existing {
            Some(split) => split
                .inserted(anchor, tab, side)
                .ok_or(ActionError::Invalid("this split is full"))?,
            None => SplitView::paired(self.ids.split(), window.clone(), anchor, tab, side),
        };
        let id = view.id.clone();
        self.replace_split(&id, Some(view));
        self.out.split = Some(id);
        self.reorder_window(&window);
        self.activate(tab);
        Ok(())
    }

    pub(super) fn replace_split_pane(
        &mut self,
        pane: &TabId,
        tab: &TabId,
    ) -> Result<(), ActionError> {
        let split = self
            .s
            .split_of(pane.as_str())
            .cloned()
            .ok_or(ActionError::Invalid("the pane isn't split"))?;
        let held = self.require_tab(pane)?;
        let incoming = self.require_listed_tab(tab)?;
        if split.contains(tab.as_str())
            || incoming.window_id != held.window_id
            || incoming.profile_id != held.profile_id
        {
            return Err(ActionError::Invalid("that tab can't take this pane"));
        }
        if let Some(own) = self.s.split_of(tab.as_str()).cloned() {
            let rest = own.without_panes(&HashSet::from([tab.clone()]));
            self.replace_split(&own.id, Some(rest));
        }
        self.join_lane(pane, std::slice::from_ref(tab));
        let current = self.require_split(&split.id)?;
        let ids: Vec<TabId> = current
            .tab_ids()
            .into_iter()
            .map(|id| if id == *pane { tab.clone() } else { id })
            .collect();
        self.replace_split(&split.id, Some(current.with_pane_ids(&ids)));
        self.close_tabs(std::slice::from_ref(pane), false);
        self.reorder_window(&held.window_id);
        self.activate(tab);
        Ok(())
    }

    pub(super) fn remove_empty_split_pane(&mut self, tab: &TabId) -> Result<(), ActionError> {
        let held = self.require_tab(tab)?;
        let empty = held.url.is_empty() || held.url.starts_with("ardia://newtab");
        if !empty || self.s.split_of(tab.as_str()).is_none() {
            return Err(ActionError::Invalid(
                "only an empty split pane closes this way",
            ));
        }
        self.close_tabs(std::slice::from_ref(tab), false);
        Ok(())
    }

    pub(super) fn replace_split(&mut self, split: &SplitId, view: Option<SplitView>) {
        push_unique(&mut self.out.changes.splits, split);
        let splits = self.splits_mut();
        match view {
            Some(view) if view.pane_count() >= 2 => {
                splits.insert(split.clone(), Arc::new(view));
            }
            _ => {
                splits.shift_remove(split);
            }
        }
    }

    pub(super) fn require_split(&self, split: &SplitId) -> Result<Arc<SplitView>, ActionError> {
        self.s
            .splits
            .get(split)
            .cloned()
            .ok_or_else(|| ActionError::NoSplit(split.to_string()))
    }

    pub(super) fn focus_pane(&mut self, window: &WindowId, delta: i32) -> Result<(), ActionError> {
        let w = self.require_window(window)?;
        let active = w
            .active_tab()
            .cloned()
            .ok_or(ActionError::Invalid("there is no active tab"))?;
        let split = self
            .s
            .split_of(active.as_str())
            .cloned()
            .ok_or(ActionError::Invalid("the active tab isn't split"))?;
        let panes = split.tab_ids();
        let at = panes.iter().position(|p| *p == active).unwrap_or(0) as i64;
        let next = (at + i64::from(delta)).rem_euclid(panes.len() as i64) as usize;
        self.switch_to(&panes[next]);
        Ok(())
    }

    pub(super) fn move_pane(
        &mut self,
        tab: &TabId,
        direction: PaneDirection,
    ) -> Result<(), ActionError> {
        let split = self
            .s
            .split_of(tab.as_str())
            .cloned()
            .ok_or(ActionError::Invalid("the tab isn't split"))?;
        let neighbor = split
            .neighbor(tab.as_str(), direction)
            .ok_or(ActionError::Invalid("there is no pane that way"))?;
        let side = match direction {
            PaneDirection::Left => SplitSide::Left,
            PaneDirection::Right => SplitSide::Right,
            PaneDirection::Up => SplitSide::Top,
            PaneDirection::Down => SplitSide::Bottom,
        };
        let moved = split
            .moved_pane(tab, &neighbor, side)
            .ok_or(ActionError::Invalid("that pane can't move"))?;
        let id = split.id.clone();
        self.replace_split(&id, Some(moved));
        let window = split.window_id.clone();
        self.reorder_window(&window);
        Ok(())
    }

    pub(super) fn remove_from_split(&mut self, tab: TabId) -> Result<(), ActionError> {
        let split = self
            .s
            .split_of(tab.as_str())
            .cloned()
            .ok_or(ActionError::Invalid("the tab isn't split"))?;
        let rest = split.without_panes(&HashSet::from([tab.clone()]));
        let panes = rest.tab_ids();
        self.replace_split(&split.id, Some(rest));
        let pinned = self.s.tabs.get(&tab).is_some_and(|t| t.pin.is_some());
        if let Some(w) = self.window_mut(&split.window_id).filter(|_| !pinned) {
            w.tab_ids.retain(|t| *t != tab);
            let after = panes
                .iter()
                .filter_map(|p| w.tab_ids.iter().position(|t| t == p))
                .max()
                .map_or(w.tab_ids.len(), |i| i + 1);
            w.tab_ids.insert(after, tab.clone());
        }
        self.reorder_window(&split.window_id);
        Ok(())
    }

    pub(super) fn unsplit(&mut self, split: SplitId) -> Result<(), ActionError> {
        self.require_split(&split)?;
        self.replace_split(&split, None);
        Ok(())
    }

    pub(super) fn swap_panes(&mut self, a: TabId, b: TabId) -> Result<(), ActionError> {
        let split = self
            .s
            .split_of(a.as_str())
            .cloned()
            .ok_or(ActionError::Invalid("the tab isn't split"))?;
        let swapped = split
            .swapped(a.as_str(), b.as_str())
            .ok_or(ActionError::Invalid("both tabs must be panes of one split"))?;
        let window = split.window_id.clone();
        self.replace_split(&split.id, Some(swapped));
        self.reorder_window(&window);
        Ok(())
    }

    pub(super) fn resize_split(
        &mut self,
        split: SplitId,
        sizes: Vec<f64>,
    ) -> Result<(), ActionError> {
        let view = self.require_split(&split)?;
        let resized = view
            .resized(&sizes)
            .ok_or(ActionError::Invalid("sizes must be positive, one per slot"))?;
        self.replace_split(&split, Some(resized));
        Ok(())
    }

    pub(super) fn restack_split(
        &mut self,
        split: SplitId,
        stack_sizes: [f64; 2],
    ) -> Result<(), ActionError> {
        let view = self.require_split(&split)?;
        let restacked = view.restacked(stack_sizes).ok_or(ActionError::Invalid(
            "stack sizes must be positive and the split must hold a stack",
        ))?;
        self.replace_split(&split, Some(restacked));
        Ok(())
    }

    pub(super) fn flip_split(&mut self, split: SplitId) -> Result<(), ActionError> {
        let view = self.require_split(&split)?;
        self.replace_split(&split, Some(view.flipped()));
        Ok(())
    }
}
