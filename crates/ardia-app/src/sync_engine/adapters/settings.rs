use std::collections::HashSet;
use std::sync::Arc;

use ardia_state::BrowserState;
use ardia_state::actions::Action;
use ardia_state::settings::{RETIRED_DEFAULTS, SETTINGS, Settings, SettingsMeta, SettingsPatch};
use ardia_state::sync_engine::canonical;
use ardia_state::sync_engine::scope::{
    Adapter, ApplyRecords, ExtractContext, Extraction, ScopeState, SyncRecord,
};
use ardia_state::sync_engine::{IndexMap, IndexSet};
use serde_json::{Value, json};

use super::{CycleContext, InTodaysNames, from_legacy};

pub const SETTING: &str = "set:";
pub const CLEAN_UP_KEY: &str = "cleanUpInactiveTabsAfterMinutes";
pub const LEGACY_CLEAN_UP_KEY: &str = "cleanUpInactiveTabsAfterHours";
const TAB_SWITCHER_MODES: [&str; 2] = ["tabSwitcherOrder", "tabSwitcherView"];

pub fn synced_settings() -> impl Iterator<Item = &'static str> {
    SETTINGS.iter().filter(|s| s.synced).map(|s| s.key)
}

fn is_synced(name: &str) -> bool {
    synced_settings().any(|k| k == name)
}

pub fn record_key(name: &str) -> String {
    format!(
        "{SETTING}{}",
        if name == CLEAN_UP_KEY {
            LEGACY_CLEAN_UP_KEY
        } else {
            name
        }
    )
}

fn setting_of(key: &str) -> &str {
    let name = key.get(SETTING.len()..).unwrap_or_default();
    if name == LEGACY_CLEAN_UP_KEY {
        CLEAN_UP_KEY
    } else {
        name
    }
}

fn number(v: f64) -> Value {
    ardia_state::json::js_number(v)
}

fn to_record(name: &str, value: &Value) -> Value {
    if name != CLEAN_UP_KEY {
        return value.clone();
    }
    match value.as_f64() {
        Some(minutes) => number(minutes / 60.0),
        None => Value::Null,
    }
}

fn from_record(name: &str, value: &Value) -> Option<Value> {
    if name != CLEAN_UP_KEY {
        return Some(value.clone());
    }
    if value.is_null() {
        return Some(Value::Null);
    }
    let hours = value.as_f64().filter(|h| h.is_finite() && *h > 0.0)?;
    Some(number((hours * 60.0).round().max(1.0)))
}

pub fn valid_setting_value(name: &str, value: &Value) -> bool {
    Settings::default().set(name, value).is_ok()
}

fn default_of(name: &str) -> Value {
    Settings::default().get(name).unwrap_or(Value::Null)
}

fn record_v(record: Option<&Value>) -> Option<Value> {
    record
        .and_then(|r| r.get("v"))
        .filter(|v| !v.is_null())
        .cloned()
}

pub struct SettingsAdapter {
    cx: CycleContext,
}

pub fn adapter(cx: &CycleContext) -> Box<dyn Adapter> {
    Box::new(InTodaysNames(SettingsAdapter { cx: cx.clone() }))
}

pub fn extract_values(
    state: &BrowserState,
    base: impl Fn(&str) -> Option<Value>,
) -> IndexMap<String, Value> {
    let settings = &state.settings;
    let chosen: HashSet<&str> = state
        .settings_meta
        .chosen
        .iter()
        .map(String::as_str)
        .collect();
    let inferred: HashSet<&str> = state
        .settings_meta
        .inferred
        .iter()
        .map(String::as_str)
        .collect();
    let last = |name: &str| record_v(base(&record_key(name)).as_ref());
    let filled_in = |name: &str, value: &Value| {
        inferred.contains(name)
            && canonical(value) == canonical(&default_of(name))
            && last(name).is_none()
    };
    let from_newer = |name: &str| {
        last(name)
            .is_some_and(|v| from_record(name, &v).is_none_or(|v| !valid_setting_value(name, &v)))
    };
    let synced_elsewhere = |name: &str| last(name).is_some();
    let mut values = IndexMap::new();
    for name in synced_settings() {
        let Some(value) = settings.get(name) else {
            continue;
        };
        if !chosen.contains(name) || filled_in(name, &value) || from_newer(name) {
            continue;
        }
        if TAB_SWITCHER_MODES.contains(&name) && inferred.contains(name) && synced_elsewhere(name) {
            continue;
        }
        values.insert(record_key(name), json!({ "v": to_record(name, &value) }));
    }
    if values.contains_key(&record_key("shortcuts")) {
        for name in TAB_SWITCHER_MODES {
            let value = settings.get(name).unwrap_or(Value::Null);
            if values.contains_key(&record_key(name))
                || value == default_of(name)
                || from_newer(name)
                || synced_elsewhere(name)
            {
                continue;
            }
            values.insert(record_key(name), json!({ "v": value }));
        }
    }
    values
}

