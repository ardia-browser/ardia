use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::time::{Duration, Instant};

use jail::{
    LaunchObserver, PolicyDelivery, Program, SpawnRequest, Supervisor, SupervisorConfig, Work,
};

fn say(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{text}");
    let _ = out.flush();
}

fn open(path: &str, flags: i32) -> OwnedFd {
    let name = std::ffi::CString::new(path).unwrap();
    let fd = unsafe { libc::open(name.as_ptr(), flags | libc::O_CLOEXEC) };
    if fd < 0 {
        say(&format!(
            "FATAL can't open {path}: {}",
            std::io::Error::last_os_error()
        ));
        std::process::exit(2);
    }
    unsafe { OwnedFd::from_raw_fd(fd) }
}

fn dir(path: &str) -> OwnedFd {
    open(path, libc::O_PATH | libc::O_DIRECTORY)
}

struct Observer {
    event: String,
    mount_after_record: String,
}

impl LaunchObserver for Observer {
    fn recorded(&mut self, outer: i32, init: i32) {
        say(&format!("RECORDED outer={outer} init={init}"));
        if !self.mount_after_record.is_empty() {
            let _ = std::fs::create_dir_all(&self.mount_after_record);
            let target = std::ffi::CString::new(self.mount_after_record.as_str()).unwrap();
            let mounted = unsafe {
                libc::mount(
                    c"latetmp".as_ptr(),
                    target.as_ptr(),
                    c"tmpfs".as_ptr(),
                    0,
                    std::ptr::null(),
                )
            };
            say(&format!(
                "MOUNTED {} result={mounted} errno={}",
                self.mount_after_record,
                std::io::Error::last_os_error()
            ));
        }
        if self.event == "crash-before-release" {
            unsafe { libc::raise(libc::SIGKILL) };
        }
    }

    fn policy(&mut self, frame: &mut Vec<u8>) -> PolicyDelivery {
        match self.event.as_str() {
            "bad-policy" => {
                let half = frame.len() / 2;
                frame.truncate(half);
                PolicyDelivery::Send
            }
            "withhold" => PolicyDelivery::Withhold,
            _ => PolicyDelivery::Send,
        }
    }
}

struct Lines {
    fd: RawFd,
    pending: Vec<u8>,
}

impl Lines {
    fn next(&mut self, deadline: Instant) -> Option<String> {
        loop {
            if let Some(at) = self.pending.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=at).collect();
                return Some(String::from_utf8_lossy(&line[..line.len() - 1]).into_owned());
            }
            if !jail::sys::wait_readable(self.fd, deadline).unwrap_or(false) {
                return None;
            }
            let mut chunk = [0u8; 4096];
            match jail::sys::read_some(self.fd, &mut chunk) {
                Ok(0) | Err(_) => return None,
                Ok(count) => self.pending.extend_from_slice(&chunk[..count]),
            }
        }
    }

    fn until(&mut self, word: &str, deadline: Instant) -> bool {
        while let Some(line) = self.next(deadline) {
            say(&format!("LINE {line}"));
            if line.starts_with(word) {
                return true;
            }
        }
        false
    }
}

fn report(exit: Option<jail::ExitReport>) {
    match exit {
        Some(exit) => say(&format!(
            "EXIT level={} status={:?} signal={:?} tree_gone={}",
            exit.level.name(),
            exit.status,
            exit.signal,
            exit.tree_gone
        )),
        None => say("EXIT none"),
    }
}

fn dump_log(fd: RawFd) {
    let _ = jail::sys::set_nonblocking(fd);
    let mut data = Vec::new();
    let mut chunk = [0u8; 4096];
    while let Ok(count) = jail::sys::read_some(fd, &mut chunk) {
        if count == 0 || data.len() > 1 << 20 {
            break;
        }
        data.extend_from_slice(&chunk[..count]);
    }
    for line in String::from_utf8_lossy(&data).lines() {
        say(&format!("LOG {line}"));
    }
}

fn wait_stdin_line() {
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
}

fn leak_fds(path: &str) {
    let name = std::ffi::CString::new(path).unwrap();
    let fd = unsafe { libc::open(name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY) };
    if fd >= 0 {
        unsafe {
            libc::dup2(fd, 9);
            libc::dup2(fd, 200);
        }
    }
}

