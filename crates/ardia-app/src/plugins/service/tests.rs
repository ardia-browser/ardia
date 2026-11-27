use std::path::Path;

use ardia_ui::plugins::model::{ConsentOwner, PluginHost};
use parking_lot::Mutex;

use super::*;

#[derive(Default)]
struct FakeEnv {
    notified: Mutex<usize>,
    opened: Mutex<Vec<(WindowId, String)>>,
    toasts: Mutex<Vec<String>>,
    urls: Mutex<HashMap<TabId, String>>,
}

impl PluginEnv for FakeEnv {
    fn notify(&self) {
        *self.notified.lock() += 1;
    }
    fn window_eligible(&self, window: &WindowId) -> bool {
        window.as_str() != "private"
    }
    fn focused_window(&self) -> Option<WindowId> {
        Some(WindowId::new("w1"))
    }
    fn open_url(&self, window: &WindowId, url: &str, _: bool) -> Option<TabId> {
        self.opened.lock().push((window.clone(), url.to_owned()));
        Some(TabId::new("new-tab"))
    }
    fn toast(&self, _: &WindowId, title: &str, _: Option<&str>) {
        self.toasts.lock().push(title.to_owned());
    }
    fn host_action(&self, _: HostAction, _: &WindowId, _: &TabId) {}
    fn tab_url(&self, tab: &TabId) -> Option<String> {
        self.urls.lock().get(tab).cloned()
    }
    fn tab_window(&self, _: &TabId) -> Option<WindowId> {
        Some(WindowId::new("w1"))
    }
    fn app_version(&self) -> String {
        "9.9.9".into()
    }
    fn control_on(&self) -> bool {
        false
    }
    fn open_plugin_settings(&self, _: &str) {}
    fn confirm(
        &self,
        _: &WindowId,
        _: String,
        _: String,
        _: String,
        _: bool,
        answer: Box<dyn FnOnce(Option<bool>) + Send>,
    ) {
        answer(Some(true));
    }
    fn state(&self) -> Option<Arc<ardia_state::BrowserState>> {
        None
    }
    fn dispatch(&self, _: ardia_state::Action) -> Result<Option<TabId>, String> {
        Ok(None)
    }
    fn watch_state(&self, _: Box<dyn Fn() + Send + Sync>) {}
    fn control(&self, method: &str, _: Value, done: ControlDone) {
        done(Ok(json!({ "ran": method })));
    }
    fn evaluate(&self, _: &TabId, _: &str, done: Box<dyn FnOnce(Option<Value>) + Send>) {
        done(None);
    }
    fn on_main(&self, job: Box<dyn FnOnce() + Send>) {
        job();
    }
}

fn write_plugin(root: &Path, name: &str, manifest: &str, files: &[(&str, &str)]) {
    let folder = root.join("config/plugins").join(name);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("plugin.json"), manifest).unwrap();
    for (file, text) in files {
        let path = folder.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}

fn service(root: &Path) -> (Arc<PluginService>, Arc<FakeEnv>) {
    let env = Arc::new(FakeEnv::default());
    let data = std::fs::canonicalize(root).unwrap();
    let folders = PluginFolders {
        data_dir: data.clone(),
        config_dir: data.join("config"),
        pin: Vec::new(),
    };
    (PluginService::new(folders, env.clone()), env)
}

fn approve(service: &PluginService, name: &str) {
    assert!(service.request_consent(name, ConsentOwner::Settings));
    let request = PluginHost::consent(service).unwrap();
    assert!(service.answer_consent(ConsentOwner::Settings, request.id, true));
}

const DEV: &str = r#"{"manifest":2,"name":"dev","title":"Dev","icon":"hammer",
"sidecar":{"run":["/bin/sh","helper.sh"]},
"contributes":{"siteSwitches":[{"key":"on","title":"Dev Mode","icon":"hammer"}],
 "pageBar":{"look":"stripes","when":{"siteSwitch":"on"},"buttons":["siteControls","address","console"]},
 "commands":[{"name":"go","title":"Go","tool":"go"}],"tools":[{"name":"go","title":"Go"}],
 "toolbar":[{"id":"run","title":"Run","icon":"play","command":"go"}]}}"#;

const HELPER: &str = r#"echo '{"id":1,"method":"hello"}' >&3
echo '{"id":2,"method":"ui.showQuickPick","params":{"items":[{"id":"a","title":"Alpha"},{"id":"b","title":"Beta"}],"options":{"title":"Pick"}}}' >&3
echo '{"id":3,"method":"toolbar.update","params":{"itemId":"run","update":{"label":"Busy","badge":3}}}' >&3
while read -r line <&3; do
  echo "$line" >> "$HOME/got.txt"
done
"#;

