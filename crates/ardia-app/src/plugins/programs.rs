use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use super::folders::PinEntry;
use super::manifest::{MANIFEST_FILE, is_name};
use super::official::{discard, instance_value};
use super::records::approval_hash;

pub const CURRENT: &str = "current";
pub const PREVIOUS: &str = "previous";
pub const LEASES: &str = ".leases";
pub const SYSTEM_DIRS: [&str; 6] = [
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
];
pub const BIN_KEY: &str = "cliBinDir";
pub const SCRATCH_NEEDS_BIN: &str =
    "a test instance puts programs on PATH only with ARDIA_INSTANCE cliBinDir set";
pub const SCRATCH_OUTSIDE: &str =
    "a test instance puts programs on PATH only in a folder inside its ARDIA_DATA_DIR";
pub const REGISTRY_UNREADABLE: &str = "Ardia's list of program names kept for its built-in plugins is missing or damaged, so no program goes on PATH";
const RESERVED: [&str; 3] = [LEASES, ".after-update", ".after-update-claim"];
const CACHES: &str = "__pycache__";
const STALE_SECONDS: i64 = 3600;
const MANIFEST_LIMIT: u64 = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Program {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Places {
    pub store: PathBuf,
    pub bin_dir: PathBuf,
    pub shadowable: Vec<PathBuf>,
    pub confined: Option<PathBuf>,
}

impl Places {
    pub fn new(store: PathBuf, bin_dir: PathBuf) -> Self {
        Places {
            store,
            bin_dir,
            shadowable: SYSTEM_DIRS.iter().map(PathBuf::from).collect(),
            confined: None,
        }
    }

    pub fn plugin_store(&self, plugin: &str) -> PathBuf {
        self.store.join(plugin)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    Name,
    BinFolder,
    BinShared,
    Shadowed,
    Taken,
    OtherPlugin,
    Busy,
    Io,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub reason: String,
    pub cause: Cause,
}

fn refusal(reason: impl Into<String>, cause: Cause) -> Refusal {
    Refusal {
        reason: reason.into(),
        cause,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Linked {
    pub version: String,
    pub linked: Vec<String>,
    pub refused: BTreeMap<String, Refusal>,
    pub kept: Option<String>,
}

pub fn places_for(
    data_dir: &Path,
    isolated: bool,
    home: Option<&Path>,
    instance: Option<&str>,
) -> Result<Places, String> {
    if isolated {
        let bin = instance
            .and_then(|text| instance_value(text, BIN_KEY))
            .ok_or(SCRATCH_NEEDS_BIN)?;
        let bin = PathBuf::from(bin);
        let data = std::fs::canonicalize(data_dir).map_err(|_| SCRATCH_OUTSIDE.to_owned())?;
        if !bin.is_absolute() || !resolved(&bin).is_some_and(|b| inside(&b, &data)) {
            return Err(SCRATCH_OUTSIDE.into());
        }
        let mut places = Places::new(data.join("Programs"), bin);
        places.confined = Some(data);
        return Ok(places);
    }
    let home = home.ok_or("Ardia couldn't find your home folder")?;
    Ok(Places::new(
        home.join("Library/Application Support/Ardia/Programs"),
        home.join(".local/bin"),
    ))
}

pub fn resolved(path: &Path) -> Option<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    while std::fs::symlink_metadata(&existing).is_err() {
        rest.push(existing.file_name()?.to_os_string());
        existing = existing.parent()?.to_path_buf();
    }
    let mut parts: Vec<std::ffi::OsString> = std::fs::canonicalize(&existing)
        .ok()?
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(name) => Some(name.to_os_string()),
            _ => None,
        })
        .collect();
    for part in rest.into_iter().rev() {
        match part.to_str() {
            Some("..") => {
                parts.pop()?;
            }
            Some(".") => {}
            _ => parts.push(part),
        }
    }
    Some(
        std::iter::once(std::ffi::OsString::from("/"))
            .chain(parts)
            .collect(),
    )
}

pub fn inside(path: &Path, folder: &Path) -> bool {
    path.starts_with(folder) && path != folder
}

pub fn registry_claims(pin: &[PinEntry]) -> BTreeMap<String, String> {
    pin.iter()
        .flat_map(|entry| {
            entry
                .reserved_programs
                .iter()
                .map(|program| (program.clone(), entry.name.clone()))
        })
        .collect()
}

pub fn registry_refusal(
    claims: &BTreeMap<String, String>,
    program: &str,
    plugin: &str,
    built_in: bool,
) -> Option<String> {
    let owner = claims.get(program)?;
    (!(built_in && owner == plugin))
        .then(|| format!("{program} belongs to Ardia's official {owner} plugin"))
}

pub fn version_folder_name(version: Option<&str>, approved: &str) -> String {
    let kept: String = version
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .take(48)
        .collect();
    let trimmed = kept.trim_start_matches(['.', '-']);
    let base = if trimmed.is_empty() { "0.0.0" } else { trimmed };
    format!("{base}-{}", &approved[..approved.len().min(12)])
}

fn random_tag() -> String {
    format!("{}-{}", std::process::id(), uuid::Uuid::new_v4().simple())
}

fn is_real_folder(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

fn private_folder(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|m| m.is_dir() && m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o022 == 0)
}

fn real_folder(path: &Path) -> Option<PathBuf> {
    if !is_real_folder(path) {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .ok()?;
    }
    private_folder(path).then(|| path.to_path_buf())
}

struct Held(File);

impl Drop for Held {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn lock_file(places: &Places, name: &str) -> Option<Held> {
    use std::os::fd::AsRawFd;
    real_folder(&places.store)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(places.store.join(name))
        .ok()?;
    (unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0).then_some(Held(file))
}

fn plugin_lock(places: &Places, plugin: &str) -> Option<Held> {
    if !is_name(plugin) {
        return None;
    }
    lock_file(places, &format!(".{plugin}.lock"))
}

fn bin_lock(places: &Places) -> Option<Held> {
    lock_file(places, ".bin.lock")
}

pub fn link_target(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_symlink() {
        return None;
    }
    std::fs::read_link(path)
        .ok()
        .and_then(|t| t.to_str().map(str::to_owned))
}

fn swap_link(folder: &Path, name: &str, target: &str) -> bool {
    let path = folder.join(name);
    if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.file_type().is_symlink()) {
        return false;
    }
    let temporary = folder.join(format!(".{name}.{}", random_tag()));
    if std::os::unix::fs::symlink(target, &temporary).is_err() {
        return false;
    }
    if std::fs::rename(&temporary, &path).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return false;
    }
    true
}

