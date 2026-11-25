#[path = "../../ardia-import-core/tests/support/mod.rs"]
mod support;

use std::mem::MaybeUninit;
use std::ptr;

use ardia_import::{
    ardia_import_buf, ardia_import_buf_free, ardia_import_bytes, ardia_import_netscape_bookmarks, ardia_import_status,
    ARDIA_IMPORT_MAX_INPUT_BYTES,
};
use ardia_import_core::{netscape_bookmarks, ProfileFile};
use serde_json::{json, Value};

const SIMPLE: &[u8] = b"<DL><p><DT><A HREF=\"javascript:void(0)\" ADD_DATE=\"1700000000\">A</A></DL><p>";

fn bytes(data: &[u8]) -> ardia_import_bytes {
    ardia_import_bytes {
        ptr: data.as_ptr(),
        len: data.len(),
    }
}

fn call(html: *const ardia_import_bytes) -> (ardia_import_status, ardia_import_buf) {
    let mut out = MaybeUninit::<ardia_import_buf>::uninit();
    let status = unsafe { ardia_import_netscape_bookmarks(html, out.as_mut_ptr()) };
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

fn answer(status: ardia_import_status, buf: ardia_import_buf) -> (ardia_import_status, Value) {
    (status, support::unbounded(&take(buf)))
}

#[test]
fn a_bookmarks_file_parses_through_the_c_abi() {
    let (status, buf) = call(&bytes(SIMPLE));
    let (status, value) = answer(status, buf);
    assert_eq!(status, ardia_import_status::Ok);
    assert_eq!(
        value,
        json!({"type":"folder","title":"Bookmarks","children":[
            {"type":"url","title":"A","url":"javascript:void(0)","dateAdded":1_700_000_000_000.0}]})
    );
}

#[test]
fn the_output_slot_is_written_without_being_read() {
    let mut out = MaybeUninit::<ardia_import_buf>::uninit();
    unsafe {
        out.as_mut_ptr()
            .cast::<u8>()
            .write_bytes(0xA5, size_of::<ardia_import_buf>())
    };
    let status = unsafe { ardia_import_netscape_bookmarks(&bytes(SIMPLE), out.as_mut_ptr()) };
    assert_eq!(status, ardia_import_status::Ok);
    take(unsafe { out.assume_init() });
}

#[test]
fn a_null_output_slot_is_refused() {
    let status = unsafe { ardia_import_netscape_bookmarks(&bytes(SIMPLE), ptr::null_mut()) };
    assert_eq!(status, ardia_import_status::InvalidArgument);
}

#[test]
fn a_missing_empty_or_bogus_file_answers_with_a_code() {
    let (status, buf) = call(ptr::null());
    assert_eq!(
        answer(status, buf),
        (ardia_import_status::NotFound, json!({"code": "notFound"}))
    );
    let empty = ardia_import_bytes {
        ptr: ptr::null(),
        len: 0,
    };
    let (status, buf) = call(&empty);
    assert_eq!(
        answer(status, buf),
        (ardia_import_status::Unreadable, json!({"code": "unreadable"}))
    );
    let bogus = ardia_import_bytes {
        ptr: ptr::null(),
        len: 3,
    };
    let (status, buf) = call(&bogus);
    assert_eq!(
        answer(status, buf),
        (ardia_import_status::InvalidArgument, json!({"code": "argument"}))
    );
    let huge = ardia_import_bytes {
        ptr: ptr::dangling(),
        len: usize::MAX,
    };
    let (status, buf) = call(&huge);
    assert_eq!(
        answer(status, buf),
        (ardia_import_status::TooLarge, json!({"code": "tooLarge"}))
    );
}

#[test]
fn the_pointer_field_is_not_read_for_empty_or_oversized_lengths() {
    for (len, want) in [
        (0, ardia_import_status::Unreadable),
        (ARDIA_IMPORT_MAX_INPUT_BYTES + 1, ardia_import_status::TooLarge),
        (usize::MAX, ardia_import_status::TooLarge),
    ] {
        let mut file = MaybeUninit::<ardia_import_bytes>::uninit();
        unsafe { ptr::addr_of_mut!((*file.as_mut_ptr()).len).write(len) };
        let (status, buf) = call(file.as_ptr());
        assert_eq!(status, want, "len {len}");
        take(buf);
    }
}

#[test]
fn every_shared_vector_reads_the_same_through_the_c_abi() {
    for case in support::netscape_cases() {
        let data = support::netscape_file(&case["file"]);
        let (status, buf) = call(&bytes(&data));
        let output = take(buf);
        match netscape_bookmarks(ProfileFile::Bytes(&data)) {
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
        let value = support::unbounded(&output);
        let result = match status {
            ardia_import_status::Ok => Ok(value.clone()),
            _ => Err(value["code"].as_str().unwrap()),
        };
        let got = support::outcome(result, expected);
        assert!(support::same(&got, expected), "{}: got {got}", case["name"]);
    }
}
