use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use ardia_state::TabId;
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;

pub const ZOOM_STEP_DELTA: f64 = 30.0;
pub const WHEEL_LINE_DELTA: f64 = 30.0;
pub const CREDIT_LIFETIME: Duration = Duration::from_secs(1);
pub const CREDIT_LIMIT: usize = 8;

static ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_enabled(on: bool) -> bool {
    ENABLED.swap(on, Ordering::Relaxed) != on
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

#[derive(Debug, Default)]
pub struct WheelZoom {
    accumulated: f64,
    gesture_trackpad: bool,
    credits: Vec<(Instant, f64, TabId)>,
    armed: Vec<TabId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    None,
    Began,
    Other,
}

impl WheelZoom {
    pub fn zooms(&mut self, command: bool, trackpad: bool, phase: Phase, momentum: bool) -> bool {
        match phase {
            Phase::Began => self.gesture_trackpad = trackpad,
            Phase::None if !momentum => self.gesture_trackpad = false,
            _ => self.gesture_trackpad = self.gesture_trackpad || trackpad,
        }
        command && !self.gesture_trackpad
    }

    pub fn step(&mut self, delta: f64, began: bool) -> Option<i32> {
        if began {
            self.accumulated = 0.0;
        }
        self.accumulated += delta;
        if self.accumulated.abs() < ZOOM_STEP_DELTA {
            return None;
        }
        let direction = if self.accumulated > 0.0 { 1 } else { -1 };
        self.accumulated = 0.0;
        Some(direction)
    }

    pub fn offer(&mut self, tab: TabId, delta: f64, now: Instant) {
        self.credits
            .retain(|(at, _, _)| now.saturating_duration_since(*at) <= CREDIT_LIFETIME);
        if self.credits.len() >= CREDIT_LIMIT {
            self.credits.remove(0);
        }
        self.credits.push((now, delta, tab));
    }

    pub fn redeem(&mut self, tab: &TabId, page_dy: f64, now: Instant) -> Option<f64> {
        self.credits
            .retain(|(at, _, _)| now.saturating_duration_since(*at) <= CREDIT_LIFETIME);
        let direction = direction_of(-page_dy);
        let at = self
            .credits
            .iter()
            .position(|(_, delta, owner)| owner == tab && direction_of(*delta) == direction)?;
        Some(self.credits.remove(at).1)
    }
}

fn direction_of(value: f64) -> i32 {
    if value > 0.0 {
        1
    } else if value < 0.0 {
        -1
    } else {
        0
    }
}

pub fn runs_page_script(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("https:") || lower.starts_with("http:") || lower.starts_with("file:")
}

fn wheel() -> &'static Mutex<WheelZoom> {
    static WHEEL: OnceLock<Mutex<WheelZoom>> = OnceLock::new();
    WHEEL.get_or_init(|| Mutex::new(WheelZoom::default()))
}

fn coordinator() -> &'static OnceLock<Weak<AppCoordinator>> {
    static COORDINATOR: OnceLock<Weak<AppCoordinator>> = OnceLock::new();
    &COORDINATOR
}

fn target_tab(me: &AppCoordinator) -> Option<(TabId, String)> {
    let state = me.store().snapshot();
    let window = crate::mouse_shortcuts::target_window(&state)?;
    let tab = state.active_tab(window.as_str())?;
    Some((tab.id.clone(), tab.url.clone()))
}

fn zoom(me: &AppCoordinator, tab: TabId, direction: i32) {
    log::debug!("command-scroll zooms {tab} {direction:+}");
    ardia_ui::UiHost::zoom_step(me, tab, direction);
}

