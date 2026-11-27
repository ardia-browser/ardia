use std::fs;
use std::path::Path;
use std::ptr;

use ardia_update::*;
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

fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/update-vectors.json");
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn status_code(status: ardia_update_status) -> &'static str {
    match status {
        ardia_update_status::Ok => "ok",
        ardia_update_status::InvalidArgument => "argument",
        ardia_update_status::TooLarge => "tooLarge",
        ardia_update_status::Manifest => "manifest",
        ardia_update_status::Signature => "signature",
        ardia_update_status::NotNewer => "notNewer",
        ardia_update_status::Kind => "kind",
        ardia_update_status::Version => "version",
        ardia_update_status::Channel => "channel",
    }
}

fn kind(name: &str) -> u32 {
    match name {
        "deb" => ARDIA_UPDATE_KIND_DEB,
        "tarball" => ARDIA_UPDATE_KIND_TARBALL,
        "appimage" => ARDIA_UPDATE_KIND_APPIMAGE,
        _ => panic!("{name}"),
    }
}

fn channel(name: &str) -> u32 {
    match name {
        "stable" => ARDIA_UPDATE_CHANNEL_STABLE,
        "nightly" => ARDIA_UPDATE_CHANNEL_NIGHTLY,
        _ => panic!("{name}"),
    }
}

fn empty() -> ardia_update_package {
    ardia_update_package {
        size: 0,
        sha256: [0; ARDIA_UPDATE_SHA256_BYTES],
    }
}

fn verify(
    manifest: &[u8],
    signature: &[u8],
    key: &[u8],
    version: &str,
    installed: &str,
    kind: u32,
) -> (ardia_update_status, ardia_update_package) {
    let mut out = ardia_update_package {
        size: 7,
        sha256: [7; ARDIA_UPDATE_SHA256_BYTES],
    };
    let status = unsafe {
        ardia_update_verify_linux(
            manifest.as_ptr(),
            manifest.len(),
            signature.as_ptr(),
            signature.len(),
            key.as_ptr(),
            key.len(),
            version.as_ptr(),
            version.len(),
            installed.as_ptr(),
            installed.len(),
            kind,
            &mut out,
        )
    };
    (status, out)
}

fn compare(left: &str, right: &str) -> (ardia_update_status, i32) {
    let mut order = 9;
    let status =
        unsafe { ardia_update_compare_versions(left.as_ptr(), left.len(), right.as_ptr(), right.len(), &mut order) };
    (status, order)
}

#[test]
fn every_manifest_vector_gives_its_outcome_through_the_c_abi() {
    let vectors = vectors();
    let cases = vectors["manifests"].as_array().unwrap();
    assert!(cases.len() >= 50);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let (status, package) = verify(
            case["manifest"].as_str().unwrap().as_bytes(),
            &hex(case["signature"].as_str().unwrap()),
            &hex(case["publicKey"].as_str().unwrap()),
            case["version"].as_str().unwrap(),
            case["installed"].as_str().unwrap(),
            kind(case["kind"].as_str().unwrap()),
        );
        let outcome = &case["outcome"];
        match outcome["error"].as_str() {
            Some(code) => {
                assert_eq!(status_code(status), code, "{name}");
                assert_eq!(package, empty(), "{name}: a refusal zeroes the output");
            }
            None => {
                assert_eq!(status, ardia_update_status::Ok, "{name}");
                assert_eq!(package.size, outcome["size"].as_u64().unwrap(), "{name}");
                assert_eq!(to_hex(&package.sha256), outcome["sha256"].as_str().unwrap(), "{name}");
            }
        }
    }
}

