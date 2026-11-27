use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::actions::{Action, NewTab};
use ardia_state::tabs::Tab;
use ardia_state::{BrowserState, WindowId};
use ardia_theme::layout::toolbar;
use gpui::{
    AnyElement, App, ClickEvent, ElementId, Hsla, IntoElement, MouseButton, ParentElement,
    RenderOnce, SharedString, Styled, Transformation, Window, div, point, prelude::*, radians,
    size, svg,
};

use crate::content::load_fill::ease_enter;
use crate::content::toolbar::ToolbarInk;
use crate::host::UiHost;
use crate::look::Palette;
use crate::msg::{Emit, Msg};
use crate::pages::links::{OpenMode, open_mode_for, open_url};
use crate::primitives::controls::tooltip;
use crate::primitives::icons::Icon;
use crate::window::page_overlays::{HistoryDirection, PaneOverlayMsg, history_items};

pub const STATE_IN: Duration = Duration::from_millis(150);
pub const STATE_OUT: Duration = Duration::from_millis(250);
pub const BREATHE_CYCLE: Duration = Duration::from_millis(1420);
pub const HIDDEN_SCALE: f32 = 0.72;
pub const BREATHE_SCALE: (f32, f32) = (0.96, 1.06);
pub const BREATHE_OPACITY: (f32, f32) = (0.86, 1.0);
pub const RETURN_ROTATION: f32 = 28.0;
pub const HANDOFF: Duration = Duration::from_millis(300);
pub const HANDOFF_INCOMING_DELAY: f32 = 35.0;
pub const HANDOFF_TRAVEL: f32 = 4.0;
pub const LONG_PRESS: Duration = Duration::from_millis(500);

