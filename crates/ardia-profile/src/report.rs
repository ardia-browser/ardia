use std::fmt::Write as _;
use std::sync::atomic::Ordering::Relaxed;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::hist::{Snapshot, ms};
use crate::names::{FrameMetric, FrameSlot, Span, field_name};
use crate::record::{
    self, FRAMES, Hang, LONGEST_STALL_US, SLOTS, SPANS, STALL_NAMES, STALLS, now_ns,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Totals {
    pub spans: Vec<Snapshot>,
    pub frames: Vec<Vec<Snapshot>>,
    pub frame_counts: Vec<[u64; 3]>,
    pub stalls: [u64; 6],
    pub longest_stall_us: u64,
}

pub fn totals() -> Totals {
    Totals {
        spans: SPANS.iter().map(|h| h.snapshot()).collect(),
        frames: FRAMES
            .iter()
            .map(|slot| slot.iter().map(|h| h.snapshot()).collect())
            .collect(),
        frame_counts: SLOTS
            .iter()
            .map(|s| {
                [
                    s.frames.load(Relaxed),
                    s.late.load(Relaxed),
                    s.dropped.load(Relaxed),
                ]
            })
            .collect(),
        stalls: std::array::from_fn(|i| STALLS[i].load(Relaxed)),
        longest_stall_us: LONGEST_STALL_US.load(Relaxed),
    }
}

fn stats_json(snapshot: &Snapshot) -> Value {
    json!({
        "count": snapshot.count,
        "mean_ms": ms(snapshot.mean_us()),
        "p50_ms": ms(snapshot.percentile_us(0.5)),
        "p90_ms": ms(snapshot.percentile_us(0.9)),
        "p99_ms": ms(snapshot.percentile_us(0.99)),
        "max_ms": ms(snapshot.max_us),
        "total_ms": ms(snapshot.sum_us),
    })
}

pub fn snapshot_json(mode: &str, started: Option<Instant>) -> Value {
    let now = totals();
    let mut spans = Map::new();
    for span in Span::ALL {
        spans.insert(span.name().into(), stats_json(&now.spans[*span as usize]));
    }
    let mut frames = Map::new();
    for slot in FrameSlot::ALL {
        let index = *slot as usize;
        let [drawn, late, dropped] = now.frame_counts[index];
        let mut entry = Map::new();
        entry.insert("frames".into(), drawn.into());
        entry.insert("late".into(), late.into());
        entry.insert("dropped".into(), dropped.into());
        for metric in FrameMetric::ALL {
            entry.insert(
                metric.name().into(),
                stats_json(&now.frames[index][*metric as usize]),
            );
        }
        frames.insert(slot.name().into(), Value::Object(entry));
    }
    let mut stalls = Map::new();
    for (name, count) in STALL_NAMES.iter().zip(now.stalls) {
        stalls.insert((*name).into(), count.into());
    }
    let at = now_ns();
    let hangs: Vec<Value> = record::recent_hangs()
        .into_iter()
        .map(|hang| {
            json!({
                "ms": ms(hang.us),
                "culprit": hang.culprit,
                "ago_ms": at.saturating_sub(hang.at_ns) / 1_000_000,
            })
        })
        .collect();
    let actions: Vec<Value> = record::actions()
        .into_iter()
        .map(|row| {
            json!({
                "name": row.name,
                "count": row.count,
                "mean_ms": ms(row.total_us.checked_div(row.count).unwrap_or(0)),
                "max_ms": ms(row.max_us),
            })
        })
        .collect();
    json!({
        "enabled": record::ENABLED,
        "mode": mode,
        "uptime_ms": started.map(|s| s.elapsed().as_millis() as u64).unwrap_or(0),
        "memory_bytes": record::static_bytes(),
        "frame_budget_ms": ms(record::FRAME_BUDGET_US),
        "spans": spans,
        "frames": frames,
        "main_thread": {
            "busy_now_ms": record::main_busy_for().map(|d| ms(d.as_micros() as u64)),
            "current_span": record::current_span().map(Span::name),
            "stalls": stalls,
            "longest_stall_ms": ms(now.longest_stall_us),
            "hangs": record::hang_total(),
        },
        "hangs": hangs,
        "actions": actions,
        "trace": {
            "on": crate::trace::on(),
            "events": crate::trace::pushed(),
            "path": crate::trace_path().map(|p| p.display().to_string()),
        },
    })
}

fn line(snapshot: &Snapshot) -> String {
    format!(
        "n {} p50 {} p90 {} p99 {} max {} ms",
        snapshot.count,
        ms(snapshot.percentile_us(0.5)),
        ms(snapshot.percentile_us(0.9)),
        ms(snapshot.percentile_us(0.99)),
        ms(snapshot.max_us)
    )
}

pub fn summary_text(previous: Option<&Totals>, now: &Totals, slowest: usize) -> String {
    let delta = |current: &Snapshot, earlier: Option<&Snapshot>| match earlier {
        Some(earlier) => current.since(earlier),
        None => *current,
    };
    let mut out = String::from("profile summary (since the last one)");
    for slot in FrameSlot::ALL {
        let index = *slot as usize;
        let before = previous.map(|p| p.frame_counts[index]).unwrap_or([0; 3]);
        let counts = now.frame_counts[index];
        let drawn = counts[0].saturating_sub(before[0]);
        if drawn == 0 {
            continue;
        }
        let _ = write!(
            out,
            "\n  frames {}: {} drawn, {} late, {} dropped",
            slot.name(),
            drawn,
            counts[1].saturating_sub(before[1]),
            counts[2].saturating_sub(before[2])
        );
        for metric in FrameMetric::ALL {
            let snapshot = delta(
                &now.frames[index][*metric as usize],
                previous.map(|p| &p.frames[index][*metric as usize]),
            );
            if snapshot.count > 0 {
                let _ = write!(out, "\n    {:<15} {}", metric.name(), line(&snapshot));
            }
        }
    }
    let mut spans: Vec<(Span, Snapshot)> = Span::ALL
        .iter()
        .map(|span| {
            let index = *span as usize;
            (
                *span,
                delta(&now.spans[index], previous.map(|p| &p.spans[index])),
            )
        })
        .filter(|(_, snapshot)| snapshot.count > 0)
        .collect();
    spans.sort_by_key(|(_, snapshot)| std::cmp::Reverse(snapshot.percentile_us(0.99)));
    if !spans.is_empty() {
        out.push_str("\n  slowest spans (by p99):");
        for (span, snapshot) in spans.iter().take(slowest) {
            let _ = write!(out, "\n    {:<28} {}", span.name(), line(snapshot));
        }
    }
    let stalls: u64 = now
        .stalls
        .iter()
        .zip(previous.map(|p| p.stalls).unwrap_or([0; 6]))
        .map(|(n, before)| n.saturating_sub(before))
        .sum();
    if stalls > 0 {
        let _ = write!(out, "\n  main thread stalls over 250 ms: {stalls}");
        let at = now_ns();
        for hang in record::recent_hangs().into_iter().take(5) {
            let _ = write!(
                out,
                "\n    {} ms in {} ({} s ago)",
                ms(hang.us),
                hang.culprit,
                at.saturating_sub(hang.at_ns) / 1_000_000_000
            );
        }
    }
    let actions = record::actions();
    if !actions.is_empty() {
        out.push_str("\n  slowest actions:");
        for row in actions.iter().take(5) {
            let _ = write!(
                out,
                "\n    {:<28} n {} max {} ms",
                row.name,
                row.count,
                ms(row.max_us)
            );
        }
    }
    out
}

fn put_stats(fields: &mut Map<String, Value>, prefix: &str, snapshot: &Snapshot) {
    fields.insert(format!("{prefix}_count"), snapshot.count.into());
    fields.insert(
        format!("{prefix}_p50_ms"),
        ms(snapshot.percentile_us(0.5)).into(),
    );
    fields.insert(
        format!("{prefix}_p95_ms"),
        ms(snapshot.percentile_us(0.95)).into(),
    );
    fields.insert(
        format!("{prefix}_p99_ms"),
        ms(snapshot.percentile_us(0.99)).into(),
    );
    fields.insert(format!("{prefix}_max_ms"), ms(snapshot.max_us).into());
}

pub fn perf_event(previous: &Totals, now: &Totals, interval: Duration) -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert("interval_s".into(), interval.as_secs().into());
    for span in Span::ALL {
        if *span == Span::OmniboxQuery {
            continue;
        }
        let index = *span as usize;
        let delta = now.spans[index].since(&previous.spans[index]);
        if delta.count > 0 {
            put_stats(&mut fields, &field_name(span.name()), &delta);
        }
    }
    for slot in FrameSlot::ALL {
        let index = *slot as usize;
        let drawn = now.frame_counts[index][0].saturating_sub(previous.frame_counts[index][0]);
        if drawn == 0 {
            continue;
        }
        let prefix = format!("frame_{}", slot.name());
        fields.insert(format!("{prefix}_frames"), drawn.into());
        fields.insert(
            format!("{prefix}_late"),
            now.frame_counts[index][1]
                .saturating_sub(previous.frame_counts[index][1])
                .into(),
        );
        fields.insert(
            format!("{prefix}_dropped"),
            now.frame_counts[index][2]
                .saturating_sub(previous.frame_counts[index][2])
                .into(),
        );
        for metric in FrameMetric::ALL {
            let delta = now.frames[index][*metric as usize]
                .since(&previous.frames[index][*metric as usize]);
            if delta.count > 0 {
                put_stats(&mut fields, &format!("{prefix}_{}", metric.name()), &delta);
            }
        }
    }
    let mut any_stall = false;
    for (name, (count, before)) in STALL_NAMES
        .iter()
        .zip(now.stalls.iter().zip(previous.stalls))
    {
        let stalls = count.saturating_sub(before);
        any_stall |= stalls > 0;
        fields.insert(format!("main_stall_{name}"), stalls.into());
    }
    let longest = if any_stall { now.longest_stall_us } else { 0 };
    fields.insert("main_stall_longest_ms".into(), (longest / 1_000).into());
    fields
}

