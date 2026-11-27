use std::cell::RefCell;
use std::collections::HashSet;

use ardia_state::sync_engine::scope::{
    Adapter, ApplyRecords, ExtractContext, Extraction, Listing, ScopeOptions, ScopeState, SyncFile,
    SyncScopeArgs, Transport, TransportError, compact, log_payload, parse_sync_file, pull,
    snapshot_payload, sync_scope,
};
use ardia_state::sync_engine::{Clock, IndexMap, IndexSet, canonical};
use serde_json::{Value, json};

struct Folder {
    files: RefCell<IndexMap<String, String>>,
    next: RefCell<u32>,
}

impl Folder {
    fn new(files: IndexMap<String, String>) -> Self {
        Folder {
            files: RefCell::new(files),
            next: RefCell::new(0),
        }
    }
}

impl Transport for Folder {
    fn write(&self, _scope: &str, payload: &str) -> Result<String, TransportError> {
        let n = {
            let mut next = self.next.borrow_mut();
            *next += 1;
            *next
        };
        let digits: String = n
            .to_string()
            .chars()
            .map(|d| (b'e' + d.to_digit(10).unwrap_or(0) as u8) as char)
            .collect();
        let id = format!("{:z<26}", format!("rust{digits}"));
        self.files
            .borrow_mut()
            .insert(id.clone(), payload.to_owned());
        Ok(id)
    }

    fn read(&self, _scope: &str, known: &[String]) -> Result<Listing, TransportError> {
        let known: HashSet<&String> = known.iter().collect();
        let files = self.files.borrow();
        Ok(Listing {
            files: files
                .iter()
                .filter(|(id, _)| !known.contains(id))
                .map(|(id, p)| (id.clone(), p.clone()))
                .collect(),
            pending: Vec::new(),
            damaged: Vec::new(),
            present: files.keys().cloned().collect(),
        })
    }

    fn remove(&self, _scope: &str, ids: &[String]) -> Result<(), TransportError> {
        let mut files = self.files.borrow_mut();
        for id in ids {
            files.shift_remove(id);
        }
        Ok(())
    }
}

struct Kv {
    local: IndexMap<String, Value>,
}

impl Adapter for Kv {
    fn prefix(&self) -> &str {
        "kv:"
    }

    fn extract(&mut self, _cx: &ExtractContext) -> Option<Extraction> {
        Some(Extraction::of(self.local.clone()))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        self.local = visible.clone();
        true
    }
}

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/sync-js-interop.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn js_files(fixture: &Value) -> IndexMap<String, String> {
    fixture["files"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, p)| (id.clone(), p.as_str().unwrap().to_owned()))
        .collect()
}

fn fixed_now() -> i64 {
    1_790_000_010_000
}

#[test]
fn files_the_old_app_wrote_merge_to_the_same_records() {
    let fixture = fixture();
    let folder = Folder::new(js_files(&fixture));
    let mut state = ScopeState::default();
    let mut clock = Clock::with_now("RSB", None, fixed_now);
    let changed = pull(
        &mut state,
        &folder,
        "app",
        &mut clock,
        fixed_now(),
        &ScopeOptions::default(),
    )
    .unwrap();
    assert_eq!(changed.len(), 5);
    let expected = fixture["records"].as_object().unwrap();
    assert_eq!(state.records.len(), expected.len());
    for (key, record) in expected {
        let mine = &state.records[key];
        assert_eq!(mine.h, record["h"].as_str().unwrap(), "{key}");
        assert_eq!(mine.v, record["v"], "{key}");
        assert_eq!(json!([mine.o.0, mine.o.1]), record["o"], "{key}");
        assert_eq!(
            canonical(&mine.v),
            fixture["canonical"][key].as_str().unwrap(),
            "{key}"
        );
    }
    assert_eq!(serde_json::to_value(&state.vv).unwrap(), fixture["vv"]);
    assert!(state.damaged.is_empty());
}

#[test]
fn payloads_reserialize_byte_for_byte_like_json_stringify() {
    let fixture = fixture();
    for payload in js_files(&fixture).values() {
        match parse_sync_file(payload).unwrap() {
            SyncFile::Log(log) => assert_eq!(&log_payload(&log), payload),
            SyncFile::Snapshot(snapshot) => assert_eq!(&snapshot_payload(&snapshot), payload),
        }
    }
}

#[test]
fn a_rust_device_joins_the_old_folder_and_both_converge() {
    let fixture = fixture();
    let folder = Folder::new(js_files(&fixture));
    let mut b = ScopeState {
        await_remote: Some(true),
        ..ScopeState::default()
    };
    let mut clock = Clock::with_now("RSB", None, fixed_now);
    let mut adapters: Vec<Box<dyn Adapter>> = vec![Box::new(Kv {
        local: IndexMap::from([("kv:mine".to_owned(), json!({"from": "rust", "f": 1.5}))]),
    })];
    let now = fixed_now;
    sync_scope(SyncScopeArgs {
        scope: "app",
        state: &mut b,
        transport: &folder,
        adapters: &mut adapters,
        clock: &mut clock,
        device: "RSB",
        now: &now,
        options: ScopeOptions::default(),
    })
    .unwrap();
    assert!(b.records.contains_key("kv:a") && b.records.contains_key("kv:mine"));
    assert!(b.records["kv:b"].v.is_null());
    let mut options = ScopeOptions {
        prune_grace: i64::MAX / 4,
        ..ScopeOptions::default()
    };
    compact(
        &mut b,
        &folder,
        "app",
        "RSB",
        fixed_now() + 1,
        &mut options,
        true,
    )
    .unwrap();
    let mut c = ScopeState::default();
    let mut other = Clock::with_now("RSC", None, fixed_now);
    pull(
        &mut c,
        &folder,
        "app",
        &mut other,
        fixed_now() + 2,
        &ScopeOptions::default(),
    )
    .unwrap();
    assert_eq!(c.records, b.records);
    if let Ok(out) = std::env::var("ARDIA_SYNC_INTEROP_OUT") {
        let files: serde_json::Map<String, Value> = folder
            .files
            .borrow()
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        let records = serde_json::to_value(&b.records).unwrap();
        std::fs::write(
            out,
            serde_json::to_string(&json!({"files": files, "records": records})).unwrap(),
        )
        .unwrap();
    }
}
