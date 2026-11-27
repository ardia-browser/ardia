use crate::closed::{ClosedGroup, ClosedLists, ClosedTab, ClosedWindow, ParkedPins};
use crate::groups::TabGroup;
use crate::ids::{GroupId, ProfileId, SplitId, TabId, WindowId};
use crate::json::Fields;
use crate::model::Millis;
use crate::persistence::migrations::{ROW_KEYS, SESSION_VERSION, listed_rows, migrate_session};
use crate::persistence::{DataDir, JsonProblem, Limits, PersistError, guard, version_field};
use crate::profiles::Profile;
use crate::settings::{Settings, SettingsMeta, with_retired_defaults};
use crate::splits::SplitView;
use crate::tabs::Tab;
use crate::windows::{BrowserWindow, LEGACY_WINDOW_KEYS};
use indexmap::IndexMap;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use std::collections::HashSet;

pub const SESSION: &str = "session.json";
pub const DAILY_BACKUP: &str = "session-backup-";
pub const MIGRATION_BACKUP: &str = "session-premigration-";
const MAX_BACKUP_SEQ: u64 = 9_999_999_999_999_999;
pub const DAILY_BACKUPS_KEPT: usize = 7;
pub const MIGRATION_BACKUPS_KEPT: usize = 3;
pub const BACKUP_EVERY_MS: Millis = 24 * 60 * 60 * 1000;
const TRANSIENT_KEYS: [&str; 3] = ["launchTab", "launchBackdrop", "linkProfile"];
const KNOWN_KEYS: [&str; 23] = [
    "profiles",
    "profileOrder",
    "orphanedProfileData",
    "settings",
    "settingsMeta",
    "windows",
    "windowOrder",
    "focusedWindowId",
    "lastProfileId",
    "tabs",
    "groups",
    "splits",
    "closedTabs",
    "closedWindows",
    "parkedPins",
    "pinChoices",
    "pinSync",
    "topAppsMerged",
    "closedGroups",
    "deletedGroups",
    "cleanedTabs",
    "version",
    "launchTab",
];

