use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ardia_import_core::BookmarkNode;
use ardia_state::ProfileId;
use ardia_ui::host_data::{ImportPlan, StageState};
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;
use crate::import::{ImportRequest, ImportSource, read_source, stages_for};
use crate::import_readers::extensions::{self, ExtensionGroup, ImportedExtension};
use crate::import_readers::{Credential, HistoryEntry};

pub const ENCRYPTED_KINDS: [&str; 2] = ["passwords", "cookies"];
pub const SAFARI: &str = "safari";
pub const SAFARI_EXPORT: &str = "safari-export";
const HISTORY_BATCH: usize = 2000;
const COOKIE_BATCH: usize = 500;

#[cfg(target_os = "macos")]
type Cookie = crate::import_readers::chromium_secrets::Cookie;
#[cfg(target_os = "macos")]
pub type UnlockedKey = Option<crate::import_readers::chromium_secrets::Key>;
#[cfg(not(target_os = "macos"))]
pub type UnlockedKey = Option<()>;
#[cfg(not(target_os = "macos"))]
type Cookie = ();

#[derive(Default)]
pub struct ReadProfile {
    pub name: String,
    pub bookmarks: Option<Result<BookmarkNode, String>>,
    pub history: Option<Result<Vec<HistoryEntry>, String>>,
    pub passwords: Option<Result<Vec<Credential>, String>>,
    pub cookies: Option<Result<Vec<Cookie>, String>>,
    pub cards: Option<Result<Vec<crate::import_readers::ImportedCard>, String>>,
    pub tabs: Option<Vec<(String, String)>>,
    pub extensions: Option<Vec<ImportedExtension>>,
}

fn wants(plan: &ImportPlan, kind: &str) -> bool {
    plan.kinds.iter().any(|k| k == kind)
}

pub fn needs_unlock(plan: &ImportPlan) -> bool {
    plan.kinds
        .iter()
        .any(|k| ENCRYPTED_KINDS.contains(&k.as_str()))
}

#[cfg(target_os = "macos")]
fn read_safari(plan: &ImportPlan, home: Option<&Path>) -> Result<ReadProfile, String> {
    use crate::import_readers::safari;
    let data = if plan.source_id == SAFARI_EXPORT {
        safari::load_export(Path::new(plan.file.as_deref().unwrap_or_default()))?
    } else {
        safari::load_direct_with(
            home.ok_or("there's no home folder to look in")?,
            wants(plan, "cookies"),
            ardia_state::store::now_ms() as f64,
        )?
    };
    let history = data.history();
    Ok(ReadProfile {
        name: String::new(),
        bookmarks: wants(plan, "bookmarks").then(|| {
            data.bookmarks
                .clone()
                .ok_or_else(|| "No Safari bookmarks".to_owned())
        }),
        history: wants(plan, "history").then_some(Ok(history)),
        passwords: (wants(plan, "passwords") && plan.source_id == SAFARI_EXPORT)
            .then_some(Ok(data.credentials)),
        cookies: (wants(plan, "cookies") && plan.source_id == SAFARI).then_some(Ok(data.cookies)),
        tabs: (wants(plan, "tabs") && plan.source_id == SAFARI).then(|| {
            data.tabs
                .iter()
                .map(|t| (t.url.clone(), t.title.clone()))
                .collect()
        }),
        cards: (wants(plan, "cards") && plan.source_id == SAFARI_EXPORT).then_some(Ok(data.cards)),
        extensions: None,
    })
}

#[cfg(not(target_os = "macos"))]
fn read_safari(_plan: &ImportPlan, _home: Option<&Path>) -> Result<ReadProfile, String> {
    Err("Safari can only be imported on a Mac".into())
}

#[cfg(target_os = "macos")]
fn read_secrets(
    plan: &ImportPlan,
    profile: &Path,
    key: &Result<crate::import_readers::chromium_secrets::Key, String>,
    read: &mut ReadProfile,
) {
    use crate::import_readers::chromium_secrets;
    let now = ardia_state::store::now_ms() as f64;
    if wants(plan, "passwords") {
        read.passwords = Some(match key {
            Ok(key) => chromium_secrets::logins(profile, key).map(|outcome| outcome.items),
            Err(problem) => Err(problem.clone()),
        });
    }
    if wants(plan, "cookies") {
        read.cookies = Some(match key {
            Ok(key) => chromium_secrets::cookies(profile, key, now).map(|outcome| outcome.items),
            Err(problem) => Err(problem.clone()),
        });
    }
}

