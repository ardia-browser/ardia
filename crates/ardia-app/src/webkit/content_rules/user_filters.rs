use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::packer::NetworkRule;

pub const PARSER_VERSION: &str = "3";
pub const READ_SCRIPT: &str = "userFilters().then((content) => { const ublock = chrome.extension.getBackgroundPage().µBlock; return ublock.selectedFilterLists.includes(ublock.userFiltersPath) ? content : \"\"; })";
const SEPARATOR: &str = "[^a-zA-Z0-9_.%-]";
const HOST_ANCHOR: &str = "^[^:]+://+([^:/]+\\.)?";
const REGEX_SPECIALS: &str = ".*+?()[]\\$^|{}";
const MAX_PROCEDURAL_DEPTH: usize = 8;
const PROCEDURAL: [&str; 22] = [
    ":has-text(",
    ":upward(",
    ":remove(",
    ":style(",
    ":matches-css(",
    ":matches-css-before(",
    ":matches-css-after(",
    ":min-text-length(",
    ":xpath(",
    ":remove-attr(",
    ":remove-class(",
    ":watch-attr(",
    ":matches-path(",
    ":matches-attr(",
    ":matches-prop(",
    ":matches-media(",
    ":others(",
    ":shadow(",
    ":spath(",
    ":if(",
    ":if-not(",
    ":-abp-",
];
const ACTIONS: [&str; 4] = ["remove", "style", "remove-attr", "remove-class"];

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedRule {
    pub priority: i64,
    pub exception: bool,
    pub json: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UserFilters {
    pub digest: String,
    pub network: Vec<SavedRule>,
    pub hide: BTreeMap<String, Vec<String>>,
    pub unhide: BTreeMap<String, Vec<String>>,
    pub strict_hosts: Vec<String>,
    pub strict_allow_hosts: Vec<String>,
    pub accepted: i64,
    pub rejected: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RejectedUserFilters {
    pub digest: String,
    pub error: String,
    pub rules: Option<Vec<String>>,
}

fn simple_type(name: &str) -> Option<&'static str> {
    Some(match name {
        "script" => "script",
        "image" => "image",
        "stylesheet" | "css" => "style-sheet",
        "font" => "font",
        "media" => "media",
        "xmlhttprequest" | "xhr" | "websocket" | "object" | "other" => "raw",
        "ping" | "beacon" => "ping",
        _ => return None,
    })
}

fn operator(name: &str) -> Option<&'static str> {
    Some(match name {
        "has-text" | "-abp-contains" => "has-text",
        "upward" => "upward",
        "min-text-length" => "min-text-length",
        "xpath" => "xpath",
        "matches-path" => "matches-path",
        "matches-media" => "matches-media",
        "others" => "others",
        "shadow" => "shadow",
        "spath" => "spath",
        "if" | "-abp-has" => "if",
        "if-not" => "if-not",
        _ => return None,
    })
}

pub fn digest_of(text: &str) -> String {
    let hash = Sha256::digest(format!("{PARSER_VERSION}\n{text}").as_bytes());
    hash[..8].iter().map(|b| format!("{b:02x}")).collect()
}

