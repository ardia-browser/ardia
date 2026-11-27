use std::sync::Arc;

use ardia_state::groups::TabGroup;
use ardia_state::model::{TabPage, TabPin, TileFolder};
use ardia_state::persistence::session::SessionData;
use ardia_state::profiles::Profile;
use ardia_state::sync::{ProfileLink, SyncDoc};
use ardia_state::sync_engine::scope::SyncFile;
use ardia_state::sync_engine::scope::{
    Listing, ScopeOptions, ScopeState, SyncScopeArgs, Transport, TransportError, sync_scope,
};
use ardia_state::sync_engine::{Clock, IndexMap, parse_sync_file};
use ardia_state::tabs::Tab;
use ardia_state::windows::{BrowserWindow, WindowKind};
use ardia_state::{BrowserState, BrowserStore, GroupId, ProfileId, TabId, WindowId};
use ardia_theme::ProfileColor;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::open_tabs::{OPEN_TAB, OPEN_TABS_ON, closed_open_tabs};
use crate::sync_engine::adapters::{AdapterMemory, CycleContext, DeviceDetails};
use crate::sync_engine::host::SyncHost;

const NOW: i64 = 1_795_000_000_000;

fn now() -> i64 {
    NOW
}

#[derive(Default)]
struct Folder {
    files: Mutex<Vec<(String, String)>>,
    counter: Mutex<u64>,
}

impl Transport for Folder {
    fn write(&self, _scope: &str, payload: &str) -> Result<String, TransportError> {
        let mut n = self.counter.lock();
        *n += 1;
        let id = format!("f{n}");
        self.files.lock().push((id.clone(), payload.to_owned()));
        Ok(id)
    }

    fn read(&self, _scope: &str, known: &[String]) -> Result<Listing, TransportError> {
        let files = self.files.lock();
        Ok(Listing {
            files: files
                .iter()
                .filter(|(id, _)| !known.contains(id))
                .cloned()
                .collect(),
            pending: Vec::new(),
            damaged: Vec::new(),
            present: files.iter().map(|(id, _)| id.clone()).collect(),
        })
    }

    fn remove(&self, _scope: &str, ids: &[String]) -> Result<(), TransportError> {
        self.files.lock().retain(|(id, _)| !ids.contains(id));
        Ok(())
    }
}

fn profile() -> ProfileId {
    ProfileId::new("default")
}

fn base_state(window: &str, home_url: &str) -> SessionData {
    let mut data = SessionData::default();
    let p = Profile::new(profile(), "Personal", ProfileColor::Plum, NOW);
    data.profiles.insert(profile(), p);
    data.profile_order.push(profile());
    let w = WindowId::new(window);
    let mut win = BrowserWindow::new(w.clone(), WindowKind::Main, profile(), NOW);
    let home = TabId::new(format!("{window}-home"));
    let mut tab = Tab::new(home.clone(), w.clone(), profile(), home_url, NOW);
    tab.page = TabPage::LOADED;
    win.tab_ids.push(home.clone());
    win.active_tab_ids.insert(profile(), home.clone());
    data.tabs.insert(home, tab);
    data.windows.insert(w.clone(), win);
    data.window_order.push(w);
    data
}

fn pin_tab(data: &mut SessionData, window: &str, id: &str, url: &str, pin: Option<TabPin>) {
    let w = WindowId::new(window);
    let mut tab = Tab::new(TabId::new(id), w.clone(), profile(), url, NOW);
    tab.pin = pin;
    tab.pinned_url = Some(url.to_owned());
    data.tabs.insert(TabId::new(id), tab);
    let win = data.windows.get_mut(&w).unwrap();
    let at = win.tab_ids.len() - 1;
    win.tab_ids.insert(at, TabId::new(id));
}

struct Device {
    store: Arc<BrowserStore>,
    cx: CycleContext,
    scope: ScopeState,
    clock: Clock,
    id: String,
}

