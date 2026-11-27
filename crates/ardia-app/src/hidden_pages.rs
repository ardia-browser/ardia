use ardia_engine::{EngineTabId, EngineWindowId};

use crate::coordinator::AppCoordinator;

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::c_void;

    use ardia_engine::EngineTabId;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::NSRect;

    const FILLS_SUPERVIEW: usize = 2 | 16;

    thread_local! {
        static SHELVES: RefCell<HashMap<usize, Retained<AnyObject>>> = RefCell::new(HashMap::new());
        static PARKED: RefCell<HashMap<EngineTabId, (usize, usize)>> = RefCell::new(HashMap::new());
    }

    fn shelf_in(host: *mut c_void) -> Option<Retained<AnyObject>> {
        let host = host.cast::<AnyObject>();
        if host.is_null() {
            return None;
        }
        SHELVES.with(|shelves| {
            if let Some(shelf) = shelves.borrow().get(&(host as usize)) {
                return Some(shelf.clone());
            }
            let shelf: Retained<AnyObject> = unsafe { msg_send![class!(NSView), new] };
            unsafe {
                let bounds: NSRect = msg_send![host, bounds];
                let _: () = msg_send![&*shelf, setFrame: bounds];
                let _: () = msg_send![&*shelf, setAutoresizingMask: FILLS_SUPERVIEW];
                let _: () = msg_send![&*shelf, setHidden: Bool::YES];
                let _: () = msg_send![host, addSubview: &*shelf];
            }
            shelves.borrow_mut().insert(host as usize, shelf.clone());
            Some(shelf)
        })
    }

    pub fn park(host: *mut c_void, tab: EngineTabId, page: *mut c_void, shown_first: bool) {
        let page = page.cast::<AnyObject>();
        if page.is_null() {
            return;
        }
        let homeless = unsafe {
            let superview: *mut AnyObject = msg_send![page, superview];
            superview.is_null()
        };
        if !homeless {
            return;
        }
        let Some(shelf) = shelf_in(host) else {
            return;
        };
        unsafe {
            let bounds: NSRect = msg_send![&*shelf, bounds];
            let _: () = msg_send![page, setFrame: bounds];
            let _: () = msg_send![page, setAutoresizingMask: FILLS_SUPERVIEW];
            if shown_first {
                let _: () = msg_send![host.cast::<AnyObject>(), addSubview: page];
            }
            let _: () = msg_send![&*shelf, addSubview: page];
        }
        PARKED.with(|parked| {
            parked
                .borrow_mut()
                .insert(tab, (host as usize, page as usize))
        });
    }

    pub fn release_closed(still_bound: impl Fn(EngineTabId) -> bool) {
        let gone: Vec<(usize, usize)> = PARKED.with(|parked| {
            let mut parked = parked.borrow_mut();
            let closed: Vec<EngineTabId> = parked
                .keys()
                .copied()
                .filter(|tab| !still_bound(*tab))
                .collect();
            closed
                .into_iter()
                .filter_map(|tab| parked.remove(&tab))
                .collect()
        });
        for (host, page) in gone {
            let Some(shelf) = SHELVES.with(|shelves| shelves.borrow().get(&host).cloned()) else {
                continue;
            };
            let page = page as *mut AnyObject;
            unsafe {
                let superview: *mut AnyObject = msg_send![page, superview];
                if std::ptr::eq(superview, &*shelf) {
                    let _: () = msg_send![page, removeFromSuperview];
                }
            }
        }
    }

    pub fn forget_host(host: *mut c_void) {
        let Some(shelf) = SHELVES.with(|shelves| shelves.borrow_mut().remove(&(host as usize)))
        else {
            return;
        };
        PARKED.with(|parked| {
            parked
                .borrow_mut()
                .retain(|_, (parked_host, _)| *parked_host != host as usize)
        });
        unsafe {
            let _: () = msg_send![&*shelf, removeFromSuperview];
        }
    }
}

impl AppCoordinator {
    pub(crate) fn strip_is_empty(
        &self,
        state: &ardia_state::BrowserState,
        window: &ardia_state::WindowId,
        profile: &ardia_state::ProfileId,
    ) -> bool {
        let bridge = self.bridge.lock();
        !bridge.tabs.iter().any(|(tab, _)| {
            bridge.tab_homes.get(tab) == Some(window)
                && state
                    .tab(tab.as_str())
                    .is_some_and(|listed| &listed.profile_id == profile)
        })
    }

    pub(crate) fn park_hidden_page(
        &self,
        engine_window: EngineWindowId,
        engine_tab: EngineTabId,
        opened_into_empty_strip: bool,
    ) {
        #[cfg(target_os = "macos")]
        {
            let (Some(side), Some(engine)) = (self.side(), self.engine()) else {
                return;
            };
            let Some(host) = side
                .borrow()
                .hosted
                .get(&engine_window)
                .map(|(_, view)| view.handle().as_ptr())
            else {
                return;
            };
            let cached = side
                .borrow()
                .views
                .get(&engine_tab)
                .map(|view| view.handle().as_ptr());
            let page = match cached {
                Some(page) => page,
                None => match engine.native_view_handle(engine_tab) {
                    Ok(view) => {
                        let page = view.handle().as_ptr();
                        side.borrow_mut().views.insert(engine_tab, view);
                        page
                    }
                    Err(problem) => {
                        log::debug!("a hidden page has no view to keep in its window: {problem}");
                        return;
                    }
                },
            };
            mac::park(host, engine_tab, page, opened_into_empty_strip);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (engine_window, engine_tab, opened_into_empty_strip);
        }
    }

    pub(crate) fn release_closed_hidden_pages(&self) {
        #[cfg(target_os = "macos")]
        {
            let bound: std::collections::HashSet<EngineTabId> = self
                .bridge
                .lock()
                .tabs
                .iter()
                .map(|(_, tab)| *tab)
                .collect();
            mac::release_closed(|tab| bound.contains(&tab));
        }
    }

    pub(crate) fn forget_hidden_page_shelf(&self, engine_window: EngineWindowId) {
        #[cfg(target_os = "macos")]
        if let Some(host) = self.side().and_then(|side| {
            side.borrow()
                .hosted
                .get(&engine_window)
                .map(|(_, view)| view.handle().as_ptr())
        }) {
            mac::forget_host(host);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = engine_window;
        }
    }
}
