use std::collections::HashMap;
use std::ffi::{CString, OsStr, OsString};
use std::fmt;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::cgroup::{CgroupDelegate, RunCgroup};
use crate::elf::{self, Linkage};
use crate::frame::{Frame, MountCheck, PinnedProgram, Rule, Target};
use crate::landlock::{self, Unavailable};
use crate::plan;
use crate::restart::SpawnLimiter;
use crate::roots::{self, Granted, ProgramPlacement};
use crate::spawn::{self, ForkSpec, Spawner};
use crate::{
    procscan, seccomp, sys, Level, RunKind, BROKER_PATH_IN_JAIL, DATA_IN_JAIL, LANDLOCK_MISSING,
    PLUGIN_IN_JAIL, PROGRAM_FD_IN_JAIL, PROGRAM_IN_JAIL,
};

pub type RunId = u64;

pub const READY_DEADLINE: Duration = Duration::from_secs(5);
pub const STOP_GRACE: Duration = Duration::from_secs(3);
pub const QUIT_GRACE: Duration = Duration::from_secs(1);
const TEARDOWN_DEADLINE: Duration = Duration::from_secs(3);
const PLUGIN_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin";
const SANDBOX_OWNED_VARIABLES: &[&str] = &[
    "PATH",
    "HOME",
    "TMPDIR",
    "ARDIA_PLUGIN_NAME",
    "ARDIA_PLUGIN_FD",
];

pub struct SupervisorConfig {
    pub broker_exe: OwnedFd,
    pub bwrap: Option<OwnedFd>,
    pub plugin_parents: Vec<OwnedFd>,
    pub forbidden: Vec<OwnedFd>,
    pub ready_deadline: Duration,
    pub landlock_abi_cap: u32,
    pub allow_full: bool,
    pub require_static_launcher: bool,
    pub cgroup: Option<CgroupDelegate>,
}

