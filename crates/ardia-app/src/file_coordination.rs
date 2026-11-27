use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Writing {
    Deleting,
    Moving,
    Replacing,
}

impl Writing {
    fn option(self) -> usize {
        match self {
            Writing::Deleting => 1,
            Writing::Moving => 2,
            Writing::Replacing => 8,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoordinationError {
    TimedOut,
    Failed(String),
}

impl std::fmt::Display for CoordinationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoordinationError::TimedOut => f.write_str("the file didn’t answer in time"),
            CoordinationError::Failed(problem) => f.write_str(problem),
        }
    }
}

const READING_WITHOUT_CHANGES: usize = 1;

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSError, NSString, NSURL};

    struct Shared(Retained<AnyObject>);
    unsafe impl Send for Shared {}
    unsafe impl Sync for Shared {}

    fn url(path: &Path) -> Option<Retained<NSURL>> {
        let text = path.to_str()?;
        Some(NSURL::fileURLWithPath(&NSString::from_str(text)))
    }

    fn coordinator() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"NSFileCoordinator")?;
        unsafe {
            let made: *mut AnyObject = msg_send![class, alloc];
            let made: *mut AnyObject =
                msg_send![made, initWithFilePresenter: std::ptr::null::<AnyObject>()];
            Retained::from_raw(made)
        }
    }

    struct Pending {
        coordinator: Shared,
        deadline: std::time::Instant,
        started: Arc<AtomicBool>,
        expired: Arc<AtomicBool>,
    }

    static PENDING: parking_lot::Mutex<Vec<Pending>> = parking_lot::Mutex::new(Vec::new());
    static WAKE: parking_lot::Condvar = parking_lot::Condvar::new();
    static WATCHER: std::sync::Once = std::sync::Once::new();

    fn watch() {
        loop {
            let mut pending = PENDING.lock();
            let now = std::time::Instant::now();
            let mut i = 0;
            while i < pending.len() {
                let entry = &pending[i];
                if entry.started.load(Ordering::Acquire) {
                    pending.swap_remove(i);
                } else if entry.deadline <= now {
                    let entry = pending.swap_remove(i);
                    entry.expired.store(true, Ordering::Release);
                    let _: () = unsafe { msg_send![&*entry.coordinator.0, cancel] };
                } else {
                    i += 1;
                }
            }
            match pending.iter().map(|p| p.deadline).min() {
                Some(next) => {
                    WAKE.wait_until(&mut pending, next.min(now + Duration::from_secs(1)));
                }
                None => WAKE.wait(&mut pending),
            }
        }
    }

    fn with_deadline<T>(
        run: impl FnOnce(&AnyObject, &Arc<AtomicBool>) -> Result<T, CoordinationError>,
    ) -> Result<T, CoordinationError> {
        let Some(coordinator) = coordinator() else {
            return Err(CoordinationError::Failed("no file coordinator".into()));
        };
        WATCHER.call_once(|| {
            let _ = std::thread::Builder::new()
                .name("ardia-file-coordination".into())
                .spawn(watch);
        });
        let started = Arc::new(AtomicBool::new(false));
        let expired = Arc::new(AtomicBool::new(false));
        PENDING.lock().push(Pending {
            coordinator: Shared(coordinator.clone()),
            deadline: std::time::Instant::now() + TIMEOUT,
            started: started.clone(),
            expired: expired.clone(),
        });
        WAKE.notify_all();
        let result = run(&coordinator, &started);
        started.store(true, Ordering::Release);
        if expired.load(Ordering::Acquire) && result.is_err() {
            return Err(CoordinationError::TimedOut);
        }
        result
    }

    fn error_text(error: *mut NSError) -> Option<String> {
        if error.is_null() {
            return None;
        }
        let error = unsafe { &*error };
        Some(error.localizedDescription().to_string())
    }

    type Task<'a> = Option<Box<dyn FnOnce() + 'a>>;

    fn coordinated<T>(
        body: impl FnOnce() -> T,
        ask: impl FnOnce(&dyn Fn(), *mut *mut NSError),
    ) -> Result<T, CoordinationError> {
        let mut out: Option<T> = None;
        let mut error: *mut NSError = std::ptr::null_mut();
        {
            let out_ref = &mut out;
            let mut task: Task<'_> = Some(Box::new(move || *out_ref = Some(body())));
            let slot = &mut task as *mut Task<'_> as usize;
            let invoke = move || {
                let task = unsafe { &mut *(slot as *mut Task<'static>) };
                if let Some(run) = task.take() {
                    run();
                }
            };
            ask(&invoke, &mut error);
        }
        match (out, error_text(error)) {
            (Some(out), _) => Ok(out),
            (None, Some(problem)) => Err(CoordinationError::Failed(problem)),
            (None, None) => Err(CoordinationError::Failed(
                "the file access was cancelled".into(),
            )),
        }
    }

    pub fn read<T>(path: &Path, body: impl FnOnce() -> T) -> Result<T, CoordinationError> {
        let Some(target) = url(path) else {
            return Ok(body());
        };
        with_deadline(|coordinator, started| {
            coordinated(body, |invoke, error| {
                let invoke: &'static dyn Fn() =
                    unsafe { std::mem::transmute::<&dyn Fn(), &'static dyn Fn()>(invoke) };
                let started = started.clone();
                let accessor = RcBlock::new(move |_url: *mut NSURL| {
                    started.store(true, Ordering::Release);
                    invoke();
                });
                let _: () = unsafe {
                    msg_send![coordinator, coordinateReadingItemAtURL: &*target, options: READING_WITHOUT_CHANGES, error: error, byAccessor: &*accessor]
                };
            })
        })
    }

    pub fn write<T>(
        path: &Path,
        writing: Writing,
        body: impl FnOnce() -> T,
    ) -> Result<T, CoordinationError> {
        let Some(target) = url(path) else {
            return Ok(body());
        };
        with_deadline(|coordinator, started| {
            coordinated(body, |invoke, error| {
                let invoke: &'static dyn Fn() =
                    unsafe { std::mem::transmute::<&dyn Fn(), &'static dyn Fn()>(invoke) };
                let started = started.clone();
                let accessor = RcBlock::new(move |_url: *mut NSURL| {
                    started.store(true, Ordering::Release);
                    invoke();
                });
                let _: () = unsafe {
                    msg_send![coordinator, coordinateWritingItemAtURL: &*target, options: writing.option(), error: error, byAccessor: &*accessor]
                };
            })
        })
    }

    pub fn moving<T>(
        from: &Path,
        to: &Path,
        body: impl FnOnce() -> T,
    ) -> Result<T, CoordinationError> {
        let (Some(source), Some(destination)) = (url(from), url(to)) else {
            return Ok(body());
        };
        with_deadline(|coordinator, started| {
            coordinated(body, |invoke, error| {
                let invoke: &'static dyn Fn() =
                    unsafe { std::mem::transmute::<&dyn Fn(), &'static dyn Fn()>(invoke) };
                let started = started.clone();
                let accessor = RcBlock::new(move |_a: *mut NSURL, _b: *mut NSURL| {
                    started.store(true, Ordering::Release);
                    invoke();
                });
                let _: () = unsafe {
                    msg_send![coordinator, coordinateWritingItemAtURL: &*source, options: Writing::Moving.option(), writingItemAtURL: &*destination, options: Writing::Replacing.option(), error: error, byAccessor: &*accessor]
                };
            })
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub fn read<T>(_path: &Path, body: impl FnOnce() -> T) -> Result<T, CoordinationError> {
        Ok(body())
    }

    pub fn write<T>(
        _path: &Path,
        _writing: Writing,
        body: impl FnOnce() -> T,
    ) -> Result<T, CoordinationError> {
        Ok(body())
    }

    pub fn moving<T>(
        _from: &Path,
        _to: &Path,
        body: impl FnOnce() -> T,
    ) -> Result<T, CoordinationError> {
        Ok(body())
    }
}

pub use platform::{moving, read, write};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_coordinated_access_runs_its_body_inside_and_returns_its_value() {
        let dir = std::env::temp_dir().join(format!("ardia-coordination-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("one.txt");
        let moved = dir.join("two.txt");
        let wrote = write(&file, Writing::Replacing, || {
            std::fs::write(&file, "hello").is_ok()
        });
        assert_eq!(wrote, Ok(true));
        assert_eq!(
            read(&file, || std::fs::read_to_string(&file).unwrap()),
            Ok("hello".to_owned())
        );
        assert_eq!(
            moving(&file, &moved, || std::fs::rename(&file, &moved).is_ok()),
            Ok(true)
        );
        assert_eq!(read(&dir.join("missing"), || 7), Ok(7));
        assert_eq!(
            write(&moved, Writing::Deleting, || std::fs::remove_file(&moved)
                .is_ok()),
            Ok(true)
        );
        assert!(!moved.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
