use crate::ids::TabId;
use crate::model::Millis;
use crate::omnibox::bangs::{BangMatch, Bangs};
use crate::omnibox::calc::calculate;
use crate::omnibox::engines::SearchEngine;
use crate::omnibox::providers::{
    ExtensionCandidate, ExtensionOpen, ProviderSection, extension_suggestions,
    global_provider_rows, provider_scope_rows,
};
use crate::omnibox::site_search::{ScopeKind, SearchScope, scoped_search_url};
use crate::omnibox::url::{display_url, fixup_url, host_of, same_address, spaced_address_guess};
use std::collections::{HashMap, HashSet};

const DAY_MS: f64 = 86_400_000.0;
const MAX_INDEXED_SHOWN: usize = 2048;
const MAX_INDEXED_TITLE: usize = 512;
const LEADING_PAGE_ROWS: usize = 3;
const LEADING_ROWS: usize = 5;
const CURRENT_PAGE_DERANK: f64 = 80.0;
const OPEN_TAB_BONUS: f64 = 6.0;
const BOOKMARK_BONUS: f64 = 20.0;
const STRONG_MATCH: f64 = 40.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Suggestion {
    Page {
        url: String,
        title: String,
        favicon: Option<String>,
        tab_id: Option<TabId>,
        bookmarked: bool,
        visited: bool,
    },
    Search {
        query: String,
        url: String,
        engine: String,
        suggested: bool,
        bang: bool,
    },
    Calc {
        expression: String,
        value: String,
        url: String,
    },
    Action {
        id: String,
        title: String,
        hint: Option<String>,
    },
    Extension {
        id: String,
        title: String,
        icon: Option<String>,
        open: ExtensionOpen,
    },
    Provider {
        provider_id: String,
        provider: String,
        title: String,
        url: String,
        subtitle: Option<String>,
        icon: Option<String>,
    },
}

impl Suggestion {
    pub fn key(&self) -> String {
        match self {
            Suggestion::Page {
                url,
                tab_id: Some(_),
                ..
            } => format!("tab:{}", page_key(url)),
            Suggestion::Page { url, .. } => format!("page:{}", with_root_slash(url)),
            Suggestion::Search { url, .. } => format!("search:{url}"),
            Suggestion::Calc { expression, .. } => format!("calc:{expression}"),
            Suggestion::Action { id, .. } => format!("action:{id}"),
            Suggestion::Extension { id, open, .. } => format!(
                "extension:{}:{id}",
                match open {
                    ExtensionOpen::Action => "action",
                    ExtensionOpen::Options => "options",
                }
            ),
            Suggestion::Provider {
                provider_id, url, ..
            } => format!("provider:{provider_id}:{}", page_key(url)),
        }
    }