fn wait_for(what: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !what() {
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn consent_enables_a_sidecar_that_drives_quick_picks_and_toolbar_state() {
    let dir = tempfile::tempdir().unwrap();
    write_plugin(dir.path(), "dev", DEV, &[("helper.sh", HELPER)]);
    let (service, env) = service(dir.path());
    service.start();
    assert!(PluginHost::toolbar_items(service.as_ref()).is_empty());
    assert!(service.request_consent("dev", ConsentOwner::Settings));
    let request = PluginHost::consent(service.as_ref()).unwrap();
    assert_eq!(request.verb, ConsentVerb::TurnOn);
    assert!(
        request
            .lines
            .iter()
            .any(|l| l.text == "Runs a program in the background: /bin/sh helper.sh")
    );
    assert!(!service.answer_consent(ConsentOwner::Window, request.id, true));
    assert!(service.answer_consent(ConsentOwner::Settings, request.id, true));
    let saved = read_records(&service.folders().data_dir);
    assert!(saved["dev"].enabled);
    wait_for(|| PluginHost::quick_pick(service.as_ref()).is_some());
    let pick = PluginHost::quick_pick(service.as_ref()).unwrap();
    assert_eq!(pick.options.title.as_deref(), Some("Pick"));
    assert_eq!(pick.plugin_title.as_deref(), Some("Dev"));
    wait_for(|| {
        PluginHost::toolbar_items(service.as_ref())
            .first()
            .is_some_and(|i| i.state.label.is_some())
    });
    let items = PluginHost::toolbar_items(service.as_ref());
    assert_eq!(items[0].state.label, Some(Some("Busy".into())));
    service.resolve_quick_pick(pick.id, Some(vec!["b".into(), "zzz".into()]));
    let got = service
        .folders()
        .data_dir
        .join("PluginData/dev/home/got.txt");
    wait_for(|| std::fs::read_to_string(&got).is_ok_and(|t| t.contains("\"picked\"")));
    let text = std::fs::read_to_string(&got).unwrap();
    assert!(
        text.contains(r#"{"id":1,"result":{"app":"Ardia""#),
        "{text}"
    );
    assert!(
        text.contains(r#"{"id":2,"result":{"picked":["b"]}}"#),
        "{text}"
    );
    assert!(*env.notified.lock() > 0);
    service.stop_all();
}

#[test]
fn site_switches_drive_page_bars_and_are_saved() {
    let dir = tempfile::tempdir().unwrap();
    write_plugin(
        dir.path(),
        "dev",
        DEV,
        &[("helper.sh", "while read -r l <&3; do :; done\n")],
    );
    let (service, env) = service(dir.path());
    service.start();
    approve(&service, "dev");
    let tab = TabId::new("t1");
    env.urls
        .lock()
        .insert(tab.clone(), "http://localhost:3000/app".into());
    let rows = PluginHost::site_switch_rows(service.as_ref(), &tab);
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].on);
    assert!(PluginHost::page_bar(service.as_ref(), &WindowId::new("w1"), &tab).is_none());
    PluginHost::set_site_switch(
        service.as_ref(),
        "dev",
        "on",
        "http://localhost:3000/app",
        true,
    );
    assert!(PluginHost::site_switch_rows(service.as_ref(), &tab)[0].on);
    let bar = PluginHost::page_bar(service.as_ref(), &WindowId::new("w1"), &tab).unwrap();
    assert_eq!(bar.buttons.len(), 3);
    assert!(PluginHost::page_bar(service.as_ref(), &WindowId::new("private"), &tab).is_none());
    let saved = read_records(&service.folders().data_dir);
    assert!(saved["dev"].site_switch("on", "http://localhost:3000"));
    service.stop_all();
}

#[test]
fn surfaces_mount_when_a_main_plugin_is_ready_and_render_its_trees() {
    let dir = tempfile::tempdir().unwrap();
    write_plugin(
        dir.path(),
        "views",
        r#"{"manifest":2,"name":"views","title":"Views","sidecar":{"run":["/bin/sh","helper.sh"]},
        "contributes":{"panels":[{"id":"side","title":"Side","mode":"sidecar","file":"page/index.html"}]}}"#,
        &[
            (
                "helper.sh",
                "while read -r l <&3; do echo \"$l\" >> \"$HOME/got.txt\"; done\n",
            ),
            ("page/index.html", "<p>hi</p>"),
        ],
    );
    let (service, env) = service(dir.path());
    service.start();
    approve(&service, "views");
    let window = WindowId::new("w1");
    assert!(service.open_panel(&window, "views", "side").is_ok());
    let side = PluginHost::side_panel(service.as_ref(), &window);
    let card = side.shown.unwrap();
    assert_eq!(card.title, "Side");
    assert_eq!(
        card.content,
        PanelContent::File("ardia-plugin://views/page/index.html".into())
    );
    PluginHost::close_side_panel(service.as_ref(), &window, "views");
    assert!(
        PluginHost::side_panel(service.as_ref(), &window)
            .shown
            .is_none()
    );
    assert!(
        service
            .open_panel(&WindowId::new("private"), "views", "side")
            .is_err()
    );
    wait_for(|| {
        matches!(
            service.process_state("views"),
            Some(ProcessState::Running { .. })
        )
    });
    PluginHost::mount_surface(
        service.as_ref(),
        SurfaceMount {
            plugin: "views".into(),
            instance: "list#1".into(),
            view: "list".into(),
            kind: SurfaceKind::Sidebar,
            window: window.clone(),
            context: Map::new(),
        },
    );
    let got = service
        .folders()
        .data_dir
        .join("PluginData/views/home/got.txt");
    wait_for(|| std::fs::read_to_string(&got).is_ok_and(|t| t.contains("\"surface\":\"mount\"")));
    assert!(PluginHost::fire(
        service.as_ref(),
        "views",
        "list#1",
        &window,
        "h1",
        vec![json!(1)],
        true
    ));
    wait_for(|| std::fs::read_to_string(&got).is_ok_and(|t| t.contains("\"handlerId\":\"h1\"")));
    let run = match service.process_state("views") {
        Some(ProcessState::Running { run }) => run,
        other => panic!("{other:?}"),
    };
    service.handle_line(
        "views",
        run,
        r#"{"id":5,"method":"surface.render","params":{"surfaceId":"list#1","tree":{"type":"List","children":[]}}}"#,
    );
    assert_eq!(
        PluginHost::surface_tree(service.as_ref(), "views", "list#1")
            .unwrap()
            .kind,
        "List"
    );
    let _ = env;
    service.stop_all();
}

#[test]
fn storage_and_toasts_follow_permissions_and_limits() {
    let dir = tempfile::tempdir().unwrap();
    write_plugin(
        dir.path(),
        "keep",
        r#"{"manifest":2,"name":"keep","title":"Keep","permissions":{"storage":true},"sidecar":{"run":["/bin/sh","h.sh"]}}"#,
        &[(
            "h.sh",
            "while read -r l <&3; do echo \"$l\" >> \"$HOME/got.txt\"; done\n",
        )],
    );
    let (service, env) = service(dir.path());
    service.start();
    approve(&service, "keep");
    wait_for(|| {
        matches!(
            service.process_state("keep"),
            Some(ProcessState::Running { .. })
        )
    });
    let Some(ProcessState::Running { run }) = service.process_state("keep") else {
        unreachable!()
    };
    service.handle_line(
        "keep",
        run,
        r#"{"id":1,"method":"storage.set","params":{"key":"k","value":{"n":1}}}"#,
    );
    service.handle_line(
        "keep",
        run,
        r#"{"id":2,"method":"storage.get","params":{"key":"k"}}"#,
    );
    service.handle_line(
        "keep",
        run,
        r#"{"id":3,"method":"ui.showToast","params":{"title":"Saved"}}"#,
    );
    service.handle_line(
        "keep",
        run,
        r#"{"id":4,"method":"ui.showToast","params":{"title":"Again"}}"#,
    );
    service.handle_line("keep", run, r#"{"id":5,"method":"nope"}"#);
    service.handle_line("keep", run, "not json");
    let got = service
        .folders()
        .data_dir
        .join("PluginData/keep/home/got.txt");
    wait_for(|| std::fs::read_to_string(&got).is_ok_and(|t| t.lines().count() >= 6));
    let text = std::fs::read_to_string(&got).unwrap();
    assert!(text.contains(r#"{"id":2,"result":{"n":1}}"#), "{text}");
    assert!(text.contains("at most every 1.5 s"), "{text}");
    assert!(text.contains("unknown_method"), "{text}");
    assert!(text.contains("The line isn't JSON."), "{text}");
    assert_eq!(*env.toasts.lock(), vec!["Saved".to_owned()]);
    let stored = std::fs::read_to_string(
        service
            .folders()
            .data_dir
            .join("PluginData/keep/storage.json"),
    )
    .unwrap();
    assert_eq!(stored, r#"{"k":{"n":1}}"#);
    service.stop_all();
}

#[test]
fn a_main_plugin_renders_through_the_quickjs_host() {
    if std::env::var_os(process::HOST_ENV).is_none() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    write_plugin(
        dir.path(),
        "js",
        r#"{"manifest":2,"name":"js","title":"JS","main":"dist/index.js",
        "contributes":{"sidebarViews":[{"id":"list","title":"List"}]}}"#,
        &[(
            "dist/index.js",
            r#"__ardiaBridge.onLine((line) => {
  const m = JSON.parse(line);
  if (m.surface === "mount") __ardiaBridge.send(JSON.stringify({ id: 2, method: "surface.render", params: { surfaceId: m.surfaceId, tree: { type: "List", children: [{ type: "ListItem", props: { title: "From JS" }, children: [] }] } } }));
});
__ardiaBridge.send(JSON.stringify({ id: 1, method: "ready" }));
"#,
        )],
    );
    let (service, _env) = service(dir.path());
    service.start();
    approve(&service, "js");
    PluginHost::mount_surface(
        service.as_ref(),
        SurfaceMount {
            plugin: "js".into(),
            instance: "list#9".into(),
            view: "list".into(),
            kind: SurfaceKind::Sidebar,
            window: WindowId::new("w1"),
            context: Map::new(),
        },
    );
    wait_for(|| PluginHost::surface_tree(service.as_ref(), "js", "list#9").is_some());
    let tree = PluginHost::surface_tree(service.as_ref(), "js", "list#9").unwrap();
    assert_eq!(
        tree.nodes().next().unwrap().props["title"],
        json!("From JS")
    );
    service.stop_all();
}

#[test]
fn secrets_and_run_need_their_permissions() {
    let dir = tempfile::tempdir().unwrap();
    write_plugin(
        dir.path(),
        "vault",
        r#"{"manifest":2,"name":"vault","title":"Vault","permissions":{"secrets":true,"commands":true},"sidecar":{"run":["/bin/sh","h.sh"]}}"#,
        &[(
            "h.sh",
            "while read -r l <&3; do echo \"$l\" >> \"$HOME/got.txt\"; done\n",
        )],
    );
    let (service, _env) = service(dir.path());
    service.start();
    approve(&service, "vault");
    wait_for(|| {
        matches!(
            service.process_state("vault"),
            Some(ProcessState::Running { .. })
        )
    });
    let Some(ProcessState::Running { run }) = service.process_state("vault") else {
        unreachable!()
    };
    service.handle_line(
        "vault",
        run,
        r#"{"id":1,"method":"secrets.set","params":{"key":"token","value":"s3"}}"#,
    );
    service.handle_line(
        "vault",
        run,
        r#"{"id":2,"method":"secrets.get","params":{"key":"token"}}"#,
    );
    service.handle_line(
        "vault",
        run,
        r#"{"id":3,"method":"run","params":{"command":"newTab"}}"#,
    );
    service.handle_line("vault", run, r#"{"id":4,"method":"workspace"}"#);
    service.handle_line("vault", run, r#"{"id":5,"method":"tabs.readActivePage"}"#);
    let got = service
        .folders()
        .data_dir
        .join("PluginData/vault/home/got.txt");
    wait_for(|| std::fs::read_to_string(&got).is_ok_and(|t| t.lines().count() >= 5));
    let text = std::fs::read_to_string(&got).unwrap();
    assert!(text.contains(r#"{"id":2,"result":"s3"}"#), "{text}");
    assert!(
        text.contains(r#"{"id":3,"result":{"ran":"run"}}"#),
        "{text}"
    );
    assert!(
        text.contains("workspace needs the workspace permission"),
        "{text}"
    );
    assert!(text.contains("activePage permission"), "{text}");
    let stored =
        std::fs::read_to_string(service.folders().data_dir.join("Plugin Secrets.json")).unwrap();
    assert!(stored.contains("ardia.plugin.vault.token"));
    service.stop_all();
}

#[test]
fn omnibox_rows_are_cleaned_capped_and_checked() {
    let rows = sanitized_rows(&json!({ "suggestions": [
        { "title": "  Docs\u{202e}  ", "url": "https://example.com/a", "subtitle": "Sub", "icon": "book.fill", "badge": "New" },
        { "title": "No url" },
        { "title": "Bad url", "url": "javascript:alert(1)" },
        { "title": "   ", "url": "https://example.com/b" },
        { "title": "Bad icon", "url": "https://example.com/c", "icon": "Not An Icon!" },
        "not a row"
    ] }));
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].title, "Docs");
    assert_eq!(rows[0].url, "https://example.com/a");
    assert_eq!(rows[0].subtitle.as_deref(), Some("Sub"));
    assert_eq!(rows[0].icon.as_deref(), Some("book.fill"));
    assert_eq!(rows[1].icon, None);
    let many: Vec<Value> = (0..20)
        .map(|i| json!({ "title": format!("R{i}"), "url": format!("https://example.com/{i}") }))
        .collect();
    assert_eq!(sanitized_rows(&Value::Array(many)).len(), OMNIBOX_ROWS);
    assert_eq!(sanitized_rows(&json!("nope")), Vec::new());
    assert_eq!(
        sanitized_rows(&json!([{ "title": "T".repeat(300), "url": "https://example.com" }]))[0]
            .title
            .chars()
            .count(),
        120
    );
}

const OMNIBOX_PLUGIN: &str = r#"{"manifest":2,"name":"finder","title":"Finder","main":"dist/index.js","permissions":{"storage":true},
"contributes":{"omnibox":[{"id":"docs","title":"Docs","keyword":"d"},{"id":"all","title":"All","global":true}]}}"#;

const OMNIBOX_MAIN: &str = r#"let n = 10;
const seen = (text) => __ardiaBridge.send(JSON.stringify({ id: n++, method: "storage.set", params: { key: "seen" + n, value: text } }));
__ardiaBridge.onLine((line) => {
  const m = JSON.parse(line);
  if (m.cancel) {
    seen("cancel:" + m.call);
    return;
  }
  if (m.kind !== "omnibox") return;
  seen([m.name, m.input.length, m.caller.kind, m.deadline > 0].join("|"));
  if (m.input.startsWith("slow")) return;
  __ardiaBridge.send(JSON.stringify({ id: n++, method: "result", params: { call: m.call, result: { suggestions: [
    { title: "Hit " + m.input.slice(0, 5), url: "https://example.com/?q=1", badge: "B" },
    { title: "Dropped", url: "file:///etc/passwd" }
  ] } } }));
});
__ardiaBridge.send(JSON.stringify({ id: 1, method: "ready" }));
"#;

fn take_rows(
    rows: &mut futures::channel::oneshot::Receiver<
        Vec<ardia_state::omnibox::providers::ProviderRow>,
    >,
) -> Vec<ardia_state::omnibox::providers::ProviderRow> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(Some(got)) = rows.try_recv() {
            return got;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn unknown_omnibox_providers_answer_empty_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let (service, _env) = service(dir.path());
    service.start();
    assert!(PluginHost::omnibox_providers(service.as_ref(), &WindowId::new("w1")).is_empty());
    let mut rows = PluginHost::query_omnibox_provider(service.as_ref(), "plugin:none:docs", "q");
    assert_eq!(rows.try_recv().unwrap(), Some(Vec::new()));
    let mut rows = PluginHost::query_omnibox_provider(service.as_ref(), "docs", "q");
    assert_eq!(rows.try_recv().unwrap(), Some(Vec::new()));
}

#[test]
fn omnibox_providers_query_time_out_and_cancel_through_the_quickjs_host() {
    if std::env::var_os(process::HOST_ENV).is_none() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    write_plugin(
        dir.path(),
        "finder",
        OMNIBOX_PLUGIN,
        &[("dist/index.js", OMNIBOX_MAIN)],
    );
    let (service, _env) = service(dir.path());
    service.start();
    approve(&service, "finder");
    let seen = || {
        service
            .storage_path("finder")
            .and_then(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_default()
    };
    let window = WindowId::new("w1");
    let providers = PluginHost::omnibox_providers(service.as_ref(), &window);
    assert_eq!(
        providers,
        vec![
            ardia_state::omnibox::providers::PluginProvider {
                id: "plugin:finder:docs".into(),
                title: "Docs".into(),
                keyword: Some("d".into()),
                global: false,
            },
            ardia_state::omnibox::providers::PluginProvider {
                id: "plugin:finder:all".into(),
                title: "All".into(),
                keyword: None,
                global: true,
            },
        ]
    );
    assert!(PluginHost::omnibox_providers(service.as_ref(), &WindowId::new("private")).is_empty());

    let long = "x".repeat(900);
    let mut rows =
        PluginHost::query_omnibox_provider(service.as_ref(), "plugin:finder:docs", &long);
    let got = take_rows(&mut rows);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].title, "Hit xxxxx");
    assert_eq!(got[0].url, "https://example.com/?q=1");
    wait_for(|| seen().contains("docs|500|host|true"));

    let started = Instant::now();
    let mut rows =
        PluginHost::query_omnibox_provider(service.as_ref(), "plugin:finder:all", "slow");
    assert!(take_rows(&mut rows).is_empty());
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(1400) && waited < Duration::from_secs(4),
        "{waited:?}"
    );
    wait_for(|| seen().matches("cancel:").count() == 1);

    let rows =
        PluginHost::query_omnibox_provider(service.as_ref(), "plugin:finder:all", "slow again");
    wait_for(|| !service.state.lock().calls.is_empty());
    let dropped = Instant::now();
    drop(rows);
    wait_for(|| service.state.lock().calls.is_empty());
    assert!(dropped.elapsed() < Duration::from_millis(1000));
    wait_for(|| seen().matches("cancel:").count() == 2);
    service.stop_all();
}

mod official_installs {
    use super::*;
    use crate::plugins::official::tests::{good_archive, pin_entry};
    use ardia_ui::host::OfficialPluginState;
    use ardia_ui::plugins::model::ConsentVerb;

    fn official_service(root: &Path, archive: &[u8]) -> (Arc<PluginService>, Arc<FakeEnv>) {
        let env = Arc::new(FakeEnv::default());
        let data = std::fs::canonicalize(root).unwrap();
        let entry = pin_entry("kit", archive);
        let source = data.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join(entry.file.as_deref().unwrap()), archive).unwrap();
        let folders = PluginFolders {
            data_dir: data.clone(),
            config_dir: data.join("config"),
            pin: vec![entry],
        };
        let service = PluginService::new(folders, env.clone());
        service.set_official_source(Some(source));
        service.start();
        (service, env)
    }

    fn state_of(service: &PluginService) -> OfficialPluginState {
        service.official_plugins()[0].state
    }

    fn reply(
        mut rx: futures::channel::oneshot::Receiver<Result<(), String>>,
    ) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match rx.try_recv() {
                Ok(Some(result)) => return result,
                Ok(None) => {}
                Err(_) => panic!("dropped"),
            }
            assert!(Instant::now() < deadline, "timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn asked(service: &PluginService) -> ConsentRequest {
        wait_for(|| PluginHost::consent(service).is_some());
        PluginHost::consent(service).unwrap()
    }

    #[test]
    fn installing_fetches_asks_then_activates_on_approval() {
        let dir = tempfile::tempdir().unwrap();
        let archive = good_archive("kit");
        let (service, _env) = official_service(dir.path(), &archive);
        let shown = service.official_plugins();
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].state, OfficialPluginState::Available);
        assert_eq!(shown[0].title, "Kit");
        assert_eq!(shown[0].blurb, "Tools.");
        assert_eq!(shown[0].icon, "shippingbox");
        assert_eq!(shown[0].version.as_deref(), Some("1.0.0"));
        let rx = service.install_official("kit");
        let joined = service.install_official("kit");
        let request = asked(&service);
        assert!(!request.changed, "a first install must be confirmable");
        assert_eq!(
            service.official_install_progress("kit"),
            Some(ardia_ui::host::OfficialInstallPhase::Asking)
        );
        assert_eq!(request.name, "kit");
        assert_eq!(request.owner, ConsentOwner::Settings);
        assert_eq!(request.verb, ConsentVerb::Install);
        assert_eq!(service.official_plugins()[0].blurb, "A kit.");
        assert_eq!(state_of(&service), OfficialPluginState::Available);
        assert!(PluginHost::answer_consent(
            service.as_ref(),
            ConsentOwner::Settings,
            request.id,
            true
        ));
        assert_eq!(reply(rx), Ok(()));
        assert_eq!(reply(joined), Ok(()));
        assert_eq!(service.official_install_progress("kit"), None);
        assert_eq!(state_of(&service), OfficialPluginState::Installed);
        assert!(PluginHost::consent(service.as_ref()).is_none());
        let sha = crate::plugins::official::tests::sha(&archive);
        assert_eq!(service.official_store().active_sha("kit"), Some(sha));
        let records = read_records(&service.folders().data_dir);
        assert_eq!(records["kit"].approved, Some(request.hash));
        assert!(records["kit"].enabled);
        assert_eq!(reply(service.install_official("kit")), Ok(()));
        assert!(PluginHost::consent(service.as_ref()).is_none());
    }

    #[test]
    fn declining_or_cancelling_leaves_it_available() {
        let dir = tempfile::tempdir().unwrap();
        let archive = good_archive("kit");
        let (service, _env) = official_service(dir.path(), &archive);
        let rx = service.install_official("kit");
        let request = asked(&service);
        assert!(PluginHost::answer_consent(
            service.as_ref(),
            ConsentOwner::Settings,
            request.id,
            false
        ));
        assert_eq!(reply(rx), Err("Cancelled.".into()));
        assert_eq!(state_of(&service), OfficialPluginState::Available);
        assert_eq!(service.official_store().active_sha("kit"), None);

        let rx = service.install_official("kit");
        asked(&service);
        service.cancel_official_install("kit");
        assert_eq!(reply(rx), Err("Cancelled.".into()));
        assert!(PluginHost::consent(service.as_ref()).is_none());
        assert_eq!(state_of(&service), OfficialPluginState::Available);
        assert!(service.state.lock().candidates.is_empty());
        service.cancel_official_install("kit");
    }

    #[test]
    fn a_bad_download_or_a_pending_question_fails_with_the_old_copy() {
        let dir = tempfile::tempdir().unwrap();
        let archive = good_archive("kit");
        let (service, _env) = official_service(dir.path(), &archive);
        std::fs::write(
            service.folders().data_dir.join("source/kit.tar.gz"),
            b"tampered",
        )
        .unwrap();
        assert_eq!(
            reply(service.install_official("kit")),
            Err("The download didn't match the copy this version of Ardia trusts, so it wasn't installed.".into())
        );
        std::fs::remove_file(service.folders().data_dir.join("source/kit.tar.gz")).unwrap();
        assert_eq!(
            reply(service.install_official("kit")),
            Err("Couldn't download it. Check your internet connection, then try again.".into())
        );
        assert_eq!(
            reply(service.install_official("nope")),
            Err("Not an official plugin.".into())
        );

        std::fs::write(
            service.folders().data_dir.join("source/kit.tar.gz"),
            &archive,
        )
        .unwrap();
        write_plugin(
            &service.folders().data_dir,
            "other",
            r#"{"manifest":2,"name":"other","title":"Other"}"#,
            &[],
        );
        service.rescan();
        assert!(service.request_consent("other", ConsentOwner::Window));
        assert_eq!(
            reply(service.install_official("kit")),
            Err(
                "Ardia is already asking about a plugin. Answer that first, then try again.".into()
            )
        );
        assert!(service.state.lock().installs.is_empty());
    }
}

