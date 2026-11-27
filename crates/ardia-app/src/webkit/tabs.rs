use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_engine::EngineEvent;
use ardia_state::actions::{NewTab, PageUpdate};
use ardia_state::engines::{
    self, can_switch_engine, chosen_engine, chromium_only, google_sign_in, mode_engine_for,
    needs_chromium, single_engine, site_of, tab_engine, web_store_page,
};
use ardia_state::model::PageEngine;
use ardia_state::settings::{EngineMode, SettingsPatch};
use ardia_state::tabs::FindState;
use ardia_state::windows::{Toast, ToastKind};
use ardia_state::{Action, BrowserState, TabId, WindowId};
use ardia_ui::host::HostTabView;
use futures::FutureExt as _;
use futures::channel::oneshot;
use futures::future::LocalBoxFuture;

use super::page::{self, PageSpec};
use super::site_data::with_deadline;
use super::telemetry::{self, SiteMoveOutcome};
use super::{WebKitEvent, WebKitSink};
use crate::coordinator::{AppCoordinator, ShellEffect};

pub const UNSAVED_WORK: &str = r#"(() => {
  const fields = Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=password]):not([type=submit]):not([type=button]), textarea, select"));
  const changed = (f) => f.type === "checkbox" || f.type === "radio" ? f.checked !== f.defaultChecked : f.tagName === "SELECT" ? Array.from(f.options).some((o) => o.selected !== o.defaultSelected) : f.value !== f.defaultValue;
  const editing = document.activeElement && document.activeElement.isContentEditable;
  return fields.some(changed) || !!editing;
})()"#;

pub const UNSAVED_DEADLINE: Duration = Duration::from_millis(1500);
pub const SITE_MOVE_SPACING: Duration = Duration::from_millis(engines::SITE_MOVE_SPACING_MS);

#[derive(Clone, Debug, PartialEq)]
pub struct EngineOffer {
    pub site: String,
    pub host: String,
    pub key_system: String,
    pub can_remember: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConfirmRequest {
    pub id: u64,
    pub window: Option<WindowId>,
    pub title: String,
    pub message: String,
    pub confirm: String,
    pub cancel: String,
}

#[derive(Clone, Debug, PartialEq)]
struct PendingMove {
    to: PageEngine,
    url: String,
    previous: String,
}

#[derive(Default)]
pub struct WebKitBook {
    pub offers: HashMap<TabId, EngineOffer>,
    declined: HashSet<String>,
    told_chromium_mode: HashSet<String>,
    switching: HashSet<TabId>,
    pub mode_pending: Option<EngineMode>,
    last_moved: HashMap<TabId, Instant>,
    pending_moves: HashMap<TabId, PendingMove>,
    confirms: HashMap<u64, oneshot::Sender<bool>>,
    next_confirm: u64,
    visited: HashMap<TabId, String>,
    applied_zoom: HashMap<TabId, f64>,
    applied_muted: HashMap<TabId, bool>,
    finding: HashMap<TabId, String>,
    pub engine_back: HashMap<TabId, (PageEngine, String)>,
    real_can_go_back: HashMap<TabId, bool>,
    webkit_sites: HashMap<TabId, String>,
    policies_loaded: bool,
}

pub fn confirm_for_switch(engine: PageEngine) -> (String, String, String) {
    let name = engines::engine_name(engine);
    (
        format!("Open this page in {name}?"),
        format!("The page reloads in {name}, so changes you made on it may not be saved."),
        format!("Open in {name}"),
    )
}

pub fn confirm_for_mode(mode: EngineMode, unsaved: usize) -> (String, String, String) {
    let name = engines::mode_name(mode);
    let pages = if unsaved == 1 {
        "A page with unsaved changes reloads".to_owned()
    } else {
        format!("{unsaved} pages with unsaved changes reload")
    };
    (
        format!("Switch to {name}?"),
        format!("{pages}, so the changes may be lost."),
        format!("Switch to {name}"),
    )
}

pub const OPEN_SETTINGS: &str = "openSettings";

pub fn chromium_mode_toast(site: &str) -> String {
    format!(
        "Protected video won't play in Chromium\n{} plays in WebKit. Set Engine to Automatic or WebKit in Settings.",
        engines::host_label(site)
    )
}

fn stage_of(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value.get("stage")?.as_str().map(str::to_owned)
}

fn key_system_of(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value
        .get("keySystem")
        .and_then(serde_json::Value::as_str)
        .filter(|system| !system.is_empty() && system.len() <= 128)
        .map(str::to_owned)
}

impl AppCoordinator {
    pub fn offers_webkit(&self) -> bool {
        cfg!(target_os = "macos") && self.backend() == ardia_engine::EngineBackend::Mac
    }

    pub fn page_engine_of(&self, state: &BrowserState, tab: &TabId) -> PageEngine {
        if self.offers_webkit() {
            tab_engine(state, tab.as_str())
        } else {
            PageEngine::Chromium
        }
    }

    pub fn is_webkit_page(&self, tab: &TabId) -> bool {
        page::has(tab)
    }

    fn webkit_sink(&self) -> WebKitSink {
        let me = self.weak();
        Arc::new(move |tab: TabId, event: WebKitEvent| {
            if let Some(coordinator) = me.upgrade() {
                coordinator.post(move |c| c.on_webkit_event(tab, event));
            }
        })
    }

    fn webkit_spec(&self, state: &BrowserState, tab: &TabId) -> Option<PageSpec> {
        let listed = state.tab(tab.as_str())?;
        let url = listed
            .live
            .navigation
            .clone()
            .unwrap_or_else(|| listed.url.clone());
        Some(PageSpec {
            tab: tab.clone(),
            profile: state.engine_profile(&listed.profile_id),
            private: listed.is_incognito(),
            url,
            zoom: listed.zoom,
            muted: listed.muted,
            inspectable: true,
            sink: self.webkit_sink(),
        })
    }

