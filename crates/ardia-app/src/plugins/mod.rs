pub mod consent;
pub mod defaults;
pub mod folders;
pub mod manifest;
pub mod official;
pub mod official_update;
pub mod page_view;
pub mod process;
pub mod programs;
pub mod records;
pub mod secrets;
pub mod service;
pub mod workspace;

use std::path::Path;
use std::sync::{Arc, Weak};

use ardia_state::windows::{Toast, ToastKind, WindowKind};
use ardia_state::{Action, NewTab, TabId, WindowId};
use ardia_ui::UiHost;
use ardia_ui::host_data::HostTopics;
use ardia_ui::plugins::model::HostAction;

use crate::coordinator::AppCoordinator;

pub use folders::PluginFolders;
pub use service::{PluginEnv, PluginService};

pub struct CoordinatorEnv {
    coordinator: Weak<AppCoordinator>,
    watching: parking_lot::Mutex<Vec<ardia_state::Subscription>>,
}

impl CoordinatorEnv {
    pub fn new(coordinator: Weak<AppCoordinator>) -> Self {
        CoordinatorEnv {
            coordinator,
            watching: parking_lot::Mutex::new(Vec::new()),
        }
    }

    fn with<T>(&self, use_it: impl FnOnce(&AppCoordinator) -> T) -> Option<T> {
        self.coordinator.upgrade().map(|c| use_it(&c))
    }
}

pub fn eligible(state: &ardia_state::BrowserState, window: &WindowId) -> bool {
    state.window(window.as_str()).is_some_and(|w| {
        matches!(w.kind, WindowKind::Main | WindowKind::LittleArdia) && !w.profile_id.is_incognito()
    })
}

impl PluginEnv for CoordinatorEnv {
    fn notify(&self) {
        self.with(|c| c.signal.emit(HostTopics::PLUGINS));
    }

    fn window_eligible(&self, window: &WindowId) -> bool {
        self.with(|c| eligible(&c.store().snapshot(), window))
            .unwrap_or(false)
    }

    fn focused_window(&self) -> Option<WindowId> {
        self.with(|c| {
            let state = c.store().snapshot();
            state
                .focus_order
                .iter()
                .find(|w| eligible(&state, w))
                .cloned()
                .or_else(|| {
                    state
                        .window_order
                        .iter()
                        .find(|w| eligible(&state, w))
                        .cloned()
                })
        })
        .flatten()
    }

    fn open_url(&self, window: &WindowId, url: &str, activate: bool) -> Option<TabId> {
        self.with(|c| {
            c.store()
                .dispatch(Action::NewTab {
                    window: window.clone(),
                    tab: NewTab {
                        url: Some(url.to_owned()),
                        background: !activate,
                        ..NewTab::default()
                    },
                })
                .ok()
                .and_then(|outcome| outcome.tab)
        })
        .flatten()
    }

    fn toast(&self, window: &WindowId, title: &str, message: Option<&str>) {
        self.toast_with_icon(window, title, message, None);
    }

    fn toast_with_icon(
        &self,
        window: &WindowId,
        title: &str,
        message: Option<&str>,
        icon: Option<&str>,
    ) {
        let now = ardia_state::store::now_ms();
        let icon = icon.map(str::to_owned);
        let text = match message {
            Some(message) => format!("{title}\n{message}"),
            None => title.to_owned(),
        };
        self.with(|c| {
            c.dispatch(Action::PushToast {
                window: window.clone(),
                toast: Toast {
                    id: now.max(0) as u64,
                    kind: ToastKind::Info,
                    message: text,
                    action: None,
                    icon,
                    created_at: now,
                    expires_at: Some(now + 6_000),
                },
            })
        });
    }

    fn host_action(&self, action: HostAction, window: &WindowId, tab: &TabId) {
        log::debug!(
            "[plugins] host action {} on {tab} in {window} runs from the window",
            action.name()
        );
    }

    fn tab_url(&self, tab: &TabId) -> Option<String> {
        self.with(|c| {
            c.store()
                .snapshot()
                .tab(tab.as_str())
                .map(|t| t.url.clone())
        })
        .flatten()
    }

    fn tab_window(&self, tab: &TabId) -> Option<WindowId> {
        self.with(|c| {
            c.store()
                .snapshot()
                .tab(tab.as_str())
                .map(|t| t.window_id.clone())
        })
        .flatten()
    }

