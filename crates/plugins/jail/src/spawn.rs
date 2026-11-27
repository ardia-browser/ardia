use std::ffi::CString;
use std::io;
use std::os::fd::{OwnedFd, RawFd};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::sys;

pub const SPAWN_ERROR_FD: RawFd = 5;
const LOWEST_SOURCE_FD: RawFd = 64;

pub struct ForkSpec {
    pub exe: RawFd,
    pub argv: Vec<CString>,
    pub envp: Vec<CString>,
    pub fds: Vec<(RawFd, RawFd)>,
    pub cgroup_procs: Option<RawFd>,
    pub new_session: bool,
}

impl ForkSpec {
    fn check(&self) -> io::Result<()> {
        if self.exe < LOWEST_SOURCE_FD {
            return Err(sys::invalid(
                "the executable fd must sit above the child's fd range",
            ));
        }
        for (source, target) in &self.fds {
            if *source < LOWEST_SOURCE_FD || *target >= LOWEST_SOURCE_FD || *target < 0 {
                return Err(sys::invalid("child fds map from 64 and up onto 0..63"));
            }
        }
        Ok(())
    }
}

unsafe fn reset_signals() {
    let mut empty: libc::sigset_t = std::mem::zeroed();
    libc::sigemptyset(&mut empty);
    libc::pthread_sigmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
    for signal in 1..65 {
        if signal == libc::SIGKILL || signal == libc::SIGSTOP {
            continue;
        }
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = libc::SIG_DFL;
        libc::sigaction(signal, &action, std::ptr::null_mut());
    }
}

unsafe fn child_fail(what: &[u8]) -> ! {
    let _ = libc::write(SPAWN_ERROR_FD, what.as_ptr().cast(), what.len());
    libc::_exit(127)
}

unsafe fn run_child(
    spec: &ForkSpec,
    holes: &[(u32, u32)],
    error_source: Option<RawFd>,
    argv: &[*const libc::c_char],
    envp: &[*const libc::c_char],
    parent: i32,
) -> ! {
    reset_signals();
    match error_source {
        Some(source) => {
            if libc::dup2(source, SPAWN_ERROR_FD) < 0 {
                libc::_exit(127);
            }
        }
        None => {
            libc::close(SPAWN_ERROR_FD);
        }
    }
    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
        child_fail(b"error spawn-parent-death-signal\n");
    }
    if libc::getppid() != parent {
        child_fail(b"error spawn-parent-gone\n");
    }
    if spec.new_session {
        libc::setsid();
    }
    if let Some(procs) = spec.cgroup_procs {
        if libc::write(procs, b"0".as_ptr().cast(), 1) != 1 {
            child_fail(b"error spawn-cgroup\n");
        }
    }
    let mut highest = 2;
    for (source, target) in &spec.fds {
        if libc::dup2(*source, *target) < 0 {
            child_fail(b"error spawn-fds\n");
        }
        highest = highest.max(*target);
    }
    for (first, last) in holes {
        if libc::syscall(libc::SYS_close_range, *first, *last, 0u32) != 0 {
            child_fail(b"error spawn-close\n");
        }
    }
    if libc::syscall(
        libc::SYS_close_range,
        (highest + 1) as u32,
        u32::MAX,
        sys::CLOSE_RANGE_CLOEXEC,
    ) != 0
    {
        child_fail(b"error spawn-close\n");
    }
    libc::syscall(
        libc::SYS_execveat,
        spec.exe,
        c"".as_ptr(),
        argv.as_ptr(),
        envp.as_ptr(),
        libc::AT_EMPTY_PATH,
    );
    child_fail(b"error spawn-exec\n")
}

pub fn holes(targets: &[RawFd]) -> Vec<(u32, u32)> {
    let mut used: Vec<RawFd> = targets.iter().copied().filter(|fd| *fd > 2).collect();
    used.sort_unstable();
    used.dedup();
    let mut holes = Vec::new();
    let mut next = 3;
    for fd in used {
        if fd > next {
            holes.push((next as u32, (fd - 1) as u32));
        }
        next = fd + 1;
    }
    holes
}

