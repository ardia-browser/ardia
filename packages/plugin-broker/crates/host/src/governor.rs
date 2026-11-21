use crate::exit::Exit;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Limits {
    pub memory_bytes: usize,
    pub stack_bytes: usize,
    pub turn_cpu: Duration,
    pub minute_cpu: Duration,
    pub turn_wall: Duration,
    pub stop_grace: Duration,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            memory_bytes: 256 << 20,
            stack_bytes: 1 << 20,
            turn_cpu: Duration::from_secs(2),
            minute_cpu: Duration::from_secs(30),
            turn_wall: Duration::from_secs(10),
            stop_grace: Duration::from_millis(3500),
        }
    }
}

pub static TERMINATE: AtomicBool = AtomicBool::new(false);
pub static WAKE_FD: AtomicI32 = AtomicI32::new(-1);

pub fn thread_cpu_ns() -> u64 {
    let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut now) };
    now.tv_sec as u64 * 1_000_000_000 + now.tv_nsec as u64
}

pub struct Heap {
    pub limit: usize,
    pub used: Cell<usize>,
    pub peak: Cell<usize>,
    pub exhausted: Cell<bool>,
}

pub struct Watch {
    pub epoch: Instant,
    pub turn_started_ms: AtomicU64,
    pub stop_deadline_ms: AtomicU64,
}

impl Watch {
    pub fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64 + 1
    }
}

pub struct Governor {
    pub limits: Limits,
    pub heap: Heap,
    pub watch: Arc<Watch>,
    reason: Cell<Option<Exit>>,
    in_turn: Cell<bool>,
    turn_start_cpu: Cell<u64>,
    window: RefCell<VecDeque<(Instant, u64)>>,
    window_sum: Cell<u64>,
}

impl Governor {
    pub fn new(limits: Limits) -> Governor {
        Governor {
            heap: Heap { limit: limits.memory_bytes, used: Cell::new(0), peak: Cell::new(0), exhausted: Cell::new(false) },
            limits,
            watch: Arc::new(Watch { epoch: Instant::now(), turn_started_ms: AtomicU64::new(0), stop_deadline_ms: AtomicU64::new(0) }),
            reason: Cell::new(None),
            in_turn: Cell::new(false),
            turn_start_cpu: Cell::new(0),
            window: RefCell::new(VecDeque::new()),
            window_sum: Cell::new(0),
        }
    }

    pub fn reason(&self) -> Option<Exit> {
        if self.reason.get().is_none() {
            if self.heap.exhausted.get() {
                self.reason.set(Some(Exit::OutOfMemory));
            } else if TERMINATE.load(Ordering::Relaxed) {
                self.reason.set(Some(Exit::Normal));
            }
        }
        self.reason.get()
    }

    pub fn begin_turn(&self) {
        self.prune(Instant::now());
        self.turn_start_cpu.set(thread_cpu_ns());
        self.in_turn.set(true);
        self.watch.turn_started_ms.store(self.watch.now_ms(), Ordering::Relaxed);
    }

    pub fn end_turn(&self) {
        self.watch.turn_started_ms.store(0, Ordering::Relaxed);
        self.in_turn.set(false);
        let used = thread_cpu_ns().saturating_sub(self.turn_start_cpu.get());
        self.window.borrow_mut().push_back((Instant::now(), used));
        self.window_sum.set(self.window_sum.get() + used);
    }

    fn prune(&self, now: Instant) {
        let mut window = self.window.borrow_mut();
        while let Some(&(at, used)) = window.front() {
            if now.duration_since(at) < Duration::from_secs(60) {
                break;
            }
            window.pop_front();
            self.window_sum.set(self.window_sum.get() - used);
        }
    }

    pub fn minute_cpu_used(&self) -> Duration {
        Duration::from_nanos(self.window_sum.get())
    }