pub fn encode(value: &Value) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let ordered: BTreeMap<String, Value> =
                    map.iter().map(|(k, v)| (k.clone(), sorted(v))).collect();
                serde_json::to_value(ordered).unwrap_or(Value::Null)
            }
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Object(map) => {
                let ordered: BTreeMap<&String, &Value> = map.iter().collect();
                out.push('{');
                for (i, (k, v)) in ordered.into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&Value::String(k.clone()).to_string());
                    out.push(':');
                    write(v, out);
                }
                out.push('}');
            }
            Value::Array(items) => {
                out.push('[');
                for (i, v) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(v, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut out = String::new();
    write(&sorted(value), &mut out);
    out
}

pub fn is_procedural(body: &str) -> bool {
    PROCEDURAL.iter().any(|p| body.contains(p))
}

struct Cosmetic {
    hosts: Vec<String>,
    exception: bool,
    body: String,
    ok: bool,
}

fn cosmetic_parts(line: &str) -> Option<Cosmetic> {
    if !line.contains('#') {
        return None;
    }
    let hash = line.find('#')?;
    let hosts_part = &line[..hash];
    if hosts_part.contains(['#', '/', '$', '|', '@']) {
        return None;
    }
    let rest = &line[hash + 1..];
    let (exception, rest) = match rest.strip_prefix('@') {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    let (kind, rest) = match rest.chars().next() {
        Some(c @ ('?' | '$' | '%')) => (c.to_string(), &rest[1..]),
        _ => (String::new(), rest),
    };
    let body = rest.strip_prefix('#')?;
    if body.is_empty() {
        return None;
    }
    let body = body.trim().to_owned();
    let mut ok = kind.is_empty() || kind == "?";
    let mut hosts = Vec::new();
    for part in hosts_part.split(',') {
        let host = part.trim().to_lowercase();
        if host.is_empty() {
            continue;
        }
        let named = host.strip_suffix(".*").unwrap_or(&host);
        if named.is_empty()
            || !named
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
        {
            ok = false;
        }
        hosts.push(host);
    }
    if body.starts_with("+js(")
        || body.starts_with('^')
        || body.starts_with('+')
        || !body.is_ascii()
    {
        ok = false;
    }
    let ok = ok && !body.is_empty();
    Some(Cosmetic {
        hosts,
        exception,
        body,
        ok,
    })
}

fn matching_paren(text: &str, start: usize) -> Option<usize> {
    let mut depth = 1;
    let mut escaped = false;
    for (offset, ch) in text[start..].char_indices() {
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth -= 1;
            if depth == 0 {
                return Some(start + offset);
            }
        }
    }
    None
}

struct Found<'a> {
    name: String,
    argument: &'a str,
    start: usize,
    end: usize,
}

fn next_operator(text: &str) -> Option<Option<Found<'_>>> {
    let bytes: Vec<(usize, char)> = text.char_indices().collect();
    let mut i = 0;
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    while i < bytes.len() {
        let (index, ch) = bytes[i];
        if let Some(open) = quote {
            if ch == '\\' {
                i += 2;
                continue;
            }
            if ch == open {
                quote = None;
            }
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
        } else if ch == '[' || ch == '(' {
            depth += 1;
        } else if ch == ']' || ch == ')' {
            depth -= 1;
        } else if ch == ':' && depth == 0 {
            let after = &text[index + 1..];
            let name: String = after
                .chars()
                .take_while(|c| c.is_alphabetic() || *c == '-')
                .collect();
            if !name.is_empty()
                && (operator(&name).is_some() || ACTIONS.contains(&name.as_str()))
                && after[name.len()..].starts_with('(')
            {
                let open = index + name.len() + 2;
                let close = matching_paren(text, open)?;
                return Some(Some(Found {
                    name,
                    argument: &text[open..close],
                    start: index,
                    end: close + 1,
                }));
            }
        }
        i += 1;
    }
    Some(None)
}

fn safe_style(declarations: &str) -> bool {
    !declarations.contains(['{', '}', '\\']) && !declarations.to_lowercase().contains("url(")
}

type Parsed = (String, Vec<Value>, Option<Vec<String>>);

fn procedural_tasks(body: &str, depth: usize) -> Option<Parsed> {
    if depth >= MAX_PROCEDURAL_DEPTH {
        return None;
    }
    let mut tasks: Vec<Value> = Vec::new();
    let mut action: Option<Vec<String>> = None;
    let mut rest = body;
    let mut prefix = String::new();
    while !rest.is_empty() {
        let found = next_operator(rest)?;
        let Some(found) = found else {
            if !tasks.is_empty() || action.is_some() {
                tasks.push(Value::Array(vec!["spath".into(), rest.into()]));
            } else {
                prefix.push_str(rest);
            }
            break;
        };
        let before = &rest[..found.start];
        if tasks.is_empty() && action.is_none() {
            prefix.push_str(before);
        } else if !before.is_empty() {
            tasks.push(Value::Array(vec!["spath".into(), before.into()]));
        }
        if action.is_some() {
            return None;
        }
        if ACTIONS.contains(&found.name.as_str()) {
            if found.name == "style" && !safe_style(found.argument) {
                return None;
            }
            action = Some(vec![found.name.clone(), found.argument.to_owned()]);
        } else {
            let op = operator(&found.name)?;
            if op == "if" || op == "if-not" {
                let inner = procedural_tasks(found.argument, depth + 1)?;
                let mut nested = serde_json::Map::new();
                nested.insert("selector".into(), inner.0.into());
                if !inner.1.is_empty() {
                    nested.insert("tasks".into(), Value::Array(inner.1));
                }
                tasks.push(Value::Array(vec![op.into(), Value::Object(nested)]));
            } else if op == "upward"
                && let Ok(count) = found.argument.parse::<i64>()
            {
                tasks.push(Value::Array(vec![op.into(), count.into()]));
            } else if op == "min-text-length"
                && let Ok(length) = found.argument.parse::<i64>()
            {
                tasks.push(Value::Array(vec![op.into(), length.into()]));
            } else {
                tasks.push(Value::Array(vec![op.into(), found.argument.into()]));
            }
        }
        rest = &rest[found.end..];
    }
    let selector = prefix.trim().to_owned();
    if action.as_ref().is_some_and(|a| a[0] == "style") && tasks.is_empty() && !selector.is_empty()
    {
        return Some((selector, Vec::new(), action));
    }
    Some((
        if selector.is_empty() {
            "*".into()
        } else {
            selector
        },
        tasks,
        action,
    ))
}

