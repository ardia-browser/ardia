#![allow(non_camel_case_types)]
#![allow(clippy::missing_safety_doc)]
#![deny(unsafe_op_in_unsafe_fn)]

use std::ptr;
use std::slice;

use ardia_sync_core::{phrase, vault, Error, PhraseError, SyncKeys};
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

pub const ARDIA_ABI_VERSION: u32 = 1;
pub const ARDIA_ENTROPY_BYTES: usize = 32;
pub const ARDIA_MAX_PAYLOAD_BYTES: usize = 1024 * 1024 * 1024;
pub const ARDIA_MAX_SEALED_FILE_BYTES: usize = ARDIA_MAX_PAYLOAD_BYTES + 4096;
pub const ARDIA_MAX_LABEL_BYTES: usize = 64 * 1024;
pub const ARDIA_MAX_PASSWORD_FIELD_BYTES: usize = ARDIA_MAX_PAYLOAD_BYTES;
pub const ARDIA_MAX_SEALED_PASSWORD_BYTES: usize = ARDIA_MAX_PAYLOAD_BYTES + ARDIA_MAX_PAYLOAD_BYTES / 2;
pub const ARDIA_MAX_PHRASE_BYTES: usize = 4096;
pub const ARDIA_MAX_LISTING_JSON_BYTES: usize = 16 * 1024 * 1024;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ardia_status {
    Ok = 0,
    InvalidArgument = 1,
    TooLarge = 2,
    Format = 3,
    Authentication = 4,
    Phrase = 5,
    Random = 6,
    OutputInUse = 7,
}

#[repr(C)]
#[derive(Debug)]
pub struct ardia_buf {
    pub ptr: *mut u8,
    pub len: usize,
}

pub struct ardia_sync_keys(SyncKeys);

struct Failure {
    status: ardia_status,
    detail: serde_json::Value,
}

impl Failure {
    fn new(status: ardia_status, code: &str) -> Self {
        Failure {
            status,
            detail: json!({ "code": code }),
        }
    }

    fn argument(code: &str) -> Self {
        Failure::new(ardia_status::InvalidArgument, code)
    }
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        let status = match error {
            Error::Format => ardia_status::Format,
            Error::Authentication => ardia_status::Authentication,
            Error::Random => ardia_status::Random,
        };
        Failure::new(status, error.code())
    }
}

impl From<PhraseError> for Failure {
    fn from(error: PhraseError) -> Self {
        let detail = match &error {
            PhraseError::WordCount(count) => json!({ "code": error.code(), "count": count }),
            PhraseError::UnknownWord(index) => json!({ "code": error.code(), "index": index }),
            PhraseError::Checksum => json!({ "code": error.code() }),
        };
        Failure {
            status: ardia_status::Phrase,
            detail,
        }
    }
}

type Outcome = Result<Zeroizing<Vec<u8>>, Failure>;

unsafe fn bytes<'a>(data: *const u8, len: usize, max: usize) -> Result<&'a [u8], Failure> {
    if len > max {
        return Err(Failure::new(ardia_status::TooLarge, "tooLarge"));
    }
    if len == 0 {
        return Ok(&[]);
    }
    if data.is_null() {
        return Err(Failure::argument("argument"));
    }
    Ok(unsafe { slice::from_raw_parts(data, len) })
}

unsafe fn text<'a>(data: *const u8, len: usize, max: usize) -> Result<&'a str, Failure> {
    std::str::from_utf8(unsafe { bytes(data, len, max) }?).map_err(|_| Failure::argument("utf8"))
}

unsafe fn keys<'a>(keys: *const ardia_sync_keys) -> Result<&'a SyncKeys, Failure> {
    unsafe { keys.as_ref() }
        .map(|keys| &keys.0)
        .ok_or_else(|| Failure::argument("argument"))
}

fn owned(data: &[u8]) -> Outcome {
    Ok(Zeroizing::new(data.to_vec()))
}

fn write(out: &mut ardia_buf, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    hand_over(out, data.to_vec());
}

fn hand_over(out: &mut ardia_buf, data: Vec<u8>) {
    let boxed = data.into_boxed_slice();
    out.len = boxed.len();
    out.ptr = Box::into_raw(boxed).cast::<u8>();
}

