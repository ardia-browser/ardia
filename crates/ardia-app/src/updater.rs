use std::cell::RefCell;

use ardia_ui::host::{SwitchPhase, UpdateChannel, UpdaterReport, UpdaterState};

pub const CHANNEL_DEFAULTS_KEY: &str = "ACUpdateChannel";
pub const NOT_SET_UP_TITLE: &str = "Updates aren't set up for this build";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SwitchCheck {
    phase: Option<SwitchPhase>,
    channel: Option<UpdateChannel>,
    version: Option<String>,
    user_asked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwitchEvent {
    Switched(UpdateChannel),
    Started,
    Found(String),
    NotFound { newer_than_latest: bool },
    Finished { failed: bool },
    ManualCheck,
}

impl SwitchCheck {
    pub fn pending(&self) -> bool {
        matches!(
            self.phase,
            Some(SwitchPhase::Waiting | SwitchPhase::Checking)
        )
    }

    pub fn user_asked(&self) -> bool {
        self.user_asked
    }

    pub fn handle(&mut self, event: SwitchEvent) {
        match event {
            SwitchEvent::Switched(channel) => {
                *self = SwitchCheck {
                    phase: Some(SwitchPhase::Waiting),
                    channel: Some(channel),
                    ..SwitchCheck::default()
                };
            }
            SwitchEvent::Started => {
                if self.phase == Some(SwitchPhase::Waiting) {
                    self.phase = Some(SwitchPhase::Checking);
                }
            }
            SwitchEvent::Found(version) => {
                if self.phase == Some(SwitchPhase::Checking) {
                    self.phase = Some(SwitchPhase::Found);
                    self.version = Some(version);
                }
            }
            SwitchEvent::NotFound { newer_than_latest } => {
                if self.phase == Some(SwitchPhase::Checking) {
                    self.phase = Some(if newer_than_latest {
                        SwitchPhase::NewerThanLatest
                    } else {
                        SwitchPhase::UpToDate
                    });
                }
            }
            SwitchEvent::Finished { failed } => {
                if self.phase == Some(SwitchPhase::Checking) {
                    self.phase = failed.then_some(SwitchPhase::Failed);
                }
            }
            SwitchEvent::ManualCheck => {
                if self.pending() {
                    self.user_asked = true;
                } else {
                    *self = SwitchCheck::default();
                }
            }
        }
    }

    pub fn report(&self) -> Option<UpdaterReport> {
        Some(UpdaterReport {
            phase: self.phase?,
            channel: self.channel?,
            version: self.version.clone(),
        })
    }
}

pub fn display_version(version: &str) -> String {
    let Some(at) = version.rfind("-nightly.") else {
        return version.to_owned();
    };
    let number = &version[at + "-nightly.".len()..];
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return version.to_owned();
    }
    format!("{} Nightly {number}", &version[..at])
}

pub fn channel_named(name: &str) -> Option<UpdateChannel> {
    match name {
        "stable" => Some(UpdateChannel::Stable),
        "nightly" => Some(UpdateChannel::Nightly),
        _ => None,
    }
}

pub fn channel_name(channel: UpdateChannel) -> &'static str {
    match channel {
        UpdateChannel::Stable => "stable",
        UpdateChannel::Nightly => "nightly",
    }
}

pub fn feed_configured(feed: &str, key: &str) -> bool {
    let feed = feed.trim();
    let scheme = feed
        .split_once("://")
        .map(|(scheme, _)| scheme.to_ascii_lowercase());
    matches!(scheme.as_deref(), Some("https" | "http")) && !key.trim().is_empty()
}

pub struct Updater {
    isolated: bool,
    background: bool,
    switch: SwitchCheck,
    sparkle: Option<platform::Sparkle>,
}

thread_local! {
    static UPDATER: RefCell<Option<Updater>> = const { RefCell::new(None) };
    static NOTED: RefCell<Vec<SwitchEvent>> = const { RefCell::new(Vec::new()) };
    static CHANNEL: std::cell::Cell<UpdateChannel> = const { std::cell::Cell::new(UpdateChannel::Stable) };
}

pub fn with<T>(isolated: bool, background: bool, run: impl FnOnce(&mut Updater) -> T) -> T {
    UPDATER.with(|cell| {
        let mut cell = cell.borrow_mut();
        let updater = cell.get_or_insert_with(|| Updater::new(isolated, background));
        for event in NOTED.with(|noted| std::mem::take(&mut *noted.borrow_mut())) {
            updater.switch.handle(event);
        }
        CHANNEL.with(|current| current.set(updater.channel()));
        let result = run(updater);
        CHANNEL.with(|current| current.set(updater.channel()));
        result
    })
}

