pub mod documents;
pub mod guard;
pub mod migrations;
pub mod session;

use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub use guard::{JsonProblem, Limits};

pub const DATA_DIR_ENV: &str = "ARDIA_DATA_DIR";

#[derive(Debug, thiserror::Error)]
pub enum PersistError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("the document isn't usable: {}", .0.code())]
    Json(JsonProblem),
    #[error("{0} is not a plain document name")]
    BadName(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataDir {
    root: PathBuf,
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static ASIDE_COUNTER: AtomicU64 = AtomicU64::new(0);
const ASIDE_ATTEMPTS: usize = 16;

fn not_regular() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "not a regular file")
}

fn open_regular(path: &Path) -> io::Result<Option<File>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    match options.open(path) {
        Ok(file) if file.metadata()?.is_file() => Ok(Some(file)),
        Ok(_) => Err(not_regular()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn aside_name(name: &str, now: i64, n: u64) -> String {
    format!(
        "{}-unreadable-{now}-{n}.json",
        name.strip_suffix(".json").unwrap_or(name)
    )
}

fn plain_name(name: &str) -> Result<&str, PersistError> {
    let ok = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0'])
        && !name.starts_with('.');
    if ok {
        Ok(name)
    } else {
        Err(PersistError::BadName(name.to_owned()))
    }
}

impl DataDir {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        DataDir { root: root.into() }
    }

    pub fn from_env() -> Option<Self> {
        std::env::var_os(DATA_DIR_ENV)
            .filter(|v| !v.is_empty())
            .map(DataDir::new)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path(&self, name: &str) -> Result<PathBuf, PersistError> {
        Ok(self.root.join(plain_name(name)?))
    }

    pub fn config_dir(&self) -> PathBuf {
        self.root.join("config")
    }

    #[cfg_attr(debug_assertions, track_caller)]
    pub fn read(&self, name: &str, max_bytes: usize) -> Result<Option<Vec<u8>>, PersistError> {
        ardia_profile::strict::blocking(ardia_profile::strict::Blocking::File);
        let Some(file) = open_regular(&self.path(name)?)? else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        file.take(max_bytes as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > max_bytes {
            return Err(PersistError::Json(JsonProblem::TooLarge));
        }
        Ok(Some(bytes))
    }

    #[cfg_attr(debug_assertions, track_caller)]
    pub fn read_json(&self, name: &str, limits: Limits) -> Result<Option<Value>, PersistError> {
        match self.read(name, limits.max_bytes)? {
            Some(bytes) => guard::parse(&bytes, limits)
                .map(Some)
                .map_err(PersistError::Json),
            None => Ok(None),
        }
    }

    pub fn exists(&self, name: &str) -> bool {
        self.path(name).is_ok_and(|p| p.exists())
    }

    #[cfg_attr(debug_assertions, track_caller)]
    pub fn write_atomic(&self, name: &str, bytes: &[u8]) -> Result<(), PersistError> {
        ardia_profile::strict::blocking(ardia_profile::strict::Blocking::File);
        let target = self.path(name)?;
        fs::create_dir_all(&self.root)?;
        let temp = self.root.join(format!(
            ".{name}.{}.{}.tmp",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let written = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(&temp, &target)?;
            if let Ok(dir) = File::open(&self.root) {
                let _ = dir.sync_all();
            }
            Ok::<(), io::Error>(())
        })();
        if written.is_err() {
            let _ = fs::remove_file(&temp);
        }
        written.map_err(PersistError::from)
    }

    #[cfg_attr(debug_assertions, track_caller)]
    pub fn create_new(&self, name: &str, bytes: &[u8]) -> Result<bool, PersistError> {
        ardia_profile::strict::blocking(ardia_profile::strict::Blocking::File);
        let target = self.path(name)?;
        fs::create_dir_all(&self.root)?;
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                file.write_all(bytes)?;
                file.sync_all()?;
                Ok(true)
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    pub fn keep_aside(&self, name: &str, now: i64) -> Result<Option<String>, PersistError> {
        let Some(mut source) = open_regular(&self.path(name)?)? else {
            return Ok(None);
        };
        for _ in 0..ASIDE_ATTEMPTS {
            let aside = aside_name(name, now, ASIDE_COUNTER.fetch_add(1, Ordering::Relaxed) + 1);
            let mut copy = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.path(&aside)?)
            {
                Ok(copy) => copy,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            };
            let copied = io::copy(&mut source, &mut copy).and_then(|_| copy.sync_all());
            if let Err(e) = copied {
                let _ = fs::remove_file(self.path(&aside)?);
                return Err(e.into());
            }
            return Ok(Some(aside));
        }
        Err(PersistError::Io(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "no free name for a kept-aside copy",
        )))
    }

    pub fn remove(&self, name: &str) -> Result<bool, PersistError> {
        match fs::remove_file(self.path(name)?) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    pub fn list(&self, prefix: &str) -> Vec<String> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.starts_with(prefix))
            .collect();
        names.sort();
        names
    }
}

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub fn version_field(value: Option<&Value>) -> Option<u64> {
    match value {
        None => Some(0),
        Some(v) => v
            .as_u64()
            .or_else(|| {
                v.as_f64()
                    .filter(|f| {
                        f.is_finite()
                            && *f >= 0.0
                            && f.fract() == 0.0
                            && *f <= MAX_SAFE_INTEGER as f64
                    })
                    .map(|f| f as u64)
            })
            .filter(|n| *n <= MAX_SAFE_INTEGER),
    }
}

pub fn versioned(mut value: Value, field: &str, version: u64) -> Value {
    if let Some(fields) = value.as_object_mut() {
        fields.shift_remove(field);
        fields.insert(field.to_owned(), version.into());
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_are_atomic_and_names_stay_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        data.write_atomic("a.json", b"{}").unwrap();
        data.write_atomic("a.json", b"{\"x\":1}").unwrap();
        assert_eq!(data.read("a.json", 100).unwrap().unwrap(), b"{\"x\":1}");
        assert!(data.list(".").is_empty());
        for bad in [
            "../escape.json",
            "a/b.json",
            ".hidden",
            "",
            "..",
            "nul\0.json",
        ] {
            assert!(
                matches!(data.write_atomic(bad, b"x"), Err(PersistError::BadName(_))),
                "{bad}"
            );
        }
        assert!(matches!(
            data.read("a.json", 3),
            Err(PersistError::Json(JsonProblem::TooLarge))
        ));
        assert_eq!(data.read("missing.json", 10).unwrap(), None);
        assert!(data.create_new("b.json", b"1").unwrap());
        assert!(!data.create_new("b.json", b"2").unwrap());
        let aside = data.keep_aside("b.json", 7).unwrap().unwrap();
        assert!(aside.starts_with("b-unreadable-7-"));
        assert_eq!(data.read(&aside, 10).unwrap().unwrap(), b"1");
        let second = data.keep_aside("b.json", 7).unwrap().unwrap();
        assert_ne!(aside, second, "a second copy never lands on the first");
        assert_eq!(data.keep_aside("missing.json", 7).unwrap(), None);
        assert_eq!(data.list("b").len(), 3);
        assert!(data.remove(&aside).unwrap());
        assert!(!data.remove(&aside).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn special_files_are_refused_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path());
        let fifo = dir.path().join("session.json");
        let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(matches!(
            data.read("session.json", 100),
            Err(PersistError::Io(_))
        ));
        assert!(data.keep_aside("session.json", 1).is_err());
        std::fs::create_dir(dir.path().join("folder.json")).unwrap();
        assert!(data.read("folder.json", 100).is_err());
    }

    #[test]
    fn version_fields_must_be_safe_integers() {
        assert_eq!(version_field(None), Some(0));
        assert_eq!(version_field(Some(&serde_json::json!(11))), Some(11));
        assert_eq!(version_field(Some(&serde_json::json!(-1))), None);
        assert_eq!(version_field(Some(&serde_json::json!(1.5))), None);
        assert_eq!(version_field(Some(&serde_json::json!(12.0))), Some(12));
        assert_eq!(version_field(Some(&serde_json::json!(1e300))), None);
        assert_eq!(version_field(Some(&serde_json::json!(-0.0))), Some(0));
        assert_eq!(version_field(Some(&serde_json::json!("11"))), None);
        assert_eq!(
            versioned(serde_json::json!({"version": 1, "a": 2}), "version", 3),
            serde_json::json!({"a": 2, "version": 3})
        );
    }
}
