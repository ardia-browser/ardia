mod buttons;
mod forms;
mod menu;
mod surfaces;

use std::rc::Rc;

use gpui::{App, ClickEvent, Window};

pub use buttons::*;
pub use forms::*;
pub use menu::*;
pub use surfaces::*;

pub type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
pub type ValueHandler<T> = Rc<dyn Fn(T, &mut Window, &mut App)>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slider_values_clamp_and_snap_to_steps() {
        assert_eq!(slider_value(50.0, 0.0, 100.0, None), 0.5);
        assert_eq!(slider_value(-20.0, 0.0, 100.0, None), 0.0);
        assert_eq!(slider_value(500.0, 0.0, 100.0, None), 1.0);
        assert_eq!(slider_value(52.0, 0.0, 100.0, Some(12)), 6.0 / 12.0);
        assert_eq!(slider_value(10.0, 0.0, 0.0, Some(12)), 0.0);
        assert_eq!(slider_value(f32::NAN, 0.0, 10.0, None), 0.0);
    }
}
