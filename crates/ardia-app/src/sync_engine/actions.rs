use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ardia_state::actions::{Action, NewTab};
use ardia_ui::sync_api::{PhraseProblem, SyncAction, SyncAnswer};

use super::{SyncEngine, owner_check, recovery_kit};

pub const PANEL_WAIT: Duration = Duration::from_secs(3600);
pub const CHOOSE_PROMPT: &str = "Use Folder";
pub const CHOOSE_MESSAGE: &str = "Choose a folder that syncs between your Macs, like one in iCloud Drive or Dropbox, or on a NAS or USB drive.";
pub const CLOUD_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preferences.AppleIDPrefPane";
pub const CONCEALED_TYPE: &str = "org.nspasteboard.ConcealedType";
pub const TEST_PASTEBOARD: &str = "com.ardia.sync.test";

fn image(png: Option<Vec<u8>>) -> SyncAnswer {
    SyncAnswer::Image(
        png.map(|bytes| Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png, bytes))),
    )
}

fn disclose<T>(engine: &SyncEngine, reveal: impl FnOnce(Vec<String>) -> Option<T>) -> Option<T> {
    let words = engine.recovery_words()?;
    if !owner_check::confirm(owner_check::REASON) {
        return None;
    }
    reveal(words)
}

fn kit_date() -> String {
    recovery_kit::created_date(ardia_state::store::now_ms())
}

fn kit_device() -> String {
    let name = super::device_name();
    if name.starts_with("This ") {
        "this Mac".to_owned()
    } else {
        name
    }
}

pub fn pasteboard_name() -> Option<String> {
    if let Ok(name) = std::env::var("ARDIA_TEST_PASTEBOARD")
        && !name.trim().is_empty()
    {
        return Some(name);
    }
    owner_check::background().then(|| TEST_PASTEBOARD.to_owned())
}

