use std::ffi::c_char;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::{call_json, ffi, status_error};
use crate::abi::c_string;
use crate::error::{EngineError, EngineResult};
use crate::types::NativeWindow;

fn checked(status: ffi::Status) -> EngineResult<()> {
    if status == ffi::OK {
        Ok(())
    } else {
        Err(status_error(status, || {
            EngineError::bad_argument("that object is gone")
        }))
    }
}

pub fn install_background_guard() -> EngineResult<()> {
    checked(unsafe { ffi::ardia_bridge_install_background_guard() })
}

pub fn background_guard_installed() -> bool {
    unsafe { ffi::ardia_bridge_background_guard_installed() }
}

pub fn install_background_guard_if_requested() -> EngineResult<bool> {
    if !crate::launch::is_background() {
        return Ok(false);
    }
    install_background_guard().map(|_| true)
}

pub fn external_url_allowed(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else {
        return false;
    };
    let scheme = scheme.to_ascii_lowercase();
    let valid = !scheme.is_empty()
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    valid
        && !rest.is_empty()
        && !matches!(
            scheme.as_str(),
            "javascript" | "data" | "file" | "blob" | "about" | "vbscript"
        )
}

fn workspace(request: serde_json::Value) -> EngineResult<bool> {
    let value = call_json(
        |json: *const c_char, out| unsafe { ffi::ardia_bridge_workspace(json, out) },
        &request,
        false,
        || EngineError::NotStarted,
    )?;
    Ok(value.as_bool().unwrap_or(false))
}

pub fn open_external_url(url: &str) -> EngineResult<bool> {
    if !external_url_allowed(url) {
        return Err(EngineError::bad_argument(
            "that link can't be handed to another app",
        ));
    }
    workspace(json!({ "op": "openUrl", "url": url }))
}

pub fn open_path(path: &Path) -> EngineResult<bool> {
    if !path.is_absolute() {
        return Err(EngineError::bad_argument("open needs an absolute path"));
    }
    workspace(json!({ "op": "openPath", "path": path }))
}

pub fn reveal_in_finder(paths: &[PathBuf]) -> EngineResult<bool> {
    if paths.is_empty() || paths.iter().any(|path| !path.is_absolute()) {
        return Err(EngineError::bad_argument("reveal needs absolute paths"));
    }
    workspace(json!({ "op": "reveal", "paths": paths }))
}

pub fn install_app_events(urls: bool, reopen: bool) -> EngineResult<()> {
    super::ensure_bridge_host()?;
    checked(unsafe { ffi::ardia_bridge_install_app_events(urls, reopen) })
}

fn live_window(window: &NativeWindow) -> EngineResult<*mut std::ffi::c_void> {
    window.live_object().ok_or_else(|| {
        EngineError::bad_argument("that window must come from the engine or retain_window")
    })
}

pub fn window_levels(window: &NativeWindow) -> EngineResult<(i64, i64)> {
    let window = live_window(window)?;
    let (mut asked, mut actual) = (0, 0);
    checked(unsafe { ffi::ardia_bridge_window_levels(window, &mut asked, &mut actual) })?;
    Ok((asked, actual))
}

pub fn set_handoff(
    window: &NativeWindow,
    url: Option<&str>,
    title: Option<&str>,
) -> EngineResult<()> {
    let window = live_window(window)?;
    let url = url
        .map(|url| c_string(url, "the handoff URL"))
        .transpose()?;
    let title = title
        .map(|title| c_string(title, "the handoff title"))
        .transpose()?;
    checked(unsafe {
        ffi::ardia_bridge_set_handoff(
            window,
            url.as_ref().map_or(std::ptr::null(), |url| url.as_ptr()),
            title
                .as_ref()
                .map_or(std::ptr::null(), |title| title.as_ptr()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_app_links_leave_the_browser() {
        for allowed in [
            "mailto:me@ardia.dev",
            "zoommtg://join?x=1",
            "https://ardia.dev",
            "x-apple.systempreferences:com.apple",
        ] {
            assert!(external_url_allowed(allowed), "{allowed}");
        }
        for refused in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
            "noscheme",
            ":",
            "1abc:x",
            "mailto:",
            "a b:c",
        ] {
            assert!(!external_url_allowed(refused), "{refused}");
        }
        assert!(open_external_url("javascript:alert(1)").is_err());
        assert!(open_path(Path::new("relative")).is_err());
        assert!(reveal_in_finder(&[]).is_err());
        assert!(
            set_handoff(
                &NativeWindow::borrowed(crate::types::NativeWindowHandle::NULL),
                None,
                None
            )
            .is_err()
        );
    }

    #[test]
    fn workspace_calls_off_the_main_thread_fail_cleanly() {
        if super::super::is_main_thread() {
            return;
        }
        assert_eq!(
            open_external_url("mailto:me@ardia.dev"),
            Err(EngineError::WrongThread)
        );
        assert_eq!(
            install_app_events(true, false),
            Err(EngineError::WrongThread)
        );
        assert_eq!(install_background_guard(), Err(EngineError::WrongThread));
    }
}
