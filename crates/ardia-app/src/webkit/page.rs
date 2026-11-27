use std::path::{Component, Path, PathBuf};

#[cfg(not(target_os = "macos"))]
use ardia_engine::NativeViewHandle;
use ardia_state::TabId;
use sha2::{Digest, Sha256};

use super::WebKitSink;

pub static FRAUD_WARNINGS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn set_fraud_warnings(on: bool) -> bool {
    let before = FRAUD_WARNINGS.swap(on, std::sync::atomic::Ordering::Relaxed);
    if before == on {
        return false;
    }
    #[cfg(target_os = "macos")]
    mac::apply_fraud_warnings(on);
    true
}

#[derive(Clone)]
pub struct PageSpec {
    pub tab: TabId,
    pub profile: String,
    pub private: bool,
    pub url: String,
    pub zoom: f64,
    pub muted: bool,
    pub inspectable: bool,
    pub sink: WebKitSink,
}

pub type Evaluated = Box<dyn FnOnce(Option<String>) + Send>;

pub const FALLBACK_SAFARI_VERSION: &str = "18.6";
pub const EVALUATE_TIMEOUT_MS: u32 = 3000;
pub const FIND_MAX_COUNT: usize = 10_000;

pub fn store_identifier(scope: &str, profile: &str) -> [u8; 16] {
    let digest = Sha256::digest(format!("ardia.webkit|{scope}|{profile}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0F) | 0x50;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    bytes
}

pub fn uuid_string(bytes: &[u8; 16]) -> String {
    let hex: String = bytes.iter().map(|b| format!("{b:02X}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

pub fn normalized_scope(dir: Option<&str>, cwd: &Path) -> String {
    let Some(dir) = dir.filter(|d| !d.is_empty()) else {
        return String::new();
    };
    let joined = if Path::new(dir).is_absolute() {
        PathBuf::from(dir)
    } else {
        cwd.join(dir)
    };
    let mut parts: Vec<String> = Vec::new();
    for component in joined.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::ParentDir => {
                parts.pop();
            }
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }
    format!("/{}", parts.join("/"))
}

pub fn private_base(profile: &str) -> &str {
    profile.split('@').next().unwrap_or(profile)
}

pub fn safari_version(short: Option<&str>) -> String {
    short
        .filter(|s| !s.is_empty())
        .map(|s| s.split('.').take(2).collect::<Vec<_>>().join("."))
        .unwrap_or_else(|| FALLBACK_SAFARI_VERSION.to_owned())
}

pub fn application_name(safari: &str) -> String {
    format!("Version/{safari} Safari/605.1.15")
}

pub fn hex_color(red: f64, green: f64, blue: f64) -> String {
    let channel = |c: f64| (c * 255.0).round().clamp(0.0, 255.0) as u8;
    format!(
        "#{:02X}{:02X}{:02X}",
        channel(red),
        channel(green),
        channel(blue)
    )
}

pub fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default()
}

pub fn evaluate_body(code: &str) -> String {
    format!(
        "return await new Promise((resolve) => {{ const post = (kind, json) => {{ if (kind === \"result\") resolve(json); }}; setTimeout(() => resolve(null), {EVALUATE_TIMEOUT_MS}); try {{\n{code}\n}} catch (e) {{ resolve(null); }} }});"
    )
}

pub fn is_web_scheme(scheme: &str) -> bool {
    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http"
            | "https"
            | "file"
            | "about"
            | "data"
            | "blob"
            | "javascript"
            | "webkit-pdfjs-viewer"
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    Foreground,
    Background,
    Popup,
}

pub fn disposition(command: bool, shift: bool, middle: bool, sized: bool) -> Disposition {
    if command || middle {
        if shift {
            Disposition::Foreground
        } else {
            Disposition::Background
        }
    } else if sized {
        Disposition::Popup
    } else {
        Disposition::Foreground
    }
}

pub fn popup_blocked(disposition: Disposition, user_initiated: bool) -> bool {
    !user_initiated && matches!(disposition, Disposition::Popup | Disposition::Foreground)
}

pub fn page_message(text: &str) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("kind")?.as_str()? != "icons" {
        return None;
    }
    let icons = value.get("data")?.get("icons")?.as_array()?;
    Some(
        icons
            .iter()
            .filter_map(|icon| icon.as_str())
            .filter(|icon| icon.starts_with("https://") || icon.starts_with("http://"))
            .take(16)
            .map(str::to_owned)
            .collect(),
    )
}

pub const PAGE_SCRIPT: &str = r#"(() => {
  const post = (kind, data) => { try { window.webkit.messageHandlers.ardia.postMessage(JSON.stringify({ kind, data })); } catch (e) {} };
  const icons = () => {
    const out = [];
    for (const link of document.querySelectorAll("link[rel]")) {
      const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
      if ((rel.includes("icon") || rel.includes("apple-touch-icon")) && link.href) out.push(link.href);
    }
    if (!out.length && /^https?:$/.test(location.protocol)) out.push(location.origin + "/favicon.ico");
    return out;
  };
  let last = null;
  let queued = false;
  const send = () => {
    queued = false;
    const list = icons();
    const key = list.join("\n");
    if (key === last) return;
    last = key;
    post("icons", { icons: list });
  };
  const soon = () => { if (!queued) { queued = true; setTimeout(send, 50); } };
  send();
  addEventListener("load", soon);
  try { new MutationObserver(soon).observe(document.head || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "rel"] }); } catch (e) {}
})();"#;

pub const HIDE_PASSKEYS: &str = r#"(() => {
  try { delete window.PublicKeyCredential; } catch (e) {}
  const container = window.CredentialsContainer && CredentialsContainer.prototype;
  if (!container) return;
  for (const name of ["create", "get"]) {
    const original = container[name];
    if (typeof original !== "function") continue;
    Object.defineProperty(container, name, {
      configurable: true, writable: true,
      value: {
        [name](options) {
          if (options && typeof options === "object" && "publicKey" in options) {
            return Promise.reject(new DOMException("Passkeys aren't available in this browser.", "NotSupportedError"));
          }
          return original.apply(this, arguments);
        },
      }[name],
    });
  }
})();"#;