pub fn run(engine: &Arc<SyncEngine>, action: SyncAction) -> SyncAnswer {
    match action {
        SyncAction::TurnOn { folder } => match engine.turn_on(&folder) {
            Ok(()) => SyncAnswer::Done,
            Err(problem) => SyncAnswer::Failed(problem.text()),
        },
        SyncAction::EnterPhrase { folder, phrase } => {
            SyncAnswer::Phrase(engine.enter_phrase(&folder, &zeroize::Zeroizing::new(phrase.0)))
        }
        SyncAction::Stop { delete_data } => {
            engine.stop(delete_data);
            SyncAnswer::Done
        }
        SyncAction::SyncNow => SyncAnswer::Flag(engine.sync_now()),
        SyncAction::ChooseFolder => {
            let current = engine.published().folder;
            let picked = platform::choose_folder(engine, current);
            if let Some(path) = picked.as_ref() {
                engine.set_folder(path);
            }
            SyncAnswer::Path(picked)
        }
        SyncAction::SetFolder(path) => {
            engine.set_folder(&path);
            SyncAnswer::Done
        }
        SyncAction::FolderInfo(path) => {
            SyncAnswer::Folder(Some(engine.folder_info(path.as_deref())))
        }
        SyncAction::AddRemoteProfile(sync_id) => {
            SyncAnswer::Flag(engine.add_remote_profile(&sync_id).is_some())
        }
        SyncAction::RemoveRemoteProfile(sync_id) => {
            SyncAnswer::Flag(engine.remove_remote_profile(&sync_id))
        }
        SyncAction::RemoveDevice(id) => SyncAnswer::Flag(engine.remove_device(&id)),
        SyncAction::RecoveryWords => SyncAnswer::Words(disclose(engine, Some)),
        SyncAction::RecoveryQrCode => {
            let code = disclose(engine, |words| {
                recovery_kit::qr_png(&words, recovery_kit::QR_SCALE)
            });
            ardia_telemetry::counts::count(if code.is_some() {
                "sync_codes_shown"
            } else {
                "sync_codes_declined"
            });
            image(code)
        }
        SyncAction::RecoveryKitPreview { width } => {
            if engine.recovery_words().is_none() {
                return SyncAnswer::Image(None);
            }
            image(recovery_kit::preview_png(
                f64::from(width),
                platform::backing_scale(),
                &kit_date(),
                &kit_device(),
            ))
        }
        SyncAction::SaveRecoveryKit { text } => {
            if engine.recovery_words().is_none() {
                return SyncAnswer::Failed("Sync isn't set up on this Mac.".to_owned());
            }
            let name = if text {
                recovery_kit::TEXT_NAME
            } else {
                recovery_kit::PDF_NAME
            };
            let Some(target) = platform::save_panel(engine, name, text) else {
                return SyncAnswer::Path(None);
            };
            let written = disclose(engine, |words| {
                let bytes = if text {
                    recovery_kit::text(&words, &kit_date(), &kit_device()).into_bytes()
                } else {
                    recovery_kit::pdf(&words, &kit_date(), &kit_device())
                };
                recovery_kit::write_atomic(&PathBuf::from(&target), &bytes)
                    .ok()
                    .map(|_| target.clone())
            });
            SyncAnswer::Path(written)
        }
        SyncAction::CopyRecoveryKit => SyncAnswer::Flag(
            disclose(engine, |words| {
                let path = recovery_kit::write_temporary_kit(&recovery_kit::pdf(
                    &words,
                    &kit_date(),
                    &kit_device(),
                ))
                .ok()?;
                platform::copy_file(engine, &path).then_some(())
            })
            .is_some(),
        ),
        SyncAction::ShareRecoveryKit => SyncAnswer::Flag(
            disclose(engine, |words| {
                let path = recovery_kit::write_temporary_kit(&recovery_kit::pdf(
                    &words,
                    &kit_date(),
                    &kit_device(),
                ))
                .ok()?;
                platform::share_file(engine, &path).then_some(())
            })
            .is_some(),
        ),
        SyncAction::CopyRecoveryPhrase => SyncAnswer::Flag(
            disclose(engine, |words| {
                platform::copy_concealed(engine, &words.join(" ")).then_some(())
            })
            .is_some(),
        ),
        SyncAction::RevealFolder(path) => {
            platform::reveal(&path);
            SyncAnswer::Done
        }
        SyncAction::OpenCloudSettings => {
            platform::open_url(CLOUD_SETTINGS_URL);
            SyncAnswer::Done
        }
        SyncAction::SendTab { tab, device } => SyncAnswer::Flag(engine.send_tab(&tab, &device)),
        SyncAction::AddSharedFolder { window } => {
            crate::shared_folders::add_shared_folder(engine, &window)
        }
        SyncAction::ShareFolder { window, group } => {
            crate::shared_folders::share_folder(engine, &window, &group)
        }
        SyncAction::RevealSharedFolder { group } => {
            crate::shared_folders::reveal_group_folder(engine, &group)
        }
        SyncAction::StopSyncingFolder { group } => {
            crate::shared_folders::stop_syncing_group(engine, &group)
        }
        SyncAction::OpenRemoteTab {
            profile,
            device,
            index,
        } => {
            let url = engine
                .published()
                .view
                .remote_tabs
                .get(&profile)
                .and_then(|list| list.iter().find(|d| d.device_id == device))
                .and_then(|d| d.tabs.get(index))
                .map(|t| t.url.clone());
            let state = engine.host().state();
            let (Some(url), Some(window)) = (url, state.main_window_for(Some(&profile)).cloned())
            else {
                return SyncAnswer::Flag(false);
            };
            SyncAnswer::Flag(
                engine
                    .host()
                    .dispatch(Action::NewTab {
                        window,
                        tab: NewTab {
                            url: Some(url),
                            ..NewTab::default()
                        },
                    })
                    .is_ok(),
            )
        }
    }
}

