use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use super::super::folders::{Listing, PinEntry};
use super::super::official::{self, HttpDownload};
use super::super::official_update::{PromptReason, UpdateVerdict, update_within};
use super::super::records::{AutoUpdate, MAX_UPDATE_LINES, write_records};
use super::{PluginService, State};

pub const FIRST_RETRY: Duration = Duration::from_secs(10 * 60);
pub const LAST_RETRY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Debug, Default)]
pub struct UpdateRetries {
    pub fetch: std::collections::HashMap<String, (Instant, Duration)>,
    pub promote: std::collections::HashMap<String, Instant>,
    pub fetching: std::collections::HashSet<String>,
    pub waiting_noted: std::collections::HashSet<String>,
    pub auto_noted: std::collections::HashSet<String>,
    pub reconciling: bool,
}

pub fn prompt_count(reason: PromptReason) -> &'static str {
    match reason {
        PromptReason::Baseline => "official_update_prompts_baseline",
        PromptReason::Permissions => "official_update_prompts_permissions",
        PromptReason::Network => "official_update_prompts_network",
        PromptReason::Runtime => "official_update_prompts_runtime",
        PromptReason::Activation => "official_update_prompts_activation",
        PromptReason::Programs => "official_update_prompts_programs",
        PromptReason::Hooks => "official_update_prompts_hooks",
        PromptReason::Settings => "official_update_prompts_settings",
        PromptReason::Contributions => "official_update_prompts_contributions",
    }
}

pub fn fetch_failure_count(code: official::FetchCode) -> Option<&'static str> {
    match code {
        official::FetchCode::Offline => Some("official_fetch_offline"),
        official::FetchCode::Verify => Some("official_verify_failures"),
        official::FetchCode::Cancelled => None,
        official::FetchCode::Failed | official::FetchCode::Unsupported => {
            Some("official_fetch_failures")
        }
    }
}

pub fn next_wait(previous: Option<Duration>) -> Duration {
    previous
        .map_or(FIRST_RETRY, |wait| wait.saturating_mul(2))
        .min(LAST_RETRY)
}

pub fn auto_update_note(updated: &AutoUpdate) -> (String, String) {
    let title = match &updated.to {
        Some(to) => format!("Updated by itself to {to}"),
        None => "Updated by itself".to_owned(),
    };
    let said = if updated.runtime {
        "It added its own code, which runs in Ardia's sandbox, offline, and first starts when you use one of its commands in the command bar. Its permissions didn't change."
    } else {
        "Its permissions didn't change."
    };
    let since = match &updated.from {
        Some(from) => format!("New since {from}"),
        None => "New since the version you approved".to_owned(),
    };
    let description = if updated.added.is_empty() {
        said.to_owned()
    } else {
        format!("{said} {since}: {}.", updated.added.join("; "))
    };
    (title, description)
}

fn pinned_folder(entry: &PinEntry) -> String {
    official::folder_id(&entry.sha256)
}

pub(super) fn needs_fetch(state: &State, entry: &PinEntry) -> bool {
    let wanted = pinned_folder(entry);
    if state
        .candidates
        .get(&entry.name)
        .is_some_and(|c| c.folder_id == wanted)
    {
        return false;
    }
    state
        .listings
        .get(&entry.name)
        .is_none_or(|l| l.folder_id != wanted)
}

pub(super) fn update_verdict(
    state: &State,
    entry: &PinEntry,
    candidate: &Listing,
) -> Option<UpdateVerdict> {
    let name = entry.name.as_str();
    let record = state.records.get(name)?;
    let listing = state.listings.get(name)?;
    let baseline = listing.read.manifest.as_ref()?;
    let next = candidate.read.manifest.as_ref()?;
    let approved = record.approved.as_deref()?;
    let hash = listing.hash.as_deref()?;
    let candidate_hash = candidate.hash.as_deref()?;
    let fits = record.enabled
        && listing.official
        && baseline.official
        && hash == approved
        && candidate.official
        && next.official
        && candidate.read.problems.is_empty()
        && candidate.folder_id == pinned_folder(entry)
        && candidate.name == name
        && next.name == name
        && baseline.name == name
        && candidate_hash != hash;
    fits.then(|| update_within(baseline, next, entry.example.as_deref()))
}

impl PluginService {
    pub(super) fn reconcile_official(&self) {
        let pin = self.folders.pin.clone();
        {
            let mut state = self.state.lock();
            if state.update_retries.reconciling || state.stopped {
                return;
            }
            state.update_retries.reconciling = true;
        }
        for entry in &pin {
            self.reconcile_one(entry);
        }
        self.state.lock().update_retries.reconciling = false;
    }

