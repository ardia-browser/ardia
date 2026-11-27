pub mod packer;

#[cfg(target_os = "macos")]
pub mod extras;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
mod scripts;
pub mod user_filters;

use std::collections::BTreeSet;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const FORMAT: &str = "f6";
pub const LIST_PREFIX: &str = "ardia-ubol-";
pub const CHECK_PREFIX: &str = "ardia-ubol-check-";
pub const FOLDER: &str = "WebKit Content Rules";

const SOURCES: &[(&str, &[&str])] = &[
    ("ublock-filters", &["ublock-filters"]),
    ("pgl", &["plowe-0"]),
    ("ublock-badware", &["ublock-badware"]),
    ("urlhaus-full", &["urlhaus-1"]),
    ("annoyances-ai", &["fanboy-ai-suggestions"]),
    (
        "annoyances-cookies",
        &[
            "fanboy-cookiemonster",
            "ublock-cookies-easylist",
            "adguard-cookies",
            "ublock-cookies-adguard",
        ],
    ),
    (
        "annoyances-overlays",
        &[
            "easylist-newsletters",
            "ublock-annoyances",
            "adguard-popup-overlays",
        ],
    ),
    (
        "annoyances-social",
        &[
            "fanboy-social",
            "fanboy-thirdparty_social",
            "adguard-social",
        ],
    ),
    ("annoyances-widgets", &["easylist-chat", "adguard-widgets"]),
    (
        "annoyances-others",
        &["easylist-annoyances", "adguard-other-annoyances"],
    ),
    ("annoyances-notifications", &["easylist-notifications"]),
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lists: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
}

fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            lists: None,
            allowed_hosts: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Ruleset {
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub scriptlets: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundled {
    pub version: String,
    #[serde(default)]
    pub digest: Option<String>,
    #[serde(default)]
    pub scriptlet_secret: Option<String>,
    pub rulesets: Vec<Ruleset>,
}

impl Bundled {
    pub fn read(directory: &Path) -> Option<Bundled> {
        let text = std::fs::read(directory.join("rulesets.json")).ok()?;
        serde_json::from_slice(&text).ok()
    }

    fn tag(&self) -> &str {
        self.digest.as_deref().unwrap_or(&self.version)
    }
}

pub fn covers(domain: &str, host: &str) -> bool {
    let name = domain.trim_matches('.').to_lowercase();
    !name.is_empty() && (host == name || host.strip_suffix(&name).is_some_and(|f| f.ends_with('.')))
}

pub fn trusted(settings: &Settings, host: &str) -> bool {
    !host.is_empty()
        && settings
            .allowed_hosts
            .iter()
            .any(|domain| covers(domain, host))
}

pub fn wanted_rulesets(bundled: Option<&Bundled>, settings: &Settings) -> Vec<String> {
    let Some(bundled) = bundled else {
        return Vec::new();
    };
    let Some(chosen) = &settings.lists else {
        return bundled
            .rulesets
            .iter()
            .filter(|ruleset| ruleset.enabled)
            .map(|ruleset| ruleset.id.clone())
            .collect();
    };
    let chosen: BTreeSet<&str> = chosen.iter().map(String::as_str).collect();
    bundled
        .rulesets
        .iter()
        .map(|ruleset| ruleset.id.as_str())
        .filter(|id| {
            let sources = SOURCES
                .iter()
                .find(|(source, _)| source == id)
                .map(|(_, lists)| lists.to_vec())
                .unwrap_or_else(|| vec![*id]);
            sources
                .iter()
                .any(|source| chosen.contains(source.to_lowercase().as_str()))
        })
        .map(str::to_owned)
        .collect()
}

pub fn key(bundled: Option<&Bundled>, rulesets: &[String], user_digest: Option<&str>) -> String {
    let mut sorted = rulesets.to_vec();
    sorted.sort();
    let user = user_digest.map(|d| format!(";{d}")).unwrap_or_default();
    let digest = Sha256::digest(format!("{}{user}", sorted.join(",")).as_bytes());
    let hex: String = digest[..6].iter().map(|b| format!("{b:02x}")).collect();
    let tag = bundled.map_or("none", Bundled::tag);
    format!("{tag}-{FORMAT}-{hex}")
}

pub fn identifiers(key: &str, total: usize) -> Vec<String> {
    (0..total)
        .map(|index| format!("{LIST_PREFIX}{key}-{index}of{total}"))
        .collect()
}

pub fn complete_set(key: &str, available: &[String]) -> Option<Vec<String>> {
    let prefix = format!("{LIST_PREFIX}{key}-");
    let mine: BTreeSet<&str> = available
        .iter()
        .map(String::as_str)
        .filter(|id| id.starts_with(&prefix))
        .collect();
    let totals: BTreeSet<usize> = mine
        .iter()
        .filter_map(|id| id.rsplit("of").next()?.parse().ok())
        .collect();
    let total = if totals.len() == 1 {
        totals.into_iter().next().unwrap_or(0)
    } else {
        0
    };
    let expected = identifiers(key, total);
    (total > 0 && expected.iter().map(String::as_str).collect::<BTreeSet<_>>() == mine)
        .then_some(expected)
}

pub fn stale(available: &[String], current: &BTreeSet<String>, previous: &str) -> Vec<String> {
    let older = (!previous.is_empty()).then(|| format!("{LIST_PREFIX}{previous}-"));
    available
        .iter()
        .filter(|id| {
            id.starts_with(LIST_PREFIX)
                && !current.contains(*id)
                && !older.as_ref().is_some_and(|older| id.starts_with(older))
        })
        .cloned()
        .collect()
}

pub fn inflate(path: &Path) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    let mut text = String::new();
    flate2::read::DeflateDecoder::new(&data[..])
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

pub fn assemble(
    rulesets: &[String],
    directory: &Path,
    user: &[packer::NetworkRule],
) -> Vec<String> {
    let texts: Vec<String> = rulesets
        .iter()
        .filter_map(|id| inflate(&directory.join(format!("{id}.rules"))))
        .collect();
    packer::lists(&texts, user)
}

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        let mut out: Vec<String> = items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_lowercase)
            .collect();
        out.sort();
        out
    })
}

