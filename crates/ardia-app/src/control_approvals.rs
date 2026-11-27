use std::io::Write as _;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const FILE_NAME: &str = "ArdiaControlApprovals.json";
pub const MAX_ENTRIES: usize = 64;
pub const MAX_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredApproval {
    pub key: String,
    pub name: String,
    pub signed_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub added: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<f64>,
}

impl StoredApproval {
    pub fn live(&self, now_seconds: f64) -> bool {
        self.until.is_none_or(|until| now_seconds < until)
    }

    pub fn wire(&self) -> Value {
        let mut out = json!({
            "key": self.key,
            "name": self.name,
            "signedBy": self.signed_by,
            "added": self.added * 1000.0,
        });
        if let Some(path) = &self.path {
            out["path"] = Value::from(path.clone());
        }
        if let Some(until) = self.until {
            out["until"] = Value::from(until * 1000.0);
        }
        out
    }
}

pub struct Loaded {
    pub entries: Vec<StoredApproval>,
    pub problem: Option<String>,
}

pub fn load(dir: &Path, now_seconds: f64) -> Loaded {
    let path = dir.join(FILE_NAME);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Loaded {
                entries: Vec::new(),
                problem: None,
            };
        }
        Err(error) => {
            return Loaded {
                entries: Vec::new(),
                problem: Some(format!("Couldn't read {FILE_NAME} ({error}).")),
            };
        }
    };
    if !private_file(&meta) || meta.len() > MAX_BYTES {
        return Loaded {
            entries: Vec::new(),
            problem: Some(format!(
                "{FILE_NAME} isn't a private file of yours, so Ardia ignores it."
            )),
        };
    }
    let parsed = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<StoredApproval>>(&bytes).ok());
    match parsed {
        Some(entries) => {
            let live: Vec<StoredApproval> = entries
                .into_iter()
                .filter(|entry| entry.live(now_seconds))
                .collect();
            let skip = live.len().saturating_sub(MAX_ENTRIES);
            Loaded {
                entries: live.into_iter().skip(skip).collect(),
                problem: None,
            }
        }
        None => Loaded {
            entries: Vec::new(),
            problem: Some(format!("{FILE_NAME} is damaged, so Ardia ignores it.")),
        },
    }
}

#[cfg(unix)]
fn private_file(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    let me = unsafe { libc::getuid() };
    meta.file_type().is_file() && meta.uid() == me && meta.mode() & 0o077 == 0
}

#[cfg(not(unix))]
fn private_file(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_file()
}

pub fn read_wire(dir: &Path, now_seconds: f64, doorbell: bool) -> Value {
    let loaded = load(dir, now_seconds);
    let mut out = json!({
        "approvals": loaded.entries.iter().map(StoredApproval::wire).collect::<Vec<_>>(),
        "doorbell": doorbell,
    });
    if let Some(problem) = loaded.problem {
        out["problem"] = Value::from(problem);
    }
    out
}

pub fn revoke(dir: &Path, key: &str, now_seconds: f64) -> Result<bool, String> {
    let loaded = load(dir, now_seconds);
    if loaded.problem.is_some() {
        return Ok(false);
    }
    let kept: Vec<StoredApproval> = loaded
        .entries
        .iter()
        .filter(|entry| entry.key != key)
        .cloned()
        .collect();
    if kept.len() == loaded.entries.len() {
        return Ok(false);
    }
    save(dir, &kept).map(|()| true)
}

pub fn add(dir: &Path, approval: StoredApproval, now_seconds: f64) -> bool {
    let mut entries: Vec<StoredApproval> = load(dir, now_seconds)
        .entries
        .into_iter()
        .filter(|entry| entry.key != approval.key)
        .collect();
    entries.push(approval);
    let skip = entries.len().saturating_sub(MAX_ENTRIES);
    save(dir, &entries[skip..]).is_ok()
}

fn save(dir: &Path, entries: &[StoredApproval]) -> Result<(), String> {
    let data = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
    let temporary = dir.join(format!(".{FILE_NAME}.{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options
        .open(&temporary)
        .and_then(|mut file| {
            file.write_all(&data)?;
            file.sync_all()
        })
        .and_then(|()| std::fs::rename(&temporary, dir.join(FILE_NAME)));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, text: &str) {
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, text).expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("mode");
        }
    }

    #[test]
    fn live_approvals_read_and_revoke() {
        let dir = tempfile::tempdir().expect("dir");
        write(
            dir.path(),
            r#"[{"key":"a","name":"python3","signedBy":"Not signed","added":10,"until":100},
                {"key":"b","name":"codex","signedBy":"OpenAI","added":20},
                {"key":"c","name":"old","signedBy":"x","added":1,"until":5}]"#,
        );
        let wire = read_wire(dir.path(), 50.0, false);
        let keys: Vec<&str> = wire["approvals"]
            .as_array()
            .expect("list")
            .iter()
            .filter_map(|a| a["key"].as_str())
            .collect();
        assert_eq!(keys, vec!["a", "b"]);
        assert_eq!(wire["approvals"][0]["until"], 100_000.0);
        assert_eq!(wire["doorbell"], false);
        assert_eq!(revoke(dir.path(), "a", 50.0), Ok(true));
        assert_eq!(revoke(dir.path(), "zzz", 50.0), Ok(false));
        let after = read_wire(dir.path(), 50.0, false);
        assert_eq!(after["approvals"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn damaged_or_shared_files_are_ignored_with_the_old_copy() {
        let dir = tempfile::tempdir().expect("dir");
        write(dir.path(), "not json");
        assert_eq!(
            read_wire(dir.path(), 0.0, true)["problem"],
            "ArdiaControlApprovals.json is damaged, so Ardia ignores it."
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            write(dir.path(), "[]");
            std::fs::set_permissions(
                dir.path().join(FILE_NAME),
                std::fs::Permissions::from_mode(0o644),
            )
            .expect("mode");
            assert_eq!(
                read_wire(dir.path(), 0.0, true)["problem"],
                "ArdiaControlApprovals.json isn't a private file of yours, so Ardia ignores it."
            );
        }
        let empty = tempfile::tempdir().expect("dir");
        assert_eq!(read_wire(empty.path(), 0.0, true)["doorbell"], true);
        assert!(read_wire(empty.path(), 0.0, true).get("problem").is_none());
    }

    #[test]
    fn added_approvals_replace_their_key_and_keep_the_newest_64() {
        let dir = tempfile::tempdir().expect("dir");
        let entry = |key: &str, until: Option<f64>| StoredApproval {
            key: key.into(),
            name: key.into(),
            signed_by: "Not signed by an identified developer".into(),
            path: None,
            added: 1.0,
            until,
        };
        assert!(add(dir.path(), entry("a", Some(100.0)), 10.0));
        assert!(add(dir.path(), entry("a", None), 10.0));
        let loaded = load(dir.path(), 10.0);
        assert_eq!(loaded.entries, vec![entry("a", None)]);
        for n in 0..70 {
            assert!(add(dir.path(), entry(&format!("k{n}"), None), 10.0));
        }
        let loaded = load(dir.path(), 10.0);
        assert_eq!(loaded.entries.len(), MAX_ENTRIES);
        assert_eq!(loaded.entries.last().map(|e| e.key.as_str()), Some("k69"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let mode = std::fs::metadata(dir.path().join(FILE_NAME))
                .expect("file")
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
