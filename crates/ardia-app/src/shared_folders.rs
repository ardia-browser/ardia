use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use ardia_state::actions::Action;
use ardia_state::shared_folders::{
    self as sf, BaseEntry, FolderOp, LocalEntry, RemoteEntry, RemoteLevel,
};
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, BrowserStore, GroupId, ProfileId};
use ardia_ui::host_data::{SharedFolderState, SharedFolderStatus};
use parking_lot::{Condvar, Mutex};
use serde_json::{Map, Value, json};

use crate::coordinator::AppCoordinator;
use crate::file_coordination::Writing;

pub const DOC: &str = "shared-folders.json";
pub const DOC_VERSION: u64 = 1;
const LOCAL_SETTLE: Duration = Duration::from_millis(300);
const REMOTE_SETTLE: Duration = Duration::from_millis(150);
const POLL: Duration = Duration::from_secs(60);
const CONFLICT_RETRY: Duration = Duration::from_secs(3);
const SAVE_WAIT: Duration = Duration::from_secs(5);
const MAX_DEPTH: usize = 8;
const MAX_LINK_BYTES: usize = 64 * 1024;
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_SCAN_BYTES: usize = 32 * 1024 * 1024;
const PLACEHOLDER: &str = ".icloud";
const SYSTEM_FOLDERS: [&str; 20] = [
    "/",
    "/System",
    "/Library",
    "/Applications",
    "/Users",
    "/Volumes",
    "/bin",
    "/sbin",
    "/usr",
    "/etc",
    "/var",
    "/tmp",
    "/dev",
    "/opt",
    "/cores",
    "/private",
    "/private/etc",
    "/private/var",
    "/private/tmp",
    "/Network",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub device: i64,
    pub inode: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub path: String,
    pub identity: Identity,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Folder {
    pub path: String,
    pub base: Vec<BaseEntry>,
    pub added_at: i64,
    pub identity: Option<Identity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderError {
    Refused(String),
    Failed(String),
}

impl FolderError {
    pub fn text(&self) -> String {
        match self {
            FolderError::Refused(t) | FolderError::Failed(t) => t.clone(),
        }
    }
}

fn last_component(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
}

fn errno_text(code: i32) -> String {
    std::io::Error::from_raw_os_error(code)
        .to_string()
        .split(" (os error")
        .next()
        .unwrap_or_default()
        .to_owned()
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn c(text: &str) -> Option<CString> {
    CString::new(text).ok()
}

struct Dir {
    fd: i32,
    path: PathBuf,
}

impl Drop for Dir {
    fn drop(&mut self) {
        unsafe { libc::close(self.fd) };
    }
}

impl Dir {
    fn identity(&self) -> Option<Identity> {
        let mut info: libc::stat = unsafe { std::mem::zeroed() };
        (unsafe { libc::fstat(self.fd, &mut info) } == 0).then_some(Identity {
            device: info.st_dev as i64,
            inode: info.st_ino as i64,
        })
    }

    fn open_child(&self, name: &str) -> Result<Dir, i32> {
        let name_c = c(name).ok_or(libc::EINVAL)?;
        let fd = unsafe {
            libc::openat(
                self.fd,
                name_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            Err(errno())
        } else {
            Ok(Dir {
                fd,
                path: self.path.join(name),
            })
        }
    }

    fn info(&self, name: &str) -> Result<libc::stat, i32> {
        let name_c = c(name).ok_or(libc::EINVAL)?;
        let mut info: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                self.fd,
                name_c.as_ptr(),
                &mut info,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0
        {
            Ok(info)
        } else {
            Err(errno())
        }
    }

    fn kind(&self, name: &str) -> Kind {
        match self.info(name) {
            Ok(info) => match info.st_mode & libc::S_IFMT {
                libc::S_IFREG => Kind::File,
                libc::S_IFDIR => Kind::Directory,
                libc::S_IFLNK => Kind::Symlink,
                _ => Kind::Other,
            },
            Err(code) if code == libc::ENOENT => Kind::Missing,
            Err(_) => Kind::Blocked,
        }
    }

    fn names(&self, budget: Option<&mut Budget>, stop_after: usize) -> Option<Vec<String>> {
        let copy = unsafe { libc::dup(self.fd) };
        if copy < 0 {
            return None;
        }
        let stream = unsafe { libc::fdopendir(copy) };
        if stream.is_null() {
            unsafe { libc::close(copy) };
            return None;
        }
        let mut names = Vec::new();
        let mut budget = budget;
        let result = loop {
            if names.len() >= stop_after {
                break Some(names);
            }
            unsafe { *libc::__error() = 0 };
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break if errno() == 0 { Some(names) } else { None };
            }
            let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }
                .to_string_lossy()
                .into_owned();
            if name == "." || name == ".." {
                continue;
            }
            names.push(name);
            if let Some(b) = budget.as_deref_mut() {
                b.entries += 1;
                if b.exceeded() {
                    break Some(names);
                }
            }
        };
        unsafe { libc::closedir(stream) };
        result
    }

    fn bounded_read(&self, name: &str, limit: usize) -> Option<Vec<u8>> {
        let name_c = c(name)?;
        let fd = unsafe {
            libc::openat(
                self.fd,
                name_c.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return None;
        }
        use std::io::Read;
        use std::os::fd::FromRawFd;
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let meta = file.metadata().ok()?;
        if !meta.is_file() {
            return None;
        }
        let mut data = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut data).ok()?;
        (data.len() <= limit).then_some(data)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Directory,
    Symlink,
    Other,
    Missing,
    Blocked,
}

#[derive(Default)]
struct Budget {
    entries: usize,
    bytes: usize,
}

impl Budget {
    fn exceeded(&self) -> bool {
        self.entries > MAX_ENTRIES || self.bytes > MAX_SCAN_BYTES
    }
}

fn real_path(path: &str) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

fn identity_of(path: &str) -> Option<Identity> {
    let meta = std::fs::metadata(path).ok()?;
    use std::os::unix::fs::MetadataExt;
    meta.is_dir().then(|| Identity {
        device: meta.dev() as i64,
        inode: meta.ino() as i64,
    })
}

fn refused_folder(real: &str) -> bool {
    let parts: Vec<&str> = real.split('/').filter(|p| !p.is_empty()).collect();
    let home = std::env::var("HOME").ok().and_then(|h| real_path(&h));
    SYSTEM_FOLDERS.contains(&real)
        || (parts.len() == 2 && parts[0] == "Users")
        || home.as_deref() == Some(real)
}

pub fn resolve(path: &str) -> Result<Resolved, FolderError> {
    let name = last_component(path);
    let Some(real) = real_path(path) else {
        let code = errno();
        return Err(FolderError::Failed(if code == libc::ENOENT {
            format!("There’s no folder at {path}.")
        } else {
            format!("Can’t open “{name}”: {}", errno_text(code))
        }));
    };
    if refused_folder(&real) {
        return Err(FolderError::Refused(format!(
            "{real} is a system or home folder; pick a folder inside it."
        )));
    }
    let Some(identity) = identity_of(&real) else {
        return Err(FolderError::Failed(format!(
            "“{name}” isn’t a folder Ardia can sync."
        )));
    };
    let Some(real_c) = c(&real) else {
        return Err(FolderError::Failed(format!(
            "“{name}” isn’t a folder Ardia can sync."
        )));
    };
    if unsafe { libc::access(real_c.as_ptr(), libc::R_OK | libc::X_OK) } != 0 {
        return Err(FolderError::Failed(format!(
            "Can’t read “{name}”: {}",
            errno_text(errno())
        )));
    }
    Ok(Resolved {
        path: real,
        identity,
    })
}

pub fn folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c == '/' || c == ':' { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim();
    let visible = cleaned.trim_start_matches('.');
    let mut capped = String::new();
    for ch in visible.chars() {
        if capped.len() + ch.len_utf8() > 200 {
            break;
        }
        capped.push(ch);
    }
    if capped.is_empty() {
        "Shared Folder".to_owned()
    } else {
        capped
    }
}

fn open_dir(path: &str, nofollow: bool) -> Result<Dir, i32> {
    let path_c = c(path).ok_or(libc::EINVAL)?;
    let flags = libc::O_RDONLY
        | libc::O_DIRECTORY
        | libc::O_CLOEXEC
        | if nofollow { libc::O_NOFOLLOW } else { 0 };
    let fd = unsafe { libc::open(path_c.as_ptr(), flags) };
    if fd < 0 {
        Err(errno())
    } else {
        Ok(Dir {
            fd,
            path: PathBuf::from(path),
        })
    }
}

pub fn create(
    parent: &str,
    parent_identity: Option<Identity>,
    name: &str,
) -> Result<Resolved, FolderError> {
    let parent_name = last_component(parent);
    if parent_identity.is_none() {
        std::fs::create_dir_all(parent).map_err(|e| FolderError::Failed(e.to_string()))?;
    }
    let mut dir = open_dir(parent, parent_identity.is_some()).map_err(|code| {
        FolderError::Failed(format!("Can’t open “{parent_name}”: {}", errno_text(code)))
    })?;
    dir.path = PathBuf::from(real_path(parent).unwrap_or_else(|| parent.to_owned()));
    if parent_identity.is_some_and(|expected| dir.identity() != Some(expected)) {
        return Err(FolderError::Failed(format!(
            "“{parent_name}” isn’t the folder that was checked any more; nothing was made."
        )));
    }
    let stem = folder_name(name);
    let mut number = 1;
    loop {
        let candidate = if number == 1 {
            stem.clone()
        } else {
            format!("{stem} {number}")
        };
        let candidate_c = c(&candidate).ok_or_else(|| FolderError::Failed("bad name".into()))?;
        if unsafe { libc::mkdirat(dir.fd, candidate_c.as_ptr(), 0o755) } == 0 {
            let made = dir.open_child(&candidate).map_err(|_| {
                FolderError::Failed(format!("The new folder “{candidate}” couldn’t be opened."))
            })?;
            let identity = made.identity().ok_or_else(|| {
                FolderError::Failed(format!("The new folder “{candidate}” couldn’t be opened."))
            })?;
            return Ok(Resolved {
                path: made.path.to_string_lossy().into_owned(),
                identity,
            });
        }
        let code = errno();
        if code != libc::EEXIST {
            return Err(FolderError::Failed(errno_text(code)));
        }
        number += 1;
    }
}

pub fn discard(made: &Resolved) -> bool {
    let parent = Path::new(&made.path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Ok(dir) = open_dir(&parent, false) else {
        return false;
    };
    let name = last_component(&made.path);
    let Ok(info) = dir.info(&name) else {
        return false;
    };
    if info.st_mode & libc::S_IFMT != libc::S_IFDIR
        || (Identity {
            device: info.st_dev as i64,
            inode: info.st_ino as i64,
        }) != made.identity
    {
        return false;
    }
    let Some(name_c) = c(&name) else { return false };
    unsafe { libc::unlinkat(dir.fd, name_c.as_ptr(), libc::AT_REMOVEDIR) == 0 }
}

pub enum Listing {
    Missing,
    Failed(String),
    Found(RemoteLevel),
}

fn open_root(root: &str, identity: Option<Identity>) -> Result<Dir, Listing> {
    let name = last_component(root);
    match open_dir(root, identity.is_some()) {
        Ok(dir) => {
            if identity.is_some_and(|expected| dir.identity() != Some(expected)) {
                return Err(Listing::Failed(format!(
                    "“{name}” isn’t the folder Ardia added any more."
                )));
            }
            Ok(dir)
        }
        Err(code) => {
            let link = std::fs::symlink_metadata(root).is_ok_and(|m| m.file_type().is_symlink());
            if identity.is_some() && (code == libc::ELOOP || code == libc::ENOTDIR) && link {
                Err(Listing::Failed(format!(
                    "“{name}” isn’t the folder Ardia added any more."
                )))
            } else if code == libc::ENOENT || code == libc::ENOTDIR {
                Err(Listing::Missing)
            } else {
                Err(Listing::Failed(format!(
                    "Can’t open “{name}”: {}",
                    errno_text(code)
                )))
            }
        }
    }
}

fn is_link_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .is_some_and(|e| e.to_string_lossy().to_lowercase() == "webloc")
}

fn waiting_for(path: &Path, ubiquity: &dyn crate::sync_engine::vault::Ubiquity) -> bool {
    if ubiquity.downloading(path) {
        ubiquity.start_download(path);
        return true;
    }
    false
}

fn plist_text(data: &[u8]) -> Option<String> {
    if data.starts_with(b"bplist") {
        return binary_plist_as_xml(data);
    }
    String::from_utf8(data.to_vec()).ok()
}

#[cfg(target_os = "macos")]
fn binary_plist_as_xml(data: &[u8]) -> Option<String> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSData;
    let class = AnyClass::get(c"NSPropertyListSerialization")?;
    let ns_data = NSData::with_bytes(data);
    unsafe {
        let mut problem: *mut AnyObject = std::ptr::null_mut();
        let plist: Option<Retained<AnyObject>> = msg_send![class, propertyListWithData: &*ns_data, options: 0usize, format: std::ptr::null_mut::<usize>(), error: &mut problem];
        let plist = plist?;
        let xml: Option<Retained<NSData>> = msg_send![class, dataWithPropertyList: &*plist, format: 100usize, options: 0usize, error: &mut problem];
        String::from_utf8(xml?.to_vec()).ok()
    }
}

#[cfg(not(target_os = "macos"))]
fn binary_plist_as_xml(_data: &[u8]) -> Option<String> {
    None
}

fn exceeded_level() -> RemoteLevel {
    RemoteLevel {
        entries: Vec::new(),
        manifest: None,
        manifest_pending: true,
    }
}

fn level(
    dir: &Dir,
    depth: usize,
    budget: &mut Budget,
    ubiquity: &dyn crate::sync_engine::vault::Ubiquity,
) -> Result<RemoteLevel, String> {
    let dir_name = last_component(&dir.path.to_string_lossy());
    let Some(mut names) = dir.names(Some(budget), usize::MAX) else {
        return Err(format!("Can’t read “{dir_name}”: {}", errno_text(errno())));
    };
    if budget.exceeded() {
        return Ok(exceeded_level());
    }
    names.sort();
    let present: HashSet<String> = names.iter().cloned().collect();
    let mut entries = Vec::new();
    let mut manifest: Option<String> = None;
    let mut manifest_pending = false;
    for name in names {
        let path = dir.path.join(&name);
        let kind = dir.kind(&name);
        if name.starts_with('.') {
            if name == sf::MANIFEST {
                let text = if kind == Kind::File && !waiting_for(&path, ubiquity) {
                    coordinated_read(&path, || dir.bounded_read(&name, MAX_MANIFEST_BYTES))
                        .and_then(|d| plist_text(&d))
                } else {
                    None
                };
                match text {
                    Some(text) => {
                        budget.bytes += text.len();
                        if budget.exceeded() {
                            return Ok(exceeded_level());
                        }
                        manifest = Some(text);
                    }
                    None => manifest_pending = true,
                }
                continue;
            }
            if !name.ends_with(PLACEHOLDER) || kind != Kind::File {
                continue;
            }
            let real = name[1..name.len() - PLACEHOLDER.len()].to_owned();
            ubiquity.start_download(&dir.path.join(&real));
            if real == sf::MANIFEST {
                manifest_pending = true;
            } else if is_link_name(&real) && !present.contains(&real) {
                entries.push(RemoteEntry::Held {
                    file: real,
                    waiting: true,
                });
            }
            continue;
        }
        match kind {
            Kind::Directory => {
                let package = std::fs::metadata(&path).is_ok() && is_package(&path);
                if package || depth >= MAX_DEPTH {
                    entries.push(RemoteEntry::Held {
                        file: name,
                        waiting: false,
                    });
                    continue;
                }
                match dir.open_child(&name) {
                    Ok(child) => {
                        let inner = level(&child, depth + 1, budget, ubiquity)?;
                        if budget.exceeded() {
                            return Ok(exceeded_level());
                        }
                        entries.push(RemoteEntry::Dir {
                            file: name,
                            level: inner,
                        });
                    }
                    Err(code) if code == libc::ENOENT => {}
                    Err(code) if code == libc::ELOOP || code == libc::ENOTDIR => {
                        entries.push(RemoteEntry::Held {
                            file: name,
                            waiting: false,
                        })
                    }
                    Err(code) => return Err(format!("Can’t read “{name}”: {}", errno_text(code))),
                }
            }
            Kind::File if is_link_name(&name) => {
                let size = dir.info(&name).map_or(0, |i| i.st_size as usize);
                if size > MAX_LINK_BYTES {
                    entries.push(RemoteEntry::Held {
                        file: name,
                        waiting: false,
                    });
                } else if waiting_for(&path, ubiquity) {
                    entries.push(RemoteEntry::Held {
                        file: name,
                        waiting: true,
                    });
                } else if let Some(text) =
                    coordinated_read(&path, || dir.bounded_read(&name, MAX_LINK_BYTES))
                        .and_then(|d| plist_text(&d))
                {
                    budget.bytes += text.len();
                    if budget.exceeded() {
                        return Ok(exceeded_level());
                    }
                    match sf::parse_webloc(&text).filter(|u| sf::is_shareable_url(u)) {
                        Some(url) => entries.push(RemoteEntry::Link {
                            file: name,
                            url,
                            id: sf::webloc_link_id(&text),
                        }),
                        None => entries.push(RemoteEntry::Held {
                            file: name,
                            waiting: false,
                        }),
                    }
                } else {
                    entries.push(RemoteEntry::Held {
                        file: name,
                        waiting: false,
                    });
                }
            }
            Kind::Missing => {}
            Kind::Blocked => return Err(format!("Can’t read “{name}” in “{dir_name}”.")),
            _ => entries.push(RemoteEntry::Held {
                file: name,
                waiting: false,
            }),
        }
    }
    let manifest_newer = sf::manifest_is_newer(manifest.as_deref());
    Ok(RemoteLevel {
        entries,
        manifest: sf::parse_manifest(manifest.as_deref()),
        manifest_pending: manifest_pending || manifest_newer,
    })
}

fn is_package(path: &Path) -> bool {
    path.extension().is_some_and(|e| {
        matches!(
            e.to_string_lossy().to_lowercase().as_str(),
            "app" | "bundle" | "framework" | "pkg" | "photoslibrary" | "rtfd"
        )
    })
}

pub fn read(
    root: &str,
    identity: Option<Identity>,
    ubiquity: &dyn crate::sync_engine::vault::Ubiquity,
) -> Listing {
    let dir = match open_root(root, identity) {
        Ok(dir) => dir,
        Err(listing) => return listing,
    };
    let mut budget = Budget::default();
    match level(&dir, 0, &mut budget, ubiquity) {
        Ok(_) if budget.exceeded() => Listing::Failed(format!(
            "“{}” holds more than {MAX_ENTRIES} items or {} MB of links; Ardia syncs smaller folders.",
            last_component(root),
            MAX_SCAN_BYTES / 1024 / 1024
        )),
        Ok(top) => Listing::Found(top),
        Err(problem) => Listing::Failed(problem),
    }
}

const OUTSIDE: &str = "A folder change pointed outside the shared folder.";

fn parts(path: &str) -> Option<Vec<String>> {
    let parts: Vec<String> = path
        .split('/')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    (!parts.is_empty() && !path.starts_with('/') && !parts.iter().any(|p| p == ".." || p == "."))
        .then_some(parts)
}

fn parent_of(parts: &[String], root: &Dir) -> Result<Option<Dir>, String> {
    let mut current = Dir {
        fd: unsafe { libc::dup(root.fd) },
        path: root.path.clone(),
    };
    if current.fd < 0 {
        return Err(errno_text(errno()));
    }
    for part in &parts[..parts.len() - 1] {
        match current.open_child(part) {
            Ok(next) => current = next,
            Err(code) if code == libc::ENOENT => return Ok(None),
            Err(code) if code == libc::ELOOP || code == libc::ENOTDIR => {
                return Err(OUTSIDE.to_owned());
            }
            Err(code) => return Err(errno_text(code)),
        }
    }
    if current.kind(parts.last().map_or("", String::as_str)) == Kind::Symlink {
        return Err(OUTSIDE.to_owned());
    }
    Ok(Some(current))
}

fn link_url(dir: &Dir, name: &str) -> Option<String> {
    let data = dir.bounded_read(name, MAX_LINK_BYTES)?;
    sf::parse_webloc(&plist_text(&data)?)
}

fn staged(data: &[u8], near: &Path, name: &str) -> Result<(PathBuf, PathBuf), String> {
    let make = |root: &Path| -> std::io::Result<(PathBuf, PathBuf)> {
        let staging = root.join(format!(".ardia-staging-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&staging)?;
        let temporary = staging.join(name);
        if let Err(problem) = std::fs::write(&temporary, data) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(problem);
        }
        Ok((staging, temporary))
    };
    make(&std::env::temp_dir())
        .or_else(|_| make(near))
        .map_err(|e| e.to_string())
}

fn rename_into(from: &Path, dir: &Dir, name: &str, exclusive: bool) -> Result<bool, i32> {
    let from_c = c(&from.to_string_lossy()).ok_or(libc::EINVAL)?;
    let name_c = c(name).ok_or(libc::EINVAL)?;
    #[cfg(target_os = "macos")]
    let done = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            from_c.as_ptr(),
            dir.fd,
            name_c.as_ptr(),
            if exclusive { libc::RENAME_EXCL } else { 0 },
        )
    } == 0;
    #[cfg(not(target_os = "macos"))]
    let done = {
        if exclusive && dir.kind(name) != Kind::Missing {
            return Ok(false);
        }
        unsafe { libc::renameat(libc::AT_FDCWD, from_c.as_ptr(), dir.fd, name_c.as_ptr()) == 0 }
    };
    if done {
        return Ok(true);
    }
    let code = errno();
    if code == libc::EEXIST {
        Ok(false)
    } else {
        Err(code)
    }
}

fn write_link(
    data: &[u8],
    dir: &Dir,
    name: &str,
    create: bool,
    expect: Option<&str>,
) -> Result<bool, String> {
    let (staging, temporary) = staged(data, &dir.path, name)?;
    let result = coordinated_write(&dir.path.join(name), Writing::Replacing, || {
        match dir.kind(name) {
            Kind::Missing => {
                if !create && expect.is_some() {
                    return Ok(false);
                }
                rename_into(&temporary, dir, name, true).map_err(errno_text)
            }
            Kind::File => {
                if create {
                    return Ok(false);
                }
                if let Some(expect) = expect
                    && link_url(dir, name).as_deref() != Some(expect)
                {
                    return Ok(false);
                }
                rename_into(&temporary, dir, name, false).map_err(errno_text)
            }
            _ => Ok(false),
        }
    });
    let _ = std::fs::remove_dir_all(staging);
    result
}

const TIMED_OUT: &str = "\u{1}timed out";

fn coordinated_read(path: &Path, body: impl FnOnce() -> Option<Vec<u8>>) -> Option<Vec<u8>> {
    crate::file_coordination::read(path, body).ok().flatten()
}

fn coordinated_write<T>(
    path: &Path,
    writing: Writing,
    body: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    match crate::file_coordination::write(path, writing, body) {
        Ok(result) => result,
        Err(crate::file_coordination::CoordinationError::TimedOut) => Err(TIMED_OUT.to_owned()),
        Err(crate::file_coordination::CoordinationError::Failed(problem)) => Err(problem),
    }
}

fn move_entry(source: &Dir, name: &str, destination: &Dir, target: &str) -> Result<bool, String> {
    if destination.kind(target) != Kind::Missing {
        return Ok(false);
    }
    match crate::file_coordination::moving(
        &source.path.join(name),
        &destination.path.join(target),
        || move_now(source, name, destination, target),
    ) {
        Ok(result) => result,
        Err(crate::file_coordination::CoordinationError::TimedOut) => Err(TIMED_OUT.to_owned()),
        Err(crate::file_coordination::CoordinationError::Failed(problem)) => Err(problem),
    }
}

fn move_now(source: &Dir, name: &str, destination: &Dir, target: &str) -> Result<bool, String> {
    if destination.kind(target) != Kind::Missing {
        return Ok(false);
    }
    let (Some(name_c), Some(target_c)) = (c(name), c(target)) else {
        return Err(OUTSIDE.to_owned());
    };
    #[cfg(target_os = "macos")]
    let done = unsafe {
        libc::renameatx_np(
            source.fd,
            name_c.as_ptr(),
            destination.fd,
            target_c.as_ptr(),
            libc::RENAME_EXCL,
        )
    } == 0;
    #[cfg(not(target_os = "macos"))]
    let done = unsafe {
        libc::renameat(
            source.fd,
            name_c.as_ptr(),
            destination.fd,
            target_c.as_ptr(),
        )
    } == 0;
    if done {
        return Ok(true);
    }
    let code = errno();
    if code == libc::EEXIST {
        Ok(false)
    } else {
        Err(errno_text(code))
    }
}

fn delete_link(
    dir: &Dir,
    name: &str,
    expect: &str,
    ubiquity: &dyn crate::sync_engine::vault::Ubiquity,
) -> Result<bool, String> {
    let kind = dir.kind(name);
    if kind == Kind::Missing && dir.kind(&format!(".{name}{PLACEHOLDER}")) == Kind::File {
        ubiquity.start_download(&dir.path.join(name));
        return Ok(false);
    }
    match kind {
        Kind::File => {}
        Kind::Blocked => return Ok(false),
        _ => return Ok(true),
    }
    coordinated_write(&dir.path.join(name), Writing::Deleting, || {
        if link_url(dir, name).as_deref() != Some(expect) {
            return Ok(true);
        }
        let Some(name_c) = c(name) else {
            return Ok(true);
        };
        if unsafe { libc::unlinkat(dir.fd, name_c.as_ptr(), 0) } != 0 && errno() != libc::ENOENT {
            return Err(errno_text(errno()));
        }
        Ok(true)
    })
}

fn remove_empty_directory(parent: &Dir, name: &str) -> Result<(), String> {
    if parent.kind(name) != Kind::Directory {
        return Ok(());
    }
    let dir = match parent.open_child(name) {
        Ok(dir) => dir,
        Err(code) if code == libc::ENOENT || code == libc::ENOTDIR || code == libc::ELOOP => {
            return Ok(());
        }
        Err(code) => return Err(errno_text(code)),
    };
    let housekeeping = [
        sf::MANIFEST.to_owned(),
        format!(".{}{PLACEHOLDER}", sf::MANIFEST),
        ".DS_Store".to_owned(),
    ];
    let names = dir
        .names(None, housekeeping.len() + 1)
        .ok_or_else(|| errno_text(errno()))?;
    if !names.iter().all(|n| housekeeping.contains(n)) {
        return Ok(());
    }
    let order = (dir.kind(sf::MANIFEST) == Kind::File)
        .then(|| dir.bounded_read(sf::MANIFEST, MAX_MANIFEST_BYTES))
        .flatten();
    for item in &housekeeping {
        if dir.kind(item) == Kind::File
            && let Some(item_c) = c(item)
        {
            unsafe { libc::unlinkat(dir.fd, item_c.as_ptr(), 0) };
        }
    }
    let Some(name_c) = c(name) else { return Ok(()) };
    if unsafe { libc::unlinkat(parent.fd, name_c.as_ptr(), libc::AT_REMOVEDIR) } == 0 {
        return Ok(());
    }
    let code = errno();
    if let Some(order) = order
        && let Ok((staging, temporary)) = staged(&order, &dir.path, sf::MANIFEST)
    {
        let _ = rename_into(&temporary, &dir, sf::MANIFEST, true);
        let _ = std::fs::remove_dir_all(staging);
    }
    if code != libc::ENOTEMPTY && code != libc::ENOENT && code != libc::EEXIST {
        return Err(errno_text(code));
    }
    Ok(())
}

fn apply_op(
    op: &FolderOp,
    root: &Dir,
    ubiquity: &dyn crate::sync_engine::vault::Ubiquity,
) -> Result<Option<String>, String> {
    let path = match op {
        FolderOp::Write { path, .. }
        | FolderOp::Move { path, .. }
        | FolderOp::Delete { path, .. }
        | FolderOp::Mkdir { path }
        | FolderOp::Rmdir { path } => path,
    };
    let parts = parts(path).ok_or_else(|| OUTSIDE.to_owned())?;
    let name = parts.last().cloned().unwrap_or_default();
    let folder = parent_of(&parts, root)?;
    match op {
        FolderOp::Write {
            text,
            create,
            expect,
            ..
        } => {
            if !is_link_name(&name) && name != sf::MANIFEST {
                return Err("Only links and the folder’s order are written.".into());
            }
            let Some(folder) = folder else {
                return Ok(Some(path.clone()));
            };
            Ok(
                (!write_link(text.as_bytes(), &folder, &name, *create, expect.as_deref())?)
                    .then(|| path.clone()),
            )
        }
        FolderOp::Move { to, .. } => {
            let to_parts = self::parts(to)
                .ok_or_else(|| "A rename pointed outside the shared folder.".to_owned())?;
            let destination = parent_of(&to_parts, root)?;
            let from = folder.as_ref().map_or(Kind::Missing, |f| f.kind(&name));
            let target = to_parts.last().cloned().unwrap_or_default();
            let allowed = matches!(from, Kind::Missing | Kind::Directory)
                || (from == Kind::File && is_link_name(&name));
            if !allowed || !(is_link_name(&target) || from != Kind::File) {
                return Err("Only links and folders are renamed.".into());
            }
            let (Some(folder), true) = (folder, from != Kind::Missing) else {
                return Ok(None);
            };
            let Some(destination) = destination else {
                return Ok(Some(to.clone()));
            };
            Ok((!move_entry(&folder, &name, &destination, &target)?).then(|| to.clone()))
        }
        FolderOp::Delete { expect, .. } => {
            if !is_link_name(&name) {
                return Err("Only links are deleted.".into());
            }
            let Some(folder) = folder else {
                return Ok(None);
            };
            Ok((!delete_link(&folder, &name, expect, ubiquity)?).then(|| path.clone()))
        }
        FolderOp::Mkdir { .. } => {
            let Some(folder) = folder else {
                return Ok(Some(path.clone()));
            };
            match folder.kind(&name) {
                Kind::Directory => Ok(None),
                Kind::Missing => {
                    let name_c = c(&name).ok_or_else(|| OUTSIDE.to_owned())?;
                    if unsafe { libc::mkdirat(folder.fd, name_c.as_ptr(), 0o755) } != 0
                        && errno() != libc::EEXIST
                    {
                        return Err(errno_text(errno()));
                    }
                    Ok((folder.kind(&name) != Kind::Directory).then(|| path.clone()))
                }
                _ => Ok(Some(path.clone())),
            }
        }
        FolderOp::Rmdir { .. } => {
            if let Some(folder) = folder {
                remove_empty_directory(&folder, &name)?;
            }
            Ok(None)
        }
    }
}

pub fn apply(
    root: &str,
    identity: Option<Identity>,
    ops: &[FolderOp],
    ubiquity: &dyn crate::sync_engine::vault::Ubiquity,
) -> Result<Vec<String>, String> {
    let name = last_component(root);
    let dir = match open_root(root, identity) {
        Ok(dir) => dir,
        Err(Listing::Missing) => return Err(format!("The folder “{name}” is missing.")),
        Err(Listing::Failed(problem)) => return Err(problem),
        Err(Listing::Found(_)) => return Err(String::new()),
    };
    let mut conflicts = Vec::new();
    for op in ops {
        let applied = apply_op(op, &dir, ubiquity).map_err(|problem| {
            if problem == TIMED_OUT {
                format!("The folder “{name}” didn’t answer in time.")
            } else {
                problem
            }
        })?;
        if let Some(conflict) = applied {
            conflicts.push(conflict);
            break;
        }
    }
    Ok(conflicts)
}

fn identity_value(identity: &Identity) -> Value {
    json!({"device": identity.device, "inode": identity.inode})
}

fn base_value(base: &[BaseEntry]) -> Value {
    serde_json::to_value(base).unwrap_or(Value::Array(Vec::new()))
}

pub fn load_folders(data_dir: &Path) -> HashMap<(String, String), Folder> {
    let text = std::fs::read_to_string(data_dir.join(DOC)).unwrap_or_default();
    let doc: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if doc
        .get("version")
        .and_then(Value::as_u64)
        .is_some_and(|v| v > DOC_VERSION)
    {
        return HashMap::new();
    }
    let mut out = HashMap::new();
    for (profile, by_key) in doc
        .get("folders")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        for (key, f) in by_key.as_object().into_iter().flatten() {
            let Some(path) = f
                .get("path")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
            else {
                continue;
            };
            let Some(base) = f.get("base").and_then(Value::as_array) else {
                continue;
            };
            let identity = f.get("identity").and_then(|i| {
                Some(Identity {
                    device: i.get("device")?.as_i64()?,
                    inode: i.get("inode")?.as_i64()?,
                })
            });
            out.insert(
                (profile.clone(), key.clone()),
                Folder {
                    path: path.to_owned(),
                    base: sf::clean_base(base),
                    added_at: f.get("addedAt").and_then(Value::as_i64).unwrap_or(0),
                    identity,
                },
            );
        }
    }
    out
}

