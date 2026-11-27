use std::collections::HashSet;
use std::path::Path;

use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use super::sqlite::Snapshot;
use super::{Credential, webkit_to_unix_ms};

const PREFIX: &[u8] = b"v10";
const SALT: &[u8] = b"saltysalt";
const ROUNDS: u32 = 1003;
const IV: [u8; 16] = [0x20; 16];

pub type Key = Zeroizing<[u8; 16]>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeychainItem {
    pub service: String,
    pub account: String,
}

pub fn keychain_items(browser: &str) -> Vec<KeychainItem> {
    let item = |service: &str, account: &str| KeychainItem {
        service: service.to_owned(),
        account: account.to_owned(),
    };
    match browser {
        "chrome" => vec![item("Chrome Safe Storage", "Chrome")],
        "chromium" => vec![item("Chromium Safe Storage", "Chromium")],
        "brave" => vec![item("Brave Safe Storage", "Brave")],
        "edge" => vec![item("Microsoft Edge Safe Storage", "Microsoft Edge")],
        "vivaldi" => vec![item("Vivaldi Safe Storage", "Vivaldi")],
        "arc" => vec![item("Arc Safe Storage", "Arc")],
        "dia" => vec![item("Dia Safe Storage", "Dia")],
        _ => Vec::new(),
    }
}

pub fn keychain_service(browser: &str) -> Option<String> {
    keychain_items(browser)
        .first()
        .map(|item| item.service.clone())
}

