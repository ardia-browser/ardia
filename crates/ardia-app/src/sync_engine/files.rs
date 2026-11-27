use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ardia_state::sync::SyncDoc;
use ardia_state::sync_engine::scope::{LogFile, ScopeState};
use ardia_state::sync_engine::sync_core::SyncKeys;
use ardia_state::sync_engine::{Clock, js_json, restore_journal};
use ardia_state::sync_engine::{IndexMap, apply_batches};
use base64::Engine;
use serde_json::{Map, Value, json};

use super::keys::KeyState;

pub const DOC: &str = "sync.json";
pub const STATE: &str = "sync-state.nns";
pub const JOURNAL: &str = "sync-journal.nns";
pub const APP_SCOPE: &str = "app";
const LOCAL_FILE_ID: &str = "state";
const CHECKPOINT_VERSION: u64 = 1;
const PART_VERSION: u64 = 1;
const STATE_EVERY_MS: i64 = 60 * 60_000;
const JOURNAL_BYTES_LIMIT: u64 = 1_000_000;
const JOURNAL_PARTS_LIMIT: usize = 400;
const DOC_IDLE_MS: i64 = 5 * 60_000;
const APPLYING_HOLD_MS: i64 = 2 * 60_000;

pub fn profile_scope(sync_id: &str) -> String {
    format!("p:{sync_id}")
}

pub fn journal_part(n: usize) -> String {
    format!("sync-journal-{n}.nns")
}

pub type Scopes = IndexMap<String, ScopeState>;

pub fn seal_local(keys: &SyncKeys, text: &str) -> Option<String> {
    keys.seal_local(text.as_bytes(), LOCAL_FILE_ID)
        .ok()
        .map(|sealed| base64::engine::general_purpose::STANDARD.encode(sealed))
}

pub fn open_local(keys: &SyncKeys, held: &KeyState, sealed: &str) -> Option<String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(sealed.trim())
        .ok()?;
    let plain = keys.open_local(&data, LOCAL_FILE_ID).ok()?;
    match super::vault::hide_legacy_passwords(&plain, keys) {
        Some(json) => Some(json),
        None => {
            held.mark_local_unreadable();
            None
        }
    }
}

fn read_text(dir: &Path, name: &str) -> Option<String> {
    std::fs::read_to_string(dir.join(name))
        .ok()
        .filter(|t| !t.is_empty())
}

fn write_text(dir: &Path, name: &str, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let target = dir.join(name);
    let temp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, text)?;
    std::fs::File::open(&temp).and_then(|f| f.sync_all())?;
    std::fs::rename(&temp, target)
}

fn versioned(mut fields: Map<String, Value>, field: &str, version: u64) -> String {
    fields.insert(field.to_owned(), version.into());
    js_json(&Value::Object(fields))
}

fn upgraded(value: Value, field: &str, version: u64) -> Option<Map<String, Value>> {
    let Value::Object(map) = value else {
        return None;
    };
    let at = match map.get(field) {
        None => 0,
        Some(v) => v.as_u64()?,
    };
    (at <= version).then_some(map)
}

#[derive(Default)]
struct JournalParts {
    batches: BTreeMap<String, Vec<LogFile>>,
    parts: Option<usize>,
    bytes: u64,
    legacy: bool,
    last_id: i64,
}

#[derive(Default)]
struct StateFile {
    json: String,
    on_disk: bool,
    loaded: bool,
    saved_at: i64,
    wanted: bool,
}

#[derive(Default)]
struct DocFile {
    json: String,
    lasting: String,
    saved_at: i64,
}

pub struct SyncFiles {
    dir: PathBuf,
    keys: Arc<KeyState>,
    doc_file: DocFile,
    journal: JournalParts,
    state: StateFile,
    written_rest: HashMap<String, String>,
    holding_applying: bool,
    held_since: Option<i64>,
}

