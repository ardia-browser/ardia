use std::sync::Arc;
use std::time::Duration;

use crate::scale::px;
use ardia_state::ProfileId;
use ardia_state::profiles::Profile;
use ardia_theme::ProfileColor;
use gpui::{
    AnyElement, Context, Entity, FontWeight, HighlightStyle, Image, IntoElement, ParentElement,
    SharedString, Styled, StyledText, UnderlineStyle, Window, div, prelude::*,
};

use crate::host::{Confirmation, NativeMenuItem};
use crate::host_data::{SyncStatus, ago, folder_label};
use crate::look::Palette;
use crate::msg::Msg;
use crate::primitives::controls::{ButtonKind, Checkbox, PushButton};
use crate::primitives::icons::{Icon, icon, symbol_icon};
use crate::primitives::sheets::{Dialog, dialog_actions};
use crate::primitives::text_input::{InputEvent, TextInput, multiline_text_field};
use crate::primitives::tokens::{SheetSize, line_height, radius, space, type_size};
use crate::settings::SettingsWindowView;
use crate::sync_api::{
    FolderInfo, PhraseText, RemoteProfile, SyncAction, SyncAnswer, SyncState, WORDS, device_detail,
    joined_message, looking_for_profiles, phrase_problem_text, phrase_word_count,
    remote_profile_description, status_line,
};

pub const COMPUTER: &str = "Mac";
pub const SYNCED_COMPUTER: &str = "Mac";
pub const SECRET_STORE: &str = "your Keychain";
pub const CLOUD_DRIVE: &str = "iCloud Drive";
pub const TURN_ON_CLOUD_DRIVE: &str = "Turn on iCloud Drive in System Settings";
pub const FILE_MANAGER: &str = "Finder";
pub const PREVIEW_WIDTH: f32 = 168.;
pub const PREVIEW_HEIGHT: f32 = 217.;
pub const SYNC_CODE_SIZE: f32 = 176.;
pub const SYNC_CODE_QUIET: f32 = 16.;
pub const SYNC_ICON: f32 = 28.;
pub const TICK: Duration = Duration::from_secs(30);
pub const PREFIX: &str = "settings:sync:";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhraseChange {
    None,
    PickThenEnter,
    ChooseThenReenter,
}

#[derive(Clone, Debug)]
pub enum SyncSheet {
    RecoveryKit {
        preview: Option<Arc<Image>>,
        saved: Option<String>,
    },
    Phrase {
        folder: Option<FolderInfo>,
        change: PhraseChange,
        busy: bool,
        error: Option<String>,
    },
    Joined,
    Connect {
        qr: Option<Arc<Image>>,
        words: Option<Vec<String>>,
    },
    Stop,
    DeleteData {
        understood: bool,
        busy: bool,
    },
}

impl SyncSheet {
    pub fn name(&self) -> &'static str {
        match self {
            SyncSheet::RecoveryKit { .. } => "recoveryKit",
            SyncSheet::Phrase { .. } => "phrase",
            SyncSheet::Joined => "joined",
            SyncSheet::Connect { .. } => "connect",
            SyncSheet::Stop => "stop",
            SyncSheet::DeleteData { .. } => "deleteData",
        }
    }
}

#[derive(Default)]
pub struct SyncUi {
    pub sheet: Option<SyncSheet>,
    pub phrase_input: Option<Entity<TextInput>>,
    pub folder: Option<FolderInfo>,
    pub turning_on: bool,
    pub failure: Option<String>,
    seen: Option<(bool, SyncState, Option<String>)>,
    tick: Option<gpui::Task<()>>,
    phrase_watch: Option<gpui::Subscription>,
}

impl SyncUi {
    pub fn sheet_name(&self) -> Option<&'static str> {
        self.sheet.as_ref().map(SyncSheet::name)
    }
}

pub fn ask(
    view: &mut SettingsWindowView,
    action: SyncAction,
    cx: &mut Context<SettingsWindowView>,
    then: impl FnOnce(&mut SettingsWindowView, SyncAnswer, &mut Context<SettingsWindowView>) + 'static,
) {
    let reply = view.host.sync_action(action);
    cx.spawn(async move |this, cx| {
        let answer = reply
            .await
            .unwrap_or_else(|_| SyncAnswer::Failed("the browser didn't answer".to_owned()));
        let _ = this.update(cx, |view, cx| {
            then(view, answer, cx);
            cx.notify();
        });
    })
    .detach();
}

fn info_of(status: &SyncStatus, ui: &SyncUi) -> Option<FolderInfo> {
    status
        .engine
        .folder_info
        .clone()
        .or_else(|| ui.folder.clone())
}

pub fn start(view: &mut SettingsWindowView, cx: &mut Context<SettingsWindowView>) {
    refresh(view, cx);
    view.sync.tick = Some(cx.spawn(async move |this, cx| {
        loop {
            cx.background_executor().timer(TICK).await;
            if this.update(cx, |_, cx| cx.notify()).is_err() {
                break;
            }
        }
    }));
}

pub fn refresh(view: &mut SettingsWindowView, cx: &mut Context<SettingsWindowView>) {
    let status = &view.sync_status;
    let key = (status.enabled, status.engine.state, status.folder.clone());
    if view.sync.seen.as_ref() == Some(&key) {
        return;
    }
    view.sync.seen = Some(key);
    reload_folder(view, cx);
}

fn reload_folder(view: &mut SettingsWindowView, cx: &mut Context<SettingsWindowView>) {
    let folder = view.sync_status.folder.clone();
    ask(
        view,
        SyncAction::FolderInfo(folder),
        cx,
        |view, answer, _| {
            if let SyncAnswer::Folder(info) = answer {
                view.sync.folder = info;
            }
        },
    );
}

fn open(
    view: &mut SettingsWindowView,
    sheet: SyncSheet,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let phrase = matches!(sheet, SyncSheet::Phrase { .. });
    let kit = matches!(sheet, SyncSheet::RecoveryKit { .. });
    view.sync.sheet = Some(sheet);
    if phrase {
        let input = phrase_input(view, window, cx);
        input.update(cx, |input, cx| input.set_text("", false, cx));
        cx.defer_in(window, move |_, window, cx| {
            crate::primitives::text_input::focus_input(&input, window, cx)
        });
    }
    if kit {
        ask(
            view,
            SyncAction::RecoveryKitPreview {
                width: PREVIEW_WIDTH,
            },
            cx,
            |view, answer, _| {
                if let (SyncAnswer::Image(image), Some(SyncSheet::RecoveryKit { preview, .. })) =
                    (answer, view.sync.sheet.as_mut())
                {
                    *preview = image;
                }
            },
        );
    }
    cx.notify();
}