mod official_updates_flow {
    use super::*;
    use crate::plugins::official::tests::{file, gz, manifest, pin_entry, sha, tar};
    use ardia_ui::plugins::model::ConsentVerb;

    fn archive(version: &str, extra: &str) -> Vec<u8> {
        let text = manifest("kit", version, extra);
        gz(&tar(&[file("kit/plugin.json", text.as_bytes())]))
    }

    fn installed_then_pinned(root: &Path, next: &[u8]) -> (Arc<PluginService>, String) {
        let data = std::fs::canonicalize(root).unwrap();
        let first = archive("1.0.0", "");
        let source = data.join("source");
        std::fs::create_dir_all(&source).unwrap();
        let old_entry = pin_entry("kit", &first);
        std::fs::write(source.join(old_entry.file.as_deref().unwrap()), &first).unwrap();
        let folders = PluginFolders {
            data_dir: data.clone(),
            config_dir: data.join("config"),
            pin: vec![old_entry],
        };
        let service = PluginService::new(folders, Arc::new(FakeEnv::default()));
        service.set_official_source(Some(source.clone()));
        service.start();
        let rx = service.install_official("kit");
        wait_for(|| PluginHost::consent(service.as_ref()).is_some());
        let request = PluginHost::consent(service.as_ref()).unwrap();
        assert!(PluginHost::answer_consent(
            service.as_ref(),
            ConsentOwner::Settings,
            request.id,
            true
        ));
        drop(rx);
        service.stop_all();
        let mut new_entry = pin_entry("kit", next);
        new_entry.version = "1.1.0".into();
        new_entry.trusted = vec![sha(&first)];
        std::fs::write(source.join(new_entry.file.as_deref().unwrap()), next).unwrap();
        let folders = PluginFolders {
            data_dir: data.clone(),
            config_dir: data.join("config"),
            pin: vec![new_entry],
        };
        let updated = PluginService::new(folders, Arc::new(FakeEnv::default()));
        updated.set_official_source(Some(source));
        (updated, sha(next))
    }

