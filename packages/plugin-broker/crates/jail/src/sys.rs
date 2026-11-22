use std::ffi::CString;
use std::io;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub const CLOSE_RANGE_UNSHARE: u32 = 2;
pub const CLOSE_RANGE_CLOEXEC: u32 = 4;
pub const MS_NOSYMFOLLOW: libc::c_ulong = 256;
pub const ST_NOSYMFOLLOW: libc::c_ulong = 0x2000;
pub const ST_RELATIME: libc::c_ulong = 0x1000;

pub fn mount_flags_of(fd: RawFd) -> io::Result<u64> {
    let mut info: libc::statvfs = unsafe { std::mem::zeroed() };
    check(unsafe { libc::fstatvfs(fd, &mut info) })?;
    let flag = info.f_flag as libc::c_ulong;
    let pairs: [(libc::c_ulong, libc::c_ulong); 7] = [
        (libc::ST_NOSUID, libc::MS_NOSUID),
        (libc::ST_NODEV, libc::MS_NODEV),
        (libc::ST_NOEXEC, libc::MS_NOEXEC),
        (libc::ST_NOATIME, libc::MS_NOATIME),
        (libc::ST_NODIRATIME, libc::MS_NODIRATIME),
        (ST_RELATIME, libc::MS_RELATIME),
        (ST_NOSYMFOLLOW, MS_NOSYMFOLLOW),
    ];
    Ok(pairs
        .iter()
        .filter(|(st, _)| flag & st != 0)
        .fold(0, |flags, (_, ms)| flags | *ms))
}

pub fn last_error() -> io::Error {
    io::Error::last_os_error()
}

pub fn check(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 {
        Err(last_error())
    } else {
        Ok(result)
    }
}

pub fn check_long(result: libc::c_long) -> io::Result<libc::c_long> {
    if result < 0 {
        Err(last_error())
    } else {
        Ok(result)
    }
}

pub fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

pub fn cstring(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| invalid("a path holds a NUL byte"))
}

pub fn owned(fd: RawFd) -> OwnedFd {
    unsafe { OwnedFd::from_raw_fd(fd) }
}

pub fn openat(dir: RawFd, path: &Path, flags: i32, mode: u32) -> io::Result<OwnedFd> {
    let name = cstring(path)?;
    let fd = check(unsafe { libc::openat(dir, name.as_ptr(), flags | libc::O_CLOEXEC, mode) })?;
    Ok(owned(fd))
}

pub fn open_path(path: &Path) -> io::Result<OwnedFd> {
    openat(libc::AT_FDCWD, path, libc::O_PATH, 0)
}

pub fn open_dir(path: &Path) -> io::Result<OwnedFd> {
    openat(libc::AT_FDCWD, path, libc::O_PATH | libc::O_DIRECTORY, 0)
}

pub fn fstat(fd: RawFd) -> io::Result<libc::stat> {
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    check(unsafe { libc::fstat(fd, &mut info) })?;
    Ok(info)
}

pub fn is_dir(fd: RawFd) -> io::Result<bool> {
    Ok(fstat(fd)?.st_mode & libc::S_IFMT == libc::S_IFDIR)
}

pub fn identity(fd: RawFd) -> io::Result<(u64, u64)> {
    let info = fstat(fd)?;
    Ok((info.st_dev as u64, info.st_ino as u64))
}

pub fn fd_path(fd: RawFd) -> io::Result<PathBuf> {
    let path = std::fs::read_link(format!("/proc/self/fd/{fd}"))?;
    if !path.is_absolute() || path.as_os_str().as_bytes().ends_with(b" (deleted)") {
        return Err(invalid(format!(
            "fd {fd} has no usable path ({})",
            path.display()
        )));
    }
    Ok(path)
}

pub fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    check(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) })?;
    Ok((owned(fds[0]), owned(fds[1])))
}

pub fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = check(unsafe { libc::fcntl(fd, libc::F_GETFL) })?;
    check(unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) })?;
    Ok(())
}

pub fn write_all(fd: RawFd, mut data: &[u8]) -> io::Result<()> {
    while !data.is_empty() {
        let count = unsafe { libc::write(fd, data.as_ptr().cast(), data.len()) };
        if count < 0 {
            let error = last_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        data = &data[count as usize..];
    }
    Ok(())
}

pub fn write_all_by(fd: RawFd, mut data: &[u8], deadline: Instant) -> io::Result<()> {
    set_nonblocking(fd)?;
    while !data.is_empty() {
        let count = unsafe { libc::write(fd, data.as_ptr().cast(), data.len()) };
        if count >= 0 {
            data = &data[count as usize..];
            continue;
        }
        let error = last_error();
        match error.kind() {
            io::ErrorKind::Interrupted => continue,
            io::ErrorKind::WouldBlock => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "the write didn't finish in time",
                    ));
                }
                let mut entry = libc::pollfd {
                    fd,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                let timeout = left.as_millis().clamp(1, i32::MAX as u128) as i32;
                unsafe { libc::poll(&mut entry, 1, timeout) };
            }
            _ => return Err(error),
        }
    }
    Ok(())
}

