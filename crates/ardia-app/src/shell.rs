use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Arc;

use ardia_state::windows::WindowKind;
use ardia_state::{Action, WindowId};
use ardia_ui::{OpenWindowTarget, UiHost, UtilityWindowKind};
use futures::StreamExt;
use futures::channel::mpsc::UnboundedReceiver;
use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, ClipboardItem, Context, ExternalWindowHandle,
    IntoElement, ParentElement, Render, SharedString, Styled, TitlebarOptions, Window,
    WindowBounds, WindowOptions, div, px, rgb, size,
};

use crate::coordinator::{AppCoordinator, HostedWindow, Presentation, ShellEffect};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellMode {
    Hosted,
    Standalone,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = ardia, no_json)]
pub struct MenuCommand {
    pub command: String,
    pub arg: Option<String>,
}

pub struct PlaceholderView {
    coordinator: Arc<AppCoordinator>,
    window: Option<WindowId>,
    title: SharedString,
}

impl Render for PlaceholderView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let state = self.coordinator.store().snapshot();
        let mut column = div()
            .size_full()
            .flex()
            .flex_col()
            .gap_1()
            .p_4()
            .bg(rgb(0x1a1a1f))
            .text_color(rgb(0xe9e9ef))
            .text_sm()
            .child(div().text_lg().child(self.title.clone()));
        if let Some(window) = self
            .window
            .as_ref()
            .and_then(|id| state.window(id.as_str()))
        {
            let active = window.active_tab().cloned();
            for tab in state.view_tabs(window.id.as_str(), None) {
                let marker = if active.as_ref() == Some(&tab.id) {
                    "●"
                } else {
                    "○"
                };
                let busy = if tab.live.loading { " …" } else { "" };
                column =
                    column.child(div().child(format!("{marker} {}{busy}", tab.display_title())));
            }
        }
        column
    }
}

fn external(host: Option<HostedWindow>) -> Option<ExternalWindowHandle> {
    let host = host?;
    let window = NonNull::new(host.window as *mut c_void)?;
    let view = NonNull::new(host.view as *mut c_void);
    Some(unsafe { ExternalWindowHandle::new(window, view) })
}

pub fn open_placeholder(
    cx: &mut App,
    coordinator: &Arc<AppCoordinator>,
    window: Option<WindowId>,
    title: &str,
    host: Option<ExternalWindowHandle>,
) -> anyhow::Result<AnyWindowHandle> {
    let background = coordinator.config().background;
    let bounds = host
        .is_none()
        .then(|| WindowBounds::Windowed(Bounds::centered(None, size(px(1100.), px(740.)), cx)));
    let options = WindowOptions {
        window_bounds: bounds,
        titlebar: Some(TitlebarOptions {
            title: Some(SharedString::from(title.to_owned())),
            ..TitlebarOptions::default()
        }),
        focus: !background,
        show: true,
        host_window: host,
        ..WindowOptions::default()
    };
    let view = PlaceholderView {
        coordinator: coordinator.clone(),
        window,
        title: SharedString::from(title.to_owned()),
    };
    let handle = cx.open_window(options, move |_, cx| cx.new(move |_| view))?;
    Ok(handle.into())
}

pub struct Shell {
    coordinator: Arc<AppCoordinator>,
    mode: ShellMode,
    utility: HashMap<UtilityWindowKind, AnyWindowHandle>,
    menu_signature: Option<u64>,
    activated: bool,
    presented_browser: bool,
    onboarding_waits: Option<UtilityWindowKind>,
}

fn utility_title(kind: UtilityWindowKind) -> &'static str {
    match kind {
        UtilityWindowKind::Settings => "Settings",
        UtilityWindowKind::Import => "Import",
        UtilityWindowKind::Onboarding => "Welcome to Ardia",
        UtilityWindowKind::Intro => "Ardia",
    }
}

impl Shell {
    pub fn new(coordinator: Arc<AppCoordinator>, mode: ShellMode) -> Self {
        Self {
            coordinator,
            mode,
            utility: HashMap::new(),
            menu_signature: None,
            activated: false,
            presented_browser: false,
            onboarding_waits: None,
        }
    }

