use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;

use crate::scale::px;
use ardia_engine::DownloadCommand;
use ardia_state::downloads::{Download, DownloadList, DownloadState};
use ardia_state::windows::WindowKind;
use ardia_state::{Action, BrowserState, ProfileId, TabId, WindowId};
use ardia_theme::layout::panel;
use gpui::{
    AnyElement, App, ClickEvent, ElementId, Entity, FontWeight, IntoElement, MouseButton,
    ObjectFit, ParentElement, Pixels, Point, RenderOnce, SharedString, Styled, Window, anchored,
    deferred, div, img, prelude::*,
};

use super::history_model::{host_label, matches_query};
use super::links::{OpenMode, open_url};
use super::shell::{PAGE_WIDTH, empty_state, page_frame_with, page_header};
use crate::host::{NativeMenuItem, UiHost};
use crate::look::Palette;

use crate::primitives::controls::{
    ButtonKind, IconButton, MenuRow, PushButton, popover, progress_bar, separator,
};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput};
use crate::primitives::virtual_list::{self, VirtualItem, virtual_list};
use crate::window::chrome::Chrome;

pub const CARD_GAP: f32 = 16.0;
pub const CARD_PAD: f32 = 16.0;
pub const CARD_ICON: f32 = 36.0;
pub const CARD_TEXT_GAP: f32 = 4.0;
pub const PROGRESS_HEIGHT: f32 = 3.0;
pub const PROGRESS_TOP: f32 = 3.0;
pub const PROGRESS_MIN: f64 = 0.03;
pub const LIST_GAP: f32 = 8.0;
pub const LIST_END_PAD: f32 = 40.0;
pub const MENU_WIDTH: f32 = 220.0;
pub const FILE_ICON_GLYPH_SHARE: f32 = 0.62;
pub const CARD_HEIGHT: f32 = 86.0;

pub const TRASH: &str = if cfg!(target_os = "windows") {
    "Recycle Bin"
} else {
    "Trash"
};

pub const FILE_MANAGER: &str = if cfg!(target_os = "macos") {
    "Finder"
} else if cfg!(target_os = "windows") {
    "File Explorer"
} else {
    "Files"
};

pub fn awaits_keep(download: &Download) -> bool {
    download.state == DownloadState::Downloading && download.dangerous == Some(true)
}

pub fn format_bytes(bytes: f64) -> String {
    if bytes < 0.0 || !bytes.is_finite() {
        return String::new();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let (mut value, mut unit) = (bytes, 0);
    while value >= 1000.0 && unit < units.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if value < 10.0 && unit > 0 {
        format!("{value:.1} {}", units[unit])
    } else {
        format!("{} {}", value.round(), units[unit])
    }
}

fn format_duration(seconds: f64) -> String {
    if seconds < 60.0 {
        format!("{} sec left", seconds.round().max(1.0))
    } else if seconds < 3600.0 {
        format!("{} min left", (seconds / 60.0).round())
    } else {
        format!("{} hr left", (seconds / 3600.0).round())
    }
}

pub fn danger_warning(download: &Download) -> &'static str {
    if download.url.starts_with("http:") {
        "Insecure download blocked"
    } else {
        "This type of file can harm your computer"
    }
}

pub fn download_status(download: &Download, exists: bool) -> String {
    match download.state {
        DownloadState::Finished if exists => format_bytes(if download.total > 0.0 {
            download.total
        } else {
            download.received
        }),
        DownloadState::Finished => "Deleted".into(),
        DownloadState::Failed => "Failed to Download".into(),
        DownloadState::Cancelled => "Cancelled".into(),
        DownloadState::Downloading if awaits_keep(download) => danger_warning(download).into(),
        DownloadState::Downloading => {
            let progress = if download.total > 0.0 {
                format!(
                    "{} of {}",
                    format_bytes(download.received),
                    format_bytes(download.total)
                )
            } else {
                format_bytes(download.received)
            };
            if download.paused {
                return format!("{progress} — Paused");
            }
            if download.speed <= 0.0 {
                return progress;
            }
            let with_speed = format!("{progress}, {}/s", format_bytes(download.speed));
            if download.total > 0.0 {
                format!(
                    "{with_speed} — {}",
                    format_duration((download.total - download.received) / download.speed)
                )
            } else {
                with_speed
            }
        }
    }
}