fn phrase_input(
    view: &mut SettingsWindowView,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) -> Entity<TextInput> {
    if let Some(input) = view.sync.phrase_input.clone() {
        return input;
    }
    let style = crate::primitives::text_input::text_field_style(&view.look);
    let input = cx.new(|cx| TextInput::new("Enter your 24-word recovery phrase", cx).multiline());
    input.update(cx, |input, cx| input.set_style(style, cx));
    view.sync.phrase_watch = Some(cx.subscribe_in(
        &input,
        window,
        |view, _, event: &InputEvent, window, cx| match event {
            InputEvent::Changed { .. } => {
                if let Some(SyncSheet::Phrase { error, .. }) = view.sync.sheet.as_mut() {
                    *error = None;
                }
                cx.notify();
            }
            InputEvent::Cancel => close(view, window, cx),
            _ => {}
        },
    ));
    view.sync.phrase_input = Some(input.clone());
    input
}

pub fn close(
    view: &mut SettingsWindowView,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    if matches!(
        view.sync.sheet,
        Some(SyncSheet::DeleteData { busy: false, .. })
    ) {
        finish_stop(view, false, cx);
        return;
    }
    view.sync.sheet = None;
    window.focus(&view.focus, cx);
    cx.notify();
}

fn finish_stop(
    view: &mut SettingsWindowView,
    delete_data: bool,
    cx: &mut Context<SettingsWindowView>,
) {
    if let Some(SyncSheet::DeleteData { busy, .. }) = view.sync.sheet.as_mut() {
        *busy = true;
    }
    ask(view, SyncAction::Stop { delete_data }, cx, |view, _, cx| {
        view.sync.sheet = None;
        view.sync.seen = None;
        refresh(view, cx);
    });
}

fn show_menu(
    view: &mut SettingsWindowView,
    items: Vec<NativeMenuItem>,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(choice) = view.host.show_menu(items) else {
        return;
    };
    cx.spawn_in(window, async move |view, cx| {
        if let Ok(Some(choice)) = choice.await {
            let _ = view.update_in(cx, |view, window, cx| {
                run(view, &format!("{PREFIX}menu:{choice}"), window, cx);
            });
        }
    })
    .detach();
}

pub fn more_menu_items(has_data: bool, no_icloud: bool) -> Vec<NativeMenuItem> {
    let mut items = vec![
        NativeMenuItem::new("folder", "Choose Sync Folder…", "folder"),
        NativeMenuItem::separator(),
    ];
    if has_data {
        items.push(
            NativeMenuItem::new("new", "Set Up Without Another Device", "plus.app")
                .enabled(!no_icloud),
        );
    }
    items.push(NativeMenuItem::new(
        "phrase",
        "Enter Recovery Phrase…",
        "key",
    ));
    items
}

pub fn advanced_menu_items(locked: bool, folder_exists: bool) -> Vec<NativeMenuItem> {
    vec![
        NativeMenuItem::new("kit", "Save Recovery Kit…", "arrow.down.doc").enabled(!locked),
        NativeMenuItem::new("copy", "Copy Recovery Code", "doc.on.doc").enabled(!locked),
        NativeMenuItem::separator(),
        NativeMenuItem::new("now", "Sync Now", "arrow.triangle.2.circlepath"),
        NativeMenuItem::new(
            "reveal",
            format!("Show Sync Folder in {FILE_MANAGER}"),
            "folder",
        )
        .enabled(folder_exists),
        NativeMenuItem::separator(),
        NativeMenuItem::new("stop", "Stop Syncing…", "xmark.circle"),
    ]
}

pub fn kit_menu_items() -> Vec<NativeMenuItem> {
    vec![
        NativeMenuItem::new("kitCopy", "Copy", "doc.on.doc"),
        NativeMenuItem::new("kitShare", "Share…", "square.and.arrow.up"),
        NativeMenuItem::separator(),
        NativeMenuItem::new("kitText", "Save as Text…", "doc.plaintext"),
    ]
}

pub fn no_icloud(info: Option<&FolderInfo>) -> bool {
    info.is_some_and(|info| info.path == info.default_path && !info.icloud_available)
}

fn turn_on(
    view: &mut SettingsWindowView,
    path: Option<String>,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(folder) = path.or_else(|| info_of(&view.sync_status, &view.sync).map(|i| i.path))
    else {
        return;
    };
    view.sync.turning_on = true;
    view.sync.failure = None;
    ask(
        view,
        SyncAction::TurnOn { folder },
        cx,
        |view, answer, cx| {
            view.sync.turning_on = false;
            match answer {
                SyncAnswer::Failed(problem) => view.sync.failure = Some(problem),
                _ => {
                    view.sync.sheet = Some(SyncSheet::RecoveryKit {
                        preview: None,
                        saved: None,
                    });
                    ask(
                        view,
                        SyncAction::RecoveryKitPreview {
                            width: PREVIEW_WIDTH,
                        },
                        cx,
                        |view, answer, _| {
                            if let (
                                SyncAnswer::Image(image),
                                Some(SyncSheet::RecoveryKit { preview, .. }),
                            ) = (answer, view.sync.sheet.as_mut())
                            {
                                *preview = image;
                            }
                        },
                    );
                }
            }
        },
    );
}

fn choose_then(
    view: &mut SettingsWindowView,
    cx: &mut Context<SettingsWindowView>,
    then: impl FnOnce(&mut SettingsWindowView, String, &mut Context<SettingsWindowView>) + 'static,
) {
    ask(
        view,
        SyncAction::ChooseFolder,
        cx,
        move |view, answer, cx| {
            if let SyncAnswer::Path(Some(picked)) = answer {
                view.sync.seen = None;
                then(view, picked, cx);
            }
        },
    );
}

fn enter_phrase(
    view: &mut SettingsWindowView,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let info = info_of(&view.sync_status, &view.sync);
    open(
        view,
        SyncSheet::Phrase {
            folder: info,
            change: PhraseChange::ChooseThenReenter,
            busy: false,
            error: None,
        },
        window,
        cx,
    );
}

