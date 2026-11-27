use super::canon::{canonical, js_json, utf16_len};
use super::hlc::{Clock, Hlc, hlc_wall};
use crate::json::Fields;
use crate::model::Millis;
use indexmap::{IndexMap, IndexSet};
use serde::de::Deserializer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

pub type Origin = (String, u64);

fn lenient_millis<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Millis, D::Error> {
    crate::json::millis(deserializer)
}

fn applying_batches<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<super::apply_batches::ApplyBatch>>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    let batches = super::apply_batches::valid_batches(Some(&value));
    Ok((!batches.is_empty()).then_some(batches))
}

fn lenient_count<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(count_of(&value).unwrap_or(0))
}

fn count_of(value: &Value) -> Option<u64> {
    let n = value.as_f64()?;
    (n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0)
        .then_some(n as u64)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SyncRecord {
    pub h: Hlc,
    pub v: Value,
    pub o: Origin,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Op {
    pub k: String,
    pub h: Hlc,
    pub v: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LogFile {
    pub v: u8,
    pub kind: String,
    pub device: String,
    pub seq: u64,
    pub at: Millis,
    pub ops: Vec<Op>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SnapshotFile {
    pub v: u8,
    pub kind: String,
    pub device: String,
    pub at: Millis,
    pub vv: BTreeMap<String, u64>,
    pub seen: BTreeMap<String, Millis>,
    pub records: IndexMap<String, SyncRecord>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SyncFile {
    Log(LogFile),
    Snapshot(SnapshotFile),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Log,
    Snapshot,
    Bad,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileMeta {
    pub d: String,
    pub k: FileKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vv: Option<BTreeMap<String, u64>>,
    #[serde(deserialize_with = "lenient_millis")]
    pub at: Millis,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<u64>,
}

#[derive(Default)]
pub struct ScopeRuntime {
    extracted: HashMap<String, (u64, u64, bool)>,
    base_writes: HashMap<String, u64>,
    touched: Option<(HashSet<String>, HashSet<String>)>,
    settling: Vec<Box<dyn FnOnce() + Send>>,
    pub(crate) recovering: HashSet<String>,
    pub(crate) reapplied: u64,
    pub(crate) owed: Vec<super::apply_batches::ApplyBatch>,
}

impl std::fmt::Debug for ScopeRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScopeRuntime").finish()
    }
}

impl Clone for ScopeRuntime {
    fn clone(&self) -> Self {
        ScopeRuntime::default()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeState {
    #[serde(default)]
    pub records: IndexMap<String, SyncRecord>,
    #[serde(default)]
    pub base: IndexMap<String, String>,
    #[serde(default)]
    pub unapplied: Vec<String>,
    #[serde(default)]
    pub vv: BTreeMap<String, u64>,
    #[serde(default)]
    pub extra: BTreeMap<String, Vec<u64>>,
    #[serde(default)]
    pub files: IndexMap<String, FileMeta>,
    #[serde(default)]
    pub damaged: IndexMap<String, Millis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_since: Option<IndexMap<String, Millis>>,
    #[serde(default, deserialize_with = "lenient_count")]
    pub seq: u64,
    #[serde(default)]
    pub outbox: Vec<Op>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journal: Option<Vec<LogFile>>,
    #[serde(default)]
    pub seen: BTreeMap<String, Millis>,
    #[serde(default)]
    pub joined: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub await_remote: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apply_as: Option<IndexMap<String, String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "applying_batches"
    )]
    pub applying: Option<Vec<super::apply_batches::ApplyBatch>>,
    #[serde(default, deserialize_with = "lenient_millis")]
    pub snapshot_at: Millis,
    #[serde(default, deserialize_with = "lenient_count")]
    pub pending: u64,
    #[serde(flatten)]
    pub other: Fields,
    #[serde(skip)]
    pub runtime: ScopeRuntime,
}

impl Default for ScopeState {
    fn default() -> Self {
        ScopeState {
            records: IndexMap::new(),
            base: IndexMap::new(),
            unapplied: Vec::new(),
            vv: BTreeMap::new(),
            extra: BTreeMap::new(),
            files: IndexMap::new(),
            damaged: IndexMap::new(),
            pending_since: None,
            seq: 0,
            outbox: Vec::new(),
            journal: None,
            seen: BTreeMap::new(),
            joined: false,
            await_remote: None,
            apply_as: None,
            applying: None,
            snapshot_at: 0,
            pending: 0,
            other: Fields::new(),
            runtime: ScopeRuntime::default(),
        }
    }
}

impl PartialEq for ScopeState {
    fn eq(&self, other: &Self) -> bool {
        self.records == other.records
            && self.base == other.base
            && self.vv == other.vv
            && self.extra == other.extra
            && self.seq == other.seq
            && self.joined == other.joined
    }
}

impl ScopeState {
    pub fn from_value(value: &Value) -> Option<ScopeState> {
        let fields = value.as_object()?;
        if !fields.get("records").is_some_and(Value::is_object)
            || !fields.get("base").is_some_and(Value::is_object)
        {
            return None;
        }
        let mut cleaned = fields.clone();
        cleaned.remove("applyingIds");
        cleaned.remove("applyingTrimmed");
        let state: ScopeState = serde_json::from_value(Value::Object(cleaned)).ok()?;
        Some(state)
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    pub fn rest_value(&self) -> Value {
        let mut value = self.to_value();
        if let Value::Object(map) = &mut value {
            map.shift_remove("records");
            map.shift_remove("base");
            map.shift_remove("applying");
            super::apply_batches::rest_with_applying(self, map);
        }
        value
    }

    pub fn put_record(&mut self, key: &str, record: SyncRecord) {
        self.records.insert(key.to_owned(), record);
        if let Some((records, _)) = &mut self.runtime.touched {
            records.insert(key.to_owned());
        }
    }

    pub fn drop_record(&mut self, key: &str) {
        if self.records.shift_remove(key).is_some()
            && let Some((records, _)) = &mut self.runtime.touched
        {
            records.insert(key.to_owned());
        }
    }

    fn count_base_write(&mut self, key: &str) {
        if let Some((_, base)) = &mut self.runtime.touched {
            base.insert(key.to_owned());
        }
        for (prefix, count) in self.runtime.base_writes.iter_mut() {
            if key.starts_with(prefix.as_str()) {
                *count += 1;
            }
        }
    }

    pub fn put_base(&mut self, key: &str, json: String) {
        if self.base.get(key) == Some(&json) {
            return;
        }
        self.base.insert(key.to_owned(), json);
        self.count_base_write(key);
    }

    pub fn drop_base(&mut self, key: &str) {
        if self.base.shift_remove(key).is_some() {
            self.count_base_write(key);
        }
    }

    pub fn base_writes_under(&mut self, prefix: &str) -> u64 {
        *self
            .runtime
            .base_writes
            .entry(prefix.to_owned())
            .or_insert(0)
    }

    pub fn track_touched(&mut self) {
        self.runtime.touched = Some((HashSet::new(), HashSet::new()));
    }

    pub fn take_touched(&mut self) -> (HashSet<String>, HashSet<String>) {
        self.runtime.touched.take().unwrap_or_default()
    }

    pub fn visible(&self, prefix: &str) -> IndexMap<String, Value> {
        self.records
            .iter()
            .filter(|(key, record)| key.starts_with(prefix) && !record.v.is_null())
            .map(|(key, record)| (key.clone(), record.v.clone()))
            .collect()
    }

    pub fn records_with(&self, prefix: &str) -> Vec<(&String, &SyncRecord)> {
        self.records
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .collect()
    }

    pub fn base_keys_with(&self, prefix: &str) -> Vec<String> {
        self.base
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect()
    }

    pub fn base_value(&self, key: &str) -> Option<Value> {
        self.base
            .get(key)
            .and_then(|json| serde_json::from_str(json).ok())
    }

    pub fn written_seq(&self) -> u64 {
        self.seq
            .saturating_sub(self.journal.as_ref().map_or(0, Vec::len) as u64)
    }

    fn see(&mut self, device: &str, at: Millis) {
        let known = self.seen.get(device).copied();
        if known.is_none_or(|k| at > k) {
            self.seen.insert(device.to_owned(), at);
        }
    }
}

pub fn covered(vv: &BTreeMap<String, u64>, origin: (&str, u64)) -> bool {
    vv.get(origin.0).copied().unwrap_or(0) >= origin.1
}

pub fn is_applied(state: &ScopeState, origin: (&str, u64)) -> bool {
    if covered(&state.vv, origin) {
        return true;
    }
    state
        .extra
        .get(origin.0)
        .is_some_and(|extra| extra.binary_search(&origin.1).is_ok())
}

pub fn mark_applied(state: &mut ScopeState, device: &str, seq: u64) {
    if covered(&state.vv, (device, seq)) {
        return;
    }
    let mut extra = state.extra.remove(device).unwrap_or_default();
    if let Err(at) = extra.binary_search(&seq) {
        extra.insert(at, seq);
    }
    let mut top = state.vv.get(device).copied().unwrap_or(0);
    let mut taken = 0;
    while extra.get(taken) == Some(&(top + 1)) {
        top = extra[taken];
        taken += 1;
    }
    state.vv.insert(device.to_owned(), top);
    let left: Vec<u64> = extra.split_off(taken);
    if !left.is_empty() {
        state.extra.insert(device.to_owned(), left);
    }
}

pub fn raise_applied(state: &mut ScopeState, device: &str, seq: u64) {
    if seq <= state.vv.get(device).copied().unwrap_or(0) {
        return;
    }
    state.vv.insert(device.to_owned(), seq);
    let extra: Vec<u64> = state
        .extra
        .remove(device)
        .unwrap_or_default()
        .into_iter()
        .filter(|s| *s > seq)
        .collect();
    let mut taken = 0;
    let mut top = seq;
    while extra.get(taken) == Some(&(top + 1)) {
        top += 1;
        state.vv.insert(device.to_owned(), extra[taken]);
        taken += 1;
    }
    let left = extra[taken..].to_vec();
    if !left.is_empty() {
        state.extra.insert(device.to_owned(), left);
    }
}

fn is_count(v: &Value) -> bool {
    v.as_u64().is_some() || count_of(v).is_some()
}

fn is_time(v: &Value) -> bool {
    v.as_f64().is_some_and(f64::is_finite)
}

fn has_value(o: &serde_json::Map<String, Value>) -> bool {
    o.contains_key("v")
}

fn is_op(v: &Value) -> bool {
    v.as_object().is_some_and(|o| {
        o.get("k").is_some_and(Value::is_string)
            && o.get("h").is_some_and(Value::is_string)
            && has_value(o)
    })
}

fn is_origin(v: &Value) -> bool {
    v.as_array()
        .is_some_and(|a| a.len() == 2 && a[0].is_string() && is_count(&a[1]))
}

fn is_record(v: &Value) -> bool {
    v.as_object().is_some_and(|o| {
        o.get("h").is_some_and(Value::is_string)
            && o.get("o").is_some_and(is_origin)
            && has_value(o)
    })
}

fn map_of(v: Option<&Value>, item: fn(&Value) -> bool) -> bool {
    v.and_then(Value::as_object)
        .is_some_and(|o| o.values().all(item))
}

fn origin_of(v: &Value) -> Origin {
    let list = v.as_array();
    let device = list
        .and_then(|l| l.first())
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let seq = list.and_then(|l| l.get(1)).and_then(count_of).unwrap_or(0);
    (device, seq)
}

fn millis_of(v: &Value) -> Millis {
    crate::json::as_millis(v).unwrap_or(0)
}

pub fn parse_sync_file(payload: &str) -> Option<SyncFile> {
    let file: Value = serde_json::from_str(payload).ok()?;
    let o = file.as_object()?;
    if o.get("v").and_then(Value::as_f64) != Some(1.0)
        || !o.get("device").is_some_and(Value::is_string)
        || !o.get("at").is_some_and(is_time)
    {
        return None;
    }
    let device = o["device"].as_str()?.to_owned();
    let at = millis_of(&o["at"]);
    match o.get("kind").and_then(Value::as_str) {
        Some("log") => {
            let seq = o.get("seq").filter(|v| is_count(v)).and_then(count_of)?;
            let ops = o.get("ops")?.as_array()?;
            if !ops.iter().all(is_op) {
                return None;
            }
            let ops = ops
                .iter()
                .map(|op| Op {
                    k: op["k"].as_str().unwrap_or_default().to_owned(),
                    h: op["h"].as_str().unwrap_or_default().to_owned(),
                    v: op["v"].clone(),
                })
                .collect();
            Some(SyncFile::Log(LogFile {
                v: 1,
                kind: "log".into(),
                device,
                seq,
                at,
                ops,
            }))
        }
        Some("snapshot") => {
            if !map_of(o.get("vv"), is_count)
                || !map_of(o.get("seen"), is_time)
                || !map_of(o.get("records"), is_record)
            {
                return None;
            }
            let vv = o["vv"]
                .as_object()?
                .iter()
                .map(|(k, v)| (k.clone(), count_of(v).unwrap_or(0)))
                .collect();
            let seen = o["seen"]
                .as_object()?
                .iter()
                .map(|(k, v)| (k.clone(), millis_of(v)))
                .collect();
            let records = o["records"]
                .as_object()?
                .iter()
                .map(|(k, r)| {
                    (
                        k.clone(),
                        SyncRecord {
                            h: r["h"].as_str().unwrap_or_default().to_owned(),
                            v: r["v"].clone(),
                            o: origin_of(&r["o"]),
                        },
                    )
                })
                .collect();
            Some(SyncFile::Snapshot(SnapshotFile {
                v: 1,
                kind: "snapshot".into(),
                device,
                at,
                vv,
                seen,
                records,
            }))
        }
        _ => None,
    }
}

pub fn log_payload(file: &LogFile) -> String {
    let mut out = format!(
        "{{\"v\":1,\"kind\":\"log\",\"device\":{},\"seq\":{},\"at\":{},\"ops\":[",
        js_json(&Value::from(file.device.clone())),
        file.seq,
        file.at
    );
    for (i, op) in file.ops.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{{\"k\":{},\"h\":{},\"v\":{}}}",
            js_json(&Value::from(op.k.clone())),
            js_json(&Value::from(op.h.clone())),
            js_json(&op.v)
        ));
    }
    out.push_str("]}");
    out
}

pub fn snapshot_payload(file: &SnapshotFile) -> String {
    let mut out = format!(
        "{{\"v\":1,\"kind\":\"snapshot\",\"device\":{},\"at\":{},\"vv\":{},\"seen\":{},\"records\":{{",
        js_json(&Value::from(file.device.clone())),
        file.at,
        serde_json::to_string(&file.vv).unwrap_or_else(|_| "{}".into()),
        serde_json::to_string(&file.seen).unwrap_or_else(|_| "{}".into())
    );
    for (i, (key, record)) in file.records.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{}:{{\"h\":{},\"v\":{},\"o\":[{},{}]}}",
            js_json(&Value::from(key.clone())),
            js_json(&Value::from(record.h.clone())),
            js_json(&record.v),
            js_json(&Value::from(record.o.0.clone())),
            record.o.1
        ));
    }
    out.push_str("}}");
    out
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Listing {
    pub files: Vec<(String, String)>,
    pub pending: Vec<String>,
    pub damaged: Vec<(String, Millis)>,
    pub present: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransportError {
    #[error(
        "The sync folder can’t be read. Check that it’s still there and that Ardia can open it."
    )]
    Unreadable(String),
    #[error("{0}")]
    Failed(String),
}

pub trait Transport {
    fn write(&self, scope: &str, payload: &str) -> Result<String, TransportError>;
    fn read(&self, scope: &str, known: &[String]) -> Result<Listing, TransportError>;
    fn remove(&self, scope: &str, ids: &[String]) -> Result<(), TransportError>;
}

pub type KeyTest = Box<dyn Fn(&str) -> bool>;
pub type Settle = Box<dyn FnOnce(&HashSet<String>) + Send>;
pub type JsonOf = Box<dyn Fn(&str, &Value) -> Option<String>>;
pub type Expiry<'a> = &'a dyn Fn(&str, &Value, Millis) -> bool;

pub struct Extraction {
    pub values: IndexMap<String, Value>,
    pub ignore: Option<KeyTest>,
    pub republish: Option<KeyTest>,
    pub published: Option<Settle>,
    pub json: Option<JsonOf>,
}

impl Extraction {
    pub fn of(values: IndexMap<String, Value>) -> Extraction {
        Extraction {
            values,
            ignore: None,
            republish: None,
            published: None,
            json: None,
        }
    }

    pub fn ignoring(mut self, ignore: impl Fn(&str) -> bool + 'static) -> Extraction {
        self.ignore = Some(Box::new(ignore));
        self
    }

    pub fn republishing(mut self, republish: impl Fn(&str) -> bool + 'static) -> Extraction {
        self.republish = Some(Box::new(republish));
        self
    }

    pub fn on_published(
        mut self,
        published: impl FnOnce(&HashSet<String>) + Send + 'static,
    ) -> Extraction {
        self.published = Some(Box::new(published));
        self
    }
}

pub struct ExtractContext<'a> {
    state: &'a ScopeState,
    overrides: Option<&'a super::apply_batches::Overrides>,
    queued: std::cell::OnceCell<HashSet<String>>,
    pub now: Millis,
}

impl<'a> ExtractContext<'a> {
    pub fn new(state: &'a ScopeState, now: Millis) -> Self {
        ExtractContext {
            state,
            overrides: None,
            queued: std::cell::OnceCell::new(),
            now,
        }
    }

    pub fn with_overrides(
        state: &'a ScopeState,
        now: Millis,
        overrides: &'a super::apply_batches::Overrides,
    ) -> Self {
        let mut cx = ExtractContext::new(state, now);
        cx.overrides = Some(overrides);
        cx
    }

    pub fn base(&self, key: &str) -> Option<Value> {
        self.base_json(key)
            .and_then(|json| serde_json::from_str(json).ok())
    }

    pub fn base_json(&self, key: &str) -> Option<&str> {
        match self.overrides.and_then(|o| o.get(key)) {
            Some(json) => json.as_deref(),
            None => self.state.base.get(key).map(String::as_str),
        }
    }

    pub fn base_keys(&self, prefix: &str) -> Vec<String> {
        self.state.base_keys_with(prefix)
    }

    pub fn queued(&self, key: &str) -> bool {
        self.queued
            .get_or_init(|| {
                self.state
                    .outbox
                    .iter()
                    .chain(
                        self.state
                            .journal
                            .iter()
                            .flatten()
                            .flat_map(|f| f.ops.iter()),
                    )
                    .map(|op| op.k.clone())
                    .collect()
            })
            .contains(key)
    }

    pub fn known(&self, key: &str) -> bool {
        self.state.records.contains_key(key)
    }

    pub fn remote(&self, key: &str) -> Option<&Value> {
        self.state.records.get(key).map(|r| &r.v)
    }

    pub fn stamp(&self, key: &str) -> Option<&str> {
        self.state.records.get(key).map(|r| r.h.as_str())
    }

    pub fn state(&self) -> &ScopeState {
        self.state
    }
}

pub struct ApplyRecords<'a> {
    state: &'a ScopeState,
    pub now: Millis,
    pub horizon: Millis,
    pub joined: bool,
    held: &'a dyn Fn() -> bool,
    landed: std::cell::RefCell<HashSet<String>>,
    deferred: std::cell::RefCell<HashSet<String>>,
}

impl<'a> ApplyRecords<'a> {
    pub fn new(
        state: &'a ScopeState,
        now: Millis,
        horizon: Millis,
        joined: bool,
        held: &'a dyn Fn() -> bool,
    ) -> Self {
        ApplyRecords {
            state,
            now,
            horizon,
            joined,
            held,
            landed: Default::default(),
            deferred: Default::default(),
        }
    }

    pub fn known(&self, key: &str) -> bool {
        self.state.records.contains_key(key)
    }

    pub fn base(&self, key: &str) -> Option<Value> {
        self.state.base_value(key)
    }

    pub fn record(&self, key: &str) -> Option<&SyncRecord> {
        self.state.records.get(key)
    }

    pub fn state(&self) -> &ScopeState {
        self.state
    }

    pub fn held(&self) -> bool {
        (self.held)()
    }

    pub fn landed(&self, key: &str) {
        self.landed.borrow_mut().insert(key.to_owned());
    }

    pub fn defer(&self, key: &str) {
        self.deferred.borrow_mut().insert(key.to_owned());
    }

    pub fn deferred_keys(&self) -> HashSet<String> {
        self.deferred.borrow().clone()
    }
}

pub trait Adapter {
    fn prefix(&self) -> &str;
    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction>;
    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        records: &ApplyRecords,
    ) -> bool;
    fn edited_at(&self, _value: &Value) -> Option<Millis> {
        None
    }
    fn extracts_only_from(&self) -> Option<u64> {
        None
    }
    fn adopt_remote_on_join(&self) -> bool {
        false
    }
    fn publish_after_pull(&self) -> bool {
        false
    }
    fn extract_uses_base(&self) -> bool {
        false
    }
    fn saves_whole(&self) -> bool {
        false
    }
}

