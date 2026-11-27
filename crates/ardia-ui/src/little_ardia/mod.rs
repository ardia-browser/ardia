use std::sync::Arc;
use std::time::Instant;

use crate::scale::px;
use ardia_state::omnibox::suggest::Suggestion;
use ardia_state::windows::{CommandBarPlacementState, CommandBarState};
use ardia_state::{Action, BrowserState, Interest, Topics, WindowId};
use ardia_theme::FieldSurface;
use ardia_theme::layout::LITTLE_ARDIA_BAR_HEIGHT;
use gpui::{
    App, Context, Entity, FocusHandle, Focusable, FontWeight, IntoElement, MouseButton,
    ParentElement, Render, SharedString, Styled, Subscription, Window, deferred, div, prelude::*,
};

use crate::content::toolbar::is_new_tab_page;
use crate::content::web_slot::{SlotCorners, web_slot};
use crate::host::UiHost;
use crate::keybindings::{Dismiss, RunCommand, RunReservedCommand};
use crate::look::{Look, UI_FONT};
use crate::msg::{Emit, Msg};
use crate::omnibox::{CommandPanel, PanelRequest, command_panel};
use crate::primitives::icons::Icon;
use crate::primitives::text_input::{InputEvent, InputStyle, SubmitKind, TextInput};
use crate::primitives::theme_bridge::{hsla, traffic_light_origin};
use crate::store_link::StoreLink;
use crate::window::backdrop::BackdropDriver;
use crate::window::chrome::{Chrome, ChromeUi};
use crate::window::layout::{ChromeLayout, LayoutInput, chrome_layout, little_ardia_layout};
use crate::window::native_views::NativeViews;

pub mod gestures;
pub mod small_chrome;

use small_chrome::{
    NAV_CENTER_PAST_ZOOM, SMALL_BAR_BUTTON, SMALL_BAR_GAP, SMALL_FIELD_GAP, SMALL_FIELD_HEIGHT,
    SMALL_INSET, SmallButton, TRAFFIC_LIGHT_PITCH, buttons_width, page_label, small_button,
};

pub const COPIED_FOR: std::time::Duration = std::time::Duration::from_millis(1400);

pub struct LittleBarState {
    pub copied: bool,
    pub panel_open: bool,
}

pub struct LittleArdiaWindowView {
    pub(crate) host: Arc<dyn UiHost>,
    pub(crate) window_id: WindowId,
    pub(crate) state: Arc<BrowserState>,
    pub(crate) look: Look,
    pub(crate) emit: Emit,
    pub(crate) panel: CommandPanel,
    focus: FocusHandle,
    rename: Entity<TextInput>,
    natives: NativeViews,
    backdrop: BackdropDriver,
    removed: bool,
    gpui_window: gpui::WindowId,
    last_bar: Option<CommandBarState>,
    copied: Option<gpui::Task<()>>,
    pinch: crate::primitives::pinch::PinchTracker,
    zoom: gestures::LittleZoom,
    swipe: gestures::LittleSwipe,
    history_swipe: crate::window::swipe_overlay::SwipeOverlay,
    swipe_closing: bool,
    leaving: bool,
    menu: Option<(crate::msg::MenuTarget, gpui::Point<gpui::Pixels>)>,
    _store: StoreLink,
    _page_swipes: crate::host_data::HostLink,
    _subscriptions: Vec<Subscription>,
}

