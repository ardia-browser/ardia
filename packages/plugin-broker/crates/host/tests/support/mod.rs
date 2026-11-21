#![allow(dead_code)]

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub fn host_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_ardia-plugin-host"))
}

pub fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn repo_dir() -> PathBuf {
    crate_dir().join("../../../..").canonicalize().unwrap()
}

pub fn scratch_plugin(name: &str, source: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ardia-host-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("main.js"), source).unwrap();
    dir
}

pub struct Host {
    pub child: Child,
    pub stream: UnixStream,
    pending: Vec<u8>,
    pub spawned: Instant,
}

pub struct Ended {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub stderr: String,
}

impl Host {
    pub fn spawn(folder: &Path, entry: &str, extra: &[&str]) -> Host {
        Host::spawn_command(Command::new(host_binary()).env_clear().arg("host"), folder, entry, extra)
    }

    pub fn spawn_command(command: &mut Command, folder: &Path, entry: &str, extra: &[&str]) -> Host {
        let (parent, child_end) = UnixStream::pair().unwrap();
        let child_fd = child_end.as_raw_fd();
        command.arg("--entry").arg(entry).args(extra).current_dir(folder).env("ARDIA_PLUGIN_FD", "3").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        unsafe {
            command.pre_exec(move || {
                if child_fd == 3 {
                    if libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                } else if libc::dup2(child_fd, 3) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let spawned = Instant::now();
        let child = command.spawn().unwrap();
        drop(child_end);
        parent.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        Host { child, stream: parent, pending: Vec::new(), spawned }
    }

    pub fn send(&mut self, message: &Value) {
        let mut line = serde_json::to_vec(message).unwrap();
        line.push(b'\n');
        self.stream.write_all(&line).unwrap();
    }

    pub fn send_raw(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.stream.write_all(bytes)
    }

    pub fn line(&mut self, within: Duration) -> Option<String> {
        let deadline = Instant::now() + within;
        loop {
            if let Some(at) = self.pending.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=at).collect();
                return Some(String::from_utf8_lossy(&line[..line.len() - 1]).into_owned());
            }
            if Instant::now() >= deadline {
                return None;
            }
            let mut chunk = [0u8; 65536];
            match self.stream.read(&mut chunk) {
                Ok(0) => return None,
                Ok(count) => self.pending.extend_from_slice(&chunk[..count]),
                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(_) => return None,
            }
        }
    }

    pub fn message(&mut self, within: Duration) -> Option<Value> {
        self.line(within).map(|line| serde_json::from_str(&line).unwrap_or(Value::String(line)))
    }

    pub fn expect(&mut self, within: Duration, what: &str) -> Value {
        match self.message(within) {
            Some(value) => value,
            None => {
                let ended = self.end(Duration::from_secs(2));
                panic!("waited for {what} but got nothing; exit {:?} signal {:?}\nstderr:\n{}", ended.code, ended.signal, ended.stderr);
            }
        }
    }

    pub fn request(&mut self, method: &str, within: Duration) -> Value {
        let deadline = Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let message = self.expect(left, &format!("a {method} request"));
            if message.get("method").and_then(Value::as_str) == Some(method) {
                return message;
            }
            self.answer(&message);
        }
    }

    pub fn answer(&mut self, message: &Value) {
        let (Some(id), Some(method)) = (message.get("id"), message.get("method").and_then(Value::as_str)) else { return };
        let result = match method {
            "hello" => json!({ "app": "Ardia", "version": "test", "protocol": 2, "plugin": "test", "values": {} }),
            "storage.get" => json!({ "found": false }),
            "windows" => json!([]),
            "panel.open" => json!({ "ok": true, "windowId": "w1" }),
            _ => Value::Null,
        };
        let id = id.clone();
        self.send(&json!({ "id": id, "result": result }));
    }

    pub fn reply(&mut self, request: &Value, result: Value) {
        let id = request["id"].clone();
        self.send(&json!({ "id": id, "result": result }));
    }

    pub fn close(&mut self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }

    pub fn shrink_stderr_to_one_page(&self) {
        let fd = self.child.stderr.as_ref().expect("a piped stderr").as_raw_fd();
        let size = unsafe { libc::fcntl(fd, libc::F_SETPIPE_SZ, 4096) };
        assert_eq!(size, 4096, "F_SETPIPE_SZ");
    }

    pub fn wait_without_reading_stderr(&mut self, within: Duration) -> Option<i32> {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        None
    }

    pub fn signal(&self, signal: i32) {
        unsafe { libc::kill(self.child.id() as i32, signal) };
    }

    pub fn end(&mut self, within: Duration) -> Ended {
        let deadline = Instant::now() + within;
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                break self.child.wait().unwrap();
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let mut stderr = String::new();
        if let Some(mut pipe) = self.child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        Ended { code: status.code(), signal: status.signal(), stderr }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
