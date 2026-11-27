use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use ed25519_dalek::{Signer, SigningKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

const VERIFIER: &str = env!("CARGO_BIN_EXE_ardia-update-verify");
const RELEASE_SEED: [u8; 32] = [0x52; 32];
const OTHER_SEED: [u8; 32] = [0x4f; 32];
const SPKI_PREFIX: &str = "MCowBQYDK2VwAyEA";

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Scratch {
        let path = std::env::temp_dir().join(format!(
            "ardia-update-verify-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Scratch(fs::canonicalize(path).unwrap())
    }

    fn file(&self, name: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let value = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (index, byte)| acc | (*byte as u32) << (16 - 8 * index));
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(ALPHABET[(value >> (18 - 6 * index) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn pem(public_key: &[u8]) -> String {
    let mut der = vec![0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
    der.extend_from_slice(public_key);
    let encoded = base64(&der);
    assert!(encoded.starts_with(SPKI_PREFIX));
    format!("-----BEGIN PUBLIC KEY-----\n{encoded}\n-----END PUBLIC KEY-----\n")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
        .collect()
}

struct Outcome {
    line: String,
    status: i32,
}

fn run(args: &[&str]) -> Outcome {
    let output = Command::new(VERIFIER).args(args).output().unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    Outcome {
        line: stdout.lines().last().unwrap_or_default().to_owned(),
        status: output.status.code().unwrap(),
    }
}

struct Release {
    scratch: Scratch,
    package: Vec<u8>,
}

impl Release {
    fn new() -> Release {
        let scratch = Scratch::new();
        let package = b"stand-in deb".repeat(1000);
        scratch.file(
            "key.pem",
            pem(&SigningKey::from_bytes(&RELEASE_SEED).verifying_key().to_bytes()),
        );
        scratch.file("Ardia-0.2.48-linux-x64.deb", &package);
        let release = Release { scratch, package };
        release.sign(&release.manifest("0.2.48"), &RELEASE_SEED);
        release
    }

    fn path(&self, name: &str) -> String {
        self.scratch.0.join(name).to_string_lossy().into_owned()
    }

    fn manifest(&self, version: &str) -> String {
        format!(
            "ardia-linux-update 1\nversion {version}\ndeb Ardia-{version}-linux-x64.deb {} {}\n",
            hex(&Sha256::digest(&self.package)),
            self.package.len()
        )
    }

    fn sign(&self, manifest: &str, seed: &[u8; 32]) {
        self.scratch.file("manifest", manifest);
        self.scratch.file(
            "signature",
            SigningKey::from_bytes(seed).sign(manifest.as_bytes()).to_bytes(),
        );
    }

    fn check(&self, command: &str, version: &str, installed: &str, kind: &str) -> Outcome {
        let key = self.path("key.pem");
        let manifest = self.path("manifest");
        let signature = self.path("signature");
        let package = self.path("Ardia-0.2.48-linux-x64.deb");
        let mut args = vec![
            command,
            "--key",
            &key,
            "--manifest",
            &manifest,
            "--signature",
            &signature,
            "--version",
            version,
            "--installed",
            installed,
            "--kind",
            kind,
        ];
        if command == "package" {
            args.extend(["--package", &package]);
        }
        run(&args)
    }

    fn ok_line(&self) -> String {
        format!(
            "ok Ardia-0.2.48-linux-x64.deb {} {}",
            hex(&Sha256::digest(&self.package)),
            self.package.len()
        )
    }
}

fn expect(outcome: Outcome, line: &str, status: i32, label: &str) {
    assert_eq!((outcome.line.as_str(), outcome.status), (line, status), "{label}");
}

#[test]
fn a_signed_newer_manifest_and_its_package_pass() {
    let release = Release::new();
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        &release.ok_line(),
        0,
        "manifest",
    );
    expect(
        release.check("package", "0.2.48", "0.2.47", "deb"),
        &release.ok_line(),
        0,
        "package",
    );
}

#[test]
fn the_signature_version_and_kind_refusals_come_from_the_core() {
    let release = Release::new();
    expect(
        release.check("manifest", "0.2.48", "0.2.48", "deb"),
        "failed notNewer",
        1,
        "replay",
    );
    expect(
        release.check("manifest", "0.2.48", "0.2.49", "deb"),
        "failed notNewer",
        1,
        "downgrade",
    );
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "tarball"),
        "failed kind",
        1,
        "no tarball line",
    );
    expect(
        release.check("manifest", "0.2.49", "0.2.47", "deb"),
        "failed manifest",
        1,
        "another version",
    );
    expect(
        release.check("manifest", "0.2.48-beta.1", "0.2.47", "deb"),
        "failed manifest",
        1,
        "a malformed version",
    );
    expect(
        release.check("manifest", "0.2.48", "0.2.47-beta", "deb"),
        "failed kind",
        1,
        "a malformed install",
    );

    release.sign(&release.manifest("0.2.48"), &OTHER_SEED);
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        "failed signature",
        1,
        "another key",
    );

    let signed = release.manifest("0.2.48");
    release.sign(&signed, &RELEASE_SEED);
    release
        .scratch
        .file("manifest", signed.replace("version 0.2.48", "version 0.2.49"));
    expect(
        release.check("manifest", "0.2.49", "0.2.47", "deb"),
        "failed signature",
        1,
        "a tampered manifest",
    );

    release.sign(&signed.replace('\n', "\r\n"), &RELEASE_SEED);
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        "failed manifest",
        1,
        "CRLF lines",
    );
}

#[test]
fn the_package_must_match_the_signed_size_and_digest() {
    let release = Release::new();
    let mut flipped = release.package.clone();
    *flipped.last_mut().unwrap() ^= 0xff;
    release.scratch.file("Ardia-0.2.48-linux-x64.deb", &flipped);
    expect(
        release.check("package", "0.2.48", "0.2.47", "deb"),
        "failed checksum",
        1,
        "a flipped byte",
    );
    let mut longer = release.package.clone();
    longer.push(b'x');
    release.scratch.file("Ardia-0.2.48-linux-x64.deb", &longer);
    expect(
        release.check("package", "0.2.48", "0.2.47", "deb"),
        "failed checksum",
        1,
        "a longer package",
    );
    release
        .scratch
        .file("Ardia-0.2.48-linux-x64.deb", &release.package[1..]);
    expect(
        release.check("package", "0.2.48", "0.2.47", "deb"),
        "failed checksum",
        1,
        "a shorter package",
    );
    fs::remove_file(release.path("Ardia-0.2.48-linux-x64.deb")).unwrap();
    expect(
        release.check("package", "0.2.48", "0.2.47", "deb"),
        "failed missing",
        1,
        "no package",
    );
}

#[test]
fn oversized_inputs_are_refused_before_they_are_verified() {
    let release = Release::new();
    release.scratch.file("signature", [0u8; 65]);
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        "failed signature",
        1,
        "a 65-byte signature",
    );
    release.scratch.file("signature", [0u8; 63]);
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        "failed signature",
        1,
        "a 63-byte signature",
    );
    let mut big = release.manifest("0.2.48");
    big.push_str(&"x".repeat(4096));
    release.sign(&big, &RELEASE_SEED);
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        "failed manifest",
        1,
        "a 4 KiB+ manifest",
    );
    release.scratch.file("key.pem", "x".repeat(5000));
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        "failed signature",
        1,
        "an oversized key",
    );
}

