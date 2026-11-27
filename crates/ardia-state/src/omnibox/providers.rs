use serde_json::Value;

use super::suggest::{CommandAction, Suggestion, match_actions, page_key};
use super::url::{encode_uri_component, host_of};

pub const QUERY_SLOT: &str = "{query}";
pub const MAX_PROVIDERS: usize = 32;
pub const MAX_CONFIG_ROWS: usize = 200;
pub const TITLE_LIMIT: usize = 120;
pub const SUBTITLE_LIMIT: usize = 160;
pub const URL_LIMIT: usize = 4096;
pub const ICON_BYTES: usize = 16_384;
pub const ROWS_PER_PROVIDER: usize = 20;
pub const ROWS_PER_GLOBAL_SECTION: usize = 3;
pub const GLOBAL_ROWS: usize = 6;
pub const PROVIDER_TITLE_LIMIT: usize = 60;
const IMAGE_TYPES: [&str; 6] = ["png", "jpeg", "gif", "webp", "x-icon", "vnd.microsoft.icon"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderRow {
    pub title: String,
    pub url: String,
    pub subtitle: Option<String>,
    pub icon: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginProvider {
    pub id: String,
    pub title: String,
    pub keyword: Option<String>,
    pub global: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSection {
    pub id: String,
    pub title: String,
    pub rows: Vec<ProviderRow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderConfig {
    pub id: String,
    pub title: String,
    pub keyword: Option<String>,
    pub global: bool,
    pub rows: Vec<ProviderRow>,
    pub url: Option<String>,
    pub suggest: Option<String>,
    pub approval_key: String,
}

impl ProviderConfig {
    pub fn needs_approval(&self) -> bool {
        self.global || self.suggest.is_some()
    }
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap_or_default(),
                        canonical(&map[k])
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_owned()),
    }
}

pub fn provider_approval_key(definition: &Value) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(canonical(definition).as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("omnibox-provider:{hex}")
}

const PRIVATE_SUFFIXES: [&str; 8] = [
    ".localhost",
    ".local",
    ".internal",
    ".lan",
    ".home.arpa",
    ".test",
    ".invalid",
    ".onion",
];

pub fn is_public_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    let bare = h.trim_end_matches('.');
    let labels: Vec<&str> = bare.split('.').collect();
    let dns = labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
        && labels
            .last()
            .is_some_and(|tld| tld.starts_with(|c: char| c.is_ascii_alphabetic()));
    dns && bare != "localhost" && !PRIVATE_SUFFIXES.iter().any(|s| bare.ends_with(s))
}

pub fn remote_request_allowed(url: &str) -> bool {
    if provider_url(Some(url)).is_none() || url.chars().any(|c| (c as u32) <= 0x20 || c == '\\') {
        return false;
    }
    let Some(rest) = url
        .get(..8)
        .filter(|p| p.eq_ignore_ascii_case("https://"))
        .map(|_| &url[8..])
    else {
        return false;
    };
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    if authority.contains(['@', '%', '[']) {
        return false;
    }
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if let Some(port) = port {
        let ok = !port.is_empty()
            && port.len() <= 5
            && !port.starts_with('0')
            && port.chars().all(|c| c.is_ascii_digit())
            && port.parse::<u32>().is_ok_and(|p| p <= 65535)
            && port != "443";
        if !ok {
            return false;
        }
    }
    is_public_host(host)
}

pub fn parse_provider_reply(body: &Value, template: Option<&str>) -> Vec<ProviderRow> {
    let Some(list) = body.as_array() else {
        return Vec::new();
    };
    if let (Some(Value::String(_)), Some(Value::Array(texts))) = (list.first(), list.get(1)) {
        let details = list.get(2).and_then(Value::as_array);
        let urls = list.get(3).and_then(Value::as_array);
        return texts
            .iter()
            .enumerate()
            .filter_map(|(i, text)| {
                let text = text.as_str().filter(|t| !t.trim().is_empty())?;
                let given = urls
                    .and_then(|u| u.get(i))
                    .and_then(Value::as_str)
                    .filter(|u| !u.is_empty())
                    .map(str::to_owned);
                let url =
                    given.or_else(|| template.and_then(|t| fill_provider_template(t, text)))?;
                let subtitle = details
                    .and_then(|d| d.get(i))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                Some(ProviderRow {
                    title: text.to_owned(),
                    url,
                    subtitle,
                    icon: None,
                })
            })
            .collect();
    }
    list.iter()
        .filter_map(|row| {
            let r = row.as_object()?;
            Some(ProviderRow {
                title: r
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                url: r.get("url").and_then(Value::as_str)?.to_owned(),
                subtitle: r.get("subtitle").and_then(Value::as_str).map(str::to_owned),
                icon: r.get("icon").and_then(Value::as_str).map(str::to_owned),
            })
        })
        .collect()
}

fn hidden(c: char) -> bool {
    let n = c as u32;
    matches!(n,
        0x0000..=0x001f | 0x007f..=0x009f | 0x00ad | 0x061c | 0x200b..=0x200f
        | 0x2028..=0x202e | 0x2060..=0x206f | 0xfeff | 0xfff9..=0xfffb)
}

pub fn provider_text(value: Option<&str>, max: usize) -> String {
    let Some(value) = value else {
        return String::new();
    };
    let cleaned: String = value
        .chars()
        .map(|c| if hidden(c) { ' ' } else { c })
        .collect();
    let text = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        return text;
    }
    let mut cut: String = text.chars().take(max.saturating_sub(1)).collect();
    cut = cut.trim_end().to_owned();
    cut.push('…');
    cut
}

