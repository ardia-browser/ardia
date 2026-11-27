use ardia_ui::{OnboardingSystem, OnboardingSystemChoice};

pub const PROBE_URL: &str = "https://example.com";
pub const DOCK_DOMAIN: &str = "com.apple.dock";
pub const DOCK_KEY: &str = "persistent-apps";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Applied {
    pub became_default: bool,
    pub login: Option<bool>,
    pub added_to_dock: bool,
}

pub trait SystemCalls {
    fn is_default_browser(&self) -> bool;
    fn set_default_browser(&self) -> bool;
    fn in_dock(&self) -> Option<bool>;
    fn add_to_dock(&self) -> bool;
    fn login_status(&self) -> LoginStatus;
    fn set_login(&self, enabled: bool) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginStatus {
    Enabled,
    RequiresApproval,
    NotFound,
    NotRegistered,
}

pub fn probe(calls: &dyn SystemCalls) -> OnboardingSystem {
    let dock = calls.in_dock();
    OnboardingSystem {
        is_default: calls.is_default_browser(),
        in_dock: dock.unwrap_or(false),
        dock_available: dock.is_some(),
        login_enabled: calls.login_status() == LoginStatus::Enabled,
    }
}

pub fn apply(
    calls: &dyn SystemCalls,
    choice: OnboardingSystemChoice,
    before: OnboardingSystem,
    allowed: bool,
) -> Applied {
    if !allowed {
        log::info!(
            "onboarding: a background or scratch instance leaves the default browser, Dock and login items alone"
        );
        return Applied::default();
    }
    let mut applied = Applied::default();
    if choice.set_default && !before.is_default {
        applied.became_default = calls.set_default_browser();
    }
    if choice.login != before.login_enabled && calls.set_login(choice.login) {
        applied.login = Some(choice.login);
    }
    if choice.dock && before.dock_available && !before.in_dock {
        applied.added_to_dock = calls.add_to_dock();
    }
    applied
}

#[cfg(target_os = "macos")]
pub mod mac {
    use std::ffi::c_void;

    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    use super::{DOCK_DOMAIN, DOCK_KEY, LoginStatus, PROBE_URL, SystemCalls};

