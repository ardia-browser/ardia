use std::path::{Path, PathBuf};

use serde_json::Value;

use super::manifest::{MANIFEST_FILE, ManifestRead, is_name, read_manifest};
use super::records::approval_hash;

pub const MAX_PLUGINS: usize = 64;
pub const OFFICIAL_FOLDER: &str = "OfficialPlugins";
pub const DATA_FOLDER: &str = "PluginData";
pub const OFFICIAL_PREFIX: &str = "official-";
const MANIFEST_LIMIT: u64 = 256 * 1024;
const PIN_TEXT: &str = include_str!("../../../../apps/browser/official-plugins.json");
const PLATFORM_ARTIFACT: &str = "macos-arm64";
const TRUSTED_HISTORY: [&str; 3] = [
    "076c2139d35b59acc826ea4db8dbce4526f6406bc8e3b2ef5de440d0d28be022",
    "5f6442242c0a7d42d9ec592c599a167faa3675dbbc18999ef2cf34fc2336339e",
    "ca438f2159460804a8e8f1eef50cfb6a3d0149ada247cc463b04586df39feadb",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinEntry {
    pub name: String,
    pub title: String,
    pub icon: String,
    pub version: String,
    pub sha256: String,
    pub trusted: Vec<String>,
    pub preselected: bool,
    pub blurb: String,
    pub file: Option<String>,
    pub url: Option<String>,
    pub reserved_programs: Vec<String>,
    pub example: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComingSoonEntry {
    pub name: String,
    pub title: String,
    pub blurb: String,
    pub icon: String,
    pub experiment: String,
}

pub const SWITCHES_ENV: &str = "ARDIA_SWITCHES";

pub fn switch_value(text: &str, name: &str) -> Option<bool> {
    text.split(',').find_map(|piece| {
        let (key, value) = piece.split_once('=')?;
        if key.trim() != name {
            return None;
        }
        match value.trim() {
            "on" | "1" | "true" => Some(true),
            "off" | "0" | "false" => Some(false),
            _ => None,
        }
    })
}

pub fn experiment_on(name: &str) -> bool {
    std::env::var(SWITCHES_ENV)
        .ok()
        .and_then(|text| switch_value(&text, name))
        .unwrap_or(false)
}

fn short_text(value: Option<&Value>, max: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty() && t.chars().count() <= max && !t.chars().any(char::is_control))
        .map(str::to_owned)
}

pub fn parse_coming_soon(text: &str) -> Vec<ComingSoonEntry> {
    let Ok(doc) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    doc.get("comingSoon")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let name = entry.get("name")?.as_str().filter(|n| is_name(n))?;
            Some(ComingSoonEntry {
                name: name.to_owned(),
                title: short_text(entry.get("title"), 80).unwrap_or_else(|| name.to_owned()),
                blurb: short_text(entry.get("blurb"), 300).unwrap_or_default(),
                icon: short_text(entry.get("icon"), 80).unwrap_or_else(|| "puzzlepiece".to_owned()),
                experiment: short_text(entry.get("experiment"), 80)?,
            })
        })
        .collect()
}

pub fn bundled_coming_soon() -> Vec<ComingSoonEntry> {
    parse_coming_soon(PIN_TEXT)
}

impl PinEntry {
    pub fn trusts(&self, sha: &str) -> bool {
        sha == self.sha256 || self.trusted.iter().any(|t| t == sha)
    }
}

