use std::fs;
use std::path::Path;

#[test]
fn the_committed_header_is_current_and_has_no_comments() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let config = cbindgen::Config::from_file(root.join("../../cbindgen.toml")).unwrap();
    let mut generated = Vec::new();
    cbindgen::Builder::new()
        .with_config(config)
        .with_src(root.join("src/lib.rs"))
        .generate()
        .unwrap()
        .write(&mut generated);
    let generated: String = String::from_utf8(generated)
        .unwrap()
        .lines()
        .map(|line| match line.find("//") {
            Some(at) => line[..at].trim_end().to_owned() + "\n",
            None => line.to_owned() + "\n",
        })
        .collect();
    let path = root.join("../../include/ardia_update.h");
    if std::env::var_os("ARDIA_WRITE_HEADER").is_some() {
        fs::write(&path, &generated).unwrap();
    }
    let committed = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
    assert_eq!(
        committed, generated,
        "include/ardia_update.h is stale: run ARDIA_WRITE_HEADER=1 cargo test -p ardia-update-ffi --test header"
    );
    assert!(
        !generated.contains("//") && !generated.contains("/*"),
        "the header must not carry comments"
    );
    for name in [
        "ardia_update_verify_linux",
        "ardia_update_verify_windows",
        "ardia_update_compare_versions",
        "ardia_update_check_offer",
        "ARDIA_UPDATE_STATUS_NOT_NEWER",
        "ARDIA_UPDATE_KIND_APPIMAGE",
        "ARDIA_UPDATE_WINDOWS_CPU_ARM64",
        "ardia_update_package",
        "ardia_update_windows_package",
    ] {
        assert!(generated.contains(name), "{name}");
    }
    let core = fs::read_to_string(root.join("../../include/ardia_core.h")).unwrap();
    for line in generated.lines().filter(|line| line.contains("ardia_")) {
        for word in line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
            if word.starts_with("ardia_") || word.starts_with("ARDIA_") {
                assert!(
                    word.starts_with("ardia_update") || word.starts_with("ARDIA_UPDATE"),
                    "{word} could clash with ardia_core.h"
                );
                assert!(!core.contains(word), "{word} is also in ardia_core.h");
            }
        }
    }
}
