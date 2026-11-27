use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::ids::{now_ms, utc_day, valid_day};
use crate::store;

pub const LOCAL_MAX_BYTES: u64 = 8 * 1_048_576;
pub const LOCAL_KEEP_DAYS: i64 = 7;
const KEEP_MS: i64 = LOCAL_KEEP_DAYS * 86_400_000;
const FLUSH_DELAY: Duration = Duration::from_secs(10);
const PRUNE_EVERY: Duration = Duration::from_secs(60 * 60);
const MAX_BUFFER_LINES: usize = 2_000;
const MAX_BUFFER_CHARS: usize = 1_000_000;
const MAX_LINE_CHARS: usize = 256_000;
const MAX_TIMINGS: usize = 500;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LocalMeter {
    pub lines: u64,
    pub chars: u64,
    pub oversize: u64,
    pub flushes: u64,
    pub failures: u64,
    pub dropped_lines: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LocalReading {
    pub meter: LocalMeter,
    pub write_ms: Vec<f64>,
    pub flush_ms: Vec<f64>,
    pub prune_ms: f64,
    pub buffered_max: u64,
}

pub struct LocalStore {
    dir: PathBuf,
    buffer: Vec<(String, String)>,
    buffer_chars: usize,
    due: Option<Instant>,
    next_prune: Instant,
    total_bytes: u64,
    pub meter: LocalMeter,
    write_ms: Vec<f64>,
    flush_ms: Vec<f64>,
    buffered_max: u64,
}

fn newlines(bytes: &[u8]) -> u64 {
    bytes.iter().filter(|b| **b == b'\n').count() as u64
}

fn line_time(line: &[u8]) -> Option<i64> {
    let rest = line.strip_prefix(b"{\"at\":")?;
    let digits: Vec<u8> = rest
        .iter()
        .copied()
        .take_while(u8::is_ascii_digit)
        .collect();
    std::str::from_utf8(&digits).ok()?.parse().ok()
}

fn app_files(dir: &Path) -> Vec<(String, PathBuf, u64)> {
    let mut files: Vec<(String, PathBuf, u64)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let day = name.strip_suffix(".jsonl")?;
            valid_day(day).then(|| {
                let size = entry.metadata().map_or(0, |m| m.len());
                (day.to_owned(), entry.path(), size)
            })
        })
        .collect();
    files.sort();
    files
}

impl LocalStore {
    pub fn new(dir: PathBuf) -> LocalStore {
        let total_bytes = app_files(&dir).iter().map(|(_, _, size)| size).sum();
        LocalStore {
            dir,
            buffer: Vec::new(),
            buffer_chars: 0,
            due: None,
            next_prune: Instant::now() + PRUNE_EVERY,
            total_bytes,
            meter: LocalMeter::default(),
            write_ms: Vec::new(),
            flush_ms: Vec::new(),
            buffered_max: 0,
        }
    }

    pub fn due(&self) -> Option<Instant> {
        self.due
    }

    pub fn record(&mut self, day: String, line: String) {
        if line.len() > MAX_LINE_CHARS {
            self.meter.oversize += 1;
            return;
        }
        self.buffer_chars += line.len() + 1;
        self.meter.lines += 1;
        self.meter.chars += line.len() as u64 + 1;
        self.buffer.push((day, line));
        self.buffered_max = self.buffered_max.max(self.buffer.len() as u64);
        if self.buffer.len() >= MAX_BUFFER_LINES || self.buffer_chars >= MAX_BUFFER_CHARS {
            self.flush();
        } else if self.due.is_none() {
            self.due = Some(Instant::now() + FLUSH_DELAY);
        }
    }

    pub fn flush(&mut self) {
        self.due = None;
        if self.buffer.is_empty() {
            return;
        }
        let flush_started = Instant::now();
        let pending = std::mem::take(&mut self.buffer);
        self.buffer_chars = 0;
        let mut by_day: Vec<(String, String)> = Vec::new();
        for (day, line) in pending {
            if !valid_day(&day) {
                continue;
            }
            match by_day.iter_mut().find(|(d, _)| *d == day) {
                Some((_, text)) => {
                    text.push_str(&line);
                    text.push('\n');
                }
                None => by_day.push((day, format!("{line}\n"))),
            }
        }
        let mut written = 0u64;
        for (day, text) in by_day {
            let write_started = Instant::now();
            let appended = store::append(&self.dir.join(format!("{day}.jsonl")), text.as_bytes());
            if self.write_ms.len() < MAX_TIMINGS {
                self.write_ms
                    .push(write_started.elapsed().as_secs_f64() * 1000.0);
            }
            match appended {
                Ok(()) => written += text.len() as u64,
                Err(_) => self.meter.failures += 1,
            }
        }
        self.meter.flushes += 1;
        if self.flush_ms.len() < MAX_TIMINGS {
            self.flush_ms
                .push(flush_started.elapsed().as_secs_f64() * 1000.0);
        }
        self.total_bytes += written;
        if self.total_bytes > LOCAL_MAX_BYTES {
            self.prune(now_ms());
        }
    }