    #[test]
    fn a_cosmetic_update_installs_by_itself_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let next = archive("1.1.0", "");
        let (service, next_sha) = installed_then_pinned(dir.path(), &next);
        service.start();
        wait_for(|| {
            service.official_store().active_sha("kit").as_deref() == Some(next_sha.as_str())
        });
        let record = read_records(&service.folders().data_dir)["kit"].clone();
        let updated = record.updated.expect("the update is noted");
        assert_eq!(updated.from.as_deref(), Some("1.0.0"));
        assert_eq!(updated.to.as_deref(), Some("1.1.0"));
        let detail = service.settings_detail("kit").unwrap();
        assert_eq!(
            detail.auto_update.map(|(title, _)| title).as_deref(),
            Some("Updated by itself to 1.1.0")
        );
        assert!(detail.active);
        assert_eq!(service.official_plugins()[0].update, None);
        service.stop_all();
    }

    #[test]
    fn an_update_that_asks_for_more_waits_for_review() {
        let dir = tempfile::tempdir().unwrap();
        let next = archive("1.1.0", r#","permissions":{"storage":true}"#);
        let (service, next_sha) = installed_then_pinned(dir.path(), &next);
        service.start();
        wait_for(|| service.official_plugins()[0].update.is_some());
        let shown = service.official_plugins();
        assert_eq!(shown[0].update.as_deref(), Some("1.1.0"));
        assert_ne!(
            service.official_store().active_sha("kit").as_deref(),
            Some(next_sha.as_str())
        );
        let rx = service.install_official("kit");
        wait_for(|| PluginHost::consent(service.as_ref()).is_some());
        let request = PluginHost::consent(service.as_ref()).unwrap();
        assert_eq!(request.verb, ConsentVerb::Update);
        assert!(PluginHost::answer_consent(
            service.as_ref(),
            ConsentOwner::Settings,
            request.id,
            true
        ));
        drop(rx);
        wait_for(|| {
            service.official_store().active_sha("kit").as_deref() == Some(next_sha.as_str())
        });
        assert_eq!(service.official_plugins()[0].update, None);
        assert!(
            read_records(&service.folders().data_dir)["kit"]
                .updated
                .is_none()
        );
        service.stop_all();
    }
}

