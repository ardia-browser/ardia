use super::*;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PageUpdate {
    pub url: Option<String>,
    pub title: Option<String>,
    pub favicon: Option<Option<String>>,
    pub loading: Option<bool>,
    pub progress: Option<f32>,
    pub can_go_back: Option<bool>,
    pub can_go_forward: Option<bool>,
    pub audible: Option<bool>,
    pub theme_color: Option<Option<RgbaColor>>,
    pub icon_theme: Option<Option<IconTheme>>,
    pub security: Option<SecurityState>,
    pub unread_count: Option<u32>,
    pub blocked_requests: Option<u32>,
    pub engine_tab_id: Option<Option<String>>,
    pub fullscreen: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct GroupPatch {
    pub name: Option<String>,
    pub icon: Option<Option<String>>,
    pub color: Option<Option<GroupColor>>,
    pub collapsed: Option<bool>,
    pub pinned: Option<bool>,
    pub shown_tab_ids: Option<Vec<TabId>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProfilePatch {
    pub name: Option<String>,
    pub color: Option<ProfileColor>,
    pub icon: Option<Option<String>>,
    pub theme: Option<Option<Arc<ProfileTheme>>>,
    pub pinned_collapsed: Option<bool>,
    pub share_top_apps: Option<bool>,
    pub sync_tabs: Option<bool>,
    pub password_manager: Option<Option<String>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewTab {
    pub url: Option<String>,
    pub profile: Option<ProfileId>,
    pub opener: Option<TabId>,
    pub background: bool,
    pub index: Option<usize>,
    pub pin: Option<TabPin>,
    pub snapshot: Option<Box<TabSnapshot>>,
}

impl NewTab {
    pub fn restoring(snapshot: TabSnapshot) -> Self {
        NewTab {
            profile: Some(snapshot.profile_id.clone()),
            snapshot: Some(Box::new(snapshot)),
            ..NewTab::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    OpenWindow {
        kind: WindowKind,
        profile: Option<ProfileId>,
        url: Option<String>,
        frame: Option<Frame>,
    },
    CloseWindow {
        window: WindowId,
    },
    OpenLastWindowOrNew,
    FocusWindow {
        window: WindowId,
    },
    SetWindowFrame {
        window: WindowId,
        frame: Option<Frame>,
        maximized: bool,
    },
    SetFullScreen {
        window: WindowId,
        on: bool,
        display: Option<String>,
    },
    ToggleSidebar {
        window: WindowId,
    },
    SetSidebarPeeking {
        window: WindowId,
        peeking: bool,
    },
    SetTabLayout {
        window: Option<WindowId>,
        layout: TabLayout,
    },
    SwitchProfile {
        window: WindowId,
        profile: ProfileId,
    },
    PromoteLittleArdia {
        window: WindowId,
    },
    NewTab {
        window: WindowId,
        tab: NewTab,
    },
    ActivateTab {
        tab: TabId,
    },
    SelectTabAt {
        window: WindowId,
        index: Option<usize>,
    },
    CycleTab {
        window: WindowId,
        delta: i32,
    },
    CloseTabs {
        tabs: Vec<TabId>,
        last_closes_window: bool,
    },
    CloseSyncedTabs {
        tabs: Vec<TabId>,
    },
    ReopenClosed {
        window: Option<WindowId>,
    },
    RestoreClosed {
        id: EntryId,
        window: Option<WindowId>,
    },
    ClearRecentlyClosed {
        window: Option<WindowId>,
    },
    MoveTab {
        tab: TabId,
        window: WindowId,
        index: usize,
    },
    SetPin {
        tab: TabId,
        pin: Option<TabPin>,
    },
    MoveTabsToProfile {
        tabs: Vec<TabId>,
        profile: ProfileId,
        before: Option<TabId>,
        background: bool,
    },
    RenameTab {
        tab: TabId,
        title: Option<String>,
    },
    SetTileLetters {
        tab: TabId,
        letters: Option<String>,
    },
    SetTabLiveItem {
        tab: TabId,
        live_item: Option<crate::model::LiveItem>,
        home: Option<Option<String>>,
    },
    SetTabIcon {
        tab: TabId,
        icon: Option<String>,
    },
    SetMuted {
        tab: TabId,
        muted: bool,
    },
    SetSiteMuted {
        tab: TabId,
        muted: bool,
    },
    SetZoom {
        tab: TabId,
        zoom: f64,
    },
    SetEngine {
        tab: TabId,
        engine: Option<PageEngine>,
    },
    Navigate {
        tab: TabId,
        input: String,
    },
    UpdatePage {
        tab: TabId,
        update: PageUpdate,
    },
    SetPrompts {
        tab: TabId,
        prompts: Vec<SitePrompt>,
    },
    SleepTabs {
        tabs: Vec<TabId>,
    },
    UnloadTopApp {
        tab: TabId,
    },
    ForgetPages {
        tabs: Vec<TabId>,
    },
    DuplicateTab {
        tab: TabId,
    },
    SelectTabs {
        window: WindowId,
        tabs: Vec<TabId>,
    },
    ReturnToPinnedUrl {
        tab: TabId,
    },
    SetPinnedUrl {
        tab: TabId,
        url: Option<String>,
    },
    ClearUnpinned {
        window: WindowId,
    },
    CloseDuplicateTabs {
        window: WindowId,
    },
    ArrangeTabs {
        window: WindowId,
        tabs: Vec<TabId>,
    },
    CleanUpTabs {
        tabs: Vec<TabId>,
    },
    TidyTabs {
        window: WindowId,
        profile: Option<ProfileId>,
    },
    TidyPins {
        window: WindowId,
    },
    UntidyTabs {
        tidied: crate::tidy::Tidied,
    },
    UndoClear {
        window: WindowId,
    },
    CreateGroup {
        tabs: Vec<TabId>,
        name: String,
    },
    UpdateGroup {
        group: GroupId,
        patch: GroupPatch,
    },
    AddToGroup {
        group: GroupId,
        tabs: Vec<TabId>,
    },
    RemoveFromGroups {
        tabs: Vec<TabId>,
    },
    Ungroup {
        group: GroupId,
    },
    CloseGroup {
        group: GroupId,
    },
    DeleteGroup {
        group: GroupId,
    },
    DuplicateGroup {
        group: GroupId,
    },
    NewNestedGroup {
        parent: GroupId,
    },
    MoveGroupToWindow {
        group: GroupId,
        window: WindowId,
    },
    SplitTabs {
        tabs: Vec<TabId>,
        orientation: Orientation,
    },
    OpenSplitPane {
        window: WindowId,
        side: SplitSide,
        url: Option<String>,
    },
    RemoveFromSplit {
        tab: TabId,
    },
    Unsplit {
        split: SplitId,
    },
    SwapPanes {
        a: TabId,
        b: TabId,
    },
    ResizeSplit {
        split: SplitId,
        sizes: Vec<f64>,
    },
    RestackSplit {
        split: SplitId,
        stack_sizes: [f64; 2],
    },
    FlipSplit {
        split: SplitId,
    },
    FocusPane {
        window: WindowId,
        delta: i32,
    },
    MovePane {
        tab: TabId,
        direction: PaneDirection,
    },
    DropIntoSplit {
        tab: TabId,
        anchor: TabId,
        side: SplitSide,
    },
    MoveGroup {
        group: GroupId,
        before: Option<TabId>,
        pinned: bool,
        parent: Option<GroupId>,
    },
    AddToTileFolder {
        tabs: Vec<TabId>,
        onto: TabId,
        before: Option<TabId>,
    },
    LeaveTileFolder {
        tabs: Vec<TabId>,
    },
    RenameTileFolder {
        window: WindowId,
        folder: String,
        name: String,
    },
    ReplaceSplitPane {
        pane: TabId,
        tab: TabId,
    },
    RemoveEmptySplitPane {
        tab: TabId,
    },
    CreateProfile {
        name: String,
        color: Option<ProfileColor>,
        icon: Option<String>,
    },
    UpdateProfile {
        profile: ProfileId,
        patch: ProfilePatch,
    },
    ShareProfileData {
        profile: ProfileId,
        with: ProfileId,
    },
    DeleteProfile {
        profile: ProfileId,
    },
    ReorderProfiles {
        order: Vec<ProfileId>,
    },
    UpdateSettings {
        patch: SettingsPatch,
        from_sync: bool,
    },
    SetShortcut {
        id: String,
        shortcut: Option<Shortcut>,
    },
    ResetShortcut {
        id: String,
    },
    SetFind {
        tab: TabId,
        find: FindState,
    },
    SetPopover {
        window: WindowId,
        popover: Option<Popover>,
    },
    SetCommandBar {
        window: WindowId,
        state: CommandBarState,
    },
    OpenPeek {
        window: WindowId,
        url: String,
        source: Option<TabId>,
    },
    ClosePeek {
        window: WindowId,
    },
    OpenPeekAt {
        window: WindowId,
        url: String,
        source: Option<TabId>,
        click_px: [f32; 2],
    },
    PromotePeek {
        window: WindowId,
    },
    PushToast {
        window: WindowId,
        toast: Toast,
    },
    DismissToast {
        window: WindowId,
        id: u64,
    },
    UpsertDownload {
        download: Box<Download>,
    },
    RemoveDownload {
        id: String,
    },
    ClearDownloads,
    RecordVisit {
        profile: ProfileId,
        url: String,
        title: String,
        favicon: Option<String>,
    },
    RemoveHistory {
        profile: ProfileId,
        url: String,
    },
    RemoveHistoryPages {
        profile: ProfileId,
        urls: Vec<String>,
    },
    ClearHistory {
        profile: ProfileId,
        since: Option<Millis>,
        until: Millis,
    },
    ReplaceHistory {
        profile: ProfileId,
        entries: Vec<crate::history::HistoryEntry>,
    },
    AddBookmark {
        profile: ProfileId,
        parent: Option<BookmarkId>,
        title: String,
        url: String,
    },
    RemoveBookmark {
        profile: ProfileId,
        id: BookmarkId,
    },
    MoveBookmark {
        profile: ProfileId,
        id: BookmarkId,
        parent: BookmarkId,
        index: Option<usize>,
    },
    SetAirTraffic {
        config: AirTrafficConfig,
    },
    RenameBookmark {
        profile: ProfileId,
        id: BookmarkId,
        title: String,
    },
    UpdateBookmark {
        profile: ProfileId,
        id: BookmarkId,
        title: Option<String>,
        url: Option<String>,
    },
    AddBookmarkFolder {
        profile: ProfileId,
        parent: Option<BookmarkId>,
        title: String,
        index: Option<usize>,
    },
    AddBookmarkAt {
        profile: ProfileId,
        parent: Option<BookmarkId>,
        index: Option<usize>,
        title: String,
        url: String,
    },
    MoveBookmarks {
        profile: ProfileId,
        ids: Vec<BookmarkId>,
        parent: BookmarkId,
        index: Option<usize>,
    },
    RemoveBookmarks {
        profile: ProfileId,
        ids: Vec<BookmarkId>,
    },
    RestoreBookmarks {
        profile: ProfileId,
        removed: crate::bookmarks::RemovedBookmarks,
    },
}
