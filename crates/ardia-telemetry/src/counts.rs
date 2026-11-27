use std::collections::BTreeMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::consent::{self, Consent};

pub type Source = Arc<dyn Fn(Option<&Consent>) -> Map<String, Value> + Send + Sync>;

static TALLY: Mutex<BTreeMap<&'static str, u64>> = Mutex::new(BTreeMap::new());
static SOURCES: Mutex<Vec<Source>> = Mutex::new(Vec::new());

pub fn count(field: &'static str) {
    add(field, 1);
}

pub fn add(field: &'static str, by: u64) {
    add_for(consent::consent_now().as_ref(), field, by);
}

pub fn add_for(consent: Option<&Consent>, field: &'static str, by: u64) {
    if by == 0 {
        return;
    }
    consent::counted(consent, || {
        *TALLY.lock().entry(field).or_default() += by;
    });
}

pub fn raise(field: &'static str, to: u64) {
    consent::counted(consent::consent_now().as_ref(), || {
        let mut tally = TALLY.lock();
        let slot = tally.entry(field).or_default();
        *slot = (*slot).max(to);
    });
}

pub fn register_source(
    source: impl Fn(Option<&Consent>) -> Map<String, Value> + Send + Sync + 'static,
) {
    SOURCES.lock().push(Arc::new(source));
}

pub fn drop_counts() {
    TALLY.lock().clear();
    let sources: Vec<Source> = SOURCES.lock().clone();
    for source in sources {
        source(None);
    }
}

pub fn take(consent: Option<&Consent>) -> Map<String, Value> {
    let tally = std::mem::take(&mut *TALLY.lock());
    let sources: Vec<Source> = SOURCES.lock().clone();
    let mut out = Map::new();
    for source in sources {
        for (key, value) in source(consent) {
            out.insert(key, value);
        }
    }
    for (field, n) in tally {
        let merged = out.get(field).and_then(Value::as_u64).unwrap_or(0) + n;
        out.insert(field.to_owned(), json!(merged));
    }
    if consent::still_valid(consent) {
        out
    } else {
        Map::new()
    }
}

pub fn any_nonzero(fields: &Map<String, Value>) -> bool {
    fields.values().any(|value| match value {
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::Bool(flag) => *flag,
        _ => false,
    })
}
