use crate::omnibox::url::host_of;
use serde_json::{Map, Value, json};

pub const SESSION_VERSION: u64 = 11;
pub const OLDEST_SESSION_VERSION: u64 = 2;
pub const ROW_KEYS: [&str; 4] = ["windows", "tabs", "groups", "splits"];
const LEGACY_PAGE_FIELDS: [&str; 5] =
    ["navigation", "adoptId", "pageIn", "unloaded", "wakeAdoptId"];
const CLEAN_UP_KEY: &str = "cleanUpInactiveTabsAfterMinutes";
const LEGACY_CLEAN_UP_KEY: &str = "cleanUpInactiveTabsAfterHours";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RowShape {
    pub tables: bool,
    pub misfiled: bool,
}

fn filed_under(key: &str, row: &Value) -> bool {
    row.get("id").and_then(Value::as_str) == Some(key)
}

pub fn table_rows(table: &Map<String, Value>) -> Vec<Value> {
    let filed: std::collections::HashSet<&str> = table
        .iter()
        .filter(|(k, row)| filed_under(k, row))
        .map(|(k, _)| k.as_str())
        .collect();
    table
        .iter()
        .filter(|(k, row)| {
            filed_under(k, row)
                || !row
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| filed.contains(id))
        })
        .map(|(_, row)| row.clone())
        .collect()
}

pub fn listed_rows(doc: &mut Map<String, Value>) -> RowShape {
    let mut shape = RowShape::default();
    for key in ROW_KEYS {
        let Some(Value::Object(table)) = doc.get(key) else {
            continue;
        };
        shape.tables = true;
        shape.misfiled |= table
            .iter()
            .any(|(k, row)| row.is_object() && !filed_under(k, row));
        let rows = table_rows(table);
        doc.insert(key.to_owned(), Value::Array(rows));
    }
    shape
}

fn rows_mut<'a>(
    doc: &'a mut Map<String, Value>,
    key: &str,
) -> impl Iterator<Item = &'a mut Map<String, Value>> {
    doc.get_mut(key)
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object_mut)
}

fn each_snapshot(doc: &mut Map<String, Value>, mut visit: impl FnMut(&mut Map<String, Value>)) {
    for row in rows_mut(doc, "tabs") {
        visit(row);
    }
    for key in ["closedTabs", "cleanedTabs"] {
        for entry in rows_mut(doc, key) {
            if let Some(tab) = entry.get_mut("tab").and_then(Value::as_object_mut) {
                visit(tab);
            }
        }
    }
    for key in ["closedWindows", "closedGroups", "deletedGroups"] {
        for entry in rows_mut(doc, key) {
            for tab in entry
                .get_mut("tabs")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object_mut)
            {
                visit(tab);
            }
        }
    }
    if let Some(parked) = doc.get_mut("parkedPins").and_then(Value::as_object_mut) {
        for park in parked.values_mut().filter_map(Value::as_object_mut) {
            for tab in park
                .get_mut("tabs")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object_mut)
            {
                visit(tab);
            }
        }
    }
}

fn settings_mut(doc: &mut Map<String, Value>) -> Option<&mut Map<String, Value>> {
    doc.get_mut("settings").and_then(Value::as_object_mut)
}

fn rename_in(list: Option<&mut Value>, from: &str, to: &str) {
    for key in list.and_then(Value::as_array_mut).into_iter().flatten() {
        if key.as_str() == Some(from) {
            *key = to.into();
        }
    }
}

fn clean_up_minutes(doc: &mut Map<String, Value>) {
    let Some(settings) = settings_mut(doc) else {
        return;
    };
    let Some(hours) = settings.shift_remove(LEGACY_CLEAN_UP_KEY) else {
        return;
    };
    let minutes = match &hours {
        Value::Null => Some(Value::Null),
        Value::Number(n) => n
            .as_f64()
            .filter(|h| h.is_finite() && *h > 0.0)
            .map(|h| json!(((h * 60.0).round()).max(1.0) as i64)),
        _ => None,
    };
    if let Some(minutes) = minutes {
        settings.entry(CLEAN_UP_KEY).or_insert(minutes);
    }
    rename_in(
        settings.get_mut("chosen"),
        LEGACY_CLEAN_UP_KEY,
        CLEAN_UP_KEY,
    );
    rename_in(
        settings.get_mut("inferred"),
        LEGACY_CLEAN_UP_KEY,
        CLEAN_UP_KEY,
    );
}

