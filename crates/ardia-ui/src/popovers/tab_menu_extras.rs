use ardia_state::live::{CalendarPatch, CalendarSettings, LiveCommand};
use ardia_state::settings::{Settings, SettingsPatch};
use ardia_state::tabs::Tab;
use ardia_state::{Action, BrowserState};
use gpui::{Hsla, Rgba};
use serde_json::{Map, Value};

use crate::live::{CalendarCommand, CalendarView, DismissedNow, SystemCalendar, now_badge_event};
use crate::msg::Msg;
use crate::plugins::model::PluginMenuEntry;
use crate::plugins::when::{WhenContext, when_holds};
use crate::popovers::context_menu::{MenuEntry, MenuItem};
use crate::settings::automations::calendar::ALERT_LEADS;
use crate::settings::rows::Pane;

pub const PLUGIN_SUBMENU_AFTER: usize = 2;
pub const ALL_UNREAD_TITLE: &str = "Show Unread Counts";
pub const DISMISS_NOW: &str = "cal:dismissNow:";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TabExtras {
    pub pip_open: bool,
    pub page_unread: bool,
    pub calendar: Vec<MenuEntry>,
    pub plugins: Vec<MenuEntry>,
}

pub fn pip_entries(tab: &Tab, open: bool) -> Vec<MenuEntry> {
    if !open {
        return Vec::new();
    }
    vec![
        MenuItem::new("exitPip", "Exit Picture in Picture")
            .symbol("pip.exit")
            .msg(Msg::ExitPip(tab.id.clone()))
            .entry(),
    ]
}

fn site_host(url: &str) -> String {
    ardia_state::omnibox::url::host_of(url)
}

pub fn can_choose_site_unread(tab: &Tab) -> bool {
    !tab.url.is_empty() && !site_host(&tab.url).is_empty() && !tab.profile_id.is_incognito()
}

pub fn unread_site_hidden(settings: &Settings, url: &str) -> bool {
    let host = site_host(url);
    !url.is_empty() && !host.is_empty() && settings.unread_hidden_sites.contains(&host)
}

pub fn unread_site_title(hidden: bool) -> &'static str {
    if hidden {
        "Show Unread Count"
    } else {
        "Hide Unread Count"
    }
}

pub fn unread_entries(state: &BrowserState, tab: &Tab, page_unread: bool) -> Vec<MenuEntry> {
    let settings = &state.settings;
    if !can_choose_site_unread(tab) {
        return Vec::new();
    }
    if tab.pin.as_ref().is_some_and(|pin| pin.is_tile()) && !settings.show_top_app_badges {
        return Vec::new();
    }
    if !settings.show_unread_counts {
        if !page_unread {
            return Vec::new();
        }
        return vec![
            MenuItem::new("allUnread", ALL_UNREAD_TITLE)
                .symbol("app.badge")
                .msg(Msg::Store(Action::UpdateSettings {
                    patch: SettingsPatch::new().set("showUnreadCounts", true),
                    from_sync: false,
                }))
                .entry(),
        ];
    }
    let hidden = unread_site_hidden(settings, &tab.url);
    if !hidden && !page_unread {
        return Vec::new();
    }
    let host = site_host(&tab.url);
    let sites: Vec<String> = if hidden {
        settings
            .unread_hidden_sites
            .iter()
            .filter(|site| **site != host)
            .cloned()
            .collect()
    } else {
        settings
            .unread_hidden_sites
            .iter()
            .cloned()
            .chain(std::iter::once(host))
            .collect()
    };
    vec![
        MenuItem::new("siteUnread", unread_site_title(hidden))
            .symbol("app.badge")
            .msg(Msg::Store(Action::UpdateSettings {
                patch: SettingsPatch::new().set("unreadHiddenSites", sites),
                from_sync: false,
            }))
            .entry(),
    ]
}

fn hex(color: &str) -> Option<Hsla> {
    let digits = color.trim_start_matches('#');
    let value = u32::from_str_radix(digits.get(..6)?, 16).ok()?;
    Some(
        Rgba {
            r: ((value >> 16) & 0xff) as f32 / 255.0,
            g: ((value >> 8) & 0xff) as f32 / 255.0,
            b: (value & 0xff) as f32 / 255.0,
            a: 1.0,
        }
        .into(),
    )
}

