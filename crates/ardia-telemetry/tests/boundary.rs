use std::path::Path;
use std::process::Command;

use ardia_telemetry::perf;
use ardia_telemetry::sanitize::{clean_properties, valid_key};
use serde_json::{Map, Value};

fn corpus() -> Vec<String> {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/security/hostile-inputs.mjs");
    let script =
        std::fs::canonicalize(&script).expect("the shared hostile corpus is in the repository");
    let program = "const { pathToFileURL } = await import('node:url'); \
        const corpus = await import(pathToFileURL(process.argv[1]).href); \
        process.stdout.write(JSON.stringify(corpus.HOSTILE_STRINGS.map((entry) => [...Buffer.from(String(entry.value), 'utf8')])));";
    let output = Command::new("node")
        .args(["--input-type=module", "-e", program])
        .arg(&script)
        .output()
        .expect("node reads the shared hostile corpus");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let bytes: Vec<Vec<u8>> = serde_json::from_slice(&output.stdout).expect("json");
    let values: Vec<String> = bytes
        .into_iter()
        .map(|value| String::from_utf8_lossy(&value).into_owned())
        .collect();
    assert!(
        values.len() > 20,
        "the corpus came back with {} values",
        values.len()
    );
    values
}

#[test]
fn hostile_keys_never_reach_the_payload_and_hostile_values_come_out_scrubbed() {
    for value in corpus() {
        let mut props = Map::new();
        props.insert(value.clone(), Value::from(1));
        props.insert("field".into(), Value::String(value.clone()));
        let cleaned = clean_properties(&props);
        for key in cleaned.keys() {
            assert!(valid_key(key), "key {key:?} got through");
            assert!(key == "field" || key == &value);
        }
        let scrubbed = cleaned.get("field").and_then(Value::as_str).unwrap_or("");
        assert!(scrubbed.chars().count() <= 64, "{scrubbed:?}");
        assert!(
            !scrubbed.contains(['\n', '\r', '\0', '\u{2028}', '\u{2029}']),
            "{scrubbed:?}"
        );
        for scheme in ["javascript:", "file:", "data:", "chrome:", "://"] {
            assert!(
                !scrubbed.to_ascii_lowercase().contains(scheme),
                "{value:?} -> {scrubbed:?}"
            );
        }
        assert!(!scrubbed.contains("../"), "{value:?} -> {scrubbed:?}");
        assert!(
            !perf::valid_metric(&value)
                || value
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        );
    }
}

#[test]
fn prototype_and_odd_keys_are_dropped() {
    for key in [
        "__proto__",
        "constructor",
        "prototype",
        "a b",
        "a.b",
        "",
        "$",
        "1abc",
        "a-b",
    ] {
        let props = Map::from_iter([(key.to_owned(), Value::from(1))]);
        let cleaned = clean_properties(&props);
        assert!(
            cleaned.is_empty() || valid_key(key),
            "{key:?} survived as {cleaned:?}"
        );
    }
    assert!(!valid_key("__proto__"));
    assert!(!valid_key("a b") && !valid_key("") && !valid_key("1abc"));
}

#[test]
fn the_control_socket_and_plugins_have_no_telemetry_entry_point() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ardia-app/src");
    for relative in [
        "control_protocol.rs",
        "ipc.rs",
        "plugins/service.rs",
        "plugins/mod.rs",
    ] {
        let Ok(source) = std::fs::read_to_string(root.join(relative)) else {
            continue;
        };
        for forbidden in [
            "ardia_telemetry::capture",
            ".capture(",
            "counts::add(",
            "perf::sample",
            "perf::submit_histogram",
        ] {
            assert!(
                !source.contains(forbidden),
                "{relative} reaches telemetry through {forbidden}"
            );
        }
    }
}
