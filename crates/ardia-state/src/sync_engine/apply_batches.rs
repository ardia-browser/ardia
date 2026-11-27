use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::canon::canonical;
use super::scope::{Extraction, ScopeState, TransportError};
use crate::model::Millis;

pub const ABSENT: &str = "null";
pub const NATIVE_SAVE_MS: f64 = 30_000.0;
pub const UNSEEN_KEPT_MS: Millis = 86_400_000;

pub type Step = (Option<String>, Option<String>);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApplyBatch {
    pub id: i64,
    pub p: String,
    pub l: String,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cut: Option<Vec<String>>,
    pub k: IndexMap<String, Step>,
}

fn json_or_null(v: &Value) -> bool {
    v.is_null()
        || v.as_str()
            .is_some_and(|t| serde_json::from_str::<Value>(t).is_ok())
}

fn finite(v: &Value) -> bool {
    v.as_f64().is_some_and(f64::is_finite)
}

pub fn is_apply_batch(v: &Value) -> bool {
    let Some(b) = v.as_object() else { return false };
    if !b.get("id").is_some_and(finite)
        || !b.get("p").is_some_and(Value::is_string)
        || !b.get("l").is_some_and(Value::is_string)
        || !b.get("at").is_some_and(finite)
    {
        return false;
    }
    if b.get("done").is_some_and(|d| !finite(d)) {
        return false;
    }
    if ["r", "f", "ok"]
        .iter()
        .any(|flag| b.get(*flag).is_some_and(|f| f.as_f64() != Some(1.0)))
    {
        return false;
    }
    if b.get("cut")
        .is_some_and(|c| !c.as_array().is_some_and(|c| c.iter().all(Value::is_string)))
    {
        return false;
    }
    b.get("k").and_then(Value::as_object).is_some_and(|k| {
        k.values().all(|s| {
            s.as_array()
                .is_some_and(|s| s.len() == 2 && json_or_null(&s[0]) && json_or_null(&s[1]))
        })
    })
}

pub fn batch_of(v: &Value) -> Option<ApplyBatch> {
    if !is_apply_batch(v) {
        return None;
    }
    let b = v.as_object()?;
    let flag = |name: &str| b.get(name).map(|_| 1u8);
    Some(ApplyBatch {
        id: b["id"].as_f64()? as i64,
        p: b["p"].as_str()?.to_owned(),
        l: b["l"].as_str()?.to_owned(),
        at: b["at"].as_f64()? as i64,
        done: b.get("done").and_then(Value::as_f64),
        r: flag("r"),
        f: flag("f"),
        ok: flag("ok"),
        cut: b.get("cut").and_then(Value::as_array).map(|c| {
            c.iter()
                .filter_map(|k| k.as_str().map(str::to_owned))
                .collect()
        }),
        k: b["k"]
            .as_object()?
            .iter()
            .map(|(key, s)| {
                (
                    key.clone(),
                    (
                        s[0].as_str().map(str::to_owned),
                        s[1].as_str().map(str::to_owned),
                    ),
                )
            })
            .collect(),
    })
}

pub fn valid_batches(v: Option<&Value>) -> Vec<ApplyBatch> {
    v.and_then(Value::as_array)
        .map(|list| list.iter().filter_map(batch_of).collect())
        .unwrap_or_default()
}

#[derive(Clone, Copy)]
pub struct Launch<'a> {
    pub id: &'a str,
    pub monotonic: f64,
    pub native_save_ms: f64,
}

fn visible_json(state: &ScopeState, key: &str) -> String {
    match state.records.get(key) {
        Some(r) if !r.v.is_null() => canonical(&r.v),
        _ => ABSENT.to_owned(),
    }
}

pub fn awaits_recovery(state: &ScopeState, key: &str) -> bool {
    state.runtime.recovering.contains(key)
}

