use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

pub const CHANNEL_FD: i32 = 3;
pub const MAX_INCOMING_LINE: usize = 32 << 20;
pub const SEARCH_PATH: [&str; 6] = [
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
];
const LOG_LIMIT: u64 = 4 << 20;
pub const HOST_ENV: &str = "ARDIA_PLUGIN_HOST";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Script,
    Program,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxSpec {
    pub home: String,
    pub app_data: String,
    pub config: String,
    pub plugin: String,
    pub data: String,
    pub program: String,
    pub network: bool,
    pub kind: Kind,
}

const MACH_ALLOWED: [&str; 6] = [
    "com.apple.system.opendirectoryd.libinfo",
    "com.apple.system.opendirectoryd.membership",
    "com.apple.logd",
    "com.apple.bsd.dirhelper",
    "com.apple.cfprefsd.agent",
    "com.apple.cfprefsd.daemon",
];
const MACH_ALLOWED_ONLINE: [&str; 5] = [
    "com.apple.SystemConfiguration.DNSConfiguration",
    "com.apple.SystemConfiguration.configd",
    "com.apple.trustd",
    "com.apple.trustd.agent",
    "com.apple.TrustEvaluationAgent",
];
const SYSTEM_READABLE: [&str; 6] = [
    "/System",
    "/usr/lib",
    "/usr/share",
    "/Library/Apple",
    "/Library/Preferences/Logging",
    "/private/var/db/timezone",
];
const SYSTEM_MAPPABLE: [&str; 3] = ["/System", "/usr/lib", "/Library/Apple"];
const CRYPTEXES: [&str; 4] = [
    "/System/Volumes/Preboot/Cryptexes/App/System",
    "/System/Volumes/Preboot/Cryptexes/Incoming/OS",
    "/System/Volumes/Preboot/Cryptexes/OS",
    "/System/Volumes/Preboot/Cryptexes/Rosetta",
];
const DEVICES_READABLE: [&str; 3] = ["/dev/random", "/dev/urandom", "/dev/autofs_nowait"];
const DEVICES_WRITABLE: [&str; 2] = ["/dev/null", "/dev/zero"];
const UNREADABLE_TREES: [&str; 2] = ["/Users", "/Volumes"];
const PACKAGE_PREFIXES: [&str; 2] = ["/usr/local", "/opt/homebrew"];
const PACKAGE_FOLDERS: [&str; 8] = [
    "bin",
    "sbin",
    "lib",
    "libexec",
    "opt",
    "Cellar",
    "Frameworks",
    "share",
];
const TOOL_SYSTEM_FILES: [&str; 8] = [
    "/private/etc/passwd",
    "/private/etc/group",
    "/private/etc/protocols",
    "/private/etc/services",
    "/private/etc/shells",
    "/private/etc/localtime",
    "/private/var/db/xcode_select_link",
    "/Library/Preferences/com.apple.dt.Xcode.plist",
];
const COMMAND_LINE_TOOLS: &str = "/Library/Developer/CommandLineTools";
const TOOL_SYSTEM_FOLDERS: [&str; 2] = ["/private/etc/ssl", "/private/var/select"];
const ONLINE_SYSTEM_FILES: [&str; 3] = [
    "/private/etc/hosts",
    "/private/etc/resolv.conf",
    "/private/var/run/resolv.conf",
];
const SHARED_TEMPORARY_TREES: [&str; 4] = ["/private/tmp", "/private/var", "/tmp", "/var"];

