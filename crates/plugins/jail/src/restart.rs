use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub const RESTART_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(16),
];
pub const RESTART_WINDOW: Duration = Duration::from_secs(600);
pub const MAX_CONCURRENT_RUNS: usize = 32;
pub const MAX_SPAWNS_PER_SECOND: usize = 10;

#[derive(Default, Debug)]
pub struct RestartBudget {
    restarts: VecDeque<Instant>,
}

impl RestartBudget {
    pub fn next_delay(&mut self, now: Instant) -> Option<Duration> {
        while matches!(self.restarts.front(), Some(at) if now.duration_since(*at) >= RESTART_WINDOW)
        {
            self.restarts.pop_front();
        }
        if self.restarts.len() >= RESTART_DELAYS.len() {
            return None;
        }
        let delay = RESTART_DELAYS[self.restarts.len()];
        self.restarts.push_back(now);
        Some(delay)
    }

    pub fn reset(&mut self) {
        self.restarts.clear();
    }
}

#[derive(Default, Debug)]
pub struct SpawnLimiter {
    recent: VecDeque<Instant>,
}

impl SpawnLimiter {
    pub fn admit(&mut self, running: usize, now: Instant) -> Result<(), &'static str> {
        if running >= MAX_CONCURRENT_RUNS {
            return Err("32 plugin processes are already running");
        }
        while matches!(self.recent.front(), Some(at) if now.duration_since(*at) >= Duration::from_secs(1))
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= MAX_SPAWNS_PER_SECOND {
            return Err("plugins are starting faster than 10 a second");
        }
        self.recent.push_back(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restarts_back_off_and_stop_after_five_in_ten_minutes() {
        let mut budget = RestartBudget::default();
        let start = Instant::now();
        let delays: Vec<_> = (0..5)
            .map(|i| {
                budget
                    .next_delay(start + Duration::from_secs(i))
                    .unwrap()
                    .as_secs()
            })
            .collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 16]);
        assert_eq!(budget.next_delay(start + Duration::from_secs(60)), None);
        assert_eq!(
            budget.next_delay(start + Duration::from_secs(601)),
            Some(Duration::from_secs(8))
        );
        budget.reset();
        assert_eq!(
            budget.next_delay(start + Duration::from_secs(700)),
            Some(Duration::from_secs(1))
        );
    }

    #[test]
    fn spawns_are_capped_by_count_and_rate() {
        let mut limiter = SpawnLimiter::default();
        let now = Instant::now();
        assert!(limiter.admit(32, now).is_err());
        for _ in 0..10 {
            limiter.admit(0, now).unwrap();
        }
        assert!(limiter.admit(0, now).is_err());
        assert!(limiter.admit(0, now + Duration::from_millis(1001)).is_ok());
    }
}
