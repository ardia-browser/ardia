use crate::air_traffic::{self, AirTrafficConfig, SourceApp};
use crate::bookmarks::{BookmarkNode, BookmarkTree};
use crate::closed::ParkedPins;
use crate::downloads::{Download, DownloadList};
use crate::json::{self, Fields};
use crate::model::Millis;
use crate::omnibox::bangs::Bangs;
use crate::persistence::{DataDir, Limits, PersistError, version_field, versioned};
use crate::settings::SettingsPatch;
use crate::shortcuts::{Platform, Shortcut};
use crate::sync::{self, SyncDoc};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DOWNLOADS: &str = "downloads.json";
pub const DOWNLOADS_VERSION: u64 = 3;
pub const ONBOARDING: &str = "onboarding.json";
pub const ONBOARDING_VERSION: u64 = 1;
pub const LINK_SOURCES: &str = "link-sources.json";
pub const LINK_SOURCES_VERSION: u64 = 1;
pub const MAX_RECENT_APPS: usize = 20;
pub const BOOKMARKS_CACHE: &str = "bookmarks-cache.json";
pub const BOOKMARKS_CACHE_VERSION: u64 = 1;
pub const SHARED_FOLDERS: &str = "shared-folders.json";
pub const SHARED_FOLDERS_VERSION: u64 = 1;
pub const PINS_BACKUP: &str = "pins-backup.json";
pub const PINS_BACKUP_VERSION: u64 = 1;
pub const MAX_PIN_BACKUPS: usize = 20;
pub const BANGS: &str = "bangs.txt";
pub const CONFIG: &str = "config.json";

#[derive(Clone, Debug, PartialEq)]
pub enum DocRead {
    Missing,
    Usable { doc: Fields, from: u64 },
    Newer,
    Unusable(&'static str),
}

pub fn read_versioned(dir: &DataDir, name: &str, field: &str, version: u64) -> DocRead {
    let value = match dir.read_json(name, Limits::DOCUMENT) {
        Ok(None) => return DocRead::Missing,
        Ok(Some(value)) => value,
        Err(PersistError::Json(problem)) => return DocRead::Unusable(problem.code()),
        Err(_) => return DocRead::Unusable("unreadable"),
    };
    let Value::Object(doc) = value else {
        return DocRead::Unusable("shape");
    };
    match version_field(doc.get(field)) {
        Some(from) if from > version => DocRead::Newer,
        Some(from) => DocRead::Usable { doc, from },
        None => DocRead::Unusable("version"),
    }
}

fn usable(read: DocRead) -> Option<Fields> {
    match read {
        DocRead::Usable { doc, .. } => Some(doc),
        _ => None,
    }
}

pub fn write_versioned(
    dir: &DataDir,
    name: &str,
    field: &str,
    version: u64,
    value: Value,
) -> Result<bool, PersistError> {
    match read_versioned(dir, name, field, version) {
        DocRead::Newer => return Ok(false),
        DocRead::Unusable(_) => {
            dir.keep_aside(name, crate::store::now_ms())?;
        }
        DocRead::Missing | DocRead::Usable { .. } => {}
    }
    let bytes =
        serde_json::to_vec(&versioned(value, field, version)).map_err(std::io::Error::other)?;
    dir.write_atomic(name, &bytes)?;
    Ok(true)
}

pub fn load_downloads(dir: &DataDir) -> (DownloadList, bool) {
    let found = usable(read_versioned(dir, DOWNLOADS, "version", DOWNLOADS_VERSION));
    let whole = found
        .as_ref()
        .is_none_or(|doc| doc.get("downloads").is_some_and(Value::is_array));
    let rows = found
        .and_then(|mut doc| doc.shift_remove("downloads"))
        .map(|rows| json::take_rows(Some(rows)))
        .unwrap_or_default();
    let listed = rows.len();
    let parsed: Vec<Download> = rows
        .into_iter()
        .filter(Download::row_is_valid)
        .filter_map(|row| serde_json::from_value::<Download>(row).ok())
        .map(|d| d.saved())
        .collect();
    let refused = !whole || parsed.len() < listed;
    (DownloadList::from_saved(parsed), refused)
}

pub fn save_downloads(dir: &DataDir, list: &DownloadList) -> Result<bool, PersistError> {
    write_versioned(
        dir,
        DOWNLOADS,
        "version",
        DOWNLOADS_VERSION,
        serde_json::json!({ "downloads": list.saved() }),
    )
}

pub fn load_air_traffic(dir: &DataDir) -> AirTrafficConfig {
    usable(read_versioned(
        dir,
        air_traffic::DOCUMENT,
        "version",
        air_traffic::VERSION,
    ))
    .map(|doc| AirTrafficConfig::from_value(&Value::Object(doc)))
    .unwrap_or_default()
}

pub fn save_air_traffic(dir: &DataDir, config: &AirTrafficConfig) -> Result<bool, PersistError> {
    write_versioned(
        dir,
        air_traffic::DOCUMENT,
        "version",
        air_traffic::VERSION,
        config.to_value(),
    )
}

pub fn load_recent_apps(dir: &DataDir) -> Vec<SourceApp> {
    let Some(doc) = usable(read_versioned(
        dir,
        LINK_SOURCES,
        "version",
        LINK_SOURCES_VERSION,
    )) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    doc.get("apps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| {
            SourceApp::deserialize(v)
                .ok()
                .filter(|a| !a.name.trim().is_empty())
        })
        .filter(|a| {
            seen.insert(
                a.bundle_id
                    .clone()
                    .unwrap_or_else(|| format!("name:{}", a.name))
                    .to_lowercase(),
            )
        })
        .take(MAX_RECENT_APPS)
        .collect()
}