fn any(filter: &str, paths: &[String]) -> String {
    paths
        .iter()
        .map(|p| format!("({filter} \"{p}\")"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn owned(paths: &[&str]) -> Vec<String> {
    paths.iter().map(|p| (*p).to_owned()).collect()
}

fn tool_folders() -> Vec<String> {
    let mut out = owned(&["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/libexec"]);
    for prefix in PACKAGE_PREFIXES {
        for folder in PACKAGE_FOLDERS {
            out.push(format!("{prefix}/{folder}"));
        }
    }
    out
}

pub fn profile(network: bool, kind: Kind) -> String {
    let mut mach = owned(&MACH_ALLOWED);
    if network {
        mach.extend(owned(&MACH_ALLOWED_ONLINE));
    }
    let preferences =
        "\n(allow user-preference-read (preference-domain \"kCFPreferencesAnyApplication\"))";
    let (programs, own_programs) = match kind {
        Kind::Script => (
            String::new(),
            "(allow process-exec (literal (param \"PROGRAM\")))".to_owned(),
        ),
        Kind::Program => {
            let mut tools = tool_folders();
            tools.push(COMMAND_LINE_TOOLS.to_owned());
            let mut readable = tools.clone();
            readable.extend(owned(&TOOL_SYSTEM_FOLDERS));
            (
                format!(
                    "\n(allow process-fork)\n(allow process-exec file-map-executable {})\n(allow file-read* {} {})\n(allow file-read* file-write-data file-ioctl (literal \"/dev/dtracehelper\"))",
                    any("subpath", &tools),
                    any("subpath", &readable),
                    any("literal", &owned(&TOOL_SYSTEM_FILES)),
                ),
                "(allow process-exec (literal (param \"PROGRAM\")) (subpath (param \"PLUGIN\")) (subpath (param \"INSTALL\")))".to_owned(),
            )
        }
    };
    let online = if network {
        format!(
            "\n(allow network-outbound (remote ip))\n(allow network-bind (local ip))\n(allow network-inbound (local ip))\n(allow network-outbound (remote unix-socket (literal \"/private/var/run/mDNSResponder\")))\n(allow file-read* {})",
            any("literal", &owned(&ONLINE_SYSTEM_FILES))
        )
    } else {
        String::new()
    };
    format!(
        "(version 1)
(deny default)
(deny appleevent-send lsopen job-creation distributed-notification-post darwin-notification-post user-preference-write iokit-open sysctl-write)
(deny process-info* signal ipc-posix-shm* mach-lookup user-preference-read)
(allow file-read-metadata)
(allow file-read* (literal \"/\") {} {})
(allow file-map-executable {})
(deny file-read* file-map-executable (subpath \"/System/Volumes\"))
(allow file-read* file-map-executable {})
(allow file-read* file-write-data {})
(allow file-read-data file-write-data (subpath \"/dev/fd\"))
(allow sysctl-read)
(allow system-info (info-type \"vfs.disk-space\"))
(allow process-info* (target same-sandbox))
(allow signal (target same-sandbox))
(allow process-info-listpids)
(allow system-socket)
(allow ipc-posix-shm-read* (ipc-posix-name \"apple.shm.notification_center\") (ipc-posix-name-prefix \"apple.cfprefs.\"))
(allow mach-lookup {}){preferences}{programs}{online}
(deny file-read* file-read-metadata file-write* file-map-executable process-exec (subpath (param \"HOME\")) (subpath (param \"APP_DATA\")) (subpath (param \"CONFIG\")))
(deny file-read* file-read-metadata file-write* file-map-executable process-exec {})
(allow file-read-metadata {})
(allow file-read* file-read-metadata file-map-executable (subpath (param \"PLUGIN\")) (literal (param \"PROGRAM\")) (subpath (param \"INSTALL\")))
(allow file-read* file-read-metadata file-write* file-ioctl (subpath (param \"DATA\")))
(allow file-read-metadata (literal (param \"HOME\")))
{own_programs}",
        any("subpath", &owned(&SYSTEM_READABLE)),
        any("literal", &owned(&DEVICES_READABLE)),
        any("subpath", &owned(&SYSTEM_MAPPABLE)),
        any("subpath", &owned(&CRYPTEXES)),
        any("literal", &owned(&DEVICES_WRITABLE)),
        any("global-name", &mach),
        any("subpath", &owned(&UNREADABLE_TREES)),
        any("literal", &owned(&UNREADABLE_TREES)),
    )
}

pub fn is_inside(path: &str, folder: &str) -> bool {
    path == folder
        || path.starts_with(&if folder.ends_with('/') {
            folder.to_owned()
        } else {
            format!("{folder}/")
        })
}

fn overlaps(a: &str, b: &str) -> bool {
    is_inside(a, b) || is_inside(b, a)
}

fn parent(path: &str) -> String {
    Path::new(path)
        .parent()
        .map_or_else(|| "/".to_owned(), |p| p.to_string_lossy().into_owned())
}

impl SandboxSpec {
    pub fn install_folder(&self) -> String {
        if self.kind == Kind::Script {
            return self.program.clone();
        }
        let up = parent(&self.program);
        let folder = if Path::new(&up).file_name().is_some_and(|n| n == "bin") {
            parent(&up)
        } else {
            up
        };
        let protected = [&self.home, &self.app_data, &self.config];
        if folder == "/"
            || folder.split('/').filter(|p| !p.is_empty()).count() < 2
            || protected.iter().any(|p| overlaps(p, &folder))
            || (UNREADABLE_TREES.iter().any(|t| overlaps(t, &folder))
                && !is_inside(&folder, &self.plugin))
            || (SHARED_TEMPORARY_TREES.iter().any(|t| overlaps(t, &folder))
                && !is_inside(&folder, &self.plugin))
            || std::iter::once("/usr")
                .chain(PACKAGE_PREFIXES)
                .any(|p| is_inside(&folder, p))
        {
            return self.program.clone();
        }
        folder
    }

    fn path_rules(&self) -> (String, Vec<(String, String)>) {
        let roots = [&self.home, &self.app_data, &self.config];
        let mut chain: Vec<String> = Vec::new();
        for path in [&self.plugin, &self.program, &self.data] {
            for root in roots.iter().filter(|root| is_inside(path, root)) {
                let mut current = parent(path);
                while is_inside(&current, root) && current != **root {
                    chain.push(current.clone());
                    current = parent(&current);
                }
                chain.push((*root).clone());
            }
        }
        chain.sort();
        chain.dedup();
        let mut text = String::new();
        let mut params = Vec::new();
        for (step, folder) in chain.into_iter().enumerate() {
            let name = format!("PATH_UP_{step}");
            text.push_str(&format!(
                "\n(allow file-read-metadata (literal (param \"{name}\")))"
            ));
            params.push((name, folder));
        }
        (text, params)
    }

    pub fn checked(&self) -> Result<(), String> {
        for path in [&self.plugin, &self.data, &self.program] {
            if path.is_empty() || path.contains('\0') || path.contains('"') {
                return Err("a path the sandbox can't name".into());
            }
        }
        if self.plugin == "/"
            || [&self.home, &self.config, &self.app_data]
                .iter()
                .any(|p| is_inside(p, &self.plugin))
        {
            return Err(
                "its folder takes in Ardia's data, its settings or your home folder".into(),
            );
        }
        let plugins_root = format!("{}/plugins", self.config);
        let official_root = format!("{}/OfficialPlugins", self.app_data);
        let in_plugins = is_inside(&self.plugin, &plugins_root) && self.plugin != plugins_root;
        let in_official = is_inside(&self.plugin, &official_root)
            && self.plugin[official_root.len()..]
                .trim_start_matches('/')
                .split('/')
                .count()
                == 2;
        if (is_inside(&self.plugin, &self.config) || is_inside(&self.plugin, &self.app_data))
            && !in_plugins
            && !in_official
        {
            return Err("its folder is in Ardia's data or config folder".into());
        }
        if !is_inside(&self.program, &self.plugin)
            && (is_inside(&self.program, &self.app_data) || is_inside(&self.program, &self.config))
        {
            return Err("its program is in Ardia's data or config folder".into());
        }
        if !is_inside(&self.data, &self.app_data) || is_inside(&self.app_data, &self.data) {
            return Err("its data folder is in the wrong place".into());
        }
        Ok(())
    }

    pub fn arguments(&self) -> Result<Vec<String>, String> {
        self.checked()?;
        let (rules, path_params) = self.path_rules();
        let mut params: Vec<(String, String)> = vec![
            ("APP_DATA".into(), self.app_data.clone()),
            ("CONFIG".into(), self.config.clone()),
            ("DATA".into(), self.data.clone()),
            ("HOME".into(), self.home.clone()),
            ("INSTALL".into(), self.install_folder()),
            ("PLUGIN".into(), self.plugin.clone()),
            ("PROGRAM".into(), self.program.clone()),
        ];
        params.extend(path_params);
        params.sort();
        let mut out = vec!["-p".to_owned(), profile(self.network, self.kind) + &rules];
        for (key, value) in params {
            out.push("-D".into());
            out.push(format!("{key}={value}"));
        }
        Ok(out)
    }
}

pub fn resolved(path: &Path) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

pub fn host_binary() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(given) = std::env::var_os(HOST_ENV).filter(|v| !v.is_empty()) {
        candidates.push(PathBuf::from(given));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join("ardia-plugin-host"));
        candidates.push(dir.join("../Helpers/ardia-plugin-host"));
        candidates.push(dir.join("../Helpers/ArdiaPluginHost"));
    }
    candidates.into_iter().find_map(|c| {
        let real = std::fs::canonicalize(&c).ok()?;
        let meta = std::fs::metadata(&real).ok()?;
        use std::os::unix::fs::PermissionsExt;
        (meta.is_file() && meta.permissions().mode() & 0o111 != 0).then_some(real)
    })
}

pub fn local_program(first: &str, plugin: &Path) -> Option<String> {
    if first.starts_with('/') {
        return resolved(Path::new(first));
    }
    if first.contains('/') {
        let real = resolved(&plugin.join(first))?;
        return is_inside(&real, &plugin.to_string_lossy()).then_some(real);
    }
    SEARCH_PATH.iter().find_map(|dir| {
        let candidate = Path::new(dir).join(first);
        use std::os::unix::fs::PermissionsExt;
        let executable = std::fs::metadata(&candidate)
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
        if executable {
            resolved(&candidate)
        } else {
            None
        }
    })
}

#[derive(Clone, Debug)]
pub struct Launch {
    pub name: String,
    pub sandbox: SandboxSpec,
    pub launched: String,
    pub arguments: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub log: PathBuf,
}

pub fn helper_environment(name: &str, data: &Path) -> Vec<(String, String)> {
    vec![
        ("PATH".into(), SEARCH_PATH.join(":")),
        (
            "HOME".into(),
            data.join("home").to_string_lossy().into_owned(),
        ),
        (
            "TMPDIR".into(),
            format!("{}/", data.join("tmp").to_string_lossy()),
        ),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("ARDIA_PLUGIN_NAME".into(), name.to_owned()),
        ("ARDIA_PLUGIN_FD".into(), CHANNEL_FD.to_string()),
        ("ARDIA_PLUGIN_PROTOCOL".into(), "1".into()),
    ]
}

pub struct Running {
    pub pid: u32,
    writer: Mutex<UnixStream>,
}

impl Running {
    pub fn send(&self, line: &str) -> bool {
        if line.contains('\n') || line.contains('\r') {
            return false;
        }
        let mut writer = self.writer.lock();
        writer.write_all(line.as_bytes()).is_ok() && writer.write_all(b"\n").is_ok()
    }

    pub fn terminate(&self, grace: Duration) {
        let pid = self.pid as i32;
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
        std::thread::spawn(move || {
            std::thread::sleep(grace);
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        });
    }
}

fn open_log(path: &Path) -> std::io::Result<std::fs::File> {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > LOG_LIMIT) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

fn read_lines(stream: UnixStream, mut on_line: impl FnMut(String)) {
    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = (&mut reader)
            .take(MAX_INCOMING_LINE as u64 + 1)
            .read_until(b'\n', &mut buffer);
        match read {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                if buffer.len() > MAX_INCOMING_LINE {
                    return;
                }
                let text = String::from_utf8_lossy(&buffer);
                let text = text.trim_end_matches(['\n', '\r']);
                if !text.is_empty() {
                    on_line(text.to_owned());
                }
            }
        }
    }
}

pub fn spawn(
    launch: &Launch,
    on_line: impl FnMut(String) + Send + 'static,
    on_exit: impl FnOnce(Option<i32>, Option<i32>) + Send + 'static,
) -> Result<Arc<Running>, String> {
    use std::os::unix::io::AsRawFd;
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    let sandbox = launch.sandbox.arguments()?;
    let (ours, theirs) = UnixStream::pair().map_err(|e| format!("no channel ({e})"))?;
    let log = open_log(&launch.log).map_err(|e| format!("its log couldn't be opened ({e})"))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("its log couldn't be opened ({e})"))?;
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .args(&sandbox)
        .arg(&launch.launched)
        .args(&launch.arguments)
        .current_dir(&launch.cwd)
        .env_clear()
        .envs(launch.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    let child_fd = theirs.as_raw_fd();
    unsafe {
        command.pre_exec(move || {
            if child_fd == CHANNEL_FD {
                let flags = libc::fcntl(CHANNEL_FD, libc::F_GETFD);
                if flags < 0
                    || libc::fcntl(CHANNEL_FD, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(child_fd, CHANNEL_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::setpgid(0, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child: Child = command
        .spawn()
        .map_err(|e| format!("it couldn't start ({e})"))?;
    drop(theirs);
    let pid = child.id();
    let reader = ours.try_clone().map_err(|e| format!("no channel ({e})"))?;
    let running = Arc::new(Running {
        pid,
        writer: Mutex::new(ours),
    });
    let name = launch.name.clone();
    std::thread::Builder::new()
        .name(format!("plugin-{name}-lines"))
        .spawn(move || read_lines(reader, on_line))
        .map_err(|e| format!("no reader ({e})"))?;
    std::thread::Builder::new()
        .name(format!("plugin-{}-wait", launch.name))
        .spawn(move || {
            let status = child.wait().ok();
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            on_exit(
                status.and_then(|s| s.code()),
                status.and_then(|s| s.signal()),
            );
        })
        .map_err(|e| format!("no watcher ({e})"))?;
    Ok(running)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(plugin: &str, program: &str) -> SandboxSpec {
        SandboxSpec {
            home: "/Users/me".into(),
            app_data: "/Users/me/Library/Ardia".into(),
            config: "/Users/me/.config/ardia".into(),
            plugin: plugin.into(),
            data: "/Users/me/Library/Ardia/PluginData/notes".into(),
            program: program.into(),
            network: false,
            kind: Kind::Program,
        }
    }

    #[test]
    fn profiles_stay_offline_unless_asked() {
        let offline = profile(false, Kind::Script);
        assert!(offline.starts_with("(version 1)\n(deny default)"));
        assert!(!offline.contains("network-outbound"));
        assert!(offline.ends_with("(allow process-exec (literal (param \"PROGRAM\")))"));
        assert!(profile(true, Kind::Program).contains("(allow network-outbound (remote ip))"));
    }

    #[test]
    fn sandboxes_refuse_folders_in_ardias_data_and_name_the_path_chain() {
        let ok = spec("/Users/me/.config/ardia/plugins/notes", "/usr/bin/python3");
        let args = ok.arguments().unwrap();
        assert_eq!(args[0], "-p");
        assert!(args.contains(&"PLUGIN=/Users/me/.config/ardia/plugins/notes".to_owned()));
        assert!(args.contains(&"INSTALL=/usr/bin/python3".to_owned()));
        assert!(args.iter().any(|a| a == "PATH_UP_0=/Users/me"));
        assert!(
            spec("/Users/me/Library/Ardia/Scratch", "/usr/bin/x")
                .checked()
                .is_err()
        );
        assert!(spec("/Users", "/usr/bin/x").checked().is_err());
        assert!(
            spec(
                "/Users/me/.config/ardia/plugins/notes",
                "/Users/me/Library/Ardia/x"
            )
            .checked()
            .is_err()
        );
        let official = spec(
            "/Users/me/Library/Ardia/OfficialPlugins/cli/abc",
            "/usr/bin/x",
        );
        assert!(official.checked().is_ok());
    }

    #[test]
    fn a_spawned_helper_talks_over_fd_3() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("cfg/plugins/echo");
        std::fs::create_dir_all(&plugin).unwrap();
        let data = dir.path().join("data/PluginData/echo");
        std::fs::create_dir_all(data.join("tmp")).unwrap();
        let real = |p: &Path| resolved(p).unwrap();
        let launch = Launch {
            name: "echo".into(),
            sandbox: SandboxSpec {
                home: real(dir.path()),
                app_data: real(&dir.path().join("data")),
                config: real(&dir.path().join("cfg")),
                plugin: real(&plugin),
                data: real(&data),
                program: "/bin/sh".into(),
                network: false,
                kind: Kind::Program,
            },
            launched: "/bin/sh".into(),
            arguments: vec![
                "-c".into(),
                "echo '{\"id\":1,\"method\":\"hello\"}' >&3; read line <&3; echo \"$line\" >&3"
                    .into(),
            ],
            cwd: plugin.clone(),
            env: helper_environment("echo", &data),
            log: data.join("plugin.log"),
        };
        let (lines, received) = std::sync::mpsc::channel();
        let (exits, exited) = std::sync::mpsc::channel();
        let running = spawn(
            &launch,
            move |line| {
                let _ = lines.send(line);
            },
            move |code, _| {
                let _ = exits.send(code);
            },
        )
        .unwrap();
        let first = received.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(first, "{\"id\":1,\"method\":\"hello\"}");
        assert!(running.send("{\"id\":1,\"result\":{}}"));
        assert_eq!(
            received.recv_timeout(Duration::from_secs(10)).unwrap(),
            "{\"id\":1,\"result\":{}}"
        );
        assert_eq!(
            exited.recv_timeout(Duration::from_secs(10)).unwrap(),
            Some(0)
        );
    }
}
