pub mod frame;
pub mod hero;
pub mod labels;
pub mod pulse;
pub mod view;

use std::collections::HashMap;
use std::sync::Arc;

use ardia_state::bookmarks::BookmarkTree;
use ardia_state::commands::{COMMANDS, Command};
use ardia_state::history::History;
use ardia_state::omnibox::Bangs;
use ardia_state::omnibox::engines::SearchEngine;
use ardia_state::omnibox::providers::{
    ExtensionCandidate, ExtensionOpen, PluginProvider, ProviderConfig, ProviderRow,
    ProviderSection, QUERY_SLOT, ROWS_PER_PROVIDER, fill_provider_template, match_provider_rows,
    provider_configs, remote_request_allowed,
};
use ardia_state::omnibox::site_search::{
    KeyModifiers, KeywordProvider, ScopeKey, ScopeSources, SearchScope, SiteSearchKey,
    SiteSearchKeyState, keyword_by_space, keyword_scope, offered_site_search, scoped_search_url,
    site_search_key,
};
use ardia_state::omnibox::suggest::{
    CommandAction, OpenTabRow, SuggestOptions, Suggestion, SuggestionIndex, SuggestionResult,
    build_suggestions,
};
use ardia_state::omnibox::url::resolve_input;
use ardia_state::windows::{CommandBarPlacementState, NewTabTarget};
use ardia_state::{BrowserState, TabId, WindowId};
use gpui::{AppContext, Entity, Pixels, Point, Window};

use crate::keybindings;
use crate::primitives::text_input::{InputStyle, TextInput};

pub use frame::Variant;
pub use view::command_panel;

pub const SUGGESTION_LIMIT: usize = 8;
pub const OPEN_TAB_START_LIMIT: usize = 8;
pub const ADD_CHIP_OTHER_TABS: usize = 12;
pub const PROVIDER_MAX_QUERY: usize = 512;

type IndexKey = (Option<usize>, Option<usize>);

pub struct PanelRequest<'a> {
    pub text: &'a str,
    pub new_tab: Option<NewTabTarget>,
    pub placement: CommandBarPlacementState,
    pub style: InputStyle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    Current,
    NewTab,
    NewWindow,
    Split,
}

