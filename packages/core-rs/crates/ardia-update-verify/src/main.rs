#![deny(unsafe_code)]

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;

use ardia_crypto::Backend;
use ardia_update_core::{
    verify_linux_update, Package, PackageKind, UpdateError, Version, MAX_MANIFEST_BYTES, PUBLIC_KEY_BYTES,
    SIGNATURE_BYTES,
};
use base64::Engine;
use sha2::{Digest, Sha256};

const USAGE: &str = "usage: ardia-update-verify version <V>
       ardia-update-verify manifest <flags>
       ardia-update-verify package <flags> --package <file>

Checks a signed Ardia update for Linux with ardia-update-core, for
lib/ardia/ardia-update.

  version <V>  exits 0 when <V> is an Ardia version (<major>.<minor>.<patch>
               or <major>.<minor>.<patch>-nightly.<n>, each part 1 to 9 digits)
  manifest     verifies the manifest's Ed25519 signature against the key,
               then that it is a canonical format 1 manifest for --version,
               that --version is newer than --installed, and that it lists a
               package for --kind
  package      does what manifest does, then checks that --package is a
               regular file of the listed size whose SHA-256 is the listed one

  --key <pem>        the Ed25519 public key (SubjectPublicKeyInfo PEM)
  --manifest <file>  Ardia-<V>-linux-update.txt, at most 4096 bytes
  --signature <file> its 64-byte signature
  --version <V>      the version the manifest's file name gives
  --installed <V>    the version installed now
  --kind <kind>      deb, tarball or appimage

Paths are absolute and never followed through a symbolic link. The last line
on stdout is \"ok <package name> <sha256> <size>\" (exit 0) or \"failed
<reason>\" (exit 1; exit 2 for usage), with reason one of usage, missing,
manifest, signature, notNewer, kind, checksum or version.";

const MAX_KEY_BYTES: u64 = 4096;
const MAX_PATH_BYTES: usize = 4096;
const SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
const PEM_BEGIN: &str = "-----BEGIN PUBLIC KEY-----";
const PEM_END: &str = "-----END PUBLIC KEY-----";
const HASH_CHUNK_BYTES: usize = 1 << 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reason {
    Usage,
    Missing,
    Manifest,
    Signature,
    NotNewer,
    Kind,
    Checksum,
    Version,
}

impl Reason {
    fn code(self) -> &'static str {
        match self {
            Reason::Usage => "usage",
            Reason::Missing => "missing",
            Reason::Manifest => "manifest",
            Reason::Signature => "signature",
            Reason::NotNewer => "notNewer",
            Reason::Kind => "kind",
            Reason::Checksum => "checksum",
            Reason::Version => "version",
        }
    }

    fn exit_code(self) -> u8 {
        match self {
            Reason::Usage => 2,
            _ => 1,
        }
    }

    fn of_update(error: UpdateError) -> Reason {
        match error {
            UpdateError::Signature => Reason::Signature,
            UpdateError::NotNewer => Reason::NotNewer,
            UpdateError::Kind => Reason::Kind,
            UpdateError::TooLarge | UpdateError::Manifest | UpdateError::Version | UpdateError::Channel => {
                Reason::Manifest
            }
        }
    }
}

#[derive(Debug)]
struct Refusal {
    reason: Reason,
    message: String,
}

fn refuse(reason: Reason, message: impl Into<String>) -> Refusal {
    Refusal {
        reason,
        message: message.into(),
    }
}

#[derive(Debug)]
struct Request {
    key: PathBuf,
    manifest: PathBuf,
    signature: PathBuf,
    version: String,
    installed: String,
    kind: PackageKind,
    package: Option<PathBuf>,
}

#[derive(Debug)]
enum Command {
    Help,
    Version(String),
    Check(Request),
}

enum ReadFailure {
    Unreadable,
    NotRegular,
    TooLarge,
}

fn text(value: OsString, flag: &str) -> Result<String, Refusal> {
    value
        .into_string()
        .map_err(|_| refuse(Reason::Usage, format!("{flag} is not UTF-8")))
}

