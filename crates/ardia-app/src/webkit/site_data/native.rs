use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ptr::NonNull;
use std::rc::Rc;
use std::time::Duration;

use block2::RcBlock;
use futures::FutureExt as _;
use futures::channel::oneshot;
use futures::future::LocalBoxFuture;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_foundation::{
    NSArray, NSCopying, NSDate, NSDictionary, NSError, NSHTTPCookie, NSHTTPCookieDomain,
    NSHTTPCookieExpires, NSHTTPCookieName, NSHTTPCookiePath, NSHTTPCookieSameSiteLax,
    NSHTTPCookieSameSitePolicy, NSHTTPCookieSameSiteStrict, NSHTTPCookieSecure, NSHTTPCookieValue,
    NSPoint, NSRect, NSSize, NSString, NSURL, NSURLRequest,
};
use objc2_web_kit::{
    WKContentWorld, WKHTTPCookieStore, WKNavigation, WKNavigationDelegate, WKWebView,
    WKWebViewConfiguration, WKWebsiteDataStore,
};

use super::{
    MAX_WEBKIT_COOKIES, PageCookie, StorageChange, StorageItems, WebKitRead, WebKitWritten,
};

pub const MAX_BYTES: usize = 2_000_000;
pub const JOB_DEADLINE: Duration = Duration::from_secs(1);
pub const IDLE_CLOSE: Duration = Duration::from_secs(10);
pub const BLANK_PAGE: &str = "<!doctype html><meta charset=\"utf-8\"><title></title>";

const PLAIN_KEYS: [&str; 16] = [
    "Name",
    "Value",
    "Domain",
    "Path",
    "Expires",
    "Secure",
    "Version",
    "Port",
    "Discard",
    "Comment",
    "CommentURL",
    "OriginURL",
    "Max-Age",
    "SameSite",
    "HttpOnly",
    "Created",
];

pub fn read_script() -> String {
    format!(
        r#"const limit = {MAX_BYTES};
const wellFormed = (text) => {{
  if (typeof text.isWellFormed === "function") return text.isWellFormed();
  try {{ encodeURIComponent(text); return true; }} catch {{ return false; }}
}};
const items = [];
let size = 0;
for (let i = 0; i < localStorage.length; i++) {{
  const key = localStorage.key(i);
  const value = localStorage.getItem(key);
  if (key === null || value === null) continue;
  if (!wellFormed(key) || !wellFormed(value)) return JSON.stringify(null);
  size += key.length + value.length;
  if (size > limit) return JSON.stringify(null);
  items.push([key, value]);
}}
return JSON.stringify(items);"#
    )
}

pub fn write_script(change: &StorageChange) -> String {
    let set = serde_json::to_string(&change.set).unwrap_or_else(|_| "[]".into());
    let remove = serde_json::to_string(&change.remove).unwrap_or_else(|_| "[]".into());
    format!(
        r#"const set = JSON.parse({});
const remove = JSON.parse({});
let count = 0;
for (const [key, value] of set) {{
  try {{ localStorage.setItem(key, value); count++; }} catch {{}}
}}
for (const key of remove) {{ localStorage.removeItem(key); count++; }}
return JSON.stringify(count);"#,
        serde_json::Value::String(set),
        serde_json::Value::String(remove)
    )
}

pub fn root_url(origin: &str) -> Option<String> {
    super::web_origin(origin).map(|o| format!("{o}/"))
}

fn private(profile: &str) -> bool {
    profile.contains('@')
}

fn store(profile: &str) -> Option<Retained<WKWebsiteDataStore>> {
    if private(profile) {
        return None;
    }
    crate::webkit::page::store_for(profile, false)
}

fn partitioned(cookie: &NSHTTPCookie) -> bool {
    let Some(properties) = cookie.properties() else {
        return false;
    };
    properties.allKeys().iter().any(|key| {
        let key = key.to_string();
        !PLAIN_KEYS.contains(&key.as_str()) && key.to_lowercase().contains("partition")
    })
}

fn engine_entry(cookie: &NSHTTPCookie) -> PageCookie {
    let expires = cookie
        .expiresDate()
        .map(|date| date.timeIntervalSince1970())
        .unwrap_or(-1.0);
    let policy = cookie.sameSitePolicy().map(|p| p.to_string());
    let same_site = match policy.as_deref() {
        Some(p) if unsafe { p == NSHTTPCookieSameSiteStrict.to_string() } => Some("Strict".into()),
        Some(p) if unsafe { p == NSHTTPCookieSameSiteLax.to_string() } => Some("Lax".into()),
        _ => None,
    };
    PageCookie {
        name: cookie.name().to_string(),
        value: cookie.value().to_string(),
        domain: cookie.domain().to_string(),
        path: cookie.path().to_string(),
        expires,
        session: cookie.isSessionOnly(),
        http_only: cookie.isHTTPOnly(),
        secure: cookie.isSecure(),
        same_site,
        partition_key: None,
        partition_key_opaque: None,
    }
}