    pub(crate) fn materialize_webkit(&self, state: &BrowserState, tab: &TabId) -> bool {
        if !self.offers_webkit() {
            return false;
        }
        let engine = tab_engine(state, tab.as_str());
        if engine == PageEngine::Chromium {
            if page::has(tab) {
                self.close_webkit_page(tab);
            }
            return false;
        }
        if let (Some(engine_tab), Some(chromium)) = (self.engine_tab(tab), self.engine()) {
            self.retire_engine_tab(tab, engine_tab, &chromium);
        }
        if !page::has(tab) {
            let Some(spec) = self.webkit_spec(state, tab) else {
                return true;
            };
            {
                let mut bridge = self.bridge.lock();
                bridge.webkit.applied_zoom.insert(tab.clone(), spec.zoom);
                bridge.webkit.applied_muted.insert(tab.clone(), spec.muted);
            }
            if page::open(spec).is_some() {
                log::debug!("{tab} opens in WebKit");
                self.mark_dirty();
            }
        }
        true
    }

    pub(crate) fn close_webkit_page(&self, tab: &TabId) {
        self.forget_webkit_page(tab);
        page::close(tab);
    }

    pub(crate) fn forget_webkit_page(&self, tab: &TabId) {
        self.webkit_services_closed(tab);
        let mut bridge = self.bridge.lock();
        bridge.webkit.visited.remove(tab);
        bridge.webkit.applied_zoom.remove(tab);
        bridge.webkit.applied_muted.remove(tab);
        bridge.webkit.finding.remove(tab);
        bridge.icon_urls.remove(tab);
        bridge.icon_themes.remove(tab);
        bridge.favicon_pages.remove(tab);
        drop(bridge);
        self.mark_dirty();
    }

    pub(crate) fn reconcile_webkit(&self, state: &BrowserState) {
        if !self.offers_webkit() {
            return;
        }
        let first = !std::mem::replace(&mut self.bridge.lock().webkit.policies_loaded, true);
        if first {
            self.load_webkit_policies();
            super::telemetry::set_allowed(ardia_ui::UiHost::sharing(self));
        }
        let live: Vec<TabId> = state
            .tabs
            .keys()
            .filter(|tab| page::has(tab))
            .cloned()
            .collect();
        self.webkit_reconsider_sight();
        self.settle_retiring();
        self.sync_site_data_watch();
        let gone: Vec<TabId> = {
            let bridge = self.bridge.lock();
            bridge
                .webkit
                .applied_zoom
                .keys()
                .filter(|tab| state.tab(tab.as_str()).is_none())
                .cloned()
                .collect()
        };
        for tab in gone {
            self.close_webkit_page(&tab);
            let mut bridge = self.bridge.lock();
            bridge.webkit.offers.remove(&tab);
            bridge.webkit.pending_moves.remove(&tab);
            bridge.webkit.last_moved.remove(&tab);
        }
        for tab in live {
            let Some(listed) = state.tab(tab.as_str()) else {
                continue;
            };
            if tab_engine(state, tab.as_str()) != PageEngine::Webkit {
                self.close_webkit_page(&tab);
                continue;
            }
            let (zoom, muted) = {
                let bridge = self.bridge.lock();
                (
                    bridge.webkit.applied_zoom.get(&tab).copied(),
                    bridge.webkit.applied_muted.get(&tab).copied(),
                )
            };
            if zoom.is_none_or(|zoom| (zoom - listed.zoom).abs() > 1e-6) {
                page::set_zoom(&tab, listed.zoom);
                self.bridge
                    .lock()
                    .webkit
                    .applied_zoom
                    .insert(tab.clone(), listed.zoom);
            }
            let silenced = ardia_state::mute::silenced(state, listed);
            if muted != Some(silenced) {
                page::set_muted(&tab, silenced);
                self.bridge
                    .lock()
                    .webkit
                    .applied_muted
                    .insert(tab.clone(), silenced);
            }
        }
    }

    pub(crate) fn webkit_views(&self, tab: &TabId) -> Option<HostTabView> {
        let handle = page::view(tab)?;
        Some(HostTabView {
            tab_id: tab.clone(),
            page_view: Some(handle),
            devtools_view: None,
        })
    }

    pub(crate) fn webkit_load(&self, tab: &TabId, url: &str) -> bool {
        if !self.offers_webkit() {
            return false;
        }
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return false;
        };
        let target = engines::typed_navigation_engine(&state, listed, url);
        let current = tab_engine(&state, tab.as_str());
        let live = page::has(tab) || self.engine_tab(tab).is_some();
        if target != current || (live && (target == PageEngine::Webkit) != page::has(tab)) {
            self.dispatch_quietly(Action::SetEngine {
                tab: tab.clone(),
                engine: Some(target),
            });
            self.drop_live_page(tab);
            self.mark_dirty();
            return true;
        }
        if page::has(tab) {
            page::load(tab, url);
            return true;
        }
        if target == PageEngine::Webkit {
            self.mark_dirty();
            return true;
        }
        false
    }

