use ardia_engine::EngineEvent;
use ardia_state::actions::{Action, NewTab, PageUpdate};
use ardia_state::omnibox::url::same_page;
use ardia_state::{TabId, WindowId};
use ardia_ui::pages::{InternalPage, OpenPlan, PageKind, plan_open};

use crate::coordinator::AppCoordinator;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnginePage {
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub favicon: Option<String>,
}

fn is_blank(url: &str) -> bool {
    url.is_empty() || url == "about:blank" || url.starts_with("chrome://newtab")
}

impl AppCoordinator {
    pub fn internal_page_of(&self, tab: &TabId) -> Option<InternalPage> {
        let state = self.store.snapshot();
        let listed = state.tab(tab.as_str())?;
        if listed.live.navigation.is_some() {
            return None;
        }
        InternalPage::of(&listed.url)
    }

    pub(crate) fn engine_page(&self, tab: &TabId) -> Option<EnginePage> {
        let engine_tab = self.engine_tab(tab)?;
        let info = self.engine()?.tab_info(engine_tab).ok()?;
        if is_blank(&info.url) {
            return None;
        }
        Some(EnginePage {
            url: info.url,
            title: info.title,
            loading: info.loading,
            can_go_back: info.can_go_back,
            can_go_forward: info.can_go_forward,
            favicon: info.favicon_url,
        })
    }

    pub(crate) fn show_internal_page(&self, tab: &TabId, page: &InternalPage) {
        let underneath = self.engine_page(tab).is_some() && *page != InternalPage::NewTab;
        {
            let mut bridge = self.bridge.lock();
            bridge.icon_urls.remove(tab);
            bridge.favicon_pages.remove(tab);
        }
        self.dispatch_quietly(Action::UpdatePage {
            tab: tab.clone(),
            update: PageUpdate {
                url: Some(page.url()),
                title: Some(page.title().to_owned()),
                favicon: Some(None),
                loading: Some(false),
                progress: Some(0.0),
                can_go_back: Some(underneath),
                can_go_forward: Some(false),
                icon_theme: Some(None),
                ..PageUpdate::default()
            },
        });
        self.bridge.lock().icon_themes.remove(tab);
    }

    pub(crate) fn return_to_engine_page(&self, tab: &TabId, page: EnginePage) {
        let favicon = page.favicon.clone();
        self.dispatch_quietly(Action::UpdatePage {
            tab: tab.clone(),
            update: PageUpdate {
                url: Some(page.url),
                title: Some(page.title),
                loading: Some(page.loading),
                can_go_back: Some(page.can_go_back),
                can_go_forward: Some(page.can_go_forward),
                ..PageUpdate::default()
            },
        });
        if let Some(engine_tab) = self.engine_tab(tab) {
            self.on_favicon(engine_tab, favicon);
        }
    }

    pub(crate) fn leaves_internal_page_in_place(&self, tab: &TabId, target: &str) -> bool {
        if self.internal_page_of_url(tab).is_none() {
            return false;
        }
        match self.engine_page(tab) {
            Some(page) if same_page(&page.url, target) => {
                self.return_to_engine_page(tab, page);
                true
            }
            _ => false,
        }
    }

    fn internal_page_of_url(&self, tab: &TabId) -> Option<InternalPage> {
        let state = self.store.snapshot();
        InternalPage::of(&state.tab(tab.as_str())?.url)
    }

    pub(crate) fn back_from_internal_page(&self, tab: &TabId) -> bool {
        if self.internal_page_of(tab).is_none() {
            return false;
        }
        if let Some(page) = self.engine_page(tab) {
            self.return_to_engine_page(tab, page);
        }
        true
    }

    pub(crate) fn reload_internal_page(&self, tab: &TabId) -> bool {
        self.internal_page_of(tab).is_some()
    }

    pub(crate) fn swallowed_by_internal_page(&self, event: &EngineEvent) -> bool {
        let page_event = matches!(
            event,
            EngineEvent::UrlChanged { .. }
                | EngineEvent::TitleChanged { .. }
                | EngineEvent::LoadingChanged { .. }
                | EngineEvent::ProgressChanged { .. }
                | EngineEvent::NavigationStateChanged { .. }
                | EngineEvent::ThemeColorChanged { .. }
                | EngineEvent::FaviconChanged { .. }
                | EngineEvent::RequestsBlocked { .. }
        );
        if !page_event {
            return false;
        }
        let Some(engine_tab) = event.tab() else {
            return false;
        };
        let Some(tab) = self.state_tab(engine_tab) else {
            return false;
        };
        self.internal_page_of(&tab).is_some()
    }

    pub fn open_internal_page(&self, window: &WindowId, kind: PageKind) -> Result<(), String> {
        let state = self.store.snapshot();
        let url = kind.page().url();
        let outcome = match plan_open(&state, window, kind) {
            OpenPlan::Activate(tab) => self.dispatch_action(Action::ActivateTab { tab }),
            OpenPlan::NavigateIn(tab) => self.dispatch_action(Action::Navigate { tab, input: url }),
            OpenPlan::NewTab => self.dispatch_action(Action::NewTab {
                window: window.clone(),
                tab: NewTab {
                    url: Some(url),
                    ..NewTab::default()
                },
            }),
        };
        outcome.map(|_| ()).map_err(|problem| problem.to_string())
    }
}
