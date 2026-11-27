#[path = "../../ardia-import-core/tests/support/mod.rs"]
mod support;

use std::mem::MaybeUninit;
use std::ptr;

use ardia_import::{
    ardia_import_abi_version, ardia_import_buf, ardia_import_buf_free, ardia_import_bytes,
    ardia_import_chromium_bookmarks, ardia_import_status, ARDIA_IMPORT_ABI_VERSION, ARDIA_IMPORT_MAX_INPUT_BYTES,
};
use ardia_import_core::{chromium_bookmarks, ProfileFile};
use serde_json::{json, Value};

const SIMPLE: &[u8] =
    br#"{"roots":{"other":{"type":"folder","children":[{"type":"url","name":"A","url":"https://a/"}]}}}"#;

fn file(data: &Option<Vec<u8>>) -> ProfileFile<'_> {
    data.as_deref().map_or(ProfileFile::Missing, ProfileFile::Bytes)
}

fn bytes(data: &[u8]) -> ardia_import_bytes {
    ardia_import_bytes {
        ptr: data.as_ptr(),
        len: data.len(),
    }
}

fn call(
    bookmarks: Option<&ardia_import_bytes>,
    account: Option<&ardia_import_bytes>,
) -> (ardia_import_status, ardia_import_buf) {
    let mut out = MaybeUninit::<ardia_import_buf>::uninit();
    let status = unsafe {
        ardia_import_chromium_bookmarks(
            bookmarks.map_or(ptr::null(), ptr::from_ref),
            account.map_or(ptr::null(), ptr::from_ref),
            out.as_mut_ptr(),
        )
    };
    (status, unsafe { out.assume_init() })
}

fn take(mut buf: ardia_import_buf) -> Vec<u8> {
    assert!(!buf.ptr.is_null() && buf.len > 0);
    let copy = unsafe { std::slice::from_raw_parts(buf.ptr, buf.len) }.to_vec();
    unsafe { ardia_import_buf_free(&mut buf) };
    assert!(buf.ptr.is_null());
    assert_eq!(buf.len, 0);
    copy
}

fn error(status: ardia_import_status, buf: ardia_import_buf) -> (ardia_import_status, Value) {
    (status, serde_json::from_slice(&take(buf)).unwrap())
}

#[test]
fn the_abi_version_is_exported() {
    assert_eq!(ardia_import_abi_version(), ARDIA_IMPORT_ABI_VERSION);
}

#[test]
fn a_profile_parses_through_the_c_abi() {
    let (status, buf) = call(Some(&bytes(SIMPLE)), None);
    assert_eq!(status, ardia_import_status::Ok);
    let tree: Value = serde_json::from_slice(&take(buf)).unwrap();
    assert_eq!(tree["children"][0]["role"], "other");
    assert_eq!(tree["children"][0]["children"][0]["url"], "https://a/");
}

#[test]
fn the_output_slot_is_written_without_being_read() {
    let mut out = MaybeUninit::<ardia_import_buf>::uninit();
    unsafe {
        out.as_mut_ptr()
            .cast::<u8>()
            .write_bytes(0xA5, size_of::<ardia_import_buf>())
    };
    let status = unsafe { ardia_import_chromium_bookmarks(&bytes(SIMPLE), ptr::null(), out.as_mut_ptr()) };
    assert_eq!(status, ardia_import_status::Ok);
    take(unsafe { out.assume_init() });
}

#[test]
fn a_null_output_slot_is_refused() {
    let status = unsafe { ardia_import_chromium_bookmarks(&bytes(SIMPLE), ptr::null(), ptr::null_mut()) };
    assert_eq!(status, ardia_import_status::InvalidArgument);
}

#[test]
fn missing_files_are_not_found() {
    let (status, buf) = call(None, None);
    assert_eq!(
        error(status, buf),
        (ardia_import_status::NotFound, json!({"code": "notFound"}))
    );
}

#[test]
fn an_empty_or_null_empty_input_is_an_unreadable_file() {
    let empty = ardia_import_bytes {
        ptr: ptr::null(),
        len: 0,
    };
    let (status, buf) = call(Some(&empty), None);
    assert_eq!(
        error(status, buf),
        (ardia_import_status::Unreadable, json!({"code": "unreadable"}))
    );
    let (status, buf) = call(None, Some(&empty));
    assert_eq!(status, ardia_import_status::Ok);
    assert_eq!(
        serde_json::from_slice::<Value>(&take(buf)).unwrap(),
        json!({"type":"folder","title":"Bookmarks","children":[]})
    );
}

