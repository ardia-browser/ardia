use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use crate::scale::px;
use ardia_state::actions::{Action, GroupPatch};
use ardia_state::tabs::Tab;
use ardia_state::{GroupId, TabId, WindowId};
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, MouseButton, ParentElement, ScrollHandle,
    SharedString, Styled, TextRun, canvas, div, linear_color_stop, linear_gradient, point,
    prelude::*,
};

use crate::msg::{MenuTarget, Msg};
use crate::primitives::controls::{IconButton, tooltip};
use crate::primitives::fade_label::fade_label;
use crate::primitives::favicon::render_favicon;
use crate::primitives::glass::{GlassState, control_glass};
use crate::primitives::glass_states::{
    GLASS_CONTROL_GROUP, GlassBacking, GlassStates, stateful_glass,
};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::sidebar::strip_layout::*;
use crate::sidebar::tab_row::{drag_payload, row_id};
use crate::window::chrome::{Chrome, TabDrag, TabDragGhost, tab_title};
use crate::window::layout::Rect;

pub fn strip_minimum(selected: bool, has_favicon: bool) -> f32 {
    use ardia_theme::layout::tab_strip;
    if selected {
        tab_strip::TAB_MIN_SELECTED
    } else if has_favicon {
        tab_strip::TAB_MIN_WITH_FAVICON
    } else {
        tab_strip::TAB_MIN_SHARED_FAVICON
    }
}

type ScrollMemo = (ScrollHandle, Option<TabId>);

thread_local! {
    static MEASURED: RefCell<HashMap<(String, u32), f32>> = RefCell::new(HashMap::new());
    static SCROLLS: RefCell<HashMap<WindowId, ScrollMemo>> = RefCell::new(HashMap::new());
}

fn measured(text: &str, size: f32) -> Option<f32> {
    MEASURED.with(|m| m.borrow().get(&(text.to_owned(), size.to_bits())).copied())
}

