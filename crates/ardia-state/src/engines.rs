use crate::model::PageEngine;
use crate::settings::{EngineMode, Settings};
use crate::state::BrowserState;
use crate::tabs::Tab;

pub const RECOMMENDED_ENGINE: PageEngine = PageEngine::Chromium;
pub const SITE_MOVE_SPACING_MS: u64 = 10_000;

pub const PROTECTED_VIDEO_SITES: &[&str] = &[
    "netflix.com",
    "disneyplus.com",
    "max.com",
    "hbomax.com",
    "primevideo.com",
    "hulu.com",
    "tv.apple.com",
    "music.apple.com",
    "open.spotify.com",
    "peacocktv.com",
    "paramountplus.com",
    "crunchyroll.com",
    "hotstar.com",
    "jiohotstar.com",
    "v.qq.com",
    "audible.com",
    "audible.co.uk",
    "audible.ca",
    "audible.com.au",
    "audible.de",
    "audible.fr",
    "audible.it",
    "audible.es",
    "audible.co.jp",
    "audible.in",
    "audible.com.br",
    "canalplus.com",
    "mycanal.fr",
    "tv.youtube.com",
    "osnplus.com",
    "anghami.com",
];

pub fn engine_name(engine: PageEngine) -> &'static str {
    match engine {
        PageEngine::Chromium => "Chromium",
        PageEngine::Webkit => "WebKit",
    }
}

pub fn engine_symbol(engine: PageEngine) -> &'static str {
    match engine {
        PageEngine::Chromium => "globe",
        PageEngine::Webkit => "safari",
    }
}

pub fn other_engine(engine: PageEngine) -> PageEngine {
    match engine {
        PageEngine::Webkit => PageEngine::Chromium,
        PageEngine::Chromium => PageEngine::Webkit,
    }
}

pub fn mode_name(mode: EngineMode) -> &'static str {
    match mode {
        EngineMode::Automatic => "Automatic",
        EngineMode::Chromium => "Chromium",
        EngineMode::Webkit => "WebKit",
    }
}

pub fn site_of(url: &str) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?;
    let site = match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    };
    Some(site.to_lowercase())
}

pub fn site_label(site: &str) -> &str {
    site.strip_prefix("https://").unwrap_or(site)
}

