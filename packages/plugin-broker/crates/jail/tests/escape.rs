#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use jail::procscan;

static SERIAL: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn harness() -> PathBuf {
    std::env::var_os("JAIL_HARNESS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_jail-harness")))
}

type Stamp = (u32, i64, i64, i64, i64);

fn stamp(path: &Path) -> Stamp {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).unwrap();
    (
        meta.mode(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec(),
    )
}

fn required() -> Option<String> {
    std::env::var("ARDIA_JAIL_REQUIRED")
        .ok()
        .filter(|v| !v.is_empty())
}

fn skip(test: &str, why: &str, needs: &str) {
    if let Some(level) = required() {
        if level == "full" || needs == "host" {
            panic!("{test}: ARDIA_JAIL_REQUIRED={level} but {why}");
        }
    }
    eprintln!("SUMMARY {test} not-applicable ({why})");
}

fn harness_is_static() -> bool {
    let file = std::fs::File::open(harness()).unwrap();
    jail::elf::needs_no_loader(std::os::fd::AsRawFd::as_raw_fd(&file)).unwrap()
}

fn bwrap() -> String {
    std::env::var("ARDIA_BWRAP")
        .expect("set ARDIA_BWRAP to the bwrap that scripts/build-bwrap.sh built")
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

struct World {
    root: PathBuf,
    name: String,
    home: PathBuf,
    config: PathBuf,
    plugins: PathBuf,
    plugin: PathBuf,
    data_root: PathBuf,
    data: PathBuf,
    store: PathBuf,
    victim_dir: PathBuf,
    victim_file: PathBuf,
    program: PathBuf,
    program_stamp: Stamp,
    canary: Child,
    abstract_name: String,
    _listeners: Vec<UnixListener>,
    _abstract: OwnedFd,
}

impl World {
    fn new(test: &str) -> World {
        let serial = SERIAL.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let base = std::env::var_os("JAIL_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/var/tmp"));
        let root = base.join(format!("je{}-{serial}", std::process::id()));
        eprintln!("WORLD {test} at {}", root.display());
        let _ = std::fs::remove_dir_all(&root);
        let name = "probe".to_string();
        let home = root.join("home");
        let config = home.join(".config/ardia");
        let plugins = config.join("plugins");
        let plugin = plugins.join(&name);
        let data_root = home.join(".local/share/ardia-data");
        let data = data_root.join("PluginData").join(&name);
        let store = home.join(".local/share/ardia/programs");
        let victim_dir = root.join("victim");
        let victim_file = victim_dir.join("file.txt");
        write(&home.join("secret.txt"), "home secret");
        write(&plugin.join("main.js"), "globalThis.ok = true;");
        write(&plugin.join("marker"), "original");
        write(
            &data_root.join("PluginData/other/secret.txt"),
            "other plugin secret",
        );
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&store).unwrap();
        write(&victim_file, "victim contents");
        std::fs::create_dir_all(root.join("run")).unwrap();
        let program = root.join("progs/probe-pkg/bin/jail-harness");
        std::fs::create_dir_all(program.parent().unwrap()).unwrap();
        std::fs::copy(harness(), &program).unwrap();
        let control = UnixListener::bind(data_root.join("control.sock")).unwrap();
        let bus = UnixListener::bind(root.join("run/bus")).unwrap();
        let abstract_name = format!("ardia-x11-{}-{test}", std::process::id());
        let abstract_listener = abstract_listen(&abstract_name);
        let canary = Command::new("sleep").arg("600").spawn().unwrap();
        let program_stamp = stamp(&program);
        World {
            program_stamp,
            root,
            name,
            home,
            config,
            plugins,
            plugin,
            data_root,
            data,
            store,
            victim_dir,
            victim_file,
            program,
            canary,
            abstract_name,
            _listeners: vec![control, bus],
            _abstract: abstract_listener,
        }
    }

    fn probe_env(&self) -> Vec<(String, String)> {
        let real_home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
        let s = |p: &Path| p.to_string_lossy().into_owned();
        vec![
            ("PROBE_PLUGIN_DIR".into(), s(&self.plugin)),
            ("PROBE_DATA_DIR".into(), s(&self.data)),
            ("PROBE_HOME".into(), s(&self.home)),
            ("PROBE_REAL_HOME".into(), real_home),
            ("PROBE_HOME_SECRET".into(), s(&self.home.join("secret.txt"))),
            (
                "PROBE_OTHER_DATA_SECRET".into(),
                s(&self.data_root.join("PluginData/other/secret.txt")),
            ),
            (
                "PROBE_CONTROL_SOCKET".into(),
                s(&self.data_root.join("control.sock")),
            ),
            ("PROBE_DBUS_SOCKET".into(), s(&self.root.join("run/bus"))),
            ("PROBE_ABSTRACT_SOCKET".into(), self.abstract_name.clone()),
            ("PROBE_CANARY_PID".into(), self.canary.id().to_string()),
            ("PROBE_BROWSER_PID".into(), std::process::id().to_string()),
            ("PROBE_VICTIM_DIR".into(), s(&self.victim_dir)),
            ("PROBE_VICTIM_FILE".into(), s(&self.victim_file)),
        ]
    }

    fn sim_args(&self, kind: &str, event: &str) -> Vec<String> {
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let forbid = [&self.home, &self.config, &self.data_root, &self.store]
            .iter()
            .map(|p| s(p))
            .collect::<Vec<_>>()
            .join(",");
        vec![
            format!("kind={kind}"),
            format!("event={event}"),
            format!("name={}", self.name),
            format!("plugin={}", s(&self.plugin)),
            format!("data={}", s(&self.data)),
            format!("parent={}", s(&self.plugins)),
            format!("forbid={forbid}"),
            format!("program={}", s(&self.program)),
            format!("bwrap={}", bwrap()),
            "leak=1".into(),
            format!("leak_path={}", s(&self.home)),
            format!("static={}", if harness_is_static() { 1 } else { 0 }),
        ]
    }

    fn check_untouched(&self) {
        assert_eq!(
            stamp(&self.program),
            self.program_stamp,
            "the program file's mode or times changed on the host"
        );
        assert_eq!(
            std::fs::read_to_string(&self.victim_file).unwrap(),
            "victim contents"
        );
        assert!(!self.victim_dir.join("created-by-probe").exists());
        assert!(!self.victim_dir.join("moved").exists());
        assert!(!self.home.join("made-by-probe").exists());
        assert!(!self.home.join("made-by-probe-file").exists());
        assert_eq!(
            std::fs::read_to_string(self.plugin.join("main.js")).unwrap(),
            "globalThis.ok = true;"
        );
        assert!(
            procscan::is_running(self.canary.id() as i32),
            "the canary outside the jail died"
        );
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = self.canary.kill();
        let _ = self.canary.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn abstract_listen(name: &str) -> OwnedFd {
    unsafe {
        let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
        assert!(fd >= 0);
        let mut address: libc::sockaddr_un = std::mem::zeroed();
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (index, byte) in name.bytes().enumerate() {
            address.sun_path[index + 1] = byte as libc::c_char;
        }
        let length = std::mem::size_of::<libc::sa_family_t>() + 1 + name.len();
        assert_eq!(
            libc::bind(
                fd,
                &address as *const _ as *const libc::sockaddr,
                length as libc::socklen_t
            ),
            0
        );
        assert_eq!(libc::listen(fd, 4), 0);
        OwnedFd::from_raw_fd(fd)
    }
}

struct Sim {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    seen: Vec<String>,
}

impl Sim {
    fn start(world: &World, args: Vec<String>, wrap: &[&str]) -> Sim {
        Sim::start_with(world, args, wrap, Vec::new())
    }

    fn start_with(
        world: &World,
        args: Vec<String>,
        wrap: &[&str],
        extra: Vec<(String, String)>,
    ) -> Sim {
        let mut command = if wrap.is_empty() {
            Command::new(harness())
        } else {
            let mut command = Command::new(wrap[0]);
            command.args(&wrap[1..]).arg(harness());
            command
        };
        command
            .arg("broker-sim")
            .args(args)
            .envs(world.probe_env())
            .envs(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let mut child = command.spawn().expect("broker-sim");
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let stdin = child.stdin.take();
        Sim {
            child,
            stdin,
            lines,
            seen: Vec::new(),
        }
    }

    fn wait_for(&mut self, prefix: &str, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(line) => {
                    self.seen.push(line.clone());
                    if line.starts_with(prefix) {
                        return Some(line);
                    }
                }
                Err(_) => return None,
            }
        }
    }

    fn send(&mut self, text: &str) {
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = writeln!(stdin, "{text}");
            let _ = stdin.flush();
        }
    }

    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
    }

    fn finish(mut self, timeout: Duration) -> Vec<String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(Some(_)) = self.child.try_wait() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                let _ = self.child.wait();
                self.seen
                    .push("TIMEOUT broker-sim was killed by the test".into());
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        while let Ok(line) = self.lines.recv_timeout(Duration::from_millis(300)) {
            self.seen.push(line);
        }
        self.seen
    }
}

#[derive(Debug, Clone)]
struct Caps {
    abi: Option<u32>,
    full: bool,
    folder_scripts: bool,
}

