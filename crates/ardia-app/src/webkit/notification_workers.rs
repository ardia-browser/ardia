use std::collections::{HashMap, HashSet};

pub const WORKERS_KEPT: usize = 200;

pub fn shared_policy(
    decisions: &HashMap<String, HashMap<String, bool>>,
    origin: &str,
    profiles: &HashSet<String>,
) -> Option<bool> {
    let mut everyone: HashSet<&String> = profiles.iter().collect();
    everyone.extend(decisions.keys());
    let answers: Vec<Option<bool>> = everyone
        .into_iter()
        .map(|profile| decisions.get(profile).and_then(|d| d.get(origin)).copied())
        .collect();
    if !answers.iter().any(Option::is_some) {
        return None;
    }
    Some(answers.iter().all(|a| *a == Some(true)))
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};
    use std::collections::{HashMap, HashSet};
    use std::ffi::{CString, c_char, c_void};

    use block2::{DynBlock, RcBlock};
    use objc2::rc::{Retained, Weak};
    use objc2::runtime::{AnyClass, AnyObject, Bool, NSObject, NSObjectProtocol, Sel};
    use objc2::{
        AllocAnyThread, ClassType as _, DefinedClass, Message as _, define_class, msg_send, sel,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSURL, NSUUID};
    use objc2_web_kit::{WKWebView, WKWebsiteDataStore};

    use super::*;
    use crate::webkit::notifications::{self, WorkerNote};
    use crate::webkit::site_answers::{self, NOTIFICATIONS};

    pub struct WorkerIvars {
        profile: String,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "ArdiaGpuiWorkerNotifications"]
        #[ivars = WorkerIvars]
        pub struct WorkerDelegate;

        unsafe impl NSObjectProtocol for WorkerDelegate {}

        impl WorkerDelegate {
            #[unsafe(method_id(notificationPermissionsForWebsiteDataStore:))]
            fn permissions(&self, _store: &AnyObject) -> Retained<NSDictionary<NSString, NSNumber>> {
                let pairs = site_answers::answers_for(&self.ivars().profile, NOTIFICATIONS);
                let keys: Vec<Retained<NSString>> =
                    pairs.iter().map(|(origin, _)| NSString::from_str(origin)).collect();
                let values: Vec<Retained<NSNumber>> =
                    pairs.iter().map(|(_, allowed)| NSNumber::new_bool(*allowed)).collect();
                let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
                let value_refs: Vec<&NSNumber> = values.iter().map(|v| &**v).collect();
                NSDictionary::from_slices(&key_refs, &value_refs)
            }

            #[unsafe(method(websiteDataStore:showNotification:))]
            fn show(&self, store: &WKWebsiteDataStore, notification: &AnyObject) {
                worker_show(notification, store, &self.ivars().profile);
            }

            #[unsafe(method(websiteDataStore:openWindow:fromServiceWorkerOrigin:completionHandler:))]
            fn open_window(
                &self,
                store: &WKWebsiteDataStore,
                url: &NSURL,
                origin: &AnyObject,
                handler: &DynBlock<dyn Fn(*mut WKWebView)>,
            ) {
                let _ = store;
                let url = url.absoluteString().map(|s| s.to_string()).unwrap_or_default();
                let origin = security_origin(origin);
                match open_worker_window(&self.ivars().profile, &url, origin.as_deref()) {
                    Some(web) => handler.call((Retained::as_ptr(&web).cast_mut(),)),
                    None => handler.call((std::ptr::null_mut(),)),
                }
            }

            #[unsafe(method(websiteDataStore:getDisplayedNotificationsForWorkerOrigin:completionHandler:))]
            fn displayed(
                &self,
                _store: &WKWebsiteDataStore,
                origin: &AnyObject,
                handler: &DynBlock<dyn Fn(*mut NSArray<NSDictionary>)>,
            ) {
                let origin = security_origin(origin).unwrap_or_default();
                let profile = self.ivars().profile.clone();
                let list: Vec<Retained<NSDictionary>> = SHOWN.with(|shown| {
                    shown
                        .borrow()
                        .values()
                        .filter(|w| w.profile == profile && w.origin == origin)
                        .map(|w| w.notification.clone())
                        .collect()
                });
                let array = NSArray::from_retained_slice(&list);
                handler.call((Retained::as_ptr(&array).cast_mut(),));
            }
        }
    );

    struct WorkerShown {
        profile: String,
        origin: String,
        tag: String,
        notification: Retained<NSDictionary>,
        order: u64,
        store: Weak<WKWebsiteDataStore>,
    }

    thread_local! {
        static DELEGATES: RefCell<HashMap<usize, Retained<WorkerDelegate>>> = RefCell::new(HashMap::new());
        static SHOWN: RefCell<HashMap<String, WorkerShown>> = RefCell::new(HashMap::new());
        static ORDER: Cell<u64> = const { Cell::new(0) };
    }

    fn responds(object: &AnyObject, selector: &str) -> bool {
        let Ok(name) = CString::new(selector) else {
            return false;
        };
        let selector = Sel::register(&name);
        let answer: Bool = unsafe { msg_send![object, respondsToSelector: selector] };
        answer.as_bool()
    }

    fn value_for(object: &AnyObject, key: &str) -> Option<Retained<AnyObject>> {
        if !responds(object, key) {
            return None;
        }
        unsafe { msg_send![object, valueForKey: &*NSString::from_str(key)] }
    }

    fn text(object: &AnyObject, key: &str) -> String {
        value_for(object, key)
            .and_then(|value| value.downcast_ref::<NSString>().map(|s| s.to_string()))
            .unwrap_or_default()
    }

    fn security_origin(origin: &AnyObject) -> Option<String> {
        let protocol: Option<Retained<NSString>> = unsafe { msg_send![origin, protocol] };
        let host: Option<Retained<NSString>> = unsafe { msg_send![origin, host] };
        let port: isize = unsafe { msg_send![origin, port] };
        let protocol = protocol?.to_string().to_lowercase();
        let host = host?.to_string().to_lowercase();
        if !matches!(protocol.as_str(), "http" | "https") || host.is_empty() {
            return None;
        }
        let default = (protocol == "http" && port == 80) || (protocol == "https" && port == 443);
        Some(if port > 0 && !default {
            format!("{protocol}://{host}:{port}")
        } else {
            format!("{protocol}://{host}")
        })
    }

    pub fn attach_workers(store: &WKWebsiteDataStore, profile: &str) {
        if crate::webkit::site_settings::is_private(profile) {
            return;
        }
        let key = std::ptr::from_ref(store) as usize;
        if DELEGATES.with(|d| d.borrow().contains_key(&key)) || !responds(store, "set_delegate:") {
            return;
        }
        let delegate: Retained<WorkerDelegate> = {
            let this = WorkerDelegate::alloc().set_ivars(WorkerIvars {
                profile: profile.to_owned(),
            });
            unsafe { msg_send![super(this), init] }
        };
        let _: () = unsafe { msg_send![store, set_delegate: &*delegate] };
        DELEGATES.with(|d| d.borrow_mut().insert(key, delegate));
        let decided: HashSet<String> = site_answers::all_origins(NOTIFICATIONS);
        for origin in decided {
            announce_policy(profile, &origin);
        }
        notifications::prime(profile);
    }

    fn worker_profiles() -> HashSet<String> {
        DELEGATES.with(|d| {
            d.borrow()
                .values()
                .map(|delegate| {
                    delegate
                        .ivars()
                        .profile
                        .split('@')
                        .next()
                        .unwrap_or_default()
                        .to_owned()
                })
                .collect()
        })
    }

    type PolicyUpdate = unsafe extern "C" fn(*const c_void, *const c_void, bool);
    type MakeString = unsafe extern "C" fn(*const c_char) -> *const c_void;
    type MakeOrigin = unsafe extern "C" fn(*const c_void) -> *const c_void;
    type Release = unsafe extern "C" fn(*const c_void);
    type ManagerGetter = unsafe extern "C" fn(*const AnyObject, Sel) -> *const c_void;

    fn webkit_symbol(name: &str) -> Option<*mut c_void> {
        let path = CString::new("/System/Library/Frameworks/WebKit.framework/WebKit").ok()?;
        let name = CString::new(name).ok()?;
        unsafe {
            let image = libc::dlopen(path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_NOLOAD);
            if image.is_null() {
                return None;
            }
            let found = libc::dlsym(image, name.as_ptr());
            (!found.is_null()).then_some(found)
        }
    }

    fn manager_of(target: &AnyObject, class_method: bool, selector: Sel) -> Option<*const c_void> {
        let class: &AnyClass = if class_method {
            let class: *const AnyClass = std::ptr::from_ref(target).cast();
            unsafe { &*class }
        } else {
            target.class()
        };
        let method = if class_method {
            class.class_method(selector)
        } else {
            class.instance_method(selector)
        }?;
        let getter: ManagerGetter = unsafe { std::mem::transmute(method.implementation()) };
        let manager = unsafe { getter(target, selector) };
        (!manager.is_null()).then_some(manager)
    }

    fn notification_managers() -> Vec<*const c_void> {
        let mut managers = Vec::new();
        let stores: &AnyClass = WKWebsiteDataStore::class();
        let stores: &AnyObject = unsafe { &*std::ptr::from_ref(stores).cast::<AnyObject>() };
        if let Some(manager) =
            manager_of(stores, true, sel!(_sharedServiceWorkerNotificationManager))
        {
            managers.push(manager);
        }
        if let Some(web) = crate::webkit::page::any_web() {
            let configuration = unsafe { web.configuration() };
            let pool: Option<Retained<AnyObject>> =
                unsafe { msg_send![&*configuration, processPool] };
            if let Some(pool) = pool
                && let Some(manager) =
                    manager_of(&pool, false, sel!(_notificationManagerForTesting))
            {
                managers.push(manager);
            }
        }
        managers
    }

    fn announce(allowed: bool, origin: &str) {
        let (Some(update), Some(make_string), Some(make_origin), Some(release)) = (
            webkit_symbol("WKNotificationManagerProviderDidUpdateNotificationPolicy"),
            webkit_symbol("WKStringCreateWithUTF8CString"),
            webkit_symbol("WKSecurityOriginCreateFromString"),
            webkit_symbol("WKRelease"),
        ) else {
            return;
        };
        let Ok(text) = CString::new(origin) else {
            return;
        };
        unsafe {
            let update: PolicyUpdate = std::mem::transmute(update);
            let make_string: MakeString = std::mem::transmute(make_string);
            let make_origin: MakeOrigin = std::mem::transmute(make_origin);
            let release: Release = std::mem::transmute(release);
            let string = make_string(text.as_ptr());
            if string.is_null() {
                return;
            }
            let security = make_origin(string);
            if !security.is_null() {
                for manager in notification_managers() {
                    update(manager, security, allowed);
                }
                release(security);
            }
            release(string);
        }
    }

    pub fn announce_policy(_profile: &str, origin: &str) {
        let profiles = worker_profiles();
        if profiles.is_empty() {
            return;
        }
        let mut decisions: HashMap<String, HashMap<String, bool>> = HashMap::new();
        for profile in &profiles {
            if let Some(allowed) = site_answers::answer(profile, origin, NOTIFICATIONS) {
                decisions
                    .entry(profile.clone())
                    .or_default()
                    .insert(origin.to_owned(), allowed);
            }
        }
        announce(
            shared_policy(&decisions, origin, &profiles).unwrap_or(false),
            origin,
        );
    }

    fn worker_show(notification: &AnyObject, store: &WKWebsiteDataStore, profile: &str) {
        if !responds(notification, "dictionaryRepresentation")
            || !responds(notification, "securityOrigin")
        {
            return;
        }
        let dictionary: Option<Retained<NSDictionary>> =
            unsafe { msg_send![notification, dictionaryRepresentation] };
        let url = value_for(notification, "securityOrigin")
            .and_then(|value| value.downcast::<NSURL>().ok())
            .and_then(|url| url.absoluteString())
            .map(|s| s.to_string());
        let (Some(dictionary), Some(origin)) = (
            dictionary,
            url.as_deref()
                .and_then(crate::webkit::site_settings::origin_of),
        ) else {
            return;
        };
        let silent = value_for(notification, "alert")
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .is_some_and(|number| number.as_isize() == 1);
        let note = WorkerNote {
            profile: profile.to_owned(),
            origin,
            title: text(notification, "title"),
            body: text(notification, "body"),
            tag: text(notification, "tag"),
            silent,
        };
        let store = Weak::from_retained(&store.retain());
        notifications::worker_notification(note, move |note, wire| {
            ORDER.with(|order| order.set(order.get() + 1));
            let order = ORDER.with(Cell::get);
            let replaced: Option<String> = if note.tag.is_empty() {
                None
            } else {
                SHOWN.with(|shown| {
                    shown
                        .borrow()
                        .iter()
                        .find(|(_, w)| {
                            w.profile == note.profile
                                && w.origin == note.origin
                                && w.tag == note.tag
                        })
                        .map(|(id, _)| id.clone())
                })
            };
            if let Some(replaced) = &replaced {
                SHOWN.with(|shown| shown.borrow_mut().remove(replaced));
            }
            SHOWN.with(|shown| {
                let mut shown = shown.borrow_mut();
                shown.insert(
                    wire.to_owned(),
                    WorkerShown {
                        profile: note.profile.clone(),
                        origin: note.origin.clone(),
                        tag: note.tag.clone(),
                        notification: dictionary.clone(),
                        order,
                        store: store.clone(),
                    },
                );
                if shown.len() > WORKERS_KEPT
                    && let Some(oldest) = shown
                        .iter()
                        .min_by_key(|(_, w)| w.order)
                        .map(|(id, _)| id.clone())
                {
                    shown.remove(&oldest);
                }
            });
            replaced
        });
    }

    fn open_worker_window(
        profile: &str,
        url: &str,
        origin: Option<&str>,
    ) -> Option<Retained<WKWebView>> {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return None;
        }
        let (held, web) = crate::webkit::page::hold_worker_window(profile, url)?;
        if !notifications::open_worker_window(profile, origin, &held, url) {
            crate::webkit::page::drop_held(&held);
            return None;
        }
        Some(web)
    }

    fn deliver(
        action: &str,
        notification: &NSDictionary,
        store: Option<Retained<WKWebsiteDataStore>>,
    ) {
        let Some(store) = store else {
            return;
        };
        let click = action == "click";
        let selector = if click {
            "_processPersistentNotificationClick:completionHandler:"
        } else {
            "_processPersistentNotificationClose:completionHandler:"
        };
        if !responds(&store, selector) {
            return;
        }
        let done = RcBlock::new(move |delivered: Bool| {
            if delivered.as_bool() && click {
                notifications::count("workerClick");
            }
        });
        unsafe {
            if click {
                let _: () = msg_send![&*store, _processPersistentNotificationClick: notification, completionHandler: &*done];
            } else {
                let _: () = msg_send![&*store, _processPersistentNotificationClose: notification, completionHandler: &*done];
            }
        }
    }

    pub fn act_worker(wire: &str, action: &str) -> bool {
        let Some(shown) = SHOWN.with(|shown| shown.borrow_mut().remove(wire)) else {
            return false;
        };
        deliver(action, &shown.notification, shown.store.load());
        true
    }

    pub fn act_persistent_page(
        profile: &str,
        origin: &str,
        scope: &str,
        title: &str,
        body: &str,
        tag: &str,
        action: &str,
    ) {
        let Some(class) = AnyClass::get(c"_WKMutableNotificationData") else {
            return;
        };
        let (Some(scope), Some(origin_url)) = (
            NSURL::URLWithString(&NSString::from_str(scope)),
            NSURL::URLWithString(&NSString::from_str(origin)),
        ) else {
            return;
        };
        let made: Option<Retained<AnyObject>> = unsafe { msg_send![class, new] };
        let Some(made) = made else {
            return;
        };
        let values: [(&str, Retained<AnyObject>); 6] = [
            (
                "title",
                Retained::into_super(Retained::into_super(NSString::from_str(title))),
            ),
            (
                "body",
                Retained::into_super(Retained::into_super(NSString::from_str(body))),
            ),
            (
                "tag",
                Retained::into_super(Retained::into_super(NSString::from_str(tag))),
            ),
            (
                "securityOrigin",
                Retained::into_super(Retained::into_super(origin_url)),
            ),
            (
                "serviceWorkerRegistrationURL",
                Retained::into_super(Retained::into_super(scope)),
            ),
            (
                "uuid",
                Retained::into_super(Retained::into_super(NSUUID::new())),
            ),
        ];
        for (key, value) in values {
            let mut chars = key.chars();
            let setter = match chars.next() {
                Some(first) => format!("set{}{}:", first.to_ascii_uppercase(), chars.as_str()),
                None => continue,
            };
            if responds(&made, &setter) {
                let _: () = unsafe {
                    msg_send![&*made, setValue: &*value, forKey: &*NSString::from_str(key)]
                };
            }
        }
        if !responds(&made, "dictionaryRepresentation") {
            return;
        }
        let dictionary: Option<Retained<NSDictionary>> =
            unsafe { msg_send![&*made, dictionaryRepresentation] };
        if let Some(dictionary) = dictionary {
            deliver(
                action,
                &dictionary,
                crate::webkit::page::store_for(profile, false),
            );
        }
    }

    pub fn forget_profile(profile: &str) {
        SHOWN.with(|shown| shown.borrow_mut().retain(|_, w| w.profile != profile));
    }
}

#[cfg(target_os = "macos")]
pub use mac::{act_persistent_page, act_worker, announce_policy, attach_workers, forget_profile};

#[cfg(not(target_os = "macos"))]
pub fn announce_policy(_: &str, _: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn act_worker(_: &str, _: &str) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn act_persistent_page(_: &str, _: &str, _: &str, _: &str, _: &str, _: &str, _: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn forget_profile(_: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_policy_needs_every_profile_to_allow() {
        let mut decisions: HashMap<String, HashMap<String, bool>> = HashMap::new();
        let profiles: HashSet<String> = ["", "p-1"].iter().map(|p| (*p).to_owned()).collect();
        assert_eq!(shared_policy(&decisions, "https://a.com", &profiles), None);
        decisions
            .entry(String::new())
            .or_default()
            .insert("https://a.com".into(), true);
        assert_eq!(
            shared_policy(&decisions, "https://a.com", &profiles),
            Some(false)
        );
        decisions
            .entry("p-1".into())
            .or_default()
            .insert("https://a.com".into(), true);
        assert_eq!(
            shared_policy(&decisions, "https://a.com", &profiles),
            Some(true)
        );
    }
}
