use std::sync::Arc;

use ardia_ui::primitives::text_editing::TextServices;
use futures::StreamExt;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use gpui::App;
use parking_lot::Mutex;

use crate::coordinator::AppCoordinator;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FieldCommand {
    Selector(String),
    Replace(String),
}

static COMMANDS: Mutex<Option<UnboundedSender<FieldCommand>>> = Mutex::new(None);

pub fn send(command: FieldCommand) -> bool {
    COMMANDS
        .lock()
        .as_ref()
        .is_some_and(|sender| sender.unbounded_send(command).is_ok())
}

pub fn utf16_range_to_utf8(text: &str, start: usize, len: usize) -> Option<std::ops::Range<usize>> {
    let mut utf16 = 0;
    let mut begin = None;
    let end_utf16 = start.checked_add(len)?;
    for (index, c) in text.char_indices() {
        if utf16 == start {
            begin = Some(index);
        }
        if utf16 == end_utf16 {
            return begin.map(|begin| begin..index);
        }
        utf16 += c.len_utf16();
    }
    if utf16 == start {
        begin = Some(text.len());
    }
    (utf16 == end_utf16).then_some(begin?..text.len())
}

pub fn utf8_to_utf16(text: &str, offset: usize) -> usize {
    text.get(..offset)
        .map_or(0, |head| head.chars().map(char::len_utf16).sum())
}

fn apply(command: FieldCommand, cx: &mut App) {
    let action: Option<Box<dyn gpui::Action>> = match command {
        FieldCommand::Selector(selector) => {
            ardia_ui::primitives::text_input::action_for_selector(&selector)
        }
        FieldCommand::Replace(text) => Some(Box::new(
            ardia_ui::primitives::text_input::ReplaceSelection { text },
        )),
    };
    let focused_window = ardia_ui::primitives::text_editing::focused_field().map(|f| f.window);
    let window = focused_window
        .and_then(|id| {
            cx.windows()
                .into_iter()
                .find(|handle| handle.window_id().as_u64() == id)
        })
        .or_else(|| cx.active_window());
    let (Some(action), Some(window)) = (action, window) else {
        return;
    };
    let _ = window.update(cx, |_, window, cx| window.dispatch_action(action, cx));
}