impl Device {
    fn new(id: &str, data: SessionData) -> Device {
        let state = BrowserState::from_session(data, NOW);
        let store = Arc::new(BrowserStore::in_memory(
            state,
            ardia_state::ids::IdGen::with_launch(id),
        ));
        let mut doc = SyncDoc {
            enabled: true,
            device_id: Some(id.to_owned()),
            ..SyncDoc::default()
        };
        doc.profiles.insert(
            "default".into(),
            ProfileLink {
                sync_id: "S1".into(),
                enabled: true,
                extra: Map::new(),
            },
        );
        let cx = CycleContext {
            host: SyncHost::detached(store.clone()),
            doc: Arc::new(Mutex::new(doc)),
            device_id: id.to_owned(),
            device_name: id.to_owned(),
            app_records: Arc::new(IndexMap::new()),
            memory: Arc::new(Mutex::new(AdapterMemory::default())),
            details: DeviceDetails::default(),
            removed_profile_keys: Arc::new(Default::default()),
            removed_device_keys: Arc::new(Default::default()),
            keys: None,
        };
        Device {
            store,
            cx,
            scope: ScopeState::default(),
            clock: Clock::with_now(id, None, now),
            id: id.to_owned(),
        }
    }

    fn sync(&mut self, folder: &Folder) {
        super::prepare_scope(&self.cx, &profile(), &mut self.scope);
        let mut adapters = super::adapters(&self.cx, &profile(), true);
        let at = || NOW;
        sync_scope(SyncScopeArgs {
            scope: "p:S1",
            state: &mut self.scope,
            transport: folder,
            adapters: &mut adapters,
            clock: &mut self.clock,
            device: &self.id,
            now: &at,
            options: ScopeOptions::default(),
        })
        .unwrap();
    }

    fn state(&self) -> Arc<BrowserState> {
        self.store.snapshot()
    }

    fn edit(&self, edit: impl FnOnce(&mut BrowserState)) {
        let mut next = (*self.state()).clone();
        edit(&mut next);
        self.store.replace(next);
    }

    fn pins_by_key(&self) -> IndexMap<String, Arc<Tab>> {
        let s = self.state();
        s.tabs
            .values()
            .filter(|t| {
                t.pin.is_some()
                    || ardia_state::groups::pinned_group_members(&s.groups).contains(&t.id)
            })
            .map(|t| (t.pin_key().to_owned(), t.clone()))
            .collect()
    }
}

fn logs(folder: &Folder) -> Vec<(String, Vec<String>)> {
    folder
        .files
        .lock()
        .iter()
        .filter_map(|(_, payload)| match parse_sync_file(payload)? {
            SyncFile::Log(log) => Some((
                log.device.clone(),
                log.ops
                    .iter()
                    .map(|op| serde_json::to_string(&json!([op.k, op.v])).unwrap())
                    .collect(),
            )),
            SyncFile::Snapshot(_) => None,
        })
        .collect()
}

fn golden_device() -> SessionData {
    let mut data = base_state("wA", "https://home.example/");
    let folder = |name: &str| {
        Some(TabPin::Tile {
            folder: Some(TileFolder {
                id: "id1".into(),
                name: name.into(),
                renamed_at: Some(NOW),
            }),
        })
    };
    pin_tab(
        &mut data,
        "wA",
        "id3",
        "https://mail.example/",
        Some(TabPin::TILE),
    );
    pin_tab(
        &mut data,
        "wA",
        "id0",
        "https://cal.example/",
        folder("Work"),
    );
    pin_tab(
        &mut data,
        "wA",
        "id2",
        "https://docs.example/",
        folder("Work"),
    );
    pin_tab(
        &mut data,
        "wA",
        "id4",
        "https://news.example/",
        Some(TabPin::TILE),
    );
    pin_tab(
        &mut data,
        "wA",
        "id5",
        "https://row.example/",
        Some(TabPin::Row),
    );
    pin_tab(
        &mut data,
        "wA",
        "id6",
        "https://row2.example/",
        Some(TabPin::Row),
    );
    pin_tab(&mut data, "wA", "id8", "https://g1.example/", None);
    pin_tab(&mut data, "wA", "id9", "https://g2.example/", None);
    let mut group = TabGroup::new(
        GroupId::new("id7"),
        WindowId::new("wA"),
        profile(),
        vec![TabId::new("id8"), TabId::new("id9")],
        NOW,
    );
    group.pinned = true;
    group.name = "Group".into();
    data.groups.insert(GroupId::new("id7"), group);
    let chosen: Map<String, Value> = ["id3", "id0", "id2", "id4", "id5", "id6"]
        .iter()
        .map(|k| ((*k).to_owned(), json!("0mwwsalis.0000.devA")))
        .collect();
    data.pin_choices
        .insert("default".into(), Value::Object(chosen));
    data
}

