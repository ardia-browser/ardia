#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use ardia_shell_migration::credentials::{self, StoredCredential};
use ardia_shell_migration::{names, Layout, Sealer, Vault};
use zeroize::Zeroizing;

pub fn long_path(path: &Path) -> PathBuf {
    if cfg!(windows) && !path.to_string_lossy().starts_with(r"\\?\") {
        PathBuf::from(format!(r"\\?\{}", path.display()))
    } else {
        path.to_path_buf()
    }
}

pub struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new(label: &str) -> Scratch {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ardia-shell-migration-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Scratch(plain_path(fs::canonicalize(&path).unwrap()))
    }
}

fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub struct FakeDpapi {
    pub seals: RefCell<u64>,
}

impl FakeDpapi {
    pub fn new() -> FakeDpapi {
        FakeDpapi { seals: RefCell::new(0) }
    }
}

const SEAL_TAG: &[u8] = b"FAKEDPAPI1";

impl Sealer for FakeDpapi {
    fn seal(&self, plain: &[u8], purpose: &str) -> io::Result<Vec<u8>> {
        *self.seals.borrow_mut() += 1;
        let mut nonce = [0u8; 8];
        getrandom_fill(&mut nonce);
        let mut sealed = SEAL_TAG.to_vec();
        sealed.extend_from_slice(&(purpose.len() as u32).to_le_bytes());
        sealed.extend_from_slice(purpose.as_bytes());
        sealed.extend_from_slice(&nonce);
        sealed.extend(plain.iter().enumerate().map(|(i, b)| b ^ nonce[i % 8] ^ 0x5a));
        Ok(sealed)
    }

    fn open(&self, sealed: &[u8], purpose: &str) -> Option<Zeroizing<Vec<u8>>> {
        let rest = sealed.strip_prefix(SEAL_TAG)?;
        let length = u32::from_le_bytes(rest.get(..4)?.try_into().ok()?) as usize;
        let stored = rest.get(4..4 + length)?;
        if stored != purpose.as_bytes() {
            return None;
        }
        let nonce = rest.get(4 + length..12 + length)?;
        let body = rest.get(12 + length..)?;
        Some(Zeroizing::new(
            body.iter().enumerate().map(|(i, b)| b ^ nonce[i % 8] ^ 0x5a).collect(),
        ))
    }
}

fn getrandom_fill(bytes: &mut [u8]) {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let value = COUNTER.fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::SeqCst);
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = (value >> ((i % 8) * 8)) as u8;
    }
}

pub fn owner_of(target: &str) -> String {
    let account = target.rsplit('/').next().unwrap_or("");
    let Some((head, index)) = account.rsplit_once('#') else {
        return account.to_string();
    };
    if index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
        return account.to_string();
    }
    head.strip_suffix("#g1")
        .or_else(|| head.strip_suffix("#g2"))
        .unwrap_or(head)
        .to_string()
}

pub type VaultItem = (String, Option<String>, Option<String>, Vec<u8>);

pub struct FakeVault {
    pub items: Vec<VaultItem>,
    pub fail: bool,
    pub lists: RefCell<u64>,
}

impl FakeVault {
    pub fn empty() -> FakeVault {
        FakeVault {
            items: Vec::new(),
            fail: false,
            lists: RefCell::new(0),
        }
    }

    pub fn add_rnw(&mut self, prefix: &str, account: &str, secret: &[u8], generation: usize) {
        for stored in credentials::rnw_layout(prefix, account, secret, generation) {
            self.items
                .push((stored.target, stored.comment, stored.user, stored.blob.to_vec()));
        }
    }

    pub fn add(&mut self, target: &str, comment: Option<&str>, blob: &[u8]) {
        let user = Some(credentials::rnw_user(&owner_of(target)));
        self.items
            .push((target.into(), comment.map(Into::into), user, blob.to_vec()));
    }

    pub fn snapshot(&self) -> Vec<VaultItem> {
        self.items.clone()
    }
}

impl Vault for FakeVault {
    fn list(&self, prefix: &str) -> io::Result<Vec<StoredCredential>> {
        *self.lists.borrow_mut() += 1;
        if self.fail {
            return Err(io::Error::other("no logon session"));
        }
        Ok(self
            .items
            .iter()
            .filter(|(target, _, _, _)| target.starts_with(prefix))
            .map(|(target, comment, user, blob)| StoredCredential {
                target: target.clone(),
                comment: comment.clone(),
                user: user.clone(),
                blob: Zeroizing::new(blob.clone()),
            })
            .collect())
    }
}

pub fn layout(root: &Path) -> Layout {
    Layout::standard(&root.join("Local"), &root.join("Roaming"), false)
}

pub fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

pub fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut found = BTreeMap::new();
    walk(root, root, &mut found);
    found
}