pub fn run(
    view: &mut SettingsWindowView,
    id: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(command) = id.strip_prefix(PREFIX) else {
        return;
    };
    let status = view.sync_status.clone();
    let info = info_of(&status, &view.sync);
    let locked = status.engine.state == SyncState::Locked;
    match command {
        "turnOn" => turn_on(view, None, cx),
        "more" => {
            let items = more_menu_items(
                info.as_ref().is_some_and(|i| i.has_sync_data),
                no_icloud(info.as_ref()),
            );
            show_menu(view, items, window, cx);
        }
        "advanced" => show_menu(
            view,
            advanced_menu_items(locked, info.as_ref().is_some_and(|i| i.exists)),
            window,
            cx,
        ),
        "phrase" | "menu:phrase" => enter_phrase(view, window, cx),
        "lockedPhrase" => open(
            view,
            SyncSheet::Phrase {
                folder: info,
                change: PhraseChange::None,
                busy: false,
                error: None,
            },
            window,
            cx,
        ),
        "menu:folder" | "chooseFolder" => {
            choose_then(view, cx, |view, _, cx| reload_folder(view, cx))
        }
        "menu:new" => turn_on(view, None, cx),
        "menu:kit" | "kit" => open(
            view,
            SyncSheet::RecoveryKit {
                preview: None,
                saved: None,
            },
            window,
            cx,
        ),
        "menu:copy" => ask(view, SyncAction::CopyRecoveryPhrase, cx, |_, _, _| {}),
        "menu:now" => ask(view, SyncAction::SyncNow, cx, |_, _, _| {}),
        "menu:reveal" => {
            if let Some(info) = info {
                ask(view, SyncAction::RevealFolder(info.path), cx, |_, _, _| {});
            }
        }
        "menu:stop" | "stop" => open(view, SyncSheet::Stop, window, cx),
        "connect" => open(
            view,
            SyncSheet::Connect {
                qr: None,
                words: None,
            },
            window,
            cx,
        ),
        "openICloud" => ask(view, SyncAction::OpenCloudSettings, cx, |_, _, _| {}),
        "close" => close(view, window, cx),
        "kitSave" | "menu:kitText" => {
            let text = command == "menu:kitText";
            ask(
                view,
                SyncAction::SaveRecoveryKit { text },
                cx,
                |view, answer, _| {
                    if let (
                        SyncAnswer::Path(Some(path)),
                        Some(SyncSheet::RecoveryKit { saved, .. }),
                    ) = (answer, view.sync.sheet.as_mut())
                    {
                        *saved = Some(path);
                    }
                },
            );
        }
        "kitMore" => show_menu(view, kit_menu_items(), window, cx),
        "menu:kitCopy" => ask(view, SyncAction::CopyRecoveryKit, cx, |_, _, _| {}),
        "menu:kitShare" => ask(view, SyncAction::ShareRecoveryKit, cx, |_, _, _| {}),
        "phraseChange" => match view.sync.sheet.clone() {
            Some(SyncSheet::Phrase {
                change: PhraseChange::PickThenEnter,
                ..
            }) => {
                choose_then(view, cx, |view, picked, cx| {
                    view.sync.sheet = None;
                    let reply = view.host.sync_action(SyncAction::FolderInfo(Some(picked)));
                    cx.spawn(async move |this, cx| {
                        let folder = match reply.await {
                            Ok(SyncAnswer::Folder(info)) => info,
                            _ => None,
                        };
                        let _ = this.update(cx, |view, cx| {
                            view.sync.sheet = Some(SyncSheet::Phrase {
                                folder,
                                change: PhraseChange::PickThenEnter,
                                busy: false,
                                error: None,
                            });
                            cx.notify();
                        });
                    })
                    .detach();
                });
            }
            Some(SyncSheet::Phrase {
                change: PhraseChange::ChooseThenReenter,
                ..
            }) => {
                choose_then(view, cx, |view, _, cx| {
                    let reply = view.host.sync_action(SyncAction::FolderInfo(None));
                    cx.spawn(async move |this, cx| {
                        let folder = match reply.await {
                            Ok(SyncAnswer::Folder(info)) => info,
                            _ => None,
                        };
                        let _ = this.update(cx, |view, cx| {
                            view.sync.folder = folder.clone();
                            view.sync.sheet = Some(SyncSheet::Phrase {
                                folder,
                                change: PhraseChange::None,
                                busy: false,
                                error: None,
                            });
                            cx.notify();
                        });
                    })
                    .detach();
                });
            }
            _ => {}
        },
        "phraseConnect" => submit_phrase(view, cx),
        "showCode" => ask(view, SyncAction::RecoveryQrCode, cx, |view, answer, _| {
            if let (SyncAnswer::Image(image), Some(SyncSheet::Connect { qr, .. })) =
                (answer, view.sync.sheet.as_mut())
            {
                *qr = image;
            }
        }),
        "toggleWords" => {
            if let Some(SyncSheet::Connect { words: Some(_), .. }) = view.sync.sheet.as_ref() {
                if let Some(SyncSheet::Connect { words, .. }) = view.sync.sheet.as_mut() {
                    *words = None;
                }
            } else {
                ask(view, SyncAction::RecoveryWords, cx, |view, answer, _| {
                    if let (SyncAnswer::Words(found), Some(SyncSheet::Connect { words, .. })) =
                        (answer, view.sync.sheet.as_mut())
                    {
                        *words = found;
                    }
                });
            }
        }
        "copyWords" => ask(view, SyncAction::CopyRecoveryPhrase, cx, |_, _, _| {}),
        "stopConfirm" => open(
            view,
            SyncSheet::DeleteData {
                understood: false,
                busy: false,
            },
            window,
            cx,
        ),
        "stopKit" => open(
            view,
            SyncSheet::RecoveryKit {
                preview: None,
                saved: None,
            },
            window,
            cx,
        ),
        "understood" => {
            if let Some(SyncSheet::DeleteData { understood, .. }) = view.sync.sheet.as_mut() {
                *understood = !*understood;
            }
        }
        "keepData" => finish_stop(view, false, cx),
        "deleteData" => {
            if matches!(
                view.sync.sheet,
                Some(SyncSheet::DeleteData {
                    understood: true,
                    busy: false
                })
            ) {
                finish_stop(view, true, cx);
            }
        }
        "addAll" => {
            for profile in status.engine.remote_profiles.iter().filter(|p| !p.waiting) {
                ask(
                    view,
                    SyncAction::AddRemoteProfile(profile.sync_id.clone()),
                    cx,
                    |_, _, _| {},
                );
            }
        }
        other => {
            if let Some(sync_id) = other.strip_prefix("add:") {
                ask(
                    view,
                    SyncAction::AddRemoteProfile(sync_id.to_owned()),
                    cx,
                    |_, _, _| {},
                );
            } else if let Some(sync_id) = other.strip_prefix("remove:") {
                if let Some(profile) = status
                    .engine
                    .remote_profiles
                    .iter()
                    .find(|p| p.sync_id == sync_id)
                {
                    confirm_then(
                        view,
                        remove_profile_question(&profile.name),
                        SyncAction::RemoveRemoteProfile(sync_id.to_owned()),
                        cx,
                    );
                }
            } else if let Some(id) = other.strip_prefix("removeDevice:")
                && let Some(device) = status.engine.devices.iter().find(|d| d.id == id)
            {
                confirm_then(
                    view,
                    remove_device_question(&device.name),
                    SyncAction::RemoveDevice(id.to_owned()),
                    cx,
                );
            }
        }
    }
    cx.notify();
}

pub fn remove_profile_question(name: &str) -> Confirmation {
    Confirmation {
        title: format!("Remove “{name}” from Sync?"),
        message: "It leaves this list on all your devices. A device that still has this profile keeps it, and it comes back here.".to_owned(),
        confirm: "Remove".to_owned(),
        destructive: true,
    }
}