fn private_session(state: &BrowserState, profile: &ProfileId) -> Option<String> {
    profile
        .is_incognito()
        .then(|| state.engine_profile(&profile.incognito_original()))
}

fn download_session(state: &BrowserState, download: &Download) -> Option<String> {
    if download.is_private() {
        return Some(download.profile.clone().unwrap_or_default());
    }
    let profile = download.profile.as_deref()?;
    let profile = ProfileId::new(profile);
    if profile.is_incognito() {
        private_session(state, &profile)
    } else {
        None
    }
}

pub fn download_visible_in(state: &BrowserState, download: &Download, window: &WindowId) -> bool {
    let Some(shown) = state.window(window.as_str()) else {
        return false;
    };
    let session = download_session(state, download);
    if shown.kind == WindowKind::Incognito {
        return session.is_some() && session == private_session(state, &shown.profile_id);
    }
    session.is_none()
        && download.profile.as_deref().unwrap_or("") == state.engine_profile(&shown.profile_id)
}

#[derive(Clone, PartialEq)]
struct WindowScope {
    incognito: bool,
    private: Option<String>,
    engine: String,
}

fn window_scope(state: &BrowserState, window: &WindowId) -> Option<WindowScope> {
    let shown = state.window(window.as_str())?;
    Some(WindowScope {
        incognito: shown.kind == WindowKind::Incognito,
        private: private_session(state, &shown.profile_id),
        engine: state.engine_profile(&shown.profile_id),
    })
}

#[derive(Clone)]
pub struct ShownDownloads {
    pub items: Rc<[Download]>,
    pub keys: Rc<[SharedString]>,
}

struct ShownMemo {
    list: Arc<DownloadList>,
    scope: Option<WindowScope>,
    shown: ShownDownloads,
}

thread_local! {
    static SHOWN: RefCell<HashMap<WindowId, ShownMemo>> = RefCell::new(HashMap::new());
    static EXISTS: RefCell<HashMap<String, bool>> = RefCell::new(HashMap::new());
}

pub fn shown_downloads(state: &BrowserState, window: &WindowId) -> ShownDownloads {
    let scope = window_scope(state, window);
    SHOWN.with(|cell| {
        let mut memos = cell.borrow_mut();
        if let Some(memo) = memos.get(window)
            && Arc::ptr_eq(&memo.list, &state.downloads)
            && memo.scope == scope
        {
            return memo.shown.clone();
        }
        let items: Rc<[Download]> = if scope.is_some() {
            state
                .downloads
                .items()
                .iter()
                .rev()
                .filter(|download| download_visible_in(state, download, window))
                .cloned()
                .collect()
        } else {
            Rc::from([])
        };
        let keys = items
            .iter()
            .map(|download| SharedString::from(download.id.to_string()))
            .collect();
        let shown = ShownDownloads { items, keys };
        if memos
            .get(window)
            .is_none_or(|memo| !Arc::ptr_eq(&memo.list, &state.downloads))
        {
            recheck_files();
        }
        memos.retain(|id, _| state.window(id.as_str()).is_some());
        memos.insert(
            window.clone(),
            ShownMemo {
                list: Arc::clone(&state.downloads),
                scope,
                shown: shown.clone(),
            },
        );
        shown
    })
}

pub fn downloads_in(state: &BrowserState, window: &WindowId) -> Rc<[Download]> {
    shown_downloads(state, window).items
}

pub fn recheck_files() {
    EXISTS.with(|cell| cell.borrow_mut().clear());
}

