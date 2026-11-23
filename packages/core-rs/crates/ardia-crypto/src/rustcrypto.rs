use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{Crypto, CryptoError, DIGEST_BYTES, KEY_BYTES, NONCE_BYTES};

pub struct RustCrypto;

impl Crypto for RustCrypto {
    fn sha256(data: &[u8]) -> [u8; DIGEST_BYTES] {
        Sha256::digest(data).into()
    }

    fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; DIGEST_BYTES] {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes keys of any length");
        for part in parts {
            mac.update(part);
        }
        mac.finalize().into_bytes().into()
    }

    fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], out: &mut [u8]) -> Result<(), CryptoError> {
        hkdf::Hkdf::<Sha256>::new(Some(salt), ikm)
            .expand(info, out)
            .map_err(|_| CryptoError::Length)
    }

    fn aes256gcm_seal(
        key: &[u8; KEY_BYTES],
        nonce: &[u8; NONCE_BYTES],
        aad: &[u8],
        plain: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
            .encrypt(Nonce::from_slice(nonce), Payload { msg: plain, aad })
            .map_err(|_| CryptoError::Length)
    }

    fn aes256gcm_open(
        key: &[u8; KEY_BYTES],
        nonce: &[u8; NONCE_BYTES],
        aad: &[u8],
        sealed: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
            .decrypt(Nonce::from_slice(nonce), Payload { msg: sealed, aad })
            .map(Zeroizing::new)
            .map_err(|_| CryptoError::Authentication)
    }

    fn fill_random(out: &mut [u8]) -> Result<(), CryptoError> {
        getrandom::getrandom(out).map_err(|_| CryptoError::Random)
    }

    #[cfg(feature = "ed25519")]
    fn ed25519_verify(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
        use ed25519_dalek::{Signature, VerifyingKey};
        if crate::small_order::has_small_order_key_or_r(public_key, signature) {
            return false;
        }
        VerifyingKey::from_bytes(public_key)
            .map(|key| key.verify_strict(message, &Signature::from_bytes(signature)).is_ok())
            .unwrap_or(false)
    }
}
