use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ardia_state::ProfileId;
use ardia_state::actions::{Action, ProfilePatch};
use ardia_state::ids::DEFAULT_PROFILE_ID;
use ardia_state::sync::ProfileLink;
use ardia_state::sync_engine::canonical;
use ardia_state::sync_engine::scope::{Adapter, ApplyRecords, ExtractContext, Extraction};
use ardia_state::sync_engine::{IndexMap, IndexSet};
use ardia_theme::ProfileColor;
use serde_json::{Map, Value, json};

use super::{
    CycleContext, DEVICE, PROFILE, PROFILE_OPEN_TABS, PROFILE_THEME, PROFILE_TOP_APPS,
    RECEIVES_TABS, SHARE,
};
use crate::sync_engine::links::{
    ThemeChoice, angles_of, legacy_theme_of, look_patch, profile_record, theme_angle_key,
    theme_from_record, without_angles,
};

fn ignoring(mine: HashSet<String>, gone: Arc<HashSet<String>>) -> impl Fn(&str) -> bool + 'static {
    move |key: &str| !mine.contains(key) && !gone.contains(key)
}

fn enabled_links(cx: &CycleContext) -> Vec<(ProfileId, ProfileLink)> {
    let state = cx.host.state();
    cx.doc
        .lock()
        .profiles
        .iter()
        .filter(|(id, link)| {
            link.enabled && state.profiles.contains_key(&ProfileId::new(id.as_str()))
        })
        .map(|(id, link)| (ProfileId::new(id.as_str()), link.clone()))
        .collect()
}

fn with_shared_owners(
    cx: &CycleContext,
    shown: Vec<(ProfileId, ProfileLink)>,
) -> Vec<(ProfileId, ProfileLink)> {
    let state = cx.host.state();
    let doc = cx.doc.lock();
    let shown_ids: HashSet<ProfileId> = shown.iter().map(|(id, _)| id.clone()).collect();
    let mut out = shown.clone();
    for (id, _) in &shown {
        let Some(owner) = state.profiles.get(id).and_then(|p| p.data_id.clone()) else {
            continue;
        };
        let owner_id = ProfileId::new(owner.as_str());
        if owner_id == *id
            || shown_ids.contains(&owner_id)
            || out.iter().any(|(o, _)| *o == owner_id)
        {
            continue;
        }
        if let Some(link) = doc.profiles.get(owner.as_str())
            && state.profiles.contains_key(&owner_id)
        {
            out.push((owner_id, link.clone()));
        }
    }
    out
}

pub struct DeviceAdapter {
    key: String,
    retired: bool,
    record: Value,
    removed: Arc<HashSet<String>>,
}

impl DeviceAdapter {
    pub fn new(cx: &CycleContext, retired: bool) -> Self {
        let order: Vec<Value> = {
            let state = cx.host.state();
            let doc = cx.doc.lock();
            state
                .profile_order
                .iter()
                .filter_map(|id| {
                    doc.profiles
                        .get(id.as_str())
                        .filter(|l| l.enabled)
                        .map(|l| Value::String(l.sync_id.clone()))
                })
                .collect()
        };
        let mut record = Map::new();
        record.insert("n".into(), Value::String(cx.device_name.clone()));
        record.insert("k".into(), Value::String("mac".into()));
        record.insert("f".into(), json!([RECEIVES_TABS]));
        if let Some(v) = &cx.details.version {
            record.insert("v".into(), Value::String(v.clone()));
        }
        if let Some(os) = &cx.details.os {
            record.insert("os".into(), Value::String(os.clone()));
        }
        if !order.is_empty() {
            record.insert("o".into(), Value::Array(order));
        }
        DeviceAdapter {
            key: format!("{DEVICE}{}", cx.device_id),
            retired,
            record: Value::Object(record),
            removed: if retired {
                Arc::new(HashSet::new())
            } else {
                cx.removed_device_keys.clone()
            },
        }
    }
}

impl Adapter for DeviceAdapter {
    fn prefix(&self) -> &str {
        DEVICE
    }