    fn drop_live_page(&self, tab: &TabId) {
        self.retire_for_swap(tab);
        if page::has(tab) {
            self.close_webkit_page(tab);
        }
        if let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) {
            self.retire_engine_tab(tab, engine_tab, &engine);
        }
    }

    pub(crate) fn webkit_go_back(&self, tab: &TabId) -> bool {
        page::has(tab).then(|| page::go_back(tab)).is_some()
    }

    pub(crate) fn webkit_go_forward(&self, tab: &TabId) -> bool {
        page::has(tab).then(|| page::go_forward(tab)).is_some()
    }

    pub(crate) fn webkit_reload(&self, tab: &TabId, ignore_cache: bool) -> bool {
        page::has(tab)
            .then(|| page::reload(tab, ignore_cache))
            .is_some()
    }

    pub(crate) fn webkit_stop(&self, tab: &TabId) -> bool {
        page::has(tab).then(|| page::stop(tab)).is_some()
    }

    pub(crate) fn webkit_zoom_step(&self, tab: &TabId, direction: i32) -> bool {
        page::has(tab)
            .then(|| page::zoom_step(tab, direction))
            .is_some()
    }

    pub(crate) fn webkit_find(&self, tab: &TabId, query: &str, forward: bool) -> bool {
        if !page::has(tab) {
            return false;
        }
        if query.is_empty() {
            page::stop_finding(tab);
            self.bridge.lock().webkit.finding.remove(tab);
        } else {
            self.bridge
                .lock()
                .webkit
                .finding
                .insert(tab.clone(), query.to_owned());
            page::find(tab, query, forward);
        }
        true
    }

    pub(crate) fn webkit_stop_finding(&self, tab: &TabId) -> bool {
        if !page::has(tab) {
            return false;
        }
        page::stop_finding(tab);
        self.bridge.lock().webkit.finding.remove(tab);
        true
    }

    pub(crate) fn on_webkit_event(&self, tab: TabId, event: WebKitEvent) {
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()).cloned() else {
            return;
        };
        if !page::has(&tab) && !matches!(event, WebKitEvent::WindowClose) {
            return;
        }
        match event {
            WebKitEvent::Navigation(nav) => {
                let previous = listed.url.clone();
                let mut update = PageUpdate {
                    title: Some(nav.title.clone()),
                    loading: Some(nav.loading),
                    can_go_back: Some(nav.can_go_back),
                    can_go_forward: Some(nav.can_go_forward),
                    theme_color: Some(
                        nav.theme_color
                            .as_deref()
                            .and_then(ardia_theme::RgbaColor::parse),
                    ),
                    ..PageUpdate::default()
                };
                let moved = !nav.url.is_empty() && nav.url != listed.url;
                let blank = nav.url == "about:blank" && listed.url.is_empty();
                if moved && !blank {
                    update.url = Some(nav.url.clone());
                }
                if nav.title.is_empty() || blank {
                    update.title = None;
                }
                if !nav.loading {
                    update.progress = Some(0.0);
                }
                self.adjust_page_update(&tab, &mut update);
                self.dispatch_quietly(Action::UpdatePage {
                    tab: tab.clone(),
                    update,
                });
                self.note_webkit_visit(&tab, &nav);
                self.note_webkit_page_settled(&tab, &nav.url, &nav.committed_url, nav.loading);
                if moved && !blank {
                    self.note_site_visit(&tab, PageEngine::Webkit, &nav.url);
                    self.note_webkit_site(&tab, &nav.url);
                    self.follow_site_choice(&tab, PageEngine::Webkit, &nav.url, &previous);
                }
            }
            WebKitEvent::Progress(progress) => {
                let mut update = PageUpdate {
                    progress: Some(progress.clamp(0.0, 1.0) as f32),
                    ..PageUpdate::default()
                };
                self.adjust_page_update(&tab, &mut update);
                if update.progress.is_some() {
                    self.dispatch_quietly(Action::UpdatePage { tab, update });
                }
            }
            WebKitEvent::Committed => {
                self.bridge.lock().webkit.visited.remove(&tab);
                self.webkit_services_committed(&tab);
            }
            WebKitEvent::Message(message) => self.on_webkit_message(&tab, message),
            WebKitEvent::Zoom(zoom) => {
                self.bridge
                    .lock()
                    .webkit
                    .applied_zoom
                    .insert(tab.clone(), zoom);
                if zoom.is_finite()
                    && (0.25..=5.0).contains(&zoom)
                    && (listed.zoom - zoom).abs() > 1e-6
                {
                    self.dispatch_quietly(Action::SetZoom { tab, zoom });
                }
            }
            WebKitEvent::Icons(icons) => {
                self.favicon_for_tab(tab, icons.into_iter().next());
            }
            WebKitEvent::FindMatches(count, active) => {
                let current = listed.live.find.clone();
                if current.open {
                    self.dispatch_quietly(Action::SetFind {
                        tab,
                        find: FindState {
                            count,
                            active: if count.unwrap_or(0) == 0 {
                                0
                            } else if active > 0 {
                                active
                            } else {
                                current.active.max(1)
                            },
                            ..current
                        },
                    });
                }
            }
            WebKitEvent::Page(event) => self.on_webkit_page_event(&tab, &listed, event),
            WebKitEvent::Media { audible } => {
                self.dispatch_quietly(Action::UpdatePage {
                    tab,
                    update: PageUpdate {
                        audible: Some(audible),
                        ..PageUpdate::default()
                    },
                });
            }
            WebKitEvent::Fullscreen(on) => {
                self.dispatch_quietly(Action::UpdatePage {
                    tab,
                    update: PageUpdate {
                        fullscreen: Some(on),
                        ..PageUpdate::default()
                    },
                });
            }
            WebKitEvent::OpenUrl { url, background } => {
                self.dispatch_quietly(Action::NewTab {
                    window: listed.window_id.clone(),
                    tab: NewTab {
                        url: Some(url),
                        profile: Some(listed.profile_id.clone()),
                        opener: Some(tab),
                        background,
                        ..NewTab::default()
                    },
                });
                self.mark_dirty();
            }
            WebKitEvent::OpenPopup {
                held,
                url,
                background,
            } => self.adopt_webkit_popup(&listed, &held, url, background),
            WebKitEvent::WindowClose => {
                self.dispatch_quietly(Action::CloseTabs {
                    tabs: vec![tab],
                    last_closes_window: false,
                });
                self.mark_dirty();
            }
            WebKitEvent::Crashed => {
                self.dispatch_quietly(Action::UpdatePage {
                    tab,
                    update: PageUpdate {
                        loading: Some(false),
                        fullscreen: Some(false),
                        ..PageUpdate::default()
                    },
                });
            }
            WebKitEvent::ProtectedMedia { .. } | WebKitEvent::Unsaved(_) => {}
        }
    }

    fn adopt_webkit_popup(
        &self,
        opener: &ardia_state::tabs::Tab,
        held: &str,
        url: String,
        background: bool,
    ) {
        self.adopt_held_tab(
            opener.window_id.clone(),
            opener.profile_id.clone(),
            Some(opener.id.clone()),
            held,
            url,
            background,
        );
    }

    pub(crate) fn adopt_held_tab(
        &self,
        window: WindowId,
        profile: ardia_state::ProfileId,
        opener: Option<TabId>,
        held: &str,
        url: String,
        background: bool,
    ) {
        let outcome = self.dispatch_quietly(Action::NewTab {
            window,
            tab: NewTab {
                url: Some(url),
                profile: Some(profile),
                opener,
                background,
                ..NewTab::default()
            },
        });
        let Some(made) = outcome.and_then(|outcome| outcome.tab) else {
            page::drop_held(held);
            return;
        };
        self.dispatch_quietly(Action::SetEngine {
            tab: made.clone(),
            engine: Some(PageEngine::Webkit),
        });
        let state = self.store().snapshot();
        match self.webkit_spec(&state, &made) {
            Some(spec) => {
                {
                    let mut bridge = self.bridge.lock();
                    bridge.webkit.applied_zoom.insert(made.clone(), spec.zoom);
                    bridge.webkit.applied_muted.insert(made.clone(), spec.muted);
                }
                if page::adopt_held(held, spec).is_none() {
                    log::debug!("{made} couldn't take its WebKit popup");
                }
            }
            None => page::drop_held(held),
        }
        self.mark_dirty();
    }

    fn note_webkit_visit(&self, tab: &TabId, nav: &super::WebKitNavigation) {
        let web = nav.url.starts_with("https://") || nav.url.starts_with("http://");
        if !web || nav.url != nav.committed_url || nav.title.is_empty() {
            return;
        }
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        if listed.is_incognito() {
            return;
        }
        let key = format!("{}\n{}", nav.url, nav.title);
        let fresh = self.bridge.lock().webkit.visited.get(tab) != Some(&key);
        if !fresh {
            return;
        }
        self.bridge.lock().webkit.visited.insert(tab.clone(), key);
        self.dispatch_quietly(Action::RecordVisit {
            profile: listed.profile_id.clone(),
            url: nav.url.clone(),
            title: nav.title.clone(),
            favicon: listed.favicon.clone(),
        });
    }

    pub(crate) fn note_engine_event(&self, event: &EngineEvent) {
        if !self.offers_webkit() {
            return;
        }
        match event {
            EngineEvent::UrlChanged { tab, url } => {
                let Some(state_tab) = self.state_tab(*tab) else {
                    return;
                };
                let state = self.store().snapshot();
                let Some(listed) = state.tab(state_tab.as_str()) else {
                    return;
                };
                if url == "about:blank" || url == &listed.url {
                    return;
                }
                let previous = listed.url.clone();
                let url = url.clone();
                let me = self.weak();
                self.post(move |c| {
                    if me.upgrade().is_some() {
                        c.note_site_visit(&state_tab, PageEngine::Chromium, &url);
                        c.note_chromium_address(&state_tab, &url);
                        c.follow_site_choice(&state_tab, PageEngine::Chromium, &url, &previous);
                    }
                });
            }
            EngineEvent::PageMessage { tab, message } if message.kind == "drm" => {
                let Some(state_tab) = self.state_tab(*tab) else {
                    return;
                };
                let state = self.store().snapshot();
                if let Some(listed) = state.tab(state_tab.as_str()) {
                    telemetry::note_protected_video_refusal(
                        stage_of(&message.json).as_deref(),
                        engines::protected_video_site(&listed.url),
                        chosen_engine(&state.settings, &listed.url) == Some(PageEngine::Webkit),
                    );
                }
                if let Some(key_system) = key_system_of(&message.json) {
                    self.offer_webkit(&state_tab, &key_system);
                }
            }
            _ => {}
        }
    }

    pub(crate) fn follow_site_choice(
        &self,
        tab: &TabId,
        engine: PageEngine,
        url: &str,
        previous: &str,
    ) {
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        if tab_engine(&state, tab.as_str()) != engine {
            return;
        }
        if single_engine(&state.settings).is_some() {
            let forced = mode_engine_for(&state, listed, url);
            let left_for_chromium = web_store_page(previous) || google_sign_in(previous);
            let follows_mode = forced == Some(PageEngine::Chromium)
                || chromium_only(previous)
                || (left_for_chromium && !google_sign_in(url));
            if let Some(forced) = forced
                && forced != engine
                && follows_mode
                && (can_switch_engine(url) || needs_chromium(url))
            {
                self.start_site_move(tab, forced, url, previous);
            }
            return;
        }
        let Some(site) = site_of(url) else {
            return;
        };
        if site_of(previous).as_deref() == Some(site.as_str()) {
            return;
        }
        let Some(chosen) = chosen_engine(&state.settings, url) else {
            return;
        };
        if chosen != engine {
            self.start_site_move(tab, chosen, url, previous);
        }
    }

    fn note_webkit_site(&self, tab: &TabId, url: &str) {
        let site = site_of(url);
        let fresh = {
            let mut bridge = self.bridge.lock();
            match &site {
                None => {
                    bridge.webkit.webkit_sites.remove(tab);
                    false
                }
                Some(site) => {
                    bridge
                        .webkit
                        .webkit_sites
                        .insert(tab.clone(), site.clone())
                        .as_ref()
                        != Some(site)
                }
            }
        };
        let state = self.store().snapshot();
        if fresh
            && engines::rule_for(&state.settings, url).is_none()
            && engines::built_in_engine(&state.settings, url).is_some()
        {
            telemetry::note_streaming_list_visit();
        }
    }

    fn start_site_move(&self, tab: &TabId, to: PageEngine, url: &str, previous: &str) {
        let wait = self
            .bridge
            .lock()
            .webkit
            .last_moved
            .get(tab)
            .map(|at| SITE_MOVE_SPACING.saturating_sub(at.elapsed()))
            .filter(|left| !left.is_zero());
        if let Some(wait) = wait {
            self.bridge.lock().webkit.pending_moves.insert(
                tab.clone(),
                PendingMove {
                    to,
                    url: url.to_owned(),
                    previous: previous.to_owned(),
                },
            );
            let tab = tab.clone();
            self.after_webkit(wait, move |c| c.settle_pending_move(&tab));
            return;
        }
        self.bridge.lock().webkit.pending_moves.remove(tab);
        self.run_site_move(tab, to, previous, false);
    }

    fn run_site_move(&self, tab: &TabId, to: PageEngine, previous_url: &str, delayed: bool) {
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        let from = tab_engine(&state, tab.as_str());
        let previous_url = previous_url.to_owned();
        let opened = listed.opener_id.is_some();
        let Some(work) = self.switch_engine(tab, to, None, delayed) else {
            if !delayed {
                telemetry::note_site_move(SiteMoveOutcome::Dropped, opened);
            }
            return;
        };
        let me = self.weak();
        let tab = tab.clone();
        self.spawn(async move {
            let moved = work.await;
            let Some(me) = me.upgrade() else {
                return;
            };
            telemetry::note_site_move(
                if moved {
                    SiteMoveOutcome::Moved
                } else {
                    SiteMoveOutcome::Dropped
                },
                opened,
            );
            if moved && (can_switch_engine(&previous_url) || needs_chromium(&previous_url)) {
                me.bridge
                    .lock()
                    .webkit
                    .engine_back
                    .insert(tab.clone(), (from, previous_url));
                me.dispatch_quietly(Action::UpdatePage {
                    tab,
                    update: PageUpdate {
                        can_go_back: Some(true),
                        ..PageUpdate::default()
                    },
                });
            }
        });
    }

    fn settle_pending_move(&self, tab: &TabId) {
        let Some(pending) = self.bridge.lock().webkit.pending_moves.remove(tab) else {
            return;
        };
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        let here = engines::current_url(listed);
        if site_of(here) != site_of(&pending.url) || tab_engine(&state, tab.as_str()) == pending.to
        {
            return;
        }
        self.run_site_move(tab, pending.to, &pending.previous, true);
    }

    fn after_webkit(&self, delay: Duration, job: impl FnOnce(&AppCoordinator) + Send + 'static) {
        let me = self.weak();
        let spawned = std::thread::Builder::new()
            .name("ardia-engine-move".into())
            .spawn(move || {
                std::thread::sleep(delay);
                if let Some(coordinator) = me.upgrade() {
                    coordinator.post(job);
                }
            });
        if let Err(problem) = spawned {
            log::debug!("an engine move timer didn't start: {problem}");
        }
    }

    pub(crate) fn offer_webkit(&self, tab: &TabId, key_system: &str) {
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        if tab_engine(&state, tab.as_str()) == PageEngine::Webkit {
            return;
        }
        let Some(site) = site_of(&listed.url) else {
            return;
        };
        match single_engine(&state.settings) {
            Some(PageEngine::Chromium) => return self.tell_chromium_mode_blocks(listed, &site),
            Some(_) => return,
            None => {}
        }
        let rule = chosen_engine(&state.settings, &listed.url);
        if rule == Some(PageEngine::Chromium) || self.bridge.lock().webkit.declined.contains(&site)
        {
            return;
        }
        if rule == Some(PageEngine::Webkit) {
            self.open_page_in_engine(tab, PageEngine::Webkit, None, false);
            return;
        }
        if !can_switch_engine(&listed.url) {
            return;
        }
        self.show_engine_offer(listed, &site, key_system);
    }

    fn show_engine_offer(&self, listed: &ardia_state::tabs::Tab, site: &str, key_system: &str) {
        let state = self.store().snapshot();
        if !state.settings.offer_webkit_for_protected_video {
            return;
        }
        let mut bridge = self.bridge.lock();
        if bridge
            .webkit
            .offers
            .get(&listed.id)
            .is_some_and(|offer| offer.site == site)
        {
            return;
        }
        bridge.webkit.offers.insert(
            listed.id.clone(),
            EngineOffer {
                site: site.to_owned(),
                host: engines::host_label(site),
                key_system: key_system.to_owned(),
                can_remember: !listed.is_incognito(),
            },
        );
        drop(bridge);
        self.touch(listed.window_id.clone());
        self.mark_dirty();
    }

    fn tell_chromium_mode_blocks(&self, listed: &ardia_state::tabs::Tab, site: &str) {
        if !self
            .bridge
            .lock()
            .webkit
            .told_chromium_mode
            .insert(site.to_owned())
        {
            return;
        }
        telemetry::note_engine_mode_video_notice(false);
        self.dispatch_quietly(Action::PushToast {
            window: listed.window_id.clone(),
            toast: Toast {
                id: 0,
                kind: ToastKind::Info,
                message: chromium_mode_toast(site),
                action: Some(OPEN_SETTINGS.into()),
                icon: Some("play.rectangle".into()),
                created_at: ardia_state::Millis::default(),
                expires_at: None,
            },
        });
    }

    pub fn engine_offer_of(&self, tab: &TabId) -> Option<EngineOffer> {
        self.bridge.lock().webkit.offers.get(tab).cloned()
    }

    fn clear_engine_offer(&self, tab: &TabId) {
        let removed = self.bridge.lock().webkit.offers.remove(tab);
        if removed.is_some() {
            self.mark_dirty();
        }
    }

    pub fn answer_engine_offer(&self, tab: &TabId, accept: bool, remember: bool) {
        if accept {
            self.open_page_in_engine(
                tab,
                PageEngine::Webkit,
                Some(Some(PageEngine::Webkit)),
                true,
            );
            return;
        }
        let offer = self.bridge.lock().webkit.offers.get(tab).cloned();
        if let Some(offer) = offer {
            self.bridge
                .lock()
                .webkit
                .declined
                .insert(offer.site.clone());
            if remember && offer.can_remember {
                self.set_website_engine(&offer.site, Some(PageEngine::Chromium));
            }
        }
        self.clear_engine_offer(tab);
    }

    pub fn set_website_engine(&self, url: &str, engine: Option<PageEngine>) {
        let state = self.store().snapshot();
        let Some(rules) =
            engines::with_website_engine(&state.settings.website_engines, url, engine)
        else {
            return;
        };
        self.dispatch_quietly(Action::UpdateSettings {
            patch: SettingsPatch::new().set("websiteEngines", &rules),
            from_sync: false,
        });
    }

    pub fn toggle_engine_of(&self, tab: &TabId) {
        let state = self.store().snapshot();
        let to = engines::other_engine(tab_engine(&state, tab.as_str()));
        self.open_page_in_engine(tab, to, None, true);
    }

    pub fn open_page_in_engine(
        &self,
        tab: &TabId,
        engine: PageEngine,
        rule: Option<Option<PageEngine>>,
        check_work: bool,
    ) {
        if let Some(work) = self.switch_engine(tab, engine, rule, check_work) {
            self.spawn(async move {
                work.await;
            });
        }
    }

    pub(crate) fn switch_engine(
        &self,
        tab: &TabId,
        engine: PageEngine,
        rule: Option<Option<PageEngine>>,
        check_work: bool,
    ) -> Option<LocalBoxFuture<'static, bool>> {
        if !self.offers_webkit() {
            return None;
        }
        let me = self.weak().upgrade()?;
        if !self.bridge.lock().webkit.switching.insert(tab.clone()) {
            return None;
        }
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            self.bridge.lock().webkit.switching.remove(tab);
            return None;
        };
        let url = engines::current_url(listed).to_owned();
        let reachable =
            can_switch_engine(&url) || (engine == PageEngine::Chromium && web_store_page(&url));
        let forced = mode_engine_for(&state, listed, &url);
        if !reachable || forced.is_some_and(|forced| forced != engine) {
            self.bridge.lock().webkit.switching.remove(tab);
            return None;
        }
        let save_rule = rule.filter(|_| !listed.is_incognito());
        self.clear_engine_offer(tab);
        if tab_engine(&state, tab.as_str()) == engine {
            if let Some(rule) = save_rule {
                self.set_website_engine(&url, rule);
            }
            self.bridge.lock().webkit.switching.remove(tab);
            return Some(futures::future::ready(true).boxed_local());
        }
        let asks = check_work && state.settings.engine_switch_asks_about_unsaved_work;
        let window = listed.window_id.clone();
        let navigation = listed.live.navigation.clone();
        let tab = tab.clone();
        let unsaved = asks.then(|| self.has_unsaved_work(&tab));
        Some(
            async move {
                let moved = me
                    .run_switch(&tab, engine, &url, navigation, save_rule, unsaved, window)
                    .await;
                me.bridge.lock().webkit.switching.remove(&tab);
                moved
            }
            .boxed_local(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_switch(
        self: &Arc<Self>,
        tab: &TabId,
        engine: PageEngine,
        url: &str,
        navigation: Option<String>,
        save_rule: Option<Option<PageEngine>>,
        unsaved: Option<LocalBoxFuture<'static, bool>>,
        window: WindowId,
    ) -> bool {
        let still = |me: &Arc<Self>| {
            let state = me.store().snapshot();
            state.tab(tab.as_str()).is_some_and(|now| {
                engines::current_url(now) == url && now.live.navigation == navigation
            })
        };
        if let Some(unsaved) = unsaved
            && unsaved.await
        {
            if !still(self) {
                return false;
            }
            let (title, message, confirm) = confirm_for_switch(engine);
            if !self
                .ask_confirm(Some(window), title, message, confirm)
                .await
                .unwrap_or(false)
            {
                return false;
            }
        }
        if !still(self) {
            return false;
        }
        if self.carries_site_data() {
            self.carry_sign_in(tab, url, engine).await;
        }
        if !still(self) {
            return false;
        }
        let from = tab_engine(&self.store().snapshot(), tab.as_str());
        let held = if from != engine {
            self.hold_page_for_swap(tab, engine, url, true).await
        } else {
            None
        };
        if !still(self) {
            self.drop_swap(tab, held);
            return false;
        }
        if let Some(rule) = save_rule {
            self.set_website_engine(url, rule);
        }
        if tab_engine(&self.store().snapshot(), tab.as_str()) == engine {
            self.drop_swap(tab, held);
            return true;
        }
        self.switch_tab_engine(tab, engine, url);
        if held.is_some() {
            self.watch_first_paint(tab);
        }
        true
    }

    fn switch_tab_engine(&self, tab: &TabId, engine: PageEngine, url: &str) {
        let state = self.store().snapshot();
        if tab_engine(&state, tab.as_str()) == engine
            && state
                .tab(tab.as_str())
                .is_some_and(|t| t.engine == Some(engine))
        {
            return;
        }
        self.dispatch_quietly(Action::SetEngine {
            tab: tab.clone(),
            engine: Some(engine),
        });
        self.drop_live_page(tab);
        self.bridge
            .lock()
            .webkit
            .last_moved
            .insert(tab.clone(), Instant::now());
        let state = self.store().snapshot();
        if let Some(listed) = state.tab(tab.as_str())
            && listed.url.is_empty()
            && !url.is_empty()
        {
            self.dispatch_quietly(Action::Navigate {
                tab: tab.clone(),
                input: url.to_owned(),
            });
        }
        if let Some(listed) = state.tab(tab.as_str()) {
            self.touch(listed.window_id.clone());
        }
        self.mark_dirty();
    }

    fn has_unsaved_work(&self, tab: &TabId) -> LocalBoxFuture<'static, bool> {
        if !page::has(tab) && self.engine_tab(tab).is_none() {
            return futures::future::ready(false).boxed_local();
        }
        let body = format!("post(\"result\", JSON.stringify({UNSAVED_WORK}))");
        if page::has(tab) {
            let (answer, reply) = oneshot::channel();
            page::evaluate(
                tab,
                &body,
                Box::new(move |result| {
                    let _ = answer.send(result.as_deref() == Some("true"));
                }),
            );
            return with_deadline(reply.map(|r| r.unwrap_or(false)), UNSAVED_DEADLINE, false)
                .boxed_local();
        }
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            return futures::future::ready(false).boxed_local();
        };
        let reply = engine.evaluate_js(engine_tab, &body);
        with_deadline(
            reply.map(|r| r.ok().flatten().and_then(|v| v.as_bool()).unwrap_or(false)),
            UNSAVED_DEADLINE,
            false,
        )
        .boxed_local()
    }

    pub(crate) fn ask_confirm(
        &self,
        window: Option<WindowId>,
        title: String,
        message: String,
        confirm: String,
    ) -> oneshot::Receiver<bool> {
        self.ask_confirm_with(window, title, message, confirm, "Stay on Page")
    }

    fn ask_confirm_with(
        &self,
        window: Option<WindowId>,
        title: String,
        message: String,
        confirm: String,
        cancel: &str,
    ) -> oneshot::Receiver<bool> {
        let (answer, reply) = oneshot::channel();
        let id = {
            let mut bridge = self.bridge.lock();
            bridge.webkit.next_confirm += 1;
            let id = bridge.webkit.next_confirm;
            bridge.webkit.confirms.insert(id, answer);
            id
        };
        self.effect(ShellEffect::Confirm(ConfirmRequest {
            id,
            window,
            title,
            message,
            confirm,
            cancel: cancel.to_owned(),
        }));
        reply
    }

    pub fn answer_confirm(&self, id: u64, confirmed: bool) {
        if let Some(answer) = self.bridge.lock().webkit.confirms.remove(&id) {
            let _ = answer.send(confirmed);
        }
    }

    pub fn engine_mode_pending(&self) -> Option<EngineMode> {
        self.bridge.lock().webkit.mode_pending
    }

    pub fn change_engine_mode(&self, mode: EngineMode) {
        let before = self.store().snapshot();
        if self.bridge.lock().webkit.mode_pending.is_some() || before.settings.engine_mode == mode {
            return;
        }
        let Some(me) = self.weak().upgrade() else {
            return;
        };
        self.bridge.lock().webkit.mode_pending = Some(mode);
        self.mark_dirty();
        let mut target = (*before.settings).clone();
        target.engine_mode = mode;
        let moving: Vec<(TabId, PageEngine, String)> = before
            .tabs
            .values()
            .filter(|tab| !engines::current_url(tab).is_empty())
            .filter_map(|tab| {
                let to = engines::engine_under_mode(&before, &target, tab);
                (tab_engine(&before, tab.id.as_str()) != to)
                    .then(|| (tab.id.clone(), to, engines::current_url(tab).to_owned()))
            })
            .collect();
        let asks = before.settings.engine_switch_asks_about_unsaved_work;
        let checks: Vec<_> = if asks {
            moving
                .iter()
                .map(|(tab, _, _)| self.has_unsaved_work(tab))
                .collect()
        } else {
            Vec::new()
        };
        let window = self.command_window(&before);
        self.spawn(async move {
            let unsaved = futures::future::join_all(checks)
                .await
                .into_iter()
                .filter(|dirty| *dirty)
                .count();
            if unsaved > 0 {
                let (title, message, confirm) = confirm_for_mode(mode, unsaved);
                let answer = me.ask_confirm_with(window, title, message, confirm, "Cancel");
                if !answer.await.unwrap_or(false) {
                    telemetry::note_engine_mode_change(true, 0);
                    me.bridge.lock().webkit.mode_pending = None;
                    me.mark_dirty();
                    return;
                }
            }
            if me.carries_site_data() {
                let mut carried = HashSet::new();
                let carries: Vec<_> = moving
                    .iter()
                    .filter(|(tab, to, url)| {
                        let state = me.store().snapshot();
                        let profile = state
                            .tab(tab.as_str())
                            .map(|t| t.profile_id.to_string())
                            .unwrap_or_default();
                        carried.insert(format!("{profile}|{:?}|{to:?}", site_of(url)))
                    })
                    .map(|(tab, to, url)| me.carry_sign_in(tab, url, *to))
                    .collect();
                futures::future::join_all(carries).await;
                if mode != EngineMode::Automatic {
                    let to = if mode == EngineMode::Webkit {
                        PageEngine::Webkit
                    } else {
                        PageEngine::Chromium
                    };
                    me.carry_recent_sites(to).await;
                }
            }
            let mut holds = HashMap::new();
            for (tab, to, url) in &moving {
                if let Some(id) = me.hold_page_for_swap(tab, *to, url, true).await {
                    holds.insert(tab.clone(), id);
                }
            }
            let moved = me.apply_engine_mode(mode, &holds);
            telemetry::note_engine_mode_change(false, moved);
        });
    }

    fn apply_engine_mode(self: &Arc<Self>, mode: EngineMode, holds: &HashMap<TabId, u64>) -> u64 {
        let now = self.store().snapshot();
        let mut next = (*now.settings).clone();
        next.engine_mode = mode;
        let plan: Vec<(TabId, PageEngine, PageEngine, Option<PageEngine>)> = now
            .tabs
            .values()
            .map(|tab| {
                (
                    tab.id.clone(),
                    tab_engine(&now, tab.id.as_str()),
                    engines::engine_under_mode(&now, &next, tab),
                    tab.engine,
                )
            })
            .collect();
        self.dispatch_quietly(Action::UpdateSettings {
            patch: SettingsPatch::new().set("engineMode", mode),
            from_sync: false,
        });
        self.bridge.lock().webkit.engine_back.clear();
        let mut moved = 0;
        for (tab, from, to, pinned) in plan {
            if from == to {
                if pinned.is_some_and(|engine| engine != to) {
                    self.dispatch_quietly(Action::SetEngine {
                        tab: tab.clone(),
                        engine: Some(to),
                    });
                }
                self.drop_swap(&tab, holds.get(&tab).copied());
                continue;
            }
            moved += 1;
            self.dispatch_quietly(Action::SetEngine {
                tab: tab.clone(),
                engine: Some(to),
            });
            self.drop_live_page(&tab);
            if holds.contains_key(&tab) {
                self.watch_first_paint(&tab);
            }
        }
        {
            let mut bridge = self.bridge.lock();
            if mode != EngineMode::Automatic {
                bridge.webkit.offers.clear();
            }
            bridge.webkit.mode_pending = None;
        }
        self.mark_dirty();
        moved
    }

    pub(crate) fn engine_back_of(&self, tab: &TabId) -> Option<(PageEngine, String)> {
        self.bridge.lock().webkit.engine_back.get(tab).cloned()
    }

    pub(crate) fn adjust_page_update(&self, tab: &TabId, update: &mut PageUpdate) {
        super::swap::hold(tab, update);
        if let Some(real) = update.can_go_back {
            let mut bridge = self.bridge.lock();
            bridge.webkit.real_can_go_back.insert(tab.clone(), real);
            if !real && bridge.webkit.engine_back.contains_key(tab) {
                update.can_go_back = Some(true);
            }
        }
    }

    pub(crate) fn go_back_across_engines(&self, tab: &TabId) -> bool {
        let Some((engine, url)) = self.engine_back_of(tab) else {
            return false;
        };
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return false;
        };
        if self
            .bridge
            .lock()
            .webkit
            .real_can_go_back
            .get(tab)
            .copied()
            .unwrap_or(false)
        {
            return false;
        }
        let forced = mode_engine_for(&state, listed, &url);
        if forced.is_some_and(|forced| forced != engine) {
            self.bridge.lock().webkit.engine_back.remove(tab);
            return false;
        }
        let Some(me) = self.weak().upgrade() else {
            return false;
        };
        let from = engines::current_url(listed).to_owned();
        let navigation = listed.live.navigation.clone();
        let window = listed.window_id.clone();
        let asks = state.settings.engine_switch_asks_about_unsaved_work;
        let unsaved = asks.then(|| self.has_unsaved_work(tab));
        let tab = tab.clone();
        self.spawn(async move {
            let still = |me: &Arc<Self>| {
                let state = me.store().snapshot();
                state.tab(tab.as_str()).is_some_and(|now| {
                    engines::current_url(now) == from && now.live.navigation == navigation
                }) && me
                    .engine_back_of(&tab)
                    .as_ref()
                    .map(|(e, u)| (e, u.as_str()))
                    == Some((&engine, url.as_str()))
            };
            if let Some(unsaved) = unsaved
                && unsaved.await
            {
                if !still(&me) {
                    return;
                }
                let (title, message, confirm) = confirm_for_back(engine);
                if !me
                    .ask_confirm(Some(window), title, message, confirm)
                    .await
                    .unwrap_or(false)
                {
                    return;
                }
            }
            if !still(&me) {
                return;
            }
            let held = me.hold_page_for_swap(&tab, engine, &url, false).await;
            if !still(&me) {
                me.drop_swap(&tab, held);
                return;
            }
            me.bridge.lock().webkit.engine_back.remove(&tab);
            me.dispatch_quietly(Action::SetEngine {
                tab: tab.clone(),
                engine: Some(engine),
            });
            me.drop_live_page(&tab);
            me.dispatch_quietly(Action::Navigate {
                tab: tab.clone(),
                input: url.clone(),
            });
            if held.is_some() {
                me.watch_first_paint(&tab);
            }
            me.mark_dirty();
        });
        true
    }
}