    pub fn run_pump(&mut self, cx: &mut App) {
        follow_platform_focus(&self.coordinator, cx);
        let report = self.coordinator.pump();
        let effects = self.coordinator.take_effects();
        for effect in effects {
            self.apply(effect, cx);
        }
        let hidden = self.coordinator.config().background;
        for window in report.refresh {
            if let Some(handle) = self.coordinator.gpui_window(&window) {
                let _ = handle.update(cx, |_, window, _| {
                    window.refresh();
                    if hidden {
                        crate::hidden_frames::request_frame(window);
                    }
                });
            }
        }
        self.sync_menu(cx);
    }

    fn apply(&mut self, effect: ShellEffect, cx: &mut App) {
        match effect {
            ShellEffect::OpenBrowserWindow { window, kind, host } => {
                self.open_browser_window(window, kind, host, cx)
            }
            ShellEffect::CloseWindow { window } => {
                if let Some(handle) = self.coordinator.gpui_window(&window) {
                    let _ = handle.update(cx, |_, window, _| window.remove_window());
                }
                self.coordinator.unregister_gpui_window(window);
            }
            ShellEffect::FocusWindow { window } => {
                if !self.coordinator.config().background
                    && let Some(handle) = self.coordinator.gpui_window(&window)
                {
                    let _ = handle.update(cx, |_, window, _| window.activate_window());
                }
            }
            ShellEffect::OpenUtility(
                kind @ (UtilityWindowKind::Onboarding | UtilityWindowKind::Intro),
            ) if !self.presented_browser => {
                self.onboarding_waits = Some(kind);
            }
            ShellEffect::OpenUtility(kind) => self.open_utility(kind, cx),
            ShellEffect::Confirm(request) => {
                let coordinator = self.coordinator.clone();
                let shown = request
                    .window
                    .as_ref()
                    .and_then(|window| self.coordinator.gpui_window(window))
                    .or_else(|| cx.active_window());
                let prompt = shown.and_then(|handle| {
                    handle
                        .update(cx, |_, window, cx| {
                            window.prompt(
                                gpui::PromptLevel::Warning,
                                &request.title,
                                Some(&request.message),
                                &[request.confirm.as_str(), request.cancel.as_str()],
                                cx,
                            )
                        })
                        .ok()
                });
                let id = request.id;
                match prompt {
                    Some(prompt) => cx
                        .spawn(async move |_| {
                            coordinator.answer_confirm(id, prompt.await.is_ok_and(|choice| choice == 0))
                        })
                        .detach(),
                    None => coordinator.answer_confirm(id, false),
                }
            }
            ShellEffect::ConfirmCloseWithDownloads {
                window,
                request,
                count,
                quitting,
            } => {
                let coordinator = self.coordinator.clone();
                self.ask_about_downloads(
                    window,
                    DownloadsQuestion::new(count, quitting),
                    false,
                    cx,
                    move |close| {
                        coordinator.answer_close_with_downloads(request, close);
                    },
                );
            }
            ShellEffect::ConfirmQuitWithDownloads { count } => {
                let coordinator = self.coordinator.clone();
                self.ask_about_downloads(
                    None,
                    DownloadsQuestion::new(count, true),
                    true,
                    cx,
                    move |quit| {
                        if quit {
                            coordinator.quit_now();
                        } else {
                            log::info!("quitting stopped so the downloads can finish");
                        }
                    },
                );
            }
            ShellEffect::InstallMenu => self.menu_signature = None,
            ShellEffect::Copy(text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            ShellEffect::SyntheticInput { window, steps } => {
                let found = if window.as_str() == crate::synthetic_input::SETTINGS_WINDOW {
                    cx.windows().into_iter().find(|handle| {
                        handle
                            .downcast::<ardia_ui::settings::SettingsWindowView>()
                            .is_some()
                    })
                } else if window.as_str() == crate::synthetic_input::ONBOARDING_WINDOW {
                    cx.windows().into_iter().find(|handle| {
                        handle
                            .downcast::<ardia_ui::onboarding::OnboardingWindowView>()
                            .is_some()
                    })
                } else if window.as_str() == crate::synthetic_input::RECORDING_PILL_WINDOW {
                    cx.windows().into_iter().find(|handle| {
                        handle
                            .downcast::<ardia_ui::report::pill::RecordingPillView>()
                            .is_some()
                    })
                } else {
                    self.coordinator.gpui_window(&window)
                };
                let Some(handle) = found else {
                    log::debug!("synthetic input for {window} has no GPUI window");
                    return;
                };
                let (native, steps): (Vec<_>, Vec<_>) =
                    steps.into_iter().partition(|step| step.native().is_some());
                let delivered = handle.update(cx, |_, window, cx| {
                    if !native.is_empty()
                        && let Some(number) = crate::mouse_shortcuts::window_number_of(window)
                    {
                        let scrolls: Vec<_> = native.iter().filter_map(|s| s.native()).collect();
                        crate::synthetic_input::post_native_scrolls(number, &scrolls);
                    }
                    for step in steps {
                        match step {
                            crate::synthetic_input::Step::KeyDown(keystroke) => {
                                window.dispatch_keystroke(keystroke, cx);
                            }
                            other => {
                                window.dispatch_event(other.into_platform_input(), cx);
                            }
                        }
                    }
                    window.refresh();
                });
                if delivered.is_err() {
                    log::debug!("synthetic input for {window} found the window closed");
                }
            }
            ShellEffect::RunCommand {
                window,
                window_number,
                command,
            } => {
                let under_pointer = window_number.and_then(|wanted| {
                    let windows = self.coordinator.bridge.lock().gpui.clone();
                    windows.into_iter().find_map(|(id, handle)| {
                        handle
                            .update(cx, |_, window, _| {
                                crate::mouse_shortcuts::window_number_of(window)
                            })
                            .ok()
                            .flatten()
                            .filter(|number| *number == wanted)
                            .map(|_| id)
                    })
                });
                let state = self.coordinator.store().snapshot();
                let Some(window) = crate::mouse_shortcuts::pick_window(
                    under_pointer,
                    Some(window),
                    |id| state.window(id.as_str()).is_some_and(|w| w.kind.has_tabs()),
                ) else {
                    return;
                };
                let Some(handle) = self.coordinator.gpui_window(&window) else {
                    return;
                };
                let ran = handle.update(cx, |_, window, cx| {
                    window.dispatch_action(ardia_ui::keybindings::action_for(&command), cx);
                });
                if ran.is_err() {
                    log::debug!("a mouse shortcut found {window} closed");
                }
            }
            ShellEffect::AskControlPeer { question, window } => {
                crate::control_doorbell::present(&self.coordinator, question, window, cx);
            }
            ShellEffect::DismissControlPeer { ask } => crate::control_doorbell::dismiss(ask),
            ShellEffect::Quit => match self.mode {
                ShellMode::Hosted => match self.coordinator.engine() {
                    Some(engine) => {
                        if let Err(problem) = engine.quit() {
                            log::warn!("the engine didn't quit: {problem}");
                            cx.quit();
                        }
                    }
                    None => cx.quit(),
                },
                ShellMode::Standalone => cx.quit(),
            },
        }
    }

    fn ask_about_downloads(
        &mut self,
        window: Option<WindowId>,
        question: DownloadsQuestion,
        unanswerable: bool,
        cx: &mut App,
        answer: impl FnOnce(bool) + 'static,
    ) {
        let shown = window
            .and_then(|window| self.coordinator.gpui_window(&window))
            .or_else(|| cx.active_window());
        let prompt = shown.and_then(|handle| {
            handle
                .update(cx, |_, window, cx| {
                    window.prompt(
                        gpui::PromptLevel::Warning,
                        &question.title,
                        Some(&question.detail),
                        &[question.leave.as_str(), DownloadsQuestion::KEEP],
                        cx,
                    )
                })
                .ok()
        });
        match prompt {
            Some(prompt) => cx
                .spawn(async move |_| answer(prompt.await.is_ok_and(|choice| choice == 0)))
                .detach(),
            None => ask_without_a_window(&self.coordinator, question, unanswerable, answer),
        }
    }

    fn open_browser_window(
        &mut self,
        window: WindowId,
        kind: WindowKind,
        host: Option<HostedWindow>,
        cx: &mut App,
    ) {
        if self.coordinator.gpui_window(&window).is_some() {
            return;
        }
        if self
            .coordinator
            .store()
            .snapshot()
            .window(window.as_str())
            .is_none()
        {
            return;
        }
        if let Some(host) = host
            && !self.coordinator.host_alive(&window, host)
        {
            log::debug!("{window}'s engine window closed before it could show");
            return;
        }
        let target = OpenWindowTarget {
            window_id: window.clone(),
            host_window: external(host),
            background: self.coordinator.config().background,
        };
        let ui: Arc<dyn UiHost> = self.coordinator.clone();
        let opening = ardia_profile::window_opening(match kind {
            WindowKind::LittleArdia => ardia_profile::FrameSlot::Little,
            _ => ardia_profile::FrameSlot::Main,
        });
        let opened = match kind {
            WindowKind::LittleArdia => ardia_ui::open_little_ardia_window(ui, target.clone(), cx),
            _ => ardia_ui::open_browser_window(ui, target.clone(), cx),
        };
        opening.opened(opened.as_ref().map_or(0, |h| h.window_id().as_u64()));
        let handle = match opened {
            Ok(handle) => handle,
            Err(problem) => {
                log::info!("ardia-ui didn't open {window} ({problem}), so a placeholder stands in");
                let title = match kind {
                    WindowKind::LittleArdia => "Little Ardia",
                    WindowKind::Incognito => "Ardia — Incognito",
                    _ => "Ardia",
                };
                match open_placeholder(
                    cx,
                    &self.coordinator,
                    Some(window.clone()),
                    title,
                    target.host_window,
                ) {
                    Ok(handle) => handle,
                    Err(problem) => {
                        log::error!("{window} has no window on screen: {problem}");
                        return;
                    }
                }
            }
        };
        self.coordinator
            .register_gpui_window(window.clone(), handle);
        if host.is_some() {
            self.present(&window, handle, cx);
        }
        self.presented_browser = true;
        if let Some(kind) = self.onboarding_waits.take() {
            self.open_utility(kind, cx);
        }
    }

    fn present(&mut self, window: &WindowId, handle: AnyWindowHandle, cx: &mut App) {
        if self.coordinator.present_window(window) != Presentation::Activate {
            return;
        }
        let _ = handle.update(cx, |_, window, _| window.activate_window());
        if !self.activated {
            self.activated = true;
            cx.activate(true);
        }
    }

    fn open_utility(&mut self, kind: UtilityWindowKind, cx: &mut App) {
        if let Some(handle) = self.utility.get(&kind).copied() {
            let background = self.coordinator.config().background;
            let alive = handle
                .update(cx, |_, window, _| {
                    if !background {
                        window.activate_window();
                    }
                })
                .is_ok();
            if alive {
                return;
            }
            self.utility.remove(&kind);
        }
        let ui: Arc<dyn UiHost> = self.coordinator.clone();
        let opening = match kind {
            UtilityWindowKind::Settings => Some(ardia_profile::FrameSlot::Settings),
            UtilityWindowKind::Onboarding => Some(ardia_profile::FrameSlot::Onboarding),
            UtilityWindowKind::Import | UtilityWindowKind::Intro => None,
        }
        .map(ardia_profile::window_opening);
        let opened = match kind {
            UtilityWindowKind::Settings => ardia_ui::open_settings_window(ui, cx),
            UtilityWindowKind::Import => ardia_ui::open_import_window(ui, cx),
            UtilityWindowKind::Onboarding => ardia_ui::open_onboarding_window(ui, cx),
            UtilityWindowKind::Intro => ardia_ui::open_intro_window(ui, cx),
        };
        if let Some(opening) = opening {
            opening.opened(opened.as_ref().map_or(0, |h| h.window_id().as_u64()));
        }
        let handle = match opened {
            Ok(handle) => handle,
            Err(problem) => {
                log::info!("ardia-ui didn't open {kind:?} ({problem}), so a placeholder stands in");
                match open_placeholder(cx, &self.coordinator, None, utility_title(kind), None) {
                    Ok(handle) => handle,
                    Err(problem) => {
                        log::error!("{kind:?} has no window on screen: {problem}");
                        return;
                    }
                }
            }
        };
        self.utility.insert(kind, handle);
    }

    #[cfg(target_os = "macos")]
    fn sync_menu(&mut self, cx: &mut App) {
        use crate::menu_bridge::native;
        let state = self.coordinator.store().snapshot();
        let context = native::menu_context(&state, &self.coordinator.recently_closed());
        let mut titles = self.coordinator.menu_titles(&state);
        let tile_pin = self.coordinator.command_enabled("togglePin", Some("tile"));
        if tile_pin {
            titles.push(("togglePin:tile", native::TILE_PIN_TITLE));
        }
        let routes_undo = state.settings.undo_reopens_closed_tab;
        if routes_undo {
            titles.push(("undo", "Undo"));
        }
        let signature = native::titled_signature(&context, &titles);
        if self.menu_signature == Some(signature) {
            return;
        }
        self.menu_signature = Some(signature);
        let mut bar = native::menu_bar(&context);
        native::retitle(&mut bar, &titles);
        native::add_tile_pin_item(&mut bar, tile_pin);
        if routes_undo {
            native::route_undo(&mut bar);
        }
        match self.mode {
            ShellMode::Hosted => {
                if let Err(problem) = bar.install() {
                    log::warn!("the menu bar didn't install: {problem}");
                }
            }
            ShellMode::Standalone => cx.set_menus(gpui_menus(&bar)),
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn sync_menu(&mut self, _: &mut App) {}
}

#[cfg(target_os = "macos")]
pub fn gpui_menus(bar: &ardia_engine::macos::menu::MenuBar) -> Vec<gpui::Menu> {
    use ardia_engine::macos::menu::{Menu, MenuItem, MenuRole};

    fn items(menu: &Menu) -> Vec<gpui::MenuItem> {
        let mut out = Vec::new();
        for item in &menu.items {
            match item {
                MenuItem::Separator => {
                    if !matches!(out.last(), None | Some(gpui::MenuItem::Separator)) {
                        out.push(gpui::MenuItem::separator());
                    }
                }
                MenuItem::Command(command) if !command.hidden => {
                    out.push(gpui::MenuItem::Action {
                        name: command.title.clone().into(),
                        action: Box::new(MenuCommand {
                            command: command.command.clone(),
                            arg: command.arg.clone(),
                        }),
                        os_action: None,
                        checked: command.checked,
                        disabled: !command.enabled,
                    });
                }
                MenuItem::Submenu(submenu) if submenu.role == Some(MenuRole::Services) => {
                    out.push(gpui::MenuItem::os_submenu(
                        submenu.title.clone(),
                        gpui::SystemMenuType::Services,
                    ));
                }
                MenuItem::Submenu(submenu) if !submenu.hidden => {
                    let children = items(submenu);
                    if !children.is_empty() {
                        out.push(gpui::MenuItem::submenu(gpui::Menu {
                            name: submenu.title.clone().into(),
                            items: children,
                            disabled: false,
                        }));
                    }
                }
                _ => {}
            }
        }
        while matches!(out.last(), Some(gpui::MenuItem::Separator)) {
            out.pop();
        }
        out
    }

    bar.menus
        .iter()
        .map(|menu| gpui::Menu {
            name: menu.title.clone().into(),
            items: items(menu),
            disabled: false,
        })
        .collect()
}

pub fn install(
    cx: &mut App,
    coordinator: Arc<AppCoordinator>,
    mut wakes: UnboundedReceiver<()>,
    mode: ShellMode,
) {
    let executor = cx.foreground_executor().clone();
    coordinator.attach_spawner(move |task| executor.spawn(task).detach());
    #[cfg(target_os = "macos")]
    if mode == ShellMode::Standalone {
        bind_menu_keys(cx);
    }
    ardia_ui::bind_global_keybindings(cx);
    crate::text_services::install(cx, coordinator.clone());
    #[cfg(target_os = "macos")]
    crate::scripting::mac::install(cx, coordinator.clone());
    crate::profiling::observe_keys(cx);
    {
        let coordinator = coordinator.clone();
        cx.on_action(move |action: &MenuCommand, cx| {
            follow_platform_focus(&coordinator, cx);
            coordinator.focus_platform_window();
            if let Err(problem) = coordinator.run_command(&action.command, action.arg.as_deref()) {
                log::debug!("{} didn't run: {problem}", action.command);
            }
        });
    }
    {
        let coordinator = coordinator.clone();
        cx.on_app_quit(move |_| {
            let coordinator = coordinator.clone();
            async move {
                coordinator.begin_shutdown();
                if !coordinator.flush() {
                    log::warn!("the session didn't finish saving before quitting");
                }
                crate::telemetry::quit();
            }
        })
        .detach();
    }
    {
        let coordinator = coordinator.clone();
        cx.on_window_closed(move |_, closed| {
            if let Some(window) = coordinator.state_window_for_gpui(closed) {
                coordinator.unregister_gpui_window(window);
            }
        })
        .detach();
    }
    if coordinator.config().background {
        crate::hidden_frames::keep_drawing(cx);
    }
    let mut shell = Shell::new(coordinator.clone(), mode);
    coordinator.start();
    cx.spawn(async move |cx| {
        loop {
            cx.update(|cx| shell.run_pump(cx));
            if wakes.next().await.is_none() {
                break;
            }
            while wakes.try_recv().is_ok() {}
        }
    })
    .detach();
}

fn follow_platform_focus(coordinator: &AppCoordinator, cx: &App) {
    let active = cx
        .active_window()
        .and_then(|handle| coordinator.state_window_for_gpui(handle.window_id()));
    coordinator.follow_platform_focus(active.as_ref());
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DownloadsQuestion {
    pub title: String,
    pub detail: String,
    pub leave: String,
}

impl DownloadsQuestion {
    pub const KEEP: &'static str = "Keep Downloading";

    pub fn new(count: u32, quitting: bool) -> Self {
        let (leave, leaving) = match (quitting, cfg!(target_os = "windows")) {
            (true, true) => ("Exit", "Exiting Ardia"),
            (true, false) => ("Quit", "Quitting Ardia"),
            (false, _) => ("Close", "Closing the window"),
        };
        let detail = if count == 1 {
            format!("A download is still in progress. {leaving} cancels it.")
        } else {
            format!("{count} downloads are still in progress. {leaving} cancels them.")
        };
        Self {
            title: format!("{leave} and cancel downloads?"),
            detail,
            leave: leave.to_owned(),
        }
    }
}

#[cfg(target_os = "macos")]
fn ask_without_a_window(
    coordinator: &AppCoordinator,
    question: DownloadsQuestion,
    _: bool,
    answer: impl FnOnce(bool) + 'static,
) {
    use ardia_engine::macos::dialogs::Alert;
    let reply = Alert::confirm(
        &question.title,
        &question.detail,
        &question.leave,
        DownloadsQuestion::KEEP,
    )
    .show(None);
    coordinator.spawn(async move {
        answer(reply.await.is_ok_and(|choice| choice.chose(0)));
    });
}

#[cfg(not(target_os = "macos"))]
fn ask_without_a_window(
    _: &AppCoordinator,
    _: DownloadsQuestion,
    unanswerable: bool,
    answer: impl FnOnce(bool) + 'static,
) {
    log::warn!("there's no window to ask about the downloads in");
    answer(unanswerable);
}

#[cfg(target_os = "macos")]
fn bind_menu_keys(cx: &mut App) {
    use crate::menu_bridge::native;
    let bar = native::menu_bar(&ardia_engine::macos::menu::MenuContext {
        app_name: "Ardia".into(),
        ..Default::default()
    });
    let mut bindings = Vec::new();
    for (command, arg, keys) in native::commands_with_keys(&bar) {
        match gpui::KeyBinding::load(
            &keys,
            Box::new(MenuCommand { command, arg }),
            None,
            false,
            None,
            cx,
        ) {
            Ok(binding) => bindings.push(binding),
            Err(problem) => log::debug!("{keys} isn't a GPUI keystroke: {problem:?}"),
        }
    }
    cx.bind_keys(bindings);
}

impl AppCoordinator {
    pub fn state_window_for_gpui(&self, closed: gpui::WindowId) -> Option<WindowId> {
        self.bridge
            .lock()
            .gpui
            .iter()
            .find(|(_, handle)| handle.window_id() == closed)
            .map(|(window, _)| window.clone())
    }

    pub fn reopen(&self) {
        ardia_telemetry::counts::count("dock_reopens");
        let state = self.store().snapshot();
        let shown = state
            .focus_order
            .iter()
            .find(|w| state.window(w.as_str()).is_some_and(|w| w.kind.has_tabs()))
            .cloned();
        match shown {
            Some(window) => self.effect(ShellEffect::FocusWindow { window }),
            None => {
                self.dispatch_quietly(Action::OpenLastWindowOrNew);
                self.mark_dirty();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::DownloadsQuestion;

    #[test]
    fn the_downloads_question_names_what_cancels_them() {
        let closing = DownloadsQuestion::new(1, false);
        assert_eq!(closing.title, "Close and cancel downloads?");
        assert_eq!(
            closing.detail,
            "A download is still in progress. Closing the window cancels it."
        );
        let quitting = DownloadsQuestion::new(3, true);
        let word = if cfg!(target_os = "windows") {
            "Exit"
        } else {
            "Quit"
        };
        assert_eq!(quitting.leave, word);
        assert!(
            quitting
                .detail
                .starts_with("3 downloads are still in progress.")
        );
        assert!(quitting.detail.ends_with("cancels them."));
    }
}
