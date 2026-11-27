use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use ardia_engine::{BlockedPopup, DownloadItem, SecurityInfo, SecurityLevel, Services};
use ardia_state::actions::PageUpdate;
use ardia_state::tabs::{SecurityState, Tab};
use ardia_state::{Action, TabId};
use serde_json::Value;

use super::{certs, downloads, page};
use crate::coordinator::AppCoordinator;

#[derive(Clone, Debug, PartialEq)]
pub enum PageEvent {
    ExternalApp(Value),
    PopupBlocked {
        id: String,
        url: String,
        origin: String,
    },
    Security(Value),
}

fn securities() -> &'static Mutex<HashMap<TabId, Value>> {
    static MAP: OnceLock<Mutex<HashMap<TabId, Value>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn security_state(level: SecurityLevel) -> SecurityState {
    match level {
        SecurityLevel::Secure => SecurityState::Secure,
        SecurityLevel::Insecure | SecurityLevel::Mixed => SecurityState::Insecure,
        SecurityLevel::CertificateError => SecurityState::Dangerous,
        SecurityLevel::Local => SecurityState::Internal,
        SecurityLevel::None | SecurityLevel::Unknown => SecurityState::Unknown,
    }
}

fn resources_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.parent()?.join("Resources"))
}

impl AppCoordinator {
    pub(crate) fn install_webkit_services(&self) {
        let chromium = self.config().data_dir.as_ref().map(|d| d.join("Chromium"));
        certs::configure(chromium.clone(), resources_dir());
        page::set_history_dir(chromium);
        self.install_webkit_notifications();
        let me = self.weak();
        let report: downloads::Reporter = Arc::new(move |profile: String, item: Value| {
            if let Some(coordinator) = me.upgrade() {
                coordinator.post(move |c| c.webkit_download_changed(&profile, item));
            }
        });
        let me = self.weak();
        let resolve: downloads::Resolver = Arc::new(move |profile: String, answer| {
            if let Some(coordinator) = me.upgrade() {
                coordinator.post(move |c| c.resolve_webkit_download_folder(&profile, answer));
            }
        });
        downloads::install(report, resolve);
    }

    fn service_dir_for_engine_profile(&self, engine_profile: &str) -> Option<String> {
        let state = self.store().snapshot();
        let base = page::private_base(engine_profile);
        let profile = state
            .profiles
            .keys()
            .find(|id| state.engine_profile(id) == base)
            .cloned()?;
        self.service_profile_dir(&profile)
    }

    fn webkit_download_changed(&self, engine_profile: &str, item: Value) {
        let Ok(item) = serde_json::from_value::<DownloadItem>(item) else {
            return;
        };
        let dir = self.service_dir_for_engine_profile(engine_profile);
        let download = crate::events_pump::state_download(dir, &item);
        self.open_if_done(&download);
        self.dispatch_quietly(Action::UpsertDownload {
            download: Box::new(download),
        });
    }

    fn resolve_webkit_download_folder(&self, engine_profile: &str, answer: downloads::Answer) {
        let (Some(engine), Some(dir)) = (
            self.engine(),
            self.service_dir_for_engine_profile(engine_profile),
        ) else {
            answer(None, false);
            return;
        };
        let reply = Services::new(engine.as_ref(), &dir).downloads().settings();
        let me = self.weak();
        self.spawn(async move {
            let settings = reply.await.ok();
            let folder = settings
                .as_ref()
                .and_then(|s| s.get("folder"))
                .and_then(Value::as_str)
                .filter(|f| !f.is_empty())
                .map(PathBuf::from);
            let ask = settings
                .as_ref()
                .and_then(|s| s.get("askWhereToSave"))
                .and_then(Value::as_bool)
                .unwrap_or(folder.is_none());
            match me.upgrade() {
                Some(coordinator) => coordinator.post(move |_| answer(folder, ask)),
                None => answer(folder, ask),
            }
        });
    }

    pub(crate) fn webkit_security_info(&self, tab: &TabId) -> Option<SecurityInfo> {
        if !page::has(tab) {
            return None;
        }
        let value = securities().lock().ok()?.get(tab).cloned()?;
        serde_json::from_value(value).ok()
    }

    pub(crate) fn on_webkit_page_event(&self, tab: &TabId, listed: &Tab, event: PageEvent) {
        match event {
            PageEvent::ExternalApp(request) => {
                if crate::site::external_app_ask(&request).is_none() {
                    if let Some(id) = request.get("id").and_then(Value::as_str) {
                        page::resolve_external(id, false, false);
                    }
                    return;
                }
                let changed = self.bridge.lock().prompts.external_app(tab, &request);
                if changed {
                    self.publish_prompts(tab);
                }
            }
            PageEvent::PopupBlocked { id, url, origin } => {
                let first = {
                    let mut bridge = self.bridge.lock();
                    let first = bridge.prompts.blocked_popups(tab).is_empty();
                    bridge.prompts.block_popup(
                        tab,
                        BlockedPopup {
                            id,
                            url,
                            origin: origin.clone(),
                        },
                    );
                    first
                };
                self.touch(listed.window_id.clone());
                self.popup_was_blocked(tab, &origin, first);
            }
            PageEvent::Security(value) => {
                let level = serde_json::from_value::<SecurityInfo>(value.clone())
                    .map(|info| info.level)
                    .unwrap_or_default();
                if let Ok(mut map) = securities().lock() {
                    map.insert(tab.clone(), value);
                }
                self.dispatch_quietly(Action::UpdatePage {
                    tab: tab.clone(),
                    update: PageUpdate {
                        security: Some(security_state(level)),
                        ..PageUpdate::default()
                    },
                });
            }
        }
    }

    pub(crate) fn open_webkit_blocked_popup(
        &self,
        tab: &TabId,
        popup_id: &str,
        always: bool,
    ) -> bool {
        if !page::has(tab) {
            return false;
        }
        let popup = self.bridge.lock().prompts.take_popup(tab, popup_id);
        let chooser = page::profile_of(tab).zip(
            crate::webkit::services::page_url(tab)
                .and_then(|url| crate::webkit::site_settings::origin_of(&url)),
        );
        let opened = popup.is_some_and(|popup| page::open_blocked(tab, &popup.id, always));
        if opened
            && always
            && let Some((profile, origin)) = chooser
        {
            self.set_webkit_answer(
                &profile,
                &origin,
                crate::webkit::site_answers::POPUPS,
                Some(true),
            );
        }
        opened
    }
}

pub fn forget_security(tab: &TabId) {
    if let Ok(mut map) = securities().lock() {
        map.remove(tab);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn security_levels_map_to_tab_states() {
        assert_eq!(security_state(SecurityLevel::Secure), SecurityState::Secure);
        assert_eq!(
            security_state(SecurityLevel::CertificateError),
            SecurityState::Dangerous
        );
        assert_eq!(
            security_state(SecurityLevel::Mixed),
            SecurityState::Insecure
        );
    }
}
