use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use ardia_state::{Action, BrowserStore, NewTab, WindowId};
use ardia_ui::live::{
    CalendarAccess, CalendarCommand, CalendarEvent, CalendarView, SystemCalendar, due_alerts,
    join_link, related_links, request_failure,
};
use parking_lot::Mutex;
use serde_json::Value;

use crate::live::{LiveHub, now_ms};

pub const HORIZON_MS: i64 = 36 * 3_600_000;
pub const REFRESH_EVERY: Duration = Duration::from_secs(5 * 60);
pub const ALERT_EVERY: Duration = Duration::from_secs(10);
pub const FIXTURE_DOC: &str = "calendar-fixture.json";
pub const MEETING_FALLBACK_TITLE: &str = "Meeting";
pub const CLEANUP_IDLE_MS: i64 = 30 * 60_000;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccessRequest {
    pub granted: bool,
    pub error: Option<String>,
    pub responsible_other: bool,
}

pub trait CalendarSource: Send + Sync {
    fn access(&self) -> CalendarAccess;
    fn request_access(&self, done: Box<dyn FnOnce(AccessRequest) + Send>);
    fn calendars(&self) -> Vec<SystemCalendar>;
    fn events(&self, start: i64, end: i64, calendars: &[String]) -> Vec<CalendarEvent>;
    fn on_change(&self, changed: Arc<dyn Fn() + Send + Sync>);
}

pub struct FixtureSource {
    path: PathBuf,
    launched_at: i64,
}

impl FixtureSource {
    pub fn new(path: PathBuf, launched_at: i64) -> FixtureSource {
        FixtureSource { path, launched_at }
    }

    fn raw(&self) -> Value {
        std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| serde_json::json!({"calendars": [], "events": []}))
    }
}

impl CalendarSource for FixtureSource {
    fn access(&self) -> CalendarAccess {
        CalendarAccess::Fixture
    }

    fn request_access(&self, done: Box<dyn FnOnce(AccessRequest) + Send>) {
        done(AccessRequest {
            granted: true,
            ..AccessRequest::default()
        });
    }

    fn calendars(&self) -> Vec<SystemCalendar> {
        serde_json::from_value(self.raw()["calendars"].clone()).unwrap_or_default()
    }

    fn events(&self, _start: i64, _end: i64, calendars: &[String]) -> Vec<CalendarEvent> {
        let base = self.launched_at.div_euclid(60_000) * 60_000;
        self.raw()["events"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| {
                let mut event: CalendarEvent = serde_json::from_value(e.clone()).ok()?;
                let start = base + e.get("startInMinutes")?.as_i64()? * 60_000;
                event.start = start;
                event.end = start + e.get("durationMinutes")?.as_i64()? * 60_000;
                event.occurrence = format!("{}@{start}", event.id);
                calendars.contains(&event.calendar_id).then_some(event)
            })
            .collect()
    }

    fn on_change(&self, _changed: Arc<dyn Fn() + Send + Sync>) {}
}

pub fn notification_text(event: &CalendarEvent, now: i64) -> (String, String) {
    let when = ardia_ui::live::relative_time(event.start, now);
    let lead = if when == "Now" {
        "Starting now".to_owned()
    } else if event.start < now {
        format!("Started {when}")
    } else {
        format!("Starts {when}")
    };
    let link = join_link(event)
        .map(|(_, provider)| format!(" · {}", ardia_ui::live::join_title(Some(provider))))
        .unwrap_or_default();
    (
        ardia_ui::live::alert_title(event).to_owned(),
        format!("{lead}{link}"),
    )
}

pub struct CalendarHub {
    source: Arc<dyn CalendarSource>,
    view: Mutex<Arc<CalendarView>>,
    live: Arc<LiveHub>,
    store: Option<Arc<BrowserStore>>,
    notify: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
    app_active: Mutex<bool>,
    notifier: Arc<dyn crate::notifications::Notifier>,
    notified: Mutex<std::collections::HashSet<String>>,
}

fn start_of_today(now: i64) -> i64 {
    let offset = local_offset_ms(now);
    (now + offset).div_euclid(86_400_000) * 86_400_000 - offset
}

