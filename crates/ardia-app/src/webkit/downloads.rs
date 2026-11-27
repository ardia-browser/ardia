use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Value, json};

pub const ID_PREFIX: &str = "wk-download-";
pub const STAGING_PREFIX: &str = ".ardia-download-";

pub type Reporter = Arc<dyn Fn(String, Value) + Send + Sync>;
pub type Answer = Box<dyn FnOnce(Option<PathBuf>, bool) + Send>;
pub type Resolver = Arc<dyn Fn(String, Answer) + Send + Sync>;

#[derive(Clone)]
struct Services {
    report: Reporter,
    resolve: Resolver,
}

fn services() -> &'static Mutex<Option<Services>> {
    static SERVICES: OnceLock<Mutex<Option<Services>>> = OnceLock::new();
    SERVICES.get_or_init(|| Mutex::new(None))
}

pub fn install(report: Reporter, resolve: Resolver) {
    if let Ok(mut slot) = services().lock() {
        *slot = Some(Services { report, resolve });
    }
}

fn current() -> Option<Services> {
    services().lock().ok().and_then(|s| s.clone())
}

pub fn handles(id: &str) -> bool {
    id.starts_with(ID_PREFIX)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Running,
    Pausing,
    Paused,
    Resuming,
    Finished,
    Failed,
    Cancelled,
}

impl Phase {
    pub fn is_done(self) -> bool {
        matches!(self, Phase::Finished | Phase::Failed | Phase::Cancelled)
    }

    pub fn is_paused(self) -> bool {
        matches!(self, Phase::Pausing | Phase::Paused | Phase::Resuming)
    }

