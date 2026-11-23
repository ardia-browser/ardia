use std::fs;
use std::path::PathBuf;

use ardia_crypto::{Backend, Crypto};
use ardia_update_core::{
    check_offer, package_in_linux_manifest, verify_linux_update, Channel, Package, PackageKind, UpdateError, Version,
    MAX_PACKAGE_BYTES,
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
    json!({
        "format": "ardia-linux-update 1",
        "keys": { "release": hex(&release), "other": hex(&other) },
        "manifests": manifests,
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
    let pem = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../scripts/linux/linux-update.pem"),
    )
    .unwrap();
    let body: String = pem.lines().filter(|line| !line.starts_with("-----")).collect();
    let spki_prefix = "MCowBQYDK2VwAyEA";
    let raw = body.strip_prefix(spki_prefix).expect("an Ed25519 SubjectPublicKeyInfo");
    let decoded = decode_base64(&format!("AAAA{raw}"));
    assert_eq!(decoded[3..], ardia_update_core::LINUX_UPDATE_PUBLIC_KEY);
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
