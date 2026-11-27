use std::mem::ManuallyDrop;
use std::thread::{self, ThreadId};

pub struct MainThread<T> {
    owner: ThreadId,
    value: ManuallyDrop<T>,
}

unsafe impl<T> Send for MainThread<T> {}
unsafe impl<T> Sync for MainThread<T> {}

impl<T> MainThread<T> {
    pub fn new(value: T) -> Self {
        Self {
            owner: thread::current().id(),
            value: ManuallyDrop::new(value),
        }
    }

    pub fn is_owner(&self) -> bool {
        thread::current().id() == self.owner
    }

    pub fn get(&self) -> Option<&T> {
        self.is_owner().then(|| &*self.value)
    }
}

impl<T> Drop for MainThread<T> {
    fn drop(&mut self) {
        if self.is_owner() {
            unsafe { ManuallyDrop::drop(&mut self.value) };
        } else {
            log::warn!("a main-thread value was dropped elsewhere and is kept alive instead");
        }
    }
}

impl<T> std::fmt::Debug for MainThread<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MainThread")
            .field("owner", &self.owner)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;
    use std::sync::Arc;

    #[test]
    fn only_the_owner_thread_reaches_the_value() {
        let cell = Arc::new(MainThread::new(Rc::new(Cell::new(1))));
        assert_eq!(cell.get().map(|v| v.get()), Some(1));
        let remote = cell;
        let seen = thread::spawn(move || remote.get().is_some())
            .join()
            .unwrap();
        assert!(!seen, "another thread can't see a main-thread value");
    }

    #[test]
    fn a_value_dropped_elsewhere_is_leaked_not_destroyed() {
        struct Loud(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Loud {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cell = MainThread::new(Loud(dropped.clone()));
        thread::spawn(move || drop(cell)).join().unwrap();
        assert!(!dropped.load(std::sync::atomic::Ordering::SeqCst));
        let cell = MainThread::new(Loud(dropped.clone()));
        drop(cell);
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    }
}
