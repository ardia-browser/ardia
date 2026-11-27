#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};

    use crate::record::{main_busy_began, main_busy_ended, now_ns};

    type Observer = *mut c_void;
    type Callout = extern "C" fn(Observer, usize, *mut c_void);

    const BEFORE_WAITING: usize = 1 << 5;
    const AFTER_WAITING: usize = 1 << 6;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFRunLoopCommonModes: *const c_void;
        fn CFRunLoopGetMain() -> *mut c_void;
        fn CFRunLoopObserverCreate(
            allocator: *const c_void,
            activities: usize,
            repeats: u8,
            order: isize,
            callout: Callout,
            context: *mut c_void,
        ) -> Observer;
        fn CFRunLoopAddObserver(run_loop: *mut c_void, observer: Observer, mode: *const c_void);
    }

    extern "C" fn woke(_: Observer, _: usize, _: *mut c_void) {
        main_busy_began(now_ns());
    }

    extern "C" fn waiting(_: Observer, _: usize, _: *mut c_void) {
        main_busy_ended(now_ns());
    }

    static INSTALLED: AtomicBool = AtomicBool::new(false);

    pub fn install() -> bool {
        if INSTALLED.swap(true, Ordering::AcqRel) {
            return false;
        }
        unsafe {
            let main = CFRunLoopGetMain();
            let first = CFRunLoopObserverCreate(
                std::ptr::null(),
                AFTER_WAITING,
                1,
                isize::MIN,
                woke,
                std::ptr::null_mut(),
            );
            let last = CFRunLoopObserverCreate(
                std::ptr::null(),
                BEFORE_WAITING,
                1,
                isize::MAX,
                waiting,
                std::ptr::null_mut(),
            );
            if main.is_null() || first.is_null() || last.is_null() {
                return false;
            }
            CFRunLoopAddObserver(main, first, kCFRunLoopCommonModes);
            CFRunLoopAddObserver(main, last, kCFRunLoopCommonModes);
        }
        true
    }
}

#[cfg(target_os = "macos")]
pub fn install() -> bool {
    mac::install()
}

#[cfg(not(target_os = "macos"))]
pub fn install() -> bool {
    false
}