#[test]
fn a_key_that_is_not_one_ed25519_public_key_verifies_nothing() {
    let release = Release::new();
    let good = fs::read_to_string(release.path("key.pem")).unwrap();
    for (label, key) in [
        ("empty", String::new()),
        ("bare carriage returns", good.replace('\n', "\r")),
        (
            "a lone carriage return at the end",
            format!("{}\r", good.trim_end_matches('\n')),
        ),
        (
            "a CRLF key with a lone carriage return at the end",
            format!("{}\r", good.trim_end_matches('\n').replace('\n', "\r\n")),
        ),
        (
            "a trailing blank CRLF line",
            format!("{}\r\n", good.replace('\n', "\r\n")),
        ),
        ("two keys", format!("{good}{good}")),
        ("a private key header", good.replace("PUBLIC", "PRIVATE")),
        ("another algorithm", good.replace(SPKI_PREFIX, "MCowBQYDK2VxAyEA")),
    ] {
        release.scratch.file("key.pem", key);
        expect(
            release.check("manifest", "0.2.48", "0.2.47", "deb"),
            "failed signature",
            1,
            label,
        );
    }
    fs::remove_file(release.path("key.pem")).unwrap();
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        "failed signature",
        1,
        "no key",
    );
}

#[cfg(unix)]
#[test]
fn links_folders_and_fifos_are_never_read() {
    let release = Release::new();
    fs::rename(release.path("manifest"), release.path("real-manifest")).unwrap();
    std::os::unix::fs::symlink(release.path("real-manifest"), release.path("manifest")).unwrap();
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        "failed missing",
        1,
        "a symlinked manifest",
    );
    fs::remove_file(release.path("manifest")).unwrap();
    fs::create_dir(release.path("manifest")).unwrap();
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        "failed missing",
        1,
        "a folder",
    );
    fs::remove_dir(release.path("manifest")).unwrap();
    fs::rename(release.path("real-manifest"), release.path("manifest")).unwrap();
    fs::rename(release.path("Ardia-0.2.48-linux-x64.deb"), release.path("real.deb")).unwrap();
    std::os::unix::fs::symlink(release.path("real.deb"), release.path("Ardia-0.2.48-linux-x64.deb")).unwrap();
    expect(
        release.check("package", "0.2.48", "0.2.47", "deb"),
        "failed missing",
        1,
        "a symlinked package",
    );
    fs::remove_file(release.path("Ardia-0.2.48-linux-x64.deb")).unwrap();
    let fifo = release.path("Ardia-0.2.48-linux-x64.deb");
    assert!(Command::new("mkfifo").arg(&fifo).status().unwrap().success());
    expect(
        release.check("package", "0.2.48", "0.2.47", "deb"),
        "failed missing",
        1,
        "a FIFO",
    );
    let signature = release.path("signature");
    fs::remove_file(&signature).unwrap();
    assert!(Command::new("mkfifo").arg(&signature).status().unwrap().success());
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        "failed missing",
        1,
        "a FIFO signature",
    );
}

