use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use ardia_state::settings::Settings;
use serde_json::{Map, Value};

use super::records::{AppliedStep, PluginRecord};

pub const CONFIG_FILE: &str = "config.json";

pub const CONFIG_SETTING_KEYS: &[&str] = &[
    "warnBeforeQuitting",
    "warnBeforeClosingWindow",
    "restoreSession",
    "separateDownloadFolders",
    "searchEngine",
    "searchSuggestions",
    "commandBarHistory",
    "showSelectionSearch",
    "blockNotificationRequests",
    "tabLayout",
    "autoHideTabs",
    "sidebarSide",
    "hideToolbarWhileScrolling",
    "newTabPosition",
    "newTabButtonPosition",
    "showTabMenuButton",
    "appLinksFirst",
    "newTabOpens",
    "warnBeforeClosingLastTab",
    "afterClosingTab",
    "tabSwitcherOrder",
    "tabSwitcherView",
    "keepTopAppsRunning",
    "undoReopensClosedTab",
    "warnBeforeMovingTabsToProfile",
    "shareTabsAcrossWindows",
    "tabReorderHaptics",
    "swipeBetweenTabs",
    "extendWebsiteColor",
    "cmdClickCreatesTabGroup",
    "optShiftClickOpensInGroup",
    "peekModifier",
    "peekLinksToOtherSites",
    "newTabLinksOpenIn",
    "popupsOpenAsTabs",
    "peekButtons",
    "splitLinkModifier",
    "autoGroupMeetingTabs",
    "cleanUpInactiveTabsAfterMinutes",
    "suggestCleanUp",
    "mutedSites",
    "showUnreadCounts",
    "showTopAppBadges",
    "showTabHoverMenu",
    "showFullUrlInTabHoverMenu",
    "closedTopAppTiles",
    "topAppFolders",
    "unreadHiddenSites",
    "neverTranslateSites",
    "developerModeSites",
    "autoPictureInPicture",
    "playingNowAcrossProfiles",
    "sidebarMediaControls",
    "commandScrollZoom",
    "blockAutoplayEverywhere",
    "videoUpscaling",
    "sidebarWidth",
    "showSidebarButton",
    "showClearButton",
    "tidyTabs",
    "balancedTopApps",
    "selectedTabGlow",
    "interfaceScale",
    "sidebarTextSize",
    "sidebarTextContrast",
    "selectedTopApp",
    "elementOutlines",
    "interfaceStyle",
    "windowButtons",
    "glassTintWithTheme",
    "glassTintAmount",
    "fadeUnloadedTabs",
    "strikeSleepingTabs",
    "warnBeforeClosingTabGroup",
    "batterySaverWhen",
    "memorySaver",
    "memorySaverMode",
    "busyTabWarnings",
    "loadProfilesWhenOpened",
    "unloadProfilesAfter",
    "keepActiveSites",
    "extensionSidePanelWidth",
    "showFullUrl",
    "showBookmarks",
    "bookmarksBar",
    "bookmarksImportDismissed",
    "appearance",
    "addressBar",
    "compactToolbar",
    "addressBarButtons",
    "borderlessMode",
    "tabCornerRadius",
    "minimalismMode",
    "minimalismPinnedIcons",
    "pageFrame",
    "pageFrameZeroInFullScreen",
    "pageFrameZeroWhenTabsHidden",
    "commandBarPlacement",
    "spacesFollowAppearance",
    "adaptTextToColor",
    "showProfileDots",
    "compactCliPill",
    "shortcuts",
    "mouseShortcuts",
    "openLinksInLittleArdia",
    "littleArdiaOpensNewTabLinks",
    "littleArdiaShortcutFromAnyApp",
    "littleArdiaSize",
    "omniboxProviders",
    "launchActions",
    "commandBarStart",
    "pressMotion",
    "folderStyle",
    "liveFolderIcon",
    "readerTextSize",
    "readerFont",
];

pub type Applied = BTreeMap<String, AppliedStep>;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    pub patch: Vec<(String, Value)>,
    pub applied: Applied,
}

#[derive(Clone, Debug, PartialEq)]
struct Claim {
    value: Value,
    order: i64,
    owner: String,
}