fn own_tab_mutes(doc: &mut Map<String, Value>) {
    let sites: std::collections::HashSet<String> = doc
        .get("settings")
        .and_then(|s| s.get("mutedSites"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    if sites.is_empty() {
        return;
    }
    each_snapshot(doc, |tab| {
        let incognito = tab
            .get("profileId")
            .and_then(Value::as_str)
            .is_some_and(|p| p.starts_with("incognito:"));
        let muted_site = tab
            .get("url")
            .and_then(Value::as_str)
            .map(host_of)
            .is_some_and(|host| !host.is_empty() && sites.contains(&host));
        if tab.get("muted") == Some(&Value::Bool(true)) && !incognito && muted_site {
            tab.insert("muted".into(), false.into());
        }
    });
}

fn tab_pages(doc: &mut Map<String, Value>) {
    for tab in rows_mut(doc, "tabs") {
        if tab.get("page").is_some_and(Value::is_object)
            && !LEGACY_PAGE_FIELDS.iter().any(|k| tab.contains_key(*k))
        {
            continue;
        }
        let asleep = tab.get("unloaded") == Some(&Value::Bool(true));
        let wake = tab
            .get("wakeAdoptId")
            .and_then(Value::as_str)
            .filter(|w| w.starts_with(crate::model::RESTORE_PREFIX))
            .map(str::to_owned);
        for key in LEGACY_PAGE_FIELDS {
            tab.shift_remove(key);
        }
        let mut page = Map::new();
        page.insert("kind".into(), if asleep { "asleep" } else { "idle" }.into());
        if let Some(wake) = wake {
            page.insert("wake".into(), wake.into());
        }
        tab.insert("page".into(), Value::Object(page));
    }
}

fn tab_pin(tab: &mut Map<String, Value>) {
    let legacy = tab.contains_key("pinned")
        || tab.contains_key("pinnedAsRow")
        || tab.contains_key("tileFolder");
    if tab.contains_key("pin") && !legacy {
        return;
    }
    let pinned = tab.shift_remove("pinned") == Some(Value::Bool(true));
    let row = tab.shift_remove("pinnedAsRow") == Some(Value::Bool(true));
    let folder = tab.shift_remove("tileFolder").filter(|f| {
        f.get("id").is_some_and(Value::is_string) && f.get("name").is_some_and(Value::is_string)
    });
    let pin = match (pinned, row, folder) {
        (false, _, _) => Value::Null,
        (true, true, _) => json!({"as": "row"}),
        (true, false, Some(folder)) => json!({"as": "tile", "folder": folder}),
        (true, false, None) => json!({"as": "tile"}),
    };
    tab.insert("pin".into(), pin);
}

fn tab_pins(doc: &mut Map<String, Value>) {
    each_snapshot(doc, tab_pin);
}

fn sizes_or(value: Option<&Value>, n: usize) -> Vec<Value> {
    match value.and_then(Value::as_array) {
        Some(sizes) if sizes.len() == n && sizes.iter().all(crate::json::is_size) => sizes.clone(),
        _ => vec![json!(1.0 / n as f64); n],
    }
}

fn slots_from_panes(ids: &[String], sizes: Option<&Value>, stack: Option<&Value>) -> Vec<Value> {
    let at = stack
        .and_then(|s| s.get("index"))
        .and_then(Value::as_u64)
        .map(|i| i as usize)
        .filter(|i| *i + 1 < ids.len());
    let stack_sizes = sizes_or(stack.and_then(|s| s.get("sizes")), 2);
    let mut panes: Vec<Vec<&String>> = Vec::new();
    let mut i = 0;
    while i < ids.len() {
        if Some(i) == at {
            panes.push(vec![&ids[i], &ids[i + 1]]);
            i += 2;
        } else {
            panes.push(vec![&ids[i]]);
            i += 1;
        }
    }
    let outer = sizes_or(sizes, panes.len());
    panes
        .iter()
        .zip(outer)
        .map(|(pane, size)| match pane.as_slice() {
            [one] => json!({"size": size, "tabId": one}),
            [a, b] => json!({"size": size, "stack": [a, b], "stackSizes": stack_sizes}),
            _ => Value::Null,
        })
        .collect()
}

fn with_slots(split: &mut Map<String, Value>, ids_key: &str) {
    let Some(ids) = split
        .get(ids_key)
        .and_then(Value::as_array)
        .and_then(|list| {
            list.iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<String>>>()
        })
    else {
        return;
    };
    let slots = slots_from_panes(&ids, split.get("sizes"), split.get("stack"));
    split.shift_remove(ids_key);
    split.shift_remove("sizes");
    split.shift_remove("stack");
    split.insert("slots".into(), Value::Array(slots));
}

fn split_slots(doc: &mut Map<String, Value>) {
    for split in rows_mut(doc, "splits") {
        with_slots(split, "tabIds");
    }
    if let Some(parked) = doc.get_mut("parkedPins").and_then(Value::as_object_mut) {
        for park in parked.values_mut().filter_map(Value::as_object_mut) {
            for split in park
                .get_mut("splits")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object_mut)
            {
                with_slots(split, "ids");
            }
        }
    }
}

fn strings_of(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|list| {
        list.iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    })
}

