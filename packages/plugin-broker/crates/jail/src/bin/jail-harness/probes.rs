use std::ffi::CString;
use std::os::fd::RawFd;

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn c(text: &str) -> CString {
    CString::new(text).unwrap()
}

pub struct Report {
    out: RawFd,
    pub denied: u32,
    pub escaped: u32,
}

impl Report {
    pub fn new(out: RawFd) -> Report {
        Report {
            out,
            denied: 0,
            escaped: 0,
        }
    }

    pub fn line(&self, text: &str) {
        let data = format!("{text}\n");
        unsafe { libc::write(self.out, data.as_ptr().cast(), data.len()) };
    }

    fn record(&mut self, name: &str, escaped: bool, detail: String) {
        if escaped {
            self.escaped += 1;
        } else {
            self.denied += 1;
        }
        self.line(&format!(
            "RESULT {name} {} {detail}",
            if escaped { "ESCAPED" } else { "denied" }
        ));
    }

    pub fn finish(&self) {
        self.line(&format!(
            "DONE denied={} escaped={}",
            self.denied, self.escaped
        ));
    }
}

fn try_socket(domain: i32, kind: i32, protocol: i32) -> (bool, String) {
    let fd = unsafe { libc::socket(domain, kind, protocol) };
    if fd >= 0 {
        unsafe { libc::close(fd) };
        return (true, "socket created".into());
    }
    (false, format!("errno={}", errno()))
}

fn unix_address(path: &[u8], abstract_name: bool) -> (libc::sockaddr_un, libc::socklen_t) {
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    let offset = if abstract_name { 1 } else { 0 };
    for (index, byte) in path.iter().enumerate().take(100) {
        address.sun_path[index + offset] = *byte as libc::c_char;
    }
    let length = std::mem::size_of::<libc::sa_family_t>()
        + offset
        + path.len()
        + if abstract_name { 0 } else { 1 };
    (address, length as libc::socklen_t)
}

fn try_connect(path: &str, abstract_name: bool) -> (bool, String) {
    if path.is_empty() {
        return (false, "no target".into());
    }
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return (false, format!("socket errno={}", errno()));
    }
    let (address, length) = unix_address(path.as_bytes(), abstract_name);
    let result = unsafe {
        libc::connect(
            fd,
            &address as *const libc::sockaddr_un as *const libc::sockaddr,
            length,
        )
    };
    let detail = if result == 0 {
        "connected".to_string()
    } else {
        format!("connect errno={}", errno())
    };
    unsafe { libc::close(fd) };
    (result == 0, detail)
}

