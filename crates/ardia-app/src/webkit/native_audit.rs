use std::ffi::{CStr, CString, c_void};

use objc2::encode::{Encode, Encoding, RefEncode};
use objc2::runtime::{AnyClass, AnyObject, AnyProtocol, Bool, Sel};
use objc2_app_kit::{NSEvent, NSView};
use objc2_foundation::{NSError, NSPoint, NSRect, NSSize, NSString, NSURL};

#[repr(C)]
struct SecTrustRef {
    _private: [u8; 0],
}

unsafe impl RefEncode for SecTrustRef {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("__SecTrust", &[]));
}

#[repr(C)]
struct Opaque {
    _private: [u8; 0],
}

unsafe impl RefEncode for Opaque {
    const ENCODING_REF: Encoding =
        Encoding::Pointer(&Encoding::Struct("OpaqueWKNotificationManager", &[]));
}

type Object<'a> = &'a AnyObject;
type Maybe<'a> = Option<&'a AnyObject>;
type Block<'a> = &'a block2::DynBlock<dyn Fn()>;
type Got = *mut AnyObject;
type MaybeGot = *mut AnyObject;

#[derive(Default)]
struct Audit {
    checked: usize,
    absent: Vec<String>,
    wrong: Vec<String>,
}

impl Audit {
    fn record(
        &mut self,
        class: &CStr,
        class_method: bool,
        selector: &str,
        optional: bool,
        verify: impl FnOnce(&AnyClass, Sel) -> Result<(), objc2::runtime::VerificationError>,
    ) {
        let name = format!(
            "{}[{} {selector}]",
            if class_method { "+" } else { "-" },
            class.to_string_lossy()
        );
        let Some(found) = AnyClass::get(class) else {
            self.absent.push(format!("{name}: class missing"));
            return;
        };
        let target = if class_method {
            found.metaclass()
        } else {
            found
        };
        let Ok(text) = CString::new(selector) else {
            self.wrong.push(format!("{name}: bad selector"));
            return;
        };
        let sel = Sel::register(&text);
        self.checked += 1;
        if let Err(error) = verify(target, sel) {
            let message = error.to_string();
            if message.contains("method not found") || message.contains("not found") {
                if optional {
                    self.absent.push(format!("{name}: {message}"));
                } else {
                    self.wrong.push(format!("{name}: {message}"));
                }
            } else {
                self.wrong.push(format!("{name}: {message}"));
            }
        }
    }
}

macro_rules! inst {
    ($audit:expr, $class:literal, $sel:literal, ($($arg:ty),*) -> $ret:ty) => {
        $audit.record($class, false, $sel, false, |c, s| c.verify_sel::<($($arg,)*), $ret>(s))
    };
    ($audit:expr, ?$class:literal, $sel:literal, ($($arg:ty),*) -> $ret:ty) => {
        $audit.record($class, false, $sel, true, |c, s| c.verify_sel::<($($arg,)*), $ret>(s))
    };
}

macro_rules! class {
    ($audit:expr, $class:literal, $sel:literal, ($($arg:ty),*) -> $ret:ty) => {
        $audit.record($class, true, $sel, false, |c, s| c.verify_sel::<($($arg,)*), $ret>(s))
    };
    ($audit:expr, ?$class:literal, $sel:literal, ($($arg:ty),*) -> $ret:ty) => {
        $audit.record($class, true, $sel, true, |c, s| c.verify_sel::<($($arg,)*), $ret>(s))
    };
}

fn link_frameworks() {
    let _ = <objc2_web_kit::WKWebView as objc2::ClassType>::class();
    let _ = <objc2_app_kit::NSView as objc2::ClassType>::class();
    let _ = crate::webkit::passkeys::entitled;
}

