use ardia_state::omnibox::suggest::CommandAction;
use ardia_state::{BrowserState, GroupId, WindowId};
use serde_json::{Map, Value};

use crate::plugins::model::{PluginBarAction, PluginHost};
use crate::plugins::when::{WhenContext, when_holds};
use crate::popovers::context_menu::MenuEntry;
use crate::popovers::tab_menu_extras::{plugin_entries, when_context};

pub const PLUGIN_ACTION_PREFIX: &str = "plugin:";
pub const PAGE_ACTION: &str = ":page";

pub fn action_id(plugin: &str, action: &str) -> String {
    format!("{PLUGIN_ACTION_PREFIX}{plugin}/{action}")
}

pub fn parse_action_id(id: &str) -> Option<(&str, &str)> {
    let (plugin, action) = id.strip_prefix(PLUGIN_ACTION_PREFIX)?.split_once('/')?;
    (!plugin.is_empty() && !action.is_empty()).then_some((plugin, action))
}

pub fn window_when_context(state: &BrowserState, window: &str) -> WhenContext {
    match state.active_tab(window) {
        Some(tab) => when_context(state, window, tab, true),
        None => WhenContext {
            tab_count: state.view_tabs(window, None).len(),
            ..WhenContext::default()
        },
    }
}

pub fn group_context(
    state: &BrowserState,
    window: &str,
    group: &GroupId,
) -> Option<(WhenContext, Map<String, Value>)> {
    let g = state.group(group.as_str())?;
    let active = state.active_tab(window);
    let front = active
        .filter(|tab| g.tab_ids.contains(&tab.id))
        .or_else(|| g.tab_ids.first().and_then(|id| state.tab(id.as_str())));
    let base = front
        .map(|tab| when_context(state, window, tab, false))
        .unwrap_or_default();
    let when = WhenContext {
        url_host: base.url_host,
        url_scheme: base.url_scheme,
        is_pinned: g.pinned,
        is_in_group: true,
        is_split: false,
        is_active: active
            .and_then(|tab| state.group_of(tab.id.as_str()))
            .is_some_and(|shown| shown.id == g.id),
        tab_count: g.tab_ids.len(),
    };
    let mut data = Map::new();
    data.insert("groupId".into(), Value::String(group.to_string()));
    data.insert("title".into(), Value::String(g.name.clone()));
    data.insert("windowId".into(), Value::String(window.to_owned()));
    data.insert("tabCount".into(), Value::from(g.tab_ids.len()));
    Some((when, data))
}

pub fn group_menu_entries(
    plugins: &dyn PluginHost,
    state: &BrowserState,
    window: &str,
    group: &GroupId,
) -> Vec<MenuEntry> {
    let Some(g) = state.group(group.as_str()) else {
        return Vec::new();
    };
    if g.profile_id.is_incognito() {
        return Vec::new();
    }
    let Some((when, data)) = group_context(state, window, group) else {
        return Vec::new();
    };
    plugin_entries("group", &plugins.menu_entries("group"), &when, &data)
}

pub fn shown_actions(entries: &[PluginBarAction], when: &WhenContext) -> Vec<CommandAction> {
    entries
        .iter()
        .filter(|entry| when_holds(entry.when.as_deref(), when))
        .map(|entry| CommandAction {
            id: action_id(&entry.plugin, &entry.action),
            title: entry.title.clone(),
            keywords: entry.keywords.clone(),
            hint: None,
        })
        .collect()
}

pub fn bar_actions(
    plugins: &dyn PluginHost,
    state: &BrowserState,
    window: &WindowId,
) -> Vec<CommandAction> {
    if !plugins.window_eligible(window) {
        return Vec::new();
    }
    shown_actions(
        &plugins.bar_actions(),
        &window_when_context(state, window.as_str()),
    )
}

pub fn run_action(
    plugins: &dyn PluginHost,
    state: &BrowserState,
    window: &WindowId,
    id: &str,
) -> bool {
    let Some((plugin, action)) = parse_action_id(id) else {
        return false;
    };
    if !plugins.window_eligible(window) {
        return false;
    }
    let entries = plugins.bar_actions();
    let Some(entry) = entries
        .iter()
        .find(|e| e.plugin == plugin && e.action == action)
    else {
        return false;
    };
    if !when_holds(
        entry.when.as_deref(),
        &window_when_context(state, window.as_str()),
    ) {
        return false;
    }
    if action == PAGE_ACTION {
        plugins.open_plugin_page(window, plugin);
        true
    } else {
        plugins.run_command(window, plugin, action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(action: &str, when: Option<&str>) -> PluginBarAction {
        PluginBarAction {
            plugin: "demo".into(),
            action: action.into(),
            title: format!("Run {action}"),
            icon: None,
            keywords: vec!["Demo".into()],
            when: when.map(str::to_owned),
        }
    }

    #[test]
    fn ids_round_trip_and_hostile_ids_are_refused() {
        assert_eq!(action_id("demo", PAGE_ACTION), "plugin:demo/:page");
        assert_eq!(
            parse_action_id("plugin:demo/:page"),
            Some(("demo", ":page"))
        );
        assert_eq!(
            parse_action_id("plugin:demo/hello"),
            Some(("demo", "hello"))
        );
        assert_eq!(parse_action_id("plugin:demo"), None);
        assert_eq!(parse_action_id("plugin:/x"), None);
        assert_eq!(parse_action_id("plugin:demo/"), None);
        assert_eq!(parse_action_id("newTab"), None);
    }

    #[test]
    fn commands_whose_when_fails_are_hidden() {
        let when = WhenContext {
            url_host: "github.com".into(),
            is_active: true,
            ..WhenContext::default()
        };
        let shown = shown_actions(
            &[
                entry(PAGE_ACTION, None),
                entry("gh", Some("urlHost == 'github.com'")),
                entry("gl", Some("urlHost == 'gitlab.com'")),
            ],
            &when,
        );
        let ids: Vec<&str> = shown.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["plugin:demo/:page", "plugin:demo/gh"]);
        assert_eq!(shown[1].keywords, vec!["Demo".to_owned()]);
    }
}
