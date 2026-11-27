#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MemoryPressure {
    #[default]
    Normal,
    Warning,
    Critical,
}

impl MemoryPressure {
    pub fn from_level(level: i64) -> Self {
        match level {
            2 => MemoryPressure::Warning,
            4 => MemoryPressure::Critical,
            _ => MemoryPressure::Normal,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            MemoryPressure::Normal => "normal",
            MemoryPressure::Warning => "warning",
            MemoryPressure::Critical => "critical",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SystemState {
    pub on_battery: bool,
    pub battery_level: Option<f64>,
    pub low_power_mode: bool,
    pub memory_pressure: MemoryPressure,
    pub physical_memory: u64,
}

pub fn read() -> SystemState {
    #[cfg(target_os = "macos")]
    {
        let (on_battery, battery_level) = mac::battery();
        SystemState {
            on_battery,
            battery_level,
            low_power_mode: mac::low_power_mode(),
            memory_pressure: MemoryPressure::from_level(
                mac::sysctl_number(c"kern.memorystatus_vm_pressure_level").unwrap_or(1),
            ),
            physical_memory: mac::sysctl_number(c"hw.memsize")
                .and_then(|bytes| u64::try_from(bytes).ok())
                .unwrap_or(0),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        SystemState::default()
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{CStr, c_char, c_void};

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};

    type CfRef = *const c_void;

    const UTF8: u32 = 0x0800_0100;
    const NUMBER_DOUBLE: isize = 13;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> CfRef;
        fn IOPSCopyPowerSourcesList(blob: CfRef) -> CfRef;
        fn IOPSGetPowerSourceDescription(blob: CfRef, source: CfRef) -> CfRef;
        fn IOPSGetProvidingPowerSourceType(blob: CfRef) -> CfRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: CfRef);
        fn CFArrayGetCount(array: CfRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CfRef, index: isize) -> CfRef;
        fn CFDictionaryGetValue(dictionary: CfRef, key: CfRef) -> CfRef;
        fn CFNumberGetValue(number: CfRef, kind: isize, out: *mut c_void) -> bool;
        fn CFStringCreateWithCString(allocator: CfRef, text: *const c_char, encoding: u32)
        -> CfRef;
        fn CFStringGetCString(text: CfRef, buffer: *mut c_char, size: isize, encoding: u32)
        -> bool;
    }

    struct Owned(CfRef);

    impl Owned {
        fn new(value: CfRef) -> Option<Self> {
            (!value.is_null()).then_some(Owned(value))
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) };
        }
    }

    fn cf_string(text: &CStr) -> Option<Owned> {
        Owned::new(unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) })
    }

    fn rust_string(text: CfRef) -> Option<String> {
        if text.is_null() {
            return None;
        }
        let mut buffer = [0 as c_char; 64];
        let ok =
            unsafe { CFStringGetCString(text, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) };
        ok.then(|| {
            unsafe { CStr::from_ptr(buffer.as_ptr()) }
                .to_string_lossy()
                .into_owned()
        })
    }

    fn number(dictionary: CfRef, key: &CStr) -> Option<f64> {
        let key = cf_string(key)?;
        let value = unsafe { CFDictionaryGetValue(dictionary, key.0) };
        if value.is_null() {
            return None;
        }
        let mut out = 0f64;
        let ok = unsafe { CFNumberGetValue(value, NUMBER_DOUBLE, (&raw mut out).cast()) };
        ok.then_some(out)
    }

    pub fn battery() -> (bool, Option<f64>) {
        let Some(info) = Owned::new(unsafe { IOPSCopyPowerSourcesInfo() }) else {
            return (false, None);
        };
        let providing = rust_string(unsafe { IOPSGetProvidingPowerSourceType(info.0) });
        let mut level = None;
        if let Some(list) = Owned::new(unsafe { IOPSCopyPowerSourcesList(info.0) }) {
            let type_key = cf_string(c"Type");
            for index in 0..unsafe { CFArrayGetCount(list.0) } {
                let source = unsafe { CFArrayGetValueAtIndex(list.0, index) };
                let description = unsafe { IOPSGetPowerSourceDescription(info.0, source) };
                if description.is_null() {
                    continue;
                }
                let kind = type_key.as_ref().and_then(|key| {
                    rust_string(unsafe { CFDictionaryGetValue(description, key.0) })
                });
                if kind.as_deref() != Some("InternalBattery") {
                    continue;
                }
                if let (Some(current), Some(max)) = (
                    number(description, c"Current Capacity"),
                    number(description, c"Max Capacity"),
                ) && max > 0.0
                {
                    level = Some(current / max);
                }
            }
        }
        (providing.as_deref() == Some("Battery Power"), level)
    }

    pub fn low_power_mode() -> bool {
        let enabled: Bool = unsafe {
            let info: Retained<AnyObject> = msg_send![class!(NSProcessInfo), processInfo];
            msg_send![&*info, isLowPowerModeEnabled]
        };
        enabled.as_bool()
    }

    pub fn sysctl_number(name: &CStr) -> Option<i64> {
        let mut buffer = [0u8; 8];
        let mut size = buffer.len();
        let ok = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } == 0;
        match (ok, size) {
            (true, 4) => Some(i64::from(i32::from_ne_bytes([
                buffer[0], buffer[1], buffer[2], buffer[3],
            ]))),
            (true, 8) => Some(i64::from_ne_bytes(buffer)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pressure_levels_follow_the_kernel_numbers() {
        assert_eq!(MemoryPressure::from_level(1), MemoryPressure::Normal);
        assert_eq!(MemoryPressure::from_level(2), MemoryPressure::Warning);
        assert_eq!(MemoryPressure::from_level(4), MemoryPressure::Critical);
        assert_eq!(MemoryPressure::from_level(-3), MemoryPressure::Normal);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn this_mac_reports_its_memory() {
        let state = read();
        assert!(state.physical_memory > 1 << 30);
        assert!(
            state
                .battery_level
                .is_none_or(|level| (0.0..=1.5).contains(&level))
        );
    }
}
