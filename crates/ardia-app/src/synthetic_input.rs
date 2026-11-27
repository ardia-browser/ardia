use gpui::{
    KeyDownEvent, KeyUpEvent, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, OperatingSystem, PlatformInput, ScrollDelta, ScrollEvent, TouchPhase, point, px,
};
use serde_json::Value;

pub const TEST_INPUT_ENV: &str = "ARDIA_TEST_INPUT";
pub const MAX_STEPS: usize = 256;

pub const SETTINGS_WINDOW: &str = "settings";
pub const ONBOARDING_WINDOW: &str = "onboarding";
pub const RECORDING_PILL_WINDOW: &str = "recording-pill";

pub fn enabled() -> bool {
    std::env::var(TEST_INPUT_ENV).is_ok_and(|value| value == "1")
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    Move {
        x: f32,
        y: f32,
        pressed: Option<MouseButton>,
        modifiers: Modifiers,
    },
    Down {
        x: f32,
        y: f32,
        button: MouseButton,
        clicks: usize,
        modifiers: Modifiers,
    },
    Up {
        x: f32,
        y: f32,
        button: MouseButton,
        clicks: usize,
        modifiers: Modifiers,
    },
    Scroll {
        x: f32,
        y: f32,
        dx: f32,
        dy: f32,
        modifiers: Modifiers,
        phase: gpui::ScrollPhase,
    },
    NativeScroll(NativeScroll),
    KeyDown(Keystroke),
    KeyUp(Keystroke),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NativeScroll {
    pub x: f32,
    pub y: f32,
    pub dx: f32,
    pub dy: f32,
    pub phase: gpui::ScrollPhase,
    pub momentum: gpui::ScrollPhase,
}

impl Step {
    pub fn native(&self) -> Option<NativeScroll> {
        match self {
            Step::NativeScroll(scroll) => Some(*scroll),
            _ => None,
        }
    }
}

fn scroll_phase(action: &Value, key: &str) -> Result<gpui::ScrollPhase, String> {
    Ok(match action.get(key).and_then(Value::as_str) {
        None | Some("none") => gpui::ScrollPhase::None,
        Some("may_begin" | "mayBegin") => gpui::ScrollPhase::MayBegin,
        Some("began") => gpui::ScrollPhase::Began,
        Some("changed") => gpui::ScrollPhase::Changed,
        Some("ended") => gpui::ScrollPhase::Ended,
        Some("cancelled") => gpui::ScrollPhase::Cancelled,
        Some(other) => return Err(format!("unknown scroll phase {other}")),
    })
}

impl Step {
    pub fn into_platform_input(self) -> PlatformInput {
        match self {
            Step::Move {
                x,
                y,
                pressed,
                modifiers,
            } => PlatformInput::MouseMove(MouseMoveEvent {
                position: point(px(x), px(y)),
                pressed_button: pressed,
                modifiers,
            }),
            Step::Down {
                x,
                y,
                button,
                clicks,
                modifiers,
            } => PlatformInput::MouseDown(MouseDownEvent {
                button,
                position: point(px(x), px(y)),
                modifiers,
                click_count: clicks,
                first_mouse: false,
            }),
            Step::Up {
                x,
                y,
                button,
                clicks,
                modifiers,
            } => PlatformInput::MouseUp(MouseUpEvent {
                button,
                position: point(px(x), px(y)),
                modifiers,
                click_count: clicks,
            }),
            Step::Scroll {
                x,
                y,
                dx,
                dy,
                modifiers,
                phase,
            } => PlatformInput::Scroll(ScrollEvent {
                position: point(px(x), px(y)),
                delta: ScrollDelta::Pixels(point(px(dx), px(dy))),
                modifiers,
                touch_phase: match phase {
                    gpui::ScrollPhase::Began | gpui::ScrollPhase::MayBegin => {
                        TouchPhase::Started
                    }
                    gpui::ScrollPhase::Ended | gpui::ScrollPhase::Cancelled => TouchPhase::Ended,
                    _ => TouchPhase::Moved,
                },
                gesture_phase: phase,
                ..ScrollEvent::default()
            }),
            Step::NativeScroll(scroll) => PlatformInput::Scroll(ScrollEvent {
                position: point(px(scroll.x), px(scroll.y)),
                delta: ScrollDelta::Pixels(point(px(scroll.dx), px(scroll.dy))),
                gesture_phase: scroll.phase,
                momentum_phase: scroll.momentum,
                ..ScrollEvent::default()
            }),
            Step::KeyDown(keystroke) => PlatformInput::KeyDown(KeyDownEvent {
                keystroke,
                is_held: false,
                prefer_character_input: false,
            }),
            Step::KeyUp(keystroke) => PlatformInput::KeyUp(KeyUpEvent { keystroke }),
        }
    }
}

fn number(action: &Value, key: &str) -> Result<f32, String> {
    action
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && value.abs() <= 100_000.0)
        .map(|value| value as f32)
        .ok_or_else(|| format!("{key} must be a finite number"))
}

