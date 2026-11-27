use std::sync::Arc;

use ardia_state::TabId;
use ardia_state::model::TileFolder;

use crate::scale::px;
use ardia_state::tabs::Tab;
use ardia_theme::layout::sidebar;
use ardia_theme::{
    DockFill, DockGlyph, DockRing, DockSelection, IconTheme, SelectionStyle, dock_selection,
};
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, MouseButton, ParentElement, SharedString, Styled,
    div, prelude::*,
};

use ardia_state::settings::{MinimalismPinnedIcons, SelectedTopApp};
use ardia_state::unread::tab_unread;

use crate::msg::{MenuTarget, Msg};
use crate::primitives::controls::shadow;
use crate::primitives::favicon::{Favicon, render_favicon};
use crate::primitives::glass::{GlassState, PINNED_GRID_GLASS_GROUP, grouped_control_glass};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::primitives::unread::tile_unread;
use crate::sidebar::drag::{self, DragKind, DropContext, Ghost, GridTarget};
use crate::sidebar::drag_motion;
use crate::sidebar::folders::{self, TileCell};
use crate::sidebar::hover_card;
use crate::sidebar::row_look;
use crate::sidebar::tab_row::{drag_payload, row_id};
use crate::window::chrome::{Chrome, TabDrag};

pub const PINNED_GROUP_ID: u64 = 0x5049_4e4e_4544;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileLook {
    pub fill: Hsla,
    pub ring: Option<(Hsla, f32)>,
    pub inner: Option<(Hsla, f32)>,
    pub white_glyph: bool,
}

pub fn tile_look(selection: &DockSelection) -> TileLook {
    let fill = match selection.fill {
        DockFill::Solid(color) => hsla(color),
        DockFill::BlurredIcon { base, .. } => hsla(base),
    };
    let (ring, inner) = match selection.ring {
        DockRing::Solid { color, width } => (Some((hsla(color), width)), None),
        DockRing::SoftLight { color, width } => (Some((hsla(color).opacity(0.3), width)), None),
        DockRing::BlurredIcon { width, backing, .. } => {
            (Some((hsla(backing).opacity(0.75), width)), None)
        }
        DockRing::Rim { rim, outline } => (Some((hsla(rim), 0.5)), Some((hsla(outline), 0.5))),
    };
    TileLook {
        fill,
        ring,
        inner,
        white_glyph: selection.glyph == DockGlyph::WhiteTemplate,
    }
}

pub fn selected_tile_look(theme: IconTheme, c: &Chrome) -> TileLook {
    let style = if c.look.glass {
        SelectionStyle::Glass
    } else {
        SelectionStyle::Classic
    };
    let mut look = tile_look(&dock_selection(theme, &c.look.theme.roles, style));
    match theme {
        IconTheme::Blur { mean, .. } => {
            look.fill = look.fill.blend(hsla(mean).opacity(0.22));
            if let Some((_, width)) = look.ring {
                look.ring = Some((hsla(mean).opacity(0.9), width));
            }
        }
        IconTheme::Template { .. } | IconTheme::Default => {}
    }
    look
}

pub(crate) fn icon_theme(c: &Chrome, tab: &Tab) -> IconTheme {
    c.host
        .icon_theme_for(tab.id.clone())
        .or(tab.live.icon_theme)
        .unwrap_or(IconTheme::Default)
}

pub const MIN_TILE: f32 = 50.0;
pub const BALANCED_MAX_COLUMNS: usize = 4;
pub const QUIET_LETTER_SCALE: f32 = 12.0 / 34.0;
pub const ASLEEP_LETTER: f32 = 0.45;

pub fn pin_grid(count: usize, inner_width: f32, balanced: bool) -> (usize, f32) {
    let gap = sidebar::PINNED_TILE_GAP;
    let fit = (((inner_width + gap) / (MIN_TILE + gap)).floor() as usize).max(1);
    let count = count.max(1);
    let columns = if balanced {
        let rows = count.div_ceil(BALANCED_MAX_COLUMNS.min(fit));
        count.div_ceil(rows)
    } else {
        count.min(fit)
    };
    let width = ((inner_width - gap * (columns as f32 - 1.0)) / columns as f32 * 2.0).floor() / 2.0;
    (columns, width.max(0.0))
}

pub(crate) fn top_app_look(
    look: TileLook,
    setting: SelectedTopApp,
    p: &crate::look::Palette,
) -> TileLook {
    match setting {
        SelectedTopApp::Ring => look,
        SelectedTopApp::Fill => TileLook {
            ring: None,
            inner: None,
            ..look
        },
        SelectedTopApp::Outline => TileLook {
            fill: Hsla::transparent_black(),
            ring: Some((
                look.ring.map_or(p.pinned_selected_fill, |(color, _)| color),
                row_look::TILE_SELECTION_STROKE,
            )),
            inner: None,
            white_glyph: false,
        },
    }
}

