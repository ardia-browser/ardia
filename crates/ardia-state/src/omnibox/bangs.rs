use crate::omnibox::engines::CustomSearchEngine;
use crate::omnibox::url::encode_uri_component;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

const BUNDLED_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/core/src/bangList.ts"
));

pub const PLACEHOLDER: &str = "{searchTerms}";
const STORED_PLACEHOLDER: &str = "{s}";
const MIN_BANGS: usize = 1000;
pub const MAX_BANG_LIST_BYTES: usize = 4_000_000;
const REQUIRED_TRIGGERS: [&str; 3] = ["gh", "w", "yt"];
const DOCUMENT_MAGIC: &str = "ardia-bangs 1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bang {
    pub trigger: String,
    pub name: String,
    pub template: String,
    pub home: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BangMatch {
    pub bang: Bang,
    pub query: String,
    pub url: String,
}

#[derive(Clone, Debug)]
enum Source {
    Slim {
        text: Arc<str>,
        lines: HashMap<Box<str>, u32>,
    },
    Custom(HashMap<String, Bang>),
}

#[derive(Clone, Debug)]
pub struct BangTable(Source);

fn valid_template(template: &str) -> bool {
    let lower = template.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    let Some(rest) = rest else { return false };
    let host_end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        .unwrap_or(rest.len());
    if host_end == 0 {
        return false;
    }
    let mut tail = &rest[host_end..];
    if let Some(port) = tail.strip_prefix(':') {
        let digits = port
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(port.len());
        if digits == 0 {
            return false;
        }
        tail = &port[digits..];
    }
    tail.is_empty() || (tail.starts_with(['/', '?', '#']) && !tail.chars().any(char::is_whitespace))
}

fn expand(stored: &str) -> String {
    let lower = stored.get(..8).unwrap_or(stored).to_ascii_lowercase();
    let full = if lower.starts_with("https://") || lower.starts_with("http://") {
        stored.to_owned()
    } else {
        format!("https://{stored}")
    };
    full.replace(STORED_PLACEHOLDER, PLACEHOLDER)
}

fn home_of(template: &str) -> String {
    let scheme_end = template.find("://").map_or(0, |i| i + 3);
    let host_end = template[scheme_end..]
        .find(['/', '?', '#'])
        .map_or(template.len(), |i| scheme_end + i);
    if host_end > scheme_end {
        format!("{}/", &template[..host_end])
    } else {
        template.to_owned()
    }
}

fn index_lines(text: &str) -> HashMap<Box<str>, u32> {
    let mut lines = HashMap::new();
    let mut at = 0usize;
    for line in text.split('\n') {
        if let Some((triggers, _)) = line.split_once('\t') {
            for trigger in triggers.split(' ').filter(|t| !t.is_empty()) {
                lines.entry(Box::from(trigger)).or_insert(at as u32);
            }
        }
        at += line.len() + 1;
    }
    lines
}

impl BangTable {
    pub fn parse(slim: impl Into<Arc<str>>) -> BangTable {
        let text: Arc<str> = slim.into();
        let lines = index_lines(&text);
        BangTable(Source::Slim { text, lines })
    }

    pub fn checked(slim: &str) -> Option<BangTable> {
        if slim.len() > MAX_BANG_LIST_BYTES {
            return None;
        }
        let mut count = 0usize;
        for line in slim.split('\n') {
            let mut fields = line.split('\t');
            let (Some(triggers), Some(name), Some(stored), None) =
                (fields.next(), fields.next(), fields.next(), fields.next())
            else {
                return None;
            };
            let triggers_ok = !triggers.is_empty()
                && triggers.split(' ').all(|t| {
                    !t.is_empty() && !t.contains('!') && !t.chars().any(char::is_whitespace)
                });
            if !triggers_ok
                || name.is_empty()
                || stored.is_empty()
                || !valid_template(&expand(stored))
            {
                return None;
            }
            count += 1;
        }
        let table = BangTable::parse(slim);
        (count >= MIN_BANGS && REQUIRED_TRIGGERS.iter().all(|t| table.get(t).is_some()))
            .then_some(table)
    }

