#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
fn main() {
    std::process::exit(macos::run());
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::{Cell, RefCell};
    use std::ffi::{CStr, c_char, c_void};
    use std::ptr::{self, NonNull};
    use std::rc::Rc;
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use ardia_app::hosted_input::GpuiInputRoutes;
    use ardia_engine::macos::{
        HostedWindowHooks, HostedWindowRoutes, SuperCall, hosted_hooks_installed,
        install_hosted_window_hooks, retain_window, style_browser_window,
    };
    use ardia_engine::{EngineError, EngineWindowId, NativeWindow};
    use gpui::{
        Bounds, ContentMask, Context, DispatchEventResult, ExternalWindowHandle, HitboxId, Hsla,
        IntoElement, NativeViewId, PaintNativeView, Platform, PlatformInput, PlatformWindow,
        Render, ScaledPixels, Scene, Window, WindowHandle, WindowId, WindowKind, WindowParams, div,
        point, px, size,
    };
    use gpui_macos::MacPlatform;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{class, msg_send, sel};
    use raw_window_handle::RawWindowHandle;

    type Check = fn() -> Result<(), String>;

    fn ensure(condition: bool, what: impl Into<String>) -> Result<(), String> {
        if condition { Ok(()) } else { Err(what.into()) }
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    unsafe impl objc2::Encode for Rect {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
            "CGRect",
            &[
                objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]),
                objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]),
            ],
        );
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }

    unsafe impl objc2::Encode for Point {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    #[repr(C)]
    #[derive(Clone, Copy, PartialEq, Debug)]
    struct Extent {
        width: f64,
        height: f64,
    }

    unsafe impl objc2::Encode for Extent {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *mut AnyObject;
    }

    fn window_server_layer(window: &AnyObject) -> Option<i64> {
        unsafe {
            let number: isize = msg_send![window, windowNumber];
            let list = CGWindowListCopyWindowInfo(1 << 3, u32::try_from(number).ok()?);
            if list.is_null() {
                return None;
            }
            let count: usize = msg_send![list, count];
            let layer = if count == 0 {
                None
            } else {
                let info: *mut AnyObject = msg_send![list, objectAtIndex: 0usize];
                let key = ns_string(c"kCGWindowLayer");
                let value: *mut AnyObject = msg_send![info, objectForKey: &*key];
                (!value.is_null()).then(|| {
                    let layer: i64 = msg_send![value, longLongValue];
                    layer
                })
            };
            let _: () = msg_send![list, release];
            layer
        }
    }

    fn text_of(string: *mut AnyObject) -> String {
        if string.is_null() {
            return String::new();
        }
        unsafe {
            let text: *const c_char = msg_send![string, UTF8String];
            CStr::from_ptr(text).to_string_lossy().into_owned()
        }
    }

    struct Blank;

    impl Render for Blank {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }

    thread_local! {
        static PAGE_KEYS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
        static CHILD_SENDS: Cell<usize> = const { Cell::new(0) };
    }

    static FOREIGN_NEXT: AtomicUsize = AtomicUsize::new(0);
    static FOREIGN_SENDS: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "C" {
        fn class_getInstanceMethod(class: *const AnyClass, selector: Sel) -> *mut c_void;
        fn method_setImplementation(
            method: *mut c_void,
            implementation: *const c_void,
        ) -> *const c_void;
    }

    fn set_implementation(class: &AnyClass, selector: Sel, implementation: usize) {
        unsafe {
            let method = class_getInstanceMethod(class, selector);
            assert!(!method.is_null(), "the class answers the selector");
            method_setImplementation(method, implementation as *const c_void);
        }
    }

    fn foreign_implementation() -> usize {
        foreign_send_event as extern "C" fn(&AnyObject, Sel, *mut AnyObject) as *const () as usize
    }

    extern "C" fn foreign_send_event(this: &AnyObject, selector: Sel, event: *mut AnyObject) {
        FOREIGN_SENDS.fetch_add(1, Ordering::Relaxed);
        let next = FOREIGN_NEXT.load(Ordering::Relaxed);
        if next != 0 {
            let next: extern "C" fn(&AnyObject, Sel, *mut AnyObject) =
                unsafe { std::mem::transmute(next) };
            next(this, selector, event);
        }
    }

    #[derive(Clone, Default)]
    struct Counts {
        send_event: Rc<Cell<usize>>,
        key_down: Rc<Cell<usize>>,
        make_first_responder: Rc<Cell<usize>>,
        perform_key_equivalent: Rc<Cell<usize>>,
    }

    impl Counts {
        fn total(&self) -> usize {
            self.send_event.get()
                + self.key_down.get()
                + self.make_first_responder.get()
                + self.perform_key_equivalent.get()
        }
    }

    struct Counting {
        counts: Counts,
        inner: GpuiInputRoutes,
    }

    fn bump(cell: &Cell<usize>) {
        cell.set(cell.get() + 1);
    }

    impl HostedWindowRoutes for Counting {
        fn send_event(
            &self,
            window: NonNull<c_void>,
            event: NonNull<c_void>,
            call_super: SuperCall<'_, ()>,
        ) {
            bump(&self.counts.send_event);
            self.inner.send_event(window, event, call_super)
        }

        fn key_down(
            &self,
            window: NonNull<c_void>,
            event: NonNull<c_void>,
            call_super: SuperCall<'_, ()>,
        ) {
            bump(&self.counts.key_down);
            self.inner.key_down(window, event, call_super)
        }

        fn make_first_responder(
            &self,
            window: NonNull<c_void>,
            responder: Option<NonNull<c_void>>,
            call_super: SuperCall<'_, bool>,
        ) -> bool {
            bump(&self.counts.make_first_responder);
            self.inner
                .make_first_responder(window, responder, call_super)
        }

        fn perform_key_equivalent(
            &self,
            window: NonNull<c_void>,
            event: NonNull<c_void>,
            call_super: SuperCall<'_, bool>,
        ) -> bool {
            bump(&self.counts.perform_key_equivalent);
            self.inner.perform_key_equivalent(window, event, call_super)
        }
    }

    fn install() -> Result<(HostedWindowHooks, Counts), String> {
        let counts = Counts::default();
        let hooks = install_hosted_window_hooks(Counting {
            counts: counts.clone(),
            inner: GpuiInputRoutes,
        })
        .map_err(|e| format!("install: {e}"))?;
        Ok((hooks, counts))
    }

    fn host_window(class: &AnyClass) -> Retained<AnyObject> {
        let frame = Rect {
            x: 0.,
            y: 0.,
            width: 800.,
            height: 600.,
        };
        unsafe {
            let window: *mut AnyObject = msg_send![class, alloc];
            let window: *mut AnyObject = msg_send![
                window,
                initWithContentRect: frame,
                styleMask: 15usize,
                backing: 2usize,
                defer: Bool::YES
            ];
            let window = Retained::from_raw(window).expect("an NSWindow");
            let _: () = msg_send![&*window, setReleasedWhenClosed: Bool::NO];
            window
        }
    }

    fn native(window: &AnyObject) -> NativeWindow {
        unsafe { retain_window(window as *const AnyObject as *mut c_void) }.expect("a window")
    }

    fn page_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder = ClassBuilder::new(c"ArdiaHostedTestPage", class!(NSView))
                .expect("a fresh view class");
            unsafe {
                builder.add_method(
                    sel!(acceptsFirstResponder),
                    accepts_first_responder as extern "C" fn(_, Sel) -> Bool,
                );
                builder.add_method(
                    sel!(keyDown:),
                    page_key_down as extern "C" fn(_, Sel, *mut AnyObject),
                );
            }
            builder.register()
        })
    }

    extern "C" fn accepts_first_responder(_: &AnyObject, _: Sel) -> Bool {
        Bool::YES
    }

    extern "C" fn page_key_down(_: &AnyObject, _: Sel, event: *mut AnyObject) {
        let text = unsafe {
            let characters: *mut AnyObject = msg_send![event, characters];
            let text: *const c_char = msg_send![characters, UTF8String];
            CStr::from_ptr(text).to_string_lossy().into_owned()
        };
        PAGE_KEYS.with_borrow_mut(|keys| keys.push(text));
    }

    fn child_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder = ClassBuilder::new(c"ArdiaHostedTestChildWindow", class!(NSWindow))
                .expect("a fresh window class");
            unsafe {
                builder.add_method(
                    sel!(sendEvent:),
                    child_send_event as extern "C" fn(_, Sel, *mut AnyObject),
                );
            }
            builder.register()
        })
    }

    extern "C" fn child_send_event(this: &AnyObject, _: Sel, event: *mut AnyObject) {
        CHILD_SENDS.with(|sends| sends.set(sends.get() + 1));
        unsafe {
            let _: () = msg_send![super(this, class!(NSWindow)), sendEvent: event];
        }
    }

    fn owning_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder = ClassBuilder::new(c"ArdiaHostedTestOwningWindow", class!(NSWindow))
                .expect("a fresh window class");
            unsafe {
                builder.add_method(
                    sel!(sendEvent:),
                    own_send_event as extern "C" fn(_, Sel, *mut AnyObject),
                );
                builder.add_method(
                    sel!(keyDown:),
                    own_key_down as extern "C" fn(_, Sel, *mut AnyObject),
                );
                builder.add_method(
                    sel!(makeFirstResponder:),
                    own_make_first_responder as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
                );
                builder.add_method(
                    sel!(performKeyEquivalent:),
                    own_perform_key_equivalent as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
                );
            }
            builder.register()
        })
    }

    extern "C" fn own_send_event(this: &AnyObject, _: Sel, event: *mut AnyObject) {
        unsafe {
            let _: () = msg_send![super(this, class!(NSWindow)), sendEvent: event];
        }
    }

    extern "C" fn own_key_down(this: &AnyObject, _: Sel, event: *mut AnyObject) {
        unsafe {
            let _: () = msg_send![super(this, class!(NSWindow)), keyDown: event];
        }
    }

    extern "C" fn own_make_first_responder(
        this: &AnyObject,
        _: Sel,
        responder: *mut AnyObject,
    ) -> Bool {
        unsafe { msg_send![super(this, class!(NSWindow)), makeFirstResponder: responder] }
    }

    extern "C" fn own_perform_key_equivalent(
        this: &AnyObject,
        _: Sel,
        event: *mut AnyObject,
    ) -> Bool {
        unsafe { msg_send![super(this, class!(NSWindow)), performKeyEquivalent: event] }
    }

    fn displaced_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder =
                ClassBuilder::new(c"ArdiaHostedTestDisplacedWindow", class!(NSWindow))
                    .expect("a fresh window class");
            unsafe {
                builder.add_method(
                    sel!(sendEvent:),
                    own_send_event as extern "C" fn(_, Sel, *mut AnyObject),
                );
            }
            builder.register()
        })
    }

    fn implementation(class: &AnyClass, selector: Sel) -> usize {
        class
            .instance_method(selector)
            .map_or(0, |method| method.implementation() as usize)
    }

    fn ns_string(text: &CStr) -> Retained<AnyObject> {
        unsafe { msg_send![class!(NSString), stringWithUTF8String: text.as_ptr()] }
    }

    fn key_event(
        window: &AnyObject,
        key: &CStr,
        key_code: u16,
        command: bool,
    ) -> Retained<AnyObject> {
        let characters = ns_string(key);
        unsafe {
            let window_number: isize = msg_send![window, windowNumber];
            let modifiers: usize = if command { 1 << 20 } else { 0 };
            let event: *mut AnyObject = msg_send![
                class!(NSEvent),
                keyEventWithType: 10usize,
                location: Point { x: 0., y: 0. },
                modifierFlags: modifiers,
                timestamp: 0f64,
                windowNumber: window_number,
                context: ptr::null_mut::<AnyObject>(),
                characters: &*characters,
                charactersIgnoringModifiers: &*characters,
                isARepeat: Bool::NO,
                keyCode: key_code
            ];
            Retained::retain(event).expect("a key event")
        }
    }

    fn mouse_down(window: &AnyObject, x: f64, y: f64) -> Retained<AnyObject> {
        unsafe {
            let window_number: isize = msg_send![window, windowNumber];
            let event: *mut AnyObject = msg_send![
                class!(NSEvent),
                mouseEventWithType: 1usize,
                location: Point { x, y },
                modifierFlags: 0usize,
                timestamp: 0f64,
                windowNumber: window_number,
                context: ptr::null_mut::<AnyObject>(),
                eventNumber: 0isize,
                clickCount: 1isize,
                pressure: 1f32
            ];
            Retained::retain(event).expect("a mouse event")
        }
    }

    const ACTIVATION_DEADLINE: f64 = 3.0;
    const MAIN_QUEUE_STEP: f64 = 0.05;

    fn run_main_queue_until(deadline: f64, done: impl Fn() -> bool) -> bool {
        let mut waited = 0.0;
        while waited < deadline {
            if done() {
                return true;
            }
            run_main_queue(MAIN_QUEUE_STEP);
            waited += MAIN_QUEUE_STEP;
        }
        done()
    }

    fn run_main_queue(seconds: f64) {
        unsafe {
            let run_loop: *mut AnyObject = msg_send![class!(NSRunLoop), currentRunLoop];
            let until: *mut AnyObject =
                msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: seconds];
            let _: () = msg_send![run_loop, runUntilDate: until];
        }
    }

    fn scaled(x: f32, y: f32, width: f32, height: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(y)),
            size: size(ScaledPixels(width), ScaledPixels(height)),
        }
    }

    fn hosted_params(window: &AnyObject, host_view: Option<&AnyObject>) -> WindowParams {
        WindowParams {
            bounds: Bounds::new(point(px(0.), px(0.)), size(px(800.), px(600.))),
            titlebar: None,
            kind: WindowKind::Normal,
            is_movable: true,
            app_owns_titlebar_drag: false,
            is_resizable: true,
            is_minimizable: true,
            focus: false,
            show: false,
            icon: None,
            display_id: None,
            app_id: None,
            window_min_size: None,
            tabbing_identifier: None,
            use_display_p3: false,
            host_window: Some(unsafe {
                ExternalWindowHandle::new(
                    NonNull::from(window).cast::<c_void>(),
                    host_view.map(|view| NonNull::from(view).cast::<c_void>()),
                )
            }),
        }
    }

    fn open_hosted(
        platform: &Rc<dyn Platform>,
        id: u64,
        window: &AnyObject,
        host_view: Option<&AnyObject>,
    ) -> Result<(Box<dyn PlatformWindow>, *mut AnyObject), String> {
        let handle = WindowHandle::<Blank>::new(WindowId::from(id)).into();
        let window = platform
            .open_window(handle, hosted_params(window, host_view))
            .map_err(|e| e.to_string())?;
        let gpui_view = match window.window_handle().map(|handle| handle.as_raw()) {
            Ok(RawWindowHandle::AppKit(handle)) => handle.ns_view.as_ptr().cast::<AnyObject>(),
            _ => return Err("a hosted window has an AppKit view".into()),
        };
        Ok((window, gpui_view))
    }

    fn page_view(id: u64, bounds: Bounds<ScaledPixels>) -> PaintNativeView {
        PaintNativeView::new(
            NativeViewId::for_test(id),
            HitboxId::placeholder(),
            bounds,
            ContentMask {
                bounds: scaled(0., 0., 1600., 1200.),
            },
            Hsla::default(),
        )
    }

    fn hooks_install_once_and_track_windows() -> Result<(), String> {
        let (hooks, _) = install()?;
        ensure(hosted_hooks_installed(), "the bridge reports the hooks")?;
        let second = install_hosted_window_hooks(GpuiInputRoutes);
        ensure(
            matches!(second, Err(EngineError::AlreadyRunning)),
            format!("a second install was {second:?}"),
        )?;
        let window = host_window(class!(NSWindow));
        let window = native(&window);
        hooks.attach(&window).map_err(|e| e.to_string())?;
        hooks
            .attach(&window)
            .map_err(|e| format!("attaching twice: {e}"))?;
        ensure(
            hooks.is_attached(&window) && hooks.attached_count() == 1,
            "one window attached",
        )?;
        hooks.detach(&window).map_err(|e| e.to_string())?;
        ensure(
            !hooks.is_attached(&window) && hooks.attached_count() == 0,
            "detached",
        )?;
        let unknown = hooks.attach_engine_window(EngineWindowId::from_raw(9_999).unwrap());
        ensure(
            matches!(unknown, Err(EngineError::UnknownWindow(_))),
            format!("an unknown engine window gave {unknown:?}"),
        )?;
        drop(hooks);
        ensure(!hosted_hooks_installed(), "dropping the hooks removes them")
    }

    fn gpui_routes_input_through_a_plain_host_window() -> Result<(), String> {
        let (hooks, counts) = install()?;
        let platform = MacPlatform::new_attached();
        let host = host_window(class!(NSWindow));
        hooks.attach(&native(&host)).map_err(|e| e.to_string())?;
        let content_view: *mut AnyObject = unsafe { msg_send![&*host, contentView] };
        let host_view: Retained<AnyObject> = unsafe {
            let view: *mut AnyObject = msg_send![class!(NSView), alloc];
            let frame = Rect {
                x: 100.,
                y: 50.,
                width: 600.,
                height: 500.,
            };
            let view: *mut AnyObject = msg_send![view, initWithFrame: frame];
            let view = Retained::from_raw(view).expect("a host view");
            let _: () = msg_send![content_view, addSubview: &*view];
            view
        };
        let (window, gpui_view) = open_hosted(&platform, 71, &host, Some(&host_view))?;
        let inputs = Rc::new(RefCell::new(Vec::new()));
        window.on_input(Box::new({
            let inputs = inputs.clone();
            move |input| {
                inputs.borrow_mut().push(input);
                DispatchEventResult {
                    propagate: true,
                    default_prevented: false,
                }
            }
        }));
        unsafe {
            let _: () = msg_send![gpui_view, mouseDown: &*mouse_down(&host, 110., 540.)];
        }
        let position = inputs.borrow().iter().find_map(|input| match input {
            PlatformInput::MouseDown(event) => Some(event.position),
            _ => None,
        });
        ensure(
            position == Some(point(px(10.), px(10.))),
            format!("mouse at {position:?}"),
        )?;
        let page: Retained<AnyObject> = unsafe { msg_send![page_class(), new] };
        let page_id = NativeViewId::for_test(7);
        let attachment =
            unsafe { window.attach_native_view(page_id, NonNull::from(&*page).cast::<c_void>()) }
                .ok_or("native views attach to hosted windows")?;
        let offered = Rc::new(RefCell::new(Vec::new()));
        window.on_key_down_before_native_view(Box::new({
            let offered = offered.clone();
            move |key_down| {
                offered.borrow_mut().push(key_down.keystroke.key.clone());
                key_down.keystroke.key == "k"
            }
        }));
        window.on_hit_test_native_view(Box::new(move |_| Some(page_id)));
        let mut scene = Scene::default();
        scene.insert_primitive(page_view(7, scaled(0., 0., 1200., 1000.)));
        scene.finish();
        window.draw(&scene);
        let first_responder = || -> *mut AnyObject { unsafe { msg_send![&*host, firstResponder] } };
        let accepted: Bool = unsafe { msg_send![&*host, makeFirstResponder: &*page] };
        ensure(
            !accepted.as_bool() && !ptr::eq(first_responder(), &*page),
            "a page can't take keyboard input on its own",
        )?;
        window.set_focused_native_view(Some(page_id));
        ensure(
            ptr::eq(first_responder(), &*page),
            "GPUI's focus gives the page the keyboard",
        )?;
        unsafe {
            let _: () = msg_send![&*host, sendEvent: &*key_event(&host, c"k", 40, false)];
            let _: () = msg_send![&*host, sendEvent: &*key_event(&host, c"a", 0, false)];
        }
        ensure(
            *offered.borrow() == ["k", "a"],
            format!("GPUI was offered {:?}", offered.borrow()),
        )?;
        let keys = PAGE_KEYS.with_borrow(|keys| keys.clone());
        ensure(keys == ["a"], format!("the page saw {keys:?}"))?;
        let performed: Bool =
            unsafe { msg_send![&*host, performKeyEquivalent: &*key_event(&host, c"k", 40, true)] };
        ensure(
            performed.as_bool(),
            "GPUI takes a reserved key equivalent first",
        )?;
        ensure(
            offered.borrow().len() == 3,
            "the key equivalent was offered",
        )?;
        ensure(
            counts.send_event.get() >= 2
                && counts.make_first_responder.get() >= 2
                && counts.perform_key_equivalent.get() >= 1,
            "every override went through the routes",
        )?;
        drop(attachment);
        drop(window);
        run_main_queue(0.2);
        drop(hooks);
        Ok(())
    }

    fn unattached_windows_of_a_hooked_class_are_untouched() -> Result<(), String> {
        let (hooks, counts) = install()?;
        let attached = host_window(class!(NSWindow));
        hooks
            .attach(&native(&attached))
            .map_err(|e| e.to_string())?;
        let other = host_window(class!(NSWindow));
        let content_view: *mut AnyObject = unsafe { msg_send![&*other, contentView] };
        let page: Retained<AnyObject> = unsafe { msg_send![page_class(), new] };
        unsafe {
            let _: () = msg_send![content_view, addSubview: &*page];
        }
        let before = counts.total();
        let accepted: Bool = unsafe { msg_send![&*other, makeFirstResponder: &*page] };
        ensure(
            accepted.as_bool(),
            "an unattached window keeps AppKit's own focus rules",
        )?;
        PAGE_KEYS.with_borrow_mut(Vec::clear);
        unsafe {
            let _: () = msg_send![&*other, sendEvent: &*key_event(&other, c"z", 6, false)];
        }
        ensure(
            PAGE_KEYS.with_borrow(|keys| keys.clone()) == ["z"],
            "the key reached the page",
        )?;
        ensure(
            counts.total() == before,
            "no route ran for a window nobody attached",
        )?;
        drop(hooks);
        Ok(())
    }

    fn a_subclass_and_its_base_route_each_event_once() -> Result<(), String> {
        let (hooks, counts) = install()?;
        let base = host_window(class!(NSWindow));
        hooks.attach(&native(&base)).map_err(|e| e.to_string())?;
        let child = host_window(child_class());
        hooks.attach(&native(&child)).map_err(|e| e.to_string())?;
        CHILD_SENDS.with(|sends| sends.set(0));
        unsafe {
            let _: () = msg_send![&*child, sendEvent: &*key_event(&child, c"q", 12, false)];
        }
        ensure(
            counts.send_event.get() == 1,
            format!("sendEvent: was routed {} times", counts.send_event.get()),
        )?;
        ensure(
            CHILD_SENDS.with(Cell::get) == 1,
            "the subclass's own override ran once",
        )?;
        let accepted: Bool =
            unsafe { msg_send![&*child, makeFirstResponder: ptr::null_mut::<AnyObject>()] };
        ensure(
            accepted.as_bool(),
            "the window took itself as first responder",
        )?;
        ensure(
            counts.make_first_responder.get() == 1,
            format!(
                "makeFirstResponder: was routed {} times",
                counts.make_first_responder.get()
            ),
        )?;
        unsafe {
            let _: () = msg_send![&*base, sendEvent: &*key_event(&base, c"w", 13, false)];
        }
        ensure(
            counts.send_event.get() == 2,
            "the base window routes on its own",
        )?;
        drop(hooks);
        Ok(())
    }

    fn uninstalling_puts_the_windows_own_methods_back() -> Result<(), String> {
        let class = owning_class();
        let selectors = [
            sel!(sendEvent:),
            sel!(keyDown:),
            sel!(makeFirstResponder:),
            sel!(performKeyEquivalent:),
        ];
        let before: Vec<usize> = selectors
            .iter()
            .map(|s| implementation(class, *s))
            .collect();
        let (hooks, counts) = install()?;
        let window = host_window(class);
        hooks.attach(&native(&window)).map_err(|e| e.to_string())?;
        let during: Vec<usize> = selectors
            .iter()
            .map(|s| implementation(class, *s))
            .collect();
        ensure(
            before.iter().zip(&during).all(|(a, b)| a != b),
            "every owned method was routed",
        )?;
        unsafe {
            let _: () = msg_send![&*window, sendEvent: &*key_event(&window, c"e", 14, false)];
        }
        ensure(counts.send_event.get() == 1, "routed while installed")?;
        let restored = hooks.uninstall().map_err(|e| e.to_string())?;
        ensure(restored >= 4, format!("{restored} methods restored"))?;
        let after: Vec<usize> = selectors
            .iter()
            .map(|s| implementation(class, *s))
            .collect();
        ensure(after == before, "the class has its own methods back")?;
        unsafe {
            let _: () = msg_send![&*window, sendEvent: &*key_event(&window, c"r", 15, false)];
        }
        ensure(
            counts.send_event.get() == 1,
            "nothing routes once the hooks are off",
        )?;
        let (hooks, counts) = install()?;
        hooks.attach(&native(&window)).map_err(|e| e.to_string())?;
        unsafe {
            let _: () = msg_send![&*window, sendEvent: &*key_event(&window, c"t", 17, false)];
        }
        ensure(
            counts.send_event.get() == 1,
            "a second install routes again",
        )?;
        drop(hooks);
        Ok(())
    }

    fn a_displaced_hook_routes_again_after_reinstalling() -> Result<(), String> {
        let class = displaced_class();
        let selector = sel!(sendEvent:);
        let own = implementation(class, selector);
        let send = |window: &AnyObject, key: &CStr| unsafe {
            let _: () = msg_send![window, sendEvent: &*key_event(window, key, 0, false)];
        };
        let (hooks, counts) = install()?;
        let window = host_window(class);
        hooks.attach(&native(&window)).map_err(|e| e.to_string())?;
        FOREIGN_NEXT.store(implementation(class, selector), Ordering::Relaxed);
        set_implementation(class, selector, foreign_implementation());
        send(&window, c"a");
        ensure(
            counts.send_event.get() == 1 && FOREIGN_SENDS.load(Ordering::Relaxed) == 1,
            "a foreign override on top of the hook still routes once",
        )?;
        hooks.uninstall().map_err(|e| e.to_string())?;
        ensure(
            implementation(class, selector) == foreign_implementation(),
            "a hook something else overrode is left in place",
        )?;
        set_implementation(class, selector, own);
        FOREIGN_NEXT.store(0, Ordering::Relaxed);
        let (hooks, counts) = install()?;
        hooks.attach(&native(&window)).map_err(|e| e.to_string())?;
        send(&window, c"b");
        ensure(
            counts.send_event.get() == 1,
            format!(
                "after the override was reset, sendEvent: routed {} times",
                counts.send_event.get()
            ),
        )?;
        FOREIGN_NEXT.store(implementation(class, selector), Ordering::Relaxed);
        set_implementation(class, selector, foreign_implementation());
        let second = host_window(class);
        hooks.attach(&native(&second)).map_err(|e| e.to_string())?;
        send(&window, c"c");
        ensure(
            counts.send_event.get() == 2,
            format!(
                "through a new hook, a foreign override and an old hook, sendEvent: routed {} times in all",
                counts.send_event.get()
            ),
        )?;
        FOREIGN_NEXT.store(0, Ordering::Relaxed);
        set_implementation(class, selector, foreign_implementation());
        hooks.attach(&native(&window)).map_err(|e| e.to_string())?;
        send(&window, c"d");
        ensure(
            counts.send_event.get() == 3,
            format!(
                "attaching the same window over an override that never chains routed {} times in all",
                counts.send_event.get()
            ),
        )?;
        drop(hooks);
        set_implementation(class, selector, own);
        FOREIGN_NEXT.store(0, Ordering::Relaxed);
        Ok(())
    }

    fn browser_windows_get_a_transparent_full_size_titlebar() -> Result<(), String> {
        let host = host_window(class!(NSWindow));
        let before: Rect = unsafe { msg_send![&*host, frame] };
        style_browser_window(&native(&host)).map_err(|e| e.to_string())?;
        let mask: usize = unsafe { msg_send![&*host, styleMask] };
        ensure(
            mask & (1 << 15) != 0,
            "the content fills the window under the titlebar",
        )?;
        let transparent: Bool = unsafe { msg_send![&*host, titlebarAppearsTransparent] };
        ensure(transparent.as_bool(), "the titlebar is transparent")?;
        let visibility: isize = unsafe { msg_send![&*host, titleVisibility] };
        ensure(visibility == 1, "the title is hidden")?;
        let title: *mut AnyObject = unsafe { msg_send![&*host, title] };
        ensure(
            text_of(title) == "Ardia",
            format!("the window is titled {:?}", text_of(title)),
        )?;
        let minimum: Extent = unsafe { msg_send![&*host, contentMinSize] };
        ensure(
            minimum
                == Extent {
                    width: 500.,
                    height: 460.,
                },
            format!("the smallest window is {minimum:?}"),
        )?;
        let released: Bool = unsafe { msg_send![&*host, isReleasedWhenClosed] };
        ensure(
            !released.as_bool(),
            "closing doesn't free the window under Chromium",
        )?;
        let tabbing: isize = unsafe { msg_send![&*host, tabbingMode] };
        ensure(tabbing == 2, "macOS window tabs stay off")?;
        let after: Rect = unsafe { msg_send![&*host, frame] };
        ensure(
            (before.x, before.y, before.width, before.height)
                == (after.x, after.y, after.width, after.height),
            "styling keeps the window where it was",
        )
    }

    fn in_the_background_an_activated_hosted_window_stays_lowered() -> Result<(), String> {
        ardia_engine::macos::platform::install_background_guard().map_err(|e| e.to_string())?;
        let platform = MacPlatform::new_attached();
        let host = host_window(class!(NSWindow));
        style_browser_window(&native(&host)).map_err(|e| e.to_string())?;
        let (window, _) = open_hosted(&platform, 91, &host, None)?;
        window.activate();
        let visible = run_main_queue_until(ACTIVATION_DEADLINE, || {
            let shown: Bool = unsafe { msg_send![&*host, isVisible] };
            shown.as_bool()
        });
        ensure(visible, "activating the hosted window ordered it in")?;
        let layer = window_server_layer(&host);
        ensure(
            layer.is_some_and(|layer| layer < 0),
            format!("the window sits at layer {layer:?}, below every normal window"),
        )?;
        let app: *mut AnyObject = unsafe { msg_send![class!(NSApplication), sharedApplication] };
        let policy: isize = unsafe { msg_send![app, activationPolicy] };
        ensure(
            policy == 2,
            format!("the app can't activate (policy {policy})"),
        )?;
        let active: Bool = unsafe { msg_send![app, isActive] };
        ensure(!active.as_bool(), "the app never took focus")?;
        unsafe {
            let _: () = msg_send![&*host, orderOut: ptr::null_mut::<AnyObject>()];
        }
        drop(window);
        run_main_queue(0.2);
        Ok(())
    }

    pub fn run() -> i32 {
        let _app: *mut AnyObject = unsafe { msg_send![class!(NSApplication), sharedApplication] };
        let checks: [(&str, Check); 8] = [
            (
                "hooks install once and track windows",
                hooks_install_once_and_track_windows,
            ),
            (
                "GPUI routes input through a plain host window",
                gpui_routes_input_through_a_plain_host_window,
            ),
            (
                "unattached windows of a hooked class are untouched",
                unattached_windows_of_a_hooked_class_are_untouched,
            ),
            (
                "a subclass and its base route each event once",
                a_subclass_and_its_base_route_each_event_once,
            ),
            (
                "uninstalling puts the window's own methods back",
                uninstalling_puts_the_windows_own_methods_back,
            ),
            (
                "a displaced hook routes again after reinstalling",
                a_displaced_hook_routes_again_after_reinstalling,
            ),
            (
                "browser windows get a transparent full-size titlebar",
                browser_windows_get_a_transparent_full_size_titlebar,
            ),
            (
                "in the background an activated hosted window stays lowered",
                in_the_background_an_activated_hosted_window_stays_lowered,
            ),
        ];
        let mut failed = 0;
        for (name, check) in checks {
            match check() {
                Ok(()) => println!("test {name} ... ok"),
                Err(problem) => {
                    failed += 1;
                    println!("test {name} ... FAILED: {problem}");
                }
            }
        }
        println!(
            "\nhosted input result: {} passed; {failed} failed",
            checks.len() - failed
        );
        i32::from(failed > 0)
    }
}