mod program_links {
    use super::*;
    use crate::plugins::official::tests::pin_entry;
    use crate::plugins::programs::{self, Places};
    use ardia_ui::plugins::model::ProgramsStatus;

    const TOOLS: &str = r#"{"manifest":2,"name":"tools","title":"Tools","version":"1.0.0",
    "contributes":{"programs":[{"name":"tool","path":"bin/tool"}]}}"#;

    fn linked_service(root: &Path, places: bool) -> (Arc<PluginService>, PathBuf) {
        let data = std::fs::canonicalize(root).unwrap();
        write_plugin(
            &data,
            "tools",
            TOOLS,
            &[("bin/tool", "#!/bin/sh\necho tool\n")],
        );
        let tool = data.join("config/plugins/tools/bin/tool");
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut cli = pin_entry("cli", b"x");
        cli.reserved_programs = vec!["ardia".into()];
        let folders = PluginFolders {
            data_dir: data.clone(),
            config_dir: data.join("config"),
            pin: vec![cli],
        };
        let service = PluginService::new(folders, Arc::new(FakeEnv::default()));
        if places {
            let mut found = Places::new(data.join("Programs"), data.join("bin"));
            found.shadowable = Vec::new();
            found.confined = Some(data.clone());
            service.set_program_places(Ok(found));
        }
        service.start();
        (service, data)
    }

    fn settled(service: &PluginService) -> Vec<ardia_ui::plugins::model::PluginPrograms> {
        wait_for(|| {
            let shown = PluginHost::plugin_programs(service);
            !shown.is_empty() && shown.iter().all(|p| p.status != ProgramsStatus::Linking)
        });
        PluginHost::plugin_programs(service)
    }

    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn turning_a_plugin_on_links_its_programs_and_off_takes_them_away() {
        let dir = tempfile::tempdir().unwrap();
        let (service, data) = linked_service(dir.path(), true);
        assert!(PluginHost::plugin_programs(service.as_ref()).is_empty());
        approve(&service, "tools");
        let shown = settled(&service);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].plugin, "tools");
        assert_eq!(shown[0].title, "Tools");
        assert_eq!(shown[0].programs, vec!["tool".to_owned()]);
        assert_eq!(
            shown[0].status,
            ProgramsStatus::Linked {
                linked: vec!["tool".into()],
                refused: Vec::new(),
                bin_dir: data.join("bin").display().to_string(),
            }
        );
        assert_eq!(shown[0].line(), "On your PATH: tool");
        assert!(!shown[0].can_relink());
        assert_eq!(
            service.linked_programs("tools"),
            vec![ardia_ui::host::LinkedProgram {
                program: "tool".into(),
                version: Some("1.0.0".into()),
            }]
        );
        assert!(service.linked_programs("nope").is_empty());
        assert!(programs::link_target(&data.join("bin/tool")).is_some());
        assert_eq!(
            PluginHost::relink_programs(service.as_ref(), "nope"),
            Err("This plugin has no programs.".into())
        );
        assert_eq!(
            PluginHost::relink_programs(service.as_ref(), "tools"),
            Ok(())
        );
        settled(&service);
        assert!(service.turn_plugin_off("tools"));
        assert!(PluginHost::plugin_programs(service.as_ref()).is_empty());
        assert!(service.linked_programs("tools").is_empty());
        wait_for(|| programs::link_target(&data.join("bin/tool")).is_none());
        assert!(service.remove_plugin_programs("tools"));
    }

    #[test]
    fn a_conflict_can_be_cleared_and_relinked() {
        let dir = tempfile::tempdir().unwrap();
        let (service, data) = linked_service(dir.path(), true);
        std::fs::create_dir_all(data.join("bin")).unwrap();
        std::fs::write(data.join("bin/tool"), b"mine").unwrap();
        approve(&service, "tools");
        let shown = settled(&service);
        let reason = format!(
            "{} is someone else's; remove it to use this one",
            data.join("bin/tool").display()
        );
        assert_eq!(shown[0].line(), format!("tool: {reason}"));
        assert!(service.linked_programs("tools").is_empty());
        assert!(shown[0].can_relink());
        std::fs::remove_file(data.join("bin/tool")).unwrap();
        assert_eq!(
            PluginHost::relink_programs(service.as_ref(), "tools"),
            Ok(())
        );
        let shown = settled(&service);
        assert_eq!(shown[0].line(), "On your PATH: tool");
    }

    #[test]
    fn without_places_or_with_a_reserved_name_nothing_is_linked() {
        let dir = tempfile::tempdir().unwrap();
        let (service, data) = linked_service(dir.path(), false);
        approve(&service, "tools");
        let shown = settled(&service);
        assert_eq!(
            shown[0].line(),
            "Not on your PATH: this copy of Ardia doesn't put programs on PATH"
        );
        assert!(shown[0].can_relink());
        assert!(!data.join("bin").exists());
        assert!(!data.join("Programs").exists());

        let dir = tempfile::tempdir().unwrap();
        let data = std::fs::canonicalize(dir.path()).unwrap();
        write_plugin(
            &data,
            "fake",
            r#"{"manifest":2,"name":"fake","title":"Fake","contributes":{"programs":[{"name":"ardia","path":"bin/ardia"}]}}"#,
            &[("bin/ardia", "#!/bin/sh\n")],
        );
        let mut cli = pin_entry("cli", b"x");
        cli.reserved_programs = vec!["ardia".into()];
        let service = PluginService::new(
            PluginFolders {
                data_dir: data.clone(),
                config_dir: data.join("config"),
                pin: vec![cli],
            },
            Arc::new(FakeEnv::default()),
        );
        let mut found = Places::new(data.join("Programs"), data.join("bin"));
        found.confined = Some(data.clone());
        service.set_program_places(Ok(found));
        service.start();
        approve(&service, "fake");
        let shown = settled(&service);
        assert_eq!(
            shown[0].line(),
            "Not on your PATH: ardia belongs to Ardia's official cli plugin"
        );
        assert!(!data.join("bin/ardia").exists());
    }
}

