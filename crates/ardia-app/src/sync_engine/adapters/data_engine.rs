use std::sync::Arc;
use std::time::Duration;

use ardia_state::{BrowserState, ProfileId};
use serde_json::Value;
use zeroize::Zeroizing;

use super::CycleContext;
use crate::sync_engine::host::ENGINE_TIMEOUT;

pub trait DataEngine: Send + Sync {
    fn call(&self, profile: &ProfileId, name: &str, args: Value) -> Option<Value>;
    fn call_secret(
        &self,
        profile: &ProfileId,
        name: &str,
        args: Value,
    ) -> Option<Zeroizing<String>>;
    fn history_ready(&self, _profile: &ProfileId) -> bool {
        true
    }
}

#[derive(Default)]
pub struct EngineHook(pub Option<Arc<dyn DataEngine>>);

pub const HOOK: &str = "data-engine";

pub fn install(cx: &CycleContext, engine: Arc<dyn DataEngine>) {
    cx.memory.lock().slot::<EngineHook>(HOOK).0 = Some(engine);
}

fn hooked(cx: &CycleContext) -> Option<Arc<dyn DataEngine>> {
    cx.memory.lock().slot::<EngineHook>(HOOK).0.clone()
}

pub fn call(cx: &CycleContext, profile: &ProfileId, name: &str, args: Value) -> Option<Value> {
    call_within(cx, profile, name, args, ENGINE_TIMEOUT)
}

pub fn call_within(
    cx: &CycleContext,
    profile: &ProfileId,
    name: &str,
    args: Value,
    timeout: Duration,
) -> Option<Value> {
    match hooked(cx) {
        Some(engine) => engine.call(profile, name, args),
        None => cx
            .host
            .engine_call(profile, name, args, timeout)
            .filter(|v| ardia_engine::services::reply_error(v).is_none()),
    }
}

pub fn call_secret(
    cx: &CycleContext,
    profile: &ProfileId,
    name: &str,
    args: Value,
) -> Option<Zeroizing<String>> {
    match hooked(cx) {
        Some(engine) => engine.call_secret(profile, name, args),
        None => {
            let secret = cx
                .host
                .engine_call_secret(profile, name, args, ENGINE_TIMEOUT)?;
            if ardia_engine::services::reply_error(secret.expose()).is_some() {
                return None;
            }
            Some(Zeroizing::new(secret.expose().to_string()))
        }
    }
}

pub fn history_ready(cx: &CycleContext, profile: &ProfileId) -> bool {
    if cx.host.state().history_of(profile).is_none() {
        return false;
    }
    if let Some(engine) = hooked(cx) {
        return engine.history_ready(profile);
    }
    if !cx.host.has_main() {
        return true;
    }
    let profile = profile.clone();
    cx.host
        .on_main(Duration::from_secs(5), move |coordinator| {
            coordinator.bridge.lock().history_loaded.contains(&profile)
        })
        .unwrap_or(false)
}

pub fn edit_state(
    cx: &CycleContext,
    edit: impl FnOnce(&BrowserState) -> Option<BrowserState> + Send + 'static,
) -> bool {
    if !cx.host.has_main() {
        let current = cx.host.state();
        return match edit(&current) {
            Some(next) => {
                crate::sync_engine::pin_choices::from_sync(|| cx.host.store().replace(next));
                true
            }
            None => false,
        };
    }
    cx.host
        .on_main(crate::sync_engine::host::MAIN_TIMEOUT, move |coordinator| {
            let current = coordinator.store.snapshot();
            match edit(&current) {
                Some(next) => {
                    crate::sync_engine::pin_choices::from_sync(|| coordinator.store.replace(next));
                    true
                }
                None => false,
            }
        })
        .unwrap_or(false)
}

#[cfg(test)]
pub mod fake {
    use std::collections::VecDeque;
    use std::sync::Arc;

    use ardia_state::sync::SyncDoc;
    use ardia_state::sync_engine::IndexMap;
    use ardia_state::{BrowserState, BrowserStore, ProfileId};
    use parking_lot::Mutex;
    use serde_json::Value;
    use zeroize::Zeroizing;

    use super::{DataEngine, install};
    use crate::sync_engine::adapters::{AdapterMemory, CycleContext, DeviceDetails};
    use crate::sync_engine::host::SyncHost;

    type Responder = Box<dyn Fn(&str, &Value) -> Option<Value> + Send + Sync>;

    pub struct FakeEngine {
        pub calls: Mutex<Vec<(String, Value)>>,
        pub answer: Mutex<Option<Responder>>,
        pub secrets: Mutex<VecDeque<Option<String>>>,
    }

    impl FakeEngine {
        pub fn new() -> Arc<FakeEngine> {
            Arc::new(FakeEngine {
                calls: Mutex::new(Vec::new()),
                answer: Mutex::new(None),
                secrets: Mutex::new(VecDeque::new()),
            })
        }

        pub fn answer(
            &self,
            respond: impl Fn(&str, &Value) -> Option<Value> + Send + Sync + 'static,
        ) {
            *self.answer.lock() = Some(Box::new(respond));
        }

        pub fn names(&self) -> Vec<String> {
            self.calls.lock().iter().map(|(n, _)| n.clone()).collect()
        }
    }

    impl DataEngine for FakeEngine {
        fn call(&self, _profile: &ProfileId, name: &str, args: Value) -> Option<Value> {
            self.calls.lock().push((name.to_owned(), args.clone()));
            self.answer
                .lock()
                .as_ref()
                .and_then(|a| a(name, &args))
                .or(Some(Value::Object(Default::default())))
        }

        fn call_secret(
            &self,
            _profile: &ProfileId,
            name: &str,
            args: Value,
        ) -> Option<Zeroizing<String>> {
            self.calls.lock().push((name.to_owned(), args.clone()));
            if let Some(answer) = self.answer.lock().as_ref().and_then(|a| a(name, &args)) {
                return Some(Zeroizing::new(answer.to_string()));
            }
            self.secrets
                .lock()
                .pop_front()
                .flatten()
                .map(Zeroizing::new)
        }
    }

    pub fn context(state: BrowserState, device: &str) -> (CycleContext, Arc<FakeEngine>) {
        let store = Arc::new(BrowserStore::in_memory(state, ardia_state::IdGen::new(1)));
        let engine = FakeEngine::new();
        let keys = ardia_state::sync_engine::sync_core::SyncKeys::new(&[5u8; 32]);
        let cx = CycleContext {
            host: SyncHost::detached(store),
            doc: Arc::new(Mutex::new(SyncDoc {
                enabled: true,
                device_id: Some(device.to_owned()),
                ..SyncDoc::default()
            })),
            device_id: device.to_owned(),
            device_name: "Mac".into(),
            app_records: Arc::new(IndexMap::new()),
            memory: Arc::new(Mutex::new(AdapterMemory::default())),
            details: DeviceDetails::default(),
            removed_profile_keys: Arc::new(Default::default()),
            removed_device_keys: Arc::new(Default::default()),
            keys: Some(Arc::new(keys)),
        };
        install(&cx, engine.clone());
        (cx, engine)
    }
}
