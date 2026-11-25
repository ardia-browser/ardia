use crate::channel::{Channel, ReadOutcome};
use crate::engine::{Engine, Thrown};
use crate::stderr;
use crate::entry;
use crate::exit::Exit;
use crate::governor::{spawn_watchdog, Governor, Limits, TERMINATE, WAKE_FD};
use crate::sandbox::{ConfinePoint, Sandbox};
use std::os::fd::{IntoRawFd, OwnedFd, RawFd};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub const PRELUDE: &str = include_str!(concat!(env!("OUT_DIR"), "/prelude.js"));

pub const USAGE: &str = "usage: ardia-plugin-host host --entry <path inside the plugin's folder> [--memory-mb N] [--stack-kb N] [--turn-cpu-ms N] [--minute-cpu-ms N] [--turn-wall-ms N] [--stop-grace-ms N]";

#[derive(Debug, Clone)]
pub struct Options {
    pub entry: String,
    pub entry_fd: Option<RawFd>,
    pub limits: Limits,
}

pub fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut entry = None;
    let mut limits = Limits::default();
    let mut at = 0;
    while at < args.len() {
        let flag = args[at].as_str();
        let value = args.get(at + 1).ok_or_else(|| format!("{flag} needs a value"))?;
        let number = || value.parse::<u64>().map_err(|_| format!("{flag} takes a whole number, not {value}"));
        match flag {
            "--entry" if entry.is_some() => return Err("--entry is given more than once".into()),
            "--entry" => entry = Some(value.clone()),
            "--memory-mb" => limits.memory_bytes = (number()? as usize) << 20,
            "--stack-kb" => limits.stack_bytes = (number()? as usize) << 10,
            "--turn-cpu-ms" => limits.turn_cpu = Duration::from_millis(number()?),
            "--minute-cpu-ms" => limits.minute_cpu = Duration::from_millis(number()?),
            "--turn-wall-ms" => limits.turn_wall = Duration::from_millis(number()?),
            "--stop-grace-ms" => limits.stop_grace = Duration::from_millis(number()?),
            _ => return Err(format!("{flag} isn't an option")),
        }
        at += 2;
    }
    Ok(Options { entry: entry.ok_or("--entry is required")?, entry_fd: None, limits })
}

pub fn hard_exit(exit: Exit, message: &'static str) -> ! {
    if !message.is_empty() {
        stderr::last_words(message);
    }
    unsafe { libc::_exit(exit.code()) }
}

extern "C" fn on_terminate(_signal: i32) {
    TERMINATE.store(true, Ordering::Relaxed);
    let fd = WAKE_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = 1u8;
        unsafe { libc::write(fd, (&byte as *const u8).cast(), 1) };
    }
}

fn install_signals() -> Result<RawFd, String> {
    let mut pipe = [0; 2];
    if unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } != 0 {
        return Err("the plugin host couldn't make its wake pipe".into());
    }
    WAKE_FD.store(pipe[1], Ordering::Relaxed);
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_terminate as *const () as usize;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        if libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut()) != 0 {
            return Err("the plugin host couldn't handle SIGTERM".into());
        }
    }
    Ok(pipe[0])
}

fn channel_fd() -> Result<RawFd, String> {
    let fd = std::env::var("ARDIA_PLUGIN_FD").ok().and_then(|text| text.parse::<RawFd>().ok()).unwrap_or(3);
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut info) } != 0 {
        return Err(format!("ARDIA_PLUGIN_FD {fd} isn't open"));
    }
    Ok(fd)
}

fn entry_filename(entry: &str) -> String {
    match std::env::current_dir() {
        Ok(dir) => dir.join(entry).to_string_lossy().into_owned(),
        Err(_) => entry.to_string(),
    }
}

fn is_stopping_line(line: &str) -> bool {
    line.contains("plugin.stopping")
        && serde_json::from_str::<serde_json::Value>(line).ok().and_then(|value| value.get("event").and_then(|event| event.as_str().map(|e| e == "plugin.stopping"))).unwrap_or(false)
}

