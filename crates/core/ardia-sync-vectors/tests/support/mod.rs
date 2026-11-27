#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use std::cell::Cell;

use ardia_crypto::{Backend, Crypto, CryptoError, DIGEST_BYTES, KEY_BYTES, NONCE_BYTES};
use ardia_sync_core::{Error, SyncKeysWith};
use base64::Engine;
use serde_json::Value;
use zeroize::Zeroizing;

pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize()
        .unwrap()
}

pub fn fixtures() -> PathBuf {
    repo().join("packages/sync/tests/fixtures")
}

pub fn vectors() -> PathBuf {
    fixtures().join("sync-vectors")
}

pub fn json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).unwrap()
}

pub fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

pub fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn base64_decode(text: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(text).unwrap()
}

pub fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn str<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing string {key} in {value}"))
}

pub fn entropy32(text: &str) -> [u8; 32] {
    hex(text).try_into().unwrap()
}

pub fn tree(folder: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, folder: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = fs::read_dir(folder) else { return };
        for entry in entries {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(relative, fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(folder, folder, &mut out);
    out
}

pub fn names(folder: &Path) -> Vec<String> {
    match fs::read_dir(folder) {
        Ok(entries) => entries
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

thread_local! {
    static QUEUED_NONCE: Cell<Option<[u8; NONCE_BYTES]>> = const { Cell::new(None) };
}

pub struct FixtureCrypto;

impl Crypto for FixtureCrypto {
    fn sha256(data: &[u8]) -> [u8; DIGEST_BYTES] {
        Backend::sha256(data)
    }

    fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; DIGEST_BYTES] {
        Backend::hmac_sha256(key, parts)
    }

    fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], out: &mut [u8]) -> Result<(), CryptoError> {
        Backend::hkdf_sha256(ikm, salt, info, out)
    }

    fn aes256gcm_seal(
        key: &[u8; KEY_BYTES],
        nonce: &[u8; NONCE_BYTES],
        aad: &[u8],
        plain: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        Backend::aes256gcm_seal(key, nonce, aad, plain)
    }

    fn aes256gcm_open(
        key: &[u8; KEY_BYTES],
        nonce: &[u8; NONCE_BYTES],
        aad: &[u8],
        sealed: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        Backend::aes256gcm_open(key, nonce, aad, sealed)
    }

    fn fill_random(out: &mut [u8]) -> Result<(), CryptoError> {
        match QUEUED_NONCE.with(Cell::take) {
            Some(nonce) => {
                assert_eq!(
                    out.len(),
                    NONCE_BYTES,
                    "a queued fixture nonce must be the next random draw"
                );
                out.copy_from_slice(&nonce);
                Ok(())
            }
            None => Backend::fill_random(out),
        }
    }

    fn ed25519_verify(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
        Backend::ed25519_verify(public_key, message, signature)
    }
}

pub type FixtureKeys = SyncKeysWith<FixtureCrypto>;

pub fn seal_fixed(
    keys: &FixtureKeys,
    payload: &[u8],
    scope_tag: &str,
    file_id: &str,
    nonce: &[u8; NONCE_BYTES],
) -> Result<Vec<u8>, Error> {
    QUEUED_NONCE.with(|queued| queued.set(Some(*nonce)));
    let sealed = keys.seal(payload, scope_tag, file_id);
    assert!(
        QUEUED_NONCE.with(Cell::get).is_none(),
        "seal didn't draw the queued nonce"
    );
    sealed
}

pub fn read_scope<C: Crypto>(vault: &Path, keys: &SyncKeysWith<C>, scope: &str) -> ScopeRead {
    let folder = vault.join(keys.chain_tag()).join(keys.scope_tag(scope));
    let names = names(&folder);
    let listing = ardia_sync_core::vault::list(names.iter().map(String::as_str), &[]);
    let mut read = ScopeRead {
        pending: listing.pending,
        present: listing.present,
        ..ScopeRead::default()
    };
    let scope_tag = keys.scope_tag(scope);
    for id in listing.open {
        let data = fs::read(folder.join(ardia_sync_core::vault::file_name(&id))).unwrap();
        match keys.open(&data, &scope_tag, &id) {
            Ok(payload) => read.files.push((id, payload.to_vec())),
            Err(_) => read.damaged.push(id),
        }
    }
    read
}

#[derive(Default, Debug)]
pub struct ScopeRead {
    pub files: Vec<(String, Vec<u8>)>,
    pub damaged: Vec<String>,
    pub pending: Vec<String>,
    pub present: Vec<String>,
}