#[test]
fn install_phases_read_as_the_old_card() {
    use ardia_ui::host::OfficialInstallPhase;
    assert_eq!(
        OfficialInstallPhase::Downloading {
            received: 0,
            total: 0
        }
        .status()
        .as_deref(),
        Some("Downloading\u{2026}")
    );
    assert_eq!(
        OfficialInstallPhase::Downloading {
            received: 512,
            total: 2048
        }
        .status()
        .as_deref(),
        Some("Downloading\u{2026} 25%")
    );
    assert_eq!(
        OfficialInstallPhase::Downloading {
            received: 9,
            total: 4
        }
        .status()
        .as_deref(),
        Some("Downloading\u{2026} 100%")
    );
    assert_eq!(OfficialInstallPhase::Asking.status(), None);
    assert_eq!(
        OfficialInstallPhase::Installing.status().as_deref(),
        Some("Installing\u{2026}")
    );
}

#[test]
fn scratch_instances_never_touch_the_home_path() {
    use crate::plugins::programs;
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let data = root.join("data");
    let home = root.join("home");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let home_bin = format!("cliBinDir={}", home.join(".local/bin").display());
    assert_eq!(
        programs::places_for(&data, true, Some(&home), Some(&home_bin))
            .err()
            .as_deref(),
        Some(programs::SCRATCH_OUTSIDE)
    );
    assert_eq!(
        programs::places_for(&data, true, Some(&home), None)
            .err()
            .as_deref(),
        Some(programs::SCRATCH_NEEDS_BIN)
    );
    let inside = format!("cliBinDir={}", data.join("bin").display());
    let mut places = programs::places_for(&data, true, Some(&home), Some(&inside)).unwrap();
    places.shadowable = Vec::new();
    write_plugin(
        &data,
        "tools",
        r#"{"manifest":2,"name":"tools","title":"Tools","contributes":{"programs":[{"name":"tool","path":"bin/tool"}]}}"#,
        &[("bin/tool", "#!/bin/sh\n")],
    );
    std::fs::set_permissions(
        data.join("config/plugins/tools/bin/tool"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let service = PluginService::new(
        PluginFolders {
            data_dir: data.clone(),
            config_dir: data.join("config"),
            pin: Vec::new(),
        },
        Arc::new(FakeEnv::default()),
    );
    service.set_program_places(Ok(places));
    service.start();
    assert!(service.request_consent("tools", ConsentOwner::Settings));
    let request = PluginHost::consent(service.as_ref()).unwrap();
    assert!(!request.lines.iter().any(|l| l.text == LOGIN_PATH_LINE));
    assert!(request.lines.iter().any(|l| l.text
        == format!(
            "Puts its programs in {}. Your shell's login file isn't changed",
            data.join("bin").display()
        )));
    assert!(PluginHost::answer_consent(
        service.as_ref(),
        ConsentOwner::Settings,
        request.id,
        true
    ));
    wait_for(|| programs::link_target(&data.join("bin/tool")).is_some());
    assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0);

    let bare = PluginService::new(
        PluginFolders {
            data_dir: data.clone(),
            config_dir: data.join("config"),
            pin: Vec::new(),
        },
        Arc::new(FakeEnv::default()),
    );
    bare.start();
    assert!(bare.request_consent("tools", ConsentOwner::Settings));
    let request = PluginHost::consent(bare.as_ref()).unwrap();
    assert!(request.lines.iter().any(|l| l.text
        == "Its programs don't go on PATH here: this copy of Ardia doesn't put programs on PATH"));
}

const KNOBS: &str = r#"{"manifest":2,"name":"knobs","title":"Knobs","permissions":{"secrets":true},
"sidecar":{"run":["/bin/sh","h.sh"]},
"contributes":{"panels":[{"id":"page","mode":"tab","title":"Knobs Home","icon":"dial.low","file":"index.html"}],"settings":{"rows":[
 {"key":"loud","title":"Loud","type":"toggle","default":false},
 {"key":"side","title":"Side","type":"choice","default":"left","choices":[{"value":"left","title":"Left"},{"value":"right","title":"Right"}]},
 {"key":"count","title":"Count","type":"number","default":3,"min":1,"max":10,"step":1},
 {"key":"name","title":"Name","type":"text","default":"Ada"},
 {"key":"token","title":"Token","type":"secret","placeholder":"sk-…"}]},
 "commands":[{"name":"go","title":"Go","keywords":["run"],"when":"urlHost == 'example.com'","tool":"go"}],
 "tools":[{"name":"go","title":"Go"}]}}"#;