    pub fn state(self) -> &'static str {
        match self {
            Phase::Running | Phase::Pausing | Phase::Paused | Phase::Resuming => "downloading",
            Phase::Finished => "finished",
            Phase::Failed => "failed",
            Phase::Cancelled => "cancelled",
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn report_json(
    id: &str,
    url: &str,
    filename: &str,
    path: &str,
    phase: Phase,
    received: i64,
    total: i64,
    speed: f64,
    mime_type: &str,
    profile: &str,
    staging: Option<&str>,
    start_time: f64,
) -> Value {
    json!({
        "id": id, "url": url, "filename": filename, "path": path, "state": phase.state(),
        "paused": phase.is_paused(), "received": received as f64, "total": total as f64,
        "speed": speed, "mimeType": mime_type, "profile": profile, "offTheRecord": false,
        "staging": staging, "startTime": start_time,
    })
}

pub fn placed_candidates(final_path: &std::path::Path) -> impl Iterator<Item = PathBuf> + '_ {
    let stem = final_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = final_path
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let folder = final_path.parent().map(PathBuf::from).unwrap_or_default();
    (0..=9999).map(move |n| {
        let name = if n == 0 {
            final_path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        folder.join(name)
    })
}

pub fn quarantine_url(url: &str) -> Option<String> {
    let mut parsed = url::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https" | "ftp") {
        return None;
    }
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    Some(parsed.to_string())
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::ffi::{CString, c_void};
    use std::os::unix::ffi::OsStrExt as _;
    use std::path::{Path, PathBuf};
    use std::time::Instant;

    use block2::RcBlock;
    use objc2::rc::{Retained, Weak};
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
    use objc2::{MainThreadMarker, MainThreadOnly, Message as _, define_class, msg_send, sel};
    use objc2_foundation::{NSString, NSURL};
    use objc2_web_kit::WKWebView;

    use super::*;

    struct Item {
        uuid: String,
        download: Option<Retained<AnyObject>>,
        progress: Option<Retained<AnyObject>>,
        web: Option<Weak<WKWebView>>,
        url: String,
        referrer: Option<String>,
        profile: String,
        private: bool,
        phase: Phase,
        filename: String,
        path: String,
        final_path: Option<PathBuf>,
        staging: Option<PathBuf>,
        received: i64,
        total: i64,
        speed: f64,
        mime_type: String,
        resume_data: Option<Retained<AnyObject>>,
        sampled_at: Instant,
        sampled_bytes: i64,
        reported_at: Option<Instant>,
        started: f64,
    }

    impl Item {
        fn id(&self) -> String {
            format!("{ID_PREFIX}{}", self.uuid)
        }

        fn staging_file(&self) -> Option<PathBuf> {
            self.staging.as_ref().map(|s| {
                s.join(if self.filename.is_empty() {
                    "download"
                } else {
                    &self.filename
                })
            })
        }
    }

    struct MainOnly<T>(T);

    unsafe impl<T> Send for MainOnly<T> {}

    impl<T> MainOnly<T> {
        fn into_inner(self) -> T {
            self.0
        }
    }

    thread_local! {
        static ITEMS: RefCell<HashMap<String, Item>> = RefCell::new(HashMap::new());
        static DELEGATE: RefCell<Option<Retained<DownloadDelegate>>> = const { RefCell::new(None) };
        static TICK_QUEUED: Cell<bool> = const { Cell::new(false) };
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArdiaGpuiWebKitDownloads"]
        pub struct DownloadDelegate;

        unsafe impl NSObjectProtocol for DownloadDelegate {}

        impl DownloadDelegate {
            #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
            fn decide(
                &self,
                download: &AnyObject,
                response: &AnyObject,
                suggested: &NSString,
                handler: &block2::DynBlock<dyn Fn(*mut NSURL)>,
            ) {
                let handler = handler.copy();
                decide_destination(download, response, &suggested.to_string(), handler);
            }

            #[unsafe(method(downloadDidFinish:))]
            fn finished(&self, download: &AnyObject) {
                did_finish(download);
            }

            #[unsafe(method(download:didFailWithError:resumeData:))]
            fn failed(&self, download: &AnyObject, error: &AnyObject, resume: Option<&AnyObject>) {
                did_fail(download, error, resume);
            }

            #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
            fn observe(
                &self,
                _key: Option<&NSString>,
                _object: Option<&AnyObject>,
                _change: Option<&AnyObject>,
                _context: *mut c_void,
            ) {
                if TICK_QUEUED.with(|q| q.replace(true)) {
                    return;
                }
                unsafe {
                    let _: () = msg_send![
                        self,
                        performSelectorOnMainThread: sel!(ardiaDownloadTick),
                        withObject: None::<&AnyObject>,
                        waitUntilDone: false
                    ];
                }
            }

            #[unsafe(method(ardiaDownloadTick))]
            fn tick(&self) {
                TICK_QUEUED.with(|q| q.set(false));
                progress_tick();
            }
        }
    );

    fn delegate() -> Option<Retained<DownloadDelegate>> {
        let mtm = MainThreadMarker::new()?;
        Some(DELEGATE.with(|d| {
            d.borrow_mut()
                .get_or_insert_with(|| {
                    let this = DownloadDelegate::alloc(mtm).set_ivars(());
                    unsafe { msg_send![super(this), init] }
                })
                .clone()
        }))
    }

    fn same(a: &AnyObject, b: &AnyObject) -> bool {
        std::ptr::eq(a, b)
    }

    fn key_of(download: &AnyObject) -> Option<String> {
        ITEMS.with(|items| {
            items
                .borrow()
                .iter()
                .find(|(_, item)| item.download.as_deref().is_some_and(|d| same(d, download)))
                .map(|(k, _)| k.clone())
        })
    }

    fn with_item<R>(key: &str, run: impl FnOnce(&mut Item) -> R) -> Option<R> {
        ITEMS.with(|items| items.borrow_mut().get_mut(key).map(run))
    }

    fn report(key: &str) {
        let Some((profile, payload)) = with_item(key, |item| {
            (
                item.profile.clone(),
                report_json(
                    &item.id(),
                    &item.url,
                    &item.filename,
                    &item.path,
                    item.phase,
                    item.received,
                    item.total,
                    item.speed,
                    &item.mime_type,
                    &item.profile,
                    item.staging.as_ref().and_then(|s| s.to_str()),
                    item.started,
                ),
            )
        }) else {
            return;
        };
        if let Some(services) = current() {
            (services.report)(profile, payload);
        }
    }

    fn url_string(url: Option<Retained<NSURL>>) -> String {
        url.and_then(|u| u.absoluteString())
            .map(|s| s.to_string())
            .unwrap_or_default()
    }

    fn attach(key: &str, download: &AnyObject) {
        let Some(delegate) = delegate() else {
            return;
        };
        unsafe {
            let _: () = msg_send![download, setDelegate: &*delegate];
        }
        let progress: Option<Retained<AnyObject>> = unsafe { msg_send![download, progress] };
        if let Some(progress) = &progress {
            unsafe {
                let _: () = msg_send![
                    &**progress,
                    addObserver: &*delegate,
                    forKeyPath: &*NSString::from_str("completedUnitCount"),
                    options: 1usize,
                    context: std::ptr::null_mut::<c_void>()
                ];
            }
        }
        with_item(key, |item| {
            item.download = Some(download.retain());
            item.progress = progress;
        });
    }

    fn detach(key: &str) {
        let Some(delegate) = delegate() else {
            return;
        };
        with_item(key, |item| {
            if let Some(progress) = item.progress.take() {
                unsafe {
                    let _: () = msg_send![
                        &*progress,
                        removeObserver: &*delegate,
                        forKeyPath: &*NSString::from_str("completedUnitCount")
                    ];
                }
            }
            item.download = None;
        });
    }

    pub fn adopt(download: &AnyObject, profile: &str, private: bool, web: &WKWebView) {
        let request: Option<Retained<AnyObject>> = unsafe { msg_send![download, originalRequest] };
        let url = request
            .as_ref()
            .map(|r| {
                let u: Option<Retained<NSURL>> = unsafe { msg_send![&**r, URL] };
                url_string(u)
            })
            .unwrap_or_default();
        let referrer = unsafe { web.backForwardList().currentItem() }
            .and_then(|item| unsafe { item.URL() }.absoluteString())
            .map(|s| s.to_string());
        let uuid = objc2_foundation::NSUUID::new().UUIDString().to_string();
        let key = format!("{ID_PREFIX}{uuid}");
        let item = Item {
            uuid,
            download: None,
            progress: None,
            web: Some(Weak::from_retained(&web.retain())),
            url,
            referrer,
            profile: profile.to_owned(),
            private,
            phase: Phase::Running,
            filename: String::new(),
            path: String::new(),
            final_path: None,
            staging: None,
            received: 0,
            total: 0,
            speed: 0.0,
            mime_type: String::new(),
            resume_data: None,
            sampled_at: Instant::now(),
            sampled_bytes: 0,
            reported_at: None,
            started: super::super::certs::now_seconds() * 1000.0,
        };
        ITEMS.with(|items| items.borrow_mut().insert(key.clone(), item));
        attach(&key, download);
    }

    fn progress_tick() {
        let keys: Vec<String> = ITEMS.with(|items| items.borrow().keys().cloned().collect());
        for key in keys {
            let due = with_item(&key, |item| {
                if item.phase != Phase::Running {
                    return false;
                }
                let Some(progress) = &item.progress else {
                    return false;
                };
                let done: i64 = unsafe { msg_send![&**progress, completedUnitCount] };
                let total: i64 = unsafe { msg_send![&**progress, totalUnitCount] };
                item.received = done;
                item.total = total.max(0);
                let elapsed = item.sampled_at.elapsed().as_secs_f64();
                if elapsed >= 0.5 {
                    item.speed = (item.received - item.sampled_bytes) as f64 / elapsed;
                    item.sampled_at = Instant::now();
                    item.sampled_bytes = item.received;
                }
                let due = item
                    .reported_at
                    .is_none_or(|at| at.elapsed().as_secs_f64() >= 0.25);
                if due {
                    item.reported_at = Some(Instant::now());
                }
                due
            })
            .unwrap_or(false);
            if due {
                report(&key);
            }
        }
    }

    fn make_staging(folder: &Path, uuid: &str) -> Option<PathBuf> {
        let staging = folder.join(format!("{STAGING_PREFIX}{uuid}"));
        let raw = CString::new(staging.as_os_str().as_bytes()).ok()?;
        (unsafe { libc::mkdir(raw.as_ptr(), 0o700) } == 0).then_some(staging)
    }

    fn drop_staging(key: &str) {
        if let Some(Some(staging)) = with_item(key, |item| item.staging.take()) {
            let _ = std::fs::remove_dir_all(staging);
        }
    }

    fn file_url(path: &Path) -> Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
    }

