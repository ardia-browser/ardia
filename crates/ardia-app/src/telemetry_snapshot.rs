use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use ardia_state::BrowserState;
use ardia_state::Topics;
use ardia_state::air_traffic::{AirTrafficConfig, LinkCondition, is_wildcard_pattern};
use ardia_state::settings::{NewTabOpens, SETTINGS, Settings};
use ardia_state::store::{BrowserStore, Interest, Subscription};
use ardia_state::windows::WindowKind;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

pub const SETTINGS_SNAPSHOT_EVENT: &str = "settings_snapshot";
pub const FIRST_SETTINGS_SNAPSHOT: Duration = Duration::from_secs(2 * 60);
const SETTINGS_DAY: &str = "settingsDay";
const FREE_TEXT_SETTINGS: [&str; 4] = [
    "searchEngine",
    "customSearchUrl",
    "newTabUrl",
    "defaultProfileId",
];
const DEFAULT_COMMAND_BAR_TABS: u64 = 8;
const FORMER_MIN_WINDOW_WIDTH: f64 = 720.0;
const MAC_FUNCTION_KEYS: std::ops::RangeInclusive<u32> = 0xf700..=0xf8ff;
const LAYOUT_CODES_OF_ARROWS: [&str; 4] = ["\u{1c}", "\u{1d}", "\u{1e}", "\u{1f}"];
const MOUSE_KEYS: [&str; 3] = ["mouse:middle", "mouse:4", "mouse:5"];

static LATEST: Mutex<Option<Arc<BrowserState>>> = Mutex::new(None);

pub fn start(store: &BrowserStore, _data_dir: &Path) -> Vec<Subscription> {
    ardia_ui::press_telemetry::start();
    *LATEST.lock() = Some(store.snapshot());
    let watch = store.subscribe(
        Interest::Topics(
            Topics::SETTINGS | Topics::PROFILES | Topics::WINDOWS | Topics::AIR_TRAFFIC,
        ),
        |update| *LATEST.lock() = Some(Arc::clone(&update.state)),
    );
    if let Some(client) = ardia_telemetry::client() {
        client.every(FIRST_SETTINGS_SNAPSHOT, None, snapshot_settings);
    }
    vec![watch]
}

pub fn hourly() {
    snapshot_settings();
    ardia_ui::press_telemetry::emit_tab_presses();
}

pub fn session_ending() {
    ardia_ui::press_telemetry::emit_tab_presses();
}