#[test]
fn a_null_pointer_with_a_length_is_an_invalid_argument() {
    let bogus = ardia_import_bytes {
        ptr: ptr::null(),
        len: 3,
    };
    for (local, account) in [(Some(&bogus), None), (Some(&bytes(SIMPLE)), Some(&bogus))] {
        let (status, buf) = call(local, account);
        assert_eq!(
            error(status, buf),
            (ardia_import_status::InvalidArgument, json!({"code": "argument"}))
        );
    }
}

#[test]
fn an_over_cap_length_is_refused_before_the_pointer_is_read() {
    let huge = ardia_import_bytes {
        ptr: ptr::null(),
        len: ARDIA_IMPORT_MAX_INPUT_BYTES + 1,
    };
    let (status, buf) = call(Some(&huge), None);
    assert_eq!(
        error(status, buf),
        (ardia_import_status::TooLarge, json!({"code": "tooLarge"}))
    );
    let huge = ardia_import_bytes {
        ptr: ptr::dangling(),
        len: usize::MAX,
    };
    let (status, buf) = call(Some(&bytes(SIMPLE)), Some(&huge));
    assert_eq!(status, ardia_import_status::Ok);
    let tree: Value = serde_json::from_slice(&take(buf)).unwrap();
    assert_eq!(tree["children"].as_array().unwrap().len(), 1);
}

#[test]
fn the_pointer_field_is_not_read_for_empty_or_oversized_lengths() {
    let cases = [
        (0, false, ardia_import_status::Unreadable),
        (ARDIA_IMPORT_MAX_INPUT_BYTES + 1, false, ardia_import_status::TooLarge),
        (0, true, ardia_import_status::Ok),
        (ARDIA_IMPORT_MAX_INPUT_BYTES + 1, true, ardia_import_status::Ok),
    ];
    for (len, as_account, want) in cases {
        let mut file = MaybeUninit::<ardia_import_bytes>::uninit();
        unsafe { ptr::addr_of_mut!((*file.as_mut_ptr()).len).write(len) };
        let local = bytes(SIMPLE);
        let (bookmarks, account) = match as_account {
            true => (ptr::from_ref(&local), file.as_ptr()),
            false => (file.as_ptr(), ptr::null()),
        };
        let mut out = MaybeUninit::<ardia_import_buf>::uninit();
        let status = unsafe { ardia_import_chromium_bookmarks(bookmarks, account, out.as_mut_ptr()) };
        assert_eq!(status, want, "len {len}, account {as_account}");
        take(unsafe { out.assume_init() });
    }
}

#[test]
fn freeing_null_or_an_empty_slot_does_nothing() {
    unsafe { ardia_import_buf_free(ptr::null_mut()) };
    let mut empty = ardia_import_buf {
        ptr: ptr::null_mut(),
        len: 0,
    };
    unsafe { ardia_import_buf_free(&mut empty) };
    unsafe { ardia_import_buf_free(&mut empty) };
    assert!(empty.ptr.is_null());
}

#[test]
fn every_shared_vector_reads_the_same_through_the_c_abi() {
    for case in support::cases() {
        let [local, account] = support::files(&case);
        let local_bytes = local.as_deref().map(bytes);
        let account_bytes = account.as_deref().map(bytes);
        let (status, buf) = call(local_bytes.as_ref(), account_bytes.as_ref());
        let output = take(buf);
        match chromium_bookmarks(file(&local), file(&account)) {
            Ok(tree) => {
                assert_eq!(status, ardia_import_status::Ok, "{}", case["name"]);
                assert_eq!(output, tree.to_json(), "{}", case["name"]);
            }
            Err(failure) => {
                assert_eq!(status, failure.into(), "{}", case["name"]);
                assert_eq!(
                    support::unbounded(&output),
                    json!({"code": failure.code()}),
                    "{}",
                    case["name"]
                );
            }
        }
        let expected = &case["expect"];
        let answer = support::unbounded(&output);
        let result = match status {
            ardia_import_status::Ok => Ok(answer.clone()),
            _ => Err(answer["code"].as_str().unwrap()),
        };
        let got = support::outcome(result, expected);
        assert!(support::same(&got, expected), "{}: got {got}", case["name"]);
    }
}