impl Disposition {
    pub fn of(meta: bool, alt: bool, shift: bool) -> Self {
        if alt {
            Disposition::Split
        } else if meta {
            Disposition::NewTab
        } else if shift {
            Disposition::NewWindow
        } else {
            Disposition::Current
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelKey {
    PageUp,
    PageDown,
    Previous,
    Next,
    Tab,
    LeaveScope,
    RemoveSelected,
    Enter {
        meta: bool,
        alt: bool,
        shift: bool,
        ctrl: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum PanelMsg {
    Key(PanelKey),
    Pick(usize),
    Remove(usize),
    Go,
    AddMenu(Option<Point<Pixels>>),
    SwitchTo(TabId),
    OpenFile,
    Dictate,
    SiteControls,
    RowsHovered(bool),
}

#[derive(Clone, Debug)]
struct WaitingRows {
    key: String,
    result: SuggestionResult,
    completion: String,
    offered: Option<SearchScope>,
}

pub fn same_rows(a: &[Suggestion], b: &[Suggestion]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.key() == y.key())
}

pub fn rows_wait(
    holding: bool,
    shown_key: Option<&str>,
    shown: &[Suggestion],
    key: &str,
    next: &[Suggestion],
) -> bool {
    holding && shown_key == Some(key) && !shown.is_empty() && !same_rows(shown, next)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Stay,
    Close,
    Go {
        url: String,
        disposition: Disposition,
    },
    Switch {
        tab: TabId,
        url: String,
        disposition: Disposition,
    },
    Command(String),
    Copy(String),
    Remove(String),
    Bookmarklet(String),
    Extension {
        id: String,
        open: ExtensionOpen,
    },
}

pub struct CommandPanel {
    pub input: Entity<TextInput>,
    pub result: SuggestionResult,
    pub selected: Option<usize>,
    pub new_tab: Option<NewTabTarget>,
    pub placement: CommandBarPlacementState,
    pub variant: Variant,
    pub scope: Option<SearchScope>,
    pub offered: Option<SearchScope>,
    pub add_menu: Option<Point<Pixels>>,
    pub hero_tab: Option<TabId>,
    pub incognito: bool,
    pub extensions: Vec<ExtensionCandidate>,
    pub providers: Vec<ActiveProvider>,
    provider_rows: HashMap<String, (String, Vec<ProviderRow>)>,
    remote: Vec<String>,
    remote_sites: Vec<(String, String)>,
    remote_for: String,
    typed: String,
    edited: bool,
    completion: String,
    scope_from: String,
    initial_text: String,
    split_from: bool,
    hero_saved: HashMap<TabId, String>,
    index: Option<(IndexKey, Arc<SuggestionIndex>)>,
    actions: Arc<Vec<CommandAction>>,
    open: bool,
    shown_rows_key: Option<String>,
    waiting_rows: Option<WaitingRows>,
    pointer_over_rows: bool,
    freed_rows_key: Option<String>,
    counted_held_key: Option<String>,
}

fn index_key(history: Option<&Arc<History>>, bookmarks: Option<&Arc<BookmarkTree>>) -> IndexKey {
    (
        history.map(|h| Arc::as_ptr(h) as usize),
        bookmarks.map(|b| Arc::as_ptr(b) as usize),
    )
}

const CLOSE_DUPLICATE_KEYWORDS: &[&str] = &[
    "close duplicate tabs",
    "dedupe",
    "deduplicate tabs",
    "duplicates",
    "remove duplicate tabs",
];

const TIDY_PINS_KEYWORDS: &[&str] = &[
    "tidy pinned tabs",
    "organize pins",
    "pinned folders",
    "remove duplicate pins",
];

fn sort_keywords(arg: &str) -> &'static [&'static str] {
    match arg {
        "site" => &["sort by site", "sort by domain", "order tabs"],
        _ => &[
            "sort by title",
            "sort by name",
            "alphabetize tabs",
            "order tabs",
        ],
    }
}

fn window_actions(state: &BrowserState, window: Option<&str>) -> Vec<CommandAction> {
    let Some(window) = window.filter(|w| state.window(w).is_some()) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    if ardia_state::duplicate_tabs::has_duplicate_tabs(state, window) {
        let id = Command::CloseDuplicateTabs.id();
        rows.push(CommandAction {
            id: id.to_owned(),
            title: Command::CloseDuplicateTabs.spec().command_bar_title(None),
            keywords: CLOSE_DUPLICATE_KEYWORDS
                .iter()
                .map(|k| (*k).to_owned())
                .collect(),
            hint: keybindings::hint(state, id),
        });
    }
    if ardia_state::tidy::can_tidy_pins(state, window) {
        let id = Command::TidyPins.id();
        rows.push(CommandAction {
            id: id.to_owned(),
            title: Command::TidyPins.spec().command_bar_title(None),
            keywords: TIDY_PINS_KEYWORDS.iter().map(|k| (*k).to_owned()).collect(),
            hint: keybindings::hint(state, id),
        });
    }
    let target = crate::sidebar::sort_tabs::SortTarget::window(&ardia_state::WindowId::new(window));
    if crate::sidebar::sort_tabs::sortable_count(state, &target) >= 2 {
        let spec = Command::SortTabs.spec();
        for variant in spec.variants {
            let id = format!("{}:{}", Command::SortTabs.id(), variant.arg);
            rows.push(CommandAction {
                title: spec.command_bar_title(Some(variant.arg)),
                hint: keybindings::hint(state, &id),
                id,
                keywords: sort_keywords(variant.arg)
                    .iter()
                    .map(|k| (*k).to_owned())
                    .collect(),
            });
        }
    }
    rows.extend(mute_actions(state, window));
    rows
}

const MUTE_KEYWORDS: &[&str] = &["mute", "unmute", "silence", "mute tab"];
const SITE_MUTE_KEYWORDS: &[&str] = &["mute site", "unmute site", "silence site"];

fn mute_actions(state: &BrowserState, window: &str) -> Vec<CommandAction> {
    let Some(tab) = state.active_tab(window) else {
        return Vec::new();
    };
    let mute = ardia_state::mute::mute_state(state, tab);
    let id = Command::ToggleMute.id();
    let site_id = format!("{id}:site");
    let words = |list: &[&str]| list.iter().map(|k| (*k).to_owned()).collect();
    vec![
        CommandAction {
            id: id.to_owned(),
            title: ardia_state::mute::mute_title(mute).to_owned(),
            keywords: words(MUTE_KEYWORDS),
            hint: keybindings::hint(state, id),
        },
        CommandAction {
            title: ardia_state::mute::site_mute_title(mute).to_owned(),
            keywords: words(SITE_MUTE_KEYWORDS),
            hint: keybindings::hint(state, &site_id),
            id: site_id,
        },
    ]
}

fn needs_a_window(command: Command) -> bool {
    matches!(
        command,
        Command::CloseDuplicateTabs | Command::SortTabs | Command::ToggleMute | Command::TidyPins
    )
}

impl CommandPanel {
    pub fn add_actions(&mut self, more: Vec<CommandAction>) {
        if more.is_empty() {
            return;
        }
        let mut all = (*self.actions).clone();
        all.extend(more);
        self.actions = Arc::new(all);
    }
}

pub fn command_actions(state: &BrowserState, window: Option<&str>) -> Vec<CommandAction> {
    let mut actions: Vec<CommandAction> = COMMANDS
        .iter()
        .filter(|spec| !spec.command.id().starts_with("std:"))
        .filter(|spec| !needs_a_window(spec.command))
        .filter(|spec| spec.variants.is_empty() || spec.chooses.is_some())
        .flat_map(|spec| {
            let base = spec.command.id();
            let mut rows = Vec::new();
            if spec.chooses.is_some() {
                for variant in spec.variants {
                    let id = format!("{base}:{}", variant.arg);
                    rows.push(CommandAction {
                        title: spec.command_bar_title(Some(variant.arg)),
                        hint: keybindings::hint(state, &id),
                        id,
                        keywords: vec![spec.title.to_lowercase()],
                    });
                }
            } else {
                rows.push(CommandAction {
                    id: base.to_owned(),
                    title: spec.command_bar_title(None),
                    keywords: Vec::new(),
                    hint: keybindings::hint(state, base),
                });
            }
            rows
        })
        .collect();
    actions.extend(window_actions(state, window));
    actions
}

pub fn placeholder(scope: Option<&SearchScope>, incognito: bool) -> String {
    match scope {
        Some(scope) => format!("Search {}", scope.name),
        None if incognito => "Search privately or enter address".to_owned(),
        None => "Search or enter address".to_owned(),
    }
}

pub fn force_search_url(
    scope: Option<&SearchScope>,
    text: &str,
    engine: &SearchEngine,
) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(match scope {
        Some(scope) => scoped_search_url(scope, text, engine),
        None => engine.search_url(text),
    })
}

pub fn www_guess(text: &str) -> Option<String> {
    let word = text.trim();
    (!word.is_empty()
        && !word.contains(|c: char| c.is_whitespace() || matches!(c, '.' | '/' | ':')))
    .then(|| format!("https://www.{word}.com"))
}

fn inserted_many(before: &str, after: &str) -> bool {
    after.chars().count() > before.chars().count() + 1
}

impl CommandPanel {
    pub fn new(cx: &mut gpui::App) -> Self {
        CommandPanel {
            input: cx
                .new(|cx| TextInput::new("Search or enter address", cx).folding_pasted_lines()),
            result: SuggestionResult::default(),
            selected: None,
            new_tab: None,
            placement: CommandBarPlacementState::Field,
            variant: Variant::Panel,
            scope: None,
            offered: None,
            add_menu: None,
            hero_tab: None,
            incognito: false,
            extensions: Vec::new(),
            providers: Vec::new(),
            provider_rows: HashMap::new(),
            remote: Vec::new(),
            remote_sites: Vec::new(),
            remote_for: String::new(),
            typed: String::new(),
            edited: false,
            completion: String::new(),
            scope_from: String::new(),
            initial_text: String::new(),
            split_from: false,
            hero_saved: HashMap::new(),
            index: None,
            actions: Arc::new(Vec::new()),
            open: false,
            shown_rows_key: None,
            waiting_rows: None,
            pointer_over_rows: false,
            freed_rows_key: None,
            counted_held_key: None,
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn is_hero(&self) -> bool {
        self.open && self.variant.hero()
    }

    pub fn typed(&self) -> &str {
        &self.typed
    }

    pub fn shown_completion(&self) -> &str {
        if self.previewing() {
            ""
        } else {
            &self.completion
        }
    }

    pub fn selected_index(&self) -> usize {
        self.selected
            .unwrap_or(0)
            .min(self.result.items.len().saturating_sub(1))
    }

    pub fn previewing(&self) -> bool {
        self.selected_index() > 0 && !self.idle()
    }

    pub fn idle(&self) -> bool {
        self.new_tab.is_some() && self.scope.is_none() && self.typed.trim().is_empty()
    }

    pub fn go_enabled(&self) -> bool {
        !self.variant.hero() || !self.typed.trim().is_empty() || self.previewing()
    }

    pub fn list_shown(&self) -> bool {
        !self.result.items.is_empty()
    }

    fn reset_bar(&mut self) {
        self.typed.clear();
        self.edited = false;
        self.completion.clear();
        self.scope = None;
        self.offered = None;
        self.scope_from.clear();
        self.selected = None;
        self.add_menu = None;
        self.result = SuggestionResult::default();
        self.remote.clear();
        self.provider_rows.clear();
        self.remote_sites.clear();
        self.remote_for.clear();
        self.shown_rows_key = None;
        self.waiting_rows = None;
    }

    pub fn prepare(
        &mut self,
        state: &BrowserState,
        request: PanelRequest<'_>,
        window: &mut Window,
        cx: &mut gpui::App,
    ) {
        let PanelRequest {
            text,
            new_tab,
            placement,
            style,
        } = request;
        let variant = if new_tab.is_some() || placement == CommandBarPlacementState::Centred {
            Variant::Floating
        } else {
            Variant::Panel
        };
        self.start(
            state, variant, text, new_tab, placement, style, true, window, cx,
        );
    }

    pub fn prepare_variant(
        &mut self,
        state: &BrowserState,
        variant: Variant,
        request: PanelRequest<'_>,
        window: &mut Window,
        cx: &mut gpui::App,
    ) {
        let PanelRequest {
            text,
            new_tab,
            placement,
            style,
        } = request;
        self.start(
            state, variant, text, new_tab, placement, style, true, window, cx,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn start(
        &mut self,
        state: &BrowserState,
        variant: Variant,
        text: &str,
        new_tab: Option<NewTabTarget>,
        placement: CommandBarPlacementState,
        style: InputStyle,
        select_all: bool,
        window: &mut Window,
        cx: &mut gpui::App,
    ) {
        if self.is_hero() {
            self.save_hero(cx);
        }
        self.reset_bar();
        self.open = true;
        self.variant = variant;
        self.new_tab = new_tab;
        self.placement = placement;
        self.initial_text = text.to_owned();
        self.typed = text.to_owned();
        self.hero_tab = None;
        self.actions = Arc::new(command_actions(
            state,
            state.focus_order.first().map(|w| w.as_str()),
        ));
        let incognito = self.incognito;
        self.input.update(cx, |input, cx| {
            input.set_style(style, cx);
            input.set_placeholder(placeholder(None, incognito), cx);
            input.set_text(text, select_all, cx);
        });
        crate::primitives::text_input::focus_input(&self.input, window, cx);
    }

    pub fn open_hero(
        &mut self,
        state: &BrowserState,
        tab: &TabId,
        style: InputStyle,
        window: &mut Window,
        cx: &mut gpui::App,
    ) {
        let incognito = self.incognito;
        let saved = self.hero_saved.remove(tab).unwrap_or_default();
        self.reset_bar();
        self.open = true;
        self.variant = Variant::Hero;
        self.new_tab = None;
        self.placement = CommandBarPlacementState::Centred;
        self.initial_text.clear();
        self.typed = saved.clone();
        self.edited = !saved.is_empty();
        self.hero_tab = Some(tab.clone());
        self.actions = Arc::new(command_actions(
            state,
            state.tab(tab.as_str()).map(|t| t.window_id.as_str()),
        ));
        self.input.update(cx, |input, cx| {
            input.set_style(style, cx);
            input.set_placeholder(placeholder(None, incognito), cx);
            input.set_text(saved, false, cx);
        });
        crate::primitives::text_input::focus_input(&self.input, window, cx);
    }

    pub fn focus_hero(&mut self, select_all: bool, window: &mut Window, cx: &mut gpui::App) {
        if select_all {
            self.input.update(cx, |input, cx| input.select_all_text(cx));
        }
        crate::primitives::text_input::focus_input(&self.input, window, cx);
    }

    fn save_hero(&mut self, cx: &gpui::App) {
        if let Some(tab) = self.hero_tab.clone() {
            let text = self.input.read(cx).typed().to_owned();
            if text.is_empty() {
                self.hero_saved.remove(&tab);
            } else {
                self.hero_saved.insert(tab, text);
            }
        }
    }

    pub fn close(&mut self) {
        self.open = false;
        self.reset_bar();
        self.pointer_over_rows = false;
        self.freed_rows_key = None;
        self.hero_tab = None;
    }

    pub fn close_hero(&mut self, cx: &gpui::App) {
        self.save_hero(cx);
        self.close();
    }

    fn profile_of(state: &BrowserState, window: &WindowId) -> ardia_state::ProfileId {
        state
            .window(window.as_str())
            .map(|w| w.profile_id.clone())
            .unwrap_or_else(|| state.last_active_profile())
    }

    fn index(&mut self, state: &BrowserState, window: &WindowId) -> Arc<SuggestionIndex> {
        let profile = Self::profile_of(state, window);
        let key = index_key(
            state.suggestion_history(&profile),
            state.suggestion_bookmarks(&profile),
        );
        if let Some((cached, index)) = &self.index
            && *cached == key
        {
            return Arc::clone(index);
        }
        let index = Arc::new(state.suggestion_index(&profile));
        self.index = Some((key, Arc::clone(&index)));
        index
    }

    fn known_hosts(
        state: &BrowserState,
        window: &WindowId,
        index: &SuggestionIndex,
    ) -> Vec<String> {
        let profile = Self::profile_of(state, window);
        let mut hosts: Vec<String> = state
            .tabs
            .values()
            .filter(|t| t.profile_id == profile && !t.url.is_empty())
            .map(|t| ardia_state::omnibox::url::host_of(&t.url))
            .chain(index.hosts().map(str::to_owned))
            .filter(|h| !h.is_empty())
            .collect();
        hosts.sort_unstable();
        hosts.dedup();
        hosts
    }

    pub fn refresh(
        &mut self,
        state: &BrowserState,
        window: &WindowId,
        deleting: bool,
        now: i64,
        cx: &mut gpui::App,
    ) {
        let _span = ardia_profile::span(ardia_profile::Span::OmniboxQuery);
        let before = self.typed.clone();
        let next = self.input.read(cx).typed().to_owned();
        let index = self.index(state, window);
        let engines = state.search_engines();
        let hosts = Self::known_hosts(state, window, &index);
        let keywords = keyword_providers(&self.providers);
        let sources = ScopeSources {
            engines: &engines,
            hosts: &hosts,
            providers: &keywords,
        };
        if self.scope.is_none()
            && let Some(by_space) = keyword_by_space(&before, &next)
            && let Some(scope) = keyword_scope(&by_space.keyword, &sources)
        {
            self.scope = Some(scope);
            self.scope_from = by_space.from;
            self.typed.clear();
            self.edited = true;
            self.input
                .update(cx, |input, cx| input.set_text("", false, cx));
            self.rebuild(state, window, true, now, &index, cx);
            return;
        }
        self.typed = next;
        self.edited = true;
        self.split_from = state
            .active_tab(window.as_str())
            .is_some_and(|t| !t.url.is_empty());
        let prevent = deleting || inserted_many(&before, &self.typed);
        self.rebuild(state, window, prevent, now, &index, cx);
    }

    fn rebuild(
        &mut self,
        state: &BrowserState,
        window: &WindowId,
        prevent_inline: bool,
        now: i64,
        index: &Arc<SuggestionIndex>,
        cx: &mut gpui::App,
    ) {
        let result = if self.idle() {
            open_tab_start(state, window)
        } else {
            self.suggest(state, window, prevent_inline, now, index)
        };
        let engines = state.search_engines();
        let hosts = Self::known_hosts(state, window, index);
        let keywords = keyword_providers(&self.providers);
        let sources = ScopeSources {
            engines: &engines,
            hosts: &hosts,
            providers: &keywords,
        };
        let completion = if prevent_inline || self.scope.is_some() {
            String::new()
        } else {
            result.completion.clone()
        };
        let offered = if self.scope.is_none() && self.edited {
            offered_site_search(&self.typed, &completion, &sources)
        } else {
            None
        };
        let waiting = WaitingRows {
            key: self.rows_key(),
            result,
            completion,
            offered,
        };
        if self.freed_rows_key.as_deref() != Some(waiting.key.as_str()) {
            self.freed_rows_key = None;
        }
        let holding = self.pointer_over_rows && self.freed_rows_key.is_none();
        if rows_wait(
            holding,
            self.shown_rows_key.as_deref(),
            &self.result.items,
            &waiting.key,
            &waiting.result.items,
        ) {
            if self.counted_held_key.as_deref() != Some(waiting.key.as_str()) {
                self.counted_held_key = Some(waiting.key.clone());
                ardia_telemetry::counts::count("command_bar_rows_held");
            }
            self.waiting_rows = Some(waiting);
            return;
        }
        self.show_rows(waiting, cx);
    }

    fn show_rows(&mut self, rows: WaitingRows, cx: &mut gpui::App) {
        self.waiting_rows = None;
        if !rows.completion.is_empty() {
            ardia_telemetry::counts::count("command_bar_inline_completions");
        }
        if self.scope.is_none()
            && rows.result.items.iter().any(|item| {
                matches!(item, Suggestion::Page { url, tab_id: None, .. }
                    if self.remote_sites.iter().any(|(site, _)| site == url))
            })
        {
            ardia_telemetry::counts::count("command_bar_site_suggestions");
        }
        self.shown_rows_key = Some(rows.key);
        self.completion = rows.completion;
        self.offered = rows.offered;
        self.selected = (!rows.result.items.is_empty()).then_some(0);
        self.result = rows.result;
        self.apply_field(cx);
    }

    fn rows_key(&self) -> String {
        let (kind, name) = self.scope.as_ref().map_or((String::new(), ""), |s| {
            (format!("{:?}", s.kind), s.name.as_str())
        });
        format!("{kind}:{name}:{}", self.typed)
    }

    pub fn rows_held(&self) -> bool {
        self.waiting_rows.is_some()
    }

    pub fn release_rows(&mut self, cx: &mut gpui::App) {
        self.freed_rows_key = self.shown_rows_key.clone();
        if let Some(rows) = self.waiting_rows.take() {
            self.show_rows(rows, cx);
        }
    }

    pub fn rows_hovered(&mut self, over: bool, cx: &mut gpui::App) {
        if self.pointer_over_rows == over {
            return;
        }
        self.pointer_over_rows = over;
        if !over {
            self.freed_rows_key = None;
            if let Some(rows) = self.waiting_rows.take() {
                self.show_rows(rows, cx);
            }
        }
    }

    pub fn page_to(&mut self, index: usize, cx: &mut gpui::App) {
        if self.rows_held() {
            self.release_rows(cx);
            return;
        }
        self.select(index, cx);
    }

    fn suggest(
        &self,
        state: &BrowserState,
        window: &WindowId,
        prevent_inline: bool,
        now: i64,
        index: &SuggestionIndex,
    ) -> SuggestionResult {
        let profile = Self::profile_of(state, window);
        let tabs: Vec<OpenTabRow<'_>> = state
            .tabs
            .values()
            .filter(|tab| tab.profile_id == profile && !tab.live.peek)
            .map(|tab| OpenTabRow {
                id: &tab.id,
                url: &tab.url,
                title: &tab.title,
                custom_title: tab.custom_title.as_deref(),
                favicon: tab.favicon.as_deref(),
            })
            .collect();
        let default_engine = state.default_search_engine();
        let engines = state.search_engines();
        let engine = match &self.scope {
            Some(scope) => scope
                .engine_id
                .as_ref()
                .and_then(|id| engines.iter().find(|e| &e.id == id))
                .cloned()
                .unwrap_or_else(|| default_engine.clone()),
            None => default_engine.clone(),
        };
        let bangs = Bangs::bundled().with_custom(&state.settings.custom_search_engines);
        let active = state.active_tab(window.as_str());
        let current_tab: Option<&TabId> = active.map(|t| &t.id).filter(|_| self.new_tab.is_none());
        let mut options = SuggestOptions::new(&default_engine, now);
        options.limit = SUGGESTION_LIMIT;
        options.actions = &self.actions;
        options.current_tab = current_tab;
        options.current_url = current_tab.and(active.map(|t| t.url.as_str()));
        options.prevent_inline = prevent_inline;
        options.bangs = Some(&bangs);
        options.switch_to_open_tab = true;
        options.scope = self.scope.as_ref();
        let sections = self.provider_sections();
        options.providers = &sections;
        options.extensions = &self.extensions;
        let remote_fresh = self.remote_for == self.remote_key();
        if remote_fresh {
            options.remote = &self.remote;
            if self.scope.is_none() {
                options.remote_sites = &self.remote_sites;
            }
        }
        if self.scope.is_some() {
            options.engine = &engine;
        }
        if self.scope.is_none() && self.typed.trim().is_empty() {
            return SuggestionResult::default();
        }
        build_suggestions(&self.typed, index, &tabs, &options)
    }

    pub fn field_text(&self) -> String {
        match self.preview() {
            Some(text) => text,
            None => format!("{}{}", self.typed, self.completion),
        }
    }

    fn preview(&self) -> Option<String> {
        self.previewing()
            .then(|| labels::preview_text(self.chosen()).unwrap_or_else(|| self.typed.clone()))
    }

    fn apply_field(&mut self, cx: &mut gpui::App) {
        let preview = self.preview();
        let typed = self.typed.clone();
        let completion = self.completion.clone();
        let hint = placeholder(self.scope.as_ref(), self.incognito);
        self.input.update(cx, |input, cx| {
            input.set_placeholder(hint, cx);
            match preview {
                Some(text) => {
                    if input.text() != text {
                        input.set_text(text, false, cx);
                    }
                }
                None => {
                    if input.typed() != typed || input.text() != format!("{typed}{completion}") {
                        input.set_text(typed, false, cx);
                    }
                    input.set_completion(&completion, cx);
                }
            }
        });
    }

    pub fn step(&mut self, delta: i32) {
        let count = self.result.items.len();
        if count == 0 {
            self.selected = None;
            return;
        }
        let next = match self.selected {
            None if delta > 0 => 0,
            None => count - 1,
            Some(at) => (at as i32 + delta).rem_euclid(count as i32) as usize,
        };
        self.selected = Some(next);
    }

    pub fn select(&mut self, index: usize, cx: &mut gpui::App) {
        if self.result.items.is_empty() {
            return;
        }
        self.selected = Some(index.min(self.result.items.len() - 1));
        self.apply_field(cx);
    }

    pub fn move_by(&mut self, delta: i32, cx: &mut gpui::App) {
        if self.rows_held() {
            self.release_rows(cx);
            return;
        }
        self.step(delta);
        self.apply_field(cx);
    }

    pub fn chosen(&self) -> Option<&Suggestion> {
        self.selected.and_then(|at| self.result.items.get(at))
    }

    pub fn tab_key(
        &mut self,
        state: &BrowserState,
        window: &WindowId,
        shift: bool,
        now: i64,
        cx: &mut gpui::App,
    ) {
        if shift {
            self.move_by(-1, cx);
            return;
        }
        let key = site_search_key(
            ScopeKey::Tab,
            KeyModifiers::default(),
            &SiteSearchKeyState {
                typed: &self.typed,
                completion: self.shown_completion(),
                scope: self.scope.as_ref(),
                offered: self.offered.as_ref(),
                scope_from: &self.scope_from,
            },
        );
        match key {
            Some(SiteSearchKey::Enter { scope, from }) => {
                self.enter_scope(state, window, scope, from, now, cx)
            }
            Some(SiteSearchKey::Accept { text }) => {
                self.typed = text;
                self.completion.clear();
                let index = self.index(state, window);
                self.rebuild(state, window, true, now, &index, cx);
            }
            Some(SiteSearchKey::Leave { .. }) | None => self.move_by(1, cx),
        }
    }

    fn enter_scope(
        &mut self,
        state: &BrowserState,
        window: &WindowId,
        scope: SearchScope,
        from: String,
        now: i64,
        cx: &mut gpui::App,
    ) {
        self.scope = Some(scope);
        self.scope_from = from;
        self.typed.clear();
        self.completion.clear();
        self.edited = true;
        self.input
            .update(cx, |input, cx| input.set_text("", false, cx));
        let index = self.index(state, window);
        self.rebuild(state, window, true, now, &index, cx);
    }

    pub fn leave_scope(
        &mut self,
        state: &BrowserState,
        window: &WindowId,
        restore: Option<String>,
        now: i64,
        cx: &mut gpui::App,
    ) {
        self.scope = None;
        if let Some(text) = restore {
            self.typed = text;
            self.edited = true;
        }
        self.completion.clear();
        let typed = self.typed.clone();
        self.input
            .update(cx, |input, cx| input.set_text(typed, false, cx));
        let index = self.index(state, window);
        self.rebuild(state, window, true, now, &index, cx);
    }

    pub fn backspace_out_of_scope(
        &mut self,
        state: &BrowserState,
        window: &WindowId,
        now: i64,
        cx: &mut gpui::App,
    ) {
        let key = site_search_key(
            ScopeKey::Backspace,
            KeyModifiers::default(),
            &SiteSearchKeyState {
                typed: &self.typed,
                completion: "",
                scope: self.scope.as_ref(),
                offered: None,
                scope_from: &self.scope_from,
            },
        );
        if let Some(SiteSearchKey::Leave { text }) = key {
            self.leave_scope(state, window, Some(text), now, cx);
        }
    }

    pub(crate) fn reset_typed(&mut self) {
        self.reset_bar();
    }

    pub fn scope_asks_for_backspace(&self, cx: &gpui::App) -> bool {
        self.scope.is_some() && self.input.read(cx).text().is_empty()
    }

    pub fn escape(
        &mut self,
        state: &BrowserState,
        window: &WindowId,
        now: i64,
        cx: &mut gpui::App,
    ) -> Outcome {
        self.add_menu = None;
        if self.previewing() {
            self.select(0, cx);
            return Outcome::Stay;
        }
        if self.scope.is_some() {
            self.leave_scope(state, window, None, now, cx);
            return Outcome::Stay;
        }
        if !self.variant.hero() {
            return Outcome::Close;
        }
        if !self.completion.is_empty() {
            self.completion.clear();
            self.apply_field(cx);
            return Outcome::Stay;
        }
        self.reset_bar();
        self.input
            .update(cx, |input, cx| input.set_text("", false, cx));
        Outcome::Stay
    }

    fn text_for_go(&self, cx: &gpui::App) -> String {
        if self.previewing() {
            self.field_text()
        } else if self.edited {
            self.input.read(cx).text().to_owned()
        } else if !self.initial_text.is_empty() {
            self.initial_text.clone()
        } else {
            self.input.read(cx).text().to_owned()
        }
    }

    fn go(&self, url: String, asked: Disposition) -> Outcome {
        if url.is_empty() {
            return Outcome::Stay;
        }
        let disposition = if asked == Disposition::Split && !self.split_from {
            if self.new_tab.is_some() {
                Disposition::NewTab
            } else {
                Disposition::Current
            }
        } else {
            asked
        };
        Outcome::Go { url, disposition }
    }

    pub fn choose(
        &mut self,
        index: Option<usize>,
        disposition: Disposition,
        engine: &SearchEngine,
        cx: &mut gpui::App,
    ) -> Outcome {
        self.add_menu = None;
        let chosen = index.and_then(|at| self.result.items.get(at)).cloned();
        let Some(s) = chosen else {
            let text = self.text_for_go(cx);
            if let Some(scope) = &self.scope {
                return self.go(scoped_search_url(scope, &text, engine), disposition);
            }
            return self.go(resolve_input(&text, &engine.url), disposition);
        };
        match s {
            Suggestion::Page {
                tab_id: Some(tab),
                url,
                ..
            } if !(self.new_tab.is_some() && disposition == Disposition::NewTab) => {
                if disposition != Disposition::Current {
                    return self.go(url, disposition);
                }
                Outcome::Switch {
                    tab,
                    url,
                    disposition,
                }
            }
            Suggestion::Calc { value, url, .. } => {
                if disposition != Disposition::Current {
                    return self.go(url, disposition);
                }
                self.typed = value.clone();
                self.completion.clear();
                self.selected = Some(0);
                let shown = value.clone();
                self.input
                    .update(cx, |input, cx| input.set_text(shown, true, cx));
                Outcome::Copy(value)
            }
            Suggestion::Action { id, .. } => Outcome::Command(id),
            Suggestion::Extension { id, open, .. } => Outcome::Extension { id, open },
            Suggestion::Page { url, .. } if is_bookmarklet(&url) => Outcome::Bookmarklet(url),
            other => match other.url() {
                Some(url) => self.go(url.to_owned(), disposition),
                None => Outcome::Stay,
            },
        }
    }

    pub fn submit(
        &mut self,
        disposition: Disposition,
        engine: &SearchEngine,
        cx: &mut gpui::App,
    ) -> Outcome {
        let index = (!self.result.items.is_empty()).then(|| self.selected_index());
        self.choose(index, disposition, engine, cx)
    }

    pub fn enter(
        &mut self,
        meta: bool,
        alt: bool,
        shift: bool,
        ctrl: bool,
        engine: &SearchEngine,
        cx: &mut gpui::App,
    ) -> Outcome {
        let text = if self.previewing() {
            self.field_text()
        } else {
            self.typed.clone()
        };
        if meta && shift {
            return match force_search_url(self.scope.as_ref(), &text, engine) {
                Some(url) => self.go(url, Disposition::Current),
                None => Outcome::Stay,
            };
        }
        if ctrl && let Some(url) = www_guess(&text) {
            let disposition = if shift {
                Disposition::NewWindow
            } else {
                Disposition::Current
            };
            return self.go(url, disposition);
        }
        self.submit(Disposition::of(meta, alt, shift), engine, cx)
    }

    pub fn remove_selected(&self) -> Outcome {
        match labels::removable_url(self.chosen()) {
            Some(url) => Outcome::Remove(url.to_owned()),
            None => Outcome::Stay,
        }
    }

    pub fn remove_at(&self, index: usize) -> Outcome {
        match labels::removable_url(self.result.items.get(index)) {
            Some(url) => Outcome::Remove(url.to_owned()),
            None => Outcome::Stay,
        }
    }

    pub fn after_removal(
        &mut self,
        state: &BrowserState,
        window: &WindowId,
        now: i64,
        cx: &mut gpui::App,
    ) {
        self.release_rows(cx);
        let keep = self.selected;
        self.index = None;
        let index = self.index(state, window);
        self.rebuild(state, window, true, now, &index, cx);
        if let Some(at) = keep {
            self.select(at, cx);
        }
    }

    fn provider_targets(&self) -> Vec<&ActiveProvider> {
        let query = self.typed.trim();
        if let Some(scope) = &self.scope {
            return match &scope.provider_id {
                Some(id) => self.providers.iter().filter(|p| &p.id == id).collect(),
                None => Vec::new(),
            };
        }
        if query.is_empty() || query.starts_with('?') || Bangs::bundled().find(query).is_some() {
            return Vec::new();
        }
        self.providers
            .iter()
            .filter(|p| p.keyword.is_none() || p.global)
            .collect()
    }

    fn provider_sections(&self) -> Vec<ProviderSection> {
        let query = self.typed.trim();
        self.provider_targets()
            .into_iter()
            .map(|p| {
                let mut rows = match &p.source {
                    ProviderSource::Config { config, .. }
                        if !(config.global && query.is_empty()) =>
                    {
                        match_provider_rows(&config.rows, &self.typed)
                    }
                    _ => Vec::new(),
                };
                if let Some((asked, extra)) = self.provider_rows.get(&p.id)
                    && asked == query
                {
                    rows.extend(extra.iter().cloned());
                }
                ProviderSection {
                    id: p.id.clone(),
                    title: p.title.clone(),
                    rows,
                }
            })
            .collect()
    }

    pub fn provider_requests(&self) -> Vec<(String, String, ProviderQuery)> {
        let query = self.typed.trim();
        if query.is_empty() || query.chars().count() > PROVIDER_MAX_QUERY {
            return Vec::new();
        }
        self.provider_targets()
            .into_iter()
            .filter_map(|p| match &p.source {
                ProviderSource::Plugin => {
                    Some((p.id.clone(), query.to_owned(), ProviderQuery::Plugin))
                }
                ProviderSource::Config {
                    config,
                    remote: true,
                } => {
                    if config.global && looks_like_address(query) {
                        return None;
                    }
                    let url = fill_provider_template(config.suggest.as_deref()?, query)?;
                    remote_request_allowed(&url).then(|| {
                        (
                            p.id.clone(),
                            query.to_owned(),
                            ProviderQuery::Remote {
                                url,
                                template: config.url.clone(),
                            },
                        )
                    })
                }
                ProviderSource::Config { .. } => None,
            })
            .collect()
    }

    pub fn take_provider_rows(
        &mut self,
        answer: ProviderAnswer,
        state: &BrowserState,
        window: &WindowId,
        now: i64,
        cx: &mut gpui::App,
    ) {
        let ProviderAnswer { id, query, rows } = answer;
        let (id, query) = (id.as_str(), query.as_str());
        if !self.open || self.typed.trim() != query {
            return;
        }
        let rows: Vec<ProviderRow> = rows.into_iter().take(ROWS_PER_PROVIDER).collect();
        self.provider_rows
            .insert(id.to_owned(), (query.to_owned(), rows));
        let held = held_key(&self.result.items, self.selected_index());
        let index = self.index(state, window);
        let prevent = self.completion.is_empty();
        self.rebuild(state, window, prevent, now, &index, cx);
        let at = held_index(&self.result.items, held.as_deref());
        if at > 0 {
            self.select(at, cx);
        }
    }

    fn remote_key(&self) -> String {
        let scope = self
            .scope
            .as_ref()
            .map_or(String::new(), |s| format!("{}:{}", s.name, s.host));
        format!("{scope}\n{}", self.typed.trim())
    }

    pub fn remote_request(
        &self,
        state: &BrowserState,
        window: &WindowId,
    ) -> Option<(ardia_state::ProfileId, String, String)> {
        let query = self.typed.trim();
        let profile = Self::profile_of(state, window);
        let bangs = Bangs::bundled().with_custom(&state.settings.custom_search_engines);
        let allowed = state.settings.search_suggestions
            && !profile.is_incognito()
            && !query.is_empty()
            && !self.idle()
            && bangs.find(query).is_none()
            && !ardia_state::omnibox::url::has_known_scheme(query)
            && !matches!(
                self.scope.as_ref().map(|s| s.kind),
                Some(ardia_state::omnibox::site_search::ScopeKind::History)
            );
        if !allowed {
            return None;
        }
        let engines = state.search_engines();
        let engine = self
            .scope
            .as_ref()
            .and_then(|s| s.engine_id.as_ref())
            .and_then(|id| engines.iter().find(|e| &e.id == id).cloned())
            .unwrap_or_else(|| state.default_search_engine());
        let url = engine.suggest_request(query)?;
        Some((profile, url, self.remote_key()))
    }

    pub fn take_remote(
        &mut self,
        key: &str,
        body: &str,
        state: &BrowserState,
        window: &WindowId,
        now: i64,
        cx: &mut gpui::App,
    ) {
        if !self.open || key != self.remote_key() {
            return;
        }
        let parsed = ardia_state::omnibox::engines::parse_remote_suggestions(body);
        self.remote = parsed.queries;
        self.remote_sites = parsed.sites;
        self.remote_for = key.to_owned();
        let held = held_key(&self.result.items, self.selected_index());
        let index = self.index(state, window);
        let prevent = self.completion.is_empty();
        self.rebuild(state, window, prevent, now, &index, cx);
        let at = held_index(&self.result.items, held.as_deref());
        if at > 0 {
            self.select(at, cx);
        }
    }

    pub fn tab_scope_hint(&self) -> Option<String> {
        if self.previewing() {
            return None;
        }
        self.offered
            .as_ref()
            .map(|scope| format!("Search {}  ⇥", scope.name))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderSource {
    Config {
        config: ProviderConfig,
        remote: bool,
    },
    Plugin,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ActiveProvider {
    pub id: String,
    pub title: String,
    pub keyword: Option<String>,
    pub template: Option<String>,
    pub global: bool,
    pub source: ProviderSource,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderAnswer {
    pub id: String,
    pub query: String,
    pub rows: Vec<ProviderRow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderQuery {
    Remote {
        url: String,
        template: Option<String>,
    },
    Plugin,
}

pub fn active_providers(
    state: &BrowserState,
    window: &WindowId,
    plugins: &[PluginProvider],
    approved: &dyn Fn(&str) -> bool,
) -> Vec<ActiveProvider> {
    let private = state.window(window.as_str()).is_some_and(|w| {
        w.kind == ardia_state::windows::WindowKind::Incognito || w.profile_id.is_incognito()
    });
    let mut out = Vec::new();
    for config in provider_configs(&state.settings.omnibox_providers) {
        let ok = !config.needs_approval() || approved(&config.approval_key);
        if config.global && !ok {
            continue;
        }
        let remote = config.suggest.is_some() && ok && !private;
        if config.global && config.suggest.is_some() && !remote && config.rows.is_empty() {
            continue;
        }
        out.push(ActiveProvider {
            id: config.id.clone(),
            title: config.title.clone(),
            keyword: config.keyword.clone(),
            template: config.url.clone(),
            global: config.global,
            source: ProviderSource::Config { config, remote },
        });
    }
    if private {
        return out;
    }
    let keywords: Vec<String> = out.iter().filter_map(|p| p.keyword.clone()).collect();
    let ids: Vec<String> = out.iter().map(|p| p.id.clone()).collect();
    for plugin in plugins {
        let clash = plugin
            .keyword
            .as_ref()
            .is_some_and(|k| keywords.contains(&k.to_lowercase()));
        if ids.contains(&plugin.id) || clash {
            continue;
        }
        out.push(ActiveProvider {
            id: plugin.id.clone(),
            title: plugin.title.clone(),
            keyword: plugin.keyword.as_ref().map(|k| k.to_lowercase()),
            template: None,
            global: plugin.global,
            source: ProviderSource::Plugin,
        });
    }
    out
}

pub fn keyword_providers(providers: &[ActiveProvider]) -> Vec<KeywordProvider> {
    providers
        .iter()
        .filter_map(|p| {
            let keyword = p.keyword.clone()?;
            let template = p.template.as_deref();
            Some(KeywordProvider {
                id: p.id.clone(),
                title: p.title.clone(),
                keyword,
                host: template.map_or(String::new(), |t| {
                    ardia_state::omnibox::url::host_of(&t.replace(QUERY_SLOT, "q"))
                }),
                url: template.map_or(String::new(), |t| t.replace(QUERY_SLOT, "%s")),
            })
        })
        .collect()
}

fn looks_like_address(text: &str) -> bool {
    ardia_state::omnibox::url::fixup_url(text).is_some()
        || text.split_once(':').is_some_and(|(scheme, _)| {
            scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        })
}

pub fn extension_candidates(list: &crate::host_data::ExtensionList) -> Vec<ExtensionCandidate> {
    list.items
        .iter()
        .filter(|x| x.enabled)
        .map(|x| ExtensionCandidate {
            id: x.id.clone(),
            title: x.name.clone(),
            icon: None,
            action: x.has_action,
            options: x.options_url.is_some(),
        })
        .filter(|x| x.action || x.options)
        .collect()
}

pub fn held_key(items: &[Suggestion], selected: usize) -> Option<String> {
    (selected > 0)
        .then(|| items.get(selected))
        .flatten()
        .map(Suggestion::key)
}

pub fn held_index(items: &[Suggestion], held: Option<&str>) -> usize {
    held.and_then(|key| items.iter().position(|s| s.key() == key))
        .unwrap_or(0)
}

pub fn is_bookmarklet(url: &str) -> bool {
    url.trim_start()
        .get(..11)
        .is_some_and(|head| head.eq_ignore_ascii_case("javascript:"))
}

pub fn open_tab_start(state: &BrowserState, window: &WindowId) -> SuggestionResult {
    let Some(shown) = state.window(window.as_str()) else {
        return SuggestionResult::default();
    };
    let active = shown.active_tab_ids.get(&shown.profile_id).cloned();
    let start = StartRows::of(&state.settings.command_bar_start);
    let mut tabs: Vec<_> =
        ardia_state::tab_share::open_tabs_by_use(state, &shown.profile_id, &shown.id)
            .into_iter()
            .filter(|(t, _)| start.keeps(t.pin.as_ref()))
            .filter(|(t, _)| !t.url.is_empty() && Some(&t.id) != active.as_ref())
            .collect();
    tabs.sort_by_key(|(_, used)| std::cmp::Reverse(*used));
    SuggestionResult {
        items: tabs
            .into_iter()
            .take(start.limit)
            .map(|(t, _)| Suggestion::Page {
                url: t.url.clone(),
                title: t
                    .custom_title
                    .clone()
                    .filter(|c| !c.is_empty())
                    .unwrap_or_else(|| t.title.clone()),
                favicon: t.favicon.clone(),
                tab_id: Some(t.id.clone()),
                bookmarked: false,
                visited: false,
            })
            .collect(),
        completion: String::new(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartRows {
    pub hide_pinned: bool,
    pub hide_top_apps: bool,
    pub limit: usize,
}

impl StartRows {
    pub fn of(setting: &serde_json::Value) -> Self {
        let tabs = setting.get("openTabs");
        let flag = |key: &str| {
            tabs.and_then(|t| t.get(key))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        };
        StartRows {
            hide_pinned: flag("hidePinned"),
            hide_top_apps: flag("hideTopApps"),
            limit: tabs
                .and_then(|t| t.get("limit"))
                .and_then(serde_json::Value::as_u64)
                .map_or(OPEN_TAB_START_LIMIT, |n| n as usize),
        }
    }

    pub fn keeps(&self, pin: Option<&ardia_state::model::TabPin>) -> bool {
        match pin {
            None => true,
            Some(ardia_state::model::TabPin::Row) => !self.hide_pinned,
            Some(_) => !self.hide_top_apps,
        }
    }
}

pub fn other_open_tabs(state: &BrowserState, window: &WindowId) -> Vec<(TabId, String)> {
    let active = state.active_tab(window.as_str()).map(|t| t.id.clone());
    crate::sidebar::model::sections(state, window.as_str())
        .ordered_tabs()
        .iter()
        .filter_map(|id| state.tab(id.as_str()))
        .filter(|t| !t.url.is_empty() && Some(&t.id) != active.as_ref())
        .take(ADD_CHIP_OTHER_TABS)
        .map(|t| {
            let title = if t.title.is_empty() {
                ardia_state::omnibox::url::display_url(&t.url)
            } else {
                t.title.clone()
            };
            (t.id.clone(), title)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::omnibox::built_in_engines;
    use ardia_state::persistence::session::{LoadOptions, SessionData};

    fn start_world() -> (BrowserState, ardia_state::IdGen, WindowId, WindowId) {
        use ardia_state::actions::Action;
        let ids = ardia_state::IdGen::with_launch("start");
        let mut s = BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 1_000);
        let mut now = 1_000;
        let mut act = |s: &mut BrowserState, action: Action| {
            now += 1_000;
            s.apply(action, now, &ids).unwrap()
        };
        let open = |s: &mut BrowserState,
                    act: &mut dyn FnMut(
            &mut BrowserState,
            Action,
        ) -> ardia_state::actions::Outcome| {
            act(
                s,
                Action::OpenWindow {
                    kind: ardia_state::windows::WindowKind::Main,
                    profile: None,
                    url: None,
                    frame: None,
                },
            )
            .window
            .unwrap()
        };
        let a = open(&mut s, &mut act);
        let b = open(&mut s, &mut act);
        for (window, url, pin) in [
            (&a, "row.com", Some(ardia_state::model::TabPin::Row)),
            (&a, "tile.com", Some(ardia_state::model::TabPin::TILE)),
            (&a, "one.com", None),
            (&b, "two.com", None),
        ] {
            let tab = act(
                &mut s,
                Action::NewTab {
                    window: window.clone(),
                    tab: ardia_state::actions::NewTab {
                        url: Some(url.into()),
                        ..Default::default()
                    },
                },
            )
            .tab
            .unwrap();
            if pin.is_some() {
                act(&mut s, Action::SetPin { tab, pin });
            }
        }
        (s, ids, a, b)
    }

    fn start_urls(s: &BrowserState, window: &WindowId) -> Vec<String> {
        open_tab_start(s, window)
            .items
            .iter()
            .filter_map(|i| match i {
                Suggestion::Page { url, .. } => Some(url.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn start_rows_list_open_tabs_from_every_window_and_follow_command_bar_start() {
        let (mut s, ids, a, b) = start_world();
        let all = start_urls(&s, &b);
        assert_eq!(
            all.len(),
            5,
            "pin copies in each window keep their own rows: {all:?}"
        );
        assert!(all.contains(&"https://one.com".to_owned()));
        assert!(all.contains(&"https://row.com".to_owned()));
        assert!(all.contains(&"https://tile.com".to_owned()));
        let set = |s: &mut BrowserState, value: serde_json::Value| {
            s.apply(
                ardia_state::actions::Action::UpdateSettings {
                    patch: ardia_state::settings::SettingsPatch::new()
                        .set("commandBarStart", value),
                    from_sync: false,
                },
                99_000,
                &ids,
            )
            .unwrap();
        };
        set(
            &mut s,
            serde_json::json!({"openTabs": {"hidePinned": true}}),
        );
        assert!(!start_urls(&s, &b).contains(&"https://row.com".to_owned()));
        assert!(start_urls(&s, &b).contains(&"https://tile.com".to_owned()));
        set(
            &mut s,
            serde_json::json!({"openTabs": {"hideTopApps": true}}),
        );
        assert!(start_urls(&s, &b).contains(&"https://row.com".to_owned()));
        assert!(!start_urls(&s, &b).contains(&"https://tile.com".to_owned()));
        set(&mut s, serde_json::json!({"openTabs": {"limit": 1}}));
        assert_eq!(start_urls(&s, &b).len(), 1);
        set(&mut s, serde_json::json!({"openTabs": {"limit": 0}}));
        assert!(start_urls(&s, &b).is_empty());
        set(&mut s, serde_json::json!({}));
        assert!(
            !start_urls(&s, &a).contains(&"https://one.com".to_owned()),
            "the shown tab is left out"
        );
    }

    #[test]
    fn shared_tabs_start_rows_list_each_tab_once() {
        let (mut s, ids, _, b) = start_world();
        s.apply(
            ardia_state::actions::Action::UpdateSettings {
                patch: ardia_state::settings::SettingsPatch::new()
                    .set("shareTabsAcrossWindows", true),
                from_sync: false,
            },
            99_000,
            &ids,
        )
        .unwrap();
        let urls = start_urls(&s, &b);
        let once = |url: &str| urls.iter().filter(|u| *u == url).count() == 1;
        assert!(once("https://one.com"), "{urls:?}");
        assert!(!urls.contains(&"https://two.com".to_owned()), "{urls:?}");
    }

    #[test]
    fn the_command_bar_offers_commands_with_their_shortcuts() {
        let state = BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 0);
        let actions = command_actions(&state, None);
        let new_tab = actions.iter().find(|a| a.id == "newTab").expect("new tab");
        assert_eq!(new_tab.title, "New Tab");
        assert!(new_tab.hint.is_some());
        assert!(actions.iter().any(|a| a.id == "setAppearance:dark"));
        assert!(actions.iter().all(|a| !a.id.starts_with("std:")));
        assert!(!actions.iter().any(|a| a.id == "selectTab"));
    }

    #[test]
    fn enter_modifiers_pick_the_old_dispositions() {
        assert_eq!(Disposition::of(false, true, false), Disposition::Split);
        assert_eq!(Disposition::of(true, false, false), Disposition::NewTab);
        assert_eq!(Disposition::of(false, false, true), Disposition::NewWindow);
        assert_eq!(Disposition::of(true, true, true), Disposition::Split);
        assert_eq!(Disposition::of(false, false, false), Disposition::Current);
    }

    #[test]
    fn placeholders_and_keyboard_shortcuts_match_the_old_bar() {
        assert_eq!(placeholder(None, false), "Search or enter address");
        assert_eq!(placeholder(None, true), "Search privately or enter address");
        assert_eq!(www_guess("apple").as_deref(), Some("https://www.apple.com"));
        assert_eq!(www_guess("apple.com"), None);
        assert_eq!(www_guess("big apple"), None);
        let engines = built_in_engines();
        assert!(force_search_url(None, " cats ", &engines[0]).is_some_and(|u| u.contains("cats")));
        assert_eq!(force_search_url(None, "  ", &engines[0]), None);
    }

    #[test]
    fn global_plugin_providers_are_kept_with_their_flag() {
        let state = BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 0);
        let plugins = vec![
            PluginProvider {
                id: "p:global".into(),
                title: "Global".into(),
                keyword: Some("glo".into()),
                global: true,
            },
            PluginProvider {
                id: "p:keyword".into(),
                title: "Keyword".into(),
                keyword: Some("kw".into()),
                global: false,
            },
        ];
        let active = active_providers(&state, &WindowId::new("w"), &plugins, &|_| false);
        let global = active.iter().find(|p| p.id == "p:global").expect("global");
        assert!(global.global);
        let keyword = active
            .iter()
            .find(|p| p.id == "p:keyword")
            .expect("keyword");
        assert!(!keyword.global && keyword.keyword.as_deref() == Some("kw"));
    }

    #[test]
    fn late_rows_keep_an_arrowed_row_but_never_move_off_the_first() {
        let search = |q: &str| Suggestion::Search {
            query: q.into(),
            url: format!("https://s.example/?q={q}"),
            engine: "S".into(),
            suggested: false,
            bang: false,
        };
        let items = vec![search("a"), search("b"), search("c")];
        assert_eq!(held_key(&items, 0), None);
        let key = held_key(&items, 2);
        let moved = vec![search("a"), search("x"), search("b"), search("c")];
        assert_eq!(held_index(&moved, key.as_deref()), 3);
        assert_eq!(held_index(&moved, None), 0);
    }

    fn row(url: &str) -> Suggestion {
        Suggestion::Search {
            query: url.into(),
            url: url.into(),
            engine: "S".into(),
            suggested: false,
            bang: false,
        }
    }

    #[test]
    fn rows_under_the_pointer_wait_like_the_old_steady_rows() {
        let (page, search, late, history) = (row("p"), row("s"), row("l"), row("h"));
        let shown = vec![page.clone(), search.clone()];
        let key = Some("example.com");
        assert!(rows_wait(
            true,
            key,
            &shown,
            "example.com",
            &[page.clone(), search.clone(), late.clone()]
        ));
        let three = vec![page.clone(), search.clone(), history];
        assert!(rows_wait(
            true,
            key,
            &three,
            "example.com",
            &[page.clone(), search, late.clone()]
        ));
        assert!(!rows_wait(true, key, &shown, "example.com", &shown));
        assert!(!rows_wait(
            false,
            key,
            &shown,
            "example.com",
            &[page.clone(), late.clone()]
        ));
        assert!(!rows_wait(
            true,
            Some("example.co"),
            &shown,
            "example.com",
            std::slice::from_ref(&late)
        ));
        assert!(!rows_wait(true, Some("e"), &[], "e", &[page]));
    }

    #[test]
    fn pasting_several_characters_suppresses_inline_completion() {
        assert!(inserted_many("", "git"));
        assert!(!inserted_many("gi", "git"));
        assert!(!inserted_many("git", "gi"));
    }
}
