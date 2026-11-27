use crate::omnibox::url::{host_of, search_url_for};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchEngine {
    pub id: String,
    pub name: String,
    pub keyword: String,
    pub url: String,
    pub suggest_url: Option<String>,
    pub custom: bool,
    pub extension: Option<(String, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomSearchEngine {
    pub id: String,
    pub name: String,
    pub keyword: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSearchEngine {
    pub profile: String,
    pub extension_id: String,
    pub extension_name: String,
    pub name: String,
    pub keyword: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggest_url: Option<String>,
    pub is_default: bool,
}

const BUILT_IN: [(&str, &str, &str, &str, Option<&str>); 12] = [
    (
        "google",
        "Google",
        "google.com",
        "https://www.google.com/search?q=%s",
        Some("https://www.google.com/complete/search?client=chrome&q=%s"),
    ),
    (
        "bing",
        "Bing",
        "bing.com",
        "https://www.bing.com/search?q=%s",
        Some("https://api.bing.com/osjson.aspx?query=%s"),
    ),
    (
        "duckduckgo",
        "DuckDuckGo",
        "duckduckgo.com",
        "https://duckduckgo.com/?q=%s",
        Some("https://duckduckgo.com/ac/?q=%s&type=list"),
    ),
    (
        "perplexity",
        "Perplexity",
        "perplexity.ai",
        "https://www.perplexity.ai/search?q=%s",
        None,
    ),
    (
        "chatgpt",
        "ChatGPT",
        "chatgpt.com",
        "https://chatgpt.com/?q=%s",
        None,
    ),
    (
        "ecosia",
        "Ecosia",
        "ecosia.org",
        "https://www.ecosia.org/search?q=%s",
        Some("https://ac.ecosia.org/autocomplete?q=%s&type=list"),
    ),
    (
        "brave",
        "Brave Search",
        "search.brave.com",
        "https://search.brave.com/search?q=%s",
        Some("https://search.brave.com/api/suggest?q=%s"),
    ),
    (
        "kagi",
        "Kagi",
        "kagi.com",
        "https://kagi.com/search?q=%s",
        None,
    ),
    (
        "startpage",
        "Startpage",
        "startpage.com",
        "https://www.startpage.com/do/search?q=%s",
        Some("https://www.startpage.com/osuggestions?q=%s"),
    ),
    (
        "yahoo",
        "Yahoo",
        "yahoo.com",
        "https://search.yahoo.com/search?p=%s",
        Some("https://search.yahoo.com/sugg/ff?output=fxjson&command=%s"),
    ),
    (
        "baidu",
        "Baidu",
        "baidu.com",
        "https://www.baidu.com/s?wd=%s",
        Some("https://www.baidu.com/su?action=opensearch&ie=utf-8&wd=%s"),
    ),
    (
        "yandex",
        "Yandex",
        "yandex.com",
        "https://yandex.com/search/?text=%s",
        Some("https://suggest.yandex.com/suggest-ff.cgi?part=%s"),
    ),
];

pub const MAX_SUGGEST_QUERY: usize = 200;
const MAX_SUGGEST_URL: usize = 2048;

pub fn built_in_engines() -> Vec<SearchEngine> {
    BUILT_IN
        .iter()
        .map(|(id, name, keyword, url, suggest)| SearchEngine {
            id: (*id).into(),
            name: (*name).into(),
            keyword: (*keyword).into(),
            url: (*url).into(),
            suggest_url: suggest.map(str::to_owned),
            custom: false,
            extension: None,
        })
        .collect()
}

fn web_prefix(url: &str) -> bool {
    let head = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    let rest = if head.starts_with("https://") {
        &url[8..]
    } else if head.starts_with("http://") {
        &url[7..]
    } else {
        return false;
    };
    rest.chars()
        .next()
        .is_some_and(|c| !c.is_whitespace() && !"/?#".contains(c))
}

pub fn valid_search_template(url: &str) -> bool {
    web_prefix(url) && url.contains("%s")
}

pub fn custom_engines_from(engines: &[CustomSearchEngine]) -> Vec<CustomSearchEngine> {
    engines
        .iter()
        .filter(|e| valid_search_template(&e.url))
        .cloned()
        .collect()
}

pub fn extension_engine_id(extension_id: &str) -> String {
    format!("extension:{extension_id}")
}

pub fn all_engines(
    custom: &[CustomSearchEngine],
    extension: &[ExtensionSearchEngine],
    legacy_custom_url: &str,
) -> Vec<SearchEngine> {
    let mut engines = built_in_engines();
    engines.extend(
        custom_engines_from(custom)
            .into_iter()
            .map(|e| SearchEngine {
                id: e.id,
                name: e.name,
                keyword: e.keyword,
                url: e.url,
                suggest_url: None,
                custom: true,
                extension: None,
            }),
    );
    if valid_search_template(legacy_custom_url) {
        engines.push(SearchEngine {
            id: "custom".into(),
            name: "Custom".into(),
            keyword: "custom".into(),
            url: legacy_custom_url.into(),
            suggest_url: None,
            custom: true,
            extension: None,
        });
    }
    let mut seen = std::collections::HashSet::new();
    for e in extension {
        if !seen.insert(e.extension_id.clone()) {
            continue;
        }
        engines.push(SearchEngine {
            id: extension_engine_id(&e.extension_id),
            name: e.name.clone(),
            keyword: e.keyword.clone(),
            url: e.url.clone(),
            suggest_url: e.suggest_url.clone().filter(|s| !s.is_empty()),
            custom: false,
            extension: Some((e.extension_id.clone(), e.extension_name.clone())),
        });
    }
    engines
}

pub fn engine_by_id(engines: &[SearchEngine], id: &str) -> SearchEngine {
    engines
        .iter()
        .find(|e| e.id == id)
        .or_else(|| engines.first())
        .cloned()
        .unwrap_or_else(|| built_in_engines().remove(0))
}

impl SearchEngine {
    pub fn search_url(&self, query: &str) -> String {
        search_url_for(&self.url, query)
    }

    pub fn host(&self) -> String {
        host_of(&self.url.replace("%s", "q"))
    }

    pub fn suggest_request(&self, query: &str) -> Option<String> {
        let trimmed = query.trim();
        let template = self.suggest_url.as_deref().filter(|_| {
            !self.custom && !trimmed.is_empty() && trimmed.chars().count() <= MAX_SUGGEST_QUERY
        })?;
        Some(search_url_for(template, trimmed)).filter(|u| u.len() <= MAX_SUGGEST_URL)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteSuggestions {
    pub queries: Vec<String>,
    pub sites: Vec<(String, String)>,
}

pub fn parse_remote_suggestions(body: &str) -> RemoteSuggestions {
    let text = body.trim_start().strip_prefix(")]}'").unwrap_or(body);
    let Ok(Value::Array(reply)) = serde_json::from_str::<Value>(text) else {
        return RemoteSuggestions::default();
    };
    let Some(Value::Array(items)) = reply.get(1) else {
        return RemoteSuggestions::default();
    };
    let types = reply
        .get(4)
        .and_then(|e| e.get("google:suggesttype"))
        .and_then(Value::as_array);
    let titles = reply.get(2).and_then(Value::as_array);
    let mut out = RemoteSuggestions::default();
    for (i, item) in items.iter().enumerate() {
        let Some(text) = item.as_str().map(str::trim).filter(|t| !t.is_empty()) else {
            continue;
        };
        let kind = types
            .and_then(|t| t.get(i))
            .and_then(Value::as_str)
            .unwrap_or("");
        match kind {
            "NAVIGATION" | "PERSONALIZED_NAVIGATION" => {
                if text.starts_with("http://") || text.starts_with("https://") {
                    let title = titles
                        .and_then(|t| t.get(i))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_owned();
                    out.sites.push((text.to_owned(), title));
                }
            }
            "CALCULATOR" => {}
            _ => out.queries.push(text.to_owned()),
        }
    }
    out
}

pub fn validate_engine(
    name: &str,
    keyword: &str,
    url: &str,
    engines: &[SearchEngine],
    ignore_id: Option<&str>,
) -> Result<CustomSearchEngine, String> {
    let name = name.trim();
    let keyword = keyword.trim().to_lowercase();
    let url = url.trim();
    if name.is_empty() {
        return Err("Enter a name.".into());
    }
    if keyword.is_empty() {
        return Err("Enter a shortcut.".into());
    }
    if keyword.chars().any(char::is_whitespace) {
        return Err("The shortcut can't contain spaces.".into());
    }
    if !web_prefix(url) {
        return Err("Enter a URL that starts with http:// or https://.".into());
    }
    if !url.contains("%s") {
        return Err("The URL must contain %s where the search terms go.".into());
    }
    if engines
        .iter()
        .any(|e| Some(e.id.as_str()) != ignore_id && e.keyword.to_lowercase() == keyword)
    {
        return Err(format!(
            "“{keyword}” is already used by another search engine."
        ));
    }
    Ok(CustomSearchEngine {
        id: String::new(),
        name: name.into(),
        keyword,
        url: url.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_ins_and_custom_engines_resolve() {
        let custom = vec![CustomSearchEngine {
            id: "e1".into(),
            name: "Docs".into(),
            keyword: "d".into(),
            url: "https://docs.rs/releases/search?query=%s".into(),
        }];
        let broken = vec![CustomSearchEngine {
            id: "e2".into(),
            name: "Bad".into(),
            keyword: "b".into(),
            url: "ftp://x/%s".into(),
        }];
        let engines = all_engines(&[custom, broken].concat(), &[], "");
        assert_eq!(engines.len(), 13);
        assert_eq!(engine_by_id(&engines, "e1").name, "Docs");
        assert_eq!(engine_by_id(&engines, "missing").id, "google");
        assert_eq!(
            engine_by_id(&engines, "google").search_url("a b"),
            "https://www.google.com/search?q=a%20b"
        );
        assert_eq!(
            engine_by_id(&engines, "duckduckgo").host(),
            "duckduckgo.com"
        );
        let legacy = all_engines(&[], &[], "https://s.example/?q=%s");
        assert_eq!(legacy.last().unwrap().id, "custom");
    }

    #[test]
    fn suggest_requests_skip_custom_and_huge_queries() {
        let engines = built_in_engines();
        let google = &engines[0];
        assert!(google.suggest_request("rust").unwrap().contains("q=rust"));
        assert_eq!(google.suggest_request("   "), None);
        assert_eq!(google.suggest_request(&"x".repeat(201)), None);
        assert_eq!(engines[3].suggest_request("x"), None);
    }

    #[test]
    fn remote_replies_split_queries_from_sites() {
        let body = r#")]}'
["ru",["rust","https://www.rust-lang.org/","2+2"],["","Rust",""],[],{"google:suggesttype":["QUERY","NAVIGATION","CALCULATOR"]}]"#;
        let parsed = parse_remote_suggestions(body);
        assert_eq!(parsed.queries, vec!["rust"]);
        assert_eq!(
            parsed.sites,
            vec![("https://www.rust-lang.org/".to_owned(), "Rust".to_owned())]
        );
        assert_eq!(
            parse_remote_suggestions("not json"),
            RemoteSuggestions::default()
        );
        assert_eq!(
            parse_remote_suggestions("[1, 2]"),
            RemoteSuggestions::default()
        );
    }

    #[test]
    fn engine_validation_messages() {
        let engines = built_in_engines();
        assert!(validate_engine("Docs", "d", "https://docs.rs/?q=%s", &engines, None).is_ok());
        assert_eq!(
            validate_engine(" ", "d", "https://x/%s", &engines, None).unwrap_err(),
            "Enter a name."
        );
        assert!(
            validate_engine("G", "google.com", "https://x/?q=%s", &engines, None)
                .unwrap_err()
                .contains("already used")
        );
        assert!(validate_engine("G", "a b", "https://x/?q=%s", &engines, None).is_err());
        assert!(
            validate_engine("G", "g2", "https://x/?q=", &engines, None)
                .unwrap_err()
                .contains("%s")
        );
        assert!(
            validate_engine("G", "g2", "x/?q=%s", &engines, None)
                .unwrap_err()
                .contains("http")
        );
        assert!(valid_search_template("HTTPS://x.example/%s"));
        assert!(!valid_search_template("https:///%s"));
    }
}