    fn extract(&mut self, _cx: &ExtractContext) -> Option<Extraction> {
        let mut values = IndexMap::new();
        if !self.retired {
            values.insert(self.key.clone(), self.record.clone());
        }
        let mine = self.key.clone();
        let gone = self.removed.clone();
        Some(Extraction::of(values).ignoring(move |key| key != mine && !gone.contains(key)))
    }

    fn apply(
        &mut self,
        _visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        true
    }
}

pub struct SharedDataAdapter {
    cx: CycleContext,
}

impl SharedDataAdapter {
    pub fn new(cx: &CycleContext) -> Self {
        SharedDataAdapter { cx: cx.clone() }
    }
}

impl Adapter for SharedDataAdapter {
    fn prefix(&self) -> &str {
        SHARE
    }

    fn adopt_remote_on_join(&self) -> bool {
        true
    }

    fn publish_after_pull(&self) -> bool {
        true
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let state = self.cx.host.state();
        let all = self.cx.doc.lock().profiles.clone();
        let synced = |id: &str| {
            state.profiles.contains_key(&ProfileId::new(id))
                && all
                    .get(id)
                    .is_some_and(|l| l.enabled && l.extra.get("retire") != Some(&Value::Bool(true)))
        };
        let mut values = IndexMap::new();
        for (id, link) in &all {
            let owner = state
                .profiles
                .get(&ProfileId::new(id.as_str()))
                .and_then(|p| p.data_id.clone());
            let Some(owner) = owner else { continue };
            if !synced(id)
                || owner == *id
                || !all.contains_key(&owner)
                || !state.profiles.contains_key(&ProfileId::new(owner.as_str()))
            {
                continue;
            }
            let key = format!("{SHARE}{}", link.sync_id);
            let removed_elsewhere = cx.known(&key) && cx.remote(&key).is_some_and(Value::is_null);
            if removed_elsewhere || !cx.known(&key) {
                values.insert(key, json!({ "o": all[&owner].sync_id }));
            }
        }
        let mine: HashSet<String> = values.keys().cloned().collect();
        Some(Extraction::of(values).ignoring(ignoring(mine, self.cx.removed_profile_keys.clone())))
    }

    fn apply(
        &mut self,
        _visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        true
    }
}

pub struct ProfilesAdapter {
    cx: CycleContext,
}

impl ProfilesAdapter {
    pub fn new(cx: &CycleContext) -> Self {
        ProfilesAdapter { cx: cx.clone() }
    }
}

impl Adapter for ProfilesAdapter {
    fn prefix(&self) -> &str {
        PROFILE
    }

