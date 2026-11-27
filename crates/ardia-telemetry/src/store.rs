use std::io::{Read as _, Write as _};
use std::path::Path;

use serde_json::Value;

pub const MAX_DOCUMENT_BYTES: u64 = 16 * 1_048_576;

pub fn read_json(path: &Path) -> Option<Value> {
    let file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_DOCUMENT_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_DOCUMENT_BYTES).read_to_end(&mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_data()?;
    }
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

pub fn append(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(bytes)
}