    type CFTypeRef = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFPreferencesCopyAppValue(key: CFTypeRef, application: CFTypeRef) -> CFTypeRef;
        fn CFPreferencesSetAppValue(key: CFTypeRef, value: CFTypeRef, application: CFTypeRef);
        fn CFPreferencesAppSynchronize(application: CFTypeRef) -> u8;
        fn CFRelease(value: CFTypeRef);
    }

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSSetDefaultHandlerForURLScheme(scheme: CFTypeRef, bundle: CFTypeRef) -> i32;
    }

    #[link(name = "ServiceManagement", kind = "framework")]
    unsafe extern "C" {}

    fn cf(text: &NSString) -> CFTypeRef {
        (text as *const NSString).cast()
    }

    fn main_bundle() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"NSBundle")?;
        unsafe { msg_send![class, mainBundle] }
    }

    fn bundle_path() -> Option<String> {
        let bundle = main_bundle()?;
        let path: Option<Retained<NSString>> = unsafe { msg_send![&*bundle, bundlePath] };
        path.map(|p| standard(&p.to_string()))
    }

    fn bundle_id() -> Option<String> {
        let bundle = main_bundle()?;
        let id: Option<Retained<NSString>> = unsafe { msg_send![&*bundle, bundleIdentifier] };
        id.map(|id| id.to_string())
    }

    fn standard(path: &str) -> String {
        path.trim_end_matches('/').to_owned()
    }

    fn url_path(url: &NSURL) -> Option<String> {
        let standard: Option<Retained<NSURL>> = unsafe { msg_send![url, standardizedURL] };
        standard
            .and_then(|u| u.path())
            .map(|p| standard_path(&p.to_string()))
    }

    fn standard_path(path: &str) -> String {
        standard(path)
    }

    fn main_app_service() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"SMAppService")?;
        unsafe { msg_send![class, mainAppService] }
    }

    fn dock_tiles() -> Option<Retained<AnyObject>> {
        let key = NSString::from_str(DOCK_KEY);
        let domain = NSString::from_str(DOCK_DOMAIN);
        let value = unsafe { CFPreferencesCopyAppValue(cf(&key), cf(&domain)) };
        if value.is_null() {
            return None;
        }
        let object = value as *mut AnyObject;
        let retained = unsafe { Retained::retain(object) };
        unsafe { CFRelease(value) };
        retained
    }

    fn string_at(dict: &AnyObject, key: &str) -> Option<String> {
        let key = NSString::from_str(key);
        let value: Option<Retained<AnyObject>> = unsafe { msg_send![dict, objectForKey: &*key] };
        let value = value?;
        let is_string: bool =
            unsafe { msg_send![&*value, isKindOfClass: AnyClass::get(c"NSString")?] };
        if !is_string {
            return None;
        }
        let text: Retained<NSString> = unsafe { Retained::cast_unchecked(value) };
        Some(text.to_string())
    }

    fn dict_at(dict: &AnyObject, key: &str) -> Option<Retained<AnyObject>> {
        let key = NSString::from_str(key);
        let value: Option<Retained<AnyObject>> = unsafe { msg_send![dict, objectForKey: &*key] };
        let value = value?;
        let is_dict: bool =
            unsafe { msg_send![&*value, isKindOfClass: AnyClass::get(c"NSDictionary")?] };
        is_dict.then_some(value)
    }

    pub struct MacSystem;

    impl SystemCalls for MacSystem {
        fn is_default_browser(&self) -> bool {
            let Some(probe) = NSURL::URLWithString(&NSString::from_str(PROBE_URL)) else {
                return false;
            };
            let workspace = NSWorkspace::sharedWorkspace();
            let handler = workspace.URLForApplicationToOpenURL(&probe);
            match (handler.as_deref().and_then(url_path), bundle_path()) {
                (Some(handler), Some(me)) => handler == me,
                _ => false,
            }
        }

        fn set_default_browser(&self) -> bool {
            let Some(id) = bundle_id() else {
                return false;
            };
            let bundle = NSString::from_str(&id);
            for scheme in ["http", "https"] {
                let scheme = NSString::from_str(scheme);
                let status = unsafe { LSSetDefaultHandlerForURLScheme(cf(&scheme), cf(&bundle)) };
                if status != 0 {
                    log::info!("setting the default browser for {scheme} returned {status}");
                    return false;
                }
            }
            self.is_default_browser()
        }

        fn in_dock(&self) -> Option<bool> {
            let tiles = dock_tiles()?;
            let count: usize = unsafe { msg_send![&*tiles, count] };
            let me = bundle_path();
            let my_id = bundle_id();
            for index in 0..count {
                let tile: Retained<AnyObject> = unsafe { msg_send![&*tiles, objectAtIndex: index] };
                let Some(data) = dict_at(&tile, "tile-data") else {
                    continue;
                };
                if my_id.is_some() && string_at(&data, "bundle-identifier") == my_id {
                    return Some(true);
                }
                let file = dict_at(&data, "file-data").and_then(|f| string_at(&f, "_CFURLString"));
                let path = file
                    .and_then(|url| NSURL::URLWithString(&NSString::from_str(&url)))
                    .and_then(|url| url_path(&url));
                if path.is_some() && path == me {
                    return Some(true);
                }
            }
            Some(false)
        }

        fn add_to_dock(&self) -> bool {
            if self.in_dock() == Some(true) {
                return true;
            }
            let (Some(bundle), Some(id)) = (main_bundle(), bundle_id()) else {
                return false;
            };
            let url: Option<Retained<NSURL>> = unsafe { msg_send![&*bundle, bundleURL] };
            let Some(url) = url else {
                return false;
            };
            let Some(dict_class) = AnyClass::get(c"NSMutableDictionary") else {
                return false;
            };
            let Some(number) = AnyClass::get(c"NSNumber") else {
                return false;
            };
            let Some(array_class) = AnyClass::get(c"NSMutableArray") else {
                return false;
            };
            let set = |dict: &AnyObject, key: &str, value: &AnyObject| {
                let key = NSString::from_str(key);
                let _: () = unsafe { msg_send![dict, setObject: value, forKey: &*key] };
            };
            let text = |value: &str| NSString::from_str(value);
            let int = |value: i32| -> Retained<AnyObject> {
                unsafe { msg_send![number, numberWithInt: value] }
            };
            let file_data: Retained<AnyObject> = unsafe { msg_send![dict_class, dictionary] };
            let absolute: Option<Retained<NSString>> = url.absoluteString();
            let Some(absolute) = absolute else {
                return false;
            };
            set(&file_data, "_CFURLString", &absolute);
            set(&file_data, "_CFURLStringType", &int(15));
            let tile_data: Retained<AnyObject> = unsafe { msg_send![dict_class, dictionary] };
            set(&tile_data, "bundle-identifier", &text(&id));
            let name = std::env::current_exe()
                .ok()
                .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
                .unwrap_or_else(|| "Ardia".into());
            set(&tile_data, "file-label", &text(&name));
            set(&tile_data, "file-type", &int(41));
            set(&tile_data, "file-data", &file_data);
            let tile: Retained<AnyObject> = unsafe { msg_send![dict_class, dictionary] };
            set(&tile, "tile-type", &text("file-tile"));
            set(&tile, "tile-data", &tile_data);
            let tiles: Retained<AnyObject> = match dock_tiles() {
                Some(existing) => unsafe { msg_send![array_class, arrayWithArray: &*existing] },
                None => unsafe { msg_send![array_class, array] },
            };
            let _: () = unsafe { msg_send![&*tiles, addObject: &*tile] };
            let key = NSString::from_str(DOCK_KEY);
            let domain = NSString::from_str(DOCK_DOMAIN);
            unsafe {
                CFPreferencesSetAppValue(
                    cf(&key),
                    (&*tiles as *const AnyObject).cast(),
                    cf(&domain),
                );
            }
            if unsafe { CFPreferencesAppSynchronize(cf(&domain)) } == 0 {
                return false;
            }
            let _ = std::process::Command::new("/usr/bin/killall")
                .arg("Dock")
                .spawn();
            true
        }

        fn login_status(&self) -> LoginStatus {
            let Some(service) = main_app_service() else {
                return LoginStatus::NotRegistered;
            };
            let status: isize = unsafe { msg_send![&*service, status] };
            match status {
                1 => LoginStatus::Enabled,
                2 => LoginStatus::RequiresApproval,
                3 => LoginStatus::NotFound,
                _ => LoginStatus::NotRegistered,
            }
        }

        fn set_login(&self, enabled: bool) -> bool {
            let Some(service) = main_app_service() else {
                return false;
            };
            let mut error: *mut AnyObject = std::ptr::null_mut();
            let error_out: *mut *mut AnyObject = &mut error;
            if enabled {
                unsafe { msg_send![&*service, registerAndReturnError: error_out] }
            } else {
                unsafe { msg_send![&*service, unregisterAndReturnError: error_out] }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    #[derive(Default)]
    struct Fake {
        default: bool,
        dock: Option<bool>,
        login: bool,
        calls: RefCell<Vec<&'static str>>,
    }

    impl SystemCalls for Fake {
        fn is_default_browser(&self) -> bool {
            self.default
        }
        fn set_default_browser(&self) -> bool {
            self.calls.borrow_mut().push("default");
            true
        }
        fn in_dock(&self) -> Option<bool> {
            self.dock
        }
        fn add_to_dock(&self) -> bool {
            self.calls.borrow_mut().push("dock");
            true
        }
        fn login_status(&self) -> LoginStatus {
            if self.login {
                LoginStatus::Enabled
            } else {
                LoginStatus::NotRegistered
            }
        }
        fn set_login(&self, enabled: bool) -> bool {
            self.calls
                .borrow_mut()
                .push(if enabled { "login on" } else { "login off" });
            true
        }
    }

    #[test]
    fn the_probe_reads_default_dock_and_login() {
        let fake = Fake {
            default: true,
            dock: Some(false),
            login: true,
            ..Fake::default()
        };
        assert_eq!(
            probe(&fake),
            OnboardingSystem {
                is_default: true,
                in_dock: false,
                dock_available: true,
                login_enabled: true
            }
        );
        let unknown = Fake::default();
        assert!(!probe(&unknown).dock_available);
    }

    #[test]
    fn apply_only_changes_what_was_asked_and_what_is_missing() {
        let fake = Fake {
            dock: Some(false),
            ..Fake::default()
        };
        let before = probe(&fake);
        let choice = OnboardingSystemChoice {
            set_default: true,
            trial: false,
            login: true,
            dock: true,
        };
        let applied = apply(&fake, choice, before, true);
        assert_eq!(
            applied,
            Applied {
                became_default: true,
                login: Some(true),
                added_to_dock: true
            }
        );
        assert_eq!(*fake.calls.borrow(), vec!["default", "login on", "dock"]);
        let already = Fake {
            default: true,
            dock: Some(true),
            login: true,
            ..Fake::default()
        };
        let applied = apply(&already, choice, probe(&already), true);
        assert_eq!(applied, Applied::default());
        assert!(already.calls.borrow().is_empty());
    }

    #[test]
    fn background_and_scratch_instances_never_touch_the_system() {
        let fake = Fake {
            dock: Some(false),
            ..Fake::default()
        };
        let choice = OnboardingSystemChoice {
            set_default: true,
            trial: true,
            login: true,
            dock: true,
        };
        assert_eq!(
            apply(&fake, choice, probe(&fake), false),
            Applied::default()
        );
        assert!(fake.calls.borrow().is_empty());
    }
}
