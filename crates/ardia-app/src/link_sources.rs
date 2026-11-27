use std::collections::VecDeque;
use std::path::Path;

use ardia_state::DataDir;
use ardia_state::air_traffic::{LinkSource, SourceApp};
use ardia_state::link_routing::source_app_key;
use ardia_state::persistence::documents::{MAX_RECENT_APPS, load_recent_apps, save_recent_apps};
use parking_lot::Mutex;

const REMEMBERED: usize = 64;

static SENDERS: Mutex<VecDeque<(String, LinkSource)>> = Mutex::new(VecDeque::new());

pub fn remember(urls: &[String], source: &LinkSource) {
    if source.bundle_id.is_none() && source.app_name.is_none() {
        return;
    }
    let mut senders = SENDERS.lock();
    for url in urls.iter().filter(|u| !u.is_empty()) {
        senders.retain(|(known, _)| known != url);
        senders.push_back((url.clone(), source.clone()));
    }
    while senders.len() > REMEMBERED {
        senders.pop_front();
    }
}

pub fn take(url: &str) -> LinkSource {
    let mut senders = SENDERS.lock();
    let at = senders
        .iter()
        .position(|(known, _)| known == url || known.trim() == url);
    at.and_then(|i| senders.remove(i))
        .map(|(_, source)| source)
        .unwrap_or_default()
}

pub fn source_app_of(source: &LinkSource) -> Option<SourceApp> {
    let bundle_id = source
        .bundle_id
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_owned);
    let name = source
        .app_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .or_else(|| bundle_id.clone())?;
    Some(SourceApp { bundle_id, name })
}

pub fn with_recent_app(recent: &[SourceApp], source: &LinkSource) -> Option<Vec<SourceApp>> {
    let app = source_app_of(source)?;
    let key = source_app_key(&app);
    if recent
        .first()
        .is_some_and(|first| source_app_key(first) == key && first.name == app.name)
    {
        return None;
    }
    let mut next = vec![app];
    next.extend(recent.iter().filter(|a| source_app_key(a) != key).cloned());
    next.truncate(MAX_RECENT_APPS);
    Some(next)
}

pub fn note(data_dir: &Path, source: &LinkSource) {
    let dir = DataDir::new(data_dir.to_path_buf());
    let recent = load_recent_apps(&dir);
    if let Some(next) = with_recent_app(&recent, source)
        && let Err(problem) = save_recent_apps(&dir, &next)
    {
        log::warn!("[airTraffic] couldn't save link-sources.json: {problem}");
    }
}

#[cfg(target_os = "macos")]
pub fn current_sender() -> LinkSource {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_app_kit::NSRunningApplication;

    let internet_class = u32::from_be_bytes(*b"GURL");
    let get_url = u32::from_be_bytes(*b"GURL");
    let core_class = u32::from_be_bytes(*b"aevt");
    let open_documents = u32::from_be_bytes(*b"odoc");
    let pid = unsafe {
        let Some(manager_class) = AnyClass::get(c"NSAppleEventManager") else {
            return LinkSource::default();
        };
        let manager: *mut AnyObject = msg_send![manager_class, sharedAppleEventManager];
        if manager.is_null() {
            return LinkSource::default();
        }
        let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
        if event.is_null() {
            return LinkSource::default();
        }
        let class: u32 = msg_send![event, eventClass];
        let id: u32 = msg_send![event, eventID];
        let wanted = (class == internet_class && id == get_url)
            || (class == core_class && id == open_documents);
        if !wanted {
            return LinkSource::default();
        }
        let mut pid: i32 = 0;
        let token: *mut AnyObject =
            msg_send![event, attributeDescriptorForKeyword: u32::from_be_bytes(*b"tokn")];
        if !token.is_null() {
            let data: *mut AnyObject = msg_send![token, data];
            if !data.is_null() {
                let length: usize = msg_send![data, length];
                let bytes: *const u32 = msg_send![data, bytes];
                if length == 32 && !bytes.is_null() {
                    pid = *bytes.add(5) as i32;
                }
            }
        }
        if pid <= 0 {
            let sender: *mut AnyObject =
                msg_send![event, attributeDescriptorForKeyword: u32::from_be_bytes(*b"spid")];
            if !sender.is_null() {
                pid = msg_send![sender, int32Value];
            }
        }
        pid
    };
    if pid <= 0 {
        return LinkSource::default();
    }
    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid);
    let bundle_id = app
        .as_ref()
        .and_then(|a| a.bundleIdentifier())
        .map(|b| b.to_string());
    let name = app
        .as_ref()
        .and_then(|a| a.localizedName())
        .map(|n| n.to_string())
        .filter(|n| !n.is_empty())
        .or_else(|| process_name(pid));
    LinkSource {
        bundle_id,
        app_name: name,
    }
}

#[cfg(target_os = "macos")]
fn process_name(pid: i32) -> Option<String> {
    let mut buffer = [0u8; 64];
    let written = unsafe { libc::proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    (written > 0)
        .then(|| String::from_utf8_lossy(&buffer[..written as usize]).into_owned())
        .filter(|n| !n.is_empty())
}

#[cfg(not(target_os = "macos"))]
pub fn current_sender() -> LinkSource {
    LinkSource::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(bundle: Option<&str>, name: Option<&str>) -> LinkSource {
        LinkSource {
            bundle_id: bundle.map(str::to_owned),
            app_name: name.map(str::to_owned),
        }
    }

    #[test]
    fn senders_are_kept_per_url_and_taken_once() {
        let slack = source(Some("com.tinyspeck.slackmacgap"), Some("Slack"));
        remember(&["https://a.test/one".into()], &slack);
        remember(&["https://a.test/two".into()], &LinkSource::default());
        assert_eq!(take("https://a.test/one"), slack);
        assert_eq!(take("https://a.test/one"), LinkSource::default());
        assert_eq!(take("https://a.test/two"), LinkSource::default());
    }

    #[test]
    fn recent_apps_move_to_the_front_like_the_old_store() {
        let slack = source(Some("com.tinyspeck.slackmacgap"), Some("Slack"));
        let first = with_recent_app(&[], &slack).expect("added");
        assert_eq!(first[0].name, "Slack");
        assert!(with_recent_app(&first, &slack).is_none());
        let mail = source(Some("com.apple.mail"), None);
        let next = with_recent_app(&first, &mail).expect("added");
        assert_eq!(next[0].name, "com.apple.mail");
        assert_eq!(next[1].name, "Slack");
        assert!(with_recent_app(&next, &LinkSource::default()).is_none());
    }

    #[test]
    fn noting_a_source_writes_link_sources_json() {
        let dir = tempfile::tempdir().expect("dir");
        note(
            dir.path(),
            &source(Some("com.hnc.Discord"), Some("Discord")),
        );
        let saved = load_recent_apps(&DataDir::new(dir.path().to_path_buf()));
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].bundle_id.as_deref(), Some("com.hnc.Discord"));
    }
}
