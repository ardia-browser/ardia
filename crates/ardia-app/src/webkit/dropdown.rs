#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub symbol: String,
    pub enabled: bool,
    pub muted: bool,
}

impl Row {
    pub fn new(id: &str, title: &str, detail: &str, symbol: &str) -> Self {
        Row {
            id: id.to_owned(),
            title: title.to_owned(),
            detail: detail.to_owned(),
            symbol: symbol.to_owned(),
            enabled: true,
            muted: false,
        }
    }
}

pub const ROW_HEIGHT: f64 = 36.0;
pub const NOTICE_HEIGHT: f64 = 62.0;
pub const INSET: f64 = 5.0;
pub const GAP: f64 = 2.0;
pub const MAX_ROWS: usize = 6;
pub const MIN_WIDTH: f64 = 240.0;
pub const MAX_WIDTH: f64 = 420.0;

pub fn row_height(row: &Row) -> f64 {
    if row.enabled {
        ROW_HEIGHT
    } else {
        NOTICE_HEIGHT
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn panel_frame(rows: &[Row], field: Frame, screen: Frame) -> Frame {
    let width = MAX_WIDTH.min(MIN_WIDTH.max(field.width));
    let visible: f64 = rows.iter().take(MAX_ROWS).map(row_height).sum();
    let height = visible + INSET * 2.0;
    let mut y = field.y - GAP - height;
    if y < screen.y && field.y + field.height + GAP + height <= screen.y + screen.height {
        y = field.y + field.height + GAP;
    }
    let x = field.x.min(screen.x + screen.width - width).max(screen.x);
    Frame {
        x,
        y,
        width,
        height,
    }
}

pub fn next_selection(rows: &[Row], selected: Option<usize>, step: i32) -> Option<usize> {
    let choices: Vec<usize> = (0..rows.len()).filter(|i| rows[*i].enabled).collect();
    if choices.is_empty() {
        return None;
    }
    let count = choices.len() as i32;
    let position = selected.and_then(|s| choices.iter().position(|c| *c == s));
    let next = match position {
        Some(at) => ((at as i32 + step) % count + count) % count,
        None if step > 0 => 0,
        None => count - 1,
    };
    Some(choices[next as usize])
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, NSObject};
    use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::{NSEvent, NSResponder, NSView};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    use super::*;

    type Part = Option<Retained<AnyObject>>;
    type Parts = (Part, Part, Part);

    pub struct RowIvars {
        index: Cell<usize>,
        enabled: Cell<bool>,
        muted: Cell<bool>,
        highlighted: Cell<bool>,
        notice: RefCell<String>,
        parts: RefCell<Vec<Retained<AnyObject>>>,
    }

    define_class!(
        #[unsafe(super(NSView, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArdiaGpuiAutofillRow"]
        #[ivars = RowIvars]
        pub struct RowView;

        impl RowView {
            #[unsafe(method(isFlipped))]
            fn is_flipped(&self) -> bool {
                true
            }

            #[unsafe(method(acceptsFirstMouse:))]
            fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
                self.ivars().enabled.get()
            }

            #[unsafe(method(updateTrackingAreas))]
            fn update_tracking_areas(&self) {
                unsafe {
                    let _: () = msg_send![super(self), updateTrackingAreas];
                    let areas: Retained<AnyObject> = msg_send![self, trackingAreas];
                    let count: usize = msg_send![&*areas, count];
                    for index in (0..count).rev() {
                        let area: Retained<AnyObject> = msg_send![&*areas, objectAtIndex: index];
                        let _: () = msg_send![self, removeTrackingArea: &*area];
                    }
                }
                if !self.ivars().enabled.get() {
                    return;
                }
                let Some(class) = AnyClass::get(c"NSTrackingArea") else {
                    return;
                };
                let options: usize = 0x01 | 0x02 | 0x80 | 0x200;
                unsafe {
                    let allocated: objc2::rc::Allocated<AnyObject> = msg_send![class, alloc];
                    let area: Option<Retained<AnyObject>> = msg_send![
                        allocated,
                        initWithRect: NSRect::ZERO,
                        options: options,
                        owner: self,
                        userInfo: std::ptr::null::<AnyObject>()
                    ];
                    if let Some(area) = area {
                        let _: () = msg_send![self, addTrackingArea: &*area];
                    }
                }
            }

            #[unsafe(method(mouseEntered:))]
            fn mouse_entered(&self, _event: &NSEvent) {
                hovered(self.ivars().index.get());
            }

            #[unsafe(method(mouseMoved:))]
            fn mouse_moved(&self, _event: &NSEvent) {
                if !self.ivars().highlighted.get() {
                    hovered(self.ivars().index.get());
                }
            }

            #[unsafe(method(mouseDown:))]
            fn mouse_down(&self, _event: &NSEvent) {}

            #[unsafe(method(mouseUp:))]
            fn mouse_up(&self, event: &NSEvent) {
                let inside = unsafe {
                    let at: NSPoint = msg_send![event, locationInWindow];
                    let local: NSPoint = msg_send![self, convertPoint: at, fromView: std::ptr::null::<NSView>()];
                    let bounds: NSRect = msg_send![self, bounds];
                    local.x >= bounds.origin.x
                        && local.y >= bounds.origin.y
                        && local.x <= bounds.origin.x + bounds.size.width
                        && local.y <= bounds.origin.y + bounds.size.height
                };
                if inside && self.ivars().enabled.get() {
                    clicked(self.ivars().index.get());
                }
            }

            #[unsafe(method(drawRect:))]
            fn draw_rect(&self, _dirty: NSRect) {
                let bounds: NSRect = unsafe { msg_send![self, bounds] };
                let notice = self.ivars().notice.borrow().clone();
                if !notice.is_empty() {
                    draw_notice(&notice, bounds);
                }
                if !self.ivars().highlighted.get() {
                    return;
                }
                unsafe {
                    let Some(colors) = AnyClass::get(c"NSColor") else {
                        return;
                    };
                    let Some(paths) = AnyClass::get(c"NSBezierPath") else {
                        return;
                    };
                    let color: Retained<AnyObject> = msg_send![colors, selectedContentBackgroundColor];
                    let _: () = msg_send![&*color, setFill];
                    let path: Retained<AnyObject> = msg_send![paths, bezierPathWithRoundedRect: bounds, xRadius: 4.0f64, yRadius: 4.0f64];
                    let _: () = msg_send![&*path, fill];
                }
            }

            #[unsafe(method(layout))]
            fn layout(&self) {
                unsafe {
                    let _: () = msg_send![super(self), layout];
                }
                self.place();
            }
        }
    );

    fn class(name: &std::ffi::CStr) -> Option<&'static AnyClass> {
        AnyClass::get(name)
    }

    fn color(name: &str) -> Option<Retained<AnyObject>> {
        let colors = class(c"NSColor")?;
        let selector = objc2::runtime::Sel::register(&std::ffi::CString::new(name).ok()?);
        unsafe { msg_send![colors, performSelector: selector] }
    }

    fn menu_font(size: f64) -> Option<Retained<AnyObject>> {
        let fonts = class(c"NSFont")?;
        unsafe { msg_send![fonts, menuFontOfSize: size] }
    }

    fn draw_notice(text: &str, bounds: NSRect) {
        let Some(dictionary) = class(c"NSMutableDictionary") else {
            return;
        };
        unsafe {
            let attributes: Retained<AnyObject> = msg_send![dictionary, new];
            if let Some(font) = menu_font(12.0) {
                let _: () = msg_send![&*attributes, setObject: &*font, forKey: &*NSString::from_str("NSFont")];
            }
            if let Some(color) = color("secondaryLabelColor") {
                let _: () = msg_send![&*attributes, setObject: &*color, forKey: &*NSString::from_str("NSColor")];
            }
            let rect = NSRect::new(
                NSPoint::new(32.0, 6.0),
                NSSize::new(bounds.size.width - 42.0, bounds.size.height - 12.0),
            );
            let options: isize = 1 | (1 << 5);
            let string = NSString::from_str(text);
            let _: () =
                msg_send![&*string, drawWithRect: rect, options: options, attributes: &*attributes];
        }
    }

    fn label(text: &str, size: f64) -> Option<Retained<AnyObject>> {
        let fields = class(c"NSTextField")?;
        unsafe {
            let field: Option<Retained<AnyObject>> =
                msg_send![fields, labelWithString: &*NSString::from_str(text)];
            let field = field?;
            if let Some(font) = menu_font(size) {
                let _: () = msg_send![&*field, setFont: &*font];
            }
            let _: () = msg_send![&*field, setLineBreakMode: 4usize];
            Some(field)
        }
    }

    fn symbol_view(name: &str) -> Option<Retained<AnyObject>> {
        let images = class(c"NSImage")?;
        let views = class(c"NSImageView")?;
        unsafe {
            let image: Option<Retained<AnyObject>> = msg_send![
                images,
                imageWithSystemSymbolName: &*NSString::from_str(name),
                accessibilityDescription: std::ptr::null::<NSString>()
            ];
            let image = image?;
            if let Some(configs) = class(c"NSImageSymbolConfiguration") {
                let config: Option<Retained<AnyObject>> =
                    msg_send![configs, configurationWithPointSize: 13.0f64, weight: 0.0f64];
                if let Some(config) = config {
                    let configured: Option<Retained<AnyObject>> =
                        msg_send![&*image, imageWithSymbolConfiguration: &*config];
                    if let Some(configured) = configured {
                        return msg_send![views, imageViewWithImage: &*configured];
                    }
                }
            }
            msg_send![views, imageViewWithImage: &*image]
        }
    }

    impl RowView {
        fn make(mtm: MainThreadMarker, index: usize, row: &Row) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(RowIvars {
                index: Cell::new(index),
                enabled: Cell::new(row.enabled),
                muted: Cell::new(row.muted),
                highlighted: Cell::new(false),
                notice: RefCell::new(if row.enabled {
                    String::new()
                } else {
                    row.title.clone()
                }),
                parts: RefCell::new(Vec::new()),
            });
            let view: Retained<Self> =
                unsafe { msg_send![super(this), initWithFrame: NSRect::ZERO] };
            let mut parts = Vec::new();
            if let Some(icon) = symbol_view(&row.symbol) {
                parts.push(icon);
            }
            let title = label(&row.title, if row.enabled { 13.0 } else { 12.0 });
            let detail = label(&row.detail, 11.0);
            unsafe {
                if let Some(icon) = parts.first() {
                    let _: () = msg_send![&*view, addSubview: &**icon];
                }
                if let Some(title) = &title {
                    let _: () = msg_send![&**title, setHidden: Bool::new(!row.enabled)];
                    let _: () = msg_send![&*view, addSubview: &**title];
                }
                if let Some(detail) = &detail {
                    let _: () = msg_send![&**detail, setHidden: Bool::new(row.detail.is_empty())];
                    let _: () = msg_send![&*view, addSubview: &**detail];
                }
                let spoken = if row.detail.is_empty() {
                    row.title.clone()
                } else {
                    format!("{}, {}", row.title, row.detail)
                };
                let _: () = msg_send![&*view, setAccessibilityElement: Bool::YES];
                let role = if row.enabled {
                    "AXMenuItem"
                } else {
                    "AXStaticText"
                };
                let _: () = msg_send![&*view, setAccessibilityRole: &*NSString::from_str(role)];
                let _: () = msg_send![&*view, setAccessibilityLabel: &*NSString::from_str(&spoken)];
            }
            if parts.is_empty() {
                parts.push(unsafe { Retained::cast_unchecked::<AnyObject>(NSObject::new()) });
            }
            parts.extend(title);
            parts.extend(detail);
            *view.ivars().parts.borrow_mut() = parts;
            view.paint();
            view
        }

        fn parts(&self) -> Parts {
            let parts = self.ivars().parts.borrow();
            (
                parts.first().cloned(),
                parts.get(1).cloned(),
                parts.get(2).cloned(),
            )
        }

        fn place(&self) {
            let bounds: NSRect = unsafe { msg_send![self, bounds] };
            let enabled = self.ivars().enabled.get();
            let (icon, title, detail) = self.parts();
            let left = 32.0;
            let width = bounds.size.width - left - 10.0;
            unsafe {
                if let Some(icon) = icon
                    && msg_send![&*icon, respondsToSelector: objc2::sel!(setFrame:)]
                {
                    let y = if enabled {
                        (bounds.size.height - 16.0) / 2.0
                    } else {
                        8.0
                    };
                    let _: () = msg_send![&*icon, setFrame: NSRect::new(NSPoint::new(8.0, y), NSSize::new(16.0, 16.0))];
                }
                if !enabled {
                    let _: () = msg_send![self, setNeedsDisplay: Bool::YES];
                    return;
                }
                let detail_hidden = detail.as_ref().is_none_or(|d| {
                    let hidden: Bool = msg_send![&**d, isHidden];
                    hidden.as_bool()
                });
                if let Some(title) = title {
                    let y = if detail_hidden {
                        (bounds.size.height - 16.0) / 2.0
                    } else {
                        4.0
                    };
                    let _: () = msg_send![&*title, setFrame: NSRect::new(NSPoint::new(left, y), NSSize::new(width, 16.0))];
                }
                if let Some(detail) = detail
                    && !detail_hidden
                {
                    let _: () = msg_send![&*detail, setFrame: NSRect::new(NSPoint::new(left, 20.0), NSSize::new(width, 13.0))];
                }
            }
        }

        fn set_highlighted(&self, on: bool) {
            if self.ivars().highlighted.replace(on) == on {
                return;
            }
            unsafe {
                let _: () = msg_send![self, setNeedsDisplay: Bool::YES];
            }
            self.paint();
        }

        fn paint(&self) {
            let highlighted = self.ivars().highlighted.get();
            let enabled = self.ivars().enabled.get();
            let muted = self.ivars().muted.get();
            let (icon, title, detail) = self.parts();
            let selected = color("alternateSelectedControlTextColor");
            let secondary = color("secondaryLabelColor");
            let primary = color("labelColor");
            unsafe {
                let title_color = if highlighted {
                    selected.clone()
                } else if enabled && !muted {
                    primary
                } else {
                    secondary.clone()
                };
                if let (Some(title), Some(c)) = (title, title_color) {
                    let _: () = msg_send![&*title, setTextColor: &*c];
                }
                let detail_color = if highlighted {
                    selected.clone().map(|c| -> Retained<AnyObject> {
                        msg_send![&*c, colorWithAlphaComponent: 0.8f64]
                    })
                } else {
                    secondary.clone()
                };
                if let (Some(detail), Some(c)) = (detail, detail_color) {
                    let _: () = msg_send![&*detail, setTextColor: &*c];
                }
                let icon_color = if highlighted { selected } else { secondary };
                if let (Some(icon), Some(c)) = (icon, icon_color)
                    && msg_send![&*icon, respondsToSelector: objc2::sel!(setContentTintColor:)]
                {
                    let _: () = msg_send![&*icon, setContentTintColor: &*c];
                }
            }
        }
    }

    define_class!(
        #[unsafe(super(NSView, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArdiaGpuiAutofillList"]
        pub struct ListView;

        impl ListView {
            #[unsafe(method(isFlipped))]
            fn is_flipped(&self) -> bool {
                true
            }
        }
    );

    struct Shown {
        panel: Retained<AnyObject>,
        scroll: Retained<AnyObject>,
        list: Retained<ListView>,
        views: Vec<Retained<RowView>>,
        rows: Vec<Row>,
        selected: Option<usize>,
        parent: Option<Retained<AnyObject>>,
        observers: Vec<Retained<AnyObject>>,
        on_pick: Option<std::rc::Rc<dyn Fn(Row)>>,
        on_select: Option<std::rc::Rc<dyn Fn()>>,
        on_dismiss: Option<std::rc::Rc<dyn Fn()>>,
        visible: bool,
    }

    thread_local! {
        static SHOWN: RefCell<Option<Shown>> = const { RefCell::new(None) };
    }

    fn hovered(index: usize) {
        select(Some(index), true);
    }

    fn clicked(index: usize) {
        let pick = SHOWN.with(|s| {
            let shown = s.borrow();
            let shown = shown.as_ref()?;
            let row = shown.rows.get(index)?.clone();
            Some((row, shown.on_pick.clone()?))
        });
        if let Some((row, pick)) = pick {
            pick(row);
        }
    }

    fn select(index: Option<usize>, notify: bool) {
        let callback = SHOWN.with(|s| {
            let mut slot = s.borrow_mut();
            let shown = slot.as_mut()?;
            shown.selected = index.filter(|i| shown.rows.get(*i).is_some_and(|r| r.enabled));
            for (i, view) in shown.views.iter().enumerate() {
                view.set_highlighted(Some(i) == shown.selected);
            }
            if let Some(selected) = shown.selected
                && let Some(view) = shown.views.get(selected)
            {
                unsafe {
                    let bounds: NSRect = msg_send![&**view, bounds];
                    let _: Bool = msg_send![&**view, scrollRectToVisible: bounds];
                }
            }
            notify.then(|| shown.on_select.clone()).flatten()
        });
        if let Some(callback) = callback {
            callback();
        }
    }

    fn make_panel(
        mtm: MainThreadMarker,
    ) -> Option<(Retained<AnyObject>, Retained<AnyObject>, Retained<ListView>)> {
        let panels = class(c"NSPanel")?;
        let effects = class(c"NSVisualEffectView")?;
        let scrolls = class(c"NSScrollView")?;
        unsafe {
            let style: usize = 1 << 7;
            let allocated: objc2::rc::Allocated<AnyObject> = msg_send![panels, alloc];
            let panel: Option<Retained<AnyObject>> = msg_send![
                allocated,
                initWithContentRect: NSRect::ZERO,
                styleMask: style,
                backing: 2usize,
                defer: Bool::YES
            ];
            let panel = panel?;
            let _: () = msg_send![&*panel, setReleasedWhenClosed: Bool::NO];
            let _: () = msg_send![&*panel, setHidesOnDeactivate: Bool::YES];
            let _: () = msg_send![&*panel, setBecomesKeyOnlyIfNeeded: Bool::YES];
            let _: () = msg_send![&*panel, setHasShadow: Bool::YES];
            let _: () = msg_send![&*panel, setOpaque: Bool::NO];
            if let Some(clear) = color("clearColor") {
                let _: () = msg_send![&*panel, setBackgroundColor: &*clear];
            }
            let _: () = msg_send![&*panel, setAnimationBehavior: 2isize];
            let _: () = msg_send![&*panel, setAccessibilityRole: &*NSString::from_str("AXMenu")];
            let effect: Retained<AnyObject> = msg_send![effects, new];
            let _: () = msg_send![&*effect, setMaterial: 5isize];
            let _: () = msg_send![&*effect, setBlendingMode: 0isize];
            let _: () = msg_send![&*effect, setState: 1isize];
            let _: () = msg_send![&*effect, setWantsLayer: Bool::YES];
            let layer: Option<Retained<AnyObject>> = msg_send![&*effect, layer];
            if let Some(layer) = layer {
                let _: () = msg_send![&*layer, setCornerRadius: 8.0f64];
                let _: () = msg_send![&*layer, setMasksToBounds: Bool::YES];
            }
            let scroll: Retained<AnyObject> = msg_send![scrolls, new];
            let _: () = msg_send![&*scroll, setDrawsBackground: Bool::NO];
            let _: () = msg_send![&*scroll, setHasVerticalScroller: Bool::YES];
            let _: () = msg_send![&*scroll, setAutohidesScrollers: Bool::YES];
            let _: () = msg_send![&*scroll, setBorderType: 0usize];
            let list: Retained<ListView> =
                msg_send![ListView::alloc(mtm), initWithFrame: NSRect::ZERO];
            let _: () = msg_send![&*scroll, setDocumentView: &*list];
            let _: () = msg_send![&*effect, addSubview: &*scroll];
            let _: () = msg_send![&*panel, setContentView: &*effect];
            Some((panel, scroll, list))
        }
    }

    fn screen_frame(field: NSRect, window: &AnyObject) -> Frame {
        unsafe {
            let anchor = NSPoint::new(
                field.origin.x + field.size.width / 2.0,
                field.origin.y + field.size.height / 2.0,
            );
            let mut chosen: Option<Retained<AnyObject>> = None;
            if let Some(screens) = class(c"NSScreen") {
                let all: Retained<AnyObject> = msg_send![screens, screens];
                let count: usize = msg_send![&*all, count];
                for index in 0..count {
                    let screen: Retained<AnyObject> = msg_send![&*all, objectAtIndex: index];
                    let frame: NSRect = msg_send![&*screen, frame];
                    if anchor.x >= frame.origin.x
                        && anchor.y >= frame.origin.y
                        && anchor.x < frame.origin.x + frame.size.width
                        && anchor.y < frame.origin.y + frame.size.height
                    {
                        chosen = Some(screen);
                        break;
                    }
                }
            }
            let chosen = chosen.or_else(|| msg_send![window, screen]);
            match chosen {
                Some(screen) => {
                    let visible: NSRect = msg_send![&*screen, visibleFrame];
                    Frame {
                        x: visible.origin.x,
                        y: visible.origin.y,
                        width: visible.size.width,
                        height: visible.size.height,
                    }
                }
                None => Frame {
                    x: -100_000.0,
                    y: -100_000.0,
                    width: 200_000.0,
                    height: 200_000.0,
                },
            }
        }
    }

    pub struct Handlers {
        pub on_pick: std::rc::Rc<dyn Fn(Row)>,
        pub on_select: std::rc::Rc<dyn Fn()>,
        pub on_dismiss: std::rc::Rc<dyn Fn()>,
    }

    pub fn show(
        rows: Vec<Row>,
        field_in_view: NSRect,
        view: &AnyObject,
        handlers: Handlers,
    ) -> bool {
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        let window: Option<Retained<AnyObject>> = unsafe { msg_send![view, window] };
        let Some(window) = window else {
            return false;
        };
        let field = unsafe {
            let in_window: NSRect =
                msg_send![view, convertRect: field_in_view, toView: std::ptr::null::<AnyObject>()];
            let on_screen: NSRect = msg_send![&*window, convertRectToScreen: in_window];
            on_screen
        };
        let screen = screen_frame(field, &window);
        let placed = panel_frame(
            &rows,
            Frame {
                x: field.origin.x,
                y: field.origin.y,
                width: field.size.width,
                height: field.size.height,
            },
            screen,
        );
        let kept = selected_row();
        let made = SHOWN.with(|s| s.borrow().is_none());
        if made {
            let Some((panel, scroll, list)) = make_panel(mtm) else {
                return false;
            };
            SHOWN.with(|s| {
                *s.borrow_mut() = Some(Shown {
                    panel,
                    scroll,
                    list,
                    views: Vec::new(),
                    rows: Vec::new(),
                    selected: None,
                    parent: None,
                    observers: Vec::new(),
                    on_pick: None,
                    on_select: None,
                    on_dismiss: None,
                    visible: false,
                })
            });
        }
        let content: f64 = rows.iter().map(row_height).sum();
        let watch_parent = SHOWN.with(|s| {
            let mut slot = s.borrow_mut();
            let Some(shown) = slot.as_mut() else {
                return false;
            };
            shown.on_pick = Some(handlers.on_pick.clone());
            shown.on_select = Some(handlers.on_select.clone());
            shown.on_dismiss = Some(handlers.on_dismiss.clone());
            unsafe {
                let frame = NSRect::new(
                    NSPoint::new(placed.x, placed.y),
                    NSSize::new(placed.width, placed.height),
                );
                let _: () = msg_send![&*shown.panel, setFrame: frame, display: Bool::NO];
                let _: () = msg_send![&*shown.scroll, setFrame: NSRect::new(NSPoint::new(0.0, INSET), NSSize::new(placed.width, placed.height - INSET * 2.0))];
                for view in shown.views.drain(..) {
                    let _: () = msg_send![&*view, removeFromSuperview];
                }
                let _: () = msg_send![&*shown.list, setFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(placed.width, content))];
                let mut y = 0.0;
                for (index, row) in rows.iter().enumerate() {
                    let view = RowView::make(mtm, index, row);
                    let height = row_height(row);
                    let _: () = msg_send![&*view, setFrame: NSRect::new(NSPoint::new(INSET, y), NSSize::new(placed.width - INSET * 2.0, height))];
                    y += height;
                    let _: () = msg_send![&*shown.list, addSubview: &*view];
                    shown.views.push(view);
                }
                let clip: Retained<AnyObject> = msg_send![&*shown.scroll, contentView];
                let _: () = msg_send![&*clip, scrollToPoint: NSPoint::new(0.0, 0.0)];
                let _: () = msg_send![&*shown.scroll, reflectScrolledClipView: &*clip];
            }
            shown.rows = rows.clone();
            let same_parent = shown
                .parent
                .as_ref()
                .is_some_and(|p| std::ptr::eq(&**p, &*window));
            unsafe {
                let current: Option<Retained<AnyObject>> = msg_send![&*shown.panel, parentWindow];
                if !current.as_ref().is_some_and(|c| std::ptr::eq(&**c, &*window)) {
                    if let Some(current) = current {
                        let _: () = msg_send![&*current, removeChildWindow: &*shown.panel];
                    }
                    let _: () = msg_send![&*window, addChildWindow: &*shown.panel, ordered: 1isize];
                }
                let _: () = msg_send![&*shown.panel, orderFront: std::ptr::null::<AnyObject>()];
                let _: () = msg_send![&*shown.panel, invalidateShadow];
            }
            shown.visible = true;
            !same_parent
        });
        let index = kept.and_then(|k| rows.iter().position(|r| *r == k));
        select(index, false);
        if watch_parent {
            watch(&window);
        }
        true
    }

    fn watch(window: &AnyObject) {
        unwatch();
        let Some(centers) = class(c"NSNotificationCenter") else {
            return;
        };
        let names = [
            "NSWindowDidResignKeyNotification",
            "NSWindowWillCloseNotification",
            "NSWindowDidResizeNotification",
            "NSWindowWillEnterFullScreenNotification",
        ];
        let observers: Vec<Retained<AnyObject>> = unsafe {
            let center: Retained<AnyObject> = msg_send![centers, defaultCenter];
            let queues = class(c"NSOperationQueue");
            let main: Option<Retained<AnyObject>> = match queues {
                Some(queues) => msg_send![queues, mainQueue],
                None => None,
            };
            names
                .iter()
                .filter_map(|name| {
                    let block = RcBlock::new(|_note: *mut AnyObject| dismissed());
                    msg_send![
                        &*center,
                        addObserverForName: &*NSString::from_str(name),
                        object: window,
                        queue: main.as_deref().map_or(std::ptr::null(), |q| q as *const AnyObject),
                        usingBlock: &*block
                    ]
                })
                .collect()
        };
        SHOWN.with(|s| {
            if let Some(shown) = s.borrow_mut().as_mut() {
                shown.parent =
                    unsafe { Retained::retain(window as *const AnyObject as *mut AnyObject) };
                shown.observers = observers;
            }
        });
    }

    fn unwatch() {
        let observers = SHOWN.with(|s| {
            s.borrow_mut()
                .as_mut()
                .map(|shown| {
                    shown.parent = None;
                    std::mem::take(&mut shown.observers)
                })
                .unwrap_or_default()
        });
        let Some(centers) = class(c"NSNotificationCenter") else {
            return;
        };
        unsafe {
            let center: Retained<AnyObject> = msg_send![centers, defaultCenter];
            for observer in observers {
                let _: () = msg_send![&*center, removeObserver: &*observer];
            }
        }
    }

    fn dismissed() {
        if !is_shown() {
            return;
        }
        let dismiss = SHOWN.with(|s| {
            s.borrow()
                .as_ref()
                .and_then(|shown| shown.on_dismiss.clone())
        });
        close();
        if let Some(dismiss) = dismiss {
            dismiss();
        }
    }

    pub fn is_shown() -> bool {
        SHOWN.with(|s| {
            s.borrow().as_ref().is_some_and(|shown| {
                shown.visible && {
                    let visible: Bool = unsafe { msg_send![&*shown.panel, isVisible] };
                    visible.as_bool()
                }
            })
        })
    }

    pub fn selected_row() -> Option<Row> {
        SHOWN.with(|s| {
            let shown = s.borrow();
            let shown = shown.as_ref()?;
            shown.selected.and_then(|i| shown.rows.get(i).cloned())
        })
    }

    pub fn move_selection(step: i32) {
        let next = SHOWN.with(|s| {
            let shown = s.borrow();
            let shown = shown.as_ref()?;
            next_selection(&shown.rows, shown.selected, step)
        });
        if next.is_some() {
            select(next, true);
        }
    }

    pub fn close() {
        SHOWN.with(|s| {
            if let Some(shown) = s.borrow_mut().as_mut() {
                shown.selected = None;
                shown.visible = false;
            }
        });
        unwatch();
        SHOWN.with(|s| {
            if let Some(shown) = s.borrow().as_ref() {
                unsafe {
                    let parent: Option<Retained<AnyObject>> =
                        msg_send![&*shown.panel, parentWindow];
                    if let Some(parent) = parent {
                        let _: () = msg_send![&*parent, removeChildWindow: &*shown.panel];
                    }
                    let _: () = msg_send![&*shown.panel, orderOut: std::ptr::null::<AnyObject>()];
                }
            }
        });
    }
}

