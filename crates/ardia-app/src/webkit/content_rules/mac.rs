use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use block2::RcBlock;
use objc2::rc::{Retained, Weak};
use objc2::{MainThreadMarker, msg_send, sel};
use objc2_foundation::{NSArray, NSBundle, NSError, NSNumber, NSString, NSURL};
use objc2_web_kit::{
    WKContentRuleList, WKContentRuleListStore, WKUserContentController, WKWebpagePreferences,
};
use serde_json::{Value, json};

use super::extras::{CosmeticIndex, Extras, ScriptletSources, StrictBlock};
use super::scripts::Scripts;
use super::user_filters::{self, Bisect, RejectedUserFilters, UserFilters};
use super::{
    Bundled, FOLDER, Settings, assemble, complete_set, host_of, identifiers, key, note_change,
    read_settings, stale, trusted, wanted_rulesets, write_settings,
};

type Job = Box<dyn FnOnce() + Send>;
type Finish = Rc<dyn Fn(&Bisect, usize)>;
type Waiter = Rc<RefCell<Option<Box<dyn FnOnce()>>>>;
type ListSet = Vec<Retained<WKContentRuleList>>;
type ApplyStep = (Retained<WKUserContentController>, ListSet, ListSet);

#[repr(C)]
struct DispatchQueue {
    _opaque: [u8; 0],
}