fn optional_number(action: &Value, key: &str) -> Result<f32, String> {
    match action.get(key) {
        None | Some(Value::Null) => Ok(0.0),
        Some(_) => number(action, key),
    }
}

fn button(action: &Value) -> Result<MouseButton, String> {
    match action
        .get("button")
        .and_then(Value::as_str)
        .unwrap_or("left")
    {
        "left" => Ok(MouseButton::Left),
        "right" => Ok(MouseButton::Right),
        "middle" => Ok(MouseButton::Middle),
        other => Err(format!("unknown button {other}")),
    }
}

fn clicks(action: &Value) -> Result<usize, String> {
    match action.get("clicks") {
        None | Some(Value::Null) => Ok(1),
        Some(value) => value
            .as_u64()
            .filter(|count| (1..=3).contains(count))
            .map(|count| count as usize)
            .ok_or_else(|| "clicks must be 1, 2 or 3".to_owned()),
    }
}

fn keystroke(text: &str) -> Result<Keystroke, String> {
    if text.is_empty() || text.len() > 64 {
        return Err("key must be 1-64 characters".to_owned());
    }
    Keystroke::parse_with_os(text, OperatingSystem::Mac).map_err(|problem| problem.to_string())
}

fn typed_keystroke(character: char) -> Keystroke {
    let key = match character {
        ' ' => "space".to_owned(),
        '\n' => "enter".to_owned(),
        '\t' => "tab".to_owned(),
        other => other.to_lowercase().to_string(),
    };
    Keystroke {
        modifiers: Modifiers {
            shift: character.is_uppercase(),
            ..Modifiers::default()
        },
        key,
        key_char: (!matches!(character, '\n' | '\t')).then(|| character.to_string()),
    }
}

fn modifiers(action: &Value) -> Result<Modifiers, String> {
    match action.get("mods").and_then(Value::as_str) {
        None | Some("") => Ok(Modifiers::default()),
        Some(mods) => keystroke(&format!("{mods}-a")).map(|parsed| parsed.modifiers),
    }
}