pub fn save_recent_apps(dir: &DataDir, apps: &[SourceApp]) -> Result<bool, PersistError> {
    write_versioned(
        dir,
        LINK_SOURCES,
        "version",
        LINK_SOURCES_VERSION,
        serde_json::json!({ "apps": &apps[..apps.len().min(MAX_RECENT_APPS)] }),
    )
}

pub fn load_bookmarks(dir: &DataDir, now: Millis) -> IndexMap<String, BookmarkTree> {
    let Some(doc) = usable(read_versioned(
        dir,
        BOOKMARKS_CACHE,
        "version",
        BOOKMARKS_CACHE_VERSION,
    )) else {
        return IndexMap::new();
    };
    doc.get("trees")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(profile, nodes)| {
            let nodes: Vec<BookmarkNode> = nodes
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|n| BookmarkNode::deserialize(n).ok())
                .collect();
            (
                profile.clone(),
                BookmarkTree::from_nodes(profile, nodes, now),
            )
        })
        .collect()
}

pub fn save_bookmarks<'a>(
    dir: &DataDir,
    trees: impl IntoIterator<Item = (&'a String, &'a BookmarkTree)>,
) -> Result<bool, PersistError> {
    let trees: Fields = trees
        .into_iter()
        .map(|(k, t)| (k.clone(), t.to_value()))
        .collect();
    write_versioned(
        dir,
        BOOKMARKS_CACHE,
        "version",
        BOOKMARKS_CACHE_VERSION,
        serde_json::json!({ "trees": trees }),
    )
}

pub fn load_sync(dir: &DataDir) -> SyncDoc {
    usable(read_versioned(
        dir,
        sync::DOCUMENT,
        "v",
        sync::DOCUMENT_VERSION,
    ))
    .map(|doc| SyncDoc::from_value(&Value::Object(doc)))
    .unwrap_or_default()
}