fn golden() -> Vec<(String, Vec<String>)> {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/browser/src/state/sync/fixtures/pin-records.json"
    ))
    .unwrap();
    let records: Vec<Value> = serde_json::from_str(&text).unwrap();
    records
        .iter()
        .map(|r| {
            (
                r["device"].as_str().unwrap().to_owned(),
                r["ops"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|o| o.as_str().unwrap().to_owned())
                    .collect(),
            )
        })
        .collect()
}

#[test]
fn a_mac_publishes_the_same_pinned_records_as_the_old_adapters() {
    let folder = Folder::default();
    let mut a = Device::new("devA", golden_device());
    a.sync(&folder);
    let published = logs(&folder);
    let expected = golden();
    assert_eq!(published[0], expected[0]);
    assert_eq!(published[1], expected[1]);
    assert!(a.state().persisted.pin_choices.get("default").is_none());
}

#[test]
fn pins_rows_folders_groups_order_and_homes_reach_another_mac_unloaded() {
    let folder = Folder::default();
    let mut a = Device::new("devA", golden_device());
    let mut b = Device::new("devB", base_state("wB", "https://b-home.example/"));
    for _ in 0..2 {
        a.sync(&folder);
        b.sync(&folder);
    }
    let pins = b.pins_by_key();
    for key in ["id3", "id0", "id2", "id4", "id5", "id6", "id8", "id9"] {
        let t = pins.get(key).unwrap_or_else(|| panic!("{key} arrived"));
        assert!(t.page.is_asleep(), "{key} stays unloaded");
        assert_eq!(t.window_id.as_str(), "wB");
    }
    assert_eq!(pins["id5"].pin, Some(TabPin::Row));
    assert_eq!(pins["id3"].pin, Some(TabPin::TILE));
    assert_eq!(
        pins["id0"]
            .pin
            .as_ref()
            .and_then(TabPin::folder)
            .map(|f| f.name.as_str()),
        Some("Work")
    );
    let s = b.state();
    let group = s
        .groups
        .values()
        .find(|g| g.pinned && g.pin_key() == "id7")
        .unwrap();
    assert_eq!(group.name, "Group");
    assert_eq!(group.tab_ids.len(), 2);
    assert_eq!(
        pins["id8"].pinned_url.as_deref(),
        Some("https://g1.example/")
    );
    let order: Vec<String> = s.windows["wB"]
        .tab_ids
        .iter()
        .map(|t| s.tabs[t].pin_key().to_owned())
        .collect();
    assert_eq!(
        order,
        [
            "id3", "id0", "id2", "id4", "id5", "id6", "id8", "id9", "wB-home"
        ]
    );
    let before = b.state();
    b.sync(&folder);
    assert_eq!(
        *before.tabs,
        *b.state().tabs,
        "an idle round changes nothing"
    );
}