pub struct Prepared {
    engine: Engine,
    source: String,
    entry: String,
    filename: String,
    wake: RawFd,
}

pub struct Confined(Prepared);

pub fn prepare(options: &Options) -> Result<Prepared, Exit> {
    stderr::make_nonblocking();
    let handed = options.entry_fd.map(|fd| {
        let read = entry::read_open(fd, &options.entry);
        unsafe { libc::close(fd) };
        read
    });
    let fd = channel_fd().map_err(|problem| {
        stderr::note(&format!("[ardia] {problem}"));
        Exit::Usage
    })?;
    let read = handed.unwrap_or_else(|| entry::read(&options.entry));
    let source = read.map_err(|problem| {
        stderr::note(&format!("[ardia] {problem}"));
        Exit::LoadFailed
    })?;
    let filename = entry_filename(&options.entry);
    let wake = install_signals().map_err(|problem| {
        stderr::note(&format!("[ardia] {problem}"));
        Exit::SandboxSetup
    })?;
    let mut engine = Engine::new(Governor::new(options.limits.clone()), Channel::new(fd)).map_err(|problem| {
        stderr::note(&format!("[ardia] {problem}"));
        Exit::LoadFailed
    })?;
    engine.update_stack_top();
    if let Err(thrown) = engine.install_prelude(PRELUDE) {
        stderr::note(&thrown.description);
        stderr::note("[ardia] the plugin host's prelude didn't load");
        return Err(Exit::LoadFailed);
    }
    if let Some(thrown) = engine.drain_jobs().into_iter().next() {
        stderr::note(&thrown.description);
        return Err(Exit::LoadFailed);
    }
    engine.host().channel.open().map_err(|error| {
        stderr::note(&format!("[ardia] the channel to Ardia couldn't be set up: {error}"));
        Exit::SandboxSetup
    })?;
    spawn_watchdog(engine.governor().watch.clone(), options.limits.turn_wall).map_err(|error| {
        stderr::note(&format!("[ardia] the watchdog couldn't start: {error}"));
        Exit::SandboxSetup
    })?;
    Ok(Prepared { engine, source, entry: options.entry.clone(), filename, wake })
}

impl Prepared {
    pub fn confine<S: Sandbox + ?Sized>(mut self, sandbox: &mut S) -> Result<Confined, Exit> {
        let channel_fd = self.engine.host().channel.fd();
        let kept = [0, 1, 2, channel_fd, self.wake, WAKE_FD.load(Ordering::Relaxed)];
        let point = ConfinePoint { channel_fd, kept_fds: &kept, threads: 2 };
        sandbox.confine(&point).map_err(|problem| {
            stderr::note(&format!("[ardia] the sandbox couldn't be set up: {problem}"));
            Exit::SandboxSetup
        })?;
        Ok(Confined(self))
    }
}

fn report(engine: &Engine, thrown: Option<Thrown>, failures: Vec<Thrown>) -> Option<Exit> {
    for failure in thrown.into_iter().chain(failures) {
        if !failure.uncatchable {
            stderr::log(&failure.description);
        }
    }
    engine.governor().reason()
}

fn exit_message(exit: Exit) -> &'static str {
    match exit {
        Exit::OutOfMemory => "the plugin ran out of memory, so it stopped",
        Exit::CpuBudget => "the plugin used too much CPU, so it stopped",
        _ => "",
    }
}

