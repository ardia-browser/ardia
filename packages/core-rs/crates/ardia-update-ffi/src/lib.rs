#![allow(non_camel_case_types)]
#![allow(clippy::missing_safety_doc)]
#![deny(unsafe_op_in_unsafe_fn)]

use std::slice;

use ardia_crypto::Backend;
use ardia_update_core::{
    check_offer, verify_linux_update, Channel, Package, PackageKind, UpdateError, Version, MAX_MANIFEST_BYTES,
};

pub const ARDIA_UPDATE_ABI_VERSION: u32 = 1;
pub const ARDIA_UPDATE_MAX_MANIFEST_BYTES: usize = 4096;
pub const ARDIA_UPDATE_SIGNATURE_BYTES: usize = 64;
pub const ARDIA_UPDATE_PUBLIC_KEY_BYTES: usize = 32;
pub const ARDIA_UPDATE_SHA256_BYTES: usize = 32;
pub const ARDIA_UPDATE_MAX_VERSION_BYTES: usize = 64;
pub const ARDIA_UPDATE_MAX_PACKAGE_BYTES: u64 = 536870912;
pub const ARDIA_UPDATE_KIND_DEB: u32 = 0;
pub const ARDIA_UPDATE_KIND_TARBALL: u32 = 1;
pub const ARDIA_UPDATE_KIND_APPIMAGE: u32 = 2;
pub const ARDIA_UPDATE_CHANNEL_STABLE: u32 = 0;
pub const ARDIA_UPDATE_CHANNEL_NIGHTLY: u32 = 1;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ardia_update_status {
    Ok = 0,
    InvalidArgument = 1,
    TooLarge = 2,
    Manifest = 3,
    Signature = 4,
    NotNewer = 5,
    Kind = 6,
    Version = 7,
    Channel = 8,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ardia_update_package {
    pub size: u64,
    pub sha256: [u8; ARDIA_UPDATE_SHA256_BYTES],
}

impl From<UpdateError> for ardia_update_status {
    fn from(error: UpdateError) -> Self {
        match error {
            UpdateError::TooLarge => ardia_update_status::TooLarge,
            UpdateError::Manifest => ardia_update_status::Manifest,
            UpdateError::Signature => ardia_update_status::Signature,
            UpdateError::NotNewer => ardia_update_status::NotNewer,
            UpdateError::Kind => ardia_update_status::Kind,
            UpdateError::Version => ardia_update_status::Version,
            UpdateError::Channel => ardia_update_status::Channel,
        }
    }
}

type Outcome<T> = Result<T, ardia_update_status>;

unsafe fn input<'a>(data: *const u8, len: usize) -> Outcome<&'a [u8]> {
    if len == 0 {
        return Ok(&[]);
    }
    if data.is_null() {
        return Err(ardia_update_status::InvalidArgument);
    }
    Ok(unsafe { slice::from_raw_parts(data, len) })
}

unsafe fn version_text<'a>(data: *const u8, len: usize) -> Outcome<&'a str> {
    if len > ARDIA_UPDATE_MAX_VERSION_BYTES {
        return Err(ardia_update_status::Version);
    }
    std::str::from_utf8(unsafe { input(data, len) }?).map_err(|_| ardia_update_status::Version)
}

unsafe fn version(data: *const u8, len: usize) -> Outcome<Version> {
    Ok(Version::parse(unsafe { version_text(data, len) }?)?)
}

fn kind(kind: u32) -> Outcome<PackageKind> {
    match kind {
        ARDIA_UPDATE_KIND_DEB => Ok(PackageKind::Deb),
        ARDIA_UPDATE_KIND_TARBALL => Ok(PackageKind::Tarball),
        ARDIA_UPDATE_KIND_APPIMAGE => Ok(PackageKind::AppImage),
        _ => Err(ardia_update_status::InvalidArgument),
    }
}

fn channel(channel: u32) -> Outcome<Channel> {
    match channel {
        ARDIA_UPDATE_CHANNEL_STABLE => Ok(Channel::Stable),
        ARDIA_UPDATE_CHANNEL_NIGHTLY => Ok(Channel::Nightly),
        _ => Err(ardia_update_status::InvalidArgument),
    }
}

fn status(outcome: Outcome<()>) -> ardia_update_status {
    match outcome {
        Ok(()) => ardia_update_status::Ok,
        Err(status) => status,
    }
}

unsafe fn deliver<T>(out: *mut T, empty: T, body: impl FnOnce() -> Outcome<T>) -> ardia_update_status {
    if out.is_null() {
        return ardia_update_status::InvalidArgument;
    }
    let (value, status) = match body() {
        Ok(value) => (value, ardia_update_status::Ok),
        Err(status) => (empty, status),
    };
    unsafe { out.write(value) };
    status
}

#[no_mangle]
pub extern "C" fn ardia_update_abi_version() -> u32 {
    ARDIA_UPDATE_ABI_VERSION
}

#[no_mangle]
pub unsafe extern "C" fn ardia_update_verify_linux(
    manifest: *const u8,
    manifest_len: usize,
    signature: *const u8,
    signature_len: usize,
    public_key: *const u8,
    public_key_len: usize,
    version: *const u8,
    version_len: usize,
    installed: *const u8,
    installed_len: usize,
    kind: u32,
    out: *mut ardia_update_package,
) -> ardia_update_status {
    let empty = ardia_update_package {
        size: 0,
        sha256: [0; ARDIA_UPDATE_SHA256_BYTES],
    };
    unsafe {
        deliver(out, empty, || {
            let kind = self::kind(kind)?;
            if public_key_len != ARDIA_UPDATE_PUBLIC_KEY_BYTES || public_key.is_null() {
                return Err(ardia_update_status::InvalidArgument);
            }
            let public_key: &[u8; ARDIA_UPDATE_PUBLIC_KEY_BYTES] = input(public_key, public_key_len)?
                .try_into()
                .map_err(|_| ardia_update_status::InvalidArgument)?;
            let version = version_text(version, version_len)?;
            let installed = version_text(installed, installed_len)?;
            Version::parse(version)?;
            Version::parse(installed)?;
            if manifest_len > MAX_MANIFEST_BYTES {
                return Err(ardia_update_status::TooLarge);
            }
            let manifest = input(manifest, manifest_len)?;
            let signature = if signature_len == ARDIA_UPDATE_SIGNATURE_BYTES {
                input(signature, signature_len)?
            } else {
                &[]
            };
            let Package { sha256, size, .. } =
                verify_linux_update::<Backend>(public_key, manifest, signature, version, installed, kind)?;
            Ok(ardia_update_package { size, sha256 })
        })
    }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_update_compare_versions(
    left: *const u8,
    left_len: usize,
    right: *const u8,
    right_len: usize,
    out: *mut i32,
) -> ardia_update_status {
    unsafe {
        deliver(out, 0, || {
            let left = version(left, left_len)?;
            let right = version(right, right_len)?;
            Ok(left.cmp(&right) as i32)
        })
    }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_update_channel_of(
    version: *const u8,
    version_len: usize,
    out: *mut u32,
) -> ardia_update_status {
    unsafe {
        deliver(out, ARDIA_UPDATE_CHANNEL_STABLE, || {
            Ok(match self::version(version, version_len)?.channel() {
                Channel::Stable => ARDIA_UPDATE_CHANNEL_STABLE,
                Channel::Nightly => ARDIA_UPDATE_CHANNEL_NIGHTLY,
            })
        })
    }
}

#[no_mangle]
pub unsafe extern "C" fn ardia_update_check_offer(
    candidate: *const u8,
    candidate_len: usize,
    installed: *const u8,
    installed_len: usize,
    channel: u32,
) -> ardia_update_status {
    status((|| {
        let channel = self::channel(channel)?;
        let candidate = unsafe { version_text(candidate, candidate_len) }?;
        let installed = unsafe { version_text(installed, installed_len) }?;
        Ok(check_offer(candidate, installed, channel)?)
    })())
}