#[cfg(unix)]
fn local_offset_ms(now: i64) -> i64 {
    let seconds = (now / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let filled = unsafe { libc::localtime_r(&seconds, &mut tm) };
    if filled.is_null() {
        0
    } else {
        tm.tm_gmtoff * 1000
    }
}

#[cfg(not(unix))]
fn local_offset_ms(_now: i64) -> i64 {
    0
}

impl CalendarHub {
    pub fn new(
        source: Arc<dyn CalendarSource>,
        live: Arc<LiveHub>,
        store: Option<Arc<BrowserStore>>,
        notifier: Arc<dyn crate::notifications::Notifier>,
    ) -> Arc<CalendarHub> {
        Arc::new(CalendarHub {
            source,
            view: Mutex::new(Arc::new(CalendarView::default())),
            live,
            store,
            notify: Mutex::new(Vec::new()),
            app_active: Mutex::new(true),
            notifier,
            notified: Mutex::new(std::collections::HashSet::new()),
        })
    }

    pub fn view(&self) -> Arc<CalendarView> {
        Arc::clone(&self.view.lock())
    }

    pub fn subscribe(&self, notify: Arc<dyn Fn() + Send + Sync>) {
        self.notify.lock().push(notify);
    }

    fn set(&self, change: impl FnOnce(&mut CalendarView)) {
        {
            let mut view = self.view.lock();
            change(Arc::make_mut(&mut view));
        }
        for listener in self.notify.lock().clone() {
            listener();
        }
    }

    pub fn refresh(&self) {
        let access = self.source.access();
        if !access.connected() {
            self.set(|v| {
                if v.access != access {
                    v.request_error = None;
                }
                v.access = access;
                v.calendars.clear();
                v.events.clear();
                v.error = None;
            });
            self.check_alerts();
            return;
        }
        self.set(|v| v.loading = true);
        let calendars = self.source.calendars();
        let hidden = self.live.snapshot().calendar.hidden_calendar_ids.clone();
        let ids: Vec<String> = calendars
            .iter()
            .filter(|c| !hidden.contains(&c.id))
            .map(|c| c.id.clone())
            .collect();
        let now = now_ms();
        let mut events = if ids.is_empty() {
            Vec::new()
        } else {
            self.source
                .events(start_of_today(now), now + HORIZON_MS, &ids)
        };
        events.sort_by_key(|e| e.start);
        self.set(|v| {
            v.access = access;
            v.calendars = calendars;
            v.events = events;
            v.error = None;
            v.request_error = None;
            v.last_fetch = Some(now);
            v.loading = false;
        });
        self.check_alerts();
    }

    pub fn connect(self: &Arc<Self>) {
        let before = self.source.access();
        if before.connected() {
            self.refresh();
            return;
        }
        self.set(|v| {
            v.requesting = true;
            v.request_error = None;
        });
        let hub = Arc::clone(self);
        let finish = move |request: Option<AccessRequest>| {
            hub.refresh();
            let access = hub.source.access();
            let failure = request_failure(
                access,
                request.as_ref().and_then(|r| r.error.as_deref()),
                request.as_ref().is_some_and(|r| r.responsible_other),
            );
            let open_settings = failure.is_some()
                && request.as_ref().is_none_or(|r| {
                    access == CalendarAccess::NotDetermined && !r.responsible_other
                });
            hub.set(|v| {
                v.requesting = false;
                v.request_error = failure;
            });
            if open_settings {
                open_privacy_settings();
            }
        };
        if before == CalendarAccess::NotDetermined {
            self.source
                .request_access(Box::new(move |request| finish(Some(request))));
        } else {
            finish(None);
        }
    }

    pub fn note_app_active(&self, active: bool) {
        *self.app_active.lock() = active;
    }

    pub fn check_alerts(&self) {
        let live = self.live.snapshot();
        let event = live.calendar.alert_minutes().and_then(|lead| {
            let dismissed = live.dismissed_alerts.iter().cloned().collect();
            due_alerts(&self.view().events, now_ms(), lead, &dismissed)
                .first()
                .map(|e| (*e).clone())
        });
        let current = self.view().alert.as_ref().map(|e| e.occurrence.clone());
        if event.as_ref().map(|e| &e.occurrence) != current.as_ref() {
            self.set(|v| v.alert = event.clone());
        }
        let Some(event) = event else {
            return;
        };
        let always = live.calendar.alert_condition == ardia_state::live::AlertCondition::Always;
        if self.notifier.app_active()
            || !always
            || !self.notified.lock().insert(event.occurrence.clone())
        {
            return;
        }
        let (title, body) = notification_text(&event, now_ms());
        self.notifier
            .post(&format!("meeting:{}", event.occurrence), &title, &body);
    }

    pub fn dismiss(&self, occurrence: &str) {
        self.live.update(true, |s| s.dismiss_alert(occurrence));
        self.notifier.remove(&[format!("meeting:{occurrence}")]);
        self.set(|v| {
            if v.alert.as_ref().is_some_and(|a| a.occurrence == occurrence) {
                v.alert = None;
            }
        });
        self.check_alerts();
    }

    pub fn join(&self, occurrence: &str, open_all: bool, window: Option<WindowId>) {
        let Some(event) = self
            .view()
            .events
            .iter()
            .find(|e| e.occurrence == occurrence)
            .cloned()
        else {
            return;
        };
        let Some((url, _)) = join_link(&event) else {
            return;
        };
        let Some(store) = &self.store else {
            return;
        };
        let state = store.snapshot();
        let window = window.or_else(|| {
            state
                .window_order
                .iter()
                .find(|w| {
                    state
                        .window(w.as_str())
                        .is_some_and(|w| w.kind == ardia_state::windows::WindowKind::Main)
                })
                .cloned()
        });
        let Some(window) = window else {
            return;
        };
        let call = store
            .dispatch(Action::NewTab {
                window: window.clone(),
                tab: NewTab {
                    url: Some(url),
                    ..NewTab::default()
                },
            })
            .ok()
            .and_then(|o| o.tab);
        if open_all && let Some(call) = &call {
            for related in related_links(&event) {
                let _ = store.dispatch(Action::NewTab {
                    window: window.clone(),
                    tab: NewTab {
                        url: Some(related),
                        background: true,
                        opener: Some(call.clone()),
                        ..NewTab::default()
                    },
                });
            }
            let _ = store.dispatch(Action::ActivateTab { tab: call.clone() });
        }
        self.dismiss(occurrence);
    }

    pub fn group_call(
        &self,
        tab_id: &ardia_state::TabId,
        event: Option<&CalendarEvent>,
    ) -> Option<ardia_state::GroupId> {
        let store = self.store.as_ref()?;
        let state = store.snapshot();
        let tab = state.tab(tab_id.as_str())?;
        let (_, key) = ardia_ui::live::meeting_of(&tab.url)?;
        if tab.pin.is_some() {
            return None;
        }
        let live = self.live.snapshot();
        if let Some(group) = state.group_of(tab_id.as_str()) {
            return live
                .meeting_groups
                .contains_key(group.id.as_str())
                .then(|| group.id.clone());
        }
        let found = event.cloned().or_else(|| {
            let events = self.view().events.clone();
            ardia_ui::live::event_for_call(&events, &tab.url, now_ms())
        });
        let same = live.meeting_groups.values().find(|m| {
            let Some(group) = state.group(m.group_id.as_str()) else {
                return false;
            };
            let same_call = state
                .tab(m.call_tab_id.as_str())
                .and_then(|t| ardia_ui::live::meeting_of(&t.url))
                .is_some_and(|(_, k)| k == key);
            group.window_id == tab.window_id
                && m.ended_at.is_none()
                && (m.occurrence.is_some()
                    && m.occurrence == found.as_ref().map(|e| e.occurrence.clone())
                    || same_call)
        });
        if let Some(same) = same {
            let group = ardia_state::GroupId::new(&same.group_id);
            let _ = store.dispatch(Action::AddToGroup {
                group: group.clone(),
                tabs: vec![tab_id.clone()],
            });
            return Some(group);
        }
        let title = found
            .as_ref()
            .map(|e| e.title.clone())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| MEETING_FALLBACK_TITLE.into());
        let group = store
            .dispatch(Action::CreateGroup {
                tabs: vec![tab_id.clone()],
                name: title.clone(),
            })
            .ok()?
            .group?;
        self.live.update(true, |s| {
            s.set_meeting_group(
                Some(ardia_state::live::MeetingGroup {
                    group_id: group.as_str().to_owned(),
                    call_tab_id: tab_id.as_str().to_owned(),
                    occurrence: found.as_ref().map(|e| e.occurrence.clone()),
                    title,
                    start: found.as_ref().map(|e| e.start),
                    end: found.as_ref().map(|e| e.end),
                    ended_at: None,
                }),
                None,
            )
        });
        Some(group)
    }

    pub fn tick_meetings(&self, now: i64) {
        let Some(store) = &self.store else {
            return;
        };
        let state = store.snapshot();
        if state.settings.auto_group_meeting_tabs {
            let calls: Vec<ardia_state::TabId> = state
                .tabs
                .values()
                .filter(|t| {
                    t.pin.is_none()
                        && state.group_of(t.id.as_str()).is_none()
                        && ardia_ui::live::meeting_of(&t.url).is_some()
                })
                .map(|t| t.id.clone())
                .collect();
            for call in calls {
                let known = self
                    .live
                    .snapshot()
                    .meeting_groups
                    .values()
                    .any(|m| m.call_tab_id == call.as_str());
                if !known {
                    self.group_call(&call, None);
                }
            }
        }
        let state = store.snapshot();
        let live = self.live.snapshot();
        for m in live.meeting_groups.values() {
            let Some(group) = state.group(m.group_id.as_str()) else {
                self.live
                    .update(true, |s| s.set_meeting_group(None, Some(&m.group_id)));
                continue;
            };
            if m.ended_at.is_none() {
                let left_call = state
                    .tab(m.call_tab_id.as_str())
                    .is_none_or(|t| ardia_ui::live::meeting_of(&t.url).is_none());
                if m.end.is_some_and(|end| now >= end) || (m.end.is_none() && left_call) {
                    let mut ended = m.clone();
                    ended.ended_at = Some(now);
                    self.live
                        .update(true, |s| s.set_meeting_group(Some(ended), None));
                }
                continue;
            }
            let active = state
                .active_tab(group.window_id.as_str())
                .map(|t| t.id.clone());
            let busy = group.tab_ids.iter().any(|id| {
                Some(id) == active.as_ref()
                    || state.tab(id.as_str()).is_some_and(|t| t.live.audible)
            });
            let last_use = group
                .tab_ids
                .iter()
                .filter_map(|id| state.tab(id.as_str()).map(|t| t.last_active_at))
                .fold(m.ended_at.unwrap_or(0), i64::max);
            if !busy && now - last_use >= CLEANUP_IDLE_MS {
                self.live
                    .update(true, |s| s.set_meeting_group(None, Some(&m.group_id)));
                let _ = store.dispatch(Action::CloseGroup {
                    group: group.id.clone(),
                });
            }
        }
    }

    pub fn command(self: &Arc<Self>, command: CalendarCommand) {
        match command {
            CalendarCommand::Connect => self.connect(),
            CalendarCommand::Refresh => self.refresh(),
            CalendarCommand::SetHidden { calendar, hidden } => {
                self.live.update(true, |s| {
                    s.calendar.hidden_calendar_ids.retain(|c| *c != calendar);
                    if hidden {
                        s.calendar.hidden_calendar_ids.push(calendar);
                    }
                });
                self.refresh();
            }
            CalendarCommand::Join {
                occurrence,
                open_all,
                window,
            } => self.join(&occurrence, open_all, window),
            CalendarCommand::Dismiss { occurrence } => self.dismiss(&occurrence),
            CalendarCommand::OpenPrivacySettings => open_privacy_settings(),
        }
    }

    pub fn start(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        self.source.on_change(Arc::new(move || {
            if let Some(hub) = weak.upgrade() {
                hub.refresh();
            }
        }));
        self.refresh();
        let weak = Arc::downgrade(self);
        let spawned = std::thread::Builder::new()
            .name("ardia-calendar".into())
            .spawn(move || {
                let mut since_refresh = Duration::ZERO;
                loop {
                    std::thread::sleep(ALERT_EVERY);
                    let Some(hub) = weak.upgrade() else {
                        return;
                    };
                    since_refresh += ALERT_EVERY;
                    if since_refresh >= REFRESH_EVERY && hub.view().access.connected() {
                        since_refresh = Duration::ZERO;
                        hub.refresh();
                    } else {
                        hub.check_alerts();
                    }
                    let target = Arc::clone(&hub);
                    hub.live
                        .on_main(Box::new(move |_| target.tick_meetings(now_ms())));
                }
            });
        if let Err(problem) = spawned {
            log::warn!("calendar timers couldn't start: {problem}");
        }
    }
}

