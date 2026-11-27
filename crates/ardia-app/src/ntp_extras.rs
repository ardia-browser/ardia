use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

use ardia_state::ntp_extras::{self, NtpExtras, NtpExtrasChange};
use ardia_state::persistence::DataDir;
use ardia_state::store::now_ms;
use ardia_state::{ProfileId, ntp_extras::TelemetryChoice};
use parking_lot::Mutex;
use serde_json::{Value, json};

use ardia_telemetry::{AskPlacement, SharingSource};

use crate::coordinator::AppCoordinator;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const SESSION_DOC: &str = "session.json";
const BLOCKED_STATUS: [u64; 2] = [403, 429];
const MAX_SUGGEST_URL: usize = 2048;

struct Store {
    dir: PathBuf,
    extras: Mutex<NtpExtras>,
}

static STORE: OnceLock<Store> = OnceLock::new();
static NEXT_SUGGEST: AtomicU64 = AtomicU64::new(1);

fn store(dir: &Path) -> &'static Store {
    STORE.get_or_init(|| {
        let has_session = dir.join(SESSION_DOC).exists();
        Store {
            dir: dir.to_path_buf(),
            extras: Mutex::new(ntp_extras::load_ntp_extras(
                &DataDir::new(dir),
                APP_VERSION,
                has_session,
                now_ms(),
            )),
        }
    })
}

pub fn extras(dir: &Path) -> NtpExtras {
    *store(dir).extras.lock()
}

pub fn change(dir: &Path, change: NtpExtrasChange) {
    let shown = store(dir);
    shown.extras.lock().apply(change);
    let handled = match change {
        NtpExtrasChange::TelemetryShare => {
            crate::telemetry::set_sharing(&shown.dir, true, SharingSource::Ask, None)
        }
        NtpExtrasChange::TelemetryNotNow => {
            crate::telemetry::set_sharing(&shown.dir, false, SharingSource::Ask, None)
        }
        NtpExtrasChange::TelemetryAskDismissed => crate::telemetry::dismiss_ask(&shown.dir),
        _ => false,
    };
    if handled {
        return;
    }
    let folder = shown.dir.clone();
    std::thread::spawn(move || {
        ntp_extras::persist_change(
            &DataDir::new(&folder),
            change,
            now_ms(),
            APP_VERSION,
            || uuid::Uuid::new_v4().to_string(),
        );
    });
}

pub fn sharing(dir: &Path) -> bool {
    extras(dir).telemetry.sharing
}

pub fn set_sharing(dir: &Path, on: bool, source: SharingSource, placement: Option<AskPlacement>) {
    let shown = store(dir);
    {
        let mut extras = shown.extras.lock();
        extras.telemetry = TelemetryChoice {
            sharing: on,
            decided: true,
            ask_done: true,
        };
    }
    if crate::telemetry::set_sharing(&shown.dir, on, source, placement) {
        return;
    }
    let folder = shown.dir.clone();
    std::thread::spawn(move || {
        ntp_extras::set_sharing(&DataDir::new(&folder), on, now_ms(), APP_VERSION, || {
            uuid::Uuid::new_v4().to_string()
        });
    });
}

pub fn suggestion_body(reply: &Value) -> Option<String> {
    let status = reply.get("status").and_then(Value::as_u64)?;
    if reply.get("stopped").and_then(Value::as_bool) == Some(true)
        || status != 200
        || BLOCKED_STATUS.contains(&status)
    {
        return None;
    }
    reply
        .get("body")
        .and_then(Value::as_str)
        .filter(|body| !body.is_empty())
        .map(str::to_owned)
}

pub fn suggest_url_allowed(url: &str) -> bool {
    url.len() <= MAX_SUGGEST_URL && (url.starts_with("https://") || url.starts_with("http://"))
}

impl AppCoordinator {
    pub fn fetch_search_suggestions(
        &self,
        profile: &ProfileId,
        url: String,
    ) -> futures::channel::oneshot::Receiver<Option<String>> {
        let (answer, reply) = futures::channel::oneshot::channel();
        let ready = suggest_url_allowed(&url)
            .then(|| Some((self.engine()?, self.service_profile_dir(profile)?)))
            .flatten();
        let Some((engine, folder)) = ready else {
            let _ = answer.send(None);
            return reply;
        };
        let id = NEXT_SUGGEST.fetch_add(1, Ordering::Relaxed);
        let call = engine.call_service(
            "ac_search_suggest",
            &folder,
            &json!({ "url": url, "id": id }).to_string(),
        );
        let consent = ardia_telemetry::consent_now();
        self.spawn(async move {
            let reply = call.await.ok();
            if let Some(status) = reply
                .as_ref()
                .filter(|r| r.get("stopped").and_then(Value::as_bool) != Some(true))
                .and_then(|r| r.get("status").and_then(Value::as_u64))
            {
                crate::telemetry_events::note_search_suggest(
                    crate::telemetry_events::suggest_outcome(status, BLOCKED_STATUS.contains(&status)),
                    consent.as_ref(),
                );
            }
            let body = reply.as_ref().and_then(suggestion_body);
            let _ = answer.send(body);
        });
        reply
    }
}

pub fn start_dictation() {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::sel;

        #[link(name = "AppKit", kind = "framework")]
        unsafe extern "C" {
            static NSApp: *mut AnyObject;
        }

        if unsafe { libc::pthread_main_np() } == 0 {
            return;
        }
        let app = unsafe { NSApp };
        if app.is_null() {
            return;
        }
        let none: *mut AnyObject = std::ptr::null_mut();
        let _: bool = unsafe {
            objc2::msg_send![app, sendAction: sel!(startDictation:), to: none, from: none]
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ok_replies_with_a_body_become_suggestions() {
        assert_eq!(
            suggestion_body(&json!({ "status": 200, "body": "[\"a\",[\"ab\"]]" })).as_deref(),
            Some("[\"a\",[\"ab\"]]")
        );
        assert_eq!(
            suggestion_body(&json!({ "status": 429, "body": "x" })),
            None
        );
        assert_eq!(suggestion_body(&json!({ "status": 200, "body": "" })), None);
        assert_eq!(
            suggestion_body(&json!({ "status": 200, "body": "x", "stopped": true })),
            None
        );
        assert!(suggest_url_allowed("https://suggest.example/?q=a"));
        assert!(!suggest_url_allowed("file:///etc/passwd"));
    }
}
