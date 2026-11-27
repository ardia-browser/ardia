use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

pub const DEFAULTS_KEY: &str = "ACAppIcon";

pub const PREVIEW_PIXELS: isize = 112;

pub struct Variant {
    pub id: &'static str,
    pub name: &'static str,
    pub flat: bool,
    pub artwork: Option<&'static [u8]>,
}

macro_rules! art {
    ($name:literal) => {
        Some(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/browser/macos/Ardia-macOS/Assets.xcassets/AppIcon-",
            $name,
            ".imageset/icon.png"
        )) as &'static [u8])
    };
}

pub const VARIANTS: [Variant; 14] = [
    Variant {
        id: "default",
        name: "Default",
        flat: false,
        artwork: None,
    },
    Variant {
        id: "midnight",
        name: "Midnight",
        flat: false,
        artwork: art!("midnight"),
    },
    Variant {
        id: "daylight",
        name: "Daylight",
        flat: false,
        artwork: art!("daylight"),
    },
    Variant {
        id: "plum",
        name: "Plum",
        flat: false,
        artwork: art!("plum"),
    },
    Variant {
        id: "ocean",
        name: "Ocean",
        flat: false,
        artwork: art!("ocean"),
    },
    Variant {
        id: "mono",
        name: "Mono",
        flat: false,
        artwork: art!("mono"),
    },
    Variant {
        id: "noir",
        name: "Noir",
        flat: false,
        artwork: art!("noir"),
    },
    Variant {
        id: "default-flat",
        name: "Default",
        flat: true,
        artwork: art!("default-flat"),
    },
    Variant {
        id: "midnight-flat",
        name: "Midnight",
        flat: true,
        artwork: art!("midnight-flat"),
    },
    Variant {
        id: "daylight-flat",
        name: "Daylight",
        flat: true,
        artwork: art!("daylight-flat"),
    },
    Variant {
        id: "plum-flat",
        name: "Plum",
        flat: true,
        artwork: art!("plum-flat"),
    },
    Variant {
        id: "ocean-flat",
        name: "Ocean",
        flat: true,
        artwork: art!("ocean-flat"),
    },
    Variant {
        id: "mono-flat",
        name: "Mono",
        flat: true,
        artwork: art!("mono-flat"),
    },
    Variant {
        id: "noir-flat",
        name: "Noir",
        flat: true,
        artwork: art!("noir-flat"),
    },
];

pub fn known(id: &str) -> bool {
    VARIANTS.iter().any(|variant| variant.id == id)
}

pub fn checked(saved: Option<&str>) -> &'static str {
    saved
        .and_then(|id| VARIANTS.iter().find(|variant| variant.id == id))
        .map_or("default", |variant| variant.id)
}

fn previews() -> &'static Mutex<HashMap<&'static str, Arc<gpui::Image>>> {
    static PREVIEWS: OnceLock<Mutex<HashMap<&'static str, Arc<gpui::Image>>>> = OnceLock::new();
    PREVIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn preview(id: &str) -> Option<Arc<gpui::Image>> {
    let variant = VARIANTS.iter().find(|variant| variant.id == id)?;
    let mut cache = previews().lock().ok()?;
    if let Some(found) = cache.get(variant.id) {
        return Some(Arc::clone(found));
    }
    let bytes = match variant.artwork {
        Some(bytes) => bytes.to_vec(),
        None => platform::bundle_icon_png()?,
    };
    let image = Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png, bytes));
    cache.insert(variant.id, Arc::clone(&image));
    Some(image)
}

pub fn current() -> &'static str {
    checked(platform::saved().as_deref())
}

pub fn set(id: &str, apply: bool) {
    if !known(id) {
        return;
    }
    platform::save(id);
    if apply {
        platform::apply(id);
    }
}

