use std::collections::{HashMap, HashSet};
use std::time::Duration;

use ardia_engine::{EngineProfileId, EngineTabId, TabAction};
use ardia_state::model::Millis;
use ardia_state::settings::Settings;
use ardia_state::{BrowserState, ProfileId, TabId};

use crate::coordinator::AppCoordinator;

pub const CHECK_EVERY_MS: Millis = 60_000;
pub const RELEASE_EVERY_MS: Millis = 60_000;
const SETTLE: Duration = Duration::from_secs(5);
const PERSONAL: &str = "";

pub fn profile_unload_delay(settings: &Settings) -> Option<Millis> {
    if !settings.memory_saver {
        return None;
    }
    settings
        .unload_profiles_after
        .minutes()
        .map(|minutes| Millis::from(minutes) * 60_000)
}

pub fn unloadable(engine_profile: &str) -> bool {
    engine_profile != PERSONAL && !engine_profile.contains('@')
}

pub fn shown_engine_profiles(state: &BrowserState) -> HashSet<String> {
    state
        .windows
        .values()
        .filter_map(|window| {
            let profile = if window.profile_id.is_incognito() {
                window.profile_id.incognito_original()
            } else {
                window.profile_id.clone()
            };
            state
                .profiles
                .contains_key(&profile)
                .then(|| state.engine_profile(&profile))
        })
        .collect()
}

pub fn engine_profile_count(state: &BrowserState) -> usize {
    state
        .profiles
        .keys()
        .map(|profile| state.engine_profile(profile))
        .collect::<HashSet<_>>()
        .len()
}

#[derive(Debug, Default)]
pub struct IdleProfiles {
    idle_since: HashMap<String, Millis>,
    shown: HashSet<String>,
}

impl IdleProfiles {
    pub fn note_shown(&mut self, in_use: &HashSet<String>, now: Millis) {
        for profile in self.shown.difference(in_use) {
            self.idle_since.insert(profile.clone(), now);
        }
        for profile in in_use {
            self.idle_since.remove(profile);
        }
        self.shown = in_use.clone();
    }

    pub fn ready(
        &mut self,
        loaded: &HashSet<String>,
        in_use: &HashSet<String>,
        now: Millis,
        delay: Option<Millis>,
    ) -> Vec<String> {
        let Some(delay) = delay else {
            self.idle_since.clear();
            self.shown.clear();
            return Vec::new();
        };
        self.note_shown(in_use, now);
        self.idle_since
            .retain(|profile, _| loaded.contains(profile));
        let mut due: Vec<String> = Vec::new();
        for profile in loaded {
            if in_use.contains(profile) {
                continue;
            }
            let since = *self.idle_since.entry(profile.clone()).or_insert(now);
            if now - since >= delay {
                due.push(profile.clone());
            }
        }
        due.sort();
        due
    }

    pub fn due(&self, profile: &str, now: Millis, delay: Option<Millis>) -> bool {
        let Some(delay) = delay else {
            return false;
        };
        !self.shown.contains(profile)
            && self
                .idle_since
                .get(profile)
                .is_some_and(|since| now - since >= delay)
    }
}

#[derive(Debug, Default)]
pub struct ProfileUnloading {
    pub idle: IdleProfiles,
    pub unloaded: HashSet<String>,
    pub had_pages: HashSet<String>,
    pub last_check_at: Option<Millis>,
    pub last_release_at: Option<Millis>,
    pub eager_loaded: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnloadOutcome {
    Unloaded,
    Busy(String),
    Settling,
}

impl AppCoordinator {
    fn engine_ids_of(
        &self,
        state: &BrowserState,
        folder: &str,
    ) -> Vec<(ProfileId, EngineProfileId)> {
        state
            .profiles
            .keys()
            .filter(|profile| state.engine_profile(profile) == folder)
            .filter_map(|profile| self.engine_profile(profile).map(|id| (profile.clone(), id)))
            .collect()
    }

