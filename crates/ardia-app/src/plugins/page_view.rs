use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const SCHEME: &str = "ardia-plugin";
pub const OFFLINE_POLICY: &str = "default-src 'self' ardia-plugin: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ardia-plugin:; form-action 'self'; worker-src 'none'";
pub const MAX_FROM_PAGE: usize = 64 << 10;
pub const MAX_TO_PAGE: usize = 256 << 10;
pub const MESSAGES_PER_SECOND: usize = 100;

pub type PageMessage = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Clone)]
pub struct PageSpec {
    pub plugin: String,
    pub url: String,
    pub folder: PathBuf,
    pub offline: bool,
    pub context: Option<String>,
    pub on_message: PageMessage,
}

pub fn relative_path(url: &str, plugin: &str) -> Option<String> {
    let rest = url.strip_prefix(&format!("{SCHEME}://"))?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    if !host.eq_ignore_ascii_case(plugin) || host.contains(['@', ':']) {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let decoded: Vec<String> = path
        .split('/')
        .map(|part| {
            url::form_urlencoded::parse(format!("x={}", part.replace('+', "%2B")).as_bytes())
                .next()
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default()
        })
        .collect();
    let joined = decoded.join("/");
    super::manifest::is_plugin_path(&joined).then_some(joined)
}

pub fn mime_type(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "js" | "mjs" => "text/javascript",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

pub fn read_file(folder: &Path, relative: &str) -> Option<Vec<u8>> {
    let path = folder.join(relative);
    let real = std::fs::canonicalize(&path).ok()?;
    let root = std::fs::canonicalize(folder).ok()?;
    (real.starts_with(&root) && real.is_file())
        .then(|| std::fs::read(real).ok())
        .flatten()
}

pub fn js_string(text: &str) -> String {
    serde_json::Value::String(text.to_owned()).to_string()
}

pub fn page_script(context: Option<&str>) -> String {
    let context = context.map_or_else(
        || "null".to_owned(),
        |c| format!("JSON.parse({})", js_string(c)),
    );
    format!(
        "(() => {{ const ardia = new EventTarget(); ardia.context = {context}; ardia.send = (message) => window.webkit.messageHandlers.ardia.postMessage(JSON.stringify(message)); Object.defineProperty(window, \"ardia\", {{ value: ardia, writable: false, configurable: false }}); }})();"
    )
}

pub fn deliver_script(json: &str) -> String {
    format!(
        "if (window.ardia) window.ardia.dispatchEvent(new MessageEvent(\"message\", {{ data: JSON.parse({}) }}));",
        js_string(json)
    )
}

pub fn from_page(text: &str, view: &str) -> Option<String> {
    if text.len() > MAX_FROM_PAGE {
        return None;
    }
    let message: serde_json::Value = serde_json::from_str(text).ok()?;
    Some(serde_json::json!({ "pageMessage": message, "view": view }).to_string())
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::time::Instant;

    use ardia_engine::NativeViewHandle;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{
        AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    };
    use objc2_foundation::{
        NSData, NSDictionary, NSHTTPURLResponse, NSPoint, NSRect, NSSize, NSString, NSURL,
        NSURLRequest,
    };
    use objc2_web_kit::{
        WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKScriptMessage,
        WKScriptMessageHandler, WKURLSchemeHandler, WKURLSchemeTask, WKUserContentController,
        WKUserScript, WKUserScriptInjectionTime, WKWebView, WKWebViewConfiguration,
        WKWebsiteDataStore,
    };

    use super::*;

    pub struct SchemeIvars {
        plugin: String,
        folder: PathBuf,
        policy: Option<String>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArdiaGpuiPluginSchemeHandler"]
        #[ivars = SchemeIvars]
        pub struct SchemeHandler;

        unsafe impl NSObjectProtocol for SchemeHandler {}

        unsafe impl WKURLSchemeHandler for SchemeHandler {
            #[unsafe(method(webView:startURLSchemeTask:))]
            unsafe fn start(&self, _web: &WKWebView, task: &ProtocolObject<dyn WKURLSchemeTask>) {
                self.serve(task);
            }

            #[unsafe(method(webView:stopURLSchemeTask:))]
            unsafe fn stop(&self, _web: &WKWebView, _task: &ProtocolObject<dyn WKURLSchemeTask>) {}
        }
    );

    impl SchemeHandler {
        fn create(mtm: MainThreadMarker, ivars: SchemeIvars) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(ivars);
            unsafe { msg_send![super(this), init] }
        }

        fn serve(&self, task: &ProtocolObject<dyn WKURLSchemeTask>) {
            let ivars = self.ivars();
            let request = unsafe { task.request() };
            let Some(url) = request.URL() else {
                return;
            };
            let text = url
                .absoluteString()
                .map(|s| s.to_string())
                .unwrap_or_default();
            let found = relative_path(&text, &ivars.plugin)
                .and_then(|path| read_file(&ivars.folder, &path).map(|bytes| (path, bytes)));
            let (status, body, kind) = match &found {
                Some((path, bytes)) => (200, bytes.clone(), mime_type(path)),
                None => (404, b"Not found".to_vec(), "text/plain; charset=utf-8"),
            };
            let mut headers: Vec<(&str, String)> = vec![
                ("content-type", kind.to_owned()),
                ("content-length", body.len().to_string()),
                ("cache-control", "no-store".into()),
                ("x-content-type-options", "nosniff".into()),
            ];
            if let Some(policy) = &ivars.policy {
                headers.push(("content-security-policy", policy.clone()));
                headers.push(("x-dns-prefetch-control", "off".into()));
            }
            let keys: Vec<Retained<NSString>> =
                headers.iter().map(|(k, _)| NSString::from_str(k)).collect();
            let values: Vec<Retained<NSString>> =
                headers.iter().map(|(_, v)| NSString::from_str(v)).collect();
            let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
            let value_refs: Vec<&NSString> = values.iter().map(|v| &**v).collect();
            let fields = NSDictionary::from_slices(&key_refs, &value_refs);
            let version = NSString::from_str("HTTP/1.1");
            let response = NSHTTPURLResponse::initWithURL_statusCode_HTTPVersion_headerFields(
                NSHTTPURLResponse::alloc(),
                &url,
                status,
                Some(&version),
                Some(&fields),
            );
            let Some(response) = response else {
                return;
            };
            unsafe {
                task.didReceiveResponse(&response);
                task.didReceiveData(&NSData::with_bytes(&body));
                task.didFinish();
            }
        }
    }

    pub struct BridgeIvars {
        plugin: String,
        view: String,
        on_message: PageMessage,
        window: RefCell<(Instant, usize)>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArdiaGpuiPluginPageBridge"]
        #[ivars = BridgeIvars]
        pub struct PageBridge;

        unsafe impl NSObjectProtocol for PageBridge {}

        unsafe impl WKScriptMessageHandler for PageBridge {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            unsafe fn received(
                &self,
                _controller: &WKUserContentController,
                message: &WKScriptMessage,
            ) {
                self.forward(message);
            }
        }

        unsafe impl WKNavigationDelegate for PageBridge {
            #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
            unsafe fn decide(
                &self,
                _web: &WKWebView,
                action: &WKNavigationAction,
                handler: &block2::DynBlock<dyn Fn(WKNavigationActionPolicy)>,
            ) {
                let allowed = self.allows(action);
                handler.call((if allowed {
                    WKNavigationActionPolicy::Allow
                } else {
                    WKNavigationActionPolicy::Cancel
                },));
            }
        }
    );

    impl PageBridge {
        fn create(mtm: MainThreadMarker, ivars: BridgeIvars) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(ivars);
            unsafe { msg_send![super(this), init] }
        }

        fn allows(&self, action: &WKNavigationAction) -> bool {
            let url = unsafe { action.request().URL() }
                .and_then(|u| u.absoluteString())
                .map(|s| s.to_string())
                .unwrap_or_default();
            let main = unsafe { action.targetFrame() }.is_some_and(|f| unsafe { f.isMainFrame() });
            if url.starts_with("about:") && !main {
                return true;
            }
            unsafe { action.targetFrame() }.is_some()
                && relative_path(&url, &self.ivars().plugin).is_some()
        }

        fn forward(&self, message: &WKScriptMessage) {
            let ivars = self.ivars();
            let frame = unsafe { message.frameInfo() };
            let origin = unsafe { frame.securityOrigin() };
            let same = unsafe { frame.isMainFrame() }
                && unsafe { origin.protocol() }.to_string() == SCHEME
                && unsafe { origin.host() }
                    .to_string()
                    .eq_ignore_ascii_case(&ivars.plugin);
            if !same {
                return;
            }
            {
                let mut window = ivars.window.borrow_mut();
                if window.0.elapsed().as_secs_f32() >= 1.0 {
                    *window = (Instant::now(), 0);
                }
                window.1 += 1;
                if window.1 > MESSAGES_PER_SECOND {
                    return;
                }
            }
            let body = unsafe { message.body() };
            let Some(text) = body.downcast_ref::<NSString>().map(|s| s.to_string()) else {
                return;
            };
            if let Some(line) = from_page(&text, &ivars.view) {
                (ivars.on_message)(line);
            }
        }
    }

    struct Page {
        plugin: String,
        url: String,
        web: Retained<WKWebView>,
        _bridge: Retained<PageBridge>,
        _scheme: Retained<SchemeHandler>,
    }

    thread_local! {
        static PAGES: RefCell<HashMap<String, Page>> = RefCell::new(HashMap::new());
    }

    fn build(mtm: MainThreadMarker, key: &str, spec: &PageSpec) -> Option<Page> {
        let scheme = SchemeHandler::create(
            mtm,
            SchemeIvars {
                plugin: spec.plugin.clone(),
                folder: spec.folder.clone(),
                policy: spec.offline.then(|| OFFLINE_POLICY.to_owned()),
            },
        );
        let bridge = PageBridge::create(
            mtm,
            BridgeIvars {
                plugin: spec.plugin.clone(),
                view: key.to_owned(),
                on_message: Arc::clone(&spec.on_message),
                window: RefCell::new((Instant::now(), 0)),
            },
        );
        unsafe {
            let configuration = WKWebViewConfiguration::new(mtm);
            configuration.setWebsiteDataStore(&WKWebsiteDataStore::nonPersistentDataStore(mtm));
            configuration.setURLSchemeHandler_forURLScheme(
                Some(ProtocolObject::from_ref(&*scheme)),
                &NSString::from_str(SCHEME),
            );
            let controller = configuration.userContentController();
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                WKUserScript::alloc(mtm),
                &NSString::from_str(&page_script(spec.context.as_deref())),
                WKUserScriptInjectionTime::AtDocumentStart,
                true,
            );
            controller.addUserScript(&script);
            controller.addScriptMessageHandler_name(
                ProtocolObject::from_ref(&*bridge),
                &NSString::from_str("ardia"),
            );
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 400.0));
            let web = WKWebView::initWithFrame_configuration(
                WKWebView::alloc(mtm),
                frame,
                &configuration,
            );
            web.setNavigationDelegate(Some(ProtocolObject::from_ref(&*bridge)));
            let url = NSURL::URLWithString(&NSString::from_str(&spec.url))?;
            web.loadRequest(&NSURLRequest::requestWithURL(&url));
            Some(Page {
                plugin: spec.plugin.clone(),
                url: spec.url.clone(),
                web,
                _bridge: bridge,
                _scheme: scheme,
            })
        }
    }

    pub fn view_for(key: &str, spec: &PageSpec) -> Option<NativeViewHandle> {
        let mtm = MainThreadMarker::new()?;
        PAGES.with(|pages| {
            let mut pages = pages.borrow_mut();
            let fresh = pages
                .get(key)
                .is_none_or(|p| p.url != spec.url || p.plugin != spec.plugin);
            if fresh {
                if let Some(old) = pages.remove(key) {
                    old.web.removeFromSuperview();
                }
                let page = build(mtm, key, spec)?;
                pages.insert(key.to_owned(), page);
            }
            pages
                .get(key)
                .map(|p| NativeViewHandle(Retained::as_ptr(&p.web) as *mut std::ffi::c_void))
        })
    }

    pub fn release(key: &str) {
        PAGES.with(|pages| {
            if let Some(page) = pages.borrow_mut().remove(key) {
                unsafe {
                    page.web
                        .configuration()
                        .userContentController()
                        .removeScriptMessageHandlerForName(&NSString::from_str("ardia"));
                    page.web.removeFromSuperview();
                }
            }
        });
    }

    pub fn release_plugin(plugin: &str) {
        let keys: Vec<String> = PAGES.with(|pages| {
            pages
                .borrow()
                .iter()
                .filter(|(_, p)| p.plugin == plugin)
                .map(|(k, _)| k.clone())
                .collect()
        });
        for key in keys {
            release(&key);
        }
    }

    pub fn post(plugin: &str, view: Option<&str>, json: &str) -> bool {
        let script = NSString::from_str(&deliver_script(json));
        PAGES.with(|pages| {
            let pages = pages.borrow();
            let mut sent = false;
            for (key, page) in pages.iter() {
                if page.plugin != plugin || view.is_some_and(|v| v != key) {
                    continue;
                }
                unsafe { page.web.evaluateJavaScript_completionHandler(&script, None) };
                sent = true;
            }
            sent
        })
    }

    pub fn count() -> usize {
        PAGES.with(|pages| pages.borrow().len())
    }
}