pub fn save_sync(dir: &DataDir, doc: &SyncDoc) -> Result<bool, PersistError> {
    write_versioned(
        dir,
        sync::DOCUMENT,
        "v",
        sync::DOCUMENT_VERSION,
        doc.to_value(),
    )
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Onboarding {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::option_millis"
    )]
    pub started_at: Option<Millis>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::option_millis"
    )]
    pub completed_at: Option<Millis>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub step: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub source: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub preset: Option<String>,
    #[serde(flatten)]
    pub extra: Fields,
}

impl Onboarding {
    pub fn completed(&self) -> bool {
        self.completed_at.is_some()
    }
}

pub fn load_onboarding(dir: &DataDir) -> Option<Onboarding> {
    usable(read_versioned(
        dir,
        ONBOARDING,
        "version",
        ONBOARDING_VERSION,
    ))
    .map(|mut doc| {
        doc.shift_remove("version");
        Onboarding::deserialize(Value::Object(doc)).unwrap_or_default()
    })
}

pub fn save_onboarding(dir: &DataDir, onboarding: &Onboarding) -> Result<bool, PersistError> {
    write_versioned(
        dir,
        ONBOARDING,
        "version",
        ONBOARDING_VERSION,
        serde_json::to_value(onboarding).unwrap_or(Value::Null),
    )
}

#[derive(Clone, Debug, PartialEq)]
pub struct SharedFolder {
    pub profile_id: String,
    pub group_key: String,
    pub path: String,
    pub added_at: Option<Millis>,
}

