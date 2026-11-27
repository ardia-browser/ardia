use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const PAGE: &str = include_str!("../assets/meadow/index.html");
pub const HANDLER: &str = "meadow";
pub const COVER_LEVEL: isize = 25;

static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn page_path(data_dir: &Path) -> PathBuf {
    data_dir.join("Meadow").join("index.html")
}

pub fn write_page(data_dir: &Path) -> Option<PathBuf> {
    let path = page_path(data_dir);
    let current = std::fs::read_to_string(&path).ok();
    if current.as_deref() != Some(PAGE) {
        std::fs::create_dir_all(path.parent()?).ok()?;
        std::fs::write(&path, PAGE).ok()?;
    }
    Some(path)
}

pub fn fragment(night: bool, creeper: bool) -> &'static str {
    match (night, creeper) {
        (true, true) => "#night-creeper",
        (true, false) => "#night",
        _ => "#day",
    }
}

pub fn said(state: &str) {
    EVENTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(state.to_owned());
}

pub fn drain() -> Vec<String> {
    std::mem::take(&mut *EVENTS.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(target_os = "macos")]
pub struct Shown(pub mac::Meadow);

#[cfg(target_os = "macos")]
unsafe impl Send for Shown {}

#[cfg(target_os = "macos")]
pub fn shown() -> &'static parking_lot::Mutex<Option<Shown>> {
    static SHOWN: parking_lot::Mutex<Option<Shown>> = parking_lot::Mutex::new(None);
    &SHOWN
}

#[cfg(target_os = "macos")]
pub mod mac {
    use std::ffi::c_void;
    use std::path::Path;
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, AnyProtocol, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    use objc2_foundation::{NSString, NSURL};

    #[link(name = "WebKit", kind = "framework")]
    unsafe extern "C" {}

    unsafe extern "C-unwind" fn received(
        _this: *mut AnyObject,
        _cmd: Sel,
        _controller: *mut AnyObject,
        message: *mut AnyObject,
    ) {
        if message.is_null() {
            return;
        }
        unsafe {
            let body: *mut AnyObject = msg_send![message, body];
            if body.is_null() {
                return;
            }
            let Some(dict) = AnyClass::get(c"NSDictionary") else {
                return;
            };
            let is_dict: bool = msg_send![body, isKindOfClass: dict];
            if !is_dict {
                return;
            }
            let key = NSString::from_str("state");
            let state: *mut AnyObject = msg_send![body, objectForKey: &*key];
            if state.is_null() {
                return;
            }
            let utf8: *const std::ffi::c_char = msg_send![state, UTF8String];
            if utf8.is_null() {
                return;
            }
            let text = std::ffi::CStr::from_ptr(utf8)
                .to_string_lossy()
                .into_owned();
            super::said(&text);
        }
    }