    fn background() -> bool {
        std::env::var("ARDIA_BACKGROUND").is_ok_and(|v| !v.is_empty() && v != "0")
    }

    fn decide_destination(
        download: &AnyObject,
        response: &AnyObject,
        suggested: &str,
        handler: RcBlock<dyn Fn(*mut NSURL)>,
    ) {
        let Some(key) = key_of(download) else {
            handler.call((std::ptr::null_mut(),));
            return;
        };
        if let Some(Some(file)) = with_item(&key, |item| item.staging_file()) {
            let _ = std::fs::remove_file(&file);
            with_item(&key, |item| item.path = file.to_string_lossy().into_owned());
            report(&key);
            handler.call((Retained::as_ptr(&file_url(&file)).cast_mut(),));
            return;
        }
        let response_name: Option<Retained<NSString>> =
            unsafe { msg_send![response, suggestedFilename] };
        let fallback_name = response_name
            .as_ref()
            .map(|n| n.to_string())
            .unwrap_or_else(|| "download".into());
        let name = super::super::page_text::safe_download_name(if suggested.is_empty() {
            &fallback_name
        } else {
            suggested
        });
        let mime: Option<Retained<NSString>> = unsafe { msg_send![response, MIMEType] };
        let expected: i64 = unsafe { msg_send![response, expectedContentLength] };
        let profile = with_item(&key, |item| {
            item.mime_type = mime.map(|m| m.to_string()).unwrap_or_default();
            item.total = expected.max(0);
            item.profile.clone()
        })
        .unwrap_or_default();
        let fallback = downloads_folder();
        let accept = move |target: Option<PathBuf>, replacing: bool| {
            let _ = replacing;
            let done = with_item(&key, |item| item.phase.is_done()).unwrap_or(true);
            if done {
                handler.call((std::ptr::null_mut(),));
                return;
            }
            let uuid = with_item(&key, |item| item.uuid.clone()).unwrap_or_default();
            let staging = target
                .as_ref()
                .and_then(|t| t.parent().and_then(|folder| make_staging(folder, &uuid)));
            let (Some(target), Some(staging)) = (target.clone(), staging) else {
                with_item(&key, |item| {
                    item.phase = if target.is_none() {
                        Phase::Cancelled
                    } else {
                        Phase::Failed
                    }
                });
                report(&key);
                handler.call((std::ptr::null_mut(),));
                return;
            };
            let filename = target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "download".into());
            let file = staging.join(&filename);
            with_item(&key, |item| {
                item.final_path = Some(target.clone());
                item.staging = Some(staging.clone());
                item.filename = filename.clone();
                item.path = file.to_string_lossy().into_owned();
            });
            report(&key);
            handler.call((Retained::as_ptr(&file_url(&file)).cast_mut(),));
        };
        let Some(services) = current() else {
            accept(Some(fallback.join(&name)), false);
            return;
        };
        let name_for_panel = name;
        let accept = MainOnly(accept);
        (services.resolve)(
            profile,
            Box::new(move |folder, ask| {
                let accept = accept.into_inner();
                let folder = folder.unwrap_or(fallback);
                if !ask || background() {
                    accept(Some(folder.join(&name_for_panel)), false);
                } else {
                    ask_where(
                        folder,
                        name_for_panel,
                        Box::new(move |chosen| accept(chosen, true)),
                    );
                }
            }),
        );
    }

    fn downloads_folder() -> PathBuf {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join("Downloads")
    }

    fn ask_where(folder: PathBuf, name: String, done: Box<dyn FnOnce(Option<PathBuf>)>) {
        unsafe {
            let panel: Retained<AnyObject> = msg_send![objc2::class!(NSSavePanel), savePanel];
            let _: () = msg_send![&*panel, setDirectoryURL: &*file_url(&folder)];
            let _: () = msg_send![&*panel, setNameFieldStringValue: &*NSString::from_str(&name)];
            let keep = panel.clone();
            let done = RefCell::new(Some(done));
            let block = RcBlock::new(move |response: isize| {
                let chosen = (response == 1)
                    .then(|| {
                        let url: Option<Retained<NSURL>> = msg_send![&*keep, URL];
                        url.and_then(|u| u.path())
                            .map(|p| PathBuf::from(p.to_string()))
                    })
                    .flatten();
                if let Some(done) = done.borrow_mut().take() {
                    done(chosen);
                }
            });
            let _: () = msg_send![&*panel, beginWithCompletionHandler: &*block];
        }
    }

    fn place(file: &Path, final_path: &Path) -> Option<PathBuf> {
        let from = CString::new(file.as_os_str().as_bytes()).ok()?;
        for candidate in placed_candidates(final_path) {
            let to = CString::new(candidate.as_os_str().as_bytes()).ok()?;
            if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } == 0 {
                return Some(candidate);
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
                return None;
            }
        }
        None
    }

    fn mark_downloaded(file: &Path, source: &str, referrer: Option<&str>, private: bool) {
        let origins: Vec<String> = if private {
            Vec::new()
        } else {
            [Some(source), referrer]
                .into_iter()
                .flatten()
                .filter_map(quarantine_url)
                .collect()
        };
        unsafe {
            let properties: Retained<AnyObject> =
                msg_send![objc2::class!(NSMutableDictionary), dictionary];
            let set = |key: &str, value: &AnyObject| {
                let _: () =
                    msg_send![&*properties, setObject: value, forKey: &*NSString::from_str(key)];
            };
            let bundle: Retained<AnyObject> = msg_send![objc2::class!(NSBundle), mainBundle];
            let name: Option<Retained<NSString>> = msg_send![
                &*bundle,
                objectForInfoDictionaryKey: &*NSString::from_str("CFBundleName")
            ];
            let name = name.unwrap_or_else(|| NSString::from_str("Ardia"));
            set("LSQuarantineAgentName", &name);
            set(
                "LSQuarantineType",
                &NSString::from_str("LSQuarantineTypeWebDownload"),
            );
            let now: Retained<AnyObject> = msg_send![objc2::class!(NSDate), date];
            set("LSQuarantineTimeStamp", &now);
            let identifier: Option<Retained<NSString>> = msg_send![&*bundle, bundleIdentifier];
            if let Some(identifier) = identifier {
                set("LSQuarantineAgentBundleIdentifier", &identifier);
            }
            if let Some(first) = origins
                .first()
                .and_then(|o| NSURL::URLWithString(&NSString::from_str(o)))
            {
                set("LSQuarantineDataURL", &first);
            }
            if let Some(second) = origins
                .get(1)
                .and_then(|o| NSURL::URLWithString(&NSString::from_str(o)))
            {
                set("LSQuarantineOriginURL", &second);
            }
            let url = file_url(file);
            let ok: bool = msg_send![
                &*url,
                setResourceValue: &*properties,
                forKey: &*NSString::from_str("NSURLQuarantinePropertiesKey"),
                error: std::ptr::null_mut::<*mut AnyObject>()
            ];
            if !ok {
                log::info!("[webkit] quarantine not set on a download");
            }
            if origins.is_empty() {
                return;
            }
            let list: Retained<AnyObject> = msg_send![objc2::class!(NSMutableArray), array];
            for origin in &origins {
                let _: () = msg_send![&*list, addObject: &*NSString::from_str(origin)];
            }
            let data: Option<Retained<AnyObject>> = msg_send![
                objc2::class!(NSPropertyListSerialization),
                dataWithPropertyList: &*list,
                format: 200usize,
                options: 0usize,
                error: std::ptr::null_mut::<*mut AnyObject>()
            ];
            let Some(data) = data else {
                return;
            };
            let bytes: *const c_void = msg_send![&*data, bytes];
            let length: usize = msg_send![&*data, length];
            let (Ok(path), Ok(name)) = (
                CString::new(file.as_os_str().as_bytes()),
                CString::new("com.apple.metadata:kMDItemWhereFroms"),
            ) else {
                return;
            };
            libc::setxattr(
                path.as_ptr(),
                name.as_ptr(),
                bytes,
                length,
                0,
                libc::XATTR_NOFOLLOW,
            );
        }
    }

    fn did_finish(download: &AnyObject) {
        let Some(key) = key_of(download) else {
            return;
        };
        detach(&key);
        let snapshot = with_item(&key, |item| {
            (
                item.staging_file(),
                item.final_path.clone(),
                item.url.clone(),
                item.referrer.clone(),
                item.private,
            )
        });
        if let Some((Some(file), Some(final_path), url, referrer, private)) = snapshot {
            mark_downloaded(&file, &url, referrer.as_deref(), private);
            let placed = place(&file, &final_path);
            with_item(&key, |item| match &placed {
                Some(placed) => {
                    item.path = placed.to_string_lossy().into_owned();
                    item.filename = placed
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    item.phase = Phase::Finished;
                    if let Ok(meta) = std::fs::metadata(placed) {
                        item.received = meta.len() as i64;
                        item.total = meta.len() as i64;
                    }
                }
                None => item.phase = Phase::Failed,
            });
            if let Some(placed) = &placed {
                mark_downloaded(placed, &url, referrer.as_deref(), private);
            }
        } else {
            with_item(&key, |item| item.phase = Phase::Failed);
        }
        drop_staging(&key);
        report(&key);
    }

    fn did_fail(download: &AnyObject, error: &AnyObject, resume: Option<&AnyObject>) {
        let Some(key) = key_of(download) else {
            return;
        };
        detach(&key);
        let code: isize = unsafe { msg_send![error, code] };
        let drop = with_item(&key, |item| match item.phase {
            Phase::Pausing | Phase::Paused => {
                if let Some(resume) = resume {
                    item.resume_data = Some(resume.retain());
                }
                item.phase = Phase::Paused;
                false
            }
            Phase::Finished | Phase::Failed | Phase::Cancelled => false,
            Phase::Running | Phase::Resuming => {
                item.phase = if code == -999 {
                    Phase::Cancelled
                } else {
                    Phase::Failed
                };
                true
            }
        })
        .unwrap_or(false);
        if drop {
            drop_staging(&key);
        }
        report(&key);
    }

    pub fn command(action: &str, id: &str) {
        let Some(phase) = with_item(id, |item| item.phase) else {
            return;
        };
        match action {
            "cancel" => {
                if phase.is_done() {
                    return;
                }
                let download = with_item(id, |item| {
                    item.phase = Phase::Cancelled;
                    item.resume_data = None;
                    item.download.clone()
                })
                .flatten();
                detach(id);
                report(id);
                match download {
                    Some(download) => {
                        let key = id.to_owned();
                        let block = RcBlock::new(move |_: *mut AnyObject| {
                            let key = key.clone();
                            drop_staging(&key);
                        });
                        unsafe {
                            let _: () = msg_send![&*download, cancel: &*block];
                        }
                    }
                    None => drop_staging(id),
                }
            }
            "pause" => {
                if phase != Phase::Running {
                    return;
                }
                let Some(download) = with_item(id, |item| item.download.clone()).flatten() else {
                    return;
                };
                with_item(id, |item| item.phase = Phase::Pausing);
                report(id);
                let key = id.to_owned();
                let block = RcBlock::new(move |data: *mut AnyObject| {
                    with_item(&key, |item| {
                        if !data.is_null() {
                            item.resume_data = unsafe { Retained::retain(data) };
                        }
                        if item.phase == Phase::Pausing {
                            item.phase = Phase::Paused;
                        }
                    });
                    detach(&key);
                });
                unsafe {
                    let _: () = msg_send![&*download, cancel: &*block];
                }
            }
            "resume" => {
                if phase != Phase::Paused {
                    return;
                }
                let (data, web) = with_item(id, |item| {
                    (
                        item.resume_data.take(),
                        item.web.as_ref().and_then(Weak::load),
                    )
                })
                .unwrap_or((None, None));
                let (Some(data), Some(web)) = (data, web) else {
                    with_item(id, |item| item.phase = Phase::Failed);
                    drop_staging(id);
                    report(id);
                    return;
                };
                with_item(id, |item| item.phase = Phase::Resuming);
                let key = id.to_owned();
                let block = RcBlock::new(move |download: *mut AnyObject| {
                    let Some(download) = (unsafe { download.as_ref() }) else {
                        return;
                    };
                    let resuming =
                        with_item(&key, |item| item.phase == Phase::Resuming).unwrap_or(false);
                    if !resuming {
                        unsafe {
                            let _: () = msg_send![download, cancel: std::ptr::null::<AnyObject>()];
                        }
                        return;
                    }
                    with_item(&key, |item| {
                        item.phase = Phase::Running;
                        item.sampled_at = Instant::now();
                        item.sampled_bytes = item.received;
                    });
                    attach(&key, download);
                    report(&key);
                });
                unsafe {
                    let _: () = msg_send![&*web, resumeDownloadFromResumeData: &*data, completionHandler: &*block];
                }
            }
            _ => {}
        }
    }

    pub fn count() -> usize {
        ITEMS.with(|items| items.borrow().len())
    }
}