pub const GLASS_RING: f32 = 2.0;
pub const PEEK_MARK_ICON: f32 = 16.0;

pub fn glass_selection(look: TileLook) -> TileLook {
    TileLook {
        fill: Hsla::transparent_black(),
        ring: look
            .ring
            .map(|(color, width)| (color, width.min(GLASS_RING))),
        inner: None,
        white_glyph: false,
    }
}

pub fn glass_ring(look: TileLook, theme: IconTheme) -> TileLook {
    TileLook {
        ring: look.ring.map(|(color, _)| {
            (
                match theme {
                    IconTheme::Blur { .. } => color,
                    IconTheme::Template { .. } | IconTheme::Default => Hsla::white(),
                },
                GLASS_RING,
            )
        }),
        ..look
    }
}

pub const GLOW_BIG_OUTSET: f32 = 0.75;

pub fn glow_hue(theme: IconTheme) -> Option<crate::primitives::glass_glow::GlowHue> {
    let mean = match theme {
        IconTheme::Blur { mean, .. } | IconTheme::Template { mean, .. } => mean,
        IconTheme::Default => return None,
    };
    crate::primitives::glass_glow::glow_color(hsla(mean))
        .map(crate::primitives::glass_glow::GlowHue::Color)
}

fn glass_hue(theme: IconTheme, width: f32, radius: f32, dark: bool) -> AnyElement {
    sized_glass_hue(theme, width, sidebar::pinned_tile_height(), radius, dark)
}

pub(crate) fn sized_glass_hue(
    theme: IconTheme,
    width: f32,
    height: f32,
    radius: f32,
    dark: bool,
) -> AnyElement {
    let big = gpui::Bounds::new(
        gpui::point(px(-width * GLOW_BIG_OUTSET), px(-height * GLOW_BIG_OUTSET)),
        gpui::size(
            px(width * (1.0 + 2.0 * GLOW_BIG_OUTSET)),
            px(height * (1.0 + 2.0 * GLOW_BIG_OUTSET)),
        ),
    );
    crate::primitives::glass_glow::glass_glow(radius, 0.0, dark, glow_hue(theme), big)
        .into_any_element()
}

fn status(c: &Chrome, tab: &Tab) -> Option<AnyElement> {
    if !c.state.settings.show_top_app_badges {
        return None;
    }
    let (box_w, box_h) = row_look::TILE_STATUS_BOX;
    let (inset_x, inset_y) = row_look::TILE_STATUS_INSET;
    let mute = ardia_state::mute::mute_state(c.state, tab);
    let playing = tab.live.audible || mute.is_some();
    let pip = c.host.media_pip_open(&tab.id);
    let unread = tab_unread(&c.state.settings, tab);
    Some(
        div()
            .absolute()
            .inset_0()
            .when(pip, |this| {
                this.child(
                    div()
                        .absolute()
                        .bottom(px(inset_y))
                        .left(px(inset_x))
                        .w(px(box_w))
                        .h(px(box_h))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon(
                            Icon::PictureInPicture,
                            row_look::TILE_STATUS_PIP,
                            c.p.text_secondary,
                        )),
                )
            })
            .when(playing, |this| {
                this.child(
                    div()
                        .absolute()
                        .bottom(px(inset_y))
                        .right(px(inset_x))
                        .w(px(box_w))
                        .h(px(box_h))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon(
                            if mute.is_some() {
                                Icon::SpeakerSlash
                            } else {
                                Icon::Speaker
                            },
                            row_look::TILE_STATUS_SPEAKER,
                            c.p.text_secondary,
                        )),
                )
            })
            .when_some(unread, |this, unread| {
                this.child(tile_unread(&unread, c.p.dark))
            })
            .into_any_element(),
    )
}

fn letter_face(c: &Chrome, tab: &Tab, width: f32, active: bool) -> AnyElement {
    let tokens = row_look::tokens_of(c);
    let letters = crate::sidebar::tile_letters::tile_letters_of(tab);
    let size =
        ((width.min(sidebar::pinned_tile_height()) * QUIET_LETTER_SCALE) * 2.0).round() / 2.0;
    let alpha = if active {
        tokens.quiet_active_text
    } else {
        tokens.quiet_text
    };
    div()
        .when(tab.page.is_asleep() && !active, |d| {
            d.opacity(ASLEEP_LETTER)
        })
        .text_size(px(size))
        .font_weight(FontWeight::MEDIUM)
        .text_color(c.p.text_tab.alpha(alpha))
        .child(letters)
        .into_any_element()
}