    fn loaded_engine_profiles(&self, state: &BrowserState) -> HashSet<String> {
        state
            .profiles
            .keys()
            .filter(|profile| self.engine_profile(profile).is_some())
            .map(|profile| state.engine_profile(profile))
            .collect()
    }

    pub(crate) fn note_tab_had_page(&self, tab: &TabId) {
        let state = self.store().snapshot();
        let Some(profile) = state
            .tab(tab.as_str())
            .map(|listed| listed.profile_id.clone())
        else {
            return;
        };
        if profile.is_incognito() {
            return;
        }
        let folder = state.engine_profile(&profile);
        let mut bridge = self.bridge.lock();
        bridge.lifecycle.profiles.had_pages.insert(folder.clone());
        bridge.lifecycle.profiles.unloaded.remove(&folder);
    }

    pub(crate) fn load_profiles_eagerly(&self) {
        let state = self.store().snapshot();
        if state.settings.load_profiles_when_opened {
            return;
        }
        {
            let mut bridge = self.bridge.lock();
            if bridge.lifecycle.profiles.eager_loaded {
                return;
            }
            bridge.lifecycle.profiles.eager_loaded = true;
        }
        for profile in state.profiles.keys().filter(|p| !p.is_incognito()) {
            let _ = self.resolve_profile(profile);
        }
    }

    pub(crate) fn tend_profiles(&self, state: &BrowserState, now: Millis) {
        let (check, release) = {
            let mut bridge = self.bridge.lock();
            let book = &mut bridge.lifecycle.profiles;
            let check = book
                .last_check_at
                .is_none_or(|at| now - at >= CHECK_EVERY_MS);
            let release = book
                .last_release_at
                .is_none_or(|at| now - at >= RELEASE_EVERY_MS);
            if check {
                book.last_check_at = Some(now);
            }
            if release {
                book.last_release_at = Some(now);
            }
            (check, release)
        };
        let shown = shown_engine_profiles(state);
        self.bridge
            .lock()
            .lifecycle
            .profiles
            .idle
            .note_shown(&shown, now);
        if check {
            self.check_idle_profiles(state, now);
        }
        if release {
            self.release_unused_profiles(state);
        }
    }

    fn check_idle_profiles(&self, state: &BrowserState, now: Millis) {
        let delay = profile_unload_delay(&state.settings);
        let shown = shown_engine_profiles(state);
        if delay.is_none() {
            let mut bridge = self.bridge.lock();
            bridge
                .lifecycle
                .profiles
                .idle
                .ready(&HashSet::new(), &HashSet::new(), now, None);
            return;
        }
        if engine_profile_count(state) < 2 {
            return;
        }
        let loaded: HashSet<String> = self
            .loaded_engine_profiles(state)
            .into_iter()
            .filter(|folder| unloadable(folder))
            .collect();
        let due = self
            .bridge
            .lock()
            .lifecycle
            .profiles
            .idle
            .ready(&loaded, &shown, now, delay);
        for folder in due {
            self.unload_idle_profile(&folder, now, false);
        }
    }

    fn kept_from_unloading_by(
        &self,
        state: &BrowserState,
        tab: &TabId,
        shown: &HashSet<TabId>,
    ) -> Option<&'static str> {
        let Some(listed) = state.tab(tab.as_str()) else {
            return Some("tab");
        };
        if shown.contains(tab) {
            return Some("visible");
        }
        if listed.live.peek {
            return Some("ownWindow");
        }
        let bridge = self.bridge.lock();
        if bridge.pending_tabs.contains(tab) || bridge.closing_rows.contains(tab) {
            return Some("moving");
        }
        if bridge
            .media_access
            .get(tab)
            .is_some_and(|access| access.camera || access.microphone || access.screen)
        {
            return Some("capture");
        }
        if bridge.media.book.pip_open.contains(tab) {
            return Some("pictureInPicture");
        }
        if bridge.devtools_open.contains(tab) {
            return Some("devTools");
        }
        None
    }