pub fn older_build_document() -> String {
    format!("session-older-build-v{SESSION_VERSION}.json")
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionData {
    pub profiles: IndexMap<ProfileId, Profile>,
    pub profile_order: Vec<ProfileId>,
    pub orphaned_profile_data: Vec<String>,
    pub settings: Settings,
    pub settings_meta: SettingsMeta,
    pub windows: IndexMap<WindowId, BrowserWindow>,
    pub window_order: Vec<WindowId>,
    pub focused_window_id: Option<WindowId>,
    pub last_profile_id: Option<ProfileId>,
    pub tabs: IndexMap<TabId, Tab>,
    pub groups: IndexMap<GroupId, TabGroup>,
    pub splits: IndexMap<SplitId, SplitView>,
    pub closed: ClosedLists,
    pub parked_pins: IndexMap<ProfileId, ParkedPins>,
    pub pin_choices: Fields,
    pub pin_sync: Fields,
    pub top_apps_merged: String,
    pub extra: Fields,
    pub row_tables: bool,
}

impl SessionData {
    pub fn fresh(options: LoadOptions) -> SessionData {
        let mut fields = Fields::new();
        let mut settings_meta = SettingsMeta::default();
        with_retired_defaults(
            &mut fields,
            &mut settings_meta,
            options.retired_defaults_wait_for_sync,
        );
        SessionData {
            settings_meta,
            ..SessionData::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionSource {
    Fresh,
    Primary,
    OlderBuild,
    Backup { name: String, age_days: i64 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadReport {
    pub source: SessionSource,
    pub from_version: Option<u64>,
    pub dropped_rows: usize,
    pub problem: Option<&'static str>,
    pub newer_build: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LoadOptions {
    pub restore_session: Option<bool>,
    pub retired_defaults_wait_for_sync: bool,
}

fn whole_session(doc: &Map<String, Value>) -> bool {
    let rows_ok = ROW_KEYS
        .iter()
        .all(|k| doc.get(*k).is_none_or(|v| v.is_array() || v.is_object()));
    let lists_ok = ["windowOrder", "profileOrder"]
        .iter()
        .all(|k| doc.get(*k).is_none_or(Value::is_array));
    let objects_ok = ["profiles", "settings", "parkedPins"]
        .iter()
        .all(|k| doc.get(*k).is_none_or(Value::is_object));
    let any = ROW_KEYS
        .iter()
        .chain(
            [
                "windowOrder",
                "profileOrder",
                "profiles",
                "settings",
                "parkedPins",
            ]
            .iter(),
        )
        .any(|k| doc.contains_key(*k));
    any && rows_ok && lists_ok && objects_ok
}

fn upgraded(value: Value) -> Result<(Map<String, Value>, u64), &'static str> {
    let Value::Object(mut doc) = value else {
        return Err("shape");
    };
    let from = version_field(doc.get("version")).ok_or("version")?;
    if from > SESSION_VERSION {
        return Err("newer");
    }
    if !migrate_session(&mut doc, from) {
        return Err("version");
    }
    if !whole_session(&doc) {
        return Err("shape");
    }
    Ok((doc, from))
}

type ReadSession = (Map<String, Value>, u64, Vec<u8>);

fn read_session(dir: &DataDir, name: &str) -> Result<Option<ReadSession>, &'static str> {
    let bytes = match dir.read(name, Limits::SESSION.max_bytes) {
        Ok(None) => return Ok(None),
        Ok(Some(bytes)) => bytes,
        Err(PersistError::Json(problem)) => return Err(problem.code()),
        Err(_) => return Err("unreadable"),
    };
    let value = guard::parse(&bytes, Limits::SESSION).map_err(JsonProblem::code)?;
    upgraded(value).map(|(doc, from)| Some((doc, from, bytes)))
}

fn rows<T: DeserializeOwned>(
    doc: &mut Map<String, Value>,
    key: &str,
    valid: fn(&Value) -> bool,
    dropped: &mut usize,
) -> Vec<T> {
    let list = match doc.shift_remove(key) {
        Some(Value::Array(list)) => list,
        Some(_) => {
            *dropped += 1;
            return Vec::new();
        }
        None => return Vec::new(),
    };
    let total = list.len();
    let parsed: Vec<T> = list
        .into_iter()
        .filter(valid)
        .filter_map(|row| serde_json::from_value(row).ok())
        .collect();
    *dropped += total - parsed.len();
    parsed
}

fn ids<T: From<String>>(doc: &mut Map<String, Value>, key: &str) -> Vec<T> {
    crate::json::strings(doc.shift_remove(key).as_ref())
        .into_iter()
        .filter(|id| crate::ids::is_own_id(id))
        .map(T::from)
        .collect()
}

fn own_id<T: From<String>>(doc: &mut Map<String, Value>, key: &str) -> Option<T> {
    doc.shift_remove(key).and_then(|v| {
        v.as_str()
            .filter(|id| crate::ids::is_own_id(id))
            .map(|id| T::from(id.to_owned()))
    })
}

fn object(doc: &mut Map<String, Value>, key: &str) -> Fields {
    match doc.shift_remove(key) {
        Some(Value::Object(fields)) => fields,
        _ => Fields::new(),
    }
}

pub fn session_from_doc(mut doc: Map<String, Value>, options: LoadOptions) -> (SessionData, usize) {
    let shape = listed_rows(&mut doc);
    let mut dropped = usize::from(shape.misfiled);
    let raw_settings = object(&mut doc, "settings");
    let legacy_icons = raw_settings
        .get("profileSwitcherIcons")
        .map(|v| *v == Value::Bool(true));
    let raw_windows: Vec<Value> = doc
        .get("windows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut windows: Vec<BrowserWindow> = rows(
        &mut doc,
        "windows",
        BrowserWindow::row_is_valid,
        &mut dropped,
    );
    let mut settings_fields = raw_settings;
    if !settings_fields.contains_key("autoHideTabs") && !raw_windows.is_empty() {
        let all_hidden = raw_windows
            .iter()
            .all(|w| w.get("sidebarOpen") == Some(&Value::Bool(false)));
        settings_fields.insert("autoHideTabs".into(), all_hidden.into());
    }
    let mut settings_meta = SettingsMeta::from_value(doc.get("settingsMeta"));
    doc.shift_remove("settingsMeta");
    with_retired_defaults(
        &mut settings_fields,
        &mut settings_meta,
        options.retired_defaults_wait_for_sync,
    );
    let settings = Settings::from_value(Some(&Value::Object(settings_fields)));
    for w in &mut windows {
        for key in LEGACY_WINDOW_KEYS {
            w.extra.shift_remove(key);
        }
    }
    let profiles_raw = object(&mut doc, "profiles");
    let mut profiles = IndexMap::new();
    for (key, row) in profiles_raw {
        let valid = crate::ids::is_own_id(&key)
            && row
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(crate::ids::is_own_id)
            && row.get("name").is_some_and(Value::is_string);
        let cleared = row.get("theme").is_some_and(Value::is_null);
        match serde_json::from_value::<Profile>(row)
            .ok()
            .filter(|_| valid)
        {
            Some(mut profile) => {
                profile.theme_cleared = cleared;
                profiles.insert(
                    ProfileId::new(&key),
                    profile
                        .with_legacy_dots(legacy_icons)
                        .with_own_looks_seeded(),
                );
            }
            None => dropped += 1,
        }
    }
    let tabs: Vec<Tab> = rows(&mut doc, "tabs", Tab::row_is_valid, &mut dropped);
    let groups: Vec<TabGroup> = rows(&mut doc, "groups", TabGroup::row_is_valid, &mut dropped);
    let splits: Vec<SplitView> = rows(&mut doc, "splits", SplitView::row_is_valid, &mut dropped);
    let closed = ClosedLists {
        tabs: rows(
            &mut doc,
            "closedTabs",
            ClosedTab::row_is_valid,
            &mut dropped,
        ),
        windows: rows(
            &mut doc,
            "closedWindows",
            ClosedWindow::row_is_valid,
            &mut dropped,
        ),
        groups: rows(
            &mut doc,
            "closedGroups",
            ClosedGroup::row_is_valid,
            &mut dropped,
        ),
        deleted_groups: rows(
            &mut doc,
            "deletedGroups",
            ClosedGroup::row_is_valid,
            &mut dropped,
        ),
        cleaned_tabs: rows(
            &mut doc,
            "cleanedTabs",
            ClosedTab::row_is_valid,
            &mut dropped,
        ),
    };
    let parked_raw = object(&mut doc, "parkedPins");
    let parked_listed = parked_raw.len();
    let parked_pins: IndexMap<ProfileId, ParkedPins> = parked_raw
        .into_iter()
        .filter(|(p, park)| crate::ids::is_own_id(p) && ParkedPins::row_is_valid(park))
        .filter_map(|(p, park)| Some((ProfileId::new(p), serde_json::from_value(park).ok()?)))
        .collect();
    dropped += parked_listed - parked_pins.len();
    let keyed = |listed: usize, kept: usize, dropped: &mut usize| *dropped += listed - kept;
    let windows_listed = windows.len();
    let windows: IndexMap<WindowId, BrowserWindow> =
        windows.into_iter().map(|w| (w.id.clone(), w)).collect();
    keyed(windows_listed, windows.len(), &mut dropped);
    let tabs_listed = tabs.len();
    let tabs: IndexMap<TabId, Tab> = tabs.into_iter().map(|t| (t.id.clone(), t)).collect();
    keyed(tabs_listed, tabs.len(), &mut dropped);
    let groups_listed = groups.len();
    let groups: IndexMap<GroupId, TabGroup> =
        groups.into_iter().map(|g| (g.id.clone(), g)).collect();
    keyed(groups_listed, groups.len(), &mut dropped);
    let splits_listed = splits.len();
    let splits: IndexMap<SplitId, SplitView> =
        splits.into_iter().map(|v| (v.id.clone(), v)).collect();
    keyed(splits_listed, splits.len(), &mut dropped);
    let data = SessionData {
        profiles,
        profile_order: ids(&mut doc, "profileOrder"),
        orphaned_profile_data: crate::json::strings(
            doc.shift_remove("orphanedProfileData").as_ref(),
        ),
        settings,
        settings_meta,
        windows,
        window_order: ids(&mut doc, "windowOrder"),
        focused_window_id: own_id(&mut doc, "focusedWindowId"),
        last_profile_id: own_id(&mut doc, "lastProfileId"),
        tabs,
        groups,
        splits,
        closed,
        parked_pins,
        pin_choices: object(&mut doc, "pinChoices"),
        pin_sync: object(&mut doc, "pinSync"),
        top_apps_merged: doc
            .shift_remove("topAppsMerged")
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default(),
        row_tables: shape.tables,
        extra: doc
            .into_iter()
            .filter(|(k, _)| {
                !KNOWN_KEYS.contains(&k.as_str()) && !TRANSIENT_KEYS.contains(&k.as_str())
            })
            .collect(),
    };
    (data, dropped)
}

fn backup_session(dir: &DataDir, name: &str) -> Option<(Map<String, Value>, Millis)> {
    let value = dir.read_json(name, Limits::SESSION).ok()??;
    let at = value.get("backupAt").and_then(crate::json::as_millis)?;
    let session = value.get("session")?.clone();
    upgraded(session).ok().map(|(doc, _)| (doc, at))
}

fn backup_seq(prefix: &str, name: &str) -> Option<u64> {
    let digits = name.strip_prefix(prefix)?.strip_suffix(".json")?;
    let plain = (1..=16).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit());
    plain.then(|| digits.parse().ok()).flatten()
}

fn plausible(at: Millis, now: Millis) -> bool {
    at <= now.saturating_add(BACKUP_EVERY_MS)
}

struct Backup {
    name: String,
    seq: u64,
    at: Millis,
    doc: Map<String, Value>,
}

fn backups(dir: &DataDir, prefixes: &[&str], now: Millis) -> Vec<Backup> {
    let mut found: Vec<Backup> = prefixes
        .iter()
        .flat_map(|prefix| {
            dir.list(prefix).into_iter().filter_map(move |name| {
                let seq = backup_seq(prefix, &name)?;
                backup_session(dir, &name).map(|(doc, at)| Backup { name, seq, at, doc })
            })
        })
        .collect();
    found.sort_by_key(|b| std::cmp::Reverse((plausible(b.at, now), b.at, b.seq)));
    found
}

enum Found {
    Missing,
    Usable(Map<String, Value>, u64, Vec<u8>),
    Unusable(&'static str),
}

fn find(dir: &DataDir, name: &str) -> Found {
    match read_session(dir, name) {
        Ok(None) => Found::Missing,
        Ok(Some((doc, from, bytes))) => Found::Usable(doc, from, bytes),
        Err(problem) => Found::Unusable(problem),
    }
}

pub struct Loaded<T> {
    pub value: T,
    pub report: LoadReport,
    pub files: SessionFiles,
}

fn original_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim()
        .trim_start_matches('\u{feff}')
        .trim()
        .to_owned()
}

pub fn load<T>(
    dir: &DataDir,
    options: LoadOptions,
    now: Millis,
    hydrate: impl Fn(SessionData) -> (T, usize),
) -> Loaded<T> {
    let mut files = SessionFiles::new(dir.clone(), SESSION.to_owned());
    let mut report = LoadReport {
        source: SessionSource::Fresh,
        from_version: None,
        dropped_rows: 0,
        problem: None,
        newer_build: false,
    };
    let prepared = |doc: Map<String, Value>| {
        let (mut data, dropped) = session_from_doc(doc, options);
        if options.restore_session == Some(false) {
            data.settings.restore_session = false;
        }
        let (value, repaired) = hydrate(data);
        (value, dropped + repaired)
    };
    let mut candidate = None;
    match find(dir, SESSION) {
        Found::Usable(doc, from, bytes) => {
            candidate = Some((SessionSource::Primary, doc, from, bytes))
        }
        Found::Missing => {}
        Found::Unusable(problem) => {
            files.keep_aside = true;
            if problem == "newer" {
                report.newer_build = true;
                files.target = older_build_document();
                files.keep_aside = false;
                match find(dir, &files.target) {
                    Found::Usable(doc, from, bytes) => {
                        candidate = Some((SessionSource::OlderBuild, doc, from, bytes))
                    }
                    Found::Missing => {}
                    Found::Unusable(problem) => {
                        report.problem = Some(problem);
                        files.keep_aside = true;
                    }
                }
            } else {
                report.problem = Some(problem);
            }
        }
    }
    if let Some((source, doc, from, bytes)) = candidate {
        let (value, lost) = prepared(doc);
        report.source = source;
        report.from_version = Some(from);
        report.dropped_rows = lost;
        files.keep_aside |= lost > 0;
        if from < SESSION_VERSION {
            files.premigration = Some(original_text(&bytes)).filter(|t| !t.is_empty());
        }
        return Loaded {
            value,
            report,
            files,
        };
    }
    if report.problem.is_some() || report.newer_build {
        let mut partial = None;
        for backup in backups(dir, &[DAILY_BACKUP, MIGRATION_BACKUP], now) {
            let (value, lost) = prepared(backup.doc);
            let source = SessionSource::Backup {
                name: backup.name,
                age_days: ((now - backup.at) / BACKUP_EVERY_MS).max(0),
            };
            if lost == 0 {
                partial = Some((value, source, lost));
                break;
            }
            if partial.is_none() {
                partial = Some((value, source, lost));
            }
        }
        if let Some((value, source, lost)) = partial {
            report.source = source;
            report.from_version = Some(SESSION_VERSION);
            report.dropped_rows = lost;
            files.recovering = true;
            return Loaded {
                value,
                report,
                files,
            };
        }
    }
    let (value, _) = hydrate(SessionData::fresh(options));
    Loaded {
        value,
        report,
        files,
    }
}

#[derive(Clone, Debug)]
pub struct SessionFiles {
    dir: DataDir,
    target: String,
    pub(crate) downloads_aside: bool,
    keep_aside: bool,
    recovering: bool,
    premigration: Option<String>,
    next_daily_check: Millis,
}

impl SessionFiles {
    pub fn new(dir: DataDir, target: String) -> Self {
        SessionFiles {
            dir,
            target,
            downloads_aside: false,
            keep_aside: false,
            recovering: false,
            premigration: None,
            next_daily_check: 0,
        }
    }

    pub fn target(&self) -> &str {
        &self.target
    }

    pub fn dir(&self) -> &DataDir {
        &self.dir
    }

    pub fn keeps_aside(&self) -> bool {
        self.keep_aside
    }

    fn next_seq(&self, prefix: &str, tried: &HashSet<u64>) -> u64 {
        let used: HashSet<u64> = self
            .dir
            .list(prefix)
            .iter()
            .filter_map(|n| backup_seq(prefix, n))
            .chain(tried.iter().copied())
            .collect();
        let after_newest = used.iter().max().map_or(1, |m| m.saturating_add(1));
        if after_newest <= MAX_BACKUP_SEQ {
            return after_newest;
        }
        (1..=MAX_BACKUP_SEQ)
            .find(|seq| !used.contains(seq))
            .unwrap_or(after_newest)
    }

    fn create_backup(
        &self,
        prefix: &str,
        at: Millis,
        session: &str,
    ) -> Result<String, PersistError> {
        let body = format!("{{\"backupAt\":{at},\"session\":{session}}}");
        let mut tried = HashSet::new();
        for _ in 0..5 {
            let seq = self.next_seq(prefix, &tried);
            let name = format!("{prefix}{seq}.json");
            if backup_seq(prefix, &name).is_some() && self.dir.create_new(&name, body.as_bytes())? {
                return Ok(name);
            }
            tried.insert(seq);
        }
        Err(PersistError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "no free backup name",
        )))
    }

    fn prune(&self, prefix: &str, kept: usize, written: &str, now: Millis) {
        if self.recovering {
            return;
        }
        let parsed = backups(&self.dir, &[prefix], now);
        let newest_whole = parsed
            .iter()
            .find(|b| plausible(b.at, now))
            .or_else(|| parsed.first())
            .map(|b| b.name.clone());
        let mut malformed: Vec<(u64, String)> = self
            .dir
            .list(prefix)
            .into_iter()
            .filter(|n| !parsed.iter().any(|b| b.name == *n))
            .filter_map(|n| backup_seq(prefix, &n).map(|seq| (seq, n)))
            .collect();
        malformed.sort_by_key(|(seq, _)| std::cmp::Reverse(*seq));
        let order = parsed
            .into_iter()
            .map(|b| b.name)
            .chain(malformed.into_iter().map(|(_, n)| n));
        for name in order.skip(kept) {
            if name != written && Some(&name) != newest_whole.as_ref() {
                let _ = self.dir.remove(&name);
            }
        }
    }

    pub fn save(&mut self, json: &str, now: Millis) -> Result<(), PersistError> {
        if self.keep_aside {
            self.dir.keep_aside(&self.target, now)?;
            self.keep_aside = false;
        }
        if let Some(original) = &self.premigration {
            let name = self.create_backup(MIGRATION_BACKUP, now, original)?;
            self.premigration = None;
            self.prune(MIGRATION_BACKUP, MIGRATION_BACKUPS_KEPT, &name, now);
        }
        self.dir.write_atomic(&self.target, json.as_bytes())?;
        if self.target == SESSION && now >= self.next_daily_check {
            let recent = backups(&self.dir, &[DAILY_BACKUP], now)
                .iter()
                .any(|b| (now - b.at).abs() < BACKUP_EVERY_MS);
            if !recent {
                let name = self.create_backup(DAILY_BACKUP, now, json)?;
                self.prune(DAILY_BACKUP, DAILY_BACKUPS_KEPT, &name, now);
            }
            self.next_daily_check = now + BACKUP_EVERY_MS;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: Millis = 1_795_656_501_578;

    fn load_plain(dir: &DataDir) -> (SessionData, LoadReport, SessionFiles) {
        let loaded = load(dir, LoadOptions::default(), NOW, |d| (d, 0));
        (loaded.value, loaded.report, loaded.files)
    }

    fn whole(urls: &[&str]) -> Value {
        let mut doc = sample();
        doc["tabs"] = Value::Array(
            urls.iter()
                .enumerate()
                .map(|(i, url)| json!({"id": format!("t{}", i + 1), "windowId": "w1", "profileId": "default", "url": url}))
                .collect(),
        );
        doc["windows"][0]["tabIds"] =
            Value::Array((1..=urls.len()).map(|i| json!(format!("t{i}"))).collect());
        doc
    }

    fn put_backup(dir: &DataDir, name: &str, at: Millis, session: &Value) {
        dir.write_atomic(
            name,
            format!("{{\"backupAt\":{at},\"session\":{session}}}").as_bytes(),
        )
        .unwrap();
    }

    fn sample() -> Value {
        json!({
            "version": 11,
            "profiles": {"default": {"id": "default", "name": "Personal", "color": "plum", "icon": null, "createdAt": 0}},
            "profileOrder": ["default", "__proto__"],
            "settings": {"pageFrame": 4, "futureSetting": 1},
            "settingsMeta": {"chosen": ["pageFrame"], "inferred": []},
            "windows": [{"id": "w1", "kind": "main", "profileId": "default", "tabIds": ["t1"], "activeTabIds": {"default": "t1"}, "frame": [0, 0, 800, 600], "createdAt": 1}],
            "windowOrder": ["w1"],
            "focusedWindowId": "w1",
            "lastProfileId": "default",
            "tabs": [{"id": "t1", "windowId": "w1", "profileId": "default", "url": "https://a.example/", "title": "A", "page": {"kind": "idle"}, "createdAt": 1, "lastActiveAt": 2}, {"id": "bad"}],
            "groups": [], "splits": [], "closedTabs": [], "closedWindows": [], "closedGroups": [], "deletedGroups": [], "cleanedTabs": [],
            "parkedPins": {}, "pinChoices": {}, "pinSync": {}, "topAppsMerged": "", "orphanedProfileData": [],
            "launchTab": {"id": "t1"}, "somethingNew": [1, 2]
        })
    }

    #[test]
    fn current_sessions_load_with_dropped_rows_counted() {
        let (data, dropped) = session_from_doc(
            sample().as_object().unwrap().clone(),
            LoadOptions::default(),
        );
        assert_eq!(dropped, 1);
        assert_eq!(data.profile_order, vec![ProfileId::new("default")]);
        assert_eq!(data.settings.page_frame(), 4);
        assert_eq!(data.settings.extra.get("futureSetting"), Some(&json!(1)));
        assert_eq!(data.extra.keys().collect::<Vec<_>>(), vec!["somethingNew"]);
        assert_eq!(data.tabs.len(), 1);
        assert!(!data.row_tables);
    }

    #[test]
    fn legacy_native_windows_infer_auto_hide_tabs() {
        let mut doc = sample();
        doc["settings"] = json!({});
        doc["windows"][0]["sidebarOpen"] = json!(false);
        doc["windows"][0]["incognito"] = json!(false);
        let (data, _) = session_from_doc(doc.as_object().unwrap().clone(), LoadOptions::default());
        assert!(data.settings.auto_hide_tabs);
        assert!(data.windows["w1"].extra.is_empty());
    }

    #[test]
    fn unreadable_sessions_restore_from_the_newest_backup_and_are_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        data_dir
            .write_atomic(SESSION, b"{\"version\": 11, \"tabs\": ")
            .unwrap();
        data_dir
            .write_atomic(
                "session-backup-1.json",
                format!(
                    "{{\"backupAt\": {}, \"session\": {}}}",
                    NOW - 3 * BACKUP_EVERY_MS,
                    sample()
                )
                .as_bytes(),
            )
            .unwrap();
        let (data, report, mut files) = load_plain(&data_dir);
        assert_eq!(report.problem, Some("invalid"));
        assert_eq!(
            report.source,
            SessionSource::Backup {
                name: "session-backup-1.json".into(),
                age_days: 3
            }
        );
        assert_eq!(data.tabs.len(), 1);
        files.save("{\"version\":11}", NOW).unwrap();
        assert_eq!(data_dir.list("session-unreadable-").len(), 1);
        assert_eq!(data_dir.list(DAILY_BACKUP).len(), 2);
    }

    #[test]
    fn sessions_from_newer_builds_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        data_dir
            .write_atomic(SESSION, b"{\"version\": 12, \"windows\": []}")
            .unwrap();
        let (_, report, mut files) = load_plain(&data_dir);
        assert!(report.newer_build);
        assert_eq!(report.source, SessionSource::Fresh);
        files.save("{\"version\":11}", NOW).unwrap();
        assert_eq!(
            data_dir.read(SESSION, 1000).unwrap().unwrap(),
            b"{\"version\": 12, \"windows\": []}"
        );
        assert!(data_dir.exists(&older_build_document()));
    }

    #[test]
    fn migrated_sessions_get_a_premigration_backup_before_the_first_write() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        let mut old = sample();
        old["version"] = json!(9);
        data_dir
            .write_atomic(SESSION, old.to_string().as_bytes())
            .unwrap();
        let (_, report, mut files) = load_plain(&data_dir);
        assert_eq!(report.from_version, Some(9));
        files.save("{\"version\":11}", NOW).unwrap();
        files.save("{\"version\":11}", NOW + 1).unwrap();
        assert_eq!(
            data_dir.list(MIGRATION_BACKUP),
            vec!["session-premigration-1.json"]
        );
        assert_eq!(data_dir.list(DAILY_BACKUP).len(), 1);
    }

    #[test]
    fn daily_backups_rotate_and_keep_seven() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        let mut files = SessionFiles::new(data_dir.clone(), SESSION.to_owned());
        for day in 0..10 {
            files
                .save(&sample().to_string(), NOW + day * BACKUP_EVERY_MS)
                .unwrap();
        }
        let names = data_dir.list(DAILY_BACKUP);
        assert_eq!(names.len(), DAILY_BACKUPS_KEPT);
        assert!(names.contains(&"session-backup-10.json".to_owned()));
        assert!(!names.contains(&"session-backup-1.json".to_owned()));
    }

    #[test]
    fn hostile_session_shapes_are_refused() {
        for doc in [
            json!([]),
            json!({"version": "11"}),
            json!({"version": 1}),
            json!({"version": 11}),
            json!({"version": 11, "windows": "x"}),
            json!({"version": 11, "profileOrder": {}}),
        ] {
            assert!(upgraded(doc.clone()).is_err(), "{doc}");
        }
        assert!(upgraded(json!({"version": 11, "tabs": {}})).is_ok());
    }
    #[test]
    fn a_broken_older_build_session_is_kept_aside_before_it_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        let newer = b"{\"version\": 12.0, \"windows\": []}";
        data_dir.write_atomic(SESSION, newer).unwrap();
        data_dir
            .write_atomic(&older_build_document(), b"{\"version\":")
            .unwrap();
        let (_, report, mut files) = load_plain(&data_dir);
        assert!(
            report.newer_build,
            "an integral 12.0 is still a newer build"
        );
        assert_eq!(report.problem, Some("invalid"));
        files.save("{\"version\":11}", NOW).unwrap();
        let asides = data_dir.list("session-older-build-v11-unreadable-");
        assert_eq!(asides.len(), 1);
        assert_eq!(
            data_dir.read(&asides[0], 100).unwrap().unwrap(),
            b"{\"version\":"
        );
        assert_eq!(data_dir.read(SESSION, 100).unwrap().unwrap(), newer);
        assert_eq!(
            data_dir
                .read(&older_build_document(), 100)
                .unwrap()
                .unwrap(),
            b"{\"version\":11}"
        );
    }

    #[test]
    fn an_older_build_session_that_loads_in_part_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        data_dir
            .write_atomic(SESSION, b"{\"version\": 99, \"windows\": []}")
            .unwrap();
        let partial = sample().to_string();
        data_dir
            .write_atomic(&older_build_document(), partial.as_bytes())
            .unwrap();
        let (_, report, mut files) = load_plain(&data_dir);
        assert_eq!(report.source, SessionSource::OlderBuild);
        assert!(report.dropped_rows > 0);
        assert!(files.keeps_aside());
        files.save("{\"version\":11}", NOW).unwrap();
        let asides = data_dir.list("session-older-build-v11-unreadable-");
        assert_eq!(
            data_dir.read(&asides[0], 1 << 20).unwrap().unwrap(),
            partial.as_bytes()
        );
    }

    #[test]
    fn rows_lost_while_loading_keep_the_original_aside() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        let mut doc = whole(&["https://a.example/"]);
        doc["tabs"].as_array_mut().unwrap().push(json!({"id": "t1", "windowId": "w1", "profileId": "default", "url": "https://dupe.example/"}));
        doc["tabs"].as_array_mut().unwrap().push(json!({"id": "t9", "windowId": "w-gone", "profileId": "default", "url": "https://orphan.example/"}));
        doc["parkedPins"] = json!({"default": {"tabs": "nope"}});
        doc["closedTabs"] = json!({"not": "a list"});
        data_dir
            .write_atomic(SESSION, doc.to_string().as_bytes())
            .unwrap();
        let loaded = load(&data_dir, LoadOptions::default(), NOW, |d| {
            let orphans = d
                .tabs
                .values()
                .filter(|t| !d.windows.contains_key(&t.window_id))
                .count();
            (d, orphans)
        });
        assert_eq!(loaded.report.dropped_rows, 4);
        assert!(loaded.files.keeps_aside());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_premigration_backup_is_tried_again_before_the_session_is_replaced() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        let mut old = sample();
        old["version"] = json!(9);
        data_dir
            .write_atomic(SESSION, old.to_string().as_bytes())
            .unwrap();
        let (_, _, mut files) = load_plain(&data_dir);
        let mode = |m: u32| {
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(m)).unwrap()
        };
        mode(0o555);
        let refused = files.save("{\"version\":11}", NOW);
        mode(0o755);
        assert!(refused.is_err());
        assert_eq!(
            data_dir.read(SESSION, 1 << 20).unwrap().unwrap(),
            old.to_string().as_bytes(),
            "the original stays until its backup lands"
        );
        files.save("{\"version\":11}", NOW + 1).unwrap();
        let backups = data_dir.list(MIGRATION_BACKUP);
        assert_eq!(backups.len(), 1);
        let backup = data_dir
            .read_json(&backups[0], Limits::SESSION)
            .unwrap()
            .unwrap();
        assert_eq!(backup["session"]["version"], json!(9));
    }

    #[test]
    fn hostile_backup_names_neither_overflow_nor_win_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        let good = whole(&["https://kept.example/"]);
        put_backup(
            &data_dir,
            "session-backup-1.json",
            NOW - 3 * BACKUP_EVERY_MS,
            &good,
        );
        for seq in [
            "18446744073709551615",
            "99999999999999999999999",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7",
        ] {
            data_dir
                .write_atomic(&format!("session-backup-{seq}.json"), b"{broken")
                .unwrap();
        }
        let mut files = SessionFiles::new(data_dir.clone(), SESSION.to_owned());
        files
            .save(&whole(&["https://today.example/"]).to_string(), NOW)
            .unwrap();
        let names = data_dir.list(DAILY_BACKUP);
        assert!(
            names.contains(&"session-backup-1.json".to_owned()),
            "the last intact backup survives rotation: {names:?}"
        );
        assert!(
            names.contains(&"session-backup-8.json".to_owned()),
            "{names:?}"
        );
        assert!(
            names.contains(&"session-backup-18446744073709551615.json".to_owned()),
            "names outside the numbering are never ours to delete"
        );
    }

    #[test]
    fn a_backup_at_the_top_of_the_numbering_never_blocks_saves() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        for name in [
            "session-premigration-9999999999999999.json",
            "session-premigration-1.json",
            "session-backup-9999999999999999.json",
        ] {
            put_backup(&data_dir, name, NOW - 3 * BACKUP_EVERY_MS, &sample());
        }
        let mut files = SessionFiles::new(data_dir.clone(), SESSION.to_owned());
        files.premigration = Some(sample().to_string());
        files
            .save(&whole(&["https://today.example/"]).to_string(), NOW)
            .unwrap();
        let migration = data_dir.list(MIGRATION_BACKUP);
        assert!(
            migration.contains(&"session-premigration-2.json".to_owned()),
            "{migration:?}"
        );
        assert!(files.premigration.is_none());
        let daily = data_dir.list(DAILY_BACKUP);
        assert!(
            daily.contains(&"session-backup-1.json".to_owned()),
            "{daily:?}"
        );
        files
            .save(&whole(&["https://again.example/"]).to_string(), NOW + 1)
            .unwrap();
    }

    #[test]
    fn a_name_taken_outside_the_numbering_moves_on_to_the_next_one() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        data_dir
            .write_atomic("session-premigration-1.JSON", b"{}")
            .unwrap();
        let mut files = SessionFiles::new(data_dir.clone(), SESSION.to_owned());
        files.premigration = Some(sample().to_string());
        files
            .save(&whole(&["https://today.example/"]).to_string(), NOW)
            .unwrap();
        assert!(files.premigration.is_none());
        let written = data_dir
            .list(MIGRATION_BACKUP)
            .into_iter()
            .filter(|n| backup_seq(MIGRATION_BACKUP, n).is_some())
            .count();
        assert_eq!(written, 1);
        let fresh = SessionFiles::new(
            DataDir::new(tempfile::tempdir().unwrap().path()),
            SESSION.to_owned(),
        );
        let tried: HashSet<u64> = [1, 2].into();
        assert_eq!(fresh.next_seq(MIGRATION_BACKUP, &tried), 3);
    }

    #[test]
    fn recovery_prefers_a_complete_backup_over_a_newer_partial_one() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(dir.path());
        data_dir
            .write_atomic(SESSION, b"{\"version\": 11, \"tabs\": [")
            .unwrap();
        put_backup(
            &data_dir,
            "session-backup-1.json",
            NOW - 2 * BACKUP_EVERY_MS,
            &whole(&["https://complete.example/"]),
        );
        put_backup(
            &data_dir,
            "session-backup-2.json",
            NOW - BACKUP_EVERY_MS,
            &sample(),
        );
        let (data, report, _) = load_plain(&data_dir);
        assert_eq!(
            report.source,
            SessionSource::Backup {
                name: "session-backup-1.json".into(),
                age_days: 2
            }
        );
        assert_eq!(report.dropped_rows, 0);
        assert_eq!(
            data.tabs.values().next().unwrap().url,
            "https://complete.example/"
        );
    }
}