pub fn open_privacy_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
            .spawn();
    }
}

#[cfg(target_os = "macos")]
pub mod eventkit {
    use std::ffi::CStr;
    use std::sync::Arc;

    use ardia_ui::live::{CalendarAccess, CalendarEvent, Participant, SystemCalendar};
    use block2::RcBlock;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use parking_lot::Mutex;

    use super::{AccessRequest, CalendarSource};

    #[link(name = "EventKit", kind = "framework")]
    unsafe extern "C" {
        static EKEventStoreChangedNotification: *mut AnyObject;
    }

    struct StorePtr(*mut AnyObject);
    unsafe impl Send for StorePtr {}

    pub struct EventKitSource {
        store: Mutex<StorePtr>,
    }

    unsafe fn text(object: *mut AnyObject) -> String {
        if object.is_null() {
            return String::new();
        }
        let utf8: *const std::ffi::c_char = unsafe { msg_send![object, UTF8String] };
        if utf8.is_null() {
            return String::new();
        }
        unsafe { CStr::from_ptr(utf8) }
            .to_string_lossy()
            .into_owned()
    }

    unsafe fn array(object: *mut AnyObject) -> Vec<*mut AnyObject> {
        if object.is_null() {
            return Vec::new();
        }
        let count: usize = unsafe { msg_send![object, count] };
        (0..count)
            .map(|i| unsafe { msg_send![object, objectAtIndex: i] })
            .collect()
    }