fn give(out: &mut ardia_buf, mut data: Zeroizing<Vec<u8>>) {
    if data.is_empty() {
        return;
    }
    if data.len() == data.capacity() {
        hand_over(out, std::mem::take(&mut *data));
    } else {
        write(out, &data);
    }
}

unsafe fn run(out: *mut ardia_buf, body: impl FnOnce() -> Outcome) -> ardia_status {
    let Some(out) = (unsafe { out.as_mut() }) else {
        return ardia_status::InvalidArgument;
    };
    if !out.ptr.is_null() || out.len != 0 {
        return ardia_status::OutputInUse;
    }
    match body() {
        Ok(data) => {
            give(out, data);
            ardia_status::Ok
        }
        Err(failure) => {
            let detail = Zeroizing::new(serde_json::to_vec(&failure.detail).unwrap_or_default());
            write(out, &detail);
            failure.status
        }
    }
}

#[no_mangle]
pub extern "C" fn ardia_abi_version() -> u32 {
    ARDIA_ABI_VERSION
}

#[no_mangle]
pub unsafe extern "C" fn ardia_buf_free(buf: *mut ardia_buf) {
    let Some(buf) = (unsafe { buf.as_mut() }) else {
        return;
    };
    if !buf.ptr.is_null() {
        let mut boxed = unsafe { Box::from_raw(ptr::slice_from_raw_parts_mut(buf.ptr, buf.len)) };
        ardia_sync_core::wipe(&mut boxed);
    }
    buf.ptr = ptr::null_mut();
    buf.len = 0;
}

#[no_mangle]
pub unsafe extern "C" fn ardia_sync_keys_new(
    entropy: *const u8,
    entropy_len: usize,
    out: *mut *mut ardia_sync_keys,
) -> ardia_status {
    let Some(out) = (unsafe { out.as_mut() }) else {
        return ardia_status::InvalidArgument;
    };
    if !out.is_null() {
        return ardia_status::OutputInUse;
    }
    if entropy_len != ARDIA_ENTROPY_BYTES || entropy.is_null() {
        return ardia_status::InvalidArgument;
    }
    let entropy = unsafe { slice::from_raw_parts(entropy, entropy_len) };
    *out = Box::into_raw(Box::new(ardia_sync_keys(SyncKeys::new(entropy))));
    ardia_status::Ok
}

