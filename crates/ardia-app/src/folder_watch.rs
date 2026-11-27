use std::sync::Arc;

pub type OnChange = Box<dyn Fn(Vec<String>) + Send + Sync>;

pub fn resolved(path: &str) -> String {
    std::fs::canonicalize(path)
        .ok()
        .and_then(|p| p.to_str().map(str::to_owned))
        .unwrap_or_else(|| path.trim_end_matches('/').to_owned())
}

pub fn touches(changed: &str, root: &str) -> bool {
    changed == root
        || changed
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
        || root
            .strip_prefix(changed)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Root {
    watched: String,
    real: String,
}

fn hits(roots: &[Root], changed: &[String]) -> Vec<String> {
    roots
        .iter()
        .filter(|root| {
            changed
                .iter()
                .any(|path| touches(path.trim_end_matches('/'), &root.real))
        })
        .map(|root| root.watched.clone())
        .collect()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2_foundation::{NSArray, NSString};
    use parking_lot::Mutex;
    use std::ffi::{CStr, c_char, c_void};

    type Stream = *mut c_void;
    type Queue = *mut c_void;
    type Callback = extern "C" fn(Stream, *mut c_void, usize, *mut c_void, *const u32, *const u64);
    type Work = extern "C" fn(*mut c_void);

    #[repr(C)]
    struct DispatchQueue {
        _opaque: [u8; 0],
    }

    #[repr(C)]
    struct Context {
        version: isize,
        info: *mut c_void,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
    }

    const SINCE_NOW: u64 = u64::MAX;
    const NO_DEFER: u32 = 0x02;
    const WATCH_ROOT: u32 = 0x04;
    const FILE_EVENTS: u32 = 0x10;
    const LATENCY: f64 = 0.2;

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn FSEventStreamCreate(
            allocator: *const c_void,
            callback: Callback,
            context: *mut Context,
            paths: *const c_void,
            since: u64,
            latency: f64,
            flags: u32,
        ) -> Stream;
        fn FSEventStreamSetDispatchQueue(stream: Stream, queue: Queue);
        fn FSEventStreamStart(stream: Stream) -> u8;
        fn FSEventStreamStop(stream: Stream);
        fn FSEventStreamInvalidate(stream: Stream);
        fn FSEventStreamRelease(stream: Stream);
        fn FSEventStreamGetLatestEventId(stream: Stream) -> u64;
    }

    unsafe extern "C" {
        fn dispatch_queue_create(label: *const c_char, attr: *const c_void) -> Queue;
        fn dispatch_async_f(queue: *const DispatchQueue, context: *mut c_void, work: Work);
        fn dispatch_sync_f(queue: *const DispatchQueue, context: *mut c_void, work: Work);
        fn dispatch_release(object: *mut c_void);
    }

    struct Inner {
        queue: usize,
        on_change: OnChange,
        state: Mutex<State>,
    }

    struct State {
        stream: usize,
        last_event: u64,
        roots: Vec<Root>,
    }

    pub struct FolderWatcher {
        inner: *const Inner,
    }

    unsafe impl Send for FolderWatcher {}
    unsafe impl Sync for FolderWatcher {}

    type Job = Box<dyn FnOnce(&Inner) + Send>;

    struct Posted {
        inner: *const Inner,
        job: Job,
    }

    thread_local! {
        static ON_QUEUE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    fn on_queue<T>(run: impl FnOnce() -> T) -> T {
        let was = ON_QUEUE.with(|q| q.replace(true));
        let out = run();
        ON_QUEUE.with(|q| q.set(was));
        out
    }

    extern "C" fn run_posted(context: *mut c_void) {
        let posted = unsafe { Box::from_raw(context as *mut Posted) };
        let inner = unsafe { &*posted.inner };
        on_queue(|| (posted.job)(inner));
    }

    extern "C" fn release_inner(context: *mut c_void) {
        drop(unsafe { Arc::from_raw(context as *const Inner) });
    }

    extern "C" fn changed(
        _stream: Stream,
        info: *mut c_void,
        count: usize,
        paths: *mut c_void,
        _flags: *const u32,
        _ids: *const u64,
    ) {
        if info.is_null() || paths.is_null() {
            return;
        }
        let inner = unsafe { &*(info as *const Inner) };
        let paths = paths as *const *const c_char;
        let changed: Vec<String> = (0..count)
            .filter_map(|i| {
                let path = unsafe { *paths.add(i) };
                (!path.is_null()).then(|| {
                    unsafe { CStr::from_ptr(path) }
                        .to_string_lossy()
                        .into_owned()
                })
            })
            .collect();
        let hit = hits(&inner.state.lock().roots, &changed);
        if !hit.is_empty() {
            on_queue(|| (inner.on_change)(hit));
        }
    }

    fn stop_stream(state: &mut State) {
        if state.stream == 0 {
            return;
        }
        let stream = state.stream as Stream;
        unsafe {
            let latest = FSEventStreamGetLatestEventId(stream);
            if latest != 0 {
                state.last_event = latest;
            }
            FSEventStreamStop(stream);
            FSEventStreamInvalidate(stream);
            FSEventStreamRelease(stream);
        }
        state.stream = 0;
    }

    fn restart(inner: &Inner, state: &mut State) {
        stop_stream(state);
        if state.roots.is_empty() {
            return;
        }
        let names: Vec<_> = state
            .roots
            .iter()
            .map(|r| NSString::from_str(&r.real))
            .collect();
        let array = NSArray::from_retained_slice(&names);
        let mut context = Context {
            version: 0,
            info: inner as *const Inner as *mut c_void,
            retain: std::ptr::null(),
            release: std::ptr::null(),
            copy_description: std::ptr::null(),
        };
        let stream = unsafe {
            FSEventStreamCreate(
                std::ptr::null(),
                changed,
                &mut context,
                &*array as *const NSArray<NSString> as *const c_void,
                state.last_event,
                LATENCY,
                FILE_EVENTS | WATCH_ROOT | NO_DEFER,
            )
        };
        if stream.is_null() {
            return;
        }
        unsafe {
            FSEventStreamSetDispatchQueue(stream, inner.queue as Queue);
            if FSEventStreamStart(stream) == 0 {
                FSEventStreamInvalidate(stream);
                FSEventStreamRelease(stream);
                return;
            }
        }
        state.stream = stream as usize;
    }

    impl FolderWatcher {
        pub fn new(on_change: OnChange) -> FolderWatcher {
            let queue = unsafe {
                dispatch_queue_create(c"ardia.shared-folders.watch".as_ptr(), std::ptr::null())
            };
            let inner = Arc::new(Inner {
                queue: queue as usize,
                on_change,
                state: Mutex::new(State {
                    stream: 0,
                    last_event: SINCE_NOW,
                    roots: Vec::new(),
                }),
            });
            FolderWatcher {
                inner: Arc::into_raw(inner),
            }
        }

        fn post(&self, wait: bool, job: impl FnOnce(&Inner) + Send + 'static) {
            let inner = unsafe { &*self.inner };
            if inner.queue == 0 {
                return;
            }
            let posted = Box::into_raw(Box::new(Posted {
                inner: self.inner,
                job: Box::new(job),
            })) as *mut c_void;
            unsafe {
                if wait {
                    dispatch_sync_f(inner.queue as *const DispatchQueue, posted, run_posted);
                } else {
                    dispatch_async_f(inner.queue as *const DispatchQueue, posted, run_posted);
                }
            }
        }

        pub fn watch(&self, paths: Vec<String>) {
            self.post(false, move |inner| {
                let next: Vec<Root> = paths
                    .into_iter()
                    .map(|watched| Root {
                        real: resolved(&watched),
                        watched,
                    })
                    .collect();
                let mut state = inner.state.lock();
                let same = next
                    .iter()
                    .map(|r| &r.real)
                    .eq(state.roots.iter().map(|r| &r.real));
                let missing = state.stream == 0 && !next.is_empty();
                state.roots = next;
                if !same || missing {
                    restart(inner, &mut state);
                }
            });
        }

        pub fn stop(&self) {
            self.post(true, |inner| {
                let mut state = inner.state.lock();
                state.roots.clear();
                stop_stream(&mut state);
            });
        }

        pub fn flush(&self) {
            self.post(true, |_| {});
        }

        pub fn watching(&self) -> bool {
            let seen = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let out = seen.clone();
            self.post(true, move |inner| {
                out.store(
                    inner.state.lock().stream != 0,
                    std::sync::atomic::Ordering::Release,
                )
            });
            seen.load(std::sync::atomic::Ordering::Acquire)
        }
    }

    impl Drop for FolderWatcher {
        fn drop(&mut self) {
            let queue = unsafe { &*self.inner }.queue;
            if queue == 0 {
                drop(unsafe { Arc::from_raw(self.inner) });
                return;
            }
            if ON_QUEUE.with(|q| q.get()) {
                let inner = unsafe { &*self.inner };
                let mut state = inner.state.lock();
                state.roots.clear();
                stop_stream(&mut state);
                drop(state);
                unsafe {
                    dispatch_async_f(
                        queue as *const DispatchQueue,
                        self.inner as *mut c_void,
                        release_inner,
                    )
                };
            } else {
                self.stop();
                drop(unsafe { Arc::from_raw(self.inner) });
            }
            unsafe { dispatch_release(queue as *mut c_void) };
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub struct FolderWatcher;

    impl FolderWatcher {
        pub fn new(_on_change: OnChange) -> FolderWatcher {
            FolderWatcher
        }

        pub fn watch(&self, _paths: Vec<String>) {}

        pub fn stop(&self) {}

        pub fn flush(&self) {}

        pub fn watching(&self) -> bool {
            false
        }
    }
}

pub use platform::FolderWatcher;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn a_change_matches_its_root_its_children_and_its_parents() {
        assert!(touches("/a/b", "/a/b"));
        assert!(touches("/a/b/c.webloc", "/a/b"));
        assert!(touches("/a", "/a/b"));
        assert!(!touches("/a/bc", "/a/b"));
        assert!(!touches("/a/b", "/a/bc"));
        let roots = vec![Root {
            watched: "/w/x".into(),
            real: "/r/x".into(),
        }];
        assert_eq!(hits(&roots, &["/r/x/one".into()]), vec!["/w/x".to_owned()]);
        assert!(hits(&roots, &["/r/y".into()]).is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn writing_into_a_watched_folder_reports_that_folder() {
        let dir = std::env::temp_dir().join(format!("ardia-watch-{}", std::process::id()));
        let folder = dir.join("Shared");
        std::fs::create_dir_all(&folder).unwrap();
        let (tx, rx) = mpsc::channel();
        let tx = parking_lot::Mutex::new(tx);
        let watcher = FolderWatcher::new(Box::new(move |paths| {
            let _ = tx.lock().send(paths);
        }));
        let watched = folder.to_str().unwrap().to_owned();
        watcher.watch(vec![watched.clone()]);
        assert!(watcher.watching());
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(folder.join("a.webloc"), "x").unwrap();
        let got = rx.recv_timeout(Duration::from_secs(10)).expect("no event");
        assert_eq!(got, vec![watched.clone()]);
        watcher.watch(vec![watched]);
        assert!(watcher.watching());
        watcher.stop();
        assert!(!watcher.watching());
        while rx.try_recv().is_ok() {}
        std::fs::write(folder.join("b.webloc"), "y").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(800)).is_err());
        drop(watcher);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