pub fn omnibox_event(previous: &Totals, now: &Totals) -> Option<Map<String, Value>> {
    let index = Span::OmniboxQuery as usize;
    let delta = now.spans[index].since(&previous.spans[index]);
    if delta.count == 0 {
        return None;
    }
    let mut fields = Map::new();
    fields.insert("samples".into(), delta.count.into());
    fields.insert("p50_ms".into(), ms(delta.percentile_us(0.5)).into());
    fields.insert("p95_ms".into(), ms(delta.percentile_us(0.95)).into());
    fields.insert("max_ms".into(), ms(delta.max_us).into());
    Some(fields)
}

const FREEZE_DURATIONS: [(u64, &str); 6] = [
    (1_000, "400ms_1s"),
    (2_000, "1_2s"),
    (5_000, "2_5s"),
    (10_000, "5_10s"),
    (30_000, "10_30s"),
    (u64::MAX, "over_30s"),
];

const UPTIMES: [(u64, &str); 5] = [
    (5, "under_5m"),
    (60, "5_60m"),
    (360, "1_6h"),
    (1_440, "6_24h"),
    (u64::MAX, "over_24h"),
];

fn bucket(table: &[(u64, &'static str)], value: u64) -> &'static str {
    table
        .iter()
        .find(|(limit, _)| value < *limit)
        .map(|(_, name)| *name)
        .unwrap_or("over")
}

pub fn freeze_event(hang: &Hang, uptime: Duration) -> Map<String, Value> {
    let freeze_ms = hang.us / 1_000;
    let mut fields = Map::new();
    fields.insert("freeze_thread".into(), "main".into());
    fields.insert(
        "freeze_duration".into(),
        bucket(&FREEZE_DURATIONS, freeze_ms).into(),
    );
    fields.insert("freeze_ms".into(), freeze_ms.into());
    fields.insert("activity".into(), hang.culprit.into());
    fields.insert(
        "uptime".into(),
        bucket(&UPTIMES, uptime.as_secs() / 60).into(),
    );
    fields
}

pub const PERF_EVENT: &str = "perf_gpui";
pub const OMNIBOX_EVENT: &str = "perf_omnibox";
pub const FREEZE_EVENT: &str = "app_freeze";

pub struct Telemetry {
    baseline: Option<(Totals, Instant)>,
    consent_since_ns: u64,
    started: Instant,
}

impl Telemetry {
    pub fn new(started: Instant) -> Self {
        Self {
            baseline: None,
            consent_since_ns: 0,
            started,
        }
    }

    pub fn tick(
        &mut self,
        sharing: bool,
        now: Instant,
        interval: Duration,
    ) -> Vec<(&'static str, Map<String, Value>)> {
        let hangs = record::take_queued_hangs();
        if !sharing {
            self.baseline = None;
            self.consent_since_ns = 0;
            return Vec::new();
        }
        let mut events = Vec::new();
        if self.consent_since_ns == 0 {
            self.consent_since_ns = record::ns_at(now);
        }
        let uptime = now.saturating_duration_since(self.started);
        for hang in hangs
            .iter()
            .filter(|hang| hang.at_ns >= self.consent_since_ns)
        {
            events.push((FREEZE_EVENT, freeze_event(hang, uptime)));
        }
        match &self.baseline {
            None => self.baseline = Some((totals(), now)),
            Some((previous, since)) if now.saturating_duration_since(*since) >= interval => {
                let current = totals();
                let elapsed = now.saturating_duration_since(*since);
                events.push((PERF_EVENT, perf_event(previous, &current, elapsed)));
                if let Some(omnibox) = omnibox_event(previous, &current) {
                    events.push((OMNIBOX_EVENT, omnibox));
                }
                self.baseline = Some((current, now));
            }
            Some(_) => {}
        }
        events
    }
}