pub fn utc_day(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

pub fn snapshot_settings() {
    let consent = ardia_telemetry::consent_now();
    let Some(client) = ardia_telemetry::client() else {
        return;
    };
    let today = utc_day(ardia_telemetry::ids::now_ms());
    if client.saved_text(SETTINGS_DAY).as_deref() == Some(today.as_str()) {
        return;
    }
    let Some(state) = LATEST.lock().clone() else {
        return;
    };
    let mut props = snapshot_props(&state);
    for (key, value) in app_icon_setting(crate::app_icon_choice::current()) {
        props.insert(key, value);
    }
    ardia_telemetry::capture_for(SETTINGS_SNAPSHOT_EVENT, props, consent.as_ref());
    if ardia_telemetry::still_valid(consent.as_ref()) {
        client.save_fields(Map::from_iter([(SETTINGS_DAY.to_owned(), json!(today))]));
    }
}

fn encode(value: &Value) -> Option<String> {
    match value {
        Value::Null => Some("null".into()),
        Value::Bool(on) => Some(on.to_string()),
        Value::Number(n) => n
            .as_f64()
            .filter(|f| f.is_finite())
            .map(|f| number_text((f * 1000.0).round() / 1000.0)),
        _ => None,
    }
}

fn number_text(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

fn measured(key: &str, value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !FREE_TEXT_SETTINGS.contains(&key) => Some(text.clone()),
        Value::String(_) => None,
        other => encode(other),
    }
}

fn flag(on: bool) -> Value {
    json!(if on { "true" } else { "false" })
}

pub fn settings_props(settings: &Settings) -> Map<String, Value> {
    let defaults = Settings::default();
    let mut out = Map::new();
    for info in SETTINGS {
        let (Some(value), Some(fallback)) = (settings.get(info.key), defaults.get(info.key)) else {
            continue;
        };
        let (Some(value), Some(fallback)) =
            (measured(info.key, &value), measured(info.key, &fallback))
        else {
            continue;
        };
        out.insert(format!("setting_{}", info.key), json!(value));
        out.insert(format!("default_{}", info.key), json!(fallback));
    }
    for (key, value) in command_bar_start_flags(&settings.command_bar_start) {
        out.insert(key, value);
    }
    for (key, value) in custom_shortcut_counts(settings) {
        out.insert(key, value);
    }
    let mouse = settings
        .mouse_shortcuts
        .values()
        .filter(|stored| {
            stored
                .first()
                .is_some_and(|key| MOUSE_KEYS.contains(&key.as_str()))
        })
        .count();
    out.insert("custom_mouse_shortcuts".into(), json!(mouse.to_string()));
    out.insert(
        "setting_interfaceScale".into(),
        json!(((settings.interface_scale * 100.0).round() as i64).to_string()),
    );
    out.insert("default_interfaceScale".into(), json!("100"));
    out.insert(
        "unread_hidden_sites".into(),
        json!(settings.unread_hidden_sites.len().to_string()),
    );
    out.insert(
        "custom_new_tab_url".into(),
        flag(custom_new_tab_url(settings)),
    );
    out
}

fn command_bar_start_flags(start: &Value) -> Map<String, Value> {
    let tabs = start.get("openTabs");
    let on = |key: &str| tabs.and_then(|t| t.get(key)).and_then(Value::as_bool) == Some(true);
    let limit = tabs
        .and_then(|t| t.get("limit"))
        .and_then(Value::as_u64)
        .filter(|n| *n <= ardia_state::settings::COMMAND_BAR_START_MAX_TABS)
        .unwrap_or(DEFAULT_COMMAND_BAR_TABS);
    Map::from_iter([
        (
            "setting_commandBarStart_hidePinned".to_owned(),
            flag(on("hidePinned")),
        ),
        ("default_commandBarStart_hidePinned".to_owned(), flag(false)),
        (
            "setting_commandBarStart_hideTopApps".to_owned(),
            flag(on("hideTopApps")),
        ),
        (
            "default_commandBarStart_hideTopApps".to_owned(),
            flag(false),
        ),
        (
            "setting_commandBarStart_limit".to_owned(),
            json!(limit.to_string()),
        ),
        (
            "default_commandBarStart_limit".to_owned(),
            json!(DEFAULT_COMMAND_BAR_TABS.to_string()),
        ),
    ])
}

fn navigation_or_function_key(stored: &[String]) -> bool {
    let Some(key) = stored.first() else {
        return false;
    };
    if LAYOUT_CODES_OF_ARROWS.contains(&key.as_str()) && stored.iter().any(|m| m == "function") {
        return true;
    }
    let mut chars = key.chars();
    matches!((chars.next(), chars.next()), (Some(c), None) if MAC_FUNCTION_KEYS.contains(&(c as u32)))
}

fn custom_shortcut_counts(settings: &Settings) -> Map<String, Value> {
    let set: Vec<&Vec<String>> = settings
        .shortcuts
        .values()
        .filter(|stored| stored.first().is_some_and(|key| !key.is_empty()))
        .collect();
    let navigation = set
        .iter()
        .filter(|stored| navigation_or_function_key(stored))
        .count();
    let option_only = set
        .iter()
        .filter(|stored| {
            let mods = &stored[1..];
            mods.iter().any(|m| m == "option")
                && !mods.iter().any(|m| m == "command" || m == "control")
        })
        .count();
    Map::from_iter([
        ("custom_shortcuts".to_owned(), json!(set.len().to_string())),
        (
            "custom_shortcuts_navigation_keys".to_owned(),
            json!(navigation.to_string()),
        ),
        (
            "custom_shortcuts_option_only".to_owned(),
            json!(option_only.to_string()),
        ),
    ])
}

fn custom_new_tab_url(settings: &Settings) -> bool {
    if settings.new_tab_opens != NewTabOpens::Page {
        return false;
    }
    let url = settings.new_tab_url.trim();
    if url.eq_ignore_ascii_case("about:blank") {
        return true;
    }
    let lower = url.to_ascii_lowercase();
    if let Some(rest) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    {
        return rest
            .chars()
            .next()
            .is_some_and(|c| !matches!(c, '/' | '?' | '#'));
    }
    !url.is_empty()
        && !url.contains(char::is_whitespace)
        && !url.contains("://")
        && url.contains('.')
}

pub fn ctrl_tab_mode(settings: &Settings) -> &'static str {
    let rebound = settings
        .shortcuts
        .keys()
        .any(|command| command == "tabSwitcher:forward" || command == "tabSwitcher:backward");
    let taken = settings.shortcuts.iter().any(|(command, stored)| {
        !command.starts_with("tabSwitcher:")
            && stored.first().is_some_and(|key| key == "\t")
            && stored.iter().any(|m| m == "control")
    });
    if rebound || taken {
        "custom"
    } else {
        "switcher"
    }
}

