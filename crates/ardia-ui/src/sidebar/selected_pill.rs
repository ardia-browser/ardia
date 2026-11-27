use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::TabId;
use ardia_theme::layout::sidebar;
use gpui::{
    AnchoredPositionMode, AnyElement, Hsla, IntoElement, MouseButton, ParentElement, Pixels,
    Styled, anchored, deferred, div, point, prelude::*,
};

use crate::primitives::controls::shadow;
use crate::primitives::favicon::render_favicon;
use crate::primitives::icons::{Icon, icon};
use crate::sidebar::{list_motion, row_look, scroll_edge};
use crate::window::chrome::Chrome;

pub const HEIGHT: f32 = 28.0;
pub const GAP: f32 = 6.0;
pub const ICON: f32 = 16.0;
pub const PAD_LEFT: f32 = 10.0;
pub const PAD_RIGHT: f32 = 9.0;
pub const ICON_GAP: f32 = 6.0;
pub const ARROW: f32 = 10.0;
pub const ENTER_SCALE_RISE: f32 = 18.0;
pub const EXIT_DROP: f32 = 4.0;
pub const ENTER_MS: u64 = 140;
pub const ENTER_SCALE: f32 = 0.3;
pub const EXIT_SCALE: f32 = 0.8;
pub const EXIT_MS: u64 = 60;
pub const SETTLE_MS: u64 = 400;
pub const REVEAL_MARGIN: f32 = 6.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Above,
    Below,
}

impl Side {
    fn outward(self) -> f32 {
        match self {
            Side::Above => -1.0,
            Side::Below => 1.0,
        }
    }
}

pub fn row_away(row_top: f32, row_height: f32, view_top: f32, view_bottom: f32) -> Option<Side> {
    if view_bottom <= view_top {
        return None;
    }
    if row_top + row_height <= view_top {
        Some(Side::Above)
    } else if row_top >= view_bottom {
        Some(Side::Below)
    } else {
        None
    }
}

#[derive(Clone, Debug, Default)]
struct PillState {
    shown: Option<(Side, TabId, Instant)>,
    leaving: Option<(Side, TabId, Instant)>,
    selected: Option<TabId>,
    quiet_until: Option<Instant>,
}

thread_local! {
    static PILLS: RefCell<HashMap<String, PillState>> = RefCell::new(HashMap::new());
}

pub fn enter_progress(t: f32) -> (f32, f32) {
    let eased = 1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(2);
    let opacity = if eased < 0.4 {
        eased / 0.4 * 0.85
    } else {
        0.85 + (eased - 0.4) / 0.6 * 0.15
    };
    (opacity, 1.0 - eased)
}

pub fn exit_progress(t: f32) -> (f32, f32) {
    let left = 1.0 - t.clamp(0.0, 1.0);
    let opacity = if left < 0.3 {
        left / 0.3 * 0.8
    } else {
        0.8 + (left - 0.3) / 0.7 * 0.2
    };
    (opacity, 1.0 - left)
}

fn page_key(c: &Chrome) -> String {
    format!("{}:{}", c.window.id, c.window.profile_id)
}

