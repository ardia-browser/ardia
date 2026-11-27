use serde_json::{Map, Value};

use super::model::{
    Child, InputBoxOptions, PluginNode, QuickPickItem, QuickPickOptions, Tone, ToolbarBadge,
    ToolbarUpdate,
};
use super::shortcuts::{plugin_shortcut_of, shortcut_text};

pub const DEPTH: usize = 24;
pub const NODES: usize = 2000;
pub const TEXT_BYTES: usize = 256 * 1024;
pub const PROPS: usize = 32;
pub const PROP_BYTES: usize = 16 * 1024;
pub const ITEMS: usize = 500;

struct Budget {
    nodes: usize,
    bytes: usize,
}

fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn is_unsafe(c: char) -> bool {
    matches!(c,
        '\u{0000}'..='\u{0008}'
        | '\u{000b}'
        | '\u{000c}'
        | '\u{000e}'..='\u{001f}'
        | '\u{007f}'
        | '\u{202a}'..='\u{202e}'
        | '\u{2066}'..='\u{2069}')
}

pub fn clean(text: &str) -> String {
    text.chars().filter(|c| !is_unsafe(*c)).collect()
}

fn take_units(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out
}

fn is_node_type(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && text.len() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric())
}

fn is_prop_name(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && text.len() <= 40
        && chars.all(|c| c.is_ascii_alphanumeric())
}

pub fn is_symbol(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.')
}

pub fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

fn prop_value(value: &Value, budget: &mut Budget, depth: usize) -> Result<Value, String> {
    Ok(match value {
        Value::Null | Value::Bool(_) => value.clone(),
        Value::Number(n) => n
            .as_f64()
            .filter(|f| f.is_finite())
            .map_or(Value::Null, |_| value.clone()),
        Value::String(text) => {
            budget.bytes += js_len(text);
            Value::String(clean(text))
        }
        _ if depth > 4 => return Err("has props nested too deep".into()),
        Value::Array(list) => {
            if list.len() > ITEMS {
                return Err(format!("has a prop list over {ITEMS}"));
            }
            Value::Array(
                list.iter()
                    .map(|v| prop_value(v, budget, depth + 1))
                    .collect::<Result<_, _>>()?,
            )
        }
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .take(PROPS)
                .map(|(k, v)| Ok((k.clone(), prop_value(v, budget, depth + 1)?)))
                .collect::<Result<Map<_, _>, String>>()?,
        ),
    })
}

fn node_of(raw: &Value, budget: &mut Budget, depth: usize) -> Result<Child, String> {
    match raw {
        Value::String(text) => {
            budget.bytes += js_len(text);
            return Ok(Child::Text(clean(text)));
        }
        Value::Number(n) => return Ok(Child::Text(js_number(n.as_f64().unwrap_or_default()))),
        _ => {}
    }
    if depth > DEPTH {
        return Err(format!("nests deeper than {DEPTH}"));
    }
    budget.nodes += 1;
    if budget.nodes > NODES {
        return Err(format!("has more than {NODES} nodes"));
    }
    let Value::Object(fields) = raw else {
        return Err("has a node that isn't an object or text".into());
    };
    let kind = fields
        .get("type")
        .and_then(Value::as_str)
        .filter(|t| is_node_type(t))
        .ok_or("has a node whose type isn't a component name")?;
    let given = match fields.get("props") {
        None => Map::new(),
        Some(Value::Object(props)) => props.clone(),
        Some(_) => return Err("has props that aren't an object".into()),
    };
    if given.len() > PROPS {
        return Err(format!("has a node with more than {PROPS} props"));
    }
    let mut props = Map::new();
    for (name, value) in &given {
        if !is_prop_name(name) {
            return Err(format!(
                "has a prop named {}",
                Value::String(take_units(name, 40))
            ));
        }
        if name == "shortcut" {
            if let Some(shortcut) = plugin_shortcut_of(value) {
                props.insert(name.clone(), Value::String(shortcut_text(&shortcut)));
            }
            continue;
        }
        let before = budget.bytes;
        props.insert(name.clone(), prop_value(value, budget, 0)?);
        if budget.bytes - before > PROP_BYTES {
            return Err(format!("has a prop over {} KB", PROP_BYTES / 1024));
        }
    }
    let children = match fields.get("children") {
        None => Vec::new(),
        Some(Value::Array(list)) => list.clone(),
        Some(_) => return Err("has children that aren't a list".into()),
    };
    let key = match fields.get("key") {
        Some(Value::String(key)) => Some(take_units(key, 200)),
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()).map(js_number),
        _ => None,
    };
    let mut node = PluginNode {
        kind: kind.to_owned(),
        key,
        props,
        children: Vec::new(),
    };
    for child in &children {
        if matches!(child, Value::Null | Value::Bool(_)) {
            continue;
        }
        node.children.push(node_of(child, budget, depth + 1)?);
    }
    if budget.bytes > TEXT_BYTES {
        return Err(format!("has over {} KB of text", TEXT_BYTES / 1024));
    }
    Ok(Child::Node(node))
}

