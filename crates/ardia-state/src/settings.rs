use crate::ids::DEFAULT_PROFILE_ID;
use crate::json::Fields;
use crate::macros::string_enum;
use crate::model::{PageEngine, SidebarSide, TabLayout};
use crate::omnibox::engines::{CustomSearchEngine, ExtensionSearchEngine, custom_engines_from};
use ardia_theme::SidebarTextSize;
use ardia_theme::layout::{
    DEFAULT_SIDEBAR_WIDTH, FrameRules, PAGE_FRAME_DEFAULT, PAGE_FRAME_MAX, PAGE_FRAME_MIN,
};
use indexmap::IndexMap;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

string_enum!(NewTabPosition { Top = "top", Bottom = "bottom", NextToCurrent = "nextToCurrent" } default Bottom);
string_enum!(Placement { Top = "top", Bottom = "bottom" } default Bottom);
string_enum!(NewTabOpens { Page = "page", CommandBar = "commandBar" } default Page);
string_enum!(AfterClosingTab { PreviouslyActive = "previouslyActive", TabAbove = "tabAbove", TabBelow = "tabBelow" } default PreviouslyActive);
string_enum!(TabSwitcherOrder { Recent = "recent", InOrder = "inOrder" } default Recent);
string_enum!(TabSwitcherView { Thumbnails = "thumbnails", CompactList = "compactList", None = "none" } default Thumbnails);
string_enum!(PeekModifier { Alt = "alt", Shift = "shift", Off = "off" } default Shift);
string_enum!(NewTabLinksOpenIn { Tab = "tab", Peek = "peek", LittleArdia = "littleArdia" } default Peek);
string_enum!(PeekButtons { Top = "top", Left = "left", Right = "right" } default Top);
string_enum!(SplitLinkModifier { AltShift = "altShift", Alt = "alt" } default AltShift);
string_enum!(SelectedTabGlowSetting { Full = "full", Soft = "soft", Off = "off" } default Full);
string_enum!(SidebarTextContrast { Auto = "auto", Standard = "standard", High = "high" } default Auto);
string_enum!(SelectedTopApp { Ring = "ring", Fill = "fill", Outline = "outline" } default Ring);
string_enum!(InterfaceStyle { Glass = "glass", Classic = "classic" } default Glass);
string_enum!(WindowButtons { Native = "native", TrafficLights = "trafficLights", Hidden = "hidden" } default Native);
string_enum!(BatterySaverWhen { LowBattery = "lowBattery", Unplugged = "unplugged", Never = "never" } default LowBattery);
string_enum!(UnloadProfilesAfter { Never = "never", FiveMinutes = "5m", FifteenMinutes = "15m", OneHour = "1h", TwoHours = "2h" } default Never);
string_enum!(MemorySaverMode { Moderate = "moderate", Balanced = "balanced", Maximum = "maximum" } default Balanced);
string_enum!(BookmarksBar { Always = "always", NewTab = "newTab", Never = "never" } default Never);
string_enum!(Appearance { Auto = "auto", Light = "light", Dark = "dark" } default Auto);
string_enum!(AddressBar { Toolbar = "toolbar", Sidebar = "sidebar" } default Toolbar);
string_enum!(AddressBarButtons { Hover = "hover", Always = "always" } default Hover);
string_enum!(MinimalismPinnedIcons { Letters = "letters", Logos = "logos" } default Letters);
string_enum!(CommandBarPlacement { Field = "field", Centred = "centred", CentredOnClick = "centredOnClick" } default Field);
string_enum!(PressMotion { Still = "still", Bounce = "bounce" } default Still);
string_enum!(FolderStyle { Profile = "profile", Neutral = "neutral" } default Profile);
string_enum!(LiveFolderIcon { Folder = "folder", Service = "service" } default Folder);
string_enum!(EngineMode { Automatic = "automatic", Chromium = "chromium", Webkit = "webkit" } default Automatic);
string_enum!(ReaderTextSize { Small = "small", Medium = "medium", Large = "large", Larger = "larger", Largest = "largest" } default Medium);
string_enum!(ReaderFont { Serif = "serif", Sans = "sans" } default Serif);

impl SelectedTabGlowSetting {
    pub const fn glow(self) -> ardia_theme::SelectedTabGlow {
        match self {
            SelectedTabGlowSetting::Full => ardia_theme::SelectedTabGlow::Full,
            SelectedTabGlowSetting::Soft => ardia_theme::SelectedTabGlow::Soft,
            SelectedTabGlowSetting::Off => ardia_theme::SelectedTabGlow::Off,
        }
    }
}

impl UnloadProfilesAfter {
    pub const fn minutes(self) -> Option<u32> {
        match self {
            UnloadProfilesAfter::Never => None,
            UnloadProfilesAfter::FiveMinutes => Some(5),
            UnloadProfilesAfter::FifteenMinutes => Some(15),
            UnloadProfilesAfter::OneHour => Some(60),
            UnloadProfilesAfter::TwoHours => Some(120),
        }
    }
}

