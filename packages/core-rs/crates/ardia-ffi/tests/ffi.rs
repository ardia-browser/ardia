use std::fs;
use std::path::Path;
use std::ptr;

use ardia_core::*;
use serde_json::Value;

struct Buf(ardia_buf);

impl Buf {
    fn new() -> Self {
        Buf(ardia_buf {
            ptr: ptr::null_mut(),
            len: 0,
        })
    }

    fn out(&mut self) -> *mut ardia_buf {
        &mut self.0
    }

    fn bytes(&self) -> Vec<u8> {
        if self.0.ptr.is_null() {
            return Vec::new();
        }
        unsafe { std::slice::from_raw_parts(self.0.ptr, self.0.len) }.to_vec()
    }

    fn text(&self) -> String {
        String::from_utf8(self.bytes()).unwrap()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes()).unwrap()
    }
}

impl Drop for Buf {
    fn drop(&mut self) {
        unsafe { ardia_buf_free(&mut self.0) };
        assert!(self.0.ptr.is_null() && self.0.len == 0);
    }
}

struct Keys(*mut ardia_sync_keys);

impl Keys {
    fn new(entropy: &[u8]) -> Self {
        let mut keys = ptr::null_mut();
        assert_eq!(
            unsafe { ardia_sync_keys_new(entropy.as_ptr(), entropy.len(), &mut keys) },
            ardia_status::Ok
        );
        Keys(keys)
    }
}

impl Drop for Keys {
    fn drop(&mut self) {
        unsafe { ardia_sync_keys_free(self.0) };
    }
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

fn vectors() -> (Value, Value) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../sync/tests/fixtures/sync-vectors");
    let read = |name: &str| serde_json::from_slice(&fs::read(root.join(name)).unwrap()).unwrap();
    (read("inputs.json"), read("expected.json"))
}

fn b64(text: &str) -> Vec<u8> {
    use std::collections::HashMap;
    let alphabet: HashMap<u8, u32> = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        .iter()
        .enumerate()
        .map(|(index, byte)| (*byte, index as u32))
        .collect();
    let mut out = Vec::new();
    for chunk in text.trim_end_matches('=').as_bytes().chunks(4) {
        let mut value = 0u32;
        for (index, byte) in chunk.iter().enumerate() {
            value |= alphabet[byte] << (18 - 6 * index);
        }
        out.extend_from_slice(&value.to_be_bytes()[1..chunk.len()]);
    }
    out
}

#[test]
fn keys_need_exactly_32_bytes_of_entropy() {
    let mut keys = ptr::null_mut();
    let short = [0u8; 31];
    assert_eq!(
        unsafe { ardia_sync_keys_new(short.as_ptr(), short.len(), &mut keys) },
        ardia_status::InvalidArgument
    );
    assert!(keys.is_null());
    assert_eq!(
        unsafe { ardia_sync_keys_new(ptr::null(), 32, &mut keys) },
        ardia_status::InvalidArgument
    );
    assert_eq!(
        unsafe { ardia_sync_keys_new(short.as_ptr(), 32, ptr::null_mut()) },
        ardia_status::InvalidArgument
    );
    unsafe { ardia_sync_keys_free(ptr::null_mut()) };
    unsafe { ardia_buf_free(ptr::null_mut()) };
    assert_eq!(ardia_abi_version(), ARDIA_ABI_VERSION);
}

