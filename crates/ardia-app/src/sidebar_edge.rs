use ardia_ui::sidebar::edge_peek::{ScreenEdge, SidebarEdgeWatch};

pub const REACH: f64 = 24.0;
pub const CROSSING_REACH: f64 = 96.0;
pub const RETURN_WITHIN: f64 = 0.7;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Frame {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.min_x && x < self.max_x && y >= self.min_y && y < self.max_y
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ScreenEdgeCrossing {
    was_inside: bool,
    left_at: Option<f64>,
}

impl ScreenEdgeCrossing {
    pub fn awaiting_return(&self, time: f64) -> bool {
        self.left_at.is_some_and(|at| time - at <= RETURN_WITHIN)
    }

    pub fn track(&mut self, past: f64, time: f64) -> Option<ScreenEdge> {
        let inside = past <= 0.0;
        let was_inside = std::mem::replace(&mut self.was_inside, inside);
        if !inside {
            if past > CROSSING_REACH {
                self.left_at = None;
            }
            if !was_inside {
                return None;
            }
            if past <= CROSSING_REACH {
                self.left_at = Some(time);
            }
            return Some(ScreenEdge::Crossed);
        }
        let since = self.left_at.take()?;
        (time - since <= RETURN_WITHIN && past >= -CROSSING_REACH).then_some(ScreenEdge::Returned)
    }
}

pub fn in_rows(y: f64, frame: Frame) -> bool {
    y >= frame.min_y && y < frame.max_y
}

pub fn in_column(x: f64, frame: Frame, hold: f64, trailing: bool) -> bool {
    if trailing {
        x >= frame.max_x - hold
    } else {
        x < frame.min_x + hold
    }
}

pub fn in_band(x: f64, frame: Frame, hold: f64, trailing: bool) -> bool {
    if trailing {
        x < frame.max_x && x >= frame.max_x - hold
    } else {
        x >= frame.min_x && x < frame.min_x + hold
    }
}

pub fn beyond_edge(x: f64, frame: Frame, screen: Frame, trailing: bool) -> bool {
    if trailing {
        x >= frame.max_x && x < screen.max_x.min(frame.max_x + REACH)
    } else {
        x < frame.min_x && x >= screen.min_x.max(frame.min_x - REACH)
    }
}

pub fn beside_screen_edge(frame: Frame, screen: Frame, trailing: bool) -> bool {
    let gap = if trailing {
        screen.max_x - frame.max_x
    } else {
        frame.min_x - screen.min_x
    };
    gap <= REACH
}

pub fn sidebar_side_at_screen_edge(frame: Frame, screen: Frame, trailing: bool) -> bool {
    let inside = if trailing {
        frame.max_x <= screen.max_x
    } else {
        frame.min_x >= screen.min_x
    };
    inside && beside_screen_edge(frame, screen, trailing)
}

pub fn screen_edge_x(screen: Frame, trailing: bool) -> f64 {
    if trailing {
        screen.max_x - 1.0
    } else {
        screen.min_x
    }
}

pub fn past_screen_edge(x: f64, screen: Frame, trailing: bool) -> f64 {
    let edge = screen_edge_x(screen, trailing);
    if trailing {
        x.floor() - edge
    } else {
        edge - x.floor()
    }
}

pub fn inside_edge(frame: Frame, trailing: bool, y: f64) -> (f64, f64) {
    (
        if trailing {
            frame.max_x - 1.0
        } else {
            frame.min_x + 1.0
        },
        y,
    )
}

pub fn root_point(x: f64, y: f64, frame: Frame) -> [f32; 2] {
    [(x - frame.min_x) as f32, (frame.max_y - y) as f32]
}

pub trait Probe {
    fn ours_at(&self, x: f64, y: f64) -> bool;
    fn another_of_ours_at(&self, x: f64, y: f64) -> bool;
    fn app_active(&self) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub frame: Frame,
    pub screen: Frame,
    pub hold: f64,
    pub trailing: bool,
}

pub fn is_over(x: f64, y: f64, at: Placement, holding: bool, probe: Option<&dyn Probe>) -> bool {
    let Placement {
        frame,
        screen,
        hold,
        trailing,
    } = at;
    let slack = if holding { REACH } else { 0.0 };
    if y < frame.min_y - slack || y >= frame.max_y + slack {
        return false;
    }
    let inside_y = y.max(frame.min_y).min(frame.max_y - 1.0);
    if in_band(x, frame, hold, trailing) {
        let Some(probe) = probe else {
            return true;
        };
        if !probe.ours_at(x, inside_y) {
            return false;
        }
        return inside_y == y || !probe.another_of_ours_at(x, y);
    }
    if !beyond_edge(x, frame, screen, trailing) {
        return false;
    }
    let Some(probe) = probe else {
        return true;
    };
    let (edge_x, edge_y) = inside_edge(frame, trailing, inside_y);
    if !probe.ours_at(edge_x, edge_y) || probe.another_of_ours_at(x, y) {
        return false;
    }
    probe.app_active() || beside_screen_edge(frame, screen, trailing)
}

pub fn watch_hold(watch: &SidebarEdgeWatch) -> f64 {
    f64::from(watch.hold.max(0.0))
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::ptr::NonNull;

    use ardia_state::WindowId;
    use ardia_ui::sidebar::edge_peek::{
        ScreenEdge, SidebarEdgeEvent, SidebarEdgeSink, SidebarEdgeWatch,
    };
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect};

    use super::*;

    const FULL_SCREEN_MASK: u64 = 1 << 14;
    const DOCK_WINDOW_LEVEL_KEY: i32 = 10;

    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, window: u32) -> *const AnyObject;
        fn CGWindowLevelForKey(key: i32) -> i32;
        fn CFRelease(object: *const std::ffi::c_void);
    }

    struct Watched {
        number: isize,
        watch: SidebarEdgeWatch,
        sink: SidebarEdgeSink,
    }

    #[derive(Default)]
    struct Watcher {
        watched: HashMap<WindowId, Watched>,
        over: HashSet<WindowId>,
        pressed_inside: HashSet<WindowId>,
        unreported: HashSet<WindowId>,
        crossings: HashMap<WindowId, ScreenEdgeCrossing>,
        returned_to: Option<WindowId>,
        button_held: bool,
        was_pressed: bool,
        background: bool,
        background_point: Option<(f64, f64)>,
        local: Option<Retained<AnyObject>>,
        global: Option<Retained<AnyObject>>,
        dock_pid: Option<i32>,
        last_hit: (isize, bool),
    }

    thread_local! {
        static WATCHER: RefCell<Watcher> = RefCell::new(Watcher::default());
    }

    fn app() -> *mut AnyObject {
        unsafe { msg_send![class!(NSApplication), sharedApplication] }
    }

    fn app_active() -> bool {
        let app = app();
        !app.is_null() && unsafe { msg_send![app, isActive] }
    }

    fn window_with_number(number: isize) -> Option<Retained<AnyObject>> {
        let app = app();
        if app.is_null() || number <= 0 {
            return None;
        }
        unsafe { msg_send![app, windowWithWindowNumber: number] }
    }

    fn frame_of(rect: NSRect) -> Frame {
        Frame {
            min_x: rect.origin.x,
            min_y: rect.origin.y,
            max_x: rect.origin.x + rect.size.width,
            max_y: rect.origin.y + rect.size.height,
        }
    }

    fn window_frame(window: &AnyObject) -> Frame {
        frame_of(unsafe { msg_send![window, frame] })
    }

    fn screen_frame(window: &AnyObject) -> Option<Frame> {
        let screen: Option<Retained<AnyObject>> = unsafe { msg_send![window, screen] };
        screen.map(|screen| frame_of(unsafe { msg_send![&*screen, frame] }))
    }

    fn shown(window: &AnyObject) -> bool {
        let visible: bool = unsafe { msg_send![window, isVisible] };
        let mini: bool = unsafe { msg_send![window, isMiniaturized] };
        visible && !mini
    }

    fn full_screen(window: &AnyObject) -> bool {
        let mask: u64 = unsafe { msg_send![window, styleMask] };
        mask & FULL_SCREEN_MASK != 0
    }

    fn same_or_child(hit: Option<&Retained<AnyObject>>, window: &AnyObject) -> bool {
        let Some(hit) = hit else {
            return false;
        };
        if std::ptr::eq(&**hit, window) {
            return true;
        }
        let parent: Option<Retained<AnyObject>> = unsafe { msg_send![&**hit, parentWindow] };
        parent.is_some_and(|parent| std::ptr::eq(&*parent, window))
    }

    fn window_number_at(x: f64, y: f64, below: isize) -> isize {
        let point = NSPoint::new(x, y);
        let mut number: isize = unsafe {
            msg_send![class!(NSWindow), windowNumberAtPoint: point, belowWindowWithWindowNumber: below]
        };
        while let Some(pass) = window_with_number(number) {
            let ignores: bool = unsafe { msg_send![&*pass, ignoresMouseEvents] };
            if !ignores {
                break;
            }
            let under: isize = unsafe {
                msg_send![class!(NSWindow), windowNumberAtPoint: point, belowWindowWithWindowNumber: number]
            };
            if under == number {
                break;
            }
            number = under;
        }
        number
    }

    struct LiveProbe<'a> {
        window: &'a AnyObject,
        number: isize,
    }

    impl Probe for LiveProbe<'_> {
        fn ours_at(&self, x: f64, y: f64) -> bool {
            same_or_child(
                window_with_number(window_number_at(x, y, 0)).as_ref(),
                self.window,
            )
        }

        fn another_of_ours_at(&self, x: f64, y: f64) -> bool {
            let under = window_number_at(x, y, 0);
            under != self.number && window_with_number(under).is_some()
        }

        fn app_active(&self) -> bool {
            app_active()
        }
    }

    impl Watcher {
        fn is_dock(&mut self, number: isize) -> bool {
            if number <= 0 || window_with_number(number).is_some() {
                return false;
            }
            if number != self.last_hit.0 {
                self.last_hit = (number, self.dock_window(number));
            }
            self.last_hit.1
        }

        fn dock_window(&mut self, number: isize) -> bool {
            let pid = match self.dock_pid {
                Some(pid) => pid,
                None => {
                    let Some(pid) = dock_pid() else {
                        return false;
                    };
                    self.dock_pid = Some(pid);
                    pid
                }
            };
            let info = unsafe { CGWindowListCopyWindowInfo(1 << 3, number as u32) };
            if info.is_null() {
                return false;
            }
            let found = unsafe {
                let count: usize = msg_send![info, count];
                let entry: Option<Retained<AnyObject>> = if count > 0 {
                    msg_send![info, objectAtIndex: 0usize]
                } else {
                    None
                };
                entry.is_some_and(|entry| {
                    let owner = number_for(&entry, "kCGWindowOwnerPID");
                    let layer = number_for(&entry, "kCGWindowLayer");
                    owner == Some(i64::from(pid))
                        && layer.is_some_and(|layer| {
                            layer >= i64::from(CGWindowLevelForKey(DOCK_WINDOW_LEVEL_KEY))
                        })
                })
            };
            unsafe { CFRelease(info.cast()) };
            if !found {
                self.dock_pid = None;
            }
            found
        }

        fn top_beneath_dock(&mut self, x: f64, y: f64, window: &AnyObject, trailing: bool) -> bool {
            let (edge_x, _) = inside_edge(window_frame(window), trailing, y);
            let probe_x = if trailing {
                x.min(edge_x)
            } else {
                x.max(edge_x)
            };
            let mut number = window_number_at(probe_x, y, 0);
            while self.is_dock(number) {
                let below = window_number_at(probe_x, y, number);
                if below == number {
                    break;
                }
                number = below;
            }
            same_or_child(window_with_number(number).as_ref(), window)
        }

        fn near_screen_edge(&self, x: f64, y: f64, id: &WindowId, live: bool) -> bool {
            let Some(watched) = self.watched.get(id) else {
                return false;
            };
            let Some(window) = window_with_number(watched.number) else {
                return false;
            };
            let Some(screen) = screen_frame(&window) else {
                return false;
            };
            let reach = watch_hold(&watched.watch).max(CROSSING_REACH);
            let frame = window_frame(&window);
            let trailing = watched.watch.trailing;
            let inside = if trailing {
                x >= frame.max_x - reach && x < frame.max_x
            } else {
                x >= frame.min_x && x < frame.min_x + reach
            };
            if !inside
                || !in_rows(y, frame)
                || !sidebar_side_at_screen_edge(frame, screen, trailing)
            {
                return false;
            }
            !live
                || same_or_child(
                    window_with_number(window_number_at(x, y, 0)).as_ref(),
                    &window,
                )
        }

        fn pressed(&self, live: bool) -> bool {
            let buttons: usize = if live {
                unsafe { msg_send![class!(NSEvent), pressedMouseButtons] }
            } else {
                0
            };
            self.button_held || buttons != 0
        }

        fn cross_screen_edge(
            &mut self,
            x: f64,
            y: f64,
            live: bool,
        ) -> HashMap<WindowId, ScreenEdge> {
            let tracking = !self.pressed(live) && (!live || (app_active() && !self.background));
            if let Some(id) = self.returned_to.clone()
                && (!tracking || !self.near_screen_edge(x, y, &id, live))
            {
                self.returned_to = None;
            }
            let time = uptime();
            let watched: Vec<WindowId> = self.watched.keys().cloned().collect();
            self.crossings
                .retain(|id, crossing| watched.contains(id) || crossing.awaiting_return(time));
            let mut notes = HashMap::new();
            for id in watched {
                let Some(entry) = self.watched.get(&id) else {
                    continue;
                };
                let trailing = entry.watch.trailing;
                let window = window_with_number(entry.number);
                let placed = window.as_ref().and_then(|window| {
                    let screen = screen_frame(window)?;
                    let frame = window_frame(window);
                    (tracking
                        && shown(window)
                        && !full_screen(window)
                        && in_rows(y, frame)
                        && sidebar_side_at_screen_edge(frame, screen, trailing))
                    .then_some((frame, screen))
                });
                let (Some(window), Some((frame, screen))) = (window, placed) else {
                    self.crossings.remove(&id);
                    continue;
                };
                let past = past_screen_edge(x, screen, trailing);
                let Some(step) = self
                    .crossings
                    .entry(id.clone())
                    .or_default()
                    .track(past, time)
                else {
                    continue;
                };
                match step {
                    ScreenEdge::Crossed => {
                        if live {
                            let (edge_x, edge_y) = inside_edge(frame, trailing, y);
                            let hit = window_with_number(window_number_at(edge_x, edge_y, 0));
                            if !same_or_child(hit.as_ref(), &window) {
                                self.crossings.remove(&id);
                                continue;
                            }
                        }
                        if self.returned_to.as_ref() == Some(&id) {
                            self.returned_to = None;
                        }
                        notes.insert(id, ScreenEdge::Crossed);
                    }
                    ScreenEdge::Returned => {
                        if !self.near_screen_edge(x, y, &id, live) {
                            continue;
                        }
                        self.returned_to = Some(id.clone());
                        notes.insert(id, ScreenEdge::Returned);
                    }
                }
            }
            notes
        }

        fn check(
            &mut self,
            x: f64,
            y: f64,
            live: bool,
        ) -> Vec<(SidebarEdgeSink, SidebarEdgeEvent)> {
            let screen_edge = self.cross_screen_edge(x, y, live);
            let active = live && app_active();
            let pressed = self.pressed(live);
            if pressed && !self.was_pressed {
                let held: Vec<WindowId> = self
                    .over
                    .iter()
                    .filter(|id| self.watched.get(*id).is_some_and(|w| w.watch.while_pressed))
                    .cloned()
                    .collect();
                self.pressed_inside.extend(held);
            }
            self.was_pressed = pressed;
            let mut out = Vec::new();
            let ids: Vec<WindowId> = self.watched.keys().cloned().collect();
            let mut on_dock: Option<bool> = None;
            for id in ids {
                let Some(entry) = self.watched.get(&id) else {
                    continue;
                };
                let (number, watch, sink) = (entry.number, entry.watch, entry.sink.clone());
                let Some(window) = window_with_number(number) else {
                    self.watched.remove(&id);
                    self.over.remove(&id);
                    self.unreported.remove(&id);
                    self.crossings.remove(&id);
                    continue;
                };
                if !pressed {
                    self.pressed_inside.remove(&id);
                }
                let frame = window_frame(&window);
                let Some(screen) = screen_frame(&window).filter(|_| shown(&window)) else {
                    continue;
                };
                let at = Placement {
                    frame,
                    screen,
                    hold: watch_hold(&watch),
                    trailing: watch.trailing,
                };
                let probe = LiveProbe {
                    window: &window,
                    number,
                };
                let probe: Option<&dyn Probe> = if live { Some(&probe) } else { None };
                let holding = self.over.contains(&id);
                let in_col = in_column(x, frame, at.hold, at.trailing) && screen.contains(x, y);
                let mut dock = |watcher: &mut Watcher| {
                    *on_dock
                        .get_or_insert_with(|| active && watcher.is_dock(window_number_at(x, y, 0)))
                };
                let now = (pressed && self.pressed_inside.contains(&id))
                    || ((watch.while_pressed || !pressed)
                        && (is_over(x, y, at, holding, probe)
                            || (in_col && holding && dock(self))
                            || (in_col
                                && is_over(x, y, at, false, None)
                                && dock(self)
                                && self.top_beneath_dock(x, y, &window, at.trailing))
                            || self.returned_to.as_ref() == Some(&id)));
                let fresh = self.unreported.remove(&id);
                let note = screen_edge.get(&id).copied();
                if !fresh && now == holding && note.is_none() {
                    continue;
                }
                if now {
                    self.over.insert(id.clone());
                } else {
                    self.over.remove(&id);
                }
                out.push((
                    sink,
                    SidebarEdgeEvent {
                        over: now,
                        point: root_point(x, y, frame),
                        screen_edge: note,
                    },
                ));
            }
            self.update_global();
            out
        }

        fn point(&self) -> Option<((f64, f64), bool)> {
            if self.background {
                return self.background_point.map(|point| (point, false));
            }
            let point: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
            Some(((point.x, point.y), true))
        }

        fn needs_global(&self) -> bool {
            if self.background || self.watched.is_empty() {
                return false;
            }
            if app_active() || !self.over.is_empty() {
                return true;
            }
            self.watched.values().any(|entry| {
                if entry.watch.hold > 0.0 {
                    return true;
                }
                window_with_number(entry.number).is_some_and(|window| {
                    screen_frame(&window).is_some_and(|screen| {
                        beside_screen_edge(window_frame(&window), screen, entry.watch.trailing)
                    })
                })
            })
        }

        fn update_global(&mut self) {
            let needed = self.needs_global();
            if needed == self.global.is_some() {
                return;
            }
            if let Some(monitor) = self.global.take() {
                unsafe {
                    let _: () = msg_send![class!(NSEvent), removeMonitor: &*monitor];
                }
                return;
            }
            let handler = RcBlock::new(|event: NonNull<AnyObject>| {
                let event = unsafe { event.as_ref() };
                note_buttons(event);
                check_pointer();
            });
            let mask = pointer_mask();
            self.global = unsafe {
                msg_send![class!(NSEvent), addGlobalMonitorForEventsMatchingMask: mask, handler: &*handler]
            };
        }

        fn start(&mut self) {
            if self.local.is_none() {
                let handler = RcBlock::new(|event: NonNull<AnyObject>| -> *mut AnyObject {
                    let shown = unsafe { event.as_ref() };
                    note_buttons(shown);
                    note_background_point(shown);
                    check_pointer();
                    event.as_ptr()
                });
                let mask = pointer_mask() | (1 << 1) | (1 << 3) | (1 << 25);
                self.local = unsafe {
                    msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: mask, handler: &*handler]
                };
            }
            self.update_global();
        }

        fn stop(&mut self) {
            self.returned_to = None;
            for monitor in [self.local.take(), self.global.take()]
                .into_iter()
                .flatten()
            {
                unsafe {
                    let _: () = msg_send![class!(NSEvent), removeMonitor: &*monitor];
                }
            }
        }
    }

    fn number_for(entry: &AnyObject, key: &str) -> Option<i64> {
        let key = objc2_foundation::NSString::from_str(key);
        let value: Option<Retained<AnyObject>> = unsafe { msg_send![entry, objectForKey: &*key] };
        value.map(|value| unsafe { msg_send![&*value, longLongValue] })
    }

    fn dock_pid() -> Option<i32> {
        let bundle = objc2_foundation::NSString::from_str("com.apple.dock");
        let apps: Retained<AnyObject> = unsafe {
            msg_send![class!(NSRunningApplication), runningApplicationsWithBundleIdentifier: &*bundle]
        };
        let first: Option<Retained<AnyObject>> = unsafe { msg_send![&*apps, firstObject] };
        first.map(|app| unsafe { msg_send![&*app, processIdentifier] })
    }

    fn uptime() -> f64 {
        let info: Retained<AnyObject> = unsafe { msg_send![class!(NSProcessInfo), processInfo] };
        unsafe { msg_send![&*info, systemUptime] }
    }

    fn pointer_mask() -> u64 {
        (1 << 5) | (1 << 6) | (1 << 7) | (1 << 27) | (1 << 2) | (1 << 4) | (1 << 26)
    }

    fn note_buttons(event: &AnyObject) {
        let kind: usize = unsafe { msg_send![event, type] };
        WATCHER.with(|cell| {
            let mut watcher = cell.borrow_mut();
            match kind {
                1 | 3 | 25 => {
                    watcher.button_held = true;
                    let held: Vec<WindowId> = watcher
                        .over
                        .iter()
                        .filter(|id| {
                            watcher
                                .watched
                                .get(*id)
                                .is_some_and(|w| w.watch.while_pressed)
                        })
                        .cloned()
                        .collect();
                    watcher.pressed_inside.extend(held);
                }
                6 | 7 | 27 => watcher.button_held = true,
                2 | 4 | 26 | 5 => {
                    watcher.button_held = false;
                    watcher.pressed_inside.clear();
                }
                _ => {}
            }
        });
    }

    fn note_background_point(event: &AnyObject) {
        WATCHER.with(|cell| {
            let mut watcher = cell.borrow_mut();
            if !watcher.background {
                return;
            }
            let window: Option<Retained<AnyObject>> = unsafe { msg_send![event, window] };
            let Some(window) = window else {
                return;
            };
            let local: NSPoint = unsafe { msg_send![event, locationInWindow] };
            let screen: NSPoint = unsafe { msg_send![&*window, convertPointToScreen: local] };
            watcher.background_point = Some((screen.x, screen.y));
        });
    }

    fn check_pointer() {
        let sends = WATCHER.with(|cell| {
            let mut watcher = cell.borrow_mut();
            let Some(((x, y), live)) = watcher.point() else {
                return Vec::new();
            };
            let sends = watcher.check(x, y, live);
            if watcher.watched.is_empty() {
                watcher.stop();
            }
            sends
        });
        for (sink, event) in sends {
            sink(event);
        }
    }

    fn window_number(window: &gpui::Window) -> Option<isize> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
            return None;
        };
        let view = appkit.ns_view.as_ptr().cast::<AnyObject>();
        let ns_window: *mut AnyObject = unsafe { msg_send![view, window] };
        if ns_window.is_null() {
            return None;
        }
        Some(unsafe { msg_send![ns_window, windowNumber] })
    }

    pub fn watch(
        window: &gpui::Window,
        window_id: WindowId,
        watch: Option<(SidebarEdgeWatch, SidebarEdgeSink)>,
        background: bool,
    ) {
        let number = window_number(window);
        WATCHER.with(|cell| {
            let mut watcher = cell.borrow_mut();
            watcher.background = background;
            match (watch, number) {
                (Some((watch, sink)), Some(number)) => {
                    watcher.watched.insert(
                        window_id.clone(),
                        Watched {
                            number,
                            watch,
                            sink,
                        },
                    );
                    watcher.unreported.insert(window_id);
                }
                _ => {
                    watcher.watched.remove(&window_id);
                    watcher.over.remove(&window_id);
                    watcher.unreported.remove(&window_id);
                    let time = uptime();
                    if !watcher
                        .crossings
                        .get(&window_id)
                        .is_some_and(|crossing| crossing.awaiting_return(time))
                    {
                        watcher.crossings.remove(&window_id);
                    }
                }
            }
            if watcher.watched.is_empty() {
                watcher.stop();
            } else {
                watcher.start();
            }
        });
        check_pointer();
    }
}