#[test]
fn version_vectors_order_and_classify_through_the_c_abi() {
    let vectors = vectors();
    let versions = &vectors["versions"];
    for entry in versions["valid"].as_array().unwrap() {
        let version = entry["version"].as_str().unwrap();
        let mut out = 9;
        assert_eq!(
            unsafe { ardia_update_channel_of(version.as_ptr(), version.len(), &mut out) },
            ardia_update_status::Ok
        );
        assert_eq!(out, channel(entry["channel"].as_str().unwrap()), "{version}");
        assert_eq!(compare(version, version), (ardia_update_status::Ok, 0));
    }
    for entry in versions["invalid"].as_array().unwrap() {
        let version = entry["version"].as_str().unwrap();
        let mut out = 9;
        assert_eq!(
            unsafe { ardia_update_channel_of(version.as_ptr(), version.len(), &mut out) },
            ardia_update_status::Version,
            "{version:?}"
        );
        assert_eq!(out, ARDIA_UPDATE_CHANNEL_STABLE);
        assert_eq!(
            compare(version, "0.2.48"),
            (ardia_update_status::Version, 0),
            "{version:?}"
        );
        assert_eq!(
            compare("0.2.48", version),
            (ardia_update_status::Version, 0),
            "{version:?}"
        );
    }
    let ascending: Vec<&str> = versions["ascending"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    for (index, left) in ascending.iter().enumerate() {
        for right in &ascending[index + 1..] {
            assert_eq!(compare(left, right), (ardia_update_status::Ok, -1), "{left} < {right}");
            assert_eq!(compare(right, left), (ardia_update_status::Ok, 1), "{right} > {left}");
        }
    }
    for pair in versions["equal"].as_array().unwrap() {
        let (left, right) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        assert_eq!(compare(left, right), (ardia_update_status::Ok, 0), "{left} = {right}");
    }
}

#[test]
fn offer_vectors_follow_channel_and_refuse_downgrades_through_the_c_abi() {
    let vectors = vectors();
    for offer in vectors["offers"].as_array().unwrap() {
        let candidate = offer["candidate"].as_str().unwrap();
        let installed = offer["installed"].as_str().unwrap();
        let status = unsafe {
            ardia_update_check_offer(
                candidate.as_ptr(),
                candidate.len(),
                installed.as_ptr(),
                installed.len(),
                channel(offer["channel"].as_str().unwrap()),
            )
        };
        assert_eq!(status_code(status), offer["outcome"].as_str().unwrap(), "{offer}");
    }
}

#[test]
fn arguments_are_checked_by_null_length_and_range_only() {
    let vectors = vectors();
    let valid = &vectors["manifests"][0];
    let manifest = valid["manifest"].as_str().unwrap().as_bytes();
    let signature = hex(valid["signature"].as_str().unwrap());
    let key = hex(valid["publicKey"].as_str().unwrap());
    let call = |manifest: (*const u8, usize),
                signature: (*const u8, usize),
                key: (*const u8, usize),
                version: (*const u8, usize),
                kind: u32,
                out: *mut ardia_update_package| unsafe {
        ardia_update_verify_linux(
            manifest.0,
            manifest.1,
            signature.0,
            signature.1,
            key.0,
            key.1,
            version.0,
            version.1,
            b"0.2.47".as_ptr(),
            6,
            kind,
            out,
        )
    };
    let m = (manifest.as_ptr(), manifest.len());
    let s = (signature.as_ptr(), signature.len());
    let k = (key.as_ptr(), key.len());
    let v = (b"0.2.48".as_ptr(), 6);
    let mut out = empty();
    assert_eq!(
        call(m, s, k, v, ARDIA_UPDATE_KIND_DEB, &mut out),
        ardia_update_status::Ok
    );
    assert_eq!(out.size, 1000);
    assert_eq!(
        call(m, s, k, v, ARDIA_UPDATE_KIND_DEB, ptr::null_mut()),
        ardia_update_status::InvalidArgument
    );
    assert_eq!(call(m, s, k, v, 3, &mut out), ardia_update_status::InvalidArgument);
    assert_eq!(out, empty());
    assert_eq!(
        call(m, s, (key.as_ptr(), 31), v, 0, &mut out),
        ardia_update_status::InvalidArgument
    );
    assert_eq!(
        call(m, s, (ptr::null(), 32), v, 0, &mut out),
        ardia_update_status::InvalidArgument
    );
    assert_eq!(
        call((ptr::null(), 10), s, k, v, 0, &mut out),
        ardia_update_status::InvalidArgument
    );
    assert_eq!(
        call((ptr::null(), 4097), s, k, v, 0, &mut out),
        ardia_update_status::TooLarge
    );
    assert_eq!(
        call(m, (ptr::null(), 64), k, v, 0, &mut out),
        ardia_update_status::InvalidArgument
    );
    assert_eq!(
        call(m, (ptr::null(), 63), k, v, 0, &mut out),
        ardia_update_status::Signature
    );
    assert_eq!(
        call(m, (ptr::null(), 0), k, v, 0, &mut out),
        ardia_update_status::Signature
    );
    assert_eq!(
        call(m, s, k, (ptr::null(), 6), 0, &mut out),
        ardia_update_status::InvalidArgument
    );
    assert_eq!(
        call(m, s, k, (ptr::null(), 65), 0, &mut out),
        ardia_update_status::Version
    );
    assert_eq!(
        call(m, s, k, (b"\xff.2.48".as_ptr(), 6), 0, &mut out),
        ardia_update_status::Version
    );
    assert_eq!(
        call((ptr::null(), 0), s, k, v, 0, &mut out),
        ardia_update_status::Signature
    );

    let mut order = 9;
    assert_eq!(
        unsafe { ardia_update_compare_versions(ptr::null(), 5, b"1.2.3".as_ptr(), 5, &mut order) },
        ardia_update_status::InvalidArgument
    );
    assert_eq!(
        unsafe { ardia_update_compare_versions(b"1.2.3".as_ptr(), 5, b"1.2.3".as_ptr(), 5, ptr::null_mut()) },
        ardia_update_status::InvalidArgument
    );
    assert_eq!(
        unsafe { ardia_update_channel_of(b"1.2.3".as_ptr(), 5, ptr::null_mut()) },
        ardia_update_status::InvalidArgument
    );
    assert_eq!(
        unsafe { ardia_update_check_offer(b"1.2.4".as_ptr(), 5, b"1.2.3".as_ptr(), 5, 2) },
        ardia_update_status::InvalidArgument
    );
    assert_eq!(
        unsafe { ardia_update_check_offer(ptr::null(), 0, b"1.2.3".as_ptr(), 5, 0) },
        ardia_update_status::Version
    );
    assert_eq!(ardia_update_abi_version(), ARDIA_UPDATE_ABI_VERSION);
}

#[test]
fn the_c_constants_match_the_core() {
    assert_eq!(ARDIA_UPDATE_MAX_MANIFEST_BYTES, ardia_update_core::MAX_MANIFEST_BYTES);
    assert_eq!(ARDIA_UPDATE_SIGNATURE_BYTES, ardia_update_core::SIGNATURE_BYTES);
    assert_eq!(ARDIA_UPDATE_PUBLIC_KEY_BYTES, ardia_update_core::PUBLIC_KEY_BYTES);
    assert_eq!(ARDIA_UPDATE_SHA256_BYTES, ardia_update_core::SHA256_BYTES);
    assert_eq!(ARDIA_UPDATE_MAX_VERSION_BYTES, ardia_update_core::MAX_VERSION_BYTES);
    assert_eq!(ARDIA_UPDATE_MAX_PACKAGE_BYTES, ardia_update_core::MAX_PACKAGE_BYTES);
    assert_eq!(
        ARDIA_UPDATE_WINDOWS_MAX_MANIFEST_BYTES,
        ardia_update_core::MAX_WINDOWS_MANIFEST_BYTES
    );
    assert_eq!(
        ARDIA_UPDATE_WINDOWS_MAX_INSTALLER_BYTES,
        ardia_update_core::MAX_WINDOWS_INSTALLER_BYTES
    );
    assert_eq!(
        ARDIA_UPDATE_WINDOWS_MAX_URL_BYTES,
        ardia_update_core::MAX_WINDOWS_URL_BYTES
    );
}

fn empty_windows() -> ardia_update_windows_package {
    ardia_update_windows_package {
        build: 0,
        bytes: 0,
        sha256: [0; ARDIA_UPDATE_SHA256_BYTES],
        version_len: 0,
        version: [0; ARDIA_UPDATE_MAX_VERSION_BYTES],
        url_len: 0,
        url: [0; ARDIA_UPDATE_WINDOWS_MAX_URL_BYTES],
    }
}

fn windows_cpu(name: &str) -> u32 {
    match name {
        "x64" => ARDIA_UPDATE_WINDOWS_CPU_X64,
        "arm64" => ARDIA_UPDATE_WINDOWS_CPU_ARM64,
        _ => panic!("{name}"),
    }
}

#[test]
fn every_windows_manifest_vector_gives_its_outcome_through_the_c_abi() {
    let vectors = vectors();
    let cases = vectors["windows"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let manifest = case["manifest"].as_str().unwrap().as_bytes();
        let signature = hex(case["signature"].as_str().unwrap());
        let key = hex(case["publicKey"].as_str().unwrap());
        let published_under = case["publishedUnder"].as_str().unwrap().as_bytes();
        let cpu = windows_cpu(case["cpu"].as_str().unwrap());
        let current_build = case["currentBuild"].as_u64().unwrap();
        let mut out = ardia_update_windows_package {
            build: 7,
            bytes: 7,
            sha256: [7; ARDIA_UPDATE_SHA256_BYTES],
            version_len: 7,
            version: [7; ARDIA_UPDATE_MAX_VERSION_BYTES],
            url_len: 7,
            url: [7; ARDIA_UPDATE_WINDOWS_MAX_URL_BYTES],
        };
        let status = unsafe {
            ardia_update_verify_windows(
                manifest.as_ptr(),
                manifest.len(),
                signature.as_ptr(),
                signature.len(),
                key.as_ptr(),
                key.len(),
                published_under.as_ptr(),
                published_under.len(),
                cpu,
                current_build,
                &mut out,
            )
        };
        let outcome = &case["outcome"];
        match outcome["error"].as_str() {
            Some(code) => {
                assert_eq!(status_code(status), code, "{name}");
                assert_eq!(out, empty_windows(), "{name}: a refusal zeroes the output");
            }
            None => {
                assert_eq!(status, ardia_update_status::Ok, "{name}");
                assert_eq!(out.build, outcome["build"].as_u64().unwrap(), "{name}");
                assert_eq!(out.bytes, outcome["bytes"].as_u64().unwrap(), "{name}");
                assert_eq!(to_hex(&out.sha256), outcome["sha256"].as_str().unwrap(), "{name}");
                assert_eq!(
                    std::str::from_utf8(&out.version[..out.version_len]).unwrap(),
                    outcome["version"].as_str().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    std::str::from_utf8(&out.url[..out.url_len]).unwrap(),
                    outcome["url"].as_str().unwrap(),
                    "{name}"
                );
            }
        }
    }
}

#[test]
fn windows_arguments_are_checked_by_null_length_and_range_only() {
    let vectors = vectors();
    let valid = &vectors["windows"][0];
    let manifest = valid["manifest"].as_str().unwrap().as_bytes();
    let signature = hex(valid["signature"].as_str().unwrap());
    let key = hex(valid["publicKey"].as_str().unwrap());
    let prefix = valid["publishedUnder"].as_str().unwrap().as_bytes();
    let mut out = empty_windows();
    assert_eq!(
        unsafe {
            ardia_update_verify_windows(
                manifest.as_ptr(),
                manifest.len(),
                signature.as_ptr(),
                signature.len(),
                key.as_ptr(),
                key.len(),
                prefix.as_ptr(),
                prefix.len(),
                ARDIA_UPDATE_WINDOWS_CPU_X64,
                59,
                ptr::null_mut(),
            )
        },
        ardia_update_status::InvalidArgument
    );
    assert_eq!(
        unsafe {
            ardia_update_verify_windows(
                manifest.as_ptr(),
                manifest.len(),
                signature.as_ptr(),
                signature.len(),
                key.as_ptr(),
                key.len(),
                prefix.as_ptr(),
                prefix.len(),
                2,
                59,
                &mut out,
            )
        },
        ardia_update_status::InvalidArgument
    );
    assert_eq!(
        unsafe {
            ardia_update_verify_windows(
                ptr::null(),
                ARDIA_UPDATE_WINDOWS_MAX_MANIFEST_BYTES + 1,
                signature.as_ptr(),
                signature.len(),
                key.as_ptr(),
                key.len(),
                prefix.as_ptr(),
                prefix.len(),
                ARDIA_UPDATE_WINDOWS_CPU_X64,
                59,
                &mut out,
            )
        },
        ardia_update_status::TooLarge
    );
    assert_eq!(
        unsafe {
            ardia_update_verify_windows(
                manifest.as_ptr(),
                manifest.len(),
                ptr::null(),
                0,
                key.as_ptr(),
                key.len(),
                prefix.as_ptr(),
                prefix.len(),
                ARDIA_UPDATE_WINDOWS_CPU_X64,
                59,
                &mut out,
            )
        },
        ardia_update_status::Signature
    );
}

#[test]
fn outputs_are_written_into_uninitialized_slots_without_reading_them() {
    use std::mem::MaybeUninit;
    let vectors = vectors();
    let valid = &vectors["manifests"][0];
    let manifest = valid["manifest"].as_str().unwrap().as_bytes();
    let signature = hex(valid["signature"].as_str().unwrap());
    let key = hex(valid["publicKey"].as_str().unwrap());
    for (signature, want, size) in [
        (signature.clone(), ardia_update_status::Ok, 1000),
        (signature[..63].to_vec(), ardia_update_status::Signature, 0),
    ] {
        let mut slot = MaybeUninit::<ardia_update_package>::uninit();
        unsafe { ptr::write_bytes(slot.as_mut_ptr(), 0xa5, 1) };
        let status = unsafe {
            ardia_update_verify_linux(
                manifest.as_ptr(),
                manifest.len(),
                signature.as_ptr(),
                signature.len(),
                key.as_ptr(),
                key.len(),
                b"0.2.48".as_ptr(),
                6,
                b"0.2.47".as_ptr(),
                6,
                ARDIA_UPDATE_KIND_DEB,
                slot.as_mut_ptr(),
            )
        };
        assert_eq!(status, want);
        let package = unsafe { slot.assume_init() };
        assert_eq!(package.size, size);
        if want != ardia_update_status::Ok {
            assert_eq!(package, empty());
        }
    }
    let mut order = MaybeUninit::<i32>::uninit();
    unsafe { ptr::write_bytes(order.as_mut_ptr(), 0xa5, 1) };
    assert_eq!(
        unsafe { ardia_update_compare_versions(b"0.2.47".as_ptr(), 6, b"0.2.48".as_ptr(), 6, order.as_mut_ptr()) },
        ardia_update_status::Ok
    );
    assert_eq!(unsafe { order.assume_init() }, -1);
    let mut channel = MaybeUninit::<u32>::uninit();
    unsafe { ptr::write_bytes(channel.as_mut_ptr(), 0xa5, 1) };
    assert_eq!(
        unsafe { ardia_update_channel_of(b"x".as_ptr(), 1, channel.as_mut_ptr()) },
        ardia_update_status::Version
    );
    assert_eq!(unsafe { channel.assume_init() }, ARDIA_UPDATE_CHANNEL_STABLE);
}
