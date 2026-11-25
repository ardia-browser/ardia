use bssl_crypto::aead::{Aead, Aes256Gcm};
use bssl_crypto::digest::Sha256;
use bssl_crypto::hkdf::{HkdfSha256, Salt};
use bssl_crypto::hmac::HmacSha256;
use zeroize::Zeroizing;

use crate::{Crypto, CryptoError, DIGEST_BYTES, KEY_BYTES, NONCE_BYTES};

pub struct BoringSsl;

fn salt(bytes: &[u8]) -> Salt<'_> {
    if bytes.is_empty() {
        Salt::None
    } else {
        Salt::NonEmpty(bytes)
    }
}

impl Crypto for BoringSsl {
    fn sha256(data: &[u8]) -> [u8; DIGEST_BYTES] {
        Sha256::hash(data)
    }

    fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; DIGEST_BYTES] {
        let mut mac = HmacSha256::new_from_slice(key);
        for part in parts {
            mac.update(part);
        }
        mac.digest()
    }

    fn hkdf_sha256(ikm: &[u8], salt_bytes: &[u8], info: &[u8], out: &mut [u8]) -> Result<(), CryptoError> {
        HkdfSha256::derive_into(ikm, salt(salt_bytes), info, out).map_err(|_| CryptoError::Length)
    }

    fn aes256gcm_seal(
        key: &[u8; KEY_BYTES],
        nonce: &[u8; NONCE_BYTES],
        aad: &[u8],
        plain: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        Ok(Aes256Gcm::new(key).seal(nonce, plain, aad))
    }

    fn aes256gcm_open(
        key: &[u8; KEY_BYTES],
        nonce: &[u8; NONCE_BYTES],
        aad: &[u8],
        sealed: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        Aes256Gcm::new(key)
            .open(nonce, sealed, aad)
            .map(Zeroizing::new)
            .ok_or(CryptoError::Authentication)
    }

    fn fill_random(out: &mut [u8]) -> Result<(), CryptoError> {
        bssl_crypto::rand_bytes(out);
        Ok(())
    }

    #[cfg(feature = "ed25519")]
    fn ed25519_verify(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
        if crate::small_order::has_small_order_key_or_r(public_key, signature) {
            return false;
        }
        bssl_crypto::ed25519::PublicKey::from_bytes(public_key)
            .verify(message, signature)
            .is_ok()
    }
}