    unsafe fn hex(color: *mut AnyObject) -> String {
        if color.is_null() {
            return "#8E8E93".into();
        }
        let space: *mut AnyObject = unsafe { msg_send![class!(NSColorSpace), sRGBColorSpace] };
        let srgb: *mut AnyObject = unsafe { msg_send![color, colorUsingColorSpace: space] };
        if srgb.is_null() {
            return "#8E8E93".into();
        }
        let r: f64 = unsafe { msg_send![srgb, redComponent] };
        let g: f64 = unsafe { msg_send![srgb, greenComponent] };
        let b: f64 = unsafe { msg_send![srgb, blueComponent] };
        let c = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        format!("#{:02X}{:02X}{:02X}", c(r), c(g), c(b))
    }

    unsafe fn date_ms(date: *mut AnyObject) -> i64 {
        if date.is_null() {
            return 0;
        }
        let seconds: f64 = unsafe { msg_send![date, timeIntervalSince1970] };
        (seconds * 1000.0) as i64
    }

    unsafe fn participant(p: *mut AnyObject) -> Participant {
        let url: *mut AnyObject = unsafe { msg_send![p, URL] };
        let absolute: *mut AnyObject = if url.is_null() {
            std::ptr::null_mut()
        } else {
            unsafe { msg_send![url, absoluteString] }
        };
        let address = unsafe { text(absolute) };
        let status: isize = unsafe { msg_send![p, participantStatus] };
        let me: Bool = unsafe { msg_send![p, isCurrentUser] };
        let name: *mut AnyObject = unsafe { msg_send![p, name] };
        Participant {
            name: unsafe { text(name) },
            email: address
                .strip_prefix("mailto:")
                .unwrap_or_default()
                .to_owned(),
            status: match status {
                2 => "accepted",
                3 => "declined",
                4 => "tentative",
                _ => "pending",
            }
            .into(),
            me: me.as_bool(),
        }
    }