pub fn arm(command_held: bool) {
    let Some(me) = coordinator().get().and_then(Weak::upgrade) else {
        return;
    };
    let Some(engine) = me.engine() else {
        return;
    };
    let Ok(mut wheel) = wheel().lock() else {
        return;
    };
    if !command_held || !enabled() {
        for tab in std::mem::take(&mut wheel.armed) {
            if let Some(engine_tab) = me.engine_tab(&tab) {
                let _ = engine.call_page(
                    engine_tab,
                    "commandWheel",
                    &json!({"armed": false}).to_string(),
                );
            }
        }
        return;
    }
    let Some((tab, url)) = target_tab(&me) else {
        return;
    };
    if !runs_page_script(&url) || wheel.armed.contains(&tab) {
        return;
    }
    if let Some(engine_tab) = me.engine_tab(&tab)
        && engine
            .call_page(
                engine_tab,
                "commandWheel",
                &json!({"armed": true}).to_string(),
            )
            .is_ok()
    {
        wheel.armed.push(tab);
    }
}

pub fn scrolled(
    command: bool,
    trackpad: bool,
    phase: Phase,
    momentum: bool,
    delta: f64,
    over_page: bool,
) -> bool {
    let Ok(mut wheel) = wheel().lock() else {
        return false;
    };
    if !wheel.zooms(command, trackpad, phase, momentum) || !enabled() || !over_page {
        return false;
    }
    let Some(me) = coordinator().get().and_then(Weak::upgrade) else {
        return false;
    };
    let Some((tab, url)) = target_tab(&me) else {
        return false;
    };
    if runs_page_script(&url) && wheel.armed.contains(&tab) {
        wheel.offer(tab, delta, Instant::now());
        return false;
    }
    let step = wheel.step(delta, phase == Phase::Began);
    drop(wheel);
    if let Some(direction) = step {
        zoom(&me, tab, direction);
    }
    true
}

impl AppCoordinator {
    pub(crate) fn command_wheel_from_page(&self, tab: TabId, data: &Value) {
        let Some(page_dy) = data
            .get("dy")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
        else {
            return;
        };
        let handled = data.get("handled").and_then(Value::as_bool).unwrap_or(true);
        let Ok(mut wheel) = wheel().lock() else {
            return;
        };
        let Some(delta) = wheel.redeem(&tab, page_dy, Instant::now()) else {
            return;
        };
        if handled {
            return;
        }
        let step = wheel.step(delta, false);
        drop(wheel);
        if let Some(direction) = step {
            zoom(self, tab, direction);
        }
    }

