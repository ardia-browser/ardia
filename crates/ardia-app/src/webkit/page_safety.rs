use std::collections::{HashSet, VecDeque};
use std::rc::Rc;

use objc2::Message as _;
use std::path::PathBuf;
use std::sync::{Mutex as SafetyMutex, OnceLock as SafetyOnce};

use crate::webkit::page_events::PageEvent;
use crate::webkit::page_text::{self as text, Interstitial};
use crate::webkit::{certs, downloads};

type Answered = Box<dyn FnOnce(isize, Option<String>)>;
type Cancelled = Box<dyn FnOnce()>;

struct DialogRequest {
    title: String,
    message: String,
    buttons: Vec<&'static str>,
    field: Option<String>,
    offers_suppression: bool,
    answered: Answered,
    cancelled: Cancelled,
}

struct ShownDialog {
    settled: Rc<Cell<bool>>,
    cancelled: Rc<RefCell<Option<Cancelled>>>,
    sheet: Option<Retained<AnyObject>>,
}

struct HeldBlocked {
    id: String,
    url: String,
    background: bool,
    item: usize,
}

#[derive(Default)]
struct Safety {
    private: bool,
    waiting: VecDeque<DialogRequest>,
    shown: Option<ShownDialog>,
    script_dialogs: usize,
    suppressed: bool,
    retry_queued: bool,
    showing_error: bool,
    error_url: Option<String>,
    error_title: String,
    token: String,
    interstitial: Option<Interstitial>,
    trust_check: u64,
    popups: Vec<HeldBlocked>,
    last_popup: u64,
    pending_hsts: Option<(String, String)>,
}

type ExternalGrant = (String, String, String);
type PendingExternal = (String, Option<ExternalGrant>);

thread_local! {
    static SAFETY: RefCell<HashMap<usize, Safety>> = RefCell::new(HashMap::new());
    static PENDING_EXTERNAL: RefCell<HashMap<String, PendingExternal>> = RefCell::new(HashMap::new());
    static EXTERNAL_GRANTS: RefCell<HashSet<ExternalGrant>> = RefCell::new(HashSet::new());
    static NEXT_EXTERNAL: Cell<u64> = const { Cell::new(0) };
    static NEXT_TRUST: Cell<u64> = const { Cell::new(0) };
    static HISTORY_DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    static PUMP: RefCell<Option<Retained<MainPump>>> = const { RefCell::new(None) };
}

type MainJob = Box<dyn FnOnce() + Send>;

fn main_jobs() -> &'static SafetyMutex<Vec<MainJob>> {
    static JOBS: SafetyOnce<SafetyMutex<Vec<MainJob>>> = SafetyOnce::new();
    JOBS.get_or_init(|| SafetyMutex::new(Vec::new()))
}

fn pump_pointer() -> &'static SafetyMutex<usize> {
    static POINTER: SafetyOnce<SafetyMutex<usize>> = SafetyOnce::new();
    POINTER.get_or_init(|| SafetyMutex::new(0))
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "ArdiaGpuiWebKitMainPump"]
    struct MainPump;

    unsafe impl NSObjectProtocol for MainPump {}

    impl MainPump {
        #[unsafe(method(ardiaRunJobs))]
        fn run_jobs(&self) {
            let jobs: Vec<MainJob> = main_jobs()
                .lock()
                .map(|mut jobs| std::mem::take(&mut *jobs))
                .unwrap_or_default();
            for job in jobs {
                job();
            }
        }
    }
);

fn ensure_pump() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    PUMP.with(|pump| {
        let mut pump = pump.borrow_mut();
        if pump.is_none() {
            let this = MainPump::alloc(mtm).set_ivars(());
            let made: Retained<MainPump> = unsafe { msg_send![super(this), init] };
            if let Ok(mut pointer) = pump_pointer().lock() {
                *pointer = Retained::as_ptr(&made) as usize;
            }
            *pump = Some(made);
        }
    });
}

fn on_main(job: MainJob) {
    let pointer = pump_pointer().lock().map(|p| *p).unwrap_or(0);
    if pointer == 0 {
        return;
    }
    if let Ok(mut jobs) = main_jobs().lock() {
        jobs.push(job);
    }
    let target = pointer as *const AnyObject;
    unsafe {
        let _: () = msg_send![
            &*target,
            performSelectorOnMainThread: sel!(ardiaRunJobs),
            withObject: None::<&AnyObject>,
            waitUntilDone: false
        ];
    }
}

fn key(delegate: &PageDelegate) -> usize {
    delegate as *const PageDelegate as usize
}

fn with_safety<R>(delegate: &PageDelegate, run: impl FnOnce(&mut Safety) -> R) -> R {
    SAFETY.with(|map| run(map.borrow_mut().entry(key(delegate)).or_default()))
}

fn forget_safety(delegate: &PageDelegate) {
    cancel_dialogs(delegate);
    SAFETY.with(|map| map.borrow_mut().remove(&key(delegate)));
}

fn set_private(delegate: &PageDelegate, private: bool) {
    ensure_pump();
    with_safety(delegate, |s| s.private = private);
}

fn store_key(delegate: &PageDelegate) -> (String, bool) {
    let profile = delegate.ivars().profile.borrow().clone();
    let private = with_safety(delegate, |s| s.private);
    if private {
        (format!("private@{}", private_base(&profile)), true)
    } else {
        (profile, false)
    }
}

fn foremost_window(delegate: &PageDelegate) -> Option<Retained<AnyObject>> {
    let web = delegate.web()?;
    if delegate.ivars().tab.borrow().is_none() {
        return None;
    }
    let hidden: bool = unsafe { msg_send![&*web, isHidden] };
    if hidden {
        return None;
    }
    unsafe { msg_send![&*web, window] }
}

fn ns(text: &str) -> Retained<NSString> {
    NSString::from_str(text)
}

fn frame_host(frame: &WKFrameInfo) -> String {
    unsafe { frame.securityOrigin().host() }.to_string()
}

fn present_script(delegate: &PageDelegate, request: DialogRequest) {
    let blocked = with_safety(delegate, |s| s.suppressed) || background();
    if blocked {
        (request.cancelled)();
        return;
    }
    let offers_suppression = with_safety(delegate, |s| {
        s.script_dialogs += 1;
        s.script_dialogs > 1
    });
    present_dialog(delegate, request, offers_suppression);
}

fn present_dialog(delegate: &PageDelegate, request: DialogRequest, offers_suppression: bool) {
    let full = with_safety(delegate, |s| s.waiting.len() >= text::MAX_WAITING_DIALOGS);
    if full {
        (request.cancelled)();
        return;
    }
    with_safety(delegate, |s| {
        s.waiting.push_back(DialogRequest {
            offers_suppression,
            ..request
        })
    });
    show_next_dialog(delegate);
}

fn retry_dialogs_later(delegate: &PageDelegate) {
    let queued = with_safety(delegate, |s| std::mem::replace(&mut s.retry_queued, true));
    if queued {
        return;
    }
    unsafe {
        let _: () = msg_send![
            delegate,
            performSelector: sel!(ardiaShowNextDialog),
            withObject: None::<&AnyObject>,
            afterDelay: 0.5f64
        ];
    }
}

