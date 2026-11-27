use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_telemetry::client::{QUEUE_DOC, SendRule};
use ardia_telemetry::{
    AppInfo, CaptureOptions, Config, Histogram, Poster, PreviousSession, SharingSource, counts,
    perf,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

static SERIAL: Mutex<()> = Mutex::new(());

type Posted = (String, Vec<(String, String)>, String);

#[derive(Default)]
struct Capture {
    bodies: Mutex<Vec<Posted>>,
    status: Mutex<u16>,
}

impl Poster for Capture {
    fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> u16 {
        self.bodies.lock().push((
            url.to_owned(),
            headers
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            String::from_utf8_lossy(body).into_owned(),
        ));
        *self.status.lock()
    }
}

impl Capture {
    fn new(status: u16) -> Arc<Capture> {
        let capture = Arc::new(Capture::default());
        *capture.status.lock() = status;
        capture
    }

    fn events(&self) -> Vec<(String, Map<String, Value>)> {
        let mut out = Vec::new();
        for (_, _, body) in self.bodies.lock().iter() {
            let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
            let scope = &parsed["resourceLogs"][0]["scopeLogs"][0];
            if scope["scope"]["name"] != "ardia.analytics" {
                continue;
            }
            for record in scope["logRecords"].as_array().into_iter().flatten() {
                let mut props = Map::new();
                for attribute in record["attributes"].as_array().into_iter().flatten() {
                    let value = &attribute["value"];
                    let plain = value
                        .get("stringValue")
                        .cloned()
                        .or_else(|| value.get("boolValue").cloned())
                        .or_else(|| {
                            value
                                .get("intValue")
                                .and_then(Value::as_str)
                                .and_then(|n| n.parse::<i64>().ok())
                                .map(Value::from)
                        })
                        .or_else(|| value.get("doubleValue").cloned())
                        .unwrap_or(Value::Null);
                    props.insert(attribute["key"].as_str().unwrap_or("").to_owned(), plain);
                }
                out.push((
                    record["body"]["stringValue"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned(),
                    props,
                ));
            }
        }
        out
    }

    fn names(&self) -> Vec<String> {
        self.events().into_iter().map(|(name, _)| name).collect()
    }
}

fn wait_for(deadline: Duration, check: impl Fn() -> bool) -> bool {
    let until = Instant::now() + deadline;
    while Instant::now() < until {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    check()
}

fn start(dir: &Path, poster: Arc<Capture>) -> ardia_telemetry::ClientSession {
    ardia_telemetry::start(Config {
        data_dir: dir.to_path_buf(),
        info: AppInfo {
            app_version: "9.9.9".into(),
            app_build: Some("gpui".into()),
            dev: false,
            isolated: true,
            ..AppInfo::default()
        },
        url: Some("http://127.0.0.1:9/otel/v1/logs".into()),
        poster: Some(poster),
        continuing: false,
        launch_props: Map::new(),
    })
}

fn flush_and_wait(poster: &Capture, expect: usize) -> bool {
    ardia_telemetry::flush();
    wait_for(Duration::from_secs(3), || {
        poster.bodies.lock().len() >= expect
    })
}

fn sharing_doc(dir: &Path, sharing: bool) {
    std::fs::write(
        dir.join("telemetry.json"),
        json!({"version": 2, "sharing": sharing, "installId": "11111111-2222-4333-8444-555555555555", "decidedAt": 1, "askDoneAt": 1, "lastVersion": "9.9.9", "lastBuild": "gpui"}).to_string(),
    )
    .expect("doc");
}

#[test]
fn sharing_off_sends_nothing_and_keeps_only_the_local_copy() {
    let _serial = SERIAL.lock();
    let dir = tempfile::tempdir().expect("dir");
    sharing_doc(dir.path(), false);
    let poster = Capture::new(200);
    start(dir.path(), poster.clone());
    counts::count("tabs_opened");
    perf::sample("gpui_frame", 12.0);
    ardia_telemetry::capture("translate_used", Map::new());
    ardia_telemetry::hourly();
    assert!(!flush_and_wait(&poster, 1));
    assert!(poster.bodies.lock().is_empty());
    let client = ardia_telemetry::client().expect("client");
    assert!(client.persist_now(Duration::from_secs(2)));
    let local = std::fs::read_dir(dir.path().join("Telemetry/local"))
        .expect("local dir")
        .flatten()
        .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default())
        .collect::<String>();
    assert!(local.contains("\"event\":\"app_launched\""));
    assert!(local.contains("\"sent\":false"));
    assert!(local.contains("\"distinct_id\":null"));
    assert!(!local.contains("usage_counts"));
    ardia_telemetry::client::stop();
}

#[test]
fn nothing_counted_while_off_is_sent_once_sharing_turns_on() {
    let _serial = SERIAL.lock();
    let dir = tempfile::tempdir().expect("dir");
    sharing_doc(dir.path(), false);
    let poster = Capture::new(200);
    start(dir.path(), poster.clone());
    counts::count("tabs_opened");
    counts::add("cli_pill_dismissals", 3);
    perf::sample("gpui_frame", 40.0);
    ardia_telemetry::set_sharing(true, SharingSource::Settings, None);
    counts::count("windows_opened");
    ardia_telemetry::hourly();
    assert!(flush_and_wait(&poster, 1));
    let events = poster.events();
    let names: Vec<&str> = events.iter().map(|(n, _)| n.as_str()).collect();
    assert!(names.contains(&"sharing_turned_on"));
    let usage = &events
        .iter()
        .find(|(n, _)| n == "usage_counts")
        .expect("usage")
        .1;
    assert_eq!(usage.get("windows_opened"), Some(&json!(1)));
    assert!(usage.get("tabs_opened").is_none());
    assert!(usage.get("cli_pill_dismissals").is_none());
    assert!(!names.contains(&"perf_journeys"));
    ardia_telemetry::client::stop();
}

#[test]
fn turning_sharing_off_and_on_again_drops_what_was_counted_before() {
    let _serial = SERIAL.lock();
    let dir = tempfile::tempdir().expect("dir");
    sharing_doc(dir.path(), true);
    let poster = Capture::new(200);
    start(dir.path(), poster.clone());
    let old = ardia_telemetry::consent_now();
    assert!(old.is_some());
    counts::count("tabs_opened");
    ardia_telemetry::capture("translate_used", Map::new());
    ardia_telemetry::set_sharing(false, SharingSource::Settings, None);
    let client = ardia_telemetry::client().expect("client");
    assert!(client.persist_now(Duration::from_secs(2)));
    let queue: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join(QUEUE_DOC)).expect("queue"))
            .expect("json");
    assert_eq!(queue["events"].as_array().map(Vec::len), Some(0));
    ardia_telemetry::set_sharing(true, SharingSource::Settings, None);
    assert_ne!(ardia_telemetry::consent_now(), old);
    counts::add_for(old.as_ref(), "windows_opened", 1);
    client.capture(
        "translate_used",
        &Map::new(),
        old.as_ref(),
        CaptureOptions::default(),
    );
    counts::count("full_screens_entered");
    ardia_telemetry::hourly();
    assert!(flush_and_wait(&poster, 1));
    let events = poster.events();
    let names: Vec<&str> = events.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names.iter().filter(|n| **n == "translate_used").count(), 0);
    let usage = &events
        .iter()
        .find(|(n, _)| n == "usage_counts")
        .expect("usage")
        .1;
    assert_eq!(usage.get("full_screens_entered"), Some(&json!(1)));
    assert!(usage.get("tabs_opened").is_none() && usage.get("windows_opened").is_none());
    ardia_telemetry::client::stop();
}

