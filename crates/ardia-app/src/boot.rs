use std::ffi::OsString;
use std::sync::Arc;

use ardia_engine::{BrowserEngine, MockBrowserEngine};
use ardia_state::persistence::documents;
use ardia_state::persistence::session::{LoadOptions, SessionSource};
use ardia_state::{BrowserStore, DataDir};
use futures::channel::mpsc::unbounded;

use crate::cli::{self, CliOutcome, EngineChoice, LaunchConfig};
use crate::coordinator::{AppCoordinator, CoordinatorConfig};
use crate::policy::AppPolicy;
use crate::shell::{self, ShellMode};

pub fn run(args: impl IntoIterator<Item = OsString>) -> i32 {
    crate::telemetry_events::mark_main();
    crate::logging::init();
    let config = match cli::parse(args, &|name| std::env::var(name).ok()) {
        CliOutcome::Run(config) => *config,
        CliOutcome::Exit { code, message } => {
            if code == 0 {
                println!("{}", message.trim_end());
            } else {
                eprintln!("{}", message.trim_end());
            }
            return code;
        }
    };
    match launch(config) {
        Ok(code) => code,
        Err(problem) => {
            log::error!("Ardia couldn't start: {problem:#}");
            1
        }
    }
}

fn prepare_environment(config: &LaunchConfig) {
    if config.background {
        unsafe { std::env::set_var(cli::BACKGROUND_ENV, "1") };
    }
    if let Some(framework) = &config.framework {
        unsafe { std::env::set_var(cli::FRAMEWORK_ENV, framework) };
    }
}

pub fn open_store(config: &LaunchConfig) -> anyhow::Result<(Arc<BrowserStore>, bool)> {
    std::fs::create_dir_all(&config.data_dir)?;
    let dir = DataDir::new(&config.data_dir);
    let saved = documents::load_onboarding(&dir);
    let mut onboarding = config.onboarding && saved.as_ref().is_none_or(|doc| !doc.completed());
    let (store, report) = {
        let _span = ardia_profile::span(ardia_profile::Span::SessionRestore);
        BrowserStore::open(dir, LoadOptions::default())?
    };
    if let SessionSource::Backup { age_days, .. } = &report.source {
        RESTORED_BACKUP_DAYS.store(*age_days, std::sync::atomic::Ordering::Relaxed);
    }
    if saved.is_none() && report.source != SessionSource::Fresh {
        crate::onboarding_doc::mark_completed_for_existing_session(&config.data_dir);
        onboarding = false;
    }
    log::info!(
        "session from {:?} ({} rows dropped{})",
        report.source,
        report.dropped_rows,
        report.problem.map(|p| format!(", {p}")).unwrap_or_default()
    );
    Ok((Arc::new(store), onboarding))
}

static RESTORED_BACKUP_DAYS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);

fn note_session_counts(store: &Arc<BrowserStore>) {
    let days = RESTORED_BACKUP_DAYS.swap(-1, std::sync::atomic::Ordering::Relaxed);
    if days >= 0 {
        ardia_telemetry::counts::count("session_restored_from_backup");
        ardia_telemetry::counts::raise("session_restored_backup_days_max", days as u64);
    }
    let store = Arc::clone(store);
    let last = std::sync::atomic::AtomicU64::new(store.saves());
    ardia_telemetry::counts::register_source(move |_| {
        let now = store.saves();
        let before = last.swap(now, std::sync::atomic::Ordering::Relaxed);
        serde_json::Map::from_iter([(
            "session_saves".to_owned(),
            serde_json::json!(now.saturating_sub(before)),
        )])
    });
}

#[cfg(unix)]
fn start_ipc(
    config: &LaunchConfig,
    coordinator: &Arc<AppCoordinator>,
) -> Option<crate::ipc::socket::ControlServer> {
    if !config.ipc {
        return None;
    }
    match crate::ipc::socket::ControlServer::start(config.socket_path(), coordinator) {
        Ok(server) => Some(server),
        Err(problem) => {
            log::warn!("the control socket isn't available: {problem}");
            None
        }
    }
}

#[cfg(not(unix))]
fn start_ipc(_: &LaunchConfig, _: &Arc<AppCoordinator>) -> Option<()> {
    None
}

fn launch(config: LaunchConfig) -> anyhow::Result<i32> {
    let _instance = match crate::instance::claim(&config.data_dir)? {
        crate::instance::Claim::Ours(lock) => lock,
        crate::instance::Claim::Taken { pid } => {
            return Ok(crate::instance::hand_off(&config, pid));
        }
    };
    prepare_environment(&config);
    crate::profiling::start(&config.data_dir);
    #[cfg(target_os = "macos")]
    if config.engine == EngineChoice::Auto {
        match chromium::load() {
            Ok(engine) => return chromium::run(config, engine),
            Err(problem) => {
                log::warn!("Chromium isn't available, so the UI runs on the mock engine: {problem}")
            }
        }
    }
    let engine = standalone_engine(&config);
    run_standalone(config, engine)
}

