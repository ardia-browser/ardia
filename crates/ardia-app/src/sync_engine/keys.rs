use std::io::Write;
use std::path::{Path, PathBuf};

use ardia_state::sync_engine::sync_core::SyncKeys;
use parking_lot::Mutex;
use zeroize::Zeroizing;

pub const KEYCHAIN_SERVICE: &str = "Ardia Sync Key";
pub const ENTROPY_BYTES: usize = 32;

pub trait KeyStore: Send + Sync {
    fn load(&self, account: &str) -> Option<Zeroizing<Vec<u8>>>;
    fn save(&self, secret: &[u8], account: &str) -> bool;
    fn delete(&self, account: &str);
}

pub struct FileKeyStore {
    directory: PathBuf,
}

impl FileKeyStore {
    pub fn new(directory: &Path) -> Self {
        FileKeyStore {
            directory: directory.to_path_buf(),
        }
    }

    fn path(&self, account: &str) -> Option<PathBuf> {
        let plain = !account.is_empty()
            && account
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        plain.then(|| self.directory.join(format!("sync-key-{account}")))
    }
}

impl KeyStore for FileKeyStore {
    fn load(&self, account: &str) -> Option<Zeroizing<Vec<u8>>> {
        std::fs::read(self.path(account)?).ok().map(Zeroizing::new)
    }

    fn save(&self, secret: &[u8], account: &str) -> bool {
        let Some(target) = self.path(account) else {
            return false;
        };
        if std::fs::create_dir_all(&self.directory).is_err() {
            return false;
        }
        let staging = self
            .directory
            .join(format!(".sync-key-{}", uuid::Uuid::new_v4()));
        let written = (|| -> std::io::Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
            }
            let mut file = options.open(&staging)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            }
            file.write_all(secret)?;
            file.sync_all()?;
            std::fs::rename(&staging, &target)
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&staging);
            return false;
        }
        true
    }

    fn delete(&self, account: &str) {
        if let Some(path) = self.path(account) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(target_os = "macos")]
pub struct KeychainKeyStore {
    service: String,
}

#[cfg(target_os = "macos")]
impl KeychainKeyStore {
    pub fn new(service: &str) -> Self {
        KeychainKeyStore {
            service: service.to_owned(),
        }
    }
}

#[cfg(target_os = "macos")]
impl KeyStore for KeychainKeyStore {
    fn load(&self, account: &str) -> Option<Zeroizing<Vec<u8>>> {
        use security_framework::passwords::{PasswordOptions, generic_password};
        let options = PasswordOptions::new_generic_password(&self.service, account);
        generic_password(options).ok().map(Zeroizing::new)
    }

    fn save(&self, secret: &[u8], account: &str) -> bool {
        use security_framework::access_control::{ProtectionMode, SecAccessControl};
        use security_framework::passwords::{PasswordOptions, set_generic_password_options};
        let options = |protected: bool| {
            let mut options = PasswordOptions::new_generic_password(&self.service, account);
            options.set_label(&self.service);
            options.set_access_synchronized(Some(false));
            if protected
                && let Ok(control) = SecAccessControl::create_with_protection(
                    Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
                    0,
                )
            {
                options.set_access_control(control);
            }
            options
        };
        set_generic_password_options(secret, options(true)).is_ok()
            || set_generic_password_options(secret, options(false)).is_ok()
    }

    fn delete(&self, account: &str) {
        use security_framework::passwords::{PasswordOptions, delete_generic_password_options};
        let options = PasswordOptions::new_generic_password(&self.service, account);
        let _ = delete_generic_password_options(options);
    }
}

pub fn uses_keychain(data_dir: &Path, scratch: bool) -> bool {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let default = crate::cli::default_data_dir(home.as_deref(), &|name| std::env::var(name).ok());
    !scratch && data_dir == default
}

pub fn store_for(data_dir: &Path, scratch: bool) -> Box<dyn KeyStore> {
    #[cfg(target_os = "macos")]
    if uses_keychain(data_dir, scratch) {
        return Box::new(KeychainKeyStore::new(KEYCHAIN_SERVICE));
    }
    Box::new(FileKeyStore::new(data_dir))
}

#[derive(Default)]
struct Held {
    entropy: Option<Zeroizing<[u8; ENTROPY_BYTES]>>,
    keys: Option<std::sync::Arc<SyncKeys>>,
    local_unreadable: bool,
}

#[derive(Default)]
pub struct KeyState {
    held: Mutex<Held>,
}

impl KeyState {
    pub fn set(&self, entropy: Option<&[u8]>) {
        let mut held = self.held.lock();
        held.local_unreadable = false;
        let Some(bytes) = entropy.filter(|b| b.len() == ENTROPY_BYTES) else {
            held.entropy = None;
            held.keys = None;
            return;
        };
        let mut fixed = Zeroizing::new([0u8; ENTROPY_BYTES]);
        fixed.copy_from_slice(bytes);
        held.keys = Some(std::sync::Arc::new(SyncKeys::new(&fixed[..])));
        held.entropy = Some(fixed);
    }

    pub fn keys(&self) -> Option<std::sync::Arc<SyncKeys>> {
        self.held.lock().keys.clone()
    }

    pub fn words(&self) -> Option<Vec<String>> {
        let held = self.held.lock();
        let entropy = held.entropy.as_ref()?;
        Some(
            ardia_state::sync_engine::sync_core::phrase::words(entropy)
                .iter()
                .map(|w| (*w).to_owned())
                .collect(),
        )
    }

    pub fn mark_local_unreadable(&self) {
        self.held.lock().local_unreadable = true;
    }

    pub fn local_unreadable(&self) -> bool {
        self.held.lock().local_unreadable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_instances_keep_the_key_in_a_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileKeyStore::new(dir.path());
        assert!(store.save(&[7u8; 32], "DEVICE1"));
        assert!(store.save(&[8u8; 32], "DEVICE1"));
        assert_eq!(store.load("DEVICE1").unwrap().as_slice(), &[8u8; 32]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("sync-key-DEVICE1"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["sync-key-DEVICE1"]);
        assert!(!store.save(&[1], "../escape"));
        store.delete("DEVICE1");
        assert!(store.load("DEVICE1").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "touches the login keychain under a test service name"]
    fn the_keychain_store_round_trips_under_a_test_service() {
        let store = KeychainKeyStore::new("Ardia Sync Key Test w9");
        assert!(store.save(&[3u8; 32], "TESTACCOUNT"));
        assert_eq!(store.load("TESTACCOUNT").unwrap().as_slice(), &[3u8; 32]);
        store.delete("TESTACCOUNT");
        assert!(store.load("TESTACCOUNT").is_none());
    }

    #[test]
    fn only_the_real_data_folder_uses_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!uses_keychain(dir.path(), false));
        assert!(!uses_keychain(dir.path(), true));
    }

    #[test]
    fn key_state_hands_out_words_and_keys() {
        let state = KeyState::default();
        assert!(state.keys().is_none());
        state.set(Some(&[0u8; 32]));
        let words = state.words().unwrap();
        assert_eq!(words.len(), 24);
        assert_eq!(words[0], "abandon");
        assert_eq!(words[23], "art");
        state.set(Some(&[1u8; 3]));
        assert!(state.keys().is_none());
    }
}