fn show_next_dialog(delegate: &PageDelegate) {
    with_safety(delegate, |s| s.retry_queued = false);
    let busy = with_safety(delegate, |s| s.shown.is_some() || s.waiting.is_empty());
    if busy {
        return;
    }
    let Some(window) = foremost_window(delegate) else {
        retry_dialogs_later(delegate);
        return;
    };
    let Some(request) = with_safety(delegate, |s| s.waiting.pop_front()) else {
        return;
    };
    let offers = request.offers_suppression;
    let settled = Rc::new(Cell::new(false));
    let cancelled = Rc::new(RefCell::new(Some(request.cancelled)));
    with_safety(delegate, |s| {
        s.shown = Some(ShownDialog {
            settled: settled.clone(),
            cancelled: cancelled.clone(),
            sheet: None,
        })
    });
    let me: Retained<PageDelegate> = delegate.retain();
    unsafe {
        let alert: Retained<AnyObject> = msg_send![objc2::class!(NSAlert), new];
        let _: () = msg_send![&*alert, setMessageText: &*ns(&request.title)];
        let _: () = msg_send![&*alert, setInformativeText: &*ns(&request.message)];
        for title in &request.buttons {
            let _: Retained<AnyObject> = msg_send![&*alert, addButtonWithTitle: &*ns(title)];
        }
        let field: Option<Retained<AnyObject>> = request.field.as_ref().map(|value| {
            let field: Retained<AnyObject> = msg_send![objc2::class!(NSTextField), new];
            let _: () = msg_send![
                &*field,
                setFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(260.0, 24.0))
            ];
            let _: () = msg_send![&*field, setStringValue: &*ns(value)];
            let _: () = msg_send![&*alert, setAccessoryView: &*field];
            let alert_window: Retained<AnyObject> = msg_send![&*alert, window];
            let _: () = msg_send![&*alert_window, setInitialFirstResponder: &*field];
            field
        });
        if offers {
            let _: () = msg_send![&*alert, setShowsSuppressionButton: true];
            let button: Option<Retained<AnyObject>> = msg_send![&*alert, suppressionButton];
            if let Some(button) = button {
                let _: () = msg_send![&*button, setTitle: &*ns(text::SUPPRESS_DIALOGS)];
            }
        }
        let answered = RefCell::new(Some(request.answered));
        let keep_alert = alert.clone();
        let block = RcBlock::new(move |response: isize| {
            if settled.replace(true) {
                return;
            }
            with_safety(&me, |s| s.shown = None);
            if offers {
                let button: Option<Retained<AnyObject>> =
                    msg_send![&*keep_alert, suppressionButton];
                let on: isize = button.map(|b| msg_send![&*b, state]).unwrap_or(0);
                if on == 1 {
                    with_safety(&me, |s| s.suppressed = true);
                }
            }
            let value = field.as_ref().map(|f| {
                let value: Retained<NSString> = msg_send![&**f, stringValue];
                value.to_string()
            });
            if let Some(answered) = answered.borrow_mut().take() {
                answered(response, value);
            }
            let _: () = msg_send![
                &*me,
                performSelector: sel!(ardiaShowNextDialog),
                withObject: None::<&AnyObject>,
                afterDelay: 0.0f64
            ];
        });
        let _: () =
            msg_send![&*alert, beginSheetModalForWindow: &*window, completionHandler: &*block];
        let sheet: Retained<AnyObject> = msg_send![&*alert, window];
        with_safety(delegate, |s| {
            if let Some(shown) = s.shown.as_mut() {
                shown.sheet = Some(sheet);
            }
        });
    }
}

fn cancel_dialogs(delegate: &PageDelegate) {
    let (dropped, shown) = with_safety(delegate, |s| {
        (std::mem::take(&mut s.waiting), s.shown.take())
    });
    for request in dropped {
        (request.cancelled)();
    }
    let Some(shown) = shown else {
        return;
    };
    if let Some(sheet) = &shown.sheet {
        unsafe {
            let parent: Option<Retained<AnyObject>> = msg_send![&**sheet, sheetParent];
            if let Some(parent) = parent {
                let _: () = msg_send![&*parent, endSheet: &**sheet, returnCode: -1001isize];
            }
        }
    }
    if !shown.settled.replace(true)
        && let Some(cancel) = shown.cancelled.borrow_mut().take()
    {
        cancel();
    }
}

fn page_changed(delegate: &PageDelegate) {
    cancel_dialogs(delegate);
    with_safety(delegate, |s| {
        s.script_dialogs = 0;
        s.suppressed = false;
    });
}

fn script_alert(
    delegate: &PageDelegate,
    message: &str,
    frame: &WKFrameInfo,
    handler: RcBlock<dyn Fn()>,
) {
    let title = text::sheet_title(&frame_host(frame));
    let message = text::elided_message(message);
    if foremost_window(delegate).is_none() {
        handler.call(());
        if with_safety(delegate, |s| s.suppressed) || background() {
            return;
        }
        present_script(
            delegate,
            DialogRequest {
                title,
                message,
                buttons: vec!["OK"],
                field: None,
                offers_suppression: false,
                answered: Box::new(|_, _| {}),
                cancelled: Box::new(|| {}),
            },
        );
        return;
    }
    let once = Rc::new(handler);
    let again = once.clone();
    present_script(
        delegate,
        DialogRequest {
            title,
            message,
            buttons: vec!["OK"],
            field: None,
            offers_suppression: false,
            answered: Box::new(move |_, _| once.call(())),
            cancelled: Box::new(move || again.call(())),
        },
    );
}

fn script_confirm(
    delegate: &PageDelegate,
    message: &str,
    frame: &WKFrameInfo,
    handler: RcBlock<dyn Fn(Bool)>,
) {
    if foremost_window(delegate).is_none() {
        handler.call((Bool::NO,));
        return;
    }
    let once = Rc::new(handler);
    let again = once.clone();
    present_script(
        delegate,
        DialogRequest {
            title: text::sheet_title(&frame_host(frame)),
            message: text::elided_message(message),
            buttons: vec!["OK", "Cancel"],
            field: None,
            offers_suppression: false,
            answered: Box::new(move |response, _| once.call((Bool::new(response == 1000),))),
            cancelled: Box::new(move || again.call((Bool::NO,))),
        },
    );
}

fn script_prompt(
    delegate: &PageDelegate,
    message: &str,
    default: Option<&NSString>,
    frame: &WKFrameInfo,
    handler: RcBlock<dyn Fn(*mut NSString)>,
) {
    if foremost_window(delegate).is_none() {
        handler.call((std::ptr::null_mut(),));
        return;
    }
    let once = Rc::new(handler);
    let again = once.clone();
    let initial = text::elided_prompt_text(&default.map(|d| d.to_string()).unwrap_or_default());
    present_script(
        delegate,
        DialogRequest {
            title: text::sheet_title(&frame_host(frame)),
            message: text::elided_message(message),
            buttons: vec!["OK", "Cancel"],
            field: Some(initial),
            offers_suppression: false,
            answered: Box::new(move |response, value| {
                let answer = (response == 1000).then(|| ns(&value.unwrap_or_default()));
                match answer {
                    Some(answer) => once.call((Retained::as_ptr(&answer).cast_mut(),)),
                    None => once.call((std::ptr::null_mut(),)),
                }
            }),
            cancelled: Box::new(move || again.call((std::ptr::null_mut(),))),
        },
    );
}

