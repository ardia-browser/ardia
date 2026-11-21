use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

pub const MAX_TIMERS: usize = 10_000;
pub const MAX_TIMER_MS: f64 = i32::MAX as f64;
pub const TOO_MANY_TIMERS: &str = "a plugin can have at most 10000 timers waiting";

#[derive(Default)]
pub struct Timers {
    order: BTreeMap<(Instant, u64), u64>,
    by_id: HashMap<u64, (Instant, u64)>,
    seq: u64,
}

pub fn clamp_delay(ms: f64) -> Duration {
    let delay = if ms.is_finite() { ms.clamp(0.0, MAX_TIMER_MS) } else { 0.0 };
    Duration::from_millis(delay.trunc() as u64)
}

impl Timers {
    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    pub fn schedule(&mut self, now: Instant, id: f64, ms: f64) -> Result<(), &'static str> {
        let key = id.to_bits();
        if let Some(old) = self.by_id.remove(&key) {
            self.order.remove(&old);
        }
        if self.order.len() >= MAX_TIMERS {
            return Err(TOO_MANY_TIMERS);
        }
        self.seq += 1;
        let slot = (now + clamp_delay(ms), self.seq);
        self.order.insert(slot, key);
        self.by_id.insert(key, slot);
        Ok(())
    }

    pub fn cancel(&mut self, id: f64) -> bool {
        match self.by_id.remove(&id.to_bits()) {
            Some(slot) => self.order.remove(&slot).is_some(),
            None => false,
        }
    }

    pub fn next_due(&self) -> Option<Instant> {
        self.order.keys().next().map(|(due, _)| *due)
    }

    pub fn pop_due(&mut self, now: Instant) -> Option<f64> {
        let (&(due, seq), _) = self.order.iter().next()?;
        if due > now {
            return None;
        }
        let key = self.order.remove(&(due, seq))?;
        self.by_id.remove(&key);
        Some(f64::from_bits(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_clamp_like_the_swift_host() {
        assert_eq!(clamp_delay(-5.0), Duration::ZERO);
        assert_eq!(clamp_delay(f64::NAN), Duration::ZERO);
        assert_eq!(clamp_delay(f64::INFINITY), Duration::ZERO);
        assert_eq!(clamp_delay(1.9), Duration::from_millis(1));
        assert_eq!(clamp_delay(1e12), Duration::from_millis(i32::MAX as u64));
    }

    #[test]
    fn fires_by_due_time_then_by_scheduling_order() {
        let mut timers = Timers::default();
        let start = Instant::now();
        timers.schedule(start, 1.0, 20.0).unwrap();
        timers.schedule(start, 2.0, 0.0).unwrap();
        timers.schedule(start, 3.0, 20.0).unwrap();
        timers.schedule(start, 4.0, 0.0).unwrap();
        timers.schedule(start, 5.0, 10.0).unwrap();
        assert_eq!(timers.pop_due(start), Some(2.0));
        assert_eq!(timers.pop_due(start), Some(4.0));
        assert_eq!(timers.pop_due(start), None);
        let later = start + Duration::from_millis(25);
        let fired: Vec<f64> = std::iter::from_fn(|| timers.pop_due(later)).collect();
        assert_eq!(fired, vec![5.0, 1.0, 3.0]);
        assert!(timers.is_empty());
    }

    #[test]
    fn refuses_past_ten_thousand_waiting() {
        let mut timers = Timers::default();
        let now = Instant::now();
        for id in 0..MAX_TIMERS {
            timers.schedule(now, id as f64, 1000.0).unwrap();
        }
        assert_eq!(timers.schedule(now, 1e9, 0.0), Err(TOO_MANY_TIMERS));
        assert_eq!(timers.len(), MAX_TIMERS);
    }

    #[test]
    fn cancelling_frees_the_slot_and_the_timer_never_fires() {
        let mut timers = Timers::default();
        let now = Instant::now();
        for id in 0..100_000u32 {
            timers.schedule(now, f64::from(id), 1e9).unwrap();
            assert!(timers.cancel(f64::from(id)));
        }
        assert!(timers.is_empty());
        assert_eq!(timers.by_id.len(), 0);
        timers.schedule(now, 1.0, 0.0).unwrap();
        timers.schedule(now, 2.0, 0.0).unwrap();
        assert!(timers.cancel(1.0));
        assert!(!timers.cancel(1.0));
        assert_eq!(timers.pop_due(now), Some(2.0));
        assert_eq!(timers.pop_due(now), None);
    }

    #[test]
    fn rescheduling_an_id_replaces_its_pending_entry() {
        let mut timers = Timers::default();
        let now = Instant::now();
        timers.schedule(now, 7.0, 0.0).unwrap();
        timers.schedule(now, 7.0, 50.0).unwrap();
        assert_eq!(timers.len(), 1);
        assert_eq!(timers.pop_due(now), None);
        assert_eq!(timers.pop_due(now + Duration::from_millis(50)), Some(7.0));
    }
}