pub type Persist<'a> = dyn FnMut(&[LogFile]) -> Result<(), TransportError> + 'a;

pub struct ScopeOptions<'a> {
    pub expired: Option<Expiry<'a>>,
    pub tombstone_ttl: Millis,
    pub compact_after_files: usize,
    pub compact_after_logs: usize,
    pub compact_log_share: f64,
    pub compact_interval: Millis,
    pub prune_grace: Millis,
    pub damaged_give_up: Millis,
    pub persist: Option<Box<Persist<'a>>>,
    pub hold_apply: Option<&'a dyn Fn() -> bool>,
    pub persist_applying: Option<Box<super::apply_batches::PersistApplying<'a>>>,
    pub launch: String,
    pub monotonic: fn() -> f64,
    pub native_save_ms: f64,
}

pub fn this_launch() -> &'static str {
    static LAUNCH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    LAUNCH.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        format!(
            "{:x}-{:08x}",
            crate::store::now_ms(),
            (nanos as u64 ^ u64::from(std::process::id())) as u32
        )
    })
}

pub fn steady_ms() -> f64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs_f64()
        * 1000.0
}

impl Default for ScopeOptions<'_> {
    fn default() -> Self {
        ScopeOptions {
            expired: None,
            tombstone_ttl: 45 * 86_400_000,
            compact_after_files: 40,
            compact_after_logs: 400,
            compact_log_share: 0.25,
            compact_interval: 10 * 60_000,
            prune_grace: 60 * 60_000,
            damaged_give_up: 86_400_000,
            persist: None,
            hold_apply: None,
            persist_applying: None,
            launch: this_launch().to_owned(),
            monotonic: steady_ms,
            native_save_ms: super::apply_batches::NATIVE_SAVE_MS,
        }
    }
}