fn tile(
    c: &Chrome,
    tab: &Arc<Tab>,
    width: f32,
    drops: &DropContext,
    folder: Option<(&TileFolder, &[Arc<Tab>])>,
) -> AnyElement {
    let p = *c.p;
    let tokens = row_look::tokens_of(c);
    let quiet = row_look::quiet(c);
    let active = c.is_active(&tab.id);
    let selected = !active && c.is_selected(&tab.id);
    let glass = c.look.glass;
    let bare = row_look::closed_top_app(c.state, tab);
    let radius = sidebar::PINNED_TILE_RADIUS;
    let selection = (active && !quiet).then(|| {
        let look = top_app_look(
            selected_tile_look(icon_theme(c, tab), c),
            c.state.settings.shown_selected_top_app(),
            c.p,
        );
        if glass {
            glass_ring(glass_selection(look), icon_theme(c, tab))
        } else {
            look
        }
    });
    let favicon = c.favicon(tab);
    let backdrop = selection
        .filter(|_| {
            c.state.settings.shown_selected_top_app() == SelectedTopApp::Ring
                && matches!(icon_theme(c, tab), IconTheme::Blur { .. })
        })
        .and_then(|look| {
            c.host.pinned_backdrop(
                &favicon,
                crate::host::PinnedBackdrop {
                    width,
                    height: sidebar::pinned_tile_height(),
                    radius,
                    stroke: look.ring.map_or(0.0, |(_, stroke)| stroke),
                    dark: p.dark,
                    glass,
                    scale: crate::primitives::cap_letter::RETINA_PIXELS_PER_POINT,
                },
            )
        });
    let marks = row_look::row_marks(c.state, tab);
    let glyph = if quiet && c.state.settings.minimalism_pinned_icons != MinimalismPinnedIcons::Logos
    {
        letter_face(c, tab, width, active)
    } else {
        match (&favicon, selection) {
            (Favicon::Letter(letter), Some(look)) if look.white_glyph => {
                let mut white = *c.p;
                white.chip_fill = Hsla::transparent_black();
                white.favicon_tile = Hsla::transparent_black();
                white.text_secondary = Hsla::white();
                crate::primitives::favicon::letter_tile(*letter, 16., &white)
            }
            _ => {
                let side = c.look.icon_points(16.);
                div()
                    .relative()
                    .when(marks.icon_dimmed(), |d| {
                        d.opacity(row_look::SLEEPING_ICON_OPACITY)
                    })
                    .child(
                        div()
                            .debug_selector({
                                let id = tab.id.clone();
                                move || format!("tile-icon:{}", id.as_str())
                            })
                            .ml(px(crate::primitives::pixel_snap::centred_nudge(
                                width,
                                side,
                                crate::primitives::cap_letter::RETINA_PIXELS_PER_POINT,
                            )))
                            .mt(px(crate::primitives::pixel_snap::centred_nudge(
                                sidebar::pinned_tile_height(),
                                side,
                                crate::primitives::cap_letter::RETINA_PIXELS_PER_POINT,
                            )))
                            .child(render_favicon(&favicon, side, c.p)),
                    )
                    .children(
                        row_look::marked_engine(c, tab, side)
                            .map(|engine| row_look::engine_mark(c, engine, side)),
                    )
                    .into_any_element()
            }
        }
    };
    let hover = if quiet {
        tokens.quiet_wash
    } else {
        p.tab_hover
    };
    let pressed = if quiet {
        tokens.quiet_pressed
    } else {
        p.tab_pressed
    };
    let rest = if quiet {
        Some(if active {
            tokens.quiet_tile_live
        } else {
            tokens.quiet_tile
        })
    } else if glass || bare || selection.is_some() {
        None
    } else {
        Some(p.pinned_resting)
    };
    let (tile_fade, tile_fading) = if c.look.glass && !row_look::quiet(c) {
        let lit = row_look::is_hovered(c.window.id.as_str(), tab.id.as_str());
        (if lit { 1.0 } else { 0.0 }, false)
    } else {
        row_look::hover_fade(c.window.id.as_str(), tab.id.as_str())
    };
    let key = c.window.id.as_str().to_owned();
    let begin_drops = drops.clone();
    let id = tab.id.clone();
    let mut ghost = Ghost::new(c, tab, DragKind::Tile, drag::row_ghost_width(c), width);
    let folder_drag = folder.map(|(folder, members)| {
        ghost.title = SharedString::from(folders::folder_label(folder));
        ghost.art = Some(drag::GhostArt::Mosaic(
            folders::mosaic_rows(members)
                .into_iter()
                .map(|row| row.iter().map(|t| c.favicon(t)).collect())
                .collect(),
        ));
        (
            folder.id.clone(),
            members.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
        )
    });
    let menu_emit = c.emit.clone();
    let menu_id = tab.id.clone();
    let menu_key = c.window.id.as_str().to_owned();
    let pick_emit = c.emit.clone();
    let pick_id = tab.id.clone();
    let pick_key = c.window.id.as_str().to_owned();
    let close_emit = c.emit.clone();
    let close_id = tab.id.clone();
    let drop_ctx = drops.clone();
    let double_click = if hover_card::away_from_pin(tab) {
        Some(Msg::Store(ardia_state::Action::ReturnToPinnedUrl {
            tab: tab.id.clone(),
        }))
    } else if active && !tab.live.loading && !tab.url.is_empty() {
        Some(Msg::Reload {
            tab: tab.id.clone(),
            hard: false,
        })
    } else {
        None
    };
    let row = div()
        .id(row_id("tile", tab.id.as_str()))
        .debug_selector({
            let id = tab.id.clone();
            move || format!("tile:{}", id.as_str())
        })
        .relative()
        .flex_none()
        .w(px(width))
        .h(px(sidebar::pinned_tile_height()))
        .rounded(px(radius))
        .flex()
        .items_center()
        .justify_center()
        .when(drag::is_dragged(c, &tab.id), |this| this.invisible())
        .when(glass && !quiet && !(bare && !active && !selected), |this| {
            this.child(grouped_control_glass(
                c.look,
                radius,
                if active && c.state.settings.shown_selected_top_app() != SelectedTopApp::Outline {
                    GlassState::Active
                } else if tile_fade > 0.5 || selected {
                    GlassState::Lit
                } else {
                    GlassState::Rest
                },
                PINNED_GRID_GLASS_GROUP,
            ))
        })
        .when_some(
            if selection.is_none() && !selected && tile_fade > 0.0 {
                Some(row_look::mix(rest, hover, tile_fade))
            } else {
                rest
            },
            |this, fill| {
                if glass && !quiet {
                    this.child(div().absolute().inset_0().rounded(px(radius)).bg(fill))
                } else {
                    this.bg(fill)
                }
            },
        )
        .when(tile_fading, |this| {
            this.child(crate::sidebar::tab_row::frame_pump())
        })
        .when(
            !glass && !quiet && selection.is_none() && !selected && !bare,
            |this| {
                this.border(px(sidebar::PINNED_RESTING_HAIRLINE))
                    .border_color(p.pinned_resting_stroke)
            },
        )
        .when(selected, |this| {
            this.bg(hover)
                .border(px(1.))
                .border_color(tokens.drag_border)
        })
        .when_some(selection, |this, look| {
            let glow = if look.inner.is_some() {
                vec![shadow(
                    tokens.tile_glow.opacity(if p.dark { 0.15 } else { 0.12 }),
                    0.5,
                    3.,
                )]
            } else {
                Vec::new()
            };
            let drawn = backdrop.clone();
            let theme = icon_theme(c, tab);
            this.when(
                glass && c.state.settings.shown_selected_top_app() != SelectedTopApp::Outline,
                |this| this.child(glass_hue(theme, width, radius, p.dark)),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(radius))
                    .shadow(glow)
                    .map(|this| match drawn {
                        Some(image) => this.child(
                            gpui::img(image)
                                .absolute()
                                .inset_0()
                                .size_full()
                                .rounded(px(radius)),
                        ),
                        None => this
                            .bg(look.fill)
                            .when_some(look.ring, |this, (color, width)| {
                                this.border(px(width)).border_color(color)
                            }),
                    })
                    .when_some(look.inner, |this, (color, width)| {
                        this.child(
                            div()
                                .absolute()
                                .inset(px(0.5))
                                .rounded(px(radius - 0.5))
                                .border(px(width))
                                .border_color(color),
                        )
                    }),
            )
        })
        .when(selection.is_none() && !selected, |this| {
            this.active(move |style| style.bg(pressed))
        })
        .when(selected, |this| this.active(move |style| style.bg(pressed)))
        .on_mouse_down(MouseButton::Left, move |event, window, cx| {
            hover_card::dismiss(&pick_key, window, cx);
            crate::press_telemetry::note_press_started(
                event.click_count < 2 && !event.modifiers.modified() && !active,
                window.is_window_active(),
            );
            if event.click_count == 2 {
                crate::press_telemetry::note_tile_double_click(match &double_click {
                    Some(Msg::Store(_)) => crate::press_telemetry::TileDoubleClick::Return,
                    Some(_) => crate::press_telemetry::TileDoubleClick::Reload,
                    None => crate::press_telemetry::TileDoubleClick::Fresh,
                });
                if let Some(msg) = double_click.clone() {
                    pick_emit.send(msg, window, cx);
                }
                return;
            }
            pick_emit.send(
                Msg::PickTab {
                    tab: pick_id.clone(),
                    toggle: event.modifiers.platform || event.modifiers.control,
                    range: event.modifiers.shift,
                },
                window,
                cx,
            );
        })
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            cx.stop_propagation();
            hover_card::dismiss(&menu_key, window, cx);
            menu_emit.send(
                Msg::Menu(Some((MenuTarget::Tab(menu_id.clone()), event.position))),
                window,
                cx,
            );
        })
        .on_mouse_down(MouseButton::Middle, move |_, window, cx| {
            close_emit.send(Msg::CloseTab(close_id.clone()), window, cx)
        })
        .on_mouse_up(MouseButton::Left, |_, _, _| {
            crate::press_telemetry::note_press_released()
        })
        .on_mouse_down(MouseButton::Left, {
            let key = c.window.id.as_str().to_owned();
            move |event, _, _| drag::note_press(&key, event.position)
        })
        .on_drag(drag_payload(c, tab), move |_, grab, window, cx| {
            drag::begin(&key, &id, DragKind::Tile, &begin_drops, grab, &ghost);
            if let Some((folder, members)) = &folder_drag {
                drag::begin_folder(&key, folder, members.clone());
            }
            hover_card::dismiss(&key, window, cx);
            window.refresh();
            let mut ghost = ghost.clone();
            ghost.card = ghost.card.snapped(window);
            let ghost = ghost.view();
            cx.new(|_| ghost)
        })
        .on_drop(move |drag: &TabDrag, window, cx| drop_ctx.drop(drag, window, cx));
    hover_card::attach(row, c, tab)
        .when(
            crate::sidebar::tile_letters::open_tab(c.window.id.as_str()).as_ref() == Some(&tab.id),
            |this| {
                this.child(crate::sidebar::tile_letters::anchor_probe(
                    c.window.id.as_str(),
                    &tab.id,
                ))
            },
        )
        .child(
            div()
                .relative()
                .child(glyph)
                .children(crate::content::peek_overlay::peek_mark(
                    c,
                    &tab.id,
                    PEEK_MARK_ICON,
                )),
        )
        .children(crate::live::views::tile_badge(c, tab))
        .children(status(c, tab))
        .into_any_element()
}

