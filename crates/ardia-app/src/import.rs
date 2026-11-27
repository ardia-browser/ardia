use std::path::{Path, PathBuf};

use ardia_import_core::BookmarkNode;
use ardia_state::ProfileId;
use ardia_state::import::{BookmarkSource, import_bookmarks_bytes, import_chromium_profile};
use serde_json::{Value, json};

use ardia_ui::host_data::{
    HostTopics, ImportBrowser, ImportBrowserProfile, ImportPlan, ImportProgress, ImportStage,
    StageState,
};

use ardia_state::DataDir;
use ardia_state::bookmarks::BookmarkTree;
use ardia_state::persistence::documents;

use crate::bookmark_merge::{ImportedFolder, ImportedFolders, import_into_tree};
use crate::coordinator::AppCoordinator;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportSource {
    ChromiumProfile { label: String, path: PathBuf },
    BookmarksFile { path: PathBuf },
}

impl ImportSource {
    pub fn label(&self) -> String {
        match self {
            Self::ChromiumProfile { label, .. } => label.clone(),
            Self::BookmarksFile { path } => path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "a bookmarks file".into()),
        }
    }
}

fn browser_folder(name: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match name {
        "chrome" => (
            "Chrome",
            "Google/Chrome/Default",
            ".config/google-chrome/Default",
        ),
        "chromium" => ("Chromium", "Chromium/Default", ".config/chromium/Default"),
        "brave" => (
            "Brave",
            "BraveSoftware/Brave-Browser/Default",
            ".config/BraveSoftware/Brave-Browser/Default",
        ),
        "edge" => (
            "Edge",
            "Microsoft Edge/Default",
            ".config/microsoft-edge/Default",
        ),
        "vivaldi" => ("Vivaldi", "Vivaldi/Default", ".config/vivaldi/Default"),
        "arc" => ("Arc", "Arc/User Data/Default", ".config/arc/Default"),
        "dia" => ("Dia", "Dia/User Data/Default", ".config/dia/Default"),
        _ => return None,
    })
}

pub fn resolve_source(source: &str, home: Option<&Path>) -> Result<ImportSource, String> {
    if let Some(path) = source.strip_prefix("chromium:") {
        return Ok(ImportSource::ChromiumProfile {
            label: "Chromium".into(),
            path: PathBuf::from(path),
        });
    }
    if let Some(path) = source.strip_prefix("html:") {
        return Ok(ImportSource::BookmarksFile {
            path: PathBuf::from(path),
        });
    }
    let (label, mac, linux) =
        browser_folder(source).ok_or_else(|| format!("Ardia can't import from {source:?} yet"))?;
    let home = home.ok_or("there's no home folder to look in")?;
    let path = if cfg!(target_os = "macos") {
        home.join("Library/Application Support").join(mac)
    } else {
        home.join(linux)
    };
    Ok(ImportSource::ChromiumProfile {
        label: label.into(),
        path,
    })
}

pub fn read_source(source: &ImportSource) -> Result<BookmarkNode, String> {
    match source {
        ImportSource::ChromiumProfile { path, .. } => {
            import_chromium_profile(path).map_err(|e| e.to_string())
        }
        ImportSource::BookmarksFile { path } => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let kind = if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
            {
                BookmarkSource::Chromium
            } else {
                BookmarkSource::NetscapeHtml
            };
            import_bookmarks_bytes(kind, &bytes).map_err(|e| e.to_string())
        }
    }
}

pub const DATA_LABELS: [(&str, &str); 7] = [
    ("bookmarks", "Bookmarks"),
    ("history", "History"),
    ("passwords", "Passwords"),
    ("cookies", "Cookies"),
    ("cards", "Payment Cards"),
    ("tabs", "Tabs"),
    ("extensions", "Extensions"),
];

pub const SUPPORTED_KINDS: [&str; 7] = [
    "tabs",
    "bookmarks",
    "history",
    "passwords",
    "cookies",
    "cards",
    "extensions",
];
pub const CHROMIUM_KINDS: [&str; 5] =
    ["bookmarks", "history", "passwords", "cookies", "extensions"];
pub const SAFARI_KINDS: [&str; 3] = ["bookmarks", "history", "tabs"];

pub const NOT_YET: &str = "Not available yet";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportRequest {
    pub source: String,
    pub data: Vec<String>,
}

pub fn parse_request(request: &str) -> ImportRequest {
    let whole = || ImportRequest {
        source: request.to_owned(),
        data: vec!["bookmarks".to_owned()],
    };
    if request.starts_with("chromium:") || request.starts_with("html:") {
        return whole();
    }
    match request.split_once(':') {
        Some((source, data)) => ImportRequest {
            source: source.to_owned(),
            data: data
                .split(',')
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(str::to_owned)
                .collect(),
        },
        None => whole(),
    }
}