pub fn restore() {
    let id = current();
    if id != "default" {
        platform::apply(id);
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::{NSData, NSPoint, NSRect, NSSize, NSString};

    use super::{DEFAULTS_KEY, PREVIEW_PIXELS, VARIANTS};

    fn defaults() -> Option<Retained<AnyObject>> {
        unsafe { msg_send![class!(NSUserDefaults), standardUserDefaults] }
    }

    pub fn saved() -> Option<String> {
        let defaults = defaults()?;
        let key = NSString::from_str(DEFAULTS_KEY);
        let value: Option<Retained<NSString>> =
            unsafe { msg_send![&*defaults, stringForKey: &*key] };
        value.map(|value| value.to_string())
    }

    pub fn save(id: &str) {
        let Some(defaults) = defaults() else {
            return;
        };
        let key = NSString::from_str(DEFAULTS_KEY);
        let value = NSString::from_str(id);
        let _: () = unsafe { msg_send![&*defaults, setObject: &*value, forKey: &*key] };
    }

    pub fn apply(id: &str) {
        let Some(app): Option<Retained<AnyObject>> =
            (unsafe { msg_send![class!(NSApplication), sharedApplication] })
        else {
            return;
        };
        let artwork = VARIANTS
            .iter()
            .find(|variant| variant.id == id)
            .and_then(|variant| variant.artwork);
        let image: Option<Retained<AnyObject>> = artwork.and_then(|bytes| {
            let data = NSData::with_bytes(bytes);
            let alloc: objc2::rc::Allocated<AnyObject> =
                unsafe { msg_send![class!(NSImage), alloc] };
            unsafe { msg_send![alloc, initWithData: &*data] }
        });
        let shown: *const AnyObject = image.as_deref().map_or(std::ptr::null(), |image| image);
        let _: () = unsafe { msg_send![&*app, setApplicationIconImage: shown] };
    }

    pub fn bundle_icon_png() -> Option<Vec<u8>> {
        let bundle: Option<Retained<AnyObject>> =
            unsafe { msg_send![class!(NSBundle), mainBundle] };
        let bundle = bundle?;
        let path: Option<Retained<NSString>> = unsafe { msg_send![&*bundle, bundlePath] };
        let path = path?;
        let workspace: Retained<AnyObject> =
            unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] };
        let icon: Option<Retained<AnyObject>> =
            unsafe { msg_send![&*workspace, iconForFile: &*path] };
        let icon = icon?;
        rasterize(&icon, PREVIEW_PIXELS)
    }

    fn rasterize(image: &AnyObject, pixels: isize) -> Option<Vec<u8>> {
        let space = NSString::from_str("NSDeviceRGBColorSpace");
        let allocated: *mut AnyObject = unsafe { msg_send![class!(NSBitmapImageRep), alloc] };
        let rep: *mut AnyObject = unsafe {
            msg_send![
                allocated,
                initWithBitmapDataPlanes: std::ptr::null_mut::<*mut u8>(),
                pixelsWide: pixels,
                pixelsHigh: pixels,
                bitsPerSample: 8isize,
                samplesPerPixel: 4isize,
                hasAlpha: Bool::YES,
                isPlanar: Bool::NO,
                colorSpaceName: &*space,
                bytesPerRow: 0isize,
                bitsPerPixel: 0isize
            ]
        };
        let rep = unsafe { Retained::from_raw(rep) }?;
        let context: Option<Retained<AnyObject>> = unsafe {
            msg_send![class!(NSGraphicsContext), graphicsContextWithBitmapImageRep: &*rep]
        };
        let context = context?;
        let side = pixels as f64;
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(side, side));
        unsafe {
            let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
            let _: () = msg_send![class!(NSGraphicsContext), setCurrentContext: &*context];
            let _: () = msg_send![image, drawInRect: frame];
            let _: () = msg_send![&*context, flushGraphics];
            let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];
        }
        let props: Retained<AnyObject> = unsafe { msg_send![class!(NSDictionary), dictionary] };
        let png: Option<Retained<NSData>> =
            unsafe { msg_send![&*rep, representationUsingType: 4usize, properties: &*props] };
        png.map(|png| png.to_vec())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn saved() -> Option<String> {
        None
    }

    pub fn save(_id: &str) {}

    pub fn apply(_id: &str) {}

    pub fn bundle_icon_png() -> Option<Vec<u8>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variants_match_the_old_list_and_unknown_ids_fall_back() {
        let ids: Vec<&str> = VARIANTS.iter().map(|variant| variant.id).collect();
        assert_eq!(ids.len(), 14);
        assert_eq!(ids[0], "default");
        assert_eq!(VARIANTS.iter().filter(|variant| variant.flat).count(), 7);
        assert!(VARIANTS.iter().skip(1).all(|variant| {
            variant
                .artwork
                .is_some_and(|art| art.starts_with(b"\x89PNG"))
        }));
        assert_eq!(checked(Some("plum")), "plum");
        assert_eq!(checked(Some("nope")), "default");
        assert_eq!(checked(None), "default");
    }
}