fn settings_meta(doc: &mut Map<String, Value>) {
    let Some(settings) = settings_mut(doc) else {
        return;
    };
    let has_meta_inside = settings.contains_key("chosen") || settings.contains_key("inferred");
    if !has_meta_inside && doc.get("settingsMeta").is_some_and(Value::is_object) {
        return;
    }
    let Some(settings) = settings_mut(doc) else {
        return;
    };
    let mut chosen = strings_of(settings.get("chosen"));
    let mut inferred = strings_of(settings.get("inferred"));
    if settings.get("newTabButtonPosition").is_none()
        && settings.get("newTabPosition").and_then(Value::as_str) == Some("top")
    {
        settings.insert("newTabButtonPosition".into(), "top".into());
        for keys in [chosen.as_mut(), inferred.as_mut()].into_iter().flatten() {
            if keys.iter().any(|k| k == "newTabPosition")
                && !keys.iter().any(|k| k == "newTabButtonPosition")
            {
                keys.push("newTabButtonPosition".into());
            }
        }
    }
    if let Some(battery) = settings.shift_remove("batterySaver") {
        let chosen_here = chosen
            .as_ref()
            .is_some_and(|c| c.iter().any(|k| k == "batterySaver"))
            && !inferred
                .as_ref()
                .is_some_and(|i| i.iter().any(|k| k == "batterySaver"));
        let explicit =
            battery == Value::Bool(false) || (battery == Value::Bool(true) && chosen_here);
        for keys in [chosen.as_mut(), inferred.as_mut()].into_iter().flatten() {
            keys.retain(|k| k != "batterySaver");
        }
        if explicit {
            if let Some(c) = chosen.as_mut()
                && !c.iter().any(|k| k == "batterySaverWhen")
            {
                c.push("batterySaverWhen".into());
            }
            settings.entry("batterySaverWhen").or_insert_with(|| {
                if battery == Value::Bool(true) {
                    "unplugged"
                } else {
                    "never"
                }
                .into()
            });
        }
    }
    let legacy: Option<Vec<String>> = chosen.is_none().then(|| settings.keys().cloned().collect());
    settings.shift_remove("chosen");
    settings.shift_remove("inferred");
    let meta = json!({"chosen": legacy.clone().unwrap_or_else(|| chosen.unwrap_or_default()), "inferred": legacy.unwrap_or_else(|| inferred.unwrap_or_default())});
    doc.insert("settingsMeta".into(), meta);
}

fn pin_choice_stamps(doc: &mut Map<String, Value>) {
    let Some(choices) = doc.get_mut("pinChoices").and_then(Value::as_object_mut) else {
        return;
    };
    for mine in choices.values_mut() {
        match mine.as_object_mut() {
            Some(entries) => entries.retain(|_, choice| choice.is_string()),
            None => *mine = Value::Object(Map::new()),
        }
    }
}

fn without_untouched_setting(doc: &mut Map<String, Value>, key: &str, old: Value) {
    let Some(settings) = doc.get("settings").and_then(Value::as_object) else {
        return;
    };
    if settings.get(key) != Some(&old) {
        return;
    }
    let meta = crate::settings::SettingsMeta::from_value(doc.get("settingsMeta"));
    if meta.chosen_here(key) {
        return;
    }
    if let Some(settings) = settings_mut(doc) {
        settings.shift_remove(key);
    }
    let without = |keys: Vec<String>| keys.into_iter().filter(|k| k != key).collect::<Vec<_>>();
    doc.insert(
        "settingsMeta".into(),
        json!({"chosen": without(meta.chosen), "inferred": without(meta.inferred)}),
    );
}

