use crate::governor::TERMINATE;
use std::sync::atomic::Ordering;

const STDERR: i32 = 2;

pub fn make_nonblocking() -> bool {
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(STDERR, &mut info) } != 0 {
        return false;
    }
    let kind = info.st_mode & libc::S_IFMT;
    if kind != libc::S_IFIFO && kind != libc::S_IFSOCK {
        return false;
    }
    unsafe {
        let flags = libc::fcntl(STDERR, libc::F_GETFL);
        flags >= 0 && libc::fcntl(STDERR, libc::F_SETFL, flags | libc::O_NONBLOCK) == 0
    }
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn wait_writable() -> bool {
    loop {
        if TERMINATE.load(Ordering::Relaxed) {
            return false;
        }
        let mut fd = libc::pollfd { fd: STDERR, events: libc::POLLOUT, revents: 0 };
        let ready = unsafe { libc::poll(&mut fd, 1, -1) };
        if ready > 0 {
            return fd.revents & (libc::POLLERR | libc::POLLNVAL) == 0;
        }
        if ready < 0 && errno() != libc::EINTR {
            return false;
        }
    }
}

fn write_all(mut bytes: &[u8], wait: bool) {
    while !bytes.is_empty() {
        let count = unsafe { libc::write(STDERR, bytes.as_ptr().cast(), bytes.len()) };
        if count > 0 {
            bytes = &bytes[count as usize..];
            continue;
        }
        let error = errno();
        if count < 0 && error == libc::EINTR {
            continue;
        }
        if count < 0 && (error == libc::EAGAIN || error == libc::EWOULDBLOCK) && wait && wait_writable() {
            continue;
        }
        return;
    }
}

fn with_newline(text: &str, wait: bool) {
    write_all(text.as_bytes(), wait);
    if !text.ends_with('\n') {
        write_all(b"\n", wait);
    }
}

pub fn log(text: &str) {
    with_newline(text, true);
}

pub fn note(text: &str) {
    with_newline(text, false);
}

pub fn last_words(message: &'static str) {
    let mut line = [0u8; 256];
    let prefix = b"[ardia] ";
    let body = message.as_bytes();
    let length = (prefix.len() + body.len() + 1).min(line.len());
    line[..prefix.len()].copy_from_slice(prefix);
    let room = length - prefix.len() - 1;
    line[prefix.len()..prefix.len() + room].copy_from_slice(&body[..room]);
    line[length - 1] = b'\n';
    unsafe { libc::write(STDERR, line.as_ptr().cast(), length) };
}
