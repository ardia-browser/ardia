use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RichNotification {
    pub id: String,
    pub title: String,
    pub body: String,
    pub subtitle: Option<String>,
    pub silent: bool,
    pub icon: Option<PathBuf>,
    pub thread: Option<String>,
    pub dismissible: bool,
    pub info: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NotificationResponse {
    pub id: String,
    pub action: String,
    pub info: Vec<(String, String)>,
}

pub type Responder = Arc<dyn Fn(NotificationResponse) + Send + Sync>;

pub trait Notifier: Send + Sync {
    fn post(&self, id: &str, title: &str, body: &str);
    fn remove(&self, ids: &[String]);
    fn app_active(&self) -> bool;

    fn post_rich(&self, note: &RichNotification) {
        self.post(&note.id, &note.title, &note.body);
    }
}

pub fn install_responder(responder: Responder) {
    #[cfg(target_os = "macos")]
    if macos::bundled() {
        macos::install_hub(responder);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = responder;
}

#[derive(Default)]
pub struct Silent;

impl Notifier for Silent {
    fn post(&self, _id: &str, _title: &str, _body: &str) {}
    fn remove(&self, _ids: &[String]) {}
    fn app_active(&self) -> bool {
        true
    }
}

pub fn system() -> Arc<dyn Notifier> {
    #[cfg(target_os = "macos")]
    if macos::bundled() {
        return Arc::new(macos::UserNotifications::default());
    }
    Arc::new(Silent)
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{CStr, CString};
    use std::sync::atomic::{AtomicBool, Ordering};

    use block2::RcBlock;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{class, msg_send};

    use super::Notifier;

    #[link(name = "UserNotifications", kind = "framework")]
    unsafe extern "C" {}

    const ALERT_AND_SOUND: usize = (1 << 1) | (1 << 2);

    unsafe fn ns_string(text: &str) -> *mut AnyObject {
        let Ok(text) = CString::new(text) else {
            return std::ptr::null_mut();
        };
        unsafe { msg_send![class!(NSString), stringWithUTF8String: text.as_ptr()] }
    }

    pub fn bundled() -> bool {
        autoreleasepool(|_| unsafe {
            let bundle: *mut AnyObject = msg_send![class!(NSBundle), mainBundle];
            if bundle.is_null() {
                return false;
            }
            let id: *mut AnyObject = msg_send![bundle, bundleIdentifier];
            if id.is_null() {
                return false;
            }
            let text: *const std::ffi::c_char = msg_send![id, UTF8String];
            !text.is_null()
                && !CStr::from_ptr(text).to_bytes().is_empty()
                && AnyClass::get(c"UNUserNotificationCenter").is_some()
        })
    }

    pub use crate::webkit::notification_hub::install_hub;
    use crate::webkit::notification_hub as hub;

    #[derive(Default)]
    pub struct UserNotifications {
        asked: AtomicBool,
    }

    unsafe fn center() -> *mut AnyObject {
        unsafe { msg_send![class!(UNUserNotificationCenter), currentNotificationCenter] }
    }

    impl Notifier for UserNotifications {
        fn post(&self, id: &str, title: &str, body: &str) {
            autoreleasepool(|_| unsafe {
                let center = center();
                if center.is_null() {
                    return;
                }
                if !self.asked.swap(true, Ordering::AcqRel) {
                    let asked = RcBlock::new(|_granted: Bool, _error: *mut AnyObject| {});
                    let _: () = msg_send![center, requestAuthorizationWithOptions: ALERT_AND_SOUND, completionHandler: &*asked];
                }
                let content: *mut AnyObject = msg_send![class!(UNMutableNotificationContent), new];
                if content.is_null() {
                    return;
                }
                let _: () = msg_send![content, setTitle: ns_string(title)];
                let _: () = msg_send![content, setBody: ns_string(body)];
                let request: *mut AnyObject = msg_send![
                    class!(UNNotificationRequest),
                    requestWithIdentifier: ns_string(id),
                    content: content,
                    trigger: std::ptr::null_mut::<AnyObject>()
                ];
                let _: () = msg_send![content, release];
                if !request.is_null() {
                    let _: () = msg_send![center, addNotificationRequest: request, withCompletionHandler: std::ptr::null_mut::<AnyObject>()];
                }
            });
        }

        fn remove(&self, ids: &[String]) {
            autoreleasepool(|_| unsafe {
                let center = center();
                if center.is_null() {
                    return;
                }
                let strings: Vec<*mut AnyObject> = ids
                    .iter()
                    .map(|id| ns_string(id))
                    .filter(|s| !s.is_null())
                    .collect();
                let list: *mut AnyObject = msg_send![class!(NSArray), arrayWithObjects: strings.as_ptr(), count: strings.len()];
                let _: () = msg_send![center, removeDeliveredNotificationsWithIdentifiers: list];
                let _: () =
                    msg_send![center, removePendingNotificationRequestsWithIdentifiers: list];
            });
        }

        fn post_rich(&self, note: &super::RichNotification) {
            hub::post_rich(note, &self.asked);
        }

        fn app_active(&self) -> bool {
            autoreleasepool(|_| unsafe {
                let app: *mut AnyObject =
                    msg_send![class!(NSRunningApplication), currentApplication];
                if app.is_null() {
                    return true;
                }
                let active: Bool = msg_send![app, isActive];
                active.as_bool()
            })
        }
    }
}

#[cfg(test)]
pub mod mock {
    use parking_lot::Mutex;

    use super::Notifier;

    #[derive(Default)]
    pub struct MockNotifier {
        pub active: Mutex<bool>,
        pub posted: Mutex<Vec<(String, String, String)>>,
        pub removed: Mutex<Vec<String>>,
    }

    impl Notifier for MockNotifier {
        fn post(&self, id: &str, title: &str, body: &str) {
            self.posted
                .lock()
                .push((id.into(), title.into(), body.into()));
        }

        fn remove(&self, ids: &[String]) {
            self.removed.lock().extend(ids.iter().cloned());
        }

        fn app_active(&self) -> bool {
            *self.active.lock()
        }
    }
}