pub fn remove_device_question(name: &str) -> Confirmation {
    Confirmation {
        title: format!("Remove “{name}” from Sync?"),
        message: "It leaves this list on all your devices, with the tabs it shared. Its data stays on it, and if it still syncs, it comes back here.".to_owned(),
        confirm: "Remove".to_owned(),
        destructive: true,
    }
}

fn confirm_then(
    view: &mut SettingsWindowView,
    question: Confirmation,
    action: SyncAction,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(window) = view.state.main_window_for(None).cloned() else {
        return;
    };
    let answer = view.host.confirm_in_window(window, question);
    let host = view.host.clone();
    cx.spawn(async move |_, _| {
        if answer.await.unwrap_or(false) {
            let _ = host.sync_action(action).await;
        }
    })
    .detach();
}

fn submit_phrase(view: &mut SettingsWindowView, cx: &mut Context<SettingsWindowView>) {
    let Some(SyncSheet::Phrase {
        folder: Some(folder),
        busy: false,
        ..
    }) = view.sync.sheet.clone()
    else {
        return;
    };
    let Some(input) = view.sync.phrase_input.clone() else {
        return;
    };
    let text = input.read(cx).text().to_owned();
    if phrase_word_count(&text) != WORDS {
        return;
    }
    if let Some(SyncSheet::Phrase { busy, error, .. }) = view.sync.sheet.as_mut() {
        *busy = true;
        *error = None;
    }
    let joining = !view.sync_status.enabled;
    ask(
        view,
        SyncAction::EnterPhrase {
            folder: folder.path,
            phrase: PhraseText(text),
        },
        cx,
        move |view, answer, cx| {
            let problem = match answer {
                SyncAnswer::Phrase(Ok(())) | SyncAnswer::Done => None,
                SyncAnswer::Phrase(Err(problem)) => {
                    Some(phrase_problem_text(&problem, SECRET_STORE))
                }
                SyncAnswer::Failed(problem) => Some(problem),
                _ => None,
            };
            match problem {
                Some(message) => {
                    if let Some(SyncSheet::Phrase { busy, error, .. }) = view.sync.sheet.as_mut() {
                        *busy = false;
                        *error = Some(message);
                    }
                }
                None => {
                    if let Some(input) = view.sync.phrase_input.clone() {
                        input.update(cx, |input, cx| input.set_text("", false, cx));
                    }
                    view.sync.sheet = if joining {
                        Some(SyncSheet::Joined)
                    } else {
                        None
                    };
                    view.sync.seen = None;
                    refresh(view, cx);
                }
            }
        },
    );
}

fn command(id: &str) -> Msg {
    Msg::Command(SharedString::from(format!("{PREFIX}{id}")))
}

fn button(
    view: &SettingsWindowView,
    id: &'static str,
    title: impl Into<SharedString>,
    kind: ButtonKind,
    disabled: bool,
    cmd: String,
) -> AnyElement {
    let p = view.look.p;
    div()
        .debug_selector(move || id.into())
        .child(
            PushButton::new(id, title.into(), &p)
                .kind(kind)
                .disabled(disabled)
                .on_click(view.emit.click(Msg::Command(SharedString::from(cmd)))),
        )
        .into_any_element()
}

fn cmd(id: &str) -> String {
    format!("{PREFIX}{id}")
}

fn body(p: &Palette, text: impl Into<SharedString>) -> AnyElement {
    div()
        .mt(px(space::ML))
        .text_size(px(type_size::SMALL))
        .line_height(px(line_height::PROSE_SMALL))
        .text_color(p.text_secondary)
        .child(text.into())
        .into_any_element()
}

pub fn home() -> Option<String> {
    std::env::var("HOME").ok()
}

pub fn label_of(info: &FolderInfo) -> String {
    folder_label(&info.path, home().as_deref())
}

pub fn saved_label(path: &str) -> String {
    let rest = path
        .strip_prefix("/Users/")
        .and_then(|r| r.find('/').map(|i| &r[i..]));
    match rest {
        Some(rest) => format!("~{rest}"),
        None => path.to_owned(),
    }
}

fn warning_fill(dark: bool) -> gpui::Hsla {
    if dark {
        gpui::rgba(0xff9f0a1f).into()
    } else {
        gpui::rgba(0xff95001a).into()
    }
}

fn recovery_kit_sheet(
    view: &SettingsWindowView,
    preview: Option<Arc<Image>>,
    saved: Option<String>,
) -> AnyElement {
    let p = view.look.p;
    let warning = "Save a copy of your Recovery Kit to another device or to the cloud. You’ll need it if you lose access to this device.";
    let start = warning.find("another").unwrap_or(0);
    let underline = HighlightStyle {
        underline: Some(UnderlineStyle {
            thickness: px(1.),
            color: None,
            wavy: false,
        }),
        ..HighlightStyle::default()
    };
    let left = div()
        .flex_1()
        .min_w_0()
        .child(sheet_title(
            "Save Your Recovery Kit",
            Some("Your Recovery Kit contains all you need to recover your data should you lose access to this device.".into()),
            None,
            &p,
        ))
        .child(
            div()
                .debug_selector(|| "sync-kit-warning".into())
                .mt(px(space::XL))
                .p(px(space::ML))
                .rounded(px(radius::PANEL))
                .bg(warning_fill(view.look.dark))
                .flex()
                .gap(px(space::M))
                .child(div().flex_none().size(px(16.)).flex().items_center().justify_center().child(icon(Icon::from_symbol("exclamationmark.triangle.fill").unwrap_or(Icon::ExclamationCircleFill), 12., p.warning)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(type_size::SMALL))
                        .line_height(px(line_height::BODY))
                        .text_color(p.text)
                        .child(StyledText::new(warning).with_highlights([(start..start + "another".len(), underline)])),
                ),
        )
        .when_some(saved, |this, saved| this.child(div().debug_selector(|| "sync-kit-saved".into()).child(body(&p, format!("Saved to {}.", saved_label(&saved))))));
    let frame = div()
        .debug_selector(|| "sync-kit-preview".into())
        .flex_none()
        .w(px(PREVIEW_WIDTH))
        .h(px(PREVIEW_HEIGHT))
        .rounded(px(radius::CONTROL))
        .overflow_hidden()
        .border_1()
        .border_color(p.group_border)
        .bg(gpui::white())
        .children(preview.map(|image| gpui::img(image).w(px(PREVIEW_WIDTH)).h(px(PREVIEW_HEIGHT))));
    Dialog::sheet("sync-kit-sheet", SheetSize::L, &p)
        .on_dismiss(close_handler(view))
        .child(div().flex().gap(px(space::XL)).child(left).child(frame))
        .child(dialog_actions(
            Some(button(
                view,
                "sync-kit-more",
                "Other Options",
                ButtonKind::Plain,
                false,
                cmd("kitMore"),
            )),
            None,
            [
                button(
                    view,
                    "sync-kit-close",
                    "Close",
                    ButtonKind::Plain,
                    false,
                    cmd("close"),
                ),
                button(
                    view,
                    "sync-kit-save",
                    "Save…",
                    ButtonKind::Primary,
                    false,
                    cmd("kitSave"),
                ),
            ],
            &p,
        ))
        .into_any_element()
}

