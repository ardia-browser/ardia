use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use ardia_state::sync_engine::apply_batches::{ApplyBatch, valid_batches};
use ardia_state::sync_engine::scope::{
    Adapter, ApplyRecords, ExtractContext, Extraction, Listing, ScopeOptions, ScopeState,
    SyncRecord, SyncScopeArgs, Transport, TransportError, sync_scope,
};
use ardia_state::sync_engine::{Clock, IndexMap, IndexSet, canonical};
use serde_json::{Value, json};

struct Empty;

impl Transport for Empty {
    fn write(&self, _scope: &str, _payload: &str) -> Result<String, TransportError> {
        Ok("zzzzzzzzzzzzzzzzzzzzzzzzzz".into())
    }

    fn read(&self, _scope: &str, _known: &[String]) -> Result<Listing, TransportError> {
        Ok(Listing::default())
    }

    fn remove(&self, _scope: &str, _ids: &[String]) -> Result<(), TransportError> {
        Ok(())
    }
}

struct Kv {
    local: Rc<RefCell<IndexMap<String, Value>>>,
    applied: Rc<RefCell<Vec<String>>>,
}

impl Adapter for Kv {
    fn prefix(&self) -> &str {
        "kv:"
    }

    fn extract(&mut self, _cx: &ExtractContext) -> Option<Extraction> {
        Some(Extraction::of(self.local.borrow().clone()))
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        self.applied.borrow_mut().extend(changed.iter().cloned());
        *self.local.borrow_mut() = visible.clone();
        true
    }
}

fn now() -> i64 {
    1_795_000_000_000
}

fn crashed_state(landed: bool) -> (ScopeState, Rc<RefCell<IndexMap<String, Value>>>) {
    let mut state = ScopeState {
        joined: true,
        ..ScopeState::default()
    };
    let old = json!({"n": "old"});
    let new = json!({"n": "new"});
    state.put_record(
        "kv:a",
        SyncRecord {
            h: "0mwwsalis.0000.REMOTE".into(),
            v: new.clone(),
            o: ("REMOTE".into(), 1),
        },
    );
    state.put_base("kv:a", canonical(&old));
    let batch = json!([{ "id": now() - 5, "p": "kv:", "l": "an-earlier-launch", "at": now() - 5, "k": { "kv:a": [canonical(&old), canonical(&new)] } }]);
    state.applying = Some(valid_batches(Some(&batch)));
    let local = IndexMap::from([("kv:a".to_owned(), if landed { new } else { old })]);
    (state, Rc::new(RefCell::new(local)))
}

fn cycle(
    state: &mut ScopeState,
    local: Rc<RefCell<IndexMap<String, Value>>>,
    journal: &Rc<RefCell<Vec<ApplyBatch>>>,
) -> (usize, Vec<String>) {
    let applied = Rc::new(RefCell::new(Vec::new()));
    let mut adapters: Vec<Box<dyn Adapter>> = vec![Box::new(Kv {
        local,
        applied: applied.clone(),
    })];
    let mut clock = Clock::with_now("ME", None, now);
    let now = now;
    let sink = journal.clone();
    let options = ScopeOptions {
        persist_applying: Some(Box::new(move |batch: &ApplyBatch| {
            sink.borrow_mut().push(batch.clone());
            Ok(())
        })),
        ..ScopeOptions::default()
    };
    let result = sync_scope(SyncScopeArgs {
        scope: "app",
        state,
        transport: &Empty,
        adapters: &mut adapters,
        clock: &mut clock,
        device: "ME",
        now: &now,
        options,
    })
    .unwrap();
    let out = applied.borrow().clone();
    (result.published, out)
}

#[test]
fn a_batch_that_landed_before_a_crash_is_settled_without_republishing() {
    let (mut state, local) = crashed_state(true);
    let journal = Rc::new(RefCell::new(Vec::new()));
    let (published, applied) = cycle(&mut state, local.clone(), &journal);
    assert_eq!(
        published, 0,
        "the landed value must not go out as a local edit"
    );
    assert_eq!(applied, vec!["kv:a".to_owned()]);
    assert_eq!(state.base["kv:a"], canonical(&json!({"n": "new"})));
    assert!(
        state.applying.is_none()
            || state.applying.as_ref().is_some_and(|l| l
                .iter()
                .all(|b| b.l != "an-earlier-launch" || b.r.is_some()))
    );
    assert_eq!(local.borrow()["kv:a"], json!({"n": "new"}));
}

#[test]
fn a_batch_that_never_landed_is_applied_again_and_old_values_are_not_published() {
    let (mut state, local) = crashed_state(false);
    let journal = Rc::new(RefCell::new(Vec::new()));
    let (published, _) = cycle(&mut state, local.clone(), &journal);
    assert_eq!(published, 0);
    assert_eq!(local.borrow()["kv:a"], json!({"n": "new"}));
    assert_eq!(state.records["kv:a"].v, json!({"n": "new"}));
}

#[test]
fn applies_are_journalled_first_and_saved_scopes_keep_old_batches() {
    let mut state = ScopeState {
        joined: true,
        ..ScopeState::default()
    };
    state.put_record(
        "kv:b",
        SyncRecord {
            h: "0mwwsalis.0000.REMOTE".into(),
            v: json!(1),
            o: ("REMOTE".into(), 1),
        },
    );
    state.unapplied.push("kv:b".into());
    let journal = Rc::new(RefCell::new(Vec::new()));
    let local = Rc::new(RefCell::new(IndexMap::new()));
    cycle(&mut state, local, &journal);
    let written = journal.borrow();
    assert_eq!(written.len(), 1);
    assert_eq!(written[0].k["kv:b"], (None, Some("1".to_owned())));
    let saved = state.to_value();
    let back = ScopeState::from_value(&saved).unwrap();
    assert_eq!(
        back.applying.as_ref().map(Vec::len),
        state.applying.as_ref().map(Vec::len)
    );
    let old_app = json!({"records": {}, "base": {}, "applying": [{"id": 5, "p": "pin:", "l": "x", "at": 5, "r": 1, "k": {"pin:t:a": ["{\"u\":1}", null]}}, {"bad": true}], "applyingIds": [5]});
    let read = ScopeState::from_value(&old_app).unwrap();
    let batches = read.applying.unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].k["pin:t:a"], (Some("{\"u\":1}".into()), None));
    let ids: HashSet<i64> = batches.iter().map(|b| b.id).collect();
    assert!(ids.contains(&5));
}