pub fn install(cx: &mut App, coordinator: Arc<AppCoordinator>) {
    let (sender, receiver): (
        UnboundedSender<FieldCommand>,
        UnboundedReceiver<FieldCommand>,
    ) = unbounded();
    *COMMANDS.lock() = Some(sender);
    let mut receiver = receiver;
    cx.spawn(async move |cx| {
        while let Some(command) = receiver.next().await {
            cx.update(|cx| apply(command, cx));
        }
    })
    .detach();
    #[cfg(target_os = "macos")]
    {
        TextServices::install(Arc::new(mac::MacTextServices::new(coordinator)), cx);
        mac::install_responder_hooks();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = coordinator;
}

#[cfg(target_os = "macos")]
pub mod mac {
    use std::cell::RefCell;
    use std::ffi::{CStr, c_char};
    use std::ops::Range;
    use std::sync::Arc;
    use std::sync::OnceLock;

    use ardia_ui::NativeMenuItem;
    use ardia_ui::primitives::text_editing::{
        LookUp, Substitutions, TextFieldServices, focused_field,
    };
    use ardia_ui::primitives::text_input::{FIELD_SELECTORS, selector_checked, selector_enabled};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, NSObject, Sel};
    use objc2::{MainThreadMarker, MainThreadOnly, class, define_class, msg_send, sel};
    use objc2_foundation::{NSPoint, NSRange, NSString};

    use super::{FieldCommand, send, utf8_to_utf16, utf16_range_to_utf8};
    use crate::coordinator::AppCoordinator;

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn EnableSecureEventInput() -> i32;
        fn DisableSecureEventInput() -> i32;
    }

    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {
        fn NSPerformService(item: *mut AnyObject, pasteboard: *mut AnyObject) -> Bool;
    }

    const NOT_FOUND: usize = isize::MAX as usize;
    const PLAIN_TEXT: &str = "public.utf8-plain-text";
    const SEARCH_SERVICE: &str = "Search With Google";

    thread_local! {
        static SPEECH: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
        static ACTIONS: RefCell<Option<Retained<FieldEditActions>>> = const { RefCell::new(None) };
    }

    fn ns(text: &str) -> Retained<NSString> {
        NSString::from_str(text)
    }

    unsafe fn string_of(object: *mut AnyObject) -> Option<String> {
        if object.is_null() {
            return None;
        }
        let utf8: *const c_char = unsafe { msg_send![object, UTF8String] };
        (!utf8.is_null()).then(|| {
            unsafe { CStr::from_ptr(utf8) }
                .to_string_lossy()
                .into_owned()
        })
    }

    fn spell_checker() -> Option<*mut AnyObject> {
        MainThreadMarker::new()?;
        let checker: *mut AnyObject =
            unsafe { msg_send![class!(NSSpellChecker), sharedSpellChecker] };
        (!checker.is_null()).then_some(checker)
    }

    fn spell_tag() -> isize {
        static TAG: OnceLock<isize> = OnceLock::new();
        *TAG.get_or_init(|| unsafe { msg_send![class!(NSSpellChecker), uniqueSpellDocumentTag] })
    }

    pub fn misspellings(text: &str) -> Vec<Range<usize>> {
        let Some(checker) = spell_checker() else {
            return Vec::new();
        };
        let string = ns(text);
        let total = utf8_to_utf16(text, text.len());
        let tag = spell_tag();
        let mut found = Vec::new();
        let mut start = 0usize;
        while start < total {
            let range: NSRange = unsafe {
                msg_send![
                    checker,
                    checkSpellingOfString: &*string,
                    startingAt: start as isize,
                    language: std::ptr::null_mut::<AnyObject>(),
                    wrap: false,
                    inSpellDocumentWithTag: tag,
                    wordCount: std::ptr::null_mut::<isize>()
                ]
            };
            if range.location == NOT_FOUND || range.length == 0 || range.location < start {
                break;
            }
            if let Some(utf8) = utf16_range_to_utf8(text, range.location, range.length) {
                found.push(utf8);
            }
            start = range.location + range.length;
        }
        found
    }

    pub fn guesses(text: &str, word: Range<usize>) -> Vec<String> {
        let Some(checker) = spell_checker() else {
            return Vec::new();
        };
        if word.end > text.len()
            || !text.is_char_boundary(word.start)
            || !text.is_char_boundary(word.end)
        {
            return Vec::new();
        }
        let range = NSRange::new(
            utf8_to_utf16(text, word.start),
            utf8_to_utf16(text, word.end) - utf8_to_utf16(text, word.start),
        );
        let string = ns(text);
        let list: *mut AnyObject = unsafe {
            msg_send![
                checker,
                guessesForWordRange: range,
                inString: &*string,
                language: std::ptr::null_mut::<AnyObject>(),
                inSpellDocumentWithTag: spell_tag()
            ]
        };
        if list.is_null() {
            return Vec::new();
        }
        let count: usize = unsafe { msg_send![list, count] };
        (0..count.min(8))
            .filter_map(|index| unsafe {
                let item: *mut AnyObject = msg_send![list, objectAtIndex: index];
                string_of(item)
            })
            .collect()
    }

    fn key_gpui_view() -> Option<*mut AnyObject> {
        MainThreadMarker::new()?;
        let app: *mut AnyObject = unsafe { msg_send![class!(NSApplication), sharedApplication] };
        if app.is_null() {
            return None;
        }
        let window: *mut AnyObject = unsafe { msg_send![app, keyWindow] };
        if window.is_null() {
            return None;
        }
        let gpui_view = AnyClass::get(c"GPUIView")?;
        let responder: *mut AnyObject = unsafe { msg_send![window, firstResponder] };
        if !responder.is_null() {
            let is_view: bool = unsafe { msg_send![responder, isKindOfClass: gpui_view] };
            if is_view {
                return Some(responder);
            }
        }
        None
    }

    fn default_flag(key: &str, fallback: bool) -> bool {
        if MainThreadMarker::new().is_none() {
            return fallback;
        }
        unsafe {
            let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
            if defaults.is_null() {
                return fallback;
            }
            let value: *mut AnyObject = msg_send![defaults, objectForKey: &*ns(key)];
            if value.is_null() {
                fallback
            } else {
                msg_send![defaults, boolForKey: &*ns(key)]
            }
        }
    }

    pub fn substitution_defaults() -> Substitutions {
        Substitutions {
            quotes: default_flag("NSAutomaticQuoteSubstitutionEnabled", false),
            dashes: default_flag("NSAutomaticDashSubstitutionEnabled", false),
            replacement: false,
            smart_insert: default_flag("NSSmartInsertDeleteEnabled", true),
            links: false,
            data: false,
        }
    }

    pub fn text_replacements() -> Vec<(String, String)> {
        let Some(checker) = spell_checker() else {
            return Vec::new();
        };
        unsafe {
            let table: *mut AnyObject = msg_send![checker, userReplacementsDictionary];
            if table.is_null() {
                return Vec::new();
            }
            let keys: *mut AnyObject = msg_send![table, allKeys];
            if keys.is_null() {
                return Vec::new();
            }
            let count: usize = msg_send![keys, count];
            (0..count.min(4096))
                .filter_map(|index| {
                    let key: *mut AnyObject = msg_send![keys, objectAtIndex: index];
                    let value: *mut AnyObject = msg_send![table, objectForKey: key];
                    Some((string_of(key)?, string_of(value)?))
                })
                .filter(|(from, _)| !from.is_empty())
                .collect()
        }
    }

    fn order_front_panel(selector: Sel) {
        let Some(checker) = spell_checker() else {
            return;
        };
        unsafe {
            let panel: *mut AnyObject = msg_send![checker, performSelector: selector];
            if !panel.is_null() {
                let _: () = msg_send![panel, orderFront: std::ptr::null_mut::<AnyObject>()];
            }
        }
    }

    pub struct MacTextServices {
        coordinator: Arc<AppCoordinator>,
    }

    impl MacTextServices {
        pub fn new(coordinator: Arc<AppCoordinator>) -> Self {
            MacTextServices { coordinator }
        }
    }

    impl TextFieldServices for MacTextServices {
        fn show_menu(
            &self,
            items: Vec<NativeMenuItem>,
        ) -> Option<futures::channel::oneshot::Receiver<Option<String>>> {
            Some(self.coordinator.native_menu(items))
        }

        fn can_paste(&self) -> bool {
            if MainThreadMarker::new().is_none() {
                return true;
            }
            unsafe {
                let board: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
                if board.is_null() {
                    return false;
                }
                let types: *mut AnyObject =
                    msg_send![class!(NSArray), arrayWithObject: &*ns(PLAIN_TEXT)];
                let found: *mut AnyObject = msg_send![board, availableTypeFromArray: types];
                !found.is_null()
            }
        }

        fn misspelled_ranges(&self, text: &str) -> Vec<Range<usize>> {
            misspellings(text)
        }

        fn guesses(&self, text: &str, word: Range<usize>) -> Vec<String> {
            guesses(text, word)
        }

        fn ignore_word(&self, word: &str) {
            if let Some(checker) = spell_checker() {
                let _: () = unsafe {
                    msg_send![checker, ignoreWord: &*ns(word), inSpellDocumentWithTag: spell_tag()]
                };
            }
        }

        fn learn_word(&self, word: &str) {
            if let Some(checker) = spell_checker() {
                let _: () = unsafe { msg_send![checker, learnWord: &*ns(word)] };
            }
        }

        fn look_up(&self, request: LookUp) {
            let Some(view) = key_gpui_view() else {
                return;
            };
            unsafe {
                let font: *mut AnyObject =
                    msg_send![class!(NSFont), systemFontOfSize: f64::from(request.font_size)];
                let attributes: *mut AnyObject = msg_send![
                    class!(NSDictionary),
                    dictionaryWithObject: font,
                    forKey: &*ns("NSFont")
                ];
                let allocated: *mut AnyObject = msg_send![class!(NSAttributedString), alloc];
                let made: *mut AnyObject = msg_send![
                    allocated,
                    initWithString: &*ns(&request.text),
                    attributes: attributes
                ];
                let Some(text) = Retained::from_raw(made) else {
                    return;
                };
                let flipped: bool = msg_send![view, isFlipped];
                let bounds: objc2_foundation::NSRect = msg_send![view, bounds];
                let x = f64::from(f32::from(request.baseline_origin.x));
                let y = f64::from(f32::from(request.baseline_origin.y));
                let point = NSPoint::new(x, if flipped { y } else { bounds.size.height - y });
                let _: () =
                    msg_send![view, showDefinitionForAttributedString: &*text, atPoint: point];
            }
        }

        fn search_web(&self, text: &str) {
            if MainThreadMarker::new().is_none() || text.trim().is_empty() {
                return;
            }
            unsafe {
                let board: *mut AnyObject =
                    msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
                if board.is_null() {
                    return;
                }
                let _: isize = msg_send![board, clearContents];
                let _: bool = msg_send![board, setString: &*ns(text), forType: &*ns(PLAIN_TEXT)];
                let service = ns(SEARCH_SERVICE);
                let performed = NSPerformService(
                    Retained::as_ptr(&service).cast::<AnyObject>().cast_mut(),
                    board,
                );
                if !performed.as_bool() {
                    log::debug!("the Search With Google service didn't run");
                }
            }
        }

        fn speak(&self, text: &str) {
            if MainThreadMarker::new().is_none() {
                return;
            }
            SPEECH.with(|slot| {
                let mut slot = slot.borrow_mut();
                if slot.is_none() {
                    let created: Option<Retained<AnyObject>> = unsafe {
                        let allocated: *mut AnyObject =
                            msg_send![class!(NSSpeechSynthesizer), alloc];
                        let made: *mut AnyObject =
                            msg_send![allocated, initWithVoice: std::ptr::null_mut::<AnyObject>()];
                        Retained::from_raw(made)
                    };
                    *slot = created;
                }
                if let Some(synth) = slot.as_ref() {
                    let _: bool = unsafe { msg_send![&**synth, startSpeakingString: &*ns(text)] };
                }
            });
        }

        fn stop_speaking(&self) {
            SPEECH.with(|slot| {
                if let Some(synth) = slot.borrow().as_ref() {
                    let _: () = unsafe { msg_send![&**synth, stopSpeaking] };
                }
            });
        }

        fn is_speaking(&self) -> bool {
            SPEECH.with(|slot| {
                slot.borrow()
                    .as_ref()
                    .is_some_and(|synth| unsafe { msg_send![&**synth, isSpeaking] })
            })
        }

        fn substitution_defaults(&self) -> Substitutions {
            substitution_defaults()
        }

        fn text_replacements(&self) -> Vec<(String, String)> {
            text_replacements()
        }

        fn show_spelling_panel(&self) {
            order_front_panel(sel!(spellingPanel));
        }

        fn update_spelling_panel(&self, word: &str) {
            if let Some(checker) = spell_checker() {
                let _: () = unsafe {
                    msg_send![checker, updateSpellingPanelWithMisspelledWord: &*ns(word)]
                };
            }
        }

        fn show_substitutions_panel(&self) {
            order_front_panel(sel!(substitutionsPanel));
        }

        fn share(&self, text: &str, anchor: gpui::Bounds<gpui::Pixels>) {
            let Some(view) = key_gpui_view() else {
                return;
            };
            unsafe {
                let items: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: &*ns(text)];
                let allocated: *mut AnyObject = msg_send![class!(NSSharingServicePicker), alloc];
                let made: *mut AnyObject = msg_send![allocated, initWithItems: items];
                let Some(picker) = Retained::from_raw(made) else {
                    return;
                };
                let flipped: bool = msg_send![view, isFlipped];
                let bounds: objc2_foundation::NSRect = msg_send![view, bounds];
                let x = f64::from(f32::from(anchor.origin.x));
                let top = f64::from(f32::from(anchor.origin.y));
                let height = f64::from(f32::from(anchor.size.height));
                let width = f64::from(f32::from(anchor.size.width)).max(1.0);
                let y = if flipped {
                    top
                } else {
                    bounds.size.height - top - height
                };
                let rect = objc2_foundation::NSRect::new(
                    NSPoint::new(x, y),
                    objc2_foundation::NSSize::new(width, height),
                );
                let min_y_edge: usize = if flipped { 3 } else { 1 };
                let _: () = msg_send![
                    &*picker,
                    showRelativeToRect: rect,
                    ofView: view,
                    preferredEdge: min_y_edge
                ];
            }
        }

        fn set_secure_input(&self, on: bool) {
            let status = unsafe {
                if on {
                    EnableSecureEventInput()
                } else {
                    DisableSecureEventInput()
                }
            };
            if status != 0 {
                log::debug!("secure event input {on} failed: {status}");
            }
        }
    }

    fn selector_name(selector: Sel) -> String {
        selector.name().to_string_lossy().into_owned()
    }

    fn handles(selector: Sel) -> bool {
        let name = selector_name(selector);
        FIELD_SELECTORS.contains(&name.as_str())
    }

    unsafe fn is_first_responder(view: *mut AnyObject) -> bool {
        if view.is_null() {
            return false;
        }
        unsafe {
            let window: *mut AnyObject = msg_send![view, window];
            if window.is_null() {
                return false;
            }
            let responder: *mut AnyObject = msg_send![window, firstResponder];
            responder == view
        }
    }

    fn actions_object() -> Option<*mut AnyObject> {
        let mtm = MainThreadMarker::new()?;
        ACTIONS.with(|slot| {
            let mut slot = slot.borrow_mut();
            let actions = slot.get_or_insert_with(|| FieldEditActions::new(mtm));
            Some(Retained::as_ptr(actions) as *mut AnyObject)
        })
    }

    fn speaking() -> bool {
        SPEECH.with(|slot| {
            slot.borrow()
                .as_ref()
                .is_some_and(|synth| unsafe { msg_send![&**synth, isSpeaking] })
        })
    }

    fn pasteboard_has_text() -> bool {
        unsafe {
            let board: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
            if board.is_null() {
                return false;
            }
            let types: *mut AnyObject =
                msg_send![class!(NSArray), arrayWithObject: &*ns(PLAIN_TEXT)];
            let found: *mut AnyObject = msg_send![board, availableTypeFromArray: types];
            !found.is_null()
        }
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArdiaGpuiFieldEditActions"]
        pub struct FieldEditActions;

        impl FieldEditActions {
            #[unsafe(method(undo:))]
            fn undo(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("undo:".into()));
            }

            #[unsafe(method(redo:))]
            fn redo(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("redo:".into()));
            }

            #[unsafe(method(cut:))]
            fn cut(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("cut:".into()));
            }

            #[unsafe(method(copy:))]
            fn copy(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("copy:".into()));
            }

            #[unsafe(method(paste:))]
            fn paste(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("paste:".into()));
            }

            #[unsafe(method(pasteAsPlainText:))]
            fn paste_plain(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("pasteAsPlainText:".into()));
            }

            #[unsafe(method(delete:))]
            fn delete(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("delete:".into()));
            }

            #[unsafe(method(selectAll:))]
            fn select_all(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("selectAll:".into()));
            }

            #[unsafe(method(checkSpelling:))]
            fn check_spelling(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("checkSpelling:".into()));
            }

            #[unsafe(method(toggleContinuousSpellChecking:))]
            fn toggle_spelling(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("toggleContinuousSpellChecking:".into()));
            }

            #[unsafe(method(uppercaseWord:))]
            fn uppercase(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("uppercaseWord:".into()));
            }

            #[unsafe(method(lowercaseWord:))]
            fn lowercase(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("lowercaseWord:".into()));
            }

            #[unsafe(method(capitalizeWord:))]
            fn capitalize(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("capitalizeWord:".into()));
            }

            #[unsafe(method(startSpeaking:))]
            fn start_speaking(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("startSpeaking:".into()));
            }

            #[unsafe(method(stopSpeaking:))]
            fn stop_speaking(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("stopSpeaking:".into()));
            }

            #[unsafe(method(showGuessPanel:))]
            fn show_guess_panel(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("showGuessPanel:".into()));
            }

            #[unsafe(method(changeSpelling:))]
            fn change_spelling(&self, sender: Option<&AnyObject>) {
                if let Some(word) = sender.and_then(selected_cell_text) {
                    send(FieldCommand::Replace(word));
                    send(FieldCommand::Selector("changeSpelling:".into()));
                }
            }

            #[unsafe(method(ignoreSpelling:))]
            fn ignore_spelling(&self, sender: Option<&AnyObject>) {
                if let (Some(word), Some(checker)) =
                    (sender.and_then(selected_cell_text), spell_checker())
                {
                    let _: () = unsafe {
                        msg_send![checker, ignoreWord: &*ns(&word), inSpellDocumentWithTag: spell_tag()]
                    };
                    send(FieldCommand::Selector("ignoreSpelling:".into()));
                }
            }

            #[unsafe(method(orderFrontSubstitutionsPanel:))]
            fn substitutions_panel(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("orderFrontSubstitutionsPanel:".into()));
            }

            #[unsafe(method(toggleSmartInsertDelete:))]
            fn toggle_smart_insert(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("toggleSmartInsertDelete:".into()));
            }

            #[unsafe(method(toggleAutomaticQuoteSubstitution:))]
            fn toggle_quotes(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("toggleAutomaticQuoteSubstitution:".into()));
            }

            #[unsafe(method(toggleAutomaticDashSubstitution:))]
            fn toggle_dashes(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("toggleAutomaticDashSubstitution:".into()));
            }

            #[unsafe(method(toggleAutomaticLinkDetection:))]
            fn toggle_links(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("toggleAutomaticLinkDetection:".into()));
            }

            #[unsafe(method(toggleAutomaticDataDetection:))]
            fn toggle_data(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("toggleAutomaticDataDetection:".into()));
            }

            #[unsafe(method(toggleAutomaticTextReplacement:))]
            fn toggle_replacement(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("toggleAutomaticTextReplacement:".into()));
            }

            #[unsafe(method(replaceQuotesInSelection:))]
            fn replace_quotes(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("replaceQuotesInSelection:".into()));
            }

            #[unsafe(method(replaceDashesInSelection:))]
            fn replace_dashes(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("replaceDashesInSelection:".into()));
            }

            #[unsafe(method(replaceTextInSelection:))]
            fn replace_text(&self, _sender: Option<&AnyObject>) {
                send(FieldCommand::Selector("replaceTextInSelection:".into()));
            }

            #[unsafe(method(validateMenuItem:))]
            fn validate_menu_item(&self, item: &AnyObject) -> bool {
                validate_item(item)
            }

            #[unsafe(method(writeSelectionToPasteboard:types:))]
            fn write_selection(&self, board: &AnyObject, _types: Option<&AnyObject>) -> bool {
                write_selection_to(board)
            }

            #[unsafe(method(readSelectionFromPasteboard:))]
            fn read_selection(&self, board: &AnyObject) -> bool {
                read_selection_from(board)
            }
        }
    );

    fn validate_item(item: &AnyObject) -> bool {
        let action: Option<Sel> = unsafe { msg_send![item, action] };
        let (Some(action), Some(field)) = (action, focused_field()) else {
            return false;
        };
        let name = selector_name(action);
        if let Some(checked) = selector_checked(&name, &field) {
            let state: isize = if checked { 1 } else { 0 };
            let _: () = unsafe { msg_send![item, setState: state] };
        }
        let can_paste =
            matches!(name.as_str(), "paste:" | "pasteAsPlainText:") && pasteboard_has_text();
        selector_enabled(&name, &field, can_paste, speaking())
    }

    fn selected_cell_text(sender: &AnyObject) -> Option<String> {
        unsafe {
            let responds: bool = msg_send![sender, respondsToSelector: sel!(selectedCell)];
            if !responds {
                return None;
            }
            let cell: *mut AnyObject = msg_send![sender, selectedCell];
            if cell.is_null() {
                return None;
            }
            let value: *mut AnyObject = msg_send![cell, stringValue];
            string_of(value).filter(|text| !text.is_empty())
        }
    }

    fn write_selection_to(board: &AnyObject) -> bool {
        let Some(field) = focused_field().filter(|f| !f.secure && f.has_selection) else {
            return false;
        };
        unsafe {
            let _: isize = msg_send![board, clearContents];
            msg_send![board, setString: &*ns(&field.selected_text), forType: &*ns(PLAIN_TEXT)]
        }
    }

    fn read_selection_from(board: &AnyObject) -> bool {
        let text: *mut AnyObject = unsafe { msg_send![board, stringForType: &*ns(PLAIN_TEXT)] };
        match unsafe { string_of(text) } {
            Some(text) => send(FieldCommand::Replace(text)),
            None => false,
        }
    }

    impl FieldEditActions {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            unsafe { msg_send![Self::alloc(mtm), init] }
        }
    }

    type SupplementalTarget =
        unsafe extern "C-unwind" fn(*mut AnyObject, Sel, Sel, *mut AnyObject) -> *mut AnyObject;
    type ValidRequestor = unsafe extern "C-unwind" fn(
        *mut AnyObject,
        Sel,
        *mut AnyObject,
        *mut AnyObject,
    ) -> *mut AnyObject;

    fn inherited(selector: Sel) -> Option<Imp> {
        AnyClass::get(c"NSView")?
            .instance_method(selector)
            .map(|method| method.implementation())
    }

    unsafe extern "C-unwind" fn supplemental_target(
        this: *mut AnyObject,
        cmd: Sel,
        action: Sel,
        sender: *mut AnyObject,
    ) -> *mut AnyObject {
        if handles(action)
            && focused_field().is_some()
            && unsafe { is_first_responder(this) }
            && let Some(actions) = actions_object()
        {
            return actions;
        }
        match inherited(cmd) {
            Some(imp) => unsafe {
                let next: SupplementalTarget = std::mem::transmute(imp);
                next(this, cmd, action, sender)
            },
            None => std::ptr::null_mut(),
        }
    }

    unsafe fn is_plain_text_type(kind: *mut AnyObject) -> bool {
        if kind.is_null() {
            return true;
        }
        let name = unsafe { string_of(kind) }.unwrap_or_default();
        name == PLAIN_TEXT || name == "NSStringPboardType"
    }

    unsafe extern "C-unwind" fn valid_requestor(
        this: *mut AnyObject,
        cmd: Sel,
        send_type: *mut AnyObject,
        return_type: *mut AnyObject,
    ) -> *mut AnyObject {
        let serves = unsafe {
            is_first_responder(this)
                && is_plain_text_type(send_type)
                && is_plain_text_type(return_type)
                && (!send_type.is_null() || !return_type.is_null())
        };
        if serves
            && let Some(field) = focused_field().filter(|field| !field.secure)
            && (send_type.is_null() || field.has_selection)
            && let Some(actions) = actions_object()
        {
            return actions;
        }
        match inherited(cmd) {
            Some(imp) => unsafe {
                let next: ValidRequestor = std::mem::transmute(imp);
                next(this, cmd, send_type, return_type)
            },
            None => std::ptr::null_mut(),
        }
    }

    pub fn install_responder_hooks() {
        static INSTALLED: OnceLock<bool> = OnceLock::new();
        INSTALLED.get_or_init(|| {
            if MainThreadMarker::new().is_none() {
                return false;
            }
            let Some(view) = AnyClass::get(c"GPUIView") else {
                log::warn!("text field menu hooks: GPUIView isn't registered");
                return false;
            };
            let class = view as *const AnyClass as *mut AnyClass;
            let supplemental: SupplementalTarget = supplemental_target;
            let requestor: ValidRequestor = valid_requestor;
            let added = unsafe {
                let first = objc2::ffi::class_addMethod(
                    class,
                    sel!(supplementalTargetForAction:sender:),
                    std::mem::transmute::<SupplementalTarget, Imp>(supplemental),
                    c"@@::@".as_ptr(),
                );
                let second = objc2::ffi::class_addMethod(
                    class,
                    sel!(validRequestorForSendType:returnType:),
                    std::mem::transmute::<ValidRequestor, Imp>(requestor),
                    c"@@:@@".as_ptr(),
                );
                first.as_bool() && second.as_bool()
            };
            unsafe {
                let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                let types: *mut AnyObject =
                    msg_send![class!(NSArray), arrayWithObject: &*ns(PLAIN_TEXT)];
                if !app.is_null() {
                    let _: () =
                        msg_send![app, registerServicesMenuSendTypes: types, returnTypes: types];
                }
            }
            if added {
                log::info!("text field menu hooks installed on GPUIView");
            } else {
                log::warn!("text field menu hooks: GPUIView already answers these selectors");
            }
            added
        });
    }

    pub fn hooks_installed() -> bool {
        AnyClass::get(c"GPUIView").is_some_and(|view| {
            view.instance_method(sel!(supplementalTargetForAction:sender:))
                .is_some_and(|method| {
                    let ours: SupplementalTarget = supplemental_target;
                    method.implementation() as usize == ours as usize
                })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_ranges_map_back_to_utf8() {
        let text = "h\u{e9}llo w\u{1F44D}rld";
        assert_eq!(utf16_range_to_utf8(text, 0, 5), Some(0..6));
        assert_eq!(utf16_range_to_utf8(text, 6, 6), Some(7..text.len()));
        assert_eq!(utf16_range_to_utf8(text, 7, 2), Some(8..12));
        assert_eq!(utf16_range_to_utf8(text, 8, 1), None);
        assert_eq!(utf16_range_to_utf8("", 0, 0), Some(0..0));
        assert_eq!(utf8_to_utf16(text, 12), 9);
    }

    #[test]
    fn commands_queue_only_after_install() {
        *COMMANDS.lock() = None;
        assert!(!send(FieldCommand::Selector("undo:".into())));
        let (sender, mut receiver) = unbounded();
        *COMMANDS.lock() = Some(sender);
        assert!(send(FieldCommand::Replace("x".into())));
        assert_eq!(
            receiver.try_recv().ok(),
            Some(FieldCommand::Replace("x".into()))
        );
        *COMMANDS.lock() = None;
    }
}
