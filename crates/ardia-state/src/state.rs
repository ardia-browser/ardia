use crate::air_traffic::{AirTrafficConfig, LinkSource, OpenAs, RoutedBy};
use crate::bookmarks::BookmarkTree;
use crate::closed::{ClearedTabs, ClosedEntry, ClosedLists, ParkedPins};
use crate::downloads::DownloadList;
use crate::groups::{self, Groups, TabGroup};
use crate::history::History;
use crate::ids::{ProfileId, SplitId, TabId, WindowId};
use crate::json::Fields;
use crate::model::{EffectiveLayout, Millis, SidebarSide, TabLayout, TabPin};
use crate::omnibox::engines::{SearchEngine, all_engines, engine_by_id, extension_engine_id};
use crate::omnibox::suggest::SuggestionIndex;
use crate::persistence::migrations::SESSION_VERSION;
use crate::persistence::session::SessionData;
use crate::profiles::Profile;
use crate::settings::{AddressBar, Appearance, Settings, SettingsMeta};
use crate::shortcuts::{Platform, ShortcutMap, default_sources};
use crate::splits::{MAX_SPLIT_PANES, SplitView};
use crate::tabs::Tab;
use crate::windows::{BrowserWindow, WindowKind};
use ardia_theme::{LookSource, PageFrame, Theme};
use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::Arc;

pub type ProfileMap = IndexMap<ProfileId, Arc<Profile>>;
pub type WindowMap = IndexMap<WindowId, Arc<BrowserWindow>>;
pub type TabMap = IndexMap<TabId, Arc<Tab>>;
pub type SplitMap = IndexMap<SplitId, Arc<SplitView>>;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Persisted {
    pub orphaned_profile_data: Vec<String>,
    pub parked_pins: IndexMap<ProfileId, ParkedPins>,
    pub pin_choices: Fields,
    pub pin_sync: Fields,
    pub top_apps_merged: String,
    pub extra: Fields,
    pub row_tables: bool,
}

#[derive(Clone, Debug, Default)]
pub struct BrowserState {
    pub profiles: Arc<ProfileMap>,
    pub profile_order: Arc<Vec<ProfileId>>,
    pub windows: Arc<WindowMap>,
    pub window_order: Arc<Vec<WindowId>>,
    pub focus_order: Arc<Vec<WindowId>>,
    pub tabs: Arc<TabMap>,
    pub groups: Arc<Groups>,
    pub splits: Arc<SplitMap>,
    pub closed: Arc<ClosedLists>,
    pub settings: Arc<Settings>,
    pub settings_meta: Arc<SettingsMeta>,
    pub last_profile_id: Option<ProfileId>,
    pub downloads: Arc<DownloadList>,
    pub history: Arc<IndexMap<String, Arc<History>>>,
    pub bookmarks: Arc<IndexMap<String, Arc<BookmarkTree>>>,
    pub air_traffic: Arc<AirTrafficConfig>,
    pub cleared: Arc<IndexMap<WindowId, ClearedTabs>>,
    pub private_site_mutes: Arc<IndexMap<WindowId, IndexMap<String, bool>>>,
    pub persisted: Arc<Persisted>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkDecision {
    pub profile_id: ProfileId,
    pub open: OpenAs,
    pub group_key: Option<String>,
    pub by: Option<RoutedBy>,
}

fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

pub fn section_rank(tab: &Tab, pinned_members: &HashSet<TabId>) -> u8 {
    match &tab.pin {
        Some(TabPin::Tile { .. }) => 0,
        Some(TabPin::Row) => 1,
        None if pinned_members.contains(&tab.id) => 1,
        None => 2,
    }
}

pub fn order_sections(ids: &[TabId], tabs: &TabMap, groups: &Groups) -> Vec<TabId> {
    let members = groups::pinned_group_members(groups);
    let rank = |id: &TabId| tabs.get(id).map_or(2, |t| section_rank(t, &members));
    let mut out: Vec<TabId> = ids.to_vec();
    out.sort_by_key(rank);
    out
}

fn sanitized_splits(splits: IndexMap<SplitId, SplitView>, tabs: &TabMap) -> (SplitMap, usize) {
    let panes = |count: usize| count + 1;
    let mut discarded = 0;
    let mut used: HashSet<TabId> = HashSet::new();
    let mut out = SplitMap::new();
    for (id, view) in splits {
        let before = panes(view.pane_count());
        let first = view
            .tab_ids()
            .first()
            .and_then(|t| tabs.get(t))
            .map(|t| t.profile_id.clone());
        let gone: HashSet<TabId> = view
            .tab_ids()
            .into_iter()
            .filter(|t| {
                !tabs.get(t).is_some_and(|tab| {
                    tab.window_id == view.window_id && Some(&tab.profile_id) == first.as_ref()
                }) || used.contains(t)
            })
            .collect();
        let fixed = if gone.is_empty() {
            view
        } else {
            view.without_panes(&gone)
        };
        if fixed.pane_count() < 2 || fixed.pane_count() > MAX_SPLIT_PANES {
            discarded += before;
            continue;
        }
        discarded += before - panes(fixed.pane_count());
        used.extend(fixed.tab_ids());
        out.insert(id, Arc::new(fixed.normalized()));
    }
    (out, discarded)
}

impl BrowserState {
    pub fn from_session(data: SessionData, now: Millis) -> BrowserState {
        Self::hydrate(data, now).0
    }

