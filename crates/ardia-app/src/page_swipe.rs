use std::collections::{HashMap, HashSet};
use std::sync::{OnceLock, Weak};

use ardia_engine::{EngineEvent, PageScrollAck, PageViewQuery};
use ardia_state::windows::WindowKind;
use ardia_state::{TabId, WindowId};
use ardia_ui::host_data::HostTopics;
use ardia_ui::window::swipe_overlay::{PageSwipe, SwipeHaptic};
use ardia_ui::window::swipe_tracker::{
    Availability, Handled, ScrollInput, SwipeBegin, SwipeLookup, SwipeTracker,
};
use gpui::ScrollPhase;
use parking_lot::Mutex;

use crate::coordinator::AppCoordinator;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Owner {
    #[default]
    Gpui,
    Page,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Gpui,
    Page { hit_page: bool },
}

impl Owner {
    pub fn takes(&mut self, source: Source, phase: ScrollPhase) -> bool {
        if phase == ScrollPhase::Began
            && let Source::Page { hit_page } = source
        {
            *self = if hit_page { Owner::Page } else { Owner::Gpui };
        }
        let takes = match source {
            Source::Gpui => *self == Owner::Gpui,
            Source::Page { .. } => *self == Owner::Page,
        };
        if takes
            && matches!(source, Source::Page { .. })
            && matches!(phase, ScrollPhase::Ended | ScrollPhase::Cancelled)
        {
            *self = Owner::Gpui;
        }
        takes
    }
}

#[derive(Default)]
pub struct PageSwipes {
    tracker: SwipeTracker,
    owner: Owner,
    queued: HashMap<WindowId, Vec<PageSwipe>>,
    lists: HashSet<WindowId>,
}

fn swipes() -> &'static Mutex<PageSwipes> {
    static SWIPES: OnceLock<Mutex<PageSwipes>> = OnceLock::new();
    SWIPES.get_or_init(|| Mutex::new(PageSwipes::default()))
}

fn coordinator() -> &'static OnceLock<Weak<AppCoordinator>> {
    static COORDINATOR: OnceLock<Weak<AppCoordinator>> = OnceLock::new();
    &COORDINATOR
}

pub fn swipe_availability(
    kind: Option<WindowKind>,
    full_screen: bool,
    back: bool,
    forward: bool,
    list_open: bool,
) -> Availability {
    let swipe_closes = kind == Some(WindowKind::LittleArdia) && !full_screen;
    Availability {
        back: back || swipe_closes,
        forward,
        allows_vertical: list_open,
    }
}

pub const MAX_QUEUED: usize = 64;

fn enqueue(queued: &mut HashMap<WindowId, Vec<PageSwipe>>, window: WindowId, swipe: PageSwipe) {
    let list = queued.entry(window).or_default();
    if list.len() >= MAX_QUEUED {
        list.remove(0);
    }
    list.push(swipe);
}

struct Lookup<'a> {
    me: &'a AppCoordinator,
    lists: &'a HashSet<WindowId>,
    begin: Option<SwipeBegin>,
}

impl SwipeLookup for Lookup<'_> {
    fn begin(&mut self) -> Option<SwipeBegin> {
        let begin = self.begin.take()?;
        let state = self.me.store.snapshot();
        let window = state.window(begin.window.as_str())?;
        let tab = state.tab(begin.tab.as_str())?;
        (window.kind.has_tabs() && tab.window_id == begin.window).then_some(begin)
    }

    fn system_swipe(&self) -> bool {
        system_swipe_enabled()
    }

    fn take_swipes(&mut self, page: u64) -> bool {
        self.me.take_page_swipes_on(page)
    }

    fn availability(&self, window: &WindowId, tab: &TabId) -> Availability {
        let state = self.me.store.snapshot();
        let shown = state.window(window.as_str());
        let history = state
            .tab(tab.as_str())
            .map(|t| ardia_ui::content::nav_buttons::history_of(&state, t, self.me));
        swipe_availability(
            shown.map(|w| w.kind),
            shown.is_some_and(|w| w.is_full_screen()),
            history.is_some_and(|h| h.back),
            history.is_some_and(|h| h.forward),
            self.lists.contains(window),
        )
    }

    fn points_per_window_point(&self) -> f32 {
        1.0 / ardia_ui::scale::current()
    }
}