unsafe extern "C" {
    static _dispatch_main_q: DispatchQueue;
    fn dispatch_async_f(
        queue: *const DispatchQueue,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
    fn dispatch_after_f(
        when: u64,
        queue: *const DispatchQueue,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
    fn dispatch_time(when: u64, delta: i64) -> u64;
}

extern "C" fn run_job(context: *mut c_void) {
    let job = unsafe { Box::from_raw(context.cast::<Job>()) };
    job();
}

fn on_main(job: impl FnOnce() + Send + 'static) {
    let boxed: Box<Job> = Box::new(Box::new(job));
    unsafe {
        dispatch_async_f(
            &raw const _dispatch_main_q,
            Box::into_raw(boxed).cast(),
            run_job,
        )
    };
}

fn on_main_after(seconds: f64, job: impl FnOnce() + Send + 'static) {
    let boxed: Box<Job> = Box::new(Box::new(job));
    let nanos = (seconds.max(0.0) * 1e9) as i64;
    unsafe {
        dispatch_after_f(
            dispatch_time(0, nanos),
            &raw const _dispatch_main_q,
            Box::into_raw(boxed).cast(),
            run_job,
        )
    };
}

struct SendBox<T>(T);
unsafe impl<T> Send for SendBox<T> {}

struct Applied {
    controller: Weak<WKUserContentController>,
    key: String,
    lists: Vec<Retained<WKContentRuleList>>,
}

#[derive(Default)]
struct Blocker {
    configured: bool,
    began: bool,
    loaded_settings: bool,
    base: Option<PathBuf>,
    rules_directory: Option<PathBuf>,
    bundled: Option<Bundled>,
    store: Option<Retained<WKContentRuleListStore>>,
    settings: Settings,
    lists: Vec<Retained<WKContentRuleList>>,
    lists_key: String,
    loading_key: Option<String>,
    desired_key: String,
    failed_key: Option<String>,
    ready: bool,
    waiters: Vec<Waiter>,
    last_compile_ms: f64,
    last_error: Option<String>,
    applied: Vec<Applied>,
    extras_key: String,
    extras: Option<Rc<Extras>>,
    active: Option<Rc<Extras>>,
    extras_ready: bool,
    strict_passes: HashMap<String, HashSet<String>>,
    scripts: Scripts,
    user: UserFilters,
    rejected_user: Option<RejectedUserFilters>,
    user_files: Option<UserFiles>,
    begin_waiting: bool,
    user_edited: bool,
}

#[derive(Default)]
struct UserFiles {
    user: UserFilters,
    rejected: Option<RejectedUserFilters>,
}

fn read_user_files(base: &Path) -> UserFiles {
    let user = std::fs::read(base.join("user-filters.json"))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    let rejected = std::fs::read(base.join("user-filters-rejected.json"))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok());
    let _ = std::fs::create_dir_all(base.join("Store"));
    UserFiles { user, rejected }
}

fn prefetch_user_files(base: Option<PathBuf>) {
    let Some(base) = base else {
        with(|b| b.user_files = Some(UserFiles::default()));
        return;
    };
    let spawned = std::thread::Builder::new()
        .name("ardia-content-rules-files".into())
        .spawn(move || {
            let files = SendBox(read_user_files(&base));
            on_main(move || {
                let files = files;
                user_files_arrived(files.0);
            });
        });
    if let Err(problem) = spawned {
        log::warn!("content blocker user filters start empty: {problem}");
        with(|b| b.user_files = Some(UserFiles::default()));
    }
}

fn user_files_arrived(files: UserFiles) {
    let fresh = with(|b| {
        if b.began && b.begin_waiting {
            b.begin_waiting = false;
            finish_begin(b, files);
            true
        } else {
            b.user_files = Some(files);
            false
        }
    });
    if fresh {
        reselect();
        apply_all();
    }
}

thread_local! {
    static BLOCKER: RefCell<Blocker> = RefCell::new(Blocker::default());
}

fn with<R>(f: impl FnOnce(&mut Blocker) -> R) -> R {
    BLOCKER.with(|blocker| f(&mut blocker.borrow_mut()))
}

fn resources_directory(resources: Option<PathBuf>) -> Option<PathBuf> {
    resources.or_else(|| {
        NSBundle::mainBundle()
            .resourcePath()
            .map(|path| PathBuf::from(path.to_string()))
    })
}

pub fn start(data_dir: Option<&Path>, resources: Option<PathBuf>) {
    if MainThreadMarker::new().is_none() {
        let data_dir = data_dir.map(Path::to_path_buf);
        on_main(move || start(data_dir.as_deref(), resources));
        return;
    }
    let rules = resources_directory(resources).map(|dir| dir.join("ContentRules"));
    let base = with(|b| {
        b.configured = true;
        b.base = data_dir.map(|dir| dir.join(FOLDER));
        b.rules_directory = rules;
        b.base.clone()
    });
    prefetch_user_files(base);
}

fn load_settings(b: &mut Blocker) {
    if b.loaded_settings {
        return;
    }
    b.loaded_settings = true;
    if let Some(base) = &b.base {
        b.settings = read_settings(base);
    }
}

fn begin() {
    let fresh = with(|b| {
        if b.began || !b.configured {
            return false;
        }
        b.began = true;
        let Some(files) = b.user_files.take() else {
            b.begin_waiting = true;
            return false;
        };
        finish_begin(b, files);
        true
    });
    if fresh {
        reselect();
    }
}

fn finish_begin(b: &mut Blocker, files: UserFiles) {
    load_settings(b);
    b.bundled = b.rules_directory.as_deref().and_then(Bundled::read);
    if b.base.is_some() {
        if !b.user_edited {
            b.user = files.user;
            b.rejected_user = files.rejected;
        }
        if let Some(message) = user_filters::rejection_message(&b.user, b.rejected_user.as_ref()) {
            b.last_error = Some(message);
        }
    }
    b.store = b.base.as_ref().and_then(|base| {
        let folder = base.join("Store");
        let url = NSURL::fileURLWithPath_isDirectory(
            &NSString::from_str(&folder.to_string_lossy()),
            true,
        );
        let mtm = MainThreadMarker::new()?;
        unsafe { WKContentRuleListStore::storeWithURL(Some(&url), mtm) }
    });
}

pub fn attach(controller: &WKUserContentController) {
    begin();
    with(|b| {
        b.applied
            .retain(|applied| applied.controller.load().is_some());
        if !b
            .applied
            .iter()
            .any(|applied| applied.controller.load().is_some_and(|c| &*c == controller))
        {
            b.applied.push(Applied {
                controller: Weak::from(controller),
                key: String::new(),
                lists: Vec::new(),
            });
        }
        b.scripts.attach(controller);
    });
    apply_all();
}

pub fn strict_blocks(url: &str, initiator: Option<&str>, store: &str) -> bool {
    with(|b| {
        let host = host_of(url);
        if !b.settings.enabled
            || host.is_empty()
            || b.strict_passes
                .get(store)
                .is_some_and(|hosts| hosts.contains(&host))
            || trusted(&b.settings, &host)
        {
            return false;
        }
        if b.user
            .strict_allow_hosts
            .iter()
            .any(|domain| super::covers(domain, &host))
        {
            return false;
        }
        if b.user
            .strict_hosts
            .iter()
            .any(|domain| super::covers(domain, &host))
        {
            return true;
        }
        b.active
            .as_ref()
            .is_some_and(|extras| extras.strict.blocks(url, initiator))
    })
}

pub fn user_filters_text(text: String) {
    std::thread::spawn(move || {
        let empty = text.trim().is_empty();
        let parsed = if empty {
            UserFilters::default()
        } else {
            user_filters::parse(&text)
        };
        on_main(move || use_user_filters(parsed));
    });
}

fn use_user_filters(parsed: UserFilters) {
    let base = with(|b| {
        if parsed.digest == b.user.digest {
            return None;
        }
        b.user_edited = true;
        b.user = parsed.clone();
        Some(b.base.clone())
    });
    let Some(base) = base else {
        return;
    };
    if let Some(base) = base {
        std::thread::spawn(move || {
            let _ = std::fs::create_dir_all(&base);
            let file = base.join("user-filters.json");
            if parsed == UserFilters::default() {
                let _ = std::fs::remove_file(file);
            } else if let Ok(data) = serde_json::to_vec(&parsed) {
                let _ = std::fs::write(file, data);
            }
        });
    }
    if with(|b| b.began) {
        reselect();
        apply_all();
    }
}

fn reject_user(digest: String, error: String, rules: Vec<String>) {
    let rejected = RejectedUserFilters {
        digest,
        error,
        rules: Some(rules),
    };
    let base = with(|b| {
        b.user_edited = true;
        b.rejected_user = Some(rejected.clone());
        b.base.clone()
    });
    if let Some(base) = base {
        std::thread::spawn(move || {
            let _ = std::fs::create_dir_all(&base);
            if let Ok(data) = serde_json::to_vec(&rejected) {
                let _ = std::fs::write(base.join("user-filters-rejected.json"), data);
            }
        });
    }
}

fn isolate_uncompiled(rules: Vec<super::packer::NetworkRule>, error: String, wanted: String) {
    let Some(store) = store() else {
        finish_loading(wanted, None);
        return;
    };
    let digest = with(|b| b.user.digest.clone());
    let earlier: Vec<String> = with(|b| {
        b.rejected_user
            .as_ref()
            .filter(|r| r.digest == digest)
            .and_then(|r| r.rules.clone())
            .unwrap_or_default()
    });
    let search = Rc::new(RefCell::new(Bisect::new(rules.len())));
    let checks = Rc::new(RefCell::new(0usize));
    let rules = Rc::new(rules);
    fn step(
        store: Retained<WKContentRuleListStore>,
        search: Rc<RefCell<Bisect>>,
        checks: Rc<RefCell<usize>>,
        rules: Rc<Vec<super::packer::NetworkRule>>,
        finish: Finish,
    ) {
        let Some(range) = search.borrow().next() else {
            let done = search.borrow().clone();
            let count = *checks.borrow();
            return finish(&done, count);
        };
        *checks.borrow_mut() += 1;
        let identifier = format!("{}{}", super::CHECK_PREFIX, checks.borrow());
        let json = format!(
            "[{}]",
            rules[range.clone()]
                .iter()
                .map(|r| r.json.as_str())
                .collect::<Vec<_>>()
                .join(",")
        );
        let keep = store.clone();
        let compiling = identifier.clone();
        let next_checks = checks;
        let handler = RcBlock::new(move |list: *mut WKContentRuleList, _: *mut NSError| {
            let compiled = !list.is_null();
            let done = RcBlock::new(|_: *mut NSError| {});
            unsafe {
                keep.removeContentRuleListForIdentifier_completionHandler(
                    Some(&NSString::from_str(&identifier)),
                    Some(&done),
                )
            };
            search.borrow_mut().record(range.clone(), compiled);
            step(
                keep.clone(),
                search.clone(),
                next_checks.clone(),
                rules.clone(),
                finish.clone(),
            );
        });
        unsafe {
            store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                Some(&NSString::from_str(&compiling)),
                Some(&NSString::from_str(&json)),
                Some(&handler),
            )
        };
    }
    let finish_rules = rules.clone();
    let finish: Finish = Rc::new(move |search: &Bisect, checks: usize| {
        let found: Vec<String> = search
            .rejected()
            .into_iter()
            .filter_map(|i| finish_rules.get(i).map(|r| r.json.clone()))
            .collect();
        let dropped = if found.is_empty() {
            finish_rules.iter().map(|r| r.json.clone()).collect()
        } else {
            found
        };
        log::info!(
            "[blocker] {} of {} user filters didn't compile ({checks} checks)",
            dropped.len(),
            finish_rules.len()
        );
        if with(|b| b.user.digest != digest) {
            finish_loading(wanted.clone(), None);
            return;
        }
        let mut all = earlier.clone();
        all.extend(dropped);
        reject_user(digest.clone(), error.clone(), all);
        with(|b| {
            b.last_error = Some(
                user_filters::rejection_message(&b.user, b.rejected_user.as_ref())
                    .unwrap_or_else(|| error.clone()),
            )
        });
        finish_loading(wanted.clone(), None);
    });
    step(store, search, checks, rules, finish);
}

