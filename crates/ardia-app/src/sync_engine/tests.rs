use std::path::{Path, PathBuf};
use std::sync::Arc;

use ardia_state::actions::Action;
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::sync_engine::sync_core::{SyncKeys, vault as core_vault};
use ardia_state::{BrowserState, BrowserStore, ProfileId};
use ardia_ui::sync_api::{PhraseProblem, SyncState};
use serde_json::Value;

use super::adapters::DeviceDetails;
use super::keys::FileKeyStore;
use super::vault::{PlainFolders, Vault};
use super::{SyncEngine, TurnOnError};

struct Mac {
    engine: Arc<SyncEngine>,
    store: Arc<BrowserStore>,
    _data: tempfile::TempDir,
}

fn store(launch: &str) -> Arc<BrowserStore> {
    Arc::new(BrowserStore::in_memory(
        BrowserState::from_session(
            SessionData::fresh(LoadOptions::default()),
            1_795_000_000_000,
        ),
        IdGen::with_launch(launch),
    ))
}

fn mac(name: &str) -> Mac {
    let data = tempfile::tempdir().unwrap();
    let store = store(name);
    let engine = SyncEngine::with_parts(
        data.path(),
        true,
        store.clone(),
        None,
        Box::new(FileKeyStore::new(data.path())),
        Arc::new(PlainFolders),
        name.to_owned(),
        DeviceDetails {
            version: Some("0.3.0".into()),
            os: Some("macOS 26.1".into()),
        },
    );
    engine.prepare();
    Mac {
        engine,
        store,
        _data: data,
    }
}

fn reopen(data: &Path, store: Arc<BrowserStore>, name: &str) -> Arc<SyncEngine> {
    let engine = SyncEngine::with_parts(
        data,
        true,
        store,
        None,
        Box::new(FileKeyStore::new(data)),
        Arc::new(PlainFolders),
        name.to_owned(),
        DeviceDetails::default(),
    );
    engine.prepare();
    engine
}

fn cycle(macs: &[&Mac]) {
    for mac in macs {
        mac.engine.run_cycle_now(false, false);
    }
}