fn measure_probe(texts: Vec<(String, f32)>) -> AnyElement {
    let missing: Vec<(String, f32)> = texts
        .into_iter()
        .filter(|(t, s)| measured(t, *s).is_none())
        .collect();
    if missing.is_empty() {
        return div().into_any_element();
    }
    canvas(
        move |_, window, _| {
            let mut font = window.text_style().font();
            font.weight = FontWeight::SEMIBOLD;
            for (text, size) in &missing {
                let run = TextRun {
                    len: text.len(),
                    font: font.clone(),
                    color: gpui::black(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let width = window
                    .text_system()
                    .shape_line(SharedString::from(text.clone()), px(*size), &[run], None)
                    .width;
                let width = (crate::scale::points(width) * 2.0).ceil() / 2.0;
                MEASURED.with(|m| m.borrow_mut().insert((text.clone(), size.to_bits()), width));
            }
            window.refresh();
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_0()
    .into_any_element()
}

fn group_name(c: &Chrome, id: &GroupId) -> String {
    c.state.group(id.as_str()).map_or_else(String::new, |g| {
        if g.name.is_empty() {
            let n = g.tab_ids.len();
            format!("{n} {}", if n == 1 { "Tab" } else { "Tabs" })
        } else {
            g.name.clone()
        }
    })
}

fn group_tint(c: &Chrome, id: &GroupId) -> (Option<Hsla>, bool) {
    let color = c.state.group(id.as_str()).and_then(|g| g.color);
    let bare = matches!(color, Some(ardia_state::groups::GroupColor::NoColor));
    (
        crate::sidebar::group_list::group_tint(color).map(hsla),
        bare,
    )
}

fn folder_chip_width(c: &Chrome, id: &GroupId) -> f32 {
    let label = measured(&group_name(c, id), 12.0)
        .unwrap_or(0.0)
        .min(FOLDER_TITLE_MAX);
    FOLDER_PAD_LEFT + GROUP_ICON + FOLDER_TITLE_GAP + label + 4.0 + 9.0 + FOLDER_PAD_RIGHT
}

fn site_band(c: &Chrome, tab: &Tab) -> Option<Hsla> {
    let ink = crate::content::toolbar::ink_for(c, Some(tab));
    ink.fill.filter(|_| !c.state.settings.minimalism_mode)
}

fn selected_shape(c: &Chrome, width: f32, band: Option<Hsla>) -> AnyElement {
    let p = c.p;
    if floating() {
        return div()
            .absolute()
            .left_0()
            .top(px(ITEM_TOP))
            .w(px(width))
            .h(px(ITEM_HEIGHT))
            .rounded(px(tab_radius()))
            .border(px(CHIP_HAIRLINE))
            .border_color(if p.dark {
                gpui::white().opacity(0.15)
            } else {
                gpui::black().opacity(0.08)
            })
            .bg(p.card)
            .into_any_element();
    }
    let mut fills = vec![p.card];
    fills.extend(band);
    let body = (width - 1.0).max(0.0);
    let rim = if p.dark {
        gpui::white().opacity(0x3B as f32 / 255.0)
    } else {
        gpui::white().opacity(0xFA as f32 / 255.0)
    };
    let flare = |x: f32, right: bool, color: Hsla| {
        let outer = FLARE * 2.0;
        div()
            .absolute()
            .left(px(x))
            .top(px(STRIP_HEIGHT - FLARE))
            .size(px(FLARE))
            .overflow_hidden()
            .child(
                div()
                    .absolute()
                    .left(px(if right { FLARE - outer } else { -outer }))
                    .top(px(-outer))
                    .size(px(outer * 2.0))
                    .rounded_full()
                    .border(px(FLARE))
                    .border_color(color),
            )
    };
    let rim_top = TAB_TOP - 0.5;
    let side_top = rim_top + tab_radius();
    let side_end = rim_top + RIM_HEIGHT;
    let side_alpha = 1.0 - tab_radius() / RIM_HEIGHT;
    let side = |left: f32| {
        div()
            .absolute()
            .left(px(left))
            .top(px(side_top))
            .w(px(RIM_WIDTH))
            .h(px((side_end - side_top).max(0.0)))
            .bg(linear_gradient(
                180.0,
                linear_color_stop(rim.opacity(side_alpha), 0.0),
                linear_color_stop(rim.opacity(0.0), 1.0),
            ))
    };
    div()
        .absolute()
        .left_0()
        .top_0()
        .w(px(width))
        .h(px(STRIP_HEIGHT))
        .children(fills.into_iter().map(move |fill| {
            div()
                .absolute()
                .inset_0()
                .child(
                    div()
                        .absolute()
                        .left(px(0.5))
                        .top(px(TAB_TOP))
                        .w(px(body))
                        .h(px(STRIP_HEIGHT - TAB_TOP))
                        .rounded_t(px(tab_radius()))
                        .bg(fill),
                )
                .child(flare(0.5 - FLARE, false, fill))
                .child(flare(body + 0.5, true, fill))
        }))
        .child(
            div()
                .absolute()
                .left_0()
                .top(px(rim_top))
                .w(px(width))
                .h(px(tab_radius() + 0.5))
                .overflow_hidden()
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .top_0()
                        .w(px(width))
                        .h(px(RIM_HEIGHT * 2.0))
                        .rounded(px(tab_radius() + 0.5))
                        .border(px(RIM_WIDTH))
                        .border_color(rim),
                ),
        )
        .child(side(0.0))
        .child(side(width - RIM_WIDTH))
        .into_any_element()
}

fn item_row(
    c: &Chrome,
    id: SharedString,
    hoverable: bool,
    inset: Option<f32>,
) -> gpui::Stateful<gpui::Div> {
    let p = *c.p;
    div()
        .id(id)
        .absolute()
        .left_0()
        .right_0()
        .top(px(ITEM_TOP))
        .h(px(ITEM_HEIGHT))
        .flex()
        .items_center()
        .pl(px(inset.unwrap_or(CHIP_PAD_LEFT)))
        .pr(px(inset.unwrap_or(CHIP_PAD_RIGHT)))
        .rounded(px(tab_radius()))
        .when(hoverable, move |this| {
            this.hover(move |s| s.bg(p.tab_hover))
                .active(move |s| s.bg(p.tab_pressed))
        })
}

fn press_handlers(
    c: &Chrome,
    tab: &Tab,
    this: gpui::Stateful<gpui::Div>,
) -> gpui::Stateful<gpui::Div> {
    press_handlers_in(c, tab, this, None)
}

fn press_handlers_in(
    c: &Chrome,
    tab: &Tab,
    this: gpui::Stateful<gpui::Div>,
    dock: Option<(usize, Vec<Vec<TabId>>)>,
) -> gpui::Stateful<gpui::Div> {
    let pick = c.emit.clone();
    let close = c.emit.clone();
    let menu = c.emit.clone();
    let drop_emit = c.emit.clone();
    let id = tab.id.clone();
    let middle = tab.id.clone();
    let menu_id = tab.id.clone();
    let before = tab.id.clone();
    let dock_key = c.window.id.as_str().to_owned();
    let strip_key = c.window.id.as_str().to_owned();
    let card_shown = c.state.settings.show_tab_hover_menu;
    let card_window = c.window.id.as_str().to_owned();
    let card_tab = tab.id.clone();
    let press_window = c.window.id.as_str().to_owned();
    let press_tab = tab.id.clone();
    let card_other_profile = tab.profile_id != c.window.profile_id;
    let split_members: Vec<TabId> = c
        .state
        .split_of(tab.id.as_str())
        .map(|s| s.tab_ids())
        .unwrap_or_default();
    this.child(crate::sidebar::strip_hover::anchor_probe(
        c.window.id.as_str(),
        &tab.id,
    ))
    .on_hover(move |hovered, window, cx| {
        crate::sidebar::strip_hover::chip_hovered(
            &card_window,
            &card_tab,
            crate::sidebar::strip_hover::Chip {
                hovered: *hovered,
                cards_on: card_shown,
                other_profile: card_other_profile,
            },
            window,
            cx,
        )
    })
    .on_mouse_down(MouseButton::Left, move |event, window, cx| {
        cx.stop_propagation();
        crate::sidebar::strip_hover::chip_pressed(&press_window, &press_tab, window, cx);
        if event.modifiers.alt && event.modifiers.shift && !event.modifiers.platform {
            pick.send(Msg::PickTabIntoGroup(id.clone()), window, cx);
            return;
        }
        pick.send(
            Msg::PickTab {
                tab: id.clone(),
                toggle: event.modifiers.platform,
                range: event.modifiers.shift,
            },
            window,
            cx,
        );
    })
    .on_mouse_down(MouseButton::Middle, move |_, window, cx| {
        cx.stop_propagation();
        close.send(Msg::CloseTab(middle.clone()), window, cx);
    })
    .on_mouse_down(MouseButton::Right, move |event, window, cx| {
        cx.stop_propagation();
        menu.send(
            Msg::Menu(Some((MenuTarget::Tab(menu_id.clone()), event.position))),
            window,
            cx,
        );
    })
    .on_drag(drag_payload(c, tab), move |drag, _, window, cx| {
        crate::content::split_view::note_strip_drag(&strip_key, &drag.tab);
        let drag = drag.clone();
        if let Some((index, cells)) = &dock {
            let (x, _) = crate::scale::logical_point(window.mouse_position());
            crate::sidebar::dock_drag::begin(&strip_key, *index, cells.clone(), false, x);
        }
        let inner = cx.new(|_| TabDragGhost::new(drag));
        let window = strip_key.clone();
        cx.new(|_| DockGhost {
            window,
            inner: Some(inner.into()),
        })
    })
    .on_drop(move |drag: &TabDrag, window, cx| {
        if dock_commit(&dock_key, &drop_emit, window, cx) {
            return;
        }
        if !split_members.contains(&drag.tab) {
            drop_emit.send(
                Msg::Store(Action::RemoveFromSplit {
                    tab: drag.tab.clone(),
                }),
                window,
                cx,
            );
        }
        drop_emit.send(
            Msg::DropTab {
                tab: drag.tab.clone(),
                before: Some(before.clone()),
                group: None,
                pin: Some(false),
            },
            window,
            cx,
        );
    })
}

fn tab_chip(c: &Chrome, tab: &Tab, width: f32) -> AnyElement {
    tab_chip_tucked(c, tab, width, None)
}

fn tuck_target(c: &Chrome, group: &GroupId) -> Option<TabId> {
    let members = c.state.group(group.as_str())?.tab_ids.clone();
    c.state
        .view_tabs(c.window.id.as_str(), None)
        .into_iter()
        .filter(|t| !members.contains(&t.id))
        .max_by_key(|t| t.last_active_at)
        .map(|t| t.id.clone())
}

thread_local! {
    static FLOATING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static STILL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn floating() -> bool {
    FLOATING.with(|f| f.get())
}

fn strip_still() -> bool {
    STILL.with(|f| f.get())
}

fn tab_chip_tucked(c: &Chrome, tab: &Tab, width: f32, tuck: Option<TabId>) -> AnyElement {
    let p = *c.p;
    let active = c.is_active(&tab.id);
    let compact = !active && width < TITLE_MIN_CHIP;
    let closable = active || width >= CLOSE_MIN_CHIP;
    let band = if active && !floating() {
        site_band(c, tab)
    } else {
        None
    };
    let site_ink = band.map(|_| crate::content::toolbar::ink_for(c, Some(tab)));
    let ink = match site_ink {
        Some(site) => site.text,
        None if active => p.text_selected,
        None => p.text_tab,
    };
    let group = SharedString::from(format!("strip-chip:{}", tab.id));
    let inset = compact.then(|| (width - FAVICON) / 2.0);
    let mute = ardia_state::mute::mute_state(c.state, tab);
    let sound = tab.live.audible || mute.is_some();
    let close_tip = crate::content::find_bar::with_shortcut(
        "Close Tab",
        active
            .then(|| crate::keybindings::hint(c.state, "closeTab"))
            .flatten(),
    );
    let renaming = c.renaming_tab(&tab.id);
    let row = item_row(
        c,
        SharedString::from(format!("strip-row:{}", tab.id)),
        !active,
        inset,
    )
    .group(group.clone())
    .child(
        div()
            .flex_none()
            .relative()
            .child(crate::media::tab_badges::with_badges(
                c,
                tab,
                FAVICON,
                render_favicon(&c.favicon(tab), FAVICON, c.p),
            ))
            .when(compact && sound, |this| {
                this.child(
                    div()
                        .absolute()
                        .right(px(-AUDIO_BADGE / 2.0 + 2.0))
                        .bottom(px(-AUDIO_BADGE / 2.0 + 2.0))
                        .size(px(AUDIO_BADGE))
                        .rounded_full()
                        .bg(hsla(c.look.theme.window_tint[0]))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            crate::primitives::icons::symbol_icon(
                                if mute.is_some() {
                                    "speaker.slash.fill"
                                } else {
                                    "speaker.wave.2.fill"
                                },
                                if mute.is_some() {
                                    Icon::SpeakerSlash
                                } else {
                                    Icon::Speaker
                                },
                                7.,
                                p.text_tab,
                            )
                            .fit_within(AUDIO_BADGE - 2.0, AUDIO_BADGE - 2.0),
                        ),
                )
            }),
    )
    .when(!compact && sound, |this| {
        let muted = mute.is_some();
        this.child(
            div().ml(px(CHIP_LABEL_GAP)).child(
                IconButton::new(
                    row_id("strip-mute", tab.id.as_str()),
                    if muted {
                        Icon::SpeakerSlash
                    } else {
                        Icon::Speaker
                    },
                    c.p,
                )
                .square(16., 4.)
                .glyph(11.)
                .color(site_ink.map_or(p.text_tab, |s| s.icon))
                .fills(gpui::transparent_black(), gpui::transparent_black())
                .tooltip(ardia_state::mute::mute_title(mute), c.p)
                .on_click(
                    c.emit
                        .click(Msg::Stores(ardia_state::mute::toggle_mute(c.state, tab))),
                ),
            ),
        )
    })
    .when(renaming, |this| {
        this.child(
            div()
                .flex_1()
                .min_w(px(60.))
                .ml(px(CHIP_LABEL_GAP))
                .debug_selector(|| "rename-input".into())
                .child(c.rename_input.clone()),
        )
    })
    .when(!compact && !renaming, |this| {
        this.child(
            div()
                .flex_1()
                .min_w_0()
                .ml(px(CHIP_LABEL_GAP))
                .child(fade_label(tab_title(tab), ink, 12.)),
        )
    })
    .when(closable && !compact, |this| {
        this.child(
            div()
                .absolute()
                .right(px(CHIP_PAD_RIGHT))
                .top(px((ITEM_HEIGHT - CLOSE_BOX) / 2.0))
                .opacity(0.)
                .group_hover(group.clone(), |s| s.opacity(1.))
                .child(
                    IconButton::new(
                        row_id("strip-close", tab.id.as_str()),
                        if tuck.is_some() {
                            Icon::Minus
                        } else {
                            Icon::XMark
                        },
                        c.p,
                    )
                    .glyph(CLOSE_GLYPH)
                    .square(CLOSE_BOX, tab_close_radius())
                    .centres_ink()
                    .color(site_ink.map_or(p.icon, |s| s.icon))
                    .tooltip(
                        if tuck.is_some() {
                            SharedString::new_static("Hide in Group")
                        } else {
                            close_tip
                        },
                        c.p,
                    )
                    .on_click(c.emit.click(match tuck.clone() {
                        Some(target) => Msg::Store(Action::ActivateTab { tab: target }),
                        None => Msg::CloseTab(tab.id.clone()),
                    })),
                ),
        )
    });
    let row = press_handlers(c, tab, row);
    div()
        .id(row_id("strip", tab.id.as_str()))
        .debug_selector({
            let id = tab.id.clone();
            move || format!("strip-tab:{id}")
        })
        .flex_none()
        .relative()
        .w(px(width))
        .h(px(STRIP_HEIGHT))
        .when(active, |this| this.child(selected_shape(c, width, band)))
        .child(row)
        .into_any_element()
}

fn split_chip(c: &Chrome, tabs: &[TabId], width: f32) -> AnyElement {
    let p = *c.p;
    let focused = tabs.iter().find(|t| c.is_active(t)).cloned();
    let active = focused.is_some();
    let first = tabs.first().cloned().unwrap_or_else(|| TabId::new(""));
    let band_tab = focused.as_ref().unwrap_or(&first);
    let shown = c.state.tab(band_tab.as_str());
    let band = if active {
        shown.and_then(|t| site_band(c, t))
    } else {
        None
    };
    let site = band.and(shown.map(|t| crate::content::toolbar::ink_for(c, Some(t))));
    let vertical = c
        .state
        .split_of(first.as_str())
        .is_some_and(|s| s.orientation == ardia_state::model::Orientation::Vertical);
    let count = tabs.len().min(2);
    let parts: Vec<AnyElement> = tabs
        .iter()
        .take(2)
        .enumerate()
        .filter_map(|(i, id)| {
            let tab = c.state.tab(id.as_str())?;
            let is_focused = c.is_active(id);
            let color = match site {
                Some(s) if is_focused => s.text,
                Some(s) => s.secondary,
                None if is_focused => p.text_selected,
                None => p.text_tab,
            };
            let part = div()
                .id(row_id("strip-split-part", id.as_str()))
                .flex_1()
                .min_w_0()
                .h_full()
                .flex()
                .items_center()
                .when(i == 0, |this| this.pl(px(CHIP_PAD_LEFT)))
                .when(i + 1 == count, |this| this.pr(px(CHIP_PAD_RIGHT)))
                .when(i == 0, |this| {
                    this.child(div().flex_none().w(px(14.)).mr(px(4.)).child(icon(
                        if vertical {
                            Icon::SplitVertical
                        } else {
                            Icon::Split
                        },
                        11.,
                        site.map_or(p.text_secondary, |s| s.secondary),
                    )))
                })
                .when(i > 0, |this| {
                    this.child(
                        div()
                            .flex_none()
                            .mx(px(6.))
                            .w(px(0.5))
                            .h(px(16.))
                            .bg(site.map_or(p.text_tertiary, |s| s.divider)),
                    )
                })
                .child(
                    div()
                        .flex_none()
                        .child(render_favicon(&c.favicon(tab), FAVICON, c.p)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .ml(px(CHIP_LABEL_GAP))
                        .child(fade_label(tab_title(tab), color, 12.)),
                );
            Some(press_handlers(c, tab, part).into_any_element())
        })
        .collect();
    div()
        .id(SharedString::from(format!("strip-split:{first}")))
        .flex_none()
        .relative()
        .w(px(width))
        .h(px(STRIP_HEIGHT))
        .when(active, |this| this.child(selected_shape(c, width, band)))
        .child(
            item_row(
                c,
                SharedString::from(format!("strip-split-row:{first}")),
                !active,
                Some(0.0),
            )
            .children(parts),
        )
        .into_any_element()
}

fn folder_member(c: &Chrome, id: &GroupId, tabs: &[TabId], tab_width: f32) -> AnyElement {
    let p = *c.p;
    let (tint, bare) = group_tint(c, id);
    let holding = tabs.iter().find(|t| c.is_active(t)).cloned();
    let label = group_name(c, id);
    let ink = if holding.is_some() {
        p.text
    } else {
        p.text_tab
    };
    let rest = tint.map_or(
        if bare {
            gpui::transparent_black()
        } else {
            p.pinned_resting
        },
        |t| t.opacity(0.22),
    );
    let hover = tint.map_or(p.tab_hover, |t| t.opacity(0.3));
    let menu_emit = c.emit.clone();
    let menu_group = id.clone();
    let face = div()
        .id(SharedString::from(format!("strip-folder:{id}")))
        .absolute()
        .left_0()
        .top(px(MID - FOLDER_HEIGHT / 2.0))
        .h(px(FOLDER_HEIGHT))
        .pl(px(FOLDER_PAD_LEFT))
        .pr(px(FOLDER_PAD_RIGHT))
        .flex()
        .items_center()
        .rounded(px(8.))
        .border(px(CHIP_HAIRLINE))
        .border_color(if bare {
            gpui::transparent_black()
        } else {
            p.pinned_resting_stroke
        })
        .bg(rest)
        .hover(move |s| s.bg(hover))
        .active(move |s| s.bg(p.tab_pressed))
        .tooltip(tooltip(format!("{label}\nShow Folder").into(), c.p))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |event, window, cx| {
            menu_emit.send(
                Msg::Menu(Some((
                    MenuTarget::Group(menu_group.clone()),
                    event.position(),
                ))),
                window,
                cx,
            )
        })
        .child(icon(Icon::Folder, GROUP_ICON, tint.unwrap_or(p.icon)))
        .child(
            div()
                .ml(px(FOLDER_TITLE_GAP))
                .max_w(px(FOLDER_TITLE_MAX))
                .truncate()
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(ink)
                .child(SharedString::from(label)),
        )
        .child(
            div()
                .ml(px(4.))
                .child(icon(Icon::ChevronDown, 8., ink.alpha(0.6))),
        );
    let chip = folder_chip_width(c, id);
    let held = holding.and_then(|t| c.state.tab(t.as_str()).cloned());
    div()
        .flex_none()
        .relative()
        .w(px(
            chip + held.as_ref().map_or(0.0, |_| MEMBERS_INSET + tab_width)
        ))
        .h(px(STRIP_HEIGHT))
        .child(face)
        .when_some(held, |this, tab| {
            this.child(
                div()
                    .absolute()
                    .left(px(chip + MEMBERS_INSET))
                    .top_0()
                    .child(tab_chip(c, &tab, tab_width)),
            )
        })
        .into_any_element()
}

struct StripCtx<'a> {
    active: TabId,
    widths: TabWidths,
    needs: &'a dyn Fn(&TabId) -> bool,
}

impl StripCtx<'_> {
    fn width_of(&self, tab: &TabId) -> f32 {
        if *tab == self.active {
            self.widths.selected
        } else if (self.needs)(tab) {
            self.widths.titled
        } else {
            self.widths.chip
        }
    }
}

fn member(c: &Chrome, m: &Member, ctx: &StripCtx) -> Option<AnyElement> {
    match m {
        Member::Tab(id) => {
            let tab = c.state.tab(id.as_str())?;
            Some(tab_chip(c, tab, ctx.width_of(id)))
        }
        Member::Split { tabs, .. } => {
            let width: f32 = tabs.iter().take(2).map(|t| ctx.width_of(t)).sum();
            Some(split_chip(c, tabs, width))
        }
        Member::Folder { id, tabs } => Some(folder_member(c, id, tabs, ctx.width_of(&ctx.active))),
    }
}

fn group_close(c: &Chrome, id: &GroupId) -> Option<(&'static str, &'static str, Msg)> {
    let root =
        ardia_state::groups::root(&c.state.groups, id.as_str()).unwrap_or_else(|| id.clone());
    let pinned = c.state.group(root.as_str()).is_some_and(|g| g.pinned);
    if !pinned {
        return Some((
            "xmark.square",
            "Close Group",
            Msg::Store(Action::CloseGroup { group: id.clone() }),
        ));
    }
    let open: Vec<TabId> = c
        .state
        .group(id.as_str())
        .map(|g| {
            g.tab_ids
                .iter()
                .filter(|t| c.state.tab(t.as_str()).is_some_and(|t| t.page.has_page()))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    (!open.is_empty()).then(|| {
        (
            "minus.square",
            "Unload Tabs",
            Msg::Store(Action::SleepTabs { tabs: open }),
        )
    })
}

struct GroupView<'a> {
    id: &'a GroupId,
    collapsed: bool,
    members: &'a [Member],
    chip: f32,
}

fn strip_group(c: &Chrome, g: GroupView, ctx: &StripCtx, measures: &Measures) -> AnyElement {
    let p = *c.p;
    let id = g.id;
    let chip = g.chip;
    let members = g.members;
    let (tint, bare) = group_tint(c, id);
    let expanded = !g.collapsed;
    let shown = members.iter().position(|m| m.holds(&ctx.active));
    let widths: Vec<f32> = members
        .iter()
        .map(|m| member_width(m, ctx.widths, &ctx.active, measures))
        .collect();
    let layout = group_layout(chip, &widths, expanded, shown);
    let now = std::time::Instant::now();
    let (open, width) = crate::sidebar::strip_motion::with(&c.window.id, |m| {
        m.group(
            &format!("group:{id}"),
            expanded,
            layout.width,
            now,
            strip_still(),
        )
    });
    let moving = (open - if expanded { 1.0 } else { 0.0 }).abs() > 1e-3
        || (width - layout.width).abs() > 0.25;
    let tuck = (!expanded).then(|| tuck_target(c, id)).flatten();
    let rest = tint.map_or(
        if bare {
            gpui::transparent_black()
        } else {
            p.pinned_resting
        },
        |t| t.opacity(GROUP_TRAY_ALPHA),
    );
    let hover = tint.map_or(
        Hsla {
            a: (p.pinned_resting.a + 0.02).min(1.0),
            ..p.pinned_resting
        },
        |t| t.opacity(GROUP_TRAY_HOVER_ALPHA),
    );
    let divider = if p.dark {
        gpui::white().opacity(0.16)
    } else {
        gpui::black().opacity(0.12)
    };
    let fill_group = SharedString::from(format!("strip-group-chip:{id}"));
    let name = group_name(c, id);
    let natural = measured(&name, 12.0);
    let name_width = natural.map_or(0.0, |n| n.min(GROUP_TITLE_MAX) + GROUP_NAME_INSET * 2.0);
    let toggle_emit = c.emit.clone();
    let toggle_id = id.clone();
    let menu_emit = c.emit.clone();
    let menu_id = id.clone();
    let open_offsets = group_layout(chip, &widths, true, shown).offsets;
    let shown_members: Vec<AnyElement> = members
        .iter()
        .enumerate()
        .filter(|(i, _)| open > 0.0 || Some(*i) == shown)
        .filter_map(|(i, m)| {
            let offset = open_offsets.get(i).copied().unwrap_or(0.0);
            let left = if Some(i) == shown {
                chip + MEMBERS_INSET + offset * open
            } else {
                chip + MEMBERS_INSET + offset
            };
            let el = match (m, tuck.as_ref()) {
                (Member::Tab(tab), Some(target)) if !expanded && Some(i) == shown => c
                    .state
                    .tab(tab.as_str())
                    .map(|t| tab_chip_tucked(c, t, ctx.width_of(tab), Some(target.clone()))),
                _ => member(c, m, ctx),
            }?;
            Some(
                div()
                    .absolute()
                    .top_0()
                    .left(px(left))
                    .child(el)
                    .into_any_element(),
            )
        })
        .collect();
    div()
        .flex_none()
        .relative()
        .ml(px(GROUP_MARGIN_LEFT))
        .mr(px(GROUP_MARGIN_RIGHT))
        .w(px(width))
        .h(px(STRIP_HEIGHT))
        .when(moving, |this| this.overflow_hidden())
        .child(
            div()
                .absolute()
                .left_0()
                .top(px(ITEM_TOP))
                .w(px(width))
                .h(px(ITEM_HEIGHT))
                .rounded(px(tab_radius()))
                .border(px(CHIP_HAIRLINE))
                .border_color(if bare {
                    gpui::transparent_black()
                } else {
                    p.pinned_resting_stroke
                })
                .bg(rest)
                .group_hover(fill_group.clone(), move |s| s.bg(hover)),
        )
        .when(open > 0.0 && !members.is_empty(), |this| {
            this.child(
                div()
                    .absolute()
                    .opacity(open)
                    .left(px(chip + 0.75))
                    .top(px(MID - 7.5))
                    .w(px(0.5))
                    .h(px(15.))
                    .bg(divider),
            )
            .child(
                div()
                    .absolute()
                    .opacity(open)
                    .left(px(width - TAIL_EXPANDED + 2.25))
                    .top(px(ITEM_TOP))
                    .h(px(ITEM_HEIGHT))
                    .flex()
                    .items_center()
                    .child(div().w(px(0.5)).h(px(GROUP_DIVIDER_LENGTH)).bg(divider))
                    .when_some(group_close(c, id), |this, (symbol, tip, msg)| {
                        let (hover, pressed) = (p.tab_hover, p.tab_pressed);
                        this.child(
                            div()
                                .id(SharedString::from(format!("strip-group-close:{id}")))
                                .size(px(24.))
                                .rounded(px(6.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .hover(move |s| s.bg(hover))
                                .active(move |s| s.bg(pressed))
                                .tooltip(tooltip(tip.into(), c.p))
                                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                .on_click(c.emit.click(msg))
                                .child(
                                    crate::primitives::icons::symbol_icon(
                                        symbol,
                                        Icon::XMark,
                                        9.,
                                        p.icon,
                                    )
                                    .weight(crate::icon_picker::symbols::SymbolWeight::Semibold),
                                ),
                        )
                    }),
            )
        })
        .children(shown_members)
        .child(
            div()
                .id(SharedString::from(format!("strip-group:{id}")))
                .group(fill_group)
                .absolute()
                .left_0()
                .top(px(ITEM_TOP))
                .w(px(chip))
                .h(px(ITEM_HEIGHT))
                .pl(px(GROUP_CHIP_PAD_LEFT))
                .pr(px(GROUP_CHIP_PAD_RIGHT))
                .flex()
                .items_center()
                .tooltip(tooltip(
                    if expanded {
                        "Collapse Group"
                    } else {
                        "Expand Group"
                    }
                    .into(),
                    c.p,
                ))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(move |_, window, cx| {
                    toggle_emit.send(
                        Msg::Store(Action::UpdateGroup {
                            group: toggle_id.clone(),
                            patch: GroupPatch {
                                collapsed: Some(expanded),
                                ..GroupPatch::default()
                            },
                        }),
                        window,
                        cx,
                    )
                })
                .on_mouse_down(MouseButton::Right, move |event, window, cx| {
                    cx.stop_propagation();
                    menu_emit.send(
                        Msg::Menu(Some((MenuTarget::Group(menu_id.clone()), event.position))),
                        window,
                        cx,
                    )
                })
                .child(icon(Icon::Folder, GROUP_ICON, tint.unwrap_or(p.icon)))
                .child(
                    div()
                        .ml(px(GROUP_TITLE_GAP - GROUP_NAME_INSET))
                        .w(px(name_width))
                        .px(px(GROUP_NAME_INSET))
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(if shown.is_some() { p.text } else { p.text_tab })
                        .truncate()
                        .child(SharedString::from(name)),
                ),
        )
        .into_any_element()
}

pub const PINNED_RING_STROKE: f32 = 2.0;

pub fn strip_ring_width(setting: ardia_state::settings::SelectedTopApp) -> f32 {
    match setting {
        ardia_state::settings::SelectedTopApp::Fill => 0.0,
        _ => PINNED_RING_STROKE,
    }
}

fn strip_glass_ring(c: &Chrome, tab: &Tab, outline: bool) -> Vec<AnyElement> {
    use crate::sidebar::pinned_grid::{
        glass_ring, glass_selection, icon_theme, selected_tile_look, sized_glass_hue, top_app_look,
    };
    let setting = c.state.settings.shown_selected_top_app();
    let theme = icon_theme(c, tab);
    let look = glass_ring(
        glass_selection(top_app_look(selected_tile_look(theme, c), setting, c.p)),
        theme,
    );
    let radius = pinned_face_radius();
    let width = PINNED_CELL - PINNED_FACE_INSET * 2.0;
    let height = ITEM_HEIGHT - 1.0 - PINNED_FACE_INSET * 2.0;
    let stroke = strip_ring_width(setting);
    let mut out = Vec::new();
    if !outline {
        out.push(sized_glass_hue(theme, width, height, radius, c.p.dark));
    }
    if let Some((color, _)) = look.ring.filter(|_| stroke > 0.0) {
        out.push(
            div()
                .absolute()
                .inset_0()
                .rounded(px(radius))
                .border(px(stroke))
                .border_color(color)
                .into_any_element(),
        );
    }
    out
}

pub fn dock_face_glass(active: bool, outline: bool) -> GlassStates {
    match (active, outline) {
        (true, false) => GlassStates {
            rest: Some(GlassState::Active),
            lit: GlassState::Active,
            pressed: Some(GlassState::Pressed),
        },
        (true, true) => GlassStates::TILE,
        (false, _) => GlassStates::ROW,
    }
}

pub const DOCK_LETTER_SIZE: f32 = 12.0;

fn dock_face_glyph(c: &Chrome, tab: &Tab, active: bool) -> AnyElement {
    if !crate::sidebar::tile_letters::shows_tile_letters(c.state, tab) {
        return render_favicon(&c.favicon(tab), FAVICON, c.p);
    }
    let tokens = crate::sidebar::row_look::tokens_of(c);
    let alpha = if active {
        tokens.quiet_active_text
    } else {
        tokens.quiet_text
    };
    let id = tab.id.clone();
    div()
        .debug_selector(move || format!("strip-pin-letters:{id}"))
        .text_size(px(DOCK_LETTER_SIZE))
        .font_weight(FontWeight::MEDIUM)
        .text_color(c.p.text_tab.opacity(alpha))
        .child(crate::sidebar::tile_letters::tile_letters_of(tab))
        .into_any_element()
}

fn dock_face_unread(c: &Chrome, tab: &Tab) -> Option<AnyElement> {
    if !c.state.settings.show_top_app_badges {
        return None;
    }
    let id = tab.id.clone();
    ardia_state::unread::tab_unread(&c.state.settings, tab).map(|unread| {
        div()
            .debug_selector(move || format!("strip-pin-unread:{id}"))
            .absolute()
            .inset_0()
            .child(crate::primitives::unread::tile_unread(&unread, c.p.dark))
            .into_any_element()
    })
}

fn pinned_dock(c: &Chrome, ids: &[TabId]) -> AnyElement {
    let p = *c.p;
    let glass = c.look.glass;
    let outline =
        c.state.settings.shown_selected_top_app() == ardia_state::settings::SelectedTopApp::Outline;
    let width = dock_width(ids.len());
    let all_cells = dock_cells(c, ids);
    div()
        .flex_none()
        .mt(px(ITEM_TOP))
        .mr(px(DOCK_GAP - GAP))
        .w(px(width))
        .h(px(ITEM_HEIGHT))
        .rounded(px(tab_radius()))
        .map(|this| {
            if glass {
                this.relative()
                    .child(control_glass(c.look, tab_radius(), GlassState::Rest))
            } else {
                this.bg(p.pinned_resting)
                    .border(px(CHIP_HAIRLINE))
                    .border_color(p.pinned_resting_stroke)
            }
        })
        .flex()
        .items_center()
        .gap(px(PINNED_SPACING))
        .on_drag_move(dock_moved::<TabDrag>(c))
        .on_drag_move(dock_moved::<FolderCellDrag>(c))
        .on_drop({
            let window = c.window.id.as_str().to_owned();
            let emit = c.emit.clone();
            move |_: &TabDrag, w, cx| {
                dock_commit(&window, &emit, w, cx);
            }
        })
        .on_drop({
            let window = c.window.id.as_str().to_owned();
            let emit = c.emit.clone();
            move |_: &FolderCellDrag, w, cx| {
                dock_commit(&window, &emit, w, cx);
            }
        })
        .when(
            crate::sidebar::dock_drag::moving(c.window.id.as_str(), std::time::Instant::now()),
            |this| this.child(crate::sidebar::tab_row::frame_pump()),
        )
        .children(ids.iter().enumerate().filter_map(|(index, id)| {
            let tab = c.state.tab(id.as_str())?;
            let (offset, lifted, _) = crate::sidebar::dock_drag::cell_offset(
                c.window.id.as_str(),
                index,
                id,
                std::time::Instant::now(),
            );
            let cells = all_cells.clone();
            if let Some(ardia_state::model::TabPin::Tile {
                folder: Some(folder),
            }) = &tab.pin
            {
                return Some(dock_slot(
                    dock_folder_cell(c, folder, index, cells),
                    offset,
                    lifted,
                ));
            }
            let active = c.is_active(id);
            let face = div()
                .id(row_id("strip-pin", id.as_str()))
                .debug_selector({
                    let id = id.clone();
                    move || format!("strip-pin:{id}")
                })
                .absolute()
                .left(px(PINNED_FACE_INSET))
                .top(px(PINNED_FACE_INSET))
                .w(px(PINNED_CELL - PINNED_FACE_INSET * 2.0))
                .h(px(ITEM_HEIGHT - 1.0 - PINNED_FACE_INSET * 2.0))
                .rounded(px(pinned_face_radius()))
                .flex()
                .items_center()
                .justify_center()
                .when(glass, |this| {
                    this.group(GLASS_CONTROL_GROUP).child(stateful_glass(
                        c.look,
                        pinned_face_radius(),
                        dock_face_glass(active, outline),
                        GlassBacking::Native,
                    ))
                })
                .when(glass && active, |this| {
                    this.children(strip_glass_ring(c, tab, outline))
                })
                .when(!glass && active, |this| this.bg(p.pinned_selected_fill))
                .when(!glass && !active, |this| {
                    this.hover(move |s| s.bg(p.tab_hover))
                        .active(move |s| s.bg(p.tab_pressed))
                })
                .child(crate::media::tab_badges::with_badges(
                    c,
                    tab,
                    FAVICON,
                    dock_face_glyph(c, tab, active),
                ));
            let face =
                press_handlers_in(c, tab, face, Some((index, cells))).on_drop(folder_cell_drop(c));
            Some(dock_slot(
                div()
                    .flex_none()
                    .relative()
                    .w(px(PINNED_CELL))
                    .h(px(ITEM_HEIGHT - 1.0))
                    .child(face)
                    .children(dock_face_unread(c, tab))
                    .into_any_element(),
                offset,
                lifted,
            ))
        }))
        .into_any_element()
}

fn dock_cells(c: &Chrome, ids: &[TabId]) -> Vec<Vec<TabId>> {
    ids.iter()
        .map(
            |id| match c.state.tab(id.as_str()).and_then(|t| t.pin.as_ref()) {
                Some(ardia_state::model::TabPin::Tile {
                    folder: Some(folder),
                }) => folder_members(c, &folder.id)
                    .iter()
                    .map(|t| t.id.clone())
                    .collect(),
                _ => vec![id.clone()],
            },
        )
        .collect()
}

fn dock_slot(cell: AnyElement, offset: f32, lifted: bool) -> AnyElement {
    div()
        .flex_none()
        .relative()
        .left(px(offset))
        .when(lifted, |this| this.opacity(0.))
        .child(cell)
        .into_any_element()
}

fn dock_moved<T: 'static>(
    c: &Chrome,
) -> impl Fn(&gpui::DragMoveEvent<T>, &mut gpui::Window, &mut gpui::App) + 'static {
    let window = c.window.id.as_str().to_owned();
    move |event, w, _| {
        let (x, y) = crate::scale::logical_point(event.event.position);
        if crate::sidebar::dock_drag::moved(&window, x, y, std::time::Instant::now()) {
            w.refresh();
        }
    }
}

pub fn dock_commit(
    window: &str,
    emit: &crate::msg::Emit,
    w: &mut gpui::Window,
    cx: &mut gpui::App,
) -> bool {
    if !crate::sidebar::dock_drag::active(window) {
        return false;
    }
    let Some((moving, before)) =
        crate::sidebar::dock_drag::release(window, std::time::Instant::now())
    else {
        return false;
    };
    let msgs: Vec<Msg> = match before {
        Some(before) => folder_cell_moves(&moving, &before),
        None => moving
            .iter()
            .map(|tab| Msg::DropTab {
                tab: tab.clone(),
                before: None,
                group: None,
                pin: Some(true),
            })
            .collect(),
    };
    for msg in msgs {
        emit.send(msg, w, cx);
    }
    w.refresh();
    true
}

pub struct DockGhost {
    window: String,
    inner: Option<gpui::AnyView>,
}

impl Render for DockGhost {
    fn render(
        &mut self,
        window: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl IntoElement {
        let hidden = crate::sidebar::dock_drag::ghost_hidden(&self.window);
        if crate::sidebar::dock_drag::active(&self.window) {
            window.request_animation_frame();
        }
        div().when(!hidden, |this| this.children(self.inner.clone()))
    }
}

impl Drop for DockGhost {
    fn drop(&mut self) {
        crate::sidebar::dock_drag::cancel(&self.window);
    }
}

pub const STRIP_MOSAIC_CELL: f32 = 7.0;
pub const STRIP_MOSAIC_GAP: f32 = 2.0;
pub const STRIP_MOSAIC_PAD: f32 = 2.0;

pub fn folder_members(c: &Chrome, folder: &str) -> Vec<Arc<Tab>> {
    c.state
        .view_tabs(c.window.id.as_str(), None)
        .into_iter()
        .filter(|t| {
            matches!(&t.pin, Some(ardia_state::model::TabPin::Tile { folder: Some(f) }) if f.id == folder)
        })
        .cloned()
        .collect()
}

fn strip_mosaic(c: &Chrome, members: &[Arc<Tab>]) -> AnyElement {
    let side = STRIP_MOSAIC_PAD * 2.0 + STRIP_MOSAIC_CELL * 2.0 + STRIP_MOSAIC_GAP;
    div()
        .w(px(side))
        .h(px(side))
        .p(px(STRIP_MOSAIC_PAD))
        .flex()
        .flex_wrap()
        .content_center()
        .justify_center()
        .gap(px(STRIP_MOSAIC_GAP))
        .children(members.iter().take(4).map(|tab| {
            div()
                .flex_none()
                .size(px(STRIP_MOSAIC_CELL))
                .child(render_favicon(&c.favicon(tab), STRIP_MOSAIC_CELL, c.p))
        }))
        .into_any_element()
}

#[derive(Clone)]
pub struct FolderCellDrag {
    pub members: Vec<TabId>,
    pub favicons: Vec<crate::primitives::favicon::Favicon>,
    pub p: crate::look::Palette,
}

impl Render for FolderCellDrag {
    fn render(&mut self, _: &mut gpui::Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
        let p = self.p;
        div()
            .w(px(PINNED_CELL - PINNED_FACE_INSET * 2.0))
            .h(px(ITEM_HEIGHT - 1.0 - PINNED_FACE_INSET * 2.0))
            .rounded(px(pinned_face_radius()))
            .bg(p.tab_hover)
            .flex()
            .items_center()
            .justify_center()
            .child(mosaic_of(&self.favicons, &p))
    }
}

pub fn folder_cell_moves(members: &[TabId], before: &TabId) -> Vec<Msg> {
    if members.contains(before) {
        return Vec::new();
    }
    members
        .iter()
        .map(|tab| Msg::DropTab {
            tab: tab.clone(),
            before: Some(before.clone()),
            group: None,
            pin: Some(true),
        })
        .collect()
}

fn folder_cell_drop(
    c: &Chrome,
) -> impl Fn(&FolderCellDrag, &mut gpui::Window, &mut gpui::App) + 'static {
    let emit = c.emit.clone();
    let key = c.window.id.as_str().to_owned();
    move |_, window, cx| {
        dock_commit(&key, &emit, window, cx);
    }
}

fn mosaic_of(
    favicons: &[crate::primitives::favicon::Favicon],
    p: &crate::look::Palette,
) -> AnyElement {
    let side = STRIP_MOSAIC_PAD * 2.0 + STRIP_MOSAIC_CELL * 2.0 + STRIP_MOSAIC_GAP;
    div()
        .w(px(side))
        .h(px(side))
        .p(px(STRIP_MOSAIC_PAD))
        .flex()
        .flex_wrap()
        .content_center()
        .justify_center()
        .gap(px(STRIP_MOSAIC_GAP))
        .children(favicons.iter().take(4).map(|favicon| {
            div()
                .flex_none()
                .size(px(STRIP_MOSAIC_CELL))
                .child(render_favicon(favicon, STRIP_MOSAIC_CELL, p))
        }))
        .into_any_element()
}

fn dock_folder_cell(
    c: &Chrome,
    folder: &ardia_state::model::TileFolder,
    index: usize,
    cells: Vec<Vec<TabId>>,
) -> AnyElement {
    let p = *c.p;
    let drag_payload_cell = FolderCellDrag {
        members: folder_members(c, &folder.id)
            .iter()
            .map(|t| t.id.clone())
            .collect(),
        favicons: folder_members(c, &folder.id)
            .iter()
            .map(|t| c.favicon(t))
            .collect(),
        p,
    };
    let window_key = c.window.id.as_str().to_owned();
    let glass = c.look.glass;
    let members = folder_members(c, &folder.id);
    let label = crate::sidebar::folders::folder_label(folder);
    let group = SharedString::from(format!("strip-dock-folder:{}", folder.id));
    let click_emit = c.emit.clone();
    let menu_emit = c.emit.clone();
    let click_folder = folder.id.clone();
    let menu_folder = folder.id.clone();
    let face = div()
        .id(SharedString::from(format!(
            "strip-dock-folder-face:{}",
            folder.id
        )))
        .debug_selector(|| "strip-dock-folder".into())
        .group(group.clone())
        .absolute()
        .left(px(PINNED_FACE_INSET))
        .top(px(PINNED_FACE_INSET))
        .w(px(PINNED_CELL - PINNED_FACE_INSET * 2.0))
        .h(px(ITEM_HEIGHT - 1.0 - PINNED_FACE_INSET * 2.0))
        .rounded(px(pinned_face_radius()))
        .flex()
        .items_center()
        .justify_center()
        .when(glass, |this| {
            this.child(crate::primitives::glass_states::stateful_glass_in(
                group.clone(),
                c.look,
                pinned_face_radius(),
                GlassStates::ROW,
                GlassBacking::Native,
            ))
        })
        .when(!glass, |this| {
            this.hover(move |s| s.bg(p.tab_hover))
                .active(move |s| s.bg(p.tab_pressed))
        })
        .tooltip(tooltip(format!("{label}\nShow Folder").into(), c.p))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |event, window, cx| {
            click_emit.send(
                Msg::Menu(Some((
                    MenuTarget::TileFolder(click_folder.clone()),
                    event.position(),
                ))),
                window,
                cx,
            );
        })
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            cx.stop_propagation();
            menu_emit.send(
                Msg::Menu(Some((
                    MenuTarget::TileFolderActions(menu_folder.clone()),
                    event.position,
                ))),
                window,
                cx,
            );
        })
        .on_drag(drag_payload_cell, move |_, _, window, cx| {
            let (x, _) = crate::scale::logical_point(window.mouse_position());
            crate::sidebar::dock_drag::begin(&window_key, index, cells.clone(), true, x);
            let window = window_key.clone();
            cx.new(|_| DockGhost {
                window,
                inner: None,
            })
        })
        .on_drop(folder_cell_drop(c))
        .child(div().relative().child(strip_mosaic(c, &members)));
    div()
        .flex_none()
        .relative()
        .w(px(PINNED_CELL))
        .h(px(ITEM_HEIGHT - 1.0))
        .child(face)
        .into_any_element()
}