#[test]
fn malformed_command_lines_are_usage_errors() {
    let release = Release::new();
    let key = release.path("key.pem");
    let manifest = release.path("manifest");
    let signature = release.path("signature");
    let base = [
        "--key",
        key.as_str(),
        "--manifest",
        manifest.as_str(),
        "--signature",
        signature.as_str(),
        "--version",
        "0.2.48",
        "--installed",
        "0.2.47",
    ];
    let with = |extra: &[&str]| {
        let mut args = vec!["manifest"];
        args.extend(base);
        args.extend(extra);
        run(&args)
    };
    expect(with(&["--kind", "deb"]), &release.ok_line(), 0, "the full command");
    expect(with(&[]), "failed usage", 2, "no --kind");
    expect(with(&["--kind", "rpm"]), "failed usage", 2, "an unknown kind");
    expect(
        with(&["--kind", "deb", "--kind", "deb"]),
        "failed usage",
        2,
        "a flag twice",
    );
    expect(
        with(&["--kind", "deb", "--package", "/tmp/x"]),
        "failed usage",
        2,
        "--package on manifest",
    );
    expect(
        with(&["--kind", "deb", "--extra", "x"]),
        "failed usage",
        2,
        "an unknown flag",
    );
    expect(with(&["--kind"]), "failed usage", 2, "a flag without a value");
    expect(with(&["--kind=deb"]), "failed usage", 2, "a joined flag");
    let relative = run(&[
        "manifest",
        "--key",
        "key.pem",
        "--manifest",
        &manifest,
        "--signature",
        &signature,
        "--version",
        "0.2.48",
        "--installed",
        "0.2.47",
        "--kind",
        "deb",
    ]);
    expect(relative, "failed usage", 2, "a relative key path");
    let long = format!("/{}", "a".repeat(5000));
    let mut args = vec!["manifest", "--key", long.as_str()];
    args.extend(&base[2..]);
    args.extend(["--kind", "deb"]);
    expect(run(&args), "failed usage", 2, "an overlong path");
    let mut args = vec!["package"];
    args.extend(base);
    args.extend(["--kind", "deb"]);
    expect(run(&args), "failed usage", 2, "package without --package");
    expect(run(&[]), "failed usage", 2, "no command");
    expect(run(&["verify"]), "failed usage", 2, "an unknown command");
    assert_eq!(run(&["--help"]).status, 0);
}

