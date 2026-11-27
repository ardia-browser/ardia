use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_app::{AppCoordinator, CoordinatorConfig};
use ardia_engine::mock::MockCall;
use ardia_engine::{BrowserEngine, MockBrowserEngine};
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::{BrowserState, BrowserStore};
use ardia_ui::UiHost;
use ardia_ui::site::model::{ContentBlockerCommand, ReloadBlocker};
use serde_json::{Value, json};

fn fresh_store() -> Arc<BrowserStore> {
    Arc::new(BrowserStore::in_memory(
        BrowserState::from_session(
            SessionData::fresh(LoadOptions::default()),
            1_795_000_000_000,
        ),
        IdGen::with_launch("blocker"),
    ))
}

fn scratch_extension() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("ardia-blocker-it-{}", std::process::id()));
    let ext = root.join("Extensions").join("ublock");
    std::fs::create_dir_all(&ext).expect("scratch dir");
    std::fs::write(ext.join("manifest.json"), r#"{"version": "1.77.0"}"#).expect("manifest");
    ext
}

fn harness() -> (Arc<MockBrowserEngine>, Arc<AppCoordinator>) {
    let engine = Arc::new(MockBrowserEngine::started());
    let allowed = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let seen = Arc::clone(&allowed);
    engine.set_evaluator(move |_, code| {
        if !code.contains("chrome-extension://") {
            return Ok(None);
        }
        if code.contains("fetch('/assets/assets.json')") {
            return Ok(Some(json!({"value": {
                "lists": [{"id": "easylist", "title": "EasyList", "group": "ads", "enabled": true, "filters": 10}],
                "networkFilters": 10, "cosmeticFilters": 2, "enabled": true,
                "allowedHosts": seen.lock().clone()
            }})));
        }
        if code.contains("const [allowed, host] = [true, \"news.example\"]") {
            seen.lock().push("news.example".into());
        }
        Ok(Some(json!({"value": Value::Null})))
    });
    let shared: Arc<dyn BrowserEngine> = engine.clone();
    let app = AppCoordinator::new(fresh_store(), shared, CoordinatorConfig::default());
    app.set_content_blocker_extension(Some(scratch_extension()));
    app.start();
    app.pump();
    (engine, app)
}

fn pump_until(app: &AppCoordinator, done: impl Fn(&AppCoordinator) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done(app) {
        assert!(Instant::now() < deadline, "timed out waiting");
        app.pump();
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn the_blocker_reads_state_through_its_hidden_extension_page() {
    let (engine, app) = harness();
    app.refresh_content_blocker();
    pump_until(&app, |app| app.content_blocker().is_some());
    let view = app.content_blocker().expect("a state");
    assert!(view.enabled && view.stats.ready);
    assert_eq!(view.version, "1.77.0");
    assert_eq!(view.lists[0].title, "EasyList");
    assert!(engine.calls().iter().any(|call| matches!(
        call,
        MockCall::Evaluate(_, code) if code.contains("withDeadline(ready(), 'uBlock Origin')")
    )));
}

#[test]
fn allowing_a_site_writes_the_whitelist_and_refreshes_the_state() {
    let (_engine, app) = harness();
    let asked = app.content_blocker_command(ContentBlockerCommand::SetAllowed {
        host: "News.Example".into(),
        allowed: true,
    });
    pump_until(&app, |app| {
        app.content_blocker()
            .is_some_and(|view| view.allows("news.example"))
    });
    drop(asked);
    let view = app.content_blocker();
    assert_eq!(
        ReloadBlocker::of(view.as_ref(), "www.news.example"),
        ReloadBlocker::Off
    );
    assert_eq!(
        ReloadBlocker::of(view.as_ref(), "other.org"),
        ReloadBlocker::On
    );
}