    pub(crate) fn apply_command_scroll_zoom(&self, on: bool) {
        if set_enabled(on) {
            log::info!("command-scroll zoom is {}", if on { "on" } else { "off" });
            if !on {
                arm(false);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn hits_page(event: &objc2_app_kit::NSEvent) -> bool {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use objc2_foundation::NSPoint;

    unsafe {
        let window: Option<Retained<AnyObject>> = msg_send![event, window];
        let Some(window) = window else {
            return false;
        };
        let content: Option<Retained<AnyObject>> = msg_send![&*window, contentView];
        let Some(content) = content else {
            return false;
        };
        let point: NSPoint = msg_send![event, locationInWindow];
        let frame: Option<Retained<AnyObject>> = msg_send![&*content, superview];
        let local: NSPoint = match frame {
            Some(frame) => {
                let nothing: *const AnyObject = std::ptr::null();
                msg_send![&*frame, convertPoint: point, fromView: nothing]
            }
            None => point,
        };
        let mut view: Option<Retained<AnyObject>> = msg_send![&*content, hitTest: local];
        while let Some(current) = view {
            let class = (*current).class().name().to_string_lossy();
            if class.contains("RenderWidgetHostView") || class.contains("WKWebView") {
                return true;
            }
            let responds: objc2::runtime::Bool =
                msg_send![&*current, respondsToSelector: sel!(superview)];
            if !responds.as_bool() {
                return false;
            }
            view = msg_send![&*current, superview];
        }
        false
    }
}

#[cfg(target_os = "macos")]
pub fn install(coordinator_ref: Weak<AppCoordinator>) {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventPhase, NSEventType};

    if coordinator().set(coordinator_ref).is_err() {
        return;
    }
    let handler = RcBlock::new(|event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let shown = unsafe { event.as_ref() };
        let command = shown
            .modifierFlags()
            .contains(NSEventModifierFlags::Command);
        match shown.r#type() {
            NSEventType::FlagsChanged => {
                arm(command);
                event.as_ptr()
            }
            NSEventType::ScrollWheel => {
                let raw_phase = shown.phase();
                let momentum = shown.momentumPhase() != NSEventPhase::empty();
                let phase = if raw_phase.intersects(NSEventPhase::Began | NSEventPhase::MayBegin) {
                    Phase::Began
                } else if raw_phase == NSEventPhase::empty() {
                    Phase::None
                } else {
                    Phase::Other
                };
                let trackpad = raw_phase != NSEventPhase::empty() || momentum;
                let precise = shown.hasPreciseScrollingDeltas();
                let delta = if precise {
                    shown.scrollingDeltaY()
                } else {
                    shown.scrollingDeltaY() * WHEEL_LINE_DELTA
                };
                let over_page = command && hits_page(shown);
                if scrolled(command, trackpad, phase, momentum, delta, over_page) {
                    std::ptr::null_mut()
                } else {
                    event.as_ptr()
                }
            }
            _ => event.as_ptr(),
        }
    });
    let mask: u64 = (1 << NSEventType::ScrollWheel.0) | (1 << NSEventType::FlagsChanged.0);
    let monitor: Option<Retained<AnyObject>> = unsafe {
        msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: mask, handler: &*handler]
    };
    std::mem::forget(monitor);
    std::mem::forget(handler);
}

#[cfg(not(target_os = "macos"))]
pub fn install(coordinator_ref: Weak<AppCoordinator>) {
    let _ = coordinator().set(coordinator_ref);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mouse_wheel_with_command_zooms_but_a_trackpad_gesture_never_does() {
        let mut wheel = WheelZoom::default();
        assert!(wheel.zooms(true, false, Phase::None, false));
        assert!(!wheel.zooms(false, false, Phase::None, false));
        assert!(!wheel.zooms(true, true, Phase::Began, false));
        assert!(!wheel.zooms(true, false, Phase::Other, false));
        assert!(!wheel.zooms(true, false, Phase::None, true));
        assert!(wheel.zooms(true, false, Phase::None, false));
    }

    #[test]
    fn zoom_steps_need_thirty_points_of_scroll() {
        let mut wheel = WheelZoom::default();
        assert_eq!(wheel.step(12.0, false), None);
        assert_eq!(wheel.step(12.0, false), None);
        assert_eq!(wheel.step(12.0, false), Some(1));
        assert_eq!(wheel.step(-30.0, false), Some(-1));
        assert_eq!(wheel.step(-20.0, false), None);
        assert_eq!(wheel.step(25.0, true), None);
    }

    #[test]
    fn the_page_answers_a_wheel_credit_in_its_own_direction() {
        let mut wheel = WheelZoom::default();
        let now = Instant::now();
        let tab = TabId::from("t-1");
        wheel.offer(tab.clone(), 40.0, now);
        assert_eq!(wheel.redeem(&tab, 40.0, now), None);
        assert_eq!(wheel.redeem(&tab, -40.0, now), Some(40.0));
        assert_eq!(wheel.redeem(&tab, -40.0, now), None);
        wheel.offer(tab.clone(), -10.0, now);
        assert_eq!(wheel.redeem(&tab, 10.0, now + Duration::from_secs(2)), None);
    }

    #[test]
    fn only_web_and_file_pages_run_the_page_script() {
        assert!(runs_page_script("https://a.example"));
        assert!(runs_page_script("file:///tmp/x.html"));
        assert!(!runs_page_script("ardia://settings"));
        assert!(!runs_page_script(""));
    }
}
