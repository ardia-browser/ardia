#[cfg(target_os = "macos")]
mod appkit {
    use std::ffi::c_void;
    use std::path::PathBuf;

    use ardia_engine::macos::dialogs::{Alert, FilePanel};
    use ardia_engine::macos::menu::{MenuContext, MenuEntry, dia_menu_bar};
    use ardia_engine::macos::{missing_classes, platform, retain_window};
    use ardia_engine::{Modifiers, NativeWindow, NativeWindowHandle};
    use objc2::rc::Retained;
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSWindow,
        NSWindowStyleMask,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use serde_json::{Value, json};

    type Check = fn(MainThreadMarker) -> Result<(), String>;

    fn ensure(condition: bool, what: impl Into<String>) -> Result<(), String> {
        if condition { Ok(()) } else { Err(what.into()) }
    }

    fn context() -> MenuContext {
        MenuContext {
            app_name: "Ardia".into(),
            profiles: vec![
                MenuEntry {
                    id: "p1".into(),
                    title: "Personal".into(),
                    current: true,
                },
                MenuEntry {
                    id: "p2".into(),
                    title: "Work".into(),
                    current: false,
                },
            ],
            ..MenuContext::default()
        }
    }

    fn find<'a>(items: &'a Value, title: &str) -> Option<&'a Value> {
        items
            .as_array()?
            .iter()
            .find(|item| item["title"] == json!(title))
    }

    fn menu_bar_materializes_through_appkit(_: MainThreadMarker) -> Result<(), String> {
        let described = dia_menu_bar(&context())
            .build_and_describe()
            .map_err(|e| e.to_string())?;
        let menus = described["menus"].as_array().ok_or("no menus")?;
        let titles: Vec<&str> = menus
            .iter()
            .filter_map(|menu| menu["title"].as_str())
            .collect();
        ensure(
            titles
                == [
                    "Ardia",
                    "File",
                    "Edit",
                    "View",
                    "Tabs",
                    "Bookmarks",
                    "History",
                    "Extensions",
                    "Window",
                    "Help",
                ],
            format!("menu titles {titles:?}"),
        )?;
        ensure(
            described["services"] == json!(true)
                && described["windows"] == json!(true)
                && described["help"] == json!(true),
            "menu roles",
        )?;
        let new_tab = find(&menus[1]["items"], "New Tab").ok_or("File › New Tab")?;
        ensure(
            new_tab["key"] == json!("t") && new_tab["modifiers"] == json!(Modifiers::COMMAND.0),
            format!("New Tab shortcut {new_tab}"),
        )?;
        ensure(
            new_tab["action"] == json!("perform:") && new_tab["command"] == json!("newTab"),
            "New Tab routes to the engine",
        )?;
        let hide = find(&menus[0]["items"], "Hide Ardia").ok_or("Ardia › Hide")?;
        ensure(
            hide["action"] == json!("hide:") && hide["kind"] == json!("standard"),
            "Hide uses AppKit",
        )?;
        let window_items = &menus[8]["items"];
        let profiles = find(window_items, "Profiles").ok_or("Window › Profiles")?;
        let personal = find(&profiles["items"], "Personal").ok_or("Profiles › Personal")?;
        ensure(
            personal["checked"] == json!(true),
            "the current profile is checked",
        )?;
        let email =
            find(&menus[1]["items"], "Email Page Location").ok_or("File › Email Page Location")?;
        ensure(email["hidden"] == json!(true), "hidden items stay hidden")?;
        Ok(())
    }

    fn alerts_materialize_with_the_right_buttons(_: MainThreadMarker) -> Result<(), String> {
        let described = Alert::confirm(
            "Close 3 tabs?",
            "They move to History.",
            "Close Tabs",
            "Cancel",
        )
        .destructive()
        .describe()
        .map_err(|e| e.to_string())?;
        let buttons = described["buttons"].as_array().ok_or("no buttons")?;
        ensure(buttons.len() == 2, "two buttons")?;
        ensure(
            buttons[0]["title"] == json!("Close Tabs") && buttons[0]["destructive"] == json!(true),
            "the confirm button is destructive",
        )?;
        ensure(
            buttons[1]["key"] == json!("\u{1b}") && described["cancel"] == json!(1),
            "Escape cancels",
        )?;
        let prompt = Alert::prompt("Rename Tab", "", "Inbox", "Name", "Rename")
            .describe()
            .map_err(|e| e.to_string())?;
        ensure(
            prompt["field"]["value"] == json!("Inbox"),
            "the prompt keeps its value",
        )?;
        Ok(())
    }

    fn engine_classes_are_absent_without_the_framework(_: MainThreadMarker) -> Result<(), String> {
        let missing = missing_classes();
        ensure(missing.len() == 5, format!("missing {missing:?}"))
    }

    fn background_guard_keeps_test_instances_from_activating(
        mtm: MainThreadMarker,
    ) -> Result<(), String> {
        let app = NSApplication::sharedApplication(mtm);
        platform::install_background_guard().map_err(|e| e.to_string())?;
        platform::install_background_guard().map_err(|e| e.to_string())?;
        ensure(
            platform::background_guard_installed(),
            "the guard reports itself",
        )?;
        ensure(
            app.activationPolicy() == NSApplicationActivationPolicy::Prohibited,
            "the app is prohibited from activating",
        )?;
        app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
        ensure(
            app.activationPolicy() == NSApplicationActivationPolicy::Prohibited,
            "a later Regular policy is refused",
        )?;
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(320.0, 200.0));
        let window: Retained<NSWindow> = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                frame,
                NSWindowStyleMask::Borderless,
                NSBackingStoreType::Buffered,
                true,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        window.setLevel(3);
        let forged =
            NativeWindow::borrowed(NativeWindowHandle(Retained::as_ptr(&window) as *mut c_void));
        ensure(
            platform::window_levels(&forged).is_err(),
            "borrowed handles are refused",
        )?;
        let handle = unsafe { retain_window(Retained::as_ptr(&window) as *mut c_void) }
            .ok_or("no window")?;
        ensure(handle.is_owned(), "retained handles are owned")?;
        let (asked, actual) = platform::window_levels(&handle).map_err(|e| e.to_string())?;
        ensure(
            asked == 3,
            format!("the window still reports its level ({asked})"),
        )?;
        ensure(
            actual < 0,
            format!("the window really sits below the owner's windows ({actual})"),
        )?;
        Ok(())
    }

    fn dialogs_answer_without_showing_in_background(_: MainThreadMarker) -> Result<(), String> {
        let mut alert = Alert::confirm("Delete everything?", "", "Delete", "Keep").show(None);
        let answer = alert
            .try_take()
            .ok_or("the alert waited for a person")?
            .map_err(|e| e.to_string())?;
        ensure(
            !answer.shown && answer.button == Some(1),
            format!("background alerts take the cancel button ({answer:?})"),
        )?;
        let mut panel = FilePanel::open_files().show(None);
        let paths = panel
            .try_take()
            .ok_or("the panel waited for a person")?
            .map_err(|e| e.to_string())?;
        ensure(paths.is_empty(), "background panels choose nothing")?;
        Ok(())
    }

    fn workspace_stays_put_in_background(_: MainThreadMarker) -> Result<(), String> {
        ensure(
            platform::open_external_url("mailto:nobody@ardia.dev") == Ok(false),
            "no mail app opens",
        )?;
        ensure(
            platform::reveal_in_finder(&[PathBuf::from("/tmp")]) == Ok(false),
            "Finder stays put",
        )?;
        Ok(())
    }

    fn menu_installs_as_the_main_menu(mtm: MainThreadMarker) -> Result<(), String> {
        dia_menu_bar(&context())
            .install()
            .map_err(|e| e.to_string())?;
        let app = NSApplication::sharedApplication(mtm);
        let menu = app.mainMenu().ok_or("no main menu")?;
        ensure(
            menu.numberOfItems() == 10,
            format!("{} top-level menus", menu.numberOfItems()),
        )?;
        ensure(
            app.windowsMenu().is_some(),
            "the Window menu is AppKit's window list",
        )?;
        Ok(())
    }

    pub fn run() -> i32 {
        let Some(mtm) = MainThreadMarker::new() else {
            eprintln!("appkit checks need the main thread");
            return 1;
        };
        let checks: [(&str, Check); 7] = [
            (
                "menu bar materializes through AppKit",
                menu_bar_materializes_through_appkit,
            ),
            (
                "alerts materialize with the right buttons",
                alerts_materialize_with_the_right_buttons,
            ),
            (
                "engine classes are absent without the framework",
                engine_classes_are_absent_without_the_framework,
            ),
            (
                "background guard keeps test instances from activating",
                background_guard_keeps_test_instances_from_activating,
            ),
            (
                "dialogs answer without showing in background",
                dialogs_answer_without_showing_in_background,
            ),
            (
                "workspace stays put in background",
                workspace_stays_put_in_background,
            ),
            (
                "menu installs as the main menu",
                menu_installs_as_the_main_menu,
            ),
        ];
        let mut failed = 0;
        for (name, check) in checks {
            match check(mtm) {
                Ok(()) => println!("test {name} ... ok"),
                Err(problem) => {
                    failed += 1;
                    println!("test {name} ... FAILED: {problem}");
                }
            }
        }
        println!(
            "\nappkit result: {} passed; {failed} failed",
            checks.len() - failed
        );
        i32::from(failed > 0)
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    std::process::exit(appkit::run());
}
