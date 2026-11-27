use crate::scale::px;
use ardia_state::windows::{Popover, WindowKind};
use ardia_theme::layout::{lights, sidebar};
use gpui::{
    AnyElement, App, Element, ElementId, FontWeight, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, MouseButton, ParentElement, Pixels, SharedString, Styled, TextRun,
    Window, div, prelude::*,
};

use crate::content::find_bar::with_shortcut;
use crate::keybindings::hint;
use crate::msg::{MenuTarget, Msg};
use crate::primitives::controls::{IconButton, progress_ring, tooltip};
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;

pub const INDICATOR_X: f32 = 84.0;
pub const INDICATOR_HEIGHT: f32 = 34.0;
pub const NAME_LIFT: f32 = 1.5;
pub const INDICATOR_PAD: f32 = 9.0;
pub const INDICATOR_ICON_WIDTH: f32 = 32.0;
pub const INDICATOR_RADIUS: f32 = 10.0;
pub const INDICATOR_FONT: f32 = 13.0;
pub const HEADER_RIGHT: f32 = 8.0;
pub const DOWNLOADS_SIZE: f32 = 34.0;
pub const DOWNLOADS_GLYPH: f32 = 16.0;
pub const DOWNLOADS_RADIUS: f32 = 10.0;
pub const DOWNLOADS_GAP: f32 = 2.0;
pub const FOOTER_BAND_BOTTOM: f32 = 3.0;
pub const TOOLS_PITCH: f32 = 35.0;
pub const TOOLS_PLATE: f32 = 32.0;
pub const TOOLS_BUTTON: f32 = 30.0;
pub const TOOLS_GLYPH: f32 = 15.0;
pub const TOOLS_EDGE: f32 = sidebar::INSET + 1.0;
pub const TOOLS_TOGGLE_X: f32 = 70.75 + 27.0;
pub const FULL_SCREEN_TOGGLE_X: f32 = 29.0;

pub fn toggle_x(window_full_screen: bool) -> f32 {
    if window_full_screen {
        FULL_SCREEN_TOGGLE_X
    } else {
        TOOLS_TOGGLE_X
    }
}
pub const TOOLS_RADIUS: f32 = 10.0;