fn folder_files(folder: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![folder.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out
}

fn add_tab(mac: &Mac, url: &str) -> ardia_state::TabId {
    let outcome = mac
        .store
        .dispatch(Action::OpenWindow {
            kind: ardia_state::windows::WindowKind::Main,
            profile: Some(ProfileId::new("default")),
            url: Some(url.to_owned()),
            frame: None,
        })
        .unwrap();
    let window = outcome.window.unwrap();
    let state = mac.store.snapshot();
    state.windows[&window].tab_ids.first().cloned().unwrap()
}

#[test]
fn two_macs_pair_through_a_temporary_folder_and_send_a_tab() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().to_string_lossy().into_owned();
    let a = mac("Ann’s MacBook Pro");
    let b = mac("Office Mac mini");

    a.engine.turn_on(&path).unwrap();
    assert_eq!(a.engine.published().status.state, SyncState::Starting);
    cycle(&[&a]);
    assert_eq!(a.engine.published().status.state, SyncState::Updated);
    let words = a.engine.recovery_words().unwrap();
    assert_eq!(words.len(), 24);

    let stranger = ardia_state::sync_engine::sync_core::phrase::phrase(&[5u8; 32]);
    assert_eq!(
        b.engine.enter_phrase(&path, &stranger),
        Err(PhraseProblem::Mismatch)
    );
    let mut swapped = words.clone();
    swapped.swap(0, 1);
    if swapped != words {
        assert_eq!(
            b.engine.enter_phrase(&path, &swapped.join(" ")),
            Err(PhraseProblem::Checksum)
        );
    }
    assert_eq!(
        b.engine.enter_phrase(&path, &words[..23].join(" ")),
        Err(PhraseProblem::WordCount(23))
    );
    let mut unknown = words.clone();
    unknown[3] = "qqqqzz".into();
    assert_eq!(
        b.engine.enter_phrase(&path, &unknown.join(" ")),
        Err(PhraseProblem::UnknownWord("qqqqzz".into()))
    );
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(
        b.engine
            .enter_phrase(&empty.path().to_string_lossy(), &words.join(" ")),
        Err(PhraseProblem::NoData)
    );
    let numbered: String = words
        .iter()
        .enumerate()
        .map(|(i, w)| format!("{}. {}\n", i + 1, w.to_uppercase()))
        .collect();
    b.engine.enter_phrase(&path, &numbered).unwrap();
    assert!(b.engine.published().joining);

    cycle(&[&b, &a, &b, &a]);
    let a_view = a.engine.published();
    let b_view = b.engine.published();
    assert!(!b_view.joining);
    assert_eq!(a_view.view.devices.len(), 2, "{:?}", a_view.view.devices);
    assert_eq!(b_view.view.devices.len(), 2);
    assert!(a_view.view.devices[0].current && a_view.view.devices[0].name == "Ann’s MacBook Pro");
    assert_eq!(a_view.view.devices[1].version.as_deref(), Some("0.3.0"));
    let a_link = a
        .engine
        .doc
        .lock()
        .profiles
        .get("default")
        .cloned()
        .unwrap();
    let b_link = b
        .engine
        .doc
        .lock()
        .profiles
        .get("default")
        .cloned()
        .unwrap();
    assert_eq!(a_link.sync_id, b_link.sync_id);

    let default = ProfileId::new("default");
    let b_id = b_view.device_id.unwrap();
    let targets = a_view
        .view
        .send_targets
        .get(&default)
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        targets.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
        vec![b_id.clone()]
    );
    assert_eq!(targets[0].name, "Office Mac mini");

    let tab = add_tab(&a, "https://example.com/sent");
    assert!(a.engine.send_tab(&tab, &b_id));
    let before = b.store.snapshot().tabs.len();
    cycle(&[&a, &b]);
    let after = b.store.snapshot();
    assert_eq!(after.tabs.len(), before + 1);
    assert!(
        after
            .tabs
            .values()
            .any(|t| t.url == "https://example.com/sent")
    );
    cycle(&[&b, &a, &b]);
    assert_eq!(
        b.store.snapshot().tabs.len(),
        before + 1,
        "a sent tab opens once"
    );

    let vault = Vault::new(
        folder.path(),
        Arc::new(SyncKeys::new(
            &ardia_state::sync_engine::sync_core::phrase::entropy(&words.join(" ")).unwrap()[..],
        )),
        Arc::new(PlainFolders),
    );
    assert!(vault.chain_exists());
    for file in folder_files(folder.path()) {
        let bytes = std::fs::read(&file).unwrap();
        assert_eq!(&bytes[..4], b"NNS1", "{file:?}");
        assert_eq!((bytes.len() - 4 - 12 - 16) % 1024, 0);
        let text = String::from_utf8_lossy(&bytes);
        for secret in ["example.com", "Ann", "Office", "default", "sent"] {
            assert!(!text.contains(secret), "{secret} in {file:?}");
        }
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            matches!(core_vault::classify(&name), core_vault::Name::File(_)),
            "{name}"
        );
    }

    b.engine.stop(false);
    assert_eq!(b.engine.published().status.state, SyncState::Off);
    assert!(!b.engine.enabled());
    cycle(&[&a]);
    assert_eq!(a.engine.published().view.devices.len(), 1);

    a.engine.stop(true);
    assert!(!vault.chain_exists());
}

#[test]
fn a_restart_keeps_the_synced_state_and_a_missing_key_locks() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().to_string_lossy().into_owned();
    let a = mac("Mac A");
    a.engine.turn_on(&path).unwrap();
    cycle(&[&a, &a]);
    let records = a
        .engine
        .inner
        .lock()
        .scopes
        .get("app")
        .map(|s| s.records.clone())
        .unwrap();
    assert!(records.keys().any(|k| k.starts_with("dev:")));
    a.engine.shutdown();
    let again = reopen(a._data.path(), a.store.clone(), "Mac A");
    let loaded = again
        .inner
        .lock()
        .scopes
        .get("app")
        .map(|s| s.records.clone())
        .unwrap();
    assert_eq!(loaded, records);
    assert_eq!(again.published().status.state, SyncState::Starting);
    let device = again.doc.lock().device_id.clone().unwrap();
    std::fs::remove_file(a._data.path().join(format!("sync-key-{device}"))).unwrap();
    let locked = reopen(a._data.path(), a.store.clone(), "Mac A");
    assert_eq!(locked.published().status.state, SyncState::Locked);
    assert_eq!(
        locked.published().status.error.as_deref(),
        Some("Enter your recovery phrase to keep syncing on this Mac.")
    );
}

