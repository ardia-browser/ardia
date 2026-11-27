use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

use ardia_state::ProfileId;
use ardia_state::sync_engine::scope::{Adapter, ApplyRecords, ExtractContext, Extraction};
use ardia_state::sync_engine::{IndexMap, IndexSet, js_json};
use serde_json::{Map, Value, json};

use super::{CycleContext, data_engine};

pub const EXTENSION: &str = "ext:";
pub const EXTENSION_APPROVAL: &str = "ext:v:";
pub const RETRY_MS: i64 = 3_600_000;
pub const INTENTS_DOC: &str = "sync-extensions.json";
const MAX_FINGERPRINTS: usize = 8;

pub fn extension_key(id: &str) -> String {
    format!("{EXTENSION}{id}")
}

pub fn approval_key(id: &str) -> String {
    format!("{EXTENSION_APPROVAL}{id}")
}

fn id_of(key: &str) -> &str {
    key.strip_prefix(EXTENSION_APPROVAL)
        .or_else(|| key.strip_prefix(EXTENSION))
        .unwrap_or(key)
}

fn is_state_key(key: &str) -> bool {
    key.starts_with(EXTENSION) && !key.starts_with(EXTENSION_APPROVAL)
}

pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |s: &str| -> Vec<i64> { s.split('.').map(leading_int).collect() };
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let d = pa
            .get(i)
            .copied()
            .unwrap_or(0)
            .cmp(&pb.get(i).copied().unwrap_or(0));
        if d != std::cmp::Ordering::Equal {
            return d;
        }
    }
    std::cmp::Ordering::Equal
}