fn walk(root: &Path, dir: &Path, found: &mut BTreeMap<String, Vec<u8>>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries {
        let entry = entry.unwrap();
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).unwrap();
        let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if meta.file_type().is_symlink() {
            found.insert(format!("{relative} -> link"), Vec::new());
        } else if meta.is_dir() {
            found.insert(format!("{relative}/"), Vec::new());
            walk(root, &path, found);
        } else {
            found.insert(relative, fs::read(&path).unwrap());
        }
    }
}

pub const PREFIX: &str = "Ardia Connected Accounts/";

pub struct Populated {
    pub layout: Layout,
    pub vault: FakeVault,
    pub secrets: BTreeMap<String, Vec<u8>>,
}

pub fn big_secret(length: usize, seed: u8) -> Vec<u8> {
    (0..length)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

pub fn populate(root: &Path, sealer: &FakeDpapi) -> Populated {
    let layout = layout(root);
    let rnw = &layout.rnw_data;
    write(&rnw.join("session.json"), br#"{"version":7,"tabs":[{"id":"t1"}]}"#);
    write(&rnw.join("history-index.json"), b"{\"pages\":3}");
    write(&rnw.join(names::PLACEMENT_NAME), b"1 2 1280 800 0");
    write(&rnw.join("dialog.json"), b"{}");
    write(&rnw.join("menu.json"), b"{}");
    write(&rnw.join("activation.log"), b"log");
    write(&rnw.join("Ardia.png"), b"png");
    write(&rnw.join(".hidden.json"), b"dot");
    write(&rnw.join(".session.json.ABC.partial"), b"half");
    write(&rnw.join("Logs").join("launch.log"), b"launch");
    write(&rnw.join("Telemetry").join("local").join("2026-11-23.jsonl"), b"{}");
    write(&rnw.join("User Data").join("Default").join("Cookies"), b"cookie jar");
    write(&rnw.join("User Data").join("Local State"), b"{\"os_crypt\":{}}");
    write(&rnw.join("Sync").join("vault.nns"), b"not a key");
    let good = sealer.seal(&[7u8; 32], &names::sync_purpose("Abc_1", false)).unwrap();
    write(&rnw.join("Sync").join("sync-key-Abc_1.dpapi"), &good);
    let wrong_purpose = sealer.seal(&[9u8; 32], &names::sync_purpose("other", false)).unwrap();
    write(&rnw.join("Sync").join("sync-key-zzz.dpapi"), &wrong_purpose);
    let short = sealer.seal(&[1u8; 16], &names::sync_purpose("short", false)).unwrap();
    write(&rnw.join("Sync").join("sync-key-short.dpapi"), &short);
    write(&rnw.join("Sync").join("sync-key-bad name.dpapi"), &good);

    let config = &layout.rnw_config;
    write(&config.join("config.json"), b"{\"theme\":\"dusk\"}");
    write(&config.join("hooks.json"), b"{\"hooks\":[]}");
    write(&config.join("config.schema.json"), b"{}");
    write(&config.join("themes").join("dusk.json"), b"{\"name\":\"dusk\"}");
    write(&config.join("themes").join("Loud.json"), b"{}");
    write(&config.join("themes").join("notes.txt"), b"x");

    let mut vault = FakeVault::empty();
    let mut secrets = BTreeMap::new();
    let one = b"gho_short-token".to_vec();
    vault.add_rnw(PREFIX, "github", &one, 1);
    secrets.insert("github".to_string(), one);
    let three = big_secret(credentials::CHUNK_BYTES * 2 + 17, 3);
    vault.add_rnw(PREFIX, "google-oauth", &three, 2);
    vault.add(&format!("{PREFIX}google-oauth#g1#1"), None, b"stale generation");
    vault.add(&format!("{PREFIX}google-oauth#g1#2"), None, b"stale generation");
    secrets.insert("google-oauth".to_string(), three);
    let legacy = big_secret(credentials::CHUNK_BYTES + 1, 9);
    vault.add_rnw(PREFIX, "legacy", &legacy, 0);
    secrets.insert("legacy".to_string(), legacy);
    let exact = big_secret(credentials::CHUNK_BYTES, 5);
    vault.add_rnw(PREFIX, "Exact Edge", &exact, 1);
    secrets.insert("Exact Edge".to_string(), exact);
    vault.add_rnw(PREFIX, "torn", &big_secret(credentials::CHUNK_BYTES * 3, 1), 1);
    vault
        .items
        .retain(|(target, _, _, _)| target != &format!("{PREFIX}torn#g1#2"));
    vault.add_rnw("Ardia Connected Accounts [C:\\scratch]/", "github", b"scratch only", 1);
    vault.add("Other App/github", None, b"not ours");
    vault.add(&format!("{PREFIX}half-written#g1#1"), None, b"orphan continuation");
    Populated { layout, vault, secrets }
}
