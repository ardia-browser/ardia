use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value};

const FILE_EXTENSIONS: &str = "json|jsonl|js|mjs|cjs|jsx|ts|tsx|map|bundle|jsbundle|hbc|html?|css|txt|md|rtf|csv|log|ips|plist|xml|ya?ml|pdf|docx?|xlsx?|pptx?|key|pages|numbers|png|jpe?g|gif|webp|heic|svg|ico|icns|mp[34]|m4[av]|mov|avi|mkv|webm|wav|aac|flac|zip|gz|tgz|tar|7z|rar|dmg|pkg|app|crx|xpi|db|sqlite|sqlite3|ldb|sst";

struct Rules {
    tokens: Vec<(Regex, &'static str)>,
    bearer: Regex,
    secret: Regex,
    text: Vec<(Regex, &'static str)>,
    long_token: Regex,
    key: Regex,
    webui_page_key: Regex,
    webui_pages_key: Regex,
    webui_page: Regex,
    webui_pages: Regex,
}

fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|_| Regex::new("$^").expect("empty pattern"))
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let page = "[a-z0-9-]{1,32}(?:/[a-z0-9-]{1,32})?";
        Rules {
            tokens: vec![
                (compile(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"), "<token>"),
                (compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,})"), "<token>"),
                (compile(r"\bsk-(?:ant-|proj-|svcacct-|admin-)?[\w-]{16,}"), "<token>"),
                (compile(r"\b(?:[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,})"), "<token>"),
                (compile(r"\bxox[abposre]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}"), "<token>"),
                (compile(r"\bAIza[\w-]{30,}|\bya29\.[\w-]{20,}|\b1//0[\w-]{20,}"), "<token>"),
                (compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "<token>"),
                (compile(r"\beyJ[\w-]{6,}\.[\w-]{6,}(?:\.[\w-]*)?"), "<token>"),
            ],
            bearer: compile(r"(?i)\b(?:Bearer|Basic|Token)\s+([\w.~+/=-]{8,})"),
            secret: compile(r"(?i)\b((?:pass(?:word|wd|phrase)?|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token)\s*[=:]\s*)([^\s,;&<>]+)"),
            text: vec![
                (compile(r"(?i)\b(?:about|data|blob|javascript|mailto|file|chrome|ardia|chrome-extension|devtools|view-source):\S+"), "<url>"),
                (compile(r#"(?i)\b[a-z][a-z0-9+.-]*://[^\s"'<>)\]}]*"#), "<url>"),
                (compile(r"[\w.%+-]+@[\w-]+(?:\.[\w-]+)+"), "<email>"),
                (compile(r#"(^|[\s(\[{=:,"'])~?/?(?:[^\s/"'<>()\[\]{}]+/)+[^\s"'<>()\[\]{},;]*"#), "${1}<path>"),
                (compile(r"(^|[\s(\[{=:,])~($|[\s)\]},;])"), "${1}<path>${2}"),
                (compile(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"), "<id>"),
                (compile(r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b"), "<ip>"),
                (compile(r"(?i)\[[0-9a-f:]*:[0-9a-f:]*\]"), "<ip>"),
                (compile(&format!(r"(?i)(^|[^\w.<])[\w-]+(?:[\w.-]*)\.(?:{FILE_EXTENSIONS})\b")), "${1}<file>"),
                (compile(r"(?i)\b(?:[a-z0-9-]+\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]+)\b(?::\d+)?"), "<host>"),
                (compile(r"(?i)\b(?:localhost|127\.0\.0\.1)(?::\d+)?\b"), "<host>"),
                (compile(r"\b\d{5,}\b"), "<n>"),
                (compile(r"(?i)\b(?:0x)?[0-9a-f]{12,}\b"), "<hex>"),
            ],
            long_token: compile(r"[A-Za-z0-9+/_-]{32,}={0,2}"),
            key: compile(r"(?i)^\$?[a-z][a-z0-9_]{0,48}$"),
            webui_page_key: compile(r"(?:^|_)webui_page$"),
            webui_pages_key: compile(r"(?:^|_)webui_pages$"),
            webui_page: compile(&format!("^{page}$")),
            webui_pages: compile(&format!(r"^{page}:\d{{1,6}}(?:,{page}:\d{{1,6}}){{0,2}}$")),
        }
    })
}

fn has_digit_or_sign(text: &str, signs: &str) -> bool {
    text.chars()
        .any(|c| c.is_ascii_digit() || signs.contains(c))
}

pub fn scrub_tokens(text: &str) -> String {
    let rules = rules();
    let mut text = text.to_owned();
    for (index, (pattern, placeholder)) in rules.tokens.iter().enumerate() {
        text = pattern.replace_all(&text, *placeholder).into_owned();
        if index == 0 {
            text = rules
                .bearer
                .replace_all(&text, |caps: &Captures| {
                    if has_digit_or_sign(&caps[1], "+/=") {
                        "<token>".to_owned()
                    } else {
                        caps[0].to_owned()
                    }
                })
                .into_owned();
        }
    }
    rules
        .secret
        .replace_all(&text, |caps: &Captures| {
            let value = &caps[2];
            let length = value.chars().count();
            let marked = length >= 6 && has_digit_or_sign(value, "!#$%*+./=?@^_~-");
            if marked || length >= 16 {
                format!("{}<secret>", &caps[1])
            } else {
                caps[0].to_owned()
            }
        })
        .into_owned()
}

const QUOTES: [char; 6] = ['"', '\u{201c}', '\u{201d}', '\u{2018}', '\u{2019}', '`'];

fn until_first_quote(line: &str) -> Option<String> {
    let mut previous: Option<char> = None;
    for (index, character) in line.char_indices() {
        let apostrophe_quote =
            character == '\'' && !previous.is_some_and(|p| p.is_ascii_alphanumeric());
        if QUOTES.contains(&character) || apostrophe_quote {
            return Some(format!("{}<text>", &line[..index]));
        }
        previous = Some(character);
    }
    None
}

fn without_partial_last_word(text: &str) -> String {
    text.char_indices()
        .rev()
        .find(|(_, c)| c.is_whitespace())
        .map_or_else(String::new, |(index, _)| text[..index].to_owned())
}

fn looks_random(text: &str) -> bool {
    text.chars().any(|c| c.is_ascii_digit())
        && text.chars().any(|c| c.is_ascii_uppercase())
        && text.chars().any(|c| c.is_ascii_lowercase())
}

fn take_chars(text: &str, count: usize) -> String {
    text.chars().take(count).collect()
}

pub fn scrub_text(input: &str, max: usize) -> String {
    let rules = rules();
    let first_line = input.split('\n').next().unwrap_or("");
    let first_line = first_line.strip_suffix('\r').unwrap_or(first_line);
    let capped = first_line.chars().count() > max;
    let mut text = if capped {
        take_chars(first_line, max.saturating_sub(1))
    } else {
        first_line.to_owned()
    };
    let before_quote = until_first_quote(&text);
    let ends_at_quote = before_quote.is_some();
    text = match before_quote {
        Some(cut) => cut,
        None if capped => without_partial_last_word(&text),
        None => text,
    };
    text = scrub_tokens(&text);
    for (pattern, placeholder) in &rules.text {
        text = pattern.replace_all(&text, *placeholder).into_owned();
    }
    text = rules
        .long_token
        .replace_all(&text, |caps: &Captures| {
            if looks_random(&caps[0]) {
                "<token>".to_owned()
            } else {
                caps[0].to_owned()
            }
        })
        .into_owned();
    text = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    if text.chars().count() >= max {
        return format!("{}…", take_chars(&text, max.saturating_sub(1)));
    }
    if capped && !ends_at_quote {
        format!("{text}…")
    } else {
        text
    }
}

pub fn valid_key(key: &str) -> bool {
    rules().key.is_match(key)
}

fn scrub_string(key: &str, value: &str) -> String {
    let rules = rules();
    if rules.webui_page_key.is_match(key) && rules.webui_page.is_match(value) {
        return value.to_owned();
    }
    if rules.webui_pages_key.is_match(key) && rules.webui_pages.is_match(value) {
        return value.to_owned();
    }
    scrub_text(value, 64)
}

pub fn clean_properties(props: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in props {
        if !valid_key(key) {
            continue;
        }
        match value {
            Value::Null | Value::Bool(_) => {
                out.insert(key.clone(), value.clone());
            }
            Value::Number(number) => {
                if number.as_f64().is_some_and(f64::is_finite) {
                    out.insert(key.clone(), value.clone());
                }
            }
            Value::String(text) => {
                out.insert(key.clone(), Value::String(scrub_string(key, text)));
            }
            Value::Array(_) | Value::Object(_) => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_loses_urls_paths_ids_and_quoted_titles() {
        let scrubbed = scrub_text(
            r#"Telemetry test error reading /Users/someone/Library/secret.json for "Private Title" at https://private.example/page?q=1"#,
            200,
        );
        assert_eq!(scrubbed, "Telemetry test error reading <path> for <text>");
        assert_eq!(
            scrub_text("failed at https://a.example/x and b@c.io", 200),
            "failed at <url> and <email>"
        );
        assert_eq!(
            scrub_text("id 0bfd5903-d13d-44db-aa99-127354f336d5 10.0.0.1", 200),
            "id <id> <ip>"
        );
        assert_eq!(scrub_text("open config.json now", 200), "open <file> now");
        assert_eq!(
            scrub_text("host api.example.com:443 code 123456", 200),
            "host <host> code <n>"
        );
        assert_eq!(scrub_text("password=hunter2!", 200), "password=<secret>");
        assert_eq!(scrub_text("Bearer abcdefgh1234", 200), "<token>");
        assert_eq!(scrub_text("line one\nline two", 200), "line one");
        assert_eq!(scrub_text("aaaa bbbb cccc", 8), "aaaa…");
        assert_eq!(scrub_text("it's fine", 200), "it's fine");
    }

    #[test]
    fn properties_keep_only_named_scalars() {
        let props = json!({
            "ok": 1, "$session_id": "s", "flag": true, "none": null,
            "Bad Key": 1, "nested": {"a": 1}, "list": [1],
            "nan_free": 1.5, "title": "see https://x.example/y",
            "ctx_webui_page": "settings/general", "ctx_webui_pages": "history:3,settings:1",
            "prev_webui_page": "https://evil.example",
        });
        let cleaned = clean_properties(props.as_object().expect("map"));
        assert_eq!(
            Value::Object(cleaned),
            json!({
                "ok": 1, "$session_id": "s", "flag": true, "none": null, "nan_free": 1.5,
                "title": "see <url>", "ctx_webui_page": "settings/general",
                "ctx_webui_pages": "history:3,settings:1", "prev_webui_page": "<url>",
            })
        );
        assert!(!valid_key(&"k".repeat(60)));
    }
}
