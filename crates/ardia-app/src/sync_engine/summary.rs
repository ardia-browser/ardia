use std::collections::{BTreeMap, HashSet};

use ardia_state::sync::SyncDoc;
use ardia_state::{BrowserState, ProfileId};
use ardia_ui::sync_api::{
    DeviceKind, RemoteProfile, RemoteTab, RemoteTabs, SendTarget, SharesWith, SyncEngineView,
    SyncState, SyncedDevice,
};
use serde_json::Value;

use super::EngineStatus;
use super::adapters::{DEVICE, DEVICE_TABS, PROFILE, RECEIVES_TABS, record_id};
use super::files::{APP_SCOPE, Scopes, profile_scope};
use super::links;

const PHONE_SEEN_MS: i64 = 30 * 86_400_000;

pub fn device_kind_of(record: Option<&Value>) -> DeviceKind {
    if record.and_then(|r| r.get("k")).and_then(Value::as_str) == Some("phone") {
        DeviceKind::Phone
    } else {
        DeviceKind::Mac
    }
}

pub fn receives_tabs(record: &Value) -> bool {
    record
        .get("f")
        .and_then(Value::as_array)
        .is_some_and(|f| f.iter().any(|v| v.as_str() == Some(RECEIVES_TABS)))
}

pub fn is_current_device(record: &Value, last_seen: Option<i64>, now: i64) -> bool {
    device_kind_of(Some(record)) != DeviceKind::Phone
        || last_seen.is_some_and(|seen| now - seen <= PHONE_SEEN_MS)
}

pub fn offers_tabs(record: &Value, last_seen: Option<i64>, now: i64) -> bool {
    receives_tabs(record) && is_current_device(record, last_seen, now)
}

pub fn device_records(scopes: &Scopes) -> Vec<(String, Value)> {
    let Some(app) = scopes.get(APP_SCOPE) else {
        return Vec::new();
    };
    app.visible(DEVICE)
        .into_iter()
        .filter(|(_, v)| v.get("n").is_some_and(Value::is_string))
        .map(|(k, v)| (record_id(DEVICE, &k).to_owned(), v))
        .collect()
}

fn last_seen_of(scopes: &Scopes, device: &str) -> Option<i64> {
    scopes
        .values()
        .filter_map(|s| s.seen.get(device).copied())
        .max()
}

