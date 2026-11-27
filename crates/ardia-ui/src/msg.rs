use std::rc::Rc;

use ardia_engine::{DownloadCommand, PermissionResult};
use ardia_state::windows::Popover;
use ardia_state::{Action, GroupId, ProfileId, SplitId, TabId, WindowId};
use gpui::{App, ClickEvent, Context, Pixels, Point, SharedString, WeakEntity, Window};

use crate::host::{UiHost, UtilityWindowKind};
use crate::settings::rows::Pane;

#[derive(Clone, Debug, PartialEq)]
pub enum MenuTarget {
    SidebarOverflow,
    Tab(TabId),
    Group(GroupId),
    Profile,
    NewTab,
    CastSource(TabId),
    Extensions,
    Extension(String),
    CastRoutes,
    Download(String),
    DownloadsButton,
    ProfileItem(ProfileId),
    LiveFolder(String),
    LiveItem {
        folder: String,
        item: String,
        tab: Option<TabId>,
    },
    Reload(TabId),
    SplitPane(TabId),
    UrlBar(TabId, Option<ardia_state::omnibox::PasteAction>),
    Site(crate::site::menus::SiteMenu),
    LittleProfile,
    TileFolder(String),
    TileFolderActions(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum RenameTarget {
    Tab(TabId),
    Group(GroupId),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Msg {
    Count(&'static str),
    Store(Action),
    Stores(Vec<Action>),
    SplitEmpty {
        tab: TabId,
        msg: crate::content::split_empty::SplitEmptyMsg,
    },
    Command(SharedString),
    Navigate {
        tab: TabId,
        input: String,
    },
    Back(TabId),
    Forward(TabId),
    Reload {
        tab: TabId,
        hard: bool,
    },
    Stop(TabId),
    Mute {
        tab: TabId,
        muted: bool,
    },
    Zoom {
        tab: TabId,
        step: i32,
    },
    DevTools(TabId),
    Pip(TabId),
    ExitPip(TabId),
    EditPinnedUrl(TabId),
    NewTileFolder(TabId),
    RenameTileFolder(String),
    PluginMenu {
        plugin: String,
        command: String,
        context: serde_json::Map<String, serde_json::Value>,
    },
    Cast(TabId),
    Share(TabId),
    Download {
        id: String,
        command: DownloadCommand,
    },
    Reveal(String),
    OpenPath(String),
    MoveGroupToWindow {
        group: GroupId,
        window: Option<WindowId>,
    },
    GroupToBookmarksBar(GroupId),
    BookmarkTabsToNewFolder(Vec<TabId>),
    MoveTabsToWindow {
        tabs: Vec<TabId>,
        window: Option<WindowId>,
    },
    ToggleOpenWhenDone(String),
    TrashDownload {
        id: String,
        path: String,
    },
    Permission {
        request: String,
        result: PermissionResult,
        remember: bool,
    },
    Password {
        tab: TabId,
        action: String,
        username: Option<String>,
    },
    Autofill {
        tab: TabId,
        prompt: i64,
        action: String,
    },
    Extension {
        tab: TabId,
        extension: String,
    },
    PinExtension {
        extension: String,
        pinned: bool,
    },
    CloseExtensionPopup,
    RemoveExtension(String),
    AskRemoveExtension(String),
    MoveExtension {
        extension: String,
        to: usize,
    },
    ToggleSidePanel(String),
    ResolveInstall {
        request: String,
        accepted: bool,
    },
    PinDialog(bool),
    DropFiles(Vec<String>),
    CloseSidePanel,
    StopCastRoute(String),
    StartCasting {
        tab: TabId,
        device: String,
    },
    StopCasting {
        tab: TabId,
        device: String,
    },
    CastSource {
        tab: TabId,
        screen: bool,
    },
    Utility(UtilityWindowKind),
    SettingsAt(Pane),
    Import {
        source: String,
        profile: ProfileId,
    },
    Copy(String),
    ClearSiteData(TabId),
    PickTab {
        tab: TabId,
        toggle: bool,
        range: bool,
    },
    PickTabIntoGroup(TabId),
    CloseTab(TabId),
    ClearUnpinned,
    UndoClear,
    DismissToast(u64),
    OpenCommandPanel {
        new_tab: bool,
        text: Option<String>,
    },
    TogglePopover(Popover),
    PickSuggestion(usize),
    Panel(crate::omnibox::PanelMsg),
    NewTabInGroup(GroupId),
    ConfirmClose(bool),
    ToastAction {
        id: u64,
        command: SharedString,
    },
    ToastHeld {
        id: u64,
        by: crate::popovers::toast::HoldBy,
        held: bool,
    },
    SubmitPanel {
        alternate: bool,
    },
    UrlHover(bool),
    CloseOverlays,
    Menu(Option<(MenuTarget, Point<Pixels>)>),
    Rename(Option<RenameTarget>),
    TileLetters(Option<TabId>),
    HoverTab(Option<TabId>),
    EdgeHover(bool),
    PeekHover(bool),
    SidebarWidth(f32),
    SidebarResized,
    SplitDrag {
        split: SplitId,
        handle: usize,
        fraction: f32,
    },
    DropTab {
        tab: TabId,
        before: Option<TabId>,
        group: Option<GroupId>,
        pin: Option<bool>,
    },
    Find(FindMsg),
    SettingsPane(usize),
    Recording(Option<SharedString>),
    PaneOverlay(crate::window::page_overlays::PaneOverlayMsg),
    People(crate::profiles::layer::PeopleMsg),
    Site(crate::site::SiteMsg),
    Live(ardia_state::live::LiveCommand),
    Calendar(crate::live::CalendarCommand),
    Report(crate::report::state::ReportCommand),
    Noop,
}

#[derive(Clone, Debug, PartialEq)]
pub enum FindMsg {
    Open,
    OpenReplace,
    Replace { all: bool },
    Close,
    Next,
    Previous,
}

impl Msg {
    pub fn command(id: &'static str) -> Msg {
        Msg::Command(SharedString::new_static(id))
    }

    pub fn deliver(
        self,
        host: &dyn UiHost,
        window: Option<&WindowId>,
        cx: &mut App,
    ) -> Option<Msg> {
        match self {
            Msg::Count(field) => ardia_telemetry::counts::count(field),
            Msg::Store(action) => {
                if matches!(action, Action::MovePane { .. }) {
                    ardia_telemetry::counts::count("split_pane_menu_moves");
                }
                host.dispatch(action)
            }
            Msg::Stores(actions) => {
                for action in actions {
                    host.dispatch(action);
                }
            }
            Msg::Navigate { tab, input } => match window {
                Some(window) => host.navigate(window.clone(), tab, input),
                None => return Some(Msg::Navigate { tab, input }),
            },
            Msg::Back(tab) => host.go_back(tab),
            Msg::Forward(tab) => host.go_forward(tab),
            Msg::Reload { tab, hard } => host.reload(tab, hard),
            Msg::Stop(tab) => host.stop_loading(tab),
            Msg::Mute { tab, muted } => host.set_muted(tab, muted),
            Msg::Zoom { tab, step: 0 } => host.set_zoom(tab, 1.0),
            Msg::Zoom { tab, step } => host.zoom_step(tab, step.signum()),
            Msg::DevTools(tab) => host.toggle_devtools(tab),
            Msg::Pip(tab) => host.toggle_media_pip(tab),
            Msg::ExitPip(tab) => {
                if host.media_pip_open(&tab) {
                    host.toggle_media_pip(tab);
                }
            }
            Msg::PluginMenu {
                plugin,
                command,
                context,
            } => match (window, host.plugins()) {
                (Some(window), Some(plugins)) => {
                    plugins.run_menu_command(window, &plugin, &command, context);
                }
                (None, _) => {
                    return Some(Msg::PluginMenu {
                        plugin,
                        command,
                        context,
                    });
                }
                _ => {}
            },
            Msg::Cast(tab) => host.show_cast(tab),
            Msg::Share(tab) => host.share_tab(tab),
            Msg::Download { id, command } => host.download_command(id, command),
            Msg::Reveal(path) => host.reveal_path(path),
            Msg::OpenPath(path) => host.open_path(path),
            Msg::ToggleOpenWhenDone(id) => host.toggle_open_when_done(id),
            Msg::TrashDownload { id, path } => {
                let answer = host.move_to_trash(path);
                let store = std::sync::Arc::clone(host.store());
                cx.spawn(async move |_: &mut gpui::AsyncApp| {
                    if answer.await == Ok(true) {
                        let _ = store.dispatch(Action::RemoveDownload { id });
                    }
                })
                .detach();
            }
            Msg::Permission {
                request,
                result,
                remember,
            } => host.resolve_permission(request, result, remember),
            Msg::Password {
                tab,
                action,
                username,
            } => host.resolve_password_prompt(tab, action, username, None),
            Msg::Autofill {
                tab,
                prompt,
                action,
            } => host.resolve_autofill_prompt(tab, prompt, action),
            Msg::Extension { tab, extension } => host.execute_extension_action(tab, extension),
            Msg::PinExtension { extension, pinned } => match window {
                Some(window) => host.set_extension_pinned(window.clone(), extension, pinned),
                None => return Some(Msg::PinExtension { extension, pinned }),
            },
            Msg::StopCastRoute(route) => host.stop_cast_route(route),
            Msg::ResolveInstall { request, accepted } => {
                host.resolve_extension_install(request, accepted)
            }
            Msg::DropFiles(paths) => match window {
                Some(window) => {
                    for path in crate::host_data::crx_paths(&paths) {
                        host.install_crx(window.clone(), path);
                    }
                }
                None => return Some(Msg::DropFiles(paths)),
            },
            Msg::PinDialog(open) => match window {
                Some(window) => host.set_pin_dialog(window.clone(), open),
                None => return Some(Msg::PinDialog(open)),
            },
            Msg::MoveExtension { extension, to } => match window {
                Some(window) => host.move_extension(window.clone(), extension, to),
                None => return Some(Msg::MoveExtension { extension, to }),
            },
            Msg::ToggleSidePanel(extension) => match window {
                Some(window) => host.toggle_side_panel(window.clone(), extension),
                None => return Some(Msg::ToggleSidePanel(extension)),
            },
            Msg::CloseSidePanel => match window {
                Some(window) => host.close_side_panel(window.clone()),
                None => return Some(Msg::CloseSidePanel),
            },
            Msg::RemoveExtension(extension) => match window {
                Some(window) => host.remove_extension(window.clone(), extension),
                None => return Some(Msg::RemoveExtension(extension)),
            },
            Msg::CloseExtensionPopup => match window {
                Some(window) => host.close_extension_popup(window.clone()),
                None => return Some(Msg::CloseExtensionPopup),
            },
            Msg::StartCasting { tab, device } => host.start_casting(tab, device),
            Msg::StopCasting { tab, device } => host.stop_casting(tab, device),
            Msg::CastSource { tab, screen } => host.set_cast_source(tab, screen),
            Msg::Utility(kind) => host.open_utility_window(kind),
            Msg::SettingsAt(pane) => {
                crate::settings::request_pane(pane, cx);
                host.open_utility_window(UtilityWindowKind::Settings);
            }
            Msg::Import { source, profile } => host.start_import(source, profile),
            Msg::Live(command) => host.live_command(command),
            Msg::Calendar(command) => host.calendar_command(command),
            Msg::Report(command) => host.report_command(command),
            Msg::Copy(text) => cx.write_to_clipboard(gpui::ClipboardItem::new_string(text)),
            Msg::ClearSiteData(tab) => host.clear_site_data(tab),
            Msg::Noop => {}
            Msg::TileLetters(tab) => match window {
                Some(window) => crate::sidebar::tile_letters::open(window.as_str(), tab),
                None => return Some(Msg::TileLetters(tab)),
            },
            other => return Some(other),
        }
        None
    }
}

type Sink = Rc<dyn Fn(Msg, &mut Window, &mut App)>;

#[derive(Clone)]
pub struct Emit(Sink);

impl Emit {
    pub fn new<V: 'static>(
        view: WeakEntity<V>,
        handle: fn(&mut V, Msg, &mut Window, &mut Context<V>),
    ) -> Self {
        Emit(Rc::new(move |msg, window, cx| {
            if view
                .update(cx, |view, cx| handle(view, msg, window, cx))
                .is_err()
            {
                log::debug!("a message reached a closed window");
            }
        }))
    }

    pub fn send(&self, msg: Msg, window: &mut Window, cx: &mut App) {
        (self.0)(msg, window, cx);
    }

    pub fn defer(&self, msg: Msg, window: &mut Window, cx: &mut App) {
        let sink = Rc::clone(&self.0);
        window.defer(cx, move |window, cx| sink(msg, window, cx));
    }

    pub fn click(&self, msg: Msg) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
        let sink = Rc::clone(&self.0);
        move |_, window, cx| sink(msg.clone(), window, cx)
    }

    pub fn on<E: ?Sized>(&self, msg: Msg) -> impl Fn(&E, &mut Window, &mut App) + 'static {
        let sink = Rc::clone(&self.0);
        move |_, window, cx| sink(msg.clone(), window, cx)
    }

    pub fn with<T: 'static>(
        &self,
        make: impl Fn(T) -> Msg + 'static,
    ) -> impl Fn(T, &mut Window, &mut App) + 'static {
        let sink = Rc::clone(&self.0);
        move |value, window, cx| sink(make(value), window, cx)
    }
}
