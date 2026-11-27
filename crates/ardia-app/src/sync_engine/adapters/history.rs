use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ardia_state::history::{History, HistoryEntry, MAX_ENTRIES, MAX_VISIT_TIMES};
use ardia_state::sync_engine::scope::{Adapter, ApplyRecords, ExtractContext, Extraction};
use ardia_state::sync_engine::{IndexMap, IndexSet};
use ardia_state::{BrowserState, ProfileId};
use serde_json::{Value, json};

use super::{CycleContext, HISTORY, InTodaysNames, data_engine, record_id};
use crate::history_sync::is_web_page_url;

pub const HISTORY_KEPT_MS: i64 = 90 * 86_400_000;
pub const SAME_VISIT_MS: i64 = 1;
pub const RECORD_VISIT_TIMES: usize = 50;

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryValue {
    pub t: String,
    pub n: f64,
    pub vt: Vec<i64>,
}

impl HistoryValue {
    pub fn to_value(&self) -> Value {
        json!({ "t": self.t, "n": ardia_state::json::js_number(self.n), "vt": self.vt })
    }

    fn last_visit(&self) -> i64 {
        self.vt.iter().copied().max().unwrap_or(0).max(0)
    }
}

pub fn history_value(value: Option<&Value>) -> Option<HistoryValue> {
    let v = value?.as_object()?;
    let t = v.get("t")?.as_str()?.to_owned();
    let n = v.get("n")?.as_f64()?;
    let vt = v
        .get("vt")?
        .as_array()?
        .iter()
        .map(|t| t.as_f64().map(|t| t as i64))
        .collect::<Option<Vec<i64>>>()?;
    Some(HistoryValue { t, n, vt })
}

pub fn expired(key: &str, value: &Value, now: i64) -> bool {
    if !key.starts_with(HISTORY) {
        return false;
    }
    history_value(Some(value)).is_some_and(|v| v.last_visit() < now - HISTORY_KEPT_MS)
}

fn kept_visits(vt: &[i64]) -> Vec<i64> {
    if vt.len() <= RECORD_VISIT_TIMES {
        return vt.to_vec();
    }
    let mut sorted = vt.to_vec();
    sorted.sort_unstable();
    let mut out: Vec<i64> = Vec::new();
    for t in sorted {
        if out.last().is_none_or(|last| t - last > SAME_VISIT_MS) {
            out.push(t);
        }
    }
    out.split_off(out.len().saturating_sub(RECORD_VISIT_TIMES))
}

fn same_visits(a: &[i64], b: &[i64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (y - x).abs() <= SAME_VISIT_MS)
}

fn near(list: &[i64], t: i64) -> bool {
    list.iter().any(|k| (k - t).abs() <= SAME_VISIT_MS)
}

pub fn local_value(entry: &HistoryEntry) -> HistoryValue {
    let vt = if entry.visit_times.is_empty() {
        vec![entry.last_visit]
    } else {
        entry.visit_times.clone()
    };
    HistoryValue {
        t: entry.title.clone(),
        n: f64::from(entry.visits),
        vt,
    }
}

pub fn visit_of(entry: &HistoryEntry, known: Option<HistoryValue>) -> HistoryValue {
    let local = local_value(entry);
    match known {
        Some(known)
            if same_visits(&local.vt, &known.vt)
                || local.vt.iter().all(|t| near(&known.vt, *t)) =>
        {
            known
        }
        _ => local,
    }
}

pub struct HistoryAdapter {
    cx: CycleContext,
    profile: ProfileId,
}

pub fn adapter(cx: &CycleContext, profile: &ProfileId) -> Box<dyn Adapter> {
    Box::new(InTodaysNames(HistoryAdapter {
        cx: cx.clone(),
        profile: profile.clone(),
    }))
}

fn floor_of(history: &History) -> Option<i64> {
    (history.len() >= MAX_ENTRIES)
        .then(|| history.entries().map(|e| e.last_visit).min().unwrap_or(0))
}

