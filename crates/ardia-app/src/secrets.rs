use std::collections::BTreeMap;
use std::path::PathBuf;

use parking_lot::Mutex;

pub const KEYCHAIN_SERVICE: &str = "Ardia Connected Accounts";
pub const ISOLATED_FILE: &str = "Connected Accounts.json";

pub struct SecretStore {
    isolated: Option<PathBuf>,
    lock: Mutex<()>,
}

impl SecretStore {
    pub fn keychain() -> SecretStore {
        SecretStore {
            isolated: None,
            lock: Mutex::new(()),
        }
    }

    pub fn isolated(dir: PathBuf) -> SecretStore {
        SecretStore {
            isolated: Some(dir.join(ISOLATED_FILE)),
            lock: Mutex::new(()),
        }
    }

    pub fn for_launch() -> SecretStore {
        match std::env::var_os(crate::cli::DATA_DIR_ENV).filter(|d| !d.is_empty()) {
            Some(dir) => SecretStore::isolated(PathBuf::from(dir)),
            None => SecretStore::keychain(),
        }
    }

    fn load(&self, path: &PathBuf) -> Option<BTreeMap<String, String>> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).ok(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(BTreeMap::new()),
            Err(_) => None,
        }
    }

    fn strict_kind(&self) -> ardia_profile::strict::Blocking {
        if self.isolated.is_some() {
            ardia_profile::strict::Blocking::File
        } else {
            ardia_profile::strict::Blocking::Keychain
        }
    }

    fn save(&self, path: &PathBuf, all: &BTreeMap<String, String>) -> bool {
        let Ok(json) = serde_json::to_vec_pretty(all) else {
            return false;
        };
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, json).is_ok() && std::fs::rename(&temp, path).is_ok()
    }

    #[cfg_attr(debug_assertions, track_caller)]
    pub fn get(&self, account: &str) -> Option<String> {
        let _guard = ardia_profile::strict::lock(|| self.lock.lock());
        ardia_profile::strict::blocking(self.strict_kind());
        match &self.isolated {
            Some(path) => self.load(path)?.get(account).cloned(),
            None => keychain::get(account),
        }
    }

    #[cfg_attr(debug_assertions, track_caller)]
    pub fn set(&self, account: &str, secret: &str) -> bool {
        let _guard = ardia_profile::strict::lock(|| self.lock.lock());
        ardia_profile::strict::blocking(self.strict_kind());
        match &self.isolated {
            Some(path) => {
                let Some(mut all) = self.load(path) else {
                    return false;
                };
                all.insert(account.to_owned(), secret.to_owned());
                self.save(path, &all)
            }
            None => keychain::set(account, secret),
        }
    }

    #[cfg_attr(debug_assertions, track_caller)]
    pub fn delete(&self, account: &str) -> bool {
        let _guard = ardia_profile::strict::lock(|| self.lock.lock());
        ardia_profile::strict::blocking(self.strict_kind());
        match &self.isolated {
            Some(path) => {
                let Some(mut all) = self.load(path) else {
                    return false;
                };
                all.remove(account);
                self.save(path, &all)
            }
            None => keychain::delete(account),
        }
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    use super::KEYCHAIN_SERVICE;

    const NOT_FOUND: i32 = -25300;

    pub fn get(account: &str) -> Option<String> {
        let bytes = get_generic_password(KEYCHAIN_SERVICE, account).ok()?;
        String::from_utf8(bytes).ok().filter(|s| !s.is_empty())
    }

    pub fn set(account: &str, secret: &str) -> bool {
        set_generic_password(KEYCHAIN_SERVICE, account, secret.as_bytes()).is_ok()
    }

    pub fn delete(account: &str) -> bool {
        match delete_generic_password(KEYCHAIN_SERVICE, account) {
            Ok(()) => true,
            Err(e) => e.code() == NOT_FOUND,
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    pub fn get(_account: &str) -> Option<String> {
        None
    }

    pub fn set(_account: &str, _secret: &str) -> bool {
        false
    }

    pub fn delete(_account: &str) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_store_round_trips_without_touching_the_keychain() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let store = SecretStore::isolated(dir.path().to_path_buf());
        assert_eq!(store.get("github"), None);
        assert!(store.set("github", "tok"));
        assert_eq!(store.get("github").as_deref(), Some("tok"));
        assert!(dir.path().join(ISOLATED_FILE).exists());
        assert!(store.delete("github"));
        assert_eq!(store.get("github"), None);
    }
}