    fn app_version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_owned()
    }

    fn control_on(&self) -> bool {
        self.with(|c| {
            c.store()
                .snapshot()
                .settings
                .get("cliControl")
                .is_some_and(|v| v.as_bool() == Some(true))
        })
        .unwrap_or(false)
    }

    fn open_plugin_settings(&self, name: &str) {
        let _ = name;
        self.with(|c| c.open_utility_window(ardia_ui::UtilityWindowKind::Settings));
    }

    fn confirm(
        &self,
        window: &WindowId,
        title: String,
        message: String,
        confirm: String,
        destructive: bool,
        answer: Box<dyn FnOnce(Option<bool>) + Send>,
    ) {
        let Some(reply) = self.with(|c| {
            c.confirm_in_window(
                window.clone(),
                ardia_ui::Confirmation {
                    title,
                    message,
                    confirm,
                    destructive,
                },
            )
        }) else {
            return answer(None);
        };
        std::thread::spawn(move || answer(futures::executor::block_on(reply).ok()));
    }

    fn state(&self) -> Option<Arc<ardia_state::BrowserState>> {
        self.with(|c| c.store().snapshot())
    }

    fn dispatch(&self, action: Action) -> Result<Option<TabId>, String> {
        self.with(|c| {
            c.store()
                .dispatch(action)
                .map(|outcome| outcome.tab)
                .map_err(|e| e.to_string())
        })
        .unwrap_or_else(|| Err("Ardia is closing.".into()))
    }

    fn watch_state(&self, changed: Box<dyn Fn() + Send + Sync>) {
        let subscription = self.with(|c| {
            c.store().subscribe(
                ardia_state::Interest::Topics(ardia_state::Topics::ALL),
                move |_| changed(),
            )
        });
        if let Some(subscription) = subscription {
            self.watching.lock().push(subscription);
        }
    }

    fn control(&self, method: &str, params: serde_json::Value, done: service::ControlDone) {
        let Some(coordinator) = self.coordinator.upgrade() else {
            return done(Err(("failed".into(), "Ardia is closing.".into())));
        };
        let method = method.to_owned();
        coordinator.post(move |c| {
            done(
                c.answer_control(&method, &params)
                    .map_err(|e| (e.code.to_owned(), e.message)),
            )
        });
    }

    fn evaluate(
        &self,
        tab: &TabId,
        script: &str,
        done: Box<dyn FnOnce(Option<serde_json::Value>) + Send>,
    ) {
        let Some(coordinator) = self.coordinator.upgrade() else {
            return done(None);
        };
        let (tab, script) = (tab.clone(), script.to_owned());
        coordinator.post(move |c| {
            let (Some(engine), Some(engine_tab)) = (c.engine(), c.engine_tab(&tab)) else {
                return done(None);
            };
            let reply = engine.evaluate_js(engine_tab, &script);
            c.spawn(async move { done(reply.await.ok().flatten()) });
        });
    }

    fn on_main(&self, job: Box<dyn FnOnce() + Send>) {
        if let Some(coordinator) = self.coordinator.upgrade() {
            coordinator.post(move |_| job());
        }
    }
}

pub fn start(
    coordinator: &Arc<AppCoordinator>,
    data_dir: &Path,
    scratch: bool,
) -> Arc<PluginService> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let config = folders::config_dir_for(data_dir, scratch, home.as_deref());
    let secrets = if scratch {
        secrets::PluginSecrets::isolated(data_dir.to_path_buf())
    } else {
        secrets::PluginSecrets::keychain()
    };
    let service = PluginService::with_secrets(
        PluginFolders::new(data_dir.to_path_buf(), config),
        Arc::new(CoordinatorEnv::new(Arc::downgrade(coordinator))),
        secrets,
    );
    let instance = std::env::var("ARDIA_INSTANCE").ok();
    let isolated = scratch || std::env::var_os("ARDIA_DATA_DIR").is_some();
    service.set_program_places(programs::places_for(
        data_dir,
        isolated,
        home.as_deref(),
        instance.as_deref(),
    ));
    if scratch {
        service.set_official_source(
            std::env::var("ARDIA_INSTANCE")
                .ok()
                .and_then(|text| official::instance_source(&text)),
        );
    }
    service.start();
    service
}
