#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
fn main() {
    std::process::exit(macos::run());
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::sync::Arc;

    use ardia_app::scripting::mac::{ScriptTab, register, serve};
    use ardia_app::scripting::{JAVASCRIPT_OFF, MISSING_JAVASCRIPT, NO_TAB};
    use ardia_app::{AppCoordinator, CoordinatorConfig};
    use ardia_engine::{BrowserEngine, MockBrowserEngine};
    use ardia_state::actions::{Action, NewTab};
    use ardia_state::ids::IdGen;
    use ardia_state::persistence::session::{LoadOptions, SessionData};
    use ardia_state::settings::SettingsPatch;
    use ardia_state::windows::WindowKind;
    use ardia_state::{BrowserState, BrowserStore, TabId, WindowId};
    use futures::executor::LocalPool;
    use futures::task::LocalSpawnExt;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{AnyThread, DefinedClass, MainThreadMarker, define_class, msg_send};
    use objc2_foundation::{NSDictionary, NSString};
    use serde_json::Value;

    #[derive(Default)]
    pub struct Seen {
        suspended: Cell<usize>,
        resumed: Cell<usize>,
        resumed_on_main: Cell<bool>,
        suspended_before_resume: Cell<bool>,
        result: RefCell<Option<String>>,
        error_number: Cell<isize>,
        error_text: RefCell<String>,
        javascript: RefCell<Option<String>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "ArdiaTestSuspendedScriptCommand"]
        #[ivars = Seen]
        pub struct FakeCommand;

        impl FakeCommand {
            #[unsafe(method(suspendExecution))]
            fn suspend_execution(&self) {
                let seen = self.ivars();
                seen.suspended.set(seen.suspended.get() + 1);
            }

            #[unsafe(method(resumeExecutionWithResult:))]
            fn resume_execution(&self, result: Option<&AnyObject>) {
                let seen = self.ivars();
                seen.suspended_before_resume.set(seen.suspended.get() == 1);
                seen.resumed.set(seen.resumed.get() + 1);
                seen.resumed_on_main.set(MainThreadMarker::new().is_some());
                *seen.result.borrow_mut() = result
                    .and_then(|r| r.downcast_ref::<NSString>())
                    .map(|s| s.to_string());
            }

            #[unsafe(method(setScriptErrorNumber:))]
            fn set_error_number(&self, number: isize) {
                self.ivars().error_number.set(number);
            }

            #[unsafe(method(scriptErrorNumber))]
            fn error_number(&self) -> isize {
                self.ivars().error_number.get()
            }

            #[unsafe(method(setScriptErrorString:))]
            fn set_error_string(&self, text: &NSString) {
                *self.ivars().error_text.borrow_mut() = text.to_string();
            }

            #[unsafe(method_id(evaluatedArguments))]
            fn evaluated_arguments(&self) -> Option<Retained<NSDictionary<NSString, AnyObject>>> {
                let code = self.ivars().javascript.borrow().clone();
                code.map(|code| {
                    let key = NSString::from_str("javascript");
                    let value = NSString::from_str(&code);
                    NSDictionary::from_retained_objects(&[&*key], &[value.into_super().into_super()])
                })
            }
        }
    );

    impl FakeCommand {
        fn new(javascript: Option<&str>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Seen {
                javascript: RefCell::new(javascript.map(str::to_owned)),
                ..Seen::default()
            });
            unsafe { msg_send![super(this), init] }
        }
    }

    type Check = fn(&Harness) -> Result<(), String>;

    struct Harness {
        app: Arc<AppCoordinator>,
        mock: Arc<MockBrowserEngine>,
        window: WindowId,
        pool: RefCell<LocalPool>,
    }

    fn ensure(condition: bool, what: impl Into<String>) -> Result<(), String> {
        if condition { Ok(()) } else { Err(what.into()) }
    }

    impl Harness {
        fn new() -> Self {
            let store = Arc::new(BrowserStore::in_memory(
                BrowserState::from_session(
                    SessionData::fresh(LoadOptions::default()),
                    1_795_000_000_000,
                ),
                IdGen::with_launch("as-main"),
            ));
            let mock = Arc::new(MockBrowserEngine::started());
            let engine: Arc<dyn BrowserEngine> = mock.clone();
            let app = AppCoordinator::new(store, engine, CoordinatorConfig::default());
            app.start();
            app.pump();
            let window = app
                .dispatch_action(Action::OpenWindow {
                    kind: WindowKind::Main,
                    profile: None,
                    url: Some("https://a.example/".into()),
                    frame: None,
                })
                .unwrap()
                .window
                .unwrap();
            app.pump();
            let pool = LocalPool::new();
            let spawner = pool.spawner();
            serve(
                &app,
                Rc::new(move |task| {
                    let _ = spawner.spawn_local(task);
                }),
                Rc::new(|_| Box::pin(futures::future::pending())),
            );
            Harness {
                app,
                mock,
                window,
                pool: RefCell::new(pool),
            }
        }

        fn settle(&self) {
            self.pool.borrow_mut().run_until_stalled();
            self.app.pump();
        }

        fn new_tab(&self) -> TabId {
            let tab = self
                .app
                .dispatch_action(Action::NewTab {
                    window: self.window.clone(),
                    tab: NewTab {
                        url: Some("https://b.example/".into()),
                        background: true,
                        ..NewTab::default()
                    },
                })
                .unwrap()
                .tab
                .unwrap();
            self.app.pump();
            tab
        }

        fn allow_javascript(&self, on: bool) {
            self.app
                .dispatch_action(Action::UpdateSettings {
                    patch: SettingsPatch::new().set("allowJavaScriptFromAppleEvents", on),
                    from_sync: false,
                })
                .unwrap();
        }
    }

    fn send(tab: &str, selector: &str, command: &FakeCommand) {
        let object = ScriptTab::with_id(tab);
        let returned: *mut AnyObject = unsafe {
            match selector {
                "close" => msg_send![&*object, handleCloseScriptCommand: command],
                "execute" => msg_send![&*object, handleExecuteScriptCommand: command],
                "reload" => msg_send![&*object, handleReloadScriptCommand: command],
                _ => unreachable!("only listed handlers are sent"),
            }
        };
        assert!(
            returned.is_null(),
            "a suspended command returns nothing at once"
        );
    }

    fn suspends_then_resumes_on_the_main_thread(h: &Harness) -> Result<(), String> {
        let tab = h.new_tab();
        let command = FakeCommand::new(None);
        send(tab.as_str(), "close", &command);
        let seen = command.ivars();
        ensure(seen.suspended.get() == 1, "close suspends its event")?;
        ensure(
            seen.resumed.get() == 0,
            "nothing answers before the main loop runs",
        )?;
        ensure(
            h.app.store().snapshot().tab(tab.as_str()).is_some(),
            "the change waits for the main loop",
        )?;
        h.settle();
        ensure(seen.resumed.get() == 1, "close resumes exactly once")?;
        ensure(
            seen.suspended_before_resume.get(),
            "suspend came before resume",
        )?;
        ensure(seen.resumed_on_main.get(), "resume runs on the main thread")?;
        ensure(seen.error_number.get() == 0, "close sets no error")?;
        ensure(
            h.app.store().snapshot().tab(tab.as_str()).is_none(),
            "the tab is closed",
        )
    }

    fn an_unknown_tab_resumes_with_the_old_error(h: &Harness) -> Result<(), String> {
        let command = FakeCommand::new(None);
        send("tab-gone", "reload", &command);
        h.settle();
        let seen = command.ivars();
        ensure(seen.resumed.get() == 1, "a failure still resumes")?;
        ensure(seen.error_number.get() == -10000, "error number -10000")?;
        ensure(*seen.error_text.borrow() == NO_TAB, "the old message")
    }

    fn execute_is_refused_with_error_twelve_while_off(h: &Harness) -> Result<(), String> {
        h.allow_javascript(false);
        let tab = h.new_tab();
        let command = FakeCommand::new(Some("1+1"));
        send(tab.as_str(), "execute", &command);
        h.settle();
        let seen = command.ivars();
        ensure(
            seen.suspended.get() == 1 && seen.resumed.get() == 1,
            "suspended then resumed",
        )?;
        ensure(seen.error_number.get() == 12, "error number 12")?;
        ensure(
            *seen.error_text.borrow() == JAVASCRIPT_OFF,
            "the old message",
        )?;
        ensure(seen.result.borrow().is_none(), "no value comes back")
    }

    fn execute_answers_the_page_value_while_on(h: &Harness) -> Result<(), String> {
        h.allow_javascript(true);
        h.mock
            .set_evaluator(|_, _| Ok(Some(Value::String("{\"value\":\"2\"}".into()))));
        let tab = h.new_tab();
        let command = FakeCommand::new(Some("1+1"));
        send(tab.as_str(), "execute", &command);
        h.settle();
        let seen = command.ivars();
        ensure(seen.resumed.get() == 1, "execute resumes once")?;
        ensure(seen.error_number.get() == 0, "no error")?;
        ensure(
            seen.result.borrow().as_deref() == Some("2"),
            format!("the value comes back, got {:?}", seen.result.borrow()),
        )
    }

    fn a_missing_parameter_fails_without_suspending(h: &Harness) -> Result<(), String> {
        let tab = h.new_tab();
        let command = FakeCommand::new(None);
        send(tab.as_str(), "execute", &command);
        h.settle();
        let seen = command.ivars();
        ensure(seen.suspended.get() == 0, "nothing is suspended")?;
        ensure(seen.error_number.get() == -10000, "error number -10000")?;
        ensure(
            *seen.error_text.borrow() == MISSING_JAVASCRIPT,
            "the old message",
        )
    }

    pub fn run() -> i32 {
        if MainThreadMarker::new().is_none() {
            eprintln!("applescript_main_thread must run on the main thread");
            return 1;
        }
        let _ = register();
        let harness = Harness::new();
        let checks: [(&str, Check); 5] = [
            (
                "suspends_then_resumes_on_the_main_thread",
                suspends_then_resumes_on_the_main_thread,
            ),
            (
                "an_unknown_tab_resumes_with_the_old_error",
                an_unknown_tab_resumes_with_the_old_error,
            ),
            (
                "execute_is_refused_with_error_twelve_while_off",
                execute_is_refused_with_error_twelve_while_off,
            ),
            (
                "execute_answers_the_page_value_while_on",
                execute_answers_the_page_value_while_on,
            ),
            (
                "a_missing_parameter_fails_without_suspending",
                a_missing_parameter_fails_without_suspending,
            ),
        ];
        let mut failed = 0;
        for (name, check) in checks {
            match check(&harness) {
                Ok(()) => println!("test {name} ... ok"),
                Err(problem) => {
                    failed += 1;
                    println!("test {name} ... FAILED: {problem}");
                }
            }
        }
        println!(
            "test result: {}. {} passed; {failed} failed",
            if failed == 0 { "ok" } else { "FAILED" },
            checks.len() - failed
        );
        i32::from(failed > 0)
    }
}