pub fn pass_strict(url: &str, store: &str) {
    let host = host_of(url);
    if host.is_empty() {
        return;
    }
    with(|b| {
        b.strict_passes
            .entry(store.to_owned())
            .or_default()
            .insert(host);
    });
}

pub fn configure(preferences: &WKWebpagePreferences, url: &str) -> bool {
    let responds: bool =
        unsafe { msg_send![preferences, respondsToSelector: sel!(_setContentBlockersEnabled:)] };
    if !responds {
        return false;
    }
    let exempt = host_trusted(&host_of(url));
    let value = NSNumber::new_bool(!exempt);
    let name = NSString::from_str("contentBlockersEnabled");
    let _: () = unsafe { msg_send![preferences, setValue: &*value, forKey: &*name] };
    exempt
}

pub fn host_trusted(host: &str) -> bool {
    with(|b| {
        load_settings(b);
        trusted(&b.settings, &host.to_lowercase())
    })
}

pub fn is_filtering() -> bool {
    with(|b| b.settings.enabled && !b.lists.is_empty())
}

pub fn blocking_enabled() -> bool {
    with(|b| {
        load_settings(b);
        b.settings.enabled
    })
}

pub fn when_ready(seconds: f64, then: Box<dyn FnOnce()>) {
    begin();
    if with(|b| (b.ready && b.extras_ready) || !b.configured) {
        then();
        return;
    }
    let once: Waiter = Rc::new(RefCell::new(Some(then)));
    with(|b| b.waiters.push(once.clone()));
    let later = SendBox(once);
    on_main_after(seconds, move || {
        let later = later;
        let run = later.0.borrow_mut().take();
        if let Some(run) = run {
            run();
        }
    });
}