pub fn file_keys(config_dir: &Path) -> BTreeSet<String> {
    std::fs::read_to_string(config_dir.join(CONFIG_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|doc| doc.get("settings").and_then(Value::as_object).cloned())
        .map(|settings| settings.keys().cloned().collect())
        .unwrap_or_default()
}

pub fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same_value(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| same_value(v, w)))
        }
        _ => a == b,
    }
}

pub fn checked(defaults: &Map<String, Value>, settings: &Settings) -> Vec<(String, Value)> {
    let mut probe = settings.clone();
    defaults
        .iter()
        .filter(|(key, _)| CONFIG_SETTING_KEYS.contains(&key.as_str()))
        .filter(|(key, value)| probe.set(key, value).is_ok())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn claims_of(records: &BTreeMap<String, PluginRecord>, except: &str) -> HashMap<String, Claim> {
    let mut claims: HashMap<String, Claim> = HashMap::new();
    for (name, record) in records {
        if name == except || !record.enabled {
            continue;
        }
        for (key, step) in &record.applied {
            if step.order >= claims.get(key).map_or(-1, |c| c.order) {
                claims.insert(
                    key.clone(),
                    Claim {
                        value: step.value.clone(),
                        order: step.order,
                        owner: name.clone(),
                    },
                );
            }
        }
    }
    claims
}

fn next_order(records: &BTreeMap<String, PluginRecord>) -> i64 {
    records
        .values()
        .flat_map(|r| r.applied.values().map(|s| s.order))
        .fold(0, i64::max)
        + 1
}

fn current(settings: &Settings, patch: &[(String, Value)], key: &str) -> Option<Value> {
    patch
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .or_else(|| settings.get(key))
}

fn plan_restore(
    applied: &Applied,
    settings: &Settings,
    claims: &HashMap<String, Claim>,
    file_keys: &BTreeSet<String>,
) -> Vec<(String, Value)> {
    let mut patch = Vec::new();
    for (key, step) in applied {
        let Some(now) = settings.get(key) else {
            continue;
        };
        if file_keys.contains(key) || step.previous.is_null() {
            continue;
        }
        if claims.get(key).map_or(-1, |c| c.order) > step.order {
            continue;
        }
        if same_value(&now, &step.value) {
            patch.push((key.clone(), step.previous.clone()));
        }
    }
    patch
}

fn plan_defaults(
    defaults: &Map<String, Value>,
    settings: &Settings,
    restored: &[(String, Value)],
    file_keys: &BTreeSet<String>,
    claims: &HashMap<String, Claim>,
    order: i64,
) -> Plan {
    let mut plan = Plan::default();
    for (key, value) in checked(defaults, settings) {
        if file_keys.contains(&key) {
            continue;
        }
        let previous = current(settings, restored, &key).unwrap_or(Value::Null);
        let same = same_value(&previous, &value);
        let claim = claims.get(&key);
        if same && claim.is_none() {
            continue;
        }
        if !same {
            plan.patch.push((key.clone(), value.clone()));
        }
        let over = claim
            .filter(|c| same_value(&previous, &c.value))
            .map(|c| c.owner.clone());
        plan.applied.insert(
            key,
            AppliedStep {
                value,
                previous,
                order,
                over,
            },
        );
    }
    plan
}

pub fn plan_enable(
    defaults: &Map<String, Value>,
    records: &BTreeMap<String, PluginRecord>,
    name: &str,
    before: &Applied,
    settings: &Settings,
    file_keys: &BTreeSet<String>,
) -> Plan {
    let claims = claims_of(records, name);
    let restore = plan_restore(before, settings, &claims, file_keys);
    let defaults_plan = plan_defaults(
        defaults,
        settings,
        &restore,
        file_keys,
        &claims,
        next_order(records),
    );
    let mut patch = restore;
    for (key, value) in defaults_plan.patch {
        patch.retain(|(k, _)| *k != key);
        patch.push((key, value));
    }
    Plan {
        patch,
        applied: defaults_plan.applied,
    }
}

pub fn plan_disable(
    records: &BTreeMap<String, PluginRecord>,
    name: &str,
    settings: &Settings,
    file_keys: &BTreeSet<String>,
) -> Vec<(String, Value)> {
    let applied = records
        .get(name)
        .map(|r| r.applied.clone())
        .unwrap_or_default();
    plan_restore(&applied, settings, &claims_of(records, name), file_keys)
}

pub fn splice_applied(records: &mut BTreeMap<String, PluginRecord>, leaving: &str) {
    let gone = records
        .get(leaving)
        .map(|r| r.applied.clone())
        .unwrap_or_default();
    for (key, step) in gone {
        for (name, record) in records.iter_mut() {
            if name == leaving || !record.enabled {
                continue;
            }
            if let Some(mine) = record.applied.get_mut(&key)
                && mine.over.as_deref() == Some(leaving)
            {
                mine.previous = step.previous.clone();
                mine.over = step.over.clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn defaults(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn record(enabled: bool, applied: Applied) -> PluginRecord {
        PluginRecord {
            enabled,
            applied,
            ..PluginRecord::default()
        }
    }

    #[test]
    fn turning_on_applies_valid_defaults_and_turning_off_restores_them() {
        let settings = Settings::default();
        let before_glow = settings.get("tidyTabs").unwrap();
        let wanted = defaults(json!({
            "tidyTabs": !before_glow.as_bool().unwrap_or(false),
            "cliControl": true,
            "notASetting": 1,
            "pageFrame": "nonsense value",
        }));
        let mut records = BTreeMap::new();
        let plan = plan_enable(
            &wanted,
            &records,
            "a",
            &Applied::new(),
            &settings,
            &BTreeSet::new(),
        );
        assert_eq!(plan.patch.len(), 1);
        assert_eq!(plan.patch[0].0, "tidyTabs");
        assert_eq!(plan.applied["tidyTabs"].previous, before_glow);
        records.insert("a".to_owned(), record(true, plan.applied.clone()));
        let mut changed = settings.clone();
        changed.set("tidyTabs", &plan.patch[0].1).expect("valid");
        let undo = plan_disable(&records, "a", &changed, &BTreeSet::new());
        assert_eq!(undo, vec![("tidyTabs".to_owned(), before_glow)]);
        let moved_on = settings;
        assert!(plan_disable(&records, "a", &moved_on, &BTreeSet::new()).is_empty());
    }

    #[test]
    fn the_allowlist_matches_the_old_config_keys() {
        let source = include_str!("../../../../apps/browser/src/state/settings/configAllowlist.ts");
        let start = source.find("CONFIG_SETTING_KEYS").expect("the list");
        let body = &source[start..];
        let body = &body[body.find("= [").expect("open") + 3..body.find("];").expect("close")];
        let old: Vec<&str> = body
            .split(',')
            .map(|item| item.trim().trim_matches('"'))
            .filter(|item| !item.is_empty())
            .collect();
        assert_eq!(old, CONFIG_SETTING_KEYS.to_vec());
    }

    #[test]
    fn keys_the_config_file_sets_are_left_alone() {
        let settings = Settings::default();
        let glow = settings.get("tidyTabs").unwrap();
        let wanted = defaults(json!({ "tidyTabs": !glow.as_bool().unwrap_or(false) }));
        let file: BTreeSet<String> = ["tidyTabs".to_owned()].into();
        let plan = plan_enable(
            &wanted,
            &BTreeMap::new(),
            "a",
            &Applied::new(),
            &settings,
            &file,
        );
        assert!(plan.patch.is_empty() && plan.applied.is_empty());
    }

    #[test]
    fn a_later_plugin_keeps_its_claim_when_an_earlier_one_leaves() {
        let settings = Settings::default();
        let glow = settings.get("tidyTabs").unwrap();
        let flipped = json!(!glow.as_bool().unwrap_or(false));
        let wanted = defaults(json!({ "tidyTabs": flipped }));
        let mut records = BTreeMap::new();
        let first = plan_enable(
            &wanted,
            &records,
            "a",
            &Applied::new(),
            &settings,
            &BTreeSet::new(),
        );
        records.insert("a".to_owned(), record(true, first.applied));
        let mut now = settings;
        now.set("tidyTabs", &flipped).expect("valid");
        let second = plan_enable(
            &wanted,
            &records,
            "b",
            &Applied::new(),
            &now,
            &BTreeSet::new(),
        );
        assert!(second.patch.is_empty());
        assert_eq!(second.applied["tidyTabs"].over.as_deref(), Some("a"));
        records.insert("b".to_owned(), record(true, second.applied));
        assert!(plan_disable(&records, "a", &now, &BTreeSet::new()).is_empty());
        splice_applied(&mut records, "a");
        assert_eq!(records["b"].applied["tidyTabs"].previous, glow);
        assert_eq!(records["b"].applied["tidyTabs"].over, None);
    }
}
