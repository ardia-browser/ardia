mod support;

use serde_json::{json, Value};
use std::time::{Duration, Instant};
use support::{repo_dir, sdk_bench, Host};

const WAIT: Duration = Duration::from_secs(5);

fn count_nodes(value: &Value) -> usize {
    match value {
        Value::Object(map) => usize::from(map.contains_key("type") && map.contains_key("props")) + map.values().map(count_nodes).sum::<usize>(),
        Value::Array(items) => items.iter().map(count_nodes).sum(),
        _ => 0,
    }
}

fn find_handler(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let (1, Some(Value::String(id))) = (map.len(), map.get("__handler")) {
                return Some(id.clone());
            }
            map.values().find_map(find_handler)
        }
        Value::Array(items) => items.iter().find_map(find_handler),
        _ => None,
    }
}

fn render_for(host: &mut Host, surface: &str) -> Value {
    let deadline = Instant::now() + WAIT;
    loop {
        let render = host.request("surface.render", deadline.saturating_duration_since(Instant::now()));
        host.reply(&render, Value::Null);
        if render["params"]["surfaceId"] == surface {
            return render;
        }
    }
}

#[test]
fn the_v2_showcase_runs_hello_activate_command_render_and_stop() {
    let folder = repo_dir().join("tests/fixtures/plugins/v2-showcase");
    let mut host = Host::spawn(&folder, "dist/index.js", &[]);
    let hello = host.request("hello", WAIT);
    host.reply(&hello, json!({ "app": "Ardia", "version": "test", "protocol": 2, "plugin": "v2-showcase", "values": { "countVisits": true } }));
    let toolbar = host.request("toolbar.update", WAIT);
    assert_eq!(toolbar["params"]["itemId"], "showcase");
    host.reply(&toolbar, Value::Null);
    let ready = host.request("ready", WAIT);
    let commands: Vec<&str> = ready["params"]["commands"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(commands.contains(&"open-sidecar") && commands.contains(&"pick-tab"), "{ready}");
    assert_eq!(ready["params"]["views"], json!(["sidebar", "toolbar-popover", "repo-browser"]));
    assert_eq!(ready["params"]["omnibox"], true);
    host.reply(&ready, Value::Null);

    host.send(&json!({ "call": "c1", "kind": "command", "name": "open-sidecar" }));
    let panel = host.request("panel.open", WAIT);
    assert_eq!(panel["params"]["panelId"], "sidecar");
    host.reply(&panel, json!({ "ok": true, "windowId": "w1" }));
    let result = host.request("result", WAIT);
    assert_eq!(result["params"]["call"], "c1");
    assert_eq!(result["params"]["result"]["ok"], true);
    host.reply(&result, Value::Null);

    host.send(&json!({ "surface": "mount", "surfaceId": "s1", "viewId": "sidebar", "kind": "sidebar" }));
    let render = render_for(&mut host, "s1");
    let tree = render["params"]["tree"].to_string();
    assert!(tree.contains("\"SidebarView\""), "{tree}");
    assert!(tree.contains("Starred repositories"), "{tree}");

    host.send(&json!({ "event": "plugin.stopping", "time": 0, "data": {} }));
    std::thread::sleep(Duration::from_millis(120));
    host.close();
    let ended = host.end(WAIT);
    assert_eq!(ended.code, Some(0), "{}", ended.stderr);
}

#[test]
fn the_sdk_bench_commits_a_cap_sized_tree_updates_a_thousand_rows_and_deactivates_in_time() {
    let mut host = Host::spawn(&sdk_bench(), "dist/index.js", &[]);
    let hello = host.request("hello", WAIT);
    let cold_start = host.spawned.elapsed();
    host.reply(&hello, json!({ "app": "Ardia", "version": "test", "protocol": 2, "plugin": "sdk-bench", "values": {} }));
    let activated = host.request("storage.set", WAIT);
    assert_eq!(activated["params"]["key"], "activated");
    host.reply(&activated, Value::Null);
    let ready = host.request("ready", WAIT);
    assert_eq!(ready["params"]["commands"], json!(["ping", "spin"]));
    host.reply(&ready, Value::Null);

    host.send(&json!({ "call": "p1", "kind": "command", "name": "ping", "input": 5 }));
    let pong = host.request("result", WAIT);
    assert_eq!(pong["params"], json!({ "call": "p1", "result": { "pong": 5 } }));
    host.reply(&pong, Value::Null);

    let started = Instant::now();
    host.send(&json!({ "surface": "mount", "surfaceId": "cap", "viewId": "cap", "kind": "sidebar" }));
    let cap = render_for(&mut host, "cap");
    let cap_commit = started.elapsed();
    assert_eq!(count_nodes(&cap["params"]["tree"]), 1 + 39 + 39 * 50);

    host.send(&json!({ "surface": "mount", "surfaceId": "rows", "viewId": "rows", "kind": "sidebar" }));
    let rows = render_for(&mut host, "rows");
    let tree = &rows["params"]["tree"];
    assert!(tree.to_string().contains("Row 999 · generation 0"));
    let handler = find_handler(tree).expect("the Bump button's handler");
    let started = Instant::now();
    host.send(&json!({ "surface": "event", "surfaceId": "rows", "handlerId": handler, "args": [] }));
    let updated = render_for(&mut host, "rows");
    let row_update = started.elapsed();
    let text = updated["params"]["tree"].to_string();
    assert!(text.contains("Row 0 · generation 1") && text.contains("Row 999 · generation 1"));
    assert!(!text.contains("generation 0"));

    let started = Instant::now();
    host.send(&json!({ "event": "plugin.stopping", "time": 0, "data": {} }));
    let deactivated = host.request("storage.set", WAIT);
    let stop_latency = started.elapsed();
    assert_eq!(deactivated["params"]["key"], "deactivated");
    assert!(stop_latency <= Duration::from_millis(120), "deactivate took {stop_latency:?}");
    host.reply(&deactivated, Value::Null);
    host.close();
    let ended = host.end(WAIT);
    assert_eq!(ended.code, Some(0), "{}", ended.stderr);
    eprintln!("sdk-bench (test profile): cold start {cold_start:?}, cap commit {cap_commit:?}, 1000-row update {row_update:?}, stopping to deactivate {stop_latency:?}");
}

#[test]
fn sigterm_ends_the_host_normally_even_mid_turn() {
    let mut host = Host::spawn(&sdk_bench(), "dist/index.js", &[]);
    handshake_with_activation(&mut host);
    host.send(&json!({ "call": "s1", "kind": "command", "name": "spin", "input": 1500 }));
    std::thread::sleep(Duration::from_millis(150));
    let sent = Instant::now();
    host.signal(libc::SIGTERM);
    let ended = host.end(WAIT);
    assert_eq!(ended.code, Some(0), "{}", ended.stderr);
    assert!(sent.elapsed() < Duration::from_millis(500), "took {:?}", sent.elapsed());
}

fn handshake_with_activation(host: &mut Host) {
    let hello = host.request("hello", WAIT);
    host.reply(&hello, json!({ "app": "Ardia", "version": "test", "protocol": 2, "plugin": "sdk-bench", "values": {} }));
    let activated = host.request("storage.set", WAIT);
    host.reply(&activated, Value::Null);
    let ready = host.request("ready", WAIT);
    host.reply(&ready, Value::Null);
}

#[test]
fn a_plain_script_handshake_works_without_the_sdk() {
    let folder = support::scratch_plugin("plain", "__ardiaBridge.onLine((line) => __ardiaBridge.send(JSON.stringify({ echo: JSON.parse(line) })));\n__ardiaBridge.send(JSON.stringify({ id: 1, method: 'hello', params: {} }));\n");
    let mut host = Host::spawn(&folder, "main.js", &[]);
    let hello = host.request("hello", WAIT);
    host.send(&json!({ "id": 1, "result": { "ok": true } }));
    let echo = host.expect(WAIT, "the echo");
    assert_eq!(echo["echo"]["result"]["ok"], true, "{hello} {echo}");
}