#[cfg(target_os = "macos")]
fn unlock_key(plan: &ImportPlan) -> Result<crate::import_readers::chromium_secrets::Key, String> {
    use crate::import_readers::chromium_secrets;
    let items = chromium_secrets::keychain_items(&plan.source_id);
    let secret = chromium_secrets::keychain_secret(&items)?;
    Ok(chromium_secrets::derive_key(&secret))
}

fn read_chromium(
    plan: &ImportPlan,
    profile: &Path,
    name: &str,
    cancel: &AtomicBool,
) -> ReadProfile {
    let mut read = ReadProfile {
        name: name.to_owned(),
        ..ReadProfile::default()
    };
    if wants(plan, "bookmarks") {
        read.bookmarks = Some(read_source(&ImportSource::ChromiumProfile {
            label: plan.source_name.clone(),
            path: profile.to_path_buf(),
        }));
    }
    if cancel.load(Ordering::Acquire) {
        return read;
    }
    #[cfg(target_os = "macos")]
    if wants(plan, "history") {
        read.history = Some(crate::import_readers::chromium_history::read(profile));
    }
    if wants(plan, "extensions") {
        read.extensions = Some(extensions::list(profile));
    }
    read
}

pub fn read_plan(
    plan: &ImportPlan,
    home: Option<&Path>,
    cancel: &AtomicBool,
) -> Result<Vec<ReadProfile>, String> {
    read_plan_with(plan, home, cancel, None)
}

pub fn read_plan_with(
    plan: &ImportPlan,
    home: Option<&Path>,
    cancel: &AtomicBool,
    unlocked: UnlockedKey,
) -> Result<Vec<ReadProfile>, String> {
    #[cfg(not(target_os = "macos"))]
    let _ = unlocked;
    if plan.source_id == SAFARI || plan.source_id == SAFARI_EXPORT {
        return read_safari(plan, home).map(|read| vec![read]);
    }
    if let Some(file) = &plan.file {
        return Ok(vec![ReadProfile {
            bookmarks: Some(read_source(&ImportSource::BookmarksFile {
                path: PathBuf::from(file),
            })),
            ..ReadProfile::default()
        }]);
    }
    #[cfg(target_os = "macos")]
    let key = needs_unlock(plan).then(|| match unlocked {
        Some(key) => Ok(key),
        None => unlock_key(plan),
    });
    let mut out = Vec::new();
    for profile in &plan.profiles {
        if cancel.load(Ordering::Acquire) {
            break;
        }
        let path = PathBuf::from(&profile.path);
        #[allow(unused_mut)]
        let mut read = read_chromium(plan, &path, &profile.name, cancel);
        #[cfg(target_os = "macos")]
        if let Some(key) = &key {
            read_secrets(plan, &path, key, &mut read);
        }
        out.push(read);
    }
    Ok(out)
}

pub const UNLOCK_IN_WINDOW: &str = "Open Import Browser Data to unlock it";

pub fn run(coordinator: &AppCoordinator, plan: ImportPlan) {
    run_locked(coordinator, plan, Vec::new());
}

pub fn run_without_unlocking(coordinator: &AppCoordinator, mut plan: ImportPlan) {
    let locked: Vec<String> = plan
        .kinds
        .iter()
        .filter(|kind| ENCRYPTED_KINDS.contains(&kind.as_str()))
        .cloned()
        .collect();
    plan.kinds
        .retain(|kind| !ENCRYPTED_KINDS.contains(&kind.as_str()));
    run_locked(coordinator, plan, locked);
}