fn authority_ok(authority: &str) -> bool {
    if authority.is_empty() {
        return false;
    }
    if let Some(rest) = authority.strip_prefix('[') {
        let Some((inside, after)) = rest.split_once(']') else {
            return false;
        };
        let port_ok = after.is_empty()
            || after.strip_prefix(':').is_some_and(|p| {
                (1..=5).contains(&p.len()) && p.chars().all(|c| c.is_ascii_digit())
            });
        return !inside.is_empty()
            && inside
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
            && port_ok;
    }
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    !host.is_empty()
        && !host.contains(['@', '[', ']'])
        && port.is_none_or(|p| (1..=5).contains(&p.len()) && p.chars().all(|c| c.is_ascii_digit()))
}

pub fn provider_url(value: Option<&str>) -> Option<String> {
    let url = value?.trim();
    if url.is_empty()
        || url.len() > URL_LIMIT
        || url.chars().any(|c| c.is_whitespace() || hidden(c))
    {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))?;
    let offset = url.len() - rest.len();
    let tail = &url[offset..];
    let authority = &tail[..tail.find(['/', '?', '#']).unwrap_or(tail.len())];
    authority_ok(authority).then(|| url.to_owned())
}

pub fn provider_icon(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let lower = value.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("data:image/") {
        let (kind, data) = rest.split_once(";base64,")?;
        let valid = value.len() <= ICON_BYTES
            && IMAGE_TYPES.contains(&kind)
            && !data.is_empty()
            && data
                .trim_end_matches('=')
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/');
        return valid.then(|| value.to_owned());
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return provider_url(Some(value));
    }
    None
}

pub fn is_provider_keyword(value: &str) -> bool {
    let count = value.chars().count();
    (1..=32).contains(&count)
        && !value
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '/' | '?' | '#' | ':' | '@' | '.' | '!'))
}

fn is_template(template: &str) -> bool {
    template.contains(QUERY_SLOT)
        && provider_url(Some(&template.replace(QUERY_SLOT, "q"))).is_some()
}

fn is_remote_endpoint(template: &str) -> bool {
    if !template.contains(QUERY_SLOT) {
        return false;
    }
    let sample = template.replace(QUERY_SLOT, "q");
    let lower = sample.to_ascii_lowercase();
    let loopback = ["http://127.0.0.1", "http://localhost", "http://[::1]"]
        .iter()
        .any(|p| lower.starts_with(p));
    provider_url(Some(&sample)).is_some() && (lower.starts_with("https://") || loopback)
}

fn row_from(value: &Value) -> Option<ProviderRow> {
    let row = value.as_object()?;
    if row
        .keys()
        .any(|k| !matches!(k.as_str(), "title" | "url" | "subtitle" | "icon"))
    {
        return None;
    }
    let title = row
        .get("title")?
        .as_str()
        .filter(|t| !t.trim().is_empty())?;
    let url = provider_url(row.get("url").and_then(Value::as_str))?;
    let subtitle = match row.get("subtitle") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return None,
    };
    let icon = match row.get("icon") {
        None | Some(Value::Null) => None,
        Some(v) => Some(provider_icon(v.as_str())?),
    };
    Some(ProviderRow {
        title: title.to_owned(),
        url,
        subtitle,
        icon,
    })
}

