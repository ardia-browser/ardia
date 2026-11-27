use ardia_state::{BrowserState, TabId};
use serde_json::json;

use super::super::workspace::minimized_url;
use super::{PluginService, State};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageContext {
    pub tab_id: TabId,
    pub url: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandedContext {
    pub plugin: String,
    pub approved: String,
    pub page_url: String,
    pub context: PageContext,
}

pub fn plugin_page_name(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("ardia://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(&rest[..end]).filter(|name| !name.is_empty())
}

fn is_plugin_page(state: &State, url: &str) -> bool {
    plugin_page_name(url).is_some_and(|name| {
        let name = name.to_ascii_lowercase();
        state.records.contains_key(&name)
            || state
                .listings
                .get(&name)
                .and_then(|l| l.read.manifest.as_ref())
                .is_some_and(|m| m.page.is_some() || !m.contributes.panels.is_empty())
    })
}

pub fn shown_context(full_urls: bool, context: &PageContext) -> String {
    let url = if full_urls {
        context.url.clone()
    } else {
        minimized_url(&context.url)
    };
    json!({ "tabId": context.tab_id.to_string(), "url": url, "title": context.title }).to_string()
}

impl PluginService {
    pub(super) fn context_of(
        state: &State,
        browser: &BrowserState,
        name: &str,
        tab: Option<&TabId>,
        window_eligible: bool,
    ) -> Option<PageContext> {
        let manifest = state.active(name)?;
        manifest.permissions.tabs.as_ref()?;
        let tab = browser.tab(tab?.as_str())?;
        let eligible = window_eligible && !tab.profile_id.is_incognito();
        if !eligible || is_plugin_page(state, &tab.url) {
            return None;
        }
        Some(PageContext {
            tab_id: tab.id.clone(),
            url: tab.url.clone(),
            title: tab
                .custom_title
                .clone()
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| tab.title.clone()),
        })
    }

    pub(super) fn hand_context(
        &self,
        tab: &TabId,
        name: &str,
        page_url: &str,
        context: Option<PageContext>,
    ) {
        let mut state = self.state.lock();
        let approved = state
            .records
            .get(name)
            .and_then(|r| r.approved.clone())
            .unwrap_or_default();
        match context {
            Some(context) => {
                state.page_contexts.insert(
                    tab.clone(),
                    HandedContext {
                        plugin: name.to_owned(),
                        approved,
                        page_url: page_url.to_owned(),
                        context,
                    },
                );
            }
            None => {
                state.page_contexts.remove(tab);
            }
        }
    }

    fn live(state: &State, url: Option<&str>, handed: &HandedContext) -> bool {
        url == Some(handed.page_url.as_str())
            && state
                .active(&handed.plugin)
                .is_some_and(|m| m.permissions.tabs.is_some())
            && state
                .records
                .get(&handed.plugin)
                .and_then(|r| r.approved.as_deref())
                == Some(handed.approved.as_str())
    }

    pub fn shown_page_context(&self, tab: &TabId, name: &str) -> Option<String> {
        let handed = self.state.lock().page_contexts.get(tab).cloned()?;
        let url = self.env.tab_url(tab);
        let mut state = self.state.lock();
        if !Self::live(&state, url.as_deref(), &handed) {
            if state.page_contexts.get(tab) == Some(&handed) {
                state.page_contexts.remove(tab);
            }
            return None;
        }
        if handed.plugin != name {
            return None;
        }
        let full_urls = state.active(name)?.permissions.full_urls;
        Some(shown_context(full_urls, &handed.context))
    }

    pub(super) fn drop_stale_page_contexts(&self) {
        let handed: Vec<(TabId, HandedContext)> = self
            .state
            .lock()
            .page_contexts
            .iter()
            .map(|(tab, handed)| (tab.clone(), handed.clone()))
            .collect();
        if handed.is_empty() {
            return;
        }
        let urls: Vec<Option<String>> = handed
            .iter()
            .map(|(tab, _)| self.env.tab_url(tab))
            .collect();
        let mut state = self.state.lock();
        for ((tab, was), url) in handed.into_iter().zip(urls) {
            if !Self::live(&state, url.as_deref(), &was)
                && state.page_contexts.get(&tab) == Some(&was)
            {
                state.page_contexts.remove(&tab);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_page_names_come_from_ardia_urls_only() {
        assert_eq!(plugin_page_name("ardia://inbox"), Some("inbox"));
        assert_eq!(
            plugin_page_name("ardia://inbox/x?ardiaPanel=a"),
            Some("inbox")
        );
        assert_eq!(plugin_page_name("ardia://"), None);
        assert_eq!(plugin_page_name("https://inbox"), None);
    }

    #[test]
    fn the_shown_context_minimizes_urls_without_full_url_access() {
        let context = PageContext {
            tab_id: TabId::new("t1"),
            url: "https://example.com/private/path?token=1".into(),
            title: "Example".into(),
        };
        let full: serde_json::Value = serde_json::from_str(&shown_context(true, &context)).unwrap();
        assert_eq!(full["url"], "https://example.com/private/path?token=1");
        assert_eq!(full["tabId"], "t1");
        assert_eq!(full["title"], "Example");
        let short: serde_json::Value =
            serde_json::from_str(&shown_context(false, &context)).unwrap();
        assert_eq!(short["url"], minimized_url(&context.url));
        assert!(!short["url"].as_str().unwrap_or_default().contains("token"));
    }
}