fn note_batch(
    state: &mut ScopeState,
    prefix: &str,
    keys: &[String],
    now: Millis,
    launch: &str,
) -> Option<ApplyBatch> {
    let mut k = IndexMap::new();
    for key in keys {
        if !key.starts_with(prefix) {
            continue;
        }
        let from = state.base.get(key).cloned();
        let to = visible_json(state, key);
        if from.as_deref().unwrap_or(ABSENT) == to && !awaits_recovery(state, key) {
            continue;
        }
        k.insert(key.clone(), (from, (to != ABSENT).then_some(to)));
    }
    if k.is_empty() {
        return None;
    }
    let batches = state.applying.get_or_insert_with(Vec::new);
    let id = batches.iter().map(|b| b.id + 1).fold(now, i64::max);
    let batch = ApplyBatch {
        id,
        p: prefix.to_owned(),
        l: launch.to_owned(),
        at: now,
        done: None,
        r: None,
        f: None,
        ok: None,
        cut: None,
        k,
    };
    batches.push(batch.clone());
    Some(batch)
}

fn drop_batch(state: &mut ScopeState, id: i64) {
    if let Some(list) = state.applying.as_mut() {
        list.retain(|b| b.id != id);
    }
    if state.applying.as_ref().is_some_and(Vec::is_empty) {
        state.applying = None;
    }
}

pub type PersistApplying<'a> = dyn FnMut(&ApplyBatch) -> Result<(), TransportError> + 'a;

pub struct WriteAhead {
    pub batch: Option<i64>,
    pub failed: bool,
}

pub fn write_ahead(
    state: &mut ScopeState,
    prefix: &str,
    keys: &[String],
    now: Millis,
    launch: &str,
    persist: Option<&mut Box<PersistApplying>>,
) -> WriteAhead {
    let Some(persist) = persist else {
        return WriteAhead {
            batch: None,
            failed: false,
        };
    };
    let Some(batch) = note_batch(state, prefix, keys, now, launch) else {
        return WriteAhead {
            batch: None,
            failed: false,
        };
    };
    match persist(&batch) {
        Ok(()) => WriteAhead {
            batch: Some(batch.id),
            failed: false,
        },
        Err(_) => {
            drop_batch(state, batch.id);
            WriteAhead {
                batch: None,
                failed: true,
            }
        }
    }
}

fn retire(state: &mut ScopeState, batch: ApplyBatch, persist: Option<&mut Box<PersistApplying>>) {
    let mut emptied = batch.clone();
    emptied.k = IndexMap::new();
    let ok = persist.is_none_or(|persist| persist(&emptied).is_ok());
    if !ok {
        state.runtime.owed.retain(|b| b.id != batch.id);
        state.runtime.owed.push(batch);
    }
}

pub fn cancel_if_raced(
    state: &mut ScopeState,
    batch: Option<i64>,
    raced: &HashSet<String>,
    persist: Option<&mut Box<PersistApplying>>,
) -> bool {
    let Some(id) = batch else { return false };
    let Some(found) = state
        .applying
        .as_ref()
        .and_then(|l| l.iter().find(|b| b.id == id))
        .cloned()
    else {
        return false;
    };
    if !found.k.keys().any(|k| raced.contains(k)) {
        return false;
    }
    drop_batch(state, id);
    retire(state, found, persist);
    true
}

pub fn settle_owed_retirements(
    state: &mut ScopeState,
    mut persist: Option<&mut Box<PersistApplying>>,
) {
    for batch in std::mem::take(&mut state.runtime.owed) {
        retire(state, batch, persist.as_deref_mut());
    }
}

pub fn finish_batch(state: &mut ScopeState, batch: Option<i64>, applied: bool, monotonic: f64) {
    let Some(id) = batch else { return };
    if let Some(found) = state
        .applying
        .as_mut()
        .and_then(|l| l.iter_mut().find(|b| b.id == id))
    {
        found.done = Some(monotonic);
        if applied {
            found.ok = Some(1);
        } else {
            found.f = Some(1);
        }
    }
}

