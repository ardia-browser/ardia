use std::path::{Path, PathBuf};
use std::sync::Arc;

use ardia_engine::BrowserEngine;
use ardia_state::TabId;
use ardia_state::omnibox::url::same_page;
use ardia_state::tabs::Tab;
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;

pub const HISTORY_FOLDER: &str = "Ardia Tab History";
pub const CLEARED_MARKER: &str = "Ardia Tab History Cleared";
pub const MAX_SAVED_HISTORY_BYTES: u64 = 32 * 1024 * 1024;

pub fn history_file(profile_dir: &Path, tab: &TabId) -> PathBuf {
    let name: String = tab
        .as_str()
        .bytes()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    profile_dir.join(HISTORY_FOLDER).join(name)
}

pub fn generation_of(reply: &Value, profile_dir: &Path) -> Option<String> {
    if let Some(generation) = reply.get("generation").and_then(Value::as_str) {
        return Some(generation.to_owned());
    }
    if reply.get("fromMarker").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let marker = profile_dir.join(CLEARED_MARKER);
    match std::fs::read_to_string(&marker) {
        Ok(saved) => Some(saved.trim().to_owned()),
        Err(problem) if problem.kind() == std::io::ErrorKind::NotFound => Some(String::new()),
        Err(_) => None,
    }
}

pub fn saved_state(bytes: &[u8], url: &str, generation: &str) -> Option<String> {
    let saved: Value = serde_json::from_slice(bytes).ok()?;
    if saved.get("version").and_then(Value::as_i64) != Some(1) {
        return None;
    }
    let state = saved
        .get("state")
        .and_then(Value::as_str)
        .filter(|state| !state.is_empty())?;
    let matches = |key: &str| {
        saved
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|saved_url| same_page(saved_url, url))
    };
    if !(matches("url") || matches("virtualUrl")) {
        return None;
    }
    (saved.get("generation").and_then(Value::as_str) == Some(generation)).then(|| state.to_owned())
}

fn read_capped(file: &Path) -> Option<Vec<u8>> {
    let size = std::fs::metadata(file).ok()?.len();
    if size == 0 || size > MAX_SAVED_HISTORY_BYTES {
        return None;
    }
    std::fs::read(file).ok()
}

impl AppCoordinator {
    pub(crate) fn restore_saved_history(
        &self,
        listed: &Tab,
        engine: &Arc<dyn BrowserEngine>,
    ) -> bool {
        let tab = listed.id.clone();
        let user_load = listed.live.navigation.is_some();
        if user_load
            || listed.is_incognito()
            || listed.url.is_empty()
            || ardia_ui::pages::is_internal(&listed.url)
            || self.bridge.lock().lifecycle.history_bound.contains(&tab)
        {
            return false;
        }
        let Some(folder) = self.service_profile_dir(&listed.profile_id) else {
            return false;
        };
        let profile_dir = PathBuf::from(&folder);
        let file = history_file(&profile_dir, &tab);
        if !file.is_file() {
            return false;
        }
        self.bridge.lock().pending_tabs.insert(tab.clone());
        let generation = engine.call_service("ac_tab_history_generation", &folder, "{}");
        let url = listed.url.clone();
        let me = self.weak();
        self.spawn(async move {
            let generation = generation
                .await
                .ok()
                .and_then(|reply| generation_of(&reply, &profile_dir));
            let (done, read) = futures::channel::oneshot::channel();
            let reading = std::thread::Builder::new()
                .name("ardia-tab-history".into())
                .spawn(move || {
                    let _ = done.send(read_capped(&file));
                });
            let bytes = match reading {
                Ok(_) => read.await.ok().flatten(),
                Err(_) => None,
            };
            let state = match (bytes, generation) {
                (Some(bytes), Some(generation)) => saved_state(&bytes, &url, &generation),
                _ => None,
            };
            if let Some(me) = me.upgrade() {
                me.finish_restore(&tab, state.map(|state| json!({ "state": state })));
            }
        });
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_files_are_named_by_the_tab_id_in_hex() {
        let file = history_file(Path::new("/p"), &TabId::new("tab-ax"));
        assert_eq!(file, Path::new("/p/Ardia Tab History/7461622D6178"));
    }

    #[test]
    fn saved_history_needs_the_same_page_version_and_generation() {
        let saved = json!({"version": 1, "state": "AAAA", "url": "https://x.com/home#top", "virtualUrl": "https://x.com/", "generation": "g1"}).to_string();
        let bytes = saved.as_bytes();
        assert_eq!(
            saved_state(bytes, "https://x.com/home", "g1").as_deref(),
            Some("AAAA")
        );
        assert_eq!(
            saved_state(bytes, "https://x.com/", "g1").as_deref(),
            Some("AAAA")
        );
        assert_eq!(saved_state(bytes, "https://x.com/explore", "g1"), None);
        assert_eq!(saved_state(bytes, "https://x.com/home", "g2"), None);
        let old =
            json!({"version": 2, "state": "AAAA", "url": "https://x.com/home", "generation": "g1"})
                .to_string();
        assert_eq!(
            saved_state(old.as_bytes(), "https://x.com/home", "g1"),
            None
        );
        assert_eq!(saved_state(b"not json", "https://x.com/home", "g1"), None);
    }

    #[test]
    fn the_generation_falls_back_to_the_cleared_marker() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            generation_of(&json!({"generation": "abc"}), dir.path()).as_deref(),
            Some("abc")
        );
        assert_eq!(
            generation_of(&json!({"fromMarker": true}), dir.path()).as_deref(),
            Some("")
        );
        std::fs::write(dir.path().join(CLEARED_MARKER), "  42\n").unwrap();
        assert_eq!(
            generation_of(&json!({"fromMarker": true}), dir.path()).as_deref(),
            Some("42")
        );
        assert_eq!(generation_of(&json!({"error": "x"}), dir.path()), None);
    }
}
