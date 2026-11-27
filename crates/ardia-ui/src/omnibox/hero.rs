use ardia_state::model::EffectiveLayout;
use ardia_state::settings::CommandBarPlacement;
use ardia_state::splits::SplitSide;
use ardia_state::windows::{CommandBarPlacementState, NewTabTarget, Popover, WindowKind};
use ardia_state::{Action, BrowserState, TabId};
use gpui::{ClipboardItem, Context, Window};

use crate::content::toolbar::is_new_tab_page;
use crate::msg::Msg;
use crate::omnibox::frame::Variant;
use crate::omnibox::view::field_style;
use crate::omnibox::{CommandPanel, Disposition, Outcome, PanelKey, PanelMsg};
use crate::primitives::text_input::{InputEvent, SubmitKind};
use crate::window::browser_window::{BrowserWindowView, Destination};

pub fn hero_shown(state: &BrowserState, window: &str) -> Option<TabId> {
    let shown = state.window(window)?;
    if !shown.kind.shows_sidebar() {
        return None;
    }
    let tab = state.active_tab(window)?;
    (is_new_tab_page(Some(tab)) && state.split_of(tab.id.as_str()).is_none())
        .then(|| tab.id.clone())
}

pub fn key_placement(
    setting: CommandBarPlacement,
    small: bool,
    field_shown: bool,
) -> CommandBarPlacementState {
    if small || (setting == CommandBarPlacement::Field && field_shown) {
        CommandBarPlacementState::Field
    } else {
        CommandBarPlacementState::Centred
    }
}

pub fn click_placement(setting: CommandBarPlacement, small: bool) -> CommandBarPlacementState {
    if setting == CommandBarPlacement::CentredOnClick && !small {
        CommandBarPlacementState::Centred
    } else {
        CommandBarPlacementState::Field
    }
}

pub fn address_field_shown(state: &BrowserState, window: &str, sidebar_or_peek: bool) -> bool {
    if state.window(window).is_none() || state.minimalism_in(window) {
        return false;
    }
    if state.effective_layout(window) == EffectiveLayout::ArcSidebar {
        return sidebar_or_peek;
    }
    state
        .active_tab(window)
        .is_some_and(|tab| !tab.url.is_empty())
        && state.fullscreen_tab(window).is_none()
}

pub fn panel_variant(
    state: &BrowserState,
    window: &str,
    new_tab: bool,
    placement: &CommandBarPlacementState,
) -> Variant {
    if new_tab || *placement == CommandBarPlacementState::Centred {
        Variant::Floating
    } else if state.effective_layout(window) == EffectiveLayout::ArcSidebar {
        if state.minimalism_in(window) {
            Variant::Floating
        } else {
            Variant::Dropdown
        }
    } else {
        Variant::Panel
    }
}

pub const PROVIDER_DEADLINE_MS: u64 = 1500;

impl BrowserWindowView {
    fn now() -> i64 {
        ardia_state::store::now_ms()
    }

    pub(crate) fn sync_hero(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let shown = hero_shown(&self.state, self.window_id.as_str());
        if self.panel.is_hero() && (shown.is_none() || shown != self.panel.hero_tab) {
            self.panel.close_hero(cx);
        }
        let Some(tab) = shown else {
            return;
        };
        if self.panel.is_open() || self.rename_input.read(cx).is_focused(window) {
            return;
        }
        self.panel.incognito = self
            .state
            .window(self.window_id.as_str())
            .is_some_and(|w| w.kind == WindowKind::Incognito);
        let style = field_style(&self.look, Variant::Hero);
        let state = std::sync::Arc::clone(&self.state);
        self.panel.open_hero(&state, &tab, style, window, cx);
        if let Some(plugins) = self.host.plugins() {
            self.panel
                .add_actions(crate::plugins::bar_actions::bar_actions(
                    plugins.as_ref(),
                    &state,
                    &self.window_id,
                ));
        }
        cx.notify();
    }

