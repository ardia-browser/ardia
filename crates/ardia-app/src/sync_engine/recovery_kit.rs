use std::path::PathBuf;
use std::sync::Mutex;

pub const PDF_NAME: &str = "Ardia Recovery Kit.pdf";
pub const TEXT_NAME: &str = "Ardia Recovery Kit.txt";
pub const TEMPORARY_FOLDER: &str = "Ardia Recovery Kit";
pub const HIDDEN_WORD: &str = "••••••";
pub const QR_SCALE: f64 = 8.0;

pub const INTRO: &str = "If you don’t have access to the Mac on which you first turned on sync, you can still get your synced data on another Mac:";
pub const STEPS: [&str; 3] = [
    "Open Ardia › Settings › General › Sync, and choose the same sync folder.",
    "Click Enter Recovery Phrase.",
    "Paste the 24 words below.",
];
pub const WARNING: &str = "Keep this kit somewhere safe, like a password manager or a printed copy. Anyone with these words and your sync folder can read your synced data. Ardia can’t recover the words for you: there’s no server and no other copy.";
pub const MOVING_TITLE: &str = "Moving to a new Mac?";
pub const MOVING_TEXT: &str = "Scan this code with your iPhone’s camera to copy the words, then paste them on the new Mac with Universal Clipboard.";

pub fn hidden_words() -> Vec<String> {
    vec![HIDDEN_WORD.to_owned(); 24]
}

pub fn text(words: &[String], date: &str, device: &str) -> String {
    let mut lines: Vec<String> = vec![
        "Ardia Recovery Kit".into(),
        format!("Created {date} on {device}"),
        String::new(),
        INTRO.into(),
        String::new(),
    ];
    lines.extend(
        STEPS
            .iter()
            .enumerate()
            .map(|(i, step)| format!("{}. {step}", i + 1)),
    );
    lines.extend(["".into(), "Recovery phrase:".into(), "".into()]);
    lines.extend(
        words
            .iter()
            .enumerate()
            .map(|(i, word)| format!("{:>2}. {word}", i + 1)),
    );
    lines.extend(["".into(), WARNING.into(), "".into()]);
    lines.join("\n")
}

pub fn temporary_folder() -> PathBuf {
    std::env::temp_dir().join(TEMPORARY_FOLDER)
}

static KIT_WRITTEN: Mutex<bool> = Mutex::new(false);

pub fn remove_temporary_kits() {
    let written = KIT_WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
    if !*written {
        let _ = std::fs::remove_dir_all(temporary_folder());
    }
}

pub fn remove_temporary_kits_in_background() {
    let spawned = std::thread::Builder::new()
        .name("ardia-recovery-kit-cleanup".into())
        .spawn(remove_temporary_kits);
    if let Err(problem) = spawned {
        log::warn!("old recovery kits stay until the next launch: {problem}");
    }
}

pub fn write_temporary_kit(pdf: &[u8]) -> std::io::Result<PathBuf> {
    let mut written = KIT_WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
    *written = true;
    let dir = temporary_folder();
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let path = dir.join(PDF_NAME);
    let staging = dir.join(format!(".{}", uuid::Uuid::new_v4()));
    std::fs::write(&staging, pdf)?;
    std::fs::rename(&staging, &path)?;
    Ok(path)
}

pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let staging = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&staging, bytes)?;
    std::fs::rename(&staging, path)
}

#[cfg(target_os = "macos")]
pub use mac::{created_date, pdf, png_size, preview_png, qr_png};

#[cfg(not(target_os = "macos"))]
pub fn created_date(_at_ms: i64) -> String {
    String::new()
}

#[cfg(not(target_os = "macos"))]
pub fn pdf(_words: &[String], _date: &str, _device: &str) -> Vec<u8> {
    Vec::new()
}