    pub fn url(&self) -> Option<&str> {
        match self {
            Suggestion::Page { url, .. }
            | Suggestion::Search { url, .. }
            | Suggestion::Calc { url, .. }
            | Suggestion::Provider { url, .. } => Some(url),
            Suggestion::Action { .. } | Suggestion::Extension { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SuggestionResult {
    pub items: Vec<Suggestion>,
    pub completion: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandAction {
    pub id: String,
    pub title: String,
    pub keywords: Vec<String>,
    pub hint: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct PageRow<'a> {
    pub url: &'a str,
    pub title: &'a str,
    pub favicon: Option<&'a str>,
    pub visits: u32,
    pub last_visit: Millis,
}

#[derive(Clone, Copy, Debug)]
pub struct OpenTabRow<'a> {
    pub id: &'a TabId,
    pub url: &'a str,
    pub title: &'a str,
    pub custom_title: Option<&'a str>,
    pub favicon: Option<&'a str>,
}

pub fn document_key(url: &str) -> &str {
    let doc = url.split('#').next().unwrap_or(url);
    doc.strip_suffix('/').unwrap_or(doc)
}

pub fn route_of(url: &str) -> &str {
    match url.find('#') {
        Some(at) if url[at..].starts_with("#/") || url[at..].starts_with("#!/") => &url[at..],
        _ => "",
    }
}

pub fn page_key(url: &str) -> String {
    format!("{}{}", document_key(url), route_of(url))
}

pub fn with_root_slash(url: &str) -> String {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    let after = if lower.starts_with("https://") {
        8
    } else if lower.starts_with("http://") {
        7
    } else {
        return url.to_owned();
    };
    let host_end = url[after..]
        .find(['/', '?', '#'])
        .map_or(url.len(), |i| after + i);
    if url[host_end..].starts_with('/') {
        url.to_owned()
    } else {
        format!("{}/{}", &url[..host_end], &url[host_end..])
    }
}

fn clip(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn words_of(lower: &str) -> String {
    let mut out = String::with_capacity(lower.len() + 1);
    let mut gap = true;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap {
                out.push(' ');
            }
            out.push(c);
            gap = false;
        } else {
            gap = true;
        }
    }
    out
}

fn log_visits(visits: u32) -> f64 {
    (1.0 + f64::from(visits)).log2() * 8.0
}

#[derive(Clone, Debug)]
struct Candidate {
    url: String,
    title: String,
    favicon: Option<String>,
    visits: u32,
    last_visit: Millis,
    bookmarked: bool,
    key: String,
    shown: String,
    shown_lower: String,
    shown_words: String,
    shown_clipped: bool,
    title_lower: String,
    title_words: String,
    host_lower: String,
    origin: Option<String>,
    tab_id: Option<TabId>,
    fresh: bool,
    renamed: bool,
}

impl Candidate {
    fn new(url: &str, title: &str, favicon: Option<&str>) -> Self {
        let raw_shown = display_url(url);
        let shown_clipped = raw_shown.len() > MAX_INDEXED_SHOWN;
        let shown = clip(&raw_shown, MAX_INDEXED_SHOWN).to_owned();
        let shown_lower = shown.to_lowercase();
        let title_lower = clip(title, MAX_INDEXED_TITLE).to_lowercase();
        let host_lower = shown_lower
            .split(['/', '?', '#'])
            .next()
            .unwrap_or("")
            .to_owned();
        let lower_url = url.get(..8).unwrap_or(url).to_ascii_lowercase();
        let origin =
            (lower_url.starts_with("https://") || lower_url.starts_with("http://")).then(|| {
                let after = url.find("://").map_or(0, |i| i + 3);
                let end = url[after..]
                    .find(['/', '?', '#'])
                    .map_or(url.len(), |i| after + i);
                url[..end].to_owned()
            });
        Candidate {
            url: url.to_owned(),
            title: title.to_owned(),
            favicon: favicon.map(str::to_owned),
            visits: 0,
            last_visit: 0,
            bookmarked: false,
            key: page_key(url),
            shown_words: words_of(&shown_lower),
            title_words: words_of(&title_lower),
            shown,
            shown_lower,
            shown_clipped,
            title_lower,
            host_lower,
            origin: origin.filter(|o| o.len() > o.find("://").map_or(0, |i| i + 3)),
            tab_id: None,
            fresh: false,
            renamed: false,
        }
    }

    fn row(&self, tab_id: Option<&TabId>) -> Suggestion {
        Suggestion::Page {
            url: self.url.clone(),
            title: self.title.clone(),
            favicon: self.favicon.clone(),
            tab_id: tab_id.cloned(),
            bookmarked: self.bookmarked,
            visited: self.visits > 0,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct SuggestionIndex {
    pages: Vec<Candidate>,
    by_key: HashMap<String, usize>,
}

impl SuggestionIndex {
    pub fn build<'a>(
        history: impl IntoIterator<Item = PageRow<'a>>,
        bookmarks: impl IntoIterator<Item = PageRow<'a>>,
    ) -> Self {
        let mut index = SuggestionIndex::default();
        let marks: Vec<Candidate> = bookmarks
            .into_iter()
            .map(|b| {
                let mut c = Candidate::new(b.url, b.title, b.favicon);
                c.bookmarked = true;
                c
            })
            .collect();
        let marked: HashMap<&str, &Candidate> = marks.iter().map(|c| (c.key.as_str(), c)).collect();
        for h in history {
            let mut c = Candidate::new(h.url, h.title, h.favicon);
            if index.by_key.contains_key(&c.key) {
                continue;
            }
            c.visits = h.visits;
            c.last_visit = h.last_visit;
            if let Some(mark) = marked.get(c.key.as_str()) {
                c.bookmarked = true;
                if !mark.title.is_empty()
                    && mark.title_lower != c.title_lower
                    && with_root_slash(&mark.url) == with_root_slash(&c.url)
                {
                    c.title = mark.title.clone();
                    c.title_lower = format!("{}\n{}", mark.title_lower, c.title_lower);
                    c.title_words = words_of(&c.title_lower);
                }
            }
            index.by_key.insert(c.key.clone(), index.pages.len());
            index.pages.push(c);
        }
        for c in marks {
            if !index.by_key.contains_key(&c.key) {
                index.by_key.insert(c.key.clone(), index.pages.len());
                index.pages.push(c);
            }
        }
        index
    }

    pub fn hosts(&self) -> impl Iterator<Item = &str> {
        self.pages
            .iter()
            .map(|c| c.host_lower.as_str())
            .filter(|h| !h.is_empty())
    }

    pub fn len(&self) -> usize {
        self.pages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }
}

#[derive(Clone, Copy)]
pub struct SuggestOptions<'a> {
    pub limit: usize,
    pub now: Millis,
    pub engine: &'a SearchEngine,
    pub website_first: bool,
    pub remote: &'a [String],
    pub remote_sites: &'a [(String, String)],
    pub actions: &'a [CommandAction],
    pub current_tab: Option<&'a TabId>,
    pub current_url: Option<&'a str>,
    pub prevent_inline: bool,
    pub switch_to_open_tab: bool,
    pub bangs: Option<&'a Bangs>,
    pub scope: Option<&'a SearchScope>,
    pub extensions: &'a [ExtensionCandidate],
    pub providers: &'a [ProviderSection],
}

impl<'a> SuggestOptions<'a> {
    pub fn new(engine: &'a SearchEngine, now: Millis) -> Self {
        SuggestOptions {
            limit: 8,
            now,
            engine,
            website_first: true,
            remote: &[],
            remote_sites: &[],
            actions: &[],
            current_tab: None,
            current_url: None,
            prevent_inline: false,
            switch_to_open_tab: true,
            bangs: None,
            scope: None,
            extensions: &[],
            providers: &[],
        }
    }
}

struct Query {
    q: String,
    tokens: Vec<String>,
    needle: String,
    word: bool,
    segment_starts: Option<[String; 2]>,
}

fn is_word(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

impl Query {
    fn new(q: &str) -> Self {
        let tokens: Vec<String> = q.split_whitespace().map(str::to_owned).collect();
        let needle = tokens
            .iter()
            .max_by_key(|t| t.len())
            .cloned()
            .unwrap_or_default();
        Query {
            segment_starts: (!q.contains(['.', '/'])).then(|| [format!(".{q}"), format!("/{q}")]),
            word: is_word(q),
            needle,
            tokens,
            q: q.to_owned(),
        }
    }

    fn score_words(&self, c: &Candidate) -> f64 {
        let (shown, title) = (&c.shown_lower, &c.title_lower);
        if !shown.contains(&self.needle) && !title.contains(&self.needle) {
            return 0.0;
        }
        let mut s = 0.0;
        if shown.contains(char::is_whitespace) {
            if shown.starts_with(&self.q) {
                s = 100.0;
            } else if self
                .segment_starts
                .as_ref()
                .is_some_and(|[a, b]| shown.contains(a.as_str()) || shown.contains(b.as_str()))
            {
                s = 60.0;
            } else if shown.contains(&self.q) {
                s = 30.0;
            }
        }
        match title.find(&self.q) {
            Some(0) => s += 40.0,
            Some(_) => s += 20.0,
            None => {}
        }
        if s > 0.0 {
            return s;
        }
        for token in &self.tokens {
            let spaced = format!(" {token}");
            if is_word(token) && c.title_words.contains(&spaced) {
                s += 15.0;
            } else if is_word(token) && c.shown_words.contains(&spaced) {
                s += 10.0;
            } else if token.chars().count() >= 3
                && (title.contains(token.as_str()) || shown.contains(token.as_str()))
            {
                s += 5.0;
            } else {
                return 0.0;
            }
        }
        s
    }

    fn score_word(&self, c: &Candidate) -> f64 {
        let q = &self.q;
        let (si, ti) = (
            c.shown_lower.find(q.as_str()),
            c.title_lower.find(q.as_str()),
        );
        if si.is_none() && ti.is_none() {
            return 0.0;
        }
        let long = q.chars().count() >= 2;
        let mut s = match si {
            Some(0) => 100.0,
            Some(_)
                if self.segment_starts.as_ref().is_some_and(|[a, b]| {
                    c.shown_lower.contains(a.as_str()) || c.shown_lower.contains(b.as_str())
                }) =>
            {
                60.0
            }
            Some(_) if long => 30.0,
            _ => 0.0,
        };
        match ti {
            Some(0) => s += 40.0,
            Some(_) if long => s += 20.0,
            _ if !long && self.word && c.title_words.contains(&format!(" {q}")) => s += 20.0,
            _ => {}
        }
        s
    }

    fn score(&self, c: &Candidate) -> f64 {
        if self.tokens.len() == 1 {
            self.score_word(c)
        } else {
            self.score_words(c)
        }
    }
}

#[derive(Clone)]
struct Ranked<'c> {
    c: &'c Candidate,
    tab: Option<TabId>,
    m: f64,
    s: f64,
}

fn inline_match(c: &Candidate, q: &str) -> bool {
    (c.host_lower.starts_with(q) && c.origin.is_some())
        || (!c.shown_clipped
            && q.contains('/')
            && !c.shown.contains(['?', '#'])
            && c.shown_lower.starts_with(q))
}

fn inline_target(q: &str, c: &Candidate) -> (String, String) {
    let host = c
        .shown
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .to_owned();
    match &c.origin {
        Some(origin) if host.to_lowercase().starts_with(q) => (host, format!("{origin}/")),
        _ => (c.shown.clone(), c.url.clone()),
    }
}

fn typed_is_page(c: &Candidate, q: &str) -> bool {
    (!c.shown_clipped && q == c.shown_lower) || q == c.host_lower
}

struct Output {
    items: Vec<Suggestion>,
    seen: HashSet<String>,
    limit: usize,
}

impl Output {
    fn push(&mut self, row: Suggestion) {
        if self.items.len() >= self.limit {
            return;
        }
        if self.seen.insert(row.key()) {
            self.items.push(row);
        }
    }
}

fn dedupe_remote<'r>(remote: &'r [String], query: &str) -> Vec<&'r str> {
    let mut seen = HashSet::from([query.trim().to_lowercase()]);
    remote
        .iter()
        .map(|r| r.trim())
        .filter(|r| !r.is_empty() && seen.insert(r.to_lowercase()))
        .collect()
}

fn fuzzy_score(q: &str, tokens: &[&str], text: &str) -> f64 {
    let t = text.to_lowercase();
    if t == q {
        return 1000.0;
    }
    let words: Vec<&str> = t
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let mut score = if t.starts_with(q) { 200.0 } else { 0.0 };
    let plain: String = t.chars().filter(char::is_ascii_alphanumeric).collect();
    for token in tokens {
        if let Some(i) = words.iter().position(|w| w.starts_with(token)) {
            score += 60.0 + token.len() as f64 * 4.0 - i as f64 * 2.0;
        } else if token.len() >= 3 && t.contains(token) {
            score += 25.0 + token.len() as f64;
        } else if token.len() >= 2 && is_subsequence(token, &plain) {
            score += 8.0;
        } else {
            return 0.0;
        }
    }
    score - words.len() as f64
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut rest = haystack.chars();
    needle.chars().all(|n| rest.any(|h| h == n))
}

pub fn match_actions<'a>(
    query: &str,
    actions: &'a [CommandAction],
    limit: usize,
) -> Vec<(&'a CommandAction, f64, bool)> {
    let q = query
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if q.chars().count() < 2 {
        return Vec::new();
    }
    let tokens: Vec<&str> = q
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let mut hits: Vec<(&CommandAction, f64, bool)> = actions
        .iter()
        .filter_map(|action| {
            let names = std::iter::once(&action.title).chain(&action.keywords);
            let mut exact = false;
            let score = names
                .enumerate()
                .map(|(i, name)| {
                    exact |= name.to_lowercase() == q;
                    fuzzy_score(&q, &tokens, name) - if i > 0 { 5.0 } else { 0.0 }
                })
                .fold(f64::NEG_INFINITY, f64::max);
            (score > 0.0).then_some((action, score, exact))
        })
        .collect();
    hits.sort_by(|a, b| b.1.total_cmp(&a.1));
    hits.truncate(limit);
    hits
}

fn action_row(action: &CommandAction) -> Suggestion {
    Suggestion::Action {
        id: action.id.clone(),
        title: action.title.clone(),
        hint: action.hint.clone(),
    }
}

fn strip_web_scheme(query: &str) -> &str {
    let head = query.get(..8).unwrap_or(query).to_ascii_lowercase();
    let cut = if head.starts_with("https://") {
        8
    } else if head.starts_with("http://") {
        7
    } else {
        return query;
    };
    match query[cut..].chars().next() {
        Some(c) if !c.is_whitespace() => &query[cut..],
        _ => query,
    }
}

pub fn build_suggestions(
    raw: &str,
    index: &SuggestionIndex,
    tabs: &[OpenTabRow<'_>],
    options: &SuggestOptions<'_>,
) -> SuggestionResult {
    let query = raw.trim();
    let provider_scope = options
        .scope
        .is_some_and(|scope| scope.kind == ScopeKind::Provider);
    if query.is_empty() && !provider_scope {
        return SuggestionResult::default();
    }
    let mut out = Output {
        items: Vec::new(),
        seen: HashSet::new(),
        limit: options.limit,
    };
    let engine = options.engine;
    if let Some(scope) = options.scope {
        return scoped_suggestions(query, scope, index, tabs, options);
    }
    if let Some(found) = options.bangs.and_then(|b| b.find(query)) {
        return bang_suggestions(found, index, tabs, options);
    }
    if let Some(text) = query.strip_prefix('?') {
        let text = text.trim();
        if text.is_empty() {
            return SuggestionResult::default();
        }
        out.push(Suggestion::Search {
            query: text.to_owned(),
            url: engine.search_url(text),
            engine: engine.name.clone(),
            suggested: false,
            bang: false,
        });
        for remote in dedupe_remote(options.remote, text).into_iter().take(4) {
            out.push(Suggestion::Search {
                query: remote.to_owned(),
                url: engine.search_url(remote),
                engine: engine.name.clone(),
                suggested: true,
                bang: false,
            });
        }
        return SuggestionResult {
            items: out.items,
            completion: String::new(),
        };
    }
    let bare = strip_web_scheme(query);
    let q = bare.to_lowercase();
    let parsed = Query::new(&q);
    let one_word = parsed.tokens.len() == 1;
    let no_inline = options.prevent_inline
        || (one_word && raw.len() != query.len() && raw.ends_with(char::is_whitespace));
    let completes = one_word && !no_inline;
    let current_key = options.current_url.map(page_key);

    let mut tab_of: HashMap<String, TabId> = HashMap::new();
    let mut extra: Vec<Candidate> = Vec::new();
    for tab in tabs
        .iter()
        .filter(|t| !t.url.is_empty() && Some(t.id) != options.current_tab)
    {
        let key = page_key(tab.url);
        let renamed = tab.custom_title.filter(|t| !t.is_empty());
        if tab_of.contains_key(&key) && renamed.is_none() {
            continue;
        }
        tab_of.insert(key.clone(), tab.id.clone());
        if index.by_key.contains_key(&key) && renamed.is_none() {
            continue;
        }
        let mut c = Candidate::new(tab.url, renamed.unwrap_or(tab.title), tab.favicon);
        if let Some(name) = renamed {
            c.title_lower = format!("{}\n{}", name.to_lowercase(), tab.title.to_lowercase());
            c.title_words = words_of(&c.title_lower);
            c.renamed = true;
            if let Some(&at) = index.by_key.get(&key) {
                let listed = &index.pages[at];
                c.visits = listed.visits;
                c.last_visit = listed.last_visit;
                c.bookmarked = listed.bookmarked;
            }
        }
        c.tab_id = Some(tab.id.clone());
        c.fresh = true;
        extra.push(c);
    }
    let renamed_keys: HashSet<&str> = extra
        .iter()
        .filter(|c| c.renamed)
        .map(|c| c.key.as_str())
        .collect();

    let mut ranked: Vec<Ranked<'_>> = Vec::new();
    let mut tab_rows: Vec<Ranked<'_>> = Vec::new();
    let mut inline: Option<Ranked<'_>> = None;
    for (listed, c) in index
        .pages
        .iter()
        .map(|c| (true, c))
        .chain(extra.iter().map(|c| (false, c)))
    {
        if listed && renamed_keys.contains(c.key.as_str()) {
            continue;
        }
        let m = parsed.score(c);
        if m <= 0.0 {
            continue;
        }
        let derank = if current_key.as_deref() == Some(c.key.as_str()) {
            CURRENT_PAGE_DERANK
        } else {
            0.0
        };
        let last = if c.fresh { options.now } else { c.last_visit };
        let age = if last > 0 {
            ((options.now - last) as f64 / DAY_MS).clamp(0.0, 30.0)
        } else {
            10.0
        };
        let tab = c.tab_id.clone().or_else(|| tab_of.get(&c.key).cloned());
        let s = m + log_visits(c.visits) - age
            + if c.bookmarked { BOOKMARK_BONUS } else { 0.0 }
            + if tab.is_some() { OPEN_TAB_BONUS } else { 0.0 }
            - derank;
        let r = Ranked { c, tab, m, s };
        if completes
            && c.visits > 0
            && inline_match(c, &q)
            && inline.as_ref().is_none_or(|i| s > i.s)
        {
            inline = Some(r.clone());
        }
        if r.tab.is_some() {
            tab_rows.push(r.clone());
        }
        ranked.push(r);
    }
    ranked.sort_by(|a, b| b.s.total_cmp(&a.s));
    ranked.truncate(options.limit + 1);
    tab_rows.sort_by(|a, b| b.m.total_cmp(&a.m).then(b.s.total_cmp(&a.s)));
    tab_rows.truncate(LEADING_ROWS);

    let typed = fixup_url(query);
    let guessed = if typed.is_none() {
        spaced_address_guess(query)
    } else {
        None
    };
    let search = Suggestion::Search {
        query: query.to_owned(),
        url: engine.search_url(query),
        engine: engine.name.clone(),
        suggested: false,
        bang: false,
    };
    let calc = calculate(query);
    let action_hits = match_actions(
        query,
        options.actions,
        if query.chars().count() >= 4 { 4 } else { 2 },
    );
    let action_hits: Vec<_> = action_hits
        .into_iter()
        .filter(|(_, score, exact)| *exact || *score >= 50.0)
        .collect();
    let target = inline.as_ref().map(|i| inline_target(&q, i.c));
    let completion: String = target
        .as_ref()
        .map(|(text, _)| text.chars().skip(bare.chars().count()).collect())
        .unwrap_or_default();

    let open_tab_at = |url: &str| -> Option<Suggestion> {
        if !options.switch_to_open_tab {
            return None;
        }
        let tab = tab_of.get(&page_key(&with_root_slash(url)))?;
        let shown = tabs.iter().find(|t| *t.id == *tab)?;
        Some(Suggestion::Page {
            url: with_root_slash(url),
            title: shown
                .custom_title
                .filter(|t| !t.is_empty())
                .unwrap_or(shown.title)
                .to_owned(),
            favicon: shown.favicon.map(str::to_owned),
            tab_id: Some(tab.clone()),
            bookmarked: false,
            visited: false,
        })
    };
    let known = |url: &str| {
        index
            .by_key
            .get(&page_key(url))
            .map(|&at| index.pages[at].row(None))
    };

    let (extension_rows, extension_exact) =
        extension_suggestions(query, options.extensions, EXTENSION_ROWS);
    let first = if let Some((action, _, true)) = action_hits.first() {
        action_row(action)
    } else if let (Some((_, url)), false) = (&target, completion.is_empty()) {
        open_tab_at(url)
            .or_else(|| known(url))
            .unwrap_or_else(|| Suggestion::Page {
                url: url.clone(),
                title: String::new(),
                favicon: inline.as_ref().and_then(|i| i.c.favicon.clone()),
                tab_id: None,
                bookmarked: false,
                visited: false,
            })
    } else if let Some(url) = &typed {
        open_tab_at(url)
            .or_else(|| known(url))
            .unwrap_or(Suggestion::Page {
                url: url.clone(),
                title: String::new(),
                favicon: None,
                tab_id: None,
                bookmarked: false,
                visited: false,
            })
    } else if let Some(row) = extension_rows.first().filter(|_| extension_exact) {
        row.clone()
    } else if let Some(best) = ranked.first().filter(|b| {
        guessed.is_none()
            && options.website_first
            && b.m >= STRONG_MATCH
            && (!no_inline || typed_is_page(b.c, &q))
    }) {
        best.c.row(best.tab.as_ref())
    } else {
        search.clone()
    };
    out.push(first);
    out.push(search);
    if let Some(guess) = &guessed {
        let row = tabs
            .iter()
            .find(|t| Some(t.id) != options.current_tab && same_address(t.url, guess))
            .map(|t| Suggestion::Page {
                url: t.url.to_owned(),
                title: t.custom_title.unwrap_or(t.title).to_owned(),
                favicon: t.favicon.map(str::to_owned),
                tab_id: Some(t.id.clone()),
                bookmarked: false,
                visited: false,
            })
            .or_else(|| known(guess))
            .unwrap_or(Suggestion::Page {
                url: guess.clone(),
                title: String::new(),
                favicon: None,
                tab_id: None,
                bookmarked: false,
                visited: false,
            });
        out.push(row);
    }
    if let Some(calc) = calc {
        out.push(Suggestion::Calc {
            url: engine.search_url(&calc.expression),
            expression: calc.expression,
            value: calc.display,
        });
    }
    for (action, _, _) in &action_hits {
        out.push(action_row(action));
    }
    for row in &extension_rows {
        out.push(row.clone());
    }
    let listed: Vec<&Ranked<'_>> = ranked
        .iter()
        .filter(|r| guessed.as_ref().is_none_or(|g| !same_address(&r.c.url, g)))
        .collect();
    let mut lead: Vec<&Ranked<'_>> = Vec::new();
    for r in &listed {
        if lead.len() >= LEADING_PAGE_ROWS {
            break;
        }
        if !lead.iter().any(|l| l.c.key == r.c.key) {
            lead.push(r);
        }
    }
    let bar = if lead.len() == LEADING_PAGE_ROWS {
        lead[LEADING_PAGE_ROWS - 1].m
    } else {
        0.0
    };
    for t in &tab_rows {
        if lead.len() >= LEADING_ROWS {
            break;
        }
        if t.m >= bar && !lead.iter().any(|l| l.c.key == t.c.key) {
            lead.push(t);
        }
    }
    for r in &lead {
        out.push(r.c.row(r.tab.as_ref()));
    }
    for (url, title) in options
        .remote_sites
        .iter()
        .take(2)
        .filter(|(url, _)| guessed.as_ref().is_none_or(|g| !same_address(url, g)))
    {
        out.push(known(url).unwrap_or(Suggestion::Page {
            url: url.clone(),
            title: title.clone(),
            favicon: None,
            tab_id: None,
            bookmarked: false,
            visited: false,
        }));
    }
    let provider_at = out.items.len();
    for remote in dedupe_remote(options.remote, query).into_iter().take(4) {
        out.push(Suggestion::Search {
            query: remote.to_owned(),
            url: engine.search_url(remote),
            engine: engine.name.clone(),
            suggested: true,
            bang: false,
        });
    }
    let trailing: Vec<Suggestion> = listed
        .iter()
        .filter(|r| !lead.iter().any(|l| l.c.key == r.c.key))
        .map(|r| r.c.row(r.tab.as_ref()))
        .collect();
    let provider_rows = if options.providers.is_empty() {
        Vec::new()
    } else {
        let mut shown = out.items.clone();
        shown.extend(
            trailing
                .iter()
                .filter(|r| {
                    matches!(
                        r,
                        Suggestion::Page {
                            tab_id: Some(_),
                            ..
                        }
                    )
                })
                .cloned(),
        );
        global_provider_rows(options.providers, &shown)
    };
    let offered: Vec<String> = provider_rows
        .iter()
        .filter_map(|r| r.url().map(page_key))
        .collect();
    for row in trailing {
        let tab = matches!(
            row,
            Suggestion::Page {
                tab_id: Some(_),
                ..
            }
        );
        if tab || row.url().is_none_or(|u| !offered.contains(&page_key(u))) {
            out.push(row);
        }
    }
    let mut items = out.items;
    if !provider_rows.is_empty() {
        let at = provider_at.min(items.len());
        items.splice(at..at, provider_rows);
    }
    SuggestionResult { items, completion }
}

const SCOPED_PAGE_ROWS: usize = 4;
const EXTENSION_ROWS: usize = 2;
const SCOPED_SEARCH_POOL: usize = 64;

fn scoped_suggestions(
    query: &str,
    scope: &SearchScope,
    index: &SuggestionIndex,
    tabs: &[OpenTabRow<'_>],
    options: &SuggestOptions<'_>,
) -> SuggestionResult {
    if scope.kind == ScopeKind::Provider {
        return SuggestionResult {
            items: provider_scope_rows(
                query,
                scope.provider_id.as_deref().unwrap_or(""),
                &scope.name,
                (!scope.url.is_empty()).then_some(scope.url.as_str()),
                options.providers,
                options.limit,
            ),
            completion: String::new(),
        };
    }
    let mut out = Output {
        items: Vec::new(),
        seen: HashSet::new(),
        limit: options.limit,
    };
    out.push(Suggestion::Search {
        query: query.to_owned(),
        url: scoped_search_url(scope, query, options.engine),
        engine: scope.name.clone(),
        suggested: false,
        bang: false,
    });
    let unscoped = SuggestOptions {
        bangs: None,
        scope: None,
        remote: &[],
        remote_sites: &[],
        actions: &[],
        prevent_inline: true,
        limit: SCOPED_SEARCH_POOL,
        ..*options
    };
    let suffix = format!(".{}", scope.host);
    let pages = build_suggestions(query, index, tabs, &unscoped);
    for row in pages
        .items
        .into_iter()
        .filter(|row| match row {
            Suggestion::Page { url, .. } => {
                let host = host_of(url);
                host == scope.host || host.ends_with(&suffix)
            }
            _ => false,
        })
        .take(SCOPED_PAGE_ROWS)
    {
        out.push(row);
    }
    SuggestionResult {
        items: out.items,
        completion: String::new(),
    }
}

fn bang_suggestions(
    found: BangMatch,
    index: &SuggestionIndex,
    tabs: &[OpenTabRow<'_>],
    options: &SuggestOptions<'_>,
) -> SuggestionResult {
    let mut out = Output {
        items: Vec::new(),
        seen: HashSet::new(),
        limit: options.limit,
    };
    if found.query.is_empty() {
        out.push(Suggestion::Page {
            url: found.bang.home.clone(),
            title: found.bang.name,
            favicon: None,
            tab_id: None,
            bookmarked: false,
            visited: false,
        });
        return SuggestionResult {
            items: out.items,
            completion: String::new(),
        };
    }
    out.push(Suggestion::Search {
        query: found.query.clone(),
        url: found.url.clone(),
        engine: found.bang.name.clone(),
        suggested: false,
        bang: true,
    });
    let site = host_of(&found.bang.home);
    let scoped = SuggestOptions {
        bangs: None,
        remote: &[],
        remote_sites: &[],
        actions: &[],
        ..*options
    };
    let pages = build_suggestions(&found.query, index, tabs, &scoped);
    for row in pages.items {
        if let Suggestion::Page { url, .. } = &row {
            let host = host_of(url);
            if host == site || host.ends_with(&format!(".{site}")) {
                out.push(row);
            }
        }
    }
    SuggestionResult {
        items: out.items,
        completion: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::omnibox::engines::built_in_engines;

    const NOW: Millis = 1_795_656_501_578;

    fn history() -> Vec<PageRow<'static>> {
        vec![
            PageRow {
                url: "https://github.com/ardia-browser/ardia",
                title: "Ardia on GitHub",
                favicon: None,
                visits: 40,
                last_visit: NOW - 1000,
            },
            PageRow {
                url: "https://github.com/",
                title: "GitHub",
                favicon: None,
                visits: 90,
                last_visit: NOW - 5000,
            },
            PageRow {
                url: "https://gist.github.com/x",
                title: "A gist",
                favicon: None,
                visits: 2,
                last_visit: NOW - 30 * 86_400_000,
            },
            PageRow {
                url: "https://docs.rs/serde",
                title: "serde - Rust",
                favicon: None,
                visits: 5,
                last_visit: NOW - 86_400_000,
            },
            PageRow {
                url: "https://news.ycombinator.com/",
                title: "Hacker News",
                favicon: None,
                visits: 12,
                last_visit: NOW - 3 * 86_400_000,
            },
        ]
    }

    fn bookmarks() -> Vec<PageRow<'static>> {
        vec![
            PageRow {
                url: "https://docs.rs/serde",
                title: "Serde docs",
                favicon: None,
                visits: 0,
                last_visit: 0,
            },
            PageRow {
                url: "https://rust-lang.org/",
                title: "Rust",
                favicon: None,
                visits: 0,
                last_visit: 0,
            },
        ]
    }

    fn suggest(text: &str, tabs: &[OpenTabRow<'_>]) -> SuggestionResult {
        let index = SuggestionIndex::build(history(), bookmarks());
        let engines = built_in_engines();
        build_suggestions(text, &index, tabs, &SuggestOptions::new(&engines[0], NOW))
    }

    #[test]
    fn typing_a_host_prefix_completes_inline_to_the_most_visited_origin() {
        let result = suggest("git", &[]);
        assert_eq!(result.completion, "hub.com");
        assert!(
            matches!(&result.items[0], Suggestion::Page { url, .. } if url == "https://github.com/")
        );
        assert!(matches!(&result.items[1], Suggestion::Search { query, .. } if query == "git"));
        assert!(result.items.len() <= 8);
    }

    #[test]
    fn a_trailing_space_stops_inline_completion() {
        let result = suggest("git ", &[]);
        assert_eq!(result.completion, "");
    }

    #[test]
    fn open_tabs_offer_switch_to_tab_rows() {
        let tab = TabId::new("tab-1");
        let tabs = [OpenTabRow {
            id: &tab,
            url: "https://news.ycombinator.com/",
            title: "HN",
            custom_title: None,
            favicon: None,
        }];
        let result = suggest("hacker", &tabs);
        assert!(
            result
                .items
                .iter()
                .any(|s| matches!(s, Suggestion::Page { tab_id: Some(id), .. } if id == &tab)),
            "{:?}",
            result.items
        );
    }

    #[test]
    fn renamed_tabs_match_their_new_name() {
        let tab = TabId::new("tab-2");
        let tabs = [OpenTabRow {
            id: &tab,
            url: "https://docs.rs/serde",
            title: "serde - Rust",
            custom_title: Some("Work Notes"),
            favicon: None,
        }];
        let result = suggest("work notes", &tabs);
        assert!(result.items.iter().any(|s| matches!(s, Suggestion::Page { title, tab_id: Some(_), .. } if title == "Work Notes")), "{:?}", result.items);
    }

    #[test]
    fn bookmarks_merge_into_history_and_get_a_boost() {
        let index = SuggestionIndex::build(history(), bookmarks());
        assert_eq!(index.len(), 6);
        let result = suggest("serde", &[]);
        assert!(result.items.iter().any(|s| matches!(s, Suggestion::Page { url, bookmarked: true, .. } if url == "https://docs.rs/serde")));
    }

    #[test]
    fn urls_math_and_search_only_mode() {
        let typed = suggest("example.org/path", &[]);
        assert!(
            matches!(&typed.items[0], Suggestion::Page { url, .. } if url == "https://example.org/path")
        );
        let math = suggest("2+2", &[]);
        assert!(
            math.items
                .iter()
                .any(|s| matches!(s, Suggestion::Calc { value, .. } if value == "4"))
        );
        let search_only = suggest("?github", &[]);
        assert_eq!(search_only.items.len(), 1);
        assert!(
            matches!(&search_only.items[0], Suggestion::Search { query, .. } if query == "github")
        );
        assert_eq!(suggest("   ", &[]), SuggestionResult::default());
    }

    #[test]
    fn remote_queries_are_deduplicated_and_capped() {
        let index = SuggestionIndex::build(history(), bookmarks());
        let engines = built_in_engines();
        let remote: Vec<String> = [
            "rust",
            "Rust",
            "rust lang",
            "rust book",
            "rust analyzer",
            "rust std",
            "rusty",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let mut options = SuggestOptions::new(&engines[0], NOW);
        options.remote = &remote;
        let result = build_suggestions("rust", &index, &[], &options);
        let suggested = result
            .items
            .iter()
            .filter(|s| {
                matches!(
                    s,
                    Suggestion::Search {
                        suggested: true,
                        ..
                    }
                )
            })
            .count();
        assert!(suggested <= 4);
        assert!(result.items.iter().all(|s| !matches!(s, Suggestion::Search { query, suggested: true, .. } if query.eq_ignore_ascii_case("rust"))));
    }

    #[test]
    fn commands_match_by_fuzzy_title_and_keywords() {
        let actions = vec![
            CommandAction {
                id: "newTab".into(),
                title: "New Tab".into(),
                keywords: vec![],
                hint: Some("⌘T".into()),
            },
            CommandAction {
                id: "reopenClosedTab".into(),
                title: "Reopen Closed Tab".into(),
                keywords: vec!["undo close".into()],
                hint: None,
            },
        ];
        let hits = match_actions("new tab", &actions, 3);
        assert_eq!(hits[0].0.id, "newTab");
        assert!(hits[0].2);
        assert_eq!(
            match_actions("undo", &actions, 3)[0].0.id,
            "reopenClosedTab"
        );
        assert!(match_actions("n", &actions, 3).is_empty());
        let index = SuggestionIndex::build(history(), bookmarks());
        let engines = built_in_engines();
        let mut options = SuggestOptions::new(&engines[0], NOW);
        options.actions = &actions;
        let result = build_suggestions("new tab", &index, &[], &options);
        assert!(matches!(&result.items[0], Suggestion::Action { id, .. } if id == "newTab"));
    }

    #[test]
    fn bangs_scope_suggestions_to_their_site() {
        let index = SuggestionIndex::build(history(), bookmarks());
        let engines = built_in_engines();
        let mut options = SuggestOptions::new(&engines[0], NOW);
        options.bangs = Some(Bangs::bundled());
        let result = build_suggestions("!gh ardia", &index, &[], &options);
        assert!(matches!(
            &result.items[0],
            Suggestion::Search { bang: true, .. }
        ));
        assert!(result.items.iter().skip(1).all(
            |s| matches!(s, Suggestion::Page { url, .. } if host_of(url).ends_with("github.com"))
        ));
        let home = build_suggestions("!gh", &index, &[], &options);
        assert!(
            matches!(&home.items[0], Suggestion::Page { url, .. } if url.starts_with("https://github.com"))
        );
    }

    #[test]
    fn keys_normalize_root_slashes_and_routes() {
        assert_eq!(with_root_slash("https://a.com"), "https://a.com/");
        assert_eq!(with_root_slash("https://a.com?x"), "https://a.com/?x");
        assert_eq!(with_root_slash("ftp://a"), "ftp://a");
        assert_eq!(
            page_key("https://a.com/x/#/route"),
            "https://a.com/x#/route"
        );
        assert_eq!(page_key("https://a.com/x#frag"), "https://a.com/x");
        assert_eq!(route_of("https://a.com/#!/r"), "#!/r");
    }

    #[test]
    fn large_histories_stay_fast_and_bounded() {
        let urls: Vec<String> = (0..20_000)
            .map(|i| format!("https://site{i}.example.com/page/{i}"))
            .collect();
        let rows: Vec<PageRow<'_>> = urls
            .iter()
            .map(|u| PageRow {
                url: u,
                title: "Some page title",
                favicon: None,
                visits: 3,
                last_visit: NOW,
            })
            .collect();
        let index = SuggestionIndex::build(rows, Vec::new());
        let engines = built_in_engines();
        let started = std::time::Instant::now();
        let result = build_suggestions(
            "site19999",
            &index,
            &[],
            &SuggestOptions::new(&engines[0], NOW),
        );
        assert!(result.items.len() <= 8);
        assert!(
            started.elapsed().as_millis() < 500,
            "{:?}",
            started.elapsed()
        );
    }
}
