use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

use serde_json::{json, Map, Value};

use crate::fsafe::{self, Dir, Entry, Fetched, Opened, Root};
use crate::migrate::{check_layout, overlapping, read_report, source_root, valid_run, Faults, Layout, Outcome, Sealer};
use crate::names;

pub const REPORT_VERSION: u64 = 1;
pub const STEP: &str = "chromium";
pub const LOCAL_STATE_LIMIT: u64 = 16 * 1024 * 1024;
pub const SPACE_MARGIN: u64 = 256 * 1024 * 1024;
pub const CHROMIUM_KEY_BYTES: usize = 32;
const PROGRESS_LIMIT: u64 = 4 * 1024 * 1024;
const REPORT_LIMIT: u64 = 1024 * 1024;
const DEPTH_LIMIT: usize = 48;
const COPY_WORKERS: usize = 4;
const COPY_BUFFER: usize = 1024 * 1024;
const DPAPI_PREFIX: &[u8] = b"DPAPI";
const ATTEMPT_CAP: u64 = 1_000_000;
const MEBIBYTE: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChromiumStage {
    Layout,
    Lock,
    InUse,
    LocalState,
    Scan,
    Space,
    Staging,
    Backup,
    Swap,
    Progress,
    Report,
    Marker,
}

const STAGES: [ChromiumStage; 12] = [
    ChromiumStage::Layout,
    ChromiumStage::Lock,
    ChromiumStage::InUse,
    ChromiumStage::LocalState,
    ChromiumStage::Scan,
    ChromiumStage::Space,
    ChromiumStage::Staging,
    ChromiumStage::Backup,
    ChromiumStage::Swap,
    ChromiumStage::Progress,
    ChromiumStage::Report,
    ChromiumStage::Marker,
];

