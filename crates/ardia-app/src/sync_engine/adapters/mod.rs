pub mod app;
pub mod bookmarks;
pub mod data_engine;
pub mod extensions;
pub mod history;
pub mod passwords;
pub mod pinned;
pub mod settings;
pub mod tabs;
#[cfg(test)]
mod tests_support;

use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;

use ardia_state::ProfileId;
use ardia_state::sync::SyncDoc;
use ardia_state::sync_engine::scope::{
    Adapter, ApplyRecords, ExtractContext, Extraction, SyncRecord,
};
use ardia_state::sync_engine::{IndexMap, IndexSet};
use parking_lot::Mutex;
use serde_json::{Map, Value};

use super::host::SyncHost;

pub const SHARE: &str = "share:";
pub const DEVICE: &str = "dev:";
pub const DEVICE_TABS: &str = "tabs:";
pub const PROFILE: &str = "prof:";
pub const PROFILE_THEME: &str = "pth:";
pub const PROFILE_TOP_APPS: &str = "pta:";
pub const PROFILE_OPEN_TABS: &str = "ptab:";
pub const BOOKMARK: &str = "bm:";
pub const HISTORY: &str = "h:";
pub const SEND: &str = "send:";
pub const RECEIVES_TABS: &str = "send";

pub fn record_id<'a>(prefix: &str, key: &'a str) -> &'a str {
    key.get(prefix.len()..).unwrap_or_default()
}

#[derive(Default)]
pub struct AdapterMemory {
    slots: HashMap<String, Box<dyn Any + Send>>,
}

impl AdapterMemory {
    pub fn slot<T: Any + Send + Default>(&mut self, name: &str) -> &mut T {
        let entry = self
            .slots
            .entry(name.to_owned())
            .or_insert_with(|| Box::new(T::default()));
        if !entry.is::<T>() {
            *entry = Box::new(T::default());
        }
        entry.downcast_mut::<T>().expect("the slot holds this type")
    }

    pub fn clear(&mut self) {
        self.slots.clear();
    }
}

#[derive(Clone)]
pub struct CycleContext {
    pub host: SyncHost,
    pub doc: Arc<Mutex<SyncDoc>>,
    pub device_id: String,
    pub device_name: String,
    pub app_records: Arc<IndexMap<String, SyncRecord>>,
    pub memory: Arc<Mutex<AdapterMemory>>,
    pub details: DeviceDetails,
    pub removed_profile_keys: Arc<std::collections::HashSet<String>>,
    pub removed_device_keys: Arc<std::collections::HashSet<String>>,
    pub keys: Option<Arc<ardia_state::sync_engine::sync_core::SyncKeys>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeviceDetails {
    pub version: Option<String>,
    pub os: Option<String>,
}

impl CycleContext {
    pub fn types_synced(&self, data_type: &str) -> bool {
        self.doc
            .lock()
            .types
            .get(data_type)
            .copied()
            .unwrap_or(false)
    }

    pub fn type_synced(&self, data_type: &str, profile: &ProfileId) -> bool {
        let owns_data = self
            .host
            .state()
            .profiles
            .get(profile)
            .is_none_or(|p| p.data_id.is_none());
        type_synced_for(&self.doc.lock(), data_type, owns_data)
    }

    pub fn link_extra(&self, profile: &ProfileId, key: &str) -> Option<Value> {
        self.doc
            .lock()
            .profiles
            .get(profile.as_str())
            .and_then(|link| link.extra.get(key).cloned())
    }

    pub fn set_link_extra(&self, profile: &ProfileId, key: &str, value: Option<Value>) {
        let mut doc = self.doc.lock();
        if let Some(link) = doc.profiles.get_mut(profile.as_str()) {
            match value {
                Some(value) => {
                    link.extra.insert(key.to_owned(), value);
                }
                None => {
                    link.extra.shift_remove(key);
                }
            }
        }
    }

    pub fn doc_extra(&self, key: &str) -> Option<Value> {
        self.doc.lock().extra.get(key).cloned()
    }

