use std::time::Duration;

use ardia_state::TabId;
use serde_json::Value;

use super::WebKitEvent;
use crate::coordinator::AppCoordinator;

pub const WORLD_SCRIPT: &str = include_str!("../../assets/webkit/world.js");
pub const PAGE_MEDIA_SCRIPT: &str = include_str!("../../assets/webkit/page_media.js");
pub const LOGINS_SCRIPT: &str = include_str!("../../assets/webkit/logins.js");
pub const AUTOFILL_SCRIPT: &str = include_str!("../../assets/webkit/autofill.js");
pub const NOTIFY_WORLD_SCRIPT: &str = include_str!("../../assets/webkit/notify_world.js");
pub const NOTIFY_PAGE_SCRIPT: &str = include_str!("../../assets/webkit/notify_page.js");
pub const AUTOFILL_HANDLER: &str = "ardiaAutofill";
pub const MAX_MESSAGE: usize = 64 << 10;

pub const OWNED_KINDS: &[&str] = &[
    "nowPlaying",
    "media",
    "pip",
    "loginField",
    "loginSubmit",
    "notification",
    "field",
    "submit",
];

#[derive(Clone, Debug, PartialEq)]
pub struct PageMessage {
    pub kind: String,
    pub data: Value,
    pub frame: String,
    pub main_frame: bool,
    pub origin: Option<String>,
    pub autofill: bool,
}

pub fn parse_body(body: &Value) -> Option<(String, Value, String)> {
    let kind = body.get("kind")?.as_str()?.to_owned();
    let data = body.get("data").cloned().unwrap_or(Value::Null);
    let frame = body
        .get("frame")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Some((kind, data, frame))
}

pub fn origin_of(protocol: &str, host: &str, port: isize) -> Option<String> {
    let scheme = protocol.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") || host.is_empty() {
        return None;
    }
    let default = if scheme == "https" { 443 } else { 80 };
    let host = host.to_ascii_lowercase();
    Some(if port > 0 && port != default {
        format!("{scheme}://{host}:{port}")
    } else {
        format!("{scheme}://{host}")
    })
}

pub fn url_origin(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let port = parsed.port().map_or(0, |port| port as isize);
    origin_of(parsed.scheme(), parsed.host_str()?, port)
}

