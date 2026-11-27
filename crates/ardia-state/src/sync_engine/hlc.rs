use crate::model::Millis;

pub type Hlc = String;

const WALL_DIGITS: usize = 9;
const COUNTER_DIGITS: usize = 4;
const COUNTER_MAX: u64 = 36u64.pow(COUNTER_DIGITS as u32) - 1;

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while n > 0 {
        let d = (n % 36) as u8;
        digits.push(if d < 10 { b'0' + d } else { b'a' + d - 10 });
        n /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

fn parse36(text: &str) -> u64 {
    let mut n: u64 = 0;
    for c in text.chars() {
        let Some(d) = c.to_digit(36) else { break };
        n = n.saturating_mul(36).saturating_add(u64::from(d));
    }
    n
}

pub fn format_hlc(wall: Millis, counter: u64, device: &str) -> Hlc {
    format!(
        "{:0>w$}.{:0>c$}.{device}",
        base36(wall.max(0) as u64),
        base36(counter),
        w = WALL_DIGITS,
        c = COUNTER_DIGITS
    )
}

fn parse_hlc(h: &str) -> (u64, u64) {
    let mut parts = h.split('.');
    let wall = parts.next().map_or(0, parse36);
    let counter = parts.next().map_or(0, parse36);
    (wall, counter)
}

pub fn hlc_wall(h: &str) -> Millis {
    let end = h
        .char_indices()
        .nth(WALL_DIGITS)
        .map_or(h.len(), |(i, _)| i);
    parse36(&h[..end]) as Millis
}

#[derive(Clone, Debug)]
pub struct Clock {
    wall: u64,
    counter: u64,
    device: String,
    now: fn() -> Millis,
}

impl Clock {
    pub fn new(device: &str, last: Option<&str>) -> Clock {
        Clock::with_now(device, last, crate::store::now_ms)
    }

    pub fn with_now(device: &str, last: Option<&str>, now: fn() -> Millis) -> Clock {
        let mut clock = Clock {
            wall: 0,
            counter: 0,
            device: device.to_owned(),
            now,
        };
        if let Some(last) = last.filter(|l| !l.is_empty()) {
            clock.observe(last);
        }
        clock
    }

    pub fn device(&self) -> &str {
        &self.device
    }

    pub fn tick(&mut self) -> Hlc {
        let t = (self.now)().max(0) as u64;
        if t > self.wall {
            self.wall = t;
            self.counter = 0;
        } else if self.counter >= COUNTER_MAX {
            self.wall += 1;
            self.counter = 0;
        } else {
            self.counter += 1;
        }
        format_hlc(self.wall as Millis, self.counter, &self.device)
    }

    pub fn at(&self, time: Millis) -> Hlc {
        format_hlc(time.min((self.now)()), 0, &self.device)
    }

    pub fn observe(&mut self, h: &str) {
        let (wall, counter) = parse_hlc(h);
        if wall > self.wall || (wall == self.wall && counter > self.counter) {
            self.wall = wall;
            self.counter = counter;
        }
    }

    pub fn last(&self) -> Hlc {
        format_hlc(self.wall as Millis, self.counter, &self.device)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed() -> Millis {
        1_790_000_000_000
    }

    #[test]
    fn stamps_match_the_old_format_and_order() {
        let mut clock = Clock::with_now("DEV", None, fixed);
        let a = clock.tick();
        assert_eq!(a, format!("{:0>9}.0000.DEV", base36(1_790_000_000_000)));
        assert_eq!(a.len(), 9 + 1 + 4 + 1 + 3);
        let b = clock.tick();
        assert!(b > a);
        assert_eq!(hlc_wall(&b), 1_790_000_000_000);
        let mut other = Clock::with_now("X", None, fixed);
        other.observe(&format_hlc(1_790_000_000_500, 3, "Y"));
        assert!(other.tick() > format_hlc(1_790_000_000_500, 3, "Y"));
        assert_eq!(clock.at(1_000), format_hlc(1_000, 0, "DEV"));
        assert_eq!(clock.at(i64::MAX), format_hlc(fixed(), 0, "DEV"));
        let mut maxed = Clock::with_now("D", Some(&format_hlc(fixed(), COUNTER_MAX, "D")), fixed);
        assert_eq!(maxed.tick(), format_hlc(fixed() + 1, 0, "D"));
        assert_eq!(parse_hlc("0mwwsalis.0000.dev").0, parse36("0mwwsalis"));
    }
}