pub fn profile_props(state: &BrowserState) -> Map<String, Value> {
    let profiles: Vec<_> = state.profiles.values().collect();
    let mut out = Map::new();
    out.insert(
        "custom_color_profiles".into(),
        json!(
            profiles
                .iter()
                .filter(|p| p.theme.is_some())
                .count()
                .to_string()
        ),
    );
    out.insert(
        "edited_presets".into(),
        json!(
            profiles
                .iter()
                .map(|p| p.preset_themes.as_ref().map_or(0, |presets| presets.len()))
                .sum::<usize>()
                .to_string()
        ),
    );
    if let Some(main) = state
        .profiles
        .iter()
        .find(|(id, _)| id.as_str() == state.settings.default_profile_id)
        .map(|(_, p)| p)
    {
        out.insert(
            "default_profile_color_edited".into(),
            flag(main.theme.is_some()),
        );
    }
    out.insert(
        "sync_open_tabs_profiles".into(),
        json!(profiles.iter().filter(|p| p.sync_tabs).count().to_string()),
    );
    out
}

pub fn window_props(state: &BrowserState) -> Map<String, Value> {
    let scale = state.settings.interface_scale.max(0.01);
    let sidebar = state.settings.sidebar_width;
    let widths: Vec<f64> = state
        .windows
        .values()
        .filter(|w| w.kind != WindowKind::LittleArdia && !w.is_full_screen())
        .filter_map(|w| w.frame.map(|frame| frame.width / scale))
        .collect();
    let narrow = widths
        .iter()
        .filter(|w| **w < FORMER_MIN_WINDOW_WIDTH)
        .count();
    let narrowed = widths
        .iter()
        .filter(|w| {
            f64::from(ardia_theme::layout::shown_sidebar_width(
                sidebar as f32,
                Some(**w as f32),
            )) < sidebar
        })
        .count();
    Map::from_iter([
        ("narrow_windows".to_owned(), json!(narrow.to_string())),
        (
            "sidebar_narrowed_windows".to_owned(),
            json!(narrowed.to_string()),
        ),
    ])
}

pub fn air_traffic_props(config: &AirTrafficConfig) -> Map<String, Value> {
    let enabled: Vec<_> = config.rules.iter().filter(|r| r.enabled).collect();
    let wildcard = enabled
        .iter()
        .filter(|r| matches!(&r.when, LinkCondition::Pattern(p) if is_wildcard_pattern(p)))
        .count();
    Map::from_iter([
        (
            "air_traffic_rules".to_owned(),
            json!(enabled.len().to_string()),
        ),
        (
            "air_traffic_wildcard_rules".to_owned(),
            json!(wildcard.to_string()),
        ),
        (
            "air_traffic_fallback".to_owned(),
            flag(config.fallback.is_some()),
        ),
    ])
}

pub fn app_icon_setting(icon: &str) -> Map<String, Value> {
    let name = icon.strip_suffix("-flat").unwrap_or(icon);
    let valid = (1..=16).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase());
    if !valid {
        return Map::new();
    }
    Map::from_iter([
        ("setting_app_icon".to_owned(), json!(icon)),
        ("default_app_icon".to_owned(), json!("default")),
    ])
}