fn http_cookie(cookie: &PageCookie, now_seconds: f64) -> Option<Retained<NSHTTPCookie>> {
    if cookie.name.is_empty()
        || cookie.domain.is_empty()
        || cookie.partition_key.as_ref().is_some_and(|v| !v.is_null())
        || cookie.partition_key_opaque == Some(true)
    {
        return None;
    }
    let path = if cookie.path.is_empty() {
        "/"
    } else {
        &cookie.path
    };
    let mut keys: Vec<Retained<NSString>> = Vec::new();
    let mut values: Vec<Retained<AnyObject>> = Vec::new();
    let mut push = |key: &NSString, value: Retained<AnyObject>| {
        keys.push(key.copy());
        values.push(value);
    };
    let text = |s: &str| -> Retained<AnyObject> {
        Retained::into_super(Retained::into_super(NSString::from_str(s)))
    };
    unsafe {
        push(NSHTTPCookieName, text(&cookie.name));
        push(NSHTTPCookieValue, text(&cookie.value));
        push(NSHTTPCookieDomain, text(&cookie.domain));
        push(NSHTTPCookiePath, text(path));
        if cookie.secure {
            push(NSHTTPCookieSecure, text("TRUE"));
        }
    }
    if cookie.http_only {
        push(&NSString::from_str("HttpOnly"), text("TRUE"));
    }
    if !cookie.session && cookie.expires > 0.0 {
        if cookie.expires <= now_seconds {
            return None;
        }
        let date = NSDate::dateWithTimeIntervalSince1970(cookie.expires);
        unsafe {
            push(
                NSHTTPCookieExpires,
                Retained::into_super(Retained::into_super(date)),
            )
        };
    }
    match cookie.same_site.as_deref() {
        Some("None") => {}
        Some("Strict") => unsafe {
            push(
                NSHTTPCookieSameSitePolicy,
                text(&NSHTTPCookieSameSiteStrict.to_string()),
            )
        },
        _ => unsafe {
            push(
                NSHTTPCookieSameSitePolicy,
                text(&NSHTTPCookieSameSiteLax.to_string()),
            )
        },
    }
    let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let dictionary = NSDictionary::from_retained_objects(&key_refs, &values);
    unsafe { NSHTTPCookie::cookieWithProperties(&dictionary) }
}

fn all_cookies(cookie_store: &WKHTTPCookieStore) -> oneshot::Receiver<Vec<Retained<NSHTTPCookie>>> {
    let (answer, reply) = oneshot::channel();
    let answer = RefCell::new(Some(answer));
    let block = RcBlock::new(move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
        let list = unsafe { cookies.as_ref() }.to_vec();
        if let Some(answer) = answer.borrow_mut().take() {
            let _ = answer.send(list);
        }
    });
    unsafe { cookie_store.getAllCookies(&block) };
    reply
}

fn after_each(count: usize, done: impl FnOnce() + 'static) -> Rc<dyn Fn()> {
    let left = Rc::new(RefCell::new(count));
    let done = Rc::new(RefCell::new(Some(done)));
    if count == 0
        && let Some(done) = done.borrow_mut().take()
    {
        done();
    }
    Rc::new(move || {
        let mut left = left.borrow_mut();
        *left = left.saturating_sub(1);
        if *left == 0
            && let Some(done) = done.borrow_mut().take()
        {
            done();
        }
    })
}

pub fn read(
    profile: &str,
    domains: &[String],
    origins: &[String],
) -> LocalBoxFuture<'static, Option<WebKitRead>> {
    let Some(store) = store(profile) else {
        return futures::future::ready(None).boxed_local();
    };
    let wanted: Vec<String> = domains
        .iter()
        .map(|d| d.to_lowercase())
        .filter(|d| !d.is_empty())
        .collect();
    let profile = profile.to_owned();
    let origins = origins.to_vec();
    async move {
        let cookie_store = unsafe { store.httpCookieStore() };
        let all = all_cookies(&cookie_store).await.ok()?;
        let cookies: Vec<PageCookie> = all
            .iter()
            .filter(|c| super::covered_by(&c.domain().to_string(), &wanted) && !partitioned(c))
            .take(MAX_WEBKIT_COOKIES)
            .map(|c| engine_entry(c))
            .collect();
        let mut storage = BTreeMap::new();
        let mut seen = std::collections::HashSet::new();
        for origin in origins {
            let Some(root) = root_url(&origin) else {
                continue;
            };
            if !seen.insert(root.clone()) {
                continue;
            }
            let value = run_job(&profile, &store, root, read_script()).await;
            let items: Option<StorageItems> = value
                .ok()
                .flatten()
                .as_deref()
                .and_then(|text| serde_json::from_str::<Option<Vec<(String, String)>>>(text).ok())
                .flatten();
            storage.insert(origin, items);
        }
        Some(WebKitRead { cookies, storage })
    }
    .boxed_local()
}

