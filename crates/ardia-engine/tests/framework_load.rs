#[cfg(target_os = "macos")]
mod mac {
    use ardia_engine::abi::{DISPATCH_SYMBOL, SET_EVENT_SINK_SYMBOL};
    use ardia_engine::loader::{
        EngineLibrary, LoaderEnvironment, Platform, STOPPED_AFTER_LOAD, describe_attempts,
    };
    use ardia_engine::macos::{MacEngine, class_check, is_main_thread};
    use ardia_engine::{BrowserEngine, EngineError, OpenTab, PAGE_SCRIPT, Rect, ServiceName};
    use std::cell::Cell;
    use std::path::PathBuf;

    type Check = fn(&'static EngineLibrary) -> Result<(), String>;

    fn ensure(condition: bool, what: impl Into<String>) -> Result<(), String> {
        if condition { Ok(()) } else { Err(what.into()) }
    }

    fn exports_the_engine_symbols(library: &'static EngineLibrary) -> Result<(), String> {
        ensure(library.set_event_sink().is_some(), SET_EVENT_SINK_SYMBOL)?;
        let dispatcher = library.dispatcher().is_some();
        println!(
            "  {DISPATCH_SYMBOL}: {}",
            if dispatcher {
                "exported"
            } else {
                "absent, services resolve one symbol each"
            }
        );
        for service in [
            "ac_bookmarks_tree",
            "ac_history_query",
            "ac_downloads_list",
            "ac_extensions_list",
            "ac_passwords_list",
            "ac_tasks_list",
        ] {
            let name = ServiceName::new(service).map_err(|e| e.to_string())?;
            ensure(library.service(&name).is_some(), service)?;
        }
        let unknown = ServiceName::new("ac_not_a_service").map_err(|e| e.to_string())?;
        ensure(
            library.service(&unknown).is_none(),
            "an unknown service resolved",
        )?;
        ensure(
            ServiceName::new("ac_engine_set_event_sink").is_err(),
            "the sink setter passed as a service",
        )?;
        ensure(
            library.exports(SET_EVENT_SINK_SYMBOL),
            "exports() can't see the sink setter",
        )?;
        ensure(
            !library.exports("malloc"),
            "RTLD_FIRST should keep lookups inside the framework",
        )
    }

    fn defines_the_ardiacore_classes(library: &'static EngineLibrary) -> Result<(), String> {
        let check = class_check(Some(library));
        ensure(check.is_clean(), format!("class check {check:?}"))
    }

    fn the_mac_engine_attaches_without_starting_chromium(
        library: &'static EngineLibrary,
    ) -> Result<(), String> {
        let engine = unsafe { MacEngine::with_library(library) }.map_err(|e| e.to_string())?;
        ensure(!engine.is_started(), "the engine claims to be running")?;
        ensure(
            engine.resolves_service("ac_bookmarks_tree"),
            "ac_bookmarks_tree doesn't resolve",
        )?;
        ensure(
            !engine.resolves_service("system"),
            "a non-engine symbol resolved",
        )?;
        ensure(
            engine.default_profile() == Err(EngineError::NotStarted),
            "default profile before start",
        )?;
        ensure(
            engine.create_window(Rect::new(0.0, 0.0, 800.0, 600.0)) == Err(EngineError::NotStarted),
            "window before start",
        )?;
        let mut reply = engine.call_service("ac_tasks_list", "", "{}");
        ensure(
            reply.try_take() == Some(Err(EngineError::NotStarted)),
            "services before start",
        )?;
        engine
            .set_page_script(Some(PAGE_SCRIPT))
            .map_err(|e| e.to_string())?;
        ensure(
            matches!(
                unsafe { MacEngine::with_library(library) },
                Err(EngineError::AlreadyRunning)
            ),
            "a second engine attached",
        )?;
        let profile = ardia_engine::EngineProfileId::from_raw(1).unwrap();
        let window = ardia_engine::EngineWindowId::from_raw(1).unwrap();
        ensure(
            engine.open_tab(
                window,
                OpenTab {
                    url: "https://ardia.dev".into(),
                    profile,
                    foreground: true,
                },
            ) == Err(EngineError::NotStarted),
            "a tab opened before Chromium started",
        )?;
        drop(engine);
        let again =
            unsafe { MacEngine::with_library(library) }.map_err(|e| format!("reattaching: {e}"))?;
        println!("  {again:?}");
        Ok(())
    }

    fn a_refused_framework_ends_the_search(library: &'static EngineLibrary) -> Result<(), String> {
        let env = LoaderEnvironment {
            executable: Some(PathBuf::from("/nonexistent/bin/ardia")),
            home: std::env::var_os("HOME").map(PathBuf::from),
            override_path: Some(library.path().to_path_buf()),
            trust_override_in_bundle: false,
        };
        let calls = Cell::new(0);
        let found = unsafe {
            EngineLibrary::find_with(Platform::Mac, &env, |_| {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Err("refused for the test".into())
                } else {
                    Ok(())
                }
            })
        };
        match found {
            Ok(_) => Err("the search went on after a framework loaded and was refused".into()),
            Err(attempts) => ensure(
                calls.get() == 1
                    && attempts.len() == 1
                    && attempts[0].problem.contains(STOPPED_AFTER_LOAD),
                format!("{} preflights, {attempts:?}", calls.get()),
            ),
        }
    }

    pub fn run() -> i32 {
        let wanted = std::env::args().any(|arg| arg == "--ignored" || arg == "--include-ignored")
            || std::env::var("ARDIA_FRAMEWORK_TEST").is_ok_and(|value| value == "1");
        if !wanted {
            println!("framework_load: skipped, pass --ignored to load the real Chromium Framework");
            return 0;
        }
        if !is_main_thread() {
            eprintln!("framework_load must run on the main thread");
            return 1;
        }
        let env = LoaderEnvironment::current(Platform::Mac);
        let library = match unsafe { EngineLibrary::find(Platform::Mac, &env) } {
            Ok(library) => library,
            Err(attempts) => {
                println!(
                    "test the real framework loads ... FAILED: {}",
                    describe_attempts(&attempts)
                );
                return 1;
            }
        };
        println!("loaded {}", library.path().display());
        let checks: [(&str, Check); 4] = [
            ("exports the engine symbols", exports_the_engine_symbols),
            (
                "a refused framework ends the search",
                a_refused_framework_ends_the_search,
            ),
            (
                "defines the ArdiaCore classes",
                defines_the_ardiacore_classes,
            ),
            (
                "the Mac engine attaches without starting Chromium",
                the_mac_engine_attaches_without_starting_chromium,
            ),
        ];
        let mut failed = 0;
        for (name, check) in checks {
            match check(library) {
                Ok(()) => println!("test {name} ... ok"),
                Err(problem) => {
                    failed += 1;
                    println!("test {name} ... FAILED: {problem}");
                }
            }
        }
        println!(
            "\nframework result: {} passed; {failed} failed",
            checks.len() - failed
        );
        i32::from(failed > 0)
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    std::process::exit(mac::run());
}