impl Focusable for LittleArdiaWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl LittleArdiaWindowView {
    pub fn new(
        host: Arc<dyn UiHost>,
        window_id: WindowId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = host.store().snapshot();
        crate::scale::sync(&state, cx);
        let look = Look::new(&state, window_id.as_str(), window.appearance());
        let panel = CommandPanel::new(cx);
        let rename = cx.new(|cx| TextInput::new("", cx));
        let subscriptions = vec![
            cx.subscribe_in(&panel.input, window, Self::on_panel_input),
            cx.observe_window_appearance(window, |this, window, cx| {
                this.sync(Topics::ALL, window, cx)
            }),
            cx.observe_window_activation(window, |this, window, cx| {
                this.sync(Topics::ALL, window, cx)
            }),
            cx.on_release(|this, cx| this.release(cx)),
        ];
        let store = StoreLink::new(
            host.store(),
            Interest::Topics(Topics::ALL),
            window,
            cx,
            Self::sync,
        );
        let page_swipes = crate::host_data::HostLink::new(
            host.host_signal(),
            crate::host_data::HostTopics::PAGE,
            window,
            cx,
            Self::on_page_swipes,
        );
        let close_host = Arc::clone(&host);
        let close_id = window_id.clone();
        window.on_window_should_close(cx, move |_, _| {
            close_host.request_window_close(close_id.clone());
            false
        });
        let mut view = LittleArdiaWindowView {
            emit: Emit::new(cx.weak_entity(), Self::handle),
            host,
            window_id,
            state,
            look,
            panel,
            focus: cx.focus_handle(),
            rename,
            natives: NativeViews::default(),
            backdrop: BackdropDriver::default(),
            removed: false,
            gpui_window: window.window_handle().window_id(),
            last_bar: None,
            copied: None,
            pinch: Default::default(),
            zoom: Default::default(),
            swipe: Default::default(),
            history_swipe: Default::default(),
            swipe_closing: false,
            leaving: false,
            menu: None,
            _store: store,
            _page_swipes: page_swipes,
            _subscriptions: subscriptions,
        };
        view.backdrop.aim(
            view.look.backdrop(crate::window::looks_active(window)),
            false,
            Instant::now(),
        );
        view.backdrop.apply(window, Instant::now());
        view.backdrop.place_lights(
            traffic_light_origin(ardia_theme::layout::lights::LITTLE_ARDIA_CENTER),
            window,
        );
        window.focus(&view.focus, cx);
        view
    }

    pub fn window_id(&self) -> &WindowId {
        &self.window_id
    }

    pub fn panel(&self) -> &CommandPanel {
        &self.panel
    }

    fn sync(&mut self, _: Topics, window: &mut Window, cx: &mut Context<Self>) {
        if self.removed {
            return;
        }
        self.state = self.host.store().snapshot();
        crate::scale::sync(&self.state, cx);
        let Some(little) = self.state.window(self.window_id.as_str()).cloned() else {
            self.release(cx);
            window.remove_window();
            return;
        };
        let bar = little.chrome.command_bar.clone();
        if bar.open && (!self.panel.is_open() || self.last_bar.as_ref() != Some(&bar)) {
            self.last_bar = Some(bar.clone());
            self.show_panel(bar.initial_text, window, cx);
        } else if !bar.open {
            self.last_bar = None;
            if self.panel.is_open() {
                self.panel.close();
                window.focus(&self.focus, cx);
            }
        }
        if self
            .look
            .refresh(&self.state, self.window_id.as_str(), window.appearance())
        {
            self.backdrop.aim(
                self.look.backdrop(crate::window::looks_active(window)),
                false,
                Instant::now(),
            );
        }
        let state = Arc::clone(&self.state);
        let own = self.window_id.clone();
        self.natives.retain(
            self.gpui_window,
            |tab| state.tab(tab.as_str()).is_some_and(|t| t.window_id == own),
            cx,
        );
        cx.notify();
    }

    fn release(&mut self, cx: &mut App) {
        if self.removed {
            return;
        }
        self.removed = true;
        self.natives.release_all(self.gpui_window, cx);
        self.host.unregister_gpui_window(self.window_id.clone());
    }

    fn show_panel(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let style = InputStyle {
            text: self.look.p.command_text,
            placeholder: self.look.p.command_placeholder,
            caret: hsla(self.look.theme.caret_color(FieldSurface::PopoverField)),
            selection: self.look.p.selection,
            font_size: 13.0,
            weight: FontWeight::NORMAL,
        };
        let state = Arc::clone(&self.state);
        self.panel.prepare(
            &state,
            PanelRequest {
                text: &text,
                new_tab: None,
                placement: CommandBarPlacementState::Field,
                style,
            },
            window,
            cx,
        );
        cx.notify();
    }

