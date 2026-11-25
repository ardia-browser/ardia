use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use ardia_import_core::{netscape_bookmarks, ProfileFile, MAX_INPUT_BYTES};
use serde_json::{json, Value};

struct PeakAllocator;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for PeakAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let block = unsafe { System.alloc(layout) };
        if !block.is_null() {
            let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        block
    }

    unsafe fn dealloc(&self, block: *mut u8, layout: Layout) {
        unsafe { System.dealloc(block, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static ALLOCATOR: PeakAllocator = PeakAllocator;

#[test]
fn one_tag_full_of_unknown_and_repeated_attributes_allocates_nothing_per_attribute() {
    let mut html = String::from("<DL><p><DT><A HREF=\"https://first.example/\" ADD_DATE=\"1700000000\" ");
    let filler = "x HREF=\"https://later.example/\" ADD_DATE=\"1\" data-y=1 ";
    let repeats = (MAX_INPUT_BYTES / 2) / filler.len();
    html.reserve(repeats * filler.len() + 64);
    for _ in 0..repeats {
        html.push_str(filler);
    }
    html.push_str(">first</A></DL><p>");
    assert!(html.len() < MAX_INPUT_BYTES);
    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let node = netscape_bookmarks(ProfileFile::Bytes(html.as_bytes())).unwrap();
    let grown = PEAK.load(Ordering::Relaxed) - before;
    assert!(
        grown < 64 * 1024,
        "parsing one tag of {repeats} attribute groups allocated {grown} bytes"
    );
    let tree: Value = serde_json::from_slice(&node.to_json()).unwrap();
    assert_eq!(
        tree["children"],
        json!([{"type":"url","title":"first","url":"https://first.example/","dateAdded":1_700_000_000_000.0}])
    );
}