fn message_sends(a: &mut Audit) {
    inst!(a, c"WKNavigationResponse", "isForMainFrame", () -> Bool);
    inst!(a, c"WKNavigationResponse", "canShowMIMEType", () -> Bool);
    inst!(a, c"WKNavigationResponse", "response", () -> Got);
    inst!(a, c"NSObject", "performSelectorOnMainThread:withObject:waitUntilDone:", (Sel, Maybe, Bool) -> ());
    inst!(a, ?c"WKWebView", "_isPlayingAudio", () -> Bool);
    inst!(a, c"NSObject", "addObserver:forKeyPath:options:context:", (Object, &NSString, usize, *mut c_void) -> ());
    inst!(a, c"NSObject", "removeObserver:forKeyPath:", (Object, &NSString) -> ());
    inst!(a, c"WKNavigationAction", "shouldPerformDownload", () -> Bool);
    inst!(a, c"NSObject", "respondsToSelector:", (Sel) -> Bool);
    class!(a, c"NSObject", "respondsToSelector:", (Sel) -> Bool);
    class!(a, c"NSObject", "respondsToSelector:", (Sel) -> Bool);
    inst!(a, c"NSObject", "respondsToSelector:", (Sel) -> Bool);
    inst!(a, ?c"WKNavigationAction", "_isUserInitiated", () -> Bool);
    inst!(a, c"NSString", "stringByStandardizingPath", () -> *mut NSString);
    class!(a, c"NSBundle", "bundleWithPath:", (&NSString) -> MaybeGot);
    inst!(a, c"NSBundle", "infoDictionary", () -> MaybeGot);
    inst!(a, c"NSDictionary", "objectForKey:", (&NSString) -> *mut NSString);
    inst!(a, c"NSDictionary", "objectForKey:", (Object) -> *mut AnyObject);
    inst!(a, ?c"WKPreferences", "_setAllowsPictureInPictureMediaPlayback:", (Bool) -> ());
    inst!(a, ?c"WKWebView", "_setWindowOcclusionDetectionEnabled:", (Bool) -> ());
    inst!(a, ?c"WKWebView", "_mediaMutedState", () -> usize);
    inst!(a, ?c"WKWebView", "_setPageMuted:", (usize) -> ());
    inst!(a, c"WKWebView", "themeColor", () -> MaybeGot);
    class!(a, c"NSColorSpace", "sRGBColorSpace", () -> Got);
    inst!(a, c"NSColor", "colorUsingColorSpace:", (Object) -> MaybeGot);
    inst!(a, c"NSColor", "redComponent", () -> f64);
    inst!(a, c"NSColor", "greenComponent", () -> f64);
    inst!(a, c"NSColor", "blueComponent", () -> f64);
    inst!(a, c"NSURL", "URLByDeletingLastPathComponent", () -> *mut NSURL);
    inst!(a, ?c"WKWebView", "_setFindDelegate:", (Maybe) -> ());
    inst!(a, ?c"WKWebView", "_findDelegate", () -> *mut AnyObject);
    class!(a, c"NSObject", "instancesRespondToSelector:", (Sel) -> Bool);
    inst!(a, ?c"WKWebView", "_findString:options:maxCount:", (&NSString, usize, usize) -> ());
    inst!(a, ?c"WKWebView", "_hideFindUI", () -> ());
    inst!(a, c"NSView", "window", () -> MaybeGot);
    inst!(a, c"NSWindow", "makeFirstResponder:", (Object) -> Bool);
    inst!(a, c"NSView", "isHidden", () -> Bool);
    inst!(a, c"NSView", "isHidden", () -> Bool);
    inst!(a, c"NSObject", "performSelector:withObject:afterDelay:", (Sel, Maybe, f64) -> ());
    class!(a, c"NSAlert", "new", () -> Got);
    inst!(a, c"NSAlert", "setMessageText:", (&NSString) -> ());
    inst!(a, c"NSAlert", "setInformativeText:", (&NSString) -> ());
    inst!(a, c"NSAlert", "addButtonWithTitle:", (&NSString) -> Got);
    class!(a, c"NSTextField", "new", () -> Got);
    inst!(a, c"NSTextField", "setFrame:", (NSRect) -> ());
    inst!(a, c"NSTextField", "setStringValue:", (&NSString) -> ());
    inst!(a, c"NSAlert", "setAccessoryView:", (Object) -> ());
    inst!(a, c"NSAlert", "window", () -> Got);
    inst!(a, c"NSWindow", "setInitialFirstResponder:", (Object) -> ());
    inst!(a, c"NSAlert", "setShowsSuppressionButton:", (Bool) -> ());
    inst!(a, c"NSAlert", "suppressionButton", () -> MaybeGot);
    inst!(a, c"NSButton", "setTitle:", (&NSString) -> ());
    inst!(a, c"NSButton", "state", () -> isize);
    inst!(a, c"NSTextField", "stringValue", () -> *mut NSString);
    inst!(a, c"NSAlert", "beginSheetModalForWindow:completionHandler:", (Object, &block2::DynBlock<dyn Fn(isize)>) -> ());
    inst!(a, c"NSWindow", "sheetParent", () -> MaybeGot);
    inst!(a, c"NSWindow", "endSheet:returnCode:", (Object, isize) -> ());
    class!(a, c"NSWorkspace", "sharedWorkspace", () -> Got);
    inst!(a, c"NSWorkspace", "URLForApplicationToOpenURL:", (&NSURL) -> *mut NSURL);
    class!(a, c"NSFileManager", "defaultManager", () -> Got);
    inst!(a, c"NSFileManager", "displayNameAtPath:", (&NSString) -> *mut NSString);
    inst!(a, c"NSWorkspace", "iconForFile:", (&NSString) -> Got);
    inst!(a, c"NSImage", "setSize:", (NSSize) -> ());
    inst!(a, c"NSImage", "TIFFRepresentation", () -> MaybeGot);
    class!(a, c"NSBitmapImageRep", "imageRepWithData:", (Object) -> MaybeGot);
    class!(a, c"NSDictionary", "dictionary", () -> Got);
    inst!(a, c"NSBitmapImageRep", "representationUsingType:properties:", (usize, Object) -> MaybeGot);
    inst!(a, c"NSData", "bytes", () -> *const c_void);
    inst!(a, c"NSData", "length", () -> usize);
    inst!(a, c"NSWorkspace", "openURL:", (Object) -> Bool);
    inst!(a, c"WKWebView", "loadHTMLString:baseURL:", (&NSString, Option<&NSURL>) -> MaybeGot);
    inst!(a, c"NSError", "userInfo", () -> Got);
    inst!(a, c"NSURL", "absoluteString", () -> *mut NSString);
    class!(a, c"NSDateFormatter", "new", () -> Got);
    inst!(a, c"NSDateFormatter", "setDateStyle:", (usize) -> ());
    inst!(a, c"NSDateFormatter", "setTimeStyle:", (usize) -> ());
    class!(a, c"NSDate", "date", () -> Got);
    inst!(a, c"NSDateFormatter", "stringFromDate:", (Object) -> *mut NSString);
    inst!(a, c"NSObject", "isKindOfClass:", (&AnyClass) -> Bool);
    inst!(a, c"NSURLResponse", "URL", () -> *mut NSURL);
    inst!(a, c"NSHTTPURLResponse", "valueForHTTPHeaderField:", (&NSString) -> *mut NSString);
    inst!(a, c"WKWebView", "serverTrust", () -> *const SecTrustRef);
    inst!(a, c"NSURL", "port", () -> MaybeGot);
    inst!(a, c"NSNumber", "unsignedShortValue", () -> u16);
    inst!(a, ?c"WKWebpagePreferences", "setPreferredHTTPSNavigationPolicy:", (isize) -> ());
    inst!(a, c"NSURLAuthenticationChallenge", "protectionSpace", () -> Got);
    inst!(a, c"NSURLProtectionSpace", "authenticationMethod", () -> *mut NSString);
    inst!(a, c"NSURLProtectionSpace", "serverTrust", () -> *const SecTrustRef);
    inst!(a, c"NSURLProtectionSpace", "host", () -> *mut NSString);
    class!(a, c"NSURLCredential", "credentialForTrust:", (*const SecTrustRef) -> Got);
    class!(a, c"NSData", "dataWithBytes:length:", (*const c_void, usize) -> Got);
    inst!(a, ?c"WKWebView", "setInteractionState:", (Object) -> ());
    inst!(a, ?c"WKWebView", "interactionState", () -> MaybeGot);
    class!(a, c"NSObject", "cancelPreviousPerformRequestsWithTarget:selector:object:", (Object, Sel, Maybe) -> ());
    inst!(a, c"NSArray", "count", () -> usize);
    inst!(a, c"NSArray", "objectAtIndex:", (usize) -> *mut AnyObject);
    inst!(a, c"NSArray", "objectAtIndex:", (usize) -> Got);
    inst!(a, c"NSArray", "objectAtIndex:", (usize) -> *mut NSString);
    inst!(a, c"NSDictionary", "allKeys", () -> Got);
    inst!(a, c"NSNumber", "boolValue", () -> Bool);
    inst!(a, c"NSNumber", "doubleValue", () -> f64);

    class!(a, c"NSLocale", "localeWithLocaleIdentifier:", (&NSString) -> MaybeGot);
    class!(a, c"NSLocale", "currentLocale", () -> MaybeGot);
    inst!(a, c"NSLocale", "localizedStringForCountryCode:", (&NSString) -> *mut NSString);
    inst!(a, c"NSLocale", "countryCode", () -> *mut NSString);
    class!(a, c"NSLocale", "ISOCountryCodes", () -> Got);

    inst!(a, c"NSObject", "setValue:forKey:", (Object, &NSString) -> ());
    inst!(a, c"NSDictionary", "objectForKey:", (&NSString) -> MaybeGot);

    inst!(a, c"WKDownload", "setDelegate:", (Object) -> ());
    inst!(a, c"WKDownload", "progress", () -> MaybeGot);
    inst!(a, c"WKDownload", "originalRequest", () -> MaybeGot);
    inst!(a, c"NSURLRequest", "URL", () -> *mut NSURL);
    inst!(a, c"NSProgress", "completedUnitCount", () -> i64);
    inst!(a, c"NSProgress", "totalUnitCount", () -> i64);
    inst!(a, c"NSURLResponse", "suggestedFilename", () -> *mut NSString);
    inst!(a, c"NSURLResponse", "MIMEType", () -> *mut NSString);
    inst!(a, c"NSURLResponse", "expectedContentLength", () -> i64);
    class!(a, c"NSSavePanel", "savePanel", () -> Got);
    inst!(a, c"NSSavePanel", "setDirectoryURL:", (&NSURL) -> ());
    inst!(a, c"NSSavePanel", "setNameFieldStringValue:", (&NSString) -> ());
    inst!(a, c"NSSavePanel", "URL", () -> *mut NSURL);
    inst!(a, c"NSSavePanel", "beginWithCompletionHandler:", (&block2::DynBlock<dyn Fn(isize)>) -> ());
    class!(a, c"NSMutableDictionary", "dictionary", () -> Got);
    inst!(a, c"NSMutableDictionary", "setObject:forKey:", (Object, &NSString) -> ());
    class!(a, c"NSBundle", "mainBundle", () -> Got);
    inst!(a, c"NSBundle", "objectForInfoDictionaryKey:", (&NSString) -> *mut NSString);
    inst!(a, c"NSBundle", "bundleIdentifier", () -> *mut NSString);
    inst!(a, c"NSURL", "setResourceValue:forKey:error:", (Object, &NSString, *mut *mut AnyObject) -> Bool);
    class!(a, c"NSMutableArray", "array", () -> Got);
    inst!(a, c"NSMutableArray", "addObject:", (Object) -> ());
    class!(a, c"NSPropertyListSerialization", "dataWithPropertyList:format:options:error:", (Object, usize, usize, *mut *mut AnyObject) -> MaybeGot);
    inst!(a, c"NSError", "code", () -> isize);
    inst!(a, c"WKDownload", "cancel:", (&block2::DynBlock<dyn Fn(*mut AnyObject)>) -> ());
    inst!(a, c"WKDownload", "cancel:", (*const AnyObject) -> ());
    inst!(a, c"WKWebView", "resumeDownloadFromResumeData:completionHandler:", (Object, &block2::DynBlock<dyn Fn(*mut AnyObject)>) -> ());

    inst!(a, c"NSView", "isHiddenOrHasHiddenAncestor", () -> Bool);
    inst!(a, c"NSWindow", "occlusionState", () -> usize);
    inst!(a, c"NSWindow", "isMiniaturized", () -> Bool);
    class!(a, c"NSNotificationCenter", "defaultCenter", () -> Got);
    inst!(a, c"NSNotificationCenter", "addObserverForName:object:queue:usingBlock:", (&NSString, *const AnyObject, *const AnyObject, &block2::DynBlock<dyn Fn(*mut AnyObject)>) -> MaybeGot);
    inst!(a, c"NSNotificationCenter", "addObserverForName:object:queue:usingBlock:", (&NSString, Object, *const AnyObject, &block2::DynBlock<dyn Fn(*mut AnyObject)>) -> MaybeGot);
    inst!(a, c"NSNotificationCenter", "removeObserver:", (Object) -> ());

    class!(a, ?c"ASAuthorizationWebBrowserPublicKeyCredentialManager", "isDeviceConfiguredForPasskeys", () -> Bool);
    class!(a, ?c"ASAuthorizationWebBrowserPublicKeyCredentialManager", "new", () -> MaybeGot);
    inst!(a, ?c"ASAuthorizationWebBrowserPublicKeyCredentialManager", "authorizationStateForPlatformCredentials", () -> isize);
    inst!(a, ?c"ASAuthorizationWebBrowserPublicKeyCredentialManager", "requestAuthorizationForPublicKeyCredentials:", (&block2::DynBlock<dyn Fn(isize)>) -> ());

    class!(a, c"NSJSONSerialization", "isValidJSONObject:", (Object) -> Bool);
    class!(a, c"NSJSONSerialization", "dataWithJSONObject:options:error:", (Object, usize, *mut *mut NSError) -> MaybeGot);
    inst!(a, c"WKWebView", "pageZoom", () -> f64);
    inst!(a, c"WKWebView", "magnification", () -> f64);
    inst!(a, c"WKWebView", "hasOnlySecureContent", () -> Bool);

    inst!(a, c"NSView", "updateTrackingAreas", () -> ());
    inst!(a, c"NSView", "trackingAreas", () -> Got);
    inst!(a, c"NSView", "removeTrackingArea:", (Object) -> ());
    class!(a, c"NSTrackingArea", "alloc", () -> *mut AnyObject);
    inst!(a, c"NSTrackingArea", "initWithRect:options:owner:userInfo:", (NSRect, usize, Object, *const AnyObject) -> MaybeGot);
    inst!(a, c"NSView", "addTrackingArea:", (Object) -> ());
    inst!(a, c"NSEvent", "locationInWindow", () -> NSPoint);
    inst!(a, c"NSView", "convertPoint:fromView:", (NSPoint, *const NSView) -> NSPoint);
    inst!(a, c"NSView", "bounds", () -> NSRect);
    class!(a, c"NSColor", "selectedContentBackgroundColor", () -> Got);
    inst!(a, c"NSColor", "setFill", () -> ());
    class!(a, c"NSBezierPath", "bezierPathWithRoundedRect:xRadius:yRadius:", (NSRect, f64, f64) -> Got);
    inst!(a, c"NSBezierPath", "fill", () -> ());
    inst!(a, c"NSView", "layout", () -> ());
    class!(a, c"NSObject", "performSelector:", (Sel) -> MaybeGot);
    class!(a, c"NSFont", "menuFontOfSize:", (f64) -> MaybeGot);
    class!(a, c"NSMutableDictionary", "new", () -> Got);
    inst!(a, c"NSString", "drawWithRect:options:attributes:", (NSRect, isize, Object) -> ());
    class!(a, c"NSTextField", "labelWithString:", (&NSString) -> MaybeGot);
    inst!(a, c"NSTextField", "setFont:", (Object) -> ());
    inst!(a, c"NSTextField", "setLineBreakMode:", (usize) -> ());
    class!(a, c"NSImage", "imageWithSystemSymbolName:accessibilityDescription:", (&NSString, *const NSString) -> MaybeGot);
    class!(a, c"NSImageSymbolConfiguration", "configurationWithPointSize:weight:", (f64, f64) -> MaybeGot);
    inst!(a, c"NSImage", "imageWithSymbolConfiguration:", (Object) -> MaybeGot);
    class!(a, c"NSImageView", "imageViewWithImage:", (Object) -> MaybeGot);
    inst!(a, c"NSView", "initWithFrame:", (NSRect) -> Got);
    inst!(a, c"NSView", "addSubview:", (Object) -> ());
    inst!(a, c"NSView", "setHidden:", (Bool) -> ());
    inst!(a, c"NSView", "setAccessibilityElement:", (Bool) -> ());
    inst!(a, c"NSView", "setAccessibilityRole:", (&NSString) -> ());
    inst!(a, c"NSView", "setAccessibilityLabel:", (&NSString) -> ());
    inst!(a, c"NSView", "setFrame:", (NSRect) -> ());
    inst!(a, c"NSView", "setNeedsDisplay:", (Bool) -> ());
    inst!(a, c"NSTextField", "setTextColor:", (Object) -> ());
    inst!(a, c"NSColor", "colorWithAlphaComponent:", (f64) -> Got);
    inst!(a, c"NSImageView", "setContentTintColor:", (Object) -> ());
    inst!(a, c"NSView", "scrollRectToVisible:", (NSRect) -> Bool);
    class!(a, c"NSPanel", "alloc", () -> *mut AnyObject);
    inst!(a, c"NSPanel", "initWithContentRect:styleMask:backing:defer:", (NSRect, usize, usize, Bool) -> MaybeGot);
    inst!(a, c"NSWindow", "setReleasedWhenClosed:", (Bool) -> ());
    inst!(a, c"NSWindow", "setHidesOnDeactivate:", (Bool) -> ());
    inst!(a, c"NSPanel", "setBecomesKeyOnlyIfNeeded:", (Bool) -> ());
    inst!(a, c"NSWindow", "setHasShadow:", (Bool) -> ());
    inst!(a, c"NSWindow", "setOpaque:", (Bool) -> ());
    inst!(a, c"NSWindow", "setBackgroundColor:", (Object) -> ());
    inst!(a, c"NSWindow", "setAnimationBehavior:", (isize) -> ());
    inst!(a, c"NSWindow", "setAccessibilityRole:", (&NSString) -> ());
    class!(a, c"NSVisualEffectView", "new", () -> Got);
    inst!(a, c"NSVisualEffectView", "setMaterial:", (isize) -> ());
    inst!(a, c"NSVisualEffectView", "setBlendingMode:", (isize) -> ());
    inst!(a, c"NSVisualEffectView", "setState:", (isize) -> ());
    inst!(a, c"NSView", "setWantsLayer:", (Bool) -> ());
    inst!(a, c"NSView", "layer", () -> MaybeGot);
    inst!(a, c"CALayer", "setCornerRadius:", (f64) -> ());
    inst!(a, c"CALayer", "setMasksToBounds:", (Bool) -> ());
    class!(a, c"NSScrollView", "new", () -> Got);
    inst!(a, c"NSScrollView", "setDrawsBackground:", (Bool) -> ());
    inst!(a, c"NSScrollView", "setHasVerticalScroller:", (Bool) -> ());
    inst!(a, c"NSScrollView", "setAutohidesScrollers:", (Bool) -> ());
    inst!(a, c"NSScrollView", "setBorderType:", (usize) -> ());
    inst!(a, c"NSScrollView", "setDocumentView:", (Object) -> ());
    inst!(a, c"NSWindow", "setContentView:", (Object) -> ());
    class!(a, c"NSScreen", "screens", () -> Got);
    inst!(a, c"NSScreen", "frame", () -> NSRect);
    inst!(a, c"NSWindow", "screen", () -> MaybeGot);
    inst!(a, c"NSScreen", "visibleFrame", () -> NSRect);
    inst!(a, c"NSView", "convertRect:toView:", (NSRect, *const AnyObject) -> NSRect);
    inst!(a, c"NSWindow", "convertRectToScreen:", (NSRect) -> NSRect);
    inst!(a, c"NSWindow", "setFrame:display:", (NSRect, Bool) -> ());
    inst!(a, c"NSView", "removeFromSuperview", () -> ());
    inst!(a, c"NSScrollView", "contentView", () -> Got);
    inst!(a, c"NSClipView", "scrollToPoint:", (NSPoint) -> ());
    inst!(a, c"NSScrollView", "reflectScrolledClipView:", (Object) -> ());
    inst!(a, c"NSWindow", "parentWindow", () -> MaybeGot);
    inst!(a, c"NSWindow", "removeChildWindow:", (Object) -> ());
    inst!(a, c"NSWindow", "addChildWindow:ordered:", (Object, isize) -> ());
    inst!(a, c"NSWindow", "orderFront:", (*const AnyObject) -> ());
    inst!(a, c"NSWindow", "invalidateShadow", () -> ());
    class!(a, c"NSOperationQueue", "mainQueue", () -> MaybeGot);
    inst!(a, c"NSWindow", "isVisible", () -> Bool);
    inst!(a, c"NSWindow", "orderOut:", (*const AnyObject) -> ());

    inst!(a, ?c"WKWebsiteDataStore", "set_delegate:", (Object) -> ());
    inst!(a, ?c"WKWebsiteDataStore", "_processPersistentNotificationClick:completionHandler:", (Object, &block2::DynBlock<dyn Fn(Bool)>) -> ());
    inst!(a, ?c"WKWebsiteDataStore", "_processPersistentNotificationClose:completionHandler:", (Object, &block2::DynBlock<dyn Fn(Bool)>) -> ());
    inst!(a, c"WKWebViewConfiguration", "processPool", () -> MaybeGot);
    inst!(a, c"WKSecurityOrigin", "protocol", () -> *mut NSString);
    inst!(a, c"WKSecurityOrigin", "host", () -> *mut NSString);
    inst!(a, c"WKSecurityOrigin", "port", () -> isize);
    inst!(a, c"NSObject", "valueForKey:", (&NSString) -> MaybeGot);
    class!(a, c"UNUserNotificationCenter", "currentNotificationCenter", () -> MaybeGot);
    inst!(a, c"UNUserNotificationCenter", "delegate", () -> MaybeGot);
    inst!(a, c"UNUserNotificationCenter", "setDelegate:", (Object) -> ());
    inst!(a, c"UNUserNotificationCenter", "setNotificationCategories:", (Object) -> ());
    inst!(a, c"UNUserNotificationCenter", "getNotificationCategoriesWithCompletionHandler:", (&block2::DynBlock<dyn Fn(*mut AnyObject)>) -> ());
    inst!(a, c"UNUserNotificationCenter", "requestAuthorizationWithOptions:completionHandler:", (usize, &block2::DynBlock<dyn Fn(Bool, *mut AnyObject)>) -> ());
    inst!(a, c"UNUserNotificationCenter", "addNotificationRequest:withCompletionHandler:", (Object, Option<&block2::DynBlock<dyn Fn(*mut AnyObject)>>) -> ());
    class!(a, c"UNNotificationCategory", "categoryWithIdentifier:actions:intentIdentifiers:options:", (&NSString, Object, Object, usize) -> MaybeGot);
    inst!(a, c"NSSet", "setByAddingObject:", (Object) -> MaybeGot);
    class!(a, c"NSSet", "setWithObject:", (Object) -> MaybeGot);
    class!(a, c"UNMutableNotificationContent", "new", () -> MaybeGot);
    inst!(a, c"UNMutableNotificationContent", "setTitle:", (&NSString) -> ());
    inst!(a, c"UNMutableNotificationContent", "setBody:", (&NSString) -> ());
    inst!(a, c"UNMutableNotificationContent", "setSubtitle:", (&NSString) -> ());
    class!(a, c"UNNotificationSound", "defaultSound", () -> MaybeGot);
    inst!(a, c"UNMutableNotificationContent", "setSound:", (Object) -> ());
    inst!(a, c"UNMutableNotificationContent", "setThreadIdentifier:", (&NSString) -> ());
    inst!(a, c"UNMutableNotificationContent", "setCategoryIdentifier:", (&NSString) -> ());
    inst!(a, c"UNMutableNotificationContent", "setUserInfo:", (Object) -> ());
    inst!(a, c"UNMutableNotificationContent", "setAttachments:", (Object) -> ());
    class!(a, c"NSURL", "fileURLWithPath:", (&NSString) -> MaybeGot);
    class!(a, c"UNNotificationAttachment", "attachmentWithIdentifier:URL:options:error:", (&NSString, Object, Maybe, &mut *mut AnyObject) -> MaybeGot);
    class!(a, c"UNNotificationRequest", "requestWithIdentifier:content:trigger:", (&NSString, Object, Maybe) -> MaybeGot);
    inst!(a, c"UNNotificationResponse", "notification", () -> MaybeGot);
    inst!(a, c"UNNotificationResponse", "actionIdentifier", () -> *mut NSString);
    inst!(a, c"UNNotification", "request", () -> MaybeGot);
    inst!(a, c"UNNotificationRequest", "content", () -> MaybeGot);
    inst!(a, c"UNNotificationContent", "userInfo", () -> MaybeGot);
    inst!(a, c"UNNotificationRequest", "identifier", () -> *mut NSString);
    class!(a, c"NSApplication", "sharedApplication", () -> MaybeGot);
    inst!(a, c"NSApplication", "activateIgnoringOtherApps:", (Bool) -> ());
    class!(a, ?c"WKWebsiteDataStore", "_sharedServiceWorkerNotificationManager", () -> *const Opaque);
    inst!(a, ?c"WKProcessPool", "_notificationManagerForTesting", () -> *const Opaque);
    let _: Option<(Block, Opaque, &NSEvent, NSString)> = None;
}