    pub fn hydrate(data: SessionData, now: Millis) -> (BrowserState, usize) {
        let mut discarded = 0;
        let mut profiles: ProfileMap = data
            .profiles
            .into_iter()
            .map(|(id, p)| (id, Arc::new(p)))
            .collect();
        if profiles.is_empty() {
            let p = Profile::default_profile();
            profiles.insert(p.id.clone(), Arc::new(p));
        }
        let profile_ok = |p: &ProfileId| profiles.contains_key(p) || p.is_incognito();
        let mut tabs: TabMap = TabMap::new();
        for (id, mut tab) in data.tabs {
            if !data.windows.contains_key(&tab.window_id) || !profile_ok(&tab.profile_id) {
                discarded += 1;
                continue;
            }
            if tab.pinned_url.is_none() && tab.pin.is_some() {
                tab.pinned_url = Some(tab.url.clone()).filter(|u| !u.is_empty());
            }
            tabs.insert(id, Arc::new(tab));
        }
        let groups_in: Groups = data
            .groups
            .into_iter()
            .map(|(id, g)| (id, Arc::new(g)))
            .collect();
        let mut windows = WindowMap::new();
        for (id, mut w) in data.windows {
            let mut members: Vec<TabId> = Vec::with_capacity(w.tab_ids.len());
            for t in &w.tab_ids {
                if tabs.get(t).is_some_and(|tab| tab.window_id == w.id) && !members.contains(t) {
                    members.push(t.clone());
                }
            }
            discarded += w.tab_ids.len() - members.len();
            let tab_ids = order_sections(&members, &tabs, &groups_in);
            let Some(first) = tab_ids.first() else {
                discarded += 1;
                continue;
            };
            w.active_tab_ids
                .retain(|p, t| tab_ids.contains(t) && &tabs[&*t].profile_id == p);
            if !tab_ids.iter().any(|t| tabs[t].profile_id == w.profile_id) {
                w.profile_id = tabs[first].profile_id.clone();
            }
            let profile = w.profile_id.clone();
            if !w.active_tab_ids.contains_key(&profile)
                && let Some(t) = tab_ids.iter().find(|t| tabs[*t].profile_id == profile)
            {
                w.active_tab_ids.insert(profile, t.clone());
            }
            w.tab_ids = tab_ids;
            w.kind = WindowKind::Main;
            windows.insert(id, Arc::new(w));
        }
        let listed: HashSet<&TabId> = windows.values().flat_map(|w| w.tab_ids.iter()).collect();
        let unlisted = tabs.keys().filter(|t| !listed.contains(t)).count();
        discarded += unlisted;
        if unlisted > 0 {
            let listed: HashSet<TabId> = listed.into_iter().cloned().collect();
            tabs.retain(|id, _| listed.contains(id));
        }
        let mut window_order: Vec<WindowId> = data
            .window_order
            .into_iter()
            .filter(|id| windows.contains_key(id))
            .collect();
        for id in windows.keys() {
            if !window_order.contains(id) {
                window_order.push(id.clone());
            }
        }
        let mut groups = Groups::new();
        for (id, g) in groups_in {
            let tab_ids: Vec<TabId> = g
                .tab_ids
                .iter()
                .filter(|t| tabs.get(*t).is_some_and(|tab| tab.window_id == g.window_id))
                .cloned()
                .collect();
            discarded += g.tab_ids.len() - tab_ids.len();
            if tab_ids.is_empty() {
                discarded += 1;
                continue;
            }
            let mut g = (*g).clone();
            g.tab_ids = tab_ids;
            groups.insert(id, Arc::new(g));
        }
        let snapshot = groups.clone();
        groups::reparent(&mut groups, &snapshot);
        let nested = groups::nest_groups(&groups);
        for (id, before) in &groups {
            match nested.get(id) {
                Some(after) => {
                    discarded += before
                        .tab_ids
                        .iter()
                        .filter(|t| !after.tab_ids.contains(t))
                        .count()
                }
                None => discarded += before.tab_ids.len() + 1,
            }
        }
        let groups = nested;
        let (splits, split_losses) = sanitized_splits(data.splits, &tabs);
        discarded += split_losses;
        let mut profile_order: Vec<ProfileId> = data
            .profile_order
            .into_iter()
            .filter(|p| profiles.contains_key(p))
            .collect();
        for id in profiles.keys() {
            if !profile_order.contains(id) {
                profile_order.push(id.clone());
            }
        }
        let mut settings = data.settings;
        if !profiles.contains_key(settings.default_profile_id.as_str()) {
            settings.default_profile_id = profile_order[0].to_string();
        }
        let focused = data
            .focused_window_id
            .filter(|id| windows.contains_key(id))
            .or_else(|| window_order.last().cloned());
        let focus_order: Vec<WindowId> = match &focused {
            Some(f) => std::iter::once(f.clone())
                .chain(window_order.iter().rev().filter(|id| *id != f).cloned())
                .collect(),
            None => Vec::new(),
        };
        let mut closed = data.closed;
        closed.purge_week_old(now);
        closed
            .cleaned_tabs
            .retain(|c| !c.tab.profile_id.is_incognito());
        let keep_profile = |p: &str| profiles.contains_key(p);
        let unknown = data
            .parked_pins
            .keys()
            .filter(|p| !keep_profile(p.as_str()))
            .count()
            + data.pin_choices.keys().filter(|p| !keep_profile(p)).count()
            + data.pin_sync.keys().filter(|p| !keep_profile(p)).count();
        discarded += unknown;
        let persisted = Persisted {
            orphaned_profile_data: data.orphaned_profile_data,
            parked_pins: data
                .parked_pins
                .into_iter()
                .filter(|(p, _)| keep_profile(p.as_str()))
                .collect(),
            pin_choices: data
                .pin_choices
                .into_iter()
                .filter(|(p, _)| keep_profile(p))
                .collect(),
            pin_sync: data
                .pin_sync
                .into_iter()
                .filter(|(p, _)| keep_profile(p))
                .collect(),
            top_apps_merged: data.top_apps_merged,
            extra: data.extra,
            row_tables: data.row_tables,
        };
        let state = BrowserState {
            last_profile_id: data.last_profile_id.filter(|p| profiles.contains_key(p)),
            profiles: Arc::new(profiles),
            profile_order: Arc::new(profile_order),
            windows: Arc::new(windows),
            window_order: Arc::new(window_order),
            focus_order: Arc::new(focus_order),
            tabs: Arc::new(tabs),
            groups: Arc::new(groups),
            splits: Arc::new(splits),
            closed: Arc::new(closed),
            settings: Arc::new(settings),
            settings_meta: Arc::new(data.settings_meta),
            persisted: Arc::new(persisted),
            ..BrowserState::default()
        };
        let state = if state.settings.restore_session {
            state
        } else {
            state.closed_for_launch(now)
        };
        (state, discarded)
    }