fn origin_of_frame(frame: &WKFrameInfo) -> Option<String> {
    let origin = unsafe { frame.securityOrigin() };
    let host = unsafe { origin.host() }.to_string();
    if host.is_empty() {
        return None;
    }
    let scheme = unsafe { origin.protocol() }.to_string();
    let port = unsafe { origin.port() };
    let default = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        _ => 0,
    };
    Some(if port == 0 || port as i64 == default {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}:{port}")
    })
}

fn app_for(url: &NSURL) -> Option<(String, String)> {
    unsafe {
        let workspace: Retained<AnyObject> = msg_send![objc2::class!(NSWorkspace), sharedWorkspace];
        let app: Option<Retained<NSURL>> = msg_send![&*workspace, URLForApplicationToOpenURL: url];
        let path = app?.path()?.to_string();
        let manager: Retained<AnyObject> = msg_send![objc2::class!(NSFileManager), defaultManager];
        let display: Retained<NSString> = msg_send![&*manager, displayNameAtPath: &*ns(&path)];
        let name = display.to_string();
        let name = name.strip_suffix(".app").unwrap_or(&name).to_owned();
        Some((name, path))
    }
}

fn icon_data_url(app_path: &str) -> Option<String> {
    unsafe {
        let workspace: Retained<AnyObject> = msg_send![objc2::class!(NSWorkspace), sharedWorkspace];
        let icon: Retained<AnyObject> = msg_send![&*workspace, iconForFile: &*ns(app_path)];
        let _: () = msg_send![&*icon, setSize: NSSize::new(64.0, 64.0)];
        let tiff: Option<Retained<AnyObject>> = msg_send![&*icon, TIFFRepresentation];
        let rep: Option<Retained<AnyObject>> =
            msg_send![objc2::class!(NSBitmapImageRep), imageRepWithData: &*tiff?];
        let empty: Retained<AnyObject> = msg_send![objc2::class!(NSDictionary), dictionary];
        let png: Option<Retained<AnyObject>> =
            msg_send![&*rep?, representationUsingType: 4usize, properties: &*empty];
        let png = png?;
        let bytes: *const c_void = msg_send![&*png, bytes];
        let bytes = bytes.cast::<u8>();
        let length: usize = msg_send![&*png, length];
        if bytes.is_null() {
            return None;
        }
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(std::slice::from_raw_parts(bytes, length));
        Some(format!("data:image/png;base64,{encoded}"))
    }
}

fn open_external(url: &str) {
    if background() {
        log::info!("[webkit] external URL (background mode, not opened)");
        return;
    }
    let Some(target) = NSURL::URLWithString(&ns(url)) else {
        return;
    };
    unsafe {
        let workspace: Retained<AnyObject> = msg_send![objc2::class!(NSWorkspace), sharedWorkspace];
        let _: bool = msg_send![&*workspace, openURL: &*target];
    }
}

fn external_request(delegate: &PageDelegate, url: &NSURL, text_url: &str, origin: Option<String>) {
    let scheme = url
        .scheme()
        .map(|s| s.to_string().to_lowercase())
        .unwrap_or_default();
    if scheme.is_empty() || text::BLOCKED_SCHEMES.contains(&scheme.as_str()) {
        log::info!("[webkit] refused a link to the {scheme}: scheme");
        return;
    }
    let app = app_for(url);
    let (store, private) = store_key(delegate);
    let trusted = origin.as_deref().is_some_and(text::is_trustworthy);
    let rememberable = match (&app, &origin) {
        (Some((name, _)), Some(origin)) if trusted && !private => {
            Some((store, origin.clone(), scheme.clone(), name.clone()))
        }
        _ => None,
    };
    if let Some((store, origin, scheme, _)) = &rememberable
        && EXTERNAL_GRANTS.with(|g| {
            g.borrow()
                .contains(&(store.clone(), origin.clone(), scheme.clone()))
        })
    {
        open_external(text_url);
        return;
    }
    let id = NEXT_EXTERNAL.with(|n| {
        let next = n.get() + 1;
        n.set(next);
        format!("wk-external-{next}")
    });
    if app.is_some() {
        PENDING_EXTERNAL.with(|p| {
            let mut p = p.borrow_mut();
            if p.len() >= 50 {
                p.clear();
            }
            p.insert(
                id.clone(),
                (
                    text_url.to_owned(),
                    rememberable.clone().map(|(s, o, k, _)| (s, o, k)),
                ),
            );
        });
    }
    let icon = app.as_ref().and_then(|(_, path)| icon_data_url(path));
    let request = text::external_app_request(&text::ExternalApp {
        id: &id,
        url: text_url,
        scheme: &scheme,
        origin: origin.as_deref(),
        app: app.as_ref().map(|(n, _)| n.as_str()),
        app_path: app.as_ref().map(|(_, p)| p.as_str()),
        icon: icon.as_deref(),
        rememberable: rememberable.is_some(),
    });
    delegate.emit(WebKitEvent::Page(PageEvent::ExternalApp(request)));
}

pub fn resolve_external(id: &str, open: bool, remember: bool) {
    let Some((url, rememberable)) = PENDING_EXTERNAL.with(|p| p.borrow_mut().remove(id)) else {
        return;
    };
    if !open {
        return;
    }
    if remember && let Some(grant) = rememberable {
        EXTERNAL_GRANTS.with(|g| g.borrow_mut().insert(grant));
    }
    open_external(&url);
}

fn current_item(web: &WKWebView) -> usize {
    unsafe { web.backForwardList().currentItem() }
        .map(|item| Retained::as_ptr(&item) as usize)
        .unwrap_or(0)
}

fn popup_origin(web: &WKWebView) -> Option<String> {
    text::origin_of(&current_url(web))
}

fn popups_allowed(delegate: &PageDelegate, web: &WKWebView) -> bool {
    let profile = delegate.ivars().profile.borrow().clone();
    popup_origin(web).is_some_and(|origin| {
        crate::webkit::site_answers::answer(&profile, &origin, crate::webkit::site_answers::POPUPS)
            == Some(true)
    })
}

fn block_popup(delegate: &PageDelegate, web: &WKWebView, url: String, background: bool) {
    let item = current_item(web);
    let id = with_safety(delegate, |s| {
        s.last_popup += 1;
        let id = s.last_popup.to_string();
        s.popups.retain(|p| p.item == item);
        s.popups.push(HeldBlocked {
            id: id.clone(),
            url: url.clone(),
            background,
            item,
        });
        if s.popups.len() > text::BLOCKED_POPUPS_KEPT {
            s.popups.remove(0);
        }
        id
    });
    let origin = popup_origin(web).unwrap_or_default();
    delegate.emit(WebKitEvent::Page(PageEvent::PopupBlocked {
        id,
        url,
        origin,
    }));
}

pub fn open_blocked(tab: &TabId, popup_id: &str, always: bool) -> bool {
    let Some((web, delegate)) = with_page(tab, |p| (p.web.clone(), p.delegate.clone())) else {
        return false;
    };
    let item = current_item(&web);
    let popup = with_safety(&delegate, |s| {
        let at = s
            .popups
            .iter()
            .position(|p| p.id == popup_id && p.item == item)?;
        Some(s.popups.remove(at))
    });
    let Some(popup) = popup else {
        return false;
    };
    if always && let Some(origin) = popup_origin(&web) {
        let profile = delegate.ivars().profile.borrow().clone();
        crate::webkit::site_answers::note(
            &profile,
            &origin,
            crate::webkit::site_answers::POPUPS,
            Some(true),
        );
    }
    delegate.emit(WebKitEvent::OpenUrl {
        url: popup.url,
        background: popup.background,
    });
    true
}

