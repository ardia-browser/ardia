use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use ardia_state::actions::{Action, ProfilePatch};
use ardia_state::ids::DEFAULT_PROFILE_ID;
use ardia_state::sync::{ProfileLink, SyncDoc};
use ardia_state::sync_engine::canonical;
use ardia_state::sync_engine::scope::{ScopeState, holds_back, pull_settled};
use ardia_state::{BrowserState, ProfileId};
use ardia_theme::{ProfileColor, ProfileTheme};
use serde_json::{Map, Value, json};

use super::adapters::{
    DEVICE, PROFILE, PROFILE_OPEN_TABS, PROFILE_THEME, PROFILE_TOP_APPS, SHARE, record_id,
};
use super::files::{APP_SCOPE, Scopes, profile_scope};
use super::host::SyncHost;

pub const PAIRING_WAIT_MS: i64 = 86_400_000;
const RETIRE: &str = "retire";
const THEME_ADOPTING: &str = "themeAdopting";

pub fn theme_angle_key(sync_id: &str) -> String {
    format!("{PROFILE_THEME}{sync_id}:angle")
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProfileRecord {
    pub n: String,
    pub c: String,
    pub i: Option<String>,
    pub d: bool,
    pub th: Option<Value>,
}

pub fn profile_record(value: Option<&Value>) -> Option<ProfileRecord> {
    let v = value?.as_object()?;
    let n = v.get("n")?.as_str()?.to_owned();
    let c = v.get("c")?.as_str()?.to_owned();
    let i = match v.get("i") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return None,
    };
    let d = match v.get("d") {
        None => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return None,
    };
    if !matches!(v.get("o"), None | Some(Value::Bool(true))) {
        return None;
    }
    let th = match v.get("th") {
        None | Some(Value::Null) => None,
        Some(t @ Value::Object(_)) => Some(t.clone()),
        Some(_) => return None,
    };
    Some(ProfileRecord { n, c, i, d, th })
}

fn flag_record(value: Option<&Value>) -> Option<bool> {
    value?.as_object()?.get("on")?.as_bool()
}

fn app_value<'a>(scopes: &'a Scopes, key: &str) -> Option<&'a Value> {
    scopes.get(APP_SCOPE)?.records.get(key).map(|r| &r.v)
}

pub fn remote_profile_record(scopes: &Scopes, sync_id: &str) -> Option<ProfileRecord> {
    profile_record(app_value(scopes, &format!("{PROFILE}{sync_id}")))
}

fn shared_data_owner(scopes: &Scopes, sync_id: &str) -> Option<String> {
    let owner = app_value(scopes, &format!("{SHARE}{sync_id}"))?
        .as_object()?
        .get("o")?
        .as_str()?
        .to_owned();
    (owner != sync_id).then_some(owner)
}