fn close_handler(view: &SettingsWindowView) -> impl Fn(&mut Window, &mut gpui::App) + 'static {
    let emit = view.emit.clone();
    move |window, cx| emit.send(command("close"), window, cx)
}

pub fn word_counter(count: usize) -> String {
    if count > WORDS {
        "too many words".to_owned()
    } else {
        format!("{count}/{WORDS} words")
    }
}

pub const TITLE_LIFT: f32 = 1.5;
pub const SUBTITLE_LIFT: f32 = 1.5;
pub const PHRASE_FIELD_DROP: f32 = 1.0;
pub const PHRASE_COUNT_LIFT: f32 = 2.5;
pub const PHRASE_FOLDER_LIFT: f32 = 5.0;
pub const PHRASE_ACTIONS_LIFT: f32 = 1.5;

fn sheet_title(
    title: impl Into<SharedString>,
    subtitle: Option<SharedString>,
    _leading: Option<AnyElement>,
    p: &Palette,
) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .debug_selector(|| "sync-sheet-title".into())
        .child(
            div()
                .mt(px(-TITLE_LIFT))
                .text_size(px(type_size::TITLE))
                .line_height(px(line_height::TITLE))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(p.text)
                .child(title.into()),
        )
        .when_some(subtitle, |this, subtitle| {
            this.child(
                div()
                    .mt(px(space::S - SUBTITLE_LIFT))
                    .text_size(px(type_size::SMALL))
                    .line_height(px(line_height::PROSE_SMALL))
                    .text_color(p.text_secondary)
                    .child(subtitle),
            )
        })
}