pub fn selected_row_pill(c: &Chrome) -> Option<AnyElement> {
    let window_key = c.window.id.as_str().to_owned();
    let handle = scroll_edge::handle(&page_key(c));
    let view = handle.bounds();
    let scale = crate::scale::current();
    let active = c.active.map(|t| t.id.clone());
    let now = Instant::now();
    let side = active.as_ref().and_then(|tab| {
        let top = list_motion::row_top(&window_key, tab)?;
        row_away(
            top,
            sidebar::row_height() * scale,
            f32::from(view.origin.y),
            f32::from(view.bottom()),
        )
    });
    let (shown, leaving) = PILLS.with(|cell| {
        let mut pills = cell.borrow_mut();
        let state = pills.entry(window_key.clone()).or_default();
        if state.selected != active {
            if state.selected.is_some() {
                state.quiet_until = Some(now + Duration::from_millis(SETTLE_MS));
            }
            state.selected = active.clone();
        }
        let quiet = state.quiet_until.is_some_and(|until| now < until);
        let wanted = if quiet {
            None
        } else {
            side.zip(active.clone())
        };
        match (&state.shown, wanted) {
            (Some((s, t, _)), Some((side, tab))) if *s == side && *t == tab => {}
            (_, Some((side, tab))) => state.shown = Some((side, tab, now)),
            (Some(shown), None) => {
                state.leaving = Some((shown.0, shown.1.clone(), now));
                state.shown = None;
            }
            (None, None) => {}
        }
        if state
            .leaving
            .as_ref()
            .is_some_and(|(_, _, at)| at.elapsed() >= Duration::from_millis(EXIT_MS))
        {
            state.leaving = None;
        }
        (state.shown.clone(), state.leaving.clone())
    });
    let quiet_pending = PILLS.with(|cell| {
        cell.borrow()
            .get(&window_key)
            .and_then(|s| s.quiet_until)
            .is_some_and(|until| now < until)
    });
    let (side, tab, since, entering) = match (shown, leaving) {
        (Some((side, tab, since)), _) => (side, tab, since, true),
        (None, Some((side, tab, since))) => (side, tab, since, false),
        (None, None) => {
            return quiet_pending.then(crate::sidebar::tab_row::frame_pump);
        }
    };
    let tab = c.state.tab(tab.as_str())?.clone();
    let elapsed = since.elapsed().as_secs_f32() * 1000.0;
    let (opacity, travel, scale_now, running) = if entering {
        let t = elapsed / ENTER_MS as f32;
        let (o, rest) = enter_progress(t);
        (
            o,
            rest * ENTER_SCALE_RISE * side.outward(),
            1.0 - rest * (1.0 - ENTER_SCALE),
            t < 1.0,
        )
    } else {
        let t = elapsed / EXIT_MS as f32;
        let (o, gone) = exit_progress(t);
        (
            o,
            gone * EXIT_DROP * side.outward(),
            1.0 - gone * (1.0 - EXIT_SCALE),
            t < 1.0,
        )
    };
    let tokens_dark = c.p.dark;
    let fill: Hsla = if tokens_dark {
        gpui::rgb(0x141617).into()
    } else {
        Hsla::white()
    };
    let stroke = if tokens_dark {
        Hsla::white().opacity(0.1)
    } else {
        Hsla::black().opacity(0.1)
    };
    let width = PAD_LEFT + ICON + ICON_GAP + ARROW + PAD_RIGHT;
    let x = f32::from(view.center().x) - width * scale / 2.0;
    let y = match side {
        Side::Above => f32::from(view.origin.y) + GAP * scale,
        Side::Below => f32::from(view.bottom()) - (GAP + HEIGHT) * scale,
    } + travel * scale;
    let marks = row_look::row_marks(c.state, &tab);
    let favicon = c.favicon(&tab);
    let reveal_handle = handle;
    let reveal_key = window_key;
    let reveal_tab = tab.id.clone();
    let face = div()
        .id("selected-row-pill")
        .debug_selector(|| "selected-row-pill".into())
        .occlude()
        .h(px(HEIGHT))
        .pl(px(PAD_LEFT))
        .pr(px(PAD_RIGHT))
        .rounded(px(HEIGHT / 2.0))
        .bg(fill)
        .border(px(0.5))
        .border_color(stroke)
        .shadow(vec![shadow(
            Hsla::black().opacity(if tokens_dark { 0.3 } else { 0.1 }),
            2.,
            12.,
        )])
        .opacity(opacity)
        .scale(scale_now)
        .flex()
        .items_center()
        .gap(px(ICON_GAP))
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, _| {
            reveal(&reveal_handle, &reveal_key, &reveal_tab);
            window.refresh();
        })
        .child(
            div()
                .when(marks.faded, |d| d.opacity(row_look::SLEEPING_ICON_OPACITY))
                .child(render_favicon(&favicon, ICON, c.p)),
        )
        .child(
            div()
                .w(px(ARROW))
                .h(px(ARROW + 2.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(
                    match side {
                        Side::Above => Icon::ArrowUp,
                        Side::Below => Icon::ArrowDown,
                    },
                    ARROW,
                    c.p.text_secondary,
                )),
        )
        .when(running || quiet_pending, |d| {
            d.child(crate::sidebar::tab_row::frame_pump())
        });
    Some(
        deferred(
            anchored()
                .position_mode(AnchoredPositionMode::Window)
                .position(point(gpui::px(x), gpui::px(y)))
                .child(face),
        )
        .with_priority(1)
        .into_any_element(),
    )
}

pub fn reveal_offset(
    row_top: f32,
    row_height: f32,
    view_top: f32,
    view_bottom: f32,
    offset: f32,
    margin: f32,
) -> f32 {
    if row_top < view_top + margin {
        offset + (view_top + margin - row_top)
    } else if row_top + row_height > view_bottom - margin {
        offset - (row_top + row_height - (view_bottom - margin))
    } else {
        offset
    }
}

fn reveal(handle: &gpui::ScrollHandle, window_key: &str, tab: &TabId) {
    let Some(top) = list_motion::row_top(window_key, tab) else {
        return;
    };
    let scale = crate::scale::current();
    let view = handle.bounds();
    let offset = f32::from(handle.offset().y);
    let next = reveal_offset(
        top,
        sidebar::row_height() * scale,
        f32::from(view.origin.y),
        f32::from(view.bottom()),
        offset,
        REVEAL_MARGIN * scale,
    );
    let max = f32::from(handle.max_offset().y);
    let clamped = next.clamp(-max, 0.0);
    handle.set_offset(point(handle.offset().x, Pixels::from(clamped)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_is_away_only_when_wholly_outside_the_viewport() {
        assert_eq!(row_away(0., 34., 100., 400.), Some(Side::Above));
        assert_eq!(row_away(80., 34., 100., 400.), None);
        assert_eq!(row_away(400., 34., 100., 400.), Some(Side::Below));
        assert_eq!(row_away(380., 34., 100., 400.), None);
        assert_eq!(row_away(0., 34., 100., 100.), None);
    }

    #[test]
    fn revealing_scrolls_the_row_just_inside_the_margin() {
        assert_eq!(reveal_offset(50., 34., 100., 400., -200., 6.), -144.);
        assert_eq!(reveal_offset(450., 34., 100., 400., -200., 6.), -290.);
        assert_eq!(reveal_offset(200., 34., 100., 400., -200., 6.), -200.);
    }

    #[test]
    fn the_pill_rises_in_and_drops_out() {
        assert_eq!(enter_progress(0.0), (0.0, 1.0));
        let (o, rest) = enter_progress(1.0);
        assert!((o - 1.0).abs() < 1e-5 && rest.abs() < 1e-5);
        assert_eq!(exit_progress(0.0).0, 1.0);
        assert_eq!(exit_progress(1.0).0, 0.0);
    }
}