pub fn state() -> Value {
    with(|b| {
        json!({
            "ready": b.ready,
            "enabled": b.settings.enabled,
            "lists": b.lists.len(),
            "key": b.lists_key,
            "loading": b.loading_key,
            "rulesets": wanted_rulesets(b.bundled.as_ref(), &b.settings),
            "allowedHosts": b.settings.allowed_hosts,
            "compileMs": b.last_compile_ms,
            "error": b.last_error,
            "version": b.bundled.as_ref().map(|x| x.version.clone()).unwrap_or_default(),
            "strictHosts": b.active.as_ref().map_or(0, |e| e.strict.host_count()),
            "strictRules": b.active.as_ref().map_or(0, |e| e.strict.rules.len()),
            "strictPasses": b.strict_passes.values().map(HashSet::len).sum::<usize>(),
            "scripted": b.active.as_ref().map_or(0, |e| e.index.selector_count()),
            "scriptletBytes": b.scripts.scriptlet_bytes,
            "cosmeticLookups": b.scripts.counts().0,
            "cosmeticApplied": b.scripts.counts().1,
            "extrasMs": b.active.as_ref().map_or(0.0, |e| e.load_ms),
            "extrasReady": b.extras_ready,
        })
    })
}

pub fn settings_changed(info: Value) {
    if MainThreadMarker::new().is_none() {
        on_main(move || settings_changed(info));
        return;
    }
    let changed = with(|b| {
        load_settings(b);
        let next = note_change(&b.settings, &info);
        if next == b.settings {
            return None;
        }
        b.settings = next.clone();
        Some((b.base.clone(), next, b.began))
    });
    let Some((base, next, began)) = changed else {
        return;
    };
    if let Some(base) = base {
        std::thread::spawn(move || write_settings(&base, &next));
    }
    if began {
        reselect();
        apply_all();
    }
}