    fn reconcile_one(&self, entry: &PinEntry) {
        let name = entry.name.as_str();
        enum Step {
            Promote(Listing, String),
            Approve(Listing, AutoUpdate),
            Waiting(String, PromptReason),
            Fetch,
            Nothing,
        }
        let step = {
            let state = self.state.lock();
            let Some(record) = state.records.get(name) else {
                return;
            };
            let Some(approved) = record.approved.clone().filter(|_| record.enabled) else {
                return;
            };
            if state.listings.get(name).is_some_and(|l| !l.official)
                || state.installs.contains_key(name)
                || state.update_retries.fetching.contains(name)
            {
                return;
            }
            match state.candidates.get(name) {
                Some(candidate)
                    if candidate.read.manifest.is_some() && candidate.hash.is_some() =>
                {
                    let hash = candidate.hash.clone().unwrap_or_default();
                    if hash == approved || record.previous.as_deref() == Some(hash.as_str()) {
                        let waiting = state
                            .update_retries
                            .promote
                            .get(name)
                            .is_some_and(|at| Instant::now() < *at);
                        if waiting {
                            Step::Nothing
                        } else {
                            Step::Promote(candidate.clone(), hash)
                        }
                    } else if state.consent.as_ref().is_some_and(|c| c.name == name) {
                        Step::Nothing
                    } else {
                        match update_verdict(&state, entry, candidate) {
                            Some(UpdateVerdict::Within { added, runtime }) => Step::Approve(
                                candidate.clone(),
                                AutoUpdate {
                                    from: state
                                        .listings
                                        .get(name)
                                        .and_then(|l| l.read.manifest.as_ref())
                                        .and_then(|m| m.version.clone()),
                                    to: candidate
                                        .read
                                        .manifest
                                        .as_ref()
                                        .and_then(|m| m.version.clone()),
                                    added: added.into_iter().take(MAX_UPDATE_LINES).collect(),
                                    runtime,
                                },
                            ),
                            Some(UpdateVerdict::Prompt(reason)) => Step::Waiting(hash, reason),
                            None => Step::Waiting(hash, PromptReason::Baseline),
                        }
                    }
                }
                _ => {
                    let backoff = state.update_retries.fetch.get(name);
                    if needs_fetch(&state, entry)
                        && backoff.is_none_or(|(at, _)| Instant::now() >= *at)
                    {
                        Step::Fetch
                    } else {
                        Step::Nothing
                    }
                }
            }
        };
        match step {
            Step::Promote(candidate, hash) => self.promote_update(&candidate, &hash),
            Step::Approve(candidate, updated) => {
                if self.approve_update(name, &candidate, updated)
                    && let Some(hash) = candidate.hash.clone()
                {
                    self.promote_update(&candidate, &hash);
                }
            }
            Step::Waiting(hash, reason) => {
                let first = self.state.lock().update_retries.waiting_noted.insert(hash);
                if first {
                    ardia_telemetry::counts::count("official_updates_waiting");
                    ardia_telemetry::counts::count(prompt_count(reason));
                }
            }
            Step::Fetch => self.fetch_update(entry.clone()),
            Step::Nothing => {}
        }
    }

    fn approve_update(&self, name: &str, candidate: &Listing, updated: AutoUpdate) -> bool {
        let mut state = self.state.lock();
        let Some(hash) = candidate.hash.clone() else {
            return false;
        };
        let Some(record) = state.records.get_mut(name) else {
            return false;
        };
        let Some(approved) = record.approved.clone() else {
            return false;
        };
        if !record.enabled || approved == hash {
            return false;
        }
        let before = record.clone();
        record.approved = Some(hash);
        record.previous = Some(approved);
        record.updated = Some(updated);
        if let Err(error) = write_records(&self.folders.data_dir, &state.records) {
            log::warn!("[plugins] couldn't save plugins.json: {error}");
            state.records.insert(name.to_owned(), before);
            return false;
        }
        true
    }

    fn promote_update(&self, candidate: &Listing, hash: &str) {
        let name = candidate.name.clone();
        self.state.lock().candidates.remove(&name);
        match self.promote_candidate(candidate, hash) {
            Ok(()) => {
                self.note_auto_update(&name, hash);
                let eager = {
                    let mut state = self.state.lock();
                    state.update_retries.promote.remove(&name);
                    state
                        .active(&name)
                        .is_some_and(super::super::manifest::PluginManifest::runs_eagerly)
                };
                if eager {
                    self.supervise(&name);
                }
                self.reconcile_programs();
                self.env.notify();
            }
            Err(reason) => {
                log::warn!("[plugins] {name}'s update wasn't switched to: {reason}");
                let mut state = self.state.lock();
                state
                    .candidates
                    .entry(name.clone())
                    .or_insert_with(|| candidate.clone());
                state
                    .update_retries
                    .promote
                    .insert(name, Instant::now() + FIRST_RETRY);
                drop(state);
                self.retry_later(FIRST_RETRY);
            }
        }
    }

