use std::collections::HashSet;
use std::sync::{Mutex, OnceLock, Weak};

use ardia_state::WindowId;

use crate::coordinator::{AppCoordinator, ShellEffect};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseEventKind {
    Down,
    Dragged,
    Up,
}

#[derive(Default)]
pub struct HeldButtons(HashSet<i64>);

impl HeldButtons {
    pub fn swallows(
        &mut self,
        kind: MouseEventKind,
        button: i64,
        command: impl FnOnce() -> Option<String>,
    ) -> Option<Option<String>> {
        match kind {
            MouseEventKind::Down => {
                self.0.remove(&button);
                let found = command()?;
                self.0.insert(button);
                Some(Some(found))
            }
            MouseEventKind::Dragged => self.0.contains(&button).then_some(None),
            MouseEventKind::Up => self.0.remove(&button).then_some(None),
        }
    }
}

fn coordinator() -> &'static OnceLock<Weak<AppCoordinator>> {
    static COORDINATOR: OnceLock<Weak<AppCoordinator>> = OnceLock::new();
    &COORDINATOR
}

fn held() -> &'static Mutex<HeldButtons> {
    static HELD: OnceLock<Mutex<HeldButtons>> = OnceLock::new();
    HELD.get_or_init(|| Mutex::new(HeldButtons::default()))
}

pub fn target_window(state: &ardia_state::BrowserState) -> Option<WindowId> {
    crate::menu_bridge::focused_window(state)
}

pub fn pick_window(
    under_pointer: Option<WindowId>,
    front: Option<WindowId>,
    is_browser: impl Fn(&WindowId) -> bool,
) -> Option<WindowId> {
    under_pointer.filter(|window| is_browser(window)).or(front)
}

#[cfg(target_os = "macos")]
pub fn window_number_of(window: &mut gpui::Window) -> Option<isize> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let handle = HasWindowHandle::window_handle(window).ok()?;
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        return None;
    };
    let view = appkit.ns_view.as_ptr().cast::<AnyObject>();
    let ns_window: *mut AnyObject = unsafe { msg_send![view, window] };
    if ns_window.is_null() {
        return None;
    }
    Some(unsafe { msg_send![ns_window, windowNumber] })
}

#[cfg(not(target_os = "macos"))]
pub fn window_number_of(_window: &mut gpui::Window) -> Option<isize> {
    None
}

pub fn handle(
    kind: MouseEventKind,
    button: i64,
    flags: u64,
    in_settings: bool,
    window_number: Option<isize>,
) -> bool {
    let Some(me) = coordinator().get().and_then(Weak::upgrade) else {
        return false;
    };
    let Ok(mut held) = held().lock() else {
        return false;
    };
    let decided = held.swallows(kind, button, || {
        if in_settings {
            return None;
        }
        let state = me.store.snapshot();
        let table = ardia_ui::keybindings::MouseShortcutTable::of(&state);
        table.command(button, flags).map(str::to_owned)
    });
    match decided {
        None => false,
        Some(None) => true,
        Some(Some(command)) => {
            let state = me.store.snapshot();
            if let Some(window) = target_window(&state) {
                match button {
                    2 => ardia_telemetry::counts::count("mouse_shortcut_runs_middle"),
                    3 => ardia_telemetry::counts::count("mouse_shortcut_runs_button4"),
                    4 => ardia_telemetry::counts::count("mouse_shortcut_runs_button5"),
                    _ => {}
                }
                me.effect(ShellEffect::RunCommand {
                    window,
                    window_number,
                    command,
                });
            }
            true
        }
    }
}

#[cfg(target_os = "macos")]
pub fn install(coordinator_ref: Weak<AppCoordinator>) {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_app_kit::{NSEvent, NSEventType};

    if coordinator().set(coordinator_ref).is_err() {
        return;
    }
    let handler = RcBlock::new(|event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let shown = unsafe { event.as_ref() };
        let kind = match shown.r#type() {
            NSEventType::OtherMouseDown => MouseEventKind::Down,
            NSEventType::OtherMouseDragged => MouseEventKind::Dragged,
            NSEventType::OtherMouseUp => MouseEventKind::Up,
            _ => return event.as_ptr(),
        };
        let button = shown.buttonNumber() as i64;
        let flags = shown.modifierFlags().0 as u64;
        let window: Option<Retained<AnyObject>> = unsafe { msg_send![shown, window] };
        let in_settings = window.is_some_and(|window| {
            let title: Option<Retained<objc2_foundation::NSString>> =
                unsafe { msg_send![&*window, title] };
            title.is_some_and(|title| title.to_string() == "Settings")
        });
        let number: isize = unsafe { msg_send![shown, windowNumber] };
        let window_number = (number > 0).then_some(number);
        if handle(kind, button, flags, in_settings, window_number) {
            std::ptr::null_mut()
        } else {
            event.as_ptr()
        }
    });
    let mask: u64 = (1 << NSEventType::OtherMouseDown.0)
        | (1 << NSEventType::OtherMouseDragged.0)
        | (1 << NSEventType::OtherMouseUp.0);
    let monitor: Option<Retained<AnyObject>> = unsafe {
        msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: mask, handler: &*handler]
    };
    std::mem::forget(monitor);
    std::mem::forget(handler);
}

#[cfg(not(target_os = "macos"))]
pub fn install(coordinator_ref: Weak<AppCoordinator>) {
    let _ = coordinator().set(coordinator_ref);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_under_the_pointer_wins_when_it_is_a_browser_window() {
        let front = Some(WindowId::new("front"));
        let under = Some(WindowId::new("under"));
        assert_eq!(pick_window(under.clone(), front.clone(), |_| true), under);
        assert_eq!(pick_window(under, front.clone(), |_| false), front);
        assert_eq!(pick_window(None, front.clone(), |_| true), front);
    }

    #[test]
    fn a_bound_button_swallows_its_drag_and_release_but_not_others() {
        let mut held = HeldButtons::default();
        assert_eq!(
            held.swallows(MouseEventKind::Down, 2, || Some("newTab".into())),
            Some(Some("newTab".into()))
        );
        assert_eq!(
            held.swallows(MouseEventKind::Dragged, 2, || None),
            Some(None)
        );
        assert_eq!(held.swallows(MouseEventKind::Up, 2, || None), Some(None));
        assert_eq!(held.swallows(MouseEventKind::Up, 2, || None), None);
        assert_eq!(held.swallows(MouseEventKind::Down, 3, || None), None);
        assert_eq!(held.swallows(MouseEventKind::Up, 3, || None), None);
    }
}
