use crate::host::ProfileFlagKind as Flag;
use crate::host::UtilityWindowKind;
use crate::primitives::icons::Icon;
use ardia_state::settings::Settings;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Pane {
    General,
    Profiles,
    Tabs,
    Appearance,
    Automations,
    Plugins,
    Shortcuts,
    Advanced,
}

#[allow(non_upper_case_globals)]
impl Pane {
    pub const Privacy: Pane = Pane::General;
    pub const Sync: Pane = Pane::General;
    pub const SiteSettings: Pane = Pane::Profiles;
    pub const Extensions: Pane = Pane::Profiles;
    pub const Passwords: Pane = Pane::Profiles;
    pub const Autofill: Pane = Pane::Profiles;
}

impl Pane {
    pub const ALL: [Pane; 8] = [
        Pane::General,
        Pane::Profiles,
        Pane::Tabs,
        Pane::Appearance,
        Pane::Automations,
        Pane::Plugins,
        Pane::Shortcuts,
        Pane::Advanced,
    ];

    pub const fn title(self) -> &'static str {
        match self {
            Pane::General => "General",
            Pane::Profiles => "Profiles",
            Pane::Tabs => "Tabs",
            Pane::Appearance => "Appearance",
            Pane::Automations => "Automations",
            Pane::Plugins => "Plugins",
            Pane::Shortcuts => "Shortcuts",
            Pane::Advanced => "Advanced",
        }
    }

    pub const fn symbol(self) -> &'static str {
        match self {
            Pane::General => "gearshape.fill",
            Pane::Profiles => "person.2.fill",
            Pane::Tabs => "square.on.square.fill",
            Pane::Appearance => "circle.lefthalf.filled",
            Pane::Automations => "wand.and.rays",
            Pane::Plugins => "puzzlepiece.fill",
            Pane::Shortcuts => "keyboard.fill",
            Pane::Advanced => "slider.horizontal.3",
        }
    }

    pub const fn icon(self) -> Icon {
        match self {
            Pane::General => Icon::Gear,
            Pane::Profiles => Icon::PersonPair,
            Pane::Tabs => Icon::Tabs,
            Pane::Appearance => Icon::HalfCircle,
            Pane::Automations => Icon::Wand,
            Pane::Plugins => Icon::Puzzle,
            Pane::Shortcuts => Icon::Keyboard,
            Pane::Advanced => Icon::Sliders,
        }
    }

    pub const fn tint(self) -> u32 {
        match self {
            Pane::General | Pane::Advanced => 0x8E8E93,
            Pane::Profiles => 0x0A84FF,
            Pane::Tabs => 0xFF9500,
            Pane::Appearance => 0x5856D6,
            Pane::Automations => 0xAF52DE,
            Pane::Plugins => 0x30B0C7,
            Pane::Shortcuts => 0xFF2D55,
        }
    }

    pub fn index(self) -> usize {
        Pane::ALL.iter().position(|p| *p == self).unwrap_or(0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Act {
    Url(&'static str),
    Utility(UtilityWindowKind),
    Command(&'static str),
    DeleteProfile,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Custom {
    Programs,
    AppIcon,
    NewTabUrl,
    KeptSites,
    Version,
    OfficialPlugins,
    PasswordManager,
    AutoUpdate,
    UpdateChannel,
    ShareDiagnostics,
    ProfileFlag(Flag),
    PluginList,
    ProfileName,
    ProfileIcon,
    ProfileSync,
    OpenAtLogin,
    DownloadsFolder,
    SeparateDownloads,
    AskWhereToSave,
    ProfileDownloadsFolder,
    RestoreSession,
    SyncSection,
    InterfaceSize,
    ProfileBar,
    ProfileColour,
    SearchEngine,
    DefaultProfile,
    TabLayout,
    Buttons,
    Badges,
    SleepingTabs,
    NewTabOpens,
    NewTabPosition,
    LinksInLittleArdia,
    PeekOtherSites,
    CleanUp,
    GlassTint,
    HighContrast,
    AfterClosing,
    CommandBarPlacement,
    CommandBarOnClick,
    BookmarksBar,
    PageFrame,
    FullScreenFrame,
    TabCorners,
    CtrlTab,
    ShortcutList,
    MemorySaver,
    BatterySaver,
    InstalledExtensions,
    ExportBookmarks,
    BlockCategory,
    AllowedPrograms,
    SearchControlled,
    EngineMode,
    PageEngine,
    WebsiteEngines,
}

pub type Options = &'static [(&'static str, &'static str)];
pub type Cards = &'static [(&'static str, &'static str, &'static str)];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Control {
    Toggle(&'static str),
    Popup(&'static str, Options),
    Segmented(&'static str, Options),
    Cards(&'static str, Cards),
    Checklist(Options),
    Button(&'static str, Act),
    Link(Act),
    Note,
    Custom(Custom),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum When {
    Always,
    Unavailable,
    Sidebar,
    GlassAvailable,
    Glass,
    Outlines,
    ToolbarAddress,
    CentredCommandBar,
    Minimalism,
    Framed,
    NewTabPage,
    NeverCleansUp,
    NotDefaultBrowser,
    LoginItems,
    SharedDownloads,
    SeparateDownloads,
    KeptSites,
    Calendar,
    AppIcons,
    SyncOn,
    ExtensionSearch,
    WebKitOffered,
    AutomaticEngine,
    WebKitInUse,
    Updater,
    OfficialPlugins,
    OfficialAi,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct System {
    pub default_browser: Option<bool>,
    pub login_items: bool,
    pub calendar: bool,
    pub app_icons: bool,
    pub sync_on: bool,
    pub webkit: bool,
    pub updater: bool,
    pub official_plugins: bool,
    pub official_ai: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Row {
    pub id: &'static str,
    pub pane: Pane,
    pub section: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub explained: bool,
    pub keywords: &'static str,
    pub control: Control,
    pub when: When,
    pub needs: &'static str,
}

impl Row {
    pub fn standalone(&self) -> bool {
        matches!(
            self.control,
            Control::Cards(..)
                | Control::Custom(
                    Custom::SyncSection
                        | Custom::ProfileBar
                        | Custom::ProfileColour
                        | Custom::TabLayout
                        | Custom::AfterClosing
                        | Custom::CommandBarPlacement
                        | Custom::ShortcutList
                        | Custom::PluginList
                        | Custom::AppIcon
                )
        )
    }

    pub fn shown(&self, settings: &Settings) -> bool {
        self.shown_in(settings, &System::default())
    }

    pub fn shown_in(&self, settings: &Settings, system: &System) -> bool {
        use ardia_state::model::TabLayout;
        use ardia_state::settings::{AddressBar, CommandBarPlacement, InterfaceStyle, NewTabOpens};
        let top = settings.tab_layout == TabLayout::Top;
        match self.when {
            When::Always => true,
            When::Unavailable => false,
            When::Sidebar => !top,
            When::GlassAvailable => crate::look::liquid_glass_available(),
            When::Glass => {
                crate::look::liquid_glass_available()
                    && settings.interface_style == InterfaceStyle::Glass
            }
            When::Outlines => settings.element_outlines,
            When::ToolbarAddress => top || settings.address_bar == AddressBar::Toolbar,
            When::CentredCommandBar => settings.command_bar_placement != CommandBarPlacement::Field,
            When::Minimalism => settings.minimalism_mode,
            When::Framed => !settings.borderless_mode,
            When::NewTabPage => {
                settings.new_tab_opens == NewTabOpens::Page && !settings.minimalism_mode
            }
            When::NeverCleansUp => settings.clean_up_inactive_tabs_after_minutes.is_none(),
            When::NotDefaultBrowser => system.default_browser == Some(false),
            When::LoginItems => system.login_items,
            When::SharedDownloads => !settings.separate_download_folders,
            When::AppIcons => system.app_icons,
            When::KeptSites => settings.memory_saver || settings.busy_tab_warnings,
            When::ExtensionSearch => settings.extension_search_engines.iter().any(|e| e.is_default),
            When::SeparateDownloads => settings.separate_download_folders,
            When::Calendar => system.calendar,
            When::SyncOn => system.sync_on,
            When::WebKitOffered => system.webkit,
            When::AutomaticEngine => {
                system.webkit
                    && settings.engine_mode == ardia_state::settings::EngineMode::Automatic
            }
            When::WebKitInUse => {
                system.webkit && settings.engine_mode != ardia_state::settings::EngineMode::Chromium
            }
            When::Updater => system.updater,
            When::OfficialPlugins => system.official_plugins,
            When::OfficialAi => system.official_ai,
        }
    }
}

const fn row(
    id: &'static str,
    pane: Pane,
    section: &'static str,
    title: &'static str,
    control: Control,
) -> Row {
    Row {
        id,
        pane,
        section,
        title,
        description: "",
        explained: false,
        keywords: "",
        control,
        when: When::Always,
        needs: "",
    }
}

impl Row {
    const fn says(mut self, description: &'static str) -> Self {
        self.description = description;
        self
    }

    const fn explains(mut self, description: &'static str) -> Self {
        self.description = description;
        self.explained = true;
        self
    }

    const fn keys(mut self, keywords: &'static str) -> Self {
        self.keywords = keywords;
        self
    }

    const fn when(mut self, when: When, needs: &'static str) -> Self {
        self.when = when;
        self.needs = needs;
        self
    }
}

use Control::{Button, Cards as CardChoice, Checklist, Link, Note, Popup, Segmented, Toggle};
use Custom as C;
use Pane::{Advanced, Appearance, Automations, General, Plugins, Profiles, Shortcuts, Tabs};

const NEEDS_SIDEBAR: &str = "Use vertical tabs to change this";
const NEEDS_CALENDAR: &str = "Allow calendar access to use this";
const NEEDS_AUTOMATIC: &str = "Set Engine to Automatic in General to use this";
const NEEDS_WEBKIT: &str = "Set Engine to Automatic or WebKit in General to use this";

pub const ASK_BEFORE: Options = &[
    ("warnBeforeQuitting", "Quitting with ⌘Q"),
    (
        "warnBeforeClosingWindow",
        "Closing a window with several tabs",
    ),
    (
        "warnBeforeClosingLastTab",
        "Closing the last tab in a profile",
    ),
    ("warnBeforeClosingTabGroup", "Closing a tab group"),
    (
        "warnBeforeMovingTabsToProfile",
        "Moving tabs to another profile",
    ),
];
pub const WINDOWS_AND_TABS: Options =
    &[("keep", "Keep windows and tabs"), ("close", "Start fresh")];
pub const SIDEBAR_SIDES: Options = &[("left", "Left"), ("right", "Right")];
pub const SLEEPING_LOOKS: Options = &[
    ("normal", "Look normal"),
    ("fade", "Fade icon"),
    ("strike", "Strike through"),
    ("both", "Both"),
];
pub const NEW_TAB_OPENS: Options = &[("page", "New Tab page"), ("commandBar", "Command bar")];
pub const NEW_TABS_DOWN: Options = &[
    ("bottom", "At the bottom"),
    ("top", "At the top"),
    ("nextToCurrent", "Below the current tab"),
];
pub const NEW_TABS_ACROSS: Options = &[
    ("bottom", "On the right"),
    ("top", "On the left"),
    ("nextToCurrent", "Next to the current tab"),
];
pub const OTHER_SITE_LINKS: Options = &[("same", "Same tab"), ("peek", "Peek")];
const NEW_TAB_LINKS: Options = &[
    ("tab", "New tab"),
    ("peek", "Peek"),
    ("littleArdia", "Little Ardia"),
];
const PEEK_BUTTONS: Options = &[
    ("top", "In the title bar"),
    ("left", "On the left"),
    ("right", "On the right"),
];
pub const CLEAN_UP: Options = &[
    ("never", "Never"),
    ("720", "12 hours"),
    ("1440", "24 hours"),
    ("10080", "7 days"),
    ("43200", "30 days"),
];
const MODES: Cards = &[
    ("auto", "Automatic", ""),
    ("light", "Light", ""),
    ("dark", "Dark", ""),
];
const STYLES: Cards = &[("glass", "Glass", ""), ("classic", "Classic", "")];
const GLOWS: Options = &[("full", "Full"), ("soft", "Soft"), ("off", "Off")];
const SELECTED_TOP_APP: Options = &[
    ("ring", "Ring"),
    ("fill", "Fill only"),
    ("outline", "Outline only"),
];
const SIDEBAR_TEXT_SIZES: Options = &[
    ("default", "Default"),
    ("large", "Large"),
    ("larger", "Larger"),
];
const SWITCHER_ORDERS: Cards = &[
    (
        "recent",
        "Recent tabs",
        "Most recently used first; let go to switch, like Arc and Dia.",
    ),
    ("inOrder", "In order", "Down the tab list, like Chrome."),
];
const SWITCHER_VIEWS: Cards = &[
    ("thumbnails", "Page previews", "A row of page pictures."),
    (
        "compactList",
        "Compact list",
        "Titles and sites, one per line.",
    ),
    ("none", "None", "Switches without showing anything."),
];
pub const AFTER_CLOSING_DOWN: Cards = &[
    ("tabAbove", "Tab above", "Goes to the tab right above it."),
    ("tabBelow", "Tab below", "Goes to the tab right below it."),
    (
        "previouslyActive",
        "Previously active tab",
        "Goes back to the tab you used before, like Arc.",
    ),
];
pub const AFTER_CLOSING_ACROSS: Cards = &[
    (
        "tabAbove",
        "Tab to the left",
        "Goes to the tab to the left.",
    ),
    (
        "tabBelow",
        "Tab to the right",
        "Goes to the tab to the right.",
    ),
    (
        "previouslyActive",
        "Previously active tab",
        "Goes back to the tab you used before, like Arc.",
    ),
];
const ADDRESS_BAR: Cards = &[
    (
        "toolbar",
        "In the toolbar",
        "Above the page, with its buttons.",
    ),
    (
        "sidebar",
        "In the sidebar",
        "Above your tabs; the page gets more room.",
    ),
];
pub const COMMAND_BAR_PLACES: Cards = &[
    (
        "field",
        "At the address",
        "Opens where the address is, like Chrome.",
    ),
    (
        "centred",
        "In the center",
        "Floats over the page, like Arc.",
    ),
];
const ADDRESS_BAR_BUTTONS: Options = &[("hover", "Show on hover"), ("always", "Always show")];
const MINIMALISM_PINNED_ICONS: Options = &[("letters", "Letters"), ("logos", "Site Logos")];
pub const BOOKMARKS_BAR: Options = &[
    ("always", "Always"),
    ("newTab", "On new tabs"),
    ("never", "Never"),
    ("hidden", "Hide bookmarks entirely"),
];
pub const FULL_SCREEN_FRAME: Options = &[
    ("keep", "Keep frame"),
    ("remove", "Remove"),
    ("tabsHidden", "Remove when tabs are hidden"),
];
const SCROLL_TOOLBAR: Cards = &[
    (
        "false",
        "Keep the toolbar",
        "Stays put while the page scrolls.",
    ),
    (
        "true",
        "Shrink while scrolling",
        "Shrinks to a strip as you scroll down.",
    ),
];
const PEEK_WITH: Options = &[("shift", "⇧-click"), ("alt", "⌥-click"), ("off", "Off")];
const SPLIT_WITH: Options = &[("altShift", "⌥⇧-click"), ("alt", "⌥-click")];
pub const MEMORY_SAVER: &[(&str, &str, &str)] = &[
    ("off", "Off", "Tabs stay loaded."),
    (
        "moderate",
        "Moderate",
        "Sleeps tabs slowly. Profiles load on open.",
    ),
    (
        "balanced",
        "Balanced (recommended)",
        "Sleeps idle tabs automatically. Profiles load on open.",
    ),
    (
        "maximum",
        "Maximum",
        "Sleeps tabs aggressively and unloads idle profiles after 15m.",
    ),
];
pub const BATTERY_SAVER: &[(&str, &str, &str)] = &[
    (
        "lowBattery",
        "When battery is low",
        "Pauses busy background tabs at 20% battery or in Low Power Mode.",
    ),
    (
        "unplugged",
        "When unplugged",
        "Pauses busy background tabs on battery or in Low Power Mode.",
    ),
    (
        "never",
        "Never",
        "Background tabs and animations always run at full speed.",
    ),
];
const SUGGEST: Options = &[
    ("searchSuggestions", "Searches"),
    ("commandBarHistory", "Pages from history"),
];

pub const ROWS: &[Row] = &[
    row("general.defaultBrowser", General, "Default browser", "Default browser", Button("Set Ardia as Default", Act::Command("settings:makeDefaultBrowser")))
        .says("Make Ardia your default browser.")
        .keys("default set as default links")
        .when(When::NotDefaultBrowser, ""),
    row("general.openAtLogin", General, "Startup and quitting", "Open Ardia at login", Control::Custom(C::OpenAtLogin))
        .keys("startup launch login items boot")
        .when(When::LoginItems, ""),
    row("general.windowsAndTabs", General, "Startup and quitting", "When Ardia quits", Control::Custom(C::RestoreSession))
        .says("What you see the next time you open it. Closed windows stay in History › Recently Closed.")
        .keys("restore session reopen preserve tabs start fresh windows and tabs"),
    row("general.askBefore", General, "Startup and quitting", "Ask before", Checklist(ASK_BEFORE))
        .explains("Ardia asks before doing any of these.")
        .keys("quit confirm cmd q last window exit warn before quitting close window warn before closing a window with multiple tabs close tab warn before closing last tab in a profile close group folder accidentally warn before closing a tab group warn before moving tabs between profiles warn last tab move tab"),
    row("general.engineMode", General, "Web engine", "Engine", Control::Custom(C::EngineMode))
        .keys("engine mode only just chromium only webkit only safari automatic always webkit limitations limitations not supported unsupported passkeys security keys picture in picture client hints midi casting chromecast chrome.debugger webrequest removeparam about engines how automatic works")
        .when(When::WebKitOffered, ""),
    row("general.downloadsFolder", General, "Downloads", "Downloads folder", Control::Custom(C::DownloadsFolder))
        .says("Where downloaded files are saved.")
        .keys("download location save to path folder")
        .when(When::SharedDownloads, "Turn off Separate folder for each profile to set one folder here"),
    row("general.separateDownloadFolders", General, "Downloads", "Separate folder for each profile", Control::Custom(C::SeparateDownloads))
        .says("Each profile saves to its own folder.")
        .keys("all profiles global download location use these settings for every profile per profile"),
    row("general.askWhereToSave", General, "Downloads", "Ask where to save each file", Control::Custom(C::AskWhereToSave))
        .keys("download location save as prompt choose folder"),
    row("general.blockAds", General, "Content blocking", "Block ads", Control::Custom(C::BlockCategory))
        .keys("ad blocker adblock ublock origin easylist"),
    row("general.blockTrackers", General, "Content blocking", "Block trackers", Control::Custom(C::BlockCategory))
        .keys("tracking easyprivacy fingerprinting"),
    row("general.blockCookieBanners", General, "Content blocking", "Block cookie banners", Control::Custom(C::BlockCategory))
        .keys("cookies consent gdpr popups"),
    row("general.filterLists", General, "Content blocking", "Filter lists", Link(Act::Command(crate::settings::general_subpages::OPEN_FILTER_LISTS)))
        .explains("Extra filter lists for the blocker.")
        .keys("filter lists annoyances malware regional ad block settings custom filter list allowlist exceptions hidden elements"),
    row("general.sync", General, "Sync", "Sync", Control::Custom(C::SyncSection))
        .explains("Keep your profiles, tabs and settings the same on every Mac.")
        .keys("icloud drive recovery phrase devices turn on sync end to end encrypted sync folder dropbox what syncs unpinned tabs open tabs data types computers macs remove device"),
    row("general.autoUpdate", General, "Updates", "Install updates automatically", Control::Custom(C::AutoUpdate))
        .explains("Installs updates on the next restart.")
        .keys("update install sparkle check for updates automatically automatic updates")
        .when(When::Updater, ""),
    row("general.updateChannel", General, "Updates", "Update channel", Control::Custom(C::UpdateChannel))
        .explains("Nightly gets fixes first.")
        .keys("nightly stable beta")
        .when(When::Updater, ""),
    row("general.version", General, "Updates", "Version", Control::Custom(C::Version))
        .keys("version update about check for updates now engine chromium license"),
    row("general.shareDiagnostics", General, "Crash reports", "Share anonymous crash reports", Control::Custom(C::ShareDiagnostics))
        .keys("telemetry analytics diagnostics crash share anonymous crash reports and usage stats"),
    row("general.crashDetails", General, "Crash reports", "Details", Link(Act::Command(crate::settings::general_subpages::OPEN_CRASH_DETAILS)))
        .says("What's sent and what's kept on this computer.")
        .keys("telemetry data collection analytics usage data what's sent"),
    row("general.importBrowser", General, "Import", "Import from another browser", Button("Import…", Act::Utility(UtilityWindowKind::Import)))
        .says("From Chrome, Arc, Safari, Firefox and more.")
        .keys("migrate switch transfer import from another browser setup code demo preset arc layout"),
    row("general.redoSetup", General, "Import", "Set up Ardia again", Button("Redo Setup…", Act::Utility(UtilityWindowKind::Onboarding)))
        .explains("Run setup again, starting from your current settings.")
        .keys("onboarding setup redo welcome start over walkthrough first run"),
    row("profiles.profiles", Profiles, "Profiles", "Profiles", Control::Custom(C::ProfileBar))
        .explains("Pick one to edit it; drag to reorder. ⌃1–⌃9 switch.")
        .keys("create profile new profile delete profile reorder work personal drag switch profiles profile settings"),
    row("profiles.name", Profiles, "This profile", "Name", Control::Custom(C::ProfileName))
        .keys("profile name rename"),
    row("profiles.icon", Profiles, "This profile", "Icon", Control::Custom(C::ProfileIcon))
        .keys("profile icon emoji symbol"),
    row("profiles.syncThisProfile", Profiles, "This profile", "Sync this profile", Control::Custom(C::ProfileSync))
        .keys("sync profile sync")
        .when(When::SyncOn, "Turn on Sync to use this"),
    row("profiles.profileDownloadsFolder", Profiles, "This profile", "Downloads folder", Control::Custom(C::ProfileDownloadsFolder))
        .keys("download location save to folder")
        .when(When::SeparateDownloads, "Turn on Separate folder for each profile in General"),
    row("profiles.preloadPages", Profiles, "This profile", "Preload pages", Control::Custom(C::ProfileFlag(Flag::PreloadPages)))
        .explains("Links open faster, but pages you may never visit are fetched too.")
        .keys("preload prerender preconnect prefetch speed faster"),
    row("profiles.siteSettings", Profiles, "This profile", "Site settings", Link(Act::Command(crate::settings::subpages::OPEN_SITES)))
        .says("Permissions, autoplay, notifications and zoom.")
        .keys("camera microphone location popups cookies javascript clear site data website settings site permissions autoplay notifications zoom levels permissions"),
    row("profiles.themeColor", Profiles, "This profile", "Colour", Control::Custom(C::ProfileColour))
        .says("Pick a theme colour and edit it: colours, intensity, blur, noise and direction.")
        .keys("theme theme colour theme color color gradient custom theme custom colour edit theme reset theme intensity pass-through blur noise grain direction tint"),
    row("profiles.searchControlled", Profiles, "Search", "An extension is controlling this setting", Control::Custom(C::SearchControlled))
        .says("To change your default search engine, disable the extension or manage its settings.")
        .when(When::ExtensionSearch, ""),
    row("profiles.searchEngine", Profiles, "Search", "Search engine", Control::Custom(C::SearchEngine))
        .says("Used by the command bar and the New Tab page.")
        .keys("google duckduckgo bing kagi ecosia default search engine"),
    row("profiles.otherEngines", Profiles, "Search", "Other search engines", Link(Act::Command(crate::settings::subpages::OPEN_OTHER_ENGINES)))
        .says("Type a shortcut and press Tab to search a site directly.")
        .keys("custom search site search keyword"),
    row("profiles.suggestWhileTyping", Profiles, "Search", "Suggest while typing", Checklist(SUGGEST))
        .explains("Searches and pages from your history.")
        .keys("autocomplete show search suggestions history visited pages browsing history command bar omnibox search suggestions history suggestions"),
    row("profiles.showSelectionSearch", Profiles, "Search", "Search button on selected text", Toggle("showSelectionSearch"))
        .says("Shows a Search button over text you select.")
        .keys("selection selected text popover popup highlight show search button when selecting text"),
    row("profiles.passwordManager", Profiles, "Passwords and autofill", "Password manager", Control::Custom(C::PasswordManager))
        .says("Ardia's own, a plugin, or none for an extension.")
        .keys("password manager passwords app passkeys verification codes"),
    row("profiles.offerToSavePasswords", Profiles, "Passwords and autofill", "Save and fill passwords", Control::Custom(C::ProfileFlag(Flag::PasswordsOffered)))
        .says("Offers to save logins and fills saved ones.")
        .keys("password manager logins credentials keychain"),
    row("profiles.passwords", Profiles, "Passwords and autofill", "Passwords", Link(Act::Command(crate::settings::subpages::OPEN_PASSWORDS)))
        .says("Saved passwords, import and export.")
        .keys("csv logins import passwords backup export passwords saved passwords never saved 1password bitwarden password manager"),
    row("profiles.addresses", Profiles, "Passwords and autofill", "Save and fill addresses", Control::Custom(C::ProfileFlag(Flag::AddressesAutofilled)))
        .says("Names, addresses, email addresses and phone numbers.")
        .keys("forms contact phone email add address addresses"),
    row("profiles.savedAddresses", Profiles, "Passwords and autofill", "Saved addresses", Link(Act::Command(crate::settings::subpages::OPEN_ADDRESSES)))
        .says("Names, addresses, email addresses and phone numbers.")
        .keys("edit address add address contact phone email autofill"),
    row("profiles.cards", Profiles, "Passwords and autofill", "Save and fill cards", Control::Custom(C::ProfileFlag(Flag::CardsAutofilled)))
        .explains("Showing or filling a card asks for Touch ID or your login password.")
        .keys("payment debit card forms save and fill credit cards credit cards"),
    row("profiles.savedCards", Profiles, "Passwords and autofill", "Saved cards", Link(Act::Command(crate::settings::subpages::OPEN_CARDS)))
        .keys("edit card add card payment credit card debit card autofill"),
    row("profiles.extensions", Profiles, "Extensions", "Installed extensions", Control::Custom(C::InstalledExtensions))
        .says("From the Chrome Web Store. Each profile has its own.")
        .keys("add ons plugins installed extensions install extension url add from a link developer mode load unpacked extension"),
    row("profiles.webStore", Profiles, "Extensions", "Get extensions", Button("Open Web Store", Act::Url("https://chromewebstore.google.com")))
        .says("Add to Ardia installs into this profile.")
        .keys("install extension chrome web store"),
    row("profiles.exportBookmarks", Profiles, "Data", "Export bookmarks", Control::Custom(C::ExportBookmarks))
        .says("As an HTML file any browser can import.")
        .keys("backup html netscape bookmarks.html save bookmarks transfer"),
    row("profiles.clearBrowsingData", Profiles, "Data", "Clear browsing data", Button("Clear…", Act::Command("clearBrowsingData")))
        .explains("History, cookies, site data and cached files for this profile.")
        .keys("clear history cookies cache delete data"),
    row("profiles.deleteProfile", Profiles, "Data", "Delete profile", Button("Delete…", Act::DeleteProfile))
        .explains("Removes its tabs, history, bookmarks and site data."),
    row("profiles.defaultProfile", Profiles, "All profiles", "Default profile", Control::Custom(C::DefaultProfile))
        .says("Used for new windows.")
        .keys("new window"),
    row("profiles.showProfileDots", Profiles, "All profiles", "Show the profile switcher in the sidebar", Toggle("showProfileDots"))
        .explains("A dot for each profile, or its icon if you gave it one.")
        .keys("dots pager profile switcher page dots sidebar footer hide show profile dots spaces space icons profile dots switcher emoji symbol arc profile icons"),
    row("profiles.shareTopApps", Profiles, "All profiles", "Share Top Apps", Note)
        .keys("pinned tabs favorites essentials spaces shared"),
    row("profiles.spacesFollowAppearance", Profiles, "All profiles", "Profile colors follow the theme", Toggle("spacesFollowAppearance"))
        .explains("Every profile follows this, whatever its theme says.")
        .keys("space profile theme arc theme follow system profile themes follow this appearance"),
    row("tabs.layout", Tabs, "Layout", "Tab layout", Control::Custom(C::TabLayout))
        .says("In the sidebar or across the top.")
        .keys("vertical tabs horizontal tabs top tabs sidebar"),
    row("tabs.autoHideTabs", Tabs, "Layout", "Auto-hide tabs", Toggle("autoHideTabs"))
        .explains("Tabs slide away until you point at the edge.")
        .keys("hide tabs hide sidebar show sidebar toggle sidebar sidebar shortcut cmd s hide tab bar tab strip top tabs focus mode full screen zen window edge slide"),
    row("tabs.sidebarSide", Tabs, "Layout", "Sidebar position", Segmented("sidebarSide", SIDEBAR_SIDES))
        .says("Left, like Dia, or right, like Arc.")
        .keys("right left side position flip mirror sidebar on the right right sidebar arc")
        .when(When::Sidebar, ""),
    row("tabs.buttons", Tabs, "Layout", "Buttons", Control::Custom(C::Buttons))
        .explains("Hide Tabs and Clear in the sidebar.")
        .keys("toggle sidebar sidebar button hide tabs button show the hide tabs button clear unpinned tabs close all tabs clear today divider arc show clear button clear button"),
    row("tabs.hideToolbarWhileScrolling", Tabs, "Layout", "Hide toolbar while scrolling", CardChoice("hideToolbarWhileScrolling", SCROLL_TOOLBAR))
        .says("Scrolling down shrinks the toolbar to a thin strip.")
        .keys("hide toolbar auto hide toolbar toolbar hides address bar hides collapse compact scroll shrink shrinking"),
    row("tabs.badges", Tabs, "Tabs and Top Apps", "Badges", Control::Custom(C::Badges))
        .explains("Unread counts on tabs, and playing or muted on Top Apps.")
        .keys("unread badge badges bubble count notification notifications dot red gmail inbox messages arc show unread counts on tabs pinned tiles favorites indicators speaker audio muted playing tab status"),
    row("tabs.sleepingTabs", Tabs, "Tabs and Top Apps", "Sleeping and unloaded tabs", Control::Custom(C::SleepingTabs))
        .says("How tabs whose page isn't loaded look.")
        .keys("unloaded asleep sleeping discarded dim grey gray inactive fade icons of unloaded tabs strikethrough strike line through crossed out memory saver strike through sleeping tabs fade"),
    row("tabs.keepTopAppsRunning", Tabs, "Tabs and Top Apps", "Keep Top Apps running when closed", Toggle("keepTopAppsRunning"))
        .explains("⌘W switches away but keeps the page loaded for notifications.")
        .keys("top apps pinned tiles favorites essentials cmd w close unload keep loaded keep running background arc notifications still arrive"),
    row("tabs.closedTopAppTiles", Tabs, "Tabs and Top Apps", "Draw tiles for closed Top Apps", Toggle("closedTopAppTiles"))
        .explains("Off, Top Apps that aren't open show a faded icon.")
        .keys("pinned tiles favorites top apps tile tiles background closed open unloaded faded contrast"),
    row("tabs.balancedTopApps", Tabs, "Tabs and Top Apps", "Grow Top Apps as the sidebar widens", Toggle("balancedTopApps"))
        .explains("Up to four per row, sized to the sidebar, like Arc.")
        .keys("pinned tiles favorites grid columns rows arc")
        .when(When::Sidebar, ""),
    row("tabs.topAppFolders", Tabs, "Tabs and Top Apps", "Make folders in Top Apps", Toggle("topAppFolders"))
        .explains("Hold one Top App over another to make a folder.")
        .keys("folder folders top apps pinned tiles favorites group tile folder stack"),
    row("tabs.tabReorderHaptics", Tabs, "Tabs and Top Apps", "Haptic feedback when reordering tabs", Toggle("tabReorderHaptics"))
        .says("The trackpad ticks as a dragged tab moves to a new place or over another window.")
        .keys("haptic haptics trackpad force touch tick vibration feedback drag reorder move tabs"),
    row("tabs.swipeBetweenTabs", Tabs, "Tabs and Top Apps", "Swipe between tabs", Toggle("swipeBetweenTabs"))
        .says("Swipe with two fingers on the address bar to change tabs.")
        .keys("swipe gesture trackpad two fingers next tab previous tab toolbar address bar scroll left right"),
    row("tabs.showTabHoverMenu", Tabs, "Tabs and Top Apps", "Show tab hover menu", Toggle("showTabHoverMenu"))
        .says("Rest on a tab to see its address and quick actions.")
        .keys("hover hover card popup pop-up tooltip tab actions reset distracting dia"),
    row("tabs.showFullUrlInTabHoverMenu", Tabs, "Tabs and Top Apps", "Show full address in tab hover menu", Toggle("showFullUrlInTabHoverMenu"))
        .says("Off, it shows only the domain.")
        .keys("hover hover card popup url address link domain full url path"),
    row("tabs.autoPictureInPicture", Tabs, "Tabs and Top Apps", "Automatic Picture in Picture", Toggle("autoPictureInPicture"))
        .says("Videos and calls pop out when you switch tabs or leave the window.")
        .keys("pip video floating mini player"),
    row("tabs.playingNowAcrossProfiles", Tabs, "Tabs and Top Apps", "Keep Playing now across profiles", Toggle("playingNowAcrossProfiles"))
        .explains("Media playing in one profile shows in every profile's sidebar.")
        .keys("playing now now playing media card media controls sidebar player music spotify youtube spaces every profile"),
    row("tabs.videoUpscaling", Tabs, "Tabs and Top Apps", "Video upscaling", Toggle("videoUpscaling"))
        .says("Sharpens low-resolution video in the tab you're watching, on Apple silicon.")
        .keys("super resolution sharpen video quality"),
    row("tabs.newTabOpens", Tabs, "New tabs", "New tab opens", Control::Custom(C::NewTabOpens))
        .says("Command Bar opens over the page when you press ⌘T, like Arc.")
        .keys("new tab page command bar cmd t"),
    row("tabs.newTabUrl", Tabs, "New tabs", "Custom address", Control::Custom(C::NewTabUrl))
        .explains("A page to open instead of the New Tab page. Leave empty for the default.")
        .keys("custom new tab new tab url home page homepage start page custom url cmd t new tab page address")
        .when(When::NewTabPage, "Set New tab opens to New Tab page"),
    row("tabs.newTabPosition", Tabs, "New tabs", "Add new tabs", Control::Custom(C::NewTabPosition))
        .says("Where ⌘T puts the new tab.")
        .keys("new tab position next to current tab after current tab beside right of below adjacent end left top bottom order cmd t new tab button plus position"),
    row("tabs.showTabMenuButton", Tabs, "New tabs", "Show tab menu button", Toggle("showTabMenuButton"))
        .says("Use the chevron next to New Tab to see open tabs and reopen closed ones.")
        .keys("overflow menu hide chevron new tab arrow"),
    row("tabs.appLinksFirst", Tabs, "New tabs", "Put links from other apps first", Toggle("appLinksFirst"))
        .explains("They go to the top, just below your pinned tabs.")
        .keys("external links other apps default browser top first left position"),
    row("tabs.shareTabsAcrossWindows", Tabs, "New tabs", "Share tabs across windows", Toggle("shareTabsAcrossWindows"))
        .explains("Every window shows the same tabs, like Arc.")
        .keys("arc multiple windows same tabs sync windows shared sidebar unpinned"),
    row("tabs.openLinksInLittleArdia", Tabs, "Links", "Open links from other apps in Little Ardia", Control::Custom(C::LinksInLittleArdia))
        .keys("little ardia little arc arc little window small window mini window external links links from other apps open links discord slack mail messages"),
    row("tabs.littleArdiaOpensNewTabLinks", Tabs, "Links", "Keep new-tab links inside a Little Ardia window", Toggle("littleArdiaOpensNewTabLinks"))
        .explains("New-tab links load in place. ⌘-click still opens behind.")
        .keys("target blank new tab links inside little ardia load right there behind command click"),
    row("tabs.littleArdiaShortcutFromAnyApp", Tabs, "Links", "Shortcut opens Little Ardia from other apps", Toggle("littleArdiaShortcutFromAnyApp"))
        .explains("Its shortcut works while another app is in front.")
        .keys("global shortcut global hotkey hotkey shortcut any app other apps system wide option command n new little ardia window in front"),
    row("tabs.peekLinksToOtherSites", Tabs, "Links", "Links to other sites open in", Control::Custom(C::PeekOtherSites))
        .explains("From Top Apps and pinned tabs.")
        .keys("peek preview external links other sites pinned pinned tabs top apps favorites glance arc zen gmail target blank"),
    row("tabs.newTabLinksOpenIn", Tabs, "Links", "Links that would open a new tab", Popup("newTabLinksOpenIn", NEW_TAB_LINKS))
        .explains("When you click a link that would open a new tab.")
        .keys("peek new tab target blank links preview open links open new-tab links in"),
    row("tabs.popupsOpenAsTabs", Tabs, "Links", "Open pop-ups as tabs", Toggle("popupsOpenAsTabs"))
        .explains("Pop-up windows from pages open as tabs instead.")
        .keys("popup pop-up pop up window.open new window outlook sign in oauth as tab links"),
    row("tabs.peekButtons", Tabs, "Links", "Show Peek buttons", Popup("peekButtons", PEEK_BUTTONS))
        .explains("Close, Open as Tab and Split View, in the title bar or beside it.")
        .keys("peek buttons close expand split view left right side position arc zen glance open as tab title bar float beside"),
    row("tabs.cleanUp", Tabs, "Clean up", "Close unused tabs after", Control::Custom(C::CleanUp))
        .says("Closes tabs you haven't used in this long.")
        .keys("archive auto close inactive tabs duplicates custom minutes clean up tabs i haven't used in"),
    row("tabs.suggestCleanUp", Tabs, "Clean up", "Suggest a clean-up", Toggle("suggestCleanUp"))
        .says("Shows a card once 10 or more tabs go unused.")
        .keys("upsell tidy suggestion don't show again card inactive tabs suggest cleaning up when tabs pile up")
        .when(When::NeverCleansUp, "Set Close unused tabs after to Never"),
    row("tabs.tidyTabs", Tabs, "Clean up", "Tidy Tabs", Toggle("tidyTabs"))
        .explains("Groups tabs by site once you have more than six.")
        .keys("tidy broom organize tabs group by site clean up arc max")
        .when(When::Sidebar, ""),
    row("appearance.theme", Appearance, "Look", "Theme", CardChoice("appearance", MODES))
        .says("Incognito windows are always dark.")
        .keys("appearance dark mode light mode dark light automatic night system"),
    row("appearance.interfaceStyle", Appearance, "Look", "Interface style", CardChoice("interfaceStyle", STYLES))
        .says("Glass uses Liquid Glass. Classic is flat, like Dia.")
        .keys("liquid glass glass classic flat translucent transparency glow frosted")
        .when(When::GlassAvailable, ""),
    row("appearance.glassTint", Appearance, "Look", "Glass tint", Control::Custom(C::GlassTint))
        .says("How much the profile color tints the glass.")
        .keys("liquid glass tint strength intensity colour color glossy tint amount profile colour theme tint glass with the profile colour")
        .when(When::Glass, "Choose the Glass style to use this"),
    row("appearance.elementOutlines", Appearance, "Look", "Outlines around tiles and fields", Toggle("elementOutlines"))
        .explains("Off is flatter, like Arc.")
        .keys("outline outlines border borders edge stroke ring flat arc pinned tiles top apps address field clean"),
    row("appearance.extendWebsiteColor", Appearance, "Look", "Extend website color into tab bar", Toggle("extendWebsiteColor"))
        .keys("theme color tint colour"),
    row("appearance.selectedTabGlow", Appearance, "Look", "Glow around the selected tab", Popup("selectedTabGlow", GLOWS))
        .says("Full is Dia's.")
        .keys("glow shadow halo highlight selected tab active tab"),
    row("appearance.selectedTopApp", Appearance, "Look", "Selected Top App", Popup("selectedTopApp", SELECTED_TOP_APP))
        .says("How the selected pinned tile looks.")
        .keys("ring outline outlined border fill filled top apps pinned tile pinned tab selected tile active tile white ring classic")
        .when(When::Outlines, ""),
    row("appearance.appIcon", Appearance, "Look", "App Icon", Control::Custom(C::AppIcon))
        .says("Shown in the Dock and the app switcher.")
        .keys("dock icon logo")
        .when(When::AppIcons, ""),
    row("appearance.interfaceScale", Appearance, "Size and text", "Interface size", Control::Custom(C::InterfaceSize))
        .explains("Resizes Ardia, not web pages.")
        .keys("scale scaling ui scale ui size interface scale zoom zoom interface fractional scaling 1440p 4k high resolution retina bigger smaller larger display monitor density accessibility low vision"),
    row("appearance.sidebarTextSize", Appearance, "Size and text", "Sidebar text size", Popup("sidebarTextSize", SIDEBAR_TEXT_SIZES))
        .says("Titles and icons in the sidebar.")
        .keys("bigger text larger text large text text size small text readability readable low vision accessibility a11y tab titles arc")
        .when(When::Sidebar, NEEDS_SIDEBAR),
    row("appearance.sidebarTextContrast", Appearance, "Size and text", "Higher contrast text", Control::Custom(C::HighContrast))
        .says("Stronger text and icons in the sidebar.")
        .keys("contrast high contrast increase contrast grey text gray text light text faint readability readable low vision accessibility a11y wcag bold")
        .when(When::Sidebar, NEEDS_SIDEBAR),
    row("appearance.ctrlTab", Appearance, "Switching tabs", "⌃Tab goes to", CardChoice("tabSwitcherOrder", SWITCHER_ORDERS))
        .says("Your most recent tabs first, or the next tab down the list.")
        .keys("ctrl tab control tab alt tab tab switcher switch tabs switching tabs recent tabs recently used last tab previous tab next tab cycle tabs mru in order order tabbing arc dia chrome"),
    row("appearance.tabSwitcherView", Appearance, "Switching tabs", "Tab switcher shows", CardChoice("tabSwitcherView", SWITCHER_VIEWS))
        .says("Page previews, a compact list of titles, or nothing at all while you switch.")
        .keys("tab switcher switcher compact list list thumbnails previews page previews pictures overlay hud none ctrl tab control tab"),
    row("appearance.afterClosingTab", Appearance, "Switching tabs", "After closing a tab", Control::Custom(C::AfterClosing))
        .says("Go back to the previously active tab, or to the tab above or below (to the left or right across the top).")
        .keys("close tab closing closing tab closing a tab tab closing tab close after closing after close close behavior close behaviour cmd w next tab previous tab tab above tab to the left tab below tab to the right neighbour neighbor adjacent adjacent tab last used previously active focus select activate mru arc chrome firefox"),
    row("appearance.addressBar", Appearance, "Toolbar", "Address bar", CardChoice("addressBar", ADDRESS_BAR))
        .says("In the toolbar or in the sidebar.")
        .keys("url bar location bar toolbar address bar address field omnibox url field address bar in sidebar arc dia")
        .when(When::Sidebar, NEEDS_SIDEBAR),
    row("appearance.commandBarPlacement", Appearance, "Toolbar", "⌘L opens the command bar", Control::Custom(C::CommandBarPlacement))
        .explains("Shows the address over the middle of the page, like Arc.")
        .keys("cmd l command l ctrl l command bar command palette centred centered middle floating arc url bar location bar click click address click url"),
    row("appearance.commandBarOnClick", Appearance, "Toolbar", "Clicking the address opens it in the center too", Control::Custom(C::CommandBarOnClick))
        .keys("click address click url centred on click command bar on click")
        .when(When::CentredCommandBar, "Choose In the center for ⌘L to use this"),
    row("appearance.compactToolbar", Appearance, "Toolbar", "Compact toolbar", Toggle("compactToolbar"))
        .explains("A shorter toolbar, so pages get more room.")
        .keys("toolbar height smaller toolbar thin toolbar slim dense helium video 16:9 black bars url bar")
        .when(When::ToolbarAddress, "Put the address bar in the toolbar to use this"),
    row("appearance.addressBarButtons", Appearance, "Toolbar", "Address bar buttons", Popup("addressBarButtons", ADDRESS_BAR_BUTTONS))
        .explains("Show on hover hides them until you point at the address bar.")
        .keys("hover always show always visible site controls split view bookmark copy url buttons icons extensions pinned extensions clean arc url bar location bar"),
    row("appearance.minimalismMode", Appearance, "Toolbar", "Minimalism mode", Toggle("minimalismMode"))
        .explains("Just tabs and the page, no toolbar. ⌃⌘M toggles it.")
        .keys("minimal minimalism minimalist clean compact zen simple distraction free no toolbar hide toolbar search browser quiet focus"),
    row("appearance.minimalismPinnedIcons", Appearance, "Toolbar", "Minimalism tiles", Popup("minimalismPinnedIcons", MINIMALISM_PINNED_ICONS))
        .explains("Letters or each site’s logo on Top Apps. With Letters, right-click a tile to change its letters.")
        .keys("minimalism minimal letters letter initials logos logo site logos favicons favicon site icons icons top apps tiles")
        .when(When::Minimalism, "Turn on Minimalism mode to use this"),
    row("appearance.bookmarksBar", Appearance, "Toolbar", "Bookmarks bar", Control::Custom(C::BookmarksBar))
        .says("Below the toolbar. ⇧⌘B toggles it.")
        .keys("bookmarks bar favorites bar favourites bar toolbar hide bookmarks show bookmarks show bookmarks bar bookmark button star bookmarks menu copy url arc no bookmarks"),
    row("appearance.pageFrame", Appearance, "Page frame", "Frame around the page", Control::Custom(C::PageFrame))
        .says("0 is borderless.")
        .keys("border borderless edge to edge margin inset padding rounded corners corner radius frame gap full bleed arc compact no borders frameless borderless mode"),
    row("appearance.fullScreenFrame", Appearance, "Page frame", "In full screen", Control::Custom(C::FullScreenFrame))
        .says("Keep the frame, or remove it.")
        .keys("fullscreen full screen borderless edge to edge zero none frame inset margin zero in full screen auto hide autohide sidebar tabs hidden")
        .when(When::Framed, "Set Frame around the page above 0"),
    row("appearance.tabCornerRadius", Appearance, "Page frame", "Tab corners", Control::Custom(C::TabCorners))
        .says("How round tab corners are. 10 pt is Dia's.")
        .keys("corner corners radius rounded round square tab shape tab corners rounded tabs pill"),
    row("automations.calendarAccess", Automations, "Calendar", "Calendar access", Note)
        .keys("connect calendar google calendar outlook icloud"),
    row("automations.meetingAlert", Automations, "Calendar", "Meeting alert", Note)
        .keys("reminder join popup show next meeting alert")
        .when(When::Calendar, NEEDS_CALENDAR),
    row("automations.meetingAlertCondition", Automations, "Calendar", "Show alerts", Note)
        .explains("With Always, alerts also show while you're in another app.")
        .keys("system alerts banner")
        .when(When::Calendar, NEEDS_CALENDAR),
    row("automations.calendarPreview", Automations, "Calendar", "Show calendar preview", Note)
        .says("Hover a pinned calendar tab to see your day.")
        .keys("hover")
        .when(When::Calendar, NEEDS_CALENDAR),
    row("automations.countdown", Automations, "Calendar", "Countdown to next meeting", Note)
        .says("How long before a meeting the badge appears.")
        .keys("countdown minutes lead time next meeting start countdown now dismiss show time to next meeting")
        .when(When::Calendar, NEEDS_CALENDAR),
    row("automations.groupMeetingTabs", Automations, "Calendar", "Group tabs for meetings", Toggle("autoGroupMeetingTabs"))
        .says("Joining a call puts its tabs in a group.")
        .keys("zoom meet call tab groups automatically group tabs for meetings calendar")
        .when(When::Calendar, NEEDS_CALENDAR),
    row("automations.liveFolders", Automations, "Live folders", "Live folders", Note)
        .explains("Right-click the sidebar and choose New Live Folder.")
        .keys("new live folder hidden refresh stack stacked pull requests group stacked pull requests completed merged closed show completed pull requests"),
    row("automations.github", Automations, "Live folders", "GitHub", Note)
        .says("Your pull requests and review requests.")
        .keys("pull requests connect"),
    row("automations.bitbucket", Automations, "Live folders", "Bitbucket", Note)
        .says("Your open pull requests.")
        .keys("pull requests connect"),
    row("automations.notion", Automations, "Live folders", "Notion", Note)
        .says("Recently edited pages.")
        .keys("documents connect"),
    row("automations.confluence", Automations, "Live folders", "Confluence", Note)
        .says("Pages you created, edited or watch.")
        .keys("documents atlassian connect"),
    row("automations.gdrive", Automations, "Live folders", "Google Drive", Note)
        .says("Recently changed documents.")
        .keys("documents docs connect"),
    row("automations.linkRules", Automations, "Link routing", "Rules", Note)
        .explains("The first rule that matches a link decides where it opens.")
        .keys("arc air traffic control atc links from other apps route links open links in profile default browser work profile rule add rule tab group group link rules hooks hooks.json link.opening automation link hooks from hooks.json"),
    row("automations.testLink", Automations, "Link routing", "Test a link", Note)
        .explains("See where a link would open, without opening it.")
        .keys("air traffic control atc test preview check try a link"),
    row("automations.linkFallback", Automations, "Link routing", "Links no rule catches", Note)
        .explains("Where links open when no rule decides.")
        .keys("everything else fallback otherwise air traffic control links from other apps"),
    row("automations.linkFallbackGroup", Automations, "Link routing", "Tab group", Note)
        .says("The group these links join.")
        .keys("everything else fallback tab group group"),
    row("automations.appLinks", Automations, "Link routing", "Apps that open links", Note)
        .explains("Sites that open another app without asking first.")
        .keys("external apps protocol handlers zoom links apps allowed to open links"),
    row("plugins.official", Plugins, "Official", "Official plugins", Control::Custom(C::OfficialPlugins))
        .keys("official plugins built in first party ardia plugins install")
        .when(When::OfficialPlugins, ""),
    row("plugins.cli", Plugins, "Official", "Command Line", Control::Custom(C::OfficialPlugins))
        .says("Drive Ardia from your terminal or an agent.")
        .keys("official plugin built in plugin command line commandline")
        .when(When::OfficialPlugins, ""),
    row("plugins.ai", Plugins, "Official", "AI", Control::Custom(C::OfficialPlugins))
        .says("Chat that can use your tabs, on your Claude plan.")
        .keys("official plugin built in plugin ai")
        .when(When::OfficialAi, ""),
    row("plugins.plugins", Plugins, "Plugins", "Plugins", Control::Custom(C::PluginList))
        .explains("Yours stay off until you turn them on.")
        .keys("plugin add-on addon install plugin ardia plugins"),
    row("shortcuts.ctrlTab", Shortcuts, "Keyboard", "⌃Tab goes to", Control::Custom(C::CtrlTab))
        .keys("ctrl tab control tab tab switcher"),
    row("shortcuts.undoReopensClosedTab", Shortcuts, "Keyboard", "⌘Z reopens closed tabs", Toggle("undoReopensClosedTab"))
        .explains("Outside text fields. In a text field, ⌘Z still undoes typing.")
        .keys("undo undo close tab reopen restore tab arc cmd z"),
    row("shortcuts.menuCommands", Shortcuts, "Keyboard", "Keyboard shortcuts", Control::Custom(C::ShortcutList))
        .keys("shortcuts keyboard shortcuts hotkeys keybindings remap menu shortcuts customize keyboard shortcuts"),
    row("shortcuts.extensionShortcuts", Shortcuts, "Keyboard", "Extension commands", Button("Edit…", Act::Url("chrome://extensions/shortcuts")))
        .says("Shortcuts that extensions add.")
        .keys("hotkeys extension shortcuts"),
    row("shortcuts.peekModifier", Shortcuts, "Clicks", "Peek a link with", Popup("peekModifier", PEEK_WITH))
        .says("Opens the link in a preview over the page.")
        .keys("peek preview shift click option click arc"),
    row("shortcuts.splitLinkModifier", Shortcuts, "Clicks", "Open a link in split view with", Popup("splitLinkModifier", SPLIT_WITH))
        .says("Opens the link in a pane beside the page.")
        .keys("split view split screen side by side option click alt click option shift click download dia"),
    row("shortcuts.cmdClickCreatesTabGroup", Shortcuts, "Clicks", "⌘-clicking links creates tab groups", Toggle("cmdClickCreatesTabGroup"))
        .explains("Puts the link's background tab in a tab group with the page you clicked it on.")
        .keys("command click cmd click control click ctrl click tab group auto group automatic grouping group tabs nested tabs background tab"),
    row("shortcuts.optShiftClickOpensInGroup", Shortcuts, "Clicks", "⌥⇧-click opens tab in group", Toggle("optShiftClickOpensInGroup"))
        .explains("Opens the tab in a group with the current tab.")
        .keys("option shift click split"),
    row("advanced.showFullUrl", Advanced, "Browsing", "Show full URL in the address bar", Toggle("showFullUrl"))
        .says("Instead of the site alone.")
        .keys("address url https"),
    row("advanced.commandScrollZoom", Advanced, "Browsing", "Zoom pages with ⌘-scroll", Toggle("commandScrollZoom"))
        .explains("Sites that use ⌘-scroll themselves, like maps, still get it.")
        .keys("scroll wheel mouse wheel command scroll cmd scroll ctrl scroll mouse zoom wheel zoom accidental zoom page zoom pinch bettermouse"),
    row("advanced.chromeSettings", Advanced, "Browsing", "Chromium settings", Button("Open Chromium Settings", Act::Url("chrome://settings")))
        .explains("Chrome's own settings, for zoom, fonts, languages and more.")
        .keys("chrome://settings zoom page zoom font font size fonts accessibility languages default zoom chrome settings"),
    row("advanced.memorySaver", Advanced, "Performance", "Memory Saver", Control::Custom(C::MemorySaver))
        .explains("How hard Ardia works to free memory.")
        .keys("sleep sleeping tabs tab sleeping discard hibernate memory ram inactive tabs unload suspend performance moderate balanced maximum memory savings profiles launch extensions lazy defer load profiles when opened idle inactive timeout unload inactive profiles"),
    row("advanced.keepActiveSites", Advanced, "Performance", "Keep these sites awake", Control::Custom(C::KeptSites))
        .explains("These sites never go to sleep.")
        .keys("sleep never sleep keep awake exceptions discard hibernate memory saver memory always keep these sites active")
        .when(When::KeptSites, "Turn on Memory Saver to use this"),
    row("advanced.batterySaver", Advanced, "Performance", "Battery Saver", Control::Custom(C::BatterySaver))
        .keys("energy energy saver low power mode performance power"),
    row("advanced.busyTabWarnings", Advanced, "Performance", "Warn about busy background tabs", Toggle("busyTabWarnings"))
        .explains("When a hidden tab keeps the processor busy for 2 minutes.")
        .keys("cpu processor energy power battery busy background tabs high cpu fan hot sleep tab keep running"),
    row("advanced.pageEngine", Advanced, "Web engine", "Open pages in", Control::Custom(C::PageEngine))
        .explains("Unless a website rule says otherwise.")
        .keys("engine webkit chromium safari drm netflix fairplay widevine reset recommended use recommended default")
        .when(When::AutomaticEngine, NEEDS_AUTOMATIC),
    row("advanced.websiteEngines", Advanced, "Web engine", "Engine per site", Control::Custom(C::WebsiteEngines))
        .says("Sites that always open in a chosen engine.")
        .keys("opens in site engine rule webkit chromium website rules drm netflix disney hbo max prime video hulu spotify apple tv apple music fairplay widevine streaming tencent video v.qq.com audible audiobooks canal+ canalplus mycanal youtube tv tv.youtube.com osn+ osnplus anghami open streaming sites in webkit")
        .when(When::AutomaticEngine, NEEDS_AUTOMATIC),
    row("advanced.offerWebKitForProtectedVideo", Advanced, "Web engine", "Offer WebKit when a video won't play", Toggle("offerWebKitForProtectedVideo"))
        .explains("When a Chromium page can't play protected video, Ardia offers to open it in WebKit.")
        .keys("drm protected video prompt open in webkit fairplay streaming stay on page drm prompt")
        .when(When::AutomaticEngine, NEEDS_AUTOMATIC),
    row("advanced.engineSwitchKeepsPage", Advanced, "Switching engines", "Keep the page on screen while it switches", Toggle("engineSwitchKeepsPage"))
        .explains("The old page stays up until the other engine draws it, up to 3 seconds.")
        .keys("seamless swap flash blank reload scroll position same scroll position switch engine switching engines open in webkit open in chromium 3 seconds drawn")
        .when(When::WebKitOffered, ""),
    row("advanced.engineSwitchAsksAboutUnsavedWork", Advanced, "Switching engines", "Ask before reloading a page you've typed in", Toggle("engineSwitchAsksAboutUnsavedWork"))
        .explains("Switching engines reloads the page, which can lose unsent text.")
        .keys("unsaved form input confirm warn stay on page switch engine switching engines text you haven't sent lost")
        .when(When::WebKitOffered, ""),
    row("advanced.engineSwitchCarriesSiteData", Advanced, "Switching engines", "Bring sign-ins along", Toggle("engineSwitchCarriesSiteData"))
        .explains("A switching page takes its cookies along, so you stay signed in.")
        .keys("bring sign-ins cookies site data sign in logged out local storage session switch engine separate sign-ins saved data stay signed in")
        .when(When::WebKitOffered, ""),
    row("advanced.webKitFraudWarnings", Advanced, "WebKit pages", "Warn about fraudulent websites", Toggle("webKitFraudWarnings"))
        .explains("WebKit pages warn before a deceptive site opens.")
        .keys("safe browsing phishing malware fraud deceptive security warning google tencent safe browsing lists addresses")
        .when(When::WebKitInUse, NEEDS_WEBKIT),
    row("advanced.enginesDiffer", Advanced, "WebKit pages", "How engines differ", Link(Act::Command("settings:sub:engines:differ")))
        .explains("Sign-ins, passkeys, and what WebKit pages can't do.")
        .keys("cookies site data sign in logged out separate sign-ins extensions ad blocker ublock content blocker passkey webauthn icloud keychain passwords app security key passkeys widevine streaming webkit limitations limitations not supported unsupported passkeys security keys picture in picture client hints midi casting chromecast chrome.debugger webrequest removeparam about engines how automatic works")
        .when(When::WebKitInUse, NEEDS_WEBKIT),
    row("advanced.programControl", Advanced, "Command line and automation", "Let programs control Ardia", Toggle("cliControl"))
        .explains("Programs like the ardia command can act in your signed-in pages.")
        .keys("control cli automation agent stop turn control back on devtools remote debugging control pill let the ardia command control ardia programs you run open read logins ardia command"),
    row("advanced.allowedPrograms", Advanced, "Command line and automation", "Programs you let in", Control::Custom(C::AllowedPrograms))
        .explains("A program that isn't part of Ardia asks before it can control Ardia. The ones you allowed for 30 minutes or always are listed here.")
        .keys("control socket allow always allow doorbell revoke programs agent script python cli permission"),
    row("advanced.programs", Advanced, "Command line and automation", "Programs on your PATH", Control::Custom(C::Programs))
        .keys("cli command line terminal shell path programs commands plugin programs try again relink"),
    row("advanced.showCliPill", Advanced, "Command line and automation", "Show the control pill", Toggle("showCliPill"))
        .explains("Shows who is controlling Ardia at the bottom of the page with a Stop button. You can still stop programs above.")
        .keys("cli control pill is controlling agent claude code codex hide dismiss turn off banner indicator stop"),
    row("advanced.compactCliPill", Advanced, "Command line and automation", "Show the control pill as an icon and Stop", Toggle("compactCliPill"))
        .explains("While a program drives Ardia, the pill shows just an icon and Stop.")
        .keys("cli control pill is controlling agent claude code codex hide smaller compact minimize indicator stop"),
    row("advanced.automationRules", Advanced, "Command line and automation", "Automation rules", Note)
        .explains("Rules from hooks.json and config.json stay off until you approve them.")
        .keys("hooks hooks.json approve launchactions address bar providers rules"),
];

pub fn keep_active_site_of(typed: &str) -> String {
    let text = typed.trim();
    let (scheme, rest) = match text.find("://") {
        Some(at)
            if at > 0
                && text[..at]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
                && text[..1].chars().all(|c| c.is_ascii_alphabetic()) =>
        {
            (text[..at + 3].to_lowercase(), &text[at + 3..])
        }
        _ => (String::new(), text),
    };
    let split = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (host, tail) = rest.split_at(split);
    let tail = if tail == "/" { "" } else { tail };
    format!("{scheme}{}{tail}", host.to_lowercase())
}

pub fn keep_active_site_valid(site: &str) -> bool {
    if site.is_empty() || site.chars().any(char::is_whitespace) {
        return false;
    }
    let host = site.split("://").last().unwrap_or(site);
    let host = host.split(['/', '?', '#', ':']).next().unwrap_or("");
    let host = host.trim_start_matches("[*.]").trim_start_matches("*.");
    !host.is_empty()
        && (host.contains('.') || host == "localhost")
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._".contains(c) || !c.is_ascii())
}

pub fn custom_new_tab_url(typed: &str) -> Option<String> {
    ardia_state::new_tab_home::home_address(typed)
}

pub fn rows_for(pane: Pane) -> impl Iterator<Item = &'static Row> {
    ROWS.iter().filter(move |row| row.pane == pane)
}

pub const SETTING_ALIASES: &[(&str, &str)] = &[("plugins.commandLine", "plugins.cli")];

pub fn resolve_id(id: &str) -> &str {
    SETTING_ALIASES
        .iter()
        .find(|(alias, _)| *alias == id)
        .map_or(id, |(_, target)| target)
}

pub fn find(id: &str) -> Option<&'static Row> {
    let id = resolve_id(id);
    ROWS.iter().find(|row| row.id == id)
}

fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !(c.is_alphanumeric() || "⌘⌥⇧⌃".contains(c)))
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
}

fn starts_a_word(text: &str, word: &str) -> bool {
    words(text).any(|candidate| candidate.starts_with(word))
}

pub fn tier(row: &Row, query: &str) -> Option<u8> {
    let wanted: Vec<String> = words(query).collect();
    if wanted.is_empty() {
        return None;
    }
    let fields = [
        row.title,
        row.section,
        row.pane.title(),
        row.keywords,
        row.description,
    ];
    let mut best = 0u8;
    for word in &wanted {
        let at = fields.iter().position(|field| starts_a_word(field, word))?;
        best = best.max(at as u8);
    }
    Some(best)
}

pub fn match_ranges(text: &str, query: &str) -> Vec<std::ops::Range<usize>> {
    let wanted: Vec<String> = words(query).collect();
    let mut out = Vec::new();
    let mut start = None;
    let push = |begin: usize, end: usize, out: &mut Vec<std::ops::Range<usize>>| {
        let word = text[begin..end].to_lowercase();
        if let Some(found) = wanted.iter().filter(|w| word.starts_with(w.as_str())).map(|w| w.len()).max() {
            let mut cut = begin;
            let mut seen = 0;
            for (offset, c) in text[begin..end].char_indices() {
                if seen >= found {
                    break;
                }
                seen += c.to_lowercase().map(char::len_utf8).sum::<usize>();
                cut = begin + offset + c.len_utf8();
            }
            out.push(begin..cut);
        }
    };
    for (at, c) in text.char_indices() {
        let word_char = c.is_alphanumeric() || "⌘⌥⇧⌃".contains(c);
        match (word_char, start) {
            (true, None) => start = Some(at),
            (false, Some(begin)) => {
                push(begin, at, &mut out);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(begin) = start {
        push(begin, text.len(), &mut out);
    }
    out
}

pub fn keyword_note(row: &Row, query: &str) -> Option<(String, Vec<std::ops::Range<usize>>)> {
    let wanted: Vec<String> = words(query).collect();
    if wanted.is_empty() {
        return None;
    }
    let shown = [row.title, row.section, row.pane.title()];
    let covered = wanted
        .iter()
        .all(|word| shown.iter().any(|field| starts_a_word(field, word)));
    if covered {
        return None;
    }
    let phrases = crate::settings::keyword_phrases::phrases(row.id)?;
    let phrase = phrases.iter().find(|phrase| {
        wanted
            .iter()
            .any(|word| !shown.iter().any(|field| starts_a_word(field, word)) && starts_a_word(phrase, word))
    })?;
    let ranges = match_ranges(phrase, query);
    let prefix = "Also called \u{201c}";
    let shift = prefix.len();
    Some((
        format!("{prefix}{phrase}\u{201d}"),
        ranges
            .into_iter()
            .map(|range| range.start + shift..range.end + shift)
            .collect(),
    ))
}

pub fn matches(row: &Row, query: &str) -> bool {
    query.trim().is_empty() || tier(row, query).is_some()
}

pub fn search(query: &str, settings: &Settings) -> Vec<&'static Row> {
    search_in(query, settings, &System::default())
}

type RowWords = [Vec<String>; 5];

fn row_words() -> &'static [RowWords] {
    static WORDS: std::sync::OnceLock<Vec<RowWords>> = std::sync::OnceLock::new();
    WORDS.get_or_init(|| {
        ROWS.iter()
            .map(|row| {
                [
                    row.title,
                    row.section,
                    row.pane.title(),
                    row.keywords,
                    row.description,
                ]
                .map(|field| words(field).collect())
            })
            .collect()
    })
}

fn tier_of(fields: &RowWords, wanted: &[String]) -> Option<u8> {
    if wanted.is_empty() {
        return None;
    }
    let mut best = 0u8;
    for word in wanted {
        let at = fields
            .iter()
            .position(|field| field.iter().any(|candidate| candidate.starts_with(word.as_str())))?;
        best = best.max(at as u8);
    }
    Some(best)
}

pub fn search_in(query: &str, settings: &Settings, system: &System) -> Vec<&'static Row> {
    let wanted: Vec<String> = words(query).collect();
    let fields = row_words();
    let mut hits: Vec<(u8, usize, &'static Row)> = ROWS
        .iter()
        .enumerate()
        .filter(|(_, row)| row.shown_in(settings, system) || !row.needs.is_empty())
        .filter_map(|(index, row)| tier_of(&fields[index], &wanted).map(|tier| (tier, index, row)))
        .collect();
    hits.sort_by_key(|(tier, index, _)| (*tier, *index));
    hits.into_iter().map(|(_, _, row)| row).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_sites_read_like_the_old_memory_saver() {
        assert_eq!(keep_active_site_of("  YouTube.com/ "), "youtube.com");
        assert_eq!(
            keep_active_site_of("HTTPS://Mail.Google.com/a"),
            "https://mail.google.com/a"
        );
        assert!(keep_active_site_valid("youtube.com"));
        assert!(keep_active_site_valid("[*.]example.com"));
        assert!(keep_active_site_valid("localhost"));
        assert!(!keep_active_site_valid("not a site"));
        assert!(!keep_active_site_valid(""));
        assert!(!keep_active_site_valid("nodots"));
    }

    #[test]
    fn custom_new_tab_addresses_must_open_as_a_tab() {
        assert_eq!(
            custom_new_tab_url("example.com").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(custom_new_tab_url("about:blank").as_deref(), Some("about:blank"));
        assert!(custom_new_tab_url("javascript:alert(1)").is_none());
        assert!(custom_new_tab_url("").is_none());
    }

    #[test]
    fn matched_word_starts_are_marked() {
        assert_eq!(match_ranges("Frame around the page", "fra pa"), vec![0..3, 17..19]);
        assert!(match_ranges("Frame", "zz").is_empty());
    }

    #[test]
    fn keyword_hits_name_the_old_phrase() {
        let row = find("tabs.littleArdiaShortcutFromAnyApp").expect("row");
        let (note, ranges) = keyword_note(row, "new little").expect("a note");
        assert_eq!(note, "Also called \u{201c}new little ardia window\u{201d}");
        let marked: Vec<&str> = ranges.iter().map(|range| &note[range.clone()]).collect();
        assert_eq!(marked, ["new", "little"]);
        assert!(keyword_note(find("appearance.pageFrame").expect("row"), "frame").is_none());
    }

    #[test]
    fn panes_follow_the_old_sidebar() {
        let titles: Vec<&str> = Pane::ALL.iter().map(|pane| pane.title()).collect();
        assert_eq!(
            titles,
            [
                "General",
                "Profiles",
                "Tabs",
                "Appearance",
                "Automations",
                "Plugins",
                "Shortcuts",
                "Advanced"
            ]
        );
        assert_eq!(Pane::SiteSettings, Pane::Profiles);
        assert_eq!(Pane::Privacy, Pane::General);
    }

    #[test]
    fn every_pane_has_rows_and_every_key_is_a_real_setting() {
        let settings = Settings::default();
        for pane in Pane::ALL {
            assert!(rows_for(pane).next().is_some(), "{pane:?}");
        }
        let mut ids = std::collections::HashSet::new();
        for row in ROWS {
            assert!(ids.insert(row.id), "{} twice", row.id);
            assert!(
                row.id.starts_with(&row.pane.title().to_lowercase()),
                "{}",
                row.id
            );
            let keys: Vec<&str> = match row.control {
                Control::Toggle(key)
                | Control::Popup(key, _)
                | Control::Segmented(key, _)
                | Control::Cards(key, _) => vec![key],
                Control::Checklist(items) => items.iter().map(|(key, _)| *key).collect(),
                _ => vec![],
            };
            for key in keys {
                assert!(settings.get(key).is_some(), "{key} is not a setting");
            }
        }
    }

    #[test]
    fn rows_of_a_section_stay_together() {
        for pane in Pane::ALL {
            let mut seen: Vec<&str> = Vec::new();
            for row in rows_for(pane) {
                if seen.last() != Some(&row.section) {
                    assert!(!seen.contains(&row.section), "{} split", row.section);
                    seen.push(row.section);
                }
            }
        }
    }

    #[test]
    fn search_ranks_titles_first_and_hides_unavailable_rows() {
        let settings = Settings::default();
        let hits = search("frame", &settings);
        assert_eq!(hits.first().map(|row| row.id), Some("appearance.pageFrame"));
        assert!(search("zzzz-nothing", &settings).is_empty());
        assert!(search("", &settings).is_empty());
        assert_eq!(
            search("ublock", &settings).first().map(|row| row.id),
            Some("general.blockAds")
        );
        assert!(
            search("dark", &settings)
                .iter()
                .any(|row| row.id == "appearance.theme")
        );
        assert!(
            search("borderless", &settings)
                .iter()
                .any(|row| row.id == "appearance.pageFrame")
        );
    }

    #[test]
    fn hidden_rows_still_turn_up_in_search_with_what_they_need() {
        let settings = Settings {
            minimalism_mode: false,
            ..Settings::default()
        };
        let tiles = find("appearance.minimalismPinnedIcons").expect("row");
        assert!(!tiles.shown(&settings));
        assert!(
            search("minimalism tiles", &settings)
                .iter()
                .any(|row| row.id == tiles.id)
        );
        let top = Settings {
            tab_layout: ardia_state::model::TabLayout::Top,
            ..Settings::default()
        };
        assert!(!find("tabs.sidebarSide").expect("row").shown(&top));
    }
}