fn run_locked(coordinator: &AppCoordinator, plan: ImportPlan, locked: Vec<String>) {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(previous) = coordinator
        .bridge
        .lock()
        .import_cancel
        .replace(Arc::clone(&cancel))
    {
        previous.store(true, Ordering::Release);
    }
    let kinds = if plan.file.is_some() && plan.source_id != SAFARI_EXPORT {
        vec!["bookmarks".to_owned()]
    } else {
        plan.kinds.clone()
    };
    let stages = stages_for(&ImportRequest {
        source: plan.source_id.clone(),
        data: kinds,
    });
    let mut stages = stages;
    for kind in &locked {
        if !stages.iter().any(|stage| &stage.key == kind) {
            let label = crate::import::DATA_LABELS
                .iter()
                .find(|(known, _)| known == kind)
                .map_or(kind.as_str(), |(_, label)| label);
            let mut stage = ardia_ui::host_data::ImportStage::new(kind, label);
            stage.state = StageState::Failed(UNLOCK_IN_WINDOW.to_owned());
            stages.push(stage);
        }
    }
    let nothing_to_read = plan.kinds.is_empty();
    let run = coordinator.begin_import(&plan.source_name, stages);
    coordinator.update_import(run, |progress| {
        progress.preparing = plan.profiles.len().max(1);
        for stage in &mut progress.stages {
            if stage.state == StageState::Waiting {
                stage.state = StageState::Running;
            }
        }
        if nothing_to_read {
            progress.finished = true;
        }
    });
    if nothing_to_read {
        coordinator.bridge.lock().import_cancel = None;
        return;
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let unlocked = coordinator.take_unlocked_key(&plan.source_id);
    let me = coordinator.weak();
    let spawned = std::thread::Builder::new()
        .name("ardia-import".into())
        .spawn(move || {
            let read = read_plan_with(&plan, home.as_deref(), &cancel, unlocked);
            if cancel.load(Ordering::Acquire) {
                return;
            }
            if let Some(coordinator) = me.upgrade() {
                coordinator
                    .post(move |coordinator| coordinator.apply_import(run, &cancel, plan, read));
            }
        });
    if let Err(problem) = spawned {
        coordinator.import_failed(run, format!("the import couldn't start: {problem}"));
    }
}

#[derive(Default)]
struct Tally {
    done: usize,
    problems: Vec<String>,
}

impl Tally {
    fn state(&self) -> StageState {
        if self.problems.is_empty() || self.done > 0 {
            StageState::Done
        } else {
            StageState::Failed(self.problems.join("; "))
        }
    }
}

#[derive(Default)]
pub struct UnlockedKeys {
    #[cfg(target_os = "macos")]
    keys: std::collections::HashMap<String, crate::import_readers::chromium_secrets::Key>,
}

impl std::fmt::Debug for UnlockedKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UnlockedKeys")
    }
}

pub const UNLOCK_DENIED: &str = "macOS didn't allow access to the keychain item";

impl AppCoordinator {
    pub(crate) fn take_unlocked_key(&self, browser: &str) -> UnlockedKey {
        #[cfg(target_os = "macos")]
        {
            self.bridge.lock().unlocked.keys.remove(browser)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = browser;
            None
        }
    }

    pub(crate) fn unlock_browser(
        &self,
        browser: String,
        name: String,
    ) -> futures::channel::oneshot::Receiver<Result<(), String>> {
        let (answer, reply) = futures::channel::oneshot::channel();
        let me = self.weak();
        let spawned = std::thread::Builder::new()
            .name("ardia-import-unlock".into())
            .spawn(move || {
                #[cfg(target_os = "macos")]
                let result = {
                    use crate::import_readers::chromium_secrets;
                    let items = chromium_secrets::keychain_items(&browser);
                    chromium_secrets::keychain_secret(&items).map(|secret| chromium_secrets::derive_key(&secret))
                };
                #[cfg(not(target_os = "macos"))]
                let result: Result<(), String> = Err("Encrypted data can only be unlocked on macOS".into());
                let outcome = match result {
                    #[cfg(target_os = "macos")]
                    Ok(key) => {
                        if let Some(me) = me.upgrade() {
                            me.bridge.lock().unlocked.keys.insert(browser.clone(), key);
                        }
                        Ok(())
                    }
                    #[cfg(not(target_os = "macos"))]
                    Ok(()) => Ok(()),
                    Err(problem) => {
                        log::info!("{browser} didn't unlock: {problem}");
                        Err(format!(
                            "macOS didn't allow access to {name}'s keychain item. Try again, or skip the encrypted data."
                        ))
                    }
                };
                let _ = answer.send(outcome);
            });
        if let Err(problem) = spawned {
            log::warn!("unlocking didn't start: {problem}");
        }
        reply
    }