    impl EventKitSource {
        pub fn new() -> EventKitSource {
            let store: *mut AnyObject = unsafe {
                let allocated: *mut AnyObject = msg_send![class!(EKEventStore), alloc];
                msg_send![allocated, init]
            };
            EventKitSource {
                store: Mutex::new(StorePtr(store)),
            }
        }

        fn status_code() -> isize {
            unsafe { msg_send![class!(EKEventStore), authorizationStatusForEntityType: 0usize] }
        }
    }

    impl Default for EventKitSource {
        fn default() -> Self {
            Self::new()
        }
    }

    impl CalendarSource for EventKitSource {
        fn access(&self) -> CalendarAccess {
            match Self::status_code() {
                1 => CalendarAccess::Restricted,
                2 => CalendarAccess::Denied,
                3 => CalendarAccess::FullAccess,
                4 => CalendarAccess::WriteOnly,
                _ => CalendarAccess::NotDetermined,
            }
        }

        fn request_access(&self, done: Box<dyn FnOnce(AccessRequest) + Send>) {
            let done = Arc::new(Mutex::new(Some(done)));
            let block = RcBlock::new(move |granted: Bool, error: *mut AnyObject| {
                let message = if error.is_null() {
                    None
                } else {
                    let description: *mut AnyObject =
                        unsafe { msg_send![error, localizedDescription] };
                    Some(unsafe { text(description) })
                };
                if let Some(done) = done.lock().take() {
                    done(AccessRequest {
                        granted: granted.as_bool(),
                        error: message,
                        responsible_other: false,
                    });
                }
            });
            let store = self.store.lock().0;
            if store.is_null() {
                return;
            }
            unsafe {
                let _: () = msg_send![store, requestFullAccessToEventsWithCompletion: &*block];
            }
        }