fn new_token(delegate: &PageDelegate) -> String {
    let token = objc2_foundation::NSUUID::new().UUIDString().to_string();
    with_safety(delegate, |s| s.token = token.clone());
    token
}

fn page_color() -> Option<String> {
    None
}

fn show_error_page(
    delegate: &PageDelegate,
    web: &WKWebView,
    domain: &str,
    code: i64,
    failing: &str,
) {
    let host = url::Url::parse(failing)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| failing.to_owned());
    let token = new_token(delegate);
    let page = text::error_page(
        failing,
        &host,
        domain,
        code,
        page_color().as_deref(),
        &token,
    );
    with_safety(delegate, |s| {
        s.showing_error = true;
        s.error_url = Some(failing.to_owned());
        s.interstitial = None;
        s.error_title = page.title.clone();
    });
    let base = NSURL::URLWithString(&ns(failing));
    unsafe {
        let _: Option<Retained<AnyObject>> =
            msg_send![web, loadHTMLString: &*ns(&page.html), baseURL: base.as_deref()];
    }
}

fn error_parts(error: &NSError) -> (String, i64, Option<String>) {
    let domain = error.domain().to_string();
    let code = error.code() as i64;
    let failing = unsafe {
        let info: Retained<AnyObject> = msg_send![error, userInfo];
        let url: Option<Retained<AnyObject>> =
            msg_send![&*info, objectForKey: &*ns("NSErrorFailingURLKey")];
        url.and_then(|u| {
            let text: Option<Retained<NSString>> = msg_send![&*u, absoluteString];
            text.map(|t| t.to_string())
        })
    };
    (domain, code, failing)
}

fn peer_trust(error: &NSError) -> Option<usize> {
    unsafe {
        let info: Retained<AnyObject> = msg_send![error, userInfo];
        let trust: *mut AnyObject =
            msg_send![&*info, objectForKey: &*ns("NSURLErrorFailingURLPeerTrustErrorKey")];
        if trust.is_null()
            || security::CFGetTypeID(trust as *const c_void) != security::SecTrustGetTypeID()
        {
            return None;
        }
        Some(security::CFRetain(trust as *const c_void) as usize)
    }
}

fn load_failed(delegate: &PageDelegate, web: &WKWebView, error: &NSError, committed: bool) {
    let (domain, code, failing) = error_parts(error);
    let failing = failing.unwrap_or_else(|| current_url(web));
    if text::is_cancelled(&domain, code) || committed || failing.is_empty() {
        delegate.queue_navigation();
        return;
    }
    with_safety(delegate, |s| s.pending_hsts = None);
    if show_certificate_interstitial(delegate, web, error, &domain, code, &failing) {
        return;
    }
    show_error_page(delegate, web, &domain, code, &failing);
    delegate.queue_navigation();
}

fn show_certificate_interstitial(
    delegate: &PageDelegate,
    web: &WKWebView,
    error: &NSError,
    domain: &str,
    code: i64,
    failing: &str,
) -> bool {
    let host = url::Url::parse(failing)
        .ok()
        .filter(|u| u.scheme() == "https")
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    if !text::is_certificate_failure(domain, code) || host.is_empty() {
        return false;
    }
    let fallback = text::certificate_fallback(code);
    let Some(trust) = peer_trust(error) else {
        if fallback.is_empty() {
            return false;
        }
        present_interstitial(delegate, web, failing, &host, fallback, None, None);
        return true;
    };
    let check = NEXT_TRUST.with(|n| {
        let next = n.get() + 1;
        n.set(next);
        next
    });
    with_safety(delegate, |s| {
        s.trust_check = check;
        s.interstitial = None;
        s.error_url = Some(failing.to_owned());
        s.showing_error = true;
    });
    let Some(tab) = delegate.ivars().tab.borrow().clone() else {
        unsafe { security::CFRelease(trust as *const c_void) };
        return false;
    };
    let failing = failing.to_owned();
    let domain = domain.to_owned();
    let spawned = std::thread::Builder::new()
        .name("ardia-webkit-trust".into())
        .spawn(move || {
            let evaluated = security::evaluate(trust);
            let certificate = security::certificate_info(trust);
            let fingerprint = security::fingerprint(trust);
            on_main(Box::new(move || {
                let page = with_page(&tab, |p| (p.web.clone(), p.delegate.clone()));
                let Some((web, delegate)) = page else {
                    return;
                };
                let current = with_safety(&delegate, |s| {
                    s.trust_check == check
                        && s.showing_error
                        && s.error_url.as_deref() == Some(failing.as_str())
                });
                if !current {
                    return;
                }
                with_safety(&delegate, |s| s.trust_check = 0);
                let errors = if evaluated.is_empty() {
                    fallback
                } else {
                    evaluated
                };
                if errors.is_empty() {
                    show_error_page(&delegate, &web, &domain, code, &failing);
                    delegate.queue_navigation();
                    return;
                }
                present_interstitial(
                    &delegate,
                    &web,
                    &failing,
                    &host,
                    errors,
                    fingerprint,
                    certificate,
                );
            }));
            unsafe { security::CFRelease(trust as *const c_void) };
        });
    spawned.is_ok()
}

fn now_ms() -> f64 {
    certs::now_seconds() * 1000.0
}

fn clock_text() -> String {
    unsafe {
        let formatter: Retained<AnyObject> = msg_send![objc2::class!(NSDateFormatter), new];
        let _: () = msg_send![&*formatter, setDateStyle: 4usize];
        let _: () = msg_send![&*formatter, setTimeStyle: 0usize];
        let now: Retained<AnyObject> = msg_send![objc2::class!(NSDate), date];
        let text: Retained<NSString> = msg_send![&*formatter, stringFromDate: &*now];
        text.to_string()
    }
}

#[allow(clippy::too_many_arguments)]
fn present_interstitial(
    delegate: &PageDelegate,
    web: &WKWebView,
    url: &str,
    host: &str,
    errors: Vec<String>,
    fingerprint: Option<String>,
    certificate: Option<serde_json::Value>,
) {
    let (store, private) = store_key(delegate);
    let strict = certs::requires_secure_transport(host, &store, private);
    let overridable = fingerprint.is_some() && certs::overridable(&errors) && !strict;
    let blocked = Interstitial {
        url: url.to_owned(),
        host: host.to_owned(),
        errors,
        fingerprint,
        overridable,
        strict_transport: strict,
        certificate,
    };
    let token = new_token(delegate);
    let html = text::interstitial_page(&blocked, &token, now_ms(), &clock_text());
    with_safety(delegate, |s| {
        s.interstitial = Some(blocked);
        s.error_title = "Privacy error".into();
        s.error_url = Some(url.to_owned());
        s.showing_error = true;
    });
    let base = NSURL::URLWithString(&ns(url));
    unsafe {
        let _: Option<Retained<AnyObject>> =
            msg_send![web, loadHTMLString: &*ns(&html), baseURL: base.as_deref()];
    }
    emit_security(delegate);
    delegate.queue_navigation();
}