#[test]
fn settings_rows_validate_save_and_reach_the_running_plugin() {
    use ardia_ui::plugins::model::{SettingKind, SettingValue};
    let dir = tempfile::tempdir().unwrap();
    write_plugin(
        dir.path(),
        "knobs",
        KNOBS,
        &[
            (
                "h.sh",
                "while read -r l <&3; do echo \"$l\" >> \"$HOME/got.txt\"; done\n",
            ),
            ("index.html", "<p>hi</p>"),
        ],
    );
    let (service, env) = service(dir.path());
    service.start();
    assert!(PluginHost::setting_rows(service.as_ref(), "knobs").is_empty());
    approve(&service, "knobs");
    let rows = PluginHost::setting_rows(service.as_ref(), "knobs");
    let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
    assert_eq!(keys, vec!["loud", "side", "count", "name", "token"]);
    assert_eq!(rows[2].value, SettingValue::Number(3.0));
    assert!(matches!(rows[4].kind, SettingKind::Secret { .. }));
    wait_for(|| {
        matches!(
            service.process_state("knobs"),
            Some(ProcessState::Running { .. })
        )
    });
    let set = |key: &str, value: SettingValue| {
        PluginHost::set_setting(service.as_ref(), "knobs", key, value)
    };
    assert!(set("side", SettingValue::Text("right".into())));
    assert!(set("count", SettingValue::Number(7.0)));
    assert!(set("loud", SettingValue::Bool(true)));
    for (key, hostile) in [
        ("side", SettingValue::Text("up".into())),
        ("side", SettingValue::Bool(true)),
        ("count", SettingValue::Number(11.0)),
        ("count", SettingValue::Number(f64::NAN)),
        ("count", SettingValue::Number(1e300)),
        ("loud", SettingValue::Text("yes".into())),
        ("name", SettingValue::Text("a\u{202e}b".into())),
        ("name", SettingValue::Text("x".repeat(100_000))),
        ("token", SettingValue::Text("leak".into())),
        ("nope", SettingValue::Bool(true)),
        ("__proto__", SettingValue::Bool(true)),
    ] {
        assert!(!set(key, hostile.clone()), "{key} took {hostile:?}");
    }
    assert!(!PluginHost::set_setting(
        service.as_ref(),
        "ghost",
        "loud",
        SettingValue::Bool(true)
    ));
    let saved = read_records(&service.folders().data_dir);
    assert_eq!(saved["knobs"].values["side"], json!("right"));
    assert_eq!(saved["knobs"].values["count"], json!(7));
    assert!(!saved["knobs"].values.contains_key("token"));
    let got = service
        .folders()
        .data_dir
        .join("PluginData/knobs/home/got.txt");
    wait_for(|| {
        std::fs::read_to_string(&got)
            .is_ok_and(|t| t.contains("plugin.values") && t.contains("\"loud\":true"))
    });
    let text = std::fs::read_to_string(&got).unwrap();
    assert!(!text.contains("token"), "{text}");
    assert!(!PluginHost::secret_row_is_set(
        service.as_ref(),
        "knobs",
        "token"
    ));
    assert!(PluginHost::set_secret_row(service.as_ref(), "knobs", "token", Some("s3")).is_ok());
    assert!(PluginHost::secret_row_is_set(
        service.as_ref(),
        "knobs",
        "token"
    ));
    assert!(PluginHost::set_secret_row(service.as_ref(), "knobs", "name", Some("s3")).is_err());
    assert!(PluginHost::set_secret_row(service.as_ref(), "knobs", "../x", Some("s3")).is_err());
    assert!(
        PluginHost::set_secret_row(
            service.as_ref(),
            "knobs",
            "token",
            Some(&"x".repeat(17 * 1024))
        )
        .is_err()
    );
    assert!(PluginHost::set_secret_row(service.as_ref(), "knobs", "token", None).is_ok());
    assert!(!PluginHost::secret_row_is_set(
        service.as_ref(),
        "knobs",
        "token"
    ));
    let actions = PluginHost::bar_actions(service.as_ref());
    let shown: Vec<(&str, &str)> = actions
        .iter()
        .map(|a| (a.action.as_str(), a.title.as_str()))
        .collect();
    assert_eq!(shown, vec![(":page", "Open Knobs Home"), ("go", "Go")]);
    assert_eq!(
        actions[1].keywords,
        vec!["run".to_owned(), "Knobs".to_owned()]
    );
    assert_eq!(actions[1].when.as_deref(), Some("urlHost == 'example.com'"));
    PluginHost::open_plugin_page(service.as_ref(), &WindowId::new("private"), "knobs");
    PluginHost::open_plugin_page(service.as_ref(), &WindowId::new("w1"), "knobs");
    assert_eq!(
        env.opened.lock().clone(),
        vec![(WindowId::new("w1"), "ardia://knobs".to_owned())]
    );
    service.stop_all();
}