#[test]
fn version_answers_exactly_the_core_version_grammar() {
    for version in ["0.2.47", "0.2.48-nightly.3", "999999999.0.0", "01.02.003"] {
        expect(run(&["version", version]), "ok", 0, version);
    }
    for version in [
        "",
        "0.2",
        "0.2.47.1",
        "0.2.47-beta.1",
        "1000000000.0.0",
        "0.2.47-nightly.",
        " 0.2.47",
        "0.2.47\n",
        "v0.2.47",
    ] {
        expect(run(&["version", version]), "failed version", 1, version);
    }
    expect(run(&["version"]), "failed usage", 2, "no version");
    expect(run(&["version", "0.2.47", "0.2.48"]), "failed usage", 2, "two versions");
}

#[test]
fn every_shared_vector_gets_the_helpers_recorded_answer() {
    let vectors_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/update-vectors.json");
    let vectors: Value = serde_json::from_str(&fs::read_to_string(vectors_path).unwrap()).unwrap();
    let scratch = Scratch::new();
    for case in vectors["manifests"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let key = scratch.file("key.pem", pem(&unhex(case["publicKey"].as_str().unwrap())));
        let manifest = scratch.file("manifest", case["manifest"].as_str().unwrap());
        let signature = scratch.file("signature", unhex(case["signature"].as_str().unwrap()));
        let outcome = run(&[
            "manifest",
            "--key",
            key.to_str().unwrap(),
            "--manifest",
            manifest.to_str().unwrap(),
            "--signature",
            signature.to_str().unwrap(),
            "--version",
            case["version"].as_str().unwrap(),
            "--installed",
            case["installed"].as_str().unwrap(),
            "--kind",
            case["kind"].as_str().unwrap(),
        ]);
        let want = case.get("helper").unwrap_or(&case["outcome"]);
        let line = match want.get("error") {
            Some(error) => format!("failed {}", error.as_str().unwrap()),
            None => format!(
                "ok {} {} {}",
                want["name"].as_str().unwrap(),
                want["sha256"].as_str().unwrap(),
                want["size"]
            ),
        };
        let status = if want.get("error").is_some() { 1 } else { 0 };
        expect(outcome, &line, status, name);
    }
}

#[cfg(unix)]
#[test]
fn a_path_through_a_parent_folder_is_a_usage_error() {
    let release = Release::new();
    let folder = release.scratch.0.file_name().unwrap().to_str().unwrap().to_owned();
    let around = format!("{}/../{folder}/key.pem", release.scratch.0.display());
    let manifest = release.path("manifest");
    let signature = release.path("signature");
    let outcome = run(&[
        "manifest",
        "--key",
        &around,
        "--manifest",
        &manifest,
        "--signature",
        &signature,
        "--version",
        "0.2.48",
        "--installed",
        "0.2.47",
        "--kind",
        "deb",
    ]);
    expect(outcome, "failed usage", 2, "a key path through ..");
}

#[test]
fn native_absolute_paths_are_accepted() {
    let release = Release::new();
    assert!(Path::new(&release.path("key.pem")).is_absolute());
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        &release.ok_line(),
        0,
        "native paths",
    );
}

#[test]
fn a_key_checked_out_with_crlf_line_endings_still_verifies() {
    let release = Release::new();
    let lf = fs::read_to_string(release.path("key.pem")).unwrap();
    release.scratch.file("key.pem", lf.replace('\n', "\r\n"));
    expect(
        release.check("manifest", "0.2.48", "0.2.47", "deb"),
        &release.ok_line(),
        0,
        "a CRLF key",
    );
    expect(
        release.check("package", "0.2.48", "0.2.47", "deb"),
        &release.ok_line(),
        0,
        "a CRLF key, package",
    );
}