fn page_action(
    delegate: &PageDelegate,
    web: &WKWebView,
    action: &WKNavigationAction,
    url: &str,
) -> bool {
    if !url.starts_with(&format!("{}:", text::PAGE_ACTION_SCHEME)) {
        return false;
    }
    let source_main = unsafe { action.sourceFrame() }
        .as_ref()
        .is_some_and(|f| unsafe { f.isMainFrame() });
    let (showing, token) = with_safety(delegate, |s| (s.showing_error, s.token.clone()));
    let Some((name, given)) = text::page_action_parts(url) else {
        return true;
    };
    if !source_main || !showing || given != token || !user_initiated(action) {
        return true;
    }
    match name.as_str() {
        "reload" => {
            reload_error(delegate, web);
        }
        "back" => leave_interstitial(delegate, web),
        "proceed" => proceed_through_interstitial(delegate, web),
        _ => {}
    }
    true
}

fn reload_error(delegate: &PageDelegate, web: &WKWebView) -> bool {
    let target = with_safety(delegate, |s| {
        s.showing_error.then(|| s.error_url.clone()).flatten()
    });
    let Some(target) = target else {
        return false;
    };
    with_safety(delegate, |s| s.showing_error = false);
    start_loading(web, &target);
    true
}

fn leave_interstitial(delegate: &PageDelegate, web: &WKWebView) {
    if unsafe { web.canGoBack() } {
        unsafe { web.goBack() };
        return;
    }
    with_safety(delegate, |s| {
        s.interstitial = None;
        s.showing_error = false;
    });
    start_loading(web, "about:blank");
}

fn proceed_through_interstitial(delegate: &PageDelegate, web: &WKWebView) {
    let Some(blocked) = with_safety(delegate, |s| s.interstitial.clone()) else {
        return;
    };
    let Some(print) = blocked.fingerprint.clone().filter(|_| blocked.overridable) else {
        return;
    };
    let (store, private) = store_key(delegate);
    certs::allow(&store, private, &blocked.host, &print, &blocked.errors);
    with_safety(delegate, |s| {
        s.interstitial = None;
        s.showing_error = false;
    });
    start_loading(web, &blocked.url);
}

fn adjust_snapshot(delegate: &PageDelegate, nav: &mut WebKitNavigation) {
    let (showing, title) = with_safety(delegate, |s| (s.showing_error, s.error_title.clone()));
    if showing {
        nav.title = title;
        nav.committed_url = String::new();
        nav.theme_color = None;
    }
}

fn provisional_started(delegate: &PageDelegate, web: &WKWebView) {
    let url = current_url(web);
    with_safety(delegate, |s| {
        s.pending_hsts = None;
        if s.showing_error && s.error_url.as_deref() != Some(url.as_str()) {
            s.showing_error = false;
        }
    });
}

fn committed(delegate: &PageDelegate, web: &WKWebView) {
    page_changed(delegate);
    let item = current_item(web);
    with_safety(delegate, |s| {
        if !s.showing_error {
            s.error_url = None;
            s.interstitial = None;
        }
        s.popups.retain(|p| p.item == item);
    });
    record_transport_security(delegate, web);
    emit_security(delegate);
    schedule_history_save(delegate);
}

fn note_response(delegate: &PageDelegate, response: &AnyObject, main: bool) {
    if !main {
        return;
    }
    with_safety(delegate, |s| s.pending_hsts = None);
    unsafe {
        let http: bool = msg_send![response, isKindOfClass: objc2::class!(NSHTTPURLResponse)];
        if !http {
            return;
        }
        let url: Option<Retained<NSURL>> = msg_send![response, URL];
        let Some(url) = url else {
            return;
        };
        if url
            .scheme()
            .map(|s| s.to_string().to_lowercase())
            .as_deref()
            != Some("https")
        {
            return;
        }
        let Some(host) = url.host().map(|h| h.to_string()) else {
            return;
        };
        let header: Option<Retained<NSString>> =
            msg_send![response, valueForHTTPHeaderField: &*ns("Strict-Transport-Security")];
        if let Some(header) = header {
            with_safety(delegate, |s| {
                s.pending_hsts = Some((host, header.to_string()))
            });
        }
    }
}

#[repr(C)]
pub struct OpaqueSecTrust {
    _private: [u8; 0],
}

unsafe impl objc2::encode::RefEncode for OpaqueSecTrust {
    const ENCODING_REF: objc2::encode::Encoding =
        objc2::encode::Encoding::Pointer(&objc2::encode::Encoding::Struct("__SecTrust", &[]));
}

fn server_trust(web: &WKWebView) -> Option<usize> {
    let trust: *const OpaqueSecTrust = unsafe { msg_send![web, serverTrust] };
    (!trust.is_null()).then_some(trust as usize)
}

fn record_transport_security(delegate: &PageDelegate, web: &WKWebView) {
    let Some((host, header)) = with_safety(delegate, |s| s.pending_hsts.take()) else {
        return;
    };
    let url = current_url(web);
    let Some(current) = url::Url::parse(&url)
        .ok()
        .filter(|u| u.scheme() == "https")
        .and_then(|u| u.host_str().map(str::to_owned))
    else {
        return;
    };
    if certs::normalized_host(&current) != certs::normalized_host(&host) {
        return;
    }
    let fingerprint = server_trust(web).and_then(security::fingerprint);
    let (store, private) = store_key(delegate);
    certs::note_transport_security(&store, private, &header, &current, fingerprint.as_deref());
}

fn security_info(delegate: &PageDelegate, web: &WKWebView) -> serde_json::Value {
    use serde_json::json;
    let url = current_url(web);
    let parsed = url::Url::parse(&url).ok();
    let scheme = parsed
        .as_ref()
        .map(|u| u.scheme().to_owned())
        .unwrap_or_default();
    let origin = if matches!(scheme.as_str(), "http" | "https") {
        text::origin_of(&url)
    } else {
        None
    };
    let mut info = json!({ "url": url, "origin": origin });
    let (showing, interstitial) =
        with_safety(delegate, |s| (s.showing_error, s.interstitial.clone()));
    if showing {
        match interstitial.filter(|_| scheme == "https") {
            Some(blocked) => {
                info["level"] = json!("certificateError");
                info["certificateErrors"] = json!(blocked.errors);
                info["mixedContent"] = serde_json::Value::Null;
                info["isEV"] = json!(false);
                if let Some(certificate) = blocked.certificate {
                    info["certificate"] = certificate;
                }
            }
            None => {
                info["level"] = json!(if scheme == "http" { "insecure" } else { "none" });
            }
        }
        return info;
    }
    match scheme.as_str() {
        "https" => {
            let trust = server_trust(web);
            let host = parsed
                .as_ref()
                .and_then(|u| u.host_str())
                .unwrap_or("")
                .to_lowercase();
            let print = trust.and_then(security::fingerprint);
            let (store, private) = store_key(delegate);
            let bypassed = if host.is_empty() {
                Vec::new()
            } else {
                certs::bypassed_errors(&store, private, &host, print.as_deref())
                    .or_else(|| {
                        print
                            .is_none()
                            .then(|| certs::bypassed_errors(&store, private, &host, None))
                            .flatten()
                    })
                    .map(|errors| {
                        if errors.is_empty() {
                            vec!["invalid".to_owned()]
                        } else {
                            errors
                        }
                    })
                    .unwrap_or_default()
            };
            let secure_only = unsafe { web.hasOnlySecureContent() };
            info["level"] = json!(if !bypassed.is_empty() {
                "certificateError"
            } else if secure_only {
                "secure"
            } else {
                "mixed"
            });
            info["mixedContent"] = if secure_only {
                serde_json::Value::Null
            } else {
                json!("displayed")
            };
            info["isEV"] =
                json!(bypassed.is_empty() && trust.is_some_and(security::extended_validation));
            info["certificateErrors"] = json!(bypassed);
            if let Some(certificate) = trust.and_then(security::certificate_info) {
                info["certificate"] = certificate;
            }
        }
        "http" => info["level"] = json!("insecure"),
        "file" => info["level"] = json!("local"),
        _ => info["level"] = json!("none"),
    }
    info
}

