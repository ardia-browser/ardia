use ardia_crypto::Crypto;

use crate::{UpdateError, Version};

pub const LINUX_MANIFEST_HEADER: &str = "ardia-linux-update 1";
pub const MAX_MANIFEST_BYTES: usize = 4096;
pub const SIGNATURE_BYTES: usize = 64;
pub const PUBLIC_KEY_BYTES: usize = 32;
pub const SHA256_BYTES: usize = 32;
pub const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
pub const LINUX_UPDATE_PUBLIC_KEY: [u8; PUBLIC_KEY_BYTES] = [
    0x3a, 0x44, 0x92, 0xa1, 0x78, 0x01, 0x99, 0x25, 0x1f, 0xdf, 0x8b, 0x76, 0x3b, 0x0d, 0xf5, 0x36, 0xba, 0x62, 0x43,
    0xff, 0xb0, 0x45, 0x55, 0xc8, 0x7f, 0x92, 0xbb, 0x16, 0x9a, 0x1a, 0xff, 0x2c,
];

const VERSION_PREFIX: &str = "version ";
const MAX_SIZE_DIGITS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PackageKind {
    Deb,
    Tarball,
    AppImage,
}

impl PackageKind {
    pub const ALL: [PackageKind; 3] = [PackageKind::Deb, PackageKind::Tarball, PackageKind::AppImage];

    pub fn name(self) -> &'static str {
        match self {
            PackageKind::Deb => "deb",
            PackageKind::Tarball => "tarball",
            PackageKind::AppImage => "appimage",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            PackageKind::Deb => "deb",
            PackageKind::Tarball => "tar.xz",
            PackageKind::AppImage => "AppImage",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        PackageKind::ALL.into_iter().find(|kind| kind.name() == name)
    }

    pub fn package_name(self, version: &str) -> String {
        format!("Ardia-{version}-linux-x64.{}", self.extension())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Package {
    pub kind: PackageKind,
    pub sha256: [u8; SHA256_BYTES],
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxManifest<'a> {
    pub version: &'a str,
    packages: [Option<Package>; 3],
}

impl LinuxManifest<'_> {
    pub fn package(&self, kind: PackageKind) -> Option<Package> {
        self.packages[kind as usize]
    }

    pub fn packages(&self) -> impl Iterator<Item = Package> + '_ {
        self.packages.iter().flatten().copied()
    }
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

pub(crate) fn sha256_hex(text: &str) -> Option<[u8; SHA256_BYTES]> {
    let bytes = text.as_bytes();
    if bytes.len() != SHA256_BYTES * 2 {
        return None;
    }
    let mut out = [0u8; SHA256_BYTES];
    for (index, pair) in bytes.as_chunks::<2>().0.iter().enumerate() {
        out[index] = hex_digit(pair[0])? << 4 | hex_digit(pair[1])?;
    }
    Some(out)
}

fn package_size(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_SIZE_DIGITS || bytes[0] == b'0' || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    text.parse().ok()
}

fn is_package_name(name: &str, version: &str, kind: PackageKind) -> bool {
    name.strip_prefix("Ardia-")
        .and_then(|rest| rest.strip_prefix(version))
        .and_then(|rest| rest.strip_prefix("-linux-x64."))
        == Some(kind.extension())
}

fn package_line(line: &str, version: &str) -> Result<Package, UpdateError> {
    let mut fields = line.split(' ');
    let (Some(kind), Some(name), Some(digest), Some(size), None) = (
        fields.next(),
        fields.next(),
        fields.next(),
        fields.next(),
        fields.next(),
    ) else {
        return Err(UpdateError::Manifest);
    };
    let kind = PackageKind::from_name(kind).ok_or(UpdateError::Manifest)?;
    if !is_package_name(name, version, kind) {
        return Err(UpdateError::Manifest);
    }
    let sha256 = sha256_hex(digest).ok_or(UpdateError::Manifest)?;
    let size = package_size(size).ok_or(UpdateError::Manifest)?;
    if size > MAX_PACKAGE_BYTES {
        return Err(UpdateError::Manifest);
    }
    Ok(Package { kind, sha256, size })
}

pub fn parse_linux_manifest(manifest: &[u8]) -> Result<LinuxManifest<'_>, UpdateError> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::TooLarge);
    }
    let text = core::str::from_utf8(manifest).map_err(|_| UpdateError::Manifest)?;
    let body = text.strip_suffix('\n').ok_or(UpdateError::Manifest)?;
    let mut lines = body.split('\n');
    if lines.next() != Some(LINUX_MANIFEST_HEADER) {
        return Err(UpdateError::Manifest);
    }
    let version = lines
        .next()
        .and_then(|line| line.strip_prefix(VERSION_PREFIX))
        .ok_or(UpdateError::Manifest)?;
    Version::parse(version).map_err(|_| UpdateError::Manifest)?;
    let mut packages = [None; 3];
    let mut last: Option<PackageKind> = None;
    for line in lines {
        let package = package_line(line, version)?;
        if last.is_some_and(|last| last >= package.kind) {
            return Err(UpdateError::Manifest);
        }
        last = Some(package.kind);
        packages[package.kind as usize] = Some(package);
    }
    Ok(LinuxManifest { version, packages })
}

pub fn package_in_linux_manifest(manifest: &[u8], version: &str, kind: PackageKind) -> Result<Package, UpdateError> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::TooLarge);
    }
    Version::parse(version)?;
    let parsed = parse_linux_manifest(manifest)?;
    if parsed.version != version {
        return Err(UpdateError::Manifest);
    }
    parsed.package(kind).ok_or(UpdateError::Kind)
}

pub fn verify_linux_manifest<'a, C: Crypto>(
    public_key: &[u8; PUBLIC_KEY_BYTES],
    manifest: &'a [u8],
    signature: &[u8],
) -> Result<LinuxManifest<'a>, UpdateError> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::TooLarge);
    }
    let signature: &[u8; SIGNATURE_BYTES] = signature.try_into().map_err(|_| UpdateError::Signature)?;
    if !C::ed25519_verify(public_key, manifest, signature) {
        return Err(UpdateError::Signature);
    }
    parse_linux_manifest(manifest)
}

pub fn verify_linux_update<C: Crypto>(
    public_key: &[u8; PUBLIC_KEY_BYTES],
    manifest: &[u8],
    signature: &[u8],
    version: &str,
    installed: &str,
    kind: PackageKind,
) -> Result<Package, UpdateError> {
    let wanted = Version::parse(version)?;
    let current = Version::parse(installed)?;
    let parsed = verify_linux_manifest::<C>(public_key, manifest, signature)?;
    if parsed.version != version {
        return Err(UpdateError::Manifest);
    }
    if wanted <= current {
        return Err(UpdateError::NotNewer);
    }
    parsed.package(kind).ok_or(UpdateError::Kind)
}