fn caps_from(lines: &[String]) -> Caps {
    let line = lines
        .iter()
        .find(|l| l.starts_with("CAPS "))
        .cloned()
        .unwrap_or_default();
    let abi = line
        .split_whitespace()
        .find_map(|w| w.strip_prefix("abi="))
        .and_then(|v| v.parse().ok());
    let full = line.contains("full=ok");
    let folder_scripts = line.contains("folder_scripts=ok");
    Caps {
        abi,
        full,
        folder_scripts,
    }
}

fn field(line: &str, name: &str) -> i32 {
    line.split_whitespace()
        .find_map(|w| w.strip_prefix(&format!("{name}=")))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

fn run_to_end(world: &World, args: Vec<String>) -> Vec<String> {
    Sim::start(world, args, &[]).finish(Duration::from_secs(60))
}

fn summarize(test: &str, lines: &[String]) -> (u32, u32) {
    let results: Vec<&String> = lines
        .iter()
        .filter(|l| l.starts_with("LINE RESULT "))
        .collect();
    let escaped: Vec<&&String> = results
        .iter()
        .filter(|l| l.split_whitespace().nth(3) == Some("ESCAPED"))
        .collect();
    let denied = results.len() as u32 - escaped.len() as u32;
    eprintln!(
        "SUMMARY {test} attempts={} denied={denied} escaped={}",
        results.len(),
        escaped.len()
    );
    for line in lines {
        eprintln!("  {line}");
    }
    (denied, escaped.len() as u32)
}

fn expect_landlock_refusal(test: &str, lines: &[String]) {
    if let Some(level) = required() {
        panic!("{test}: ARDIA_JAIL_REQUIRED={level} but this kernel has no Landlock: {lines:#?}");
    }
    eprintln!("SUMMARY {test} refused-without-landlock");
    for line in lines {
        eprintln!("  {line}");
    }
    let refused = lines
        .iter()
        .find(|l| l.starts_with("REFUSED"))
        .expect("a refusal");
    assert!(refused.contains(jail::LANDLOCK_MISSING), "{refused}");
    assert!(!lines.iter().any(|l| l.starts_with("SPAWNED")));
}

fn assert_contained(test: &str, world: &World, lines: &[String], level: &str, minimum: u32) {
    let (denied, escaped) = summarize(test, lines);
    let spawned = lines
        .iter()
        .find(|l| l.starts_with("SPAWNED"))
        .unwrap_or_else(|| panic!("{test} didn't spawn: {lines:#?}"));
    assert!(spawned.contains(&format!("level={level}")), "{spawned}");
    assert!(
        lines.iter().any(|l| l.starts_with("LINE DONE")),
        "{test}: the probe never finished"
    );
    assert_eq!(escaped, 0, "{test}: something escaped");
    assert!(denied >= minimum, "{test}: only {denied} attempts ran");
    world.check_untouched();
    let exit = lines
        .iter()
        .find(|l| l.starts_with("EXIT"))
        .expect("an exit report");
    assert!(exit.contains("tree_gone=true"), "{exit}");
    for name in ["outer", "init", "main"] {
        let pid = field(spawned, name);
        if pid > 0 {
            assert!(
                !procscan::is_running(pid),
                "{test}: {name} {pid} is still running"
            );
        }
    }
}

fn result_detail<'a>(lines: &'a [String], name: &str) -> Option<&'a str> {
    lines
        .iter()
        .find(|l| l.starts_with(&format!("LINE RESULT {name} ")))
        .map(|s| s.as_str())
}

#[test]
fn full_sidecar_escape() {
    let world = World::new("full-sidecar");
    let mut args = world.sim_args("sidecar", "probe");
    args.push("probe=escape".into());
    let lines = run_to_end(&world, args);
    let caps = caps_from(&lines);
    match caps.abi {
        None => expect_landlock_refusal("full_sidecar_escape", &lines),
        Some(abi) if abi < 2 || !caps.full => {
            skip("full_sidecar_escape", "sidecars aren't available", "full");
            summarize("full_sidecar_escape", &lines);
            assert!(
                lines
                    .iter()
                    .any(|l| l.starts_with("REFUSED") && l.contains("Sidecars need")),
                "{lines:#?}"
            );
        }
        Some(_) => {
            assert_contained("full_sidecar_escape", &world, &lines, "full", 28);
            for field in ["CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:"] {
                let line = lines
                    .iter()
                    .find(|l| l.starts_with(&format!("LINE INFO {field}")))
                    .unwrap_or_else(|| panic!("{field} wasn't reported"));
                assert!(
                    line.ends_with(" 0000000000000000"),
                    "the sidecar kept capabilities: {line}"
                );
            }
            for name in ["fcntl-setown-outside", "exec-from-data"] {
                let line =
                    result_detail(&lines, name).unwrap_or_else(|| panic!("{name} didn't run"));
                assert!(line.contains(" denied "), "{line}");
            }
            let tiocsti = result_detail(&lines, "tiocsti").unwrap();
            assert!(tiocsti.ends_with("errno=1"), "{tiocsti}");
        }
    }
}

#[test]
fn full_sidecar_escape_on_landlock_abi_2() {
    let world = World::new("full-sidecar-abi2");
    let mut args = world.sim_args("sidecar", "probe");
    args.push("probe=escape".into());
    args.push("abi=2".into());
    let mut sim = Sim::start_with(
        &world,
        args,
        &[],
        vec![("PROBE_EXPECT_TRUNCATE_FILTERED".into(), "1".into())],
    );
    let _ = sim.wait_for("CAPS", Duration::from_secs(10));
    let lines = sim.finish(Duration::from_secs(60));
    let caps = caps_from(&lines);
    match caps.abi {
        None => expect_landlock_refusal("full_sidecar_escape_on_landlock_abi_2", &lines),
        Some(abi) if abi < 2 || !caps.full => {
            skip(
                "full_sidecar_escape_on_landlock_abi_2",
                "sidecars aren't available",
                "full",
            );
            summarize("full_sidecar_escape_on_landlock_abi_2", &lines);
            assert!(lines.iter().any(|l| l.starts_with("REFUSED")));
        }
        Some(_) => {
            assert_contained(
                "full_sidecar_escape_on_landlock_abi_2",
                &world,
                &lines,
                "full",
                26,
            );
            assert!(lines.iter().any(|l| l.contains("abi=2")));
            let filtered = result_detail(&lines, "truncate-path-abi2-filtered")
                .expect("the ABI 2 truncate probe ran");
            assert!(filtered.contains(" denied "), "{filtered}");
            assert!(lines
                .iter()
                .any(|l| l.contains("ftruncate-on-writable-fd allowed")));
        }
    }
}

fn spawn_env_probe(world: &World) -> Vec<(String, String)> {
    let mut env = world.probe_env();
    env.push(("PROBE_EXPECT_TRUNCATE_FILTERED".into(), "1".into()));
    env
}

#[test]
fn full_host_escape() {
    let world = World::new("full-host");
    let mut args = world.sim_args("host", "probe");
    args.push("host_mode=probe".into());
    let lines = run_to_end(&world, args);
    let caps = caps_from(&lines);
    match caps.abi {
        None => expect_landlock_refusal("full_host_escape", &lines),
        Some(_) if !caps.full => {
            skip("full_host_escape", "full isolation isn't available", "full");
            summarize("full_host_escape", &lines);
            assert!(lines.iter().any(|l| l.contains("level=hostReduced")));
        }
        Some(_) => {
            assert_contained("full_host_escape", &world, &lines, "full", 33);
            assert!(
                lines
                    .iter()
                    .any(|l| l.contains("trusted-init-read-entry=21")),
                "the host couldn't read its entry before confining"
            );
        }
    }
}

#[test]
fn host_reduced_escape() {
    let world = World::new("host-reduced");
    let mut args = world.sim_args("host", "probe");
    args.push("host_mode=probe".into());
    args.push("level=reduced".into());
    let lines = run_to_end(&world, args);
    match caps_from(&lines).abi {
        None => expect_landlock_refusal("host_reduced_escape", &lines),
        Some(_) => {
            assert_contained("host_reduced_escape", &world, &lines, "hostReduced", 33);
            let setown = result_detail(&lines, "fcntl-setown-outside").unwrap();
            assert!(setown.contains("errno=1"), "{setown}");
            assert!(
                lines
                    .iter()
                    .any(|l| l.contains("trusted-init-read-entry=21")),
                "the host couldn't read its entry before confining"
            );
            let exec = result_detail(&lines, "execve-permitted").unwrap();
            assert!(exec.ends_with("errno=1"), "{exec}");
        }
    }
}

#[test]
fn landlock_missing_refuses_everything() {
    let world = World::new("no-landlock");
    let mut sidecar = world.sim_args("sidecar", "probe");
    sidecar.push("probe=escape".into());
    let lines = run_to_end(&world, sidecar);
    let caps = caps_from(&lines);
    if caps.abi.is_some() {
        assert!(
            std::env::var("JAIL_EXPECT_NO_LANDLOCK").is_err(),
            "this kernel has Landlock, but the run expected none"
        );
        eprintln!("SUMMARY landlock_missing_refuses_everything not-applicable (kernel has Landlock ABI {:?})", caps.abi);
        return;
    }
    expect_landlock_refusal("landlock_missing/sidecar", &lines);
    for level in ["auto", "reduced"] {
        let mut host = world.sim_args("host", "probe");
        host.push(format!("level={level}"));
        let lines = run_to_end(&world, host);
        expect_landlock_refusal(&format!("landlock_missing/host-{level}"), &lines);
    }
}

