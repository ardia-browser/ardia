use ardia_state::BrowserState;
use ardia_state::shortcuts::{Key, Platform, Shortcut};

use crate::coordinator::AppCoordinator;

pub const COMMAND: &str = "newLittleArdia";
pub const CARBON_COMMAND: u32 = 0x0100;
pub const CARBON_SHIFT: u32 = 0x0200;
pub const CARBON_OPTION: u32 = 0x0800;
pub const CARBON_CONTROL: u32 = 0x1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chord {
    pub key_code: u32,
    pub modifiers: u32,
}

const FUNCTION_KEYS: [u32; 20] = [
    0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71, 0x6A,
    0x40, 0x4F, 0x50, 0x5A,
];

pub const LAYOUT_KEY_CODES: u16 = 128;

pub type KeyLayout = [Option<String>];

pub fn fixed_key_code(key: Key) -> Option<u32> {
    Some(match key {
        Key::Char(' ') | Key::Space => 0x31,
        Key::Char(_) => return None,
        Key::Up => 0x7E,
        Key::Down => 0x7D,
        Key::Left => 0x7B,
        Key::Right => 0x7C,
        Key::PageUp => 0x74,
        Key::PageDown => 0x79,
        Key::Home => 0x73,
        Key::End => 0x77,
        Key::ForwardDelete => 0x75,
        Key::Backspace => 0x33,
        Key::Tab => 0x30,
        Key::Enter => 0x24,
        Key::Escape => 0x35,
        Key::Function(n) => *FUNCTION_KEYS.get(usize::from(n).checked_sub(1)?)?,
    })
}

pub fn key_code(key: Key, layout: &KeyLayout) -> Option<u32> {
    if let Some(code) = fixed_key_code(key) {
        return Some(code);
    }
    let Key::Char(c) = key else {
        return None;
    };
    let wanted: String = c.to_lowercase().collect();
    layout
        .iter()
        .take(usize::from(LAYOUT_KEY_CODES))
        .position(|typed| typed.as_ref().is_some_and(|t| t.to_lowercase() == wanted))
        .map(|code| code as u32)
}

pub fn chord(shortcut: &Shortcut, layout: &KeyLayout) -> Option<Chord> {
    let m = shortcut.modifiers;
    let function_key = matches!(shortcut.key, Key::Function(_));
    if m.function && !function_key {
        return None;
    }
    let modifiers = if m.command { CARBON_COMMAND } else { 0 }
        | if m.option { CARBON_OPTION } else { 0 }
        | if m.control { CARBON_CONTROL } else { 0 }
        | if m.shift { CARBON_SHIFT } else { 0 };
    if modifiers & (CARBON_COMMAND | CARBON_CONTROL) == 0 && !function_key {
        return None;
    }
    Some(Chord {
        key_code: key_code(shortcut.key, layout)?,
        modifiers,
    })
}