pub fn footer_downloads_inset() -> f32 {
    FOOTER_BAND_BOTTOM + (sidebar::FOOTER_HEIGHT - FOOTER_BAND_BOTTOM - DOWNLOADS_SIZE) / 2.0
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum IndicatorShape {
    Hidden,
    Name(f32),
    Icon,
}

pub fn indicator_shape(room: f32, text_width: f32, wanted: bool) -> IndicatorShape {
    if !wanted || room < INDICATOR_ICON_WIDTH {
        return IndicatorShape::Hidden;
    }
    let name_room = room - 2.0 * INDICATOR_PAD;
    if text_width <= name_room || name_room >= sidebar::PROFILE_NAME_MIN_TRUNCATED {
        IndicatorShape::Name((text_width + 2.0 * INDICATOR_PAD).min(room))
    } else {
        IndicatorShape::Icon
    }
}

pub fn indicator_room(sidebar_width: f32, downloads_in_header: bool) -> f32 {
    sidebar_width
        - INDICATOR_X
        - HEADER_RIGHT
        - if downloads_in_header {
            DOWNLOADS_SIZE + DOWNLOADS_GAP
        } else {
            0.0
        }
}

pub fn downloads_in_footer(c: &Chrome) -> bool {
    c.layout.sidebar_shows_address()
}

pub fn minimal_parts_hidden(c: &Chrome) -> bool {
    crate::sidebar::row_look::quiet(c)
}

pub fn has_downloads(c: &Chrome) -> bool {
    !minimal_parts_hidden(c)
        && !crate::pages::downloads::shown_downloads(c.state, &c.window.id)
            .items
            .is_empty()
}

fn lights_y(c: &Chrome) -> f32 {
    if c.layout.sidebar_shows_address() {
        lights::ARC_CENTER[1]
    } else {
        lights::center(c.layout.frame.inset, c.state.settings.compact_toolbar)[1]
    }
}

pub fn window_drag(this: gpui::Div) -> gpui::Div {
    this.on_mouse_down(MouseButton::Left, |event, window, _| {
        if event.click_count >= 2 {
            window.titlebar_double_click();
        } else {
            window.start_window_move();
        }
    })
}

struct ByFit {
    text: SharedString,
    room: f32,
    wanted: bool,
    name: Option<AnyElement>,
    glyph: Option<AnyElement>,
}

impl Element for ByFit {
    type RequestLayoutState = Option<AnyElement>;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut font = window.text_style().font();
        font.weight = FontWeight::SEMIBOLD;
        let run = TextRun {
            len: self.text.len(),
            font,
            color: gpui::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let measured = window
            .text_system()
            .shape_line(
                self.text.clone(),
                px(INDICATOR_FONT),
                std::slice::from_ref(&run),
                None,
            )
            .width;
        let width = crate::scale::points(measured).ceil();
        let mut chosen = match indicator_shape(self.room, width, self.wanted) {
            IndicatorShape::Hidden => None,
            IndicatorShape::Name(_) => self.name.take(),
            IndicatorShape::Icon => self.glyph.take(),
        };
        match chosen.as_mut() {
            Some(element) => (element.request_layout(window, cx), chosen),
            None => (window.request_layout(gpui::Style::default(), [], cx), None),
        }
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: gpui::Bounds<Pixels>,
        chosen: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        if let Some(element) = chosen.as_mut() {
            element.prepaint(window, cx);
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: gpui::Bounds<Pixels>,
        chosen: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(element) = chosen.as_mut() {
            element.paint(window, cx);
        }
    }
}

fn indicator_plate(c: &Chrome, id: &'static str, incognito: bool) -> gpui::Stateful<gpui::Div> {
    let p = *c.p;
    let emit = c.emit.clone();
    div()
        .id(id)
        .flex_none()
        .h(px(INDICATOR_HEIGHT))
        .rounded(px(INDICATOR_RADIUS))
        .flex()
        .items_center()
        .justify_center()
        .when(!incognito, |this| {
            this.hover(move |style| style.bg(p.tab_hover))
                .active(move |style| style.bg(p.tab_pressed))
                .tooltip(tooltip("Switch between profiles".into(), c.p))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(MouseButton::Right, {
                    let emit = c.emit.clone();
                    let profile = c.window.profile_id.clone();
                    move |event, window, cx| {
                        cx.stop_propagation();
                        emit.send(
                            Msg::Menu(Some((
                                MenuTarget::ProfileItem(profile.clone()),
                                event.position,
                            ))),
                            window,
                            cx,
                        );
                    }
                })
                .on_click(move |event, window, cx| {
                    emit.send(
                        Msg::Menu(Some((MenuTarget::Profile, event.position()))),
                        window,
                        cx,
                    );
                })
        })
}

pub fn profile_indicator(c: &Chrome, room: f32) -> AnyElement {
    let p = *c.p;
    let incognito = c.window.kind == WindowKind::Incognito;
    let wanted = incognito || c.state.profile_order.len() >= 2;
    let name = if incognito {
        SharedString::new_static("Incognito")
    } else {
        SharedString::from(
            c.state
                .profile(c.window.profile_id.as_str())
                .map_or_else(String::new, |profile| profile.name.clone()),
        )
    };
    let color = if incognito { p.text } else { p.profile_name };
    let named = indicator_plate(c, "profile-indicator", incognito)
        .debug_selector(|| "profile-indicator".into())
        .max_w(px(room.max(0.0)))
        .px(px(INDICATOR_PAD))
        .child(
            div()
                .min_w_0()
                .truncate()
                .mb(px(NAME_LIFT * 2.0))
                .text_size(px(INDICATOR_FONT))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(color)
                .child(name.clone()),
        )
        .into_any_element();
    let glyph = indicator_plate(c, "profile-indicator-icon", incognito)
        .w(px(INDICATOR_ICON_WIDTH))
        .child(icon(Icon::Person, 14., color))
        .into_any_element();
    ByFit {
        text: name,
        room,
        wanted,
        name: Some(named),
        glyph: Some(glyph),
    }
    .into_any_element()
}

pub fn downloads_button(c: &Chrome) -> AnyElement {
    let p = *c.p;
    let progress = c.state.downloads.active_progress();
    let open = c.window.chrome.downloads_open
        || matches!(c.window.chrome.popover, Some(Popover::Downloads));
    let tip = with_shortcut("Downloads", hint(c.state, "downloads"));
    div()
        .id("downloads-button")
        .debug_selector(|| "downloads-button".into())
        .flex_none()
        .relative()
        .size(px(DOWNLOADS_SIZE))
        .rounded(px(DOWNLOADS_RADIUS))
        .flex()
        .items_center()
        .justify_center()
        .when(open, |this| this.bg(p.toolbar_pressed))
        .hover(move |style| style.bg(p.toolbar_hover))
        .active(move |style| style.bg(p.toolbar_pressed))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click({
            let emit = c.emit.clone();
            move |_, window, cx| {
                ardia_telemetry::counts::count(if open {
                    "downloads_panel_closes_button"
                } else {
                    "downloads_panel_opens_button"
                });
                emit.send(Msg::command("downloads"), window, cx);
            }
        })
        .on_mouse_down(MouseButton::Right, {
            let emit = c.emit.clone();
            move |event, window, cx| {
                cx.stop_propagation();
                emit.send(
                    Msg::Menu(Some((MenuTarget::DownloadsButton, event.position))),
                    window,
                    cx,
                );
            }
        })
        .when(
            !open && !matches!(c.ui.menu, Some((MenuTarget::DownloadsButton, _))),
            |this| this.tooltip(tooltip(tip, c.p)),
        )
        .child(icon(
            Icon::ArrowDownCircle,
            DOWNLOADS_GLYPH,
            p.downloads_tint,
        ))
        .when_some(progress, |this, fraction| {
            this.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(progress_ring(
                        19.,
                        fraction as f32,
                        p.downloads_tint.opacity(0.2),
                        p.form_accent,
                    )),
            )
        })
        .into_any_element()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeaderButton {
    Back,
    Forward,
    Reload,
}

pub fn nav_buttons_fitting(width: f32, toggle: bool, toggle_x: f32) -> (Vec<HeaderButton>, f32) {
    let span = width
        - TOOLS_EDGE
        - TOOLS_BUTTON / 2.0
        - if toggle {
            toggle_x
        } else {
            toggle_x - TOOLS_PITCH
        };
    let count = (span / TOOLS_BUTTON).floor().clamp(0.0, 3.0) as usize;
    let all = [
        HeaderButton::Back,
        HeaderButton::Forward,
        HeaderButton::Reload,
    ];
    let step = if count > 0 {
        TOOLS_PITCH.min(span / count as f32)
    } else {
        TOOLS_PITCH
    };
    (all[..count].to_vec(), step)
}

fn header_tools(c: &Chrome) -> Vec<AnyElement> {
    let p = c.p;
    let width = c.layout.sidebar_width;
    let minimal = minimal_parts_hidden(c);
    let toggle = c.state.settings.show_sidebar_button && !minimal;
    let right = c.layout.trailing;
    let tab = c.active.map(|t| t.id.clone());
    let at = toggle_x(c.window.is_full_screen());
    let (buttons, step) = nav_buttons_fitting(width, toggle, at);
    let shown: Vec<HeaderButton> = if tab.is_some() && !minimal {
        buttons
    } else {
        Vec::new()
    };
    let last = width - TOOLS_EDGE - TOOLS_BUTTON / 2.0;
    let count = shown.len();
    let plate = TOOLS_PLATE.min(step);
    let y = lights::ARC_CENTER[1];
    let place = move |center: f32, element: IconButton| {
        div()
            .absolute()
            .left(px(center - plate / 2.0 - sidebar::INSET))
            .top(px(y - plate / 2.0))
            .child(element.square(plate, TOOLS_RADIUS).glyph(TOOLS_GLYPH))
            .into_any_element()
    };
    let mut out = Vec::new();
    if toggle {
        out.push(place(
            at,
            IconButton::new(
                "arc-sidebar-toggle",
                if right {
                    Icon::SidebarRight
                } else {
                    Icon::SidebarLeft
                },
                p,
            )
            .tooltip(
                with_shortcut("Hide Tabs", hint(c.state, "toggleSidebar")),
                p,
            )
            .on_click(c.emit.click(Msg::command("toggleSidebar"))),
        ));
    }
    let loading = c.active.is_some_and(|t| t.live.loading);
    let back = c.active.is_some_and(|t| t.live.can_go_back);
    let forward = c.active.is_some_and(|t| t.live.can_go_forward);
    for (index, button) in shown.into_iter().enumerate() {
        let center = last - (count - 1 - index) as f32 * step;
        let Some(tab) = tab.clone() else {
            continue;
        };
        let element = match button {
            HeaderButton::Back => IconButton::new("arc-back", Icon::ChevronLeft, p)
                .disabled(!back)
                .tooltip(with_shortcut("Back", hint(c.state, "back")), p)
                .on_click(c.emit.click(Msg::Back(tab))),
            HeaderButton::Forward => IconButton::new("arc-forward", Icon::ChevronRight, p)
                .disabled(!forward)
                .tooltip(with_shortcut("Forward", hint(c.state, "forward")), p)
                .on_click(c.emit.click(Msg::Forward(tab))),
            HeaderButton::Reload if loading => IconButton::new("arc-stop", Icon::XMark, p)
                .tooltip(with_shortcut("Stop", hint(c.state, "stop")), p)
                .on_click(c.emit.click(Msg::Stop(tab))),
            HeaderButton::Reload => IconButton::new("arc-reload", Icon::Reload, p)
                .tooltip(with_shortcut("Reload", hint(c.state, "reload")), p)
                .on_click(c.emit.click(Msg::Reload { tab, hard: false })),
        };
        out.push(place(center, element));
    }
    out
}

pub fn header(c: &Chrome) -> AnyElement {
    let arc = c.layout.sidebar_shows_address();
    let downloads_here = has_downloads(c) && !downloads_in_footer(c);
    let base = window_drag(div())
        .id("sidebar-header")
        .flex_none()
        .relative()
        .h(px(c.layout.header))
        .on_mouse_down(MouseButton::Right, {
            let emit = c.emit.clone();
            move |event, window, cx| {
                emit.send(
                    Msg::Menu(Some((MenuTarget::NewTab, event.position))),
                    window,
                    cx,
                )
            }
        });
    if arc {
        return base.children(header_tools(c)).into_any_element();
    }
    let room = indicator_room(c.layout.sidebar_width, downloads_here);
    base.pl(px(INDICATOR_X - sidebar::INSET))
        .pr(px(HEADER_RIGHT - sidebar::INSET))
        .pt(px(lights_y(c) - INDICATOR_HEIGHT / 2.0))
        .flex()
        .items_start()
        .child(profile_indicator(c, room))
        .child(div().flex_1())
        .when(downloads_here, |this| this.child(downloads_button(c)))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_indicator_shows_the_whole_name_when_it_fits() {
        assert_eq!(
            indicator_shape(120.0, 60.0, true),
            IndicatorShape::Name(78.0)
        );
    }

    #[test]
    fn the_indicator_cuts_a_name_only_when_52_points_of_it_fit() {
        assert_eq!(
            indicator_shape(70.0, 200.0, true),
            IndicatorShape::Name(70.0)
        );
        assert_eq!(indicator_shape(69.0, 200.0, true), IndicatorShape::Icon);
        assert_eq!(
            indicator_shape(40.0, 20.0, true),
            IndicatorShape::Name(38.0)
        );
    }

    #[test]
    fn the_indicator_hides_without_room_or_a_second_profile() {
        assert_eq!(indicator_shape(31.0, 10.0, true), IndicatorShape::Hidden);
        assert_eq!(indicator_shape(300.0, 10.0, false), IndicatorShape::Hidden);
    }

    #[test]
    fn the_indicator_room_leaves_space_for_downloads_in_the_header() {
        assert_eq!(indicator_room(240.0, false), 148.0);
        assert_eq!(indicator_room(240.0, true), 112.0);
    }

    #[test]
    fn footer_downloads_sit_centred_on_the_band() {
        assert_eq!(footer_downloads_inset(), 5.0);
    }

    #[test]
    fn header_tools_fit_three_buttons_in_a_wide_sidebar() {
        let (buttons, step) = nav_buttons_fitting(240.0, true, TOOLS_TOGGLE_X);
        assert_eq!(buttons.len(), 3);
        assert_eq!(step, 35.0);
        let (narrow, _) = nav_buttons_fitting(160.0, true, TOOLS_TOGGLE_X);
        assert_eq!(narrow, vec![HeaderButton::Back]);
        let (without_toggle, _) = nav_buttons_fitting(160.0, false, TOOLS_TOGGLE_X);
        assert_eq!(without_toggle.len(), 2);
    }

    #[test]
    fn the_sidebar_toggle_moves_into_the_lights_gap_in_full_screen() {
        assert_eq!(toggle_x(false), 97.75);
        assert_eq!(toggle_x(true), 29.0);
        let (full, _) = nav_buttons_fitting(160.0, true, toggle_x(true));
        assert_eq!(full.len(), 3);
    }
}
