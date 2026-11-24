use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;

const OPENING: &str = "static let source = #\"\"\"\n";
const CLOSING: &str = "\n\"\"\"#";

fn fail(message: String) -> ! {
    eprintln!("error: the plugin host prelude couldn't be extracted: {message}");
    process::exit(1);
}

fn swift_source() -> PathBuf {
    if let Ok(path) = env::var("ARDIA_HOST_PRELUDE_SWIFT") {
        return PathBuf::from(path);
    }
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    manifest.join("../../../shell/plugin-host/HostPrelude.swift")
}

fn extract(swift: &str) -> Result<String, String> {
    let starts: Vec<usize> = swift.match_indices(OPENING).map(|(at, _)| at).collect();
    if starts.len() != 1 {
        return Err(format!("expected one `static let source = #\"\"\"` literal, found {}", starts.len()));
    }
    let body_start = starts[0] + OPENING.len();
    let rest = &swift[body_start..];
    let body_len = rest.find(CLOSING).ok_or("the raw string literal has no closing `\"\"\"#` at column 0")?;
    let body = &rest[..body_len];
    if body.contains("\\#") {
        return Err("the literal uses a `\\#` escape or interpolation, which this extractor doesn't evaluate".into());
    }
    if !body.starts_with("(function (native) {") {
        return Err("the prelude no longer starts with `(function (native) {`".into());
    }
    if !body.trim_end().ends_with("})") {
        return Err("the prelude no longer ends with `})`".into());
    }
    Ok(body.to_string())
}

fn hooks(prelude: &str) -> Result<BTreeSet<String>, String> {
    let bytes = prelude.as_bytes();
    let mut found = BTreeSet::new();
    for (at, _) in prelude.match_indices("native.") {
        if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_' || bytes[at - 1] == b'$' || bytes[at - 1] == b'.') {
            continue;
        }
        let name: String = prelude[at + "native.".len()..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$').collect();
        if name.is_empty() {
            return Err(format!("`native.` at byte {at} isn't followed by a hook name"));
        }
        found.insert(name);
    }
    if found.is_empty() {
        return Err("the prelude calls no native hooks".into());
    }
    if prelude.contains("native[") {
        return Err("the prelude reaches a native hook by computed name, which this check can't see".into());
    }
    Ok(found)
}

fn main() {
    let source = swift_source();
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-env-changed=ARDIA_HOST_PRELUDE_SWIFT");
    let swift = fs::read_to_string(&source).unwrap_or_else(|error| fail(format!("{} can't be read: {error}", source.display())));
    let prelude = extract(&swift).unwrap_or_else(|problem| fail(format!("{}: {problem}", source.display())));
    let names = hooks(&prelude).unwrap_or_else(|problem| fail(format!("{}: {problem}", source.display())));
    let listed: Vec<String> = names.iter().map(|name| format!("{name:?}")).collect();
    let generated = format!("pub const PRELUDE_HOOKS: [&str; {}] = [{}];\n", names.len(), listed.join(", "));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    for (name, text) in [("prelude.js", prelude.as_str()), ("prelude_hooks.rs", generated.as_str())] {
        let out = out_dir.join(name);
        fs::write(&out, text).unwrap_or_else(|error| fail(format!("{} can't be written: {error}", out.display())));
    }
}
