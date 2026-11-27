use std::collections::{BTreeMap, HashMap};

use ardia_state::actions::{Action, GroupPatch};
use ardia_state::model::TabPin;
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, GroupId, NewTab, TabId, WindowId};
use serde_json::{Map, Value, json};

use super::records::switch_origin;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Redaction {
    pub urls: bool,
    pub full: bool,
}

const MAX_TITLE: usize = 500;
pub const MAX_INTENT_TABS: usize = 100;
const SECRET_NAMES: [&str; 12] = [
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "key",
    "auth",
    "session",
    "sig",
    "code",
    "credential",
    "signature",
];

fn control(c: char) -> bool {
    matches!(c,
        '\u{0000}'..='\u{001f}'
        | '\u{007f}'..='\u{009f}'
        | '\u{200b}'..='\u{200f}'
        | '\u{2028}'..='\u{202e}'
        | '\u{2066}'..='\u{2069}'
        | '\u{feff}')
}

pub fn clean_text(text: &str, max: usize) -> String {
    text.chars().filter(|c| !control(*c)).take(max).collect()
}

fn decoded(raw: &str) -> Option<String> {
    let mut name = raw.replace('+', " ");
    for _ in 0..4 {
        let next = url::form_urlencoded::parse(format!("x={name}").as_bytes())
            .next()
            .map(|(_, v)| v.into_owned())?;
        if next == name {
            return Some(name);
        }
        name = next;
    }
    None
}

pub fn has_secret_param(query: &str) -> bool {
    query
        .trim_start_matches('?')
        .split(['&', ';'])
        .filter(|p| !p.is_empty())
        .any(|pair| {
            let (name, value) = pair
                .split_once('=')
                .map_or((pair, None), |(n, v)| (n, Some(v)));
            match decoded(name) {
                None => true,
                Some(name) => {
                    let lower = name.to_lowercase();
                    SECRET_NAMES.iter().any(|s| lower.contains(s))
                        || value.is_some_and(|v| decoded(v).is_none())
                }
            }
        })
}

pub fn minimized_url(url: &str) -> String {
    url.split(['?', '#']).next().unwrap_or_default().to_owned()
}

pub fn state_url(url: &str, r: Redaction) -> Option<String> {
    if !r.urls || url.len() > 8192 || url.chars().any(control) {
        return None;
    }
    switch_origin(url)?;
    let authority = url.split_once("://")?.1.split(['/', '?', '#']).next()?;
    if authority.contains('@') {
        return None;
    }
    if !r.full {
        return Some(minimized_url(url));
    }
    let fragmentless = url.split('#').next().unwrap_or_default();
    let query = fragmentless.split_once('?').map_or("", |(_, q)| q);
    Some(if has_secret_param(query) {
        minimized_url(url)
    } else {
        fragmentless.to_owned()
    })
}

pub fn eligible_window(state: &BrowserState, window: &str) -> Option<&'static str> {
    let w = state.window(window)?;
    if w.profile_id.is_incognito() {
        return None;
    }
    match w.kind {
        WindowKind::Main => Some("normal"),
        WindowKind::LittleArdia => Some("little"),
        _ => None,
    }
}

pub fn eligible_tab(state: &BrowserState, tab: &str) -> bool {
    state.tab(tab).is_some_and(|t| {
        eligible_window(state, t.window_id.as_str()).is_some() && !t.profile_id.is_incognito()
    })
}