    fn closed_for_launch(mut self, now: Millis) -> BrowserState {
        let ids = crate::ids::IdGen::with_launch(crate::ids::to_base36(now.max(0) as u64));
        let windows: Vec<WindowId> = self.window_order.iter().cloned().collect();
        let mut tx = crate::actions::Tx::new(&mut self, now, &ids);
        for w in windows {
            tx.close_window(&w, false);
        }
        Arc::make_mut(&mut self.closed).forget_launch_hints();
        self
    }

    pub fn tab(&self, id: &str) -> Option<&Arc<Tab>> {
        self.tabs.get(id)
    }

    pub fn window(&self, id: &str) -> Option<&Arc<BrowserWindow>> {
        self.windows.get(id)
    }

    pub fn profile(&self, id: &str) -> Option<&Arc<Profile>> {
        self.profiles.get(id)
    }

    pub fn group(&self, id: &str) -> Option<&Arc<TabGroup>> {
        self.groups.get(id)
    }

    pub fn split(&self, id: &str) -> Option<&Arc<SplitView>> {
        self.splits.get(id)
    }

    pub fn is_empty_card_tab(&self, tab: &Tab) -> bool {
        tab.pin.is_none()
            && tab.url.is_empty()
            && !tab.page.has_page()
            && self.split_of(tab.id.as_str()).is_none()
    }

