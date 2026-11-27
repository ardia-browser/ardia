use std::sync::mpsc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

pub const VALIDITY: Duration = Duration::from_secs(60);
pub const REASON: &str = "show your sync recovery phrase";

static GRANTED_AT: Mutex<Option<Instant>> = Mutex::new(None);

pub fn revoke() {
    *GRANTED_AT.lock() = None;
}

pub fn test_grant(test: Option<&str>) -> bool {
    test.is_some_and(|value| {
        value
            .split([',', ';', ' '])
            .any(|part| part.trim() == "reauth=granted")
    })
}

pub fn background() -> bool {
    std::env::var("ARDIA_BACKGROUND").is_ok_and(|v| matches!(v.trim(), "1" | "true" | "yes"))
}

pub fn confirm(reason: &str) -> bool {
    confirm_with(
        reason,
        background(),
        std::env::var("ARDIA_TEST").ok().as_deref(),
        evaluate,
    )
}

pub fn confirm_with(
    reason: &str,
    background: bool,
    test: Option<&str>,
    evaluate: fn(&str) -> bool,
) -> bool {
    if GRANTED_AT.lock().is_some_and(|at| at.elapsed() < VALIDITY) {
        return true;
    }
    let granted = if background {
        let granted = test_grant(test);
        log::info!(
            "[sync] device owner check ({reason}) in a hidden test instance, no prompt: {}",
            if granted { "granted" } else { "denied" }
        );
        granted
    } else {
        evaluate(reason)
    };
    if granted {
        *GRANTED_AT.lock() = Some(Instant::now());
    }
    granted
}

#[cfg(target_os = "macos")]
fn evaluate(reason: &str) -> bool {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;
    const DEVICE_OWNER_AUTHENTICATION: isize = 2;
    unsafe {
        libc::dlopen(
            c"/System/Library/Frameworks/LocalAuthentication.framework/LocalAuthentication"
                .as_ptr(),
            libc::RTLD_LAZY,
        );
    }
    let Some(class) = AnyClass::get(c"LAContext") else {
        return false;
    };
    let context: Option<Retained<AnyObject>> = unsafe { msg_send![class, new] };
    let Some(context) = context else { return false };
    let mut problem: *mut AnyObject = std::ptr::null_mut();
    let can: bool = unsafe {
        msg_send![&*context, canEvaluatePolicy: DEVICE_OWNER_AUTHENTICATION, error: &mut problem]
    };
    if !can {
        log::warn!("[sync] device owner check unavailable");
        return false;
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let block = RcBlock::new(move |granted: Bool, _error: *mut AnyObject| {
        let _ = sender.send(granted.as_bool());
    });
    let reason = NSString::from_str(reason);
    let _: () = unsafe {
        msg_send![&*context, evaluatePolicy: DEVICE_OWNER_AUTHENTICATION, localizedReason: &*reason, reply: &*block]
    };
    let granted = receiver
        .recv_timeout(Duration::from_secs(600))
        .unwrap_or(false);
    drop(context);
    granted
}

#[cfg(not(target_os = "macos"))]
fn evaluate(_reason: &str) -> bool {
    let _ = mpsc::channel::<()>;
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn never(_: &str) -> bool {
        panic!("a hidden instance never prompts")
    }

    fn yes(_: &str) -> bool {
        true
    }

    #[test]
    fn hidden_instances_grant_only_when_the_test_says_so_and_grants_last_a_minute() {
        revoke();
        assert!(!confirm_with(REASON, true, None, never));
        assert!(!confirm_with(REASON, true, Some("reauth=denied"), never));
        assert!(confirm_with(
            REASON,
            true,
            Some("loginsTimeout=1,reauth=granted"),
            never
        ));
        assert!(confirm_with(REASON, false, None, never));
        revoke();
        assert!(confirm_with(REASON, false, None, yes));
        revoke();
    }
}
