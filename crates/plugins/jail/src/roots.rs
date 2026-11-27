use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use crate::sys;

type Identity = (u64, u64);

fn parent(fd: RawFd) -> io::Result<OwnedFd> {
    sys::openat(fd, Path::new(".."), libc::O_PATH | libc::O_DIRECTORY, 0)
}

pub fn ancestors(fd: RawFd) -> io::Result<Vec<Identity>> {
    let mut chain = vec![sys::identity(fd)?];
    let mut current = parent(fd)?;
    loop {
        let id = sys::identity(current.as_raw_fd())?;
        if chain.last() == Some(&id) {
            return Ok(chain);
        }
        chain.push(id);
        if chain.len() > 4096 {
            return Err(sys::invalid("a folder is nested too deeply"));
        }
        current = parent(current.as_raw_fd())?;
    }
}

pub fn contains(outer: RawFd, inner: RawFd) -> io::Result<bool> {
    let outer = sys::identity(outer)?;
    Ok(ancestors(inner)?.contains(&outer))
}

pub fn strictly_contains(outer: RawFd, inner: RawFd) -> io::Result<bool> {
    Ok(sys::identity(outer)? != sys::identity(inner)? && contains(outer, inner)?)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal(pub String);

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub struct Granted<'a> {
    pub plugin: RawFd,
    pub data: Option<RawFd>,
    pub program: Option<RawFd>,
    pub plugin_parents: &'a [OwnedFd],
    pub forbidden: &'a [OwnedFd],
}

fn io_refusal(error: io::Error) -> Refusal {
    Refusal(format!("a folder couldn't be checked: {error}"))
}