pub fn start_applying(state: &mut ScopeState, now: Millis, launch: Launch) {
    state.runtime.reapplied = 0;
    let Some(list) = state.applying.take() else {
        return;
    };
    let retrying: HashSet<&String> = state.unapplied.iter().collect();
    let live: Vec<ApplyBatch> = list
        .into_iter()
        .filter(|b| {
            if b.l == launch.id && b.f.is_some() && b.k.keys().any(|k| retrying.contains(k)) {
                return true;
            }
            if b.l == launch.id {
                return b
                    .done
                    .is_none_or(|done| launch.monotonic - done < launch.native_save_ms);
            }
            b.r.is_none() || now - b.at < UNSEEN_KEPT_MS
        })
        .collect();
    state.applying = (!live.is_empty()).then_some(live);
}

pub fn queue_recovered(state: &mut ScopeState, keys: &[String]) {
    let mut queued: HashSet<String> = state.unapplied.iter().cloned().collect();
    for key in keys {
        state.runtime.recovering.insert(key.clone());
        if queued.insert(key.clone()) {
            state.unapplied.push(key.clone());
        }
    }
}

pub fn count_reapplied(
    state: &mut ScopeState,
    applied: &[String],
    deferred: &HashSet<String>,
    changed: &HashSet<String>,
) {
    if state.runtime.recovering.is_empty() {
        return;
    }
    let mut count = 0;
    for key in applied {
        if deferred.contains(key) || !state.runtime.recovering.remove(key) {
            continue;
        }
        if changed.contains(key) {
            count += 1;
        }
    }
    state.runtime.reapplied += count;
}

pub fn failed_targets(
    state: &ScopeState,
    prefix: &str,
    launch: &str,
) -> Option<HashMap<String, HashSet<String>>> {
    let mut targets: Option<HashMap<String, HashSet<String>>> = None;
    for batch in state.applying.iter().flatten() {
        if batch.f.is_none() || batch.l != launch || batch.p != prefix {
            continue;
        }
        let map = targets.get_or_insert_with(HashMap::new);
        for (key, (_, to)) in &batch.k {
            map.entry(key.clone())
                .or_default()
                .insert(to.clone().unwrap_or_else(|| ABSENT.to_owned()));
        }
    }
    targets
}

pub fn take_reapplied(state: &mut ScopeState) -> u64 {
    std::mem::take(&mut state.runtime.reapplied)
}

#[derive(Clone)]
struct ChainStep {
    at: usize,
    from: String,
    to: String,
    partial: bool,
}

fn chains_of(
    batches: &[ApplyBatch],
    skip: &dyn Fn(&str) -> bool,
) -> IndexMap<String, Vec<ChainStep>> {
    let mut chains: IndexMap<String, Vec<ChainStep>> = IndexMap::new();
    for (at, batch) in batches.iter().enumerate() {
        for (key, (from, to)) in &batch.k {
            if skip(key) {
                continue;
            }
            chains.entry(key.clone()).or_default().push(ChainStep {
                at,
                from: from.clone().unwrap_or_else(|| ABSENT.to_owned()),
                to: to.clone().unwrap_or_else(|| ABSENT.to_owned()),
                partial: batch.ok.is_none(),
            });
        }
    }
    chains
}

fn value_at(chain: &[ChainStep], hypothesis: usize) -> String {
    chain
        .iter()
        .rev()
        .find(|s| s.at < hypothesis)
        .map_or_else(|| chain[0].from.clone(), |s| s.to.clone())
}

fn holds(chain: Option<&Vec<ChainStep>>, json: &str) -> bool {
    chain.is_some_and(|c| c.iter().any(|s| s.to == json || s.from == json))
}

fn left_over(chain: &Vec<ChainStep>, json: &str, saves_whole: bool) -> bool {
    (!saves_whole || chain.iter().any(|s| s.partial)) && holds(Some(chain), json)
}

pub fn native_json(extraction: &Extraction, key: &str) -> String {
    match extraction.values.get(key) {
        None => ABSENT.to_owned(),
        Some(value) => extraction
            .json
            .as_ref()
            .and_then(|j| j(key, value))
            .unwrap_or_else(|| canonical(value)),
    }
}