#[test]
fn tags_seals_and_opens_reproduce_the_vectors() {
    let (inputs, expected) = vectors();
    let entropy = hex(inputs["entropies"]["ordinary"].as_str().unwrap());
    let keys = Keys::new(&entropy);
    let mut chain = Buf::new();
    assert_eq!(unsafe { ardia_sync_chain_tag(keys.0, chain.out()) }, ardia_status::Ok);
    assert_eq!(
        chain.text(),
        expected["chains"]["ordinary"]["chainTag"].as_str().unwrap()
    );
    let mut scope = Buf::new();
    assert_eq!(
        unsafe { ardia_sync_scope_tag(keys.0, b"app".as_ptr(), 3, scope.out()) },
        ardia_status::Ok
    );
    assert_eq!(
        scope.text(),
        expected["chains"]["ordinary"]["scopeTags"]["app"].as_str().unwrap()
    );

    let state = &inputs["localStates"][0];
    let payload = b64(inputs["payloads"][state["payload"].as_str().unwrap()].as_str().unwrap());
    let file = b64(expected["localStates"][0]["sealed"].as_str().unwrap());
    let mut opened = Buf::new();
    let status = unsafe {
        ardia_sync_open(
            keys.0,
            file.as_ptr(),
            file.len(),
            b"local".as_ptr(),
            5,
            b"state".as_ptr(),
            5,
            opened.out(),
        )
    };
    assert_eq!(status, ardia_status::Ok);
    assert_eq!(opened.bytes(), payload);

    let mut wrong = Buf::new();
    let status = unsafe {
        ardia_sync_open(
            keys.0,
            file.as_ptr(),
            file.len(),
            b"local".as_ptr(),
            5,
            b"other".as_ptr(),
            5,
            wrong.out(),
        )
    };
    assert_eq!(status, ardia_status::Authentication);
    assert_eq!(wrong.json()["code"], "authentication");

    let mut short = Buf::new();
    let status = unsafe {
        ardia_sync_open(
            keys.0,
            file.as_ptr(),
            10,
            b"local".as_ptr(),
            5,
            b"state".as_ptr(),
            5,
            short.out(),
        )
    };
    assert_eq!(status, ardia_status::Format);
    assert_eq!(short.json()["code"], "format");

    let mut random = Buf::new();
    let status = unsafe {
        ardia_sync_seal(
            keys.0,
            payload.as_ptr(),
            payload.len(),
            b"local".as_ptr(),
            5,
            b"state".as_ptr(),
            5,
            random.out(),
        )
    };
    assert_eq!(status, ardia_status::Ok);
    assert_eq!(random.bytes().len(), file.len());
    assert_ne!(random.bytes(), file);
}

#[test]
fn passwords_reproduce_the_vectors() {
    let (inputs, expected) = vectors();
    let keys = Keys::new(&hex(inputs["entropies"]["ordinary"].as_str().unwrap()));
    for login in expected["passwords"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|login| login["entropy"] == "ordinary")
    {
        let field = |key: &str| login[key].as_str().unwrap().as_bytes().to_vec();
        let (password, origin, username, sealed) =
            (field("password"), field("origin"), field("username"), field("sealed"));
        let mut out = Buf::new();
        let status = unsafe {
            ardia_sync_seal_password(
                keys.0,
                password.as_ptr(),
                password.len(),
                origin.as_ptr(),
                origin.len(),
                username.as_ptr(),
                username.len(),
                out.out(),
            )
        };
        assert_eq!(status, ardia_status::Ok);
        assert_eq!(out.bytes(), sealed);
        let mut opened = Buf::new();
        let status = unsafe {
            ardia_sync_open_password(
                keys.0,
                sealed.as_ptr(),
                sealed.len(),
                origin.as_ptr(),
                origin.len(),
                username.as_ptr(),
                username.len(),
                opened.out(),
            )
        };
        assert_eq!(status, ardia_status::Ok);
        assert_eq!(opened.bytes(), password);
    }
}

#[test]
fn every_input_has_a_size_cap_and_text_must_be_utf8() {
    let keys = Keys::new(&[0u8; 32]);
    let byte = [0u8; 1];
    let mut out = Buf::new();
    let status = unsafe {
        ardia_sync_seal(
            keys.0,
            byte.as_ptr(),
            ARDIA_MAX_PAYLOAD_BYTES + 1,
            b"a".as_ptr(),
            1,
            b"b".as_ptr(),
            1,
            out.out(),
        )
    };
    assert_eq!(status, ardia_status::TooLarge);
    assert_eq!(out.json()["code"], "tooLarge");
    let mut out = Buf::new();
    let status = unsafe {
        ardia_sync_open(
            keys.0,
            byte.as_ptr(),
            ARDIA_MAX_SEALED_FILE_BYTES + 1,
            b"a".as_ptr(),
            1,
            b"b".as_ptr(),
            1,
            out.out(),
        )
    };
    assert_eq!(status, ardia_status::TooLarge);
    let mut out = Buf::new();
    let status = unsafe { ardia_sync_scope_tag(keys.0, byte.as_ptr(), ARDIA_MAX_LABEL_BYTES + 1, out.out()) };
    assert_eq!(status, ardia_status::TooLarge);
    let mut out = Buf::new();
    let status = unsafe {
        ardia_sync_seal_password(
            keys.0,
            byte.as_ptr(),
            ARDIA_MAX_PASSWORD_FIELD_BYTES + 1,
            b"o".as_ptr(),
            1,
            b"u".as_ptr(),
            1,
            out.out(),
        )
    };
    assert_eq!(status, ardia_status::TooLarge);
    let mut out = Buf::new();
    let status = unsafe {
        ardia_sync_open_password(
            keys.0,
            byte.as_ptr(),
            ARDIA_MAX_SEALED_PASSWORD_BYTES + 1,
            b"o".as_ptr(),
            1,
            b"u".as_ptr(),
            1,
            out.out(),
        )
    };
    assert_eq!(status, ardia_status::TooLarge);
    let mut out = Buf::new();
    assert_eq!(
        unsafe { ardia_phrase_to_entropy(byte.as_ptr(), ARDIA_MAX_PHRASE_BYTES + 1, out.out()) },
        ardia_status::TooLarge
    );
    let mut out = Buf::new();
    assert_eq!(
        unsafe { ardia_vault_list(byte.as_ptr(), ARDIA_MAX_LISTING_JSON_BYTES + 1, out.out()) },
        ardia_status::TooLarge
    );
    let invalid = [0xffu8, 0xfe];
    let mut out = Buf::new();
    assert_eq!(
        unsafe { ardia_sync_scope_tag(keys.0, invalid.as_ptr(), 2, out.out()) },
        ardia_status::InvalidArgument
    );
    assert_eq!(out.json()["code"], "utf8");
    let mut out = Buf::new();
    assert_eq!(
        unsafe { ardia_sync_scope_tag(keys.0, ptr::null(), 3, out.out()) },
        ardia_status::InvalidArgument
    );
    let mut out = Buf::new();
    assert_eq!(
        unsafe { ardia_sync_scope_tag(ptr::null(), b"app".as_ptr(), 3, out.out()) },
        ardia_status::InvalidArgument
    );
    assert_eq!(
        unsafe { ardia_sync_chain_tag(keys.0, ptr::null_mut()) },
        ardia_status::InvalidArgument
    );
}

