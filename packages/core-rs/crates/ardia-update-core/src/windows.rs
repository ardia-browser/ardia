use ardia_crypto::Crypto;

use crate::manifest::sha256_hex;
use crate::{UpdateError, LINUX_UPDATE_PUBLIC_KEY, PUBLIC_KEY_BYTES, SHA256_BYTES, SIGNATURE_BYTES};

pub const WINDOWS_PUBLISHED_UNDER: &str = "https://github.com/ardia-browser/ardia/releases/download/";
pub const MAX_WINDOWS_MANIFEST_BYTES: usize = 64 * 1024;
pub const MAX_WINDOWS_INSTALLER_BYTES: u64 = 1 << 30;
pub const MAX_WINDOWS_BUILD: u64 = (1u64 << 53) - 1;
pub const MAX_WINDOWS_URL_BYTES: usize = 512;
pub const MAX_WINDOWS_PREFIX_BYTES: usize = 256;
pub const MAX_WINDOWS_VERSION_BYTES: usize = 64;
pub const WINDOWS_UPDATE_PUBLIC_KEY: [u8; PUBLIC_KEY_BYTES] = LINUX_UPDATE_PUBLIC_KEY;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum WindowsCpu {
    X64,
    Arm64,
}

impl WindowsCpu {
    pub const ALL: [WindowsCpu; 2] = [WindowsCpu::X64, WindowsCpu::Arm64];