fn leading_int(text: &str) -> i64 {
    let trimmed = text.trim_start();
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let numeric: String = digits.chars().take_while(char::is_ascii_digit).collect();
    numeric.parse::<i64>().map_or(0, |n| sign * n)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExtensionState {
    pub on: bool,
    pub inc: bool,
    pub pin: bool,
}

impl ExtensionState {
    fn to_value(self) -> Value {
        json!({ "on": self.on, "inc": self.inc, "pin": self.pin })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Approval {
    pub v: String,
    pub fps: Vec<String>,
}

impl Approval {
    fn to_value(&self) -> Value {
        json!({ "v": self.v, "fps": self.fps })
    }
}

fn is_removal(v: Option<&Value>) -> bool {
    v.and_then(|v| v.get("removed")) == Some(&Value::Bool(true))
}

fn extension_state(v: Option<&Value>) -> Option<ExtensionState> {
    if is_removal(v) {
        return None;
    }
    let v = v?.as_object()?;
    Some(ExtensionState {
        on: v.get("on")?.as_bool()?,
        inc: v.get("inc")?.as_bool()?,
        pin: v.get("pin")?.as_bool()?,
    })
}

fn approval_of(v: Option<&Value>) -> Option<Approval> {
    let v = v?.as_object()?;
    let fps = v
        .get("fps")?
        .as_array()?
        .iter()
        .map(|f| f.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    Some(Approval {
        v: v.get("v")?.as_str()?.to_owned(),
        fps,
    })
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LocalExtension {
    pub id: String,
    pub syncable: bool,
    pub version: Option<String>,
    pub approved: bool,
    pub fingerprint: Option<String>,
    pub user_disabled: bool,
    pub incognito: bool,
    pub pinned: bool,
}

impl LocalExtension {
    fn state(&self) -> ExtensionState {
        ExtensionState {
            on: !self.user_disabled,
            inc: self.incognito,
            pin: self.pinned,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LocalExtensions {
    pub ready: bool,
    pub extensions: Vec<LocalExtension>,
    pub pending: Vec<String>,
    pub settling: Vec<String>,
    pub queued: Vec<String>,
    pub intents: Vec<(String, String)>,
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|l| {
            l.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn local_extensions(reply: &Value) -> Option<LocalExtensions> {
    let reply = reply.as_object()?;
    let extensions = reply
        .get("extensions")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|e| {
                    Some(LocalExtension {
                        id: e.get("id")?.as_str()?.to_owned(),
                        syncable: e.get("syncable").and_then(Value::as_bool).unwrap_or(false),
                        version: e.get("version").and_then(Value::as_str).map(str::to_owned),
                        approved: e.get("approved").and_then(Value::as_bool).unwrap_or(false),
                        fingerprint: e
                            .get("fingerprint")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        user_disabled: e
                            .get("userDisabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        incognito: e.get("incognito").and_then(Value::as_bool).unwrap_or(false),
                        pinned: e.get("pinned").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let intents = reply
        .get("intents")
        .and_then(Value::as_array)
        .map(|l| {
            l.iter()
                .filter_map(|i| {
                    Some((
                        i.get("id")?.as_str()?.to_owned(),
                        i.get("kind")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(LocalExtensions {
        ready: reply.get("ready").and_then(Value::as_bool).unwrap_or(false),
        extensions,
        pending: strings(reply.get("pending")),
        settling: strings(reply.get("settling")),
        queued: strings(reply.get("queued")),
        intents,
    })
}

fn same_state(a: ExtensionState, b: ExtensionState) -> bool {
    a == b
}

fn grantable(approval: Option<&Approval>, e: &LocalExtension) -> bool {
    approval.is_some_and(|a| {
        !e.approved
            && Some(&a.v) == e.version.as_ref()
            && e.fingerprint.as_ref().is_some_and(|f| a.fps.contains(f))
    })
}

pub fn approval_to_publish(e: &LocalExtension, known: Option<Approval>) -> Option<Approval> {
    let (true, Some(fingerprint), Some(version)) = (
        e.approved,
        e.fingerprint.as_ref(),
        e.version.as_ref().filter(|v| !v.is_empty()),
    ) else {
        return known;
    };
    match known {
        None => Some(Approval {
            v: version.clone(),
            fps: vec![fingerprint.clone()],
        }),
        Some(known) if compare_versions(version, &known.v).is_gt() => Some(Approval {
            v: version.clone(),
            fps: vec![fingerprint.clone()],
        }),
        Some(known)
            if compare_versions(version, &known.v).is_lt() || known.fps.contains(fingerprint) =>
        {
            Some(known)
        }
        Some(known) => {
            let mut fps = known.fps.clone();
            fps.push(fingerprint.clone());
            fps.sort();
            let fps = fps.split_off(fps.len().saturating_sub(MAX_FINGERPRINTS));
            Some(Approval { v: known.v, fps })
        }
    }
}

fn newer_approval(approval: Option<&Approval>, e: &LocalExtension) -> bool {
    approval.is_some_and(|a| compare_versions(&a.v, e.version.as_deref().unwrap_or("0")).is_gt())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub kind: String,
    pub g: u64,
}

#[derive(Default)]
pub struct IntentStore {
    loaded: bool,
    path: Option<PathBuf>,
    generation: u64,
    profiles: BTreeMap<String, BTreeMap<String, Intent>>,
}

impl IntentStore {
    fn load(&mut self, path: Option<PathBuf>) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        self.path = path;
        let saved = self
            .path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .unwrap_or(Value::Null);
        self.generation = saved
            .get("generation")
            .and_then(Value::as_f64)
            .map_or(0, |g| g.max(0.0) as u64);
        for (profile, intents) in saved
            .get("profiles")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            let entries = intents
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(id, i)| {
                    Some((
                        id.clone(),
                        Intent {
                            kind: i.get("kind")?.as_str()?.to_owned(),
                            g: i.get("g")?.as_f64()? as u64,
                        },
                    ))
                })
                .collect();
            self.profiles.insert(profile.clone(), entries);
        }
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        let profiles: Map<String, Value> = self
            .profiles
            .iter()
            .map(|(p, intents)| {
                (
                    p.clone(),
                    Value::Object(
                        intents
                            .iter()
                            .map(|(id, i)| (id.clone(), json!({ "kind": i.kind, "g": i.g })))
                            .collect(),
                    ),
                )
            })
            .collect();
        let text =
            js_json(&json!({ "generation": self.generation, "profiles": profiles, "version": 1 }));
        let temp = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
        if std::fs::write(&temp, text)
            .and_then(|_| std::fs::rename(&temp, path))
            .is_err()
        {
            let _ = std::fs::remove_file(&temp);
        }
    }

    pub fn note(&mut self, profile: &str, id: &str, kind: &str) {
        self.generation += 1;
        let g = self.generation;
        self.profiles.entry(profile.to_owned()).or_default().insert(
            id.to_owned(),
            Intent {
                kind: kind.to_owned(),
                g,
            },
        );
        self.save();
    }

    fn of(&self, profile: &str) -> BTreeMap<String, Intent> {
        self.profiles.get(profile).cloned().unwrap_or_default()
    }

    fn settle(&mut self, profile: &str, published: &BTreeMap<String, u64>) {
        let Some(by_id) = self.profiles.get_mut(profile) else {
            return;
        };
        let before = by_id.len();
        by_id.retain(|id, i| published.get(id) != Some(&i.g));
        if by_id.len() != before {
            self.save();
        }
    }
}

#[derive(Default)]
struct Memory {
    tried: HashMap<String, i64>,
    unsettled: HashSet<String>,
}

const INTENTS_SLOT: &str = "extensions:intents";

pub enum Change {
    Install {
        id: String,
        record: ExtensionState,
        approval: Option<Approval>,
    },
    Reconcile {
        id: String,
        record: ExtensionState,
        approval: Option<Approval>,
    },
    Cancel {
        id: String,
    },
}

impl Change {
    fn id(&self) -> &str {
        match self {
            Change::Install { id, .. } | Change::Reconcile { id, .. } | Change::Cancel { id } => id,
        }
    }

    fn plan(&self) -> Value {
        match self {
            Change::Cancel { id } => json!({ "id": id, "record": { "removed": true } }),
            Change::Install {
                id,
                record,
                approval,
            }
            | Change::Reconcile {
                id,
                record,
                approval,
            } => {
                let mut plan = json!({ "id": id, "record": record.to_value() });
                if let Some(approval) = approval {
                    plan["approval"] = approval.to_value();
                }
                plan
            }
        }
    }
}

pub struct ExtensionsAdapter {
    cx: CycleContext,
    profile: ProfileId,
    engine_profile: String,
    slot: String,
}

pub fn adapter(cx: &CycleContext, profile: &ProfileId) -> Vec<Box<dyn Adapter>> {
    vec![Box::new(ExtensionsAdapter::new(cx, profile))]
}

impl ExtensionsAdapter {
    fn new(cx: &CycleContext, profile: &ProfileId) -> Self {
        let engine_profile = cx.host.state().engine_profile(profile);
        ExtensionsAdapter {
            cx: cx.clone(),
            profile: profile.clone(),
            engine_profile,
            slot: format!("extensions:{profile}"),
        }
    }

    fn intents_path(&self) -> Option<PathBuf> {
        if !self.cx.host.has_main() {
            return None;
        }
        self.cx
            .host
            .on_main(Duration::from_secs(5), |c| c.data_dir())
            .flatten()
            .map(|d| d.join(INTENTS_DOC))
    }

    fn with_intents<T>(&self, f: impl FnOnce(&mut IntentStore) -> T) -> T {
        let path = {
            let mut memory = self.cx.memory.lock();
            let loaded = memory.slot::<IntentStore>(INTENTS_SLOT).loaded;
            drop(memory);
            if loaded {
                None
            } else {
                Some(self.intents_path())
            }
        };
        let mut memory = self.cx.memory.lock();
        let store = memory.slot::<IntentStore>(INTENTS_SLOT);
        if let Some(path) = path {
            store.load(path);
        }
        f(store)
    }

    fn with_memory<T>(&self, f: impl FnOnce(&mut Memory) -> T) -> T {
        f(self.cx.memory.lock().slot::<Memory>(&self.slot))
    }

    fn read(&self) -> Option<LocalExtensions> {
        let reply = data_engine::call(
            &self.cx,
            &self.profile,
            "ac_extensions_sync_state",
            json!({}),
        )?;
        let local = local_extensions(&reply)?;
        if !local.intents.is_empty() {
            let profile = self.engine_profile.clone();
            self.with_intents(|store| {
                for (id, kind) in &local.intents {
                    store.note(&profile, id, kind);
                }
            });
        }
        Some(local)
    }

    fn intents(&self) -> BTreeMap<String, Intent> {
        let profile = self.engine_profile.clone();
        self.with_intents(|store| store.of(&profile))
    }

    fn run(&self, change: Change) -> bool {
        let ok = data_engine::call(
            &self.cx,
            &self.profile,
            "ac_extensions_sync_apply",
            change.plan(),
        )
        .is_some();
        let id = change.id().to_owned();
        self.with_memory(|m| {
            if ok {
                m.unsettled.remove(&id);
            } else {
                m.unsettled.insert(id);
            }
        });
        ok
    }

    #[allow(clippy::too_many_arguments)]
    fn reconcile_one(
        &self,
        id: &str,
        record: Option<&Value>,
        approval_value: Option<&Value>,
        local: &LocalExtensions,
        intents: &BTreeMap<String, Intent>,
        joined: bool,
        held: &dyn Fn() -> bool,
    ) -> bool {
        if held() {
            return false;
        }
        let e = local.extensions.iter().find(|x| x.id == id);
        let pending = local.pending.iter().any(|p| p == id);
        let queued = local.queued.iter().any(|p| p == id);
        let approval = approval_of(approval_value);
        if is_removal(record) {
            if intents.get(id).is_some_and(|i| i.kind == "installed") {
                return true;
            }
            if !joined && e.is_some_and(|e| e.syncable) {
                let profile = self.engine_profile.clone();
                self.with_intents(|store| store.note(&profile, id, "installed"));
                return true;
            }
            return if e.is_none() && (pending || queued) {
                self.run(Change::Cancel { id: id.to_owned() })
            } else {
                true
            };
        }
        let Some(record) = extension_state(record) else {
            return true;
        };
        if let Some(e) = e {
            if !e.syncable {
                return true;
            }
            if !same_state(record, e.state())
                || grantable(approval.as_ref(), e)
                || newer_approval(approval.as_ref(), e)
            {
                return self.run(Change::Reconcile {
                    id: id.to_owned(),
                    record,
                    approval,
                });
            }
            return true;
        }
        if intents.get(id).is_some_and(|i| i.kind == "uninstalled") {
            return true;
        }
        self.run(Change::Install {
            id: id.to_owned(),
            record,
            approval,
        })
    }
}

impl Adapter for ExtensionsAdapter {
    fn prefix(&self) -> &str {
        EXTENSION
    }

    fn adopt_remote_on_join(&self) -> bool {
        true
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let local = self.read().filter(|l| l.ready)?;
        let intents = self.intents();
        let unsettled = self.with_memory(|m| m.unsettled.clone());
        let mut values = IndexMap::new();
        let mut captured: BTreeMap<String, u64> = BTreeMap::new();
        let mut installed = HashSet::new();
        let settling: HashSet<&String> = local
            .pending
            .iter()
            .chain(local.settling.iter())
            .chain(unsettled.iter())
            .collect();
        for e in &local.extensions {
            if !e.syncable || e.version.as_deref().is_none_or(str::is_empty) {
                continue;
            }
            installed.insert(e.id.clone());
            if settling.contains(&e.id) {
                continue;
            }
            let key = extension_key(&e.id);
            let stored = cx.base(&key);
            let explicit = intents.get(&e.id).is_some_and(|i| i.kind == "installed");
            if !explicit && ((cx.known(&key) && stored.is_none()) || is_removal(stored.as_ref())) {
                continue;
            }
            values.insert(key, e.state().to_value());
            if explicit {
                captured.insert(e.id.clone(), intents[&e.id].g);
            }
            if let Some(approval) =
                approval_to_publish(e, approval_of(cx.base(&approval_key(&e.id)).as_ref()))
            {
                values.insert(approval_key(&e.id), approval.to_value());
            }
        }
        for (id, intent) in &intents {
            if intent.kind != "uninstalled" || installed.contains(id) {
                continue;
            }
            values.insert(extension_key(id), json!({ "removed": true }));
            captured.insert(id.clone(), intent.g);
        }
        let mine: HashSet<String> = values.keys().cloned().collect();
        let republish_ids: HashSet<String> = captured
            .keys()
            .filter(|id| !cx.queued(&extension_key(id)))
            .cloned()
            .collect();
        let memory = self.cx.memory.clone();
        let profile = self.engine_profile.clone();
        Some(
            Extraction::of(values)
                .ignoring(move |key| !mine.contains(key))
                .republishing(move |key| is_state_key(key) && republish_ids.contains(id_of(key)))
                .on_published(move |keys| {
                    let settled: BTreeMap<String, u64> = keys
                        .iter()
                        .filter(|k| is_state_key(k))
                        .map(|k| id_of(k).to_owned())
                        .filter_map(|id| captured.get(&id).map(|g| (id, *g)))
                        .collect();
                    if !settled.is_empty() {
                        memory
                            .lock()
                            .slot::<IntentStore>(INTENTS_SLOT)
                            .settle(&profile, &settled);
                    }
                }),
        )
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        records: &ApplyRecords,
    ) -> bool {
        let Some(local) = self.read().filter(|l| l.ready) else {
            return false;
        };
        let intents = self.intents();
        let held = || records.held();
        let ids: IndexSet<String> = changed.iter().map(|k| id_of(k).to_owned()).collect();
        let mut ok = true;
        for id in ids {
            ok = self.reconcile_one(
                &id,
                visible.get(&extension_key(&id)),
                visible.get(&approval_key(&id)),
                &local,
                &intents,
                records.joined,
                &held,
            ) && ok;
        }
        ok && !records.held()
    }
}

pub fn reconcile(cx: &CycleContext, profile: &ProfileId, visible: &IndexMap<String, Value>) {
    let adapter = ExtensionsAdapter::new(cx, profile);
    let Some(local) = adapter.read().filter(|l| l.ready) else {
        return;
    };
    let intents = adapter.intents();
    let now = ardia_state::store::now_ms();
    let held = || cx.host.quitting();
    for (key, record) in visible {
        if !is_state_key(key) || extension_state(Some(record)).is_none() {
            continue;
        }
        let id = id_of(key).to_owned();
        let approval = visible.get(&approval_key(&id));
        if let Some(e) = local.extensions.iter().find(|x| x.id == id) {
            if e.syncable && grantable(approval_of(approval).as_ref(), e) {
                adapter.reconcile_one(&id, Some(record), approval, &local, &intents, true, &held);
            }
            continue;
        }
        if held() {
            return;
        }
        let recent = adapter.with_memory(|m| m.tried.get(&id).is_some_and(|t| now - t < RETRY_MS));
        if local.pending.contains(&id) || recent {
            continue;
        }
        adapter.with_memory(|m| m.tried.insert(id.clone(), now));
        adapter.reconcile_one(&id, Some(record), approval, &local, &intents, true, &held);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::adapters::data_engine::fake;
    use crate::sync_engine::adapters::tests_support::{MemoryTransport, run_cycle};
    use ardia_state::BrowserState;
    use ardia_state::sync_engine::scope::ScopeState;
    use parking_lot::Mutex;
    use std::sync::Arc;

    type Installed = Arc<Mutex<Vec<Value>>>;

    fn serve(engine: &fake::FakeEngine, installed: Installed, applied: Arc<Mutex<Vec<Value>>>) {
        engine.answer(move |name, args| match name {
            "ac_extensions_sync_state" => Some(json!({ "ready": true, "extensions": installed.lock().clone(), "pending": [] })),
            "ac_extensions_sync_apply" => {
                applied.lock().push(args.clone());
                let id = args["id"].as_str()?.to_owned();
                let record = &args["record"];
                if record.get("removed").is_none() {
                    let mut list = installed.lock();
                    list.retain(|e| e["id"] != id);
                    list.push(json!({ "id": id, "syncable": true, "version": "1.0", "approved": true, "fingerprint": "fp", "userDisabled": !record["on"].as_bool().unwrap_or(true), "incognito": record["inc"], "pinned": record["pin"] }));
                }
                Some(json!({ "ok": true }))
            }
            _ => None,
        });
    }

    #[test]
    fn approvals_and_versions_follow_the_old_rules() {
        assert!(compare_versions("1.10", "1.9").is_gt());
        assert!(compare_versions("1.0.0", "1").is_eq());
        let e = LocalExtension {
            id: "x".into(),
            syncable: true,
            version: Some("2.0".into()),
            approved: true,
            fingerprint: Some("b".into()),
            ..Default::default()
        };
        assert_eq!(
            approval_to_publish(&e, None),
            Some(Approval {
                v: "2.0".into(),
                fps: vec!["b".into()]
            })
        );
        assert_eq!(
            approval_to_publish(
                &e,
                Some(Approval {
                    v: "2.0".into(),
                    fps: vec!["c".into()]
                })
            ),
            Some(Approval {
                v: "2.0".into(),
                fps: vec!["b".into(), "c".into()]
            })
        );
        assert_eq!(
            approval_to_publish(
                &e,
                Some(Approval {
                    v: "3.0".into(),
                    fps: vec!["c".into()]
                })
            ),
            Some(Approval {
                v: "3.0".into(),
                fps: vec!["c".into()]
            })
        );
    }

    #[test]
    fn an_extension_installed_on_one_mac_installs_on_the_other_and_a_removal_is_a_live_record() {
        let transport = MemoryTransport::default();
        let (a, ea) = fake::context(BrowserState::default(), "AAAA");
        let (b, eb) = fake::context(BrowserState::default(), "BBBB");
        let ia: Installed = Arc::new(Mutex::new(vec![
            json!({ "id": "abc", "syncable": true, "version": "1.0", "approved": true, "fingerprint": "fp", "pinned": true }),
        ]));
        let ib: Installed = Arc::new(Mutex::new(Vec::new()));
        let applied_b = Arc::new(Mutex::new(Vec::new()));
        serve(&ea, ia.clone(), Arc::new(Mutex::new(Vec::new())));
        serve(&eb, ib.clone(), applied_b.clone());
        let profile = ProfileId::default_profile();
        let mut sa = ScopeState {
            joined: true,
            ..ScopeState::default()
        };
        let mut sb = ScopeState {
            joined: true,
            ..ScopeState::default()
        };
        run_cycle(&transport, "p:x", &mut sa, "AAAA", adapter(&a, &profile));
        assert_eq!(
            sa.records["ext:abc"].v,
            json!({ "on": true, "inc": false, "pin": true })
        );
        assert_eq!(
            sa.records["ext:v:abc"].v,
            json!({ "v": "1.0", "fps": ["fp"] })
        );
        run_cycle(&transport, "p:x", &mut sb, "BBBB", adapter(&b, &profile));
        assert_eq!(
            applied_b.lock()[0],
            json!({ "id": "abc", "record": { "on": true, "inc": false, "pin": true }, "approval": { "v": "1.0", "fps": ["fp"] } })
        );
        ia.lock().clear();
        a.memory
            .lock()
            .slot::<IntentStore>(INTENTS_SLOT)
            .note("", "abc", "uninstalled");
        run_cycle(&transport, "p:x", &mut sa, "AAAA", adapter(&a, &profile));
        assert_eq!(sa.records["ext:abc"].v, json!({ "removed": true }));
        run_cycle(&transport, "p:x", &mut sb, "BBBB", adapter(&b, &profile));
        assert_eq!(ib.lock().len(), 1);
        assert_eq!(applied_b.lock().len(), 1);
    }
}