pub fn js_string(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

pub fn later(
    coordinator: &AppCoordinator,
    delay: Duration,
    job: impl FnOnce(&AppCoordinator) + Send + 'static,
) {
    let me = coordinator.weak();
    let spawned = std::thread::Builder::new()
        .name("ardia-webkit-services".into())
        .spawn(move || {
            std::thread::sleep(delay);
            if let Some(coordinator) = me.upgrade() {
                coordinator.post(job);
            }
        });
    if let Err(problem) = spawned {
        log::debug!("a WebKit timer didn't start: {problem}");
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::{
        WKContentWorld, WKFrameInfo, WKScriptMessage, WKScriptMessageHandler,
        WKUserContentController, WKUserScript, WKUserScriptInjectionTime, WKWebView,
    };

    use super::*;

    thread_local! {
        static FRAMES: RefCell<HashMap<(TabId, String), Retained<WKFrameInfo>>> = RefCell::new(HashMap::new());
        static HANDLER: RefCell<Option<Retained<AutofillHandler>>> = const { RefCell::new(None) };
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArdiaGpuiWebKitAutofillHandler"]
        pub struct AutofillHandler;

        unsafe impl NSObjectProtocol for AutofillHandler {}

        unsafe impl WKScriptMessageHandler for AutofillHandler {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            unsafe fn received(
                &self,
                _controller: &WKUserContentController,
                message: &WKScriptMessage,
            ) {
                forward(message, true);
            }
        }
    );

    fn handler(mtm: MainThreadMarker) -> Retained<AutofillHandler> {
        HANDLER.with(|slot| {
            slot.borrow_mut()
                .get_or_insert_with(|| unsafe { msg_send![AutofillHandler::alloc(mtm), init] })
                .clone()
        })
    }

    fn world(mtm: MainThreadMarker) -> Retained<WKContentWorld> {
        unsafe { WKContentWorld::worldWithName(&NSString::from_str("ardia"), mtm) }
    }

    fn add(
        controller: &WKUserContentController,
        source: &str,
        start: bool,
        main_only: bool,
        world: &WKContentWorld,
        mtm: MainThreadMarker,
    ) {
        unsafe {
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
                WKUserScript::alloc(mtm),
                &NSString::from_str(source),
                if start {
                    WKUserScriptInjectionTime::AtDocumentStart
                } else {
                    WKUserScriptInjectionTime::AtDocumentEnd
                },
                main_only,
                world,
            );
            controller.addUserScript(&script);
        }
    }

    pub fn install(controller: &WKUserContentController) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let ardia = world(mtm);
        let page = unsafe { WKContentWorld::pageWorld(mtm) };
        add(controller, WORLD_SCRIPT, true, false, &ardia, mtm);
        add(controller, PAGE_MEDIA_SCRIPT, true, false, &page, mtm);
        add(controller, LOGINS_SCRIPT, false, true, &ardia, mtm);
        add(controller, AUTOFILL_SCRIPT, false, false, &ardia, mtm);
        add(controller, NOTIFY_WORLD_SCRIPT, true, true, &ardia, mtm);
        add(controller, NOTIFY_PAGE_SCRIPT, true, true, &page, mtm);
        unsafe {
            controller.addScriptMessageHandler_contentWorld_name(
                ProtocolObject::from_ref(&*handler(mtm)),
                &ardia,
                &NSString::from_str(AUTOFILL_HANDLER),
            );
        }
    }

    fn json_of(body: &AnyObject) -> Option<Value> {
        if let Some(text) = body.downcast_ref::<NSString>() {
            let text = text.to_string();
            if text.len() > MAX_MESSAGE {
                return None;
            }
            return serde_json::from_str(&text).ok();
        }
        let serializer = objc2::runtime::AnyClass::get(c"NSJSONSerialization")?;
        unsafe {
            let valid: bool = msg_send![serializer, isValidJSONObject: body];
            if !valid {
                return None;
            }
            let data: Option<Retained<AnyObject>> = msg_send![
                serializer,
                dataWithJSONObject: body,
                options: 0usize,
                error: std::ptr::null_mut::<*mut NSError>()
            ];
            let data = data?;
            let length: usize = msg_send![&*data, length];
            if length > MAX_MESSAGE {
                return None;
            }
            let bytes: *const std::ffi::c_void = msg_send![&*data, bytes];
            if bytes.is_null() {
                return None;
            }
            serde_json::from_slice(std::slice::from_raw_parts(bytes.cast::<u8>(), length)).ok()
        }
    }

    fn frame_origin(frame: &WKFrameInfo) -> Option<String> {
        unsafe {
            let origin = frame.securityOrigin();
            super::origin_of(
                &origin.protocol().to_string(),
                &origin.host().to_string(),
                origin.port(),
            )
        }
    }

    fn forward(message: &WKScriptMessage, autofill: bool) -> bool {
        let Some(web) = (unsafe { message.webView() }) else {
            return false;
        };
        let body = unsafe { message.body() };
        let Some(value) = json_of(&body) else {
            return autofill;
        };
        let Some((kind, data, frame)) = parse_body(&value) else {
            return autofill;
        };
        if !autofill && !OWNED_KINDS.contains(&kind.as_str()) {
            return false;
        }
        let Some((tab, sink)) = crate::webkit::page::owner_of(&web) else {
            return true;
        };
        let info = unsafe { message.frameInfo() };
        let main_frame = unsafe { info.isMainFrame() };
        let key = if autofill {
            data.get("token")
                .and_then(Value::as_str)
                .map(|t| format!("autofill:{t}"))
                .unwrap_or_default()
        } else {
            frame.clone()
        };
        if !key.is_empty() {
            FRAMES.with(|frames| {
                let mut frames = frames.borrow_mut();
                if frames.len() > 512 {
                    frames.retain(|(owner, _), _| crate::webkit::page::has(owner));
                }
                frames.insert((tab.clone(), key), info.clone());
            });
        }
        sink(
            tab,
            WebKitEvent::Message(PageMessage {
                kind,
                data,
                frame,
                main_frame,
                origin: frame_origin(&info),
                autofill,
            }),
        );
        true
    }

    pub fn route(message: &WKScriptMessage) -> bool {
        forward(message, false)
    }

    pub fn forget_frames(tab: &TabId) {
        FRAMES.with(|frames| frames.borrow_mut().retain(|(owner, _), _| owner != tab));
    }

    pub fn run(
        tab: &TabId,
        frame: Option<&str>,
        code: &str,
        done: Option<Box<dyn FnOnce(Option<Value>)>>,
    ) {
        let Some(web) = crate::webkit::page::web_of(tab) else {
            if let Some(done) = done {
                done(None);
            }
            return;
        };
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let info = frame.and_then(|frame| {
            FRAMES.with(|frames| {
                frames
                    .borrow()
                    .get(&(tab.clone(), frame.to_owned()))
                    .cloned()
            })
        });
        let info = info.filter(|info| unsafe { !info.isMainFrame() });
        let slot = std::cell::Cell::new(done);
        let reply = RcBlock::new(move |value: *mut AnyObject, _error: *mut NSError| {
            let Some(done) = slot.take() else {
                return;
            };
            let value = unsafe { value.as_ref() }.and_then(|v| {
                if let Some(text) = v.downcast_ref::<NSString>() {
                    return Some(Value::String(text.to_string()));
                }
                let number: Option<f64> = v
                    .downcast_ref::<objc2_foundation::NSNumber>()
                    .map(|n| n.as_f64());
                number.map(Value::from)
            });
            done(value);
        });
        unsafe {
            web.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
                &NSString::from_str(code),
                info.as_deref(),
                &world(mtm),
                Some(&reply),
            );
        }
    }

    pub fn web_rect(
        tab: &TabId,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Option<(Retained<WKWebView>, objc2_foundation::NSRect)> {
        let web = crate::webkit::page::web_of(tab)?;
        let zoom: f64 = unsafe {
            let page: f64 = msg_send![&*web, pageZoom];
            let magnification: f64 = msg_send![&*web, magnification];
            page * magnification
        };
        let rect = objc2_foundation::NSRect::new(
            objc2_foundation::NSPoint::new(x * zoom, y * zoom),
            objc2_foundation::NSSize::new((width * zoom).max(1.0), (height * zoom).max(1.0)),
        );
        Some((web, rect))
    }

    pub fn page_secure(tab: &TabId) -> bool {
        crate::webkit::page::web_of(tab).is_some_and(|web| unsafe {
            let secure: bool = msg_send![&*web, hasOnlySecureContent];
            secure
        })
    }

    pub fn page_url(tab: &TabId) -> Option<String> {
        let web = crate::webkit::page::web_of(tab)?;
        let url = unsafe { web.URL() }?;
        url.absoluteString().map(|s| s.to_string())
    }

    pub fn page_loading(tab: &TabId) -> bool {
        crate::webkit::page::web_of(tab).is_some_and(|web| unsafe { web.isLoading() })
    }

    pub fn frame_is_secure(tab: &TabId, key: &str) -> bool {
        FRAMES.with(|frames| {
            frames
                .borrow()
                .get(&(tab.clone(), key.to_owned()))
                .is_some_and(|info| unsafe {
                    info.securityOrigin()
                        .protocol()
                        .to_string()
                        .eq_ignore_ascii_case("https")
                })
        })
    }
}

