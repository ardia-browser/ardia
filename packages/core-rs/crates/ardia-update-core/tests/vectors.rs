use std::fs;
use std::path::PathBuf;

use ardia_crypto::{Backend, Crypto};
use ardia_update_core::{
    check_offer, installer_in_windows_manifest, package_in_linux_manifest, verify_linux_update, verify_windows_update,
    Channel, Package, PackageKind, UpdateError, Version, WindowsCpu, WindowsUpdate, MAX_PACKAGE_BYTES,
    MAX_WINDOWS_BUILD, MAX_WINDOWS_INSTALLER_BYTES, MAX_WINDOWS_MANIFEST_BYTES, WINDOWS_PUBLISHED_UNDER,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Map, Value};

const RELEASE_SEED: [u8; 32] = [0x52; 32];
const OTHER_SEED: [u8; 32] = [0x4f; 32];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/update-vectors.json")
}

fn digest(kind: &str, version: &str) -> String {
    hex(&Backend::sha256(format!("{kind} {version}").as_bytes()))
}

fn line(kind: &str, version: &str, size: u64) -> String {
    let extension = PackageKind::from_name(kind).map_or("rpm", PackageKind::extension);
    format!(
        "{kind} Ardia-{version}-linux-x64.{extension} {} {size}",
        digest(kind, version)
    )
}

fn manifest(version: &str, packages: &[(&str, u64)]) -> String {
    let mut text = format!("ardia-linux-update 1\nversion {version}\n");
    for (kind, size) in packages {
        text.push_str(&line(kind, version, *size));
        text.push('\n');
    }
    text
}

fn full(version: &str) -> String {
    manifest(version, &[("deb", 1000), ("tarball", 2000), ("appimage", 3000)])
}

enum Signing {
    Release,
    Other,
    Over(String),
    Flipped,
    Length(usize),
    SmallOrder,
}

struct Case {
    name: &'static str,
    manifest: Vec<u8>,
    signing: Signing,
    version: &'static str,
    installed: &'static str,
    kind: PackageKind,
    want: Result<(), UpdateError>,
    overrides: Vec<(&'static str, Value)>,
}

fn case(name: &'static str, manifest: impl Into<Vec<u8>>, want: Result<(), UpdateError>) -> Case {
    Case {
        name,
        manifest: manifest.into(),
        signing: Signing::Release,
        version: "0.2.48",
        installed: "0.2.47",
        kind: PackageKind::Deb,
        want,
        overrides: Vec::new(),
    }
}

impl Case {
    fn signing(mut self, signing: Signing) -> Self {
        self.signing = signing;
        self
    }

    fn versions(mut self, version: &'static str, installed: &'static str) -> Self {
        self.version = version;
        self.installed = installed;
        self
    }

    fn kind(mut self, kind: PackageKind) -> Self {
        self.kind = kind;
        self
    }