fn parse_action(action: &Value, steps: &mut Vec<Step>) -> Result<(), String> {
    let kind = action
        .get("type")
        .and_then(Value::as_str)
        .ok_or("every action needs a type")?;
    let mods = modifiers(action)?;
    match kind {
        "move" => steps.push(Step::Move {
            x: number(action, "x")?,
            y: number(action, "y")?,
            pressed: None,
            modifiers: mods,
        }),
        "drag" => steps.push(Step::Move {
            x: number(action, "x")?,
            y: number(action, "y")?,
            pressed: Some(button(action)?),
            modifiers: mods,
        }),
        "down" | "up" | "click" => {
            let (x, y, button, clicks) = (
                number(action, "x")?,
                number(action, "y")?,
                button(action)?,
                clicks(action)?,
            );
            if kind == "click" {
                steps.push(Step::Move {
                    x,
                    y,
                    pressed: None,
                    modifiers: mods,
                });
            }
            if kind != "up" {
                steps.push(Step::Down {
                    x,
                    y,
                    button,
                    clicks,
                    modifiers: mods,
                });
            }
            if kind != "down" {
                steps.push(Step::Up {
                    x,
                    y,
                    button,
                    clicks,
                    modifiers: mods,
                });
            }
        }
        "scroll" if action.get("native").and_then(Value::as_bool) == Some(true) => {
            steps.push(Step::NativeScroll(NativeScroll {
                x: number(action, "x")?,
                y: number(action, "y")?,
                dx: optional_number(action, "dx")?,
                dy: optional_number(action, "dy")?,
                phase: scroll_phase(action, "phase")?,
                momentum: scroll_phase(action, "momentum")?,
            }))
        }
        "scroll" => steps.push(Step::Scroll {
            x: number(action, "x")?,
            y: number(action, "y")?,
            dx: optional_number(action, "dx")?,
            dy: optional_number(action, "dy")?,
            modifiers: mods,
            phase: scroll_phase(action, "phase")?,
        }),
        "key" | "keydown" | "keyup" => {
            let text = action
                .get("key")
                .and_then(Value::as_str)
                .ok_or("key actions need a key")?;
            let parsed = keystroke(text)?;
            if kind != "keyup" {
                steps.push(Step::KeyDown(parsed.clone()));
            }
            if kind != "keydown" {
                steps.push(Step::KeyUp(parsed));
            }
        }
        "text" => {
            let text = action
                .get("text")
                .and_then(Value::as_str)
                .ok_or("text actions need text")?;
            if text.chars().count() > MAX_STEPS / 2 {
                return Err(format!(
                    "at most {} characters per text action",
                    MAX_STEPS / 2
                ));
            }
            for character in text.chars() {
                let typed = typed_keystroke(character);
                steps.push(Step::KeyDown(typed.clone()));
                steps.push(Step::KeyUp(typed));
            }
        }
        other => return Err(format!("unknown input type {other}")),
    }
    Ok(())
}

pub fn parse(params: &Value) -> Result<Vec<Step>, String> {
    let actions: Vec<&Value> = match params.get("actions") {
        Some(Value::Array(actions)) => actions.iter().collect(),
        Some(_) => return Err("actions must be an array".to_owned()),
        None => vec![params],
    };
    let mut steps = Vec::new();
    for action in actions {
        parse_action(action, &mut steps)?;
        if steps.len() > MAX_STEPS {
            return Err(format!("at most {MAX_STEPS} input steps per request"));
        }
    }
    if steps.is_empty() {
        return Err("no input to send".to_owned());
    }
    Ok(steps)
}

