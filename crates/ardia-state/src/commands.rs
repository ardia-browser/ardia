use crate::macros::string_enum;

string_enum!(Command {
    NewTab = "newTab",
    NewWindow = "newWindow",
    NewIncognitoWindow = "newIncognitoWindow",
    NewLittleArdia = "newLittleArdia",
    ToggleOpenLinksInLittleArdia = "toggleOpenLinksInLittleArdia",
    ReopenClosedTab = "reopenClosedTab",
    ReopenClosedWindow = "reopenClosedWindow",
    RestoreClosed = "restoreClosed",
    ClearRecentlyClosed = "clearRecentlyClosed",
    FocusCommandBar = "focusCommandBar",
    CloseTab = "closeTab",
    CloseAllTabs = "closeAllTabs",
    CloseDuplicateTabs = "closeDuplicateTabs",
    Print = "print",
    CopyUrl = "copyUrl",
    CopyUrlAsMarkdown = "copyUrlAsMarkdown",
    FindInPage = "findInPage",
    FindNext = "findNext",
    FindPrevious = "findPrevious",
    HideElement = "hideElement",
    ShowHiddenElements = "showHiddenElements",
    SetAppearance = "setAppearance",
    Reload = "reload",
    ForceReload = "forceReload",
    ToggleTabLayout = "toggleTabLayout",
    SetTabLayout = "setTabLayout",
    ToggleSidebarSide = "toggleSidebarSide",
    ToggleSidebar = "toggleSidebar",
    ToggleCompactToolbar = "toggleCompactToolbar",
    TogglePinnedFold = "togglePinnedFold",
    OpenSplitPane = "openSplitPane",
    OpenSplitPaneBelow = "openSplitPaneBelow",
    UseSelectionForFind = "useSelectionForFind",
    FindAndReplace = "findAndReplace",
    JumpToSelection = "jumpToSelection",
    FocusNextPane = "focusNextPane",
    FocusPreviousPane = "focusPreviousPane",
    MoveSplitPaneLeft = "moveSplitPaneLeft",
    MoveSplitPaneRight = "moveSplitPaneRight",
    MoveSplitPaneUp = "moveSplitPaneUp",
    MoveSplitPaneDown = "moveSplitPaneDown",
    ToggleFullUrl = "toggleFullUrl",
    ToggleJavaScriptFromAppleEvents = "toggleJavaScriptFromAppleEvents",
    ToggleAddressBar = "toggleAddressBar",
    ToggleMinimalism = "toggleMinimalism",
    Cast = "cast",
    ZoomReset = "zoomReset",
    ZoomIn = "zoomIn",
    ZoomOut = "zoomOut",
    DevTools = "devTools",
    ToggleDevTools = "toggleDevTools",
    JavaScriptConsole = "javaScriptConsole",
    InspectElements = "inspectElements",
    ViewSource = "viewSource",
    Back = "back",
    Forward = "forward",
    NextTab = "nextTab",
    PreviousTab = "previousTab",
    SelectTab = "selectTab",
    SelectLastTab = "selectLastTab",
    TogglePin = "togglePin",
    TogglePinnedRow = "togglePinnedRow",
    DuplicateTab = "duplicateTab",
    MoveTabToProfile = "moveTabToProfile",
    MoveTabToWindow = "moveTabToWindow",
    BookmarkPage = "bookmarkPage",
    AddBookmarkToFolder = "addBookmarkToFolder",
    OpenBookmark = "openBookmark",
    AddFolderToSidebar = "addFolderToSidebar",
    RestoreArcFolders = "restoreArcFolders",
    ToggleMute = "toggleMute",
    TogglePageEngine = "togglePageEngine",
    ToggleReader = "toggleReader",
    Downloads = "downloads",
    MergeAllWindows = "mergeAllWindows",
    SwitchProfile = "switchProfile",
    NextProfile = "nextProfile",
    PreviousProfile = "previousProfile",
    NewProfile = "newProfile",
    OpenSettings = "openSettings",
    ImportBrowserData = "importBrowserData",
    ShowHistory = "showHistory",
    ClearBrowsingData = "clearBrowsingData",
    ManageBookmarks = "manageBookmarks",
    ExportBookmarks = "exportBookmarks",
    BookmarkAllTabs = "bookmarkAllTabs",
    SetBookmarksBar = "setBookmarksBar",
    ToggleBookmarksBar = "toggleBookmarksBar",
    NewTabInGroup = "newTabInGroup",
    NewGroupWithTabs = "newGroupWithTabs",
    CleanUpTabs = "cleanUpTabs",
    TidyPins = "tidyPins",
    SortTabs = "sortTabs",
    SearchTabs = "searchTabs",
    RenameTab = "renameTab",
    ChangeTabIcon = "changeTabIcon",
    ReturnToPinnedUrl = "returnToPinnedUrl",
    TabSwitcher = "tabSwitcher",
    Share = "share",
    ReportProblem = "reportProblem",
    KeyboardShortcuts = "keyboardShortcuts",
    CopyDiagnostics = "copyDiagnostics",
    CopyLastFreeze = "copyLastFreeze",
    ToolTour = "toolTour",
    VideoTour = "videoTour",
    ReleaseNotes = "releaseNotes",
    ShowOnboarding = "showOnboarding",
    TaskManager = "taskManager",
    OpenExtension = "openExtension",
    AddExtension = "addExtension",
    ManageExtensions = "manageExtensions",
    PinExtensions = "pinExtensions",
    ManagePlugins = "managePlugins",
    Autofill = "autofill",
    OpenFile = "openFile",
    SavePage = "savePage",
    EmailPageLocation = "emailPageLocation",
    PrintWithSystemDialog = "printWithSystemDialog",
    Stop = "stop",
    CaretBrowsing = "caretBrowsing",
    MoveTabDown = "moveTabDown",
    MoveTabUp = "moveTabUp",
    CloseTabGroup = "closeTabGroup",
    OpenProfileMenu = "openProfileMenu",
    OpenPeekAsTab = "openPeekAsTab",
    ClosePeek = "closePeek",
    UndoClearTabs = "undoClearTabs",
    Quit = "std:quit:",
    Hide = "std:hide:",
    HideOthers = "std:hideOtherApplications:",
    ShowAll = "std:unhideAllApplications:",
    CloseWindow = "std:closeWindow:",
    Undo = "std:undo:",
    Redo = "std:redo:",
    Cut = "std:cut:",
    Copy = "std:copy:",
    Paste = "std:paste:",
    PasteAndMatchStyle = "std:pasteAndMatchStyle:",
    SelectAll = "std:selectAll:",
    ToggleFullScreen = "std:toggleFullScreen:",
    Minimize = "std:performMiniaturize:",
    MinimizeAll = "std:miniaturizeAll:",
} default NewTab);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    App,
    Window,
    Page,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum InLittleArdia {
    Allowed,
    Page,
    Off,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Variant {
    pub arg: &'static str,
    pub title: &'static str,
    pub bar_title: Option<&'static str>,
    pub symbol: Option<&'static str>,
    pub keys: &'static [&'static str],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommandSpec {
    pub command: Command,
    pub title: &'static str,
    pub bar_title: Option<&'static str>,
    pub symbol: Option<&'static str>,
    pub keys: &'static [&'static str],
    pub scope: Scope,
    pub little_ardia: InLittleArdia,
    pub on_internal_pages: bool,
    pub toggles: Option<&'static str>,
    pub chooses: Option<&'static str>,
    pub variants: &'static [Variant],
}

