use std::collections::HashMap;
use std::sync::atomic::Ordering;

use ardia_engine::{EngineEvent, TabCommand};
use ardia_state::{TabId, WindowId};
use ardia_ui::host_data::HostTopics;
use ardia_ui::window::page_overlays::{
    NavigationStep, NewTabNotice, PageOverlay, hover_status, status_at_top,
};

use crate::coordinator::AppCoordinator;

#[derive(Debug, Default)]
pub struct PageOverlayBook {
    pages: HashMap<TabId, PageOverlay>,
    notices: HashMap<WindowId, NewTabNotice>,
    next_notice: u64,
}

impl PageOverlayBook {
    pub fn overlay(&self, tab: &TabId) -> PageOverlay {
        self.pages.get(tab).cloned().unwrap_or_default()
    }

    pub fn notice(&self, window: &WindowId) -> Option<NewTabNotice> {
        self.notices.get(window).cloned()
    }

    fn edit(&mut self, tab: &TabId, change: impl FnOnce(&mut PageOverlay)) -> bool {
        let before = self.overlay(tab);
        let mut after = before.clone();
        change(&mut after);
        if after == before {
            return false;
        }
        if after == PageOverlay::default() {
            self.pages.remove(tab);
        } else {
            self.pages.insert(tab.clone(), after);
        }
        true
    }

    pub fn apply(
        &mut self,
        tab: &TabId,
        event: &EngineEvent,
        quitting: bool,
        from_bottom: Option<f64>,
    ) -> bool {
        match event {
            EngineEvent::StatusText { text, .. } => self.edit(tab, |page| {
                page.status = (!text.is_empty()).then(|| hover_status(text));
                page.status_at_top = page.status.is_some() && status_at_top(from_bottom);
            }),
            EngineEvent::RendererGone { .. } if !quitting => self.edit(tab, |page| {
                page.crashed = true;
                page.unresponsive = false;
                page.status = None;
            }),
            EngineEvent::Unresponsive { .. } => self.edit(tab, |page| page.unresponsive = true),
            EngineEvent::Responsive { .. } => self.edit(tab, |page| page.unresponsive = false),
            EngineEvent::UrlChanged { .. } => self.edit(tab, |page| {
                page.crashed = false;
                page.status = None;
            }),
            EngineEvent::LoadingChanged { loading: true, .. } => {
                self.edit(tab, |page| page.crashed = false)
            }
            EngineEvent::TabWillClose { .. } => {
                let notices = self.notices.len();
                self.notices
                    .retain(|_, notice| &notice.tab != tab && &notice.source != tab);
                self.pages.remove(tab).is_some() || notices != self.notices.len()
            }
            _ => false,
        }
    }

    pub fn clear(&mut self, tab: &TabId, change: impl FnOnce(&mut PageOverlay)) -> bool {
        self.edit(tab, change)
    }

    pub fn note_background_tab(&mut self, window: WindowId, tab: TabId, source: TabId) {
        self.next_notice += 1;
        self.notices.insert(
            window,
            NewTabNotice {
                id: self.next_notice,
                tab,
                source,
            },
        );
    }
}

#[cfg(target_os = "macos")]
pub fn pointer_from_bottom(view: *mut std::ffi::c_void) -> Option<f64> {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect};
    let view = view.cast::<AnyObject>();
    if view.is_null() {
        return None;
    }
    unsafe {
        let window: *mut AnyObject = msg_send![view, window];
        if window.is_null() {
            return None;
        }
        let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let in_window: NSPoint = msg_send![window, convertPointFromScreen: mouse];
        let local: NSPoint =
            msg_send![view, convertPoint: in_window, fromView: std::ptr::null_mut::<AnyObject>()];
        let bounds: NSRect = msg_send![view, bounds];
        let flipped: Bool = msg_send![view, isFlipped];
        distance_from_bottom(
            (local.x, local.y),
            (
                bounds.origin.x,
                bounds.origin.y,
                bounds.size.width,
                bounds.size.height,
            ),
            flipped.as_bool(),
        )
    }
}

#[cfg(not(target_os = "macos"))]
pub fn pointer_from_bottom(_view: *mut std::ffi::c_void) -> Option<f64> {
    None
}

