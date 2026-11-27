use std::fs;
use std::path::Path;

use ardia_crypto::{BoringSsl, Crypto};
use ardia_update_core::{
    installer_in_windows_manifest, package_in_linux_manifest, verify_linux_update, verify_windows_update, Package,
    PackageKind, UpdateError, WindowsCpu, WindowsUpdate,
};
use serde_json::Value;

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn same(result: Result<Package, UpdateError>, want: &Value, name: &str) {
    match want["error"].as_str() {
        Some(code) => assert_eq!(result.map(|_| ()).map_err(UpdateError::code), Err(code), "{name}"),
        None => {
            let package = result.unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(package.size, want["size"].as_u64().unwrap(), "{name}");
            if let Some(sha256) = want["sha256"].as_str() {
                assert_eq!(to_hex(&package.sha256), sha256, "{name}");
            }
        }
    }
}

#[test]
fn every_manifest_vector_gives_its_outcome_through_boringssl() {
    assert_eq!(
        core::any::type_name::<ardia_crypto::Backend>(),
        core::any::type_name::<BoringSsl>()
    );
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../update-vectors.json");
    let vectors: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let cases = vectors["manifests"].as_array().unwrap();
    assert!(cases.len() >= 50);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let manifest = case["manifest"].as_str().unwrap().as_bytes();
        let signature = hex(case["signature"].as_str().unwrap());
        let key: [u8; 32] = hex(case["publicKey"].as_str().unwrap()).try_into().unwrap();
        let version = case["version"].as_str().unwrap();
        let kind = PackageKind::from_name(case["kind"].as_str().unwrap()).unwrap();
        let verified = <[u8; 64]>::try_from(signature.as_slice())
            .is_ok_and(|signature| BoringSsl::ed25519_verify(&key, manifest, &signature));
        assert_eq!(verified, case["signatureValid"].as_bool().unwrap(), "{name}");
        same(
            verify_linux_update::<BoringSsl>(
                &key,
                manifest,
                &signature,
                version,
                case["installed"].as_str().unwrap(),
                kind,
            ),
            &case["outcome"],
            name,
        );
        same(package_in_linux_manifest(manifest, version, kind), &case["parse"], name);
    }
}

fn same_windows(result: Result<WindowsUpdate<'_>, UpdateError>, want: &Value, name: &str) {
    match want["error"].as_str() {
        Some(code) => assert_eq!(result.map(|_| ()).map_err(UpdateError::code), Err(code), "{name}"),
        None => {
            let update = result.unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(update.version, want["version"].as_str().unwrap(), "{name}");
            assert_eq!(update.build, want["build"].as_u64().unwrap(), "{name}");
            assert_eq!(update.installer.url, want["url"].as_str().unwrap(), "{name}");
            assert_eq!(to_hex(&update.installer.sha256), want["sha256"].as_str().unwrap(), "{name}");
            assert_eq!(update.installer.bytes, want["bytes"].as_u64().unwrap(), "{name}");
        }
    }
}

#[test]
fn every_windows_manifest_vector_gives_its_outcome_through_boringssl() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../update-vectors.json");
    let vectors: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let cases = vectors["windows"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let manifest = case["manifest"].as_str().unwrap().as_bytes();
        let signature = hex(case["signature"].as_str().unwrap());
        let key: [u8; 32] = hex(case["publicKey"].as_str().unwrap()).try_into().unwrap();
        let published_under = case["publishedUnder"].as_str().unwrap();
        let cpu = WindowsCpu::from_name(case["cpu"].as_str().unwrap()).unwrap();
        let current_build = case["currentBuild"].as_u64().unwrap();
        let verified = <[u8; 64]>::try_from(signature.as_slice())
            .is_ok_and(|signature| BoringSsl::ed25519_verify(&key, manifest, &signature));
        assert_eq!(verified, case["signatureValid"].as_bool().unwrap(), "{name}");
        same_windows(
            verify_windows_update::<BoringSsl>(&key, manifest, &signature, published_under, cpu, current_build),
            &case["outcome"],
            name,
        );
        same_windows(
            installer_in_windows_manifest(manifest, published_under, cpu),
            &case["parse"],
            name,
        );
    }
}
