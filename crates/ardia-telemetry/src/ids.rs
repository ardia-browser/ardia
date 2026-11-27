use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

pub fn uuidv4() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn uuidv7() -> String {
    uuidv7_at(now_ms())
}

pub fn uuidv7_at(ms: i64) -> String {
    let random = *uuid::Uuid::new_v4().as_bytes();
    let ms = format!("{:012x}", ms.max(0) as u64 & 0xffff_ffff_ffff);
    let hex: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let variant = ["8", "9", "a", "b"][(random[15] % 4) as usize];
    format!(
        "{}-{}-7{}-{variant}{}-{}",
        &ms[0..8],
        &ms[8..12],
        &hex[0..3],
        &hex[3..6],
        &hex[6..18]
    )
}

pub fn utc_day(ms: i64) -> String {
    let (year, month, day) = civil(ms.div_euclid(86_400_000));
    format!("{year:04}-{month:02}-{day:02}")
}

fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn iso_timestamp(ms: i64) -> String {
    let day = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (year, month, date) = civil(day);
    format!(
        "{year:04}-{month:02}-{date:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

pub fn parse_iso(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let number = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    let millis = if bytes.get(19) == Some(&b'.') {
        let digits: String = text[20..]
            .chars()
            .take_while(char::is_ascii_digit)
            .take(3)
            .collect();
        format!("{digits:0<3}").parse::<i64>().ok()?
    } else {
        0
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    Some(
        days_from_civil(year, month, day) * 86_400_000
            + hour * 3_600_000
            + minute * 60_000
            + second * 1000
            + millis,
    )
}

pub fn valid_day(day: &str) -> bool {
    let bytes = day.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
        && parse_iso(&format!("{day}T00:00:00Z")).is_some()
}

pub fn day_start(day: &str) -> Option<i64> {
    parse_iso(&format!("{day}T00:00:00.000Z"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_match_javascript_to_iso_string() {
        assert_eq!(iso_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_timestamp(1_795_524_295_184), "2026-11-24T12:44:55.184Z");
        assert_eq!(
            parse_iso("2026-11-24T12:44:55.184Z"),
            Some(1_795_524_295_184)
        );
        assert_eq!(parse_iso("2026-11-24T12:44:55Z"), Some(1_795_524_295_000));
        assert_eq!(parse_iso("nope"), None);
        assert_eq!(utc_day(1_795_524_295_184), "2026-11-24");
        assert!(valid_day("2026-02-28"));
        assert!(!valid_day("2026-2-28"));
    }

    #[test]
    fn ids_have_the_old_shapes() {
        let v7 = uuidv7_at(1_795_524_295_184);
        assert_eq!(v7.len(), 36);
        assert_eq!(&v7[14..15], "7");
        assert!(matches!(&v7[19..20], "8" | "9" | "a" | "b"));
        assert!(v7.starts_with(&format!("{:08x}", 1_795_524_295_184u64 >> 16)));
        assert_eq!(&uuidv4()[14..15], "4");
    }
}