#[cfg(target_os = "macos")]
pub fn post_native_scrolls(window_number: isize, scrolls: &[NativeScroll]) -> usize {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect};
    use std::ffi::c_void;

    #[repr(C)]
    struct CgEventRef([u8; 0]);

    unsafe impl objc2::encode::RefEncode for CgEventRef {
        const ENCODING_REF: objc2::encode::Encoding =
            objc2::encode::Encoding::Pointer(&objc2::encode::Encoding::Struct("__CGEvent", &[]));
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CgPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventCreateScrollWheelEvent2(
            source: *const c_void,
            units: u32,
            wheel_count: u32,
            wheel1: i32,
            wheel2: i32,
            wheel3: i32,
        ) -> *mut c_void;
        fn CGEventSetIntegerValueField(event: *mut c_void, field: u32, value: i64);
        fn CGEventSetDoubleValueField(event: *mut c_void, field: u32, value: f64);
        fn CGEventSetLocation(event: *mut c_void, location: CgPoint);
    }
    unsafe extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const std::ffi::c_char) -> *mut c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(object: *const c_void);
    }

    const PIXEL_UNITS: u32 = 0;
    const IS_CONTINUOUS: u32 = 88;
    const FIXED_DELTA_Y: u32 = 93;
    const FIXED_DELTA_X: u32 = 94;
    const SCROLL_PHASE: u32 = 99;
    const MOMENTUM_PHASE: u32 = 123;
    const WINDOW_NUMBER: u32 = 51;

    fn cg_phase(phase: gpui::ScrollPhase) -> i64 {
        match phase {
            gpui::ScrollPhase::Began => 1,
            gpui::ScrollPhase::Changed => 2,
            gpui::ScrollPhase::Ended => 4,
            gpui::ScrollPhase::Cancelled => 8,
            gpui::ScrollPhase::MayBegin => 128,
            _ => 0,
        }
    }

    fn cg_momentum(phase: gpui::ScrollPhase) -> i64 {
        match phase {
            gpui::ScrollPhase::Began => 1,
            gpui::ScrollPhase::Changed | gpui::ScrollPhase::Stationary => 2,
            gpui::ScrollPhase::Ended | gpui::ScrollPhase::Cancelled => 3,
            _ => 0,
        }
    }

    let app: *mut AnyObject = unsafe { msg_send![class!(NSApplication), sharedApplication] };
    let window: Option<Retained<AnyObject>> =
        unsafe { msg_send![app, windowWithWindowNumber: window_number] };
    let Some(window) = window else {
        return 0;
    };
    let content: *mut AnyObject = unsafe { msg_send![&*window, contentView] };
    if content.is_null() {
        return 0;
    }
    let bounds: NSRect = unsafe { msg_send![content, bounds] };
    let screens: Option<Retained<AnyObject>> = unsafe { msg_send![class!(NSScreen), screens] };
    let main_height = screens
        .and_then(|screens| {
            let first: Option<Retained<AnyObject>> = unsafe { msg_send![&*screens, firstObject] };
            first
        })
        .map(|screen| {
            let frame: NSRect = unsafe { msg_send![&*screen, frame] };
            frame.size.height
        })
        .unwrap_or(0.0);
    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
    let set_window_location = unsafe { dlsym(RTLD_DEFAULT, c"CGEventSetWindowLocation".as_ptr()) };
    let set_window_location: Option<unsafe extern "C" fn(*mut c_void, CgPoint)> =
        (!set_window_location.is_null()).then(|| unsafe {
            std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void, CgPoint)>(
                set_window_location,
            )
        });
    let window_frame: NSRect = unsafe { msg_send![&*window, frame] };
    let mut posted = 0;
    for scroll in scrolls {
        let in_content = NSPoint::new(
            f64::from(scroll.x),
            bounds.size.height - f64::from(scroll.y),
        );
        let in_window: NSPoint = unsafe {
            msg_send![content, convertPoint: in_content, toView: std::ptr::null::<AnyObject>()]
        };
        let screen: NSPoint = unsafe { msg_send![&*window, convertPointToScreen: in_window] };
        let event = unsafe {
            CGEventCreateScrollWheelEvent2(
                std::ptr::null(),
                PIXEL_UNITS,
                2,
                scroll.dy.round() as i32,
                scroll.dx.round() as i32,
                0,
            )
        };
        if event.is_null() {
            continue;
        }
        unsafe {
            CGEventSetIntegerValueField(event, IS_CONTINUOUS, 1);
            CGEventSetDoubleValueField(event, FIXED_DELTA_Y, f64::from(scroll.dy));
            CGEventSetDoubleValueField(event, FIXED_DELTA_X, f64::from(scroll.dx));
            CGEventSetIntegerValueField(event, SCROLL_PHASE, cg_phase(scroll.phase));
            CGEventSetIntegerValueField(event, MOMENTUM_PHASE, cg_momentum(scroll.momentum));
            CGEventSetLocation(
                event,
                CgPoint {
                    x: screen.x,
                    y: main_height - screen.y,
                },
            );
            CGEventSetIntegerValueField(event, WINDOW_NUMBER, window_number as i64);
            if let Some(set_window_location) = set_window_location {
                set_window_location(
                    event,
                    CgPoint {
                        x: in_window.x,
                        y: window_frame.size.height - in_window.y,
                    },
                );
            }
        }
        let ns_event: Option<Retained<AnyObject>> =
            unsafe { msg_send![class!(NSEvent), eventWithCGEvent: event.cast::<CgEventRef>()] };
        unsafe { CFRelease(event) };
        if let Some(ns_event) = ns_event {
            let _: () = unsafe { msg_send![app, postEvent: &*ns_event, atStart: false] };
            posted += 1;
        }
    }
    posted
}