impl SupervisorConfig {
    pub fn new(broker_exe: OwnedFd, bwrap: Option<OwnedFd>) -> SupervisorConfig {
        SupervisorConfig {
            broker_exe,
            bwrap,
            plugin_parents: Vec::new(),
            forbidden: Vec::new(),
            ready_deadline: READY_DEADLINE,
            landlock_abi_cap: landlock::NEWEST_KNOWN_ABI,
            allow_full: true,
            require_static_launcher: true,
            cgroup: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderScripts {
    Available,
    Unsupported(String),
    Unknown(String),
}

#[derive(Debug, Clone)]
pub struct Capabilities {
    pub landlock_abi: Result<u32, Unavailable>,
    pub full_isolation: Result<(), String>,
    pub folder_scripts: FolderScripts,
    pub launcher: Linkage,
    pub cgroup: Option<PathBuf>,
}

pub struct Program {
    file: OwnedFd,
    folder: Option<OwnedFd>,
    path: PathBuf,
    script: bool,
}

impl Program {
    pub fn resolve(file: OwnedFd, forbidden: &[OwnedFd]) -> io::Result<Program> {
        let info = sys::fstat(file.as_raw_fd())?;
        if info.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err(sys::invalid("the program isn't a regular file"));
        }
        let path = sys::fd_path(file.as_raw_fd())?;
        let readable = sys::openat(
            libc::AT_FDCWD,
            Path::new(&format!("/proc/self/fd/{}", file.as_raw_fd())),
            libc::O_RDONLY,
            0,
        )?;
        if sys::identity(readable.as_raw_fd())? != sys::identity(file.as_raw_fd())? {
            return Err(sys::invalid(
                "the program changed while it was being opened",
            ));
        }
        let mut head = [0u8; 4];
        let count = unsafe { libc::pread(readable.as_raw_fd(), head.as_mut_ptr().cast(), 4, 0) };
        let script = count >= 2 && &head[..2] == b"#!";
        if !script && (count < 4 || &head != b"\x7fELF") {
            return Err(sys::invalid(
                "the program is neither an ELF executable nor a #! script",
            ));
        }
        let folder = Self::install_folder(&readable, &path, forbidden)?;
        Ok(Program {
            file: readable,
            folder,
            path,
            script,
        })
    }

    pub fn is_script(&self) -> bool {
        self.script
    }

    fn install_folder(
        file: &OwnedFd,
        path: &Path,
        forbidden: &[OwnedFd],
    ) -> io::Result<Option<OwnedFd>> {
        let Some(bin) = path.parent() else {
            return Ok(None);
        };
        if bin.file_name().map(|name| name != "bin").unwrap_or(true) {
            return Ok(None);
        }
        let Some(candidate) = bin.parent() else {
            return Ok(None);
        };
        if candidate == Path::new("/") || candidate == Path::new("/usr") {
            return Ok(None);
        }
        let folder = sys::open_dir(candidate)?;
        let above = sys::open_dir(candidate.parent().unwrap_or(Path::new("/")))?;
        if sys::fstat(folder.as_raw_fd())?.st_dev != sys::fstat(above.as_raw_fd())?.st_dev {
            return Ok(None);
        }
        for place in forbidden {
            if roots::contains(folder.as_raw_fd(), place.as_raw_fd())? {
                return Ok(None);
            }
        }
        let relative = Path::new("bin").join(path.file_name().unwrap_or_default());
        let again = sys::openat(
            folder.as_raw_fd(),
            &relative,
            libc::O_PATH | libc::O_NOFOLLOW,
            0,
        )?;
        if sys::identity(again.as_raw_fd())? != sys::identity(file.as_raw_fd())? {
            return Err(sys::invalid("the program moved while it was being checked"));
        }
        Ok(Some(folder))
    }

    fn jail_path(&self, placement: ProgramPlacement, plugin: &Path) -> io::Result<PathBuf> {
        let inside = |root: &Path, jail_root: &str| -> io::Result<PathBuf> {
            let relative = self
                .path
                .strip_prefix(root)
                .map_err(|_| sys::invalid("the program isn't where its folder says"))?;
            Ok(Path::new(jail_root).join(relative))
        };
        match (placement, &self.folder) {
            (ProgramPlacement::Separate, Some(folder)) => {
                inside(&sys::fd_path(folder.as_raw_fd())?, PROGRAM_IN_JAIL)
            }
            (ProgramPlacement::Separate, None) => {
                Ok(Path::new(PROGRAM_IN_JAIL).join(self.path.file_name().unwrap_or_default()))
            }
            (ProgramPlacement::InsidePluginFolder, _) => inside(plugin, PLUGIN_IN_JAIL),
            (ProgramPlacement::InsideUsr, _) => Ok(self.path.clone()),
            (ProgramPlacement::None, _) => Err(sys::invalid("a sidecar needs a program")),
        }
    }

    fn verify_at(&self, dir: RawFd, relative: &Path, resolve: u64) -> Result<(), String> {
        let found = sys::openat2(dir, relative, libc::O_PATH | libc::O_NOFOLLOW, resolve);
        let found = match found {
            Ok(fd) => fd,
            Err(error) => {
                return Err(match error.raw_os_error() {
                    Some(libc::ELOOP) => "the program's path now ends in a link".into(),
                    Some(libc::ENOENT) => "the program is no longer at its path".into(),
                    Some(libc::EXDEV) => {
                        "the program's path crosses into another filesystem".into()
                    }
                    _ => format!("the program's path can't be checked: {error}"),
                })
            }
        };
        let kind = sys::fstat(found.as_raw_fd()).map(|info| info.st_mode & libc::S_IFMT);
        if kind.ok() == Some(libc::S_IFLNK) {
            return Err("the program's path now ends in a link".into());
        }
        let same =
            sys::identity(found.as_raw_fd()).ok() == sys::identity(self.file.as_raw_fd()).ok();
        if !same {
            return Err("the program changed after it was checked".into());
        }
        Ok(())
    }

    fn verify_destination(&self, placement: ProgramPlacement, plugin: RawFd) -> Result<(), String> {
        let beneath = sys::RESOLVE_BENEATH
            | sys::RESOLVE_NO_XDEV
            | sys::RESOLVE_NO_SYMLINKS
            | sys::RESOLVE_NO_MAGICLINKS;
        let relative_to = |root: RawFd| -> Result<(), String> {
            let root_path = sys::fd_path(root).map_err(|e| e.to_string())?;
            let relative = self
                .path
                .strip_prefix(&root_path)
                .map_err(|_| "the program isn't inside the folder it was checked in".to_string())?;
            self.verify_at(root, relative, beneath)
        };
        match (placement, &self.folder) {
            (ProgramPlacement::Separate, Some(folder)) => relative_to(folder.as_raw_fd())?,
            (ProgramPlacement::InsidePluginFolder, _) => relative_to(plugin)?,
            _ => {}
        }
        let parent = sys::open_dir(self.path.parent().unwrap_or(Path::new("/")))
            .map_err(|e| e.to_string())?;
        let name = Path::new(self.path.file_name().unwrap_or_default());
        self.verify_at(
            parent.as_raw_fd(),
            name,
            sys::RESOLVE_NO_SYMLINKS | sys::RESOLVE_NO_MAGICLINKS,
        )
    }

    fn needs_overlay(&self, placement: ProgramPlacement) -> bool {
        let inside_a_folder = matches!(placement, ProgramPlacement::InsidePluginFolder)
            || (matches!(placement, ProgramPlacement::Separate) && self.folder.is_some());
        self.script && inside_a_folder
    }

    fn granted_mount_flags(&self, folder: Option<RawFd>) -> Result<u64, String> {
        let mut places = vec![self.file.as_raw_fd()];
        places.extend(self.folder.as_ref().map(|folder| folder.as_raw_fd()));
        places.extend(folder);
        places.into_iter().try_fold(0, |flags, fd| {
            sys::mount_flags_of(fd)
                .map(|found| flags | found)
                .map_err(|error| format!("the program's filesystem can't be checked: {error}"))
        })
    }

    fn refuse_noexec(&self) -> Result<(), String> {
        if self.granted_mount_flags(None)? & libc::MS_NOEXEC != 0 {
            return Err("the program sits on a filesystem mounted noexec, so it can't run".into());
        }
        Ok(())
    }

    fn refuse_unrunnable(&self) -> Result<(), String> {
        let path = sys::cstring(Path::new(&format!(
            "/proc/self/fd/{}",
            self.file.as_raw_fd()
        )))
        .map_err(|error| error.to_string())?;
        if unsafe { libc::access(path.as_ptr(), libc::X_OK) } != 0 {
            return Err(format!(
                "you can't run this program yourself ({}), so the sandbox won't run it either",
                sys::last_error()
            ));
        }
        Ok(())
    }

    fn check_dir(&self) -> io::Result<OwnedFd> {
        if let Some(folder) = &self.folder {
            return folder.try_clone();
        }
        let parent = sys::open_dir(self.path.parent().unwrap_or(Path::new("/")))?;
        let name = self.path.file_name().unwrap_or_default();
        let again = sys::openat(
            parent.as_raw_fd(),
            Path::new(name),
            libc::O_PATH | libc::O_NOFOLLOW,
            0,
        )?;
        if sys::identity(again.as_raw_fd())? != sys::identity(self.file.as_raw_fd())? {
            return Err(sys::invalid("the program moved while it was being checked"));
        }
        Ok(parent)
    }
}

pub enum Work {
    Host { args: Vec<String> },
    Sidecar { program: Program, args: Vec<String> },
}

impl Work {
    fn kind(&self) -> RunKind {
        match self {
            Work::Host { .. } => RunKind::Host,
            Work::Sidecar { .. } => RunKind::Sidecar,
        }
    }
}

pub struct SpawnRequest {
    pub work: Work,
    pub plugin_name: String,
    pub plugin_dir: OwnedFd,
    pub data_dir: OwnedFd,
    pub channel: OwnedFd,
    pub env: Vec<(String, String)>,
    pub memory_mb: u64,
}

pub enum PolicyDelivery {
    Send,
    Withhold,
}

pub trait LaunchObserver {
    fn recorded(&mut self, _outer: i32, _init: i32) {}
    fn policy(&mut self, _frame: &mut Vec<u8>) -> PolicyDelivery {
        PolicyDelivery::Send
    }
}

pub struct Quiet;

impl LaunchObserver for Quiet {}

#[derive(Debug)]
pub enum SpawnError {
    LandlockUnavailable(String),
    SidecarNeedsNamespaces(String),
    SidecarNeedsNewerLandlock(u32),
    Refused(String),
    Busy(&'static str),
    SetupFailed(String),
    Io(io::Error),
}

impl fmt::Display for SpawnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpawnError::LandlockUnavailable(why) => write!(f, "{LANDLOCK_MISSING} ({why})"),
            SpawnError::SidecarNeedsNamespaces(why) => write!(
                f,
                "Sidecars need user namespaces, which this system doesn't allow ({why})"
            ),
            SpawnError::SidecarNeedsNewerLandlock(abi) => write!(
                f,
                "Sidecars need Landlock ABI 2 (Linux 5.19 or later); this kernel has ABI {abi}"
            ),
            SpawnError::Refused(why) => write!(f, "The plugin can't start: {why}"),
            SpawnError::Busy(why) => write!(f, "The plugin can't start yet: {why}"),
            SpawnError::SetupFailed(why) => write!(f, "sandbox setup failed: {why}"),
            SpawnError::Io(error) => write!(f, "sandbox setup failed: {error}"),
        }
    }
}

impl From<io::Error> for SpawnError {
    fn from(error: io::Error) -> Self {
        SpawnError::Io(error)
    }
}

