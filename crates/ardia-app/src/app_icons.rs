use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

pub fn bundle_id(browser: &str) -> Option<&'static str> {
    Some(match browser {
        "chrome" => "com.google.Chrome",
        "chromium" => "org.chromium.Chromium",
        "brave" => "com.brave.Browser",
        "edge" => "com.microsoft.edgemac",
        "vivaldi" => "com.vivaldi.Vivaldi",
        "arc" => "company.thebrowser.Browser",
        "dia" => "company.thebrowser.dia",
        "safari" | "safari-export" => "com.apple.Safari",
        _ => return None,
    })
}

static PATHS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);
type PidIcons = HashMap<(i32, u32), Option<Arc<gpui::Image>>>;

static PIDS: Mutex<Option<PidIcons>> = Mutex::new(None);

#[cfg(target_os = "macos")]
mod mac {
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSRunningApplication, NSWorkspace,
    };
    use objc2_foundation::{NSDictionary, NSSize, NSString};

    pub fn app_path(bundle: &str) -> Option<String> {
        let url = NSWorkspace::sharedWorkspace()
            .URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle))?;
        Some(url.path()?.to_string())
    }

    pub fn png(icon: &NSImage, points: f64) -> Option<Vec<u8>> {
        icon.setSize(NSSize::new(points * 2.0, points * 2.0));
        let tiff = icon.TIFFRepresentation()?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
        let png = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }?;
        Some(png.to_vec())
    }

    pub fn running_icon(pid: i32, points: f64) -> Option<Vec<u8>> {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
        let icon = app.icon()?;
        png(&icon, points)
    }
}

pub fn browser_app_path(browser: &str) -> Option<String> {
    let bundle = bundle_id(browser)?;
    let mut guard = PATHS.lock();
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some(known) = cache.get(bundle) {
        return known.clone();
    }
    #[cfg(target_os = "macos")]
    let found = mac::app_path(bundle);
    #[cfg(not(target_os = "macos"))]
    let found = None;
    cache.insert(bundle.to_owned(), found.clone());
    found
}

pub fn running_app_icon(pid: i32, points: f32) -> Option<Arc<gpui::Image>> {
    let key = (pid, points.round() as u32);
    let mut guard = PIDS.lock();
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some(known) = cache.get(&key) {
        return known.clone();
    }
    #[cfg(target_os = "macos")]
    let found = mac::running_icon(pid, f64::from(points))
        .map(|png| Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png, png)));
    #[cfg(not(target_os = "macos"))]
    let found = None;
    if cache.len() > 256 {
        cache.clear();
    }
    cache.insert(key, found.clone());
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browsers_map_to_their_bundles() {
        assert_eq!(bundle_id("chrome"), Some("com.google.Chrome"));
        assert_eq!(bundle_id("safari-export"), Some("com.apple.Safari"));
        assert_eq!(bundle_id("firefox"), None);
    }
}