fn keep_unresolved(state: &mut ScopeState, ids: &HashSet<i64>, resolved: &HashSet<String>) {
    let Some(list) = state.applying.take() else {
        return;
    };
    let mut kept = Vec::new();
    for mut batch in list {
        if !ids.contains(&batch.id) {
            kept.push(batch);
            continue;
        }
        let cut: Vec<String> = batch
            .k
            .keys()
            .filter(|k| resolved.contains(*k))
            .cloned()
            .collect();
        batch.k.retain(|k, _| !resolved.contains(k));
        if batch.k.is_empty() {
            continue;
        }
        batch.r = Some(1);
        if !cut.is_empty() {
            let mut all = batch.cut.take().unwrap_or_default();
            all.extend(cut);
            batch.cut = Some(all);
        }
        kept.push(batch);
    }
    state.applying = (!kept.is_empty()).then_some(kept);
}

pub type Overrides = HashMap<String, Option<String>>;

pub fn recover_batches(
    state: &mut ScopeState,
    prefix: &str,
    first: Extraction,
    extract_with: &mut dyn FnMut(&ScopeState, &Overrides) -> Option<Extraction>,
    uses_base: bool,
    saves_whole: bool,
    launch: &str,
) -> Option<Extraction> {
    let mut batches: Vec<ApplyBatch> = state
        .applying
        .iter()
        .flatten()
        .filter(|b| b.p == prefix && b.l != launch)
        .cloned()
        .collect();
    batches.sort_by_key(|b| b.id);
    if batches.is_empty() {
        return Some(first);
    }
    let ids: HashSet<i64> = batches.iter().map(|b| b.id).collect();
    let chains = chains_of(&batches, &|key| {
        first.ignore.as_ref().is_some_and(|i| i(key))
    });
    if chains.is_empty() {
        if batches.iter().any(|b| b.r.is_none()) {
            keep_unresolved(state, &ids, &HashSet::new());
        }
        return Some(first);
    }
    let mut best: Option<(usize, usize, Overrides, bool)> = None;
    let mut trials: Vec<Option<Extraction>> = Vec::new();
    let mut first_slot = Some(first);
    for hypothesis in 0..=batches.len() {
        let overrides: Overrides = chains
            .iter()
            .map(|(key, chain)| {
                let json = value_at(chain, hypothesis);
                (key.clone(), (json != ABSENT).then_some(json))
            })
            .collect();
        let same = overrides.iter().all(|(key, json)| {
            state.base.get(key).map(String::as_str).unwrap_or(ABSENT)
                == json.as_deref().unwrap_or(ABSENT)
        });
        let (extraction, from_first) = if same || !uses_base {
            (None, true)
        } else {
            (Some(extract_with(state, &overrides)?), false)
        };
        let probe = extraction.as_ref().or(first_slot.as_ref());
        let Some(probe) = probe else { continue };
        let matches = chains
            .iter()
            .filter(|(key, chain)| {
                !probe.ignore.as_ref().is_some_and(|i| i(key))
                    && native_json(probe, key) == value_at(chain, hypothesis)
            })
            .count();
        let index = trials.len();
        trials.push(extraction);
        if best.as_ref().is_none_or(|(_, m, _, _)| matches > *m) {
            best = Some((index, matches, overrides, from_first));
        }
    }
    let (index, _, overrides, from_first) = best?;
    let hypothesis = index;
    let extraction = if from_first {
        first_slot.take()?
    } else {
        trials.get_mut(index)?.take()?
    };
    let base_json = |state: &ScopeState, key: &str| -> Option<String> {
        overrides
            .get(key)
            .cloned()
            .unwrap_or_else(|| state.base.get(key).cloned())
    };
    let since_restart = {
        let current: Vec<ApplyBatch> = state
            .applying
            .iter()
            .flatten()
            .filter(|b| b.p == prefix && b.l == launch)
            .cloned()
            .collect();
        chains_of(&current, &|key| !chains.contains_key(key))
    };
    let mut resolved = HashSet::new();
    let mut queue = Vec::new();
    for (key, chain) in &chains {
        if extraction.ignore.as_ref().is_some_and(|i| i(key)) {
            continue;
        }
        resolved.insert(key.clone());
        let actual = native_json(&extraction, key);
        if actual != value_at(chain, hypothesis)
            && !left_over(chain, &actual, saves_whole)
            && !holds(since_restart.get(key), &actual)
        {
            match base_json(state, key) {
                Some(json) => state.put_base(key, json),
                None => state.drop_base(key),
            }
            continue;
        }
        if actual == ABSENT {
            state.drop_base(key);
        } else {
            state.put_base(key, actual.clone());
        }
        let target = visible_json(state, key);
        let record_behind = target != actual
            && chain.iter().any(|s| s.from == target)
            && !chain.iter().any(|s| s.to == target);
        if record_behind {
            continue;
        }
        queue.push(key.clone());
    }
    keep_unresolved(state, &ids, &resolved);
    queue_recovered(state, &queue);
    Some(extraction)
}