#[test]
fn phrases_cross_as_bytes_and_problems_as_json() {
    let (inputs, expected) = vectors();
    let entropy = hex(inputs["entropies"]["ordinary"].as_str().unwrap());
    let phrase = expected["chains"]["ordinary"]["phrase"].as_str().unwrap();
    let mut words = Buf::new();
    assert_eq!(
        unsafe { ardia_phrase_from_entropy(entropy.as_ptr(), entropy.len(), words.out()) },
        ardia_status::Ok
    );
    assert_eq!(words.text(), phrase);
    let upper = phrase.to_uppercase();
    let mut back = Buf::new();
    assert_eq!(
        unsafe { ardia_phrase_to_entropy(upper.as_ptr(), upper.len(), back.out()) },
        ardia_status::Ok
    );
    assert_eq!(back.bytes(), entropy);
    let cases = [
        ("awful supreme", serde_json::json!({"code": "wordCount", "count": 2})),
        (
            &*phrase.replacen("awful", "awf", 1),
            serde_json::json!({"code": "unknownWord", "index": 0}),
        ),
        (
            &*phrase.replacen("lizard", "lizzard", 1),
            serde_json::json!({"code": "unknownWord", "index": 6}),
        ),
        (
            &*phrase.replacen("awful supreme", "supreme awful", 1),
            serde_json::json!({"code": "checksum"}),
        ),
    ];
    for (text, detail) in cases {
        let mut out = Buf::new();
        assert_eq!(
            unsafe { ardia_phrase_to_entropy(text.as_ptr(), text.len(), out.out()) },
            ardia_status::Phrase
        );
        assert_eq!(out.json(), detail);
    }
    let mut fresh = Buf::new();
    assert_eq!(unsafe { ardia_phrase_generate_entropy(fresh.out()) }, ardia_status::Ok);
    assert_eq!(fresh.bytes().len(), ARDIA_ENTROPY_BYTES);
    let mut id = Buf::new();
    assert_eq!(unsafe { ardia_sync_new_file_id(id.out()) }, ardia_status::Ok);
    assert_eq!(id.text().len(), 26);
}

#[test]
fn occupied_output_slots_are_refused_and_left_alone() {
    let keys = Keys::new(&[0u8; 32]);
    let mut out = Buf::new();
    assert_eq!(unsafe { ardia_sync_chain_tag(keys.0, out.out()) }, ardia_status::Ok);
    let (held, length) = (out.0.ptr, out.0.len);
    assert_eq!(
        unsafe { ardia_sync_chain_tag(keys.0, out.out()) },
        ardia_status::OutputInUse
    );
    assert_eq!((out.0.ptr, out.0.len), (held, length));
    assert_eq!(out.text(), "gbcx4r55mk3rlaegbggknyx4ta");
    let mut stale = ardia_buf {
        ptr: ptr::null_mut(),
        len: 5,
    };
    assert_eq!(unsafe { ardia_sync_new_file_id(&mut stale) }, ardia_status::OutputInUse);
    let mut existing = keys.0;
    let entropy = [1u8; 32];
    assert_eq!(
        unsafe { ardia_sync_keys_new(entropy.as_ptr(), 32, &mut existing) },
        ardia_status::OutputInUse
    );
    assert_eq!(existing, keys.0);
}