    fn import_destination(
        &self,
        index: usize,
        target: &ProfileId,
        name: &str,
    ) -> Option<ProfileId> {
        if index == 0 {
            return Some(target.clone());
        }
        self.dispatch_quietly(ardia_state::Action::CreateProfile {
            name: name.to_owned(),
            color: None,
            icon: None,
        })
        .and_then(|outcome| outcome.profile)
    }

    fn import_services(
        &self,
        profile: &ProfileId,
    ) -> Option<(Arc<dyn ardia_engine::BrowserEngine>, String)> {
        let engine = self.engine()?;
        let dir = self.service_profile_dir(profile)?;
        Some((engine, dir))
    }

    fn import_history(
        &self,
        profile: &ProfileId,
        entries: &[HistoryEntry],
    ) -> Result<usize, String> {
        if entries.is_empty() {
            return Ok(0);
        }
        let (engine, dir) = self
            .import_services(profile)
            .ok_or("the profile isn't open")?;
        for batch in entries.chunks(HISTORY_BATCH) {
            ardia_telemetry::counts::count("import_history_batches");
            let rows: Vec<Value> = batch.iter().map(HistoryEntry::wire).collect();
            let reply = ardia_engine::Services::new(engine.as_ref(), &dir)
                .history()
                .import(json!(rows));
            self.spawn(async move {
                if let Err(problem) = reply.await {
                    ardia_telemetry::counts::count("import_history_batches_failed");
                    log::warn!("history didn't import: {problem}");
                }
            });
        }
        Ok(entries.len())
    }

    fn import_passwords(
        &self,
        profile: &ProfileId,
        credentials: Vec<Credential>,
    ) -> Result<usize, String> {
        if credentials.is_empty() {
            return Ok(0);
        }
        let (engine, dir) = self
            .import_services(profile)
            .ok_or("the profile isn't open")?;
        let count = credentials.len();
        let consent = ardia_telemetry::consent_now();
        let replies: Vec<_> = credentials
            .into_iter()
            .map(|credential| {
                ardia_engine::Services::new(engine.as_ref(), &dir)
                    .passwords()
                    .add(
                        &credential.url,
                        &credential.username,
                        credential.password.clone(),
                    )
            })
            .collect();
        self.spawn(async move {
            let (mut saved, mut other) = (0u64, 0u64);
            for reply in replies {
                match reply.await {
                    Ok(_) => saved += 1,
                    Err(problem) => {
                        other += 1;
                        log::debug!("a password didn't import: {problem}");
                    }
                }
            }
            let mut props = serde_json::Map::new();
            props.insert("source".into(), serde_json::json!("browser"));
            props.insert("tried".into(), serde_json::json!(saved + other));
            props.insert("saved".into(), serde_json::json!(saved));
            props.insert("refused".into(), serde_json::json!(0));
            props.insert("not_landed".into(), serde_json::json!(0));
            props.insert("other".into(), serde_json::json!(other));
            ardia_telemetry::capture_for("password_import", props, consent.as_ref());
        });
        Ok(count)
    }

    fn import_tabs(&self, profile: &ProfileId, tabs: &[(String, String)]) -> usize {
        let state = self.store.snapshot();
        let page = |url: &str| url.split('#').next().unwrap_or(url).to_owned();
        let mut open: HashSet<String> = state
            .tabs
            .values()
            .filter(|t| &t.profile_id == profile)
            .map(|t| page(&t.url))
            .collect();
        let Some(window) = state
            .focus_order
            .iter()
            .filter_map(|id| state.window(id.as_str()))
            .find(|w| w.kind.has_tabs() && &w.profile_id == profile)
            .map(|w| w.id.clone())
            .or_else(|| crate::ipc::control_window(&state))
        else {
            return 0;
        };
        let mut made = Vec::new();
        for (url, title) in tabs {
            if !open.insert(page(url)) {
                continue;
            }
            let Ok(snapshot) = serde_json::from_value::<ardia_state::tabs::TabSnapshot>(
                json!({ "url": url, "title": title, "profileId": profile.as_str() }),
            ) else {
                continue;
            };
            let mut tab = ardia_state::actions::NewTab::restoring(snapshot);
            tab.background = true;
            if let Some(id) = self
                .dispatch_quietly(ardia_state::Action::NewTab {
                    window: window.clone(),
                    tab,
                })
                .and_then(|outcome| outcome.tab)
            {
                made.push(id);
            }
        }
        if !made.is_empty() {
            let _ = self.dispatch_quietly(ardia_state::Action::CreateGroup {
                tabs: made.clone(),
                name: "Imported".into(),
            });
        }
        made.len()
    }