pub fn launcher_owner(target: &[u8], store: &Path) -> Option<String> {
    let mut base = store.as_os_str().as_bytes().to_vec();
    if base.last() != Some(&b'/') {
        base.push(b'/');
    }
    if !target.starts_with(&base) || target.contains(&0) || std::str::from_utf8(target).is_err() {
        return None;
    }
    let parts: Vec<&[u8]> = target[base.len()..].split(|b| *b == b'/').collect();
    if parts.len() < 3
        || parts
            .iter()
            .any(|p| p.is_empty() || *p == b"." || *p == b"..")
        || parts[1] != CURRENT.as_bytes()
    {
        return None;
    }
    let owner = std::str::from_utf8(parts[0]).ok()?;
    is_name(owner).then(|| owner.to_owned())
}

fn is_launcher_path(target: &[u8], store: &Path, plugin: Option<&str>) -> bool {
    launcher_owner(target, store).is_some_and(|owner| plugin.is_none_or(|p| p == owner))
}

pub struct Bin {
    path: PathBuf,
}

fn trusted_ancestor(meta: &std::fs::Metadata) -> bool {
    let uid = unsafe { libc::geteuid() };
    meta.is_dir()
        && (meta.uid() == uid || meta.uid() == 0)
        && (meta.mode() & 0o022 == 0 || meta.mode() & 0o1000 != 0)
}

