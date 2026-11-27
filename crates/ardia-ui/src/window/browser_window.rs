use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::model::{EffectiveLayout, SidebarSide};
use ardia_state::omnibox::url::resolve_input;
use ardia_state::tabs::{FindState, Tab};
use ardia_state::windows::{CommandBarPlacementState, CommandBarState, NewTabTarget, Popover};
use ardia_state::{
    Action, BrowserState, GroupId, Interest, NewTab, ProfileId, TabId, Topics, WindowId,
};
use ardia_theme::FieldSurface;
use ardia_theme::motion::ARC_HIDE_MS;
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, IntoElement, MouseButton, NativeView,
    ParentElement, Render, SharedString, Styled, Subscription, Task, Window, deferred, div,
    prelude::*,
};

use crate::content::find_bar::find_bar;
use crate::content::peek_overlay::peek_overlay;
use crate::content::split_view::{pane_rects, resized, split_view};
use crate::content::toolbar::{is_new_tab_page, toolbar};
use crate::content::web_slot::{SlotCorners, placeholder, web_slot};
use crate::host::UiHost;
use crate::host_data::{HostLink, HostTopics};
use crate::keybindings::{self, Dismiss, RunCommand, RunReservedCommand};
use crate::look::{Look, UI_FONT};
use crate::msg::{Emit, FindMsg, Msg, RenameTarget};
use crate::ntp::new_tab_page;
use crate::omnibox::{CommandPanel, PanelRequest, command_panel};
use crate::popovers::cast::cast_popover;
use crate::popovers::context_menu::{context_menu_cached, forget_cached_menu};
use crate::popovers::downloads::downloads;
use crate::popovers::extensions::extension_popup;
use crate::popovers::prompts::close_with_downloads;
use crate::popovers::toast::toasts;
use crate::primitives::text_input::{InputEvent, InputStyle, SubmitKind, TextInput};
use crate::primitives::theme_bridge::{
    blend_backdrops, hsla, traffic_light_origin, tucked_traffic_lights,
};
use crate::sidebar::model::{clearable, sections};
use crate::sidebar::{docked_sidebar, floating_sidebar, tab_strip};
use crate::store_link::StoreLink;
use crate::window::backdrop::BackdropDriver;
use crate::window::chrome::{Chrome, ChromeUi};
use crate::window::layout::{ChromeLayout, LayoutInput, Rect, chrome_layout};
use crate::window::motion::{Curve, DOCK_SLIDE_MS, DockMove, Motion, dock_move};
use crate::window::native_views::NativeViews;
use crate::window::page_overlays::{
    OverlayInput, PaneOverlayMsg, PaneOverlays, shown_notice, shows_empty_card,
};
use crate::window::profile_pager::{PagerOutcome, ProfilePager, neighbour_backdrop};
use crate::window::retiring_page::{RETIRING_SUFFIX, retiring_slot, retiring_swap, shows_retiring};

#[derive(Clone, Debug, PartialEq)]
pub enum Destination {
    Active,
    NewTab,
    Group(GroupId),
    Into(TabId),
}

impl Destination {
    pub fn of(target: Option<NewTabTarget>, alternate: bool) -> Self {
        match target {
            Some(NewTabTarget::Into(tab)) => Destination::Into(tab),
            Some(NewTabTarget::Group(group)) => Destination::Group(group),
            Some(NewTabTarget::List) => Destination::NewTab,
            None if alternate => Destination::NewTab,
            None => Destination::Active,
        }
    }
}
pub const PROFILE_SLIDE: f32 = 24.0;
pub const PAGE_FOCUS_RESTORE_WINDOW: Duration = Duration::from_secs(1);

