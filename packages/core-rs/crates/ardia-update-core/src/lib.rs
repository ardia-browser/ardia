#![deny(unsafe_code)]

mod error;
mod manifest;
mod version;
mod windows;

pub use error::UpdateError;
pub use manifest::{
    package_in_linux_manifest, parse_linux_manifest, verify_linux_manifest, verify_linux_update, LinuxManifest,
    Package, PackageKind, LINUX_MANIFEST_HEADER, LINUX_UPDATE_PUBLIC_KEY, MAX_MANIFEST_BYTES, MAX_PACKAGE_BYTES,
    PUBLIC_KEY_BYTES, SHA256_BYTES, SIGNATURE_BYTES,
};
pub use version::{check_offer, Channel, Version, MAX_VERSION_BYTES};
pub use windows::{
    installer_in_windows_manifest, is_valid_windows_published_under, is_valid_windows_version, parse_windows_manifest,
    verify_windows_manifest, verify_windows_update, WindowsCpu, WindowsInstaller, WindowsManifest, WindowsUpdate,
    MAX_WINDOWS_BUILD, MAX_WINDOWS_INSTALLER_BYTES, MAX_WINDOWS_MANIFEST_BYTES, MAX_WINDOWS_PREFIX_BYTES,
    MAX_WINDOWS_URL_BYTES, MAX_WINDOWS_VERSION_BYTES, WINDOWS_PUBLISHED_UNDER, WINDOWS_UPDATE_PUBLIC_KEY,
};