pub fn stages_for(request: &ImportRequest) -> Vec<ImportStage> {
    let mut stages: Vec<ImportStage> = Vec::new();
    for key in &request.data {
        if stages.iter().any(|stage| &stage.key == key) {
            continue;
        }
        let label = DATA_LABELS
            .iter()
            .find(|(known, _)| known == key)
            .map_or(key.as_str(), |(_, label)| label);
        let mut stage = ImportStage::new(key, label);
        if !SUPPORTED_KINDS.contains(&key.as_str()) {
            stage.state = StageState::Failed(NOT_YET.to_owned());
        }
        stages.push(stage);
    }
    stages
}

fn source_name(source: &str) -> String {
    browser_folder(source)
        .map(|(label, _, _)| label.to_owned())
        .unwrap_or_else(|| {
            let mut chars = source.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect())
                .unwrap_or_default()
        })
}

pub fn plan_for_request(
    source: &str,
    profile: ProfileId,
    home: Option<&Path>,
) -> Result<ImportPlan, String> {
    let request = parse_request(source);
    let name = source_name(&request.source);
    if request.source == crate::import_run::SAFARI {
        return Ok(ImportPlan {
            source_id: request.source.clone(),
            source_name: "Safari".into(),
            kinds: request.data,
            target: Some(profile),
            ..ImportPlan::default()
        });
    }
    let plan = match resolve_source(&request.source, home)? {
        ImportSource::BookmarksFile { path } => ImportPlan {
            source_id: "html".into(),
            source_name: ImportSource::BookmarksFile { path: path.clone() }.label(),
            kinds: vec!["bookmarks".into()],
            target: Some(profile),
            file: Some(path.to_string_lossy().into_owned()),
            ..ImportPlan::default()
        },
        ImportSource::ChromiumProfile { label, path } => ImportPlan {
            source_id: request
                .source
                .split(':')
                .next()
                .unwrap_or_default()
                .to_owned(),
            source_name: if request.source.starts_with("chromium:") {
                label
            } else {
                name
            },
            profiles: vec![ImportBrowserProfile {
                id: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: path.to_string_lossy().into_owned(),
                is_default: true,
                ..ImportBrowserProfile::default()
            }],
            kinds: request.data,
            target: Some(profile),
            file: None,
        },
    };
    Ok(plan)
}

pub fn start(coordinator: &AppCoordinator, source: String, profile: ProfileId) {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match plan_for_request(&source, profile, home.as_deref()) {
        Ok(plan) => crate::import_run::run_without_unlocking(coordinator, plan),
        Err(problem) => {
            let request = parse_request(&source);
            let run = coordinator.begin_import(&source_name(&request.source), stages_for(&request));
            coordinator.import_failed(run, problem);
        }
    }
}

pub const BROWSER_ORDER: [&str; 7] = [
    "arc", "dia", "chrome", "brave", "edge", "vivaldi", "chromium",
];

fn user_data_dir(home: &Path, id: &str) -> Option<PathBuf> {
    let (_, mac, linux) = browser_folder(id)?;
    let relative = if cfg!(target_os = "macos") {
        Path::new("Library/Application Support").join(mac)
    } else {
        PathBuf::from(linux)
    };
    home.join(relative).parent().map(Path::to_path_buf)
}

