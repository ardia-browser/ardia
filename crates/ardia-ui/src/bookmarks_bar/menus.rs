use std::time::Duration;

use crate::scale::px;
use ardia_state::BookmarkId;
use ardia_state::bookmarks::{BookmarkNode, BookmarkTree};
use gpui::{
    AnyElement, AnyWindowHandle, App, AsyncApp, IntoElement, MouseButton, ParentElement,
    SharedString, Styled, Window, anchored, deferred, div, point, prelude::*,
};

use super::fit::{self, ItemHit, Spot, ZoneItem};
use super::{
    BarCtx, BarDrag, FOLDER_MANY, Panel, chip_icon, measure, open_bookmark_url, open_mode_for,
    panel_key,
};
use crate::pages::bookmarks::edits;
use crate::pages::bookmarks::open::OpenAll;
use crate::primitives::virtual_list::{VirtualItem, virtual_list};

thread_local! {
    static PANEL_OPENED: std::cell::RefCell<std::collections::HashMap<String, Option<std::time::Instant>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

fn row_key(level: usize, id: &BookmarkId) -> String {
    format!("row:{level}:{id}")
}

fn inside_any_panel(ctx: &BarCtx, cx: &App, at: gpui::Point<gpui::Pixels>) -> bool {
    let ui = ctx.ui.read(cx);
    ui.panels.iter().any(|panel| {
        ui.bounds
            .get(&format!("menu:{}", panel.level))
            .is_some_and(|b| b.contains(&at))
    })
}

fn hover_row(ctx: &BarCtx, level: usize, id: &BookmarkId, folder: bool, cx: &mut App) {
    let generation = ctx.ui.update(cx, |ui, _| {
        ui.hover_generation += 1;
        ui.hover_generation
    });
    if ctx.ui.read(cx).dragging.is_some() {
        return;
    }
    let ui = ctx.ui.clone();
    let id = id.clone();
    cx.spawn(async move |cx: &mut AsyncApp| {
        cx.background_executor()
            .timer(Duration::from_millis(fit::HOVER_OPEN_MS))
            .await;
        ui.update(cx, |ui, cx| {
            if ui.hover_generation != generation {
                return;
            }
            if folder {
                if let Some(anchor) = ui.rect(&row_key(level, &id)) {
                    ui.open_panel(
                        Panel {
                            key: panel_key(&id, 0),
                            parent: id.clone(),
                            from: 0,
                            anchor,
                            level: level + 1,
                        },
                        false,
                    );
                }
            } else {
                ui.close_above(level);
            }
            cx.notify();
        });
    })
    .detach();
}

fn open_child(ctx: &BarCtx, level: usize, id: &BookmarkId, cx: &mut App) {
    ctx.ui.update(cx, |ui, cx| {
        if let Some(anchor) = ui.rect(&row_key(level, id)) {
            ui.open_panel(
                Panel {
                    key: panel_key(id, 0),
                    parent: id.clone(),
                    from: 0,
                    anchor,
                    level: level + 1,
                },
                false,
            );
            cx.notify();
        }
    });
}

fn track_panel(
    ctx: &BarCtx,
    panel: &Panel,
    ids: &[BookmarkId],
    inside: bool,
    at: gpui::Point<gpui::Pixels>,
    dragged: Option<&BookmarkId>,
    cx: &mut App,
) {
    let Some(tree) = ctx.tree() else {
        return;
    };
    if !inside {
        let mine = match &ctx.ui.read(cx).spot {
            Some(Spot::Slot { parent, .. }) => parent == &panel.parent,
            Some(Spot::Into(id)) => ids.contains(id),
            None => false,
        };
        if mine {
            super::set_spot(ctx, None, dragged.cloned(), panel.level + 1, cx);
        }
        return;
    }
    let y = crate::scale::points(at.y);
    let items: Vec<ZoneItem> = {
        let ui = ctx.ui.read(cx);
        ids.iter()
            .filter_map(|id| {
                let rect = ui.rect(&row_key(panel.level, id))?;
                Some(ZoneItem {
                    id: id.clone(),
                    start: rect.y,
                    size: rect.h,
                    folder: matches!(tree.get(id.as_str()), Some(BookmarkNode::Folder { .. })),
                })
            })
            .collect()
    };
    let next = match fit::zone_hit(&items, y, dragged, 0.0) {
        ItemHit::Into(id) if !dragged.is_some_and(|d| fit::is_within(&tree, &id, d)) => {
            Some(Spot::Into(id))
        }
        ItemHit::Into(_) => None,
        ItemHit::Slot(slot) => Some(Spot::Slot {
            parent: panel.parent.clone(),
            slot: panel.from + slot,
        }),
    };
    super::set_spot(ctx, next, dragged.cloned(), panel.level + 1, cx);
}

#[allow(clippy::too_many_arguments)]
fn menu_row(
    ctx: &BarCtx,
    panel: &Panel,
    tree: &BookmarkTree,
    id: &BookmarkId,
    open: bool,
    ring: bool,
    line_above: bool,
    motion: RowMotion,
    window_handle: AnyWindowHandle,
) -> Option<AnyElement> {
    let p = ctx.p;
    let node = tree.get(id.as_str())?;
    let folder = matches!(node, BookmarkNode::Folder { .. });
    let url = match node {
        BookmarkNode::Url { url, .. } => Some(url.clone()),
        _ => None,
    };
    let title = if node.title().is_empty() {
        url.clone().unwrap_or_default()
    } else {
        node.title().to_owned()
    };
    let favicon = match node {
        BookmarkNode::Url { url, favicon, .. } => Some(super::bookmark_favicon(
            ctx.host.as_ref(),
            &ctx.profile,
            url,
            favicon.as_deref(),
            &title,
        )),
        _ => None,
    };
    let level = panel.level;
    let key = row_key(level, id);
    let drag = BarDrag {
        ui: ctx.ui.clone(),
        since: std::time::Instant::now(),
        id: id.clone(),
        title: SharedString::from(title.clone()),
        favicon: favicon.clone(),
        folder,
        host: ctx.host.clone(),
        width: fit::MENU_WIDTH - fit::ROW_INSET * 2.0,
        p,
    };
    let hover = ctx.clone();
    let click = ctx.clone();
    let middle = ctx.clone();
    let menu = ctx.clone();
    let (hover_id, click_id, menu_id) = (id.clone(), id.clone(), id.clone());
    let (click_url, middle_url) = (url.clone(), url.clone());
    let selector = format!("bookmark-folder-row:{title}");
    let tip = url;
    let row = div()
        .id(SharedString::from(key.clone()))
        .relative()
        .h(px(fit::MENU_ROW))
        .top(px(motion.offset))
        .when(motion.hidden, |this| this.opacity(0.))
        .px(px(fit::ROW_PADDING))
        .rounded(px(fit::ROW_RADIUS))
        .flex()
        .items_center()
        .gap(px(fit::ICON_GAP))
        .cursor_pointer()
        .debug_selector(move || selector)
        .when(open || ring, |this| this.bg(p.menu_hover))
        .when(!open && !ring, |this| {
            this.hover(move |style| style.bg(p.menu_hover))
                .active(move |style| style.bg(p.popover_row_pressed))
        })
        .when(ring, |this| {
            this.border(px(fit::DROP_RING)).border_color(p.accent)
        })
        .on_hover(move |hovered, _, cx| {
            if *hovered {
                hover_row(&hover, level, &hover_id, folder, cx);
            }
        })
        .on_click(move |event, _, cx| {
            if folder {
                open_child(&click, level, &click_id, cx);
                return;
            }
            let Some(url) = click_url.as_deref() else {
                return;
            };
            let mode = open_mode_for(event.modifiers(), false);
            if mode != crate::pages::bookmarks::open::OpenMode::Background {
                click.ui.update(cx, |ui, cx| {
                    ui.close_all(false);
                    cx.notify();
                });
            }
            open_bookmark_url(&click.host, &click.window, url, mode);
        })
        .on_mouse_down(MouseButton::Middle, move |event, _, _| {
            if let Some(url) = middle_url.as_deref() {
                open_bookmark_url(
                    &middle.host,
                    &middle.window,
                    url,
                    open_mode_for(event.modifiers, true),
                );
            }
        })
        .on_mouse_down(MouseButton::Right, move |_, _, cx| {
            cx.stop_propagation();
            super::open_bar_menu(&menu, Some(menu_id.clone()), window_handle, cx);
        })
        .on_drag(drag, |drag, _, _, cx| cx.new(|_| drag.restarted()))
        .child(
            div()
                .size(px(fit::ICON_SLOT))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .child(chip_icon(
                    ctx.host.as_ref(),
                    favicon.as_ref(),
                    folder,
                    &p,
                    p.icon,
                    fit::MENU_FAVICON,
                    fit::PANEL_ICON,
                    fit::ICON_SLOT,
                )),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(13.))
                .text_color(p.text)
                .child(title),
        )
        .when(folder, |this| {
            this.child(
                div()
                    .size(px(fit::MENU_CHEVRON_BOX))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(super::sf_semibold(
                        ctx.host.as_ref(),
                        "chevron.right",
                        10.,
                        fit::MENU_CHEVRON_BOX,
                        p.text_secondary,
                    )),
            )
        })
        .when_some(tip, |this, tip| {
            this.tooltip(crate::primitives::controls::tooltip(tip.into(), &p))
        })
        .when(line_above, |this| {
            this.child(
                div()
                    .absolute()
                    .left(px(fit::ROW_PADDING))
                    .right(px(fit::ROW_PADDING))
                    .top(px(motion.line_top - fit::DROP_LINE / 2.))
                    .h(px(fit::DROP_LINE))
                    .rounded(px(1.))
                    .bg(p.accent),
            )
        });
    Some(
        div()
            .relative()
            .flex_none()
            .mx(px(fit::ROW_INSET))
            .child(measure(&ctx.ui, key))
            .child(row)
            .into_any_element(),
    )
}

