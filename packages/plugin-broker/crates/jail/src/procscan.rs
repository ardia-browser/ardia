use std::fs;

fn stat_fields(pid: i32) -> Option<Vec<String>> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = text.rfind(')')?;
    Some(
        text[close + 2..]
            .split_whitespace()
            .map(str::to_string)
            .collect(),
    )
}

pub fn parent_of(pid: i32) -> Option<i32> {
    stat_fields(pid)?.get(1)?.parse().ok()
}

pub fn state_of(pid: i32) -> Option<char> {
    stat_fields(pid)?.first()?.chars().next()
}

pub fn is_running(pid: i32) -> bool {
    matches!(state_of(pid), Some(state) if state != 'Z' && state != 'X')
}

pub fn all_pids() -> Vec<i32> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
        .collect()
}

pub fn children_of(parent: i32) -> Vec<i32> {
    all_pids()
        .into_iter()
        .filter(|pid| parent_of(*pid) == Some(parent))
        .collect()
}

pub fn innermost_pid(pid: i32) -> Option<i32> {
    let text = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let line = text.lines().find(|line| line.starts_with("NSpid:"))?;
    line.split_whitespace().last()?.parse().ok()
}

pub fn direct_children(parent: i32) -> Vec<i32> {
    match fs::read_to_string(format!("/proc/{parent}/task/{parent}/children")) {
        Ok(text) => text
            .split_whitespace()
            .filter_map(|pid| pid.parse().ok())
            .collect(),
        Err(_) => children_of(parent),
    }
}

pub fn pid_namespace(pid: i32) -> Option<u64> {
    let link = fs::read_link(format!("/proc/{pid}/ns/pid")).ok()?;
    let text = link.to_str()?;
    text.strip_prefix("pid:[")?.strip_suffix(']')?.parse().ok()
}

pub fn in_namespace(namespace: u64) -> Vec<i32> {
    all_pids()
        .into_iter()
        .filter(|pid| pid_namespace(*pid) == Some(namespace))
        .collect()
}

pub fn pss_bytes(pid: i32) -> u64 {
    let Ok(text) = fs::read_to_string(format!("/proc/{pid}/smaps_rollup")) else {
        return 0;
    };
    text.lines()
        .find_map(|line| line.strip_prefix("Pss:"))
        .and_then(|rest| {
            rest.trim()
                .trim_end_matches("kB")
                .trim()
                .parse::<u64>()
                .ok()
        })
        .map(|kb| kb * 1024)
        .unwrap_or(0)
}

pub fn cmdline_contains(pid: i32, needle: &str) -> bool {
    fs::read(format!("/proc/{pid}/cmdline"))
        .map(|bytes| bytes.split(|b| *b == 0).any(|arg| arg == needle.as_bytes()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_visible() {
        let me = std::process::id() as i32;
        assert!(is_running(me));
        assert_eq!(parent_of(me), Some(unsafe { libc::getppid() }));
        assert!(pid_namespace(me).is_some());
        assert!(in_namespace(pid_namespace(me).unwrap()).contains(&me));
        assert!(pss_bytes(me) > 0);
    }
}