#[test]
fn controls_outside_the_jail_escape() {
    let world = World::new("controls");
    for kind in ["sidecar", "host"] {
        let output = Command::new(harness())
            .arg("control")
            .arg(kind)
            .envs(spawn_env_probe(&world))
            .output()
            .unwrap();
        let lines: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|l| format!("LINE {l}"))
            .collect();
        let (denied, escaped) = summarize(&format!("controls_outside/{kind}"), &lines);
        assert!(escaped >= 12, "only {escaped} probes escaped without the jail; the probes may be broken ({denied} denied)");
        for name in [
            "socket-unix-stream",
            "socket-inet-tcp",
            "connect-control-socket",
            "read-home",
            "read-other-plugin-data",
            "write-outside",
            "signal-outside",
        ] {
            let line = result_detail(&lines, name).unwrap_or_else(|| panic!("{name} missing"));
            assert!(
                line.contains(" ESCAPED "),
                "control {name} should succeed outside the jail: {line}"
            );
        }
    }
    assert_eq!(
        std::fs::read_to_string(&world.victim_file).unwrap(),
        "victim contents"
    );
}

#[test]
fn root_checks_refuse_bad_folders() {
    let world = World::new("roots");
    let caps = caps_from(&run_to_end(&world, {
        let mut a = world.sim_args("host", "probe");
        a.push("level=reduced".into());
        a.push("host_mode=probe".into());
        a
    }));
    if caps.abi.is_none() {
        eprintln!(
            "SUMMARY root_checks not-applicable (no Landlock, everything is refused earlier)"
        );
        return;
    }
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let stray = world.root.join("stray-plugin");
    write(&stray.join("main.js"), "x");
    let cases = [
        ("plugin-is-home", format!("plugin={}", s(&world.home))),
        ("plugin-outside-plugins", format!("plugin={}", s(&stray))),
        (
            "plugin-is-plugins-folder",
            format!("plugin={}", s(&world.plugins)),
        ),
        ("data-is-plugin", format!("data={}", s(&world.plugin))),
        ("data-takes-in-home", format!("data={}", s(&world.root))),
    ];
    for (name, change) in cases {
        let key = change.split('=').next().unwrap().to_string();
        let mut args: Vec<String> = world
            .sim_args("host", "probe")
            .into_iter()
            .filter(|a| !a.starts_with(&format!("{key}=")))
            .collect();
        args.push(change);
        args.push("level=reduced".into());
        let lines = run_to_end(&world, args);
        eprintln!(
            "SUMMARY root_checks/{name}: {}",
            lines
                .iter()
                .find(|l| l.starts_with("REFUSED"))
                .cloned()
                .unwrap_or_default()
        );
        assert!(
            lines
                .iter()
                .any(|l| l.starts_with("REFUSED") && l.contains("can't start")),
            "{name}: {lines:#?}"
        );
        assert!(!lines.iter().any(|l| l.starts_with("SPAWNED")), "{name}");
    }
}

#[test]
fn a_swapped_plugin_folder_mounts_the_verified_inode() {
    let world = World::new("swap");
    let mut args = world.sim_args("sidecar", "marker");
    args.push("probe=marker".into());
    args.push("swap=1".into());
    let lines = run_to_end(&world, args);
    let caps = caps_from(&lines);
    if caps.abi.map(|abi| abi < 2).unwrap_or(true) || !caps.full {
        summarize("swapped_folder", &lines);
        assert!(lines.iter().any(|l| l.starts_with("REFUSED")));
        return;
    }
    summarize("swapped_folder", &lines);
    let marker = lines
        .iter()
        .find(|l| l.starts_with("LINE MARKER"))
        .expect("the marker probe answered");
    assert!(marker.contains("cwd=original"), "{marker}");
    assert!(!marker.contains("swapped"), "{marker}");
}

fn token_processes(token: &str) -> Vec<i32> {
    let needle = format!("--token={token}");
    procscan::all_pids()
        .into_iter()
        .filter(|pid| procscan::is_running(*pid) && procscan::cmdline_contains(*pid, &needle))
        .collect()
}