fn new_tab_buttons(c: &Chrome) -> AnyElement {
    let p = *c.p;
    let hint = crate::keybindings::hint(c.state, "newTab");
    let tip = format!(
        "{} — ⌥-click to open in Split View",
        crate::content::find_bar::with_shortcut("New Tab", hint)
    );
    let open_emit = c.emit.clone();
    let window = c.window.id.clone();
    let menu = |emit: crate::msg::Emit| {
        move |event: &gpui::MouseDownEvent, window: &mut gpui::Window, cx: &mut gpui::App| {
            cx.stop_propagation();
            ardia_telemetry::counts::count("tab_strip_menu_opens");
            emit.send(
                Msg::Menu(Some((MenuTarget::NewTab, event.position))),
                window,
                cx,
            )
        }
    };
    let overflow_emit = c.emit.clone();
    let show_tab_menu_button = c.state.settings.show_tab_menu_button;
    div()
        .id("strip-new-tab-row")
        .flex_none()
        .mt(px(ITEM_TOP))
        .flex()
        .child(
            div()
                .id("strip-new-tab")
                .on_mouse_down(MouseButton::Right, menu(c.emit.clone()))
                .child(
                    IconButton::new("strip-new-tab-button", Icon::Plus, c.p)
                        .square(ITEM_HEIGHT, tab_radius())
                        .glyph(NEW_TAB_ICON)
                        .color(p.text_secondary)
                        .fills(p.tab_hover, p.tab_pressed)
                        .tooltip(tip, c.p)
                        .on_click(move |event, w, cx| {
                            let msg = if event.modifiers().alt {
                                Msg::Store(Action::OpenSplitPane {
                                    window: window.clone(),
                                    side: ardia_state::splits::SplitSide::Right,
                                    url: None,
                                })
                            } else {
                                Msg::command("newTab")
                            };
                            open_emit.send(msg, w, cx);
                        }),
                ),
        )
        .when(show_tab_menu_button, |this| {
            this.child(
                div()
                    .id("strip-overflow")
                    .ml(px(GAP))
                    .h(px(ITEM_HEIGHT))
                    .flex()
                    .items_center()
                    .on_mouse_down(MouseButton::Right, menu(c.emit.clone()))
                    .child(
                        IconButton::new("strip-overflow-button", Icon::ChevronDown, c.p)
                            .square(OVERFLOW_BOX, overflow_radius())
                            .glyph(OVERFLOW_GLYPH)
                            .color(p.text_tertiary)
                            .fills(p.tab_hover, p.tab_pressed)
                            .tooltip("Open and recently closed tabs", c.p)
                            .on_click(move |event, w, cx| {
                                ardia_telemetry::counts::count("tab_strip_overflow_opens");
                                overflow_emit.send(
                                    Msg::Menu(Some((
                                        MenuTarget::SidebarOverflow,
                                        event.position(),
                                    ))),
                                    w,
                                    cx,
                                )
                            }),
                    ),
            )
        })
        .into_any_element()
}

