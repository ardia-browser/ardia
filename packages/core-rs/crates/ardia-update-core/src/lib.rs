#![deny(unsafe_code)]

mod error;
mod manifest;
mod version;

pub use error::UpdateError;
pub use manifest::{
    package_in_linux_manifest, parse_linux_manifest, verify_linux_manifest, verify_linux_update, LinuxManifest,
    Package, PackageKind, LINUX_MANIFEST_HEADER, LINUX_UPDATE_PUBLIC_KEY, MAX_MANIFEST_BYTES, MAX_PACKAGE_BYTES,
    PUBLIC_KEY_BYTES, SHA256_BYTES, SIGNATURE_BYTES,
};
pub use version::{check_offer, Channel, Version, MAX_VERSION_BYTES};
