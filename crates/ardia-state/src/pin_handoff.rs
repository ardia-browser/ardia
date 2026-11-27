use std::collections::HashMap;
use std::time::Duration;

use crate::ids::{TabId, WindowId};
use crate::pin_share::{holder_of, holder_of_page};
use crate::state::BrowserState;

pub const CAPTURE_DEADLINE: Duration = Duration::from_millis(250);
pub const PAINT_DEADLINE: Duration = Duration::from_millis(120);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandoffRequest {
    pub token: u64,
    pub family: String,
    pub copy: TabId,
    pub target: WindowId,
    pub source: WindowId,
    pub holder: TabId,
    pub on_screen: bool,
    before: Option<TabId>,
    intent: u64,
}

#[derive(Clone, Debug)]
pub struct PinHandoffs<P> {
    requests: u64,
    pending: HashMap<String, u64>,
    latest_in: HashMap<WindowId, u64>,
    interactions: HashMap<WindowId, u64>,
    frames: HashMap<TabId, P>,
    bridges: HashMap<WindowId, (TabId, P)>,
    committing: Option<TabId>,
}

impl<P> Default for PinHandoffs<P> {
    fn default() -> Self {
        PinHandoffs {
            requests: 0,
            pending: HashMap::new(),
            latest_in: HashMap::new(),
            interactions: HashMap::new(),
            frames: HashMap::new(),
            bridges: HashMap::new(),
            committing: None,
        }
    }
}

pub fn family_key(s: &BrowserState, tab: &TabId) -> Option<String> {
    let t = s.tabs.get(tab)?;
    Some(format!("{}\u{1}{}", t.profile_id, t.pin_key()))
}

fn active_in(s: &BrowserState, window: &WindowId) -> Option<TabId> {
    s.windows.get(window)?.active_tab().cloned()
}

impl<P: Clone> PinHandoffs<P> {
    pub fn needs_handoff(s: &BrowserState, copy: &TabId) -> bool {
        s.tabs.get(copy).is_some_and(|t| !t.page.has_page()) && holder_of(s, copy).is_some()
    }

    pub fn is_committing(&self, copy: &TabId) -> bool {
        self.committing.as_ref() == Some(copy)
    }

    pub fn committing(&mut self, copy: Option<TabId>) {
        self.committing = copy;
    }

    pub fn begin(&mut self, s: &BrowserState, copy: &TabId) -> Option<HandoffRequest> {
        let tab = s.tabs.get(copy)?;
        let holder = holder_of(s, copy)?;
        let family = family_key(s, copy)?;
        self.requests += 1;
        let token = self.requests;
        self.pending.insert(family.clone(), token);
        let target = tab.window_id.clone();
        self.latest_in.insert(target.clone(), token);
        let source = holder.window_id.clone();
        Some(HandoffRequest {
            token,
            family,
            copy: copy.clone(),
            on_screen: active_in(s, &source).as_ref() == Some(&holder.id),
            holder: holder.id.clone(),
            source,
            before: active_in(s, &target),
            intent: self.interaction_in(&target),
            target,
        })
    }

    fn interaction_in(&self, window: &WindowId) -> u64 {
        self.interactions.get(window).copied().unwrap_or(0)
    }

    pub fn note_windows(&mut self, s: &BrowserState, prev: &BrowserState) {
        for (id, w) in s.windows.iter() {
            let same = prev.windows.get(id).is_some_and(|was| {
                was.active_tab_ids == w.active_tab_ids
                    && was.chrome.popover == w.chrome.popover
                    && was.chrome.command_bar == w.chrome.command_bar
            });
            if !same {
                *self.interactions.entry(id.clone()).or_insert(0) += 1;
            }
        }
    }

    pub fn is_current(&self, request: &HandoffRequest, s: &BrowserState) -> bool {
        self.pending.get(&request.family) == Some(&request.token)
            && self.latest_in.get(&request.target) == Some(&request.token)
            && s.tabs
                .get(&request.copy)
                .is_some_and(|t| t.window_id == request.target)
            && active_in(s, &request.target) == request.before
            && self.interaction_in(&request.target) == request.intent
            && holder_of(s, &request.copy).is_some()
    }