#[test]
fn an_unpin_removes_the_unloaded_copy_and_a_row_change_follows() {
    let folder = Folder::default();
    let mut a = Device::new("devA", golden_device());
    let mut b = Device::new("devB", base_state("wB", "https://b-home.example/"));
    for _ in 0..2 {
        a.sync(&folder);
        b.sync(&folder);
    }
    a.store
        .dispatch(ardia_state::Action::SetPin {
            tab: TabId::new("id5"),
            pin: None,
        })
        .unwrap();
    a.edit(|s| {
        let tabs = Arc::make_mut(&mut s.tabs);
        Arc::make_mut(tabs.get_mut("id4").unwrap()).pin = Some(TabPin::Row);
    });
    for _ in 0..2 {
        a.sync(&folder);
        b.sync(&folder);
    }
    let pins = b.pins_by_key();
    assert!(!pins.contains_key("id5"));
    assert!(!b.state().tabs.values().any(|t| t.pin_key() == "id5"));
    assert_eq!(pins["id4"].pin, Some(TabPin::Row));
}

#[test]
fn a_profile_without_a_window_keeps_synced_pins_parked() {
    let folder = Folder::default();
    let mut a = Device::new("devA", golden_device());
    let mut data = base_state("wB", "https://b-home.example/");
    data.windows
        .get_mut(&WindowId::new("wB"))
        .unwrap()
        .profile_id = ProfileId::new("other");
    let mut other = Profile::new(ProfileId::new("other"), "Work", ProfileColor::Plum, NOW);
    other.created_at = NOW;
    data.profiles.insert(ProfileId::new("other"), other);
    data.profile_order.push(ProfileId::new("other"));
    let home = TabId::new("wB-home");
    data.tabs.get_mut(&home).unwrap().profile_id = ProfileId::new("other");
    data.windows
        .get_mut(&WindowId::new("wB"))
        .unwrap()
        .active_tab_ids = [(ProfileId::new("other"), home)].into_iter().collect();
    let mut b = Device::new("devB", data);
    for _ in 0..2 {
        a.sync(&folder);
        b.sync(&folder);
    }
    let s = b.state();
    let park = s
        .persisted
        .parked_pins
        .get(&profile())
        .expect("pins parked");
    let keys: Vec<&str> = park.tabs.iter().map(|p| p.id.as_str()).collect();
    assert!(keys.contains(&"id3") && keys.contains(&"id8"));
    assert!(
        park.groups
            .iter()
            .any(|g| g.id == "id7" && g.name == "Group")
    );
    assert!(
        !s.tabs
            .values()
            .any(|t| t.profile_id == profile() && t.pin.is_some())
    );
}

fn open_tabs_device(id: &str, window: &str) -> Device {
    let mut data = base_state(window, "https://start.example/");
    data.profiles.get_mut(&profile()).unwrap().sync_tabs = true;
    Device::new(id, data)
}

fn add_regular(d: &Device, window: &str, id: &str, url: &str) {
    d.edit(|s| {
        let mut tab = Tab::new(TabId::new(id), WindowId::new(window), profile(), url, NOW);
        tab.title = format!("{id} title");
        tab.page = TabPage::LOADED;
        Arc::make_mut(&mut s.tabs).insert(TabId::new(id), Arc::new(tab));
        let w = Arc::make_mut(&mut s.windows).get_mut(window).unwrap();
        Arc::make_mut(w).tab_ids.push(TabId::new(id));
    });
}

#[test]
fn open_tabs_arrive_unloaded_and_closes_follow() {
    let folder = Folder::default();
    let mut a = open_tabs_device("devA", "wA");
    let mut b = open_tabs_device("devB", "wB");
    add_regular(&a, "wA", "t1", "https://one.example/");
    for _ in 0..2 {
        a.sync(&folder);
        b.sync(&folder);
    }
    let record = a.scope.records.get(&format!("{OPEN_TAB}t1")).unwrap();
    assert_eq!(
        serde_json::to_string(&record.v).unwrap(),
        r#"{"u":"https://one.example/","t":"t1 title","pos":"l","g":null,"a":1794999960000}"#
    );
    let arrived = b.state().tabs.get("t1").cloned().expect("t1 arrived on B");
    assert_eq!(arrived.page.kind, ardia_state::model::PageKind::Idle);
    assert_eq!(arrived.url, "https://one.example/");
    let prev = a.state();
    a.store
        .dispatch(ardia_state::Action::CloseTabs {
            tabs: vec![TabId::new("t1")],
            last_closes_window: false,
        })
        .unwrap();
    let closed = closed_open_tabs(&prev, &a.state(), false);
    assert_eq!(closed, vec![(profile(), "t1".to_owned())]);
    crate::sync_engine::adapters::tabs::record_open_tab_closes(&mut a.cx.doc.lock(), &closed);
    for _ in 0..2 {
        a.sync(&folder);
        b.sync(&folder);
    }
    assert!(a.scope.records[&format!("{OPEN_TAB}t1")].v.is_null());
    assert!(b.state().tabs.get("t1").is_none(), "the close reached B");
    assert!(a.cx.doc_extra("tabCloses").is_none(), "the close settled");
}