fn wait_gone(pids: &[i32], token: Option<&str>, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let alive: Vec<i32> = pids
            .iter()
            .copied()
            .filter(|pid| *pid > 0 && procscan::is_running(*pid))
            .collect();
        let tokens = token.map(token_processes).unwrap_or_default();
        if alive.is_empty() && tokens.is_empty() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "still running: pids {alive:?}, token processes {tokens:?}"
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn cleanup(kind: &str, level: &str, event: &str, wrap: &[&str]) {
    let test = format!(
        "cleanup/{kind}-{level}-{event}{}",
        if wrap.is_empty() { "" } else { "-cgroup" }
    );
    let world = World::new(&format!("cleanup-{kind}-{level}-{event}-{}", wrap.len()));
    let token = format!("tok-{}-{}", std::process::id(), test.replace('/', "-"));
    let mut args = world.sim_args(kind, event);
    args.push(format!("token={token}"));
    args.push(format!(
        "probe={}",
        if event == "natural" {
            "grandchild-exit"
        } else {
            "grandchild"
        }
    ));
    args.push("host_mode=idle".into());
    args.push("deadline=1500".into());
    if level == "reduced" {
        args.push("level=reduced".into());
    }
    if !wrap.is_empty() {
        args.push("cgroup=1".into());
    }
    let mut sim = Sim::start(&world, args, wrap);
    let caps_line = sim
        .wait_for("CAPS", Duration::from_secs(15))
        .unwrap_or_default();
    let caps = caps_from(&[caps_line]);
    if caps.abi.is_none() || (kind == "sidecar" && (!caps.full || caps.abi < Some(2))) {
        let lines = sim.finish(Duration::from_secs(20));
        eprintln!("SUMMARY {test} refused-as-expected");
        assert!(
            lines.iter().any(|l| l.starts_with("REFUSED")),
            "{test}: {lines:#?}"
        );
        return;
    }
    let mut pids = Vec::new();
    let mut grandchild_seen = false;
    let outcome = match event {
        "crash-before-release" => {
            let recorded = sim
                .wait_for("RECORDED", Duration::from_secs(15))
                .unwrap_or_else(|| panic!("{test}: {:#?}", sim.seen));
            pids.extend([field(&recorded, "outer"), field(&recorded, "init")]);
            let _ = sim.finish(Duration::from_secs(10));
            "broker killed itself between recording the run and releasing --block-fd".to_string()
        }
        "bad-policy" | "withhold" => {
            let recorded = sim
                .wait_for("RECORDED", Duration::from_secs(15))
                .unwrap_or_else(|| panic!("{test}: {:#?}", sim.seen));
            pids.extend([field(&recorded, "outer"), field(&recorded, "init")]);
            let failed = sim
                .wait_for("SETUP-FAILED", Duration::from_secs(15))
                .unwrap_or_else(|| panic!("{test}: {:#?}", sim.seen));
            let runs = sim
                .wait_for("RUNS", Duration::from_secs(5))
                .unwrap_or_default();
            assert_eq!(runs, "RUNS 0", "{test}: the failed run stayed recorded");
            let _ = sim.finish(Duration::from_secs(10));
            failed
        }
        _ => {
            let spawned = sim
                .wait_for("SPAWNED", Duration::from_secs(15))
                .unwrap_or_else(|| panic!("{test}: {:#?}", sim.seen));
            let wanted = if level == "reduced" || !caps.full {
                "level=hostReduced"
            } else {
                "level=full"
            };
            assert!(spawned.contains(wanted), "{test}: {spawned}");
            pids.extend([
                field(&spawned, "outer"),
                field(&spawned, "init"),
                field(&spawned, "main"),
            ]);
            sim.wait_for("READY", Duration::from_secs(20))
                .unwrap_or_else(|| panic!("{test}: {:#?}", sim.seen));
            if kind == "sidecar" {
                grandchild_seen = sim.seen.iter().any(|l| l.contains("GRANDCHILD up"));
                let alive = token_processes(&token);
                assert!(
                    alive.len() >= 2 || event == "natural",
                    "{test}: expected the main and the grandchild running, saw {alive:?}"
                );
            }
            match event {
                "stop" => {
                    sim.send("go");
                    let exit = sim
                        .wait_for("EXIT", Duration::from_secs(15))
                        .unwrap_or_default();
                    let _ = sim.finish(Duration::from_secs(10));
                    exit
                }
                "eof" => {
                    sim.close_stdin();
                    let exit = sim
                        .wait_for("EXIT", Duration::from_secs(15))
                        .unwrap_or_default();
                    let _ = sim.finish(Duration::from_secs(10));
                    exit
                }
                "crash" => {
                    sim.kill();
                    let _ = sim.finish(Duration::from_secs(10));
                    "broker SIGKILLed".to_string()
                }
                "natural" => {
                    let exit = sim
                        .wait_for("EXIT", Duration::from_secs(15))
                        .unwrap_or_default();
                    let _ = sim.finish(Duration::from_secs(10));
                    exit
                }
                other => panic!("unknown event {other}"),
            }
        }
    };
    let token_filter = (kind == "sidecar").then_some(token.as_str());
    let gone = wait_gone(&pids, token_filter, Duration::from_secs(5));
    eprintln!(
        "SUMMARY {test} grandchild_started={grandchild_seen} outcome=[{outcome}] all_gone={}",
        gone.is_ok()
    );
    if outcome.starts_with("EXIT") {
        assert!(outcome.contains("tree_gone=true"), "{test}: {outcome}");
    }
    gone.unwrap_or_else(|why| panic!("{test}: {why}"));
}

#[test]
fn cleanup_sidecar_stop() {
    cleanup("sidecar", "full", "stop", &[]);
}
#[test]
fn cleanup_sidecar_browser_eof() {
    cleanup("sidecar", "full", "eof", &[]);
}
#[test]
fn cleanup_sidecar_broker_crash() {
    cleanup("sidecar", "full", "crash", &[]);
}
#[test]
fn cleanup_sidecar_natural_exit() {
    cleanup("sidecar", "full", "natural", &[]);
}
#[test]
fn cleanup_sidecar_interrupted_before_release() {
    cleanup("sidecar", "full", "crash-before-release", &[]);
}
#[test]
fn cleanup_sidecar_interrupted_bad_policy() {
    cleanup("sidecar", "full", "bad-policy", &[]);
}
#[test]
fn cleanup_sidecar_interrupted_no_readiness() {
    cleanup("sidecar", "full", "withhold", &[]);
}
#[test]
fn cleanup_host_full_stop() {
    cleanup("host", "full", "stop", &[]);
}
#[test]
fn cleanup_host_full_browser_eof() {
    cleanup("host", "full", "eof", &[]);
}
#[test]
fn cleanup_host_full_broker_crash() {
    cleanup("host", "full", "crash", &[]);
}
#[test]
fn cleanup_host_full_interrupted_before_release() {
    cleanup("host", "full", "crash-before-release", &[]);
}
#[test]
fn cleanup_host_reduced_stop() {
    cleanup("host", "reduced", "stop", &[]);
}
#[test]
fn cleanup_host_reduced_browser_eof() {
    cleanup("host", "reduced", "eof", &[]);
}
#[test]
fn cleanup_host_reduced_broker_crash() {
    cleanup("host", "reduced", "crash", &[]);
}
#[test]
fn cleanup_host_reduced_interrupted_before_policy() {
    cleanup("host", "reduced", "crash-before-release", &[]);
}
#[test]
fn cleanup_host_reduced_interrupted_bad_policy() {
    cleanup("host", "reduced", "bad-policy", &[]);
}
#[test]
fn cleanup_host_reduced_interrupted_no_readiness() {
    cleanup("host", "reduced", "withhold", &[]);
}

fn delegated_scope() -> Option<Vec<&'static str>> {
    let ok = Command::new("systemd-run")
        .args(["--user", "--scope", "-q", "-p", "Delegate=yes", "true"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    ok.then(|| {
        vec![
            "systemd-run",
            "--user",
            "--scope",
            "-q",
            "-p",
            "Delegate=yes",
            "--",
        ]
    })
}

#[test]
fn cleanup_sidecar_with_delegated_cgroup() {
    let Some(wrap) = delegated_scope() else {
        eprintln!("SUMMARY cleanup/cgroup not-applicable (no systemd user manager)");
        return;
    };
    for event in ["stop", "eof", "crash", "natural"] {
        cleanup("sidecar", "full", event, &wrap);
    }
}

fn full_sidecars_available(lines: &[String]) -> bool {
    let caps = caps_from(lines);
    caps.full && caps.abi.map(|abi| abi >= 2).unwrap_or(false)
}

fn no_overlay_expected() -> bool {
    std::env::var("JAIL_EXPECT_NO_OVERLAY").as_deref() == Ok("1")
}

fn script_sidecars(test: &str, lines: &[String]) -> bool {
    if !full_sidecars_available(lines) {
        skip(test, "sidecars aren't available", "full");
        return false;
    }
    if caps_from(lines).folder_scripts {
        return true;
    }
    if no_overlay_expected() {
        eprintln!("SUMMARY {test} not-applicable (no overlayfs, as JAIL_EXPECT_NO_OVERLAY says)");
        return false;
    }
    skip(
        test,
        "overlayfs isn't usable, so scripts inside folders are off",
        "full",
    );
    false
}

fn build_preload(world: &World) -> Option<PathBuf> {
    let source = world.root.join("preload.c");
    std::fs::write(
        &source,
        "#include <unistd.h>\n#include <stdio.h>\n#include <string.h>\n__attribute__((constructor)) static void announce(void) {\n  char exe[512] = {0}; char line[600];\n  ssize_t n = readlink(\"/proc/self/exe\", exe, sizeof exe - 1);\n  if (n < 0) strcpy(exe, \"unknown\");\n  int len = snprintf(line, sizeof line, \"PRELOADED %s\\n\", exe);\n  write(2, line, len);\n}\n",
    )
    .unwrap();
    let output = world.plugin.join("preload.so");
    if let Some(prebuilt) = std::env::var_os("JAIL_PRELOAD_SO") {
        return std::fs::copy(prebuilt, &output).ok().map(|_| output);
    }
    let built = Command::new("cc")
        .args(["-shared", "-fPIC", "-o"])
        .arg(&output)
        .arg(&source)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    built.then_some(output)
}

#[test]
fn a_loader_variable_in_the_request_never_reaches_the_launcher() {
    let world = World::new("preload");
    let Some(_library) = build_preload(&world) else {
        skip("preload", "no C compiler and no JAIL_PRELOAD_SO", "host");
        return;
    };
    let mut host = world.sim_args("host", "probe");
    host.push("level=reduced".into());
    host.push(format!("preload={}/preload.so", jail::PLUGIN_IN_JAIL));
    let lines = run_to_end(&world, host);
    if caps_from(&lines).abi.is_some() {
        let refused = lines
            .iter()
            .find(|l| l.starts_with("REFUSED"))
            .cloned()
            .unwrap_or_default();
        eprintln!("SUMMARY preload/host {refused}");
        assert!(refused.contains("takes no environment"), "{lines:#?}");
    }
    let mut sidecar = world.sim_args("sidecar", "marker");
    sidecar.push("probe=marker".into());
    sidecar.push(format!("preload={}/preload.so", jail::PLUGIN_IN_JAIL));
    let lines = run_to_end(&world, sidecar);
    if !full_sidecars_available(&lines) {
        skip("preload/sidecar", "sidecars aren't available", "full");
        return;
    }
    let preloaded: Vec<&String> = lines.iter().filter(|l| l.contains("PRELOADED")).collect();
    eprintln!(
        "SUMMARY preload/sidecar launcher_static={} preloaded_lines={:?}",
        harness_is_static(),
        preloaded
    );
    assert!(
        lines.iter().any(|l| l.starts_with("LINE MARKER")),
        "{lines:#?}"
    );
    assert!(
        !preloaded.iter().any(|l| l.contains("ardia-plugins")),
        "the trusted launcher loaded a library from the request: {preloaded:?}"
    );
    if !harness_is_static() {
        assert!(
            !preloaded.is_empty(),
            "the dynamic sidecar should have received its own approved LD_PRELOAD"
        );
    }
}

#[test]
fn a_dynamic_launcher_is_refused_when_static_is_required() {
    let world = World::new("static");
    let mut args: Vec<String> = world
        .sim_args("host", "probe")
        .into_iter()
        .filter(|a| !a.starts_with("static="))
        .collect();
    args.push("static=1".into());
    args.push("level=reduced".into());
    args.push("host_mode=probe".into());
    let lines = run_to_end(&world, args);
    let fatal = lines.iter().find(|l| l.starts_with("FATAL")).cloned();
    eprintln!(
        "SUMMARY static_launcher harness_static={} fatal={fatal:?}",
        harness_is_static()
    );
    if harness_is_static() {
        assert!(fatal.is_none(), "{lines:#?}");
        assert!(
            lines.iter().any(|l| l.contains("launcher=Static")),
            "{lines:#?}"
        );
    } else {
        assert!(
            fatal.unwrap_or_default().contains("dynamically linked"),
            "{lines:#?}"
        );
    }
}

#[test]
fn a_program_swapped_after_verification_still_runs_the_verified_inode() {
    let world = World::new("program-swap");
    let mut args = world.sim_args("sidecar", "marker");
    args.push("probe=marker".into());
    args.push("swap_program=1".into());
    let lines = run_to_end(&world, args);
    if !full_sidecars_available(&lines) {
        skip("program_swap", "sidecars aren't available", "full");
        assert!(lines.iter().any(|l| l.starts_with("REFUSED")));
        return;
    }
    summarize("program_swap", &lines);
    assert!(lines.iter().any(|l| l == "SWAPPED-PROGRAM"), "{lines:#?}");
    assert!(
        !lines.iter().any(|l| l.contains("DECOY")),
        "the swapped-in program ran: {lines:#?}"
    );
    let refused = lines
        .iter()
        .find(|l| l.starts_with("REFUSED") || l.starts_with("SETUP-FAILED"))
        .cloned();
    let verified_ran = lines.iter().any(|l| l.starts_with("LINE MARKER"));
    eprintln!("SUMMARY program_swap verified_ran={verified_ran} refused={refused:?}");
    assert!(verified_ran || refused.is_some(), "{lines:#?}");
    let on_disk = std::fs::read_to_string(&world.program).unwrap_or_default();
    assert!(on_disk.contains("DECOY"), "the swap didn't happen on disk");
}

#[test]
fn a_script_program_runs_from_its_pinned_fd() {
    let world = World::new("script");
    let script = world.root.join("progs/script-pkg/bin/hello.sh");
    write(
        &script,
        "#!/bin/sh\nchmod 755 \"$0\" 2>/dev/null && echo \"META-OK chmod $0\" >&3\ntouch -r \"$0\" \"$0\" 2>/dev/null && echo \"META-OK touch $0\" >&3\nfor f in /proc/self/fd/* /proc/$$/fd/*; do [ -f \"$f\" ] && chmod 755 \"$f\" 2>/dev/null && echo \"META-OK chmod $f\" >&3; done\necho \"REREAD $(head -c 9 \"$0\")\" >&3\necho \"SCRIPT-RAN args=$1 home=$HOME self=$0\" >&3\necho DONE >&3\n",
    );
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let mut args: Vec<String> = world
        .sim_args("sidecar", "probe")
        .into_iter()
        .filter(|a| !a.starts_with("program="))
        .collect();
    args.push(format!("program={}", script.display()));
    args.push("probe=from-script".into());
    let before = stamp(&script);
    let lines = run_to_end(&world, args);
    if !script_sidecars("script", &lines) {
        return;
    }
    assert_eq!(
        stamp(&script),
        before,
        "the script's mode or times changed on the host"
    );
    assert!(!lines.iter().any(|l| l.contains("META-OK")), "{lines:#?}");
    summarize("script_program", &lines);
    let ran = lines
        .iter()
        .find(|l| l.starts_with("LINE SCRIPT-RAN"))
        .unwrap_or_else(|| panic!("{lines:#?}"));
    assert!(ran.contains("args=probe"), "{ran}");
    assert!(ran.contains("home=/run/ardia/data/home"), "{ran}");
    assert!(
        ran.contains("self=/run/ardia/program/bin/hello.sh"),
        "the script should keep its own path: {ran}"
    );
    assert!(
        lines.iter().any(|l| l == "LINE REREAD #!/bin/sh"),
        "the interpreter couldn't reopen its script path: {lines:#?}"
    );
}

const SIBLING_LIB: &str =
    "#include <unistd.h>\nvoid sib_hello(void) { write(3, \"SIBLING-OK\\n\", 11); }\n";

const SIBLING_MAIN: &str = r#"#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
void sib_hello(void);
static void say(const char *s) { write(3, s, strlen(s)); }
int main(void) {
  char line[600];
  struct stat st;
  sib_hello();
  if (stat("/proc/self/exe", &st) == 0) {
    struct timespec t[2] = {st.st_atim, st.st_mtim};
    if (chmod("/proc/self/exe", st.st_mode & 07777) == 0) say("META-OK chmod exe\n");
    if (utimensat(AT_FDCWD, "/proc/self/exe", t, 0) == 0) say("META-OK utimensat exe\n");
  }
  for (int fd = 0; fd < 1024; fd++) {
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) continue;
    struct timespec t[2] = {st.st_atim, st.st_mtim};
    if (fchmod(fd, st.st_mode & 07777) == 0) { snprintf(line, sizeof line, "META-OK fchmod %d\n", fd); say(line); }
    if (futimens(fd, t) == 0) { snprintf(line, sizeof line, "META-OK futimens %d\n", fd); say(line); }
  }
  char exe[512] = {0};
  if (readlink("/proc/self/exe", exe, sizeof exe - 1) > 0) { snprintf(line, sizeof line, "EXE %s\n", exe); say(line); }
  say("DONE\n");
  return 0;
}
"#;

fn sibling_package(world: &World) -> Option<PathBuf> {
    let package = world.root.join("progs/sib-pkg");
    std::fs::create_dir_all(package.join("bin")).unwrap();
    std::fs::create_dir_all(package.join("lib")).unwrap();
    if let Some(prebuilt) = std::env::var_os("JAIL_SIBLING_DIR").map(PathBuf::from) {
        std::fs::copy(prebuilt.join("bin/sibprog"), package.join("bin/sibprog")).ok()?;
        std::fs::copy(
            prebuilt.join("lib/libsib.so"),
            package.join("lib/libsib.so"),
        )
        .ok()?;
        return Some(package);
    }
    std::fs::write(world.root.join("sib.c"), SIBLING_LIB).unwrap();
    std::fs::write(world.root.join("main.c"), SIBLING_MAIN).unwrap();
    let lib = Command::new("cc")
        .args(["-shared", "-fPIC", "-o"])
        .arg(package.join("lib/libsib.so"))
        .arg(world.root.join("sib.c"))
        .status()
        .ok()?
        .success();
    let main = lib
        && Command::new("cc")
            .arg("-o")
            .arg(package.join("bin/sibprog"))
            .arg(world.root.join("main.c"))
            .arg(format!("-L{}", package.join("lib").display()))
            .args(["-lsib", "-Wl,-rpath,$ORIGIN/../lib"])
            .status()
            .ok()?
            .success();
    main.then_some(package)
}

#[test]
fn an_elf_with_a_sibling_library_resolves_origin_inside_the_jail() {
    let world = World::new("sibling");
    let Some(package) = sibling_package(&world) else {
        skip("sibling", "no C compiler and no JAIL_SIBLING_DIR", "host");
        return;
    };
    let program = package.join("bin/sibprog");
    let library = package.join("lib/libsib.so");
    let (program_before, library_before) = (stamp(&program), stamp(&library));
    let mut args: Vec<String> = world
        .sim_args("sidecar", "probe")
        .into_iter()
        .filter(|a| !a.starts_with("program="))
        .collect();
    args.push(format!("program={}", program.display()));
    args.push("probe=sibling".into());
    let lines = run_to_end(&world, args);
    if !full_sidecars_available(&lines) {
        skip("sibling", "sidecars aren't available", "full");
        return;
    }
    summarize("sibling", &lines);
    assert!(lines.iter().any(|l| l == "LINE SIBLING-OK"), "{lines:#?}");
    assert!(
        lines
            .iter()
            .any(|l| l == "LINE EXE /run/ardia/program/bin/sibprog"),
        "{lines:#?}"
    );
    assert!(!lines.iter().any(|l| l.contains("META-OK")), "{lines:#?}");
    assert_eq!(
        stamp(&program),
        program_before,
        "the program's metadata changed on the host"
    );
    assert_eq!(
        stamp(&library),
        library_before,
        "the library's metadata changed on the host"
    );
}

fn userns_wrapper_works() -> bool {
    Command::new("unshare")
        .args(["--user", "--map-root-user", "--mount", "true"])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[test]
fn a_submount_under_a_system_root_is_refused_inside_the_jail() {
    let world = World::new("usr-submount");
    if !userns_wrapper_works() {
        skip(
            "usr_submount",
            "the test can't make a user namespace to mount in",
            "tool",
        );
        return;
    }
    let script = "mount -t tmpfs extra /usr/local && exec \"$@\"";
    let wrap = [
        "unshare",
        "--user",
        "--map-root-user",
        "--mount",
        "--propagation",
        "private",
        "sh",
        "-c",
        script,
        "sh",
    ];
    for kind in ["host", "sidecar"] {
        let mut args = world.sim_args(kind, "probe");
        args.push("host_mode=probe".into());
        args.push("probe=escape".into());
        let lines = Sim::start(&world, args, &wrap).finish(Duration::from_secs(30));
        let caps = caps_from(&lines);
        if kind == "sidecar" && caps.full && !full_sidecars_available(&lines) {
            skip(
                "usr_submount/sidecar",
                "sidecars need Landlock ABI 2",
                "full",
            );
            continue;
        }
        if !caps.full {
            skip(
                "usr_submount",
                "full isolation isn't available inside the test's namespace",
                "full",
            );
            return;
        }
        let failed = lines
            .iter()
            .find(|l| l.starts_with("SETUP-FAILED"))
            .cloned()
            .unwrap_or_default();
        eprintln!("SUMMARY usr_submount/{kind} {failed}");
        assert!(
            failed.contains("unexpected-mount") || failed.contains("unexpected filesystem"),
            "{lines:#?}"
        );
        assert!(failed.contains("/usr/local"), "{failed}");
        assert!(
            !lines.iter().any(|l| l.starts_with("LINE RESULT")),
            "plugin code ran: {lines:#?}"
        );
    }
}

#[test]
fn a_submount_that_appears_after_the_source_check_is_refused_inside_the_jail() {
    let world = World::new("late-submount");
    if !userns_wrapper_works() {
        skip(
            "late_submount",
            "the test can't make a user namespace to mount in",
            "tool",
        );
        return;
    }
    let wrap = [
        "unshare",
        "--user",
        "--map-root-user",
        "--mount",
        "--propagation",
        "shared",
    ];
    for level in ["full", "reduced"] {
        let late = world.plugin.join(format!("late-{level}"));
        let mut args = world.sim_args("host", "probe");
        args.push("host_mode=probe".into());
        args.push(format!("mount_after_record={}", late.display()));
        if level == "reduced" {
            args.push("level=reduced".into());
        }
        let lines = Sim::start(&world, args, &wrap).finish(Duration::from_secs(30));
        let caps = caps_from(&lines);
        if level == "full" && !caps.full {
            skip(
                "late_submount/full",
                "full isolation isn't available inside the test's namespace",
                "full",
            );
            continue;
        }
        let failed = lines
            .iter()
            .find(|l| l.starts_with("SETUP-FAILED"))
            .cloned()
            .unwrap_or_default();
        eprintln!("SUMMARY late_submount/{level} {failed}");
        assert!(
            lines
                .iter()
                .any(|l| l.starts_with("MOUNTED") && l.contains("result=0")),
            "{lines:#?}"
        );
        assert!(failed.contains("unexpected filesystem"), "{lines:#?}");
        assert!(failed.contains(&format!("late-{level}")), "{failed}");
        assert!(
            !lines.iter().any(|l| l.starts_with("LINE RESULT")),
            "plugin code ran: {lines:#?}"
        );
    }
}

#[test]
fn nested_mounts_inside_granted_trees_are_refused() {
    let world = World::new("nested");
    let nested = world.plugin.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let script = format!(
        "mount -t tmpfs nested '{}' && exec \"$@\"",
        nested.display()
    );
    let wrap = [
        "unshare",
        "--user",
        "--map-root-user",
        "--mount",
        "--propagation",
        "private",
        "sh",
        "-c",
        &script,
        "sh",
    ];
    let usable = Command::new("unshare")
        .args(["--user", "--map-root-user", "--mount", "true"])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !usable {
        eprintln!(
            "SUMMARY nested_mounts not-applicable (no unprivileged user namespaces for the test)"
        );
        return;
    }
    let mut args = world.sim_args("host", "probe");
    args.push("level=reduced".into());
    args.push("host_mode=probe".into());
    let lines = Sim::start(&world, args, &wrap).finish(Duration::from_secs(30));
    if caps_from(&lines).abi.is_none() {
        expect_landlock_refusal("nested_mounts", &lines);
        return;
    }
    let refused = lines
        .iter()
        .find(|l| l.starts_with("REFUSED"))
        .cloned()
        .unwrap_or_default();
    eprintln!("SUMMARY nested_mounts {refused}");
    assert!(
        refused.contains("a filesystem is mounted inside the plugin folder"),
        "{lines:#?}"
    );
    assert!(!lines.iter().any(|l| l.starts_with("SPAWNED")));
}

#[test]
fn a_mount_added_upstream_after_acceptance_never_reaches_the_jail() {
    let world = World::new("upstream");
    if !userns_wrapper_works() {
        skip(
            "upstream_mount",
            "the test can't make a user namespace to mount in",
            "tool",
        );
        return;
    }
    let wrap = [
        "unshare",
        "--user",
        "--map-root-user",
        "--mount",
        "--propagation",
        "shared",
    ];
    let mut args = world.sim_args("sidecar", "mount-after-start");
    args.push("probe=mountwatch".into());
    let lines = Sim::start(&world, args, &wrap).finish(Duration::from_secs(30));
    if !full_sidecars_available(&lines) {
        skip(
            "upstream_mount",
            "sidecars aren't available inside the test's namespace",
            "full",
        );
        return;
    }
    let watch = lines
        .iter()
        .find(|l| l.starts_with("LINE MOUNTWATCH"))
        .cloned()
        .unwrap_or_else(|| panic!("{lines:#?}"));
    eprintln!("SUMMARY upstream_mount {watch}");
    assert!(
        lines.iter().any(|l| l == "UPSTREAM-MOUNT late result=0"),
        "{lines:#?}"
    );
    assert!(
        lines
            .iter()
            .any(|l| l == "UPSTREAM-MOUNT usr-local result=0"),
        "{lines:#?}"
    );
    assert!(watch.contains("late_visible=0"), "{watch}");
    assert!(watch.contains("usr_local_visible=0"), "{watch}");
    assert!(watch.contains("tagged=0"), "{watch}");
    assert!(watch.contains("marker=unreadable(2)"), "{watch}");
}

#[test]
fn a_fifo_entry_is_refused_without_stalling() {
    let world = World::new("fifo-entry");
    let fifo = world.plugin.join("pipe.js");
    let name = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    for level in ["auto", "reduced"] {
        let mut args = world.sim_args("host", "probe");
        args.push("entry=pipe.js".into());
        args.push(format!("level={level}"));
        let started = Instant::now();
        let lines = run_to_end(&world, args);
        let took = started.elapsed();
        if caps_from(&lines).abi.is_none() {
            expect_landlock_refusal("fifo_entry", &lines);
            return;
        }
        let failed = lines
            .iter()
            .find(|l| l.starts_with("SETUP-FAILED"))
            .cloned()
            .unwrap_or_default();
        eprintln!("SUMMARY fifo_entry/{level} took={took:?} {failed}");
        assert!(failed.contains("entry-check"), "{lines:#?}");
        assert!(
            took < Duration::from_secs(3),
            "the FIFO stalled setup for {took:?}"
        );
    }
}

#[test]
fn a_duplicate_entry_is_refused() {
    let world = World::new("duplicate-entry");
    write(&world.plugin.join("other.js"), "x");
    let mut args = world.sim_args("host", "probe");
    args.push("entry2=other.js".into());
    let lines = run_to_end(&world, args);
    if caps_from(&lines).abi.is_none() {
        expect_landlock_refusal("duplicate_entry", &lines);
        return;
    }
    let refused = lines
        .iter()
        .find(|l| l.starts_with("REFUSED"))
        .cloned()
        .unwrap_or_default();
    eprintln!("SUMMARY duplicate_entry {refused}");
    assert!(
        refused.contains("--entry is given more than once"),
        "{lines:#?}"
    );
}

#[test]
fn a_program_path_that_became_a_link_or_vanished_is_refused() {
    for (mode, expected) in [
        ("link", "the program's path now ends in a link"),
        ("delete", "the program is no longer at its path"),
    ] {
        let world = World::new(&format!("program-{mode}"));
        let mut args = world.sim_args("sidecar", "marker");
        args.push("probe=marker".into());
        args.push(format!("swap_program={mode}"));
        let lines = run_to_end(&world, args);
        if !full_sidecars_available(&lines) {
            skip("program_path", "sidecars aren't available", "full");
            return;
        }
        let refused = lines
            .iter()
            .find(|l| l.starts_with("REFUSED"))
            .cloned()
            .unwrap_or_default();
        eprintln!("SUMMARY program_path/{mode} {refused}");
        assert!(refused.contains(expected), "{lines:#?}");
        assert!(
            !lines.iter().any(|l| l.starts_with("SPAWNED")),
            "{lines:#?}"
        );
    }
}

fn prebuilt_or_cc(world: &World, name: &str, source: &str) -> Option<PathBuf> {
    let package = world.root.join("progs/quick-pkg/bin");
    std::fs::create_dir_all(&package).unwrap();
    let target = package.join(name);
    if let Some(dir) = std::env::var_os("JAIL_PREBUILT_DIR") {
        return std::fs::copy(PathBuf::from(dir).join(name), &target)
            .ok()
            .map(|_| target);
    }
    let file = world.root.join(format!("{name}.c"));
    std::fs::write(&file, source).unwrap();
    let built = Command::new("cc")
        .args(["-static", "-O2", "-o"])
        .arg(&target)
        .arg(&file)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    built.then_some(target)
}

#[test]
fn sidecars_that_exit_at_once_are_never_reported_as_setup_failures() {
    let world = World::new("instant-exit");
    let mut programs = Vec::new();
    for code in [0, 200] {
        let name = format!("quick{code}");
        match prebuilt_or_cc(
            &world,
            &name,
            &format!("int main(void) {{ return {code}; }}\n"),
        ) {
            Some(path) => programs.push((code, path)),
            None => {
                skip(
                    "instant_exit",
                    "no C compiler and no JAIL_PREBUILT_DIR",
                    "host",
                );
                return;
            }
        }
    }
    let load: Vec<Child> = (0..8)
        .map(|_| {
            Command::new("sh")
                .args(["-c", "while :; do :; done"])
                .spawn()
                .unwrap()
        })
        .collect();
    let mut summary = Vec::new();
    let mut failures = Vec::new();
    for (code, program) in &programs {
        let mut started = 0;
        for _ in 0..40 {
            let mut args: Vec<String> = world
                .sim_args("sidecar", "none")
                .into_iter()
                .filter(|a| !a.starts_with("program=") && !a.starts_with("leak"))
                .collect();
            args.push(format!("program={}", program.display()));
            let lines = run_to_end(&world, args);
            if !full_sidecars_available(&lines) {
                for mut child in load {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                skip("instant_exit", "sidecars aren't available", "full");
                return;
            }
            if lines.iter().any(|l| l.starts_with("SPAWNED")) {
                started += 1;
            } else {
                failures.push(lines);
            }
        }
        summary.push(format!("exit {code}: {started}/40 started"));
    }
    for mut child in load {
        let _ = child.kill();
        let _ = child.wait();
    }
    eprintln!("SUMMARY instant_exit {}", summary.join(", "));
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn a_mount_namespace_quota_without_room_for_the_launcher_falls_back_to_host_reduced() {
    let world = World::new("mnt-quota");
    if !userns_wrapper_works() {
        skip("mnt_quota", "the test can't make a user namespace", "tool");
        return;
    }
    let script = "echo 1 > /proc/sys/user/max_mnt_namespaces && exec \"$@\"";
    let wrap = [
        "unshare",
        "--user",
        "--map-root-user",
        "sh",
        "-c",
        script,
        "sh",
    ];
    let mut host = world.sim_args("host", "probe");
    host.push("host_mode=probe".into());
    let lines = Sim::start(&world, host, &wrap).finish(Duration::from_secs(30));
    if caps_from(&lines).abi.is_none() {
        expect_landlock_refusal("mnt_quota", &lines);
        return;
    }
    let caps = lines
        .iter()
        .find(|l| l.starts_with("CAPS"))
        .cloned()
        .unwrap_or_default();
    let spawned = lines
        .iter()
        .find(|l| l.starts_with("SPAWNED"))
        .cloned()
        .unwrap_or_default();
    eprintln!("SUMMARY mnt_quota/host {caps} || {spawned}");
    assert!(
        caps.contains("full=no"),
        "the probe should fail like a real launch: {lines:#?}"
    );
    assert!(spawned.contains("level=hostReduced"), "{lines:#?}");
    assert!(
        lines.iter().any(|l| l.starts_with("LINE DONE denied=")),
        "{lines:#?}"
    );
    let mut sidecar = world.sim_args("sidecar", "probe");
    sidecar.push("probe=escape".into());
    let lines = Sim::start(&world, sidecar, &wrap).finish(Duration::from_secs(30));
    let refused = lines
        .iter()
        .find(|l| l.starts_with("REFUSED"))
        .cloned()
        .unwrap_or_default();
    eprintln!("SUMMARY mnt_quota/sidecar {refused}");
    assert!(
        refused.contains("Sidecars need user namespaces"),
        "{lines:#?}"
    );
}

#[test]
fn a_script_sources_its_siblings_and_keeps_running_the_verified_copy_after_a_rename() {
    let world = World::new("script-siblings");
    let script = world.root.join("progs/script-pkg/bin/run.sh");
    write(
        &world.root.join("progs/script-pkg/lib/setup.sh"),
        "SETUP=sourced\n",
    );
    write(
        &script,
        "#!/bin/sh\n. \"$(dirname \"$0\")/../lib/setup.sh\"\necho READY >&3\nread line <&3\necho \"AFTER self=$0 head=$(head -c 12 \"$0\" | tr '\\n' '_') setup=$SETUP script_fds=$(ls -l /proc/self/fd | grep -c run.sh)\" >&3\necho DONE >&3\n",
    );
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let mut args: Vec<String> = world
        .sim_args("sidecar", "replace-after-start")
        .into_iter()
        .filter(|a| !a.starts_with("program="))
        .collect();
    args.push(format!("program={}", script.display()));
    args.push("probe=siblings".into());
    let lines = run_to_end(&world, args);
    if !script_sidecars("script_siblings", &lines) {
        return;
    }
    let after = lines
        .iter()
        .find(|l| l.starts_with("LINE AFTER"))
        .cloned()
        .unwrap_or_else(|| panic!("{lines:#?}"));
    eprintln!("SUMMARY script_siblings {after}");
    assert!(lines.iter().any(|l| l == "REPLACED-PROGRAM"), "{lines:#?}");
    assert!(
        std::fs::read_to_string(&script).unwrap().contains("DECOY"),
        "the host copy wasn't replaced"
    );
    assert!(
        after.contains("self=/run/ardia/program/bin/run.sh"),
        "{after}"
    );
    assert!(
        after.contains("setup=sourced"),
        "the sibling wasn't sourced: {after}"
    );
    assert!(
        after.contains("script_fds=0"),
        "a child inherited the script's fd: {after}"
    );
    assert!(
        after.contains("head=#!/bin/sh_. "),
        "the script now reads the replacement: {after}"
    );
    assert!(
        !lines.iter().any(|l| l.contains("DECOY")),
        "the replacement ran: {lines:#?}"
    );
}

#[test]
fn a_script_sees_real_siblings_through_unreadable_and_crowded_folders() {
    let world = World::new("crowded-script");
    let package = world.root.join("progs/crowd-pkg");
    let script = package.join("bin/run.sh");
    write(&package.join("lib/setup.sh"), "SETUP=sourced\n");
    write(&package.join("bin/helper.sh"), "echo helped\n");
    write(
        &script,
        "#!/bin/sh\n. \"$(dirname \"$0\")/../lib/setup.sh\"\nfound=$(find \"$(dirname \"$0\")/../lib\" \"$(dirname \"$0\")/helper.sh\" -type f 2>/dev/null | wc -l)\nhelper=$(sh \"$(dirname \"$0\")/helper.sh\")\ntouch \"$(dirname \"$0\")/new\" 2>/dev/null && echo WROTE-PROGRAM >&3\nprintf '#!/bin/sh\\necho RAN\\n' > \"$HOME/t.sh\"; chmod 755 \"$HOME/t.sh\"; \"$HOME/t.sh\" >/dev/null 2>&1; data_exec=$?\necho \"CROWD self=$0 setup=$SETUP found=$found helper=$helper data_exec=$data_exec\" >&3\necho DONE >&3\n",
    );
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    for index in 0..5000 {
        std::fs::write(package.join(format!("bin/crowd-{index:04}")), "").unwrap();
    }
    std::fs::set_permissions(
        package.join("bin"),
        std::os::unix::fs::PermissionsExt::from_mode(0o111),
    )
    .unwrap();
    let mut args: Vec<String> = world
        .sim_args("sidecar", "probe")
        .into_iter()
        .filter(|a| !a.starts_with("program="))
        .collect();
    args.push(format!("program={}", script.display()));
    args.push("probe=crowded".into());
    let lines = run_to_end(&world, args);
    std::fs::set_permissions(
        package.join("bin"),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    if !script_sidecars("crowded_script", &lines) {
        return;
    }
    let crowd = lines
        .iter()
        .find(|l| l.starts_with("LINE CROWD"))
        .cloned()
        .unwrap_or_else(|| panic!("{lines:#?}"));
    eprintln!("SUMMARY crowded_script {crowd}");
    assert!(
        crowd.contains("self=/run/ardia/program/bin/run.sh"),
        "{crowd}"
    );
    assert!(crowd.contains("setup=sourced"), "{crowd}");
    assert!(
        crowd.contains("found=2"),
        "find -type f should see the real helper files: {crowd}"
    );
    assert!(crowd.contains("helper=helped"), "{crowd}");
    assert!(
        crowd.contains("data_exec=126"),
        "Landlock should still refuse running files from the data folder: {crowd}"
    );
    assert!(
        !lines.iter().any(|l| l.contains("WROTE-PROGRAM")),
        "{lines:#?}"
    );
}

fn mount_wrapper(target: &Path, source: &Path, options: &str) -> Vec<String> {
    let script = format!(
        "mount -t tmpfs -o {options},size=16m wrapped '{}' && cp -a '{}/.' '{}/' && exec \"$@\"",
        target.display(),
        source.display(),
        target.display()
    );
    [
        "unshare",
        "--user",
        "--map-root-user",
        "--mount",
        "--propagation",
        "private",
        "sh",
        "-c",
        &script,
        "sh",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn noexec_wrapper(target: &Path, source: &Path) -> Vec<String> {
    mount_wrapper(target, source, "noexec")
}

#[test]
fn programs_in_a_noexec_folder_never_run() {
    let world = World::new("noexec");
    if !userns_wrapper_works() {
        skip(
            "noexec",
            "the test can't make a user namespace to mount in",
            "tool",
        );
        return;
    }
    let source = world.root.join("progs-src/pkg");
    write(
        &source.join("bin/run.sh"),
        "#!/bin/sh\necho RAN >&3\necho DONE >&3\n",
    );
    write(&source.join("bin/helper.sh"), "#!/bin/sh\necho HELPER\n");
    std::fs::copy(harness(), source.join("bin/tool")).unwrap();
    for name in ["bin/run.sh", "bin/helper.sh", "bin/tool"] {
        std::fs::set_permissions(
            source.join(name),
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
    }
    let target = world.root.join("progs/noexec-pkg");
    std::fs::create_dir_all(&target).unwrap();
    let wrap = noexec_wrapper(&target, &source);
    let wrap: Vec<&str> = wrap.iter().map(String::as_str).collect();
    for program in ["bin/run.sh", "bin/tool"] {
        let mut args: Vec<String> = world
            .sim_args("sidecar", "probe")
            .into_iter()
            .filter(|a| !a.starts_with("program=") && !a.starts_with("static="))
            .collect();
        args.push(format!("program={}", target.join(program).display()));
        args.push("probe=escape".into());
        args.push("static=0".into());
        let lines = Sim::start(&world, args, &wrap).finish(Duration::from_secs(30));
        if !full_sidecars_available(&lines) {
            skip(
                "noexec",
                "sidecars aren't available inside the test's namespace",
                "full",
            );
            return;
        }
        let outcome = lines
            .iter()
            .find(|l| {
                l.starts_with("REFUSED")
                    || l.starts_with("SETUP-FAILED")
                    || l.starts_with("SPAWNED")
            })
            .cloned()
            .unwrap_or_default();
        eprintln!("SUMMARY noexec/{program} {outcome}");
        assert!(
            !lines
                .iter()
                .any(|l| l == "LINE RAN" || l.starts_with("LINE RESULT")),
            "{program} ran from a noexec folder: {lines:#?}"
        );
        assert!(
            outcome.starts_with("REFUSED") && outcome.contains("noexec"),
            "{program}: {lines:#?}"
        );
    }
}

#[test]
fn a_script_another_user_owns_with_unusual_mode_bits_still_runs() {
    let world = World::new("foreign-mode");
    let sudo = Command::new("sudo")
        .args(["-n", "true"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !sudo {
        skip(
            "foreign_mode",
            "the test needs passwordless sudo to make a root-owned script",
            "tool",
        );
        return;
    }
    let package = world.root.join("progs/foreign-pkg");
    let script = package.join("bin/run.sh");
    write(
        &script,
        "#!/bin/sh\necho \"FOREIGN self=$0\" >&3\necho DONE >&3\n",
    );
    let ok = Command::new("sudo")
        .args(["-n", "sh", "-c"])
        .arg(format!(
            "chown -R 0:0 '{}' && chmod 0055 '{}'",
            package.display(),
            script.display()
        ))
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    assert!(ok, "couldn't prepare the root-owned script");
    let mut args: Vec<String> = world
        .sim_args("sidecar", "probe")
        .into_iter()
        .filter(|a| !a.starts_with("program="))
        .collect();
    args.push(format!("program={}", script.display()));
    args.push("probe=foreign".into());
    let lines = run_to_end(&world, args);
    let _ = Command::new("sudo")
        .args(["-n", "chown", "-R"])
        .arg(format!("{}:{}", unsafe { libc::getuid() }, unsafe {
            libc::getgid()
        }))
        .arg(&package)
        .status();
    if !script_sidecars("foreign_mode", &lines) {
        return;
    }
    let ran = lines
        .iter()
        .find(|l| l.starts_with("LINE FOREIGN"))
        .cloned()
        .unwrap_or_default();
    eprintln!("SUMMARY foreign_mode {ran}");
    assert!(
        ran.contains("self=/run/ardia/program/bin/run.sh"),
        "{lines:#?}"
    );
}

#[test]
fn scripts_inside_folders_are_refused_without_overlayfs_while_elf_sidecars_still_run() {
    let world = World::new("no-overlay");
    let script = world.root.join("progs/no-overlay-pkg/bin/run.sh");
    write(&script, "#!/bin/sh\necho RAN >&3\necho DONE >&3\n");
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let mut args: Vec<String> = world
        .sim_args("sidecar", "probe")
        .into_iter()
        .filter(|a| !a.starts_with("program="))
        .collect();
    args.push(format!("program={}", script.display()));
    let lines = run_to_end(&world, args);
    if !full_sidecars_available(&lines) {
        skip("no_overlay", "sidecars aren't available", "full");
        return;
    }
    let caps = lines
        .iter()
        .find(|l| l.starts_with("CAPS"))
        .cloned()
        .unwrap_or_default();
    if caps_from(&lines).folder_scripts {
        assert!(
            !no_overlay_expected(),
            "JAIL_EXPECT_NO_OVERLAY=1 but overlayfs works: {caps}"
        );
        eprintln!("SUMMARY no_overlay not-applicable (overlayfs works here)");
        return;
    }
    let refused = lines
        .iter()
        .find(|l| l.starts_with("REFUSED"))
        .cloned()
        .unwrap_or_default();
    assert!(refused.contains("overlayfs"), "{lines:#?}");
    assert!(
        !lines
            .iter()
            .any(|l| l == "LINE RAN" || l.starts_with("SPAWNED")),
        "{lines:#?}"
    );
    let elf = run_to_end(&world, world.sim_args("sidecar", "probe"));
    let (_, escaped) = summarize("no_overlay_elf", &elf);
    assert!(elf.iter().any(|l| l.starts_with("SPAWNED")), "{elf:#?}");
    assert_eq!(escaped, 0, "{elf:#?}");
    world.check_untouched();
    eprintln!("SUMMARY no_overlay script-refused elf-ran {caps}");
}

const NOSYMFOLLOW_SCRIPT: &str = "#!/bin/sh\nd=$(dirname \"$0\")\nif err=$(cat \"$d/link\" 2>&1 >/dev/null); then f=1; else f=0; fi\nopts=$(grep ' /run/ardia/program ' /proc/self/mountinfo | cut -d' ' -f6 | tr '\\n' '|')\necho \"NOSYM followed=$f opts=$opts err=$err\" >&3\necho DONE >&3\n";

#[test]
fn a_script_in_a_nosymfollow_folder_still_cant_follow_links_once_pinned() {
    let world = World::new("nosymfollow");
    if !userns_wrapper_works() {
        skip(
            "nosymfollow",
            "the test can't make a user namespace to mount in",
            "tool",
        );
        return;
    }
    let source = world.root.join("progs-src/sym");
    write(&source.join("pkg/bin/run.sh"), NOSYMFOLLOW_SCRIPT);
    write(&source.join("pkg/bin/target.txt"), "target\n");
    std::os::unix::fs::symlink("target.txt", source.join("pkg/bin/link")).unwrap();
    std::fs::set_permissions(
        source.join("pkg/bin/run.sh"),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let mut outcomes = Vec::new();
    for (label, options) in [("plain", None), ("nosymfollow", Some("nosymfollow"))] {
        let target = world.root.join(format!("progs/sym-{label}"));
        std::fs::create_dir_all(&target).unwrap();
        let wrap = match options {
            Some(options) => mount_wrapper(&target, &source, options),
            None => {
                std::process::Command::new("cp")
                    .arg("-a")
                    .arg(format!("{}/.", source.display()))
                    .arg(&target)
                    .status()
                    .unwrap();
                Vec::new()
            }
        };
        let wrap: Vec<&str> = wrap.iter().map(String::as_str).collect();
        let mut args: Vec<String> = world
            .sim_args("sidecar", "probe")
            .into_iter()
            .filter(|a| !a.starts_with("program="))
            .collect();
        args.push(format!(
            "program={}",
            target.join("pkg/bin/run.sh").display()
        ));
        let lines = Sim::start(&world, args, &wrap).finish(Duration::from_secs(30));
        if !script_sidecars(&format!("nosymfollow/{label}"), &lines) {
            return;
        }
        let seen = lines
            .iter()
            .find(|l| l.starts_with("LINE NOSYM"))
            .cloned()
            .unwrap_or_else(|| panic!("{label}: {lines:#?}"));
        eprintln!("SUMMARY nosymfollow/{label} {seen}");
        outcomes.push((label, seen));
    }
    assert!(outcomes[0].1.contains("followed=1"), "{outcomes:?}");
    assert!(outcomes[1].1.contains("nosymfollow"), "{outcomes:?}");
    assert!(
        outcomes[1].1.contains("followed=0"),
        "a link was followed in a nosymfollow folder: {outcomes:?}"
    );
}

#[test]
fn a_program_the_launching_user_cant_execute_is_refused() {
    let world = World::new("unrunnable");
    let sudo = Command::new("sudo")
        .args(["-n", "true"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !sudo {
        skip(
            "unrunnable",
            "the test needs passwordless sudo to make a root-owned script",
            "tool",
        );
        return;
    }
    let package = world.root.join("progs/unrunnable-pkg");
    let script = package.join("bin/run.sh");
    write(&script, "#!/bin/sh\necho RAN >&3\necho DONE >&3\n");
    let ok = Command::new("sudo")
        .args(["-n", "sh", "-c"])
        .arg(format!(
            "chown -R 0:0 '{}' && chmod 0744 '{}'",
            package.display(),
            script.display()
        ))
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    assert!(ok, "couldn't prepare the root-owned script");
    let mut args: Vec<String> = world
        .sim_args("sidecar", "probe")
        .into_iter()
        .filter(|a| !a.starts_with("program="))
        .collect();
    args.push(format!("program={}", script.display()));
    let lines = run_to_end(&world, args);
    let _ = Command::new("sudo")
        .args(["-n", "chown", "-R"])
        .arg(format!("{}:{}", unsafe { libc::getuid() }, unsafe {
            libc::getgid()
        }))
        .arg(&package)
        .status();
    if !full_sidecars_available(&lines) {
        skip("unrunnable", "sidecars aren't available", "full");
        return;
    }
    let refused = lines
        .iter()
        .find(|l| l.starts_with("REFUSED"))
        .cloned()
        .unwrap_or_default();
    eprintln!("SUMMARY unrunnable {refused}");
    assert!(!lines.iter().any(|l| l == "LINE RAN"), "{lines:#?}");
    assert!(
        refused.contains("can't run this program yourself"),
        "{lines:#?}"
    );
}
