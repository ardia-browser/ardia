use std::ffi::c_void;
use std::ptr::NonNull;

use ardia_engine::macos::{HostedWindowRoutes, SuperCall};
use gpui_platform::macos_hosted_window;

#[derive(Clone, Copy, Debug, Default)]
pub struct GpuiInputRoutes;

impl HostedWindowRoutes for GpuiInputRoutes {
    fn send_event(
        &self,
        window: NonNull<c_void>,
        event: NonNull<c_void>,
        call_super: SuperCall<'_, ()>,
    ) {
        unsafe { macos_hosted_window::send_event(window, event, || call_super.call()) }
    }

    fn key_down(
        &self,
        window: NonNull<c_void>,
        event: NonNull<c_void>,
        call_super: SuperCall<'_, ()>,
    ) {
        unsafe { macos_hosted_window::key_down(window, event, || call_super.call()) }
    }

    fn make_first_responder(
        &self,
        window: NonNull<c_void>,
        responder: Option<NonNull<c_void>>,
        call_super: SuperCall<'_, bool>,
    ) -> bool {
        unsafe {
            macos_hosted_window::make_first_responder(window, responder, || call_super.call())
        }
    }

    fn perform_key_equivalent(
        &self,
        window: NonNull<c_void>,
        event: NonNull<c_void>,
        call_super: SuperCall<'_, bool>,
    ) -> bool {
        unsafe { macos_hosted_window::perform_key_equivalent(window, event, || call_super.call()) }
    }
}

pub fn main_window() -> Option<usize> {
    use objc2::runtime::AnyObject;

    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {
        static NSApp: *mut AnyObject;
    }

    if unsafe { libc::pthread_main_np() } == 0 {
        return None;
    }
    let app = unsafe { NSApp };
    if app.is_null() {
        return None;
    }
    let window: *mut AnyObject = unsafe { objc2::msg_send![app, mainWindow] };
    (!window.is_null()).then_some(window as usize)
}
