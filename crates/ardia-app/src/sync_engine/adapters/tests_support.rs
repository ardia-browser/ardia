use std::collections::BTreeMap;

use ardia_state::sync_engine::scope::{
    Adapter, Listing, LogFile, Op, ScopeOptions, ScopeState, SyncScopeArgs, Transport,
    TransportError, log_payload, sync_scope,
};
use ardia_state::sync_engine::{Clock, SyncFile, parse_sync_file};
use parking_lot::Mutex;
use serde_json::Value;

#[derive(Default)]
pub struct MemoryTransport {
    files: Mutex<BTreeMap<String, BTreeMap<String, String>>>,
    next: Mutex<u64>,
    injected: Mutex<u64>,
}

impl MemoryTransport {
    fn new_id(&self) -> String {
        let mut next = self.next.lock();
        *next += 1;
        format!("F{:025}", *next)
    }

    pub fn inject(&self, scope: &str, device: &str, ops: Vec<(&str, Value)>) {
        let seq = {
            let mut injected = self.injected.lock();
            *injected += 1;
            *injected
        };
        let file = LogFile {
            v: 1,
            kind: "log".into(),
            device: device.to_owned(),
            seq,
            at: ardia_state::store::now_ms(),
            ops: ops
                .into_iter()
                .map(|(k, v)| Op {
                    k: k.to_owned(),
                    h: ardia_state::sync_engine::format_hlc(
                        ardia_state::store::now_ms(),
                        0,
                        device,
                    ),
                    v,
                })
                .collect(),
        };
        let id = self.new_id();
        self.files
            .lock()
            .entry(scope.to_owned())
            .or_default()
            .insert(id, log_payload(&file));
    }

    pub fn all_ops(&self) -> Vec<(String, Value)> {
        let mut out = Vec::new();
        for payload in self.files.lock().values().flat_map(|scope| scope.values()) {
            match parse_sync_file(payload) {
                Some(SyncFile::Log(log)) => out.extend(log.ops.into_iter().map(|op| (op.k, op.v))),
                Some(SyncFile::Snapshot(snapshot)) => {
                    out.extend(snapshot.records.into_iter().map(|(k, r)| (k, r.v)))
                }
                None => {}
            }
        }
        out
    }
}

impl Transport for MemoryTransport {
    fn write(&self, scope: &str, payload: &str) -> Result<String, TransportError> {
        let id = self.new_id();
        self.files
            .lock()
            .entry(scope.to_owned())
            .or_default()
            .insert(id.clone(), payload.to_owned());
        Ok(id)
    }

    fn read(&self, scope: &str, known: &[String]) -> Result<Listing, TransportError> {
        let files = self.files.lock();
        let mut listing = Listing::default();
        for (id, payload) in files.get(scope).into_iter().flatten() {
            listing.present.push(id.clone());
            if !known.contains(id) {
                listing.files.push((id.clone(), payload.clone()));
            }
        }
        Ok(listing)
    }

    fn remove(&self, scope: &str, ids: &[String]) -> Result<(), TransportError> {
        if let Some(files) = self.files.lock().get_mut(scope) {
            for id in ids {
                files.remove(id);
            }
        }
        Ok(())
    }
}

pub fn run_cycle(
    transport: &MemoryTransport,
    scope: &str,
    state: &mut ScopeState,
    device: &str,
    mut adapters: Vec<Box<dyn Adapter>>,
) {
    let mut clock = Clock::new(device, None);
    for record in state.records.values() {
        clock.observe(&record.h);
    }
    let now = ardia_state::store::now_ms;
    sync_scope(SyncScopeArgs {
        scope,
        state,
        transport,
        adapters: &mut adapters,
        clock: &mut clock,
        device,
        now: &now,
        options: ScopeOptions::default(),
    })
    .expect("the cycle runs");
}