    pub fn new_tab_opens_bar(&self) -> bool {
        self.settings.new_tab_opens() == crate::settings::NewTabOpens::CommandBar
    }

    pub fn hidden_empty_card(&self, tab: &Tab) -> bool {
        self.new_tab_opens_bar() && self.is_empty_card_tab(tab)
    }

    pub fn view_tabs(&self, window: &str, profile: Option<&ProfileId>) -> Vec<&Arc<Tab>> {
        let Some(w) = self.windows.get(window) else {
            return Vec::new();
        };
        let profile = profile.unwrap_or(&w.profile_id);
        w.tab_ids
            .iter()
            .filter_map(|id| self.tabs.get(id))
            .filter(|t| &t.profile_id == profile)
            .collect()
    }

    pub fn active_tab(&self, window: &str) -> Option<&Arc<Tab>> {
        let w = self.windows.get(window)?;
        let id = w.active_tab()?;
        self.tabs.get(id).filter(|t| t.window_id == w.id)
    }

    pub fn shown_peek(&self, window: &str) -> Option<&crate::windows::PeekCard> {
        let w = self.windows.get(window)?;
        let peek = w.chrome.peek.as_ref()?;
        let source_shown = peek
            .source_tab_id
            .as_ref()
            .is_none_or(|s| w.active_tab() == Some(s));
        (source_shown && self.tabs.get(&peek.tab_id).is_some_and(|t| t.live.peek)).then_some(peek)
    }

    pub fn fullscreen_tab(&self, window: &str) -> Option<&Arc<Tab>> {
        let full = |id: &str| self.tabs.get(id).filter(|t| t.live.fullscreen);
        if let Some(peek) = self.shown_peek(window)
            && let Some(tab) = full(peek.tab_id.as_str())
        {
            return Some(tab);
        }
        let active = self.windows.get(window)?.active_tab()?;
        if let Some(split) = self.split_of(active.as_str()) {
            for pane in split.tab_ids() {
                if let Some(tab) = full(pane.as_str()) {
                    return Some(tab);
                }
            }
        }
        full(active.as_str())
    }

