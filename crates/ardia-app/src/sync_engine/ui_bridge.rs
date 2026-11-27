use std::sync::Arc;

use ardia_ui::host_data::{HostTopics, SyncDevice, SyncFolderState, SyncStatus, SyncedProfile};
use ardia_ui::sync_api::{SyncAction, SyncAnswer, SyncReply};

use super::SyncEngine;
use crate::coordinator::AppCoordinator;

pub fn engine(coordinator: &AppCoordinator) -> Option<Arc<SyncEngine>> {
    if let Some(engine) = running(coordinator) {
        return Some(engine);
    }
    if coordinator.is_shutting_down() {
        return None;
    }
    let data_dir = coordinator.config.data_dir.clone()?;
    let engine = SyncEngine::new(
        &data_dir,
        coordinator.config.scratch,
        coordinator.store.clone(),
        Some(coordinator.weak()),
    );
    let me = coordinator.weak();
    engine.set_sink(Box::new(move |_| {
        if let Some(coordinator) = me.upgrade() {
            coordinator.signal.emit(HostTopics::SYNC);
        }
    }));
    {
        let mut bridge = coordinator.bridge.lock();
        if let Some(known) = bridge.sync_engine.clone() {
            return Some(known);
        }
        bridge.sync_engine = Some(engine.clone());
    }
    super::recovery_kit::remove_temporary_kits_in_background();
    let shared = crate::shared_folders::SharedFolders::new(
        &data_dir,
        coordinator.config.scratch,
        coordinator.store.clone(),
        coordinator.weak(),
    );
    coordinator.bridge.lock().shared_folders = Some(shared.clone());
    shared.start();
    watch_store(coordinator, &engine);
    engine.start();
    Some(engine)
}

pub fn running(coordinator: &AppCoordinator) -> Option<Arc<SyncEngine>> {
    coordinator.bridge.lock().sync_engine.clone()
}

pub fn shutdown(coordinator: &AppCoordinator) {
    if let Some(shared) = shared_folders(coordinator) {
        shared.stop();
    }
    if let Some(engine) = running(coordinator) {
        engine.shutdown();
    }
}

pub fn shared_folders(
    coordinator: &AppCoordinator,
) -> Option<Arc<crate::shared_folders::SharedFolders>> {
    coordinator.bridge.lock().shared_folders.clone()
}

fn watch_store(coordinator: &AppCoordinator, engine: &Arc<SyncEngine>) {
    use ardia_state::actions::Topics;
    let previous = parking_lot::Mutex::new(coordinator.store.snapshot());
    let weak = Arc::downgrade(engine);
    let shared = shared_folders(coordinator).map(|s| Arc::downgrade(&s));
    let topics = Topics::TABS
        | Topics::BOOKMARKS
        | Topics::SETTINGS
        | Topics::PROFILES
        | Topics::GROUPS
        | Topics::WINDOWS
        | Topics::PINS
        | Topics::FOCUS;
    let subscription =
        coordinator
            .store
            .subscribe(ardia_state::Interest::Topics(topics), move |update| {
                if let Some(shared) = shared.as_ref().and_then(std::sync::Weak::upgrade)
                    && update
                        .changes
                        .topics
                        .intersects(Topics::TABS | Topics::GROUPS | Topics::WINDOWS | Topics::FOCUS)
                {
                    shared.note_store_change();
                }
                let Some(engine) = weak.upgrade() else { return };
                let prev = std::mem::replace(&mut *previous.lock(), update.state.clone());
                if !engine.enabled() {
                    return;
                }
                engine.note_pin_choices(&prev, &update.state);
                let closes = super::adapters::pinned::open_tabs::closed_open_tabs(
                    &prev,
                    &update.state,
                    engine.host().quitting(),
                );
                engine.record_open_tab_closes(&closes);
                let edited = update.changes.topics.intersects(
                    Topics::BOOKMARKS | Topics::SETTINGS | Topics::PROFILES | Topics::GROUPS,
                );
                if edited {
                    engine.note_store_edit();
                }
            });
    std::mem::forget(subscription);
}

pub fn status(coordinator: &AppCoordinator) -> SyncStatus {
    let mut base = coordinator.bridge.lock().sync_status.clone();
    if let Some(shared) = shared_folders(coordinator) {
        base.shared_folders = shared.statuses();
    }
    let Some(engine) = running(coordinator) else {
        return base;
    };
    let published = engine.published();
    let folder_state = if published.enabled {
        crate::sync_status::folder_state(published.folder.as_deref())
    } else {
        SyncFolderState::Unset
    };
    let mut status = SyncStatus {
        loaded: base.loaded,
        enabled: published.enabled,
        joining: published.joining,
        folder: published.folder.clone(),
        folder_exists: published
            .folder
            .as_deref()
            .is_some_and(|f| std::path::Path::new(f).is_dir()),
        folder_state,
        device_id: published.device_id.clone(),
        last_synced_at: published.last_synced_at,
        setup_at: published.setup_at,
        data_types: published.types.clone(),
        profiles: published
            .profiles
            .iter()
            .map(|(profile_id, enabled)| SyncedProfile {
                profile_id: profile_id.clone(),
                enabled: *enabled,
            })
            .collect(),
        devices: published
            .view
            .devices
            .iter()
            .map(|d| SyncDevice {
                id: d.id.clone(),
                name: d.name.clone(),
                current: d.current,
                last_seen: d.last_seen,
                kind: d.kind,
                receives_tabs: d.receives_tabs,
                version: d.version.clone(),
                os: d.os.clone(),
            })
            .collect::<Vec<_>>(),
        errors: base.errors.clone(),
        engine: published.view.clone(),
        shared_folders: base.shared_folders.clone(),
    };
    if status.devices.is_empty() {
        status.devices = base.devices;
    }
    status
}

pub fn action(coordinator: &AppCoordinator, action: SyncAction) -> SyncReply {
    let (sender, reply) = futures::channel::oneshot::channel();
    let Some(engine) = engine(coordinator) else {
        let _ = sender.send(SyncAnswer::Failed(
            "Sync isn’t available in this build.".to_owned(),
        ));
        return reply;
    };
    let spawned = std::thread::Builder::new()
        .name("ardia-sync-action".into())
        .spawn(move || {
            let answer = super::actions::run(&engine, action);
            engine.publish(None);
            let _ = sender.send(answer);
        });
    if let Err(problem) = spawned {
        log::warn!("[sync] the sync action couldn't start: {problem}");
    }
    reply
}