#[test]
fn an_approved_plugin_turns_back_on_without_asking() {
    let dir = tempfile::tempdir().unwrap();
    write_plugin(
        dir.path(),
        "knobs",
        KNOBS,
        &[
            ("h.sh", "while read -r l <&3; do :; done\n"),
            ("index.html", ""),
        ],
    );
    let (service, _env) = service(dir.path());
    service.start();
    assert!(!PluginHost::turn_on_approved(service.as_ref(), "knobs"));
    approve(&service, "knobs");
    assert!(!PluginHost::turn_on_approved(service.as_ref(), "knobs"));
    assert!(service.turn_plugin_off("knobs"));
    assert!(PluginHost::setting_rows(service.as_ref(), "knobs").is_empty());
    assert!(PluginHost::turn_on_approved(service.as_ref(), "knobs"));
    assert_eq!(PluginHost::setting_rows(service.as_ref(), "knobs").len(), 5);
    assert!(read_records(&service.folders().data_dir)["knobs"].enabled);
    service.stop_all();
    write_plugin(
        dir.path(),
        "knobs",
        &KNOBS.replace("\"title\":\"Knobs\"", "\"title\":\"Knobs 2\""),
        &[
            ("h.sh", "while read -r l <&3; do :; done\n"),
            ("index.html", ""),
        ],
    );
    assert!(service.turn_plugin_off("knobs"));
    service.rescan();
    assert!(!PluginHost::turn_on_approved(service.as_ref(), "knobs"));
}

mod handed_page_contexts {
    use super::*;

    const PAGER: &str = r#"{"manifest":2,"name":"pager","title":"Pager","permissions":{"tabs":"read"},
"contributes":{"panels":[{"id":"default","mode":"tab","title":"Pager","icon":"doc","file":"index.html"}],
 "commands":[{"name":"open","title":"Open Pager","open":"tab","context":true}]}}"#;

    #[test]
    fn a_handed_tab_lives_only_while_the_page_and_approval_last() {
        let dir = tempfile::tempdir().unwrap();
        write_plugin(dir.path(), "pager", PAGER, &[("index.html", "<p>hi</p>")]);
        let (service, env) = service(dir.path());
        service.start();
        approve(&service, "pager");
        let page = TabId::new("page");
        env.urls.lock().insert(page.clone(), "ardia://pager".into());
        service.hand_context(
            &page,
            "pager",
            "ardia://pager",
            Some(super::super::page_contexts::PageContext {
                tab_id: TabId::new("source"),
                url: "https://example.com/a/b?secret=1".into(),
                title: "Example".into(),
            }),
        );
        let shown = service.shown_page_context(&page, "pager").expect("handed");
        let shown: Value = serde_json::from_str(&shown).unwrap();
        assert_eq!(shown["tabId"], "source");
        assert!(!shown["url"].as_str().unwrap().contains("secret"));
        assert!(service.shown_page_context(&page, "other").is_none());
        match PluginHost::page(service.as_ref(), &page, "pager") {
            Some(PluginPageState::File { context, .. }) => assert!(context.is_some()),
            other => panic!("{other:?}"),
        }
        env.urls.lock().insert(page.clone(), "https://elsewhere.com".into());
        assert!(service.shown_page_context(&page, "pager").is_none());
        env.urls.lock().insert(page.clone(), "ardia://pager".into());
        assert!(service.shown_page_context(&page, "pager").is_none());
        service.hand_context(
            &page,
            "pager",
            "ardia://pager",
            Some(super::super::page_contexts::PageContext {
                tab_id: TabId::new("source"),
                url: "https://example.com".into(),
                title: "Example".into(),
            }),
        );
        assert!(service.turn_plugin_off("pager"));
        assert!(service.state.lock().page_contexts.is_empty());
        service.stop_all();
    }
}