#[test]
fn a_batch_has_the_old_shape_and_headers() {
    let _serial = SERIAL.lock();
    let dir = tempfile::tempdir().expect("dir");
    sharing_doc(dir.path(), true);
    let poster = Capture::new(200);
    let session = start(dir.path(), poster.clone());
    assert_eq!(session.previous, PreviousSession::Clean);
    let mut props = Map::new();
    props.insert("split_view_closes".into(), json!(2));
    props.insert(
        "title".into(),
        json!("open https://secret.example/path now"),
    );
    props.insert("Not A Key".into(), json!(1));
    props.insert("nested".into(), json!({"a": 1}));
    ardia_telemetry::capture("split_view_opened", props);
    assert!(flush_and_wait(&poster, 1));
    let (url, headers, body) = poster.bodies.lock()[0].clone();
    assert_eq!(url, "http://127.0.0.1:9/otel/v1/logs");
    assert!(headers.contains(&(
        "X-Ardia-Key".into(),
        "ak_app_41b5d0762fd8ade6949ac2ac".into()
    )));
    assert!(headers.contains(&("Content-Type".into(), "application/json".into())));
    let parsed: Value = serde_json::from_str(&body).expect("json");
    let resource: Vec<&str> = parsed["resourceLogs"][0]["resource"]["attributes"]
        .as_array()
        .expect("resource")
        .iter()
        .filter_map(|a| a["key"].as_str())
        .collect();
    assert_eq!(
        resource,
        [
            "service.name",
            "service.version",
            "deployment.environment",
            "os.type",
            "host.arch"
        ]
    );
    let events = poster.events();
    let (_, opened) = events
        .iter()
        .find(|(n, _)| n == "split_view_opened")
        .expect("event");
    assert_eq!(
        opened["distinct_id"],
        "11111111-2222-4333-8444-555555555555"
    );
    assert_eq!(opened["$lib"], "ardia-telemetry");
    assert_eq!(opened["$environment"], "test");
    assert_eq!(opened["$app_version"], "9.9.9");
    assert_eq!(opened["$process_person_profile"], false);
    assert_eq!(opened["$geoip_disable"], true);
    assert_eq!(opened["split_view_closes"], 2);
    assert_eq!(opened["title"], "open <url> now");
    assert!(!opened.contains_key("Not A Key") && !opened.contains_key("nested"));
    assert!(
        opened["$session_id"]
            .as_str()
            .is_some_and(|s| s.len() == 36)
    );
    assert!(!body.contains("secret.example"));
    ardia_telemetry::client::stop();
}