fn gap_tile(width: f32) -> AnyElement {
    div()
        .flex_none()
        .w(px(width))
        .h(px(sidebar::pinned_tile_height()))
        .into_any_element()
}

fn folder_tile(c: &Chrome, folder: &TileFolder, members: &[Arc<Tab>], width: f32) -> AnyElement {
    let p = *c.p;
    let drag_source = members.first().map(|lead| {
        let mut ghost = Ghost::new(c, lead, DragKind::Tile, drag::row_ghost_width(c), width);
        ghost.title = SharedString::from(folders::folder_label(folder));
        ghost.favicon = Favicon::Glyph(Icon::Folder);
        ghost.art = Some(drag::GhostArt::Mosaic(
            folders::mosaic_rows(members)
                .into_iter()
                .map(|row| row.iter().map(|t| c.favicon(t)).collect())
                .collect(),
        ));
        (
            drag_payload(c, lead),
            ghost,
            members.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
            DropContext::new(c),
        )
    });
    let key = c.window.id.as_str().to_owned();
    let folder_id = folder.id.clone();
    let glass = c.look.glass;
    let radius = sidebar::PINNED_TILE_RADIUS;
    let hover = p.tab_hover;
    let pressed = p.tab_pressed;
    div()
        .id(SharedString::from(format!("folder-tile:{}", folder.id)))
        .relative()
        .flex_none()
        .w(px(width))
        .h(px(sidebar::pinned_tile_height()))
        .rounded(px(radius))
        .when(glass, |this| {
            this.child(grouped_control_glass(
                c.look,
                radius,
                GlassState::Rest,
                PINNED_GRID_GLASS_GROUP,
            ))
        })
        .when(!glass, |this| {
            this.bg(p.pinned_resting)
                .border(px(sidebar::PINNED_RESTING_HAIRLINE))
                .border_color(p.pinned_resting_stroke)
        })
        .hover(move |style| style.bg(hover))
        .active(move |style| style.bg(pressed))
        .on_click(folders::folder_tile_click(c, folder))
        .on_mouse_down(MouseButton::Right, {
            let emit = c.emit.clone();
            let folder = folder.id.clone();
            move |event, window, cx| {
                cx.stop_propagation();
                emit.send(
                    Msg::Menu(Some((
                        MenuTarget::TileFolderActions(folder.clone()),
                        event.position,
                    ))),
                    window,
                    cx,
                );
            }
        })
        .when_some(
            drag_source,
            move |this, (payload, ghost, members, drops)| {
                let press_key = key.clone();
                let lead = payload.tab.clone();
                this.on_mouse_down(MouseButton::Left, move |event, _, _| {
                    drag::note_press(&press_key, event.position)
                })
                .on_drag(payload, move |_, grab, window, cx| {
                    drag::begin(&key, &lead, DragKind::Tile, &drops, grab, &ghost);
                    drag::begin_folder(&key, &folder_id, members.clone());
                    hover_card::dismiss(&key, window, cx);
                    window.refresh();
                    let mut ghost = ghost.clone();
                    ghost.card = ghost.card.snapped(window);
                    let ghost = ghost.view();
                    cx.new(|_| ghost)
                })
            },
        )
        .child(folders::folder_mosaic(c, members, width))
        .into_any_element()
}