impl Confined {
    pub fn run(self) -> Exit {
        let Prepared { mut engine, source, entry, filename, wake } = self.0;
        engine.update_stack_top();
        engine.governor().begin_turn();
        let loaded = engine.eval_global(&source, &filename);
        drop(source);
        let failures = engine.drain_jobs();
        let failed_at_start = loaded.as_ref().err().map(|thrown| (thrown.uncatchable, thrown.stack_overflow));
        let stopped = report(&engine, loaded.err(), failures);
        engine.governor().end_turn();
        if let Some(exit) = stopped {
            return finish(&mut engine, exit);
        }
        if let Some((_, stack_overflow)) = failed_at_start {
            stderr::note(&format!("[ardia] {entry} threw while it loaded, so the plugin stopped"));
            return finish(&mut engine, if stack_overflow { Exit::Stack } else { Exit::LoadFailed });
        }
        event_loop(&mut engine, wake)
    }
}

fn finish(engine: &mut Engine, exit: Exit) -> Exit {
    engine.host().channel.flush();
    let message = exit_message(exit);
    if !message.is_empty() {
        stderr::note(&format!("[ardia] {message}"));
    }
    exit
}

fn turn<F: FnOnce(&mut Engine) -> Result<(), Thrown>>(engine: &mut Engine, work: F) -> Option<Exit> {
    engine.governor().begin_turn();
    let outcome = work(engine);
    let failures = engine.drain_jobs();
    let stopped = report(engine, outcome.err(), failures);
    engine.governor().end_turn();
    stopped
}

fn poll_timeout(engine: &mut Engine, now: Instant) -> i32 {
    let mut wait: Option<Duration> = engine.host().timers.next_due().map(|due| due.saturating_duration_since(now));
    if let Some(stop) = engine.governor().stop_deadline_in() {
        wait = Some(wait.map_or(stop, |w| w.min(stop)));
    }
    match wait {
        None => -1,
        Some(wait) => {
            let ms = wait.as_micros().div_ceil(1000);
            ms.min(i32::MAX as u128) as i32
        }
    }
}

fn event_loop(engine: &mut Engine, wake: RawFd) -> Exit {
    let mut lines = Vec::new();
    loop {
        if let Some(exit) = engine.governor().reason() {
            return finish(engine, exit);
        }
        let channel_fd = engine.host().channel.fd();
        let mut events = libc::POLLIN;
        if engine.host().channel.wants_write() {
            events |= libc::POLLOUT;
        }
        let mut fds = [libc::pollfd { fd: channel_fd, events, revents: 0 }, libc::pollfd { fd: wake, events: libc::POLLIN, revents: 0 }];
        let timeout = if engine.host().channel.has_buffered_input() { 0 } else { poll_timeout(engine, Instant::now()) };
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), 2, timeout) };
        if ready < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return finish(engine, Exit::ChannelClosed);
        }
        if TERMINATE.load(Ordering::Relaxed) {
            return finish(engine, Exit::Normal);
        }
        if fds[0].revents & libc::POLLOUT != 0 {
            engine.host().channel.flush();
        }
        let mut outcome = ReadOutcome::Open;
        if fds[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 || engine.host().channel.has_buffered_input() {
            outcome = engine.host().channel.read_lines(&mut lines);
            for line in lines.drain(..) {
                if is_stopping_line(&line) {
                    engine.governor().arm_stop_deadline();
                }
                if let Some(exit) = turn(engine, |engine| engine.deliver_line(line)) {
                    return finish(engine, exit);
                }
            }
        }
        match outcome {
            ReadOutcome::Violated => {
                stderr::note(&format!("[ardia] a line from Ardia was over {} MB, so the channel closed", crate::channel::MAX_INCOMING_LINE >> 20));
                return finish(engine, Exit::ChannelViolated);
            }
            ReadOutcome::Closed => return finish(engine, if engine.governor().stopping() { Exit::Normal } else { Exit::ChannelClosed }),
            ReadOutcome::Open => {}
        }
        let now = Instant::now();
        while let Some(id) = engine.host().timers.pop_due(now) {
            if let Some(exit) = turn(engine, |engine| engine.fire_timer(id)) {
                return finish(engine, exit);
            }
        }
        if engine.host().channel.is_closed() {
            return finish(engine, if engine.governor().stopping() { Exit::Normal } else { Exit::ChannelClosed });
        }
        if engine.governor().stop_deadline_in() == Some(Duration::ZERO) {
            stderr::note("[ardia] the plugin overstayed its stop grace, so it was ended");
            return finish(engine, Exit::ShutdownDeadline);
        }
    }
}