fn phrase_sheet(
    view: &SettingsWindowView,
    folder: Option<FolderInfo>,
    change: PhraseChange,
    busy: bool,
    error: Option<String>,
    cx: &gpui::App,
) -> AnyElement {
    let p = view.look.p;
    let text = view
        .sync
        .phrase_input
        .as_ref()
        .map(|i| i.read(cx).text().to_owned())
        .unwrap_or_default();
    let count = phrase_word_count(&text);
    let field = view.sync.phrase_input.clone().map(|input| {
        div()
            .debug_selector(|| "sync-phrase-field".into())
            .mt(px(space::L + PHRASE_FIELD_DROP))
            .font_family("Menlo")
            .child(multiline_text_field(&input, &p, error.is_some()))
    });
    let foot = div()
        .mt(px(space::S - PHRASE_COUNT_LIFT))
        .flex()
        .child(
            div()
                .debug_selector(|| "sync-phrase-error".into())
                .flex_1()
                .text_size(px(type_size::CAPTION))
                .line_height(px(line_height::CAPTION))
                .text_color(if error.is_some() {
                    p.destructive
                } else {
                    p.text_secondary
                })
                .child(SharedString::from(error.unwrap_or_default())),
        )
        .child(
            div()
                .debug_selector(|| "sync-phrase-count".into())
                .text_size(px(type_size::CAPTION))
                .text_color(if count > WORDS {
                    p.destructive
                } else {
                    p.text_tertiary
                })
                .child(SharedString::from(word_counter(count))),
        );
    let folder_row = folder.as_ref().map(|info| {
        div()
            .debug_selector(|| "sync-phrase-folder".into())
            .mt(px(space::ML - PHRASE_FOLDER_LIFT))
            .mb(px(-PHRASE_ACTIONS_LIFT))
            .flex()
            .items_center()
            .gap(px(space::S))
            .child(
                div()
                    .flex_none()
                    .size(px(14.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(symbol_icon("folder", Icon::Folder, 11., p.text_secondary)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(type_size::CAPTION))
                    .text_color(p.text_secondary)
                    .child(SharedString::from(label_of(info))),
            )
            .when(change != PhraseChange::None, |this| {
                this.child(button(
                    view,
                    "sync-phrase-change",
                    "Change…",
                    ButtonKind::Link,
                    false,
                    cmd("phraseChange"),
                ))
            })
    });
    Dialog::sheet("sync-phrase-sheet", SheetSize::M, &p)
        .on_dismiss(close_handler(view))
        .child(sheet_title(
            "Connect with Recovery Phrase",
            Some("Enter your 24-word recovery phrase to sync with another device.".into()),
            None,
            &p,
        ))
        .children(field)
        .child(foot)
        .children(folder_row)
        .child(dialog_actions(
            None,
            None,
            [
                button(
                    view,
                    "sync-phrase-cancel",
                    "Cancel",
                    ButtonKind::Plain,
                    false,
                    cmd("close"),
                ),
                button(
                    view,
                    "sync-phrase-connect",
                    if busy { "Connecting…" } else { "Connect" },
                    ButtonKind::Primary,
                    busy || count != WORDS || folder.is_none(),
                    cmd("phraseConnect"),
                ),
            ],
            &p,
        ))
        .into_any_element()
}

pub fn remote_profile_row(view: &SettingsWindowView, profile: &RemoteProfile) -> AnyElement {
    let p = view.look.p;
    let mut shown = Profile::new(
        ProfileId::new(profile.sync_id.as_str()),
        &profile.name,
        ProfileColor::from_key(&profile.color).unwrap_or(ProfileColor::Plum),
        Default::default(),
    );
    shown.icon = profile.icon.clone();
    let id = profile.sync_id.clone();
    row(
        &p,
        Some(crate::profiles::profile_badge(
            view.host.as_ref(),
            &shown,
            24.,
        )),
        Some(profile.name.clone()),
        Some(remote_profile_description(profile)),
        vec![
            div()
                .flex()
                .gap(px(space::S))
                .child(button(
                    view,
                    "sync-remote-remove",
                    "Remove…",
                    ButtonKind::Plain,
                    profile.shared_by_others,
                    cmd(&format!("remove:{id}")),
                ))
                .child(button(
                    view,
                    "sync-remote-add",
                    format!("Add to This {COMPUTER}"),
                    ButtonKind::Plain,
                    profile.waiting,
                    cmd(&format!("add:{id}")),
                ))
                .into_any_element(),
        ],
    )
}

fn joined_sheet(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let engine = &view.sync_status.engine;
    let remote = &engine.remote_profiles;
    let error = (engine.state == SyncState::Stalled)
        .then(|| engine.error.clone())
        .flatten();
    let addable = remote.iter().filter(|r| !r.waiting).count();
    let subtitle = joined_message(
        remote.len(),
        view.sync_status.joining,
        engine.pending,
        error.as_deref(),
        COMPUTER,
        true,
    );
    let mut buttons = vec![button(
        view,
        "sync-joined-done",
        "Done",
        if addable > 1 {
            ButtonKind::Plain
        } else {
            ButtonKind::Primary
        },
        false,
        cmd("close"),
    )];
    if addable > 1 {
        buttons.push(button(
            view,
            "sync-joined-add-all",
            "Add All",
            ButtonKind::Primary,
            false,
            cmd("addAll"),
        ));
    }
    Dialog::sheet("sync-joined-sheet", SheetSize::L, &p)
        .on_dismiss(close_handler(view))
        .child(sheet_title(
            format!("This {COMPUTER} Is Syncing"),
            Some(subtitle.into()),
            None,
            &p,
        ))
        .when(!remote.is_empty(), |this| {
            this.child(
                div()
                    .mt(px(space::XL))
                    .child(crate::primitives::list::group(
                        &p,
                        remote
                            .iter()
                            .map(|r| remote_profile_row(view, r))
                            .collect::<Vec<_>>(),
                    )),
            )
        })
        .child(dialog_actions(None, None, buttons, &p))
        .into_any_element()
}

pub const QR_NOTE: &str = "Click Show Code. On your iPhone, open Ardia, tap Sync With Mac, and scan the code. For another Mac, you can also scan it with your iPhone’s camera and paste the words there with Universal Clipboard.";

pub fn connect_subtitle() -> String {
    format!(
        "On your other {SYNCED_COMPUTER}, open Ardia › Settings › General › Sync and choose the same sync folder. Then click Enter Recovery Phrase and enter the 24 words of your recovery phrase."
    )
}

pub fn numbered(index: usize) -> String {
    format!("{:>2} ", index + 1)
}

fn connect_sheet(
    view: &SettingsWindowView,
    qr: Option<Arc<Image>>,
    words: Option<Vec<String>>,
) -> AnyElement {
    let p = view.look.p;
    let frame = SYNC_CODE_SIZE + SYNC_CODE_QUIET * 2.;
    let shown = qr.is_some();
    let code = div()
        .debug_selector(|| "sync-code".into())
        .flex_none()
        .size(px(frame))
        .rounded(px(radius::TILE))
        .border_1()
        .border_color(p.group_border)
        .bg(if shown { gpui::white() } else { p.group_fill })
        .flex()
        .items_center()
        .justify_center()
        .child(match qr {
            Some(image) => gpui::img(image).size(px(SYNC_CODE_SIZE)).into_any_element(),
            None => button(
                view,
                "sync-show-code",
                "Show Code",
                ButtonKind::Plain,
                false,
                cmd("showCode"),
            ),
        });
    let note = div()
        .flex_1()
        .min_w_0()
        .text_size(px(type_size::SMALL))
        .line_height(px(line_height::BODY))
        .text_color(p.text_secondary)
        .child(QR_NOTE);
    let grid = words.as_ref().map(|words| {
        div()
            .debug_selector(|| "sync-words".into())
            .mt(px(space::XL))
            .p(px(space::ML))
            .rounded(px(radius::TILE))
            .bg(p.group_fill)
            .flex()
            .flex_wrap()
            .children(words.iter().enumerate().map(|(i, word)| {
                div()
                    .w(gpui::relative(0.25))
                    .py(px(space::XS))
                    .font_family("Menlo")
                    .text_size(px(type_size::SMALL))
                    .line_height(px(line_height::SMALL))
                    .flex()
                    .child(
                        div()
                            .text_color(p.text_tertiary)
                            .child(SharedString::from(numbered(i))),
                    )
                    .child(
                        div()
                            .text_color(p.text)
                            .child(SharedString::from(word.clone())),
                    )
            }))
    });
    Dialog::sheet("sync-connect-sheet", SheetSize::L, &p)
        .on_dismiss(close_handler(view))
        .child(sheet_title(
            "Connect Another Device",
            Some(connect_subtitle().into()),
            None,
            &p,
        ))
        .child(
            div()
                .mt(px(space::XL))
                .flex()
                .items_center()
                .gap(px(space::XL))
                .child(code)
                .child(note),
        )
        .children(grid)
        .child(dialog_actions(
            Some(
                div()
                    .flex()
                    .gap(px(space::M))
                    .child(button(
                        view,
                        "sync-toggle-words",
                        if words.is_some() {
                            "Hide Words"
                        } else {
                            "Show Words"
                        },
                        ButtonKind::Plain,
                        false,
                        cmd("toggleWords"),
                    ))
                    .child(button(
                        view,
                        "sync-copy-words",
                        "Copy Words",
                        ButtonKind::Plain,
                        false,
                        cmd("copyWords"),
                    ))
                    .into_any_element(),
            ),
            None,
            [button(
                view,
                "sync-connect-done",
                "Done",
                ButtonKind::Primary,
                false,
                cmd("close"),
            )],
            &p,
        ))
        .into_any_element()
}

pub fn stop_subtitle() -> String {
    format!(
        "Syncing will stop on this device. To re-enable sync, you’ll need another device that is currently syncing, or the recovery phrase from your Recovery Kit. Everything on this {COMPUTER} stays as it is."
    )
}

pub fn delete_subtitle() -> String {
    format!(
        "Would you also like to permanently delete your synced data from the sync folder? This will stop syncing on all your other devices too. To sync again, you’ll need to set up each device from scratch. Your data on each {SYNCED_COMPUTER} stays."
    )
}

fn stop_sheet(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    Dialog::sheet("sync-stop-sheet", SheetSize::S, &p)
        .on_dismiss(close_handler(view))
        .child(sheet_title(
            "Stop Syncing This Device?",
            Some(stop_subtitle().into()),
            None,
            &p,
        ))
        .child(dialog_actions(
            Some(button(
                view,
                "sync-stop-kit",
                "Save Recovery Kit",
                ButtonKind::Plain,
                false,
                cmd("stopKit"),
            )),
            None,
            [
                button(
                    view,
                    "sync-stop-cancel",
                    "Cancel",
                    ButtonKind::Plain,
                    false,
                    cmd("close"),
                ),
                button(
                    view,
                    "sync-stop-confirm",
                    "Stop Syncing",
                    ButtonKind::Destructive,
                    false,
                    cmd("stopConfirm"),
                ),
            ],
            &p,
        ))
        .into_any_element()
}

fn delete_sheet(view: &SettingsWindowView, understood: bool, busy: bool) -> AnyElement {
    let p = view.look.p;
    let emit = view.emit.clone();
    Dialog::sheet("sync-delete-sheet", SheetSize::S, &p)
        .on_dismiss(close_handler(view))
        .child(sheet_title(
            "Delete Sync Data?",
            Some(delete_subtitle().into()),
            None,
            &p,
        ))
        .child(
            div()
                .debug_selector(|| "sync-understood".into())
                .mt(px(space::L))
                .child(
                    Checkbox::new(
                        "sync-understood",
                        understood,
                        "I understand this cannot be undone",
                        &p,
                    )
                    .on_toggle(move |_, window, cx| emit.send(command("understood"), window, cx)),
                ),
        )
        .child(dialog_actions(
            None,
            None,
            [
                button(
                    view,
                    "sync-keep-data",
                    "Keep Sync Data",
                    ButtonKind::Plain,
                    busy,
                    cmd("keepData"),
                ),
                button(
                    view,
                    "sync-delete-data",
                    "Delete My Sync Data",
                    ButtonKind::Destructive,
                    !understood || busy,
                    cmd("deleteData"),
                ),
            ],
            &p,
        ))
        .into_any_element()
}

pub fn sheet(view: &SettingsWindowView, cx: &gpui::App) -> Option<AnyElement> {
    Some(match view.sync.sheet.clone()? {
        SyncSheet::RecoveryKit { preview, saved } => recovery_kit_sheet(view, preview, saved),
        SyncSheet::Phrase {
            folder,
            change,
            busy,
            error,
        } => phrase_sheet(view, folder, change, busy, error, cx),
        SyncSheet::Joined => joined_sheet(view),
        SyncSheet::Connect { qr, words } => connect_sheet(view, qr, words),
        SyncSheet::Stop => stop_sheet(view),
        SyncSheet::DeleteData { understood, busy } => delete_sheet(view, understood, busy),
    })
}

pub fn row(
    p: &Palette,
    glyph: Option<AnyElement>,
    title: Option<String>,
    detail: Option<String>,
    buttons: Vec<AnyElement>,
) -> AnyElement {
    div()
        .min_h(px(crate::settings::panes::ROW_MIN_HEIGHT))
        .px(px(crate::settings::panes::ROW_PAD_X))
        .py(px(crate::settings::panes::ROW_PAD_Y))
        .flex()
        .items_center()
        .gap(px(12.))
        .children(glyph)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .when_some(title, |this, title| {
                    this.child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(16.))
                            .child(SharedString::from(title)),
                    )
                })
                .when_some(detail, |this, detail| {
                    this.child(
                        div()
                            .mt(px(2.))
                            .text_size(px(11.))
                            .line_height(px(14.))
                            .text_color(p.text_secondary)
                            .child(SharedString::from(detail)),
                    )
                }),
        )
        .children(buttons)
        .into_any_element()
}

