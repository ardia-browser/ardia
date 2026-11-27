use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

use crate::credentials::{self, Assembled, StoredCredential};
use crate::fsafe::{self, Dir, Entry, Fetched, Root};
use crate::names;

pub const MARKER_VERSION: u64 = 1;
pub const DOCUMENT_LIMIT: u64 = 64 * 1024 * 1024;
pub const CONFIG_LIMIT: u64 = 4 * 1024 * 1024;
pub const SYNC_KEY_LIMIT: u64 = 64 * 1024;
pub const SECRET_FILE_LIMIT: u64 = 1024 * 1024;
pub const SYNC_KEY_BYTES: usize = 32;
const ATTEMPT_CAP: u64 = 1_000_000;

pub trait Sealer {
    fn seal(&self, plain: &[u8], purpose: &str) -> io::Result<Vec<u8>>;
    fn open(&self, sealed: &[u8], purpose: &str) -> Option<Zeroizing<Vec<u8>>>;
}

pub trait Vault {
    fn list(&self, prefix: &str) -> io::Result<Vec<StoredCredential>>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    pub rnw_data: PathBuf,
    pub rnw_config: PathBuf,
    pub webui_data: PathBuf,
    pub credential_prefix: String,
    pub test_instance: bool,
}

pub const WEBUI_FOLDER: &str = "Ardia WebUI";
pub const RNW_FOLDER: &str = "Ardia";

impl Layout {
    pub fn standard(local_app_data: &Path, roaming_app_data: &Path, test_instance: bool) -> Layout {
        Layout {
            rnw_data: local_app_data.join(RNW_FOLDER),
            rnw_config: roaming_app_data.join(RNW_FOLDER),
            webui_data: local_app_data.join(WEBUI_FOLDER),
            credential_prefix: names::credential_prefix(None),
            test_instance,
        }
    }

    pub fn custom(rnw_data: &str, webui_data: &Path, test_instance: bool) -> Layout {
        let rnw = PathBuf::from(rnw_data);
        Layout {
            rnw_config: rnw.join(names::CONFIG_FOLDER),
            rnw_data: rnw,
            webui_data: webui_data.to_path_buf(),
            credential_prefix: names::credential_prefix(Some(rnw_data)),
            test_instance,
        }
    }
}

#[derive(Default)]
pub struct Faults {
    pub fail_at_commit: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Migrated,
    MigratedWithSkips,
    AlreadyMigrated,
    NothingToMigrate,
    Busy,
    Refused,
    Failed,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Migrated => "migrated",
            Outcome::MigratedWithSkips => "migrated_with_skips",
            Outcome::AlreadyMigrated => "already_migrated",
            Outcome::NothingToMigrate => "nothing_to_migrate",
            Outcome::Busy => "busy",
            Outcome::Refused => "refused",
            Outcome::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Layout,
    Lock,
    Documents,
    Config,
    SyncKeys,
    Credentials,
    Report,
    Marker,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Layout => "layout",
            Stage::Lock => "lock",
            Stage::Documents => "documents",
            Stage::Config => "config",
            Stage::SyncKeys => "sync_keys",
            Stage::Credentials => "credentials",
            Stage::Report => "report",
            Stage::Marker => "marker",
        }
    }

    pub fn parse(text: &str) -> Option<Stage> {
        [
            Stage::Layout,
            Stage::Lock,
            Stage::Documents,
            Stage::Config,
            Stage::SyncKeys,
            Stage::Credentials,
            Stage::Report,
            Stage::Marker,
        ]
        .into_iter()
        .find(|stage| stage.as_str() == text)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub documents: u64,
    pub placement: u64,
    pub config_files: u64,
    pub sync_keys: u64,
    pub credentials: u64,
    pub unchanged: u64,
    pub kept_aside: u64,
    pub skipped_links: u64,
    pub skipped_invalid: u64,
    pub skipped_too_large: u64,
    pub skipped_case_clash: u64,
    pub sync_keys_unreadable: u64,
    pub credentials_incomplete: u64,
    pub credential_chunks_orphaned: u64,
    pub partials_swept: u64,
}

impl Counts {
    fn skipped(&self) -> u64 {
        self.skipped_links
            + self.skipped_invalid
            + self.skipped_too_large
            + self.skipped_case_clash
            + self.sync_keys_unreadable
            + self.credentials_incomplete
            + self.credential_chunks_orphaned
    }