    pub fn edit_doc_extra(&self, key: &str, edit: impl FnOnce(&mut Map<String, Value>)) {
        let mut doc = self.doc.lock();
        let mut map = doc
            .extra
            .get(key)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        edit(&mut map);
        if map.is_empty() {
            doc.extra.shift_remove(key);
        } else {
            doc.extra.insert(key.to_owned(), Value::Object(map));
        }
    }
}

pub fn type_synced_for(doc: &SyncDoc, data_type: &str, owns_data: bool) -> bool {
    let profile_data = matches!(
        data_type,
        "bookmarks" | "history" | "passwords" | "extensions"
    );
    doc.types.get(data_type).copied().unwrap_or(false) && (owns_data || !profile_data)
}

const LEGACY_URLS: [(&str, &str); 3] = [
    ("netnyahoo://yahu", "ardia://game"),
    ("chrome://yahu", "chrome://game"),
    ("netnyahoo://", "ardia://"),
];

const LEGACY_KEYS: [(&str, &str); 4] = [
    ("openLinksInSmallYahu", "openLinksInLittleArdia"),
    ("smallYahuSize", "littleArdiaSize"),
    ("newSmallYahu", "newLittleArdia"),
    ("toggleOpenLinksInSmallYahu", "toggleOpenLinksInLittleArdia"),
];

pub fn from_legacy_url(url: &str) -> String {
    let lower = url.to_lowercase();
    for prefix in ["", "view-source:"] {
        for (old, now) in LEGACY_URLS {
            let full = format!("{prefix}{old}");
            if !lower.starts_with(&full) || url.len() < full.len() {
                continue;
            }
            let rest = &url[full.len()..];
            if !old.ends_with("://") && !rest.is_empty() && !rest.starts_with(['/', '?', '#']) {
                continue;
            }
            return format!("{}{now}{rest}", &url[..prefix.len()]);
        }
    }
    url.to_owned()
}

pub fn from_legacy(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(from_legacy_url(s)),
        Value::Array(list) => Value::Array(list.iter().map(from_legacy).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, v) in map {
                let name = LEGACY_KEYS
                    .iter()
                    .find(|(old, _)| old == key)
                    .map_or(key.as_str(), |(_, now)| now);
                if name != key && map.contains_key(name) {
                    continue;
                }
                out.insert(name.to_owned(), from_legacy(v));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

pub struct InTodaysNames<A: Adapter>(pub A);

impl<A: Adapter> Adapter for InTodaysNames<A> {
    fn prefix(&self) -> &str {
        self.0.prefix()
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        self.0.extract(cx)
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        records: &ApplyRecords,
    ) -> bool {
        let renamed: IndexMap<String, Value> = visible
            .iter()
            .map(|(k, v)| (k.clone(), from_legacy(v)))
            .collect();
        self.0.apply(&renamed, changed, records)
    }

    fn edited_at(&self, value: &Value) -> Option<i64> {
        self.0.edited_at(value)
    }

    fn extracts_only_from(&self) -> Option<u64> {
        self.0.extracts_only_from()
    }

    fn adopt_remote_on_join(&self) -> bool {
        self.0.adopt_remote_on_join()
    }

    fn publish_after_pull(&self) -> bool {
        self.0.publish_after_pull()
    }

    fn extract_uses_base(&self) -> bool {
        self.0.extract_uses_base()
    }

    fn saves_whole(&self) -> bool {
        self.0.saves_whole()
    }
}

pub fn app_adapters(cx: &CycleContext, retiring: bool) -> Vec<Box<dyn Adapter>> {
    if retiring {
        return vec![Box::new(app::DeviceAdapter::new(cx, true))];
    }
    let mut list: Vec<Box<dyn Adapter>> = Vec::new();
    if cx.types_synced("settings") {
        list.push(settings::adapter(cx));
    }
    list.push(Box::new(app::SharedDataAdapter::new(cx)));
    list.push(Box::new(app::ProfilesAdapter::new(cx)));
    list.push(Box::new(app::ProfileThemesAdapter::new(cx)));
    list.push(Box::new(app::ProfileFlagAdapter::top_apps(cx)));
    list.push(Box::new(app::ProfileFlagAdapter::open_tabs(cx)));
    list.push(Box::new(app::DeviceAdapter::new(cx, false)));
    list
}

pub fn profile_adapters(
    cx: &CycleContext,
    profile: &ProfileId,
    retiring: bool,
    force_passwords: bool,
) -> Vec<Box<dyn Adapter>> {
    if retiring {
        return vec![Box::new(tabs::DeviceTabsAdapter::new(cx, profile, true))];
    }
    let mut list: Vec<Box<dyn Adapter>> = Vec::new();
    list.extend(pinned::adapters(
        cx,
        profile,
        cx.type_synced("pinned", profile),
    ));
    if cx.type_synced("bookmarks", profile) {
        list.push(bookmarks::adapter(cx, profile));
    }
    if cx.type_synced("history", profile) {
        list.push(history::adapter(cx, profile));
    }
    list.push(Box::new(InTodaysNames(tabs::DeviceTabsAdapter::new(
        cx,
        profile,
        !cx.type_synced("tabs", profile),
    ))));
    list.push(Box::new(tabs::SentTabsAdapter::new(cx, profile)));
    if cx.type_synced("passwords", profile) {
        list.push(passwords::adapter(cx, profile, force_passwords));
    }
    if cx.type_synced("extensions", profile) {
        list.extend(extensions::adapter(cx, profile));
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn old_names_read_as_todays() {
        assert_eq!(from_legacy_url("netnyahoo://yahu/x"), "ardia://game/x");
        assert_eq!(from_legacy_url("netnyahoo://yahuz"), "ardia://yahuz");
        assert_eq!(
            from_legacy_url("view-source:netnyahoo://settings"),
            "view-source:ardia://settings"
        );
        assert_eq!(
            from_legacy(&json!({"smallYahuSize": 3, "u": "chrome://yahu"})),
            json!({"littleArdiaSize": 3, "u": "chrome://game"})
        );
        assert_eq!(
            from_legacy(&json!({"smallYahuSize": 3, "littleArdiaSize": 4})),
            json!({"littleArdiaSize": 4})
        );
    }
}