#[test]
fn a_failed_post_keeps_the_batch_and_a_400_drops_it() {
    let _serial = SERIAL.lock();
    let dir = tempfile::tempdir().expect("dir");
    sharing_doc(dir.path(), true);
    let poster = Capture::new(503);
    start(dir.path(), poster.clone());
    ardia_telemetry::capture("translate_used", Map::new());
    assert!(flush_and_wait(&poster, 1));
    let client = ardia_telemetry::client().expect("client");
    assert!(wait_for(Duration::from_secs(3), || client
        .dev_state()
        .queued_events
        >= 2));
    *poster.status.lock() = 400;
    poster.bodies.lock().clear();
    ardia_telemetry::flush();
    assert!(wait_for(Duration::from_secs(3), || !poster
        .bodies
        .lock()
        .is_empty()));
    assert_eq!(
        ardia_telemetry::client::backoff_after(1),
        Duration::from_secs(30)
    );
    assert_eq!(
        ardia_telemetry::client::backoff_after(20),
        Duration::from_secs(1800)
    );
    ardia_telemetry::client::stop();
}

#[test]
fn a_queue_from_an_earlier_period_is_not_sent_after_a_restart() {
    let _serial = SERIAL.lock();
    let dir = tempfile::tempdir().expect("dir");
    sharing_doc(dir.path(), true);
    let poster = Capture::new(503);
    start(dir.path(), poster);
    ardia_telemetry::capture("translate_used", Map::new());
    let client = ardia_telemetry::client().expect("client");
    assert!(client.persist_now(Duration::from_secs(2)));
    ardia_telemetry::client::stop();
    let saved: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("telemetry.json")).expect("doc"),
    )
    .expect("json");
    let mut queue: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join(QUEUE_DOC)).expect("queue"))
            .expect("json");
    assert_eq!(queue["epoch"], saved["epoch"]);
    queue["epoch"] = json!("an-older-period");
    std::fs::write(dir.path().join(QUEUE_DOC), queue.to_string()).expect("write");
    let poster = Capture::new(200);
    start(dir.path(), poster.clone());
    assert!(flush_and_wait(&poster, 1));
    let names = poster.names();
    assert!(!names.contains(&"translate_used".to_owned()));
    assert!(names.contains(&"app_launched".to_owned()));
    ardia_telemetry::client::stop();
}

#[test]
fn sharing_saved_without_an_install_id_reads_as_off_and_turning_on_keeps_the_id() {
    let _serial = SERIAL.lock();
    let dir = tempfile::tempdir().expect("dir");
    std::fs::write(
        dir.path().join("telemetry.json"),
        r#"{"version":2,"sharing":true}"#,
    )
    .expect("doc");
    let poster = Capture::new(200);
    start(dir.path(), poster);
    assert!(!ardia_telemetry::is_sharing());
    assert!(ardia_telemetry::consent_now().is_none());
    ardia_telemetry::set_sharing(true, SharingSource::Onboarding, None);
    let client = ardia_telemetry::client().expect("client");
    let first = client.shown().install_id.expect("id");
    assert_eq!(&first[14..15], "4");
    ardia_telemetry::set_sharing(false, SharingSource::Settings, None);
    ardia_telemetry::set_sharing(true, SharingSource::Settings, None);
    assert_eq!(client.shown().install_id, Some(first.clone()));
    let replaced = client.replace_install_id();
    assert_ne!(replaced, first);
    assert!(client.is_sharing());
    ardia_telemetry::client::stop();
}

#[test]
fn a_newer_state_file_keeps_its_id_and_choice() {
    let _serial = SERIAL.lock();
    let dir = tempfile::tempdir().expect("dir");
    std::fs::write(
        dir.path().join("telemetry.json"),
        r#"{"version":7,"sharing":true,"installId":"keep-me","epoch":"e1","futureField":1}"#,
    )
    .expect("doc");
    let poster = Capture::new(200);
    start(dir.path(), poster);
    let client = ardia_telemetry::client().expect("client");
    assert!(client.is_sharing());
    assert_eq!(client.shown().install_id.as_deref(), Some("keep-me"));
    assert_eq!(client.saved_number("futureField"), Some(1));
    ardia_telemetry::client::stop();
}