#[test]
fn every_windows_shared_vector_gets_its_recorded_answer() {
    let vectors_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/update-vectors.json");
    let vectors: Value = serde_json::from_str(&fs::read_to_string(vectors_path).unwrap()).unwrap();
    let scratch = Scratch::new();
    for case in vectors["windows"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let key = scratch.file("key.pem", pem(&unhex(case["publicKey"].as_str().unwrap())));
        let manifest = scratch.file("manifest.json", case["manifest"].as_str().unwrap());
        let signature = scratch.file("manifest.json.sig", unhex(case["signature"].as_str().unwrap()));
        let build = case["currentBuild"].as_u64().unwrap().to_string();
        let outcome = run(&[
            "windows-manifest",
            "--key",
            key.to_str().unwrap(),
            "--manifest",
            manifest.to_str().unwrap(),
            "--signature",
            signature.to_str().unwrap(),
            "--published-under",
            case["publishedUnder"].as_str().unwrap(),
            "--cpu",
            case["cpu"].as_str().unwrap(),
            "--current-build",
            &build,
        ]);
        let want = case.get("helper").unwrap_or(&case["outcome"]);
        let line = match want.get("error") {
            Some(error) => format!("failed {}", error.as_str().unwrap()),
            None => format!(
                "ok {} {} {} {} {}",
                want["version"].as_str().unwrap(),
                want["build"],
                want["url"].as_str().unwrap(),
                want["sha256"].as_str().unwrap(),
                want["bytes"]
            ),
        };
        let status = if want.get("error").is_some() { 1 } else { 0 };
        expect(outcome, &line, status, name);
    }
}

#[test]
fn windows_package_verifies_installer_checksum_and_refuses_tampering_or_bad_usage() {
    let scratch = Scratch::new();
    let installer = b"windows installer bytes".repeat(256);
    let sha = hex(&Sha256::digest(&installer));
    let prefix = "https://github.com/ardia-browser/ardia/releases/download/";
    let url = format!("{prefix}windows-alpha/Ardia-Setup-x64-60.exe");
    let manifest_text = format!(
        "{{\"version\":\"0.2.48\",\"build\":60,\"x64\":{{\"url\":\"{url}\",\"sha256\":\"{sha}\",\"bytes\":{}}}}}\n",
        installer.len()
    );
    let key = scratch.file(
        "key.pem",
        pem(&SigningKey::from_bytes(&RELEASE_SEED).verifying_key().to_bytes()),
    );
    let manifest = scratch.file("windows-update.json", &manifest_text);
    let signature = scratch.file(
        "windows-update.json.sig",
        SigningKey::from_bytes(&RELEASE_SEED)
            .sign(manifest_text.as_bytes())
            .to_bytes(),
    );
    let package = scratch.file("Ardia-Setup-x64-60.exe", &installer);
    let ok_line = format!("ok 0.2.48 60 {url} {sha} {}", installer.len());
    expect(
        run(&[
            "windows-package",
            "--key",
            key.to_str().unwrap(),
            "--manifest",
            manifest.to_str().unwrap(),
            "--signature",
            signature.to_str().unwrap(),
            "--published-under",
            prefix,
            "--cpu",
            "x64",
            "--current-build",
            "59",
            "--package",
            package.to_str().unwrap(),
        ]),
        &ok_line,
        0,
        "valid windows package",
    );
    let mut tampered = installer.clone();
    tampered[0] ^= 0xff;
    scratch.file("Ardia-Setup-x64-60.exe", &tampered);
    expect(
        run(&[
            "windows-package",
            "--key",
            key.to_str().unwrap(),
            "--manifest",
            manifest.to_str().unwrap(),
            "--signature",
            signature.to_str().unwrap(),
            "--published-under",
            prefix,
            "--cpu",
            "x64",
            "--current-build",
            "59",
            "--package",
            package.to_str().unwrap(),
        ]),
        "failed checksum",
        1,
        "tampered windows package",
    );
    expect(
        run(&[
            "windows-manifest",
            "--key",
            key.to_str().unwrap(),
            "--manifest",
            manifest.to_str().unwrap(),
            "--signature",
            signature.to_str().unwrap(),
            "--published-under",
            prefix,
            "--cpu",
            "x86",
            "--current-build",
            "59",
        ]),
        "failed usage",
        2,
        "bad cpu",
    );
    expect(
        run(&[
            "windows-manifest",
            "--key",
            key.to_str().unwrap(),
            "--manifest",
            manifest.to_str().unwrap(),
            "--signature",
            signature.to_str().unwrap(),
            "--published-under",
            prefix,
            "--cpu",
            "x64",
            "--current-build",
            "01",
        ]),
        "failed usage",
        2,
        "leading zero build arg",
    );
}
