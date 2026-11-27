#![deny(unsafe_code)]

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

pub fn wipe(bytes: &mut [u8]) {
    #[cfg(target_vendor = "apple")]
    apple::erase(bytes);
    #[cfg(not(target_vendor = "apple"))]
    zeroize::Zeroize::zeroize(bytes);
}

#[cfg(target_vendor = "apple")]
#[allow(unsafe_code)]
mod apple {
    use core::ffi::{c_int, c_void};

    extern "C" {
        fn memset_s(destination: *mut c_void, capacity: usize, value: c_int, count: usize) -> c_int;
    }

    pub fn erase(bytes: &mut [u8]) {
        if bytes.is_empty() {
            return;
        }
        let status = unsafe { memset_s(bytes.as_mut_ptr().cast(), bytes.len(), 0, bytes.len()) };
        if status != 0 {
            zeroize::Zeroize::zeroize(bytes);
        }
    }
}

pub struct Wiping(pub Vec<u8>);

impl Drop for Wiping {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
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

    fn aes256gcm_seal_in_place(
        key: &[u8; KEY_BYTES],
        nonce: &[u8; NONCE_BYTES],
        aad: &[u8],
        buffer: &mut Vec<u8>,
        start: usize,
    ) -> Result<(), CryptoError> {
        let sealed = Self::aes256gcm_seal(key, nonce, aad, &buffer[start..])?;
        buffer.truncate(start);
        buffer.extend_from_slice(&sealed);
        Ok(())
    }

    fn aes256gcm_open_in_place(
        key: &[u8; KEY_BYTES],
        nonce: &[u8; NONCE_BYTES],
        aad: &[u8],
        buffer: &mut Vec<u8>,
    ) -> Result<(), CryptoError> {
        let plain = Self::aes256gcm_open(key, nonce, aad, buffer)?;
        buffer.clear();
        buffer.extend_from_slice(&plain);
        Ok(())
    }

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
