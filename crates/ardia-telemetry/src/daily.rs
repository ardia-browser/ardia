use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::client::{Client, PostKind};
use crate::context::AppInfo;
use crate::ids::{day_start, iso_timestamp, now_ms, utc_day, uuidv4, valid_day};
use crate::store;
use crate::wire::{EVENTS_SCOPE, Outcome, QueuedEvent, event_record, logs_request, outcome};

pub const DAILY_DOC: &str = "telemetry-daily.json";
pub const DAILY_VERSION: u64 = 1;
pub const DAILY_EVENT: &str = "daily_active";
pub const DAILY_LIB: &str = "ardia-daily";
pub const FIRST_PING_DELAY: Duration = Duration::from_secs(30);
pub const MAX_PENDING: usize = 35;
const RECHECK_MS: i64 = 60 * 60_000;
const MIDNIGHT_JITTER_MS: i64 = 5 * 60_000;
const FIRST_RETRY_MS: i64 = 60_000;
const MAX_RETRY_MS: i64 = 60 * 60_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DailyFlags {
    pub first: bool,
    pub weekly: bool,
    pub monthly: bool,
}

pub fn iso_week_monday(day: &str) -> String {
    let start = day_start(day).unwrap_or(0);
    let weekday = (start.div_euclid(86_400_000) + 3).rem_euclid(7);
    utc_day(start - weekday * 86_400_000)
}

pub fn daily_flags(
    last_day: Option<&str>,
    today: &str,
    existing_install: bool,
) -> Option<DailyFlags> {
    let last = last_day.filter(|day| valid_day(day));
    if last.is_some_and(|last| today <= last) {
        return None;
    }
    Some(DailyFlags {
        first: last.is_none() && !existing_install,
        weekly: last.is_none_or(|last| iso_week_monday(last) != iso_week_monday(today)),
        monthly: last.is_none_or(|last| last[..7] != today[..7]),
    })
}

pub fn retry_delay_ms(failures: u32) -> i64 {
    (FIRST_RETRY_MS.saturating_mul(1i64 << failures.saturating_sub(1).min(20))).min(MAX_RETRY_MS)
}

pub fn next_check_delay_ms(now: i64, jitter: f64) -> i64 {
    let midnight = day_start(&utc_day(now)).unwrap_or(now) + 86_400_000;
    RECHECK_MS.min(midnight - now + (jitter * MIDNIGHT_JITTER_MS as f64) as i64)
}

#[derive(Clone, Debug, PartialEq)]
pub struct PendingPing {
    pub day: String,
    pub id: String,
    pub timestamp: String,
    pub properties: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DailyState {
    pub last_day: Option<String>,
    pub pending: Vec<PendingPing>,
}

fn path(dir: &Path) -> PathBuf {
    dir.join(DAILY_DOC)
}

pub fn read_state(dir: &Path) -> DailyState {
    let Some(Value::Object(doc)) = store::read_json(&path(dir)) else {
        return DailyState::default();
    };
    if doc
        .get("version")
        .and_then(Value::as_u64)
        .is_some_and(|v| v > DAILY_VERSION)
    {
        return DailyState::default();
    }
    let last_day = doc
        .get("lastDay")
        .and_then(Value::as_str)
        .filter(|day| valid_day(day))
        .map(str::to_owned);
    let pending = doc
        .get("pending")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let day = item.get("day")?.as_str().filter(|d| valid_day(d))?;
            let id = item.get("id")?.as_str().filter(|id| !id.is_empty())?;
            Some(PendingPing {
                day: day.to_owned(),
                id: id.to_owned(),
                timestamp: item.get("timestamp")?.as_str()?.to_owned(),
                properties: item.get("properties")?.as_object()?.clone(),
            })
        })
        .collect();
    DailyState { last_day, pending }
}

fn save_state(dir: &Path, state: &DailyState) -> bool {
    let doc = json!({
        "lastDay": state.last_day,
        "pending": state.pending.iter().map(|p| json!({
            "day": p.day, "id": p.id, "timestamp": p.timestamp, "properties": p.properties,
        })).collect::<Vec<_>>(),
        "version": DAILY_VERSION,
    });
    serde_json::to_vec(&doc)
        .ok()
        .is_some_and(|bytes| store::write_atomic(&path(dir), &bytes).is_ok())
}