pub fn check_plugin_node(raw: &Value) -> Result<PluginNode, String> {
    let mut budget = Budget { nodes: 0, bytes: 0 };
    match node_of(raw, &mut budget, 0)? {
        Child::Node(node) => Ok(node),
        Child::Text(_) => Err("must be a node, not text".into()),
    }
}

fn short_text(value: Option<&Value>, max: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(|s| take_units(&clean(s), max))
}

fn symbol_of(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| is_symbol(s))
        .map(str::to_owned)
}

pub fn quick_pick_items_of(raw: &Value) -> Option<Vec<QuickPickItem>> {
    let list = raw.as_array().filter(|l| l.len() <= ITEMS)?;
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for value in list {
        let fields = value.as_object()?;
        let id = short_text(fields.get("id"), 200)?;
        let title = short_text(fields.get("title"), 200)?;
        if !seen.insert(id.clone()) {
            return None;
        }
        let keywords = fields
            .get("keywords")
            .and_then(Value::as_array)
            .map(|k| {
                k.iter()
                    .filter_map(|k| short_text(Some(k), 40))
                    .take(8)
                    .collect()
            })
            .unwrap_or_default();
        items.push(QuickPickItem {
            id,
            title,
            subtitle: short_text(fields.get("subtitle"), 200),
            icon: symbol_of(fields.get("icon")),
            badge: short_text(fields.get("badge"), 24),
            keywords,
            picked: fields.get("picked") == Some(&Value::Bool(true)),
        });
    }
    Some(items)
}

pub fn quick_pick_options_of(raw: &Value) -> QuickPickOptions {
    QuickPickOptions {
        title: short_text(raw.get("title"), 80),
        placeholder: short_text(raw.get("placeholder"), 120),
        can_pick_many: raw.get("canPickMany") == Some(&Value::Bool(true)),
    }
}

pub fn input_box_options_of(raw: &Value) -> Option<InputBoxOptions> {
    let fields = raw.as_object()?;
    Some(InputBoxOptions {
        title: short_text(fields.get("title"), 80)?,
        message: short_text(fields.get("message"), 400),
        placeholder: short_text(fields.get("placeholder"), 120),
        value: fields
            .get("value")
            .and_then(Value::as_str)
            .map(|v| take_units(&clean(v), 2000)),
        password: fields.get("password") == Some(&Value::Bool(true)),
        confirm_title: short_text(fields.get("confirmTitle"), 30),
    })
}