fn fork_exec(spec: ForkSpec, orphans: &Mutex<Vec<i32>>) -> io::Result<(i32, OwnedFd)> {
    spec.check()?;
    let error_source = spec
        .fds
        .iter()
        .find(|(_, target)| *target == SPAWN_ERROR_FD)
        .map(|(source, _)| *source);
    let targets: Vec<RawFd> = spec.fds.iter().map(|(_, target)| *target).collect();
    let holes = holes(&targets);
    let mut argv: Vec<*const libc::c_char> = spec.argv.iter().map(|arg| arg.as_ptr()).collect();
    argv.push(std::ptr::null());
    let mut envp: Vec<*const libc::c_char> = spec.envp.iter().map(|arg| arg.as_ptr()).collect();
    envp.push(std::ptr::null());
    let parent = std::process::id() as i32;
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(sys::last_error());
    }
    if pid == 0 {
        unsafe { run_child(&spec, &holes, error_source, &argv, &envp, parent) }
    }
    match sys::pidfd_open(pid) {
        Ok(pidfd) => Ok((pid, pidfd)),
        Err(error) => {
            unsafe { libc::kill(pid, libc::SIGKILL) };
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                match sys::try_wait_child(pid) {
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Ok(None) => {
                        if let Ok(mut list) = orphans.lock() {
                            list.push(pid);
                        }
                        break;
                    }
                    _ => break,
                }
            }
            Err(error)
        }
    }
}

type Job = Box<dyn FnOnce() + Send>;

pub struct Spawner {
    jobs: Option<mpsc::Sender<Job>>,
    thread: Option<thread::JoinHandle<()>>,
    orphans: Arc<Mutex<Vec<i32>>>,
}

impl Spawner {
    pub fn start() -> io::Result<Spawner> {
        let (jobs, inbox) = mpsc::channel::<Job>();
        let thread = thread::Builder::new()
            .name("jail-spawner".into())
            .spawn(move || {
                for job in inbox {
                    job();
                }
            })?;
        Ok(Spawner {
            jobs: Some(jobs),
            thread: Some(thread),
            orphans: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub fn spawn(&self, spec: ForkSpec) -> io::Result<(i32, OwnedFd)> {
        let (reply, answer) = mpsc::channel();
        let orphans = Arc::clone(&self.orphans);
        let job: Job = Box::new(move || {
            let _ = reply.send(fork_exec(spec, &orphans));
        });
        self.jobs
            .as_ref()
            .ok_or_else(|| sys::invalid("the spawner has stopped"))?
            .send(job)
            .map_err(|_| sys::invalid("the spawner thread is gone"))?;
        answer
            .recv()
            .map_err(|_| sys::invalid("the spawner thread didn't answer"))?
    }
}

impl Spawner {
    pub fn take_orphans(&self) -> Vec<i32> {
        self.orphans
            .lock()
            .map(|mut list| std::mem::take(&mut *list))
            .unwrap_or_default()
    }

    pub fn reap_orphans(&self) -> usize {
        let Ok(mut list) = self.orphans.lock() else {
            return 0;
        };
        list.retain(|pid| matches!(sys::try_wait_child(*pid), Ok(None)));
        list.len()
    }
}

impl Drop for Spawner {
    fn drop(&mut self) {
        self.jobs = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn lift(fd: RawFd) -> io::Result<OwnedFd> {
    sys::dup_above(fd, LOWEST_SOURCE_FD)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holes_cover_every_unmapped_fd_below_the_highest_target() {
        assert_eq!(holes(&[0, 1, 2, 3, 4, 5]), vec![]);
        assert_eq!(holes(&[0, 1, 2, 3, 6, 9]), vec![(4, 5), (7, 8)]);
        assert_eq!(holes(&[0, 1, 2, 13]), vec![(3, 12)]);
    }
}
