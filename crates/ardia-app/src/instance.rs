use std::fs::{File, OpenOptions, TryLockError};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::cli::LaunchConfig;

pub const LOCK_FILE: &str = "ardia.lock";
pub const HAND_OFF_WAIT: Duration = Duration::from_secs(15);

#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
    path: PathBuf,
}

impl InstanceLock {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[derive(Debug)]
pub enum Claim {
    Ours(InstanceLock),
    Taken { pid: Option<u32> },
}

pub fn claim(data_dir: &Path) -> io::Result<Claim> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join(LOCK_FILE);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&path).map_err(|problem| {
        #[cfg(unix)]
        if problem.raw_os_error() == Some(libc::ELOOP) {
            return io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} is a link, so it can't be the lock", path.display()),
            );
        }
        problem
    })?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} isn't a regular file, so it can't be the lock",
                path.display()
            ),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "{} has other names, so it can't be the lock",
                    path.display()
                ),
            ));
        }
    }
    match file.try_lock() {
        Ok(()) => {
            file.set_len(0)?;
            file.seek(SeekFrom::Start(0))?;
            writeln!(file, "{}", std::process::id())?;
            file.flush()?;
            Ok(Claim::Ours(InstanceLock { _file: file, path }))
        }
        Err(TryLockError::WouldBlock) => {
            let mut text = String::new();
            let _ = file.read_to_string(&mut text);
            Ok(Claim::Taken {
                pid: text.trim().parse().ok(),
            })
        }
        Err(TryLockError::Error(problem)) => Err(problem),
    }
}

pub fn hand_off(config: &LaunchConfig, pid: Option<u32>) -> i32 {
    let who = pid.map_or_else(
        || "Another Ardia".to_owned(),
        |pid| format!("Another Ardia (pid {pid})"),
    );
    let folder = config.data_dir.display();
    #[cfg(unix)]
    if config.ipc {
        match forward(&config.socket_path(), &config.open_urls, HAND_OFF_WAIT) {
            Ok(opened) if opened == config.open_urls.len() => {
                match opened {
                    0 => println!("{who} is already running with {folder}."),
                    1 => println!("{who} is running with {folder}, so it opened the link."),
                    _ => {
                        println!("{who} is running with {folder}, so it opened the {opened} links.")
                    }
                }
                return 0;
            }
            Ok(opened) => {
                eprintln!(
                    "{who} is running with {folder}, but it opened only {opened} of {} links.",
                    config.open_urls.len()
                );
                return 1;
            }
            Err(problem) => log::warn!("the running Ardia didn't answer: {problem}"),
        }
    }
    eprintln!("{who} is already using {folder}. Quit it first, or pass --data-dir to run another.");
    1
}

#[cfg(unix)]
fn connect_patiently(socket: &Path, wait: Duration) -> io::Result<std::os::unix::net::UnixStream> {
    use std::os::unix::net::UnixStream;
    use std::time::Instant;

    let deadline = Instant::now() + wait;
    loop {
        match UnixStream::connect(socket) {
            Ok(stream) => return Ok(stream),
            Err(problem)
                if Instant::now() < deadline
                    && matches!(
                        problem.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                    ) =>
            {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(problem) => return Err(problem),
        }
    }
}

#[cfg(unix)]
pub fn forward(socket: &Path, urls: &[String], wait: Duration) -> io::Result<usize> {
    use std::io::BufRead;

    use serde_json::{Value, json};

    let stream = connect_patiently(socket, wait)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = io::BufReader::new(stream.try_clone()?);
    let mut writer = stream;
    let mut ask = |id: usize, method: &str, params: Value| -> io::Result<()> {
        writeln!(
            writer,
            "{}",
            json!({ "id": id, "method": method, "params": params })
        )?;
        let mut line = String::new();
        let limit = crate::ipc::socket::MAX_LINE as u64;
        if (&mut reader).take(limit).read_line(&mut line)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the running Ardia hung up",
            ));
        }
        let reply: Value = serde_json::from_str(&line)
            .map_err(|problem| io::Error::new(io::ErrorKind::InvalidData, problem))?;
        let Some(error) = reply.get("error") else {
            return Ok(());
        };
        if error.get("message").and_then(Value::as_str)
            == Some(crate::control_protocol::NO_ANSWER_IN_TIME)
        {
            log::info!("the running Ardia is still starting, so the link opens once it's ready");
            return Ok(());
        }
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("the running Ardia refused");
        Err(io::Error::other(message.to_owned()))
    };
    let mut opened = 0;
    for (index, url) in urls.iter().enumerate() {
        match ask(index, "open_url", json!({ "url": url })) {
            Ok(()) => opened += 1,
            Err(problem) => log::warn!("a link didn't open in the running Ardia: {problem}"),
        }
    }
    Ok(opened)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_instance_holds_a_data_folder() {
        let dir = tempfile::tempdir().unwrap();
        let first = match claim(dir.path()).unwrap() {
            Claim::Ours(lock) => lock,
            Claim::Taken { .. } => panic!("an empty folder is free"),
        };
        assert_eq!(first.path(), dir.path().join(LOCK_FILE));
        match claim(dir.path()).unwrap() {
            Claim::Taken { pid } => assert_eq!(pid, Some(std::process::id())),
            Claim::Ours(_) => panic!("a second instance can't share the folder"),
        }
        drop(first);
        assert!(
            matches!(claim(dir.path()).unwrap(), Claim::Ours(_)),
            "the folder frees up on exit"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_lock_file_is_refused_and_its_target_kept() {
        let dir = tempfile::tempdir().unwrap();
        let sentinel = dir.path().join("sentinel");
        std::fs::write(&sentinel, b"keep me").unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::os::unix::fs::symlink(&sentinel, data.join(LOCK_FILE)).unwrap();
        let refused = claim(&data).unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::InvalidInput, "{refused}");
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"keep me");
        std::fs::remove_file(data.join(LOCK_FILE)).unwrap();
        std::fs::hard_link(&sentinel, data.join(LOCK_FILE)).unwrap();
        let refused = claim(&data).unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::InvalidInput, "{refused}");
        assert_eq!(
            std::fs::read(&sentinel).unwrap(),
            b"keep me",
            "a second name for a file is refused too"
        );
        std::fs::remove_file(data.join(LOCK_FILE)).unwrap();
        std::fs::create_dir(data.join(LOCK_FILE)).unwrap();
        assert!(claim(&data).is_err(), "a folder can't be the lock either");
    }
}
