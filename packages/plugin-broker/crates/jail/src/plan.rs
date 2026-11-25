use std::ffi::{OsStr, OsString};
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};

use crate::frame::{MountCheck, Rule, Target};
use crate::landlock::{
    DEVICE_READ, DEVICE_READ_WRITE, EXECUTE, READ, READ_EXECUTE, READ_FILE, READ_WRITE,
};
use crate::{
    RunKind, BROKER_PATH_IN_JAIL, DATA_IN_JAIL, EXEC_STAGE_IN_JAIL, PLUGIN_IN_JAIL, PROGRAM_IN_JAIL,
};

pub const TMP_BYTES: u64 = 64 << 20;

const USR_LINKS: &[&str] = &["/bin", "/sbin", "/lib", "/lib64", "/lib32"];

const ETC_ENTRIES: &[&str] = &[
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/localtime",
    "/etc/os-release",
    "/etc/alternatives",
    "/etc/ssl",
    "/etc/ca-certificates",
    "/etc/pki",
    "/etc/gai.conf",
    "/etc/host.conf",
];

const DEVICES_READ_WRITE: &[&str] = &["/dev/null", "/dev/zero", "/dev/full", "/dev/tty"];
const DEVICES_READ: &[&str] = &["/dev/random", "/dev/urandom"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    System,
    Fd { fd: RawFd, writable: bool },
    Tmpfs { bytes: u64 },
    Proc,
    Dev,
    Symlink(PathBuf),
    Present,
    Dir,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub dest: PathBuf,
    pub source: Source,
    pub rights: u64,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub entries: Vec<Entry>,
}

#[derive(Clone, Debug)]
pub struct Input {
    pub kind: RunKind,
    pub plugin: RawFd,
    pub data: Option<RawFd>,
    pub program_folder: Option<RawFd>,
    pub program_file: Option<(RawFd, PathBuf)>,
    pub broker: RawFd,
}

fn system(dest: &str, rights: u64) -> Entry {
    Entry {
        dest: dest.into(),
        source: Source::System,
        rights,
    }
}

fn sidecar_only(kind: RunKind, rights: u64) -> u64 {
    if kind == RunKind::Sidecar {
        rights
    } else {
        0
    }
}

pub fn system_entries(kind: RunKind) -> Vec<Entry> {
    let mut entries = vec![system("/usr", sidecar_only(kind, READ_EXECUTE))];
    for link in USR_LINKS {
        let path = Path::new(link);
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                if let Ok(target) = std::fs::read_link(path) {
                    entries.push(Entry {
                        dest: path.into(),
                        source: Source::Symlink(target),
                        rights: 0,
                    });
                }
            }
            Ok(meta) if meta.is_dir() => {
                entries.push(system(link, sidecar_only(kind, READ_EXECUTE)))
            }
            _ => {}
        }
    }
    for item in ETC_ENTRIES {
        if Path::new(item).exists() {
            entries.push(system(item, sidecar_only(kind, READ)));
        }
    }
    entries
}

pub fn build(input: &Input) -> Plan {
    let kind = input.kind;
    let mut entries = system_entries(kind);
    entries.push(Entry {
        dest: "/tmp".into(),
        source: Source::Tmpfs { bytes: TMP_BYTES },
        rights: sidecar_only(kind, READ_WRITE),
    });
    entries.push(Entry {
        dest: "/proc".into(),
        source: Source::Proc,
        rights: sidecar_only(kind, READ),
    });
    entries.push(Entry {
        dest: "/dev".into(),
        source: Source::Dev,
        rights: 0,
    });
    for device in DEVICES_READ_WRITE {
        entries.push(Entry {
            dest: device.into(),
            source: Source::Present,
            rights: sidecar_only(kind, DEVICE_READ_WRITE),
        });
    }
    for device in DEVICES_READ {
        entries.push(Entry {
            dest: device.into(),
            source: Source::Present,
            rights: sidecar_only(kind, DEVICE_READ),
        });
    }
    let mut bind = |dest: &str, fd: RawFd, writable: bool, rights: u64| {
        entries.push(Entry {
            dest: dest.into(),
            source: Source::Fd { fd, writable },
            rights,
        })
    };
    bind(
        BROKER_PATH_IN_JAIL,
        input.broker,
        false,
        sidecar_only(kind, READ_FILE | EXECUTE),
    );
    let plugin_rights = match kind {
        RunKind::Host => READ,
        RunKind::Sidecar => READ_EXECUTE,
    };
    bind(PLUGIN_IN_JAIL, input.plugin, false, plugin_rights);
    if let Some(data) = input.data {
        bind(DATA_IN_JAIL, data, true, sidecar_only(kind, READ_WRITE));
    }
    if let Some(folder) = input.program_folder {
        bind(
            PROGRAM_IN_JAIL,
            folder,
            false,
            sidecar_only(kind, READ_EXECUTE),
        );
    }
    if kind == RunKind::Sidecar {
        entries.push(Entry {
            dest: EXEC_STAGE_IN_JAIL.into(),
            source: Source::Dir,
            rights: 0,
        });
    }
    if let Some((fd, dest)) = &input.program_file {
        entries.push(Entry {
            dest: dest.clone(),
            source: Source::Fd {
                fd: *fd,
                writable: false,
            },
            rights: READ_FILE | EXECUTE,
        });
    }
    Plan { entries }
}

impl Plan {
    pub fn mount_checks(&self) -> Vec<MountCheck> {
        self.entries
            .iter()
            .filter_map(|entry| {
                let writable = match entry.source {
                    Source::System => false,
                    Source::Tmpfs { .. } => true,
                    Source::Fd { writable, .. } => writable,
                    _ => return None,
                };
                Some(MountCheck {
                    path: entry.dest.clone(),
                    writable,
                })
            })
            .collect()
    }