    pub fn name(self) -> &'static str {
        match self {
            WindowsCpu::X64 => "x64",
            WindowsCpu::Arm64 => "arm64",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        WindowsCpu::ALL.into_iter().find(|cpu| cpu.name() == name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsInstaller<'a> {
    pub cpu: WindowsCpu,
    pub url: &'a str,
    pub sha256: [u8; SHA256_BYTES],
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsManifest<'a> {
    pub version: &'a str,
    pub build: u64,
    installers: [Option<WindowsInstaller<'a>>; 2],
}

impl<'a> WindowsManifest<'a> {
    pub fn installer(&self, cpu: WindowsCpu) -> Option<WindowsInstaller<'a>> {
        self.installers[cpu as usize]
    }

    pub fn installers(&self) -> impl Iterator<Item = WindowsInstaller<'a>> + '_ {
        self.installers.iter().flatten().copied()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsUpdate<'a> {
    pub version: &'a str,
    pub build: u64,
    pub installer: WindowsInstaller<'a>,
}

pub fn is_valid_windows_version(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_WINDOWS_VERSION_BYTES {
        return false;
    }
    if !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
}

fn is_url_path_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+' | b'/')
}

fn has_valid_path_segments(path: &str) -> bool {
    if path.contains("..") || path.contains("//") || !path.bytes().all(is_url_path_byte) {
        return false;
    }
    path.split('/').all(|segment| segment != ".")
}

fn is_valid_host_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')
}

fn is_valid_port(port: &str) -> bool {
    let bytes = port.as_bytes();
    if bytes.is_empty() || bytes.len() > 5 || bytes[0] == b'0' || !bytes.iter().all(u8::is_ascii_digit) {
        return false;
    }
    port.parse::<u16>().is_ok_and(|value| value >= 1)
}

fn split_authority(authority: &str) -> Option<(&str, Option<&str>)> {
    match authority.split_once(':') {
        Some((host, port)) => {
            if !is_valid_port(port) {
                return None;
            }
            Some((host, Some(port)))
        }
        None => Some((authority, None)),
    }
}

pub fn is_valid_windows_published_under(prefix: &str) -> bool {
    let bytes = prefix.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_WINDOWS_PREFIX_BYTES || !prefix.ends_with('/') {
        return false;
    }
    let (is_http, after_scheme) = if let Some(rest) = prefix.strip_prefix("https://") {
        (false, rest)
    } else if let Some(rest) = prefix.strip_prefix("http://") {
        (true, rest)
    } else {
        return false;
    };
    let Some((authority, path)) = after_scheme.split_once('/') else {
        return false;
    };
    if authority.is_empty() || path.starts_with('/') || !has_valid_path_segments(path) {
        return false;
    }
    let Some((host, _)) = split_authority(authority) else {
        return false;
    };
    if host.is_empty() || host.starts_with('.') || host.ends_with('.') || !host.bytes().all(is_valid_host_byte) {
        return false;
    }
    if is_http {
        return matches!(host, "127.0.0.1" | "localhost" | "10.0.2.2");
    }
    true
}

fn is_valid_installer_url(url: &str, published_under: &str) -> bool {
    if url.len() > MAX_WINDOWS_URL_BYTES {
        return false;
    }
    let Some(rest) = url.strip_prefix(published_under) else {
        return false;
    };
    if rest.is_empty() || rest.starts_with('/') || !has_valid_path_segments(rest) {
        return false;
    }
    let Some(stem_path) = rest.strip_suffix(".exe") else {
        return false;
    };
    let filename_stem = match stem_path.rsplit_once('/') {
        Some((_, tail)) => tail,
        None => stem_path,
    };
    filename_stem.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), UpdateError> {
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(UpdateError::Manifest)
        }
    }

    fn parse_ascii_string(&mut self) -> Result<&'a str, UpdateError> {
        self.expect(b'"')?;
        let start = self.pos;
        while let Some(byte) = self.peek() {
            if byte == b'"' {
                let slice = &self.bytes[start..self.pos];
                self.pos += 1;
                return core::str::from_utf8(slice).map_err(|_| UpdateError::Manifest);
            }
            if !(0x20..=0x7e).contains(&byte) || byte == b'\\' {
                return Err(UpdateError::Manifest);
            }
            self.pos += 1;
        }
        Err(UpdateError::Manifest)
    }

    fn parse_positive_u64(&mut self, max: u64) -> Result<u64, UpdateError> {
        let first = self.peek().ok_or(UpdateError::Manifest)?;
        if !(b'1'..=b'9').contains(&first) {
            return Err(UpdateError::Manifest);
        }
        let mut value = (first - b'0') as u64;
        self.pos += 1;
        while let Some(byte) = self.peek() {
            if !byte.is_ascii_digit() {
                break;
            }
            value = value
                .checked_mul(10)
                .and_then(|v| v.checked_add((byte - b'0') as u64))
                .ok_or(UpdateError::Manifest)?;
            if value > max {
                return Err(UpdateError::Manifest);
            }
            self.pos += 1;
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return Err(UpdateError::Manifest);
        }
        Ok(value)
    }

    fn parse_installer(&mut self, cpu: WindowsCpu, published_under: &str) -> Result<WindowsInstaller<'a>, UpdateError> {
        self.skip_ws();
        self.expect(b'{')?;
        self.skip_ws();
        if self.peek() == Some(b'}') {
            return Err(UpdateError::Manifest);
        }
        let mut url: Option<&'a str> = None;
        let mut sha256: Option<[u8; SHA256_BYTES]> = None;
        let mut bytes: Option<u64> = None;
        loop {
            self.skip_ws();
            let key = self.parse_ascii_string()?;
            self.skip_ws();
            self.expect(b':')?;
            self.skip_ws();
            match key {
                "url" => {
                    if url.is_some() {
                        return Err(UpdateError::Manifest);
                    }
                    let value = self.parse_ascii_string()?;
                    if !is_valid_installer_url(value, published_under) {
                        return Err(UpdateError::Manifest);
                    }
                    url = Some(value);
                }
                "sha256" => {
                    if sha256.is_some() {
                        return Err(UpdateError::Manifest);
                    }
                    let value = self.parse_ascii_string()?;
                    sha256 = Some(sha256_hex(value).ok_or(UpdateError::Manifest)?);
                }
                "bytes" => {
                    if bytes.is_some() {
                        return Err(UpdateError::Manifest);
                    }
                    bytes = Some(self.parse_positive_u64(MAX_WINDOWS_INSTALLER_BYTES)?);
                }
                _ => return Err(UpdateError::Manifest),
            }
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(UpdateError::Manifest),
            }
        }
        Ok(WindowsInstaller {
            cpu,
            url: url.ok_or(UpdateError::Manifest)?,
            sha256: sha256.ok_or(UpdateError::Manifest)?,
            bytes: bytes.ok_or(UpdateError::Manifest)?,
        })
    }
}