pub fn file_exists(download: &Download) -> bool {
    if download.state != DownloadState::Finished {
        return true;
    }
    if download.path.is_empty() {
        return false;
    }
    EXISTS.with(|cell| {
        if let Some(found) = cell.borrow().get(&download.path) {
            return *found;
        }
        let exists = Path::new(&download.path).exists();
        cell.borrow_mut().insert(download.path.clone(), exists);
        exists
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DownloadMenuItem {
    WhenDone,
    Keep,
    Discard,
    Pause,
    Resume,
    Cancel,
    Open,
    Reveal,
    CopyLink,
    Remove,
    Trash,
}

pub fn download_menu_choice(id: &str) -> Option<DownloadMenuItem> {
    Some(match id {
        "whenDone" => DownloadMenuItem::WhenDone,
        "keep" => DownloadMenuItem::Keep,
        "discard" => DownloadMenuItem::Discard,
        "pause" => DownloadMenuItem::Pause,
        "resume" => DownloadMenuItem::Resume,
        "cancel" => DownloadMenuItem::Cancel,
        "open" => DownloadMenuItem::Open,
        "reveal" => DownloadMenuItem::Reveal,
        "copy" => DownloadMenuItem::CopyLink,
        "remove" => DownloadMenuItem::Remove,
        "trash" => DownloadMenuItem::Trash,
        _ => return None,
    })
}

pub fn download_menu(
    download: &Download,
    exists: bool,
    opens_when_done: bool,
) -> Vec<NativeMenuItem> {
    let downloading = download.state == DownloadState::Downloading;
    let file_exists = download.state == DownloadState::Finished && exists;
    let mut items = if awaits_keep(download) {
        vec![
            NativeMenuItem::new("keep", "Keep", "checkmark.circle"),
            NativeMenuItem::new("discard", "Discard", "xmark.circle"),
        ]
    } else if downloading {
        vec![
            NativeMenuItem::new("whenDone", "Open When Done", "").checked(opens_when_done),
            if download.paused {
                NativeMenuItem::new("resume", "Resume", "play")
            } else {
                NativeMenuItem::new("pause", "Pause", "pause")
            },
            NativeMenuItem::new("cancel", "Cancel", "xmark.circle"),
        ]
    } else {
        vec![
            NativeMenuItem::new("open", "Open", "arrow.up.forward.app").enabled(file_exists),
            NativeMenuItem::new("reveal", format!("Show in {FILE_MANAGER}"), "folder")
                .enabled(file_exists),
        ]
    };
    items.push(NativeMenuItem::separator());
    items.push(NativeMenuItem::new("copy", "Copy Link", "link"));
    items.push(NativeMenuItem::separator());
    items.push(
        NativeMenuItem::new("remove", "Remove from List", "minus.circle").enabled(!downloading),
    );
    if file_exists {
        items.push(NativeMenuItem::new(
            "trash",
            format!("Move to {TRASH}"),
            "trash",
        ));
    }
    items
}

pub struct DownloadsUi {
    pub search: Entity<TextInput>,
    pub menu: Option<(String, Point<Pixels>)>,
    filtered: Option<Filtered>,
}

struct Filtered {
    source: Rc<[Download]>,
    query: String,
    indices: Rc<[usize]>,
    items: Rc<[VirtualItem]>,
    clearable: bool,
}

impl DownloadsUi {
    fn filtered(&mut self, shown: &ShownDownloads, query: &str) -> &Filtered {
        let stale = self
            .filtered
            .as_ref()
            .is_none_or(|f| !Rc::ptr_eq(&f.source, &shown.items) || f.query != query);
        if stale {
            let indices: Rc<[usize]> = shown
                .items
                .iter()
                .enumerate()
                .filter(|(_, download)| matches_query(query, &[&download.filename, &download.url]))
                .map(|(ix, _)| ix)
                .collect();
            let items = indices
                .iter()
                .map(|&ix| {
                    let height = if shown.items[ix].state == DownloadState::Downloading {
                        CARD_HEIGHT + PROGRESS_TOP + PROGRESS_HEIGHT + CARD_TEXT_GAP
                    } else {
                        CARD_HEIGHT
                    };
                    VirtualItem::new(shown.keys[ix].clone(), height)
                })
                .collect();
            self.filtered = Some(Filtered {
                source: Rc::clone(&shown.items),
                query: query.to_owned(),
                indices,
                items,
                clearable: shown
                    .items
                    .iter()
                    .any(|download| download.state != DownloadState::Downloading),
            });
        }
        self.filtered.as_ref().expect("filtered downloads")
    }
}

fn list_key(tab: &TabId) -> SharedString {
    SharedString::from(format!("downloads-page:{tab}"))
}

#[derive(Clone)]
struct Ctx {
    tab: TabId,
    window: WindowId,
    host: Arc<dyn UiHost>,
    ui: Entity<DownloadsUi>,
    p: Palette,
}

impl Ctx {
    fn command(&self, id: &str, command: DownloadCommand) {
        self.host.download_command(id.to_owned(), command);
    }

    fn remove(&self, id: &str) {
        self.host
            .dispatch(Action::RemoveDownload { id: id.to_owned() });
    }

    fn close_menu(&self, cx: &mut App) {
        self.ui.update(cx, |ui, cx| {
            ui.menu = None;
            cx.notify();
        });
    }

    fn run(&self, download: &Download, item: DownloadMenuItem, cx: &mut App) {
        self.close_menu(cx);
        let id = download.id.as_str();
        match item {
            DownloadMenuItem::WhenDone => self.host.toggle_open_when_done(id.to_owned()),
            DownloadMenuItem::Trash => {
                let answer = self.host.move_to_trash(download.path.clone());
                let host = Arc::clone(&self.host);
                let id = id.to_owned();
                cx.spawn(async move |_: &mut gpui::AsyncApp| {
                    if answer.await == Ok(true) {
                        host.dispatch(Action::RemoveDownload { id });
                    }
                })
                .detach();
            }
            DownloadMenuItem::Keep => self.command(id, DownloadCommand::Keep),
            DownloadMenuItem::Discard | DownloadMenuItem::Cancel => {
                self.command(id, DownloadCommand::Cancel)
            }
            DownloadMenuItem::Pause => self.command(id, DownloadCommand::Pause),
            DownloadMenuItem::Resume => self.command(id, DownloadCommand::Resume),
            DownloadMenuItem::Open => self.host.open_path(download.path.clone()),
            DownloadMenuItem::Reveal => self.host.reveal_path(download.path.clone()),
            DownloadMenuItem::CopyLink => {
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(download.url.clone()))
            }
            DownloadMenuItem::Remove => self.remove(id),
        }
    }
}

#[derive(IntoElement)]
pub struct DownloadsPage {
    tab: TabId,
    window: WindowId,
    downloads: ShownDownloads,
    host: Arc<dyn UiHost>,
    p: Palette,
}

impl DownloadsPage {
    pub fn new(c: &Chrome, tab: &ardia_state::tabs::Tab) -> Self {
        DownloadsPage {
            tab: tab.id.clone(),
            window: tab.window_id.clone(),
            downloads: shown_downloads(c.state, &tab.window_id),
            host: Arc::clone(c.host),
            p: *c.p,
        }
    }
}

impl RenderOnce for DownloadsPage {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let p = self.p;
        let key = list_key(&self.tab);
        let forget_key = key.clone();
        let ui = window.use_keyed_state(
            ElementId::Name(SharedString::from(format!("downloads-ui:{}", self.tab))),
            cx,
            move |_, cx| {
                virtual_list::forget(&forget_key);
                recheck_files();
                let style = InputStyle {
                    text: p.text,
                    placeholder: p.placeholder,
                    caret: p.caret,
                    selection: p.selection,
                    font_size: 13.0,
                    weight: FontWeight::NORMAL,
                };
                let search = cx.new(|cx| {
                    let mut input = TextInput::new("Search downloads", cx);
                    input.set_style(style, cx);
                    input
                });
                cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
                    if matches!(event, InputEvent::Changed { .. }) {
                        cx.notify();
                    }
                })
                .detach();
                DownloadsUi {
                    search,
                    menu: None,
                    filtered: None,
                }
            },
        );
        let ctx = Ctx {
            tab: self.tab.clone(),
            window: self.window.clone(),
            host: Arc::clone(&self.host),
            ui: ui.clone(),
            p,
        };
        let search = ui.read(cx).search.clone();
        let query = search.read(cx).text().to_owned();
        let (indices, items, clearable) = ui.update(cx, |ui, _| {
            let filtered = ui.filtered(&self.downloads, &query);
            (
                Rc::clone(&filtered.indices),
                Rc::clone(&filtered.items),
                filtered.clearable,
            )
        });
        let clear_all = clearable.then(|| {
            let clear = ctx.clone();
            let all = Rc::clone(&self.downloads.items);
            div()
                .debug_selector(|| "downloads-clear-all".into())
                .child(
                    PushButton::new("downloads-clear-all", "Clear All", &p).on_click(
                        move |_, _, _| {
                            for download in all.iter().filter(|download| !download.is_active()) {
                                clear.remove(download.id.as_str());
                            }
                        },
                    ),
                )
                .into_any_element()
        });
        let header = page_header("Downloads", Some(search.into_any_element()), clear_all, &p);
        let body = if indices.is_empty() {
            empty_state(
                Icon::ArrowDownCircle,
                if query.is_empty() {
                    "Files you download appear here"
                } else {
                    "No search results found"
                },
                &p,
            )
        } else {
            let handle = virtual_list::scroll_handle(key.clone());
            let all = Rc::clone(&self.downloads.items);
            let rows = virtual_list(key, &handle)
                .items(items.iter().cloned())
                .gap(LIST_GAP)
                .render(|ix, _| download_card(&ctx, &all[indices[ix]]));
            div()
                .id("downloads-list")
                .debug_selector(|| "downloads-list".into())
                .size_full()
                .overflow_y_scroll()
                .track_scroll(&handle)
                .child(
                    div()
                        .w_full()
                        .pt(px(8.))
                        .pb(px(LIST_END_PAD))
                        .flex()
                        .flex_col()
                        .items_center()
                        .child(div().w(px(PAGE_WIDTH - 32.)).max_w_full().child(rows)),
                )
                .into_any_element()
        };
        let menu = ui.read(cx).menu.clone().and_then(|(id, at)| {
            let download = self
                .downloads
                .items
                .iter()
                .find(|download| download.id.as_str() == id)?;
            Some(download_menu_popover(&ctx, download, at))
        });
        page_frame_with("downloads-page", header, body, menu)
    }
}