pub fn settings_patch(
    state: &BrowserState,
    visible: &IndexMap<String, Value>,
    changed: &[String],
) -> SettingsPatch {
    let mut patch = SettingsPatch::new();
    for key in changed {
        let name = setting_of(key);
        let Some(record) = visible.get(key) else {
            continue;
        };
        if *key != record_key(name) || !is_synced(name) {
            continue;
        }
        let Some(value) = record.get("v").and_then(|v| from_record(name, v)) else {
            continue;
        };
        if valid_setting_value(name, &value) {
            patch = patch.set(name, value);
        }
    }
    let chosen = &state.settings_meta.chosen;
    let modes_synced = TAB_SWITCHER_MODES
        .iter()
        .any(|n| visible.contains_key(&record_key(n)));
    let modes_explicit = modes_synced
        || TAB_SWITCHER_MODES
            .iter()
            .any(|n| chosen.iter().any(|c| c == n));
    let shortcuts = visible
        .get(&record_key("shortcuts"))
        .and_then(|r| r.get("v"))
        .filter(|v| valid_setting_value("shortcuts", v))
        .cloned();
    if modes_synced
        && TAB_SWITCHER_MODES
            .iter()
            .any(|n| changed.contains(&record_key(n)))
        && let Some(shortcuts) = &shortcuts
    {
        if !patch.contains("shortcuts") {
            patch = patch.set("shortcuts", shortcuts.clone());
        }
        for name in TAB_SWITCHER_MODES {
            if !visible.contains_key(&record_key(name))
                && !patch.contains(name)
                && !chosen.iter().any(|c| c == name)
            {
                patch = patch.set(name, default_of(name));
            }
        }
    }
    if patch.contains("shortcuts")
        && !modes_explicit
        && !TAB_SWITCHER_MODES.iter().any(|n| patch.contains(n))
    {
        for name in TAB_SWITCHER_MODES {
            patch = patch.set(name, default_of(name));
        }
    }
    patch
}

fn apply_setting_records(cx: &CycleContext, visible: &IndexMap<String, Value>, changed: &[String]) {
    let patch = settings_patch(&cx.host.state(), visible, changed);
    if !patch.is_empty() {
        let _ = cx.host.dispatch(Action::UpdateSettings {
            patch,
            from_sync: true,
        });
    }
}

impl Adapter for SettingsAdapter {
    fn prefix(&self) -> &str {
        SETTING
    }

    fn adopt_remote_on_join(&self) -> bool {
        true
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let values = extract_values(&self.cx.host.state(), |key| cx.base(key));
        let mine: HashSet<String> = values.keys().cloned().collect();
        Some(Extraction::of(values).ignoring(move |key| !mine.contains(key)))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        let changed: Vec<String> = changed.iter().cloned().collect();
        apply_setting_records(&self.cx, visible, &changed);
        true
    }
}

fn chosen_here(meta: &SettingsMeta, key: &str) -> bool {
    meta.chosen.iter().any(|k| k == key) && !meta.inferred.iter().any(|k| k == key)
}

fn legacy_record_v(records: &IndexMap<String, SyncRecord>, key: &str) -> Option<Value> {
    let record = records.get(key)?;
    from_legacy(&record.v).get("v").cloned()
}

pub fn settings_to_reapply(
    state: &BrowserState,
    records: &IndexMap<String, SyncRecord>,
) -> Vec<String> {
    let meta = &state.settings_meta;
    let chosen: HashSet<&str> = meta.chosen.iter().map(String::as_str).collect();
    let inferred_mode =
        |name: &str| TAB_SWITCHER_MODES.contains(&name) && meta.inferred.iter().any(|k| k == name);
    synced_settings()
        .filter_map(|name| {
            let key = record_key(name);
            let value = legacy_record_v(records, &key).and_then(|v| from_record(name, &v))?;
            if (chosen.contains(name) && !inferred_mode(name)) || !valid_setting_value(name, &value)
            {
                return None;
            }
            (canonical(&value) != canonical(&state.settings.get(name).unwrap_or(Value::Null)))
                .then_some(key)
        })
        .collect()
}