        fn calendars(&self) -> Vec<SystemCalendar> {
            if self.access() != CalendarAccess::FullAccess {
                return Vec::new();
            }
            let store = self.store.lock().0;
            autoreleasepool(|_| unsafe {
                let list: *mut AnyObject = msg_send![store, calendarsForEntityType: 0usize];
                array(list)
                    .into_iter()
                    .map(|cal| {
                        let id: *mut AnyObject = msg_send![cal, calendarIdentifier];
                        let title: *mut AnyObject = msg_send![cal, title];
                        let color: *mut AnyObject = msg_send![cal, color];
                        let source: *mut AnyObject = msg_send![cal, source];
                        let (account, kind) = if source.is_null() {
                            (String::new(), "other")
                        } else {
                            let title: *mut AnyObject = msg_send![source, title];
                            let kind: isize = msg_send![source, sourceType];
                            (
                                text(title),
                                match kind {
                                    0 => "local",
                                    1 => "exchange",
                                    2 => "calDAV",
                                    4 => "subscribed",
                                    5 => "birthdays",
                                    _ => "other",
                                },
                            )
                        };
                        let modifies: Bool = msg_send![cal, allowsContentModifications];
                        let cal_type: isize = msg_send![cal, type];
                        SystemCalendar {
                            id: text(id),
                            title: text(title),
                            color: hex(color),
                            account,
                            account_type: kind.into(),
                            owned: modifies.as_bool() && cal_type != 3 && cal_type != 4,
                        }
                    })
                    .collect()
            })
        }

