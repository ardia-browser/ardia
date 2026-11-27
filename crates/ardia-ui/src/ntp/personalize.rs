use crate::scale::px;
use ardia_state::model::{SidebarSide, TabLayout};
use ardia_state::settings::SettingsPatch;
use ardia_state::{Action, ProfileId, ProfilePatch, WindowId};
use ardia_theme::ProfileColor;
use gpui::{
    AnyElement, App, ElementId, Hsla, IntoElement, MouseButton, ParentElement, RenderOnce,
    SharedString, Styled, Window, div, prelude::*, rgba,
};

use crate::look::Palette;
use crate::msg::{Emit, Msg};
use crate::primitives::controls::{Segmented, shadow, tooltip};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::window::chrome::Chrome;

pub const INSET: f32 = 16.0;
pub const BUTTON: f32 = 30.0;
pub const GLYPH: f32 = 14.0;
pub const GLYPH_DROP: f32 = 1.5;
pub const PANEL_WIDTH: f32 = 432.0;
pub const PANEL_PRIORITY: usize = 3;
pub const PANEL_RADIUS: f32 = 16.0;
pub const PANEL_GAP_ABOVE_BUTTON: f32 = 8.0;
pub const PANEL_PAD: f32 = 16.0;
pub const SWATCH: f32 = 28.0;
pub const SWATCH_GAP: f32 = 4.0;
pub const SWATCH_RING: f32 = 2.0;
pub const SWATCH_INSET: f32 = 2.0;
pub const LAYOUT_PREVIEW: f32 = 64.0;
pub const OFF_OPACITY: f32 = 0.4;
pub const TITLE: &str = "Make it yours";
pub const SUBTITLE: &str = "Pick the theme color and layout that feel right for you.";
pub const LAYOUTS: &str = "Choose how you would like to view your tabs:";
pub const SIDE: &str = "Sidebar on the";

#[derive(Default)]
struct PersonalizeUi {
    open: bool,
    selected: usize,
}

#[derive(Clone, Copy)]
struct OnboardingInk {
    title: Hsla,
    subtitle: Hsla,
    tile: Hsla,
    tile_lit: Hsla,
    tile_border: Hsla,
    tile_border_selected: Hsla,
    preview: Hsla,
    preview_border: Hsla,
    track: Hsla,
}

fn onboarding_ink(dark: bool) -> OnboardingInk {
    let c = |value: u32| Hsla::from(rgba(value));
    if dark {
        OnboardingInk {
            title: c(0xFFFFFFFF),
            subtitle: c(0xFFFFFF99),
            tile: c(0xFFFFFF0F),
            tile_lit: c(0xFFFFFF1A),
            tile_border: c(0xFFFFFF12),
            tile_border_selected: c(0xFFFFFF57),
            preview: c(0xFFFFFF0A),
            preview_border: c(0xFFFFFF1A),
            track: c(0xFFFFFF1F),
        }
    } else {
        OnboardingInk {
            title: c(0x000000FF),
            subtitle: c(0x00000099),
            tile: c(0xFFFFFFE6),
            tile_lit: c(0x00000009),
            tile_border: c(0x0000000F),
            tile_border_selected: c(0x0000004D),
            preview: c(0x00000006),
            preview_border: c(0x00000012),
            track: c(0x00000014),
        }
    }
}

#[derive(IntoElement)]
pub struct PersonalizeCorner {
    window: WindowId,
    profile: Option<ProfileId>,
    chosen: Option<ProfileColor>,
    stored: Option<ardia_theme::ProfileTheme>,
    swatch: ardia_theme::RgbaColor,
    host: std::sync::Arc<dyn crate::host::UiHost>,
    layout: TabLayout,
    side: SidebarSide,
    dark: bool,
    p: Palette,
    emit: Emit,
}

impl PersonalizeCorner {
    pub fn new(c: &Chrome) -> Self {
        let profile = c.window.profile_id.clone();
        let shown = c.state.profile(profile.as_str());
        let stored = shown.and_then(|p| p.theme.as_deref().cloned());
        let swatch = shown.map_or(c.look.theme.roles.accent, |p| {
            p.color.preset().spec().swatch
        });
        let chosen = c
            .state
            .profile(profile.as_str())
            .map(|shown| shown.color.preset());
        PersonalizeCorner {
            window: c.window.id.clone(),
            profile: c.state.profile(profile.as_str()).map(|_| profile),
            chosen,
            stored,
            swatch,
            host: std::sync::Arc::clone(c.host),
            layout: c.state.tab_layout(c.window.id.as_str()),
            side: c.state.settings.sidebar_side,
            dark: c.look.dark,
            p: *c.p,
            emit: c.emit.clone(),
        }
    }
}