pub fn phrase_problem(answer: &SyncAnswer) -> Option<&PhraseProblem> {
    match answer {
        SyncAnswer::Phrase(Err(problem)) => Some(problem),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
pub mod platform {
    use std::path::Path;
    use std::sync::mpsc;

    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    use super::{CHOOSE_MESSAGE, CHOOSE_PROMPT, CONCEALED_TYPE, PANEL_WAIT};
    use crate::sync_engine::{SyncEngine, owner_check};

    fn ns(text: &str) -> Retained<NSString> {
        NSString::from_str(text)
    }

    fn file_url(path: &str) -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"NSURL")?;
        unsafe { msg_send![class, fileURLWithPath: &*ns(path)] }
    }

    fn path_of(url: *mut AnyObject) -> Option<String> {
        if url.is_null() {
            return None;
        }
        let path: Option<Retained<NSString>> = unsafe { msg_send![url, path] };
        path.map(|p| p.to_string())
    }

    fn array(items: &[*const AnyObject]) -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"NSArray")?;
        unsafe { msg_send![class, arrayWithObjects: items.as_ptr(), count: items.len()] }
    }

    fn panel_answer(
        engine: &SyncEngine,
        start: impl FnOnce(mpsc::SyncSender<Option<String>>) + Send + 'static,
    ) -> Option<String> {
        if owner_check::background() {
            log::info!("[sync] a file panel was asked for in a hidden instance; not showing it");
            return None;
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        engine
            .host()
            .on_main(crate::sync_engine::host::MAIN_TIMEOUT, move |_| {
                start(sender)
            })?;
        receiver.recv_timeout(PANEL_WAIT).ok().flatten()
    }

    pub fn choose_folder(engine: &SyncEngine, current: Option<String>) -> Option<String> {
        pick_folder(engine, current, CHOOSE_PROMPT, Some(CHOOSE_MESSAGE))
    }

    pub fn pick_folder(
        engine: &SyncEngine,
        current: Option<String>,
        prompt: &'static str,
        message: Option<&'static str>,
    ) -> Option<String> {
        panel_answer(engine, move |sender| {
            let Some(class) = AnyClass::get(c"NSOpenPanel") else {
                let _ = sender.send(None);
                return;
            };
            unsafe {
                let panel: Option<Retained<AnyObject>> = msg_send![class, openPanel];
                let Some(panel) = panel else {
                    let _ = sender.send(None);
                    return;
                };
                let _: () = msg_send![&*panel, setCanChooseFiles: Bool::NO];
                let _: () = msg_send![&*panel, setCanChooseDirectories: Bool::YES];
                let _: () = msg_send![&*panel, setCanCreateDirectories: Bool::YES];
                let _: () = msg_send![&*panel, setAllowsMultipleSelection: Bool::NO];
                let _: () = msg_send![&*panel, setPrompt: &*ns(prompt)];
                if let Some(message) = message {
                    let _: () = msg_send![&*panel, setMessage: &*ns(message)];
                }
                if let Some(url) = current.as_deref().and_then(file_url) {
                    let _: () = msg_send![&*panel, setDirectoryURL: &*url];
                }
                let shown = panel.clone();
                let block = RcBlock::new(move |response: isize| {
                    let url: *mut AnyObject = if response == 1 {
                        msg_send![&*shown, URL]
                    } else {
                        std::ptr::null_mut()
                    };
                    let _ = sender.send(path_of(url));
                });
                let _: () = msg_send![&*panel, beginWithCompletionHandler: &*block];
            }
        })
    }

    pub fn save_panel(engine: &SyncEngine, name: &'static str, text: bool) -> Option<String> {
        panel_answer(engine, move |sender| {
            let Some(class) = AnyClass::get(c"NSSavePanel") else {
                let _ = sender.send(None);
                return;
            };
            unsafe {
                let panel: Option<Retained<AnyObject>> = msg_send![class, savePanel];
                let Some(panel) = panel else {
                    let _ = sender.send(None);
                    return;
                };
                let _: () = msg_send![&*panel, setNameFieldStringValue: &*ns(name)];
                if let Some(types) = AnyClass::get(c"UTType") {
                    let kind: Option<Retained<AnyObject>> = msg_send![types, typeWithIdentifier: &*ns(if text { "public.plain-text" } else { "com.adobe.pdf" })];
                    if let Some(list) = kind.as_ref().and_then(|k| array(&[Retained::as_ptr(k)])) {
                        let _: () = msg_send![&*panel, setAllowedContentTypes: &*list];
                    }
                }
                let _: () = msg_send![&*panel, setCanCreateDirectories: Bool::YES];
                let shown = panel.clone();
                let block = RcBlock::new(move |response: isize| {
                    let url: *mut AnyObject = if response == 1 {
                        msg_send![&*shown, URL]
                    } else {
                        std::ptr::null_mut()
                    };
                    let _ = sender.send(path_of(url));
                });
                let _: () = msg_send![&*panel, beginWithCompletionHandler: &*block];
            }
        })
    }

    fn pasteboard() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"NSPasteboard")?;
        unsafe {
            match super::pasteboard_name() {
                Some(name) => msg_send![class, pasteboardWithName: &*ns(&name)],
                None => msg_send![class, generalPasteboard],
            }
        }
    }

    pub fn copy_concealed(engine: &SyncEngine, text: &str) -> bool {
        let text = text.to_owned();
        engine
            .host()
            .on_main(crate::sync_engine::host::MAIN_TIMEOUT, move |_| {
                let Some(board) = pasteboard() else { return false };
                let string_type = ns("public.utf8-plain-text");
                let concealed = ns(CONCEALED_TYPE);
                let Some(types) = array(&[Retained::as_ptr(&string_type).cast(), Retained::as_ptr(&concealed).cast()]) else { return false };
                unsafe {
                    let _: isize = msg_send![&*board, clearContents];
                    let _: isize = msg_send![&*board, declareTypes: &*types, owner: std::ptr::null::<AnyObject>()];
                    let set: bool = msg_send![&*board, setString: &*ns(&text), forType: &*string_type];
                    let _: bool = msg_send![&*board, setString: &*ns(""), forType: &*concealed];
                    set
                }
            })
            .unwrap_or(false)
    }

    pub fn copy_file(engine: &SyncEngine, path: &Path) -> bool {
        let path = path.to_string_lossy().into_owned();
        engine
            .host()
            .on_main(crate::sync_engine::host::MAIN_TIMEOUT, move |_| {
                let (Some(board), Some(url)) = (pasteboard(), file_url(&path)) else {
                    return false;
                };
                let Some(items) = array(&[Retained::as_ptr(&url)]) else {
                    return false;
                };
                unsafe {
                    let _: isize = msg_send![&*board, clearContents];
                    msg_send![&*board, writeObjects: &*items]
                }
            })
            .unwrap_or(false)
    }

    pub fn share_file(engine: &SyncEngine, path: &Path) -> bool {
        if owner_check::background() {
            log::info!(
                "[sync] sharing the recovery kit in a hidden instance; not showing the picker"
            );
            return false;
        }
        let path = path.to_string_lossy().into_owned();
        engine
            .host()
            .on_main(crate::sync_engine::host::MAIN_TIMEOUT, move |_| unsafe {
                let Some(app_class) = AnyClass::get(c"NSApplication") else { return false };
                let app: *mut AnyObject = msg_send![app_class, sharedApplication];
                if app.is_null() {
                    return false;
                }
                let window: *mut AnyObject = msg_send![app, keyWindow];
                if window.is_null() {
                    return false;
                }
                let view: *mut AnyObject = msg_send![window, contentView];
                let Some(url) = file_url(&path) else { return false };
                let Some(items) = array(&[Retained::as_ptr(&url)]) else { return false };
                let Some(picker_class) = AnyClass::get(c"NSSharingServicePicker") else { return false };
                let allocated: *mut AnyObject = msg_send![picker_class, alloc];
                let picker: Option<Retained<AnyObject>> = Retained::from_raw(msg_send![allocated, initWithItems: &*items]);
                let Some(picker) = picker else { return false };
                let mouse: NSPoint = msg_send![window, mouseLocationOutsideOfEventStream];
                let point: NSPoint = msg_send![view, convertPoint: mouse, fromView: std::ptr::null::<AnyObject>()];
                const MIN_Y: usize = 1;
                let _: () = msg_send![&*picker, showRelativeToRect: NSRect::new(point, NSSize::new(0.0, 0.0)), ofView: view, preferredEdge: MIN_Y];
                true
            })
            .unwrap_or(false)
    }

    pub fn reveal(path: &str) {
        if let Err(problem) =
            ardia_engine::macos::platform::reveal_in_finder(&[std::path::PathBuf::from(path)])
        {
            log::warn!("couldn't show {path} in Finder: {problem}");
        }
    }

    pub fn open_url(url: &str) {
        let (Some(workspace_class), Some(url_class)) =
            (AnyClass::get(c"NSWorkspace"), AnyClass::get(c"NSURL"))
        else {
            return;
        };
        unsafe {
            let workspace: *mut AnyObject = msg_send![workspace_class, sharedWorkspace];
            let target: Option<Retained<AnyObject>> =
                msg_send![url_class, URLWithString: &*ns(url)];
            if let (false, Some(target)) = (workspace.is_null(), target) {
                let _: bool = msg_send![workspace, openURL: &*target];
            }
        }
    }

    pub fn backing_scale() -> f64 {
        let Some(class) = AnyClass::get(c"NSScreen") else {
            return 2.0;
        };
        unsafe {
            let screen: *mut AnyObject = msg_send![class, mainScreen];
            if screen.is_null() {
                return 2.0;
            }
            let scale: f64 = msg_send![screen, backingScaleFactor];
            if scale > 0.0 { scale } else { 2.0 }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub mod platform {
    use std::path::Path;

    use crate::sync_engine::SyncEngine;

    pub fn choose_folder(_engine: &SyncEngine, _current: Option<String>) -> Option<String> {
        None
    }

    pub fn pick_folder(
        _engine: &SyncEngine,
        _current: Option<String>,
        _prompt: &'static str,
        _message: Option<&'static str>,
    ) -> Option<String> {
        None
    }

    pub fn save_panel(_engine: &SyncEngine, _name: &'static str, _text: bool) -> Option<String> {
        None
    }

    pub fn copy_concealed(_engine: &SyncEngine, _text: &str) -> bool {
        false
    }

    pub fn copy_file(_engine: &SyncEngine, _path: &Path) -> bool {
        false
    }

    pub fn share_file(_engine: &SyncEngine, _path: &Path) -> bool {
        false
    }

    pub fn reveal(_path: &str) {}

    pub fn open_url(_url: &str) {}

    pub fn backing_scale() -> f64 {
        2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_ui::sync_api::PhraseText;

    fn make(dir: &std::path::Path) -> Arc<SyncEngine> {
        let store = Arc::new(ardia_state::BrowserStore::in_memory(
            ardia_state::BrowserState::default(),
            ardia_state::IdGen::new(1),
        ));
        SyncEngine::with_parts(
            dir,
            true,
            store,
            None,
            Box::new(crate::sync_engine::keys::FileKeyStore::new(dir)),
            Arc::new(crate::sync_engine::vault::PlainFolders),
            "Studio".into(),
            Default::default(),
        )
    }

    #[test]
    fn actions_drive_the_engine_without_appkit() {
        let data = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let sync = folder.path().join("Ardia Sync");
        let engine = make(data.path());
        let info = match run(
            &engine,
            SyncAction::FolderInfo(Some(sync.to_string_lossy().into_owned())),
        ) {
            SyncAnswer::Folder(Some(info)) => info,
            other => panic!("{other:?}"),
        };
        assert!(!info.exists && !info.has_sync_data);
        assert!(matches!(
            run(&engine, SyncAction::RecoveryKitPreview { width: 168. }),
            SyncAnswer::Image(None)
        ));
        assert!(matches!(
            run(
                &engine,
                SyncAction::TurnOn {
                    folder: sync.to_string_lossy().into_owned()
                }
            ),
            SyncAnswer::Done
        ));
        assert!(
            matches!(run(&engine, SyncAction::FolderInfo(Some(sync.to_string_lossy().into_owned()))), SyncAnswer::Folder(Some(info)) if info.exists && info.has_sync_data)
        );
        let other_dir = tempfile::tempdir().unwrap();
        let other = make(other_dir.path());
        let wrong = ["abandon"; 24].join(" ");
        let answer = run(
            &other,
            SyncAction::EnterPhrase {
                folder: sync.to_string_lossy().into_owned(),
                phrase: PhraseText(wrong),
            },
        );
        assert_eq!(phrase_problem(&answer), Some(&PhraseProblem::Checksum));
        let mut valid = vec!["abandon"; 23];
        valid.push("art");
        let answer = run(
            &other,
            SyncAction::EnterPhrase {
                folder: sync.to_string_lossy().into_owned(),
                phrase: PhraseText(valid.join(" ")),
            },
        );
        assert_eq!(phrase_problem(&answer), Some(&PhraseProblem::Mismatch));
        let answer = run(
            &other,
            SyncAction::EnterPhrase {
                folder: sync.to_string_lossy().into_owned(),
                phrase: PhraseText("one two".into()),
            },
        );
        assert_eq!(phrase_problem(&answer), Some(&PhraseProblem::WordCount(2)));
        assert!(matches!(
            run(&engine, SyncAction::Stop { delete_data: true }),
            SyncAnswer::Done
        ));
        assert!(!crate::sync_engine::vault::has_sync_data(&sync));
    }
}