fn patch(update: CalendarPatch) -> Msg {
    Msg::Live(LiveCommand::UpdateCalendar { patch: update })
}

pub fn is_calendar_tab(tab: &Tab) -> bool {
    tab.pin.is_some() && crate::live::is_calendar_url(tab.pinned_url.as_deref().unwrap_or(&tab.url))
}

pub fn dismiss_now_entries(
    settings: &CalendarSettings,
    calendar: &CalendarView,
    dismissed: &DismissedNow,
    now: i64,
) -> Vec<MenuEntry> {
    if !settings.show_time_to_next {
        return Vec::new();
    }
    let Some(event) = now_badge_event(&calendar.events, now, dismissed) else {
        return Vec::new();
    };
    let title = if event.title.is_empty() {
        "This Meeting"
    } else {
        event.title.as_str()
    };
    vec![
        MenuItem::new(
            format!("{DISMISS_NOW}{}", event.occurrence),
            format!("Hide \u{201C}Now\u{201D} for {title}"),
        )
        .symbol("eye.slash")
        .msg(Msg::Live(LiveCommand::DismissNowBadge {
            occurrence: event.occurrence.clone(),
            end: event.end,
        }))
        .entry(),
    ]
}

fn calendar_items(list: &[&SystemCalendar], hidden: &[String]) -> Vec<MenuEntry> {
    list.iter()
        .map(|c| {
            let shown = !hidden.contains(&c.id);
            MenuItem::new(format!("cal:toggle:{}", c.id), c.title.clone())
                .swatch(hex(&c.color))
                .checked(shown)
                .msg(Msg::Calendar(CalendarCommand::SetHidden {
                    calendar: c.id.clone(),
                    hidden: shown,
                }))
                .entry()
        })
        .collect()
}

pub fn calendar_menu(settings: &CalendarSettings, calendar: &CalendarView) -> MenuEntry {
    let owned: Vec<&SystemCalendar> = calendar.calendars.iter().filter(|c| c.owned).collect();
    let others: Vec<&SystemCalendar> = calendar.calendars.iter().filter(|c| !c.owned).collect();
    let hidden = &settings.hidden_calendar_ids;
    let mut children = Vec::new();
    if !calendar.access.connected() {
        children.push(
            MenuItem::new("cal:connect", "Connect Calendar…")
                .symbol("calendar.badge.plus")
                .msg(Msg::Calendar(CalendarCommand::Connect))
                .entry(),
        );
        children.push(MenuEntry::Separator);
    }
    children.push(MenuEntry::submenu(
        "cal:alerts",
        "Show Next Meeting Alert",
        None,
        ALERT_LEADS
            .iter()
            .map(|(value, title)| {
                MenuItem::new(format!("cal:lead:{value}"), *title)
                    .checked(settings.alert_lead == *value)
                    .msg(patch(CalendarPatch {
                        alert_lead: Some((*value).to_owned()),
                        ..CalendarPatch::default()
                    }))
                    .entry()
            })
            .collect(),
    ));
    children.push(
        MenuItem::new("cal:preview", "Show Calendar Preview")
            .checked(settings.show_preview)
            .msg(patch(CalendarPatch {
                show_preview: Some(!settings.show_preview),
                ..CalendarPatch::default()
            }))
            .entry(),
    );
    children.push(
        MenuItem::new("cal:badge", "Show Time to Next Meeting")
            .checked(settings.show_time_to_next)
            .msg(patch(CalendarPatch {
                show_time_to_next: Some(!settings.show_time_to_next),
                ..CalendarPatch::default()
            }))
            .entry(),
    );
    let mut active = Vec::new();
    if !owned.is_empty() {
        active.push(
            MenuItem::new("cal:h1", "My Calendars")
                .enabled(false)
                .entry(),
        );
        active.extend(calendar_items(&owned, hidden));
    }
    if !others.is_empty() {
        active.push(MenuEntry::Separator);
        active.push(
            MenuItem::new("cal:h2", "Other Calendars")
                .enabled(false)
                .entry(),
        );
        active.extend(calendar_items(&others, hidden));
    }
    children.push(
        MenuEntry::submenu("cal:active", "Active Calendars", None, active)
            .enabled(!calendar.calendars.is_empty()),
    );
    children.push(MenuEntry::Separator);
    children.push(
        MenuItem::new("cal:settings", "Calendar Settings…")
            .symbol("gearshape")
            .msg(Msg::SettingsAt(Pane::Automations))
            .entry(),
    );
    MenuEntry::submenu("cal", "Calendar", None, children).symbol("calendar")
}