impl AppCoordinator {
    fn take_page_swipes_on(&self, page: u64) -> bool {
        let (Some(side), Some(engine)) = (self.side(), self.engine()) else {
            return false;
        };
        let side = side.borrow();
        let Some(view) = side
            .views
            .values()
            .find(|view| view.handle().as_ptr() as usize as u64 == page)
        else {
            return false;
        };
        engine
            .page_view(view, PageViewQuery::TakeSwipes)
            .unwrap_or(false)
    }

    pub(crate) fn page_tab_of(&self, candidates: &[u64]) -> Option<(u64, TabId)> {
        let side = self.side()?.borrow();
        let found = candidates.iter().find_map(|candidate| {
            side.views
                .iter()
                .find(|(_, view)| view.handle().as_ptr() as usize as u64 == *candidate)
                .map(|(engine_tab, _)| (*candidate, *engine_tab))
        });
        drop(side);
        let (page, engine_tab) = found?;
        Some((page, self.state_tab(engine_tab)?))
    }

    fn feed_swipe(&self, source: Source, input: ScrollInput, begin: Option<SwipeBegin>) -> bool {
        let mut guard = swipes().lock();
        let PageSwipes {
            tracker,
            owner,
            queued,
            lists,
        } = &mut *guard;
        let phase = if input.phase == ScrollPhase::None {
            input.momentum
        } else {
            input.phase
        };
        if !owner.takes(source, phase) {
            return false;
        }
        let mut lookup = Lookup {
            me: self,
            lists,
            begin,
        };
        let Handled { swallow, emitted } = tracker.scroll(input, &mut lookup);
        log::debug!(
            "page swipe {source:?} {:?}/{:?} dx {} tracking {} swallow {swallow} emitted {:?}",
            input.phase,
            input.momentum,
            input.dx,
            tracker.tracking(),
            emitted
                .as_ref()
                .map(|(_, swipe)| (swipe.phase, swipe.distance))
        );
        let emitted = emitted.map(|(window, swipe)| enqueue(queued, window, swipe));
        drop(guard);
        if emitted.is_some() {
            self.signal.emit(HostTopics::PAGE);
        }
        swallow
    }

    pub(crate) fn page_scroll_from_gpui(
        &self,
        window: &WindowId,
        tab: Option<&TabId>,
        input: ScrollInput,
    ) -> bool {
        let begin = tab.map(|tab| SwipeBegin {
            window: window.clone(),
            tab: tab.clone(),
            page: None,
        });
        self.feed_swipe(Source::Gpui, input, begin)
    }

    pub(crate) fn page_scroll_from_page(&self, candidates: &[u64], input: ScrollInput) -> bool {
        let hit = if input.phase == ScrollPhase::Began {
            self.page_tab_of(candidates)
        } else {
            None
        };
        let begin = hit.as_ref().and_then(|(page, tab)| {
            Some(SwipeBegin {
                window: self.window_of(tab)?,
                tab: tab.clone(),
                page: Some(*page),
            })
        });
        let hit_page = begin.is_some();
        if input.phase == ScrollPhase::Began {
            log::debug!(
                "page swipe began over {} views, page {:?}, system swipes {}",
                candidates.len(),
                begin.as_ref().map(|b| &b.tab),
                system_swipe_enabled()
            );
        }
        self.feed_swipe(Source::Page { hit_page }, input, begin)
    }

    pub(crate) fn page_discrete_swipe(&self, candidates: &[u64], dx: f32) -> bool {
        let Some((page, tab)) = self.page_tab_of(candidates) else {
            return false;
        };
        let Some(window) = self.window_of(&tab) else {
            return false;
        };
        let mut guard = swipes().lock();
        let PageSwipes {
            tracker,
            queued,
            lists,
            ..
        } = &mut *guard;
        let mut lookup = Lookup {
            me: self,
            lists,
            begin: Some(SwipeBegin {
                window,
                tab,
                page: Some(page),
            }),
        };
        let Some((window, swipe)) = tracker.discrete(dx, &mut lookup) else {
            return false;
        };
        enqueue(queued, window, swipe);
        drop(guard);
        self.signal.emit(HostTopics::PAGE);
        true
    }

    pub(crate) fn note_page_scroll_ack(&self, event: &EngineEvent) {
        log::debug!("page swipe renderer {event:?}");
        let mut guard = swipes().lock();
        match event {
            EngineEvent::PageScroll {
                view,
                ack,
                consumed,
            } => guard
                .tracker
                .renderer_acked(view.get(), *ack == PageScrollAck::Begin, *consumed),
            EngineEvent::PageOverscroll {
                view,
                allows_horizontal,
            } => guard
                .tracker
                .renderer_overscrolled(view.get(), *allows_horizontal),
            _ => {}
        }
    }