    fn open_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let url = self
            .state
            .active_tab(self.window_id.as_str())
            .filter(|t| !is_new_tab_page(Some(t)))
            .map(|t| t.url.clone())
            .unwrap_or_default();
        let request = CommandBarState {
            open: true,
            initial_text: url.clone(),
            new_tab: None,
            placement: CommandBarPlacementState::Field,
        };
        self.last_bar = Some(request.clone());
        self.host.dispatch(Action::SetCommandBar {
            window: self.window_id.clone(),
            state: request,
        });
        self.show_panel(url, window, cx);
    }

    fn close_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.panel.close();
        self.host.dispatch(Action::SetCommandBar {
            window: self.window_id.clone(),
            state: CommandBarState::default(),
        });
        window.focus(&self.focus, cx);
        self.sync(Topics::ALL, window, cx);
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.panel.input.read(cx).text().trim().to_owned();
        let target = match self.panel.chosen().cloned() {
            Some(Suggestion::Action { .. }) | None => text,
            Some(suggestion) => suggestion.url().map(str::to_owned).unwrap_or(text),
        };
        self.close_panel(window, cx);
        if let Some(tab) = self
            .state
            .active_tab(self.window_id.as_str())
            .map(|t| t.id.clone())
            && !target.is_empty()
        {
            self.host.navigate(self.window_id.clone(), tab, target);
        }
        self.sync(Topics::ALL, window, cx);
    }

    fn on_panel_input(
        &mut self,
        _: &Entity<TextInput>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Changed { deleting } => {
                let state = Arc::clone(&self.state);
                self.panel.refresh(
                    &state,
                    &self.window_id,
                    *deleting,
                    ardia_state::store::now_ms(),
                    cx,
                );
                cx.notify();
            }
            InputEvent::Submit(SubmitKind::Plain | SubmitKind::Alternate | SubmitKind::Shift) => {
                self.submit(window, cx)
            }
            InputEvent::Cancel => self.close_panel(window, cx),
            InputEvent::Up => {
                self.panel.step(-1);
                cx.notify();
            }
            InputEvent::Down | InputEvent::Tab => {
                self.panel.step(1);
                cx.notify();
            }
        }
    }

    fn handle(&mut self, msg: Msg, window: &mut Window, cx: &mut Context<Self>) {
        let Some(msg) = msg.deliver(&*self.host, Some(&self.window_id), cx) else {
            self.menu = None;
            self.sync(Topics::ALL, window, cx);
            return;
        };
        match msg {
            Msg::OpenCommandPanel { .. } => self.open_panel(window, cx),
            Msg::SubmitPanel { .. } => self.submit(window, cx),
            Msg::PickSuggestion(index) => {
                self.panel.selected = Some(index);
                self.submit(window, cx);
            }
            Msg::CloseOverlays if self.menu.is_some() => {
                self.menu = None;
                cx.notify();
            }
            Msg::CloseOverlays => self.close_panel(window, cx),
            Msg::Menu(menu) => {
                self.menu = menu;
                cx.notify();
            }
            Msg::Command(id) => self.run_command(&id, window, cx),
            Msg::Navigate { tab, input } => self.host.navigate(self.window_id.clone(), tab, input),
            _ => {}
        }
    }

    fn run_command(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let tab = self
            .state
            .active_tab(self.window_id.as_str())
            .map(|t| t.id.clone());
        match id {
            "closeTab" | "std:closeWindow:" => {
                self.host.request_window_close(self.window_id.clone())
            }
            "openFile" | "openPeekAsTab" | "littleArdia:promote" => {
                self.host.open_little_ardia_in_main(self.window_id.clone());
            }
            "focusCommandBar" => self.open_panel(window, cx),
            "littleArdia:copyLink" => self.copy_link(cx),
            "littleArdia:profileMenu" => {}
            "copyUrl" => {
                if let Some(url) = self
                    .state
                    .active_tab(self.window_id.as_str())
                    .map(|t| t.url.clone())
                {
                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(url));
                }
            }
            "reload" | "forceReload" => {
                if let Some(tab) = tab {
                    self.host.reload(tab, id == "forceReload");
                }
            }
            "back" => {
                if let Some(tab) = tab {
                    self.host.go_back(tab);
                }
            }
            "forward" => {
                if let Some(tab) = tab {
                    self.host.go_forward(tab);
                }
            }
            "zoomIn" | "zoomOut" | "zoomReset" => {
                if let Some(tab) = tab {
                    match id {
                        "zoomIn" => self.host.zoom_step(tab, 1),
                        "zoomOut" => self.host.zoom_step(tab, -1),
                        _ => self.host.set_zoom(tab, 1.0),
                    }
                }
            }
            "nextProfile" | "previousProfile" => {
                let order = self.state.profile_order.clone();
                let current = self
                    .state
                    .window(self.window_id.as_str())
                    .map(|w| w.profile_id.clone());
                if let Some(at) = current.and_then(|c| order.iter().position(|p| *p == c))
                    && order.len() > 1
                {
                    let delta: i32 = if id == "nextProfile" { 1 } else { -1 };
                    let next = (at as i32 + delta).rem_euclid(order.len() as i32) as usize;
                    self.host.dispatch(Action::SwitchProfile {
                        window: self.window_id.clone(),
                        profile: order[next].clone(),
                    });
                }
            }
            other => log::debug!("{other} does nothing in Little Ardia"),
        }
        self.sync(Topics::ALL, window, cx);
    }

    fn copy_link(&mut self, cx: &mut Context<Self>) {
        let Some(url) = self
            .state
            .active_tab(self.window_id.as_str())
            .map(|t| t.url.clone())
            .filter(|url| !url.is_empty())
        else {
            return;
        };
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(url));
        self.copied = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(COPIED_FOR).await;
            let _ = this.update(cx, |view, cx| {
                view.copied = None;
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn on_pinch(&mut self, event: &gpui::PinchEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !window.is_fullscreen() {
            cx.stop_propagation();
        }
        let mut motion = LittlePinch {
            host: Arc::clone(&self.host),
            window: self.window_id.clone(),
            full_screen: window.is_fullscreen(),
            reduce: cx.reduce_motion(),
            leaving: &mut self.leaving,
            zoom: &mut self.zoom,
            now: Instant::now(),
        };
        self.pinch.step(event, &mut motion);
        cx.notify();
    }

    fn on_navigate_back(
        &mut self,
        event: &gpui::MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.button != MouseButton::Navigate(gpui::NavigationDirection::Back) {
            return;
        }
        let Some(tab) = self.state.active_tab(self.window_id.as_str()).cloned() else {
            return;
        };
        let swipe = crate::window::swipe_overlay::PageSwipe {
            tab: tab.id.clone(),
            phase: crate::window::swipe_overlay::SwipePhase::Swipe,
            direction: crate::window::page_overlays::HistoryDirection::Back,
            distance: 0.0,
            dy: 0.0,
            velocity: 0.0,
        };
        self.take_swipe(&swipe, tab.live.can_go_back, window, cx);
    }

    fn on_page_swipes(
        &mut self,
        _: crate::host_data::HostTopics,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for swipe in self.host.take_page_swipes(&self.window_id) {
            let can_go_back = self
                .state
                .tab(swipe.tab.as_str())
                .is_some_and(|tab| tab.live.can_go_back);
            if matches!(
                swipe.phase,
                crate::window::swipe_overlay::SwipePhase::Began
                    | crate::window::swipe_overlay::SwipePhase::Swipe
            ) {
                self.swipe_closing =
                    gestures::swipe_closes(swipe.direction, can_go_back, window.is_fullscreen());
            }
            if self.swipe_closing {
                self.take_swipe(&swipe, can_go_back, window, cx);
            } else {
                self.history_swipe(&swipe, window, cx);
            }
        }
    }

    fn history_swipe(
        &mut self,
        swipe: &crate::window::swipe_overlay::PageSwipe,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let host = Arc::clone(&self.host);
        let items = crate::window::swipe_overlay::items_for(host.as_ref(), &swipe.tab);
        let height = self.history_swipe.pane_height();
        let out = self
            .history_swipe
            .on_swipe(swipe, height, items, Instant::now());
        let state = Arc::clone(&self.state);
        for msg in
            crate::window::swipe_overlay::effects_msgs(&state, host.as_ref(), &self.window_id, out)
        {
            self.handle(msg, window, cx);
        }
        cx.notify();
    }

    fn take_swipe(
        &mut self,
        swipe: &crate::window::swipe_overlay::PageSwipe,
        can_go_back: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.leaving || window.is_fullscreen() {
            return;
        }
        let outcome = self
            .swipe
            .on_swipe(swipe, can_go_back, cx.reduce_motion(), Instant::now());
        if outcome == gestures::SwipeOutcome::Close {
            self.leave_by_swipe();
        }
        cx.notify();
    }

    fn leave_by_swipe(&mut self) {
        self.leaving = true;
        self.host.request_window_close(self.window_id.clone());
    }

    fn on_run_command(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        self.run_command(&action.id, window, cx);
    }

    fn on_reserved(
        &mut self,
        action: &RunReservedCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.run_command(&action.id, window, cx);
    }

    fn on_dismiss(&mut self, _: &Dismiss, window: &mut Window, cx: &mut Context<Self>) {
        if self.panel.is_open() {
            self.close_panel(window, cx);
        } else {
            let blank = self
                .state
                .active_tab(self.window_id.as_str())
                .is_none_or(|tab| tab.url.is_empty());
            ardia_telemetry::counts::count(if blank {
                "little_ardia_escape_closes_blank"
            } else {
                "little_ardia_escape_closes"
            });
            self.host.request_window_close(self.window_id.clone());
            self.sync(Topics::ALL, window, cx);
        }
    }
}

impl Render for LittleArdiaWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let started = std::time::Instant::now();
        crate::profiled::profiled_root(
            ardia_profile::FrameSlot::Little,
            started,
            self.render_root(window, cx),
        )
    }
}