pub const APPLYING_PART_CHARS: usize = 1_000_000;

pub fn chunks_of(batch: &ApplyBatch) -> Vec<Value> {
    let mut groups: Vec<IndexMap<String, Step>> = Vec::new();
    let mut keys: IndexMap<String, Step> = IndexMap::new();
    let mut size = 0usize;
    for (key, step) in &batch.k {
        let entry = serde_json::to_string(key).map_or(0, |s| s.len())
            + serde_json::to_string(step).map_or(0, |s| s.len())
            + 2;
        if size > 0 && size + entry > APPLYING_PART_CHARS {
            groups.push(std::mem::take(&mut keys));
            size = 0;
        }
        keys.insert(key.clone(), step.clone());
        size += entry;
    }
    groups.push(keys);
    let n = groups.len();
    groups
        .into_iter()
        .enumerate()
        .map(|(i, k)| {
            let mut value =
                serde_json::to_value(ApplyBatch { k, ..batch.clone() }).unwrap_or(Value::Null);
            if let Value::Object(map) = &mut value {
                map.insert("n".into(), n.into());
                map.insert("i".into(), i.into());
            }
            value
        })
        .collect()
}

pub fn holds_applying<'a>(scopes: impl IntoIterator<Item = &'a ScopeState>) -> bool {
    scopes
        .into_iter()
        .any(|s| s.applying.iter().flatten().any(|b| b.r.is_none()))
}

pub fn rest_with_applying(state: &ScopeState, rest: &mut serde_json::Map<String, Value>) {
    let Some(applying) = state.applying.as_ref().filter(|l| !l.is_empty()) else {
        return;
    };
    rest.insert(
        "applyingIds".into(),
        Value::Array(applying.iter().map(|b| Value::from(b.id)).collect()),
    );
    let mut trimmed = serde_json::Map::new();
    for b in applying {
        let cut = b.cut.clone().unwrap_or_default();
        if cut.is_empty() && b.r.is_none() && b.f.is_none() && b.ok.is_none() {
            continue;
        }
        let kept: Vec<String> = b.k.keys().cloned().collect();
        let mut t = serde_json::Map::new();
        if cut.len() < kept.len() {
            t.insert("e".into(), cut.into());
        } else {
            t.insert("k".into(), kept.into());
        }
        for (flag, on) in [("r", b.r), ("f", b.f), ("ok", b.ok)] {
            if on.is_some() {
                t.insert(flag.into(), 1.into());
            }
        }
        trimmed.insert(b.id.to_string(), Value::Object(t));
    }
    if !trimmed.is_empty() {
        rest.insert("applyingTrimmed".into(), Value::Object(trimmed));
    }
}

fn key_list(v: Option<&Value>) -> Option<Vec<String>> {
    v?.as_array()?
        .iter()
        .map(|k| k.as_str().map(str::to_owned))
        .collect()
}