fn eligible_tab_ids(state: &BrowserState, window: &WindowId) -> Vec<TabId> {
    state
        .window(window.as_str())
        .map(|w| {
            w.tab_ids
                .iter()
                .filter(|id| {
                    state
                        .tab(id.as_str())
                        .is_some_and(|t| &t.window_id == window)
                        && eligible_tab(state, id.as_str())
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn eligible_group(state: &BrowserState, group: &GroupId) -> bool {
    state.groups.get(group).is_some_and(|g| {
        eligible_window(state, g.window_id.as_str()).is_some() && !g.profile_id.is_incognito()
    })
}

pub fn tabs_rows(state: &BrowserState, r: Redaction) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    for window in state.window_order.iter() {
        if eligible_window(state, window.as_str()).is_none() {
            continue;
        }
        let active = state.active_tab(window.as_str()).map(|t| t.id.clone());
        for (index, id) in eligible_tab_ids(state, window).into_iter().enumerate() {
            let Some(t) = state.tab(id.as_str()) else {
                continue;
            };
            let url = state_url(&t.url, r);
            let title = url
                .as_ref()
                .map(|_| clean_text(t.custom_title.as_deref().unwrap_or(&t.title), MAX_TITLE));
            let group = ardia_state::groups::innermost_group_of(&state.groups, id.as_str())
                .filter(|g| eligible_group(state, g));
            out.push((
                id.to_string(),
                json!({
                    "id": id.to_string(),
                    "windowId": window.to_string(),
                    "index": index,
                    "url": url,
                    "title": title,
                    "pinned": t.pin.is_some(),
                    "active": Some(&id) == active.as_ref(),
                    "groupId": group.map(|g| g.to_string()),
                    "muted": t.muted,
                }),
            ));
        }
    }
    out
}

pub fn windows_rows(state: &BrowserState) -> Vec<(String, Value)> {
    let focused = state
        .focus_order
        .iter()
        .find(|w| eligible_window(state, w.as_str()).is_some())
        .cloned();
    state
        .window_order
        .iter()
        .filter_map(|id| {
            let kind = eligible_window(state, id.as_str())?;
            let tabs = eligible_tab_ids(state, id);
            let active = state
                .active_tab(id.as_str())
                .map(|t| t.id.clone())
                .filter(|a| tabs.contains(a));
            Some((
                format!("w:{id}"),
                json!({
                    "id": id.to_string(),
                    "kind": kind,
                    "focused": Some(id) == focused.as_ref(),
                    "activeTabId": active.map(|a| a.to_string()),
                    "tabCount": tabs.len(),
                }),
            ))
        })
        .collect()
}

pub fn groups_rows(state: &BrowserState) -> Vec<(String, Value)> {
    state
        .groups
        .values()
        .filter(|g| eligible_group(state, &g.id))
        .map(|g| {
            (
                format!("g:{}", g.id),
                json!({
                    "id": g.id.to_string(),
                    "windowId": g.window_id.to_string(),
                    "name": clean_text(&g.name, MAX_TITLE),
                    "color": g.color.as_ref().map_or_else(|| json!("neutral"), |c| serde_json::to_value(c).unwrap_or(json!("neutral"))),
                    "icon": g.icon,
                    "collapsed": g.collapsed,
                    "pinned": g.pinned,
                    "parentId": g.parent_id.as_ref().filter(|p| eligible_group(state, p)).map(|p| p.to_string()),
                    "tabIds": g.tab_ids.iter().filter(|t| eligible_tab(state, t.as_str())).map(|t| t.to_string()).collect::<Vec<_>>(),
                }),
            )
        })
        .collect()
}

pub fn windows_listing(state: &BrowserState, full: bool) -> Value {
    let r = Redaction { urls: true, full };
    let tabs = tabs_rows(state, r);
    Value::Array(
        windows_rows(state)
            .into_iter()
            .map(|(_, mut w)| {
                let id = w["id"].clone();
                w["tabs"] = Value::Array(
                    tabs.iter()
                        .filter(|(_, t)| t["windowId"] == id)
                        .map(|(_, t)| t.clone())
                        .collect(),
                );
                w
            })
            .collect(),
    )
}

pub type Sent = BTreeMap<String, String>;

pub fn diff_frame(
    topic: &str,
    rows: Vec<(String, Value)>,
    before: Option<&Sent>,
) -> (Option<Value>, Sent) {
    let mut signatures = Sent::new();
    let mut changed: Vec<(String, Value)> = Vec::new();
    for (id, row) in rows {
        let sig = row.to_string();
        if before.and_then(|b| b.get(&id)) != Some(&sig) {
            changed.push((id.clone(), row));
        }
        signatures.insert(id, sig);
    }
    let removed: Vec<String> = before
        .map(|b| {
            b.keys()
                .filter(|id| !signatures.contains_key(*id))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if before.is_some() && changed.is_empty() && removed.is_empty() {
        return (None, signatures);
    }
    let mut data = Map::new();
    if before.is_none() {
        data.insert("initial".into(), Value::Bool(true));
    }
    if topic == "workspace" {
        let pick = |prefix: &str| -> Value {
            Value::Array(
                changed
                    .iter()
                    .filter(|(id, _)| id.starts_with(prefix))
                    .map(|(_, v)| v.clone())
                    .collect(),
            )
        };
        let gone = |prefix: &str| -> Value {
            Value::Array(
                removed
                    .iter()
                    .filter_map(|id| id.strip_prefix(prefix))
                    .map(|id| Value::String(id.to_owned()))
                    .collect(),
            )
        };
        data.insert("windows".into(), pick("w:"));
        data.insert("groups".into(), pick("g:"));
        data.insert("removedWindows".into(), gone("w:"));
        data.insert("removedGroups".into(), gone("g:"));
    } else {
        data.insert(
            topic.into(),
            Value::Array(changed.into_iter().map(|(_, v)| v).collect()),
        );
        data.insert(
            "removed".into(),
            Value::Array(removed.into_iter().map(Value::String).collect()),
        );
    }
    (Some(Value::Object(data)), signatures)
}

pub fn rows_for(topic: &str, state: &BrowserState, r: Redaction) -> Vec<(String, Value)> {
    match topic {
        "tabs" => tabs_rows(state, r),
        "workspace" => {
            let mut rows = windows_rows(state);
            rows.extend(groups_rows(state));
            rows
        }
        _ => Vec::new(),
    }
}

pub fn wire_line(topic: &str, time: i64, data: &Value) -> String {
    json!({ "event": format!("state.{topic}"), "time": time, "data": data }).to_string()
}

type Problem = (&'static str, String);

fn bad(message: impl Into<String>) -> Problem {
    ("bad_request", message.into())
}

fn is_id(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 128
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.:@-".contains(c))
}

fn tab_arg(state: &BrowserState, value: &Value, path: &str) -> Result<TabId, Problem> {
    let id = value
        .as_str()
        .filter(|t| is_id(t))
        .ok_or_else(|| bad(format!("{path} must be a tab id.")))?;
    if !eligible_tab(state, id) {
        return Err((
            "refused",
            format!("There's no tab {id} this plugin may use."),
        ));
    }
    Ok(TabId::new(id))
}

fn tabs_arg(state: &BrowserState, value: &Value, path: &str) -> Result<Vec<TabId>, Problem> {
    let list = value
        .as_array()
        .filter(|l| !l.is_empty() && l.len() <= MAX_INTENT_TABS)
        .ok_or_else(|| {
            bad(format!(
                "{path} must be a list of 1 to {MAX_INTENT_TABS} tab ids."
            ))
        })?;
    let mut out: Vec<TabId> = Vec::new();
    for (i, id) in list.iter().enumerate() {
        let tab = tab_arg(state, id, &format!("{path}[{i}]"))?;
        if out.contains(&tab) {
            return Err(bad(format!("{path} names a tab twice.")));
        }
        out.push(tab);
    }
    Ok(out)
}

fn group_arg(state: &BrowserState, value: &Value, path: &str) -> Result<GroupId, Problem> {
    let id = value
        .as_str()
        .filter(|t| is_id(t))
        .ok_or_else(|| bad(format!("{path} must be a group id.")))?;
    let group = GroupId::new(id);
    if !eligible_group(state, &group) {
        return Err((
            "refused",
            format!("There's no group {id} this plugin may use."),
        ));
    }
    Ok(group)
}

fn name_arg(value: &Value, path: &str) -> Result<String, Problem> {
    value
        .as_str()
        .filter(|s| s.chars().count() <= 200 && !s.chars().any(control))
        .map(|s| s.trim().to_owned())
        .ok_or_else(|| bad(format!("{path} must be text of at most 200 characters with no control or direction characters.")))
}

fn group_patch(args: &Map<String, Value>) -> Result<GroupPatch, Problem> {
    let mut patch = GroupPatch::default();
    if let Some(name) = args.get("name") {
        patch.name = Some(name_arg(name, "name")?);
    }
    if let Some(collapsed) = args.get("collapsed") {
        patch.collapsed = Some(
            collapsed
                .as_bool()
                .ok_or_else(|| bad("collapsed must be true or false."))?,
        );
    }
    if let Some(color) = args.get("color") {
        patch.color = Some(match color.as_str() {
            Some("neutral") | Some("none") => None,
            _ => Some(
                serde_json::from_value(color.clone())
                    .map_err(|_| bad("color must be one of Ardia's group colors."))?,
            ),
        });
    }
    if let Some(icon) = args.get("icon") {
        patch.icon = Some(match icon {
            Value::Null => None,
            Value::String(s) if s == "none" => None,
            Value::String(s) if s.chars().count() <= 64 => Some(s.clone()),
            _ => {
                return Err(bad(
                    "icon must be an emoji from Ardia's picker, symbol:<SF Symbol name>, \"none\", or null.",
                ));
            }
        });
    }
    Ok(patch)
}

fn index_of(state: &BrowserState, tab: &TabId) -> Option<(WindowId, usize)> {
    let t = state.tab(tab.as_str())?;
    let w = state.window(t.window_id.as_str())?;
    w.tab_ids
        .iter()
        .position(|id| id == tab)
        .map(|i| (t.window_id.clone(), i))
}

pub const INTENTS: [(&str, &[&str]); 9] = [
    (
        "tabs.group",
        &["tabs", "name", "color", "icon", "collapsed"],
    ),
    ("tabs.ungroup", &["group"]),
    ("tabs.move", &["tabs", "before", "after", "group", "window"]),
    ("tabs.pin", &["tabs", "as"]),
    ("tabs.unpin", &["tabs"]),
    ("tabs.mute", &["tabs"]),
    ("tabs.unmute", &["tabs"]),
    ("tabs.activate", &["tab"]),
    (
        "groups.update",
        &["group", "name", "color", "icon", "collapsed"],
    ),
];

pub fn intent_actions(
    state: &BrowserState,
    intent: &str,
    args: &Map<String, Value>,
) -> Result<Vec<Action>, Problem> {
    let fields = INTENTS
        .iter()
        .find(|(name, _)| *name == intent)
        .map(|(_, f)| *f)
        .ok_or_else(|| {
            bad(format!(
                "intent is one of {}.",
                INTENTS
                    .iter()
                    .map(|(n, _)| *n)
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })?;
    if let Some(key) = args.keys().find(|k| !fields.contains(&k.as_str())) {
        return Err(bad(format!(
            "{intent} takes {}, not {}.",
            fields.join(", "),
            key.chars().take(40).collect::<String>()
        )));
    }
    let need = |key: &str| {
        args.get(key)
            .ok_or_else(|| bad(format!("{intent} needs {key}.")))
    };
    Ok(match intent {
        "tabs.group" => {
            let tabs = tabs_arg(state, need("tabs")?, "tabs")?;
            let name = args
                .get("name")
                .map(|n| name_arg(n, "name"))
                .transpose()?
                .unwrap_or_default();
            let mut actions = vec![Action::CreateGroup { tabs, name }];
            let patch = group_patch(args)?;
            if patch.color.is_some() || patch.icon.is_some() || patch.collapsed.is_some() {
                actions.push(Action::UpdateGroup {
                    group: GroupId::new("__new__"),
                    patch,
                });
            }
            actions
        }
        "tabs.ungroup" => vec![Action::Ungroup {
            group: group_arg(state, need("group")?, "group")?,
        }],
        "tabs.move" => {
            let tabs = tabs_arg(state, need("tabs")?, "tabs")?;
            if args.contains_key("before") && args.contains_key("after") {
                return Err(bad(format!("{intent} takes before or after, not both.")));
            }
            let anchor = args
                .get("before")
                .or(args.get("after"))
                .map(|a| tab_arg(state, a, "before"))
                .transpose()?;
            if anchor.as_ref().is_some_and(|a| tabs.contains(a)) {
                return Err(bad(format!(
                    "{intent} can't place tabs next to one of themselves."
                )));
            }
            if let Some(group) = args.get("group") {
                return match group {
                    Value::Null => Ok(vec![Action::RemoveFromGroups { tabs }]),
                    value => Ok(vec![Action::AddToGroup {
                        group: group_arg(state, value, "group")?,
                        tabs,
                    }]),
                };
            }
            let (window, mut index) = match (&anchor, args.get("window")) {
                (Some(anchor), _) => {
                    let (window, at) = index_of(state, anchor)
                        .ok_or_else(|| ("refused", "That tab is gone.".to_owned()))?;
                    (
                        window,
                        if args.contains_key("after") {
                            at + 1
                        } else {
                            at
                        },
                    )
                }
                (None, Some(window)) => {
                    let id = window
                        .as_str()
                        .filter(|w| is_id(w))
                        .ok_or_else(|| bad("window must be a window id."))?;
                    if eligible_window(state, id) != Some("normal") {
                        return Err((
                            "refused",
                            format!("There's no window {id} this plugin may use."),
                        ));
                    }
                    let count = state.window(id).map_or(0, |w| w.tab_ids.len());
                    (WindowId::new(id), count)
                }
                (None, None) => {
                    return Err(bad(
                        "tabs.move needs a destination: before, after, group or window.",
                    ));
                }
            };
            tabs.into_iter()
                .map(|tab| {
                    let action = Action::MoveTab {
                        tab,
                        window: window.clone(),
                        index,
                    };
                    index += 1;
                    action
                })
                .collect()
        }
        "tabs.pin" => {
            let pin = match args.get("as").and_then(Value::as_str) {
                None | Some("row") => TabPin::Row,
                Some("tile") => TabPin::TILE,
                Some(_) => return Err(bad("as must be \"tile\" or \"row\".")),
            };
            tabs_arg(state, need("tabs")?, "tabs")?
                .into_iter()
                .map(|tab| Action::SetPin {
                    tab,
                    pin: Some(pin.clone()),
                })
                .collect()
        }
        "tabs.unpin" => tabs_arg(state, need("tabs")?, "tabs")?
            .into_iter()
            .map(|tab| Action::SetPin { tab, pin: None })
            .collect(),
        "tabs.mute" | "tabs.unmute" => tabs_arg(state, need("tabs")?, "tabs")?
            .into_iter()
            .map(|tab| Action::SetMuted {
                tab,
                muted: intent == "tabs.mute",
            })
            .collect(),
        "tabs.activate" => vec![Action::ActivateTab {
            tab: tab_arg(state, need("tab")?, "tab")?,
        }],
        _ => {
            let group = group_arg(state, need("group")?, "group")?;
            let patch = group_patch(args)?;
            if args.len() < 2 {
                return Err(bad("groups.update needs name, color, icon or collapsed."));
            }
            vec![Action::UpdateGroup { group, patch }]
        }
    })
}

pub enum Op {
    Open {
        window: WindowId,
        urls: Vec<String>,
        activate: bool,
    },
    Actions(Vec<Action>),
}

pub fn apply_ops(
    state: &BrowserState,
    ops: &[Value],
    focused: Option<WindowId>,
    tab_only: bool,
) -> Result<Vec<Op>, Problem> {
    let mut out = Vec::new();
    for (i, op) in ops.iter().enumerate() {
        let fields = op
            .as_object()
            .ok_or_else(|| bad(format!("ops[{i}] must be an object.")))?;
        let name = fields.get("op").and_then(Value::as_str).unwrap_or_default();
        let args: Map<String, Value> = fields
            .iter()
            .filter(|(k, _)| k.as_str() != "op")
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        match name {
            "open" => {
                let urls: Vec<String> = args
                    .get("urls")
                    .and_then(Value::as_array)
                    .map(|u| {
                        u.iter()
                            .filter_map(|u| {
                                u.as_str()
                                    .and_then(ardia_ui::plugins::nodes::plugin_web_url)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if urls.is_empty() {
                    return Err(bad(format!(
                        "ops[{i}].urls must be http or https addresses."
                    )));
                }
                let window = match args.get("window").and_then(Value::as_str) {
                    Some(w) if eligible_window(state, w) == Some("normal") => WindowId::new(w),
                    Some(w) => {
                        return Err((
                            "refused",
                            format!("There's no window {w} this plugin may use."),
                        ));
                    }
                    None => focused.clone().ok_or_else(|| {
                        ("no_window", "No window to open the tabs in.".to_owned())
                    })?,
                };
                out.push(Op::Open {
                    window,
                    urls,
                    activate: args.get("activate") == Some(&Value::Bool(true)),
                });
            }
            "tab.close" => {
                let tabs = match args.get("tabs") {
                    Some(t) => tabs_arg(state, t, "tabs")?,
                    None => vec![tab_arg(
                        state,
                        args.get("tab").unwrap_or(&Value::Null),
                        "tab",
                    )?],
                };
                out.push(Op::Actions(vec![Action::CloseTabs {
                    tabs,
                    last_closes_window: false,
                }]));
            }
            "tab.activate" => out.push(Op::Actions(vec![Action::ActivateTab {
                tab: tab_arg(state, args.get("tab").unwrap_or(&Value::Null), "tab")?,
            }])),
            _ if tab_only => {
                return Err(("refused", format!("{name} needs the workspace permission.")));
            }
            "group.create" => out.push(Op::Actions(intent_actions(state, "tabs.group", &args)?)),
            "group.ungroup" => out.push(Op::Actions(intent_actions(state, "tabs.ungroup", &args)?)),
            "group.update" => out.push(Op::Actions(intent_actions(state, "groups.update", &args)?)),
            "tab.move" => out.push(Op::Actions(intent_actions(state, "tabs.move", &args)?)),
            "tab.pin" => out.push(Op::Actions(intent_actions(state, "tabs.pin", &args)?)),
            "tab.unpin" => out.push(Op::Actions(intent_actions(state, "tabs.unpin", &args)?)),
            "tab.mute" => out.push(Op::Actions(intent_actions(state, "tabs.mute", &args)?)),
            "tab.unmute" => out.push(Op::Actions(intent_actions(state, "tabs.unmute", &args)?)),
            other => return Err(bad(format!("ops[{i}].op {other} isn't one Ardia knows."))),
        }
    }
    Ok(out)
}

pub fn open_tab_action(window: &WindowId, url: &str, activate: bool) -> Action {
    Action::NewTab {
        window: window.clone(),
        tab: NewTab {
            url: Some(url.to_owned()),
            background: !activate,
            ..NewTab::default()
        },
    }
}

pub type Subscriptions = HashMap<(String, u64), (Vec<String>, HashMap<String, Sent>)>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_redacted_by_permission() {
        let none = Redaction::default();
        let short = Redaction {
            urls: true,
            full: false,
        };
        let full = Redaction {
            urls: true,
            full: true,
        };
        let url = "https://a.test/p?q=1#x";
        assert_eq!(state_url(url, none), None);
        assert_eq!(state_url(url, short).as_deref(), Some("https://a.test/p"));
        assert_eq!(
            state_url(url, full).as_deref(),
            Some("https://a.test/p?q=1")
        );
        assert_eq!(
            state_url("https://a.test/?token=1", full).as_deref(),
            Some("https://a.test/")
        );
        assert_eq!(state_url("https://u@a.test/", full), None);
        assert_eq!(state_url("file:///x", full), None);
        assert_eq!(clean_text("a\u{202e}b", 10), "ab");
    }

    #[test]
    fn diffs_send_initial_then_changes_and_removals() {
        let rows = vec![
            ("1".to_owned(), json!({"id": "1"})),
            ("2".to_owned(), json!({"id": "2"})),
        ];
        let (first, sent) = diff_frame("tabs", rows, None);
        assert_eq!(first.unwrap()["initial"], json!(true));
        let (none, sent) = diff_frame(
            "tabs",
            vec![
                ("1".into(), json!({"id": "1"})),
                ("2".into(), json!({"id": "2"})),
            ],
            Some(&sent),
        );
        assert!(none.is_none());
        let (change, _) = diff_frame(
            "tabs",
            vec![("1".into(), json!({"id": "1", "x": 1}))],
            Some(&sent),
        );
        let change = change.unwrap();
        assert_eq!(change["tabs"], json!([{"id": "1", "x": 1}]));
        assert_eq!(change["removed"], json!(["2"]));
        let (ws, _) = diff_frame(
            "workspace",
            vec![
                ("w:a".into(), json!({"id": "a"})),
                ("g:b".into(), json!({"id": "b"})),
            ],
            None,
        );
        let ws = ws.unwrap();
        assert_eq!(ws["windows"], json!([{"id": "a"}]));
        assert_eq!(ws["groups"], json!([{"id": "b"}]));
        assert_eq!(
            wire_line("tabs", 5, &json!({})),
            r#"{"event":"state.tabs","time":5,"data":{}}"#
        );
    }

    #[test]
    fn intents_check_their_args() {
        let state = ardia_state::BrowserState::default();
        let err = |intent: &str, args: Value| {
            intent_actions(&state, intent, args.as_object().unwrap())
                .err()
                .unwrap()
                .1
        };
        assert!(err("tabs.fly", json!({})).starts_with("intent is one of"));
        assert_eq!(
            err("tabs.pin", json!({"tabs": ["t1"], "x": 1})),
            "tabs.pin takes tabs, as, not x."
        );
        assert_eq!(
            err("tabs.activate", json!({"tab": "t1"})),
            "There's no tab t1 this plugin may use."
        );
        assert_eq!(err("tabs.mute", json!({})), "tabs.mute needs tabs.");
        assert!(has_secret_param("a=1&api_key=2"));
        assert!(!has_secret_param("q=hello"));
    }
}
