use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::history::History;
use ardia_state::{Action, ProfileId, TabId, WindowId};
use ardia_theme::layout::panel;
use gpui::{
    AnyElement, App, AsyncApp, ClickEvent, Context, ElementId, Entity, FocusHandle, FontWeight,
    Hsla, InteractiveElement, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent,
    ParentElement, Pixels, Point, RenderOnce, ScrollHandle, SharedString, Styled, Task, Window,
    anchored, deferred, div, prelude::*,
};

use super::history_model::{
    DAY_HEADER, HistoryItem, HistoryLayout, ROW_HEIGHT, RowMenuItem, RowSelection, all_rows,
    entries_newest_first, history_row_menu, host_label, layout_history, moved_cursor, shown_rows,
    time_label, toggled_cursor, toggled_row, without_rows,
};
use super::links::{OpenAllMode, OpenMode, open_links, open_mode_for, open_url};
use super::shell::{PAGE_WIDTH, empty_state, page_frame_with, page_header};
use crate::host::{ClearBrowsingData, Confirmation, NativeMenuItem, UiHost};
use crate::look::Palette;

use crate::primitives::controls::{
    ButtonKind, Checkbox, IconButton, MenuRow, PopUp, PushButton, popover, separator,
};
use crate::primitives::favicon::{Favicon, favicon_of, render_favicon, resolve_favicon};
use crate::primitives::icons::Icon;
use crate::primitives::list::{Row, group};
use crate::primitives::sheets::{dialog_actions, dialog_title, panel_surface};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput};
use crate::primitives::tokens::{SheetSize, radius, shadow, space, type_size};
use crate::primitives::virtual_list::{self, Align, VirtualItem, virtual_list};
use crate::window::chrome::Chrome;

type OptionToggle = Box<dyn Fn(bool, &mut App)>;

pub const MENU_WIDTH: f32 = 240.0;
pub const SCROLL_SETTLE: Duration = Duration::from_millis(150);
pub const ROW_INSET_X: f32 = 16.0;
pub const ROW_PAD_X: f32 = 12.0;
pub const ROW_GAP: f32 = 12.0;
pub const TIME_WIDTH: f32 = 64.0;
pub const HOST_MAX_WIDTH: f32 = 220.0;
pub const CHECKBOX_SLOT: f32 = 14.0;
pub const MENU_SLOT: f32 = 26.0;
pub const HEADER_INSET: f32 = 32.0;
pub const LIST_END_PAD: f32 = 40.0;
pub const RANGE_MIN_WIDTH: f32 = 150.0;
pub const MANY_PAGES: &str = "That's a lot of pages.";

thread_local! {
    static CLEAR_REQUESTS: RefCell<Vec<WindowId>> = const { RefCell::new(Vec::new()) };
}

pub fn request_clear_data(window: &WindowId) {
    CLEAR_REQUESTS.with(|requests| {
        let mut requests = requests.borrow_mut();
        if !requests.contains(window) {
            requests.push(window.clone());
        }
    });
}

fn take_clear_request(window: &WindowId) -> bool {
    CLEAR_REQUESTS.with(|requests| {
        let mut requests = requests.borrow_mut();
        let before = requests.len();
        requests.retain(|waiting| waiting != window);
        requests.len() != before
    })
}