pub fn back_closes_tab(state: &BrowserState, tab: &Tab) -> bool {
    let Some(opener) = tab.opener_id.as_ref() else {
        return false;
    };
    if !tab.live.peek && tab.link_opener_id.as_ref() != Some(opener) {
        return false;
    }
    let Some(source) = state.tab(opener.as_str()) else {
        return false;
    };
    if source.window_id != tab.window_id || source.profile_id != tab.profile_id {
        return false;
    }
    !state.in_pinned_container(tab.id.as_str())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct History {
    pub back: bool,
    pub forward: bool,
    pub back_closes: bool,
}

pub fn history_of(state: &BrowserState, tab: &Tab, host: &dyn UiHost) -> History {
    history_with(
        state,
        tab,
        host.back_to_new_tab(&tab.id),
        host.new_tab_shown(&tab.id),
    )
}

pub fn history_with(
    state: &BrowserState,
    tab: &Tab,
    back_to_new_tab: bool,
    new_tab_shown: bool,
) -> History {
    let closes = back_closes_tab(state, tab);
    let behind = back_to_new_tab && !tab.url.is_empty();
    History {
        back: !new_tab_shown && (tab.live.can_go_back || behind || closes),
        forward: new_tab_shown || tab.live.can_go_forward,
        back_closes: !new_tab_shown && !tab.live.can_go_back && !behind && closes,
    }
}

pub fn back_msgs(state: &BrowserState, tab: &Tab, back_to_new_tab: bool) -> Vec<Msg> {
    if tab.live.can_go_back || back_to_new_tab || !back_closes_tab(state, tab) {
        return vec![Msg::Back(tab.id.clone())];
    }
    if tab.live.peek {
        return vec![Msg::Store(Action::ClosePeek {
            window: tab.window_id.clone(),
        })];
    }
    let shown = state.active_tab(tab.window_id.as_str()).map(|t| &t.id) == Some(&tab.id);
    let mut msgs = vec![
        Msg::Count("back_closes_to_opener"),
        Msg::CloseTab(tab.id.clone()),
    ];
    if let (true, Some(opener)) = (shown, tab.opener_id.clone()) {
        msgs.push(Msg::Store(Action::ActivateTab { tab: opener }));
    }
    msgs
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub opacity: f32,
    pub scale: f32,
    pub rotation: f32,
    pub x: f32,
}

impl Pose {
    const SHOWN: Pose = Pose {
        opacity: 1.0,
        scale: 1.0,
        rotation: 0.0,
        x: 0.0,
    };
}

pub fn reload_poses(loading: bool, since: Option<Duration>) -> (Pose, Pose) {
    let (state, back) = match (loading, since) {
        (true, Some(t)) if t < STATE_IN => {
            (ease_enter(t.as_secs_f32() / STATE_IN.as_secs_f32()), 0.0)
        }
        (false, Some(t)) if t < STATE_OUT => {
            let left = 1.0 - ease_enter(t.as_secs_f32() / STATE_OUT.as_secs_f32());
            (left, left)
        }
        (true, _) => (1.0, 0.0),
        (false, _) => (0.0, 0.0),
    };
    let reload = Pose {
        opacity: 1.0 - state,
        scale: 1.0 + (HIDDEN_SCALE - 1.0) * state,
        rotation: RETURN_ROTATION * back,
        x: 0.0,
    };
    let stop = Pose {
        opacity: state,
        scale: HIDDEN_SCALE + (1.0 - HIDDEN_SCALE) * state,
        rotation: 0.0,
        x: 0.0,
    };
    (reload, stop)
}

pub fn breathe_level(elapsed: Duration) -> f32 {
    let t = elapsed.as_secs_f32() / BREATHE_CYCLE.as_secs_f32();
    (1.0 - (std::f32::consts::TAU * t.fract()).cos()) / 2.0
}

pub fn handoff_poses(direction: i32, elapsed: Duration) -> (Pose, Pose) {
    let total = HANDOFF.as_secs_f32() * 1000.0;
    let v = total * ease_enter(elapsed.as_secs_f32() * 1000.0 / total);
    let d = direction as f32;
    let outgoing = Pose {
        opacity: 1.0 - v / total,
        x: d * HANDOFF_TRAVEL * v / total,
        ..Pose::SHOWN
    };
    let incoming = Pose {
        opacity: ((v - HANDOFF_INCOMING_DELAY) / (total - HANDOFF_INCOMING_DELAY)).clamp(0.0, 1.0),
        x: -d * HANDOFF_TRAVEL * (1.0 - v / total),
        ..Pose::SHOWN
    };
    (outgoing, incoming)
}

pub fn navigation_weight(icon: Icon) -> crate::icon_picker::symbols::SymbolWeight {
    use crate::icon_picker::symbols::SymbolWeight;
    if icon == Icon::XMark {
        SymbolWeight::Medium
    } else {
        SymbolWeight::Semibold
    }
}

fn glyph(icon: Icon, side: f32, color: Hsla, pose: Pose) -> AnyElement {
    let at_rest = pose.scale == 1.0 && pose.rotation == 0.0 && pose.x == 0.0;
    if at_rest {
        return div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .opacity(pose.opacity)
            .child(
                crate::primitives::icons::icon(icon, side, color).weight(navigation_weight(icon)),
            )
            .into_any_element();
    }
    let transformation = Transformation::scale(size(pose.scale, pose.scale))
        .with_rotation(radians(pose.rotation.to_radians()))
        .with_translation(point(px(pose.x), px(0.0)));
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .child(
            svg()
                .data(icon.svg().as_bytes())
                .size(px(side))
                .flex_none()
                .text_color(color.opacity(pose.opacity))
                .with_transformation(transformation),
        )
        .into_any_element()
}

fn breathing_stop(side: f32, color: Hsla, morph: Pose) -> impl IntoElement {
    let (low_scale, high_scale) = BREATHE_SCALE;
    let (low_alpha, high_alpha) = BREATHE_OPACITY;
    let ink = color.opacity(morph.opacity);
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .child(
            svg()
                .data(Icon::XMark.svg().as_bytes())
                .size(px(side))
                .flex_none()
                .text_color(ink)
                .with_timed_transformation(
                    gpui::TimedTransformation::new(BREATHE_CYCLE)
                        .from(
                            Transformation::scale(size(
                                morph.scale * low_scale,
                                morph.scale * low_scale,
                            ))
                            .with_alpha(low_alpha),
                        )
                        .to(Transformation::scale(size(
                            morph.scale * high_scale,
                            morph.scale * high_scale,
                        ))
                        .with_alpha(high_alpha))
                        .with_easing(gpui::Easing::EaseInOut)
                        .alternate(),
                ),
        )
}

#[derive(Clone)]
pub struct NavPlace {
    pub left: f32,
    pub top: f32,
    pub button: f32,
    pub radius: f32,
}

impl NavPlace {
    pub fn centered(center: f32, row: &toolbar::ToolbarRow) -> NavPlace {
        NavPlace {
            left: center - row.button / 2.0,
            top: row.center - row.button / 2.0,
            button: row.button,
            radius: row.button_radius,
        }
    }
}

fn frame(
    id: impl Into<ElementId>,
    place: &NavPlace,
    ink: &ToolbarInk,
    enabled: bool,
) -> gpui::Stateful<gpui::Div> {
    let (hover, pressed) = (ink.hover, ink.pressed);
    div()
        .id(id)
        .absolute()
        .left(px(place.left))
        .top(px(place.top))
        .size(px(place.button))
        .rounded(px(place.radius))
        .when(enabled, |this| {
            this.hover(move |style| style.bg(hover))
                .active(move |style| style.bg(pressed))
        })
}

type PressHandler = Rc<dyn Fn(OpenMode, &mut Window, &mut App)>;

#[derive(Default)]
struct HistoryButtonState {
    handoff: Option<Instant>,
    pressed: u64,
    long_fired: bool,
}

#[derive(IntoElement)]
pub struct HistoryButton {
    pub id: &'static str,
    pub direction: HistoryDirection,
    pub tab: Arc<Tab>,
    pub history: History,
    pub place: NavPlace,
    pub ink: ToolbarInk,
    pub hint: Option<String>,
    pub p: Palette,
    pub emit: Emit,
    pub host: Arc<dyn UiHost>,
    pub back: Vec<Msg>,
    pub focus: Option<Msg>,
}

impl HistoryButton {
    fn enabled(&self) -> bool {
        match self.direction {
            HistoryDirection::Back => self.history.back,
            HistoryDirection::Forward => self.history.forward,
        }
    }

    fn tip(&self) -> SharedString {
        let title = match self.direction {
            HistoryDirection::Forward => "Go Forward",
            HistoryDirection::Back if self.history.back_closes => "Close Tab and Go Back",
            HistoryDirection::Back => "Go Back",
        };
        crate::content::find_bar::with_shortcut(title, self.hint.clone())
    }
}

fn open_history(
    host: &Arc<dyn UiHost>,
    tab: &Tab,
    direction: HistoryDirection,
    mode: OpenMode,
) -> bool {
    let steps = host.navigation_steps(&tab.id);
    let Some(target) = history_items(&steps, direction, 1).into_iter().next() else {
        return false;
    };
    if target.url.is_empty() {
        return false;
    }
    open_url(host, &tab.window_id, &tab.id, &target.url, mode);
    true
}

impl RenderOnce for HistoryButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = Instant::now();
        let enabled = self.enabled();
        let tip = self.tip();
        let state = window.use_keyed_state(
            SharedString::from(format!("{}:{}", self.id, self.tab.window_id)),
            cx,
            |_, _| HistoryButtonState::default(),
        );
        let handoff = state
            .read(cx)
            .handoff
            .filter(|start| now.saturating_duration_since(*start) < HANDOFF);
        if handoff.is_some() {
            window.request_animation_frame();
        }
        let icon = match self.direction {
            HistoryDirection::Back => Icon::ChevronLeft,
            HistoryDirection::Forward => Icon::ChevronRight,
        };
        let color = if enabled {
            self.ink.icon
        } else {
            self.ink.icon_disabled
        };
        let step = self.direction.step();
        let face: Vec<gpui::AnyElement> = match handoff {
            Some(start) => {
                let (out, inn) = handoff_poses(step, now.saturating_duration_since(start));
                vec![
                    glyph(icon, toolbar::GLYPH, color, out).into_any_element(),
                    glyph(icon, toolbar::GLYPH, color, inn).into_any_element(),
                ]
            }
            None => vec![glyph(icon, toolbar::GLYPH, color, Pose::SHOWN).into_any_element()],
        };
        let direction = self.direction;
        let menu = {
            let emit = self.emit.clone();
            let tab = self.tab.id.clone();
            let focus = self.focus.clone();
            move |window: &mut Window, cx: &mut App| {
                if let Some(focus) = focus.clone() {
                    emit.send(focus, window, cx);
                }
                emit.send(
                    Msg::PaneOverlay(PaneOverlayMsg::ToggleHistory {
                        tab: tab.clone(),
                        direction,
                    }),
                    window,
                    cx,
                );
            }
        };
        let menu = Rc::new(menu);
        let press: PressHandler = {
            let emit = self.emit.clone();
            let tab = Arc::clone(&self.tab);
            let host = Arc::clone(&self.host);
            let back = self.back.clone();
            let focus = self.focus.clone();
            let state = state.clone();
            let reduce = cx.reduce_motion();
            Rc::new(move |mode, window, cx| {
                if let Some(focus) = focus.clone() {
                    emit.send(focus, window, cx);
                }
                if !reduce {
                    state.update(cx, |s, _| s.handoff = Some(Instant::now()));
                }
                if matches!(mode, OpenMode::Current | OpenMode::Split) {
                    let msgs = match direction {
                        HistoryDirection::Back => back.clone(),
                        HistoryDirection::Forward => vec![Msg::Forward(tab.id.clone())],
                    };
                    for msg in msgs {
                        emit.send(msg, window, cx);
                    }
                } else {
                    open_history(&host, &tab, direction, mode);
                }
                window.refresh();
            })
        };
        frame(self.id, &self.place, &self.ink, enabled)
            .debug_selector(move || self_selector(direction))
            .when(enabled, |this| {
                let press_down = state.clone();
                let long_menu = Rc::clone(&menu);
                let click_state = state.clone();
                let click = Rc::clone(&press);
                let middle = Rc::clone(&press);
                let right_menu = Rc::clone(&menu);
                this.on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    let token = press_down.update(cx, |s, _| {
                        s.pressed += 1;
                        s.long_fired = false;
                        s.pressed
                    });
                    let watch = press_down.clone();
                    let fire = Rc::clone(&long_menu);
                    window
                        .spawn(cx, async move |cx| {
                            cx.background_executor().timer(LONG_PRESS).await;
                            let _ = cx.update(|window, cx| {
                                let still = watch.read(cx).pressed == token;
                                if still {
                                    watch.update(cx, |s, _| s.long_fired = true);
                                    fire(window, cx);
                                }
                            });
                        })
                        .detach();
                })
                .on_mouse_up(MouseButton::Left, {
                    let up = state.clone();
                    move |_, _, cx| {
                        up.update(cx, |s, _| s.pressed += 1);
                    }
                })
                .on_mouse_up_out(MouseButton::Left, {
                    let up = state.clone();
                    move |_, _, cx| {
                        up.update(cx, |s, _| s.pressed += 1);
                    }
                })
                .on_click(move |event: &ClickEvent, window, cx| {
                    cx.stop_propagation();
                    if click_state.read(cx).long_fired {
                        click_state.update(cx, |s, _| s.long_fired = false);
                        return;
                    }
                    let m = event.modifiers();
                    click(open_mode_for(m.platform, m.shift, m.alt, false), window, cx);
                })
                .on_mouse_down(MouseButton::Middle, move |event, window, cx| {
                    cx.stop_propagation();
                    let m = event.modifiers;
                    middle(open_mode_for(m.platform, m.shift, m.alt, true), window, cx);
                })
                .on_mouse_down(MouseButton::Right, move |_, window, cx| {
                    cx.stop_propagation();
                    right_menu(window, cx);
                })
            })
            .when(!enabled, |this| {
                this.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            })
            .tooltip(tooltip(tip, &self.p))
            .children(face)
    }
}