pub fn extract_values(
    history: &History,
    now: i64,
    base: &dyn Fn(&str) -> Option<Value>,
) -> (IndexMap<String, Value>, HashSet<String>, Option<i64>) {
    let since = now - HISTORY_KEPT_MS;
    let mut values = IndexMap::new();
    let mut older = HashSet::new();
    for entry in history.entries() {
        if !is_web_page_url(&entry.url) {
            continue;
        }
        let key = format!("{HISTORY}{}", entry.url);
        if entry.last_visit < since {
            older.insert(key);
            continue;
        }
        let known = history_value(base(&key).as_ref());
        values.insert(key, visit_of(entry, known).to_value());
    }
    (values, older, floor_of(history))
}

impl Adapter for HistoryAdapter {
    fn prefix(&self) -> &str {
        HISTORY
    }

    fn extract_uses_base(&self) -> bool {
        true
    }

    fn extracts_only_from(&self) -> Option<u64> {
        let state = self.cx.host.state();
        let day = ardia_state::store::now_ms() / 86_400_000;
        state
            .history_of(&self.profile)
            .map(|h| (Arc::as_ptr(h) as u64) ^ (day as u64).rotate_left(48))
    }

    fn edited_at(&self, value: &Value) -> Option<i64> {
        history_value(Some(value)).map(|v| v.last_visit())
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        if !data_engine::history_ready(&self.cx, &self.profile) {
            return None;
        }
        let state = self.cx.host.state();
        let history = state.history_of(&self.profile)?.clone();
        let now = ardia_state::store::now_ms();
        let since = now - HISTORY_KEPT_MS;
        let (values, older, floor) = extract_values(&history, now, &|key| cx.base(key));
        let base_lasts: HashMap<String, i64> = cx
            .base_keys(HISTORY)
            .into_iter()
            .filter_map(|key| history_value(cx.base(&key).as_ref()).map(|v| (key, v.last_visit())))
            .collect();
        Some(Extraction::of(values).ignoring(move |key| {
            if older.contains(key) || !is_web_page_url(record_id(HISTORY, key)) {
                return true;
            }
            base_lasts
                .get(key)
                .is_some_and(|last| *last < since || floor.is_some_and(|f| *last <= f))
        }))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        if !data_engine::history_ready(&self.cx, &self.profile) {
            return false;
        }
        let state = self.cx.host.state();
        let Some(history) = state.history_of(&self.profile).cloned() else {
            return false;
        };
        let Some(plan) = plan_apply(&history, visible, changed, ardia_state::store::now_ms())
        else {
            return false;
        };
        if plan.updates.is_empty() {
            return true;
        }
        if !plan.add.is_empty() {
            let pages: Vec<Value> = plan
                .add
                .iter()
                .map(|(u, t, v)| json!({ "u": u, "t": t, "v": v }))
                .collect();
            data_engine::call(
                &self.cx,
                &self.profile,
                "ac_history_add",
                json!({ "pages": pages, "toleranceMs": SAME_VISIT_MS }),
            );
        }
        if !plan.remove.is_empty() {
            data_engine::call(
                &self.cx,
                &self.profile,
                "ac_history_delete_urls",
                json!({ "urls": plan.remove }),
            );
        }
        let profile = self.profile.clone();
        let updates = plan.updates;
        data_engine::edit_state(&self.cx, move |state| {
            merged_state(state, &profile, &updates)
        });
        true
    }
}

pub struct ApplyPlan {
    pub add: Vec<(String, String, Vec<i64>)>,
    pub remove: Vec<String>,
    pub updates: IndexMap<String, Option<HistoryEntry>>,
}