fn mark_ready() {
    let first = with(|b| {
        let first = !b.ready;
        b.ready = true;
        first
    });
    if first {
        flush_waiters();
    }
}

fn finish_extras() {
    let first = with(|b| {
        let first = !b.extras_ready;
        b.extras_ready = true;
        first
    });
    if first {
        flush_waiters();
    }
}

fn flush_waiters() {
    let waiters = with(|b| {
        if !(b.ready && b.extras_ready) {
            return Vec::new();
        }
        std::mem::take(&mut b.waiters)
    });
    for waiter in waiters {
        let run = waiter.borrow_mut().take();
        if let Some(run) = run {
            run();
        }
    }
}

enum Next {
    Ready,
    Clear,
    Load(Vec<String>, String),
    Wait,
}

fn refresh_extras() {
    enum Step {
        Done,
        Load(
            Vec<String>,
            PathBuf,
            HashMap<String, Vec<String>>,
            String,
            String,
        ),
    }
    let step = with(|b| {
        let rulesets = if b.settings.enabled {
            wanted_rulesets(b.bundled.as_ref(), &b.settings)
        } else {
            Vec::new()
        };
        let trusted_hosts = b.settings.allowed_hosts.clone();
        let digest = b
            .bundled
            .as_ref()
            .and_then(|x| x.digest.clone())
            .unwrap_or_default();
        let user_digest = if b.settings.enabled {
            b.user.digest.clone()
        } else {
            String::new()
        };
        let key = [
            rulesets.join(","),
            trusted_hosts.join(","),
            user_digest,
            digest,
        ]
        .join("|");
        if b.settings.enabled {
            super::extras::set_user_part(
                b.user.hide.clone().into_iter().collect(),
                b.user.unhide.clone().into_iter().collect(),
            );
        } else {
            super::extras::set_user_part(HashMap::new(), HashMap::new());
        }
        if key == b.extras_key {
            return None;
        }
        b.extras_key = key.clone();
        let (Some(directory), Some(bundled), true) = (
            b.rules_directory.clone(),
            b.bundled.clone(),
            b.settings.enabled,
        ) else {
            b.active = None;
            b.scripts.update(None, None, &[], &key);
            return Some(Step::Done);
        };
        if let Some(extras) = b.extras.clone().filter(|e| e.rulesets == rulesets) {
            b.active = Some(extras.clone());
            b.scripts.update(
                extras.sources.as_ref(),
                Some(extras.index.clone()),
                &trusted_hosts,
                &key,
            );
            return Some(Step::Done);
        }
        let worlds = bundled
            .rulesets
            .iter()
            .map(|r| (r.id.clone(), r.scriptlets.clone().unwrap_or_default()))
            .collect();
        Some(Step::Load(
            rulesets,
            directory,
            worlds,
            bundled.scriptlet_secret.unwrap_or_default(),
            key,
        ))
    });
    match step {
        None => {}
        Some(Step::Done) => finish_extras(),
        Some(Step::Load(rulesets, directory, worlds, secret, key)) => {
            std::thread::spawn(move || {
                let started = Instant::now();
                let strict = StrictBlock::load(&rulesets, &directory);
                let index = Arc::new(CosmeticIndex::load(&rulesets, &directory));
                let sources = ScriptletSources::load(&rulesets, &worlds, &secret, &directory);
                let made = Extras {
                    rulesets,
                    strict,
                    index,
                    sources,
                    load_ms: started.elapsed().as_secs_f64() * 1000.0,
                };
                on_main(move || {
                    let installed = with(|b| {
                        if key != b.extras_key {
                            return false;
                        }
                        log::info!(
                            "[blocker] WebKit strict blocking ({} hosts, {} rules), {} scripted selectors and scriptlets loaded in {:.0} ms",
                            made.strict.host_count(),
                            made.strict.rules.len(),
                            made.index.selector_count(),
                            made.load_ms
                        );
                        let extras = Rc::new(made);
                        b.extras = Some(extras.clone());
                        b.active = Some(extras.clone());
                        let trusted_hosts = b.settings.allowed_hosts.clone();
                        b.scripts.update(
                            extras.sources.as_ref(),
                            Some(extras.index.clone()),
                            &trusted_hosts,
                            &key,
                        );
                        true
                    });
                    if installed {
                        finish_extras();
                    }
                });
            });
        }
    }
}

