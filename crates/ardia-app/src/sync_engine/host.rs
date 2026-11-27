use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use ardia_engine::{SecretValue, Services};
use ardia_state::actions::{Action, ActionError, Outcome};
use ardia_state::{BrowserState, BrowserStore, ProfileId};
use serde_json::Value;

use crate::coordinator::AppCoordinator;

pub const ENGINE_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAIN_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct SyncHost {
    store: Arc<BrowserStore>,
    main: Option<Weak<AppCoordinator>>,
    quitting: Arc<AtomicBool>,
}

impl SyncHost {
    pub fn new(
        store: Arc<BrowserStore>,
        main: Option<Weak<AppCoordinator>>,
        quitting: Arc<AtomicBool>,
    ) -> Self {
        SyncHost {
            store,
            main,
            quitting,
        }
    }

    pub fn detached(store: Arc<BrowserStore>) -> Self {
        SyncHost {
            store,
            main: None,
            quitting: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn store(&self) -> &Arc<BrowserStore> {
        &self.store
    }

    pub fn state(&self) -> Arc<BrowserState> {
        self.store.snapshot()
    }

    pub fn quitting(&self) -> bool {
        self.quitting.load(Ordering::Acquire)
    }

    pub fn has_main(&self) -> bool {
        self.main.as_ref().is_some_and(|m| m.strong_count() > 0)
    }

    pub fn on_main<T: Send + 'static>(
        &self,
        timeout: Duration,
        job: impl FnOnce(&AppCoordinator) -> T + Send + 'static,
    ) -> Option<T> {
        let coordinator = self.main.as_ref()?.upgrade()?;
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        coordinator.post(move |coordinator| {
            let _ = sender.send(super::pin_choices::from_sync(|| job(coordinator)));
        });
        drop(coordinator);
        receiver.recv_timeout(timeout).ok()
    }

    pub fn post(&self, job: impl FnOnce(&AppCoordinator) + Send + 'static) {
        if let Some(coordinator) = self.main.as_ref().and_then(Weak::upgrade) {
            coordinator.post(job);
        }
    }

    pub fn dispatch(&self, action: Action) -> Result<Outcome, ActionError> {
        if !self.has_main() {
            return super::pin_choices::from_sync(|| self.store.dispatch(action));
        }
        self.on_main(MAIN_TIMEOUT, move |coordinator| {
            coordinator.dispatch_action(action)
        })
        .unwrap_or(Err(ActionError::Invalid("the app didn't answer")))
    }

    pub fn replace_state(&self, next: BrowserState) {
        if !self.has_main() {
            super::pin_choices::from_sync(|| self.store.replace(next));
            return;
        }
        let _ = self.on_main(MAIN_TIMEOUT, move |coordinator| {
            coordinator.store.replace(next)
        });
    }

    pub fn engine_call(
        &self,
        profile: &ProfileId,
        name: &str,
        args: Value,
        timeout: Duration,
    ) -> Option<Value> {
        let profile = profile.clone();
        let name = name.to_owned();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let started = self.on_main(MAIN_TIMEOUT, move |coordinator| {
            let (Some(engine), Some(dir)) = (
                coordinator.engine(),
                coordinator.service_profile_dir(&profile),
            ) else {
                return false;
            };
            let reply = Services::new(engine.as_ref(), &dir).call(&name, args);
            coordinator.spawn(async move {
                let _ = sender.send(reply.await.ok());
            });
            true
        })?;
        if !started {
            return None;
        }
        receiver.recv_timeout(timeout).ok().flatten()
    }

    pub fn engine_call_secret(
        &self,
        profile: &ProfileId,
        name: &str,
        args: Value,
        timeout: Duration,
    ) -> Option<SecretValue> {
        let profile = profile.clone();
        let name = name.to_owned();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let started = self.on_main(MAIN_TIMEOUT, move |coordinator| {
            let (Some(engine), Some(dir)) = (
                coordinator.engine(),
                coordinator.service_profile_dir(&profile),
            ) else {
                return false;
            };
            let reply = Services::new(engine.as_ref(), &dir).call_secret(&name, args);
            coordinator.spawn(async move {
                let _ = sender.send(reply.await.ok());
            });
            true
        })?;
        if !started {
            return None;
        }
        receiver.recv_timeout(timeout).ok().flatten()
    }
}
