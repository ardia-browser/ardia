use std::sync::atomic::{AtomicU32, AtomicU64, Ordering::Relaxed};
use std::time::Duration;

pub const BUCKETS: usize = 140;
const LINEAR: u64 = 8;
const MAX_EXP: usize = 35;

pub struct Histogram {
    count: AtomicU64,
    sum_us: AtomicU64,
    max_us: AtomicU64,
    buckets: [AtomicU32; BUCKETS],
}

impl Default for Histogram {
    fn default() -> Self {
        Self::new()
    }
}

impl Histogram {
    pub const fn new() -> Self {
        Self {
            count: AtomicU64::new(0),
            sum_us: AtomicU64::new(0),
            max_us: AtomicU64::new(0),
            buckets: [const { AtomicU32::new(0) }; BUCKETS],
        }
    }

    #[inline]
    pub fn record(&self, elapsed: Duration) {
        self.record_us(u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX));
    }

    #[inline]
    pub fn record_us(&self, us: u64) {
        self.count.fetch_add(1, Relaxed);
        self.sum_us.fetch_add(us, Relaxed);
        self.max_us.fetch_max(us, Relaxed);
        self.buckets[bucket_of(us)].fetch_add(1, Relaxed);
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut buckets = [0u32; BUCKETS];
        for (slot, bucket) in buckets.iter_mut().zip(&self.buckets) {
            *slot = bucket.load(Relaxed);
        }
        Snapshot {
            count: buckets.iter().map(|n| u64::from(*n)).sum(),
            sum_us: self.sum_us.load(Relaxed),
            max_us: self.max_us.load(Relaxed),
            buckets,
        }
    }

    pub fn reset(&self) {
        self.count.store(0, Relaxed);
        self.sum_us.store(0, Relaxed);
        self.max_us.store(0, Relaxed);
        for bucket in &self.buckets {
            bucket.store(0, Relaxed);
        }
    }

    pub fn count(&self) -> u64 {
        self.count.load(Relaxed)
    }
}

#[inline]
pub fn bucket_of(us: u64) -> usize {
    if us < LINEAR {
        return us as usize;
    }
    let exp = 63 - us.leading_zeros() as usize;
    if exp > MAX_EXP {
        return BUCKETS - 1;
    }
    LINEAR as usize + (exp - 3) * 4 + ((us >> (exp - 2)) & 3) as usize
}

pub fn bucket_range(index: usize) -> (u64, u64) {
    if index < LINEAR as usize {
        return (index as u64, index as u64 + 1);
    }
    let offset = index - LINEAR as usize;
    let exp = offset / 4 + 3;
    let sub = (offset % 4) as u64;
    let step = 1u64 << (exp - 2);
    let low = (4 + sub) << (exp - 2);
    (low, low + step)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub count: u64,
    pub sum_us: u64,
    pub max_us: u64,
    pub buckets: [u32; BUCKETS],
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            count: 0,
            sum_us: 0,
            max_us: 0,
            buckets: [0; BUCKETS],
        }
    }
}

impl Snapshot {
    pub fn percentile_us(&self, quantile: f64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let wanted = ((quantile.clamp(0.0, 1.0) * self.count as f64).ceil() as u64).max(1);
        let mut seen = 0u64;
        for (index, n) in self.buckets.iter().enumerate() {
            seen += u64::from(*n);
            if seen >= wanted {
                if bucket_of(self.max_us) == index {
                    return self.max_us;
                }
                let (low, high) = bucket_range(index);
                return low + (high - low) / 2;
            }
        }
        self.max_us
    }

    pub fn mean_us(&self) -> u64 {
        self.sum_us.checked_div(self.count).unwrap_or(0)
    }

    pub fn since(&self, earlier: &Snapshot) -> Snapshot {
        let mut buckets = [0u32; BUCKETS];
        for ((slot, now), before) in buckets.iter_mut().zip(&self.buckets).zip(&earlier.buckets) {
            *slot = now.saturating_sub(*before);
        }
        let count = buckets.iter().map(|n| u64::from(*n)).sum();
        let max_us = buckets
            .iter()
            .rposition(|n| *n > 0)
            .map(|index| bucket_range(index).1.saturating_sub(1).min(self.max_us))
            .unwrap_or(0);
        Snapshot {
            count,
            sum_us: if count == 0 {
                0
            } else {
                self.sum_us.saturating_sub(earlier.sum_us)
            },
            max_us,
            buckets,
        }
    }

