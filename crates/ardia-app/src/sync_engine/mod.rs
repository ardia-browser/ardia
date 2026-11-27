pub mod actions;
pub mod adapters;
pub mod files;
pub mod host;
pub mod keys;
pub mod links;
pub mod owner_check;
pub mod pin_choices;
pub mod recovery_kit;
pub mod summary;
pub mod ui_bridge;
pub mod vault;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use ardia_state::sync::SyncDoc;
use ardia_state::sync_engine::Clock;
use ardia_state::sync_engine::scope::{ScopeOptions, SyncScopeArgs, TransportError, sync_scope};
use ardia_state::{BrowserStore, ProfileId};
use ardia_ui::sync_api::{FolderInfo, PhraseProblem, SyncState};
use parking_lot::{Condvar, Mutex};
use serde_json::Value;
use zeroize::Zeroizing;

use adapters::{AdapterMemory, CycleContext, DeviceDetails};
use files::{APP_SCOPE, Scopes, SyncFiles, profile_scope};
use host::SyncHost;
use keys::{KeyState, KeyStore};
use vault::{Ubiquity, Vault};

pub const CYCLE_MS: u64 = 15_000;
pub const AFTER_EDIT_MS: u64 = 3_000;
pub const QUIT_WAIT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EngineStatus {
    pub state: SyncState,
    pub error: Option<String>,
    pub pending: u64,
}

pub struct Inner {
    pub doc: Arc<Mutex<SyncDoc>>,
    pub scopes: Scopes,
    pub files: SyncFiles,
    pub clock: Option<Clock>,
    pub status: EngineStatus,
}

#[derive(Default)]
struct Schedule {
    due: Option<Instant>,
    again: bool,
    force_passwords: bool,
    stop: bool,
    running: bool,
}

pub type StatusSink = Box<dyn Fn(&SyncEngine) + Send + Sync>;

pub struct SyncEngine {
    inner: Mutex<Inner>,
    doc: Arc<Mutex<SyncDoc>>,
    keys: Arc<KeyState>,
    key_store: Box<dyn KeyStore>,
    data_dir: PathBuf,
    scratch: bool,
    host: SyncHost,
    ubiquity: Arc<dyn Ubiquity>,
    schedule: Mutex<Schedule>,
    wake: Condvar,
    stopping: AtomicBool,
    quitting: Arc<AtomicBool>,
    memory: Arc<Mutex<AdapterMemory>>,
    published: Mutex<summary::Published>,
    sink: Mutex<Option<StatusSink>>,
    device_name: String,
    details: DeviceDetails,
    edit_clock: Mutex<Clock>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnOnError {
    Unavailable,
    Keychain(String),
    Folder(String),
}

impl TurnOnError {
    pub fn text(&self) -> String {
        match self {
            TurnOnError::Unavailable => "Sync isn’t available in this build.".to_owned(),
            TurnOnError::Keychain(store) => format!("Couldn’t save the sync key in {store}."),
            TurnOnError::Folder(problem) => format!("Couldn’t use that folder: {problem}"),
        }
    }
}

pub const SECRET_STORE: &str = "your Keychain";
pub const COMPUTER: &str = "Mac";

fn now_ms() -> i64 {
    ardia_state::store::now_ms()
}

pub fn device_name() -> String {
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2::runtime::{AnyClass, AnyObject};
        use objc2_foundation::NSString;
        if let Some(class) = AnyClass::get(c"NSHost") {
            let host: *mut AnyObject = unsafe { msg_send![class, currentHost] };
            if !host.is_null() {
                let name: Option<Retained<NSString>> = unsafe { msg_send![host, localizedName] };
                if let Some(name) = name.map(|n| n.to_string()).filter(|n| !n.is_empty()) {
                    return name;
                }
            }
        }
    }
    format!("This {COMPUTER}")
}

pub fn this_device_details() -> DeviceDetails {
    let version =
        crate::system_probe::app_version().or_else(|| Some(env!("CARGO_PKG_VERSION").to_owned()));
    let os = os_version().map(|v| format!("macOS {v}"));
    DeviceDetails { version, os }
}