pub const INTERFACE_SCALE_MIN: f64 = 0.8;
pub const INTERFACE_SCALE_MAX: f64 = 1.5;
pub const INTERFACE_SCALE_STEP: f64 = 0.05;
pub const TAB_CORNERS_MAX: f64 = 20.0;
pub const MAX_LAUNCH_ACTIONS: usize = 20;
pub const COMMAND_BAR_START_MAX_TABS: u64 = 50;

const LOCAL_ONLY_KEYS: [&str; 17] = [
    "cliControl",
    "allowJavaScriptFromAppleEvents",
    "extensionSearchEngines",
    "defaultProfileId",
    "customSearchUrl",
    "newTabUrl",
    "customSearchEngines",
    "engineMode",
    "pageEngine",
    "websiteEngines",
    "protectedVideoInWebKit",
    "offerWebKitForProtectedVideo",
    "engineSwitchKeepsPage",
    "engineSwitchAsksAboutUnsavedWork",
    "engineSwitchCarriesSiteData",
    "showCliPill",
    "webKitFraudWarnings",
];

const fn same_text(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

const fn in_config_file(key: &str) -> bool {
    let mut i = 0;
    while i < LOCAL_ONLY_KEYS.len() {
        if same_text(LOCAL_ONLY_KEYS[i], key) {
            return false;
        }
        i += 1;
    }
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettingInfo {
    pub key: &'static str,
    pub synced: bool,
    pub config_file: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SettingError {
    #[error("there is no setting called {0}")]
    Unknown(String),
    #[error("{0} doesn't take that value")]
    Invalid(String),
}

fn any<T>(_: &T) -> bool {
    true
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "settings validators share the fn(&T) -> bool shape of the settings table"
)]
fn positive(v: &f64) -> bool {
    v.is_finite() && *v > 0.0
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "settings validators share the fn(&T) -> bool shape of the settings table"
)]
fn fraction(v: &f64) -> bool {
    (0.0..=1.0).contains(v)
}

pub fn valid_interface_scale(v: &f64) -> bool {
    if !v.is_finite() {
        return false;
    }
    let percent = (v * 100.0).round();
    (v * 100.0 - percent).abs() < 1e-6 && (80.0..=150.0).contains(&percent) && percent % 5.0 == 0.0
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "settings validators share the fn(&T) -> bool shape of the settings table"
)]
fn page_frame(v: &f64) -> bool {
    v.fract() == 0.0 && (f64::from(PAGE_FRAME_MIN)..=f64::from(PAGE_FRAME_MAX)).contains(v)
}

fn tab_corners(v: &Option<f64>) -> bool {
    v.is_none_or(|v| v.fract() == 0.0 && (0.0..=TAB_CORNERS_MAX).contains(&v))
}

fn clean_up(v: &Option<f64>) -> bool {
    v.is_none_or(|m| m.is_finite() && m > 0.0)
}

fn launch_actions(v: &[String]) -> bool {
    v.len() <= MAX_LAUNCH_ACTIONS
}

fn little_size(v: &[f64; 2]) -> bool {
    v.iter().all(positive)
}

fn providers(v: &Value) -> bool {
    v.as_array()
        .is_some_and(|list| list.iter().all(Value::is_object))
}

fn command_bar_start(v: &Value) -> bool {
    let Some(fields) = v.as_object() else {
        return false;
    };
    fields.iter().all(|(key, value)| {
        key == "openTabs"
            && value.as_object().is_some_and(|tabs| {
                tabs.iter().all(|(k, v)| match k.as_str() {
                    "hidePinned" | "hideTopApps" => v.is_boolean(),
                    "limit" => v.as_u64().is_some_and(|n| n <= COMMAND_BAR_START_MAX_TABS),
                    _ => false,
                })
            })
    })
}

fn empty_object() -> Value {
    Value::Object(Fields::new())
}

fn empty_array() -> Value {
    Value::Array(Vec::new())
}

fn normalize_numbers(value: Value) -> Value {
    match value {
        Value::Number(n) => n
            .as_f64()
            .filter(|f| n.is_f64() && crate::json::is_integral(*f))
            .map_or(Value::Number(n), crate::json::js_number),
        Value::Array(list) => Value::Array(list.into_iter().map(normalize_numbers).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(k, v)| (k, normalize_numbers(v)))
                .collect(),
        ),
        other => other,
    }
}

pub fn to_json<T: Serialize>(value: &T) -> Value {
    normalize_numbers(serde_json::to_value(value).unwrap_or(Value::Null))
}

fn parse_value<T: DeserializeOwned>(value: &Value, valid: fn(&T) -> bool) -> Option<T> {
    T::deserialize(value).ok().filter(valid)
}

pub const RETIRED_SETTING_KEYS: [&str; 6] = [
    "hideBookmarksBarImport",
    "profileSwitcherIcons",
    "batterySaver",
    "cleanUpInactiveTabsAfterHours",
    "chosen",
    "inferred",
];

