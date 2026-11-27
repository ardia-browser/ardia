use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

fn include(name: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../include").join(name))
        .unwrap()
        .replace("\r\n", "\n")
}

fn identifiers(header: &str) -> BTreeSet<String> {
    header
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|word| word.starts_with("ardia_") || word.starts_with("ARDIA_"))
        .map(str::to_owned)
        .collect()
}

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
    let path = root.join("../../include/ardia_import.h");
    if std::env::var_os("ARDIA_WRITE_HEADER").is_some() {
        fs::write(&path, &generated).unwrap();
    }
    assert_eq!(
        include("ardia_import.h"),
        generated,
        "include/ardia_import.h is stale: run ARDIA_WRITE_HEADER=1 cargo test -p ardia-import-ffi --test header"
    );
    assert!(
        !generated.contains("//") && !generated.contains("/*"),
        "the header must not carry comments"
    );
    for name in [
        "ardia_import_chromium_bookmarks",
        "ardia_import_netscape_bookmarks",
        "ardia_import_buf_free",
        "ardia_import_abi_version",
        "ARDIA_IMPORT_STATUS_OK",
        "ARDIA_IMPORT_MAX_INPUT_BYTES",
    ] {
        assert!(generated.contains(name), "{name}");
    }
}

#[test]
fn every_import_name_is_prefixed_and_none_clashes_with_the_other_headers() {
    let import = identifiers(&include("ardia_import.h"));
    let unprefixed: Vec<_> = import
        .iter()
        .filter(|name| !name.starts_with("ardia_import_") && !name.starts_with("ARDIA_IMPORT_"))
        .collect();
    assert!(unprefixed.is_empty(), "{unprefixed:?}");
    for other in ["ardia_core.h", "ardia_update.h"] {
        let names = identifiers(&include(other));
        let shared: Vec<_> = import.intersection(&names).collect();
        assert!(shared.is_empty(), "ardia_import.h and {other} both define {shared:?}");
    }
}

#[test]
fn the_header_cap_is_the_parser_cap() {
    assert_eq!(
        ardia_import::ARDIA_IMPORT_MAX_INPUT_BYTES,
        ardia_import_core::MAX_INPUT_BYTES
    );
}
