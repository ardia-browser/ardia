use std::path::{Path, PathBuf};

use ardia_state::persistence::documents;
use ardia_state::{DataDir, ProfileId};
use ardia_ui::host_data::{
    HostTopics, SharedFolderStatus, SyncDevice, SyncFolderState, SyncStatus, SyncedProfile,
};

use crate::coordinator::AppCoordinator;

pub fn folder_state(folder: Option<&str>) -> SyncFolderState {
    let Some(folder) = folder.filter(|folder| !folder.trim().is_empty()) else {
        return SyncFolderState::Unset;
    };
    match std::fs::metadata(folder) {
        Ok(found) if found.is_dir() => SyncFolderState::Reachable,
        Ok(_) => SyncFolderState::Unreadable("not a folder".to_owned()),
        Err(problem) if problem.kind() == std::io::ErrorKind::NotFound => SyncFolderState::Missing,
        Err(problem) => SyncFolderState::Unreadable(problem.kind().to_string()),
    }
}

pub fn read_status(data_dir: &Path) -> SyncStatus {
    let dir = DataDir::new(data_dir);
    let doc = documents::load_sync(&dir);
    let folder_state = if doc.enabled {
        folder_state(doc.folder.as_deref())
    } else {
        SyncFolderState::Unset
    };
    let shared_folders: Vec<SharedFolderStatus> = documents::load_shared_folders(&dir)
        .into_iter()
        .map(|folder| SharedFolderStatus {
            reachable: Path::new(&folder.path).is_dir(),
            profile_id: ProfileId::new(folder.profile_id),
            group_key: folder.group_key,
            path: folder.path,
            added_at: folder.added_at,
            ..SharedFolderStatus::default()
        })
        .collect();
    let mut errors = Vec::new();
    match &folder_state {
        SyncFolderState::Missing => errors
            .push("The sync folder is missing. Reconnect the drive or choose it again.".to_owned()),
        SyncFolderState::Unreadable(problem) => {
            errors.push(format!("Ardia can't read the sync folder ({problem})."))
        }
        SyncFolderState::Unset if doc.enabled => {
            errors.push("Sync is on but has no folder.".to_owned())
        }
        _ => {}
    }
    let missing = shared_folders
        .iter()
        .filter(|folder| !folder.reachable)
        .count();
    match missing {
        0 => {}
        1 => errors.push("A shared folder is missing.".to_owned()),
        count => errors.push(format!("{count} shared folders are missing.")),
    }
    let devices = doc
        .device_id
        .iter()
        .filter(|_| doc.enabled)
        .map(|id| SyncDevice {
            id: id.clone(),
            name: "This device".to_owned(),
            current: true,
            last_seen: doc.last_synced_at,
            ..SyncDevice::default()
        })
        .collect();
    let folder_exists = doc
        .folder
        .as_deref()
        .is_some_and(|folder| Path::new(folder).is_dir());
    SyncStatus {
        folder_exists,
        loaded: true,
        enabled: doc.enabled,
        joining: doc.joining,
        folder: doc.folder.clone(),
        folder_state,
        device_id: doc.device_id.clone(),
        last_synced_at: doc.last_synced_at,
        setup_at: doc.setup_at,
        data_types: doc
            .types
            .iter()
            .map(|(name, on)| (name.clone(), *on))
            .collect(),
        profiles: doc
            .profiles
            .iter()
            .map(|(profile, link)| SyncedProfile {
                profile_id: ProfileId::new(profile.as_str()),
                enabled: link.enabled,
            })
            .collect(),
        shared_folders,
        devices,
        errors,
        ..SyncStatus::default()
    }
}

impl AppCoordinator {
    pub(crate) fn refresh_sync(&self) {
        let Some(data_dir) = self.config.data_dir.clone() else {
            self.set_sync_status(SyncStatus {
                loaded: true,
                ..SyncStatus::default()
            });
            return;
        };
        if std::mem::replace(&mut self.bridge.lock().sync_refreshing, true) {
            return;
        }
        let me = self.weak();
        let spawned = std::thread::Builder::new()
            .name("ardia-sync-status".into())
            .spawn(move || {
                let status = read_status(&data_dir);
                if let Some(coordinator) = me.upgrade() {
                    coordinator.post(move |coordinator| {
                        coordinator.bridge.lock().sync_refreshing = false;
                        coordinator.set_sync_status(status);
                    });
                }
            });
        if let Err(problem) = spawned {
            self.bridge.lock().sync_refreshing = false;
            log::warn!("the sync status couldn't be read: {problem}");
        }
    }

