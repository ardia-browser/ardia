use ardia_crypto::{Backend, Crypto, CryptoError};

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

#[test]
fn sha256_matches_fips_180() {
    assert_eq!(
        Backend::sha256(b"abc").to_vec(),
        hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    );
}

#[test]
fn hmac_sha256_matches_rfc_4231_and_streams_parts() {
    let expected = hex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    assert_eq!(
        Backend::hmac_sha256(b"Jefe", &[b"what do ya want for nothing?"]).to_vec(),
        expected
    );
    assert_eq!(
        Backend::hmac_sha256(b"Jefe", &[b"what do ya ", b"", b"want for nothing?"]).to_vec(),
        expected
    );
}

#[test]
fn hkdf_sha256_matches_rfc_5869() {
    let mut okm = [0u8; 42];
    Backend::hkdf_sha256(
        &[0x0b; 22],
        &hex("000102030405060708090a0b0c"),
        &hex("f0f1f2f3f4f5f6f7f8f9"),
        &mut okm,
    )
    .unwrap();
    assert_eq!(
        okm.to_vec(),
        hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
    );
    let mut too_long = vec![0u8; 255 * 32 + 1];
    assert_eq!(
        Backend::hkdf_sha256(b"k", b"s", b"i", &mut too_long),
        Err(CryptoError::Length)
    );
}

#[test]
fn aes256gcm_matches_gcm_spec_cases_13_and_14() {
    let key = [0u8; 32];
    let nonce = [0u8; 12];
    assert_eq!(
        Backend::aes256gcm_seal(&key, &nonce, b"", b"").unwrap(),
        hex("530f8afbc74536b9a963b4f1c4cb738b")
    );
    let sealed = Backend::aes256gcm_seal(&key, &nonce, b"", &[0u8; 16]).unwrap();
    assert_eq!(
        sealed,
        hex("cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919")
    );
    assert_eq!(
        Backend::aes256gcm_open(&key, &nonce, b"", &sealed).unwrap().as_slice(),
        &[0u8; 16]
    );
}

#[test]
fn aes256gcm_rejects_wrong_aad_key_nonce_and_tampering() {
    let key = [7u8; 32];
    let nonce = [9u8; 12];
    let sealed = Backend::aes256gcm_seal(&key, &nonce, b"aad", b"secret").unwrap();
    assert_eq!(
        Backend::aes256gcm_open(&key, &nonce, b"aad", &sealed)
            .unwrap()
            .as_slice(),
        b"secret"
    );
    assert_eq!(
        Backend::aes256gcm_open(&key, &nonce, b"aaD", &sealed),
        Err(CryptoError::Authentication)
    );
    assert_eq!(
        Backend::aes256gcm_open(&[8u8; 32], &nonce, b"aad", &sealed),
        Err(CryptoError::Authentication)
    );
    assert_eq!(
        Backend::aes256gcm_open(&key, &[0u8; 12], b"aad", &sealed),
        Err(CryptoError::Authentication)
    );
    for index in 0..sealed.len() {
        let mut tampered = sealed.clone();
        tampered[index] ^= 1;
        assert_eq!(
            Backend::aes256gcm_open(&key, &nonce, b"aad", &tampered),
            Err(CryptoError::Authentication)
        );
    }
    assert_eq!(
        Backend::aes256gcm_open(&key, &nonce, b"aad", &sealed[..15]),
        Err(CryptoError::Authentication)
    );
}

#[test]
fn random_fills_and_differs() {
    let mut first = [0u8; 32];
    let mut second = [0u8; 32];
    Backend::fill_random(&mut first).unwrap();
    Backend::fill_random(&mut second).unwrap();
    assert_ne!(first, second);
}

#[cfg(feature = "ed25519")]
#[test]
fn ed25519_verifies_rfc_8032_test_1() {
    let public_key: [u8; 32] = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        .try_into()
        .unwrap();
    let signature: [u8; 64] = hex(concat!(
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46b",
        "d25bf5f0595bbe24655141438e7a100b"
    ))
    .try_into()
    .unwrap();
    assert!(Backend::ed25519_verify(&public_key, b"", &signature));
    assert!(!Backend::ed25519_verify(&public_key, b"x", &signature));
    let mut forged = signature;
    forged[0] ^= 1;
    assert!(!Backend::ed25519_verify(&public_key, b"", &forged));
}