#[derive(Debug)]
pub struct Launched {
    pub id: RunId,
    pub level: Level,
    pub landlock_abi: u32,
    pub log: OwnedFd,
    pub outer_pid: i32,
    pub init_pid: Option<i32>,
    pub main_pid: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitReport {
    pub level: Level,
    pub status: Option<i32>,
    pub signal: Option<i32>,
    pub tree_gone: bool,
}

struct Run {
    level: Level,
    outer: i32,
    outer_pidfd: OwnedFd,
    init_pidfd: Option<OwnedFd>,
    main_pidfd: Option<OwnedFd>,
    main: Option<i32>,
    namespace: Option<u64>,
    cgroup: Option<RunCgroup>,
}

struct Straggler {
    pid: Option<i32>,
    _pidfd: Option<OwnedFd>,
    cgroup: Option<RunCgroup>,
}

pub struct Supervisor {
    config: SupervisorConfig,
    broker_exe: OwnedFd,
    bwrap: Option<OwnedFd>,
    capabilities: Capabilities,
    runs: HashMap<RunId, Run>,
    stragglers: Vec<Straggler>,
    next_id: RunId,
    limiter: SpawnLimiter,
    spawner: Spawner,
    devnull: OwnedFd,
}

fn cstrings<T: AsRef<OsStr>>(items: &[T]) -> io::Result<Vec<CString>> {
    items
        .iter()
        .map(|item| {
            CString::new(item.as_ref().as_bytes())
                .map_err(|_| sys::invalid("an argument holds a NUL byte"))
        })
        .collect()
}

fn strings(items: &[&str]) -> Vec<OsString> {
    items.iter().map(OsString::from).collect()
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && !name.as_bytes()[0].is_ascii_digit()
        && name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

fn host_entry(args: &[String]) -> Result<String, SpawnError> {
    let mut entries = Vec::new();
    let mut at = 0;
    while at < args.len() {
        let value = args.get(at + 1).ok_or_else(|| {
            SpawnError::Refused(format!("the host option {} has no value", args[at]))
        })?;
        if args[at] == "--entry" {
            entries.push(value.clone());
        }
        at += 2;
    }
    match entries.as_slice() {
        [entry] => Ok(entry.clone()),
        [] => Err(SpawnError::Refused(
            "the extension host needs an --entry".into(),
        )),
        _ => Err(SpawnError::Refused(
            "--entry is given more than once".into(),
        )),
    }
}

pub fn valid_plugin_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

enum Readiness {
    Line(String),
    Closed,
    TimedOut,
    Failed(String),
}

struct ReadyLines {
    fd: RawFd,
    pending: Vec<u8>,
}

impl ReadyLines {
    fn next(&mut self, deadline: Instant) -> Readiness {
        loop {
            if let Some(at) = self.pending.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=at).collect();
                return match String::from_utf8(line[..at].to_vec()) {
                    Ok(text) => Readiness::Line(text),
                    Err(_) => Readiness::Failed("the readiness record isn't text".into()),
                };
            }
            if self.pending.len() > 512 {
                return Readiness::Failed("the readiness record is too long".into());
            }
            match sys::wait_readable(self.fd, deadline) {
                Ok(true) => {}
                Ok(false) => return Readiness::TimedOut,
                Err(error) => {
                    return Readiness::Failed(format!("the readiness pipe failed: {error}"))
                }
            }
            let mut chunk = [0u8; 256];
            match sys::read_some(self.fd, &mut chunk) {
                Ok(0) if self.pending.is_empty() => return Readiness::Closed,
                Ok(0) => return Readiness::Failed("the readiness record was cut short".into()),
                Ok(count) => self.pending.extend_from_slice(&chunk[..count]),
                Err(error) => {
                    return Readiness::Failed(format!("the readiness pipe failed: {error}"))
                }
            }
        }
    }
}

fn read_child_pid(fd: RawFd, deadline: Instant) -> io::Result<Option<i32>> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        let text = String::from_utf8_lossy(&data);
        if let Some(at) = text.find("\"child-pid\"") {
            let rest = &text[at + 11..];
            let digits: String = rest
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            let complete = rest
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .find(|c| !c.is_ascii_digit())
                .is_some();
            if !digits.is_empty() && complete {
                return Ok(digits.parse().ok());
            }
        }
        if data.len() > 8192 || !sys::wait_readable(fd, deadline)? {
            return Ok(None);
        }
        let count = sys::read_some(fd, &mut chunk)?;
        if count == 0 {
            return Ok(None);
        }
        data.extend_from_slice(&chunk[..count]);
    }
}