impl ChromiumStage {
    pub fn as_str(self) -> &'static str {
        match self {
            ChromiumStage::Layout => "layout",
            ChromiumStage::Lock => "lock",
            ChromiumStage::InUse => "in_use",
            ChromiumStage::LocalState => "local_state",
            ChromiumStage::Scan => "scan",
            ChromiumStage::Space => "space",
            ChromiumStage::Staging => "staging",
            ChromiumStage::Backup => "backup",
            ChromiumStage::Swap => "swap",
            ChromiumStage::Progress => "progress",
            ChromiumStage::Report => "report",
            ChromiumStage::Marker => "marker",
        }
    }

    pub fn parse(text: &str) -> Option<ChromiumStage> {
        STAGES.into_iter().find(|stage| stage.as_str() == text)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChromiumCounts {
    pub profiles: u64,
    pub profiles_replaced: u64,
    pub webui_profiles_backed_up: u64,
    pub webui_profiles_left: u64,
    pub files: u64,
    pub megabytes: u64,
    pub skipped_links: u64,
    pub skipped_invalid: u64,
    pub skipped_clash: u64,
    pub key_carried: u64,
    pub key_shared: u64,
    pub key_missing: u64,
    pub key_unreadable: u64,
    pub local_state_kept: u64,
    pub local_state_malformed: u64,
    pub staging_cleared: u64,
    pub swap_rolled_back: u64,
    pub partials_swept: u64,
}

impl ChromiumCounts {
    pub fn skipped(&self) -> u64 {
        self.skipped_links + self.skipped_invalid + self.skipped_clash + self.key_unreadable
    }

    pub fn fields(&self) -> [(&'static str, u64); 18] {
        [
            ("profiles", self.profiles),
            ("profiles_replaced", self.profiles_replaced),
            ("webui_profiles_backed_up", self.webui_profiles_backed_up),
            ("webui_profiles_left", self.webui_profiles_left),
            ("files", self.files),
            ("megabytes", self.megabytes),
            ("skipped_links", self.skipped_links),
            ("skipped_invalid", self.skipped_invalid),
            ("skipped_clash", self.skipped_clash),
            ("key_carried", self.key_carried),
            ("key_shared", self.key_shared),
            ("key_missing", self.key_missing),
            ("key_unreadable", self.key_unreadable),
            ("local_state_kept", self.local_state_kept),
            ("local_state_malformed", self.local_state_malformed),
            ("staging_cleared", self.staging_cleared),
            ("swap_rolled_back", self.swap_rolled_back),
            ("partials_swept", self.partials_swept),
        ]
    }
}

#[derive(Clone, Debug)]
pub struct ChromiumReport {
    pub outcome: Outcome,
    pub failed_stage: Option<ChromiumStage>,
    pub counts: ChromiumCounts,
    pub duration_ms: u64,
    pub attempt: u64,
    pub prior_failed_stage: Option<ChromiumStage>,
    pub run: String,
}

impl ChromiumReport {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("version".into(), json!(REPORT_VERSION));
        object.insert("step".into(), json!(STEP));
        object.insert("run".into(), json!(self.run));
        object.insert("outcome".into(), json!(self.outcome.as_str()));
        if let Some(stage) = self.failed_stage {
            object.insert("failed_stage".into(), json!(stage.as_str()));
        }
        object.insert("attempt".into(), json!(self.attempt));
        if let Some(stage) = self.prior_failed_stage {
            object.insert("prior_failed_stage".into(), json!(stage.as_str()));
        }
        object.insert("duration_ms".into(), json!(self.duration_ms));
        let counts: Map<String, Value> = self
            .counts
            .fields()
            .into_iter()
            .map(|(name, value)| (name.to_string(), json!(value)))
            .collect();
        object.insert("counts".into(), Value::Object(counts));
        Value::Object(object)
    }

    pub fn exit_code(&self) -> u8 {
        match self.outcome {
            Outcome::Migrated | Outcome::MigratedWithSkips | Outcome::AlreadyMigrated | Outcome::NothingToMigrate => 0,
            Outcome::Failed => 1,
            Outcome::Refused => 2,
            Outcome::Busy => 3,
        }
    }
}

fn of_step(report: &Value) -> bool {
    report.get("version").and_then(Value::as_u64) == Some(REPORT_VERSION)
        && report.get("step").and_then(Value::as_str) == Some(STEP)
        && valid_run(report)
        && report.get("attempt").is_some_and(Value::is_u64)
}

pub fn valid_chromium_marker(marker: &Value) -> bool {
    let finished = ["migrated", "migrated_with_skips", "nothing_to_migrate"];
    let counts_ok = marker.get("counts").and_then(Value::as_object).is_some_and(|counts| {
        ChromiumCounts::default()
            .fields()
            .iter()
            .all(|(name, _)| counts.get(*name).is_some_and(Value::is_u64))
    });
    of_step(marker)
        && marker
            .get("outcome")
            .and_then(Value::as_str)
            .is_some_and(|outcome| finished.contains(&outcome))
        && counts_ok
        && marker.get("failed_stage").is_none()
        && marker.get("duration_ms").is_some_and(Value::is_u64)
}

pub fn valid_chromium_attempt(report: &Value) -> bool {
    let written = [
        "failed",
        "busy",
        "migrated",
        "migrated_with_skips",
        "nothing_to_migrate",
    ];
    of_step(report)
        && report
            .get("outcome")
            .and_then(Value::as_str)
            .is_some_and(|outcome| written.contains(&outcome))
}

fn prior_failed_stage(previous: &Value) -> Option<ChromiumStage> {
    let stage_of = |field: &str| {
        previous
            .get(field)
            .and_then(Value::as_str)
            .and_then(ChromiumStage::parse)
    };
    let failed = matches!(previous.get("outcome").and_then(Value::as_str), Some("failed" | "busy"));
    failed
        .then(|| stage_of("failed_stage"))
        .flatten()
        .or_else(|| stage_of("prior_failed_stage"))
}

pub fn read_chromium_marker(webui_data: &std::path::Path) -> Option<Value> {
    read_report(&Root::new(webui_data).ok()?, names::CHROMIUM_MARKER_NAME).filter(valid_chromium_marker)
}

pub fn read_chromium_attempt(webui_data: &std::path::Path) -> Option<Value> {
    read_report(&Root::new(webui_data).ok()?, names::CHROMIUM_ATTEMPT_NAME)
}

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |byte: u8| -> Option<u32> {
        Some(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let body = text.trim_end_matches('=');
    if !text.len().is_multiple_of(4) || text.len() - body.len() > 2 || body.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.as_bytes().chunks(4) {
        let mut word = 0u32;
        for (index, byte) in chunk.iter().enumerate() {
            word |= value(*byte)? << (18 - 6 * index);
        }
        let bytes = word.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

pub fn chromium_key_opens(sealer: &dyn Sealer, encrypted_key: &str) -> bool {
    base64_decode(encrypted_key)
        .and_then(|bytes| bytes.strip_prefix(DPAPI_PREFIX).map(<[u8]>::to_vec))
        .and_then(|sealed| sealer.open_unbound(&sealed))
        .is_some_and(|plain| plain.len() == CHROMIUM_KEY_BYTES)
}

fn encrypted_key(local_state: &Map<String, Value>) -> Option<&str> {
    local_state.get("os_crypt")?.get("encrypted_key")?.as_str()
}

enum RnwKey {
    Missing,
    Unreadable,
    Ready(String),
}

impl RnwKey {
    fn encrypted_key(&self) -> Option<&str> {
        match self {
            RnwKey::Ready(encrypted_key) => Some(encrypted_key),
            _ => None,
        }
    }
}

fn rnw_key(source: &Dir, sealer: &dyn Sealer) -> io::Result<RnwKey> {
    let bytes = match source.read(names::LOCAL_STATE, LOCAL_STATE_LIMIT)? {
        Fetched::Missing => return Ok(RnwKey::Missing),
        Fetched::Data(bytes) => bytes,
        _ => return Ok(RnwKey::Unreadable),
    };
    let Ok(Value::Object(state)) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(RnwKey::Unreadable);
    };
    match encrypted_key(&state) {
        Some(key) if chromium_key_opens(sealer, key) => Ok(RnwKey::Ready(key.to_string())),
        _ => Ok(RnwKey::Unreadable),
    }
}

enum WebUIState {
    Missing,
    Oversized,
    Malformed,
    Parsed(Map<String, Value>),
}

impl WebUIState {
    fn encrypted_key(&self) -> Option<&str> {
        match self {
            WebUIState::Parsed(state) => encrypted_key(state),
            _ => None,
        }
    }

    fn exists(&self) -> bool {
        !matches!(self, WebUIState::Missing)
    }
}

fn webui_state(chromium: Option<&Dir>) -> io::Result<WebUIState> {
    let Some(chromium) = chromium else {
        return Ok(WebUIState::Missing);
    };
    match chromium.read(names::LOCAL_STATE, LOCAL_STATE_LIMIT)? {
        Fetched::Missing => Ok(WebUIState::Missing),
        Fetched::Data(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(state)) => Ok(WebUIState::Parsed(state)),
            _ => Ok(WebUIState::Malformed),
        },
        Fetched::TooLarge => Ok(WebUIState::Oversized),
        _ => Err(fsafe::unsafe_path(names::LOCAL_STATE.into())),
    }
}

pub fn merged_local_state(existing: Option<&Map<String, Value>>, encrypted_key: &str) -> Vec<u8> {
    let mut state = existing.cloned().unwrap_or_default();
    let mut os_crypt = match state.remove("os_crypt") {
        Some(Value::Object(os_crypt)) => os_crypt,
        _ => Map::new(),
    };
    os_crypt.insert("encrypted_key".into(), json!(encrypted_key));
    state.insert("os_crypt".into(), Value::Object(os_crypt));
    serde_json::to_vec(&Value::Object(state)).unwrap_or_default()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Replace,
    Restored,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Replace => "replace",
            Mode::Restored => "restored",
        }
    }
}

#[derive(Clone, Debug)]
struct Progress {
    mode: Mode,
    key: Option<String>,
    skipped: [u64; 3],
    profiles: Vec<(String, String)>,
    staged: bool,
    local_state: bool,
    installed: BTreeSet<String>,
}

impl Progress {
    fn to_json(&self) -> Value {
        json!({
            "version": REPORT_VERSION,
            "mode": self.mode.as_str(),
            "key": self.key,
            "skipped": self.skipped,
            "profiles": self.profiles.iter().map(|(from, to)| json!([from, to])).collect::<Vec<_>>(),
            "staged": self.staged,
            "local_state": self.local_state,
            "installed": self.installed.iter().collect::<Vec<_>>(),
        })
    }