pub fn load_shared_folders(dir: &DataDir) -> Vec<SharedFolder> {
    let Some(doc) = usable(read_versioned(
        dir,
        SHARED_FOLDERS,
        "version",
        SHARED_FOLDERS_VERSION,
    )) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (profile, groups) in doc
        .get("folders")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        for (group, folder) in groups.as_object().into_iter().flatten() {
            if let Some(path) = folder.get("path").and_then(Value::as_str) {
                out.push(SharedFolder {
                    profile_id: profile.clone(),
                    group_key: group.clone(),
                    path: path.to_owned(),
                    added_at: folder.get("addedAt").and_then(json::as_millis),
                });
            }
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PinBackup {
    #[serde(deserialize_with = "json::millis")]
    pub at: Millis,
    #[serde(default, deserialize_with = "json::lenient")]
    pub dropped: IndexMap<String, u64>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub pins: IndexMap<String, ParkedPins>,
}

pub fn load_pin_backups(dir: &DataDir) -> Vec<PinBackup> {
    usable(read_versioned(
        dir,
        PINS_BACKUP,
        "version",
        PINS_BACKUP_VERSION,
    ))
    .and_then(|doc| doc.get("backups").cloned())
    .and_then(|v| v.as_array().cloned())
    .map(|rows| {
        rows.iter()
            .filter_map(|row| PinBackup::deserialize(row).ok())
            .collect()
    })
    .unwrap_or_default()
}

pub fn append_pin_backup(dir: &DataDir, backup: PinBackup) -> Result<bool, PersistError> {
    let mut backups = load_pin_backups(dir);
    backups.push(backup);
    let over = backups.len().saturating_sub(MAX_PIN_BACKUPS);
    backups.drain(..over);
    write_versioned(
        dir,
        PINS_BACKUP,
        "version",
        PINS_BACKUP_VERSION,
        serde_json::json!({ "backups": backups }),
    )
}

pub fn load_bangs(dir: &DataDir) -> Option<Bangs> {
    let bytes = dir
        .read(BANGS, crate::omnibox::bangs::MAX_BANG_LIST_BYTES + 1024)
        .ok()??;
    Bangs::from_document(std::str::from_utf8(&bytes).ok()?).map(|(_, bangs)| bangs)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ConfigFile {
    pub theme: Option<String>,
    pub settings: SettingsPatch,
    pub rejected: Vec<String>,
}

pub fn load_config(dir: &DataDir, platform: Platform) -> Option<ConfigFile> {
    let config = DataDir::new(dir.config_dir());
    let value = config.read_json(CONFIG, Limits::CONFIG).ok()??;
    let mut out = ConfigFile {
        theme: value
            .get("theme")
            .and_then(Value::as_str)
            .map(str::to_owned),
        ..ConfigFile::default()
    };
    for (key, raw) in value
        .get("settings")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let allowed = crate::settings::Settings::info(key).is_some_and(|info| info.config_file);
        if !allowed {
            out.rejected.push(key.clone());
            continue;
        }
        let value = if key == "shortcuts" {
            shortcuts_from_config(raw, platform)
        } else {
            Some(raw.clone())
        };
        match value {
            Some(value) => out.settings.0.push((key.clone(), value)),
            None => out.rejected.push(key.clone()),
        }
    }
    Some(out)
}

fn shortcuts_from_config(raw: &Value, platform: Platform) -> Option<Value> {
    let fields = raw.as_object()?;
    let mut out = Fields::new();
    for (id, combo) in fields {
        let stored = match combo {
            Value::String(text) if text.trim().is_empty() => vec![String::new()],
            Value::String(text) => Shortcut::parse_combo(text, platform)?.to_stored(),
            Value::Array(parts) => parts
                .iter()
                .map(|p| p.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
            _ => return None,
        };
        out.insert(id.clone(), serde_json::to_value(stored).ok()?);
    }
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir() -> (tempfile::TempDir, DataDir) {
        let temp = tempfile::tempdir().unwrap();
        let data = DataDir::new(temp.path());
        (temp, data)
    }

    #[test]
    fn newer_documents_are_never_overwritten() {
        let (_t, data) = dir();
        data.write_atomic(
            air_traffic::DOCUMENT,
            br#"{"version": 99, "rules": [{"future": true}]}"#,
        )
        .unwrap();
        assert_eq!(load_air_traffic(&data), AirTrafficConfig::default());
        assert!(!save_air_traffic(&data, &AirTrafficConfig::default()).unwrap());
        assert!(
            String::from_utf8(data.read(air_traffic::DOCUMENT, 1000).unwrap().unwrap())
                .unwrap()
                .contains("future")
        );
    }

    #[test]
    fn downloads_round_trip_and_unfinished_ones_fail() {
        let (_t, data) = dir();
        data.write_atomic(DOWNLOADS, br#"{"version": 2, "downloads": [{"id": "a", "state": "downloading", "url": "https://x/a", "stagingId": "s", "destination": "/tmp/x"}, {"id": 4}, {"id": "b", "state": "finished", "url": "https://x/b", "offTheRecord": true}]}"#).unwrap();
        let (list, refused) = load_downloads(&data);
        assert!(refused, "the row without a usable id was refused");
        assert_eq!(list.len(), 1);
        assert_eq!(
            list.items()[0].state,
            crate::downloads::DownloadState::Failed
        );
        assert!(!list.items()[0].extra.contains_key("stagingId"));
        assert!(save_downloads(&data, &list).unwrap());
        let saved = data
            .read_json(DOWNLOADS, Limits::DOCUMENT)
            .unwrap()
            .unwrap();
        assert_eq!(saved["version"], json!(3));
        assert_eq!(load_downloads(&data).0.len(), 1);
    }

    #[test]
    fn downloads_in_the_wrong_shape_count_as_refused() {
        let (_t, data) = dir();
        for shape in [
            br#"{"version": 3, "downloads": {"a": {"id": "a", "state": "finished"}}}"#.as_slice(),
            br#"{"version": 3, "downloads": "garbage"}"#,
            br#"{"version": 3}"#,
        ] {
            data.write_atomic(DOWNLOADS, shape).unwrap();
            let (list, refused) = load_downloads(&data);
            assert!(
                list.is_empty() && refused,
                "{}",
                String::from_utf8_lossy(shape)
            );
        }
        data.remove(DOWNLOADS).unwrap();
        assert!(
            !load_downloads(&data).1,
            "no document means nothing to keep"
        );
    }

    #[test]
    fn unreadable_documents_are_kept_aside_before_they_are_replaced() {
        let (_t, data) = dir();
        data.write_atomic(DOWNLOADS, br#"{"version": 3, "downloads": [{"id": "a""#)
            .unwrap();
        let (list, refused) = load_downloads(&data);
        assert!(list.is_empty() && !refused);
        assert!(save_downloads(&data, &list).unwrap());
        let asides = data.list("downloads-unreadable-");
        assert_eq!(asides.len(), 1);
        assert_eq!(
            data.read(&asides[0], 100).unwrap().unwrap(),
            br#"{"version": 3, "downloads": [{"id": "a""#
        );
        assert!(save_downloads(&data, &list).unwrap());
        assert_eq!(
            data.list("downloads-unreadable-").len(),
            1,
            "a good document is not copied again"
        );
    }

    #[test]
    fn sync_documents_use_their_short_version_field() {
        let (_t, data) = dir();
        assert!(!load_sync(&data).enabled);
        let doc = SyncDoc {
            enabled: true,
            folder: Some("/tmp/sync".into()),
            ..SyncDoc::default()
        };
        assert!(save_sync(&data, &doc).unwrap());
        let raw = data
            .read_json(sync::DOCUMENT, Limits::DOCUMENT)
            .unwrap()
            .unwrap();
        assert_eq!(raw["v"], json!(1));
        assert!(raw.get("version").is_none());
        assert_eq!(load_sync(&data), doc);
    }

    #[test]
    fn config_files_take_allowlisted_settings_and_combo_shortcuts() {
        let (_t, data) = dir();
        std::fs::create_dir_all(data.config_dir()).unwrap();
        std::fs::write(data.config_dir().join(CONFIG), r#"{"theme": "nord", "settings": {"tabLayout": "top", "cliControl": true, "shortcuts": {"newTab": "cmd+shift+n", "reopenClosedTab": ""}}}"#).unwrap();
        let config = load_config(&data, Platform::Mac).unwrap();
        assert_eq!(config.theme.as_deref(), Some("nord"));
        assert_eq!(config.rejected, vec!["cliControl"]);
        assert_eq!(config.settings.get("tabLayout"), Some(&json!("top")));
        assert_eq!(
            config.settings.get("shortcuts"),
            Some(&json!({"newTab": ["n", "shift", "command"], "reopenClosedTab": [""]}))
        );
        assert_eq!(
            load_config(&DataDir::new(data.root().join("nope")), Platform::Mac),
            None
        );
    }

    #[test]
    fn small_documents_tolerate_garbage() {
        let (_t, data) = dir();
        for name in [
            LINK_SOURCES,
            BOOKMARKS_CACHE,
            SHARED_FOLDERS,
            PINS_BACKUP,
            ONBOARDING,
        ] {
            data.write_atomic(name, b"[1, 2, 3]").unwrap();
        }
        assert!(load_recent_apps(&data).is_empty());
        assert!(load_bookmarks(&data, 0).is_empty());
        assert!(load_shared_folders(&data).is_empty());
        assert!(load_pin_backups(&data).is_empty());
        assert_eq!(load_onboarding(&data), None);
        data.write_atomic(LINK_SOURCES, br#"{"version": 1, "apps": [{"bundleId": "com.a", "name": "A"}, {"bundleId": "COM.A", "name": "A2"}, {"name": " "}]}"#).unwrap();
        assert_eq!(load_recent_apps(&data).len(), 1);
        for i in 0..25 {
            append_pin_backup(
                &data,
                PinBackup {
                    at: i,
                    dropped: IndexMap::new(),
                    pins: IndexMap::new(),
                },
            )
            .unwrap();
        }
        let backups = load_pin_backups(&data);
        assert_eq!((backups.len(), backups[0].at), (MAX_PIN_BACKUPS, 5));
    }
}