    pub fn bwrap_mounts(&self) -> Vec<OsString> {
        let mut args: Vec<OsString> = Vec::new();
        let mut push = |items: &[&OsStr]| args.extend(items.iter().map(|item| item.to_os_string()));
        for entry in &self.entries {
            let dest = entry.dest.as_os_str();
            let os = |text: &str| OsString::from(text);
            match &entry.source {
                Source::System => push(&[&os("--ro-bind"), dest, dest]),
                Source::Fd { fd, writable } => {
                    let flag = if *writable {
                        "--bind-fd"
                    } else {
                        "--ro-bind-fd"
                    };
                    push(&[&os(flag), &os(&fd.to_string()), dest]);
                }
                Source::Tmpfs { bytes } => {
                    push(&[&os("--size"), &os(&bytes.to_string()), &os("--tmpfs"), dest])
                }
                Source::Proc => push(&[&os("--proc"), dest]),
                Source::Dev => push(&[&os("--dev"), dest]),
                Source::Symlink(target) => push(&[&os("--symlink"), target.as_os_str(), dest]),
                Source::Present => {}
                Source::Dir => push(&[&os("--dir"), dest]),
            }
        }
        args.push("--remount-ro".into());
        args.push("/".into());
        args
    }

    pub fn landlock_rules(&self) -> Vec<Rule> {
        self.entries
            .iter()
            .filter(|entry| entry.rights != 0)
            .map(|entry| Rule {
                target: Target::Path(entry.dest.clone()),
                rights: entry.rights,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: RunKind) -> Input {
        Input {
            kind,
            plugin: 9,
            data: (kind == RunKind::Sidecar).then_some(10),
            program_folder: (kind == RunKind::Sidecar).then_some(11),
            program_file: (kind == RunKind::Sidecar)
                .then(|| (13, PathBuf::from("/run/ardia/program/bin/tool"))),
            broker: 12,
        }
    }

    #[test]
    fn the_mounts_and_the_rules_come_from_one_list() {
        let plan = build(&input(RunKind::Sidecar));
        let mounts = plan.bwrap_mounts();
        for rule in plan.landlock_rules() {
            let Target::Path(path) = &rule.target else {
                panic!("full plans use in-jail paths")
            };
            let entry = plan
                .entries
                .iter()
                .find(|entry| &entry.dest == path)
                .unwrap();
            if entry.source != Source::Present {
                assert!(
                    mounts.iter().any(|arg| arg.as_os_str() == path.as_os_str()),
                    "{path:?} is ruled but not mounted"
                );
            }
        }
        assert!(mounts
            .windows(3)
            .any(|w| w == ["--ro-bind-fd", "9", PLUGIN_IN_JAIL]));
        assert!(mounts
            .windows(3)
            .any(|w| w == ["--bind-fd", "10", DATA_IN_JAIL]));
        assert!(mounts
            .windows(3)
            .any(|w| w == ["--ro-bind-fd", "11", PROGRAM_IN_JAIL]));
        assert!(mounts
            .windows(3)
            .any(|w| w == ["--ro-bind-fd", "12", BROKER_PATH_IN_JAIL]));
        assert!(!mounts
            .iter()
            .any(|arg| arg == "/home" || arg == "/run/user" || arg == "/var" || arg == "/sys"));
    }

    #[test]
    fn granted_destinations_are_fixed_and_never_nested() {
        let plan = build(&input(RunKind::Sidecar));
        let granted: Vec<&Entry> = plan
            .entries
            .iter()
            .filter(|e| matches!(e.source, Source::Fd { .. }))
            .collect();
        assert_eq!(granted.len(), 5);
        for entry in &granted {
            assert!(entry.dest.starts_with("/run/ardia"), "{:?}", entry.dest);
        }
        let ruled: Vec<&Entry> = plan.entries.iter().filter(|e| e.rights != 0).collect();
        for a in &ruled {
            for b in &ruled {
                let pinned_file_inside_its_folder =
                    b.dest == Path::new("/run/ardia/program/bin/tool") && b.rights & !a.rights == 0;
                if a.dest != b.dest && !pinned_file_inside_its_folder {
                    assert!(
                        !b.dest.starts_with(&a.dest),
                        "{:?} sits under {:?}, so their grants would add up",
                        b.dest,
                        a.dest
                    );
                }
            }
        }
        let writable: Vec<&Entry> = plan
            .entries
            .iter()
            .filter(|e| e.rights & crate::landlock::WRITE_FILE != 0)
            .collect();
        for entry in writable {
            assert_eq!(
                entry.rights & EXECUTE,
                0,
                "{:?} is writable and executable",
                entry.dest
            );
        }
    }

    #[test]
    fn non_utf8_paths_reach_bwrap_unchanged() {
        use std::os::unix::ffi::OsStrExt;
        let odd = PathBuf::from(OsStr::from_bytes(b"/run/odd\xffname"));
        let plan = Plan {
            entries: vec![Entry {
                dest: odd.clone(),
                source: Source::System,
                rights: 0,
            }],
        };
        let mounts = plan.bwrap_mounts();
        assert_eq!(
            std::os::unix::ffi::OsStrExt::as_bytes(mounts[1].as_os_str()),
            b"/run/odd\xffname"
        );
        assert_eq!(mounts[2].as_os_str(), odd.as_os_str());
    }

    #[test]
    fn the_host_reads_its_plugin_folder_and_nothing_else() {
        let plan = build(&input(RunKind::Host));
        let rules = plan.landlock_rules();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].target, Target::Path(PLUGIN_IN_JAIL.into()));
        assert_eq!(rules[0].rights, READ);
    }
}