fn try_read(path: &str) -> (bool, String) {
    if path.is_empty() {
        return (false, "no target".into());
    }
    let fd = unsafe { libc::open(c(path).as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
    if fd < 0 {
        return (false, format!("open errno={}", errno()));
    }
    let mut buffer = [0u8; 64];
    let count = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
    let error = errno();
    unsafe { libc::close(fd) };
    if count > 0 {
        (true, format!("read {count} bytes"))
    } else {
        (false, format!("opened but read errno={error}"))
    }
}

fn list_names(path: &str) -> Result<Vec<String>, i32> {
    let fd = unsafe {
        libc::open(
            c(path).as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(errno());
    }
    let mut buffer = [0u8; 8192];
    let count =
        unsafe { libc::syscall(libc::SYS_getdents64, fd, buffer.as_mut_ptr(), buffer.len()) };
    let error = errno();
    unsafe { libc::close(fd) };
    if count < 0 {
        return Err(error);
    }
    let mut names = Vec::new();
    let mut at = 0usize;
    while at + 19 < count as usize {
        let length = u16::from_ne_bytes([buffer[at + 16], buffer[at + 17]]) as usize;
        let name = &buffer[at + 19..at + length];
        let end = name.iter().position(|b| *b == 0).unwrap_or(name.len());
        let name = String::from_utf8_lossy(&name[..end]).into_owned();
        if name != "." && name != ".." {
            names.push(name);
        }
        at += length.max(1);
    }
    Ok(names)
}

fn try_list(path: &str, skeleton: &[&str]) -> (bool, String) {
    match list_names(path) {
        Err(error) => (false, format!("open errno={error}")),
        Ok(names) => {
            let exposed: Vec<&String> = names
                .iter()
                .filter(|name| !skeleton.contains(&name.as_str()))
                .collect();
            (!exposed.is_empty(), format!("entries {names:?}"))
        }
    }
}

fn any(attempts: &[(bool, String)]) -> (bool, String) {
    let escaped = attempts.iter().any(|(escaped, _)| *escaped);
    let detail = attempts
        .iter()
        .map(|(_, detail)| detail.as_str())
        .collect::<Vec<_>>()
        .join("; ");
    (escaped, detail)
}

fn file_len(path: &str) -> i64 {
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::stat(c(path).as_ptr(), &mut info) } == 0 {
        info.st_size
    } else {
        0
    }
}

fn try_truncate(path: &str) -> (bool, i32) {
    let result = unsafe { libc::truncate(c(path).as_ptr(), file_len(path)) };
    (result == 0, if result == 0 { 0 } else { errno() })
}

fn try_rename(from: &str, to: &str) -> (bool, String) {
    let result = unsafe { libc::rename(c(from).as_ptr(), c(to).as_ptr()) };
    if result == 0 {
        unsafe { libc::rename(c(to).as_ptr(), c(from).as_ptr()) };
        return (true, format!("renamed {from} -> {to}"));
    }
    (
        false,
        format!("{} errno={}", to.rsplit('/').next().unwrap_or(""), errno()),
    )
}

fn same_times(info: &libc::stat) -> [libc::timespec; 2] {
    [
        libc::timespec {
            tv_sec: info.st_atime,
            tv_nsec: info.st_atime_nsec,
        },
        libc::timespec {
            tv_sec: info.st_mtime,
            tv_nsec: info.st_mtime_nsec,
        },
    ]
}

fn try_metadata() -> (bool, String) {
    let mut attempts = Vec::new();
    let exe = c("/proc/self/exe");
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::stat(exe.as_ptr(), &mut info) } == 0 {
        let chmod = unsafe { libc::chmod(exe.as_ptr(), info.st_mode & 0o7777) };
        let chmod_errno = if chmod == 0 { 0 } else { errno() };
        let times = same_times(&info);
        let touch = unsafe { libc::utimensat(libc::AT_FDCWD, exe.as_ptr(), times.as_ptr(), 0) };
        let touch_errno = if touch == 0 { 0 } else { errno() };
        attempts.push((chmod == 0, format!("chmod(exe) errno={chmod_errno}")));
        attempts.push((touch == 0, format!("utimensat(exe) errno={touch_errno}")));
    } else {
        attempts.push((false, format!("stat(exe) errno={}", errno())));
    }
    let mut files = 0;
    for fd in 0..1024 {
        let mut info: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut info) } != 0
            || info.st_mode & libc::S_IFMT != libc::S_IFREG
        {
            continue;
        }
        files += 1;
        let chmod = unsafe { libc::fchmod(fd, info.st_mode & 0o7777) };
        let chmod_errno = if chmod == 0 { 0 } else { errno() };
        let times = same_times(&info);
        let touch = unsafe { libc::futimens(fd, times.as_ptr()) };
        let touch_errno = if touch == 0 { 0 } else { errno() };
        attempts.push((chmod == 0, format!("fchmod({fd}) errno={chmod_errno}")));
        attempts.push((touch == 0, format!("futimens({fd}) errno={touch_errno}")));
    }
    attempts.push((false, format!("regular-file fds={files}")));
    any(&attempts)
}

pub struct Context {
    pub level: String,
    pub kind: String,
    pub in_jail: bool,
    pub allowed_fds: Vec<i32>,
    pub values: std::collections::HashMap<String, String>,
}

impl Context {
    pub fn from_env(level: &str, kind: &str, in_jail: bool) -> Context {
        Context {
            level: level.into(),
            kind: kind.into(),
            in_jail,
            allowed_fds: Vec::new(),
            values: std::env::vars()
                .filter(|(name, _)| name.starts_with("PROBE_"))
                .collect(),
        }
    }