    fn differs(mut self, implementation: &'static str, outcome: Value) -> Self {
        self.overrides.push((implementation, outcome));
        self
    }
}

fn error(code: &str) -> Value {
    json!({ "error": code })
}

fn ok_size(kind: PackageKind, version: &str, size: u64) -> Value {
    json!({ "name": kind.package_name(version), "size": size })
}

fn small_order_key_and_signature() -> ([u8; 32], [u8; 64]) {
    let mut key = [0u8; 32];
    key[0] = 1;
    let mut signature = [0u8; 64];
    signature[0] = 1;
    (key, signature)
}

fn sign(case: &Case) -> ([u8; 32], Vec<u8>) {
    let release = SigningKey::from_bytes(&RELEASE_SEED);
    let public = release.verifying_key().to_bytes();
    match &case.signing {
        Signing::Release => (public, release.sign(&case.manifest).to_bytes().to_vec()),
        Signing::Other => (
            public,
            SigningKey::from_bytes(&OTHER_SEED)
                .sign(&case.manifest)
                .to_bytes()
                .to_vec(),
        ),
        Signing::Over(original) => (public, release.sign(original.as_bytes()).to_bytes().to_vec()),
        Signing::Flipped => {
            let mut signature = release.sign(&case.manifest).to_bytes();
            signature[10] ^= 0x01;
            (public, signature.to_vec())
        }
        Signing::Length(length) => {
            let mut signature = release.sign(&case.manifest).to_bytes().to_vec();
            signature.resize(*length, 0);
            (public, signature)
        }
        Signing::SmallOrder => {
            let (key, signature) = small_order_key_and_signature();
            (key, signature.to_vec())
        }
    }
}

fn outcome(result: Result<Package, UpdateError>, version: &str) -> Value {
    match result {
        Ok(package) => {
            json!({ "name": package.kind.package_name(version), "sha256": hex(&package.sha256), "size": package.size })
        }
        Err(error) => json!({ "error": error.code() }),
    }
}

fn cases() -> Vec<Case> {
    use PackageKind::{AppImage, Deb, Tarball};
    use UpdateError as E;
    let base = full("0.2.48");
    let mut oversized = base.clone();
    while oversized.len() <= 4096 {
        oversized.push_str("x\n");
    }
    oversized.truncate(4097);
    let over_cap = MAX_PACKAGE_BYTES + 1;
    vec![
        case("deb install, all three formats", base.clone(), Ok(())),
        case("tarball install, all three formats", base.clone(), Ok(())).kind(Tarball),
        case("AppImage install, all three formats", base.clone(), Ok(())).kind(AppImage),
        case(
            "only an AppImage, AppImage install",
            manifest("0.2.48", &[("appimage", 5)]),
            Ok(()),
        )
        .kind(AppImage),
        case("nightly over the previous stable", full("0.2.48-nightly.3"), Ok(()))
            .versions("0.2.48-nightly.3", "0.2.47"),
        case("stable over its own nightly", base.clone(), Ok(())).versions("0.2.48", "0.2.48-nightly.3"),
        case("nightly over the previous nightly", full("0.2.48-nightly.10"), Ok(()))
            .versions("0.2.48-nightly.10", "0.2.48-nightly.9"),
        case(
            "a package of exactly 512 MiB",
            manifest("0.2.48", &[("deb", MAX_PACKAGE_BYTES)]),
            Ok(()),
        ),
        case(
            "no line for this kind",
            manifest("0.2.48", &[("tarball", 2), ("appimage", 3)]),
            Err(E::Kind),
        ),
        case("no package lines at all", manifest("0.2.48", &[]), Err(E::Kind)),
        case("tampered size", base.replace(" 1000\n", " 1001\n"), Err(E::Signature))
            .signing(Signing::Over(base.clone())),
        case(
            "tampered digest",
            base.replacen(&digest("deb", "0.2.48"), &digest("deb", "0.2.49"), 1),
            Err(E::Signature),
        )
        .signing(Signing::Over(base.clone())),
        case(
            "tampered and malformed",
            base.replace("version ", "version  "),
            Err(E::Signature),
        )
        .signing(Signing::Over(base.clone())),
        case("one flipped signature bit", base.clone(), Err(E::Signature)).signing(Signing::Flipped),
        case("signed by another key", base.clone(), Err(E::Signature)).signing(Signing::Other),
        case("a 63-byte signature", base.clone(), Err(E::Signature)).signing(Signing::Length(63)),
        case("a 65-byte signature", base.clone(), Err(E::Signature)).signing(Signing::Length(65)),
        case("an empty signature", base.clone(), Err(E::Signature)).signing(Signing::Length(0)),
        case(
            "small-order key with its trivial signature",
            base.clone(),
            Err(E::Signature),
        )
        .signing(Signing::SmallOrder)
        .differs("openssl", json!(true)),
        case("the installed version again", base.clone(), Err(E::NotNewer)).versions("0.2.48", "0.2.48"),
        case("a downgrade", full("0.2.47"), Err(E::NotNewer)).versions("0.2.47", "0.2.48"),
        case(
            "a nightly of the installed stable",
            full("0.2.48-nightly.9"),
            Err(E::NotNewer),
        )
        .versions("0.2.48-nightly.9", "0.2.48"),
        case("an older nightly", full("0.2.48-nightly.2"), Err(E::NotNewer))
            .versions("0.2.48-nightly.2", "0.2.48-nightly.3"),
        case("the same version with leading zeros", full("0.2.048"), Err(E::NotNewer)).versions("0.2.048", "0.2.48"),
        case("a manifest for another version", full("0.2.49"), Err(E::Manifest)),
        case("format 2", base.replace("update 1\n", "update 2\n"), Err(E::Manifest)),
        case(
            "no trailing newline",
            base.trim_end_matches('\n').to_owned(),
            Err(E::Manifest),
        ),
        case("CRLF line endings", base.replace('\n', "\r\n"), Err(E::Manifest)),
        case(
            "a blank line between packages",
            base.replacen("\ntarball", "\n\ntarball", 1),
            Err(E::Manifest),
        ),
        case("a trailing blank line", format!("{base}\n"), Err(E::Manifest)),
        case(
            "packages out of order",
            format!(
                "ardia-linux-update 1\nversion 0.2.48\n{}\n{}\n",
                line("tarball", "0.2.48", 2),
                line("deb", "0.2.48", 1)
            ),
            Err(E::Manifest),
        ),
        case(
            "the deb line twice",
            format!(
                "ardia-linux-update 1\nversion 0.2.48\n{}\n{}\n",
                line("deb", "0.2.48", 1),
                line("deb", "0.2.48", 1)
            ),
            Err(E::Manifest),
        ),
        case(
            "a package named for another version",
            base.replace("Ardia-0.2.48-linux-x64.deb", "Ardia-0.2.47-linux-x64.deb"),
            Err(E::Manifest),
        ),
        case(
            "an arm64 package name",
            base.replace("Ardia-0.2.48-linux-x64.deb", "Ardia-0.2.48-linux-arm64.deb"),
            Err(E::Manifest),
        ),
        case(
            "a path in the package name",
            base.replace("Ardia-0.2.48-linux-x64.deb", "../Ardia-0.2.48-linux-x64.deb"),
            Err(E::Manifest),
        ),
        case(
            "an uppercase digest",
            base.replacen(&digest("deb", "0.2.48"), &digest("deb", "0.2.48").to_uppercase(), 1),
            Err(E::Manifest),
        ),
        case(
            "a 63-character digest",
            base.replacen(&digest("deb", "0.2.48"), &digest("deb", "0.2.48")[1..], 1),
            Err(E::Manifest),
        ),
        case("a zero size", base.replace(" 1000\n", " 0\n"), Err(E::Manifest)),
        case(
            "a size with a leading zero",
            base.replace(" 1000\n", " 01000\n"),
            Err(E::Manifest),
        ),
        case("a signed size", base.replace(" 1000\n", " +1000\n"), Err(E::Manifest)),
        case(
            "another format over 512 MiB, tarball install",
            manifest("0.2.48", &[("deb", over_cap), ("tarball", 2)]),
            Err(E::Manifest),
        )
        .kind(Tarball)
        .differs("linuxPolicy", ok_size(Tarball, "0.2.48", 2)),
        case(
            "this format over 512 MiB",
            manifest("0.2.48", &[("deb", over_cap)]),
            Err(E::Manifest),
        )
        .differs("linuxPolicy", error("tooLarge")),
        case(
            "an eleven-digit size",
            manifest("0.2.48", &[("deb", 10_000_000_000)]),
            Err(E::Manifest),
        )
        .differs("linuxPolicy", error("tooLarge")),
        case(
            "two spaces between fields",
            base.replacen(" Ardia-", "  Ardia-", 1),
            Err(E::Manifest),
        ),
        case(
            "a tab between fields",
            base.replacen(" Ardia-", "\tArdia-", 1),
            Err(E::Manifest),
        ),
        case(
            "a trailing space",
            base.replace(" 1000\n", " 1000 \n"),
            Err(E::Manifest),
        ),
        case(
            "an rpm line",
            format!("ardia-linux-update 1\nversion 0.2.48\n{}\n", line("rpm", "0.2.48", 1)),
            Err(E::Manifest),
        ),
        case("a beta version line", full("0.2.48-beta.1"), Err(E::Manifest)),
        case(
            "no version line",
            base.replace("version 0.2.48\n", ""),
            Err(E::Manifest),
        ),
        case("a NUL byte", base.replace(" 1000\n", " 1000\0\n"), Err(E::Manifest)),
        case(
            "non-ASCII in a name",
            base.replace("Ardia-0.2.48-linux-x64.deb", "Ardía-0.2.48-linux-x64.deb"),
            Err(E::Manifest),
        ),
        case("the header alone", "ardia-linux-update 1\n", Err(E::Manifest)),
        case("an empty manifest", "", Err(E::Manifest)),
        case("4097 bytes", oversized.clone(), Err(E::TooLarge)).differs("helper", error("manifest")),
        case("4097 bytes with a bad signature", oversized, Err(E::TooLarge))
            .signing(Signing::Flipped)
            .differs("helper", error("manifest")),
        case("a ten-digit version part", full("1000000000.0.0"), Err(E::Version))
            .versions("1000000000.0.0", "0.2.47")
            .differs("linuxPolicy", ok_size(Deb, "1000000000.0.0", 1000))
            .differs("helper", error("manifest")),
        case("a malformed requested version", base.clone(), Err(E::Version))
            .versions("latest", "0.2.47")
            .differs("linuxPolicy", error("manifest"))
            .differs("helper", error("manifest")),
        case("a malformed installed version", base.clone(), Err(E::Version))
            .versions("0.2.48", "0.2.47-beta")
            .differs("helper", error("kind")),
    ]
}

fn version_section() -> Value {
    let valid = [
        "0.0.0",
        "0.2.48",
        "0.2.48-nightly.0",
        "0.2.48-nightly.3",
        "01.2.3",
        "999999999.999999999.999999999-nightly.999999999",
    ];
    let invalid: [(&str, &[&str]); 21] = [
        ("", &[]),
        ("0.2", &[]),
        ("0.2.48.1", &[]),
        ("v0.2.48", &[]),
        (" 0.2.48", &[]),
        ("0.2.48 ", &[]),
        ("0.2.48\n", &[]),
        ("0.2.48-beta.1", &[]),
        ("0.2.48-nightly", &[]),
        ("0.2.48-nightly.", &[]),
        ("0.2.48-nightly.1.2", &[]),
        ("0.2.48-Nightly.1", &[]),
        ("0.2.48-nightly.-1", &[]),
        ("0.2.48+build", &[]),
        ("0..48", &[]),
        ("-1.2.3", &[]),
        ("0.2.4８", &[]),
        ("1000000000.0.0", &["linuxPolicy", "linuxReleases"]),
        ("0.2.48-nightly.1000000000", &["linuxPolicy", "linuxReleases"]),
        ("0.2.48-", &[]),
        ("0x1.2.3", &[]),
    ];
    let ascending = [
        "0.0.0",
        "0.0.1",
        "0.1.0",
        "0.2.9",
        "0.2.10",
        "0.2.47",
        "0.2.48-nightly.0",
        "0.2.48-nightly.1",
        "0.2.48-nightly.9",
        "0.2.48-nightly.10",
        "0.2.48",
        "0.2.49-nightly.1",
        "0.2.49",
        "0.10.0",
        "1.0.0-nightly.1",
        "1.0.0",
        "2.0.0",
        "999999999.999999999.999999999-nightly.999999999",
        "999999999.999999999.999999999",
    ];
    let equal = [
        ("1.2.3", "01.2.3"),
        ("0.2.48", "0.2.048"),
        ("0.2.48-nightly.3", "0.2.48-nightly.03"),
    ];
    for version in valid {
        assert!(Version::parse(version).is_ok(), "{version}");
    }
    for (version, _) in invalid {
        assert_eq!(Version::parse(version), Err(UpdateError::Version), "{version:?}");
    }
    for (index, left) in ascending.iter().enumerate() {
        for right in &ascending[index + 1..] {
            assert!(
                Version::parse(left).unwrap() < Version::parse(right).unwrap(),
                "{left} < {right}"
            );
        }
    }
    for (left, right) in equal {
        assert_eq!(Version::parse(left).unwrap(), Version::parse(right).unwrap());
    }
    json!({
        "valid": valid.iter().map(|version| json!({
            "version": version,
            "channel": Version::parse(version).unwrap().channel().name(),
        })).collect::<Vec<_>>(),
        "invalid": invalid.iter().map(|(version, accepted_by)| json!({
            "version": version,
            "acceptedBy": accepted_by,
        })).collect::<Vec<_>>(),
        "ascending": ascending,
        "equal": equal.iter().map(|(left, right)| json!([left, right])).collect::<Vec<_>>(),
    })
}

fn offer_section() -> Value {
    use Channel::{Nightly, Stable};
    use UpdateError as E;
    let offers: [(&str, &str, Channel, Result<(), UpdateError>); 13] = [
        ("0.2.48", "0.2.47", Stable, Ok(())),
        ("0.2.48", "0.2.47", Nightly, Ok(())),
        ("0.2.48-nightly.1", "0.2.47", Nightly, Ok(())),
        ("0.2.48-nightly.1", "0.2.47", Stable, Err(E::Channel)),
        ("0.2.48", "0.2.48-nightly.7", Stable, Ok(())),
        ("0.2.48-nightly.8", "0.2.48-nightly.7", Nightly, Ok(())),
        ("0.2.48-nightly.7", "0.2.48-nightly.7", Nightly, Err(E::NotNewer)),
        ("0.2.48-nightly.6", "0.2.48-nightly.7", Nightly, Err(E::NotNewer)),
        ("0.2.47", "0.2.48-nightly.1", Stable, Err(E::NotNewer)),
        ("0.2.48", "0.2.48", Stable, Err(E::NotNewer)),
        ("0.2.47", "0.2.48", Nightly, Err(E::NotNewer)),
        ("0.2.48-beta.1", "0.2.47", Nightly, Err(E::Version)),
        ("0.2.48", "", Stable, Err(E::Version)),
    ];
    offers
        .iter()
        .map(|(candidate, installed, channel, want)| {
            assert_eq!(
                check_offer(candidate, installed, *channel),
                *want,
                "{candidate} over {installed}"
            );
            json!({
                "candidate": candidate,
                "installed": installed,
                "channel": channel.name(),
                "outcome": match want { Ok(()) => "ok", Err(error) => error.code() },
            })
        })
        .collect()
}

struct WindowsCase {
    name: &'static str,
    manifest: Vec<u8>,
    signing: Signing,
    published_under: &'static str,
    cpu: WindowsCpu,
    current_build: u64,
    want: Result<(), UpdateError>,
    overrides: Vec<(&'static str, Value)>,
}

fn windows_digest(cpu: &str, build: u64) -> String {
    hex(&Backend::sha256(format!("windows {cpu} {build}").as_bytes()))
}

fn windows_manifest_json(
    version: &str,
    build: u64,
    x64: Option<(&str, &str, u64)>,
    arm64: Option<(&str, &str, u64)>,
) -> String {
    let mut map = Map::new();
    map.insert("version".into(), json!(version));
    map.insert("build".into(), json!(build));
    if let Some((url, sha, bytes)) = x64 {
        map.insert("x64".into(), json!({ "url": url, "sha256": sha, "bytes": bytes }));
    }
    if let Some((url, sha, bytes)) = arm64 {
        map.insert("arm64".into(), json!({ "url": url, "sha256": sha, "bytes": bytes }));
    }
    serde_json::to_string_pretty(&Value::Object(map)).unwrap() + "\n"
}

fn windows_full(version: &str, build: u64) -> String {
    let x64_url = format!("{WINDOWS_PUBLISHED_UNDER}windows-alpha/Ardia-Setup-x64-{build}.exe");
    let arm64_url = format!("{WINDOWS_PUBLISHED_UNDER}windows-alpha/Ardia-Setup-arm64-{build}.exe");
    let x64_sha = windows_digest("x64", build);
    let arm64_sha = windows_digest("arm64", build);
    windows_manifest_json(
        version,
        build,
        Some((&x64_url, &x64_sha, 180_000_000)),
        Some((&arm64_url, &arm64_sha, 175_000_000)),
    )
}

fn win_case(name: &'static str, manifest: impl Into<Vec<u8>>, want: Result<(), UpdateError>) -> WindowsCase {
    WindowsCase {
        name,
        manifest: manifest.into(),
        signing: Signing::Release,
        published_under: WINDOWS_PUBLISHED_UNDER,
        cpu: WindowsCpu::X64,
        current_build: 59,
        want,
        overrides: Vec::new(),
    }
}

impl WindowsCase {
    fn signing(mut self, signing: Signing) -> Self {
        self.signing = signing;
        self
    }