pub fn procedural_json(body: &str) -> Option<String> {
    let (selector, tasks, action) = procedural_tasks(body, 0)?;
    if is_procedural(&selector) {
        return None;
    }
    let mut object = serde_json::Map::new();
    object.insert("selector".into(), selector.into());
    if !tasks.is_empty() {
        object.insert("tasks".into(), Value::Array(tasks));
    }
    if let Some(action) = action {
        object.insert(
            "action".into(),
            Value::Array(action.into_iter().map(Value::String).collect()),
        );
    }
    Some(encode(&Value::Object(object)))
}

fn domains_have_entities(names: &[String]) -> bool {
    names.iter().any(|name| {
        name.ends_with(".*")
            || name.chars().count() < 2
            || !name
                .chars()
                .skip(1)
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
    })
}

fn pure_host(text: &str) -> Option<String> {
    let host = text.strip_prefix("||")?.strip_suffix('^')?;
    (!host.is_empty()
        && host
            .chars()
            .all(|c| c.is_alphanumeric() || c == '.' || c == '-'))
    .then(|| host.to_lowercase())
}

pub fn url_filter_patterns(filter: &str) -> Vec<String> {
    let mut text = filter;
    let mut prefix = "";
    let mut host_anchored = false;
    if let Some(rest) = text.strip_prefix("||") {
        prefix = HOST_ANCHOR;
        text = rest;
        host_anchored = true;
    } else if let Some(rest) = text.strip_prefix('|') {
        prefix = "^";
        text = rest;
    }
    let mut suffix = "";
    if text.ends_with('|') && !text.ends_with("\\|") {
        suffix = "$";
        text = &text[..text.len() - 1];
    }
    let trailing = text.ends_with('^') && suffix.is_empty();
    if trailing {
        text = &text[..text.len() - 1];
    }
    while prefix.is_empty() && text.starts_with('*') {
        text = &text[1..];
    }
    while suffix.is_empty() && !trailing && text.ends_with('*') {
        text = &text[..text.len() - 1];
    }
    let mut body = String::new();
    for ch in text.chars() {
        if ch == '*' {
            body.push_str(".*");
        } else if ch == '^' {
            body.push_str(SEPARATOR);
        } else if REGEX_SPECIALS.contains(ch) {
            body.push('\\');
            body.push(ch);
        } else {
            body.push(ch);
        }
    }
    let core = format!("{prefix}{body}");
    if trailing {
        let host_only = host_anchored
            && text
                .chars()
                .all(|c| c.is_alphanumeric() || c == '.' || c == '-');
        return if host_only {
            vec![format!("{core}{SEPARATOR}")]
        } else {
            vec![format!("{core}{SEPARATOR}"), format!("{core}$")]
        };
    }
    let pattern = format!("{core}{suffix}");
    vec![if pattern.is_empty() {
        ".*".into()
    } else {
        pattern
    }]
}