pub fn plan_apply(
    history: &History,
    visible: &IndexMap<String, Value>,
    changed: &IndexSet<String>,
    now: i64,
) -> Option<ApplyPlan> {
    let since = now - HISTORY_KEPT_MS;
    let mut plan = ApplyPlan {
        add: Vec::new(),
        remove: Vec::new(),
        updates: IndexMap::new(),
    };
    for key in changed {
        let url = record_id(HISTORY, key);
        if !is_web_page_url(url) {
            continue;
        }
        let value = history_value(visible.get(key));
        if visible.contains_key(key) && value.is_none() {
            return None;
        }
        let old = history.get(url);
        match value {
            Some(v) => {
                let have = old.map(|o| o.visit_times.clone()).unwrap_or_default();
                let fresh: Vec<i64> = kept_visits(&v.vt)
                    .into_iter()
                    .filter(|t| *t >= since && !near(&have, *t))
                    .collect();
                if !fresh.is_empty() {
                    plan.add.push((url.to_owned(), v.t.clone(), fresh.clone()));
                }
                let mut times: Vec<i64> = have.iter().chain(fresh.iter()).copied().collect();
                times.sort_unstable();
                let times = times.split_off(times.len().saturating_sub(MAX_VISIT_TIMES));
                let Some(last) = times.last().copied() else {
                    continue;
                };
                let title = if v.t.is_empty() {
                    old.map(|o| o.title.clone()).unwrap_or_default()
                } else {
                    v.t.clone()
                };
                let visits =
                    (v.n.max(0.0).min(f64::from(u32::MAX)) as u32).max(old.map_or(0, |o| o.visits));
                plan.updates.insert(
                    url.to_owned(),
                    Some(HistoryEntry {
                        url: url.to_owned(),
                        title,
                        favicon: None,
                        visits,
                        last_visit: last,
                        visit_times: times,
                    }),
                );
            }
            None => {
                if old.is_some_and(|o| o.last_visit >= since) {
                    plan.remove.push(url.to_owned());
                    plan.updates.insert(url.to_owned(), None);
                }
            }
        }
    }
    Some(plan)
}

