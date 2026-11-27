use std::collections::HashSet;

use serde_json::{Map, Value, json};
use sha2::Digest;

use crate::air_traffic::parse_match_pattern;

pub const HOOKS_FILE: &str = "hooks.json";
pub const APPROVALS_DOC: &str = "automation-approvals.json";
pub const APPROVALS_VERSION: u64 = 1;
pub const CONFIG_SOURCE: &str = "config.json";
const MAX_HOOKS: usize = 200;
const MAX_REWRITES: usize = 50;
const MAX_DISMISSED: usize = 500;
const MIN_IDLE_SECONDS: u64 = 60;

const KEYS: &[&str] = &[
    "name",
    "on",
    "at",
    "days",
    "timezone",
    "every",
    "match",
    "run",
    "command",
    "arg",
    "timeout",
    "idle",
    "fullUrls",
    "rewrite",
    "cancel",
    "route",
    "drop",
    "from",
    "folder",
    "permission",
    "kinds",
    "omnibox",
];
const DAYS: &[&str] = &["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const RULE_KEYS: &[(&str, &str)] = &[
    ("rewrite", "tab.opening"),
    ("cancel", "tab.opening"),
    ("route", "link.opening"),
    ("drop", "link.opening"),
    ("folder", "download.deciding"),
    ("permission", "permission.requested"),
];
const FILTER_KEYS: &[(&str, &str)] = &[("from", "link.opening"), ("kinds", "permission.requested")];
const OPEN_MODES: &[&str] = &["tab", "littleArdia", "window"];
const STRIPPING_TEMPLATES: &[&str] = &["{origin}{path}", "{origin}{path}{hash}"];
const DOWNLOADS_FOLDER: &str = "~/Downloads";
const SAFE_LAUNCH_ACTIONS: &[&str] = &[
    "newTab",
    "newWindow",
    "newLittleArdia",
    "focusCommandBar",
    "toggleSidebar",
    "nextTab",
    "previousTab",
    "selectTab",
    "selectLastTab",
];

