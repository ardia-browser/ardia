mod support;

use serde_json::Value;
use std::time::Duration;
use support::{crate_dir, Host};

fn rust_report() -> Value {
    let folder = crate_dir().join("tests/conformance");
    let mut host = Host::spawn(&folder, "conformance.js", &[]);
    let message = host.expect(Duration::from_secs(10), "the conformance report");
    host.close();
    message["conformance"].clone()
}

fn vectors() -> Value {
    serde_json::from_str(&std::fs::read_to_string(crate_dir().join("tests/vectors/host-conformance.json")).unwrap()).unwrap()
}

#[test]
fn matches_the_whatwg_vectors_and_records_where_foundation_differs() {
    let rust = rust_report();
    let vectors = vectors();
    let mac = &vectors["mac"];
    let whatwg = &vectors["whatwg"];
    let prelude_limits: Vec<&str> = vectors["preludeLimits"].as_array().unwrap().iter().filter_map(Value::as_str).collect();

    let rust_urls = rust["url"].as_array().unwrap();
    let mac_urls = mac["url"].as_array().unwrap();
    let whatwg_urls = whatwg["url"].as_array().unwrap();
    assert_eq!(rust_urls.len(), whatwg_urls.len());
    let mut foundation_differs = Vec::new();
    for ((ours, theirs), apple) in rust_urls.iter().zip(whatwg_urls).zip(mac_urls) {
        assert_eq!(ours["input"], theirs["input"]);
        let input = ours["input"].as_str().unwrap();
        let expected = if prelude_limits.contains(&input) { apple } else { theirs };
        assert_eq!(ours["result"], expected["result"], "URL {input:?} base {}", ours["base"]);
        if apple["result"] != theirs["result"] {
            foundation_differs.push(format!("{input:?} base {}", ours["base"]));
        }
    }
    for kind in ["btoa", "atob"] {
        let ours = rust["base64"][kind].as_array().unwrap();
        let theirs = whatwg["base64"][kind].as_array().unwrap();
        let apple = mac["base64"][kind].as_array().unwrap();
        for ((o, t), a) in ours.iter().zip(theirs).zip(apple) {
            assert_eq!(o["result"], t["result"], "{kind} {}", o["input"]);
            if a["result"] != t["result"] {
                foundation_differs.push(format!("{kind} {}", o["input"]));
            }
        }
    }
    eprintln!("Foundation differs from WHATWG on {} of {} vectors:\n  {}", foundation_differs.len(), rust_urls.len() + 28, foundation_differs.join("\n  "));
    assert_eq!(foundation_differs.len(), 19);
}

#[test]
fn everything_the_prelude_does_matches_the_swift_host() {
    let rust = rust_report();
    let vectors = vectors();
    let mac = &vectors["mac"];
    for section in ["setters", "params", "text", "misc", "timers"] {
        assert_eq!(rust[section], mac[section], "{section}");
    }
}

#[test]
fn timers_and_promise_jobs_run_in_web_order() {
    let rust = rust_report();
    let expected = [
        "sync-start",
        "async-sync",
        "sync-end",
        "micro-1",
        "micro-2",
        "async-after-await",
        "micro-nested",
        "timeout-0-a",
        "timeout-0-b",
        "timeout-20",
        "micro-in-timeout-20",
        "timeout-nested-0",
        "interval-1",
        "timeout-args:1,2",
        "interval-2",
        "interval-3",
        "end",
    ];
    assert_eq!(rust["timers"], serde_json::json!(expected));
}