pub fn count_script(query: &str) -> String {
    let quoted = serde_json::Value::String(query.to_owned()).to_string();
    format!(
        "(() => {{ const q = {quoted}.toLowerCase(); if (!q) return 0; const text = (document.body ? document.body.innerText : \"\").toLowerCase(); let n = 0; let at = text.indexOf(q); while (at >= 0 && n < {FIND_MAX_COUNT}) {{ n++; at = text.indexOf(q, at + q.length); }} return n; }})()"
    )
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::ptr::NonNull;

    use ardia_engine::NativeViewHandle;
    use ardia_state::TabId;
    use block2::RcBlock;
    use objc2::rc::{Retained, Weak};
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject, Sel};
    use objc2::{
        AllocAnyThread, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, define_class,
        msg_send, sel,
    };
    use objc2_app_kit::NSEventModifierFlags;
    use objc2_foundation::{
        NSDictionary, NSError, NSPoint, NSRect, NSSize, NSString, NSURL, NSURLRequest, NSUUID,
    };
    use objc2_web_kit::{
        WKAudiovisualMediaTypes, WKContentMode, WKContentWorld, WKFindConfiguration, WKFindResult,
        WKFrameInfo, WKNavigation, WKNavigationAction, WKNavigationActionPolicy,
        WKNavigationDelegate, WKNavigationType, WKPreferences, WKScriptMessage,
        WKScriptMessageHandler, WKUIDelegate, WKUserContentController, WKUserScript,
        WKUserScriptInjectionTime, WKWebView, WKWebViewConfiguration, WKWebpagePreferences,
        WKWebsiteDataStore, WKWindowFeatures,
    };

    use super::super::{WebKitEvent, WebKitNavigation, WebKitSink, next_zoom};
    use super::*;

    const WATCHED: [&str; 9] = [
        "hasOnlySecureContent",
        "serverTrust",
        "URL",
        "title",
        "canGoBack",
        "canGoForward",
        "loading",
        "themeColor",
        "estimatedProgress",
    ];
    const PLAYING_AUDIO: &str = "_isPlayingAudio";
    const FULLSCREEN_STATE: &str = "fullscreenState";

    #[derive(Default)]
    struct FindState {
        text: String,
        active: usize,
    }

    pub struct Ivars {
        tab: RefCell<Option<TabId>>,
        sink: RefCell<Option<WebKitSink>>,
        profile: RefCell<String>,
        web: RefCell<Option<Weak<WKWebView>>>,
        queued: Cell<bool>,
        watching: RefCell<Vec<&'static str>>,
        fullscreen: Cell<bool>,
        find: RefCell<FindState>,
        muted: Cell<bool>,
    }

    impl Ivars {
        fn new(profile: &str) -> Self {
            Self {
                tab: RefCell::new(None),
                sink: RefCell::new(None),
                profile: RefCell::new(profile.to_owned()),
                web: RefCell::new(None),
                queued: Cell::new(false),
                watching: RefCell::new(Vec::new()),
                fullscreen: Cell::new(false),
                find: RefCell::new(FindState::default()),
                muted: Cell::new(false),
            }
        }
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArdiaGpuiWebKitPage"]
        #[ivars = Ivars]
        pub struct PageDelegate;

        unsafe impl NSObjectProtocol for PageDelegate {}

        unsafe impl WKNavigationDelegate for PageDelegate {
            #[unsafe(method(webView:decidePolicyForNavigationAction:preferences:decisionHandler:))]
            unsafe fn decide(
                &self,
                web: &WKWebView,
                action: &WKNavigationAction,
                preferences: &WKWebpagePreferences,
                handler: &block2::DynBlock<
                    dyn Fn(WKNavigationActionPolicy, NonNull<WKWebpagePreferences>),
                >,
            ) {
                let policy = self.policy_for(web, action, preferences);
                if policy == WKNavigationActionPolicy::Allow
                    && let Some(url) = gated_main_frame_url(action)
                {
                    let current = unsafe { web.backForwardList().currentItem() }
                        .and_then(|item| unsafe { item.URL() }.absoluteString())
                        .map(|s| s.to_string());
                    let block = handler.copy();
                    let kept = preferences.retain();
                    let proceed: crate::webkit::site_gate::Proceed = Box::new(move || {
                        block.call((WKNavigationActionPolicy::Allow, NonNull::from(&*kept)));
                    });
                    let profile = self.ivars().profile.borrow().clone();
                    match crate::webkit::site_gate::hold(&profile, &url, current.as_deref(), proceed)
                    {
                        Ok(()) => {}
                        Err(proceed) => proceed(),
                    }
                    return;
                }
                handler.call((policy, NonNull::from(preferences)));
            }

            #[unsafe(method(webView:didStartProvisionalNavigation:))]
            unsafe fn started(&self, web: &WKWebView, _navigation: Option<&WKNavigation>) {
                provisional_started(self, web);
                self.queue_navigation();
            }

            #[unsafe(method(webView:didCommitNavigation:))]
            unsafe fn committed(&self, web: &WKWebView, _navigation: Option<&WKNavigation>) {
                self.on_commit(web);
            }

            #[unsafe(method(webView:didFinishNavigation:))]
            unsafe fn finished(&self, web: &WKWebView, _navigation: Option<&WKNavigation>) {
                if self.ivars().muted.get() {
                    apply_mute(web, true);
                }
                self.queue_navigation();
            }

            #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
            unsafe fn failed_early(
                &self,
                web: &WKWebView,
                _navigation: Option<&WKNavigation>,
                error: &NSError,
            ) {
                load_failed(self, web, error, false);
            }

            #[unsafe(method(webView:didFailNavigation:withError:))]
            unsafe fn failed(
                &self,
                web: &WKWebView,
                _navigation: Option<&WKNavigation>,
                error: &NSError,
            ) {
                load_failed(self, web, error, true);
            }

            #[unsafe(method(webViewWebContentProcessDidTerminate:))]
            unsafe fn terminated(&self, _web: &WKWebView) {
                self.emit(WebKitEvent::Crashed);
                self.queue_navigation();
            }
        }

        unsafe impl WKUIDelegate for PageDelegate {
            #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
            unsafe fn create_window(
                &self,
                web: &WKWebView,
                configuration: &WKWebViewConfiguration,
                action: &WKNavigationAction,
                features: &WKWindowFeatures,
            ) -> Option<Retained<WKWebView>> {
                self.open_window(web, configuration, action, features)
            }

            #[unsafe(method(webViewDidClose:))]
            unsafe fn did_close(&self, _web: &WKWebView) {
                self.emit(WebKitEvent::WindowClose);
            }

            #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
            unsafe fn alert(
                &self,
                _web: &WKWebView,
                message: &NSString,
                frame: &WKFrameInfo,
                handler: &block2::DynBlock<dyn Fn()>,
            ) {
                script_alert(self, &message.to_string(), frame, handler.copy());
            }

            #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
            unsafe fn confirm(
                &self,
                _web: &WKWebView,
                message: &NSString,
                frame: &WKFrameInfo,
                handler: &block2::DynBlock<dyn Fn(Bool)>,
            ) {
                script_confirm(self, &message.to_string(), frame, handler.copy());
            }

            #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
            unsafe fn prompt(
                &self,
                _web: &WKWebView,
                prompt: &NSString,
                default: Option<&NSString>,
                frame: &WKFrameInfo,
                handler: &block2::DynBlock<dyn Fn(*mut NSString)>,
            ) {
                script_prompt(self, &prompt.to_string(), default, frame, handler.copy());
            }
        }

        impl PageDelegate {
            #[unsafe(method(_webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:completionHandler:))]
            unsafe fn create_window_later(
                &self,
                web: &WKWebView,
                configuration: &WKWebViewConfiguration,
                action: &WKNavigationAction,
                features: &WKWindowFeatures,
                handler: &block2::DynBlock<dyn Fn(*mut WKWebView)>,
            ) {
                self.open_window_later(web, configuration, action, features, handler.copy());
            }

            #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
            fn observe(
                &self,
                key: Option<&NSString>,
                _object: Option<&AnyObject>,
                _change: Option<&AnyObject>,
                _context: *mut c_void,
            ) {
                let Some(key) = key.map(|k| k.to_string()) else {
                    return;
                };
                self.key_changed(&key);
            }

            #[unsafe(method(ardiaFlushNavigation))]
            fn flush(&self) {
                self.ivars().queued.set(false);
                if let Some(web) = self.web() {
                    let mut nav = snapshot(&web);
                    adjust_snapshot(self, &mut nav);
                    self.emit(WebKitEvent::Navigation(nav));
                }
            }

            #[unsafe(method(ardiaShowNextDialog))]
            fn show_next_dialog_now(&self) {
                show_next_dialog(self);
            }

            #[unsafe(method(ardiaSaveHistory))]
            fn save_history(&self) {
                save_history_now(self);
            }

            #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
            fn decide_response(
                &self,
                _web: &WKWebView,
                response: &AnyObject,
                handler: &block2::DynBlock<dyn Fn(isize)>,
            ) {
                let main: bool = unsafe { msg_send![response, isForMainFrame] };
                let can_show: bool = unsafe { msg_send![response, canShowMIMEType] };
                let inner: Retained<AnyObject> = unsafe { msg_send![response, response] };
                note_response(self, &inner, main);
                handler.call((response_policy(&inner, main, can_show),));
            }

            #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
            fn action_download(&self, web: &WKWebView, _action: &AnyObject, download: &AnyObject) {
                adopt_download(self, web, download);
            }

            #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
            fn response_download(&self, web: &WKWebView, _response: &AnyObject, download: &AnyObject) {
                adopt_download(self, web, download);
            }

            #[unsafe(method(webView:didReceiveAuthenticationChallenge:completionHandler:))]
            fn challenge(
                &self,
                _web: &WKWebView,
                challenge: &AnyObject,
                handler: &block2::DynBlock<dyn Fn(isize, *mut AnyObject)>,
            ) {
                answer_challenge(self, challenge, handler.copy());
            }

            #[unsafe(method(_webView:didFindMatches:forString:withMatchIndex:))]
            fn did_find(&self, web: &AnyObject, matches: usize, string: &NSString, index: isize) {
                if !self.same_find(web, string) {
                    return;
                }
                let found = matches.min(FIND_MAX_COUNT);
                let ordinal = usize::try_from(index)
                    .ok()
                    .filter(|i| *i < found)
                    .map(|i| i + 1);
                let count = found.max(1);
                let active = {
                    let mut find = self.ivars().find.borrow_mut();
                    find.active = ordinal.unwrap_or(find.active).clamp(1, count);
                    find.active
                };
                self.emit(WebKitEvent::FindMatches(Some(count as u32), active as u32));
            }

            #[unsafe(method(_webView:didCountMatches:forString:))]
            fn did_count(&self, web: &AnyObject, matches: usize, string: &NSString) {
                if matches == 0 || !self.same_find(web, string) {
                    return;
                }
                let active = self.ivars().find.borrow().active as u32;
                self.emit(WebKitEvent::FindMatches(
                    Some(matches.min(FIND_MAX_COUNT) as u32),
                    active,
                ));
            }

            #[unsafe(method(_webView:didFailToFindString:))]
            fn did_fail_find(&self, web: &AnyObject, string: &NSString) {
                if !self.same_find(web, string) {
                    return;
                }
                self.ivars().find.borrow_mut().active = 0;
                self.emit(WebKitEvent::FindMatches(Some(0), 0));
            }
        }
    );

    impl PageDelegate {
        fn make(mtm: MainThreadMarker, profile: &str) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars::new(profile));
            unsafe { msg_send![super(this), init] }
        }

        fn web(&self) -> Option<Retained<WKWebView>> {
            self.ivars().web.borrow().as_ref().and_then(Weak::load)
        }

        fn emit(&self, event: WebKitEvent) {
            let tab = self.ivars().tab.borrow().clone();
            let sink = self.ivars().sink.borrow().clone();
            if let (Some(tab), Some(sink)) = (tab, sink) {
                sink(tab, event);
            }
        }

        fn queue_navigation(&self) {
            if self.ivars().queued.replace(true) {
                return;
            }
            unsafe {
                let _: () = msg_send![
                    self,
                    performSelectorOnMainThread: sel!(ardiaFlushNavigation),
                    withObject: None::<&AnyObject>,
                    waitUntilDone: false
                ];
            }
        }

        fn key_changed(&self, key: &str) {
            match key {
                "estimatedProgress" => {
                    if let Some(web) = self.web() {
                        self.emit(WebKitEvent::Progress(unsafe { web.estimatedProgress() }));
                    }
                }
                PLAYING_AUDIO => {
                    if let Some(web) = self.web() {
                        let audible: bool = unsafe { msg_send![&*web, _isPlayingAudio] };
                        self.emit(WebKitEvent::Media { audible });
                    }
                }
                FULLSCREEN_STATE => {
                    if let Some(web) = self.web() {
                        let state: isize = unsafe { msg_send![&*web, fullscreenState] };
                        let on = matches!(state, 1 | 2);
                        if self.ivars().fullscreen.replace(on) != on {
                            if on {
                                crate::webkit::telemetry::note_webkit_count("fullscreen");
                            }
                            self.emit(WebKitEvent::Fullscreen(on));
                        }
                    }
                }
                "hasOnlySecureContent" | "serverTrust" => emit_security(self),
                _ => self.queue_navigation(),
            }
        }

        fn watch(&self, web: &WKWebView) {
            let mut keys: Vec<&'static str> = WATCHED.to_vec();
            if responds(web, sel!(_isPlayingAudio)) {
                keys.push(PLAYING_AUDIO);
            }
            if responds(web, sel!(fullscreenState)) {
                keys.push(FULLSCREEN_STATE);
            }
            for key in &keys {
                unsafe {
                    let _: () = msg_send![
                        web,
                        addObserver: self,
                        forKeyPath: &*NSString::from_str(key),
                        options: 1usize,
                        context: std::ptr::null_mut::<c_void>()
                    ];
                }
            }
            *self.ivars().watching.borrow_mut() = keys;
        }

        fn unwatch(&self, web: &WKWebView) {
            for key in self.ivars().watching.take() {
                unsafe {
                    let _: () = msg_send![
                        web,
                        removeObserver: self,
                        forKeyPath: &*NSString::from_str(key)
                    ];
                }
            }
        }

        fn same_find(&self, web: &AnyObject, string: &NSString) -> bool {
            let mine = self
                .web()
                .is_some_and(|w| std::ptr::eq(Retained::as_ptr(&w).cast::<AnyObject>(), web));
            mine && self.ivars().find.borrow().text == string.to_string()
        }

        fn on_commit(&self, web: &WKWebView) {
            let url = current_url(web);
            let host = host_of(&url);
            if !host.is_empty() {
                let profile = self.ivars().profile.borrow().clone();
                let zoom = stored_zoom(&profile, &host);
                if (unsafe { web.pageZoom() } - zoom).abs() > 0.001 {
                    unsafe { web.setPageZoom(zoom) };
                }
            }
            self.ivars().find.borrow_mut().active = 0;
            committed(self, web);
            self.emit(WebKitEvent::Committed);
            self.emit(WebKitEvent::Zoom(unsafe { web.pageZoom() }));
            self.queue_navigation();
        }

        fn policy_for(
            &self,
            _web: &WKWebView,
            action: &WKNavigationAction,
            preferences: &WKWebpagePreferences,
        ) -> WKNavigationActionPolicy {
            let request = unsafe { action.request() };
            let Some(url) = request.URL() else {
                return WKNavigationActionPolicy::Allow;
            };
            let text = url
                .absoluteString()
                .map(|s| s.to_string())
                .unwrap_or_default();
            let scheme = url.scheme().map(|s| s.to_string()).unwrap_or_default();
            if page_action(self, _web, action, &text) {
                return WKNavigationActionPolicy::Cancel;
            }
            let target = unsafe { action.targetFrame() };
            let main = target.as_ref().is_some_and(|f| unsafe { f.isMainFrame() });
            if !is_web_scheme(&scheme) {
                let source = unsafe { action.sourceFrame() };
                let from_main = source.as_ref().is_some_and(|f| unsafe { f.isMainFrame() }) || main;
                if unsafe { action.navigationType() } == WKNavigationType::LinkActivated
                    || from_main
                {
                    let origin = source.as_deref().and_then(origin_of_frame);
                    external_request(self, &url, &text, origin);
                }
                return WKNavigationActionPolicy::Cancel;
            }
            apply_https_policy(action, preferences, main);
            let download: bool = unsafe { msg_send![action, shouldPerformDownload] };
            if download {
                return WKNavigationActionPolicy::Download;
            }
            if unsafe { action.navigationType() } == WKNavigationType::LinkActivated
                && target.is_some()
                && matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
            {
                let flags = unsafe { action.modifierFlags() };
                let middle = unsafe { action.buttonNumber() } == 2;
                if flags.contains(NSEventModifierFlags::Command) || middle {
                    self.emit(WebKitEvent::OpenUrl {
                        url: text,
                        background: !flags.contains(NSEventModifierFlags::Shift),
                    });
                    return WKNavigationActionPolicy::Cancel;
                }
            }
            if main {
                crate::webkit::content_rules::configure(preferences, &text);
                crate::webkit::site_settings::configure(
                    _web,
                    preferences,
                    &self.ivars().profile.borrow(),
                    &text,
                );
            }
            WKNavigationActionPolicy::Allow
        }

        fn open_window(
            &self,
            _web: &WKWebView,
            configuration: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            let flags = unsafe { action.modifierFlags() };
            let sized = unsafe { features.width().is_some() || features.height().is_some() };
            let chosen = disposition(
                flags.contains(NSEventModifierFlags::Command),
                flags.contains(NSEventModifierFlags::Shift),
                unsafe { action.buttonNumber() } == 2,
                sized,
            );
            let url = unsafe { action.request() }
                .URL()
                .and_then(|u| u.absoluteString())
                .map(|s| s.to_string())
                .unwrap_or_default();
            if popup_blocked(chosen, user_initiated(action)) && !popups_allowed(self, _web) {
                block_popup(self, _web, url, chosen == Disposition::Background);
                return None;
            }
            self.spawn_popup(configuration, url, chosen)
        }

        fn spawn_popup(
            &self,
            configuration: &WKWebViewConfiguration,
            url: String,
            chosen: Disposition,
        ) -> Option<Retained<WKWebView>> {
            let mtm = MainThreadMarker::new()?;
            let profile = self.ivars().profile.borrow().clone();
            let (held, web) = hold_popup(mtm, configuration, &profile)?;
            self.emit(WebKitEvent::OpenPopup {
                held,
                url,
                background: chosen == Disposition::Background,
            });
            Some(web)
        }

        fn open_window_later(
            &self,
            web: &WKWebView,
            configuration: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            features: &WKWindowFeatures,
            handler: RcBlock<dyn Fn(*mut WKWebView)>,
        ) {
            let answer = |made: Option<Retained<WKWebView>>| {
                let pointer = made
                    .as_ref()
                    .map_or(std::ptr::null_mut(), |web| Retained::as_ptr(web).cast_mut());
                handler.call((pointer,));
            };
            let flags = unsafe { action.modifierFlags() };
            let sized = unsafe { features.width().is_some() || features.height().is_some() };
            let chosen = disposition(
                flags.contains(NSEventModifierFlags::Command),
                flags.contains(NSEventModifierFlags::Shift),
                unsafe { action.buttonNumber() } == 2,
                sized,
            );
            let url = unsafe { action.request() }
                .URL()
                .and_then(|u| u.absoluteString())
                .map(|s| s.to_string())
                .unwrap_or_default();
            if !popup_blocked(chosen, user_initiated(action)) {
                return answer(self.spawn_popup(configuration, url, chosen));
            }
            let Some(origin) = popup_origin(web) else {
                block_popup(self, web, url, chosen == Disposition::Background);
                return answer(None);
            };
            let Some(coordinator) = crate::webkit::notifications::coordinator() else {
                if popups_allowed(self, web) {
                    return answer(self.spawn_popup(configuration, url, chosen));
                }
                block_popup(self, web, url, chosen == Disposition::Background);
                return answer(None);
            };
            let profile = self.ivars().profile.borrow().clone();
            let id = NEXT_HELD.with(|next| {
                next.set(next.get() + 1);
                next.get()
            });
            DECIDING.with(|deciding| {
                deciding.borrow_mut().insert(
                    id,
                    PopupDecision {
                        delegate: self.retain(),
                        web: web.retain(),
                        configuration: configuration.retain(),
                        url,
                        chosen,
                        handler: handler.clone(),
                    },
                )
            });
            coordinator.post(move |c| {
                let (asked_profile, asked_origin) = (profile.clone(), origin.clone());
                c.load_webkit_answers(&asked_profile, &asked_origin, move |_| {
                    finish_popup_decision(id, &profile, &origin)
                });
            });
        }
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArdiaGpuiWebKitBridge"]
        pub struct Bridge;

        unsafe impl NSObjectProtocol for Bridge {}

        unsafe impl WKScriptMessageHandler for Bridge {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            unsafe fn received(
                &self,
                _controller: &WKUserContentController,
                message: &WKScriptMessage,
            ) {
                route_message(message);
            }
        }
    );

    impl Bridge {
        fn create(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    struct Page {
        web: Retained<WKWebView>,
        delegate: Retained<PageDelegate>,
    }

    struct PopupDecision {
        delegate: Retained<PageDelegate>,
        web: Retained<WKWebView>,
        configuration: Retained<WKWebViewConfiguration>,
        url: String,
        chosen: Disposition,
        handler: RcBlock<dyn Fn(*mut WKWebView)>,
    }

    fn finish_popup_decision(id: u64, profile: &str, origin: &str) {
        let Some(decision) = DECIDING.with(|deciding| deciding.borrow_mut().remove(&id)) else {
            return;
        };
        let live = PAGES.with(|pages| {
            pages.borrow().values().any(|page| {
                Retained::as_ptr(&page.web) == Retained::as_ptr(&decision.web)
                    && Retained::as_ptr(&page.delegate) == Retained::as_ptr(&decision.delegate)
            })
        });
        let made = if !live {
            None
        } else if crate::webkit::site_answers::answer(
            profile,
            origin,
            crate::webkit::site_answers::POPUPS,
        ) == Some(true)
        {
            decision
                .delegate
                .spawn_popup(&decision.configuration, decision.url, decision.chosen)
        } else {
            block_popup(
                &decision.delegate,
                &decision.web,
                decision.url,
                decision.chosen == Disposition::Background,
            );
            None
        };
        let pointer = made
            .as_ref()
            .map_or(std::ptr::null_mut(), |web| Retained::as_ptr(web).cast_mut());
        decision.handler.call((pointer,));
    }

    thread_local! {
        static DECIDING: RefCell<HashMap<u64, PopupDecision>> = RefCell::new(HashMap::new());
        static PAGES: RefCell<HashMap<TabId, Page>> = RefCell::new(HashMap::new());
        static HELD: RefCell<HashMap<String, Page>> = RefCell::new(HashMap::new());
        static RETIRING: RefCell<HashMap<TabId, Page>> = RefCell::new(HashMap::new());
        static NEXT_HELD: Cell<u64> = const { Cell::new(0) };
        static STORES: RefCell<HashMap<String, Retained<WKWebsiteDataStore>>> = RefCell::new(HashMap::new());
        static PRIVATE: RefCell<HashMap<String, Retained<WKWebsiteDataStore>>> = RefCell::new(HashMap::new());
        static ZOOMS: RefCell<HashMap<(String, String), f64>> = RefCell::new(HashMap::new());
        static BRIDGE: RefCell<Option<Retained<Bridge>>> = const { RefCell::new(None) };
        static SAFARI: RefCell<Option<String>> = const { RefCell::new(None) };
    }

    fn responds(web: &WKWebView, selector: Sel) -> bool {
        unsafe { msg_send![web, respondsToSelector: selector] }
    }

    fn background() -> bool {
        std::env::var("ARDIA_BACKGROUND").is_ok_and(|v| !v.is_empty() && v != "0")
    }

    fn user_initiated(action: &WKNavigationAction) -> bool {
        let spi: bool = unsafe { msg_send![action, respondsToSelector: sel!(_isUserInitiated)] };
        if spi {
            unsafe { msg_send![action, _isUserInitiated] }
        } else {
            (unsafe { action.navigationType() }) == WKNavigationType::LinkActivated
        }
    }

    fn stored_zoom(profile: &str, host: &str) -> f64 {
        ZOOMS.with(|z| {
            z.borrow()
                .get(&(profile.to_owned(), host.to_owned()))
                .copied()
                .unwrap_or(1.0)
        })
    }

    fn store_zoom(profile: &str, host: &str, zoom: f64) {
        if host.is_empty() {
            return;
        }
        ZOOMS.with(|z| {
            let mut z = z.borrow_mut();
            let key = (profile.to_owned(), host.to_owned());
            if (zoom - 1.0).abs() < 0.001 {
                z.remove(&key);
            } else {
                z.insert(key, zoom);
            }
        });
    }

    fn scope() -> String {
        let cwd = std::env::current_dir().unwrap_or_default();
        let plain = normalized_scope(std::env::var("ARDIA_DATA_DIR").ok().as_deref(), &cwd);
        if plain.is_empty() {
            return plain;
        }
        let standardized: Retained<NSString> =
            unsafe { msg_send![&*NSString::from_str(&plain), stringByStandardizingPath] };
        standardized.to_string()
    }

    fn data_store(
        mtm: MainThreadMarker,
        profile: &str,
        private: bool,
    ) -> Retained<WKWebsiteDataStore> {
        if private {
            let base = private_base(profile).to_owned();
            return PRIVATE.with(|p| {
                p.borrow_mut()
                    .entry(base)
                    .or_insert_with(|| unsafe { WKWebsiteDataStore::nonPersistentDataStore(mtm) })
                    .clone()
            });
        }
        STORES.with(|s| {
            s.borrow_mut()
                .entry(profile.to_owned())
                .or_insert_with(|| {
                    let text = uuid_string(&store_identifier(&scope(), profile));
                    let store = match NSUUID::initWithUUIDString(
                        NSUUID::alloc(),
                        &NSString::from_str(&text),
                    ) {
                        Some(uuid) => unsafe {
                            WKWebsiteDataStore::dataStoreForIdentifier(&uuid, mtm)
                        },
                        None => unsafe { WKWebsiteDataStore::nonPersistentDataStore(mtm) },
                    };
                    crate::webkit::notification_workers::attach_workers(&store, profile);
                    store
                })
                .clone()
        })
    }

    fn safari() -> String {
        SAFARI.with(|cell| {
            cell.borrow_mut()
                .get_or_insert_with(|| {
                    let paths = [
                        "/Applications/Safari.app",
                        "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app",
                    ];
                    let found = paths.iter().find_map(|path| unsafe {
                        let bundle: Option<Retained<AnyObject>> = msg_send![
                            objc2::class!(NSBundle),
                            bundleWithPath: &*NSString::from_str(path)
                        ];
                        let bundle = bundle?;
                        let info: Option<Retained<AnyObject>> = msg_send![&*bundle, infoDictionary];
                        let info = info?;
                        let value: Option<Retained<NSString>> = msg_send![
                            &*info,
                            objectForKey: &*NSString::from_str("CFBundleShortVersionString")
                        ];
                        value.map(|v| v.to_string())
                    });
                    safari_version(found.as_deref())
                })
                .clone()
        })
    }

    fn base_preferences(preferences: &WKPreferences) {
        unsafe {
            preferences.setElementFullscreenEnabled(!background());
            preferences.setJavaScriptCanOpenWindowsAutomatically(true);
            preferences.setFraudulentWebsiteWarningEnabled(
                FRAUD_WARNINGS.load(std::sync::atomic::Ordering::Relaxed),
            );
            let pip: bool = msg_send![preferences, respondsToSelector: sel!(_setAllowsPictureInPictureMediaPlayback:)];
            if pip {
                let _: () = msg_send![preferences, _setAllowsPictureInPictureMediaPlayback: true];
            }
        }
    }

    fn bridge(mtm: MainThreadMarker) -> Retained<Bridge> {
        BRIDGE.with(|b| {
            b.borrow_mut()
                .get_or_insert_with(|| Bridge::create(mtm))
                .clone()
        })
    }

    fn configuration(
        mtm: MainThreadMarker,
        profile: &str,
        private: bool,
    ) -> Retained<WKWebViewConfiguration> {
        unsafe {
            let config = WKWebViewConfiguration::new(mtm);
            config.setWebsiteDataStore(&data_store(mtm, profile, private));
            let controller = WKUserContentController::new(mtm);
            let world = WKContentWorld::worldWithName(&NSString::from_str("ardia"), mtm);
            let page = WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
                WKUserScript::alloc(mtm),
                &NSString::from_str(PAGE_SCRIPT),
                WKUserScriptInjectionTime::AtDocumentEnd,
                true,
                &world,
            );
            controller.addUserScript(&page);
            let passkeys =
                WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
                    WKUserScript::alloc(mtm),
                    &NSString::from_str(HIDE_PASSKEYS),
                    WKUserScriptInjectionTime::AtDocumentStart,
                    false,
                    &WKContentWorld::pageWorld(mtm),
                );
            if !crate::webkit::passkeys::entitled() {
                controller.addUserScript(&passkeys);
            }
            controller.addScriptMessageHandler_contentWorld_name(
                ProtocolObject::from_ref(&*bridge(mtm)),
                &world,
                &NSString::from_str("ardia"),
            );
            crate::webkit::content_rules::attach(&controller);
            crate::webkit::services::install(&controller);
            config.setUserContentController(&controller);
            config.setApplicationNameForUserAgent(Some(&NSString::from_str(&application_name(
                &safari(),
            ))));
            config.setMediaTypesRequiringUserActionForPlayback(WKAudiovisualMediaTypes::None);
            config.setAllowsAirPlayForMediaPlayback(true);
            base_preferences(&config.preferences());
            config.setUpgradeKnownHostsToHTTPS(true);
            config
                .defaultWebpagePreferences()
                .setPreferredContentMode(WKContentMode::Desktop);
            config
        }
    }

    fn prepare(web: &WKWebView, delegate: &PageDelegate, inspectable: bool) {
        unsafe {
            web.setNavigationDelegate(Some(ProtocolObject::from_ref(delegate)));
            web.setUIDelegate(Some(ProtocolObject::from_ref(delegate)));
            web.setAllowsBackForwardNavigationGestures(true);
            web.setAllowsMagnification(true);
            web.setInspectable(inspectable);
            if background() {
                if responds(web, sel!(_setWindowOcclusionDetectionEnabled:)) {
                    let _: () = msg_send![web, _setWindowOcclusionDetectionEnabled: false];
                }
                apply_mute(web, true);
            }
        }
        delegate.watch(web);
    }

    fn apply_mute(web: &WKWebView, on: bool) {
        if !responds(web, sel!(_setPageMuted:)) || !responds(web, sel!(_mediaMutedState)) {
            return;
        }
        let silenced = on || background();
        unsafe {
            let current: usize = msg_send![web, _mediaMutedState];
            let next = if silenced { current | 1 } else { current & !1 };
            if next != current {
                let _: () = msg_send![web, _setPageMuted: next];
            }
        }
    }

    fn make_view(
        mtm: MainThreadMarker,
        configuration: &WKWebViewConfiguration,
    ) -> Retained<WKWebView> {
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(800.0, 600.0));
        unsafe {
            WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, configuration)
        }
    }

    fn hold_popup(
        mtm: MainThreadMarker,
        configuration: &WKWebViewConfiguration,
        profile: &str,
    ) -> Option<(String, Retained<WKWebView>)> {
        unsafe {
            let preferences = WKPreferences::new(mtm);
            base_preferences(&preferences);
            configuration.setPreferences(&preferences);
        }
        let web = make_view(mtm, configuration);
        let delegate = PageDelegate::make(mtm, profile);
        *delegate.ivars().web.borrow_mut() = Some(Weak::from_retained(&web));
        prepare(&web, &delegate, true);
        let id = NEXT_HELD.with(|n| {
            let next = n.get() + 1;
            n.set(next);
            format!("webkit:{next}")
        });
        HELD.with(|h| {
            h.borrow_mut().insert(
                id.clone(),
                Page {
                    web: web.clone(),
                    delegate,
                },
            )
        });
        Some((id, web))
    }

    fn current_url(web: &WKWebView) -> String {
        unsafe {
            web.URL()
                .or_else(|| web.backForwardList().currentItem().map(|item| item.URL()))
                .and_then(|u| u.absoluteString())
                .map(|s| s.to_string())
                .unwrap_or_default()
        }
    }

    fn theme_hex(web: &WKWebView) -> Option<String> {
        unsafe {
            let color: Option<Retained<AnyObject>> = msg_send![web, themeColor];
            let color = color?;
            let space: Retained<AnyObject> = msg_send![objc2::class!(NSColorSpace), sRGBColorSpace];
            let rgb: Option<Retained<AnyObject>> =
                msg_send![&*color, colorUsingColorSpace: &*space];
            let rgb = rgb?;
            let r: f64 = msg_send![&*rgb, redComponent];
            let g: f64 = msg_send![&*rgb, greenComponent];
            let b: f64 = msg_send![&*rgb, blueComponent];
            Some(hex_color(r, g, b))
        }
    }

    fn snapshot(web: &WKWebView) -> WebKitNavigation {
        unsafe {
            WebKitNavigation {
                url: current_url(web),
                committed_url: web
                    .backForwardList()
                    .currentItem()
                    .and_then(|item| item.URL().absoluteString())
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
                title: web.title().map(|t| t.to_string()).unwrap_or_default(),
                can_go_back: web.canGoBack(),
                can_go_forward: web.canGoForward(),
                loading: web.isLoading(),
                theme_color: theme_hex(web),
            }
        }
    }

    fn route_message(message: &WKScriptMessage) {
        if crate::webkit::services::route(message) {
            return;
        }
        let Some(web) = (unsafe { message.webView() }) else {
            return;
        };
        let frame = unsafe { message.frameInfo() };
        if !unsafe { frame.isMainFrame() } {
            return;
        }
        let body = unsafe { message.body() };
        let Some(text) = body.downcast_ref::<NSString>().map(|s| s.to_string()) else {
            return;
        };
        if text.len() > 64 << 10 {
            return;
        }
        let Some(icons) = page_message(&text) else {
            return;
        };
        let pointer = Retained::as_ptr(&web);
        let delegate = PAGES.with(|pages| {
            pages
                .borrow()
                .values()
                .find(|p| std::ptr::eq(Retained::as_ptr(&p.web), pointer))
                .map(|p| p.delegate.clone())
        });
        if let Some(delegate) = delegate {
            delegate.emit(WebKitEvent::Icons(icons));
        }
    }

    fn with_page<R>(tab: &TabId, run: impl FnOnce(&Page) -> R) -> Option<R> {
        PAGES.with(|pages| pages.borrow().get(tab).map(run))
    }

    pub fn owner_of(web: &WKWebView) -> Option<(TabId, crate::webkit::WebKitSink)> {
        let pointer = web as *const WKWebView;
        PAGES
            .with(|pages| {
                pages.borrow().iter().find_map(|(tab, page)| {
                    std::ptr::eq(Retained::as_ptr(&page.web), pointer).then(|| {
                        let sink = page.delegate.ivars().sink.borrow().clone();
                        sink.map(|sink| (tab.clone(), sink))
                    })
                })
            })
            .flatten()
    }

    pub fn web_of(tab: &TabId) -> Option<Retained<WKWebView>> {
        with_page(tab, |page| page.web.clone())
    }

    pub fn profile_of(tab: &TabId) -> Option<String> {
        with_page(tab, |page| page.delegate.ivars().profile.borrow().clone())
    }

    pub fn live_tab_for(
        profile: &str,
        origin: Option<&str>,
    ) -> Option<(TabId, crate::webkit::WebKitSink)> {
        PAGES.with(|pages| {
            let pages = pages.borrow();
            let mut matching: Vec<(&TabId, &Page)> = pages
                .iter()
                .filter(|(_, page)| *page.delegate.ivars().profile.borrow() == profile)
                .filter(|(_, page)| {
                    origin.is_none_or(|origin| {
                        crate::webkit::site_settings::origin_of(&current_url(&page.web)).as_deref()
                            == Some(origin)
                    })
                })
                .collect();
            matching.sort_by_key(|(_, page)| page.web.isHidden());
            matching.into_iter().find_map(|(tab, page)| {
                let sink = page.delegate.ivars().sink.borrow().clone()?;
                Some((tab.clone(), sink))
            })
        })
    }

    pub fn any_web() -> Option<Retained<WKWebView>> {
        PAGES.with(|pages| pages.borrow().values().next().map(|page| page.web.clone()))
    }

    pub fn hold_worker_window(profile: &str, url: &str) -> Option<(String, Retained<WKWebView>)> {
        let mtm = MainThreadMarker::new()?;
        let configuration = configuration(mtm, profile, false);
        let (held, web) = hold_popup(mtm, &configuration, profile)?;
        start_loading(&web, url);
        Some((held, web))
    }

    fn gated_main_frame_url(action: &WKNavigationAction) -> Option<String> {
        let main = unsafe { action.targetFrame() }.is_some_and(|f| unsafe { f.isMainFrame() });
        if !main {
            return None;
        }
        let url = unsafe { action.request() }
            .URL()
            .and_then(|u| u.absoluteString())
            .map(|s| s.to_string())?;
        crate::webkit::site_gate::gated_host(&url).map(|_| url)
    }

    fn handle_of(web: &WKWebView) -> NativeViewHandle {
        NativeViewHandle((web as *const WKWebView).cast_mut().cast::<c_void>())
    }

    fn start_loading(web: &WKWebView, url: &str) {
        if url.is_empty() {
            return;
        }
        let Some(target) = NSURL::URLWithString(&NSString::from_str(url)) else {
            return;
        };
        unsafe {
            if target.isFileURL() {
                let folder: Retained<NSURL> = msg_send![&*target, URLByDeletingLastPathComponent];
                web.loadFileURL_allowingReadAccessToURL(&target, &folder);
            } else {
                web.loadRequest(&NSURLRequest::requestWithURL(&target));
            }
        }
    }

    fn bind(delegate: &PageDelegate, spec: &PageSpec) {
        *delegate.ivars().tab.borrow_mut() = Some(spec.tab.clone());
        *delegate.ivars().sink.borrow_mut() = Some(spec.sink.clone());
        *delegate.ivars().profile.borrow_mut() = spec.profile.clone();
        delegate.ivars().muted.set(spec.muted);
        set_private(delegate, spec.private);
    }

    pub fn open(spec: PageSpec) -> Option<NativeViewHandle> {
        if let Some(handle) = view(&spec.tab) {
            return Some(handle);
        }
        let mtm = MainThreadMarker::new()?;
        let config = configuration(mtm, &spec.profile, spec.private);
        let web = make_view(mtm, &config);
        let delegate = PageDelegate::make(mtm, &spec.profile);
        *delegate.ivars().web.borrow_mut() = Some(Weak::from_retained(&web));
        bind(&delegate, &spec);
        prepare(&web, &delegate, spec.inspectable && !spec.private);
        apply_mute(&web, spec.muted);
        let host = host_of(&spec.url);
        if spec.zoom.is_finite() && spec.zoom > 0.0 {
            store_zoom(&spec.profile, &host, spec.zoom);
            unsafe { web.setPageZoom(spec.zoom) };
        }
        if !restore_history(&web, &delegate, &spec) {
            let first = web.clone();
            let url = spec.url.clone();
            crate::webkit::content_rules::when_ready(
                1.0,
                Box::new(move || start_loading(&first, &url)),
            );
        }
        let handle = handle_of(&web);
        PAGES.with(|pages| {
            pages
                .borrow_mut()
                .insert(spec.tab.clone(), Page { web, delegate })
        });
        Some(handle)
    }

    pub fn adopt_held(held: &str, spec: PageSpec) -> Option<NativeViewHandle> {
        let page = HELD.with(|h| h.borrow_mut().remove(held))?;
        if let Some(old) = PAGES.with(|pages| pages.borrow_mut().remove(&spec.tab)) {
            retire(old);
        }
        bind(&page.delegate, &spec);
        unsafe { page.web.setInspectable(spec.inspectable && !spec.private) };
        apply_mute(&page.web, spec.muted);
        let handle = handle_of(&page.web);
        let delegate = page.delegate.clone();
        PAGES.with(|pages| pages.borrow_mut().insert(spec.tab.clone(), page));
        delegate.queue_navigation();
        Some(handle)
    }

    pub fn drop_held(held: &str) {
        if let Some(page) = HELD.with(|h| h.borrow_mut().remove(held)) {
            retire(page);
        }
    }

    fn retire(page: Page) {
        save_history_now(&page.delegate);
        forget_safety(&page.delegate);
        if let Some(tab) = page.delegate.ivars().tab.borrow().as_ref() {
            crate::webkit::page_events::forget_security(tab);
        }
        page.delegate.unwatch(&page.web);
        unsafe {
            if WKWebView::class_responds_to_find() {
                let _: () = msg_send![&*page.web, _setFindDelegate: None::<&AnyObject>];
            }
            page.web.setNavigationDelegate(None);
            page.web.setUIDelegate(None);
            page.web.stopLoading();
            page.web.pauseAllMediaPlaybackWithCompletionHandler(None);
            page.web.removeFromSuperview();
        }
        *page.delegate.ivars().sink.borrow_mut() = None;
    }

    trait FindSupport {
        fn class_responds_to_find() -> bool;
    }

    impl FindSupport for WKWebView {
        fn class_responds_to_find() -> bool {
            let class = WKWebView::class();
            [
                sel!(_findString:options:maxCount:),
                sel!(_setFindDelegate:),
                sel!(_findDelegate),
                sel!(_hideFindUI),
            ]
            .into_iter()
            .all(|selector| unsafe {
                let ok: bool = msg_send![class, instancesRespondToSelector: selector];
                ok
            })
        }
    }

    pub fn view(tab: &TabId) -> Option<NativeViewHandle> {
        with_page(tab, |page| handle_of(&page.web))
    }

    pub fn has(tab: &TabId) -> bool {
        with_page(tab, |_| ()).is_some()
    }

    pub fn close(tab: &TabId) {
        if let Some(page) = PAGES.with(|pages| pages.borrow_mut().remove(tab)) {
            retire(page);
        }
    }

    pub fn hold_retiring(tab: &TabId) -> Option<NativeViewHandle> {
        let page = PAGES.with(|pages| pages.borrow_mut().remove(tab))?;
        *page.delegate.ivars().sink.borrow_mut() = None;
        let handle = handle_of(&page.web);
        if let Some(old) = RETIRING.with(|r| r.borrow_mut().insert(tab.clone(), page)) {
            retire(old);
        }
        Some(handle)
    }

    pub fn retiring_view(tab: &TabId) -> Option<NativeViewHandle> {
        RETIRING.with(|r| r.borrow().get(tab).map(|page| handle_of(&page.web)))
    }

    pub fn release_retiring(tab: &TabId) {
        if let Some(page) = RETIRING.with(|r| r.borrow_mut().remove(tab)) {
            retire(page);
        }
    }

    pub fn load(tab: &TabId, url: &str) {
        with_page(tab, |page| start_loading(&page.web, url));
    }

    pub fn go_back(tab: &TabId) {
        with_page(tab, |page| unsafe { page.web.goBack() });
    }

    pub fn go_forward(tab: &TabId) {
        with_page(tab, |page| unsafe { page.web.goForward() });
    }

    pub fn reload(tab: &TabId, ignore_cache: bool) {
        with_page(tab, |page| unsafe {
            if reload_error(&page.delegate, &page.web) {
                return;
            }
            if ignore_cache {
                page.web.reloadFromOrigin();
            } else {
                page.web.reload();
            }
        });
    }

    pub fn stop(tab: &TabId) {
        with_page(tab, |page| unsafe { page.web.stopLoading() });
    }

    fn apply_zoom(page: &Page, zoom: f64) {
        let profile = page.delegate.ivars().profile.borrow().clone();
        unsafe { page.web.setPageZoom(zoom) };
        store_zoom(&profile, &host_of(&current_url(&page.web)), zoom);
        page.delegate.emit(WebKitEvent::Zoom(zoom));
    }

    pub fn zoom_step(tab: &TabId, direction: i32) {
        with_page(tab, |page| {
            let next = next_zoom(unsafe { page.web.pageZoom() }, direction);
            apply_zoom(page, next);
        });
    }

    pub fn set_zoom(tab: &TabId, zoom: f64) {
        if !zoom.is_finite() || zoom <= 0.0 {
            return;
        }
        with_page(tab, |page| {
            if (unsafe { page.web.pageZoom() } - zoom).abs() > 0.001 {
                apply_zoom(page, zoom);
            }
        });
    }

    pub fn set_muted(tab: &TabId, muted: bool) {
        with_page(tab, |page| {
            page.delegate.ivars().muted.set(muted);
            apply_mute(&page.web, muted);
        });
    }

    fn native_find(web: &WKWebView, delegate: &PageDelegate, query: &str, forward: bool) {
        let mut options: usize = (1 << 0) | (1 << 4) | (1 << 7) | (1 << 9);
        if !forward {
            options |= 1 << 3;
        }
        unsafe {
            let current: *mut AnyObject = msg_send![web, _findDelegate];
            if !std::ptr::eq(
                current,
                (delegate as *const PageDelegate)
                    .cast::<AnyObject>()
                    .cast_mut(),
            ) {
                let _: () = msg_send![web, _setFindDelegate: delegate];
            }
            let _: () = msg_send![
                web,
                _findString: &*NSString::from_str(query),
                options: options,
                maxCount: FIND_MAX_COUNT
            ];
        }
    }

    fn fallback_find(
        web: Retained<WKWebView>,
        delegate: Retained<PageDelegate>,
        query: String,
        forward: bool,
    ) {
        let mtm = MainThreadMarker::from(&*delegate);
        let world = unsafe { WKContentWorld::worldWithName(&NSString::from_str("ardia"), mtm) };
        let script = NSString::from_str(&count_script(&query));
        let counted = RcBlock::new(move |value: *mut AnyObject, _error: *mut NSError| {
            if delegate.ivars().find.borrow().text != query {
                return;
            }
            let total = unsafe { value.as_ref() }
                .and_then(|v| v.downcast_ref::<objc2_foundation::NSNumber>())
                .map(|n| n.integerValue().max(0) as usize)
                .unwrap_or(0);
            let configuration = unsafe { WKFindConfiguration::new(mtm) };
            unsafe {
                configuration.setBackwards(!forward);
                configuration.setCaseSensitive(false);
                configuration.setWraps(true);
            }
            let reporter = delegate.clone();
            let wanted = query.clone();
            let done = RcBlock::new(move |result: NonNull<WKFindResult>| {
                let delegate = &reporter;
                if delegate.ivars().find.borrow().text != wanted {
                    return;
                }
                let found = unsafe { result.as_ref().matchFound() };
                if !found {
                    delegate.ivars().find.borrow_mut().active = 0;
                    delegate.emit(WebKitEvent::FindMatches(Some(0), 0));
                    return;
                }
                let count = total.max(1);
                let active = {
                    let mut find = delegate.ivars().find.borrow_mut();
                    find.active = if find.active == 0 {
                        1
                    } else if forward {
                        find.active % count + 1
                    } else {
                        (find.active + count - 2) % count + 1
                    };
                    find.active
                };
                delegate.emit(WebKitEvent::FindMatches(Some(count as u32), active as u32));
            });
            if let Some(web) = delegate.web() {
                unsafe {
                    web.findString_withConfiguration_completionHandler(
                        &NSString::from_str(&query),
                        Some(&configuration),
                        &done,
                    )
                };
            }
        });
        unsafe {
            web.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
                &script,
                None,
                &world,
                Some(&counted),
            )
        };
    }

    pub fn find(tab: &TabId, query: &str, forward: bool) {
        let Some((web, delegate)) = with_page(tab, |p| (p.web.clone(), p.delegate.clone())) else {
            return;
        };
        if query.is_empty() {
            stop_finding(tab);
            delegate.emit(WebKitEvent::FindMatches(Some(0), 0));
            return;
        }
        let (fresh, refined) = {
            let mut find = delegate.ivars().find.borrow_mut();
            let fresh = find.text != query;
            let refined = fresh && !find.text.is_empty();
            if fresh {
                find.text = query.to_owned();
                find.active = 0;
            }
            (fresh, refined)
        };
        let _ = fresh;
        if !WKWebView::class_responds_to_find() {
            fallback_find(web, delegate, query.to_owned(), forward);
            return;
        }
        if !refined {
            native_find(&web, &delegate, query, forward);
            return;
        }
        let mtm = MainThreadMarker::from(&*delegate);
        let world = unsafe { WKContentWorld::worldWithName(&NSString::from_str("ardia"), mtm) };
        let query = query.to_owned();
        let collapse = NSString::from_str(
            "(() => { const s = getSelection(); if (s.rangeCount) s.collapseToStart(); })()",
        );
        let then = RcBlock::new(move |_value: *mut AnyObject, _error: *mut NSError| {
            if delegate.ivars().find.borrow().text != query {
                return;
            }
            if let Some(web) = delegate.web() {
                native_find(&web, &delegate, &query, forward);
            }
        });
        unsafe {
            web.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
                &collapse,
                None,
                &world,
                Some(&then),
            )
        };
    }

    pub fn stop_finding(tab: &TabId) {
        with_page(tab, |page| {
            *page.delegate.ivars().find.borrow_mut() = FindState::default();
            let mtm = MainThreadMarker::from(&*page.delegate);
            unsafe {
                if WKWebView::class_responds_to_find() {
                    let _: () = msg_send![&*page.web, _hideFindUI];
                }
                let world = WKContentWorld::worldWithName(&NSString::from_str("ardia"), mtm);
                page.web
                    .evaluateJavaScript_inFrame_inContentWorld_completionHandler(
                        &NSString::from_str("getSelection().removeAllRanges()"),
                        None,
                        &world,
                        None,
                    );
            }
        });
    }

    pub fn evaluate(tab: &TabId, script: &str, done: Evaluated) {
        let Some(web) = with_page(tab, |p| p.web.clone()) else {
            done(None);
            return;
        };
        let Some(mtm) = MainThreadMarker::new() else {
            done(None);
            return;
        };
        let slot = Cell::new(Some(done));
        let asked = std::time::Instant::now();
        let reply = RcBlock::new(move |value: *mut AnyObject, _error: *mut NSError| {
            ardia_profile::record_since(ardia_profile::Span::WebkitReply, asked);
            let text = unsafe { value.as_ref() }
                .and_then(|v| v.downcast_ref::<NSString>())
                .map(|s| s.to_string());
            if let Some(done) = slot.take() {
                done(text);
            }
        });
        unsafe {
            let world = WKContentWorld::worldWithName(&NSString::from_str("ardia"), mtm);
            let arguments = NSDictionary::<NSString, AnyObject>::new();
            web.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &NSString::from_str(&evaluate_body(script)),
                Some(&arguments),
                None,
                &world,
                Some(&reply),
            );
        }
    }

    pub fn set_visible(tab: &TabId, visible: bool) {
        with_page(tab, |page| page.web.setHidden(!visible));
    }

    pub fn focus(tab: &TabId) {
        with_page(tab, |page| unsafe {
            let window: Option<Retained<AnyObject>> = msg_send![&*page.web, window];
            if let Some(window) = window {
                let _: bool = msg_send![&*window, makeFirstResponder: &*page.web];
            }
        });
    }

    pub fn end_private_session(base_profile: &str) {
        PRIVATE.with(|p| p.borrow_mut().remove(private_base(base_profile)));
    }

    pub fn store_for(profile: &str, private: bool) -> Option<Retained<WKWebsiteDataStore>> {
        MainThreadMarker::new().map(|mtm| data_store(mtm, profile, private))
    }

    pub fn set_host_zoom(profile: &str, host: &str, zoom: f64) {
        store_zoom(profile, host, zoom);
    }

    pub fn count() -> usize {
        PAGES.with(|pages| pages.borrow().len())
    }

    pub fn apply_fraud_warnings(on: bool) {
        PAGES.with(|pages| {
            for page in pages.borrow().values() {
                unsafe {
                    page.web
                        .configuration()
                        .preferences()
                        .setFraudulentWebsiteWarningEnabled(on);
                }
            }
        });
    }

    include!("page_safety.rs");

    pub fn held_count() -> usize {
        HELD.with(|h| h.borrow().len())
    }
}