fn reselect() {
    refresh_extras();
    let next = with(|b| {
        let rulesets = if b.settings.enabled {
            wanted_rulesets(b.bundled.as_ref(), &b.settings)
        } else {
            Vec::new()
        };
        b.desired_key = if rulesets.is_empty() || b.store.is_none() {
            String::new()
        } else {
            key(
                b.bundled.as_ref(),
                &rulesets,
                user_filters::user_key(&b.user, b.rejected_user.as_ref())
                    .0
                    .as_deref(),
            )
        };
        if b.desired_key == b.lists_key {
            return Next::Ready;
        }
        if b.desired_key.is_empty() {
            return Next::Clear;
        }
        if b.loading_key.is_some() || b.failed_key.as_deref() == Some(b.desired_key.as_str()) {
            return Next::Wait;
        }
        Next::Load(rulesets, b.desired_key.clone())
    });
    match next {
        Next::Ready => {
            mark_ready();
            apply_all();
        }
        Next::Clear => install(String::new(), Vec::new()),
        Next::Load(rulesets, wanted) => load(rulesets, wanted),
        Next::Wait => {}
    }
}

fn store() -> Option<Retained<WKContentRuleListStore>> {
    with(|b| b.store.clone())
}

fn strings_of(array: *mut NSArray<NSString>) -> Vec<String> {
    let Some(array) = (unsafe { array.as_ref() }) else {
        return Vec::new();
    };
    array.iter().map(|s| s.to_string()).collect()
}