    fn parse(value: &Value) -> Option<Progress> {
        if value.get("version")?.as_u64()? != REPORT_VERSION {
            return None;
        }
        let mode = match value.get("mode")?.as_str()? {
            "replace" => Mode::Replace,
            "restored" => Mode::Restored,
            _ => return None,
        };
        let key = match value.get("key")? {
            Value::Null => None,
            Value::String(key) => Some(key.clone()),
            _ => return None,
        };
        let skipped = value.get("skipped")?.as_array()?;
        let skipped: [u64; 3] = [
            skipped.first()?.as_u64()?,
            skipped.get(1)?.as_u64()?,
            skipped.get(2)?.as_u64()?,
        ];
        let mut profiles = Vec::new();
        for pair in value.get("profiles")?.as_array()? {
            let pair = pair.as_array()?;
            let (from, to) = (pair.first()?.as_str()?, pair.get(1)?.as_str()?);
            if pair.len() != 2 || names::webui_profile_folder(from).as_deref() != Some(to) {
                return None;
            }
            profiles.push((from.to_string(), to.to_string()));
        }
        let targets: BTreeSet<&str> = profiles.iter().map(|(_, to)| to.as_str()).collect();
        if targets.len() != profiles.len() {
            return None;
        }
        let mut installed = BTreeSet::new();
        for name in value.get("installed")?.as_array()? {
            let name = name.as_str()?;
            if !targets.contains(name) {
                return None;
            }
            installed.insert(name.to_string());
        }
        let local_state = value.get("local_state")?.as_bool()?;
        if !local_state && !installed.is_empty() {
            return None;
        }
        Some(Progress {
            mode,
            key,
            skipped,
            profiles,
            staged: value.get("staged")?.as_bool()?,
            local_state,
            installed,
        })
    }
}

enum Step {
    Nothing,
    Busy,
    Done,
}

type StepResult<T> = Result<T, (ChromiumStage, io::Error)>;

#[derive(Debug)]
struct Crash;

impl std::fmt::Display for Crash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stopped as if the process had been killed")
    }
}

impl std::error::Error for Crash {}

fn crashed(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|inner| inner.is::<Crash>())
}

struct Job {
    from: Arc<Dir>,
    to: Arc<Dir>,
    name: String,
    len: u64,
}

fn modified(meta: &std::fs::Metadata) -> Option<SystemTime> {
    meta.modified().ok()
}

const READ_TRIES: u32 = 5;

fn opened_source(dir: &Dir, name: &str) -> io::Result<Opened> {
    let mut tries = 1;
    loop {
        match dir.open_source(name) {
            Err(error) if tries < READ_TRIES && !fsafe::is_unsafe(&error) => {
                std::thread::sleep(std::time::Duration::from_millis(100 * u64::from(tries)));
                tries += 1;
            }
            other => return other,
        }
    }
}

enum Copied {
    Bytes(u64),
    Vanished,
    Link,
    Invalid,
}

fn copy_one(job: &Job, buffer: &mut [u8]) -> io::Result<Copied> {
    let (mut source, meta) = match opened_source(&job.from, &job.name)? {
        Opened::File(file, meta) => (file, meta),
        Opened::Missing => return Ok(Copied::Vanished),
        Opened::Link => return Ok(Copied::Link),
        Opened::NotRegular | Opened::HardLinked => return Ok(Copied::Invalid),
    };
    let (staged, copied) = job.to.stage_copy(&mut source, buffer, modified(&meta))?;
    job.to.commit(staged, &job.name)?;
    Ok(Copied::Bytes(copied))
}

const MOVE_TRIES: u32 = 20;

fn held_by_another_process(error: &io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

fn moved(mut attempt: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let mut tries = 1;
    loop {
        match attempt() {
            Err(error) if tries < MOVE_TRIES && held_by_another_process(&error) => {
                std::thread::sleep(std::time::Duration::from_millis(50 * u64::from(tries)));
                tries += 1;
            }
            other => return other,
        }
    }
}

fn out_of_space(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::StorageFull
        || matches!(error.raw_os_error(), Some(code) if cfg!(windows) && (code == 39 || code == 112))
}

fn has_preferences(dir: &Dir, name: &str) -> io::Result<bool> {
    let Some(profile) = dir.child(name, false)? else {
        return Ok(false);
    };
    Ok(profile.entry("Preferences")? == Entry::File)
}

enum Undo {
    MovedAside(String),
    LocalState { previous: bool },
    Installed(String),
}

struct Run<'a> {
    webui: &'a Root,
    sealer: &'a dyn Sealer,
    faults: &'a Faults,
    run: String,
    counts: ChromiumCounts,
    commits: usize,
    kept: Option<Dir>,
    journal: Vec<Undo>,
    rollback_steps: usize,
}