#[cfg(target_os = "macos")]
pub use mac::watch;

#[cfg(not(target_os = "macos"))]
pub fn watch(
    _window: &gpui::Window,
    _window_id: ardia_state::WindowId,
    _watch: Option<(
        SidebarEdgeWatch,
        ardia_ui::sidebar::edge_peek::SidebarEdgeSink,
    )>,
    _background: bool,
) {
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Frame = Frame {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 1512.0,
        max_y: 982.0,
    };

    fn placed(min_x: f64, hold: f64) -> Placement {
        Placement {
            frame: Frame {
                min_x,
                min_y: 100.0,
                max_x: min_x + 1000.0,
                max_y: 800.0,
            },
            screen: SCREEN,
            hold,
            trailing: false,
        }
    }

    struct Fake {
        ours: bool,
        other: bool,
        active: bool,
    }

    impl Probe for Fake {
        fn ours_at(&self, _: f64, _: f64) -> bool {
            self.ours
        }
        fn another_of_ours_at(&self, _: f64, _: f64) -> bool {
            self.other
        }
        fn app_active(&self) -> bool {
            self.active
        }
    }

    #[test]
    fn the_watch_reaches_twenty_four_points_beyond_the_window_edge() {
        let at = placed(200.0, 3.0);
        assert!(is_over(200.0, 300.0, at, false, None));
        assert!(is_over(202.9, 300.0, at, false, None));
        assert!(!is_over(203.0, 300.0, at, false, None));
        assert!(is_over(176.0, 300.0, at, false, None));
        assert!(!is_over(175.9, 300.0, at, false, None));
        let at_screen = placed(0.0, 3.0);
        assert!(!is_over(-1.0, 300.0, at_screen, false, None));
    }

    #[test]
    fn holding_adds_twenty_four_points_of_vertical_slack() {
        let at = placed(200.0, 239.0);
        assert!(!is_over(300.0, 99.0, at, false, None));
        assert!(is_over(300.0, 77.0, at, true, None));
        assert!(!is_over(300.0, 75.9, at, true, None));
        assert!(is_over(300.0, 823.0, at, true, None));
        assert!(!is_over(300.0, 824.0, at, true, None));
        assert!(!is_over(439.0, 300.0, at, true, None));
    }

    #[test]
    fn beyond_the_edge_needs_the_app_active_or_the_window_at_the_screen_edge() {
        let inactive = Fake {
            ours: true,
            other: false,
            active: false,
        };
        assert!(!is_over(
            180.0,
            300.0,
            placed(200.0, 3.0),
            false,
            Some(&inactive)
        ));
        assert!(is_over(
            5.0,
            300.0,
            placed(10.0, 3.0),
            false,
            Some(&inactive)
        ));
        let active = Fake {
            active: true,
            ..inactive
        };
        assert!(is_over(
            180.0,
            300.0,
            placed(200.0, 3.0),
            false,
            Some(&active)
        ));
        let covered = Fake {
            ours: false,
            ..active
        };
        assert!(!is_over(
            201.0,
            300.0,
            placed(200.0, 3.0),
            false,
            Some(&covered)
        ));
        let over_other = Fake {
            other: true,
            ..active
        };
        assert!(!is_over(
            180.0,
            300.0,
            placed(200.0, 3.0),
            false,
            Some(&over_other)
        ));
    }

    #[test]
    fn crossing_the_screen_edge_is_noted_once_and_a_quick_return_comes_back() {
        let mut crossing = ScreenEdgeCrossing::default();
        assert_eq!(crossing.track(-10.0, 0.0), None);
        assert_eq!(crossing.track(1.0, 0.1), Some(ScreenEdge::Crossed));
        assert_eq!(crossing.track(5.0, 0.2), None);
        assert!(crossing.awaiting_return(0.7));
        assert_eq!(crossing.track(-2.0, 0.5), Some(ScreenEdge::Returned));
        assert_eq!(crossing.track(1.0, 1.0), Some(ScreenEdge::Crossed));
        assert_eq!(crossing.track(-2.0, 1.8), None);
        let mut far = ScreenEdgeCrossing::default();
        far.track(-1.0, 0.0);
        assert_eq!(far.track(200.0, 0.1), Some(ScreenEdge::Crossed));
        assert_eq!(far.track(-1.0, 0.2), None);
    }

    #[test]
    fn the_screen_edge_counts_only_for_a_window_against_it() {
        let frame = placed(10.0, 3.0).frame;
        assert!(sidebar_side_at_screen_edge(frame, SCREEN, false));
        assert!(!sidebar_side_at_screen_edge(
            placed(30.0, 3.0).frame,
            SCREEN,
            false
        ));
        assert!(!sidebar_side_at_screen_edge(
            placed(-5.0, 3.0).frame,
            SCREEN,
            false
        ));
        assert_eq!(past_screen_edge(-0.5, SCREEN, false), 1.0);
        assert_eq!(past_screen_edge(0.4, SCREEN, false), 0.0);
        assert_eq!(past_screen_edge(1512.2, SCREEN, true), 1.0);
    }

    #[test]
    fn points_go_to_the_ui_from_the_window_top_left() {
        let frame = placed(200.0, 3.0).frame;
        assert_eq!(root_point(190.0, 700.0, frame), [-10.0, 100.0]);
    }
}