pub fn wanted(
    state: &BrowserState,
    app_active: bool,
    layout: impl FnOnce() -> Vec<Option<String>>,
) -> Option<Chord> {
    if app_active || !state.settings.little_ardia_shortcut_from_any_app {
        return None;
    }
    let map = state.shortcut_map(Platform::current());
    let shortcut = map.primary(COMMAND)?;
    chord(shortcut, &layout())
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::Weak;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::{MainThreadMarker, NSString};

    use super::{COMMAND, Chord, wanted};
    use crate::coordinator::AppCoordinator;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct EventHotKeyId {
        signature: u32,
        id: u32,
    }

    #[repr(C)]
    struct EventTypeSpec {
        event_class: u32,
        event_kind: u32,
    }

    type Handler = extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32;

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn GetApplicationEventTarget() -> *mut c_void;
        fn RegisterEventHotKey(
            key_code: u32,
            modifiers: u32,
            id: EventHotKeyId,
            target: *mut c_void,
            options: u32,
            out: *mut *mut c_void,
        ) -> i32;
        fn UnregisterEventHotKey(hot_key: *mut c_void) -> i32;
        fn InstallEventHandler(
            target: *mut c_void,
            handler: Handler,
            count: u32,
            list: *const EventTypeSpec,
            data: *mut c_void,
            out: *mut *mut c_void,
        ) -> i32;
        fn GetEventParameter(
            event: *mut c_void,
            name: u32,
            desired: u32,
            actual: *mut u32,
            size: usize,
            actual_size: *mut usize,
            data: *mut c_void,
        ) -> i32;
    }

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        static kTISPropertyUnicodeKeyLayoutData: *const c_void;
        fn TISCopyCurrentKeyboardLayoutInputSource() -> *const c_void;
        fn TISGetInputSourceProperty(source: *const c_void, key: *const c_void) -> *const c_void;
        fn UCKeyTranslate(
            layout: *const c_void,
            key_code: u16,
            action: u16,
            modifiers: u32,
            keyboard_type: u32,
            options: u32,
            dead_keys: *mut u32,
            max_length: usize,
            length: *mut usize,
            chars: *mut u16,
        ) -> i32;
        fn LMGetKbdType() -> u8;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        fn CFRelease(object: *const c_void);
    }

    const KEY_ACTION_DISPLAY: u16 = 3;
    const INPUT_SOURCE_CHANGED: &str =
        "com.apple.Carbon.TISNotifySelectedKeyboardInputSourceChanged";

    pub fn live_layout() -> Vec<Option<String>> {
        let mut typed = vec![None; usize::from(super::LAYOUT_KEY_CODES)];
        unsafe {
            let source = TISCopyCurrentKeyboardLayoutInputSource();
            if source.is_null() {
                return typed;
            }
            let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
            let layout = if data.is_null() {
                std::ptr::null()
            } else {
                CFDataGetBytePtr(data)
            };
            if !layout.is_null() {
                let keyboard = u32::from(LMGetKbdType());
                for (code, slot) in typed.iter_mut().enumerate() {
                    let mut dead = 0u32;
                    let mut length = 0usize;
                    let mut chars = [0u16; 4];
                    let status = UCKeyTranslate(
                        layout.cast(),
                        code as u16,
                        KEY_ACTION_DISPLAY,
                        0,
                        keyboard,
                        0,
                        &mut dead,
                        chars.len(),
                        &mut length,
                        chars.as_mut_ptr(),
                    );
                    if status == 0 && length > 0 {
                        *slot = String::from_utf16(&chars[..length.min(chars.len())]).ok();
                    }
                }
            }
            CFRelease(source);
        }
        typed
    }

    const SIGNATURE: u32 = 0x4172_4C41;
    const KEYBOARD_CLASS: u32 = 0x6B65_7962;
    const HOT_KEY_PRESSED: u32 = 5;
    const DIRECT_OBJECT: u32 = 0x2D2D_2D2D;
    const HOT_KEY_ID_TYPE: u32 = 0x686B_6964;
    const NOT_HANDLED: i32 = -9874;

    #[derive(Default)]
    struct HotKey {
        coordinator: Weak<AppCoordinator>,
        background: bool,
        registered: Option<(Chord, usize)>,
        held_back: Option<Chord>,
        handler: bool,
        watching: bool,
        layout: Option<Vec<Option<String>>>,
    }

    thread_local! {
        static HOT_KEY: RefCell<HotKey> = RefCell::new(HotKey::default());
    }

    extern "C" fn pressed(_: *mut c_void, event: *mut c_void, _: *mut c_void) -> i32 {
        let mut id = EventHotKeyId::default();
        let status = unsafe {
            GetEventParameter(
                event,
                DIRECT_OBJECT,
                HOT_KEY_ID_TYPE,
                std::ptr::null_mut(),
                std::mem::size_of::<EventHotKeyId>(),
                std::ptr::null_mut(),
                (&raw mut id).cast(),
            )
        };
        if status != 0 || id.signature != SIGNATURE {
            return NOT_HANDLED;
        }
        let coordinator = HOT_KEY.with(|h| h.borrow().coordinator.upgrade());
        if let Some(coordinator) = coordinator {
            log::info!("the Little Ardia shortcut was pressed in another app");
            if let Err(problem) = coordinator.run_command(COMMAND, None) {
                log::warn!("the Little Ardia shortcut didn't open it: {problem}");
            }
        }
        0
    }

    fn app_active() -> bool {
        unsafe {
            let app: Option<Retained<AnyObject>> =
                msg_send![class!(NSApplication), sharedApplication];
            app.is_some_and(|app| {
                let active: Bool = msg_send![&*app, isActive];
                active.as_bool()
            })
        }
    }

    fn unregister(hot_key: &mut HotKey) {
        if let Some((_, reference)) = hot_key.registered.take() {
            unsafe {
                UnregisterEventHotKey(reference as *mut c_void);
            }
        }
        hot_key.held_back = None;
    }

    fn install_handler(hot_key: &mut HotKey) {
        if hot_key.handler {
            return;
        }
        let spec = EventTypeSpec {
            event_class: KEYBOARD_CLASS,
            event_kind: HOT_KEY_PRESSED,
        };
        let mut handler = std::ptr::null_mut();
        let status = unsafe {
            InstallEventHandler(
                GetApplicationEventTarget(),
                pressed,
                1,
                &spec,
                std::ptr::null_mut(),
                &mut handler,
            )
        };
        hot_key.handler = status == 0;
    }

    fn watch_activation() {
        let names = [
            (
                "NSNotificationCenter",
                "NSApplicationDidBecomeActiveNotification",
            ),
            (
                "NSNotificationCenter",
                "NSApplicationDidResignActiveNotification",
            ),
            ("NSDistributedNotificationCenter", INPUT_SOURCE_CHANGED),
        ];
        unsafe {
            let queue: Option<Retained<AnyObject>> = msg_send![class!(NSOperationQueue), mainQueue];
            let Some(queue) = queue else {
                return;
            };
            for (center_class, name) in names {
                let center: Option<Retained<AnyObject>> = match center_class {
                    "NSDistributedNotificationCenter" => {
                        msg_send![class!(NSDistributedNotificationCenter), defaultCenter]
                    }
                    _ => msg_send![class!(NSNotificationCenter), defaultCenter],
                };
                let Some(center) = center else {
                    continue;
                };
                let layout_changed = name == INPUT_SOURCE_CHANGED;
                let block = RcBlock::new(move |_: NonNull<AnyObject>| {
                    if layout_changed {
                        HOT_KEY.with(|h| h.borrow_mut().layout = None);
                    }
                    refresh();
                });
                let name = NSString::from_str(name);
                let nothing: *const AnyObject = std::ptr::null();
                let observer: Option<Retained<AnyObject>> = msg_send![
                    &*center,
                    addObserverForName: &*name,
                    object: nothing,
                    queue: &*queue,
                    usingBlock: &*block
                ];
                std::mem::forget(observer);
                std::mem::forget(block);
            }
        }
    }

    pub fn refresh() {
        let Some(coordinator) = HOT_KEY.with(|h| h.borrow().coordinator.upgrade()) else {
            return;
        };
        let state = coordinator.store().snapshot();
        let want = wanted(&state, app_active(), || {
            HOT_KEY.with(|h| {
                h.borrow_mut()
                    .layout
                    .get_or_insert_with(live_layout)
                    .clone()
            })
        });
        HOT_KEY.with(|h| {
            let mut hot_key = h.borrow_mut();
            let current = hot_key
                .registered
                .map(|(chord, _)| chord)
                .or(hot_key.held_back);
            if current == want {
                return;
            }
            unregister(&mut hot_key);
            let Some(chord) = want else {
                return;
            };
            if hot_key.background {
                hot_key.held_back = Some(chord);
                log::info!(
                    "global shortcut {}/{} not registered (background mode)",
                    chord.key_code,
                    chord.modifiers
                );
                return;
            }
            install_handler(&mut hot_key);
            let mut reference = std::ptr::null_mut();
            let status = unsafe {
                RegisterEventHotKey(
                    chord.key_code,
                    chord.modifiers,
                    EventHotKeyId {
                        signature: SIGNATURE,
                        id: 1,
                    },
                    GetApplicationEventTarget(),
                    0,
                    &mut reference,
                )
            };
            if status != 0 || reference.is_null() {
                log::info!(
                    "global shortcut {}/{} is taken ({status})",
                    chord.key_code,
                    chord.modifiers
                );
                return;
            }
            hot_key.registered = Some((chord, reference as usize));
        });
    }

    pub fn sync(coordinator: &AppCoordinator, background: bool) {
        if MainThreadMarker::new().is_none() {
            return;
        }
        let first = HOT_KEY.with(|h| {
            let mut hot_key = h.borrow_mut();
            hot_key.coordinator = coordinator.weak();
            hot_key.background = background;
            !std::mem::replace(&mut hot_key.watching, true)
        });
        if first {
            watch_activation();
        }
        refresh();
    }
}

