use std::collections::BTreeMap;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::consent::{self, Consent};

pub const JOURNEYS_EVENT: &str = "perf_journeys";
pub const BUCKET_BOUNDS_MS: [u32; 9] = [8, 16, 33, 50, 100, 250, 500, 1000, 5000];
pub const BUCKETS: usize = BUCKET_BOUNDS_MS.len() + 1;
pub const MAX_SAMPLES: usize = 500;
pub const MAX_METRICS: usize = 64;
const MAX_MS: f64 = 60_000.0;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Metric {
    samples: Vec<u32>,
    buckets: [u64; BUCKETS],
    total: u64,
    max: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Histogram {
    pub buckets: [u64; BUCKETS],
    pub max_ms: f64,
}

#[derive(Default)]
struct Journeys {
    metrics: BTreeMap<&'static str, Metric>,
    counts: BTreeMap<&'static str, u64>,
}

static JOURNEYS: Mutex<Journeys> = Mutex::new(Journeys {
    metrics: BTreeMap::new(),
    counts: BTreeMap::new(),
});

pub fn valid_metric(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=40).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

pub fn bucket_of(ms: u32) -> usize {
    BUCKET_BOUNDS_MS
        .iter()
        .position(|bound| ms <= *bound)
        .unwrap_or(BUCKET_BOUNDS_MS.len())
}

fn metric<'a>(journeys: &'a mut Journeys, name: &'static str) -> Option<&'a mut Metric> {
    if !journeys.metrics.contains_key(name) && journeys.metrics.len() >= MAX_METRICS {
        return None;
    }
    Some(journeys.metrics.entry(name).or_default())
}

pub fn sample(name: &'static str, ms: f64) {
    sample_for(consent::consent_now().as_ref(), name, ms);
}

pub fn sample_for(consent: Option<&Consent>, name: &'static str, ms: f64) {
    if !valid_metric(name) || !(0.0..MAX_MS).contains(&ms) {
        return;
    }
    consent::counted(consent, || {
        let rounded = ms.round() as u32;
        let mut journeys = JOURNEYS.lock();
        let Some(entry) = metric(&mut journeys, name) else {
            return;
        };
        if entry.samples.len() < MAX_SAMPLES {
            entry.samples.push(rounded);
        }
        entry.buckets[bucket_of(rounded)] += 1;
        entry.total += 1;
        entry.max = entry.max.max(rounded);
    });
}

pub fn submit_histogram(name: &'static str, histogram: &Histogram) {
    submit_histogram_for(consent::consent_now().as_ref(), name, histogram);
}

pub fn submit_histogram_for(consent: Option<&Consent>, name: &'static str, histogram: &Histogram) {
    if !valid_metric(name) || !histogram.max_ms.is_finite() {
        return;
    }
    consent::counted(consent, || {
        let mut journeys = JOURNEYS.lock();
        let Some(entry) = metric(&mut journeys, name) else {
            return;
        };
        for (slot, add) in entry.buckets.iter_mut().zip(histogram.buckets) {
            *slot = slot.saturating_add(add);
        }
        entry.total = entry
            .total
            .saturating_add(histogram.buckets.iter().sum::<u64>());
        entry.max = entry.max.max(histogram.max_ms.clamp(0.0, MAX_MS) as u32);
    });
}

pub fn count(what: &'static str) {
    if !valid_metric(what) {
        return;
    }
    consent::counted(consent::consent_now().as_ref(), || {
        *JOURNEYS.lock().counts.entry(what).or_default() += 1;
    });
}

pub fn percentile(sorted: &[u32], p: f64) -> u32 {
    let index = ((p * sorted.len() as f64).floor() as usize).min(sorted.len().saturating_sub(1));
    sorted.get(index).copied().unwrap_or(0)
}

fn bucket_percentile(buckets: &[u64; BUCKETS], total: u64, max: u32, p: f64) -> u32 {
    let rank = ((p * total as f64).floor() as u64).min(total.saturating_sub(1));
    let mut seen = 0;
    for (index, n) in buckets.iter().enumerate() {
        seen += n;
        if seen > rank {
            return BUCKET_BOUNDS_MS.get(index).copied().unwrap_or(max).min(max);
        }
    }
    max
}

pub fn drop_all() {
    let mut journeys = JOURNEYS.lock();
    journeys.metrics.clear();
    journeys.counts.clear();
}

pub fn take() -> Map<String, Value> {
    let journeys = std::mem::take(&mut *JOURNEYS.lock());
    let mut props = Map::new();
    for (name, mut metric) in journeys.metrics {
        if metric.total == 0 {
            continue;
        }
        let exact = metric.samples.len() as u64 == metric.total;
        metric.samples.sort_unstable();
        let at = |p: f64| {
            if exact {
                percentile(&metric.samples, p)
            } else {
                bucket_percentile(&metric.buckets, metric.total, metric.max, p)
            }
        };
        props.insert(format!("{name}_p50"), json!(at(0.5)));
        props.insert(format!("{name}_p75"), json!(at(0.75)));
        props.insert(format!("{name}_p95"), json!(at(0.95)));
        props.insert(format!("{name}_max"), json!(metric.max));
        props.insert(format!("{name}_n"), json!(metric.total));
        for (index, n) in metric.buckets.iter().enumerate() {
            let label = BUCKET_BOUNDS_MS
                .get(index)
                .map_or_else(|| "over".to_owned(), |bound| bound.to_string());
            props.insert(format!("{name}_h{label}"), json!(n));
        }
    }
    for (what, n) in journeys.counts {
        props.insert(what.to_owned(), json!(n));
    }
    props
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain_snake_case() {
        assert!(valid_metric("gpui_frame"));
        assert!(!valid_metric("Frame"));
        assert!(!valid_metric("a b"));
        assert!(!valid_metric("https://x"));
        assert!(!valid_metric(""));
        assert_eq!(bucket_of(0), 0);
        assert_eq!(bucket_of(16), 1);
        assert_eq!(bucket_of(17), 2);
        assert_eq!(bucket_of(9000), 9);
    }

    #[test]
    fn percentiles_match_the_old_transport_rule() {
        let sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        assert_eq!(percentile(&sorted, 0.5), 6);
        assert_eq!(percentile(&sorted, 0.95), 10);
        let mut buckets = [0; BUCKETS];
        buckets[1] = 9;
        buckets[5] = 1;
        assert_eq!(bucket_percentile(&buckets, 10, 200, 0.5), 16);
        assert_eq!(bucket_percentile(&buckets, 10, 200, 0.95), 200);
    }
}
