use std::io;
use std::os::fd::{AsRawFd, RawFd};

use crate::sys;

pub const EXECUTE: u64 = 1 << 0;
pub const WRITE_FILE: u64 = 1 << 1;
pub const READ_FILE: u64 = 1 << 2;
pub const READ_DIR: u64 = 1 << 3;
pub const REMOVE_DIR: u64 = 1 << 4;
pub const REMOVE_FILE: u64 = 1 << 5;
pub const MAKE_CHAR: u64 = 1 << 6;
pub const MAKE_DIR: u64 = 1 << 7;
pub const MAKE_REG: u64 = 1 << 8;
pub const MAKE_SOCK: u64 = 1 << 9;
pub const MAKE_FIFO: u64 = 1 << 10;
pub const MAKE_BLOCK: u64 = 1 << 11;
pub const MAKE_SYM: u64 = 1 << 12;
pub const REFER: u64 = 1 << 13;
pub const TRUNCATE: u64 = 1 << 14;
pub const IOCTL_DEV: u64 = 1 << 15;

pub const NET_BIND_TCP: u64 = 1 << 0;
pub const NET_CONNECT_TCP: u64 = 1 << 1;

pub const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;
pub const SCOPE_SIGNAL: u64 = 1 << 1;

pub const FILE_ONLY_RIGHTS: u64 = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV;

pub const READ: u64 = READ_FILE | READ_DIR;
pub const READ_EXECUTE: u64 = READ | EXECUTE;
pub const READ_WRITE: u64 = READ
    | WRITE_FILE
    | MAKE_REG
    | MAKE_DIR
    | MAKE_SYM
    | REMOVE_FILE
    | REMOVE_DIR
    | REFER
    | TRUNCATE;
pub const DEVICE_READ_WRITE: u64 = READ_FILE | WRITE_FILE | IOCTL_DEV;
pub const DEVICE_READ: u64 = READ_FILE;

pub const NEWEST_KNOWN_ABI: u32 = 6;
pub const HOST_MIN_ABI: u32 = 1;
pub const SIDECAR_MIN_ABI: u32 = 2;

const CREATE_RULESET_VERSION: u32 = 1 << 0;
const RULE_PATH_BENEATH: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    NotBuiltIn,
    Disabled,
    Other(i32),
}

impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unavailable::NotBuiltIn => write!(f, "the kernel wasn't built with Landlock"),
            Unavailable::Disabled => write!(f, "Landlock is turned off at boot (it isn't in lsm=)"),
            Unavailable::Other(errno) => write!(f, "Landlock answered errno {errno}"),
        }
    }
}

pub fn kernel_abi() -> Result<u32, Unavailable> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<u8>(),
            0usize,
            CREATE_RULESET_VERSION,
        )
    };
    if result >= 1 {
        return Ok(result as u32);
    }
    match sys::last_error().raw_os_error() {
        Some(libc::ENOSYS) => Err(Unavailable::NotBuiltIn),
        Some(libc::EOPNOTSUPP) => Err(Unavailable::Disabled),
        Some(errno) => Err(Unavailable::Other(errno)),
        None => Err(Unavailable::Other(0)),
    }
}

pub fn effective_abi(kernel: u32, cap: u32) -> u32 {
    kernel.min(cap).min(NEWEST_KNOWN_ABI)
}

pub fn fs_rights(abi: u32) -> u64 {
    let mut rights = (1u64 << 13) - 1;
    if abi >= 2 {
        rights |= REFER;
    }
    if abi >= 3 {
        rights |= TRUNCATE;
    }
    if abi >= 5 {
        rights |= IOCTL_DEV;
    }
    rights
}

pub fn net_rights(abi: u32) -> u64 {
    if abi >= 4 {
        NET_BIND_TCP | NET_CONNECT_TCP
    } else {
        0
    }
}

pub fn scopes(abi: u32) -> u64 {
    if abi >= 6 {
        SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL
    } else {
        0
    }
}

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}

#[repr(C, packed)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

fn attr_size(abi: u32) -> usize {
    match abi {
        0..=3 => 8,
        4 | 5 => 16,
        _ => 24,
    }
}

pub fn restrict_self(abi: u32, rules: &[(RawFd, u64)]) -> io::Result<()> {
    if abi == 0 {
        return Err(sys::invalid("Landlock ABI 0 can't restrict anything"));
    }
    let handled = fs_rights(abi);
    let attr = RulesetAttr {
        handled_access_fs: handled,
        handled_access_net: net_rights(abi),
        scoped: scopes(abi),
    };
    let ruleset = sys::check_long(unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr as *const RulesetAttr,
            attr_size(abi),
            0u32,
        )
    })?;
    let ruleset = sys::owned(ruleset as RawFd);
    for (fd, rights) in rules {
        let mut allowed = rights & handled;
        if !sys::is_dir(*fd)? {
            allowed &= FILE_ONLY_RIGHTS;
        }
        if allowed == 0 {
            continue;
        }
        let beneath = PathBeneathAttr {
            allowed_access: allowed,
            parent_fd: *fd,
        };
        sys::check_long(unsafe {
            libc::syscall(
                libc::SYS_landlock_add_rule,
                ruleset.as_raw_fd(),
                RULE_PATH_BENEATH,
                &beneath as *const PathBeneathAttr,
                0u32,
            )
        })?;
    }
    sys::set_no_new_privs()?;
    sys::check_long(unsafe {
        libc::syscall(libc::SYS_landlock_restrict_self, ruleset.as_raw_fd(), 0u32)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rights_grow_with_the_abi() {
        assert_eq!(fs_rights(1) & (REFER | TRUNCATE | IOCTL_DEV), 0);
        assert_eq!(fs_rights(2) & REFER, REFER);
        assert_eq!(fs_rights(2) & TRUNCATE, 0);
        assert_eq!(fs_rights(3) & TRUNCATE, TRUNCATE);
        assert_eq!(fs_rights(4) & IOCTL_DEV, 0);
        assert_eq!(fs_rights(5) & IOCTL_DEV, IOCTL_DEV);
        assert_eq!(net_rights(3), 0);
        assert_eq!(net_rights(4), NET_BIND_TCP | NET_CONNECT_TCP);
        assert_eq!(scopes(5), 0);
        assert_eq!(scopes(6), SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL);
    }

    #[test]
    fn the_effective_abi_never_passes_what_the_crate_knows() {
        assert_eq!(effective_abi(9, 99), NEWEST_KNOWN_ABI);
        assert_eq!(effective_abi(4, 2), 2);
        assert_eq!(effective_abi(1, 6), 1);
    }
}