pub const AUTOMATION_EVENTS: &[&str] = &[
    "window.opened",
    "window.closed",
    "window.focused",
    "tab.opened",
    "tab.closed",
    "tab.activated",
    "tab.navigated",
    "settings.changed",
    "app.launched",
    "app.quitting",
    "app.activated",
    "app.deactivated",
    "tab.idle",
    "tab.resumed",
    "media.started",
    "media.stopped",
    "tab.crashed",
    "notification.shown",
    "peek.opened",
    "peek.closed",
    "littleArdia.opened",
    "split.created",
    "split.closed",
    "pin.added",
    "pin.removed",
    "tab.moved",
    "profile.switched",
    "system.sleep",
    "system.wake",
    "user.idle",
    "user.active",
    "page.error",
    "bookmarks.changed",
    "history.removed",
    "download.changed",
    "profile.changed",
    "permission.prompted",
    "password.prompted",
    "menu.opened",
];
pub const DECIDE_EVENTS: &[&str] = &[
    "tab.opening",
    "link.opening",
    "download.deciding",
    "permission.requested",
];
const IDLE_EVENTS: &[&str] = &["tab.idle", "tab.resumed", "user.idle", "user.active"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rewrite {
    pub pattern: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub profile: Option<String>,
    pub open: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DecideRules {
    pub rewrite: Option<Vec<Rewrite>>,
    pub cancel: bool,
    pub route: Option<Route>,
    pub drop: bool,
    pub folder: Option<String>,
    pub permission: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OmniboxSpec {
    pub title: String,
    pub keyword: Option<String>,
    pub global: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HookSpec {
    pub name: String,
    pub revision: String,
    pub on: Vec<String>,
    pub patterns: Vec<String>,
    pub decide: Option<String>,
    pub rules: Option<DecideRules>,
    pub program: Option<Vec<String>>,
    pub command: Option<(String, Option<String>)>,
    pub omnibox: Option<OmniboxSpec>,
    pub from: Vec<String>,
    pub kinds: Vec<String>,
    pub full_urls: bool,
    pub scheduled: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HooksRead {
    pub hooks: Vec<HookSpec>,
    pub problems: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalRule {
    pub key: String,
    pub kind: String,
    pub name: String,
    pub summary: String,
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let body: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap_or_default(),
                        canonical_json(&map[k])
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Number(number) => match number.as_f64() {
            Some(f) if number.is_f64() && f.fract() == 0.0 && f.abs() < 1e21 => {
                format!("{}", f as i64)
            }
            _ => number.to_string(),
        },
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".into()),
    }
}

fn sha256_hex(text: &str) -> String {
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn hook_revision(raw: &Value) -> String {
    sha256_hex(&canonical_json(raw))[..32].to_owned()
}

pub fn parse_duration(value: &Value) -> Option<u64> {
    let text = value.as_str()?.trim();
    let unit = text.chars().last()?;
    let scale = match unit {
        's' => 1,
        'm' => 60,
        'h' => 3600,
        'd' => 86400,
        _ => return None,
    };
    let digits = &text[..text.len() - 1];
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok().map(|n| n * scale)
}

fn list_or_one(value: Option<&Value>) -> Option<Vec<String>> {
    match value {
        None => Some(Vec::new()),
        Some(Value::String(one)) => Some(vec![one.clone()]),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| v.as_str().map(str::to_owned))
            .collect(),
        Some(_) => None,
    }
}

fn string_list(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect()
}

fn rule_owner(key: &str) -> Option<&'static str> {
    RULE_KEYS
        .iter()
        .chain(FILTER_KEYS.iter())
        .find(|(k, _)| *k == key)
        .map(|(_, owner)| *owner)
}

fn is_time(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && text[..2].parse::<u32>().is_ok_and(|h| h <= 23)
        && text[3..].parse::<u32>().is_ok_and(|m| m <= 59)
        && bytes[..2].iter().chain(&bytes[3..]).all(u8::is_ascii_digit)
}

fn is_timezone(text: &str) -> bool {
    let mut parts = text.split('/');
    let first = parts.next().unwrap_or("");
    !first.is_empty()
        && first.chars().all(|c| c.is_ascii_alphabetic() || c == '_')
        && parts.all(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_+-".contains(c))
        })
}

fn check_trigger(item: &Map<String, Value>) -> Option<String> {
    let triggers = ["on", "at", "every", "omnibox"]
        .iter()
        .filter(|k| item.contains_key(**k))
        .count();
    if triggers != 1 {
        return Some("give exactly one of on, at, every or omnibox".into());
    }
    if let Some(at) = item.get("at")
        && !at.as_str().is_some_and(is_time)
    {
        return Some("at must be a time like \"09:00\"".into());
    }
    if let Some(days) = item.get("days") {
        if !item.contains_key("at") {
            return Some("days only goes with at".into());
        }
        let ok = string_list(days)
            .is_some_and(|d| !d.is_empty() && d.iter().all(|d| DAYS.contains(&d.as_str())));
        if !ok {
            return Some(format!("days must be a list of {}", DAYS.join(", ")));
        }
    }
    if let Some(zone) = item.get("timezone")
        && (!item.contains_key("at") || !zone.as_str().is_some_and(is_timezone))
    {
        return Some("timezone goes with at and is a name like Europe/Paris".into());
    }
    if let Some(every) = item.get("every")
        && parse_duration(every).is_none_or(|s| s < 60)
    {
        return Some("every must be a duration like \"15m\" or \"1h\", at least 1m".into());
    }
    None
}

fn is_web_template(to: &str) -> bool {
    let swapped = to
        .strip_prefix("{url}")
        .or_else(|| to.strip_prefix("{origin}"))
        .map_or_else(|| to.to_owned(), |rest| format!("https://x{rest}"));
    let lower = swapped.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn rules_of(item: &Map<String, Value>, event: &str) -> Result<DecideRules, String> {
    let mut rules = DecideRules::default();
    let mut count = 0;
    if let Some(list) = item.get("rewrite") {
        let list = list
            .as_array()
            .filter(|l| !l.is_empty() && l.len() <= MAX_REWRITES)
            .ok_or_else(|| {
                format!("rewrite must be a list of 1 to {MAX_REWRITES} {{\"match\", \"to\"}} rules")
            })?;
        let mut rewrites = Vec::new();
        for rule in list {
            let fields = rule
                .as_object()
                .filter(|f| f.keys().all(|k| k == "match" || k == "to"));
            let (Some(pattern), Some(to)) = (
                fields.and_then(|f| f.get("match")).and_then(Value::as_str),
                fields.and_then(|f| f.get("to")).and_then(Value::as_str),
            ) else {
                return Err("each rewrite rule is {\"match\": pattern, \"to\": URL}".into());
            };
            if let Err(error) = parse_match_pattern(pattern) {
                return Err(format!("bad match pattern {pattern}: {error}"));
            }
            if !is_web_template(to) {
                return Err(format!("rewrite to {to} must be an http or https URL"));
            }
            rewrites.push(Rewrite {
                pattern: pattern.to_owned(),
                to: to.to_owned(),
            });
        }
        rules.rewrite = Some(rewrites);
        count += 1;
    }
    if let Some(cancel) = item.get("cancel") {
        if cancel != &Value::Bool(true) {
            return Err("cancel must be true".into());
        }
        rules.cancel = true;
        count += 1;
    }
    if let Some(drop) = item.get("drop") {
        if drop != &Value::Bool(true) {
            return Err("drop must be true".into());
        }
        rules.drop = true;
        count += 1;
    }
    if let Some(route) = item.get("route") {
        let fields = route
            .as_object()
            .filter(|f| f.keys().all(|k| k == "profile" || k == "open"))
            .ok_or(
                "route is {\"profile\"?: name, \"open\"?: \"tab\" | \"littleArdia\" | \"window\"}",
            )?;
        let profile = match fields.get("profile") {
            None => None,
            Some(Value::String(p)) if !p.is_empty() => Some(p.clone()),
            Some(_) => return Err("route.profile must be a profile name or id".into()),
        };
        let open = match fields.get("open") {
            None => None,
            Some(Value::String(o)) if OPEN_MODES.contains(&o.as_str()) => Some(o.clone()),
            Some(_) => return Err(format!("route.open must be {}", OPEN_MODES.join(", "))),
        };
        if profile.is_none() && open.is_none() {
            return Err("route needs profile or open".into());
        }
        rules.route = Some(Route { profile, open });
        count += 1;
    }
    if let Some(folder) = item.get("folder") {
        let folder = folder
            .as_str()
            .filter(|f| f.starts_with("~/"))
            .ok_or("folder must be a path under your home folder, starting with ~/")?;
        if folder.split('/').any(|p| p == ".." || p == ".") {
            return Err("folder can't contain . or .. parts".into());
        }
        rules.folder = Some(folder.to_owned());
        count += 1;
    }
    if let Some(permission) = item.get("permission") {
        let permission = permission
            .as_str()
            .filter(|p| ["allow", "deny", "ask"].contains(p))
            .ok_or("permission must be allow, deny or ask")?;
        rules.permission = Some(permission.to_owned());
        count += 1;
    }
    if count > 1 && !(event == "tab.opening" && rules.rewrite.is_some() && !rules.cancel) {
        return Err("give one answer: one of the decide keys".into());
    }
    Ok(rules)
}

fn omnibox_of(value: &Value) -> Result<OmniboxSpec, String> {
    let fields = value
        .as_object()
        .filter(|f| {
            f.keys()
                .all(|k| ["title", "keyword", "global"].contains(&k.as_str()))
        })
        .ok_or("omnibox is {\"title\", \"keyword\"} or {\"title\", \"global\": true}")?;
    let title = fields
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("omnibox needs a title")?;
    let keyword = match fields.get("keyword") {
        None => None,
        Some(Value::String(k))
            if (1..=32).contains(&k.chars().count()) && !k.chars().any(char::is_whitespace) =>
        {
            Some(k.clone())
        }
        Some(_) => return Err("omnibox.keyword must be one word".into()),
    };
    let global = match fields.get("global") {
        None => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return Err("omnibox.global must be true".into()),
    };
    if keyword.is_none() == !global {
        return Err("omnibox takes a keyword or global: true, not both".into());
    }
    Ok(OmniboxSpec {
        title: title.to_owned(),
        keyword,
        global,
    })
}

fn parse_hook(name: &str, item: &Map<String, Value>) -> Result<HookSpec, String> {
    if let Some(unknown) = item.keys().find(|k| !KEYS.contains(&k.as_str())) {
        return Err(format!("unknown key {unknown}"));
    }
    if let Some(problem) = check_trigger(item) {
        return Err(problem);
    }
    let on = list_or_one(item.get("on")).ok_or("on must be a list of event names")?;
    let decide = on
        .iter()
        .find(|n| DECIDE_EVENTS.contains(&n.as_str()))
        .cloned();
    for event in &on {
        if event != "*"
            && !AUTOMATION_EVENTS.contains(&event.as_str())
            && !DECIDE_EVENTS.contains(&event.as_str())
        {
            return Err(format!("unknown event {event}"));
        }
    }
    if item.contains_key("on") && on.is_empty() {
        return Err("give at least one event".into());
    }
    if let Some(decide) = &decide
        && on.len() != 1
    {
        return Err(format!("{decide} goes alone in on"));
    }
    let patterns =
        list_or_one(item.get("match")).ok_or("match must be a list of match patterns")?;
    for pattern in &patterns {
        if let Err(error) = parse_match_pattern(pattern) {
            return Err(format!("bad match pattern {pattern}: {error}"));
        }
    }
    let rule_keys: Vec<&str> = RULE_KEYS
        .iter()
        .map(|(k, _)| *k)
        .filter(|k| item.contains_key(*k))
        .collect();
    let actions = ["run", "command"]
        .iter()
        .filter(|k| item.contains_key(**k))
        .count()
        + usize::from(!rule_keys.is_empty());
    if actions != 1 {
        return Err("give exactly one of run, command or a decide answer (rewrite, cancel, route, drop, folder, permission)".into());
    }
    for key in item.keys().map(String::as_str) {
        if let Some(owner) = rule_owner(key)
            && decide.as_deref() != Some(owner)
        {
            return Err(format!("{key} only goes with on: [\"{owner}\"]"));
        }
    }
    let mut program = None;
    if let Some(run) = item.get("run") {
        if let Some(text) = run.as_str() {
            return Err(format!(
                "run must be a list, like [\"{text}\"], or [\"/bin/sh\", \"-c\", \"…\"] for a shell line"
            ));
        }
        let list = string_list(run)
            .filter(|l| !l.is_empty() && l.iter().all(|p| !p.is_empty() && !p.contains('\0')))
            .ok_or("run must be a non-empty list of strings: [program, args…]")?;
        program = Some(list);
    }
    let mut command = None;
    if let Some(id) = item.get("command") {
        let id = id
            .as_str()
            .filter(|i| !i.is_empty())
            .ok_or("command must be a command id")?;
        if decide.is_some() || item.contains_key("omnibox") {
            return Err("command can't answer a decide event or the omnibox".into());
        }
        command = Some((id.to_owned(), None));
    }
    if let Some(arg) = item.get("arg") {
        let Some((_, slot)) = command.as_mut() else {
            return Err("arg only goes with command".into());
        };
        *slot = Some(arg.as_str().ok_or("arg must be a string")?.to_owned());
    }
    if let Some(timeout) = item.get("timeout") {
        if decide.is_some() || item.contains_key("omnibox") || program.is_none() {
            return Err("timeout only goes with run on events and schedules; decide and omnibox hooks have fixed deadlines".into());
        }
        if !timeout.as_f64().is_some_and(|t| t > 0.0 && t <= 86400.0) {
            return Err(
                "timeout must be a number of seconds, more than 0 and at most 86400".into(),
            );
        }
    }
    let idle_events: Vec<&String> = on
        .iter()
        .filter(|n| IDLE_EVENTS.contains(&n.as_str()))
        .collect();
    if let Some(idle) = item.get("idle") {
        if idle_events.is_empty() {
            return Err(
                "idle only goes with tab.idle, tab.resumed, user.idle or user.active".into(),
            );
        }
        if parse_duration(idle).is_none_or(|s| s < MIN_IDLE_SECONDS) {
            return Err("idle must be a duration like \"30m\", at least 1m".into());
        }
    } else if let Some(first) = idle_events.first() {
        return Err(format!("{first} needs idle, like \"idle\": \"30m\""));
    }
    if item.get("fullUrls").is_some_and(|v| !v.is_boolean()) {
        return Err("fullUrls must be true or false".into());
    }
    let rules = if rule_keys.is_empty() {
        None
    } else {
        Some(rules_of(item, decide.as_deref().unwrap_or(""))?)
    };
    let omnibox = match item.get("omnibox") {
        None => None,
        Some(value) => {
            let parsed = omnibox_of(value)?;
            if program.is_none() {
                return Err("an omnibox hook needs run".into());
            }
            Some(parsed)
        }
    };
    let from =
        list_or_one(item.get("from")).ok_or("from must be a list of app bundle ids or names")?;
    let kinds = list_or_one(item.get("kinds")).ok_or("kinds must be a list of permission kinds")?;
    Ok(HookSpec {
        name: name.to_owned(),
        revision: hook_revision(&Value::Object(item.clone())),
        on,
        patterns,
        decide,
        rules,
        program,
        command,
        omnibox,
        from,
        kinds,
        full_urls: item.get("fullUrls") == Some(&Value::Bool(true)),
        scheduled: item.contains_key("at") || item.contains_key("every"),
    })
}

pub fn parse_hooks_document(doc: &Value) -> HooksRead {
    let Some(list) = doc.get("hooks").and_then(Value::as_array) else {
        return HooksRead {
            hooks: Vec::new(),
            problems: vec![format!(
                "{HOOKS_FILE} must be an object with a \"hooks\" list"
            )],
        };
    };
    if list.len() > MAX_HOOKS {
        return HooksRead {
            hooks: Vec::new(),
            problems: vec![format!("{HOOKS_FILE} has more than {MAX_HOOKS} hooks")],
        };
    }
    let mut hooks = Vec::new();
    let mut problems = Vec::new();
    let mut names = HashSet::new();
    for (index, item) in list.iter().enumerate() {
        let Some(fields) = item.as_object() else {
            problems.push(format!("hook {} must be an object", index + 1));
            continue;
        };
        let Some(name) = fields
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| !n.trim().is_empty())
        else {
            problems.push(format!("hook {} needs a name", index + 1));
            continue;
        };
        if !names.insert(name.to_owned()) {
            problems.push(format!("hook {name}: the name is used twice"));
            continue;
        }
        match parse_hook(name, fields) {
            Ok(hook) => hooks.push(hook),
            Err(problem) => problems.push(format!("hook {name}: {problem}")),
        }
    }
    if !problems.is_empty() {
        hooks.clear();
    }
    HooksRead { hooks, problems }
}

pub fn parse_hooks_text(text: &str) -> HooksRead {
    match serde_json::from_str::<Value>(text) {
        Ok(doc) => parse_hooks_document(&doc),
        Err(error) => HooksRead {
            hooks: Vec::new(),
            problems: vec![format!("{HOOKS_FILE} doesn't parse: {error}")],
        },
    }
}

pub fn is_inside_downloads(folder: &str) -> bool {
    folder == DOWNLOADS_FOLDER || folder.starts_with(&format!("{DOWNLOADS_FOLDER}/"))
}

pub fn approval_for(hook: &HookSpec) -> Option<ApprovalRule> {
    let rule = |kind: &str, summary: String| ApprovalRule {
        key: format!("{kind}:{}", hook.revision),
        kind: kind.to_owned(),
        name: hook.name.clone(),
        summary,
    };
    let first_program = || {
        hook.program
            .as_ref()
            .and_then(|p| p.first())
            .cloned()
            .unwrap_or_default()
    };
    if let Some(omnibox) = &hook.omnibox {
        let typed = if omnibox.global {
            "everything you type in the address bar".to_owned()
        } else {
            format!(
                "what you type after \u{201c}{}\u{201d}",
                omnibox.keyword.clone().unwrap_or_default()
            )
        };
        return Some(rule(
            "omnibox",
            format!("Sends {typed} to {} for suggestions", first_program()),
        ));
    }
    let decide = hook.decide.as_ref()?;
    if hook.program.is_some() {
        return Some(rule(
            "program",
            format!("{} answers {decide}", first_program()),
        ));
    }
    let rules = hook.rules.as_ref()?;
    if let Some(rewrites) = &rules.rewrite
        && !rewrites
            .iter()
            .all(|r| STRIPPING_TEMPLATES.contains(&r.to.as_str()))
    {
        let summary = rewrites
            .iter()
            .map(|r| format!("{} \u{2192} {}", r.pattern, r.to))
            .collect::<Vec<_>>()
            .join("; ");
        return Some(rule("rewrite", summary));
    }
    if let Some(route) = &rules.route {
        let from = if hook.from.is_empty() {
            String::new()
        } else {
            format!(" from {}", hook.from.join(", "))
        };
        let target: Vec<String> = [
            route.profile.as_ref().map(|p| format!("profile {p}")),
            route.open.clone(),
        ]
        .into_iter()
        .flatten()
        .collect();
        return Some(rule(
            "route",
            format!("Opens links{from} in {}", target.join(", ")),
        ));
    }
    if let Some(folder) = &rules.folder
        && !is_inside_downloads(folder)
    {
        return Some(rule("folder", format!("Saves downloads to {folder}")));
    }
    None
}

pub fn launch_action_approval(entry: &str) -> Option<ApprovalRule> {
    let id = entry.split(':').next().unwrap_or("");
    if SAFE_LAUNCH_ACTIONS.contains(&id) {
        return None;
    }
    Some(ApprovalRule {
        key: format!("launchAction:{}", &sha256_hex(entry)[..32]),
        kind: "launchAction".into(),
        name: format!("launchActions: {entry}"),
        summary: format!("Runs {entry} each time Ardia starts"),
    })
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Approvals {
    pub approved: Vec<(ApprovalRule, f64)>,
    pub dismissed: Vec<String>,
}

fn number_of(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

fn rule_of(value: &Value) -> Option<(ApprovalRule, f64)> {
    let text = |k: &str| value.get(k).and_then(Value::as_str).map(str::to_owned);
    Some((
        ApprovalRule {
            key: text("key")?,
            kind: text("kind")?,
            name: text("name")?,
            summary: text("summary")?,
        },
        value.get("at")?.as_f64()?,
    ))
}

impl Approvals {
    pub fn from_value(doc: &Value) -> Approvals {
        let readable = doc
            .get("version")
            .and_then(Value::as_u64)
            .is_none_or(|v| v <= APPROVALS_VERSION);
        if !readable {
            return Approvals::default();
        }
        let approved = doc
            .get("approved")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(key, rule)| rule_of(rule).filter(|(r, _)| &r.key == key))
            .collect();
        let dismissed = doc
            .get("dismissed")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|d| d.as_str().map(str::to_owned))
            .collect();
        Approvals {
            approved,
            dismissed,
        }
    }

    pub fn to_value(&self) -> Value {
        let approved: Map<String, Value> = self
            .approved
            .iter()
            .map(|(rule, at)| {
                (
                    rule.key.clone(),
                    json!({"key": rule.key, "kind": rule.kind, "name": rule.name, "summary": rule.summary, "at": number_of(*at)}),
                )
            })
            .collect();
        json!({"approved": approved, "dismissed": self.dismissed, "version": APPROVALS_VERSION})
    }

    pub fn is_approved(&self, key: &str) -> bool {
        self.approved.iter().any(|(rule, _)| rule.key == key)
    }

    pub fn approve(&mut self, rule: ApprovalRule, now: f64) {
        self.approved.retain(|(r, _)| r.key != rule.key);
        self.dismissed.retain(|d| *d != rule.key);
        self.approved.push((rule, now));
    }

    pub fn remove(&mut self, key: &str) {
        self.approved.retain(|(r, _)| r.key != key);
        if !self.dismissed.iter().any(|d| d == key) {
            self.dismissed.push(key.to_owned());
        }
        let skip = self.dismissed.len().saturating_sub(MAX_DISMISSED);
        self.dismissed.drain(..skip);
    }

    pub fn approved_rules(&self) -> Vec<ApprovalRule> {
        let mut rules: Vec<ApprovalRule> = self.approved.iter().map(|(r, _)| r.clone()).collect();
        rules.sort_by_key(|r| r.name.to_lowercase());
        rules
    }

    pub fn pending(&self, offered: &[ApprovalRule]) -> Vec<ApprovalRule> {
        let mut seen = HashSet::new();
        offered
            .iter()
            .filter(|r| {
                !self.is_approved(&r.key)
                    && !self.dismissed.contains(&r.key)
                    && seen.insert(r.key.clone())
            })
            .cloned()
            .collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkHookState {
    Active,
    Approved,
    Waiting,
    Off,
}

impl LinkHookState {
    pub fn label(self) -> &'static str {
        match self {
            LinkHookState::Active => "On",
            LinkHookState::Approved => "Approved",
            LinkHookState::Waiting => "Waiting for approval",
            LinkHookState::Off => "Off",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkHookRow {
    pub name: String,
    pub from: Vec<String>,
    pub patterns: Vec<String>,
    pub answer: String,
    pub state: LinkHookState,
}

impl LinkHookRow {
    pub fn summary(&self) -> String {
        let from = if self.from.is_empty() {
            "Any app".to_owned()
        } else {
            format!("From {}", self.from.join(", "))
        };
        let links = if self.patterns.is_empty() {
            "any link".to_owned()
        } else {
            self.patterns.join(", ")
        };
        format!(
            "{from} \u{b7} {links} \u{2192} {} \u{b7} {}",
            self.answer,
            self.state.label()
        )
    }
}

fn answer_of(hook: &HookSpec) -> String {
    if let Some(program) = &hook.program {
        return format!("asks {}", program.first().cloned().unwrap_or_default());
    }
    let Some(rules) = &hook.rules else {
        return String::new();
    };
    if rules.drop {
        return "drops it".into();
    }
    rules
        .route
        .as_ref()
        .map(|route| {
            [
                route.profile.as_ref().map(|p| format!("profile {p}")),
                route.open.clone(),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ")
        })
        .unwrap_or_default()
}

pub fn link_hook_rows(hooks: &[HookSpec], approvals: &Approvals) -> Vec<LinkHookRow> {
    hooks
        .iter()
        .filter(|h| h.decide.as_deref() == Some("link.opening"))
        .map(|hook| {
            let state = match approval_for(hook) {
                None => LinkHookState::Active,
                Some(rule) if approvals.is_approved(&rule.key) => LinkHookState::Approved,
                Some(rule) if approvals.dismissed.contains(&rule.key) => LinkHookState::Off,
                Some(_) => LinkHookState::Waiting,
            };
            LinkHookRow {
                name: hook.name.clone(),
                from: hook.from.clone(),
                patterns: hook.patterns.clone(),
                answer: answer_of(hook),
                state,
            }
        })
        .collect()
}

pub fn provider_rule(
    key: &str,
    title: &str,
    keyword: Option<&str>,
    global: bool,
    endpoint: Option<&str>,
) -> ApprovalRule {
    let summary = match endpoint {
        Some(endpoint) => {
            let typed = if global {
                "everything you type in the address bar".to_owned()
            } else {
                format!(
                    "what you type after \u{201c}{}\u{201d}",
                    keyword.unwrap_or("")
                )
            };
            format!("Sends {typed} to {endpoint}")
        }
        None => format!("Address bar provider {title}"),
    };
    ApprovalRule {
        key: format!("omniboxProvider:{key}"),
        kind: "omniboxProvider".into(),
        name: title.to_owned(),
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(doc: Value) -> HooksRead {
        parse_hooks_document(&doc)
    }

    #[test]
    fn link_hooks_parse_and_ask_for_approval() {
        let parsed = read(json!({"hooks": [
            {"name": "Work links", "on": "link.opening", "from": ["Slack"], "match": "*://*.corp.com/*", "route": {"profile": "Work", "open": "window"}},
            {"name": "Drop ads", "on": ["link.opening"], "drop": true},
            {"name": "Ping", "every": "15m", "run": ["/usr/bin/true"]}
        ]}));
        assert!(parsed.problems.is_empty(), "{:?}", parsed.problems);
        assert_eq!(parsed.hooks.len(), 3);
        let work = approval_for(&parsed.hooks[0]).expect("a route needs approval");
        assert_eq!(work.kind, "route");
        assert_eq!(
            work.summary,
            "Opens links from Slack in profile Work, window"
        );
        assert_eq!(work.key.len(), "route:".len() + 32);
        assert!(approval_for(&parsed.hooks[1]).is_none());
        assert!(parsed.hooks[2].scheduled);
        let mut approvals = Approvals::default();
        let rows = link_hook_rows(&parsed.hooks, &approvals);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].state, LinkHookState::Waiting);
        assert_eq!(rows[1].state, LinkHookState::Active);
        assert_eq!(
            rows[0].summary(),
            "From Slack \u{b7} *://*.corp.com/* \u{2192} profile Work, window \u{b7} Waiting for approval"
        );
        approvals.approve(work.clone(), 1.0);
        assert_eq!(
            link_hook_rows(&parsed.hooks, &approvals)[0].state,
            LinkHookState::Approved
        );
        approvals.remove(&work.key);
        assert_eq!(
            link_hook_rows(&parsed.hooks, &approvals)[0].state,
            LinkHookState::Off
        );
        assert!(approvals.pending(&[work]).is_empty());
    }

    #[test]
    fn one_bad_hook_rejects_the_file_like_the_old_reader() {
        let parsed = read(json!({"hooks": [
            {"name": "ok", "on": "tab.opened", "run": ["/bin/echo"]},
            {"name": "bad", "on": "nope", "run": ["/bin/echo"]}
        ]}));
        assert!(parsed.hooks.is_empty());
        assert_eq!(parsed.problems, vec!["hook bad: unknown event nope"]);
        assert_eq!(
            read(json!({"hooks": [{"name": "x", "on": "tab.idle", "run": ["a"]}]})).problems,
            vec!["hook x: tab.idle needs idle, like \"idle\": \"30m\""]
        );
        assert_eq!(parse_hooks_text("{").problems.len(), 1);
    }

    #[test]
    fn revisions_ignore_key_order_and_integral_floats() {
        assert_eq!(
            hook_revision(&json!({"b": 1, "a": [true, "x"]})),
            hook_revision(&json!({"a": [true, "x"], "b": 1.0}))
        );
        assert_eq!(
            canonical_json(&json!({"b": 1, "a": "é"})),
            "{\"a\":\"é\",\"b\":1}"
        );
    }

    #[test]
    fn launch_actions_and_providers_read_like_the_old_rows() {
        assert!(launch_action_approval("newTab").is_none());
        let rule = launch_action_approval("openUrl:https://a.com").expect("needs approval");
        assert_eq!(rule.name, "launchActions: openUrl:https://a.com");
        assert_eq!(
            rule.summary,
            "Runs openUrl:https://a.com each time Ardia starts"
        );
        let provider = provider_rule(
            "omnibox-provider:ab",
            "Links",
            Some("l"),
            false,
            Some("api.example.com"),
        );
        assert_eq!(provider.key, "omniboxProvider:omnibox-provider:ab");
        assert_eq!(
            provider.summary,
            "Sends what you type after \u{201c}l\u{201d} to api.example.com"
        );
    }

    #[test]
    fn approvals_round_trip_and_sort_by_name() {
        let mut approvals = Approvals::default();
        let rule = |k: &str, n: &str| ApprovalRule {
            key: k.into(),
            kind: "route".into(),
            name: n.into(),
            summary: "s".into(),
        };
        approvals.approve(rule("b", "beta"), 2.0);
        approvals.approve(rule("a", "Alpha"), 1.0);
        let back = Approvals::from_value(&approvals.to_value());
        assert_eq!(back.approved_rules()[0].name, "Alpha");
        assert!(back.is_approved("b"));
        assert_eq!(approvals.to_value()["approved"]["a"]["at"], json!(1));
        assert_eq!(
            back.pending(&[rule("c", "c"), rule("a", "a"), rule("c", "c")])
                .len(),
            1
        );
    }
}