    fn adopt_remote_on_join(&self) -> bool {
        true
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let state = self.cx.host.state();
        let all = self.cx.doc.lock().profiles.clone();
        let mut values = IndexMap::new();
        for (id, link) in with_shared_owners(&self.cx, enabled_links(&self.cx)) {
            let Some(profile) = state.profiles.get(&id) else {
                continue;
            };
            let shares_synced = profile.data_id.as_ref().is_some_and(|owner| {
                *owner != *id.as_str()
                    && all.contains_key(owner)
                    && state.profiles.contains_key(&ProfileId::new(owner.as_str()))
            });
            if shares_synced && !cx.known(&format!("{SHARE}{}", link.sync_id)) {
                continue;
            }
            let mut record = Map::new();
            record.insert("n".into(), Value::String(profile.name.clone()));
            record.insert("c".into(), Value::String(profile.color.key().to_owned()));
            record.insert(
                "i".into(),
                profile.icon.clone().map_or(Value::Null, Value::String),
            );
            if id.as_str() == DEFAULT_PROFILE_ID {
                record.insert("d".into(), Value::Bool(true));
            }
            values.insert(format!("{PROFILE}{}", link.sync_id), Value::Object(record));
        }
        let mine: HashSet<String> = values.keys().cloned().collect();
        Some(Extraction::of(values).ignoring(ignoring(mine, self.cx.removed_profile_keys.clone())))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        records: &ApplyRecords,
    ) -> bool {
        let state = self.cx.host.state();
        let themed: HashSet<ProfileId> = enabled_links(&self.cx)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        for (id, link) in with_shared_owners(&self.cx, enabled_links(&self.cx)) {
            let key = format!("{PROFILE}{}", link.sync_id);
            let Some(record) = profile_record(visible.get(&key)) else {
                continue;
            };
            if !changed.contains(&key) {
                continue;
            }
            let Some(profile) = state.profiles.get(&id) else {
                continue;
            };
            let theme_key = format!("{PROFILE_THEME}{}", link.sync_id);
            let legacy = if profile.theme.is_none() && !records.known(&theme_key) {
                legacy_theme_of(&record)
            } else {
                None
            };
            let synced_color = ProfileColor::from_key(&record.c);
            let mut patch = ProfilePatch {
                name: Some(record.n.clone()),
                icon: Some(record.i),
                ..ProfilePatch::default()
            };
            if legacy.is_some() || !themed.contains(&id) {
                let look = look_patch(legacy, synced_color);
                patch.color = look.color;
                patch.theme = look.theme;
            } else if synced_color.is_some_and(|c| c != profile.color.preset()) {
                let synced = records
                    .record(&theme_key)
                    .map(|r| r.v.clone())
                    .filter(|v| !v.is_null());
                let look = synced.as_ref().and_then(|v| {
                    theme_from_record(
                        Some(v),
                        records
                            .record(&theme_angle_key(&link.sync_id))
                            .map(|r| &r.v),
                    )
                });
                let look = look_patch(look, synced_color);
                patch.color = look.color;
                patch.theme = look.theme;
            }
            let _ = self
                .cx
                .host
                .dispatch(Action::UpdateProfile { profile: id, patch });
        }
        true
    }
}

pub struct ProfileThemesAdapter {
    cx: CycleContext,
}

impl ProfileThemesAdapter {
    pub fn new(cx: &CycleContext) -> Self {
        ProfileThemesAdapter { cx: cx.clone() }
    }
}

impl Adapter for ProfileThemesAdapter {
    fn prefix(&self) -> &str {
        PROFILE_THEME
    }

    fn adopt_remote_on_join(&self) -> bool {
        true
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let state = self.cx.host.state();
        let unapplied = |key: &str| {
            cx.remote(key).is_some_and(|v| {
                !v.is_null()
                    && canonical(v)
                        != cx
                            .base_json(key)
                            .map_or_else(|| "null".to_owned(), str::to_owned)
            })
        };
        let mut values = IndexMap::new();
        for (id, link) in enabled_links(&self.cx) {
            let Some(profile) = state.profiles.get(&id) else {
                continue;
            };
            if profile.theme.is_none() && !profile.theme_cleared {
                continue;
            }
            let key = format!("{PROFILE_THEME}{}", link.sync_id);
            let angle_key = theme_angle_key(&link.sync_id);
            let adopting = link.extra.get("themeAdopting") == Some(&Value::Bool(true));
            if adopting || unapplied(&key) || unapplied(&angle_key) {
                continue;
            }
            let (record, angles) = match profile.theme.as_ref() {
                Some(theme) => {
                    let Ok(theme) = serde_json::to_value(&**theme) else {
                        continue;
                    };
                    (json!({ "t": without_angles(&theme) }), angles_of(&theme))
                }
                None => (json!({ "preset": true }), json!({})),
            };
            values.insert(key, record);
            if angles.as_object().is_some_and(|a| !a.is_empty()) || cx.known(&angle_key) {
                values.insert(angle_key, angles);
            }
        }
        let mine: HashSet<String> = values.keys().cloned().collect();
        Some(Extraction::of(values).ignoring(ignoring(mine, self.cx.removed_profile_keys.clone())))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        for (id, link) in enabled_links(&self.cx) {
            let key = format!("{PROFILE_THEME}{}", link.sync_id);
            let angle_key = theme_angle_key(&link.sync_id);
            if !changed.contains(&key) && !changed.contains(&angle_key) {
                continue;
            }
            let Some(choice) = theme_from_record(visible.get(&key), visible.get(&angle_key)) else {
                continue;
            };
            let patch = ProfilePatch {
                theme: Some(match choice {
                    ThemeChoice::Preset => None,
                    ThemeChoice::Custom(theme) => Some(theme),
                }),
                ..ProfilePatch::default()
            };
            let _ = self
                .cx
                .host
                .dispatch(Action::UpdateProfile { profile: id, patch });
        }
        true
    }
}