pub(crate) fn protocol_mismatches(class: &AnyClass, protocols: &[&CStr]) -> (usize, Vec<String>) {
    let mut checked = 0;
    let mut wrong = Vec::new();
    for method in class.instance_methods().iter() {
        let sel = method.name();
        let ours = unsafe { CStr::from_ptr(objc2::ffi::method_getTypeEncoding(*method)) };
        for protocol in protocols {
            let Some(proto) = AnyProtocol::get(protocol) else {
                continue;
            };
            for required in [true, false] {
                let description = unsafe {
                    objc2::ffi::protocol_getMethodDescription(
                        proto as *const AnyProtocol as *mut _,
                        sel,
                        Bool::new(required),
                        Bool::YES,
                    )
                };
                if description.types.is_null() {
                    continue;
                }
                checked += 1;
                let declared = unsafe { CStr::from_ptr(description.types) };
                if shape(&declared.to_string_lossy()) != shape(&ours.to_string_lossy()) {
                    wrong.push(format!(
                        "-[{} {sel}] vs {}: protocol {} ours {}",
                        class.name().to_string_lossy(),
                        protocol.to_string_lossy(),
                        declared.to_string_lossy(),
                        ours.to_string_lossy()
                    ));
                }
            }
        }
    }
    (checked, wrong)
}