fn download_card(ctx: &Ctx, download: &Download) -> AnyElement {
    let p = ctx.p;
    let exists = file_exists(download);
    let done = download.state == DownloadState::Finished && exists;
    let blocked = awaits_keep(download);
    let downloading = download.state == DownloadState::Downloading;
    let progress = download.progress().unwrap_or(0.0).max(PROGRESS_MIN);
    let id = download.id.to_string();
    let path = download.path.clone();
    let name = if download.filename.is_empty() {
        "Preparing…".to_owned()
    } else {
        download.filename.clone()
    };
    let opened = ctx.clone();
    let opener_ctx = ctx.clone();
    let source = download.url.clone();
    let file_icon = ctx.host.file_icon(
        if download.path.is_empty() {
            if download.filename.is_empty() {
                "file.bin"
            } else {
                &download.filename
            }
        } else {
            &download.path
        },
        CARD_ICON,
    );
    let menu_download = download.clone();
    let menu = ctx.clone();
    let menu_id = id.clone();
    let mut buttons: Vec<AnyElement> = Vec::new();
    if blocked {
        let keep = ctx.clone();
        let keep_id = id.clone();
        let discard = ctx.clone();
        let discard_id = id.clone();
        buttons.push(
            PushButton::new(
                SharedString::from(format!("download-keep:{id}")),
                "Keep",
                &p,
            )
            .on_click(move |_, _, _| keep.command(&keep_id, DownloadCommand::Keep))
            .into_any_element(),
        );
        buttons.push(
            PushButton::new(
                SharedString::from(format!("download-discard:{id}")),
                "Discard",
                &p,
            )
            .kind(ButtonKind::Destructive)
            .on_click(move |_, _, _| discard.command(&discard_id, DownloadCommand::Cancel))
            .into_any_element(),
        );
    } else if downloading {
        let toggle = ctx.clone();
        let toggle_id = id.clone();
        let paused = download.paused;
        let cancel = ctx.clone();
        let cancel_id = id.clone();
        buttons.push(
            PushButton::new(
                SharedString::from(format!("download-toggle:{id}")),
                if paused { "Resume" } else { "Pause" },
                &p,
            )
            .on_click(move |_, _, _| {
                toggle.command(
                    &toggle_id,
                    if paused {
                        DownloadCommand::Resume
                    } else {
                        DownloadCommand::Pause
                    },
                )
            })
            .into_any_element(),
        );
        buttons.push(
            PushButton::new(
                SharedString::from(format!("download-cancel:{id}")),
                "Cancel",
                &p,
            )
            .on_click(move |_, _, _| cancel.command(&cancel_id, DownloadCommand::Cancel))
            .into_any_element(),
        );
    } else if done {
        let reveal = ctx.clone();
        let reveal_path = path.clone();
        buttons.push(
            PushButton::new(
                SharedString::from(format!("download-reveal:{id}")),
                format!("Show in {FILE_MANAGER}"),
                &p,
            )
            .on_click(move |_, _, _| reveal.host.reveal_path(reveal_path.clone()))
            .into_any_element(),
        );
    }
    let remove = (!downloading).then(|| {
        let remove = ctx.clone();
        let remove_id = id.clone();
        IconButton::new(
            SharedString::from(format!("download-remove:{id}")),
            Icon::XMark,
            &p,
        )
        .square(26., 6.)
        .glyph(11.)
        .tooltip("Remove from List", &p)
        .on_click(move |_, _, _| remove.remove(&remove_id))
    });
    div()
        .id(SharedString::from(format!("download-card:{id}")))
        .debug_selector(|| "download-card".into())
        .w_full()
        .flex_none()
        .flex()
        .items_center()
        .gap(px(CARD_GAP))
        .p(px(CARD_PAD))
        .rounded(px(panel::RADIUS))
        .bg(p.group_box)
        .border(px(0.5))
        .border_color(p.group_stroke)
        .hover(move |style| style.bg(p.row_hover))
        .child(
            div()
                .flex_none()
                .size(px(CARD_ICON))
                .flex()
                .items_center()
                .justify_center()
                .when(!exists, |this| this.opacity(0.4))
                .child(match file_icon {
                    Some(image) => img(image)
                        .size(px(CARD_ICON))
                        .object_fit(ObjectFit::Contain)
                        .into_any_element(),
                    None => icon(Icon::Download, CARD_ICON * FILE_ICON_GLYPH_SHARE, p.icon)
                        .into_any_element(),
                }),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(CARD_TEXT_GAP))
                .child(
                    div()
                        .id(SharedString::from(format!("download-name:{id}")))
                        .truncate()
                        .text_size(px(13.))
                        .line_height(px(16.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(if exists { p.text } else { p.text_secondary })
                        .when(!exists, |this| this.line_through())
                        .when(done, |this| {
                            let path = path.clone();
                            let opener = opener_ctx.clone();
                            this.cursor_pointer()
                                .on_click(move |_, _, _| opener.host.open_path(path.clone()))
                        })
                        .child(SharedString::from(name)),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("download-source:{id}")))
                        .truncate()
                        .cursor_pointer()
                        .text_size(px(12.))
                        .line_height(px(15.))
                        .text_color(p.text_tertiary)
                        .on_click(move |_, _, _| {
                            open_url(
                                &opened.host,
                                &opened.window,
                                &opened.tab,
                                &source,
                                OpenMode::Foreground,
                            )
                        })
                        .child(SharedString::from(host_label(&download.url))),
                )
                .when(downloading && !blocked, |this| {
                    this.child(div().mt(px(PROGRESS_TOP)).h(px(PROGRESS_HEIGHT)).child(
                        progress_bar(
                            progress as f32,
                            p.progress_track.opacity(0.4),
                            if download.paused {
                                p.text_tertiary
                            } else {
                                p.accent
                            },
                        ),
                    ))
                })
                .child(
                    div()
                        .truncate()
                        .text_size(px(12.))
                        .line_height(px(15.))
                        .text_color(if blocked {
                            p.destructive
                        } else {
                            p.text_secondary
                        })
                        .child(download_status(download, exists)),
                ),
        )
        .children(buttons)
        .child(
            div()
                .debug_selector({
                    let id = id.clone();
                    move || format!("download-more-{id}")
                })
                .child(
                    IconButton::new(
                        SharedString::from(format!("download-more:{id}")),
                        Icon::Ellipsis,
                        &p,
                    )
                    .square(26., 6.)
                    .glyph(13.)
                    .tooltip("More actions", &p)
                    .on_click(move |event: &ClickEvent, window, cx| {
                        let at = event
                            .mouse_position()
                            .unwrap_or_else(|| window.mouse_position());
                        let id = menu_id.clone();
                        open_download_menu(&menu, &menu_download, at, cx);
                        let _ = id;
                    }),
                ),
        )
        .children(remove)
        .into_any_element()
}