pub fn main(args: &[String]) -> i32 {
    let options: HashMap<String, String> = args
        .iter()
        .filter_map(|arg| {
            arg.split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect();
    let get = |key: &str| options.get(key).cloned().unwrap_or_default();
    let event = get("event");
    let kind = get("kind");
    if get("leak") == "1" {
        leak_fds(&get("leak_path"));
    }

    let broker_exe = open("/proc/self/exe", libc::O_RDONLY);
    let bwrap = (!get("bwrap").is_empty()).then(|| open(&get("bwrap"), libc::O_PATH));
    let mut config = SupervisorConfig::new(broker_exe, bwrap);
    config.plugin_parents = vec![dir(&get("parent"))];
    config.forbidden = get("forbid")
        .split(',')
        .filter(|p| !p.is_empty())
        .map(dir)
        .collect();
    config.require_static_launcher = get("static") == "1";
    if let Ok(abi) = get("abi").parse() {
        config.landlock_abi_cap = abi;
    }
    if get("level") == "reduced" {
        config.allow_full = false;
    }
    if let Ok(ms) = get("deadline").parse() {
        config.ready_deadline = Duration::from_millis(ms);
    }
    if get("cgroup") == "1" {
        match jail::cgroup::CgroupDelegate::from_own_scope() {
            Ok(Some(delegate)) => {
                say(&format!("CGROUP {}", delegate.path().display()));
                config.cgroup = Some(delegate);
            }
            Ok(None) => say("CGROUP none"),
            Err(error) => say(&format!("CGROUP error {error}")),
        }
    }
    let mut supervisor = match Supervisor::new(config) {
        Ok(supervisor) => supervisor,
        Err(error) => {
            say(&format!("FATAL supervisor {error}"));
            return 2;
        }
    };
    let caps = supervisor.capabilities().clone();
    say(&format!(
        "CAPS launcher={:?} abi={} full={} folder_scripts={}",
        caps.launcher,
        caps.landlock_abi
            .map(|abi| abi.to_string())
            .unwrap_or_else(|why| format!("none:{why}")),
        caps.full_isolation
            .as_ref()
            .map(|_| "ok".to_string())
            .unwrap_or_else(|why| format!("no:{why}")),
        match &caps.folder_scripts {
            jail::FolderScripts::Available => "ok".to_string(),
            jail::FolderScripts::Unsupported(why) => format!("no:{why}"),
            jail::FolderScripts::Unknown(why) => format!("unknown:{why}"),
        }
    ));

    let mut pair = [0; 2];
    unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
            0,
            pair.as_mut_ptr(),
        )
    };
    let (ours, theirs) = unsafe { (OwnedFd::from_raw_fd(pair[0]), OwnedFd::from_raw_fd(pair[1])) };

    let work = if kind == "sidecar" {
        let file = open(&get("program"), libc::O_PATH);
        let forbidden: Vec<OwnedFd> = get("forbid")
            .split(',')
            .filter(|p| !p.is_empty())
            .map(dir)
            .collect();
        let program = match Program::resolve(file, &forbidden) {
            Ok(program) => program,
            Err(error) => {
                say(&format!("REFUSED program {error}"));
                return 0;
            }
        };
        if get("swap_program") == "link" {
            let target = get("program");
            let moved = format!("{target}.real");
            std::fs::rename(&target, &moved).expect("move the program");
            std::os::unix::fs::symlink(&moved, &target).expect("link the program");
            say("LINKED-PROGRAM");
        }
        if get("swap_program") == "delete" {
            std::fs::remove_file(get("program")).expect("delete the program");
            say("DELETED-PROGRAM");
        }
        if get("swap_program") == "1" {
            let target = get("program");
            let decoy = format!("{target}.decoy");
            std::fs::write(&decoy, "#!/bin/sh\necho DECOY >&3\necho DONE >&3\n").expect("decoy");
            std::fs::set_permissions(&decoy, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .expect("decoy mode");
            std::fs::rename(&decoy, &target).expect("swap the program");
            say("SWAPPED-PROGRAM");
        }
        let mut args = vec!["probe".to_string(), get("probe")];
        if !get("token").is_empty() {
            args.push(format!("--token={}", get("token")));
        }
        Work::Sidecar { program, args }
    } else {
        Work::Host {
            args: {
                let mut args = vec![
                    "--entry".to_string(),
                    match get("entry") {
                        entry if entry.is_empty() => "main.js".to_string(),
                        entry => entry,
                    },
                ];
                if !get("entry2").is_empty() {
                    args.extend(["--entry".to_string(), get("entry2")]);
                }
                args
            },
        }
    };
    let probe_env: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| k.starts_with("PROBE_"))
        .collect();
    let mut env = Vec::new();
    if kind == "sidecar" {
        env = probe_env.clone();
    } else {
        let mut text: String = probe_env
            .iter()
            .map(|(k, v)| format!("{k}={v}\n"))
            .collect();
        text.push_str(&format!("JAIL_HOST_MODE={}\n", get("host_mode")));
        std::fs::write(format!("{}/probe-context", get("plugin")), text).expect("probe context");
    }
    if !get("preload").is_empty() {
        env.push(("LD_PRELOAD".into(), get("preload")));
    }
    let plugin_dir = dir(&get("plugin"));
    if get("swap") == "1" {
        let original = get("plugin");
        let moved = format!("{original}.old");
        std::fs::rename(&original, &moved).expect("swap: rename");
        std::fs::create_dir(&original).expect("swap: mkdir");
        std::fs::write(format!("{original}/marker"), "swapped").expect("swap: marker");
        std::fs::write(format!("{original}/main.js"), "swapped").expect("swap: main");
        say("SWAPPED");
    }
    let request = SpawnRequest {
        work,
        plugin_name: get("name"),
        plugin_dir,
        data_dir: dir(&get("data")),
        channel: theirs,
        env,
        memory_mb: 64,
    };
    let mut observer = Observer {
        event: event.clone(),
        mount_after_record: get("mount_after_record"),
    };
    let launched = match supervisor.spawn(request, &mut observer) {
        Ok(launched) => launched,
        Err(jail::SpawnError::SetupFailed(why)) => {
            say(&format!("SETUP-FAILED {why}"));
            say(&format!("RUNS {}", supervisor.run_ids().len()));
            return 0;
        }
        Err(error) => {
            say(&format!("REFUSED {error}"));
            return 0;
        }
    };
    say(&format!(
        "SPAWNED level={} abi={} outer={} init={} main={}",
        launched.level.name(),
        launched.landlock_abi,
        launched.outer_pid,
        launched.init_pid.unwrap_or(0),
        launched.main_pid.unwrap_or(0)
    ));
    let log = launched.log;
    let mut lines = Lines {
        fd: ours.as_raw_fd(),
        pending: Vec::new(),
    };
    let soon = |seconds| Instant::now() + Duration::from_secs(seconds);
    match event.as_str() {
        "replace-after-start" => {
            if !lines.until("READY", soon(20)) {
                say("NOT-READY");
            }
            let target = get("program");
            let decoy = format!("{target}.decoy");
            std::fs::write(&decoy, "#!/bin/sh\necho DECOY >&3\n").expect("decoy");
            std::fs::rename(&decoy, &target).expect("replace the program");
            say("REPLACED-PROGRAM");
            let _ = jail::sys::write_all(ours.as_raw_fd(), b"CHECK\n");
            lines.until("DONE", soon(20));
            report(supervisor.stop(launched.id, Duration::from_secs(1)));
        }
        "mount-after-start" => {
            if !lines.until("READY", soon(20)) {
                say("NOT-READY");
            }
            let plugin = get("plugin");
            let late = format!("{plugin}/late");
            let _ = std::fs::create_dir_all(&late);
            for (target, label) in [(late.as_str(), "late"), ("/usr/local", "usr-local")] {
                let path = std::ffi::CString::new(target).unwrap();
                let mounted = unsafe {
                    libc::mount(
                        c"upstream".as_ptr(),
                        path.as_ptr(),
                        c"tmpfs".as_ptr(),
                        0,
                        std::ptr::null(),
                    )
                };
                say(&format!("UPSTREAM-MOUNT {label} result={mounted}"));
            }
            let _ = std::fs::write(format!("{late}/marker"), "upstream");
            let _ = jail::sys::write_all(ours.as_raw_fd(), b"CHECK\n");
            lines.until("DONE", soon(20));
            report(supervisor.stop(launched.id, Duration::from_secs(1)));
            dump_log(log.as_raw_fd());
        }
        "probe" | "marker" => {
            lines.until("DONE", soon(30));
            report(supervisor.stop(launched.id, Duration::from_secs(1)));
            dump_log(log.as_raw_fd());
        }
        "stop" | "eof" | "crash" | "natural" => {
            if !lines.until("READY", soon(20)) {
                say("NOT-READY");
                report(supervisor.stop(launched.id, Duration::from_secs(1)));
                return 1;
            }
            say("READY");
            match event.as_str() {
                "stop" => {
                    wait_stdin_line();
                    report(supervisor.stop(launched.id, Duration::from_secs(1)));
                }
                "eof" => {
                    let mut sink = String::new();
                    while std::io::stdin()
                        .lock()
                        .read_line(&mut sink)
                        .map(|n| n > 0)
                        .unwrap_or(false)
                    {
                        sink.clear();
                    }
                    for (_, exit) in supervisor.shutdown(jail::supervise::QUIT_GRACE) {
                        report(Some(exit));
                    }
                }
                "crash" => loop {
                    wait_stdin_line();
                },
                _ => {
                    let fd = supervisor.ended_fd(launched.id).unwrap();
                    let ended = jail::sys::wait_readable(fd, soon(10)).unwrap_or(false);
                    say(&format!("ENDED {ended}"));
                    report(supervisor.finish(launched.id));
                }
            }
        }
        _ => report(supervisor.stop(launched.id, Duration::from_secs(1))),
    }
    0
}