pub fn host_label(site: &str) -> String {
    url::Url::parse(site)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .map(|host| host.strip_prefix("www.").unwrap_or(&host).to_owned())
        .unwrap_or_else(|| site.to_owned())
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

pub fn is_web_page_url(url: &str) -> bool {
    ["http:", "https:", "file:"]
        .iter()
        .any(|scheme| starts_with_ignore_case(url, scheme))
}

pub fn chromium_only(url: &str) -> bool {
    [
        "ardia:",
        "chrome:",
        "chrome-extension:",
        "chrome-untrusted:",
        "devtools:",
        "view-source:",
    ]
    .iter()
    .any(|scheme| starts_with_ignore_case(url, scheme))
}

pub fn web_store_page(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    [
        "https://chromewebstore.google.com",
        "https://chrome.google.com/webstore",
    ]
    .iter()
    .any(|prefix| {
        lower.strip_prefix(prefix).is_some_and(|rest| {
            rest.is_empty()
                || rest.starts_with('/')
                || rest.starts_with('?')
                || rest.starts_with('#')
        })
    })
}

pub fn google_sign_in(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower
        .strip_prefix("https://accounts.google.com")
        .is_some_and(|rest| {
            rest.is_empty()
                || rest.starts_with('/')
                || rest.starts_with('?')
                || rest.starts_with('#')
        })
}

pub fn needs_chromium(url: &str) -> bool {
    chromium_only(url) || web_store_page(url)
}

pub fn can_switch_engine(url: &str) -> bool {
    !url.is_empty() && is_web_page_url(url) && !web_store_page(url)
}

pub fn engine_mode(settings: &Settings) -> EngineMode {
    settings.engine_mode
}

pub fn single_engine(settings: &Settings) -> Option<PageEngine> {
    match settings.engine_mode {
        EngineMode::Automatic => None,
        EngineMode::Chromium => Some(PageEngine::Chromium),
        EngineMode::Webkit => Some(PageEngine::Webkit),
    }
}

fn mode_engine(settings: &Settings, url: &str) -> Option<PageEngine> {
    single_engine(settings).map(|only| {
        if needs_chromium(url) {
            PageEngine::Chromium
        } else {
            only
        }
    })
}

pub fn switchable_engine(settings: &Settings, url: &str) -> bool {
    single_engine(settings).is_none() && can_switch_engine(url)
}

pub fn default_engine(settings: &Settings) -> PageEngine {
    single_engine(settings).unwrap_or(settings.page_engine)
}

pub fn rule_for(settings: &Settings, url: &str) -> Option<PageEngine> {
    let site = site_of(url)?;
    if single_engine(settings).is_some() {
        return None;
    }
    settings.website_engines.get(&site).copied()
}

pub fn protected_video_site(url: &str) -> bool {
    let Some(site) = site_of(url) else {
        return false;
    };
    let Some(rest) = site.strip_prefix("https://") else {
        return false;
    };
    let host = rest.rsplit_once(':').map_or(rest, |(host, port)| {
        if port.chars().all(|c| c.is_ascii_digit()) {
            host
        } else {
            rest
        }
    });
    PROTECTED_VIDEO_SITES.iter().any(|domain| {
        host == *domain
            || host
                .strip_suffix(domain)
                .is_some_and(|front| front.ends_with('.'))
    })
}

pub fn built_in_engine(settings: &Settings, url: &str) -> Option<PageEngine> {
    (single_engine(settings).is_none()
        && settings.protected_video_in_webkit
        && protected_video_site(url))
    .then_some(PageEngine::Webkit)
}

pub fn chosen_engine(settings: &Settings, url: &str) -> Option<PageEngine> {
    mode_engine(settings, url)
        .or_else(|| web_store_page(url).then_some(PageEngine::Chromium))
        .or_else(|| rule_for(settings, url))
        .or_else(|| built_in_engine(settings, url))
}

pub fn recommended_engine_for(settings: &Settings, url: &str) -> PageEngine {
    mode_engine(settings, url)
        .or_else(|| built_in_engine(settings, url))
        .unwrap_or_else(|| default_engine(settings))
}

pub fn engine_for_url(settings: &Settings, url: &str) -> PageEngine {
    chosen_engine(settings, url).unwrap_or_else(|| default_engine(settings))
}

fn page_url(tab: &Tab) -> &str {
    tab.live.navigation.as_deref().unwrap_or(&tab.url)
}

pub fn current_url(tab: &Tab) -> &str {
    if tab.url.is_empty() {
        tab.live.navigation.as_deref().unwrap_or("")
    } else {
        &tab.url
    }
}

pub fn driven_by_chrome(state: &BrowserState, tab: &Tab, depth: usize) -> bool {
    if tab.chrome_opened {
        return true;
    }
    let _ = (state, depth);
    false
}

fn engine_of(state: &BrowserState, tab: &Tab, depth: usize) -> PageEngine {
    let settings = &state.settings;
    let url = page_url(tab);
    if needs_chromium(url) {
        return PageEngine::Chromium;
    }
    let only = single_engine(settings);
    if only == Some(PageEngine::Webkit) && driven_by_chrome(state, tab, depth) {
        return PageEngine::Chromium;
    }
    if let Some(only) = only {
        return only;
    }
    if let Some(engine) = tab.engine {
        return engine;
    }
    if let Some(chosen) = chosen_engine(settings, url) {
        return chosen;
    }
    let opener = tab.opener_id.as_ref().and_then(|id| state.tab(id.as_str()));
    if let Some(opener) = opener
        && let Some(engine) = opener.engine
        && (!opener.url.is_empty() || opener.live.navigation.is_some())
    {
        return engine;
    }
    default_engine(settings)
}

pub fn tab_engine(state: &BrowserState, tab_id: &str) -> PageEngine {
    state.tab(tab_id).map_or_else(
        || default_engine(&state.settings),
        |tab| engine_of(state, tab, 0),
    )
}

pub fn engine_under_mode(state: &BrowserState, settings: &Settings, tab: &Tab) -> PageEngine {
    let url = page_url(tab);
    match single_engine(settings) {
        Some(only) => {
            if needs_chromium(url)
                || (only == PageEngine::Webkit && driven_by_chrome(state, tab, 0))
            {
                PageEngine::Chromium
            } else {
                only
            }
        }
        None => {
            if needs_chromium(url) || driven_by_chrome(state, tab, 0) {
                PageEngine::Chromium
            } else {
                engine_for_url(settings, url)
            }
        }
    }
}

pub fn mode_engine_for(state: &BrowserState, tab: &Tab, url: &str) -> Option<PageEngine> {
    let only = single_engine(&state.settings)?;
    if needs_chromium(url) {
        return Some(PageEngine::Chromium);
    }
    Some(
        if only == PageEngine::Webkit && driven_by_chrome(state, tab, 0) {
            PageEngine::Chromium
        } else {
            only
        },
    )
}

pub fn typed_navigation_engine(state: &BrowserState, tab: &Tab, url: &str) -> PageEngine {
    if needs_chromium(url) {
        return PageEngine::Chromium;
    }
    if let Some(chosen) = chosen_engine(&state.settings, url) {
        return chosen;
    }
    if !tab.url.is_empty() || tab.live.navigation.is_some() {
        tab_engine(state, tab.id.as_str())
    } else {
        default_engine(&state.settings)
    }
}

pub fn engine_mark(state: &BrowserState, tab_id: &str) -> Option<PageEngine> {
    let tab = state.tab(tab_id)?;
    if !switchable_engine(&state.settings, current_url(tab)) {
        return None;
    }
    let engine = tab_engine(state, tab_id);
    (engine != default_engine(&state.settings)).then_some(engine)
}

pub fn toggle_title(state: &BrowserState, tab_id: Option<&str>) -> (&'static str, bool) {
    let tab = tab_id.and_then(|id| state.tab(id));
    let webkit = tab.is_some_and(|t| tab_engine(state, t.id.as_str()) == PageEngine::Webkit);
    let enabled = tab.is_some_and(|t| switchable_engine(&state.settings, &t.url));
    (
        if webkit {
            "Open Page in Chromium"
        } else {
            "Open Page in WebKit"
        },
        enabled,
    )
}

pub fn tab_menu_engine_item(state: &BrowserState, tab: &Tab) -> Option<String> {
    switchable_engine(&state.settings, &tab.url).then(|| {
        format!(
            "Open in {}",
            engine_name(other_engine(tab_engine(state, tab.id.as_str())))
        )
    })
}

pub fn engine_mode_footer(
    mode: EngineMode,
    switching: bool,
    default_engine: PageEngine,
    streaming_in_webkit: bool,
) -> String {
    if switching {
        return "Switching…".into();
    }
    match mode {
        EngineMode::Chromium => "Opens every page in Chromium (no FairPlay video).".into(),
        EngineMode::Webkit => "Opens pages in WebKit (no extensions).".into(),
        EngineMode::Automatic => {
            let opens = format!("Most pages open in {}.", engine_name(default_engine));
            if streaming_in_webkit && default_engine == PageEngine::Chromium {
                format!("{opens} Streaming sites open in WebKit to play protected video.")
            } else {
                opens
            }
        }
    }
}

pub fn with_website_engine(
    rules: &indexmap::IndexMap<String, PageEngine>,
    url: &str,
    engine: Option<PageEngine>,
) -> Option<indexmap::IndexMap<String, PageEngine>> {
    let site = site_of(url)?;
    let mut next = rules.clone();
    match engine {
        Some(engine) => {
            next.insert(site, engine);
        }
        None => {
            next.shift_remove(&site);
        }
    }
    Some(next)
}

pub fn rule_site_from_input(typed: &str) -> Option<String> {
    let typed = typed.trim();
    if typed.is_empty() {
        return None;
    }
    let has_scheme = typed.split_once("://").is_some_and(|(scheme, _)| {
        let mut chars = scheme.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-' | '_'))
    });
    if has_scheme {
        return site_of(typed);
    }
    if typed.contains(char::is_whitespace)
        || !typed.contains('.') && !typed.starts_with("localhost")
    {
        return None;
    }
    site_of(&format!("https://{typed}"))
}

pub fn streaming_sites_description(shown: usize) -> String {
    let listed = PROTECTED_VIDEO_SITES
        .iter()
        .take(shown)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    let more = PROTECTED_VIDEO_SITES.len().saturating_sub(shown);
    let more = if more > 0 {
        format!(" and {more} more")
    } else {
        String::new()
    };
    format!("{listed}{more} open in WebKit, which plays their protected video.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        Settings::default()
    }

    #[test]
    fn sites_are_scheme_host_and_port() {
        assert_eq!(
            site_of("https://WWW.Netflix.com/browse?x=1").as_deref(),
            Some("https://www.netflix.com")
        );
        assert_eq!(
            site_of("http://localhost:8080/a").as_deref(),
            Some("http://localhost:8080")
        );
        assert_eq!(site_of("file:///tmp/a.html"), None);
        assert_eq!(site_of(""), None);
        assert_eq!(host_label("https://www.netflix.com"), "netflix.com");
        assert_eq!(site_label("https://netflix.com"), "netflix.com");
    }

    #[test]
    fn chromium_pages_and_the_web_store_never_switch() {
        assert!(needs_chromium("chrome://settings"));
        assert!(needs_chromium("ardia://newtab"));
        assert!(needs_chromium("https://chromewebstore.google.com/detail/x"));
        assert!(!needs_chromium(
            "https://chromewebstore.google.com.evil.com/"
        ));
        assert!(can_switch_engine("https://example.com"));
        assert!(can_switch_engine("file:///tmp/a.html"));
        assert!(!can_switch_engine("https://chrome.google.com/webstore"));
        assert!(!can_switch_engine("about:blank"));
    }

    #[test]
    fn streaming_sites_open_in_webkit_under_automatic() {
        let mut s = settings();
        assert_eq!(
            engine_for_url(&s, "https://www.netflix.com/watch/1"),
            PageEngine::Webkit
        );
        assert_eq!(
            engine_for_url(&s, "https://netflix.com.evil.com/"),
            PageEngine::Chromium
        );
        assert_eq!(
            engine_for_url(&s, "http://netflix.com/"),
            PageEngine::Chromium
        );
        s.protected_video_in_webkit = false;
        assert_eq!(
            engine_for_url(&s, "https://www.netflix.com/"),
            PageEngine::Chromium
        );
        s.website_engines
            .insert("https://example.com".into(), PageEngine::Webkit);
        assert_eq!(
            engine_for_url(&s, "https://example.com/a"),
            PageEngine::Webkit
        );
        assert_eq!(
            engine_for_url(&s, "https://sub.example.com/a"),
            PageEngine::Chromium
        );
        s.engine_mode = EngineMode::Chromium;
        assert_eq!(
            engine_for_url(&s, "https://example.com/a"),
            PageEngine::Chromium
        );
        s.engine_mode = EngineMode::Webkit;
        assert_eq!(engine_for_url(&s, "https://other.com/"), PageEngine::Webkit);
        assert_eq!(engine_for_url(&s, "chrome://flags"), PageEngine::Chromium);
        assert_eq!(
            engine_for_url(&s, "https://chromewebstore.google.com/"),
            PageEngine::Chromium
        );
    }

    #[test]
    fn footer_copy_matches_the_old_app() {
        assert_eq!(
            engine_mode_footer(EngineMode::Automatic, false, PageEngine::Chromium, true),
            "Most pages open in Chromium. Streaming sites open in WebKit to play protected video."
        );
        assert_eq!(
            engine_mode_footer(EngineMode::Automatic, false, PageEngine::Webkit, true),
            "Most pages open in WebKit."
        );
        assert_eq!(
            engine_mode_footer(EngineMode::Chromium, false, PageEngine::Chromium, true),
            "Opens every page in Chromium (no FairPlay video)."
        );
        assert_eq!(
            engine_mode_footer(EngineMode::Webkit, false, PageEngine::Webkit, true),
            "Opens pages in WebKit (no extensions)."
        );
        assert_eq!(
            engine_mode_footer(EngineMode::Webkit, true, PageEngine::Webkit, true),
            "Switching…"
        );
        assert_eq!(
            streaming_sites_description(5),
            "netflix.com, disneyplus.com, max.com, hbomax.com, primevideo.com and 26 more open in WebKit, which plays their protected video."
        );
    }

    #[test]
    fn rules_are_typed_as_sites() {
        assert_eq!(
            rule_site_from_input("netflix.com").as_deref(),
            Some("https://netflix.com")
        );
        assert_eq!(
            rule_site_from_input("http://a.b:81/x").as_deref(),
            Some("http://a.b:81")
        );
        assert_eq!(rule_site_from_input("not a site"), None);
        assert_eq!(rule_site_from_input(""), None);
        let rules = indexmap::IndexMap::new();
        let added =
            with_website_engine(&rules, "https://x.com/a", Some(PageEngine::Webkit)).unwrap();
        assert_eq!(added.get("https://x.com"), Some(&PageEngine::Webkit));
        let removed = with_website_engine(&added, "https://x.com", None).unwrap();
        assert!(removed.is_empty());
    }
}
