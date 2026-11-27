use std::io::Write as _;
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::Value;

pub const COUNT_EVENTS: [&str; 6] = [
    "usage_counts",
    "tab_presses",
    "perf_omnibox",
    "perf_memory",
    "telemetry_local_store",
    "password_import",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Exported {
    pub path: PathBuf,
    pub bytes: u64,
    pub lines: usize,
}

pub fn utc_day(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

pub fn line_time(line: &[u8]) -> Option<f64> {
    let rest = line.strip_prefix(b"{\"at\":")?;
    let digits: Vec<u8> = rest
        .iter()
        .copied()
        .take_while(u8::is_ascii_digit)
        .collect();
    if digits.is_empty() {
        return None;
    }
    std::str::from_utf8(&digits).ok()?.parse().ok()
}

pub fn unsent_count(line: &[u8]) -> bool {
    let Ok(record) = serde_json::from_slice::<Value>(line) else {
        return false;
    };
    record.get("sent") == Some(&Value::Bool(false))
        && record
            .get("event")
            .and_then(Value::as_str)
            .is_some_and(|e| COUNT_EVENTS.contains(&e))
}

fn app_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut files: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let day = name.strip_suffix(".jsonl")?;
            let valid = day.len() == 10
                && day.chars().enumerate().all(|(i, c)| {
                    if i == 4 || i == 7 {
                        c == '-'
                    } else {
                        c.is_ascii_digit()
                    }
                });
            valid.then(|| (day.to_owned(), entry.path()))
        })
        .collect();
    files.sort();
    files
}

pub fn collect(dir: &Path, since: i64) -> (Vec<u8>, usize) {
    let from = utc_day(since);
    let mut out = Vec::new();
    let mut lines = 0;
    for (day, path) in app_files(dir) {
        if day < from {
            continue;
        }
        let Ok(data) = std::fs::read(&path) else {
            continue;
        };
        let mut started = day != from;
        for line in data.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            if !started {
                if line_time(line).unwrap_or(since as f64) < since as f64 {
                    continue;
                }
                started = true;
            }
            if unsent_count(line) {
                continue;
            }
            out.extend_from_slice(line);
            out.push(b'\n');
            lines += 1;
        }
    }
    (out, lines)
}

pub fn export_for_report(data_dir: &Path, since: i64) -> Option<Exported> {
    let local = data_dir.join("Telemetry").join("local");
    let (data, lines) = collect(&local, since);
    let export = data_dir.join("Telemetry").join("export");
    std::fs::create_dir_all(&export).ok()?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&data).ok()?;
    let gz = encoder.finish().ok()?;
    let path = export.join("local-events.jsonl.gz");
    std::fs::write(&path, &gz).ok()?;
    Some(Exported {
        path,
        bytes: gz.len() as u64,
        lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_and_line_times() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(1_790_326_800_000), "2026-09-25");
        assert_eq!(line_time(b"{\"at\":1234,\"event\":\"x\"}"), Some(1234.0));
        assert_eq!(line_time(b"{\"event\":\"x\"}"), None);
        assert!(unsent_count(
            b"{\"at\":1,\"event\":\"usage_counts\",\"sent\":false}"
        ));
        assert!(!unsent_count(
            b"{\"at\":1,\"event\":\"usage_counts\",\"sent\":true}"
        ));
    }

    #[test]
    fn exports_recent_lines_without_unsent_counts() {
        let dir = tempfile::tempdir().expect("dir");
        let local = dir.path().join("Telemetry").join("local");
        std::fs::create_dir_all(&local).expect("dir");
        std::fs::write(
            local.join("1970-01-01.jsonl"),
            "{\"at\":10,\"event\":\"old\"}\n",
        )
        .expect("w");
        std::fs::write(
            local.join("1970-01-02.jsonl"),
            "{\"at\":86400001,\"event\":\"early\"}\n{\"at\":86400500,\"event\":\"kept\"}\n{\"at\":86400600,\"event\":\"usage_counts\",\"sent\":false}\n",
        )
        .expect("w");
        let exported = export_for_report(dir.path(), 86_400_100).expect("exported");
        assert_eq!(exported.lines, 1);
        assert!(
            exported
                .path
                .ends_with("Telemetry/export/local-events.jsonl.gz")
        );
        assert!(exported.bytes > 0);
    }
}