fn find_second_pid(init: i32, deadline: Instant) -> Option<(i32, OwnedFd)> {
    loop {
        for child in procscan::direct_children(init) {
            if procscan::innermost_pid(child) != Some(2) {
                continue;
            }
            let Ok(pidfd) = sys::pidfd_open(child) else {
                continue;
            };
            if procscan::parent_of(child) == Some(init) && procscan::innermost_pid(child) == Some(2)
            {
                return Some((child, pidfd));
            }
        }
        if Instant::now() >= deadline || !procscan::is_running(init) {
            return None;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn drain_text(fd: RawFd) -> String {
    let _ = sys::set_nonblocking(fd);
    let mut buffer = vec![0u8; 4096];
    let count = sys::read_some(fd, &mut buffer).unwrap_or(0);
    String::from_utf8_lossy(&buffer[..count]).trim().to_string()
}

fn decode_status(level: Level, status: libc::c_int) -> (Option<i32>, Option<i32>) {
    if libc::WIFSIGNALED(status) {
        return (None, Some(libc::WTERMSIG(status)));
    }
    let code = libc::WEXITSTATUS(status);
    if level == Level::Full && code > 128 {
        return (None, Some(code - 128));
    }
    (Some(code), None)
}

struct Prepared {
    exe: RawFd,
    argv: Vec<OsString>,
    envp: Vec<String>,
    frame: Frame,
    fds: Vec<(RawFd, RawFd)>,
    held: Vec<OwnedFd>,
    info_r: Option<OwnedFd>,
    block_w: Option<OwnedFd>,
}

impl Supervisor {
    pub fn new(config: SupervisorConfig) -> io::Result<Supervisor> {
        let launcher = elf::linkage(config.broker_exe.as_raw_fd())?;
        if config.require_static_launcher && launcher == Linkage::Dynamic {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the plugin launcher is dynamically linked; release builds must ship it static so no loader variable runs before the sandbox",
            ));
        }
        let broker_exe = spawn::lift(config.broker_exe.as_raw_fd())?;
        let bwrap = match &config.bwrap {
            Some(fd) => Some(spawn::lift(fd.as_raw_fd())?),
            None => None,
        };
        let devnull = sys::openat(libc::AT_FDCWD, Path::new("/dev/null"), libc::O_RDWR, 0)?;
        let devnull = spawn::lift(devnull.as_raw_fd())?;
        let cgroup = config
            .cgroup
            .as_ref()
            .map(|delegate| delegate.path().to_path_buf());
        let mut supervisor = Supervisor {
            config,
            broker_exe,
            bwrap,
            capabilities: Capabilities {
                landlock_abi: landlock::kernel_abi(),
                full_isolation: Err("not probed".into()),
                folder_scripts: FolderScripts::Unknown("not probed".into()),
                launcher,
                cgroup,
            },
            runs: HashMap::new(),
            stragglers: Vec::new(),
            next_id: 1,
            limiter: SpawnLimiter::default(),
            spawner: Spawner::start()?,
            devnull,
        };
        match supervisor.probe_full_isolation() {
            Ok(folder_scripts) => {
                supervisor.capabilities.full_isolation = Ok(());
                supervisor.capabilities.folder_scripts = folder_scripts;
            }
            Err(why) => {
                supervisor.capabilities.folder_scripts = FolderScripts::Unknown(why.clone());
                supervisor.capabilities.full_isolation = Err(why);
            }
        }
        Ok(supervisor)
    }

    pub fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }

    fn run_once(
        &mut self,
        exe: RawFd,
        argv: Vec<OsString>,
        extra: Vec<(RawFd, RawFd)>,
    ) -> Result<(i32, String), String> {
        let (out_r, pipe_w) = sys::pipe().map_err(|e| e.to_string())?;
        let out_w = spawn::lift(pipe_w.as_raw_fd()).map_err(|e| e.to_string())?;
        drop(pipe_w);
        let mut fds = vec![
            (self.devnull.as_raw_fd(), 0),
            (out_w.as_raw_fd(), 1),
            (out_w.as_raw_fd(), 2),
        ];
        fds.extend(extra);
        let spec = ForkSpec {
            exe,
            argv: cstrings(&argv).map_err(|e| e.to_string())?,
            envp: Vec::new(),
            fds,
            cgroup_procs: None,
            new_session: true,
        };
        let (pid, pidfd) = self.spawner.spawn(spec).map_err(|e| e.to_string())?;
        drop(out_w);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        let mut chunk = [0u8; 4096];
        while sys::wait_readable(out_r.as_raw_fd(), deadline).unwrap_or(false) {
            match sys::read_some(out_r.as_raw_fd(), &mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(count) if output.len() < 65536 => output.extend_from_slice(&chunk[..count]),
                Ok(_) => {}
            }
        }
        if !sys::wait_readable(pidfd.as_raw_fd(), deadline).unwrap_or(false) {
            let _ = sys::pidfd_signal(pidfd.as_raw_fd(), libc::SIGKILL);
            let _ = sys::wait_readable(pidfd.as_raw_fd(), Instant::now() + Duration::from_secs(1));
        }
        let Some(status) = sys::try_wait_child(pid).ok().flatten() else {
            self.stragglers.push(Straggler {
                pid: Some(pid),
                _pidfd: Some(pidfd),
                cgroup: None,
            });
            return Err("a probe process didn't end".into());
        };
        let code = if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            128 + libc::WTERMSIG(status)
        };
        Ok((code, String::from_utf8_lossy(&output).into_owned()))
    }

    fn namespace_flags() -> Vec<OsString> {
        strings(&[
            "--unshare-user",
            "--unshare-ipc",
            "--unshare-pid",
            "--unshare-uts",
            "--unshare-cgroup",
            "--unshare-net",
            "--disable-userns",
            "--die-with-parent",
            "--new-session",
            "--cap-drop",
            "ALL",
            "--cap-add",
            "CAP_SYS_ADMIN",
            "--cap-add",
            "CAP_SETPCAP",
            "--clearenv",
        ])
    }

    fn probe_full_isolation(&mut self) -> Result<FolderScripts, String> {
        let bwrap = self.bwrap.as_ref().ok_or("no bundled bwrap")?.as_raw_fd();
        let (code, help) = self.run_once(bwrap, strings(&["ardia-bwrap", "--help"]), Vec::new())?;
        for flag in [
            "--ro-bind-fd",
            "--bind-fd",
            "--add-seccomp-fd",
            "--block-fd",
            "--info-fd",
            "--disable-userns",
            "--size",
        ] {
            if !help.contains(flag) {
                return Err(format!(
                    "the bundled bwrap lacks {flag} (exit {code}), so plugins can't be mounted by fd"
                ));
            }
        }
        let mut argv = vec![OsString::from("ardia-bwrap")];
        argv.extend(Self::namespace_flags());
        let mut entries = plan::system_entries(RunKind::Host);
        entries.push(plan::Entry {
            dest: "/proc".into(),
            source: plan::Source::Proc,
            rights: 0,
        });
        entries.push(plan::Entry {
            dest: "/dev".into(),
            source: plan::Source::Dev,
            rights: 0,
        });
        entries.push(plan::Entry {
            dest: BROKER_PATH_IN_JAIL.into(),
            source: plan::Source::Fd {
                fd: 3,
                writable: false,
            },
            rights: 0,
        });
        entries.push(plan::Entry {
            dest: crate::EXEC_STAGE_IN_JAIL.into(),
            source: plan::Source::Dir,
            rights: 0,
        });
        argv.extend(plan::Plan { entries }.bwrap_mounts());
        argv.extend(strings(&["--", BROKER_PATH_IN_JAIL, "exec", "--probe"]));
        let (code, output) = self.run_once(bwrap, argv, vec![(self.broker_exe.as_raw_fd(), 3)])?;
        match code {
            0 => Ok(FolderScripts::Available),
            crate::exec::EXIT_PROBE_WITHOUT_OVERLAY => Ok(FolderScripts::Unsupported(format!(
                "scripts inside a folder need overlayfs to keep their path, and {}",
                output.trim()
            ))),
            crate::exec::EXIT_PROBE_OVERLAY_UNSURE => Ok(FolderScripts::Unknown(format!(
                "scripts inside a folder need overlayfs, and {}",
                output.trim()
            ))),
            _ => Err(format!(
                "bwrap couldn't make namespaces (exit {code}): {}",
                output.trim()
            )),
        }
    }

    fn ensure_folder_scripts(&mut self) -> Result<(), SpawnError> {
        if matches!(self.capabilities.folder_scripts, FolderScripts::Unknown(_)) {
            self.capabilities.folder_scripts = match self.probe_full_isolation() {
                Ok(state) => state,
                Err(why) => FolderScripts::Unknown(why),
            };
        }
        match &self.capabilities.folder_scripts {
            FolderScripts::Available => Ok(()),
            FolderScripts::Unsupported(why) | FolderScripts::Unknown(why) => Err(
                SpawnError::Refused(format!("this script can't run here: {why}")),
            ),
        }
    }

    pub fn placement(&self, kind: RunKind) -> Result<(Level, u32), SpawnError> {
        let kernel = self
            .capabilities
            .landlock_abi
            .map_err(|why| SpawnError::LandlockUnavailable(why.to_string()))?;
        let abi = landlock::effective_abi(kernel, self.config.landlock_abi_cap);
        let full = self.config.allow_full && self.capabilities.full_isolation.is_ok();
        match kind {
            RunKind::Host if full => Ok((Level::Full, abi)),
            RunKind::Host => Ok((Level::HostReduced, abi)),
            RunKind::Sidecar if !full => {
                let why = match &self.capabilities.full_isolation {
                    Err(why) => why.clone(),
                    Ok(()) => "namespaces are turned off for plugins".into(),
                };
                Err(SpawnError::SidecarNeedsNamespaces(why))
            }
            RunKind::Sidecar if abi < landlock::SIDECAR_MIN_ABI => {
                Err(SpawnError::SidecarNeedsNewerLandlock(abi))
            }
            RunKind::Sidecar => Ok((Level::Full, abi)),
        }
    }

    fn launcher_environment(name: &str) -> Vec<(String, String)> {
        vec![
            ("ARDIA_PLUGIN_FD".into(), "3".into()),
            ("ARDIA_PLUGIN_NAME".into(), name.into()),
            ("LANG".into(), "C.UTF-8".into()),
        ]
    }

    fn sidecar_environment(request: &SpawnRequest) -> Result<Vec<String>, SpawnError> {
        let mut env: Vec<(String, String)> = vec![
            ("PATH".into(), PLUGIN_PATH.into()),
            ("HOME".into(), format!("{DATA_IN_JAIL}/home")),
            ("TMPDIR".into(), format!("{DATA_IN_JAIL}/tmp")),
            ("LANG".into(), "C.UTF-8".into()),
            ("ARDIA_PLUGIN_NAME".into(), request.plugin_name.clone()),
            ("ARDIA_PLUGIN_FD".into(), "3".into()),
        ];
        for (name, value) in &request.env {
            if !valid_env_name(name) || value.contains('\0') {
                return Err(SpawnError::Refused(format!(
                    "{name} isn't a usable environment variable"
                )));
            }
            if SANDBOX_OWNED_VARIABLES.contains(&name.as_str()) {
                return Err(SpawnError::Refused(format!("{name} is set by the sandbox")));
            }
            env.retain(|(existing, _)| existing != name);
            env.push((name.clone(), value.clone()));
        }
        Ok(env.into_iter().map(|(n, v)| format!("{n}={v}")).collect())
    }

    fn check_request(&self, request: &SpawnRequest) -> Result<ProgramPlacement, SpawnError> {
        if !valid_plugin_name(&request.plugin_name) {
            return Err(SpawnError::Refused(
                "the plugin's name isn't a folder name".into(),
            ));
        }
        if matches!(request.work, Work::Host { .. }) && !request.env.is_empty() {
            return Err(SpawnError::Refused(
                "the extension host takes no environment from the request".into(),
            ));
        }
        if let Work::Host { args } = &request.work {
            host_entry(args)?;
        }
        let program_dir = match &request.work {
            Work::Sidecar { program, .. } => Some(program.check_dir()?),
            Work::Host { .. } => None,
        };
        let placement = roots::check(&Granted {
            plugin: request.plugin_dir.as_raw_fd(),
            data: Some(request.data_dir.as_raw_fd()),
            program: program_dir.as_ref().map(|fd| fd.as_raw_fd()),
            plugin_parents: &self.config.plugin_parents,
            forbidden: &self.config.forbidden,
        })
        .map_err(|refusal| SpawnError::Refused(refusal.0))?;
        let refuse = |refusal: roots::Refusal| SpawnError::Refused(refusal.0);
        roots::refuse_nested_mounts("the plugin folder", request.plugin_dir.as_raw_fd())
            .map_err(refuse)?;
        if let Work::Sidecar { program, .. } = &request.work {
            program
                .verify_destination(placement, request.plugin_dir.as_raw_fd())
                .map_err(SpawnError::Refused)?;
            program.refuse_noexec().map_err(SpawnError::Refused)?;
            program.refuse_unrunnable().map_err(SpawnError::Refused)?;
        }
        if let Work::Sidecar { program, .. } = &request.work {
            roots::refuse_nested_mounts("the plugin's data", request.data_dir.as_raw_fd())
                .map_err(refuse)?;
            if let (ProgramPlacement::Separate, Some(folder)) = (placement, &program.folder) {
                roots::refuse_nested_mounts("the program's folder", folder.as_raw_fd())
                    .map_err(refuse)?;
            }
        }
        Ok(placement)
    }

    fn prepare(
        &self,
        request: &SpawnRequest,
        level: Level,
        abi: u32,
        placement: ProgramPlacement,
        child_ends: [RawFd; 3],
    ) -> Result<Prepared, SpawnError> {
        let kind = request.work.kind();
        let [log_w, policy_r, ready_w] = child_ends;
        let mut held: Vec<OwnedFd> = Vec::new();
        let lift = |fd: RawFd, held: &mut Vec<OwnedFd>| -> io::Result<RawFd> {
            let lifted = spawn::lift(fd)?;
            let raw = lifted.as_raw_fd();
            held.push(lifted);
            Ok(raw)
        };
        let mut fds = vec![
            (self.devnull.as_raw_fd(), 0),
            (lift(log_w, &mut held)?, 1),
            (lift(log_w, &mut held)?, 2),
            (lift(request.channel.as_raw_fd(), &mut held)?, 3),
            (lift(policy_r, &mut held)?, 4),
            (lift(ready_w, &mut held)?, spawn::SPAWN_ERROR_FD),
        ];
        let launcher_env = Self::launcher_environment(&request.plugin_name);
        let mut frame = Frame {
            level,
            kind,
            landlock_abi: abi,
            expected_parent: 0,
            baseline: Vec::new(),
            final_filter: Vec::new(),
            rules: Vec::new(),
            cwd: Target::Path(PLUGIN_IN_JAIL.into()),
            program: None,
            argv: Vec::new(),
            env: Vec::new(),
            host_args: Vec::new(),
            entry: None,
            mount_checks: Vec::new(),
            expected_mounts: Vec::new(),
            private_mounts: false,
        };
        let plugin_path = sys::fd_path(request.plugin_dir.as_raw_fd())?;
        let mut program_file = None;
        match &request.work {
            Work::Host { args } => {
                frame.host_args = args.clone();
                frame.entry = Some(host_entry(args)?);
            }
            Work::Sidecar { program, args } => {
                let name = program
                    .path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                frame.argv.push(name);
                frame.argv.extend(args.iter().cloned());
                frame.env = Self::sidecar_environment(request)?;
                let jail_path = program.jail_path(placement, &plugin_path)?;
                let (device, inode) = sys::identity(program.file.as_raw_fd())?;
                let pin_with_overlay = program.needs_overlay(placement);
                frame.program = Some(PinnedProgram {
                    path: jail_path.clone(),
                    device,
                    inode,
                    script: program.script,
                    pin_with_overlay,
                    folder_flags: if pin_with_overlay {
                        let plugin = matches!(placement, ProgramPlacement::InsidePluginFolder)
                            .then(|| request.plugin_dir.as_raw_fd());
                        program
                            .granted_mount_flags(plugin)
                            .map_err(SpawnError::Refused)?
                    } else {
                        0
                    },
                });
                frame.final_filter =
                    seccomp::to_bytes(&seccomp::compile(&seccomp::sidecar_offline(abi))?);
                if !pin_with_overlay {
                    frame.expected_mounts.push(jail_path.clone());
                    fds.push((
                        lift(program.file.as_raw_fd(), &mut held)?,
                        PROGRAM_FD_IN_JAIL,
                    ));
                    program_file = Some((PROGRAM_FD_IN_JAIL, jail_path));
                }
            }
        }
        if level == Level::HostReduced {
            fds.push((lift(request.plugin_dir.as_raw_fd(), &mut held)?, 6));
            frame.expected_parent = std::process::id() as i32;
            frame.baseline = seccomp::to_bytes(&seccomp::compile(&seccomp::baseline())?);
            frame.rules = vec![Rule {
                target: Target::Fd(6),
                rights: landlock::READ,
            }];
            frame.cwd = Target::Fd(6);
            frame.mount_checks = vec![MountCheck {
                path: plugin_path,
                writable: false,
            }];
            return Ok(Prepared {
                exe: self.broker_exe.as_raw_fd(),
                argv: strings(&[
                    "ardia-plugins",
                    "exec",
                    "--policy-fd",
                    "4",
                    "--ready-fd",
                    "5",
                ]),
                envp: launcher_env
                    .iter()
                    .map(|(n, v)| format!("{n}={v}"))
                    .collect(),
                frame,
                fds,
                held,
                info_r: None,
                block_w: None,
            });
        }
        let (info_r, info_w) = sys::pipe()?;
        let (block_r, block_w) = sys::pipe()?;
        let (seccomp_r, seccomp_w) = sys::pipe()?;
        let baseline = seccomp::to_bytes(&seccomp::compile(&seccomp::launcher_baseline())?);
        if baseline.len() >= 65536 {
            return Err(SpawnError::SetupFailed(
                "the baseline filter doesn't fit a pipe".into(),
            ));
        }
        sys::write_all(seccomp_w.as_raw_fd(), &baseline)?;
        drop(seccomp_w);
        fds.push((lift(info_w.as_raw_fd(), &mut held)?, 6));
        fds.push((lift(block_r.as_raw_fd(), &mut held)?, 7));
        fds.push((lift(seccomp_r.as_raw_fd(), &mut held)?, 8));
        fds.push((lift(request.plugin_dir.as_raw_fd(), &mut held)?, 9));
        let mut data = None;
        let mut program_folder = None;
        if let Work::Sidecar { program, .. } = &request.work {
            fds.push((lift(request.data_dir.as_raw_fd(), &mut held)?, 10));
            data = Some(10);
            if let (ProgramPlacement::Separate, Some(folder)) = (placement, &program.folder) {
                fds.push((lift(folder.as_raw_fd(), &mut held)?, 11));
                program_folder = Some(11);
            }
        }
        fds.push((self.broker_exe.as_raw_fd(), 12));
        let plan = plan::build(&plan::Input {
            kind,
            plugin: 9,
            data,
            program_folder,
            program_file,
            broker: 12,
        });
        frame.rules.extend(plan.landlock_rules());
        frame.mount_checks = plan.mount_checks();
        frame.private_mounts = true;
        let mut argv = vec![OsString::from("ardia-bwrap")];
        argv.extend(Self::namespace_flags());
        for (name, value) in &launcher_env {
            argv.extend([
                OsString::from("--setenv"),
                OsString::from(name),
                OsString::from(value),
            ]);
        }
        argv.extend(strings(&[
            "--info-fd",
            "6",
            "--block-fd",
            "7",
            "--add-seccomp-fd",
            "8",
        ]));
        argv.extend(plan.bwrap_mounts());
        argv.extend(strings(&[
            "--",
            BROKER_PATH_IN_JAIL,
            "exec",
            "--policy-fd",
            "4",
            "--ready-fd",
            "5",
        ]));
        held.push(info_w);
        held.push(block_r);
        held.push(seccomp_r);
        let exe = self
            .bwrap
            .as_ref()
            .ok_or_else(|| SpawnError::SetupFailed("full isolation needs bwrap".into()))?
            .as_raw_fd();
        Ok(Prepared {
            exe,
            argv,
            envp: Vec::new(),
            frame,
            fds,
            held,
            info_r: Some(info_r),
            block_w: Some(block_w),
        })
    }

    pub fn spawn(
        &mut self,
        request: SpawnRequest,
        observer: &mut dyn LaunchObserver,
    ) -> Result<Launched, SpawnError> {
        self.reap_stragglers();
        let kind = request.work.kind();
        let (level, abi) = self.placement(kind)?;
        self.limiter
            .admit(self.runs.len(), Instant::now())
            .map_err(SpawnError::Busy)?;
        let placement = self.check_request(&request)?;
        if let Work::Sidecar { program, .. } = &request.work {
            if program.needs_overlay(placement) {
                self.ensure_folder_scripts()?;
            }
        }
        sys::mkdir_at(request.data_dir.as_raw_fd(), "home", 0o700)?;
        sys::mkdir_at(request.data_dir.as_raw_fd(), "tmp", 0o700)?;

        let (policy_r, policy_w) = sys::pipe()?;
        let (ready_r, ready_w) = sys::pipe()?;
        let (log_r, log_w) = sys::pipe()?;
        let prepared = self.prepare(
            &request,
            level,
            abi,
            placement,
            [log_w.as_raw_fd(), policy_r.as_raw_fd(), ready_w.as_raw_fd()],
        )?;
        let Prepared {
            exe,
            argv,
            envp,
            frame,
            fds,
            held,
            info_r,
            block_w,
        } = prepared;
        let mut frame = frame.encode();

        let id = self.next_id;
        self.next_id += 1;
        let cgroup = match &self.config.cgroup {
            Some(delegate) => Some(delegate.create_run(request.memory_mb.saturating_mul(2 << 20))?),
            None => None,
        };
        let spec = ForkSpec {
            exe,
            argv: cstrings(&argv)?,
            envp: cstrings(&envp)?,
            fds,
            cgroup_procs: cgroup.as_ref().map(|c| c.procs_fd()),
            new_session: true,
        };
        let spawned = self.spawner.spawn(spec);
        drop(held);
        drop(policy_r);
        drop(ready_w);
        drop(log_w);
        let (outer, outer_pidfd) = match spawned {
            Ok(child) => child,
            Err(error) => {
                if let Some(cgroup) = cgroup {
                    if let Err(cgroup) = cgroup.empty_and_remove(Instant::now() + TEARDOWN_DEADLINE)
                    {
                        self.stragglers.push(Straggler {
                            pid: None,
                            _pidfd: None,
                            cgroup: Some(cgroup),
                        });
                    }
                }
                return Err(SpawnError::Io(error));
            }
        };
        let host_reduced = level == Level::HostReduced;
        let main_pidfd = if host_reduced {
            outer_pidfd.try_clone().ok()
        } else {
            None
        };
        self.runs.insert(
            id,
            Run {
                level,
                outer,
                outer_pidfd,
                init_pidfd: None,
                main: host_reduced.then_some(outer),
                main_pidfd,
                namespace: None,
                cgroup,
            },
        );
        let deadline = Instant::now() + self.config.ready_deadline;

        let mut init_pid = None;
        if let Some(info) = &info_r {
            let found = read_child_pid(info.as_raw_fd(), deadline).ok().flatten();
            let verified = found.and_then(|pid| {
                let pidfd = sys::pidfd_open(pid).ok()?;
                (procscan::parent_of(pid) == Some(outer)).then_some((pid, pidfd))
            });
            let Some((pid, pidfd)) = verified else {
                return Err(self.abort(id, &log_r, "bwrap didn't report its sandbox".into()));
            };
            init_pid = Some(pid);
            let run = self.runs.get_mut(&id).expect("registered after fork");
            run.init_pidfd = Some(pidfd);
            run.namespace = procscan::pid_namespace(pid);
        } else if self
            .runs
            .get(&id)
            .and_then(|run| run.main_pidfd.as_ref())
            .is_none()
        {
            return Err(self.abort(id, &log_r, "the launcher's pidfd couldn't be kept".into()));
        }
        observer.recorded(outer, init_pid.unwrap_or(0));
        if let Some(block) = &block_w {
            if let Err(error) = sys::write_all_by(block.as_raw_fd(), b"1", deadline) {
                return Err(self.abort(
                    id,
                    &log_r,
                    format!("the sandbox couldn't be released: {error}"),
                ));
            }
        }
        drop(block_w);
        if let Some(init) = init_pid {
            let Some((main, pidfd)) = find_second_pid(init, deadline) else {
                return Err(self.abort(
                    id,
                    &log_r,
                    "the sandbox's first process never appeared".into(),
                ));
            };
            let run = self.runs.get_mut(&id).expect("registered after fork");
            run.main = Some(main);
            run.main_pidfd = Some(pidfd);
        }
        let mut withheld = None;
        match observer.policy(&mut frame) {
            PolicyDelivery::Send => {
                if let Err(error) = sys::write_all_by(policy_w.as_raw_fd(), &frame, deadline) {
                    return Err(self.abort(
                        id,
                        &log_r,
                        format!("the policy couldn't be sent: {error}"),
                    ));
                }
                drop(policy_w);
            }
            PolicyDelivery::Withhold => withheld = Some(policy_w),
        }
        let mut ready = ReadyLines {
            fd: ready_r.as_raw_fd(),
            pending: Vec::new(),
        };
        let accepted = format!("accepted {} {}", level.name(), abi);
        let problem = match ready.next(deadline) {
            Readiness::Line(line) if line == accepted => None,
            Readiness::Line(line) => Some(format!("the sandbox answered \"{line}\"")),
            Readiness::Closed => Some("the sandbox closed before accepting its policy".into()),
            Readiness::Failed(why) => Some(why),
            Readiness::TimedOut => Some("the sandbox didn't get ready in time".into()),
        };
        if let Some(problem) = problem {
            return Err(self.abort(id, &log_r, problem));
        }
        drop(withheld);
        let problem = match (kind, ready.next(deadline)) {
            (RunKind::Host, Readiness::Line(line)) if line == "started" => None,
            (RunKind::Sidecar, Readiness::Closed) => None,
            (_, Readiness::Line(line)) => Some(format!("the runtime didn't start: {line}")),
            (RunKind::Host, Readiness::Closed) => {
                Some("the host exited before it confined itself".into())
            }
            (_, Readiness::TimedOut) => Some("the runtime didn't start in time".into()),
            (_, Readiness::Failed(why)) => Some(why),
        };
        if let Some(problem) = problem {
            return Err(self.abort(id, &log_r, problem));
        }
        let main_pid = self.runs.get(&id).and_then(|run| run.main);
        Ok(Launched {
            id,
            level,
            landlock_abi: abi,
            log: log_r,
            outer_pid: outer,
            init_pid,
            main_pid,
        })
    }

    fn abort(&mut self, id: RunId, log: &OwnedFd, why: String) -> SpawnError {
        if let Some(run) = self.runs.remove(&id) {
            self.teardown(run, Duration::ZERO);
        }
        let detail = drain_text(log.as_raw_fd());
        if detail.is_empty() {
            SpawnError::SetupFailed(why)
        } else {
            SpawnError::SetupFailed(format!("{why}: {detail}"))
        }
    }

    pub fn run_ids(&self) -> Vec<RunId> {
        self.runs.keys().copied().collect()
    }

    pub fn straggler_count(&self) -> usize {
        self.stragglers.len()
    }

    pub fn ended_fd(&self, id: RunId) -> Option<RawFd> {
        self.runs.get(&id).map(|run| run.outer_pidfd.as_raw_fd())
    }

    pub fn has_ended(&self, id: RunId) -> bool {
        self.runs
            .get(&id)
            .map(|run| {
                sys::wait_readable(run.outer_pidfd.as_raw_fd(), Instant::now()).unwrap_or(true)
            })
            .unwrap_or(true)
    }

    pub fn memory_bytes(&self, id: RunId) -> Option<u64> {
        let run = self.runs.get(&id)?;
        if let Some(bytes) = run.cgroup.as_ref().and_then(|c| c.memory_current()) {
            return Some(bytes);
        }
        if let Some(namespace) = run.namespace {
            return Some(
                procscan::in_namespace(namespace)
                    .into_iter()
                    .map(procscan::pss_bytes)
                    .sum(),
            );
        }
        run.main.map(procscan::pss_bytes)
    }

    pub fn stop(&mut self, id: RunId, grace: Duration) -> Option<ExitReport> {
        let run = self.runs.remove(&id)?;
        Some(self.teardown(run, grace))
    }

    pub fn finish(&mut self, id: RunId) -> Option<ExitReport> {
        let run = self.runs.remove(&id)?;
        Some(self.teardown(run, Duration::ZERO))
    }

    pub fn shutdown(&mut self, grace: Duration) -> Vec<(RunId, ExitReport)> {
        let runs: Vec<(RunId, Run)> = self.runs.drain().collect();
        for (_, run) in &runs {
            Self::ask_to_stop(run);
        }
        let graceful = Instant::now() + grace;
        let deadline = graceful + TEARDOWN_DEADLINE;
        for (_, run) in &runs {
            if !sys::wait_readable(run.outer_pidfd.as_raw_fd(), graceful).unwrap_or(true) {
                Self::force_kill(run);
            }
        }
        let reports = runs
            .into_iter()
            .map(|(id, run)| (id, self.reap(run, deadline)))
            .collect();
        self.reap_stragglers();
        reports
    }

    pub fn reap_stragglers(&mut self) {
        self.spawner.reap_orphans();
        self.stragglers.retain_mut(|straggler| {
            if let Some(pid) = straggler.pid {
                if !matches!(sys::try_wait_child(pid), Ok(None)) {
                    straggler.pid = None;
                    straggler._pidfd = None;
                }
            }
            settle_cgroup(&mut straggler.cgroup);
            straggler.pid.is_some() || straggler.cgroup.is_some()
        });
    }

    fn ask_to_stop(run: &Run) {
        if let Some(main) = &run.main_pidfd {
            let _ = sys::pidfd_signal(main.as_raw_fd(), libc::SIGTERM);
        }
    }

    fn force_kill(run: &Run) {
        if let Some(cgroup) = &run.cgroup {
            let _ = cgroup.kill();
        }
        if let Some(init) = &run.init_pidfd {
            let _ = sys::pidfd_signal(init.as_raw_fd(), libc::SIGKILL);
        }
        if let Some(main) = &run.main_pidfd {
            let _ = sys::pidfd_signal(main.as_raw_fd(), libc::SIGKILL);
        }
        let _ = sys::pidfd_signal(run.outer_pidfd.as_raw_fd(), libc::SIGKILL);
    }

    fn teardown(&mut self, run: Run, grace: Duration) -> ExitReport {
        let graceful = Instant::now() + grace;
        let deadline = graceful + TEARDOWN_DEADLINE;
        if !grace.is_zero() {
            Self::ask_to_stop(&run);
            if sys::wait_readable(run.outer_pidfd.as_raw_fd(), graceful).unwrap_or(true) {
                return self.reap(run, deadline);
            }
        }
        Self::force_kill(&run);
        self.reap(run, deadline)
    }

    fn reap(&mut self, run: Run, deadline: Instant) -> ExitReport {
        let ended = sys::wait_readable(run.outer_pidfd.as_raw_fd(), deadline).unwrap_or(false);
        Self::force_kill(&run);
        let status = if ended {
            sys::try_wait_child(run.outer).ok().flatten()
        } else {
            None
        };
        let mut tree_gone = status.is_some();
        if let Some(init) = &run.init_pidfd {
            tree_gone &= sys::wait_readable(init.as_raw_fd(), deadline).unwrap_or(false);
        }
        if let Some(namespace) = run.namespace {
            loop {
                let alive: Vec<i32> = procscan::in_namespace(namespace)
                    .into_iter()
                    .filter(|pid| procscan::is_running(*pid))
                    .collect();
                if alive.is_empty() {
                    break;
                }
                if Instant::now() >= deadline {
                    tree_gone = false;
                    break;
                }
                for pid in alive {
                    if let Ok(pidfd) = sys::pidfd_open(pid) {
                        if procscan::pid_namespace(pid) == Some(namespace) {
                            let _ = sys::pidfd_signal(pidfd.as_raw_fd(), libc::SIGKILL);
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let leftover_cgroup = match run.cgroup {
            Some(cgroup) => cgroup.empty_and_remove(deadline).err(),
            None => None,
        };
        tree_gone &= leftover_cgroup.is_none();
        let leftover_pid = status.is_none();
        if leftover_pid || leftover_cgroup.is_some() {
            self.stragglers.push(Straggler {
                pid: leftover_pid.then_some(run.outer),
                _pidfd: leftover_pid.then_some(run.outer_pidfd),
                cgroup: leftover_cgroup,
            });
        }
        let (code, signal) = match status {
            Some(status) => decode_status(run.level, status),
            None => (None, None),
        };
        ExitReport {
            level: run.level,
            status: code,
            signal,
            tree_gone,
        }
    }
}

fn settle_cgroup(cgroup: &mut Option<RunCgroup>) {
    let Some(current) = cgroup.as_ref() else {
        return;
    };
    match current.try_remove() {
        crate::cgroup::Removal::Removed => *cgroup = None,
        crate::cgroup::Removal::Busy => {}
        crate::cgroup::Removal::GaveUp(error) => {
            current.give_up(&error);
            *cgroup = None;
        }
    }
}

fn reap_independently(stragglers: &mut Vec<Straggler>, deadline: Option<Instant>) {
    loop {
        stragglers.retain_mut(|straggler| {
            if let Some(pid) = straggler.pid {
                if !matches!(sys::try_wait_child(pid), Ok(None)) {
                    straggler.pid = None;
                    straggler._pidfd = None;
                }
            }
            settle_cgroup(&mut straggler.cgroup);
            straggler.pid.is_some() || straggler.cgroup.is_some()
        });
        if stragglers.is_empty() || deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return;
        }
        let pause = if deadline.is_some() { 20 } else { 250 };
        std::thread::sleep(Duration::from_millis(pause));
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown(QUIT_GRACE);
        let mut left = std::mem::take(&mut self.stragglers);
        left.extend(
            self.spawner
                .take_orphans()
                .into_iter()
                .map(|pid| Straggler {
                    pid: Some(pid),
                    _pidfd: None,
                    cgroup: None,
                }),
        );
        reap_independently(&mut left, Some(Instant::now() + TEARDOWN_DEADLINE));
        if left.is_empty() {
            return;
        }
        let count = left.len();
        let started = std::thread::Builder::new()
            .name("jail-straggler-reaper".into())
            .spawn(move || reap_independently(&mut left, None));
        if let Err(error) = started {
            let _ = sys::write_all(
                2,
                format!("[ardia] the straggler reaper couldn't start ({error}), so {count} sandbox processes or cgroups stay unreaped\n").as_bytes(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn child(seconds: u32) -> (i32, OwnedFd) {
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            unsafe {
                libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32);
                libc::sleep(seconds);
                libc::_exit(0);
            }
        }
        (pid, sys::pidfd_open(pid).unwrap())
    }

    #[test]
    fn one_stuck_straggler_never_holds_up_the_others() {
        let (slow, slow_fd) = child(3);
        let (quick, quick_fd) = child(0);
        let mut stragglers = vec![
            Straggler {
                pid: Some(slow),
                _pidfd: Some(slow_fd),
                cgroup: None,
            },
            Straggler {
                pid: Some(quick),
                _pidfd: Some(quick_fd),
                cgroup: None,
            },
        ];
        let started = Instant::now();
        reap_independently(
            &mut stragglers,
            Some(Instant::now() + Duration::from_millis(800)),
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            stragglers.len(),
            1,
            "the quick child should be reaped while the slow one lingers"
        );
        assert_eq!(stragglers[0].pid, Some(slow));
        assert!(
            procscan::state_of(quick).is_none(),
            "the quick child is still a zombie"
        );
        unsafe { libc::kill(slow, libc::SIGKILL) };
        reap_independently(
            &mut stragglers,
            Some(Instant::now() + Duration::from_secs(2)),
        );
        assert!(stragglers.is_empty());
    }

    #[test]
    fn plugin_names_are_plain_folder_names() {
        assert!(valid_plugin_name("cli"));
        assert!(valid_plugin_name("my-plugin_2.0"));
        for bad in ["", ".hidden", "a/b", "a b", "a=b", "x\n"] {
            assert!(!valid_plugin_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn sidecar_variables_are_validated_and_the_sandbox_keeps_its_own() {
        assert!(valid_env_name("LD_PRELOAD"));
        assert!(!valid_env_name("1X"));
        assert!(!valid_env_name("lower"));
        assert!(SANDBOX_OWNED_VARIABLES.contains(&"HOME"));
        let launcher = Supervisor::launcher_environment("cli");
        assert!(launcher.iter().all(|(name, _)| !name.starts_with("LD_")));
        assert_eq!(launcher.len(), 3);
    }
}