fn swatch(
    color: ProfileColor,
    selected: bool,
    profile: Option<ProfileId>,
    emit: &Emit,
    p: &Palette,
) -> AnyElement {
    let fill = hsla(color.spec().swatch);
    let emit = emit.clone();
    div()
        .id(SharedString::from(format!(
            "personalize-color:{}",
            color.key()
        )))
        .debug_selector(move || format!("personalize-color:{}", color.key()))
        .flex_none()
        .size(px(SWATCH))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .tooltip(tooltip(color.spec().name.into(), p))
        .active(|style| style.opacity(0.9))
        .when(selected, |this| {
            this.border(px(SWATCH_RING)).border_color(fill).child(
                div()
                    .size(px(SWATCH - 2.0 * (SWATCH_RING + SWATCH_INSET)))
                    .rounded_full()
                    .bg(fill),
            )
        })
        .when(!selected, |this| this.bg(fill))
        .on_click(move |_, window, cx| {
            if let Some(profile) = profile.clone() {
                emit.send(
                    Msg::Store(Action::UpdateProfile {
                        profile,
                        patch: ProfilePatch {
                            color: Some(color),
                            theme: Some(None),
                            ..ProfilePatch::default()
                        },
                    }),
                    window,
                    cx,
                );
            }
        })
        .into_any_element()
}

fn mini_window(kind: TabLayout, side: SidebarSide, ink: OnboardingInk) -> AnyElement {
    let bars = [1.0_f32, 0.8, 0.9];
    let rail = div()
        .flex_none()
        .w(px(30.))
        .h_full()
        .p(px(5.))
        .flex()
        .flex_col()
        .gap(px(4.))
        .children(bars.map(|share| {
            div()
                .h(px(4.))
                .w(gpui::relative(share))
                .rounded(px(2.))
                .bg(ink.track)
        }));
    let strip = div()
        .flex_none()
        .h(px(12.))
        .w_full()
        .px(px(5.))
        .flex()
        .items_center()
        .gap(px(4.))
        .children(bars.map(|share| {
            div()
                .h(px(4.))
                .w(px(24. * share))
                .rounded(px(2.))
                .bg(ink.track)
        }));
    let page = div()
        .flex_1()
        .m(px(4.))
        .rounded(px(3.))
        .border(px(0.5))
        .border_color(ink.preview_border)
        .bg(ink.preview);
    let body = match (kind, side) {
        (TabLayout::Top, _) => div().size_full().flex().flex_col().child(strip).child(page),
        (TabLayout::Sidebar, SidebarSide::Right) => {
            div().size_full().flex().child(page).child(rail)
        }
        (TabLayout::Sidebar, _) => div().size_full().flex().child(rail).child(page),
    };
    div()
        .h(px(LAYOUT_PREVIEW))
        .rounded(px(8.))
        .overflow_hidden()
        .border(px(1.))
        .border_color(ink.preview_border)
        .bg(ink.preview)
        .child(body)
        .into_any_element()
}

fn radio(on: bool, p: &Palette, ink: OnboardingInk) -> AnyElement {
    div()
        .flex_none()
        .size(px(16.))
        .rounded_full()
        .border(px(if on { 5. } else { 1. }))
        .border_color(if on {
            p.accent
        } else {
            ink.tile_border_selected
        })
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn layout_card(
    id: &'static str,
    kind: TabLayout,
    side: SidebarSide,
    title: &'static str,
    subtitle: &'static str,
    selected: bool,
    window: WindowId,
    emit: &Emit,
    p: &Palette,
    ink: OnboardingInk,
) -> AnyElement {
    let emit = emit.clone();
    let lit = ink.tile_lit;
    div()
        .id(id)
        .debug_selector(move || id.into())
        .flex_1()
        .p(px(10.))
        .gap(px(10.))
        .flex()
        .flex_col()
        .rounded(px(12.))
        .border(px(1.))
        .border_color(if selected {
            ink.tile_border_selected
        } else {
            ink.tile_border
        })
        .bg(if selected { lit } else { ink.tile })
        .hover(move |style| style.bg(lit))
        .cursor_pointer()
        .on_click(move |_, w, cx| {
            if !selected {
                emit.send(
                    Msg::Store(Action::SetTabLayout {
                        window: Some(window.clone()),
                        layout: kind,
                    }),
                    w,
                    cx,
                );
            }
        })
        .child(mini_window(kind, side, ink))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(radio(selected, p, ink))
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(12.))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .text_color(ink.title)
                                .child(title),
                        )
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(ink.subtitle)
                                .child(subtitle),
                        ),
                ),
        )
        .into_any_element()
}