macro_rules! settings {
    ($($field:ident : $key:literal => $ty:ty = $default:expr, $valid:expr, $synced:expr;)+) => {
        #[derive(Clone, Debug, PartialEq)]
        pub struct Settings {
            $(pub $field: $ty,)+
            pub extra: Fields,
        }

        impl Default for Settings {
            fn default() -> Self {
                Settings { $($field: $default,)+ extra: Fields::new() }
            }
        }

        pub const SETTINGS: &[SettingInfo] = &[$(SettingInfo { key: $key, synced: $synced, config_file: in_config_file($key) },)+];

        impl Settings {
            fn assign(&mut self, key: &str, value: &Value) -> Result<(), SettingError> {
                match key {
                    $($key => {
                        let parsed: $ty = parse_value(value, $valid).ok_or_else(|| SettingError::Invalid(key.to_owned()))?;
                        self.$field = parsed;
                        Ok(())
                    })+
                    _ => Err(SettingError::Unknown(key.to_owned())),
                }
            }

            pub fn get(&self, key: &str) -> Option<Value> {
                match key {
                    $($key => Some(to_json(&self.$field)),)+
                    _ => self.extra.get(key).cloned(),
                }
            }

            pub fn to_fields(&self) -> Fields {
                let mut out = Fields::new();
                $(out.insert($key.to_owned(), to_json(&self.$field));)+
                for (key, value) in &self.extra {
                    out.entry(key.clone()).or_insert_with(|| value.clone());
                }
                out
            }
        }
    };
}