pub fn note_change(settings: &Settings, info: &Value) -> Settings {
    let mut next = settings.clone();
    if let Some(enabled) = info.get("enabled").and_then(Value::as_bool) {
        next.enabled = enabled;
    }
    if let Some(lists) = strings(info.get("lists")) {
        next.lists = Some(lists);
    }
    if let Some(hosts) = strings(info.get("allowedHosts")) {
        next.allowed_hosts = hosts;
    }
    if let (Some(host), Some(allowed)) = (
        info.get("host")
            .and_then(Value::as_str)
            .map(str::to_lowercase),
        info.get("allowed").and_then(Value::as_bool),
    ) {
        let exact = info.get("exact").and_then(Value::as_bool) == Some(true);
        let mut kept: Vec<String> = next
            .allowed_hosts
            .iter()
            .filter(|domain| {
                if allowed || exact {
                    **domain != host
                } else {
                    !covers(domain, &host)
                }
            })
            .cloned()
            .collect();
        if allowed {
            kept.push(host);
        }
        kept.sort();
        next.allowed_hosts = kept;
    }
    if let (Some(list), Some(on), Some(lists)) = (
        info.get("list")
            .and_then(Value::as_str)
            .map(str::to_lowercase),
        info.get("listEnabled").and_then(Value::as_bool),
        next.lists.as_mut(),
    ) {
        lists.retain(|item| *item != list);
        if on {
            lists.push(list);
        }
        lists.sort();
    }
    next
}

pub fn read_settings(base: &Path) -> Settings {
    std::fs::read(base.join("settings.json"))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

pub fn write_settings(base: &Path, settings: &Settings) {
    let Ok(data) = serde_json::to_vec(settings) else {
        return;
    };
    let _ = std::fs::create_dir_all(base);
    let path = base.join("settings.json");
    let partial = base.join(".settings.json.partial");
    if std::fs::write(&partial, data).is_ok() && std::fs::rename(&partial, &path).is_err() {
        let _ = std::fs::remove_file(&partial);
    }
}

pub fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_lowercase))
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
pub use mac::{
    attach, configure, pass_strict, state, strict_blocks, user_filters_text, when_ready,
};

#[cfg(target_os = "macos")]
pub fn start(data_dir: Option<&Path>, resources: Option<PathBuf>) {
    mac::start(data_dir, resources);
}

#[cfg(target_os = "macos")]
pub fn settings_changed(info: Value) {
    mac::settings_changed(info);
}

#[cfg(target_os = "macos")]
pub fn is_filtering() -> bool {
    mac::is_filtering()
}

#[cfg(target_os = "macos")]
pub fn blocking_enabled() -> bool {
    mac::blocking_enabled()
}

#[cfg(target_os = "macos")]
pub fn host_trusted(host: &str) -> bool {
    mac::host_trusted(host)
}

#[cfg(not(target_os = "macos"))]
pub fn start(data_dir: Option<&Path>, resources: Option<PathBuf>) {
    let _ = (data_dir, resources);
}

#[cfg(not(target_os = "macos"))]
pub fn settings_changed(info: Value) {
    let _ = info;
}

#[cfg(not(target_os = "macos"))]
pub fn is_filtering() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn blocking_enabled() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn host_trusted(host: &str) -> bool {
    let _ = host;
    false
}

#[cfg(not(target_os = "macos"))]
pub fn user_filters_text(text: String) {
    let _ = text;
}

