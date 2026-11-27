use std::sync::atomic::{AtomicBool, Ordering};

use ardia_state::WindowId;

use crate::coordinator::AppCoordinator;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemAccess {
    Granted,
    NotDetermined,
    Denied,
    Restricted,
    ServicesOff,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NextStep {
    Nothing,
    AskSystem,
    PointToSettings,
}

pub fn next_step(access: SystemAccess, told_before: bool) -> NextStep {
    match access {
        SystemAccess::Granted => NextStep::Nothing,
        SystemAccess::NotDetermined => NextStep::AskSystem,
        _ if told_before => NextStep::Nothing,
        _ => NextStep::PointToSettings,
    }
}

pub struct SettingsNotice {
    pub title: &'static str,
    pub message: &'static str,
    pub settings_url: String,
}

pub fn location_notice(access: SystemAccess) -> SettingsNotice {
    if access == SystemAccess::ServicesOff {
        SettingsNotice {
            title: "Location Services Are Off",
            message: "Turn on Location Services in System Settings so websites you allow can use your location.",
            settings_url: LOCATION_SETTINGS.to_owned(),
        }
    } else {
        SettingsNotice {
            title: "Ardia Needs Location Permission",
            message: "You need to open System Settings to give Ardia permission to use your location.",
            settings_url: LOCATION_SETTINGS.to_owned(),
        }
    }
}

pub fn notifications_notice(bundle_id: &str) -> SettingsNotice {
    SettingsNotice {
        title: "Ardia Needs Notifications Permission",
        message: "You need to open System Settings to give Ardia permission to show you Notifications.",
        settings_url: format!(
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={bundle_id}"
        ),
    }
}

const LOCATION_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices";

static TOLD_ABOUT_LOCATION: AtomicBool = AtomicBool::new(false);
static TOLD_ABOUT_NOTIFICATIONS: AtomicBool = AtomicBool::new(false);

impl AppCoordinator {
    pub(crate) fn ensure_location_permission(&self, window: Option<WindowId>) {
        if crate::screen_capture::background() {
            return;
        }
        let access = system::location_access();
        match next_step(access, TOLD_ABOUT_LOCATION.load(Ordering::Acquire)) {
            NextStep::Nothing => {}
            NextStep::AskSystem => system::ask_for_location(),
            NextStep::PointToSettings => {
                TOLD_ABOUT_LOCATION.store(true, Ordering::Release);
                self.point_to_settings(window, location_notice(access));
            }
        }
    }

    pub(crate) fn ensure_notification_permission(&self, window: Option<WindowId>) {
        if crate::screen_capture::background() {
            return;
        }
        let me = self.weak();
        system::notification_access(move |access| {
            let Some(me) = me.upgrade() else {
                return;
            };
            let window = window.clone();
            me.post(move |c| {
                match next_step(access, TOLD_ABOUT_NOTIFICATIONS.load(Ordering::Acquire)) {
                    NextStep::Nothing => {}
                    NextStep::AskSystem => system::ask_for_notifications(),
                    NextStep::PointToSettings => {
                        TOLD_ABOUT_NOTIFICATIONS.store(true, Ordering::Release);
                        c.point_to_settings(window, notifications_notice(&system::bundle_id()));
                    }
                }
            });
        });
    }

    #[cfg(target_os = "macos")]
    fn point_to_settings(&self, window: Option<WindowId>, notice: SettingsNotice) {
        use ardia_engine::macos::dialogs::Alert;
        let alert = Alert::confirm(
            notice.title,
            notice.message,
            "Open System Settings",
            "Not Now",
        );
        let parent = window
            .filter(|_| self.config.hosts_native_windows)
            .and_then(|window| self.engine_window(&window))
            .and_then(|engine_window| {
                self.engine()
                    .and_then(|engine| engine.native_window_handle(engine_window).ok())
            });
        let shown = alert.show(parent.as_ref());
        let url = notice.settings_url;
        self.spawn(async move {
            if shown.await.is_ok_and(|choice| choice.chose(0)) {
                let _ = std::process::Command::new("/usr/bin/open")
                    .arg(&url)
                    .spawn();
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    fn point_to_settings(&self, _window: Option<WindowId>, notice: SettingsNotice) {
        log::info!("{}", notice.title);
    }
}

#[cfg(target_os = "macos")]
mod system {
    use std::cell::RefCell;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{MainThreadMarker, class, msg_send};

    use super::SystemAccess;

    #[link(name = "CoreLocation", kind = "framework")]
    unsafe extern "C" {}

    #[link(name = "UserNotifications", kind = "framework")]
    unsafe extern "C" {}

    thread_local! {
        static MANAGER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    fn with_manager<T>(use_it: impl FnOnce(&AnyObject) -> T) -> Option<T> {
        MainThreadMarker::new()?;
        MANAGER.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                *slot = unsafe { msg_send![class!(CLLocationManager), new] };
            }
            slot.as_deref().map(use_it)
        })
    }

    pub fn location_access() -> SystemAccess {
        let enabled: Bool =
            unsafe { msg_send![class!(CLLocationManager), locationServicesEnabled] };
        if !enabled.as_bool() {
            return SystemAccess::ServicesOff;
        }
        let status = with_manager(|manager| {
            let status: i32 = unsafe { msg_send![manager, authorizationStatus] };
            status
        });
        match status {
            Some(0) | None => SystemAccess::NotDetermined,
            Some(1) => SystemAccess::Restricted,
            Some(2) => SystemAccess::Denied,
            Some(_) => SystemAccess::Granted,
        }
    }

    pub fn ask_for_location() {
        with_manager(|manager| {
            let _: () = unsafe { msg_send![manager, requestWhenInUseAuthorization] };
        });
    }

    pub fn bundle_id() -> String {
        let bundle: Option<Retained<AnyObject>> =
            unsafe { msg_send![class!(NSBundle), mainBundle] };
        let id: Option<Retained<objc2_foundation::NSString>> =
            bundle.and_then(|bundle| unsafe { msg_send![&*bundle, bundleIdentifier] });
        id.map(|id| id.to_string()).unwrap_or_default()
    }

    fn center() -> Option<Retained<AnyObject>> {
        if bundle_id().is_empty()
            || objc2::runtime::AnyClass::get(c"UNUserNotificationCenter").is_none()
        {
            return None;
        }
        unsafe { msg_send![class!(UNUserNotificationCenter), currentNotificationCenter] }
    }

    pub fn notification_access(done: impl Fn(SystemAccess) + Send + Sync + 'static) {
        let Some(center) = center() else {
            done(SystemAccess::Granted);
            return;
        };
        let block = RcBlock::new(move |settings: *mut AnyObject| {
            let status: isize = if settings.is_null() {
                0
            } else {
                unsafe { msg_send![settings, authorizationStatus] }
            };
            done(match status {
                0 => SystemAccess::NotDetermined,
                1 => SystemAccess::Denied,
                _ => SystemAccess::Granted,
            });
        });
        let _: () =
            unsafe { msg_send![&*center, getNotificationSettingsWithCompletionHandler: &*block] };
    }

    pub fn ask_for_notifications() {
        let Some(center) = center() else {
            return;
        };
        let answered = RcBlock::new(|_granted: Bool, _error: *mut AnyObject| {});
        let _: () = unsafe {
            msg_send![&*center, requestAuthorizationWithOptions: (1usize << 1) | (1usize << 2), completionHandler: &*answered]
        };
    }
}

#[cfg(not(target_os = "macos"))]
mod system {
    use super::SystemAccess;

    pub fn location_access() -> SystemAccess {
        SystemAccess::Granted
    }

    pub fn ask_for_location() {}

    pub fn notification_access(done: impl Fn(SystemAccess) + Send + Sync + 'static) {
        done(SystemAccess::Granted);
    }

    pub fn ask_for_notifications() {}

    pub fn bundle_id() -> String {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_is_asked_once_then_settings_are_offered_once_like_the_old_app() {
        assert_eq!(next_step(SystemAccess::Granted, false), NextStep::Nothing);
        assert_eq!(
            next_step(SystemAccess::NotDetermined, true),
            NextStep::AskSystem
        );
        assert_eq!(
            next_step(SystemAccess::Denied, false),
            NextStep::PointToSettings
        );
        assert_eq!(next_step(SystemAccess::Denied, true), NextStep::Nothing);
        assert_eq!(
            location_notice(SystemAccess::ServicesOff).title,
            "Location Services Are Off"
        );
        assert_eq!(
            location_notice(SystemAccess::Denied).title,
            "Ardia Needs Location Permission"
        );
    }
}