        fn events(&self, start: i64, end: i64, calendars: &[String]) -> Vec<CalendarEvent> {
            if self.access() != CalendarAccess::FullAccess {
                return Vec::new();
            }
            let store = self.store.lock().0;
            autoreleasepool(|_| unsafe {
                let all: *mut AnyObject = msg_send![store, calendarsForEntityType: 0usize];
                let chosen: Vec<*mut AnyObject> = array(all)
                    .into_iter()
                    .filter(|cal| {
                        let id: *mut AnyObject = msg_send![*cal, calendarIdentifier];
                        calendars.is_empty() || calendars.contains(&text(id))
                    })
                    .collect();
                if chosen.is_empty() {
                    return Vec::new();
                }
                let list: *mut AnyObject = msg_send![class!(NSArray), arrayWithObjects: chosen.as_ptr(), count: chosen.len()];
                let from: *mut AnyObject =
                    msg_send![class!(NSDate), dateWithTimeIntervalSince1970: start as f64 / 1000.0];
                let to: *mut AnyObject =
                    msg_send![class!(NSDate), dateWithTimeIntervalSince1970: end as f64 / 1000.0];
                let predicate: *mut AnyObject = msg_send![store, predicateForEventsWithStartDate: from, endDate: to, calendars: list];
                let events: *mut AnyObject = msg_send![store, eventsMatchingPredicate: predicate];
                array(events)
                    .into_iter()
                    .map(|event| {
                        let id: *mut AnyObject = msg_send![event, calendarItemIdentifier];
                        let id = text(id);
                        let calendar: *mut AnyObject = msg_send![event, calendar];
                        let (calendar_id, color) = if calendar.is_null() {
                            (String::new(), "#8E8E93".to_owned())
                        } else {
                            let cid: *mut AnyObject = msg_send![calendar, calendarIdentifier];
                            let color: *mut AnyObject = msg_send![calendar, color];
                            (text(cid), hex(color))
                        };
                        let start_date: *mut AnyObject = msg_send![event, startDate];
                        let end_date: *mut AnyObject = msg_send![event, endDate];
                        let start = date_ms(start_date);
                        let title: *mut AnyObject = msg_send![event, title];
                        let location: *mut AnyObject = msg_send![event, location];
                        let notes: *mut AnyObject = msg_send![event, notes];
                        let url: *mut AnyObject = msg_send![event, URL];
                        let url_text = if url.is_null() {
                            String::new()
                        } else {
                            let absolute: *mut AnyObject = msg_send![url, absoluteString];
                            text(absolute)
                        };
                        let all_day: Bool = msg_send![event, isAllDay];
                        let status: isize = msg_send![event, status];
                        let attendees: *mut AnyObject = msg_send![event, attendees];
                        let people: Vec<*mut AnyObject> = array(attendees)
                            .into_iter()
                            .filter(|p| {
                                let kind: isize = msg_send![*p, participantType];
                                kind != 3 && kind != 2
                            })
                            .collect();
                        let declined = array(attendees).into_iter().any(|p| {
                            let me: Bool = msg_send![p, isCurrentUser];
                            let status: isize = msg_send![p, participantStatus];
                            me.as_bool() && status == 3
                        });
                        let organizer: *mut AnyObject = msg_send![event, organizer];
                        CalendarEvent {
                            occurrence: format!("{id}@{}", start / 1000),
                            id,
                            calendar_id,
                            color,
                            title: text(title),
                            start,
                            end: date_ms(end_date),
                            all_day: all_day.as_bool(),
                            location: Some(text(location)),
                            notes: Some(text(notes)),
                            url: Some(url_text),
                            cancelled: status == 3,
                            declined,
                            organizer: (!organizer.is_null()).then(|| participant(organizer)),
                            attendees: people.into_iter().map(|p| participant(p)).collect(),
                        }
                    })
                    .collect()
            })
        }

        fn on_change(&self, changed: Arc<dyn Fn() + Send + Sync>) {
            let store = self.store.lock().0;
            let block = RcBlock::new(move |_note: *mut AnyObject| changed());
            unsafe {
                let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
                let queue: *mut AnyObject = msg_send![class!(NSOperationQueue), mainQueue];
                let _: *mut AnyObject = msg_send![
                    center,
                    addObserverForName: EKEventStoreChangedNotification,
                    object: store,
                    queue: queue,
                    usingBlock: &*block
                ];
            }
        }
    }
}

static HUB: OnceLock<Arc<CalendarHub>> = OnceLock::new();

pub fn hub() -> Option<&'static Arc<CalendarHub>> {
    HUB.get()
}

pub fn fixture_mode() -> bool {
    std::env::var("ARDIA_CALENDAR_FIXTURE").is_ok_and(|v| v == "1")
}