#[cfg(target_os = "macos")]
pub use mac::{adopt, command, count};

#[cfg(not(target_os = "macos"))]
pub fn command(_: &str, _: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn count() -> usize {
    0
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn native_classes_match_their_protocols() {
        use objc2::ClassType as _;
        crate::webkit::native_audit::assert_signatures(
            super::mac::DownloadDelegate::class(),
            &[
                (
                    "download:decideDestinationUsingResponse:suggestedFilename:completionHandler:",
                    "v@:@@@@?",
                ),
                ("downloadDidFinish:", "v@:@"),
                ("download:didFailWithError:resumeData:", "v@:@@@"),
                (
                    "observeValueForKeyPath:ofObject:change:context:",
                    "v@:@@@^v",
                ),
            ],
        );
    }

    use super::*;

    #[test]
    fn download_reports_and_names() {
        let value = report_json(
            "wk-download-1",
            "https://a.com/f.zip",
            "f.zip",
            "/tmp/f.zip",
            Phase::Paused,
            5,
            10,
            1.0,
            "application/zip",
            "",
            None,
            0.0,
        );
        assert_eq!(value["state"], "downloading");
        assert_eq!(value["paused"], true);
        assert!(handles("wk-download-x"));
        let names: Vec<PathBuf> = placed_candidates(std::path::Path::new("/d/a.txt"))
            .take(3)
            .collect();
        assert_eq!(
            names,
            vec![
                PathBuf::from("/d/a.txt"),
                PathBuf::from("/d/a (1).txt"),
                PathBuf::from("/d/a (2).txt")
            ]
        );
        assert_eq!(
            quarantine_url("https://u:p@a.com/x").as_deref(),
            Some("https://a.com/x")
        );
        assert_eq!(quarantine_url("data:text/plain,x"), None);
    }
}