#[test]
fn switching_open_tabs_off_tombstones_records_and_keeps_tabs_elsewhere() {
    let folder = Folder::default();
    let mut a = open_tabs_device("devA", "wA");
    let mut b = open_tabs_device("devB", "wB");
    add_regular(&a, "wA", "t1", "https://one.example/");
    for _ in 0..2 {
        a.sync(&folder);
        b.sync(&folder);
    }
    a.edit(|s| {
        let profiles = Arc::make_mut(&mut s.profiles);
        Arc::make_mut(profiles.get_mut(&profile()).unwrap()).sync_tabs = false;
    });
    a.cx.set_link_extra(&profile(), "tabsRetire", Some(Value::Bool(true)));
    let flag = ardia_state::sync_engine::SyncRecord {
        h: a.clock.tick(),
        v: json!({ "on": false }),
        o: ("devA".into(), 1),
    };
    a.cx.app_records = Arc::new([("ptab:S1".to_owned(), flag)].into_iter().collect());
    a.sync(&folder);
    assert_eq!(a.scope.records[OPEN_TABS_ON].v, json!({ "on": false }));
    assert!(a.scope.records[&format!("{OPEN_TAB}t1")].v.is_null());
    b.sync(&folder);
    assert!(b.state().tabs.contains_key("t1"), "B keeps the tab it has");
    assert!(a.state().tabs.contains_key("t1"), "A keeps its tab");
}

#[test]
fn records_this_mac_does_not_own_are_left_alone() {
    let folder = Folder::default();
    let mut a = open_tabs_device("devA", "wA");
    let mut b = Device::new("devB", base_state("wB", "https://b-home.example/"));
    add_regular(&a, "wA", "t1", "https://one.example/");
    a.sync(&folder);
    b.sync(&folder);
    b.sync(&folder);
    assert!(!b.scope.records[&format!("{OPEN_TAB}t1")].v.is_null());
    assert!(
        !logs(&folder)
            .iter()
            .any(|(device, ops)| device == "devB" && ops.iter().any(|op| op.contains("otab:")))
    );
    assert!(
        !b.state().tabs.contains_key("t1"),
        "a Mac with the switch off opens nothing"
    );
}

#[test]
fn a_group_set_to_none_travels_as_null_plus_its_look_record() {
    let folder = Folder::default();
    let mut data = golden_device();
    data.groups.get_mut(&GroupId::new("id7")).unwrap().color =
        Some(ardia_state::groups::GroupColor::NoColor);
    let mut a = Device::new("devA", data);
    let mut b = Device::new("devB", base_state("wB", "https://b-home.example/"));
    for _ in 0..2 {
        a.sync(&folder);
        b.sync(&folder);
    }
    let ops: Vec<String> = logs(&folder).into_iter().flat_map(|(_, ops)| ops).collect();
    assert!(ops.contains(&r#"["pgc:id7","none"]"#.to_owned()));
    assert!(
        ops.contains(&r#"["pin:g:id7",{"n":"Group","i":null,"c":null,"pos":"zl"}]"#.to_owned())
    );
    let s = b.state();
    let group = s.groups.values().find(|g| g.pin_key() == "id7").unwrap();
    assert_eq!(group.color, Some(ardia_state::groups::GroupColor::NoColor));
}
