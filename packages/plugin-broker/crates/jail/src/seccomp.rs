use std::io;

use crate::sys;

const LOAD_WORD: u16 = 0x20;
const AND_CONSTANT: u16 = 0x54;
const JUMP_IF_EQUAL: u16 = 0x15;
const JUMP_IF_ANY_BIT: u16 = 0x45;
const JUMP_ALWAYS: u16 = 0x05;
const RETURN: u16 = 0x06;

const RET_KILL_PROCESS: u32 = 0x8000_0000;
const RET_ERRNO: u32 = 0x0005_0000;
const RET_ALLOW: u32 = 0x7fff_0000;

const OFFSET_NR: u32 = 0;
const OFFSET_ARCH: u32 = 4;
const X32_SYSCALL_BIT: u32 = 0x4000_0000;

const AUDIT_ARCH: u32 = 0xc000_003e;

const SET_MODE_FILTER: libc::c_ulong = 1;
const FILTER_FLAG_TSYNC: libc::c_ulong = 1;

const NAMESPACE_FLAGS: u32 = (libc::CLONE_NEWNS
    | libc::CLONE_NEWCGROUP
    | libc::CLONE_NEWUTS
    | libc::CLONE_NEWIPC
    | libc::CLONE_NEWUSER
    | libc::CLONE_NEWPID
    | libc::CLONE_NEWNET) as u32;

const TIOCSTI: u32 = 0x5412;
const TIOCLINUX: u32 = 0x541c;
const PERSONALITY_QUERY: u32 = 0xffff_ffff;
const SOCKET_TYPE_FLAGS: u32 = (libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC) as u32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Allow,
    Errno(u16),
    KillProcess,
}

impl Action {
    fn code(self) -> u32 {
        match self {
            Action::Allow => RET_ALLOW,
            Action::Errno(errno) => RET_ERRNO | errno as u32,
            Action::KillProcess => RET_KILL_PROCESS,
        }
    }
}

const DENY: Action = Action::Errno(libc::EPERM as u16);
const NOT_IMPLEMENTED: Action = Action::Errno(libc::ENOSYS as u16);

#[derive(Clone, Debug)]
pub struct LowWordMatch {
    pub arg: u8,
    pub mask: u32,
    pub values: Vec<u32>,
}

impl LowWordMatch {
    pub fn equals(index: u8, value: u32) -> LowWordMatch {
        LowWordMatch {
            arg: index,
            mask: u32::MAX,
            values: vec![value],
        }
    }

    pub fn one_of(index: u8, values: &[u32]) -> LowWordMatch {
        LowWordMatch {
            arg: index,
            mask: u32::MAX,
            values: values.to_vec(),
        }
    }

    pub fn none_of_bits(index: u8, bits: u32) -> LowWordMatch {
        LowWordMatch {
            arg: index,
            mask: bits,
            values: vec![0],
        }
    }