pub fn write(
    profile: &str,
    set: Vec<PageCookie>,
    remove: Vec<PageCookie>,
    storage: BTreeMap<String, StorageChange>,
) -> LocalBoxFuture<'static, Option<WebKitWritten>> {
    let Some(store) = store(profile) else {
        return futures::future::ready(None).boxed_local();
    };
    let profile = profile.to_owned();
    async move {
        let cookie_store = unsafe { store.httpCookieStore() };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let made: Vec<Retained<NSHTTPCookie>> =
            set.iter().filter_map(|c| http_cookie(c, now)).collect();
        let all = all_cookies(&cookie_store).await.ok()?;
        let doomed: Vec<&Retained<NSHTTPCookie>> = all
            .iter()
            .filter(|cookie| {
                !partitioned(cookie)
                    && remove.iter().any(|r| {
                        r.name == cookie.name().to_string()
                            && r.domain.to_lowercase() == cookie.domain().to_string().to_lowercase()
                            && (if r.path.is_empty() { "/" } else { &r.path })
                                == cookie.path().to_string()
                    })
            })
            .collect();
        let removed = doomed.len() as u64;
        let (finished, wait) = oneshot::channel::<()>();
        let finished = RefCell::new(Some(finished));
        let tick = after_each(doomed.len() + made.len(), move || {
            if let Some(finished) = finished.borrow_mut().take() {
                let _ = finished.send(());
            }
        });
        for cookie in doomed {
            let tick = tick.clone();
            let block = RcBlock::new(move || tick());
            unsafe { cookie_store.deleteCookie_completionHandler(cookie, Some(&block)) };
        }
        for cookie in &made {
            let tick = tick.clone();
            let block = RcBlock::new(move || tick());
            unsafe { cookie_store.setCookie_completionHandler(cookie, Some(&block)) };
        }
        let _ = wait.await;
        let mut stored = 0u64;
        for (origin, change) in storage {
            let Some(root) = root_url(&origin) else {
                continue;
            };
            if change.set.is_empty() && change.remove.is_empty() {
                continue;
            }
            let value = run_job(&profile, &store, root, write_script(&change)).await;
            stored += value
                .ok()
                .flatten()
                .as_deref()
                .and_then(|text| serde_json::from_str::<u64>(text).ok())
                .unwrap_or(0);
        }
        Some(WebKitWritten {
            cookies: made.len() as u64,
            removed,
            storage: stored,
        })
    }
    .boxed_local()
}

struct Job {
    origin: String,
    script: String,
    done: oneshot::Sender<Option<String>>,
}

struct Reader {
    view: Retained<WKWebView>,
    delegate: Retained<ReaderDelegate>,
    queue: VecDeque<Job>,
    running: Option<Job>,
    loaded: Option<String>,
    generation: u64,
    idle: u64,
}

thread_local! {
    static READERS: RefCell<HashMap<String, Reader>> = RefCell::new(HashMap::new());
}