pub fn linked_profile_id(doc: &SyncDoc, state: &BrowserState, sync_id: &str) -> Option<ProfileId> {
    doc.profiles
        .iter()
        .find(|(id, link)| {
            link.sync_id == sync_id
                && link.extra.get(RETIRE) != Some(&Value::Bool(true))
                && state.profiles.contains_key(&ProfileId::new(id.as_str()))
        })
        .map(|(id, _)| ProfileId::new(id.as_str()))
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Chain {
    pub adds: Vec<String>,
    pub shares_with: Option<ProfileId>,
    pub waiting_for: Option<String>,
}

pub fn shared_data_chain(
    doc: &SyncDoc,
    scopes: &Scopes,
    state: &BrowserState,
    sync_id: &str,
) -> Chain {
    let mut adds = vec![sync_id.to_owned()];
    let mut at = sync_id.to_owned();
    loop {
        let Some(owner) = shared_data_owner(scopes, &at) else {
            return Chain {
                adds,
                shares_with: None,
                waiting_for: None,
            };
        };
        if let Some(here) = linked_profile_id(doc, state, &owner) {
            return Chain {
                adds,
                shares_with: Some(here),
                waiting_for: None,
            };
        }
        if remote_profile_record(scopes, &owner).is_none() {
            return Chain {
                adds,
                shares_with: None,
                waiting_for: Some(owner),
            };
        }
        if let Some(start) = adds.iter().position(|a| *a == owner) {
            let mut cycle: Vec<&String> = adds[start..].iter().collect();
            cycle.sort();
            let lowest = cycle[0].clone();
            let end = adds.iter().position(|a| *a == lowest).unwrap_or(0);
            adds.truncate(end + 1);
            return Chain {
                adds,
                shares_with: None,
                waiting_for: None,
            };
        }
        adds.push(owner.clone());
        at = owner;
    }
}

fn pairing_overdue(doc: &SyncDoc, now: i64) -> bool {
    doc.setup_at.is_some_and(|at| now - at > PAIRING_WAIT_MS)
}

pub fn app_scope_of(doc: &mut SyncDoc, scopes: &mut Scopes, now: i64) {
    if !scopes.contains_key(APP_SCOPE) {
        let state = ScopeState {
            await_remote: doc.joining.then_some(true),
            ..ScopeState::default()
        };
        scopes.insert(APP_SCOPE.to_owned(), state);
    }
    if doc.joining
        && pairing_overdue(doc, now)
        && let Some(app) = scopes.get_mut(APP_SCOPE)
    {
        app.await_remote = None;
    }
}

pub fn ready_to_pair(doc: &SyncDoc, app: &ScopeState, now: i64) -> bool {
    if !doc.joining || pairing_overdue(doc, now) {
        return true;
    }
    let synced: Vec<ProfileRecord> = app
        .visible(PROFILE)
        .values()
        .filter_map(|v| profile_record(Some(v)))
        .collect();
    if synced.iter().any(|r| r.d) {
        return true;
    }
    !synced.is_empty() && !holds_back(app, now, PAIRING_WAIT_MS)
}

fn new_sync_id() -> String {
    ardia_state::sync_engine::sync_core::new_file_id()
        .unwrap_or_else(|_| uuid::Uuid::new_v4().simple().to_string().to_uppercase())
}

pub fn link_profiles(doc: &mut SyncDoc, scopes: &mut Scopes, host: &SyncHost) {
    let state = host.state();
    let remote: Vec<(String, ProfileRecord)> = scopes
        .get(APP_SCOPE)
        .map(|app| {
            app.visible(PROFILE)
                .iter()
                .filter_map(|(k, v)| {
                    profile_record(Some(v)).map(|r| (record_id(PROFILE, k).to_owned(), r))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut taken: HashSet<String> = doc.profiles.values().map(|l| l.sync_id.clone()).collect();
    for id in state.profile_order.iter() {
        let Some(profile) = state.profiles.get(id) else {
            continue;
        };
        if id.is_incognito() || doc.profiles.contains_key(id.as_str()) {
            continue;
        }
        let matched = if doc.joining {
            remote
                .iter()
                .find(|(sync_id, r)| {
                    !taken.contains(sync_id)
                        && if id.as_str() == DEFAULT_PROFILE_ID {
                            r.d
                        } else {
                            r.n == profile.name
                        }
                })
                .map(|(sync_id, _)| sync_id.clone())
        } else {
            None
        };
        let sync_id = matched.clone().unwrap_or_else(new_sync_id);
        doc.profiles.insert(
            id.as_str().to_owned(),
            ProfileLink {
                sync_id: sync_id.clone(),
                enabled: true,
                extra: Map::new(),
            },
        );
        taken.insert(sync_id.clone());
        let Some(matched) = matched else { continue };
        let mut patch = ProfilePatch::default();
        if let Some(on) = flag_record(app_value(scopes, &format!("{PROFILE_TOP_APPS}{matched}")))
            && on != profile.share_top_apps
        {
            patch.share_top_apps = Some(on);
        }
        if let Some(on) = flag_record(app_value(scopes, &format!("{PROFILE_OPEN_TABS}{matched}")))
            && on != profile.sync_tabs
        {
            patch.sync_tabs = Some(on);
        }
        let top_apps_changed = patch.share_top_apps;
        if patch != ProfilePatch::default() {
            let _ = host.dispatch(Action::UpdateProfile {
                profile: id.clone(),
                patch,
            });
        }
        if let Some(on) = top_apps_changed {
            crate::telemetry_events::note_top_apps_sharing_synced(&host.state(), "link_profiles", on);
        }
        scopes.insert(
            profile_scope(&sync_id),
            ScopeState {
                await_remote: Some(true),
                ..ScopeState::default()
            },
        );
        let mut link = doc
            .profiles
            .get(id.as_str())
            .cloned()
            .unwrap_or_else(|| ProfileLink {
                sync_id: sync_id.clone(),
                enabled: true,
                extra: Map::new(),
            });
        pair_theme(scopes.get(APP_SCOPE), id, &mut link, None, host);
        doc.profiles.insert(id.as_str().to_owned(), link);
    }
    for (id, link) in doc.profiles.iter_mut() {
        if !state.profiles.contains_key(&ProfileId::new(id.as_str()))
            && link.extra.get(RETIRE) != Some(&Value::Bool(true))
        {
            link.extra.insert(RETIRE.into(), Value::Bool(true));
        }
    }
    doc.joining = false;
}

pub fn add_remote_profile(
    doc: &mut SyncDoc,
    scopes: &mut Scopes,
    host: &SyncHost,
    sync_id: &str,
) -> Option<ProfileId> {
    let state = host.state();
    remote_profile_record(scopes, sync_id)?;
    if linked_profile_id(doc, &state, sync_id).is_some() {
        return None;
    }
    let chain = shared_data_chain(doc, scopes, &state, sync_id);
    if chain.waiting_for.is_some() {
        return None;
    }
    let mut share_with = chain.shares_with.clone();
    for add in chain.adds.iter().rev() {
        let record = remote_profile_record(scopes, add)?;
        share_with = Some(add_linked_profile(
            doc,
            scopes,
            host,
            add,
            &record,
            share_with.as_ref(),
        )?);
    }
    share_with
}

fn add_linked_profile(
    doc: &mut SyncDoc,
    scopes: &mut Scopes,
    host: &SyncHost,
    sync_id: &str,
    record: &ProfileRecord,
    share_with: Option<&ProfileId>,
) -> Option<ProfileId> {
    let color = ProfileColor::from_key(&record.c);
    let outcome = host
        .dispatch(Action::CreateProfile {
            name: record.n.clone(),
            color,
            icon: record.i.clone(),
        })
        .ok()?;
    let id = outcome.profile?;
    if let Some(with) = share_with {
        let _ = host.dispatch(Action::ShareProfileData {
            profile: id.clone(),
            with: with.clone(),
        });
    }
    let mut patch = ProfilePatch::default();
    let shares_top_apps =
        flag_record(app_value(scopes, &format!("{PROFILE_TOP_APPS}{sync_id}"))) == Some(true);
    if shares_top_apps {
        patch.share_top_apps = Some(true);
    }
    if flag_record(app_value(scopes, &format!("{PROFILE_OPEN_TABS}{sync_id}"))) == Some(true) {
        patch.sync_tabs = Some(true);
    }
    if patch != ProfilePatch::default() {
        let _ = host.dispatch(Action::UpdateProfile {
            profile: id.clone(),
            patch,
        });
    }
    if shares_top_apps {
        crate::telemetry_events::note_top_apps_sharing_synced(
            &host.state(),
            "linked_profile_created",
            true,
        );
    }
    let mut link = ProfileLink {
        sync_id: sync_id.to_owned(),
        enabled: true,
        extra: Map::new(),
    };
    pair_theme(scopes.get(APP_SCOPE), &id, &mut link, Some(record), host);
    doc.profiles.insert(id.as_str().to_owned(), link);
    scopes.insert(
        profile_scope(sync_id),
        ScopeState {
            await_remote: Some(true),
            ..ScopeState::default()
        },
    );
    Some(id)
}

pub fn without_angles(theme: &Value) -> Value {
    let mut theme = theme.clone();
    if let Value::Object(map) = &mut theme {
        map.shift_remove("angle");
        if let Some(Value::Object(dark)) = map.get_mut("dark") {
            dark.shift_remove("angle");
        }
    }
    theme
}

pub fn angles_of(theme: &Value) -> Value {
    let mut out = Map::new();
    if let Some(a) = theme.get("angle").filter(|v| !v.is_null()) {
        out.insert("a".into(), a.clone());
    }
    if let Some(d) = theme
        .get("dark")
        .and_then(|d| d.get("angle"))
        .filter(|v| !v.is_null())
    {
        out.insert("d".into(), d.clone());
    }
    Value::Object(out)
}

#[derive(Clone, Debug, PartialEq)]
pub enum ThemeChoice {
    Preset,
    Custom(Arc<ProfileTheme>),
}

pub fn theme_from_record(record: Option<&Value>, angles: Option<&Value>) -> Option<ThemeChoice> {
    let record = record?.as_object()?;
    if record.get("preset") == Some(&Value::Bool(true)) {
        return Some(ThemeChoice::Preset);
    }
    let raw = record.get("t")?;
    ProfileTheme::sanitize(raw)?;
    let Some(angles) = angles.and_then(Value::as_object) else {
        return ProfileTheme::sanitize(raw).map(|t| ThemeChoice::Custom(Arc::new(t)));
    };
    let mut look = without_angles(raw);
    if let Value::Object(map) = &mut look {
        if let Some(a) = angles.get("a") {
            map.insert("angle".into(), a.clone());
        }
        if let Some(Value::Object(dark)) = map.get_mut("dark")
            && let Some(d) = angles.get("d")
        {
            dark.insert("angle".into(), d.clone());
        }
    }
    ProfileTheme::sanitize(&look).map(|t| ThemeChoice::Custom(Arc::new(t)))
}

pub fn legacy_theme_of(record: &ProfileRecord) -> Option<ThemeChoice> {
    record
        .th
        .as_ref()
        .and_then(ProfileTheme::sanitize)
        .map(|t| ThemeChoice::Custom(Arc::new(t)))
}

fn paired_theme(app: &ScopeState, sync_id: &str) -> Option<ThemeChoice> {
    let key = format!("{PROFILE_THEME}{sync_id}");
    if let Some(record) = app.records.get(&key).map(|r| &r.v).filter(|v| !v.is_null()) {
        return theme_from_record(
            Some(record),
            app.records.get(&theme_angle_key(sync_id)).map(|r| &r.v),
        );
    }
    profile_record(
        app.records
            .get(&format!("{PROFILE}{sync_id}"))
            .map(|r| &r.v),
    )
    .and_then(|r| legacy_theme_of(&r))
}

fn settled_theme(app: &ScopeState, sync_id: &str) -> bool {
    let key = format!("{PROFILE_THEME}{sync_id}");
    app.records
        .get(&key)
        .map(|r| &r.v)
        .filter(|v| !v.is_null())
        .is_some_and(|v| theme_from_record(Some(v), None).is_some())
}

pub fn look_patch(theme: Option<ThemeChoice>, color: Option<ProfileColor>) -> ProfilePatch {
    ProfilePatch {
        color,
        theme: theme.map(|t| match t {
            ThemeChoice::Preset => None,
            ThemeChoice::Custom(theme) => Some(theme),
        }),
        ..ProfilePatch::default()
    }
}

pub fn pair_theme(
    app: Option<&ScopeState>,
    profile: &ProfileId,
    link: &mut ProfileLink,
    record: Option<&ProfileRecord>,
    host: &SyncHost,
) {
    let theme = match app {
        Some(app) => paired_theme(app, &link.sync_id),
        None => record.and_then(legacy_theme_of),
    };
    let synced_color = match app {
        Some(app) => profile_record(
            app.records
                .get(&format!("{PROFILE}{}", link.sync_id))
                .map(|r| &r.v),
        )
        .map(|r| r.c),
        None => record.map(|r| r.c.clone()),
    };
    let state = host.state();
    let current = state.profiles.get(profile).map(|p| p.color.preset());
    let color = synced_color
        .and_then(|c| ProfileColor::from_key(&c))
        .filter(|c| Some(*c) != current);
    if theme.is_some() || color.is_some() {
        let _ = host.dispatch(Action::UpdateProfile {
            profile: profile.clone(),
            patch: look_patch(theme, color),
        });
    }
    if app.is_some_and(|app| settled_theme(app, &link.sync_id)) {
        link.extra.shift_remove(THEME_ADOPTING);
    } else {
        link.extra.insert(THEME_ADOPTING.into(), Value::Bool(true));
    }
}

pub fn theme_chosen_here(link: &mut ProfileLink) -> bool {
    link.extra.shift_remove(THEME_ADOPTING).is_some()
}

pub fn settle_theme_adoption(doc: &mut SyncDoc, app: Option<&ScopeState>, after_pull: bool) {
    let Some(app) = app else { return };
    let clean = after_pull && pull_settled(app);
    for link in doc.profiles.values_mut() {
        if link.extra.get(THEME_ADOPTING) != Some(&Value::Bool(true)) {
            continue;
        }
        let key = format!("{PROFILE_THEME}{}", link.sync_id);
        let record = app.records.get(&key).map(|r| &r.v);
        let applied = record.filter(|v| !v.is_null()).is_some_and(|v| {
            theme_from_record(Some(v), None).is_some() && app.base.get(&key) == Some(&canonical(v))
        });
        let absent = clean && record.is_none_or(Value::is_null);
        if applied || absent {
            link.extra.shift_remove(THEME_ADOPTING);
        }
    }
}

fn removal_keys(sync_id: &str) -> Vec<String> {
    let mut keys: Vec<String> = [
        PROFILE,
        SHARE,
        PROFILE_THEME,
        PROFILE_TOP_APPS,
        PROFILE_OPEN_TABS,
    ]
    .iter()
    .map(|p| format!("{p}{sync_id}"))
    .collect();
    keys.push(theme_angle_key(sync_id));
    keys
}

fn live_keys(app: Option<&ScopeState>, sync_id: &str) -> Map<String, Value> {
    removal_keys(sync_id)
        .into_iter()
        .filter_map(|key| {
            let record = app?.records.get(&key)?;
            (!record.v.is_null()).then(|| (key, Value::String(record.h.clone())))
        })
        .collect()
}

fn is_removal(value: &Value) -> bool {
    value
        .get("keys")
        .and_then(Value::as_object)
        .is_some_and(|keys| keys.values().all(Value::is_string))
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    value?
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect()
}

pub fn removal_targets(
    doc: &SyncDoc,
    scopes: &Scopes,
    state: &BrowserState,
) -> BTreeMap<String, Value> {
    let saved = doc.extra.get("removing");
    let entries: Vec<(String, Value)> = if let Some(list) = string_list(saved) {
        list.into_iter()
            .filter_map(|sync_id| {
                let keys = live_keys(scopes.get(APP_SCOPE), &sync_id);
                (!keys.is_empty()).then(|| (sync_id, json!({ "keys": keys })))
            })
            .collect()
    } else if let Some(map) = saved.and_then(Value::as_object) {
        map.iter()
            .filter(|(_, v)| is_removal(v))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    } else {
        Vec::new()
    };
    entries
        .into_iter()
        .filter(|(sync_id, _)| linked_profile_id(doc, state, sync_id).is_none())
        .collect()
}

fn targets_value(targets: BTreeMap<String, Value>) -> Option<Value> {
    (!targets.is_empty()).then(|| Value::Object(targets.into_iter().collect()))
}

fn set_extra(doc: &mut SyncDoc, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            doc.extra.insert(key.to_owned(), value);
        }
        None => {
            doc.extra.shift_remove(key);
        }
    }
}

pub fn freeze_removals(doc: &mut SyncDoc, scopes: &Scopes, state: &BrowserState) -> bool {
    let devices = freeze_device_removals(doc, scopes);
    let joined = scopes.get(APP_SCOPE).is_some_and(|a| a.joined);
    if string_list(doc.extra.get("removing")).is_none() || !joined {
        return devices;
    }
    let targets = removal_targets(doc, scopes, state);
    set_extra(doc, "removing", targets_value(targets));
    true
}

pub fn removed_record_keys(
    doc: &SyncDoc,
    scopes: &Scopes,
    state: &BrowserState,
) -> HashSet<String> {
    let app = scopes.get(APP_SCOPE);
    removal_targets(doc, scopes, state)
        .values()
        .flat_map(|removal| {
            removal
                .get("keys")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        })
        .filter(|(key, h)| {
            app.and_then(|a| a.records.get(key))
                .is_some_and(|r| Some(r.h.as_str()) == h.as_str())
        })
        .map(|(key, _)| key)
        .collect()
}

pub fn being_removed(doc: &SyncDoc, scopes: &Scopes, state: &BrowserState, sync_id: &str) -> bool {
    removal_targets(doc, scopes, state).contains_key(sync_id)
}

pub fn shares_its_data(
    doc: &SyncDoc,
    scopes: &Scopes,
    state: &BrowserState,
    sync_id: &str,
) -> bool {
    let Some(app) = scopes.get(APP_SCOPE) else {
        return false;
    };
    app.visible(SHARE).iter().any(|(key, value)| {
        let sharer = record_id(SHARE, key);
        sharer != sync_id
            && value.get("o").and_then(Value::as_str) == Some(sync_id)
            && remote_profile_record(scopes, sharer).is_some()
            && !being_removed(doc, scopes, state, sharer)
    })
}

pub fn mark_removed(
    doc: &mut SyncDoc,
    scopes: &Scopes,
    state: &BrowserState,
    sync_id: &str,
) -> bool {
    if remote_profile_record(scopes, sync_id).is_none()
        || linked_profile_id(doc, state, sync_id).is_some()
        || being_removed(doc, scopes, state, sync_id)
        || shares_its_data(doc, scopes, state, sync_id)
    {
        return false;
    }
    let mut targets = removal_targets(doc, scopes, state);
    targets.insert(
        sync_id.to_owned(),
        json!({ "keys": live_keys(scopes.get(APP_SCOPE), sync_id) }),
    );
    set_extra(doc, "removing", targets_value(targets));
    true
}

pub fn settle_removals(doc: &mut SyncDoc, app: &ScopeState, state: &BrowserState) {
    if !app.joined {
        return;
    }
    settle_device_removals(doc, app);
    let mut scopes = Scopes::new();
    scopes.insert(APP_SCOPE.to_owned(), app.clone());
    let mut left = BTreeMap::new();
    for (sync_id, removal) in removal_targets(doc, &scopes, state) {
        let mut back = removal.get("returned") == Some(&Value::Bool(true));
        let keys: Map<String, Value> = removal
            .get("keys")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter(|(key, h)| {
                let record = app.records.get(*key);
                if record.is_some_and(|r| Some(r.h.as_str()) == h.as_str()) {
                    return true;
                }
                back = back || record.is_some_and(|r| !r.v.is_null());
                false
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if !keys.is_empty() {
            let mut settled = json!({ "keys": keys });
            if back {
                settled["returned"] = Value::Bool(true);
            }
            left.insert(sync_id, settled);
        }
    }
    set_extra(doc, "removing", targets_value(left));
}

fn device_key(id: &str) -> String {
    format!("{DEVICE}{id}")
}

pub fn device_removal_targets(doc: &SyncDoc, scopes: &Scopes) -> BTreeMap<String, String> {
    let saved = doc.extra.get("removingDevices");
    let app = scopes.get(APP_SCOPE);
    let entries: Vec<(String, String)> = if let Some(list) = string_list(saved) {
        list.into_iter()
            .filter_map(|id| {
                app.and_then(|a| a.records.get(&device_key(&id)))
                    .filter(|r| !r.v.is_null())
                    .map(|r| (id, r.h.clone()))
            })
            .collect()
    } else if let Some(map) = saved.and_then(Value::as_object) {
        map.iter()
            .filter_map(|(k, v)| v.as_str().map(|h| (k.clone(), h.to_owned())))
            .collect()
    } else {
        Vec::new()
    };
    entries
        .into_iter()
        .filter(|(id, _)| Some(id) != doc.device_id.as_ref())
        .collect()
}

fn freeze_device_removals(doc: &mut SyncDoc, scopes: &Scopes) -> bool {
    let joined = scopes.get(APP_SCOPE).is_some_and(|a| a.joined);
    if string_list(doc.extra.get("removingDevices")).is_none() || !joined {
        return false;
    }
    let targets = device_removal_targets(doc, scopes);
    set_extra(
        doc,
        "removingDevices",
        (!targets.is_empty()).then(|| json!(targets)),
    );
    true
}

pub fn removed_device_keys(doc: &SyncDoc, scopes: &Scopes) -> HashSet<String> {
    let app = scopes.get(APP_SCOPE);
    device_removal_targets(doc, scopes)
        .into_iter()
        .filter(|(id, h)| {
            app.and_then(|a| a.records.get(&device_key(id)))
                .is_some_and(|r| r.h == *h)
        })
        .map(|(id, _)| device_key(&id))
        .collect()
}

pub fn device_being_removed(doc: &SyncDoc, scopes: &Scopes, id: &str) -> bool {
    device_removal_targets(doc, scopes).contains_key(id)
}

pub fn mark_device_removed(doc: &mut SyncDoc, scopes: &Scopes, id: &str) -> bool {
    let Some(app) = scopes.get(APP_SCOPE) else {
        return false;
    };
    let Some(record) = app.records.get(&device_key(id)) else {
        return false;
    };
    let known = app
        .visible(DEVICE)
        .get(&device_key(id))
        .is_some_and(|v| v.get("n").is_some_and(Value::is_string));
    if Some(id) == doc.device_id.as_deref() || !known || device_being_removed(doc, scopes, id) {
        return false;
    }
    let mut targets = device_removal_targets(doc, scopes);
    targets.insert(id.to_owned(), record.h.clone());
    set_extra(doc, "removingDevices", Some(json!(targets)));
    true
}

fn settle_device_removals(doc: &mut SyncDoc, app: &ScopeState) {
    let mut scopes = Scopes::new();
    scopes.insert(APP_SCOPE.to_owned(), app.clone());
    let left: BTreeMap<String, String> = device_removal_targets(doc, &scopes)
        .into_iter()
        .filter(|(id, h)| app.records.get(&device_key(id)).is_some_and(|r| r.h == *h))
        .collect();
    set_extra(
        doc,
        "removingDevices",
        (!left.is_empty()).then(|| json!(left)),
    );
}