    fn published_under(mut self, prefix: &'static str) -> Self {
        self.published_under = prefix;
        self
    }

    fn cpu(mut self, cpu: WindowsCpu) -> Self {
        self.cpu = cpu;
        self
    }

    fn current_build(mut self, build: u64) -> Self {
        self.current_build = build;
        self
    }

    fn differs(mut self, implementation: &'static str, outcome: Value) -> Self {
        self.overrides.push((implementation, outcome));
        self
    }
}

fn sign_bytes(manifest: &[u8], signing: &Signing) -> ([u8; 32], Vec<u8>) {
    let release = SigningKey::from_bytes(&RELEASE_SEED);
    let public = release.verifying_key().to_bytes();
    match signing {
        Signing::Release => (public, release.sign(manifest).to_bytes().to_vec()),
        Signing::Other => (
            public,
            SigningKey::from_bytes(&OTHER_SEED).sign(manifest).to_bytes().to_vec(),
        ),
        Signing::Over(original) => (public, release.sign(original.as_bytes()).to_bytes().to_vec()),
        Signing::Flipped => {
            let mut signature = release.sign(manifest).to_bytes();
            signature[10] ^= 0x01;
            (public, signature.to_vec())
        }
        Signing::Length(length) => {
            let mut signature = release.sign(manifest).to_bytes().to_vec();
            signature.resize(*length, 0);
            (public, signature)
        }
        Signing::SmallOrder => {
            let (key, signature) = small_order_key_and_signature();
            (key, signature.to_vec())
        }
    }
}

fn windows_outcome(result: Result<WindowsUpdate<'_>, UpdateError>) -> Value {
    match result {
        Ok(update) => json!({
            "version": update.version,
            "build": update.build,
            "url": update.installer.url,
            "sha256": hex(&update.installer.sha256),
            "bytes": update.installer.bytes,
        }),
        Err(error) => json!({ "error": error.code() }),
    }
}

fn windows_cases() -> Vec<WindowsCase> {
    use UpdateError as E;
    use WindowsCpu::Arm64;
    let base = windows_full("0.2.48-nightly.1", 60);
    let x64_sha = windows_digest("x64", 60);
    let arm64_sha = windows_digest("arm64", 60);
    let x64_url = format!("{WINDOWS_PUBLISHED_UNDER}windows-alpha/Ardia-Setup-x64-60.exe");
    let arm64_url = format!("{WINDOWS_PUBLISHED_UNDER}windows-alpha/Ardia-Setup-arm64-60.exe");
    let local_prefix = "http://10.0.2.2:18770/feed/";
    let local_manifest = windows_manifest_json(
        "0.2.48",
        60,
        None,
        Some(("http://10.0.2.2:18770/feed/Ardia-Setup-arm64-60.exe", &arm64_sha, 10)),
    );
    let loopback_prefix = "http://127.0.0.1:18770/feed/";
    let loopback_manifest = windows_manifest_json(
        "0.2.48",
        60,
        Some(("http://127.0.0.1:18770/feed/Ardia-Setup-x64-60.exe", &x64_sha, 10)),
        None,
    );
    let mut oversized = base.clone();
    while oversized.len() <= MAX_WINDOWS_MANIFEST_BYTES {
        oversized.push(' ');
    }
    oversized.truncate(MAX_WINDOWS_MANIFEST_BYTES + 1);
    let over_url = format!("{WINDOWS_PUBLISHED_UNDER}windows-alpha/{}.exe", "a".repeat(500));
    vec![
        win_case("x64 install, both CPUs", base.clone(), Ok(())),
        win_case("arm64 install, both CPUs", base.clone(), Ok(())).cpu(Arm64),
        win_case(
            "only arm64 published, arm64 install",
            windows_manifest_json("0.2.48", 60, None, Some((&arm64_url, &arm64_sha, 100))),
            Ok(()),
        )
        .cpu(Arm64),
        win_case("current build zero accepts build 1", windows_full("0.2.48", 1), Ok(())).current_build(0),
        win_case(
            "installer at exact 1 GiB cap",
            windows_manifest_json("0.2.48", 60, Some((&x64_url, &x64_sha, MAX_WINDOWS_INSTALLER_BYTES)), None),
            Ok(()),
        ),
        win_case("local QEMU test feed on 10.0.2.2", local_manifest, Ok(()))
            .published_under(local_prefix)
            .cpu(Arm64),
        win_case("local loopback test feed on 127.0.0.1", loopback_manifest, Ok(()))
            .published_under(loopback_prefix),
        win_case("only x64 published, arm64 install", windows_manifest_json("0.2.48", 60, Some((&x64_url, &x64_sha, 100)), None), Err(E::Kind))
            .cpu(Arm64),
        win_case("no installers listed", windows_manifest_json("0.2.48", 60, None, None), Err(E::Kind)),
        win_case("same build as installed", base.clone(), Err(E::NotNewer)).current_build(60),
        win_case("downgrade build", base.clone(), Err(E::NotNewer)).current_build(61),
        win_case("tampered build", base.replace("60", "61"), Err(E::Signature)).signing(Signing::Over(base.clone())),
        win_case(
            "tampered sha256",
            base.replacen(&x64_sha, &windows_digest("x64", 61), 1),
            Err(E::Signature),
        )
        .signing(Signing::Over(base.clone())),
        win_case(
            "tampered bytes",
            base.replace("180000000", "180000001"),
            Err(E::Signature),
        )
        .signing(Signing::Over(base.clone())),
        win_case("one flipped signature bit", base.clone(), Err(E::Signature)).signing(Signing::Flipped),
        win_case("signed by another key", base.clone(), Err(E::Signature)).signing(Signing::Other),
        win_case("a 63-byte signature", base.clone(), Err(E::Signature)).signing(Signing::Length(63)),
        win_case("a 65-byte signature", base.clone(), Err(E::Signature)).signing(Signing::Length(65)),
        win_case("an empty signature", base.clone(), Err(E::Signature)).signing(Signing::Length(0)),
        win_case("small-order key with its trivial signature", base.clone(), Err(E::Signature))
            .signing(Signing::SmallOrder),
        win_case("a validly signed Linux manifest is rejected on Windows", full("0.2.48"), Err(E::Manifest)),
        win_case("empty manifest", "", Err(E::Manifest)),
        win_case("HTML response", "<html>404</html>", Err(E::Manifest)),
        win_case("JSON array", "[]", Err(E::Manifest)),
        win_case("JSON null", "null", Err(E::Manifest)),
        win_case("trailing garbage after object", format!("{base}{{}}"), Err(E::Manifest)),
        win_case(
            "UTF-8 BOM before object",
            format!("\u{feff}{base}"),
            Err(E::Manifest),
        ),
        win_case(
            "trailing comma in object",
            format!("{{\"version\":\"0.2.48\",\"build\":60,\"x64\":{{\"url\":\"{x64_url}\",\"sha256\":\"{x64_sha}\",\"bytes\":10,}}}}"),
            Err(E::Manifest),
        ),
        win_case(
            "duplicate top-level build key",
            format!("{{\"version\":\"0.2.48\",\"build\":60,\"build\":61,\"x64\":{{\"url\":\"{x64_url}\",\"sha256\":\"{x64_sha}\",\"bytes\":10}}}}"),
            Err(E::Manifest),
        ),
        win_case(
            "unknown top-level key",
            format!("{{\"version\":\"0.2.48\",\"build\":60,\"extra\":1,\"x64\":{{\"url\":\"{x64_url}\",\"sha256\":\"{x64_sha}\",\"bytes\":10}}}}"),
            Err(E::Manifest),
        ),
        win_case(
            "unknown installer key",
            format!("{{\"version\":\"0.2.48\",\"build\":60,\"x64\":{{\"url\":\"{x64_url}\",\"sha256\":\"{x64_sha}\",\"bytes\":10,\"extra\":1}}}}"),
            Err(E::Manifest),
        ),
        win_case(
            "duplicate installer url key",
            format!("{{\"version\":\"0.2.48\",\"build\":60,\"x64\":{{\"url\":\"{x64_url}\",\"url\":\"{x64_url}\",\"sha256\":\"{x64_sha}\",\"bytes\":10}}}}"),
            Err(E::Manifest),
        ),
        win_case("missing version", format!("{{\"build\":60,\"x64\":{{\"url\":\"{x64_url}\",\"sha256\":\"{x64_sha}\",\"bytes\":10}}}}"), Err(E::Manifest)),
        win_case("missing build", format!("{{\"version\":\"0.2.48\",\"x64\":{{\"url\":\"{x64_url}\",\"sha256\":\"{x64_sha}\",\"bytes\":10}}}}"), Err(E::Manifest)),
        win_case("empty version", base.replace("\"0.2.48-nightly.1\"", "\"\""), Err(E::Manifest)),
        win_case("single-segment version 1", base.replace("\"0.2.48-nightly.1\"", "\"1\""), Ok(())),
        win_case("non-digit version constructor", base.replace("\"0.2.48-nightly.1\"", "\"constructor\""), Err(E::Manifest)),
        win_case("version with space", base.replace("\"0.2.48-nightly.1\"", "\"0.2.48 nightly\""), Err(E::Manifest)),
        win_case("version starting with dash", base.replace("\"0.2.48-nightly.1\"", "\"-0.2.48\""), Err(E::Manifest)),
        win_case(
            "version over 64 characters",
            base.replace("\"0.2.48-nightly.1\"", &format!("\"{}\"", "1".repeat(65))),
            Err(E::Manifest),
        ),
        win_case("build zero", base.replace("\"build\": 60", "\"build\": 0"), Err(E::Manifest)),
        win_case("negative build", base.replace("\"build\": 60", "\"build\": -1"), Err(E::Manifest)),
        win_case("fractional build", base.replace("\"build\": 60", "\"build\": 60.5"), Err(E::Manifest)),
        win_case("decimal integer build 60.0", base.replace("\"build\": 60", "\"build\": 60.0"), Err(E::Manifest)),
        win_case("exponent integer build 6e1", base.replace("\"build\": 60", "\"build\": 6e1"), Err(E::Manifest)),
        win_case("string build", base.replace("\"build\": 60", "\"build\": \"60\""), Err(E::Manifest)),
        win_case("leading zero build", base.replace("\"build\": 60", "\"build\": 060"), Err(E::Manifest)),
        win_case(
            "build above MAX_SAFE_INTEGER",
            base.replace("\"build\": 60", &format!("\"build\": {}", MAX_WINDOWS_BUILD + 1)),
            Err(E::Manifest),
        ),
        win_case(
            "installer from another host",
            windows_manifest_json("0.2.48", 60, Some(("https://example.com/Ardia-Setup-x64-60.exe", &x64_sha, 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "installer over plain http on github",
            windows_manifest_json("0.2.48", 60, Some(("http://github.com/ardia-browser/ardia/releases/download/windows-alpha/Ardia-Setup-x64-60.exe", &x64_sha, 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "installer with non-exe extension",
            windows_manifest_json("0.2.48", 60, Some((&format!("{WINDOWS_PUBLISHED_UNDER}windows-alpha/Ardia-Setup-x64-60.msi"), &x64_sha, 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "installer URL with path traversal",
            windows_manifest_json("0.2.48", 60, Some((&format!("{WINDOWS_PUBLISHED_UNDER}../../../other/repo/releases/download/x/Setup.exe"), &x64_sha, 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "installer URL with query string",
            windows_manifest_json("0.2.48", 60, Some((&format!("{WINDOWS_PUBLISHED_UNDER}windows-alpha/Setup.exe?x=1.exe"), &x64_sha, 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "installer URL with percent encoding",
            windows_manifest_json("0.2.48", 60, Some((&format!("{WINDOWS_PUBLISHED_UNDER}windows-alpha/%2e%2e/Setup.exe"), &x64_sha, 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "installer URL with userinfo",
            windows_manifest_json("0.2.48", 60, Some((&format!("{WINDOWS_PUBLISHED_UNDER}windows-alpha/a@b.exe"), &x64_sha, 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "installer URL with punctuation metacharacters",
            windows_manifest_json("0.2.48", 60, Some((&format!("{WINDOWS_PUBLISHED_UNDER}windows-alpha/||ardia-fixture.invalid^.exe"), &x64_sha, 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "installer URL with backslash escape",
            format!("{{\"version\":\"0.2.48\",\"build\":60,\"x64\":{{\"url\":\"{WINDOWS_PUBLISHED_UNDER}windows-alpha\\/Ardia-Setup-x64-60.exe\",\"sha256\":\"{x64_sha}\",\"bytes\":10}}}}"),
            Err(E::Manifest),
        ),
        win_case(
            "installer URL over 512 bytes",
            windows_manifest_json("0.2.48", 60, Some((&over_url, &x64_sha, 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "bare .exe filename",
            windows_manifest_json("0.2.48", 60, Some((&format!("{WINDOWS_PUBLISHED_UNDER}windows-alpha/.exe"), &x64_sha, 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "uppercase installer sha256",
            windows_manifest_json("0.2.48", 60, Some((&x64_url, &x64_sha.to_uppercase(), 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "short installer sha256",
            windows_manifest_json("0.2.48", 60, Some((&x64_url, &x64_sha[..63], 10)), None),
            Err(E::Manifest),
        ),
        win_case(
            "zero installer bytes",
            base.replace("180000000", "0"),
            Err(E::Manifest),
        ),
        win_case(
            "exponent installer bytes 1e2",
            base.replace("180000000", "1e2"),
            Err(E::Manifest),
        ),
        win_case(
            "decimal installer bytes 180000000.0",
            base.replace("180000000", "180000000.0"),
            Err(E::Manifest),
        ),
        win_case(
            "installer over 1 GiB cap",
            windows_manifest_json("0.2.48", 60, Some((&x64_url, &x64_sha, MAX_WINDOWS_INSTALLER_BYTES + 1)), None),
            Err(E::Manifest),
        ),
        win_case(
            "bad x64 entry poisons manifest even for arm64",
            windows_manifest_json(
                "0.2.48",
                60,
                Some(("https://example.com/bad.exe", &x64_sha, 10)),
                Some((&arm64_url, &arm64_sha, 100)),
            ),
            Err(E::Manifest),
        )
        .cpu(Arm64),
        win_case(
            "non-local http publishedUnder refused",
            windows_manifest_json("0.2.48", 60, Some(("http://example.com/feed/Ardia-Setup-x64-60.exe", &x64_sha, 10)), None),
            Err(E::Manifest),
        )
        .published_under("http://example.com/feed/"),
        win_case("65537 bytes", oversized.clone(), Err(E::TooLarge)).differs("helper", error("manifest")),
        win_case("65537 bytes with a bad signature", oversized, Err(E::TooLarge))
            .signing(Signing::Flipped)
            .differs("helper", error("manifest")),
    ]
}

fn generate() -> Value {
    let release = SigningKey::from_bytes(&RELEASE_SEED).verifying_key().to_bytes();
    let other = SigningKey::from_bytes(&OTHER_SEED).verifying_key().to_bytes();
    let mut names = std::collections::BTreeSet::new();
    let manifests: Vec<Value> = cases()
        .into_iter()
        .map(|case| {
            assert!(names.insert(case.name), "two cases named {}", case.name);
            let (public_key, signature) = sign(&case);
            let result = verify_linux_update::<Backend>(
                &public_key,
                &case.manifest,
                &signature,
                case.version,
                case.installed,
                case.kind,
            );
            assert_eq!(
                result.as_ref().map(|_| ()).map_err(|error| *error),
                case.want,
                "{}",
                case.name
            );
            let signature_valid = <[u8; 64]>::try_from(signature.as_slice())
                .is_ok_and(|signature| Backend::ed25519_verify(&public_key, &case.manifest, &signature));
            let mut entry = Map::new();
            entry.insert("name".into(), json!(case.name));
            entry.insert(
                "manifest".into(),
                json!(String::from_utf8(case.manifest.clone()).expect("vector manifests are UTF-8")),
            );
            entry.insert("signature".into(), json!(hex(&signature)));
            entry.insert("publicKey".into(), json!(hex(&public_key)));
            entry.insert("version".into(), json!(case.version));
            entry.insert("installed".into(), json!(case.installed));
            entry.insert("kind".into(), json!(case.kind.name()));
            entry.insert("signatureValid".into(), json!(signature_valid));
            entry.insert("outcome".into(), outcome(result, case.version));
            entry.insert(
                "parse".into(),
                outcome(
                    package_in_linux_manifest(&case.manifest, case.version, case.kind),
                    case.version,
                ),
            );
            for (implementation, differs) in case.overrides {
                entry.insert(implementation.into(), differs);
            }
            Value::Object(entry)
        })
        .collect();
    let mut win_names = std::collections::BTreeSet::new();
    let windows: Vec<Value> = windows_cases()
        .into_iter()
        .map(|case| {
            assert!(win_names.insert(case.name), "two windows cases named {}", case.name);
            let (public_key, signature) = sign_bytes(&case.manifest, &case.signing);
            let result = verify_windows_update::<Backend>(
                &public_key,
                &case.manifest,
                &signature,
                case.published_under,
                case.cpu,
                case.current_build,
            );
            assert_eq!(
                result.as_ref().map(|_| ()).map_err(|error| *error),
                case.want,
                "{}",
                case.name
            );
            let signature_valid = <[u8; 64]>::try_from(signature.as_slice())
                .is_ok_and(|signature| Backend::ed25519_verify(&public_key, &case.manifest, &signature));
            let mut entry = Map::new();
            entry.insert("name".into(), json!(case.name));
            entry.insert(
                "manifest".into(),
                json!(String::from_utf8(case.manifest.clone()).expect("vector manifests are UTF-8")),
            );
            entry.insert("signature".into(), json!(hex(&signature)));
            entry.insert("publicKey".into(), json!(hex(&public_key)));
            entry.insert("publishedUnder".into(), json!(case.published_under));
            entry.insert("cpu".into(), json!(case.cpu.name()));
            entry.insert("currentBuild".into(), json!(case.current_build));
            entry.insert("signatureValid".into(), json!(signature_valid));
            entry.insert("outcome".into(), windows_outcome(result));
            entry.insert(
                "parse".into(),
                windows_outcome(installer_in_windows_manifest(
                    &case.manifest,
                    case.published_under,
                    case.cpu,
                )),
            );
            for (implementation, differs) in case.overrides {
                entry.insert(implementation.into(), differs);
            }
            Value::Object(entry)
        })
        .collect();
    json!({
        "format": "ardia-linux-update 1",
        "keys": { "release": hex(&release), "other": hex(&other) },
        "manifests": manifests,
        "windows": windows,
        "versions": version_section(),
        "offers": offer_section(),
    })
}

#[test]
fn the_committed_vectors_are_current() {
    let generated = serde_json::to_string_pretty(&generate()).unwrap() + "\n";
    let path = vectors_path();
    if std::env::var_os("ARDIA_WRITE_UPDATE_VECTORS").is_some() {
        fs::write(&path, &generated).unwrap();
    }
    let committed = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
    assert_eq!(
        committed, generated,
        "tests/update-vectors.json is stale: run ARDIA_WRITE_UPDATE_VECTORS=1 cargo test -p ardia-update-core --test vectors"
    );
}

#[test]
fn the_production_key_is_the_linux_installs_key() {
    for (relative, expected) in [
        (
            "../../../../scripts/linux/linux-update.pem",
            ardia_update_core::LINUX_UPDATE_PUBLIC_KEY,
        ),
        (
            "../../../../scripts/windows/windows-update.pem",
            ardia_update_core::WINDOWS_UPDATE_PUBLIC_KEY,
        ),
    ] {
        let pem = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)).unwrap();
        let body: String = pem.lines().filter(|line| !line.starts_with("-----")).collect();
        let spki_prefix = "MCowBQYDK2VwAyEA";
        let raw = body.strip_prefix(spki_prefix).expect("an Ed25519 SubjectPublicKeyInfo");
        let decoded = decode_base64(&format!("AAAA{raw}"));
        assert_eq!(decoded[3..], expected, "{relative}");
    }
}

fn decode_base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bits = 0u32;
    let mut count = 0;
    let mut out = Vec::new();
    for byte in text.bytes().filter(|byte| *byte != b'=') {
        bits = bits << 6 | ALPHABET.iter().position(|letter| *letter == byte).unwrap() as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
        }
    }
    out
}