pub fn derive_key(secret: &[u8]) -> Key {
    let mut key = Zeroizing::new([0u8; 16]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(secret, SALT, ROUNDS, key.as_mut());
    key
}

pub fn is_encrypted(value: &[u8]) -> bool {
    value.len() > PREFIX.len() && value.starts_with(PREFIX)
}

pub fn decrypt_bytes(value: &[u8], key: &Key) -> Option<Zeroizing<Vec<u8>>> {
    if !is_encrypted(value) {
        return None;
    }
    let body = &value[PREFIX.len()..];
    if body.is_empty() || !body.len().is_multiple_of(16) {
        return None;
    }
    let mut buffer = Zeroizing::new(body.to_vec());
    let decryptor = cbc::Decryptor::<aes::Aes128>::new(key.as_ref().into(), (&IV).into());
    let length = decryptor
        .decrypt_padded_mut::<Pkcs7>(buffer.as_mut_slice())
        .ok()?
        .len();
    buffer.truncate(length);
    Some(buffer)
}

pub fn decrypt(value: &[u8], key: &Key, host_key: Option<&str>) -> Option<Zeroizing<String>> {
    if !is_encrypted(value) {
        return String::from_utf8(value.to_vec()).ok().map(Zeroizing::new);
    }
    let mut plain = decrypt_bytes(value, key)?;
    let start = match host_key {
        Some(host) => {
            let hash = Sha256::digest(host.as_bytes());
            if plain.len() >= hash.len() && plain[..hash.len()] == hash[..] {
                hash.len()
            } else {
                0
            }
        }
        None => 0,
    };
    let text = std::str::from_utf8(&plain[start..])
        .ok()
        .map(|s| Zeroizing::new(s.to_owned()));
    plain.zeroize();
    text
}

#[cfg(target_os = "macos")]
pub fn keychain_secret(items: &[KeychainItem]) -> Result<Zeroizing<Vec<u8>>, String> {
    use security_framework::passwords::get_generic_password;
    let mut last = None;
    for item in items {
        match get_generic_password(&item.service, &item.account) {
            Ok(secret) if !secret.is_empty() => return Ok(Zeroizing::new(secret)),
            Ok(_) => return Err(format!("{} is empty", item.service)),
            Err(error) if error.code() == -25300 => {
                last = Some(format!("No {} item in the Keychain", item.service))
            }
            Err(error) if matches!(error.code(), -128 | -25293 | -25308) => {
                return Err(format!("Access to {} was denied", item.service));
            }
            Err(error) => {
                return Err(format!(
                    "Keychain error {} reading {}",
                    error.code(),
                    item.service
                ));
            }
        }
    }
    Err(last.unwrap_or_else(|| "This browser has no Keychain item".into()))
}

#[cfg(not(target_os = "macos"))]
pub fn keychain_secret(_items: &[KeychainItem]) -> Result<Zeroizing<Vec<u8>>, String> {
    Err("Encrypted data can only be unlocked on macOS".into())
}

#[derive(Debug)]
pub struct Outcome<T> {
    pub items: Vec<T>,
    pub undecryptable: usize,
}

impl<T> Default for Outcome<T> {
    fn default() -> Self {
        Outcome {
            items: Vec::new(),
            undecryptable: 0,
        }
    }
}

fn logins_in(database: &Path, key: &Key) -> Result<Outcome<Credential>, String> {
    let db = Snapshot::copying(database)?;
    if !db.table_exists("logins") {
        return Err("Login Data has no logins table".into());
    }
    let mut out = Outcome::default();
    db.query("SELECT * FROM logins", |row| {
        if row.int("blacklisted_by_user").unwrap_or(0) != 0 {
            return true;
        }
        let Some(blob) = row.blob("password_value").filter(|b| !b.is_empty()) else {
            return true;
        };
        let Some(password) = decrypt(&blob, key, None) else {
            out.undecryptable += 1;
            return true;
        };
        if password.is_empty() {
            return true;
        }
        let origin = row.text("origin_url").unwrap_or_default();
        let realm = row.text("signon_realm");
        out.items.push(Credential {
            url: if origin.is_empty() {
                realm.clone().unwrap_or_default()
            } else {
                origin
            },
            username: row.text("username_value").unwrap_or_default(),
            password,
            realm,
        });
        true
    })?;
    Ok(out)
}

pub fn logins(profile: &Path, key: &Key) -> Result<Outcome<Credential>, String> {
    let files: Vec<_> = ["Login Data", "Login Data For Account"]
        .iter()
        .map(|name| profile.join(name))
        .filter(|file| file.is_file())
        .collect();
    if files.is_empty() {
        return Err("No saved passwords in this profile".into());
    }
    let mut out = Outcome::default();
    let mut seen = HashSet::new();
    for file in files {
        let found = logins_in(&file, key)?;
        out.undecryptable += found.undecryptable;
        for credential in found.items {
            let identity = format!(
                "{}\u{0}{}",
                credential.realm.as_deref().unwrap_or(&credential.url),
                credential.username
            );
            if seen.insert(identity) {
                out.items.push(credential);
            }
        }
    }
    Ok(out)
}

#[derive(Clone)]
pub struct Cookie {
    pub domain: String,
    pub name: String,
    pub value: Zeroizing<String>,
    pub path: String,
    pub created: Option<f64>,
    pub expires: Option<f64>,
    pub last_access: Option<f64>,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: &'static str,
    pub priority: &'static str,
    pub source_scheme: &'static str,
    pub source_port: i64,
    pub partition: Option<(String, bool)>,
}

impl std::fmt::Debug for Cookie {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cookie")
            .field("domain", &self.domain)
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl Cookie {
    pub fn wire(&self) -> serde_json::Value {
        let mut out = serde_json::json!({
            "domain": self.domain,
            "name": self.name,
            "value": self.value.as_str(),
            "path": self.path,
            "secure": self.secure,
            "httpOnly": self.http_only,
            "sameSite": self.same_site,
            "priority": self.priority,
            "sourceScheme": self.source_scheme,
            "sourcePort": self.source_port,
        });
        for (key, value) in [
            ("created", self.created),
            ("expires", self.expires),
            ("lastAccess", self.last_access),
        ] {
            if let Some(value) = value {
                out[key] = serde_json::json!(value);
            }
        }
        if let Some((site, cross)) = &self.partition {
            out["partitionKey"] = serde_json::json!({ "topLevelSite": site, "crossSite": cross });
        }
        out
    }
}

fn same_site(value: Option<i64>) -> &'static str {
    match value {
        Some(0) => "none",
        Some(1) => "lax",
        Some(2) => "strict",
        _ => "unspecified",
    }
}

fn priority(value: Option<i64>) -> &'static str {
    match value {
        Some(0) => "low",
        Some(2) => "high",
        _ => "medium",
    }
}

fn source_scheme(value: Option<i64>) -> &'static str {
    match value {
        Some(1) => "nonSecure",
        Some(2) => "secure",
        _ => "unset",
    }
}