fn scroll_of(window: &WindowId) -> ScrollMemo {
    SCROLLS.with(|s| {
        s.borrow_mut()
            .entry(window.clone())
            .or_insert_with(|| (ScrollHandle::new(), None))
            .clone()
    })
}

pub fn strip_left(full_screen: bool) -> f32 {
    if full_screen {
        8.0
    } else {
        TRAFFIC_LIGHTS_WIDTH + LIGHTS_GAP
    }
}

pub fn strip_right(controls: f32) -> f32 {
    84.0f32.max(controls + 8.0 + 6.0)
}

const NEW_TAB_SLOT: &str = "~new";

fn top_key(e: &Entry) -> Option<String> {
    match e {
        Entry::Dock(_) => None,
        Entry::Group { id, .. } => Some(format!("group:{id}")),
        Entry::Member(m) => m.tabs().first().map(|t| t.to_string()),
    }
}

fn ghost_chip(
    c: &Chrome,
    ghost: &crate::sidebar::strip_motion::Ghost,
    now: std::time::Instant,
) -> AnyElement {
    div()
        .absolute()
        .left(px(ghost.x))
        .top(px(ITEM_TOP))
        .w(px(ghost.width))
        .h(px(ITEM_HEIGHT))
        .opacity(ghost.opacity(now))
        .flex()
        .items_center()
        .pl(px(CHIP_PAD_LEFT))
        .pr(px(CHIP_PAD_RIGHT))
        .child(render_favicon(&ghost.favicon, FAVICON, c.p))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .ml(px(CHIP_LABEL_GAP))
                .child(fade_label(
                    SharedString::from(ghost.title.clone()),
                    c.p.text_tab,
                    12.,
                )),
        )
        .into_any_element()
}