#[test]
fn a_wrong_entropy_length_is_an_invalid_argument_everywhere() {
    let bytes = [7u8; 64];
    for length in [0, 1, 31, 33, 64] {
        let mut keys = ptr::null_mut();
        assert_eq!(
            unsafe { ardia_sync_keys_new(bytes.as_ptr(), length, &mut keys) },
            ardia_status::InvalidArgument
        );
        assert!(keys.is_null());
        let mut words = Buf::new();
        let status = unsafe { ardia_phrase_from_entropy(bytes.as_ptr(), length, words.out()) };
        assert_eq!(status, ardia_status::InvalidArgument, "{length} bytes");
        assert_eq!(words.json()["code"], "argument");
    }
    let mut words = Buf::new();
    assert_eq!(
        unsafe { ardia_phrase_from_entropy(ptr::null(), 32, words.out()) },
        ardia_status::InvalidArgument
    );
    let mut words = Buf::new();
    assert_eq!(
        unsafe { ardia_phrase_from_entropy(bytes.as_ptr(), 32, words.out()) },
        ardia_status::Ok
    );
    let mut keys = ptr::null_mut();
    assert_eq!(
        unsafe { ardia_sync_keys_new(bytes.as_ptr(), 32, &mut keys) },
        ardia_status::Ok
    );
    unsafe { ardia_sync_keys_free(keys) };
}

#[test]
fn too_large_is_only_for_variable_length_inputs_over_their_cap() {
    let byte = [b'a'; 1];
    let mut out = Buf::new();
    let status = unsafe { ardia_phrase_to_entropy(byte.as_ptr(), ARDIA_MAX_PHRASE_BYTES + 1, out.out()) };
    assert_eq!(status, ardia_status::TooLarge);
    assert_eq!(out.json()["code"], "tooLarge");
    let at_cap = "a ".repeat(ARDIA_MAX_PHRASE_BYTES / 2);
    let mut out = Buf::new();
    let status = unsafe { ardia_phrase_to_entropy(at_cap.as_ptr(), at_cap.len(), out.out()) };
    assert_eq!(status, ardia_status::Phrase);
}

#[test]
fn phrase_problems_never_carry_phrase_text() {
    let words = "abandon ".repeat(23) + "zebrafish";
    let mut out = Buf::new();
    assert_eq!(
        unsafe { ardia_phrase_to_entropy(words.as_ptr(), words.len(), out.out()) },
        ardia_status::Phrase
    );
    let detail = out.text();
    assert_eq!(detail, r#"{"code":"unknownWord","index":23}"#);
    assert!(!detail.contains("zebra") && !detail.contains("abandon"));
}

#[test]
fn vault_listing_crosses_as_json() {
    let request = serde_json::json!({
        "names": [
            "zsiw2mzu7zuwbq7s2mwin4l3lm.nns",
            ".3kxt2wmd3uerpyxu3p7jvb4er4.nns.icloud",
            "k6s5tui52jhfei32qihguzxuui.nns",
            ".k6s5tui52jhfei32qihguzxuui.nns.icloud",
            "notatag.nns",
            ".DS_Store",
            "ccpuxwjb5kpwrzbb5rbq22h67e.nns.tmp"
        ],
        "known": ["zsiw2mzu7zuwbq7s2mwin4l3lm"]
    })
    .to_string();
    let mut out = Buf::new();
    assert_eq!(
        unsafe { ardia_vault_list(request.as_ptr(), request.len(), out.out()) },
        ardia_status::Ok
    );
    assert_eq!(
        out.json(),
        serde_json::json!({
            "open": ["k6s5tui52jhfei32qihguzxuui"],
            "pending": ["3kxt2wmd3uerpyxu3p7jvb4er4", "k6s5tui52jhfei32qihguzxuui"],
            "present": ["3kxt2wmd3uerpyxu3p7jvb4er4", "k6s5tui52jhfei32qihguzxuui", "zsiw2mzu7zuwbq7s2mwin4l3lm"]
        })
    );
    let mut bad = Buf::new();
    assert_eq!(
        unsafe { ardia_vault_list(b"{".as_ptr(), 1, bad.out()) },
        ardia_status::InvalidArgument
    );
    assert_eq!(bad.json()["code"], "json");
}