impl Run<'_> {
    fn checkpoint(&mut self) -> io::Result<()> {
        self.commits += 1;
        if self.faults.crash_at_commit == Some(self.commits) {
            return Err(io::Error::other(Crash));
        }
        if self.faults.fail_at_commit == Some(self.commits) {
            return Err(io::Error::other("stopped before a rename"));
        }
        Ok(())
    }

    fn write(&mut self, dir: &Dir, name: &str, bytes: &[u8]) -> io::Result<()> {
        let staged = dir.stage(bytes)?;
        if let Err(error) = self.checkpoint() {
            if crashed(&error) {
                dir.abandon(staged);
            } else {
                dir.discard(staged);
            }
            return Err(error);
        }
        dir.commit(staged, name)
    }

    fn progress_bytes(progress: &Progress) -> io::Result<Vec<u8>> {
        serde_json::to_vec_pretty(&progress.to_json()).map_err(io::Error::other)
    }

    fn save_progress(&mut self, progress: &Progress) -> StepResult<()> {
        let bytes = Self::progress_bytes(progress).map_err(|e| (ChromiumStage::Progress, e))?;
        let root = self.webui.dir();
        self.write(root, names::CHROMIUM_PROGRESS_NAME, &bytes)
            .map_err(|e| (ChromiumStage::Progress, e))
    }

    fn save_progress_now(&self, progress: &Progress) -> io::Result<()> {
        self.webui
            .dir()
            .write(names::CHROMIUM_PROGRESS_NAME, &Self::progress_bytes(progress)?)
    }

    fn read_progress(&self) -> io::Result<Option<Progress>> {
        Ok(
            match self.webui.dir().read(names::CHROMIUM_PROGRESS_NAME, PROGRESS_LIMIT)? {
                Fetched::Data(bytes) => serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .as_ref()
                    .and_then(Progress::parse),
                _ => None,
            },
        )
    }

    fn kept(&mut self) -> io::Result<&Dir> {
        if self.kept.is_none() {
            let folder = format!("{}-{}", names::CHROMIUM_FOLDER, self.run);
            let root = self
                .webui
                .folder(&[names::KEPT_FOLDER], true)?
                .ok_or_else(|| fsafe::unsafe_path(names::KEPT_FOLDER.into()))?;
            if root.entry(&folder)? != Entry::Missing {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "a backup folder is never written twice",
                ));
            }
            let kept = root
                .child(&folder, true)?
                .ok_or_else(|| fsafe::unsafe_path(folder.into()))?;
            self.kept = Some(kept);
        }
        Ok(self.kept.as_ref().expect("kept folder was just made"))
    }

    fn chromium(&self, create: bool) -> io::Result<Option<Dir>> {
        self.webui.folder(&[names::CHROMIUM_FOLDER], create)
    }

    fn live(&self) -> io::Result<Dir> {
        self.chromium(true)?
            .ok_or_else(|| fsafe::unsafe_path(names::CHROMIUM_FOLDER.into()))
    }

    fn staging(&self, create: bool) -> io::Result<Option<Dir>> {
        self.webui.folder(&[names::CHROMIUM_STAGING_FOLDER], create)
    }

    fn sweep(&mut self) -> io::Result<()> {
        self.counts.partials_swept += self.webui.dir().sweep_partials()? as u64;
        if let Some(chromium) = self.chromium(false)? {
            self.counts.partials_swept += chromium.sweep_partials()? as u64;
        }
        Ok(())
    }

    fn plan(&mut self, source: &Dir) -> io::Result<Vec<(String, String)>> {
        let mut planned = BTreeMap::new();
        let mut names_in_source = source.list()?;
        names_in_source.sort_by_key(|name| name != names::RNW_DEFAULT_PROFILE);
        for name in names_in_source {
            let Some(target) = names::webui_profile_folder(&name) else {
                continue;
            };
            match source.entry(&name)? {
                Entry::Directory => {}
                Entry::Link => {
                    self.counts.skipped_links += 1;
                    continue;
                }
                Entry::Missing => continue,
                Entry::File | Entry::Other => {
                    self.counts.skipped_invalid += 1;
                    continue;
                }
            }
            if planned.contains_key(&names::folded(&target)) {
                self.counts.skipped_clash += 1;
                continue;
            }
            planned.insert(names::folded(&target), (name, target));
        }
        let mut profiles: Vec<(String, String)> = planned.into_values().collect();
        profiles.sort_by(|a, b| a.1.cmp(&b.1));
        Ok(profiles)
    }

    fn scan(
        &mut self,
        source: Arc<Dir>,
        target: Arc<Dir>,
        parents: &mut Vec<String>,
        jobs: &mut Vec<Job>,
    ) -> io::Result<()> {
        let mut wanted = BTreeSet::new();
        for name in source.list()? {
            if names::profile_transient(parents, &name) {
                continue;
            }
            match source.entry(&name)? {
                Entry::Missing => {}
                Entry::Link => self.counts.skipped_links += 1,
                Entry::Other => self.counts.skipped_invalid += 1,
                Entry::Directory if parents.len() + 1 >= DEPTH_LIMIT => self.counts.skipped_invalid += 1,
                Entry::Directory => {
                    let Some(inner) = source.child(&name, false)? else {
                        continue;
                    };
                    if !matches!(target.entry(&name)?, Entry::Missing | Entry::Directory) {
                        target.remove_tree(&name)?;
                    }
                    let made = target
                        .child(&name, true)?
                        .ok_or_else(|| fsafe::unsafe_path(name.clone().into()))?;
                    wanted.insert(name.clone());
                    parents.push(name);
                    let scanned = self.scan(Arc::new(inner), Arc::new(made), parents, jobs);
                    parents.pop();
                    scanned?;
                }
                Entry::File => {
                    let meta = match opened_source(&source, &name)? {
                        Opened::File(_, meta) => meta,
                        Opened::Missing => continue,
                        Opened::Link => {
                            self.counts.skipped_links += 1;
                            continue;
                        }
                        Opened::NotRegular | Opened::HardLinked => {
                            self.counts.skipped_invalid += 1;
                            continue;
                        }
                    };
                    wanted.insert(name.clone());
                    if !matches!(target.entry(&name)?, Entry::Missing | Entry::File) {
                        target.remove_tree(&name)?;
                    }
                    jobs.push(Job {
                        from: Arc::clone(&source),
                        to: Arc::clone(&target),
                        name,
                        len: meta.len(),
                    });
                }
            }
        }
        for stale in target.list()? {
            if !wanted.contains(&stale) {
                target.remove_tree(&stale)?;
            }
        }
        Ok(())
    }

    fn copy(&mut self, jobs: &[Job]) -> io::Result<u64> {
        let workers = if self.faults.fail_at_file.is_some() {
            1
        } else {
            COPY_WORKERS
        };
        let next = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        let stop = AtomicBool::new(false);
        let bytes = AtomicU64::new(0);
        let tallies: [AtomicU64; 3] = Default::default();
        let failure: Mutex<Option<io::Error>> = Mutex::new(None);
        let fail_at_file = self.faults.fail_at_file;
        let fail = |error: io::Error| {
            stop.store(true, Ordering::SeqCst);
            failure.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(error);
        };
        std::thread::scope(|scope| {
            for _ in 0..workers.min(jobs.len().max(1)) {
                scope.spawn(|| {
                    let mut buffer = vec![0u8; COPY_BUFFER];
                    while !stop.load(Ordering::SeqCst) {
                        let index = next.fetch_add(1, Ordering::SeqCst);
                        let Some(job) = jobs.get(index) else {
                            break;
                        };
                        if fail_at_file.is_some_and(|limit| done.load(Ordering::SeqCst) >= limit) {
                            fail(io::Error::other("stopped before a file"));
                            break;
                        }
                        match copy_one(job, &mut buffer) {
                            Ok(Copied::Bytes(copied)) => {
                                bytes.fetch_add(copied, Ordering::SeqCst);
                                tallies[0].fetch_add(1, Ordering::SeqCst);
                            }
                            Ok(Copied::Vanished) => {}
                            Ok(Copied::Link) => {
                                tallies[1].fetch_add(1, Ordering::SeqCst);
                            }
                            Ok(Copied::Invalid) => {
                                tallies[2].fetch_add(1, Ordering::SeqCst);
                            }
                            Err(error) => fail(error),
                        }
                        done.fetch_add(1, Ordering::SeqCst);
                    }
                });
            }
        });
        self.counts.skipped_links += tallies[1].load(Ordering::SeqCst);
        self.counts.skipped_invalid += tallies[2].load(Ordering::SeqCst);
        match failure.into_inner().unwrap_or_else(|e| e.into_inner()) {
            Some(error) => Err(error),
            None => {
                self.counts.megabytes += bytes.load(Ordering::SeqCst).div_ceil(MEBIBYTE);
                Ok(tallies[0].load(Ordering::SeqCst))
            }
        }
    }

    fn room_for(&self, jobs: &[Job]) -> io::Result<()> {
        self.room_for_bytes(jobs.iter().map(|job| job.len).sum())
    }

    fn room_for_bytes(&self, needed: u64) -> io::Result<()> {
        let free = match self.faults.free_space {
            Some(free) => free,
            None => fsafe::free_space(&self.webui.resolved)?,
        };
        if free < needed.saturating_add(SPACE_MARGIN) {
            return Err(io::Error::new(
                io::ErrorKind::StorageFull,
                "not enough free space to copy the profiles",
            ));
        }
        Ok(())
    }

    fn stage_profiles(&mut self, source: &Dir, profiles: &[(String, String)]) -> StepResult<()> {
        let mut jobs = Vec::new();
        {
            let staging = self
                .staging(true)
                .and_then(|staging| staging.ok_or_else(|| fsafe::unsafe_path(names::CHROMIUM_STAGING_FOLDER.into())))
                .map_err(|e| (ChromiumStage::Scan, e))?;
            let targets: BTreeSet<&str> = profiles.iter().map(|(_, to)| to.as_str()).collect();
            for stale in staging.list().map_err(|e| (ChromiumStage::Scan, e))? {
                if !targets.contains(stale.as_str()) {
                    staging.remove_tree(&stale).map_err(|e| (ChromiumStage::Scan, e))?;
                }
            }
            for (from, to) in profiles {
                let scanned = (|| -> io::Result<()> {
                    let inner = source
                        .child(from, false)?
                        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the profile folder went away"))?;
                    let made = staging.child(to, true)?.ok_or_else(|| fsafe::unsafe_path(to.into()))?;
                    self.scan(Arc::new(inner), Arc::new(made), &mut Vec::new(), &mut jobs)
                })();
                scanned.map_err(|e| (ChromiumStage::Scan, e))?;
            }
        }
        self.room_for(&jobs).map_err(|e| (ChromiumStage::Space, e))?;
        let copied = self.copy(&jobs);
        drop(jobs);
        self.counts.files += copied.map_err(|e| (ChromiumStage::Staging, e))?;
        Ok(())
    }

    fn back_up_live(&mut self, targets: &[String], webui: &WebUIState) -> StepResult<()> {
        let backup = |e| (ChromiumStage::Backup, e);
        let Some(chromium) = self.chromium(false).map_err(backup)? else {
            return Ok(());
        };
        let mut left = Vec::new();
        for name in chromium.list().map_err(backup)? {
            let replaced = targets.iter().any(|to| to.eq_ignore_ascii_case(&name));
            if !replaced
                && chromium.entry(&name).map_err(backup)? == Entry::Directory
                && has_preferences(&chromium, &name).map_err(backup)?
            {
                left.push(name);
            }
        }
        if left.is_empty() && !webui.exists() {
            return Ok(());
        }
        if webui.exists() {
            let len = match chromium.open_source(names::LOCAL_STATE).map_err(backup)? {
                Opened::File(_, meta) => meta.len(),
                _ => return Err(backup(fsafe::unsafe_path(names::LOCAL_STATE.into()))),
            };
            self.room_for_bytes(len).map_err(|e| (ChromiumStage::Space, e))?;
            self.keep_local_state(&chromium).map_err(backup)?;
        }
        let chromium = Arc::new(chromium);
        let kept = Arc::new(self.kept().map_err(backup)?.try_clone().map_err(backup)?);
        let mut jobs = Vec::new();
        for name in &left {
            let inner = chromium
                .child(name, false)
                .and_then(|inner| inner.ok_or_else(|| fsafe::unsafe_path(name.clone().into())))
                .map_err(backup)?;
            let made = kept
                .child(name, true)
                .and_then(|made| made.ok_or_else(|| fsafe::unsafe_path(name.clone().into())))
                .map_err(backup)?;
            self.scan(Arc::new(inner), Arc::new(made), &mut Vec::new(), &mut jobs)
                .map_err(backup)?;
        }
        self.room_for(&jobs).map_err(|e| (ChromiumStage::Space, e))?;
        let files = self.copy(&jobs);
        drop(jobs);
        files.map_err(backup)?;
        self.counts.webui_profiles_backed_up += left.len() as u64;
        Ok(())
    }

    fn keep_local_state(&mut self, chromium: &Dir) -> io::Result<()> {
        let kept = self.kept()?;
        if kept.entry(names::LOCAL_STATE)? != Entry::Missing {
            return Ok(());
        }
        let (mut live, meta) = match chromium.open_source(names::LOCAL_STATE)? {
            Opened::File(file, meta) => (file, meta),
            Opened::Missing => return Ok(()),
            _ => return Err(fsafe::unsafe_path(names::LOCAL_STATE.into())),
        };
        let mut buffer = vec![0u8; COPY_BUFFER];
        let (staged, _) = kept.stage_copy(&mut live, &mut buffer, modified(&meta))?;
        kept.commit(staged, names::LOCAL_STATE)?;
        self.counts.local_state_kept = 1;
        Ok(())
    }

    fn move_aside(&mut self, to: &str) -> io::Result<bool> {
        let chromium = self.live()?;
        if chromium.entry(to)? == Entry::Missing {
            return Ok(false);
        }
        self.keep_local_state(&chromium)?;
        self.checkpoint()?;
        let kept = self.kept()?;
        moved(|| chromium.move_to(to, kept, to))?;
        self.counts.profiles_replaced += 1;
        Ok(true)
    }

    fn install(&mut self, to: &str) -> io::Result<()> {
        let staging = self.staging(false)?;
        let staged = match &staging {
            Some(staging) => staging.entry(to)? == Entry::Directory,
            None => false,
        };
        let chromium = self.live()?;
        let present = chromium.entry(to)?;
        let Some(staging) = staging.filter(|_| staged) else {
            return if present == Entry::Directory {
                Ok(())
            } else {
                Err(io::Error::new(io::ErrorKind::NotFound, "a staged profile went missing"))
            };
        };
        if self.move_aside(to)? {
            self.journal.push(Undo::MovedAside(to.to_string()));
        }
        self.checkpoint()?;
        moved(|| staging.move_to(to, &chromium, to))?;
        self.journal.push(Undo::Installed(to.to_string()));
        Ok(())
    }

    fn write_key(&mut self, encrypted_key: &str, webui: &WebUIState) -> io::Result<()> {
        let chromium = self.live()?;
        let existing = match webui {
            WebUIState::Parsed(state) => Some(state),
            _ => None,
        };
        let bytes = merged_local_state(existing, encrypted_key);
        self.write(&chromium, names::LOCAL_STATE, &bytes)?;
        self.journal.push(Undo::LocalState {
            previous: webui.exists(),
        });
        self.counts.key_carried = 1;
        Ok(())
    }

    fn reconcile(&self, progress: &mut Progress, webui: &WebUIState) -> io::Result<()> {
        let staging = self.staging(false)?;
        let live = self.chromium(false)?;
        let mut undone = Vec::new();
        for to in &progress.installed {
            let in_staging = match &staging {
                Some(staging) => staging.entry(to)? == Entry::Directory,
                None => false,
            };
            let in_live = match &live {
                Some(live) => live.entry(to)? == Entry::Directory,
                None => false,
            };
            if in_staging && !in_live {
                undone.push(to.clone());
            }
        }
        for to in undone {
            progress.installed.remove(&to);
        }
        let wanted = progress.key.as_deref().filter(|_| progress.mode == Mode::Replace);
        if progress.local_state && wanted.is_some() && webui.encrypted_key() != wanted {
            progress.local_state = false;
        }
        Ok(())
    }

    fn swap(&mut self, progress: &mut Progress, webui: &WebUIState) -> StepResult<()> {
        let swap = |e| (ChromiumStage::Swap, e);
        self.reconcile(progress, webui).map_err(swap)?;
        let targets: Vec<String> = progress.profiles.iter().map(|(_, to)| to.clone()).collect();
        let pending: Vec<String> = targets
            .iter()
            .filter(|to| !progress.installed.contains(*to))
            .cloned()
            .collect();
        if !progress.local_state {
            let key = progress
                .key
                .clone()
                .filter(|key| progress.mode == Mode::Replace && webui.encrypted_key() != Some(key.as_str()));
            if let Some(key) = key {
                self.back_up_live(&pending, webui)?;
                for to in &pending {
                    if self.move_aside(to).map_err(swap)? {
                        self.journal.push(Undo::MovedAside(to.clone()));
                    }
                }
                self.write_key(&key, webui)
                    .map_err(|e| (ChromiumStage::LocalState, e))?;
            }
            progress.local_state = true;
            self.save_progress(progress)?;
        }
        for to in &pending {
            if progress.mode == Mode::Restored
                && self.live().and_then(|live| live.entry(to)).map_err(swap)? == Entry::Directory
            {
                continue;
            }
            self.install(to).map_err(swap)?;
            progress.installed.insert(to.clone());
            self.save_progress(progress)?;
        }
        Ok(())
    }

    fn rollback_step(&mut self) -> io::Result<()> {
        self.rollback_steps += 1;
        if self.faults.crash_in_rollback_at == Some(self.rollback_steps) {
            return Err(io::Error::other(Crash));
        }
        Ok(())
    }

    fn roll_back(&mut self, progress: &mut Progress) -> io::Result<()> {
        let journal = std::mem::take(&mut self.journal);
        for undo in journal.into_iter().rev() {
            let chromium = self.live()?;
            match undo {
                Undo::Installed(name) => {
                    let staging = self
                        .staging(true)?
                        .ok_or_else(|| fsafe::unsafe_path(names::CHROMIUM_STAGING_FOLDER.into()))?;
                    progress.installed.remove(&name);
                    self.rollback_step()?;
                    self.save_progress_now(progress)?;
                    self.rollback_step()?;
                    moved(|| chromium.move_to(&name, &staging, &name))?;
                }
                Undo::LocalState { previous } => {
                    progress.installed.clear();
                    progress.local_state = false;
                    self.rollback_step()?;
                    self.save_progress_now(progress)?;
                    self.rollback_step()?;
                    if previous {
                        let kept = self.kept()?;
                        let mut saved = match kept.open_source(names::LOCAL_STATE)? {
                            Opened::File(file, _) => file,
                            _ => return Err(io::Error::other("the kept Local State is gone")),
                        };
                        let staged = chromium.stage_from(&mut saved)?;
                        chromium.commit(staged, names::LOCAL_STATE)?;
                    } else {
                        chromium.remove_file(names::LOCAL_STATE)?;
                    }
                }
                Undo::MovedAside(name) => {
                    if chromium.entry(&name)? == Entry::Missing {
                        self.rollback_step()?;
                        let kept = self.kept()?;
                        moved(|| kept.move_to(&name, &chromium, &name))?;
                    }
                }
            }
        }
        self.counts.swap_rolled_back = u64::from(self.rollback_steps > 0);
        Ok(())
    }

    fn steps(&mut self, rnw: Option<&Root>) -> StepResult<Step> {
        self.sweep().map_err(|e| (ChromiumStage::Lock, e))?;
        let Some(rnw) = rnw else {
            return Ok(Step::Nothing);
        };
        let source = rnw.dir();
        let in_use = |e| (ChromiumStage::InUse, e);
        if source.held_open(names::CHROMIUM_LOCK_FILE).map_err(in_use)? {
            return Ok(Step::Busy);
        }
        let chromium = self.chromium(false).map_err(|e| (ChromiumStage::Layout, e))?;
        if let Some(chromium) = &chromium {
            if chromium.held_open(names::CHROMIUM_LOCK_FILE).map_err(in_use)? {
                return Ok(Step::Busy);
            }
        }
        let stored = self
            .read_progress()
            .map_err(|e| (ChromiumStage::Progress, e))?
            .filter(|progress| progress.staged);
        let stored_was_some = stored.is_some();
        let planned = match &stored {
            Some(progress) if !progress.profiles.is_empty() => progress.profiles.clone(),
            _ => self.plan(source).map_err(|e| (ChromiumStage::Scan, e))?,
        };
        if planned.is_empty() {
            return Ok(Step::Nothing);
        }
        let _rnw_lock = source.hold_lockfile(names::CHROMIUM_LOCK_FILE).map_err(in_use)?;
        let _webui_lock = self
            .live()
            .and_then(|live| live.hold_lockfile(names::CHROMIUM_LOCK_FILE))
            .map_err(in_use)?;
        let chromium = self.chromium(false).map_err(|e| (ChromiumStage::Layout, e))?;

        let local = |e| (ChromiumStage::LocalState, e);
        let rnw_key = rnw_key(source, self.sealer).map_err(local)?;
        let webui = webui_state(chromium.as_ref()).map_err(local)?;
        match rnw_key {
            RnwKey::Missing => self.counts.key_missing = 1,
            RnwKey::Unreadable => self.counts.key_unreadable = 1,
            RnwKey::Ready(_) => {}
        }
        if matches!(webui, WebUIState::Malformed | WebUIState::Oversized) {
            self.counts.local_state_malformed = 1;
        }

        let usable = stored.filter(|progress| {
            progress.mode == Mode::Replace
                || (webui.encrypted_key() == progress.key.as_deref()
                    && progress.key.as_deref() == rnw_key.encrypted_key())
        });
        let planned = match (&usable, stored_was_some) {
            (None, true) => self.plan(source).map_err(|e| (ChromiumStage::Scan, e))?,
            _ => planned,
        };
        if planned.is_empty() && usable.is_none() {
            return Ok(Step::Nothing);
        }
        let stored = usable;
        let mut progress = match stored {
            Some(mut progress) => {
                let current = rnw_key.encrypted_key().map(str::to_string);
                self.restage(source, &mut progress, current)?;
                progress
            }
            None => {
                let shared = rnw_key.encrypted_key().is_some() && rnw_key.encrypted_key() == webui.encrypted_key();
                let mode = if shared { Mode::Restored } else { Mode::Replace };
                let mut profiles = Vec::new();
                for (from, to) in planned {
                    let present = match &chromium {
                        Some(chromium) => {
                            chromium.entry(&to).map_err(|e| (ChromiumStage::Scan, e))? == Entry::Directory
                        }
                        None => false,
                    };
                    if mode == Mode::Restored && present {
                        continue;
                    }
                    profiles.push((from, to));
                }
                let progress = Progress {
                    mode,
                    key: rnw_key.encrypted_key().map(str::to_string),
                    skipped: [0; 3],
                    profiles,
                    staged: false,
                    local_state: false,
                    installed: BTreeSet::new(),
                };
                if !progress.profiles.is_empty() {
                    self.stage_profiles(source, &progress.profiles)?;
                }
                let progress = Progress {
                    staged: true,
                    skipped: [
                        self.counts.skipped_links,
                        self.counts.skipped_invalid,
                        self.counts.skipped_clash,
                    ],
                    ..progress
                };
                self.save_progress(&progress)?;
                progress
            }
        };
        self.counts.key_shared = u64::from(progress.mode == Mode::Restored);

        let swapped_here = !progress.local_state;
        if let Err((stage, error)) = self.swap(&mut progress, &webui) {
            if swapped_here && !crashed(&error) {
                if let Err(stopped) = self.roll_back(&mut progress) {
                    if crashed(&stopped) {
                        return Err((stage, stopped));
                    }
                }
            }
            return Err((stage, error));
        }
        self.counts.profiles = progress.installed.len() as u64;
        let targets: Vec<String> = progress.profiles.iter().map(|(_, to)| to.clone()).collect();
        if let Some(chromium) = self.chromium(false).map_err(|e| (ChromiumStage::Swap, e))? {
            for name in chromium.list().map_err(|e| (ChromiumStage::Swap, e))? {
                if names::webui_profile_name(&name)
                    && !targets.iter().any(|to| to.eq_ignore_ascii_case(&name))
                    && chromium.entry(&name).map_err(|e| (ChromiumStage::Swap, e))? == Entry::Directory
                {
                    self.counts.webui_profiles_left += 1;
                }
            }
        }
        let _ = self.webui.dir().remove_tree(names::CHROMIUM_STAGING_FOLDER);
        Ok(Step::Done)
    }

    fn restage(&mut self, source: &Dir, progress: &mut Progress, current: Option<String>) -> StepResult<()> {
        let scan = |e| (ChromiumStage::Scan, e);
        let live = self.chromium(false).map_err(scan)?;
        if progress.key != current {
            progress.key = current;
            progress.mode = Mode::Replace;
            progress.local_state = false;
            progress.installed.clear();
        }
        let mut planned = std::mem::take(&mut progress.profiles);
        for (from, to) in self.plan(source).map_err(scan)? {
            if !planned.iter().any(|(_, known)| known.eq_ignore_ascii_case(&to)) {
                planned.push((from, to));
            }
        }
        let mut profiles = Vec::new();
        let mut pending = Vec::new();
        for (from, to) in planned {
            let in_live = match &live {
                Some(live) => live.entry(&to).map_err(scan)? == Entry::Directory,
                None => false,
            };
            if progress.installed.contains(&to) && in_live {
                profiles.push((from, to));
                continue;
            }
            progress.installed.remove(&to);
            if progress.mode == Mode::Restored && in_live {
                profiles.push((from, to));
                continue;
            }
            if source.entry(&from).map_err(scan)? == Entry::Directory {
                pending.push((from.clone(), to.clone()));
                profiles.push((from, to));
            }
        }
        profiles.sort_by(|a, b| a.1.cmp(&b.1));
        progress.profiles = profiles;
        if !pending.is_empty() {
            self.stage_profiles(source, &pending)?;
        }
        progress.skipped = [
            self.counts.skipped_links,
            self.counts.skipped_invalid,
            self.counts.skipped_clash,
        ];
        self.save_progress(progress)
    }

    fn clear_staging(&mut self) {
        let live = self
            .chromium(false)
            .ok()
            .flatten()
            .and_then(|chromium| webui_state(Some(&chromium)).ok());
        let live_key = live.as_ref().and_then(WebUIState::encrypted_key);
        let committed = matches!(self.read_progress(), Ok(Some(progress)) if progress.local_state
            || (progress.mode == Mode::Replace && progress.key.is_some() && progress.key.as_deref() == live_key));
        let _ = self.webui.dir().remove_tree(names::CHROMIUM_STAGING_FOLDER);
        if !committed {
            let _ = self.webui.dir().remove_file(names::CHROMIUM_PROGRESS_NAME);
        }
        self.counts.staging_cleared = 1;
    }
}

