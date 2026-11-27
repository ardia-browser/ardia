use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::path::Path;

use crate::sys;

pub const LOG_NAME: &str = "plugin.log";
pub const ROTATED_NAME: &str = "plugin.log.1";
pub const ROTATE_AT: u64 = 1 << 20;
pub const EMPTY_AT: u64 = 2 << 20;
pub const BUFFER_CAP: usize = 1 << 20;

#[derive(Debug, PartialEq, Eq)]
pub enum Drained {
    Bytes(usize),
    Idle,
    Closed,
    Backpressure,
}

pub struct LogPump {
    dir: OwnedFd,
    file: Option<OwnedFd>,
    pending: Vec<u8>,
}

impl LogPump {
    pub fn new(dir: OwnedFd) -> LogPump {
        LogPump {
            dir,
            file: None,
            pending: Vec::new(),
        }
    }

    fn open(&mut self) -> io::Result<RawFd> {
        if self.file.is_none() {
            let flags = libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT | libc::O_NOFOLLOW;
            self.file = Some(sys::openat(
                self.dir.as_raw_fd(),
                Path::new(LOG_NAME),
                flags,
                0o600,
            )?);
        }
        Ok(self.file.as_ref().unwrap().as_raw_fd())
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file = None;
        let from = sys::cstring(Path::new(LOG_NAME))?;
        let to = sys::cstring(Path::new(ROTATED_NAME))?;
        sys::check(unsafe {
            libc::renameat(
                self.dir.as_raw_fd(),
                from.as_ptr(),
                self.dir.as_raw_fd(),
                to.as_ptr(),
            )
        })?;
        Ok(())
    }

    fn append(&mut self, data: &[u8]) -> io::Result<()> {
        let fd = self.open()?;
        let size = sys::fstat(fd)?.st_size as u64;
        if size >= EMPTY_AT {
            sys::check(unsafe { libc::ftruncate(fd, 0) })?;
        } else if size + data.len() as u64 > ROTATE_AT && size > 0 && self.rotate().is_err() {
            let fd = self.open()?;
            sys::check(unsafe { libc::ftruncate(fd, 0) })?;
        }
        let fd = self.open()?;
        sys::write_all(fd, data)
    }

    pub fn flush(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let data = std::mem::take(&mut self.pending);
        match self.append(&data) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.pending = data;
                Err(error)
            }
        }
    }

    pub fn drain(&mut self, from: RawFd) -> io::Result<Drained> {
        if self.pending.len() >= BUFFER_CAP {
            self.flush()?;
            if self.pending.len() >= BUFFER_CAP {
                return Ok(Drained::Backpressure);
            }
        }
        let mut chunk = vec![0u8; 65536.min(BUFFER_CAP - self.pending.len())];
        let count = match sys::read_some(from, &mut chunk) {
            Ok(0) => {
                self.flush()?;
                return Ok(Drained::Closed);
            }
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(Drained::Idle),
            Err(error) => return Err(error),
        };
        self.pending.extend_from_slice(&chunk[..count]);
        let _ = self.flush();
        Ok(Drained::Bytes(count))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn the_log_rotates_at_one_megabyte() {
        let dir = std::env::temp_dir().join(format!("jail-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut pump = LogPump::new(
            sys::openat(libc::AT_FDCWD, &dir, libc::O_RDONLY | libc::O_DIRECTORY, 0).unwrap(),
        );
        let (read, write) = sys::pipe().unwrap();
        sys::set_nonblocking(read.as_raw_fd()).unwrap();
        let line = vec![b'x'; 60000];
        for _ in 0..20 {
            sys::write_all(write.as_raw_fd(), &line).unwrap();
            while let Drained::Bytes(_) = pump.drain(read.as_raw_fd()).unwrap() {}
        }
        drop(write);
        assert_eq!(pump.drain(read.as_raw_fd()).unwrap(), Drained::Closed);
        let current = fs::metadata(dir.join(LOG_NAME)).unwrap().len();
        let rotated = fs::metadata(dir.join(ROTATED_NAME)).unwrap().len();
        assert!(current <= ROTATE_AT, "{current}");
        assert!(rotated <= ROTATE_AT && rotated > 0, "{rotated}");
        assert_eq!(current + rotated, 1_200_000);
        fs::remove_dir_all(dir).unwrap();
    }
}
