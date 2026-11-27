use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

use ardia_state::windows::Popover;
use gpui::Window;

use crate::primitives::presence::{Leaving, Switch};
use crate::primitives::tokens::duration;

thread_local! {
    static SITE_PANELS: RefCell<HashMap<String, Leaving<Popover>>> = RefCell::new(HashMap::new());
}

pub fn site_panel_leaving(
    window_key: &str,
    popover: Option<&Popover>,
    window: &mut Window,
) -> Option<(Popover, f32)> {
    let shown = popover.filter(|p| crate::site::render::fades_when_closed(p));
    let leaving = SITE_PANELS.with(|panels| {
        panels
            .borrow_mut()
            .entry(window_key.to_owned())
            .or_default()
            .update(shown, Switch::FadeOld, Instant::now(), duration::FAST)
    });
    if leaving.is_some() {
        window.request_animation_frame();
    }
    leaving
}