    pub fn split_of(&self, tab: &str) -> Option<&Arc<SplitView>> {
        self.splits.values().find(|s| s.contains(tab))
    }

    pub fn group_of(&self, tab: &str) -> Option<&Arc<TabGroup>> {
        groups::innermost_group_of(&self.groups, tab).and_then(|g| self.groups.get(&g))
    }

    pub fn in_pinned_container(&self, tab: &str) -> bool {
        self.tabs.get(tab).is_some_and(|t| {
            t.is_pinned()
                || self
                    .groups
                    .values()
                    .any(|g| g.pinned && g.tab_ids.iter().any(|m| m == tab))
        })
    }

    pub fn tab_layout(&self, window: &str) -> TabLayout {
        self.windows
            .get(window)
            .and_then(|w| w.tab_layout)
            .unwrap_or(self.settings.tab_layout)
    }

    pub fn minimalism_in(&self, window: &str) -> bool {
        self.settings.minimalism_mode
            && self
                .windows
                .get(window)
                .is_none_or(|w| w.kind != WindowKind::LittleArdia)
    }

    pub fn effective_layout(&self, window: &str) -> EffectiveLayout {
        EffectiveLayout::of(
            self.tab_layout(window),
            self.settings.address_bar == AddressBar::Sidebar || self.minimalism_in(window),
        )
    }

    pub fn page_frame_inset_in(&self, window: &str, full_screen: bool) -> f32 {
        let mut rules = self
            .settings
            .frame_rules(full_screen, self.auto_hides_tabs(window));
        rules.borderless_mode |= self.minimalism_in(window);
        ardia_theme::layout::page_frame_inset(self.settings.page_frame as f32, rules)
    }

    pub fn auto_hides_tabs(&self, window: &str) -> bool {
        self.windows
            .get(window)
            .and_then(|w| w.auto_hide_tabs)
            .unwrap_or(self.settings.auto_hide_tabs)
    }

    pub fn sidebar_shown(&self, window: &str) -> bool {
        self.windows
            .get(window)
            .is_some_and(|w| w.kind.shows_sidebar())
            && !self.auto_hides_tabs(window)
    }

    pub fn sidebar_side(&self, window: &str) -> SidebarSide {
        match self.windows.get(window) {
            Some(w) if w.kind == WindowKind::LittleArdia => SidebarSide::Left,
            _ if self.tab_layout(window) == TabLayout::Sidebar => self.settings.sidebar_side,
            _ => SidebarSide::Left,
        }
    }

    pub fn sidebar_width(&self, window_width: Option<f32>) -> f32 {
        ardia_theme::layout::shown_sidebar_width(self.settings.sidebar_width as f32, window_width)
    }

    pub fn page_frame(
        &self,
        window: &str,
        window_radius: f32,
        drawn_window_radius: f32,
    ) -> PageFrame {
        let full_screen = self.windows.get(window).is_some_and(|w| w.is_full_screen());
        let inset = self.page_frame_inset_in(window, full_screen);
        PageFrame::concentric(inset, window_radius, drawn_window_radius)
    }

    pub fn engine_profile(&self, profile: &ProfileId) -> String {
        if profile.is_incognito() {
            return format!(
                "{}@{}",
                profile.as_str().split('@').next().unwrap_or(""),
                self.engine_profile(&profile.incognito_original())
            );
        }
        self.profiles.get(profile).map_or_else(
            || {
                if profile.as_str() == crate::ids::DEFAULT_PROFILE_ID {
                    String::new()
                } else {
                    profile.to_string()
                }
            },
            |p| p.engine_profile(),
        )
    }

    pub fn last_active_profile(&self) -> ProfileId {
        if let Some(last) = self
            .last_profile_id
            .as_ref()
            .filter(|p| self.profiles.contains_key(*p))
        {
            return last.clone();
        }
        for id in self
            .focus_order
            .iter()
            .chain(self.window_order.iter().rev())
        {
            if let Some(w) = self
                .windows
                .get(id)
                .filter(|w| w.kind != WindowKind::LittleArdia)
            {
                let profile = if w.profile_id.is_incognito() {
                    w.profile_id.incognito_original()
                } else {
                    w.profile_id.clone()
                };
                if self.profiles.contains_key(&profile) {
                    return profile;
                }
            }
        }
        ProfileId::new(&self.settings.default_profile_id)
    }