#[cfg(not(target_os = "macos"))]
pub fn post_native_scrolls(_window_number: isize, _scrolls: &[NativeScroll]) -> usize {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_click_moves_then_presses_and_releases() {
        let steps = parse(&json!({ "type": "click", "x": 10, "y": 20, "mods": "cmd" })).unwrap();
        assert_eq!(steps.len(), 3);
        assert!(matches!(
            steps[0],
            Step::Move {
                x: 10.0,
                y: 20.0,
                pressed: None,
                ..
            }
        ));
        match &steps[1] {
            Step::Down {
                button, modifiers, ..
            } => {
                assert_eq!(*button, MouseButton::Left);
                assert!(modifiers.platform);
            }
            other => panic!("expected a press, got {other:?}"),
        }
        assert!(matches!(steps[2], Step::Up { clicks: 1, .. }));
    }

    #[test]
    fn a_native_scroll_keeps_its_gesture_and_momentum_phases() {
        let steps = parse(&json!({ "actions": [
            { "type": "scroll", "native": true, "x": 3, "y": 4, "dx": 12, "phase": "began" },
            { "type": "scroll", "native": true, "x": 3, "y": 4, "dx": 5, "momentum": "changed" },
            { "type": "scroll", "x": 3, "y": 4, "dx": 5, "phase": "mayBegin" }
        ]}))
        .unwrap();
        assert_eq!(
            steps[0].native(),
            Some(NativeScroll {
                x: 3.0,
                y: 4.0,
                dx: 12.0,
                dy: 0.0,
                phase: gpui::ScrollPhase::Began,
                momentum: gpui::ScrollPhase::None,
            })
        );
        assert_eq!(
            steps[1].native().map(|s| s.momentum),
            Some(gpui::ScrollPhase::Changed)
        );
        assert!(steps[2].native().is_none());
        assert!(parse(&json!({ "type": "scroll", "x": 1, "y": 1, "phase": "sideways" })).is_err());
    }

    #[test]
    fn a_batch_keeps_its_order_and_keys_press_and_release() {
        let steps = parse(&json!({ "actions": [
            { "type": "move", "x": 1, "y": 2 },
            { "type": "key", "key": "escape" },
            { "type": "scroll", "x": 3, "y": 4, "dy": -40 }
        ]}))
        .unwrap();
        assert_eq!(steps.len(), 4);
        assert!(matches!(steps[1], Step::KeyDown(_)));
        assert!(matches!(steps[2], Step::KeyUp(_)));
        assert!(matches!(
            steps[3],
            Step::Scroll {
                dy: -40.0,
                dx: 0.0,
                ..
            }
        ));
    }

    #[test]
    fn typing_text_presses_each_character_with_its_text() {
        let steps = parse(&json!({ "type": "text", "text": "Hi there" })).unwrap();
        assert_eq!(steps.len(), 16);
        match &steps[0] {
            Step::KeyDown(keystroke) => {
                assert_eq!(keystroke.key, "h");
                assert_eq!(keystroke.key_char.as_deref(), Some("H"));
                assert!(keystroke.modifiers.shift);
            }
            other => panic!("expected a key press, got {other:?}"),
        }
        match &steps[4] {
            Step::KeyDown(keystroke) => {
                assert_eq!(keystroke.key, "space");
                assert_eq!(keystroke.key_char.as_deref(), Some(" "));
            }
            other => panic!("expected a key press, got {other:?}"),
        }
        let long: String = "a".repeat(200);
        assert!(parse(&json!({ "type": "text", "text": long })).is_err());
    }

    #[test]
    fn hostile_input_is_refused() {
        assert!(parse(&json!({ "type": "click", "x": "1", "y": 2 })).is_err());
        assert!(parse(&json!({ "type": "click", "x": 1e12, "y": 2 })).is_err());
        assert!(parse(&json!({ "type": "click", "x": 1, "y": 2, "clicks": 9 })).is_err());
        assert!(parse(&json!({ "type": "teleport" })).is_err());
        assert!(parse(&json!({ "type": "key", "key": "" })).is_err());
        assert!(parse(&json!({ "actions": "nope" })).is_err());
        let flood: Vec<Value> = (0..200)
            .map(|_| json!({ "type": "click", "x": 1, "y": 1 }))
            .collect();
        assert!(parse(&json!({ "actions": flood })).is_err());
    }
}