#[test]
fn an_unclean_quit_is_reported_and_a_clean_one_is_not() {
    let _serial = SERIAL.lock();
    let dir = tempfile::tempdir().expect("dir");
    sharing_doc(dir.path(), true);
    let poster = Capture::new(200);
    start(dir.path(), poster.clone());
    ardia_telemetry::client::stop();
    let session = start(dir.path(), poster.clone());
    assert_eq!(session.previous, PreviousSession::Unclean);
    assert!(ardia_telemetry::session_ending());
    ardia_telemetry::client::stop();
    let session = start(dir.path(), poster.clone());
    assert_eq!(session.previous, PreviousSession::Clean);
    assert!(flush_and_wait(&poster, 1));
    let events = poster.events();
    assert!(
        events
            .iter()
            .any(|(n, p)| n == "app_launched" && p["previous_session"] == "unclean")
    );
    assert!(events.iter().any(|(n, _)| n == "app_session_ended"));
    ardia_telemetry::client::stop();
}

#[test]
fn perf_summaries_ride_perf_journeys_with_buckets_only() {
    let _serial = SERIAL.lock();
    let dir = tempfile::tempdir().expect("dir");
    sharing_doc(dir.path(), true);
    let poster = Capture::new(200);
    start(dir.path(), poster.clone());
    for ms in [5.0, 10.0, 20.0, 120.0] {
        perf::sample("gpui_frame", ms);
    }
    let mut buckets = [0; perf::BUCKETS];
    buckets[1] = 9;
    buckets[4] = 1;
    perf::submit_histogram(
        "gpui_layout",
        &Histogram {
            buckets,
            max_ms: 80.0,
        },
    );
    perf::sample("Not Valid", 3.0);
    ardia_telemetry::hourly();
    assert!(flush_and_wait(&poster, 1));
    let events = poster.events();
    let (_, journeys) = events
        .iter()
        .find(|(n, _)| n == "perf_journeys")
        .expect("journeys");
    assert_eq!(journeys["gpui_frame_n"], 4);
    assert_eq!(journeys["gpui_frame_p50"], 20);
    assert_eq!(journeys["gpui_frame_max"], 120);
    assert_eq!(journeys["gpui_frame_h8"], 1);
    assert_eq!(journeys["gpui_frame_h250"], 1);
    assert_eq!(journeys["gpui_layout_n"], 10);
    assert_eq!(journeys["gpui_layout_p50"], 16);
    assert_eq!(journeys["gpui_layout_p95"], 80);
    assert!(!journeys.keys().any(|k| k.starts_with("Not")));
    ardia_telemetry::client::stop();
}

#[test]
fn the_daily_ping_has_no_install_id_and_goes_once_a_day() {
    let _serial = SERIAL.lock();
    let dir = tempfile::tempdir().expect("dir");
    sharing_doc(dir.path(), false);
    let poster = Capture::new(200);
    start(dir.path(), poster.clone());
    let client = ardia_telemetry::client().expect("client");
    let now = 1_795_512_295_184;
    use ardia_telemetry::daily::{DailyResult, send_daily_ping};
    assert_eq!(
        send_daily_ping(&client, true, Some("stable"), now),
        DailyResult::Sent
    );
    assert_eq!(
        send_daily_ping(&client, true, Some("stable"), now + 1000),
        DailyResult::Already
    );
    let events = poster.events();
    let (_, ping) = events
        .iter()
        .find(|(n, _)| n == "daily_active")
        .expect("ping");
    assert_eq!(ping["distinct_id"], ping["uuid"]);
    assert_ne!(ping["distinct_id"], "11111111-2222-4333-8444-555555555555");
    assert_eq!(ping["$lib"], "ardia-daily");
    assert_eq!(ping["channel"], "stable");
    assert_eq!(ping["first"], false);
    assert!(!ping.contains_key("$session_id"));
    ardia_telemetry::client::stop();
}

#[test]
fn shipped_builds_post_to_ardia_dev_and_dev_builds_only_dry_run() {
    let shipped = SendRule::new(
        &AppInfo {
            dev: false,
            isolated: false,
            ..AppInfo::default()
        },
        None,
    );
    assert_eq!(shipped.url, "https://ardia.dev/otel/v1/logs");
    assert!(shipped.events && shipped.daily);
    let scratch = SendRule::new(
        &AppInfo {
            dev: false,
            isolated: true,
            ..AppInfo::default()
        },
        None,
    );
    assert!(!scratch.events && !scratch.daily);
    let dev = SendRule::new(
        &AppInfo {
            dev: true,
            ..AppInfo::default()
        },
        None,
    );
    assert!(!dev.events);
}