pub fn toolbar_update_of(raw: &Value) -> Option<ToolbarUpdate> {
    let fields = raw.as_object()?;
    let mut out = ToolbarUpdate::default();
    if let Some(icon) = fields.get("icon") {
        out.icon = Some(symbol_of(Some(icon))?);
    }
    if let Some(label) = fields.get("label") {
        out.label = Some(short_text(Some(label), 24));
    }
    if let Some(tooltip) = fields.get("tooltip") {
        out.tooltip = Some(short_text(Some(tooltip), 120));
    }
    if let Some(badge) = fields.get("badge") {
        out.badge = Some(match badge {
            Value::Null | Value::Bool(false) => None,
            Value::Bool(true) => Some(ToolbarBadge::Dot),
            Value::Number(n) => {
                let n = n.as_f64().filter(|f| f.is_finite())?;
                Some(ToolbarBadge::Count(n.round().clamp(-9999.0, 9999.0) as i64))
            }
            Value::String(text) => Some(ToolbarBadge::Text(take_units(&clean(text), 6))),
            _ => return None,
        });
    }
    if let Some(tone) = fields.get("tone") {
        out.tone = Some(tone.as_str().and_then(Tone::parse)?);
    }
    Some(out)
}

pub fn handler_of(value: Option<&Value>) -> Option<&str> {
    value?.get("__handler")?.as_str()
}

pub fn node_of_value(value: Option<&Value>) -> Option<PluginNode> {
    let value = value?;
    let fields = value.as_object()?;
    fields.get("type")?.as_str()?;
    fields.get("children")?.as_array()?;
    check_plugin_node(value).ok()
}

pub fn str_prop(node: &PluginNode, name: &str) -> Option<String> {
    str_of(node.prop(name))
}

pub fn str_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).map(js_number),
        _ => None,
    }
}

pub fn num_prop(node: &PluginNode, name: &str) -> Option<f64> {
    node.prop(name)?.as_f64().filter(|f| f.is_finite())
}

pub fn bool_prop(node: &PluginNode, name: &str) -> bool {
    node.prop(name) == Some(&Value::Bool(true))
}

pub fn strings_of(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|v| str_of(Some(v))).collect())
        .unwrap_or_default()
}

pub fn records_of(value: Option<&Value>) -> Vec<Map<String, Value>> {
    value
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|v| v.as_object().cloned()).collect())
        .unwrap_or_default()
}

pub fn text_of(children: &[Child]) -> String {
    children
        .iter()
        .map(|child| match child {
            Child::Text(text) => text.clone(),
            Child::Node(node) => text_of(&node.children),
        })
        .collect()
}

pub fn node_key(child: &Child, index: usize) -> String {
    match child {
        Child::Text(_) => format!("t{index}"),
        Child::Node(node) => match &node.key {
            Some(key) => format!("k{key}"),
            None => format!("{}{index}", node.kind),
        },
    }
}

pub fn flatten_nodes(children: &[Child], keep: &dyn Fn(&PluginNode) -> bool) -> Vec<PluginNode> {
    let mut out = Vec::new();
    for child in children {
        let Child::Node(node) = child else {
            continue;
        };
        if keep(node) {
            out.push(node.clone());
        } else if matches!(
            node.kind.as_str(),
            "Fragment" | "ActionPanel" | "ActionPanelSection"
        ) {
            out.extend(flatten_nodes(&node.children, keep));
        }
    }
    out
}

pub fn flatten_node_refs<'a>(
    children: &'a [Child],
    keep: &dyn Fn(&PluginNode) -> bool,
) -> Vec<&'a PluginNode> {
    let mut out = Vec::new();
    for child in children {
        let Child::Node(node) = child else {
            continue;
        };
        if keep(node) {
            out.push(node);
        } else if matches!(
            node.kind.as_str(),
            "Fragment" | "ActionPanel" | "ActionPanelSection"
        ) {
            out.extend(flatten_node_refs(&node.children, keep));
        }
    }
    out
}

pub fn actions_in(panel: Option<&Value>) -> Vec<PluginNode> {
    let Some(panel) = node_of_value(panel) else {
        return Vec::new();
    };
    if panel.kind == "Action" {
        return vec![panel];
    }
    flatten_nodes(&panel.children, &|n| n.kind == "Action")
}

pub struct FuzzyQuery {
    lowered: String,
    needle: Vec<char>,
}

impl FuzzyQuery {
    pub fn new(query: &str) -> Option<Self> {
        let lowered = query.trim().to_lowercase();
        if lowered.is_empty() {
            return None;
        }
        let needle = lowered.chars().collect();
        Some(FuzzyQuery { lowered, needle })
    }