fn hosts_line(line: &str) -> Option<String> {
    let rest = line
        .strip_prefix("0.0.0.0")
        .or_else(|| line.strip_prefix("127.0.0.1"))?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let host = rest.trim_start();
    (!host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-'))
    .then(|| format!("||{host}^"))
}

fn network(
    line: &str,
    strict: &mut BTreeSet<String>,
    strict_allow: &mut BTreeSet<String>,
) -> Option<Vec<SavedRule>> {
    let converted = if line.starts_with('0') || line.starts_with('1') {
        hosts_line(line)
    } else {
        None
    };
    let mut text: &str = converted.as_deref().unwrap_or(line);
    let exception = text.starts_with("@@");
    if exception {
        text = &text[2..];
    }
    let mut options: Vec<&str> = Vec::new();
    if (!text.starts_with('/') || !text.ends_with('/'))
        && let Some(dollar) = text.rfind('$')
        && dollar != 0
    {
        options = text[dollar + 1..]
            .split(',')
            .filter(|o| !o.is_empty())
            .collect();
        text = &text[..dollar];
    }
    if (text.starts_with('/') && text.len() >= 2 && text.ends_with('/')) || !text.is_ascii() {
        return None;
    }
    let mut types: Vec<&str> = Vec::new();
    let (mut frames, mut document, mut important, mut case_sensitive) =
        (false, false, false, false);
    let mut load_type: Option<&str> = None;
    let mut if_domains: Vec<String> = Vec::new();
    let mut unless_domains: Vec<String> = Vec::new();
    for option in &options {
        let name = option.to_lowercase();
        match name.as_str() {
            "third-party" | "3p" => load_type = Some("third-party"),
            "~third-party" | "1p" | "first-party" | "~3p" => load_type = Some("first-party"),
            "important" => important = true,
            "match-case" => case_sensitive = true,
            "all" => document = true,
            other => {
                if let Some(mapped) = simple_type(other) {
                    types.push(mapped);
                } else if matches!(other, "subdocument" | "frame") {
                    frames = true;
                } else if matches!(other, "document" | "doc") {
                    document = true;
                } else if other.starts_with("domain=") || other.starts_with("from=") {
                    let list = other.split_once('=').map(|(_, v)| v).unwrap_or_default();
                    for domain in list.split('|').filter(|d| !d.is_empty()) {
                        match domain.strip_prefix('~') {
                            Some(rest) => unless_domains.push(format!("*{rest}")),
                            None => if_domains.push(format!("*{domain}")),
                        }
                    }
                    let all: Vec<String> =
                        if_domains.iter().chain(&unless_domains).cloned().collect();
                    if domains_have_entities(&all) {
                        return None;
                    }
                } else {
                    return None;
                }
            }
        }
    }
    if !if_domains.is_empty() && !unless_domains.is_empty() {
        return None;
    }
    let host = pure_host(text);
    if (document || (host.is_some() && options.is_empty()))
        && let Some(host) = &host
        && if_domains.is_empty()
        && unless_domains.is_empty()
    {
        if exception {
            strict_allow.insert(host.clone());
        } else {
            strict.insert(host.clone());
        }
    }
    if document && types.is_empty() && !frames {
        return (host.is_some() && if_domains.is_empty() && unless_domains.is_empty())
            .then(Vec::new);
    }
    let patterns = url_filter_patterns(text);
    if patterns.is_empty() {
        return None;
    }
    let simple: Vec<&str> = types
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut groups: Vec<serde_json::Map<String, Value>> = Vec::new();
    if !simple.is_empty() || (!frames && types.is_empty()) {
        let mut group = serde_json::Map::new();
        if !simple.is_empty() {
            group.insert(
                "resource-type".into(),
                simple.iter().map(|s| Value::from(*s)).collect(),
            );
        }
        groups.push(group);
    }
    if frames {
        let mut group = serde_json::Map::new();
        group.insert("resource-type".into(), Value::from(vec!["document"]));
        group.insert("load-context".into(), Value::from(vec!["child-frame"]));
        groups.push(group);
    }
    let priority = if exception {
        30
    } else if important {
        40
    } else {
        10
    };
    let mut out = Vec::new();
    for pattern in &patterns {
        for group in &groups {
            let mut trigger = serde_json::Map::new();
            trigger.insert("url-filter".into(), Value::from(pattern.as_str()));
            for (k, v) in group {
                trigger.entry(k.clone()).or_insert_with(|| v.clone());
            }
            if case_sensitive {
                trigger.insert("url-filter-is-case-sensitive".into(), Value::Bool(true));
            }
            if let Some(load_type) = load_type {
                trigger.insert("load-type".into(), Value::from(vec![load_type]));
            }
            if !if_domains.is_empty() {
                trigger.insert("if-domain".into(), Value::from(if_domains.clone()));
            }
            if !unless_domains.is_empty() {
                trigger.insert("unless-domain".into(), Value::from(unless_domains.clone()));
            }
            let kind = if exception {
                "ignore-previous-rules"
            } else {
                "block"
            };
            let rule = serde_json::json!({ "trigger": Value::Object(trigger), "action": { "type": kind } });
            out.push(SavedRule {
                priority,
                exception,
                json: encode(&rule),
            });
        }
    }
    Some(out)
}

pub fn parse(text: &str) -> UserFilters {
    let mut out = UserFilters {
        digest: digest_of(text),
        ..UserFilters::default()
    };
    let mut hide: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut unhide: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut strict = BTreeSet::new();
    let mut strict_allow = BTreeSet::new();
    for raw in text.split(['\n', '\r']) {
        let line = raw.trim_matches([' ', '\t']);
        if line.is_empty()
            || line.starts_with('!')
            || line.starts_with('[')
            || line.starts_with("# ")
            || line == "#"
        {
            continue;
        }
        if let Some(cosmetic) = cosmetic_parts(line) {
            if !cosmetic.ok {
                out.rejected += 1;
                continue;
            }
            out.accepted += 1;
            let hosts = if cosmetic.hosts.is_empty() {
                vec!["*".to_owned()]
            } else {
                cosmetic.hosts.clone()
            };
            if cosmetic.exception {
                for host in hosts {
                    unhide
                        .entry(host)
                        .or_default()
                        .insert(cosmetic.body.clone());
                }
                continue;
            }
            let entry = if is_procedural(&cosmetic.body) {
                procedural_json(&cosmetic.body)
            } else if cosmetic.body.contains(['{', '}']) {
                None
            } else {
                Some(cosmetic.body)
            };
            let Some(entry) = entry else {
                out.accepted -= 1;
                out.rejected += 1;
                continue;
            };
            for host in hosts {
                hide.entry(host).or_default().insert(entry.clone());
            }
            continue;
        }
        match network(line, &mut strict, &mut strict_allow) {
            Some(rules) => {
                out.accepted += 1;
                out.network.extend(rules);
            }
            None => out.rejected += 1,
        }
    }
    out.hide = hide
        .into_iter()
        .map(|(k, v)| (k, v.into_iter().collect()))
        .collect();
    out.unhide = unhide
        .into_iter()
        .map(|(k, v)| (k, v.into_iter().collect()))
        .collect();
    out.strict_hosts = strict.into_iter().collect();
    out.strict_allow_hosts = strict_allow.into_iter().collect();
    out
}

impl UserFilters {
    pub fn network_rules(&self, left_out: &BTreeSet<String>) -> Vec<NetworkRule> {
        self.network
            .iter()
            .filter(|rule| !left_out.contains(&rule.json))
            .map(|rule| NetworkRule {
                priority: rule.priority,
                exception: rule.exception,
                json: rule.json.clone(),
            })
            .collect()
    }
}

pub fn user_key(
    filters: &UserFilters,
    rejected: Option<&RejectedUserFilters>,
) -> (Option<String>, Vec<NetworkRule>) {
    let left: BTreeSet<String> = rejected
        .filter(|r| r.digest == filters.digest)
        .and_then(|r| r.rules.clone())
        .unwrap_or_default()
        .into_iter()
        .collect();
    let rules = filters.network_rules(&left);
    if rules.is_empty() {
        return (None, rules);
    }
    let digest = if left.is_empty() {
        filters.digest.clone()
    } else {
        format!("{}-{}", filters.digest, left.len())
    };
    (Some(digest), rules)
}

pub fn rejection_message(
    filters: &UserFilters,
    rejected: Option<&RejectedUserFilters>,
) -> Option<String> {
    let rejected = rejected.filter(|r| r.digest == filters.digest)?;
    if filters.network.is_empty() {
        return None;
    }
    let left = rejected.rules.as_ref().map_or(0, Vec::len);
    if left == 0 {
        return None;
    }
    if left >= filters.network.len() {
        return Some(format!(
            "your filters didn't compile, so they're left out: {}",
            rejected.error
        ));
    }
    Some(format!(
        "{left} of your filters didn't compile, so they're left out: {}",
        rejected.error
    ))
}

#[derive(Clone, Debug)]
pub struct Bisect {
    pending: Vec<std::ops::Range<usize>>,
    bad: Vec<usize>,
    attempts: usize,
    limit: usize,
}

impl Bisect {
    pub fn new(count: usize) -> Self {
        let bits = usize::BITS as usize - count.leading_zeros() as usize;
        Bisect {
            pending: if count > 0 {
                std::iter::once(0..count).collect()
            } else {
                Vec::new()
            },
            bad: Vec::new(),
            attempts: 0,
            limit: 8 * bits + 1,
        }
    }

    pub fn next(&self) -> Option<std::ops::Range<usize>> {
        (self.attempts < self.limit)
            .then(|| self.pending.last().cloned())
            .flatten()
    }

    pub fn rejected(&self) -> Vec<usize> {
        let mut all: Vec<usize> = self.bad.clone();
        all.extend(self.pending.iter().flat_map(|r| r.clone()));
        all.sort_unstable();
        all
    }

    pub fn record(&mut self, range: std::ops::Range<usize>, compiled: bool) {
        let Some(index) = self.pending.iter().rposition(|r| *r == range) else {
            return;
        };
        self.attempts += 1;
        self.pending.remove(index);
        if compiled {
            return;
        }
        if range.len() == 1 {
            self.bad.push(range.start);
            return;
        }
        let middle = range.start + range.len() / 2;
        self.pending.push(middle..range.end);
        self.pending.push(range.start..middle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_rules_match_the_old_json() {
        let filters = parse(
            "||ads.example.com^\n@@||good.com^$script\n/banner/*$image,third-party\n0.0.0.0 track.io\n! comment\nbad$unknownoption",
        );
        assert_eq!(filters.rejected, 1);
        assert_eq!(filters.accepted, 4);
        assert_eq!(filters.strict_hosts, vec!["ads.example.com", "track.io"]);
        assert_eq!(
            filters.network[0].json,
            r#"{"action":{"type":"block"},"trigger":{"url-filter":"^[^:]+://+([^:/]+\\.)?ads\\.example\\.com[^a-zA-Z0-9_.%-]"}}"#
        );
        assert!(
            filters
                .network
                .iter()
                .any(|r| r.exception && r.priority == 30)
        );
        let banner = filters
            .network
            .iter()
            .find(|r| r.json.contains("banner"))
            .unwrap();
        assert!(banner.json.contains(r#""load-type":["third-party"]"#));
        assert!(banner.json.contains(r#""resource-type":["image"]"#));
    }

    #[test]
    fn cosmetic_and_procedural_rules_are_kept_per_host() {
        let filters = parse(
            "example.com##.ad\n##.banner\nexample.com#@#.ok\nsite.org##div:has-text(Sponsored)\nx.com##+js(foo)",
        );
        assert_eq!(filters.hide["example.com"], vec![".ad"]);
        assert_eq!(filters.hide["*"], vec![".banner"]);
        assert_eq!(filters.unhide["example.com"], vec![".ok"]);
        assert_eq!(
            filters.hide["site.org"],
            vec![r#"{"selector":"div","tasks":[["has-text","Sponsored"]]}"#]
        );
        assert_eq!(filters.rejected, 1);
    }

    #[test]
    fn digests_keys_and_bisects_follow_the_old_scheme() {
        assert_eq!(digest_of("x").len(), 16);
        let filters = parse("||a.com^\n||b.com^");
        let (digest, rules) = user_key(&filters, None);
        assert_eq!(digest.as_deref(), Some(filters.digest.as_str()));
        assert_eq!(rules.len(), 2);
        let rejected = RejectedUserFilters {
            digest: filters.digest.clone(),
            error: "e".into(),
            rules: Some(vec![filters.network[0].json.clone()]),
        };
        let (digest, rules) = user_key(&filters, Some(&rejected));
        assert_eq!(digest, Some(format!("{}-1", filters.digest)));
        assert_eq!(rules.len(), 1);
        assert_eq!(
            rejection_message(&filters, Some(&rejected)).as_deref(),
            Some("1 of your filters didn't compile, so they're left out: e")
        );
        let mut search = Bisect::new(4);
        while let Some(range) = search.next() {
            let bad = range.contains(&2);
            search.record(range, !bad);
        }
        assert_eq!(search.rejected(), vec![2]);
        assert_eq!(url_filter_patterns("|http://x|"), vec!["^http://x$"]);
    }
}
