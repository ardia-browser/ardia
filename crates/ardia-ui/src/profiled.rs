use std::time::Instant;

use ardia_profile::{FrameSlot, FrameTimes};
use gpui::{
    AnyElement, App, Bounds, DispatchPhase, Element, ElementId, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, MouseDownEvent, Pixels, ScrollEvent, Window,
};

pub struct ProfiledRoot {
    slot: FrameSlot,
    started: Instant,
    prepaint: Option<(Instant, Instant)>,
    child: AnyElement,
    #[cfg(debug_assertions)]
    allocations_at_start: u64,
}

pub fn profiled_root(slot: FrameSlot, started: Instant, child: impl IntoElement) -> ProfiledRoot {
    ProfiledRoot {
        slot,
        started,
        prepaint: None,
        child: child.into_any_element(),
        #[cfg(debug_assertions)]
        allocations_at_start: ardia_profile::strict::alloc_mark(),
    }
}

fn listen<const SLOT: u8>(window: &mut Window) {
    window.on_mouse_event(|_: &MouseDownEvent, phase: DispatchPhase, _, _| {
        if phase.capture()
            && let Some(slot) = FrameSlot::from_index(SLOT as usize)
        {
            ardia_profile::note_input(slot);
        }
    });
    window.on_mouse_event(|_: &ScrollEvent, phase: DispatchPhase, _, _| {
        if phase.capture()
            && let Some(slot) = FrameSlot::from_index(SLOT as usize)
        {
            ardia_profile::note_input(slot);
        }
    });
}

fn listen_for(slot: FrameSlot, window: &mut Window) {
    match slot {
        FrameSlot::Main => listen::<{ FrameSlot::Main as u8 }>(window),
        FrameSlot::Settings => listen::<{ FrameSlot::Settings as u8 }>(window),
        FrameSlot::Onboarding => listen::<{ FrameSlot::Onboarding as u8 }>(window),
        FrameSlot::Little => listen::<{ FrameSlot::Little as u8 }>(window),
    }
}

impl Element for ProfiledRoot {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let start = Instant::now();
        self.child.prepaint(window, cx);
        self.prepaint = Some((start, Instant::now()));
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let paint_start = Instant::now();
        self.child.paint(window, cx);
        if !ardia_profile::ENABLED {
            return;
        }
        listen_for(self.slot, window);
        let paint_end = Instant::now();
        let (prepaint_start, prepaint_end) = self.prepaint.unwrap_or((paint_start, paint_start));
        let times = FrameTimes {
            started: self.started,
            prepaint_start,
            prepaint_end,
            paint_start,
            paint_end,
        };
        ardia_profile::record_frame(
            self.slot,
            window.window_handle().window_id().as_u64(),
            times,
        );
        #[cfg(debug_assertions)]
        ardia_profile::strict::frame(self.slot, &times, self.allocations_at_start);
    }
}
