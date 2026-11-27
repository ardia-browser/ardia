use std::collections::BTreeMap;
use std::path::PathBuf;

use parking_lot::Mutex;

pub const PLUGIN_KEYCHAIN_SERVICE: &str = "Ardia Plugins";
pub const ISOLATED_FILE: &str = "Plugin Secrets.json";
pub const MAX_KEYS: usize = 64;
pub const MAX_VALUE_BYTES: usize = 16 * 1024;

pub fn is_secret_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn secret_account(plugin: &str, key: &str) -> String {
    format!("ardia.plugin.{plugin}.{key}")
}

pub fn index_account(plugin: &str) -> String {
    format!("ardia.plugin-index.{plugin}")
}

pub struct PluginSecrets {
    isolated: Option<PathBuf>,
    lock: Mutex<()>,
}

impl PluginSecrets {
    pub fn keychain() -> Self {
        PluginSecrets {
            isolated: None,
            lock: Mutex::new(()),
        }
    }

    pub fn isolated(dir: PathBuf) -> Self {
        PluginSecrets {
            isolated: Some(dir.join(ISOLATED_FILE)),
            lock: Mutex::new(()),
        }
    }

    fn load(path: &PathBuf) -> Option<BTreeMap<String, String>> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).ok(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(BTreeMap::new()),
            Err(_) => None,
        }
    }

    fn read(&self, account: &str) -> Result<Option<String>, String> {
        match &self.isolated {
            Some(path) => Ok(Self::load(path)
                .ok_or("The secrets file can't be read.")?
                .get(account)
                .cloned()),
            None => keychain::get(account),
        }
    }

    fn write(&self, account: &str, value: Option<&str>) -> Result<(), String> {
        match &self.isolated {
            Some(path) => {
                let mut all = Self::load(path).ok_or("The secrets file can't be read.")?;
                match value {
                    Some(value) => all.insert(account.to_owned(), value.to_owned()),
                    None => all.remove(account),
                };
                let json = serde_json::to_vec(&all).map_err(|e| e.to_string())?;
                let staged = path.with_extension("json.tmp");
                std::fs::write(&staged, json)
                    .and_then(|_| std::fs::rename(&staged, path))
                    .map_err(|e| e.to_string())
            }
            None => match value {
                Some(value) => keychain::set(account, value),
                None => keychain::delete(account),
            },
        }
    }

    fn index(&self, plugin: &str) -> Result<Vec<String>, String> {
        match self.read(&index_account(plugin))? {
            None => Ok(Vec::new()),
            Some(text) => serde_json::from_str(&text)
                .map_err(|_| "The Keychain's list of this plugin's secrets can't be read, so Ardia leaves it alone.".to_owned()),
        }
    }

    pub fn keys(&self, plugin: &str) -> Result<Vec<String>, String> {
        let _guard = self.lock.lock();
        self.index(plugin)
    }

    pub fn get(&self, plugin: &str, key: &str) -> Result<Option<String>, String> {
        let _guard = self.lock.lock();
        self.read(&secret_account(plugin, key))
    }

    pub fn set(&self, plugin: &str, key: &str, value: &str) -> Result<(), String> {
        let _guard = self.lock.lock();
        let mut index = self.index(plugin)?;
        if !index.iter().any(|k| k == key) {
            if index.len() >= MAX_KEYS {
                return Err(format!("A plugin keeps at most {MAX_KEYS} secrets."));
            }
            index.push(key.to_owned());
            self.write(
                &index_account(plugin),
                Some(&serde_json::to_string(&index).unwrap_or_default()),
            )?;
        }
        self.write(&secret_account(plugin, key), Some(value))
    }

    pub fn delete(&self, plugin: &str, key: &str) -> Result<(), String> {
        let _guard = self.lock.lock();
        self.write(&secret_account(plugin, key), None)?;
        let mut index = self.index(plugin)?;
        index.retain(|k| k != key);
        self.write(
            &index_account(plugin),
            Some(&serde_json::to_string(&index).unwrap_or_default()),
        )
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::PLUGIN_KEYCHAIN_SERVICE;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    const NOT_FOUND: i32 = -25300;

    pub fn get(account: &str) -> Result<Option<String>, String> {
        match get_generic_password(PLUGIN_KEYCHAIN_SERVICE, account) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(format!("The Keychain refused: {e}")),
        }
    }

    pub fn set(account: &str, value: &str) -> Result<(), String> {
        set_generic_password(PLUGIN_KEYCHAIN_SERVICE, account, value.as_bytes())
            .map_err(|e| format!("The Keychain refused: {e}"))
    }

    pub fn delete(account: &str) -> Result<(), String> {
        match delete_generic_password(PLUGIN_KEYCHAIN_SERVICE, account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == NOT_FOUND => Ok(()),
            Err(e) => Err(format!("The Keychain refused: {e}")),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    pub fn get(_: &str) -> Result<Option<String>, String> {
        Err("Secrets aren't available here.".into())
    }

    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err("Secrets aren't available here.".into())
    }

    pub fn delete(_: &str) -> Result<(), String> {
        Err("Secrets aren't available here.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_secrets_round_trip_with_an_index() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = PluginSecrets::isolated(dir.path().to_path_buf());
        assert_eq!(secrets.get("p", "token").unwrap(), None);
        secrets.set("p", "token", "abc").unwrap();
        assert_eq!(secrets.get("p", "token").unwrap().as_deref(), Some("abc"));
        assert_eq!(secrets.index("p").unwrap(), vec!["token"]);
        secrets.delete("p", "token").unwrap();
        assert_eq!(secrets.get("p", "token").unwrap(), None);
        assert!(secrets.index("p").unwrap().is_empty());
        assert!(is_secret_key("api_key-2"));
        assert!(!is_secret_key("bad key"));
    }
}