fn absolute_path(value: String, flag: &str) -> Result<PathBuf, Refusal> {
    let path = PathBuf::from(value);
    let length = path.as_os_str().len();
    let traverses = path.components().any(|component| component == Component::ParentDir);
    if length > MAX_PATH_BYTES || !path.is_absolute() || traverses || path.to_string_lossy().contains('\n') {
        return Err(refuse(
            Reason::Usage,
            format!("{flag} takes an absolute path of at most {MAX_PATH_BYTES} bytes, without .."),
        ));
    }
    Ok(path)
}

fn parse(args: Vec<OsString>) -> Result<Command, Refusal> {
    let mut args = args.into_iter();
    let command = text(
        args.next().ok_or_else(|| refuse(Reason::Usage, "no command"))?,
        "the command",
    )?;
    match command.as_str() {
        "-h" | "--help" if args.as_slice().is_empty() => Ok(Command::Help),
        "version" => {
            let (Some(version), None) = (args.next(), args.next()) else {
                return Err(refuse(Reason::Usage, "version takes one version"));
            };
            Ok(Command::Version(text(version, "the version")?))
        }
        "manifest" | "package" => parse_request(args, command == "package").map(Command::Check),
        _ => Err(refuse(Reason::Usage, "unknown command")),
    }
}

fn parse_request(mut args: impl Iterator<Item = OsString>, with_package: bool) -> Result<Request, Refusal> {
    let mut key = None;
    let mut manifest = None;
    let mut signature = None;
    let mut version = None;
    let mut installed = None;
    let mut kind = None;
    let mut package = None;
    while let Some(flag) = args.next() {
        let flag = text(flag, "a flag")?;
        let slot = match flag.as_str() {
            "--key" => &mut key,
            "--manifest" => &mut manifest,
            "--signature" => &mut signature,
            "--version" => &mut version,
            "--installed" => &mut installed,
            "--kind" => &mut kind,
            "--package" if with_package => &mut package,
            _ => return Err(refuse(Reason::Usage, "unknown flag")),
        };
        if slot.is_some() {
            return Err(refuse(Reason::Usage, format!("{flag} given twice")));
        }
        let value = text(
            args.next()
                .ok_or_else(|| refuse(Reason::Usage, format!("{flag} needs a value")))?,
            &flag,
        )?;
        *slot = Some(value);
    }
    let required = |value: Option<String>, flag: &str| value.ok_or_else(|| refuse(Reason::Usage, format!("no {flag}")));
    let kind = required(kind, "--kind")?;
    Ok(Request {
        key: absolute_path(required(key, "--key")?, "--key")?,
        manifest: absolute_path(required(manifest, "--manifest")?, "--manifest")?,
        signature: absolute_path(required(signature, "--signature")?, "--signature")?,
        version: required(version, "--version")?,
        installed: required(installed, "--installed")?,
        kind: PackageKind::from_name(&kind)
            .ok_or_else(|| refuse(Reason::Usage, "--kind is deb, tarball or appimage"))?,
        package: match (with_package, package) {
            (true, value) => Some(absolute_path(required(value, "--package")?, "--package")?),
            (false, _) => None,
        },
    })
}

#[cfg(unix)]
fn open_without_following(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(not(unix))]
fn open_without_following(path: &Path) -> io::Result<File> {
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::other("a symbolic link"));
    }
    File::open(path)
}

fn open_regular(path: &Path) -> Result<(File, u64), ReadFailure> {
    let file = open_without_following(path).map_err(|_| ReadFailure::Unreadable)?;
    let metadata = file.metadata().map_err(|_| ReadFailure::Unreadable)?;
    if !metadata.is_file() {
        return Err(ReadFailure::NotRegular);
    }
    Ok((file, metadata.len()))
}

fn read_capped(path: &Path, cap: u64) -> Result<Vec<u8>, ReadFailure> {
    let (file, length) = open_regular(path)?;
    if length > cap {
        return Err(ReadFailure::TooLarge);
    }
    let mut bytes = Vec::new();
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ReadFailure::Unreadable)?;
    if bytes.len() as u64 > cap {
        return Err(ReadFailure::TooLarge);
    }
    Ok(bytes)
}