pub fn distance_from_bottom(
    point: (f64, f64),
    bounds: (f64, f64, f64, f64),
    flipped: bool,
) -> Option<f64> {
    let (x, y) = point;
    let (left, top, width, height) = bounds;
    if x < left || x > left + width || y < top || y > top + height {
        return None;
    }
    Some(if flipped { top + height - y } else { y - top })
}

pub fn opened_behind(disposition: &str) -> bool {
    matches!(disposition, "background_tab" | "background")
}

impl AppCoordinator {
    pub(crate) fn note_page_overlay(&self, event: &EngineEvent) {
        let Some(tab) = event.tab().and_then(|tab| self.state_tab(tab)) else {
            return;
        };
        let quitting = self.shutting_down.load(Ordering::Relaxed);
        let from_bottom = match event {
            EngineEvent::StatusText { text, .. } if !text.is_empty() => self
                .tab_views(&tab)
                .and_then(|views| views.page_view)
                .and_then(|view| pointer_from_bottom(view.as_ptr().cast())),
            _ => None,
        };
        let changed = self
            .bridge
            .lock()
            .page_overlays
            .apply(&tab, event, quitting, from_bottom);
        if changed {
            self.signal.emit(HostTopics::PAGE);
        }
    }

    pub(crate) fn note_inserted_tab(&self, event: &EngineEvent) {
        let EngineEvent::TabInserted {
            window,
            tab,
            opener: Some(opener),
            disposition,
        } = event
        else {
            return;
        };
        if !opened_behind(disposition) {
            return;
        }
        let (Some(window), Some(tab), Some(source)) = (
            self.state_window(*window),
            self.state_tab(*tab),
            self.state_tab(*opener),
        ) else {
            return;
        };
        let opened_as_pane = self
            .store
            .snapshot()
            .split_of(tab.as_str())
            .is_some_and(|split| split.contains(source.as_str()));
        if opened_as_pane {
            return;
        }
        self.bridge
            .lock()
            .page_overlays
            .note_background_tab(window, tab, source);
        self.signal.emit(HostTopics::PAGE);
    }

    pub(crate) fn page_overlay_of(&self, tab: &TabId) -> PageOverlay {
        self.bridge.lock().page_overlays.overlay(tab)
    }

    pub(crate) fn new_tab_notice_of(&self, window: &WindowId) -> Option<NewTabNotice> {
        self.bridge.lock().page_overlays.notice(window)
    }

    pub(crate) fn navigation_steps_of(&self, tab: &TabId) -> Vec<NavigationStep> {
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            return Vec::new();
        };
        match engine.navigation_entries(engine_tab) {
            Ok(entries) => navigation_steps(entries),
            Err(problem) => {
                log::debug!("{tab} has no navigation list: {problem}");
                Vec::new()
            }
        }
    }

    pub(crate) fn go_to_offset_in(&self, tab: &TabId, offset: i32) {
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            return;
        };
        if let Err(problem) = engine.go_to_offset(engine_tab, offset) {
            log::warn!("{tab} couldn't go {offset} in its history: {problem}");
        }
    }

    pub(crate) fn recover_crashed(&self, tab: &TabId) {
        if self
            .bridge
            .lock()
            .page_overlays
            .clear(tab, |page| page.crashed = false)
        {
            self.signal.emit(HostTopics::PAGE);
        }
    }

    pub(crate) fn resolve_unresponsive_in(&self, tab: &TabId, exit: bool) {
        if self
            .bridge
            .lock()
            .page_overlays
            .clear(tab, |page| page.unresponsive = false)
        {
            self.signal.emit(HostTopics::PAGE);
        }
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            return;
        };
        if let Err(problem) = engine.tab_command(
            engine_tab,
            TabCommand::ResolveUnresponsive { terminate: exit },
        ) {
            log::warn!("{tab} couldn't resolve its hang: {problem}");
        }
    }
}

