use std::io;
use std::os::fd::RawFd;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;

use crate::sys::invalid;
use crate::{Level, RunKind};

const MAGIC: &[u8; 4] = b"ARJP";
const VERSION: u32 = 1;
pub const MAX_FRAME: usize = 1 << 20;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Path(PathBuf),
    Fd(RawFd),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub target: Target,
    pub rights: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub level: Level,
    pub kind: RunKind,
    pub landlock_abi: u32,
    pub expected_parent: i32,
    pub baseline: Vec<u8>,
    pub final_filter: Vec<u8>,
    pub rules: Vec<Rule>,
    pub cwd: Target,
    pub program: Option<PinnedProgram>,
    pub argv: Vec<String>,
    pub env: Vec<String>,
    pub host_args: Vec<String>,
    pub entry: Option<String>,
    pub mount_checks: Vec<MountCheck>,
    pub expected_mounts: Vec<PathBuf>,
    pub private_mounts: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountCheck {
    pub path: PathBuf,
    pub writable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinnedProgram {
    pub path: PathBuf,
    pub device: u64,
    pub inode: u64,
    pub script: bool,
    pub pin_with_overlay: bool,
    pub folder_flags: u64,
}

struct Writer(Vec<u8>);

impl Writer {
    fn u8(&mut self, value: u8) {
        self.0.push(value);
    }
    fn u32(&mut self, value: u32) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
    fn i32(&mut self, value: i32) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
    fn u64(&mut self, value: u64) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
    fn bytes(&mut self, value: &[u8]) {
        self.u32(value.len() as u32);
        self.0.extend_from_slice(value);
    }
    fn target(&mut self, target: &Target) {
        match target {
            Target::Path(path) => {
                self.u8(0);
                self.bytes(path.as_os_str().as_bytes());
            }
            Target::Fd(fd) => {
                self.u8(1);
                self.i32(*fd);
            }
        }
    }
    fn paths(&mut self, values: &[PathBuf]) {
        self.u32(values.len() as u32);
        for value in values {
            self.bytes(value.as_os_str().as_bytes());
        }
    }

    fn strings(&mut self, values: &[String]) {
        self.u32(values.len() as u32);
        for value in values {
            self.bytes(value.as_bytes());
        }
    }
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> io::Result<&'a [u8]> {
        if self.data.len() - self.at < count {
            return Err(invalid("the policy frame is cut short"));
        }
        let slice = &self.data[self.at..self.at + count];
        self.at += count;
        Ok(slice)
    }
    fn u8(&mut self) -> io::Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> io::Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> io::Result<i32> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> io::Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn bytes(&mut self) -> io::Result<Vec<u8>> {
        let count = self.u32()? as usize;
        Ok(self.take(count)?.to_vec())
    }
    fn path(&mut self) -> io::Result<PathBuf> {
        let bytes = self.bytes()?;
        if bytes.first() != Some(&b'/') || bytes.contains(&0) {
            return Err(invalid("a policy path isn't absolute"));
        }
        Ok(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
    }
    fn target(&mut self) -> io::Result<Target> {
        match self.u8()? {
            0 => Ok(Target::Path(self.path()?)),
            1 => Ok(Target::Fd(self.i32()?)),
            _ => Err(invalid("a policy target has an unknown kind")),
        }
    }
    fn string(&mut self) -> io::Result<String> {
        String::from_utf8(self.bytes()?).map_err(|_| invalid("a policy string isn't UTF-8"))
    }
    fn paths(&mut self) -> io::Result<Vec<PathBuf>> {
        let count = self.u32()? as usize;
        if count > 256 {
            return Err(invalid("the policy frame lists too many paths"));
        }
        (0..count).map(|_| self.path()).collect()
    }

    fn strings(&mut self) -> io::Result<Vec<String>> {
        let count = self.u32()? as usize;
        if count > 4096 {
            return Err(invalid("the policy frame lists too many strings"));
        }
        (0..count).map(|_| self.string()).collect()
    }
}

impl Frame {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Writer(Vec::new());
        out.0.extend_from_slice(MAGIC);
        out.u32(VERSION);
        out.u8(match self.level {
            Level::Full => 0,
            Level::HostReduced => 1,
        });
        out.u8(match self.kind {
            RunKind::Host => 0,
            RunKind::Sidecar => 1,
        });
        out.u32(self.landlock_abi);
        out.i32(self.expected_parent);
        out.bytes(&self.baseline);
        out.bytes(&self.final_filter);
        out.u32(self.rules.len() as u32);
        for rule in &self.rules {
            out.target(&rule.target);
            out.u64(rule.rights);
        }
        out.target(&self.cwd);
        match &self.program {
            Some(program) => {
                out.u8(match (program.script, program.pin_with_overlay) {
                    (false, _) => 1,
                    (true, false) => 2,
                    (true, true) => 3,
                });
                out.bytes(program.path.as_os_str().as_bytes());
                out.u64(program.device);
                out.u64(program.inode);
                out.u64(program.folder_flags);
            }
            None => out.u8(0),
        }
        out.strings(&self.argv);
        out.strings(&self.env);
        out.strings(&self.host_args);
        match &self.entry {
            Some(entry) => {
                out.u8(1);
                out.bytes(entry.as_bytes());
            }
            None => out.u8(0),
        }
        out.u32(self.mount_checks.len() as u32);
        for check in &self.mount_checks {
            out.bytes(check.path.as_os_str().as_bytes());
            out.u8(u8::from(check.writable));
        }
        out.paths(&self.expected_mounts);
        out.u8(u8::from(self.private_mounts));
        out.0
    }

    pub fn decode(data: &[u8]) -> io::Result<Frame> {
        if data.len() > MAX_FRAME {
            return Err(invalid("the policy frame is over 1 MB"));
        }
        let mut input = Reader { data, at: 0 };
        if input.take(4)? != MAGIC || input.u32()? != VERSION {
            return Err(invalid("the policy frame has the wrong magic or version"));
        }
        let level = match input.u8()? {
            0 => Level::Full,
            1 => Level::HostReduced,
            _ => return Err(invalid("the policy frame names an unknown level")),
        };
        let kind = match input.u8()? {
            0 => RunKind::Host,
            1 => RunKind::Sidecar,
            _ => return Err(invalid("the policy frame names an unknown kind")),
        };
        let landlock_abi = input.u32()?;
        let expected_parent = input.i32()?;
        let baseline = input.bytes()?;
        let final_filter = input.bytes()?;
        let count = input.u32()? as usize;
        if count > 256 {
            return Err(invalid("the policy frame lists too many rules"));
        }
        let mut rules = Vec::with_capacity(count);
        for _ in 0..count {
            let target = input.target()?;
            let rights = input.u64()?;
            rules.push(Rule { target, rights });
        }
        let cwd = input.target()?;
        let program = match input.u8()? {
            0 => None,
            flag @ (1..=3) => Some(PinnedProgram {
                path: input.path()?,
                device: input.u64()?,
                inode: input.u64()?,
                script: flag >= 2,
                pin_with_overlay: flag == 3,
                folder_flags: input.u64()?,
            }),
            _ => return Err(invalid("the policy frame's program flag is wrong")),
        };
        let argv = input.strings()?;
        let env = input.strings()?;
        let host_args = input.strings()?;
        let entry = match input.u8()? {
            0 => None,
            1 => Some(input.string()?),
            _ => return Err(invalid("the policy frame's entry flag is wrong")),
        };
        let count = input.u32()? as usize;
        if count > 256 {
            return Err(invalid("the policy frame lists too many mount checks"));
        }
        let mut mount_checks = Vec::with_capacity(count);
        for _ in 0..count {
            let path = input.path()?;
            let writable = match input.u8()? {
                0 => false,
                1 => true,
                _ => return Err(invalid("a mount check's flag is wrong")),
            };
            mount_checks.push(MountCheck { path, writable });
        }
        let expected_mounts = input.paths()?;
        let private_mounts = match input.u8()? {
            0 => false,
            1 => true,
            _ => return Err(invalid("the private-mounts flag is wrong")),
        };
        if private_mounts != (level == Level::Full) {
            return Err(invalid(
                "a full sandbox always makes its mounts private, and only a full sandbox can",
            ));
        }
        if entry
            .as_deref()
            .map(|e| e.is_empty() || e.starts_with('/') || e.split('/').any(|p| p == ".."))
            .unwrap_or(false)
        {
            return Err(invalid(
                "the entry isn't a plain path inside the plugin folder",
            ));
        }
        if env
            .iter()
            .any(|entry| !entry.contains('=') || entry.starts_with('='))
        {
            return Err(invalid("a policy environment entry isn't NAME=value"));
        }
        if kind == RunKind::Host && !env.is_empty() {
            return Err(invalid("the extension host takes no environment"));
        }

        if input.at != data.len() {
            return Err(invalid("the policy frame has trailing bytes"));
        }
        if level == Level::HostReduced && kind == RunKind::Sidecar {
            return Err(invalid("a sidecar never runs below full isolation"));
        }
        if kind == RunKind::Sidecar && (program.is_none() || final_filter.is_empty()) {
            return Err(invalid(
                "a sidecar frame needs a program and its final filter",
            ));
        }
        if level == Level::HostReduced && baseline.is_empty() {
            return Err(invalid("a host-reduced frame needs the baseline filter"));
        }
        Ok(Frame {
            level,
            kind,
            landlock_abi,
            expected_parent,
            baseline,
            final_filter,
            rules,
            cwd,
            program,
            argv,
            env,
            host_args,
            entry,
            mount_checks,
            expected_mounts,
            private_mounts,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Frame {
        Frame {
            level: Level::Full,
            kind: RunKind::Sidecar,
            landlock_abi: 4,
            expected_parent: 0,
            baseline: Vec::new(),
            final_filter: vec![1, 2, 3, 4, 5, 6, 7, 8],
            rules: vec![
                Rule {
                    target: Target::Path("/usr".into()),
                    rights: 13,
                },
                Rule {
                    target: Target::Fd(6),
                    rights: 12,
                },
            ],
            cwd: Target::Path("/plugins/x".into()),
            program: Some(PinnedProgram {
                path: "/run/ardia/program/bin/x".into(),
                device: 2049,
                inode: 77,
                script: true,
                pin_with_overlay: true,
                folder_flags: libc::MS_NOSUID | libc::MS_NOATIME,
            }),
            argv: vec!["x".into(), "--serve".into()],
            env: vec!["HOME=/run/ardia/data/home".into()],
            host_args: Vec::new(),
            entry: None,
            mount_checks: vec![
                MountCheck {
                    path: "/usr".into(),
                    writable: false,
                },
                MountCheck {
                    path: "/run/ardia/data".into(),
                    writable: true,
                },
            ],
            expected_mounts: vec!["/run/ardia/program/bin/x".into()],
            private_mounts: true,
        }
    }

    #[test]
    fn frames_round_trip() {
        let frame = sample();
        assert_eq!(Frame::decode(&frame.encode()).unwrap(), frame);
    }

    #[test]
    fn damaged_frames_are_refused() {
        let bytes = sample().encode();
        for cut in [0, 3, 8, bytes.len() - 1] {
            assert!(Frame::decode(&bytes[..cut]).is_err(), "cut at {cut}");
        }
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(Frame::decode(&extra).is_err());
        let mut public_full = sample();
        public_full.private_mounts = false;
        assert!(Frame::decode(&public_full.encode()).is_err());
        let mut reduced_sidecar = sample();
        reduced_sidecar.level = Level::HostReduced;
        reduced_sidecar.baseline = vec![0; 8];
        assert!(Frame::decode(&reduced_sidecar.encode()).is_err());
    }
}