impl AppCoordinator {
    pub(crate) fn sync_global_hotkey(&self) {
        #[cfg(target_os = "macos")]
        mac::sync(self, self.config.background);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::actions::Action;
    use ardia_state::ids::IdGen;
    use ardia_state::persistence::session::{LoadOptions, SessionData};
    use ardia_state::settings::SettingsPatch;
    use ardia_state::shortcuts::Modifiers;

    const US_KEYS: [(u16, char); 47] = [
        (0x00, 'a'),
        (0x01, 's'),
        (0x02, 'd'),
        (0x03, 'f'),
        (0x04, 'h'),
        (0x05, 'g'),
        (0x06, 'z'),
        (0x07, 'x'),
        (0x08, 'c'),
        (0x09, 'v'),
        (0x0B, 'b'),
        (0x0C, 'q'),
        (0x0D, 'w'),
        (0x0E, 'e'),
        (0x0F, 'r'),
        (0x10, 'y'),
        (0x11, 't'),
        (0x12, '1'),
        (0x13, '2'),
        (0x14, '3'),
        (0x15, '4'),
        (0x16, '6'),
        (0x17, '5'),
        (0x18, '='),
        (0x19, '9'),
        (0x1A, '7'),
        (0x1B, '-'),
        (0x1C, '8'),
        (0x1D, '0'),
        (0x1E, ']'),
        (0x1F, 'o'),
        (0x20, 'u'),
        (0x21, '['),
        (0x22, 'i'),
        (0x23, 'p'),
        (0x25, 'l'),
        (0x26, 'j'),
        (0x27, '\''),
        (0x28, 'k'),
        (0x29, ';'),
        (0x2A, '\\'),
        (0x2B, ','),
        (0x2C, '/'),
        (0x2D, 'n'),
        (0x2E, 'm'),
        (0x2F, '.'),
        (0x32, '`'),
    ];

    fn layout(swaps: &[(u16, char)]) -> Vec<Option<String>> {
        let mut typed = vec![None; usize::from(LAYOUT_KEY_CODES)];
        for (code, c) in US_KEYS.iter().chain(swaps) {
            typed[usize::from(*code)] = Some(c.to_string());
        }
        typed
    }

    fn us() -> Vec<Option<String>> {
        layout(&[])
    }

    fn german() -> Vec<Option<String>> {
        layout(&[(0x06, 'y'), (0x10, 'z'), (0x29, '\u{f6}'), (0x27, '\u{e4}')])
    }

    fn french() -> Vec<Option<String>> {
        layout(&[
            (0x00, 'q'),
            (0x0C, 'a'),
            (0x0D, 'z'),
            (0x06, 'w'),
            (0x29, 'm'),
            (0x2E, ','),
            (0x2B, ';'),
        ])
    }

    fn cmd(key: char) -> Shortcut {
        Shortcut::new(
            Key::Char(key),
            Modifiers {
                command: true,
                option: true,
                ..Modifiers::default()
            },
        )
    }

    #[test]
    fn key_codes_follow_the_live_keyboard_layout() {
        assert_eq!(key_code(Key::Char('z'), &us()), Some(0x06));
        assert_eq!(key_code(Key::Char('z'), &german()), Some(0x10));
        assert_eq!(key_code(Key::Char('Y'), &german()), Some(0x06));
        assert_eq!(key_code(Key::Char('\u{f6}'), &german()), Some(0x29));
        assert_eq!(key_code(Key::Char('a'), &french()), Some(0x0C));
        assert_eq!(key_code(Key::Char('m'), &french()), Some(0x29));
        assert_eq!(key_code(Key::Char('\u{f6}'), &us()), None);
        assert_eq!(
            chord(&cmd('z'), &german()).map(|c| c.key_code),
            Some(0x10),
            "a German layout registers Z where it sits, not the US key"
        );
        assert_eq!(key_code(Key::Function(5), &french()), Some(0x60));
        assert_eq!(key_code(Key::Space, &vec![None; 128]), Some(0x31));
        assert_eq!(key_code(Key::Char('n'), &[]), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_macs_own_layout_translates_its_keys() {
        let live = mac::live_layout();
        assert_eq!(live.len(), usize::from(LAYOUT_KEY_CODES));
        let typed = live.iter().filter(|t| t.is_some()).count();
        assert!(typed > 30, "only {typed} keys typed anything");
        assert!(key_code(Key::Char('1'), &live).is_some());
    }

    #[test]
    fn chords_need_command_control_or_a_function_key() {
        let cmd_opt_n = Shortcut::new(
            Key::Char('n'),
            Modifiers {
                command: true,
                option: true,
                ..Modifiers::default()
            },
        );
        assert_eq!(
            chord(&cmd_opt_n, &us()),
            Some(Chord {
                key_code: 0x2D,
                modifiers: CARBON_COMMAND | CARBON_OPTION
            })
        );
        let opt_n = Shortcut::new(
            Key::Char('n'),
            Modifiers {
                option: true,
                ..Modifiers::default()
            },
        );
        assert_eq!(chord(&opt_n, &us()), None);
        let f5 = Shortcut::new(Key::Function(5), Modifiers::default());
        assert_eq!(
            chord(&f5, &us()),
            Some(Chord {
                key_code: 0x60,
                modifiers: 0
            })
        );
        let fn_n = Shortcut::new(
            Key::Char('n'),
            Modifiers {
                command: true,
                function: true,
                ..Modifiers::default()
            },
        );
        assert_eq!(chord(&fn_n, &us()), None);
    }

    #[test]
    fn the_shortcut_is_wanted_only_from_other_apps_when_turned_on() {
        let ids = IdGen::with_launch("hotkey");
        let mut state = BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 1);
        assert_eq!(wanted(&state, false, us), None);
        state
            .apply(
                Action::UpdateSettings {
                    patch: SettingsPatch::new().set("littleArdiaShortcutFromAnyApp", true),
                    from_sync: false,
                },
                2,
                &ids,
            )
            .expect("settings");
        let expected = state
            .shortcut_map(Platform::current())
            .primary(COMMAND)
            .and_then(|shortcut| chord(shortcut, &us()));
        assert!(expected.is_some(), "Little Ardia has a default shortcut");
        assert_eq!(wanted(&state, false, us), expected);
        assert_eq!(wanted(&state, true, us), None);
        let moved = state
            .shortcut_map(Platform::current())
            .primary(COMMAND)
            .and_then(|shortcut| chord(shortcut, &french()));
        assert_eq!(wanted(&state, false, french), moved);
    }
}
