use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginItem {
    Enabled,
    RequiresApproval,
    NotFound,
    NotRegistered,
}

impl LoginItem {
    pub fn from_status(status: isize) -> Self {
        match status {
            1 => LoginItem::Enabled,
            2 => LoginItem::RequiresApproval,
            3 => LoginItem::NotFound,
            _ => LoginItem::NotRegistered,
        }
    }

    pub fn shown_on(self) -> bool {
        matches!(self, LoginItem::Enabled | LoginItem::RequiresApproval)
    }
}

pub struct ProbeCache<T> {
    known: parking_lot::Mutex<Option<(T, Instant)>>,
    refreshing: AtomicBool,
    generation: AtomicU64,
    fresh_for: Duration,
}

impl<T: Copy + PartialEq + Send + 'static> ProbeCache<T> {
    pub const fn new(fresh_for: Duration) -> Self {
        Self {
            known: parking_lot::const_mutex(None),
            refreshing: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            fresh_for,
        }
    }

    pub fn get(&'static self, probe: fn() -> T, on_change: impl FnOnce() + Send + 'static) -> T {
        let known = *self.known.lock();
        match known {
            Some((value, at)) => {
                if at.elapsed() >= self.fresh_for {
                    self.refresh_in_background(probe, on_change);
                }
                value
            }
            None => {
                let value = probe();
                self.store(value);
                value
            }
        }
    }

    pub fn prewarm(&'static self, probe: fn() -> T) {
        if self.known.lock().is_none() {
            self.refresh_in_background(probe, || {});
        }
    }

    pub fn forget(&self) {
        let mut known = self.known.lock();
        self.generation.fetch_add(1, Ordering::AcqRel);
        *known = None;
    }

    fn store(&self, value: T) -> bool {
        let mut known = self.known.lock();
        Self::replace(&mut known, value)
    }

    fn store_if_current(&self, value: T, generation: u64) -> bool {
        let mut known = self.known.lock();
        if self.generation.load(Ordering::Acquire) != generation {
            return false;
        }
        Self::replace(&mut known, value)
    }

    fn replace(known: &mut Option<(T, Instant)>, value: T) -> bool {
        let changed = known.is_some_and(|(old, _)| old != value);
        *known = Some((value, Instant::now()));
        changed
    }

    fn refresh_in_background(
        &'static self,
        probe: fn() -> T,
        on_change: impl FnOnce() + Send + 'static,
    ) {
        if self.refreshing.swap(true, Ordering::AcqRel) {
            return;
        }
        let generation = self.generation.load(Ordering::Acquire);
        let spawned = std::thread::Builder::new()
            .name("ardia-system-probe".into())
            .spawn(move || {
                let changed = self.store_if_current(probe(), generation);
                self.refreshing.store(false, Ordering::Release);
                if changed {
                    on_change();
                }
            });
        if spawned.is_err() {
            self.refreshing.store(false, Ordering::Release);
        }
    }
}

const LOGIN_ITEM_FRESH_FOR: Duration = Duration::from_secs(2);

static LOGIN_ITEM: ProbeCache<LoginItem> = ProbeCache::new(LOGIN_ITEM_FRESH_FOR);

pub fn cached_login_item(on_change: impl FnOnce() + Send + 'static) -> LoginItem {
    LOGIN_ITEM.get(login_item, on_change)
}

pub fn prewarm_login_item() {
    LOGIN_ITEM.prewarm(login_item);
}

pub fn forget_login_item() {
    LOGIN_ITEM.forget();
}

#[cfg(target_os = "macos")]
mod mac {
    use super::LoginItem;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{class, msg_send};
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    #[link(name = "ServiceManagement", kind = "framework")]
    unsafe extern "C" {}

    fn main_app_service() -> Option<Retained<AnyObject>> {
        let class: &AnyClass = AnyClass::get(c"SMAppService")?;
        unsafe { msg_send![class, mainAppService] }
    }

    fn bundle_url() -> Option<Retained<NSURL>> {
        let bundle: Option<Retained<AnyObject>> =
            unsafe { msg_send![class!(NSBundle), mainBundle] };
        let bundle = bundle?;
        unsafe { msg_send![&*bundle, bundleURL] }
    }