pub fn daily_properties(
    info: &AppInfo,
    flags: DailyFlags,
    channel: Option<&str>,
) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("$lib".into(), json!(DAILY_LIB));
    out.insert("$lib_version".into(), json!("1"));
    out.insert("$app_name".into(), json!("Ardia"));
    out.insert("$app_version".into(), json!(info.app_version));
    out.insert("$os".into(), json!(info.os));
    let major = info
        .os_version
        .as_deref()
        .and_then(|v| v.split('.').next())
        .filter(|m| !m.is_empty());
    out.insert("os_major".into(), json!(major));
    out.insert("arch".into(), json!(info.arch));
    out.insert("channel".into(), json!(channel));
    out.insert("$environment".into(), json!(info.environment().as_str()));
    out.insert("$process_person_profile".into(), json!(false));
    out.insert("$geoip_disable".into(), json!(true));
    out.insert("first".into(), json!(flags.first));
    out.insert("daily".into(), json!(true));
    out.insert("weekly".into(), json!(flags.weekly));
    out.insert("monthly".into(), json!(flags.monthly));
    out
}

pub fn daily_body(info: &AppInfo, ping: &PendingPing) -> String {
    let record = event_record(&QueuedEvent {
        uuid: ping.id.clone(),
        event: DAILY_EVENT.to_owned(),
        distinct_id: ping.id.clone(),
        timestamp: ping.timestamp.clone(),
        properties: ping.properties.clone(),
    });
    logs_request(&info.daily_resource(), EVENTS_SCOPE, &[record])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DailyResult {
    Sent,
    Already,
    Failed,
}

pub fn send_daily_ping(
    client: &Client,
    existing_install: bool,
    channel: Option<&str>,
    now: i64,
) -> DailyResult {
    let dir = client.data_dir();
    let info = client.info();
    let today = utc_day(now);
    let mut state = read_state(dir);
    if let Some(flags) = daily_flags(state.last_day.as_deref(), &today, existing_install) {
        state.pending.push(PendingPing {
            day: today.clone(),
            id: uuidv4(),
            timestamp: iso_timestamp(now),
            properties: daily_properties(&info, flags, channel),
        });
        let keep = state.pending.len().saturating_sub(MAX_PENDING);
        state.pending.drain(..keep);
        state.last_day = Some(today);
        if !save_state(dir, &state) {
            return DailyResult::Failed;
        }
    }
    if state.pending.is_empty() {
        return DailyResult::Already;
    }
    let mut pending = state.pending.clone();
    pending.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    let mut sent = false;
    for ping in pending {
        match outcome(
            client.post(PostKind::Daily, daily_body(&info, &ping).as_bytes()),
            1,
        ) {
            Outcome::Retry | Outcome::Split => return DailyResult::Failed,
            result => sent |= result == Outcome::Sent,
        }
        let mut current = read_state(dir);
        current.pending.retain(|p| p.id != ping.id);
        save_state(dir, &current);
    }
    if sent {
        DailyResult::Sent
    } else {
        DailyResult::Failed
    }
}

pub fn start_daily(
    client: std::sync::Arc<Client>,
    existing_install: bool,
    channel: Option<String>,
) {
    let _ = std::thread::Builder::new()
        .name("ardia-telemetry-daily".into())
        .spawn(move || {
            let mut failures = 0u32;
            std::thread::sleep(FIRST_PING_DELAY);
            loop {
                if crate::client::client()
                    .is_none_or(|current| !std::sync::Arc::ptr_eq(&current, &client))
                {
                    return;
                }
                let result =
                    send_daily_ping(&client, existing_install, channel.as_deref(), now_ms());
                let delay = if result == DailyResult::Failed {
                    failures += 1;
                    retry_delay_ms(failures)
                } else {
                    failures = 0;
                    next_check_delay_ms(now_ms(), (uuidv4().as_bytes()[0] % 100) as f64 / 100.0)
                };
                std::thread::sleep(Duration::from_millis(delay.max(1000) as u64));
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_follow_days_weeks_and_months() {
        assert_eq!(iso_week_monday("2026-11-26"), "2026-11-23");
        assert_eq!(iso_week_monday("2026-11-23"), "2026-11-23");
        assert_eq!(iso_week_monday("2026-11-22"), "2026-11-16");
        assert_eq!(daily_flags(Some("2026-11-26"), "2026-11-26", true), None);
        assert_eq!(
            daily_flags(None, "2026-11-26", false),
            Some(DailyFlags {
                first: true,
                weekly: true,
                monthly: true
            })
        );
        assert_eq!(
            daily_flags(Some("2026-11-25"), "2026-11-26", true),
            Some(DailyFlags {
                first: false,
                weekly: false,
                monthly: false
            })
        );
        assert_eq!(
            daily_flags(Some("2026-11-22"), "2026-12-01", true),
            Some(DailyFlags {
                first: false,
                weekly: true,
                monthly: true
            })
        );
        assert_eq!(retry_delay_ms(1), 60_000);
        assert_eq!(retry_delay_ms(30), 3_600_000);
        assert!(
            next_check_delay_ms(day_start("2026-11-26").unwrap_or(0) + 86_000_000, 0.0) < 1_000_000
        );
    }
}
