#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/build-gpui-macos.sh")
}

fn target_dir() -> PathBuf {
    let binary = Path::new(env!("CARGO_BIN_EXE_ardia"));
    binary
        .parent()
        .and_then(Path::parent)
        .expect("the binary sits in <target>/<profile>")
        .to_path_buf()
}

fn run(args: &[&str], cwd: &Path) -> Output {
    Command::new("bash")
        .arg(script())
        .args(args)
        .current_dir(cwd)
        .env("CARGO_TARGET_DIR", target_dir())
        .env_remove("ARDIACORE_FRAMEWORK")
        .output()
        .expect("bash runs the script")
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn fake_framework(root: &Path) -> PathBuf {
    let framework = root.join("fake").join("Chromium Framework.framework");
    std::fs::create_dir_all(&framework).unwrap();
    let binary = framework.join("Chromium Framework");
    std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&binary, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    framework
}

fn leftovers(out: &Path) -> Vec<String> {
    std::fs::read_dir(out)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with(".ardia-app"))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn two_builds_into_one_folder_both_finish_with_a_signed_app() {
    let scratch = tempfile::tempdir().unwrap();
    let out = scratch.path().join("shared");
    let target = out.to_str().unwrap().to_owned();
    let builds: Vec<_> = (0..2)
        .map(|_| {
            let target = target.clone();
            let cwd = scratch.path().to_path_buf();
            std::thread::spawn(move || {
                run(&["--skip-build", "--no-framework", "--out", &target], &cwd)
            })
        })
        .collect();
    for build in builds {
        let output = build.join().unwrap();
        assert!(output.status.success(), "{}", text(&output));
    }
    let app = out.join("Ardia.app");
    assert!(app.join("Contents/MacOS/ardia").is_file());
    assert!(
        !app.join("Ardia.app").exists(),
        "one build never lands inside the other"
    );
    let verified = Command::new("codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(&app)
        .output()
        .unwrap();
    assert!(verified.status.success(), "{}", text(&verified));
    assert!(leftovers(&out).is_empty(), "{:?}", leftovers(&out));
}

#[test]
fn help_lists_every_option() {
    let scratch = tempfile::tempdir().unwrap();
    let output = run(&["--help"], scratch.path());
    assert!(output.status.success(), "{}", text(&output));
    let help = text(&output);
    for option in [
        "--release",
        "--out",
        "--framework",
        "--link-framework",
        "--no-framework",
        "--skip-build",
        "--dry-run",
        "--help",
        "ARDIA_BACKGROUND=1",
    ] {
        assert!(help.contains(option), "the help leaves out {option}");
    }
    let wrong = run(&["--bogus"], scratch.path());
    assert_eq!(wrong.status.code(), Some(1));
    assert!(text(&wrong).contains("unknown option --bogus"));
}

#[test]
fn a_dry_run_changes_nothing() {
    let scratch = tempfile::tempdir().unwrap();
    let out = scratch.path().join("out");
    let output = run(
        &[
            "--dry-run",
            "--skip-build",
            "--no-framework",
            "--out",
            out.to_str().unwrap(),
        ],
        scratch.path(),
    );
    assert!(output.status.success(), "{}", text(&output));
    assert!(text(&output).contains("+ codesign --force --deep --sign -"));
    assert!(!out.exists(), "a dry run creates nothing");
}

#[test]
fn a_linked_framework_given_by_a_relative_path_still_resolves() {
    let scratch = tempfile::tempdir().unwrap();
    fake_framework(scratch.path());
    let output = run(
        &[
            "--dry-run",
            "--skip-build",
            "--link-framework",
            "--framework",
            "fake/Chromium Framework.framework",
            "--out",
            "out",
        ],
        scratch.path(),
    );
    assert!(output.status.success(), "{}", text(&output));
    let printed = text(&output);
    let link = printed
        .lines()
        .find(|line| line.starts_with("+ ln -s "))
        .unwrap_or_else(|| panic!("no link step in {printed}"));
    assert!(
        link.starts_with("+ ln -s /"),
        "the link points at an absolute path: {link}"
    );
    assert!(
        link.contains(r"fake/Chromium\ Framework.framework "),
        "{link}"
    );
}

#[test]
fn packaging_without_chromium_makes_a_signed_app() {
    let scratch = tempfile::tempdir().unwrap();
    let out = scratch.path().join("bundle");
    let output = run(
        &[
            "--skip-build",
            "--no-framework",
            "--out",
            out.to_str().unwrap(),
        ],
        scratch.path(),
    );
    assert!(output.status.success(), "{}", text(&output));
    let app = out.join("Ardia.app");
    let contents = app.join("Contents");
    assert!(contents.join("MacOS/ardia").is_file());
    assert_eq!(
        std::fs::read(contents.join("PkgInfo")).unwrap(),
        b"APPL????"
    );
    let plist = std::fs::read_to_string(contents.join("Info.plist")).unwrap();
    assert!(plist.contains("<string>dev.ardia.browser</string>"));
    assert!(!plist.contains("@VERSION@") && !plist.contains("@BUILD@"));
    assert!(
        leftovers(&out).is_empty(),
        "staging folders and locks are gone: {:?}",
        leftovers(&out)
    );
    let verified = Command::new("codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(&app)
        .output()
        .unwrap();
    assert!(verified.status.success(), "{}", text(&verified));
    let entitlements = Command::new("codesign")
        .args(["-d", "--entitlements", "-", "--xml"])
        .arg(&app)
        .output()
        .unwrap();
    assert!(text(&entitlements).contains("com.apple.security.cs.allow-jit"));
}
