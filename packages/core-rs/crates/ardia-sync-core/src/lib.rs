#![forbid(unsafe_code)]

mod base32;
mod error;
pub mod foundation_base64;
mod keys;
mod lowercase_letters;
pub mod phrase;
pub mod vault;
pub mod wordlist;

pub use ardia_crypto::wipe;
pub use base32::{base32_encode, is_tag, TAG_LENGTH};
pub use error::{Error, PhraseError};
pub use keys::{
    new_file_id, SyncKeys, SyncKeysWith, LOCAL_SCOPE_TAG, MAGIC, NONCE_BYTES, PADDING, PASSWORD_PADDING,
    PASSWORD_VERSION, SALT, TAG_BYTES,
};