    pub fn settle(&mut self, request: &HandoffRequest) {
        if self.pending.get(&request.family) == Some(&request.token) {
            self.pending.remove(&request.family);
        }
        if self.latest_in.get(&request.target) == Some(&request.token) {
            self.latest_in.remove(&request.target);
        }
    }

    pub fn keep_frame(&mut self, copy: &TabId, picture: P) {
        self.frames.insert(copy.clone(), picture);
    }

    pub fn bridge(&mut self, window: &WindowId, copy: &TabId, picture: P) {
        self.bridges.insert(window.clone(), (copy.clone(), picture));
    }

    pub fn unbridge(&mut self, window: &WindowId, copy: &TabId) -> bool {
        if self.bridges.get(window).is_some_and(|(c, _)| c == copy) {
            self.bridges.remove(window);
            return true;
        }
        false
    }

    pub fn bridged(&self, window: &WindowId) -> bool {
        self.bridges.contains_key(window)
    }

    pub fn picture_in(&self, s: &BrowserState, window: &WindowId) -> Option<P> {
        let active = active_in(s, window);
        let frozen = active
            .as_ref()
            .filter(|t| holder_of_page(s.tabs.get(*t).map(|t| &**t)).is_some());
        match frozen {
            Some(tab) => self
                .frames
                .get(tab)
                .cloned()
                .or_else(|| self.bridges.get(window).map(|(_, p)| p.clone())),
            None => self
                .bridges
                .get(window)
                .map(|(copy, p)| self.frames.get(copy).cloned().unwrap_or_else(|| p.clone())),
        }
    }

    pub fn forget_stale(&mut self, s: &BrowserState) -> bool {
        let before = self.frames.len();
        let bridged: Vec<TabId> = self.bridges.values().map(|(c, _)| c.clone()).collect();
        self.frames.retain(|id, _| {
            holder_of_page(s.tabs.get(id).map(|t| &**t)).is_some() || bridged.contains(id)
        });
        self.frames.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pin_share::swap_pin_page;
    use std::sync::Arc;

    fn shared() -> BrowserState {
        crate::pin_share::tests::two_windows()
    }

    #[test]
    fn a_handoff_stays_current_until_the_window_moves_on() {
        let s = shared();
        let copy = TabId::new("b");
        assert!(PinHandoffs::<u8>::needs_handoff(&s, &copy));
        let mut handoffs = PinHandoffs::<u8>::default();
        let request = handoffs.begin(&s, &copy).unwrap();
        assert!(request.on_screen);
        assert_eq!(request.source.as_str(), "w1");
        assert!(handoffs.is_current(&request, &s));
        let mut moved = s.clone();
        let mut w = (*moved.windows[&WindowId::new("w2")]).clone();
        w.active_tab_ids
            .insert(crate::ProfileId::default_profile(), TabId::new("c"));
        w.chrome.popover = Some(crate::windows::Popover::Custom("x".into()));
        Arc::make_mut(&mut moved.windows).insert(w.id.clone(), Arc::new(w));
        handoffs.note_windows(&moved, &s);
        assert!(!handoffs.is_current(&request, &moved));
        let newer = handoffs.begin(&s, &copy).unwrap();
        assert!(!handoffs.is_current(&request, &s));
        assert!(handoffs.is_current(&newer, &s));
        handoffs.settle(&newer);
        assert!(!handoffs.is_current(&newer, &s));
    }

    #[test]
    fn the_source_window_shows_the_bridge_then_the_kept_frame() {
        let s = shared();
        let copy = TabId::new("b");
        let mut handoffs = PinHandoffs::<u8>::default();
        handoffs.keep_frame(&copy, 7);
        handoffs.bridge(&WindowId::new("w1"), &copy, 7);
        assert_eq!(handoffs.picture_in(&s, &WindowId::new("w1")), Some(7));
        let swapped = swap_pin_page(&s, &copy).unwrap().state;
        assert!(handoffs.unbridge(&WindowId::new("w1"), &copy));
        assert_eq!(handoffs.picture_in(&swapped, &WindowId::new("w1")), Some(7));
        assert_eq!(handoffs.picture_in(&swapped, &WindowId::new("w2")), None);
        assert!(!handoffs.forget_stale(&swapped));
        assert!(handoffs.forget_stale(&s));
        assert_eq!(handoffs.picture_in(&swapped, &WindowId::new("w1")), None);
    }
}