pub fn merged_state(
    state: &BrowserState,
    profile: &ProfileId,
    updates: &IndexMap<String, Option<HistoryEntry>>,
) -> Option<BrowserState> {
    let engine = state.engine_profile(profile);
    let current = state.history.get(&engine).cloned().unwrap_or_default();
    let mut by_url: IndexMap<String, HistoryEntry> = current
        .entries()
        .map(|e| (e.url.clone(), e.clone()))
        .collect();
    for (url, update) in updates {
        match update {
            None => {
                by_url.shift_remove(url);
            }
            Some(update) => match by_url.get(url) {
                None => {
                    by_url.insert(url.clone(), update.clone());
                }
                Some(now) => {
                    let mut times: Vec<i64> = now
                        .visit_times
                        .iter()
                        .chain(update.visit_times.iter())
                        .copied()
                        .collect::<std::collections::BTreeSet<_>>()
                        .into_iter()
                        .collect();
                    times = times.split_off(times.len().saturating_sub(MAX_VISIT_TIMES));
                    let merged = HistoryEntry {
                        url: url.clone(),
                        title: if now.title.is_empty() {
                            update.title.clone()
                        } else {
                            now.title.clone()
                        },
                        favicon: now.favicon.clone(),
                        visits: now.visits.max(update.visits),
                        last_visit: times.last().copied().unwrap_or(update.last_visit),
                        visit_times: times,
                    };
                    by_url.insert(url.clone(), merged);
                }
            },
        }
    }
    let mut list: Vec<HistoryEntry> = by_url.into_values().collect();
    list.sort_by_key(|e| std::cmp::Reverse(e.last_visit));
    let next_history = History::from_entries(list);
    if next_history == *current {
        return None;
    }
    let mut next = state.clone();
    Arc::make_mut(&mut next.history).insert(engine, Arc::new(next_history));
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::adapters::data_engine::fake;
    use crate::sync_engine::adapters::tests_support::{MemoryTransport, run_cycle};
    use ardia_state::sync_engine::scope::ScopeState;

    fn entry(url: &str, title: &str, times: &[i64]) -> HistoryEntry {
        HistoryEntry {
            url: url.into(),
            title: title.into(),
            favicon: None,
            visits: times.len() as u32,
            last_visit: *times.last().unwrap(),
            visit_times: times.to_vec(),
        }
    }

    fn state_with(entries: Vec<HistoryEntry>) -> BrowserState {
        let mut state = BrowserState::default();
        let engine = state.engine_profile(&ProfileId::default_profile());
        Arc::make_mut(&mut state.history).insert(engine, Arc::new(History::from_entries(entries)));
        state
    }

    #[test]
    fn values_match_the_old_shape_and_keep_known_records() {
        let now = ardia_state::store::now_ms();
        let h = History::from_entries(vec![
            entry("https://a.com/", "A", &[now - 10, now - 5]),
            entry("ardia://settings", "S", &[now]),
            entry("https://old.com/", "O", &[now - HISTORY_KEPT_MS - 5]),
        ]);
        let (values, older, _) = extract_values(&h, now, &|_| None);
        assert_eq!(
            values.get("h:https://a.com/"),
            Some(&json!({ "t": "A", "n": 2, "vt": [now - 10, now - 5] }))
        );
        assert_eq!(values.len(), 1);
        assert!(older.contains("h:https://old.com/"));
        let known = json!({ "t": "A", "n": 9, "vt": [now - 20, now - 10, now - 5] });
        let (values, _, _) = extract_values(&h, now, &|_| Some(known.clone()));
        assert_eq!(values["h:https://a.com/"], known);
        assert!(expired("h:x", &json!({ "t": "", "n": 1, "vt": [1] }), now));
        assert!(!expired(
            "bm:x",
            &json!({ "t": "", "n": 1, "vt": [1] }),
            now
        ));
    }

    #[test]
    fn two_macs_end_with_the_union_of_their_visits() {
        let now = ardia_state::store::now_ms();
        let transport = MemoryTransport::default();
        let (a, engine_a) = fake::context(
            state_with(vec![entry("https://a.com/", "A", &[now - 100])]),
            "AAAA",
        );
        let (b, _) = fake::context(
            state_with(vec![
                entry("https://a.com/", "A", &[now - 50]),
                entry("https://b.com/", "B", &[now - 40]),
            ]),
            "BBBB",
        );
        let profile = ProfileId::default_profile();
        let mut sa = ScopeState {
            joined: true,
            ..ScopeState::default()
        };
        let mut sb = ScopeState {
            joined: true,
            ..ScopeState::default()
        };
        run_cycle(
            &transport,
            "p:x",
            &mut sa,
            "AAAA",
            vec![adapter(&a, &profile)],
        );
        run_cycle(
            &transport,
            "p:x",
            &mut sb,
            "BBBB",
            vec![adapter(&b, &profile)],
        );
        run_cycle(
            &transport,
            "p:x",
            &mut sa,
            "AAAA",
            vec![adapter(&a, &profile)],
        );
        let state = a.host.state();
        let ha = state.history_of(&profile).unwrap();
        assert_eq!(
            ha.get("https://a.com/").unwrap().visit_times,
            vec![now - 100, now - 50]
        );
        assert!(ha.get("https://b.com/").is_some());
        assert!(engine_a.names().contains(&"ac_history_add".to_owned()));
        run_cycle(
            &transport,
            "p:x",
            &mut sa,
            "AAAA",
            vec![adapter(&a, &profile)],
        );
        run_cycle(
            &transport,
            "p:x",
            &mut sb,
            "BBBB",
            vec![adapter(&b, &profile)],
        );
        assert_eq!(
            sa.records["h:https://a.com/"],
            sb.records["h:https://a.com/"]
        );
        let hb = b.host.state();
        assert_eq!(
            hb.history_of(&profile)
                .unwrap()
                .get("https://a.com/")
                .unwrap()
                .visit_times,
            vec![now - 100, now - 50]
        );
    }

    #[test]
    fn unloaded_history_publishes_and_deletes_nothing() {
        let (cx, _) = fake::context(BrowserState::default(), "AAAA");
        let profile = ProfileId::default_profile();
        let mut state = ScopeState::default();
        state.put_base(
            "h:https://a.com/",
            "{\"n\":1,\"t\":\"A\",\"vt\":[5]}".into(),
        );
        let mut adapter = adapter(&cx, &profile);
        let ecx = ExtractContext::new(&state, 0);
        assert!(adapter.extract(&ecx).is_none());
    }
}