    fn handler_class() -> Option<&'static AnyClass> {
        static CLASS: OnceLock<usize> = OnceLock::new();
        let raw = *CLASS.get_or_init(|| {
            let Some(superclass) = AnyClass::get(c"NSObject") else {
                return 0;
            };
            let Some(mut builder) = ClassBuilder::new(c"ArdiaGpuiMeadowMessages", superclass)
            else {
                return AnyClass::get(c"ArdiaGpuiMeadowMessages")
                    .map_or(0, |c| c as *const AnyClass as usize);
            };
            if let Some(protocol) = AnyProtocol::get(c"WKScriptMessageHandler") {
                builder.add_protocol(protocol);
            }
            unsafe {
                builder.add_method(
                    sel!(userContentController:didReceiveScriptMessage:),
                    received
                        as unsafe extern "C-unwind" fn(
                            *mut AnyObject,
                            Sel,
                            *mut AnyObject,
                            *mut AnyObject,
                        ),
                );
            }
            builder.register() as *const AnyClass as usize
        });
        (raw != 0).then(|| unsafe { &*(raw as *const AnyClass) })
    }

    pub struct Meadow {
        pub view: *mut AnyObject,
        controller: *mut AnyObject,
        handler: *mut AnyObject,
    }

    impl Meadow {
        pub fn view_ptr(&self) -> *mut c_void {
            self.view.cast()
        }

        pub fn set_alpha(&self, alpha: f64) {
            let _: () = unsafe { msg_send![self.view, setAlphaValue: alpha] };
        }

        pub fn loading(&self) -> bool {
            unsafe { msg_send![self.view, isLoading] }
        }
    }

    impl Drop for Meadow {
        fn drop(&mut self) {
            unsafe {
                let name = NSString::from_str(super::HANDLER);
                let _: () = msg_send![self.controller, removeScriptMessageHandlerForName: &*name];
                let _: () = msg_send![self.view, stopLoading];
                let _: () = msg_send![self.view, release];
                let _: () = msg_send![self.handler, release];
            }
        }
    }

    pub fn cover_screen(window: &gpui::Window) {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let Ok(handle) = HasWindowHandle::window_handle(window) else {
            return;
        };
        let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
            return;
        };
        let view = appkit.ns_view.as_ptr().cast::<AnyObject>();
        unsafe {
            let shell: *mut AnyObject = msg_send![view, window];
            if shell.is_null() {
                return;
            }
            let mut screen: *mut AnyObject = msg_send![shell, screen];
            if screen.is_null()
                && let Some(class) = AnyClass::get(c"NSScreen")
            {
                screen = msg_send![class, mainScreen];
            }
            if screen.is_null() {
                return;
            }
            let frame: objc2_foundation::NSRect = msg_send![screen, frame];
            let _: () = msg_send![shell, setStyleMask: 0usize];
            let _: () = msg_send![shell, setLevel: super::COVER_LEVEL];
            let _: () = msg_send![shell, setHasShadow: false];
            let _: () = msg_send![shell, setFrame: frame, display: true];
        }
    }

    pub fn app_active() -> bool {
        let Some(class) = AnyClass::get(c"NSApplication") else {
            return true;
        };
        unsafe {
            let app: *mut AnyObject = msg_send![class, sharedApplication];
            if app.is_null() {
                return true;
            }
            msg_send![app, isActive]
        }
    }

    pub fn create(page: &Path, night: bool, creeper: bool) -> Option<Meadow> {
        unsafe {
            let config_class = AnyClass::get(c"WKWebViewConfiguration")?;
            let store_class = AnyClass::get(c"WKWebsiteDataStore")?;
            let web_class = AnyClass::get(c"WKWebView")?;
            let config: *mut AnyObject = msg_send![config_class, new];
            let store: *mut AnyObject = msg_send![store_class, nonPersistentDataStore];
            let _: () = msg_send![config, setWebsiteDataStore: store];
            let _: () = msg_send![config, setMediaTypesRequiringUserActionForPlayback: usize::MAX];
            let controller: *mut AnyObject = msg_send![config, userContentController];
            let handler: *mut AnyObject = match handler_class() {
                Some(class) => msg_send![class, new],
                None => std::ptr::null_mut(),
            };
            if !handler.is_null() {
                let name = NSString::from_str(super::HANDLER);
                let _: () = msg_send![controller, addScriptMessageHandler: handler, name: &*name];
            }
            let allocated: *mut AnyObject = msg_send![web_class, alloc];
            let frame = [0f64, 0.0, 800.0, 600.0];
            let view: *mut AnyObject = msg_send![allocated, initWithFrame: objc2_foundation::NSRect::new(objc2_foundation::NSPoint::new(frame[0], frame[1]), objc2_foundation::NSSize::new(frame[2], frame[3])), configuration: config];
            let _: () = msg_send![config, release];
            if view.is_null() {
                return None;
            }
            let _: () = msg_send![view, setAllowsMagnification: false];
            let _: () = msg_send![view, setAllowsBackForwardNavigationGestures: false];
            let _: () = msg_send![view, setAllowsLinkPreview: false];
            let _: () = msg_send![view, setAlphaValue: 0.0f64];
            let page_url = NSURL::fileURLWithPath(&NSString::from_str(&page.to_string_lossy()));
            let opening = NSURL::URLWithString_relativeToURL(
                &NSString::from_str(super::fragment(night, creeper)),
                Some(&page_url),
            )
            .unwrap_or(page_url.clone());
            let folder = NSURL::fileURLWithPath(&NSString::from_str(
                &page.parent().unwrap_or(page).to_string_lossy(),
            ));
            let _: *mut AnyObject =
                msg_send![view, loadFileURL: &*opening, allowingReadAccessToURL: &*folder];
            Some(Meadow {
                view,
                controller,
                handler,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_is_written_once_and_fragments_pick_the_scene() {
        let dir = tempfile::tempdir().expect("dir");
        let path = write_page(dir.path()).expect("written");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), PAGE);
        assert_eq!(fragment(true, true), "#night-creeper");
        assert_eq!(fragment(false, true), "#day");
        said("ready");
        said("boom");
        assert_eq!(drain(), vec!["ready".to_owned(), "boom".to_owned()]);
        assert!(drain().is_empty());
    }
}