    pub fn should_interrupt(&self) -> bool {
        if self.reason().is_some() {
            return true;
        }
        if !self.in_turn.get() {
            return false;
        }
        let turn = thread_cpu_ns().saturating_sub(self.turn_start_cpu.get());
        if turn > self.limits.turn_cpu.as_nanos() as u64 || self.window_sum.get() + turn > self.limits.minute_cpu.as_nanos() as u64 {
            self.reason.set(Some(Exit::CpuBudget));
            return true;
        }
        false
    }

    pub fn arm_stop_deadline(&self) {
        if self.watch.stop_deadline_ms.load(Ordering::Relaxed) == 0 {
            let due = self.watch.now_ms() + self.limits.stop_grace.as_millis() as u64;
            self.watch.stop_deadline_ms.store(due, Ordering::Relaxed);
        }
    }

    pub fn stopping(&self) -> bool {
        self.watch.stop_deadline_ms.load(Ordering::Relaxed) != 0
    }

    pub fn stop_deadline_in(&self) -> Option<Duration> {
        let due = self.watch.stop_deadline_ms.load(Ordering::Relaxed);
        (due != 0).then(|| Duration::from_millis(due.saturating_sub(self.watch.now_ms())))
    }
}

pub fn spawn_watchdog(watch: Arc<Watch>, turn_wall: Duration) -> std::io::Result<()> {
    let (started, running) = std::sync::mpsc::sync_channel::<()>(0);
    std::thread::Builder::new().name("watchdog".into()).stack_size(64 << 10).spawn(move || {
        let _ = started.send(());
        drop(started);
        watchdog(&watch, turn_wall)
    })?;
    running.recv().map_err(|_| std::io::Error::other("the watchdog thread didn't start"))
}

fn watchdog(watch: &Watch, turn_wall: Duration) -> ! {
    loop {
        std::thread::sleep(Duration::from_millis(50));
        let now = watch.now_ms();
        let started = watch.turn_started_ms.load(Ordering::Relaxed);
        if started != 0 && now.saturating_sub(started) > turn_wall.as_millis() as u64 {
            crate::host::hard_exit(Exit::TurnWatchdog, "a turn ran past its wall-clock limit, so the plugin stopped");
        }
        let stop = watch.stop_deadline_ms.load(Ordering::Relaxed);
        if stop != 0 && now > stop {
            crate::host::hard_exit(Exit::ShutdownDeadline, "the plugin overstayed its stop grace, so it was ended");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_over_its_cpu_budget_is_interrupted() {
        let governor = Governor::new(Limits { turn_cpu: Duration::from_millis(30), ..Limits::default() });
        governor.begin_turn();
        assert!(!governor.should_interrupt());
        let start = Instant::now();
        while !governor.should_interrupt() {
            assert!(start.elapsed() < Duration::from_secs(5));
        }
        assert_eq!(governor.reason(), Some(Exit::CpuBudget));
    }

    #[test]
    fn short_turns_add_up_against_the_minute_budget() {
        let governor = Governor::new(Limits { turn_cpu: Duration::from_secs(5), minute_cpu: Duration::from_millis(60), ..Limits::default() });
        let start = Instant::now();
        let mut interrupted = false;
        while start.elapsed() < Duration::from_secs(5) && !interrupted {
            governor.begin_turn();
            let turn = thread_cpu_ns();
            while thread_cpu_ns() - turn < 10_000_000 {
                if governor.should_interrupt() {
                    interrupted = true;
                    break;
                }
            }
            governor.end_turn();
        }
        assert!(interrupted);
        assert!(governor.minute_cpu_used() >= Duration::from_millis(40));
        assert_eq!(governor.reason(), Some(Exit::CpuBudget));
    }

    #[test]
    fn idle_time_never_counts() {
        let governor = Governor::new(Limits { turn_cpu: Duration::from_millis(5), ..Limits::default() });
        governor.begin_turn();
        governor.end_turn();
        std::thread::sleep(Duration::from_millis(20));
        assert!(!governor.should_interrupt());
        assert_eq!(governor.reason(), None);
    }
}