impl ScopeOptions<'_> {
    fn held(&self) -> bool {
        self.hold_apply.is_some_and(|held| held())
    }
}

fn merge_record(state: &mut ScopeState, key: &str, record: SyncRecord, clock: &mut Clock) -> bool {
    clock.observe(&record.h);
    if state
        .records
        .get(key)
        .is_some_and(|current| current.h >= record.h)
    {
        return false;
    }
    state.put_record(key, record);
    true
}

fn ingest_log(
    state: &mut ScopeState,
    file: &LogFile,
    clock: &mut Clock,
    changed: &mut IndexSet<String>,
) {
    state.see(&file.device, file.at);
    if is_applied(state, (&file.device, file.seq)) {
        return;
    }
    for op in &file.ops {
        let record = SyncRecord {
            h: op.h.clone(),
            v: op.v.clone(),
            o: (file.device.clone(), file.seq),
        };
        if merge_record(state, &op.k, record, clock) {
            changed.insert(op.k.clone());
        }
    }
    mark_applied(state, &file.device, file.seq);
}

pub fn ingest_snapshot(
    state: &mut ScopeState,
    file: &SnapshotFile,
    clock: &mut Clock,
    changed: &mut IndexSet<String>,
) {
    for (device, at) in &file.seen {
        state.see(device, *at);
    }
    state.see(&file.device, file.at);
    for (key, record) in &file.records {
        if !state.records.contains_key(key) && is_applied(state, (&record.o.0, record.o.1)) {
            continue;
        }
        if merge_record(state, key, record.clone(), clock) {
            changed.insert(key.clone());
        }
    }
    let gone: Vec<String> = state
        .records
        .iter()
        .filter(|(key, record)| {
            !file.records.contains_key(*key) && covered(&file.vv, (&record.o.0, record.o.1))
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in gone {
        state.drop_record(&key);
        changed.insert(key);
    }
    for (device, seq) in &file.vv {
        raise_applied(state, device, *seq);
    }
}

struct Change {
    key: String,
    value: Value,
    json: String,
}

struct Found {
    changes: Vec<Change>,
    settle: Option<Settle>,
    source: Option<u64>,
}

fn changes_of(
    state: &mut ScopeState,
    adapter: &mut dyn Adapter,
    now: Millis,
    launch: &str,
) -> Option<Found> {
    if adapter.adopt_remote_on_join() && !state.joined {
        return None;
    }
    let prefix = adapter.prefix().to_owned();
    let source = adapter.extracts_only_from();
    if let Some(source) = source {
        let writes = state.base_writes_under(&prefix);
        if state.runtime.extracted.get(&prefix) == Some(&(source, writes, state.joined)) {
            return Some(Found {
                changes: Vec::new(),
                settle: None,
                source: None,
            });
        }
    }
    let first = {
        let cx = ExtractContext::new(state, now);
        adapter.extract(&cx)?
    };
    let extraction = if state.applying.is_some() {
        let uses_base = adapter.extract_uses_base();
        let saves_whole = adapter.saves_whole();
        let mut again = |state: &ScopeState, overrides: &super::apply_batches::Overrides| {
            let cx = ExtractContext::with_overrides(state, now, overrides);
            adapter.extract(&cx)
        };
        super::apply_batches::recover_batches(
            state,
            &prefix,
            first,
            &mut again,
            uses_base,
            saves_whole,
            launch,
        )?
    } else {
        first
    };
    let unsettled = super::apply_batches::failed_targets(state, &prefix, launch);
    let Extraction {
        values,
        ignore,
        republish,
        published,
        json,
    } = extraction;
    let mut changes = Vec::new();
    let mut live: HashSet<String> = HashSet::new();
    for (key, value) in values {
        live.insert(key.clone());
        if value.is_null() {
            continue;
        }
        let text = json
            .as_ref()
            .and_then(|j| j(&key, &value))
            .unwrap_or_else(|| canonical(&value));
        if unsettled
            .as_ref()
            .is_some_and(|u| u.get(&key).is_some_and(|held| held.contains(&text)))
        {
            continue;
        }
        if state.base.get(&key) == Some(&text)
            && (!republish.as_ref().is_some_and(|r| r(&key))
                || super::apply_batches::awaits_recovery(state, &key))
        {
            continue;
        }
        changes.push(Change {
            key,
            value,
            json: text,
        });
    }
    for key in state.base_keys_with(&prefix) {
        if live.contains(&key)
            || ignore.as_ref().is_some_and(|i| i(&key))
            || unsettled
                .as_ref()
                .is_some_and(|u| u.get(&key).is_some_and(|held| held.contains("null")))
        {
            continue;
        }
        changes.push(Change {
            key,
            value: Value::Null,
            json: "null".into(),
        });
    }
    Some(Found {
        changes,
        settle: published,
        source,
    })
}

fn stamp_of(state: &ScopeState, adapter: &dyn Adapter, clock: &mut Clock, change: &Change) -> Hlc {
    let edited = if !state.records.contains_key(&change.key) && !change.value.is_null() {
        adapter.edited_at(&change.value)
    } else {
        None
    };
    match edited {
        Some(at) => clock.at(at),
        None => clock.tick(),
    }
}

type Stamps = HashMap<String, (String, Hlc)>;

fn candidate_stamps(
    state: &mut ScopeState,
    adapter: &mut dyn Adapter,
    clock: &mut Clock,
    now: Millis,
    launch: &str,
) -> Stamps {
    let Some(found) = changes_of(state, adapter, now, launch) else {
        return Stamps::new();
    };
    found
        .changes
        .iter()
        .map(|change| {
            (
                change.key.clone(),
                (change.json.clone(), stamp_of(state, adapter, clock, change)),
            )
        })
        .collect()
}

fn publish_adapter(
    state: &mut ScopeState,
    adapter: &mut dyn Adapter,
    clock: &mut Clock,
    device: &str,
    now: Millis,
    stamps: Option<&Stamps>,
    launch: &str,
) -> HashSet<String> {
    let mut published = HashSet::new();
    let Some(found) = changes_of(state, adapter, now, launch) else {
        return published;
    };
    for change in &found.changes {
        if change.value.is_null() {
            state.drop_base(&change.key);
        } else {
            state.put_base(&change.key, change.json.clone());
        }
        let h = match stamps.and_then(|s| s.get(&change.key)) {
            Some((json, h)) if *json == change.json => h.clone(),
            _ => stamp_of(state, adapter, clock, change),
        };
        if state
            .records
            .get(&change.key)
            .is_some_and(|known| known.h >= h)
        {
            continue;
        }
        let record = SyncRecord {
            h: h.clone(),
            v: change.value.clone(),
            o: (device.to_owned(), state.seq + 1),
        };
        state.put_record(&change.key, record);
        state.outbox.push(Op {
            k: change.key.clone(),
            h,
            v: change.value.clone(),
        });
        published.insert(change.key.clone());
    }
    if let Some(source) = found.source {
        let prefix = adapter.prefix().to_owned();
        let writes = state.base_writes_under(&prefix);
        let joined = state.joined;
        state
            .runtime
            .extracted
            .insert(prefix, (source, writes, joined));
    }
    if let Some(settle) = found.settle
        && !published.is_empty()
    {
        let keys = published.clone();
        state.runtime.settling.push(Box::new(move || settle(&keys)));
    }
    published
}

fn settle_durable(state: &mut ScopeState) {
    for settle in std::mem::take(&mut state.runtime.settling) {
        settle();
    }
}

pub fn flush(
    state: &mut ScopeState,
    transport: &dyn Transport,
    scope: &str,
    device: &str,
    now: Millis,
    options: &mut ScopeOptions,
) -> Result<(), TransportError> {
    if !state.outbox.is_empty() {
        state.seq += 1;
        let ops = std::mem::take(&mut state.outbox);
        state.journal.get_or_insert_with(Vec::new).push(LogFile {
            v: 1,
            kind: "log".into(),
            device: device.to_owned(),
            seq: state.seq,
            at: now,
            ops,
        });
    }
    if state.journal.as_ref().is_none_or(Vec::is_empty) {
        state.journal = None;
        return Ok(());
    }
    if let Some(persist) = options.persist.as_mut() {
        persist(state.journal.as_deref().unwrap_or_default())?;
        settle_durable(state);
    }
    while let Some(file) = state.journal.as_ref().and_then(|j| j.first()).cloned() {
        let payload = log_payload(&file);
        let id = transport.write(scope, &payload)?;
        state.files.insert(
            id,
            FileMeta {
                d: file.device.clone(),
                k: FileKind::Log,
                s: Some(file.seq),
                vv: None,
                at: file.at,
                b: Some(utf16_len(&payload)),
            },
        );
        if let Some(journal) = state.journal.as_mut() {
            journal.remove(0);
        }
        mark_applied(state, &file.device, file.seq);
        state.see(&file.device, now);
    }
    state.journal = None;
    settle_durable(state);
    Ok(())
}

pub fn restore_journal(
    state: &mut ScopeState,
    batches: &[LogFile],
    clock: &mut Clock,
    written: u64,
) {
    let saved = state.seq;
    let mut sorted: Vec<&LogFile> = batches.iter().collect();
    sorted.sort_by_key(|f| f.seq);
    for file in sorted {
        if file.seq <= state.seq {
            continue;
        }
        if file.seq == saved + 1 {
            state.outbox.clear();
        }
        for op in &file.ops {
            merge_record(
                state,
                &op.k,
                SyncRecord {
                    h: op.h.clone(),
                    v: op.v.clone(),
                    o: (file.device.clone(), file.seq),
                },
                clock,
            );
            if op.v.is_null() {
                state.drop_base(&op.k);
            } else {
                state.put_base(&op.k, canonical(&op.v));
            }
        }
        state.seq = file.seq;
        if file.seq <= written {
            mark_applied(state, &file.device, file.seq);
        } else {
            state
                .journal
                .get_or_insert_with(Vec::new)
                .push(file.clone());
        }
    }
    state.seq = state.seq.max(written);
}

pub fn note_file_health(
    state: &mut ScopeState,
    read: &[String],
    unreadable: &[String],
    pending: &[String],
    present: &HashSet<String>,
    now: Millis,
    give_up: Millis,
) {
    let set_aside =
        |state: &ScopeState, id: &str| state.files.get(id).is_some_and(|f| f.k == FileKind::Bad);
    for id in read {
        state.damaged.shift_remove(id);
    }
    for id in unreadable {
        if set_aside(state, id) {
            continue;
        }
        let since = state.damaged.get(id).copied().unwrap_or(now).min(now);
        if now - since > give_up {
            state.files.insert(
                id.clone(),
                FileMeta {
                    d: String::new(),
                    k: FileKind::Bad,
                    s: None,
                    vv: None,
                    at: now,
                    b: None,
                },
            );
            state.damaged.shift_remove(id);
        } else {
            state.damaged.insert(id.clone(), since);
        }
    }
    state.damaged.retain(|id, _| present.contains(id));
    let pending: Vec<&String> = pending.iter().filter(|id| !set_aside(state, id)).collect();
    state.pending = pending.len() as u64;
    if pending.is_empty() {
        state.pending_since = None;
    } else {
        let before = state.pending_since.take().unwrap_or_default();
        state.pending_since = Some(
            pending
                .iter()
                .map(|id| {
                    (
                        (*id).clone(),
                        before.get(*id).copied().unwrap_or(now).min(now),
                    )
                })
                .collect(),
        );
    }
}

pub fn holds_back(state: &ScopeState, now: Millis, window: Millis) -> bool {
    !state.damaged.is_empty()
        || state
            .pending_since
            .as_ref()
            .is_some_and(|p| p.values().any(|at| now - at <= window))
}

pub fn pull_settled(state: &ScopeState) -> bool {
    state.pending == 0
        && state.damaged.is_empty()
        && !state.files.values().any(|f| f.k == FileKind::Bad)
}

pub fn pull(
    state: &mut ScopeState,
    transport: &dyn Transport,
    scope: &str,
    clock: &mut Clock,
    now: Millis,
    options: &ScopeOptions,
) -> Result<IndexSet<String>, TransportError> {
    let known: Vec<String> = state
        .files
        .iter()
        .filter(|(_, f)| f.k != FileKind::Bad)
        .map(|(id, _)| id.clone())
        .collect();
    let listing = transport.read(scope, &known)?;
    let mut changed = IndexSet::new();
    let mut unreadable: Vec<String> = listing.damaged.iter().map(|(id, _)| id.clone()).collect();
    let mut parsed: Vec<(String, SyncFile, u64)> = Vec::new();
    for (id, payload) in &listing.files {
        match parse_sync_file(payload) {
            Some(file) => parsed.push((id.clone(), file, utf16_len(payload))),
            None => unreadable.push(id.clone()),
        }
    }
    parsed.sort_by_key(|(_, file, _)| match file {
        SyncFile::Snapshot(_) => 0,
        SyncFile::Log(_) => 1,
    });
    for (id, file, b) in &parsed {
        match file {
            SyncFile::Snapshot(snapshot) => {
                ingest_snapshot(state, snapshot, clock, &mut changed);
                state.files.insert(
                    id.clone(),
                    FileMeta {
                        d: snapshot.device.clone(),
                        k: FileKind::Snapshot,
                        s: None,
                        vv: Some(snapshot.vv.clone()),
                        at: snapshot.at,
                        b: Some(*b),
                    },
                );
            }
            SyncFile::Log(log) => {
                ingest_log(state, log, clock, &mut changed);
                state.files.insert(
                    id.clone(),
                    FileMeta {
                        d: log.device.clone(),
                        k: FileKind::Log,
                        s: Some(log.seq),
                        vv: None,
                        at: log.at,
                        b: Some(*b),
                    },
                );
            }
        }
    }
    let present: HashSet<String> = listing.present.iter().cloned().collect();
    state.files.retain(|id, _| present.contains(id));
    let read: Vec<String> = parsed.iter().map(|(id, _, _)| id.clone()).collect();
    note_file_health(
        state,
        &read,
        &unreadable,
        &listing.pending,
        &present,
        now,
        options.damaged_give_up,
    );
    Ok(changed)
}

fn dominates(vv: &BTreeMap<String, u64>, other: &BTreeMap<String, u64>) -> bool {
    other
        .iter()
        .all(|(d, s)| vv.get(d).copied().unwrap_or(0) >= *s)
}

pub fn newest_snapshot<'a>(
    files: &'a IndexMap<String, FileMeta>,
    device: Option<&str>,
) -> Option<(&'a String, &'a FileMeta)> {
    let mut newest: Option<(&String, &FileMeta)> = None;
    for (id, f) in files {
        if f.k == FileKind::Snapshot
            && device.is_none_or(|d| f.d == d)
            && newest.is_none_or(|(_, n)| f.at > n.at)
        {
            newest = Some((id, f));
        }
    }
    newest
}

pub fn retired_by(
    files: &IndexMap<String, FileMeta>,
    snapshot_id: &str,
    vv: &BTreeMap<String, u64>,
    now: Millis,
    prune_grace: Millis,
    with_snapshots: bool,
) -> Vec<String> {
    files
        .iter()
        .filter(|(id, f)| {
            if id.as_str() == snapshot_id || now - f.at < prune_grace {
                return false;
            }
            match f.k {
                FileKind::Log => covered(vv, (&f.d, f.s.unwrap_or(u64::MAX))),
                FileKind::Snapshot => {
                    with_snapshots && dominates(vv, f.vv.as_ref().unwrap_or(&BTreeMap::new()))
                }
                FileKind::Bad => false,
            }
        })
        .map(|(id, _)| id.clone())
        .collect()
}

fn prune(
    state: &mut ScopeState,
    transport: &dyn Transport,
    scope: &str,
    ids: Vec<String>,
) -> Result<(), TransportError> {
    if ids.is_empty() {
        return Ok(());
    }
    transport.remove(scope, &ids)?;
    for id in ids {
        state.files.shift_remove(&id);
    }
    Ok(())
}

pub fn compaction_due(state: &ScopeState, now: Millis, options: &ScopeOptions) -> bool {
    let latest = newest_snapshot(&state.files, None);
    if now - state.snapshot_at.max(latest.map_or(0, |(_, f)| f.at)) < options.compact_interval {
        return false;
    }
    let empty = BTreeMap::new();
    let base = latest.and_then(|(_, f)| f.vv.as_ref()).unwrap_or(&empty);
    let mut logs = 0usize;
    let mut log_bytes = 0u64;
    for f in state.files.values() {
        let seq = f.s.unwrap_or(u64::MAX);
        if f.k != FileKind::Log || covered(base, (&f.d, seq)) || !covered(&state.vv, (&f.d, seq)) {
            continue;
        }
        logs += 1;
        log_bytes += f.b.unwrap_or(0);
    }
    if logs <= options.compact_after_files {
        return false;
    }
    logs >= options.compact_after_logs
        || log_bytes as f64
            >= options.compact_log_share * latest.and_then(|(_, f)| f.b).unwrap_or(0) as f64
}

pub fn compact(
    state: &mut ScopeState,
    transport: &dyn Transport,
    scope: &str,
    device: &str,
    now: Millis,
    options: &mut ScopeOptions,
    force: bool,
) -> Result<bool, TransportError> {
    if !force && !compaction_due(state, now, options) {
        if let Some((id, own)) = newest_snapshot(&state.files, Some(device)) {
            let ids = retired_by(
                &state.files,
                id,
                own.vv.as_ref().unwrap_or(&BTreeMap::new()),
                now,
                options.prune_grace,
                false,
            );
            let _ = prune(state, transport, scope, ids);
        }
        return Ok(false);
    }
    flush(state, transport, scope, device, now, options)?;
    let ttl = if state.extra.is_empty() {
        options.tombstone_ttl
    } else {
        2 * options.tombstone_ttl
    };
    let mut records = IndexMap::new();
    let mut dropped = Vec::new();
    for (key, record) in &state.records {
        let drop = if record.v.is_null() {
            now - hlc_wall(&record.h) > ttl
        } else {
            options
                .expired
                .is_some_and(|expired| expired(key, &record.v, now))
        };
        if drop {
            dropped.push(key.clone());
        } else {
            records.insert(key.clone(), record.clone());
        }
    }
    for key in dropped {
        state.drop_record(&key);
    }
    let vv = state.vv.clone();
    let file = SnapshotFile {
        v: 1,
        kind: "snapshot".into(),
        device: device.to_owned(),
        at: now,
        vv: vv.clone(),
        seen: state.seen.clone(),
        records,
    };
    let payload = snapshot_payload(&file);
    let id = transport.write(scope, &payload)?;
    state.files.insert(
        id.clone(),
        FileMeta {
            d: device.to_owned(),
            k: FileKind::Snapshot,
            s: None,
            vv: Some(vv.clone()),
            at: now,
            b: Some(utf16_len(&payload)),
        },
    );
    state.snapshot_at = now;
    let ids = retired_by(&state.files, &id, &vv, now, options.prune_grace, true);
    prune(state, transport, scope, ids)?;
    Ok(true)
}

fn apply_adapter(
    state: &mut ScopeState,
    adapter: &mut dyn Adapter,
    keys: &mut IndexSet<String>,
    now: Millis,
    horizon: Millis,
    held: &dyn Fn() -> bool,
    deferred: &mut HashSet<String>,
) -> bool {
    let prefix = adapter.prefix().to_owned();
    let mine: IndexSet<String> = keys
        .iter()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();
    if mine.is_empty() {
        return true;
    }
    let view = state.visible(&prefix);
    let joined_now = state.joined;
    let apply_as = state.apply_as.get_or_insert_with(IndexMap::new);
    let mode = apply_as
        .entry(prefix.clone())
        .or_insert_with(|| {
            if joined_now {
                "joined".into()
            } else {
                "joining".into()
            }
        })
        .clone();
    let (ok, landed, deferred_here) = if held() {
        (false, HashSet::new(), HashSet::new())
    } else {
        let records = ApplyRecords::new(state, now, horizon, mode == "joined", held);
        let ok = adapter.apply(&view, &mine, &records);
        (ok, records.landed.borrow().clone(), records.deferred_keys())
    };
    for key in deferred_here {
        if mine.contains(&key) {
            deferred.insert(key);
        }
    }
    let settle = |state: &mut ScopeState, key: &str| match view.get(key) {
        Some(value) => state.put_base(key, canonical(value)),
        None => state.drop_base(key),
    };
    let changing: HashSet<String> = mine
        .iter()
        .filter(|key| {
            state.base.get(*key).map(String::as_str).unwrap_or("null")
                != view.get(*key).map_or_else(|| "null".to_owned(), canonical)
        })
        .cloned()
        .collect();
    if !ok || held() {
        let mut settled = Vec::new();
        for key in landed {
            if !mine.contains(&key) {
                continue;
            }
            settle(state, &key);
            keys.shift_remove(&key);
            settled.push(key);
        }
        super::apply_batches::count_reapplied(state, &settled, deferred, &changing);
        return false;
    }
    if let Some(apply_as) = state.apply_as.as_mut() {
        apply_as.insert(prefix, "joined".into());
    }
    for key in &mine {
        if !deferred.contains(key) {
            settle(state, key);
        }
    }
    let all: Vec<String> = mine.iter().cloned().collect();
    super::apply_batches::count_reapplied(state, &all, deferred, &changing);
    true
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CycleResult {
    pub published: usize,
    pub changed: usize,
    pub pending: u64,
    pub compacted: bool,
    pub snapshot_bytes: u64,
    pub reapplied: u64,
}

pub struct SyncScopeArgs<'a, 'b> {
    pub scope: &'a str,
    pub state: &'a mut ScopeState,
    pub transport: &'a dyn Transport,
    pub adapters: &'a mut [Box<dyn Adapter + 'b>],
    pub clock: &'a mut Clock,
    pub device: &'a str,
    pub now: &'a dyn Fn() -> Millis,
    pub options: ScopeOptions<'a>,
}

pub fn sync_scope(args: SyncScopeArgs) -> Result<CycleResult, TransportError> {
    let SyncScopeArgs {
        scope,
        state,
        transport,
        adapters,
        clock,
        device,
        now,
        mut options,
    } = args;
    let launch = options.launch.clone();
    super::apply_batches::start_applying(
        state,
        now(),
        super::apply_batches::Launch {
            id: &launch,
            monotonic: (options.monotonic)(),
            native_save_ms: options.native_save_ms,
        },
    );
    super::apply_batches::settle_owed_retirements(state, options.persist_applying.as_mut());
    let mut published = 0usize;
    let mut stamps: HashMap<usize, Stamps> = HashMap::new();
    for (i, adapter) in adapters.iter_mut().enumerate() {
        if adapter.publish_after_pull() {
            stamps.insert(
                i,
                candidate_stamps(state, adapter.as_mut(), clock, now(), &launch),
            );
        } else {
            published +=
                publish_adapter(state, adapter.as_mut(), clock, device, now(), None, &launch).len();
        }
    }
    flush(state, transport, scope, device, now(), &mut options)?;
    let changed = pull(state, transport, scope, clock, now(), &options)?;
    let held = holds_back(state, now(), options.damaged_give_up);
    let mut keys: IndexSet<String> = state
        .unapplied
        .iter()
        .cloned()
        .chain(changed.iter().cloned())
        .collect();
    let mut unapplied: Vec<String> = Vec::new();
    let mut held_apply = false;
    let mut journal_failed = false;
    let hold = |options: &ScopeOptions| options.held();
    for (i, adapter) in adapters.iter_mut().enumerate() {
        let late = if adapter.publish_after_pull() && held {
            HashSet::new()
        } else {
            publish_adapter(
                state,
                adapter.as_mut(),
                clock,
                device,
                now(),
                stamps.get(&i),
                &launch,
            )
        };
        published += late.len();
        for key in &late {
            keys.shift_remove(key);
        }
        let prefix = adapter.prefix().to_owned();
        for key in state.unapplied.clone() {
            if key.starts_with(&prefix) && !late.contains(&key) {
                keys.insert(key);
            }
        }
        held_apply = held_apply || hold(&options);
        let mut deferred = HashSet::new();
        let ahead = if held_apply {
            super::apply_batches::WriteAhead {
                batch: None,
                failed: false,
            }
        } else {
            let pending: Vec<String> = keys.iter().cloned().collect();
            super::apply_batches::write_ahead(
                state,
                &prefix,
                &pending,
                now(),
                &launch,
                options.persist_applying.as_mut(),
            )
        };
        let cancelled = ahead.batch.is_some() && {
            let raced = publish_adapter(
                state,
                adapter.as_mut(),
                clock,
                device,
                now(),
                stamps.get(&i),
                &launch,
            );
            published += raced.len();
            for key in &raced {
                keys.shift_remove(key);
            }
            super::apply_batches::cancel_if_raced(
                state,
                ahead.batch,
                &raced,
                options.persist_applying.as_mut(),
            )
        };
        journal_failed = journal_failed || ahead.failed;
        held_apply = held_apply || ahead.failed;
        let held_fn = || options.held();
        let applied = !held_apply
            && !cancelled
            && apply_adapter(
                state,
                adapter.as_mut(),
                &mut keys,
                now(),
                2 * options.tombstone_ttl,
                &held_fn,
                &mut deferred,
            );
        super::apply_batches::finish_batch(state, ahead.batch, applied, (options.monotonic)());
        held_apply = held_apply || hold(&options);
        if !applied {
            unapplied.extend(keys.iter().filter(|k| k.starts_with(&prefix)).cloned());
        } else {
            unapplied.extend(deferred);
        }
    }
    let prefixes: Vec<String> = adapters.iter().map(|a| a.prefix().to_owned()).collect();
    unapplied.extend(
        keys.iter()
            .filter(|k| !prefixes.iter().any(|p| k.starts_with(p.as_str())))
            .cloned(),
    );
    let mut seen_unapplied = HashSet::new();
    unapplied.retain(|k| seen_unapplied.insert(k.clone()));
    state.unapplied = unapplied;
    if !held_apply && (state.await_remote != Some(true) || state.seen.keys().any(|d| d != device)) {
        state.joined = true;
        state.await_remote = None;
    }
    flush(state, transport, scope, device, now(), &mut options)?;
    if journal_failed {
        return Err(TransportError::Failed(
            "couldn't journal what this cycle was about to apply".to_owned(),
        ));
    }
    let compacted = compact(state, transport, scope, device, now(), &mut options, false)?;
    let snapshot_bytes = if compacted {
        newest_snapshot(&state.files, Some(device))
            .and_then(|(_, f)| f.b)
            .unwrap_or(0)
    } else {
        0
    };
    Ok(CycleResult {
        published,
        changed: changed.len(),
        pending: state.pending,
        compacted,
        snapshot_bytes,
        reapplied: super::apply_batches::take_reapplied(state),
    })
}