    fn fields(&self) -> [(&'static str, u64); 15] {
        [
            ("documents", self.documents),
            ("placement", self.placement),
            ("config_files", self.config_files),
            ("sync_keys", self.sync_keys),
            ("credentials", self.credentials),
            ("unchanged", self.unchanged),
            ("kept_aside", self.kept_aside),
            ("skipped_links", self.skipped_links),
            ("skipped_invalid", self.skipped_invalid),
            ("skipped_too_large", self.skipped_too_large),
            ("skipped_case_clash", self.skipped_case_clash),
            ("sync_keys_unreadable", self.sync_keys_unreadable),
            ("credentials_incomplete", self.credentials_incomplete),
            ("credential_chunks_orphaned", self.credential_chunks_orphaned),
            ("partials_swept", self.partials_swept),
        ]
    }
}

#[derive(Clone, Debug)]
pub struct Report {
    pub outcome: Outcome,
    pub failed_stage: Option<Stage>,
    pub counts: Counts,
    pub duration_ms: u64,
    pub attempt: u64,
    pub prior_failed_stage: Option<Stage>,
    pub run: String,
}

impl Report {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("version".into(), json!(MARKER_VERSION));
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
        let mut counts = Map::new();
        for (name, value) in self.counts.fields() {
            counts.insert(name.into(), json!(value));
        }
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

enum Placed {
    Written,
    Unchanged,
    Skipped,
}

type StepResult = Result<(), (Stage, io::Error)>;

struct Migration<'a> {
    layout: &'a Layout,
    webui: &'a Root,
    rnw_data: Option<&'a Root>,
    rnw_config: Option<&'a Root>,
    sealer: &'a dyn Sealer,
    faults: &'a Faults,
    counts: Counts,
    commits: usize,
}

fn absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
}

fn resolved(path: &Path) -> io::Result<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match fs::canonicalize(&existing) {
            Ok(canonical) => {
                let mut full = fsafe::plain(canonical);
                for part in rest.iter().rev() {
                    full.push(part);
                }
                return Ok(full);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let Some(name) = existing.file_name().map(|n| n.to_os_string()) else {
                    return Err(error);
                };
                rest.push(name);
                if !existing.pop() {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
    }
}

pub fn overlapping(a: &Path, b: &Path) -> bool {
    fsafe::within(a, b) || fsafe::within(b, a)
}

pub fn check_layout(layout: &Layout) -> io::Result<()> {
    for path in [&layout.rnw_data, &layout.rnw_config, &layout.webui_data] {
        if !absolute(path) {
            return Err(fsafe::unsafe_path(path.clone()));
        }
    }
    for path in [&layout.rnw_data, &layout.rnw_config, &layout.webui_data] {
        fsafe::check_ancestors(path)?;
    }
    let webui = resolved(&layout.webui_data)?;
    let rnw_user_data = layout.rnw_data.join(names::CHROMIUM_USER_DATA);
    for theirs in [&layout.rnw_data, &layout.rnw_config, &rnw_user_data] {
        if overlapping(&webui, &resolved(theirs)?) || overlapping(&layout.webui_data, theirs) {
            return Err(fsafe::unsafe_path(theirs.clone()));
        }
    }
    for root in [&layout.rnw_data, &layout.rnw_config, &layout.webui_data] {
        if matches!(fsafe::entry(root)?, Entry::Link | Entry::File | Entry::Other) {
            return Err(fsafe::unsafe_path(root.clone()));
        }
    }
    Ok(())
}

fn read_report(root: &Root, name: &str) -> Option<Value> {
    match root.dir().read(name, SECRET_FILE_LIMIT).ok()? {
        Fetched::Data(bytes) => serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object),
        _ => None,
    }
}