pub(crate) fn assert_conforms(class: &AnyClass, protocols: &[&CStr]) {
    link_frameworks();
    let missing: Vec<String> = protocols
        .iter()
        .filter(|p| p.to_bytes().first() != Some(&b'_') && AnyProtocol::get(p).is_none())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    assert!(missing.is_empty(), "protocols not loaded: {missing:?}");
    let (checked, wrong) = protocol_mismatches(class, protocols);
    eprintln!(
        "{}: checked {checked} protocol signatures",
        class.name().to_string_lossy()
    );
    assert!(
        wrong.is_empty(),
        "wrong delegate types:\n{}",
        wrong.join("\n")
    );
}

pub(crate) fn assert_signatures(class: &AnyClass, expected: &[(&str, &str)]) {
    let mut wrong = Vec::new();
    for (selector, want) in expected {
        let Ok(text) = CString::new(*selector) else {
            wrong.push(format!("{selector}: bad selector"));
            continue;
        };
        let Some(method) = class.instance_method(Sel::register(&text)) else {
            wrong.push(format!("{selector}: not implemented"));
            continue;
        };
        let ours = unsafe { CStr::from_ptr(objc2::ffi::method_getTypeEncoding(method)) };
        if shape(&ours.to_string_lossy()) != shape(want) {
            wrong.push(format!(
                "-[{} {selector}]: header {want} ours {}",
                class.name().to_string_lossy(),
                ours.to_string_lossy()
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "wrong delegate types:\n{}",
        wrong.join("\n")
    );
}

pub fn shape(encoding: &str) -> String {
    let mut out = String::new();
    let mut chars = encoding.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() {
            continue;
        }
        if matches!(c, 'r' | 'n' | 'N' | 'o' | 'O' | 'R' | 'V') {
            continue;
        }
        if c == '"' {
            for d in chars.by_ref() {
                if d == '"' {
                    break;
                }
            }
            continue;
        }
        if c == '<' {
            let mut depth = 1;
            for d in chars.by_ref() {
                if d == '<' {
                    depth += 1;
                } else if d == '>' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out.replace("^{__SecTrust=}", "^v")
        .replace("^{__SecTrust}", "^v")
}

fn values_compile() {
    let _: Option<(Got, MaybeGot, NSError)> = None;
    let _ = <Bool as Encode>::ENCODING;
}

#[test]
fn every_native_message_matches_its_declared_types() {
    link_frameworks();
    values_compile();
    let mut audit = Audit::default();
    message_sends(&mut audit);
    eprintln!(
        "checked {} signatures; {} optional selectors absent on this macOS",
        audit.checked,
        audit.absent.len()
    );
    for absent in &audit.absent {
        eprintln!("absent: {absent}");
    }
    assert!(
        audit.wrong.is_empty(),
        "wrong native types:\n{}",
        audit.wrong.join("\n")
    );
}

#[test]
fn the_audit_catches_the_types_that_crashed_before() {
    link_frameworks();
    let mut audit = Audit::default();
    inst!(audit, c"NSData", "bytes", () -> *const u8);
    inst!(audit, c"WKWebView", "serverTrust", () -> *const c_void);
    inst!(audit, c"NSData", "length", () -> isize);
    inst!(audit, c"NSView", "bounds", () -> NSSize);
    assert_eq!(audit.checked, 4);
    assert_eq!(audit.wrong.len(), 3, "{:?}", audit.wrong);
    assert!(audit.wrong.iter().any(|w| w.contains("NSData bytes")));
    assert!(audit.wrong.iter().any(|w| w.contains("serverTrust")));
}

#[test]
fn shapes_ignore_offsets_and_qualifiers() {
    assert_eq!(shape("v32@0:8r^v16Q24"), "v@:^vQ");
    assert_eq!(shape("v40@0:8@\"WKWebView\"16@?<v@?q>24"), "v@:@@?");
}
