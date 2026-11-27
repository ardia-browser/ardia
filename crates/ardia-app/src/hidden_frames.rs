use std::time::Duration;

use gpui::{App, Window};

pub const HIDDEN_FRAME_EVERY: Duration = Duration::from_millis(250);

#[cfg(target_os = "macos")]
pub fn request_frame(window: &mut Window) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        return;
    };
    let view = appkit.ns_view.as_ptr().cast::<AnyObject>();
    unsafe {
        let layer: *mut AnyObject = msg_send![view, layer];
        if let Some(layer) = layer.as_ref() {
            let _: () = msg_send![layer, setNeedsDisplay];
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request_frame(window: &mut Window) {
    let _ = window;
}

pub fn keep_drawing(cx: &mut App) {
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(HIDDEN_FRAME_EVERY).await;
            cx.update(|cx| {
                for handle in cx.windows() {
                    let _ = handle.update(cx, |_, window, _| {
                        window.refresh();
                        request_frame(window);
                    });
                }
            });
        }
    })
    .detach();
}