pub fn browser_profiles(user_data: &Path) -> Vec<ImportBrowserProfile> {
    let local_state = std::fs::read(user_data.join("Local State"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let mut profiles: Vec<ImportBrowserProfile> = local_state
        .as_ref()
        .and_then(|state| state.pointer("/profile/info_cache"))
        .and_then(Value::as_object)
        .map(|cache| {
            cache
                .iter()
                .map(|(dir, info)| {
                    let text = |key: &str| {
                        info.get(key)
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                            .map(str::to_owned)
                    };
                    ImportBrowserProfile {
                        id: dir.clone(),
                        name: text("name").unwrap_or_else(|| dir.clone()),
                        path: user_data.join(dir).to_string_lossy().into_owned(),
                        email: text("user_name"),
                        is_default: dir == "Default",
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    if profiles.is_empty() && user_data.join("Default").is_dir() {
        profiles.push(ImportBrowserProfile {
            id: "Default".into(),
            name: "Default".into(),
            path: user_data.join("Default").to_string_lossy().into_owned(),
            email: None,
            is_default: true,
        });
    }
    profiles.retain(|profile| {
        let dir = Path::new(&profile.path);
        ["Bookmarks", "History", "Preferences"]
            .iter()
            .any(|file| dir.join(file).is_file())
    });
    profiles.sort_by(|a, z| z.is_default.cmp(&a.is_default).then(a.id.cmp(&z.id)));
    profiles
}

pub fn detect_browsers(home: &Path) -> Vec<ImportBrowser> {
    let mut found: Vec<ImportBrowser> = BROWSER_ORDER
        .iter()
        .filter_map(|id| {
            let user_data = user_data_dir(home, id)?;
            let profiles = browser_profiles(&user_data);
            (!profiles.is_empty()).then(|| ImportBrowser {
                id: (*id).to_owned(),
                name: browser_folder(id)
                    .map_or_else(|| (*id).to_owned(), |(name, _, _)| name.to_owned()),
                profiles,
                kinds: CHROMIUM_KINDS.iter().map(|k| (*k).to_owned()).collect(),
            })
        })
        .collect();
    if cfg!(target_os = "macos") && home.join("Library/Safari").is_dir() {
        found.push(ImportBrowser {
            id: crate::import_run::SAFARI.to_owned(),
            name: "Safari".to_owned(),
            profiles: Vec::new(),
            kinds: SAFARI_KINDS.iter().map(|k| (*k).to_owned()).collect(),
        });
    }
    found
}

pub fn refresh_browsers(coordinator: &AppCoordinator) {
    let me = coordinator.weak();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let spawned = std::thread::Builder::new()
        .name("ardia-import-browsers".into())
        .spawn(move || {
            let found = home.as_deref().map(detect_browsers).unwrap_or_default();
            if let Some(coordinator) = me.upgrade() {
                coordinator.post(move |coordinator| {
                    coordinator.bridge.lock().import_browsers = Some(found);
                    coordinator.signal.emit(HostTopics::IMPORT);
                });
            }
        });
    if let Err(problem) = spawned {
        log::warn!("other browsers couldn't be listed: {problem}");
        coordinator.bridge.lock().import_browsers = Some(Vec::new());
        coordinator.signal.emit(HostTopics::IMPORT);
    }
}

pub fn run_plan(coordinator: &AppCoordinator, plan: ImportPlan) {
    crate::import_run::run(coordinator, plan);
}

impl AppCoordinator {
    pub fn import_progress(&self) -> Option<ImportProgress> {
        self.bridge.lock().import.clone()
    }

    pub(crate) fn begin_import(&self, source: &str, stages: Vec<ImportStage>) -> u64 {
        let run = {
            let mut bridge = self.bridge.lock();
            bridge.import_runs += 1;
            let run = bridge.import_runs;
            bridge.import = Some(ImportProgress::new(run, source, stages));
            run
        };
        self.signal.emit(HostTopics::IMPORT);
        run
    }

    pub(crate) fn update_import(&self, run: u64, change: impl FnOnce(&mut ImportProgress)) {
        let changed = {
            let mut bridge = self.bridge.lock();
            match bridge.import.as_mut() {
                Some(progress) if progress.run == run => {
                    change(progress);
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.signal.emit(HostTopics::IMPORT);
        }
    }

    pub(crate) fn abort_import(&self) {
        let cancel = self.bridge.lock().import_cancel.take();
        if let Some(cancel) = cancel {
            cancel.store(true, std::sync::atomic::Ordering::Release);
            let run = self
                .bridge
                .lock()
                .import
                .as_ref()
                .map(|progress| progress.run);
            if let Some(run) = run {
                self.update_import(run, |progress| {
                    if !progress.finished {
                        progress.fail("Cancelled".to_owned());
                    }
                });
            }
        }
    }

    pub(crate) fn import_failed(&self, run: u64, problem: String) {
        self.update_import(run, |progress| progress.fail(problem.clone()));
    }

    fn imported_folders(&self) -> ImportedFolders {
        if let Some(known) = self.bridge.lock().imported_folders.clone() {
            return known;
        }
        let loaded = self
            .config
            .data_dir
            .as_deref()
            .map(|dir| read_imported_folders(&DataDir::new(dir)))
            .unwrap_or_default();
        self.bridge.lock().imported_folders = Some(loaded.clone());
        loaded
    }

    fn keep_imported_folders(&self, folders: ImportedFolders) {
        if let Some(dir) = self.config.data_dir.as_deref()
            && let Err(problem) = documents::write_versioned(
                &DataDir::new(dir),
                IMPORTED_FOLDERS_DOCUMENT,
                "version",
                IMPORTED_FOLDERS_VERSION,
                imported_folders_value(&folders),
            )
        {
            log::warn!("couldn't save which bookmark folders imports made: {problem}");
        }
        self.bridge.lock().imported_folders = Some(folders);
    }

    pub(crate) fn merge_import(
        &self,
        profile: &ProfileId,
        label: &str,
        imported: &BookmarkNode,
    ) -> Option<usize> {
        let state = self.store.snapshot();
        state.profile(profile.as_str())?;
        let key = state.engine_profile(profile);
        let now = ardia_state::store::now_ms();
        let mut made = self.imported_folders();
        let mut next = (*state).clone();
        let tree = std::sync::Arc::make_mut(
            std::sync::Arc::make_mut(&mut next.bookmarks)
                .entry(key.clone())
                .or_insert_with(|| std::sync::Arc::new(BookmarkTree::new(&key, now))),
        );
        let merged = import_into_tree(tree, self.store.ids(), &mut made, imported, label, now);
        if merged.links > 0 || merged.folders > 0 {
            self.store.replace(next);
        }
        self.keep_imported_folders(made);
        Some(merged.links)
    }
}

pub const IMPORTED_FOLDERS_DOCUMENT: &str = "imported-bookmarks.json";
pub const IMPORTED_FOLDERS_VERSION: u64 = 1;

pub fn read_imported_folders(dir: &DataDir) -> ImportedFolders {
    let documents::DocRead::Usable { doc, .. } = documents::read_versioned(
        dir,
        IMPORTED_FOLDERS_DOCUMENT,
        "version",
        IMPORTED_FOLDERS_VERSION,
    ) else {
        return ImportedFolders::new();
    };
    doc.get("folders")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, saved)| {
            let text = |key: &str| saved.get(key).and_then(Value::as_str).map(str::to_owned);
            Some((
                id.clone(),
                ImportedFolder {
                    source: text("source")?,
                    engine: text("engine")?,
                    wrapper: saved
                        .get("wrapper")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    adopted: saved
                        .get("adopted")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                },
            ))
        })
        .collect()
}

pub fn imported_folders_value(folders: &ImportedFolders) -> Value {
    let entries: serde_json::Map<String, Value> = folders
        .iter()
        .map(|(id, folder)| {
            let mut saved = json!({ "source": folder.source, "engine": folder.engine });
            if folder.wrapper {
                saved["wrapper"] = json!(true);
            }
            if folder.adopted {
                saved["adopted"] = json!(true);
            }
            (id.clone(), saved)
        })
        .collect();
    json!({ "folders": entries })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_resolve_to_profiles_and_files() {
        let home = Path::new("/Users/x");
        match resolve_source("chrome", Some(home)).unwrap() {
            ImportSource::ChromiumProfile { label, path } => {
                assert_eq!(label, "Chrome");
                assert!(path.ends_with("Default"));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            resolve_source("html:/tmp/b.html", None).unwrap(),
            ImportSource::BookmarksFile {
                path: PathBuf::from("/tmp/b.html")
            }
        );
        assert!(resolve_source("netscape", Some(home)).is_err());
        assert!(resolve_source("chrome", None).is_err());
    }

    #[test]
    fn requests_name_the_browser_and_the_data() {
        assert_eq!(
            parse_request("chrome:bookmarks,history,,passwords"),
            ImportRequest {
                source: "chrome".into(),
                data: vec!["bookmarks".into(), "history".into(), "passwords".into()],
            }
        );
        assert_eq!(
            parse_request("html:/tmp/a:b.html").source,
            "html:/tmp/a:b.html"
        );
        assert_eq!(parse_request("arc").data, vec!["bookmarks".to_owned()]);
        let stages = stages_for(&parse_request("dia:history,bookmarks,history"));
        assert_eq!(stages.len(), 2);
        assert_eq!(stages[0].state, StageState::Waiting);
        assert_eq!(stages[1].state, StageState::Waiting);
        assert_eq!(
            stages_for(&parse_request("dia:spaces"))[0].state,
            StageState::Failed(NOT_YET.into())
        );
        assert_eq!(source_name("chrome"), "Chrome");
        assert_eq!(source_name("firefox"), "Firefox");
    }

    #[test]
    fn html_files_import() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bookmarks.html");
        std::fs::write(
            &path,
            "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p><DT><A HREF=\"https://x.example/\">X</A></DL><p>",
        )
        .unwrap();
        let tree = read_source(&ImportSource::BookmarksFile { path }).unwrap();
        assert_eq!(tree.link_count(), 1);
    }
}