pub fn check(granted: &Granted<'_>) -> Result<ProgramPlacement, Refusal> {
    let root = sys::open_dir(Path::new("/")).map_err(io_refusal)?;
    let named: Vec<(&str, RawFd)> = [
        ("the plugin folder", Some(granted.plugin)),
        ("the plugin's data", granted.data),
        ("the program's folder", granted.program),
    ]
    .into_iter()
    .filter_map(|(name, fd)| fd.map(|fd| (name, fd)))
    .collect();
    for (name, fd) in &named {
        if contains(*fd, root.as_raw_fd()).map_err(io_refusal)? {
            return Err(Refusal(format!("{name} would take in the whole disk")));
        }
        for forbidden in granted.forbidden {
            if contains(*fd, forbidden.as_raw_fd()).map_err(io_refusal)? {
                let place = sys::fd_path(forbidden.as_raw_fd())
                    .map(|p| p.display().to_string())
                    .unwrap_or_default();
                return Err(Refusal(format!("{name} would take in {place}")));
            }
        }
    }
    let mut inside_a_parent = false;
    for parent_fd in granted.plugin_parents {
        if strictly_contains(parent_fd.as_raw_fd(), granted.plugin).map_err(io_refusal)? {
            inside_a_parent = true;
        }
    }
    if !inside_a_parent {
        return Err(Refusal(
            "the plugin folder isn't inside the plugins folder or the built-in plugins".into(),
        ));
    }
    if let Some(data) = granted.data {
        if contains(data, granted.plugin).map_err(io_refusal)?
            || contains(granted.plugin, data).map_err(io_refusal)?
        {
            return Err(Refusal("the plugin folder and its data overlap".into()));
        }
    }
    let Some(program) = granted.program else {
        return Ok(ProgramPlacement::None);
    };
    if let Some(data) = granted.data {
        if contains(data, program).map_err(io_refusal)?
            || contains(program, data).map_err(io_refusal)?
        {
            return Err(Refusal(
                "the program's folder and the plugin's data overlap".into(),
            ));
        }
    }
    if strictly_contains(program, granted.plugin).map_err(io_refusal)? {
        return Err(Refusal(
            "the program's folder takes in the plugin folder".into(),
        ));
    }
    if contains(granted.plugin, program).map_err(io_refusal)? {
        return Ok(ProgramPlacement::InsidePluginFolder);
    }
    let usr = sys::open_dir(Path::new("/usr")).map_err(io_refusal)?;
    if contains(usr.as_raw_fd(), program).map_err(io_refusal)? {
        return Ok(ProgramPlacement::InsideUsr);
    }
    Ok(ProgramPlacement::Separate)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramPlacement {
    None,
    InsidePluginFolder,
    InsideUsr,
    Separate,
}

fn unescape_mount_path(bytes: &[u8]) -> PathBuf {
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\\'
            && at + 3 < bytes.len()
            && bytes[at + 1..at + 4]
                .iter()
                .all(|b| (b'0'..=b'7').contains(b))
        {
            let value = (bytes[at + 1] - b'0') as u32 * 64
                + (bytes[at + 2] - b'0') as u32 * 8
                + (bytes[at + 3] - b'0') as u32;
            out.push(value as u8);
            at += 4;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    PathBuf::from(std::ffi::OsString::from_vec(out))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountEntry {
    pub id: u64,
    pub parent: u64,
    pub point: PathBuf,
    pub options: Vec<Vec<u8>>,
    pub tags: Vec<Vec<u8>>,
}

impl MountEntry {
    pub fn read_only(&self) -> bool {
        self.options.iter().any(|option| option == b"ro")
    }

    pub fn propagates(&self) -> bool {
        self.tags.iter().any(|tag| {
            tag.starts_with(b"shared:")
                || tag.starts_with(b"master:")
                || tag.starts_with(b"propagate_from:")
        })
    }
}

pub fn parse_mountinfo(data: &[u8]) -> io::Result<Vec<MountEntry>> {
    let mut entries = Vec::new();
    for line in data.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
        let fields: Vec<&[u8]> = line.split(|b| *b == b' ').collect();
        let separator = fields
            .iter()
            .position(|field| *field == b"-")
            .ok_or_else(|| sys::invalid("a mountinfo line has no separator"))?;
        if separator < 6 {
            return Err(sys::invalid("a mountinfo line is too short"));
        }
        let number = |field: &[u8]| -> io::Result<u64> {
            std::str::from_utf8(field)
                .ok()
                .and_then(|text| text.parse().ok())
                .ok_or_else(|| sys::invalid("a mountinfo id isn't a number"))
        };
        entries.push(MountEntry {
            id: number(fields[0])?,
            parent: number(fields[1])?,
            point: unescape_mount_path(fields[4]),
            options: fields[5]
                .split(|b| *b == b',')
                .map(<[u8]>::to_vec)
                .collect(),
            tags: fields[6..separator]
                .iter()
                .map(|tag| tag.to_vec())
                .collect(),
        });
    }
    Ok(entries)
}

pub fn read_mountinfo() -> io::Result<Vec<MountEntry>> {
    parse_mountinfo(&std::fs::read("/proc/self/mountinfo")?)
}

pub fn mount_points() -> io::Result<Vec<PathBuf>> {
    Ok(read_mountinfo()?
        .into_iter()
        .map(|entry| entry.point)
        .collect())
}

pub fn mounts_beneath(root: &Path) -> io::Result<Vec<PathBuf>> {
    Ok(mount_points()?
        .into_iter()
        .filter(|point| point != root && point.starts_with(root))
        .collect())
}

pub fn refuse_nested_mounts(name: &str, fd: RawFd) -> Result<(), Refusal> {
    let root = sys::fd_path(fd).map_err(io_refusal)?;
    let nested = mounts_beneath(&root).map_err(io_refusal)?;
    match nested.first() {
        None => Ok(()),
        Some(point) => Err(Refusal(format!(
            "a filesystem is mounted inside {name} at {}",
            point.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::ffi::OsStrExt;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jail-roots-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn dir(path: &Path) -> OwnedFd {
        fs::create_dir_all(path).unwrap();
        sys::open_dir(path).unwrap()
    }

    #[test]
    fn mount_points_are_unescaped_and_matched_below_a_root() {
        assert_eq!(unescape_mount_path(b"/a\\040b"), PathBuf::from("/a b"));
        let entries = parse_mountinfo(
            b"22 1 0:21 / /run/ardia/plugin ro,nosuid master:7 - ext4 /dev/vda1 rw\n23 22 0:22 / /odd\\377name rw shared:3 propagate_from:2 - tmpfs t rw\n24 1 0:23 / /plain rw - tmpfs t rw\n",
        )
        .unwrap();
        assert_eq!(entries.len(), 3);
        assert!(entries[0].read_only() && entries[0].propagates());
        assert_eq!(entries[1].parent, 22);
        assert_eq!(entries[1].point.as_os_str().as_bytes(), b"/odd\xffname");
        assert!(!entries[2].read_only() && !entries[2].propagates());
        assert!(parse_mountinfo(b"bad line\n").is_err());
        assert!(mount_points().unwrap().contains(&PathBuf::from("/")));
        assert!(mounts_beneath(Path::new("/"))
            .unwrap()
            .iter()
            .any(|p| p == Path::new("/proc")));
        assert!(!mounts_beneath(Path::new("/proc"))
            .unwrap()
            .contains(&PathBuf::from("/proc")));
    }

    #[test]
    fn containment_follows_the_real_tree() {
        let base = scratch("contain");
        let outer = dir(&base.join("a"));
        let inner = dir(&base.join("a/b/c"));
        let other = dir(&base.join("d"));
        assert!(contains(outer.as_raw_fd(), inner.as_raw_fd()).unwrap());
        assert!(!contains(inner.as_raw_fd(), outer.as_raw_fd()).unwrap());
        assert!(!contains(other.as_raw_fd(), inner.as_raw_fd()).unwrap());
        assert!(contains(outer.as_raw_fd(), outer.as_raw_fd()).unwrap());
        assert!(!strictly_contains(outer.as_raw_fd(), outer.as_raw_fd()).unwrap());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn plugin_folders_that_take_in_home_or_leave_the_plugins_folder_are_refused() {
        let base = scratch("refuse");
        let home = dir(&base.join("home"));
        let plugins = dir(&base.join("home/.config/ardia/plugins"));
        let good = dir(&base.join("home/.config/ardia/plugins/good"));
        let data = dir(&base.join("home/.local/share/ardia/PluginData/good"));
        let stray = dir(&base.join("elsewhere/plugin"));
        let parents = vec![plugins];
        let forbidden = vec![home];
        let ok = Granted {
            plugin: good.as_raw_fd(),
            data: Some(data.as_raw_fd()),
            program: None,
            plugin_parents: &parents,
            forbidden: &forbidden,
        };
        assert_eq!(check(&ok), Ok(ProgramPlacement::None));
        let takes_home = Granted {
            plugin: forbidden[0].as_raw_fd(),
            ..ok
        };
        assert!(check(&takes_home).is_err());
        let wanders = Granted {
            plugin: stray.as_raw_fd(),
            ..ok
        };
        assert!(check(&wanders).unwrap_err().0.contains("isn't inside"));
        let plugins_itself = Granted {
            plugin: parents[0].as_raw_fd(),
            ..ok
        };
        assert!(check(&plugins_itself).is_err());
        let data_inside_plugin = dir(&base.join("home/.config/ardia/plugins/good/data"));
        let overlapping = Granted {
            data: Some(data_inside_plugin.as_raw_fd()),
            ..ok
        };
        assert!(check(&overlapping).unwrap_err().0.contains("overlap"));
        let program_root = sys::open_dir(Path::new("/")).unwrap();
        let whole_disk = Granted {
            program: Some(program_root.as_raw_fd()),
            ..ok
        };
        assert!(check(&whole_disk).unwrap_err().0.contains("whole disk"));
        fs::remove_dir_all(base).unwrap();
    }
}
