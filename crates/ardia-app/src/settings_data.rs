use std::collections::{HashMap, HashSet};

use ardia_state::ProfileId;
use ardia_ui::DownloadSettings;
use ardia_ui::host_data::HostTopics;
use serde_json::Value;

use crate::coordinator::AppCoordinator;

#[derive(Default)]
pub struct SettingsData {
    downloads: HashMap<ProfileId, DownloadSettings>,
    asked: HashSet<ProfileId>,
    waiting: HashSet<ProfileId>,
}

pub fn download_settings_of(reply: &Value) -> Option<DownloadSettings> {
    let folder = reply.get("folder")?.as_str()?.to_owned();
    Some(DownloadSettings {
        folder,
        ask_where_to_save: reply
            .get("askWhereToSave")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        managed: reply
            .get("managed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

impl AppCoordinator {
    pub(crate) fn cached_download_settings(&self, profile: &ProfileId) -> Option<DownloadSettings> {
        let (cached, ask) = {
            let mut bridge = self.bridge.lock();
            let data = &mut bridge.settings_data;
            let cached = data.downloads.get(profile).cloned();
            (cached, data.asked.insert(profile.clone()))
        };
        if ask {
            self.fetch_download_settings(profile.clone());
        }
        cached
    }

    fn fetch_download_settings(&self, profile: ProfileId) {
        let me = self.weak();
        self.spawn(async move {
            let Some(me) = me.upgrade() else {
                return;
            };
            let (Some(engine), Some(dir)) = (me.engine(), me.service_profile_dir(&profile)) else {
                me.bridge
                    .lock()
                    .settings_data
                    .waiting
                    .insert(profile.clone());
                let _ = me.resolve_profile(&profile);
                return;
            };
            let reply = ardia_engine::Services::new(engine.as_ref(), &dir)
                .downloads()
                .settings()
                .await;
            let found = match reply {
                Ok(value) => download_settings_of(&value),
                Err(problem) => {
                    log::debug!("download settings for {profile} weren't read: {problem}");
                    None
                }
            };
            {
                let mut bridge = me.bridge.lock();
                match found {
                    Some(found) => {
                        bridge.settings_data.downloads.insert(profile, found);
                    }
                    None => {
                        bridge.settings_data.asked.remove(&profile);
                    }
                }
            }
            me.signal.emit(HostTopics::SYNC);
        });
    }

    pub(crate) fn engine_profile_flags(
        &self,
        profile: &ProfileId,
    ) -> Option<ardia_ui::ProfileFlags> {
        let id = self.resolve_profile(profile)?;
        let info = self.engine()?.profile_info(id).ok()?;
        Some(ardia_ui::ProfileFlags {
            passwords_offered: info.passwords_offered,
            addresses_autofilled: info.addresses_autofilled,
            cards_autofilled: info.cards_autofilled,
            preload_pages: info.preload_pages,
        })
    }

    pub(crate) fn write_profile_flag(
        &self,
        profile: &ProfileId,
        flag: ardia_ui::ProfileFlagKind,
        on: bool,
    ) {
        let (Some(id), Some(engine)) = (self.resolve_profile(profile), self.engine()) else {
            return;
        };
        let flag = match flag {
            ardia_ui::ProfileFlagKind::PasswordsOffered => {
                ardia_engine::ProfileFlag::PasswordsOffered
            }
            ardia_ui::ProfileFlagKind::AddressesAutofilled => {
                ardia_engine::ProfileFlag::AddressesAutofilled
            }
            ardia_ui::ProfileFlagKind::CardsAutofilled => {
                ardia_engine::ProfileFlag::CardsAutofilled
            }
            ardia_ui::ProfileFlagKind::PreloadPages => ardia_engine::ProfileFlag::PreloadPages,
        };
        let preload = flag == ardia_engine::ProfileFlag::PreloadPages;
        match engine.set_profile_flag(id, flag, on) {
            Err(problem) => log::debug!("profile flag for {profile} wasn't set: {problem}"),
            Ok(_) if preload => ardia_telemetry::counts::count(if on {
                "preload_pages_turned_on"
            } else {
                "preload_pages_turned_off"
            }),
            Ok(_) => {}
        }
        self.signal.emit(HostTopics::SYNC);
    }

    pub(crate) fn note_profile_loaded(&self, profile: &ProfileId) {
        let waited = {
            let mut bridge = self.bridge.lock();
            let data = &mut bridge.settings_data;
            let waited = data.waiting.remove(profile);
            if waited {
                data.asked.remove(profile);
            }
            waited
        };
        if waited {
            self.fetch_download_settings(profile.clone());
        }
    }

    pub(crate) fn write_download_settings(
        &self,
        profiles: Vec<ProfileId>,
        folder: Option<String>,
        ask_where_to_save: Option<bool>,
    ) {
        {
            let mut bridge = self.bridge.lock();
            for profile in &profiles {
                if let Some(entry) = bridge.settings_data.downloads.get_mut(profile) {
                    if entry.managed {
                        continue;
                    }
                    if let Some(folder) = &folder {
                        entry.folder = folder.clone();
                    }
                    if let Some(ask) = ask_where_to_save {
                        entry.ask_where_to_save = ask;
                    }
                }
            }
        }
        self.signal.emit(HostTopics::SYNC);
        let me = self.weak();
        self.spawn(async move {
            let Some(me) = me.upgrade() else {
                return;
            };
            let Some(engine) = me.engine() else {
                return;
            };
            for profile in profiles {
                let Some(dir) = me.service_profile_dir(&profile) else {
                    continue;
                };
                let reply = ardia_engine::Services::new(engine.as_ref(), &dir)
                    .downloads()
                    .set_settings(folder.as_deref(), ask_where_to_save)
                    .await;
                if let Err(problem) = reply {
                    log::debug!("download settings for {profile} weren't saved: {problem}");
                }
                me.bridge.lock().settings_data.asked.remove(&profile);
                me.fetch_download_settings(profile);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn download_settings_read_the_engine_reply() {
        let found = download_settings_of(&json!({
            "folder": "/Users/me/Downloads",
            "askWhereToSave": true,
            "managed": false
        }))
        .expect("settings");
        assert_eq!(found.folder, "/Users/me/Downloads");
        assert!(found.ask_where_to_save);
        assert!(!found.managed);
        assert!(download_settings_of(&json!({ "askWhereToSave": true })).is_none());
    }
}