    pub(crate) fn take_page_swipes_of(&self, window: &WindowId) -> Vec<PageSwipe> {
        swipes().lock().queued.remove(window).unwrap_or_default()
    }

    pub(crate) fn note_swipe_list_of(&self, window: &WindowId, open: bool) {
        let mut guard = swipes().lock();
        if open {
            guard.lists.insert(window.clone());
        } else {
            guard.lists.remove(window);
        }
    }

    pub(crate) fn install_page_swipes(&self) {
        if coordinator().set(self.weak()).is_err() {
            return;
        }
        if let Some(engine) = self.engine()
            && let Err(problem) = engine.set_scroll_observer(true)
        {
            log::debug!("page swipes can't watch page scrolls: {problem}");
        }
        install_monitor();
    }
}

pub fn on_scroll_event(candidates: &[u64], input: ScrollInput) -> bool {
    coordinator()
        .get()
        .and_then(Weak::upgrade)
        .is_some_and(|me| me.page_scroll_from_page(candidates, input))
}

pub fn on_discrete_swipe(candidates: &[u64], dx: f32) -> bool {
    coordinator()
        .get()
        .and_then(Weak::upgrade)
        .is_some_and(|me| me.page_discrete_swipe(candidates, dx))
}

pub fn haptic(pattern: SwipeHaptic) {
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        const GENERIC: isize = 0;
        const ALIGNMENT: isize = 1;
        const LEVEL_CHANGE: isize = 2;
        const DEFAULT_TIME: usize = 0;
        const NOW: usize = 1;
        let (kind, time) = match pattern {
            SwipeHaptic::LevelChange => (LEVEL_CHANGE, DEFAULT_TIME),
            SwipeHaptic::Alignment => (ALIGNMENT, NOW),
            SwipeHaptic::Generic => (GENERIC, NOW),
        };
        let Some(class) = AnyClass::get(c"NSHapticFeedbackManager") else {
            return;
        };
        let performer: *mut AnyObject = unsafe { msg_send![class, defaultPerformer] };
        if performer.is_null() {
            return;
        }
        let _: () =
            unsafe { msg_send![performer, performFeedbackPattern: kind, performanceTime: time] };
    }
    #[cfg(not(target_os = "macos"))]
    let _ = pattern;
}

#[cfg(target_os = "macos")]
fn system_swipe_enabled() -> bool {
    use objc2::{class, msg_send};
    unsafe { msg_send![class!(NSEvent), isSwipeTrackingFromScrollEventsEnabled] }
}

#[cfg(not(target_os = "macos"))]
fn system_swipe_enabled() -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn phase_of(raw: usize) -> ScrollPhase {
    const BEGAN: usize = 1;
    const STATIONARY: usize = 2;
    const CHANGED: usize = 4;
    const ENDED: usize = 8;
    const CANCELLED: usize = 16;
    const MAY_BEGIN: usize = 32;
    if raw & MAY_BEGIN != 0 {
        ScrollPhase::MayBegin
    } else if raw & BEGAN != 0 {
        ScrollPhase::Began
    } else if raw & ENDED != 0 {
        ScrollPhase::Ended
    } else if raw & CANCELLED != 0 {
        ScrollPhase::Cancelled
    } else if raw & CHANGED != 0 {
        ScrollPhase::Changed
    } else if raw & STATIONARY != 0 {
        ScrollPhase::Stationary
    } else {
        ScrollPhase::None
    }
}