    pub fn custom(engines: &[CustomSearchEngine]) -> BangTable {
        let bangs = engines
            .iter()
            .filter_map(|e| {
                let trigger = e.keyword.trim().to_lowercase();
                let template = e.url.replace("%s", PLACEHOLDER);
                (!trigger.is_empty() && !trigger.contains(['!', ' ']) && valid_template(&template))
                    .then(|| {
                        let home = home_of(&template);
                        (
                            trigger.clone(),
                            Bang {
                                trigger,
                                name: e.name.clone(),
                                template,
                                home,
                            },
                        )
                    })
            })
            .collect();
        BangTable(Source::Custom(bangs))
    }

    pub fn len(&self) -> usize {
        match &self.0 {
            Source::Slim { lines, .. } => lines.len(),
            Source::Custom(bangs) => bangs.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn get(&self, trigger: &str) -> Option<Bang> {
        let key = trigger.to_lowercase();
        match &self.0 {
            Source::Custom(bangs) => bangs.get(&key).cloned(),
            Source::Slim { text, lines } => {
                let at = *lines.get(key.as_str())? as usize;
                let line = text[at..].split('\n').next()?;
                let mut fields = line.split('\t');
                let (_, name, stored) = (fields.next()?, fields.next()?, fields.next()?);
                let template = expand(stored);
                (!name.is_empty() && valid_template(&template)).then(|| Bang {
                    trigger: key,
                    name: name.to_owned(),
                    home: home_of(&template),
                    template,
                })
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct Bangs(Vec<BangTable>);

fn template_literal(source: &str, name: &str) -> Option<String> {
    let marker = format!("export const {name} = `");
    let start = source.find(&marker)? + marker.len();
    let mut out = String::new();
    let mut chars = source[start..].chars();
    while let Some(c) = chars.next() {
        match c {
            '`' => return Some(out),
            '\\' => out.push(chars.next()?),
            _ => out.push(c),
        }
    }
    None
}

impl Bangs {
    pub fn new(tables: Vec<BangTable>) -> Self {
        Bangs(tables)
    }

    pub fn bundled() -> &'static Bangs {
        static BUNDLED: OnceLock<Bangs> = OnceLock::new();
        BUNDLED.get_or_init(|| {
            let tables = ["BANG_LIST", "BANG_LIST_UNICODE"]
                .iter()
                .filter_map(|name| template_literal(BUNDLED_SOURCE, name))
                .map(BangTable::parse)
                .collect();
            Bangs(tables)
        })
    }

    pub fn from_document(doc: &str) -> Option<(Option<String>, Bangs)> {
        if doc.len() > MAX_BANG_LIST_BYTES + 1024 {
            return None;
        }
        let (first, rest) = doc.split_once('\n')?;
        let mut header = first.split('\t');
        let (Some(magic), etag, None) = (header.next(), header.next(), header.next()) else {
            return None;
        };
        if magic != DOCUMENT_MAGIC {
            return None;
        }
        let table = BangTable::checked(rest)?;
        Some((
            etag.filter(|e| !e.is_empty()).map(str::to_owned),
            Bangs(vec![table]),
        ))
    }

    pub fn document(etag: Option<&str>, slim: &str) -> String {
        format!("{DOCUMENT_MAGIC}\t{}\n{slim}", etag.unwrap_or(""))
    }

    pub fn with_custom(&self, engines: &[CustomSearchEngine]) -> Bangs {
        let mut tables = vec![BangTable::custom(engines)];
        tables.extend(self.0.iter().cloned());
        Bangs(tables)
    }

    pub fn len(&self) -> usize {
        self.0.iter().map(BangTable::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn get(&self, trigger: &str) -> Option<Bang> {
        self.0.iter().find_map(|t| t.get(trigger))
    }

    pub fn find(&self, text: &str) -> Option<BangMatch> {
        if !text.contains('!') || text.trim_start().starts_with('?') {
            return None;
        }
        let words: Vec<&str> = text.split_whitespace().collect();
        let last = words.len().checked_sub(1)?;
        let candidates: &[usize] = if last > 0 { &[0, last] } else { &[0] };
        for &at in candidates {
            let word = words[at];
            let Some(trigger) = word.strip_prefix('!').filter(|t| !t.is_empty()) else {
                continue;
            };
            let Some(bang) = self.get(trigger) else {
                continue;
            };
            let query = words
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != at)
                .map(|(_, w)| *w)
                .collect::<Vec<_>>()
                .join(" ");
            let url = if query.is_empty() {
                bang.home.clone()
            } else {
                fill_template(&bang.template, &query)
            };
            if stays_on_site(&url, &bang.template) {
                return Some(BangMatch { bang, query, url });
            }
        }
        None
    }
}

pub fn might_be_bang(text: &str) -> bool {
    let trimmed = text.trim();
    if !trimmed.contains('!') || trimmed.starts_with('?') {
        return false;
    }
    let is_bang = |w: &str| w.len() > 1 && w.starts_with('!') && !w[1..].contains('!');
    let mut words = trimmed.split_whitespace();
    words.next().is_some_and(is_bang) || trimmed.split_whitespace().next_back().is_some_and(is_bang)
}

fn origin(url: &str) -> Option<(String, String)> {
    let scheme_end = url.find("://")?;
    let scheme = &url[..scheme_end];
    if !scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    {
        return None;
    }
    let rest = &url[scheme_end + 3..];
    let host = &rest[..rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len())];
    Some((scheme.to_ascii_lowercase(), host.to_ascii_lowercase()))
}

pub fn stays_on_site(url: &str, template: &str) -> bool {
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    match (origin(url), origin(template)) {
        (Some(to), Some(from)) => !from.1.is_empty() && to == from,
        _ => false,
    }
}

pub fn escape_search_terms(terms: &str, in_query: bool) -> String {
    if in_query {
        return encode_uri_component(terms).replace("%20", "+");
    }
    let mut out = String::with_capacity(terms.len());
    let mut run = String::new();
    for c in terms.chars() {
        let printable = ('\u{21}'..='\u{7e}').contains(&c);
        if !printable {
            run.push(c);
            continue;
        }
        if !run.is_empty() {
            out.push_str(&encode_uri_component(&run));
            run.clear();
        }
        if "\"#%:<>?[\\]^`{|}".contains(c) {
            out.push_str(&encode_uri_component(&c.to_string()));
        } else {
            out.push(c);
        }
    }
    if !run.is_empty() {
        out.push_str(&encode_uri_component(&run));
    }
    out
}

pub fn fill_template(template: &str, terms: &str) -> String {
    let Some(at) = template.find(PLACEHOLDER) else {
        return template.to_owned();
    };
    let in_query = template.find('?').is_some_and(|q| at > q);
    template.replace(PLACEHOLDER, &escape_search_terms(terms, in_query))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_list_loads_both_tables_with_common_triggers() {
        let bangs = Bangs::bundled();
        assert!(bangs.len() > 10_000, "{}", bangs.len());
        let gh = bangs.get("gh").unwrap();
        assert!(
            gh.template.starts_with("https://github.com"),
            "{}",
            gh.template
        );
        assert!(bangs.get("YT").is_some());
        assert!(bangs.get("w").is_some());
        assert!(bangs.get("g").is_some());
        assert!(bangs.get("hashtag").unwrap().template.contains("\\#"));
        assert!(bangs.get("definitely-not-a-bang").is_none());
    }

    #[test]
    fn bangs_work_as_first_or_last_word() {
        let bangs = Bangs::bundled();
        let first = bangs.find("!gh ardia browser").unwrap();
        assert_eq!(first.query, "ardia browser");
        assert!(
            first.url.starts_with("https://github.com/"),
            "{}",
            first.url
        );
        let last = bangs.find("rust lang !w").unwrap();
        assert_eq!(last.bang.trigger, "w");
        assert!(last.url.contains("search=rust+lang"), "{}", last.url);
        let home = bangs.find("!yt").unwrap();
        assert!(home.query.is_empty() && home.url.ends_with('/'));
        assert!(bangs.find("? !gh x").is_none());
        assert!(bangs.find("hello world").is_none());
        assert!(bangs.find("a !gh b").is_none());
        assert!(
            might_be_bang("!gh x")
                && might_be_bang("x !w")
                && !might_be_bang("a !b c")
                && !might_be_bang("?!gh")
        );
    }

    #[test]
    fn custom_engines_become_bangs_first() {
        let engines = vec![CustomSearchEngine {
            id: "e".into(),
            name: "Docs".into(),
            keyword: "gh".into(),
            url: "https://docs.rs/releases/search?query=%s".into(),
        }];
        let bangs = Bangs::bundled().with_custom(&engines);
        let hit = bangs.find("!gh serde json").unwrap();
        assert_eq!(hit.url, "https://docs.rs/releases/search?query=serde+json");
        assert_eq!(hit.bang.home, "https://docs.rs/");
    }

    #[test]
    fn templates_escape_paths_and_queries_differently() {
        assert_eq!(
            fill_template("https://x.example/{searchTerms}", "a b/c?d"),
            "https://x.example/a%20b/c%3Fd"
        );
        assert_eq!(
            fill_template("https://x.example/s?q={searchTerms}", "a b&c"),
            "https://x.example/s?q=a+b%26c"
        );
        assert_eq!(
            fill_template("https://x.example/", "a"),
            "https://x.example/"
        );
        assert_eq!(escape_search_terms("ü x", false), "%C3%BC%20x");
        assert!(stays_on_site(
            "https://GitHub.com/x",
            "https://github.com/search?q={searchTerms}"
        ));
        assert!(!stays_on_site("https://evil.com/x", "https://github.com/"));
        assert!(!stays_on_site(
            "https://github.com/x y",
            "https://github.com/"
        ));
    }

    #[test]
    fn documents_need_the_header_and_a_full_valid_list() {
        let body: Vec<String> = (0..1000)
            .map(|i| format!("t{i}\tSite {i}\tsite{i}.example/?q={{s}}"))
            .chain([
                "gh\tGitHub\tgithub.com/search?q={s}".into(),
                "w\tWiki\twikipedia.org/?s={s}".into(),
                "yt\tYouTube\twww.youtube.com/results?q={s}".into(),
            ])
            .collect();
        let slim = body.join("\n");
        let doc = Bangs::document(Some("\"etag\""), &slim);
        let (etag, bangs) = Bangs::from_document(&doc).unwrap();
        assert_eq!(etag.as_deref(), Some("\"etag\""));
        assert_eq!(
            bangs.get("t5").unwrap().template,
            "https://site5.example/?q={searchTerms}"
        );
        assert!(Bangs::from_document(&doc.replace("ardia-bangs 1", "other")).is_none());
        assert!(
            Bangs::from_document(&format!("{DOCUMENT_MAGIC}\t\n{}", body[..10].join("\n")))
                .is_none()
        );
        assert!(Bangs::from_document(&format!("{doc}\nbad line")).is_none());
        assert!(BangTable::checked("x\ty\tjavascript:alert(1)").is_none());
    }

    #[test]
    fn hostile_bang_text_never_panics() {
        let bangs = Bangs::bundled();
        for text in [
            "!",
            "!!",
            " ! ",
            "!\u{0}",
            "!gh\u{202e}",
            &"!a ".repeat(5000),
        ] {
            let _ = bangs.find(text);
        }
    }
}