pub fn sync_icon(on: bool, p: &Palette) -> AnyElement {
    div()
        .debug_selector(move || {
            if on {
                "sync-icon-on".into()
            } else {
                "sync-icon-off".into()
            }
        })
        .flex_none()
        .size(px(SYNC_ICON))
        .rounded_full()
        .bg(if on { p.form_accent } else { p.control })
        .when(!on, |this| {
            this.border(px(0.5)).border_color(p.control_border)
        })
        .flex()
        .items_center()
        .justify_center()
        .child(
            icon(Icon::Sync, 13., if on { p.on_accent } else { p.icon })
                .weight(crate::icon_picker::symbols::SymbolWeight::Semibold),
        )
        .into_any_element()
}

pub fn off_detail(status: &SyncStatus, info: Option<&FolderInfo>) -> String {
    if status.engine.state == SyncState::Reset
        && let Some(error) = status.engine.error.as_ref()
    {
        return error.clone();
    }
    if info.is_some_and(|i| i.has_sync_data) {
        return "Synced data found. Enter your recovery phrase to join.".to_owned();
    }
    match info {
        Some(info) => format!("End-to-end encrypted through {}.", label_of(info)),
        None => "End-to-end encrypted through a synced folder you choose.".to_owned(),
    }
}

fn header(
    p: &Palette,
    title: &'static str,
    detail: Option<String>,
    action: Option<AnyElement>,
) -> AnyElement {
    div()
        .mt(px(crate::settings::panes::SECTION_TOP))
        .mb(px(6.))
        .px(px(6.))
        .flex()
        .items_end()
        .child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(16.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(title),
                )
                .when_some(detail, |this, detail| {
                    this.child(
                        div()
                            .mt(px(4.))
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(p.text_secondary)
                            .child(SharedString::from(detail)),
                    )
                }),
        )
        .children(action)
        .into_any_element()
}

fn caption(p: &Palette, text: String, destructive: bool) -> AnyElement {
    div()
        .debug_selector(|| "sync-failure".into())
        .mt(px(space::M))
        .text_size(px(type_size::CAPTION))
        .line_height(px(line_height::CAPTION))
        .text_color(if destructive {
            p.destructive
        } else {
            p.text_secondary
        })
        .child(SharedString::from(text))
        .into_any_element()
}