#[cfg(not(target_os = "macos"))]
pub fn state() -> Value {
    Value::Null
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn native_classes_match_their_protocols() {
        use objc2::ClassType as _;
        crate::webkit::native_audit::assert_conforms(
            super::scripts::Lookup::class(),
            &[c"WKScriptMessageHandlerWithReply"],
        );
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn covers_matches_the_host_and_its_subdomains() {
        assert!(covers("example.com", "example.com"));
        assert!(covers(".Example.com.", "a.example.com"));
        assert!(!covers("example.com", "badexample.com"));
        assert!(!covers("", "example.com"));
        let settings = Settings {
            allowed_hosts: vec!["news.com".into()],
            ..Settings::default()
        };
        assert!(trusted(&settings, "www.news.com"));
        assert!(!trusted(&settings, ""));
    }

    #[test]
    fn key_matches_the_old_apps_compiled_store() {
        let bundled_path = Path::new("/Applications/Ardia.app/Contents/Resources/ContentRules");
        let Some(bundled) = Bundled::read(bundled_path) else {
            return;
        };
        if bundled.digest.as_deref() != Some("543d8556d0c35b22") {
            return;
        }
        let settings = Settings {
            lists: Some(
                [
                    "easylist",
                    "easyprivacy",
                    "plowe-0",
                    "ublock-badware",
                    "ublock-filters",
                    "ublock-privacy",
                    "ublock-quick-fixes",
                    "ublock-unbreak",
                    "urlhaus-1",
                ]
                .map(str::to_owned)
                .to_vec(),
            ),
            ..Settings::default()
        };
        let wanted = wanted_rulesets(Some(&bundled), &settings);
        assert_eq!(
            key(Some(&bundled), &wanted, None),
            "543d8556d0c35b22-f6-7a4c9d1bdef1"
        );
        assert_eq!(assemble(&wanted, bundled_path, &[]).len(), 18);
    }

    #[test]
    fn rulesets_follow_chosen_lists_through_their_sources() {
        let bundled = Bundled {
            version: "v".into(),
            digest: None,
            scriptlet_secret: None,
            rulesets: ["ublock-filters", "pgl", "easylist", "annoyances-cookies"]
                .iter()
                .enumerate()
                .map(|(i, id)| Ruleset {
                    id: (*id).into(),
                    enabled: i == 2,
                    scriptlets: None,
                })
                .collect(),
        };
        assert_eq!(
            wanted_rulesets(Some(&bundled), &Settings::default()),
            vec!["easylist"]
        );
        let settings = Settings {
            lists: Some(vec!["plowe-0".into(), "adguard-cookies".into()]),
            ..Settings::default()
        };
        assert_eq!(
            wanted_rulesets(Some(&bundled), &settings),
            vec!["pgl", "annoyances-cookies"]
        );
        assert!(key(Some(&bundled), &["b".into(), "a".into()], None).starts_with("v-f6-"));
        assert_eq!(
            key(None, &["a".into(), "b".into()], None),
            key(None, &["b".into(), "a".into()], None)
        );
        assert_ne!(
            key(None, &["a".into()], Some("u")),
            key(None, &["a".into()], None)
        );
    }

    #[test]
    fn stored_lists_are_reused_only_when_complete() {
        let key = "k-f6-abc";
        let all = identifiers(key, 2);
        assert_eq!(all[1], "ardia-ubol-k-f6-abc-1of2");
        assert_eq!(complete_set(key, &all), Some(all.clone()));
        assert_eq!(complete_set(key, &all[..1]), None);
        let mut extra = all.clone();
        extra.push("ardia-ubol-k-f6-abc-0of3".into());
        assert_eq!(complete_set(key, &extra), None);
        let current: BTreeSet<String> = all.iter().cloned().collect();
        let available = vec![
            all[0].clone(),
            "ardia-ubol-old-f6-1-0of1".into(),
            "ardia-ubol-prev-f6-2-0of1".into(),
            "other".into(),
        ];
        assert_eq!(
            stale(&available, &current, "prev-f6-2"),
            vec!["ardia-ubol-old-f6-1-0of1".to_owned()]
        );
    }

    #[test]
    fn changes_follow_the_old_notification_fields() {
        let settings = Settings {
            lists: Some(vec!["easylist".into()]),
            allowed_hosts: vec!["a.com".into(), "news.com".into()],
            ..Settings::default()
        };
        let next = note_change(
            &settings,
            &json!({"host": "www.news.com", "allowed": false}),
        );
        assert_eq!(next.allowed_hosts, vec!["a.com"]);
        let next = note_change(&settings, &json!({"host": "B.com", "allowed": true}));
        assert_eq!(next.allowed_hosts, vec!["a.com", "b.com", "news.com"]);
        let next = note_change(&settings, &json!({"list": "PGL", "listEnabled": true}));
        assert_eq!(next.lists, Some(vec!["easylist".into(), "pgl".into()]));
        let next = note_change(
            &settings,
            &json!({"enabled": false, "lists": ["Z", "a"], "allowedHosts": []}),
        );
        assert!(!next.enabled);
        assert_eq!(next.lists, Some(vec!["a".into(), "z".into()]));
        assert!(next.allowed_hosts.is_empty());
        let dir = tempfile::tempdir().unwrap();
        write_settings(dir.path(), &next);
        assert_eq!(read_settings(dir.path()), next);
        assert_eq!(
            read_settings(&dir.path().join("missing")),
            Settings::default()
        );
    }
}
