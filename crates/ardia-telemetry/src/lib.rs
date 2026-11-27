pub mod choice;
pub mod client;
pub mod consent;
pub mod context;
pub mod counts;
pub mod crash;
pub mod daily;
pub mod ids;
pub mod local;
pub mod native_crash;
pub mod perf;
pub mod sanitize;
pub mod store;
pub mod wire;

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use serde_json::{Map, Value, json};

pub use client::{
    AskPlacement, CaptureOptions, Client, ClientSession, Config, PostKind, Poster, PreviousSession,
    SharingSource, client,
};
pub use consent::{Consent, consent_epoch, consent_now, counted, native_consent, still_valid};
pub use context::AppInfo;
pub use perf::Histogram;

pub const HOUR: Duration = Duration::from_secs(60 * 60);
pub const TEST_ENDPOINT_ENV: &str = "ARDIA_TEST_TELEMETRY_ENDPOINT";

pub const LOCAL_STORE_EVENT: &str = "telemetry_local_store";

static STARTED_AT: AtomicI64 = AtomicI64::new(0);
static COUNTS_SINCE: AtomicI64 = AtomicI64::new(0);
static WATCHING: AtomicBool = AtomicBool::new(false);

pub fn test_endpoint(isolated: bool, value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if !isolated {
        return None;
    }
    let rest = value.strip_prefix("http://")?;
    let host = rest.split(['/', ':']).next()?;
    matches!(host, "127.0.0.1" | "localhost").then(|| value.to_owned())
}

pub fn start(config: Config) -> ClientSession {
    STARTED_AT.store(ids::now_ms(), Ordering::Relaxed);
    COUNTS_SINCE.store(ids::now_ms(), Ordering::Relaxed);
    if !WATCHING.swap(true, Ordering::Relaxed) {
        consent::on_period_change(|| {
            counts::drop_counts();
            perf::drop_all();
        });
    }
    let continuing = config.continuing;
    let launch_props = config.launch_props.clone();
    let (client, session) = client::start(config);
    if !continuing {
        launch_events(&client, &session, launch_props);
    }
    client.every(HOUR, Some(HOUR), hourly);
    session
}

pub fn capture(event: &'static str, props: Map<String, Value>) -> bool {
    capture_for(event, props, consent_now().as_ref())
}

pub fn capture_for(
    event: &'static str,
    props: Map<String, Value>,
    consent: Option<&Consent>,
) -> bool {
    client().is_some_and(|client| client.capture(event, &props, consent, CaptureOptions::default()))
}

pub fn is_sharing() -> bool {
    client().is_some_and(|client| client.is_sharing())
}

pub fn set_sharing(on: bool, source: SharingSource, placement: Option<AskPlacement>) {
    if let Some(client) = client() {
        client.set_sharing(on, source, placement);
    }
}

pub fn dismiss_ask() {
    if let Some(client) = client() {
        client.dismiss_ask();
    }
}

pub fn flush() {
    if let Some(client) = client() {
        client.flush();
    }
}

pub fn reset_anonymous_id(client: &Client) -> String {
    let began = consent_now();
    client.clear_local();
    let shared_throughout = still_valid(began.as_ref());
    let install_id = client.replace_install_id();
    let consent = if shared_throughout {
        consent_now()
    } else {
        None
    };
    client.capture(
        "anonymous_id_reset",
        &Map::new(),
        consent.as_ref(),
        CaptureOptions::default(),
    );
    install_id
}

fn launch_events(client: &Client, session: &ClientSession, extra: Map<String, Value>) {
    let consent = consent_now();
    let mut props = Map::new();
    props.insert("previous_session".into(), json!(session.previous.as_str()));
    for (key, value) in extra {
        props.insert(key, value);
    }
    let info = client.info();
    if let Some(boot) = info.boot_time
        && session.previous == PreviousSession::Unclean
    {
        props.insert(
            "rebooted_since".into(),
            json!(session.last_launch_at.map(|last| boot > last)),
        );
    }
    client.capture(
        "app_launched",
        &props,
        consent.as_ref(),
        CaptureOptions::default(),
    );
    if let Some(from) = &session.updated_from {
        let props = Map::from_iter([("from_version".to_owned(), json!(from))]);
        client.capture(
            "app_updated",
            &props,
            consent.as_ref(),
            CaptureOptions::default(),
        );
    }
}

pub fn emit_usage(consent: Option<&Consent>) {
    let Some(client) = client() else {
        counts::take(None);
        perf::take();
        return;
    };
    let mut usage = counts::take(consent);
    let now = ids::now_ms();
    let since = COUNTS_SINCE.swap(now, Ordering::Relaxed);
    if counts::any_nonzero(&usage) {
        usage.insert(
            "period_minutes".into(),
            json!(((now - since).max(0) as f64 / 60_000.0).round() as i64),
        );
        client.capture("usage_counts", &usage, consent, CaptureOptions::default());
    }
    let journeys = perf::take();
    if !journeys.is_empty() && still_valid(consent) {
        client.capture(
            perf::JOURNEYS_EVENT,
            &journeys,
            consent,
            CaptureOptions::default(),
        );
    }
}