pub fn cookies(profile: &Path, key: &Key, now_ms: f64) -> Result<Outcome<Cookie>, String> {
    let file = [profile.join("Network/Cookies"), profile.join("Cookies")]
        .into_iter()
        .find(|file| file.is_file())
        .ok_or("No cookies in this profile")?;
    let db = Snapshot::copying(&file)?;
    if !db.table_exists("cookies") {
        return Err("Cookies has no cookies table".into());
    }
    let mut version = 0;
    if db.table_exists("meta") {
        let _ = db.query(
            "SELECT CAST(value AS INTEGER) AS version FROM meta WHERE key='version'",
            |row| {
                version = row.int("version").unwrap_or(0);
                false
            },
        );
    }
    let host_hashed = version >= 24;
    let mut out = Outcome::default();
    db.query("SELECT * FROM cookies", |row| {
        let (Some(host), Some(name)) = (row.text("host_key"), row.text("name")) else {
            return true;
        };
        let flag = |names: &[&str]| names.iter().find_map(|n| row.int(n)).map(|v| v != 0);
        let persistent = flag(&["has_expires", "is_persistent", "persistent"]).unwrap_or(true);
        let expires = if persistent {
            row.int("expires_utc").and_then(webkit_to_unix_ms)
        } else {
            None
        };
        if expires.is_some_and(|at| at < now_ms) {
            return true;
        }
        let plain = row.blob("value").unwrap_or_default();
        let encrypted = row.blob("encrypted_value").unwrap_or_default();
        let value = match (plain.is_empty(), encrypted.is_empty()) {
            (false, false) => {
                out.undecryptable += 1;
                return true;
            }
            (false, true) => Zeroizing::new(String::from_utf8_lossy(&plain).into_owned()),
            (true, false) => match decrypt(&encrypted, key, host_hashed.then_some(host.as_str())) {
                Some(value) => value,
                None => {
                    out.undecryptable += 1;
                    return true;
                }
            },
            (true, true) => Zeroizing::new(String::new()),
        };
        let top_frame = row.text("top_frame_site_key").unwrap_or_default();
        let port = row.int("source_port").unwrap_or(-1);
        out.items.push(Cookie {
            domain: host,
            name,
            value,
            path: row
                .text("path")
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| "/".into()),
            created: row.int("creation_utc").and_then(webkit_to_unix_ms),
            expires,
            last_access: row.int("last_access_utc").and_then(webkit_to_unix_ms),
            secure: flag(&["is_secure", "secure"]).unwrap_or(false),
            http_only: flag(&["is_httponly", "httponly"]).unwrap_or(false),
            same_site: same_site(row.int("samesite").or_else(|| row.int("firstpartyonly"))),
            priority: priority(row.int("priority")),
            source_scheme: source_scheme(row.int("source_scheme")),
            source_port: if (0..=65535).contains(&port) {
                port
            } else {
                -1
            },
            partition: (!top_frame.is_empty()).then(|| {
                (
                    top_frame,
                    row.int("has_cross_site_ancestor").unwrap_or(0) != 0,
                )
            }),
        });
        true
    })?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_readers::fixture;

    fn fixture_key() -> Key {
        let secrets: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture("secrets.json")).unwrap()).unwrap();
        derive_key(
            secrets["chromiumSafeStorageSecret"]
                .as_str()
                .unwrap()
                .as_bytes(),
        )
    }

    fn chrome() -> std::path::PathBuf {
        fixture("home/Library/Application Support/Google/Chrome/Default")
    }

    #[test]
    fn the_key_derives_like_chromium() {
        let secrets: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture("secrets.json")).unwrap()).unwrap();
        let hex: String = fixture_key().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, secrets["chromiumKeyHex"].as_str().unwrap());
    }

    #[test]
    fn wrong_keys_fail_and_legacy_plaintext_passes() {
        let wrong = derive_key(b"nope");
        let mut value = b"v10".to_vec();
        value.extend([1u8; 16]);
        assert!(decrypt(&value, &wrong, None).is_none());
        assert_eq!(
            decrypt(b"plain", &wrong, None)
                .as_deref()
                .map(String::as_str),
            Some("plain")
        );
    }

    #[test]
    fn logins_decrypt_and_dedupe_across_the_account_store() {
        let outcome = logins(&chrome(), &fixture_key()).unwrap();
        let pairs: Vec<String> = outcome
            .items
            .iter()
            .map(|c| format!("{}@{}={}", c.username, c.url, c.password.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                "alex@example.com@https://accounts.example.com/login=correct horse",
                "alex@https://shop.example/=pässwörd 🔑",
                "alex@android://hash@com.example.app/=from-android",
                "old@https://legacy.example/=plain-legacy",
                "sam@https://account-only.example/=only-in-account",
            ]
        );
        assert_eq!(outcome.undecryptable, 1);
        assert_eq!(
            outcome.items[0].realm.as_deref(),
            Some("https://accounts.example.com/")
        );
    }

    #[test]
    fn cookies_decrypt_with_the_profile_key() {
        let outcome = cookies(&chrome(), &fixture_key(), 0.0).unwrap();
        assert!(!outcome.items.is_empty());
        assert!(
            outcome
                .items
                .iter()
                .all(|c| !c.domain.is_empty() && c.path.starts_with('/'))
        );
    }

    #[test]
    fn browsers_name_their_keychain_items() {
        assert_eq!(
            keychain_service("chrome").as_deref(),
            Some("Chrome Safe Storage")
        );
        assert_eq!(keychain_service("arc").as_deref(), Some("Arc Safe Storage"));
        assert_eq!(keychain_service("safari"), None);
    }
}