    fn fetch_update(&self, entry: PinEntry) {
        let name = entry.name.clone();
        let (source, download) = {
            let mut state = self.state.lock();
            state.update_retries.fetching.insert(entry.name.clone());
            (
                state.official_source.clone(),
                state.official_download.clone(),
            )
        };
        let me = self.me.clone();
        let spawned = std::thread::Builder::new()
            .name("official-update".into())
            .spawn(move || {
                let Some(service) = me.upgrade() else {
                    return;
                };
                let download = download.unwrap_or_else(|| Arc::new(HttpDownload));
                let store = service.official_store();
                let cancel = Arc::new(AtomicBool::new(false));
                ardia_telemetry::counts::count("official_fetches");
                let fetched = official::fetch(
                    &entry,
                    &service.folders.pin,
                    &store,
                    source.as_deref(),
                    download.as_ref(),
                    &cancel,
                    &mut |_, _| {},
                );
                if let Err(failure) = &fetched
                    && let Some(field) = fetch_failure_count(failure.code)
                {
                    ardia_telemetry::counts::count(field);
                }
                let sha = fetched.ok().and_then(|f| {
                    f.copy
                        .file_name()
                        .and_then(|s| s.to_str())
                        .filter(|s| official::is_sha(s))
                        .map(str::to_owned)
                });
                let candidate = sha.map(|sha| service.folders.candidate_listing(&entry, &sha));
                let wait = {
                    let mut state = service.state.lock();
                    state.update_retries.fetching.remove(&entry.name);
                    match candidate.filter(|c| c.read.manifest.is_some() && c.hash.is_some()) {
                        Some(candidate) => {
                            state.update_retries.fetch.remove(&entry.name);
                            if !state.installs.contains_key(&entry.name) {
                                state.candidates.insert(entry.name.clone(), candidate);
                            }
                            None
                        }
                        None => {
                            let wait = next_wait(
                                state.update_retries.fetch.get(&entry.name).map(|(_, w)| *w),
                            );
                            state
                                .update_retries
                                .fetch
                                .insert(entry.name.clone(), (Instant::now() + wait, wait));
                            Some(wait)
                        }
                    }
                };
                match wait {
                    Some(wait) => service.retry_later(wait),
                    None => {
                        service.reconcile_official();
                        service.env.notify();
                    }
                }
            });
        if spawned.is_err() {
            self.state.lock().update_retries.fetching.remove(&name);
        }
    }

    fn retry_later(&self, wait: Duration) {
        let me = self.me.clone();
        let _ = std::thread::Builder::new()
            .name("official-retry".into())
            .spawn(move || {
                std::thread::sleep(wait + Duration::from_secs(1));
                if let Some(service) = me.upgrade() {
                    service.reconcile_official();
                }
            });
    }

    fn note_auto_update(&self, name: &str, hash: &str) {
        let first = {
            let mut state = self.state.lock();
            let noted = state
                .records
                .get(name)
                .is_some_and(|r| r.updated.is_some() && r.approved.as_deref() == Some(hash))
                && state
                    .listings
                    .get(name)
                    .is_some_and(|l| l.hash.as_deref() == Some(hash));
            noted && state.update_retries.auto_noted.insert(hash.to_owned())
        };
        if first {
            ardia_telemetry::counts::count("official_updates_auto");
        }
    }

    pub(super) fn promote_approved_update(&self, name: &str) -> Option<Result<(), String>> {
        let candidate = {
            let state = self.state.lock();
            let record = state.records.get(name)?;
            let candidate = state.candidates.get(name)?;
            let hash = candidate.hash.as_deref()?;
            (record.enabled && record.approved.as_deref() == Some(hash))
                .then(|| candidate.clone())?
        };
        let hash = candidate.hash.clone()?;
        self.state.lock().candidates.remove(name);
        let outcome = self.promote_candidate(&candidate, &hash);
        if outcome.is_ok() {
            self.note_auto_update(name, &hash);
        }
        if outcome.is_err() {
            self.state
                .lock()
                .candidates
                .entry(name.to_owned())
                .or_insert(candidate);
        }
        self.reconcile_programs();
        self.env.notify();
        Some(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_auto_update_note_reads_like_the_old_one() {
        let plain = AutoUpdate {
            from: Some("0.6.0".into()),
            to: Some("0.7.0".into()),
            added: Vec::new(),
            runtime: false,
        };
        assert_eq!(
            auto_update_note(&plain),
            (
                "Updated by itself to 0.7.0".to_owned(),
                "Its permissions didn't change.".to_owned()
            )
        );
        let added = AutoUpdate {
            from: None,
            to: None,
            added: vec!["Reads the page".into(), "Opens tabs".into()],
            runtime: true,
        };
        let (title, description) = auto_update_note(&added);
        assert_eq!(title, "Updated by itself");
        assert!(description.starts_with("It added its own code"));
        assert!(
            description
                .ends_with("New since the version you approved: Reads the page; Opens tabs.")
        );
    }

    #[test]
    fn retries_back_off_from_ten_minutes_to_six_hours() {
        assert_eq!(next_wait(None), FIRST_RETRY);
        assert_eq!(next_wait(Some(FIRST_RETRY)), FIRST_RETRY * 2);
        assert_eq!(next_wait(Some(LAST_RETRY)), LAST_RETRY);
    }
}