    pub fn main_window_for(&self, profile: Option<&ProfileId>) -> Option<&WindowId> {
        let order: Vec<&WindowId> = self
            .focus_order
            .iter()
            .chain(self.window_order.iter())
            .filter(|id| {
                self.windows
                    .get(*id)
                    .is_some_and(|w| w.kind == WindowKind::Main)
            })
            .collect();
        profile
            .and_then(|p| {
                order
                    .iter()
                    .find(|id| &self.windows[**id].profile_id == p)
                    .copied()
            })
            .or_else(|| order.first().copied())
    }

    pub fn app_dark(&self, system_dark: bool) -> bool {
        match self.settings.appearance {
            Appearance::Auto => system_dark,
            Appearance::Light => false,
            Appearance::Dark => true,
        }
    }

    pub fn theme(&self, window: &str, system_dark: bool, system_increase_contrast: bool) -> Theme {
        let app_dark = self.app_dark(system_dark);
        let source = if self.settings.spaces_follow_appearance {
            LookSource::App
        } else {
            LookSource::Own
        };
        let w = self.windows.get(window);
        let incognito = w.is_some_and(|w| w.kind == WindowKind::Incognito);
        let profile = w.map_or_else(
            || self.last_active_profile(),
            |w| {
                if w.profile_id.is_incognito() {
                    w.profile_id.incognito_original()
                } else {
                    w.profile_id.clone()
                }
            },
        );
        let (color, custom) = self
            .profiles
            .get(&profile)
            .map_or((ardia_theme::ProfileColor::Plum, None), |p| {
                (p.color.preset(), p.theme.clone())
            });
        let theme = Theme::scoped(
            incognito,
            color,
            custom.as_ref(),
            app_dark,
            source,
            self.settings.adapt_text_to_color,
        )
        .tinted();
        if self.settings.high_contrast_text(system_increase_contrast) {
            theme.high_contrast()
        } else {
            theme
        }
    }

    pub fn history_of(&self, profile: &ProfileId) -> Option<&Arc<History>> {
        self.history.get(&self.engine_profile(profile))
    }

    pub fn bookmarks_of(&self, profile: &ProfileId) -> Option<&Arc<BookmarkTree>> {
        self.bookmarks.get(&self.engine_profile(profile))
    }

    pub fn suggestion_history(&self, profile: &ProfileId) -> Option<&Arc<History>> {
        self.history_of(profile)
            .filter(|_| self.settings.command_bar_history)
    }

    pub fn suggestion_bookmarks(&self, profile: &ProfileId) -> Option<&Arc<BookmarkTree>> {
        self.bookmarks_of(profile)
            .filter(|_| self.settings.show_bookmarks)
    }

    pub fn suggestion_index(&self, profile: &ProfileId) -> SuggestionIndex {
        let history = self.suggestion_history(profile);
        let bookmarks = self.suggestion_bookmarks(profile);
        SuggestionIndex::build(
            history.into_iter().flat_map(|h| h.rows()),
            bookmarks.into_iter().flat_map(|b| b.rows()),
        )
    }

    pub fn search_engines(&self) -> Vec<SearchEngine> {
        all_engines(
            &self.settings.custom_search_engines,
            &self.settings.extension_search_engines,
            &self.settings.custom_search_url,
        )
    }

    pub fn default_search_engine(&self) -> SearchEngine {
        let engines = self.search_engines();
        let controlling = self
            .settings
            .extension_search_engines
            .iter()
            .find(|e| e.is_default)
            .map(|e| extension_engine_id(&e.extension_id));
        engine_by_id(
            &engines,
            controlling
                .as_deref()
                .unwrap_or(&self.settings.search_engine),
        )
    }