fn entry_title(entry: &serde_json::Map<String, Value>) -> String {
    if let Some(title) = entry.get("title").and_then(Value::as_str) {
        return title.trim().to_owned();
    }
    let template = entry
        .get("url")
        .or_else(|| entry.get("suggest"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let host = host_of(&template.replace(QUERY_SLOT, "q"));
    if !host.is_empty() {
        return host;
    }
    entry
        .get("keyword")
        .and_then(Value::as_str)
        .map_or_else(|| "Links".to_owned(), str::to_owned)
}

fn valid_entry(entry: &serde_json::Map<String, Value>) -> Option<ProviderConfig> {
    let known = ["keyword", "title", "global", "rows", "url", "suggest"];
    if entry.keys().any(|k| !known.contains(&k.as_str())) {
        return None;
    }
    let keyword = match entry.get("keyword") {
        None => None,
        Some(Value::String(k)) if is_provider_keyword(k) => Some(k.to_lowercase()),
        Some(_) => return None,
    };
    if let Some(title) = entry.get("title") {
        let t = title.as_str()?;
        if t.trim().is_empty() || t.chars().count() > PROVIDER_TITLE_LIMIT {
            return None;
        }
    }
    let global = match entry.get("global") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return None,
    };
    if global && keyword.is_some() {
        return None;
    }
    let url = match entry.get("url") {
        None => None,
        Some(v) => Some(v.as_str().filter(|u| is_template(u))?.to_owned()),
    };
    if url.is_some() && keyword.is_none() {
        return None;
    }
    let suggest = match entry.get("suggest") {
        None => None,
        Some(v) => Some(v.as_str().filter(|u| is_remote_endpoint(u))?.to_owned()),
    };
    if suggest.is_some() && keyword.is_none() && !global {
        return None;
    }
    let rows = match entry.get("rows") {
        None => None,
        Some(Value::Array(rows)) => Some(
            rows.iter()
                .take(MAX_CONFIG_ROWS)
                .filter_map(row_from)
                .collect::<Vec<_>>(),
        ),
        Some(_) => return None,
    };
    if rows.is_none() && url.is_none() && suggest.is_none() {
        return None;
    }
    if rows.as_ref().is_some_and(Vec::is_empty) && url.is_none() && suggest.is_none() {
        return None;
    }
    Some(ProviderConfig {
        id: String::new(),
        title: entry_title(entry),
        global: keyword.is_none(),
        keyword,
        rows: rows.unwrap_or_default(),
        url,
        suggest,
        approval_key: provider_approval_key(&Value::Object(entry.clone())),
    })
}

pub fn provider_configs(value: &Value) -> Vec<ProviderConfig> {
    let Some(list) = value.as_array() else {
        return Vec::new();
    };
    let mut out: Vec<ProviderConfig> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for item in list {
        if out.len() >= MAX_PROVIDERS {
            break;
        }
        let Some(mut config) = item.as_object().and_then(valid_entry) else {
            continue;
        };
        if let Some(keyword) = &config.keyword
            && out.iter().any(|c| c.keyword.as_ref() == Some(keyword))
        {
            continue;
        }
        let base = config
            .keyword
            .clone()
            .unwrap_or_else(|| config.title.to_lowercase());
        let mut id = format!("config:{base}");
        let mut n = 2;
        while ids.contains(&id) {
            id = format!("config:{base}:{n}");
            n += 1;
        }
        ids.push(id.clone());
        config.id = id;
        out.push(config);
    }
    out
}

pub fn match_provider_rows(rows: &[ProviderRow], text: &str) -> Vec<ProviderRow> {
    let lower = text.trim().to_lowercase();
    let tokens: Vec<&str> = lower.split_whitespace().collect();
    if tokens.is_empty() {
        return rows.to_vec();
    }
    let mut scored: Vec<(&ProviderRow, u8, usize)> = Vec::new();
    for (at, row) in rows.iter().enumerate() {
        let title = row.title.to_lowercase();
        let haystack = format!(
            "{title} {} {}",
            row.subtitle.as_deref().unwrap_or("").to_lowercase(),
            row.url.to_lowercase()
        );
        if !tokens.iter().all(|t| haystack.contains(t)) {
            continue;
        }
        let first = tokens[0];
        let at_word = title.match_indices(first).any(|(i, _)| {
            i == 0
                || !title[..i]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        });
        let score = if title.starts_with(first) {
            3
        } else if at_word {
            2
        } else {
            1
        };
        scored.push((row, score, at));
    }
    scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)));
    scored.into_iter().map(|(row, _, _)| row.clone()).collect()
}