#[cfg(target_os = "macos")]
pub use mac::{
    adopt_held, close, count, drop_held, end_private_session, evaluate, find, focus, go_back,
    go_forward, has, held_count, load, open, reload, set_muted, set_visible, set_zoom, stop,
    stop_finding, view, zoom_step,
};
#[cfg(target_os = "macos")]
pub use mac::{
    any_web, hold_worker_window, live_tab_for, owner_of, profile_of, set_host_zoom, store_for,
    web_of,
};
#[cfg(target_os = "macos")]
pub use mac::{hold_retiring, release_retiring, retiring_view};

#[cfg(not(target_os = "macos"))]
mod stub {
    use super::*;

    pub fn open(spec: PageSpec) -> Option<NativeViewHandle> {
        let _ = spec;
        None
    }

    pub fn adopt_held(held: &str, spec: PageSpec) -> Option<NativeViewHandle> {
        let _ = (held, spec);
        None
    }

    pub fn hold_retiring(tab: &TabId) -> Option<NativeViewHandle> {
        let _ = tab;
        None
    }

    pub fn retiring_view(tab: &TabId) -> Option<NativeViewHandle> {
        let _ = tab;
        None
    }

    pub fn release_retiring(tab: &TabId) {
        let _ = tab;
    }

    pub fn drop_held(held: &str) {
        let _ = held;
    }