impl Bin {
    pub fn open(places: &Places, creating: bool) -> Result<Bin, Refusal> {
        let given = places.bin_dir.as_path();
        let shown = given.display().to_string();
        let not_owned = || refusal(format!("{shown} isn't a folder you own"), Cause::BinFolder);
        let outside = || refusal(SCRATCH_OUTSIDE, Cause::BinFolder);
        if !given.is_absolute() {
            return Err(not_owned());
        }
        if let Some(confined) = &places.confined
            && !resolved(given).is_some_and(|b| inside(&b, confined))
        {
            return Err(outside());
        }
        if creating && std::fs::symlink_metadata(given).is_err() {
            let _ = std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o755)
                .create(given);
        }
        let real = std::fs::canonicalize(given).map_err(|_| not_owned())?;
        if let Some(confined) = &places.confined
            && !inside(&real, confined)
        {
            return Err(outside());
        }
        let meta = std::fs::metadata(&real).map_err(|_| not_owned())?;
        if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
            return Err(not_owned());
        }
        let shared = || {
            refusal(
                format!("{shown} is inside a folder other users can change"),
                Cause::BinShared,
            )
        };
        if meta.mode() & 0o022 != 0 {
            return Err(shared());
        }
        for ancestor in real.ancestors().skip(1) {
            let meta = std::fs::metadata(ancestor).map_err(|_| not_owned())?;
            if !trusted_ancestor(&meta) {
                return Err(shared());
            }
        }
        Ok(Bin { path: real })
    }

    fn entry(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    fn exists(&self, name: &str) -> Option<bool> {
        match std::fs::symlink_metadata(self.entry(name)) {
            Ok(_) => Some(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(false),
            Err(_) => None,
        }
    }

    fn target_bytes(&self, name: &str) -> Option<Vec<u8>> {
        let path = self.entry(name);
        if !std::fs::symlink_metadata(&path)
            .ok()?
            .file_type()
            .is_symlink()
        {
            return None;
        }
        std::fs::read_link(path)
            .ok()
            .map(|t| t.as_os_str().as_bytes().to_vec())
    }

    fn leads_nowhere(&self, name: &str) -> bool {
        self.target_bytes(name).is_some() && std::fs::metadata(self.entry(name)).is_err()
    }

    fn is_same_file(&self, name: &str, other: &Path) -> bool {
        match (
            std::fs::metadata(self.entry(name)),
            std::fs::metadata(other),
        ) {
            (Ok(here), Ok(there)) => here.dev() == there.dev() && here.ino() == there.ino(),
            _ => false,
        }
    }

    fn names(&self) -> Vec<String> {
        std::fs::read_dir(&self.path)
            .map(|dir| {
                dir.filter_map(|e| e.ok()?.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn create(&self, name: &str, target: &Path) -> bool {
        std::os::unix::fs::symlink(target, self.entry(name)).is_ok()
    }

    fn swap(&self, name: &str, target: &[u8]) -> bool {
        let temporary = self.path.join(format!(".{name}.{}", random_tag()));
        let target = Path::new(std::ffi::OsStr::from_bytes(target));
        if std::os::unix::fs::symlink(target, &temporary).is_err() {
            return false;
        }
        if std::fs::rename(&temporary, self.entry(name)).is_err() {
            let _ = std::fs::remove_file(&temporary);
            return false;
        }
        true
    }

    fn remove(&self, name: &str) -> bool {
        std::fs::remove_file(self.entry(name)).is_ok()
    }

    fn links_into_store(&self, places: &Places) -> Vec<(String, Vec<u8>)> {
        self.names()
            .into_iter()
            .filter(|name| is_name(name))
            .filter_map(|name| {
                let target = self.target_bytes(&name)?;
                is_launcher_path(&target, &places.store, None).then_some((name, target))
            })
            .collect()
    }
}

pub fn link_target_path(program: &Program, plugin: &str, places: &Places) -> PathBuf {
    places
        .plugin_store(plugin)
        .join(CURRENT)
        .join(&program.path)
}

fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.mode() & 0o111 != 0)
}

pub fn link_problem(
    program: &Program,
    plugin: &str,
    places: &Places,
    bin: &Result<Bin, Refusal>,
) -> Option<Refusal> {
    if !is_name(&program.name) {
        return Some(refusal(
            format!("{} isn't a program name", program.name),
            Cause::Name,
        ));
    }
    let bin = match bin {
        Ok(bin) => bin,
        Err(refused) => return Some(refused.clone()),
    };
    if let Some(hidden) = places
        .shadowable
        .iter()
        .map(|dir| dir.join(&program.name))
        .find(|path| is_executable_file(path))
    {
        return Some(refusal(
            format!(
                "{} would hide {}, so it isn't put on PATH",
                program.name,
                hidden.display()
            ),
            Cause::Shadowed,
        ));
    }
    let path = places.bin_dir.join(&program.name);
    let target = link_target_path(program, plugin, places);
    let Some(present) = bin.exists(&program.name) else {
        return Some(refusal(
            format!("{} couldn't be checked", path.display()),
            Cause::Io,
        ));
    };
    if !present {
        return None;
    }
    let taken = refusal(
        format!(
            "{} is someone else's; remove it to use this one",
            path.display()
        ),
        Cause::Taken,
    );
    let Some(existing) = bin.target_bytes(&program.name) else {
        return Some(taken);
    };
    if existing == target.as_os_str().as_bytes()
        || is_launcher_path(&existing, &places.store, Some(plugin))
    {
        return None;
    }
    if (bin.leads_nowhere(&program.name) && is_launcher_path(&existing, &places.store, None))
        || bin.is_same_file(&program.name, &target)
    {
        return None;
    }
    if let Some(other) = launcher_owner(&existing, &places.store) {
        return Some(refusal(
            format!(
                "{} comes from the {other} plugin; turn that one off to use this one",
                program.name
            ),
            Cause::OtherPlugin,
        ));
    }
    Some(taken)
}

fn link_one(
    program: &Program,
    plugin: &str,
    places: &Places,
    bin: &Result<Bin, Refusal>,
) -> Option<Refusal> {
    if let Some(problem) = link_problem(program, plugin, places, bin) {
        return Some(problem);
    }
    let Ok(bin) = bin else {
        return None;
    };
    let failed = refusal(
        format!(
            "{} couldn't be linked",
            places.bin_dir.join(&program.name).display()
        ),
        Cause::Io,
    );
    let target = link_target_path(program, plugin, places);
    match bin.exists(&program.name) {
        None => Some(failed),
        Some(false) => (!bin.create(&program.name, &target)).then_some(failed),
        Some(true) => {
            if bin.target_bytes(&program.name).as_deref() == Some(target.as_os_str().as_bytes()) {
                return None;
            }
            (!bin.swap(&program.name, target.as_os_str().as_bytes())).then_some(failed)
        }
    }
}

fn unlink_others(plugin: &str, keeping: &BTreeSet<String>, places: &Places, bin: &Bin) {
    for (name, target) in bin.links_into_store(places) {
        if !keeping.contains(&name) && is_launcher_path(&target, &places.store, Some(plugin)) {
            bin.remove(&name);
        }
    }
}

fn read_manifest(folder: &Path) -> Option<String> {
    let path = folder.join(MANIFEST_FILE);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MANIFEST_LIMIT {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn local_program(folder: &Path, relative: &str) -> bool {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return false;
    }
    let mut current = folder.to_path_buf();
    for part in path.components() {
        current.push(part);
        if std::fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
            return false;
        }
    }
    std::fs::symlink_metadata(&current).is_ok_and(|m| m.is_file() && m.mode() & 0o111 != 0)
}

fn copy_tree(source: &Path, destination: &Path, relative: &str) -> Result<(), String> {
    let shown = |name: &str| {
        if relative.is_empty() {
            name.to_owned()
        } else {
            format!("{relative}/{name}")
        }
    };
    let here = if relative.is_empty() {
        "its folder"
    } else {
        relative
    };
    let mut names: Vec<String> = std::fs::read_dir(source)
        .map_err(|_| format!("{here} couldn't be read"))?
        .filter_map(|e| e.ok().map(|e| e.file_name()))
        .map(|n| n.to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in names {
        let label = shown(&name);
        if name.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) {
            return Err(format!("a name in {here} has control characters"));
        }
        if relative.is_empty() && RESERVED.contains(&name.to_lowercase().as_str()) {
            return Err(format!("{label} is reserved for Ardia"));
        }
        let from = source.join(&name);
        let meta =
            std::fs::symlink_metadata(&from).map_err(|_| format!("{label} couldn't be read"))?;
        if name == CACHES && meta.is_dir() {
            continue;
        }
        let to = destination.join(&name);
        if meta.file_type().is_symlink() {
            return Err(format!(
                "{label} is a link; a plugin's programs may not contain links"
            ));
        } else if meta.is_dir() {
            std::fs::DirBuilder::new()
                .mode(0o755)
                .create(&to)
                .map_err(|e| format!("{label} couldn't be copied ({e})"))?;
            copy_tree(&from, &to, &label)?;
        } else if meta.is_file() {
            if meta.nlink() != 1 {
                return Err(format!(
                    "{label} is a hard link; a plugin's programs may not contain links"
                ));
            }
            let mut input = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&from)
                .map_err(|_| format!("{label} couldn't be read"))?;
            let opened = input
                .metadata()
                .map_err(|_| format!("{label} couldn't be read"))?;
            if !opened.is_file() || opened.ino() != meta.ino() || opened.dev() != meta.dev() {
                return Err(format!("{label} changed while it was copied"));
            }
            let mode = meta.mode() & 0o755;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(mode)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&to)
                .map_err(|e| format!("{label} couldn't be copied ({e})"))?;
            std::io::copy(&mut input, &mut output)
                .map_err(|e| format!("{label} couldn't be copied ({e})"))?;
            output
                .set_permissions(std::fs::Permissions::from_mode(mode))
                .map_err(|e| format!("{label} couldn't be copied ({e})"))?;
        } else {
            return Err(format!("{label} isn't a file or a folder"));
        }
    }
    Ok(())
}

fn check_tree(folder: &Path, root: bool) -> bool {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return false;
    };
    entries.flatten().all(|entry| {
        let name = entry.file_name();
        if root && RESERVED.contains(&name.to_string_lossy().as_ref()) {
            return true;
        }
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            return false;
        };
        if meta.is_dir() {
            check_tree(&entry.path(), false)
        } else {
            meta.is_file() && meta.nlink() == 1 && meta.mode() & 0o7022 == 0
        }
    })
}

