use std::collections::HashMap;

use ardia_engine::{ServiceEvent, Services};
use ardia_state::actions::Action;
use ardia_state::history::{HistoryEntry, MAX_ENTRIES, MAX_VISIT_TIMES};
use ardia_state::{BrowserState, ProfileId};
use serde_json::Value;

use crate::coordinator::AppCoordinator;

pub fn is_web_page_url(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("file:")
}

fn text(row: &Value, key: &str) -> String {
    row.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

pub fn engine_entries(answer: &Value) -> Vec<HistoryEntry> {
    let Some(rows) = answer.get("entries").and_then(Value::as_array) else {
        return Vec::new();
    };
    rows.iter()
        .take(MAX_ENTRIES)
        .filter_map(|row| {
            let url = text(row, "u");
            if url.is_empty() || !is_web_page_url(&url) {
                return None;
            }
            let mut visit_times: Vec<i64> = row
                .get("v")
                .and_then(Value::as_array)
                .map(|times| {
                    times
                        .iter()
                        .filter_map(Value::as_f64)
                        .filter(|at| at.is_finite() && *at > 0.0)
                        .map(|at| at as i64)
                        .collect()
                })
                .unwrap_or_default();
            if visit_times.len() > MAX_VISIT_TIMES {
                visit_times.drain(..visit_times.len() - MAX_VISIT_TIMES);
            }
            let visits = row
                .get("n")
                .and_then(Value::as_u64)
                .map_or(visit_times.len() as u32, |n| {
                    n.min(u64::from(u32::MAX)) as u32
                });
            Some(HistoryEntry {
                title: text(row, "t"),
                favicon: None,
                visits,
                last_visit: visit_times.last().copied().unwrap_or(0),
                visit_times,
                url,
            })
        })
        .collect()
}

pub fn merged_history(engine: Vec<HistoryEntry>, kept: &[HistoryEntry]) -> Vec<HistoryEntry> {
    let mut by_url: HashMap<String, HistoryEntry> = engine
        .into_iter()
        .map(|entry| (entry.url.clone(), entry))
        .collect();
    for entry in kept {
        let newer = by_url
            .get(&entry.url)
            .is_none_or(|known| known.last_visit < entry.last_visit);
        if newer {
            let mut entry = entry.clone();
            if let Some(known) = by_url.get(&entry.url)
                && entry.favicon.is_none()
            {
                entry.favicon = known.favicon.clone();
            }
            by_url.insert(entry.url.clone(), entry);
        }
    }
    let mut list: Vec<HistoryEntry> = by_url.into_values().collect();
    list.sort_by_key(|entry| std::cmp::Reverse(entry.last_visit));
    list
}

fn owner_of(state: &BrowserState, engine_profile: &str) -> Option<ProfileId> {
    state
        .profile_order
        .iter()
        .find(|profile| state.engine_profile(profile) == engine_profile)
        .cloned()
}

impl AppCoordinator {
    pub(crate) fn load_engine_history(&self) {
        let state = self.store.snapshot();
        for profile in state.profile_order.iter() {
            if profile.is_incognito() || self.engine_profile(profile).is_none() {
                continue;
            }
            let started = self.bridge.lock().history_loaded.insert(profile.clone());
            if !started {
                continue;
            }
            let (Some(engine), Some(profile_dir)) =
                (self.engine(), self.service_profile_dir(profile))
            else {
                self.bridge.lock().history_loaded.remove(profile);
                continue;
            };
            let watch = Services::new(engine.as_ref(), &profile_dir)
                .history()
                .watch();
            let query = Services::new(engine.as_ref(), &profile_dir)
                .history()
                .query(MAX_ENTRIES as u32, MAX_VISIT_TIMES as u32);
            let me = self.weak();
            let profile = profile.clone();
            self.spawn(async move {
                let _ = watch.await;
                let answer = query.await;
                let Some(me) = me.upgrade() else {
                    return;
                };
                match answer {
                    Ok(answer) => {
                        let engine = engine_entries(&answer);
                        let kept: Vec<HistoryEntry> = me
                            .store
                            .snapshot()
                            .history_of(&profile)
                            .map(|history| history.entries().cloned().collect())
                            .unwrap_or_default();
                        me.dispatch_quietly(Action::ReplaceHistory {
                            entries: merged_history(engine, &kept),
                            profile,
                        });
                    }
                    Err(problem) => {
                        log::warn!("{profile}'s history couldn't be read: {problem}");
                    }
                }
            });
        }
    }

    pub(crate) fn engine_history_changed(&self, event: &ServiceEvent) {
        let state = self.store.snapshot();
        let engine_profile = event
            .payload
            .get("profile")
            .and_then(Value::as_str)
            .or(event.profile.as_deref())
            .unwrap_or_default();
        let Some(profile) = owner_of(&state, engine_profile) else {
            return;
        };
        let Some(changes) = event.payload.get("changes").and_then(Value::as_array) else {
            return;
        };
        for change in changes {
            if change.get("kind").and_then(Value::as_str) != Some("deleted") {
                continue;
            }
            if change.get("all").and_then(Value::as_bool) == Some(true) {
                self.bridge.lock().history_loaded.remove(&profile);
                continue;
            }
            let urls: Vec<String> = change
                .get("urls")
                .and_then(Value::as_array)
                .map(|urls| {
                    urls.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            if !urls.is_empty() {
                self.dispatch_quietly(Action::RemoveHistoryPages {
                    profile: profile.clone(),
                    urls,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn engine_rows_become_history_entries() {
        let answer = json!({ "entries": [
            { "u": "https://a.example/", "t": "A", "n": 3, "v": [10, 20, 30] },
            { "u": "chrome://settings", "t": "Settings", "n": 1, "v": [5] },
            { "u": "file:///tmp/x.html", "t": "", "n": 1, "v": [7] },
            { "t": "no url" }
        ]});
        let entries = engine_entries(&answer);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].last_visit, 30);
        assert_eq!(entries[0].visits, 3);
        assert!(engine_entries(&json!({})).is_empty());
    }

    #[test]
    fn newer_app_visits_win_the_merge() {
        let engine = vec![HistoryEntry {
            url: "https://a.example/".into(),
            title: "Old".into(),
            favicon: None,
            visits: 1,
            last_visit: 10,
            visit_times: vec![10],
        }];
        let kept = vec![HistoryEntry {
            url: "https://a.example/".into(),
            title: "New".into(),
            favicon: None,
            visits: 2,
            last_visit: 20,
            visit_times: vec![10, 20],
        }];
        let merged = merged_history(engine, &kept);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].title, "New");
    }
}