    fn standardized_path(url: &NSURL) -> Option<String> {
        let standard: Option<Retained<NSURL>> = unsafe { msg_send![url, standardizedURL] };
        let path: Option<Retained<NSString>> = unsafe { msg_send![&*standard?, path] };
        path.map(|path| path.to_string())
    }

    pub fn is_default_browser() -> bool {
        let Some(app) = bundle_url() else {
            return false;
        };
        let Some(probe) = NSURL::URLWithString(&NSString::from_str("https://example.com")) else {
            return false;
        };
        let workspace = NSWorkspace::sharedWorkspace();
        let handler: Option<Retained<NSURL>> =
            unsafe { msg_send![&*workspace, URLForApplicationToOpenURL: &*probe] };
        match (handler, standardized_path(&app)) {
            (Some(handler), Some(app)) => standardized_path(&handler).as_deref() == Some(&app),
            _ => false,
        }
    }

    pub fn make_default_browser() {
        let Some(app) = bundle_url() else {
            return;
        };
        let workspace = NSWorkspace::sharedWorkspace();
        for scheme in ["http", "https"] {
            let scheme = NSString::from_str(scheme);
            let none: *const AnyObject = std::ptr::null();
            let _: () = unsafe {
                msg_send![&*workspace, setDefaultApplicationAtURL: &*app, toOpenURLsWithScheme: &*scheme, completionHandler: none]
            };
        }
    }

    pub fn app_version() -> Option<String> {
        let bundle: Option<Retained<AnyObject>> =
            unsafe { msg_send![class!(NSBundle), mainBundle] };
        let bundle = bundle?;
        let key = NSString::from_str("CFBundleShortVersionString");
        let value: Option<Retained<AnyObject>> =
            unsafe { msg_send![&*bundle, objectForInfoDictionaryKey: &*key] };
        let value = value?;
        let is_string: bool = unsafe { msg_send![&*value, isKindOfClass: class!(NSString)] };
        if !is_string {
            return None;
        }
        let text: Retained<NSString> = unsafe { Retained::cast_unchecked(value) };
        Some(text.to_string()).filter(|text| !text.is_empty())
    }

    pub fn login_item() -> LoginItem {
        let Some(service) = main_app_service() else {
            return LoginItem::NotRegistered;
        };
        let status: isize = unsafe { msg_send![&*service, status] };
        LoginItem::from_status(status)
    }

    pub fn set_open_at_login(on: bool) -> bool {
        let Some(service) = main_app_service() else {
            return false;
        };
        let mut error: *mut AnyObject = std::ptr::null_mut();
        let done: bool = if on {
            unsafe { msg_send![&*service, registerAndReturnError: &mut error] }
        } else {
            unsafe { msg_send![&*service, unregisterAndReturnError: &mut error] }
        };
        done
    }
}

#[cfg(target_os = "macos")]
pub use mac::{
    app_version, is_default_browser, login_item, make_default_browser, set_open_at_login,
};

#[cfg(not(target_os = "macos"))]
pub fn app_version() -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn is_default_browser() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn make_default_browser() {}

#[cfg(not(target_os = "macos"))]
pub fn login_item() -> LoginItem {
    LoginItem::NotRegistered
}

