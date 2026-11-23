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
    let path = root.join("../../include/ardia_core.h");
    if std::env::var_os("ARDIA_WRITE_HEADER").is_some() {
        fs::write(&path, &generated).unwrap();
    }
    let committed = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
    assert_eq!(
        committed, generated,
        "include/ardia_core.h is stale: run ARDIA_WRITE_HEADER=1 cargo test -p ardia-ffi --test header"
    );
    assert!(
        !generated.contains("//") && !generated.contains("/*"),
        "the header must not carry comments"
    );
    for name in [
        "ardia_buf_free",
        "ardia_sync_open",
        "ardia_phrase_to_entropy",
        "ARDIA_STATUS_OK",
        "ARDIA_MAX_PAYLOAD_BYTES",
    ] {
        assert!(generated.contains(name), "{name}");
    }
}
