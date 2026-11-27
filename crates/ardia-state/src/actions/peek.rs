use super::*;

pub(crate) fn settle_stranded_peeks(state: &BrowserState) -> Option<BrowserState> {
    let stranded: Vec<(WindowId, TabId)> = state
        .windows
        .values()
        .filter_map(|w| {
            let peek = w.chrome.peek.as_ref()?;
            let source = peek.source_tab_id.as_ref()?;
            (!w.tab_ids.contains(source)).then(|| (w.id.clone(), peek.tab_id.clone()))
        })
        .collect();
    if stranded.is_empty() {
        return None;
    }
    let mut next = state.clone();
    for (window, peek) in stranded {
        if let Some(w) = Arc::make_mut(&mut next.windows).get_mut(&window) {
            Arc::make_mut(w).chrome.peek = None;
        }
        if next.tabs.get(&peek).is_some_and(|t| t.live.peek) {
            Arc::make_mut(&mut next.tabs).shift_remove(&peek);
        }
    }
    Some(next)
}

impl Tx<'_> {
    pub(super) fn settle_peeks(&mut self, gone: &HashSet<TabId>) {
        let ended: Vec<(WindowId, TabId)> = self
            .s
            .windows
            .values()
            .filter_map(|w| {
                let peek = w.chrome.peek.as_ref()?;
                let source_gone = peek
                    .source_tab_id
                    .as_ref()
                    .is_some_and(|s| gone.contains(s));
                (gone.contains(&peek.tab_id) || source_gone)
                    .then(|| (w.id.clone(), peek.tab_id.clone()))
            })
            .collect();
        for (window, peek) in ended {
            if let Some(w) = self.window_mut_as(&window, Topics::CHROME) {
                w.chrome.peek = None;
            }
            if self.s.tabs.get(&peek).is_some_and(|t| t.live.peek) {
                Arc::make_mut(&mut self.s.tabs).shift_remove(&peek);
                self.note_tab(&peek, Topics::LIVE, true);
            }
        }
    }

    pub(super) fn open_peek_at(
        &mut self,
        window: &WindowId,
        url: &str,
        source: Option<TabId>,
        click_px: [f32; 2],
    ) -> Result<TabId, ActionError> {
        let id = self.open_peek(window, url, source)?;
        let click_px = (click_px[0].is_finite() && click_px[1].is_finite()).then_some(click_px);
        if let Some(w) = self.window_mut_as(window, Topics::CHROME)
            && let Some(peek) = w.chrome.peek.as_mut()
        {
            peek.click_px = click_px;
        }
        Ok(id)
    }

    pub(super) fn open_peek(
        &mut self,
        window: &WindowId,
        url: &str,
        source: Option<TabId>,
    ) -> Result<TabId, ActionError> {
        let w = self.require_window(window)?;
        if w.kind == WindowKind::LittleArdia {
            return Err(ActionError::Invalid("Little Ardia doesn't peek"));
        }
        let source = source.or_else(|| w.active_tab().cloned());
        if let Some(source) = &source
            && !w.tab_ids.contains(source)
        {
            return Err(ActionError::Invalid(
                "a peek opens from a tab in its own window",
            ));
        }
        if let Some(old) = w.chrome.peek.as_ref().map(|p| p.tab_id.clone()) {
            Arc::make_mut(&mut self.s.tabs).shift_remove(&old);
            self.note_tab(&old, Topics::LIVE, true);
        }
        let url = self.resolve_url(url);
        let profile = source
            .as_ref()
            .and_then(|s| self.s.tabs.get(s))
            .map_or_else(|| w.profile_id.clone(), |t| t.profile_id.clone());
        let id = self.ids.tab();
        let mut tab = Tab::new(id.clone(), window.clone(), profile, url, self.now);
        tab.live.peek = true;
        tab.opener_id = source.clone();
        Arc::make_mut(&mut self.s.tabs).insert(id.clone(), Arc::new(tab));
        self.note_tab(&id, Topics::LIVE, true);
        if let Some(w) = self.window_mut_as(window, Topics::CHROME) {
            w.chrome.peek = Some(PeekCard {
                tab_id: id.clone(),
                source_tab_id: source,
                click_px: None,
            });
        }
        self.out.tab = Some(id.clone());
        Ok(id)
    }

    pub(super) fn close_peek(&mut self, window: &WindowId) -> Result<(), ActionError> {
        let w = self.require_window(window)?;
        let Some(peek) = w.chrome.peek.clone() else {
            return Ok(());
        };
        Arc::make_mut(&mut self.s.tabs).shift_remove(&peek.tab_id);
        self.note_tab(&peek.tab_id, Topics::LIVE, true);
        if let Some(w) = self.window_mut_as(window, Topics::CHROME) {
            w.chrome.peek = None;
        }
        Ok(())
    }

    pub(super) fn promote_peek(&mut self, window: &WindowId) -> Result<TabId, ActionError> {
        let w = self.require_window(window)?;
        let peek = w
            .chrome
            .peek
            .clone()
            .ok_or(ActionError::Invalid("there is no peek to open"))?;
        let tab = self.require_tab(&peek.tab_id)?;
        let index = peek
            .source_tab_id
            .as_ref()
            .filter(|s| w.tab_ids.contains(*s))
            .map(|s| self.after_panes(&w, s))
            .unwrap_or_else(|| self.insertion_index(&w, &tab, false));
        if let Some(t) = self.tab_mut(&peek.tab_id) {
            t.live.peek = false;
        }
        if let Some(w) = self.window_mut(window) {
            w.chrome.peek = None;
            let at = index.min(w.tab_ids.len());
            w.tab_ids.insert(at, peek.tab_id.clone());
        }
        self.reorder_window(window);
        self.activate(&peek.tab_id);
        Ok(peek.tab_id)
    }
}