fn holds_approved(folder: &Path, folder_id: &str, approved: &str, programs: &[Program]) -> bool {
    is_real_folder(folder)
        && read_manifest(folder).is_some_and(|text| approval_hash(&text, folder_id) == approved)
        && check_tree(folder, true)
        && programs.iter().all(|p| local_program(folder, &p.path))
}

fn seal_keeping_root(root: &Path) -> bool {
    fn walk(path: &Path, is_root: bool) -> bool {
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            return false;
        };
        if meta.file_type().is_symlink() {
            return false;
        }
        if meta.is_dir() {
            let Ok(entries) = std::fs::read_dir(path) else {
                return false;
            };
            for entry in entries.flatten() {
                if !walk(&entry.path(), false) {
                    return false;
                }
            }
        }
        if is_root {
            return true;
        }
        let mode = if meta.is_dir() || meta.mode() & 0o111 != 0 {
            0o555
        } else {
            0o444
        };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).is_ok()
    }
    walk(root, true)
}

fn stage(
    folder: &Path,
    plugin_store: &Path,
    folder_id: &str,
    approved: &str,
    programs: &[Program],
) -> Result<PathBuf, String> {
    let staged = plugin_store.join(format!(".stage-{}", random_tag()));
    std::fs::DirBuilder::new()
        .mode(0o755)
        .create(&staged)
        .map_err(|_| "its programs couldn't be staged".to_owned())?;
    let refuse = |reason: String| {
        discard(&staged);
        Err(reason)
    };
    if let Err(problem) = copy_tree(folder, &staged, "") {
        return refuse(problem);
    }
    if read_manifest(&staged).is_none_or(|text| approval_hash(&text, folder_id) != approved) {
        return refuse("its plugin.json changed since you approved it".into());
    }
    if let Some(program) = programs.iter().find(|p| !local_program(&staged, &p.path)) {
        return refuse(format!(
            "its program {} isn't an executable file in its folder",
            program.path
        ));
    }
    if !seal_keeping_root(&staged) {
        return refuse("its programs couldn't be made read-only".into());
    }
    if std::fs::DirBuilder::new()
        .mode(0o700)
        .create(staged.join(LEASES))
        .is_err()
    {
        return refuse("its programs' lease folder couldn't be made".into());
    }
    Ok(staged)
}