pub fn migrate_session(doc: &mut Map<String, Value>, from: u64) -> bool {
    if from < OLDEST_SESSION_VERSION {
        return false;
    }
    for version in from..SESSION_VERSION {
        listed_rows(doc);
        match version {
            2 => clean_up_minutes(doc),
            3 => own_tab_mutes(doc),
            4 => tab_pages(doc),
            5 => tab_pins(doc),
            6 => split_slots(doc),
            7 => settings_meta(doc),
            8 => pin_choice_stamps(doc),
            9 => without_untouched_setting(doc, "littleArdiaOpensNewTabLinks", Value::Bool(false)),
            10 => without_untouched_setting(doc, "showUnreadCounts", Value::Bool(true)),
            _ => return false,
        }
        doc.insert("version".into(), (version + 1).into());
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated(mut doc: Value, from: u64) -> Value {
        let fields = doc.as_object_mut().unwrap();
        assert!(migrate_session(fields, from));
        doc
    }

    #[test]
    fn version_two_sessions_reach_the_current_shape() {
        let v2 = json!({
            "version": 2,
            "settings": {"cleanUpInactiveTabsAfterHours": 12, "mutedSites": ["noisy.example"], "newTabPosition": "top", "batterySaver": false, "chosen": ["newTabPosition", "cleanUpInactiveTabsAfterHours"], "showUnreadCounts": true},
            "windows": [{"id": "w", "profileId": "default", "tabIds": ["t1", "t2"], "activeTabIds": {"default": "t1"}}],
            "tabs": [
                {"id": "t1", "windowId": "w", "profileId": "default", "url": "https://noisy.example/", "muted": true, "pinned": true, "pinnedAsRow": true, "unloaded": true, "wakeAdoptId": "restore:t1"},
                {"id": "t2", "windowId": "w", "profileId": "default", "url": "https://b.example/", "pinned": true, "tileFolder": {"id": "f", "name": "Work"}, "navigation": {}}
            ],
            "splits": [{"id": "s", "windowId": "w", "orientation": "horizontal", "tabIds": ["t1", "t2"], "sizes": [0.3, 0.7]}],
            "pinChoices": {"default": {"t1": 1795000000000u64, "g": "0abc.0000."}}
        });
        let doc = migrated(v2, 2);
        assert_eq!(doc["version"], json!(11));
        let settings = &doc["settings"];
        assert_eq!(settings["cleanUpInactiveTabsAfterMinutes"], json!(720));
        assert_eq!(settings["newTabButtonPosition"], json!("top"));
        assert_eq!(settings["batterySaverWhen"], json!("never"));
        assert!(
            settings.get("chosen").is_none()
                && settings.get("batterySaver").is_none()
                && settings.get("showUnreadCounts").is_none()
        );
        assert!(
            doc["settingsMeta"]["chosen"]
                .as_array()
                .unwrap()
                .contains(&json!("cleanUpInactiveTabsAfterMinutes"))
        );
        let t1 = &doc["tabs"][0];
        assert_eq!(t1["muted"], json!(false));
        assert_eq!(t1["pin"], json!({"as": "row"}));
        assert_eq!(t1["page"], json!({"kind": "asleep", "wake": "restore:t1"}));
        assert!(t1.get("unloaded").is_none() && t1.get("pinned").is_none());
        assert_eq!(
            doc["tabs"][1]["pin"],
            json!({"as": "tile", "folder": {"id": "f", "name": "Work"}})
        );
        assert_eq!(
            doc["splits"][0]["slots"],
            json!([{"size": 0.3, "tabId": "t1"}, {"size": 0.7, "tabId": "t2"}])
        );
        assert_eq!(doc["pinChoices"], json!({"default": {"g": "0abc.0000."}}));
    }

    #[test]
    fn stacked_legacy_splits_become_stack_slots() {
        let doc = migrated(
            json!({"version": 6, "splits": [{"id": "s", "windowId": "w", "orientation": "horizontal", "tabIds": ["a", "b", "c"], "stack": {"index": 1, "sizes": [0.4, 0.6]}}]}),
            6,
        );
        assert_eq!(
            doc["splits"][0]["slots"][1],
            json!({"size": 0.5, "stack": ["b", "c"], "stackSizes": [0.4, 0.6]})
        );
    }

    #[test]
    fn table_rows_become_lists_and_misfiled_rows_are_noticed() {
        let mut doc =
            json!({"tabs": {"t1": {"id": "t1"}, "x": {"id": "t2"}, "dupe": {"id": "t1"}}})
                .as_object()
                .unwrap()
                .clone();
        let shape = listed_rows(&mut doc);
        assert!(shape.tables && shape.misfiled);
        assert_eq!(doc["tabs"], json!([{"id": "t1"}, {"id": "t2"}]));
    }

    #[test]
    fn too_old_or_unknown_versions_are_refused() {
        let mut doc = Map::new();
        assert!(!migrate_session(&mut doc, 1));
        assert!(migrate_session(&mut doc, SESSION_VERSION));
    }

    #[test]
    fn untouched_retired_defaults_are_dropped_but_chosen_ones_stay() {
        let doc = migrated(
            json!({"version": 9, "settings": {"littleArdiaOpensNewTabLinks": false}, "settingsMeta": {"chosen": [], "inferred": []}}),
            9,
        );
        assert!(doc["settings"].get("littleArdiaOpensNewTabLinks").is_none());
        let kept = migrated(
            json!({"version": 9, "settings": {"littleArdiaOpensNewTabLinks": false}, "settingsMeta": {"chosen": ["littleArdiaOpensNewTabLinks"], "inferred": []}}),
            9,
        );
        assert_eq!(
            kept["settings"]["littleArdiaOpensNewTabLinks"],
            json!(false)
        );
    }
}