fn report_bytes(report: &ChromiumReport) -> io::Result<Vec<u8>> {
    serde_json::to_vec_pretty(&report.to_json()).map_err(io::Error::other)
}

pub fn migrate_chromium(layout: &Layout, sealer: &dyn Sealer, faults: &Faults) -> ChromiumReport {
    let started = Instant::now();
    let mut report = ChromiumReport {
        outcome: Outcome::Failed,
        failed_stage: None,
        counts: ChromiumCounts::default(),
        duration_ms: 0,
        attempt: 1,
        prior_failed_stage: None,
        run: fsafe::run_id(),
    };
    let finish = |mut report: ChromiumReport| {
        report.duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        report
    };
    let refuse = |mut report: ChromiumReport, stage: ChromiumStage| {
        report.outcome = Outcome::Refused;
        report.failed_stage = Some(stage);
        finish(report)
    };

    if check_layout(layout).is_err() {
        return refuse(report, ChromiumStage::Layout);
    }
    if matches!(fsafe::entry(&layout.rnw_chromium), Ok(Entry::Missing)) {
        report.outcome = Outcome::NothingToMigrate;
        return finish(report);
    }
    let webui = match Root::open_or_create(&layout.webui_data) {
        Ok(webui) => webui,
        Err(error) if fsafe::is_unsafe(&error) => return refuse(report, ChromiumStage::Layout),
        Err(_) => {
            report.failed_stage = Some(ChromiumStage::Layout);
            return finish(report);
        }
    };
    let Ok(rnw) = source_root(&layout.rnw_chromium) else {
        return refuse(report, ChromiumStage::Layout);
    };
    if rnw
        .as_ref()
        .is_some_and(|root| overlapping(&root.resolved, &webui.resolved))
    {
        return refuse(report, ChromiumStage::Layout);
    }

    let lock = match webui.dir().open_lock(names::LOCK_NAME) {
        Ok(lock) => lock,
        Err(error) if fsafe::is_unsafe(&error) => return refuse(report, ChromiumStage::Lock),
        Err(_) => {
            report.failed_stage = Some(ChromiumStage::Lock);
            return finish(report);
        }
    };
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            report.outcome = Outcome::Busy;
            report.failed_stage = Some(ChromiumStage::Lock);
            return finish(report);
        }
        Err(std::fs::TryLockError::Error(_)) => {
            report.failed_stage = Some(ChromiumStage::Lock);
            return finish(report);
        }
    }

    if !matches!(
        webui.dir().entry(names::CHROMIUM_MARKER_NAME),
        Ok(Entry::Missing | Entry::File)
    ) {
        return refuse(report, ChromiumStage::Marker);
    }
    if read_report(&webui, names::CHROMIUM_MARKER_NAME)
        .filter(valid_chromium_marker)
        .is_some()
    {
        report.outcome = Outcome::AlreadyMigrated;
        return finish(report);
    }
    let previous = match webui.dir().read(names::CHROMIUM_ATTEMPT_NAME, REPORT_LIMIT) {
        Ok(Fetched::Data(bytes)) => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .filter(valid_chromium_attempt),
        _ => None,
    };
    report.attempt = previous
        .as_ref()
        .and_then(|previous| previous.get("attempt").and_then(Value::as_u64))
        .map_or(1, |previous| previous.saturating_add(1).min(ATTEMPT_CAP));
    report.prior_failed_stage = previous.as_ref().and_then(prior_failed_stage);

    let mut run = Run {
        webui: &webui,
        sealer,
        faults,
        run: report.run.clone(),
        counts: ChromiumCounts::default(),
        commits: 0,
        kept: None,
        journal: Vec::new(),
        rollback_steps: 0,
    };
    let stepped = run.steps(rnw.as_ref());
    if let Err((_, error)) = &stepped {
        if crashed(error) {
            report.outcome = Outcome::Failed;
            report.counts = run.counts.clone();
            return finish(report);
        }
    }
    if let Err((ChromiumStage::Space | ChromiumStage::Staging, error)) = &stepped {
        if out_of_space(error) && run.counts.swap_rolled_back == 0 && run.counts.key_carried == 0 {
            run.clear_staging();
        }
    }
    report.counts = run.counts.clone();
    let write_attempt = |report: &mut ChromiumReport| {
        if report_bytes(report)
            .and_then(|bytes| webui.dir().write(names::CHROMIUM_ATTEMPT_NAME, &bytes))
            .is_err()
        {
            report.failed_stage = Some(ChromiumStage::Report);
        }
    };
    match stepped {
        Err((stage, _error)) => {
            report.outcome = Outcome::Failed;
            report.failed_stage = Some(stage);
            let mut report = finish(report);
            write_attempt(&mut report);
            return report;
        }
        Ok(Step::Busy) => {
            report.outcome = Outcome::Busy;
            report.failed_stage = Some(ChromiumStage::InUse);
            let mut report = finish(report);
            write_attempt(&mut report);
            return report;
        }
        Ok(Step::Nothing) => report.outcome = Outcome::NothingToMigrate,
        Ok(Step::Done) => {
            report.outcome = if report.counts.skipped() > 0 {
                Outcome::MigratedWithSkips
            } else {
                Outcome::Migrated
            }
        }
    }
    let mut report = finish(report);
    let root = webui.dir();
    let commits = [
        (names::CHROMIUM_ATTEMPT_NAME, ChromiumStage::Report),
        (names::CHROMIUM_MARKER_NAME, ChromiumStage::Marker),
    ];
    for (name, stage) in commits {
        let written = report_bytes(&report).and_then(|bytes| run.write(root, name, &bytes));
        if written.is_err() {
            report.outcome = Outcome::Failed;
            report.failed_stage = Some(stage);
            write_attempt(&mut report);
            return report;
        }
    }
    let _ = root.remove_file(names::CHROMIUM_PROGRESS_NAME);
    drop(lock);
    report
}