    pub fn prune_if_due(&mut self, now: i64) {
        if Instant::now() >= self.next_prune {
            self.prune(now);
        }
    }

    pub fn prune(&mut self, now: i64) {
        self.next_prune = Instant::now() + PRUNE_EVERY;
        let cutoff = now - KEEP_MS;
        let oldest_day = utc_day(cutoff);
        let newest_day = utc_day(now + 86_400_000);
        let mut files = app_files(&self.dir);
        files.retain(|(day, path, _)| {
            if *day >= oldest_day && *day <= newest_day {
                return true;
            }
            self.meter.dropped_lines += std::fs::read(path).map_or(0, |d| newlines(&d));
            let _ = std::fs::remove_file(path);
            false
        });
        if let Some((day, path, size)) = files.first_mut()
            && *day == oldest_day
            && let Ok(data) = std::fs::read(&*path)
        {
            let mut offset = 0;
            for line in data.split_inclusive(|b| *b == b'\n') {
                if line_time(line).unwrap_or(now) >= cutoff {
                    break;
                }
                offset += line.len();
            }
            if offset > 0 {
                self.meter.dropped_lines += newlines(&data[..offset]);
                let _ = store::write_atomic(path, &data[offset..]);
                *size = (data.len() - offset) as u64;
            }
        }
        let mut total: u64 = files.iter().map(|(_, _, size)| size).sum();
        let target = LOCAL_MAX_BYTES - LOCAL_MAX_BYTES / 10;
        while total > LOCAL_MAX_BYTES && !files.is_empty() {
            let excess = total - target;
            let (_, path, size) = files[0].clone();
            if size <= excess {
                self.meter.dropped_lines += std::fs::read(&path).map_or(0, |d| newlines(&d));
                let _ = std::fs::remove_file(&path);
                total -= size;
                files.remove(0);
                continue;
            }
            let Ok(data) = std::fs::read(&path) else {
                break;
            };
            let mut offset = (excess as usize).min(data.len());
            if offset > 0 && data[offset - 1] != b'\n' {
                offset = data[offset..]
                    .iter()
                    .position(|b| *b == b'\n')
                    .map_or(data.len(), |at| offset + at + 1);
            }
            self.meter.dropped_lines += newlines(&data[..offset]);
            let _ = store::write_atomic(&path, &data[offset..]);
            total -= offset as u64;
            break;
        }
        self.total_bytes = total;
    }

    pub fn take_reading(&mut self, now: i64) -> LocalReading {
        self.flush();
        let started = Instant::now();
        self.prune(now);
        let reading = LocalReading {
            meter: self.meter,
            write_ms: std::mem::take(&mut self.write_ms),
            flush_ms: std::mem::take(&mut self.flush_ms),
            prune_ms: started.elapsed().as_secs_f64() * 1000.0,
            buffered_max: self.buffered_max,
        };
        self.meter = LocalMeter::default();
        self.buffered_max = self.buffer.len() as u64;
        reading
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
        self.buffer_chars = 0;
        self.due = None;
        for (_, path, _) in app_files(&self.dir) {
            let _ = std::fs::remove_file(path);
        }
        self.total_bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_land_in_day_files_and_old_days_are_pruned() {
        let dir = tempfile::tempdir().expect("dir");
        let local = dir.path().join("local");
        let mut store = LocalStore::new(local.clone());
        let now = 1_795_524_295_184;
        store.record(utc_day(now), format!("{{\"at\":{now},\"kind\":\"event\"}}"));
        store.record("../escape".into(), "{}".into());
        store.flush();
        let today =
            std::fs::read_to_string(local.join(format!("{}.jsonl", utc_day(now)))).expect("today");
        assert_eq!(today.lines().count(), 1);
        assert!(!dir.path().join("escape.jsonl").exists());
        std::fs::write(local.join("2020-01-01.jsonl"), "{\"at\":1}\n").expect("old");
        let edge = now - KEEP_MS;
        std::fs::write(
            local.join(format!("{}.jsonl", utc_day(edge))),
            format!("{{\"at\":{}}}\n{{\"at\":{}}}\n", edge - 5, edge + 5),
        )
        .expect("edge");
        store.prune(now);
        assert!(!local.join("2020-01-01.jsonl").exists());
        let kept =
            std::fs::read_to_string(local.join(format!("{}.jsonl", utc_day(edge)))).expect("edge");
        assert_eq!(kept.lines().count(), 1);
        assert_eq!(store.meter.dropped_lines, 2);
    }

    #[test]
    fn oversize_lines_are_dropped() {
        let dir = tempfile::tempdir().expect("dir");
        let mut store = LocalStore::new(dir.path().to_path_buf());
        store.record("2026-11-24".into(), "x".repeat(MAX_LINE_CHARS + 1));
        assert_eq!(store.meter.oversize, 1);
        assert!(store.due().is_none());
    }
}
