use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::TabId;
use gpui::{
    AnyElement, App, Global, Hsla, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement, RenderOnce, Styled, Window, WindowId, div, prelude::*,
};

use crate::content::drag_card::{CardFrame, card_frame, drag_card};
use crate::content::split_view::{
    DropContext, drop_actions, drop_preview, drop_rules, pane_drop_target, stacked_panes,
};
use crate::msg::{Emit, Msg};
use crate::primitives::icons::{Icon, icon};
use crate::window::layout::Rect;

pub const PANE_DRAG_SLOP: f32 = 10.0;
pub const CLICK_AFTER_DRAG: Duration = Duration::from_millis(300);

#[derive(Clone, Debug, PartialEq)]
pub struct PaneButtonLook {
    pub size: f32,
    pub radius: f32,
    pub glyph: Icon,
    pub glyph_size: f32,
    pub fill: Hsla,
    pub ink: Hsla,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PaneDrag {
    pub tab: TabId,
    pub start: [f32; 2],
    pub at: [f32; 2],
    pub moving: bool,
    pub look: PaneButtonLook,
    pub landing: crate::content::split_view::LandingPresence,
    pub card: crate::content::drag_card::CardMotion,
}

#[derive(Default)]
pub struct PaneDrags {
    drags: HashMap<WindowId, PaneDrag>,
    pictures: HashMap<WindowId, std::sync::Arc<gpui::RenderImage>>,
    clicks_ignored_until: HashMap<WindowId, Instant>,
}

impl Global for PaneDrags {}

pub fn past_slop(start: [f32; 2], at: [f32; 2]) -> bool {
    (at[0] - start[0]).hypot(at[1] - start[1]) > PANE_DRAG_SLOP
}

fn window_key(window: &Window) -> WindowId {
    window.window_handle().window_id()
}

pub fn press(
    tab: TabId,
    look: PaneButtonLook,
    event: &MouseDownEvent,
    window: &mut Window,
    cx: &mut App,
) {
    let (x, y) = crate::scale::logical_point(event.position);
    let key = window_key(window);
    cx.default_global::<PaneDrags>().drags.insert(
        key,
        PaneDrag {
            tab,
            start: [x, y],
            at: [x, y],
            moving: false,
            look,
            landing: Default::default(),
            card: Default::default(),
        },
    );
    window.refresh();
}

pub fn click_allowed(window: &Window, cx: &App) -> bool {
    let key = window_key(window);
    cx.try_global::<PaneDrags>()
        .and_then(|drags| drags.clicks_ignored_until.get(&key))
        .is_none_or(|until| Instant::now() >= *until)
}

pub fn cancel(window: &mut Window, cx: &mut App) -> bool {
    let key = window_key(window);
    let Some(drags) = cx.try_global::<PaneDrags>() else {
        return false;
    };
    if !drags.drags.contains_key(&key) {
        return false;
    }
    let drags = cx.global_mut::<PaneDrags>();
    drags.pictures.remove(&key);
    let was_moving = drags.drags.remove(&key).is_some_and(|drag| drag.moving);
    if was_moving {
        drags
            .clicks_ignored_until
            .insert(key, Instant::now() + CLICK_AFTER_DRAG);
    }
    window.refresh();
    true
}

pub fn current(window: &Window, cx: &App) -> Option<PaneDrag> {
    cx.try_global::<PaneDrags>()
        .and_then(|drags| drags.drags.get(&window_key(window)).cloned())
}

fn track(event: &MouseMoveEvent, window: &mut Window, cx: &mut App) {
    let (x, y) = crate::scale::logical_point(event.position);
    let key = window_key(window);
    let Some(drag) = cx.default_global::<PaneDrags>().drags.get_mut(&key) else {
        return;
    };
    drag.at = [x, y];
    let started = !drag.moving && past_slop(drag.start, drag.at);
    if started {
        drag.moving = true;
    }
    if started && let Some(picture) = crate::content::drag_card::snapshot_window(window) {
        cx.default_global::<PaneDrags>()
            .pictures
            .insert(key, picture);
    }
    window.refresh();
}

#[derive(IntoElement)]
pub struct PaneDragLayer {
    pub panes: Vec<(TabId, Rect)>,
    pub page: Rect,
    pub viewport: [f32; 2],
    pub ctx: Arc<DropContext>,
    pub emit: Emit,
    pub card: Option<crate::content::drag_card::DragCard>,
}

pub fn landing(
    ctx: &DropContext,
    panes: &[(TabId, Rect)],
    page: Rect,
    drag: &PaneDrag,
) -> Option<crate::content::split_view::PaneDrop> {
    if !drag.moving {
        return None;
    }
    let rules = drop_rules(ctx, panes, &drag.tab)?;
    pane_drop_target(
        &rules.candidates,
        drag.at[0] - page.x,
        drag.at[1] - page.y,
        None,
        rules.sides,
    )
}

impl RenderOnce for PaneDragLayer {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let Some(drag) = current(window, cx) else {
            return div().id("pane-drag-layer");
        };
        let now = Instant::now();
        let target = landing(&self.ctx, &self.panes, self.page, &drag);
        let wanted = target.as_ref().and_then(|target| {
            let pane = self.panes.iter().find(|(t, _)| *t == target.tab)?.1;
            let from = self
                .panes
                .iter()
                .find(|(t, _)| *t == drag.tab)
                .map(|(_, r)| *r);
            Some((
                crate::content::split_view::drop_preview_rect(pane, target.side),
                target.side,
                from.is_some_and(|from| stacked_panes(from, pane)),
            ))
        });
        let on_page = drag.moving
            && drag.at[0] >= self.page.x
            && drag.at[1] >= self.page.y
            && drag.at[0] <= self.page.right()
            && drag.at[1] <= self.page.y + self.page.h;
        let key = window_key(window);
        let (preview, card_progress, animating) = {
            let drags = cx.default_global::<PaneDrags>();
            let Some(live) = drags.drags.get_mut(&key) else {
                return div().id("pane-drag-layer");
            };
            live.landing.aim(wanted, now);
            live.card.aim(on_page && target.is_none(), now);
            (
                live.landing.visible(now),
                live.card.progress(now),
                live.landing.moving(now) || live.card.moving(now),
            )
        };
        if animating {
            window.request_animation_frame();
        }
        let preview = preview.map(|((rect, side, stacked), appear)| {
            drop_preview(rect, side, stacked).opacity(appear)
        });
        let (panes, page, ctx, emit) = (self.panes, self.page, self.ctx, self.emit);
        let look = drag.look.clone();
        let picture = cx
            .try_global::<PaneDrags>()
            .and_then(|drags| drags.pictures.get(&key).cloned());
        let card = self.card.map(|mut card| {
            card.shown = Some(drag.tab.clone());
            card.window_picture = picture;
            card
        });
        let ghost = drag.moving.then(|| {
            let button = div()
                .size(px(look.size))
                .rounded(px(look.radius))
                .bg(look.fill)
                .flex()
                .items_center()
                .justify_center()
                .child(icon(look.glyph, look.glyph_size, look.ink));
            let pill = CardFrame {
                x: -look.size / 2.0,
                y: -look.size / 2.0,
                w: look.size,
                h: look.size,
            };
            let face = match (card_progress, card.as_ref()) {
                (Some(progress), Some(card)) if progress > 0.0 => {
                    drag_card(card, card_frame(pill, [0.0, 0.0], progress)).into_any_element()
                }
                (None, _) if target.is_some() => div().into_any_element(),
                _ => div()
                    .absolute()
                    .left(px(pill.x))
                    .top(px(pill.y))
                    .child(button)
                    .into_any_element(),
            };
            div()
                .id("pane-drag-ghost")
                .debug_selector(|| "pane-drag-ghost".into())
                .absolute()
                .left(px(drag.at[0]))
                .top(px(drag.at[1]))
                .size_0()
                .child(face)
        });
        div()
            .id("pane-drag-layer")
            .debug_selector(|| "pane-drag-layer".into())
            .absolute()
            .left(px(-page.x))
            .top(px(-page.y))
            .w(px(self.viewport[0]))
            .h(px(self.viewport[1]))
            .on_mouse_move(track)
            .on_mouse_up(MouseButton::Left, move |_: &MouseUpEvent, window, cx| {
                let key = window_key(window);
                cx.default_global::<PaneDrags>().pictures.remove(&key);
                let Some(drag) = cx.default_global::<PaneDrags>().drags.remove(&key) else {
                    return;
                };
                if drag.moving {
                    cx.default_global::<PaneDrags>()
                        .clicks_ignored_until
                        .insert(key, Instant::now() + CLICK_AFTER_DRAG);
                    if let Some(target) = landing(&ctx, &panes, page, &drag) {
                        super::split_view::note_drop(&drag.tab, &target, &panes);
                        let actions = drop_actions(&drag.tab, &target);
                        crate::primitives::haptics::tick_for_swaps(&actions);
                        if !actions.is_empty() {
                            emit.send(Msg::Stores(actions), window, cx);
                        }
                    }
                }
                window.refresh();
            })
            .when_some(preview, |this, preview| {
                this.child(
                    div()
                        .absolute()
                        .left(px(page.x))
                        .top(px(page.y))
                        .w(px(page.w))
                        .h(px(page.h))
                        .child(preview),
                )
            })
            .children(ghost)
    }
}