#[cfg(not(target_os = "macos"))]
pub fn set_open_at_login(_on: bool) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn login_status_maps_like_the_old_module() {
        assert_eq!(LoginItem::from_status(1), LoginItem::Enabled);
        assert_eq!(LoginItem::from_status(2), LoginItem::RequiresApproval);
        assert_eq!(LoginItem::from_status(3), LoginItem::NotFound);
        assert_eq!(LoginItem::from_status(0), LoginItem::NotRegistered);
        assert!(LoginItem::RequiresApproval.shown_on());
        assert!(!LoginItem::NotFound.shown_on());
    }

    fn wait_until(done: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        done()
    }

    static FIRST_PROBES: AtomicUsize = AtomicUsize::new(0);
    static FIRST_CACHE: ProbeCache<u8> = ProbeCache::new(Duration::from_secs(60));

    fn first_probe() -> u8 {
        FIRST_PROBES.fetch_add(1, Ordering::SeqCst);
        7
    }

    #[test]
    fn a_fresh_value_is_served_without_probing_again() {
        assert_eq!(FIRST_CACHE.get(first_probe, || {}), 7);
        assert_eq!(FIRST_CACHE.get(first_probe, || {}), 7);
        assert_eq!(FIRST_CACHE.get(first_probe, || {}), 7);
        assert_eq!(FIRST_PROBES.load(Ordering::SeqCst), 1);
    }

    static STALE_VALUE: AtomicUsize = AtomicUsize::new(1);
    static STALE_CACHE: ProbeCache<usize> = ProbeCache::new(Duration::ZERO);

    fn stale_probe() -> usize {
        STALE_VALUE.load(Ordering::SeqCst)
    }

    #[test]
    fn a_stale_value_answers_at_once_and_refreshes_off_the_caller() {
        assert_eq!(STALE_CACHE.get(stale_probe, || {}), 1);
        STALE_VALUE.store(2, Ordering::SeqCst);
        let changed = std::sync::Arc::new(AtomicBool::new(false));
        let noted = std::sync::Arc::clone(&changed);
        assert_eq!(
            STALE_CACHE.get(stale_probe, move || noted.store(true, Ordering::SeqCst)),
            1
        );
        assert!(wait_until(|| changed.load(Ordering::SeqCst)));
        assert!(wait_until(|| !STALE_CACHE
            .refreshing
            .load(Ordering::SeqCst)));
        STALE_VALUE.store(2, Ordering::SeqCst);
        assert_eq!(STALE_CACHE.get(stale_probe, || {}), 2);
    }

    static WARM_PROBES: AtomicUsize = AtomicUsize::new(0);
    static WARM_CACHE: ProbeCache<u8> = ProbeCache::new(Duration::from_secs(60));

    fn warm_probe() -> u8 {
        WARM_PROBES.fetch_add(1, Ordering::SeqCst);
        3
    }

    static RACE_VALUE: AtomicUsize = AtomicUsize::new(1);
    static RACE_GATE: parking_lot::Mutex<()> = parking_lot::const_mutex(());
    static RACE_CACHE: ProbeCache<usize> = ProbeCache::new(Duration::ZERO);

    static RACE_PROBING: AtomicBool = AtomicBool::new(false);

    fn slow_probe() -> usize {
        let seen = RACE_VALUE.load(Ordering::SeqCst);
        RACE_PROBING.store(true, Ordering::SeqCst);
        drop(RACE_GATE.lock());
        seen
    }

    #[test]
    fn a_refresh_that_started_before_forget_never_overwrites_the_newer_value() {
        assert_eq!(RACE_CACHE.get(slow_probe, || {}), 1);
        RACE_PROBING.store(false, Ordering::SeqCst);
        let gate = RACE_GATE.lock();
        assert_eq!(RACE_CACHE.get(slow_probe, || {}), 1);
        assert!(wait_until(|| RACE_PROBING.load(Ordering::SeqCst)));
        RACE_CACHE.forget();
        RACE_VALUE.store(2, Ordering::SeqCst);
        RACE_CACHE.store(2);
        drop(gate);
        assert!(wait_until(|| !RACE_CACHE.refreshing.load(Ordering::SeqCst)));
        assert_eq!(RACE_CACHE.known.lock().map(|(value, _)| value), Some(2));
    }

    #[test]
    fn a_prewarmed_value_needs_no_probe_on_first_use_and_forget_probes_again() {
        WARM_CACHE.prewarm(warm_probe);
        assert!(wait_until(|| WARM_CACHE.known.lock().is_some()));
        assert_eq!(WARM_CACHE.get(warm_probe, || {}), 3);
        assert_eq!(WARM_PROBES.load(Ordering::SeqCst), 1);
        WARM_CACHE.forget();
        assert_eq!(WARM_CACHE.get(warm_probe, || {}), 3);
        assert_eq!(WARM_PROBES.load(Ordering::SeqCst), 2);
    }
}