    fn import_cards(
        &self,
        profile: &ProfileId,
        cards: Vec<crate::import_readers::ImportedCard>,
    ) -> Result<usize, String> {
        let wire = crate::import_readers::cards_wire(&cards);
        let count = cards
            .iter()
            .filter(|card| crate::import_readers::card_digit_count(&card.number).is_some())
            .count();
        if count == 0 {
            return Ok(0);
        }
        let (engine, dir) = self
            .import_services(profile)
            .ok_or("the profile isn't open")?;
        let data: Value = serde_json::from_str(&wire).map_err(|e| e.to_string())?;
        let reply = ardia_engine::Services::new(engine.as_ref(), &dir)
            .autofill()
            .import(data);
        self.spawn(async move {
            if let Err(problem) = reply.await {
                log::warn!("cards didn't import: {problem}");
            }
        });
        Ok(count)
    }

    #[cfg(target_os = "macos")]
    fn import_cookies(&self, profile: &ProfileId, cookies: Vec<Cookie>) -> Result<usize, String> {
        if cookies.is_empty() {
            return Ok(0);
        }
        let (engine, dir) = self
            .import_services(profile)
            .ok_or("the profile isn't open")?;
        for batch in cookies.chunks(COOKIE_BATCH) {
            let wire: Vec<Value> = batch.iter().map(Cookie::wire).collect();
            let reply = ardia_engine::Services::new(engine.as_ref(), &dir).call(
                "ac_cookies_import",
                json!({ "cookies": wire, "replaceOlder": false }),
            );
            self.spawn(async move {
                if let Err(problem) = reply.await {
                    log::warn!("cookies didn't import: {problem}");
                }
            });
        }
        Ok(cookies.len())
    }

    #[cfg(not(target_os = "macos"))]
    fn import_cookies(&self, _profile: &ProfileId, _cookies: Vec<Cookie>) -> Result<usize, String> {
        Err("cookies can only be imported on a Mac".into())
    }

    fn installed_extension_ids(&self, profile: &ProfileId) -> HashSet<String> {
        self.bridge
            .lock()
            .extension_lists
            .get(profile)
            .map(|items| items.iter().map(|(item, _)| item.id.clone()).collect())
            .unwrap_or_default()
    }