fn is_leased(version_folder: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(version_folder.join(LEASES)) else {
        return false;
    };
    let mut live = false;
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<i32>().ok())
            .filter(|p| *p > 0)
        else {
            continue;
        };
        if unsafe { libc::kill(pid, 0) } == 0 {
            live = true;
        } else {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    live
}

fn older_than(path: &Path, seconds: i64) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        now - m.mtime() > seconds
    })
}

fn sweep_locked(plugin: &str, places: &Places, keep_current: bool) {
    let plugin_store = places.plugin_store(plugin);
    let Ok(entries) = std::fs::read_dir(&plugin_store) else {
        return;
    };
    let mut keep = BTreeSet::new();
    if keep_current {
        for link in [CURRENT, PREVIOUS] {
            if let Some(target) = link_target(&plugin_store.join(link)) {
                keep.insert(target);
            }
        }
    }
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name == CURRENT || name == PREVIOUS || keep.contains(&name) || name.ends_with(".lock") {
            continue;
        }
        let path = entry.path();
        if name.starts_with(".stage-") || name.starts_with(".trash-") {
            if name.starts_with(".trash-") || older_than(&path, STALE_SECONDS) {
                discard(&path);
            }
            continue;
        }
        if is_real_folder(&path) && !is_leased(&path) {
            discard(&path);
        }
    }
}