pub fn retired_defaults_held_by_sync(
    state: &BrowserState,
    records: &IndexMap<String, SyncRecord>,
) -> IndexMap<String, Value> {
    let meta = &state.settings_meta;
    let mut held = IndexMap::new();
    for retired in RETIRED_DEFAULTS
        .iter()
        .filter(|r| !meta.inferred.iter().any(|k| k == r.applied))
    {
        let key = record_key(retired.key);
        let Some(value) = legacy_record_v(records, &key).and_then(|v| from_record(retired.key, &v))
        else {
            continue;
        };
        if chosen_here(meta, retired.key)
            || value.is_null()
            || !valid_setting_value(retired.key, &value)
        {
            continue;
        }
        held.insert(key, json!({ "v": to_record(retired.key, &value) }));
    }
    held
}

pub fn settled_retired_defaults(
    state: &BrowserState,
    held_by_sync: &dyn Fn(&str) -> bool,
) -> Option<BrowserState> {
    let mut meta = (*state.settings_meta).clone();
    let mut settings = (*state.settings).clone();
    for retired in RETIRED_DEFAULTS {
        if meta.inferred.iter().any(|k| k == retired.applied) {
            continue;
        }
        let unchosen = |meta: &mut SettingsMeta| {
            meta.chosen.retain(|k| k != retired.key);
            meta.inferred.retain(|k| k != retired.key);
            meta.inferred.push(retired.applied.to_owned());
        };
        if held_by_sync(retired.key) && !chosen_here(&meta, retired.key) {
            unchosen(&mut meta);
            continue;
        }
        let old_nobody_chose = settings.get(retired.key) == Some(Value::Bool(retired.old))
            && !chosen_here(&meta, retired.key);
        if !old_nobody_chose {
            meta.inferred.push(retired.applied.to_owned());
            continue;
        }
        let _ = settings.set(retired.key, &default_of(retired.key));
        unchosen(&mut meta);
    }
    if meta == *state.settings_meta && settings == *state.settings {
        return None;
    }
    let mut next = state.clone();
    next.settings = Arc::new(settings);
    next.settings_meta = Arc::new(meta);
    Some(next)
}

pub fn settle_from_saved_sync(
    cx: &CycleContext,
    app: Option<&mut ScopeState>,
    settings_synced: bool,
) {
    let state = cx.host.state();
    let held = match (&app, settings_synced) {
        (Some(app), true) => retired_defaults_held_by_sync(&state, &app.records),
        _ => IndexMap::new(),
    };
    if !held.is_empty() {
        let keys: Vec<String> = held.keys().cloned().collect();
        apply_setting_records(cx, &held, &keys);
    }
    let held_keys: HashSet<String> = held.keys().cloned().collect();
    super::data_engine::edit_state(cx, move |state| {
        settled_retired_defaults(state, &|name| held_keys.contains(&record_key(name)))
    });
    if let Some(app) = app {
        let reapply = settings_to_reapply(&cx.host.state(), &app.records);
        for key in reapply {
            if !app.unapplied.contains(&key) {
                app.unapplied.push(key);
            }
        }
    }
}