pub fn row_selected_fill(p: &Palette) -> Hsla {
    p.form_accent.opacity(if p.dark {
        0x59 as f32 / 255.0
    } else {
        0x33 as f32 / 255.0
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClearRange {
    Hour,
    Day,
    Week,
    Month,
    All,
}

impl ClearRange {
    pub const ALL: [ClearRange; 5] = [
        ClearRange::Hour,
        ClearRange::Day,
        ClearRange::Week,
        ClearRange::Month,
        ClearRange::All,
    ];

    pub fn title(self) -> &'static str {
        match self {
            ClearRange::Hour => "Last hour",
            ClearRange::Day => "Last 24 hours",
            ClearRange::Week => "Last 7 days",
            ClearRange::Month => "Last 4 weeks",
            ClearRange::All => "All time",
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            ClearRange::Hour => "hour",
            ClearRange::Day => "day",
            ClearRange::Week => "week",
            ClearRange::Month => "month",
            ClearRange::All => "all",
        }
    }

    pub fn span_ms(self) -> Option<i64> {
        match self {
            ClearRange::Hour => Some(3_600_000),
            ClearRange::Day => Some(86_400_000),
            ClearRange::Week => Some(7 * 86_400_000),
            ClearRange::Month => Some(28 * 86_400_000),
            ClearRange::All => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClearDialog {
    pub range: ClearRange,
    pub history: bool,
    pub site_data: bool,
    pub busy: bool,
    pub error: bool,
    pub range_open: bool,
}

impl Default for ClearDialog {
    fn default() -> Self {
        ClearDialog {
            range: ClearRange::Hour,
            history: true,
            site_data: true,
            busy: false,
            error: false,
            range_open: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RowMenu {
    pub at: Point<Pixels>,
    pub links: Vec<(String, String)>,
    pub alternate: bool,
    pub open_in: bool,
}

pub struct HistoryUi {
    pub search: Entity<TextInput>,
    pub list_focus: FocusHandle,
    pub dialog_focus: FocusHandle,
    pub list_key: SharedString,
    pub scroll: ScrollHandle,
    pub items: Rc<[VirtualItem]>,
    pub signature: Option<(usize, String, usize)>,
    pub layout: Rc<HistoryLayout>,
    pub selection: RowSelection,
    pub url_query: Option<String>,
    pub menu: Option<RowMenu>,
    pub clear: Option<ClearDialog>,
    pub hovered: Option<String>,
    pub resting: Option<String>,
    pub last_scroll: Option<Instant>,
    settle: Option<Task<()>>,
}

impl HistoryUi {
    fn new(p: &Palette, tab: &TabId, cx: &mut Context<Self>) -> Self {
        let style = InputStyle {
            text: p.text,
            placeholder: p.placeholder,
            caret: p.caret,
            selection: p.selection,
            font_size: 13.0,
            weight: FontWeight::NORMAL,
        };
        let search = cx.new(|cx| {
            let mut input = TextInput::new("Search history", cx);
            input.set_style(style, cx);
            input
        });
        cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Changed { .. }) {
                cx.notify();
            }
        })
        .detach();
        let list_key = SharedString::from(format!("history-page:{tab}"));
        virtual_list::forget(&list_key);
        let scroll = virtual_list::scroll_handle(list_key.clone());
        HistoryUi {
            search,
            list_focus: cx.focus_handle(),
            dialog_focus: cx.focus_handle(),
            list_key,
            scroll,
            items: Rc::from([]),
            signature: None,
            layout: Rc::new(HistoryLayout::default()),
            selection: RowSelection::default(),
            url_query: None,
            menu: None,
            clear: None,
            hovered: None,
            resting: None,
            last_scroll: None,
            settle: None,
        }
    }

    fn settle_wait(&self) -> Duration {
        self.last_scroll.map_or(Duration::ZERO, |at| {
            SCROLL_SETTLE.saturating_sub(at.elapsed())
        })
    }

    pub fn hover(&mut self, url: Option<String>, cx: &mut Context<Self>) {
        if self.hovered == url {
            return;
        }
        self.hovered = url.clone();
        self.resting = None;
        self.settle = None;
        cx.notify();
        let Some(url) = url else {
            return;
        };
        if self.settle_wait().is_zero() {
            self.resting = Some(url);
            return;
        }
        self.settle = Some(cx.spawn(async move |this, cx| {
            loop {
                let wait = match this.update(cx, |ui, _| ui.settle_wait()) {
                    Ok(wait) => wait,
                    Err(_) => return,
                };
                if wait.is_zero() {
                    break;
                }
                cx.background_executor().timer(wait).await;
            }
            let _ = this.update(cx, |ui, cx| {
                if ui.hovered.as_ref() == Some(&url) {
                    ui.resting = Some(url);
                    cx.notify();
                }
            });
        }));
    }

    fn urls(&self) -> Vec<String> {
        self.layout.urls()
    }

    fn cursor_key(&self) -> Option<SharedString> {
        let cursor = self.selection.cursor.as_deref()?;
        let at = self.layout.rows.iter().position(|row| row.url == cursor)?;
        Some(row_key(at))
    }

    fn reveal_cursor(&self) {
        if let Some(key) = self.cursor_key() {
            virtual_list::scroll_to(&self.list_key, &key, Align::Nearest);
        }
    }

    fn menu_targets(&self, url: &str, title: &str) -> Vec<(String, String)> {
        if self.selection.selected.len() < 2 || !self.selection.selected.contains(url) {
            return vec![(url.to_owned(), title.to_owned())];
        }
        self.layout
            .rows
            .iter()
            .filter(|row| self.selection.selected.contains(&row.url))
            .map(|row| (row.url.clone(), row.title.clone()))
            .collect()
    }
}

#[derive(Clone)]
struct Ctx {
    tab: TabId,
    window: WindowId,
    profile: ProfileId,
    host: Arc<dyn UiHost>,
    ui: Entity<HistoryUi>,
    p: Palette,
}

impl Ctx {
    fn remove(&self, urls: Vec<String>, cx: &mut App) {
        ardia_telemetry::counts::count("history_removals_by_menu");
        ardia_telemetry::counts::add("history_rows_removed_by_menu", urls.len() as u64);
        self.host.dispatch(Action::RemoveHistoryPages {
            profile: self.profile.clone(),
            urls: urls.clone(),
        });
        self.ui.update(cx, |ui, cx| {
            ui.selection = without_rows(&ui.selection, &urls);
            cx.notify();
        });
    }

    fn remove_after_asking(&self, urls: Vec<String>, cx: &mut App) {
        let answer = self.host.confirm_in_window(
            self.window.clone(),
            Confirmation {
                title: "Remove selected items?".into(),
                message: "Are you sure you want to delete these pages from your history?".into(),
                confirm: "Remove".into(),
                destructive: true,
            },
        );
        let me = self.clone();
        cx.spawn(async move |cx: &mut AsyncApp| {
            if answer.await == Ok(true) {
                cx.update(|cx| me.remove(urls, cx));
            }
        })
        .detach();
    }

    fn delete_selected(&self, by_key: bool, cx: &mut App) {
        let selected: Vec<String> = self
            .ui
            .read(cx)
            .selection
            .selected
            .iter()
            .cloned()
            .collect();
        if selected.is_empty() {
            return;
        }
        let answer = self.host.confirm_in_window(
            self.window.clone(),
            Confirmation {
                title: "Remove selected items?".into(),
                message: "Are you sure you want to delete these pages from your history?".into(),
                confirm: "Remove".into(),
                destructive: true,
            },
        );
        let me = self.clone();
        cx.spawn(async move |cx: &mut AsyncApp| {
            if answer.await == Ok(true) {
                cx.update(|cx| {
                    let (removals, rows) = if by_key {
                        ("history_removals_by_key", "history_rows_removed_by_key")
                    } else {
                        (
                            "history_removals_by_button",
                            "history_rows_removed_by_button",
                        )
                    };
                    ardia_telemetry::counts::count(removals);
                    ardia_telemetry::counts::add(rows, selected.len() as u64);
                    me.host.dispatch(Action::RemoveHistoryPages {
                        profile: me.profile.clone(),
                        urls: selected,
                    });
                    me.ui.update(cx, |ui, cx| {
                        ui.selection.selected.clear();
                        cx.notify();
                    });
                });
            }
        })
        .detach();
    }

    fn toggle(&self, url: &str, shift: bool, cx: &mut App) {
        self.ui.update(cx, |ui, cx| {
            let urls = ui.urls();
            ui.selection = toggled_row(&urls, &ui.selection, url, shift);
            cx.notify();
        });
    }

    fn open(&self, url: &str, mode: OpenMode) {
        open_url(&self.host, &self.window, &self.tab, url, mode);
    }
}

#[derive(IntoElement)]
pub struct HistoryPage {
    tab: TabId,
    window: WindowId,
    profile: ProfileId,
    history: Option<Arc<History>>,
    url_query: String,
    active: bool,
    profile_name: Option<String>,
    host: Arc<dyn UiHost>,
    p: Palette,
}

impl HistoryPage {
    pub fn new(c: &Chrome, tab: &ardia_state::tabs::Tab, url_query: &str) -> Self {
        let original = if tab.profile_id.is_incognito() {
            tab.profile_id.incognito_original()
        } else {
            tab.profile_id.clone()
        };
        let profile_name = (c.state.profile_order.len() > 1)
            .then(|| c.state.profile(original.as_str()).map(|p| p.name.clone()))
            .flatten();
        HistoryPage {
            tab: tab.id.clone(),
            window: tab.window_id.clone(),
            profile: tab.profile_id.clone(),
            history: c.state.history_of(&tab.profile_id).cloned(),
            url_query: url_query.to_owned(),
            active: c.is_active(&tab.id),
            profile_name,
            host: Arc::clone(c.host),
            p: *c.p,
        }
    }
}

fn layout_key(history: Option<&Arc<History>>, query: &str) -> (usize, String, usize) {
    (
        history.map_or(0, |h| Arc::as_ptr(h) as usize),
        query.to_owned(),
        history.map_or(0, |h| h.len()),
    )
}

impl RenderOnce for HistoryPage {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let p = self.p;
        let ui = window.use_keyed_state(
            ElementId::Name(SharedString::from(format!("history-ui:{}", self.tab))),
            cx,
            {
                let tab = self.tab.clone();
                move |_, cx| HistoryUi::new(&p, &tab, cx)
            },
        );
        let url_query = self.url_query.clone();
        let search = ui.read(cx).search.clone();
        if ui.read(cx).url_query.as_ref() != Some(&url_query) {
            search.update(cx, |input, cx| input.set_text(url_query.clone(), false, cx));
            ui.update(cx, |ui, _| ui.url_query = Some(url_query.clone()));
        }
        let query = search.read(cx).text().to_owned();
        let key = layout_key(self.history.as_ref(), &query);
        if ui.read(cx).signature.as_ref() != Some(&key) {
            let entries = entries_newest_first(self.history.as_deref());
            let layout = Rc::new(layout_history(
                &entries,
                &query,
                ardia_state::store::now_ms(),
            ));
            ui.update(cx, |ui, _| {
                let requeried = ui.signature.as_ref().is_some_and(|old| old.1 != key.1);
                if requeried {
                    ui.scroll.set_offset(gpui::point(px(0.), px(0.)));
                }
                ui.items = virtual_items(&layout);
                ui.selection = shown_rows(&layout.urls(), &ui.selection);
                ui.layout = layout;
                ui.signature = Some(key);
            });
        }
        if self.active && take_clear_request(&self.window) {
            let focus = ui.read(cx).dialog_focus.clone();
            ui.update(cx, |ui, _| ui.clear = Some(ClearDialog::default()));
            window.focus(&focus, cx);
        }
        let ctx = Ctx {
            tab: self.tab.clone(),
            window: self.window.clone(),
            profile: self.profile.clone(),
            host: Arc::clone(&self.host),
            ui: ui.clone(),
            p,
        };
        let state = ui.read(cx);
        let selected = state.selection.selected.len();
        let actions = if selected > 0 {
            let clear = ctx.clone();
            let delete = ctx.clone();
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(p.text_secondary)
                        .child(format!("{selected} selected")),
                )
                .child(
                    PushButton::new("history-cancel-selection", "Cancel", &p).on_click(
                        move |_, _, cx| {
                            clear.ui.update(cx, |ui, cx| {
                                ui.selection.selected.clear();
                                cx.notify();
                            })
                        },
                    ),
                )
                .child(
                    div()
                        .debug_selector(|| "history-delete-selection".into())
                        .child(
                            PushButton::new("history-delete-selection", "Delete", &p)
                                .kind(ButtonKind::Primary)
                                .on_click(move |_, _, cx| delete.delete_selected(false, cx)),
                        ),
                )
                .into_any_element()
        } else {
            let open = ctx.clone();
            div()
                .debug_selector(|| "history-clear-data".into())
                .child(
                    PushButton::new("history-clear-data", "Clear Browsing Data…", &p).on_click(
                        move |_, window, cx| {
                            let focus = open.ui.read(cx).dialog_focus.clone();
                            open.ui.update(cx, |ui, cx| {
                                ui.clear = Some(ClearDialog::default());
                                cx.notify();
                            });
                            window.focus(&focus, cx);
                        },
                    ),
                )
                .into_any_element()
        };
        let search_keys = ctx.clone();
        let header_search = div()
            .w_full()
            .capture_key_down(move |event: &KeyDownEvent, window, cx| {
                if event.keystroke.key != "down" {
                    return;
                }
                let focus = search_keys.ui.read(cx).list_focus.clone();
                let has_rows = !search_keys.ui.read(cx).layout.rows.is_empty();
                if !has_rows {
                    return;
                }
                cx.stop_propagation();
                window.focus(&focus, cx);
                search_keys.ui.update(cx, |ui, cx| {
                    let urls = ui.urls();
                    let reset = RowSelection {
                        cursor: None,
                        ..ui.selection.clone()
                    };
                    ui.selection = moved_cursor(&urls, &reset, 1, false);
                    ui.reveal_cursor();
                    cx.notify();
                });
            })
            .child(search.clone());
        let header = page_header(
            "History",
            Some(header_search.into_any_element()),
            Some(actions),
            &p,
        );
        let body = if state.layout.rows.is_empty() {
            empty_state(
                Icon::History,
                if query.is_empty() {
                    "Your browsing history appears here"
                } else {
                    "No search results found"
                },
                &p,
            )
        } else {
            history_list(&ctx, state)
        };
        let menu = state.menu.clone().map(|menu| row_menu(&ctx, menu));
        let dialog = state.clear.clone().map(|dialog| {
            clear_dialog(
                &ctx,
                dialog,
                self.profile_name.as_deref(),
                &state.dialog_focus,
            )
        });
        let overlay = match (menu, dialog) {
            (None, None) => None,
            (menu, dialog) => Some(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .children(menu)
                    .children(dialog)
                    .into_any_element(),
            ),
        };
        page_frame_with("history-page", header, body, overlay)
    }
}

fn row_key(at: usize) -> SharedString {
    SharedString::from(format!("row:{at}"))
}

fn virtual_items(layout: &HistoryLayout) -> Rc<[VirtualItem]> {
    layout
        .items
        .iter()
        .map(|item| match item {
            HistoryItem::Day(day) => {
                VirtualItem::header(SharedString::from(format!("day:{day}")), DAY_HEADER)
            }
            HistoryItem::Row(at) => VirtualItem::new(row_key(*at), ROW_HEIGHT),
        })
        .collect()
}

fn history_list(ctx: &Ctx, state: &HistoryUi) -> AnyElement {
    let layout = Rc::clone(&state.layout);
    let selection = RowView {
        selection: state.selection.clone(),
        hovered: state.hovered.clone(),
        resting: state.resting.clone(),
    };
    let keys = ctx.clone();
    let scrolled = ctx.ui.clone();
    let rows = virtual_list(state.list_key.clone(), &state.scroll)
        .items(state.items.iter().cloned())
        .small_list_rows(0)
        .overscan(ROW_HEIGHT)
        .keep(state.cursor_key())
        .render(|index, _| match layout.items.get(index) {
            Some(HistoryItem::Day(day)) => day_header(&layout.days[*day], &ctx.p),
            Some(HistoryItem::Row(at)) => history_row(ctx, &layout, *at, &selection),
            None => div().into_any_element(),
        });
    div()
        .id("history-list")
        .debug_selector(|| "history-list".into())
        .track_focus(&state.list_focus)
        .size_full()
        .overflow_y_scroll()
        .track_scroll(&state.scroll)
        .on_scroll(move |_, _, cx| {
            scrolled.update(cx, |ui, _| ui.last_scroll = Some(Instant::now()));
        })
        .on_key_down(move |event: &KeyDownEvent, window, cx| list_key(&keys, event, window, cx))
        .child(div().w_full().pb(px(LIST_END_PAD)).child(rows))
        .into_any_element()
}

fn list_key(ctx: &Ctx, event: &KeyDownEvent, _: &mut Window, cx: &mut App) {
    let key = event.keystroke.key.as_str();
    let modifiers = event.keystroke.modifiers;
    match key {
        "down" | "up" => {
            let step = if key == "down" { 1 } else { -1 };
            ctx.ui.update(cx, |ui, cx| {
                let urls = ui.urls();
                ui.selection = moved_cursor(&urls, &ui.selection, step, modifiers.shift);
                ui.reveal_cursor();
                cx.notify();
            });
        }
        "space" => ctx.ui.update(cx, |ui, cx| {
            let urls = ui.urls();
            ui.selection = toggled_cursor(&urls, &ui.selection);
            cx.notify();
        }),
        "a" if modifiers.platform => ctx.ui.update(cx, |ui, cx| {
            let urls = ui.urls();
            ui.selection = all_rows(&urls, &ui.selection);
            cx.notify();
        }),
        "backspace" | "delete" => ctx.delete_selected(true, cx),
        "escape" => {
            if ctx.ui.read(cx).selection.selected.is_empty() {
                return;
            }
            ctx.ui.update(cx, |ui, cx| {
                ui.selection.selected.clear();
                cx.notify();
            });
        }
        _ => return,
    }
    cx.stop_propagation();
}

fn day_header(label: &str, p: &Palette) -> AnyElement {
    div()
        .w_full()
        .flex()
        .justify_center()
        .child(
            div()
                .w(px(PAGE_WIDTH))
                .max_w_full()
                .h(px(DAY_HEADER))
                .px(px(HEADER_INSET))
                .pb(px(8.))
                .flex()
                .flex_col()
                .justify_end()
                .child(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.text_secondary)
                        .child(SharedString::from(label.to_owned())),
                ),
        )
        .into_any_element()
}

pub struct RowView {
    pub selection: RowSelection,
    pub hovered: Option<String>,
    pub resting: Option<String>,
}

fn history_row(ctx: &Ctx, layout: &HistoryLayout, at: usize, view: &RowView) -> AnyElement {
    let p = ctx.p;
    let row = &layout.rows[at];
    let selection = &view.selection;
    let selecting = !selection.selected.is_empty();
    let selected = selection.selected.contains(&row.url);
    let highlighted = selection.cursor.as_deref() == Some(row.url.as_str());
    let hovered = view.hovered.as_deref() == Some(row.url.as_str());
    let show_controls = view.resting.as_deref() == Some(row.url.as_str());
    let hover = ctx.clone();
    let hover_url = row.url.clone();
    let label = host_label(&row.url);
    let shown = match ctx.host.page_favicon(&ctx.profile, &row.url) {
        Some(image) => Favicon::Image(image),
        None => resolve_favicon(
            favicon_of(&row.url, row.favicon.as_deref(), None, &label),
            ctx.host.as_ref(),
            &ctx.profile,
        ),
    };
    let radius = panel::RADIUS;
    let fill = if selected {
        row_selected_fill(&p)
    } else if highlighted || hovered {
        p.row_hover
    } else {
        p.group_box
    };
    let toggle = ctx.clone();
    let toggle_url = row.url.clone();
    let open = ctx.clone();
    let open_url_of = row.url.clone();
    let middle = ctx.clone();
    let middle_url = row.url.clone();
    let menu = ctx.clone();
    let menu_url = row.url.clone();
    let menu_title = row.title.clone();
    let button_menu = ctx.clone();
    let button_url = row.url.clone();
    let button_title = row.title.clone();
    let title = if row.title.is_empty() {
        row.url.clone()
    } else {
        row.title.clone()
    };
    div()
        .w_full()
        .flex()
        .justify_center()
        .child(
            div()
                .id(("history-row-frame", at))
                .w(px(PAGE_WIDTH))
                .max_w_full()
                .h(px(ROW_HEIGHT))
                .px(px(ROW_INSET_X))
                .relative()
                .on_hover(move |entered: &bool, _, cx| {
                    let url = hover_url.clone();
                    let entered = *entered;
                    hover.ui.update(cx, |ui, cx| {
                        if entered {
                            ui.hover(Some(url), cx);
                        } else if ui.hovered.as_ref() == Some(&url) {
                            ui.hover(None, cx);
                        }
                    });
                })
                .child(
                    div()
                        .id(("history-row", at))
                        .size_full()
                        .flex()
                        .items_center()
                        .px(px(ROW_PAD_X))
                        .gap(px(ROW_GAP))
                        .bg(fill)
                        .when(row.first, |this| this.rounded_t(px(radius)))
                        .when(row.last, |this| this.rounded_b(px(radius)))
                        .on_mouse_down(MouseButton::Right, move |event: &MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            open_row_menu(
                                &menu,
                                &menu_url,
                                &menu_title,
                                event.position,
                                event.modifiers.alt,
                                cx,
                            );
                        })
                        .on_mouse_down(MouseButton::Middle, move |_, _, cx| {
                            cx.stop_propagation();
                            middle.open(&middle_url, OpenMode::Background);
                        })
                        .child(
                            div()
                                .debug_selector(move || format!("history-check-{at}"))
                                .flex_none()
                                .w(px(CHECKBOX_SLOT))
                                .when(show_controls || selecting, |this| {
                                    this.child(
                                        Checkbox::new(("history-check", at), selected, "", &p)
                                            .on_toggle(move |_, window, cx| {
                                                let shift = window.modifiers().shift;
                                                toggle.toggle(&toggle_url, shift, cx)
                                            }),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .flex_none()
                                .w(px(TIME_WIDTH))
                                .text_size(px(12.))
                                .text_color(p.text_secondary)
                                .child(time_label(row.last_visit)),
                        )
                        .child(
                            div()
                                .id(("history-link", at))
                                .debug_selector(move || format!("history-link-{at}"))
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(px(10.))
                                .cursor_pointer()
                                .on_click(move |event: &ClickEvent, _, cx| {
                                    let modifiers = event.modifiers();
                                    if !open.ui.read(cx).selection.selected.is_empty() {
                                        open.toggle(&open_url_of, modifiers.shift, cx);
                                        return;
                                    }
                                    let mode = open_mode_for(
                                        modifiers.platform,
                                        modifiers.shift,
                                        modifiers.alt,
                                        false,
                                    );
                                    open.open(&open_url_of, mode);
                                })
                                .child(render_favicon(&shown, 16., &p))
                                .child(
                                    div()
                                        .min_w_0()
                                        .flex_shrink(1.)
                                        .truncate()
                                        .text_size(px(13.))
                                        .text_color(p.text)
                                        .child(SharedString::from(title)),
                                )
                                .child(
                                    div()
                                        .flex_none()
                                        .max_w(px(HOST_MAX_WIDTH))
                                        .truncate()
                                        .text_size(px(12.))
                                        .text_color(p.text_tertiary)
                                        .child(SharedString::from(label)),
                                ),
                        )
                        .child(
                            div()
                                .flex_none()
                                .w(px(MENU_SLOT))
                                .when(show_controls, |this| {
                                    this.debug_selector(move || format!("history-more-{at}"))
                                })
                                .when(show_controls, |this| {
                                    this.child(
                                        IconButton::new(("history-more", at), Icon::Ellipsis, &p)
                                            .square(MENU_SLOT, 6.)
                                            .glyph(13.)
                                            .tooltip("More actions", &p)
                                            .on_click(move |event: &ClickEvent, window, cx| {
                                                let at = event
                                                    .mouse_position()
                                                    .unwrap_or_else(|| window.mouse_position());
                                                open_row_menu(
                                                    &button_menu,
                                                    &button_url,
                                                    &button_title,
                                                    at,
                                                    event.modifiers().alt,
                                                    cx,
                                                );
                                            }),
                                    )
                                }),
                        ),
                )
                .when(!row.last, |this| {
                    this.child(
                        div()
                            .absolute()
                            .left(px(ROW_INSET_X + ROW_PAD_X))
                            .right(px(ROW_INSET_X + ROW_PAD_X))
                            .bottom_0()
                            .h(px(1.))
                            .bg(p.divider),
                    )
                }),
        )
        .into_any_element()
}

fn native_row_menu(count: usize) -> Vec<NativeMenuItem> {
    if count > 1 {
        return vec![
            NativeMenuItem::new("openAll", format!("Open {count} in New Tabs"), "plus.app"),
            NativeMenuItem::new(
                "openAllWindow",
                format!("Open {count} in New Window"),
                "macwindow.badge.plus",
            ),
            NativeMenuItem::new(
                "openAllIncognito",
                format!("Open {count} in Incognito Window"),
                "eyeglasses",
            ),
            NativeMenuItem::separator(),
            NativeMenuItem::new("copy", format!("Copy {count} Links"), "link"),
            NativeMenuItem::new(
                "copyMarkdown",
                format!("Copy {count} Links as Markdown"),
                "link",
            )
            .alternate(),
            NativeMenuItem::separator(),
            NativeMenuItem::new(
                "remove",
                format!("Remove {count} Pages from History…"),
                "trash",
            ),
        ];
    }
    vec![
        NativeMenuItem::new("tab", "Open in New Tab", "plus.app"),
        NativeMenuItem::new("split", "Open in Split View", "rectangle.split.2x1"),
        NativeMenuItem::new("openIn", "Open in", "macwindow").children(vec![
            NativeMenuItem::new("window", "New Window", "macwindow.badge.plus"),
            NativeMenuItem::new("incognito", "Incognito Window", "eyeglasses"),
        ]),
        NativeMenuItem::separator(),
        NativeMenuItem::new("copy", "Copy Link", "link"),
        NativeMenuItem::new("copyMarkdown", "Copy Link as Markdown", "link").alternate(),
        NativeMenuItem::new("more", "More from This Site", "magnifyingglass"),
        NativeMenuItem::separator(),
        NativeMenuItem::new("remove", "Remove from History", "trash"),
    ]
}

pub fn row_menu_choice(id: &str) -> Option<RowMenuItem> {
    Some(match id {
        "tab" => RowMenuItem::OpenInNewTab,
        "split" => RowMenuItem::OpenInSplitView,
        "window" => RowMenuItem::OpenInNewWindow,
        "incognito" => RowMenuItem::OpenInIncognitoWindow,
        "openAll" => RowMenuItem::OpenAllInNewTabs,
        "openAllWindow" => RowMenuItem::OpenAllInNewWindow,
        "openAllIncognito" => RowMenuItem::OpenAllInIncognitoWindow,
        "copy" => RowMenuItem::CopyLink,
        "copyMarkdown" => RowMenuItem::CopyLinkAsMarkdown,
        "more" => RowMenuItem::MoreFromThisSite,
        "remove" => RowMenuItem::Remove,
        _ => return None,
    })
}

fn open_row_menu(
    ctx: &Ctx,
    url: &str,
    title: &str,
    at: Point<Pixels>,
    alternate: bool,
    cx: &mut App,
) {
    let links = ctx.ui.read(cx).menu_targets(url, title);
    let menu = RowMenu {
        at,
        links,
        alternate,
        open_in: false,
    };
    if let Some(answer) = ctx.host.show_menu(native_row_menu(menu.links.len())) {
        let run = ctx.clone();
        cx.spawn(async move |cx: &mut AsyncApp| {
            if let Ok(Some(choice)) = answer.await
                && let Some(item) = row_menu_choice(&choice)
            {
                cx.update(|cx| run_menu_item(&run, &menu, &item, cx));
            }
        })
        .detach();
        return;
    }
    ctx.ui.update(cx, |ui, cx| {
        ui.menu = Some(menu);
        cx.notify();
    });
}

fn close_menu(ctx: &Ctx, cx: &mut App) {
    ctx.ui.update(cx, |ui, cx| {
        ui.menu = None;
        cx.notify();
    });
}

fn copy_links(links: &[(String, String)], markdown: bool) -> String {
    links
        .iter()
        .map(|(url, title)| {
            if markdown {
                format!("[{}]({url})", title.replace(['[', ']'], ""))
            } else {
                url.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn run_menu_item(ctx: &Ctx, menu: &RowMenu, item: &RowMenuItem, cx: &mut App) {
    let urls: Vec<String> = menu.links.iter().map(|(url, _)| url.clone()).collect();
    let first = urls.first().cloned().unwrap_or_default();
    close_menu(ctx, cx);
    match item {
        RowMenuItem::OpenInNewTab => ctx.open(&first, OpenMode::Foreground),
        RowMenuItem::OpenInSplitView => ctx.open(&first, OpenMode::Split),
        RowMenuItem::OpenInNewWindow => ctx.open(&first, OpenMode::Window),
        RowMenuItem::OpenInIncognitoWindow => ctx.open(&first, OpenMode::Incognito),
        RowMenuItem::OpenAllInNewTabs => open_links(
            Arc::clone(&ctx.host),
            ctx.window.clone(),
            urls,
            OpenAllMode::Tabs,
            MANY_PAGES,
            cx,
        ),
        RowMenuItem::OpenAllInNewWindow => open_links(
            Arc::clone(&ctx.host),
            ctx.window.clone(),
            urls,
            OpenAllMode::Window,
            MANY_PAGES,
            cx,
        ),
        RowMenuItem::OpenAllInIncognitoWindow => open_links(
            Arc::clone(&ctx.host),
            ctx.window.clone(),
            urls,
            OpenAllMode::Incognito,
            MANY_PAGES,
            cx,
        ),
        RowMenuItem::CopyLink | RowMenuItem::CopyLinkAsMarkdown => {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(copy_links(
                &menu.links,
                *item == RowMenuItem::CopyLinkAsMarkdown,
            )))
        }
        RowMenuItem::MoreFromThisSite => {
            let host = host_label(&first);
            let search = ctx.ui.read(cx).search.clone();
            search.update(cx, |input, cx| input.set_text(host, false, cx));
        }
        RowMenuItem::Remove if urls.len() > 1 => ctx.remove_after_asking(urls, cx),
        RowMenuItem::Remove => ctx.remove(urls, cx),
    }
}

fn row_menu(ctx: &Ctx, menu: RowMenu) -> AnyElement {
    let p = ctx.p;
    let sections = history_row_menu(menu.links.len(), menu.alternate);
    let single = menu.links.len() == 1;
    let mut rows: Vec<AnyElement> = Vec::new();
    let mut open_in_index = 0;
    for (section_at, section) in sections.iter().enumerate() {
        if section_at > 0 {
            rows.push(separator(&p).into_any_element());
        }
        for (item, title) in section {
            if single
                && matches!(
                    item,
                    RowMenuItem::OpenInNewWindow | RowMenuItem::OpenInIncognitoWindow
                )
            {
                continue;
            }
            let glyph = match item {
                RowMenuItem::OpenInNewTab | RowMenuItem::OpenAllInNewTabs => Icon::Plus,
                RowMenuItem::OpenInSplitView => Icon::Split,
                RowMenuItem::OpenInNewWindow | RowMenuItem::OpenAllInNewWindow => Icon::Plus,
                RowMenuItem::OpenInIncognitoWindow | RowMenuItem::OpenAllInIncognitoWindow => {
                    Icon::Incognito
                }
                RowMenuItem::CopyLink | RowMenuItem::CopyLinkAsMarkdown => Icon::Link,
                RowMenuItem::MoreFromThisSite => Icon::Search,
                RowMenuItem::Remove => Icon::Trash,
            };
            let run = ctx.clone();
            let chosen = item.clone();
            let shown = menu.clone();
            rows.push(
                MenuRow::new(
                    SharedString::from(format!("history-menu-{item:?}")),
                    title.clone(),
                    &p,
                )
                .icon(glyph)
                .on_click(move |_, _, cx| run_menu_item(&run, &shown, &chosen, cx))
                .into_any_element(),
            );
            if single && *item == RowMenuItem::OpenInSplitView {
                open_in_index = rows.len();
                let toggle = ctx.clone();
                rows.push(
                    MenuRow::new("history-menu-open-in", "Open in", &p)
                        .icon(Icon::Split)
                        .trailing("›")
                        .on_click(move |_, _, cx| {
                            toggle.ui.update(cx, |ui, cx| {
                                if let Some(menu) = ui.menu.as_mut() {
                                    menu.open_in = !menu.open_in;
                                }
                                cx.notify();
                            })
                        })
                        .into_any_element(),
                );
            }
        }
    }
    let at = menu.at;
    let submenu = (single && menu.open_in).then(|| {
        let window_run = ctx.clone();
        let window_menu = menu.clone();
        let private_run = ctx.clone();
        let private_menu = menu.clone();
        let offset = panel::LIST_PADDING + panel::ROW_HEIGHT * open_in_index as f32;
        deferred(
            anchored()
                .position(Point {
                    x: at.x + px(MENU_WIDTH - 4.),
                    y: at.y + px(offset),
                })
                .snap_to_window_with_margin(px(8.))
                .child(
                    popover("history-submenu", false, 200., &p)
                        .debug_selector(|| "history-submenu".into())
                        .occlude()
                        .child(
                            MenuRow::new("history-menu-window", "New Window", &p)
                                .icon(Icon::Plus)
                                .on_click(move |_, _, cx| {
                                    run_menu_item(
                                        &window_run,
                                        &window_menu,
                                        &RowMenuItem::OpenInNewWindow,
                                        cx,
                                    )
                                }),
                        )
                        .child(
                            MenuRow::new("history-menu-incognito", "Incognito Window", &p)
                                .icon(Icon::Incognito)
                                .on_click(move |_, _, cx| {
                                    run_menu_item(
                                        &private_run,
                                        &private_menu,
                                        &RowMenuItem::OpenInIncognitoWindow,
                                        cx,
                                    )
                                }),
                        ),
                ),
        )
        .with_priority(3)
    });
    let dismiss = ctx.clone();
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .child(
            div()
                .id("history-menu-dismiss")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .on_mouse_down(MouseButton::Left, move |_, _, cx| close_menu(&dismiss, cx)),
        )
        .child(
            deferred(
                anchored()
                    .position(at)
                    .snap_to_window_with_margin(px(8.))
                    .child(
                        popover("history-menu", false, MENU_WIDTH, &p)
                            .debug_selector(|| "history-menu".into())
                            .occlude()
                            .children(rows),
                    ),
            )
            .with_priority(2),
        )
        .children(submenu)
        .into_any_element()
}

fn clear_dialog(
    ctx: &Ctx,
    dialog: ClearDialog,
    profile_name: Option<&str>,
    focus: &FocusHandle,
) -> AnyElement {
    let p = ctx.p;
    let busy = dialog.busy;
    let can_clear = !busy && (dialog.history || dialog.site_data);
    let leave = ctx.clone();
    let keys = ctx.clone();
    let submit = ctx.clone();
    let cancel = ctx.clone();
    let range_toggle = ctx.clone();
    let history_toggle = ctx.clone();
    let site_toggle = ctx.clone();
    let option = |id: &'static str,
                  checked: bool,
                  title: &'static str,
                  subtitle: &'static str,
                  on: OptionToggle| {
        Row::new(id, &p)
            .icon(
                Checkbox::new(SharedString::from(format!("{id}-box")), checked, "", &p)
                    .disabled(busy)
                    .on_toggle(move |value, _, cx| on(value, cx)),
            )
            .title(title)
            .description(subtitle)
            .into_any_element()
    };
    let range_rows = dialog.range_open.then(|| {
        div().absolute().top(px(28.)).left_0().child(
            popover("clear-range-menu", false, RANGE_MIN_WIDTH + 20., &p)
                .occlude()
                .children(ClearRange::ALL.iter().map(|range| {
                    let pick = ctx.clone();
                    let range = *range;
                    MenuRow::new(
                        SharedString::from(format!("clear-range-{range:?}")),
                        range.title(),
                        &p,
                    )
                    .checked(range == dialog.range)
                    .on_click(move |_, _, cx| {
                        pick.ui.update(cx, |ui, cx| {
                            if let Some(clear) = ui.clear.as_mut() {
                                clear.range = range;
                                clear.range_open = false;
                            }
                            cx.notify();
                        })
                    })
                })),
        )
    });
    let card = panel_surface(&p, radius::SHEET, shadow::DIALOG)
        .id("clear-data-dialog")
        .debug_selector(|| "clear-data-dialog".into())
        .track_focus(focus)
        .occlude()
        .w(px(SheetSize::M.width()))
        .p(px(space::XXL))
        .text_color(p.text)
        .text_size(px(type_size::BODY))
        .flex()
        .flex_col()
        .on_key_down(
            move |event: &KeyDownEvent, _, cx| match event.keystroke.key.as_str() {
                "escape" => {
                    cx.stop_propagation();
                    close_clear(&keys, cx);
                }
                "enter" => {
                    cx.stop_propagation();
                    start_clear(&keys, cx);
                }
                _ => {}
            },
        )
        .child(dialog_title(
            "Clear Browsing Data",
            profile_name.map(|name| SharedString::from(format!("From your {name} profile"))),
            None,
            &p,
        ))
        .child(
            div()
                .mt(px(16.))
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(p.text)
                        .child("Time range"),
                )
                .child(
                    div()
                        .relative()
                        .child(
                            div().debug_selector(|| "clear-range".into()).child(
                                PopUp::new("clear-range", dialog.range.title(), &p)
                                    .min_width(RANGE_MIN_WIDTH)
                                    .disabled(busy)
                                    .on_click(move |_, _, cx| open_range_menu(&range_toggle, cx)),
                            ),
                        )
                        .children(range_rows),
                ),
        )
        .child(
            group(
                &p,
                [
                    option(
                        "clear-history",
                        dialog.history,
                        "Browsing history",
                        "Clears the pages you visited from History and the command bar.",
                        Box::new(move |on, cx| {
                            history_toggle.ui.update(cx, |ui, cx| {
                                if let Some(clear) = ui.clear.as_mut() {
                                    clear.history = on;
                                }
                                cx.notify();
                            })
                        }),
                    ),
                    option(
                        "clear-site-data",
                        dialog.site_data,
                        "Cookies, site data and cached files",
                        "Signs you out of most sites.",
                        Box::new(move |on, cx| {
                            site_toggle.ui.update(cx, |ui, cx| {
                                if let Some(clear) = ui.clear.as_mut() {
                                    clear.site_data = on;
                                }
                                cx.notify();
                            })
                        }),
                    ),
                ],
            )
            .mt(px(space::XL)),
        )
        .when(dialog.error, |this| {
            this.child(
                div()
                    .mt(px(10.))
                    .text_size(px(11.))
                    .text_color(p.destructive)
                    .child("Some browsing data could not be cleared. Please try again."),
            )
        })
        .child(
            dialog_actions(None, None, Vec::<AnyElement>::new(), &p)
                .child(
                    PushButton::new("clear-data-cancel", "Cancel", &p)
                        .on_click(move |_, _, cx| close_clear(&cancel, cx)),
                )
                .child(
                    div().debug_selector(|| "clear-data-confirm".into()).child(
                        PushButton::new(
                            "clear-data-confirm",
                            if dialog.error { "Retry" } else { "Clear Data" },
                            &p,
                        )
                        .kind(ButtonKind::Primary)
                        .disabled(!can_clear)
                        .on_click(move |_, _, cx| start_clear(&submit, cx)),
                    ),
                ),
        );
    div()
        .id("clear-data-scrim")
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .bg(p.scrim)
        .flex()
        .items_center()
        .justify_center()
        .on_mouse_down(MouseButton::Left, move |_, _, cx| close_clear(&leave, cx))
        .child(card)
        .into_any_element()
}

fn open_range_menu(ctx: &Ctx, cx: &mut App) {
    let current = ctx.ui.read(cx).clear.as_ref().map(|clear| clear.range);
    let items: Vec<NativeMenuItem> = ClearRange::ALL
        .iter()
        .map(|range| {
            NativeMenuItem::new(range.key(), range.title(), "").checked(Some(*range) == current)
        })
        .collect();
    if let Some(answer) = ctx.host.show_menu(items) {
        let ui = ctx.ui.clone();
        cx.spawn(async move |cx: &mut AsyncApp| {
            if let Ok(Some(choice)) = answer.await
                && let Some(range) = ClearRange::ALL.iter().find(|range| range.key() == choice)
            {
                let range = *range;
                cx.update(|cx| {
                    ui.update(cx, |ui, cx| {
                        if let Some(clear) = ui.clear.as_mut() {
                            clear.range = range;
                        }
                        cx.notify();
                    })
                });
            }
        })
        .detach();
        return;
    }
    ctx.ui.update(cx, |ui, cx| {
        if let Some(clear) = ui.clear.as_mut() {
            clear.range_open = !clear.range_open;
        }
        cx.notify();
    });
}

fn close_clear(ctx: &Ctx, cx: &mut App) {
    ctx.ui.update(cx, |ui, cx| {
        ui.clear = None;
        cx.notify();
    });
}

fn start_clear(ctx: &Ctx, cx: &mut App) {
    let Some(dialog) = ctx.ui.read(cx).clear.clone() else {
        return;
    };
    if dialog.busy || (!dialog.history && !dialog.site_data) {
        return;
    }
    let started_at = ardia_state::store::now_ms();
    let request = ClearBrowsingData {
        history: dialog.history,
        site_data: dialog.site_data,
        since: dialog.range.span_ms().map(|span| started_at - span),
        started_at,
    };
    ctx.ui.update(cx, |ui, cx| {
        if let Some(clear) = ui.clear.as_mut() {
            clear.busy = true;
            clear.error = false;
            clear.range_open = false;
        }
        cx.notify();
    });
    let answer = ctx.host.clear_browsing_data(ctx.profile.clone(), request);
    let ui = ctx.ui.clone();
    cx.spawn(async move |cx: &mut AsyncApp| {
        let cleared = answer.await == Ok(true);
        cx.update(|cx| {
            ui.update(cx, |ui, cx| {
                if cleared {
                    ui.clear = None;
                } else if let Some(clear) = ui.clear.as_mut() {
                    clear.busy = false;
                    clear.error = true;
                }
                cx.notify();
            })
        });
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_requests_are_taken_once_per_window() {
        let window = WindowId::new("w-clear-test");
        request_clear_data(&window);
        request_clear_data(&window);
        assert!(take_clear_request(&window));
        assert!(!take_clear_request(&window));
    }

    #[test]
    fn ranges_match_the_old_dialog() {
        let titles: Vec<&str> = ClearRange::ALL.iter().map(|r| r.title()).collect();
        assert_eq!(
            titles,
            [
                "Last hour",
                "Last 24 hours",
                "Last 7 days",
                "Last 4 weeks",
                "All time"
            ]
        );
        assert_eq!(ClearRange::Month.span_ms(), Some(28 * 86_400_000));
        assert_eq!(ClearRange::All.span_ms(), None);
    }
}