pub fn confirm_for_back(engine: PageEngine) -> (String, String, String) {
    (
        "Go back to the previous page?".to_owned(),
        format!(
            "It opens in {}, so changes you made on this page may not be saved.",
            engines::engine_name(engine)
        ),
        "Go Back".to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_engine::{BrowserEngine, MockBrowserEngine};
    use ardia_state::BrowserStore;
    use ardia_state::ids::IdGen;
    use ardia_state::persistence::session::{LoadOptions, SessionData};

    fn coordinator() -> (Arc<AppCoordinator>, TabId) {
        let store = Arc::new(BrowserStore::in_memory(
            BrowserState::from_session(
                SessionData::fresh(LoadOptions::default()),
                1_795_000_000_000,
            ),
            IdGen::with_launch("w10r"),
        ));
        let engine: Arc<dyn BrowserEngine> = Arc::new(MockBrowserEngine::started());
        let app = AppCoordinator::new(store, engine, crate::CoordinatorConfig::default());
        app.dispatch_quietly(Action::OpenLastWindowOrNew);
        let state = app.store().snapshot();
        let window = state.window_order[0].clone();
        app.dispatch_quietly(Action::NewTab {
            window,
            tab: NewTab {
                url: Some("https://a.example/".into()),
                ..NewTab::default()
            },
        });
        let tab = app
            .store()
            .snapshot()
            .tabs
            .values()
            .find(|t| t.url == "https://a.example/")
            .map(|t| t.id.clone())
            .unwrap();
        (app, tab)
    }

    #[test]
    fn the_engine_back_entry_keeps_back_enabled_until_the_page_has_its_own_history() {
        let (app, tab) = coordinator();
        let mut update = PageUpdate {
            can_go_back: Some(false),
            ..PageUpdate::default()
        };
        app.adjust_page_update(&tab, &mut update);
        assert_eq!(update.can_go_back, Some(false));
        app.bridge.lock().webkit.engine_back.insert(
            tab.clone(),
            (PageEngine::Webkit, "https://b.example/".into()),
        );
        let mut update = PageUpdate {
            can_go_back: Some(false),
            ..PageUpdate::default()
        };
        app.adjust_page_update(&tab, &mut update);
        assert_eq!(update.can_go_back, Some(true));
        app.dispatch_quietly(Action::UpdateSettings {
            patch: SettingsPatch::new().set("engineMode", EngineMode::Chromium),
            from_sync: false,
        });
        assert!(!app.go_back_across_engines(&tab));
        assert!(app.engine_back_of(&tab).is_none());
        assert_eq!(
            confirm_for_back(PageEngine::Webkit).1,
            "It opens in WebKit, so changes you made on this page may not be saved."
        );
        assert!(
            chromium_mode_toast("https://www.netflix.com").starts_with(
                "Protected video won't play in Chromium\nnetflix.com plays in WebKit."
            )
        );
    }

    #[test]
    fn copy_matches_the_old_app() {
        assert_eq!(
            confirm_for_switch(PageEngine::Webkit),
            (
                "Open this page in WebKit?".to_owned(),
                "The page reloads in WebKit, so changes you made on it may not be saved."
                    .to_owned(),
                "Open in WebKit".to_owned()
            )
        );
        assert_eq!(
            confirm_for_mode(EngineMode::Automatic, 1).1,
            "A page with unsaved changes reloads, so the changes may be lost."
        );
        assert_eq!(
            confirm_for_mode(EngineMode::Chromium, 3),
            (
                "Switch to Chromium?".to_owned(),
                "3 pages with unsaved changes reload, so the changes may be lost.".to_owned(),
                "Switch to Chromium".to_owned()
            )
        );
        assert_eq!(
            key_system_of(r#"{"keySystem":"com.widevine.alpha","stage":"access"}"#).as_deref(),
            Some("com.widevine.alpha")
        );
        assert_eq!(key_system_of("nope"), None);
    }
}
