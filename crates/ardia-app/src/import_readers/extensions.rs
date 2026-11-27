use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

pub const WEB_STORE_DETAIL: &str = "https://chromewebstore.google.com/detail/";
const NOT_OFFERED: [&str; 2] = [
    "cjpalhdlnbpafiamejdnhcphjbkeiagm",
    "ddkjiahejlhfcafbddmgiahcphecmpfh",
];
const INTERNAL_LOCATION: i64 = 1;
const UNPACKED_LOCATIONS: [i64; 2] = [4, 8];
const POLICY_LOCATIONS: [i64; 2] = [7, 9];
const EXTERNAL_LOCATIONS: [i64; 3] = [2, 3, 6];
const COMPONENT_LOCATIONS: [i64; 2] = [5, 10];
const USER_ACTION: i64 = 1;
const UNSUPPORTED_MANIFEST_VERSION: i64 = 1 << 23;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Skip {
    ManifestV2,
    Unpacked,
    Policy,
    External,
    NotWebStore,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedExtension {
    pub id: String,
    pub name: String,
    pub web_store_url: String,
    pub enabled: bool,
    pub pinned_index: Option<usize>,
    pub skip: Option<Skip>,
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn json_int(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) if n.is_i64() || n.is_u64() => n.as_i64(),
        _ => None,
    }
}

pub fn is_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

pub fn disable_reasons(entry: &Map<String, Value>) -> HashSet<i64> {
    if let Some(list) = entry.get("disable_reasons").and_then(Value::as_array) {
        return list.iter().filter_map(|v| json_int(Some(v))).collect();
    }
    if let Some(mask) = json_int(entry.get("disable_reasons")).filter(|m| *m != 0) {
        return (0..31)
            .map(|bit| 1i64 << bit)
            .filter(|bit| mask & bit != 0)
            .collect();
    }
    if json_int(entry.get("state")) == Some(0) {
        return HashSet::from([USER_ACTION]);
    }
    HashSet::new()
}

fn skip(
    location: Option<i64>,
    entry: &Map<String, Value>,
    manifest: Option<&Map<String, Value>>,
    reasons: &HashSet<i64>,
) -> Option<Skip> {
    let Some(location) = location else {
        return Some(Skip::NotWebStore);
    };
    if UNPACKED_LOCATIONS.contains(&location) {
        return Some(Skip::Unpacked);
    }
    if POLICY_LOCATIONS.contains(&location) {
        return Some(Skip::Policy);
    }
    if EXTERNAL_LOCATIONS.contains(&location) {
        return Some(Skip::External);
    }
    if location != INTERNAL_LOCATION
        || entry.get("from_webstore").and_then(Value::as_bool) != Some(true)
    {
        return Some(Skip::NotWebStore);
    }
    if json_int(manifest.and_then(|m| m.get("manifest_version"))) == Some(2)
        || reasons.contains(&UNSUPPORTED_MANIFEST_VERSION)
    {
        return Some(Skip::ManifestV2);
    }
    None
}

fn manifest_of(
    entry: &Map<String, Value>,
    profile: &Path,
    unpacked: bool,
) -> (Option<Map<String, Value>>, Option<PathBuf>) {
    let mut manifest = entry.get("manifest").and_then(Value::as_object).cloned();
    let Some(path) = entry
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.contains(".."))
    else {
        return (manifest, None);
    };
    let folder = if path.starts_with('/') {
        if !unpacked {
            return (manifest, None);
        }
        PathBuf::from(path)
    } else {
        profile.join("Extensions").join(path)
    };
    if manifest.is_none() {
        manifest = read_json(&folder.join("manifest.json")).and_then(|v| v.as_object().cloned());
    }
    (manifest, Some(folder))
}

fn name_of(manifest: Option<&Map<String, Value>>, folder: Option<&Path>) -> Option<String> {
    let raw = manifest?.get("name")?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let Some(key) = raw
        .strip_prefix("__MSG_")
        .and_then(|k| k.strip_suffix("__"))
    else {
        return Some(raw.to_owned());
    };
    let key = key.to_lowercase();
    let locale = manifest?.get("default_locale")?.as_str()?;
    if locale.contains('/') || locale.contains("..") {
        return None;
    }
    let messages = read_json(&folder?.join("_locales").join(locale).join("messages.json"))?;
    messages
        .as_object()?
        .iter()
        .find(|(k, _)| k.to_lowercase() == key)?
        .1
        .get("message")?
        .as_str()
        .filter(|m| !m.is_empty())
        .map(str::to_owned)
}