    pub(crate) fn apply_import(
        &self,
        run: u64,
        cancel: &AtomicBool,
        plan: ImportPlan,
        read: Result<Vec<ReadProfile>, String>,
    ) {
        let read = match read {
            Ok(read) => read,
            Err(problem) => {
                self.import_failed(run, problem);
                return;
            }
        };
        let state = self.store.snapshot();
        let target = plan
            .target
            .clone()
            .unwrap_or_else(|| state.last_active_profile());
        let mut tallies: std::collections::HashMap<&'static str, Tally> =
            std::collections::HashMap::new();
        let mut groups = Vec::new();
        for (index, profile) in read.into_iter().enumerate() {
            if cancel.load(Ordering::Acquire) {
                return;
            }
            let destination = self.import_destination(index, &target, &profile.name);
            let Some(destination) = destination else {
                for key in ["bookmarks", "history", "passwords", "cookies"] {
                    tallies
                        .entry(key)
                        .or_default()
                        .problems
                        .push(format!("{}: the profile isn't open", profile.name));
                }
                continue;
            };
            if let Some(tree) = profile.bookmarks {
                let tally = tallies.entry("bookmarks").or_default();
                match tree.map(|tree| self.merge_import(&destination, &plan.source_name, &tree)) {
                    Ok(Some(links)) => tally.done += links,
                    Ok(None) => tally.problems.push("the profile isn't open".into()),
                    Err(problem) => tally.problems.push(problem),
                }
            }
            if let Some(history) = profile.history {
                let tally = tallies.entry("history").or_default();
                match history.and_then(|entries| self.import_history(&destination, &entries)) {
                    Ok(count) => tally.done += count,
                    Err(problem) => tally.problems.push(problem),
                }
            }
            if let Some(passwords) = profile.passwords {
                let tally = tallies.entry("passwords").or_default();
                match passwords.and_then(|found| self.import_passwords(&destination, found)) {
                    Ok(count) => tally.done += count,
                    Err(problem) => tally.problems.push(problem),
                }
            }
            if let Some(cookies) = profile.cookies {
                let tally = tallies.entry("cookies").or_default();
                match cookies.and_then(|found| self.import_cookies(&destination, found)) {
                    Ok(count) => tally.done += count,
                    Err(problem) => tally.problems.push(problem),
                }
            }
            if let Some(tabs) = profile.tabs {
                tallies.entry("tabs").or_default().done += self.import_tabs(&destination, &tabs);
            }
            if let Some(cards) = profile.cards {
                let tally = tallies.entry("cards").or_default();
                match cards.and_then(|found| self.import_cards(&destination, found)) {
                    Ok(count) => tally.done += count,
                    Err(problem) => tally.problems.push(problem),
                }
            }
            if let Some(list) = profile.extensions {
                let profile_name = state
                    .profile(destination.as_str())
                    .map(|p| p.name.clone())
                    .unwrap_or_default();
                tallies.entry("extensions").or_default().done += list.len();
                groups.push(ExtensionGroup {
                    profile_id: destination,
                    profile_name,
                    list,
                });
            }
        }
        if cancel.load(Ordering::Acquire) {
            return;
        }
        let listing = extensions::plan_listing(&plan.source_name, &groups, |profile| {
            self.installed_extension_ids(profile)
        });
        ardia_telemetry::counts::count("import_runs");
        let failed_kinds = tallies
            .values()
            .filter(|tally| matches!(tally.state(), StageState::Failed(_)))
            .count();
        ardia_telemetry::counts::add("import_kinds_done", (tallies.len() - failed_kinds) as u64);
        ardia_telemetry::counts::add("import_kinds_failed", failed_kinds as u64);
        if let Some(listing) = &listing {
            use ardia_ui::host_data::LeftOutReason;
            let listed: usize = listing.targets.iter().map(|t| t.extensions.len()).sum();
            ardia_telemetry::counts::add("import_extensions_listed", listed as u64);
            for left in &listing.left_out {
                ardia_telemetry::counts::count(match left.reason {
                    LeftOutReason::Installed => "import_extensions_skipped_installed",
                    LeftOutReason::ManifestV2 => "import_extensions_skipped_mv2",
                    LeftOutReason::Unpacked => "import_extensions_skipped_unpacked",
                    LeftOutReason::Policy => "import_extensions_skipped_policy",
                    LeftOutReason::External => "import_extensions_skipped_external",
                    LeftOutReason::NotWebStore => "import_extensions_skipped_not_web_store",
                });
            }
        }
        self.update_import(run, |progress| {
            for stage in &mut progress.stages {
                if let Some(tally) = tallies.get(stage.key.as_str()) {
                    stage.done = tally.done;
                    stage.total = Some(tally.done);
                    stage.state = tally.state();
                } else if stage.state == StageState::Running {
                    stage.state = StageState::Done;
                }
            }
            progress.extensions = listing;
            progress.finished = true;
        });
        let mut bridge = self.bridge.lock();
        if bridge
            .import
            .as_ref()
            .is_some_and(|progress| progress.run == run)
        {
            bridge.import_cancel = None;
        }
    }