fn emit_security(delegate: &PageDelegate) {
    if let Some(web) = delegate.web() {
        let info = security_info(delegate, &web);
        delegate.emit(WebKitEvent::Page(PageEvent::Security(info)));
    }
}

fn apply_https_policy(action: &WKNavigationAction, preferences: &WKWebpagePreferences, main: bool) {
    if !main {
        return;
    }
    let Some(url) = (unsafe { action.request() }).URL() else {
        return;
    };
    if url
        .scheme()
        .map(|s| s.to_string().to_lowercase())
        .as_deref()
        != Some("http")
    {
        return;
    }
    let Some(host) = url.host().map(|h| h.to_string().to_lowercase()) else {
        return;
    };
    let port: Option<Retained<AnyObject>> = unsafe { msg_send![&*url, port] };
    let port = port.map(|p| unsafe { msg_send![&*p, unsignedShortValue] });
    let responds: bool = unsafe {
        msg_send![preferences, respondsToSelector: sel!(setPreferredHTTPSNavigationPolicy:)]
    };
    if !responds {
        return;
    }
    let policy: isize = if text::upgrades_to_https(&host, port) {
        1
    } else {
        0
    };
    unsafe {
        let _: () = msg_send![preferences, setPreferredHTTPSNavigationPolicy: policy];
    }
}

fn answer_challenge(
    delegate: &PageDelegate,
    challenge: &AnyObject,
    handler: RcBlock<dyn Fn(isize, *mut AnyObject)>,
) {
    let default =
        |handler: &RcBlock<dyn Fn(isize, *mut AnyObject)>| handler.call((1, std::ptr::null_mut()));
    unsafe {
        let space: Option<Retained<AnyObject>> =
            msg_send![challenge, performSelector: sel!(protectionSpace)];
        let Some(space) = space else {
            return default(&handler);
        };
        let method: Retained<NSString> = msg_send![&*space, authenticationMethod];
        if method.to_string() != "NSURLAuthenticationMethodServerTrust" {
            return default(&handler);
        }
        let trust: *const OpaqueSecTrust = msg_send![&*space, serverTrust];
        let host: Retained<NSString> = msg_send![&*space, host];
        let host = host.to_string();
        let (store, private) = store_key(delegate);
        let print = (!trust.is_null())
            .then(|| security::fingerprint(trust as usize))
            .flatten();
        let (false, Some(print)) = (trust.is_null(), print) else {
            return default(&handler);
        };
        if !certs::has_exception(&store, private, &host) {
            return default(&handler);
        }
        let retained = security::CFRetain(trust.cast()) as usize;
        let holder = ThreadBound(handler);
        let spawned = std::thread::Builder::new()
            .name("ardia-webkit-trust".into())
            .spawn(move || {
                let errors = security::evaluate(retained);
                on_main(Box::new(move || {
                    let handler = holder.into_inner();
                    let allowed = !errors.is_empty()
                        && certs::allows(&store, private, &host, &print, &errors);
                    if allowed {
                        let credential: Retained<AnyObject> = msg_send![
                            objc2::class!(NSURLCredential),
                            credentialForTrust: retained as *const OpaqueSecTrust
                        ];
                        handler.call((0, Retained::as_ptr(&credential).cast_mut()));
                    } else {
                        handler.call((1, std::ptr::null_mut()));
                    }
                    security::CFRelease(retained as *const c_void);
                }));
            });
        if spawned.is_err() {
            security::CFRelease(trust.cast());
        }
    }
}

struct ThreadBound<T>(T);

unsafe impl<T> Send for ThreadBound<T> {}

impl<T> ThreadBound<T> {
    fn into_inner(self) -> T {
        self.0
    }
}

fn adopt_download(delegate: &PageDelegate, web: &WKWebView, download: &AnyObject) {
    let (_, private) = store_key(delegate);
    let profile = delegate.ivars().profile.borrow().clone();
    downloads::adopt(download, &profile, private, web);
}

fn response_policy(response: &AnyObject, main: bool, can_show: bool) -> isize {
    let disposition: Option<String> = unsafe {
        let http: bool = msg_send![response, isKindOfClass: objc2::class!(NSHTTPURLResponse)];
        if http {
            let value: Option<Retained<NSString>> =
                msg_send![response, valueForHTTPHeaderField: &*ns("Content-Disposition")];
            value.map(|v| v.to_string())
        } else {
            None
        }
    };
    let attachment = text::content_disposition_attachment(disposition.as_deref());
    if !can_show || (attachment && main) {
        2
    } else {
        1
    }
}

pub fn flush_history() {
    let delegates: Vec<Retained<PageDelegate>> = PAGES.with(|pages| {
        pages
            .borrow()
            .values()
            .map(|page| page.delegate.clone())
            .collect()
    });
    for delegate in delegates {
        save_history_sync(&delegate);
    }
}

pub fn set_history_dir(dir: Option<PathBuf>) {
    HISTORY_DIR.with(|h| *h.borrow_mut() = dir);
}

fn history_folder(profile: &str) -> Option<PathBuf> {
    HISTORY_DIR.with(|h| h.borrow().clone()).map(|dir| {
        dir.join("WebKit Tab History")
            .join(format!("p{}", text::hex_upper(profile)))
    })
}

fn history_marker(folder: &std::path::Path, kind: &str) -> PathBuf {
    let name = folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    folder.with_file_name(format!("{name}.{kind}"))
}