impl crate::coordinator::AppCoordinator {
    pub fn start_calendar(&self, live: Arc<LiveHub>) {
        if HUB.get().is_some() {
            return;
        }
        let source: Arc<dyn CalendarSource> = match (fixture_mode(), self.data_dir()) {
            (true, Some(dir)) => Arc::new(FixtureSource::new(dir.join(FIXTURE_DOC), now_ms())),
            #[cfg(target_os = "macos")]
            _ => Arc::new(eventkit::EventKitSource::new()),
            #[cfg(not(target_os = "macos"))]
            _ => Arc::new(FixtureSource::new(PathBuf::new(), now_ms())),
        };
        let hub = CalendarHub::new(
            source,
            live,
            Some(Arc::clone(&self.store)),
            crate::notifications::system(),
        );
        let weak = self.weak();
        hub.subscribe(Arc::new(move || {
            if let Some(coordinator) = weak.upgrade() {
                coordinator
                    .signal
                    .emit(ardia_ui::host_data::HostTopics::PEOPLE);
            }
        }));
        let hub = HUB.get_or_init(|| hub);
        hub.start();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::sources::Endpoints;
    use crate::secrets::SecretStore;

    fn fixture_hub(dir: &std::path::Path) -> Arc<CalendarHub> {
        fixture_hub_with(dir, Arc::new(crate::notifications::Silent))
    }

    fn fixture_hub_with(
        dir: &std::path::Path,
        notifier: Arc<dyn crate::notifications::Notifier>,
    ) -> Arc<CalendarHub> {
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/browser/src/state/live/fixtures/calendar-fixture.json"
        );
        let _ = std::fs::copy(fixture, dir.join(FIXTURE_DOC));
        let live = LiveHub::new(
            Some(dir.to_path_buf()),
            SecretStore::isolated(dir.to_path_buf()),
            None,
            Endpoints { mock: None },
            None,
        );
        CalendarHub::new(
            Arc::new(FixtureSource::new(dir.join(FIXTURE_DOC), now_ms())),
            live,
            None,
            notifier,
        )
    }

    #[test]
    fn inactive_app_gets_one_system_notification_per_alert() {
        let dir = tempfile::tempdir().expect("dir");
        let notifier = Arc::new(crate::notifications::mock::MockNotifier::default());
        let hub = fixture_hub_with(dir.path(), notifier.clone());
        if !dir.path().join(FIXTURE_DOC).exists() {
            return;
        }
        hub.live
            .update(false, |s| s.calendar.alert_lead = "5".into());
        hub.refresh();
        hub.check_alerts();
        let posted = notifier.posted.lock().clone();
        assert_eq!(posted.len(), 1);
        assert!(posted[0].0.starts_with("meeting:design@"));
        assert_eq!(posted[0].1, "Design review: Live folders");
        assert!(posted[0].2.starts_with("Starts in "));
        assert!(posted[0].2.ends_with(" · Join with Google Meet"));
        let occurrence = posted[0].0.trim_start_matches("meeting:").to_owned();
        hub.dismiss(&occurrence);
        assert_eq!(
            notifier.removed.lock().clone(),
            vec![format!("meeting:{occurrence}")]
        );
        *notifier.active.lock() = true;
    }

    #[test]
    fn fixture_events_load_hidden_calendars_drop_and_alerts_fire() {
        let dir = tempfile::tempdir().expect("dir");
        let hub = fixture_hub(dir.path());
        if !dir.path().join(FIXTURE_DOC).exists() {
            return;
        }
        hub.live
            .update(false, |s| s.calendar.alert_lead = "5".into());
        hub.refresh();
        let view = hub.view();
        assert_eq!(view.access, CalendarAccess::Fixture);
        assert!(!view.events.is_empty());
        assert!(view.events.windows(2).all(|w| w[0].start <= w[1].start));
        let alert = view.alert.clone().expect("the design review is due");
        assert_eq!(alert.title, "Design review: Live folders");
        hub.dismiss(&alert.occurrence);
        assert_ne!(
            hub.view().alert.as_ref().map(|a| a.occurrence.clone()),
            Some(alert.occurrence)
        );
        hub.command(CalendarCommand::SetHidden {
            calendar: "work".into(),
            hidden: true,
        });
        assert!(hub.view().events.iter().all(|e| e.calendar_id != "work"));
    }

    #[test]
    fn today_starts_at_local_midnight() {
        let now = now_ms();
        let start = start_of_today(now);
        assert!(start <= now && now - start < 86_400_000);
    }
}
