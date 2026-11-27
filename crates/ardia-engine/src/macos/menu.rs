use std::ffi::c_char;

use serde::Serialize;
use serde_json::Value;

use super::{call_json, ensure_bridge_host, ffi};
use crate::error::{EngineError, EngineResult};
use crate::types::Modifiers;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Shortcut {
    pub key: String,
    pub modifiers: u32,
}

impl Shortcut {
    pub fn new(key: &str, modifiers: Modifiers) -> Self {
        Self {
            key: key.to_owned(),
            modifiers: modifiers.chord().0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MenuRole {
    Services,
    Windows,
    Help,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandItem {
    pub title: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arg: Option<String>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<Shortcut>,
    pub hidden: bool,
    pub alternate: bool,
    pub enabled: bool,
    pub checked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandardItem {
    pub title: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<Shortcut>,
    pub hidden: bool,
    pub alternate: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Menu {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<MenuRole>,
    pub hidden: bool,
    pub items: Vec<MenuItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MenuItem {
    Command(CommandItem),
    Standard(StandardItem),
    Submenu(Menu),
    Separator,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct MenuBar {
    pub menus: Vec<Menu>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MenuEntry {
    pub id: String,
    pub title: String,
    pub current: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MenuContext {
    pub app_name: String,
    pub profiles: Vec<MenuEntry>,
    pub windows: Vec<MenuEntry>,
    pub recently_closed: Vec<MenuEntry>,
    pub extensions: Vec<MenuEntry>,
    pub show_onboarding: bool,
}

const CMD: Modifiers = Modifiers::COMMAND;
const SHIFT: Modifiers = Modifiers::SHIFT;
const OPT: Modifiers = Modifiers::OPTION;
const CTRL: Modifiers = Modifiers::CONTROL;
const FN: Modifiers = Modifiers::FUNCTION;

const UP: &str = "\u{F700}";
const DOWN: &str = "\u{F701}";
const LEFT: &str = "\u{F702}";
const RIGHT: &str = "\u{F703}";
const F7: &str = "\u{F70A}";
const F12: &str = "\u{F70F}";
const PAGE_UP: &str = "\u{F72C}";
const PAGE_DOWN: &str = "\u{F72D}";
const BACKSPACE: &str = "\u{8}";
const RETURN: &str = "\u{D}";
const TAB: &str = "\u{9}";

fn command(title: &str, id: &str) -> CommandItem {
    CommandItem {
        title: title.to_owned(),
        command: id.to_owned(),
        arg: None,
        shortcut: None,
        hidden: false,
        alternate: false,
        enabled: true,
        checked: false,
    }
}

impl CommandItem {
    fn key(mut self, key: &str, modifiers: Modifiers) -> Self {
        self.shortcut = Some(Shortcut::new(key, modifiers));
        self
    }

    fn arg(mut self, arg: &str) -> Self {
        self.arg = Some(arg.to_owned());
        self
    }

    fn hidden(mut self) -> Self {
        self.hidden = true;
        self
    }

    fn alternate(mut self) -> Self {
        self.alternate = true;
        self
    }

    fn checked(mut self, current: bool) -> Self {
        self.checked = current;
        self
    }

    fn item(self) -> MenuItem {
        MenuItem::Command(self)
    }
}

fn standard(title: &str, action: &str) -> StandardItem {
    StandardItem {
        title: title.to_owned(),
        action: action.to_owned(),
        target: None,
        shortcut: None,
        hidden: false,
        alternate: false,
    }
}

impl StandardItem {
    fn key(mut self, key: &str, modifiers: Modifiers) -> Self {
        self.shortcut = Some(Shortcut::new(key, modifiers));
        self
    }

    fn app(mut self) -> Self {
        self.target = Some("app".to_owned());
        self
    }

    fn alternate(mut self) -> Self {
        self.alternate = true;
        self
    }

    fn item(self) -> MenuItem {
        MenuItem::Standard(self)
    }
}

fn submenu(title: &str, items: Vec<MenuItem>) -> MenuItem {
    MenuItem::Submenu(Menu {
        title: title.to_owned(),
        role: None,
        hidden: false,
        items,
    })
}

fn hidden_submenu(title: &str, items: Vec<MenuItem>, hidden: bool) -> MenuItem {
    MenuItem::Submenu(Menu {
        title: title.to_owned(),
        role: None,
        hidden,
        items,
    })
}

fn menu(title: &str, role: Option<MenuRole>, items: Vec<MenuItem>) -> Menu {
    Menu {
        title: title.to_owned(),
        role,
        hidden: false,
        items,
    }
}

fn header(title: &str) -> MenuItem {
    let mut item = command(title, "noop");
    item.enabled = false;
    item.item()
}

fn sep() -> MenuItem {
    MenuItem::Separator
}

fn entries(list: &[MenuEntry], id: &str) -> Vec<MenuItem> {
    list.iter()
        .map(|entry| {
            command(&entry.title, id)
                .arg(&entry.id)
                .checked(entry.current)
                .item()
        })
        .collect()
}

pub fn dia_menu_bar(context: &MenuContext) -> MenuBar {
    let app = if context.app_name.is_empty() {
        "Ardia"
    } else {
        context.app_name.as_str()
    };
    let many_profiles = context.profiles.len() > 1;
    let app_menu = menu(
        app,
        None,
        vec![
            command(&format!("About {app}"), "about").item(),
            command("Check for Updates…", "checkForUpdates").item(),
            sep(),
            command("Settings…", "openSettings").key(",", CMD).item(),
            command("Import from Another Browser…", "importBrowserData").item(),
            sep(),
            MenuItem::Submenu(menu("Services", Some(MenuRole::Services), Vec::new())),
            sep(),
            standard(&format!("Hide {app}"), "hide:")
                .app()
                .key("h", CMD)
                .item(),
            standard("Hide Others", "hideOtherApplications:")
                .app()
                .key("h", OPT | CMD)
                .item(),
            standard("Show All", "unhideAllApplications:").app().item(),
            sep(),
            command(&format!("Quit {app}"), "quit").key("q", CMD).item(),
        ],
    );
    let file = menu(
        "File",
        None,
        vec![
            command("New Tab", "newTab").key("t", CMD).item(),
            command("New Tab in Group", "newTabInGroup")
                .key("t", OPT | CMD)
                .item(),
            command("New Window", "newWindow").key("n", CMD).item(),
            command("New Incognito Window", "newIncognitoWindow")
                .key("n", SHIFT | CMD)
                .item(),
            command("New Little Ardia Window", "newLittleArdia")
                .key("n", OPT | CMD)
                .item(),
            hidden_submenu(
                "New Little Ardia Window in Profile",
                entries(&context.profiles, "newLittleArdia"),
                !many_profiles,
            ),
            command(
                "Open Links from Other Apps in Main Window",
                "toggleOpenLinksInLittleArdia",
            )
            .hidden()
            .item(),
            command("Reopen Closed Tab", "reopenClosedTab")
                .key("t", SHIFT | CMD)
                .item(),
            command("Reopen Closed Window", "reopenClosedWindow").item(),
            command("Open File…", "openFile").key("o", CMD).item(),
            sep(),
            command("Open Command Bar", "focusCommandBar")
                .key("l", CMD)
                .item(),
            sep(),
            command("Close Window", "closeWindow")
                .key("w", SHIFT | CMD)
                .item(),
            command("Close Tab", "closeTab").key("w", CMD).item(),
            command("Close All Tabs", "closeAllTabs")
                .key("k", SHIFT | CMD)
                .item(),
            command("Close Duplicate Tabs", "closeDuplicateTabs").item(),
            command("Clean Up Tabs", "cleanUpTabs")
                .key("k", OPT | CMD)
                .item(),
            sep(),
            command("Save Page As…", "savePage").item(),
            submenu(
                "Share",
                vec![command("Share…", "share").key("s", OPT | CMD).item(), sep()],
            ),
            command("Email Page Location", "emailPageLocation")
                .key("i", SHIFT | CMD)
                .hidden()
                .item(),
            command("Print…", "print").key("p", CMD).item(),
            command("Print Using System Dialog…", "printWithSystemDialog")
                .key("p", OPT | CMD)
                .item(),
        ],
    );
    let edit = menu(
        "Edit",
        None,
        vec![
            standard("Undo", "undo:").key("z", CMD).item(),
            standard("Redo", "redo:").key("z", SHIFT | CMD).item(),
            sep(),
            standard("Cut", "cut:").key("x", CMD).item(),
            standard("Copy", "copy:").key("c", CMD).item(),
            command("Copy URL", "copyUrl").key("c", SHIFT | CMD).item(),
            command("Copy URL as Markdown", "copyUrlAsMarkdown")
                .key("c", OPT | SHIFT | CMD)
                .item(),
            standard("Paste", "paste:").key("v", CMD).item(),
            standard("Paste and Match Style", "pasteAsPlainText:")
                .key("v", SHIFT | CMD)
                .item(),
            standard("Delete", "delete:").item(),
            standard("Select All", "selectAll:").key("a", CMD).item(),
            sep(),
            submenu(
                "Find",
                vec![
                    command("Find…", "findInPage").key("f", CMD).item(),
                    command("Find and Replace…", "findAndReplace")
                        .key("f", OPT | CMD)
                        .item(),
                    command("Find Next", "findNext").key("g", CMD).item(),
                    command("Find Previous", "findPrevious")
                        .key("g", SHIFT | CMD)
                        .item(),
                    command("Use Selection for Find", "useSelectionForFind")
                        .key("e", CMD)
                        .item(),
                    command("Jump to Selection", "jumpToSelection")
                        .key("j", CMD)
                        .item(),
                ],
            ),
            submenu(
                "Spelling and Grammar",
                vec![
                    standard("Show Spelling and Grammar", "showGuessPanel:")
                        .key(":", CMD)
                        .item(),
                    standard("Check Document Now", "checkSpelling:")
                        .key(";", CMD)
                        .item(),
                    sep(),
                    standard(
                        "Check Spelling While Typing",
                        "toggleContinuousSpellChecking:",
                    )
                    .item(),
                    standard("Check Grammar With Spelling", "toggleGrammarChecking:").item(),
                    standard(
                        "Correct Spelling Automatically",
                        "toggleAutomaticSpellingCorrection:",
                    )
                    .item(),
                ],
            ),
            submenu(
                "Substitutions",
                vec![
                    standard("Show Substitutions", "orderFrontSubstitutionsPanel:").item(),
                    sep(),
                    standard("Smart Copy/Paste", "toggleSmartInsertDelete:").item(),
                    standard("Smart Quotes", "toggleAutomaticQuoteSubstitution:").item(),
                    standard("Smart Dashes", "toggleAutomaticDashSubstitution:").item(),
                    standard("Smart Links", "toggleAutomaticLinkDetection:").item(),
                    standard("Data Detectors", "toggleAutomaticDataDetection:").item(),
                    standard("Text Replacement", "toggleAutomaticTextReplacement:").item(),
                ],
            ),
            submenu(
                "Transformations",
                vec![
                    standard("Make Upper Case", "uppercaseWord:").item(),
                    standard("Make Lower Case", "lowercaseWord:").item(),
                    standard("Capitalize", "capitalizeWord:").item(),
                ],
            ),
            submenu(
                "Speech",
                vec![
                    standard("Start Speaking", "startSpeaking:").item(),
                    standard("Stop Speaking", "stopSpeaking:").item(),
                ],
            ),
            submenu(
                "AutoFill",
                vec![
                    command("Contact…", "autofill").arg("contact").item(),
                    command("Passwords…", "autofill").arg("passwords").item(),
                    command("Credit Card…", "autofill").arg("creditCard").item(),
                ],
            ),
        ],
    );
    let view = menu(
        "View",
        None,
        vec![
            submenu(
                "Appearance",
                vec![
                    command("Automatic", "setAppearance").arg("auto").item(),
                    command("Light", "setAppearance").arg("light").item(),
                    command("Dark", "setAppearance").arg("dark").item(),
                ],
            ),
            command("Stop", "stop").key(".", CMD).item(),
            command("Refresh", "reload").key("r", CMD).item(),
            command("Force Refresh the Page", "forceReload")
                .key("r", SHIFT | CMD)
                .alternate()
                .item(),
            sep(),
            submenu(
                "Browser Layout",
                vec![
                    command("Sidebar on Left", "setTabLayout")
                        .arg("sidebarLeft")
                        .item(),
                    command("Sidebar on Right", "setTabLayout")
                        .arg("sidebarRight")
                        .item(),
                    command("Top Tab Bar", "setTabLayout").arg("top").item(),
                    command("Show Tabs in Sidebar", "toggleTabLayout")
                        .key("s", SHIFT | CMD)
                        .hidden()
                        .item(),
                    sep(),
                    command("Show Address Bar in Sidebar", "toggleAddressBar").item(),
                    command("Compact Toolbar", "toggleCompactToolbar").item(),
                    command("Show Full URL", "toggleFullUrl").item(),
                    sep(),
                    command("Auto-Hide Tabs", "toggleSidebar")
                        .key("s", CMD)
                        .item(),
                    command("Minimalism Mode", "toggleMinimalism")
                        .key("m", CTRL | CMD)
                        .item(),
                    submenu(
                        "Show Bookmarks Bar",
                        vec![
                            command("Always", "setBookmarksBar").arg("always").item(),
                            command("On New Tab Only", "setBookmarksBar")
                                .arg("newTab")
                                .item(),
                            command("Never", "setBookmarksBar").arg("never").item(),
                            sep(),
                            command("Toggle Bookmarks Bar", "toggleBookmarksBar")
                                .key("b", SHIFT | CMD)
                                .item(),
                        ],
                    ),
                    command("Collapse Pinned Tabs", "togglePinnedFold").item(),
                ],
            ),
            submenu(
                "Split View",
                vec![
                    command("Open Split Pane", "openSplitPane")
                        .key("=", CTRL | SHIFT)
                        .item(),
                    command("Open Split Pane Below", "openSplitPaneBelow")
                        .key("-", CTRL | SHIFT)
                        .item(),
                    command("Focus Next Split Pane", "focusNextPane")
                        .key("]", CTRL | SHIFT)
                        .item(),
                    command("Focus Previous Split Pane", "focusPreviousPane")
                        .key("[", CTRL | SHIFT)
                        .item(),
                    command("Move Split Pane Left", "moveSplitPaneLeft")
                        .key(LEFT, CTRL | OPT)
                        .item(),
                    command("Move Split Pane Right", "moveSplitPaneRight")
                        .key(RIGHT, CTRL | OPT)
                        .item(),
                    command("Move Split Pane Up", "moveSplitPaneUp")
                        .key(UP, CTRL | OPT)
                        .item(),
                    command("Move Split Pane Down", "moveSplitPaneDown")
                        .key(DOWN, CTRL | OPT)
                        .item(),
                ],
            ),
            sep(),
            command("Cast…", "cast").item(),
            command("Open Page in WebKit", "togglePageEngine").item(),
            command("Show Reader", "toggleReader")
                .key("r", OPT | CMD)
                .item(),
            sep(),
            command("Zoom to Actual Size", "zoomReset")
                .key("0", CMD)
                .item(),
            command("Zoom In", "zoomIn").key("+", CMD).item(),
            command("Zoom Out", "zoomOut").key("-", CMD).item(),
            sep(),
            submenu(
                "Hide Elements",
                vec![
                    command("Hide Element…", "hideElement")
                        .key("h", SHIFT | CMD)
                        .item(),
                    command("Hidden Elements on This Site…", "showHiddenElements")
                        .key("u", SHIFT | CMD)
                        .item(),
                ],
            ),
            sep(),
            standard("Enter Full Screen", "toggleFullScreen:")
                .key("f", FN)
                .item(),
            sep(),
            submenu(
                "Developer",
                vec![
                    command("View Source", "viewSource")
                        .key("u", OPT | CMD)
                        .item(),
                    command("Developer Tools", "devTools")
                        .key("i", OPT | CMD)
                        .item(),
                    command("Inspect Elements", "inspectElements")
                        .key("c", OPT | CMD)
                        .item(),
                    command("JavaScript Console", "javaScriptConsole")
                        .key("j", OPT | CMD)
                        .item(),
                    command(
                        "Allow JavaScript from Apple Events",
                        "toggleJavaScriptFromAppleEvents",
                    )
                    .item(),
                    command("Toggle Developer Tools", "toggleDevTools")
                        .key(F12, Modifiers::NONE)
                        .hidden()
                        .item(),
                    command("Caret Browsing", "caretBrowsing")
                        .key(F7, Modifiers::NONE)
                        .hidden()
                        .item(),
                ],
            ),
        ],
    );
    let mut tab_items = vec![
        command("Go Back", "back").key("[", CMD).item(),
        command("Go Forward", "forward").key("]", CMD).item(),
        sep(),
        command("Next Tab", "nextTab").key("]", SHIFT | CMD).item(),
        command("Previous Tab", "previousTab")
            .key("[", SHIFT | CMD)
            .item(),
        command("Move Tab Down", "moveTabDown")
            .key(PAGE_DOWN, CTRL | SHIFT)
            .hidden()
            .item(),
        command("Move Tab Up", "moveTabUp")
            .key(PAGE_UP, CTRL | SHIFT)
            .hidden()
            .item(),
        command("Search Tabs…", "searchTabs")
            .key("a", SHIFT | CMD)
            .item(),
        command("Sort Tabs by Site", "sortTabs")
            .arg("site")
            .hidden()
            .item(),
        command("Sort Tabs by Title", "sortTabs")
            .arg("title")
            .hidden()
            .item(),
        command("Tab Switcher (forward)", "tabSwitcher")
            .arg("forward")
            .key(TAB, CTRL)
            .hidden()
            .item(),
        command("Tab Switcher (backward)", "tabSwitcher")
            .arg("backward")
            .key(TAB, CTRL | SHIFT)
            .hidden()
            .item(),
        command("Back to Pinned URL", "returnToPinnedUrl")
            .key(RETURN, CMD)
            .hidden()
            .item(),
    ];
    for n in 1..=8 {
        let digit = n.to_string();
        tab_items.push(
            command(&format!("Select Tab {n}"), "selectTab")
                .arg(&digit)
                .key(&digit, CMD)
                .hidden()
                .item(),
        );
    }
    tab_items.extend([
        command("Select Last Tab", "selectLastTab")
            .key("9", CMD)
            .hidden()
            .item(),
        sep(),
        command("Move to Top Apps", "togglePin").item(),
        command("Move to Pinned", "togglePinnedRow")
            .key("d", OPT | SHIFT | CMD)
            .item(),
        command("Duplicate", "duplicateTab").item(),
        command("New Group with Tab", "newGroupWithTabs")
            .key("n", CTRL | CMD)
            .item(),
        command("Close Group", "closeTabGroup")
            .key("w", CTRL | CMD)
            .hidden()
            .item(),
        sep(),
        submenu(
            "Move to Profile",
            entries(&context.profiles, "moveTabToProfile"),
        ),
        submenu("Move to Window", {
            let mut items = entries(&context.windows, "moveTabToWindow");
            if !items.is_empty() {
                items.push(sep());
            }
            items.push(command("New Window", "moveTabToWindow").arg("new").item());
            items
        }),
        sep(),
        command("Add to Bookmarks…", "bookmarkPage")
            .key("d", CMD)
            .item(),
        sep(),
        command("Rename…", "renameTab").item(),
        command("Change Icon…", "changeTabIcon").item(),
        command("Mute Tab", "toggleMute").item(),
    ]);
    let tabs = menu("Tabs", None, tab_items);
    let bookmarks = menu(
        "Bookmarks",
        None,
        vec![
            command("Bookmark This Page", "bookmarkPage")
                .key("d", CMD)
                .item(),
            command("Bookmark All Tabs…", "bookmarkAllTabs")
                .key("d", SHIFT | CMD)
                .item(),
            command("Manage Bookmarks", "manageBookmarks")
                .key("b", OPT | CMD)
                .item(),
            command("Export Bookmarks…", "exportBookmarks").item(),
        ],
    );
    let mut history_items = vec![
        command("Show History…", "showHistory").key("y", CMD).item(),
        command("Clear Browsing Data…", "clearBrowsingData")
            .key(BACKSPACE, SHIFT | CMD)
            .item(),
        sep(),
        header("Recently Closed"),
    ];
    if context.recently_closed.is_empty() {
        history_items.push(header("Empty"));
    } else {
        history_items.extend(entries(&context.recently_closed, "restoreClosed"));
    }
    history_items.extend([
        sep(),
        command("Clear Recently Closed", "clearRecentlyClosed").item(),
    ]);
    let history = menu("History", None, history_items);
    let mut extension_items = entries(&context.extensions, "openExtension");
    if !extension_items.is_empty() {
        extension_items.push(sep());
    }
    extension_items.extend([
        command("Manage Extensions…", "manageExtensions").item(),
        command("Add Extension…", "addExtension").item(),
        command("Pin Extensions…", "pinExtensions").hidden().item(),
    ]);
    let extensions = menu("Extensions", None, extension_items);
    let mut profile_items = entries(&context.profiles, "switchProfile");
    if !profile_items.is_empty() {
        profile_items.push(sep());
    }
    profile_items.extend([
        command("Next Profile", "nextProfile")
            .key(RIGHT, OPT | CMD)
            .item(),
        command("Previous Profile", "previousProfile")
            .key(LEFT, OPT | CMD)
            .item(),
        sep(),
        command("New Profile…", "newProfile").item(),
    ]);
    let window = menu(
        "Window",
        Some(MenuRole::Windows),
        vec![
            standard("Minimize", "performMiniaturize:")
                .key("m", CMD)
                .item(),
            standard("Minimize All", "miniaturizeAll:")
                .app()
                .key("m", OPT | CMD)
                .alternate()
                .item(),
            standard("Zoom", "performZoom:").item(),
            standard("Arrange in Front", "arrangeInFront:").app().item(),
            command("Keep Window on Top", "toggleKeepOnTop").item(),
            sep(),
            command("Downloads", "downloads")
                .key("j", SHIFT | CMD)
                .item(),
            command("Task Manager", "taskManager").item(),
            command("Merge All Windows", "mergeAllWindows").item(),
            sep(),
            hidden_submenu("Profiles", profile_items, !many_profiles),
            command("Show Profiles Menu", "openProfileMenu")
                .key("m", SHIFT | CMD)
                .hidden()
                .item(),
        ],
    );
    let mut help_items = vec![
        command("Report a Problem…", "reportProblem")
            .key("i", OPT | SHIFT | CMD)
            .item(),
        command("Keyboard Shortcuts", "keyboardShortcuts").item(),
        command("Tool Tour", "toolTour").item(),
        command("Video Tour", "videoTour").hidden().item(),
        command("Release Notes", "releaseNotes").item(),
        sep(),
        command("Copy Diagnostics", "copyDiagnostics").item(),
        command("Copy Last Freeze", "copyLastFreeze").item(),
    ];
    if context.show_onboarding {
        help_items.extend([sep(), command("Show Onboarding", "showOnboarding").item()]);
    }
    let help = menu("Help", Some(MenuRole::Help), help_items);
    MenuBar {
        menus: vec![
            app_menu, file, edit, view, tabs, bookmarks, history, extensions, window, help,
        ],
    }
}

impl MenuBar {
    pub fn titles(&self) -> Vec<&str> {
        self.menus.iter().map(|menu| menu.title.as_str()).collect()
    }

    pub fn commands(&self) -> Vec<&CommandItem> {
        fn walk<'a>(items: &'a [MenuItem], out: &mut Vec<&'a CommandItem>) {
            for item in items {
                match item {
                    MenuItem::Command(command) => out.push(command),
                    MenuItem::Submenu(menu) => walk(&menu.items, out),
                    MenuItem::Standard(_) | MenuItem::Separator => {}
                }
            }
        }
        let mut out = Vec::new();
        for menu in &self.menus {
            walk(&menu.items, &mut out);
        }
        out
    }

    pub fn shortcut_conflicts(&self) -> Vec<String> {
        fn walk(
            items: &[MenuItem],
            seen: &mut Vec<(Shortcut, String)>,
            conflicts: &mut Vec<String>,
        ) {
            for item in items {
                let (shortcut, action) = match item {
                    MenuItem::Command(c) => (
                        c.shortcut.as_ref(),
                        format!("{}:{}", c.command, c.arg.as_deref().unwrap_or("")),
                    ),
                    MenuItem::Standard(s) => (s.shortcut.as_ref(), s.action.clone()),
                    MenuItem::Submenu(menu) => {
                        walk(&menu.items, seen, conflicts);
                        continue;
                    }
                    MenuItem::Separator => continue,
                };
                let Some(shortcut) = shortcut else { continue };
                match seen.iter().find(|(known, _)| known == shortcut) {
                    Some((_, other)) if other != &action => {
                        conflicts.push(format!("{shortcut:?}: {other} and {action}"))
                    }
                    Some(_) => {}
                    None => seen.push((shortcut.clone(), action)),
                }
            }
        }
        let mut seen = Vec::new();
        let mut conflicts = Vec::new();
        for menu in &self.menus {
            walk(&menu.items, &mut seen, &mut conflicts);
        }
        conflicts
    }

    pub fn to_json(&self) -> EngineResult<Value> {
        serde_json::to_value(self).map_err(|e| EngineError::bad_argument(e.to_string()))
    }

    pub fn install(&self) -> EngineResult<()> {
        ensure_bridge_host()?;
        call_json(
            |json: *const c_char, _| unsafe { ffi::ardia_bridge_menu_install(json) },
            self,
            false,
            || EngineError::NotStarted,
        )
        .map(|_| ())
    }

    pub fn build_and_describe(&self) -> EngineResult<Value> {
        call_json(
            |json: *const c_char, out| unsafe { ffi::ardia_bridge_menu_build_describe(json, out) },
            self,
            false,
            || EngineError::NotStarted,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context() -> MenuContext {
        MenuContext {
            app_name: "Ardia".into(),
            profiles: vec![
                MenuEntry {
                    id: "p1".into(),
                    title: "Personal".into(),
                    current: true,
                },
                MenuEntry {
                    id: "p2".into(),
                    title: "Work".into(),
                    current: false,
                },
            ],
            windows: vec![MenuEntry {
                id: "w1".into(),
                title: "GitHub".into(),
                current: false,
            }],
            recently_closed: Vec::new(),
            extensions: vec![MenuEntry {
                id: "ext".into(),
                title: "uBlock".into(),
                current: false,
            }],
            show_onboarding: false,
        }
    }

    #[test]
    fn the_bar_has_dias_ten_menus_in_order() {
        let bar = dia_menu_bar(&context());
        assert_eq!(
            bar.titles(),
            [
                "Ardia",
                "File",
                "Edit",
                "View",
                "Tabs",
                "Bookmarks",
                "History",
                "Extensions",
                "Window",
                "Help"
            ]
        );
        assert_eq!(bar.menus[8].role, Some(MenuRole::Windows));
        assert_eq!(bar.menus[9].role, Some(MenuRole::Help));
        assert!(
            matches!(&bar.menus[0].items[6], MenuItem::Submenu(menu) if menu.role == Some(MenuRole::Services))
        );
    }

    #[test]
    fn shortcuts_never_point_two_ways() {
        let bar = dia_menu_bar(&context());
        assert_eq!(bar.shortcut_conflicts(), Vec::<String>::new());
        let commands = bar.commands();
        let find = |id: &str| commands.iter().find(|c| c.command == id).copied().unwrap();
        assert_eq!(find("newTab").shortcut, Some(Shortcut::new("t", CMD)));
        assert_eq!(
            find("newIncognitoWindow").shortcut,
            Some(Shortcut::new("n", SHIFT | CMD))
        );
        assert_eq!(find("quit").shortcut, Some(Shortcut::new("q", CMD)));
        assert!(find("emailPageLocation").hidden);
        assert!(find("forceReload").alternate);
        assert_eq!(
            commands.iter().filter(|c| c.command == "selectTab").count(),
            8
        );
    }

    #[test]
    fn dynamic_lists_fill_their_menus() {
        let bar = dia_menu_bar(&context());
        let commands = bar.commands();
        let switches: Vec<_> = commands
            .iter()
            .filter(|c| c.command == "switchProfile")
            .map(|c| (c.title.as_str(), c.checked))
            .collect();
        assert_eq!(switches, [("Personal", true), ("Work", false)]);
        assert!(
            commands
                .iter()
                .any(|c| c.command == "moveTabToWindow" && c.arg.as_deref() == Some("w1"))
        );
        assert!(
            commands
                .iter()
                .any(|c| c.command == "moveTabToWindow" && c.arg.as_deref() == Some("new"))
        );
        assert!(
            commands
                .iter()
                .any(|c| c.command == "openExtension" && c.title == "uBlock")
        );
        let single = dia_menu_bar(&MenuContext {
            profiles: vec![context().profiles[0].clone()],
            ..context()
        });
        let profiles = single.menus[8].items.iter().find_map(|item| match item {
            MenuItem::Submenu(menu) if menu.title == "Profiles" => Some(menu),
            _ => None,
        });
        assert!(profiles.unwrap().hidden);
    }

    #[test]
    fn specs_serialize_for_the_bridge() {
        let item = command("New Tab", "newTab").key("t", CMD).item();
        assert_eq!(
            serde_json::to_value(&item).unwrap(),
            json!({"kind": "command", "title": "New Tab", "command": "newTab", "key": "t", "modifiers": CMD.0, "hidden": false, "alternate": false, "enabled": true, "checked": false})
        );
        let hide = standard("Hide Ardia", "hide:").app().key("h", CMD).item();
        assert_eq!(
            serde_json::to_value(&hide).unwrap(),
            json!({"kind": "standard", "title": "Hide Ardia", "action": "hide:", "target": "app", "key": "h", "modifiers": CMD.0, "hidden": false, "alternate": false})
        );
        assert_eq!(
            serde_json::to_value(sep()).unwrap(),
            json!({"kind": "separator"})
        );
        let bar = dia_menu_bar(&context()).to_json().unwrap();
        assert_eq!(bar["menus"].as_array().unwrap().len(), 10);
    }
}