fn incoming_gap(width: f32) -> AnyElement {
    div()
        .flex_none()
        .w(px(width))
        .h(px(STRIP_HEIGHT))
        .into_any_element()
}

fn bounds_probe(window: WindowId) -> AnyElement {
    canvas(
        move |_, w, cx| {
            let b = w.bounds();
            crate::sidebar::strip_drag::note_bounds(
                &window,
                crate::sidebar::strip_drag::ScreenRect {
                    x: crate::scale::points(b.origin.x),
                    y: crate::scale::points(b.origin.y),
                    w: crate::scale::points(b.size.width),
                    h: crate::scale::points(b.size.height),
                },
            );
            STILL.with(|f| f.set(cx.reduce_motion()));
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_0()
    .into_any_element()
}

pub struct StripFrame {
    pub origin: f32,
    pub width: f32,
    pub left: f32,
    pub right: f32,
    pub floating: bool,
}

fn strip_body(c: &Chrome, frame: StripFrame) -> AnyElement {
    FLOATING.with(|f| f.set(frame.floating));
    let body = strip_items(c, &frame);
    FLOATING.with(|f| f.set(false));
    let strip_bottom = if frame.floating {
        PEEK_TOP + PEEK_HEIGHT
    } else {
        STRIP_HEIGHT
    };
    div()
        .size_full()
        .relative()
        .child(body)
        .children(crate::sidebar::strip_hover::overlay(c, strip_bottom))
        .into_any_element()
}

fn strip_items(c: &Chrome, frame: &StripFrame) -> AnyElement {
    let now = std::time::Instant::now();
    let window_id = c.window.id.as_str();
    let entries = strip_entries(c.state, window_id);
    let needs_list = title_needs(c.state, window_id);
    let needs = |t: &TabId| needs_list.contains(t);
    let active = c
        .active
        .map(|t| t.id.clone())
        .unwrap_or_else(|| TabId::new(""));
    let mut probes: Vec<(String, f32)> = Vec::new();
    for e in &entries {
        if let Entry::Group { id, members, .. } = e {
            probes.push((group_name(c, id), 12.0));
            for m in members {
                if let Member::Folder { id, .. } = m {
                    probes.push((group_name(c, id), 12.0));
                }
            }
        }
    }
    let group_chip = |id: &GroupId| {
        group_chip_width(
            group_chip_frame(),
            measured(&group_name(c, id), 12.0),
            GROUP_TITLE_MAX,
        )
    };
    let folder_chip = |id: &GroupId| folder_chip_width(c, id);
    let room_for_new_tab = new_tab_room(c.state.settings.show_tab_menu_button);
    let measures = Measures {
        group_chip: &group_chip,
        folder_chip: &folder_chip,
        needs_title: &needs,
        new_tab_room: room_for_new_tab,
    };
    let flare = if frame.floating { 0.0 } else { FLARE };
    let left = frame.left;
    let page_width = (frame.width - left - frame.right).max(0.0);
    let count: usize = entries
        .iter()
        .map(|e| match e {
            Entry::Dock(_) => 0,
            Entry::Group { members, .. } => members.iter().map(|m| m.tabs().len()).sum(),
            Entry::Member(m) => m.tabs().len(),
        })
        .sum();
    let held = crate::sidebar::strip_motion::with(&c.window.id, |m| m.hold(count));
    let fit = strip_fit(&entries, &active, page_width, &measures);
    let layout = layout_strip(
        &entries,
        &active,
        page_width,
        &measures,
        fit,
        held.map(|h| h.widths),
    );
    let pinned = new_tab_pinned(
        layout.widths.chip,
        layout.tabs_end,
        page_width,
        layout.tabs_shrink,
        room_for_new_tab,
    );
    let ctx = StripCtx {
        active: active.clone(),
        widths: layout.widths,
        needs: &needs,
    };
    let dock = entries
        .iter()
        .find_map(|e| match e {
            Entry::Dock(ids) => Some(ids.len()),
            _ => None,
        })
        .unwrap_or(0);
    let (scroll, revealed) = scroll_of(&c.window.id);
    let scrolled = -crate::scale::points(scroll.offset().x);
    if revealed.as_ref() != Some(&active) {
        let span = layout
            .slots
            .iter()
            .find(|s| s.tabs.contains(&active))
            .map(|s| (dock_span(dock) + s.left, s.width));
        if let Some((x, w)) = span
            && let Some(to) = reveal_offset(x, w, scrolled, page_width, EDGE_FADE + GAP)
        {
            scroll.set_offset(point(px(-to), px(0.)));
        }
        SCROLLS.with(|s| {
            if let Some(entry) = s.borrow_mut().get_mut(&c.window.id) {
                entry.1 = Some(active.clone());
            }
        });
    }
    let rows: Vec<&Entry> = entries
        .iter()
        .filter(|e| !matches!(e, Entry::Dock(_)))
        .collect();
    let mut shots: Vec<crate::sidebar::strip_motion::Shot> = rows
        .iter()
        .zip(layout.slots.iter())
        .filter_map(|(e, slot)| {
            let key = top_key(e)?;
            let label = match e {
                Entry::Member(Member::Tab(id)) => c
                    .state
                    .tab(id.as_str())
                    .map(|t| (tab_title(t).to_string(), c.favicon(t))),
                _ => None,
            };
            Some(crate::sidebar::strip_motion::Shot {
                key,
                x: dock_span(dock) + slot.left,
                width: slot.width,
                label,
            })
        })
        .collect();
    let still = strip_still();
    let end = dock_span(dock) + layout.slots.last().map_or(0.0, |s| s.left + s.width);
    if !pinned {
        shots.push(crate::sidebar::strip_motion::Shot {
            key: NEW_TAB_SLOT.to_owned(),
            x: end + GAP,
            width: room_for_new_tab,
            label: None,
        });
    }
    let (offsets, shown, ghosts, running, hovered_now) =
        crate::sidebar::strip_motion::with(&c.window.id, |m| {
            m.advance(
                shots,
                page_width,
                (scrolled, scrolled + page_width),
                now,
                still,
            );
            m.remember(layout.widths, end);
            let offsets: HashMap<String, f32> = m
                .slides
                .keys()
                .map(|k| (k.clone(), m.offset(k, now)))
                .collect();
            let shown: HashMap<String, f32> = m
                .appears
                .keys()
                .map(|k| (k.clone(), m.shown(k, now)))
                .collect();
            (offsets, shown, m.ghosts.clone(), m.running(now), m.hovered)
        });
    let _ = hovered_now;
    let content = end + GAP + room_for_new_tab;
    let strength = crate::sidebar::strip_motion::edge_strength(scrolled, page_width, content);
    let clip_shown = if scrolled < 0.5 { 0.0 } else { flare };
    let dragging_in =
        crate::sidebar::strip_drag::external(&c.window.id).map(|(x, y)| (x - frame.origin, y));
    let incoming = crate::sidebar::strip_drag::incoming(&c.window.id)
        .map(|(x, y)| (x - frame.origin, y))
        .or(dragging_in);
    let insert = incoming.and_then(|(x, y)| {
        let strip_x = x - left - flare + flare - dock_span(dock) + scrolled;
        crate::sidebar::strip_drag::incoming_index(&layout.slots, Some(strip_x), y, &|t: &TabId| {
            c.state.in_pinned_container(t.as_str())
        })
    });
    let insert_tab = insert
        .and_then(|i| layout.slots.get(i))
        .and_then(|s| s.tabs.first().cloned());
    let order = c.window.tab_ids.clone();
    crate::sidebar::strip_drag::set_insert(
        &c.window.id,
        insert.map(|_| {
            insert_tab
                .as_ref()
                .and_then(|t| order.iter().position(|o| o == t))
                .unwrap_or(order.len())
        }),
    );
    let mut items: Vec<AnyElement> = Vec::new();
    let mut slot_index = 0usize;
    let reach = crate::primitives::virtual_list::OVERSCAN;
    let seen_from = scrolled - dock_span(dock) - reach;
    let seen_to = scrolled - dock_span(dock) + page_width + reach;
    let active_tab = c.active.map(|tab| tab.id.clone());
    let cull = layout.slots.len() > crate::primitives::virtual_list::SMALL_LIST_ROWS
        && insert.is_none()
        && !running;
    for e in &entries {
        let off_screen = cull
            && !matches!(e, Entry::Dock(_))
            && layout.slots.get(slot_index).is_some_and(|slot| {
                (slot.left + slot.width < seen_from || slot.left > seen_to)
                    && !active_tab.as_ref().is_some_and(|t| slot.tabs.contains(t))
            });
        if off_screen {
            let width = layout.slots[slot_index].width;
            slot_index += 1;
            items.push(div().flex_none().w(px(width)).into_any_element());
            continue;
        }
        let element = match e {
            Entry::Dock(ids) => {
                items.push(pinned_dock(c, ids));
                continue;
            }
            Entry::Member(m) => member(c, m, &ctx),
            Entry::Group {
                id,
                collapsed,
                members,
            } => Some(strip_group(
                c,
                GroupView {
                    id,
                    collapsed: *collapsed,
                    members,
                    chip: group_chip(id),
                },
                &ctx,
                &measures,
            )),
        };
        if insert == Some(slot_index) {
            items.push(incoming_gap(layout.widths.chip));
        }
        slot_index += 1;
        let Some(element) = element else {
            continue;
        };
        let key = top_key(e).unwrap_or_default();
        let opacity = shown.get(&key).copied().unwrap_or(1.0);
        let offset = offsets.get(&key).copied().unwrap_or(0.0);
        items.push(
            div()
                .flex_none()
                .relative()
                .left(px(offset))
                .opacity(opacity)
                .child(element)
                .into_any_element(),
        );
    }
    if insert == Some(slot_index) {
        items.push(incoming_gap(layout.widths.chip));
    }
    let glow = crate::sidebar::strip_motion::with(&c.window.id, |m| {
        m.group("drop-glow", incoming.is_some(), 0.0, now, still).0
    });
    let menu_emit = c.emit.clone();
    let hover_window = c.window.id.clone();
    let move_window = c.window.id.clone();
    let end_window = c.window.id.clone();
    let end_out_window = c.window.id.clone();
    let end_emit = c.emit.clone();
    let end_out_emit = c.emit.clone();
    let land =
        |window: &WindowId, emit: &crate::msg::Emit, w: &mut gpui::Window, cx: &mut gpui::App| {
            if let Some(landing) = crate::sidebar::strip_drag::finish(window) {
                let index = landing.index.unwrap_or(usize::MAX);
                emit.send(
                    Msg::Stores(vec![
                        Action::MoveTab {
                            tab: landing.tab.clone(),
                            window: landing.window,
                            index,
                        },
                        Action::ActivateTab { tab: landing.tab },
                    ]),
                    w,
                    cx,
                );
                cx.refresh_windows();
            }
        };
    let p = *c.p;
    let ring = (left - 4.0, frame.right - 4.0);
    div()
        .id(if frame.floating {
            "tab-strip-floating"
        } else {
            "tab-strip"
        })
        .debug_selector(|| "tab-strip".into())
        .size_full()
        .relative()
        .on_hover(move |hovered, w, _| {
            let release = crate::sidebar::strip_motion::with(&hover_window, |m| {
                m.hovered = *hovered;
                (!*hovered).then(|| m.held.take()).flatten().is_some()
            });
            if release {
                w.refresh();
            }
        })
        .on_drag_move({
            let window = c.window.id.clone();
            move |event: &gpui::DragMoveEvent<gpui::ExternalPaths>, w, _| {
                let (x, y) = crate::scale::logical_point(event.event.position);
                crate::sidebar::strip_drag::external_moved(&window, (x, y));
                w.refresh();
            }
        })
        .on_drag_move({
            let window = c.window.id.clone();
            move |event: &gpui::DragMoveEvent<gpui::ExternalItems>, w, _| {
                let (x, y) = crate::scale::logical_point(event.event.position);
                crate::sidebar::strip_drag::external_moved(&window, (x, y));
                w.refresh();
            }
        })
        .on_drop({
            let emit = c.emit.clone();
            let window = c.window.id.clone();
            move |paths: &gpui::ExternalPaths, w, cx| {
                let index = crate::sidebar::strip_drag::external_dropped(&window);
                if let Some(msg) = crate::sidebar::drag::file_drop(&window, index, paths) {
                    emit.send(msg, w, cx);
                }
            }
        })
        .on_drop({
            let emit = c.emit.clone();
            let window = c.window.id.clone();
            move |items: &gpui::ExternalItems, w, cx| {
                let index = crate::sidebar::strip_drag::external_dropped(&window);
                if let Some(msg) = crate::sidebar::drag::items_drop(&window, index, items) {
                    emit.send(msg, w, cx);
                }
            }
        })
        .on_drag_move(move |event: &gpui::DragMoveEvent<TabDrag>, w, cx| {
            let b = w.bounds();
            let at = (
                crate::scale::points(b.origin.x + event.event.position.x),
                crate::scale::points(b.origin.y + event.event.position.y),
            );
            let tab = event.drag(cx).tab.clone();
            if crate::sidebar::strip_drag::moved(&move_window, &tab, at) {
                cx.refresh_windows();
            }
        })
        .on_mouse_up(MouseButton::Left, move |_, w, cx| {
            land(&end_window, &end_emit, w, cx)
        })
        .on_mouse_up_out(MouseButton::Left, move |_, w, cx| {
            land(&end_out_window, &end_out_emit, w, cx)
        })
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            menu_emit.send(
                Msg::Menu(Some((MenuTarget::NewTab, event.position))),
                window,
                cx,
            )
        })
        .child(measure_probe(probes))
        .child(bounds_probe(c.window.id.clone()))
        .child(crate::sidebar::strip_motion::frame_driver(
            running || dragging_in.is_some() || (glow > 0.0 && glow < 1.0),
        ))
        .child(
            div()
                .id("tab-strip-clip")
                .absolute()
                .left(px(left - flare + clip_shown))
                .top_0()
                .w(px(page_width + flare * 2.0 - clip_shown))
                .h(px(STRIP_HEIGHT))
                .overflow_hidden()
                .child(crate::primitives::edge_fade::edge_fade(
                    div()
                        .id("tab-strip-items")
                        .absolute()
                        .left(px(-clip_shown))
                        .top_0()
                        .bottom_0()
                        .right(px(if pinned {
                            flare + room_for_new_tab
                        } else {
                            0.0
                        }))
                        .overflow_x_scroll()
                        .track_scroll(&scroll)
                        .flex()
                        .items_start()
                        .gap(px(GAP))
                        .pl(px(flare))
                        .pr(px(if pinned { flare.max(GAP) } else { flare }))
                        .child(
                            div()
                                .absolute()
                                .left(px(flare))
                                .top_0()
                                .size_full()
                                .children(ghosts.iter().map(|g| ghost_chip(c, g, now))),
                        )
                        .children(items)
                        .when(!pinned, |this| {
                            this.child(
                                div()
                                    .flex_none()
                                    .relative()
                                    .left(px(offsets.get(NEW_TAB_SLOT).copied().unwrap_or(0.0)))
                                    .child(new_tab_buttons(c)),
                            )
                        }),
                    strength.0,
                    strength.1,
                ))
                .when(pinned, |this| {
                    this.child(
                        div()
                            .absolute()
                            .top_0()
                            .right(px(flare))
                            .child(new_tab_buttons(c)),
                    )
                }),
        )
        .when(glow > 0.0 && !frame.floating, |this| {
            this.child(
                div()
                    .absolute()
                    .left(px(ring.0))
                    .right(px(ring.1))
                    .top(px(ITEM_TOP - 1.0))
                    .h(px(ITEM_HEIGHT + 2.0))
                    .rounded(px(tab_radius() + 1.0))
                    .border(px(DROP_RING_WIDTH))
                    .border_color(p.accent)
                    .bg(hsla(c.look.theme.roles.drop_zone_fill))
                    .opacity(glow),
            )
        })
        .into_any_element()
}