pub fn send_targets(
    doc: &SyncDoc,
    scopes: &Scopes,
    profile: &ProfileId,
    now: i64,
) -> Vec<SendTarget> {
    let Some(link) = doc.profiles.get(profile.as_str()) else {
        return Vec::new();
    };
    let (Some(app), Some(scope), Some(me)) = (
        scopes.get(APP_SCOPE),
        scopes.get(&profile_scope(&link.sync_id)),
        doc.device_id.as_ref(),
    ) else {
        return Vec::new();
    };
    if !doc.enabled || !link.enabled || link.extra.get("retire") == Some(&Value::Bool(true)) {
        return Vec::new();
    }
    let mut targets: Vec<(String, Value)> = device_records(scopes)
        .into_iter()
        .filter(|(id, record)| {
            id != me
                && offers_tabs(record, last_seen_of(scopes, id), now)
                && (device_kind_of(Some(record)) == DeviceKind::Phone
                    || scope.seen.contains_key(id))
        })
        .collect();
    let seen = |id: &str| {
        scope
            .seen
            .get(id)
            .or_else(|| app.seen.get(id))
            .copied()
            .unwrap_or(0)
    };
    targets.sort_by_key(|(id, _)| std::cmp::Reverse(seen(id)));
    targets
        .into_iter()
        .map(|(id, record)| SendTarget {
            name: record
                .get("n")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .unwrap_or("Unknown Device")
                .to_owned(),
            kind: device_kind_of(Some(&record)),
            id,
        })
        .collect()
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Published {
    pub status: EngineStatus,
    pub enabled: bool,
    pub joining: bool,
    pub folder: Option<String>,
    pub device_id: Option<String>,
    pub last_synced_at: Option<i64>,
    pub setup_at: Option<i64>,
    pub types: BTreeMap<String, bool>,
    pub profiles: Vec<(ProfileId, bool)>,
    pub view: SyncEngineView,
}

impl Published {
    pub fn build(
        doc: &SyncDoc,
        scopes: &Scopes,
        status: &EngineStatus,
        state: &BrowserState,
        now: i64,
    ) -> Published {
        let mut view = SyncEngineView {
            state: status.state,
            error: status.error.clone(),
            pending: status.pending,
            ..SyncEngineView::default()
        };
        if doc.enabled {
            summarize(doc, scopes, state, now, &mut view);
        } else {
            view.pending = 0;
        }
        Published {
            status: status.clone(),
            enabled: doc.enabled,
            joining: doc.enabled && doc.joining,
            folder: doc.folder.clone(),
            device_id: doc.device_id.clone(),
            last_synced_at: doc.last_synced_at,
            setup_at: doc.setup_at,
            types: doc.types.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            profiles: doc
                .profiles
                .iter()
                .map(|(k, l)| (ProfileId::new(k.as_str()), l.enabled))
                .collect(),
            view,
        }
    }

    pub fn locked(&self) -> bool {
        self.status.state == SyncState::Locked
    }
}

fn summarize(
    doc: &SyncDoc,
    scopes: &Scopes,
    state: &BrowserState,
    now: i64,
    view: &mut SyncEngineView,
) {
    if !scopes.contains_key(APP_SCOPE) {
        return;
    }
    let records: Vec<(String, Value)> = device_records(scopes)
        .into_iter()
        .filter(|(id, r)| {
            Some(id) == doc.device_id.as_ref()
                || (!links::device_being_removed(doc, scopes, id)
                    && is_current_device(r, last_seen_of(scopes, id), now))
        })
        .collect();
    let names: BTreeMap<String, String> = records
        .iter()
        .map(|(id, r)| {
            (
                id.clone(),
                r.get("n")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            )
        })
        .collect();
    let mut devices: Vec<SyncedDevice> = records
        .iter()
        .map(|(id, r)| SyncedDevice {
            id: id.clone(),
            name: names[id].clone(),
            kind: device_kind_of(Some(r)),
            receives_tabs: offers_tabs(r, last_seen_of(scopes, id), now),
            last_seen: last_seen_of(scopes, id),
            current: Some(id) == doc.device_id.as_ref(),
            version: r
                .get("v")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned),
            os: r
                .get("os")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned),
        })
        .collect();
    devices.sort_by(|a, b| {
        b.current
            .cmp(&a.current)
            .then(b.last_seen.unwrap_or(0).cmp(&a.last_seen.unwrap_or(0)))
    });
    view.devices = devices;
    let by_id: BTreeMap<&String, &Value> = records.iter().map(|(id, r)| (id, r)).collect();
    for (profile_id, link) in &doc.profiles {
        let Some(scope) = scopes.get(&profile_scope(&link.sync_id)) else {
            continue;
        };
        if !link.enabled {
            continue;
        }
        let tabs: Vec<RemoteTabs> = scope
            .visible(DEVICE_TABS)
            .iter()
            .filter_map(|(key, value)| {
                let device = record_id(DEVICE_TABS, key).to_owned();
                let name = value.get("n")?.as_str()?;
                let list = value.get("tabs")?.as_array()?;
                let tabs: Option<Vec<RemoteTab>> = list
                    .iter()
                    .map(|t| {
                        Some(RemoteTab {
                            url: t.get("u")?.as_str()?.to_owned(),
                            title: t.get("t")?.as_str()?.to_owned(),
                        })
                    })
                    .collect();
                let tabs = tabs?;
                if Some(&device) == doc.device_id.as_ref()
                    || !names.contains_key(&device)
                    || tabs.is_empty()
                {
                    return None;
                }
                let record = by_id.get(&device).copied();
                let kind_source = if record.is_some_and(|r| r.get("k").is_some()) {
                    record
                } else {
                    Some(value)
                };
                Some(RemoteTabs {
                    name: Some(names[&device].clone())
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| {
                            if name.is_empty() {
                                "Unknown Device".to_owned()
                            } else {
                                name.to_owned()
                            }
                        }),
                    kind: device_kind_of(kind_source),
                    device_id: device,
                    tabs,
                })
            })
            .collect();
        view.remote_tabs
            .insert(ProfileId::new(profile_id.as_str()), tabs);
        let profile = ProfileId::new(profile_id.as_str());
        view.send_targets
            .insert(profile.clone(), send_targets(doc, scopes, &profile, now));
    }
    let linked: HashSet<&String> = doc.profiles.values().map(|l| &l.sync_id).collect();
    let app = &scopes[APP_SCOPE];
    view.remote_profiles = app
        .visible(PROFILE)
        .iter()
        .filter_map(|(key, value)| {
            let sync_id = record_id(PROFILE, key).to_owned();
            let record = links::profile_record(Some(value))?;
            if doc.joining
                || linked.contains(&sync_id)
                || links::being_removed(doc, scopes, state, &sync_id)
            {
                return None;
            }
            let chain = links::shared_data_chain(doc, scopes, state, &sync_id);
            let owner_name = match chain.adds.get(1) {
                Some(owner) => links::remote_profile_record(scopes, owner).map(|r| r.n),
                None => chain
                    .shares_with
                    .as_ref()
                    .and_then(|p| state.profiles.get(p))
                    .map(|p| p.name.clone()),
            };
            Some(RemoteProfile {
                name: record.n,
                color: record.c,
                icon: record.i,
                shares_with: owner_name.map(|name| SharesWith {
                    name,
                    added: chain.adds.len() > 1,
                }),
                waiting: chain.waiting_for.is_some(),
                shared_by_others: links::shares_its_data(doc, scopes, state, &sync_id),
                sync_id,
            })
        })
        .collect();
}
