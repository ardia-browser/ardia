use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use ardia_state::sync_engine::sync_core::{SyncKeys, is_tag, vault};
use ardia_state::sync_engine::{Listing, Transport, TransportError};
use serde_json::{Map, Value};

pub const ICLOUD_SUFFIX: &str = ".icloud";
pub const LEGACY_FOLDER_NAME: &str = "Netnyahoo Sync";
pub const FOLDER_NAME: &str = "Ardia Sync";

pub fn icloud_drive(home: &Path) -> PathBuf {
    home.join("Library/Mobile Documents/com~apple~CloudDocs")
}

pub fn has_sync_data(folder: &Path) -> bool {
    std::fs::read_dir(folder).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| is_tag(&entry.file_name().to_string_lossy()))
    })
}

pub fn is_dir(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_dir())
}

fn now_ms() -> i64 {
    ardia_state::store::now_ms()
}

fn missing(problem: &std::io::Error) -> bool {
    problem.kind() == std::io::ErrorKind::NotFound
}

pub trait Ubiquity: Send + Sync {
    fn downloading(&self, path: &Path) -> bool;
    fn start_download(&self, path: &Path);
}

pub struct PlainFolders;

impl Ubiquity for PlainFolders {
    fn downloading(&self, _path: &Path) -> bool {
        false
    }

    fn start_download(&self, _path: &Path) {}
}

pub struct Vault {
    folder: PathBuf,
    keys: Arc<SyncKeys>,
    ubiquity: Arc<dyn Ubiquity>,
}

impl Vault {
    pub fn new(folder: &Path, keys: Arc<SyncKeys>, ubiquity: Arc<dyn Ubiquity>) -> Self {
        Vault {
            folder: folder.to_path_buf(),
            keys,
            ubiquity,
        }
    }

    pub fn chain_path(&self) -> PathBuf {
        self.folder.join(self.keys.chain_tag())
    }

    fn scope_path(&self, scope: &str) -> PathBuf {
        self.chain_path().join(self.keys.scope_tag(scope))
    }

    pub fn chain_exists(&self) -> bool {
        is_dir(&self.chain_path())
    }

    pub fn create_chain(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(self.chain_path())
    }

    pub fn delete_chain(&self) -> std::io::Result<()> {
        if !self.chain_exists() {
            return Ok(());
        }
        let chain = self.chain_path();
        crate::file_coordination::write(&chain, crate::file_coordination::Writing::Deleting, || {
            std::fs::remove_dir_all(&chain)
        })
        .map_err(|problem| std::io::Error::other(problem.to_string()))?
    }