pub fn settle_without_sync(cx: &CycleContext) {
    super::data_engine::edit_state(cx, |state| settled_retired_defaults(state, &|_| false));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::adapters::data_engine::fake;
    use crate::sync_engine::adapters::tests_support::{MemoryTransport, run_cycle};
    use ardia_state::settings::SettingsMeta;

    fn state_with(chosen: &[&str], patch: SettingsPatch) -> BrowserState {
        let mut state = BrowserState::default();
        let mut settings = Settings::default();
        let mut meta = SettingsMeta::default();
        settings.apply(&mut meta, &patch, false, false);
        meta.chosen = chosen.iter().map(|s| (*s).to_owned()).collect();
        state.settings = Arc::new(settings);
        state.settings_meta = Arc::new(meta);
        state
    }

    #[test]
    fn only_chosen_synced_settings_publish_with_the_old_record_shape() {
        let state = state_with(
            &["appearance", "sidebarWidth", CLEAN_UP_KEY],
            SettingsPatch::new()
                .set("appearance", "dark")
                .set("sidebarWidth", 300.0)
                .set(CLEAN_UP_KEY, 90.0),
        );
        let values = extract_values(&state, |_| None);
        assert_eq!(values.get("set:appearance"), Some(&json!({ "v": "dark" })));
        assert_eq!(
            values.get("set:cleanUpInactiveTabsAfterHours"),
            Some(&json!({ "v": 1.5 }))
        );
        assert!(!values.contains_key("set:sidebarWidth"));
        assert_eq!(values.len(), 2);
    }

    #[test]
    fn records_from_a_newer_version_are_never_overwritten() {
        let state = state_with(
            &["appearance"],
            SettingsPatch::new().set("appearance", "dark"),
        );
        let values = extract_values(&state, |key| {
            (key == "set:appearance").then(|| json!({ "v": "sepia" }))
        });
        assert!(values.is_empty());
    }

    #[test]
    fn applying_converts_hours_and_skips_unsynced_and_invalid_values() {
        let state = BrowserState::default();
        let visible: IndexMap<String, Value> = [
            (
                "set:cleanUpInactiveTabsAfterHours".to_owned(),
                json!({ "v": 2 }),
            ),
            ("set:sidebarWidth".to_owned(), json!({ "v": 400 })),
            ("set:appearance".to_owned(), json!({ "v": 7 })),
            ("set:futureThing".to_owned(), json!({ "v": true })),
        ]
        .into_iter()
        .collect();
        let changed: Vec<String> = visible.keys().cloned().collect();
        let patch = settings_patch(&state, &visible, &changed);
        assert_eq!(patch.get(CLEAN_UP_KEY), Some(&json!(120)));
        assert!(
            !patch.contains("sidebarWidth")
                && !patch.contains("appearance")
                && !patch.contains("futureThing")
        );
    }

    #[test]
    fn nulls_from_another_mac_are_no_say_but_never_is_a_value() {
        let state = BrowserState::default();
        let visible: IndexMap<String, Value> = [
            (
                "set:cmdClickCreatesTabGroup".to_owned(),
                json!({ "v": null }),
            ),
            ("set:optShiftClickOpensInGroup".to_owned(), json!({})),
            (
                "set:cleanUpInactiveTabsAfterHours".to_owned(),
                json!({ "v": null }),
            ),
        ]
        .into_iter()
        .collect();
        let changed: Vec<String> = visible.keys().cloned().collect();
        let patch = settings_patch(&state, &visible, &changed);
        assert_eq!(patch.keys().collect::<Vec<_>>(), vec![CLEAN_UP_KEY]);
        assert_eq!(patch.get(CLEAN_UP_KEY), Some(&Value::Null));
        let filled = state_with(
            &["cmdClickCreatesTabGroup"],
            SettingsPatch::new().set("cmdClickCreatesTabGroup", false),
        );
        let mut meta = (*filled.settings_meta).clone();
        meta.inferred.push("cmdClickCreatesTabGroup".into());
        let mut filled = filled;
        filled.settings_meta = Arc::new(meta);
        assert!(!extract_values(&filled, |_| None).contains_key("set:cmdClickCreatesTabGroup"));
    }

    #[test]
    fn retired_defaults_settle_like_the_old_app() {
        let state = state_with(
            &[],
            SettingsPatch::new()
                .set("cmdClickCreatesTabGroup", true)
                .set("hideToolbarWhileScrolling", true),
        );
        let settled =
            settled_retired_defaults(&state, &|key| key == "cmdClickCreatesTabGroup").unwrap();
        assert!(settled.settings.cmd_click_creates_tab_group);
        assert!(!settled.settings.hide_toolbar_while_scrolling);
        assert!(
            settled
                .settings_meta
                .inferred
                .contains(&"cmdClickCreatesTabGroup:offByDefault".to_owned())
        );
        assert!(settled_retired_defaults(&settled, &|_| false).is_none());
    }

    #[test]
    fn two_macs_converge_on_settings_and_leave_unknown_records_alone() {
        let transport = MemoryTransport::default();
        let (a, _) = fake::context(
            state_with(
                &["appearance"],
                SettingsPatch::new().set("appearance", "dark"),
            ),
            "AAAA",
        );
        let (b, _) = fake::context(BrowserState::default(), "BBBB");
        let mut scope_a = ScopeState {
            joined: true,
            ..ScopeState::default()
        };
        let mut scope_b = ScopeState {
            joined: true,
            ..ScopeState::default()
        };
        run_cycle(&transport, "app", &mut scope_a, "AAAA", vec![adapter(&a)]);
        transport.inject("app", "ZZZZ", vec![("set:futureThing", json!({ "v": 1 }))]);
        run_cycle(&transport, "app", &mut scope_b, "BBBB", vec![adapter(&b)]);
        assert_eq!(
            b.host.state().settings.get("appearance"),
            Some(json!("dark"))
        );
        b.host
            .dispatch(Action::UpdateSettings {
                patch: SettingsPatch::new().set("appearance", "light"),
                from_sync: false,
            })
            .unwrap();
        run_cycle(&transport, "app", &mut scope_b, "BBBB", vec![adapter(&b)]);
        run_cycle(&transport, "app", &mut scope_a, "AAAA", vec![adapter(&a)]);
        assert_eq!(
            a.host.state().settings.get("appearance"),
            Some(json!("light"))
        );
        assert_eq!(scope_a.records["set:futureThing"].v, json!({ "v": 1 }));
        assert_eq!(scope_b.records["set:futureThing"].v, json!({ "v": 1 }));
        assert!(
            transport
                .all_ops()
                .iter()
                .all(|(k, v)| k != "set:futureThing" || !v.is_null())
        );
    }
}
