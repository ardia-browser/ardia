use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use std::collections::HashSet;
use std::sync::OnceLock;

const TLD_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/core/src/tlds.ts"
));

const KNOWN_SCHEMES: [&str; 28] = [
    "http",
    "https",
    "file",
    "about",
    "data",
    "blob",
    "mailto",
    "tel",
    "sms",
    "facetime",
    "ftp",
    "view-source",
    "ardia",
    "chrome",
    "chrome-extension",
    "devtools",
    "x-apple.systempreferences",
    "itms-apps",
    "slack",
    "zoommtg",
    "vscode",
    "cursor",
    "notion",
    "figma",
    "spotify",
    "linear",
    "obsidian",
    "raycast",
];
const NON_SEARCH_SCHEMES: [&str; 3] = ["javascript", "vbscript", "edge"];
const LOCAL_TLDS: [&str; 6] = ["meta", "local", "localhost", "test", "internal", "lan"];
const LOCAL_SUFFIXES: [&str; 6] = [
    ".local",
    ".localhost",
    ".test",
    ".internal",
    ".lan",
    ".home.arpa",
];
const WIKI_SITES: [&str; 11] = [
    "wikipedia",
    "wiktionary",
    "wikimedia",
    "wikiquote",
    "wikibooks",
    "wikisource",
    "wikinews",
    "wikiversity",
    "wikivoyage",
    "wikidata",
    "mediawiki",
];
const PASSTHROUGH: [&str; 7] = [
    "about:",
    "data:",
    "mailto:",
    "tel:",
    "sms:",
    "facetime:",
    "view-source:",
];
pub const APP_SCHEME: &str = "ardia";
const APP_PAGES: [&str; 3] = ["history", "bookmarks", "downloads"];

const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn tlds() -> &'static HashSet<&'static str> {
    static TLDS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    TLDS.get_or_init(|| {
        let start = TLD_SOURCE.find('`').map_or(0, |i| i + 1);
        let end = TLD_SOURCE[start..]
            .find('`')
            .map_or(TLD_SOURCE.len(), |i| start + i);
        TLD_SOURCE[start..end].split_whitespace().collect()
    })
}

fn known_tld(tld: &str) -> bool {
    LOCAL_TLDS.contains(&tld) || tlds().contains(tld)
}

fn starts_with_ci(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text.is_char_boundary(prefix.len())
        && text[..prefix.len()].eq_ignore_ascii_case(prefix)
}

pub fn scheme_of(input: &str) -> Option<&str> {
    let colon = input.find(':')?;
    let scheme = &input[..colon];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    (first.is_ascii_alphabetic() && chars.all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)))
        .then_some(scheme)
}

fn is_known_scheme(scheme: &str) -> bool {
    KNOWN_SCHEMES.iter().any(|s| s.eq_ignore_ascii_case(scheme))
}

pub fn has_known_scheme(input: &str) -> bool {
    let Some(scheme) = scheme_of(input) else {
        return false;
    };
    input[scheme.len()..].starts_with("://")
        || is_known_scheme(scheme)
        || NON_SEARCH_SCHEMES
            .iter()
            .any(|s| s.eq_ignore_ascii_case(scheme))
}

pub fn is_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.len() <= 3
                && p.bytes().all(|b| b.is_ascii_digit())
                && p.parse::<u16>().is_ok_and(|n| n <= 255)
        })
}

fn is_local_host(host: &str) -> bool {
    host == "localhost"
        || !host.contains('.')
        || host.starts_with('[')
        || is_ipv4(host)
        || LOCAL_SUFFIXES.iter().any(|s| host.ends_with(s))
}

fn is_label(part: &str) -> bool {
    !part.is_empty()
        && !part.starts_with('-')
        && !part.ends_with('-')
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c >= '\u{a1}')
}

