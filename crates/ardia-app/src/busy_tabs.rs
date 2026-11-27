use std::collections::{HashMap, HashSet};
use std::net::Ipv6Addr;

use ardia_engine::EngineTabId;
use ardia_state::actions::Action;
use ardia_state::model::{Millis, PageKind};
use ardia_state::settings::SettingsPatch;
use ardia_state::tabs::Tab;
use ardia_state::windows::{Toast, ToastKind, WindowKind};
use ardia_state::{BrowserState, TabId, WindowId};
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;

pub const BUSY_TICK_MS: Millis = 10_000;
pub const HOT_CORES: f64 = 0.7;
pub const SUSTAINED_MS: Millis = 120_000;
const LONGEST_GAP_MS: Millis = BUSY_TICK_MS * 5 / 2;
const OWNERS_FRESH_MS: Millis = 5 * 60_000;
const QUIET_AFTER_WARNING_MS: Millis = 120 * 60_000;
const WARNING_HOLD_MS: Millis = 20_000;
const CONFIRM_MS: Millis = 2_600;
const NAME_CHARS: usize = 24;
const ICON: &str = "bolt.fill";
const ASLEEP_ICON: &str = "moon.zzz";

pub use ardia_ui::popovers::toast::{BUSY_TAB_ACTION, BUSY_TAB_KEEP, BUSY_TAB_SLEEP};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CpuReading {
    pub pid: i32,
    pub started: f64,
    pub cpu_ms: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Reading {
    at: Millis,
    cpu_ms: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProcessHeat {
    pub started: f64,
    readings: Vec<Reading>,
    pub cores: f64,
    pub busy_since: Option<Millis>,
}

fn cpu_at(window: &[Reading], at: Millis) -> Option<f64> {
    let before = window.first()?;
    if before.at > at {
        return None;
    }
    let Some(after) = window.iter().find(|r| r.at >= at) else {
        return Some(before.cpu_ms);
    };
    if after == before {
        return Some(before.cpu_ms);
    }
    Some(
        before.cpu_ms
            + (after.cpu_ms - before.cpu_ms) * (at - before.at) as f64
                / (after.at - before.at) as f64,
    )
}

pub fn read_heat(
    prev: &HashMap<i32, ProcessHeat>,
    readings: &[CpuReading],
    now: Millis,
    hot_cores: f64,
) -> HashMap<i32, ProcessHeat> {
    let mut next = HashMap::new();
    let mut seen = HashSet::new();
    for r in readings {
        let valid = r.pid > 0
            && r.started.is_finite()
            && r.started >= 0.0
            && r.cpu_ms.is_finite()
            && r.cpu_ms >= 0.0
            && seen.insert(r.pid);
        if !valid {
            continue;
        }
        let was = prev.get(&r.pid);
        let last = was.and_then(|w| w.readings.last()).copied();
        let continued = match (was, last) {
            (Some(was), Some(last)) => {
                was.started == r.started
                    && now > last.at
                    && now - last.at <= LONGEST_GAP_MS
                    && r.cpu_ms >= last.cpu_ms
            }
            _ => false,
        };
        let kept: &[Reading] = match (continued, was) {
            (true, Some(was)) => &was.readings,
            _ => &[],
        };
        let mut from = 0;
        while from + 1 < kept.len() && kept[from + 1].at <= now - SUSTAINED_MS {
            from += 1;
        }
        let mut window: Vec<Reading> = kept[from..].to_vec();
        window.push(Reading {
            at: now,
            cpu_ms: r.cpu_ms,
        });
        let cores = match (continued, last) {
            (true, Some(last)) => (r.cpu_ms - last.cpu_ms) / (now - last.at) as f64,
            _ => 0.0,
        };
        let busy = cpu_at(&window, now - SUSTAINED_MS)
            .is_some_and(|at_cutoff| (r.cpu_ms - at_cutoff) / SUSTAINED_MS as f64 >= hot_cores);
        let busy_since = busy.then(|| was.and_then(|w| w.busy_since).unwrap_or(now));
        next.insert(
            r.pid,
            ProcessHeat {
                started: r.started,
                readings: window,
                cores,
                busy_since,
            },
        );
    }
    next
}

pub fn sustained_busy(heat: &HashMap<i32, ProcessHeat>) -> Vec<i32> {
    let mut pids: Vec<i32> = heat
        .iter()
        .filter(|(_, h)| h.busy_since.is_some())
        .map(|(pid, _)| *pid)
        .collect();
    pids.sort_unstable();
    pids
}

fn web_parts(address: &str) -> Option<(String, String)> {
    let url = url::Url::parse(address).ok()?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = match url.host()? {
        url::Host::Ipv6(ip) => format!("[{ip}]"),
        other => other.to_string().trim_end_matches('.').to_ascii_lowercase(),
    };
    Some((scheme.to_owned(), host))
}

pub fn site_to_keep_active(address: &str) -> Option<String> {
    let (_, host) = web_parts(address)?;
    let site = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    (!site.is_empty()).then_some(site)
}

fn label_chars(label: &str) -> bool {
    !label.is_empty()
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn rule_matches(rule: &str, page_scheme: &str, page_host: &str) -> bool {
    let rule = rule.trim().to_lowercase();
    let (scheme, rest) = match rule.split_once("://") {
        Some((scheme @ ("http" | "https"), rest)) => (Some(scheme.to_owned()), rest.to_owned()),
        Some(_) => return false,
        None => (None, rule.clone()),
    };
    let rest = rest.strip_suffix('/').unwrap_or(&rest);
    if scheme
        .as_deref()
        .is_some_and(|scheme| scheme != page_scheme)
    {
        return false;
    }
    if let Some(inner) = rest.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        let shape = !inner.is_empty() && inner.bytes().all(|b| b.is_ascii_hexdigit() || b == b':');
        let canonical = inner
            .parse::<Ipv6Addr>()
            .is_ok_and(|ip| ip.to_string() == inner);
        return shape && canonical && page_host == rest;
    }
    let (exact, rest) = match rest.strip_prefix('.') {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    let kept = rest.strip_suffix('.').unwrap_or(rest);
    if !kept.split('.').all(label_chars) {
        return false;
    }
    page_host == kept || (!exact && page_host.ends_with(&format!(".{kept}")))
}

pub fn kept_active(address: &str, rules: &[String]) -> bool {
    let Some((scheme, host)) = web_parts(address) else {
        return false;
    };
    rules.iter().any(|rule| rule_matches(rule, &scheme, &host))
}

pub fn toast_name(raw: &str) -> String {
    let mut clean = String::with_capacity(raw.len());
    let mut space = false;
    for c in raw.chars() {
        let blank = c.is_whitespace()
            || c.is_control()
            || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}' | '\u{00AD}' | '\u{2028}' | '\u{2029}');
        if blank {
            space = true;
            continue;
        }
        if space && !clean.is_empty() {
            clean.push(' ');
        }
        space = false;
        clean.push(c);
    }
    let chars: Vec<char> = clean.chars().collect();
    if chars.len() > NAME_CHARS {
        let cut: String = chars[..NAME_CHARS - 1].iter().collect();
        format!("{}…", cut.trim_end())
    } else {
        clean
    }
}

pub fn warning_title(names: &[String], site: Option<&str>) -> String {
    match names {
        [one] => format!("“{one}” is using a lot of power"),
        many => format!(
            "{} {} tabs are using a lot of power",
            many.len(),
            site.map(toast_name)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "background".into())
        ),
    }
}

#[derive(Clone, Debug, Default)]
pub struct Owner {
    started: f64,
    at: Millis,
    tab_ids: Vec<TabId>,
    urls: HashMap<TabId, String>,
}

#[derive(Clone, Debug)]
struct Warning {
    window: WindowId,
    pid: i32,
    started: f64,
    tab_ids: Vec<TabId>,
    warned_urls: HashMap<TabId, String>,
    site: Option<String>,
    name: String,
    generation: u64,
}

#[derive(Debug, Default)]
pub struct BusyBook {
    heat: HashMap<i32, ProcessHeat>,
    owners: HashMap<i32, Owner>,
    hidden_since: HashMap<TabId, Millis>,
    quiet_until: HashMap<TabId, Millis>,
    kept_tabs: HashSet<TabId>,
    warnings: HashMap<u64, Warning>,
    ticking: bool,
    unsupported: bool,
    generation: u64,
    last_tick_at: Option<Millis>,
    watching: Option<bool>,
    sites: Option<Vec<String>>,
}

impl BusyBook {
    fn drop_work(&mut self) {
        self.hidden_since.clear();
        self.generation += 1;
        self.heat.clear();
        self.owners.clear();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SleepOutcome {
    Gone,
    Shown,
    Already,
    Kept,
    Dropped,
    Asleep,
}

impl AppCoordinator {
    fn watching_busy_tabs(&self, state: &BrowserState) -> bool {
        state.settings.busy_tab_warnings && !self.is_shutting_down()
    }

    fn shown_family(&self, state: &BrowserState) -> HashSet<TabId> {
        let shown: Vec<TabId> = crate::tab_lifecycle::shown_everywhere(state)
            .into_iter()
            .collect();
        ardia_state::pin_share::with_shared_family(state, &shown)
            .into_iter()
            .collect()
    }

    fn is_private_tab(state: &BrowserState, tab: &Tab) -> bool {
        tab.is_incognito()
            || state
                .window(tab.window_id.as_str())
                .is_some_and(|w| w.kind == WindowKind::Incognito)
    }

    fn can_sleep_tab(&self, state: &BrowserState, tab: &Tab, shown: &HashSet<TabId>) -> bool {
        let asleep = matches!(tab.page.kind, PageKind::Asleep | PageKind::Frozen { .. })
            || self
                .bridge
                .lock()
                .applied
                .get(&tab.id)
                .is_some_and(|applied| applied.asleep);
        !tab.url.is_empty()
            && !asleep
            && self.engine_tab(&tab.id).is_some()
            && !shown.contains(&tab.id)
            && state.tab(tab.id.as_str()).is_some()
    }

    fn hidden_and_idle(
        &self,
        state: &BrowserState,
        id: &TabId,
        shown: &HashSet<TabId>,
        now: Millis,
    ) -> bool {
        let Some(tab) = state.tab(id.as_str()) else {
            return false;
        };
        if Self::is_private_tab(state, tab)
            || !self.can_sleep_tab(state, tab, shown)
            || self.tab_in_use(tab)
        {
            return false;
        }
        let since = self
            .bridge
            .lock()
            .lifecycle
            .busy
            .hidden_since
            .get(id)
            .copied();
        since.is_some_and(|since| now - since >= SUSTAINED_MS)
            && now - tab.last_active_at >= SUSTAINED_MS
    }

    fn kept_running(&self, state: &BrowserState, id: &TabId) -> bool {
        self.bridge.lock().lifecycle.busy.kept_tabs.contains(id)
            || state
                .tab(id.as_str())
                .is_some_and(|t| kept_active(&t.url, &state.settings.keep_active_sites))
    }

    fn eligible_to_sleep(
        &self,
        state: &BrowserState,
        id: &TabId,
        shown: &HashSet<TabId>,
        now: Millis,
    ) -> bool {
        self.hidden_and_idle(state, id, shown, now) && !self.kept_running(state, id)
    }

    fn busy_tabs_of(
        &self,
        state: &BrowserState,
        owner: &Owner,
        shown: &HashSet<TabId>,
        now: Millis,
    ) -> Option<Vec<TabId>> {
        if owner.tab_ids.is_empty()
            || !owner
                .tab_ids
                .iter()
                .all(|id| self.hidden_and_idle(state, id, shown, now))
        {
            return None;
        }
        let mut groups: Vec<(String, Vec<TabId>)> = Vec::new();
        for id in &owner.tab_ids {
            let host = state
                .tab(id.as_str())
                .and_then(|t| site_to_keep_active(&t.url))
                .unwrap_or_default();
            match groups.iter_mut().find(|(h, _)| *h == host) {
                Some((_, ids)) => ids.push(id.clone()),
                None => groups.push((host, vec![id.clone()])),
            }
        }
        let quiet = |id: &TabId| {
            self.bridge
                .lock()
                .lifecycle
                .busy
                .quiet_until
                .get(id)
                .is_some_and(|until| *until > now)
        };
        groups.into_iter().map(|(_, ids)| ids).find(|ids| {
            !ids.iter()
                .any(|id| self.kept_running(state, id) || quiet(id))
        })
    }

    pub(crate) fn note_tab_left_screen(&self, tab: &TabId) {
        let now = ardia_state::store::now_ms();
        let mut bridge = self.bridge.lock();
        let busy = &mut bridge.lifecycle.busy;
        if busy.watching == Some(true) {
            busy.hidden_since.entry(tab.clone()).or_insert(now);
        }
    }

    pub(crate) fn note_busy_settings(&self, state: &BrowserState) {
        let on = state.settings.busy_tab_warnings;
        let (turned_off, warned) = {
            let mut bridge = self.bridge.lock();
            let busy = &mut bridge.lifecycle.busy;
            let sites = Some(state.settings.keep_active_sites.clone());
            if busy.sites.is_some() && busy.sites != sites {
                busy.kept_tabs.clear();
            }
            busy.sites = sites;
            let before = busy.watching.replace(on);
            let turned_off = before == Some(true) && !on;
            let warned: Vec<(WindowId, u64)> = if turned_off {
                busy.drop_work();
                busy.warnings
                    .drain()
                    .map(|(id, w)| (w.window, id))
                    .collect()
            } else {
                Vec::new()
            };
            (turned_off, warned)
        };
        if turned_off {
            for (window, id) in warned {
                self.dispatch_quietly(Action::DismissToast { window, id });
            }
        }
    }

    fn has_hidden_loaded_tab(&self, state: &BrowserState, shown: &HashSet<TabId>) -> bool {
        let bound: Vec<TabId> = self.bridge.lock().tabs.lefts();
        bound.iter().any(|id| {
            state.tab(id.as_str()).is_some_and(|t| {
                !Self::is_private_tab(state, t) && self.can_sleep_tab(state, t, shown)
            })
        })
    }

    pub(crate) fn tend_busy_tabs(&self, state: &BrowserState, now: Millis) {
        let watching = self.watching_busy_tabs(state);
        {
            let mut bridge = self.bridge.lock();
            let busy = &mut bridge.lifecycle.busy;
            busy.watching
                .get_or_insert(state.settings.busy_tab_warnings);
            let due = busy.last_tick_at.is_none_or(|at| now - at >= BUSY_TICK_MS);
            if !watching || busy.unsupported || busy.ticking || !due {
                return;
            }
        }
        let shown = self.shown_family(state);
        if !self.has_hidden_loaded_tab(state, &shown) {
            return;
        }
        let bound: Vec<TabId> = self.bridge.lock().tabs.lefts();
        {
            let mut bridge = self.bridge.lock();
            let busy = &mut bridge.lifecycle.busy;
            busy.ticking = true;
            busy.last_tick_at = Some(now);
            busy.hidden_since
                .retain(|id, _| state.tab(id.as_str()).is_some() && !shown.contains(id));
            busy.hidden_since.retain(|id, since| {
                state
                    .tab(id.as_str())
                    .is_none_or(|t| t.last_active_at < *since)
            });
            for id in &bound {
                if state.tab(id.as_str()).is_some() && !shown.contains(id) {
                    busy.hidden_since.entry(id.clone()).or_insert(now);
                }
            }
            busy.quiet_until.retain(|_, until| *until > now);
            busy.kept_tabs.retain(|id| state.tab(id.as_str()).is_some());
        }
        let generation = self.bridge.lock().lifecycle.busy.generation;
        let (done, read) = futures::channel::oneshot::channel();
        let sampling = std::thread::Builder::new()
            .name("ardia-child-cpu".into())
            .spawn(move || {
                let _ = done.send(crate::child_cpu::sample());
            });
        if sampling.is_err() {
            self.bridge.lock().lifecycle.busy.ticking = false;
            return;
        }
        let me = self.weak();
        self.spawn(async move {
            let readings = read.await.ok().flatten();
            let Some(me) = me.upgrade() else {
                return;
            };
            me.busy_tick_read(readings, now, generation);
        });
    }

    fn busy_still_wanted(&self, generation: u64) -> bool {
        let state = self.store().snapshot();
        self.watching_busy_tabs(&state)
            && self.bridge.lock().lifecycle.busy.generation == generation
    }

    fn busy_tick_read(&self, readings: Option<Vec<CpuReading>>, now: Millis, generation: u64) {
        let wanted = self.busy_still_wanted(generation);
        let Some(readings) = readings else {
            let mut bridge = self.bridge.lock();
            bridge.lifecycle.busy.ticking = false;
            if wanted {
                bridge.lifecycle.busy.unsupported = true;
            }
            return;
        };
        if !wanted {
            self.bridge.lock().lifecycle.busy.ticking = false;
            return;
        }
        let state = self.store().snapshot();
        let busy_pids = {
            let mut bridge = self.bridge.lock();
            let busy = &mut bridge.lifecycle.busy;
            busy.heat = read_heat(&busy.heat, &readings, now, HOT_CORES);
            let heat = &busy.heat;
            busy.owners.retain(|pid, owner| {
                heat.get(pid).is_some_and(|h| h.started == owner.started)
                    && owner.tab_ids.iter().all(|id| {
                        state
                            .tab(id.as_str())
                            .is_some_and(|t| owner.urls.get(id) == Some(&t.url))
                    })
            });
            sustained_busy(&busy.heat)
        };
        if busy_pids.is_empty() {
            self.bridge.lock().lifecycle.busy.ticking = false;
            return;
        }
        self.warn_for_busy(busy_pids, now, generation);
    }

    fn focused_tab_window(state: &BrowserState) -> Option<WindowId> {
        state
            .focus_order
            .iter()
            .find(|w| state.window(w.as_str()).is_some_and(|w| w.kind.has_tabs()))
            .cloned()
    }

    fn toast_slot_free(&self, window: &WindowId, allowed: Option<u64>) -> bool {
        let state = self.store().snapshot();
        let now = ardia_state::store::now_ms();
        state.window(window.as_str()).is_some_and(|w| {
            w.chrome
                .toasts
                .iter()
                .filter(|t| t.expires_at.is_none_or(|at| at > now))
                .all(|t| Some(t.id) == allowed)
        })
    }

    fn session_tab_map(&self) -> HashMap<i64, TabId> {
        let Some(engine) = self.engine() else {
            return HashMap::new();
        };
        let bound: Vec<(TabId, EngineTabId)> = self
            .bridge
            .lock()
            .tabs
            .iter()
            .map(|(tab, engine_tab)| (tab.clone(), *engine_tab))
            .collect();
        let mut sessions = HashMap::with_capacity(bound.len());
        for (tab, engine_tab) in &bound {
            if let Ok(info) = engine.tab_info(*engine_tab) {
                sessions.insert(i64::from(info.tab_id), tab.clone());
            }
        }
        sessions
    }

    fn fresh_owners(
        &self,
        pids: Vec<i32>,
        now: Millis,
        then: impl FnOnce(&AppCoordinator, Option<HashMap<i32, Owner>>) + 'static,
    ) {
        let Some(engine) = self.engine().filter(|engine| engine.is_started()) else {
            then(self, None);
            return;
        };
        let before: HashMap<TabId, String> = self
            .store()
            .snapshot()
            .tabs
            .values()
            .map(|t| (t.id.clone(), t.url.clone()))
            .collect();
        let reply = engine.call_service("ac_tasks_list", "", "{}");
        let me = self.weak();
        self.spawn(async move {
            let tasks = reply.await.ok();
            let Some(me) = me.upgrade() else {
                return;
            };
            let found = tasks.map(|tasks| me.owners_from_tasks(&tasks, &pids, &before, now));
            then(&me, found);
        });
    }

    fn owners_from_tasks(
        &self,
        tasks: &Value,
        pids: &[i32],
        before: &HashMap<TabId, String>,
        now: Millis,
    ) -> HashMap<i32, Owner> {
        let sessions = self.session_tab_map();
        let heat_started: HashMap<i32, f64> = {
            let bridge = self.bridge.lock();
            pids.iter()
                .map(|pid| {
                    (
                        *pid,
                        bridge
                            .lifecycle
                            .busy
                            .heat
                            .get(pid)
                            .map_or(-1.0, |h| h.started),
                    )
                })
                .collect()
        };
        let mut found: HashMap<i32, Owner> = pids
            .iter()
            .map(|pid| {
                (
                    *pid,
                    Owner {
                        started: heat_started[pid],
                        at: now,
                        ..Owner::default()
                    },
                )
            })
            .collect();
        let rows = tasks
            .get("tasks")
            .and_then(Value::as_array)
            .or_else(|| tasks.as_array());
        for task in rows.into_iter().flatten() {
            let Some(pid) = task
                .get("pid")
                .and_then(Value::as_i64)
                .and_then(|p| i32::try_from(p).ok())
            else {
                continue;
            };
            let Some(owner) = found.get_mut(&pid) else {
                continue;
            };
            for id in task
                .get("tabIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(tab) = id.as_i64().and_then(|n| sessions.get(&n)) else {
                    continue;
                };
                if !owner.tab_ids.contains(tab) {
                    owner.tab_ids.push(tab.clone());
                }
            }
        }
        let state = self.store().snapshot();
        found.retain(|_, owner| {
            !owner.tab_ids.iter().any(|id| {
                before.contains_key(id)
                    && state
                        .tab(id.as_str())
                        .is_none_or(|t| Some(&t.url) != before.get(id))
            })
        });
        for owner in found.values_mut() {
            for id in &owner.tab_ids {
                if let Some(t) = state.tab(id.as_str()) {
                    owner.urls.insert(id.clone(), t.url.clone());
                }
            }
        }
        found
    }

    fn warn_for_busy(&self, pids: Vec<i32>, now: Millis, generation: u64) {
        let finish = |me: &AppCoordinator| me.bridge.lock().lifecycle.busy.ticking = false;
        let state = self.store().snapshot();
        let Some(window) = Self::focused_tab_window(&state) else {
            return finish(self);
        };
        if !self.toast_slot_free(&window, None) {
            return finish(self);
        }
        let stale: Vec<i32> = {
            let bridge = self.bridge.lock();
            let busy = &bridge.lifecycle.busy;
            pids.iter()
                .copied()
                .filter(|pid| {
                    busy.owners.get(pid).is_none_or(|known| {
                        Some(known.started) != busy.heat.get(pid).map(|h| h.started)
                            || now - known.at >= OWNERS_FRESH_MS
                    })
                })
                .collect()
        };
        let asked = stale.clone();
        let none_stale = stale.is_empty();
        let next =
            move |me: &AppCoordinator| me.warn_with_owners(pids, stale, window, now, generation);
        if none_stale {
            next(self);
            return;
        }
        self.fresh_owners(asked, now, move |me, found| {
            let Some(found) = found.filter(|_| me.busy_still_wanted(generation)) else {
                me.bridge.lock().lifecycle.busy.ticking = false;
                return;
            };
            me.bridge.lock().lifecycle.busy.owners.extend(found);
            next(me);
        });
    }

    fn warn_with_owners(
        &self,
        pids: Vec<i32>,
        stale: Vec<i32>,
        window: WindowId,
        now: Millis,
        generation: u64,
    ) {
        let state = self.store().snapshot();
        let shown = self.shown_family(&state);
        let owners = self.bridge.lock().lifecycle.busy.owners.clone();
        let candidates: Vec<i32> = pids
            .into_iter()
            .filter(|pid| {
                owners
                    .get(pid)
                    .is_some_and(|owner| self.busy_tabs_of(&state, owner, &shown, now).is_some())
            })
            .collect();
        if candidates.is_empty() {
            self.bridge.lock().lifecycle.busy.ticking = false;
            return;
        }
        let confirming = candidates.clone();
        let confirm = move |me: &AppCoordinator, confirmed: HashMap<i32, Owner>| {
            me.bridge.lock().lifecycle.busy.ticking = false;
            if !me.busy_still_wanted(generation) || !me.toast_slot_free(&window, None) {
                return;
            }
            let state = me.store().snapshot();
            let shown = me.shown_family(&state);
            for pid in &confirming {
                let Some(owner) = confirmed.get(pid) else {
                    continue;
                };
                let started = me
                    .bridge
                    .lock()
                    .lifecycle
                    .busy
                    .heat
                    .get(pid)
                    .map(|h| h.started);
                if Some(owner.started) != started {
                    continue;
                }
                me.bridge
                    .lock()
                    .lifecycle
                    .busy
                    .owners
                    .insert(*pid, owner.clone());
                if let Some(tabs) = me.busy_tabs_of(&state, owner, &shown, now) {
                    me.warn_about_tabs(&window, *pid, tabs, now, generation);
                    return;
                }
            }
        };
        let all_fresh = candidates.iter().all(|pid| stale.contains(pid));
        if all_fresh {
            let confirmed: HashMap<i32, Owner> = candidates
                .iter()
                .filter_map(|pid| owners.get(pid).map(|o| (*pid, o.clone())))
                .collect();
            confirm(self, confirmed);
            return;
        }
        self.fresh_owners(candidates, now, move |me, found| match found {
            Some(found) => confirm(me, found),
            None => me.bridge.lock().lifecycle.busy.ticking = false,
        });
    }

    fn tab_name(state: &BrowserState, id: &TabId, fallback: &Tab) -> String {
        let tab = state.tab(id.as_str()).map_or(fallback, |t| &**t);
        let titled = tab
            .custom_title
            .as_deref()
            .filter(|t| !t.is_empty())
            .unwrap_or(&tab.title);
        let name = toast_name(titled);
        if !name.is_empty() {
            return name;
        }
        let site = toast_name(&site_to_keep_active(&tab.url).unwrap_or_default());
        if site.is_empty() {
            "A background tab".into()
        } else {
            site
        }
    }

    fn push_busy_toast(
        &self,
        window: &WindowId,
        message: String,
        icon: &str,
        action: Option<String>,
        hold: Millis,
    ) -> u64 {
        let now = ardia_state::store::now_ms();
        let id = ardia_ui::popovers::toast::next_toast_id();
        self.dispatch_quietly(Action::PushToast {
            window: window.clone(),
            toast: Toast {
                id,
                kind: ToastKind::Info,
                message,
                action,
                icon: Some(icon.to_owned()),
                created_at: now,
                expires_at: Some(now + hold),
            },
        });
        id
    }

    fn warn_about_tabs(
        &self,
        window: &WindowId,
        pid: i32,
        tab_ids: Vec<TabId>,
        now: Millis,
        generation: u64,
    ) {
        let state = self.store().snapshot();
        let Some(first) = tab_ids
            .first()
            .and_then(|id| state.tab(id.as_str()))
            .cloned()
        else {
            return;
        };
        let Some(started) = self
            .bridge
            .lock()
            .lifecycle
            .busy
            .heat
            .get(&pid)
            .map(|h| h.started)
        else {
            return;
        };
        let site = site_to_keep_active(&first.url);
        let warned_urls: HashMap<TabId, String> = tab_ids
            .iter()
            .filter_map(|id| state.tab(id.as_str()).map(|t| (id.clone(), t.url.clone())))
            .collect();
        let name = Self::tab_name(&state, &first.id, &first);
        let names: Vec<String> = tab_ids
            .iter()
            .map(|id| Self::tab_name(&state, id, &first))
            .collect();
        {
            let mut bridge = self.bridge.lock();
            for id in &tab_ids {
                bridge
                    .lifecycle
                    .busy
                    .quiet_until
                    .insert(id.clone(), now + QUIET_AFTER_WARNING_MS);
            }
        }
        let title = warning_title(&names, site.as_deref());
        let id = ardia_ui::popovers::toast::next_toast_id();
        let action = format!("{BUSY_TAB_ACTION}{id}");
        let created = ardia_state::store::now_ms();
        self.bridge.lock().lifecycle.busy.warnings.insert(
            id,
            Warning {
                window: window.clone(),
                pid,
                started,
                tab_ids,
                warned_urls,
                site,
                name,
                generation,
            },
        );
        self.dispatch_quietly(Action::PushToast {
            window: window.clone(),
            toast: Toast {
                id,
                kind: ToastKind::Info,
                message: title,
                action: Some(action),
                icon: Some(ICON.to_owned()),
                created_at: created,
                expires_at: Some(created + WARNING_HOLD_MS),
            },
        });
        log::info!("a background tab is using a lot of power");
    }

    pub(crate) fn busy_toast_command(&self, command: &str) -> bool {
        if let Some(id) = command
            .strip_prefix(BUSY_TAB_SLEEP)
            .and_then(|id| id.parse::<u64>().ok())
        {
            self.sleep_busy_tabs(id);
            return true;
        }
        if let Some(id) = command
            .strip_prefix(BUSY_TAB_KEEP)
            .and_then(|id| id.parse::<u64>().ok())
        {
            self.keep_busy_tabs_running(id);
            return true;
        }
        false
    }

    fn still_hot(&self, pid: i32, started: f64) -> bool {
        self.bridge
            .lock()
            .lifecycle
            .busy
            .heat
            .get(&pid)
            .is_some_and(|h| h.started == started && h.busy_since.is_some())
    }

    fn sleep_busy_tabs(&self, warning_id: u64) {
        let Some(warning) = self
            .bridge
            .lock()
            .lifecycle
            .busy
            .warnings
            .get(&warning_id)
            .cloned()
        else {
            return;
        };
        if !self.busy_still_wanted(warning.generation)
            || !self.still_hot(warning.pid, warning.started)
        {
            return;
        }
        let now = ardia_state::store::now_ms();
        self.fresh_owners(vec![warning.pid], now, move |me, found| {
            let Some(owner) = found.and_then(|mut f| f.remove(&warning.pid)) else {
                return;
            };
            if !me.busy_still_wanted(warning.generation)
                || !me.still_hot(warning.pid, warning.started)
            {
                return;
            }
            let state = me.store().snapshot();
            let shown = me.shown_family(&state);
            let now = ardia_state::store::now_ms();
            let still: Vec<TabId> = warning
                .tab_ids
                .iter()
                .filter(|id| {
                    owner.tab_ids.contains(id) && me.eligible_to_sleep(&state, id, &shown, now)
                })
                .cloned()
                .collect();
            if still.is_empty() {
                return;
            }
            let outcomes: Vec<SleepOutcome> = still
                .iter()
                .map(|id| {
                    me.sleep_asked(id, |me| {
                        let now_state = me.store().snapshot();
                        let shown = me.shown_family(&now_state);
                        me.busy_still_wanted(warning.generation)
                            && now_state
                                .tab(id.as_str())
                                .is_some_and(|t| Some(&t.url) == warning.warned_urls.get(id))
                            && me.still_hot(warning.pid, warning.started)
                            && me.eligible_to_sleep(
                                &now_state,
                                id,
                                &shown,
                                ardia_state::store::now_ms(),
                            )
                    })
                })
                .collect();
            if outcomes.iter().all(|o| *o == SleepOutcome::Dropped) {
                return;
            }
            let asleep: Vec<&TabId> = still
                .iter()
                .zip(&outcomes)
                .filter(|(_, o)| **o == SleepOutcome::Asleep)
                .map(|(id, _)| id)
                .collect();
            let kept: Vec<&TabId> = still
                .iter()
                .zip(&outcomes)
                .filter(|(_, o)| **o == SleepOutcome::Kept)
                .map(|(id, _)| id)
                .collect();
            if !me.busy_still_wanted(warning.generation)
                || !me.toast_slot_free(&warning.window, Some(warning_id))
            {
                return;
            }
            let state = me.store().snapshot();
            let fallback = state.tab(still[0].as_str()).cloned();
            let name_of = |id: &TabId| {
                fallback
                    .as_ref()
                    .map_or_else(|| warning.name.clone(), |f| Self::tab_name(&state, id, f))
            };
            if !asleep.is_empty() {
                let message = if asleep.len() > 1 {
                    format!("{} tabs are asleep", asleep.len())
                } else {
                    format!("“{}” is asleep", name_of(asleep[0]))
                };
                me.push_busy_toast(&warning.window, message, ASLEEP_ICON, None, CONFIRM_MS);
            } else if let Some(first) = kept.first() {
                me.push_busy_toast(
                    &warning.window,
                    format!("“{}” stayed awake", name_of(first)),
                    ICON,
                    None,
                    CONFIRM_MS,
                );
            }
        });
    }

    fn on_warned_site(me: &AppCoordinator, warning: &Warning) -> bool {
        let state = me.store().snapshot();
        warning.tab_ids.iter().all(|id| {
            state
                .tab(id.as_str())
                .is_some_and(|t| site_to_keep_active(&t.url) == warning.site)
        })
    }

    fn keep_busy_tabs_running(&self, warning_id: u64) {
        let Some(warning) = self
            .bridge
            .lock()
            .lifecycle
            .busy
            .warnings
            .get(&warning_id)
            .cloned()
        else {
            return;
        };
        if !self.busy_still_wanted(warning.generation) || !Self::on_warned_site(self, &warning) {
            return;
        }
        let Some(site) = warning.site.clone() else {
            {
                let mut bridge = self.bridge.lock();
                for id in &warning.tab_ids {
                    bridge.lifecycle.busy.kept_tabs.insert(id.clone());
                }
            }
            self.push_busy_toast(
                &warning.window,
                format!("“{}” will keep running", warning.name),
                ICON,
                None,
                CONFIRM_MS,
            );
            return;
        };
        let Some(engine) = self.engine().filter(|engine| engine.is_started()) else {
            return;
        };
        let reply = engine.call_service(
            "ac_memory_saver",
            "",
            &json!({ "validate": site }).to_string(),
        );
        let me = self.weak();
        self.spawn(async move {
            let valid = reply
                .await
                .ok()
                .and_then(|v| v.get("valid").and_then(Value::as_bool))
                .unwrap_or(false);
            let Some(me) = me.upgrade() else {
                return;
            };
            if !valid
                || !me.busy_still_wanted(warning.generation)
                || !Self::on_warned_site(&me, &warning)
            {
                return;
            }
            let mut sites = me.store().snapshot().settings.keep_active_sites.clone();
            if !sites.contains(&site) {
                sites.push(site.clone());
                me.dispatch_quietly(Action::UpdateSettings {
                    patch: SettingsPatch::new().set("keepActiveSites", sites),
                    from_sync: false,
                });
            }
            let saved = me
                .store()
                .snapshot()
                .settings
                .keep_active_sites
                .contains(&site);
            if saved && me.toast_slot_free(&warning.window, Some(warning_id)) {
                me.push_busy_toast(
                    &warning.window,
                    format!("{} will keep running", toast_name(&site)),
                    ICON,
                    None,
                    CONFIRM_MS,
                );
            }
        });
    }

    pub(crate) fn sleep_asked(
        &self,
        id: &TabId,
        still_wanted: impl Fn(&AppCoordinator) -> bool,
    ) -> SleepOutcome {
        let state = self.store().snapshot();
        let Some(tab) = state.tab(id.as_str()).cloned() else {
            return SleepOutcome::Gone;
        };
        if self.shown_family(&state).contains(id) {
            return SleepOutcome::Shown;
        }
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(id), self.engine()) else {
            return SleepOutcome::Already;
        };
        if self.tab_in_use(&tab) {
            return SleepOutcome::Kept;
        }
        if !still_wanted(self) {
            return SleepOutcome::Dropped;
        }
        let kept_by = engine
            .sleep_if_hidden(engine_tab, 0.0)
            .unwrap_or_else(|_| vec![-1]);
        if kept_by.is_empty() {
            return SleepOutcome::Asleep;
        }
        if !crate::tab_lifecycle::only_automatic_protections(&kept_by) {
            return SleepOutcome::Kept;
        }
        let after = self.store().snapshot();
        if after.tab(id.as_str()).is_none() || self.engine_tab(id) != Some(engine_tab) {
            return SleepOutcome::Gone;
        }
        if self.shown_family(&after).contains(id) {
            return SleepOutcome::Shown;
        }
        if self.tab_in_use(&tab) {
            return SleepOutcome::Kept;
        }
        if !still_wanted(self) {
            return SleepOutcome::Dropped;
        }
        match engine.discard(engine_tab) {
            Ok(true) => SleepOutcome::Asleep,
            _ => SleepOutcome::Kept,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(pid: i32, cpu_ms: f64) -> CpuReading {
        CpuReading {
            pid,
            started: 7.0,
            cpu_ms,
        }
    }

    #[test]
    fn a_renderer_is_busy_after_two_minutes_above_seven_tenths_of_a_core() {
        let mut heat = HashMap::new();
        let mut cpu = 0.0;
        for tick in 0..=12 {
            let now = tick * BUSY_TICK_MS;
            heat = read_heat(&heat, &[reading(9, cpu)], now, HOT_CORES);
            cpu += 0.8 * BUSY_TICK_MS as f64;
            if tick < 12 {
                assert!(sustained_busy(&heat).is_empty(), "tick {tick}");
            }
        }
        assert_eq!(sustained_busy(&heat), vec![9]);
        assert_eq!(heat[&9].busy_since, Some(12 * BUSY_TICK_MS));
        assert!((heat[&9].cores - 0.8).abs() < 1e-9);
    }

    #[test]
    fn a_light_or_restarted_process_never_counts_as_busy() {
        let mut heat = HashMap::new();
        let mut cpu = 0.0;
        for tick in 0..=14 {
            heat = read_heat(&heat, &[reading(9, cpu)], tick * BUSY_TICK_MS, HOT_CORES);
            cpu += 0.5 * BUSY_TICK_MS as f64;
        }
        assert!(sustained_busy(&heat).is_empty());
        let restarted = CpuReading {
            started: 8.0,
            ..reading(9, cpu * 4.0)
        };
        let heat = read_heat(&heat, &[restarted], 15 * BUSY_TICK_MS, HOT_CORES);
        assert_eq!(heat[&9].readings.len(), 1);
        let gap = read_heat(
            &heat,
            &[reading(9, cpu * 8.0)],
            30 * BUSY_TICK_MS,
            HOT_CORES,
        );
        assert_eq!(gap[&9].readings.len(), 1);
        let bad = read_heat(
            &HashMap::new(),
            &[reading(-1, 1.0), reading(3, f64::NAN)],
            0,
            HOT_CORES,
        );
        assert!(bad.is_empty());
    }

    #[test]
    fn kept_sites_match_hosts_subdomains_schemes_and_literals_like_the_old_app() {
        let rules = |r: &[&str]| r.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert!(kept_active(
            "https://music.youtube.com/x",
            &rules(&["youtube.com"])
        ));
        assert!(kept_active(
            "https://youtube.com/",
            &rules(&["YouTube.com/"])
        ));
        assert!(!kept_active(
            "https://music.youtube.com/",
            &rules(&[".youtube.com"])
        ));
        assert!(kept_active(
            "https://youtube.com/",
            &rules(&[".youtube.com"])
        ));
        assert!(!kept_active(
            "http://youtube.com/",
            &rules(&["https://youtube.com"])
        ));
        assert!(kept_active("http://[::1]:8080/", &rules(&["[::1]"])));
        assert!(!kept_active("http://[::1]/", &rules(&["[0::1]"])));
        assert!(!kept_active("ardia://history", &rules(&["history"])));
        assert!(!kept_active(
            "https://a.example/",
            &rules(&["a.example/path"])
        ));
    }

    #[test]
    fn sites_and_names_read_like_the_old_toasts() {
        assert_eq!(
            site_to_keep_active("https://www.Example.com./a").as_deref(),
            Some("example.com")
        );
        assert_eq!(site_to_keep_active("file:///tmp/a"), None);
        assert_eq!(toast_name("  Inbox\n\t(3)  "), "Inbox (3)");
        assert_eq!(toast_name("a\u{200B}b"), "a b");
        assert_eq!(
            toast_name("A very long tab title that goes on"),
            "A very long tab title t…"
        );
        assert_eq!(
            warning_title(&["YouTube".into()], Some("youtube.com")),
            "“YouTube” is using a lot of power"
        );
        assert_eq!(
            warning_title(&["a".into(), "b".into()], Some("youtube.com")),
            "2 youtube.com tabs are using a lot of power"
        );
        assert_eq!(
            warning_title(&["a".into(), "b".into()], None),
            "2 background tabs are using a lot of power"
        );
    }
}