fn error_row(p: &Palette, error: String) -> AnyElement {
    div()
        .debug_selector(|| "sync-error".into())
        .mt(px(space::M))
        .px(px(space::XXS))
        .flex()
        .gap(px(space::S))
        .child(
            div()
                .flex_none()
                .w(px(14.))
                .h(px(15.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(Icon::ExclamationCircleFill, 11., p.destructive)),
        )
        .child(
            div()
                .flex_1()
                .text_size(px(type_size::CAPTION))
                .line_height(px(line_height::CAPTION))
                .text_color(p.text_secondary)
                .child(SharedString::from(error)),
        )
        .into_any_element()
}

pub fn section(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let status = &view.sync_status;
    let engine = &status.engine;
    let info = info_of(status, &view.sync);
    let now = ardia_state::store::now_ms();
    let since = |at| ago(now, at);
    let mut out = div()
        .debug_selector(|| "sync-section".into())
        .relative()
        .child(header(&p, "Sync", None, None));
    if engine.state == SyncState::Unavailable {
        return out
            .child(crate::primitives::list::group(
                &p,
                vec![row(
                    &p,
                    None,
                    Some("Sync".into()),
                    Some("Sync isn’t available in this build.".into()),
                    Vec::new(),
                )],
            ))
            .into_any_element();
    }
    if !status.enabled {
        let has_data = info.as_ref().is_some_and(|i| i.has_sync_data);
        let no_icloud = no_icloud(info.as_ref());
        let busy = view.sync.turning_on;
        let primary = if has_data {
            button(
                view,
                "sync-phrase",
                "Enter Recovery Phrase…",
                ButtonKind::Primary,
                false,
                cmd("phrase"),
            )
        } else {
            button(
                view,
                "sync-turn-on",
                if busy { "Turning On…" } else { "Turn On" },
                ButtonKind::Primary,
                busy || no_icloud || info.is_none(),
                cmd("turnOn"),
            )
        };
        let mut rows = vec![row(
            &p,
            Some(sync_icon(false, &p)),
            Some("Sync".into()),
            Some(off_detail(status, info.as_ref())),
            vec![
                button(
                    view,
                    "sync-more",
                    "More",
                    ButtonKind::Plain,
                    false,
                    cmd("more"),
                ),
                primary,
            ],
        )];
        if no_icloud {
            rows.push(row(
                &p,
                Some(
                    div()
                        .flex_none()
                        .w(px(28.))
                        .h(px(20.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(symbol_icon(
                            "exclamationmark.icloud",
                            Icon::ExclamationCircleFill,
                            14.,
                            p.warning,
                        ))
                        .into_any_element(),
                ),
                Some(format!("{CLOUD_DRIVE} is off on this {COMPUTER}")),
                Some(format!(
                    "{TURN_ON_CLOUD_DRIVE}, or pick any folder that syncs, like Dropbox."
                )),
                vec![
                    button(
                        view,
                        "sync-open-icloud",
                        "Open iCloud Settings",
                        ButtonKind::Plain,
                        false,
                        cmd("openICloud"),
                    ),
                    button(
                        view,
                        "sync-choose",
                        "Choose…",
                        ButtonKind::Plain,
                        false,
                        cmd("chooseFolder"),
                    ),
                ],
            ));
        }
        out = out.child(crate::primitives::list::group(&p, rows));
        if let Some(failure) = view.sync.failure.clone() {
            out = out.child(caption(&p, failure, true));
        }
        return out.into_any_element();
    }
    let locked = engine.state == SyncState::Locked;
    let synced: Vec<&Arc<Profile>> = status
        .profiles
        .iter()
        .filter(|l| l.enabled)
        .filter_map(|l| view.state.profile(l.profile_id.as_str()))
        .collect();
    let all_tabs = synced.iter().filter(|profile| profile.sync_tabs).count();
    let first = if locked {
        button(
            view,
            "sync-phrase",
            "Enter Recovery Phrase…",
            ButtonKind::Primary,
            false,
            cmd("lockedPhrase"),
        )
    } else {
        button(
            view,
            "sync-connect",
            "Connect Another Device…",
            ButtonKind::Plain,
            false,
            cmd("connect"),
        )
    };
    let mut rows = vec![
        row(
            &p,
            Some(sync_icon(!locked, &p)),
            Some("Sync".into()),
            Some(status_line(
                engine.state,
                status.last_synced_at,
                engine.pending,
                since,
            )),
            vec![
                first,
                button(
                    view,
                    "sync-advanced",
                    "Advanced…",
                    ButtonKind::Plain,
                    false,
                    cmd("advanced"),
                ),
            ],
        ),
        row(
            &p,
            None,
            Some("Sync folder".into()),
            Some(info.as_ref().map_or_else(|| " ".to_owned(), label_of)),
            Vec::new(),
        ),
        crate::settings::panes::what_syncs(view, synced.len(), all_tabs),
        row(
            &p,
            None,
            Some("Devices".into()),
            engine.devices.is_empty().then(|| {
                format!("Just this {COMPUTER} so far. Other devices show here once they sync.")
            }),
            Vec::new(),
        ),
    ];
    for device in &engine.devices {
        let title = if device.current {
            format!("{} (This {COMPUTER})", device.name)
        } else {
            device.name.clone()
        };
        let detail = if device.current {
            status_line(engine.state, status.last_synced_at, 0, since)
        } else {
            device_detail(device, since)
        };
        let remove = (!device.current).then(|| {
            button(
                view,
                "sync-device-remove",
                "Remove…",
                ButtonKind::Plain,
                false,
                cmd(&format!("removeDevice:{}", device.id)),
            )
        });
        rows.push(row(
            &p,
            None,
            Some(title),
            Some(detail),
            remove.into_iter().collect(),
        ));
    }
    out = out.child(crate::primitives::list::group(&p, rows));
    if let Some(error) = engine
        .error
        .clone()
        .filter(|_| engine.state != SyncState::Updated)
    {
        out = out.child(error_row(&p, error));
    }
    let remote = &engine.remote_profiles;
    if status.joining || !remote.is_empty() {
        let detail = if status.joining {
            looking_for_profiles(engine.pending)
        } else {
            format!(
                "Add them to this {COMPUTER}. Choose which profiles sync on each profile's page."
            )
        };
        let add_all = (remote.iter().filter(|r| !r.waiting).count() > 1).then(|| {
            button(
                view,
                "sync-add-all",
                "Add All",
                ButtonKind::Plain,
                false,
                cmd("addAll"),
            )
        });
        out = out.child(header(
            &p,
            "Profiles on your other devices",
            Some(detail),
            add_all,
        ));
        if !remote.is_empty() {
            out = out.child(crate::primitives::list::group(
                &p,
                remote
                    .iter()
                    .map(|r| remote_profile_row(view, r))
                    .collect::<Vec<_>>(),
            ));
        }
    }
    out.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_reads_like_the_old_sheets() {
        assert_eq!(word_counter(3), "3/24 words");
        assert_eq!(word_counter(25), "too many words");
        assert_eq!(numbered(0), " 1 ");
        assert_eq!(numbered(23), "24 ");
        assert_eq!(
            saved_label("/Users/me/Desktop/Ardia Recovery Kit.pdf"),
            "~/Desktop/Ardia Recovery Kit.pdf"
        );
        assert!(stop_subtitle().ends_with("Everything on this Mac stays as it is."));
        assert!(delete_subtitle().ends_with("Your data on each Mac stays."));
        assert!(connect_subtitle().starts_with("On your other Mac, open Ardia › Settings"));
        assert_eq!(
            remove_profile_question("Work").title,
            "Remove “Work” from Sync?"
        );
        let info = FolderInfo {
            path: "/x/Ardia Sync".into(),
            default_path: "/x/Ardia Sync".into(),
            ..FolderInfo::default()
        };
        assert!(no_icloud(Some(&info)));
        let ids: Vec<String> = more_menu_items(true, true)
            .into_iter()
            .map(|i| {
                if i.separator {
                    "-".into()
                } else {
                    format!("{}{}", i.id, if i.enabled { "" } else { "!" })
                }
            })
            .collect();
        assert_eq!(ids, ["folder", "-", "new!", "phrase"]);
        let ids: Vec<String> = advanced_menu_items(true, false)
            .into_iter()
            .map(|i| {
                if i.separator {
                    "-".into()
                } else {
                    format!("{}{}", i.id, if i.enabled { "" } else { "!" })
                }
            })
            .collect();
        assert_eq!(ids, ["kit!", "copy!", "-", "now", "reveal!", "-", "stop"]);
    }

    #[test]
    fn the_off_row_explains_the_folder() {
        let mut status = SyncStatus::default();
        assert_eq!(
            off_detail(&status, None),
            "End-to-end encrypted through a synced folder you choose."
        );
        let mut info = FolderInfo {
            path: "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Ardia Sync".into(),
            ..FolderInfo::default()
        };
        assert_eq!(
            off_detail(&status, Some(&info)),
            "End-to-end encrypted through iCloud Drive › Ardia Sync."
        );
        info.has_sync_data = true;
        assert_eq!(
            off_detail(&status, Some(&info)),
            "Synced data found. Enter your recovery phrase to join."
        );
        status.engine.state = SyncState::Reset;
        status.engine.error = Some(
            "This device is out of sync. Sync may have been reset from another device.".into(),
        );
        assert_eq!(
            off_detail(&status, Some(&info)),
            "This device is out of sync. Sync may have been reset from another device."
        );
    }
}