    pub fn view(tab: &TabId) -> Option<NativeViewHandle> {
        let _ = tab;
        None
    }

    pub fn has(tab: &TabId) -> bool {
        let _ = tab;
        false
    }

    pub fn close(tab: &TabId) {
        let _ = tab;
    }

    pub fn load(tab: &TabId, url: &str) {
        let _ = (tab, url);
    }

    pub fn go_back(tab: &TabId) {
        let _ = tab;
    }

    pub fn go_forward(tab: &TabId) {
        let _ = tab;
    }

    pub fn reload(tab: &TabId, ignore_cache: bool) {
        let _ = (tab, ignore_cache);
    }

    pub fn stop(tab: &TabId) {
        let _ = tab;
    }

    pub fn zoom_step(tab: &TabId, direction: i32) {
        let _ = (tab, direction);
    }

    pub fn set_zoom(tab: &TabId, zoom: f64) {
        let _ = (tab, zoom);
    }

    pub fn set_muted(tab: &TabId, muted: bool) {
        let _ = (tab, muted);
    }

    pub fn find(tab: &TabId, query: &str, forward: bool) {
        let _ = (tab, query, forward);
    }

    pub fn stop_finding(tab: &TabId) {
        let _ = tab;
    }

    pub fn evaluate(tab: &TabId, script: &str, done: Evaluated) {
        let _ = (tab, script);
        done(None);
    }