    pub(crate) fn unload_idle_profile(
        &self,
        folder: &str,
        now: Millis,
        settled: bool,
    ) -> UnloadOutcome {
        let state = self.store().snapshot();
        let delay = profile_unload_delay(&state.settings);
        let in_use = shown_engine_profiles(&state).contains(folder);
        let due = self
            .bridge
            .lock()
            .lifecycle
            .profiles
            .idle
            .due(folder, now, delay);
        if !unloadable(folder) || in_use || !due {
            return UnloadOutcome::Busy("notDue".into());
        }
        let Some(engine) = self.engine().filter(|engine| engine.is_started()) else {
            return UnloadOutcome::Busy("profile".into());
        };
        let ids = self.engine_ids_of(&state, folder);
        let Some(&(_, engine_profile)) = ids.first() else {
            return UnloadOutcome::Unloaded;
        };
        let profiles: HashSet<ProfileId> = state
            .profiles
            .keys()
            .filter(|profile| state.engine_profile(profile) == folder)
            .cloned()
            .collect();
        let shown: HashSet<TabId> = crate::tab_lifecycle::shown_everywhere(&state);
        let hosted: Vec<(TabId, EngineTabId)> = self
            .bridge
            .lock()
            .tabs
            .iter()
            .filter(|(tab, _)| {
                state
                    .tab(tab.as_str())
                    .is_some_and(|listed| profiles.contains(&listed.profile_id))
            })
            .map(|(tab, engine_tab)| (tab.clone(), *engine_tab))
            .collect();
        for (tab, _) in &hosted {
            if let Some(held_by) = self.kept_from_unloading_by(&state, tab, &shown) {
                return UnloadOutcome::Busy(held_by.into());
            }
        }
        let engine_tabs: Vec<EngineTabId> = hosted.iter().map(|(_, tab)| *tab).collect();
        match engine.sleep_idle_profile(engine_profile, &engine_tabs) {
            Ok(Some(held_by)) if held_by == "sleeping" && !settled => {
                let folder = folder.to_owned();
                let me = self.weak();
                std::thread::Builder::new()
                    .name("ardia-profile-unload".into())
                    .spawn(move || {
                        std::thread::sleep(SETTLE);
                        if let Some(me) = me.upgrade()
                            && !me.is_shutting_down()
                        {
                            me.post(move |coordinator| {
                                let _ = coordinator.unload_idle_profile(
                                    &folder,
                                    ardia_state::store::now_ms(),
                                    true,
                                );
                            });
                        }
                    })
                    .ok();
                return UnloadOutcome::Settling;
            }
            Ok(Some(held_by)) => return UnloadOutcome::Busy(held_by),
            Ok(None) => {}
            Err(problem) => return UnloadOutcome::Busy(problem.to_string()),
        }
        let mut unloaded_tabs: Vec<TabId> = Vec::new();
        for (tab, engine_tab) in &hosted {
            self.bridge.lock().closing_tabs.insert(*engine_tab);
            let done = engine
                .tab_action(*engine_tab, TabAction::UnloadKeepingHistory)
                .unwrap_or(false);
            if !done {
                self.bridge.lock().closing_tabs.remove(engine_tab);
                self.apply_profile_unload(&unloaded_tabs);
                return UnloadOutcome::Busy("history".into());
            }
            self.unbind_tab(tab);
            self.bridge.lock().lifecycle.history_bound.remove(tab);
            unloaded_tabs.push(tab.clone());
        }
        let status = engine
            .unload_idle_profile(engine_profile)
            .unwrap_or_else(|_| "busy".into());
        self.apply_profile_unload(&unloaded_tabs);
        if status == "busy" {
            return UnloadOutcome::Busy("engine".into());
        }
        {
            let mut bridge = self.bridge.lock();
            for (profile, _) in &ids {
                bridge.profiles.forget(profile);
                bridge.profile_paths.remove(profile);
                bridge.history_loaded.remove(profile);
            }
            bridge.lifecycle.profiles.unloaded.insert(folder.to_owned());
        }
        log::info!("an idle profile was unloaded to save memory");
        UnloadOutcome::Unloaded
    }