pub fn tab_strip(c: &Chrome, rect: Rect) -> AnyElement {
    let full_screen = c.window.is_full_screen();
    let left = strip_left(full_screen);
    let downloads = crate::sidebar::header::has_downloads(c);
    let controls = 96.0
        + if downloads {
            CONTROLS_GAP + DOWNLOADS_BOX
        } else {
            0.0
        };
    let right = strip_right(controls);
    div()
        .id("tab-strip-frame")
        .absolute()
        .left(px(rect.x))
        .top(px(rect.y))
        .w(px(rect.w))
        .h(px(rect.h))
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count >= 2 {
                window.titlebar_double_click();
            } else {
                window.start_window_move();
            }
        })
        .child(strip_body(
            c,
            StripFrame {
                origin: rect.x,
                width: rect.w,
                left,
                right,
                floating: false,
            },
        ))
        .child(
            div()
                .id("tab-strip-controls")
                .absolute()
                .right(px(8.))
                .top(px(MID - 17.0))
                .flex()
                .items_center()
                .gap(px(CONTROLS_GAP))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(crate::sidebar::header::profile_indicator(c, PROFILE_ROOM))
                .when(downloads, |this| {
                    this.child(crate::sidebar::header::downloads_button(c))
                }),
        )
        .into_any_element()
}