pub(crate) fn navigation_steps(entries: Vec<ardia_engine::NavigationEntry>) -> Vec<NavigationStep> {
    entries
        .into_iter()
        .map(|entry| NavigationStep {
            url: entry.url,
            title: entry.title,
            current: entry.current,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_history_entry_is_a_step_not_only_the_last_committed_one() {
        let entry = |url: &str, current: bool, committed: bool| ardia_engine::NavigationEntry {
            url: url.into(),
            title: String::new(),
            committed,
            current,
        };
        let steps = super::navigation_steps(vec![
            entry("https://a.com/", false, false),
            entry("https://b.com/", false, false),
            entry("https://c.com/", true, true),
            entry("https://d.com/", false, false),
        ]);
        assert_eq!(steps.len(), 4);
        assert_eq!(steps.iter().position(|s| s.current), Some(2));
        let back = ardia_ui::window::page_overlays::history_items(
            &steps,
            ardia_ui::window::page_overlays::HistoryDirection::Back,
            15,
        );
        assert_eq!(
            back.iter().map(|i| i.offset).collect::<Vec<_>>(),
            vec![-1, -2]
        );
    }

    use super::*;
    use ardia_engine::EngineTabId;

    fn engine_tab() -> EngineTabId {
        EngineTabId::from_raw(7).expect("a valid tab id")
    }

    #[test]
    fn status_text_follows_the_hovered_link_and_hides_secrets() {
        let mut book = PageOverlayBook::default();
        let tab = TabId::new("t");
        let hover = EngineEvent::StatusText {
            tab: engine_tab(),
            text: "otpauth://totp/x?secret=A".into(),
        };
        assert!(book.apply(&tab, &hover, false, Some(10.0)));
        assert_eq!(book.overlay(&tab).status.as_deref(), Some("otpauth:"));
        assert!(book.overlay(&tab).status_at_top);
        assert_eq!(
            distance_from_bottom((5.0, 590.0), (0.0, 0.0, 800.0, 600.0), true),
            Some(10.0)
        );
        assert_eq!(
            distance_from_bottom((5.0, 10.0), (0.0, 0.0, 800.0, 600.0), false),
            Some(10.0)
        );
        assert_eq!(
            distance_from_bottom((900.0, 10.0), (0.0, 0.0, 800.0, 600.0), false),
            None
        );
        let left = EngineEvent::StatusText {
            tab: engine_tab(),
            text: String::new(),
        };
        assert!(book.apply(&tab, &left, false, None));
        assert_eq!(book.overlay(&tab), PageOverlay::default());
        assert!(!book.apply(&tab, &left, false, None));
    }

    #[test]
    fn a_crash_shows_the_sad_tab_until_the_page_loads_again() {
        let mut book = PageOverlayBook::default();
        let tab = TabId::new("t");
        let gone = EngineEvent::RendererGone {
            tab: engine_tab(),
            status: "crashed".into(),
            code: 1,
        };
        assert!(!book.apply(&tab, &gone, true, None));
        assert!(book.apply(&tab, &gone, false, None));
        assert!(book.overlay(&tab).crashed);
        let reload = EngineEvent::LoadingChanged {
            tab: engine_tab(),
            loading: true,
        };
        assert!(book.apply(&tab, &reload, false, None));
        assert!(!book.overlay(&tab).crashed);
    }

    #[test]
    fn hangs_raise_and_clear_the_unresponsive_dialog() {
        let mut book = PageOverlayBook::default();
        let tab = TabId::new("t");
        assert!(book.apply(
            &tab,
            &EngineEvent::Unresponsive { tab: engine_tab() },
            false,
            None
        ));
        assert!(book.overlay(&tab).unresponsive);
        assert!(book.apply(
            &tab,
            &EngineEvent::Responsive { tab: engine_tab() },
            false,
            None
        ));
        assert!(!book.overlay(&tab).unresponsive);
    }

    #[test]
    fn background_tabs_leave_one_notice_per_window_until_either_tab_closes() {
        let mut book = PageOverlayBook::default();
        let window = WindowId::new("w");
        book.note_background_tab(window.clone(), TabId::new("b"), TabId::new("a"));
        book.note_background_tab(window.clone(), TabId::new("c"), TabId::new("a"));
        let notice = book.notice(&window).expect("a notice");
        assert_eq!(notice.tab, TabId::new("c"));
        assert_eq!(notice.id, 2);
        let closing = EngineEvent::TabWillClose { tab: engine_tab() };
        assert!(book.apply(&TabId::new("a"), &closing, false, None));
        assert!(book.notice(&window).is_none());
        assert!(opened_behind("background_tab"));
        assert!(!opened_behind("foreground_tab"));
    }
}
