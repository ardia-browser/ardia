use std::cell::RefCell;
use std::collections::HashMap;

use crate::scale::px;
use gpui::{AnyElement, CursorStyle, IntoElement, MouseButton, Styled, div, prelude::*};

use crate::msg::{Emit, Msg};
use crate::primitives::controls::EmptyDrag;
use crate::window::layout::Rect;

pub const BAND: f32 = 36.0;
pub const BAND_SCALE: f32 = 90.0;

pub fn band(over: f32) -> f32 {
    BAND * (1.0 - (-over / BAND_SCALE).exp())
}

pub fn unband(stretch: f32) -> f32 {
    -BAND_SCALE * (1.0 - stretch.min(BAND - 0.01) / BAND).ln()
}

pub fn rubber_band(width: f32, min: f32, max: f32) -> f32 {
    if width > max {
        max + band(width - max)
    } else if width < min {
        min - band(min - width)
    } else {
        width
    }
}

pub fn unstretch(width: f32, min: f32, max: f32) -> f32 {
    if width > max {
        max + unband(width - max)
    } else if width < min {
        min - unband(min - width)
    } else {
        width
    }
}

pub fn kept_width(dragged: f32, limit: f32, saved: f32) -> f32 {
    if dragged >= limit {
        dragged.max(saved)
    } else {
        dragged
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Grab {
    from_edge: f32,
}

thread_local! {
    static GRABS: RefCell<HashMap<String, Grab>> = RefCell::new(HashMap::new());
}

pub struct SidebarResizeDrag;

pub struct HandleSpec {
    pub window: String,
    pub rect: Rect,
    pub trailing: bool,
    pub sidebar_x: f32,
    pub sidebar_width: f32,
}

pub fn resize_handle(emit: &Emit, spec: HandleSpec) -> AnyElement {
    let HandleSpec {
        window: key,
        rect,
        trailing,
        sidebar_x,
        sidebar_width,
    } = spec;
    let move_emit = emit.clone();
    let up_emit = emit.clone();
    let out_emit = emit.clone();
    let reset_emit = emit.clone();
    let down_key = key.clone();
    let move_key = key;
    div()
        .id("sidebar-resize")
        .debug_selector(|| "sidebar-resize".into())
        .absolute()
        .left(px(rect.x))
        .top(px(rect.y))
        .w(px(rect.w))
        .h(px(rect.h))
        .cursor(CursorStyle::ResizeLeftRight)
        .on_mouse_down(MouseButton::Left, move |event, window, cx| {
            if event.click_count >= 2 {
                reset_emit.send(
                    Msg::Store(ardia_state::Action::UpdateSettings {
                        patch: ardia_state::settings::SettingsPatch::new().set(
                            "sidebarWidth",
                            f64::from(ardia_theme::layout::DEFAULT_SIDEBAR_WIDTH),
                        ),
                        from_sync: false,
                    }),
                    window,
                    cx,
                );
                return;
            }
            let x = crate::scale::points(event.position.x);
            let edge = if trailing {
                sidebar_x
            } else {
                sidebar_x + sidebar_width
            };
            let from_edge = if trailing { edge - x } else { x - edge };
            GRABS.with(|g| g.borrow_mut().insert(down_key.clone(), Grab { from_edge }));
        })
        .on_drag(SidebarResizeDrag, |_, _, _, cx| cx.new(|_| EmptyDrag))
        .on_drag_move(
            move |event: &gpui::DragMoveEvent<SidebarResizeDrag>, window, cx| {
                let x = crate::scale::points(event.event.position.x);
                let grab = GRABS.with(|g| g.borrow().get(&move_key).copied().unwrap_or_default());
                let width = if trailing {
                    crate::scale::points(window.viewport_size().width) - x - grab.from_edge
                } else {
                    x - sidebar_x - grab.from_edge
                };
                move_emit.send(Msg::SidebarWidth(width.max(0.0)), window, cx);
            },
        )
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            up_emit.send(Msg::SidebarResized, window, cx)
        })
        .on_mouse_up_out(MouseButton::Left, move |_, window, cx| {
            out_emit.send(Msg::SidebarResized, window, cx)
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_width_stretches_past_its_limits_with_resistance() {
        assert_eq!(rubber_band(250.0, 160.0, 400.0), 250.0);
        let past = rubber_band(490.0, 160.0, 400.0);
        assert!(past > 400.0 && past < 400.0 + BAND);
        let under = rubber_band(100.0, 160.0, 400.0);
        assert!(under < 160.0 && under > 160.0 - BAND);
    }

    #[test]
    fn unstretch_undoes_the_band() {
        let stretched = rubber_band(450.0, 160.0, 400.0);
        assert!((unstretch(stretched, 160.0, 400.0) - 450.0).abs() < 0.01);
    }

    #[test]
    fn a_saved_width_past_the_window_limit_is_kept() {
        assert_eq!(kept_width(300.0, 400.0, 500.0), 300.0);
        assert_eq!(kept_width(400.0, 400.0, 500.0), 500.0);
        assert_eq!(kept_width(400.0, 400.0, 350.0), 400.0);
    }
}