#[cfg(feature = "ed25519")]
const TRIVIAL_MESSAGES: [&[u8]; 3] = [b"", b"any message", b"update manifest"];

#[cfg(feature = "ed25519")]
fn identity_and_trivial_signature() -> ([u8; 32], [u8; 64]) {
    let mut identity = [0u8; 32];
    identity[0] = 1;
    let mut trivial = [0u8; 64];
    trivial[0] = 1;
    (identity, trivial)
}

#[cfg(all(feature = "ed25519", feature = "rustcrypto"))]
#[test]
fn dalek_lenient_verify_accepts_the_trivial_signature_the_backend_refuses() {
    let (identity, trivial) = identity_and_trivial_signature();
    let lenient = ed25519_dalek::VerifyingKey::from_bytes(&identity).unwrap();
    for message in TRIVIAL_MESSAGES {
        assert!(
            ed25519_dalek::Verifier::verify(&lenient, message, &ed25519_dalek::Signature::from_bytes(&trivial)).is_ok()
        );
        assert!(!Backend::ed25519_verify(&identity, message, &trivial));
    }
}

#[cfg(feature = "ed25519")]
#[test]
fn ed25519_rejects_small_order_keys_and_their_trivial_signatures() {
    let (identity, trivial) = identity_and_trivial_signature();
    for message in TRIVIAL_MESSAGES {
        assert!(!Backend::ed25519_verify(&identity, message, &trivial));
    }
    let order_two: [u8; 32] = hex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")
        .try_into()
        .unwrap();
    let mut with_order_two = [0u8; 64];
    with_order_two[..32].copy_from_slice(&order_two);
    assert!(!Backend::ed25519_verify(&order_two, b"", &with_order_two));
}

#[cfg(feature = "ed25519")]
const RFC_8032_TEST_1_KEY: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

#[cfg(feature = "ed25519")]
const IDENTITY_R_UNDER_TEST_1_KEY: [(&[u8], &str); 2] = [
    (
        b"",
        concat!(
            "0100000000000000000000000000000000000000000000000000000000000000",
            "756cf9b1d6f0d7a979b9d2af3dc2bc1294ec7cb6daa20eaff534c024fc57920f"
        ),
    ),
    (
        b"small order R",
        concat!(
            "0100000000000000000000000000000000000000000000000000000000000000",
            "f0a69ddebb802c89e405561d3315c191f2a6a984f8b7999f1f271e28c0a9850d"
        ),
    ),
];

#[cfg(feature = "ed25519")]
#[test]
fn ed25519_rejects_a_small_order_r_under_a_valid_key() {
    let public_key: [u8; 32] = hex(RFC_8032_TEST_1_KEY).try_into().unwrap();
    for (message, signature) in IDENTITY_R_UNDER_TEST_1_KEY {
        let signature: [u8; 64] = hex(signature).try_into().unwrap();
        assert!(!Backend::ed25519_verify(&public_key, message, &signature));
    }
}

#[cfg(all(feature = "ed25519", feature = "rustcrypto"))]
#[test]
fn the_identity_r_signatures_pass_the_cofactorless_equation() {
    let key = ed25519_dalek::VerifyingKey::from_bytes(&hex(RFC_8032_TEST_1_KEY).try_into().unwrap()).unwrap();
    for (message, signature) in IDENTITY_R_UNDER_TEST_1_KEY {
        let signature: [u8; 64] = hex(signature).try_into().unwrap();
        let signature = ed25519_dalek::Signature::from_bytes(&signature);
        assert!(ed25519_dalek::Verifier::verify(&key, message, &signature).is_ok());
        assert!(key.verify_strict(message, &signature).is_err());
    }
}

#[cfg(feature = "ed25519")]
#[test]
fn ed25519_rejects_a_non_canonical_s() {
    let public_key: [u8; 32] = hex(RFC_8032_TEST_1_KEY).try_into().unwrap();
    let s_plus_l: [u8; 64] = hex(concat!(
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155",
        "4c8c7872aa064e049dbb3013fbf29380d25bf5f0595bbe24655141438e7a101b"
    ))
    .try_into()
    .unwrap();
    assert!(!Backend::ed25519_verify(&public_key, b"", &s_plus_l));
}