impl SyncEngine {
    pub fn new(
        data_dir: &Path,
        scratch: bool,
        store: Arc<BrowserStore>,
        main: Option<std::sync::Weak<crate::coordinator::AppCoordinator>>,
    ) -> Arc<SyncEngine> {
        let key_store = keys::store_for(data_dir, scratch);
        SyncEngine::with_parts(
            data_dir,
            scratch,
            store,
            main,
            key_store,
            vault::ubiquity(),
            device_name(),
            this_device_details(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_parts(
        data_dir: &Path,
        scratch: bool,
        store: Arc<BrowserStore>,
        main: Option<std::sync::Weak<crate::coordinator::AppCoordinator>>,
        key_store: Box<dyn KeyStore>,
        ubiquity: Arc<dyn Ubiquity>,
        device_name: String,
        details: DeviceDetails,
    ) -> Arc<SyncEngine> {
        let keys = Arc::new(KeyState::default());
        let quitting = Arc::new(AtomicBool::new(false));
        let mut files = SyncFiles::new(data_dir, keys.clone());
        let doc = files.read_doc().unwrap_or_default();
        let status = EngineStatus {
            state: if doc.enabled {
                SyncState::Starting
            } else {
                SyncState::Off
            },
            ..EngineStatus::default()
        };
        let doc = Arc::new(Mutex::new(doc));
        Arc::new(SyncEngine {
            inner: Mutex::new(Inner {
                doc: doc.clone(),
                scopes: Scopes::new(),
                files,
                clock: None,
                status,
            }),
            doc,
            keys,
            key_store,
            data_dir: data_dir.to_path_buf(),
            scratch,
            host: SyncHost::new(store, main, quitting.clone()),
            ubiquity,
            schedule: Mutex::new(Schedule::default()),
            wake: Condvar::new(),
            stopping: AtomicBool::new(false),
            quitting,
            memory: Arc::new(Mutex::new(AdapterMemory::default())),
            published: Mutex::new(summary::Published::default()),
            sink: Mutex::new(None),
            device_name,
            details,
            edit_clock: Mutex::new(Clock::new("", None)),
        })
    }

    pub fn set_sink(&self, sink: StatusSink) {
        *self.sink.lock() = Some(sink);
    }

    pub fn host(&self) -> &SyncHost {
        &self.host
    }

    pub fn keys(&self) -> &Arc<KeyState> {
        &self.keys
    }

    pub fn published(&self) -> summary::Published {
        self.published.lock().clone()
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn default_folder(&self) -> PathBuf {
        if !keys::uses_keychain(&self.data_dir, self.scratch) {
            return self.data_dir.join(vault::FOLDER_NAME);
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        let drive = vault::icloud_drive(&home);
        let folder = drive.join(vault::FOLDER_NAME);
        let legacy = drive.join(vault::LEGACY_FOLDER_NAME);
        if !folder.exists() && vault::has_sync_data(&legacy) {
            return legacy;
        }
        folder
    }

    pub fn icloud_available(&self) -> bool {
        if !keys::uses_keychain(&self.data_dir, self.scratch) {
            return true;
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        vault::is_dir(&vault::icloud_drive(&home))
    }

    pub fn folder_info(&self, path: Option<&str>) -> FolderInfo {
        let default = self.default_folder();
        let chosen = path.map(PathBuf::from).unwrap_or_else(|| default.clone());
        let exists = vault::is_dir(&chosen);
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        let drive = vault::icloud_drive(&home);
        FolderInfo {
            path: chosen.to_string_lossy().into_owned(),
            default_path: default.to_string_lossy().into_owned(),
            icloud_available: self.icloud_available(),
            in_icloud: !home.as_os_str().is_empty() && chosen.starts_with(&drive),
            exists,
            writable: exists && writable(&chosen),
            has_sync_data: exists && vault::has_sync_data(&chosen),
        }
    }

    fn vault(&self, folder: &str) -> Option<Vault> {
        Some(Vault::new(
            Path::new(folder),
            self.keys.keys()?,
            self.ubiquity.clone(),
        ))
    }

    pub fn start(self: &Arc<Self>) {
        self.prepare();
        let me = Arc::downgrade(self);
        let spawned = std::thread::Builder::new()
            .name("ardia-sync".into())
            .spawn(move || run_loop(me));
        if let Err(problem) = spawned {
            log::warn!("[sync] the sync thread couldn't start: {problem}");
        }
    }

    pub fn prepare(&self) {
        let (enabled, device) = {
            let inner = self.inner.lock();
            let doc = inner.doc.lock();
            (doc.enabled, doc.device_id.clone())
        };
        if enabled && let Some(device) = device {
            if self.unlock(&device) {
                self.load_saved_state();
                self.publish(None);
                self.schedule(Duration::from_millis(500));
            } else {
                self.set_status(
                    SyncState::Locked,
                    Some(format!(
                        "Enter your recovery phrase to keep syncing on this {COMPUTER}."
                    )),
                    None,
                );
            }
        } else {
            self.settle_settings_without_sync();
            self.publish(None);
        }
    }

    pub fn shutdown(&self) {
        self.quitting.store(true, Ordering::Release);
        let deadline = Instant::now() + QUIT_WAIT;
        {
            let mut schedule = self.schedule.lock();
            schedule.stop = true;
            self.wake.notify_all();
            while schedule.running && Instant::now() < deadline {
                self.wake.wait_until(&mut schedule, deadline);
            }
        }
        if let Some(mut inner) = self
            .inner
            .try_lock_for(deadline.saturating_duration_since(Instant::now()))
        {
            let Inner {
                doc,
                scopes,
                files,
                clock,
                ..
            } = &mut *inner;
            let doc = doc.lock().clone();
            files.checkpoint(&doc, scopes, clock.as_ref());
        }
    }

    fn unlock(&self, device: &str) -> bool {
        match self.key_store.load(device) {
            Some(entropy) if entropy.len() == keys::ENTROPY_BYTES => {
                self.keys.set(Some(&entropy));
                true
            }
            _ => false,
        }
    }

    fn load_saved_state(&self) {
        let mut inner = self.inner.lock();
        let Inner {
            doc,
            scopes,
            files,
            clock,
            ..
        } = &mut *inner;
        let mut meta = doc.lock().clone();
        *scopes = files.load_state(&mut meta);
        let device = meta.device_id.clone().unwrap_or_default();
        *clock = Some(Clock::new(&device, meta.clock.as_deref()));
        links::settle_theme_adoption(&mut meta, scopes.get(APP_SCOPE), false);
        let settings_synced = meta.enabled && meta.types.get("settings").copied().unwrap_or(false);
        merge_back(&mut doc.lock(), meta);
        drop(inner);
        let inner_ref = self.inner.lock();
        let cx = self.context(&inner_ref, &device);
        drop(inner_ref);
        let mut app = self.inner.lock().scopes.shift_remove(APP_SCOPE);
        adapters::settings::settle_from_saved_sync(&cx, app.as_mut(), settings_synced);
        if let Some(app) = app {
            self.inner.lock().scopes.insert(APP_SCOPE.to_owned(), app);
        }
    }

    fn settle_settings_without_sync(&self) {
        let synced = {
            let doc = self.doc.lock();
            doc.enabled && doc.types.get("settings").copied().unwrap_or(false)
        };
        if synced {
            return;
        }
        let inner = self.inner.lock();
        let cx = self.context(&inner, "");
        drop(inner);
        adapters::settings::settle_without_sync(&cx);
    }

    pub fn schedule(&self, delay: Duration) {
        let mut schedule = self.schedule.lock();
        let due = Instant::now() + delay;
        schedule.due = Some(schedule.due.map_or(due, |known| known.min(due)));
        self.wake.notify_all();
    }

    pub fn schedule_after_edit(&self) {
        if self.enabled() {
            self.schedule(Duration::from_millis(AFTER_EDIT_MS));
        }
    }

    pub fn enabled(&self) -> bool {
        self.doc.lock().enabled
    }

    pub fn status(&self) -> EngineStatus {
        self.published.lock().status.clone()
    }

    fn set_status(&self, state: SyncState, error: Option<String>, pending: Option<u64>) {
        {
            let mut inner = self.inner.lock();
            inner.status.state = state;
            inner.status.error = error;
            if let Some(pending) = pending {
                inner.status.pending = pending;
            }
        }
        self.publish(None);
    }

    pub fn publish(&self, patch: Option<EngineStatus>) {
        let snapshot = {
            let mut inner = self.inner.lock();
            if let Some(patch) = patch {
                inner.status = patch;
            }
            let doc = inner.doc.lock().clone();
            summary::Published::build(
                &doc,
                &inner.scopes,
                &inner.status,
                &self.host.state(),
                now_ms(),
            )
        };
        *self.published.lock() = snapshot;
        if let Some(sink) = self.sink.lock().as_ref() {
            sink(self);
        }
    }

    pub fn sync_now(&self) -> bool {
        if self.stopping.load(Ordering::Acquire)
            || !self.enabled()
            || self.status().state == SyncState::Locked
        {
            return false;
        }
        let mut schedule = self.schedule.lock();
        schedule.force_passwords = true;
        if schedule.running {
            schedule.again = true;
        }
        schedule.due = Some(Instant::now());
        self.wake.notify_all();
        true
    }

    pub fn run_cycle_now(&self, retiring: bool, force_passwords: bool) {
        let started = {
            let mut schedule = self.schedule.lock();
            while schedule.running {
                self.wake
                    .wait_for(&mut schedule, Duration::from_millis(200));
            }
            schedule.running = true;
            true
        };
        if started {
            let span = ardia_profile::span(ardia_profile::Span::SyncCycle);
            self.cycle(retiring, force_passwords);
            drop(span);
            let mut schedule = self.schedule.lock();
            schedule.running = false;
            self.wake.notify_all();
        }
    }

    fn cycle(&self, retiring: bool, force_passwords: bool) {
        let (folder, device) = {
            let inner = self.inner.lock();
            let doc = inner.doc.lock();
            if !doc.enabled || inner.status.state == SyncState::Locked {
                return;
            }
            match (doc.folder.clone(), doc.device_id.clone()) {
                (Some(f), Some(d)) => (f, d),
                _ => return,
            }
        };
        let Some(vault) = self.vault(&folder) else {
            return;
        };
        if !vault::is_dir(Path::new(&folder)) {
            self.set_status(SyncState::Offline, None, None);
            return;
        }
        if !vault.chain_exists() {
            self.reset_from_elsewhere();
            return;
        }
        let outcome = self.cycle_scopes(&vault, &device, retiring, force_passwords);
        match outcome {
            Ok(pending) => {
                {
                    let inner = self.inner.lock();
                    let mut doc = inner.doc.lock();
                    if let Some(clock) = inner.clock.as_ref() {
                        doc.clock = Some(clock.last());
                        self.edit_clock.lock().observe(&clock.last());
                    }
                    doc.last_synced_at = Some(now_ms());
                }
                self.publish_status(SyncState::Updated, None, Some(pending));
            }
            Err(TransportError::Unreadable(_)) => {
                self.publish_status(SyncState::Offline, Some("The sync folder can’t be read. Check that it’s still there and that Ardia can open it.".to_owned()), None);
            }
            Err(TransportError::Failed(problem)) => {
                if self.status().state != SyncState::Locked {
                    log::warn!("[sync] cycle failed: {problem}");
                    self.publish_status(SyncState::Stalled, Some(problem), None);
                }
            }
        }
        self.save();
    }

    fn publish_status(&self, state: SyncState, error: Option<String>, pending: Option<u64>) {
        let status = {
            let inner = self.inner.lock();
            EngineStatus {
                state,
                error,
                pending: pending.unwrap_or(inner.status.pending),
            }
        };
        self.publish(Some(status));
    }

    fn context(&self, inner: &Inner, device: &str) -> CycleContext {
        let doc = inner.doc.lock().clone();
        let state = self.host.state();
        CycleContext {
            removed_profile_keys: Arc::new(links::removed_record_keys(&doc, &inner.scopes, &state)),
            removed_device_keys: Arc::new(links::removed_device_keys(&doc, &inner.scopes)),
            keys: self.keys.keys(),
            host: self.host.clone(),
            doc: inner.doc.clone(),
            device_id: device.to_owned(),
            device_name: self.device_name.clone(),
            app_records: Arc::new(
                inner
                    .scopes
                    .get(APP_SCOPE)
                    .map(|s| s.records.clone())
                    .unwrap_or_default(),
            ),
            memory: self.memory.clone(),
            details: self.details.clone(),
        }
    }

    fn sync_one(
        &self,
        inner: &mut Inner,
        scope: &str,
        vault: &Vault,
        device: &str,
        adapters: &mut [Box<dyn ardia_state::sync_engine::Adapter>],
        history: bool,
    ) -> Result<u64, TransportError> {
        let quitting = self.quitting.clone();
        let hold = move || quitting.load(Ordering::Acquire);
        let Inner {
            doc,
            scopes,
            files,
            clock,
            ..
        } = inner;
        let clock = clock.get_or_insert_with(|| Clock::new(device, doc.lock().clock.as_deref()));
        let mut state = scopes.shift_remove(scope).unwrap_or_default();
        state.track_touched();
        let expired =
            |key: &str, value: &Value, now: i64| adapters::history::expired(key, value, now);
        let files_cell = std::cell::RefCell::new(&mut *files);
        let scope_name = scope.to_owned();
        let persist = |batches: &[ardia_state::sync_engine::LogFile]| {
            files_cell
                .borrow_mut()
                .persist_journal(&scope_name, batches)
                .map_err(TransportError::Failed)
        };
        let applying_device = doc.lock().device_id.clone();
        let persist_applying = |batch: &ardia_state::sync_engine::apply_batches::ApplyBatch| {
            files_cell
                .borrow_mut()
                .persist_applying(&scope_name, applying_device.as_deref(), batch)
                .map_err(TransportError::Failed)
        };
        let now = || now_ms();
        let options = ScopeOptions {
            expired: history.then_some(&expired as &dyn Fn(&str, &Value, i64) -> bool),
            persist: Some(Box::new(persist)),
            hold_apply: Some(&hold),
            persist_applying: Some(Box::new(persist_applying)),
            ..ScopeOptions::default()
        };
        let result = sync_scope(SyncScopeArgs {
            scope,
            state: &mut state,
            transport: vault,
            adapters,
            clock,
            device,
            now: &now,
            options,
        });
        let device_id = doc.lock().device_id.clone();
        files_cell.borrow_mut().journal_scope_changes(
            scope,
            &mut state,
            device_id.as_deref(),
            clock,
        );
        let pending = state.pending;
        scopes.insert(scope.to_owned(), state);
        result.map(|_| pending)
    }

    fn cycle_scopes(
        &self,
        vault: &Vault,
        device: &str,
        retiring: bool,
        force_passwords: bool,
    ) -> Result<u64, TransportError> {
        let mut inner = self.inner.lock();
        {
            let Inner { doc, scopes, .. } = &mut *inner;
            let mut meta = doc.lock();
            links::app_scope_of(&mut meta, scopes, now_ms());
            links::freeze_removals(&mut meta, scopes, &self.host.state());
        }
        let cx = self.context(&inner, device);
        let mut app_list = adapters::app_adapters(&cx, retiring);
        self.sync_one(&mut inner, APP_SCOPE, vault, device, &mut app_list, false)?;
        drop(app_list);
        {
            let Inner { doc, scopes, .. } = &mut *inner;
            let mut meta = doc.lock().clone();
            if let Some(app) = scopes.get(APP_SCOPE) {
                links::settle_removals(&mut meta, app, &self.host.state());
            }
            let ready = scopes
                .get(APP_SCOPE)
                .is_some_and(|app| app.joined && links::ready_to_pair(&meta, app, now_ms()));
            if ready && !self.quitting.load(Ordering::Acquire) {
                links::link_profiles(&mut meta, scopes, &self.host);
            }
            links::settle_theme_adoption(&mut meta, scopes.get(APP_SCOPE), true);
            merge_back(&mut doc.lock(), meta);
        }
        let mut pending = inner.scopes.get(APP_SCOPE).map_or(0, |s| s.pending);
        let state = self.host.state();
        let links_now: Vec<(String, ardia_state::sync::ProfileLink)> = inner
            .doc
            .lock()
            .profiles
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (profile_id, link) in links_now {
            let profile = ProfileId::new(profile_id.as_str());
            let exists = state.profiles.contains_key(&profile);
            let retire =
                retiring || link.extra.get("retire") == Some(&Value::Bool(true)) || !exists;
            if !retire && !link.enabled {
                continue;
            }
            let scope = profile_scope(&link.sync_id);
            inner.scopes.entry(scope.clone()).or_default();
            let cx = self.context(&inner, device);
            if !retire && let Some(state) = inner.scopes.get_mut(&scope) {
                adapters::pinned::prepare_scope(&cx, &profile, state);
            }
            let mut list = adapters::profile_adapters(&cx, &profile, retire, force_passwords);
            self.sync_one(&mut inner, &scope, vault, device, &mut list, true)?;
            drop(list);
            pending += inner.scopes.get(&scope).map_or(0, |s| s.pending);
            if !retire
                && !self.quitting.load(Ordering::Acquire)
                && cx.type_synced("extensions", &profile)
            {
                let visible = inner
                    .scopes
                    .get(&scope)
                    .map(|s| s.visible(adapters::extensions::EXTENSION))
                    .unwrap_or_default();
                adapters::extensions::reconcile(&cx, &profile, &visible);
            }
            if retire {
                let mut doc = inner.doc.lock();
                if let Some(link) = doc.profiles.get_mut(&profile_id) {
                    link.extra.shift_remove("retire");
                }
                if !exists {
                    doc.profiles.shift_remove(&profile_id);
                    if let Some(Value::Object(sends)) = doc.extra.get_mut("sends") {
                        sends.shift_remove(&scope);
                    }
                    drop(doc);
                    inner.scopes.shift_remove(&scope);
                }
            }
        }
        Ok(pending)
    }

    fn reset_from_elsewhere(&self) {
        let device = self.inner.lock().doc.lock().device_id.clone();
        if let Some(device) = device {
            self.forget(&device);
        }
        {
            let mut inner = self.inner.lock();
            let Inner {
                doc,
                scopes,
                files,
                clock,
                ..
            } = &mut *inner;
            let old = doc.lock().clone();
            let fresh = SyncDoc {
                folder: old.folder,
                types: old.types,
                ..SyncDoc::default()
            };
            *doc.lock() = fresh.clone();
            scopes.clear();
            *clock = None;
            files.start_over(&fresh, scopes);
        }
        self.publish_status(
            SyncState::Reset,
            Some(
                "This device is out of sync. Sync may have been reset from another device."
                    .to_owned(),
            ),
            Some(0),
        );
    }

    fn forget(&self, device: &str) {
        self.key_store.delete(device);
        self.keys.set(None);
        owner_check::revoke();
    }

    pub fn save(&self) {
        let _span = ardia_profile::span(ardia_profile::Span::SyncSave);
        let mut inner = self.inner.lock();
        let Inner {
            doc,
            scopes,
            files,
            clock,
            ..
        } = &mut *inner;
        let doc = doc.lock().clone();
        files.save(&doc, scopes, clock.as_ref());
    }

    fn begin(&self, folder: &str, device: &str, joining: bool) {
        {
            let mut inner = self.inner.lock();
            let Inner {
                doc,
                scopes,
                files,
                clock,
                status,
            } = &mut *inner;
            let types = doc.lock().types.clone();
            let fresh = SyncDoc {
                types,
                enabled: true,
                folder: Some(folder.to_owned()),
                device_id: Some(device.to_owned()),
                setup_at: Some(now_ms()),
                joining,
                ..SyncDoc::default()
            };
            *doc.lock() = fresh.clone();
            scopes.clear();
            *clock = Some(Clock::new(device, None));
            files.start_over(&fresh, scopes);
            *status = EngineStatus {
                state: SyncState::Starting,
                error: None,
                pending: 0,
            };
        }
        self.memory.lock().clear();
        self.publish(None);
        self.schedule(Duration::ZERO);
    }

    pub fn turn_on(&self, folder: &str) -> Result<(), TurnOnError> {
        let device = ardia_state::sync_engine::sync_core::new_file_id()
            .map_err(|_| TurnOnError::Unavailable)?;
        let entropy = ardia_state::sync_engine::sync_core::phrase::generate_entropy()
            .map_err(|_| TurnOnError::Unavailable)?;
        if !self.key_store.save(&entropy[..], &device) {
            return Err(TurnOnError::Keychain(SECRET_STORE.to_owned()));
        }
        self.keys.set(Some(&entropy[..]));
        let created = std::fs::create_dir_all(folder)
            .map_err(|e| e.to_string())
            .and_then(|_| {
                self.vault(folder)
                    .ok_or_else(|| "locked".to_owned())?
                    .create_chain()
                    .map_err(|e| e.to_string())
            });
        if let Err(problem) = created {
            self.forget(&device);
            return Err(TurnOnError::Folder(problem));
        }
        self.begin(folder, &device, false);
        Ok(())
    }

    pub fn enter_phrase(&self, folder: &str, text: &str) -> Result<(), PhraseProblem> {
        let locked = {
            let inner = self.inner.lock();
            let doc = inner.doc.lock();
            (doc.enabled && inner.status.state == SyncState::Locked)
                .then(|| (doc.device_id.clone(), doc.folder.clone()))
        };
        let (device, folder, rejoin) = match locked {
            Some((Some(device), saved)) => {
                (device, saved.unwrap_or_else(|| folder.to_owned()), true)
            }
            _ => (
                ardia_state::sync_engine::sync_core::new_file_id()
                    .map_err(|_| PhraseProblem::Unavailable)?,
                folder.to_owned(),
                false,
            ),
        };
        let entropy = phrase_entropy(text)?;
        let keys = Arc::new(ardia_state::sync_engine::sync_core::SyncKeys::new(
            &entropy[..],
        ));
        let probe = Vault::new(Path::new(&folder), keys, self.ubiquity.clone());
        if !probe.chain_exists() {
            return Err(if vault::has_sync_data(Path::new(&folder)) {
                PhraseProblem::Mismatch
            } else {
                PhraseProblem::NoData
            });
        }
        if !self.key_store.save(&entropy[..], &device) {
            return Err(PhraseProblem::Keychain);
        }
        self.keys.set(Some(&entropy[..]));
        if rejoin {
            self.load_saved_state();
            self.publish(Some(EngineStatus {
                state: SyncState::Starting,
                error: None,
                pending: 0,
            }));
            self.schedule(Duration::ZERO);
        } else {
            self.begin(&folder, &device, true);
        }
        Ok(())
    }

    pub fn stop(&self, delete_data: bool) {
        if self.stopping.swap(true, Ordering::AcqRel) || !self.enabled() {
            self.stopping.store(false, Ordering::Release);
            return;
        }
        let shown = self.inner.lock().doc.lock().folder.clone();
        if self.status().state != SyncState::Locked {
            self.run_cycle_now(true, false);
        }
        let (folder, device) = {
            let inner = self.inner.lock();
            let doc = inner.doc.lock();
            (doc.folder.clone(), doc.device_id.clone())
        };
        if delete_data {
            let mut targets: Vec<String> = folder.iter().chain(shown.iter()).cloned().collect();
            targets.dedup();
            for target in targets {
                if let Some(vault) = self.vault(&target)
                    && let Err(problem) = vault.delete_chain()
                {
                    log::warn!("[sync] deleting sync data failed: {problem}");
                }
            }
        }
        if let Some(device) = device {
            self.forget(&device);
        }
        {
            let mut inner = self.inner.lock();
            let Inner {
                doc,
                scopes,
                files,
                clock,
                status,
            } = &mut *inner;
            let types = doc.lock().types.clone();
            let fresh = SyncDoc {
                folder,
                types,
                ..SyncDoc::default()
            };
            *doc.lock() = fresh.clone();
            scopes.clear();
            *clock = None;
            files.start_over(&fresh, scopes);
            *status = EngineStatus::default();
        }
        self.memory.lock().clear();
        self.stopping.store(false, Ordering::Release);
        self.schedule.lock().due = None;
        self.settle_settings_without_sync();
        self.publish(None);
    }

    fn doc_changed(&self) {
        self.save();
        self.publish(None);
        if self.enabled() {
            self.schedule(Duration::ZERO);
        }
    }

    pub fn edit_doc(&self, edit: impl FnOnce(&mut SyncDoc, &Scopes) -> bool) -> bool {
        let changed = {
            let inner = self.inner.lock();
            let mut doc = inner.doc.lock();
            edit(&mut doc, &inner.scopes)
        };
        if changed {
            self.doc_changed();
        }
        changed
    }

    pub fn set_type_synced(&self, data_type: &str, on: bool) {
        self.edit_doc(|doc, _| {
            doc.types.insert(data_type.to_owned(), on);
            true
        });
        if data_type == "settings" && !on {
            self.settle_settings_without_sync();
        }
    }

    pub fn set_profile_synced(&self, profile: &ProfileId, on: bool) {
        self.edit_doc(|doc, _| crate::profile_sync::mark_profile_synced(doc, profile, on));
    }

    pub fn set_open_tabs_synced(&self, profile: &ProfileId, on: bool) {
        self.edit_doc(|doc, _| {
            crate::profile_sync::mark_open_tabs_synced(doc, profile, on);
            true
        });
    }

    pub fn set_folder(&self, path: &str) {
        self.edit_doc(|doc, _| {
            if doc.enabled {
                return false;
            }
            doc.folder = Some(path.to_owned());
            true
        });
    }

    pub fn send_tab(&self, tab: &ardia_state::TabId, device: &str) -> bool {
        if self.status().state == SyncState::Locked {
            return false;
        }
        let queued = {
            let inner = self.inner.lock();
            let mut doc = inner.doc.lock();
            adapters::tabs::queue_send(
                &mut doc,
                &inner.scopes,
                &self.host.state(),
                tab,
                device,
                now_ms(),
            )
        };
        if queued {
            self.save();
            self.schedule(Duration::ZERO);
        }
        queued
    }

    pub fn add_remote_profile(&self, sync_id: &str) -> Option<ProfileId> {
        let added = {
            let mut inner = self.inner.lock();
            let Inner { doc, scopes, .. } = &mut *inner;
            let mut meta = doc.lock().clone();
            let added = links::add_remote_profile(&mut meta, scopes, &self.host, sync_id);
            merge_back(&mut doc.lock(), meta);
            added
        };
        if added.is_some() {
            self.doc_changed();
        }
        added
    }

    pub fn remove_remote_profile(&self, sync_id: &str) -> bool {
        let state = self.host.state();
        self.edit_doc(|doc, scopes| links::mark_removed(doc, scopes, &state, sync_id))
    }

    pub fn remove_device(&self, id: &str) -> bool {
        self.edit_doc(|doc, scopes| links::mark_device_removed(doc, scopes, id))
    }

    pub fn recovery_words(&self) -> Option<Vec<String>> {
        self.keys.words()
    }

    pub fn note_store_edit(&self) {
        if self.enabled() && !self.schedule.lock().running {
            self.schedule(Duration::from_millis(AFTER_EDIT_MS));
        }
    }

    pub fn note_pin_choices(
        &self,
        prev: &ardia_state::BrowserState,
        next: &ardia_state::BrowserState,
    ) {
        if pin_choices::writing_from_sync() || !self.enabled() {
            return;
        }
        let marks = pin_choices::choice_marks(prev, next);
        if marks.is_empty() {
            return;
        }
        let device = self.doc.lock().device_id.clone().unwrap_or_default();
        let stamps: Vec<String> = {
            let mut clock = self.edit_clock.lock();
            if clock.device() != device {
                let mut fresh = Clock::new(&device, self.doc.lock().clock.as_deref());
                fresh.observe(&clock.last());
                *clock = fresh;
            }
            marks.iter().map(|_| clock.tick()).collect()
        };
        let store = self.host.store().clone();
        let apply = move || {
            let mut stamps = stamps.into_iter();
            let current = store.snapshot();
            if let Some(next) =
                pin_choices::with_marks(&current, &marks, &mut || stamps.next().unwrap_or_default())
            {
                pin_choices::from_sync(|| store.replace(next));
            }
        };
        if self.host.has_main() {
            self.host.post(move |_| apply());
        } else {
            apply();
        }
    }

    pub fn record_open_tab_closes(&self, closes: &[(ProfileId, String)]) {
        if closes.is_empty() || self.quitting.load(Ordering::Acquire) {
            return;
        }
        let recorded = adapters::tabs::record_open_tab_closes(&mut self.doc.lock(), closes);
        if recorded {
            self.schedule(Duration::from_millis(AFTER_EDIT_MS));
        }
    }
}

fn os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let name = c"kern.osproductversion";
        let mut buffer = [0u8; 64];
        let mut size = buffer.len();
        let ok = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } == 0;
        if ok {
            let text = String::from_utf8_lossy(&buffer[..size])
                .trim_end_matches('\0')
                .trim()
                .to_owned();
            return (!text.is_empty()).then_some(text);
        }
    }
    None
}

fn merge_back(doc: &mut SyncDoc, mut meta: SyncDoc) {
    if let Some(closes) = doc.extra.get("tabCloses").cloned() {
        meta.extra.insert("tabCloses".into(), closes);
    }
    *doc = meta;
}

fn writable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| !m.permissions().readonly())
}

pub fn phrase_entropy(text: &str) -> Result<Zeroizing<[u8; 32]>, PhraseProblem> {
    use ardia_state::sync_engine::sync_core::PhraseError;
    let tokens = ardia_state::sync_engine::sync_core::phrase::tokens(text);
    match ardia_state::sync_engine::sync_core::phrase::entropy(text) {
        Ok(entropy) => Ok(entropy),
        Err(PhraseError::WordCount(n)) => Err(PhraseProblem::WordCount(n)),
        Err(PhraseError::UnknownWord(index)) => Err(PhraseProblem::UnknownWord(
            tokens.get(index).map(|t| t.to_string()).unwrap_or_default(),
        )),
        Err(PhraseError::Checksum) => Err(PhraseProblem::Checksum),
    }
}

fn run_loop(engine: std::sync::Weak<SyncEngine>) {
    loop {
        let Some(me) = engine.upgrade() else { return };
        let job = {
            let mut schedule = me.schedule.lock();
            loop {
                if schedule.stop {
                    return;
                }
                match schedule.due {
                    Some(due) if due <= Instant::now() => break,
                    Some(due) => {
                        let wait = due.min(Instant::now() + Duration::from_secs(5));
                        me.wake.wait_until(&mut schedule, wait);
                    }
                    None => {
                        me.wake.wait_for(&mut schedule, Duration::from_secs(5));
                    }
                }
                if engine.strong_count() <= 1 && schedule.due.is_none() {
                    continue;
                }
            }
            schedule.due = None;
            schedule.running = true;
            let force = std::mem::take(&mut schedule.force_passwords);
            schedule.again = false;
            force
        };
        me.cycle(false, job);
        let mut schedule = me.schedule.lock();
        schedule.running = false;
        let enabled = me.inner.try_lock().is_none_or(|i| i.doc.lock().enabled);
        if enabled && schedule.due.is_none() {
            let delay = if std::mem::take(&mut schedule.again) {
                Duration::ZERO
            } else {
                Duration::from_millis(CYCLE_MS)
            };
            schedule.due = Some(Instant::now() + delay);
        }
        me.wake.notify_all();
        drop(schedule);
        drop(me);
    }
}
