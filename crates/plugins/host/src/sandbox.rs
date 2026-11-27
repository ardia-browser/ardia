use std::os::fd::RawFd;

pub struct ConfinePoint<'a> {
    pub channel_fd: RawFd,
    pub kept_fds: &'a [RawFd],
    pub threads: usize,
}

pub trait Sandbox {
    fn confine(&mut self, point: &ConfinePoint<'_>) -> Result<(), String>;
}

pub struct Unconfined;

impl Sandbox for Unconfined {
    fn confine(&mut self, _point: &ConfinePoint<'_>) -> Result<(), String> {
        Ok(())
    }
}

pub const SYSCALLS_AFTER_CONFINE: &[&str] = &[
    "read",
    "write",
    "poll",
    "ppoll",
    "clock_gettime",
    "clock_nanosleep",
    "nanosleep",
    "getrandom",
    "brk",
    "mmap",
    "munmap",
    "mremap",
    "madvise",
    "futex",
    "rt_sigreturn",
    "exit_group",
];
