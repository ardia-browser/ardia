mod support;

use ardia_plugin_host::{run_host, ConfinePoint, Exit, Sandbox, SYSCALLS_AFTER_CONFINE};
use std::collections::BTreeSet;
use std::process::Command;
use std::time::Duration;
use std::io::Read;
use std::time::Instant;
use support::{scratch_plugin, sdk_bench, Host};

const CHILD: &str = "ARDIA_CONFINE_ORDER_CHILD";

struct Marker {
    fail: bool,
}

impl Sandbox for Marker {
    fn confine(&mut self, point: &ConfinePoint<'_>) -> Result<(), String> {
        if let Ok(ms) = std::env::var("ARDIA_CONFINE_DELAY_MS") {
            std::thread::sleep(Duration::from_millis(ms.parse().unwrap_or(0)));
        }
        if self.fail {
            return Err("no Landlock here".into());
        }
        let mut open = Vec::new();
        for fd in 0..64 {
            if unsafe { libc::fcntl(fd, libc::F_GETFD) } >= 0 {
                open.push(fd);
            }
        }
        let undeclared: Vec<i32> = open.iter().copied().filter(|fd| !point.kept_fds.contains(fd)).collect();
        let line = format!("{{\"confined\":true,\"undeclared\":{undeclared:?},\"threads\":{}}}\n", point.threads);
        let written = unsafe { libc::write(point.channel_fd, line.as_ptr().cast(), line.len()) };
        if written != line.len() as isize {
            return Err("the marker line didn't fit".into());
        }
        Ok(())
    }
}

fn child() -> ! {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut marker = Marker { fail: std::env::var("ARDIA_CONFINE_FAIL").is_ok() };
    let exit = run_host(&args, &mut marker);
    unsafe { libc::_exit(exit.code()) }
}

fn spawn(fail: bool) -> Host {
    let folder = scratch_plugin(if fail { "confine-fail" } else { "confine" }, "__ardiaBridge.send(JSON.stringify({ entry: typeof URL, bridge: typeof __ardiaBridge }));\n__ardiaBridge.onLine(() => {});\n");
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.env_clear().env(CHILD, "1");
    if fail {
        command.env("ARDIA_CONFINE_FAIL", "1");
    }
    Host::spawn_command(&mut command, &folder, "main.js", &[])
}

fn confinement_runs_after_the_prelude_and_before_the_entry() {
    let mut host = spawn(false);
    let first = host.expect(Duration::from_secs(5), "the confine marker");
    assert_eq!(first["confined"], true, "{first}");
    assert_eq!(first["undeclared"], serde_json::json!([]), "every fd open at the confine point is declared");
    assert_eq!(first["threads"], 2);
    let second = host.expect(Duration::from_secs(5), "the entry's first line");
    assert_eq!(second["entry"], "function");
    assert_eq!(second["bridge"], "object");
    host.close();
    assert_eq!(host.end(Duration::from_secs(5)).code, Some(Exit::ChannelClosed.code()));
}

fn a_failed_confinement_never_runs_plugin_code() {
    let mut host = spawn(true);
    assert!(host.line(Duration::from_millis(500)).is_none());
    let ended = host.end(Duration::from_secs(5));
    assert_eq!(ended.code, Some(Exit::SandboxSetup.code()));
    assert!(ended.stderr.contains("the sandbox couldn't be set up: no Landlock here"), "{}", ended.stderr);
}

fn spawn_sdk_bench(envs: &[(&str, &str)]) -> Host {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.env_clear().env(CHILD, "1");
    for (key, value) in envs {
        command.env(key, value);
    }
    Host::spawn_command(&mut command, &sdk_bench(), "dist/index.js", &[])
}

fn hello_reaches_fd_3_only_after_the_sandbox_returns_ok() {
    let mut host = spawn_sdk_bench(&[("ARDIA_CONFINE_DELAY_MS", "400")]);
    assert_eq!(host.line(Duration::from_millis(300)), None, "the host wrote to fd 3 before the sandbox returned");
    let marker = host.expect(Duration::from_secs(5), "the confine marker");
    assert_eq!(marker["confined"], true, "{marker}");
    let hello = host.expect(Duration::from_secs(5), "the hello request");
    assert_eq!(hello["method"], "hello", "{hello}");
    host.close();
    host.end(Duration::from_secs(5));
}