const fn spec(command: Command, title: &'static str) -> CommandSpec {
    CommandSpec {
        command,
        title,
        bar_title: None,
        symbol: None,
        keys: &[],
        scope: Scope::App,
        little_ardia: InLittleArdia::Allowed,
        on_internal_pages: false,
        toggles: None,
        chooses: None,
        variants: &[],
    }
}

const fn variant(arg: &'static str, title: &'static str) -> Variant {
    Variant {
        arg,
        title,
        bar_title: None,
        symbol: None,
        keys: &[],
    }
}

impl Variant {
    const fn symbol(self, symbol: &'static str) -> Self {
        Variant {
            symbol: Some(symbol),
            ..self
        }
    }

    const fn bar(self, bar_title: &'static str) -> Self {
        Variant {
            bar_title: Some(bar_title),
            ..self
        }
    }

    const fn keys(self, keys: &'static [&'static str]) -> Self {
        Variant { keys, ..self }
    }
}

impl CommandSpec {
    const fn bar(self, bar_title: &'static str) -> Self {
        CommandSpec {
            bar_title: Some(bar_title),
            ..self
        }
    }

    const fn symbol(self, symbol: &'static str) -> Self {
        CommandSpec {
            symbol: Some(symbol),
            ..self
        }
    }

    const fn keys(self, keys: &'static [&'static str]) -> Self {
        CommandSpec { keys, ..self }
    }

    const fn window(self) -> Self {
        CommandSpec {
            scope: Scope::Window,
            ..self
        }
    }

    const fn page(self) -> Self {
        CommandSpec {
            scope: Scope::Page,
            little_ardia: InLittleArdia::Page,
            ..self
        }
    }

    const fn page_in_little(self) -> Self {
        CommandSpec {
            little_ardia: InLittleArdia::Page,
            ..self
        }
    }

    const fn off_in_little(self) -> Self {
        CommandSpec {
            little_ardia: InLittleArdia::Off,
            ..self
        }
    }

    const fn window_off(self) -> Self {
        CommandSpec {
            scope: Scope::Window,
            little_ardia: InLittleArdia::Off,
            ..self
        }
    }

    const fn internal(self) -> Self {
        CommandSpec {
            on_internal_pages: true,
            ..self
        }
    }

    const fn toggles(self, key: &'static str) -> Self {
        CommandSpec {
            toggles: Some(key),
            ..self
        }
    }

    const fn chooses(self, key: &'static str, variants: &'static [Variant]) -> Self {
        CommandSpec {
            chooses: Some(key),
            variants,
            ..self
        }
    }

    const fn variants(self, variants: &'static [Variant]) -> Self {
        CommandSpec { variants, ..self }
    }

    pub fn shown_title(&self, arg: Option<&str>) -> &'static str {
        self.variant(arg).map_or(self.title, |v| v.title)
    }

    pub fn command_bar_title(&self, arg: Option<&str>) -> String {
        let (bar, title) = match self.variant(arg) {
            Some(v) => (v.bar_title, v.title),
            None => (self.bar_title, self.title),
        };
        bar.map_or_else(|| title.trim_end_matches('…').to_owned(), str::to_owned)
    }

    pub fn shown_symbol(&self, arg: Option<&str>) -> Option<&'static str> {
        self.variant(arg).and_then(|v| v.symbol).or(self.symbol)
    }

    pub fn variant(&self, arg: Option<&str>) -> Option<&'static Variant> {
        let arg = arg?;
        self.variants.iter().find(|v| v.arg == arg)
    }
}

