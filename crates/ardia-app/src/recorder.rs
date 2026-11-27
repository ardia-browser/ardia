use std::time::Duration;

pub const FPS: f64 = 15.0;
pub const MAX_PIXEL_WIDTH: f64 = 1440.0;
pub const THUMBNAIL_MAX: u32 = 480;
pub const THUMBNAIL_AT_SECONDS: f64 = 1.0;
pub const PILL_TOP_INSET: f64 = 10.0;
pub const MIN_FRAME_GAP: Duration = Duration::from_millis(4);
pub const PILL_SIZE: [f64; 2] = [236.0, 48.0];
pub const PAGE_VIEW_CLASSES: [&str; 2] = ["RenderWidgetHostViewCocoa", "WebContentsViewCocoa"];

pub fn frame_interval() -> Duration {
    Duration::from_secs_f64(1.0 / FPS)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OutputSize {
    pub width: usize,
    pub height: usize,
    pub scale_x: f64,
    pub scale_y: f64,
}

pub fn output_size(
    points: [f64; 2],
    backing_scale: f64,
    max_pixel_width: f64,
) -> Option<OutputSize> {
    let [w, h] = points;
    if !(w >= 2.0 && h >= 2.0) {
        return None;
    }
    let scale = backing_scale.min((max_pixel_width / w).max(1.0)).max(0.5);
    let width = ((w * scale) as usize) & !1;
    let height = ((h * scale) as usize) & !1;
    (width >= 2 && height >= 2).then(|| OutputSize {
        width,
        height,
        scale_x: width as f64 / w,
        scale_y: height as f64 / h,
    })
}

pub fn average_bit_rate(size: OutputSize, fps: f64) -> i64 {
    ((size.width * size.height) as f64 * fps * 0.06) as i64
}

pub fn key_frame_interval(fps: f64) -> i64 {
    (fps * 5.0) as i64
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub fn thumbnail_png(
    bgra: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
) -> Option<Vec<u8>> {
    use image::ImageEncoder;
    let mut rgba = image::RgbaImage::new(width as u32, height as u32);
    for (y, row) in rgba.rows_mut().enumerate() {
        let line = bgra.get(y * bytes_per_row..y * bytes_per_row + width * 4)?;
        for (px, src) in row.zip(line.as_chunks::<4>().0) {
            *px = image::Rgba([src[2], src[1], src[0], 255]);
        }
    }
    let longest = width.max(height) as u32;
    let small = if longest > THUMBNAIL_MAX {
        let ratio = f64::from(THUMBNAIL_MAX) / f64::from(longest);
        image::imageops::thumbnail(
            &rgba,
            ((width as f64 * ratio).round() as u32).max(1),
            ((height as f64 * ratio).round() as u32).max(1),
        )
    } else {
        rgba
    };
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(
            small.as_raw(),
            small.width(),
            small.height(),
            image::ExtendedColorType::Rgba8,
        )
        .ok()?;
    Some(out)
}

pub const MINIMUM_ALPHA: f64 = 0.01;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayKind {
    PictureInPicture,
    Chrome,
    App,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayFill {
    Black,
    Picture,
    Layers,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OverlayCandidate {
    pub number: isize,
    pub frame: PointRect,
    pub kind: OverlayKind,
    pub owned: bool,
    pub alpha: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OverlayPlacement {
    pub candidate: OverlayCandidate,
    pub rect: PointRect,
    pub clip: Vec<PointRect>,
}

impl PointRect {
    pub fn is_empty(&self) -> bool {
        !(self.w > 0.0 && self.h > 0.0)
    }

    pub fn offset(&self, dx: f64, dy: f64) -> PointRect {
        PointRect {
            x: self.x + dx,
            y: self.y + dy,
            ..*self
        }
    }

    pub fn intersection(&self, other: &PointRect) -> Option<PointRect> {
        let x0 = self.x.max(other.x);
        let y0 = self.y.max(other.y);
        let x1 = (self.x + self.w).min(other.x + other.w);
        let y1 = (self.y + self.h).min(other.y + other.h);
        (x1 > x0 && y1 > y0).then_some(PointRect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        })
    }
}

pub fn place_overlay(
    frame: PointRect,
    main: PointRect,
    screens: &[PointRect],
) -> Option<(PointRect, Vec<PointRect>)> {
    let canvas = PointRect {
        x: 0.0,
        y: 0.0,
        w: main.w,
        h: main.h,
    };
    let rect = frame.offset(-main.x, -main.y);
    let clip: Vec<PointRect> = screens
        .iter()
        .filter_map(|screen| {
            screen
                .offset(-main.x, -main.y)
                .intersection(&rect)?
                .intersection(&canvas)
        })
        .collect();
    (!clip.is_empty()).then_some((rect, clip))
}

pub fn select_overlays(
    front_to_back: &[isize],
    main: isize,
    main_frame: PointRect,
    screens: &[PointRect],
    candidates: &[OverlayCandidate],
    excluded: &[isize],
) -> Vec<OverlayPlacement> {
    let depth_of = |n: isize| front_to_back.iter().position(|x| *x == n);
    let Some(main_depth) = depth_of(main) else {
        return Vec::new();
    };
    let mut kept: Vec<(usize, OverlayCandidate)> = candidates
        .iter()
        .filter(|c| {
            c.owned
                && c.number != main
                && !excluded.contains(&c.number)
                && c.alpha > MINIMUM_ALPHA
                && !c.frame.is_empty()
        })
        .filter_map(|c| {
            depth_of(c.number)
                .filter(|d| *d < main_depth)
                .map(|d| (d, *c))
        })
        .collect();
    kept.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    kept.into_iter()
        .filter_map(|(_, candidate)| {
            place_overlay(candidate.frame, main_frame, screens).map(|(rect, clip)| {
                OverlayPlacement {
                    candidate,
                    rect,
                    clip,
                }
            })
        })
        .collect()
}

pub fn overlay_fill(kind: OverlayKind, include_pages: bool, picture_fresh: bool) -> OverlayFill {
    if !include_pages {
        return OverlayFill::Black;
    }
    match kind {
        OverlayKind::PictureInPicture | OverlayKind::Chrome if picture_fresh => {
            OverlayFill::Picture
        }
        OverlayKind::PictureInPicture | OverlayKind::Chrome => OverlayFill::Black,
        OverlayKind::App => OverlayFill::Layers,
    }
}

#[cfg(target_os = "macos")]
pub use mac::{can_record, close_player, open_player, start};

#[cfg(not(target_os = "macos"))]
pub fn can_record() -> bool {
    false
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::ptr::NonNull;
    use std::sync::Arc;
    use std::time::Instant;

    use ardia_engine::NativeViewHandle;
    use gpui::{
        AnyWindowHandle, App, AppContext, Bounds, Window, WindowBackgroundAppearance, WindowBounds,
        WindowKind, WindowOptions, point, px, size,
    };
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{Encode, Encoding, msg_send};
    use objc2_av_foundation::{
        AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor,
        AVAssetWriterStatus, AVFileTypeMPEG4, AVMediaTypeVideo, AVVideoAllowFrameReorderingKey,
        AVVideoAverageBitRateKey, AVVideoCodecKey, AVVideoCodecTypeH264,
        AVVideoCompressionPropertiesKey, AVVideoHeightKey, AVVideoMaxKeyFrameIntervalKey,
        AVVideoProfileLevelH264HighAutoLevel, AVVideoProfileLevelKey, AVVideoWidthKey,
    };
    use objc2_core_media::CMTime;
    use objc2_core_video::{
        CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
        CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferPool,
        CVPixelBufferUnlockBaseAddress, kCVPixelBufferCGBitmapContextCompatibilityKey,
        kCVPixelBufferHeightKey, kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey,
        kCVPixelFormatType_32BGRA,
    };
    use objc2_foundation::{NSCopying, NSDictionary, NSNumber, NSString, NSURL};

    use super::*;
    use crate::report::{Finished, RecordPlan, RecorderBackend, ReportHub, StopDone};

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Point {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Size {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct Rect {
        origin: Point,
        size: Size,
    }

    unsafe impl Encode for Point {
        const ENCODING: Encoding =
            Encoding::Struct("CGPoint", &[Encoding::Double, Encoding::Double]);
    }

    unsafe impl Encode for Size {
        const ENCODING: Encoding =
            Encoding::Struct("CGSize", &[Encoding::Double, Encoding::Double]);
    }

    #[repr(C)]
    struct CgColor {
        _opaque: [u8; 0],
    }

    unsafe impl objc2::RefEncode for CgColor {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGColor", &[]));
    }

    unsafe impl Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
    }

    const IMAGE_BOUNDS_IGNORE_FRAMING: u32 = 1 << 0;
    const IMAGE_BEST_RESOLUTION: u32 = 1 << 3;
    const ALPHA_PREMULTIPLIED_FIRST: u32 = 2;
    const BYTE_ORDER_32_LITTLE: u32 = 2 << 12;
    const WINDOW_ABOVE: isize = 1;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        #[link_name = "CGWindowListCreateImageFromArray"]
        fn window_list_image(bounds: Rect, windows: *const c_void, options: u32) -> *mut c_void;
        fn CGImageRelease(image: *mut c_void);
        fn CGImageGetWidth(image: *mut c_void) -> usize;
        fn CGColorSpaceCreateWithName(name: *const c_void) -> *mut c_void;
        fn CGColorSpaceRelease(space: *mut c_void);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits: usize,
            bytes_per_row: usize,
            space: *mut c_void,
            info: u32,
        ) -> *mut c_void;
        fn CGContextRelease(ctx: *mut c_void);
        fn CGContextDrawImage(ctx: *mut c_void, rect: Rect, image: *mut c_void);
        fn CGContextSetRGBFillColor(ctx: *mut c_void, r: f64, g: f64, b: f64, a: f64);
        fn CGContextFillRect(ctx: *mut c_void, rect: Rect);
        fn CGContextSetInterpolationQuality(ctx: *mut c_void, quality: i32);
        fn CGColorGetConstantColor(name: *const c_void) -> *const CgColor;
        fn CGContextSaveGState(ctx: *mut c_void);
        fn CGContextRestoreGState(ctx: *mut c_void);
        fn CGContextClipToRects(ctx: *mut c_void, rects: *const Rect, count: usize);
        fn CGContextAddPath(ctx: *mut c_void, path: *const c_void);
        fn CGContextClip(ctx: *mut c_void);
        fn CGPathCreateWithRoundedRect(
            rect: Rect,
            corner_width: f64,
            corner_height: f64,
            transform: *const c_void,
        ) -> *const c_void;
        fn CGPathRelease(path: *const c_void);
        static kCGColorSpaceSRGB: *const c_void;
        static kCGColorBlack: *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFArrayCreate(
            allocator: *const c_void,
            values: *const *const c_void,
            count: isize,
            callbacks: *const c_void,
        ) -> *const c_void;
        fn CFRelease(object: *const c_void);
    }

    pub fn can_record() -> bool {
        AnyClass::get(c"AVAssetWriter").is_some()
    }

    struct Writer {
        writer: Retained<AVAssetWriter>,
        input: Retained<AVAssetWriterInput>,
        adaptor: Retained<AVAssetWriterInputPixelBufferAdaptor>,
    }

    fn any<T: objc2::Message>(object: Retained<T>) -> Retained<AnyObject> {
        unsafe { Retained::cast_unchecked(object) }
    }

    fn cf_key(key: &objc2_core_foundation::CFString) -> &NSString {
        unsafe { &*(key as *const objc2_core_foundation::CFString).cast::<NSString>() }
    }

    fn make_writer(path: &std::path::Path, out: OutputSize) -> Option<Writer> {
        let _ = std::fs::remove_file(path);
        unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            let writer =
                AVAssetWriter::assetWriterWithURL_fileType_error(&url, AVFileTypeMPEG4?).ok()?;
            let compression = NSDictionary::from_retained_objects(
                &[
                    AVVideoAverageBitRateKey?,
                    AVVideoMaxKeyFrameIntervalKey?,
                    AVVideoProfileLevelKey?,
                    AVVideoAllowFrameReorderingKey?,
                ],
                &[
                    any(NSNumber::new_i64(average_bit_rate(out, FPS))),
                    any(NSNumber::new_i64(key_frame_interval(FPS))),
                    any(AVVideoProfileLevelH264HighAutoLevel?.copy()),
                    any(NSNumber::new_bool(false)),
                ],
            );
            let settings = NSDictionary::from_retained_objects(
                &[
                    AVVideoCodecKey?,
                    AVVideoWidthKey?,
                    AVVideoHeightKey?,
                    AVVideoCompressionPropertiesKey?,
                ],
                &[
                    any(AVVideoCodecTypeH264?.copy()),
                    any(NSNumber::new_usize(out.width)),
                    any(NSNumber::new_usize(out.height)),
                    any(compression),
                ],
            );
            let input = AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(
                AVMediaTypeVideo?,
                Some(&settings),
            );
            input.setExpectsMediaDataInRealTime(true);
            let attributes = NSDictionary::from_retained_objects(
                &[
                    cf_key(kCVPixelBufferPixelFormatTypeKey),
                    cf_key(kCVPixelBufferWidthKey),
                    cf_key(kCVPixelBufferHeightKey),
                    cf_key(kCVPixelBufferCGBitmapContextCompatibilityKey),
                ],
                &[
                    any(NSNumber::new_u32(kCVPixelFormatType_32BGRA)),
                    any(NSNumber::new_usize(out.width)),
                    any(NSNumber::new_usize(out.height)),
                    any(NSNumber::new_bool(true)),
                ],
            );
            let adaptor = AVAssetWriterInputPixelBufferAdaptor::assetWriterInputPixelBufferAdaptorWithAssetWriterInput_sourcePixelBufferAttributes(&input, Some(&attributes));
            if !writer.canAddInput(&input) {
                return None;
            }
            writer.addInput(&input);
            if !writer.startWriting() {
                return None;
            }
            writer.startSessionAtSourceTime(CMTime::new(0, 600));
            Some(Writer {
                writer,
                input,
                adaptor,
            })
        }
    }

    fn ns_window_of(window: &mut Window) -> Option<Retained<AnyObject>> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
            return None;
        };
        let view = appkit.ns_view.as_ptr().cast::<AnyObject>();
        unsafe {
            let ns_window: *mut AnyObject = msg_send![view, window];
            Retained::retain(ns_window)
        }
    }

    fn content_view(window: &AnyObject) -> Option<Retained<AnyObject>> {
        unsafe {
            let content: *mut AnyObject = msg_send![window, contentView];
            Retained::retain(content)
        }
    }

    fn window_number(window: &AnyObject) -> isize {
        unsafe { msg_send![window, windowNumber] }
    }

    fn content_points(window: &AnyObject) -> Option<[f64; 2]> {
        let content = content_view(window)?;
        let bounds: Rect = unsafe { msg_send![&*content, bounds] };
        Some([bounds.size.width, bounds.size.height])
    }

    fn backing_scale(window: &AnyObject) -> f64 {
        unsafe { msg_send![window, backingScaleFactor] }
    }

    fn primary_screen_height() -> f64 {
        unsafe {
            let screens: *mut AnyObject = msg_send![objc2::class!(NSScreen), screens];
            if screens.is_null() {
                return 0.0;
            }
            let count: usize = msg_send![screens, count];
            if count == 0 {
                return 0.0;
            }
            let first: *mut AnyObject = msg_send![screens, objectAtIndex: 0usize];
            let frame: Rect = msg_send![first, frame];
            frame.size.height
        }
    }

    fn content_screen_rect(window: &AnyObject) -> Option<Rect> {
        let content = content_view(window)?;
        unsafe {
            let bounds: Rect = msg_send![&*content, bounds];
            let in_window: Rect = msg_send![&*content, convertRect: bounds, toView: std::ptr::null_mut::<AnyObject>()];
            let on_screen: Rect = msg_send![window, convertRectToScreen: in_window];
            let top = primary_screen_height() - (on_screen.origin.y + on_screen.size.height);
            Some(Rect {
                origin: Point {
                    x: on_screen.origin.x,
                    y: top,
                },
                size: on_screen.size,
            })
        }
    }

    fn content_cocoa_rect(window: &AnyObject) -> Option<Rect> {
        let content = content_view(window)?;
        unsafe {
            let bounds: Rect = msg_send![&*content, bounds];
            let in_window: Rect = msg_send![&*content, convertRect: bounds, toView: std::ptr::null_mut::<AnyObject>()];
            Some(msg_send![window, convertRectToScreen: in_window])
        }
    }

    fn point_rect(rect: Rect) -> PointRect {
        PointRect {
            x: rect.origin.x,
            y: rect.origin.y,
            w: rect.size.width,
            h: rect.size.height,
        }
    }

    fn cg_rect(rect: PointRect, out: OutputSize) -> Rect {
        Rect {
            origin: Point {
                x: rect.x * out.scale_x,
                y: rect.y * out.scale_y,
            },
            size: Size {
                width: rect.w * out.scale_x,
                height: rect.h * out.scale_y,
            },
        }
    }

    const RECT_NULL: Rect = Rect {
        origin: Point {
            x: f64::INFINITY,
            y: f64::INFINITY,
        },
        size: Size {
            width: 0.0,
            height: 0.0,
        },
    };

    fn capture_windows(numbers: &[isize], bounds: Rect) -> Option<CgImage> {
        unsafe {
            let values: Vec<*const c_void> = numbers
                .iter()
                .map(|n| *n as usize as *const c_void)
                .collect();
            let array = CFArrayCreate(
                std::ptr::null(),
                values.as_ptr(),
                values.len() as isize,
                std::ptr::null(),
            );
            if array.is_null() {
                return None;
            }
            let image = window_list_image(
                bounds,
                array,
                IMAGE_BOUNDS_IGNORE_FRAMING | IMAGE_BEST_RESOLUTION,
            );
            CFRelease(array);
            let image = CgImage(image);
            (!image.0.is_null() && CGImageGetWidth(image.0) > 0).then_some(image)
        }
    }

    struct CgImage(*mut c_void);

    impl Drop for CgImage {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CGImageRelease(self.0) };
            }
        }
    }

    fn screen_frames() -> Vec<PointRect> {
        let mut frames = Vec::new();
        unsafe {
            let screens: *mut AnyObject = msg_send![objc2::class!(NSScreen), screens];
            let Some(screens) = screens.as_ref() else {
                return frames;
            };
            let count: usize = msg_send![screens, count];
            for index in 0..count {
                let screen: *mut AnyObject = msg_send![screens, objectAtIndex: index];
                if let Some(screen) = screen.as_ref() {
                    let frame: Rect = msg_send![screen, frame];
                    frames.push(point_rect(frame));
                }
            }
        }
        frames
    }

    fn front_to_back() -> Vec<isize> {
        let mut order = Vec::new();
        unsafe {
            let numbers: *mut AnyObject =
                msg_send![objc2::class!(NSWindow), windowNumbersWithOptions: 0usize];
            let Some(numbers) = numbers.as_ref() else {
                return order;
            };
            let count: usize = msg_send![numbers, count];
            for index in 0..count {
                let number: *mut AnyObject = msg_send![numbers, objectAtIndex: index];
                if let Some(number) = number.as_ref() {
                    let value: isize = msg_send![number, integerValue];
                    order.push(value);
                }
            }
        }
        order
    }

    fn app_windows() -> Vec<Retained<AnyObject>> {
        let mut windows = Vec::new();
        unsafe {
            let app: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
            let list: *mut AnyObject = msg_send![app, windows];
            let Some(list) = list.as_ref() else {
                return windows;
            };
            let count: usize = msg_send![list, count];
            for index in 0..count {
                let window: *mut AnyObject = msg_send![list, objectAtIndex: index];
                if let Some(window) = Retained::retain(window) {
                    windows.push(window);
                }
            }
        }
        windows
    }

    fn bundle_path_of(class: *const AnyClass) -> Option<String> {
        unsafe {
            let bundle: *mut AnyObject = msg_send![objc2::class!(NSBundle), bundleForClass: class];
            let bundle = bundle.as_ref()?;
            let path: *mut NSString = msg_send![bundle, bundlePath];
            Some(path.as_ref()?.to_string())
        }
    }

    fn chromium_bundle() -> Option<String> {
        static PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
        PATH.get_or_init(|| {
            let class = AnyClass::get(c"RenderWidgetHostViewCocoa")?;
            bundle_path_of(class)
        })
        .clone()
    }

    fn is_chromium(window: &AnyObject) -> bool {
        let class: *const AnyClass = unsafe { msg_send![window, class] };
        chromium_bundle()
            .is_some_and(|chromium| bundle_path_of(class).as_deref() == Some(&chromium))
    }

    fn visible(window: &AnyObject) -> bool {
        unsafe { msg_send![window, isVisible] }
    }

    fn alpha_of(window: &AnyObject) -> f64 {
        unsafe { msg_send![window, alphaValue] }
    }

    fn level_of(window: &AnyObject) -> isize {
        unsafe { msg_send![window, level] }
    }

    fn frame_of(window: &AnyObject) -> PointRect {
        point_rect(unsafe { msg_send![window, frame] })
    }

    fn corner_radius_of(window: &AnyObject) -> f64 {
        let Some(content) = content_view(window) else {
            return 0.0;
        };
        unsafe {
            let layer: *mut AnyObject = msg_send![&*content, layer];
            layer
                .as_ref()
                .map_or(0.0, |layer| msg_send![layer, cornerRadius])
        }
    }

    const FLOATING_LEVEL: isize = 3;

    fn adopt(
        window: &AnyObject,
        owned: &mut Vec<(Retained<AnyObject>, OverlayKind)>,
        seen: &mut Vec<isize>,
    ) {
        unsafe {
            let children: *mut AnyObject = msg_send![window, childWindows];
            let mut next: Vec<Retained<AnyObject>> = Vec::new();
            if let Some(children) = children.as_ref() {
                let count: usize = msg_send![children, count];
                for index in 0..count {
                    let child: *mut AnyObject = msg_send![children, objectAtIndex: index];
                    if let Some(child) = Retained::retain(child) {
                        next.push(child);
                    }
                }
            }
            let sheet: *mut AnyObject = msg_send![window, attachedSheet];
            if let Some(sheet) = Retained::retain(sheet) {
                next.push(sheet);
            }
            for child in next {
                let number = window_number(&child);
                if seen.contains(&number) {
                    continue;
                }
                seen.push(number);
                let kind = if is_chromium(&child) {
                    OverlayKind::Chrome
                } else {
                    OverlayKind::App
                };
                adopt(&child, owned, seen);
                owned.push((child, kind));
            }
        }
    }

    fn page_rects(window: &AnyObject) -> Vec<PointRect> {
        let Some(content) = content_view(window) else {
            return Vec::new();
        };
        let classes: Vec<&AnyClass> = PAGE_VIEW_CLASSES
            .iter()
            .filter_map(|name| {
                let name = std::ffi::CString::new(*name).ok()?;
                AnyClass::get(&name)
            })
            .collect();
        let bounds: Rect = unsafe { msg_send![&*content, bounds] };
        let mut found = Vec::new();
        visit(&content, &content, &classes, bounds, &mut found);
        found
    }

    fn visit(
        view: &AnyObject,
        content: &AnyObject,
        classes: &[&AnyClass],
        bounds: Rect,
        found: &mut Vec<PointRect>,
    ) {
        unsafe {
            let hidden: bool = msg_send![view, isHidden];
            if hidden {
                return;
            }
            let page = !std::ptr::eq(view, content)
                && classes.iter().any(|class| {
                    let kind: bool = msg_send![view, isKindOfClass: *class];
                    kind
                });
            if page {
                let own: Rect = msg_send![view, bounds];
                let rect: Rect = msg_send![view, convertRect: own, toView: content];
                let flipped: bool = msg_send![content, isFlipped];
                let y = if flipped {
                    bounds.size.height - (rect.origin.y + rect.size.height)
                } else {
                    rect.origin.y
                };
                found.push(PointRect {
                    x: rect.origin.x,
                    y,
                    w: rect.size.width,
                    h: rect.size.height,
                });
                return;
            }
            let subviews: *mut AnyObject = msg_send![view, subviews];
            if subviews.is_null() {
                return;
            }
            let count: usize = msg_send![subviews, count];
            for index in 0..count {
                let child: *mut AnyObject = msg_send![subviews, objectAtIndex: index];
                if let Some(child) = child.as_ref() {
                    visit(child, content, classes, bounds, found);
                }
            }
        }
    }

    struct Session {
        window: Retained<AnyObject>,
        pill: Option<(AnyWindowHandle, Retained<AnyObject>)>,
        writer: Writer,
        out: OutputSize,
        points: [f64; 2],
        include_pages: bool,
        path: PathBuf,
        thumbnail: PathBuf,
        thumbnail_written: bool,
        started: Instant,
        last_frame: f64,
        frames: u64,
        skipped: u64,
        masked: usize,
        overlay_frames: u64,
        pip_frames: u64,
        withheld: Vec<isize>,
        pip_owned: Box<dyn Fn() -> bool>,
        shown_second: i64,
        pill_attached: bool,
        hub: Arc<ReportHub>,
        space: *mut c_void,
    }

    impl Drop for Session {
        fn drop(&mut self) {
            if !self.space.is_null() {
                unsafe { CGColorSpaceRelease(self.space) };
            }
        }
    }

    thread_local! {
        static ACTIVE: RefCell<Option<Session>> = const { RefCell::new(None) };
        static PLAYER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    struct NativeBackend;

    impl RecorderBackend for NativeBackend {
        fn stop(&self, done: StopDone) {
            match ACTIVE.try_with(|slot| slot.borrow_mut().take()) {
                Ok(Some(session)) => session.finish(done),
                _ => done(None),
            }
        }

        fn cancel(&self) {
            if let Ok(Some(session)) = ACTIVE.try_with(|slot| slot.borrow_mut().take()) {
                session.cancel();
            }
        }
    }

    impl Session {
        fn seconds(&self) -> f64 {
            self.started.elapsed().as_secs_f64()
        }

        fn pill_number(&self) -> Option<isize> {
            self.pill.as_ref().map(|(_, w)| window_number(w))
        }

        fn place_pill(&mut self) {
            let Some((_, pill)) = &self.pill else {
                return;
            };
            let attach = !self.pill_attached;
            self.pill_attached = true;
            unsafe {
                let parent: Rect = msg_send![&*self.window, frame];
                let frame: Rect = msg_send![&**pill, frame];
                let x =
                    (parent.origin.x + parent.size.width / 2.0 - frame.size.width / 2.0).round();
                let y = (parent.origin.y + parent.size.height - PILL_TOP_INSET - frame.size.height)
                    .round();
                if (frame.origin.x - x).abs() > 0.5 || (frame.origin.y - y).abs() > 0.5 {
                    let _: () = msg_send![&**pill, setFrameOrigin: Point { x, y }];
                }
                if attach {
                    let _: () =
                        msg_send![&*self.window, addChildWindow: &**pill, ordered: WINDOW_ABOVE];
                }
            }
        }

        fn frame(&mut self) {
            let now = self.seconds();
            if now <= self.last_frame {
                return;
            }
            let ready = unsafe { self.writer.input.isReadyForMoreMediaData() };
            let same_size = content_points(&self.window).is_some_and(|p| {
                (p[0] - self.points[0]).abs() < 0.5 && (p[1] - self.points[1]).abs() < 0.5
            });
            let pool: Option<Retained<CVPixelBufferPool>> =
                unsafe { self.writer.adaptor.pixelBufferPool() };
            let (true, true, Some(pool)) = (ready, same_size, pool) else {
                self.skipped += 1;
                return;
            };
            let Some(bounds) = content_screen_rect(&self.window) else {
                self.skipped += 1;
                return;
            };
            let main_number = window_number(&self.window);
            let Some(main_image) = capture_windows(&[main_number], bounds) else {
                self.skipped += 1;
                return;
            };
            let pages = if self.include_pages {
                Vec::new()
            } else {
                page_rects(&self.window)
            };
            self.masked = self.masked.max(pages.len());
            let overlays = self.collect_overlays();
            let mut buffer: *mut CVPixelBuffer = std::ptr::null_mut();
            let created = unsafe {
                CVPixelBufferPool::create_pixel_buffer(None, &pool, NonNull::from(&mut buffer))
            };
            let Some(buffer) = NonNull::new(buffer).filter(|_| created == 0) else {
                self.skipped += 1;
                return;
            };
            let buffer = unsafe { objc2_core_foundation::CFRetained::from_raw(buffer) };
            unsafe {
                CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags(0));
                let base = CVPixelBufferGetBaseAddress(&buffer);
                let row = CVPixelBufferGetBytesPerRow(&buffer);
                let ctx = CGBitmapContextCreate(
                    base,
                    self.out.width,
                    self.out.height,
                    8,
                    row,
                    self.space,
                    ALPHA_PREMULTIPLIED_FIRST | BYTE_ORDER_32_LITTLE,
                );
                if !ctx.is_null() {
                    let whole = Rect {
                        origin: Point::default(),
                        size: Size {
                            width: self.out.width as f64,
                            height: self.out.height as f64,
                        },
                    };
                    CGContextSetRGBFillColor(ctx, 0.0, 0.0, 0.0, 1.0);
                    CGContextFillRect(ctx, whole);
                    CGContextSetInterpolationQuality(ctx, 3);
                    CGContextDrawImage(ctx, whole, main_image.0);
                    for page in &pages {
                        CGContextFillRect(ctx, cg_rect(*page, self.out));
                    }
                    let drew_pip = self.draw_overlays(ctx, &overlays);
                    self.overlay_frames += u64::from(!overlays.is_empty());
                    self.pip_frames += u64::from(drew_pip);
                    CGContextRelease(ctx);
                }
                if !base.is_null() {
                    let bytes =
                        std::slice::from_raw_parts_mut(base.cast::<u8>(), row * self.out.height);
                    if !self.thumbnail_written
                        && (now >= THUMBNAIL_AT_SECONDS || self.frames == 0)
                        && let Some(png) =
                            thumbnail_png(bytes, self.out.width, self.out.height, row)
                    {
                        self.thumbnail_written = std::fs::write(&self.thumbnail, png).is_ok()
                            && now >= THUMBNAIL_AT_SECONDS;
                    }
                }
                CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags(0));
                let at = CMTime::with_seconds(now, 600);
                if self
                    .writer
                    .adaptor
                    .appendPixelBuffer_withPresentationTime(&buffer, at)
                {
                    self.last_frame = now;
                    self.frames += 1;
                } else {
                    self.skipped += 1;
                }
            }
        }

        fn collect_overlays(&mut self) -> Vec<(OverlayPlacement, Retained<AnyObject>)> {
            let main = window_number(&self.window);
            let excluded: Vec<isize> = self.pill_number().into_iter().collect();
            let Some(canvas) = content_cocoa_rect(&self.window).map(point_rect) else {
                return Vec::new();
            };
            let order = front_to_back();
            let mut owned: Vec<(Retained<AnyObject>, OverlayKind)> = Vec::new();
            let mut seen = vec![main];
            seen.extend(excluded.iter().copied());
            let windows = app_windows();
            if (self.pip_owned)() {
                for window in &windows {
                    let number = window_number(window);
                    let parent: *mut AnyObject = unsafe { msg_send![&**window, parentWindow] };
                    if !seen.contains(&number)
                        && parent.is_null()
                        && level_of(window) >= FLOATING_LEVEL
                        && is_chromium(window)
                    {
                        seen.push(number);
                        owned.push((window.clone(), OverlayKind::PictureInPicture));
                    }
                }
            }
            adopt(&self.window, &mut owned, &mut seen);
            let main_depth = order.iter().position(|n| *n == main).unwrap_or(0);
            for number in &order[..main_depth] {
                if seen.contains(number) || self.withheld.contains(number) {
                    continue;
                }
                let overlaps = windows.iter().any(|w| {
                    window_number(w) == *number
                        && visible(w)
                        && alpha_of(w) > MINIMUM_ALPHA
                        && frame_of(w).intersection(&canvas).is_some()
                });
                if overlaps {
                    self.withheld.push(*number);
                }
            }
            let candidates: Vec<OverlayCandidate> = owned
                .iter()
                .filter(|(w, _)| visible(w))
                .map(|(w, kind)| OverlayCandidate {
                    number: window_number(w),
                    frame: frame_of(w),
                    kind: *kind,
                    owned: true,
                    alpha: alpha_of(w),
                })
                .collect();
            select_overlays(
                &order,
                main,
                canvas,
                &screen_frames(),
                &candidates,
                &excluded,
            )
            .into_iter()
            .filter_map(|placement| {
                let window = owned
                    .iter()
                    .find(|(w, _)| window_number(w) == placement.candidate.number)?
                    .0
                    .clone();
                Some((placement, window))
            })
            .collect()
        }

        unsafe fn draw_overlays(
            &self,
            ctx: *mut c_void,
            overlays: &[(OverlayPlacement, Retained<AnyObject>)],
        ) -> bool {
            let mut drew_pip = false;
            for (placement, window) in overlays {
                let kind = placement.candidate.kind;
                let wants_picture = self.include_pages;
                let picture = wants_picture
                    .then(|| capture_windows(&[placement.candidate.number], RECT_NULL))
                    .flatten();
                let fill = overlay_fill(kind, self.include_pages, picture.is_some());
                let rect = cg_rect(placement.rect, self.out);
                let clips: Vec<Rect> = placement
                    .clip
                    .iter()
                    .map(|c| cg_rect(*c, self.out))
                    .collect();
                let radius = (corner_radius_of(window) * self.out.scale_x)
                    .min(rect.size.width / 2.0)
                    .min(rect.size.height / 2.0)
                    .max(0.0);
                unsafe {
                    CGContextSaveGState(ctx);
                    CGContextClipToRects(ctx, clips.as_ptr(), clips.len());
                    let path = CGPathCreateWithRoundedRect(rect, radius, radius, std::ptr::null());
                    if !path.is_null() {
                        CGContextAddPath(ctx, path);
                        CGContextClip(ctx);
                        CGPathRelease(path);
                    }
                    match (fill, &picture) {
                        (OverlayFill::Picture | OverlayFill::Layers, Some(image)) => {
                            CGContextDrawImage(ctx, rect, image.0);
                        }
                        _ => {
                            CGContextSetRGBFillColor(ctx, 0.0, 0.0, 0.0, 1.0);
                            CGContextFillRect(ctx, rect);
                        }
                    }
                    if fill == OverlayFill::Layers {
                        CGContextSetRGBFillColor(ctx, 0.0, 0.0, 0.0, 1.0);
                        for page in page_rects(window) {
                            let page = page.offset(placement.rect.x, placement.rect.y);
                            CGContextFillRect(ctx, cg_rect(page, self.out));
                        }
                    }
                    CGContextRestoreGState(ctx);
                }
                drew_pip |= kind == OverlayKind::PictureInPicture;
            }
            drew_pip
        }

        fn close_pill(&mut self, cx: Option<&mut App>) {
            if let Some((handle, pill)) = self.pill.take() {
                unsafe {
                    let _: () = msg_send![&*self.window, removeChildWindow: &*pill];
                    let _: () = msg_send![&*pill, orderOut: std::ptr::null_mut::<AnyObject>()];
                }
                if let Some(cx) = cx {
                    let _ = handle.update(cx, |_, window, _| window.remove_window());
                } else {
                    PENDING_CLOSE.with(|slot| slot.borrow_mut().push(handle));
                }
            }
        }

        fn finish(mut self, done: StopDone) {
            self.close_pill(None);
            let seconds = self.seconds().max(self.last_frame);
            log::info!(
                "report recording: {} frames, {} skipped, {} pages masked, {} overlay frames, {} picture in picture frames, {} windows withheld, {:.1}s",
                self.frames,
                self.skipped,
                self.masked,
                self.overlay_frames,
                self.pip_frames,
                self.withheld.len(),
                seconds
            );
            if self.frames == 0 {
                unsafe { self.writer.writer.cancelWriting() };
                let _ = std::fs::remove_file(&self.path);
                let _ = std::fs::remove_file(&self.thumbnail);
                done(None);
                return;
            }
            let path = self.path.clone();
            let thumbnail = self.thumbnail.clone();
            let writer = self.writer.writer.clone();
            let picture_in_picture = self.pip_frames > 0;
            unsafe {
                self.writer.input.markAsFinished();
                self.writer
                    .writer
                    .endSessionAtSourceTime(CMTime::with_seconds(self.last_frame, 600));
            }
            let done = RefCell::new(Some(done));
            let block = block2::RcBlock::new(move || {
                let Some(done) = done.borrow_mut().take() else {
                    return;
                };
                let completed = unsafe { writer.status() } == AVAssetWriterStatus::Completed;
                let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                if !completed || bytes == 0 {
                    let _ = std::fs::remove_file(&path);
                    let _ = std::fs::remove_file(&thumbnail);
                    done(None);
                    return;
                }
                done(Some(Finished {
                    path: path.to_string_lossy().into_owned(),
                    seconds,
                    bytes,
                    thumbnail: thumbnail
                        .is_file()
                        .then(|| thumbnail.to_string_lossy().into_owned()),
                    picture_in_picture,
                }));
            });
            unsafe {
                self.writer
                    .writer
                    .finishWritingWithCompletionHandler(&block);
            }
        }

        fn cancel(mut self) {
            self.close_pill(None);
            unsafe { self.writer.writer.cancelWriting() };
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_file(&self.thumbnail);
        }
    }

    thread_local! {
        static PENDING_CLOSE: RefCell<Vec<AnyWindowHandle>> = const { RefCell::new(Vec::new()) };
    }

    fn close_pending(cx: &mut App) {
        let pending = PENDING_CLOSE.with(|slot| std::mem::take(&mut *slot.borrow_mut()));
        for handle in pending {
            let _ = handle.update(cx, |_, window, _| window.remove_window());
        }
    }

    fn open_pill(
        parent: &AnyObject,
        host: Arc<dyn ardia_ui::host::UiHost>,
        cx: &mut App,
    ) -> Option<(AnyWindowHandle, Retained<AnyObject>)> {
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(0.0), px(0.0)),
                size: size(px(PILL_SIZE[0] as f32), px(PILL_SIZE[1] as f32)),
            })),
            titlebar: None,
            focus: false,
            show: false,
            kind: WindowKind::PopUp,
            is_movable: false,
            is_resizable: false,
            is_minimizable: false,
            window_background: WindowBackgroundAppearance::Transparent,
            ..WindowOptions::default()
        };
        let handle = cx
            .open_window(options, move |_, cx| {
                cx.new(|_| ardia_ui::report::pill::RecordingPillView::new(host))
            })
            .ok()?;
        let handle: AnyWindowHandle = handle.into();
        let pill = handle
            .update(cx, |_, window, _| ns_window_of(window))
            .ok()
            .flatten()?;
        unsafe {
            let level: isize = msg_send![parent, level];
            let _: () = msg_send![&*pill, setLevel: level];
            let _: () = msg_send![&*pill, setHasShadow: true];
            let _: () = msg_send![&*pill, setHidesOnDeactivate: false];
        }
        Some((handle, pill))
    }

    fn drive(cx: &mut App) {
        cx.spawn(async move |cx| {
            let mut wait = frame_interval();
            loop {
                cx.background_executor().timer(wait).await;
                let began = Instant::now();
                let running = cx.update(|cx| {
                    close_pending(cx);
                    let tick = ACTIVE.with(|slot| {
                        let mut slot = slot.borrow_mut();
                        let session = slot.as_mut()?;
                        session.frame();
                        let seconds = session.seconds();
                        let whole = seconds.floor() as i64;
                        let redraw = (whole != session.shown_second)
                            .then(|| session.pill.as_ref().map(|(handle, _)| *handle))
                            .flatten();
                        session.shown_second = whole;
                        Some((Arc::clone(&session.hub), seconds, redraw))
                    });
                    let Some((hub, seconds, redraw)) = tick else {
                        return false;
                    };
                    hub.recording_tick(seconds);
                    if let Some(pill) = redraw {
                        let _ = pill.update(cx, |_, window, _| window.refresh());
                    }
                    if seconds >= f64::from(ardia_ui::report::RECORDING_MAX_SECONDS) {
                        hub.command(ardia_ui::report::state::ReportCommand::StopRecording);
                    }
                    true
                });
                if !running {
                    break;
                }
                ACTIVE.with(|slot| {
                    if let Some(session) = slot.borrow_mut().as_mut() {
                        session.place_pill();
                    }
                });
                wait = frame_interval()
                    .saturating_sub(began.elapsed())
                    .max(MIN_FRAME_GAP);
            }
        })
        .detach();
    }

    pub fn start(
        hub: &Arc<ReportHub>,
        host: Arc<dyn ardia_ui::host::UiHost>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(plan) = hub.plan_recording() else {
            return;
        };
        match begin(&plan, hub, host, window, cx) {
            Some(session) => {
                ACTIVE.with(|slot| {
                    if let Some(old) = slot.borrow_mut().replace(session) {
                        old.cancel();
                    }
                });
                hub.recording_started(plan.include_pages, Arc::new(NativeBackend));
                drive(cx);
            }
            None => hub.recording_start_failed(),
        }
    }

    fn begin(
        plan: &RecordPlan,
        hub: &Arc<ReportHub>,
        host: Arc<dyn ardia_ui::host::UiHost>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Session> {
        let ns_window = ns_window_of(window)?;
        let points = content_points(&ns_window)?;
        let out = output_size(points, backing_scale(&ns_window), MAX_PIXEL_WIDTH)?;
        let writer = make_writer(&plan.path, out)?;
        let space = unsafe { CGColorSpaceCreateWithName(kCGColorSpaceSRGB) };
        let window_id = hub.view().window.clone();
        let pip_host = Arc::clone(&host);
        let pip_owned: Box<dyn Fn() -> bool> = Box::new(move || {
            let Some(window) = &window_id else {
                return false;
            };
            let state = pip_host.store().snapshot();
            state
                .tabs
                .values()
                .any(|tab| &tab.window_id == window && pip_host.media_pip_open(&tab.id))
        });
        let pill = open_pill(&ns_window, host, cx);
        let session = Session {
            window: ns_window,
            pill,
            writer,
            out,
            points,
            include_pages: plan.include_pages,
            path: plan.path.clone(),
            thumbnail: plan.thumbnail.clone(),
            thumbnail_written: false,
            started: Instant::now(),
            last_frame: -1.0,
            frames: 0,
            skipped: 0,
            masked: 0,
            overlay_frames: 0,
            pip_frames: 0,
            withheld: Vec::new(),
            pip_owned,
            shown_second: -1,
            pill_attached: false,
            hub: Arc::clone(hub),
            space,
        };
        Some(session)
    }

    pub fn open_player(path: &str) -> Option<NativeViewHandle> {
        close_player();
        unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let player: *mut AnyObject =
                msg_send![AnyClass::get(c"AVPlayer")?, playerWithURL: &*url];
            let player = player.as_ref()?;
            let layer: *mut AnyObject =
                msg_send![AnyClass::get(c"AVPlayerLayer")?, playerLayerWithPlayer: player];
            let layer = layer.as_ref()?;
            let gravity = NSString::from_str("AVLayerVideoGravityResizeAspect");
            let _: () = msg_send![layer, setVideoGravity: &*gravity];
            let view: Retained<AnyObject> = msg_send![objc2::class!(NSView), new];
            let _: () = msg_send![&*view, setLayer: layer];
            let _: () = msg_send![&*view, setWantsLayer: true];
            let black = CGColorGetConstantColor(kCGColorBlack);
            let _: () = msg_send![layer, setBackgroundColor: black];
            let _: () = msg_send![player, play];
            let raw = Retained::as_ptr(&view).cast_mut().cast::<c_void>();
            PLAYER.with(|slot| *slot.borrow_mut() = Some(view));
            Some(NativeViewHandle(raw))
        }
    }

    pub fn close_player() {
        let Some(view) = PLAYER.with(|slot| slot.borrow_mut().take()) else {
            return;
        };
        unsafe {
            let layer: *mut AnyObject = msg_send![&*view, layer];
            if let Some(layer) = layer.as_ref() {
                let player: *mut AnyObject = msg_send![layer, player];
                if let Some(player) = player.as_ref() {
                    let _: () = msg_send![player, pause];
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> PointRect {
        PointRect { x, y, w, h }
    }

    fn candidate(number: isize, frame: PointRect, kind: OverlayKind) -> OverlayCandidate {
        OverlayCandidate {
            number,
            frame,
            kind,
            owned: true,
            alpha: 1.0,
        }
    }

    #[test]
    fn overlays_follow_the_old_layout() {
        let main = rect(100.0, 100.0, 800.0, 600.0);
        let screens = [rect(0.0, 0.0, 1000.0, 800.0)];
        let pip = candidate(
            7,
            rect(700.0, 150.0, 300.0, 200.0),
            OverlayKind::PictureInPicture,
        );
        let menu = candidate(8, rect(200.0, 200.0, 100.0, 100.0), OverlayKind::Chrome);
        let behind = candidate(9, rect(200.0, 200.0, 100.0, 100.0), OverlayKind::App);
        let faded = OverlayCandidate {
            alpha: 0.0,
            ..candidate(10, rect(200.0, 200.0, 10.0, 10.0), OverlayKind::App)
        };
        let stranger = OverlayCandidate {
            owned: false,
            ..candidate(11, rect(200.0, 200.0, 10.0, 10.0), OverlayKind::App)
        };
        let order = [8, 11, 10, 7, 1, 9];
        let placed = select_overlays(
            &order,
            1,
            main,
            &screens,
            &[pip, menu, behind, faded, stranger],
            &[],
        );
        let numbers: Vec<isize> = placed.iter().map(|p| p.candidate.number).collect();
        assert_eq!(numbers, vec![7, 8]);
        assert_eq!(placed[0].rect, rect(600.0, 50.0, 300.0, 200.0));
        assert_eq!(placed[0].clip, vec![rect(600.0, 50.0, 200.0, 200.0)]);
        assert!(select_overlays(&order, 1, main, &screens, &[menu], &[8]).is_empty());
        assert!(place_overlay(rect(5000.0, 0.0, 10.0, 10.0), main, &screens).is_none());
    }

    #[test]
    fn overlay_fills_hide_pages_unless_asked() {
        use OverlayFill::*;
        use OverlayKind::*;
        assert_eq!(overlay_fill(PictureInPicture, false, true), Black);
        assert_eq!(overlay_fill(Chrome, false, true), Black);
        assert_eq!(overlay_fill(App, false, true), Black);
        assert_eq!(overlay_fill(PictureInPicture, true, true), Picture);
        assert_eq!(overlay_fill(PictureInPicture, true, false), Black);
        assert_eq!(overlay_fill(App, true, false), Layers);
    }

    #[test]
    fn output_size_is_even_and_capped() {
        let size = output_size([1001.0, 701.0], 2.0, MAX_PIXEL_WIDTH).expect("size");
        assert_eq!(size.width % 2, 0);
        assert_eq!(size.height % 2, 0);
        assert!(size.width <= 1440);
        assert_eq!(size.width, 1440);
        let small = output_size([400.0, 300.0], 2.0, MAX_PIXEL_WIDTH).expect("size");
        assert_eq!((small.width, small.height), (800, 600));
        assert!(output_size([1.0, 300.0], 2.0, MAX_PIXEL_WIDTH).is_none());
        assert_eq!(
            average_bit_rate(small, FPS),
            (800.0 * 600.0 * 15.0 * 0.06) as i64
        );
        assert_eq!(key_frame_interval(FPS), 75);
    }

    #[test]
    fn thumbnails_shrink_to_the_old_size() {
        let (w, h) = (960usize, 600usize);
        let bgra = vec![128u8; w * h * 4];
        let png = thumbnail_png(&bgra, w, h, w * 4).expect("png");
        let decoded = image::load_from_memory(&png).expect("decode");
        assert_eq!((decoded.width(), decoded.height()), (480, 300));
    }
}