fn restore_history(web: &WKWebView, delegate: &PageDelegate, spec: &PageSpec) -> bool {
    if spec.private || spec.url.is_empty() {
        return false;
    }
    let Some(folder) = history_folder(&spec.profile) else {
        return false;
    };
    if history_marker(&folder, "forgotten").exists() {
        return false;
    }
    let file = folder.join(text::hex_upper(spec.tab.as_str()));
    let Ok(data) = std::fs::read(&file) else {
        return false;
    };
    if data.len() > 32 * 1024 * 1024 {
        return false;
    }
    let Ok(saved) = serde_json::from_slice::<serde_json::Value>(&data) else {
        return false;
    };
    let epoch = std::fs::read_to_string(history_marker(&folder, "cleared")).ok();
    if saved.get("version").and_then(serde_json::Value::as_i64) != Some(1)
        || epoch.is_some_and(|e| {
            saved.get("epoch").and_then(serde_json::Value::as_str) != Some(e.as_str())
        })
    {
        return false;
    }
    let (Some(url), Some(state)) = (
        saved.get("url").and_then(serde_json::Value::as_str),
        saved.get("state").and_then(serde_json::Value::as_str),
    ) else {
        return false;
    };
    if !text::same_page(url, &spec.url) {
        return false;
    }
    use base64::Engine as _;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(state) else {
        return false;
    };
    let responds: bool = unsafe { msg_send![web, respondsToSelector: sel!(setInteractionState:)] };
    if !responds {
        return false;
    }
    unsafe {
        let data: Retained<AnyObject> = msg_send![
            objc2::class!(NSData),
            dataWithBytes: bytes.as_ptr().cast::<c_void>(),
            length: bytes.len()
        ];
        let _: () = msg_send![web, setInteractionState: &*data];
    }
    let restored = unsafe { web.backForwardList().currentItem() }.is_some();
    if !restored {
        start_loading(web, &spec.url);
    }
    let _ = delegate;
    true
}

fn schedule_history_save(delegate: &PageDelegate) {
    unsafe {
        let _: () = msg_send![
            objc2::class!(NSObject),
            cancelPreviousPerformRequestsWithTarget: delegate,
            selector: sel!(ardiaSaveHistory),
            object: None::<&AnyObject>
        ];
        let _: () = msg_send![
            delegate,
            performSelector: sel!(ardiaSaveHistory),
            withObject: None::<&AnyObject>,
            afterDelay: 2.5f64
        ];
    }
}

fn save_history_now(delegate: &PageDelegate) {
    if let Some((file, folder, body)) = history_snapshot(delegate) {
        let spawned = std::thread::Builder::new()
            .name("ardia-webkit-history".into())
            .spawn(move || write_history(&file, &folder, body));
        if let Err(problem) = spawned {
            log::debug!("WebKit history wasn't saved: {problem}");
        }
    }
}

fn save_history_sync(delegate: &PageDelegate) {
    unsafe {
        let _: () = msg_send![
            objc2::class!(NSObject),
            cancelPreviousPerformRequestsWithTarget: delegate,
            selector: sel!(ardiaSaveHistory),
            object: None::<&AnyObject>
        ];
    }
    if let Some((file, folder, body)) = history_snapshot(delegate) {
        write_history(&file, &folder, body);
    }
}

fn write_history(file: &std::path::Path, folder: &std::path::Path, mut body: serde_json::Value) {
    if history_marker(folder, "forgotten").exists() {
        return;
    }
    if let Ok(epoch) = std::fs::read_to_string(history_marker(folder, "cleared")) {
        body["epoch"] = serde_json::Value::String(epoch);
    }
    let Ok(data) = serde_json::to_vec(&body) else {
        return;
    };
    if data.len() > 32 * 1024 * 1024 {
        return;
    }
    let _ = std::fs::create_dir_all(folder);
    let partial = file.with_extension("partial");
    if std::fs::write(&partial, data).is_ok() {
        let _ = std::fs::rename(&partial, file);
    }
}

fn history_snapshot(delegate: &PageDelegate) -> Option<(PathBuf, PathBuf, serde_json::Value)> {
    let web = delegate.web()?;
    let tab = delegate.ivars().tab.borrow().clone()?;
    let (_, private) = store_key(delegate);
    if private {
        return None;
    }
    let profile = delegate.ivars().profile.borrow().clone();
    let folder = history_folder(&profile)?;
    let item = (unsafe { web.backForwardList().currentItem() })?;
    let url = unsafe { item.URL() }
        .absoluteString()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let responds: bool = unsafe { msg_send![&*web, respondsToSelector: sel!(interactionState)] };
    if !responds {
        return None;
    }
    let state: Option<Retained<AnyObject>> = unsafe { msg_send![&*web, interactionState] };
    let state = state?;
    let is_data: bool = unsafe { msg_send![&*state, isKindOfClass: objc2::class!(NSData)] };
    if !is_data {
        return None;
    }
    let bytes = unsafe {
        let pointer: *const c_void = msg_send![&*state, bytes];
        let pointer = pointer.cast::<u8>();
        let length: usize = msg_send![&*state, length];
        if pointer.is_null() {
            return None;
        }
        std::slice::from_raw_parts(pointer, length).to_vec()
    };
    let file = folder.join(text::hex_upper(tab.as_str()));
    use base64::Engine as _;
    let body = serde_json::json!({
        "version": 1,
        "url": url,
        "state": base64::engine::general_purpose::STANDARD.encode(&bytes),
    });
    Some((file, folder, body))
}