pub fn save_folders(data_dir: &Path, folders: &HashMap<(String, String), Folder>) {
    let mut by_profile: std::collections::BTreeMap<String, Map<String, Value>> =
        std::collections::BTreeMap::new();
    for ((profile, key), f) in folders {
        let mut entry = Map::new();
        entry.insert("path".into(), f.path.clone().into());
        entry.insert("base".into(), base_value(&f.base));
        entry.insert("addedAt".into(), f.added_at.into());
        if let Some(identity) = &f.identity {
            entry.insert("identity".into(), identity_value(identity));
        }
        by_profile
            .entry(profile.clone())
            .or_default()
            .insert(key.clone(), Value::Object(entry));
    }
    let folders: Map<String, Value> = by_profile
        .into_iter()
        .map(|(k, v)| (k, Value::Object(v)))
        .collect();
    let text = json!({"folders": folders, "version": DOC_VERSION}).to_string();
    let temp = data_dir.join(format!(".{DOC}.{}.tmp", uuid::Uuid::new_v4()));
    if std::fs::write(&temp, text)
        .and_then(|_| std::fs::rename(&temp, data_dir.join(DOC)))
        .is_err()
    {
        let _ = std::fs::remove_file(temp);
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Place {
    Shown(GroupId),
    Hidden,
    Gone,
}

pub fn folder_place(s: &BrowserState, profile: &ProfileId, key: &str) -> Place {
    if !s.profiles.contains_key(profile) {
        return Place::Gone;
    }
    let mut order: Vec<&ardia_state::WindowId> = s.focus_order.iter().collect();
    for w in s.window_order.iter() {
        if !order.contains(&w) {
            order.push(w);
        }
    }
    let rank =
        |w: &ardia_state::WindowId| order.iter().position(|x| *x == w).unwrap_or(order.len());
    let regular =
        |w: &ardia_state::WindowId| s.windows.get(w).is_some_and(|w| w.kind == WindowKind::Main);
    let mut copies: Vec<_> = s
        .groups
        .values()
        .filter(|g| {
            g.pinned
                && g.parent_id.is_none()
                && g.profile_id == *profile
                && g.pin_key() == key
                && regular(&g.window_id)
        })
        .collect();
    copies.sort_by_key(|g| rank(&g.window_id));
    if let Some(first) = copies.first() {
        return Place::Shown(first.id.clone());
    }
    if s.persisted
        .parked_pins
        .get(profile)
        .is_some_and(|p| p.groups.iter().any(|g| g.id.as_str() == key))
    {
        return Place::Hidden;
    }
    let shows = s.windows.values().any(|w| {
        w.kind == WindowKind::Main
            && w.tab_ids
                .iter()
                .any(|id| s.tabs.get(id).is_some_and(|t| t.profile_id == *profile))
    });
    if shows { Place::Gone } else { Place::Hidden }
}

fn icloud_drive() -> PathBuf {
    crate::sync_engine::vault::icloud_drive(
        &std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default(),
    )
}

pub fn folder_label(path: &str) -> String {
    let drive = icloud_drive().to_string_lossy().into_owned();
    match path.strip_prefix(&format!("{drive}/")) {
        Some(rest) => std::iter::once("iCloud Drive")
            .chain(rest.split('/'))
            .collect::<Vec<_>>()
            .join(" › "),
        None => path.to_owned(),
    }
}

pub fn status_text(state: &SharedFolderState, path: &str) -> String {
    match state {
        SharedFolderState::Syncing => "Syncing…".to_owned(),
        SharedFolderState::Waiting(1) => "Waiting for 1 link to download".to_owned(),
        SharedFolderState::Waiting(n) => format!("Waiting for {n} links to download"),
        SharedFolderState::Missing => format!(
            "Can’t find the folder in {}",
            folder_label(
                &Path::new(path)
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default()
            )
        ),
        SharedFolderState::Error(e) => format!("Can’t sync: {e}"),
        SharedFolderState::Paused => "Syncs when this profile is open".to_owned(),
        SharedFolderState::Synced => format!("Synced with {}", folder_label(path)),
    }
}

type Ref = (String, String);

#[derive(Default)]
struct Plan {
    due: HashMap<Ref, Instant>,
    check_local_at: Option<Instant>,
    next_poll: Option<Instant>,
    stop: bool,
}

pub struct SharedFolders {
    data_dir: PathBuf,
    location: PathBuf,
    icloud_available: bool,
    store: Arc<BrowserStore>,
    main: Weak<AppCoordinator>,
    folders: Mutex<HashMap<Ref, Folder>>,
    sync: Mutex<HashMap<Ref, SharedFolderState>>,
    signatures: Mutex<HashMap<Ref, String>>,
    watcher: crate::folder_watch::FolderWatcher,
    plan: Mutex<Plan>,
    wake: Condvar,
    ubiquity: Arc<dyn crate::sync_engine::vault::Ubiquity>,
}

impl SharedFolders {
    pub fn new(
        data_dir: &Path,
        scratch: bool,
        store: Arc<BrowserStore>,
        main: Weak<AppCoordinator>,
    ) -> Arc<SharedFolders> {
        let real = crate::sync_engine::keys::uses_keychain(data_dir, scratch);
        let instance = std::env::var("ARDIA_INSTANCE").ok().and_then(|v| {
            v.split(',')
                .find_map(|p| p.strip_prefix("sharedFolders=").map(PathBuf::from))
        });
        let location = instance.unwrap_or_else(|| {
            if real {
                icloud_drive().join("Ardia Shared")
            } else {
                data_dir.join("Ardia Shared")
            }
        });
        let icloud_available = !real || crate::sync_engine::vault::is_dir(&icloud_drive());
        Arc::new_cyclic(|me: &Weak<SharedFolders>| SharedFolders {
            data_dir: data_dir.to_path_buf(),
            location,
            icloud_available,
            store,
            main,
            folders: Mutex::new(load_folders(data_dir)),
            sync: Mutex::new(HashMap::new()),
            signatures: Mutex::new(HashMap::new()),
            watcher: watcher_for(me.clone()),
            plan: Mutex::new(Plan::default()),
            wake: Condvar::new(),
            ubiquity: crate::sync_engine::vault::ubiquity(),
        })
    }

    pub fn location(&self) -> (PathBuf, bool) {
        (self.location.clone(), self.icloud_available)
    }

    pub fn start(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        let _ = std::thread::Builder::new()
            .name("ardia-shared-folders".into())
            .spawn(move || run(me));
        self.rewatch();
        self.sync_all(Duration::ZERO);
    }

    pub fn stop(&self) {
        self.watcher.stop();
        self.plan.lock().stop = true;
        self.wake.notify_all();
    }

    pub fn statuses(&self) -> Vec<SharedFolderStatus> {
        let folders = self.folders.lock();
        let sync = self.sync.lock();
        let mut out: Vec<SharedFolderStatus> = folders
            .iter()
            .map(|((profile, key), f)| {
                let state = sync
                    .get(&(profile.clone(), key.clone()))
                    .cloned()
                    .unwrap_or(SharedFolderState::Syncing);
                SharedFolderStatus {
                    profile_id: ProfileId::new(profile.as_str()),
                    group_key: key.clone(),
                    path: f.path.clone(),
                    reachable: !matches!(
                        state,
                        SharedFolderState::Missing | SharedFolderState::Error(_)
                    ),
                    added_at: Some(f.added_at),
                    status_text: status_text(&state, &f.path),
                    state,
                }
            })
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    pub fn bound(&self, profile: &ProfileId, key: &str) -> Option<Folder> {
        self.folders
            .lock()
            .get(&(profile.as_str().to_owned(), key.to_owned()))
            .cloned()
    }

    fn save(&self) {
        let folders = self.folders.lock().clone();
        save_folders(&self.data_dir, &folders);
        self.rewatch();
    }

    fn rewatch(&self) {
        let mut paths: Vec<String> = self
            .folders
            .lock()
            .values()
            .map(|f| f.path.clone())
            .collect();
        paths.sort();
        paths.dedup();
        self.watcher.watch(paths);
    }

    fn folders_at(&self, paths: &[String]) -> Vec<Ref> {
        self.folders
            .lock()
            .iter()
            .filter(|(_, f)| paths.contains(&f.path))
            .map(|(r, _)| r.clone())
            .collect()
    }

    fn set_sync(&self, r: &Ref, state: SharedFolderState) {
        let changed = self.sync.lock().insert(r.clone(), state.clone()) != Some(state);
        if changed {
            self.notify();
        }
    }

    fn notify(&self) {
        if let Some(main) = self.main.upgrade() {
            main.post(|coordinator| {
                coordinator
                    .signal
                    .emit(ardia_ui::host_data::HostTopics::SYNC)
            });
        }
    }

    pub fn bind(&self, profile: &ProfileId, key: &str, path: &str, identity: Option<Identity>) {
        self.folders.lock().insert(
            (profile.as_str().to_owned(), key.to_owned()),
            Folder {
                path: path.to_owned(),
                base: Vec::new(),
                added_at: ardia_state::store::now_ms(),
                identity,
            },
        );
        self.save();
        self.notify();
    }

    pub fn bind_if_unbound(&self, profile: &ProfileId, key: &str, made: &Resolved) -> bool {
        if self.bound(profile, key).is_some() {
            return false;
        }
        self.bind(profile, key, &made.path, Some(made.identity));
        true
    }

    pub fn unbind(&self, profile: &ProfileId, key: &str) {
        let r = (profile.as_str().to_owned(), key.to_owned());
        if self.folders.lock().remove(&r).is_none() {
            return;
        }
        self.sync.lock().remove(&r);
        self.save();
        self.notify();
    }

    pub fn bound_at(&self, profile: &ProfileId, found: &Resolved) -> Option<String> {
        self.folders
            .lock()
            .iter()
            .find(|((p, _), f)| {
                *p == profile.as_str()
                    && match f.identity {
                        Some(id) => id == found.identity,
                        None => f.path == found.path,
                    }
            })
            .map(|((_, k), _)| k.clone())
    }

    pub fn schedule(&self, profile: &ProfileId, key: &str, delay: Duration) {
        let mut plan = self.plan.lock();
        let at = Instant::now() + delay;
        let entry = plan
            .due
            .entry((profile.as_str().to_owned(), key.to_owned()))
            .or_insert(at);
        *entry = (*entry).min(at);
        drop(plan);
        self.wake.notify_all();
    }

    pub fn sync_all(&self, delay: Duration) {
        let refs: Vec<Ref> = self.folders.lock().keys().cloned().collect();
        for (profile, key) in refs {
            self.schedule(&ProfileId::new(profile.as_str()), &key, delay);
        }
    }

    pub fn note_store_change(&self) {
        if self.folders.lock().is_empty() {
            return;
        }
        self.plan.lock().check_local_at = Some(Instant::now() + LOCAL_SETTLE);
        self.wake.notify_all();
    }

    fn check_local(&self) {
        let s = self.store.snapshot();
        let folders: Vec<(Ref, Folder)> = self
            .folders
            .lock()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for ((profile, key), folder) in folders {
            let profile_id = ProfileId::new(profile.as_str());
            let signature = match folder_place(&s, &profile_id, &key) {
                Place::Shown(group) => local_signature(&s, &group, &folder.base),
                Place::Hidden => "hidden".into(),
                Place::Gone => "gone".into(),
            };
            if self.signatures.lock().get(&(profile, key.clone())) != Some(&signature) {
                self.schedule(&profile_id, &key, Duration::ZERO);
            }
        }
    }

    fn upgrade_legacy(&self, profile: &ProfileId, key: &str) -> Option<Folder> {
        let was = self.bound(profile, key)?;
        if was.identity.is_some() {
            return Some(was);
        }
        match resolve(&was.path) {
            Err(FolderError::Refused(_)) => return None,
            Err(_) => {}
            Ok(found) => {
                let mut folders = self.folders.lock();
                if let Some(current) =
                    folders.get_mut(&(profile.as_str().to_owned(), key.to_owned()))
                    && *current == was
                {
                    current.path = found.path;
                    current.identity = Some(found.identity);
                }
                drop(folders);
                self.save();
            }
        }
        self.bound(profile, key)
    }

    pub fn round(&self, profile: &ProfileId, key: &str) {
        let r = (profile.as_str().to_owned(), key.to_owned());
        let Some(folder) = self.upgrade_legacy(profile, key) else {
            return;
        };
        let place = folder_place(&self.store.snapshot(), profile, key);
        let Place::Shown(_) = place else {
            self.signatures.lock().insert(
                r.clone(),
                if place == Place::Gone {
                    "gone".into()
                } else {
                    "hidden".into()
                },
            );
            if place == Place::Gone {
                self.unbind(profile, key);
            } else {
                self.set_sync(&r, SharedFolderState::Paused);
            }
            return;
        };
        let listing = read(&folder.path, folder.identity, self.ubiquity.as_ref());
        if self.bound(profile, key).as_ref() != Some(&folder) {
            self.schedule(profile, key, REMOTE_SETTLE);
            return;
        }
        let remote = match listing {
            Listing::Failed(problem) => {
                return self.set_sync(&r, SharedFolderState::Error(problem));
            }
            Listing::Missing => {
                let s = self.store.snapshot();
                if let Place::Shown(group) = folder_place(&s, profile, key) {
                    self.signatures
                        .lock()
                        .insert(r.clone(), local_signature(&s, &group, &folder.base));
                }
                return self.set_sync(&r, SharedFolderState::Missing);
            }
            Listing::Found(remote) => remote,
        };
        let Some((mut level, waiting, group)) =
            self.merge_into_store(profile, key, &folder, &remote)
        else {
            self.schedule(profile, key, REMOTE_SETTLE);
            return;
        };
        let planned = sf::plan_files(&level, &folder.base, ardia_state::store::now_ms());
        let _ = &mut level;
        let settled = local_signature(&self.store.snapshot(), &group, &planned.base);
        if !self.store.flush(SAVE_WAIT) {
            self.schedule(profile, key, CONFLICT_RETRY);
            return self.set_sync(&r, SharedFolderState::Syncing);
        }
        if self.bound(profile, key).as_ref() != Some(&folder) {
            self.schedule(profile, key, REMOTE_SETTLE);
            return;
        }
        let conflicts = if planned.ops.is_empty() {
            Ok(Vec::new())
        } else {
            apply(
                &folder.path,
                folder.identity,
                &planned.ops,
                self.ubiquity.as_ref(),
            )
        };
        match conflicts {
            Err(problem) => self.set_sync(&r, SharedFolderState::Error(problem)),
            Ok(conflicts) if !conflicts.is_empty() => {
                self.schedule(profile, key, CONFLICT_RETRY);
                self.set_sync(&r, SharedFolderState::Syncing);
            }
            Ok(_) => {
                if let Some(current) = self.folders.lock().get_mut(&r) {
                    current.base = planned.base;
                }
                self.save();
                self.signatures.lock().insert(r.clone(), settled);
                self.plan.lock().check_local_at = Some(Instant::now());
                self.set_sync(
                    &r,
                    if waiting > 0 {
                        SharedFolderState::Waiting(waiting)
                    } else {
                        SharedFolderState::Synced
                    },
                );
            }
        }
    }

    fn merge_into_store(
        &self,
        profile: &ProfileId,
        key: &str,
        folder: &Folder,
        remote: &RemoteLevel,
    ) -> Option<(sf::TargetLevel, u32, GroupId)> {
        let profile = profile.clone();
        let key = key.to_owned();
        let base = folder.base.clone();
        let remote = remote.clone();
        let job = move |store: &BrowserStore,
                        dispatch: &dyn Fn(Action)|
              -> Option<(sf::TargetLevel, u32, GroupId)> {
            let s = store.snapshot();
            let Place::Shown(group) = folder_place(&s, &profile, &key) else {
                return None;
            };
            let mut names = HashMap::new();
            sf::known_names(&base, &mut names);
            let local = sf::local_folder(&s, &group, &names)?;
            let merged = sf::merge_folder(&base, &local.entries, &remote);
            let removals = sf::folder_removals(&s, &group, &merged.level, &local);
            if !removals.removed.is_empty() {
                dispatch(Action::CloseSyncedTabs {
                    tabs: removals.removed,
                });
            }
            let mut level = merged.level;
            let after = store.snapshot();
            if let Some((next, _)) = sf::with_folder(
                &s,
                &after,
                &group,
                &mut level,
                &local,
                store.ids(),
                ardia_state::store::now_ms(),
            ) {
                store.replace(next);
            }
            Some((level, merged.waiting, group))
        };
        match self.main.upgrade() {
            Some(main) => {
                let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                main.post(move |coordinator| {
                    let dispatch = |action: Action| {
                        let _ = coordinator.dispatch_action(action);
                    };
                    let _ = sender.send(job(&coordinator.store, &dispatch));
                });
                drop(main);
                receiver
                    .recv_timeout(Duration::from_secs(10))
                    .ok()
                    .flatten()
            }
            None => {
                let store = self.store.clone();
                let dispatch = |action: Action| {
                    let _ = store.dispatch(action);
                };
                job(&self.store, &dispatch)
            }
        }
    }
}

pub fn local_signature(s: &BrowserState, group: &GroupId, base: &[BaseEntry]) -> String {
    let mut names = HashMap::new();
    sf::known_names(base, &mut names);
    sf::local_folder(s, group, &names)
        .map_or_else(String::new, |f| LocalEntry::signature(&f.entries))
}

fn run(me: Weak<SharedFolders>) {
    loop {
        let Some(folders) = me.upgrade() else { return };
        let (due, check_local, poll) = {
            let mut plan = folders.plan.lock();
            if plan.stop {
                return;
            }
            let now = Instant::now();
            let next_poll = *plan.next_poll.get_or_insert(now + POLL);
            let soonest = plan
                .due
                .values()
                .copied()
                .chain(plan.check_local_at)
                .chain(std::iter::once(next_poll))
                .min()
                .unwrap_or(next_poll);
            if soonest > now {
                folders.wake.wait_until(&mut plan, soonest);
            }
            if plan.stop {
                return;
            }
            let now = Instant::now();
            let due: Vec<Ref> = plan
                .due
                .iter()
                .filter(|(_, at)| **at <= now)
                .map(|(r, _)| r.clone())
                .collect();
            for r in &due {
                plan.due.remove(r);
            }
            let check = plan.check_local_at.is_some_and(|at| at <= now);
            if check {
                plan.check_local_at = None;
            }
            let poll = plan.next_poll.is_some_and(|at| at <= now);
            if poll {
                plan.next_poll = Some(now + POLL);
            }
            (due, check, poll)
        };
        if poll {
            folders.sync_all(Duration::ZERO);
        }
        if check_local {
            folders.check_local();
        }
        for (profile, key) in due {
            folders.round(&ProfileId::new(profile.as_str()), &key);
        }
        drop(folders);
    }
}

fn watcher_for(me: Weak<SharedFolders>) -> crate::folder_watch::FolderWatcher {
    crate::folder_watch::FolderWatcher::new(Box::new(move |paths| {
        let Some(folders) = me.upgrade() else { return };
        for (profile, key) in folders.folders_at(&paths) {
            folders.schedule(&ProfileId::new(profile.as_str()), &key, REMOTE_SETTLE);
        }
    }))
}

pub fn shared_group_of(
    s: &BrowserState,
    folders: &SharedFolders,
    group: &GroupId,
) -> Option<(ProfileId, String, Folder)> {
    let g = s.groups.get(group)?;
    if !g.pinned || g.parent_id.is_some() {
        return None;
    }
    let key = g.pin_key().to_owned();
    folders
        .bound(&g.profile_id, &key)
        .map(|f| (g.profile_id.clone(), key, f))
}

pub fn file_url_of(path: &str) -> String {
    let encoded: Vec<String> = path.split('/').map(percent_encode).collect();
    format!("file://{}/", encoded.join("/"))
}

fn percent_encode(part: &str) -> String {
    let mut out = String::new();
    for b in part.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn with_shared_group(
    s: &BrowserState,
    window: &ardia_state::WindowId,
    name: &str,
    ids: &ardia_state::IdGen,
    now: i64,
) -> Option<(BrowserState, GroupId)> {
    let w = s.windows.get(window)?;
    if w.kind != WindowKind::Main {
        return None;
    }
    let profile = w.profile_id.clone();
    let tab_id = ardia_state::TabId::from(ids.next("t"));
    let mut tab = ardia_state::tabs::Tab::new(
        tab_id.clone(),
        window.clone(),
        profile.clone(),
        sf::EMPTY_FOLDER_URL,
        now,
    );
    tab.title = sf::EMPTY_FOLDER_TITLE.into();
    tab.custom_title = Some(sf::EMPTY_FOLDER_TITLE.into());
    tab.page = ardia_state::model::TabPage::ASLEEP;
    let group_id = GroupId::from(ids.next("g"));
    let mut group = ardia_state::groups::TabGroup::new(
        group_id.clone(),
        window.clone(),
        profile,
        vec![tab_id.clone()],
        now,
    );
    group.name = name.to_owned();
    group.pinned = true;
    let mut next = s.clone();
    Arc::make_mut(&mut next.tabs).insert(tab_id.clone(), Arc::new(tab));
    let mut groups = (*next.groups).clone();
    groups.insert(group_id.clone(), Arc::new(group));
    let groups = ardia_state::groups::nest_groups(&groups);
    let pinned_area = ardia_state::groups::pinned_group_members(&s.groups);
    let mut ids_order = w.tab_ids.clone();
    let at = w.tab_ids.iter().enumerate().fold(0, |last, (i, t)| {
        if s.tabs.get(t).is_some_and(|t| t.pin.is_some()) || pinned_area.contains(t) {
            i + 1
        } else {
            last
        }
    });
    ids_order.insert(at.min(ids_order.len()), tab_id);
    let arranged = ardia_state::state::order_sections(&ids_order, &next.tabs, &groups);
    let mut groups = groups;
    ardia_state::groups::sync_group_order(&mut groups, window, &arranged);
    let mut w = (**w).clone();
    w.tab_ids = arranged;
    Arc::make_mut(&mut next.windows).insert(window.clone(), Arc::new(w));
    next.groups = Arc::new(groups);
    Some((next, group_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::vault::PlainFolders;

    #[test]
    fn the_directory_reads_writes_and_refuses_like_the_swift_one() {
        let parent = tempfile::tempdir().unwrap();
        let made = create(&parent.path().to_string_lossy(), None, "Team: Links").unwrap();
        assert!(made.path.ends_with("Team- Links"));
        let again = create(&parent.path().to_string_lossy(), None, "Team: Links").unwrap();
        assert!(again.path.ends_with("Team- Links 2"));
        assert!(discard(&again));
        let ops = vec![
            FolderOp::Write {
                path: "Docs.webloc".into(),
                text: sf::webloc_text("https://docs.example/", Some("id1")),
                create: true,
                expect: None,
            },
            FolderOp::Mkdir {
                path: "Reading".into(),
            },
            FolderOp::Write {
                path: "Reading/Essay.webloc".into(),
                text: sf::webloc_text("https://essay.example/", None),
                create: true,
                expect: None,
            },
            FolderOp::Write {
                path: sf::MANIFEST.into(),
                text: sf::manifest_text(&["Docs.webloc".into(), "Reading".into()]),
                create: false,
                expect: None,
            },
        ];
        assert!(
            apply(&made.path, Some(made.identity), &ops, &PlainFolders)
                .unwrap()
                .is_empty()
        );
        std::fs::write(Path::new(&made.path).join(".Later.webloc.icloud"), b"").unwrap();
        std::fs::write(Path::new(&made.path).join("notes.txt"), b"x").unwrap();
        let Listing::Found(level) = read(&made.path, Some(made.identity), &PlainFolders) else {
            panic!("listing")
        };
        assert_eq!(
            level.manifest,
            Some(vec!["Docs.webloc".to_owned(), "Reading".to_owned()])
        );
        assert!(level.entries.iter().any(|e| matches!(e, RemoteEntry::Link { file, url, id } if file == "Docs.webloc" && url == "https://docs.example/" && id.as_deref() == Some("id1"))));
        assert!(level.entries.iter().any(
            |e| matches!(e, RemoteEntry::Held { file, waiting: true } if file == "Later.webloc")
        ));
        assert!(level.entries.iter().any(
            |e| matches!(e, RemoteEntry::Held { file, waiting: false } if file == "notes.txt")
        ));
        assert!(
            level
                .entries
                .iter()
                .any(|e| matches!(e, RemoteEntry::Dir { file, .. } if file == "Reading"))
        );
        let conflict = apply(
            &made.path,
            Some(made.identity),
            &[FolderOp::Write {
                path: "Docs.webloc".into(),
                text: sf::webloc_text("https://x/", None),
                create: true,
                expect: None,
            }],
            &PlainFolders,
        )
        .unwrap();
        assert_eq!(conflict, vec!["Docs.webloc".to_owned()]);
        let kept = apply(
            &made.path,
            Some(made.identity),
            &[FolderOp::Delete {
                path: "Docs.webloc".into(),
                expect: "https://other/".into(),
            }],
            &PlainFolders,
        )
        .unwrap();
        assert!(kept.is_empty() && Path::new(&made.path).join("Docs.webloc").exists());
        assert!(
            apply(
                &made.path,
                Some(made.identity),
                &[FolderOp::Write {
                    path: "../escape.webloc".into(),
                    text: String::new(),
                    create: true,
                    expect: None
                }],
                &PlainFolders
            )
            .is_err()
        );
        assert!(matches!(resolve("/"), Err(FolderError::Refused(_))));
        assert!(matches!(
            read(
                &made.path,
                Some(Identity {
                    device: 1,
                    inode: 2
                }),
                &PlainFolders
            ),
            Listing::Failed(_)
        ));
        let mut folders = HashMap::new();
        folders.insert(
            ("default".to_owned(), "g1".to_owned()),
            Folder {
                path: made.path.clone(),
                base: Vec::new(),
                added_at: 5,
                identity: Some(made.identity),
            },
        );
        save_folders(parent.path(), &folders);
        assert_eq!(load_folders(parent.path()), folders);
        assert_eq!(file_url_of("/a b/c"), "file:///a%20b/c/");
        assert_eq!(
            status_text(&SharedFolderState::Waiting(2), "/x"),
            "Waiting for 2 links to download"
        );
    }
}

use ardia_ui::sync_api::SyncAnswer;

fn on_main<T: Send + 'static>(
    engine: &crate::sync_engine::SyncEngine,
    job: impl FnOnce(&AppCoordinator) -> T + Send + 'static,
) -> Option<T> {
    engine.host().on_main(Duration::from_secs(10), job)
}

fn folders_of(engine: &crate::sync_engine::SyncEngine) -> Option<Arc<SharedFolders>> {
    on_main(engine, crate::sync_engine::ui_bridge::shared_folders).flatten()
}

fn ask(
    engine: &crate::sync_engine::SyncEngine,
    window: &ardia_state::WindowId,
    question: ardia_ui::Confirmation,
) -> bool {
    let window = window.clone();
    let Some(reply) = on_main(engine, move |c| c.ask_in_window(&window, question)) else {
        return false;
    };
    ardia_profile::strict::blocking(ardia_profile::strict::Blocking::Ipc);
    futures::executor::block_on(reply).unwrap_or(false)
}

fn toast(
    engine: &crate::sync_engine::SyncEngine,
    window: &ardia_state::WindowId,
    title: &str,
    message: Option<&str>,
    icon: &str,
) {
    let now = ardia_state::store::now_ms();
    let text = match message {
        Some(message) => format!("{title}\n{message}"),
        None => title.to_owned(),
    };
    let toast = ardia_state::windows::Toast {
        id: ardia_ui::popovers::toast::next_toast_id(),
        kind: ardia_state::windows::ToastKind::Info,
        message: text,
        action: None,
        icon: Some(icon.to_owned()),
        created_at: now,
        expires_at: Some(now + ardia_ui::popovers::toast::TOAST_ACTION_MS),
    };
    let _ = engine.host().dispatch(Action::PushToast {
        window: window.clone(),
        toast,
    });
}

fn choose_parent(
    engine: &crate::sync_engine::SyncEngine,
    folders: &SharedFolders,
    window: &ardia_state::WindowId,
) -> Option<String> {
    let (location, icloud) = folders.location();
    if icloud {
        return Some(location.to_string_lossy().into_owned());
    }
    let question = ardia_ui::Confirmation {
        title: "iCloud Drive Is Off".into(),
        message: "Shared folders live in iCloud Drive, where the people you invite get your changes. Turn it on in System Settings › Apple Account › iCloud, or keep the folder in another folder that syncs, like one in Dropbox.".into(),
        confirm: "Choose Folder…".into(),
        destructive: false,
    };
    if !ask(engine, window, question) {
        return None;
    }
    crate::sync_engine::actions::platform::pick_folder(engine, None, "Use Folder", None)
}

fn group_label(s: &BrowserState, group: &GroupId) -> String {
    s.groups
        .get(group)
        .map(|g| sf::group_name(g))
        .unwrap_or_default()
}

pub fn add_shared_folder(
    engine: &crate::sync_engine::SyncEngine,
    window: &ardia_state::WindowId,
) -> SyncAnswer {
    let Some(folders) = folders_of(engine) else {
        return SyncAnswer::Flag(false);
    };
    let state = engine.host().state();
    let Some(w) = state
        .windows
        .get(window)
        .filter(|w| w.kind == WindowKind::Main && !w.profile_id.is_incognito())
    else {
        return SyncAnswer::Flag(false);
    };
    let profile = w.profile_id.clone();
    let (location, icloud) = folders.location();
    let start = if icloud {
        Some(location.to_string_lossy().into_owned())
    } else {
        choose_parent(engine, &folders, window)
    };
    let Some(start) = start else {
        return SyncAnswer::Flag(false);
    };
    let Some(picked) =
        crate::sync_engine::actions::platform::pick_folder(engine, Some(start), "Add Folder", None)
    else {
        return SyncAnswer::Flag(false);
    };
    let found = match resolve(&picked) {
        Ok(found) => found,
        Err(problem) => {
            toast(
                engine,
                window,
                "Couldn’t add this folder",
                Some(&problem.text()),
                "exclamationmark.icloud",
            );
            return SyncAnswer::Failed(problem.text());
        }
    };
    let state = engine.host().state();
    if state.windows.get(window).map(|w| &w.profile_id) != Some(&profile) {
        return SyncAnswer::Flag(false);
    }
    if let Some(key) = folders.bound_at(&profile, &found) {
        let shown = state
            .groups
            .values()
            .find(|g| g.profile_id == profile && g.pinned && g.pin_key() == key)
            .map(|g| sf::group_name(g))
            .unwrap_or_else(|| last_component(&found.path));
        toast(
            engine,
            window,
            &format!("“{shown}” is already in your sidebar"),
            None,
            "person.2",
        );
        folders.schedule(&profile, &key, Duration::ZERO);
        return SyncAnswer::Done;
    }
    let name = Path::new(&found.path).file_name().map_or_else(
        || "Shared Folder".to_owned(),
        |n| n.to_string_lossy().into_owned(),
    );
    let store = engine.host().store().clone();
    let window_id = window.clone();
    let made = on_main(engine, move |c| {
        let s = store.snapshot();
        let (next, group) = with_shared_group(
            &s,
            &window_id,
            &name,
            store.ids(),
            ardia_state::store::now_ms(),
        )?;
        c.store.replace(next);
        let key = c.store.snapshot().groups.get(&group)?.pin_key().to_owned();
        Some(key)
    })
    .flatten();
    let Some(key) = made else {
        return SyncAnswer::Flag(false);
    };
    folders.bind(&profile, &key, &found.path, Some(found.identity));
    folders.round(&profile, &key);
    SyncAnswer::Done
}

pub fn share_folder(
    engine: &crate::sync_engine::SyncEngine,
    window: &ardia_state::WindowId,
    group: &GroupId,
) -> SyncAnswer {
    let Some(folders) = folders_of(engine) else {
        return SyncAnswer::Flag(false);
    };
    let state = engine.host().state();
    let Some(g) = state
        .groups
        .get(group)
        .filter(|g| g.pinned && g.parent_id.is_none() && !g.profile_id.is_incognito())
        .cloned()
    else {
        return SyncAnswer::Flag(false);
    };
    let key = g.pin_key().to_owned();
    let label = group_label(&state, group);
    if folders.bound(&g.profile_id, &key).is_none() {
        let Some(parent) = choose_parent(engine, &folders, window) else {
            return SyncAnswer::Flag(false);
        };
        let made = match create(
            &parent,
            None,
            if label.is_empty() {
                "Shared Folder"
            } else {
                &label
            },
        ) {
            Ok(made) => made,
            Err(problem) => {
                toast(
                    engine,
                    window,
                    "Couldn’t share this folder",
                    Some(&problem.text()),
                    "exclamationmark.icloud",
                );
                return SyncAnswer::Failed(problem.text());
            }
        };
        if !folders.bind_if_unbound(&g.profile_id, &key, &made) {
            discard(&made);
        }
    }
    folders.round(&g.profile_id, &key);
    let Some(folder) = folders.bound(&g.profile_id, &key) else {
        return SyncAnswer::Flag(false);
    };
    let state_now = folders
        .sync
        .lock()
        .get(&(g.profile_id.as_str().to_owned(), key))
        .cloned();
    match state_now {
        Some(SharedFolderState::Synced) | Some(SharedFolderState::Waiting(_)) => {}
        other => {
            let reason = match other {
                Some(SharedFolderState::Error(e)) => e,
                Some(SharedFolderState::Missing) => {
                    "Its folder can’t be found any more. Stop syncing it, then share it again."
                        .to_owned()
                }
                _ => "Its links aren’t in the folder yet. Try again in a moment.".to_owned(),
            };
            toast(
                engine,
                window,
                "Couldn’t share this folder yet",
                Some(&reason),
                "exclamationmark.icloud",
            );
            return SyncAnswer::Failed(reason);
        }
    }
    let url = file_url_of(&folder.path);
    let window_id = window.clone();
    let shown = on_main(engine, move |c| c.share_folder_url(&window_id, &url)).unwrap_or(false);
    SyncAnswer::Flag(shown)
}

pub fn reveal_group_folder(engine: &crate::sync_engine::SyncEngine, group: &GroupId) -> SyncAnswer {
    let Some(folders) = folders_of(engine) else {
        return SyncAnswer::Flag(false);
    };
    let Some((_, _, folder)) = shared_group_of(&engine.host().state(), &folders, group) else {
        return SyncAnswer::Flag(false);
    };
    crate::sync_engine::actions::platform::reveal(&folder.path);
    SyncAnswer::Done
}

pub fn stop_syncing_group(engine: &crate::sync_engine::SyncEngine, group: &GroupId) -> SyncAnswer {
    let Some(folders) = folders_of(engine) else {
        return SyncAnswer::Flag(false);
    };
    let Some((profile, key, _)) = shared_group_of(&engine.host().state(), &folders, group) else {
        return SyncAnswer::Flag(false);
    };
    folders.unbind(&profile, &key);
    SyncAnswer::Done
}

pub fn removal_question(
    s: &BrowserState,
    folders: &SharedFolders,
    group: &GroupId,
) -> Option<ardia_ui::Confirmation> {
    let (_, _, folder) = shared_group_of(s, folders, group)?;
    let name = Some(group_label(s, group))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "this folder".to_owned());
    Some(ardia_ui::Confirmation {
        title: format!("Remove “{name}” from the Sidebar?"),
        message: format!(
            "The folder stays in {}, with every link in it, and the people you shared it with keep it. Ardia only stops syncing it on this Mac.",
            folder_label(&folder.path)
        ),
        confirm: "Remove".into(),
        destructive: true,
    })
}

thread_local! {
    static REMOVAL_CONFIRMED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn removed_group(action: &Action, s: &BrowserState) -> Option<GroupId> {
    let group = match action {
        Action::Ungroup { group }
        | Action::CloseGroup { group }
        | Action::DeleteGroup { group } => group.clone(),
        Action::UpdateGroup { group, patch } if patch.pinned == Some(false) => group.clone(),
        Action::MoveGroupToWindow { group, .. } => group.clone(),
        _ => return None,
    };
    s.groups
        .get(&group)
        .filter(|g| g.pinned && g.parent_id.is_none())
        .map(|g| g.id.clone())
}

impl AppCoordinator {
    pub(crate) fn guard_shared_removal(&self, action: &Action) -> bool {
        if REMOVAL_CONFIRMED.with(std::cell::Cell::get)
            || crate::sync_engine::pin_choices::writing_from_sync()
        {
            return false;
        }
        let Some(folders) = crate::sync_engine::ui_bridge::shared_folders(self) else {
            return false;
        };
        let state = self.store.snapshot();
        let Some(group) = removed_group(action, &state) else {
            return false;
        };
        let Some(question) = removal_question(&state, &folders, &group) else {
            return false;
        };
        let Some(window) = state.groups.get(&group).map(|g| g.window_id.clone()) else {
            return false;
        };
        let reply = self.ask_in_window(&window, question);
        let action = action.clone();
        let me = self.weak();
        self.spawn(async move {
            if !reply.await.unwrap_or(false) {
                return;
            }
            let Some(me) = me.upgrade() else { return };
            if let Some((profile, key, _)) = shared_group_of(&me.store.snapshot(), &folders, &group)
            {
                folders.unbind(&profile, &key);
            }
            REMOVAL_CONFIRMED.with(|c| c.set(true));
            let _ = me.dispatch_action(action);
            REMOVAL_CONFIRMED.with(|c| c.set(false));
        });
        true
    }

    pub(crate) fn share_folder_url(&self, window: &ardia_state::WindowId, url: &str) -> bool {
        #[cfg(target_os = "macos")]
        {
            use ardia_engine::macos::dialogs::{ShareItem, share};
            let anchor = self
                .engine_window(window)
                .and_then(|w| self.engine()?.window_host_view(w).ok());
            if let Some(anchor) = anchor {
                let rect = ardia_engine::Rect::new(0.0, 0.0, 1.0, 1.0);
                return share(&[ShareItem::Url(url.to_owned())], &anchor, rect).is_ok();
            }
        }
        let _ = (window, url);
        false
    }
}

#[cfg(test)]
mod round_tests {
    use super::*;
    use ardia_state::ids::IdGen;
    use ardia_state::persistence::session::{LoadOptions, SessionData};

    fn mac(launch: &str) -> (Arc<BrowserStore>, ardia_state::WindowId) {
        let store = Arc::new(BrowserStore::in_memory(
            BrowserState::from_session(
                SessionData::fresh(LoadOptions::default()),
                1_795_000_000_000,
            ),
            IdGen::with_launch(launch),
        ));
        let window = store
            .dispatch(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: Some(ProfileId::new("default")),
                url: Some("https://home.example/".into()),
                frame: None,
            })
            .unwrap()
            .window
            .unwrap();
        (store, window)
    }

    fn shared_group(
        store: &BrowserStore,
        window: &ardia_state::WindowId,
        links: &[(&str, &str)],
    ) -> GroupId {
        let s = store.snapshot();
        let (mut next, group) =
            with_shared_group(&s, window, "Team Links", store.ids(), 1).unwrap();
        for (title, url) in links {
            let id = ardia_state::TabId::from(store.ids().next("t"));
            let mut tab = ardia_state::tabs::Tab::new(
                id.clone(),
                window.clone(),
                ProfileId::new("default"),
                *url,
                1,
            );
            tab.title = (*title).to_owned();
            tab.pinned_url = Some((*url).to_owned());
            Arc::make_mut(&mut next.tabs).insert(id.clone(), Arc::new(tab));
            let groups = Arc::make_mut(&mut next.groups);
            let g = Arc::make_mut(groups.get_mut(&group).unwrap());
            g.tab_ids.push(id.clone());
            let w = Arc::make_mut(Arc::make_mut(&mut next.windows).get_mut(window).unwrap());
            w.tab_ids.push(id);
        }
        store.replace(next);
        group
    }

    fn links_in(store: &BrowserStore, group: &GroupId) -> Vec<(String, String)> {
        let s = store.snapshot();
        s.groups[group]
            .tab_ids
            .iter()
            .filter_map(|id| s.tabs.get(id))
            .filter(|t| sf::is_shareable_url(t.pin_home()))
            .map(|t| {
                (
                    t.custom_title.clone().unwrap_or_else(|| t.title.clone()),
                    t.pin_home().to_owned(),
                )
            })
            .collect()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_file_another_mac_writes_schedules_a_round_without_polling() {
        let data = tempfile::tempdir().unwrap();
        let shared = tempfile::tempdir().unwrap();
        let (store, window) = mac("w");
        let group = shared_group(&store, &window, &[]);
        let folders = SharedFolders::new(data.path(), true, store.clone(), Weak::new());
        let made = create(&shared.path().to_string_lossy(), None, "Team Links").unwrap();
        let profile = ProfileId::new("default");
        let key = store.snapshot().groups[&group].pin_key().to_owned();
        folders.bind(&profile, &key, &made.path, Some(made.identity));
        assert!(folders.watcher.watching());
        std::thread::sleep(Duration::from_millis(300));
        folders.plan.lock().due.clear();
        std::fs::write(
            Path::new(&made.path).join("New.webloc"),
            sf::webloc_text("https://new.example/", None),
        )
        .unwrap();
        let r = (profile.as_str().to_owned(), key.clone());
        let deadline = Instant::now() + Duration::from_secs(10);
        while !folders.plan.lock().due.contains_key(&r) {
            assert!(Instant::now() < deadline, "no round was scheduled");
            std::thread::sleep(Duration::from_millis(20));
        }
        folders.unbind(&profile, &key);
        assert!(!folders.watcher.watching());
    }

    #[test]
    fn two_macs_share_one_directory() {
        let data_a = tempfile::tempdir().unwrap();
        let data_b = tempfile::tempdir().unwrap();
        let shared = tempfile::tempdir().unwrap();
        let (store_a, window_a) = mac("a");
        let (store_b, window_b) = mac("b");
        let group_a = shared_group(
            &store_a,
            &window_a,
            &[
                ("Docs", "https://docs.example/"),
                ("News", "https://news.example/"),
            ],
        );
        let group_b = shared_group(&store_b, &window_b, &[]);
        let a = SharedFolders::new(data_a.path(), true, store_a.clone(), Weak::new());
        let b = SharedFolders::new(data_b.path(), true, store_b.clone(), Weak::new());
        let made = create(&shared.path().to_string_lossy(), None, "Team Links").unwrap();
        let profile = ProfileId::new("default");
        let key_a = store_a.snapshot().groups[&group_a].pin_key().to_owned();
        let key_b = store_b.snapshot().groups[&group_b].pin_key().to_owned();
        a.bind(&profile, &key_a, &made.path, Some(made.identity));
        b.bind(&profile, &key_b, &made.path, Some(made.identity));
        a.round(&profile, &key_a);
        let files: HashSet<String> = std::fs::read_dir(&made.path)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            files.contains("Docs.webloc")
                && files.contains("News.webloc")
                && files.contains(sf::MANIFEST),
            "{files:?}"
        );
        assert_eq!(a.statuses()[0].state, SharedFolderState::Synced);
        b.round(&profile, &key_b);
        assert_eq!(
            links_in(&store_b, &group_b),
            vec![
                ("Docs".to_owned(), "https://docs.example/".to_owned()),
                ("News".to_owned(), "https://news.example/".to_owned())
            ]
        );
        let docs_tab = store_b.snapshot().groups[&group_b]
            .tab_ids
            .iter()
            .find(|id| store_b.snapshot().tabs[*id].pin_home() == "https://docs.example/")
            .cloned()
            .unwrap();
        assert!(store_b.snapshot().tabs[&docs_tab].page.is_asleep());
        b.round(&profile, &key_b);
        assert_eq!(
            links_in(&store_b, &group_b).len(),
            2,
            "a second round changes nothing"
        );
        std::fs::remove_file(Path::new(&made.path).join("News.webloc")).unwrap();
        b.round(&profile, &key_b);
        assert_eq!(
            links_in(&store_b, &group_b),
            vec![("Docs".to_owned(), "https://docs.example/".to_owned())]
        );
        a.round(&profile, &key_a);
        assert_eq!(
            links_in(&store_a, &group_a),
            vec![("Docs".to_owned(), "https://docs.example/".to_owned())]
        );
        let reloaded = load_folders(data_a.path());
        assert_eq!(reloaded.len(), 1);
        b.unbind(&profile, &key_b);
        assert!(b.statuses().is_empty());
    }
}