fn valid_run(report: &Value) -> bool {
    report
        .get("run")
        .and_then(Value::as_str)
        .is_some_and(|run| run.len() == 32 && run.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

pub fn valid_attempt_report(report: &Value) -> bool {
    let written = [
        Outcome::Failed,
        Outcome::Migrated,
        Outcome::MigratedWithSkips,
        Outcome::NothingToMigrate,
    ];
    report.get("version").and_then(Value::as_u64) == Some(MARKER_VERSION)
        && valid_run(report)
        && report
            .get("outcome")
            .and_then(Value::as_str)
            .is_some_and(|outcome| written.iter().any(|known| known.as_str() == outcome))
        && report.get("attempt").is_some_and(Value::is_u64)
}

fn prior_failed_stage(previous: &Value) -> Option<Stage> {
    let stage_of = |field: &str| previous.get(field).and_then(Value::as_str).and_then(Stage::parse);
    let failed = previous.get("outcome").and_then(Value::as_str) == Some("failed");
    failed
        .then(|| stage_of("failed_stage"))
        .flatten()
        .or_else(|| stage_of("prior_failed_stage"))
}

pub fn valid_marker(marker: &Value) -> bool {
    let finished = ["migrated", "migrated_with_skips", "nothing_to_migrate"];
    let run_ok = valid_run(marker);
    let outcome_ok = marker
        .get("outcome")
        .and_then(Value::as_str)
        .is_some_and(|outcome| finished.contains(&outcome));
    let counts_ok = marker.get("counts").and_then(Value::as_object).is_some_and(|counts| {
        Counts::default()
            .fields()
            .iter()
            .all(|(name, _)| counts.get(*name).is_some_and(Value::is_u64))
    });
    marker.get("version").and_then(Value::as_u64) == Some(MARKER_VERSION)
        && run_ok
        && outcome_ok
        && counts_ok
        && marker.get("failed_stage").is_none()
        && marker.get("attempt").is_some_and(Value::is_u64)
        && marker.get("duration_ms").is_some_and(Value::is_u64)
}

fn marker_in(root: &Root) -> Option<Value> {
    read_report(root, names::MARKER_NAME).filter(valid_marker)
}

pub fn read_marker(webui_data: &Path) -> Option<Value> {
    marker_in(&Root::new(webui_data).ok()?)
}

pub fn read_attempt(webui_data: &Path) -> Option<Value> {
    read_report(&Root::new(webui_data).ok()?, names::ATTEMPT_NAME)
}

fn report_bytes(report: &Report) -> io::Result<Vec<u8>> {
    serde_json::to_vec_pretty(&report.to_json()).map_err(io::Error::other)
}

fn write_report(root: &Root, name: &str, report: &Report) -> io::Result<()> {
    root.dir().write(name, &report_bytes(report)?)
}

const NAME_LIMIT: usize = 255;

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().copied().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

pub fn content_tag(bytes: &[u8]) -> String {
    format!("{:016x}", fnv(bytes))
}

pub fn kept_name(name: &str, tag: &str) -> String {
    let suffix = format!(".{}.kept", tag.get(..tag.len().min(16)).unwrap_or(tag));
    let full = format!("{name}{suffix}");
    if full.encode_utf16().count() <= NAME_LIMIT {
        return full;
    }
    let tag = format!(".{:016x}{suffix}", fnv(name.as_bytes()));
    let room = NAME_LIMIT - tag.len();
    let mut cut = String::new();
    for c in name.chars() {
        if cut.encode_utf16().count() + c.len_utf16() > room {
            break;
        }
        cut.push(c);
    }
    format!("{cut}{tag}")
}

impl Migration<'_> {
    fn commit(&mut self, dir: &Dir, staged: fsafe::Staged, name: &str) -> io::Result<()> {
        self.commits += 1;
        if self.faults.fail_at_commit == Some(self.commits) {
            dir.abandon(staged);
            return Err(io::Error::other("stopped before a rename"));
        }
        dir.commit(staged, name)
    }

    fn write(&mut self, dir: &Dir, name: &str, bytes: &[u8]) -> io::Result<()> {
        let staged = dir.stage(bytes)?;
        self.commit(dir, staged, name)
    }

    fn keep_aside(&mut self, kept_parts: &[&str], name: &str, bytes: &[u8]) -> io::Result<()> {
        let mut parts = vec![names::KEPT_FOLDER];
        parts.extend_from_slice(kept_parts);
        let kept = self
            .webui
            .folder(&parts, true)?
            .ok_or_else(|| fsafe::unsafe_path(parts.join("/").into()))?;
        let target = match kept.read(name, DOCUMENT_LIMIT)? {
            Fetched::Missing => name.to_string(),
            Fetched::Data(earlier) if earlier.as_slice() == bytes => return Ok(()),
            _ => {
                let tag = content_tag(bytes);
                let mut found = None;
                for round in 0..64u32 {
                    let candidate = if round == 0 {
                        kept_name(name, &tag)
                    } else {
                        kept_name(name, &format!("{}-{round}", &tag[..tag.len().min(12)]))
                    };
                    match kept.read(&candidate, DOCUMENT_LIMIT)? {
                        Fetched::Missing => {
                            found = Some(candidate);
                            break;
                        }
                        Fetched::Data(earlier) if earlier.as_slice() == bytes => return Ok(()),
                        _ => {}
                    }
                }
                found.ok_or_else(|| io::Error::other("no free name to keep a pilot copy under"))?
            }
        };
        self.write(&kept, &target, bytes)?;
        self.counts.kept_aside += 1;
        Ok(())
    }

    fn place(&mut self, parts: &[&str], name: &str, bytes: &[u8], same: &dyn Fn(&[u8]) -> bool) -> io::Result<Placed> {
        let dir = self
            .webui
            .folder(parts, true)?
            .ok_or_else(|| fsafe::unsafe_path(parts.join("/").into()))?;
        match dir.read(name, DOCUMENT_LIMIT)? {
            Fetched::Missing => {}
            Fetched::Data(existing) if same(&existing) => {
                self.counts.unchanged += 1;
                return Ok(Placed::Unchanged);
            }
            Fetched::Data(existing) => self.keep_aside(parts, name, &existing)?,
            Fetched::Link => {
                self.counts.skipped_links += 1;
                return Ok(Placed::Skipped);
            }
            Fetched::NotRegular | Fetched::HardLinked | Fetched::TooLarge => {
                self.counts.skipped_invalid += 1;
                return Ok(Placed::Skipped);
            }
        }
        self.write(&dir, name, bytes)?;
        Ok(Placed::Written)
    }

    fn skip(&mut self, fetched: &Fetched) {
        match fetched {
            Fetched::Link => self.counts.skipped_links += 1,
            Fetched::TooLarge => self.counts.skipped_too_large += 1,
            Fetched::NotRegular | Fetched::HardLinked => self.counts.skipped_invalid += 1,
            Fetched::Missing | Fetched::Data(_) => {}
        }
    }

    fn source_folder(&mut self, root: &Root, parts: &[&str]) -> io::Result<Option<Dir>> {
        let Some((last, above)) = parts.split_last() else {
            return root.folder(&[], false);
        };
        let Some(parent) = root.folder(above, false)? else {
            return Ok(None);
        };
        match parent.entry(last)? {
            Entry::Directory => parent.child(last, false),
            Entry::Missing => Ok(None),
            Entry::Link => {
                self.counts.skipped_links += 1;
                Ok(None)
            }
            Entry::File | Entry::Other => {
                self.counts.skipped_invalid += 1;
                Ok(None)
            }
        }
    }

    fn copy_folder(
        &mut self,
        root: &Root,
        source_parts: &[&str],
        parts: &[&str],
        limit: u64,
        accept: &dyn Fn(&str) -> bool,
        counted: &dyn Fn(&mut Counts, &str),
    ) -> io::Result<()> {
        let Some(source) = self.source_folder(root, source_parts)? else {
            return Ok(());
        };
        let mut seen = BTreeSet::new();
        for name in source.list()? {
            if !accept(&name) || matches!(source.entry(&name)?, Entry::Directory) {
                continue;
            }
            if !seen.insert(names::folded(&name)) {
                self.counts.skipped_case_clash += 1;
                continue;
            }
            match source.read(&name, limit)? {
                Fetched::Data(bytes) => {
                    match self.place(parts, &name, &bytes, &|existing| existing == bytes.as_slice())? {
                        Placed::Written | Placed::Unchanged => counted(&mut self.counts, &name),
                        Placed::Skipped => {}
                    }
                }
                other => self.skip(&other),
            }
        }
        Ok(())
    }

    fn documents(&mut self) -> io::Result<()> {
        let Some(root) = self.rnw_data else {
            return Ok(());
        };
        self.copy_folder(
            root,
            &[],
            &[],
            DOCUMENT_LIMIT,
            &names::document_name,
            &|counts, name| {
                if name.eq_ignore_ascii_case(names::PLACEMENT_NAME) {
                    counts.placement += 1;
                } else {
                    counts.documents += 1;
                }
            },
        )
    }

    fn config(&mut self) -> io::Result<()> {
        let Some(root) = self.rnw_config else {
            return Ok(());
        };
        let is_config = |name: &str| names::CONFIG_FILES.contains(&name);
        let count = |counts: &mut Counts, _: &str| counts.config_files += 1;
        self.copy_folder(root, &[], &[names::CONFIG_FOLDER], CONFIG_LIMIT, &is_config, &count)?;
        self.copy_folder(
            root,
            &[names::THEMES_FOLDER],
            &[names::CONFIG_FOLDER, names::THEMES_FOLDER],
            CONFIG_LIMIT,
            &names::theme_file_name,
            &count,
        )
    }

    fn sync_keys(&mut self) -> io::Result<()> {
        let Some(root) = self.rnw_data else {
            return Ok(());
        };
        let Some(source) = self.source_folder(root, &[names::SYNC_FOLDER])? else {
            return Ok(());
        };
        let mut seen = BTreeSet::new();
        for name in source.list()? {
            let Some(account) = names::sync_key_account(&name) else {
                continue;
            };
            let bytes = match source.read(&name, SYNC_KEY_LIMIT)? {
                Fetched::Data(bytes) => bytes,
                other => {
                    self.skip(&other);
                    continue;
                }
            };
            let purpose = names::sync_purpose(account, self.layout.test_instance);
            let opens = self
                .sealer
                .open(&bytes, &purpose)
                .is_some_and(|plain| plain.len() == SYNC_KEY_BYTES);
            if !opens {
                self.counts.sync_keys_unreadable += 1;
                continue;
            }
            let target = names::webui_sync_key_file(account);
            if !seen.insert(target.clone()) {
                self.counts.skipped_case_clash += 1;
                continue;
            }
            match self.place(&[names::SYNC_FOLDER], &target, &bytes, &|existing| {
                existing == bytes.as_slice()
            })? {
                Placed::Written | Placed::Unchanged => self.counts.sync_keys += 1,
                Placed::Skipped => {}
            }
        }
        Ok(())
    }

    fn credentials(&mut self, stored: Vec<StoredCredential>) -> io::Result<()> {
        for assembled in credentials::assemble(&self.layout.credential_prefix, stored) {
            let (account, secret) = match assembled {
                Assembled::Secret { account, secret } => (account, secret),
                Assembled::Incomplete => {
                    self.counts.credentials_incomplete += 1;
                    continue;
                }
                Assembled::Invalid => {
                    self.counts.skipped_invalid += 1;
                    continue;
                }
                Assembled::Orphan => {
                    self.counts.credential_chunks_orphaned += 1;
                    continue;
                }
            };
            let purpose = names::secret_purpose(&account, self.layout.test_instance);
            let sealed = self.sealer.seal(&secret, &purpose)?;
            let sealer = self.sealer;
            let same = |existing: &[u8]| {
                sealer
                    .open(existing, &purpose)
                    .is_some_and(|plain| plain[..] == secret[..])
            };
            match self.place(&[names::SECRETS_FOLDER], &names::secret_file(&account), &sealed, &same)? {
                Placed::Written | Placed::Unchanged => self.counts.credentials += 1,
                Placed::Skipped => {}
            }
        }
        Ok(())
    }

    fn sweep(&mut self) -> io::Result<()> {
        let mut folders: Vec<Vec<&str>> = vec![vec![], vec![names::KEPT_FOLDER]];
        for base in [vec![], vec![names::KEPT_FOLDER]] {
            for sub in [
                vec![names::CONFIG_FOLDER],
                vec![names::CONFIG_FOLDER, names::THEMES_FOLDER],
                vec![names::SYNC_FOLDER],
                vec![names::SECRETS_FOLDER],
            ] {
                folders.push(base.iter().chain(sub.iter()).copied().collect());
            }
        }
        for parts in folders {
            if let Ok(Some(dir)) = self.webui.folder(&parts, false) {
                self.counts.partials_swept += dir.sweep_partials()? as u64;
            }
        }
        Ok(())
    }

    fn steps(&mut self, stored: Vec<StoredCredential>) -> StepResult {
        self.sweep().map_err(|e| (Stage::Lock, e))?;
        self.documents().map_err(|e| (Stage::Documents, e))?;
        self.config().map_err(|e| (Stage::Config, e))?;
        self.sync_keys().map_err(|e| (Stage::SyncKeys, e))?;
        self.credentials(stored).map_err(|e| (Stage::Credentials, e))
    }
}

pub fn migrate(layout: &Layout, sealer: &dyn Sealer, vault: &dyn Vault, faults: &Faults) -> Report {
    let started = Instant::now();
    let mut report = Report {
        outcome: Outcome::Failed,
        failed_stage: None,
        counts: Counts::default(),
        duration_ms: 0,
        attempt: 1,
        prior_failed_stage: None,
        run: fsafe::run_id(),
    };
    let finish = |mut report: Report| {
        report.duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        report
    };
    let refuse = |mut report: Report, stage: Stage| {
        report.outcome = Outcome::Refused;
        report.failed_stage = Some(stage);
        finish(report)
    };

    if check_layout(layout).is_err() {
        return refuse(report, Stage::Layout);
    }
    let webui = match Root::open_or_create(&layout.webui_data) {
        Ok(webui) => webui,
        Err(error) if fsafe::is_unsafe(&error) => return refuse(report, Stage::Layout),
        Err(_) => {
            report.failed_stage = Some(Stage::Layout);
            return finish(report);
        }
    };
    let source_root = |path: &Path| match fsafe::entry(path) {
        Ok(Entry::Missing) => Ok(None),
        Ok(Entry::Directory) => Root::new(path).map(Some).map_err(|_| ()),
        _ => Err(()),
    };
    let (Ok(rnw_data), Ok(rnw_config)) = (source_root(&layout.rnw_data), source_root(&layout.rnw_config)) else {
        return refuse(report, Stage::Layout);
    };
    let overlaps = [rnw_data.as_ref(), rnw_config.as_ref()]
        .into_iter()
        .flatten()
        .any(|root| overlapping(&root.resolved, &webui.resolved));
    if overlaps {
        return refuse(report, Stage::Layout);
    }

    let lock = match webui.dir().open_lock(names::LOCK_NAME) {
        Ok(lock) => lock,
        Err(error) if fsafe::is_unsafe(&error) => return refuse(report, Stage::Lock),
        Err(_) => {
            report.failed_stage = Some(Stage::Lock);
            return finish(report);
        }
    };
    match lock.try_lock() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => {
            report.outcome = Outcome::Busy;
            report.failed_stage = Some(Stage::Lock);
            return finish(report);
        }
        Err(fs::TryLockError::Error(_)) => {
            report.failed_stage = Some(Stage::Lock);
            return finish(report);
        }
    }

    if !matches!(webui.dir().entry(names::MARKER_NAME), Ok(Entry::Missing | Entry::File)) {
        return refuse(report, Stage::Marker);
    }
    if marker_in(&webui).is_some() {
        report.outcome = Outcome::AlreadyMigrated;
        return finish(report);
    }
    let previous = read_report(&webui, names::ATTEMPT_NAME).filter(valid_attempt_report);
    report.attempt = previous
        .as_ref()
        .and_then(|previous| previous.get("attempt").and_then(Value::as_u64))
        .map_or(1, |previous| previous.saturating_add(1).min(ATTEMPT_CAP));
    report.prior_failed_stage = previous.as_ref().and_then(prior_failed_stage);
    let failed = |mut report: Report, stage: Stage| {
        report.outcome = Outcome::Failed;
        report.failed_stage = Some(stage);
        let mut report = finish(report);
        if write_report(&webui, names::ATTEMPT_NAME, &report).is_err() {
            report.failed_stage = Some(Stage::Report);
        }
        report
    };

    let stored = match vault.list(&layout.credential_prefix) {
        Ok(stored) => stored,
        Err(_) => return failed(report, Stage::Credentials),
    };
    let nothing = rnw_data.is_none() && rnw_config.is_none() && stored.is_empty();

    let mut migration = Migration {
        layout,
        webui: &webui,
        rnw_data: rnw_data.as_ref(),
        rnw_config: rnw_config.as_ref(),
        sealer,
        faults,
        counts: Counts::default(),
        commits: 0,
    };
    let stepped = if nothing {
        migration.sweep().map_err(|e| (Stage::Lock, e))
    } else {
        migration.steps(stored)
    };
    report.counts = migration.counts.clone();
    if let Err((stage, _error)) = stepped {
        return failed(report, stage);
    }
    report.outcome = if nothing {
        Outcome::NothingToMigrate
    } else if report.counts.skipped() > 0 {
        Outcome::MigratedWithSkips
    } else {
        Outcome::Migrated
    };
    let report = finish(report);
    let root = webui.dir();
    let attempt = report_bytes(&report)
        .and_then(|bytes| root.stage(&bytes))
        .and_then(|staged| migration.commit(root, staged, names::ATTEMPT_NAME));
    if attempt.is_err() {
        return failed(report, Stage::Report);
    }
    let marker = report_bytes(&report)
        .and_then(|bytes| root.stage(&bytes))
        .and_then(|staged| migration.commit(root, staged, names::MARKER_NAME));
    if marker.is_err() {
        return failed(report, Stage::Marker);
    }
    drop(lock);
    report
}