mod security {
    use std::ffi::c_void;

    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSString;
    use sha2::{Digest, Sha256};

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecTrustEvaluateWithError(trust: *const c_void, error: *mut *const c_void) -> bool;
        fn SecTrustCopyResult(trust: *const c_void) -> *const c_void;
        fn SecTrustGetCertificateCount(trust: *const c_void) -> isize;
        fn SecTrustGetCertificateAtIndex(trust: *const c_void, index: isize) -> *const c_void;
        fn SecCertificateCopyData(certificate: *const c_void) -> *const c_void;
        fn SecCertificateCopyValues(
            certificate: *const c_void,
            keys: *const c_void,
            error: *mut *const c_void,
        ) -> *const c_void;
        fn SecCertificateCopySerialNumberData(
            certificate: *const c_void,
            error: *mut *const c_void,
        ) -> *const c_void;
        pub fn SecTrustGetTypeID() -> usize;
        static kSecOIDX509V1SubjectName: *const c_void;
        static kSecOIDX509V1IssuerName: *const c_void;
        static kSecOIDX509V1ValidityNotBefore: *const c_void;
        static kSecOIDX509V1ValidityNotAfter: *const c_void;
        static kSecOIDCommonName: *const c_void;
        static kSecOIDOrganizationName: *const c_void;
        static kSecOIDOrganizationalUnitName: *const c_void;
        static kSecOIDCountryName: *const c_void;
        static kSecPropertyKeyValue: *const c_void;
        static kSecPropertyKeyLabel: *const c_void;
        static kSecTrustExtendedValidation: *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        pub fn CFRetain(value: *const c_void) -> *const c_void;
        pub fn CFRelease(value: *const c_void);
        pub fn CFGetTypeID(value: *const c_void) -> usize;
        fn CFArrayCreate(
            allocator: *const c_void,
            values: *const *const c_void,
            count: isize,
            callbacks: *const c_void,
        ) -> *const c_void;
        static kCFTypeArrayCallBacks: c_void;
    }

    fn object<'a>(pointer: *const c_void) -> Option<&'a AnyObject> {
        unsafe { (pointer as *const AnyObject).as_ref() }
    }

    fn get(dict: &AnyObject, key: *const c_void) -> Option<&AnyObject> {
        let key = object(key)?;
        let value: *mut AnyObject = unsafe { msg_send![dict, objectForKey: key] };
        unsafe { value.as_ref() }
    }

    fn string_of(value: &AnyObject) -> Option<String> {
        let is_string: bool = unsafe { msg_send![value, isKindOfClass: objc2::class!(NSString)] };
        is_string.then(|| unsafe { &*(value as *const AnyObject as *const NSString) }.to_string())
    }

    fn array_items(value: &AnyObject) -> Vec<&AnyObject> {
        let is_array: bool = unsafe { msg_send![value, isKindOfClass: objc2::class!(NSArray)] };
        if !is_array {
            return Vec::new();
        }
        let count: usize = unsafe { msg_send![value, count] };
        (0..count)
            .filter_map(|i| {
                let item: *mut AnyObject = unsafe { msg_send![value, objectAtIndex: i] };
                unsafe { item.as_ref() }
            })
            .collect()
    }

    fn leaf(trust: usize) -> Option<*const c_void> {
        let trust = trust as *const c_void;
        if unsafe { SecTrustGetCertificateCount(trust) } < 1 {
            return None;
        }
        let leaf = unsafe { SecTrustGetCertificateAtIndex(trust, 0) };
        (!leaf.is_null()).then_some(leaf)
    }

    fn data_bytes(data: *const c_void) -> Option<Vec<u8>> {
        let value = object(data)?;
        let pointer: *const c_void = unsafe { msg_send![value, bytes] };
        let pointer = pointer.cast::<u8>();
        let length: usize = unsafe { msg_send![value, length] };
        (!pointer.is_null())
            .then(|| unsafe { std::slice::from_raw_parts(pointer, length) }.to_vec())
    }

    pub fn fingerprint(trust: usize) -> Option<String> {
        let leaf = leaf(trust)?;
        let data = unsafe { SecCertificateCopyData(leaf) };
        if data.is_null() {
            return None;
        }
        let bytes = data_bytes(data);
        unsafe { CFRelease(data) };
        let digest = Sha256::digest(bytes?);
        Some(
            digest
                .iter()
                .map(|b| format!("{b:02X}"))
                .collect::<Vec<_>>()
                .join(":"),
        )
    }

    pub fn evaluate(trust: usize) -> Vec<String> {
        let pointer = trust as *const c_void;
        let trusted = unsafe { SecTrustEvaluateWithError(pointer, std::ptr::null_mut()) };
        if trusted {
            return Vec::new();
        }
        let result = unsafe { SecTrustCopyResult(pointer) };
        let mut failing = Vec::new();
        if let Some(dict) = object(result) {
            let details: *mut AnyObject = unsafe {
                msg_send![dict, objectForKey: &*NSString::from_str("TrustResultDetails")]
            };
            if let Some(details) = unsafe { details.as_ref() } {
                for entry in array_items(details) {
                    let keys: Retained<AnyObject> = unsafe { msg_send![entry, allKeys] };
                    for key in array_items(&keys) {
                        let value: *mut AnyObject = unsafe { msg_send![entry, objectForKey: key] };
                        let Some(value) = (unsafe { value.as_ref() }) else {
                            continue;
                        };
                        let number: bool =
                            unsafe { msg_send![value, isKindOfClass: objc2::class!(NSNumber)] };
                        let truthy: bool = number && unsafe { msg_send![value, boolValue] };
                        if number
                            && !truthy
                            && let Some(name) = string_of(key)
                        {
                            failing.push(name);
                        }
                    }
                }
            }
        }
        if !result.is_null() {
            unsafe { CFRelease(result) };
        }
        crate::webkit::page_text::error_names(&failing, true)
    }

    pub fn extended_validation(trust: usize) -> bool {
        let result = unsafe { SecTrustCopyResult(trust as *const c_void) };
        let ev = object(result)
            .and_then(|dict| get(dict, unsafe { kSecTrustExtendedValidation }))
            .is_some_and(|v| unsafe { msg_send![v, boolValue] });
        if !result.is_null() {
            unsafe { CFRelease(result) };
        }
        ev
    }

    pub fn certificate_info(trust: usize) -> Option<serde_json::Value> {
        use serde_json::json;
        let leaf = leaf(trust)?;
        let count = unsafe { SecTrustGetCertificateCount(trust as *const c_void) };
        let keys_list = unsafe {
            [
                kSecOIDX509V1SubjectName,
                kSecOIDX509V1IssuerName,
                kSecOIDX509V1ValidityNotBefore,
                kSecOIDX509V1ValidityNotAfter,
            ]
        };
        let keys = unsafe {
            CFArrayCreate(
                std::ptr::null(),
                keys_list.as_ptr(),
                keys_list.len() as isize,
                &kCFTypeArrayCallBacks as *const c_void,
            )
        };
        let values = unsafe { SecCertificateCopyValues(leaf, keys, std::ptr::null_mut()) };
        if !keys.is_null() {
            unsafe { CFRelease(keys) };
        }
        let dict = object(values);
        let principal = |oid: *const c_void| {
            let entries: Vec<&AnyObject> = dict
                .and_then(|d| get(d, oid))
                .and_then(|section| get(section, unsafe { kSecPropertyKeyValue }))
                .map(array_items)
                .unwrap_or_default();
            let field = |name: *const c_void| -> Vec<String> {
                let wanted = object(name).and_then(string_of).unwrap_or_default();
                entries
                    .iter()
                    .filter(|entry| {
                        get(entry, unsafe { kSecPropertyKeyLabel })
                            .and_then(string_of)
                            .is_some_and(|label| label == wanted)
                    })
                    .filter_map(|entry| {
                        get(entry, unsafe { kSecPropertyKeyValue }).and_then(string_of)
                    })
                    .collect()
            };
            let common = field(unsafe { kSecOIDCommonName })
                .into_iter()
                .next()
                .unwrap_or_default();
            let organizations = field(unsafe { kSecOIDOrganizationName });
            let display = if common.is_empty() {
                organizations
                    .first()
                    .cloned()
                    .or_else(|| {
                        field(unsafe { kSecOIDOrganizationalUnitName })
                            .into_iter()
                            .next()
                    })
                    .unwrap_or_default()
            } else {
                common.clone()
            };
            json!({
                "commonName": common,
                "displayName": display,
                "organizations": organizations,
                "country": field(unsafe { kSecOIDCountryName }).into_iter().next().unwrap_or_default(),
            })
        };
        let date = |oid: *const c_void| -> f64 {
            dict.and_then(|d| get(d, oid))
                .and_then(|section| get(section, unsafe { kSecPropertyKeyValue }))
                .map(|v| {
                    let seconds: f64 = unsafe { msg_send![v, doubleValue] };
                    (seconds + 978_307_200.0) * 1000.0
                })
                .unwrap_or(0.0)
        };
        let mut info = json!({
            "subject": principal(unsafe { kSecOIDX509V1SubjectName }),
            "issuer": principal(unsafe { kSecOIDX509V1IssuerName }),
            "validFrom": date(unsafe { kSecOIDX509V1ValidityNotBefore }),
            "validUntil": date(unsafe { kSecOIDX509V1ValidityNotAfter }),
            "chainLength": count,
        });
        if !values.is_null() {
            unsafe { CFRelease(values) };
        }
        if let Some(print) = fingerprint(trust) {
            info["sha256"] = json!(print);
        }
        let serial = unsafe { SecCertificateCopySerialNumberData(leaf, std::ptr::null_mut()) };
        if !serial.is_null() {
            if let Some(bytes) = data_bytes(serial) {
                info["serialNumber"] = json!(
                    bytes
                        .iter()
                        .map(|b| format!("{b:02X}"))
                        .collect::<Vec<_>>()
                        .join(":")
                );
            }
            unsafe { CFRelease(serial) };
        }
        Some(info)
    }
}