    pub(crate) fn panel_input(
        &mut self,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let state = std::sync::Arc::clone(&self.state);
        let engine = state.default_search_engine();
        let outcome = match event {
            InputEvent::Changed { deleting } => {
                self.panel.extensions =
                    crate::omnibox::extension_candidates(&self.host.extensions(&self.window_id));
                let plugins = self
                    .host
                    .plugins()
                    .map(|host| host.omnibox_providers(&self.window_id))
                    .unwrap_or_default();
                let host = std::sync::Arc::clone(&self.host);
                self.panel.providers =
                    crate::omnibox::active_providers(&state, &self.window_id, &plugins, &|key| {
                        host.automation_approved(key)
                    });
                self.panel
                    .refresh(&state, &self.window_id, *deleting, Self::now(), cx);
                self.request_remote(window, cx);
                self.request_providers(window, cx);
                Outcome::Stay
            }
            InputEvent::Submit(SubmitKind::Plain) => {
                self.panel.submit(Disposition::Current, &engine, cx)
            }
            InputEvent::Submit(SubmitKind::Alternate) => {
                self.panel.enter(true, false, false, false, &engine, cx)
            }
            InputEvent::Submit(SubmitKind::Shift) => {
                self.panel.enter(false, false, true, false, &engine, cx)
            }
            InputEvent::Cancel => self.panel.escape(&state, &self.window_id, Self::now(), cx),
            InputEvent::Up => {
                self.panel.move_by(-1, cx);
                Outcome::Stay
            }
            InputEvent::Down => {
                self.panel.move_by(1, cx);
                Outcome::Stay
            }
            InputEvent::Tab => {
                self.panel
                    .tab_key(&state, &self.window_id, false, Self::now(), cx);
                Outcome::Stay
            }
        };
        self.run_outcome(outcome, window, cx);
        cx.notify();
    }

    pub(crate) fn panel_msg(&mut self, msg: PanelMsg, window: &mut Window, cx: &mut Context<Self>) {
        if !self.panel.is_open() {
            return;
        }
        let state = std::sync::Arc::clone(&self.state);
        let engine = state.default_search_engine();
        let last = self.panel.result.items.len().saturating_sub(1);
        let outcome = match msg {
            PanelMsg::Key(PanelKey::PageUp) => {
                self.panel.page_to(0, cx);
                Outcome::Stay
            }
            PanelMsg::Key(PanelKey::PageDown) => {
                self.panel.page_to(last, cx);
                Outcome::Stay
            }
            PanelMsg::Key(PanelKey::Previous) => {
                self.panel.move_by(-1, cx);
                Outcome::Stay
            }
            PanelMsg::Key(PanelKey::Next) => {
                self.panel.move_by(1, cx);
                Outcome::Stay
            }
            PanelMsg::Key(PanelKey::Tab) => {
                self.panel
                    .tab_key(&state, &self.window_id, false, Self::now(), cx);
                Outcome::Stay
            }
            PanelMsg::Key(PanelKey::LeaveScope) => {
                self.panel
                    .backspace_out_of_scope(&state, &self.window_id, Self::now(), cx);
                Outcome::Stay
            }
            PanelMsg::Key(PanelKey::RemoveSelected) => self.panel.remove_selected(),
            PanelMsg::Key(PanelKey::Enter {
                meta,
                alt,
                shift,
                ctrl,
            }) => self.panel.enter(meta, alt, shift, ctrl, &engine, cx),
            PanelMsg::Pick(index) => {
                self.panel
                    .choose(Some(index), Disposition::Current, &engine, cx)
            }
            PanelMsg::Remove(index) => self.panel.remove_at(index),
            PanelMsg::RowsHovered(over) => {
                self.panel.rows_hovered(over, cx);
                Outcome::Stay
            }
            PanelMsg::Go => self.panel.submit(Disposition::Current, &engine, cx),
            PanelMsg::AddMenu(at) => {
                let native = at.is_some() && self.host.native_menus();
                if native {
                    let entries = crate::omnibox::view::add_menu_entries(&state, &self.window_id);
                    crate::popovers::context_menu::show_native(
                        &self.host, &self.emit, &entries, window, cx,
                    );
                }
                self.panel.add_menu = if native { None } else { at };
                Outcome::Stay
            }
            PanelMsg::SwitchTo(tab) => {
                self.panel.add_menu = None;
                Outcome::Switch {
                    tab,
                    url: String::new(),
                    disposition: Disposition::Current,
                }
            }
            PanelMsg::OpenFile => {
                self.panel.add_menu = None;
                self.dismiss_bar(window, cx);
                self.host.open_file(self.window_id.clone());
                Outcome::Stay
            }
            PanelMsg::Dictate => {
                crate::primitives::text_input::focus_input(&self.panel.input, window, cx);
                self.host.start_dictation();
                Outcome::Stay
            }
            PanelMsg::SiteControls => {
                self.dismiss_bar(window, cx);
                self.emit
                    .defer(Msg::TogglePopover(Popover::SiteControls), window, cx);
                Outcome::Stay
            }
        };
        self.run_outcome(outcome, window, cx);
        cx.notify();
    }