    pub fn masked(index: u8, mask: u32, values: &[u32]) -> LowWordMatch {
        LowWordMatch {
            arg: index,
            mask,
            values: values.to_vec(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Rule {
    pub nr: libc::c_long,
    pub args: Vec<LowWordMatch>,
    pub action: Action,
}

impl Rule {
    pub fn plain(nr: libc::c_long, action: Action) -> Rule {
        Rule {
            nr,
            args: Vec::new(),
            action,
        }
    }

    pub fn when(nr: libc::c_long, args: Vec<LowWordMatch>, action: Action) -> Rule {
        Rule { nr, args, action }
    }
}

#[derive(Clone, Debug)]
pub struct Filter {
    pub default: Action,
    pub rules: Vec<Rule>,
}

#[derive(Clone, Copy)]
enum Target {
    Next,
    Label(usize),
}

enum Op {
    Load(u32),
    And(u32),
    JumpIfEqual(u32, Target, Target),
    JumpIfAnyBit(u32, Target, Target),
    Jump(usize),
    Return(u32),
    Mark(usize),
}

#[derive(Default)]
struct Assembler {
    ops: Vec<Op>,
    labels: usize,
}

impl Assembler {
    fn label(&mut self) -> usize {
        self.labels += 1;
        self.labels - 1
    }

    fn push(&mut self, op: Op) {
        self.ops.push(op);
    }

    fn assemble(self) -> io::Result<Vec<libc::sock_filter>> {
        let mut positions = vec![usize::MAX; self.labels];
        let mut index = 0;
        for op in &self.ops {
            match op {
                Op::Mark(label) => positions[*label] = index,
                _ => index += 1,
            }
        }
        let offset = |target: Target, at: usize| -> io::Result<u8> {
            match target {
                Target::Next => Ok(0),
                Target::Label(label) => u8::try_from(positions[label] - (at + 1))
                    .map_err(|_| sys::invalid("a seccomp jump is longer than 255 instructions")),
            }
        };
        let mut program = Vec::with_capacity(index);
        for op in &self.ops {
            let at = program.len();
            let instruction = match op {
                Op::Mark(_) => continue,
                Op::Load(k) => libc::sock_filter {
                    code: LOAD_WORD,
                    jt: 0,
                    jf: 0,
                    k: *k,
                },
                Op::And(k) => libc::sock_filter {
                    code: AND_CONSTANT,
                    jt: 0,
                    jf: 0,
                    k: *k,
                },
                Op::JumpIfEqual(k, yes, no) => libc::sock_filter {
                    code: JUMP_IF_EQUAL,
                    jt: offset(*yes, at)?,
                    jf: offset(*no, at)?,
                    k: *k,
                },
                Op::JumpIfAnyBit(k, yes, no) => libc::sock_filter {
                    code: JUMP_IF_ANY_BIT,
                    jt: offset(*yes, at)?,
                    jf: offset(*no, at)?,
                    k: *k,
                },
                Op::Jump(label) => libc::sock_filter {
                    code: JUMP_ALWAYS,
                    jt: 0,
                    jf: 0,
                    k: (positions[*label] - (at + 1)) as u32,
                },
                Op::Return(k) => libc::sock_filter {
                    code: RETURN,
                    jt: 0,
                    jf: 0,
                    k: *k,
                },
            };
            program.push(instruction);
        }
        if program.len() > 4096 {
            return Err(sys::invalid(
                "the seccomp program is over 4096 instructions",
            ));
        }
        Ok(program)
    }
}

fn low_word_offset(index: u8) -> u32 {
    16 + 8 * index as u32
}

pub fn compile(filter: &Filter) -> io::Result<Vec<libc::sock_filter>> {
    let mut asm = Assembler::default();
    let native_arch = asm.label();
    asm.push(Op::Load(OFFSET_ARCH));
    asm.push(Op::JumpIfEqual(
        AUDIT_ARCH,
        Target::Label(native_arch),
        Target::Next,
    ));
    asm.push(Op::Return(RET_KILL_PROCESS));
    asm.push(Op::Mark(native_arch));
    asm.push(Op::Load(OFFSET_NR));
    let native_abi = asm.label();
    asm.push(Op::JumpIfAnyBit(
        X32_SYSCALL_BIT,
        Target::Next,
        Target::Label(native_abi),
    ));
    asm.push(Op::Return(DENY.code()));
    asm.push(Op::Mark(native_abi));

    let mut order: Vec<libc::c_long> = Vec::new();
    for rule in &filter.rules {
        if !order.contains(&rule.nr) {
            order.push(rule.nr);
        }
    }
    for nr in order {
        let skip = asm.label();
        asm.push(Op::JumpIfEqual(
            nr as u32,
            Target::Next,
            Target::Label(skip),
        ));
        for rule in filter.rules.iter().filter(|rule| rule.nr == nr) {
            let unmatched = asm.label();
            for arg in &rule.args {
                asm.push(Op::Load(low_word_offset(arg.arg)));
                if arg.mask != u32::MAX {
                    asm.push(Op::And(arg.mask));
                }
                let matched = asm.label();
                for value in &arg.values {
                    asm.push(Op::JumpIfEqual(
                        *value,
                        Target::Label(matched),
                        Target::Next,
                    ));
                }
                asm.push(Op::Jump(unmatched));
                asm.push(Op::Mark(matched));
            }
            asm.push(Op::Return(rule.action.code()));
            asm.push(Op::Mark(unmatched));
        }
        asm.push(Op::Return(filter.default.code()));
        asm.push(Op::Mark(skip));
    }
    asm.push(Op::Return(filter.default.code()));
    asm.assemble()
}

pub fn to_bytes(program: &[libc::sock_filter]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(program.len() * 8);
    for instruction in program {
        bytes.extend_from_slice(&instruction.code.to_ne_bytes());
        bytes.push(instruction.jt);
        bytes.push(instruction.jf);
        bytes.extend_from_slice(&instruction.k.to_ne_bytes());
    }
    bytes
}

pub fn from_bytes(bytes: &[u8]) -> io::Result<Vec<libc::sock_filter>> {
    if bytes.is_empty() || !bytes.len().is_multiple_of(8) {
        return Err(sys::invalid(
            "a seccomp program isn't a whole number of instructions",
        ));
    }
    Ok(bytes
        .chunks_exact(8)
        .map(|chunk| libc::sock_filter {
            code: u16::from_ne_bytes([chunk[0], chunk[1]]),
            jt: chunk[2],
            jf: chunk[3],
            k: u32::from_ne_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]),
        })
        .collect())
}

pub fn install(program: &[libc::sock_filter], every_thread: bool) -> io::Result<()> {
    sys::set_no_new_privs()?;
    let header = libc::sock_fprog {
        len: program.len() as libc::c_ushort,
        filter: program.as_ptr() as *mut _,
    };
    let flags = if every_thread { FILTER_FLAG_TSYNC } else { 0 };
    let result = unsafe {
        libc::syscall(
            libc::SYS_seccomp,
            SET_MODE_FILTER,
            flags,
            &header as *const libc::sock_fprog,
        )
    };
    if result == 0 {
        return Ok(());
    }
    if result > 0 {
        return Err(io::Error::other(format!(
            "thread {result} couldn't take the seccomp filter"
        )));
    }
    Err(sys::last_error())
}

pub const DENIED_FOR_EVERY_PLUGIN: &[libc::c_long] = &[
    libc::SYS_ptrace,
    libc::SYS_process_vm_readv,
    libc::SYS_process_vm_writev,
    libc::SYS_pidfd_getfd,
    libc::SYS_kcmp,
    libc::SYS_bpf,
    libc::SYS_perf_event_open,
    libc::SYS_userfaultfd,
    libc::SYS_fanotify_init,
    libc::SYS_keyctl,
    libc::SYS_add_key,
    libc::SYS_request_key,
    libc::SYS_io_uring_setup,
    libc::SYS_io_uring_enter,
    libc::SYS_io_uring_register,
    libc::SYS_mount,
    libc::SYS_umount2,
    libc::SYS_pivot_root,
    libc::SYS_move_mount,
    libc::SYS_open_tree,
    libc::SYS_fsopen,
    libc::SYS_fsmount,
    libc::SYS_fsconfig,
    libc::SYS_fspick,
    libc::SYS_mount_setattr,
    libc::SYS_chroot,
    libc::SYS_unshare,
    libc::SYS_setns,
    libc::SYS_open_by_handle_at,
    libc::SYS_name_to_handle_at,
    libc::SYS_kexec_load,
    libc::SYS_kexec_file_load,
    libc::SYS_init_module,
    libc::SYS_finit_module,
    libc::SYS_delete_module,
    libc::SYS_acct,
    libc::SYS_swapon,
    libc::SYS_swapoff,
    libc::SYS_reboot,
    libc::SYS_syslog,
    libc::SYS_quotactl,
    libc::SYS_uselib,
    libc::SYS_iopl,
    libc::SYS_ioperm,
];

pub fn baseline() -> Filter {
    let mut rules: Vec<Rule> = DENIED_FOR_EVERY_PLUGIN
        .iter()
        .map(|nr| Rule::plain(*nr, DENY))
        .collect();
    rules.push(Rule::plain(libc::SYS_clone3, NOT_IMPLEMENTED));
    rules.push(Rule::when(
        libc::SYS_clone,
        vec![LowWordMatch::none_of_bits(0, NAMESPACE_FLAGS)],
        Action::Allow,
    ));
    rules.push(Rule::plain(libc::SYS_clone, DENY));
    rules.push(Rule::when(
        libc::SYS_personality,
        vec![LowWordMatch::equals(0, PERSONALITY_QUERY)],
        Action::Allow,
    ));
    rules.push(Rule::plain(libc::SYS_personality, DENY));
    rules.push(Rule::when(
        libc::SYS_ioctl,
        vec![LowWordMatch::one_of(1, &[TIOCSTI, TIOCLINUX])],
        DENY,
    ));
    Filter {
        default: Action::Allow,
        rules,
    }
}

pub fn launcher_baseline() -> Filter {
    let mut filter = baseline();
    filter
        .rules
        .retain(|rule| rule.nr != libc::SYS_mount && rule.nr != libc::SYS_unshare);
    filter.rules.insert(
        0,
        Rule::when(
            libc::SYS_unshare,
            vec![LowWordMatch::equals(0, libc::CLONE_NEWNS as u32)],
            Action::Allow,
        ),
    );
    filter.rules.insert(1, Rule::plain(libc::SYS_unshare, DENY));
    filter
}

pub fn sidecar_offline(landlock_abi: u32) -> Filter {
    let mut rules = vec![
        Rule::plain(libc::SYS_socket, DENY),
        Rule::when(
            libc::SYS_socketpair,
            vec![
                LowWordMatch::equals(0, libc::AF_UNIX as u32),
                LowWordMatch::masked(
                    1,
                    !SOCKET_TYPE_FLAGS,
                    &[libc::SOCK_STREAM as u32, libc::SOCK_SEQPACKET as u32],
                ),
            ],
            Action::Allow,
        ),
        Rule::plain(libc::SYS_socketpair, DENY),
    ];
    if landlock_abi < 3 {
        rules.push(Rule::plain(libc::SYS_truncate, DENY));
    }
    Filter {
        default: Action::Allow,
        rules,
    }
}

const HOST_ALLOWED: &[libc::c_long] = &[
    libc::SYS_read,
    libc::SYS_write,
    libc::SYS_readv,
    libc::SYS_writev,
    libc::SYS_close,
    libc::SYS_fstat,
    libc::SYS_lseek,
    libc::SYS_munmap,
    libc::SYS_mremap,
    libc::SYS_brk,
    libc::SYS_madvise,
    libc::SYS_rt_sigaction,
    libc::SYS_rt_sigprocmask,
    libc::SYS_rt_sigreturn,
    libc::SYS_sigaltstack,
    libc::SYS_futex,
    libc::SYS_set_robust_list,
    libc::SYS_get_robust_list,
    libc::SYS_rseq,
    libc::SYS_set_tid_address,
    libc::SYS_clock_gettime,
    libc::SYS_clock_getres,
    libc::SYS_clock_nanosleep,
    libc::SYS_nanosleep,
    libc::SYS_gettimeofday,
    libc::SYS_getrusage,
    libc::SYS_getpid,
    libc::SYS_gettid,
    libc::SYS_getppid,
    libc::SYS_getuid,
    libc::SYS_geteuid,
    libc::SYS_getgid,
    libc::SYS_getegid,
    libc::SYS_sched_yield,
    libc::SYS_sched_getaffinity,
    libc::SYS_poll,
    libc::SYS_ppoll,
    libc::SYS_select,
    libc::SYS_pselect6,
    libc::SYS_epoll_create1,
    libc::SYS_epoll_ctl,
    libc::SYS_epoll_wait,
    libc::SYS_epoll_pwait,
    libc::SYS_epoll_pwait2,
    libc::SYS_eventfd2,
    libc::SYS_pipe2,
    libc::SYS_dup,
    libc::SYS_dup3,
    libc::SYS_getrandom,
    libc::SYS_exit,
    libc::SYS_exit_group,
    libc::SYS_restart_syscall,
    libc::SYS_membarrier,
    libc::SYS_recvfrom,
    libc::SYS_sendto,
    libc::SYS_recvmsg,
    libc::SYS_sendmsg,
    libc::SYS_shutdown,
    libc::SYS_getsockopt,
    libc::SYS_timerfd_create,
    libc::SYS_timerfd_settime,
    libc::SYS_timerfd_gettime,
];

const HOST_IOCTLS: &[u32] = &[
    libc::FIONBIO as u32,
    libc::FIOCLEX as u32,
    libc::FIONCLEX as u32,
    libc::TCGETS as u32,
    libc::TIOCGWINSZ as u32,
];

pub fn host_final(own_pid: i32) -> Filter {
    let mut rules: Vec<Rule> = HOST_ALLOWED
        .iter()
        .map(|nr| Rule::plain(*nr, Action::Allow))
        .collect();
    let no_exec_memory = || vec![LowWordMatch::none_of_bits(2, libc::PROT_EXEC as u32)];
    rules.push(Rule::when(libc::SYS_mmap, no_exec_memory(), Action::Allow));
    rules.push(Rule::when(
        libc::SYS_mprotect,
        no_exec_memory(),
        Action::Allow,
    ));
    rules.push(Rule::when(
        libc::SYS_clone,
        vec![LowWordMatch::masked(
            0,
            libc::CLONE_THREAD as u32 | NAMESPACE_FLAGS,
            &[libc::CLONE_THREAD as u32],
        )],
        Action::Allow,
    ));
    rules.push(Rule::plain(libc::SYS_clone3, NOT_IMPLEMENTED));
    rules.push(Rule::when(
        libc::SYS_tgkill,
        vec![LowWordMatch::equals(0, own_pid as u32)],
        Action::Allow,
    ));
    rules.push(Rule::when(
        libc::SYS_ioctl,
        vec![LowWordMatch::one_of(1, HOST_IOCTLS)],
        Action::Allow,
    ));
    rules.push(Rule::when(
        libc::SYS_prctl,
        vec![LowWordMatch::one_of(
            0,
            &[libc::PR_SET_NAME as u32, libc::PR_GET_NAME as u32],
        )],
        Action::Allow,
    ));
    Filter {
        default: DENY,
        rules,
    }
}

pub const NEVER_ALLOWED_IN_HOST: &[libc::c_long] = &[
    libc::SYS_socket,
    libc::SYS_socketpair,
    libc::SYS_connect,
    libc::SYS_bind,
    libc::SYS_listen,
    libc::SYS_accept,
    libc::SYS_accept4,
    libc::SYS_execve,
    libc::SYS_execveat,
    libc::SYS_fork,
    libc::SYS_vfork,
    libc::SYS_open,
    libc::SYS_openat,
    libc::SYS_openat2,
    libc::SYS_creat,
    libc::SYS_truncate,
    libc::SYS_kill,
    libc::SYS_ptrace,
    libc::SYS_rename,
    libc::SYS_renameat,
    libc::SYS_renameat2,
    libc::SYS_unlink,
    libc::SYS_unlinkat,
    libc::SYS_mkdir,
    libc::SYS_mkdirat,
    libc::SYS_link,
    libc::SYS_linkat,
    libc::SYS_symlink,
    libc::SYS_symlinkat,
    libc::SYS_io_uring_setup,
    libc::SYS_fcntl,
];

#[cfg(test)]
mod tests {
    use super::*;

    fn run(program: &[libc::sock_filter], nr: u32, arch: u32, args: [u64; 6]) -> u32 {
        let mut data = [0u8; 64];
        data[0..4].copy_from_slice(&nr.to_ne_bytes());
        data[4..8].copy_from_slice(&arch.to_ne_bytes());
        for (index, arg) in args.iter().enumerate() {
            data[16 + index * 8..24 + index * 8].copy_from_slice(&arg.to_ne_bytes());
        }
        let mut accumulator = 0u32;
        let mut pc = 0usize;
        loop {
            let instruction = program[pc];
            pc += 1;
            match instruction.code {
                LOAD_WORD => {
                    let at = instruction.k as usize;
                    accumulator = u32::from_ne_bytes(data[at..at + 4].try_into().unwrap());
                }
                AND_CONSTANT => accumulator &= instruction.k,
                JUMP_IF_EQUAL => {
                    pc += if accumulator == instruction.k {
                        instruction.jt
                    } else {
                        instruction.jf
                    } as usize
                }
                JUMP_IF_ANY_BIT => {
                    pc += if accumulator & instruction.k != 0 {
                        instruction.jt
                    } else {
                        instruction.jf
                    } as usize
                }
                JUMP_ALWAYS => pc += instruction.k as usize,
                RETURN => return instruction.k,
                other => panic!("unknown opcode {other:#x}"),
            }
        }
    }

    fn call(program: &[libc::sock_filter], nr: libc::c_long, args: [u64; 6]) -> u32 {
        run(program, nr as u32, AUDIT_ARCH, args)
    }

    #[test]
    fn baseline_denies_the_listed_calls_and_namespace_clones() {
        let program = compile(&baseline()).unwrap();
        assert_eq!(call(&program, libc::SYS_ptrace, [0; 6]), DENY.code());
        assert_eq!(
            call(&program, libc::SYS_io_uring_setup, [0; 6]),
            DENY.code()
        );
        assert_eq!(call(&program, libc::SYS_read, [0; 6]), RET_ALLOW);
        assert_eq!(
            call(&program, libc::SYS_clone3, [0; 6]),
            NOT_IMPLEMENTED.code()
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_clone,
                [libc::SIGCHLD as u64, 0, 0, 0, 0, 0]
            ),
            RET_ALLOW
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_clone,
                [libc::CLONE_NEWUSER as u64 | 17, 0, 0, 0, 0, 0]
            ),
            DENY.code()
        );
        assert_eq!(
            call(&program, libc::SYS_ioctl, [1, TIOCSTI as u64, 0, 0, 0, 0]),
            DENY.code()
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_ioctl,
                [1, (1u64 << 32) | TIOCSTI as u64, 0, 0, 0, 0]
            ),
            DENY.code()
        );
        assert_eq!(
            call(&program, libc::SYS_ioctl, [1, libc::TCGETS, 0, 0, 0, 0]),
            RET_ALLOW
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_personality,
                [0xffff_ffff, 0, 0, 0, 0, 0]
            ),
            RET_ALLOW
        );
        assert_eq!(
            call(&program, libc::SYS_personality, [0x0040000, 0, 0, 0, 0, 0]),
            DENY.code()
        );
        assert_eq!(
            run(
                &program,
                libc::SYS_read as u32 | X32_SYSCALL_BIT,
                AUDIT_ARCH,
                [0; 6]
            ),
            DENY.code()
        );
        assert_eq!(
            run(&program, libc::SYS_read as u32, 0x4000_0003, [0; 6]),
            RET_KILL_PROCESS
        );
    }

    #[test]
    fn the_launcher_baseline_only_lets_mount_through() {
        let launcher = compile(&launcher_baseline()).unwrap();
        let full = compile(&baseline()).unwrap();
        assert_eq!(call(&launcher, libc::SYS_mount, [0; 6]), RET_ALLOW);
        assert_eq!(call(&full, libc::SYS_mount, [0; 6]), DENY.code());
        let new_mount_ns = [libc::CLONE_NEWNS as u64, 0, 0, 0, 0, 0];
        let new_user_ns = [libc::CLONE_NEWUSER as u64, 0, 0, 0, 0, 0];
        assert_eq!(call(&launcher, libc::SYS_unshare, new_mount_ns), RET_ALLOW);
        assert_eq!(call(&launcher, libc::SYS_unshare, new_user_ns), DENY.code());
        assert_eq!(call(&full, libc::SYS_unshare, new_mount_ns), DENY.code());
        for nr in DENIED_FOR_EVERY_PLUGIN
            .iter()
            .filter(|nr| **nr != libc::SYS_mount && **nr != libc::SYS_unshare)
        {
            assert_eq!(call(&launcher, *nr, [0; 6]), DENY.code(), "syscall {nr}");
        }
    }

    #[test]
    fn offline_sidecars_get_unix_socketpairs_only() {
        let program = compile(&sidecar_offline(2)).unwrap();
        let stream = (libc::SOCK_STREAM | libc::SOCK_CLOEXEC) as u64;
        assert_eq!(
            call(
                &program,
                libc::SYS_socket,
                [libc::AF_INET as u64, 1, 0, 0, 0, 0]
            ),
            DENY.code()
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_socket,
                [libc::AF_UNIX as u64, 1, 0, 0, 0, 0]
            ),
            DENY.code()
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_socketpair,
                [libc::AF_UNIX as u64, stream, 0, 0, 0, 0]
            ),
            RET_ALLOW
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_socketpair,
                [
                    libc::AF_UNIX as u64,
                    libc::SOCK_SEQPACKET as u64,
                    0,
                    0,
                    0,
                    0
                ]
            ),
            RET_ALLOW
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_socketpair,
                [libc::AF_UNIX as u64, libc::SOCK_DGRAM as u64, 0, 0, 0, 0]
            ),
            DENY.code()
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_socketpair,
                [libc::AF_INET as u64, stream, 0, 0, 0, 0]
            ),
            DENY.code()
        );
        assert_eq!(call(&program, libc::SYS_truncate, [0; 6]), DENY.code());
        assert_eq!(call(&program, libc::SYS_ftruncate, [0; 6]), RET_ALLOW);
        let modern = compile(&sidecar_offline(3)).unwrap();
        assert_eq!(call(&modern, libc::SYS_truncate, [0; 6]), RET_ALLOW);
    }

    #[test]
    fn the_host_allowlist_refuses_sockets_children_exec_and_files() {
        let program = compile(&host_final(4242)).unwrap();
        for nr in NEVER_ALLOWED_IN_HOST {
            assert_eq!(call(&program, *nr, [0; 6]), DENY.code(), "syscall {nr}");
        }
        assert_eq!(call(&program, libc::SYS_read, [0; 6]), RET_ALLOW);
        assert_eq!(
            call(&program, libc::SYS_mmap, [0, 4096, 3, 0, 0, 0]),
            RET_ALLOW
        );
        assert_eq!(
            call(&program, libc::SYS_mmap, [0, 4096, 5, 0, 0, 0]),
            DENY.code()
        );
        assert_eq!(
            call(&program, libc::SYS_mprotect, [0, 4096, 4, 0, 0, 0]),
            DENY.code()
        );
        let thread = (libc::CLONE_VM | libc::CLONE_THREAD | libc::CLONE_SIGHAND) as u64;
        assert_eq!(
            call(&program, libc::SYS_clone, [thread, 0, 0, 0, 0, 0]),
            RET_ALLOW
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_clone,
                [libc::SIGCHLD as u64, 0, 0, 0, 0, 0]
            ),
            DENY.code()
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_clone,
                [thread | libc::CLONE_NEWUSER as u64, 0, 0, 0, 0, 0]
            ),
            DENY.code()
        );
        assert_eq!(
            call(&program, libc::SYS_tgkill, [4242, 4243, 6, 0, 0, 0]),
            RET_ALLOW
        );
        assert_eq!(
            call(&program, libc::SYS_tgkill, [1, 1, 9, 0, 0, 0]),
            DENY.code()
        );
        assert_eq!(
            call(&program, libc::SYS_ioctl, [0, libc::FIONBIO, 0, 0, 0, 0]),
            RET_ALLOW
        );
        assert_eq!(
            call(&program, libc::SYS_ioctl, [0, TIOCSTI as u64, 0, 0, 0, 0]),
            DENY.code()
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_prctl,
                [libc::PR_SET_NAME as u64, 0, 0, 0, 0, 0]
            ),
            RET_ALLOW
        );
        assert_eq!(
            call(
                &program,
                libc::SYS_prctl,
                [libc::PR_SET_DUMPABLE as u64, 0, 0, 0, 0, 0]
            ),
            DENY.code()
        );
        assert_eq!(
            call(&program, libc::SYS_clone3, [0; 6]),
            NOT_IMPLEMENTED.code()
        );
    }

    #[test]
    fn programs_survive_a_byte_round_trip() {
        let program = compile(&baseline()).unwrap();
        let back = from_bytes(&to_bytes(&program)).unwrap();
        assert_eq!(program.len(), back.len());
        for (a, b) in program.iter().zip(back.iter()) {
            assert_eq!((a.code, a.jt, a.jf, a.k), (b.code, b.jt, b.jf, b.k));
        }
    }
}