pub fn safe_provider_rows(
    id: &str,
    title: &str,
    rows: &[ProviderRow],
    limit: usize,
) -> Vec<Suggestion> {
    let provider = provider_text(Some(title), PROVIDER_TITLE_LIMIT);
    let mut out = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for row in rows {
        if out.len() >= limit {
            break;
        }
        let Some(url) = provider_url(Some(&row.url)) else {
            continue;
        };
        let key = page_key(&url);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let shown = provider_text(Some(&row.title), TITLE_LIMIT);
        let title = if shown.is_empty() {
            url.chars().take(TITLE_LIMIT).collect()
        } else {
            shown
        };
        let subtitle = provider_text(row.subtitle.as_deref(), SUBTITLE_LIMIT);
        out.push(Suggestion::Provider {
            provider_id: id.to_owned(),
            provider: provider.clone(),
            title,
            url,
            subtitle: (!subtitle.is_empty()).then_some(subtitle),
            icon: provider_icon(row.icon.as_deref()),
        });
    }
    out
}

pub fn global_provider_rows(sections: &[ProviderSection], shown: &[Suggestion]) -> Vec<Suggestion> {
    let mut taken: Vec<String> = shown
        .iter()
        .filter(|s| !matches!(s, Suggestion::Search { .. }))
        .filter_map(|s| s.url().map(page_key))
        .collect();
    let mut out = Vec::new();
    for section in sections {
        let mut in_section = 0;
        for row in safe_provider_rows(
            &section.id,
            &section.title,
            &section.rows,
            ROWS_PER_PROVIDER,
        ) {
            if out.len() >= GLOBAL_ROWS || in_section >= ROWS_PER_GLOBAL_SECTION {
                break;
            }
            let Some(key) = row.url().map(page_key) else {
                continue;
            };
            if taken.contains(&key) {
                continue;
            }
            taken.push(key);
            out.push(row);
            in_section += 1;
        }
    }
    out
}

pub fn fill_provider_template(template: &str, query: &str) -> Option<String> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }
    provider_url(Some(
        &template.replace(QUERY_SLOT, &encode_uri_component(q)),
    ))
}

pub fn provider_scope_rows(
    query: &str,
    provider_id: &str,
    name: &str,
    template: Option<&str>,
    sections: &[ProviderSection],
    limit: usize,
) -> Vec<Suggestion> {
    let mut items = Vec::new();
    if let Some(template) = template.filter(|_| !query.is_empty())
        && let Some(url) = provider_url(Some(&super::url::search_url_for(
            &template.replace(QUERY_SLOT, "%s"),
            query,
        )))
    {
        items.push(Suggestion::Provider {
            provider_id: provider_id.to_owned(),
            provider: name.to_owned(),
            title: query.to_owned(),
            url,
            subtitle: None,
            icon: None,
        });
    }
    if let Some(section) = sections.iter().find(|s| s.id == provider_id) {
        for row in safe_provider_rows(provider_id, name, &section.rows, limit) {
            let fresh = !items.iter().any(|i| i.url() == row.url());
            if fresh && items.len() < limit {
                items.push(row);
            }
        }
    }
    items
}