    pub fn shortcut_map(&self, platform: Platform) -> ShortcutMap {
        ShortcutMap::resolve(
            &default_sources(platform, &self.profile_order),
            &self.settings.shortcuts,
        )
    }

    pub fn route_link(&self, url: &str, source: &LinkSource) -> LinkDecision {
        let usable = |p: &ProfileId, group: Option<&str>| {
            self.profiles.contains_key(p)
                && !p.is_incognito()
                && group.is_none_or(|key| {
                    self.groups
                        .values()
                        .any(|g| &g.profile_id == p && g.pin_key() == key)
                })
        };
        match self.air_traffic.route(url, source, usable) {
            Some(route) => LinkDecision {
                profile_id: route
                    .target
                    .profile_id
                    .unwrap_or_else(|| self.last_active_profile()),
                open: route.target.open,
                group_key: route.target.group_key,
                by: Some(route.by),
            },
            None => LinkDecision {
                profile_id: self.last_active_profile(),
                open: if self.settings.open_links_in_little_ardia {
                    OpenAs::LittleArdia
                } else {
                    OpenAs::Tab
                },
                group_key: None,
                by: None,
            },
        }
    }

    pub fn newest_closed(&self, window: Option<&WindowId>) -> Option<ClosedEntry<'_>> {
        let target = window.and_then(|w| self.windows.get(w));
        let private = target.is_some_and(|w| w.kind == WindowKind::Incognito);
        let shown = |profile: &ProfileId| target.is_none_or(|w| &w.profile_id == profile);
        self.closed.newest(|entry| match entry {
            ClosedEntry::Tab(c) if c.tab.profile_id.is_incognito() => {
                target.is_some_and(|w| w.id == c.window_id)
            }
            ClosedEntry::Tab(c) => !private && shown(&c.tab.profile_id),
            ClosedEntry::Window(c) => !private && c.window.profile_id.as_ref().is_none_or(shown),
            ClosedEntry::Group(c) => {
                !private && c.tabs.first().is_none_or(|t| shown(&t.profile_id))
            }
        })
    }

    pub fn saved_windows(&self) -> impl Iterator<Item = &Arc<BrowserWindow>> {
        self.window_order
            .iter()
            .filter_map(|id| self.windows.get(id))
            .filter(|w| w.kind.is_saved())
    }

