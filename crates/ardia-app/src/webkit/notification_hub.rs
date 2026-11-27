pub const DISMISSIBLE_CATEGORY: &str = "ardia.dismissible";
pub const ENGINE_NOTIFICATION_KEY: &str = "notificationId";
pub const DEFAULT_ACTION: &str = "com.apple.UNNotificationDefaultActionIdentifier";
pub const DISMISS_ACTION: &str = "com.apple.UNNotificationDismissActionIdentifier";
pub const PRESENT_BANNER_LIST_SOUND: usize = (1 << 4) | (1 << 3) | (1 << 1);
pub const CUSTOM_DISMISS_ACTION: usize = 1;
pub const MAX_ICON_BYTES: usize = 786_432;

pub fn action_name(identifier: &str) -> Option<&'static str> {
    match identifier {
        DEFAULT_ACTION => Some("click"),
        DISMISS_ACTION => Some("close"),
        _ => None,
    }
}

pub fn icon_extension(content_type: &str, url: &str) -> &'static str {
    let kind = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let subtype = kind
        .strip_prefix("image/")
        .map(str::to_owned)
        .unwrap_or_else(|| {
            url.rsplit('.')
                .next()
                .unwrap_or_default()
                .split(['?', '#'])
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        });
    match subtype.as_str() {
        "jpeg" | "jpg" => "jpg",
        "gif" => "gif",
        "heic" => "heic",
        "tiff" => "tiff",
        "webp" => "webp",
        _ => "png",
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::ffi::CString;
    use std::sync::atomic::{AtomicBool, Ordering};

    use block2::{DynBlock, RcBlock};
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol};
    use objc2::{AllocAnyThread, DefinedClass, Message as _, class, define_class, msg_send};
    use objc2_foundation::{NSArray, NSDictionary, NSString};
    use parking_lot::Mutex;

    use super::*;
    use crate::notifications::{NotificationResponse, Responder, RichNotification};

    static RESPONDER: Mutex<Option<Responder>> = Mutex::new(None);
    static PENDING: Mutex<Vec<NotificationResponse>> = Mutex::new(Vec::new());

    pub struct HubIvars {
        previous: RefCell<Option<Retained<AnyObject>>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "ArdiaGpuiNotificationHub"]
        #[ivars = HubIvars]
        pub struct Hub;

        unsafe impl NSObjectProtocol for Hub {}

        impl Hub {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                center: &AnyObject,
                notification: &AnyObject,
                handler: &DynBlock<dyn Fn(usize)>,
            ) {
                if posted_by_engine(notification)
                    && let Some(previous) = self.ivars().previous.borrow().clone()
                    && responds(
                        &previous,
                        "userNotificationCenter:willPresentNotification:withCompletionHandler:",
                    )
                {
                    let _: () = unsafe {
                        msg_send![&*previous, userNotificationCenter: center, willPresentNotification: notification, withCompletionHandler: handler]
                    };
                    return;
                }
                handler.call((PRESENT_BANNER_LIST_SOUND,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                center: &AnyObject,
                response: &AnyObject,
                handler: &DynBlock<dyn Fn()>,
            ) {
                let notification: Option<Retained<AnyObject>> =
                    unsafe { msg_send![response, notification] };
                if let Some(notification) = &notification
                    && posted_by_engine(notification)
                {
                    if let Some(previous) = self.ivars().previous.borrow().clone()
                        && responds(
                            &previous,
                            "userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:",
                        )
                    {
                        let _: () = unsafe {
                            msg_send![&*previous, userNotificationCenter: center, didReceiveNotificationResponse: response, withCompletionHandler: handler]
                        };
                        return;
                    }
                    handler.call(());
                    return;
                }
                let action: Option<Retained<NSString>> =
                    unsafe { msg_send![response, actionIdentifier] };
                let action = action.map(|a| a.to_string()).unwrap_or_default();
                if let (Some(notification), Some(action)) = (notification, action_name(&action)) {
                    let (id, info) = identity(&notification);
                    if action == "click" {
                        activate_app();
                    }
                    deliver(NotificationResponse {
                        id,
                        action: action.to_owned(),
                        info,
                    });
                }
                handler.call(());
            }
        }
    );

    thread_local! {
        static HUB: RefCell<Option<Retained<Hub>>> = const { RefCell::new(None) };
    }

    fn responds(object: &AnyObject, selector: &str) -> bool {
        let Ok(name) = CString::new(selector) else {
            return false;
        };
        let selector = objc2::runtime::Sel::register(&name);
        let answer: Bool = unsafe { msg_send![object, respondsToSelector: selector] };
        answer.as_bool()
    }

    fn center() -> Option<Retained<AnyObject>> {
        unsafe { msg_send![class!(UNUserNotificationCenter), currentNotificationCenter] }
    }

    fn user_info(notification: &AnyObject) -> Option<Retained<NSDictionary<NSString, AnyObject>>> {
        unsafe {
            let request: Option<Retained<AnyObject>> = msg_send![notification, request];
            let content: Option<Retained<AnyObject>> = msg_send![&*request?, content];
            msg_send![&*content?, userInfo]
        }
    }

    fn posted_by_engine(notification: &AnyObject) -> bool {
        user_info(notification).is_some_and(|info| {
            info.objectForKey(&NSString::from_str(ENGINE_NOTIFICATION_KEY))
                .is_some()
        })
    }

    fn identity(notification: &AnyObject) -> (String, Vec<(String, String)>) {
        let id = unsafe {
            let request: Option<Retained<AnyObject>> = msg_send![notification, request];
            request
                .and_then(|request| {
                    let id: Option<Retained<NSString>> = msg_send![&*request, identifier];
                    id
                })
                .map(|id| id.to_string())
                .unwrap_or_default()
        };
        let info = user_info(notification)
            .map(|info| {
                let keys = info.allKeys();
                keys.iter()
                    .filter_map(|key| {
                        let value = info.objectForKey(&key)?;
                        let text = value.downcast_ref::<NSString>()?.to_string();
                        Some((key.to_string(), text))
                    })
                    .collect()
            })
            .unwrap_or_default();
        (id, info)
    }

    fn activate_app() {
        unsafe {
            let app: Option<Retained<AnyObject>> =
                msg_send![class!(NSApplication), sharedApplication];
            if let Some(app) = app {
                let _: () = msg_send![&*app, activateIgnoringOtherApps: Bool::YES];
            }
        }
    }

    fn deliver(response: NotificationResponse) {
        let responder = RESPONDER.lock().clone();
        match responder {
            Some(responder) => responder(response),
            None => PENDING.lock().push(response),
        }
    }

    fn ensure_installed() {
        let Some(center) = center() else {
            return;
        };
        HUB.with(|cell| {
            let mut cell = cell.borrow_mut();
            let hub = cell
                .get_or_insert_with(|| {
                    let this = Hub::alloc().set_ivars(HubIvars {
                        previous: RefCell::new(None),
                    });
                    unsafe { msg_send![super(this), init] }
                })
                .clone();
            let current: Option<Retained<AnyObject>> = unsafe { msg_send![&*center, delegate] };
            let ours = current.as_ref().is_some_and(|current| {
                Retained::as_ptr(current).cast::<u8>() == Retained::as_ptr(&hub).cast::<u8>()
            });
            if !ours {
                if let Some(current) = current {
                    *hub.ivars().previous.borrow_mut() = Some(current);
                }
                let _: () = unsafe { msg_send![&*center, setDelegate: &*hub] };
            }
        });
    }

    fn register_category(center: &AnyObject) {
        static REGISTERED: AtomicBool = AtomicBool::new(false);
        if REGISTERED.swap(true, Ordering::AcqRel) {
            return;
        }
        let owner = center.retain();
        let block = RcBlock::new(move |categories: *mut AnyObject| unsafe {
            let category: Option<Retained<AnyObject>> = msg_send![
                class!(UNNotificationCategory),
                categoryWithIdentifier: &*NSString::from_str(DISMISSIBLE_CATEGORY),
                actions: &*NSArray::<AnyObject>::new(),
                intentIdentifiers: &*NSArray::<NSString>::new(),
                options: CUSTOM_DISMISS_ACTION
            ];
            let Some(category) = category else {
                return;
            };
            let existing: Option<Retained<AnyObject>> = if categories.is_null() {
                None
            } else {
                Some(Retained::retain(categories).unwrap_or_else(|| category.clone()))
            };
            let merged: Option<Retained<AnyObject>> = match existing {
                Some(existing) => msg_send![&*existing, setByAddingObject: &*category],
                None => msg_send![class!(NSSet), setWithObject: &*category],
            };
            if let Some(merged) = merged {
                let _: () = msg_send![&*owner, setNotificationCategories: &*merged];
            }
        });
        let _: () =
            unsafe { msg_send![center, getNotificationCategoriesWithCompletionHandler: &*block] };
    }

    pub fn install_hub(responder: Responder) {
        *RESPONDER.lock() = Some(responder.clone());
        if objc2::MainThreadMarker::new().is_some() {
            ensure_installed();
        }
        if let Some(center) = center() {
            register_category(&center);
        }
        let waiting: Vec<NotificationResponse> = std::mem::take(&mut *PENDING.lock());
        for response in waiting {
            responder(response);
        }
    }

    fn string_dictionary(
        pairs: &[(String, String)],
    ) -> Retained<NSDictionary<NSString, AnyObject>> {
        let keys: Vec<Retained<NSString>> =
            pairs.iter().map(|(k, _)| NSString::from_str(k)).collect();
        let values: Vec<Retained<AnyObject>> = pairs
            .iter()
            .map(|(_, v)| Retained::into_super(Retained::into_super(NSString::from_str(v))))
            .collect();
        let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
        let value_refs: Vec<&AnyObject> = values.iter().map(|v| &**v).collect();
        NSDictionary::from_slices(&key_refs, &value_refs)
    }

    pub fn post_rich(note: &RichNotification, asked: &AtomicBool) {
        if objc2::MainThreadMarker::new().is_some() {
            ensure_installed();
        }
        autoreleasepool(|_| unsafe {
            let Some(center) = center() else {
                return;
            };
            if !asked.swap(true, Ordering::AcqRel) {
                let answered = RcBlock::new(|_granted: Bool, _error: *mut AnyObject| {});
                let _: () = msg_send![&*center, requestAuthorizationWithOptions: (1usize << 1) | (1usize << 2), completionHandler: &*answered];
            }
            let content: Option<Retained<AnyObject>> =
                msg_send![class!(UNMutableNotificationContent), new];
            let Some(content) = content else {
                return;
            };
            let _: () = msg_send![&*content, setTitle: &*NSString::from_str(&note.title)];
            let _: () = msg_send![&*content, setBody: &*NSString::from_str(&note.body)];
            if let Some(subtitle) = &note.subtitle {
                let _: () = msg_send![&*content, setSubtitle: &*NSString::from_str(subtitle)];
            }
            if !note.silent {
                let sound: Option<Retained<AnyObject>> =
                    msg_send![class!(UNNotificationSound), defaultSound];
                if let Some(sound) = sound {
                    let _: () = msg_send![&*content, setSound: &*sound];
                }
            }
            if let Some(thread) = &note.thread {
                let _: () = msg_send![&*content, setThreadIdentifier: &*NSString::from_str(thread)];
            }
            if note.dismissible {
                let _: () = msg_send![&*content, setCategoryIdentifier: &*NSString::from_str(DISMISSIBLE_CATEGORY)];
            }
            let info = string_dictionary(&note.info);
            let _: () = msg_send![&*content, setUserInfo: &*info];
            if let Some(icon) = &note.icon {
                let url: Option<Retained<AnyObject>> = msg_send![
                    class!(NSURL),
                    fileURLWithPath: &*NSString::from_str(&icon.to_string_lossy())
                ];
                if let Some(url) = url {
                    let mut error: *mut AnyObject = std::ptr::null_mut();
                    let attachment: Option<Retained<AnyObject>> = msg_send![
                        class!(UNNotificationAttachment),
                        attachmentWithIdentifier: &*NSString::from_str("icon"),
                        URL: &*url,
                        options: None::<&AnyObject>,
                        error: &mut error
                    ];
                    if let Some(attachment) = attachment {
                        let list = NSArray::from_retained_slice(&[attachment]);
                        let _: () = msg_send![&*content, setAttachments: &*list];
                    }
                }
            }
            let request: Option<Retained<AnyObject>> = msg_send![
                class!(UNNotificationRequest),
                requestWithIdentifier: &*NSString::from_str(&note.id),
                content: &*content,
                trigger: None::<&AnyObject>
            ];
            if let Some(request) = request {
                let _: () = msg_send![&*center, addNotificationRequest: &*request, withCompletionHandler: None::<&DynBlock<dyn Fn(*mut AnyObject)>>];
            }
        });
    }
}

#[cfg(target_os = "macos")]
pub use mac::{install_hub, post_rich};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_map_to_the_old_actions() {
        assert_eq!(action_name(DEFAULT_ACTION), Some("click"));
        assert_eq!(action_name(DISMISS_ACTION), Some("close"));
        assert_eq!(action_name("other"), None);
        assert_eq!(icon_extension("image/jpeg", "x"), "jpg");
        assert_eq!(icon_extension("", "https://a.com/i.webp?x=1"), "webp");
        assert_eq!(
            icon_extension("application/octet-stream", "https://a.com/i"),
            "png"
        );
    }
}