fn cell_element(c: &Chrome, cell: &TileCell, width: f32, drops: &DropContext) -> AnyElement {
    match cell {
        TileCell::Tab(tab) => tile(c, tab, width, drops, None),
        TileCell::Folder { folder, members } => match folders::shown_folder_tab(c, members) {
            Some(tab) => div()
                .relative()
                .flex_none()
                .child(tile(c, &tab, width, drops, Some((folder, members))))
                .child(folders::folder_badge(c))
                .into_any_element(),
            None => folder_tile(c, folder, members, width),
        },
    }
}

pub const FOLDER_RING_OUTSET: f32 = 3.0;
pub const FOLDER_RING_WIDTH: f32 = 2.0;
pub const FOLDER_RING_FROM_SCALE: f32 = 0.92;

thread_local! {
    static RINGS: std::cell::RefCell<std::collections::HashMap<(String, TabId), drag_motion::Slide>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

pub fn folder_rings(
    window: &str,
    heads: &[TabId],
    target: Option<&TabId>,
    now: std::time::Instant,
) -> (Vec<(TabId, f32)>, bool) {
    RINGS.with(|cell| {
        let mut rings = cell.borrow_mut();
        if let Some(target) = target {
            rings
                .entry((window.to_owned(), target.clone()))
                .or_insert_with(|| drag_motion::Slide::resting(0.0, drag_motion::ROOM_OMEGA));
        }
        let mut shown = Vec::new();
        let mut moving = false;
        rings.retain(|(win, head), slide| {
            if win != window {
                return true;
            }
            let on = target == Some(head) && heads.contains(head);
            slide.aim(if on { 1.0 } else { 0.0 }, now);
            let value = slide.value(now);
            let still = slide.moving(now);
            moving |= still;
            if value > 0.0 || still {
                shown.push((head.clone(), value));
            }
            on || still || value > 0.0
        });
        (shown, moving)
    })
}

fn folder_drop_ring(c: &Chrome, head: &TabId, shown: f32) -> AnyElement {
    let tokens = row_look::tokens_of(c);
    div()
        .id(gpui::SharedString::from(format!("folder-drop-ring:{head}")))
        .debug_selector(|| "folder-drop-ring".into())
        .absolute()
        .left(px(-FOLDER_RING_OUTSET))
        .top(px(-FOLDER_RING_OUTSET))
        .right(px(-FOLDER_RING_OUTSET))
        .bottom(px(-FOLDER_RING_OUTSET))
        .rounded(px(sidebar::PINNED_TILE_RADIUS + FOLDER_RING_OUTSET))
        .border(px(FOLDER_RING_WIDTH))
        .border_color(tokens.drop_mark)
        .bg(tokens.folder_drop_fill)
        .opacity(shown)
        .scale(FOLDER_RING_FROM_SCALE + (1.0 - FOLDER_RING_FROM_SCALE) * shown)
        .into_any_element()
}

pub fn cell_head(cell: &TileCell) -> Option<&TabId> {
    match cell {
        TileCell::Tab(tab) => Some(&tab.id),
        TileCell::Folder { members, .. } => members.first().map(|t| &t.id),
    }
}

type FolderableKey = (usize, usize, String);

thread_local! {
    static FOLDERABLE: std::cell::RefCell<Option<(FolderableKey, std::rc::Rc<std::collections::HashSet<TabId>>)>> =
        const { std::cell::RefCell::new(None) };
}

fn folderable(c: &Chrome) -> std::rc::Rc<std::collections::HashSet<TabId>> {
    let key: FolderableKey = (
        Arc::as_ptr(&c.state.tabs) as usize,
        Arc::as_ptr(&c.state.windows) as usize,
        c.window.id.as_str().to_owned(),
    );
    if let Some(hit) = FOLDERABLE.with(|cell| {
        cell.borrow()
            .as_ref()
            .filter(|(cached, _)| *cached == key)
            .map(|(_, ids)| ids.clone())
    }) {
        return hit;
    }
    let ids: std::rc::Rc<std::collections::HashSet<TabId>> = std::rc::Rc::new(
        c.window
            .tab_ids
            .iter()
            .filter(|id| {
                c.state.tab(id.as_str()).is_some_and(|t| {
                    !matches!(
                        &t.pin,
                        Some(ardia_state::model::TabPin::Tile { folder: Some(_) })
                    )
                })
            })
            .cloned()
            .collect(),
    );
    FOLDERABLE.with(|cell| *cell.borrow_mut() = Some((key, ids.clone())));
    ids
}

pub fn pinned_grid(c: &Chrome, tiles: &[Arc<Tab>], inner_width: f32) -> AnyElement {
    let balanced = c.state.settings.balanced_top_apps;
    let dragging = drag::snapshot(c);
    let dragged_tile = dragging
        .dragging
        .as_ref()
        .filter(|_| dragging.kind == Some(DragKind::Tile) && dragging.lifted);
    let all = folders::tile_cells(tiles);
    let home = dragged_tile.and_then(|id| {
        all.iter()
            .position(|cell| matches!(cell, TileCell::Tab(tab) if &tab.id == id))
    });
    let dragged_folder = drag::dragged_folder(c.window.id.as_str()).filter(|_| dragging.lifted);
    let home = home.or_else(|| {
        dragged_folder.as_ref().and_then(|id| {
            all.iter().position(
                |cell| matches!(cell, TileCell::Folder { folder, .. } if &folder.id == id),
            )
        })
    });
    let cells: Vec<&TileCell> = all
        .iter()
        .filter(|cell| !matches!(cell, TileCell::Tab(tab) if Some(&tab.id) == dragged_tile))
        .filter(|cell| {
            !matches!(cell, TileCell::Folder { folder, .. } if Some(&folder.id) == dragged_folder.as_ref())
        })
        .collect();
    let gap_at = drag::tile_gap_index(c)
        .or_else(|| home.filter(|_| dragging.spot.is_none()))
        .map(|i| i.min(cells.len()));
    let total = cells.len() + usize::from(gap_at.is_some());
    let (_, width) = pin_grid(total, inner_width, balanced);
    let drops = DropContext::new(c);
    let heads: Vec<(TabId, bool)> = cells
        .iter()
        .filter_map(|cell| {
            cell_head(cell).map(|head| (head.clone(), matches!(cell, TileCell::Folder { .. })))
        })
        .collect();
    let can_folder = folderable(c);
    let folder_target = drag::folder_target(c);
    let cell_heads: Vec<TabId> = cells
        .iter()
        .filter_map(|cell| cell_head(cell).cloned())
        .collect();
    let (rings, rings_moving) = folder_rings(
        c.window.id.as_str(),
        &cell_heads,
        folder_target.as_ref(),
        std::time::Instant::now(),
    );
    let target = GridTarget {
        window: c.window.id.as_str().to_owned(),
        emit: c.emit.clone(),
        sidebar: c.layout.sidebar.map(|r| (r.x, r.w)),
        cells: cells.len(),
        inner: inner_width,
        balanced,
        heads: std::rc::Rc::new(heads),
        folders: c.state.settings.top_app_folders,
        can_folder,
    };
    let drop_ctx = drops.clone();
    if cells.is_empty() && gap_at.is_none() {
        return div()
            .id("pinned-grid")
            .w(px(inner_width))
            .on_drag_move::<TabDrag>(move |event, window, cx| target.moved(event, window, cx))
            .on_drop(move |drag: &TabDrag, window, cx| drop_ctx.drop(drag, window, cx))
            .child(drag::pin_slot_zone(c))
            .into_any_element();
    }
    let mut children: Vec<AnyElement> = cells
        .iter()
        .map(|cell| {
            let element = cell_element(c, cell, width, &drops);
            let ring = cell_head(cell).and_then(|head| {
                rings
                    .iter()
                    .find(|(h, _)| h == head)
                    .map(|(h, v)| (h.clone(), *v))
            });
            match ring {
                Some((head, shown)) => div()
                    .relative()
                    .flex_none()
                    .child(element)
                    .child(folder_drop_ring(c, &head, shown))
                    .into_any_element(),
                None => element,
            }
        })
        .collect();
    if let Some(at) = gap_at {
        children.insert(at, gap_tile(width));
    }
    div()
        .id("pinned-grid")
        .flex()
        .flex_wrap()
        .gap(px(sidebar::PINNED_TILE_GAP))
        .w(px(inner_width))
        .on_drag_move::<TabDrag>(move |event, window, cx| target.moved(event, window, cx))
        .on_drop(move |drag: &TabDrag, window, cx| drop_ctx.drop(drag, window, cx))
        .children(children)
        .when(rings_moving, |this| {
            this.child(crate::sidebar::tab_row::frame_pump())
        })
        .children(crate::sidebar::tile_letters::tile_letters_panel(c))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_theme::{RgbaColor, tokens};

    #[test]
    fn template_icons_fill_with_their_colour_and_get_a_white_glyph() {
        let selection = dock_selection(
            IconTheme::Template {
                mean: RgbaColor::hex(0x1DA1F2),
                spread: 0.0,
            },
            &tokens::DARK,
            SelectionStyle::Classic,
        );
        let look = tile_look(&selection);
        assert!(look.white_glyph);
        assert_eq!(look.fill, hsla(RgbaColor::hex(0x1DA1F2)));
        assert_eq!(look.ring.map(|(_, width)| width), Some(3.0));
    }

    #[test]
    fn a_folder_cell_drops_before_its_first_member() {
        use ardia_state::model::TabPin;
        use ardia_state::{ProfileId, WindowId};
        let folder = TileFolder {
            id: "f".into(),
            name: "Work".into(),
            renamed_at: None,
        };
        let make = |id: &str, folder: Option<TileFolder>| {
            let mut tab = Tab::new(
                TabId::new(id),
                WindowId::new("w"),
                ProfileId::default_profile(),
                "https://a.test/",
                0,
            );
            tab.pin = Some(TabPin::Tile { folder });
            Arc::new(tab)
        };
        let tiles = vec![
            make("a", None),
            make("b", Some(folder.clone())),
            make("c", Some(folder)),
            make("d", None),
        ];
        let heads: Vec<String> = folders::tile_cells(&tiles)
            .iter()
            .filter_map(cell_head)
            .map(|id| id.to_string())
            .collect();
        assert_eq!(heads, vec!["a", "b", "d"]);
    }

    #[test]
    fn the_folder_ring_springs_in_and_back_out() {
        let now = std::time::Instant::now();
        let head = TabId::new("ring-head");
        let heads = vec![head.clone()];
        let ms = |n: u64| now + std::time::Duration::from_millis(n);
        let (shown, moving) = folder_rings("ring-w", &heads, Some(&head), now);
        assert_eq!(shown, vec![(head.clone(), 0.0)]);
        assert!(moving);
        let (shown, moving) = folder_rings("ring-w", &heads, Some(&head), ms(16));
        assert!(moving && shown[0].1 > 0.0 && shown[0].1 < 1.0);
        let (shown, _) = folder_rings("ring-w", &heads, Some(&head), ms(300));
        assert!((shown[0].1 - 1.0).abs() < 1e-3);
        let (shown, moving) = folder_rings("ring-w", &heads, None, ms(316));
        assert!(moving && shown[0].1 > 0.0 && shown[0].1 <= 1.0);
        let (shown, moving) = folder_rings("ring-w", &heads, None, ms(330));
        assert!(moving && shown[0].1 < 1.0);
        let (shown, moving) = folder_rings("ring-w", &heads, None, ms(700));
        assert!(shown.is_empty() && !moving);
    }

    #[test]
    fn balanced_grids_spread_tiles_over_even_rows() {
        assert_eq!(pin_grid(5, 178., false).0, 3);
        assert_eq!(pin_grid(5, 400., false).0, 5);
        assert_eq!(pin_grid(5, 400., true).0, 3);
        assert_eq!(pin_grid(8, 400., true).0, 4);
        assert_eq!(pin_grid(3, 178., false).1, 55.0);
    }

    #[test]
    fn a_selected_glass_tile_draws_a_white_two_point_ring() {
        let theme = IconTheme::Default;
        let look = glass_ring(
            glass_selection(tile_look(&dock_selection(
                theme,
                &tokens::DARK,
                SelectionStyle::Glass,
            ))),
            theme,
        );
        assert_eq!(look.ring, Some((Hsla::white(), GLASS_RING)));
        assert!(look.inner.is_none());
        let blur = IconTheme::Blur {
            mean: RgbaColor::hex(0x3366CC),
            spread: 0.0,
        };
        let tinted = glass_ring(
            TileLook {
                fill: Hsla::transparent_black(),
                ring: Some((hsla(RgbaColor::hex(0x3366CC)), 3.0)),
                inner: None,
                white_glyph: false,
            },
            blur,
        );
        assert_eq!(
            tinted.ring,
            Some((hsla(RgbaColor::hex(0x3366CC)), GLASS_RING))
        );
    }

    #[test]
    fn the_default_selection_draws_a_rim() {
        let look = tile_look(&dock_selection(
            IconTheme::Default,
            &tokens::DARK,
            SelectionStyle::Classic,
        ));
        assert!(!look.white_glyph);
        assert!(look.inner.is_some());
        assert_eq!(look.fill, hsla(tokens::DARK.pinned_selected_fill));
    }
}
