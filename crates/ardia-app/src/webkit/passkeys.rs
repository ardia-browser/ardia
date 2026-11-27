use std::sync::atomic::{AtomicBool, Ordering};

use ardia_ui::settings::engines::{PasskeyAccess, PasskeyStatus};

use crate::coordinator::AppCoordinator;

pub const ENTITLEMENT: &str = "com.apple.developer.web-browser.public-key-credential";

static REQUESTING: AtomicBool = AtomicBool::new(false);

pub fn status_of(device_configured: bool, state: isize) -> PasskeyStatus {
    if !device_configured {
        return PasskeyStatus::DeviceNotConfigured;
    }
    match state {
        0 => PasskeyStatus::Authorized,
        1 => PasskeyStatus::Denied,
        _ => PasskeyStatus::NotDetermined,
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
    use objc2::{msg_send, sel};
    use objc2_foundation::NSString;

    use super::*;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecTaskCreateFromSelf(allocator: *const c_void) -> *mut c_void;
        fn SecTaskCopyValueForEntitlement(
            task: *mut c_void,
            entitlement: *const c_void,
            error: *mut *mut c_void,
        ) -> *mut c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
        fn CFBooleanGetValue(value: *const c_void) -> u8;
        fn CFGetTypeID(value: *const c_void) -> usize;
        fn CFBooleanGetTypeID() -> usize;
    }

    #[link(name = "AuthenticationServices", kind = "framework")]
    unsafe extern "C" {}

    pub fn entitled() -> bool {
        static ENTITLED: OnceLock<bool> = OnceLock::new();
        *ENTITLED.get_or_init(|| unsafe {
            let task = SecTaskCreateFromSelf(std::ptr::null());
            if task.is_null() {
                return false;
            }
            let name = NSString::from_str(ENTITLEMENT);
            let value = SecTaskCopyValueForEntitlement(
                task,
                (&*name as *const NSString).cast(),
                std::ptr::null_mut(),
            );
            CFRelease(task);
            if value.is_null() {
                return false;
            }
            let yes = CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue(value) != 0;
            CFRelease(value);
            yes
        })
    }

    fn manager_class() -> Option<&'static AnyClass> {
        AnyClass::get(c"ASAuthorizationWebBrowserPublicKeyCredentialManager")
    }

    fn device_configured() -> bool {
        let Some(class) = manager_class() else {
            return true;
        };
        let selector: Sel = sel!(isDeviceConfiguredForPasskeys);
        let responds: Bool = unsafe { msg_send![class, respondsToSelector: selector] };
        if !responds.as_bool() {
            return true;
        }
        let configured: Bool = unsafe { msg_send![class, isDeviceConfiguredForPasskeys] };
        configured.as_bool()
    }

    fn manager() -> Option<objc2::rc::Retained<AnyObject>> {
        let class = manager_class()?;
        unsafe { msg_send![class, new] }
    }

    pub fn access() -> PasskeyAccess {
        if !entitled() {
            return PasskeyAccess::default();
        }
        let state: isize = match manager() {
            Some(manager) => unsafe {
                msg_send![&*manager, authorizationStateForPlatformCredentials]
            },
            None => 2,
        };
        PasskeyAccess {
            entitled: true,
            status: status_of(device_configured(), state),
        }
    }

    pub fn request(done: impl FnOnce() + Send + 'static) {
        if !entitled() || !device_configured() {
            done();
            return;
        }
        let Some(manager) = manager() else {
            done();
            return;
        };
        let slot = std::sync::Mutex::new(Some(done));
        let reply = block2::RcBlock::new(move |_state: isize| {
            if let Some(done) = slot.lock().ok().and_then(|mut slot| slot.take()) {
                done();
            }
        });
        unsafe {
            let _: () = msg_send![&*manager, requestAuthorizationForPublicKeyCredentials: &*reply];
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use super::*;

    pub fn entitled() -> bool {
        false
    }

    pub fn access() -> PasskeyAccess {
        PasskeyAccess::default()
    }

    pub fn request(done: impl FnOnce() + Send + 'static) {
        done();
    }
}

pub use mac::{access, entitled};

impl AppCoordinator {
    pub fn webkit_passkey_access_now(&self) -> PasskeyAccess {
        if self.offers_webkit() {
            access()
        } else {
            PasskeyAccess::default()
        }
    }

    pub fn passkey_request_pending(&self) -> bool {
        REQUESTING.load(Ordering::Acquire)
    }

    pub fn request_passkey_access(&self) {
        if !self.offers_webkit() || REQUESTING.swap(true, Ordering::AcqRel) {
            return;
        }
        self.mark_dirty();
        let me = self.weak();
        mac::request(move || {
            REQUESTING.store(false, Ordering::Release);
            if let Some(coordinator) = me.upgrade() {
                coordinator.post(|c| {
                    c.mark_dirty();
                    c.signal.emit(ardia_ui::host_data::HostTopics::ALL);
                });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_follow_the_old_mapping() {
        assert_eq!(status_of(false, 0), PasskeyStatus::DeviceNotConfigured);
        assert_eq!(status_of(true, 0), PasskeyStatus::Authorized);
        assert_eq!(status_of(true, 1), PasskeyStatus::Denied);
        assert_eq!(status_of(true, 2), PasskeyStatus::NotDetermined);
        assert_eq!(status_of(true, 9), PasskeyStatus::NotDetermined);
    }
}