pub const PEEK_PAD: f32 = 8.0;
pub const PEEK_HEIGHT: f32 = ITEM_HEIGHT + PEEK_PAD * 2.0;
pub const PEEK_BORDER: f32 = 0.5;
pub const PEEK_LEFT: f32 = 6.0;
pub const PEEK_TOP: f32 = 4.0;
pub const PEEK_HOVER_HEIGHT: f32 = 6.0;
pub const PEEK_IN: std::time::Duration = std::time::Duration::from_millis(150);
pub const PEEK_OUT: std::time::Duration = std::time::Duration::from_millis(150);
pub const PEEK_CLOSE_DELAY: std::time::Duration = std::time::Duration::from_millis(200);

#[derive(Clone, Copy, Debug, Default)]
pub struct PeekState {
    pub out: bool,
    pub leave_at: Option<std::time::Instant>,
    pub moved_at: Option<std::time::Instant>,
    pub from: f32,
}

impl PeekState {
    pub fn show(&mut self, now: std::time::Instant) {
        self.leave_at = None;
        if !self.out {
            self.from = self.value(now);
            self.out = true;
            self.moved_at = Some(now);
        }
    }

    pub fn leave(&mut self, now: std::time::Instant) {
        if self.out {
            self.leave_at = Some(now);
        }
    }

