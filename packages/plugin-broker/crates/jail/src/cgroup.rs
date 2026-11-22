use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::sys;

pub const RUN_PIDS_MAX: u64 = 512;
pub const UNSURE_REMOVAL_GRACE: Duration = Duration::from_secs(30);

fn random_u64() -> io::Result<u64> {
    let mut bytes = [0u8; 8];
    let got = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), 8, 0) };
    if got != 8 {
        return Err(sys::last_error());
    }
    Ok(u64::from_ne_bytes(bytes))
}

fn write_at(dir: RawFd, name: &str, value: &str) -> io::Result<()> {
    let file = sys::openat(dir, Path::new(name), libc::O_WRONLY, 0)?;
    sys::write_all(file.as_raw_fd(), value.as_bytes())
}

fn read_at(dir: RawFd, name: &str) -> io::Result<String> {
    let file = sys::openat(dir, Path::new(name), libc::O_RDONLY, 0)?;
    let bytes = sys::read_to_end_capped(file.as_raw_fd(), 1 << 16)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn writable(dir: RawFd, name: &str) -> bool {
    let Ok(name) = std::ffi::CString::new(name) else {
        return false;
    };
    unsafe { libc::faccessat(dir, name.as_ptr(), libc::W_OK, 0) == 0 }
}

pub fn own_cgroup_path() -> io::Result<PathBuf> {
    let text = std::fs::read_to_string("/proc/self/cgroup")?;
    let relative = text
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .ok_or_else(|| sys::invalid("this process isn't on the unified cgroup hierarchy"))?;
    Ok(Path::new("/sys/fs/cgroup").join(relative.trim_start_matches('/')))
}

#[derive(Debug)]
pub struct CgroupDelegate {
    counter: AtomicU64,
    root: OwnedFd,
    path: PathBuf,
    memory: bool,
    pids: bool,
}

impl CgroupDelegate {
    pub fn from_own_scope() -> io::Result<Option<CgroupDelegate>> {
        let path = own_cgroup_path()?;
        let root = match sys::openat(libc::AT_FDCWD, &path, libc::O_RDONLY | libc::O_DIRECTORY, 0) {
            Ok(fd) => fd,
            Err(_) => return Ok(None),
        };
        let owner = sys::fstat(root.as_raw_fd())?.st_uid;
        if owner != unsafe { libc::getuid() }
            || !writable(root.as_raw_fd(), "cgroup.procs")
            || !writable(root.as_raw_fd(), "cgroup.subtree_control")
        {
            return Ok(None);
        }
        sys::mkdir_at(root.as_raw_fd(), "supervisor", 0o755)?;
        let leaf = sys::openat(
            root.as_raw_fd(),
            Path::new("supervisor"),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        write_at(
            leaf.as_raw_fd(),
            "cgroup.procs",
            &std::process::id().to_string(),
        )?;
        let available = read_at(root.as_raw_fd(), "cgroup.controllers")?;
        let mut memory = false;
        let mut pids = false;
        for controller in available.split_whitespace() {
            let wanted = controller == "memory" || controller == "pids";
            if wanted
                && write_at(
                    root.as_raw_fd(),
                    "cgroup.subtree_control",
                    &format!("+{controller}"),
                )
                .is_ok()
            {
                memory |= controller == "memory";
                pids |= controller == "pids";
            }
        }
        Ok(Some(CgroupDelegate {
            counter: AtomicU64::new(0),
            root,
            path,
            memory,
            pids,
        }))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn create_run(&self, memory_max: u64) -> io::Result<RunCgroup> {
        let mut collision = None;
        for _ in 0..4 {
            let name = format!(
                "run-{}-{}-{:016x}",
                std::process::id(),
                self.counter.fetch_add(1, Ordering::Relaxed),
                random_u64()?
            );
            let cname = sys::cstring(Path::new(&name))?;
            if unsafe { libc::mkdirat(self.root.as_raw_fd(), cname.as_ptr(), 0o755) } != 0 {
                let error = sys::last_error();
                if error.raw_os_error() == Some(libc::EEXIST) {
                    collision = Some(error);
                    continue;
                }
                return Err(error);
            }
            return match self.configure(&name, memory_max) {
                Ok(run) => Ok(run),
                Err(error) => {
                    unsafe {
                        libc::unlinkat(self.root.as_raw_fd(), cname.as_ptr(), libc::AT_REMOVEDIR)
                    };
                    Err(error)
                }
            };
        }
        Err(collision.unwrap_or_else(|| sys::invalid("no free cgroup name")))
    }

    fn configure(&self, name: &str, memory_max: u64) -> io::Result<RunCgroup> {
        let dir = sys::openat(
            self.root.as_raw_fd(),
            Path::new(name),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        if self.pids {
            write_at(dir.as_raw_fd(), "pids.max", &RUN_PIDS_MAX.to_string())?;
        }
        if self.memory && memory_max > 0 {
            write_at(dir.as_raw_fd(), "memory.max", &memory_max.to_string())?;
            let _ = write_at(dir.as_raw_fd(), "memory.swap.max", "0");
        }
        let procs = sys::openat(
            dir.as_raw_fd(),
            Path::new("cgroup.procs"),
            libc::O_WRONLY,
            0,
        )?;
        let parent = self.root.try_clone()?;
        Ok(RunCgroup {
            parent,
            dir,
            procs,
            name: name.to_string(),
            unsure_since: Mutex::new(None),
        })
    }
}

#[derive(Debug)]
pub enum Removal {
    Removed,
    Busy,
    GaveUp(io::Error),
}

#[derive(Debug)]
pub struct RunCgroup {
    parent: OwnedFd,
    dir: OwnedFd,
    procs: OwnedFd,
    name: String,
    unsure_since: Mutex<Option<Instant>>,
}

impl RunCgroup {
    pub fn procs_fd(&self) -> RawFd {
        self.procs.as_raw_fd()
    }

    pub fn kill(&self) -> io::Result<()> {
        if write_at(self.dir.as_raw_fd(), "cgroup.kill", "1").is_ok() {
            return Ok(());
        }
        for pid in self.members() {
            if let Ok(pidfd) = sys::pidfd_open(pid) {
                if self.members().contains(&pid) {
                    let _ = sys::pidfd_signal(pidfd.as_raw_fd(), libc::SIGKILL);
                }
            }
        }
        Ok(())
    }

    pub fn has_kill_file(&self) -> bool {
        writable(self.dir.as_raw_fd(), "cgroup.kill")
    }

    pub fn populated(&self) -> Option<bool> {
        read_at(self.dir.as_raw_fd(), "cgroup.events")
            .ok()
            .map(|events| events.lines().any(|line| line.trim() == "populated 1"))
    }

    pub fn members(&self) -> Vec<i32> {
        read_at(self.dir.as_raw_fd(), "cgroup.procs")
            .map(|text| {
                text.lines()
                    .filter_map(|line| line.trim().parse().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn memory_current(&self) -> Option<u64> {
        read_at(self.dir.as_raw_fd(), "memory.current")
            .ok()?
            .trim()
            .parse()
            .ok()
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn try_remove(&self) -> Removal {
        let populated = self.populated();
        if populated != Some(false) {
            let _ = self.kill();
        }
        if populated == Some(true) {
            return Removal::Busy;
        }
        let name = match sys::cstring(Path::new(&self.name)) {
            Ok(name) => name,
            Err(error) => return Removal::GaveUp(error),
        };
        if unsafe { libc::unlinkat(self.parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }
            == 0
        {
            return Removal::Removed;
        }
        let error = sys::last_error();
        match error.raw_os_error() {
            Some(libc::ENOENT) => Removal::Removed,
            Some(libc::EBUSY) | Some(libc::ENOTEMPTY) | Some(libc::EAGAIN) | Some(libc::EINTR) => {
                Removal::Busy
            }
            _ if populated.is_none() && !self.unsure_for_too_long() => Removal::Busy,
            _ => Removal::GaveUp(error),
        }
    }

    fn unsure_for_too_long(&self) -> bool {
        let Ok(mut since) = self.unsure_since.lock() else {
            return true;
        };
        since.get_or_insert_with(Instant::now).elapsed() >= UNSURE_REMOVAL_GRACE
    }

    pub fn give_up(&self, error: &io::Error) {
        let _ = sys::write_all(
            2,
            format!(
                "[ardia] the run's cgroup {} can't be removed ({error}), so it's left behind\n",
                self.name
            )
            .as_bytes(),
        );
    }

    pub fn empty_and_remove(self, deadline: Instant) -> Result<(), RunCgroup> {
        loop {
            match self.try_remove() {
                Removal::Removed => return Ok(()),
                Removal::GaveUp(error) => {
                    self.give_up(&error);
                    return Ok(());
                }
                Removal::Busy => {}
            }
            if Instant::now() >= deadline {
                return Err(self);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_permanent_removal_error_is_given_up_once_empty_or_unsure_for_too_long() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let base = std::env::temp_dir().join(format!("jail-cgroup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("run-x")).unwrap();
        let open_dir = |path: &Path| {
            sys::openat(libc::AT_FDCWD, path, libc::O_RDONLY | libc::O_DIRECTORY, 0).unwrap()
        };
        let run = RunCgroup {
            parent: open_dir(&base),
            dir: open_dir(&base.join("run-x")),
            procs: open_dir(&base.join("run-x")),
            name: "run-x".into(),
            unsure_since: Mutex::new(None),
        };
        let events = base.join("run-x/cgroup.events");
        std::fs::write(&events, "populated 0\nfrozen 0\n").unwrap();
        std::fs::set_permissions(&base, std::os::unix::fs::PermissionsExt::from_mode(0o555))
            .unwrap();
        let known_empty = run.try_remove();
        std::fs::remove_file(&events).unwrap();
        let unknown = run.try_remove();
        let unknown_again = run.try_remove();
        *run.unsure_since.lock().unwrap() = Some(Instant::now() - UNSURE_REMOVAL_GRACE);
        let unknown_for_too_long = run.try_remove();
        std::fs::set_permissions(&base, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        assert!(matches!(known_empty, Removal::GaveUp(_)), "{known_empty:?}");
        assert!(matches!(unknown, Removal::Busy), "{unknown:?}");
        assert!(matches!(unknown_again, Removal::Busy), "{unknown_again:?}");
        assert!(
            matches!(unknown_for_too_long, Removal::GaveUp(_)),
            "{unknown_for_too_long:?}"
        );
        assert!(matches!(run.try_remove(), Removal::Removed));
        std::fs::remove_dir_all(base).unwrap();
    }
}
