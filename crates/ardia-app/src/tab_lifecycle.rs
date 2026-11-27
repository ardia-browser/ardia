use std::collections::{HashMap, HashSet};
use std::sync::Weak;
use std::time::{Duration, Instant};

use ardia_engine::{BrowserEngine, EngineTabId};
use ardia_state::actions::{Action, PageUpdate};
use ardia_state::model::{Millis, PageKind};
use ardia_state::settings::{BatterySaverWhen, MemorySaverMode, NewTabOpens, Settings};
use ardia_state::tabs::Tab;
use ardia_state::windows::{BrowserWindow, Toast, ToastKind, WindowKind};
use ardia_state::{BrowserState, TabId, WindowId};
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;
use crate::system_state::{MemoryPressure, SystemState};

pub const LAUNCH_SETTLES_AFTER: Duration = Duration::from_millis(1500);
pub const NEW_TAB_PREWARM_DELAY: Duration = Duration::from_millis(120);
pub const RECENT_TABS_AFTER: Duration = Duration::from_secs(3);
pub const RECENT_TABS_STEP: Duration = Duration::from_secs(2);
pub const LIFECYCLE_TICK: Duration = Duration::from_secs(5);
const RECENT_TABS_WITHIN_MS: Millis = 24 * 60 * MINUTE_MS;
const MINUTE_MS: Millis = 60_000;
const RECENTLY_SEEN_MS: Millis = 10 * MINUTE_MS;
const RECENTLY_AUDIBLE_MS: Millis = MINUTE_MS;
const FREQUENT_SWITCHES: u32 = 15;
const SLEEPS_PER_TICK: usize = 4;
const SWEEP_EVERY_MS: Millis = MINUTE_MS;
const PRESSURE_ARMS_AFTER: Duration = Duration::from_secs(10);
const ASK_AGAIN_MS: Millis = 10 * MINUTE_MS;
const KEPT_RECENTLY_MS: Millis = 60 * MINUTE_MS;
const LOW_BATTERY_PERCENT: f64 = 20.0;
const GIB: f64 = (1u64 << 30) as f64;
const OVERRIDDEN_BY_ASKING: [i32; 10] = [6, 7, 13, 14, 23, 25, 100, 101, 102, 103];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NewTabPrewarm {
    Open,
    Wait(Duration),
    Hold,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SleepRules {
    pub tabs: usize,
    pub hidden_ms: Millis,
    pub pressure: MemoryPressure,
    pub per_tick: usize,
    pub every_ms: Millis,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SleepVeto {
    NotSleepable,
    Shown,
    CliSession,
    Call,
    PictureInPicture,
    Audible,
    RecentlyAudible,
    FrequentlyUsed,
    RecentlySeen,
    KeptRecently,
    Loading,
    TypedInput,
    PostedDocument,
    BeforeUnload,
    Download,
    Other,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TabSleepFacts {
    pub id: TabId,
    pub sleepable: bool,
    pub shown: bool,
    pub last_seen_at: Millis,
    pub switches: u32,
    pub audible: bool,
    pub last_audible_at: Millis,
    pub call: bool,
    pub picture_in_picture: bool,
    pub loading: bool,
    pub ask_again_at: Millis,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SleepPlan {
    pub sleep: Vec<TabId>,
    pub vetoed: Vec<(TabId, SleepVeto)>,
}

pub fn sleep_rules(settings: &Settings, system: Option<&SystemState>) -> Option<SleepRules> {
    let system = system.filter(|_| settings.memory_saver)?;
    let (floor, per_gib, hidden_ms) = match settings.memory_saver_mode {
        MemorySaverMode::Moderate => (20, 2.0, 120 * MINUTE_MS),
        MemorySaverMode::Balanced => (10, 1.0, 60 * MINUTE_MS),
        MemorySaverMode::Maximum => (5, 0.5, 30 * MINUTE_MS),
    };
    let pressured = |pressure_hidden_ms: Millis, every_ms: Millis| SleepRules {
        tabs: floor,
        hidden_ms: hidden_ms.min(pressure_hidden_ms),
        pressure: system.memory_pressure,
        per_tick: SLEEPS_PER_TICK,
        every_ms,
    };
    Some(match system.memory_pressure {
        MemoryPressure::Warning => pressured(5 * MINUTE_MS, 15_000),
        MemoryPressure::Critical => pressured(2 * MINUTE_MS, 10_000),
        MemoryPressure::Normal => SleepRules {
            tabs: floor.max((system.physical_memory as f64 / GIB * per_gib).round() as usize),
            hidden_ms,
            pressure: MemoryPressure::Normal,
            per_tick: SLEEPS_PER_TICK,
            every_ms: SWEEP_EVERY_MS,
        },
    })
}

fn seen_window_ms(rules: &SleepRules) -> Millis {
    if rules.pressure == MemoryPressure::Normal {
        rules.hidden_ms.max(RECENTLY_SEEN_MS)
    } else {
        rules.hidden_ms
    }
}

pub fn sleep_veto(tab: &TabSleepFacts, now: Millis, rules: &SleepRules) -> Option<SleepVeto> {
    if !tab.sleepable {
        return Some(SleepVeto::NotSleepable);
    }
    if tab.shown {
        return Some(SleepVeto::Shown);
    }
    if tab.call {
        return Some(SleepVeto::Call);
    }
    if tab.picture_in_picture {
        return Some(SleepVeto::PictureInPicture);
    }
    if tab.audible {
        return Some(SleepVeto::Audible);
    }
    if now - tab.last_audible_at < RECENTLY_AUDIBLE_MS {
        return Some(SleepVeto::RecentlyAudible);
    }
    if tab.switches >= FREQUENT_SWITCHES {
        return Some(SleepVeto::FrequentlyUsed);
    }
    if now - tab.last_seen_at < seen_window_ms(rules) {
        return Some(SleepVeto::RecentlySeen);
    }
    if tab.ask_again_at > now {
        return Some(SleepVeto::KeptRecently);
    }
    if tab.loading {
        return Some(SleepVeto::Loading);
    }
    None
}

pub fn tabs_to_sleep(awake: &[TabSleepFacts], now: Millis, rules: &SleepRules) -> SleepPlan {
    let mut plan = SleepPlan::default();
    if awake.len() <= rules.tabs {
        return plan;
    }
    let recency = |t: &TabSleepFacts| if t.shown { now } else { t.last_seen_at };
    let mut ordered: Vec<&TabSleepFacts> = awake.iter().collect();
    ordered.sort_by_key(|t| std::cmp::Reverse(recency(t)));
    for tab in ordered.into_iter().skip(rules.tabs).rev() {
        match sleep_veto(tab, now, rules) {
            Some(veto) => plan.vetoed.push((tab.id.clone(), veto)),
            None => plan.sleep.push(tab.id.clone()),
        }
    }
    plan
}

fn engine_code_veto(code: i32) -> SleepVeto {
    match code {
        -1 => SleepVeto::NotSleepable,
        4 | 22 => SleepVeto::Shown,
        5 => SleepVeto::Audible,
        6 => SleepVeto::RecentlyAudible,
        7 => SleepVeto::RecentlySeen,
        8 => SleepVeto::PictureInPicture,
        15..=19 => SleepVeto::Call,
        26 | 27 => SleepVeto::TypedInput,
        100 => SleepVeto::PostedDocument,
        101 => SleepVeto::BeforeUnload,
        102 => SleepVeto::Download,
        103 => SleepVeto::CliSession,
        _ => SleepVeto::Other,
    }
}

pub fn engine_veto(kept_by: &[i32]) -> Option<SleepVeto> {
    const ORDER: [SleepVeto; 12] = [
        SleepVeto::PostedDocument,
        SleepVeto::BeforeUnload,
        SleepVeto::TypedInput,
        SleepVeto::Download,
        SleepVeto::CliSession,
        SleepVeto::Call,
        SleepVeto::PictureInPicture,
        SleepVeto::Audible,
        SleepVeto::RecentlyAudible,
        SleepVeto::RecentlySeen,
        SleepVeto::Shown,
        SleepVeto::NotSleepable,
    ];
    if kept_by.is_empty() {
        return None;
    }
    let vetoes: HashSet<SleepVeto> = kept_by.iter().copied().map(engine_code_veto).collect();
    Some(
        ORDER
            .into_iter()
            .find(|veto| vetoes.contains(veto))
            .unwrap_or(SleepVeto::Other),
    )
}

pub fn only_automatic_protections(kept_by: &[i32]) -> bool {
    !kept_by.is_empty()
        && kept_by
            .iter()
            .all(|code| OVERRIDDEN_BY_ASKING.contains(code))
}

pub fn battery_saver_wanted(
    when: BatterySaverWhen,
    system: Option<&SystemState>,
    low_battery_held: bool,
) -> (bool, bool) {
    let Some(system) = system.filter(|_| when != BatterySaverWhen::Never) else {
        return (false, false);
    };
    let low = when == BatterySaverWhen::LowBattery
        && system.on_battery
        && (low_battery_held
            || system
                .battery_level
                .is_some_and(|level| (level * 100.0).round() <= LOW_BATTERY_PERCENT));
    let on =
        system.low_power_mode || (system.on_battery && when == BatterySaverWhen::Unplugged) || low;
    (on, low)
}

pub fn memory_saver_request(settings: &Settings) -> Value {
    json!({
        "state": if settings.memory_saver { "on" } else { "off" },
        "aggressiveness": match settings.memory_saver_mode {
            MemorySaverMode::Moderate => "moderate",
            MemorySaverMode::Balanced => "balanced",
            MemorySaverMode::Maximum => "maximum",
        },
        "sites": settings.keep_active_sites,
    })
}

pub fn recent_reload_count(system: &SystemState) -> usize {
    let busy = system.on_battery
        || system.low_power_mode
        || system.memory_pressure != MemoryPressure::Normal;
    let gib = system.physical_memory as f64 / GIB;
    match () {
        _ if busy => 0,
        _ if gib >= 32.0 => 4,
        _ if gib >= 16.0 => 3,
        _ if gib >= 8.0 => 1,
        _ => 0,
    }
}

pub fn restored_lazily(tab: &Tab) -> bool {
    !tab.url.is_empty() && tab.page.kind == PageKind::Idle
}

pub fn is_blank_new_tab(tab: &Tab) -> bool {
    tab.url.is_empty() && tab.live.navigation.is_none() && tab.page.pending_restore().is_none()
}

pub fn keeps_hidden_page(tab: &Tab) -> bool {
    tab.page.has_page()
        && !tab.url.is_empty()
        && !tab.live.peek
        && !ardia_ui::pages::is_internal(&tab.url)
}

pub fn shown_everywhere(state: &BrowserState) -> HashSet<TabId> {
    state
        .windows
        .values()
        .filter(|window| window.kind.has_tabs())
        .flat_map(|window| crate::reconcile::shown_tabs(state, window))
        .collect()
}

pub fn recent_tabs_to_reload(
    state: &BrowserState,
    shown: &HashSet<TabId>,
    count: usize,
    now: Millis,
) -> Vec<TabId> {
    let since = now - RECENT_TABS_WITHIN_MS;
    let mut found: Vec<&Tab> = state
        .tabs
        .values()
        .map(|tab| &**tab)
        .filter(|tab| restored_lazily(tab) && !shown.contains(&tab.id))
        .filter(|tab| !ardia_ui::pages::is_internal(&tab.url) && tab.last_active_at >= since)
        .filter(|tab| {
            state
                .window(tab.window_id.as_str())
                .is_some_and(|window| window.profile_id == tab.profile_id)
        })
        .collect();
    found.sort_by_key(|tab| std::cmp::Reverse(tab.last_active_at));
    found
        .into_iter()
        .take(count)
        .map(|tab| tab.id.clone())
        .collect()
}

#[derive(Debug, Default)]
pub struct LifecycleBook {
    booted_at: Option<Instant>,
    cold_new_tabs: HashSet<TabId>,
    new_tabs_seen: HashMap<TabId, Instant>,
    new_tabs_this_pass: HashSet<TabId>,
    wake_due: Option<Instant>,
    system: Option<SystemState>,
    memory_saver_sent: Option<Value>,
    battery_saver: Option<bool>,
    battery_saver_when: Option<BatterySaverWhen>,
    low_battery_held: bool,
    seen_at: HashMap<TabId, Millis>,
    audible: HashSet<TabId>,
    last_audible_at: HashMap<TabId, Millis>,
    switches: HashMap<TabId, u32>,
    front: HashMap<WindowId, TabId>,
    ask_again_at: HashMap<TabId, Millis>,
    kept_at: HashMap<TabId, Millis>,
    last_sweep_at: Option<Millis>,
    last_pressure: MemoryPressure,
    pub(crate) history_bound: HashSet<TabId>,
    pub(crate) profiles: crate::idle_profiles::ProfileUnloading,
    pub(crate) busy: crate::busy_tabs::BusyBook,
}

impl LifecycleBook {
    pub fn boot(&mut self, now: Instant) {
        self.booted_at.get_or_insert(now);
    }

    fn settled(&self, now: Instant) -> bool {
        self.booted_at
            .is_some_and(|booted| now.duration_since(booted) >= LAUNCH_SETTLES_AFTER)
    }

    fn pressure_armed(&self, now: Instant) -> bool {
        self.booted_at
            .is_some_and(|booted| now.duration_since(booted) >= PRESSURE_ARMS_AFTER)
    }

    pub fn begin_pass(&mut self) {
        self.new_tabs_this_pass.clear();
    }

    pub fn end_pass(&mut self) {
        let seen = &self.new_tabs_this_pass;
        self.cold_new_tabs.retain(|tab| seen.contains(tab));
        self.new_tabs_seen.retain(|tab, _| seen.contains(tab));
    }

    pub fn new_tab_prewarm(&mut self, tab: &TabId, eligible: bool, now: Instant) -> NewTabPrewarm {
        if !eligible {
            return NewTabPrewarm::Hold;
        }
        self.new_tabs_this_pass.insert(tab.clone());
        if !self.settled(now) {
            self.cold_new_tabs.insert(tab.clone());
        }
        if self.cold_new_tabs.contains(tab) {
            return NewTabPrewarm::Hold;
        }
        let since = now.duration_since(*self.new_tabs_seen.entry(tab.clone()).or_insert(now));
        match NEW_TAB_PREWARM_DELAY.checked_sub(since) {
            Some(left) if !left.is_zero() => NewTabPrewarm::Wait(left),
            _ => NewTabPrewarm::Open,
        }
    }

    fn wants_wake_at(&mut self, due: Instant) -> bool {
        if self.wake_due.is_some_and(|pending| pending <= due) {
            return false;
        }
        self.wake_due = Some(due);
        true
    }

    pub fn note_front(&mut self, window: &WindowId, tab: &TabId) {
        if self.front.get(window) == Some(tab) {
            return;
        }
        self.front.insert(window.clone(), tab.clone());
        *self.switches.entry(tab.clone()).or_default() += 1;
    }

    pub fn note_audible(&mut self, playing: HashSet<TabId>, now: Millis) {
        for stopped in self.audible.difference(&playing) {
            self.last_audible_at.insert(stopped.clone(), now);
        }
        self.audible = playing;
    }

    fn forget_missing(&mut self, state: &BrowserState, now: Millis) {
        let listed = |tab: &TabId| state.tab(tab.as_str()).is_some();
        self.seen_at.retain(|tab, _| listed(tab));
        self.last_audible_at.retain(|tab, _| listed(tab));
        self.switches.retain(|tab, _| listed(tab));
        self.ask_again_at.retain(|tab, at| listed(tab) && *at > now);
        self.kept_at
            .retain(|tab, at| listed(tab) && now - *at < KEPT_RECENTLY_MS);
    }
}

fn delay_then(
    me: Weak<AppCoordinator>,
    wait: Duration,
    job: impl FnOnce(&AppCoordinator) + Send + 'static,
) {
    let spawned = std::thread::Builder::new()
        .name("ardia-tab-lifecycle".into())
        .spawn(move || {
            std::thread::sleep(wait);
            if let Some(me) = me.upgrade()
                && !me.is_shutting_down()
            {
                me.post(job);
            }
        });
    if let Err(problem) = spawned {
        log::debug!("a tab lifecycle timer didn't start: {problem}");
    }
}

impl AppCoordinator {
    pub(crate) fn start_tab_lifecycle(&self) {
        let fresh = {
            let mut bridge = self.bridge.lock();
            let fresh = bridge.lifecycle.booted_at.is_none();
            bridge.lifecycle.boot(Instant::now());
            fresh
        };
        if !fresh {
            return;
        }
        let system = crate::system_state::read();
        self.bridge.lock().lifecycle.system = Some(system);
        self.push_memory_saver();
        self.update_battery_saver(false, true);
        self.load_profiles_eagerly();
        delay_then(self.weak(), RECENT_TABS_AFTER, Self::reload_recent_tabs);
        let me = self.weak();
        let spawned = std::thread::Builder::new()
            .name("ardia-tab-lifecycle-tick".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(LIFECYCLE_TICK);
                    let Some(coordinator) = me.upgrade() else {
                        return;
                    };
                    if coordinator.is_shutting_down() {
                        return;
                    }
                    coordinator.post(Self::lifecycle_tick);
                }
            });
        if let Err(problem) = spawned {
            log::warn!("tabs won't sleep on their own: {problem}");
        }
    }

    pub(crate) fn new_tab_page_ready(
        &self,
        state: &BrowserState,
        window: &BrowserWindow,
        tab: &TabId,
    ) -> bool {
        let Some(listed) = state.tab(tab.as_str()) else {
            return true;
        };
        if !self.config.delays_new_tab_pages
            || !is_blank_new_tab(listed)
            || self.engine_tab(tab).is_some()
        {
            return true;
        }
        let eligible = window.kind != WindowKind::LittleArdia
            && state.split_of(tab.as_str()).is_none()
            && state.settings.new_tab_opens != NewTabOpens::CommandBar;
        let now = Instant::now();
        let decision = self
            .bridge
            .lock()
            .lifecycle
            .new_tab_prewarm(tab, eligible, now);
        match decision {
            NewTabPrewarm::Open => true,
            NewTabPrewarm::Hold => false,
            NewTabPrewarm::Wait(left) => {
                let due = now + left;
                if self.bridge.lock().lifecycle.wants_wake_at(due) {
                    delay_then(self.weak(), left, |coordinator| {
                        coordinator.bridge.lock().lifecycle.wake_due = None;
                        coordinator.mark_dirty();
                    });
                }
                false
            }
        }
    }

    pub(crate) fn note_front_tab(&self, window: &WindowId, tab: &TabId) {
        self.bridge.lock().lifecycle.note_front(window, tab);
    }

    fn reload_recent_tabs(&self) {
        let Some(system) = self.bridge.lock().lifecycle.system else {
            return;
        };
        let state = self.store().snapshot();
        let shown = shown_everywhere(&state);
        let ids = recent_tabs_to_reload(
            &state,
            &shown,
            recent_reload_count(&system),
            ardia_state::store::now_ms(),
        );
        for (index, tab) in ids.into_iter().enumerate() {
            let wait = RECENT_TABS_STEP * (index as u32 + 1);
            delay_then(self.weak(), wait, move |coordinator| {
                coordinator.wake_restored_tab(&tab);
            });
        }
    }

    fn wake_restored_tab(&self, tab: &TabId) {
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        if !restored_lazily(listed) || ardia_state::pin_share::holder_of(&state, tab).is_some() {
            return;
        }
        self.mark_page_awake(listed);
    }

    fn mark_page_awake(&self, listed: &Tab) {
        self.dispatch_quietly(Action::UpdatePage {
            tab: listed.id.clone(),
            update: PageUpdate {
                url: Some(listed.url.clone()),
                ..PageUpdate::default()
            },
        });
        self.mark_dirty();
    }

    pub(crate) fn push_memory_saver(&self) {
        let Some(engine) = self.engine().filter(|engine| engine.is_started()) else {
            return;
        };
        let state = self.store().snapshot();
        let request = memory_saver_request(&state.settings);
        if self.bridge.lock().lifecycle.memory_saver_sent.as_ref() == Some(&request) {
            return;
        }
        let Some(folder) = state
            .profile_order
            .iter()
            .filter(|profile| !profile.is_incognito() && self.engine_profile(profile).is_some())
            .find_map(|profile| self.service_profile_dir(profile))
        else {
            return;
        };
        self.bridge.lock().lifecycle.memory_saver_sent = Some(request.clone());
        let reply = engine.call_service("ac_memory_saver", &folder, &request.to_string());
        let me = self.weak();
        self.spawn(async move {
            if let Err(problem) = reply.await {
                log::debug!("Memory Saver didn't take the settings: {problem}");
                if let Some(me) = me.upgrade() {
                    me.bridge.lock().lifecycle.memory_saver_sent = None;
                }
            }
        });
    }

    pub(crate) fn note_lifecycle_settings(&self) {
        self.push_memory_saver();
        self.note_busy_settings(&self.store().snapshot());
        let when = self.store().snapshot().settings.battery_saver_when;
        let changed = {
            let mut bridge = self.bridge.lock();
            let before = bridge.lifecycle.battery_saver_when.replace(when);
            let changed = before.is_some_and(|before| before != when);
            if changed {
                bridge.lifecycle.low_battery_held = false;
            }
            changed
        };
        if changed {
            self.update_battery_saver(false, false);
        }
    }

    fn update_battery_saver(&self, announce: bool, push_always: bool) {
        let state = self.store().snapshot();
        let (on, changed) = {
            let mut bridge = self.bridge.lock();
            let book = &mut bridge.lifecycle;
            book.battery_saver_when
                .get_or_insert(state.settings.battery_saver_when);
            let (on, held) = battery_saver_wanted(
                state.settings.battery_saver_when,
                book.system.as_ref(),
                book.low_battery_held,
            );
            book.low_battery_held = held;
            let before = book.battery_saver.replace(on);
            (on, before.is_some_and(|before| before != on))
        };
        if !changed && !push_always {
            return;
        }
        if let Some(engine) = self.engine().filter(|engine| engine.is_started()) {
            let reply = engine.call_service(
                "ac_battery_saver",
                "",
                &json!({ "mode": if on { "on" } else { "off" } }).to_string(),
            );
            self.spawn(async move {
                if let Err(problem) = reply.await {
                    log::debug!("Battery Saver didn't switch: {problem}");
                }
            });
        }
        if !announce || !changed {
            return;
        }
        let Some(window) = state
            .focus_order
            .iter()
            .find(|w| state.window(w.as_str()).is_some_and(|w| w.kind.has_tabs()))
            .cloned()
        else {
            return;
        };
        let now = ardia_state::store::now_ms();
        let (message, icon) = if on {
            ("Battery Saver Mode Activated", "battery.25")
        } else {
            ("Battery Saver Mode Deactivated", "battery.100.bolt")
        };
        self.dispatch_quietly(Action::PushToast {
            window,
            toast: Toast {
                id: now.max(0) as u64,
                kind: ToastKind::Info,
                message: message.to_owned(),
                action: None,
                icon: Some(icon.to_owned()),
                created_at: now,
                expires_at: Some(now + 6_000),
            },
        });
    }

    fn lifecycle_tick(&self) {
        let system = crate::system_state::read();
        let now = ardia_state::store::now_ms();
        let state = self.store().snapshot();
        let playing: HashSet<TabId> = {
            let bridge = self.bridge.lock();
            state
                .tabs
                .values()
                .filter(|tab| {
                    tab.live.audible
                        || bridge
                            .media
                            .book
                            .sessions
                            .get(&tab.id)
                            .is_some_and(|session| session.now.is_playing())
                })
                .map(|tab| tab.id.clone())
                .collect()
        };
        let pressure_rose = {
            let mut bridge = self.bridge.lock();
            let book = &mut bridge.lifecycle;
            book.system = Some(system);
            book.note_audible(playing, now);
            let before = std::mem::replace(&mut book.last_pressure, system.memory_pressure);
            before != system.memory_pressure && system.memory_pressure != MemoryPressure::Normal
        };
        if pressure_rose {
            log::info!(
                "memory pressure is {}, so hidden tabs sleep sooner",
                system.memory_pressure.name()
            );
        }
        self.update_battery_saver(true, false);
        self.push_memory_saver();
        self.sweep_if_due(&state, now, pressure_rose);
        self.tend_profiles(&state, now);
        self.tend_busy_tabs(&state, now);
    }

    fn sleep_facts(
        &self,
        state: &BrowserState,
        tab: &Tab,
        shown: &HashSet<TabId>,
    ) -> TabSleepFacts {
        let bridge = self.bridge.lock();
        let book = &bridge.lifecycle;
        let capturing = bridge
            .media_access
            .get(&tab.id)
            .is_some_and(|access| access.camera || access.microphone || access.screen);
        let playing = book.audible.contains(&tab.id);
        let lowered = tab.url.to_ascii_lowercase();
        TabSleepFacts {
            id: tab.id.clone(),
            sleepable: (lowered.starts_with("http://") || lowered.starts_with("https://"))
                && state.tab(tab.id.as_str()).is_some(),
            shown: shown.contains(&tab.id),
            last_seen_at: tab
                .last_active_at
                .max(book.seen_at.get(&tab.id).copied().unwrap_or(0)),
            switches: book.switches.get(&tab.id).copied().unwrap_or(0),
            audible: playing || tab.live.audible,
            last_audible_at: book.last_audible_at.get(&tab.id).copied().unwrap_or(0),
            call: capturing,
            picture_in_picture: bridge.media.book.pip_open.contains(&tab.id),
            loading: tab.live.loading,
            ask_again_at: book.ask_again_at.get(&tab.id).copied().unwrap_or(0),
        }
    }

    fn awake_engine_tabs(&self, state: &BrowserState) -> Vec<(Tab, EngineTabId)> {
        let bridge = self.bridge.lock();
        bridge
            .tabs
            .iter()
            .filter_map(|(tab, engine_tab)| {
                let listed = state.tab(tab.as_str())?;
                let asleep = matches!(listed.page.kind, PageKind::Asleep | PageKind::Frozen { .. })
                    || bridge
                        .applied
                        .get(tab)
                        .is_some_and(|applied| applied.asleep);
                (!asleep).then(|| ((**listed).clone(), *engine_tab))
            })
            .collect()
    }

    fn sweep_if_due(&self, state: &BrowserState, now: Millis, pressure_rose: bool) {
        let (rules, armed) = {
            let bridge = self.bridge.lock();
            (
                sleep_rules(&state.settings, bridge.lifecycle.system.as_ref()),
                bridge.lifecycle.pressure_armed(Instant::now()),
            )
        };
        let Some(rules) = rules else {
            return;
        };
        let awake = self.awake_engine_tabs(state);
        if awake.len() <= rules.tabs {
            return;
        }
        if rules.pressure != MemoryPressure::Normal && !armed {
            return;
        }
        {
            let mut bridge = self.bridge.lock();
            let book = &mut bridge.lifecycle;
            let due = book
                .last_sweep_at
                .is_none_or(|at| now - at >= rules.every_ms || pressure_rose);
            if !due {
                return;
            }
            book.last_sweep_at = Some(now);
        }
        self.sweep(state, &awake, &rules, now);
    }

    fn sweep(
        &self,
        state: &BrowserState,
        awake: &[(Tab, EngineTabId)],
        rules: &SleepRules,
        now: Millis,
    ) {
        let Some(engine) = self.engine().filter(|engine| engine.is_started()) else {
            return;
        };
        let shown_ids: Vec<TabId> = shown_everywhere(state).into_iter().collect();
        let shown: HashSet<TabId> = ardia_state::pin_share::with_shared_family(state, &shown_ids)
            .into_iter()
            .collect();
        {
            let mut bridge = self.bridge.lock();
            let book = &mut bridge.lifecycle;
            for tab in &shown {
                book.seen_at.insert(tab.clone(), now);
            }
            book.forget_missing(state, now);
        }
        let facts: Vec<TabSleepFacts> = awake
            .iter()
            .map(|(tab, _)| self.sleep_facts(state, tab, &shown))
            .collect();
        let plan = tabs_to_sleep(&facts, now, rules);
        let asking: Vec<TabId> = {
            let bridge = self.bridge.lock();
            let kept = &bridge.lifecycle.kept_at;
            let (fresh, again): (Vec<TabId>, Vec<TabId>) = plan
                .sleep
                .into_iter()
                .partition(|tab| !kept.contains_key(tab));
            fresh
                .into_iter()
                .chain(again)
                .take(rules.per_tick)
                .collect()
        };
        let hidden_seconds = rules.hidden_ms as f64 / 1000.0;
        for tab in asking {
            let Some(engine_tab) = self.engine_tab(&tab) else {
                continue;
            };
            let answer = engine.sleep_if_hidden(engine_tab, hidden_seconds);
            let mut bridge = self.bridge.lock();
            let book = &mut bridge.lifecycle;
            match answer {
                Ok(kept_by) if kept_by.is_empty() => {
                    book.kept_at.remove(&tab);
                    log::debug!("{tab} slept: more tabs were awake than Memory Saver keeps");
                }
                Ok(kept_by) if engine_veto(&kept_by) == Some(SleepVeto::RecentlySeen) => {
                    book.seen_at.insert(tab, now);
                }
                _ => {
                    book.ask_again_at.insert(tab.clone(), now + ASK_AGAIN_MS);
                    book.kept_at.insert(tab, now);
                }
            }
        }
    }

    pub(crate) fn tab_in_use(&self, tab: &Tab) -> bool {
        let bridge = self.bridge.lock();
        tab.live.audible
            || bridge
                .media
                .book
                .sessions
                .get(&tab.id)
                .is_some_and(|session| session.now.is_playing())
            || bridge.media.book.pip_open.contains(&tab.id)
            || bridge
                .media_access
                .get(&tab.id)
                .is_some_and(|access| access.camera || access.microphone || access.screen)
    }

    pub(crate) fn sleep_when_asked(
        &self,
        listed: &Tab,
        engine_tab: EngineTabId,
        engine: &std::sync::Arc<dyn BrowserEngine>,
    ) -> bool {
        let slept = !self.tab_in_use(listed)
            && match engine.sleep_if_hidden(engine_tab, 0.0) {
                Ok(kept_by) if kept_by.is_empty() => true,
                Ok(kept_by) if only_automatic_protections(&kept_by) => {
                    engine.discard(engine_tab).unwrap_or(false)
                }
                _ => false,
            };
        if !slept {
            log::info!("{} stays awake: it's busy", listed.id);
            self.mark_page_awake(listed);
        }
        slept
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::model::TabPage;
    use ardia_state::{ProfileId, WindowId};

    fn system(gib: u64) -> SystemState {
        SystemState {
            physical_memory: gib << 30,
            ..SystemState::default()
        }
    }

    fn facts(id: &str, seen: Millis) -> TabSleepFacts {
        TabSleepFacts {
            id: TabId::new(id),
            sleepable: true,
            shown: false,
            last_seen_at: seen,
            switches: 0,
            audible: false,
            last_audible_at: 0,
            call: false,
            picture_in_picture: false,
            loading: false,
            ask_again_at: 0,
        }
    }

    #[test]
    fn memory_saver_keeps_as_many_tabs_as_the_old_app() {
        let mut settings = Settings::default();
        let rules = sleep_rules(&settings, Some(&system(48))).unwrap();
        assert_eq!(
            (rules.tabs, rules.hidden_ms, rules.every_ms),
            (48, 60 * MINUTE_MS, MINUTE_MS)
        );
        settings.memory_saver_mode = MemorySaverMode::Maximum;
        let tight = SystemState {
            memory_pressure: MemoryPressure::Critical,
            ..system(8)
        };
        let rules = sleep_rules(&settings, Some(&tight)).unwrap();
        assert_eq!(
            (rules.tabs, rules.hidden_ms, rules.every_ms),
            (5, 2 * MINUTE_MS, 10_000)
        );
        settings.memory_saver = false;
        assert!(sleep_rules(&settings, Some(&system(8))).is_none());
    }

    #[test]
    fn the_oldest_unseen_tabs_over_the_budget_sleep_first() {
        let rules = SleepRules {
            tabs: 2,
            hidden_ms: 60 * MINUTE_MS,
            pressure: MemoryPressure::Normal,
            per_tick: 4,
            every_ms: MINUTE_MS,
        };
        let now = 1_000 * MINUTE_MS;
        let mut playing = facts("playing", now - 500 * MINUTE_MS);
        playing.audible = true;
        let awake = vec![
            facts("fresh", now - MINUTE_MS),
            facts("old", now - 300 * MINUTE_MS),
            facts("older", now - 400 * MINUTE_MS),
            playing,
            facts("recent", now - 2 * MINUTE_MS),
        ];
        let plan = tabs_to_sleep(&awake, now, &rules);
        assert_eq!(plan.sleep, vec![TabId::new("older"), TabId::new("old")]);
        assert_eq!(
            plan.vetoed,
            vec![(TabId::new("playing"), SleepVeto::Audible)]
        );
    }

    #[test]
    fn engine_answers_pick_the_strongest_reason() {
        assert_eq!(engine_veto(&[]), None);
        assert_eq!(engine_veto(&[7, 5]), Some(SleepVeto::Audible));
        assert_eq!(engine_veto(&[7]), Some(SleepVeto::RecentlySeen));
        assert_eq!(engine_veto(&[999]), Some(SleepVeto::Other));
        assert!(only_automatic_protections(&[6, 7, 101]));
        assert!(!only_automatic_protections(&[7, 5]));
        assert!(!only_automatic_protections(&[]));
    }

    #[test]
    fn battery_saver_follows_the_setting_and_holds_low_battery() {
        let unplugged = SystemState {
            on_battery: true,
            battery_level: Some(0.19),
            ..system(16)
        };
        assert_eq!(
            battery_saver_wanted(BatterySaverWhen::LowBattery, Some(&unplugged), false),
            (true, true)
        );
        let charged = SystemState {
            battery_level: Some(0.5),
            ..unplugged
        };
        assert_eq!(
            battery_saver_wanted(BatterySaverWhen::LowBattery, Some(&charged), true),
            (true, true)
        );
        assert_eq!(
            battery_saver_wanted(BatterySaverWhen::LowBattery, Some(&charged), false),
            (false, false)
        );
        assert_eq!(
            battery_saver_wanted(BatterySaverWhen::Unplugged, Some(&charged), false),
            (true, false)
        );
        assert_eq!(
            battery_saver_wanted(BatterySaverWhen::Never, Some(&unplugged), true),
            (false, false)
        );
        assert_eq!(
            battery_saver_wanted(BatterySaverWhen::LowBattery, None, true),
            (false, false)
        );
    }

    #[test]
    fn recent_tabs_reload_by_memory_like_the_old_app() {
        assert_eq!(recent_reload_count(&system(48)), 4);
        assert_eq!(recent_reload_count(&system(24)), 3);
        assert_eq!(recent_reload_count(&system(8)), 1);
        assert_eq!(recent_reload_count(&system(4)), 0);
        let unplugged = SystemState {
            on_battery: true,
            ..system(48)
        };
        assert_eq!(recent_reload_count(&unplugged), 0);
    }

    #[test]
    fn a_new_tab_shown_at_launch_gets_no_page_until_it_is_shown_again() {
        let start = Instant::now();
        let mut book = LifecycleBook::default();
        book.boot(start);
        let tab = TabId::new("new");
        book.begin_pass();
        assert_eq!(book.new_tab_prewarm(&tab, true, start), NewTabPrewarm::Hold);
        book.end_pass();
        let later = start + Duration::from_secs(5);
        book.begin_pass();
        assert_eq!(book.new_tab_prewarm(&tab, true, later), NewTabPrewarm::Hold);
        book.end_pass();
        book.begin_pass();
        book.end_pass();
        book.begin_pass();
        assert_eq!(
            book.new_tab_prewarm(&tab, true, later),
            NewTabPrewarm::Wait(NEW_TAB_PREWARM_DELAY)
        );
        book.end_pass();
        book.begin_pass();
        assert_eq!(
            book.new_tab_prewarm(&tab, true, later + NEW_TAB_PREWARM_DELAY),
            NewTabPrewarm::Open
        );
        assert_eq!(
            book.new_tab_prewarm(&TabId::new("split"), false, later),
            NewTabPrewarm::Hold
        );
    }

    #[test]
    fn only_loaded_web_pages_stay_loaded_while_hidden() {
        let tab = |url: &str, page: TabPage| {
            let mut t = Tab::new(
                TabId::new("t"),
                WindowId::new("w"),
                ProfileId::new("p"),
                url,
                0,
            );
            t.page = page;
            t
        };
        assert!(keeps_hidden_page(&tab(
            "https://a.example/",
            TabPage::LOADED
        )));
        assert!(!keeps_hidden_page(&tab(
            "https://a.example/",
            TabPage::IDLE
        )));
        assert!(!keeps_hidden_page(&tab(
            "https://a.example/",
            TabPage::ASLEEP
        )));
        assert!(!keeps_hidden_page(&tab("ardia://history", TabPage::LOADED)));
        assert!(!keeps_hidden_page(&tab("", TabPage::LOADED)));
        let mut peek = tab("https://a.example/", TabPage::LOADED);
        peek.live.peek = true;
        assert!(!keeps_hidden_page(&peek));
    }

    #[test]
    fn switches_count_each_time_a_tab_comes_to_the_front() {
        let mut book = LifecycleBook::default();
        let window = WindowId::new("w");
        let (a, b) = (TabId::new("a"), TabId::new("b"));
        book.note_front(&window, &a);
        book.note_front(&window, &a);
        book.note_front(&window, &b);
        book.note_front(&window, &a);
        assert_eq!(book.switches.get(&a), Some(&2));
        assert_eq!(book.switches.get(&b), Some(&1));
    }

    #[test]
    fn only_recent_lazy_web_tabs_in_the_window_profile_reload() {
        let now = 100 * RECENT_TABS_WITHIN_MS;
        let window = WindowId::new("w");
        let profile = ProfileId::new("p");
        let other = ProfileId::new("o");
        let tab = |id: &str, url: &str, at: Millis, profile: &ProfileId, page: TabPage| {
            let mut t = Tab::new(TabId::new(id), window.clone(), profile.clone(), url, at);
            t.last_active_at = at;
            t.page = page;
            t
        };
        let tabs = [
            tab(
                "newest",
                "https://a.example/",
                now - 10,
                &profile,
                TabPage::IDLE,
            ),
            tab(
                "asleep",
                "https://b.example/",
                now - 5,
                &profile,
                TabPage::ASLEEP,
            ),
            tab(
                "loaded",
                "https://c.example/",
                now - 5,
                &profile,
                TabPage::LOADED,
            ),
            tab(
                "other",
                "https://d.example/",
                now - 5,
                &other,
                TabPage::IDLE,
            ),
            tab(
                "stale",
                "https://e.example/",
                now - RECENT_TABS_WITHIN_MS - 1,
                &profile,
                TabPage::IDLE,
            ),
            tab(
                "internal",
                "ardia://history",
                now - 1,
                &profile,
                TabPage::IDLE,
            ),
            tab("empty", "", now - 1, &profile, TabPage::IDLE),
            tab(
                "second",
                "https://f.example/",
                now - 20,
                &profile,
                TabPage::IDLE,
            ),
            tab(
                "shown",
                "https://g.example/",
                now - 1,
                &profile,
                TabPage::IDLE,
            ),
        ];
        let mut state = BrowserState::default();
        let mut listed = BrowserWindow::new(window.clone(), WindowKind::Main, profile, 0);
        listed.tab_ids = tabs.iter().map(|t| t.id.clone()).collect();
        std::sync::Arc::make_mut(&mut state.windows)
            .insert(window.clone(), std::sync::Arc::new(listed));
        std::sync::Arc::make_mut(&mut state.tabs).extend(
            tabs.into_iter()
                .map(|t| (t.id.clone(), std::sync::Arc::new(t))),
        );
        let shown = HashSet::from([TabId::new("shown")]);
        assert_eq!(
            recent_tabs_to_reload(&state, &shown, 4, now),
            vec![TabId::new("newest"), TabId::new("second")]
        );
        assert_eq!(
            recent_tabs_to_reload(&state, &shown, 1, now),
            vec![TabId::new("newest")]
        );
    }
}