fn standalone_engine(config: &LaunchConfig) -> Arc<dyn BrowserEngine> {
    if config.engine == EngineChoice::Auto {
        #[cfg(target_os = "linux")]
        match unsafe { ardia_engine::linux::load() } {
            Ok(engine) => return Arc::new(engine),
            Err(problem) => log::warn!("the Linux engine isn't available: {problem}"),
        }
        #[cfg(target_os = "windows")]
        match windows_engine() {
            Ok(engine) => return Arc::new(engine),
            Err(problem) => log::warn!("the Windows engine isn't available: {problem}"),
        }
    }
    Arc::new(MockBrowserEngine::started())
}

#[cfg(target_os = "windows")]
fn windows_engine() -> ardia_engine::EngineResult<ardia_engine::windows::WindowsEngine> {
    use ardia_engine::EngineError;
    use ardia_engine::loader::{EngineLibrary, LoaderEnvironment, Platform, describe_attempts};
    let library = unsafe {
        EngineLibrary::find(
            Platform::Windows,
            &LoaderEnvironment::current(Platform::Windows),
        )
    }
    .map_err(|attempts| EngineError::NotLoaded(describe_attempts(&attempts)))?;
    let entry = library
        .api_entry()
        .ok_or_else(|| EngineError::NotLoaded("the engine has no ardia_engine_api".into()))?;
    unsafe { ardia_engine::windows::from_api(entry()) }
}

fn run_standalone(config: LaunchConfig, engine: Arc<dyn BrowserEngine>) -> anyhow::Result<i32> {
    #[cfg(target_os = "macos")]
    if config.background {
        ardia_engine::macos::platform::install_background_guard()?;
    }
    if !engine.is_started() {
        engine.run_with_args(&config.launch_options().to_args())?;
    }
    crate::telemetry_events::mark_engine_started();
    let (store, onboarding) = open_store(&config)?;
    crate::telemetry::start(&config.data_dir, config.scratch);
    let _usage = crate::telemetry::watch_store(&store);
    let _snapshot = crate::telemetry_snapshot::start(&store, &config.data_dir);
    note_session_counts(&store);
    let coordinator = AppCoordinator::new(
        store,
        engine.clone(),
        CoordinatorConfig {
            hosts_native_windows: false,
            background: config.background,
            onboarding,
            data_dir: Some(config.data_dir.clone()),
            scratch: config.scratch,
            favicon_dir: Some(config.data_dir.join("Favicons")),
            delays_new_tab_pages: true,
            ..CoordinatorConfig::default()
        },
    );
    engine.set_policy(Arc::new(AppPolicy::new(coordinator.weak(), Vec::new())));
    crate::telemetry::started(&coordinator);
    ardia_telemetry::counts::add("launch_command_line_links", config.open_urls.len() as u64);
    coordinator.queue_urls(config.open_urls.clone());
    coordinator.start_plugins(&config.data_dir, config.scratch);
    let control = start_ipc(&config, &coordinator);
    let (sender, wakes) = unbounded();
    coordinator.set_waker(move || {
        let _ = sender.unbounded_send(());
    });
    let app = gpui_platform::application();
    {
        let coordinator = coordinator.clone();
        app.on_reopen(move |_| coordinator.reopen());
    }
    {
        let coordinator = coordinator.clone();
        app.on_open_urls(move |urls| {
            crate::link_sources::remember(&urls, &crate::link_sources::current_sender());
            coordinator.queue_urls(urls)
        });
    }
    let shell_coordinator = coordinator.clone();
    app.run(move |cx| shell::install(cx, shell_coordinator, wakes, ShellMode::Standalone));
    coordinator.begin_shutdown();
    crate::telemetry::quit();
    crate::profiling::stop();
    coordinator.flush();
    drop(control);
    Ok(0)
}

#[cfg(target_os = "macos")]
mod main_queue {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[repr(C)]
    pub struct DispatchQueue {
        _opaque: [u8; 0],
    }

    unsafe extern "C" {
        static _dispatch_main_q: DispatchQueue;
        fn dispatch_async_f(
            queue: *const DispatchQueue,
            context: *mut c_void,
            work: extern "C" fn(*mut c_void),
        );
    }

    static SCHEDULED: AtomicBool = AtomicBool::new(false);

    pub fn schedule(work: extern "C" fn(*mut c_void)) {
        if !SCHEDULED.swap(true, Ordering::AcqRel) {
            unsafe { dispatch_async_f(&raw const _dispatch_main_q, std::ptr::null_mut(), work) };
        }
    }

    pub fn ran() {
        SCHEDULED.store(false, Ordering::Release);
    }
}