pub const SORT_TABS: &[Variant] = &[
    variant("site", "Sort Tabs by Site"),
    variant("title", "Sort Tabs by Title"),
];

const APPEARANCE: &[Variant] = &[
    variant("auto", "Automatic")
        .bar("Use System Appearance")
        .symbol("circle.lefthalf.filled"),
    variant("light", "Light")
        .bar("Light Appearance")
        .symbol("sun.max"),
    variant("dark", "Dark")
        .bar("Dark Appearance")
        .symbol("moon"),
];
const TAB_LAYOUTS: &[Variant] = &[
    variant("sidebarLeft", "Sidebar on Left").symbol("sidebar.left"),
    variant("sidebarRight", "Sidebar on Right").symbol("sidebar.right"),
    variant("top", "Top Tab Bar").symbol("menubar.rectangle"),
];
const SELECT_TAB: &[Variant] = &[
    variant("1", "Select Tab 1").keys(&["⌘1"]),
    variant("2", "Select Tab 2").keys(&["⌘2"]),
    variant("3", "Select Tab 3").keys(&["⌘3"]),
    variant("4", "Select Tab 4").keys(&["⌘4"]),
    variant("5", "Select Tab 5").keys(&["⌘5"]),
    variant("6", "Select Tab 6").keys(&["⌘6"]),
    variant("7", "Select Tab 7").keys(&["⌘7"]),
    variant("8", "Select Tab 8").keys(&["⌘8"]),
];
const PINS: &[Variant] = &[
    variant("tile", "Move Pinned Tab to Top Apps"),
    variant("row", "Move to Top Apps"),
];
const BOOKMARKS_BAR: &[Variant] = &[
    variant("always", "Always"),
    variant("newTab", "On New Tab Only"),
    variant("never", "Never"),
];
const SWITCHER: &[Variant] = &[
    variant("forward", "Tab Switcher (forward)").keys(&["⌃⇥"]),
    variant("backward", "Tab Switcher (backward)").keys(&["⌃⇧⇥"]),
];
const AUTOFILL: &[Variant] = &[
    variant("contact", "Contact…"),
    variant("passwords", "Passwords…"),
    variant("creditCard", "Credit Card…"),
];