pub fn try_wait_child(pid: i32) -> io::Result<Option<libc::c_int>> {
    let mut status = 0;
    loop {
        let got = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if got == pid {
            return Ok(Some(status));
        }
        if got == 0 {
            return Ok(None);
        }
        let error = last_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

pub fn read_some(fd: RawFd, buffer: &mut [u8]) -> io::Result<usize> {
    loop {
        let count = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
        if count >= 0 {
            return Ok(count as usize);
        }
        let error = last_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

pub fn read_to_end_capped(fd: RawFd, cap: usize) -> io::Result<Vec<u8>> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 16384];
    loop {
        let count = read_some(fd, &mut chunk)?;
        if count == 0 {
            return Ok(data);
        }
        if data.len() + count > cap {
            return Err(invalid(format!("more than {cap} bytes arrived")));
        }
        data.extend_from_slice(&chunk[..count]);
    }
}

pub fn wait_readable(fd: RawFd, deadline: Instant) -> io::Result<bool> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let timeout = left.as_millis().min(i32::MAX as u128) as i32;
        let mut entry = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut entry, 1, timeout) };
        if ready < 0 {
            let error = last_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if ready > 0 {
            return Ok(true);
        }
        if left.is_zero() {
            return Ok(false);
        }
    }
}

pub fn dup_above(fd: RawFd, minimum: RawFd) -> io::Result<OwnedFd> {
    Ok(owned(check(unsafe {
        libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, minimum)
    })?))
}

pub fn pidfd_open(pid: i32) -> io::Result<OwnedFd> {
    let fd = check_long(unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) })?;
    Ok(owned(fd as RawFd))
}

pub fn pidfd_signal(pidfd: RawFd, signal: i32) -> io::Result<()> {
    check_long(unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pidfd,
            signal,
            std::ptr::null::<u8>(),
            0,
        )
    })?;
    Ok(())
}

pub fn close_range(first: u32, last: u32, flags: u32) -> io::Result<()> {
    check_long(unsafe { libc::syscall(libc::SYS_close_range, first, last, flags) })?;
    Ok(())
}

pub fn close_all_except(kept: &[RawFd]) -> io::Result<()> {
    let mut kept: Vec<u32> = kept
        .iter()
        .filter(|fd| **fd >= 0)
        .map(|fd| *fd as u32)
        .collect();
    kept.sort_unstable();
    kept.dedup();
    let mut next = 0u32;
    for fd in kept {
        if fd > next {
            close_range(next, fd - 1, 0)?;
        }
        next = fd + 1;
    }
    close_range(next, u32::MAX, 0)
}

pub fn set_no_new_privs() -> io::Result<()> {
    check(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) })?;
    Ok(())
}

pub fn die_with_parent(expected_parent: i32) -> io::Result<()> {
    check(unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) })?;
    if unsafe { libc::getppid() } != expected_parent {
        return Err(invalid("the broker went away before the sandbox started"));
    }
    Ok(())
}

pub fn mkdir_at(dir: RawFd, name: &str, mode: u32) -> io::Result<()> {
    let name = cstring(Path::new(name))?;
    if unsafe { libc::mkdirat(dir, name.as_ptr(), mode) } != 0 {
        let error = last_error();
        if error.raw_os_error() != Some(libc::EEXIST) {
            return Err(error);
        }
    }
    Ok(())
}

pub fn wait_child(pid: i32) -> io::Result<libc::c_int> {
    let mut status = 0;
    loop {
        let got = unsafe { libc::waitpid(pid, &mut status, 0) };
        if got == pid {
            return Ok(status);
        }
        let error = last_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

pub fn mount_id(fd: RawFd) -> io::Result<u64> {
    const STATX_MNT_ID: u32 = 0x1000;
    let mut buffer = [0u8; 256];
    let result = unsafe {
        libc::syscall(
            libc::SYS_statx,
            fd,
            c"".as_ptr(),
            libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW,
            STATX_MNT_ID,
            buffer.as_mut_ptr(),
        )
    };
    if result == 0 {
        let mask = u32::from_ne_bytes(buffer[0..4].try_into().unwrap());
        if mask & STATX_MNT_ID != 0 {
            return Ok(u64::from_ne_bytes(buffer[0x90..0x98].try_into().unwrap()));
        }
    }
    let info = std::fs::read_to_string(format!("/proc/self/fdinfo/{fd}"))?;
    info.lines()
        .find_map(|line| line.strip_prefix("mnt_id:"))
        .and_then(|value| value.trim().parse().ok())
        .ok_or_else(|| invalid("the kernel reported no mount id"))
}

pub const RESOLVE_NO_XDEV: u64 = 0x01;
pub const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
pub const RESOLVE_NO_SYMLINKS: u64 = 0x04;
pub const RESOLVE_BENEATH: u64 = 0x08;

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

pub fn openat2(dir: RawFd, relative: &Path, flags: i32, resolve: u64) -> io::Result<OwnedFd> {
    let name = cstring(relative)?;
    let how = OpenHow {
        flags: (flags | libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve,
    };
    let fd = check_long(unsafe {
        libc::syscall(
            libc::SYS_openat2,
            dir,
            name.as_ptr(),
            &how as *const OpenHow,
            std::mem::size_of::<OpenHow>(),
        )
    })?;
    Ok(owned(fd as RawFd))
}