pub fn snapshot_props(state: &BrowserState) -> Map<String, Value> {
    let mut props = settings_props(&state.settings);
    for part in [
        profile_props(state),
        window_props(state),
        air_traffic_props(&state.air_traffic),
    ] {
        for (key, value) in part {
            props.insert(key, value);
        }
    }
    props.insert(
        "ctrl_tab_mode".into(),
        json!(ctrl_tab_mode(&state.settings)),
    );
    props
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_days_match_the_iso_date() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(1_764_115_200_000), "2025-11-26");
        assert_eq!(utc_day(951_782_400_000), "2000-02-29");
    }

    #[test]
    fn default_settings_send_enums_flags_and_numbers_but_no_free_text() {
        let props = settings_props(&Settings::default());
        assert_eq!(props["setting_tabLayout"], "sidebar");
        assert_eq!(props["default_tabLayout"], "sidebar");
        assert_eq!(props["setting_warnBeforeQuitting"], "false");
        assert_eq!(props["setting_glassTintAmount"], "0.8");
        assert_eq!(props["setting_pageFrame"], props["default_pageFrame"]);
        assert_eq!(props["setting_tabCornerRadius"], "null");
        assert_eq!(props["setting_unloadProfilesAfter"], "never");
        assert_eq!(props["setting_interfaceScale"], "100");
        assert_eq!(props["setting_commandBarStart_limit"], "8");
        assert_eq!(props["custom_shortcuts"], "0");
        assert_eq!(props["custom_new_tab_url"], "false");
        for key in [
            "searchEngine",
            "customSearchUrl",
            "newTabUrl",
            "defaultProfileId",
            "mutedSites",
            "shortcuts",
            "littleArdiaSize",
        ] {
            assert!(!props.contains_key(&format!("setting_{key}")), "{key}");
        }
        assert!(props.values().all(Value::is_string));
    }

    #[test]
    fn changed_settings_are_reported_against_their_defaults() {
        let mut settings = Settings {
            tab_layout: ardia_state::model::TabLayout::Top,
            interface_scale: 1.25,
            clean_up_inactive_tabs_after_minutes: Some(720.0),
            new_tab_url: "example.com".into(),
            unread_hidden_sites: vec!["a".into(), "b".into()],
            ..Settings::default()
        };
        settings
            .shortcuts
            .insert("reload".into(), vec!["r".into(), "option".into()]);
        settings
            .shortcuts
            .insert("back".into(), vec!["\u{f702}".into(), "command".into()]);
        settings
            .mouse_shortcuts
            .insert("back".into(), vec!["mouse:4".into()]);
        settings.command_bar_start = json!({"openTabs": {"hidePinned": true, "limit": 3}});
        let props = settings_props(&settings);
        assert_eq!(props["setting_tabLayout"], "top");
        assert_eq!(props["setting_interfaceScale"], "125");
        assert_eq!(props["setting_cleanUpInactiveTabsAfterMinutes"], "720");
        assert_eq!(props["default_cleanUpInactiveTabsAfterMinutes"], "null");
        assert_eq!(props["custom_new_tab_url"], "true");
        assert_eq!(props["unread_hidden_sites"], "2");
        assert_eq!(props["custom_shortcuts"], "2");
        assert_eq!(props["custom_shortcuts_navigation_keys"], "1");
        assert_eq!(props["custom_shortcuts_option_only"], "1");
        assert_eq!(props["custom_mouse_shortcuts"], "1");
        assert_eq!(props["setting_commandBarStart_hidePinned"], "true");
        assert_eq!(props["setting_commandBarStart_limit"], "3");
        assert_eq!(ctrl_tab_mode(&settings), "switcher");
        settings
            .shortcuts
            .insert("nextTab".into(), vec!["\t".into(), "control".into()]);
        assert_eq!(ctrl_tab_mode(&settings), "custom");
    }

    #[test]
    fn the_app_icon_is_named_only_when_it_is_a_plain_variant_id() {
        assert_eq!(app_icon_setting("default")["setting_app_icon"], "default");
        assert_eq!(
            app_icon_setting("glass-flat")["default_app_icon"],
            "default"
        );
        assert!(app_icon_setting("Not Valid").is_empty());
    }

    #[test]
    fn the_whole_snapshot_carries_the_window_profile_and_routing_parts() {
        let state = BrowserState::default();
        let props = snapshot_props(&state);
        assert_eq!(props["narrow_windows"], "0");
        assert_eq!(props["air_traffic_rules"], "0");
        assert_eq!(props["air_traffic_fallback"], "false");
        assert_eq!(props["ctrl_tab_mode"], "switcher");
        assert!(props.contains_key("sync_open_tabs_profiles"));
    }
}
