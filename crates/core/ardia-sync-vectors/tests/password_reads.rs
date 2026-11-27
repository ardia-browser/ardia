mod support;

use std::path::Path;

use ardia_sync_core::{foundation_base64, Error, SyncKeys};
use base64::Engine;
use serde_json::{json, Value};
use support::*;

#[test]
fn base64_reads_decode_exactly_like_foundation() {
    let table = json(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/foundation-base64.json"));
    let cases = table["cases"].as_array().unwrap();
    assert!(cases.len() > 8000);
    for case in cases {
        let input = case[0].as_str().unwrap();
        let decoded = foundation_base64::decode(input).map(|bytes| hex_string(&bytes));
        assert_eq!(decoded.as_deref(), case[1].as_str(), "{input:?}");
    }
}

#[test]
fn password_reads_match_swift_and_writes_stay_canonical() {
    let table = json(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/password-read-cases.json"));
    let inputs = json(&vectors().join("inputs.json"));
    let keys = SyncKeys::new(&hex(inputs["entropies"][str(&table, "entropy")].as_str().unwrap()));
    let cases = table["cases"].as_array().unwrap();
    assert!(cases.len() >= 14);
    for case in cases {
        let name = str(case, "name");
        let (origin, username) = (str(case, "origin"), str(case, "username"));
        let got = match keys.open_password(str(case, "sealed"), origin, username) {
            Ok(password) => json!({ "password": password.as_str() }),
            Err(Error::Format) => json!({ "error": "format" }),
            Err(Error::Authentication) => json!({ "error": "authentication" }),
            Err(Error::Random) => json!({ "error": "random" }),
        };
        assert_eq!(got, case["outcomes"]["swift"], "{name}");
        let sealed = keys.seal_password(str(case, "password"), origin, username).unwrap();
        assert!(
            base64::engine::general_purpose::STANDARD.decode(&sealed).is_ok(),
            "{name}"
        );
        if name.contains("byte order mark") {
            assert_eq!(sealed, str(case, "sealed"), "{name}");
        }
    }
    let differs = |platform: &str| {
        cases
            .iter()
            .filter(|case| case["outcomes"][platform] != case["outcomes"]["swift"])
            .count()
    };
    assert!(differs("linux") == 0 && differs("kotlin") >= 5);
    let _: &Value = &table["sources"];
}