impl LittleArdiaWindowView {
    fn render_root(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        self.backdrop.fit(&self.look, window);
        if self.backdrop.apply(window, Instant::now()) {
            window.request_animation_frame();
        }
        let state = Arc::clone(&self.state);
        let Some(browser) = state.window(self.window_id.as_str()).cloned() else {
            return div().id("little-ardia").into_any_element();
        };
        let (width, height) = crate::scale::logical_size(window.viewport_size());
        let inset = state.settings.page_frame_inset(false, false);
        let (card, _) = little_ardia_layout(width, height, inset);
        let radius = ardia_theme::layout::scaled_card_radius(inset).max(6.0);
        let now = Instant::now();
        let zoom = self.zoom.value(now);
        let swipe_x = self.swipe.offset(now);
        if self.swipe.left(now) {
            self.leave_by_swipe();
        }
        if self.zoom.running() || self.swipe.running() {
            window.request_animation_frame();
        }
        let swipe_alpha = gestures::LittleSwipe::opacity(swipe_x);
        let swipe_pane = crate::window::layout::Rect::new(0.0, 0.0, card.w, card.h);
        self.history_swipe.note_pane(swipe_pane);
        let swipe_effects = self.history_swipe.tick(now);
        for msg in crate::window::swipe_overlay::effects_msgs(
            &state,
            self.host.as_ref(),
            &self.window_id,
            swipe_effects,
        ) {
            self.handle(msg, window, cx);
        }
        if self.history_swipe.animating(now) {
            window.request_animation_frame();
        }
        let history_back_closes = crate::window::swipe_overlay::back_closes(
            &state,
            self.host.as_ref(),
            self.history_swipe.shown().map(|shown| &shown.tab),
        );
        self.backdrop
            .override_gradients((swipe_alpha < 1.0).then(|| {
                let gradients = self.backdrop.gradients();
                gradients.opacity(gradients.opacity * swipe_alpha)
            }));
        let headroom = LITTLE_ARDIA_BAR_HEIGHT.min(crate::window::layout::WINDOW_CORNER_RADIUS);
        let corner = gestures::zoomed_corner(
            zoom,
            width,
            height,
            inset,
            radius,
            crate::window::layout::WINDOW_CORNER_RADIUS,
        )
        .unwrap_or(0.0);
        let card_top_radius = radius.max(corner - headroom);
        let card_bottom_radius = radius.max(corner);
        let base: ChromeLayout = chrome_layout(LayoutInput {
            width,
            height,
            layout: ardia_state::model::EffectiveLayout::Sidebar,
            inset,
            sidebar_width: 0.0,
            trailing: false,
            dock: 0.0,
            peek: 0.0,
            compact: false,
            full_screen: false,
            page_full_screen: false,
            has_sidebar: false,
            field_hidden: false,
        });
        let layout = ChromeLayout {
            card,
            toolbar: 0.0,
            lights: Some(ardia_theme::layout::lights::LITTLE_ARDIA_CENTER),
            ..base
        };
        let active = state.active_tab(self.window_id.as_str()).cloned();
        let background = self.look.p.card;
        let page = match &active {
            Some(tab) => {
                let views = self.host.tab_native_views(tab.id.clone());
                let attached = self.natives.attach(
                    &tab.id,
                    false,
                    views.and_then(|v| v.page_view),
                    background,
                    window,
                    cx,
                );
                if attached.is_some() {
                    self.natives.round(
                        &tab.id,
                        false,
                        SlotCorners {
                            top: card_top_radius,
                            bottom: card_bottom_radius,
                        }
                        .native(),
                        window,
                        cx,
                    );
                }
                attached
            }
            None => None,
        };
        let ui = ChromeUi {
            profile_alpha: 1.0,
            ..ChromeUi::default()
        };
        let native_menu = if self.host.native_menus() {
            self.menu.take()
        } else {
            None
        };
        let host = Arc::clone(&self.host);
        let sections = crate::sidebar::model::Sections::default();
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
            rename_input: &self.rename,
            sections: &sections,
            toast_focus: None,
        };
        if let Some((target, _)) = native_menu {
            crate::popovers::context_menu::present_native(&chrome, &target, window, cx);
        }
        let p = self.look.p;
        let history_capsule =
            self.history_swipe
                .render(&chrome, swipe_pane, history_back_closes, now);
        let bar = little_bar(
            &chrome,
            active.as_ref(),
            &LittleBarState {
                copied: self.copied.is_some(),
                panel_open: self.panel.is_open(),
            },
        );
        let content = match &active {
            Some(tab) => web_slot(
                &chrome,
                tab,
                page,
                None,
                SlotCorners {
                    top: card_top_radius,
                    bottom: card_bottom_radius,
                },
            ),
            None => div().into_any_element(),
        };
        let panel_open = self.panel.is_open();
        let menu = self.menu.clone();
        let page_full = self.state.fullscreen_tab(self.window_id.as_str()).is_some();
        div()
            .id("little-ardia")
            .key_context(if page_full {
                "ArdiaWindow LittleArdia PageFullScreen"
            } else {
                "ArdiaWindow LittleArdia"
            })
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .font_family(UI_FONT)
            .text_color(p.text)
            .on_action(cx.listener(Self::on_run_command))
            .on_action(cx.listener(Self::on_reserved))
            .on_action(cx.listener(Self::on_dismiss))
            .on_pinch(cx.listener(Self::on_pinch))
            .on_mouse_down(
                MouseButton::Navigate(gpui::NavigationDirection::Back),
                cx.listener(Self::on_navigate_back),
            )
            .child(
                div()
                    .id("little-ardia-swipe")
                    .absolute()
                    .top_0()
                    .left(px(swipe_x))
                    .size_full()
                    .when(swipe_alpha < 1.0, |this| this.opacity(swipe_alpha))
                    .child(
                        div()
                            .id("little-ardia-zoom")
                            .debug_selector(|| "little-ardia-zoom".into())
                            .absolute()
                            .inset_0()
                            .when((zoom - 1.0).abs() > 1e-5, |this| this.scale(zoom))
                            .child(
                                div()
                                    .id("little-ardia-card")
                                    .debug_selector(|| "little-ardia-card".into())
                                    .absolute()
                                    .left(px(card.x))
                                    .top(px(card.y))
                                    .w(px(card.w))
                                    .h(px(card.h))
                                    .rounded_tl(px(card_top_radius))
                                    .rounded_tr(px(card_top_radius))
                                    .rounded_bl(px(card_bottom_radius))
                                    .rounded_br(px(card_bottom_radius))
                                    .bg(p.card)
                                    .child(content)
                                    .children(history_capsule),
                            )
                            .child(bar),
                    ),
            )
            .when_some(menu, |this, (target, at)| {
                let emit = self.emit.clone();
                this.child(
                    deferred(div().absolute().inset_0().occlude().on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            emit.send(Msg::CloseOverlays, window, cx);
                        },
                    ))
                    .with_priority(1),
                )
                .child(crate::popovers::context_menu::context_menu(
                    &chrome, &target, at,
                ))
            })
            .when(panel_open, |this| {
                let emit = self.emit.clone();
                this.child(
                    deferred(div().absolute().inset_0().occlude().on_mouse_down(
                        MouseButton::Left,
                        move |_, window, cx| {
                            emit.send(Msg::CloseOverlays, window, cx);
                        },
                    ))
                    .with_priority(1),
                )
                .child(deferred(command_panel(&chrome, &self.panel)).with_priority(2))
            })
            .into_any_element()
    }
}

