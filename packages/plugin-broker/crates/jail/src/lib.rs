#![cfg(target_os = "linux")]

#[cfg(not(target_arch = "x86_64"))]
compile_error!(
    "the plugin jail compiles syscall tables for x86-64 only; AArch64 needs its own tables first"
);

pub mod cgroup;
pub mod elf;
pub mod exec;
pub mod frame;
pub mod landlock;
pub mod log;
pub mod plan;
pub mod procscan;
pub mod restart;
pub mod roots;
pub mod seccomp;
pub mod spawn;
pub mod supervise;
pub mod sys;

pub use exec::{exec_main, ExecOutcome, HostHandoff, StartedSignal};
pub use supervise::{
    Capabilities, ExitReport, FolderScripts, LaunchObserver, Launched, PolicyDelivery, Program,
    Quiet, RunId, SpawnError, SpawnRequest, Supervisor, SupervisorConfig, Work,
};

pub const BROKER_PATH_IN_JAIL: &str = "/run/ardia/ardia-plugins";
pub const PLUGIN_IN_JAIL: &str = "/run/ardia/plugin";
pub const DATA_IN_JAIL: &str = "/run/ardia/data";
pub const PROGRAM_IN_JAIL: &str = "/run/ardia/program";
pub const PROGRAM_FD_IN_JAIL: i32 = 13;
pub const EXEC_STAGE_IN_JAIL: &str = "/run/ardia/exec";
pub const LANDLOCK_MISSING: &str =
    "This system's kernel lacks Landlock, which Ardia needs to sandbox plugins";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Full,
    HostReduced,
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Level::Full => "full",
            Level::HostReduced => "hostReduced",
        }
    }

    pub fn from_name(name: &str) -> Option<Level> {
        match name {
            "full" => Some(Level::Full),
            "hostReduced" => Some(Level::HostReduced),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunKind {
    Host,
    Sidecar,
}