#[no_mangle]
pub unsafe extern "C" fn ardia_sync_keys_free(keys: *mut ardia_sync_keys) {
    if !keys.is_null() {
        drop(unsafe { Box::from_raw(keys) });
    }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_sync_chain_tag(keys: *const ardia_sync_keys, out: *mut ardia_buf) -> ardia_status {
    unsafe { run(out, || owned(self::keys(keys)?.chain_tag().as_bytes())) }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_sync_scope_tag(
    keys: *const ardia_sync_keys,
    scope: *const u8,
    scope_len: usize,
    out: *mut ardia_buf,
) -> ardia_status {
    unsafe {
        run(out, || {
            let keys = self::keys(keys)?;
            owned(
                keys.scope_tag(text(scope, scope_len, ARDIA_MAX_LABEL_BYTES)?)
                    .as_bytes(),
            )
        })
    }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_sync_seal(
    keys: *const ardia_sync_keys,
    payload: *const u8,
    payload_len: usize,
    scope_tag: *const u8,
    scope_tag_len: usize,
    file_id: *const u8,
    file_id_len: usize,
    out: *mut ardia_buf,
) -> ardia_status {
    unsafe {
        run(out, || {
            let keys = self::keys(keys)?;
            let payload = bytes(payload, payload_len, ARDIA_MAX_PAYLOAD_BYTES)?;
            let scope_tag = text(scope_tag, scope_tag_len, ARDIA_MAX_LABEL_BYTES)?;
            let file_id = text(file_id, file_id_len, ARDIA_MAX_LABEL_BYTES)?;
            Ok(Zeroizing::new(keys.seal(payload, scope_tag, file_id)?))
        })
    }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_sync_open(
    keys: *const ardia_sync_keys,
    file: *const u8,
    file_len: usize,
    scope_tag: *const u8,
    scope_tag_len: usize,
    file_id: *const u8,
    file_id_len: usize,
    out: *mut ardia_buf,
) -> ardia_status {
    unsafe {
        run(out, || {
            let keys = self::keys(keys)?;
            let file = bytes(file, file_len, ARDIA_MAX_SEALED_FILE_BYTES)?;
            let scope_tag = text(scope_tag, scope_tag_len, ARDIA_MAX_LABEL_BYTES)?;
            let file_id = text(file_id, file_id_len, ARDIA_MAX_LABEL_BYTES)?;
            Ok(keys.open(file, scope_tag, file_id)?)
        })
    }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_sync_seal_password(
    keys: *const ardia_sync_keys,
    password: *const u8,
    password_len: usize,
    origin: *const u8,
    origin_len: usize,
    username: *const u8,
    username_len: usize,
    out: *mut ardia_buf,
) -> ardia_status {
    unsafe {
        run(out, || {
            let keys = self::keys(keys)?;
            let password = text(password, password_len, ARDIA_MAX_PASSWORD_FIELD_BYTES)?;
            let origin = text(origin, origin_len, ARDIA_MAX_PASSWORD_FIELD_BYTES)?;
            let username = text(username, username_len, ARDIA_MAX_PASSWORD_FIELD_BYTES)?;
            Ok(Zeroizing::new(
                keys.seal_password(password, origin, username)?.into_bytes(),
            ))
        })
    }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_sync_open_password(
    keys: *const ardia_sync_keys,
    sealed: *const u8,
    sealed_len: usize,
    origin: *const u8,
    origin_len: usize,
    username: *const u8,
    username_len: usize,
    out: *mut ardia_buf,
) -> ardia_status {
    unsafe {
        run(out, || {
            let keys = self::keys(keys)?;
            let sealed = text(sealed, sealed_len, ARDIA_MAX_SEALED_PASSWORD_BYTES)?;
            let origin = text(origin, origin_len, ARDIA_MAX_PASSWORD_FIELD_BYTES)?;
            let username = text(username, username_len, ARDIA_MAX_PASSWORD_FIELD_BYTES)?;
            owned(keys.open_password(sealed, origin, username)?.as_bytes())
        })
    }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_sync_new_file_id(out: *mut ardia_buf) -> ardia_status {
    unsafe { run(out, || owned(ardia_sync_core::new_file_id()?.as_bytes())) }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_phrase_generate_entropy(out: *mut ardia_buf) -> ardia_status {
    unsafe { run(out, || owned(phrase::generate_entropy()?.as_ref())) }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_phrase_from_entropy(
    entropy: *const u8,
    entropy_len: usize,
    out: *mut ardia_buf,
) -> ardia_status {
    unsafe {
        run(out, || {
            if entropy_len != ARDIA_ENTROPY_BYTES || entropy.is_null() {
                return Err(Failure::argument("argument"));
            }
            let entropy: &[u8; ARDIA_ENTROPY_BYTES] = bytes(entropy, entropy_len, ARDIA_ENTROPY_BYTES)?
                .try_into()
                .map_err(|_| Failure::argument("argument"))?;
            owned(phrase::phrase(entropy).as_bytes())
        })
    }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_phrase_to_entropy(
    text: *const u8,
    text_len: usize,
    out: *mut ardia_buf,
) -> ardia_status {
    unsafe {
        run(out, || {
            let text = self::text(text, text_len, ARDIA_MAX_PHRASE_BYTES)?;
            owned(phrase::entropy(text)?.as_ref())
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListingRequest {
    names: Vec<String>,
    #[serde(default)]
    known: Vec<String>,
}

#[derive(Serialize)]
struct ListingReply {
    open: Vec<String>,
    pending: Vec<String>,
    present: Vec<String>,
}

#[no_mangle]
pub unsafe extern "C" fn ardia_vault_list(request: *const u8, request_len: usize, out: *mut ardia_buf) -> ardia_status {
    unsafe {
        run(out, || {
            let request: ListingRequest =
                serde_json::from_slice(bytes(request, request_len, ARDIA_MAX_LISTING_JSON_BYTES)?)
                    .map_err(|_| Failure::argument("json"))?;
            let known: Vec<&str> = request.known.iter().map(String::as_str).collect();
            let listing = vault::list(request.names.iter().map(String::as_str), &known);
            let reply = ListingReply {
                open: listing.open,
                pending: listing.pending,
                present: listing.present,
            };
            Ok(Zeroizing::new(
                serde_json::to_vec(&reply).map_err(|_| Failure::argument("json"))?,
            ))
        })
    }
}