thread_local! {
    static DISMISSING_BY_KEY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[derive(Clone, Debug, PartialEq)]
pub struct SidebarResizeDrag;

pub struct BrowserWindowView {
    pub(crate) host: Arc<dyn UiHost>,
    pub(crate) window_id: WindowId,
    pub(crate) state: Arc<BrowserState>,
    pub(crate) look: Look,
    pub(crate) emit: Emit,
    pub(crate) focus: FocusHandle,
    pub(crate) panel: CommandPanel,
    pub(crate) find_input: Entity<TextInput>,
    pub(crate) replace_input: Entity<TextInput>,
    pub(crate) rename_input: Entity<TextInput>,
    pub(crate) people: Entity<crate::profiles::layer::PeopleLayer>,
    pub(crate) report_sheet: Entity<crate::report::sheet::ReportSheetView>,
    pub(crate) site: crate::site::SiteUi,
    pub(crate) downloads_motion: crate::popovers::downloads::Motion,
    pub(crate) split_empty: crate::content::split_empty::SplitEmptyPanes,
    pub(crate) natives: NativeViews,
    pub(crate) popup_natives: NativeViews,
    pub(crate) backdrop: BackdropDriver,
    pub(crate) ui: ChromeUi,
    pub(crate) dock: Motion,
    pub(crate) peek: Motion,
    pub(crate) peek_motion: crate::content::peek_motion::PeekDriver,
    pub(crate) sidebar_edge: crate::window::sidebar_peek::SidebarEdge,
    pub(crate) profile_switch: Option<(Instant, f32)>,
    pub(crate) shown_profile: ProfileId,
    pub(crate) confirm_close: bool,
    pub(crate) layout: Option<ChromeLayout>,
    app_appearance: Option<ardia_state::settings::Appearance>,
    pub(crate) overlays: PaneOverlays,
    swipe: crate::window::swipe_overlay::SwipeOverlay,
    pub(crate) pager: ProfilePager,
    focus_tab: Option<TabId>,
    pending_page_focus: Option<(TabId, Instant)>,
    title: String,
    toast_timers: HashMap<u64, Task<()>>,
    toast_focus: [FocusHandle; 2],
    removed: bool,
    gpui_window: gpui::WindowId,
    focus_watch: HashMap<usize, Subscription>,
    last_bar: Option<CommandBarState>,
    find_tab: Option<TabId>,
    synced: Option<(Arc<ardia_state::settings::Settings>, Arc<Vec<ProfileId>>)>,
    page_full_screen: crate::window::page_full_screen::PageFullScreen,
    restore_tick: Option<Task<()>>,
    covers: Option<crate::window::page_full_screen::Covers>,
    cover_task: Option<Task<()>>,
    uncover_tick: Option<Task<()>>,
    _store: StoreLink,
    _host: HostLink,
    _subscriptions: Vec<Subscription>,
}

impl Focusable for BrowserWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn input_style(look: &Look, surface: FieldSurface, font_size: f32) -> InputStyle {
    let p = &look.p;
    InputStyle {
        text: p.command_text,
        placeholder: p.command_placeholder,
        caret: hsla(look.theme.caret_color(surface)),
        selection: p.selection,
        font_size,
        weight: gpui::FontWeight::NORMAL,
    }
}

fn backdrop_frame(window: &Window, layout: Option<&ChromeLayout>) -> [f32; 4] {
    match layout {
        Some(layout) => {
            let focus = layout
                .sidebar
                .or(layout.peek)
                .map_or([layout.width / 2.0, layout.height / 2.0], |rect| {
                    [rect.x + rect.w / 2.0, rect.y + rect.h / 2.0]
                });
            [layout.width, layout.height, focus[0], focus[1]]
        }
        None => {
            let size = window.viewport_size();
            let (width, height) = (f32::from(size.width), f32::from(size.height));
            [width, height, width / 2.0, height / 2.0]
        }
    }
}

impl BrowserWindowView {
    pub fn new(
        host: Arc<dyn UiHost>,
        window_id: WindowId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = host.store().snapshot();
        crate::scale::sync(&state, cx);
        crate::look::note_window_glass(window);
        let look = Look::new(&state, window_id.as_str(), window.appearance());
        host.note_system_dark(crate::look::system_dark(window.appearance()));
        let emit = Emit::new(cx.weak_entity(), Self::handle);
        let panel = CommandPanel::new(cx);
        let find_input =
            cx.new(|cx| TextInput::new(crate::content::find_bar::FIND_PLACEHOLDER, cx));
        let replace_input =
            cx.new(|cx| TextInput::new(crate::content::find_bar::REPLACE_PLACEHOLDER, cx));
        let rename_input = cx.new(|cx| TextInput::new("Name", cx));
        let people = cx.new(|_| {
            crate::profiles::layer::PeopleLayer::new(Arc::clone(&host), window_id.clone())
        });
        let report_sheet = cx.new(|cx| {
            crate::report::sheet::ReportSheetView::new(
                Arc::clone(&host),
                window_id.clone(),
                window,
                cx,
            )
        });
        let rename_focus = rename_input.focus_handle(cx);
        let sidebar_edge = crate::window::sidebar_peek::SidebarEdge::new(window, cx);
        let toast_focus = [cx.focus_handle(), cx.focus_handle()];
        let mut subscriptions = vec![
            cx.subscribe_in(&panel.input, window, Self::on_panel_input),
            cx.subscribe_in(&find_input, window, Self::on_find_input),
            cx.subscribe_in(&replace_input, window, Self::on_replace_input),
            cx.subscribe_in(&rename_input, window, Self::on_rename_input),
            cx.on_blur(&rename_focus, window, |this, window, cx| {
                this.commit_rename(window, cx)
            }),
            cx.on_release(|this, cx| this.release(cx)),
            cx.observe_window_appearance(window, |this, window, cx| this.restyle(window, cx)),
            cx.observe_window_activation(window, |this, window, cx| {
                this.restyle(window, cx);
                this.restore_focus_on_activation(window, cx);
            }),
        ];
        for handle in &toast_focus {
            subscriptions.push(cx.on_focus_in(handle, window, |this, window, cx| {
                this.toast_focus_changed(window, cx)
            }));
            subscriptions.push(cx.on_blur(handle, window, |this, window, cx| {
                this.toast_focus_changed(window, cx)
            }));
        }
        let store = StoreLink::new(
            host.store(),
            Interest::Topics(Topics::ALL),
            window,
            cx,
            Self::on_store,
        );
        let host_link = HostLink::new(
            host.host_signal(),
            HostTopics::EXTENSIONS
                | HostTopics::CAST
                | HostTopics::PAGE
                | HostTopics::PLUGINS
                | HostTopics::SITE,
            window,
            cx,
            Self::on_host_data,
        );
        let shown = state.sidebar_shown(window_id.as_str());
        let profile = state
            .window(window_id.as_str())
            .map(|w| w.profile_id.clone())
            .unwrap_or_else(ProfileId::default_profile);
        let closer = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            closer
                .update(cx, |view, cx| view.request_close(window, cx))
                .is_err()
        });
        let mut view = BrowserWindowView {
            host,
            window_id,
            state: Arc::clone(&state),
            look,
            emit,
            focus: cx.focus_handle(),
            panel,
            find_input,
            replace_input,
            rename_input,
            people,
            report_sheet,
            site: crate::site::SiteUi::new(),
            downloads_motion: crate::popovers::downloads::Motion::default(),
            split_empty: Default::default(),
            natives: NativeViews::default(),
            popup_natives: NativeViews::default(),
            backdrop: BackdropDriver::default(),
            ui: ChromeUi {
                profile_alpha: 1.0,
                ..ChromeUi::default()
            },
            dock: Motion::rest(if shown { 1.0 } else { 0.0 }),
            peek: Motion::rest(0.0),
            peek_motion: Default::default(),
            sidebar_edge,
            profile_switch: None,
            shown_profile: profile,
            confirm_close: false,
            layout: None,
            app_appearance: None,
            overlays: PaneOverlays::default(),
            swipe: Default::default(),
            pager: ProfilePager::default(),
            focus_tab: None,
            pending_page_focus: None,
            title: String::new(),
            toast_timers: HashMap::new(),
            toast_focus,
            removed: false,
            gpui_window: window.window_handle().window_id(),
            focus_watch: HashMap::new(),
            last_bar: None,
            find_tab: None,
            page_full_screen: Default::default(),
            restore_tick: None,
            covers: None,
            cover_task: None,
            uncover_tick: None,
            synced: None,
            _store: store,
            _host: host_link,
            _subscriptions: subscriptions,
        };
        view.sync_shortcuts(cx);
        view.sync_app_appearance(cx);
        view.backdrop
            .aim(view.backdrop_spec(window), false, Instant::now());
        view.backdrop.apply(window, Instant::now());
        window.focus(&view.focus, cx);
        view
    }

    pub fn window_id(&self) -> &WindowId {
        &self.window_id
    }

    pub fn state(&self) -> &Arc<BrowserState> {
        &self.state
    }

    pub fn look(&self) -> &Look {
        &self.look
    }

    pub fn ui(&self) -> &ChromeUi {
        &self.ui
    }

    pub fn panel(&self) -> &CommandPanel {
        &self.panel
    }

    pub fn chrome_layout(&self) -> Option<ChromeLayout> {
        self.layout
    }

    pub fn backdrop(&self) -> &BackdropDriver {
        &self.backdrop
    }

    pub fn active_tab(&self) -> Option<Arc<Tab>> {
        self.state.active_tab(self.window_id.as_str()).cloned()
    }

    pub(crate) fn reduce_motion(&self, cx: &App) -> bool {
        cx.reduce_motion()
    }

    fn sync_app_appearance(&mut self, cx: &mut App) {
        crate::primitives::hover_fill::set_press_motion(self.state.settings.press_motion, cx);
        let setting = self.state.settings.appearance;
        if self.app_appearance != Some(setting) {
            self.app_appearance = Some(setting);
            cx.set_window_appearance(crate::look::app_appearance(setting));
        }
    }

    fn backdrop_spec(&self, window: &Window) -> gpui::BackdropLayerSpec {
        self.backdrop_spec_in(window, backdrop_frame(window, self.layout.as_ref()))
    }

    fn backdrop_spec_in(&self, window: &Window, frame: [f32; 4]) -> gpui::BackdropLayerSpec {
        let [width, height, x, y] = frame;
        self.look
            .backdrop_in(crate::window::looks_active(window), [width, height], [x, y])
    }

    fn restyle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.host
            .note_system_dark(crate::look::system_dark(window.appearance()));
        self.look
            .refresh(&self.state, self.window_id.as_str(), window.appearance());
        self.backdrop
            .aim(self.backdrop_spec(window), false, Instant::now());
        cx.notify();
    }

    pub(crate) fn dispatch(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        if self.peek_motion_takes(&action, cx) {
            return;
        }
        self.host.dispatch(action);
        self.on_store(Topics::ALL, window, cx);
    }

    fn on_host_data(&mut self, topics: HostTopics, window: &mut Window, cx: &mut Context<Self>) {
        if !self.removed {
            if topics.contains(HostTopics::SITE) {
                self.selection_changed(cx);
            }
            if topics.contains(HostTopics::PAGE) {
                self.page_swipes(window, cx);
            }
            cx.notify();
        }
    }

    fn page_swipes(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let now = Instant::now();
        for swipe in self.host.take_page_swipes(&self.window_id) {
            let host = Arc::clone(&self.host);
            let items = crate::window::swipe_overlay::items_for(host.as_ref(), &swipe.tab);
            let out = self
                .swipe
                .on_swipe(&swipe, self.swipe.pane_height(), items, now);
            let state = Arc::clone(&self.state);
            for msg in crate::window::swipe_overlay::effects_msgs(
                &state,
                host.as_ref(),
                &self.window_id,
                out,
            ) {
                self.handle(msg, window, cx);
            }
        }
    }

    pub(crate) fn on_store(&mut self, topics: Topics, window: &mut Window, cx: &mut Context<Self>) {
        if self.removed {
            return;
        }
        let next = self.host.store().snapshot();
        let changed = !Arc::ptr_eq(&next, &self.state);
        self.state = next;
        crate::scale::sync(&self.state, cx);
        self.sync_app_appearance(cx);
        let Some(browser) = self.state.window(self.window_id.as_str()).cloned() else {
            self.release(cx);
            window.remove_window();
            return;
        };
        if !changed && !topics.contains(Topics::ALL) {
            return;
        }
        if let Some(Popover::Custom(name)) = &browser.chrome.popover
            && let Some(command) = name.strip_prefix("command:").map(str::to_owned)
        {
            self.host.dispatch(Action::SetPopover {
                window: self.window_id.clone(),
                popover: None,
            });
            self.run_command(&command, window, cx);
            return;
        }
        let now = Instant::now();
        let switched = browser.profile_id != self.shown_profile;
        if self
            .look
            .refresh(&self.state, self.window_id.as_str(), window.appearance())
        {
            self.backdrop.aim(
                self.backdrop_spec(window),
                switched && !self.reduce_motion(cx),
                now,
            );
        }
        if switched {
            let order = &self.state.profile_order;
            let from = order.iter().position(|p| *p == self.shown_profile);
            let to = order.iter().position(|p| *p == browser.profile_id);
            let direction = match (from, to) {
                (Some(from), Some(to)) if to < from => -1.0,
                _ => 1.0,
            };
            self.shown_profile = browser.profile_id.clone();
            crate::press_telemetry::profile_switched(&browser, self.state.profiles.len(), window);
            if !self.reduce_motion(cx) {
                self.profile_switch = Some((now, direction));
            }
        }
        let shown = self.state.sidebar_shown(self.window_id.as_str());
        let target = if shown { 1.0 } else { 0.0 };
        if (self.dock.target() - target).abs() > f32::EPSILON {
            let arc =
                self.state.effective_layout(self.window_id.as_str()) == EffectiveLayout::ArcSidebar;
            let (duration, curve) = match dock_move(
                shown,
                !self.reduce_motion(cx),
                arc,
                self.peek.target() > 0.5,
            ) {
                DockMove::Jump => (Duration::ZERO, Curve::Linear),
                DockMove::ArcHide => (Duration::from_millis(ARC_HIDE_MS), Curve::EaseOut),
                DockMove::Slide => (Duration::from_millis(DOCK_SLIDE_MS), Curve::DockSlide),
            };
            if !duration.is_zero() {
                ardia_telemetry::counts::count("sidebar_slides");
            }
            self.dock.go(target, duration, curve, now);
            self.sidebar_dock_changed(shown);
            if shown {
                self.peek.snap(0.0);
            }
        }
        let bar = browser.chrome.command_bar.clone();
        if bar.open && (!self.panel.is_open() || self.last_bar.as_ref() != Some(&bar)) {
            self.last_bar = Some(bar.clone());
            self.prepare_panel(bar.initial_text, bar.new_tab, bar.placement, window, cx);
        } else if !bar.open {
            self.last_bar = None;
            if self.panel.is_open() && !self.panel.is_hero() {
                self.panel.close();
                if self
                    .active_tab()
                    .is_some_and(|t| !is_new_tab_page(Some(&t)))
                {
                    ardia_telemetry::counts::count("page_focus_returns_after_bar");
                }
                self.refocus_page(window, cx);
            }
        }
        self.sync_hero(window, cx);
        self.show_over_empty_card(window, cx);
        self.sync_find(cx);
        self.sync_split_empty(window, cx);
        let state = Arc::clone(&self.state);
        let own = self.window_id.clone();
        self.natives.retain(
            self.gpui_window,
            |tab| {
                let tab = tab.as_str();
                state
                    .tab(tab.strip_suffix(RETIRING_SUFFIX).unwrap_or(tab))
                    .is_some_and(|t| t.window_id == own)
            },
            cx,
        );
        let attached: Vec<usize> = self
            .natives
            .attached()
            .map(|(_, pointer)| pointer)
            .collect();
        self.focus_watch
            .retain(|pointer, _| attached.contains(pointer));
        self.sync_shortcuts(cx);
        self.schedule_toasts(&browser.chrome.toasts, cx);
        if let Some(rename) = &self.ui.rename {
            let alive = match rename {
                RenameTarget::Tab(tab) => self.state.tab(tab.as_str()).is_some(),
                RenameTarget::Group(group) => self.state.group(group.as_str()).is_some(),
            };
            if !alive {
                self.ui.rename = None;
            }
        }
        self.settle_focus(window, cx);
        self.restore_page_focus(window, cx);
        cx.notify();
    }

    fn settle_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let find_open = self.active_tab().is_some_and(|t| t.live.find.open);
        let stranded = (self.find_input.focus_handle(cx).is_focused(window) && !find_open)
            || (self.replace_input.focus_handle(cx).is_focused(window) && !find_open)
            || (self.panel.input.focus_handle(cx).is_focused(window) && !self.panel.is_open())
            || (self.rename_input.focus_handle(cx).is_focused(window) && self.ui.rename.is_none());
        if stranded {
            self.refocus_page(window, cx);
        }
    }

    fn release(&mut self, cx: &mut App) {
        if self.removed {
            return;
        }
        self.removed = true;
        self.focus_watch.clear();
        self.natives.release_all(self.gpui_window, cx);
        self.popup_natives.release_all(self.gpui_window, cx);
        crate::window::WindowRegistry::remove(&self.window_id, cx);
        self.host.unregister_gpui_window(self.window_id.clone());
    }

    fn sync_shortcuts(&mut self, cx: &mut App) {
        let current = (
            Arc::clone(&self.state.settings),
            Arc::clone(&self.state.profile_order),
        );
        let same = self.synced.as_ref().is_some_and(|(settings, profiles)| {
            Arc::ptr_eq(settings, &current.0) && Arc::ptr_eq(profiles, &current.1)
        });
        if !same {
            keybindings::sync(&self.state, cx);
            self.synced = Some(current);
        }
    }

    fn sync_find(&mut self, cx: &mut Context<Self>) {
        let Some(active) = self.active_tab() else {
            return;
        };
        if !active.live.find.open || self.find_tab.as_ref() == Some(&active.id) {
            return;
        }
        self.find_tab = Some(active.id.clone());
        let query = active.live.find.query.clone();
        self.find_input
            .update(cx, |input, cx| input.set_text(query, true, cx));
    }

    pub(crate) fn request_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let downloading = self.state.downloads.items().iter().any(|d| d.is_active());
        if downloading && !self.confirm_close {
            self.confirm_close = true;
            cx.notify();
            return;
        }
        self.confirm_close = false;
        self.host.request_window_close(self.window_id.clone());
        self.on_store(Topics::ALL, window, cx);
    }

    fn shown_two_button_toast(&self) -> Option<u64> {
        self.state
            .window(self.window_id.as_str())
            .and_then(|w| w.chrome.toasts.back())
            .filter(|toast| crate::popovers::toast::holds_on_hover(toast))
            .map(|toast| toast.id)
    }

    fn toast_focus_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let focused = self
            .toast_focus
            .iter()
            .any(|handle| handle.is_focused(window));
        let id = match (
            focused,
            self.ui.toast_hold.focused,
            self.shown_two_button_toast(),
        ) {
            (true, _, Some(id)) => id,
            (false, Some(id), _) => id,
            _ => return,
        };
        self.handle(
            Msg::ToastHeld {
                id,
                by: crate::popovers::toast::HoldBy::Focus,
                held: focused,
            },
            window,
            cx,
        );
    }

    fn tab_into_toast(
        &mut self,
        event: &gpui::KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let on_toast = self
            .toast_focus
            .iter()
            .any(|handle| handle.is_focused(window));
        if event.keystroke.key != "tab"
            || self.shown_two_button_toast().is_none()
            || !(on_toast || self.focus.is_focused(window))
        {
            return;
        }
        cx.stop_propagation();
        let back = event.keystroke.modifiers.shift;
        let target = match (on_toast, back) {
            (false, false) => 0,
            (false, true) => 1,
            (true, _) => usize::from(self.toast_focus[0].is_focused(window)),
        };
        window.focus(&self.toast_focus[target], cx);
    }

    fn schedule_toasts(
        &mut self,
        toasts: &std::collections::VecDeque<ardia_state::windows::Toast>,
        cx: &mut Context<Self>,
    ) {
        self.toast_timers
            .retain(|id, _| toasts.iter().any(|toast| toast.id == *id));
        let now = ardia_state::store::now_ms();
        self.ui
            .toast_hold
            .forget(|id| toasts.iter().any(|t| t.id == id));
        let hold = self.ui.toast_hold;
        for toast in toasts {
            let Some(expires) = hold.deadline(toast) else {
                self.toast_timers.remove(&toast.id);
                continue;
            };
            if self.toast_timers.contains_key(&toast.id) {
                continue;
            }
            let wait = Duration::from_millis(expires.saturating_sub(now).max(0) as u64)
                + crate::primitives::sheets::TOAST_FADE_OUT.0;
            let id = toast.id;
            let window = self.window_id.clone();
            let task = cx.spawn(async move |this, cx| {
                cx.background_executor().timer(wait).await;
                let _ = this.update(cx, |view, _| {
                    view.host.dispatch(Action::DismissToast { window, id });
                });
            });
            self.toast_timers.insert(toast.id, task);
        }
    }

    pub(crate) fn handle(&mut self, msg: Msg, window: &mut Window, cx: &mut Context<Self>) {
        if let Msg::Store(action) = &msg
            && self.peek_motion_takes(action, cx)
        {
            return;
        }
        let Some(msg) = msg.deliver(&*self.host, Some(&self.window_id), cx) else {
            self.on_store(Topics::ALL, window, cx);
            return;
        };
        match msg {
            Msg::Command(id) if crate::onboarding::tour::handle(&id, cx) => cx.notify(),
            Msg::Command(id) => self.run_command(&id, window, cx),
            Msg::PickTab { tab, toggle, range } => self.pick_tab(tab, toggle, range, window, cx),
            Msg::PickTabIntoGroup(tab) => self.pick_tab_into_group(tab, window, cx),
            Msg::CloseTab(tab) => {
                if self.state.split_of(tab.as_str()).is_some() {
                    ardia_telemetry::counts::count("split_pane_closes");
                }
                self.dispatch(
                    Action::CloseTabs {
                        tabs: vec![tab],
                        last_closes_window: false,
                    },
                    window,
                    cx,
                )
            }
            Msg::ClearUnpinned => self.clear_unpinned(window, cx),
            Msg::UndoClear => self.dispatch(
                Action::UndoClear {
                    window: self.window_id.clone(),
                },
                window,
                cx,
            ),
            Msg::DismissToast(id) => self.dispatch(
                Action::DismissToast {
                    window: self.window_id.clone(),
                    id,
                },
                window,
                cx,
            ),
            Msg::ToastHeld { id, by, held } => {
                let mut hold = self.ui.toast_hold;
                hold.press(id, by, held, ardia_state::store::now_ms());
                if hold != self.ui.toast_hold {
                    self.ui.toast_hold = hold;
                    self.toast_timers.remove(&id);
                    let toasts = self
                        .state
                        .window(self.window_id.as_str())
                        .map(|w| w.chrome.toasts.clone());
                    if let Some(toasts) = toasts {
                        self.schedule_toasts(&toasts, cx);
                    }
                    cx.notify();
                }
            }
            Msg::ToastAction { id, command } => {
                if self
                    .toast_focus
                    .iter()
                    .any(|handle| handle.is_focused(window))
                {
                    window.focus(&self.focus, cx);
                }
                self.dispatch(
                    Action::DismissToast {
                        window: self.window_id.clone(),
                        id,
                    },
                    window,
                    cx,
                );
                match crate::popovers::toast::reveal_target(&command) {
                    Some(path) => self.host.reveal_path(path.to_owned()),
                    None if self.host.toast_command(&command) => {}
                    None => self.run_command(&command, window, cx),
                }
            }
            Msg::OpenCommandPanel { new_tab, text } => self.open_panel(new_tab, text, window, cx),
            Msg::PickSuggestion(index) => {
                self.panel_msg(crate::omnibox::PanelMsg::Pick(index), window, cx)
            }
            Msg::SubmitPanel { alternate } => self.submit_panel(alternate, window, cx),
            Msg::Panel(msg) => self.panel_msg(msg, window, cx),
            Msg::CloseOverlays => self.dismiss(window, cx),
            Msg::TogglePopover(popover) => self.toggle_popover(popover, window, cx),
            Msg::UrlHover(hovered) => {
                if self.ui.url_hover != hovered {
                    self.ui.url_hover = hovered;
                    cx.notify();
                }
            }
            Msg::Menu(menu) => {
                self.ui.menu = menu;
                cx.notify();
            }
            Msg::EditPinnedUrl(tab) => {
                let state = Arc::clone(&self.state);
                crate::popovers::pin_prompts::edit_pinned_url(
                    &self.host,
                    &self.emit,
                    &self.window_id,
                    &state,
                    &tab,
                    window,
                    cx,
                );
            }
            Msg::RenameTileFolder(folder) => {
                let state = Arc::clone(&self.state);
                crate::popovers::pin_prompts::rename_folder(
                    &self.host,
                    &self.emit,
                    &self.window_id,
                    &state,
                    &folder,
                    window,
                    cx,
                );
            }
            Msg::NewTileFolder(tab) => crate::popovers::pin_prompts::new_folder_with_tab(
                &self.host,
                &self.emit,
                &self.window_id,
                &tab,
                window,
                cx,
            ),
            Msg::AskRemoveExtension(extension) => {
                crate::popovers::extension_menus::ask_remove_extension(
                    &self.host,
                    &self.window_id,
                    &self.emit,
                    &extension,
                    window,
                    cx,
                );
            }
            Msg::Rename(target) => self.start_rename(target, window, cx),
            Msg::EdgeHover(hovered) => self.sidebar_edge_strip(hovered, window, cx),
            Msg::PeekHover(hovered) => self.sidebar_peek_hover(hovered, window, cx),
            Msg::SidebarWidth(width) => {
                if self.ui.sidebar_drag.is_none() && self.peek.target() > 0.5 {
                    ardia_telemetry::counts::count("sidebar_peek_resizes");
                }
                let limit = ardia_theme::layout::sidebar_width_limit(Some(crate::scale::points(
                    window.viewport_size().width,
                )));
                self.ui.sidebar_drag = Some(crate::sidebar::resize::rubber_band(
                    width,
                    ardia_theme::layout::SIDEBAR_MIN_WIDTH,
                    limit,
                ));
                cx.notify();
            }
            Msg::SidebarResized => {
                if let Some(width) = self.ui.sidebar_drag.take() {
                    ardia_telemetry::counts::count("sidebar_resizes");
                    self.resize_sidebar(width, window, cx);
                    cx.notify();
                }
            }
            Msg::SplitDrag {
                split,
                handle,
                fraction,
            } => {
                if let Some(view) = self.state.split(split.as_str())
                    && let Some(sizes) = resized(view, handle, f64::from(fraction))
                {
                    self.dispatch(Action::ResizeSplit { split, sizes }, window, cx);
                }
            }
            Msg::DropTab {
                tab,
                before,
                group,
                pin,
            } => self.drop_tab(tab, before, group, pin, window, cx),
            Msg::Find(find) => self.find(find, window, cx),
            Msg::MoveTabsToWindow {
                tabs,
                window: target,
            } => self.move_tabs_to_window(tabs, target, window, cx),
            Msg::MoveGroupToWindow {
                group,
                window: target,
            } => self.move_group_to_window(group, target, window, cx),
            Msg::GroupToBookmarksBar(group) => self.group_to_bookmarks_bar(group, window, cx),
            Msg::BookmarkTabsToNewFolder(tabs) => self.bookmark_tabs_to_new_folder(tabs, cx),
            Msg::SplitEmpty { tab, msg } => self.split_empty_msg(tab, msg, window, cx),
            Msg::NewTabInGroup(group) => self.new_tab_in_group(group, window, cx),
            Msg::PaneOverlay(msg) => self.pane_overlay(msg, window, cx),
            Msg::Site(msg) => self.site_msg(msg, window, cx),
            Msg::People(msg) => self
                .people
                .update(cx, |layer, cx| layer.handle(msg, window, cx)),
            Msg::ConfirmClose(close) => {
                self.confirm_close = false;
                if close {
                    self.host.request_window_close(self.window_id.clone());
                }
                cx.notify();
            }
            _ => {}
        }
    }

    fn pick_tab(
        &mut self,
        tab: TabId,
        toggle: bool,
        range: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(browser) = self.state.window(self.window_id.as_str()).cloned() else {
            return;
        };
        self.ui.menu = None;
        if toggle || range {
            let mut selection = browser.chrome.selection.clone();
            if selection.is_empty()
                && let Some(active) = browser.active_tab()
            {
                selection.push(active.clone());
            }
            if range {
                let order = sections(&self.state, self.window_id.as_str()).ordered_tabs();
                let anchor = browser
                    .chrome
                    .selection_anchor
                    .clone()
                    .or_else(|| browser.active_tab().cloned());
                let from = anchor.and_then(|a| order.iter().position(|t| *t == a));
                let to = order.iter().position(|t| *t == tab);
                if let (Some(from), Some(to)) = (from, to) {
                    crate::press_telemetry::note_range_select(
                        browser.chrome.selection_anchor.is_none(),
                    );
                    let (low, high) = (from.min(to), from.max(to));
                    selection = order[low..=high].to_vec();
                    if from > to {
                        selection.reverse();
                    }
                }
            } else if let Some(at) = selection.iter().position(|t| *t == tab) {
                selection.remove(at);
            } else {
                selection.push(tab);
            }
            self.dispatch(
                Action::SelectTabs {
                    window: self.window_id.clone(),
                    tabs: selection,
                },
                window,
                cx,
            );
            return;
        }
        if !browser.chrome.selection.is_empty() {
            self.host.dispatch(Action::SelectTabs {
                window: self.window_id.clone(),
                tabs: Vec::new(),
            });
        }
        if browser.active_tab() != Some(&tab) {
            self.dispatch(Action::ActivateTab { tab }, window, cx);
        } else {
            self.on_store(Topics::ALL, window, cx);
        }
    }

    fn pick_tab_into_group(&mut self, tab: TabId, window: &mut Window, cx: &mut Context<Self>) {
        if !self.state.settings.opt_shift_click_opens_in_group {
            return self.pick_tab(tab, false, true, window, cx);
        }
        let unpinned = |id: &TabId| self.state.tab(id.as_str()).is_some_and(|t| t.pin.is_none());
        let active = self
            .state
            .window(self.window_id.as_str())
            .and_then(|w| w.active_tab().cloned())
            .filter(|active| *active != tab && unpinned(active) && unpinned(&tab));
        if let Some(active) = active {
            let joining = match self.state.group_of(active.as_str()) {
                Some(group) => Action::AddToGroup {
                    group: group.id.clone(),
                    tabs: vec![tab.clone()],
                },
                None => Action::CreateGroup {
                    tabs: vec![active, tab.clone()],
                    name: String::new(),
                },
            };
            self.host.dispatch(joining);
        }
        self.pick_tab(tab, false, false, window, cx);
    }

    pub(crate) fn clear_unpinned(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let count = clearable(&self.state, self.window_id.as_str()).len();
        if count == 0 {
            return;
        }
        self.dispatch(
            Action::ClearUnpinned {
                window: self.window_id.clone(),
            },
            window,
            cx,
        );
        crate::sidebar::overflow_menu::note_tabs_cleared(None);
        let message = if count == 1 {
            "Cleared 1 Tab".to_owned()
        } else {
            format!("Cleared {count} Tabs")
        };
        self.dispatch(
            Action::PushToast {
                window: self.window_id.clone(),
                toast: crate::popovers::toast::toast(
                    message,
                    ardia_state::windows::ToastKind::Undo,
                    Some("undoClearTabs"),
                    ardia_state::store::now_ms(),
                ),
            },
            window,
            cx,
        );
    }

    pub(crate) fn close_duplicate_tabs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let count =
            ardia_state::duplicate_tabs::duplicate_tab_ids(&self.state, self.window_id.as_str())
                .len();
        if count == 0 {
            return;
        }
        self.dispatch(
            Action::CloseDuplicateTabs {
                window: self.window_id.clone(),
            },
            window,
            cx,
        );
        crate::sidebar::overflow_menu::note_tabs_cleared(Some(count));
        let mut toast = crate::popovers::toast::toast(
            crate::sidebar::overflow_menu::closed_duplicates_message(count),
            ardia_state::windows::ToastKind::Undo,
            Some("undoClearTabs"),
            ardia_state::store::now_ms(),
        );
        toast.icon = Some("square.on.square".to_owned());
        self.dispatch(
            Action::PushToast {
                window: self.window_id.clone(),
                toast,
            },
            window,
            cx,
        );
    }

    pub(crate) fn notify_toast(
        &mut self,
        message: impl Into<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dispatch(
            Action::PushToast {
                window: self.window_id.clone(),
                toast: crate::popovers::toast::toast(
                    message,
                    ardia_state::windows::ToastKind::Info,
                    None,
                    ardia_state::store::now_ms(),
                ),
            },
            window,
            cx,
        );
    }

    fn key_placement(&self) -> CommandBarPlacementState {
        let id = self.window_id.as_str();
        let small = self
            .state
            .window(id)
            .is_some_and(|w| w.kind == ardia_state::windows::WindowKind::LittleArdia);
        let sidebar_or_peek = self
            .layout
            .is_some_and(|l| l.sidebar.is_some() || l.peek.is_some());
        crate::omnibox::hero::key_placement(
            self.state.settings.command_bar_placement,
            small,
            crate::omnibox::hero::address_field_shown(&self.state, id, sidebar_or_peek),
        )
    }

    pub(crate) fn open_panel_by_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let placement = self.key_placement();
        self.open_panel_placed(false, None, Some(placement), window, cx);
    }

    fn placement_for_active(&self) -> CommandBarPlacementState {
        if self.state.settings.command_bar_placement
            == ardia_state::settings::CommandBarPlacement::Field
        {
            CommandBarPlacementState::Field
        } else {
            CommandBarPlacementState::Centred
        }
    }

    pub(crate) fn open_panel(
        &mut self,
        new_tab: bool,
        text: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let clicked = text.is_none().then(|| {
            crate::omnibox::hero::click_placement(self.state.settings.command_bar_placement, false)
        });
        self.open_panel_placed(new_tab, text, clicked, window, cx);
    }

    fn open_panel_placed(
        &mut self,
        new_tab: bool,
        text: Option<String>,
        chosen: Option<CommandBarPlacementState>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let by_key = text.is_none();
        let open_bar = self.panel.is_open() && !self.panel.is_hero();
        if open_bar && (new_tab || by_key) && self.panel.new_tab.is_some() == new_tab {
            if by_key {
                ardia_telemetry::counts::count("command_bar_key_dismissals");
            }
            self.close_panel(window, cx);
            return;
        }
        let hero = crate::omnibox::hero::hero_shown(&self.state, self.window_id.as_str());
        if !new_tab && hero.is_some() {
            if open_bar {
                self.close_panel(window, cx);
            }
            if !self.panel.is_hero() {
                self.sync_hero(window, cx);
            }
            self.panel.focus_hero(true, window, cx);
            cx.notify();
            return;
        }
        let active = self.active_tab();
        let initial = text.unwrap_or_else(|| match (&active, new_tab) {
            (Some(tab), false) if !is_new_tab_page(Some(tab)) => tab.url.clone(),
            _ => String::new(),
        });
        let placement = if new_tab {
            CommandBarPlacementState::Centred
        } else {
            chosen.unwrap_or_else(|| self.placement_for_active())
        };
        let target = new_tab.then(|| match hero {
            Some(tab) if active.as_ref().is_some_and(|t| t.pin.is_none()) => {
                NewTabTarget::Into(tab)
            }
            _ => NewTabTarget::List,
        });
        self.ui.menu = None;
        if !self.panel.is_open() {
            let label = match (&target, &placement) {
                (Some(_), _) => "new_tab",
                (None, CommandBarPlacementState::Centred) => "centred",
                (None, CommandBarPlacementState::Field) => "field",
            };
            ardia_telemetry::capture(
                "command_bar_opened",
                serde_json::Map::from_iter([("placement".to_owned(), serde_json::json!(label))]),
            );
        }
        let request = CommandBarState {
            open: true,
            initial_text: initial.clone(),
            new_tab: target.clone(),
            placement: placement.clone(),
        };
        self.last_bar = Some(request.clone());
        self.host.dispatch(Action::SetCommandBar {
            window: self.window_id.clone(),
            state: request,
        });
        self.prepare_panel(initial, target, placement, window, cx);
        self.on_store(Topics::CHROME, window, cx);
    }

    fn prepare_panel(
        &mut self,
        text: String,
        target: Option<NewTabTarget>,
        placement: CommandBarPlacementState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let variant = crate::omnibox::hero::panel_variant(
            &self.state,
            self.window_id.as_str(),
            target.is_some(),
            &placement,
        );
        let style = crate::omnibox::view::field_style(&self.look, variant);
        let state = Arc::clone(&self.state);
        self.panel.incognito = state
            .window(self.window_id.as_str())
            .is_some_and(|w| w.kind == ardia_state::windows::WindowKind::Incognito);
        self.panel.prepare_variant(
            &state,
            variant,
            PanelRequest {
                text: &text,
                new_tab: target,
                placement,
                style,
            },
            window,
            cx,
        );
        if let Some(plugins) = self.host.plugins() {
            self.panel
                .add_actions(crate::plugins::bar_actions::bar_actions(
                    plugins.as_ref(),
                    &state,
                    &self.window_id,
                ));
        }
        if self.panel.idle() {
            self.panel.refresh(
                &state,
                &self.window_id,
                false,
                ardia_state::store::now_ms(),
                cx,
            );
        }
        cx.notify();
    }

    pub(crate) fn close_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.panel.is_open() || self.panel.is_hero() {
            return;
        }
        self.panel.close();
        self.host.dispatch(Action::SetCommandBar {
            window: self.window_id.clone(),
            state: CommandBarState::default(),
        });
        self.refocus_page(window, cx);
        self.on_store(Topics::CHROME, window, cx);
    }

    fn submit_panel(&mut self, alternate: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !self.panel.is_open() {
            return;
        }
        let engine = self.state.default_search_engine();
        let disposition = if alternate {
            crate::omnibox::Disposition::NewTab
        } else {
            crate::omnibox::Disposition::Current
        };
        let outcome = self.panel.submit(disposition, &engine, cx);
        self.run_outcome(outcome, window, cx);
        cx.notify();
    }

    pub(crate) fn open_input(
        &mut self,
        input: String,
        new_tab: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let destination = if new_tab {
            Destination::NewTab
        } else {
            Destination::Active
        };
        self.open_into(input, destination, window, cx);
    }

    pub(crate) fn open_into(
        &mut self,
        input: String,
        destination: Destination,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let target = match &destination {
            Destination::Active => self.active_tab().map(|t| t.id.clone()),
            Destination::Into(tab) => self.state.tab(tab.as_str()).map(|t| t.id.clone()),
            Destination::NewTab | Destination::Group(_) => None,
        };
        if let Some(tab) = target {
            self.host.navigate(self.window_id.clone(), tab, input);
            self.on_store(Topics::ALL, window, cx);
            return;
        }
        let engine = self.state.default_search_engine();
        let url = resolve_input(&input, &engine.url);
        let before = self.active_tab().map(|t| t.id.clone());
        self.host.dispatch(Action::NewTab {
            window: self.window_id.clone(),
            tab: NewTab {
                url: Some(url),
                ..NewTab::default()
            },
        });
        if let Destination::Group(group) = destination {
            let created = self
                .host
                .store()
                .snapshot()
                .active_tab(self.window_id.as_str())
                .map(|t| t.id.clone())
                .filter(|id| Some(id) != before.as_ref());
            if let Some(tab) = created {
                self.host.dispatch(Action::AddToGroup {
                    group,
                    tabs: vec![tab],
                });
            }
        }
        self.on_store(Topics::ALL, window, cx);
    }

    fn on_panel_input(
        &mut self,
        _: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.panel_input(event, window, cx);
    }

    fn find_state(&self) -> Option<(TabId, FindState)> {
        let tab = self.active_tab()?;
        Some((tab.id.clone(), tab.live.find.clone()))
    }

    fn find(&mut self, find: FindMsg, window: &mut Window, cx: &mut Context<Self>) {
        let Some((tab, state)) = self.find_state() else {
            return;
        };
        match find {
            FindMsg::Open | FindMsg::OpenReplace => {
                if !state.open {
                    ardia_telemetry::counts::count("find_opens");
                }
                let query = state.query.clone();
                let replace = state.replace || find == FindMsg::OpenReplace;
                self.dispatch(
                    Action::SetFind {
                        tab,
                        find: FindState {
                            open: true,
                            replace,
                            ..state
                        },
                    },
                    window,
                    cx,
                );
                let replace_style = input_style(
                    &self.look,
                    FieldSurface::PopoverField,
                    crate::content::find_bar::FIND_FONT,
                );
                self.replace_input
                    .update(cx, |input, cx| input.set_style(replace_style, cx));
                let style = input_style(
                    &self.look,
                    FieldSurface::PopoverField,
                    crate::content::find_bar::FIND_FONT,
                );
                self.find_input.update(cx, |input, cx| {
                    input.set_style(style, cx);
                    input.set_text(query, true, cx);
                });
                crate::primitives::text_input::focus_input(&self.find_input, window, cx);
            }
            FindMsg::Close => {
                self.host.stop_finding(tab.clone());
                self.dispatch(
                    Action::SetFind {
                        tab,
                        find: FindState {
                            open: false,
                            count: None,
                            active: 0,
                            ..state
                        },
                    },
                    window,
                    cx,
                );
                self.refocus_page(window, cx);
            }
            FindMsg::Replace { all } => {
                if !state.query.is_empty() {
                    let replacement = self.replace_input.read(cx).text().to_owned();
                    self.host
                        .replace_in_page(tab, state.query, replacement, all);
                }
            }
            FindMsg::Next | FindMsg::Previous if state.query.is_empty() => {
                self.find(FindMsg::Open, window, cx)
            }
            FindMsg::Next | FindMsg::Previous => {
                ardia_telemetry::counts::count("find_steps");
                self.host
                    .find_in_page(tab, state.query, find == FindMsg::Next);
            }
        }
    }

    fn on_replace_input(
        &mut self,
        _: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Submit(_) => self.find(FindMsg::Replace { all: false }, window, cx),
            InputEvent::Cancel => self.find(FindMsg::Close, window, cx),
            _ => {}
        }
    }

    fn on_find_input(
        &mut self,
        input: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Changed { .. } => {
                let Some((tab, state)) = self.find_state() else {
                    return;
                };
                let query = input.read(cx).text().to_owned();
                self.find_tab = Some(tab.clone());
                if query.is_empty() {
                    self.host.stop_finding(tab.clone());
                }
                self.host.dispatch(Action::SetFind {
                    tab: tab.clone(),
                    find: FindState {
                        open: true,
                        count: None,
                        active: 0,
                        query: query.clone(),
                        ..state
                    },
                });
                if !query.is_empty() {
                    self.host.find_in_page(tab, query, true);
                }
                self.on_store(Topics::ALL, window, cx);
            }
            InputEvent::Submit(SubmitKind::Shift) => self.find(FindMsg::Previous, window, cx),
            InputEvent::Submit(_) => self.find(FindMsg::Next, window, cx),
            InputEvent::Cancel => self.find(FindMsg::Close, window, cx),
            InputEvent::Up | InputEvent::Down | InputEvent::Tab => {}
        }
    }

    fn start_rename(
        &mut self,
        target: Option<RenameTarget>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ui.menu = None;
        let Some(target) = target else {
            self.ui.rename = None;
            cx.notify();
            return;
        };
        let current = match &target {
            RenameTarget::Tab(tab) => self.state.tab(tab.as_str()).map(|t| t.display_title()),
            RenameTarget::Group(group) => self.state.group(group.as_str()).map(|g| g.name.clone()),
        };
        let Some(current) = current else {
            return;
        };
        let mut style = input_style(&self.look, FieldSurface::Field, self.look.points(13.));
        style.text = self.look.p.text;
        self.rename_input.update(cx, |input, cx| {
            input.set_style(style, cx);
            input.set_text(current, true, cx);
        });
        crate::primitives::text_input::focus_input(&self.rename_input, window, cx);
        self.ui.rename = Some(target);
        cx.notify();
    }

    fn commit_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.rename_input.read(cx).text().trim().to_owned();
        match self.ui.rename.take() {
            Some(RenameTarget::Tab(tab)) => self.dispatch(
                Action::RenameTab {
                    tab,
                    title: (!name.is_empty()).then_some(name),
                },
                window,
                cx,
            ),
            Some(RenameTarget::Group(group)) => self.dispatch(
                Action::UpdateGroup {
                    group,
                    patch: ardia_state::GroupPatch {
                        name: Some(name),
                        ..ardia_state::GroupPatch::default()
                    },
                },
                window,
                cx,
            ),
            None => {}
        }
    }

    fn on_rename_input(
        &mut self,
        _: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Submit(_) => {
                self.commit_rename(window, cx);
                window.focus(&self.focus, cx);
            }
            InputEvent::Cancel => {
                self.ui.rename = None;
                window.focus(&self.focus, cx);
                cx.notify();
            }
            _ => {}
        }
    }

    fn toggle_popover(&mut self, popover: Popover, window: &mut Window, cx: &mut Context<Self>) {
        let current = self
            .state
            .window(self.window_id.as_str())
            .and_then(|w| w.chrome.popover.clone());
        self.site_popover_toggled(&popover);
        let next = (current.as_ref() != Some(&popover)).then_some(popover);
        self.ui.menu = None;
        self.dispatch(
            Action::SetPopover {
                window: self.window_id.clone(),
                popover: next,
            },
            window,
            cx,
        );
    }

    fn pager_scroll(
        &mut self,
        phase: gpui::TouchPhase,
        dx: f32,
        dy: f32,
        precise: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(browser) = self.state.window(self.window_id.as_str()).cloned() else {
            return;
        };
        if browser.profile_id.is_incognito() || self.state.profile_order.len() < 2 {
            return;
        }
        let now = Instant::now();
        let outcome = if precise {
            if phase == gpui::TouchPhase::Started {
                self.pager.begin(&self.state, &browser.profile_id);
            }
            let width = self.layout.map_or(1.0, |layout| layout.sidebar_width);
            self.pager.precise(phase, dx, dy, width, now)
        } else {
            self.pager.wheel(&self.state, &browser.profile_id, dx, now)
        };
        match outcome {
            PagerOutcome::None => return,
            PagerOutcome::Moved => self.pager_tint(window, now),
            PagerOutcome::SwitchTo(profile) => self.dispatch(
                Action::SwitchProfile {
                    window: self.window_id.clone(),
                    profile,
                },
                window,
                cx,
            ),
        }
        cx.notify();
    }

    fn pager_tint(&mut self, window: &mut Window, now: Instant) {
        let Some(browser) = self.state.window(self.window_id.as_str()) else {
            return;
        };
        let current = browser.profile_id.clone();
        let toward = crate::sidebar::pager::pager_position(self.window_id.as_str(), now).and_then(
            |position| {
                crate::sidebar::pager::tint_toward(&self.state.profile_order, &current, position)
            },
        );
        let Some((toward, fraction)) = toward else {
            if self.pager.neighbour_spec().is_some() {
                self.pager.set_neighbour_spec(None);
                self.backdrop.override_gradients(None);
                self.backdrop.aim(self.backdrop_spec(window), false, now);
            }
            return;
        };
        let viewport = window.viewport_size();
        let viewport = [f32::from(viewport.width), f32::from(viewport.height)];
        if self
            .pager
            .neighbour_spec()
            .is_none_or(|(id, _, _)| *id != toward)
        {
            let frame = backdrop_frame(window, self.layout.as_ref());
            let spec = neighbour_backdrop(
                &self.state,
                self.window_id.as_str(),
                &toward,
                window.appearance(),
                crate::window::looks_active(window),
                frame,
                viewport,
            );
            self.pager.set_neighbour_spec(
                spec.map(|(spec, gradients)| (toward.clone(), spec, gradients)),
            );
        }
        if let Some((_, neighbour, gradients)) = self.pager.neighbour_spec().cloned() {
            let blended = blend_backdrops(&self.backdrop_spec(window), &neighbour, fraction);
            self.backdrop.aim(blended, false, now);
            let own = self.look.backdrop_gradients(viewport);
            self.backdrop
                .override_gradients(Some(crate::window::backdrop::blend_gradients(
                    &own, &gradients, fraction,
                )));
        }
    }

    fn pane_overlay(&mut self, msg: PaneOverlayMsg, window: &mut Window, cx: &mut Context<Self>) {
        if let PaneOverlayMsg::Pager {
            phase,
            dx,
            dy,
            precise,
        } = msg
        {
            self.pager_scroll(phase, dx, dy, precise, window, cx);
            return;
        }
        let order = sections(&self.state, self.window_id.as_str()).ordered_tabs();
        let command = self.overlays.handle(
            msg,
            &self.host,
            &self.state,
            &self.window_id,
            &order,
            Instant::now(),
        );
        if let Some(command) = command {
            self.run_command(command, window, cx);
        }
        cx.notify();
    }

    fn show_over_empty_card(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self
            .active_tab()
            .filter(|tab| shows_empty_card(&self.state, tab))
        else {
            return;
        };
        if self.overlays.first_time_over_empty_card(&tab.id)
            && (!self.panel.is_open() || self.panel.is_hero())
        {
            self.open_panel(true, Some(String::new()), window, cx);
        }
    }

    pub(crate) fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if crate::content::pane_drag::cancel(window, cx) {
            cx.notify();
            return;
        }
        if crate::bookmarks_bar::escape(&self.window_id, cx) {
            cx.notify();
            return;
        }
        if self.overlays.close_history() {
            cx.notify();
            return;
        }
        if self.ui.menu.take().is_some() {
            cx.notify();
            return;
        }
        if self.ui.rename.take().is_some() {
            window.focus(&self.focus, cx);
            cx.notify();
            return;
        }
        if self.confirm_close {
            self.confirm_close = false;
            cx.notify();
            return;
        }
        if self.panel.is_open() {
            self.close_panel(window, cx);
            return;
        }
        if self.host.extension_popup(&self.window_id).is_some() {
            self.host.close_extension_popup(self.window_id.clone());
            cx.notify();
            return;
        }
        let Some(browser) = self.state.window(self.window_id.as_str()).cloned() else {
            return;
        };
        if browser.chrome.popover.is_some() {
            if matches!(browser.chrome.popover, Some(Popover::Downloads)) {
                ardia_telemetry::counts::count("downloads_panel_closes_escape");
            } else if DISMISSING_BY_KEY.with(std::cell::Cell::get) {
                ardia_telemetry::counts::count("popover_escape_closes");
            }
            self.dispatch(
                Action::SetPopover {
                    window: self.window_id.clone(),
                    popover: None,
                },
                window,
                cx,
            );
            return;
        }
        if self.active_tab().is_some_and(|t| t.live.find.open) {
            self.find(FindMsg::Close, window, cx);
            return;
        }
        if self.state.shown_peek(self.window_id.as_str()).is_some() {
            self.dispatch(
                Action::ClosePeek {
                    window: self.window_id.clone(),
                },
                window,
                cx,
            );
            return;
        }
        if !browser.chrome.selection.is_empty() {
            self.dispatch(
                Action::SelectTabs {
                    window: self.window_id.clone(),
                    tabs: Vec::new(),
                },
                window,
                cx,
            );
        }
    }

    pub(crate) fn has_sidebar(&self) -> bool {
        self.state
            .window(self.window_id.as_str())
            .is_some_and(|w| w.kind.shows_sidebar())
            && self.state.effective_layout(self.window_id.as_str()) != EffectiveLayout::TopStrip
    }

    fn resize_sidebar(&mut self, width: f32, window: &mut Window, cx: &mut Context<Self>) {
        let limit = ardia_theme::layout::sidebar_width_limit(Some(crate::scale::points(
            window.viewport_size().width,
        )));
        let width = width
            .clamp(ardia_theme::layout::SIDEBAR_MIN_WIDTH, limit)
            .round();
        if (self.state.settings.sidebar_width - f64::from(width)).abs() < 0.5 {
            return;
        }
        self.dispatch(
            Action::UpdateSettings {
                patch: ardia_state::settings::SettingsPatch::new()
                    .set("sidebarWidth", f64::from(width)),
                from_sync: false,
            },
            window,
            cx,
        );
    }

    fn drop_tab(
        &mut self,
        tab: TabId,
        before: Option<TabId>,
        group: Option<GroupId>,
        pin: Option<bool>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(moving) = self.state.tab(tab.as_str()).cloned() else {
            return;
        };
        let target_group = group.or_else(|| {
            before
                .as_ref()
                .filter(|b| **b != tab)
                .and_then(|b| self.state.group_of(b.as_str()))
                .map(|g| g.id.clone())
        });
        let current_group = self.state.group_of(tab.as_str()).map(|g| g.id.clone());
        match &target_group {
            Some(group) if Some(group) != current_group.as_ref() => {
                self.host.dispatch(Action::AddToGroup {
                    group: group.clone(),
                    tabs: vec![tab.clone()],
                });
            }
            None if current_group.is_some() && pin != Some(true) => {
                self.host.dispatch(Action::RemoveFromGroups {
                    tabs: vec![tab.clone()],
                });
            }
            _ => {}
        }
        match pin {
            Some(true) if !moving.pin.as_ref().is_some_and(|p| p.is_tile()) => {
                self.host.dispatch(Action::SetPin {
                    tab: tab.clone(),
                    pin: Some(ardia_state::model::TabPin::TILE),
                });
            }
            Some(false) if moving.pin.is_some() => {
                self.host.dispatch(Action::SetPin {
                    tab: tab.clone(),
                    pin: None,
                });
            }
            _ => {}
        }
        if before.as_ref() != Some(&tab) {
            let order: Vec<TabId> = self
                .host
                .store()
                .snapshot()
                .window(self.window_id.as_str())
                .map(|w| w.tab_ids.iter().filter(|id| **id != tab).cloned().collect())
                .unwrap_or_default();
            let index = before
                .as_ref()
                .and_then(|b| order.iter().position(|id| id == b))
                .unwrap_or(order.len());
            self.host.dispatch(Action::MoveTab {
                tab,
                window: self.window_id.clone(),
                index,
            });
        }
        self.on_store(Topics::ALL, window, cx);
    }

    fn pane_focused(&mut self, tab: TabId, window: &mut Window, cx: &mut Context<Self>) {
        if self.active_tab().is_some_and(|active| active.id == tab) {
            return;
        }
        if self.visible_tabs().iter().any(|shown| shown.id == tab) {
            self.dispatch(Action::ActivateTab { tab }, window, cx);
        }
    }

    fn new_tab_in_group(&mut self, group: GroupId, window: &mut Window, cx: &mut Context<Self>) {
        let before = self.active_tab().map(|t| t.id.clone());
        self.host.dispatch(Action::NewTab {
            window: self.window_id.clone(),
            tab: NewTab {
                url: ardia_state::new_tab_home::home_url(&self.state.settings),
                ..NewTab::default()
            },
        });
        let newest = self
            .host
            .store()
            .snapshot()
            .active_tab(self.window_id.as_str())
            .map(|t| t.id.clone())
            .filter(|id| Some(id) != before.as_ref());
        if let Some(tab) = newest {
            self.host.dispatch(Action::AddToGroup {
                group,
                tabs: vec![tab],
            });
        }
        self.on_store(Topics::ALL, window, cx);
    }

    pub(crate) fn refocus_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.panel.is_hero() {
            self.panel.focus_hero(false, window, cx);
            return;
        }
        let Some(tab) = self.active_tab().map(|tab| tab.id.clone()) else {
            window.focus(&self.focus, cx);
            return;
        };
        let attached = self.natives.focus(&tab, window, cx);
        log::debug!("refocus page {tab}: native view attached {attached}");
        if attached {
            self.focus_engine_page(tab, window);
            return;
        }
        window.focus(&self.focus, cx);
        if self
            .active_tab()
            .is_some_and(|t| !is_new_tab_page(Some(&t)))
        {
            self.pending_page_focus = Some((tab, Instant::now()));
            cx.notify();
        }
    }

    fn focus_engine_page(&self, tab: TabId, window: &mut Window) {
        let host = Arc::clone(&self.host);
        window.on_next_frame(move |window, _| {
            window.on_next_frame(move |_, _| host.focus_page(tab));
            window.refresh();
        });
        window.refresh();
    }

    fn settle_pending_page_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((tab, since)) = self.pending_page_focus.take() else {
            return;
        };
        if self.active_tab().map(|t| t.id.clone()) != Some(tab.clone())
            || since.elapsed() > PAGE_FOCUS_RESTORE_WINDOW
            || !self.chrome_free_for_page(window, cx)
        {
            return;
        }
        if self.natives.focus(&tab, window, cx) {
            self.focus_engine_page(tab, window);
        } else {
            self.pending_page_focus = Some((tab, since));
            window.request_animation_frame();
        }
    }

    fn restore_focus_on_activation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if window.is_window_active()
            && !self.panel.is_open()
            && self.natives.holds_focus(window, cx)
            && let Some(tab) = self.active_tab().map(|tab| tab.id.clone())
        {
            self.focus_engine_page(tab, window);
        }
    }

    fn chrome_free_for_page(&self, window: &Window, cx: &App) -> bool {
        let stale_bar = (!self.panel.is_open() || self.panel.is_hero())
            && self.panel.input.focus_handle(cx).is_focused(window);
        match window.focused(cx) {
            None => true,
            Some(focused) => {
                focused == self.focus || stale_bar || self.natives.holds_focus(window, cx)
            }
        }
    }

    fn restore_page_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let active = self.active_tab().map(|tab| tab.id.clone());
        if active == self.focus_tab {
            return;
        }
        self.focus_tab = active;
        let free = self.chrome_free_for_page(window, cx);
        log::debug!(
            "page focus on activation: tab {:?}, chrome free {free}",
            self.focus_tab
        );
        if self.focus_tab.is_some()
            && (!self.panel.is_open() || self.panel.is_hero())
            && self.state.shown_peek(self.window_id.as_str()).is_none()
            && free
        {
            self.refocus_page(window, cx);
        }
    }

    fn on_run_command(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        self.run_command(&action.id, window, cx);
    }

    fn on_reserved_command(
        &mut self,
        action: &RunReservedCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.run_command(&action.id, window, cx);
    }

    fn on_dismiss(&mut self, _: &Dismiss, window: &mut Window, cx: &mut Context<Self>) {
        let active = self
            .state
            .active_tab(self.window_id.as_str())
            .map(|tab| tab.id.clone());
        if let Some(tab) = active
            && crate::media::share::picker_key(&self.host, &tab, "escape")
        {
            window.refresh();
            return;
        }
        DISMISSING_BY_KEY.with(|key| key.set(true));
        self.dismiss(window, cx);
        DISMISSING_BY_KEY.with(|key| key.set(false));
    }

    pub(crate) fn window_full_screen(&self, window: &Window) -> bool {
        window.is_fullscreen() || self.page_full_screen.acted()
    }

    fn full_screen_page(&self) -> Option<&Arc<Tab>> {
        self.state.fullscreen_tab(self.window_id.as_str())
    }

    pub(crate) fn set_window_full_screen(
        &mut self,
        on: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if crate::window::keeps_key_look() {
            if self.page_full_screen.acted() != on {
                self.page_full_screen.set_acted(on);
                self.host.act_window_full_screen(self.window_id.clone(), on);
                cx.notify();
            }
            return;
        }
        if window.is_fullscreen() != on {
            window.toggle_fullscreen();
        }
    }

    fn sync_page_full_screen(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let page = self.full_screen_page().map(|tab| tab.id.clone());
        let takes_window = page.as_ref().is_some_and(|tab| {
            self.state
                .window(self.window_id.as_str())
                .is_some_and(|w| w.kind == ardia_state::windows::WindowKind::Main)
                && self.host.page_full_screen_takes_window(tab)
        });
        let full = self.window_full_screen(window);
        let step = self
            .page_full_screen
            .step(page.as_ref(), takes_window, full, Instant::now());
        use crate::window::page_full_screen::Step;
        match step {
            Step::Stay => {}
            Step::EnterWindow | Step::LeaveWindow => {
                self.cover_then_toggle(step == Step::EnterWindow, window, cx);
            }
            Step::ExitPage(tab) => self.host.exit_page_full_screen(tab),
        }
        self.lift_covers(window, cx);
        self.record_window_full_screen(window, cx);
        if let Some(peek) = self.state.shown_peek(self.window_id.as_str())
            && page.as_ref().is_some_and(|tab| *tab != peek.tab_id)
        {
            let window_id = self.window_id.clone();
            cx.defer_in(window, move |view, window, cx| {
                view.dispatch(Action::ClosePeek { window: window_id }, window, cx)
            });
        }
    }

    fn cover_then_toggle(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        use crate::window::page_full_screen::{Covers, DRAW_WAIT, page_drew};
        let tabs: Vec<TabId> = self
            .visible_tabs()
            .iter()
            .map(|tab| tab.id.clone())
            .collect();
        let probe = tabs.first().cloned();
        let scale = f64::from(window.scale_factor());
        let size = window.viewport_size();
        let pixels = [
            f64::from(f32::from(size.width)) * scale,
            f64::from(f32::from(size.height)) * scale,
        ];
        let host = Arc::clone(&self.host);
        let window_id = self.window_id.clone();
        self.cover_task = Some(cx.spawn_in(window, async move |view, cx| {
            if let Some(tab) = probe {
                let deadline = Instant::now() + DRAW_WAIT;
                loop {
                    let drawn = host.page_draw_state(tab.clone()).await.ok().flatten();
                    if page_drew(drawn, on, pixels) || Instant::now() >= deadline {
                        break;
                    }
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(16))
                        .await;
                }
            }
            let mut covered = Vec::new();
            for tab in &tabs {
                if host.cover_page(tab.clone()).await.unwrap_or(false) {
                    covered.push(tab.clone());
                }
            }
            let transitions = host.window_transitions(&window_id);
            let _ = view.update_in(cx, |view, window, cx| {
                let toggles = view.window_full_screen(window) != on;
                view.set_window_full_screen(on, window, cx);
                if toggles && !covered.is_empty() {
                    view.covers = Some(Covers {
                        tabs: covered,
                        since: Instant::now(),
                        transitions,
                    });
                } else {
                    for tab in covered {
                        view.host.uncover_page(tab, false);
                    }
                }
                cx.notify();
            });
        }));
    }

    fn lift_covers(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use crate::window::page_full_screen::UNCOVER_AFTER_DRAW;
        let Some(covers) = self.covers.clone() else {
            return;
        };
        let transitions = self.host.window_transitions(&self.window_id);
        if !covers.lifts(transitions, Instant::now()) {
            self.uncover_tick = Some(cx.spawn_in(window, async move |view, cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(100))
                    .await;
                let _ = view.update(cx, |_, cx| cx.notify());
            }));
            return;
        }
        self.covers = None;
        self.uncover_tick = None;
        let host = Arc::clone(&self.host);
        cx.spawn_in(window, async move |_, cx| {
            for tab in &covers.tabs {
                let _ = host.page_draw_state(tab.clone()).await;
            }
            cx.background_executor().timer(UNCOVER_AFTER_DRAW).await;
            for tab in covers.tabs {
                host.uncover_page(tab, true);
            }
        })
        .detach();
    }

    fn record_window_full_screen(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(browser) = self.state.window(self.window_id.as_str()) else {
            return;
        };
        if browser.kind != ardia_state::windows::WindowKind::Main {
            return;
        }
        let recorded = browser.is_full_screen();
        let full = self.window_full_screen(window);
        let now = Instant::now();
        use crate::window::full_screen_restore::{FullScreenRestore, Turn, saved_order};
        if !cx.default_global::<FullScreenRestore>().armed() {
            let order = saved_order(&self.state);
            let focus = self.state.focus_order.first().cloned();
            cx.global_mut::<FullScreenRestore>().arm(order, focus, now);
        }
        let turn = cx
            .global_mut::<FullScreenRestore>()
            .step(&self.window_id, full, now);
        if cx.global::<FullScreenRestore>().busy() {
            self.restore_tick = Some(cx.spawn_in(window, async move |view, cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(250))
                    .await;
                let _ = view.update(cx, |_, cx| cx.notify());
            }));
        } else {
            self.restore_tick = None;
        }
        match turn {
            Turn::Hold => return,
            Turn::Enter => {
                if let Some(display) = browser.display.clone() {
                    self.host
                        .move_window_to_display(self.window_id.clone(), display);
                }
                cx.on_next_frame(window, |view, window, cx| {
                    view.set_window_full_screen(true, window, cx)
                });
                return;
            }
            Turn::GiveUp(gone) => {
                let off = self
                    .state
                    .window(gone.as_str())
                    .is_some_and(|w| w.is_full_screen());
                if off && (gone != self.window_id || !full) {
                    self.host.dispatch(Action::SetFullScreen {
                        window: gone,
                        on: false,
                        display: None,
                    });
                }
                return;
            }
            Turn::Refocus => {
                if !crate::window::keeps_key_look() {
                    window.activate_window();
                }
            }
            Turn::Record => {}
        }
        let wanted = full && !self.page_full_screen.entered_for_page();
        let display = window
            .display(cx)
            .and_then(|display| display.uuid().ok())
            .map(|uuid| uuid.to_string().to_uppercase());
        let moved = wanted && display.is_some() && browser.display != display;
        if wanted != recorded || moved {
            self.host.dispatch(Action::SetFullScreen {
                window: self.window_id.clone(),
                on: wanted,
                display: display.filter(|_| wanted),
            });
        }
    }

    fn inset(&self, window: &Window) -> f32 {
        let full_screen = self.window_full_screen(window);
        self.state
            .page_frame_inset_in(self.window_id.as_str(), full_screen)
    }

    fn compute_layout(&mut self, window: &Window, now: Instant) -> ChromeLayout {
        let (width, height) = crate::scale::logical_size(window.viewport_size());
        let id = self.window_id.as_str();
        let layout = self.state.effective_layout(id);
        let sidebar_width = self
            .ui
            .sidebar_drag
            .unwrap_or_else(|| self.state.sidebar_width(Some(width)));
        let computed = chrome_layout(LayoutInput {
            width,
            height,
            layout,
            inset: self.inset(window),
            sidebar_width,
            trailing: self.state.sidebar_side(id) == SidebarSide::Right,
            dock: self.dock.value(now),
            peek: self.peek.value(now),
            compact: self.state.settings.compact_toolbar,
            full_screen: self.window_full_screen(window),
            page_full_screen: self.full_screen_page().is_some(),
            has_sidebar: if layout == EffectiveLayout::TopStrip {
                self.state.sidebar_shown(id)
            } else {
                self.has_sidebar()
            },
            field_hidden: self.state.minimalism_in(id),
        });
        self.layout = Some(computed);
        computed
    }

    pub(crate) fn visible_tabs(&self) -> Vec<Arc<Tab>> {
        if let Some(full) = self.full_screen_page() {
            return vec![Arc::clone(full)];
        }
        let Some(active) = self.active_tab() else {
            return Vec::new();
        };
        match self.state.split_of(active.id.as_str()) {
            Some(split) => split
                .tab_ids()
                .iter()
                .filter_map(|id| self.state.tab(id.as_str()).cloned())
                .collect(),
            None => vec![active],
        }
    }

    fn attach_natives(
        &mut self,
        layout: &ChromeLayout,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> HashMap<TabId, (Option<NativeView>, Option<NativeView>)> {
        let mut out = HashMap::new();
        let background = self.look.p.card;
        let radius = layout.frame.radius;
        let top = if layout.toolbar > 0.0 { 0.0 } else { radius };
        let corners = SlotCorners {
            top,
            bottom: radius,
        }
        .native();
        let mut tabs = self.visible_tabs();
        if let Some(peek) = self.state.shown_peek(self.window_id.as_str())
            && self.full_screen_page().is_none()
            && let Some(tab) = self.state.tab(peek.tab_id.as_str())
        {
            tabs.push(Arc::clone(tab));
        }
        for tab in tabs {
            let views = self.host.tab_native_views(tab.id.clone());
            let drawn_page = crate::pages::InternalPage::of(&tab.url).is_some();
            let handle = views
                .as_ref()
                .and_then(|v| v.page_view)
                .filter(|_| !drawn_page);
            let devtools = views.as_ref().and_then(|v| v.devtools_view);
            let page = self
                .natives
                .attach(&tab.id, false, handle, background, window, cx);
            if let (Some(view), Some(handle)) = (&page, handle)
                && let std::collections::hash_map::Entry::Vacant(slot) =
                    self.focus_watch.entry(handle.as_ptr() as usize)
            {
                let focus = view.focus_handle(cx);
                let focused = tab.id.clone();
                slot.insert(cx.on_focus(&focus, window, move |view, window, cx| {
                    view.pane_focused(focused.clone(), window, cx)
                }));
            }
            let shape = if tab.live.peek && !tab.live.fullscreen {
                self.peek_motion.frame().map_or_else(
                    || {
                        SlotCorners {
                            top: radius,
                            bottom: radius,
                        }
                        .native()
                    },
                    |frame| crate::content::peek_overlay::peek_native_corners(&frame),
                )
            } else {
                corners
            };
            let retiring_slot = retiring_slot(&tab.id);
            let retiring = self
                .host
                .retiring_page(tab.id.clone())
                .filter(|_| shows_retiring(&tab, self.host.new_tab_shown(&tab.id)))
                .map(|retiring| retiring.view);
            let retiring =
                self.natives
                    .attach(&retiring_slot, false, retiring, background, window, cx);
            if retiring.is_some() {
                self.natives.round(&retiring_slot, false, shape, window, cx);
                out.insert(retiring_slot, (retiring, None));
            }
            let devtools = self
                .natives
                .attach(&tab.id, true, devtools, background, window, cx);
            if page.is_some() {
                self.natives.round(&tab.id, false, shape, window, cx);
            }
            out.insert(tab.id.clone(), (page, devtools));
        }
        out
    }

    fn page_content(
        &self,
        chrome: &Chrome,
        page: Rect,
        natives: &HashMap<TabId, (Option<NativeView>, Option<NativeView>)>,
    ) -> AnyElement {
        let Some(active) = chrome.active else {
            return div().into_any_element();
        };
        let radius = chrome.layout.frame.radius;
        let corners = SlotCorners {
            top: if chrome.layout.toolbar > 0.0 {
                0.0
            } else {
                radius
            },
            bottom: radius,
        };
        let slot = |tab: &Arc<Tab>, rect: Rect| -> AnyElement {
            if shows_empty_card(chrome.state, tab) {
                return crate::window::page_overlays::new_tab_drop_area(
                    div().size_full().into_any_element(),
                    &tab.id,
                    chrome.emit,
                );
            }
            if let Some(pane) = self
                .split_empty
                .panes
                .get(&tab.id)
                .filter(|_| crate::content::split_empty::shows_split_empty(chrome.state, tab))
            {
                return crate::content::split_empty::split_empty_state(
                    chrome,
                    tab,
                    rect,
                    crate::content::split_empty::SplitEmptyView { pane },
                );
            }
            if is_new_tab_page(Some(tab)) {
                return crate::window::page_overlays::new_tab_drop_area(
                    new_tab_page(chrome, Rect::new(0.0, 0.0, rect.w, rect.h), tab),
                    &tab.id,
                    chrome.emit,
                );
            }
            if let Some(page) = crate::plugins::overlays::mounted_page(&tab.id) {
                return page;
            }
            if crate::window::frozen_page::is_frozen(tab) {
                return crate::window::frozen_page::frozen_page(
                    chrome,
                    &tab.id,
                    self.host.frozen_picture(&self.window_id),
                );
            }
            let (page_view, devtools) = natives.get(&tab.id).cloned().unwrap_or((None, None));
            if let Some(old) = natives
                .get(&retiring_slot(&tab.id))
                .and_then(|(view, _)| view.clone())
            {
                let above = self
                    .host
                    .retiring_page(tab.id.clone())
                    .is_some_and(|retiring| retiring.above);
                return retiring_swap(
                    web_slot(chrome, tab, page_view, devtools, corners),
                    web_slot(chrome, tab, Some(old), None, corners),
                    above,
                );
            }
            web_slot(chrome, tab, page_view, devtools, corners)
        };
        if let Some(full) = self.full_screen_page() {
            return div()
                .id("page")
                .debug_selector(|| "page".into())
                .absolute()
                .left(px(page.x))
                .top(px(page.y))
                .w(px(page.w))
                .h(px(page.h))
                .child(slot(full, page))
                .into_any_element();
        }
        match self.state.split_of(active.id.as_str()) {
            Some(split) => {
                let gap = chrome.layout.frame.split_gap;
                let panes = pane_rects(split, page.w, page.h, gap)
                    .into_iter()
                    .filter_map(|(id, rect)| {
                        let tab = self.state.tab(id.as_str())?;
                        Some((id, rect, slot(tab, rect)))
                    })
                    .collect();
                split_view(chrome, split, page, radius, panes)
            }
            None => div()
                .id("page")
                .debug_selector(|| "page".into())
                .absolute()
                .left(px(page.x))
                .top(px(page.y))
                .w(px(page.w))
                .h(px(page.h))
                .child(slot(active, page))
                .child(crate::content::split_view::page_drop_targets(
                    chrome,
                    vec![(active.id.clone(), Rect::new(0.0, 0.0, page.w, page.h))],
                ))
                .into_any_element(),
        }
    }

    fn swipe_panes(&self, page: Rect) -> Vec<(TabId, Rect)> {
        let Some(active) = self.state.active_tab(self.window_id.as_str()) else {
            return Vec::new();
        };
        match self.state.split_of(active.id.as_str()) {
            Some(split) => split
                .tab_ids()
                .into_iter()
                .map(|tab| {
                    let pane = self.active_pane(page, &tab);
                    (tab, pane)
                })
                .collect(),
            None => vec![(active.id.clone(), page)],
        }
    }

    fn active_pane(&self, page: Rect, tab: &TabId) -> Rect {
        match self.state.split_of(tab.as_str()) {
            Some(split) => pane_rects(
                split,
                page.w,
                page.h,
                self.layout.map_or(0.0, |l| l.frame.split_gap),
            )
            .into_iter()
            .find(|(id, _)| id == tab)
            .map_or(page, |(_, rect)| {
                Rect::new(page.x + rect.x, page.y + rect.y, rect.w, rect.h)
            }),
            None => page,
        }
    }

    fn sync_platform(&mut self, layout: &ChromeLayout, window: &mut Window, now: Instant) -> bool {
        let frame = backdrop_frame(window, Some(layout));
        if self.backdrop.size() != Some(frame) {
            let spec = self.backdrop_spec_in(window, frame);
            self.backdrop.resize(frame, spec);
        }
        let viewport = window.viewport_size();
        self.backdrop.aim_gradients(
            self.look
                .backdrop_gradients([f32::from(viewport.width), f32::from(viewport.height)]),
        );
        let fading = self.backdrop.apply(window, now);
        let origin = layout
            .lights
            .map(traffic_light_origin)
            .unwrap_or_else(|| tucked_traffic_lights(ardia_theme::layout::lights::CENTER[1]));
        self.backdrop.place_lights(origin, window);
        let title = self
            .active_tab()
            .map(|tab| tab.display_title())
            .unwrap_or_else(|| "Ardia".to_owned());
        if title != self.title {
            window.set_window_title(&title);
            self.title = title;
        }
        fading
    }

    fn profile_slide(&mut self, now: Instant) -> bool {
        let Some((start, direction)) = self.profile_switch else {
            self.ui.profile_offset = 0.0;
            self.ui.profile_alpha = 1.0;
            return false;
        };
        let duration = crate::window::backdrop::CROSS_FADE.as_secs_f32();
        let t = now.saturating_duration_since(start).as_secs_f32() / duration;
        if t >= 1.0 {
            self.profile_switch = None;
            self.ui.profile_offset = 0.0;
            self.ui.profile_alpha = 1.0;
            return false;
        }
        let eased = Curve::EaseOut.apply(t);
        self.ui.profile_offset = direction * PROFILE_SLIDE * (1.0 - eased);
        self.ui.profile_alpha = 0.35 + 0.65 * eased;
        true
    }
}