pub fn little_bounds(saved: [f64; 2], visible: [f32; 2]) -> [f32; 2] {
    ardia_theme::layout::little_ardia_size([saved[0] as f32, saved[1] as f32], visible)
}

pub fn nav_left() -> f32 {
    ardia_theme::layout::lights::LITTLE_ARDIA_CENTER[0]
        + 2.0 * TRAFFIC_LIGHT_PITCH
        + NAV_CENTER_PAST_ZOOM
        - SMALL_BAR_BUTTON / 2.0
}

pub fn nav_pitch() -> f32 {
    SMALL_BAR_BUTTON + SMALL_BAR_GAP
}

pub fn field_left() -> f32 {
    nav_left() + nav_pitch() + SMALL_BAR_BUTTON + SMALL_FIELD_GAP
}

pub fn profile_button_shown(
    state: &BrowserState,
    window: &ardia_state::windows::BrowserWindow,
) -> bool {
    state.settings.show_profile_dots
        && state.profile_order.len() > 1
        && window.kind != ardia_state::windows::WindowKind::Incognito
}

fn little_bar(
    c: &Chrome,
    tab: Option<&Arc<ardia_state::tabs::Tab>>,
    bar: &LittleBarState,
) -> gpui::Stateful<gpui::Div> {
    let p = *c.p;
    let height = LITTLE_ARDIA_BAR_HEIGHT;
    let button_top = (height - SMALL_BAR_BUTTON) / 2.0;
    let has_url = tab.is_some_and(|t| !t.url.is_empty());
    let link = crate::keybindings::hint(c.state, "copyUrl").or_else(|| Some("⇧⌘C".to_owned()));
    let open = crate::keybindings::hint(c.state, "openFile").or_else(|| Some("⌘O".to_owned()));
    let buttons = vec![
        SmallButton {
            id: "little-copy".into(),
            glyph: if bar.copied { Icon::Check } else { Icon::Link },
            tooltip: crate::content::find_bar::with_shortcut("Copy Link", link),
            disabled: !has_url,
            msg: Msg::Command(SharedString::new_static("littleArdia:copyLink")),
        },
        SmallButton {
            id: "little-open".into(),
            glyph: Icon::Expand,
            tooltip: crate::content::find_bar::with_shortcut("Open in Ardia", open),
            disabled: false,
            msg: Msg::Command(SharedString::new_static("littleArdia:promote")),
        },
    ];
    let profile = profile_button_shown(c.state, c.window)
        .then(|| c.state.profile(c.window.profile_id.as_str()).cloned())
        .flatten();
    let count = buttons.len() + usize::from(profile.is_some());
    let field_right = SMALL_INSET + buttons_width(count) + SMALL_FIELD_GAP;
    let nav = |id: &'static str,
               glyph: Icon,
               slot: f32,
               enabled: bool,
               title: &str,
               command: &str,
               msg: Msg| {
        div()
            .absolute()
            .top(px(button_top))
            .left(px(nav_left() + slot * nav_pitch()))
            .child(small_button(
                c,
                SmallButton {
                    id: id.into(),
                    glyph,
                    tooltip: crate::content::find_bar::with_shortcut(
                        title,
                        crate::keybindings::hint(c.state, command),
                    ),
                    disabled: !enabled,
                    msg,
                },
            ))
    };
    div()
        .id("little-ardia-bar")
        .debug_selector(|| "little-ardia-bar".into())
        .absolute()
        .left_0()
        .top_0()
        .w_full()
        .h(px(height))
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count >= 2 {
                window.titlebar_double_click();
            } else {
                window.start_window_move();
            }
        })
        .when_some(tab, |this, tab| {
            this.child(nav(
                "little-back",
                Icon::ChevronLeft,
                0.0,
                tab.live.can_go_back,
                "Back",
                "back",
                Msg::Back(tab.id.clone()),
            ))
            .child(nav(
                "little-forward",
                Icon::ChevronRight,
                1.0,
                tab.live.can_go_forward,
                "Forward",
                "forward",
                Msg::Forward(tab.id.clone()),
            ))
            .child(
                div()
                    .id("little-ardia-address")
                    .debug_selector(|| "little-ardia-address".into())
                    .group("little-ardia-address")
                    .absolute()
                    .left(px(field_left()))
                    .right(px(field_right))
                    .top(px((height - SMALL_FIELD_HEIGHT) / 2.0))
                    .h(px(SMALL_FIELD_HEIGHT))
                    .rounded(px(small_chrome::FIELD_RADIUS))
                    .when(bar.panel_open, |this| this.opacity(0.0))
                    .hover(move |style| style.bg(p.toolbar_hover))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(c.emit.click(Msg::OpenCommandPanel {
                        new_tab: false,
                        text: None,
                    }))
                    .when(!tab.url.is_empty(), |this| {
                        let emit = c.emit.clone();
                        let menu_tab = tab.id.clone();
                        this.on_mouse_down(MouseButton::Right, move |event, window, cx| {
                            cx.stop_propagation();
                            let paste = cx
                                .read_from_clipboard()
                                .and_then(|item| item.text())
                                .and_then(|text| ardia_state::omnibox::classify_paste(&text));
                            emit.send(
                                Msg::Menu(Some((
                                    crate::msg::MenuTarget::UrlBar(menu_tab.clone(), paste),
                                    event.position,
                                ))),
                                window,
                                cx,
                            );
                        })
                    })
                    .child(page_label(c, tab, false)),
            )
        })
        .child(
            div()
                .absolute()
                .right(px(SMALL_INSET))
                .top(px(button_top))
                .flex()
                .gap(px(SMALL_BAR_GAP))
                .children(buttons.into_iter().map(|button| small_button(c, button)))
                .when_some(profile, |this, profile| {
                    let emit = c.emit.clone();
                    this.child(
                        div()
                            .id("little-profile")
                            .debug_selector(|| "little-profile".into())
                            .size(px(SMALL_BAR_BUTTON))
                            .rounded(px(small_chrome::SMALL_BUTTON_RADIUS))
                            .flex()
                            .items_center()
                            .justify_center()
                            .hover(move |style| style.bg(p.toolbar_hover))
                            .active(move |style| style.bg(p.toolbar_pressed))
                            .tooltip(crate::primitives::controls::tooltip(
                                SharedString::from(format!("Profile: {}", profile.name)),
                                &p,
                            ))
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(move |event, window, cx| {
                                emit.send(
                                    Msg::Menu(Some((
                                        crate::msg::MenuTarget::LittleProfile,
                                        event.position(),
                                    ))),
                                    window,
                                    cx,
                                );
                            })
                            .child({
                                let mut shown = profile.as_ref().clone();
                                if shown.switcher_dot {
                                    shown.icon = None;
                                }
                                crate::profiles::profile_badge(c.host.as_ref(), &shown, 16.)
                            }),
                    )
                }),
        )
}

pub struct LittlePinch<'a> {
    pub host: Arc<dyn UiHost>,
    pub window: WindowId,
    pub full_screen: bool,
    pub reduce: bool,
    pub leaving: &'a mut bool,
    pub zoom: &'a mut gestures::LittleZoom,
    pub now: Instant,
}

impl crate::primitives::pinch::PinchMotion for LittlePinch<'_> {
    fn reduce(&self) -> bool {
        self.reduce
    }

    fn idle(&self) -> bool {
        self.full_screen || *self.leaving
    }

    fn begin(&mut self) {
        self.zoom.stop(self.now);
    }

    fn follow(&mut self, magnification: f32) {
        self.zoom.follow(magnification);
    }

    fn settle(&mut self) {
        self.zoom.settle(self.now);
    }

    fn open(&mut self) {
        ardia_telemetry::counts::count("little_ardia_pinch_opens");
        self.host.open_little_ardia_in_main(self.window.clone());
        self.zoom.settle(self.now);
    }

    fn close(&mut self) {
        ardia_telemetry::counts::count("little_ardia_pinch_closes");
        *self.leaving = true;
        self.host.request_window_close(self.window.clone());
    }
}