pub struct ReaderIvars {
    profile: String,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "ArdiaGpuiSiteStorageReader"]
    #[ivars = ReaderIvars]
    pub struct ReaderDelegate;

    unsafe impl NSObjectProtocol for ReaderDelegate {}

    unsafe impl WKNavigationDelegate for ReaderDelegate {
        #[unsafe(method(webView:didFinishNavigation:))]
        unsafe fn finished(&self, web: &WKWebView, _navigation: Option<&WKNavigation>) {
            let url = unsafe { web.URL() }
                .and_then(|u| u.absoluteString())
                .map(|s| s.to_string())
                .unwrap_or_default();
            loaded(&self.ivars().profile, &url);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        unsafe fn failed(
            &self,
            _web: &WKWebView,
            _navigation: Option<&WKNavigation>,
            _error: &NSError,
        ) {
            fail_running(&self.ivars().profile);
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        unsafe fn failed_early(
            &self,
            _web: &WKWebView,
            _navigation: Option<&WKNavigation>,
            _error: &NSError,
        ) {
            fail_running(&self.ivars().profile);
        }
    }
);

fn reader_for(profile: &str, store: &WKWebsiteDataStore) {
    let mtm = match MainThreadMarker::new() {
        Some(mtm) => mtm,
        None => return,
    };
    let same = READERS.with(|readers| {
        readers.borrow().get(profile).is_some_and(|reader| {
            let current = unsafe { reader.view.configuration().websiteDataStore() };
            std::ptr::eq(&*current, store)
        })
    });
    if same {
        return;
    }
    close(profile);
    let delegate = ReaderDelegate::alloc(mtm).set_ivars(ReaderIvars {
        profile: profile.to_owned(),
    });
    let delegate: Retained<ReaderDelegate> = unsafe { msg_send![super(delegate), init] };
    let view = unsafe {
        let configuration = WKWebViewConfiguration::new(mtm);
        configuration.setWebsiteDataStore(store);
        WKWebView::initWithFrame_configuration(
            WKWebView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0)),
            &configuration,
        )
    };
    unsafe { view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    READERS.with(|readers| {
        readers.borrow_mut().insert(
            profile.to_owned(),
            Reader {
                view,
                delegate,
                queue: VecDeque::new(),
                running: None,
                loaded: None,
                generation: 0,
                idle: 0,
            },
        );
    });
}

pub fn cookie_store(profile: &str) -> Option<Retained<WKHTTPCookieStore>> {
    store(profile).map(|store| unsafe { store.httpCookieStore() })
}

pub fn every_cookie(cookie_store: &WKHTTPCookieStore, done: impl FnOnce(Vec<PageCookie>) + 'static) {
    let done = RefCell::new(Some(done));
    let block = RcBlock::new(move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
        let list: Vec<PageCookie> = unsafe { cookies.as_ref() }
            .to_vec()
            .iter()
            .filter(|cookie| !partitioned(cookie))
            .map(|cookie| engine_entry(cookie))
            .collect();
        if let Some(done) = done.borrow_mut().take() {
            done(list);
        }
    });
    unsafe { cookie_store.getAllCookies(&block) };
}

pub fn close(profile: &str) {
    let removed = READERS.with(|readers| readers.borrow_mut().remove(profile));
    if let Some(mut reader) = removed {
        unsafe {
            reader.view.setNavigationDelegate(None);
            reader.view.stopLoading();
        }
        let _ = &reader.delegate;
        if let Some(job) = reader.running.take() {
            let _ = job.done.send(None);
        }
        for job in reader.queue.drain(..) {
            let _ = job.done.send(None);
        }
    }
}

fn run_job(
    profile: &str,
    store: &WKWebsiteDataStore,
    origin: String,
    script: String,
) -> oneshot::Receiver<Option<String>> {
    let (done, reply) = oneshot::channel();
    reader_for(profile, store);
    let queued = READERS.with(|readers| {
        let mut readers = readers.borrow_mut();
        let Some(reader) = readers.get_mut(profile) else {
            return Err(done);
        };
        reader.idle += 1;
        reader.queue.push_back(Job {
            origin,
            script,
            done,
        });
        Ok(())
    });
    match queued {
        Ok(()) => run_next(profile),
        Err(done) => {
            let _ = done.send(None);
        }
    }
    reply
}

type Later = Box<dyn FnOnce() + Send>;

#[repr(C)]
struct DispatchQueue {
    _opaque: [u8; 0],
}

unsafe extern "C" {
    static _dispatch_main_q: DispatchQueue;
    fn dispatch_after_f(
        when: u64,
        queue: *const DispatchQueue,
        context: *mut std::ffi::c_void,
        work: extern "C" fn(*mut std::ffi::c_void),
    );
    fn dispatch_time(when: u64, delta: i64) -> u64;
}

extern "C" fn run_later(context: *mut std::ffi::c_void) {
    let job = unsafe { Box::from_raw(context.cast::<Later>()) };
    job();
}

fn later(delay: Duration, job: impl FnOnce() + Send + 'static) {
    let boxed: Box<Later> = Box::new(Box::new(job));
    unsafe {
        dispatch_after_f(
            dispatch_time(0, delay.as_nanos() as i64),
            &raw const _dispatch_main_q,
            Box::into_raw(boxed).cast(),
            run_later,
        )
    };
}