pub fn parse_windows_manifest<'a>(
    manifest: &'a [u8],
    published_under: &str,
) -> Result<WindowsManifest<'a>, UpdateError> {
    if !is_valid_windows_published_under(published_under) {
        return Err(UpdateError::Manifest);
    }
    if manifest.len() > MAX_WINDOWS_MANIFEST_BYTES {
        return Err(UpdateError::TooLarge);
    }
    if core::str::from_utf8(manifest).is_err() {
        return Err(UpdateError::Manifest);
    }
    let mut cursor = Cursor::new(manifest);
    cursor.skip_ws();
    cursor.expect(b'{')?;
    cursor.skip_ws();
    if cursor.peek() == Some(b'}') {
        return Err(UpdateError::Manifest);
    }
    let mut version: Option<&'a str> = None;
    let mut build: Option<u64> = None;
    let mut installers: [Option<WindowsInstaller<'a>>; 2] = [None; 2];
    loop {
        cursor.skip_ws();
        let key = cursor.parse_ascii_string()?;
        cursor.skip_ws();
        cursor.expect(b':')?;
        cursor.skip_ws();
        match key {
            "version" => {
                if version.is_some() {
                    return Err(UpdateError::Manifest);
                }
                let value = cursor.parse_ascii_string()?;
                if !is_valid_windows_version(value) {
                    return Err(UpdateError::Manifest);
                }
                version = Some(value);
            }
            "build" => {
                if build.is_some() {
                    return Err(UpdateError::Manifest);
                }
                build = Some(cursor.parse_positive_u64(MAX_WINDOWS_BUILD)?);
            }
            "x64" => {
                if installers[WindowsCpu::X64 as usize].is_some() {
                    return Err(UpdateError::Manifest);
                }
                installers[WindowsCpu::X64 as usize] = Some(cursor.parse_installer(WindowsCpu::X64, published_under)?);
            }
            "arm64" => {
                if installers[WindowsCpu::Arm64 as usize].is_some() {
                    return Err(UpdateError::Manifest);
                }
                installers[WindowsCpu::Arm64 as usize] =
                    Some(cursor.parse_installer(WindowsCpu::Arm64, published_under)?);
            }
            _ => return Err(UpdateError::Manifest),
        }
        cursor.skip_ws();
        match cursor.peek() {
            Some(b',') => cursor.pos += 1,
            Some(b'}') => {
                cursor.pos += 1;
                break;
            }
            _ => return Err(UpdateError::Manifest),
        }
    }
    cursor.skip_ws();
    if cursor.pos != manifest.len() {
        return Err(UpdateError::Manifest);
    }
    Ok(WindowsManifest {
        version: version.ok_or(UpdateError::Manifest)?,
        build: build.ok_or(UpdateError::Manifest)?,
        installers,
    })
}

pub fn installer_in_windows_manifest<'a>(
    manifest: &'a [u8],
    published_under: &str,
    cpu: WindowsCpu,
) -> Result<WindowsUpdate<'a>, UpdateError> {
    let parsed = parse_windows_manifest(manifest, published_under)?;
    let installer = parsed.installer(cpu).ok_or(UpdateError::Kind)?;
    Ok(WindowsUpdate {
        version: parsed.version,
        build: parsed.build,
        installer,
    })
}

pub fn verify_windows_manifest<'a, C: Crypto>(
    public_key: &[u8; PUBLIC_KEY_BYTES],
    manifest: &'a [u8],
    signature: &[u8],
    published_under: &str,
) -> Result<WindowsManifest<'a>, UpdateError> {
    if !is_valid_windows_published_under(published_under) {
        return Err(UpdateError::Manifest);
    }
    if manifest.len() > MAX_WINDOWS_MANIFEST_BYTES {
        return Err(UpdateError::TooLarge);
    }
    let signature: &[u8; SIGNATURE_BYTES] = signature.try_into().map_err(|_| UpdateError::Signature)?;
    if !C::ed25519_verify(public_key, manifest, signature) {
        return Err(UpdateError::Signature);
    }
    parse_windows_manifest(manifest, published_under)
}

pub fn verify_windows_update<'a, C: Crypto>(
    public_key: &[u8; PUBLIC_KEY_BYTES],
    manifest: &'a [u8],
    signature: &[u8],
    published_under: &str,
    cpu: WindowsCpu,
    current_build: u64,
) -> Result<WindowsUpdate<'a>, UpdateError> {
    if current_build > MAX_WINDOWS_BUILD {
        return Err(UpdateError::Version);
    }
    let parsed = verify_windows_manifest::<C>(public_key, manifest, signature, published_under)?;
    if parsed.build <= current_build {
        return Err(UpdateError::NotNewer);
    }
    let installer = parsed.installer(cpu).ok_or(UpdateError::Kind)?;
    Ok(WindowsUpdate {
        version: parsed.version,
        build: parsed.build,
        installer,
    })
}
