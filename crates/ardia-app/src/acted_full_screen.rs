use ardia_engine::NativeWindowHandle;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn overlap(self, other: Rect) -> f64 {
        let w = (self.x + self.w).min(other.x + other.w) - self.x.max(other.x);
        let h = (self.y + self.h).min(other.y + other.h) - self.y.max(other.y);
        if w > 0.0 && h > 0.0 { w * h } else { 0.0 }
    }
}

pub fn on_screen(frame: Rect, screens: &[Rect], target: usize, visible: Rect) -> Rect {
    let w = frame.w.min(visible.w);
    let h = frame.h.min(visible.h);
    let mine = screens
        .get(target)
        .map_or(0.0, |screen| frame.overlap(*screen));
    let holds_most = mine > 0.0
        && screens
            .iter()
            .enumerate()
            .all(|(index, screen)| index == target || frame.overlap(*screen) <= mine);
    if holds_most {
        Rect {
            x: frame.x.clamp(visible.x, visible.x + visible.w - w),
            y: frame.y.clamp(visible.y, visible.y + visible.h - h),
            w,
            h,
        }
    } else {
        Rect {
            x: (visible.x + (visible.w - w) / 2.0).round(),
            y: (visible.y + (visible.h - h) / 2.0).round(),
            w,
            h,
        }
    }
}

pub fn plausible_object(handle: NativeWindowHandle) -> bool {
    let address = handle.0 as usize;
    address != 0 && address.is_multiple_of(std::mem::align_of::<usize>() * 2)
}