pub fn peek_page_of(page: Rect, toolbar_lift: f32) -> Rect {
    let lift = toolbar_lift.clamp(0.0, page.h);
    Rect::new(page.x, page.y + lift, page.w, page.h - lift)
}

impl Render for BrowserWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let started = std::time::Instant::now();
        crate::profiled::profiled_root(
            ardia_profile::FrameSlot::Main,
            started,
            self.render_root(window, cx),
        )
    }
}

impl BrowserWindowView {
    fn render_root(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let now = Instant::now();
        crate::live::feed::publish_for(&self.host, &self.window_id, &self.emit);
        let state = Arc::clone(&self.state);
        let Some(browser) = state.window(self.window_id.as_str()).cloned() else {
            return div().id("browser-window").into_any_element();
        };
        self.sync_page_full_screen(window, cx);
        let window_full = self.window_full_screen(window);
        let page_full = self.full_screen_page().is_some();
        let mut layout = self.compute_layout(window, now);
        let developer_bar = !page_full
            && crate::content::developer_bar::shows(&state, &self.window_id, &layout, window_full);
        let plugin_page_bar =
            (!page_full && !developer_bar && layout.toolbar <= 0.0 && !window_full)
                .then(|| {
                    let tab = state.active_tab(self.window_id.as_str())?;
                    self.host.plugins()?.page_bar(&self.window_id, &tab.id)
                })
                .flatten();
        let full_toolbar_row = layout.toolbar;
        if developer_bar || plugin_page_bar.is_some() {
            layout.toolbar = crate::content::developer_bar::HEIGHT;
            self.layout = Some(layout);
        } else if let Some(height) = (!page_full)
            .then(|| {
                crate::content::auto_hide::toolbar_height(
                    &state,
                    &self.host,
                    &self.window_id,
                    &layout,
                )
            })
            .flatten()
        {
            layout.toolbar = height;
            self.layout = Some(layout);
        }
        let toolbar_row = layout.toolbar;
        let peek_lift = if developer_bar || plugin_page_bar.is_some() {
            0.0
        } else {
            (full_toolbar_row - toolbar_row).max(0.0)
        };
        let bookmarks_bar = if page_full {
            0.0
        } else {
            crate::bookmarks_bar::bar_height(&state, &browser, window_full)
        };
        if bookmarks_bar > 0.0 {
            layout.toolbar += bookmarks_bar;
            self.layout = Some(layout);
        }
        let share_tab = state
            .active_tab(self.window_id.as_str())
            .map(|tab| tab.id.clone());
        let (share_bar, share_moving) = crate::media::share::bar_height(
            self.window_id.as_str(),
            share_tab
                .as_ref()
                .is_some_and(|tab| self.host.share_bar(tab).is_some()),
            now,
        );
        let share_bar = if page_full { 0.0 } else { share_bar };
        if share_bar > 0.0 {
            layout.toolbar += share_bar;
            self.layout = Some(layout);
        }
        let panel_motion = crate::popovers::side_panel::appear(
            self.window_id.as_str(),
            self.host.side_panel(&self.window_id),
            self.host.side_panel_wanted(&self.window_id),
            state.active_tab(self.window_id.as_str()).map(|tab| &tab.id),
            now,
        );
        let side_panel = panel_motion.panel.clone().filter(|_| !page_full);
        if side_panel.is_some() {
            let room = crate::popovers::side_panel::room(
                state.settings.extension_side_panel_width,
                layout.frame.split_gap,
            ) * panel_motion.appear;
            layout.card.w = (layout.card.w - room).max(0.0);
        }
        let plugin_room = crate::plugins::side_panel::room(
            &self.host,
            &self.window_id,
            layout.frame.split_gap,
            window,
            cx,
        );
        let plugin_room = if page_full { 0.0 } else { plugin_room };
        layout.card.w = (layout.card.w - plugin_room).max(0.0);
        self.pager_tint(window, now);
        let fading = self.sync_platform(&layout, window, now);
        let sliding = self.profile_slide(now);
        let active_id = state
            .active_tab(self.window_id.as_str())
            .map(|tab| tab.id.clone());
        self.overlays.close_history_of(active_id.as_ref());
        let pane_overlay = active_id
            .as_ref()
            .map(|tab| self.host.page_overlay(tab))
            .unwrap_or_default();
        let pill_room = layout.toolbar <= 0.0
            && !(layout.sidebar_shows_address() && layout.sidebar.is_some())
            && browser.kind != ardia_state::windows::WindowKind::LittleArdia;
        let overlay_motion = self.overlays.sync(
            OverlayInput {
                overlay: &pane_overlay,
                loading: pill_room
                    && state
                        .active_tab(self.window_id.as_str())
                        .is_some_and(|tab| tab.live.loading && !is_new_tab_page(Some(tab))),
                reduce_motion: self.reduce_motion(cx),
                notice: shown_notice(
                    &state,
                    self.window_id.as_str(),
                    active_id.as_ref(),
                    self.host.new_tab_notice(&self.window_id),
                ),
                control: self.host.program_control(),
            },
            now,
        );
        if let Some(tab) = active_id.as_ref() {
            let pane = self.active_pane(layout.page(), tab);
            self.swipe.note_pane(pane);
        }
        let swipe_effects = self.swipe.tick(now);
        for msg in crate::window::swipe_overlay::effects_msgs(
            &state,
            self.host.as_ref(),
            &self.window_id,
            swipe_effects,
        ) {
            self.handle(msg, window, cx);
        }
        let swipe_motion = self.swipe.animating(now);
        let swipe_closes = crate::window::swipe_overlay::back_closes(
            &state,
            self.host.as_ref(),
            self.swipe.shown().map(|shown| &shown.tab),
        );
        let frozen_bridge = active_id
            .as_ref()
            .and_then(|tab| state.tab(tab.as_str()))
            .filter(|tab| !crate::window::frozen_page::is_frozen(tab))
            .and_then(|_| self.host.frozen_picture(&self.window_id));
        if fading
            || sliding
            || overlay_motion
            || swipe_motion
            || panel_motion.moving
            || share_moving
            || self.dock.running(now)
            || self.peek.running(now)
        {
            window.request_animation_frame();
        }
        self.drive_peek(&layout, peek_page_of(layout.page(), peek_lift), window, cx);
        let sidebar_edge = self.sync_sidebar_edge(&layout, window, cx);
        let natives = self.attach_natives(&layout, window, cx);
        self.settle_pending_page_focus(window, cx);
        let popup = self.host.extension_popup(&self.window_id);
        let popup_body = {
            let slot = TabId::new("extension-popup");
            let handle = popup.as_ref().and_then(|popup| popup.view);
            let background = gpui::white();
            self.popup_natives
                .attach(&slot, false, handle, background, window, cx)
                .map(|view| div().size_full().child(view).into_any_element())
        };
        let side_panel_body = {
            let slot = TabId::new("extension-side-panel");
            let handle = side_panel
                .as_ref()
                .filter(|_| panel_motion.current && !panel_motion.moving)
                .and_then(|panel| panel.view);
            self.popup_natives
                .attach(&slot, false, handle, gpui::white(), window, cx)
                .map(|view| div().size_full().child(view).into_any_element())
        };
        let active = state.active_tab(self.window_id.as_str()).cloned();
        let host = Arc::clone(&self.host);
        let native_menu = if self.host.native_menus() {
            self.ui.menu.take()
        } else {
            None
        };
        let ui = self.ui.clone();
        let sections = crate::sidebar::model::shared_sections(&state, self.window_id.as_str());
        let plugin_layer = crate::plugins::plugin_layer(
            &self.host,
            &self.window_id,
            crate::plugins::LayerFrame {
                card: crate::window::layout::Rect {
                    w: layout.card.w
                        + side_panel.as_ref().map_or(0.0, |_| {
                            crate::popovers::side_panel::room(
                                state.settings.extension_side_panel_width,
                                layout.frame.split_gap,
                            ) * panel_motion.appear
                        }),
                    ..layout.card
                },
                gap: layout.frame.split_gap,
                radius: layout.frame.radius,
                viewport_width: crate::scale::points(window.viewport_size().width),
                glass: self.look.glass,
            },
            self.look.p,
            window,
            cx,
        );
        let chrome = Chrome {
            state: &state,
            window: &browser,
            look: &self.look,
            p: &self.look.p,
            layout: &layout,
            emit: &self.emit,
            host: &host,
            ui: &ui,
            active: active.as_ref(),
            rename_input: &self.rename_input,
            sections: &sections,
            toast_focus: Some(&self.toast_focus),
        };
        crate::window::hover_hold::note(&chrome);
        if let Some((target, _)) = native_menu {
            crate::popovers::context_menu::present_native(&chrome, &target, window, cx);
        }
        let p = self.look.p;
        let card = layout.card;
        let page = layout.page();
        let sidebar_toggle = layout.layout != EffectiveLayout::TopStrip && self.has_sidebar();
        let peek_tab = state
            .shown_peek(self.window_id.as_str())
            .filter(|_| !page_full)
            .and_then(|peek| state.tab(peek.tab_id.as_str()).cloned());
        let peek_shown = peek_tab.as_ref().and_then(|_| self.peek_shown(cx));
        let popover = browser.chrome.popover.clone();
        let site_leaving = crate::popovers::closing::site_panel_leaving(
            self.window_id.as_str(),
            popover.as_ref(),
            window,
        );
        let downloads_now = Instant::now();
        let downloads_open = matches!(popover, Some(Popover::Downloads));
        self.downloads_motion.update(
            downloads_open,
            &state,
            &self.window_id,
            window.is_window_active(),
            downloads_now,
        );
        let downloads_appear = self.downloads_motion.appear(downloads_now);
        if self.downloads_motion.running(downloads_now) {
            window.request_animation_frame();
        }
        let finds: Vec<(Arc<Tab>, Rect, bool)> = self
            .visible_tabs()
            .into_iter()
            .filter(|tab| tab.live.find.open && !tab.url.is_empty() && !is_new_tab_page(Some(tab)))
            .map(|tab| {
                let rect = self.active_pane(page, &tab.id);
                let live = active.as_ref().is_some_and(|a| a.id == tab.id);
                (tab, rect, live)
            })
            .collect();
        let active_downloads = state
            .downloads
            .items()
            .iter()
            .filter(|d| d.is_active())
            .count();
        let resize_emit = self.emit.clone();
        let edge = layout.trailing;
        let sidebar_x = layout.sidebar.map_or(0.0, |s| s.x);
        let sidebar_w = layout.sidebar_width;
        let overlays_open = self.ui.menu.is_some()
            || self.overlays.history_open()
            || (self.panel.is_open() && !self.panel.is_hero())
            || popup.is_some()
            || matches!(
                popover,
                Some(
                    Popover::Downloads
                        | Popover::SiteControls
                        | Popover::Extensions
                        | Popover::Cast
                )
            )
            || popover.as_ref().is_some_and(|popover| {
                crate::site::render::closes_on_outside_press(popover, self.site.zoom_bubble)
            });
        let catcher_emit = self.emit.clone();
        let catcher_closes_downloads = matches!(popover, Some(Popover::Downloads));
        let history_buttons = {
            let centers = crate::content::toolbar::icon_centers(sidebar_toggle);
            [centers[1], centers[2]]
        };
        let menu = self.ui.menu.clone();
        if menu.is_none() {
            forget_cached_menu(&self.window_id);
        }
        let toolbar_feed = crate::content::toolbar_extensions::feed_from_host(
            self.host.as_ref(),
            &browser.id,
            active.as_ref().map(|tab| &tab.id),
        );
        let body = div()
            .id("browser-window")
            .key_context(if page_full {
                "ArdiaWindow BrowserWindow PageFullScreen"
            } else {
                "ArdiaWindow BrowserWindow"
            })
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .overflow_hidden()
            .font_family(UI_FONT)
            .text_color(p.text)
            .capture_key_down(cx.listener(|view, event: &gpui::KeyDownEvent, window, cx| {
                let active = view
                    .state
                    .active_tab(view.window_id.as_str())
                    .map(|tab| tab.id.clone());
                if let Some(tab) = active
                    && crate::media::share::picker_key(&view.host, &tab, &event.keystroke.key)
                {
                    cx.stop_propagation();
                    window.refresh();
                }
            }))
            .on_key_down(cx.listener(Self::tab_into_toast))
            .on_action(cx.listener(Self::on_run_command))
            .on_action(cx.listener(Self::on_reserved_command))
            .on_action(cx.listener(Self::on_dismiss))
            .when(!browser.profile_id.is_incognito(), |this| {
                let emit = self.emit.clone();
                this.on_drop(move |paths: &gpui::ExternalPaths, window, cx| {
                    let paths: Vec<String> = paths
                        .paths()
                        .iter()
                        .map(|path| path.to_string_lossy().into_owned())
                        .collect();
                    emit.send(Msg::DropFiles(paths), window, cx);
                })
            })
            .when_some(layout.sidebar, |this, rect| {
                this.child(docked_sidebar(&chrome, rect))
            })
            .when_some(layout.strip, |this, rect| {
                this.child(tab_strip::tab_strip(&chrome, rect))
            })
            .when(
                layout.layout == EffectiveLayout::TopStrip && layout.strip.is_none() && !page_full,
                |this| this.child(tab_strip::strip_peek(&chrome, layout.width)),
            )
            .when_some(layout.resize, |this, rect| {
                this.child(crate::sidebar::resize::resize_handle(
                    &resize_emit,
                    crate::sidebar::resize::HandleSpec {
                        window: self.window_id.as_str().to_owned(),
                        rect,
                        trailing: edge,
                        sidebar_x,
                        sidebar_width: sidebar_w,
                    },
                ))
            })
            .child(
                div()
                    .id("content-card")
                    .debug_selector(|| "content-card".into())
                    .absolute()
                    .left(px(card.x))
                    .top(px(card.y))
                    .w(px(card.w))
                    .h(px(card.h))
                    .rounded(px(layout.frame.radius))
                    .map(|this| crate::content::split_view::card_fill(this, &chrome, card, p.card))
                    .when(toolbar_row > 0.0, |this| {
                        this.child(match (active.as_ref(), &plugin_page_bar) {
                            (Some(tab), _) if developer_bar => {
                                crate::content::developer_bar::developer_bar(&chrome, tab, card.w)
                            }
                            (Some(tab), Some(bar)) => {
                                crate::plugins::page_bar::page_bar(&chrome, tab, bar, card.w)
                            }
                            _ => toolbar(&chrome, card, sidebar_toggle, &toolbar_feed),
                        })
                    })
                    .when(bookmarks_bar > 0.0, |this| {
                        this.child(
                            div()
                                .absolute()
                                .left_0()
                                .top(px(toolbar_row))
                                .w(px(card.w))
                                .h(px(bookmarks_bar))
                                .child(crate::bookmarks_bar::bookmarks_bar(
                                    &chrome, card.w, window, cx,
                                )),
                        )
                    })
                    .when(share_bar > 0.0, |this| {
                        this.child(
                            div()
                                .absolute()
                                .left_0()
                                .top(px(toolbar_row + bookmarks_bar))
                                .w(px(card.w))
                                .h(px(share_bar))
                                .overflow_hidden()
                                .children(
                                    share_tab.as_ref().and_then(|tab| {
                                        crate::media::share::share_bar(&chrome, tab)
                                    }),
                                ),
                        )
                    }),
            )
            .child(crate::window::swipe_tracker::swipe_area(
                Arc::clone(&self.host),
                self.window_id.clone(),
                self.swipe_panes(page),
                self.page_content(&chrome, page, &natives),
            ))
            .children(
                frozen_bridge.map(|picture| {
                    crate::window::frozen_page::bridge_layer(&chrome, page, picture)
                }),
            )
            .child(
                div()
                    .absolute()
                    .left(px(page.x))
                    .top(px(page.y))
                    .w(px(page.w))
                    .h(px(page.h))
                    .child(crate::onboarding::tour::probe(
                        self.window_id.clone(),
                        crate::onboarding::tour::Anchor::Page,
                    )),
            )
            .child(crate::bookmarks_bar::bookmarks_layer(&chrome, window, cx))
            .when_some(active_id.as_ref(), |this, tab| {
                let pane = self.active_pane(page, tab);
                this.children(self.overlays.render(&chrome, pane, tab, &pane_overlay, now))
                    .children(self.swipe.render(&chrome, pane, swipe_closes, now))
            })
            .when_some(
                self.host.extension_install(&self.window_id),
                |this, install| {
                    this.child(
                        deferred(crate::popovers::extension_dialogs::install_dialog(
                            &chrome, &install,
                        ))
                        .with_priority(3),
                    )
                },
            )
            .when(self.host.pin_dialog_open(&self.window_id), |this| {
                let list = self.host.extensions(&self.window_id);
                this.child(
                    deferred(crate::popovers::extension_dialogs::pin_dialog(
                        &chrome, &list,
                    ))
                    .with_priority(3),
                )
            })
            .children(plugin_layer)
            .when_some(side_panel, |this, panel| {
                this.child(crate::popovers::side_panel::side_panel(
                    &chrome,
                    &panel,
                    card,
                    side_panel_body,
                    panel_motion.appear,
                ))
            })
            .children(finds.iter().map(|(tab, rect, live)| {
                let replace = crate::content::find_bar::ReplaceRow {
                    input: &self.replace_input,
                    note: self.host.replace_note(&tab.id),
                };
                find_bar(
                    &chrome,
                    crate::content::find_bar::FindPane {
                        tab: &tab.id,
                        rect: *rect,
                        input: live.then_some(&self.find_input),
                    },
                    &tab.live.find,
                    Some(replace),
                )
            }))
            .when_some(
                active.as_ref().and_then(|tab| {
                    crate::site::render::page_layer(
                        &chrome,
                        &self.site,
                        page,
                        tab,
                        sidebar_toggle,
                        is_new_tab_page(Some(tab)),
                    )
                }),
                |this, prompts| this.child(prompts),
            )
            .children(sidebar_edge)
            .when_some(layout.peek, |this, rect| {
                this.child(floating_sidebar(&chrome, rect))
            })
            .when_some(peek_tab, |this, tab| {
                let peek_corners = SlotCorners {
                    top: layout.frame.radius,
                    bottom: layout.frame.radius,
                };
                let live = match natives.get(&tab.id).and_then(|(page, _)| page.clone()) {
                    Some(view) => div().size_full().child(view).into_any_element(),
                    None => placeholder(&chrome, &tab, peek_corners),
                };
                let body = match natives
                    .get(&retiring_slot(&tab.id))
                    .and_then(|(view, _)| view.clone())
                {
                    Some(old) => retiring_swap(
                        live,
                        div().size_full().child(old).into_any_element(),
                        self.host
                            .retiring_page(tab.id.clone())
                            .is_some_and(|retiring| retiring.above),
                    ),
                    None => live,
                };
                let shown = peek_shown.unwrap_or_else(|| {
                    crate::content::peek_overlay::resting_stage(
                        &chrome,
                        peek_page_of(page, peek_lift),
                    )
                });
                this.child(peek_overlay(&chrome, &tab, body, shown))
            })
            .when(downloads_open || downloads_appear > 0.0, |this| {
                this.child(deferred(downloads(&chrome, downloads_appear)).with_priority(2))
            })
            .children(crate::popovers::downloads::flight(
                &chrome,
                &self.downloads_motion,
                downloads_now,
            ))
            .when_some(site_leaving, |this, (popover, exit)| {
                this.children(active.as_ref().and_then(|tab| {
                    crate::site::render::popover_layer(
                        &chrome,
                        &self.site,
                        page,
                        tab,
                        &popover,
                        sidebar_toggle,
                        exit,
                    )
                }))
            })
            .when_some(popover, |this, popover| match popover {
                Popover::Downloads => this,
                Popover::SiteControls
                | Popover::Zoom
                | Popover::BlockedPopups
                | Popover::Custom(_) => this.children(active.as_ref().and_then(|tab| {
                    crate::site::render::popover_layer(
                        &chrome,
                        &self.site,
                        page,
                        tab,
                        &popover,
                        sidebar_toggle,
                        1.0,
                    )
                })),
                Popover::Cast => match active.as_ref().and_then(|tab| {
                    cast_popover(&chrome, &tab.id, self.host.cast_panel(&tab.id).as_ref())
                }) {
                    Some(picker) => this.child(deferred(picker).with_priority(2)),
                    None => this,
                },
                _ => this,
            })
            .when_some(
                active
                    .as_ref()
                    .and_then(|tab| crate::media::share::share_picker(&chrome, &tab.id)),
                |this, picker| this.child(deferred(picker).with_priority(2)),
            )
            .when_some(popup, |this, popup| {
                let width = crate::scale::points(window.viewport_size().width);
                this.child(
                    deferred(extension_popup(&chrome, &popup, width, popup_body)).with_priority(2),
                )
            })
            .when(overlays_open, |this| {
                let emit = catcher_emit.clone();
                this.child(
                    deferred(
                        div()
                            .id("overlay-catcher")
                            .absolute()
                            .inset_0()
                            .occlude()
                            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                if catcher_closes_downloads {
                                    ardia_telemetry::counts::count("downloads_panel_press_closes");
                                }
                                emit.send(Msg::CloseOverlays, window, cx);
                            })
                            .on_mouse_down(MouseButton::Right, {
                                let emit = catcher_emit.clone();
                                move |_, window, cx| emit.send(Msg::CloseOverlays, window, cx)
                            }),
                    )
                    .with_priority(1),
                )
            })
            .when_some(
                self.overlays
                    .render_history(&chrome, page, history_buttons[0], history_buttons[1]),
                |this, menu| this.child(deferred(menu).with_priority(2)),
            )
            .when(self.panel.is_open(), |this| {
                this.child(deferred(command_panel(&chrome, &self.panel)).with_priority(2))
            })
            .when_some(menu, |this, (target, at)| {
                this.child(context_menu_cached(&chrome, &state, &target, at))
            })
            .when_some(toasts(&chrome, page), |this, toasts| {
                this.child(deferred(toasts).with_priority(2))
            })
            .when_some(
                crate::sidebar::tab_switcher::overlay(&chrome),
                |this, switcher| this.child(deferred(switcher).with_priority(2)),
            )
            .when_some(
                crate::sidebar::search_tabs::panel(&chrome),
                |this, search| this.child(deferred(search).with_priority(2)),
            )
            .when_some(
                crate::sidebar::icon_picker::layer(&chrome),
                |this, picker| this.child(deferred(picker).with_priority(3)),
            )
            .children(crate::live::views::window_alert(
                &chrome,
                crate::scale::points(window.viewport_size().width),
                window.is_window_active(),
            ))
            .child(self.people.clone())
            .child(self.report_sheet.clone())
            .when_some(
                crate::onboarding::tour::overlay(&chrome, &self.emit, window, cx),
                |this, tour| this.child(deferred(tour).with_priority(3)),
            )
            .when(self.confirm_close, |this| {
                this.child(
                    deferred(close_with_downloads(&chrome, page, active_downloads.max(1)))
                        .with_priority(3),
                )
            });
        body.into_any_element()
    }
}

impl BrowserWindowView {
    pub fn title(&self) -> SharedString {
        SharedString::from(self.title.clone())
    }
}