pub fn install(
    plugin: &str,
    folder: &Path,
    folder_id: &str,
    approved: &str,
    version: Option<&str>,
    programs: &[Program],
    places: &Places,
) -> Result<Linked, String> {
    let Some(_held) = plugin_lock(places, plugin) else {
        return Err("its program folder couldn't be locked".into());
    };
    let store_shown = places.plugin_store(plugin).display().to_string();
    let Some(plugin_store) = real_folder(&places.plugin_store(plugin)) else {
        return Err(format!(
            "its program folder ({store_shown}) isn't a folder you own"
        ));
    };
    if !private_folder(&places.store) {
        return Err(format!(
            "its program folder ({store_shown}) is inside a folder other users can change"
        ));
    }
    let base = version_folder_name(version, approved);
    let mut reusable = vec![base.clone()];
    let mut rebuilt: Vec<String> = std::fs::read_dir(&plugin_store)
        .map(|dir| {
            dir.filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|n| n.starts_with(&format!("{base}-r")))
                .collect()
        })
        .unwrap_or_default();
    rebuilt.sort();
    reusable.extend(rebuilt);
    let name = match reusable
        .iter()
        .find(|n| holds_approved(&plugin_store.join(n), folder_id, approved, programs))
    {
        Some(found) => found.clone(),
        None => {
            let name = if std::fs::symlink_metadata(plugin_store.join(&base)).is_ok() {
                format!(
                    "{base}-r{}",
                    &uuid::Uuid::new_v4().simple().to_string()[..7]
                )
            } else {
                base
            };
            let staged = stage(folder, &plugin_store, folder_id, approved, programs)?;
            let target = plugin_store.join(&name);
            if std::fs::symlink_metadata(&target).is_ok()
                || std::fs::rename(&staged, &target).is_err()
            {
                discard(&staged);
                return Err("its programs couldn't be put in place".into());
            }
            name
        }
    };
    let before = link_target(&plugin_store.join(CURRENT));
    let replacing = before
        .as_ref()
        .is_some_and(|b| *b != name && is_real_folder(&plugin_store.join(b)));
    let Some(_bin_held) = bin_lock(places) else {
        let refused = programs
            .iter()
            .map(|p| {
                (
                    p.name.clone(),
                    refusal(
                        format!("{} couldn't be locked", places.bin_dir.display()),
                        Cause::Busy,
                    ),
                )
            })
            .collect();
        return Ok(Linked {
            version: name,
            linked: Vec::new(),
            refused,
            kept: if replacing { before } else { None },
        });
    };
    let bin = Bin::open(places, true);
    if replacing {
        let held: BTreeMap<String, Refusal> = programs
            .iter()
            .filter_map(|p| link_problem(p, plugin, places, &bin).map(|r| (p.name.clone(), r)))
            .collect();
        if !held.is_empty() {
            return Ok(Linked {
                version: name,
                linked: Vec::new(),
                refused: held,
                kept: before,
            });
        }
    }
    let snapshot: BTreeMap<String, Option<Vec<u8>>> = programs
        .iter()
        .map(|p| {
            (
                p.name.clone(),
                bin.as_ref().ok().and_then(|b| b.target_bytes(&p.name)),
            )
        })
        .collect();
    if !swap_link(&plugin_store, CURRENT, &name) {
        return Err("its programs couldn't be switched to the new version".into());
    }
    let mut linked = Vec::new();
    let mut refused = BTreeMap::new();
    for program in programs {
        match link_one(program, plugin, places, &bin) {
            Some(problem) => {
                refused.insert(program.name.clone(), problem);
            }
            None => linked.push(program.name.clone()),
        }
    }
    if replacing && !refused.is_empty() {
        let before = before.unwrap_or_default();
        let mut restored = swap_link(&plugin_store, CURRENT, &before);
        for program in &linked {
            let Ok(bin) = &bin else {
                restored = false;
                continue;
            };
            match snapshot.get(program).cloned().flatten() {
                Some(target) => {
                    if bin.target_bytes(program).as_deref() != Some(target.as_slice())
                        && !bin.swap(program, &target)
                    {
                        restored = false;
                    }
                }
                None => {
                    if !bin.remove(program) {
                        restored = false;
                    }
                }
            }
        }
        if !restored {
            let first = refused
                .values()
                .next()
                .map_or("a program was refused".to_owned(), |r| r.reason.clone());
            return Err(format!(
                "{first}, and the earlier version couldn't be put back on PATH"
            ));
        }
        return Ok(Linked {
            version: name,
            linked: Vec::new(),
            refused,
            kept: Some(before),
        });
    }
    if let Some(before) = before.filter(|b| *b != name) {
        swap_link(&plugin_store, PREVIOUS, &before);
    }
    if let Ok(bin) = &bin {
        let keeping = programs.iter().map(|p| p.name.clone()).collect();
        unlink_others(plugin, &keeping, places, bin);
    }
    sweep_locked(plugin, places, true);
    Ok(Linked {
        version: name,
        linked,
        refused,
        kept: None,
    })
}