pub fn joined_behavior(behavior: usize) -> usize {
    const MOVE_TO_ACTIVE_SPACE: usize = 1 << 1;
    const FULL_SCREEN_PRIMARY: usize = 1 << 7;
    const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
    const FULL_SCREEN_NONE: usize = 1 << 9;
    (behavior & !(FULL_SCREEN_PRIMARY | FULL_SCREEN_NONE))
        | MOVE_TO_ACTIVE_SPACE
        | FULL_SCREEN_AUXILIARY
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::rc::Rc;

    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    use ardia_engine::NativeWindowHandle;

    use super::Rect;

    #[repr(C)]
    struct DispatchQueue {
        _opaque: [u8; 0],
    }

    unsafe extern "C" {
        static _dispatch_main_q: DispatchQueue;
        fn pthread_main_np() -> i32;
        fn dispatch_async_f(
            queue: *const DispatchQueue,
            context: *mut c_void,
            work: extern "C" fn(*mut c_void),
        );
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGDisplayCreateUUIDFromDisplayID(display: u32) -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFUUIDCreateString(allocator: *const c_void, uuid: *const c_void) -> *const c_void;
        fn CFRelease(object: *const c_void);
    }

    enum Placement {
        Act(bool),
        Display(String),
        JoinSpaces,
    }

    fn on_main_thread() -> bool {
        unsafe { pthread_main_np() != 0 }
    }

    struct Pending {
        window: usize,
        placement: Placement,
    }

    thread_local! {
        static RESTORE: RefCell<HashMap<usize, NSRect>> = RefCell::new(HashMap::new());
        static TRANSITIONS: RefCell<HashMap<usize, Rc<Cell<u64>>>> = RefCell::new(HashMap::new());
    }

    fn rect(frame: NSRect) -> Rect {
        Rect {
            x: frame.origin.x,
            y: frame.origin.y,
            w: frame.size.width,
            h: frame.size.height,
        }
    }

    fn ns(rect: Rect) -> NSRect {
        NSRect::new(NSPoint::new(rect.x, rect.y), NSSize::new(rect.w, rect.h))
    }

    fn count_of(key: usize) -> Rc<Cell<u64>> {
        TRANSITIONS.with(|all| all.borrow_mut().entry(key).or_default().clone())
    }

    pub fn transitions(handle: NativeWindowHandle) -> u64 {
        if !super::plausible_object(handle) || !on_main_thread() {
            return 0;
        }
        let window = handle.0.cast::<AnyObject>();
        let key = window as usize;
        let known = TRANSITIONS.with(|all| all.borrow().contains_key(&key));
        let count = count_of(key);
        if !known {
            for name in [
                "NSWindowDidEnterFullScreenNotification",
                "NSWindowDidExitFullScreenNotification",
            ] {
                let seen = count.clone();
                let block = block2::RcBlock::new(move |_note: *mut AnyObject| {
                    seen.set(seen.get() + 1);
                });
                unsafe {
                    let center: *mut AnyObject =
                        msg_send![objc2::class!(NSNotificationCenter), defaultCenter];
                    let queue: *mut AnyObject =
                        msg_send![objc2::class!(NSOperationQueue), mainQueue];
                    let name = NSString::from_str(name);
                    let _: *mut AnyObject = msg_send![
                        center,
                        addObserverForName: &*name,
                        object: window,
                        queue: queue,
                        usingBlock: &*block
                    ];
                }
            }
        }
        count.get()
    }

    pub fn join_full_screen_spaces(handle: NativeWindowHandle) {
        later(handle, Placement::JoinSpaces);
    }

    unsafe fn join_spaces(window: *mut AnyObject) {
        unsafe {
            let behavior: usize = msg_send![window, collectionBehavior];
            let _: () = msg_send![window, setCollectionBehavior: super::joined_behavior(behavior)];
        }
    }

    pub fn act(handle: NativeWindowHandle, on: bool) {
        later(handle, Placement::Act(on));
    }

    pub fn move_to_display(handle: NativeWindowHandle, display: String) {
        later(handle, Placement::Display(display));
    }

    fn later(handle: NativeWindowHandle, placement: Placement) {
        if !super::plausible_object(handle) {
            return;
        }
        let window = handle.0 as usize;
        let _: *mut AnyObject = unsafe { msg_send![window as *mut AnyObject, retain] };
        let context = Box::into_raw(Box::new(Pending { window, placement })).cast::<c_void>();
        unsafe { dispatch_async_f(&raw const _dispatch_main_q, context, run) };
    }

    extern "C" fn run(context: *mut c_void) {
        let pending = unsafe { Box::from_raw(context.cast::<Pending>()) };
        let window = pending.window as *mut AnyObject;
        unsafe {
            match &pending.placement {
                Placement::Act(on) => {
                    place(window, pending.window, *on);
                    let count = count_of(pending.window);
                    count.set(count.get() + 1);
                }
                Placement::Display(display) => onto_display(window, display),
                Placement::JoinSpaces => join_spaces(window),
            }
            let _: () = msg_send![window, release];
        }
    }

    unsafe fn place(window: *mut AnyObject, key: usize, on: bool) {
        unsafe {
            if on {
                let mut screen: *mut AnyObject = msg_send![window, screen];
                if screen.is_null()
                    && let Some(class) = objc2::runtime::AnyClass::get(c"NSScreen")
                {
                    screen = msg_send![class, mainScreen];
                }
                if screen.is_null() {
                    return;
                }
                let before: NSRect = msg_send![window, frame];
                RESTORE.with(|saved| {
                    saved.borrow_mut().entry(key).or_insert(before);
                });
                let full: NSRect = msg_send![screen, frame];
                let _: () = msg_send![window, setFrame: full, display: true];
            } else if let Some(before) = RESTORE.with(|saved| saved.borrow_mut().remove(&key)) {
                let _: () = msg_send![window, setFrame: before, display: true];
            }
        }
    }

    unsafe fn screen_uuid(screen: *mut AnyObject) -> Option<String> {
        unsafe {
            let description: *mut AnyObject = msg_send![screen, deviceDescription];
            let key = NSString::from_str("NSScreenNumber");
            let number: *mut AnyObject = msg_send![description, objectForKey: &*key];
            if number.is_null() {
                return None;
            }
            let id: u32 = msg_send![number, unsignedIntValue];
            let uuid = CGDisplayCreateUUIDFromDisplayID(id);
            if uuid.is_null() {
                return None;
            }
            let text = CFUUIDCreateString(std::ptr::null(), uuid);
            CFRelease(uuid);
            if text.is_null() {
                return None;
            }
            let out = (*text.cast::<NSString>()).to_string();
            CFRelease(text);
            Some(out)
        }
    }

    unsafe fn onto_display(window: *mut AnyObject, display: &str) {
        unsafe {
            let style: usize = msg_send![window, styleMask];
            if style & (1 << 14) != 0 {
                return;
            }
            let Some(class) = objc2::runtime::AnyClass::get(c"NSScreen") else {
                return;
            };
            let screens: *mut AnyObject = msg_send![class, screens];
            let count: usize = msg_send![screens, count];
            let mut frames = Vec::with_capacity(count);
            let mut target = None;
            for index in 0..count {
                let screen: *mut AnyObject = msg_send![screens, objectAtIndex: index];
                let frame: NSRect = msg_send![screen, frame];
                frames.push(rect(frame));
                if screen_uuid(screen).is_some_and(|uuid| uuid.eq_ignore_ascii_case(display)) {
                    let visible: NSRect = msg_send![screen, visibleFrame];
                    target = Some((index, screen, rect(visible)));
                }
            }
            let Some((index, screen, visible)) = target else {
                return;
            };
            let current: *mut AnyObject = msg_send![window, screen];
            if current == screen {
                return;
            }
            let frame: NSRect = msg_send![window, frame];
            let placed = super::on_screen(rect(frame), &frames, index, visible);
            let _: () = msg_send![window, setFrame: ns(placed), display: false];
        }
    }
}