fn load(rulesets: Vec<String>, wanted: String) {
    let Some(store) = store() else {
        return;
    };
    with(|b| b.loading_key = Some(wanted.clone()));
    let handler = RcBlock::new(move |found: *mut NSArray<NSString>| {
        let available = strings_of(found);
        let current = with(|b| b.desired_key.clone());
        if wanted != current {
            with(|b| b.loading_key = None);
            reselect();
            return;
        }
        match complete_set(&wanted, &available) {
            Some(expected) => look_up(expected, wanted.clone(), rulesets.clone()),
            None => {
                mark_ready();
                compile(rulesets.clone(), wanted.clone());
            }
        }
    });
    unsafe { store.getAvailableContentRuleListIdentifiers(Some(&handler)) };
}

struct Gather {
    found: HashMap<usize, Retained<WKContentRuleList>>,
    left: usize,
    failure: Option<String>,
}

fn look_up(identifiers: Vec<String>, wanted: String, rulesets: Vec<String>) {
    let Some(store) = store() else {
        return;
    };
    let total = identifiers.len();
    let gather = Rc::new(RefCell::new(Gather {
        found: HashMap::new(),
        left: total,
        failure: None,
    }));
    for (index, identifier) in identifiers.iter().enumerate() {
        let gather = gather.clone();
        let wanted = wanted.clone();
        let rulesets = rulesets.clone();
        let handler = RcBlock::new(move |list: *mut WKContentRuleList, _: *mut NSError| {
            let done = {
                let mut g = gather.borrow_mut();
                match unsafe { Retained::retain(list) } {
                    Some(list) => {
                        g.found.insert(index, list);
                    }
                    None => g.failure = Some("missing".into()),
                }
                g.left -= 1;
                g.left == 0
            };
            if !done {
                return;
            }
            let (failed, lists) = {
                let mut g = gather.borrow_mut();
                let lists: Vec<_> = (0..total).filter_map(|i| g.found.remove(&i)).collect();
                (g.failure.is_some(), lists)
            };
            if failed {
                mark_ready();
                compile(rulesets.clone(), wanted.clone());
            } else {
                finish_loading(wanted.clone(), Some(lists));
            }
        });
        unsafe {
            store.lookUpContentRuleListForIdentifier_completionHandler(
                Some(&NSString::from_str(identifier)),
                Some(&handler),
            )
        };
    }
}

fn compile(rulesets: Vec<String>, wanted: String) {
    let (Some(_), Some(directory)) = (store(), with(|b| b.rules_directory.clone())) else {
        finish_loading(wanted, None);
        return;
    };
    let started = Instant::now();
    let user = with(|b| user_filters::user_key(&b.user, b.rejected_user.as_ref()).1);
    std::thread::spawn(move || {
        let encoded = assemble(&rulesets, &directory, &user);
        on_main(move || compile_lists(rulesets, wanted, encoded, started, user));
    });
}