    pub fn count_at_least_us(&self, floor_us: u64) -> u64 {
        self.buckets
            .iter()
            .enumerate()
            .filter(|(index, _)| bucket_range(*index).0 >= floor_us)
            .map(|(_, n)| u64::from(*n))
            .sum()
    }
}

pub fn ms(us: u64) -> f64 {
    (us as f64 / 100.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_cover_every_value_in_order_without_gaps() {
        let mut previous_high = 0;
        for index in 0..BUCKETS {
            let (low, high) = bucket_range(index);
            assert_eq!(
                low, previous_high,
                "bucket {index} starts where the last ended"
            );
            assert!(high > low);
            assert_eq!(bucket_of(low), index);
            assert_eq!(bucket_of(high - 1), index);
            previous_high = high;
        }
        assert_eq!(bucket_of(u64::MAX), BUCKETS - 1);
        assert_eq!(bucket_of(1 << 40), BUCKETS - 1);
    }

    #[test]
    fn a_bucket_is_never_wider_than_a_quarter_of_its_start() {
        for index in 8..BUCKETS {
            let (low, high) = bucket_range(index);
            assert!((high - low) * 4 <= low, "bucket {index}: {low}..{high}");
        }
    }

    #[test]
    fn percentiles_land_within_a_bucket_of_the_truth() {
        let histogram = Histogram::new();
        for us in 1..=10_000u64 {
            histogram.record_us(us);
        }
        let snapshot = histogram.snapshot();
        assert_eq!(snapshot.count, 10_000);
        assert_eq!(snapshot.max_us, 10_000);
        assert_eq!(snapshot.mean_us(), 5_000);
        for (quantile, truth) in [(0.5, 5_000.0), (0.9, 9_000.0), (0.99, 9_900.0)] {
            let got = snapshot.percentile_us(quantile) as f64;
            assert!(
                (got - truth).abs() / truth < 0.15,
                "p{quantile}: {got} vs {truth}"
            );
        }
        assert_eq!(snapshot.percentile_us(1.0), 10_000);
        assert_eq!(Snapshot::default().percentile_us(0.5), 0);
    }

    #[test]
    fn a_single_slow_sample_reports_its_own_size() {
        let histogram = Histogram::new();
        histogram.record(Duration::from_millis(1_234));
        let snapshot = histogram.snapshot();
        assert_eq!(snapshot.percentile_us(0.5), 1_234_000);
        assert_eq!(ms(snapshot.max_us), 1234.0);
    }

    #[test]
    fn deltas_count_only_what_came_after() {
        let histogram = Histogram::new();
        histogram.record_us(100);
        histogram.record_us(50_000);
        let before = histogram.snapshot();
        histogram.record_us(200);
        histogram.record_us(300);
        let delta = histogram.snapshot().since(&before);
        assert_eq!(delta.count, 2);
        assert_eq!(delta.sum_us, 500);
        assert!(
            delta.max_us >= 300 && delta.max_us < 400,
            "{}",
            delta.max_us
        );
        assert_eq!(histogram.snapshot().since(&histogram.snapshot()).count, 0);
        assert_eq!(delta.count_at_least_us(250), 1);
    }

    #[test]
    fn histograms_take_samples_from_many_threads() {
        let histogram = std::sync::Arc::new(Histogram::new());
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let histogram = histogram.clone();
                std::thread::spawn(move || {
                    for us in 0..10_000 {
                        histogram.record_us(us);
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(histogram.snapshot().count, 40_000);
        histogram.reset();
        assert_eq!(histogram.snapshot().count, 0);
    }

    #[test]
    fn a_histogram_is_small() {
        assert!(std::mem::size_of::<Histogram>() <= 600);
    }
}