pub fn config_sections(
    configs: &[ProviderConfig],
    text: &str,
    scoped: Option<&str>,
) -> Vec<ProviderSection> {
    let query = text.trim();
    configs
        .iter()
        .filter(|c| match scoped {
            Some(id) => c.id == id,
            None => c.global && !query.is_empty() && !query.starts_with('?'),
        })
        .map(|c| ProviderSection {
            id: c.id.clone(),
            title: c.title.clone(),
            rows: if c.global && query.is_empty() {
                Vec::new()
            } else {
                match_provider_rows(&c.rows, text)
            },
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionCandidate {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub action: bool,
    pub options: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtensionOpen {
    Action,
    Options,
}

const EXTENSION_MIN_PARTIAL: usize = 3;
const EXTENSION_MIN_SCORE: f64 = 50.0;

pub fn extension_suggestions(
    query: &str,
    extensions: &[ExtensionCandidate],
    limit: usize,
) -> (Vec<Suggestion>, bool) {
    if extensions.is_empty() {
        return (Vec::new(), false);
    }
    let q = query.trim();
    let actions: Vec<CommandAction> = extensions
        .iter()
        .map(|x| CommandAction {
            id: x.id.clone(),
            title: x.title.clone(),
            keywords: Vec::new(),
            hint: None,
        })
        .collect();
    let matches: Vec<_> = match_actions(q, &actions, limit)
        .into_iter()
        .filter(|(_, score, exact)| {
            *exact || (q.chars().count() >= EXTENSION_MIN_PARTIAL && *score >= EXTENSION_MIN_SCORE)
        })
        .collect();
    let Some(first_exact) = matches.first().map(|m| m.2) else {
        return (Vec::new(), false);
    };
    let mut rows = Vec::new();
    for (i, (action, _, _)) in matches.iter().enumerate() {
        let Some(x) = extensions.iter().find(|x| x.id == action.id) else {
            continue;
        };
        let row = |open| Suggestion::Extension {
            id: x.id.clone(),
            title: x.title.clone(),
            icon: x.icon.clone(),
            open,
        };
        if x.action {
            rows.push(row(ExtensionOpen::Action));
        }
        if x.options && (i == 0 || !x.action) {
            rows.push(row(ExtensionOpen::Options));
        }
    }
    let exact = !rows.is_empty() && first_exact;
    (rows, exact)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn config_entries_are_checked_like_the_old_reader() {
        let configs = provider_configs(&json!([
            { "keyword": "Docs", "url": "https://docs.example/search?q={query}", "rows": [{ "title": "Guide", "url": "https://docs.example/guide" }] },
            { "global": true, "rows": [{ "title": "Team wiki", "url": "https://wiki.example/" }] },
            { "keyword": "docs", "rows": [{ "title": "dup", "url": "https://x.example/" }] },
            { "keyword": "bad key", "rows": [{ "title": "x", "url": "https://x.example/" }] },
            { "url": "https://x.example/{query}" },
            { "keyword": "x", "rows": [{ "title": "x", "url": "javascript:alert(1)" }] }
        ]));
        assert_eq!(configs.len(), 2);
        assert_eq!(configs[0].id, "config:docs");
        assert_eq!(configs[0].keyword.as_deref(), Some("docs"));
        assert_eq!(configs[1].id, "config:links");
        assert!(configs[1].needs_approval());
        assert!(configs[0].approval_key.starts_with("omnibox-provider:"));
        assert_eq!(
            provider_approval_key(&json!({ "b": 1, "a": [true, "x"] })),
            provider_approval_key(&json!({ "a": [true, "x"], "b": 1 }))
        );
        assert!(remote_request_allowed("https://api.example.com/s?q=a"));
        assert!(!remote_request_allowed("http://api.example.com/s?q=a"));
        assert!(!remote_request_allowed("https://localhost/s"));
        assert!(!remote_request_allowed("https://box.local/s"));
        let reply = parse_provider_reply(
            &json!([
                "a",
                ["alpha", "beta"],
                ["first", ""],
                ["https://x.example/a", ""]
            ]),
            Some("https://x.example/?q={query}"),
        );
        assert_eq!(reply.len(), 2);
        assert_eq!(reply[1].url, "https://x.example/?q=beta");
        assert_eq!(reply[0].subtitle.as_deref(), Some("first"));
        assert!(configs[1].global);
    }

    #[test]
    fn rows_are_sanitized_matched_and_capped() {
        assert_eq!(provider_text(Some("  a\u{200b}b \n c "), 10), "a b c");
        assert_eq!(
            provider_url(Some("https://ok.example/x")).as_deref(),
            Some("https://ok.example/x")
        );
        assert_eq!(provider_url(Some("https://user@ok.example/")), None);
        assert_eq!(provider_url(Some("ftp://x/")), None);
        assert!(provider_icon(Some("data:image/png;base64,AAAA")).is_some());
        assert!(provider_icon(Some("data:text/html;base64,AAAA")).is_none());
        let rows = vec![
            ProviderRow {
                title: "Zeta guide".into(),
                url: "https://a.example/1".into(),
                subtitle: None,
                icon: None,
            },
            ProviderRow {
                title: "Guide".into(),
                url: "https://a.example/2".into(),
                subtitle: None,
                icon: None,
            },
        ];
        let matched = match_provider_rows(&rows, "guide");
        assert_eq!(matched[0].title, "Guide");
        let section = ProviderSection {
            id: "config:x".into(),
            title: "X".into(),
            rows,
        };
        let shown = global_provider_rows(std::slice::from_ref(&section), &[]);
        assert_eq!(shown.len(), 2);
        assert_eq!(
            fill_provider_template("https://s.example/?q={query}", "a b").as_deref(),
            Some("https://s.example/?q=a%20b")
        );
    }

    #[test]
    fn extensions_match_by_name_and_offer_action_then_options() {
        let list = vec![ExtensionCandidate {
            id: "ub".into(),
            title: "uBlock Origin".into(),
            icon: None,
            action: true,
            options: true,
        }];
        let (rows, exact) = extension_suggestions("ublock origin", &list, 2);
        assert!(exact);
        assert_eq!(rows.len(), 2);
        assert!(matches!(
            rows[1],
            Suggestion::Extension {
                open: ExtensionOpen::Options,
                ..
            }
        ));
        assert!(extension_suggestions("ub", &list, 2).0.is_empty());
    }
}