pub fn doc_meta_value(doc: &SyncDoc, scopes: &Scopes, keep_synced_at: bool) -> Map<String, Value> {
    let mut value = match doc.to_value() {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    value.shift_remove("v");
    if !keep_synced_at {
        value.insert("lastSyncedAt".into(), Value::Null);
    }
    let seqs: Map<String, Value> = scopes
        .iter()
        .map(|(k, s)| (k.clone(), Value::from(s.written_seq())))
        .collect();
    value.insert("seqs".into(), Value::Object(seqs));
    value
}

impl SyncFiles {
    pub fn new(dir: &Path, keys: Arc<KeyState>) -> Self {
        SyncFiles {
            dir: dir.to_path_buf(),
            keys,
            doc_file: DocFile::default(),
            journal: JournalParts::default(),
            state: StateFile::default(),
            written_rest: HashMap::new(),
            holding_applying: false,
            held_since: None,
        }
    }

    pub fn read_doc(&mut self) -> Option<SyncDoc> {
        let json = read_text(&self.dir, DOC)?;
        let value: Value = serde_json::from_str(&json).ok()?;
        let map = upgraded(value, "v", ardia_state::sync::DOCUMENT_VERSION)?;
        self.doc_file.json = json;
        Some(SyncDoc::from_value(&Value::Object(map)))
    }

    fn open_sealed(&self, sealed: Option<String>) -> Option<String> {
        let keys = self.keys.keys()?;
        open_local(&keys, &self.keys, &sealed?)
    }

    fn read_journal(&mut self) -> Vec<Map<String, Value>> {
        let mut found = Vec::new();
        let legacy = read_text(&self.dir, JOURNAL);
        self.journal.legacy = legacy.is_some();
        self.journal.bytes = legacy.as_ref().map_or(0, |l| l.len() as u64);
        let mut take = |me: &Self, sealed: Option<String>| {
            let part = me
                .open_sealed(sealed)
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| upgraded(v, "version", PART_VERSION))
                .unwrap_or_default();
            found.push(part);
        };
        take(self, legacy);
        self.journal.parts = Some(0);
        let mut n = 1;
        while let Some(part) = read_text(&self.dir, &journal_part(n)) {
            self.journal.parts = Some(n);
            self.journal.bytes += part.len() as u64;
            take(self, Some(part));
            n += 1;
        }
        found
    }

    pub fn load_state(&mut self, doc: &mut SyncDoc) -> Scopes {
        let sealed = read_text(&self.dir, STATE);
        let on_disk = sealed.is_some();
        let checkpoint = self
            .open_sealed(sealed)
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| upgraded(v, "version", CHECKPOINT_VERSION))
            .map(|mut map| {
                if !map.get("covers").is_some_and(Value::is_number) {
                    let scopes = Value::Object(map.clone());
                    map = Map::new();
                    map.insert("covers".into(), json!(-1));
                    map.insert("scopes".into(), scopes);
                }
                map
            })
            .unwrap_or_default();
        let covers = checkpoint
            .get("covers")
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        let mut scopes: Scopes = checkpoint
            .get("scopes")
            .and_then(Value::as_object)
            .map(|all| {
                all.iter()
                    .filter_map(|(name, scope)| {
                        ScopeState::from_value(scope).map(|s| (name.clone(), s))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let parts = self.read_journal();
        let device = doc.device_id.clone().unwrap_or_default();
        let live: HashSet<String> = std::iter::once(APP_SCOPE.to_owned())
            .chain(doc.profiles.values().map(|l| profile_scope(&l.sync_id)))
            .collect();
        let mut clock = Clock::new(&device, doc.clock.as_deref());
        if let Some(saved) = checkpoint.get("clock").and_then(Value::as_str) {
            clock.observe(saved);
        }
        let mut batches: BTreeMap<String, Vec<LogFile>> = BTreeMap::new();
        let mut added: HashMap<String, HashSet<String>> = HashMap::new();
        let mut assembly = apply_batches::Assembly::default();
        self.journal.last_id = covers.max(0);
        for part in &parts {
            let id = part.get("id").and_then(Value::as_i64).unwrap_or(0);
            self.journal.last_id = self.journal.last_id.max(id);
            if id <= covers {
                continue;
            }
            if let Some(journal) = part.get("journal").and_then(Value::as_object) {
                for (scope, files) in journal {
                    let list = batches.entry(scope.clone()).or_default();
                    let ids = added.entry(scope.clone()).or_default();
                    for file in files.as_array().into_iter().flatten() {
                        let Ok(file) = serde_json::from_value::<LogFile>(file.clone()) else {
                            continue;
                        };
                        if ids.insert(format!("{}:{}", file.device, file.seq)) {
                            list.push(file);
                        }
                    }
                }
            }
            if (part.get("changes").is_none() && part.get("applying").is_none())
                || part.get("device").and_then(Value::as_str) != doc.device_id.as_deref()
            {
                continue;
            }
            if let Some(c) = part.get("clock").and_then(Value::as_str) {
                clock.observe(c);
            }
            if let Some(changes) = part.get("changes").and_then(Value::as_object) {
                replay_changes(&mut scopes, changes, &live);
            }
            if let Some(applying) = part.get("applying") {
                apply_batches::replay_applying(&mut scopes, applying, &live, &mut assembly);
            }
        }
        self.journal.batches = batches
            .into_iter()
            .filter_map(|(scope, files)| {
                let mine: Vec<LogFile> = files
                    .into_iter()
                    .filter(|f| Some(&f.device) == doc.device_id.as_ref())
                    .collect();
                (!mine.is_empty()).then_some((scope, mine))
            })
            .collect();
        let seqs: BTreeMap<String, u64> = doc
            .extra
            .get("seqs")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_u64().map(|n| (k.clone(), n)))
                    .collect()
            })
            .unwrap_or_default();
        let names: Vec<String> = seqs
            .keys()
            .cloned()
            .chain(self.journal.batches.keys().cloned())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        for scope in names {
            let state = scopes.entry(scope.clone()).or_default();
            let batches = self
                .journal
                .batches
                .get(&scope)
                .cloned()
                .unwrap_or_default();
            restore_journal(
                state,
                &batches,
                &mut clock,
                seqs.get(&scope).copied().unwrap_or(0),
            );
        }
        for scoped in scopes.values() {
            for record in scoped.records.values() {
                clock.observe(&record.h);
            }
        }
        if doc.device_id.is_some() {
            doc.clock = Some(clock.last());
        }
        self.written_rest = scopes
            .iter()
            .map(|(name, s)| (name.clone(), js_json(&s.rest_value())))
            .collect();
        self.state = StateFile {
            json: String::new(),
            on_disk,
            loaded: true,
            saved_at: ardia_state::store::now_ms(),
            wanted: false,
        };
        scopes
    }

    fn counted_parts(&mut self) -> usize {
        if let Some(n) = self.journal.parts {
            return n;
        }
        let mut n = 0;
        while self.dir.join(journal_part(n + 1)).exists() {
            n += 1;
        }
        self.journal.parts = Some(n);
        n
    }

    fn write_part(&mut self, part: Map<String, Value>) -> Result<(), String> {
        let id = (self.journal.last_id + 1).max(ardia_state::store::now_ms());
        self.journal.last_id = id;
        let mut part = part;
        part.insert("id".into(), id.into());
        let keys = self.keys.keys().ok_or("Sync isn't set up on this Mac.")?;
        if self.keys.local_unreadable() {
            return Err(
                "This Mac's sync state couldn't be read safely, so sync is paused to keep it."
                    .into(),
            );
        }
        let sealed =
            seal_local(&keys, &versioned(part, "version", PART_VERSION)).ok_or("sealing failed")?;
        let n = self.counted_parts() + 1;
        write_text(&self.dir, &journal_part(n), &sealed).map_err(|e| e.to_string())?;
        self.journal.parts = Some(n);
        self.journal.bytes += sealed.len() as u64;
        Ok(())
    }

    pub fn persist_applying(
        &mut self,
        scope: &str,
        device: Option<&str>,
        batch: &apply_batches::ApplyBatch,
    ) -> Result<(), String> {
        for chunk in apply_batches::chunks_of(batch) {
            let mut applying = Map::new();
            applying.insert(scope.to_owned(), Value::Array(vec![chunk]));
            let mut part = Map::new();
            part.insert(
                "device".into(),
                device.map_or(Value::Null, |d| Value::String(d.to_owned())),
            );
            part.insert("applying".into(), Value::Object(applying));
            self.write_part(part)?;
        }
        Ok(())
    }

    pub fn persist_journal(&mut self, scope: &str, batches: &[LogFile]) -> Result<(), String> {
        let list = self.journal.batches.entry(scope.to_owned()).or_default();
        let known: HashSet<u64> = list.iter().map(|f| f.seq).collect();
        let fresh: Vec<LogFile> = batches
            .iter()
            .filter(|f| !known.contains(&f.seq))
            .cloned()
            .collect();
        if fresh.is_empty() {
            return Ok(());
        }
        list.extend(fresh.iter().cloned());
        let mut journal = Map::new();
        journal.insert(
            scope.to_owned(),
            serde_json::to_value(&fresh).unwrap_or(Value::Null),
        );
        let mut part = Map::new();
        part.insert("journal".into(), Value::Object(journal));
        if let Err(problem) = self.write_part(part) {
            let failed: HashSet<u64> = fresh.iter().map(|f| f.seq).collect();
            if let Some(list) = self.journal.batches.get_mut(scope) {
                list.retain(|f| !failed.contains(&f.seq));
                if list.is_empty() {
                    self.journal.batches.remove(scope);
                }
            }
            return Err(problem);
        }
        Ok(())
    }

    pub fn journal_scope_changes(
        &mut self,
        scope: &str,
        state: &mut ScopeState,
        device: Option<&str>,
        clock: &Clock,
    ) {
        let (records, base) = state.take_touched();
        let rest = state.rest_value();
        let rest_json = js_json(&rest);
        if records.is_empty() && base.is_empty() && self.written_rest.get(scope) == Some(&rest_json)
        {
            return;
        }
        let record_entries: Map<String, Value> = records
            .iter()
            .map(|k| {
                (
                    k.clone(),
                    state.records.get(k).map_or(Value::Null, |r| {
                        serde_json::to_value(r).unwrap_or(Value::Null)
                    }),
                )
            })
            .collect();
        let base_entries: Map<String, Value> = base
            .iter()
            .map(|k| {
                (
                    k.clone(),
                    state
                        .base
                        .get(k)
                        .map_or(Value::Null, |j| Value::String(j.clone())),
                )
            })
            .collect();
        let mut change = Map::new();
        change.insert("records".into(), Value::Object(record_entries));
        change.insert("base".into(), Value::Object(base_entries));
        change.insert("rest".into(), rest);
        let mut changes = Map::new();
        changes.insert(scope.to_owned(), Value::Object(change));
        let mut part = Map::new();
        part.insert(
            "device".into(),
            device.map_or(Value::Null, |d| Value::String(d.to_owned())),
        );
        part.insert("clock".into(), Value::String(clock.last()));
        part.insert("changes".into(), Value::Object(changes));
        match self.write_part(part) {
            Ok(()) => {
                self.written_rest.insert(scope.to_owned(), rest_json);
            }
            Err(problem) => {
                log::warn!("[sync] couldn't journal this cycle's changes: {problem}");
                self.state.wanted = true;
            }
        }
    }

    fn clear_journal(&mut self) {
        self.journal.batches.clear();
        for n in (1..=self.counted_parts()).rev() {
            let _ = std::fs::remove_file(self.dir.join(journal_part(n)));
        }
        if self.journal.legacy {
            let _ = write_text(&self.dir, JOURNAL, "");
        }
        self.journal.parts = Some(0);
        self.journal.bytes = 0;
        self.journal.legacy = false;
    }

    fn drop_covered_batches(&mut self, seqs: &BTreeMap<String, u64>) {
        self.journal.batches.retain(|scope, list| {
            list.retain(|f| f.seq > seqs.get(scope).copied().unwrap_or(0));
            !list.is_empty()
        });
        if self.journal.batches.is_empty() {
            self.clear_journal();
        }
    }

    pub fn save_doc(&mut self, doc: &SyncDoc, scopes: &Scopes) {
        let json = versioned(
            doc_meta_value(doc, scopes, true),
            "v",
            ardia_state::sync::DOCUMENT_VERSION,
        );
        if json == self.doc_file.json {
            return;
        }
        let lasting = versioned(
            doc_meta_value(doc, scopes, false),
            "v",
            ardia_state::sync::DOCUMENT_VERSION,
        );
        let now = ardia_state::store::now_ms();
        if lasting == self.doc_file.lasting && now - self.doc_file.saved_at < DOC_IDLE_MS {
            return;
        }
        if let Err(problem) = write_text(&self.dir, DOC, &json) {
            log::warn!("[sync] couldn't save sync.json: {problem}");
            return;
        }
        self.doc_file = DocFile {
            json,
            lasting,
            saved_at: now,
        };
    }

    fn state_due(&mut self) -> bool {
        if self.state.wanted {
            return true;
        }
        if !self.state.loaded {
            return false;
        }
        if self.holding_applying {
            let since = *self
                .held_since
                .get_or_insert_with(ardia_state::store::now_ms);
            if ardia_state::store::now_ms() - since < APPLYING_HOLD_MS {
                return false;
            }
        }
        self.held_since = None;
        self.counted_parts() >= JOURNAL_PARTS_LIMIT
            || self.journal.bytes >= JOURNAL_BYTES_LIMIT
            || ardia_state::store::now_ms() - self.state.saved_at >= STATE_EVERY_MS
    }

    pub fn save_state(&mut self, doc: &SyncDoc, scopes: &Scopes, clock: Option<&Clock>) {
        if !doc.enabled {
            if self.state.on_disk || self.state.wanted {
                let _ = write_text(&self.dir, STATE, "");
            }
            self.state.json.clear();
            self.state.on_disk = false;
            self.state.wanted = false;
            return;
        }
        self.holding_applying = apply_batches::holds_applying(scopes.values());
        if !self.state_due() {
            return;
        }
        self.state.wanted = false;
        self.state.loaded = true;
        let covers = self.journal.last_id;
        let seqs: BTreeMap<String, u64> = scopes.iter().map(|(k, s)| (k.clone(), s.seq)).collect();
        let scope_json = {
            let all: Map<String, Value> = scopes
                .iter()
                .map(|(k, s)| (k.clone(), s.to_value()))
                .collect();
            js_json(&Value::Object(all))
        };
        let mut seen = Clock::new("", doc.clock.as_deref());
        if let Some(clock) = clock {
            seen.observe(&clock.last());
        }
        if scope_json != self.state.json {
            let Some(keys) = self.keys.keys() else { return };
            if self.keys.local_unreadable() {
                return;
            }
            let text = format!(
                "{{\"covers\":{covers},\"clock\":{},\"scopes\":{scope_json},\"version\":{CHECKPOINT_VERSION}}}",
                js_json(&Value::String(seen.last()))
            );
            let Some(sealed) = seal_local(&keys, &text) else {
                return;
            };
            if let Err(problem) = write_text(&self.dir, STATE, &sealed) {
                log::warn!("[sync] couldn't save the sync state: {problem}");
                return;
            }
            self.state.json = scope_json;
            self.state.on_disk = true;
        }
        self.state.saved_at = ardia_state::store::now_ms();
        self.drop_covered_batches(&seqs);
    }

    pub fn save(&mut self, doc: &SyncDoc, scopes: &Scopes, clock: Option<&Clock>) {
        self.save_doc(doc, scopes);
        self.save_state(doc, scopes, clock);
    }

    pub fn start_over(&mut self, doc: &SyncDoc, scopes: &Scopes) {
        self.save_doc(doc, scopes);
        self.clear_journal();
        self.state.wanted = true;
        self.save_state(doc, scopes, None);
    }

    pub fn checkpoint(&mut self, doc: &SyncDoc, scopes: &Scopes, clock: Option<&Clock>) {
        self.save_doc(doc, scopes);
        if self.state.loaded && doc.enabled {
            self.state.wanted = true;
        }
        self.save_state(doc, scopes, clock);
    }
}