pub const COMMANDS: &[CommandSpec] = &[
    spec(Command::NewTab, "New Tab")
        .symbol("plus")
        .keys(&["⌘T"]),
    spec(Command::NewWindow, "New Window")
        .symbol("macwindow")
        .keys(&["⌘N"]),
    spec(Command::NewIncognitoWindow, "New Incognito Window")
        .symbol("eyeglasses")
        .keys(&["⇧⌘N"]),
    spec(Command::NewLittleArdia, "New Little Ardia Window").keys(&["⌥⌘N"]),
    spec(
        Command::ToggleOpenLinksInLittleArdia,
        "Open Links from Other Apps in Main Window",
    ),
    spec(Command::ReopenClosedTab, "Reopen Closed Tab")
        .symbol("arrow.uturn.backward")
        .keys(&["⇧⌘T"])
        .page_in_little(),
    spec(Command::ReopenClosedWindow, "Reopen Closed Window"),
    spec(Command::RestoreClosed, "Restore Closed").page_in_little(),
    spec(Command::ClearRecentlyClosed, "Clear Recently Closed").symbol("trash"),
    spec(Command::FocusCommandBar, "Open Command Bar")
        .keys(&["⌘L", "⌃F5"])
        .window(),
    spec(Command::CloseTab, "Close Tab")
        .symbol("xmark")
        .keys(&["⌘W"])
        .window(),
    spec(Command::CloseAllTabs, "Close All Tabs")
        .symbol("xmark.square")
        .keys(&["⇧⌘K"])
        .window_off(),
    spec(Command::CloseDuplicateTabs, "Close Duplicate Tabs")
        .symbol("square.on.square")
        .window_off(),
    spec(Command::Print, "Print…")
        .symbol("printer")
        .keys(&["⌘P"])
        .page(),
    spec(Command::CopyUrl, "Copy URL")
        .symbol("link")
        .keys(&["⇧⌘C"])
        .page()
        .internal(),
    spec(Command::CopyUrlAsMarkdown, "Copy URL as Markdown")
        .symbol("link")
        .keys(&["⌥⇧⌘C"])
        .page()
        .internal(),
    spec(Command::FindInPage, "Find…")
        .bar("Find in Page")
        .symbol("text.magnifyingglass")
        .keys(&["⌘F"])
        .page(),
    spec(Command::FindNext, "Find Next").keys(&["⌘G"]).page(),
    spec(Command::FindPrevious, "Find Previous")
        .keys(&["⇧⌘G"])
        .page(),
    spec(Command::HideElement, "Hide Element…")
        .bar("Hide an Element on This Page")
        .symbol("eye.slash")
        .keys(&["⇧⌘H"])
        .page(),
    spec(Command::ShowHiddenElements, "Hidden Elements on This Site…")
        .bar("Show Hidden Elements on This Site")
        .symbol("eye")
        .keys(&["⇧⌘U"])
        .page(),
    spec(Command::SetAppearance, "Appearance").chooses("appearance", APPEARANCE),
    spec(Command::Reload, "Refresh")
        .bar("Reload Page")
        .symbol("arrow.clockwise")
        .keys(&["⌘R"])
        .page(),
    spec(Command::ForceReload, "Force Refresh the Page")
        .bar("Force Reload Page")
        .symbol("arrow.clockwise")
        .keys(&["⇧⌘R"])
        .page(),
    spec(Command::ToggleTabLayout, "Show Tabs in Sidebar")
        .keys(&["⇧⌘S"])
        .window_off(),
    spec(Command::SetTabLayout, "Tab Layout")
        .window_off()
        .variants(TAB_LAYOUTS),
    spec(Command::ToggleSidebarSide, "Sidebar on Right")
        .symbol("sidebar.right")
        .off_in_little(),
    spec(Command::ToggleSidebar, "Auto-Hide Tabs")
        .symbol("sidebar.left")
        .keys(&["⌘S", "⇧⌘L", "⇧⌘F"])
        .window_off(),
    spec(Command::ToggleCompactToolbar, "Compact Toolbar")
        .symbol("rectangle.compress.vertical")
        .toggles("compactToolbar")
        .off_in_little(),
    spec(Command::TogglePinnedFold, "Collapse Pinned Tabs")
        .symbol("rectangle.compress.vertical")
        .window_off(),
    spec(Command::OpenSplitPane, "Open Split Pane")
        .keys(&["⌃⇧=", "⌃+"])
        .window_off(),
    spec(Command::OpenSplitPaneBelow, "Open Split Pane Below")
        .keys(&["⌃⇧-", "⌃_"])
        .window_off(),
    spec(Command::UseSelectionForFind, "Use Selection for Find")
        .keys(&["⌘E"])
        .page(),
    spec(Command::FindAndReplace, "Find and Replace…")
        .keys(&["⌥⌘F"])
        .page(),
    spec(Command::JumpToSelection, "Jump to Selection")
        .keys(&["⌘J"])
        .page(),
    spec(Command::FocusNextPane, "Focus Next Split Pane")
        .keys(&["⌃⇧]", "⌃}"])
        .off_in_little(),
    spec(Command::FocusPreviousPane, "Focus Previous Split Pane")
        .keys(&["⌃⇧[", "⌃{"])
        .off_in_little(),
    spec(Command::MoveSplitPaneLeft, "Move Split Pane Left")
        .keys(&["⌃⌥←"])
        .window_off(),
    spec(Command::MoveSplitPaneRight, "Move Split Pane Right")
        .keys(&["⌃⌥→"])
        .window_off(),
    spec(Command::MoveSplitPaneUp, "Move Split Pane Up")
        .keys(&["⌃⌥↑"])
        .window_off(),
    spec(Command::MoveSplitPaneDown, "Move Split Pane Down")
        .keys(&["⌃⌥↓"])
        .window_off(),
    spec(Command::ToggleFullUrl, "Show Full URL")
        .symbol("text.alignleft")
        .toggles("showFullUrl")
        .off_in_little(),
    spec(
        Command::ToggleJavaScriptFromAppleEvents,
        "Allow JavaScript from Apple Events",
    )
    .toggles("allowJavaScriptFromAppleEvents"),
    spec(Command::ToggleAddressBar, "Show Address Bar in Sidebar").off_in_little(),
    spec(Command::ToggleMinimalism, "Minimalism Mode")
        .bar("Toggle Minimalism Mode")
        .symbol("rectangle.leftthird.inset.filled")
        .keys(&["⌃⌘M"])
        .toggles("minimalismMode")
        .off_in_little(),
    spec(Command::Cast, "Cast…").page_in_little(),
    spec(Command::ZoomReset, "Zoom to Actual Size")
        .bar("Actual Size")
        .symbol("1.magnifyingglass")
        .keys(&["⌘0"])
        .page(),
    spec(Command::ZoomIn, "Zoom In")
        .symbol("plus.magnifyingglass")
        .keys(&["⌘+", "⌘="])
        .page(),
    spec(Command::ZoomOut, "Zoom Out")
        .symbol("minus.magnifyingglass")
        .keys(&["⌘-"])
        .page(),
    spec(Command::DevTools, "Developer Tools")
        .symbol("hammer")
        .keys(&["⌥⌘I"])
        .page(),
    spec(Command::ToggleDevTools, "Toggle Developer Tools")
        .keys(&["F12"])
        .page(),
    spec(Command::JavaScriptConsole, "JavaScript Console")
        .keys(&["⌥⌘J"])
        .page(),
    spec(Command::InspectElements, "Inspect Elements")
        .keys(&["⌥⌘C"])
        .page(),
    spec(Command::ViewSource, "View Source")
        .keys(&["⌥⌘U"])
        .page(),
    spec(Command::Back, "Go Back")
        .keys(&["⌘[", "⌘←"])
        .window()
        .page_in_little(),
    spec(Command::Forward, "Go Forward")
        .keys(&["⌘]", "⌘→"])
        .window()
        .page_in_little(),
    spec(Command::NextTab, "Next Tab")
        .keys(&["⇧⌘]", "⌘}", "⌃⇟", "⌥⌘↓"])
        .window_off(),
    spec(Command::PreviousTab, "Previous Tab")
        .keys(&["⇧⌘[", "⌘{", "⌃⇞", "⌥⌘↑"])
        .window_off(),
    spec(Command::SelectTab, "Select Tab")
        .window_off()
        .variants(SELECT_TAB),
    spec(Command::SelectLastTab, "Select Last Tab")
        .keys(&["⌘9"])
        .window_off(),
    spec(Command::TogglePin, "Move to Top Apps")
        .symbol("pin")
        .window_off()
        .variants(PINS),
    spec(Command::TogglePinnedRow, "Move to Pinned")
        .keys(&["⌥⇧⌘D"])
        .window_off(),
    spec(Command::DuplicateTab, "Duplicate")
        .bar("Duplicate Tab")
        .symbol("plus.square.on.square")
        .window_off(),
    spec(Command::MoveTabToProfile, "Move Tab to Profile").window_off(),
    spec(Command::MoveTabToWindow, "Move Tab to Window").window_off(),
    spec(Command::BookmarkPage, "Add to Bookmarks…")
        .symbol("bookmark")
        .keys(&["⌘D"])
        .page()
        .internal(),
    spec(Command::AddBookmarkToFolder, "Add Bookmark to Folder")
        .page()
        .internal(),
    spec(Command::OpenBookmark, "Open Bookmark")
        .window()
        .page_in_little(),
    spec(Command::AddFolderToSidebar, "Add Folder to Sidebar"),
    spec(Command::RestoreArcFolders, "Restore Arc Folders"),
    spec(Command::ToggleMute, "Mute Tab")
        .symbol("speaker.slash")
        .page(),
    spec(Command::TogglePageEngine, "Open Page in WebKit"),
    spec(Command::ToggleReader, "Show Reader")
        .bar("Toggle Reading Mode")
        .symbol("doc.plaintext")
        .keys(&["⌥⌘R"])
        .page(),
    spec(Command::Downloads, "Downloads")
        .symbol("arrow.down.circle")
        .keys(&["⇧⌘J", "⌥⌘L"])
        .window()
        .page_in_little(),
    spec(Command::MergeAllWindows, "Merge All Windows")
        .symbol("rectangle.stack")
        .window_off(),
    spec(Command::SwitchProfile, "Switch Profile").window(),
    spec(Command::NextProfile, "Next Profile")
        .keys(&["⌥⌘→"])
        .window(),
    spec(Command::PreviousProfile, "Previous Profile")
        .keys(&["⌥⌘←"])
        .window(),
    spec(Command::NewProfile, "New Profile…").symbol("person.crop.circle.badge.plus"),
    spec(Command::OpenSettings, "Settings…")
        .symbol("gearshape")
        .keys(&["⌘,"]),
    spec(Command::ImportBrowserData, "Import from Another Browser…")
        .bar("Import Browser Data")
        .symbol("square.and.arrow.down"),
    spec(Command::ShowHistory, "Show History…")
        .bar("History")
        .symbol("clock")
        .keys(&["⌘Y"]),
    spec(Command::ClearBrowsingData, "Clear Browsing Data…")
        .symbol("trash")
        .keys(&["⇧⌘⌫"]),
    spec(Command::ManageBookmarks, "Manage Bookmarks")
        .bar("Bookmarks")
        .symbol("book")
        .keys(&["⌥⌘B"]),
    spec(Command::ExportBookmarks, "Export Bookmarks…").symbol("square.and.arrow.up"),
    spec(Command::BookmarkAllTabs, "Bookmark All Tabs…")
        .keys(&["⇧⌘D"])
        .off_in_little(),
    spec(Command::SetBookmarksBar, "Show Bookmarks Bar")
        .chooses("bookmarksBar", BOOKMARKS_BAR)
        .off_in_little(),
    spec(Command::ToggleBookmarksBar, "Toggle Bookmarks Bar")
        .symbol("menubar.rectangle")
        .keys(&["⇧⌘B"])
        .off_in_little(),
    spec(Command::NewTabInGroup, "New Tab in Group")
        .keys(&["⌥⌘T", "⌃⌘C"])
        .window_off(),
    spec(Command::NewGroupWithTabs, "New Group with Tab")
        .symbol("folder.badge.plus")
        .keys(&["⌃⌘N", "⌃⌘P"])
        .window_off(),
    spec(Command::CleanUpTabs, "Clean Up Tabs")
        .symbol("sparkles")
        .keys(&["⌥⌘K"])
        .window_off(),
    spec(Command::TidyPins, "Tidy Pins").symbol("sparkles"),
    spec(Command::SortTabs, "Sort Tabs")
        .symbol("arrow.up.arrow.down")
        .window_off()
        .variants(SORT_TABS),
    spec(Command::SearchTabs, "Search Tabs…")
        .symbol("magnifyingglass")
        .keys(&["⇧⌘A"])
        .window_off(),
    spec(Command::RenameTab, "Rename…")
        .bar("Rename Tab")
        .symbol("pencil")
        .window_off(),
    spec(Command::ChangeTabIcon, "Change Icon…").window_off(),
    spec(Command::ReturnToPinnedUrl, "Back to Pinned URL")
        .keys(&["⌘↩"])
        .window_off(),
    spec(Command::TabSwitcher, "Tab Switcher")
        .window_off()
        .variants(SWITCHER),
    spec(Command::Share, "Share…")
        .symbol("square.and.arrow.up")
        .keys(&["⌥⌘S"])
        .page(),
    spec(Command::ReportProblem, "Report a Problem…").keys(&["⌥⇧⌘I"]),
    spec(Command::KeyboardShortcuts, "Keyboard Shortcuts").symbol("keyboard"),
    spec(Command::CopyDiagnostics, "Copy Diagnostics"),
    spec(Command::CopyLastFreeze, "Copy Last Freeze"),
    spec(Command::ToolTour, "Tool Tour"),
    spec(Command::VideoTour, "Video Tour"),
    spec(Command::ReleaseNotes, "Release Notes"),
    spec(Command::ShowOnboarding, "Show Onboarding"),
    spec(Command::TaskManager, "Task Manager"),
    spec(Command::OpenExtension, "Open Extension").page_in_little(),
    spec(Command::AddExtension, "Add Extension…").page_in_little(),
    spec(Command::ManageExtensions, "Manage Extensions…"),
    spec(Command::PinExtensions, "Pin Extensions…"),
    spec(Command::ManagePlugins, "Plugins…").symbol("puzzlepiece.extension"),
    spec(Command::Autofill, "Autofill")
        .page_in_little()
        .variants(AUTOFILL),
    spec(Command::OpenFile, "Open File…").keys(&["⌘O"]),
    spec(Command::SavePage, "Save Page As…").page(),
    spec(Command::EmailPageLocation, "Email Page Location")
        .keys(&["⇧⌘I"])
        .page(),
    spec(Command::PrintWithSystemDialog, "Print Using System Dialog…")
        .keys(&["⌥⌘P"])
        .page(),
    spec(Command::Stop, "Stop").keys(&["⌘."]).page(),
    spec(Command::CaretBrowsing, "Caret Browsing")
        .keys(&["F7"])
        .page(),
    spec(Command::MoveTabDown, "Move Tab Down")
        .keys(&["⌃⇧⇟"])
        .window_off(),
    spec(Command::MoveTabUp, "Move Tab Up")
        .keys(&["⌃⇧⇞"])
        .window_off(),
    spec(Command::CloseTabGroup, "Close Group")
        .keys(&["⌃⌘W"])
        .window_off(),
    spec(Command::OpenProfileMenu, "Show Profiles Menu")
        .keys(&["⇧⌘M"])
        .window(),
    spec(Command::OpenPeekAsTab, "Open as Tab")
        .symbol("arrow.up.left.and.arrow.down.right")
        .window_off(),
    spec(Command::ClosePeek, "Close Peek").window_off(),
    spec(Command::UndoClearTabs, "Undo Clear").window_off(),
    spec(Command::Quit, "Quit Ardia").keys(&["⌘Q"]),
    spec(Command::Hide, "Hide Ardia").keys(&["⌘H"]),
    spec(Command::HideOthers, "Hide Others").keys(&["⌥⌘H"]),
    spec(Command::ShowAll, "Show All"),
    spec(Command::CloseWindow, "Close Window").keys(&["⇧⌘W"]),
    spec(Command::Undo, "Undo").keys(&["⌘Z"]),
    spec(Command::Redo, "Redo").keys(&["⇧⌘Z"]),
    spec(Command::Cut, "Cut").keys(&["⌘X"]),
    spec(Command::Copy, "Copy").keys(&["⌘C"]),
    spec(Command::Paste, "Paste").keys(&["⌘V"]),
    spec(Command::PasteAndMatchStyle, "Paste and Match Style").keys(&["⇧⌘V", "⌥⇧⌘V"]),
    spec(Command::SelectAll, "Select All").keys(&["⌘A"]),
    spec(Command::ToggleFullScreen, "Enter Full Screen").keys(&["🌐F", "⌃⌘F"]),
    spec(Command::Minimize, "Minimize").keys(&["⌘M"]),
    spec(Command::MinimizeAll, "Minimize All").keys(&["⌥⌘M"]),
];