#[cfg(target_os = "macos")]
mod chromium {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use ardia_engine::macos::menu::MenuContext;
    use ardia_engine::macos::{MacEngine, install_hosted_window_hooks, platform};
    use ardia_engine::{BrowserEngine, EngineResult};
    use futures::channel::mpsc::{UnboundedReceiver, unbounded};

    use super::{main_queue, open_store, start_ipc};
    use crate::cli::LaunchConfig;
    use crate::coordinator::{AppCoordinator, CoordinatorConfig};
    use crate::hosted_input::GpuiInputRoutes;
    use crate::menu_bridge::native;
    use crate::policy::{AppPolicy, reserved_chords};
    use crate::shell::{self, ShellMode};

    struct Boot {
        coordinator: Arc<AppCoordinator>,
        wakes: Option<UnboundedReceiver<()>>,
        app: Option<gpui::ApplicationHandle>,
        booted: Arc<AtomicBool>,
    }

    thread_local! {
        static BOOT: RefCell<Option<Boot>> = const { RefCell::new(None) };
    }

    impl Boot {
        fn tick(&mut self) {
            if self.app.is_some() {
                return;
            }
            let started = self
                .coordinator
                .engine()
                .is_some_and(|engine| engine.is_started());
            if !started {
                self.coordinator.pump();
                return;
            }
            crate::telemetry_events::mark_engine_started();
            let Some(wakes) = self.wakes.take() else {
                return;
            };
            self.booted.store(true, Ordering::Release);
            let coordinator = self.coordinator.clone();
            let app = gpui_platform::attached_macos_application()
                .run_embedded(move |cx| shell::install(cx, coordinator, wakes, ShellMode::Hosted));
            self.app = Some(app);
        }
    }

    extern "C" fn boot_tick(_: *mut c_void) {
        main_queue::ran();
        let ran = BOOT.with(|slot| match slot.try_borrow_mut() {
            Ok(mut slot) => {
                if let Some(boot) = slot.as_mut() {
                    boot.tick();
                }
                true
            }
            Err(_) => false,
        });
        if !ran {
            main_queue::schedule(boot_tick);
        }
    }

    pub fn load() -> EngineResult<Arc<MacEngine>> {
        unsafe { MacEngine::load() }.map(Arc::new)
    }

    pub fn run(config: LaunchConfig, engine: Arc<MacEngine>) -> anyhow::Result<i32> {
        log::info!("Chromium from {}", engine.framework_path().display());
        crate::symbols::register_icon_symbols();
        ardia_ui::primitives::haptics::install_performer(crate::profile_sync::haptic_alignment);
        let hooks = install_hosted_window_hooks(GpuiInputRoutes)?;
        platform::install_app_events(true, true)?;
        let (store, onboarding) = open_store(&config)?;
        crate::telemetry::start(&config.data_dir, config.scratch);
        let _usage = crate::telemetry::watch_store(&store);
        let _snapshot = crate::telemetry_snapshot::start(&store, &config.data_dir);
        super::note_session_counts(&store);
        let shared: Arc<dyn BrowserEngine> = engine.clone();
        let coordinator = AppCoordinator::new(
            store,
            shared,
            CoordinatorConfig {
                hosts_native_windows: true,
                background: config.background,
                onboarding,
                data_dir: Some(config.data_dir.clone()),
                scratch: config.scratch,
                favicon_dir: Some(config.data_dir.join("Favicons")),
                delays_new_tab_pages: true,
                ..CoordinatorConfig::default()
            },
        );
        let reserved = reserved_chords(&native::menu_bar(&MenuContext::default()));
        engine.set_policy(Arc::new(AppPolicy::new(coordinator.weak(), reserved)));
        crate::telemetry::started(&coordinator);
        ardia_telemetry::counts::add("launch_command_line_links", config.open_urls.len() as u64);
        coordinator.queue_urls(config.open_urls.clone());
        coordinator.start_plugins(&config.data_dir, config.scratch);
        let control = start_ipc(&config, &coordinator);
        let (sender, wakes) = unbounded();
        let booted = Arc::new(AtomicBool::new(false));
        BOOT.with_borrow_mut(|slot| {
            *slot = Some(Boot {
                coordinator: coordinator.clone(),
                wakes: Some(wakes),
                app: None,
                booted: booted.clone(),
            })
        });
        coordinator.set_waker(move || {
            let _ = sender.unbounded_send(());
            if !booted.load(Ordering::Acquire) {
                main_queue::schedule(boot_tick);
            }
        });
        let exit = engine.launch(&config.launch_options());
        coordinator.begin_shutdown();
        crate::telemetry::quit();
        crate::profiling::stop();
        if !coordinator.flush() {
            log::warn!("the session didn't finish saving before Chromium exited");
        }
        let boot = BOOT.with_borrow_mut(Option::take);
        drop(control);
        drop(boot);
        drop(hooks);
        Ok(exit?)
    }
}