pub fn note_later(event: SwitchEvent) {
    NOTED.with(|noted| noted.borrow_mut().push(event));
}

pub fn current_channel() -> UpdateChannel {
    CHANNEL.with(|current| current.get())
}

impl Updater {
    fn new(isolated: bool, background: bool) -> Self {
        let mut updater = Updater {
            isolated,
            background,
            switch: SwitchCheck::default(),
            sparkle: None,
        };
        updater.remember_channel();
        if updater.configured_by_bundle() {
            updater.sparkle = platform::Sparkle::start();
        }
        updater
    }

    fn feed_override() -> Option<String> {
        std::env::var("ARDIA_UPDATE_FEED")
            .ok()
            .filter(|feed| !feed.is_empty())
    }

    fn configured_by_bundle(&self) -> bool {
        if self.isolated && Self::feed_override().is_none() {
            return false;
        }
        let feed = Self::feed_override()
            .or_else(|| platform::info_string("SUFeedURL"))
            .unwrap_or_default();
        let key = platform::info_string("SUPublicEDKey").unwrap_or_default();
        feed_configured(&feed, &key)
    }

    pub fn configured(&self) -> bool {
        self.sparkle.is_some() && self.configured_by_bundle()
    }

    pub fn build_channel() -> UpdateChannel {
        match platform::info_string(CHANNEL_DEFAULTS_KEY).as_deref() {
            Some("nightly") => UpdateChannel::Nightly,
            _ => UpdateChannel::Stable,
        }
    }

    pub fn channel(&self) -> UpdateChannel {
        platform::default_string(CHANNEL_DEFAULTS_KEY)
            .as_deref()
            .and_then(channel_named)
            .unwrap_or_else(Self::build_channel)
    }

    fn remember_channel(&self) {
        if platform::default_string(CHANNEL_DEFAULTS_KEY).is_none() {
            platform::set_default_string(CHANNEL_DEFAULTS_KEY, channel_name(Self::build_channel()));
        }
    }

    pub fn state(&self) -> UpdaterState {
        let version = platform::info_string("CFBundleShortVersionString").unwrap_or_default();
        let sparkle = self.sparkle.as_ref();
        UpdaterState {
            configured: self.configured(),
            automatic_checks: sparkle.map_or_else(
                || platform::default_bool("SUEnableAutomaticChecks"),
                platform::Sparkle::automatic_checks,
            ),
            automatic_downloads: sparkle.map_or_else(
                || platform::default_bool("SUAutomaticallyUpdate"),
                platform::Sparkle::automatic_downloads,
            ),
            can_check: sparkle.is_none_or(platform::Sparkle::can_check),
            session_in_progress: sparkle.is_some_and(platform::Sparkle::session_in_progress),
            last_check_ms: sparkle.and_then(platform::Sparkle::last_check_ms),
            display_version: display_version(&version),
            version,
            channel: self.channel(),
            switch_check: self.switch.report(),
        }
    }

    pub fn set_automatic(&mut self, on: bool) {
        match &self.sparkle {
            Some(sparkle) => sparkle.set_automatic(on),
            None => {
                platform::set_default_bool("SUEnableAutomaticChecks", on);
                platform::set_default_bool("SUAutomaticallyUpdate", on);
            }
        }
    }

    pub fn set_channel(&mut self, channel: UpdateChannel) {
        let switched = channel != self.channel();
        platform::set_default_string(CHANNEL_DEFAULTS_KEY, channel_name(channel));
        if !switched {
            return;
        }
        let Some(sparkle) = &self.sparkle else {
            return;
        };
        self.switch.handle(SwitchEvent::Switched(channel));
        if sparkle.session_in_progress() {
            return;
        }
        self.switch.handle(SwitchEvent::Started);
        if sparkle.can_check() {
            sparkle.check();
        } else {
            log::info!(
                "Sparkle can't check the {} channel after the switch yet",
                channel_name(channel)
            );
            self.switch.handle(SwitchEvent::Finished { failed: true });
        }
    }

    pub fn check_now(&mut self) {
        if !self.configured() {
            if self.background {
                log::info!("update checks are off in this instance");
            } else {
                platform::show_not_set_up();
            }
            return;
        }
        let pending = self.switch.pending();
        self.switch.handle(SwitchEvent::ManualCheck);
        if pending {
            return;
        }
        if let Some(sparkle) = &self.sparkle {
            sparkle.check();
        }
    }
}