pub const DESKTOP_KEYS: &[(&str, &[&str])] = &[
    ("focusCommandBar", &["⌘L", "F6", "⌥D"]),
    ("reload", &["⌘R", "F5"]),
    ("forceReload", &["⇧⌘R", "⇧F5"]),
    ("devTools", &["⇧⌘I", "⌥⌘I"]),
    ("emailPageLocation", &[]),
    ("jumpToSelection", &[]),
    ("downloads", &["⌘J", "⌥⌘L"]),
    ("javaScriptConsole", &["⇧⌘J", "⌥⌘J"]),
    ("zoomIn", &["⌘=", "⇧⌘="]),
    ("openSplitPane", &["⌘\\"]),
    ("back", &["⌘[", "⌥←"]),
    ("forward", &["⌘]", "⌥→"]),
    ("nextTab", &["⇧⌘]", "⌘⇟", "⌥⌘↓"]),
    ("previousTab", &["⇧⌘[", "⌘⇞", "⌥⌘↑"]),
    ("openSplitPaneBelow", &["⇧⌘\\"]),
    ("moveSplitPaneLeft", &["⌥⇧←"]),
    ("moveSplitPaneRight", &["⌥⇧→"]),
    ("moveSplitPaneUp", &["⌥⇧↑"]),
    ("moveSplitPaneDown", &["⌥⇧↓"]),
    ("tabSwitcher:forward", &["⌘⇥"]),
    ("tabSwitcher:backward", &["⇧⌘⇥"]),
    ("std:quit:", &["⇧⌘Q"]),
    ("std:toggleFullScreen:", &["F11"]),
    ("std:hide:", &[]),
    ("std:hideOtherApplications:", &[]),
    ("std:unhideAllApplications:", &[]),
    ("std:performMiniaturize:", &[]),
    ("std:miniaturizeAll:", &[]),
];