#[derive(Clone, Copy)]
enum Flag {
    TopApps,
    OpenTabs,
}

pub struct ProfileFlagAdapter {
    cx: CycleContext,
    flag: Flag,
}

impl ProfileFlagAdapter {
    pub fn top_apps(cx: &CycleContext) -> Self {
        ProfileFlagAdapter {
            cx: cx.clone(),
            flag: Flag::TopApps,
        }
    }

    pub fn open_tabs(cx: &CycleContext) -> Self {
        ProfileFlagAdapter {
            cx: cx.clone(),
            flag: Flag::OpenTabs,
        }
    }

    fn on(&self, profile: &ardia_state::profiles::Profile) -> bool {
        match self.flag {
            Flag::TopApps => profile.share_top_apps,
            Flag::OpenTabs => profile.sync_tabs,
        }
    }
}

impl Adapter for ProfileFlagAdapter {
    fn prefix(&self) -> &str {
        match self.flag {
            Flag::TopApps => PROFILE_TOP_APPS,
            Flag::OpenTabs => PROFILE_OPEN_TABS,
        }
    }

    fn adopt_remote_on_join(&self) -> bool {
        true
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let state = self.cx.host.state();
        let prefix = self.prefix().to_owned();
        let mut values = IndexMap::new();
        for (id, link) in enabled_links(&self.cx) {
            let Some(profile) = state.profiles.get(&id) else {
                continue;
            };
            let key = format!("{prefix}{}", link.sync_id);
            let on = self.on(profile);
            let unapplied = cx.known(&key)
                && cx.remote(&key).is_some_and(|v| {
                    !v.is_null()
                        && canonical(v)
                            != cx
                                .base_json(&key)
                                .map_or_else(|| "null".to_owned(), str::to_owned)
                });
            if (on || cx.known(&key)) && !unapplied {
                values.insert(key, json!({ "on": on }));
            }
        }
        let mine: HashSet<String> = values.keys().cloned().collect();
        Some(Extraction::of(values).ignoring(ignoring(mine, self.cx.removed_profile_keys.clone())))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        let prefix = self.prefix().to_owned();
        let mut patches: HashMap<ProfileId, bool> = HashMap::new();
        for (id, link) in enabled_links(&self.cx) {
            let key = format!("{prefix}{}", link.sync_id);
            if !changed.contains(&key) {
                continue;
            }
            if let Some(on) = visible
                .get(&key)
                .and_then(|v| v.get("on"))
                .and_then(Value::as_bool)
            {
                patches.insert(id, on);
            }
        }
        for (profile, on) in patches {
            let top_apps_changed = matches!(self.flag, Flag::TopApps)
                && self
                    .cx
                    .host
                    .state()
                    .profiles
                    .get(&profile)
                    .is_some_and(|found| found.share_top_apps != on);
            let patch = match self.flag {
                Flag::TopApps => ProfilePatch {
                    share_top_apps: Some(on),
                    ..ProfilePatch::default()
                },
                Flag::OpenTabs => ProfilePatch {
                    sync_tabs: Some(on),
                    ..ProfilePatch::default()
                },
            };
            let _ = self
                .cx
                .host
                .dispatch(Action::UpdateProfile { profile, patch });
            if top_apps_changed {
                crate::telemetry_events::note_top_apps_sharing_synced(
                    &self.cx.host.state(),
                    "synced_record",
                    on,
                );
            }
        }
        true
    }
}