fn read_input(path: &Path, cap: u64, what: &str, oversize: Reason) -> Result<Vec<u8>, Refusal> {
    read_capped(path, cap).map_err(|failure| match failure {
        ReadFailure::Unreadable => refuse(Reason::Missing, format!("couldn't read the {what}")),
        ReadFailure::NotRegular => refuse(Reason::Missing, format!("the {what} is not a regular file")),
        ReadFailure::TooLarge => refuse(oversize, format!("the {what} is larger than {cap} bytes")),
    })
}

fn public_key_from_pem(pem: &[u8]) -> Option<[u8; PUBLIC_KEY_BYTES]> {
    let text = core::str::from_utf8(pem).ok()?;
    let mut lines = text.split_inclusive('\n').map(|line| match line.strip_suffix('\n') {
        Some(ended) => ended.strip_suffix('\r').unwrap_or(ended),
        None => line,
    });
    let (Some(PEM_BEGIN), Some(encoded), Some(PEM_END), None) =
        (lines.next(), lines.next(), lines.next(), lines.next())
    else {
        return None;
    };
    let der = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    der.strip_prefix(SPKI_PREFIX.as_slice())?.try_into().ok()
}

fn read_key(path: &Path) -> Result<[u8; PUBLIC_KEY_BYTES], Refusal> {
    let pem = read_input(path, MAX_KEY_BYTES, "public key", Reason::Signature)
        .map_err(|refusal| refuse(Reason::Signature, refusal.message))?;
    public_key_from_pem(&pem)
        .ok_or_else(|| refuse(Reason::Signature, "the public key is not an Ed25519 public key PEM"))
}

fn verify(request: &Request) -> Result<Package, Refusal> {
    Version::parse(&request.installed).map_err(|_| refuse(Reason::Kind, "the installed version is malformed"))?;
    let key = read_key(&request.key)?;
    let manifest = read_input(
        &request.manifest,
        MAX_MANIFEST_BYTES as u64,
        "manifest",
        Reason::Manifest,
    )?;
    let signature = read_input(
        &request.signature,
        SIGNATURE_BYTES as u64,
        "signature",
        Reason::Signature,
    )?;
    verify_linux_update::<Backend>(
        &key,
        &manifest,
        &signature,
        &request.version,
        &request.installed,
        request.kind,
    )
    .map_err(|error| {
        let message = match error {
            UpdateError::Signature => "the manifest's signature doesn't verify".to_owned(),
            UpdateError::NotNewer => "the update is not newer than the installed version".to_owned(),
            UpdateError::Kind => format!("the manifest has no {} package", request.kind.name()),
            UpdateError::TooLarge => "the manifest is too large".to_owned(),
            UpdateError::Version => "the manifest's version is malformed".to_owned(),
            UpdateError::Manifest | UpdateError::Channel => {
                "the manifest isn't a canonical format 1 manifest for this version".to_owned()
            }
        };
        refuse(Reason::of_update(error), message)
    })
}