#[cfg(target_os = "macos")]
pub use mac::{
    forget_frames, frame_is_secure, install, page_loading, page_secure, page_url, route, run,
    web_rect,
};

#[cfg(not(target_os = "macos"))]
pub fn forget_frames(_: &TabId) {}

#[cfg(not(target_os = "macos"))]
pub fn run(_: &TabId, _: Option<&str>, _: &str, done: Option<Box<dyn FnOnce(Option<Value>)>>) {
    if let Some(done) = done {
        done(None);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn page_url(_: &TabId) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn page_loading(_: &TabId) -> bool {
    false
}

impl AppCoordinator {
    pub(crate) fn on_webkit_message(&self, tab: &TabId, message: PageMessage) {
        if message.autofill {
            self.webkit_autofill_message(tab, &message);
            return;
        }
        match message.kind.as_str() {
            "nowPlaying" | "media" | "pip" => self.webkit_media_message(tab, &message),
            "loginField" if message.main_frame => self.webkit_login_field(tab, &message),
            "loginSubmit" if message.main_frame => self.webkit_login_submitted(tab, &message),
            "notification" if message.main_frame => self.webkit_notification(tab, &message),
            _ => {}
        }
    }

    pub(crate) fn webkit_services_committed(&self, tab: &TabId) {
        self.webkit_media_committed(tab);
        self.webkit_share_notification_permission(tab);
        self.webkit_logins_committed(tab);
    }

    pub(crate) fn webkit_services_closed(&self, tab: &TabId) {
        forget_frames(tab);
        self.webkit_logins_closed(tab);
        self.webkit_media_closed(tab);
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn native_classes_match_their_protocols() {
        use objc2::ClassType as _;
        crate::webkit::native_audit::assert_conforms(
            super::mac::AutofillHandler::class(),
            &[c"WKScriptMessageHandler"],
        );
    }

    use super::*;

    #[test]
    fn origins_drop_default_ports() {
        assert_eq!(
            origin_of("HTTPS", "Example.com", 443).as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            origin_of("http", "a.b", 8080).as_deref(),
            Some("http://a.b:8080")
        );
        assert_eq!(origin_of("file", "", 0), None);
        assert_eq!(
            url_origin("https://x.com:443/a?b").as_deref(),
            Some("https://x.com")
        );
    }

    #[test]
    fn bodies_carry_kind_data_and_frame() {
        let body = serde_json::json!({ "kind": "nowPlaying", "data": { "a": 1 }, "frame": "f1" });
        let (kind, data, frame) = parse_body(&body).unwrap();
        assert_eq!(kind, "nowPlaying");
        assert_eq!(data["a"], 1);
        assert_eq!(frame, "f1");
        assert!(parse_body(&serde_json::json!({ "data": 1 })).is_none());
        assert_eq!(js_string("a\"b"), "\"a\\\"b\"");
    }

    #[test]
    fn scripts_are_bundled() {
        for script in [
            WORLD_SCRIPT,
            PAGE_MEDIA_SCRIPT,
            LOGINS_SCRIPT,
            AUTOFILL_SCRIPT,
            NOTIFY_WORLD_SCRIPT,
            NOTIFY_PAGE_SCRIPT,
        ] {
            assert!(script.trim_start().starts_with("(() =>"));
        }
        assert!(LOGINS_SCRIPT.contains("__ardiaLogins"));
        assert!(AUTOFILL_SCRIPT.contains(AUTOFILL_HANDLER));
    }
}
