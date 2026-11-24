use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::fs;
use std::path::Path;

use ardia_update::*;
use serde_json::Value;

struct Counting;

thread_local! {
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.with(|count| count.set(count.get() + 1));
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.with(|count| count.set(count.get() + 1));
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

fn allocations_during(call: impl FnOnce()) -> usize {
    let before = ALLOCATIONS.with(Cell::get);
    call();
    ALLOCATIONS.with(Cell::get) - before
}

#[test]
fn no_call_allocates_for_any_vector() {
    assert_eq!(
        allocations_during(|| drop(std::hint::black_box(Vec::<u8>::with_capacity(8)))),
        1
    );
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/update-vectors.json");
    let vectors: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    for case in vectors["manifests"].as_array().unwrap() {
        let manifest = case["manifest"].as_str().unwrap().as_bytes().to_vec();
        let signature = hex(case["signature"].as_str().unwrap());
        let key = hex(case["publicKey"].as_str().unwrap());
        let version = case["version"].as_str().unwrap().to_owned();
        let installed = case["installed"].as_str().unwrap().to_owned();
        let kind = match case["kind"].as_str().unwrap() {
            "deb" => ARDIA_UPDATE_KIND_DEB,
            "tarball" => ARDIA_UPDATE_KIND_TARBALL,
            _ => ARDIA_UPDATE_KIND_APPIMAGE,
        };
        let mut out = ardia_update_package {
            size: 0,
            sha256: [0; ARDIA_UPDATE_SHA256_BYTES],
        };
        let count = allocations_during(|| unsafe {
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
            );
        });
        assert_eq!(count, 0, "{}", case["name"]);
    }
    let pairs = [("0.2.48-nightly.3", "0.2.48"), ("garbage", "0.2.48")];
    for (left, right) in pairs {
        let mut order = 0;
        let mut channel = 0;
        let count = allocations_during(|| unsafe {
            ardia_update_compare_versions(left.as_ptr(), left.len(), right.as_ptr(), right.len(), &mut order);
            ardia_update_channel_of(left.as_ptr(), left.len(), &mut channel);
            ardia_update_check_offer(left.as_ptr(), left.len(), right.as_ptr(), right.len(), 1);
        });
        assert_eq!(count, 0, "{left} vs {right}");
    }
}