fn replay_changes(scopes: &mut Scopes, changes: &Map<String, Value>, live: &HashSet<String>) {
    for (scope, change) in changes {
        if !live.contains(scope) {
            continue;
        }
        let before = scopes.shift_remove(scope).unwrap_or_default();
        let mut records = before.records.clone();
        let mut base = before.base.clone();
        for (key, record) in change
            .get("records")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            match serde_json::from_value(record.clone()) {
                Ok(parsed) if !record.is_null() => {
                    records.insert(key.clone(), parsed);
                }
                _ => {
                    records.shift_remove(key);
                }
            }
        }
        for (key, json) in change
            .get("base")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            match json.as_str() {
                Some(text) => {
                    base.insert(key.clone(), text.to_owned());
                }
                None => {
                    base.shift_remove(key);
                }
            }
        }
        let mut rest = change
            .get("rest")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let applying = apply_batches::batches_from_rest(&rest, before.applying.as_ref());
        rest.shift_remove("applying");
        rest.shift_remove("applyingIds");
        rest.shift_remove("applyingTrimmed");
        rest.insert("records".into(), json!({}));
        rest.insert("base".into(), json!({}));
        let mut scoped = ScopeState::from_value(&Value::Object(rest)).unwrap_or_default();
        scoped.records = records;
        scoped.base = base;
        scoped.applying = applying;
        scopes.insert(scope.clone(), scoped);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::sync_engine::scope::{Op, SyncRecord};

    fn keys() -> Arc<KeyState> {
        let state = KeyState::default();
        state.set(Some(&[9u8; 32]));
        Arc::new(state)
    }

    #[test]
    fn the_local_state_round_trips_through_checkpoint_and_journal() {
        let dir = tempfile::tempdir().unwrap();
        let held = keys();
        let mut doc = SyncDoc {
            enabled: true,
            device_id: Some("DEV".into()),
            ..SyncDoc::default()
        };
        let mut files = SyncFiles::new(dir.path(), held.clone());
        let mut scopes = files.load_state(&mut doc);
        let app = scopes.entry(APP_SCOPE.to_owned()).or_default();
        app.track_touched();
        app.put_record(
            "dev:DEV",
            SyncRecord {
                h: "a".into(),
                v: json!({"n": "Mac"}),
                o: ("DEV".into(), 1),
            },
        );
        app.put_base("dev:DEV", "{\"n\":\"Mac\"}".into());
        let clock = Clock::new("DEV", None);
        let mut app = scopes.shift_remove(APP_SCOPE).unwrap();
        files.journal_scope_changes(APP_SCOPE, &mut app, Some("DEV"), &clock);
        scopes.insert(APP_SCOPE.to_owned(), app);
        let batch = LogFile {
            v: 1,
            kind: "log".into(),
            device: "DEV".into(),
            seq: 1,
            at: 5,
            ops: vec![Op {
                k: "dev:DEV".into(),
                h: "a".into(),
                v: json!({"n": "Mac"}),
            }],
        };
        files
            .persist_journal(APP_SCOPE, std::slice::from_ref(&batch))
            .unwrap();
        files.save_doc(&doc, &scopes);
        assert!(
            dir.path().join(journal_part(1)).exists() && dir.path().join(journal_part(2)).exists()
        );
        let mut reread_doc = SyncFiles::new(dir.path(), held.clone()).read_doc().unwrap();
        let mut again = SyncFiles::new(dir.path(), held.clone());
        let loaded = again.load_state(&mut reread_doc);
        let app = &loaded[APP_SCOPE];
        assert_eq!(app.records["dev:DEV"].v, json!({"n": "Mac"}));
        assert_eq!(app.base["dev:DEV"], "{\"n\":\"Mac\"}");
        assert_eq!(app.journal.as_ref().map(Vec::len), Some(1));
        again.checkpoint(&reread_doc, &loaded, None);
        let sealed = std::fs::read_to_string(dir.path().join(STATE)).unwrap();
        let text = open_local(&held.keys().unwrap(), &held, &sealed).unwrap();
        assert!(text.starts_with("{\"covers\":"));
        assert!(text.ends_with(",\"version\":1}"));
        let other = KeyState::default();
        other.set(Some(&[1u8; 32]));
        assert!(open_local(&other.keys().unwrap(), &other, &sealed).is_none());
    }
}