#[cfg(target_os = "macos")]
fn install_monitor() {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_app_kit::{NSEvent, NSEventType};
    use objc2_foundation::NSPoint;

    fn hit_chain(window: &AnyObject, location: NSPoint) -> Vec<u64> {
        let content: *mut AnyObject = unsafe { msg_send![window, contentView] };
        if content.is_null() {
            return Vec::new();
        }
        let frame: *mut AnyObject = unsafe { msg_send![content, superview] };
        let root = if frame.is_null() { content } else { frame };
        let mut view: *mut AnyObject = unsafe { msg_send![root, hitTest: location] };
        let mut chain = Vec::new();
        while !view.is_null() && chain.len() < 64 {
            chain.push(view as usize as u64);
            view = unsafe { msg_send![view, superview] };
        }
        chain
    }

    let handler = RcBlock::new(|event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let shown = unsafe { event.as_ref() };
        let kind = shown.r#type();
        if kind != NSEventType::ScrollWheel && kind != NSEventType::Swipe {
            return event.as_ptr();
        }
        let window: Option<Retained<AnyObject>> = unsafe { msg_send![shown, window] };
        let Some(window) = window else {
            return event.as_ptr();
        };
        let location = shown.locationInWindow();
        let swallow = if kind == NSEventType::Swipe {
            let dx = shown.deltaX() as f32;
            on_discrete_swipe(&hit_chain(&window, location), dx)
        } else {
            let phase = phase_of(shown.phase().0);
            let input = ScrollInput {
                phase,
                momentum: phase_of(shown.momentumPhase().0),
                dx: shown.scrollingDeltaX() as f32,
                dy: shown.scrollingDeltaY() as f32,
                precise: shown.hasPreciseScrollingDeltas(),
                time: shown.timestamp(),
            };
            let chain = if phase == ScrollPhase::Began {
                hit_chain(&window, location)
            } else {
                Vec::new()
            };
            on_scroll_event(&chain, input)
        };
        if swallow {
            std::ptr::null_mut()
        } else {
            event.as_ptr()
        }
    });
    let mask: u64 = (1 << NSEventType::ScrollWheel.0) | (1 << NSEventType::Swipe.0);
    let monitor: Option<Retained<AnyObject>> = unsafe {
        msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: mask, handler: &*handler]
    };
    std::mem::forget(monitor);
    std::mem::forget(handler);
}

#[cfg(not(target_os = "macos"))]
fn install_monitor() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gesture_belongs_to_whichever_side_it_began_on() {
        let mut owner = Owner::default();
        assert!(!owner.takes(Source::Page { hit_page: false }, ScrollPhase::Began));
        assert!(owner.takes(Source::Gpui, ScrollPhase::Began));
        assert!(owner.takes(Source::Gpui, ScrollPhase::Changed));
        assert!(owner.takes(Source::Page { hit_page: true }, ScrollPhase::Began));
        assert!(!owner.takes(Source::Gpui, ScrollPhase::Began));
        assert!(!owner.takes(Source::Gpui, ScrollPhase::Changed));
        assert!(owner.takes(Source::Page { hit_page: false }, ScrollPhase::Changed));
        assert!(owner.takes(Source::Page { hit_page: false }, ScrollPhase::Ended));
        assert_eq!(owner, Owner::Gpui);
        assert!(owner.takes(Source::Gpui, ScrollPhase::Began));
    }

    #[test]
    fn little_ardia_can_always_swipe_back_to_close_outside_full_screen() {
        let little = swipe_availability(Some(WindowKind::LittleArdia), false, false, false, false);
        assert!(little.back && !little.forward);
        let full = swipe_availability(Some(WindowKind::LittleArdia), true, false, false, false);
        assert!(!full.back);
        let main = swipe_availability(Some(WindowKind::Main), false, false, true, true);
        assert!(!main.back && main.forward && main.allows_vertical);
    }

    #[test]
    fn queued_swipes_stay_bounded() {
        let mut queued = HashMap::new();
        let window = WindowId::new("w");
        for i in 0..(MAX_QUEUED + 5) {
            enqueue(
                &mut queued,
                window.clone(),
                PageSwipe {
                    tab: TabId::new("t"),
                    phase: ardia_ui::window::swipe_overlay::SwipePhase::Changed,
                    direction: ardia_ui::window::page_overlays::HistoryDirection::Back,
                    distance: i as f32,
                    dy: 0.0,
                    velocity: 0.0,
                },
            );
        }
        let list = &queued[&window];
        assert_eq!(list.len(), MAX_QUEUED);
        assert_eq!(list[0].distance, 5.0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn appkit_phase_bits_map_to_scroll_phases() {
        assert_eq!(phase_of(0), ScrollPhase::None);
        assert_eq!(phase_of(1), ScrollPhase::Began);
        assert_eq!(phase_of(4), ScrollPhase::Changed);
        assert_eq!(phase_of(8), ScrollPhase::Ended);
        assert_eq!(phase_of(16), ScrollPhase::Cancelled);
        assert_eq!(phase_of(32), ScrollPhase::MayBegin);
        assert_eq!(phase_of(2), ScrollPhase::Stationary);
    }
}