pub fn list(profile: &Path) -> Vec<ImportedExtension> {
    let mut settings: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut pinned: Vec<String> = Vec::new();
    for file in ["Preferences", "Secure Preferences"] {
        let Some(root) = read_json(&profile.join(file)) else {
            continue;
        };
        let Some(extensions) = root.get("extensions").and_then(Value::as_object) else {
            continue;
        };
        if let Some(ids) = extensions
            .get("pinned_extensions")
            .and_then(Value::as_array)
        {
            pinned = ids
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
        }
        let Some(found) = extensions.get("settings").and_then(Value::as_object) else {
            continue;
        };
        for (id, value) in found {
            let Some(entry) = value.as_object() else {
                continue;
            };
            let merged = settings.entry(id.clone()).or_default();
            for (key, field) in entry {
                merged.insert(key.clone(), field.clone());
            }
        }
    }
    let mut out = Vec::new();
    for (id, entry) in &settings {
        if !is_extension_id(id) || NOT_OFFERED.contains(&id.as_str()) {
            continue;
        }
        let location = json_int(entry.get("location"));
        if location.is_some_and(|l| COMPONENT_LOCATIONS.contains(&l)) {
            continue;
        }
        let unpacked = location.is_some_and(|l| UNPACKED_LOCATIONS.contains(&l));
        let (manifest, folder) = manifest_of(entry, profile, unpacked);
        if manifest
            .as_ref()
            .is_some_and(|m| m.contains_key("theme") || m.contains_key("app"))
        {
            continue;
        }
        let reasons = disable_reasons(entry);
        out.push(ImportedExtension {
            id: id.clone(),
            name: name_of(manifest.as_ref(), folder.as_deref()).unwrap_or_else(|| id.clone()),
            web_store_url: format!("{WEB_STORE_DETAIL}{id}"),
            enabled: !reasons.contains(&USER_ACTION),
            pinned_index: pinned.iter().position(|p| p == id),
            skip: skip(location, entry, manifest.as_ref(), &reasons),
        });
    }
    out.sort_by_key(|e| e.name.to_lowercase());
    out
}

pub struct ExtensionGroup {
    pub profile_id: ardia_state::ProfileId,
    pub profile_name: String,
    pub list: Vec<ImportedExtension>,
}