fn unlink_plugin(plugin: &str, places: &Places) {
    if let Some(_bin_held) = bin_lock(places)
        && let Ok(bin) = Bin::open(places, false)
    {
        unlink_others(plugin, &BTreeSet::new(), places, &bin);
    }
}

fn withdraw_locked(plugin: &str, places: &Places) {
    unlink_plugin(plugin, places);
    let plugin_store = places.plugin_store(plugin);
    if !is_real_folder(&plugin_store) {
        return;
    }
    for link in [CURRENT, PREVIOUS] {
        let path = plugin_store.join(link);
        if link_target(&path).is_some() {
            let _ = std::fs::remove_file(path);
        }
    }
    sweep_locked(plugin, places, false);
}

pub fn withdraw(plugin: &str, places: &Places, keep_copy: bool) {
    let Some(_held) = plugin_lock(places, plugin) else {
        return;
    };
    if keep_copy {
        unlink_plugin(plugin, places);
        return;
    }
    withdraw_locked(plugin, places);
}

pub fn remove(plugin: &str, places: &Places) -> bool {
    let Some(_held) = plugin_lock(places, plugin) else {
        return false;
    };
    withdraw_locked(plugin, places);
    let plugin_store = places.plugin_store(plugin);
    if !is_real_folder(&plugin_store) {
        return true;
    }
    let left_only_hidden = std::fs::read_dir(&plugin_store).is_ok_and(|dir| {
        dir.flatten()
            .all(|e| e.file_name().to_string_lossy().starts_with('.'))
    });
    if !left_only_hidden {
        return false;
    }
    discard(&plugin_store);
    true
}

pub fn withdraw_all_but(
    active: &BTreeSet<String>,
    places: &Places,
    keeping_copies: &BTreeSet<String>,
) {
    if let Some(_bin_held) = bin_lock(places)
        && let Ok(bin) = Bin::open(places, false)
    {
        for (name, target) in bin.links_into_store(places) {
            if launcher_owner(&target, &places.store).is_some_and(|owner| !active.contains(&owner))
            {
                bin.remove(&name);
            }
        }
    }
    let plugins: Vec<String> = std::fs::read_dir(&places.store)
        .map(|dir| {
            dir.filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|n| is_name(n) && !active.contains(n))
                .collect()
        })
        .unwrap_or_default();
    for plugin in plugins {
        if is_real_folder(&places.plugin_store(&plugin)) {
            withdraw(&plugin, places, keeping_copies.contains(&plugin));
        }
    }
}

#[cfg(test)]
pub mod tests;