    fn apply_profile_unload(&self, tabs: &[TabId]) {
        if !tabs.is_empty() {
            self.dispatch_quietly(ardia_state::actions::Action::ForgetPages {
                tabs: tabs.to_vec(),
            });
        }
        self.mark_dirty();
    }

    fn release_unused_profiles(&self, state: &BrowserState) {
        let Some(engine) = self.engine().filter(|engine| engine.is_started()) else {
            return;
        };
        let mut in_use: HashSet<String> = state
            .windows
            .values()
            .map(|window| state.engine_profile(&window.profile_id))
            .collect();
        {
            let bridge = self.bridge.lock();
            for (tab, _) in bridge.tabs.iter() {
                if let Some(listed) = state.tab(tab.as_str()) {
                    in_use.insert(state.engine_profile(&listed.profile_id));
                }
            }
        }
        let releasing: Vec<String> = {
            let mut bridge = self.bridge.lock();
            let book = &mut bridge.lifecycle.profiles;
            let releasing: Vec<String> = book
                .had_pages
                .iter()
                .filter(|folder| unloadable(folder) && !in_use.contains(*folder))
                .cloned()
                .collect();
            for folder in &releasing {
                book.had_pages.remove(folder);
            }
            releasing
        };
        for folder in releasing {
            for (profile, engine_profile) in self.engine_ids_of(state, &folder) {
                if let Err(problem) = engine.release_profile(engine_profile) {
                    log::debug!("{profile} stayed loaded: {problem}");
                    continue;
                }
                let mut bridge = self.bridge.lock();
                bridge.profiles.forget(&profile);
                bridge.profile_paths.remove(&profile);
                bridge.history_loaded.remove(&profile);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::settings::UnloadProfilesAfter;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn the_unload_delay_needs_memory_saver() {
        let mut settings = Settings::default();
        assert_eq!(profile_unload_delay(&settings), None);
        settings.unload_profiles_after = UnloadProfilesAfter::FifteenMinutes;
        assert_eq!(profile_unload_delay(&settings), Some(15 * 60_000));
        settings.memory_saver = false;
        assert_eq!(profile_unload_delay(&settings), None);
    }

    #[test]
    fn personal_and_private_profiles_never_unload() {
        assert!(!unloadable(""));
        assert!(!unloadable("private-1@work"));
        assert!(unloadable("work"));
    }

    #[test]
    fn a_profile_unloads_once_it_has_been_idle_for_the_delay() {
        let mut idle = IdleProfiles::default();
        let delay = Some(5 * 60_000);
        let loaded = set(&["work", "play"]);
        assert!(idle.ready(&loaded, &set(&["work"]), 0, delay).is_empty());
        assert!(
            idle.ready(&loaded, &set(&["work"]), 4 * 60_000, delay)
                .is_empty()
        );
        assert_eq!(
            idle.ready(&loaded, &set(&["work"]), 5 * 60_000, delay),
            vec!["play".to_owned()]
        );
        assert!(idle.due("play", 5 * 60_000, delay));
        assert!(!idle.due("work", 5 * 60_000, delay));
        idle.note_shown(&set(&["play"]), 6 * 60_000);
        assert!(!idle.due("play", 20 * 60_000, delay));
        assert!(
            idle.ready(&loaded, &set(&["play"]), 10 * 60_000, delay)
                .is_empty()
        );
        assert_eq!(
            idle.ready(&loaded, &set(&["play"]), 11 * 60_000, delay),
            vec!["work".to_owned()]
        );
        assert!(idle.ready(&loaded, &set(&[]), 11 * 60_000, None).is_empty());
        assert!(!idle.due("work", 11 * 60_000, delay));
    }
}