#[cfg(target_os = "macos")]
pub use mac::{Handlers, close, is_shown, move_selection, selected_row, show};

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn native_classes_match_their_protocols() {
        use objc2::ClassType as _;
        crate::webkit::native_audit::assert_conforms(super::mac::RowView::class(), &[]);
        crate::webkit::native_audit::assert_conforms(super::mac::ListView::class(), &[]);
    }

    use super::*;

    fn rows(n: usize) -> Vec<Row> {
        (0..n)
            .map(|i| Row::new(&i.to_string(), "t", "", "key.fill"))
            .collect()
    }

    #[test]
    fn panels_sit_under_the_field_and_flip_when_the_screen_ends() {
        let screen = Frame {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 800.0,
        };
        let field = Frame {
            x: 100.0,
            y: 400.0,
            width: 100.0,
            height: 20.0,
        };
        let below = panel_frame(&rows(2), field, screen);
        assert_eq!(below.width, MIN_WIDTH);
        assert_eq!(below.height, 2.0 * ROW_HEIGHT + 2.0 * INSET);
        assert_eq!(below.y, 400.0 - GAP - below.height);
        let low = Frame { y: 30.0, ..field };
        let above = panel_frame(&rows(8), low, screen);
        assert_eq!(above.height, 6.0 * ROW_HEIGHT + 2.0 * INSET);
        assert_eq!(above.y, 30.0 + 20.0 + GAP);
        let right = Frame { x: 900.0, ..field };
        assert_eq!(panel_frame(&rows(1), right, screen).x, 1000.0 - MIN_WIDTH);
    }

    #[test]
    fn selection_wraps_over_enabled_rows() {
        let mut list = rows(3);
        list[1].enabled = false;
        assert_eq!(next_selection(&list, None, 1), Some(0));
        assert_eq!(next_selection(&list, None, -1), Some(2));
        assert_eq!(next_selection(&list, Some(0), 1), Some(2));
        assert_eq!(next_selection(&list, Some(2), 1), Some(0));
        assert_eq!(next_selection(&[], None, 1), None);
    }
}