    pub fn write_with_id(
        &self,
        scope: &str,
        payload: &[u8],
        id: &str,
    ) -> Result<(), TransportError> {
        let failed = |problem: String| TransportError::Failed(problem);
        let scope_tag = self.keys.scope_tag(scope);
        let sealed = self
            .keys
            .seal(payload, &scope_tag, id)
            .map_err(|e| failed(e.code().to_owned()))?;
        let directory = self.scope_path(scope);
        std::fs::create_dir_all(&directory).map_err(|e| failed(e.to_string()))?;
        let destination = directory.join(vault::file_name(id));
        let place = |root: &Path| -> std::io::Result<()> {
            let staging = root.join(format!(".ardia-sync-staging-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&staging)?;
            let temporary = staging.join(id);
            let placed = std::fs::write(&temporary, &sealed)
                .and_then(|_| std::fs::File::open(&temporary).and_then(|f| f.sync_all()))
                .and_then(|_| {
                    crate::file_coordination::write(
                        &destination,
                        crate::file_coordination::Writing::Replacing,
                        || std::fs::rename(&temporary, &destination),
                    )
                    .map_err(|problem| std::io::Error::other(problem.to_string()))?
                });
            let _ = std::fs::remove_dir_all(&staging);
            placed
        };
        let placed = place(&std::env::temp_dir()).or_else(|_| place(&self.folder));
        placed.map_err(|e| failed(e.to_string()))
    }

    pub fn read_scope(
        &self,
        scope: &str,
        known: &HashSet<String>,
    ) -> Result<Listing, TransportError> {
        let mut listing = Listing::default();
        let directory = self.scope_path(scope);
        let mut names: Vec<String> = match std::fs::read_dir(&directory) {
            Ok(entries) => entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
            Err(problem) if missing(&problem) => return Ok(listing),
            Err(problem) => return Err(TransportError::Unreadable(problem.to_string())),
        };
        names.sort();
        let suffix = format!(".{}", vault::FILE_EXTENSION);
        let scope_tag = self.keys.scope_tag(scope);
        let mut present = HashSet::new();
        for name in names {
            if let Some(stub) = name
                .strip_prefix('.')
                .and_then(|n| n.strip_suffix(ICLOUD_SUFFIX))
                .and_then(|n| n.strip_suffix(suffix.as_str()))
            {
                if !is_tag(stub) || present.contains(stub) {
                    continue;
                }
                present.insert(stub.to_owned());
                listing.present.push(stub.to_owned());
                if !known.contains(stub) {
                    listing.pending.push(stub.to_owned());
                    self.ubiquity
                        .start_download(&directory.join(format!("{stub}{suffix}")));
                }
                continue;
            }
            let Some(id) = name.strip_suffix(suffix.as_str()) else {
                continue;
            };
            if !is_tag(id) {
                continue;
            }
            if present.insert(id.to_owned()) {
                listing.present.push(id.to_owned());
            }
            if known.contains(id) {
                continue;
            }
            let path = directory.join(&name);
            if self.ubiquity.downloading(&path) {
                listing.pending.push(id.to_owned());
                self.ubiquity.start_download(&path);
                continue;
            }
            let data = match crate::file_coordination::read(&path, || std::fs::read(&path)) {
                Err(crate::file_coordination::CoordinationError::TimedOut) => return Ok(listing),
                Err(_) => None,
                Ok(read) => read.ok(),
            };
            let opened = data.and_then(|data| self.keys.open(&data, &scope_tag, id).ok());
            match opened.and_then(|plain| hide_legacy_passwords(plain.as_slice(), &self.keys)) {
                Some(payload) => listing.files.push((id.to_owned(), payload)),
                None => {
                    let modified = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .unwrap_or_else(|_| SystemTime::now());
                    let age = SystemTime::now()
                        .duration_since(modified)
                        .map_or(0, |d| d.as_millis() as i64);
                    listing.damaged.push((id.to_owned(), age.max(0)));
                }
            }
        }
        Ok(listing)
    }

    pub fn remove_files(&self, scope: &str, ids: &[String]) -> Result<(), TransportError> {
        let directory = self.scope_path(scope);
        let mut first: Option<String> = None;
        for id in ids {
            let path = directory.join(vault::file_name(id));
            let removed = crate::file_coordination::write(
                &path,
                crate::file_coordination::Writing::Deleting,
                || std::fs::remove_file(&path),
            );
            match removed {
                Ok(Err(problem)) if !missing(&problem) => {
                    first.get_or_insert(problem.to_string());
                }
                Err(crate::file_coordination::CoordinationError::Failed(problem))
                    if path.exists() =>
                {
                    first.get_or_insert(problem);
                }
                Err(crate::file_coordination::CoordinationError::TimedOut) => {
                    first.get_or_insert("the sync folder didn’t answer in time".to_owned());
                }
                _ => {}
            }
            let _ = std::fs::remove_file(
                directory.join(format!(".{id}.{}{ICLOUD_SUFFIX}", vault::FILE_EXTENSION)),
            );
        }
        first.map_or(Ok(()), |problem| Err(TransportError::Failed(problem)))
    }
}

impl Transport for Vault {
    fn write(&self, scope: &str, payload: &str) -> Result<String, TransportError> {
        let id = ardia_state::sync_engine::sync_core::new_file_id()
            .map_err(|e| TransportError::Failed(e.code().to_owned()))?;
        let restored = restore_legacy_passwords(payload.as_bytes(), &self.keys)
            .map_err(TransportError::Failed)?;
        self.write_with_id(scope, &restored, &id)?;
        Ok(id)
    }

    fn read(&self, scope: &str, known: &[String]) -> Result<Listing, TransportError> {
        self.read_scope(scope, &known.iter().cloned().collect())
    }

    fn remove(&self, scope: &str, ids: &[String]) -> Result<(), TransportError> {
        self.remove_files(scope, ids)
    }
}

const LEGACY_PREFIX: &str = "pw:";
const LEGACY_MARKER: &[u8] = b"\"pw:";

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

pub fn hide_legacy_passwords(json: &[u8], keys: &SyncKeys) -> Option<String> {
    if !contains(json, LEGACY_MARKER) {
        return Some(String::from_utf8_lossy(json).into_owned());
    }
    rewrite(json, keys, true).ok()
}

pub fn restore_legacy_passwords(json: &[u8], keys: &SyncKeys) -> Result<Vec<u8>, String> {
    if !contains(json, LEGACY_MARKER) {
        return Ok(json.to_vec());
    }
    rewrite(json, keys, false).map(String::into_bytes)
}

fn without_lone_surrogates(json: &[u8]) -> Vec<u8> {
    let unit = |i: usize| -> Option<u32> {
        if i + 5 < json.len() && json[i] == b'\\' && json[i + 1] == b'u' {
            u32::from_str_radix(std::str::from_utf8(&json[i + 2..i + 6]).ok()?, 16).ok()
        } else {
            None
        }
    };
    let mut out = Vec::with_capacity(json.len());
    let mut i = 0;
    while i < json.len() {
        if json[i] != b'\\' || i + 1 >= json.len() {
            out.push(json[i]);
            i += 1;
            continue;
        }
        match unit(i) {
            Some(value) if (0xD800..=0xDFFF).contains(&value) => {
                if value <= 0xDBFF
                    && unit(i + 6).is_some_and(|next| (0xDC00..=0xDFFF).contains(&next))
                {
                    out.extend_from_slice(&json[i..i + 12]);
                    i += 12;
                } else {
                    out.extend_from_slice(b"\\ufffd");
                    i += 6;
                }
            }
            _ => {
                out.extend_from_slice(&json[i..i + 2]);
                i += 2;
            }
        }
    }
    out
}

fn rewrite(json: &[u8], keys: &SyncKeys, hiding: bool) -> Result<String, String> {
    let tree: Value = serde_json::from_slice(json)
        .or_else(|_| serde_json::from_slice(&without_lone_surrogates(json)))
        .map_err(|e| e.to_string())?;
    let walked = walk(tree, keys, hiding)?;
    serde_json::to_string(&walked).map_err(|e| e.to_string())
}

fn walk(node: Value, keys: &SyncKeys, hiding: bool) -> Result<Value, String> {
    match node {
        Value::Array(list) => list
            .into_iter()
            .map(|v| walk(v, keys, hiding))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(mut object) => {
            let legacy_op = object
                .get("k")
                .and_then(Value::as_str)
                .is_some_and(|k| k.starts_with(LEGACY_PREFIX))
                && object.contains_key("v");
            if legacy_op {
                let value = object.remove("v").unwrap_or(Value::Null);
                object.insert("v".into(), password(value, keys, hiding)?);
                return Ok(Value::Object(object));
            }
            let mut out = Map::new();
            for (key, value) in object {
                if !key.starts_with(LEGACY_PREFIX) {
                    out.insert(key, walk(value, keys, hiding)?);
                } else if value.is_string() {
                    continue;
                } else if let Value::Object(mut record) = value {
                    if let Some(inner) = record.remove("v") {
                        record.insert("v".into(), password(inner, keys, hiding)?);
                    }
                    out.insert(key, Value::Object(record));
                } else {
                    out.insert(key, value);
                }
            }
            Ok(Value::Object(out))
        }
        other => Ok(other),
    }
}

fn password(value: Value, keys: &SyncKeys, hiding: bool) -> Result<Value, String> {
    let Value::Object(mut login) = value else {
        return Ok(value);
    };
    let (Some(origin), Some(username)) = (
        login.get("o").and_then(Value::as_str).map(str::to_owned),
        login.get("u").and_then(Value::as_str).map(str::to_owned),
    ) else {
        return Ok(Value::Object(login));
    };
    if hiding {
        if let Some(plain) = login
            .get("p")
            .and_then(Value::as_str)
            .map(|p| zeroize::Zeroizing::new(p.to_owned()))
        {
            login.remove("p");
            let sealed = keys
                .seal_password(&plain, &origin, &username)
                .map_err(|e| e.code().to_owned())?;
            login.insert("s".into(), Value::String(sealed));
        }
    } else if let Some(sealed) = login.get("s").and_then(Value::as_str).map(str::to_owned) {
        login.remove("s");
        let plain = keys
            .open_password(&sealed, &origin, &username)
            .map_err(|e| e.code().to_owned())?;
        login.insert("p".into(), Value::String(plain.to_string()));
    }
    Ok(Value::Object(login))
}

#[cfg(target_os = "macos")]
pub struct ICloudFolders;

#[cfg(target_os = "macos")]
impl Ubiquity for ICloudFolders {
    fn downloading(&self, path: &Path) -> bool {
        use objc2_foundation::{NSString, NSURL};
        let Some(text) = path.to_str() else {
            return false;
        };
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        let ubiquitous = resource(&url, "NSURLIsUbiquitousItemKey")
            .and_then(|v| v.downcast::<objc2_foundation::NSNumber>().ok())
            .is_some_and(|n| n.boolValue());
        if !ubiquitous {
            return false;
        }
        let status = resource(&url, "NSURLUbiquitousItemDownloadingStatusKey")
            .and_then(|v| v.downcast::<NSString>().ok())
            .map(|s| s.to_string());
        status.is_some_and(|s| s != "NSURLUbiquitousItemDownloadingStatusCurrent")
    }

    fn start_download(&self, path: &Path) {
        use objc2::msg_send;
        use objc2_foundation::{NSFileManager, NSString, NSURL};
        let Some(text) = path.to_str() else { return };
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        let manager = NSFileManager::defaultManager();
        let mut problem: *mut objc2_foundation::NSError = std::ptr::null_mut();
        let _: bool = unsafe {
            msg_send![&*manager, startDownloadingUbiquitousItemAtURL: &*url, error: &mut problem]
        };
    }
}

#[cfg(target_os = "macos")]
fn resource(
    url: &objc2_foundation::NSURL,
    key: &str,
) -> Option<objc2::rc::Retained<objc2::runtime::AnyObject>> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSString;
    let key = NSString::from_str(key);
    let mut value: *mut AnyObject = std::ptr::null_mut();
    let mut problem: *mut objc2_foundation::NSError = std::ptr::null_mut();
    let ok: bool =
        unsafe { msg_send![url, getResourceValue: &mut value, forKey: &*key, error: &mut problem] };
    if !ok || value.is_null() {
        return None;
    }
    unsafe { Retained::retain(value) }
}

pub fn ubiquity() -> Arc<dyn Ubiquity> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(ICloudFolders)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(PlainFolders)
    }
}

pub fn file_age_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

pub fn clock_now() -> i64 {
    now_ms()
}