pub fn calendar_entries(
    tab: &Tab,
    settings: &CalendarSettings,
    calendar: &CalendarView,
    dismissed: &DismissedNow,
    now: i64,
) -> Vec<MenuEntry> {
    if !is_calendar_tab(tab) {
        return Vec::new();
    }
    let mut out = if tab.pin.as_ref().is_some_and(|pin| pin.is_tile()) {
        dismiss_now_entries(settings, calendar, dismissed, now)
    } else {
        Vec::new()
    };
    out.push(calendar_menu(settings, calendar));
    out
}

pub fn when_context(state: &BrowserState, window: &str, tab: &Tab, active: bool) -> WhenContext {
    let scheme = ardia_state::omnibox::url::scheme_of(&tab.url)
        .map(|s| s.trim_end_matches(':').to_ascii_lowercase())
        .unwrap_or_default();
    WhenContext {
        url_host: site_host(&tab.url),
        url_scheme: scheme,
        is_pinned: tab.pin.is_some(),
        is_in_group: state.group_of(tab.id.as_str()).is_some(),
        is_split: state.split_of(tab.id.as_str()).is_some(),
        is_active: active,
        tab_count: state.view_tabs(window, None).len(),
    }
}

pub fn plugin_entries(
    slot: &str,
    entries: &[PluginMenuEntry],
    when: &WhenContext,
    data: &Map<String, Value>,
) -> Vec<MenuEntry> {
    let mut out = Vec::new();
    let mut plugins: Vec<&str> = Vec::new();
    for entry in entries {
        if !plugins.contains(&entry.plugin.as_str()) {
            plugins.push(&entry.plugin);
        }
    }
    for plugin in plugins {
        let mine: Vec<&PluginMenuEntry> = entries.iter().filter(|e| e.plugin == plugin).collect();
        let items: Vec<MenuEntry> = mine
            .iter()
            .filter(|e| {
                when_holds(e.when.as_deref(), when) && when_holds(e.command_when.as_deref(), when)
            })
            .map(|e| {
                let mut item = MenuItem::new(
                    format!("plugin-menu:{slot}/{}/{}", e.plugin, e.command),
                    e.title.clone(),
                )
                .msg(Msg::PluginMenu {
                    plugin: e.plugin.clone(),
                    command: e.command.clone(),
                    context: menu_context(slot, data),
                });
                if let Some(icon) = e.icon.as_deref().filter(|i| !i.is_empty()) {
                    item.symbol = Some(icon.to_owned().into());
                }
                item.entry()
            })
            .collect();
        if items.len() > PLUGIN_SUBMENU_AFTER {
            let first = mine[0];
            let mut sub = MenuEntry::submenu(
                format!("plugin-menu:{slot}/{plugin}"),
                first.plugin_title.clone(),
                None,
                items,
            );
            if let MenuEntry::Submenu(s) = &mut sub {
                s.symbol = Some(
                    first
                        .plugin_icon
                        .clone()
                        .filter(|i| !i.is_empty())
                        .unwrap_or_else(|| "puzzlepiece".to_owned())
                        .into(),
                );
            }
            out.push(sub);
        } else {
            out.extend(items);
        }
    }
    out
}

fn menu_context(slot: &str, data: &Map<String, Value>) -> Map<String, Value> {
    let mut context = Map::new();
    context.insert("from".into(), Value::String("menu".into()));
    context.insert("slot".into(), Value::String(slot.to_owned()));
    for (key, value) in data {
        context.insert(key.clone(), value.clone());
    }
    context
}

pub fn tab_context_data(window: &str, tab: &Tab) -> Map<String, Value> {
    let mut data = Map::new();
    data.insert("url".into(), Value::String(tab.url.clone()));
    data.insert("title".into(), Value::String(tab.display_title()));
    data.insert("tabId".into(), Value::String(tab.id.to_string()));
    data.insert("windowId".into(), Value::String(window.to_owned()));
    data
}