    pub fn from_text(text: &str, level: &str, kind: &str) -> Context {
        Context {
            level: level.into(),
            kind: kind.into(),
            in_jail: true,
            allowed_fds: Vec::new(),
            values: text
                .lines()
                .filter_map(|line| line.split_once('='))
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
        }
    }

    pub fn get(&self, name: &str) -> String {
        self.values.get(name).cloned().unwrap_or_default()
    }
}

fn data_in_jail() -> String {
    std::env::var("HOME")
        .ok()
        .and_then(|home| {
            std::path::Path::new(&home)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
        })
        .unwrap_or_default()
}

pub fn run_all(report: &mut Report, context: &Context) {
    let env = |name: &str| context.get(name);
    let env_pid = |name: &str| context.get(name).parse::<i32>().unwrap_or(0);
    let host = context.kind == "host";
    let outside_plugin = env("PROBE_PLUGIN_DIR");
    let plugin = if context.in_jail {
        ".".to_string()
    } else {
        outside_plugin.clone()
    };
    let data = match (context.in_jail, host) {
        (false, _) => env("PROBE_DATA_DIR"),
        (true, true) => String::new(),
        (true, false) => data_in_jail(),
    };
    let victim_dir = env("PROBE_VICTIM_DIR");
    let victim_file = env("PROBE_VICTIM_FILE");
    let home = env("PROBE_HOME");
    let canary = env_pid("PROBE_CANARY_PID");
    let browser = env_pid("PROBE_BROWSER_PID");

    let (escaped, detail) = try_socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
    report.record("socket-unix-stream", escaped, detail);
    let (escaped, detail) = try_socket(libc::AF_UNIX, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0);
    report.record("socket-unix-dgram", escaped, detail);
    let (escaped, detail) = try_socket(libc::AF_NETLINK, libc::SOCK_RAW, libc::NETLINK_ROUTE);
    report.record("socket-netlink", escaped, detail);
    let (escaped, detail) = try_socket(libc::AF_INET, libc::SOCK_STREAM, 0);
    report.record("socket-inet-tcp", escaped, detail);
    let (escaped, detail) = try_socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_NONBLOCK, 0);
    report.record("socket-inet-udp", escaped, detail);
    let (escaped, detail) = try_socket(libc::AF_INET6, libc::SOCK_STREAM, 0);
    report.record("socket-inet6-tcp", escaped, detail);
    let (escaped, detail) = try_socket(libc::AF_PACKET, libc::SOCK_RAW, 0);
    report.record("socket-packet", escaped, detail);
    let mut pair = [0; 2];
    let result = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_DGRAM, 0, pair.as_mut_ptr()) };
    if result == 0 {
        unsafe {
            libc::close(pair[0]);
            libc::close(pair[1]);
        }
    }
    report.record(
        "socketpair-unix-dgram",
        result == 0,
        format!("errno={}", if result == 0 { 0 } else { errno() }),
    );

    let (escaped, detail) = try_connect(&env("PROBE_CONTROL_SOCKET"), false);
    report.record("connect-control-socket", escaped, detail);
    let (escaped, detail) = try_connect(&env("PROBE_DBUS_SOCKET"), false);
    report.record("connect-session-bus", escaped, detail);
    let (escaped, detail) = try_connect(&env("PROBE_ABSTRACT_SOCKET"), true);
    report.record("connect-abstract-x11", escaped, detail);

    let (escaped, detail) = try_read(&env("PROBE_HOME_SECRET"));
    report.record("read-home", escaped, detail);
    let (escaped, detail) = any(&[
        try_list(&env("PROBE_REAL_HOME"), &[]),
        try_list(&home, &[".config", ".local"]),
    ]);
    report.record("list-home", escaped, detail);
    let (escaped, detail) = try_read(&env("PROBE_OTHER_DATA_SECRET"));
    report.record("read-other-plugin-data", escaped, detail);
    let (escaped, detail) = any(&[
        try_read(&format!("/proc/{browser}/environ")),
        try_read(&format!("/proc/{browser}/cmdline")),
        (
            std::fs::read_link(format!("/proc/{browser}/cwd")).is_ok(),
            "readlink cwd".into(),
        ),
    ]);
    report.record("read-browser-proc", escaped, detail);

    let killed = unsafe { libc::kill(canary, libc::SIGCONT) };
    let kill_errno = errno();
    let everyone = unsafe { libc::kill(-1, 0) };
    let everyone_errno = errno();
    report.record(
        "signal-outside",
        killed == 0 || everyone == 0,
        format!("kill(canary)={killed} errno={kill_errno}; kill(-1,0)={everyone} errno={everyone_errno}"),
    );
    let seize = unsafe { libc::ptrace(libc::PTRACE_SEIZE, canary, 0, 0) };
    let seize_errno = errno();
    if seize == 0 {
        unsafe { libc::ptrace(libc::PTRACE_DETACH, canary, 0, 0) };
    }
    let parent = unsafe { libc::getppid() };
    let attach = unsafe { libc::ptrace(libc::PTRACE_SEIZE, parent, 0, 0) };
    let attach_errno = errno();
    report.record(
        "ptrace-outside",
        seize == 0 || attach == 0,
        format!("seize(canary)={seize} errno={seize_errno}; seize(parent)={attach} errno={attach_errno}"),
    );

    let mut writes = Vec::new();
    let mut attempt = |label: &str, result: i32| {
        let error = if result < 0 { errno() } else { 0 };
        writes.push((result >= 0, format!("{label}={result} errno={error}")));
        result
    };
    let append = attempt("append(victim)", unsafe {
        libc::open(
            c(&victim_file).as_ptr(),
            libc::O_WRONLY | libc::O_APPEND | libc::O_CLOEXEC,
        )
    });
    if append >= 0 {
        unsafe { libc::close(append) };
    }
    let created_path = format!("{victim_dir}/created-by-probe");
    let created = attempt("create(victim dir)", unsafe {
        libc::open(
            c(&created_path).as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY | libc::O_CLOEXEC,
            0o600,
        )
    });
    if created >= 0 {
        unsafe {
            libc::close(created);
            libc::unlink(c(&created_path).as_ptr());
        }
    }
    let new_dir = format!("{home}/made-by-probe");
    if attempt("mkdir(home)", unsafe {
        libc::mkdir(c(&new_dir).as_ptr(), 0o700)
    }) == 0
    {
        unsafe { libc::rmdir(c(&new_dir).as_ptr()) };
    }
    let plugin_write = attempt("write(plugin)", unsafe {
        libc::open(
            c(&format!("{plugin}/main.js")).as_ptr(),
            libc::O_WRONLY | libc::O_CLOEXEC,
        )
    });
    if plugin_write >= 0 {
        unsafe { libc::close(plugin_write) };
    }
    let outside_write = attempt("write(plugin outside path)", unsafe {
        libc::open(
            c(&format!("{outside_plugin}/main.js")).as_ptr(),
            libc::O_WRONLY | libc::O_CLOEXEC,
        )
    });
    if outside_write >= 0 {
        unsafe { libc::close(outside_write) };
    }
    let root_file = attempt("create(/)", unsafe {
        libc::open(
            c("/made-by-probe").as_ptr(),
            libc::O_CREAT | libc::O_WRONLY | libc::O_CLOEXEC,
            0o600,
        )
    });
    if root_file >= 0 {
        unsafe {
            libc::close(root_file);
            libc::unlink(c("/made-by-probe").as_ptr());
        }
    }
    let skeleton_file = attempt("create(home skeleton)", unsafe {
        libc::open(
            c(&format!("{home}/made-by-probe-file")).as_ptr(),
            libc::O_CREAT | libc::O_WRONLY | libc::O_CLOEXEC,
            0o600,
        )
    });
    if skeleton_file >= 0 {
        unsafe { libc::close(skeleton_file) };
    }
    let (escaped, detail) = any(&writes);
    report.record("write-outside", escaped, detail);

    let (victim_truncated, victim_errno) = try_truncate(&victim_file);
    let (plugin_truncated, plugin_truncate_errno) = try_truncate(&format!("{plugin}/main.js"));
    report.record(
        "truncate-path-outside",
        victim_truncated || plugin_truncated,
        format!("victim errno={victim_errno}; plugin errno={plugin_truncate_errno}"),
    );
    if env("PROBE_EXPECT_TRUNCATE_FILTERED") == "1" {
        let own = format!("{data}/truncate-target");
        let fd = unsafe {
            libc::open(
                c(&own).as_ptr(),
                libc::O_CREAT | libc::O_WRONLY | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd >= 0 {
            unsafe {
                libc::write(fd, b"keep".as_ptr().cast(), 4);
                libc::close(fd);
            }
        }
        let (done, error) = try_truncate(&own);
        report.record(
            "truncate-path-abi2-filtered",
            done || error != libc::EPERM,
            format!(
                "truncate(own data)={} errno={error}",
                if done { 0 } else { -1 }
            ),
        );
        let fd = unsafe { libc::open(c(&own).as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC) };
        let ftruncated = fd >= 0 && unsafe { libc::ftruncate(fd, 2) } == 0;
        if fd >= 0 {
            unsafe { libc::close(fd) };
        }
        report.line(&format!(
            "INFO ftruncate-on-writable-fd {}",
            if ftruncated { "allowed" } else { "refused" }
        ));
    }

    let mut renames = Vec::new();
    if !data.is_empty() && !host {
        let source = format!("{data}/rename-source");
        let fd = unsafe {
            libc::open(
                c(&source).as_ptr(),
                libc::O_CREAT | libc::O_WRONLY | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd >= 0 {
            unsafe { libc::close(fd) };
        }
        renames.push(try_rename(&source, &format!("{plugin}/moved")));
        renames.push(try_rename(&source, &format!("{victim_dir}/moved")));
        renames.push(try_rename(&source, &format!("{home}/moved")));
        renames.push(try_rename(&source, "/tmp/../moved"));
    }
    renames.push(try_rename(
        &format!("{plugin}/main.js"),
        &format!("{plugin}/renamed.js"),
    ));
    renames.push(try_rename(
        &format!("{plugin}/main.js"),
        &format!("{victim_dir}/moved-main"),
    ));
    if !data.is_empty() && !host {
        renames.push(try_rename(
            &format!("{plugin}/main.js"),
            &format!("{data}/moved-main"),
        ));
    }
    let (escaped, detail) = any(&renames);
    report.record("rename-across-roots", escaped, detail);

    let mut open_fds = Vec::new();
    for fd in 4..1024 {
        if context.allowed_fds.contains(&fd) {
            continue;
        }
        if unsafe { libc::fcntl(fd, libc::F_GETFD) } != -1 {
            open_fds.push(fd);
        }
    }
    report.record(
        "inherited-fd",
        !open_fds.is_empty(),
        format!("open beyond 0-3: {open_fds:?}"),
    );

    let mut params = [0u8; 120];
    let ring = unsafe { libc::syscall(libc::SYS_io_uring_setup, 1u32, params.as_mut_ptr()) };
    let ring_errno = errno();
    if ring >= 0 {
        unsafe { libc::close(ring as i32) };
    }
    report.record("io-uring", ring >= 0, format!("errno={ring_errno}"));
    let byte = b'x';
    let injected = unsafe { libc::ioctl(1, libc::TIOCSTI, &byte) };
    report.record(
        "tiocsti",
        injected == 0,
        format!("errno={}", if injected == 0 { 0 } else { errno() }),
    );
    let unshared = unsafe { libc::unshare(libc::CLONE_NEWUSER) };
    report.record(
        "unshare-user-namespace",
        unshared == 0,
        format!("errno={}", if unshared == 0 { 0 } else { errno() }),
    );
    let keyring = unsafe { libc::syscall(libc::SYS_keyctl, 0, -3i32, 0) };
    report.record(
        "keyctl",
        keyring >= 0,
        format!("errno={}", if keyring >= 0 { 0 } else { errno() }),
    );
    let mut bpf_attr = [0u8; 64];
    let bpf = unsafe { libc::syscall(libc::SYS_bpf, 0, bpf_attr.as_mut_ptr(), bpf_attr.len()) };
    report.record(
        "bpf",
        bpf >= 0,
        format!("errno={}", if bpf >= 0 { 0 } else { errno() }),
    );

    let (escaped, detail) = try_metadata();
    report.record("exe-metadata", escaped, detail);

    let mut pipe = [-1; 2];
    let piped = unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) } == 0;
    let (owner, owner_errno, asynced) = if piped {
        let owner = unsafe { libc::fcntl(pipe[0], libc::F_SETOWN, canary) };
        let owner_errno = if owner == 0 { 0 } else { errno() };
        let asynced = unsafe { libc::fcntl(pipe[0], libc::F_SETFL, libc::O_ASYNC) };
        unsafe {
            libc::fcntl(pipe[0], libc::F_SETOWN, 0);
            libc::close(pipe[0]);
            libc::close(pipe[1]);
        }
        (owner, owner_errno, asynced)
    } else {
        (-1, errno(), -1)
    };
    report.record(
        "fcntl-setown-outside",
        owner == 0,
        format!(
            "pipe={piped} F_SETOWN(canary)={owner} errno={owner_errno}; F_SETFL(O_ASYNC)={asynced}"
        ),
    );

    if !host && !data.is_empty() {
        let script = format!("{data}/run-me.sh");
        let fd = unsafe {
            libc::open(
                c(&script).as_ptr(),
                libc::O_CREAT | libc::O_TRUNC | libc::O_WRONLY | libc::O_CLOEXEC,
                0o755,
            )
        };
        if fd >= 0 {
            unsafe {
                let body = b"#!/bin/sh\nexit 0\n";
                libc::write(fd, body.as_ptr().cast(), body.len());
                libc::close(fd);
                libc::chmod(c(&script).as_ptr(), 0o755);
            }
        }
        let child = unsafe { libc::fork() };
        if child == 0 {
            let path = c(&script);
            let argv = [path.as_ptr(), std::ptr::null()];
            unsafe {
                libc::execv(path.as_ptr(), argv.as_ptr());
                libc::_exit(100 + errno().min(100));
            }
        }
        let mut status = 0;
        if child > 0 {
            unsafe { libc::waitpid(child, &mut status, 0) };
        }
        let code = if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            -1
        };
        report.record(
            "exec-from-data",
            code == 0,
            format!("exit={code} (100+errno means execve failed)"),
        );
    }

    if host {
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            unsafe { libc::_exit(0) };
        }
        if pid > 0 {
            let mut status = 0;
            unsafe { libc::waitpid(pid, &mut status, 0) };
        }
        report.record(
            "fork",
            pid >= 0,
            format!("errno={}", if pid >= 0 { 0 } else { errno() }),
        );
        let path = c("/nonexistent-ardia/true");
        let argv = [path.as_ptr(), std::ptr::null()];
        unsafe { libc::execv(path.as_ptr(), argv.as_ptr()) };
        let exec_errno = errno();
        report.record(
            "execve-permitted",
            exec_errno != libc::EPERM,
            format!("errno={exec_errno}"),
        );
        let (escaped, detail) = try_read("/etc/passwd");
        report.record("open-outside-plugin-folder", escaped, detail);
        let (escaped, detail) = try_read(&format!("{plugin}/main.js"));
        report.record("open-after-confine", escaped, detail);
        let memory = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                4096,
                libc::PROT_READ | libc::PROT_EXEC,
                libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                -1,
                0,
            )
        };
        report.record(
            "mmap-exec",
            memory != libc::MAP_FAILED,
            format!(
                "errno={}",
                if memory != libc::MAP_FAILED {
                    0
                } else {
                    errno()
                }
            ),
        );
    }
    report.line(&format!(
        "INFO level={} kind={}",
        context.level, context.kind
    ));
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        for line in status.lines().filter(|line| {
            line.starts_with("NoNewPrivs")
                || line.starts_with("Seccomp:")
                || line.starts_with("Cap")
        }) {
            report.line(&format!("INFO {}", line.replace('\t', " ")));
        }
    }
}