    pub fn set_visible(tab: &TabId, visible: bool) {
        let _ = (tab, visible);
    }

    pub fn focus(tab: &TabId) {
        let _ = tab;
    }

    pub fn end_private_session(base_profile: &str) {
        let _ = base_profile;
    }

    pub fn count() -> usize {
        0
    }

    pub fn held_count() -> usize {
        0
    }
}

#[cfg(not(target_os = "macos"))]
pub use stub::*;

#[cfg(target_os = "macos")]
pub use mac::{flush_history, open_blocked, resolve_external, set_history_dir};

#[cfg(not(target_os = "macos"))]
pub fn open_blocked(_: &TabId, _: &str, _: bool) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn resolve_external(_: &str, _: bool, _: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn set_history_dir(_: Option<PathBuf>) {}

#[cfg(not(target_os = "macos"))]
pub fn flush_history() {}

#[cfg(not(target_os = "macos"))]
pub fn profile_of(_: &TabId) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn native_classes_match_their_protocols() {
        use objc2::ClassType as _;
        crate::webkit::native_audit::assert_conforms(
            super::mac::PageDelegate::class(),
            &[c"WKNavigationDelegate", c"WKUIDelegate", c"_WKFindDelegate"],
        );
        crate::webkit::native_audit::assert_conforms(
            super::mac::Bridge::class(),
            &[c"WKScriptMessageHandler"],
        );
        crate::webkit::native_audit::assert_signatures(
            super::mac::PageDelegate::class(),
            &[
                ("_webView:didCountMatches:forString:", "v@:@Q@"),
                (
                    "_webView:didFindMatches:forString:withMatchIndex:",
                    "v@:@Q@q",
                ),
                ("_webView:didFailToFindString:", "v@:@@"),
                (
                    "observeValueForKeyPath:ofObject:change:context:",
                    "v@:@@@^v",
                ),
                (
                    "_webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:completionHandler:",
                    "v@:@@@@@?",
                ),
            ],
        );
    }

    #[test]
    fn uuid_strings_are_hyphenated_upper_hex() {
        let bytes = [
            0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
            0xcd, 0xef,
        ];
        assert_eq!(uuid_string(&bytes), "01234567-89AB-CDEF-0123-456789ABCDEF");
    }

    use super::*;

    #[test]
    fn store_identifiers_match_the_old_app() {
        let id = store_identifier("", "");
        assert_eq!(id[6] & 0xF0, 0x50);
        assert_eq!(id[8] & 0xC0, 0x80);
        assert_eq!(
            store_identifier("", ""),
            [
                0xe7, 0x59, 0xfb, 0xd0, 0x71, 0x5c, 0x5c, 0x5c, 0xbd, 0x62, 0xf9, 0xc9, 0x6b, 0x18,
                0x99, 0x6d
            ]
        );
        assert_ne!(store_identifier("/tmp/a", ""), store_identifier("", ""));
    }

    #[test]
    fn scopes_are_absolute_and_tidy() {
        let cwd = Path::new("/work/here");
        assert_eq!(normalized_scope(None, cwd), "");
        assert_eq!(normalized_scope(Some(""), cwd), "");
        assert_eq!(normalized_scope(Some("/tmp/x/"), cwd), "/tmp/x");
        assert_eq!(normalized_scope(Some("/tmp/./x/../y"), cwd), "/tmp/y");
        assert_eq!(normalized_scope(Some("data"), cwd), "/work/here/data");
        assert_eq!(private_base("p@Default"), "p");
        assert_eq!(private_base("Default"), "Default");
    }

    #[test]
    fn helpers_follow_webkit_tab() {
        assert_eq!(safari_version(Some("26.1.2")), "26.1");
        assert_eq!(safari_version(None), "18.6");
        assert_eq!(application_name("26.1"), "Version/26.1 Safari/605.1.15");
        assert_eq!(hex_color(1.0, 0.5, 0.0), "#FF8000");
        assert_eq!(host_of("https://WWW.Example.com:8/a"), "www.example.com");
        assert!(is_web_scheme("HTTPS"));
        assert!(!is_web_scheme("mailto"));
        assert_eq!(
            disposition(true, false, false, false),
            Disposition::Background
        );
        assert_eq!(
            disposition(true, true, false, false),
            Disposition::Foreground
        );
        assert_eq!(
            disposition(false, false, true, false),
            Disposition::Background
        );
        assert_eq!(disposition(false, false, false, true), Disposition::Popup);
        assert!(popup_blocked(Disposition::Popup, false));
        assert!(!popup_blocked(Disposition::Background, false));
        assert!(!popup_blocked(Disposition::Foreground, true));
        assert!(
            evaluate_body("post(\"result\", \"1\")")
                .contains("setTimeout(() => resolve(null), 3000)")
        );
        assert_eq!(
            page_message(r#"{"kind":"icons","data":{"icons":["https://a/x.ico","javascript:1"]}}"#),
            Some(vec!["https://a/x.ico".to_owned()])
        );
        assert_eq!(page_message(r#"{"kind":"other"}"#), None);
        assert!(count_script("a\"b").contains("\"a\\\"b\""));
    }
}