pub fn transitions(handle: NativeWindowHandle) -> u64 {
    #[cfg(target_os = "macos")]
    return mac::transitions(handle);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = handle;
        0
    }
}

pub fn join_full_screen_spaces(handle: NativeWindowHandle) {
    #[cfg(target_os = "macos")]
    mac::join_full_screen_spaces(handle);
    #[cfg(not(target_os = "macos"))]
    let _ = handle;
}

pub fn move_to_display(handle: NativeWindowHandle, display: String) {
    #[cfg(target_os = "macos")]
    mac::move_to_display(handle, display);
    #[cfg(not(target_os = "macos"))]
    let _ = (handle, display);
}

pub fn act(handle: NativeWindowHandle, on: bool) {
    #[cfg(target_os = "macos")]
    mac::act(handle, on);
    #[cfg(not(target_os = "macos"))]
    let _ = (handle, on);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_moved_to_its_saved_display_is_centred_there_like_the_old_app() {
        let left = Rect {
            x: 0.0,
            y: 0.0,
            w: 1512.0,
            h: 982.0,
        };
        let right = Rect {
            x: 1512.0,
            y: 0.0,
            w: 2560.0,
            h: 1440.0,
        };
        let visible = Rect {
            x: 1512.0,
            y: 0.0,
            w: 2560.0,
            h: 1415.0,
        };
        let window = Rect {
            x: 100.0,
            y: 50.0,
            w: 1200.0,
            h: 800.0,
        };
        let placed = on_screen(window, &[left, right], 1, visible);
        assert_eq!(
            placed,
            Rect {
                x: 2192.0,
                y: 308.0,
                w: 1200.0,
                h: 800.0
            }
        );
        let mostly_there = Rect {
            x: 1400.0,
            y: 900.0,
            w: 1200.0,
            h: 800.0,
        };
        let kept = on_screen(mostly_there, &[left, right], 1, visible);
        assert_eq!(
            kept,
            Rect {
                x: 1512.0,
                y: 615.0,
                w: 1200.0,
                h: 800.0
            }
        );
    }

    #[test]
    fn handles_that_cant_be_windows_are_never_messaged() {
        let fake = |address: usize| NativeWindowHandle(address as *mut std::ffi::c_void);
        assert!(!plausible_object(fake(0)));
        assert!(!plausible_object(fake((5 << 4) | 0x2)));
        assert!(!plausible_object(fake(0x1008)));
        assert!(plausible_object(fake(0x6000_1234_5670)));
        for address in [0, (1 << 4) | 0x2, (9 << 4) | 0x2] {
            join_full_screen_spaces(fake(address));
            act(fake(address), true);
            move_to_display(fake(address), "UUID".into());
            assert_eq!(transitions(fake(address)), 0);
        }
    }

    #[test]
    fn little_ardia_joins_full_screen_spaces_and_never_leads_one() {
        assert_eq!(
            joined_behavior((1 << 7) | (1 << 9) | 1),
            1 | (1 << 1) | (1 << 8)
        );
    }
}