pub fn pane_drag_layer(
    panes: Vec<(TabId, Rect)>,
    page: Rect,
    viewport: [f32; 2],
    ctx: Arc<DropContext>,
    emit: Emit,
    card: Option<crate::content::drag_card::DragCard>,
) -> AnyElement {
    PaneDragLayer {
        panes,
        page,
        viewport,
        ctx,
        emit,
        card,
    }
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drag(at: [f32; 2], moving: bool) -> PaneDrag {
        PaneDrag {
            tab: TabId::new("a"),
            start: [100.0, 20.0],
            at,
            moving,
            landing: Default::default(),
            card: Default::default(),
            look: PaneButtonLook {
                size: 30.0,
                radius: 7.0,
                glyph: Icon::Split,
                glyph_size: 13.0,
                fill: gpui::black(),
                ink: gpui::white(),
            },
        }
    }

    #[test]
    fn the_landing_follows_the_pointer_only_once_moving() {
        let page = Rect::new(200.0, 40.0, 1000.0, 600.0);
        let panes = vec![
            (TabId::new("a"), Rect::new(0.0, 0.0, 496.0, 600.0)),
            (TabId::new("b"), Rect::new(504.0, 0.0, 496.0, 600.0)),
        ];
        let ctx = DropContext {
            droppable: [TabId::new("a"), TabId::new("b")].into_iter().collect(),
            recent: vec![TabId::new("a"), TabId::new("b")],
        };
        assert_eq!(
            landing(&ctx, &panes, page, &drag([1190.0, 300.0], false)),
            None
        );
        let right = landing(&ctx, &panes, page, &drag([1190.0, 300.0], true)).expect("a target");
        assert_eq!(right.tab, TabId::new("b"));
        assert_eq!(right.side, crate::content::split_view::PaneDropSide::Right);
        let centre = landing(&ctx, &panes, page, &drag([952.0, 340.0], true)).expect("a target");
        assert_eq!(
            centre.side,
            crate::content::split_view::PaneDropSide::Center
        );
    }

    #[test]
    fn a_pane_drag_starts_past_ten_points() {
        assert!(!past_slop([0.0, 0.0], [6.0, 8.0]));
        assert!(!past_slop([0.0, 0.0], [10.0, 0.0]));
        assert!(past_slop([0.0, 0.0], [7.1, 7.1]));
    }
}