pub fn plan_listing(
    source_name: &str,
    groups: &[ExtensionGroup],
    installed_in: impl Fn(&ardia_state::ProfileId) -> HashSet<String>,
) -> Option<ardia_ui::host_data::ExtensionListing> {
    use ardia_ui::host_data::{
        ExtensionListing, ExtensionTarget, LeftOutExtension, LeftOutReason, ListedExtension,
    };
    let mut targets: Vec<ExtensionTarget> = Vec::new();
    let mut left_out: Vec<LeftOutExtension> = Vec::new();
    let mut leave = |name: &str, reason: LeftOutReason| {
        if !left_out
            .iter()
            .any(|e| e.name == name && e.reason == reason)
        {
            left_out.push(LeftOutExtension {
                name: name.to_owned(),
                reason,
            });
        }
    };
    for group in groups {
        let installed = installed_in(&group.profile_id);
        let at = match targets
            .iter()
            .position(|t| t.profile_id == group.profile_id)
        {
            Some(at) => at,
            None => {
                targets.push(ExtensionTarget {
                    profile_id: group.profile_id.clone(),
                    profile_name: group.profile_name.clone(),
                    extensions: Vec::new(),
                });
                targets.len() - 1
            }
        };
        for extension in &group.list {
            let reason = match extension.skip {
                Some(Skip::ManifestV2) => Some(LeftOutReason::ManifestV2),
                Some(Skip::Unpacked) => Some(LeftOutReason::Unpacked),
                Some(Skip::Policy) => Some(LeftOutReason::Policy),
                Some(Skip::External) => Some(LeftOutReason::External),
                Some(Skip::NotWebStore) => Some(LeftOutReason::NotWebStore),
                None if !is_extension_id(&extension.id) => Some(LeftOutReason::NotWebStore),
                None if installed.contains(&extension.id) => Some(LeftOutReason::Installed),
                None => None,
            };
            match reason {
                Some(reason) => leave(&extension.name, reason),
                None => {
                    let target = &mut targets[at];
                    if !target.extensions.iter().any(|e| e.id == extension.id) {
                        target.extensions.push(ListedExtension {
                            id: extension.id.clone(),
                            name: extension.name.clone(),
                            web_store_url: format!("{WEB_STORE_DETAIL}{}", extension.id),
                            off_in_source: !extension.enabled,
                            pinned_in_source: extension.pinned_index.is_some(),
                        });
                    }
                }
            }
        }
    }
    let targets: Vec<ExtensionTarget> = targets
        .into_iter()
        .filter(|t| !t.extensions.is_empty())
        .map(|mut t| {
            t.extensions.sort_by_key(|e| e.name.to_lowercase());
            t
        })
        .collect();
    if targets.is_empty() && left_out.is_empty() {
        return None;
    }
    Some(ExtensionListing {
        source_name: source_name.to_owned(),
        targets,
        left_out,
        store_opened: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_readers::fixture;

    #[test]
    fn web_store_extensions_are_listed_with_their_names() {
        let list: Vec<ImportedExtension> = list(&fixture("extensions/Default"))
            .into_iter()
            .filter(|e| e.skip.is_none())
            .collect();
        let names: Vec<&str> = list.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Localized Blocker",
                "Older Chrome Keeps Manifests",
                "Plain Name"
            ]
        );
        assert_eq!(
            list[0].web_store_url,
            "https://chromewebstore.google.com/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert!(list.iter().all(|e| e.enabled && e.pinned_index.is_none()));
    }

    #[test]
    fn unpacked_extensions_are_marked_and_components_hidden() {
        let list = list(&fixture("extensions/Default"));
        let skipped: Vec<&str> = list
            .iter()
            .filter(|e| e.skip.is_some())
            .map(|e| e.id.as_str())
            .collect();
        assert_eq!(skipped, ["cccccccccccccccccccccccccccccccc"]);
        assert!(
            !list
                .iter()
                .any(|e| e.id == "dddddddddddddddddddddddddddddddd")
        );
    }

    #[test]
    fn each_extension_says_why_it_cant_come_from_the_web_store() {
        let list = list(&fixture("extensions/Mixed"));
        let by = |name: &str| list.iter().find(|e| e.name == name).cloned();
        assert_eq!(by("Clip Saver").map(|e| e.skip), Some(None));
        assert_eq!(by("Tab Notes").map(|e| e.skip), Some(None));
        assert_eq!(
            by("Old Toolbar").and_then(|e| e.skip),
            Some(Skip::ManifestV2)
        );
        assert_eq!(
            by("Flagged By Chrome").and_then(|e| e.skip),
            Some(Skip::ManifestV2)
        );
        assert_eq!(by("Dev Helper").and_then(|e| e.skip), Some(Skip::Unpacked));
        assert_eq!(by("Company SSO").and_then(|e| e.skip), Some(Skip::Policy));
        assert_eq!(
            by("Password Helper").and_then(|e| e.skip),
            Some(Skip::External)
        );
        assert_eq!(
            by("Dragged In").and_then(|e| e.skip),
            Some(Skip::NotWebStore)
        );
        assert_eq!(
            by("No Location").and_then(|e| e.skip),
            Some(Skip::NotWebStore)
        );
        assert!(by("A Theme").is_none());
        assert!(by("Built In").is_none());
        assert_eq!(by("Clip Saver").map(|e| e.enabled), Some(true));
        assert_eq!(by("Tab Notes").map(|e| e.enabled), Some(false));
        assert_eq!(by("Old Off").map(|e| e.enabled), Some(false));
        assert_eq!(by("Legacy Mask Off").map(|e| e.enabled), Some(false));
        assert_eq!(by("Reloading").map(|e| e.enabled), Some(true));
        assert_eq!(by("Tab Notes").and_then(|e| e.pinned_index), Some(0));
        assert_eq!(by("Clip Saver").and_then(|e| e.pinned_index), Some(1));
    }

    #[test]
    fn helium_lists_store_installs_but_not_its_built_in_ublock() {
        let list = list(&fixture("extensions/Helium"));
        assert_eq!(
            list.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["Dark Reader"]
        );
        assert_eq!(list[0].skip, None);
        assert!(super::list(&fixture("extensions/UBlockOnly")).is_empty());
        assert!(super::list(&fixture("extensions/Nope")).is_empty());
    }

    #[test]
    fn the_listing_offers_store_installs_and_says_why_others_are_left_out() {
        use ardia_ui::host_data::LeftOutReason;
        let profile = ardia_state::ProfileId::new("p1");
        let groups = vec![ExtensionGroup {
            profile_id: profile,
            profile_name: "Work".into(),
            list: list(&fixture("extensions/Mixed")),
        }];
        let installed = HashSet::from([list(&fixture("extensions/Mixed"))
            .iter()
            .find(|e| e.name == "Clip Saver")
            .unwrap()
            .id
            .clone()]);
        let listing = plan_listing("Chrome", &groups, |_| installed.clone()).unwrap();
        let names: Vec<&str> = listing.targets[0]
            .extensions
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert!(names.contains(&"Tab Notes"));
        assert!(!names.contains(&"Clip Saver"));
        assert_eq!(listing.targets[0].profile_name, "Work");
        assert!(
            listing
                .left_out
                .iter()
                .any(|e| e.name == "Clip Saver" && e.reason == LeftOutReason::Installed)
        );
        assert!(
            listing
                .left_out
                .iter()
                .any(|e| e.name == "Dev Helper" && e.reason == LeftOutReason::Unpacked)
        );
        let notes = listing.targets[0]
            .extensions
            .iter()
            .find(|e| e.name == "Tab Notes")
            .unwrap();
        assert_eq!(
            ardia_ui::host_data::source_notes(notes, "Chrome"),
            "off and pinned in Chrome"
        );
        assert!(plan_listing("Chrome", &[], |_| HashSet::new()).is_none());
    }

    #[test]
    fn both_forms_of_disable_reasons_decode() {
        let list: Map<String, Value> =
            serde_json::from_str(r#"{"disable_reasons":[2,8388608]}"#).unwrap();
        assert_eq!(disable_reasons(&list), HashSet::from([2, 1 << 23]));
        let mask: Map<String, Value> = serde_json::from_str(r#"{"disable_reasons":3}"#).unwrap();
        assert_eq!(disable_reasons(&mask), HashSet::from([1, 2]));
        let old: Map<String, Value> = serde_json::from_str(r#"{"state":0}"#).unwrap();
        assert_eq!(disable_reasons(&old), HashSet::from([USER_ACTION]));
    }
}
