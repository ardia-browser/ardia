#![allow(non_camel_case_types)]
#![allow(clippy::missing_safety_doc)]
#![deny(unsafe_op_in_unsafe_fn)]

use std::ptr;
use std::slice;

use ardia_import_core::{chromium_bookmarks, ImportError, ProfileFile};
use serde_json::json;
use zeroize::Zeroize;

pub const ARDIA_IMPORT_ABI_VERSION: u32 = 1;
pub const ARDIA_IMPORT_MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ardia_import_status {
    Ok = 0,
    InvalidArgument = 1,
    TooLarge = 2,
    NotFound = 3,
    Unreadable = 4,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ardia_import_bytes {
    pub ptr: *const u8,
    pub len: usize,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ardia_import_buf {
    pub ptr: *mut u8,
    pub len: usize,
}

const EMPTY: ardia_import_buf = ardia_import_buf {
    ptr: ptr::null_mut(),
    len: 0,
};

impl From<ImportError> for ardia_import_status {
    fn from(error: ImportError) -> Self {
        match error {
            ImportError::NotFound => ardia_import_status::NotFound,
            ImportError::Unreadable => ardia_import_status::Unreadable,
            ImportError::TooLarge => ardia_import_status::TooLarge,
        }
    }
}

unsafe fn profile_file<'a>(file: *const ardia_import_bytes) -> Option<ProfileFile<'a>> {
    if file.is_null() {
        return Some(ProfileFile::Missing);
    }
    let len = unsafe { ptr::addr_of!((*file).len).read() };
    if len > ARDIA_IMPORT_MAX_INPUT_BYTES {
        return Some(ProfileFile::Oversized);
    }
    if len == 0 {
        return Some(ProfileFile::Bytes(&[]));
    }
    let data = unsafe { ptr::addr_of!((*file).ptr).read() };
    if data.is_null() {
        return None;
    }
    Some(ProfileFile::Bytes(unsafe { slice::from_raw_parts(data, len) }))
}

fn hand_over(data: Vec<u8>) -> ardia_import_buf {
    if data.is_empty() {
        return EMPTY;
    }
    let boxed = data.into_boxed_slice();
    let len = boxed.len();
    ardia_import_buf {
        ptr: Box::into_raw(boxed).cast::<u8>(),
        len,
    }
}

fn failure(code: &str) -> ardia_import_buf {
    hand_over(json!({ "code": code }).to_string().into_bytes())
}

#[no_mangle]
pub extern "C" fn ardia_import_abi_version() -> u32 {
    ARDIA_IMPORT_ABI_VERSION
}

#[no_mangle]
pub unsafe extern "C" fn ardia_import_chromium_bookmarks(
    bookmarks: *const ardia_import_bytes,
    account_bookmarks: *const ardia_import_bytes,
    out: *mut ardia_import_buf,
) -> ardia_import_status {
    if out.is_null() {
        return ardia_import_status::InvalidArgument;
    }
    let files = unsafe { (profile_file(bookmarks), profile_file(account_bookmarks)) };
    let (status, result) = match files {
        (Some(local), Some(account)) => match chromium_bookmarks(local, account) {
            Ok(tree) => (ardia_import_status::Ok, hand_over(tree.to_json())),
            Err(error) => (error.into(), failure(error.code())),
        },
        _ => (ardia_import_status::InvalidArgument, failure("argument")),
    };
    unsafe { out.write(result) };
    status
}

#[no_mangle]
pub unsafe extern "C" fn ardia_import_buf_free(buf: *mut ardia_import_buf) {
    if buf.is_null() {
        return;
    }
    let held = unsafe { buf.read() };
    if !held.ptr.is_null() {
        let mut boxed = unsafe { Box::from_raw(ptr::slice_from_raw_parts_mut(held.ptr, held.len)) };
        boxed.zeroize();
    }
    unsafe { buf.write(EMPTY) };
}