fn compile_lists(
    rulesets: Vec<String>,
    wanted: String,
    encoded: Vec<String>,
    started: Instant,
    user: Vec<super::packer::NetworkRule>,
) {
    let user = Rc::new(user);
    let Some(store) = store() else {
        return;
    };
    if encoded.is_empty() {
        with(|b| b.last_error = Some(format!("no rules for {}", rulesets.join(","))));
        finish_loading(wanted, None);
        return;
    }
    let total = encoded.len();
    let names = identifiers(&wanted, total);
    let gather = Rc::new(RefCell::new(Gather {
        found: HashMap::new(),
        left: total,
        failure: None,
    }));
    for (index, json) in encoded.iter().enumerate() {
        let gather = gather.clone();
        let wanted = wanted.clone();
        let all_names = names.clone();
        let rulesets = rulesets.clone();
        let user = user.clone();
        let handler = RcBlock::new(move |list: *mut WKContentRuleList, error: *mut NSError| {
            let done = {
                let mut g = gather.borrow_mut();
                match unsafe { Retained::retain(list) } {
                    Some(list) => {
                        g.found.insert(index, list);
                    }
                    None => {
                        if g.failure.is_none() {
                            let text = unsafe { error.as_ref() }
                                .map(|e| e.localizedDescription().to_string())
                                .unwrap_or_else(|| "failed".into());
                            g.failure = Some(text);
                        }
                    }
                }
                g.left -= 1;
                g.left == 0
            };
            if !done {
                return;
            }
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            with(|b| b.last_compile_ms = ms);
            let (failure, lists) = {
                let mut g = gather.borrow_mut();
                let lists: Vec<_> = (0..total).filter_map(|i| g.found.remove(&i)).collect();
                (g.failure.take(), lists)
            };
            if let Some(failure) = failure {
                log::warn!("[blocker] WebKit rules didn't compile: {failure}");
                if !user.is_empty() {
                    isolate_uncompiled(user.to_vec(), failure, wanted.clone());
                    return;
                }
                with(|b| b.last_error = Some(failure));
                finish_loading(wanted.clone(), None);
                return;
            }
            log::info!(
                "[blocker] WebKit rules for {} compiled in {ms:.0} ms",
                rulesets.join(",")
            );
            let previous = with(|b| {
                b.last_error = user_filters::rejection_message(&b.user, b.rejected_user.as_ref());
                b.lists_key.clone()
            });
            finish_loading(wanted.clone(), Some(lists));
            if with(|b| b.lists_key == wanted) {
                remove_stale(all_names.iter().cloned().collect(), previous);
            }
        });
        unsafe {
            store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                Some(&NSString::from_str(&names[index])),
                Some(&NSString::from_str(json)),
                Some(&handler),
            )
        };
    }
}

fn remove_stale(current: BTreeSet<String>, previous: String) {
    let Some(store) = store() else {
        return;
    };
    let keep = store.clone();
    let handler = RcBlock::new(move |found: *mut NSArray<NSString>| {
        for identifier in stale(&strings_of(found), &current, &previous) {
            let done = RcBlock::new(|_: *mut NSError| {});
            unsafe {
                keep.removeContentRuleListForIdentifier_completionHandler(
                    Some(&NSString::from_str(&identifier)),
                    Some(&done),
                )
            };
        }
    });
    unsafe { store.getAvailableContentRuleListIdentifiers(Some(&handler)) };
}

fn finish_loading(wanted: String, made: Option<Vec<Retained<WKContentRuleList>>>) {
    let install_now = with(|b| {
        b.loading_key = None;
        if made.is_none() {
            b.failed_key = Some(wanted.clone());
        }
        wanted == b.desired_key
    });
    if let (Some(made), true) = (made, install_now) {
        install(wanted, made);
    }
    mark_ready();
    if with(|b| b.desired_key != b.lists_key) {
        reselect();
    }
}

fn install(key: String, made: Vec<Retained<WKContentRuleList>>) {
    with(|b| {
        b.lists_key = key;
        b.lists = made;
    });
    mark_ready();
    apply_all();
}

fn apply_all() {
    let plan: Vec<ApplyStep> = with(|b| {
        let want = if b.settings.enabled && !b.lists.is_empty() {
            b.lists_key.clone()
        } else {
            String::new()
        };
        let adding = if want.is_empty() {
            Vec::new()
        } else {
            b.lists.clone()
        };
        b.applied
            .retain(|applied| applied.controller.load().is_some());
        b.applied
            .iter_mut()
            .filter(|applied| applied.key != want)
            .filter_map(|applied| {
                let controller = applied.controller.load()?;
                let removing = std::mem::replace(&mut applied.lists, adding.clone());
                applied.key = want.clone();
                Some((controller, removing, adding.clone()))
            })
            .collect()
    });
    for (controller, removing, adding) in plan {
        for list in &removing {
            unsafe { controller.removeContentRuleList(list) };
        }
        for list in &adding {
            unsafe { controller.addContentRuleList(list) };
        }
    }
}