    pub fn score(&self, haystack: &[Option<&str>]) -> u32 {
        let mut best = 0;
        for raw in haystack.iter().flatten() {
            let text = raw.to_lowercase();
            match text.find(&self.lowered) {
                Some(0) => return 100,
                Some(at) => {
                    let at = text[..at].encode_utf16().count() as u32;
                    best = best.max(80 - at.min(40));
                }
                None if best < 20 => {
                    let mut qi = 0;
                    for c in text.chars() {
                        if qi < self.needle.len() && c == self.needle[qi] {
                            qi += 1;
                        }
                    }
                    if qi == self.needle.len() {
                        best = 20;
                    }
                }
                None => {}
            }
        }
        best
    }
}

pub fn fuzzy_score(query: &str, haystack: &[Option<&str>]) -> u32 {
    FuzzyQuery::new(query).map_or(1, |q| q.score(haystack))
}

pub fn fuzzy_rank<T>(
    items: &[T],
    query: &str,
    fields: impl Fn(&T) -> Vec<Option<&str>>,
) -> Vec<usize> {
    let Some(q) = FuzzyQuery::new(query) else {
        return (0..items.len()).collect();
    };
    let mut scored: Vec<(u32, usize)> = items
        .iter()
        .enumerate()
        .map(|(index, item)| (q.score(&fields(item)), index))
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, index)| index).collect()
}

pub fn fuzzy_filter<T: Clone>(
    items: &[T],
    query: &str,
    fields: impl Fn(&T) -> Vec<Option<&str>>,
) -> Vec<T> {
    fuzzy_rank(items, query, fields)
        .into_iter()
        .map(|index| items[index].clone())
        .collect()
}