pub fn batches_from_rest(
    rest: &serde_json::Map<String, Value>,
    before: Option<&Vec<ApplyBatch>>,
) -> Option<Vec<ApplyBatch>> {
    let ids: Option<HashSet<i64>> = rest.get("applyingIds").and_then(Value::as_array).map(|l| {
        l.iter()
            .filter_map(Value::as_f64)
            .map(|f| f as i64)
            .collect()
    });
    let trims = rest.get("applyingTrimmed").and_then(Value::as_object);
    let mut out = Vec::new();
    for batch in before.into_iter().flatten() {
        if !ids.as_ref().is_some_and(|ids| ids.contains(&batch.id)) {
            continue;
        }
        let trim = trims
            .and_then(|t| t.get(&batch.id.to_string()))
            .and_then(Value::as_object);
        let Some(trim) = trim else {
            out.push(batch.clone());
            continue;
        };
        let kept = key_list(trim.get("k"));
        let cut_keys: HashSet<String> = key_list(trim.get("e"))
            .unwrap_or_default()
            .into_iter()
            .collect();
        let mut next = batch.clone();
        next.k.retain(|key, _| match &kept {
            Some(kept) => kept.contains(key),
            None => !cut_keys.contains(key),
        });
        if next.k.is_empty() {
            continue;
        }
        let mut all_cut = batch.cut.clone().unwrap_or_default();
        for key in batch.k.keys() {
            if !next.k.contains_key(key) && !all_cut.contains(key) {
                all_cut.push(key.clone());
            }
        }
        if !all_cut.is_empty() {
            next.cut = Some(all_cut);
        }
        for (flag, slot) in [("r", &mut next.r), ("f", &mut next.f), ("ok", &mut next.ok)] {
            if trim.get(flag).is_some() {
                *slot = Some(1);
            }
        }
        out.push(next);
    }
    (!out.is_empty()).then_some(out)
}

type Parts = (usize, HashMap<usize, ApplyBatch>);

#[derive(Default)]
pub struct Assembly {
    pending: HashMap<String, HashMap<i64, Parts>>,
}

pub fn replay_applying(
    scopes: &mut IndexMap<String, ScopeState>,
    applying: &Value,
    live: &HashSet<String>,
    assembly: &mut Assembly,
) {
    let Some(by_scope) = applying.as_object() else {
        return;
    };
    for (scope, list) in by_scope {
        if !live.contains(scope) {
            continue;
        }
        for chunk in list.as_array().into_iter().flatten() {
            let Some(batch) = batch_of(chunk) else {
                continue;
            };
            let n_raw = chunk.get("n");
            let i_raw = chunk.get("i");
            let n = n_raw
                .and_then(Value::as_u64)
                .filter(|n| *n > 0)
                .unwrap_or(1) as usize;
            let i = match (i_raw, n_raw) {
                (None, None) => 0,
                _ => match i_raw.and_then(Value::as_u64).map(|i| i as usize) {
                    Some(i) if i < n => i,
                    _ => continue,
                },
            };
            let by_id = assembly.pending.entry(scope.clone()).or_default();
            let id = batch.id;
            let entry = by_id.entry(id).or_insert_with(|| (n, HashMap::new()));
            if entry.0 != n {
                *entry = (n, HashMap::new());
            }
            entry.1.insert(i, batch);
            if entry.1.len() < n {
                continue;
            }
            let Some((_, parts)) = by_id.remove(&id) else {
                continue;
            };
            let mut parts: Vec<(usize, ApplyBatch)> = parts.into_iter().collect();
            parts.sort_by_key(|(i, _)| *i);
            let mut whole = parts[0].1.clone();
            for (_, part) in parts.iter().skip(1) {
                whole.k.extend(part.k.clone());
            }
            let state = scopes.entry(scope.clone()).or_default();
            let mut list: Vec<ApplyBatch> = state
                .applying
                .take()
                .unwrap_or_default()
                .into_iter()
                .filter(|b| b.id != whole.id)
                .collect();
            if !whole.k.is_empty() {
                list.push(whole);
            }
            list.sort_by_key(|b| b.id);
            state.applying = (!list.is_empty()).then_some(list);
        }
    }
}