pub fn hourly() {
    emit_usage(consent_now().as_ref());
    report_local_store(consent_now().as_ref());
}

fn timing(ms: f64) -> f64 {
    (ms * 100.0).round() / 100.0
}

pub fn local_store_properties(
    reading: &local::LocalReading,
    posts: (u64, u64, u64),
    queue_bytes: u64,
) -> Map<String, Value> {
    let mut writes = reading.write_ms.clone();
    writes.sort_by(f64::total_cmp);
    let mut flushes = reading.flush_ms.clone();
    flushes.sort_by(f64::total_cmp);
    let p95 = |sorted: &[f64]| {
        (!sorted.is_empty()).then(|| {
            let index = ((0.95 * sorted.len() as f64).floor() as usize).min(sorted.len() - 1);
            timing(sorted[index])
        })
    };
    Map::from_iter([
        ("write_ms_p95".to_owned(), json!(p95(&writes))),
        (
            "write_ms_max".to_owned(),
            json!(writes.last().copied().map(timing)),
        ),
        ("writes".to_owned(), json!(writes.len())),
        ("flush_js_ms_p95".to_owned(), json!(p95(&flushes))),
        ("flushes".to_owned(), json!(reading.meter.flushes)),
        ("prune_ms".to_owned(), json!(timing(reading.prune_ms))),
        ("lines_oversize".to_owned(), json!(reading.meter.oversize)),
        ("lines_recorded".to_owned(), json!(reading.meter.lines)),
        ("bytes_recorded".to_owned(), json!(reading.meter.chars)),
        ("buffered_max".to_owned(), json!(reading.buffered_max)),
        ("write_failures".to_owned(), json!(reading.meter.failures)),
        ("queue_bytes".to_owned(), json!(queue_bytes)),
        ("bytes_posted".to_owned(), json!(posts.0)),
        ("posts".to_owned(), json!(posts.1)),
        ("failed_posts".to_owned(), json!(posts.2)),
    ])
}

pub fn report_local_store(consent: Option<&Consent>) -> bool {
    let Some(client) = client() else {
        return false;
    };
    let Some((reading, queue_bytes)) = client.local_reading() else {
        return false;
    };
    let posts = if still_valid(consent) {
        client.take_post_stats()
    } else {
        (0, 0, 0)
    };
    let props = local_store_properties(&reading, posts, queue_bytes);
    client.capture(
        LOCAL_STORE_EVENT,
        &props,
        consent,
        CaptureOptions::default(),
    )
}

pub fn session_ending() -> bool {
    let Some(client) = client() else {
        return false;
    };
    let consent = consent_now();
    emit_usage(consent.as_ref());
    let minutes = (ids::now_ms() - STARTED_AT.load(Ordering::Relaxed)) / 60_000;
    let props = Map::from_iter([("duration_minutes".to_owned(), json!(minutes))]);
    client.capture(
        "app_session_ended",
        &props,
        consent.as_ref(),
        CaptureOptions::default(),
    );
    client.end_session()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_local_store_report_rounds_timings_and_counts_lines() {
        let reading = local::LocalReading {
            meter: local::LocalMeter {
                lines: 3,
                chars: 120,
                flushes: 2,
                ..local::LocalMeter::default()
            },
            write_ms: vec![1.234, 0.5, 9.876],
            flush_ms: vec![2.0],
            prune_ms: 0.4567,
            buffered_max: 3,
        };
        let props = local_store_properties(&reading, (500, 2, 1), 77);
        assert_eq!(props["write_ms_max"], 9.88);
        assert_eq!(props["write_ms_p95"], 9.88);
        assert_eq!(props["writes"], 3);
        assert_eq!(props["prune_ms"], 0.46);
        assert_eq!(props["lines_recorded"], 3);
        assert_eq!(props["bytes_posted"], 500);
        assert_eq!(props["failed_posts"], 1);
        assert_eq!(props["queue_bytes"], 77);
    }

    #[test]
    fn the_test_endpoint_is_loopback_only_and_only_for_test_instances() {
        assert_eq!(
            test_endpoint(true, Some("http://127.0.0.1:9000/otel")).as_deref(),
            Some("http://127.0.0.1:9000/otel")
        );
        assert!(test_endpoint(true, Some("http://localhost:1/x")).is_some());
        assert!(test_endpoint(false, Some("http://127.0.0.1:9000/otel")).is_none());
        assert!(test_endpoint(true, Some("https://ardia.dev/otel/v1/logs")).is_none());
        assert!(test_endpoint(true, Some("http://evil.example/")).is_none());
        assert!(test_endpoint(true, Some("http://127.0.0.1.evil.example/")).is_none());
        assert!(test_endpoint(true, None).is_none());
    }
}