fn is_tld(part: &str) -> bool {
    (is_label(part) && !part.starts_with(|c: char| c.is_ascii_digit()))
        || (starts_with_ci(part, "xn--")
            && part.len() > 4
            && part[4..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

fn is_host_name(name: &str) -> bool {
    if name.eq_ignore_ascii_case("localhost") || is_ipv4(name) {
        return true;
    }
    if name.len() > 2 && name.starts_with('[') && name.ends_with(']') {
        return name[1..name.len() - 1]
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
            && name.len() > 2;
    }
    let labels: Vec<&str> = name.split('.').collect();
    match labels.as_slice() {
        [only] => is_label(only),
        [rest @ .., last] => rest.iter().all(|l| is_label(l)) && is_tld(last),
        [] => false,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HostMatch<'a> {
    authority: &'a str,
    name: &'a str,
    port: &'a str,
}

fn match_host(input: &str) -> Option<HostMatch<'_>> {
    let end = input.find(['/', '?', '#']).unwrap_or(input.len());
    let authority = &input[..end];
    let port = authority.rfind(':').filter(|&c| {
        let digits = &authority[c + 1..];
        (1..=5).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
    });
    let bare = port.map_or(authority, |c| &authority[..c]);
    let name = bare.strip_suffix('.').unwrap_or(bare);
    is_host_name(name).then_some(HostMatch {
        authority,
        name,
        port: port.map_or("", |c| &authority[c..]),
    })
}

fn has_query_key(rest: &str) -> bool {
    let stop = rest
        .find(|c: char| c.is_whitespace() || c == '?' || c == '#')
        .unwrap_or(rest.len());
    if !rest[stop..].starts_with('?') {
        return false;
    }
    let query = &rest[stop + 1..];
    let query = &query[..query
        .find(|c: char| c.is_whitespace() || c == '#')
        .unwrap_or(query.len())];
    query
        .split('&')
        .any(|piece| piece.find('=').is_some_and(|at| at > 0))
}

struct Spaced {
    escaped: String,
    certain: bool,
}

fn spaced_address(input: &str) -> Option<Spaced> {
    if !input.contains(' ') || input.chars().any(|c| c.is_whitespace() && c != ' ') {
        return None;
    }
    let end = input.find(['/', '?', '#'])?;
    if end == 0 || input[..end].contains(' ') || input[end..].starts_with("/ ") {
        return None;
    }
    let host = match_host(input)?;
    let name = host.name.to_ascii_lowercase();
    if KNOWN_SCHEMES.contains(&name.as_str()) || name == "javascript" {
        return None;
    }
    let port: u32 = host.port.get(1..).and_then(|p| p.parse().ok()).unwrap_or(0);
    if !host.port.is_empty() && !(1..=65535).contains(&port) {
        return None;
    }
    let dotted = name.contains('.') && !name.bytes().all(|b| b.is_ascii_digit() || b == b'.');
    let ip = name.starts_with('[') || is_ipv4(&name);
    let local = name == "localhost"
        || ip
        || (!host.port.is_empty()
            && !(dotted && !is_local_host(&name) && (port == 80 || port == 443)));
    if !dotted && !local {
        return None;
    }
    let rest = &input[host.authority.len()..];
    let wiki = name.strip_suffix(".org").is_some_and(|site| {
        WIKI_SITES
            .iter()
            .any(|w| site == *w || site.ends_with(&format!(".{w}")))
    }) && rest
        .strip_prefix("/wiki/")
        .and_then(|r| r.chars().next())
        .is_some_and(|c| !c.is_whitespace() && !"/?#".contains(c));
    Some(Spaced {
        escaped: input.replace(' ', "%20"),
        certain: local || wiki || has_query_key(rest),
    })
}

fn fixup(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let spaced = spaced_address(trimmed);
    let input = match &spaced {
        Some(s) if s.certain => s.escaped.as_str(),
        _ => trimmed,
    };
    if input.is_empty() {
        return None;
    }
    if input.chars().any(char::is_whitespace) {
        let schemed = scheme_of(input).is_some_and(|s| input[s.len()..].starts_with("://"));
        let rooted = input.starts_with('/')
            && input[1..]
                .chars()
                .next()
                .is_some_and(|c| !c.is_whitespace() && c != '/');
        if !schemed && !rooted {
            return None;
        }
    }
    if PASSTHROUGH.iter().any(|p| starts_with_ci(input, p)) {
        return Some(input.to_owned());
    }
    let scheme = scheme_of(input).map(str::to_ascii_lowercase);
    if let Some(scheme) = &scheme {
        let rest = &input[scheme.len() + 1..];
        if is_known_scheme(scheme)
            && (rest.starts_with("//") || !rest.starts_with(|c: char| c.is_ascii_digit()))
        {
            return Some(format!(
                "{scheme}:{}",
                rest.split(char::is_whitespace)
                    .collect::<Vec<_>>()
                    .join("%20")
            ));
        }
        if !is_known_scheme(scheme) && rest.starts_with("//") {
            return Some(input.to_owned());
        }
    }
    if input.starts_with('/') && !input.starts_with("//") {
        return Some(format!(
            "file://{}",
            input
                .split(char::is_whitespace)
                .collect::<Vec<_>>()
                .join("%20")
        ));
    }
    if !input.contains(['.', ':', '/', '?', '#', '[']) {
        return input
            .eq_ignore_ascii_case("localhost")
            .then(|| format!("http://{input}"));
    }
    let host = match_host(input)?;
    let name = host.name.to_lowercase();
    let numeric = name.bytes().all(|b| b.is_ascii_digit() || b == b'.');
    if numeric && !name.contains('.') {
        return None;
    }
    let dotted = name.contains('.') && !numeric && !name.starts_with('[');
    let tld = if dotted {
        &name[name.rfind('.').map_or(0, |i| i + 1)..]
    } else {
        ""
    };
    let rest = &input[host.authority.len()..];
    let special = name == "localhost" || name.starts_with('[') || numeric;
    let proto = if is_local_host(&name) {
        "http"
    } else {
        "https"
    };
    if special || (dotted && (known_tld(tld) || tld.starts_with("xn--"))) {
        return Some(format!("{proto}://{input}"));
    }
    if host.port.is_empty() && !rest.contains(['/', '?', '#']) {
        return None;
    }
    let path_end = rest.find(['?', '#']).unwrap_or(rest.len());
    let path = &rest[..path_end];
    let query = rest[path_end..]
        .split('#')
        .next()
        .filter(|q| q.starts_with('?'))
        .unwrap_or("");
    let fragment = rest.find('#').map_or("", |at| &rest[at..]);
    let parts = usize::from(!host.port.is_empty())
        + usize::from(!path.is_empty())
        + usize::from(query.len() > 1)
        + usize::from(fragment.len() > 1);
    (!host.port.is_empty() || path.ends_with('/') || parts > 1)
        .then(|| format!("{proto}://{input}"))
}

pub fn is_javascript_url(url: &str) -> bool {
    let cleaned: String = url
        .trim_start_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let bare = if starts_with_ci(&cleaned, "view-source:") {
        &cleaned["view-source:".len()..]
    } else {
        cleaned.as_str()
    };
    starts_with_ci(bare, "javascript:")
}

pub fn without_javascript_scheme(text: &str) -> &str {
    let mut out = text;
    loop {
        let stripped = out.trim_start_matches(|c: char| c <= ' ' || c == '\u{7f}');
        if starts_with_ci(stripped, "javascript:") {
            out = &stripped["javascript:".len()..];
        } else {
            return out;
        }
    }
}

pub fn fixup_url(raw: &str) -> Option<String> {
    fixup(raw)
        .filter(|url| !is_javascript_url(url))
        .map(|url| to_app_url(&url))
}

pub fn spaced_address_guess(raw: &str) -> Option<String> {
    spaced_address(raw.trim())
        .filter(|s| !s.certain)
        .and_then(|s| fixup_url(&s.escaped))
}

pub fn encode_uri_component(text: &str) -> String {
    utf8_percent_encode(text, URI_COMPONENT).to_string()
}

pub fn search_url_for(template: &str, query: &str) -> String {
    let q = encode_uri_component(query.trim());
    if template.contains("%s") {
        template.replace("%s", &q)
    } else {
        format!("{template}{q}")
    }
}

pub fn resolve_input(raw: &str, search_template: &str) -> String {
    let input = raw.trim();
    if input.is_empty() {
        return String::new();
    }
    if let Some(query) = input.strip_prefix('?') {
        return if query.is_empty() {
            String::new()
        } else {
            search_url_for(search_template, query)
        };
    }
    fixup_url(input).unwrap_or_else(|| search_url_for(search_template, input))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputKind {
    Url(String),
    Search(String),
}

pub fn classify(raw: &str) -> InputKind {
    let input = raw.trim();
    match input.strip_prefix('?') {
        Some(query) => InputKind::Search(query.trim().to_owned()),
        None => {
            fixup_url(input).map_or_else(|| InputKind::Search(input.to_owned()), InputKind::Url)
        }
    }
}

fn split_app<'a>(url: &'a str, scheme: &str) -> Option<(&'a str, String, &'a str)> {
    let (view_source, rest) = if starts_with_ci(url, "view-source:") {
        ("view-source:", &url["view-source:".len()..])
    } else {
        ("", url)
    };
    if !starts_with_ci(rest, scheme) || !rest[scheme.len()..].starts_with(':') {
        return None;
    }
    let after = &rest[scheme.len() + 1..];
    let after = after.strip_prefix("//").unwrap_or(after);
    let host_end = after.find(['/', '?', '#']).unwrap_or(after.len());
    Some((
        view_source,
        after[..host_end].to_lowercase(),
        &after[host_end..],
    ))
}

pub fn to_app_url(url: &str) -> String {
    if let Some((view_source, host, rest)) =
        split_app(url, APP_SCHEME).or_else(|| split_app(url, "chrome"))
    {
        return if host.is_empty() {
            url.to_owned()
        } else {
            format!("{view_source}{APP_SCHEME}://{host}{rest}")
        };
    }
    if !starts_with_ci(url, "about:") {
        return url.to_owned();
    }
    let page = &url["about:".len()..];
    let name_end = page
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .unwrap_or(page.len());
    let name = &page[..name_end];
    let blank = name.eq_ignore_ascii_case("blank") || name.eq_ignore_ascii_case("srcdoc");
    if name.is_empty()
        || !name.starts_with(|c: char| c.is_ascii_alphabetic())
        || (blank
            && page[name_end..]
                .chars()
                .next()
                .is_none_or(|c| c == '?' || c == '#'))
    {
        return url.to_owned();
    }
    format!(
        "{APP_SCHEME}://{}{}",
        name.to_lowercase(),
        &page[name_end..]
    )
}

pub fn to_engine_url(url: &str) -> String {
    match split_app(url, APP_SCHEME) {
        Some((view_source, host, rest)) if !host.is_empty() => {
            format!("{view_source}chrome://{host}{rest}")
        }
        _ => url.to_owned(),
    }
}

pub fn app_url_origin(url: &str) -> Option<String> {
    let app = to_app_url(url);
    let rest = app.strip_prefix("ardia://")?;
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    (host_end > 0).then(|| format!("{APP_SCHEME}://{}", &rest[..host_end]))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppRoute {
    Page(&'static str),
    Settings(Option<String>),
    NewTab,
    Engine(String),
}

pub fn app_url_route(url: &str) -> Option<AppRoute> {
    let rest = url
        .strip_prefix("ardia://")
        .filter(|r| !r.is_empty() && !r.starts_with(['/', '?', '#']))?;
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host = rest[..host_end].to_lowercase();
    if let Some(page) = APP_PAGES.iter().find(|p| **p == host) {
        return Some(AppRoute::Page(page));
    }
    match host.as_str() {
        "newtab" => Some(AppRoute::NewTab),
        "settings" => {
            let path = &rest[host_end..];
            let path = &path[..path.find(['?', '#']).unwrap_or(path.len())];
            Some(AppRoute::Settings(
                path.split('/').find(|s| !s.is_empty()).map(str::to_owned),
            ))
        }
        _ => Some(AppRoute::Engine(to_engine_url(url))),
    }
}

pub fn host_of(url: &str) -> String {
    let Some(scheme) = scheme_of(url.trim()) else {
        return String::new();
    };
    let rest = &url.trim()[scheme.len() + 1..];
    let Some(rest) = rest.strip_prefix("//") else {
        return String::new();
    };
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = if authority.starts_with('[') {
        &authority[..authority.find(']').map_or(authority.len(), |i| i + 1)]
    } else {
        authority.split(':').next().unwrap_or("")
    };
    let host = host.to_lowercase();
    host.strip_prefix("www.").map(str::to_owned).unwrap_or(host)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Script {
    Common,
    Latin,
    Greek,
    Cyrillic,
    Other(u32),
}

fn script_of(c: char) -> Script {
    let n = c as u32;
    match n {
        0x30..=0x39 | 0x2D => Script::Common,
        0x41..=0x5A | 0x61..=0x7A | 0xC0..=0x24F | 0x1E00..=0x1EFF => Script::Latin,
        0x370..=0x3FF | 0x1F00..=0x1FFF => Script::Greek,
        0x400..=0x52F | 0x2DE0..=0x2DFF | 0xA640..=0xA69F => Script::Cyrillic,
        _ => Script::Other(n >> 7),
    }
}

fn mixed_scripts(label: &str) -> bool {
    let mut seen: Option<Script> = None;
    for script in label
        .chars()
        .map(script_of)
        .filter(|s| *s != Script::Common)
    {
        match seen {
            None => seen = Some(script),
            Some(previous) if previous != script => return true,
            _ => {}
        }
    }
    false
}

pub fn display_host(host: &str) -> String {
    if !host.split('.').any(|label| starts_with_ci(label, "xn--")) {
        return host.to_owned();
    }
    let labels: Vec<String> = host.to_lowercase().split('.').map(str::to_owned).collect();
    let tld = labels
        .iter()
        .rev()
        .find(|l| !l.is_empty())
        .cloned()
        .unwrap_or_default();
    let cyrillic_tld = [
        "ru",
        "su",
        "ua",
        "by",
        "kz",
        "bg",
        "rs",
        "mk",
        "mn",
        "xn--p1ai",
        "xn--90ais",
        "xn--j1amh",
    ]
    .contains(&tld.as_str());
    let shown: Vec<String> = labels
        .iter()
        .map(|label| {
            let Some(code) = label.strip_prefix("xn--") else {
                return label.clone();
            };
            match idna::punycode::decode_to_string(code) {
                Some(unicode)
                    if !mixed_scripts(&unicode)
                        && (cyrillic_tld
                            || !unicode.chars().any(|c| script_of(c) == Script::Cyrillic)) =>
                {
                    unicode
                }
                _ => label.clone(),
            }
        })
        .collect();
    shown.join(".")
}

pub fn url_for_display(url: &str) -> String {
    if app_url_origin(url).is_some() {
        let app = to_app_url(url);
        let rest = &app["ardia://".len()..];
        let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let tail = &rest[host_end..];
        let tail = if tail == "/" || tail.starts_with("/?") || tail.starts_with("/#") {
            &tail[1..]
        } else {
            tail
        };
        return format!("ardia://{}{tail}", &rest[..host_end]);
    }
    let rest = match scheme_of(url) {
        Some(scheme) if url[scheme.len()..].starts_with("://") => {
            let after = &url[scheme.len() + 3..];
            let authority_end = after.find(['/', '?', '#']).unwrap_or(after.len());
            match after[..authority_end].rfind('@') {
                Some(at) => &after[at + 1..],
                None => after,
            }
        }
        _ => url,
    };
    let host_end = rest.find(['/', '?', '#', ':']).unwrap_or(rest.len());
    let shown = format!("{}{}", display_host(&rest[..host_end]), &rest[host_end..]);
    if starts_with_ci(&shown, "www.") {
        shown[4..].to_owned()
    } else {
        shown
    }
}

pub fn display_url(url: &str) -> String {
    let shown = url_for_display(url);
    shown.strip_suffix('/').map(str::to_owned).unwrap_or(shown)
}

pub fn breadcrumb_host(url: &str) -> String {
    if let Some(app) = app_url_origin(url) {
        return app;
    }
    match url::Url::parse(url) {
        Ok(parsed) => {
            let host = display_host(parsed.host_str().unwrap_or(""));
            let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
            match parsed.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            }
        }
        Err(_) => url.to_owned(),
    }
}

const TRACKING_PARAMS: [&str; 52] = [
    "gclid",
    "gclsrc",
    "dclid",
    "gbraid",
    "wbraid",
    "gad_source",
    "gad_campaignid",
    "_ga",
    "_gl",
    "srsltid",
    "fbclid",
    "igshid",
    "msclkid",
    "twclid",
    "ttclid",
    "li_fat_id",
    "yclid",
    "ysclid",
    "rdt_cid",
    "epik",
    "mc_cid",
    "mc_eid",
    "_hsenc",
    "_hsmi",
    "__hssc",
    "__hstc",
    "__hsfp",
    "hsctatracking",
    "mkt_tok",
    "elqtrackid",
    "elqtrack",
    "vero_id",
    "vero_conv",
    "_kx",
    "__s",
    "oly_anon_id",
    "oly_enc_id",
    "_openstat",
    "wickedid",
    "rb_clickid",
    "s_cid",
    "irclickid",
    "cjevent",
    "sscid",
    "zanpid",
    "ranmid",
    "raneaid",
    "ransiteid",
    "trk_contact",
    "trk_msg",
    "trk_module",
    "trk_sid",
];
const TRACKING_PREFIXES: [&str; 7] = ["utm_", "pk_", "mtm_", "piwik_", "matomo_", "hsa_", "stm_"];
const AMAZON: [&str; 10] = [
    "amazon.com",
    "amazon.co.uk",
    "amazon.de",
    "amazon.fr",
    "amazon.it",
    "amazon.es",
    "amazon.ca",
    "amazon.co.jp",
    "amazon.in",
    "amazon.com.au",
];
const SITE_TRACKERS: [(&[&str], &[&str], &[&str]); 11] = [
    (
        &["youtube.com", "youtu.be", "music.youtube.com"],
        &["si", "pp", "feature"],
        &[],
    ),
    (&["open.spotify.com"], &["si", "nd", "context"], &[]),
    (&["instagram.com"], &["igsh", "img_index"], &[]),
    (
        &["x.com", "twitter.com"],
        &["s", "t", "ref_src", "ref_url"],
        &[],
    ),
    (&["threads.net", "threads.com"], &["xmt", "slof"], &[]),
    (
        &["tiktok.com"],
        &[
            "is_from_webapp",
            "sender_device",
            "sender_web_id",
            "_r",
            "_t",
        ],
        &[],
    ),
    (
        &["linkedin.com"],
        &[
            "trk",
            "trackingid",
            "lipi",
            "midtoken",
            "midsig",
            "trkemail",
            "eid",
        ],
        &[],
    ),
    (
        &["reddit.com"],
        &["share_id", "ref_source", "ref_campaign"],
        &[],
    ),
    (&["medium.com"], &["source"], &[]),
    (
        &["facebook.com"],
        &["mibextid", "sfnsn", "rdid", "share_url"],
        &[],
    ),
    (
        &AMAZON,
        &[
            "_encoding",
            "psc",
            "ref",
            "ref_",
            "tag",
            "linkcode",
            "linkid",
            "camp",
            "creative",
            "creativeasin",
            "content-id",
            "crid",
            "sprefix",
            "qid",
            "sr",
            "dib",
            "dib_tag",
        ],
        &["pd_rd_", "pf_rd_"],
    ),
];

fn tracks(name: &str, host: &str) -> bool {
    let key = percent_encoding::percent_decode_str(&name.replace('+', " "))
        .decode_utf8_lossy()
        .to_lowercase();
    if TRACKING_PARAMS.contains(&key.as_str())
        || TRACKING_PREFIXES.iter().any(|p| key.starts_with(p))
    {
        return true;
    }
    let host = host.strip_prefix("www.").unwrap_or(host);
    SITE_TRACKERS.iter().any(|(hosts, params, prefixes)| {
        hosts
            .iter()
            .any(|h| host == *h || host.ends_with(&format!(".{h}")))
            && (params.contains(&key.as_str()) || prefixes.iter().any(|p| key.starts_with(p)))
    })
}

pub fn clean_url(url: &str) -> String {
    let Some(q) = url
        .find('?')
        .filter(|q| url.find('#').is_none_or(|h| *q < h))
    else {
        return url.to_owned();
    };
    let Ok(parsed) = url::Url::parse(url) else {
        return url.to_owned();
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return url.to_owned();
    }
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let hash_at = url[q..].find('#').map_or(url.len(), |h| q + h);
    let pairs: Vec<&str> = url[q + 1..hash_at].split('&').collect();
    let kept: Vec<&str> = pairs
        .iter()
        .copied()
        .filter(|pair| !pair.is_empty() && !tracks(pair.split('=').next().unwrap_or(""), &host))
        .collect();
    if kept.len() == pairs.len() {
        return url.to_owned();
    }
    let query = if kept.is_empty() {
        String::new()
    } else {
        format!("?{}", kept.join("&"))
    };
    format!("{}{query}{}", &url[..q], &url[hash_at..])
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PasteAction {
    Go(String),
    Search(String),
}

pub fn classify_paste(text: &str) -> Option<PasteAction> {
    let trimmed = without_javascript_scheme(text.trim()).trim();
    if trimmed.is_empty() {
        return None;
    }
    let spaced_ok = !trimmed.chars().any(char::is_whitespace)
        || spaced_address(trimmed).is_some_and(|s| s.certain);
    let url = if spaced_ok { fixup_url(trimmed) } else { None };
    match url {
        Some(url) if !starts_with_ci(&url, "about:") && !starts_with_ci(&url, "data:") => {
            Some(PasteAction::Go(clean_url(&url)))
        }
        _ => Some(PasteAction::Search(
            trimmed
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(2000)
                .collect(),
        )),
    }
}

pub fn same_address(a: &str, b: &str) -> bool {
    let key = |u: &str| {
        url::Url::parse(u.trim())
            .map(|p| p.to_string())
            .unwrap_or_else(|_| u.trim().to_owned())
    };
    key(a) == key(b)
}

pub fn same_page(a: &str, b: &str) -> bool {
    let page = |u: &str| u.split_once('#').map_or(u, |(page, _)| page).to_owned();
    page(a) == page(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const GOOGLE: &str = "https://www.google.com/search?q=%s";

    #[test]
    fn hosts_and_tlds_become_https_urls() {
        assert_eq!(fixup_url("github.com"), Some("https://github.com".into()));
        assert_eq!(
            fixup_url("github.com/ardia"),
            Some("https://github.com/ardia".into())
        );
        assert_eq!(
            fixup_url("news.ycombinator.com/item?id=1"),
            Some("https://news.ycombinator.com/item?id=1".into())
        );
        assert_eq!(
            fixup_url("xn--80ak6aa92e.com"),
            Some("https://xn--80ak6aa92e.com".into())
        );
        assert_eq!(fixup_url("example.notatld"), None);
        assert_eq!(
            fixup_url("example.notatld/path/"),
            Some("https://example.notatld/path/".into())
        );
    }

    #[test]
    fn local_addresses_ports_and_ips_use_http() {
        assert_eq!(fixup_url("localhost"), Some("http://localhost".into()));
        assert_eq!(
            fixup_url("localhost:3000"),
            Some("http://localhost:3000".into())
        );
        assert_eq!(fixup_url("192.168.1.1"), Some("http://192.168.1.1".into()));
        assert_eq!(fixup_url("[::1]:8080"), Some("http://[::1]:8080".into()));
        assert_eq!(fixup_url("router.lan"), Some("http://router.lan".into()));
        assert_eq!(fixup_url("devbox:8080"), Some("http://devbox:8080".into()));
        assert_eq!(fixup_url("1234"), None);
        assert_eq!(fixup_url("1.2.3.4.5"), None);
    }

    #[test]
    fn schemes_files_and_internal_pages() {
        assert_eq!(
            fixup_url("https://Example.com/A B"),
            Some("https://Example.com/A%20B".into())
        );
        assert_eq!(fixup_url("HTTP://x.org"), Some("http://x.org".into()));
        assert_eq!(
            fixup_url("/Users/me/My File.pdf"),
            Some("file:///Users/me/My%20File.pdf".into())
        );
        assert_eq!(fixup_url("about:blank"), Some("about:blank".into()));
        assert_eq!(fixup_url("about:settings"), Some("ardia://settings".into()));
        assert_eq!(fixup_url("ABOUT:BLANK#x"), Some("ABOUT:BLANK#x".into()));
        assert_eq!(
            fixup_url("ardia://settings/tabs"),
            Some("ardia://settings/tabs".into())
        );
        assert_eq!(
            fixup_url("chrome://extensions"),
            Some("ardia://extensions".into())
        );
        assert_eq!(
            fixup_url("mailto:me@example.com"),
            Some("mailto:me@example.com".into())
        );
        assert_eq!(fixup_url("javascript:alert(1)"), None);
        assert_eq!(fixup_url("  javascript:alert(1)"), None);
        assert_eq!(
            fixup_url("custom-app://do/thing"),
            Some("custom-app://do/thing".into())
        );
        assert_eq!(to_app_url("about:version"), "ardia://version");
        assert_eq!(to_engine_url("ardia://flags"), "chrome://flags");
    }

    #[test]
    fn plain_words_and_sentences_search() {
        assert_eq!(fixup_url("rust borrow checker"), None);
        assert_eq!(fixup_url("weather"), None);
        assert_eq!(
            resolve_input("rust lang", GOOGLE),
            "https://www.google.com/search?q=rust%20lang"
        );
        assert_eq!(
            resolve_input("?github.com", GOOGLE),
            "https://www.google.com/search?q=github.com"
        );
        assert_eq!(resolve_input("?", GOOGLE), "");
        assert_eq!(resolve_input("   ", GOOGLE), "");
        assert_eq!(
            classify("github.com"),
            InputKind::Url("https://github.com".into())
        );
        assert_eq!(
            classify("c++ & rust"),
            InputKind::Search("c++ & rust".into())
        );
    }

    #[test]
    fn spaced_addresses_need_certainty() {
        assert_eq!(
            fixup_url("en.wikipedia.org/wiki/New York"),
            Some("https://en.wikipedia.org/wiki/New%20York".into())
        );
        assert_eq!(
            fixup_url("example.com/search?q=a b"),
            Some("https://example.com/search?q=a%20b".into())
        );
        assert_eq!(fixup_url("example.com/some page"), None);
        assert_eq!(
            spaced_address_guess("example.com/some page"),
            Some("https://example.com/some%20page".into())
        );
        assert_eq!(
            fixup_url("localhost:3000/a b"),
            Some("http://localhost:3000/a%20b".into())
        );
    }

    #[test]
    fn search_templates_encode_like_encode_uri_component() {
        assert_eq!(
            search_url_for(GOOGLE, " a&b=c/ü "),
            "https://www.google.com/search?q=a%26b%3Dc%2F%C3%BC"
        );
        assert_eq!(
            search_url_for("https://x.example/?q=", "it's (ok)!"),
            "https://x.example/?q=it's%20(ok)!"
        );
        assert!(
            has_known_scheme("javascript:x")
                && has_known_scheme("foo://bar")
                && !has_known_scheme("foo:bar")
        );
    }

    #[test]
    fn app_routes_and_display_forms() {
        assert_eq!(
            app_url_route("ardia://history"),
            Some(AppRoute::Page("history"))
        );
        assert_eq!(
            app_url_route("ardia://settings/appearance?x=1"),
            Some(AppRoute::Settings(Some("appearance".into())))
        );
        assert_eq!(app_url_route("ardia://newtab"), Some(AppRoute::NewTab));
        assert_eq!(
            app_url_route("ardia://gpu"),
            Some(AppRoute::Engine("chrome://gpu".into()))
        );
        assert_eq!(app_url_route("https://x.com"), None);
        assert_eq!(
            app_url_origin("chrome://settings/x"),
            Some("ardia://settings".into())
        );
        assert_eq!(
            host_of("https://user@WWW.Example.com:8080/x"),
            "example.com"
        );
        assert_eq!(display_url("https://www.example.com/"), "example.com");
        assert_eq!(
            url_for_display("https://user:pw@www.example.com/a?b"),
            "example.com/a?b"
        );
        assert_eq!(display_url("ardia://settings/"), "ardia://settings");
        assert_eq!(breadcrumb_host("https://www.github.com/x"), "github.com");
        assert_eq!(breadcrumb_host("http://localhost:3000/"), "localhost:3000");
    }

    #[test]
    fn display_host_decodes_single_script_punycode_only() {
        assert_eq!(display_host("xn--mnchen-3ya.de"), "münchen.de");
        assert_eq!(display_host("xn--80ak6aa92e.com"), "xn--80ak6aa92e.com");
        assert_eq!(display_host("xn--80ak6aa92e.ru"), "аррӏе.ru");
        assert_eq!(display_host("example.com"), "example.com");
        assert_eq!(display_host("xn--ab$.com"), "xn--ab$.com");
    }

    #[test]
    fn tracking_parameters_are_stripped_from_pastes() {
        assert_eq!(
            clean_url("https://x.com/a?utm_source=a&id=3&fbclid=9#top"),
            "https://x.com/a?id=3#top"
        );
        assert_eq!(
            clean_url("https://www.youtube.com/watch?v=1&si=abc"),
            "https://www.youtube.com/watch?v=1"
        );
        assert_eq!(
            clean_url("https://shop.example/?si=keep"),
            "https://shop.example/?si=keep"
        );
        assert_eq!(clean_url("ftp://x/?utm_source=1"), "ftp://x/?utm_source=1");
        assert_eq!(
            clean_url("https://www.amazon.de/dp/1?pd_rd_w=x&th=1"),
            "https://www.amazon.de/dp/1?th=1"
        );
        assert_eq!(
            classify_paste(" https://a.com/?utm_medium=x "),
            Some(PasteAction::Go("https://a.com/".into()))
        );
        assert_eq!(
            classify_paste("javascript:javascript:evil.com"),
            Some(PasteAction::Go("https://evil.com".into()))
        );
        assert_eq!(
            classify_paste("two\n words"),
            Some(PasteAction::Search("two words".into()))
        );
        assert_eq!(classify_paste("   "), None);
    }

    proptest! {
        #[test]
        fn fixup_never_panics_and_never_returns_javascript(input in "\\PC{0,40}") {
            if let Some(url) = fixup_url(&input) {
                prop_assert!(!is_javascript_url(&url));
            }
            let _ = classify_paste(&input);
            let _ = display_url(&input);
            let _ = host_of(&input);
            let _ = clean_url(&input);
        }

        #[test]
        fn resolved_input_is_a_url_or_a_search(input in "[a-z .:/?#0-9]{1,30}") {
            let resolved = resolve_input(&input, GOOGLE);
            prop_assert!(resolved.is_empty() || resolved.contains("://") || resolved.starts_with("about:") || resolved.contains(':'));
        }
    }
}
