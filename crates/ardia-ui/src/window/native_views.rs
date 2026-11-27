use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;

use ardia_engine::NativeViewHandle;
use ardia_state::TabId;
use gpui::{
    App, Corners, FocusHandle, Focusable, Global, Hsla, NativeView, Pixels, Window, WindowId,
};

use crate::keybindings::RunReservedCommand;

struct Owned {
    window: WindowId,
    view: NativeView,
    corners: Option<Corners<Pixels>>,
}

#[derive(Default)]
struct NativeOwners {
    views: HashMap<usize, Owned>,
}

impl Global for NativeOwners {}

#[derive(Default)]
pub struct NativeViews {
    slots: HashMap<(TabId, bool), usize>,
}

fn key_of(handle: NativeViewHandle) -> usize {
    handle.as_ptr() as usize
}

fn release(pointer: usize, owner: WindowId, cx: &mut App) {
    if let Some(owners) = cx.try_global::<NativeOwners>()
        && owners
            .views
            .get(&pointer)
            .is_some_and(|owned| owned.window == owner)
    {
        let gone = cx.global_mut::<NativeOwners>().views.remove(&pointer);
        drop(gone);
    }
}

impl NativeViews {
    pub fn attach(
        &mut self,
        tab: &TabId,
        devtools: bool,
        handle: Option<NativeViewHandle>,
        background: Hsla,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<NativeView> {
        let me = window.window_handle().window_id();
        let slot = (tab.clone(), devtools);
        let Some(handle) = handle.filter(|handle| !handle.is_null()) else {
            if let Some(pointer) = self.slots.remove(&slot) {
                release(pointer, me, cx);
            }
            return None;
        };
        let pointer = key_of(handle);
        if let Some(previous) = self.slots.get(&slot).copied()
            && previous != pointer
        {
            self.slots.remove(&slot);
            release(previous, me, cx);
        }
        let existing = cx
            .try_global::<NativeOwners>()
            .and_then(|owners| owners.views.get(&pointer))
            .map(|owned| (owned.window, owned.view.clone()));
        match existing {
            Some((owner, view)) if owner == me => {
                self.slots.insert(slot, pointer);
                return Some(view);
            }
            Some(_) => {
                let moved = cx.global_mut::<NativeOwners>().views.remove(&pointer);
                drop(moved);
            }
            None => {}
        }
        let raw = NonNull::new(handle.as_ptr().cast::<c_void>())?;
        let view = match unsafe { NativeView::new(raw, window, cx) } {
            Ok(view) => view,
            Err(error) => {
                log::debug!("tab {tab} has no native view here: {error}");
                return None;
            }
        };
        view.reserve_action::<RunReservedCommand>();
        view.set_background(background, cx);
        cx.default_global::<NativeOwners>().views.insert(
            pointer,
            Owned {
                window: me,
                view: view.clone(),
                corners: None,
            },
        );
        self.slots.insert(slot, pointer);
        Some(view)
    }

    pub fn round(
        &mut self,
        tab: &TabId,
        devtools: bool,
        corners: Corners<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(pointer) = self.slots.get(&(tab.clone(), devtools)).copied() else {
            return;
        };
        let me = window.window_handle().window_id();
        let Some(owners) = cx.try_global::<NativeOwners>() else {
            return;
        };
        let needs = owners
            .views
            .get(&pointer)
            .is_some_and(|owned| owned.window == me && owned.corners != Some(corners));
        if needs {
            let owners = cx.global_mut::<NativeOwners>();
            if let Some(owned) = owners.views.get_mut(&pointer) {
                window.set_native_view_corner_radius(&owned.view, corners);
                owned.corners = Some(corners);
            }
        }
    }

    pub fn focus_handle(&self, tab: &TabId, cx: &App) -> Option<FocusHandle> {
        let pointer = self.slots.get(&(tab.clone(), false))?;
        cx.try_global::<NativeOwners>()?
            .views
            .get(pointer)
            .map(|owned| owned.view.focus_handle(cx))
    }

    pub fn holds_focus(&self, window: &Window, cx: &App) -> bool {
        let Some(owners) = cx.try_global::<NativeOwners>() else {
            return false;
        };
        self.slots.values().any(|pointer| {
            owners
                .views
                .get(pointer)
                .is_some_and(|owned| owned.view.focus_handle(cx).is_focused(window))
        })
    }

    pub fn focus(&self, tab: &TabId, window: &mut Window, cx: &mut App) -> bool {
        match self.focus_handle(tab, cx) {
            Some(handle) => {
                window.focus(&handle, cx);
                true
            }
            None => false,
        }
    }

    pub fn retain(&mut self, owner: WindowId, keep: impl Fn(&TabId) -> bool, cx: &mut App) {
        let gone: Vec<usize> = self
            .slots
            .iter()
            .filter(|((tab, _), _)| !keep(tab))
            .map(|(_, pointer)| *pointer)
            .collect();
        self.slots.retain(|(tab, _), _| keep(tab));
        for pointer in gone {
            release(pointer, owner, cx);
        }
    }

    pub fn release_all(&mut self, owner: WindowId, cx: &mut App) {
        for (_, pointer) in self.slots.drain() {
            release(pointer, owner, cx);
        }
    }

    pub fn attached(&self) -> impl Iterator<Item = (&TabId, usize)> {
        self.slots
            .iter()
            .filter(|((_, devtools), _)| !devtools)
            .map(|((tab, _), pointer)| (tab, *pointer))
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    pub fn corners(&self, tab: &TabId, cx: &App) -> Option<Corners<Pixels>> {
        let pointer = self.slots.get(&(tab.clone(), false))?;
        cx.try_global::<NativeOwners>()?
            .views
            .get(pointer)
            .and_then(|owned| owned.corners)
    }

    pub fn owner_of(handle: NativeViewHandle, cx: &App) -> Option<WindowId> {
        cx.try_global::<NativeOwners>()?
            .views
            .get(&key_of(handle))
            .map(|owned| owned.window)
    }
}
