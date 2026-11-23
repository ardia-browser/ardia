use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const NOT_BUILT_BY_GN: [&str; 13] = [
    "crates/ardia-crypto/src/rustcrypto.rs",
    "crates/ardia-sync-vectors/src/lib.rs",
    "crates/ardia-update-core/src/error.rs",
    "crates/ardia-update-core/src/lib.rs",
    "crates/ardia-update-core/src/manifest.rs",
    "crates/ardia-update-core/src/version.rs",
    "crates/ardia-update-ffi/src/lib.rs",
    "crates/ardia-import-core/src/bookmark.rs",
    "crates/ardia-import-core/src/chromium_bookmarks.rs",
    "crates/ardia-import-core/src/error.rs",
    "crates/ardia-import-core/src/json.rs",
    "crates/ardia-import-core/src/lib.rs",
    "crates/ardia-import-ffi/src/lib.rs",
];

fn core_rs() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn gn_local_paths() -> BTreeSet<String> {
    let text = fs::read_to_string(core_rs().join("BUILD.gn")).unwrap();
    text.split('"')
        .skip(1)
        .step_by(2)
        .filter(|value| {
            !value.starts_with("//")
                && !value.starts_with(':')
                && !value.contains('$')
                && value.contains('/')
                && value.contains('.')
        })
        .map(str::to_owned)
        .collect()
}

fn crate_sources() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for krate in fs::read_dir(core_rs().join("crates")).unwrap() {
        let krate = krate.unwrap().path();
        let src = krate.join("src");
        for file in fs::read_dir(&src).unwrap() {
            let file = file.unwrap().path();
            if file.extension().is_some_and(|extension| extension == "rs") {
                let relative = file
                    .strip_prefix(core_rs())
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if !NOT_BUILT_BY_GN.contains(&relative.as_str()) {
                    out.insert(relative);
                }
            }
        }
    }
    out
}

#[test]
fn the_gn_target_lists_every_crate_source() {
    let listed = gn_local_paths();
    for path in &listed {
        assert!(
            core_rs().join(path).is_file(),
            "BUILD.gn names {path}, which is not there"
        );
    }
    let rust: BTreeSet<String> = listed
        .iter()
        .filter(|path| path.ends_with(".rs") && path.contains("/src/"))
        .cloned()
        .collect();
    assert_eq!(rust, crate_sources(), "BUILD.gn and the crates' src folders disagree");
}

#[test]
fn the_linux_engine_copies_exactly_what_the_gn_target_reads() {
    let copies = fs::read_to_string(core_rs().join("../../engine/ardiacore-linux/copies.tsv")).unwrap();
    let mut copied = BTreeSet::new();
    for line in copies.lines() {
        let Some((source, target)) = line.split_once('\t') else {
            continue;
        };
        let Some(relative) = source.strip_prefix("packages/core-rs/") else {
            continue;
        };
        assert_eq!(target, format!("ardia/core_rs/{relative}"), "{line}");
        assert!(copied.insert(relative.to_owned()), "copied twice: {relative}");
    }
    let mut expected = gn_local_paths();
    expected.insert("BUILD.gn".to_owned());
    assert_eq!(
        copied, expected,
        "engine/ardiacore-linux/copies.tsv and BUILD.gn disagree"
    );
}