pub fn run_host<S: Sandbox + ?Sized>(args: &[String], sandbox: &mut S) -> Exit {
    let options = match parse_options(args) {
        Ok(options) => options,
        Err(problem) => {
            stderr::note(&format!("[ardia] {problem}\n{USAGE}"));
            return Exit::Usage;
        }
    };
    let prepared = match prepare(&options) {
        Ok(prepared) => prepared,
        Err(exit) => return exit,
    };
    match prepared.confine(sandbox) {
        Ok(confined) => confined.run(),
        Err(exit) => exit,
    }
}

pub fn run_host_with_entry<S: Sandbox + ?Sized>(args: &[String], entry: OwnedFd, sandbox: &mut S) -> Exit {
    let mut options = match parse_options(args) {
        Ok(options) => options,
        Err(problem) => {
            stderr::note(&format!("[ardia] {problem}\n{USAGE}"));
            return Exit::Usage;
        }
    };
    options.entry_fd = Some(entry.into_raw_fd());
    let prepared = match prepare(&options) {
        Ok(prepared) => prepared,
        Err(exit) => return exit,
    };
    match prepared.confine(sandbox) {
        Ok(confined) => confined.run(),
        Err(exit) => exit,
    }
}

pub fn main_with<S: Sandbox + ?Sized>(sandbox: &mut S) -> ! {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let exit = match args.first().map(String::as_str) {
        Some("host") => run_host(&args[1..], sandbox),
        _ => {
            stderr::note(USAGE);
            Exit::Usage
        }
    };
    hard_exit(exit, "")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_limits_and_requires_an_entry() {
        let options = parse_options(&strings(&["--entry", "dist/index.js", "--memory-mb", "64", "--turn-cpu-ms", "50"])).unwrap();
        assert_eq!(options.entry, "dist/index.js");
        assert_eq!(options.limits.memory_bytes, 64 << 20);
        assert_eq!(options.limits.turn_cpu, Duration::from_millis(50));
        assert_eq!(options.limits.minute_cpu, Duration::from_secs(30));
        assert!(parse_options(&strings(&["--memory-mb", "64"])).is_err());
        assert!(parse_options(&strings(&["--entry"])).is_err());
        assert!(parse_options(&strings(&["--entry", "a", "--bogus", "1"])).is_err());
        assert!(parse_options(&strings(&["--entry", "a", "--memory-mb", "lots"])).is_err());
        assert!(parse_options(&strings(&["--entry", "a", "--entry", "b"])).unwrap_err().contains("more than once"));
    }

    #[test]
    fn spots_the_stopping_event() {
        assert!(is_stopping_line(r#"{"event":"plugin.stopping","time":1,"data":{}}"#));
        assert!(is_stopping_line(r#"{ "event" : "plugin.stopping" }"#));
        assert!(!is_stopping_line(r#"{"id":1,"result":"plugin.stopping"}"#));
        assert!(!is_stopping_line("plugin.stopping"));
    }

    #[test]
    fn the_prelude_is_the_swift_hosts_text() {
        assert!(PRELUDE.starts_with("(function (native) {\n  \"use strict\";"));
        assert!(PRELUDE.ends_with("})"));
        let implemented: Vec<&str> = crate::engine::NATIVES.iter().map(|(name, _, _)| *name).collect();
        let mut called: Vec<&str> = crate::engine::PRELUDE_HOOKS.to_vec();
        called.sort_unstable();
        let mut sorted = implemented.clone();
        sorted.sort_unstable();
        assert_eq!(called, sorted);
        assert_eq!(called.len(), 11);
        let swift = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../shell/plugin-host/HostPrelude.swift"));
        assert!(swift.contains(PRELUDE));
    }
}