fn a_failed_sandbox_leaves_fd_3_silent() {
    let mut host = spawn_sdk_bench(&[("ARDIA_CONFINE_FAIL", "1"), ("ARDIA_CONFINE_DELAY_MS", "100")]);
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut received = 0;
    let mut chunk = [0u8; 4096];
    loop {
        assert!(Instant::now() < deadline, "fd 3 never reached EOF");
        match host.stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => received += count,
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(error) => panic!("{error}"),
        }
    }
    assert_eq!(received, 0, "bytes reached fd 3 although the sandbox failed");
    assert_eq!(host.end(Duration::from_secs(5)).code, Some(Exit::SandboxSetup.code()));
}

const BUSY_PLUGIN: &str = "const keep = [];\nfor (let i = 0; i < 200; i++) keep.push(new Array(20000).fill(i));\nkeep.length = 0;\nconst big = 'x'.repeat(4 << 20);\ncrypto.getRandomValues(new Uint8Array(1024));\ncrypto.randomUUID();\nnew URL('https://example.com/a?b');\nconsole.log('log line', btoa('ab'), atob('YWI='));\nsetTimeout(() => __ardiaBridge.send(JSON.stringify({ done: big.length })), 30);\n__ardiaBridge.onLine((line) => __ardiaBridge.send('echo ' + line.length));\n";

fn syscall_name(line: &str) -> Option<String> {
    let rest = line.split_once(' ')?.1.trim_start();
    let rest = rest.strip_prefix("<... ").unwrap_or(rest);
    if rest.starts_with("---") || rest.starts_with("+++") {
        return None;
    }
    let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    (!name.is_empty()).then_some(name)
}

fn only_listed_syscalls_run_after_the_confine_point() {
    if Command::new("strace").arg("-V").output().map(|out| !out.status.success()).unwrap_or(true) {
        println!("test only_listed_syscalls_run_after_the_confine_point ... skipped (no strace)");
        return;
    }
    let folder = scratch_plugin("confine-trace", BUSY_PLUGIN);
    let trace = folder.join("host.trace");
    let mut command = Command::new("strace");
    command.env_clear().env(CHILD, "1").args(["-f", "-qq", "-o"]).arg(&trace).arg(std::env::current_exe().unwrap());
    let mut host = Host::spawn_command(&mut command, &folder, "main.js", &[]);
    let marker = host.expect(Duration::from_secs(10), "the confine marker");
    assert_eq!(marker["confined"], true);
    host.send_raw(&[vec![b'y'; 2 << 20], vec![b'\n']].concat()).unwrap();
    let mut seen = Vec::new();
    while seen.len() < 2 {
        seen.push(host.line(Duration::from_secs(10)).expect("the busy plugin's lines"));
    }
    assert!(seen.contains(&format!("echo {}", 2 << 20)), "{seen:?}");
    assert!(seen.iter().any(|line| line.contains("\"done\":4194304")), "{seen:?}");
    host.close();
    assert_eq!(host.end(Duration::from_secs(10)).code, Some(Exit::ChannelClosed.code()));
    let text = std::fs::read_to_string(&trace).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.iter().position(|line| line.contains("write(3, \"{\\\"confined\\\"")).expect("the marker write in the trace");
    let used: BTreeSet<String> = lines[start + 1..].iter().filter_map(|line| syscall_name(line)).collect();
    let unlisted: Vec<&String> = used.iter().filter(|name| !SYSCALLS_AFTER_CONFINE.contains(&name.as_str())).collect();
    assert!(unlisted.is_empty(), "syscalls after the confine point that SYSCALLS_AFTER_CONFINE lacks: {unlisted:?} (all: {used:?})");
    println!("syscalls after the confine point: {used:?}");
}

fn main() {
    if std::env::var(CHILD).is_ok() {
        child();
    }
    let tests: [(&str, fn()); 5] = [
        ("hello_reaches_fd_3_only_after_the_sandbox_returns_ok", hello_reaches_fd_3_only_after_the_sandbox_returns_ok),
        ("a_failed_sandbox_leaves_fd_3_silent", a_failed_sandbox_leaves_fd_3_silent),
        ("confinement_runs_after_the_prelude_and_before_the_entry", confinement_runs_after_the_prelude_and_before_the_entry),
        ("a_failed_confinement_never_runs_plugin_code", a_failed_confinement_never_runs_plugin_code),
        ("only_listed_syscalls_run_after_the_confine_point", only_listed_syscalls_run_after_the_confine_point),
    ];
    for (name, test) in tests {
        test();
        println!("test {name} ... ok");
    }
    println!("test result: ok. {} passed", tests.len());
}