fn self_selector(direction: HistoryDirection) -> String {
    match direction {
        HistoryDirection::Back => "toolbar-back".into(),
        HistoryDirection::Forward => "toolbar-forward".into(),
    }
}

#[derive(Clone, Copy)]
struct ReloadState {
    loading: bool,
    changed: Option<Instant>,
}

#[derive(IntoElement)]
pub struct ReloadButton {
    pub tab: Option<Arc<Tab>>,
    pub loading: bool,
    pub place: NavPlace,
    pub ink: ToolbarInk,
    pub hint: Option<String>,
    pub p: Palette,
    pub emit: Emit,
    pub window: WindowId,
    pub focus: Option<Msg>,
}

pub fn reload_click(tab: &Tab, loading: bool, platform: bool, shift: bool) -> Msg {
    if loading {
        return Msg::Stop(tab.id.clone());
    }
    if platform {
        return Msg::Store(Action::NewTab {
            window: tab.window_id.clone(),
            tab: NewTab {
                url: Some(tab.url.clone()),
                profile: Some(tab.profile_id.clone()),
                opener: Some(tab.id.clone()),
                background: true,
                ..NewTab::default()
            },
        });
    }
    Msg::Reload {
        tab: tab.id.clone(),
        hard: shift,
    }
}

pub fn reload_tip(loading: bool, hint: Option<String>) -> SharedString {
    if loading {
        SharedString::new_static("Stop Loading This Page")
    } else {
        crate::content::find_bar::with_shortcut("Refresh", hint)
    }
}