#[cfg(target_os = "macos")]
pub use mac::{count, post, release, release_plugin, view_for};

#[cfg(not(target_os = "macos"))]
pub fn view_for(_: &str, _: &PageSpec) -> Option<ardia_engine::NativeViewHandle> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn release(_: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn release_plugin(_: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn post(_: &str, _: Option<&str>, _: &str) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn count() -> usize {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheme_paths_stay_inside_the_plugin() {
        assert_eq!(
            relative_path("ardia-plugin://notes/page/index.html", "notes").as_deref(),
            Some("page/index.html")
        );
        assert_eq!(
            relative_path("ardia-plugin://notes/a%20b.js?x=1", "notes").as_deref(),
            Some("a b.js")
        );
        assert_eq!(relative_path("ardia-plugin://notes/../x", "notes"), None);
        assert_eq!(relative_path("ardia-plugin://other/x", "notes"), None);
        assert_eq!(relative_path("https://notes/x", "notes"), None);
        assert_eq!(mime_type("a/b.MJS"), "text/javascript");
        assert_eq!(mime_type("x.bin"), "application/octet-stream");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("in.txt"), "hi").unwrap();
        assert_eq!(read_file(dir.path(), "in.txt").unwrap(), b"hi");
        assert!(read_file(dir.path(), "missing").is_none());
    }

    #[test]
    fn page_messages_are_wrapped_with_their_view() {
        assert_eq!(
            from_page("{\"a\":1}", "v1").unwrap(),
            r#"{"pageMessage":{"a":1},"view":"v1"}"#
        );
        assert!(from_page("not json", "v").is_none());
        assert!(page_script(Some("{\"tab\":1}")).contains("JSON.parse(\"{\\\"tab\\\":1}\")"));
        assert!(deliver_script("{}").starts_with("if (window.ardia)"));
    }
}