    pub(crate) fn open_store_pages(&self, profile: &ProfileId, urls: &[String]) {
        let window = self
            .store
            .snapshot()
            .focus_order
            .iter()
            .find(|w| {
                self.store
                    .snapshot()
                    .window(w.as_str())
                    .is_some_and(|w| w.kind.has_tabs() && &w.profile_id == profile)
            })
            .cloned()
            .or_else(|| crate::ipc::control_window(&self.store.snapshot()));
        let Some(window) = window else {
            return;
        };
        ardia_telemetry::counts::add("import_extension_store_pages_opened", urls.len() as u64);
        for url in urls {
            let _ = self.dispatch_quietly(ardia_state::Action::NewTab {
                window: window.clone(),
                tab: ardia_state::actions::NewTab {
                    url: Some(url.clone()),
                    background: true,
                    ..ardia_state::actions::NewTab::default()
                },
            });
        }
    }

    pub(crate) fn mark_store_pages_opened(&self) {
        let run = self.bridge.lock().import.as_ref().map(|p| p.run);
        if let Some(run) = run {
            self.update_import(run, |progress| {
                if let Some(listing) = progress.extensions.as_mut() {
                    listing.store_opened = true;
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_readers::fixture;
    use ardia_ui::host_data::ImportBrowserProfile;

    fn chrome_plan(kinds: &[&str]) -> ImportPlan {
        ImportPlan {
            source_id: "chrome".into(),
            source_name: "Chrome".into(),
            profiles: vec![ImportBrowserProfile {
                id: "Default".into(),
                name: "Person".into(),
                path: fixture("home/Library/Application Support/Google/Chrome/Default")
                    .display()
                    .to_string(),
                email: None,
                is_default: true,
            }],
            kinds: kinds.iter().map(|k| (*k).to_owned()).collect(),
            target: None,
            file: None,
        }
    }

    #[test]
    fn a_chromium_profile_reads_bookmarks_history_and_extensions_without_unlocking() {
        let plan = chrome_plan(&["bookmarks", "history", "extensions"]);
        assert!(!needs_unlock(&plan));
        let read = read_plan(&plan, None, &AtomicBool::new(false)).unwrap();
        assert_eq!(read.len(), 1);
        assert!(read[0].bookmarks.as_ref().is_some_and(Result::is_ok));
        #[cfg(target_os = "macos")]
        assert!(
            read[0]
                .history
                .as_ref()
                .is_some_and(|h| h.as_ref().is_ok_and(|h| !h.is_empty()))
        );
        assert!(read[0].extensions.is_some());
        assert!(read[0].passwords.is_none() && read[0].cookies.is_none());
    }

    #[test]
    fn encrypted_kinds_ask_to_unlock() {
        assert!(needs_unlock(&chrome_plan(&["bookmarks", "passwords"])));
        assert!(needs_unlock(&chrome_plan(&["cookies"])));
        assert!(!needs_unlock(&chrome_plan(&["history"])));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_safari_export_brings_bookmarks_history_and_passwords() {
        let plan = ImportPlan {
            source_id: SAFARI_EXPORT.into(),
            source_name: "Safari".into(),
            profiles: Vec::new(),
            kinds: vec!["bookmarks".into(), "history".into(), "passwords".into()],
            target: None,
            file: Some(fixture("safari/Safari Export.zip").display().to_string()),
        };
        let read = read_plan(&plan, None, &AtomicBool::new(false)).unwrap();
        assert!(read[0].bookmarks.as_ref().is_some_and(Result::is_ok));
        assert!(
            read[0]
                .history
                .as_ref()
                .is_some_and(|h| h.as_ref().is_ok_and(|h| !h.is_empty()))
        );
        assert!(
            read[0]
                .passwords
                .as_ref()
                .is_some_and(|p| p.as_ref().is_ok_and(|p| !p.is_empty()))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn safari_direct_reads_the_library_folder() {
        let plan = ImportPlan {
            source_id: SAFARI.into(),
            source_name: "Safari".into(),
            kinds: vec!["bookmarks".into(), "history".into()],
            ..ImportPlan::default()
        };
        let read = read_plan(&plan, Some(&fixture("home")), &AtomicBool::new(false)).unwrap();
        assert!(read[0].bookmarks.as_ref().is_some_and(Result::is_ok));
        assert!(read[0].history.as_ref().is_some_and(Result::is_ok));
        let missing = read_plan(&plan, Some(&fixture("nowhere")), &AtomicBool::new(false));
        assert_eq!(
            missing.err().as_deref(),
            Some(crate::import_readers::safari::FULL_DISK_ACCESS_NEEDED)
        );
    }
}