pub fn is_plugin_path(value: &str) -> bool {
    if value.is_empty()
        || js_len(value) > 1024
        || value.starts_with('/')
        || value.contains('\\')
        || value.contains('\0')
    {
        return false;
    }
    value
        .split('/')
        .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn encode_component(part: &str) -> String {
    let mut out = String::new();
    for byte in part.bytes() {
        let c = byte as char;
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn plugin_file_url(plugin: &str, file: Option<&str>) -> Option<String> {
    let file = file.filter(|f| is_plugin_path(f))?;
    let path: Vec<String> = file.split('/').map(encode_component).collect();
    Some(format!("ardia-plugin://{plugin}/{}", path.join("/")))
}

pub fn is_web_url(value: Option<&Value>) -> Option<&str> {
    let url = value?.as_str()?;
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    ((lower.starts_with("http://") || lower.starts_with("https://")) && js_len(url) <= 4096)
        .then_some(url)
}

pub fn plugin_web_url(raw: &str) -> Option<String> {
    if js_len(raw) > 2048
        || raw
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') || !authority.is_ascii() {
        return None;
    }
    let host = authority
        .rsplit_once(':')
        .map_or(authority, |(host, port)| {
            if !host.starts_with('[') || host.ends_with(']') {
                if port.parse::<u16>().is_ok_and(|p| p > 0) {
                    host
                } else {
                    ""
                }
            } else {
                authority
            }
        });
    if host.is_empty() {
        return None;
    }
    let mut out = String::new();
    for c in raw.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut buffer = [0u8; 4];
            for byte in c.encode_utf8(&mut buffer).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_trees_and_cleans_text() {
        let tree = check_plugin_node(&json!({
            "type": "List",
            "key": 3,
            "props": {"title": "Hi\u{202e}", "shortcut": "cmd+k", "n": 1.5},
            "children": ["a\u{0007}", 2, null, false, {"type": "ListItem", "props": {}, "children": []}]
        }))
        .unwrap();
        assert_eq!(tree.key.as_deref(), Some("3"));
        assert_eq!(tree.props["title"], json!("Hi"));
        assert_eq!(tree.props["shortcut"], json!("cmd+k"));
        assert_eq!(tree.children.len(), 3);
        assert_eq!(tree.children[0], Child::Text("a".into()));
        assert_eq!(tree.children[1], Child::Text("2".into()));
        assert_eq!(
            check_plugin_node(&json!("text")).unwrap_err(),
            "must be a node, not text"
        );
        assert_eq!(
            check_plugin_node(&json!({"type": "lower"})).unwrap_err(),
            "has a node whose type isn't a component name"
        );
        assert_eq!(
            check_plugin_node(&json!({"type": "Box", "props": {"bad-name": 1}})).unwrap_err(),
            "has a prop named \"bad-name\""
        );
        assert_eq!(
            check_plugin_node(&json!({"type": "Box", "children": "x"})).unwrap_err(),
            "has children that aren't a list"
        );
        let mut deep = json!({"type": "Box"});
        for _ in 0..30 {
            deep = json!({"type": "Box", "children": [deep]});
        }
        assert_eq!(
            check_plugin_node(&deep).unwrap_err(),
            "nests deeper than 24"
        );
        let big = "x".repeat(17 * 1024);
        assert_eq!(
            check_plugin_node(&json!({"type": "Text", "props": {"text": big}})).unwrap_err(),
            "has a prop over 16 KB"
        );
    }

    #[test]
    fn parses_quick_pick_input_box_and_toolbar_updates() {
        let items = quick_pick_items_of(&json!([
            {"id": "a", "title": "Alpha", "icon": "star", "keywords": ["x", 3, "y"], "picked": true},
            {"id": "b", "title": "Beta", "icon": "Bad Icon"}
        ]))
        .unwrap();
        assert_eq!(items[0].keywords, vec!["x", "y"]);
        assert!(items[0].picked);
        assert_eq!(items[1].icon, None);
        assert!(
            quick_pick_items_of(&json!([{"id": "a", "title": "A"}, {"id": "a", "title": "B"}]))
                .is_none()
        );
        assert!(quick_pick_items_of(&json!([{"id": "a"}])).is_none());
        assert!(quick_pick_options_of(&json!({"canPickMany": true})).can_pick_many);
        assert!(input_box_options_of(&json!({"message": "m"})).is_none());
        let input =
            input_box_options_of(&json!({"title": "T", "password": true, "value": ""})).unwrap();
        assert!(input.password);
        assert_eq!(input.value.as_deref(), Some(""));
        let update =
            toolbar_update_of(&json!({"badge": 12345.4, "tone": "accent", "label": null})).unwrap();
        assert_eq!(update.badge, Some(Some(ToolbarBadge::Count(9999))));
        assert_eq!(update.tone, Some(Tone::Accent));
        assert_eq!(update.label, Some(None));
        assert!(toolbar_update_of(&json!({"tone": "loud"})).is_none());
        assert!(toolbar_update_of(&json!({"icon": "No"})).is_none());
    }

    #[test]
    fn fuzzy_ranks_prefix_then_contains_then_subsequence() {
        let items = vec!["xbar", "bar", "bxaxr", "zzz"];
        let shown = fuzzy_filter(&items, "bar", |s| vec![Some(*s)]);
        assert_eq!(shown, vec!["bar", "xbar", "bxaxr"]);
        assert_eq!(fuzzy_filter(&items, " ", |s| vec![Some(*s)]).len(), 4);
    }

    #[test]
    fn plugin_files_and_web_urls() {
        assert_eq!(
            plugin_file_url("notes", Some("page/a b.html")).as_deref(),
            Some("ardia-plugin://notes/page/a%20b.html")
        );
        assert!(plugin_file_url("notes", Some("../x")).is_none());
        assert!(plugin_file_url("notes", Some("/abs")).is_none());
        assert!(is_web_url(Some(&json!("HTTPS://a.b"))).is_some());
        assert!(is_web_url(Some(&json!("ftp://a.b"))).is_none());
        assert_eq!(
            plugin_web_url("https://a.b/é").as_deref(),
            Some("https://a.b/%C3%A9")
        );
        assert!(plugin_web_url("https://u@a.b").is_none());
        assert!(plugin_web_url("javascript:alert(1)").is_none());
        assert!(plugin_web_url("https://a.b:0/").is_none());
    }
}