#[test]
fn deleting_the_data_elsewhere_resets_this_mac() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().to_string_lossy().into_owned();
    let a = mac("A");
    let b = mac("B");
    a.engine.turn_on(&path).unwrap();
    cycle(&[&a]);
    b.engine
        .enter_phrase(&path, &a.engine.recovery_words().unwrap().join(" "))
        .unwrap();
    cycle(&[&b, &a]);
    a.engine.stop(true);
    cycle(&[&b]);
    let view = b.engine.published();
    assert_eq!(view.status.state, SyncState::Reset);
    assert_eq!(
        view.status.error.as_deref(),
        Some("This device is out of sync. Sync may have been reset from another device.")
    );
    assert!(!view.enabled);
    assert_eq!(view.folder.as_deref(), Some(path.as_str()));
}

#[test]
fn turning_on_in_an_unusable_folder_fails_and_forgets_the_key() {
    let a = mac("A");
    let file = tempfile::NamedTempFile::new().unwrap();
    let inside = file.path().join("x");
    match a.engine.turn_on(&inside.to_string_lossy()) {
        Err(TurnOnError::Folder(_)) => {}
        other => panic!("{other:?}"),
    }
    assert!(a.engine.recovery_words().is_none());
    assert!(!a.engine.enabled());
    assert!(
        TurnOnError::Keychain(super::SECRET_STORE.to_owned())
            .text()
            .ends_with("in your Keychain.")
    );
}

#[test]
fn the_app_vault_reads_the_shared_vector_folder_exactly() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let vectors = repo.join("packages/sync/tests/fixtures/sync-vectors");
    let inputs: Value =
        serde_json::from_str(&std::fs::read_to_string(vectors.join("inputs.json")).unwrap())
            .unwrap();
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(vectors.join("expected.json")).unwrap())
            .unwrap();
    let hex = |text: &str| -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    };
    use base64::Engine;
    for (name, entropy) in inputs["entropies"].as_object().unwrap() {
        let keys = Arc::new(SyncKeys::new(&hex(entropy.as_str().unwrap())));
        let vault = Vault::new(&vectors.join("vault"), keys, Arc::new(PlainFolders));
        assert!(vault.chain_exists());
        for scope in inputs["scopes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap())
        {
            let listing = vault.read_scope(scope, &Default::default()).unwrap();
            let entries = |kind: &str| -> Vec<Value> {
                expected["vault"][kind]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|e| e["entropy"] == *name && e["scope"] == scope)
                    .cloned()
                    .collect()
            };
            let ids = |list: &[Value]| -> Vec<String> {
                let mut ids: Vec<String> = list
                    .iter()
                    .map(|e| e["id"].as_str().unwrap().to_owned())
                    .collect();
                ids.sort();
                ids
            };
            let mut read: Vec<String> = listing.files.iter().map(|(id, _)| id.clone()).collect();
            read.sort();
            assert_eq!(read, ids(&entries("files")));
            for (id, payload) in &listing.files {
                let file = entries("files")
                    .into_iter()
                    .find(|f| f["id"] == *id)
                    .unwrap();
                let raw = base64::engine::general_purpose::STANDARD
                    .decode(
                        inputs["payloads"][file["payload"].as_str().unwrap()]
                            .as_str()
                            .unwrap(),
                    )
                    .unwrap();
                assert_eq!(payload, &String::from_utf8_lossy(&raw));
            }
            let mut damaged: Vec<String> =
                listing.damaged.iter().map(|(id, _)| id.clone()).collect();
            damaged.sort();
            assert_eq!(damaged, ids(&entries("damaged")));
            let mut pending = listing.pending;
            pending.sort();
            assert_eq!(pending, ids(&entries("pending")));
        }
    }
}