#[cfg(not(target_os = "macos"))]
pub fn qr_png(_words: &[String], _scale: f64) -> Option<Vec<u8>> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn preview_png(_width: f64, _scale: f64, _date: &str, _device: &str) -> Option<Vec<u8>> {
    None
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    use objc2::encode::{Encode, Encoding, RefEncode};
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    use super::{INTRO, MOVING_TEXT, MOVING_TITLE, STEPS, WARNING, hidden_words};

    #[repr(C)]
    pub struct CGContext([u8; 0]);
    unsafe impl RefEncode for CGContext {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGContext", &[]));
    }

    #[repr(C)]
    pub struct CGImage([u8; 0]);
    unsafe impl RefEncode for CGImage {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGImage", &[]));
    }

    #[repr(C)]
    struct CGDataConsumer([u8; 0]);

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGAffineTransform {
        a: f64,
        b: f64,
        c: f64,
        d: f64,
        tx: f64,
        ty: f64,
    }
    unsafe impl Encode for CGAffineTransform {
        const ENCODING: Encoding = Encoding::Struct(
            "CGAffineTransform",
            &[
                f64::ENCODING,
                f64::ENCODING,
                f64::ENCODING,
                f64::ENCODING,
                f64::ENCODING,
                f64::ENCODING,
            ],
        );
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGDataConsumerCreateWithCFData(data: *mut AnyObject) -> *mut CGDataConsumer;
        fn CGDataConsumerRelease(consumer: *mut CGDataConsumer);
        fn CGPDFContextCreate(
            consumer: *mut CGDataConsumer,
            media_box: *const NSRect,
            info: *const AnyObject,
        ) -> *mut CGContext;
        fn CGPDFContextBeginPage(context: *mut CGContext, info: *const AnyObject);
        fn CGPDFContextEndPage(context: *mut CGContext);
        fn CGPDFContextClose(context: *mut CGContext);
        fn CGContextTranslateCTM(context: *mut CGContext, tx: f64, ty: f64);
        fn CGContextScaleCTM(context: *mut CGContext, sx: f64, sy: f64);
        fn CGContextRelease(context: *mut c_void);
        fn CGImageRelease(image: *mut c_void);
        static kCGPDFContextTitle: *const AnyObject;
    }

    fn class(name: &std::ffi::CStr) -> Option<&'static AnyClass> {
        AnyClass::get(name)
    }

    fn ns(text: &str) -> Retained<NSString> {
        NSString::from_str(text)
    }

    fn load_core_image() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| unsafe {
            libc::dlopen(
                c"/System/Library/Frameworks/CoreImage.framework/CoreImage".as_ptr(),
                libc::RTLD_LAZY,
            );
        });
    }

    fn dictionary(
        keys: &[*const AnyObject],
        values: &[*const AnyObject],
    ) -> Option<Retained<AnyObject>> {
        let dict = class(c"NSDictionary")?;
        unsafe {
            msg_send![dict, dictionaryWithObjects: values.as_ptr(), forKeys: keys.as_ptr(), count: keys.len()]
        }
    }

    fn font(selector: &str, size: f64) -> Option<Retained<AnyObject>> {
        let cls = class(c"NSFont")?;
        unsafe {
            match selector {
                "bold" => msg_send![cls, boldSystemFontOfSize: size],
                "digits" => msg_send![cls, monospacedDigitSystemFontOfSize: size, weight: 0.0f64],
                "courier" => {
                    let named: Option<Retained<AnyObject>> =
                        msg_send![cls, fontWithName: &*ns("Courier-Bold"), size: size];
                    named.or_else(
                        || msg_send![cls, monospacedSystemFontOfSize: size, weight: 0.4f64],
                    )
                }
                _ => msg_send![cls, systemFontOfSize: size],
            }
        }
    }

    fn white(level: f64) -> Option<Retained<AnyObject>> {
        let cls = class(c"NSColor")?;
        unsafe { msg_send![cls, colorWithWhite: level, alpha: 1.0f64] }
    }

    fn attributed(
        text: &str,
        font: &AnyObject,
        color: &AnyObject,
        spaced: bool,
    ) -> Option<Retained<AnyObject>> {
        let font_key = ns("NSFont");
        let color_key = ns("NSColor");
        let style_key = ns("NSParagraphStyle");
        let mut keys: Vec<*const AnyObject> = vec![
            Retained::as_ptr(&font_key).cast(),
            Retained::as_ptr(&color_key).cast(),
        ];
        let mut values: Vec<*const AnyObject> =
            vec![font as *const AnyObject, color as *const AnyObject];
        let style: Option<Retained<AnyObject>> = if spaced {
            let cls = class(c"NSMutableParagraphStyle")?;
            let style: Option<Retained<AnyObject>> = unsafe { msg_send![cls, new] };
            if let Some(style) = style.as_ref() {
                let _: () = unsafe { msg_send![&**style, setLineSpacing: 3.0f64] };
            }
            style
        } else {
            None
        };
        if let Some(style) = style.as_ref() {
            keys.push(Retained::as_ptr(&style_key).cast());
            values.push(Retained::as_ptr(style));
        }
        let attrs = dictionary(&keys, &values)?;
        let cls = class(c"NSAttributedString")?;
        let allocated: *mut AnyObject = unsafe { msg_send![cls, alloc] };
        unsafe {
            Retained::from_raw(
                msg_send![allocated, initWithString: &*ns(text), attributes: &*attrs],
            )
        }
    }

    struct Page {
        y: f64,
        margin: f64,
        width: f64,
    }

    impl Page {
        fn text(
            &mut self,
            string: &str,
            font: &AnyObject,
            color: &AnyObject,
            x: Option<f64>,
            width: Option<f64>,
            spacing: f64,
        ) {
            let x = x.unwrap_or(self.margin);
            let width = width.unwrap_or(self.width);
            let Some(text) = attributed(string, font, color, true) else {
                return;
            };
            const LINE_FRAGMENT_ORIGIN: usize = 1;
            let bounds: NSRect = unsafe {
                msg_send![&*text, boundingRectWithSize: NSSize::new(width, 1000.0), options: LINE_FRAGMENT_ORIGIN]
            };
            let height = bounds.size.height.ceil();
            let rect = NSRect::new(NSPoint::new(x, self.y), NSSize::new(width, height));
            let _: () =
                unsafe { msg_send![&*text, drawWithRect: rect, options: LINE_FRAGMENT_ORIGIN] };
            self.y += height + spacing;
        }
    }

    pub fn created_date(at_ms: i64) -> String {
        let Some(formatter_class) = class(c"NSDateFormatter") else {
            return String::new();
        };
        unsafe {
            let formatter: Option<Retained<AnyObject>> = msg_send![formatter_class, new];
            let Some(formatter) = formatter else {
                return String::new();
            };
            let locale_class = class(c"NSLocale");
            let current: Option<Retained<AnyObject>> =
                locale_class.and_then(|c| msg_send![c, currentLocale]);
            let region: Option<Retained<NSString>> =
                current.as_ref().and_then(|l| msg_send![&**l, regionCode]);
            let identifier = format!(
                "en_{}",
                region.map_or_else(|| "US".to_owned(), |r| r.to_string())
            );
            if let Some(locale_class) = locale_class {
                let locale: Option<Retained<AnyObject>> =
                    msg_send![locale_class, localeWithLocaleIdentifier: &*ns(&identifier)];
                if let Some(locale) = locale {
                    let _: () = msg_send![&*formatter, setLocale: &*locale];
                }
            }
            let _: () = msg_send![&*formatter, setDateStyle: 3usize];
            let _: () = msg_send![&*formatter, setTimeStyle: 0usize];
            let Some(date_class) = class(c"NSDate") else {
                return String::new();
            };
            let date: Option<Retained<AnyObject>> =
                msg_send![date_class, dateWithTimeIntervalSince1970: at_ms as f64 / 1000.0];
            let Some(date) = date else {
                return String::new();
            };
            let text: Option<Retained<NSString>> = msg_send![&*formatter, stringFromDate: &*date];
            text.map(|t| t.to_string()).unwrap_or_default()
        }
    }

    fn qr_image(words: &[String], scale: f64) -> Option<*mut CGImage> {
        load_core_image();
        let filter_class = class(c"CIFilter")?;
        unsafe {
            let filter: Option<Retained<AnyObject>> =
                msg_send![filter_class, filterWithName: &*ns("CIQRCodeGenerator")];
            let filter = filter?;
            let message = words.join(" ");
            let data_class = class(c"NSData")?;
            let data: Option<Retained<AnyObject>> = msg_send![data_class, dataWithBytes: message.as_ptr().cast::<c_void>(), length: message.len()];
            let data = data?;
            let _: () = msg_send![&*filter, setValue: &*data, forKey: &*ns("inputMessage")];
            let _: () =
                msg_send![&*filter, setValue: &*ns("M"), forKey: &*ns("inputCorrectionLevel")];
            let output: Option<Retained<AnyObject>> = msg_send![&*filter, outputImage];
            let transform = CGAffineTransform {
                a: scale,
                b: 0.0,
                c: 0.0,
                d: scale,
                tx: 0.0,
                ty: 0.0,
            };
            let scaled: Option<Retained<AnyObject>> =
                msg_send![&*output?, imageByApplyingTransform: transform];
            let scaled = scaled?;
            let extent: NSRect = msg_send![&*scaled, extent];
            let software_key = libc::dlsym(
                libc::RTLD_DEFAULT,
                c"kCIContextUseSoftwareRenderer".as_ptr(),
            )
            .cast::<*const AnyObject>();
            let number_class = class(c"NSNumber")?;
            let yes: Option<Retained<AnyObject>> =
                msg_send![number_class, numberWithBool: Bool::YES];
            let yes = yes?;
            let options = if software_key.is_null() {
                None
            } else {
                dictionary(&[*software_key], &[Retained::as_ptr(&yes)])
            };
            let context_class = class(c"CIContext")?;
            let context: Option<Retained<AnyObject>> = match options.as_ref() {
                Some(options) => msg_send![context_class, contextWithOptions: &**options],
                None => msg_send![context_class, contextWithOptions: std::ptr::null::<AnyObject>()],
            };
            let image: *mut CGImage =
                msg_send![&*context?, createCGImage: &*scaled, fromRect: extent];
            (!image.is_null()).then_some(image)
        }
    }

    fn png_of(image: *mut CGImage) -> Option<Vec<u8>> {
        let rep_class = class(c"NSBitmapImageRep")?;
        unsafe {
            let allocated: *mut AnyObject = msg_send![rep_class, alloc];
            let rep: Option<Retained<AnyObject>> =
                Retained::from_raw(msg_send![allocated, initWithCGImage: image]);
            let rep = rep?;
            let data_dictionary = dictionary(&[], &[])?;
            const PNG: usize = 4;
            let png: Option<Retained<AnyObject>> =
                msg_send![&*rep, representationUsingType: PNG, properties: &*data_dictionary];
            bytes(png?)
        }
    }

    fn bytes(data: Retained<AnyObject>) -> Option<Vec<u8>> {
        unsafe {
            let length: usize = msg_send![&*data, length];
            let pointer: *const c_void = msg_send![&*data, bytes];
            if pointer.is_null() {
                return Some(Vec::new());
            }
            Some(std::slice::from_raw_parts(pointer.cast::<u8>(), length).to_vec())
        }
    }

    pub fn png_size(png: &[u8]) -> Option<(u32, u32)> {
        if png.len() < 24 || &png[1..4] != b"PNG" {
            return None;
        }
        Some((
            u32::from_be_bytes([png[16], png[17], png[18], png[19]]),
            u32::from_be_bytes([png[20], png[21], png[22], png[23]]),
        ))
    }

    pub fn qr_png(words: &[String], scale: f64) -> Option<Vec<u8>> {
        let image = qr_image(words, scale)?;
        let png = png_of(image);
        unsafe { CGImageRelease(image.cast()) };
        png
    }

    fn draw(words: &[String], date: &str, device: &str, page: NSSize) {
        let margin = 60.0;
        let mut at = Page {
            y: 64.0,
            margin,
            width: page.width - margin * 2.0,
        };
        let (Some(ink), Some(grey), Some(title), Some(small), Some(body)) = (
            white(0.1),
            white(0.4),
            font("bold", 26.0),
            font("system", 12.0),
            font("system", 13.0),
        ) else {
            return;
        };
        at.text("Ardia Recovery Kit", &title, &ink, None, None, 4.0);
        at.text(
            &format!("Created {date} on {device}"),
            &small,
            &grey,
            None,
            None,
            26.0,
        );
        at.text(INTRO, &body, &ink, None, None, 10.0);
        for (i, step) in STEPS.iter().enumerate() {
            at.text(
                &format!("{}.  {step}", i + 1),
                &body,
                &ink,
                Some(margin + 8.0),
                Some(at.width - 8.0),
                4.0,
            );
        }
        at.y += 18.0;
        let box_rect = NSRect::new(
            NSPoint::new(margin, at.y),
            NSSize::new(at.width, 6.0 * 26.0 + 30.0),
        );
        if let Some(path_class) = class(c"NSBezierPath") {
            unsafe {
                let path: Option<Retained<AnyObject>> = msg_send![path_class, bezierPathWithRoundedRect: box_rect, xRadius: 12.0f64, yRadius: 12.0f64];
                if let (Some(path), Some(fill), Some(stroke)) = (path, white(0.96), white(0.82)) {
                    let _: () = msg_send![&*fill, setFill];
                    let _: () = msg_send![&*path, fill];
                    let _: () = msg_send![&*stroke, setStroke];
                    let _: () = msg_send![&*path, setLineWidth: 1.0f64];
                    let _: () = msg_send![&*path, stroke];
                }
            }
        }
        let column = (box_rect.size.width - 36.0) / 4.0;
        if let (Some(number), Some(word_font)) = (font("digits", 10.0), font("courier", 14.0)) {
            for (i, word) in words.iter().enumerate() {
                let x = box_rect.origin.x + 18.0 + (i / 6) as f64 * column;
                let row_y = box_rect.origin.y + 15.0 + (i % 6) as f64 * 26.0;
                if let Some(label) = attributed(&(i + 1).to_string(), &number, &grey, false) {
                    let size: NSSize = unsafe { msg_send![&*label, size] };
                    let _: () = unsafe {
                        msg_send![&*label, drawAtPoint: NSPoint::new(x + 14.0 - size.width, row_y + 3.0)]
                    };
                }
                if let Some(text) = attributed(word, &word_font, &ink, false) {
                    let _: () =
                        unsafe { msg_send![&*text, drawAtPoint: NSPoint::new(x + 20.0, row_y)] };
                }
            }
        }
        at.y = box_rect.origin.y + box_rect.size.height + 22.0;
        let side = 112.0;
        if let Some(qr) = qr_image(words, 4.0) {
            unsafe {
                if let Some(context_class) = class(c"NSGraphicsContext") {
                    let current: Option<Retained<AnyObject>> =
                        msg_send![context_class, currentContext];
                    if let Some(current) = current {
                        let _: () = msg_send![&*current, setImageInterpolation: 1usize];
                    }
                }
                if let Some(image_class) = class(c"NSImage") {
                    let allocated: *mut AnyObject = msg_send![image_class, alloc];
                    let image: Option<Retained<AnyObject>> = Retained::from_raw(
                        msg_send![allocated, initWithCGImage: qr, size: NSSize::new(side, side)],
                    );
                    if let Some(image) = image {
                        let target =
                            NSRect::new(NSPoint::new(margin, at.y), NSSize::new(side, side));
                        let zero = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
                        const SOURCE_OVER: usize = 2;
                        let _: () = msg_send![&*image, drawInRect: target, fromRect: zero, operation: SOURCE_OVER, fraction: 1.0f64, respectFlipped: Bool::YES, hints: std::ptr::null::<AnyObject>()];
                    }
                }
                CGImageRelease(qr.cast());
            }
        }
        let caption_y = at.y;
        at.y += 18.0;
        if let Some(bold) = font("bold", 12.0) {
            at.text(
                MOVING_TITLE,
                &bold,
                &ink,
                Some(margin + side + 18.0),
                Some(at.width - side - 18.0),
                4.0,
            );
        }
        at.text(
            MOVING_TEXT,
            &small,
            &grey,
            Some(margin + side + 18.0),
            Some(at.width - side - 18.0),
            8.0,
        );
        at.y = at.y.max(caption_y + side) + 26.0;
        if let Some(tiny) = font("system", 11.0) {
            at.text(WARNING, &tiny, &grey, None, None, 8.0);
        }
    }

    pub fn pdf(words: &[String], date: &str, device: &str) -> Vec<u8> {
        let Some(data_class) = class(c"NSMutableData") else {
            return Vec::new();
        };
        unsafe {
            let data: Option<Retained<AnyObject>> = msg_send![data_class, data];
            let Some(data) = data else { return Vec::new() };
            let consumer = CGDataConsumerCreateWithCFData(Retained::as_ptr(&data).cast_mut());
            if consumer.is_null() {
                return Vec::new();
            }
            let title = ns("Ardia Recovery Kit");
            let info = dictionary(&[kCGPDFContextTitle], &[Retained::as_ptr(&title).cast()]);
            let page = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(612.0, 792.0));
            let context = CGPDFContextCreate(
                consumer,
                &page,
                info.as_ref().map_or(std::ptr::null(), Retained::as_ptr),
            );
            if context.is_null() {
                CGDataConsumerRelease(consumer);
                return Vec::new();
            }
            CGPDFContextBeginPage(context, std::ptr::null());
            let graphics_class = class(c"NSGraphicsContext");
            let previous: Option<Retained<AnyObject>> =
                graphics_class.and_then(|c| msg_send![c, currentContext]);
            let graphics: Option<Retained<AnyObject>> = graphics_class.and_then(
                |c| msg_send![c, graphicsContextWithCGContext: context, flipped: Bool::YES],
            );
            if let (Some(cls), Some(graphics)) = (graphics_class, graphics.as_ref()) {
                let _: () = msg_send![cls, setCurrentContext: &**graphics];
            }
            CGContextTranslateCTM(context, 0.0, page.size.height);
            CGContextScaleCTM(context, 1.0, -1.0);
            draw(words, date, device, page.size);
            if let Some(cls) = graphics_class {
                match previous.as_ref() {
                    Some(previous) => {
                        let _: () = msg_send![cls, setCurrentContext: &**previous];
                    }
                    None => {
                        let _: () =
                            msg_send![cls, setCurrentContext: std::ptr::null::<AnyObject>()];
                    }
                }
            }
            CGPDFContextEndPage(context);
            CGPDFContextClose(context);
            CGContextRelease(context.cast());
            CGDataConsumerRelease(consumer);
            bytes(data).unwrap_or_default()
        }
    }

    pub fn preview_png(width: f64, scale: f64, date: &str, device: &str) -> Option<Vec<u8>> {
        let pdf = pdf(&hidden_words(), date, device);
        let data_class = class(c"NSData")?;
        let image_class = class(c"NSImage")?;
        let rep_class = class(c"NSBitmapImageRep")?;
        let graphics_class = class(c"NSGraphicsContext")?;
        unsafe {
            let data: Option<Retained<AnyObject>> = msg_send![data_class, dataWithBytes: pdf.as_ptr().cast::<c_void>(), length: pdf.len()];
            let allocated: *mut AnyObject = msg_send![image_class, alloc];
            let page: Option<Retained<AnyObject>> =
                Retained::from_raw(msg_send![allocated, initWithData: &*data?]);
            let page = page?;
            let page_size: NSSize = msg_send![&*page, size];
            if page_size.width <= 0.0 {
                return None;
            }
            let size = NSSize::new(width, width * page_size.height / page_size.width);
            let pixels_wide = (size.width * scale) as isize;
            let pixels_high = (size.height * scale) as isize;
            let space = ns("NSDeviceRGBColorSpace");
            let allocated: *mut AnyObject = msg_send![rep_class, alloc];
            let rep: Option<Retained<AnyObject>> = Retained::from_raw(msg_send![
                allocated,
                initWithBitmapDataPlanes: std::ptr::null_mut::<*mut u8>(),
                pixelsWide: pixels_wide,
                pixelsHigh: pixels_high,
                bitsPerSample: 8isize,
                samplesPerPixel: 4isize,
                hasAlpha: Bool::YES,
                isPlanar: Bool::NO,
                colorSpaceName: &*space,
                bytesPerRow: 0isize,
                bitsPerPixel: 0isize
            ]);
            let rep = rep?;
            let _: () = msg_send![&*rep, setSize: size];
            let _: () = msg_send![graphics_class, saveGraphicsState];
            let context: Option<Retained<AnyObject>> =
                msg_send![graphics_class, graphicsContextWithBitmapImageRep: &*rep];
            if let Some(context) = context.as_ref() {
                let _: () = msg_send![graphics_class, setCurrentContext: &**context];
            }
            let whole = NSRect::new(NSPoint::new(0.0, 0.0), size);
            if let Some(fill) = white(1.0) {
                let _: () = msg_send![&*fill, setFill];
            }
            if let Some(path_class) = class(c"NSBezierPath") {
                let _: () = msg_send![path_class, fillRect: whole];
            }
            let _: () = msg_send![&*page, drawInRect: whole];
            let _: () = msg_send![graphics_class, restoreGraphicsState];
            let png: Option<Retained<AnyObject>> = msg_send![&*rep, representationUsingType: 4usize, properties: &*dictionary(&[], &[])?];
            bytes(png?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_kit_matches_the_swift_sheet() {
        let words: Vec<String> = (1..=24).map(|i| format!("w{i}")).collect();
        let kit = text(&words, "November 26, 2026", "Studio");
        let lines: Vec<&str> = kit.split('\n').collect();
        assert_eq!(lines[0], "Ardia Recovery Kit");
        assert_eq!(lines[1], "Created November 26, 2026 on Studio");
        assert_eq!(lines[3], INTRO);
        assert_eq!(
            lines[5],
            "1. Open Ardia › Settings › General › Sync, and choose the same sync folder."
        );
        assert_eq!(lines[9], "Recovery phrase:");
        assert_eq!(lines[11], " 1. w1");
        assert_eq!(lines[34], "24. w24");
        assert_eq!(lines[36], WARNING);
        assert_eq!(*lines.last().unwrap(), "");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_pdf_qr_and_preview_render() {
        let words: Vec<String> = ["abandon"; 24].iter().map(|w| (*w).to_owned()).collect();
        let pdf = pdf(&words, "November 26, 2026", "Studio");
        assert!(pdf.starts_with(b"%PDF"));
        let png = qr_png(&words, QR_SCALE).expect("qr");
        let (w, h) = png_size(&png).expect("png");
        assert_eq!(w, h);
        assert_eq!(w % 8, 0);
        let preview = preview_png(168.0, 2.0, "November 26, 2026", "Studio").expect("preview");
        assert_eq!(png_size(&preview), Some((336, 434)));
        assert!(!created_date(1_795_000_000_000).is_empty());
    }

    #[test]
    fn startup_cleanup_never_removes_a_kit_written_this_session() {
        let path = write_temporary_kit(b"%PDF-1.4 kit").expect("the kit is written");
        remove_temporary_kits();
        assert!(path.exists(), "a kit made this session stays");
        let _ = std::fs::remove_file(&path);
    }
}