pub fn allowed_channels(channel: UpdateChannel) -> &'static [&'static str] {
    match channel {
        UpdateChannel::Nightly => &["nightly"],
        UpdateChannel::Stable => &[],
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, NSObject};
    use objc2::{AnyThread, class, define_class, msg_send};
    use objc2_foundation::{NSError, NSSet, NSString};

    use super::{SwitchEvent, allowed_channels, current_channel, display_version, note_later};

    fn defaults() -> Option<Retained<AnyObject>> {
        unsafe { msg_send![class!(NSUserDefaults), standardUserDefaults] }
    }

    pub fn info_string(key: &str) -> Option<String> {
        let bundle: Option<Retained<AnyObject>> =
            unsafe { msg_send![class!(NSBundle), mainBundle] };
        let bundle = bundle?;
        let key = NSString::from_str(key);
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

    pub fn default_string(key: &str) -> Option<String> {
        let defaults = defaults()?;
        let key = NSString::from_str(key);
        let value: Option<Retained<NSString>> =
            unsafe { msg_send![&*defaults, stringForKey: &*key] };
        value.map(|value| value.to_string())
    }

    pub fn set_default_string(key: &str, value: &str) {
        let Some(defaults) = defaults() else {
            return;
        };
        let key = NSString::from_str(key);
        let value = NSString::from_str(value);
        let _: () = unsafe { msg_send![&*defaults, setObject: &*value, forKey: &*key] };
    }

    pub fn default_bool(key: &str) -> bool {
        let Some(defaults) = defaults() else {
            return false;
        };
        let key = NSString::from_str(key);
        let on: Bool = unsafe { msg_send![&*defaults, boolForKey: &*key] };
        on.as_bool()
    }

    pub fn set_default_bool(key: &str, on: bool) {
        let Some(defaults) = defaults() else {
            return;
        };
        let key = NSString::from_str(key);
        let _: () = unsafe { msg_send![&*defaults, setBool: Bool::new(on), forKey: &*key] };
    }

    pub fn show_not_set_up() {
        let alert: Option<Retained<AnyObject>> = unsafe { msg_send![class!(NSAlert), new] };
        let Some(alert) = alert else {
            return;
        };
        let name: Retained<NSString> = unsafe {
            let info: Retained<AnyObject> = msg_send![class!(NSProcessInfo), processInfo];
            msg_send![&*info, processName]
        };
        let title = NSString::from_str(super::NOT_SET_UP_TITLE);
        let detail = NSString::from_str(&format!(
            "This copy of {name} doesn't have an update feed, so it can't check for new versions. Get newer versions from wherever you got this one."
        ));
        let ok = NSString::from_str("OK");
        unsafe {
            let _: () = msg_send![&*alert, setMessageText: &*title];
            let _: () = msg_send![&*alert, setInformativeText: &*detail];
            let _: Option<Retained<AnyObject>> = msg_send![&*alert, addButtonWithTitle: &*ok];
            let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
            let key: Option<Retained<AnyObject>> = msg_send![&*app, keyWindow];
            let sheet: Option<Retained<AnyObject>> = match &key {
                Some(window) => msg_send![&**window, attachedSheet],
                None => None,
            };
            match (key, sheet) {
                (Some(window), None) => {
                    let _: () = msg_send![&*alert, beginSheetModalForWindow: &*window, completionHandler: std::ptr::null::<AnyObject>()];
                }
                _ => {
                    let _: isize = msg_send![&*alert, runModal];
                }
            }
        }
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "ArdiaGpuiUpdaterDelegate"]
        struct UpdaterDelegate;

        impl UpdaterDelegate {
            #[unsafe(method_id(allowedChannelsForUpdater:))]
            fn allowed(&self, _updater: &AnyObject) -> Retained<NSSet<NSString>> {
                let channel = current_channel();
                let names: Vec<Retained<NSString>> = allowed_channels(channel)
                    .iter()
                    .map(|name| NSString::from_str(name))
                    .collect();
                NSSet::from_retained_slice(&names)
            }

            #[unsafe(method(updater:didFindValidUpdate:))]
            fn found(&self, _updater: &AnyObject, item: &AnyObject) {
                let shown: Option<Retained<NSString>> = unsafe { msg_send![item, displayVersionString] };
                let version = shown.map(|v| display_version(&v.to_string())).unwrap_or_default();
                note_later(SwitchEvent::Found(version));
            }

            #[unsafe(method(updaterDidNotFindUpdate:error:))]
            fn not_found(&self, _updater: &AnyObject, error: &NSError) {
                let reason_key = NSString::from_str("SPUNoUpdateFoundReason");
                let info = error.userInfo();
                let reason: Option<Retained<AnyObject>> = info.objectForKey(&reason_key);
                let code: i32 = reason
                    .map(|number| unsafe { msg_send![&*number, intValue] })
                    .unwrap_or(0);
                note_later(SwitchEvent::NotFound { newer_than_latest: code == 2 });
            }

            #[unsafe(method(updater:didFinishUpdateCycleForUpdateCheck:error:))]
            fn finished(&self, _updater: &AnyObject, _check: isize, error: Option<&NSError>) {
                let failed = error.is_some_and(|error| {
                    !(error.domain().to_string() == "SUSparkleErrorDomain" && error.code() == 1001)
                });
                note_later(SwitchEvent::Finished { failed });
            }
        }
    );

    pub struct Sparkle {
        updater: Retained<AnyObject>,
        _controller: Retained<AnyObject>,
        _delegate: Retained<UpdaterDelegate>,
    }

    impl Sparkle {
        pub fn start() -> Option<Sparkle> {
            let bundle: Option<Retained<AnyObject>> =
                unsafe { msg_send![class!(NSBundle), mainBundle] };
            let frameworks: Option<Retained<NSString>> =
                unsafe { msg_send![&*bundle?, privateFrameworksPath] };
            let path = NSString::from_str(&format!("{}/Sparkle.framework", frameworks?));
            let sparkle: Option<Retained<AnyObject>> =
                unsafe { msg_send![class!(NSBundle), bundleWithPath: &*path] };
            let sparkle = sparkle?;
            let loaded: Bool = unsafe { msg_send![&*sparkle, load] };
            if !loaded.as_bool() {
                return None;
            }
            let controller_class = AnyClass::get(c"SPUStandardUpdaterController")?;
            let delegate: Retained<UpdaterDelegate> =
                unsafe { msg_send![UpdaterDelegate::alloc(), init] };
            let controller: Option<Retained<AnyObject>> = unsafe {
                let made: *mut AnyObject = msg_send![controller_class, alloc];
                Retained::from_raw(
                    msg_send![made, initWithStartingUpdater: Bool::YES, updaterDelegate: &*delegate, userDriverDelegate: std::ptr::null::<AnyObject>()],
                )
            };
            let controller = controller?;
            let updater: Option<Retained<AnyObject>> = unsafe { msg_send![&*controller, updater] };
            Some(Sparkle {
                updater: updater?,
                _controller: controller,
                _delegate: delegate,
            })
        }

        pub fn automatic_checks(&self) -> bool {
            let on: Bool = unsafe { msg_send![&*self.updater, automaticallyChecksForUpdates] };
            on.as_bool()
        }

        pub fn automatic_downloads(&self) -> bool {
            let on: Bool = unsafe { msg_send![&*self.updater, automaticallyDownloadsUpdates] };
            on.as_bool()
        }

        pub fn set_automatic(&self, on: bool) {
            unsafe {
                let _: () =
                    msg_send![&*self.updater, setAutomaticallyChecksForUpdates: Bool::new(on)];
                let _: () =
                    msg_send![&*self.updater, setAutomaticallyDownloadsUpdates: Bool::new(on)];
            }
        }

        pub fn can_check(&self) -> bool {
            let on: Bool = unsafe { msg_send![&*self.updater, canCheckForUpdates] };
            on.as_bool()
        }

        pub fn session_in_progress(&self) -> bool {
            let on: Bool = unsafe { msg_send![&*self.updater, sessionInProgress] };
            on.as_bool()
        }

        pub fn last_check_ms(&self) -> Option<f64> {
            let date: Option<Retained<AnyObject>> =
                unsafe { msg_send![&*self.updater, lastUpdateCheckDate] };
            let seconds: f64 = unsafe { msg_send![&*date?, timeIntervalSince1970] };
            Some(seconds * 1000.0)
        }

        pub fn check(&self) {
            let _: () = unsafe { msg_send![&*self.updater, checkForUpdates] };
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn info_string(_key: &str) -> Option<String> {
        None
    }
    pub fn default_string(_key: &str) -> Option<String> {
        None
    }
    pub fn set_default_string(_key: &str, _value: &str) {}
    pub fn default_bool(_key: &str) -> bool {
        false
    }
    pub fn set_default_bool(_key: &str, _on: bool) {}
    pub fn show_not_set_up() {}

    pub struct Sparkle;

    impl Sparkle {
        pub fn start() -> Option<Sparkle> {
            None
        }
        pub fn automatic_checks(&self) -> bool {
            false
        }
        pub fn automatic_downloads(&self) -> bool {
            false
        }
        pub fn set_automatic(&self, _on: bool) {}
        pub fn can_check(&self) -> bool {
            true
        }
        pub fn session_in_progress(&self) -> bool {
            false
        }
        pub fn last_check_ms(&self) -> Option<f64> {
            None
        }
        pub fn check(&self) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_check_follows_the_old_state_machine() {
        let mut check = SwitchCheck::default();
        assert_eq!(check.report(), None);
        check.handle(SwitchEvent::Started);
        assert_eq!(check.report(), None);
        check.handle(SwitchEvent::Switched(UpdateChannel::Nightly));
        assert_eq!(check.report().map(|r| r.phase), Some(SwitchPhase::Waiting));
        assert!(check.pending());
        check.handle(SwitchEvent::Found("1".into()));
        assert_eq!(check.report().map(|r| r.phase), Some(SwitchPhase::Waiting));
        check.handle(SwitchEvent::Started);
        check.handle(SwitchEvent::ManualCheck);
        assert!(check.user_asked());
        assert_eq!(check.report().map(|r| r.phase), Some(SwitchPhase::Checking));
        check.handle(SwitchEvent::Found("0.3 Nightly 2".into()));
        let report = check.report().expect("report");
        assert_eq!(report.phase, SwitchPhase::Found);
        assert_eq!(report.channel, UpdateChannel::Nightly);
        assert_eq!(report.version.as_deref(), Some("0.3 Nightly 2"));
        check.handle(SwitchEvent::Finished { failed: true });
        assert_eq!(check.report().map(|r| r.phase), Some(SwitchPhase::Found));
        check.handle(SwitchEvent::ManualCheck);
        assert_eq!(check.report(), None);
    }

    #[test]
    fn switch_check_reports_newer_than_latest_and_failures() {
        let mut check = SwitchCheck::default();
        check.handle(SwitchEvent::Switched(UpdateChannel::Stable));
        check.handle(SwitchEvent::Started);
        check.handle(SwitchEvent::NotFound {
            newer_than_latest: true,
        });
        assert_eq!(
            check.report().map(|r| r.phase),
            Some(SwitchPhase::NewerThanLatest)
        );
        let mut failing = SwitchCheck::default();
        failing.handle(SwitchEvent::Switched(UpdateChannel::Stable));
        failing.handle(SwitchEvent::Started);
        failing.handle(SwitchEvent::Finished { failed: true });
        assert_eq!(failing.report().map(|r| r.phase), Some(SwitchPhase::Failed));
        let mut quiet = SwitchCheck::default();
        quiet.handle(SwitchEvent::Switched(UpdateChannel::Stable));
        quiet.handle(SwitchEvent::Started);
        quiet.handle(SwitchEvent::Finished { failed: false });
        assert_eq!(quiet.report(), None);
    }

    #[test]
    fn display_versions_read_like_the_old_about_box() {
        assert_eq!(display_version("0.2.49-nightly.1"), "0.2.49 Nightly 1");
        assert_eq!(display_version("0.2.49"), "0.2.49");
        assert_eq!(display_version("0.2.49-nightly."), "0.2.49-nightly.");
        assert_eq!(display_version("0.2.49-nightly.x"), "0.2.49-nightly.x");
    }

    #[test]
    fn feeds_need_a_web_url_and_a_key() {
        assert!(feed_configured("https://ardia.dev/appcast.xml", "key"));
        assert!(feed_configured(" http://x/appcast.xml ", "key"));
        assert!(!feed_configured("https://ardia.dev/appcast.xml", " "));
        assert!(!feed_configured("file:///appcast.xml", "key"));
        assert!(!feed_configured("", "key"));
        assert_eq!(allowed_channels(UpdateChannel::Nightly), &["nightly"]);
        assert!(allowed_channels(UpdateChannel::Stable).is_empty());
        assert_eq!(channel_named("nightly"), Some(UpdateChannel::Nightly));
        assert_eq!(channel_name(UpdateChannel::Stable), "stable");
    }
}