    pub fn to_session_value(&self) -> Value {
        let saved: HashSet<&WindowId> = self.saved_windows().map(|w| &w.id).collect();
        let public = |p: &ProfileId| !p.is_incognito();
        let rows = |list: Vec<Value>| -> Value {
            if self.persisted.row_tables {
                Value::Object(
                    list.into_iter()
                        .filter_map(|row| Some((row.get("id")?.as_str()?.to_owned(), row)))
                        .collect(),
                )
            } else {
                Value::Array(list)
            }
        };
        let mut out = Map::new();
        out.insert(
            "profiles".into(),
            Value::Object(
                self.profiles
                    .iter()
                    .filter(|(id, _)| public(id))
                    .map(|(id, p)| (id.to_string(), to_json(&**p)))
                    .collect(),
            ),
        );
        out.insert(
            "profileOrder".into(),
            Value::Array(
                self.profile_order
                    .iter()
                    .filter(|p| public(p))
                    .map(|p| Value::from(p.as_str()))
                    .collect(),
            ),
        );
        out.insert(
            "orphanedProfileData".into(),
            self.persisted
                .orphaned_profile_data
                .iter()
                .map(|s| Value::from(s.as_str()))
                .collect(),
        );
        out.insert("settings".into(), self.settings.to_value());
        out.insert("settingsMeta".into(), to_json(&*self.settings_meta));
        out.insert(
            "windows".into(),
            rows(self.saved_windows().map(|w| to_json(&**w)).collect()),
        );
        out.insert(
            "windowOrder".into(),
            Value::Array(
                self.saved_windows()
                    .map(|w| Value::from(w.id.as_str()))
                    .collect(),
            ),
        );
        out.insert(
            "focusedWindowId".into(),
            self.focus_order
                .iter()
                .find(|id| saved.contains(id))
                .map_or(Value::Null, |id| Value::from(id.as_str())),
        );
        out.insert(
            "lastProfileId".into(),
            self.last_profile_id
                .as_ref()
                .map_or(Value::Null, |p| Value::from(p.as_str())),
        );
        out.insert(
            "tabs".into(),
            rows(
                self.tabs
                    .values()
                    .filter(|t| {
                        saved.contains(&t.window_id) && public(&t.profile_id) && !t.live.peek
                    })
                    .map(|t| to_json(&**t))
                    .collect(),
            ),
        );
        out.insert(
            "groups".into(),
            rows(
                self.groups
                    .values()
                    .filter(|g| saved.contains(&g.window_id))
                    .map(|g| to_json(&**g))
                    .collect(),
            ),
        );
        out.insert(
            "splits".into(),
            rows(
                self.splits
                    .values()
                    .filter(|s| saved.contains(&s.window_id))
                    .map(|s| to_json(&**s))
                    .collect(),
            ),
        );
        out.insert(
            "closedTabs".into(),
            Value::Array(
                self.closed
                    .tabs
                    .iter()
                    .filter(|c| public(&c.tab.profile_id))
                    .map(to_json)
                    .collect(),
            ),
        );
        out.insert(
            "closedWindows".into(),
            Value::Array(
                self.closed
                    .windows
                    .iter()
                    .filter(|c| c.tabs.iter().all(|t| public(&t.snapshot.profile_id)))
                    .map(to_json)
                    .collect(),
            ),
        );
        out.insert(
            "parkedPins".into(),
            Value::Object(
                self.persisted
                    .parked_pins
                    .iter()
                    .filter(|(p, _)| public(p))
                    .map(|(p, park)| (p.to_string(), to_json(park)))
                    .collect(),
            ),
        );
        out.insert(
            "pinChoices".into(),
            Value::Object(self.persisted.pin_choices.clone()),
        );
        out.insert(
            "pinSync".into(),
            Value::Object(self.persisted.pin_sync.clone()),
        );
        out.insert(
            "topAppsMerged".into(),
            Value::from(self.persisted.top_apps_merged.as_str()),
        );
        out.insert(
            "closedGroups".into(),
            Value::Array(
                self.closed
                    .groups
                    .iter()
                    .filter(|c| c.tabs.iter().all(|t| public(&t.profile_id)))
                    .map(to_json)
                    .collect(),
            ),
        );
        out.insert(
            "deletedGroups".into(),
            Value::Array(
                self.closed
                    .deleted_groups
                    .iter()
                    .filter(|c| c.tabs.iter().all(|t| public(&t.profile_id)))
                    .map(to_json)
                    .collect(),
            ),
        );
        out.insert(
            "cleanedTabs".into(),
            Value::Array(
                self.closed
                    .cleaned_tabs
                    .iter()
                    .filter(|c| public(&c.tab.profile_id))
                    .map(to_json)
                    .collect(),
            ),
        );
        for (key, value) in &self.persisted.extra {
            out.entry(key.clone()).or_insert_with(|| value.clone());
        }
        out.insert("version".into(), SESSION_VERSION.into());
        Value::Object(out)
    }

    pub fn session_json(&self) -> String {
        serde_json::to_string(&self.to_session_value()).unwrap_or_else(|_| "{}".to_owned())
    }

    pub fn profile_index(
        &self,
        window: &WindowId,
        profile: &ProfileId,
        tab: &TabId,
    ) -> Option<usize> {
        let w = self.windows.get(window)?;
        let mut i = 0;
        for id in &w.tab_ids {
            if id == tab {
                return Some(i);
            }
            if self.tabs.get(id).is_some_and(|t| &t.profile_id == profile) {
                i += 1;
            }
        }
        None
    }
}
