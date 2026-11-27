use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

static ARMED: AtomicU64 = AtomicU64::new(0);
static INPUT: AtomicBool = AtomicBool::new(false);

pub fn note_input() {
    if ARMED.load(Ordering::Acquire) % 2 == 1 {
        INPUT.store(true, Ordering::Release);
    }
}

pub fn arm() -> u64 {
    install_monitor();
    INPUT.store(false, Ordering::Release);
    let next = (ARMED.load(Ordering::Acquire) | 1) + 2;
    ARMED.store(next, Ordering::Release);
    next
}

pub fn take(armed: u64) -> bool {
    let confirmed = ARMED.load(Ordering::Acquire) == armed && INPUT.load(Ordering::Acquire);
    ARMED.store((armed + 1) & !1, Ordering::Release);
    INPUT.store(false, Ordering::Release);
    confirmed || !monitors_input()
}

#[cfg(all(target_os = "macos", not(test)))]
fn monitors_input() -> bool {
    true
}

#[cfg(any(not(target_os = "macos"), test))]
fn monitors_input() -> bool {
    false
}

#[cfg(all(target_os = "macos", not(test)))]
fn install_monitor() {
    use std::sync::Once;

    use block2::RcBlock;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel};

    const LEFT_MOUSE_UP: usize = 2;
    const KEY_DOWN: usize = 10;
    const RETURN_KEY: u16 = 36;
    const ENTER_KEY: u16 = 76;
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let Some(class) = AnyClass::get(c"NSEvent") else {
            return;
        };
        if !class.responds_to(sel!(addLocalMonitorForEventsMatchingMask:handler:)) {
            return;
        }
        let handler = RcBlock::new(|event: *mut AnyObject| -> *mut AnyObject {
            if let Some(seen) = unsafe { event.as_ref() } {
                let window: *mut AnyObject = unsafe { msg_send![seen, window] };
                if !window.is_null() {
                    let kind: usize = unsafe { msg_send![seen, type] };
                    let confirming = kind == LEFT_MOUSE_UP
                        || (kind == KEY_DOWN && {
                            let code: u16 = unsafe { msg_send![seen, keyCode] };
                            code == RETURN_KEY || code == ENTER_KEY
                        });
                    if confirming {
                        note_input();
                    }
                }
            }
            event
        });
        let mask: u64 = (1 << LEFT_MOUSE_UP) | (1 << KEY_DOWN);
        let monitor: *mut AnyObject = unsafe {
            msg_send![class, addLocalMonitorForEventsMatchingMask: mask, handler: &*handler]
        };
        if !monitor.is_null() {
            let _: *mut AnyObject = unsafe { msg_send![monitor, retain] };
        }
        std::mem::forget(handler);
    });
}

#[cfg(any(not(target_os = "macos"), test))]
fn install_monitor() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_armed_pick_needs_input_before_it_is_taken() {
        let armed = arm();
        note_input();
        assert!(ARMED.load(Ordering::Acquire) == armed && INPUT.load(Ordering::Acquire));
        assert!(take(armed));
        let again = arm();
        assert_ne!(again, armed);
        assert!(!INPUT.load(Ordering::Acquire));
        assert!(take(again));
        note_input();
        assert!(!INPUT.load(Ordering::Acquire));
    }
}