    fn request_remote(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((profile, url, key)) = self.panel.remote_request(&self.state, &self.window_id)
        else {
            return;
        };
        let reply = self.host.search_suggestions(profile, url);
        cx.spawn_in(window, async move |view, cx| {
            if let Ok(Some(body)) = reply.await {
                let _ = view.update_in(cx, |this, _, cx| {
                    let state = std::sync::Arc::clone(&this.state);
                    this.panel
                        .take_remote(&key, &body, &state, &this.window_id, Self::now(), cx);
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn request_providers(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let profile = self
            .state
            .window(self.window_id.as_str())
            .map(|w| w.profile_id.clone())
            .unwrap_or_else(|| self.state.last_active_profile());
        for (id, query, ask) in self.panel.provider_requests() {
            let rows = match ask {
                crate::omnibox::ProviderQuery::Plugin => match self.host.plugins() {
                    Some(plugins) => plugins.query_omnibox_provider(&id, &query),
                    None => continue,
                },
                crate::omnibox::ProviderQuery::Remote { url, template } => {
                    let body = self.host.search_suggestions(profile.clone(), url);
                    let (answer, rows) = futures::channel::oneshot::channel();
                    cx.background_executor()
                        .spawn(async move {
                            let parsed = body
                                .await
                                .ok()
                                .flatten()
                                .and_then(|text| {
                                    serde_json::from_str::<serde_json::Value>(&text).ok()
                                })
                                .map(|value| {
                                    ardia_state::omnibox::providers::parse_provider_reply(
                                        &value,
                                        template.as_deref(),
                                    )
                                })
                                .unwrap_or_default();
                            let _ = answer.send(parsed);
                        })
                        .detach();
                    rows
                }
            };
            cx.spawn_in(window, async move |view, cx| {
                let deadline = std::time::Duration::from_millis(PROVIDER_DEADLINE_MS);
                let timer = cx.background_executor().timer(deadline);
                let answer = futures::future::select(rows, Box::pin(timer)).await;
                if let futures::future::Either::Left((Ok(rows), _)) = answer {
                    let _ = view.update_in(cx, |this, _, cx| {
                        let state = std::sync::Arc::clone(&this.state);
                        this.panel.take_provider_rows(
                            crate::omnibox::ProviderAnswer { id, query, rows },
                            &state,
                            &this.window_id,
                            Self::now(),
                            cx,
                        );
                        cx.notify();
                    });
                }
            })
            .detach();
        }
    }

    fn dismiss_bar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.panel.is_hero() {
            self.panel.reset_hero(cx);
        } else {
            self.close_panel(window, cx);
        }
    }

    pub(crate) fn run_outcome(
        &mut self,
        outcome: Outcome,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match outcome {
            Outcome::Stay => {}
            Outcome::Close => self.close_panel(window, cx),
            Outcome::Copy(text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            Outcome::Remove(url) => {
                let profile = self
                    .state
                    .window(self.window_id.as_str())
                    .map(|w| w.profile_id.clone())
                    .unwrap_or_else(|| self.state.last_active_profile());
                self.host.dispatch(Action::RemoveHistory { profile, url });
                let state = self.host.store().snapshot();
                self.panel
                    .after_removal(&state, &self.window_id, Self::now(), cx);
            }
            Outcome::Extension { id, open } => {
                self.dismiss_bar(window, cx);
                match open {
                    ardia_state::omnibox::providers::ExtensionOpen::Action => {
                        if let Some(tab) = self.active_tab() {
                            self.host.execute_extension_action(tab.id.clone(), id);
                        }
                    }
                    ardia_state::omnibox::providers::ExtensionOpen::Options => {
                        let options = self
                            .host
                            .extensions(&self.window_id)
                            .find(&id)
                            .and_then(|x| x.options_url.clone());
                        if let Some(url) = options {
                            self.open_into(url, Destination::NewTab, window, cx);
                        }
                    }
                }
            }
            Outcome::Bookmarklet(url) => {
                self.dismiss_bar(window, cx);
                if let Some(tab) = self.active_tab() {
                    self.host.run_bookmarklet(tab.id.clone(), url);
                }
            }
            Outcome::Command(id) => {
                self.dismiss_bar(window, cx);
                self.run_command(&id, window, cx);
            }
            Outcome::Switch { tab, .. } => {
                let target = self.panel.new_tab.clone();
                self.dismiss_bar(window, cx);
                if let Some(NewTabTarget::Into(blank)) = target
                    && blank != tab
                    && self
                        .state
                        .tab(blank.as_str())
                        .is_some_and(|t| t.url.is_empty())
                {
                    self.host.dispatch(Action::CloseTabs {
                        tabs: vec![blank],
                        last_closes_window: false,
                    });
                }
                self.dispatch(Action::ActivateTab { tab }, window, cx);
            }
            Outcome::Go { url, disposition } => self.go_from_bar(url, disposition, window, cx),
        }
    }

    fn go_from_bar(
        &mut self,
        url: String,
        disposition: Disposition,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let target = self.panel.new_tab.clone();
        let hero = self.panel.is_hero();
        match disposition {
            Disposition::Current => {
                if !hero {
                    self.close_panel(window, cx);
                }
                self.open_into(url, Destination::of(target, false), window, cx);
            }
            Disposition::NewTab => {
                self.dismiss_bar(window, cx);
                self.open_into(url, Destination::NewTab, window, cx);
            }
            Disposition::NewWindow => {
                self.dismiss_bar(window, cx);
                let shown = self.state.window(self.window_id.as_str()).cloned();
                let kind = shown.as_ref().map_or(WindowKind::Main, |w| {
                    if w.kind == WindowKind::Incognito {
                        WindowKind::Incognito
                    } else {
                        WindowKind::Main
                    }
                });
                let profile = shown.map(|w| {
                    if w.profile_id.is_incognito() {
                        w.profile_id.incognito_original()
                    } else {
                        w.profile_id.clone()
                    }
                });
                self.dispatch(
                    Action::OpenWindow {
                        kind,
                        profile,
                        url: Some(url),
                        frame: None,
                    },
                    window,
                    cx,
                );
            }
            Disposition::Split => {
                ardia_telemetry::counts::count("bar_split_opens");
                self.dismiss_bar(window, cx);
                self.dispatch(
                    Action::OpenSplitPane {
                        window: self.window_id.clone(),
                        side: SplitSide::Right,
                        url: Some(url),
                    },
                    window,
                    cx,
                );
            }
        }
    }
}

impl CommandPanel {
    pub fn reset_hero(&mut self, cx: &mut gpui::App) {
        self.reset_typed();
        self.input
            .update(cx, |input, cx| input.set_text("", false, cx));
    }
}

#[cfg(test)]
mod placement_tests {
    use super::*;
    use ardia_state::ids::{ProfileId, WindowId};
    use ardia_state::windows::BrowserWindow;
    use std::sync::Arc;

    #[test]
    fn command_key_and_address_clicks_place_the_bar_like_the_old_app() {
        use CommandBarPlacement::*;
        use CommandBarPlacementState as S;
        assert_eq!(key_placement(Field, false, true), S::Field);
        assert_eq!(key_placement(Field, false, false), S::Centred);
        assert_eq!(key_placement(Centred, false, true), S::Centred);
        assert_eq!(key_placement(CentredOnClick, false, true), S::Centred);
        assert_eq!(key_placement(Centred, true, false), S::Field);
        assert_eq!(click_placement(Field, false), S::Field);
        assert_eq!(click_placement(Centred, false), S::Field);
        assert_eq!(click_placement(CentredOnClick, false), S::Centred);
        assert_eq!(click_placement(CentredOnClick, true), S::Field);
    }

    #[test]
    fn the_address_field_is_hidden_in_minimalism_and_when_the_sidebar_is_away() {
        let mut state = BrowserState::default();
        let profile = ProfileId::from(ardia_state::ids::DEFAULT_PROFILE_ID);
        Arc::make_mut(&mut state.windows).insert(
            WindowId::from("w"),
            Arc::new(BrowserWindow::new(
                WindowId::from("w"),
                WindowKind::Main,
                profile,
                0,
            )),
        );
        Arc::make_mut(&mut state.settings).address_bar = ardia_state::settings::AddressBar::Sidebar;
        assert!(address_field_shown(&state, "w", true));
        assert!(!address_field_shown(&state, "w", false));
        assert!(!address_field_shown(&state, "missing", true));
        Arc::make_mut(&mut state.settings).minimalism_mode = true;
        assert!(!address_field_shown(&state, "w", true));
        assert_eq!(
            panel_variant(&state, "w", false, &CommandBarPlacementState::Field),
            Variant::Floating
        );
        Arc::make_mut(&mut state.settings).minimalism_mode = false;
        assert_eq!(
            panel_variant(&state, "w", false, &CommandBarPlacementState::Field),
            Variant::Dropdown
        );
        Arc::make_mut(&mut state.settings).address_bar = ardia_state::settings::AddressBar::Toolbar;
        assert!(!address_field_shown(&state, "w", true));
    }

    #[test]
    fn peek_keeps_the_full_toolbar_above_its_page_while_the_toolbar_hides() {
        use crate::window::browser_window::peek_page_of;
        use crate::window::layout::Rect;
        let page = Rect::new(200.0, 50.0, 800.0, 600.0);
        assert_eq!(peek_page_of(page, 0.0), page);
        assert_eq!(
            peek_page_of(page, 24.0),
            Rect::new(200.0, 74.0, 800.0, 576.0)
        );
        assert_eq!(peek_page_of(page, 900.0).h, 0.0);
    }
}