impl Command {
    pub fn spec(self) -> &'static CommandSpec {
        &COMMANDS[self as usize]
    }

    pub fn id(self) -> &'static str {
        self.key()
    }

    pub fn title(self, arg: Option<&str>) -> &'static str {
        self.spec().shown_title(arg)
    }

    pub fn parse_id(id: &str) -> Option<(Command, Option<&str>)> {
        if let Some(command) = Command::from_key(id) {
            return Some((command, None));
        }
        let (name, arg) = id.split_once(':')?;
        Some((Command::from_key(name)?, Some(arg)))
    }

    pub fn is_app_wide(self) -> bool {
        self.spec().scope == Scope::App
    }

    pub fn allowed_in_little_ardia(self) -> bool {
        self.spec().little_ardia != InLittleArdia::Off
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_has_its_spec_at_its_own_index() {
        assert_eq!(COMMANDS.len(), Command::ALL.len());
        for (i, &command) in Command::ALL.iter().enumerate() {
            assert_eq!(COMMANDS[i].command, command, "{command:?}");
            assert_eq!(command.spec().command, command);
        }
    }

    #[test]
    fn titles_variants_and_ids() {
        assert_eq!(Command::NewTab.title(None), "New Tab");
        assert_eq!(Command::SelectTab.title(Some("3")), "Select Tab 3");
        assert_eq!(
            Command::SetAppearance
                .spec()
                .command_bar_title(Some("dark")),
            "Dark Appearance"
        );
        assert_eq!(Command::Print.spec().command_bar_title(None), "Print");
        assert_eq!(
            Command::FindInPage.spec().command_bar_title(None),
            "Find in Page"
        );
        assert_eq!(
            Command::SetAppearance.spec().shown_symbol(Some("light")),
            Some("sun.max")
        );
        assert_eq!(
            Command::parse_id("selectTab:4"),
            Some((Command::SelectTab, Some("4")))
        );
        assert_eq!(Command::parse_id("std:quit:"), Some((Command::Quit, None)));
        assert_eq!(
            Command::parse_id("switchProfile:p-1"),
            Some((Command::SwitchProfile, Some("p-1")))
        );
        assert_eq!(Command::parse_id("nope"), None);
        assert!(Command::OpenSettings.is_app_wide());
        assert!(!Command::CloseAllTabs.allowed_in_little_ardia());
        assert_eq!(
            Command::ToggleMinimalism.spec().toggles,
            Some("minimalismMode")
        );
    }

    #[test]
    fn desktop_overrides_name_real_ids() {
        for (id, _) in DESKTOP_KEYS {
            assert!(Command::parse_id(id).is_some(), "{id}");
        }
    }
}