settings! {
    warn_before_quitting: "warnBeforeQuitting" => bool = false, any, true;
    warn_before_closing_window: "warnBeforeClosingWindow" => bool = true, any, true;
    restore_session: "restoreSession" => bool = true, any, false;
    separate_download_folders: "separateDownloadFolders" => bool = false, any, false;
    search_engine: "searchEngine" => String = "google".to_owned(), any, true;
    custom_search_url: "customSearchUrl" => String = String::new(), any, true;
    custom_search_engines: "customSearchEngines" => Vec<CustomSearchEngine> = Vec::new(), any, true;
    extension_search_engines: "extensionSearchEngines" => Vec<ExtensionSearchEngine> = Vec::new(), any, false;
    search_suggestions: "searchSuggestions" => bool = true, any, true;
    command_bar_history: "commandBarHistory" => bool = true, any, true;
    show_selection_search: "showSelectionSearch" => bool = true, any, true;
    tab_layout: "tabLayout" => TabLayout = TabLayout::Sidebar, any, true;
    sidebar_side: "sidebarSide" => SidebarSide = SidebarSide::Left, any, true;
    auto_hide_tabs: "autoHideTabs" => bool = false, any, true;
    hide_toolbar_while_scrolling: "hideToolbarWhileScrolling" => bool = false, any, true;
    new_tab_position: "newTabPosition" => NewTabPosition = NewTabPosition::Bottom, any, true;
    new_tab_button_position: "newTabButtonPosition" => Placement = Placement::Bottom, any, true;
    show_tab_menu_button: "showTabMenuButton" => bool = true, any, true;
    app_links_first: "appLinksFirst" => bool = false, any, true;
    new_tab_opens: "newTabOpens" => NewTabOpens = NewTabOpens::Page, any, true;
    new_tab_url: "newTabUrl" => String = String::new(), any, true;
    warn_before_closing_last_tab: "warnBeforeClosingLastTab" => bool = true, any, true;
    after_closing_tab: "afterClosingTab" => AfterClosingTab = AfterClosingTab::PreviouslyActive, any, true;
    tab_switcher_order: "tabSwitcherOrder" => TabSwitcherOrder = TabSwitcherOrder::Recent, any, true;
    tab_switcher_view: "tabSwitcherView" => TabSwitcherView = TabSwitcherView::Thumbnails, any, true;
    keep_top_apps_running: "keepTopAppsRunning" => bool = false, any, true;
    tab_reorder_haptics: "tabReorderHaptics" => bool = true, any, true;
    swipe_between_tabs: "swipeBetweenTabs" => bool = true, any, true;
    undo_reopens_closed_tab: "undoReopensClosedTab" => bool = false, any, true;
    warn_before_moving_tabs_to_profile: "warnBeforeMovingTabsToProfile" => bool = true, any, true;
    share_tabs_across_windows: "shareTabsAcrossWindows" => bool = false, any, false;
    extend_website_color: "extendWebsiteColor" => bool = true, any, true;
    cmd_click_creates_tab_group: "cmdClickCreatesTabGroup" => bool = false, any, true;
    opt_shift_click_opens_in_group: "optShiftClickOpensInGroup" => bool = true, any, true;
    peek_modifier: "peekModifier" => PeekModifier = PeekModifier::Shift, any, true;
    peek_links_to_other_sites: "peekLinksToOtherSites" => bool = true, any, true;
    new_tab_links_open_in: "newTabLinksOpenIn" => NewTabLinksOpenIn = NewTabLinksOpenIn::Peek, any, true;
    popups_open_as_tabs: "popupsOpenAsTabs" => bool = false, any, true;
    peek_buttons: "peekButtons" => PeekButtons = PeekButtons::Top, any, true;
    split_link_modifier: "splitLinkModifier" => SplitLinkModifier = SplitLinkModifier::AltShift, any, true;
    auto_group_meeting_tabs: "autoGroupMeetingTabs" => bool = true, any, true;
    clean_up_inactive_tabs_after_minutes: "cleanUpInactiveTabsAfterMinutes" => Option<f64> = None, clean_up, true;
    suggest_clean_up: "suggestCleanUp" => bool = true, any, true;
    muted_sites: "mutedSites" => Vec<String> = Vec::new(), any, true;
    show_unread_counts: "showUnreadCounts" => bool = false, any, true;
    show_top_app_badges: "showTopAppBadges" => bool = false, any, true;
    show_tab_hover_menu: "showTabHoverMenu" => bool = true, any, true;
    show_full_url_in_tab_hover_menu: "showFullUrlInTabHoverMenu" => bool = false, any, true;
    closed_top_app_tiles: "closedTopAppTiles" => bool = true, any, true;
    top_app_folders: "topAppFolders" => bool = true, any, true;
    unread_hidden_sites: "unreadHiddenSites" => Vec<String> = Vec::new(), any, true;
    never_translate_sites: "neverTranslateSites" => IndexMap<String, Vec<String>> = IndexMap::new(), any, false;
    developer_mode_sites: "developerModeSites" => IndexMap<String, bool> = IndexMap::new(), any, true;
    auto_picture_in_picture: "autoPictureInPicture" => bool = true, any, true;
    playing_now_across_profiles: "playingNowAcrossProfiles" => bool = false, any, true;
    sidebar_media_controls: "sidebarMediaControls" => bool = true, any, true;
    command_scroll_zoom: "commandScrollZoom" => bool = true, any, true;
    block_autoplay_everywhere: "blockAutoplayEverywhere" => bool = false, any, true;
    block_notification_requests: "blockNotificationRequests" => bool = false, any, true;
    video_upscaling: "videoUpscaling" => bool = true, any, true;
    sidebar_width: "sidebarWidth" => f64 = f64::from(DEFAULT_SIDEBAR_WIDTH), positive, false;
    show_sidebar_button: "showSidebarButton" => bool = true, any, true;
    show_clear_button: "showClearButton" => bool = true, any, true;
    tidy_tabs: "tidyTabs" => bool = false, any, true;
    balanced_top_apps: "balancedTopApps" => bool = false, any, true;
    selected_tab_glow: "selectedTabGlow" => SelectedTabGlowSetting = SelectedTabGlowSetting::Full, any, true;
    interface_scale: "interfaceScale" => f64 = 1.0, valid_interface_scale, false;
    sidebar_text_size: "sidebarTextSize" => SidebarTextSize = SidebarTextSize::Default, any, false;
    sidebar_text_contrast: "sidebarTextContrast" => SidebarTextContrast = SidebarTextContrast::Auto, any, true;
    selected_top_app: "selectedTopApp" => SelectedTopApp = SelectedTopApp::Ring, any, true;
    element_outlines: "elementOutlines" => bool = true, any, true;
    interface_style: "interfaceStyle" => InterfaceStyle = InterfaceStyle::Glass, any, true;
    window_buttons: "windowButtons" => WindowButtons = WindowButtons::Native, any, false;
    glass_tint_with_theme: "glassTintWithTheme" => bool = false, any, true;
    glass_tint_amount: "glassTintAmount" => f64 = 0.8, fraction, true;
    fade_unloaded_tabs: "fadeUnloadedTabs" => bool = false, any, true;
    strike_sleeping_tabs: "strikeSleepingTabs" => bool = false, any, true;
    warn_before_closing_tab_group: "warnBeforeClosingTabGroup" => bool = true, any, true;
    battery_saver_when: "batterySaverWhen" => BatterySaverWhen = BatterySaverWhen::LowBattery, any, false;
    unload_profiles_after: "unloadProfilesAfter" => UnloadProfilesAfter = UnloadProfilesAfter::Never, any, false;
    memory_saver: "memorySaver" => bool = true, any, false;
    busy_tab_warnings: "busyTabWarnings" => bool = true, any, false;
    memory_saver_mode: "memorySaverMode" => MemorySaverMode = MemorySaverMode::Balanced, any, false;
    load_profiles_when_opened: "loadProfilesWhenOpened" => bool = true, any, false;
    keep_active_sites: "keepActiveSites" => Vec<String> = Vec::new(), any, true;
    extension_side_panel_width: "extensionSidePanelWidth" => f64 = 360.0, positive, false;
    show_full_url: "showFullUrl" => bool = false, any, true;
    allow_javascript_from_apple_events: "allowJavaScriptFromAppleEvents" => bool = false, any, false;
    cli_control: "cliControl" => bool = false, any, false;
    show_cli_pill: "showCliPill" => bool = true, any, true;
    compact_cli_pill: "compactCliPill" => bool = false, any, true;
    show_bookmarks: "showBookmarks" => bool = true, any, true;
    bookmarks_bar: "bookmarksBar" => BookmarksBar = BookmarksBar::Never, any, true;
    bookmarks_import_dismissed: "bookmarksImportDismissed" => bool = false, any, false;
    appearance: "appearance" => Appearance = Appearance::Auto, any, true;
    address_bar: "addressBar" => AddressBar = AddressBar::Toolbar, any, true;
    compact_toolbar: "compactToolbar" => bool = false, any, true;
    address_bar_buttons: "addressBarButtons" => AddressBarButtons = AddressBarButtons::Hover, any, true;
    page_frame: "pageFrame" => f64 = f64::from(PAGE_FRAME_DEFAULT), page_frame, true;
    borderless_mode: "borderlessMode" => bool = false, any, true;
    tab_corner_radius: "tabCornerRadius" => Option<f64> = None, tab_corners, true;
    minimalism_mode: "minimalismMode" => bool = false, any, true;
    minimalism_pinned_icons: "minimalismPinnedIcons" => MinimalismPinnedIcons = MinimalismPinnedIcons::Letters, any, true;
    page_frame_zero_in_full_screen: "pageFrameZeroInFullScreen" => bool = false, any, true;
    page_frame_zero_when_tabs_hidden: "pageFrameZeroWhenTabsHidden" => bool = false, any, true;
    command_bar_placement: "commandBarPlacement" => CommandBarPlacement = CommandBarPlacement::Field, any, true;
    command_bar_start: "commandBarStart" => Value = empty_object(), command_bar_start, false;
    press_motion: "pressMotion" => PressMotion = PressMotion::Still, any, false;
    folder_style: "folderStyle" => FolderStyle = FolderStyle::Profile, any, false;
    live_folder_icon: "liveFolderIcon" => LiveFolderIcon = LiveFolderIcon::Folder, any, false;
    spaces_follow_appearance: "spacesFollowAppearance" => bool = true, any, false;
    adapt_text_to_color: "adaptTextToColor" => bool = true, any, true;
    default_profile_id: "defaultProfileId" => String = DEFAULT_PROFILE_ID.to_owned(), any, false;
    show_profile_dots: "showProfileDots" => bool = true, any, true;
    shortcuts: "shortcuts" => IndexMap<String, Vec<String>> = IndexMap::new(), any, true;
    mouse_shortcuts: "mouseShortcuts" => IndexMap<String, Vec<String>> = IndexMap::new(), any, true;
    open_links_in_little_ardia: "openLinksInLittleArdia" => bool = true, any, false;
    little_ardia_opens_new_tab_links: "littleArdiaOpensNewTabLinks" => bool = true, any, true;
    little_ardia_shortcut_from_any_app: "littleArdiaShortcutFromAnyApp" => bool = false, any, false;
    little_ardia_size: "littleArdiaSize" => [f64; 2] = [900.0, 640.0], little_size, false;
    engine_mode: "engineMode" => EngineMode = EngineMode::Automatic, any, false;
    page_engine: "pageEngine" => PageEngine = PageEngine::Chromium, any, false;
    website_engines: "websiteEngines" => IndexMap<String, PageEngine> = IndexMap::new(), any, false;
    protected_video_in_webkit: "protectedVideoInWebKit" => bool = true, any, false;
    offer_webkit_for_protected_video: "offerWebKitForProtectedVideo" => bool = true, any, false;
    engine_switch_keeps_page: "engineSwitchKeepsPage" => bool = true, any, false;
    engine_switch_asks_about_unsaved_work: "engineSwitchAsksAboutUnsavedWork" => bool = true, any, false;
    engine_switch_carries_site_data: "engineSwitchCarriesSiteData" => bool = true, any, false;
    webkit_fraud_warnings: "webKitFraudWarnings" => bool = false, any, false;
    launch_actions: "launchActions" => Vec<String> = Vec::new(), |v: &Vec<String>| launch_actions(v), false;
    omnibox_providers: "omniboxProviders" => Value = empty_array(), providers, false;
    reader_text_size: "readerTextSize" => ReaderTextSize = ReaderTextSize::Medium, any, true;
    reader_font: "readerFont" => ReaderFont = ReaderFont::Serif, any, true;
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsMeta {
    #[serde(default, deserialize_with = "crate::json::lenient")]
    pub chosen: Vec<String>,
    #[serde(default, deserialize_with = "crate::json::lenient")]
    pub inferred: Vec<String>,
}

impl SettingsMeta {
    pub fn from_value(value: Option<&Value>) -> Self {
        let fields = value.and_then(Value::as_object);
        SettingsMeta {
            chosen: crate::json::strings(fields.and_then(|f| f.get("chosen"))),
            inferred: crate::json::strings(fields.and_then(|f| f.get("inferred"))),
        }
    }

    pub fn chosen_here(&self, key: &str) -> bool {
        self.chosen.iter().any(|k| k == key) && !self.inferred.iter().any(|k| k == key)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SettingsPatch(pub Vec<(String, Value)>);

impl SettingsPatch {
    pub fn new() -> Self {
        SettingsPatch(Vec::new())
    }

    pub fn set(mut self, key: &str, value: impl Serialize) -> Self {
        self.0.retain(|(k, _)| k != key);
        self.0.push((key.to_owned(), to_json(&value)));
        self
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(k, _)| k.as_str())
    }

    pub fn contains(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AppliedPatch {
    pub keys: Vec<String>,
    pub rejected: Vec<String>,
    pub auto_hide_changed: bool,
}

impl Settings {
    pub fn shown_selected_top_app(&self) -> SelectedTopApp {
        if self.element_outlines {
            self.selected_top_app
        } else {
            SelectedTopApp::Fill
        }
    }

    pub fn info(key: &str) -> Option<&'static SettingInfo> {
        SETTINGS.iter().find(|s| s.key == key)
    }

    pub fn from_value(raw: Option<&Value>) -> Settings {
        let mut settings = Settings::default();
        let Some(fields) = raw.and_then(Value::as_object) else {
            return settings;
        };
        for (key, value) in fields {
            match settings.assign(key, value) {
                Ok(()) | Err(SettingError::Invalid(_)) => {}
                Err(SettingError::Unknown(_)) => {
                    if !RETIRED_SETTING_KEYS.contains(&key.as_str()) {
                        settings.extra.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        settings.custom_search_engines = custom_engines_from(&settings.custom_search_engines);
        if fields.get("hideBookmarksBarImport") == Some(&Value::Bool(true)) {
            settings.bookmarks_import_dismissed = true;
        }
        settings.keep_link_keys_apart(None);
        settings
    }

    pub fn set(&mut self, key: &str, value: &Value) -> Result<(), SettingError> {
        self.assign(key, value)?;
        if key == "customSearchEngines" {
            self.custom_search_engines = custom_engines_from(&self.custom_search_engines);
        }
        Ok(())
    }

    fn keep_link_keys_apart(&mut self, changed: Option<&str>) {
        if self.peek_modifier != PeekModifier::Alt
            || self.split_link_modifier != SplitLinkModifier::Alt
        {
            return;
        }
        if changed == Some("splitLinkModifier") {
            self.peek_modifier = PeekModifier::Shift;
        } else {
            self.split_link_modifier = SplitLinkModifier::AltShift;
        }
    }

    pub fn page_frame(&self) -> u8 {
        self.page_frame
            .clamp(f64::from(PAGE_FRAME_MIN), f64::from(PAGE_FRAME_MAX)) as u8
    }

    pub fn frame_rules(&self, full_screen: bool, tabs_hidden: bool) -> FrameRules {
        FrameRules {
            borderless_mode: self.borderless_mode,
            zero_in_full_screen: self.page_frame_zero_in_full_screen,
            full_screen,
            zero_when_tabs_hidden: self.page_frame_zero_when_tabs_hidden,
            tabs_hidden,
        }
    }

    pub fn page_frame_inset(&self, full_screen: bool, tabs_hidden: bool) -> f32 {
        ardia_theme::layout::page_frame_inset(
            self.page_frame as f32,
            self.frame_rules(full_screen, tabs_hidden),
        )
    }

    pub fn liquid_glass_enabled(&self) -> bool {
        self.interface_style == InterfaceStyle::Glass
    }

    pub fn high_contrast_text(&self, system_increase_contrast: bool) -> bool {
        match self.sidebar_text_contrast {
            SidebarTextContrast::Auto => system_increase_contrast,
            SidebarTextContrast::Standard => false,
            SidebarTextContrast::High => true,
        }
    }

    pub fn new_tab_opens(&self) -> NewTabOpens {
        if self.minimalism_mode {
            NewTabOpens::CommandBar
        } else {
            self.new_tab_opens
        }
    }

    pub fn split_link_modifier(&self) -> SplitLinkModifier {
        if self.split_link_modifier == SplitLinkModifier::Alt
            && self.peek_modifier == PeekModifier::Alt
        {
            SplitLinkModifier::AltShift
        } else {
            self.split_link_modifier
        }
    }

    pub fn clean_up_after_hours(&self) -> Option<f64> {
        self.clean_up_inactive_tabs_after_minutes.map(|m| m / 60.0)
    }

    pub fn to_value(&self) -> Value {
        Value::Object(self.to_fields())
    }

    pub fn apply(
        &mut self,
        meta: &mut SettingsMeta,
        patch: &SettingsPatch,
        from_sync: bool,
        inferring: bool,
    ) -> AppliedPatch {
        let before_auto_hide = self.auto_hide_tabs;
        let mut keys = Vec::new();
        let mut rejected = Vec::new();
        for (key, value) in &patch.0 {
            match self.set(key, value) {
                Ok(()) => keys.push(key.clone()),
                Err(_) => rejected.push(key.clone()),
            }
        }
        if self.page_frame_zero_in_full_screen
            && !self.page_frame_zero_when_tabs_hidden
            && !patch.contains("pageFrameZeroWhenTabsHidden")
            && patch.contains("pageFrameZeroInFullScreen")
        {
            self.page_frame_zero_when_tabs_hidden = true;
            keys.push("pageFrameZeroWhenTabsHidden".to_owned());
        }
        if !from_sync {
            let changed = if patch.contains("splitLinkModifier") && !patch.contains("peekModifier")
            {
                Some("splitLinkModifier")
            } else {
                None
            };
            let peek_before = self.peek_modifier;
            let split_before = self.split_link_modifier;
            self.keep_link_keys_apart(changed);
            if self.peek_modifier != peek_before {
                keys.push("peekModifier".to_owned());
            }
            if self.split_link_modifier != split_before {
                keys.push("splitLinkModifier".to_owned());
            }
            for key in &keys {
                if !meta.chosen.contains(key) {
                    meta.chosen.push(key.clone());
                }
            }
            if inferring {
                for key in &keys {
                    if !meta.inferred.contains(key) {
                        meta.inferred.push(key.clone());
                    }
                }
            } else {
                meta.inferred.retain(|k| !keys.contains(k));
            }
        }
        AppliedPatch {
            auto_hide_changed: self.auto_hide_tabs != before_auto_hide,
            keys,
            rejected,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetiredDefault {
    pub key: &'static str,
    pub old: bool,
    pub applied: &'static str,
    pub waits_for_sync: bool,
}

pub const RETIRED_DEFAULTS: [RetiredDefault; 2] = [
    RetiredDefault {
        key: "hideToolbarWhileScrolling",
        old: true,
        applied: "hideToolbarWhileScrolling:offByDefault",
        waits_for_sync: false,
    },
    RetiredDefault {
        key: "cmdClickCreatesTabGroup",
        old: true,
        applied: "cmdClickCreatesTabGroup:offByDefault",
        waits_for_sync: true,
    },
];

pub fn with_retired_defaults(
    saved: &mut Fields,
    meta: &mut SettingsMeta,
    wait_for_sync: bool,
) -> bool {
    let mut changed = false;
    for retired in RETIRED_DEFAULTS {
        if meta.inferred.iter().any(|k| k == retired.applied) {
            continue;
        }
        let nobody_chose_old = saved.get(retired.key) == Some(&Value::Bool(retired.old))
            && !meta.chosen_here(retired.key);
        if !nobody_chose_old {
            meta.inferred.push(retired.applied.to_owned());
            changed = true;
            continue;
        }
        if wait_for_sync && retired.waits_for_sync {
            continue;
        }
        saved.shift_remove(retired.key);
        meta.chosen.retain(|k| k != retired.key);
        meta.inferred.retain(|k| k != retired.key);
        meta.inferred.push(retired.applied.to_owned());
        changed = true;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_setting_has_a_unique_key_and_round_trips_its_default() {
        let defaults = Settings::default();
        let fields = defaults.to_fields();
        assert_eq!(fields.len(), SETTINGS.len());
        let mut keys: Vec<&str> = SETTINGS.iter().map(|s| s.key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), SETTINGS.len());
        assert_eq!(Settings::from_value(Some(&Value::Object(fields))), defaults);
        assert_eq!(SETTINGS.len(), 133);
        assert_eq!(SETTINGS.iter().filter(|s| !s.config_file).count(), 17);
    }

    #[test]
    fn invalid_values_fall_back_to_defaults_and_unknown_keys_survive() {
        let raw = json!({"pageFrame": 4, "sidebarWidth": 233.3046875, "interfaceScale": 1.07, "tabLayout": "diagonal", "glassTintAmount": 0.17,
            "tabCornerRadius": 9, "littleArdiaSize": [900, -1], "futureKnob": {"on": true}, "profileSwitcherIcons": false, "cleanUpInactiveTabsAfterMinutes": null});
        let settings = Settings::from_value(Some(&raw));
        assert_eq!(settings.page_frame(), 4);
        assert_eq!(settings.sidebar_width, 233.3046875);
        assert_eq!(settings.interface_scale, 1.0);
        assert_eq!(settings.tab_layout, TabLayout::Sidebar);
        assert_eq!(settings.tab_corner_radius, Some(9.0));
        assert_eq!(settings.little_ardia_size, [900.0, 640.0]);
        assert_eq!(settings.extra.get("futureKnob"), Some(&json!({"on": true})));
        assert!(!settings.extra.contains_key("profileSwitcherIcons"));
        let out = settings.to_value();
        assert_eq!(out["pageFrame"], json!(4));
        assert_eq!(out["sidebarWidth"], json!(233.3046875));
        assert_eq!(out["littleArdiaSize"], json!([900, 640]));
        assert_eq!(out["futureKnob"], json!({"on": true}));
    }

    #[test]
    fn interface_scale_takes_only_five_percent_steps() {
        for ok in [0.8, 0.85, 1.0, 1.25, 1.5] {
            assert!(valid_interface_scale(&ok), "{ok}");
        }
        for bad in [0.75, 1.55, 1.07, f64::NAN] {
            assert!(!valid_interface_scale(&bad), "{bad}");
        }
    }

    #[test]
    fn patches_track_chosen_and_inferred_keys() {
        let mut settings = Settings::default();
        let mut meta = SettingsMeta::default();
        let applied = settings.apply(
            &mut meta,
            &SettingsPatch::new()
                .set("tabLayout", "top")
                .set("pageFrame", 40),
            false,
            false,
        );
        assert_eq!(applied.keys, vec!["tabLayout"]);
        assert_eq!(applied.rejected, vec!["pageFrame"]);
        assert_eq!(settings.tab_layout, TabLayout::Top);
        assert_eq!(meta.chosen, vec!["tabLayout"]);
        settings.apply(
            &mut meta,
            &SettingsPatch::new().set("appearance", "dark"),
            false,
            true,
        );
        assert!(meta.inferred.contains(&"appearance".to_owned()));
        settings.apply(
            &mut meta,
            &SettingsPatch::new().set("appearance", "light"),
            false,
            false,
        );
        assert!(!meta.inferred.contains(&"appearance".to_owned()));
        let synced = settings.apply(
            &mut meta,
            &SettingsPatch::new().set("autoHideTabs", true),
            true,
            false,
        );
        assert!(synced.auto_hide_changed);
        assert!(!meta.chosen.contains(&"autoHideTabs".to_owned()));
    }

    #[test]
    fn link_modifiers_never_collide() {
        let mut settings = Settings::default();
        let mut meta = SettingsMeta::default();
        settings.apply(
            &mut meta,
            &SettingsPatch::new().set("peekModifier", "alt"),
            false,
            false,
        );
        settings.apply(
            &mut meta,
            &SettingsPatch::new().set("splitLinkModifier", "alt"),
            false,
            false,
        );
        assert_eq!(
            (settings.peek_modifier, settings.split_link_modifier),
            (PeekModifier::Shift, SplitLinkModifier::Alt)
        );
        settings.apply(
            &mut meta,
            &SettingsPatch::new().set("peekModifier", "alt"),
            false,
            false,
        );
        assert_eq!(
            (settings.peek_modifier, settings.split_link_modifier),
            (PeekModifier::Alt, SplitLinkModifier::AltShift)
        );
    }

    #[test]
    fn zero_in_full_screen_turns_on_zero_when_tabs_hidden() {
        let mut settings = Settings::default();
        let mut meta = SettingsMeta::default();
        settings.apply(
            &mut meta,
            &SettingsPatch::new().set("pageFrameZeroInFullScreen", true),
            false,
            false,
        );
        assert!(settings.page_frame_zero_when_tabs_hidden);
        assert_eq!(settings.page_frame_inset(true, false), 0.0);
        assert_eq!(settings.page_frame_inset(false, true), 9.0);
    }

    #[test]
    fn retired_defaults_drop_untouched_old_values_once() {
        let mut saved = json!({"hideToolbarWhileScrolling": true, "cmdClickCreatesTabGroup": true})
            .as_object()
            .unwrap()
            .clone();
        let mut meta = SettingsMeta {
            chosen: vec!["cmdClickCreatesTabGroup".into()],
            inferred: vec![],
        };
        assert!(with_retired_defaults(&mut saved, &mut meta, false));
        assert!(!saved.contains_key("hideToolbarWhileScrolling"));
        assert!(saved.contains_key("cmdClickCreatesTabGroup"));
        assert!(
            meta.inferred
                .contains(&"hideToolbarWhileScrolling:offByDefault".to_owned())
        );
        assert!(!with_retired_defaults(&mut saved, &mut meta, false));
        let mut waiting = json!({"cmdClickCreatesTabGroup": true})
            .as_object()
            .unwrap()
            .clone();
        let mut fresh = SettingsMeta::default();
        with_retired_defaults(&mut waiting, &mut fresh, true);
        assert!(waiting.contains_key("cmdClickCreatesTabGroup"));
    }

    #[test]
    fn config_file_keeps_engine_and_control_keys_out() {
        assert!(!Settings::info("cliControl").unwrap().config_file);
        assert!(!Settings::info("websiteEngines").unwrap().config_file);
        assert!(Settings::info("tabLayout").unwrap().config_file);
        assert!(Settings::info("tabLayout").unwrap().synced);
        assert!(!Settings::info("sidebarWidth").unwrap().synced);
        assert_eq!(Settings::info("nope"), None);
    }
}
