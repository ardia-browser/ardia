use std::ffi::c_void;
use std::io;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{LocalFree, ERROR_NOT_FOUND, HLOCAL};
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredEnumerateW, CredFree, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use zeroize::{Zeroize, Zeroizing};

use crate::credentials::StoredCredential;
use crate::migrate::{Sealer, Vault};

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn from_wide(pointer: *const u16) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    let mut length = 0usize;
    while unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, length) }).ok()
}

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

pub struct Dpapi;

impl Sealer for Dpapi {
    fn seal(&self, plain: &[u8], purpose: &str) -> io::Result<Vec<u8>> {
        let input = blob(plain);
        let entropy = blob(purpose.as_bytes());
        let description = wide("Ardia connected account");
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        let sealed = unsafe {
            CryptProtectData(
                &input,
                description.as_ptr(),
                &entropy,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if sealed == 0 || output.pbData.is_null() {
            return Err(io::Error::last_os_error());
        }
        let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe { LocalFree(output.pbData as HLOCAL) };
        Ok(bytes)
    }

    fn open(&self, sealed: &[u8], purpose: &str) -> Option<Zeroizing<Vec<u8>>> {
        let input = blob(sealed);
        let entropy = blob(purpose.as_bytes());
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        let opened = unsafe {
            CryptUnprotectData(
                &input,
                null_mut(),
                &entropy,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if opened == 0 || output.pbData.is_null() {
            return None;
        }
        let plain = unsafe { std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize) };
        let copy = Zeroizing::new(plain.to_vec());
        plain.zeroize();
        unsafe { LocalFree(output.pbData as HLOCAL) };
        Some(copy)
    }
}

pub struct CredentialManager;

impl Vault for CredentialManager {
    fn list(&self, prefix: &str) -> io::Result<Vec<StoredCredential>> {
        let filter = wide(&format!("{prefix}*"));
        let mut count = 0u32;
        let mut found: *mut *mut CREDENTIALW = null_mut();
        if unsafe { CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut found) } == 0 {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
                Ok(Vec::new())
            } else {
                Err(error)
            };
        }
        let mut stored = Vec::with_capacity(count as usize);
        for index in 0..count as usize {
            let credential = unsafe { &**found.add(index) };
            if credential.Type != CRED_TYPE_GENERIC {
                continue;
            }
            let size = credential.CredentialBlobSize as usize;
            let bytes: &mut [u8] = if credential.CredentialBlob.is_null() || size == 0 {
                &mut []
            } else {
                unsafe { std::slice::from_raw_parts_mut(credential.CredentialBlob, size) }
            };
            let copy = Zeroizing::new(bytes.to_vec());
            bytes.zeroize();
            let Some(target) = (unsafe { from_wide(credential.TargetName) }) else {
                continue;
            };
            let comment = unsafe { from_wide(credential.Comment) };
            let user = unsafe { from_wide(credential.UserName) };
            stored.push(StoredCredential {
                target,
                comment,
                user,
                blob: copy,
            });
        }
        unsafe { CredFree(found as *const c_void) };
        Ok(stored)
    }
}

pub fn write_generic(target: &str, comment: Option<&str>, user: &str, bytes: &[u8]) -> io::Result<()> {
    let target = wide(target);
    let user = wide(user);
    let comment = comment.map(wide);
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_ptr() as *mut u16,
        UserName: user.as_ptr() as *mut u16,
        Comment: comment.as_ref().map_or(null_mut(), |c| c.as_ptr() as *mut u16),
        CredentialBlobSize: bytes.len() as u32,
        CredentialBlob: if bytes.is_empty() {
            null_mut()
        } else {
            bytes.as_ptr() as *mut u8
        },
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn delete_generic(target: &str) {
    let target = wide(target);
    unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
}