    pub fn tick(&mut self, now: std::time::Instant) {
        if let Some(at) = self.leave_at
            && now.saturating_duration_since(at) >= PEEK_CLOSE_DELAY
        {
            self.from = self.value(now);
            self.out = false;
            self.leave_at = None;
            self.moved_at = Some(now);
        }
    }

    pub fn value(&self, now: std::time::Instant) -> f32 {
        let to = if self.out { 1.0 } else { 0.0 };
        let Some(at) = self.moved_at else {
            return to;
        };
        let length = if self.out { PEEK_IN } else { PEEK_OUT };
        let t = now.saturating_duration_since(at).as_secs_f32() / length.as_secs_f32();
        self.from + (to - self.from) * crate::sidebar::strip_motion::toggle_ease(t)
    }

    pub fn running(&self, now: std::time::Instant) -> bool {
        self.leave_at.is_some()
            || self.moved_at.is_some_and(|at| {
                now.saturating_duration_since(at) < if self.out { PEEK_IN } else { PEEK_OUT }
            })
    }
}

thread_local! {
    static PEEKS: RefCell<HashMap<WindowId, PeekState>> = RefCell::new(HashMap::new());
}

fn with_peek<R>(window: &WindowId, f: impl FnOnce(&mut PeekState) -> R) -> R {
    PEEKS.with(|p| f(p.borrow_mut().entry(window.clone()).or_default()))
}

pub fn strip_peek(c: &Chrome, window_width: f32) -> AnyElement {
    let now = std::time::Instant::now();
    let (slide, running) = with_peek(&c.window.id, |p| {
        p.tick(now);
        (p.value(now), p.running(now))
    });
    let enter_window = c.window.id.clone();
    let auto_hide_tabs = c.state.settings.auto_hide_tabs;
    let leave_window = c.window.id.clone();
    let panel_window = c.window.id.clone();
    let p = *c.p;
    div()
        .absolute()
        .inset_0()
        .child(crate::sidebar::strip_motion::frame_driver(running))
        .child(
            div()
                .id("strip-peek-edge")
                .absolute()
                .left(px(TRAFFIC_LIGHTS_WIDTH))
                .right_0()
                .top_0()
                .h(px(PEEK_HOVER_HEIGHT))
                .on_hover(move |hovered, w, _| {
                    if *hovered {
                        let opened = with_peek(&enter_window, |p| {
                            let was_out = p.out;
                            p.show(std::time::Instant::now());
                            !was_out
                        });
                        if opened {
                            ardia_telemetry::counts::count("tab_strip_peeks");
                            if !auto_hide_tabs {
                                ardia_telemetry::counts::count("tab_peeks_with_auto_hide_off");
                            }
                        }
                        w.refresh();
                    }
                }),
        )
        .when(slide > 0.0, |this| {
            this.child(
                div()
                    .id("strip-peek")
                    .debug_selector(|| "strip-peek".into())
                    .absolute()
                    .left(px(PEEK_LEFT))
                    .w(px(window_width - PEEK_LEFT * 2.0))
                    .top(px(PEEK_TOP + (1.0 - slide) * -(PEEK_HEIGHT + 8.0)))
                    .h(px(PEEK_HEIGHT))
                    .opacity(slide)
                    .rounded(px(12.))
                    .border(px(PEEK_BORDER))
                    .border_color(p.popover_border)
                    .bg(hsla(c.look.theme.window_tint[0]))
                    .shadow(crate::primitives::controls::panel_shadows(&p))
                    .overflow_hidden()
                    .on_hover(move |hovered, w, _| {
                        let y = crate::scale::points(w.mouse_position().y);
                        with_peek(&leave_window, |p| {
                            let now = std::time::Instant::now();
                            if *hovered {
                                p.show(now)
                            } else if y >= PEEK_HOVER_HEIGHT {
                                p.leave(now)
                            }
                        });
                        w.refresh();
                    })
                    .on_mouse_down(MouseButton::Left, move |_, _, _| {
                        with_peek(&panel_window, |p| p.leave_at = None);
                    })
                    .child(
                        div()
                            .absolute()
                            .left_0()
                            .right_0()
                            .top(px(PEEK_PAD - ITEM_TOP))
                            .h(px(STRIP_HEIGHT))
                            .child(strip_body(
                                c,
                                StripFrame {
                                    origin: PEEK_LEFT + PEEK_BORDER,
                                    width: window_width - 12.0 - PEEK_BORDER * 2.0,
                                    left: 8.0,
                                    right: 8.0,
                                    floating: true,
                                },
                            )),
                    ),
            )
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_cell_moves_all_its_members_before_the_cell_it_lands_on() {
        let members = vec![TabId::new("f1"), TabId::new("f2")];
        let moves = folder_cell_moves(&members, &TabId::new("t"));
        assert_eq!(moves.len(), 2);
        assert!(moves.iter().all(|m| matches!(m, Msg::DropTab { before: Some(b), pin: Some(true), .. } if b.as_str() == "t")));
        assert!(folder_cell_moves(&members, &TabId::new("f2")).is_empty());
    }

    #[test]
    fn the_selected_strip_face_rings_unless_the_top_app_is_filled() {
        use ardia_state::settings::SelectedTopApp;
        assert_eq!(strip_ring_width(SelectedTopApp::Ring), PINNED_RING_STROKE);
        assert_eq!(
            strip_ring_width(SelectedTopApp::Outline),
            PINNED_RING_STROKE
        );
        assert_eq!(strip_ring_width(SelectedTopApp::Fill), 0.0);
        assert_eq!(dock_face_glass(true, false).rest, Some(GlassState::Active));
        assert_eq!(dock_face_glass(false, false).rest, None);
    }

    #[test]
    fn strip_minimums_follow_the_dia_rules() {
        assert_eq!(strip_minimum(true, true), 128.0);
        assert_eq!(strip_minimum(false, true), 32.0);
        assert_eq!(strip_minimum(false, false), 64.0);
    }

    #[test]
    fn the_peek_slides_in_and_leaves_after_a_short_delay() {
        let now = std::time::Instant::now();
        let mut peek = PeekState::default();
        assert_eq!(peek.value(now), 0.0);
        peek.show(now);
        assert_eq!(peek.value(now), 0.0);
        assert_eq!(peek.value(now + PEEK_IN), 1.0);
        peek.leave(now + PEEK_IN);
        peek.tick(now + PEEK_IN + PEEK_CLOSE_DELAY / 2);
        assert!(peek.out);
        peek.tick(now + PEEK_IN + PEEK_CLOSE_DELAY);
        assert!(!peek.out);
        assert_eq!(peek.value(now + PEEK_IN + PEEK_CLOSE_DELAY + PEEK_OUT), 0.0);
    }

    #[test]
    fn the_strip_starts_after_the_window_buttons() {
        assert_eq!(strip_left(false), 86.0);
        assert_eq!(strip_left(true), 8.0);
        assert_eq!(strip_right(0.0), 84.0);
        assert_eq!(strip_right(130.0), 144.0);
    }
}
