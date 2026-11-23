#![forbid(unsafe_code)]

use zeroize::Zeroizing;

pub const KEY_BYTES: usize = 32;
pub const NONCE_BYTES: usize = 12;
pub const TAG_BYTES: usize = 16;
pub const DIGEST_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    Authentication,
    Length,
    Random,
}

pub trait Crypto {
    fn sha256(data: &[u8]) -> [u8; DIGEST_BYTES];

    fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; DIGEST_BYTES];

    fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], out: &mut [u8]) -> Result<(), CryptoError>;

    fn aes256gcm_seal(
        key: &[u8; KEY_BYTES],
        nonce: &[u8; NONCE_BYTES],
        aad: &[u8],
        plain: &[u8],
    ) -> Result<Vec<u8>, CryptoError>;

    fn aes256gcm_open(
        key: &[u8; KEY_BYTES],
        nonce: &[u8; NONCE_BYTES],
        aad: &[u8],
        sealed: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, CryptoError>;

    fn fill_random(out: &mut [u8]) -> Result<(), CryptoError>;

    #[cfg(feature = "ed25519")]
    fn ed25519_verify(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool;
}

#[cfg(feature = "rustcrypto")]
mod rustcrypto;

#[cfg(feature = "rustcrypto")]
pub use rustcrypto::RustCrypto;

#[cfg(feature = "boringssl")]
mod boringssl;

#[cfg(feature = "ed25519")]
mod small_order;

#[cfg(feature = "boringssl")]
pub use boringssl::BoringSsl;

#[cfg(feature = "boringssl")]
pub type Backend = BoringSsl;

#[cfg(all(feature = "rustcrypto", not(feature = "boringssl")))]
pub type Backend = RustCrypto;

#[cfg(not(any(feature = "rustcrypto", feature = "boringssl")))]
compile_error!(
    "ardia-crypto needs a backend: enable the `rustcrypto` feature, or `boringssl` inside Chromium's GN build"
);
