use std::collections::VecDeque;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::Relaxed};
use std::time::Duration;

pub const CAPACITY: usize = 16_384;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Event {
    pub name: &'static str,
    pub start_ns: u64,
    pub dur_ns: u64,
    pub thread: u32,
}

struct Ring {
    events: VecDeque<Event>,
    capacity: usize,
}

static ON: AtomicBool = AtomicBool::new(false);
static RING: Mutex<Ring> = Mutex::new(Ring {
    events: VecDeque::new(),
    capacity: CAPACITY,
});
static PUSHED: AtomicU64 = AtomicU64::new(0);
static NEXT_THREAD: AtomicU32 = AtomicU32::new(1);

thread_local! {
    static THREAD: u32 = NEXT_THREAD.fetch_add(1, Relaxed);
}

#[inline]
pub fn on() -> bool {
    ON.load(Relaxed)
}

pub fn start(capacity: usize) {
    if let Ok(mut ring) = RING.lock() {
        ring.capacity = capacity.max(1);
        ring.events = VecDeque::with_capacity(ring.capacity);
    }
    ON.store(true, Relaxed);
}

pub fn stop() {
    ON.store(false, Relaxed);
    if let Ok(mut ring) = RING.lock() {
        ring.events = VecDeque::new();
    }
}

#[cold]
pub fn push(name: &'static str, start_ns: u64, elapsed: Duration) {
    let event = Event {
        name,
        start_ns,
        dur_ns: u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX),
        thread: THREAD.with(|id| *id),
    };
    let Ok(mut ring) = RING.lock() else {
        return;
    };
    if ring.events.len() >= ring.capacity {
        ring.events.pop_front();
    }
    ring.events.push_back(event);
    PUSHED.fetch_add(1, Relaxed);
}

pub fn pushed() -> u64 {
    PUSHED.load(Relaxed)
}

pub fn events() -> Vec<Event> {
    RING.lock()
        .map(|ring| ring.events.iter().copied().collect())
        .unwrap_or_default()
}

pub fn chrome_json(events: &[Event], pid: u32) -> String {
    let mut out = String::with_capacity(64 + events.len() * 96);
    out.push_str("{\"displayTimeUnit\":\"ms\",\"traceEvents\":[");
    for (index, event) in events.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let line = serde_json::json!({
            "name": event.name,
            "cat": event.name.split('.').next().unwrap_or("span"),
            "ph": "X",
            "ts": event.start_ns as f64 / 1_000.0,
            "dur": event.dur_ns as f64 / 1_000.0,
            "pid": pid,
            "tid": event.thread,
        });
        out.push_str(&line.to_string());
    }
    out.push_str("]}");
    out
}

pub fn write(path: &Path) -> std::io::Result<usize> {
    let events = events();
    let json = chrome_json(&events, std::process::id());
    let partial = path.with_extension("json.partial");
    {
        let mut file = std::fs::File::create(&partial)?;
        file.write_all(json.as_bytes())?;
    }
    std::fs::rename(&partial, path)?;
    Ok(events.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_trace_is_chrome_json_and_never_outgrows_its_ring() {
        let _guard = crate::tests::GLOBALS
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        start(4);
        for n in 0..10u64 {
            push("omnibox.query", n * 1_000, Duration::from_micros(n));
        }
        let kept = events();
        assert_eq!(kept.len(), 4);
        assert_eq!(kept[0].start_ns, 6_000);
        let parsed: serde_json::Value =
            serde_json::from_str(&chrome_json(&kept, 7)).expect("valid json");
        let first = &parsed["traceEvents"][0];
        assert_eq!(first["ph"], "X");
        assert_eq!(first["name"], "omnibox.query");
        assert_eq!(first["cat"], "omnibox");
        assert_eq!(first["ts"], 6.0);
        assert_eq!(first["dur"], 6.0);
        assert_eq!(first["pid"], 7);
        let dir = std::env::temp_dir().join(format!("ardia-trace-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("profile-1.json");
        assert_eq!(write(&path).unwrap(), 4);
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["traceEvents"].as_array().unwrap().len(), 4);
        std::fs::remove_dir_all(&dir).ok();
        stop();
        assert!(events().is_empty());
    }
}
