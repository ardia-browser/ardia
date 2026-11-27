use super::engines::SearchEngine;
use super::url::{host_of, search_url_for};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SiteSearch {
    pub host: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    pub keyword: Option<&'static str>,
}

const fn site(host: &'static str, name: &'static str, url: &'static str) -> SiteSearch {
    SiteSearch {
        host,
        name,
        url,
        keyword: None,
    }
}

const fn keyed(
    host: &'static str,
    name: &'static str,
    url: &'static str,
    keyword: &'static str,
) -> SiteSearch {
    SiteSearch {
        host,
        name,
        url,
        keyword: Some(keyword),
    }
}

pub const POPULAR_SITE_SEARCHES: &[SiteSearch] = &[
    site(
        "youtube.com",
        "YouTube",
        "https://www.youtube.com/results?search_query=%s",
    ),
    site(
        "wikipedia.org",
        "Wikipedia",
        "https://en.wikipedia.org/w/index.php?search=%s",
    ),
    site("github.com", "GitHub", "https://github.com/search?q=%s"),
    site("amazon.com", "Amazon", "https://www.amazon.com/s?k=%s"),
    site(
        "reddit.com",
        "Reddit",
        "https://www.reddit.com/search/?q=%s",
    ),
    site("x.com", "X", "https://x.com/search?q=%s"),
    site("twitter.com", "X", "https://x.com/search?q=%s"),
    site(
        "stackoverflow.com",
        "Stack Overflow",
        "https://stackoverflow.com/search?q=%s",
    ),
    site("npmjs.com", "npm", "https://www.npmjs.com/search?q=%s"),
    keyed(
        "maps.google.com",
        "Google Maps",
        "https://www.google.com/maps/search/%s",
        "maps",
    ),
    keyed(
        "drive.google.com",
        "Google Drive",
        "https://drive.google.com/drive/search?q=%s",
        "drive",
    ),
    keyed(
        "mail.google.com",
        "Gmail",
        "https://mail.google.com/mail/u/0/#search/%s",
        "gmail",
    ),
    site("imdb.com", "IMDb", "https://www.imdb.com/find/?q=%s"),
    site(
        "open.spotify.com",
        "Spotify",
        "https://open.spotify.com/search/%s",
    ),
    site(
        "linkedin.com",
        "LinkedIn",
        "https://www.linkedin.com/search/results/all/?keywords=%s",
    ),
    site(
        "ebay.com",
        "eBay",
        "https://www.ebay.com/sch/i.html?_nkw=%s",
    ),
    site(
        "pinterest.com",
        "Pinterest",
        "https://www.pinterest.com/search/pins/?q=%s",
    ),
    site(
        "news.ycombinator.com",
        "Hacker News",
        "https://hn.algolia.com/?q=%s",
    ),
    site(
        "developer.mozilla.org",
        "MDN",
        "https://developer.mozilla.org/en-US/search?q=%s",
    ),
    site(
        "figma.com",
        "Figma",
        "https://www.figma.com/files/search?q=%s",
    ),
    site("notion.so", "Notion", "https://www.notion.so/search?q=%s"),
    site(
        "apps.apple.com",
        "App Store",
        "https://www.apple.com/us/search/%s?src=serp",
    ),
    keyed(
        "translate.google.com",
        "Google Translate",
        "https://translate.google.com/?text=%s",
        "translate",
    ),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeKind {
    Engine,
    Site,
    History,
    Provider,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchScope {
    pub kind: ScopeKind,
    pub name: String,
    pub host: String,
    pub url: String,
    pub engine_id: Option<String>,
    pub provider_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeywordProvider {
    pub id: String,
    pub title: String,
    pub keyword: String,
    pub host: String,
    pub url: String,
}

pub struct ScopeSources<'a> {
    pub engines: &'a [SearchEngine],
    pub hosts: &'a [String],
    pub providers: &'a [KeywordProvider],
}

pub fn provider_scope(text: &str, providers: &[KeywordProvider]) -> Option<SearchScope> {
    let t = text.trim().to_lowercase();
    if t.is_empty() || t.chars().any(char::is_whitespace) {
        return None;
    }
    providers
        .iter()
        .find(|p| p.keyword.to_lowercase() == t)
        .map(|p| SearchScope {
            kind: ScopeKind::Provider,
            name: p.title.clone(),
            host: p.host.clone(),
            url: p.url.clone(),
            engine_id: None,
            provider_id: Some(p.id.clone()),
        })
}

fn normalize(text: &str) -> String {
    let lower = text.trim().to_lowercase();
    let without_scheme = match lower.find("://") {
        Some(at) if lower[..at].chars().all(|c| c.is_ascii_lowercase()) && at > 0 => {
            lower[at + 3..].to_owned()
        }
        _ => lower,
    };
    let without_www = without_scheme
        .strip_prefix("www.")
        .map(str::to_owned)
        .unwrap_or(without_scheme);
    without_www
        .strip_suffix('/')
        .map(str::to_owned)
        .unwrap_or(without_www)
}

fn site_label(host: &str) -> &str {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() >= 2 {
        parts[parts.len() - 2]
    } else {
        host
    }
}

fn engine_scope(engine: &SearchEngine) -> SearchScope {
    SearchScope {
        kind: ScopeKind::Engine,
        name: engine.name.clone(),
        host: engine.host(),
        url: engine.url.clone(),
        engine_id: Some(engine.id.clone()),
        provider_id: None,
    }
}

pub fn find_scope(text: &str, sources: &ScopeSources<'_>) -> Option<SearchScope> {
    if let Some(provider) = provider_scope(text, sources.providers) {
        return Some(provider);
    }
    let t = normalize(text);
    if t.is_empty() || t.chars().any(char::is_whitespace) {
        return None;
    }
    let parsed = host_of(&format!("https://{t}"));
    let host = if parsed.is_empty() { t.clone() } else { parsed };
    if let Some(engine) = sources
        .engines
        .iter()
        .find(|e| e.custom && e.keyword.to_lowercase() == t)
    {
        return Some(engine_scope(engine));
    }
    for engine in sources.engines.iter().filter(|e| !e.custom) {
        let engine_host = engine.host();
        if engine.keyword.to_lowercase() == host
            || engine_host == host
            || (t.chars().count() >= 3 && t == site_label(&engine_host))
        {
            return Some(engine_scope(engine));
        }
    }
    for s in POPULAR_SITE_SEARCHES {
        let by_label = t == host
            && t.chars().count() >= 3
            && s.host.split('.').count() == 2
            && site_label(s.host) == t;
        if s.host == host
            || host.ends_with(&format!(".{}", s.host))
            || s.keyword == Some(t.as_str())
            || by_label
        {
            return Some(SearchScope {
                kind: ScopeKind::Site,
                name: s.name.to_owned(),
                host: s.host.to_owned(),
                url: s.url.to_owned(),
                engine_id: None,
                provider_id: None,
            });
        }
    }
    if host.contains('.') && sources.hosts.contains(&host) {
        return Some(SearchScope {
            kind: ScopeKind::History,
            name: host.clone(),
            host,
            url: String::new(),
            engine_id: None,
            provider_id: None,
        });
    }
    None
}

pub fn scoped_search_url(
    scope: &SearchScope,
    query: &str,
    default_engine: &SearchEngine,
) -> String {
    match scope.kind {
        ScopeKind::History => {
            default_engine.search_url(&format!("site:{} {}", scope.host, query.trim()))
        }
        ScopeKind::Provider if scope.url.is_empty() => default_engine.search_url(query),
        _ => search_url_for(&scope.url, query),
    }
}

pub fn offered_site_search(
    typed: &str,
    completion: &str,
    sources: &ScopeSources<'_>,
) -> Option<SearchScope> {
    let t = typed.trim();
    if t.is_empty() || t.chars().any(char::is_whitespace) {
        return None;
    }
    provider_scope(typed, sources.providers)
        .or_else(|| find_scope(&format!("{typed}{completion}"), sources))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeywordBySpace {
    pub keyword: String,
    pub from: String,
}

pub fn keyword_by_space(typed: &str, next: &str) -> Option<KeywordBySpace> {
    if typed.trim().is_empty()
        || typed.ends_with(char::is_whitespace)
        || next != format!("{typed} ")
    {
        return None;
    }
    Some(KeywordBySpace {
        keyword: typed.to_owned(),
        from: next.to_owned(),
    })
}

pub fn keyword_scope(text: &str, sources: &ScopeSources<'_>) -> Option<SearchScope> {
    let trimmed = text.trim();
    let bare = match trimmed.find("://") {
        Some(at) if at > 0 && trimmed[..at].chars().all(|c| c.is_ascii_alphabetic()) => {
            &trimmed[at + 3..]
        }
        _ => trimmed,
    };
    let bare = bare.strip_suffix('/').unwrap_or(bare);
    if bare.contains(['/', '?', '#', ':', '@']) {
        return None;
    }
    let scope = find_scope(text, sources)?;
    if scope.kind == ScopeKind::Provider || bare.contains('.') {
        return Some(scope);
    }
    if scope.kind != ScopeKind::Engine {
        return None;
    }
    let engine = sources
        .engines
        .iter()
        .find(|e| Some(&e.id) == scope.engine_id.as_ref())?;
    (engine.keyword.to_lowercase() == text.to_lowercase()).then_some(scope)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeKey {
    Tab,
    Backspace,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KeyModifiers {
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    pub ctrl: bool,
}

pub struct SiteSearchKeyState<'a> {
    pub typed: &'a str,
    pub completion: &'a str,
    pub scope: Option<&'a SearchScope>,
    pub offered: Option<&'a SearchScope>,
    pub scope_from: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SiteSearchKey {
    Enter { scope: SearchScope, from: String },
    Leave { text: String },
    Accept { text: String },
}

pub fn site_search_key(
    key: ScopeKey,
    modifiers: KeyModifiers,
    state: &SiteSearchKeyState<'_>,
) -> Option<SiteSearchKey> {
    match key {
        ScopeKey::Tab if !modifiers.shift && !modifiers.ctrl => {
            if let (None, Some(offered)) = (state.scope, state.offered) {
                return Some(SiteSearchKey::Enter {
                    scope: offered.clone(),
                    from: format!("{}{}", state.typed, state.completion),
                });
            }
            (!state.completion.is_empty()).then(|| SiteSearchKey::Accept {
                text: format!("{}{}", state.typed, state.completion),
            })
        }
        ScopeKey::Backspace if modifiers == KeyModifiers::default() && state.scope.is_some() => {
            Some(SiteSearchKey::Leave {
                text: state.scope_from.to_owned(),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::omnibox::engines::built_in_engines;

    fn sources<'a>(engines: &'a [SearchEngine], hosts: &'a [String]) -> ScopeSources<'a> {
        ScopeSources {
            engines,
            hosts,
            providers: &[],
        }
    }

    #[test]
    fn popular_sites_and_engines_offer_their_own_search() {
        let engines = built_in_engines();
        let hosts = vec!["docs.rs".to_owned()];
        let s = sources(&engines, &hosts);
        let youtube = find_scope("youtube.com", &s).expect("youtube");
        assert_eq!(youtube.kind, ScopeKind::Site);
        assert_eq!(youtube.name, "YouTube");
        assert_eq!(
            find_scope("youtube", &s).map(|s| s.name),
            Some("YouTube".into())
        );
        assert_eq!(
            find_scope("maps", &s).map(|s| s.name),
            Some("Google Maps".into())
        );
        assert_eq!(find_scope("you", &s), None);
        assert_eq!(find_scope("you tube", &s), None);
        let docs = find_scope("docs.rs", &s).expect("history host");
        assert_eq!(docs.kind, ScopeKind::History);
        assert!(find_scope("bing.com", &s).is_some_and(|s| s.kind == ScopeKind::Engine));
    }

    #[test]
    fn scoped_urls_fill_the_site_template_or_search_the_host() {
        let engines = built_in_engines();
        let s = sources(&engines, &[]);
        let youtube = find_scope("youtube.com", &s).expect("youtube");
        assert_eq!(
            scoped_search_url(&youtube, "cats", &engines[0]),
            "https://www.youtube.com/results?search_query=cats"
        );
        let history = SearchScope {
            kind: ScopeKind::History,
            name: "docs.rs".into(),
            host: "docs.rs".into(),
            url: String::new(),
            engine_id: None,
            provider_id: None,
        };
        assert!(scoped_search_url(&history, "serde", &engines[0]).contains("site%3Adocs.rs"));
    }

    #[test]
    fn space_enters_a_scope_only_after_a_host_or_an_engine_keyword() {
        let engines = built_in_engines();
        let s = sources(&engines, &[]);
        assert_eq!(
            keyword_by_space("youtube.com", "youtube.com "),
            Some(KeywordBySpace {
                keyword: "youtube.com".into(),
                from: "youtube.com ".into()
            })
        );
        assert_eq!(keyword_by_space("youtube.com ", "youtube.com  "), None);
        assert!(keyword_scope("youtube.com", &s).is_some());
        assert!(keyword_scope("youtube", &s).is_none());
        assert!(keyword_scope("youtube.com/watch", &s).is_none());
    }

    #[test]
    fn tab_enters_the_offered_scope_and_backspace_leaves_it() {
        let engines = built_in_engines();
        let s = sources(&engines, &[]);
        let offered = offered_site_search("you", "tube.com", &s);
        assert!(offered.is_some());
        let state = SiteSearchKeyState {
            typed: "you",
            completion: "tube.com",
            scope: None,
            offered: offered.as_ref(),
            scope_from: "",
        };
        assert!(matches!(
            site_search_key(ScopeKey::Tab, KeyModifiers::default(), &state),
            Some(SiteSearchKey::Enter { from, .. }) if from == "youtube.com"
        ));
        let scope = offered.expect("scope");
        let inside = SiteSearchKeyState {
            typed: "",
            completion: "",
            scope: Some(&scope),
            offered: None,
            scope_from: "youtube.com",
        };
        assert_eq!(
            site_search_key(ScopeKey::Backspace, KeyModifiers::default(), &inside),
            Some(SiteSearchKey::Leave {
                text: "youtube.com".into()
            })
        );
        let plain = SiteSearchKeyState {
            typed: "gi",
            completion: "thub.com",
            scope: None,
            offered: None,
            scope_from: "",
        };
        assert_eq!(
            site_search_key(ScopeKey::Tab, KeyModifiers::default(), &plain),
            Some(SiteSearchKey::Accept {
                text: "github.com".into()
            })
        );
    }
}
