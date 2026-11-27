use crate::busy_tabs::CpuReading;

pub fn is_renderer_command(line: &str) -> bool {
    line.contains(" --type=renderer") && !line.contains(" --extension-process")
}

#[cfg(target_os = "macos")]
mod mac {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    use super::is_renderer_command;
    use crate::busy_tabs::CpuReading;

    const PROC_PPID_ONLY: u32 = 6;
    const MAX_CHILDREN: usize = 1024;

    #[derive(Clone, Copy)]
    struct Known {
        started: u64,
        renderer: bool,
    }

    fn known() -> &'static Mutex<HashMap<i32, Known>> {
        static KNOWN: OnceLock<Mutex<HashMap<i32, Known>>> = OnceLock::new();
        KNOWN.get_or_init(|| Mutex::new(HashMap::new()))
    }

    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }

    unsafe extern "C" {
        fn mach_timebase_info(info: *mut Timebase) -> i32;
    }

    fn ticks_to_nanos() -> f64 {
        static RATIO: OnceLock<f64> = OnceLock::new();
        *RATIO.get_or_init(|| {
            let mut info = Timebase { numer: 0, denom: 0 };
            let read = unsafe { mach_timebase_info(&mut info) };
            if read != 0 || info.denom == 0 {
                1.0
            } else {
                f64::from(info.numer) / f64::from(info.denom)
            }
        })
    }

    fn rusage(pid: i32) -> Option<libc::rusage_info_v2> {
        let mut usage: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
        let read = unsafe {
            libc::proc_pid_rusage(
                pid,
                libc::RUSAGE_INFO_V2,
                (&raw mut usage).cast::<libc::rusage_info_t>(),
            )
        };
        (read == 0).then_some(usage)
    }

    fn parent_of(pid: i32) -> Option<i32> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let read = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size)
        };
        (read == size).then_some(info.pbi_ppid as i32)
    }

    fn command_line(pid: i32) -> Option<String> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size: libc::size_t = 0;
        let probe = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                std::ptr::null_mut(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if probe != 0 || size == 0 {
            return None;
        }
        let mut args = vec![0u8; size];
        let read = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                args.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if read != 0 {
            return None;
        }
        args.truncate(size);
        let spaced: Vec<u8> = args
            .iter()
            .map(|b| if *b == 0 { b' ' } else { *b })
            .collect();
        Some(String::from_utf8_lossy(&spaced).into_owned())
    }

    pub fn sample() -> Option<Vec<CpuReading>> {
        let me = std::process::id() as i32;
        let mut pids = vec![0i32; MAX_CHILDREN];
        let bytes = unsafe {
            libc::proc_listpids(
                PROC_PPID_ONLY,
                me as u32,
                pids.as_mut_ptr().cast(),
                (pids.len() * std::mem::size_of::<i32>()) as i32,
            )
        };
        if bytes <= 0 {
            return Some(Vec::new());
        }
        let count = (bytes as usize / std::mem::size_of::<i32>()).min(pids.len());
        let mut known = known().lock().ok()?;
        let mut alive = HashMap::new();
        let mut rows = Vec::new();
        for pid in pids[..count].iter().copied().filter(|pid| *pid > 0) {
            let Some(usage) = rusage(pid) else {
                continue;
            };
            let started = usage.ri_proc_start_abstime;
            let renderer = known
                .get(&pid)
                .filter(|k| k.started == started)
                .map(|k| k.renderer)
                .unwrap_or_else(|| {
                    command_line(pid).is_some_and(|line| is_renderer_command(&line))
                });
            if parent_of(pid) != Some(me)
                || rusage(pid).map(|u| u.ri_proc_start_abstime) != Some(started)
            {
                continue;
            }
            alive.insert(pid, Known { started, renderer });
            if !renderer {
                continue;
            }
            let ticks = usage.ri_user_time.wrapping_add(usage.ri_system_time);
            rows.push(CpuReading {
                pid,
                started: started as f64,
                cpu_ms: ticks as f64 * ticks_to_nanos() / 1_000_000.0,
            });
        }
        *known = alive;
        Some(rows)
    }
}

pub fn sample() -> Option<Vec<CpuReading>> {
    #[cfg(target_os = "macos")]
    {
        mac::sample()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_page_renderers_are_watched() {
        assert!(is_renderer_command("Helper --type=renderer --lang=en"));
        assert!(!is_renderer_command(
            "Helper --type=renderer --extension-process"
        ));
        assert!(!is_renderer_command("Helper --type=gpu-process"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sampling_this_process_works_without_children() {
        assert!(sample().is_some());
    }
}