fn open_download_menu(ctx: &Ctx, download: &Download, at: Point<Pixels>, cx: &mut App) {
    let items = download_menu(
        download,
        file_exists(download),
        ctx.host.opens_when_done(download.id.as_str()),
    );
    if let Some(answer) = ctx.host.show_menu(items) {
        let run = ctx.clone();
        let chosen = download.clone();
        cx.spawn(async move |cx: &mut gpui::AsyncApp| {
            if let Ok(Some(choice)) = answer.await
                && let Some(item) = download_menu_choice(&choice)
            {
                cx.update(|cx| run.run(&chosen, item, cx));
            }
        })
        .detach();
        return;
    }
    let id = download.id.to_string();
    ctx.ui.update(cx, |ui, cx| {
        ui.menu = Some((id, at));
        cx.notify();
    });
}

fn download_menu_popover(ctx: &Ctx, download: &Download, at: Point<Pixels>) -> AnyElement {
    let p = ctx.p;
    let exists = file_exists(download);
    let mut rows: Vec<AnyElement> = Vec::new();
    let items = download_menu(
        download,
        exists,
        ctx.host.opens_when_done(download.id.as_str()),
    );
    for entry in items {
        if entry.separator {
            rows.push(separator(&p).into_any_element());
            continue;
        }
        let Some(item) = download_menu_choice(&entry.id) else {
            continue;
        };
        let run = ctx.clone();
        let shown = download.clone();
        let glyph = match item {
            DownloadMenuItem::WhenDone => None,
            DownloadMenuItem::Keep => Some(Icon::Check),
            DownloadMenuItem::Discard | DownloadMenuItem::Cancel => Some(Icon::XMark),
            DownloadMenuItem::Pause => Some(Icon::Pause),
            DownloadMenuItem::Resume => Some(Icon::Play),
            DownloadMenuItem::Open => Some(Icon::ArrowUp),
            DownloadMenuItem::Reveal => Some(Icon::Folder),
            DownloadMenuItem::CopyLink => Some(Icon::Link),
            DownloadMenuItem::Remove => Some(Icon::Minus),
            DownloadMenuItem::Trash => Some(Icon::Trash),
        };
        let mut row = MenuRow::new(
            SharedString::from(format!("download-menu-{item:?}")),
            entry.title.clone(),
            &p,
        )
        .checked(entry.checked)
        .disabled(!entry.enabled)
        .on_click(move |_, _, cx| run.run(&shown, item, cx));
        if let Some(glyph) = glyph {
            row = row.icon(glyph);
        }
        rows.push(row.into_any_element());
    }
    let dismiss = ctx.clone();
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .child(
            div()
                .id("download-menu-dismiss")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .on_mouse_down(MouseButton::Left, move |_, _, cx| dismiss.close_menu(cx)),
        )
        .child(
            deferred(
                anchored()
                    .position(at)
                    .snap_to_window_with_margin(px(8.))
                    .child(
                        popover("download-menu", false, MENU_WIDTH, &p)
                            .debug_selector(|| "download-menu".into())
                            .occlude()
                            .children(rows),
                    ),
            )
            .with_priority(2),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::DownloadId;

    fn download(state: DownloadState) -> Download {
        Download {
            id: DownloadId::new("d"),
            url: "https://files.example/a.zip".into(),
            filename: "a.zip".into(),
            path: "/nowhere/a.zip".into(),
            state,
            paused: false,
            dangerous: None,
            received: 2_500_000.0,
            total: 10_000_000.0,
            speed: 1_000_000.0,
            mime_type: String::new(),
            profile: None,
            off_the_record: None,
            staging: None,
            start_time: None,
            extra: Default::default(),
        }
    }

    #[test]
    fn statuses_read_like_the_old_app() {
        let mut active = download(DownloadState::Downloading);
        assert_eq!(
            download_status(&active, true),
            "2.5 MB of 10 MB, 1.0 MB/s — 8 sec left"
        );
        active.paused = true;
        assert_eq!(download_status(&active, true), "2.5 MB of 10 MB — Paused");
        active.dangerous = Some(true);
        assert_eq!(
            download_status(&active, true),
            "This type of file can harm your computer"
        );
        let done = download(DownloadState::Finished);
        assert_eq!(download_status(&done, true), "10 MB");
        assert_eq!(download_status(&done, false), "Deleted");
        assert_eq!(
            download_status(&download(DownloadState::Failed), true),
            "Failed to Download"
        );
        assert_eq!(format_bytes(512.0), "512 B");
        assert_eq!(format_bytes(12_345.0), "12 KB");
    }

    #[test]
    fn menus_follow_the_download_state() {
        let active = download(DownloadState::Downloading);
        let menu = download_menu(&active, true, true);
        assert_eq!(menu[0].title, "Open When Done");
        assert!(menu[0].checked);
        assert_eq!(menu[1].id, "pause");
        let remove = menu.iter().find(|item| item.id == "remove").unwrap();
        assert!(!remove.enabled, "an active download can't be removed");
        assert!(menu.iter().all(|item| item.id != "trash"));
        let done = download(DownloadState::Finished);
        let menu = download_menu(&done, false, false);
        assert_eq!(
            download_menu_choice(&menu[0].id),
            Some(DownloadMenuItem::Open)
        );
        assert!(!menu[0].enabled, "a deleted file can't be opened");
        assert!(
            menu.iter().all(|item| item.id != "trash"),
            "a deleted file can't be trashed"
        );
        let kept = download_menu(&done, true, false);
        assert_eq!(kept.last().unwrap().title, "Move to Trash");
    }
}