    pub(crate) fn write_sync_type(&self, data_type: &str, on: bool) {
        if !ardia_state::sync::DATA_TYPES.contains(&data_type) {
            return;
        }
        if let Some(engine) = crate::sync_engine::ui_bridge::running(self) {
            engine.set_type_synced(data_type, on);
            return;
        }
        let Some(data_dir) = self.config.data_dir.clone() else {
            return;
        };
        let dir = DataDir::new(&data_dir);
        let mut doc = documents::load_sync(&dir);
        doc.types.insert(data_type.to_owned(), on);
        if let Err(problem) = documents::save_sync(&dir, &doc) {
            log::warn!("the sync choice for {data_type} wasn't saved: {problem}");
        }
        self.refresh_sync();
    }

    pub(crate) fn write_open_tabs_synced(&self, on: bool) {
        let engine = crate::sync_engine::ui_bridge::running(self);
        let synced: Vec<ProfileId> = match &engine {
            Some(engine) => engine
                .published()
                .profiles
                .into_iter()
                .filter(|(_, on)| *on)
                .map(|(id, _)| id)
                .collect(),
            None => self
                .bridge
                .lock()
                .sync_status
                .profiles
                .iter()
                .filter(|link| link.enabled)
                .map(|link| link.profile_id.clone())
                .collect(),
        };
        let state = self.store.snapshot();
        let mut next = (*state).clone();
        let mut changed = false;
        for profile in &synced {
            if let Some(found) = std::sync::Arc::make_mut(&mut next.profiles).get_mut(profile)
                && found.sync_tabs != on
            {
                std::sync::Arc::make_mut(found).sync_tabs = on;
                changed = true;
            }
        }
        if changed {
            self.store.replace(next);
        }
        if let Some(engine) = engine {
            for profile in &synced {
                engine.set_open_tabs_synced(profile, on);
            }
        }
    }

    pub(crate) fn set_sync_status(&self, status: SyncStatus) {
        let changed = {
            let mut bridge = self.bridge.lock();
            crate::telemetry_events::note_sync_status(
                (bridge.sync_status.loaded, bridge.sync_status.enabled),
                (status.loaded, status.enabled),
            );
            let changed = bridge.sync_status != status;
            bridge.sync_status = status;
            changed
        };
        if changed {
            self.signal.emit(HostTopics::SYNC);
        }
    }

    pub fn data_dir(&self) -> Option<PathBuf> {
        self.config.data_dir.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn statuses_read_the_real_documents_and_check_folders() {
        let data = tempfile::tempdir().unwrap();
        let synced = tempfile::tempdir().unwrap();
        let status = read_status(data.path());
        assert!(status.loaded && !status.enabled && status.errors.is_empty());
        std::fs::write(
            data.path().join("sync.json"),
            json!({"v": 1, "enabled": true, "folder": synced.path(), "deviceId": "dev-1",
                   "types": {"history": false}, "profiles": {"default": {"syncId": "s", "enabled": true}},
                   "lastSyncedAt": 1_795_000_000_000u64})
            .to_string(),
        )
        .unwrap();
        let status = read_status(data.path());
        assert!(status.enabled);
        assert_eq!(status.folder_state, SyncFolderState::Reachable);
        assert_eq!(status.data_types.get("history"), Some(&false));
        assert_eq!(status.data_types.get("bookmarks"), Some(&true));
        assert_eq!(status.profiles.len(), 1);
        assert_eq!(status.devices[0].id, "dev-1");
        assert!(status.errors.is_empty());
        let gone = synced.path().to_path_buf();
        drop(synced);
        assert_eq!(folder_state(gone.to_str()), SyncFolderState::Missing);
        let status = read_status(data.path());
        assert_eq!(status.folder_state, SyncFolderState::Missing);
        assert_eq!(status.errors.len(), 1);
        assert_eq!(folder_state(Some("  ")), SyncFolderState::Unset);
    }
}