fn write_theme(
    emit: &Emit,
    profile: &Option<ProfileId>,
    theme: Option<ardia_theme::ProfileTheme>,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(profile) = profile.clone() else {
        return;
    };
    emit.send(
        Msg::Store(Action::UpdateProfile {
            profile,
            patch: ProfilePatch {
                theme: Some(theme.map(std::sync::Arc::new)),
                ..ProfilePatch::default()
            },
        }),
        window,
        cx,
    );
}

fn theme_editor(
    corner: &PersonalizeCorner,
    selected: usize,
    ui: gpui::Entity<PersonalizeUi>,
) -> AnyElement {
    use crate::theme_editor::{
        ThemeEditor, preset_starting_theme, texture_menu_items, with_texture,
    };
    use std::rc::Rc;
    let theme = corner
        .stored
        .clone()
        .unwrap_or_else(|| preset_starting_theme(corner.swatch));
    let change_emit = corner.emit.clone();
    let change_profile = corner.profile.clone();
    let reset_emit = corner.emit.clone();
    let reset_profile = corner.profile.clone();
    let menu_emit = corner.emit.clone();
    let menu_profile = corner.profile.clone();
    let menu_theme = theme.clone();
    let host = std::sync::Arc::clone(&corner.host);
    ThemeEditor {
        id: SharedString::from(format!("personalize-theme:{}", corner.window.as_str())),
        theme: theme.clone(),
        start: Some(theme),
        selected,
        stacked: true,
        native_form: false,
        p: corner.p,
        on_change: Rc::new(move |next, _, window, cx| {
            write_theme(&change_emit, &change_profile, Some(next), window, cx)
        }),
        on_select: Rc::new(move |index, _, cx| {
            ui.update(cx, |ui, cx| {
                ui.selected = index;
                cx.notify();
            })
        }),
        on_reset: corner
            .stored
            .is_some()
            .then(|| -> crate::theme_editor::Action {
                Rc::new(move |window, cx| {
                    write_theme(&reset_emit, &reset_profile, None, window, cx)
                })
            }),
        on_texture_menu: Rc::new(move |window, cx| {
            let Some(reply) = host.show_menu(texture_menu_items(menu_theme.look.texture)) else {
                return;
            };
            let emit = menu_emit.clone();
            let profile = menu_profile.clone();
            let theme = menu_theme.clone();
            window
                .spawn(cx, async move |cx| {
                    if let Ok(Some(id)) = reply.await
                        && let Some(texture) = ardia_theme::ThemeTexture::from_key(&id)
                    {
                        let next = with_texture(&theme, texture);
                        let _ = cx.update(|window, cx| {
                            write_theme(&emit, &profile, Some(next), window, cx)
                        });
                    }
                })
                .detach();
        }),
    }
    .render()
}