fn run_next(profile: &str) {
    let start = READERS.with(|readers| {
        let mut readers = readers.borrow_mut();
        let reader = readers.get_mut(profile)?;
        if reader.running.is_some() {
            return None;
        }
        let Some(job) = reader.queue.pop_front() else {
            let idle = reader.idle;
            let profile = profile.to_owned();
            later(IDLE_CLOSE, move || {
                let quiet = READERS.with(|readers| {
                    readers.borrow().get(&profile).is_some_and(|r| {
                        r.idle == idle && r.running.is_none() && r.queue.is_empty()
                    })
                });
                if quiet {
                    close(&profile);
                }
            });
            return None;
        };
        reader.generation += 1;
        let generation = reader.generation;
        let ready = reader.loaded.as_deref() == Some(job.origin.as_str())
            && unsafe { reader.view.URL() }
                .and_then(|u| u.absoluteString())
                .is_some_and(|u| u.to_string() == job.origin);
        let origin = job.origin.clone();
        reader.running = Some(job);
        if !ready {
            reader.loaded = None;
        }
        Some((generation, ready, origin, reader.view.clone()))
    });
    let Some((generation, ready, origin, view)) = start else {
        return;
    };
    let watched = profile.to_owned();
    later(JOB_DEADLINE, move || {
        let stuck = READERS.with(|readers| {
            readers
                .borrow()
                .get(&watched)
                .is_some_and(|r| r.generation == generation && r.running.is_some())
        });
        if stuck {
            close(&watched);
        }
    });
    if ready {
        evaluate(profile, generation);
        return;
    }
    let Some(url) = NSURL::URLWithString(&NSString::from_str(&origin)) else {
        fail_running(profile);
        return;
    };
    let request = NSURLRequest::requestWithURL(&url);
    unsafe {
        view.loadSimulatedRequest_responseHTMLString(&request, &NSString::from_str(BLANK_PAGE));
    }
}

fn loaded(profile: &str, url: &str) {
    let generation = READERS.with(|readers| {
        let mut readers = readers.borrow_mut();
        let reader = readers.get_mut(profile)?;
        let job = reader.running.as_ref()?;
        (job.origin == url).then(|| {
            reader.loaded = Some(url.to_owned());
            reader.generation
        })
    });
    if let Some(generation) = generation {
        evaluate(profile, generation);
    }
}

fn evaluate(profile: &str, generation: u64) {
    let found = READERS.with(|readers| {
        let readers = readers.borrow();
        let reader = readers.get(profile)?;
        let job = reader.running.as_ref()?;
        Some((reader.view.clone(), job.script.clone()))
    });
    let Some((view, script)) = found else {
        return;
    };
    let mtm = match MainThreadMarker::new() {
        Some(mtm) => mtm,
        None => return,
    };
    let owner = profile.to_owned();
    let block = RcBlock::new(move |value: *mut AnyObject, _error: *mut NSError| {
        let text = unsafe { value.as_ref() }
            .and_then(|v| v.downcast_ref::<NSString>())
            .map(|s| s.to_string());
        let job = READERS.with(|readers| {
            let mut readers = readers.borrow_mut();
            let reader = readers.get_mut(&owner)?;
            (reader.generation == generation)
                .then(|| reader.running.take())
                .flatten()
        });
        if let Some(job) = job {
            let _ = job.done.send(text);
            run_next(&owner);
        }
    });
    unsafe {
        view.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
            &NSString::from_str(&script),
            None,
            None,
            &WKContentWorld::pageWorld(mtm),
            Some(&block),
        );
    }
}

fn fail_running(profile: &str) {
    let job = READERS.with(|readers| {
        let mut readers = readers.borrow_mut();
        let reader = readers.get_mut(profile)?;
        reader.loaded = None;
        reader.running.take()
    });
    if let Some(job) = job {
        let _ = job.done.send(None);
        run_next(profile);
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn native_classes_match_their_protocols() {
        use objc2::ClassType as _;
        crate::webkit::native_audit::assert_conforms(
            super::ReaderDelegate::class(),
            &[c"WKNavigationDelegate"],
        );
    }

    use super::*;

    #[test]
    fn storage_scripts_embed_their_arguments_as_json() {
        let change = StorageChange {
            set: vec![("k".into(), "v\"x".into())],
            remove: vec!["gone".into()],
        };
        let script = write_script(&change);
        assert!(script.contains(r#"JSON.parse("[[\"k\",\"v\\\"x\"]]")"#));
        assert!(script.contains(r#"JSON.parse("[\"gone\"]")"#));
        assert!(read_script().contains("const limit = 2000000;"));
        assert_eq!(
            root_url("https://a.com/x?y").as_deref(),
            Some("https://a.com/")
        );
        assert_eq!(root_url("ftp://a.com"), None);
    }
}