impl RenderOnce for ReloadButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = Instant::now();
        let reduce = cx.reduce_motion();
        let loading = self.loading;
        let state = window.use_keyed_state(
            SharedString::from(format!("toolbar-reload:{}", self.window)),
            cx,
            |_, _| ReloadState {
                loading,
                changed: None,
            },
        );
        let since = state.update(cx, |s, _| {
            if s.loading != loading {
                s.loading = loading;
                s.changed = (!reduce).then_some(now);
            }
            s.changed.map(|at| now.saturating_duration_since(at))
        });
        let window_motion = if loading { STATE_IN } else { STATE_OUT };
        let morphing = since.is_some_and(|t| t < window_motion);
        if morphing {
            window.request_animation_frame();
        }
        let (reload, stop) = reload_poses(loading, since);
        let enabled = self.tab.as_ref().is_some_and(|tab| !tab.url.is_empty());
        let color = if enabled {
            self.ink.icon
        } else {
            self.ink.icon_disabled
        };
        let tip = reload_tip(loading, self.hint.clone());
        frame("toolbar-reload", &self.place, &self.ink, enabled)
            .debug_selector(|| "toolbar-reload".into())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .when_some(self.tab.clone().filter(|_| enabled), |this, tab| {
                let emit = self.emit.clone();
                let focus = self.focus.clone();
                let menu_emit = self.emit.clone();
                let menu_focus = self.focus.clone();
                let menu_tab = tab.id.clone();
                let web = crate::content::toolbar_menus::site_origin(&tab.url).is_some();
                this.on_click(move |event: &ClickEvent, window, cx| {
                    cx.stop_propagation();
                    if let Some(focus) = focus.clone() {
                        emit.send(focus, window, cx);
                    }
                    let m = event.modifiers();
                    emit.send(reload_click(&tab, loading, m.platform, m.shift), window, cx);
                })
                .on_mouse_down(MouseButton::Right, move |event, window, cx| {
                    cx.stop_propagation();
                    if let Some(focus) = menu_focus.clone() {
                        menu_emit.send(focus, window, cx);
                    }
                    if web {
                        menu_emit.send(
                            Msg::Menu(Some((
                                crate::msg::MenuTarget::Reload(menu_tab.clone()),
                                event.position,
                            ))),
                            window,
                            cx,
                        );
                    }
                })
            })
            .tooltip(tooltip(tip, &self.p))
            .when(reload.opacity > 0.0, |this| {
                this.child(glyph(Icon::Reload, toolbar::GLYPH, color, reload))
            })
            .when(stop.opacity > 0.0, |this| {
                if reduce {
                    this.child(glyph(Icon::XMark, toolbar::GLYPH, color, stop))
                } else {
                    this.child(breathing_stop(toolbar::GLYPH, color, stop))
                }
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::{ProfileId, TabId};

    fn tab(id: &str) -> Tab {
        Tab::new(
            TabId::new(id),
            WindowId::new("w"),
            ProfileId::default_profile(),
            "https://a.test/",
            0,
        )
    }

    #[test]
    fn mac_navigation_is_semibold_and_stop_stays_medium() {
        use crate::icon_picker::symbols::SymbolWeight;
        for glyph in [Icon::ChevronLeft, Icon::ChevronRight, Icon::Reload] {
            assert_eq!(navigation_weight(glyph), SymbolWeight::Semibold);
        }
        assert_eq!(navigation_weight(Icon::XMark), SymbolWeight::Medium);
    }

    #[test]
    fn the_reload_glyph_turns_into_a_stop_and_spins_back() {
        let (reload, stop) = reload_poses(true, None);
        assert_eq!((reload.opacity, stop.opacity, stop.scale), (0.0, 1.0, 1.0));
        let (reload, stop) = reload_poses(true, Some(Duration::ZERO));
        assert_eq!((reload.opacity, stop.opacity), (1.0, 0.0));
        assert!((stop.scale - HIDDEN_SCALE).abs() < 1e-6);
        let (reload, _) = reload_poses(false, Some(Duration::ZERO));
        assert!((reload.rotation - RETURN_ROTATION).abs() < 1e-4);
        assert!((reload.scale - HIDDEN_SCALE).abs() < 1e-4);
        let (reload, stop) = reload_poses(false, Some(STATE_OUT));
        assert_eq!(
            (reload.opacity, reload.rotation, stop.opacity),
            (1.0, 0.0, 0.0)
        );
        assert!(breathe_level(Duration::ZERO).abs() < 1e-6);
        assert!((breathe_level(BREATHE_CYCLE / 2) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn history_handoff_slides_the_old_glyph_out_and_the_new_one_in() {
        let (out, inn) = handoff_poses(-1, Duration::ZERO);
        assert_eq!((out.opacity, out.x, inn.opacity), (1.0, 0.0, 0.0));
        assert!((inn.x - HANDOFF_TRAVEL).abs() < 1e-6);
        let (out, inn) = handoff_poses(-1, HANDOFF);
        assert!((out.opacity).abs() < 1e-5 && (out.x + HANDOFF_TRAVEL).abs() < 1e-4);
        assert!((inn.opacity - 1.0).abs() < 1e-5 && inn.x.abs() < 1e-4);
    }

    #[test]
    fn leaving_the_new_tab_page_lets_back_return_to_it() {
        let state = BrowserState::default();
        let tab = tab("a");
        let plain = history_with(&state, &tab, false, false);
        assert!(!plain.back && !plain.forward);
        let behind = history_with(&state, &tab, true, false);
        assert!(behind.back && !behind.back_closes);
        let shown = history_with(&state, &tab, true, true);
        assert!(!shown.back && shown.forward);
        assert_eq!(
            back_msgs(&state, &tab, true),
            vec![Msg::Back(tab.id.clone())]
        );
    }

    #[test]
    fn reload_modifiers_follow_the_legacy_rules() {
        let tab = tab("a");
        assert_eq!(
            reload_click(&tab, true, true, true),
            Msg::Stop(tab.id.clone())
        );
        assert_eq!(
            reload_click(&tab, false, false, true),
            Msg::Reload {
                tab: tab.id.clone(),
                hard: true
            }
        );
        assert!(matches!(
            reload_click(&tab, false, true, false),
            Msg::Store(Action::NewTab {
                tab: NewTab {
                    background: true,
                    ..
                },
                ..
            })
        ));
        assert_eq!(
            reload_tip(true, Some("⌘R".into())).as_ref(),
            "Stop Loading This Page"
        );
        assert_eq!(
            reload_tip(false, Some("⌘R".into())).as_ref(),
            "Refresh (⌘R)"
        );
    }
}