fn panel(
    corner: &PersonalizeCorner,
    selected: usize,
    ui: gpui::Entity<PersonalizeUi>,
    close: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let p = &corner.p;
    let ink = onboarding_ink(corner.dark);
    let side_on = corner.layout == TabLayout::Sidebar;
    let side_emit = corner.emit.clone();
    let catcher = div()
        .id("personalize-catcher")
        .absolute()
        .inset_0()
        .occlude()
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            cx.stop_propagation();
            close(window, cx);
        });
    let sheet = div()
        .id("personalize-panel")
        .debug_selector(|| "personalize-panel".into())
        .absolute()
        .right(px(INSET))
        .bottom(px(INSET + BUTTON + PANEL_GAP_ABOVE_BUTTON))
        .w(px(PANEL_WIDTH))
        .rounded(px(PANEL_RADIUS))
        .bg(p.popover_fill)
        .border(px(0.5))
        .border_color(p.popover_border)
        .shadow(vec![shadow(gpui::black().opacity(0.3), 10., 24.)])
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .p(px(PANEL_PAD))
        .flex()
        .flex_col()
        .gap(px(PANEL_PAD))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(
                    div()
                        .text_size(px(15.))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(p.text)
                        .child(TITLE),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .line_height(px(17.))
                        .text_color(p.text_secondary)
                        .child(SUBTITLE),
                ),
        )
        .child(div().flex().flex_wrap().gap(px(SWATCH_GAP)).children(
            ProfileColor::ALL.into_iter().map(|color| {
                swatch(
                    color,
                    corner.chosen == Some(color),
                    corner.profile.clone(),
                    &corner.emit,
                    p,
                )
            }),
        ))
        .child(theme_editor(corner, selected, ui))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(p.text_secondary)
                        .child(LAYOUTS),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .child(
                            div()
                                .flex()
                                .gap(px(10.))
                                .child(layout_card(
                                    "personalize-layout-sidebar",
                                    TabLayout::Sidebar,
                                    corner.side,
                                    "Sidebar",
                                    "Tabs down the side",
                                    side_on,
                                    corner.window.clone(),
                                    &corner.emit,
                                    p,
                                    ink,
                                ))
                                .child(layout_card(
                                    "personalize-layout-top",
                                    TabLayout::Top,
                                    SidebarSide::Left,
                                    "Classic",
                                    "Tabs along the top",
                                    !side_on,
                                    corner.window.clone(),
                                    &corner.emit,
                                    p,
                                    ink,
                                )),
                        )
                        .child(
                            div()
                                .px(px(4.))
                                .flex()
                                .items_center()
                                .justify_between()
                                .when(!side_on, |this| this.opacity(OFF_OPACITY))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(p.text_secondary)
                                        .child(SIDE),
                                )
                                .child(
                                    Segmented::new(
                                        "personalize-side",
                                        usize::from(corner.side == SidebarSide::Right),
                                        p,
                                    )
                                    .option("Left", None)
                                    .option("Right", None)
                                    .on_select(
                                        move |index, window, cx| {
                                            if !side_on {
                                                return;
                                            }
                                            let side = if index == 1 { "right" } else { "left" };
                                            side_emit.send(
                                                Msg::Store(Action::UpdateSettings {
                                                    patch: SettingsPatch::new()
                                                        .set("sidebarSide", side),
                                                    from_sync: false,
                                                }),
                                                window,
                                                cx,
                                            );
                                        },
                                    ),
                                ),
                        ),
                ),
        );
    div()
        .absolute()
        .inset_0()
        .child(catcher)
        .child(sheet)
        .into_any_element()
}

impl RenderOnce for PersonalizeCorner {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state(
            ElementId::Name(SharedString::from(format!(
                "personalize:{}",
                self.window.as_str()
            ))),
            cx,
            |_, _| PersonalizeUi::default(),
        );
        let open = state.read(cx).open;
        let selected = state.read(cx).selected;
        let editor_ui = state.clone();
        let p = self.p;
        let toggle = state.clone();
        let close = state;
        let glyph = if open { p.icon } else { p.text_tertiary };
        let hover = p.toolbar_hover;
        let pressed = p.toolbar_pressed;
        div()
            .absolute()
            .inset_0()
            .when(open, |this| {
                this.child(
                    gpui::deferred(panel(&self, selected, editor_ui, move |_, cx| {
                        close.update(cx, |open, cx| {
                            open.open = false;
                            cx.notify();
                        })
                    }))
                    .with_priority(PANEL_PRIORITY),
                )
            })
            .child(
                div()
                    .id("ntp-customize")
                    .debug_selector(|| "ntp-customize".into())
                    .absolute()
                    .right(px(INSET))
                    .bottom(px(INSET - GLYPH_DROP))
                    .size(px(BUTTON))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .when(open, |this| this.bg(hover))
                    .hover(move |style| style.bg(hover))
                    .active(move |style| style.bg(pressed))
                    .tooltip(tooltip("Personalize".into(), &p))
                    .on_click(move |_, _, cx| {
                        toggle.update(cx, |open, cx| {
                            open.open = !open.open;
                            cx.notify();
                        })
                    })
                    .child(icon(Icon::Palette, GLYPH, glyph)),
            )
            .into_any_element()
    }
}