fn menu_material(p: &crate::look::Palette) -> [AnyElement; 2] {
    let material = if p.dark {
        ardia_theme::tokens::POPOVER_MENU_MATERIAL_DARK
    } else {
        ardia_theme::tokens::POPOVER_MENU_MATERIAL_LIGHT
    };
    let tint = if p.dark {
        ardia_theme::RgbaColor::new(38.0 / 255.0, 38.0 / 255.0, 38.0 / 255.0, 0.72)
    } else {
        ardia_theme::RgbaColor::new(1.0, 1.0, 1.0, 0.7)
    };
    let radius = px(ardia_theme::layout::panel::RADIUS);
    [
        gpui::visual_effect(gpui::VisualEffectMaterial::Menu)
            .blending(gpui::VisualEffectBlending::WithinWindow)
            .absolute()
            .inset_0()
            .rounded(radius)
            .bg(crate::primitives::theme_bridge::hsla(material))
            .into_any_element(),
        div()
            .absolute()
            .inset_0()
            .rounded(radius)
            .bg(crate::primitives::theme_bridge::hsla(tint))
            .into_any_element(),
    ]
}

pub const MENU_SCALE_FROM: f32 = 0.94;

pub fn menu_scale(progress: f32) -> f32 {
    MENU_SCALE_FROM + (1.0 - MENU_SCALE_FROM) * progress
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RowMotion {
    pub offset: f32,
    pub hidden: bool,
    pub line_top: f32,
}

fn action_row(
    ctx: &BarCtx,
    id: &'static str,
    glyph: &'static str,
    title: String,
    disabled: bool,
    run: impl Fn(&mut App) + 'static,
) -> AnyElement {
    let p = ctx.p;
    let closer = ctx.clone();
    let selector = format!("bookmark-folder-action:{title}");
    div()
        .id(id)
        .h(px(fit::MENU_ROW))
        .mx(px(fit::ROW_INSET))
        .px(px(fit::ROW_PADDING))
        .rounded(px(fit::ROW_RADIUS))
        .flex()
        .items_center()
        .gap(px(fit::ICON_GAP))
        .debug_selector(move || selector)
        .when(disabled, |this| this.opacity(0.4))
        .when(!disabled, |this| {
            this.cursor_pointer()
                .hover(move |style| style.bg(p.menu_hover))
                .active(move |style| style.bg(p.popover_row_pressed))
                .on_click(move |_, _, cx| {
                    closer.ui.update(cx, |ui, cx| {
                        ui.close_all(false);
                        cx.notify();
                    });
                    run(cx);
                })
        })
        .child(
            div()
                .size(px(fit::ICON_SLOT))
                .flex()
                .items_center()
                .justify_center()
                .child(super::sf(
                    ctx.host.as_ref(),
                    glyph,
                    fit::PANEL_ICON,
                    fit::ICON_SLOT,
                    p.icon,
                )),
        )
        .child(
            div()
                .flex_1()
                .truncate()
                .text_size(px(13.))
                .text_color(p.text)
                .child(title),
        )
        .into_any_element()
}

pub fn render_panels(
    ctx: &BarCtx,
    tree: &BookmarkTree,
    layer: fit::Rect,
    window_handle: AnyWindowHandle,
    window: &mut Window,
    cx: &mut App,
) -> Vec<AnyElement> {
    let now = std::time::Instant::now();
    let close_ms = crate::primitives::tokens::duration::FAST;
    let open_ms = crate::primitives::tokens::duration::BASE;
    ctx.ui.update(cx, |ui, _| {
        ui.closing
            .retain(|(_, since)| now.saturating_duration_since(*since) < close_ms)
    });
    let ui = ctx.ui.read(cx);
    let panels = ui.panels.clone();
    let appear = ui.appear.clone();
    let closing = ui.closing.clone();
    let spot = ui.spot.clone();
    let p = ctx.p;
    let mut out = Vec::new();
    let mut animating = !closing.is_empty();
    let shown: Vec<(Panel, bool)> = closing
        .iter()
        .map(|(panel, _)| (panel.clone(), true))
        .chain(panels.iter().map(|panel| (panel.clone(), false)))
        .collect();
    for (panel, fading) in &shown {
        let progress = if *fading {
            let since = closing
                .iter()
                .find(|(p, _)| super::appear_key(p) == super::appear_key(panel))
                .map(|(_, at)| *at)
                .unwrap_or(now);
            1.0 - crate::primitives::tokens::Curve::Exit.ease(
                (now.saturating_duration_since(since).as_secs_f32() / close_ms.as_secs_f32())
                    .min(1.0),
            )
        } else {
            let since = appear
                .get(&super::appear_key(panel))
                .copied()
                .unwrap_or(now - open_ms);
            let t = (now.saturating_duration_since(since).as_secs_f32() / open_ms.as_secs_f32())
                .min(1.0);
            if t < 1.0 {
                animating = true;
            }
            crate::primitives::tokens::Curve::Enter.ease(t)
        };
        let ids: Vec<BookmarkId> = tree
            .children(panel.parent.as_str())
            .iter()
            .skip(panel.from)
            .cloned()
            .collect();
        let height = ctx
            .ui
            .read(cx)
            .rect(&format!("menu:{}", panel.level))
            .map(|r| r.h);
        let (x, y, max_height) =
            fit::place_menu(panel.anchor, panel.level, layer, fit::MENU_WIDTH, height);
        let child_open = panels
            .iter()
            .find(|p| p.level == panel.level + 1)
            .map(|p| p.parent.clone());
        let line_slot = match &spot {
            Some(Spot::Slot { parent, slot }) if parent == &panel.parent => {
                Some(slot.saturating_sub(panel.from))
            }
            _ => None,
        };
        let into = match &spot {
            Some(Spot::Into(id)) => Some(id.clone()),
            _ => None,
        };
        let has_links = panel.from == 0 && edits::folder_has_links(tree, panel.parent.as_str());
        let footer_room = if !has_links {
            0.0
        } else {
            fit::FOOTER_ROWS as f32 * fit::MENU_ROW + fit::ROW_INSET * 2.0
        };
        let dragging = ctx
            .ui
            .read(cx)
            .dragging
            .clone()
            .filter(|_| cx.has_active_drag());
        let dragged_at = dragging
            .as_ref()
            .and_then(|d| ids.iter().position(|id| id == d));
        let offsets = if cx.has_active_drag() && !*fading {
            fit::room_offsets(ids.len(), dragged_at, line_slot, fit::MENU_ROW)
        } else {
            vec![0.0; ids.len()]
        };
        let line_row =
            line_slot.and_then(|slot| (slot..ids.len()).find(|i| Some(*i) != dragged_at));
        let (slid, sliding) = ctx.ui.update(cx, |ui, _| {
            let mut sliding = false;
            let slid: Vec<f32> = ids
                .iter()
                .zip(&offsets)
                .map(|(id, offset)| {
                    let slide = ui
                        .slides
                        .entry(row_key(panel.level, id))
                        .or_insert_with(|| fit::Slide::at(*offset, now));
                    slide.retarget(*offset, now);
                    sliding |= slide.running(now);
                    slide.value(now)
                })
                .collect();
            (slid, sliding)
        });
        animating |= sliding;
        let scroll_key = format!(
            "bookmark-folder:{}:{}",
            ctx.window,
            super::appear_key(panel)
        );
        let opened_at = appear.get(&super::appear_key(panel)).copied();
        if opened_at.is_some()
            && PANEL_OPENED.with(|seen| {
                seen.borrow_mut().insert(scroll_key.clone(), opened_at) != Some(opened_at)
            })
        {
            crate::primitives::virtual_list::forget(&scroll_key);
        }
        let scroll = crate::primitives::virtual_list::scroll_handle(scroll_key.clone());
        let row_items: Vec<VirtualItem> = ids
            .iter()
            .map(|id| VirtualItem::new(SharedString::from(id.as_str().to_owned()), fit::MENU_ROW))
            .collect();
        let rows = virtual_list(scroll_key, &scroll)
            .items(row_items)
            .render_all(cx.has_active_drag())
            .render(|index, _| {
                let id = &ids[index];
                menu_row(
                    ctx,
                    panel,
                    tree,
                    id,
                    child_open.as_ref() == Some(id),
                    into.as_ref() == Some(id),
                    line_row == Some(index),
                    RowMotion {
                        offset: slid.get(index).copied().unwrap_or(0.0),
                        hidden: dragged_at == Some(index),
                        line_top: if line_slot.is_some() && cx.has_active_drag() {
                            -fit::MENU_ROW / 2.0
                        } else {
                            0.0
                        },
                    },
                    window_handle,
                )
                .unwrap_or_else(|| div().flex_none().h(px(fit::MENU_ROW)).into_any_element())
            });
        let empty = ids.is_empty().then(|| {
            div()
                .h(px(fit::MENU_ROW))
                .mx(px(fit::ROW_INSET))
                .px(px(fit::ROW_PADDING))
                .flex()
                .items_center()
                .text_size(px(13.))
                .text_color(p.text_tertiary)
                .child("Empty")
        });
        let footer = has_links.then(|| {
            let makes = super::groups::makes_group(tree, &panel.parent);
            let mut items = Vec::new();
            for (id, glyph, title, mode) in [
                (
                    "folder-open-all",
                    "plus.app",
                    "Open All in New Tabs".to_owned(),
                    OpenAll::Tabs,
                ),
                (
                    "folder-open-window",
                    "macwindow.badge.plus",
                    "Open All in New Window".to_owned(),
                    OpenAll::Window,
                ),
                (
                    "folder-open-incognito",
                    "eyeglasses",
                    "Open All in Incognito Window".to_owned(),
                    OpenAll::Incognito,
                ),
            ] {
                let opener = ctx.clone();
                let folder = panel.parent.clone();
                items.push(action_row(ctx, id, glyph, title, false, move |cx| {
                    let urls: Vec<String> = opener
                        .tree()
                        .map(|tree| {
                            edits::folder_links(&tree, folder.as_str())
                                .into_iter()
                                .map(|(url, _)| url)
                                .collect()
                        })
                        .unwrap_or_default();
                    opener.open_links(urls, mode, FOLDER_MANY, cx)
                }));
            }
            let grouper = ctx.clone();
            let folder = panel.parent.clone();
            items.push(action_row(
                ctx,
                "folder-add-group",
                "sidebar.left",
                "Add to Sidebar as Group".to_owned(),
                !makes,
                move |_| {
                    super::add_folder_to_sidebar(
                        &grouper.host,
                        &folder,
                        &grouper.window,
                        &grouper.profile,
                    )
                },
            ));
            div()
                .pb(px(fit::ROW_INSET))
                .child(crate::primitives::controls::separator(&p))
                .children(items)
        });
        let closer = ctx.clone();
        let mover = ctx.clone();
        let dropper = ctx.clone();
        let tracked = panel.clone();
        let tracked_ids = ids.clone();
        let link_mover = ctx.clone();
        let link_dropper = ctx.clone();
        let link_tracked = panel.clone();
        let link_ids = ids.clone();
        let menu_key = format!("menu:{}", panel.level);
        let selector = format!("bookmark-folder-menu:{}", panel.level);
        let tail_line = line_slot.is_some() && line_row.is_none() && !ids.is_empty();
        out.push(
            deferred(
                anchored()
                    .position(point(
                        px(x - (1.0 - menu_scale(progress)) * fit::MENU_WIDTH / 2.0),
                        px(y - 4.0 * (1.0 - progress)
                            - (1.0 - menu_scale(progress)) * height.unwrap_or(0.0) / 2.0),
                    ))
                    .child(
                        crate::primitives::controls::popover(
                            SharedString::from(format!("bookmark-folder-menu-{}", panel.level)),
                            false,
                            fit::MENU_WIDTH,
                            &p,
                        )
                        .debug_selector(move || selector)
                        .py(px(0.))
                        .opacity(progress)
                        .scale(menu_scale(progress))
                        .children(menu_material(&p))
                        .when(!*fading, |this| this.child(measure(&ctx.ui, menu_key)))
                        .on_mouse_down_out(move |event, _, cx| {
                            if inside_any_panel(&closer, cx, event.position) {
                                return;
                            }
                            closer.ui.update(cx, |ui, cx| {
                                ui.close_all(true);
                                cx.notify();
                            });
                        })
                        .on_drag_move::<BarDrag>(move |event, _, cx| {
                            let inside = event.bounds.contains(&event.event.position);
                            let dragged = event.drag(cx).id.clone();
                            track_panel(
                                &mover,
                                &tracked,
                                &tracked_ids,
                                inside,
                                event.event.position,
                                Some(&dragged),
                                cx,
                            );
                        })
                        .on_drag_move::<gpui::ExternalItems>(move |event, _, cx| {
                            let inside = event.bounds.contains(&event.event.position);
                            track_panel(
                                &link_mover,
                                &link_tracked,
                                &link_ids,
                                inside,
                                event.event.position,
                                None,
                                cx,
                            );
                        })
                        .on_drop::<BarDrag>(move |drag, _, cx| {
                            super::drop_bookmark(&dropper, &drag.id, cx)
                        })
                        .on_drop::<gpui::ExternalItems>(move |items, _, cx| {
                            super::drop_links(&link_dropper, items, cx)
                        })
                        .child(
                            div()
                                .id(SharedString::from(format!(
                                    "bookmark-folder-scroll-{}",
                                    panel.level
                                )))
                                .max_h(px((max_height - footer_room).max(fit::MENU_ROW * 3.0)))
                                .overflow_y_scroll()
                                .track_scroll(&scroll)
                                .py(px(fit::ROW_INSET))
                                .child(rows)
                                .children(empty)
                                .when(tail_line, |this| {
                                    this.child(
                                        div().relative().h(px(0.)).child(
                                            div()
                                                .absolute()
                                                .left(px(fit::ROW_INSET + fit::ROW_PADDING))
                                                .right(px(fit::ROW_INSET + fit::ROW_PADDING))
                                                .top(px(fit::MENU_ROW / 2.0 - fit::DROP_LINE / 2.0))
                                                .h(px(fit::DROP_LINE))
                                                .rounded(px(1.))
                                                .bg(p.accent),
                                        ),
                                    )
                                }),
                        )
                        .children(footer),
                    ),
            )
            .with_priority(4 + panel.level)
            .into_any_element(),
        );
    }
    if animating {
        window.request_animation_frame();
    }
    out
}