fn check_package(path: &Path, package: &Package) -> Result<(), Refusal> {
    let unreadable = || refuse(Reason::Missing, "couldn't read the package");
    let (file, length) = open_regular(path).map_err(|failure| match failure {
        ReadFailure::NotRegular => refuse(Reason::Missing, "the package is not a regular file"),
        ReadFailure::Unreadable | ReadFailure::TooLarge => unreadable(),
    })?;
    if length != package.size {
        return Err(refuse(
            Reason::Checksum,
            format!("the package is {length} bytes, not {}", package.size),
        ));
    }
    let mut reader = file.take(package.size + 1);
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; HASH_CHUNK_BYTES];
    let mut total = 0u64;
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(unreadable()),
        };
        total += read as u64;
        hasher.update(&chunk[..read]);
    }
    if total != package.size {
        return Err(refuse(Reason::Checksum, "the package changed size while it was read"));
    }
    if hasher.finalize().as_slice() != package.sha256.as_slice() {
        return Err(refuse(
            Reason::Checksum,
            "the package doesn't match the manifest's sha256",
        ));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn run(args: Vec<OsString>) -> Result<String, Refusal> {
    match parse(args)? {
        Command::Help => Ok(USAGE.to_owned()),
        Command::Version(version) => Version::parse(&version)
            .map(|_| "ok".to_owned())
            .map_err(|_| refuse(Reason::Version, "not an Ardia version")),
        Command::Check(request) => {
            let package = verify(&request)?;
            if let Some(path) = &request.package {
                check_package(path, &package)?;
            }
            Ok(format!(
                "ok {} {} {}",
                package.kind.package_name(&request.version),
                hex(&package.sha256),
                package.size
            ))
        }
    }
}

fn main() -> ExitCode {
    let result = run(std::env::args_os().skip(1).collect());
    let mut stdout = io::stdout().lock();
    match result {
        Ok(line) => {
            let _ = writeln!(stdout, "{line}");
            ExitCode::SUCCESS
        }
        Err(refusal) => {
            let mut stderr = io::stderr().lock();
            let _ = writeln!(stderr, "ardia-update-verify: {}", refusal.message);
            if refusal.reason == Reason::Usage {
                let _ = writeln!(stderr, "{USAGE}");
            }
            let _ = writeln!(stdout, "failed {}", refusal.reason.code());
            ExitCode::from(refusal.reason.exit_code())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELEASE_PEM: &str = include_str!("../../../../../scripts/linux/linux-update.pem");

    #[test]
    fn the_release_pem_is_the_core_release_key() {
        assert_eq!(
            public_key_from_pem(RELEASE_PEM.as_bytes()),
            Some(ardia_update_core::LINUX_UPDATE_PUBLIC_KEY)
        );
    }

    #[test]
    fn a_pem_must_be_exactly_one_ed25519_public_key() {
        let pem = RELEASE_PEM;
        let body = pem.lines().nth(1).unwrap();
        for pem in [
            String::new(),
            format!("{PEM_BEGIN}\n{body}\n"),
            format!("{PEM_BEGIN}\n{body}\n{PEM_END}\n{PEM_END}\n"),
            format!("{PEM_BEGIN}\r\r\n{body}\r\n{PEM_END}\r\n"),
            format!("{PEM_BEGIN}\r{body}\r{PEM_END}\r"),
            format!("{PEM_BEGIN}\n{body}\n{PEM_END}\n\n"),
            format!("{PEM_BEGIN}\r\n{body}\r\n{PEM_END}\r\n\r\n"),
            format!("{PEM_BEGIN}\n{body}\n{PEM_END}\r"),
            format!("{PEM_BEGIN}\r\n{body}\r\n{PEM_END}\r"),
            format!("{PEM_BEGIN}\n{body}\r\r\n{PEM_END}\n"),
            format!("{PEM_BEGIN}\n{body}=\n{PEM_END}\n"),
            format!("{PEM_BEGIN}\n{}\n{PEM_END}\n", &body[..body.len() - 4]),
            format!("-----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY-----\n"),
            format!("{PEM_BEGIN}\nMCowBQYDK2VxAyEA{}\n{PEM_END}\n", &body[16..]),
        ] {
            assert_eq!(public_key_from_pem(pem.as_bytes()), None, "{pem:?}");
        }
        for accepted in [
            format!("{PEM_BEGIN}\n{body}\n{PEM_END}\n"),
            format!("{PEM_BEGIN}\n{body}\n{PEM_END}"),
            format!("{PEM_BEGIN}\r\n{body}\r\n{PEM_END}\r\n"),
            format!("{PEM_BEGIN}\r\n{body}\r\n{PEM_END}"),
        ] {
            assert_eq!(
                public_key_from_pem(accepted.as_bytes()),
                Some(ardia_update_core::LINUX_UPDATE_PUBLIC_KEY),
                "{accepted:?}"
            );
        }
    }

    #[test]
    fn every_update_error_maps_to_a_reason_the_helper_reports() {
        for (error, reason) in [
            (UpdateError::TooLarge, "manifest"),
            (UpdateError::Manifest, "manifest"),
            (UpdateError::Version, "manifest"),
            (UpdateError::Channel, "manifest"),
            (UpdateError::Signature, "signature"),
            (UpdateError::NotNewer, "notNewer"),
            (UpdateError::Kind, "kind"),
        ] {
            assert_eq!(Reason::of_update(error).code(), reason, "{error:?}");
        }
    }
}
