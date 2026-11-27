use std::cell::Cell;

use ardia_state::BrowserState;
use ardia_state::settings::{INTERFACE_SCALE_MAX, INTERFACE_SCALE_MIN};
use gpui::{App, Pixels, Point, Size};

thread_local! {
    static INTERFACE_SCALE: Cell<f32> = const { Cell::new(1.0) };
}

pub fn sanitize(value: f64) -> f32 {
    if value.is_finite() {
        value.clamp(INTERFACE_SCALE_MIN, INTERFACE_SCALE_MAX) as f32
    } else {
        1.0
    }
}

pub fn current() -> f32 {
    INTERFACE_SCALE.with(Cell::get)
}

pub fn set(scale: f32) -> bool {
    let scale = sanitize(f64::from(scale));
    INTERFACE_SCALE.with(|cell| {
        let changed = (cell.get() - scale).abs() > f32::EPSILON;
        cell.set(scale);
        changed
    })
}

pub fn sync(state: &BrowserState, cx: &mut App) -> bool {
    let scaled = set(sanitize(state.settings.interface_scale));
    let cornered = crate::sidebar::row_look::sync_chrome_radius(
        state.settings.tab_corner_radius,
        state.settings.minimalism_mode,
    );
    let metered = ardia_theme::layout::sidebar::set_row_metrics(
        ardia_theme::layout::sidebar::RowMetrics::of(
            state.settings.minimalism_mode,
            state.settings.sidebar_text_size,
        ),
    );
    crate::primitives::haptics::set_reorder_haptics(state.settings.tab_reorder_haptics);
    let changed = scaled || cornered || metered;
    if changed {
        cx.refresh_windows();
    }
    changed
}

pub fn px(points: f32) -> Pixels {
    gpui::px(points * current())
}

pub fn points(real: Pixels) -> f32 {
    f32::from(real) / current()
}

pub fn logical_size(real: Size<Pixels>) -> (f32, f32) {
    (points(real.width), points(real.height))
}

pub fn logical_point(real: Point<Pixels>) -> (f32, f32) {
    (points(real.x), points(real.y))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_scale_into_pixels_and_back() {
        set(1.0);
        assert_eq!(px(10.0), gpui::px(10.0));
        assert!(set(1.5));
        assert!(!set(1.5));
        assert_eq!(px(10.0), gpui::px(15.0));
        assert_eq!(points(gpui::px(15.0)), 10.0);
        assert_eq!(
            logical_size(gpui::size(gpui::px(300.0), gpui::px(150.0))),
            (200.0, 100.0)
        );
        set(9.0);
        assert_eq!(current(), INTERFACE_SCALE_MAX as f32);
        set(f32::NAN);
        assert_eq!(current(), 1.0);
        set(1.0);
    }
}