fn is_sha(text: &str) -> bool {
    text.len() == 64
        && text
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

pub fn parse_pin(text: &str) -> Vec<PinEntry> {
    let Ok(doc) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let Some(plugins) = doc.get("plugins").and_then(Value::as_array) else {
        return Vec::new();
    };
    plugins
        .iter()
        .filter_map(|plugin| {
            let name = plugin.get("name")?.as_str().filter(|n| is_name(n))?;
            let artifact = plugin.get("artifacts")?.get(PLATFORM_ARTIFACT)?;
            let sha = artifact.get("sha256")?.as_str().filter(|s| is_sha(s))?;
            let file = artifact
                .get("file")
                .and_then(Value::as_str)
                .filter(|f| is_component(f))
                .map(str::to_owned);
            let url = plugin
                .get("release")
                .and_then(Value::as_str)
                .zip(file.as_deref())
                .map(|(release, file)| format!("{}/{file}", release.trim_end_matches('/')))
                .filter(|u| {
                    url::Url::parse(u).is_ok_and(|u| {
                        u.scheme() == "https" && u.host_str().is_some_and(|h| !h.is_empty())
                    })
                });
            let mut trusted: Vec<String> = plugin
                .get("trusted")
                .and_then(|t| t.get("artifacts"))
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|s| s.as_str().filter(|s| is_sha(s)).map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            if name == "cli" {
                trusted.extend(TRUSTED_HISTORY.iter().map(|s| (*s).to_owned()));
            }
            Some(PinEntry {
                name: name.to_owned(),
                title: plugin
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(name)
                    .to_owned(),
                icon: plugin
                    .get("icon")
                    .and_then(Value::as_str)
                    .unwrap_or("puzzlepiece")
                    .to_owned(),
                version: plugin
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                sha256: sha.to_owned(),
                trusted,
                preselected: plugin.get("preselected") == Some(&Value::Bool(true)),
                blurb: plugin
                    .get("blurb")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                url,
                file,
                example: short_text(plugin.get("example"), 200),
                reserved_programs: plugin
                    .get("reservedPrograms")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(Value::as_str)
                            .filter(|p| is_name(p))
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn is_component(text: &str) -> bool {
    !text.is_empty()
        && text != "."
        && text != ".."
        && text.len() <= 255
        && !text.contains('/')
        && !text.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
}

pub fn bundled_pin() -> Vec<PinEntry> {
    parse_pin(PIN_TEXT)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Listing {
    pub name: String,
    pub folder: PathBuf,
    pub folder_id: String,
    pub official: bool,
    pub legacy: bool,
    pub ignores_user_folder: bool,
    pub text: Option<String>,
    pub read: ManifestRead,
    pub hash: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct PluginFolders {
    pub data_dir: PathBuf,
    pub config_dir: PathBuf,
    pub pin: Vec<PinEntry>,
}

pub fn config_dir_for(data_dir: &Path, scratch: bool, home: Option<&Path>) -> PathBuf {
    if scratch {
        return data_dir.join("config");
    }
    home.map_or_else(
        || data_dir.join("config"),
        |home| home.join(".config/ardia"),
    )
}

#[cfg(unix)]
fn folder_id(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    meta.is_dir()
        .then(|| format!("{}:{}", meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn folder_id(path: &Path) -> Option<String> {
    std::fs::metadata(path)
        .ok()?
        .is_dir()
        .then(|| path.to_string_lossy().into_owned())
}

fn manifest_text(folder: &Path) -> (String, Option<String>) {
    let path = folder.join(MANIFEST_FILE);
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return ("missing".into(), None);
    };
    if !meta.is_file() {
        return ("unreadable".into(), None);
    }
    if meta.len() > MANIFEST_LIMIT {
        return ("tooLarge".into(), None);
    }
    match std::fs::read_to_string(&path) {
        Ok(text) => ("ok".into(), Some(text)),
        Err(_) => ("unreadable".into(), None),
    }
}

fn listing(
    name: &str,
    folder: PathBuf,
    folder_id: String,
    official: bool,
    legacy: bool,
) -> Listing {
    let (status, text) = manifest_text(&folder);
    let read = match &text {
        Some(text) => read_manifest(text),
        None => ManifestRead {
            manifest: None,
            problems: vec![format!("{MANIFEST_FILE} is {status}")],
            newer: false,
        },
    };
    let read = match read.manifest.as_ref() {
        Some(m) if m.name != name => ManifestRead {
            manifest: None,
            problems: vec![format!(
                "{MANIFEST_FILE}: name must be {name}, the folder's name"
            )],
            newer: false,
        },
        _ => read,
    };
    let hash = text.as_deref().map(|text| approval_hash(text, &folder_id));
    Listing {
        name: name.to_owned(),
        folder,
        folder_id,
        official,
        legacy,
        ignores_user_folder: false,
        text,
        read,
        hash,
        status,
    }
}

fn official_copy_listing(name: &str, folder: PathBuf, sha: &str, legacy: bool) -> Listing {
    let mut found = listing(
        name,
        folder,
        format!("{OFFICIAL_PREFIX}{sha}"),
        true,
        legacy,
    );
    if found.read.manifest.as_ref().is_some_and(|m| !m.official) {
        found.read = ManifestRead {
            manifest: None,
            problems: vec![format!(
                "{MANIFEST_FILE}: official must be true for an official plugin"
            )],
            newer: false,
        };
    }
    found
}

impl PluginFolders {
    pub fn new(data_dir: PathBuf, config_dir: PathBuf) -> Self {
        PluginFolders {
            data_dir,
            config_dir,
            pin: bundled_pin(),
        }
    }

    pub fn user_root(&self) -> PathBuf {
        self.config_dir.join("plugins")
    }

    pub fn official_root(&self) -> PathBuf {
        self.data_dir.join(OFFICIAL_FOLDER)
    }

    pub fn data_folder(&self, name: &str) -> Option<PathBuf> {
        if !is_name(name) {
            return None;
        }
        let folder = self.data_dir.join(DATA_FOLDER).join(name);
        std::fs::create_dir_all(folder.join("home")).ok()?;
        std::fs::create_dir_all(folder.join("tmp")).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700));
        }
        Some(folder)
    }

    fn official_listing(&self, entry: &PinEntry) -> Option<Listing> {
        let root = self.official_root().join(&entry.name);
        let active = std::fs::read_link(root.join("active")).ok()?;
        let sha = active.file_name()?.to_str()?.to_owned();
        if !is_sha(&sha) || !entry.trusts(&sha) {
            return None;
        }
        Some(official_copy_listing(
            &entry.name,
            root.join(&sha),
            &sha,
            sha != entry.sha256,
        ))
    }

    pub fn candidate_listing(&self, entry: &PinEntry, sha: &str) -> Listing {
        official_copy_listing(
            &entry.name,
            self.official_root().join(&entry.name).join(sha),
            sha,
            false,
        )
    }

    pub fn list(&self) -> Vec<Listing> {
        let mut user: Vec<String> = std::fs::read_dir(self.user_root())
            .map(|dir| {
                dir.filter_map(Result::ok)
                    .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                    .filter(|n| is_name(n))
                    .collect()
            })
            .unwrap_or_default();
        user.sort();
        let official: Vec<Listing> = self
            .pin
            .iter()
            .filter_map(|e| self.official_listing(e))
            .collect();
        let mut out: Vec<Listing> = Vec::new();
        for mut found in official {
            found.ignores_user_folder = user.contains(&found.name);
            out.push(found);
        }
        for name in user {
            if out.len() >= MAX_PLUGINS {
                break;
            }
            if out.iter().any(|l| l.name == name) {
                continue;
            }
            let folder = self.user_root().join(&name);
            let real = std::fs::canonicalize(&folder).unwrap_or(folder);
            let Some(id) = folder_id(&real) else {
                continue;
            };
            out.push(listing(&name, real, id, false, false));
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    pub fn approved_folder(&self, listing: &Listing, approved: &str) -> Result<PathBuf, String> {
        let id = if listing.official {
            listing.folder_id.clone()
        } else {
            folder_id(&listing.folder).ok_or("its folder is gone")?
        };
        if id != listing.folder_id {
            return Err("its folder was replaced".into());
        }
        let (_, text) = manifest_text(&listing.folder);
        let text = text.ok_or("its plugin.json can't be read")?;
        if approval_hash(&text, &id) != approved {
            return Err("it changed since you approved it".into());
        }
        Ok(listing.folder.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_pin_reads_and_trusts_older_cli_builds() {
        let pin = bundled_pin();
        let cli = pin.iter().find(|e| e.name == "cli").expect("cli is pinned");
        assert!(cli.trusts(&cli.sha256));
        assert!(cli.trusts(TRUSTED_HISTORY[2]));
        assert!(!cli.trusts(&"0".repeat(64)));
    }

    #[test]
    fn lists_user_and_official_plugins() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let folders = PluginFolders {
            data_dir: data.clone(),
            config_dir: config_dir_for(&data, true, None),
            pin: parse_pin(&format!(
                r#"{{"plugins":[{{"name":"cli","artifacts":{{"macos-arm64":{{"sha256":"{}"}}}}}}]}}"#,
                "b".repeat(64)
            )),
        };
        let user = folders.user_root().join("notes");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(
            user.join("plugin.json"),
            r#"{"manifest":2,"name":"notes","title":"Notes"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(folders.user_root().join("Bad Name")).unwrap();
        let official = folders.official_root().join("cli");
        let sha = "b".repeat(64);
        std::fs::create_dir_all(official.join(&sha)).unwrap();
        std::fs::write(
            official.join(&sha).join("plugin.json"),
            r#"{"manifest":2,"name":"cli","title":"Command Line","official":true}"#,
        )
        .unwrap();
        std::os::unix::fs::symlink(&sha, official.join("active")).unwrap();
        let found = folders.list();
        assert_eq!(
            found.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(),
            vec!["cli", "notes"]
        );
        assert!(found[0].official);
        assert_eq!(found[0].folder_id, format!("official-{sha}"));
        assert!(found[1].read.manifest.is_some());
        let hash = found[1].hash.clone().unwrap();
        assert!(folders.approved_folder(&found[1], &hash).is_ok());
        std::fs::write(
            user.join("plugin.json"),
            r#"{"manifest":2,"name":"notes","title":"Changed"}"#,
        )
        .unwrap();
        assert!(folders.approved_folder(&found[1], &hash).is_err());
        assert!(folders.data_folder("notes").unwrap().join("tmp").is_dir());
        assert!(folders.data_folder("../x").is_none());
    }
}
