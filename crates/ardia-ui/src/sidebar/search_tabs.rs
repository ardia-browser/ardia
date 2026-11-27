use std::cell::RefCell;
use std::collections::HashMap;

use crate::scale::px;
use ardia_state::group_panel::fuzzy_score;
use ardia_state::groups::GroupColor;
use ardia_state::omnibox::url::{display_url, host_of};
use ardia_state::tabs::Tab;
use ardia_state::{Action, BrowserState, EntryId, Millis, TabId, WindowId};
use gpui::{
    AnyElement, App, Context, Entity, FontWeight, IntoElement, MouseButton, ParentElement,
    SharedString, Styled, Window, div, prelude::*,
};

use crate::msg::Msg;
use crate::primitives::fade_label::fade_label;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput, focus_input};
use crate::window::browser_window::BrowserWindowView;
use crate::window::chrome::Chrome;

pub const WIDTH: f32 = 560.0;
pub const TOP: f32 = 56.0;
pub const EDGE: f32 = 12.0;
pub const ROW: f32 = 36.0;
pub const MAX_ROWS: f32 = 10.0;
pub const FIELD_ROW: f32 = 50.0;
pub const FIELD_PAD: f32 = 16.0;
pub const SECTION_PAD: f32 = 6.0;
pub const LABEL_INSET: f32 = 10.0;
pub const LABEL_PAD: f32 = 4.0;
pub const URL_GAP: f32 = 4.0;
pub const TITLE_LEAD: f32 = 2.0;
pub const CLOSED_SHOWN: usize = 8;
pub const PANEL_RADIUS: f32 = 16.0;
pub const ROW_RADIUS: f32 = 8.0;
pub const ROW_PAD: f32 = 8.0;
pub const TITLE_SIZE: f32 = 15.0;
pub const NO_MATCH_PAD: f32 = 16.0;

#[derive(Clone, Debug, PartialEq)]
pub enum RowKind {
    Tab {
        id: TabId,
        where_: Option<String>,
        current: bool,
    },
    Closed {
        id: EntryId,
        detail: String,
        group: Option<Option<GroupColor>>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub kind: RowKind,
    pub title: String,
    pub url: String,
    pub favicon: Option<String>,
    pub icon: Option<String>,
}

impl Row {
    pub fn detail(&self) -> Option<String> {
        match &self.kind {
            RowKind::Tab {
                where_: None,
                current: true,
                ..
            } => Some("Current Tab".to_owned()),
            RowKind::Tab { where_, .. } => where_.clone(),
            RowKind::Closed { detail, .. } if !detail.is_empty() => Some(detail.clone()),
            RowKind::Closed { .. } => None,
        }
    }
}

fn snapshot_title(title: &str, custom: Option<&str>, url: &str) -> String {
    custom
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or_else(|| (!title.is_empty()).then(|| title.to_owned()))
        .unwrap_or_else(|| {
            if url.is_empty() {
                "New Tab".to_owned()
            } else {
                url.to_owned()
            }
        })
}

pub fn candidates(state: &BrowserState, window: &str) -> (Vec<Row>, Vec<Row>) {
    let Some(w) = state.window(window) else {
        return (Vec::new(), Vec::new());
    };
    let profile = w.profile_id.clone();
    let numbers: Vec<&WindowId> = state
        .window_order
        .iter()
        .filter(|id| {
            id.as_str() == window
                || state
                    .window(id.as_str())
                    .is_some_and(|w| w.kind != ardia_state::windows::WindowKind::Incognito)
        })
        .collect();
    let mut tabs: Vec<(&Tab, ardia_state::model::Millis)> =
        ardia_state::tab_share::open_tabs_by_use(state, &profile, &w.id);
    tabs.sort_by_key(|(_, used)| std::cmp::Reverse(*used));
    let open = tabs
        .into_iter()
        .map(|(t, _)| Row {
            kind: RowKind::Tab {
                id: t.id.clone(),
                where_: (t.window_id.as_str() != window).then(|| {
                    let n = numbers
                        .iter()
                        .position(|id| **id == t.window_id)
                        .map_or(0, |i| i + 1);
                    format!("Window {n}")
                }),
                current: state
                    .window(t.window_id.as_str())
                    .and_then(|w| w.active_tab_ids.get(&profile))
                    == Some(&t.id),
            },
            title: t.display_title(),
            url: t.url.clone(),
            favicon: t.favicon.clone(),
            icon: t.custom_icon.clone(),
        })
        .collect();
    let mut closed: Vec<(Millis, Row)> = state
        .closed
        .tabs
        .iter()
        .filter(|c| c.tab.profile_id == profile)
        .map(|c| {
            (
                c.closed_at,
                Row {
                    kind: RowKind::Closed {
                        id: c.id.clone(),
                        detail: String::new(),
                        group: None,
                    },
                    title: snapshot_title(&c.tab.title, c.tab.custom_title.as_deref(), &c.tab.url),
                    url: c.tab.url.clone(),
                    favicon: c.tab.favicon.clone(),
                    icon: c.tab.custom_icon.clone(),
                },
            )
        })
        .collect();
    closed.extend(state.closed.groups.iter().map(|g| {
        let first = g.tabs.first();
        (
            g.closed_at,
            Row {
                kind: RowKind::Closed {
                    id: g.id.clone(),
                    detail: if g.tabs.len() == 1 {
                        "Group · 1 tab".to_owned()
                    } else {
                        format!("Group · {} tabs", g.tabs.len())
                    },
                    group: Some(g.group.color),
                },
                title: g.group.name.clone(),
                url: first.map(|t| t.url.clone()).unwrap_or_default(),
                favicon: first.and_then(|t| t.favicon.clone()),
                icon: g.group.icon.clone(),
            },
        )
    }));
    closed.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    (open, closed.into_iter().map(|(_, row)| row).collect())
}

pub fn rank(query: &str, rows: Vec<Row>) -> Vec<Row> {
    let mut scored: Vec<(f64, usize, Row)> = rows
        .into_iter()
        .enumerate()
        .filter_map(|(order, row)| {
            let score = fuzzy_score(query, &row.title)
                .max(fuzzy_score(query, &host_of(&row.url)) * 0.9)
                .max(fuzzy_score(query, &row.url) * 0.6);
            (score > 0.0).then_some((score, order, row))
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, _, row)| row).collect()
}

pub fn sections(state: &BrowserState, window: &str, query: &str) -> Vec<(&'static str, Vec<Row>)> {
    let (open, closed) = candidates(state, window);
    let q = query.trim();
    let (open, mut closed) = if q.is_empty() {
        (open, closed)
    } else {
        (rank(q, open), rank(q, closed))
    };
    closed.truncate(CLOSED_SHOWN);
    vec![("Open Tabs", open), ("Recently Closed", closed)]
}

pub fn scroll_for(selected: usize) -> f32 {
    ((selected as f32 - MAX_ROWS + 2.0) * ROW).max(0.0)
}

struct Search {
    input: Entity<TextInput>,
    query: String,
    selected: usize,
    scroll: f32,
}

thread_local! {
    static OPEN: RefCell<HashMap<String, Search>> = RefCell::new(HashMap::new());
}

pub fn is_open(window: &str) -> bool {
    OPEN.with(|o| o.borrow().contains_key(window))
}

pub fn close(window: &str) {
    OPEN.with(|o| o.borrow_mut().remove(window));
}

fn chosen_msg(row: &Row, window: &WindowId) -> Msg {
    match &row.kind {
        RowKind::Tab { id, .. } => Msg::Store(Action::ActivateTab { tab: id.clone() }),
        RowKind::Closed { id, .. } => Msg::Store(Action::RestoreClosed {
            id: id.clone(),
            window: Some(window.clone()),
        }),
    }
}

fn flat(state: &BrowserState, window: &str, query: &str) -> Vec<Row> {
    sections(state, window, query)
        .into_iter()
        .flat_map(|(_, rows)| rows)
        .collect()
}

pub fn open(view: &BrowserWindowView, window: &mut Window, cx: &mut Context<BrowserWindowView>) {
    let key = view.window_id.as_str().to_owned();
    if is_open(&key) {
        if let Some(input) = OPEN.with(|o| o.borrow().get(&key).map(|s| s.input.clone())) {
            focus_input(&input, window, cx);
        }
        return;
    }
    let look = view.look.p;
    let input = cx.new(|cx| {
        let mut input = TextInput::new("Search Tabs", cx);
        input.set_style(
            InputStyle {
                text: look.text,
                placeholder: look.placeholder,
                caret: look.text,
                font_size: TITLE_SIZE,
                ..InputStyle::default()
            },
            cx,
        );
        input
    });
    let events_key = key.clone();
    cx.subscribe_in(
        &input,
        window,
        move |view: &mut BrowserWindowView, input, event: &InputEvent, window, cx| {
            let state = std::sync::Arc::clone(&view.state);
            let query = input.read(cx).text().to_owned();
            let rows_len = flat(&state, &events_key, &query).len();
            let mut chosen: Option<Msg> = None;
            let mut closing = false;
            OPEN.with(|o| {
                let mut o = o.borrow_mut();
                let Some(search) = o.get_mut(&events_key) else {
                    return;
                };
                match event {
                    InputEvent::Changed { .. } => {
                        search.query = query.clone();
                        search.selected = 0;
                        search.scroll = 0.0;
                    }
                    InputEvent::Up | InputEvent::Down => {
                        let delta: i64 = if matches!(event, InputEvent::Up) {
                            -1
                        } else {
                            1
                        };
                        let last = rows_len.saturating_sub(1) as i64;
                        search.selected =
                            (search.selected as i64 + delta).clamp(0, last.max(0)) as usize;
                        search.scroll = scroll_for(search.selected);
                    }
                    InputEvent::Submit(_) => {
                        let rows = flat(&state, &events_key, &search.query);
                        chosen = rows
                            .get(search.selected)
                            .map(|row| chosen_msg(row, &view.window_id));
                        closing = true;
                    }
                    InputEvent::Cancel => closing = true,
                    InputEvent::Tab => {}
                }
            });
            if closing {
                close(&events_key);
            }
            if let Some(msg) = chosen {
                view.handle(msg, window, cx);
            }
            cx.notify();
        },
    )
    .detach();
    let blur_key = key.clone();
    let focus = gpui::Focusable::focus_handle(input.read(cx), cx);
    cx.on_blur(&focus, window, move |_, _, cx| {
        close(&blur_key);
        cx.notify();
    })
    .detach();
    OPEN.with(|o| {
        o.borrow_mut().insert(
            key,
            Search {
                input: input.clone(),
                query: String::new(),
                selected: 0,
                scroll: 0.0,
            },
        )
    });
    focus_input(&input, window, cx);
    cx.notify();
}

fn select(window: String, index: usize) -> impl Fn(&bool, &mut Window, &mut App) + 'static {
    move |hovered, window_ref, _| {
        if !*hovered {
            return;
        }
        OPEN.with(|o| {
            if let Some(search) = o.borrow_mut().get_mut(&window) {
                search.selected = index;
            }
        });
        window_ref.refresh();
    }
}

fn section_label(c: &Chrome, title: &'static str) -> AnyElement {
    div()
        .px(px(LABEL_INSET))
        .pt(px(LABEL_PAD))
        .pb(px(LABEL_PAD))
        .text_size(px(11.0))
        .line_height(px(14.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(c.p.text_secondary)
        .truncate()
        .child(SharedString::new_static(title))
        .into_any_element()
}

fn row_icon(c: &Chrome, row: &Row) -> AnyElement {
    if let RowKind::Closed {
        group: Some(color), ..
    } = &row.kind
    {
        let tint = crate::sidebar::group_list::folder_art::group_tint(*color)
            .map(crate::primitives::theme_bridge::hsla)
            .unwrap_or(c.p.icon);
        return div()
            .flex_none()
            .size(px(16.0))
            .flex()
            .items_center()
            .justify_center()
            .child(icon(Icon::Folder, 14.0, tint))
            .into_any_element();
    }
    let favicon = crate::primitives::favicon::favicon_of(
        &row.url,
        row.favicon.as_deref(),
        row.icon.as_deref(),
        &row.title,
    );
    let favicon = c.resolve_favicon(favicon, &c.window.profile_id);
    crate::primitives::favicon::render_favicon(&favicon, 16.0, c.p)
}

fn result_row(c: &Chrome, row: &Row, index: usize, selected: bool) -> AnyElement {
    let p = *c.p;
    let key = c.window.id.as_str().to_owned();
    let msg = chosen_msg(row, &c.window.id);
    let emit = c.emit.clone();
    let click_key = key.clone();
    let url = (!row.url.is_empty()).then(|| format!("— {}", display_url(&row.url)));
    div()
        .id(SharedString::from(format!("search-row:{index}")))
        .h(px(ROW))
        .px(px(ROW_PAD))
        .rounded(px(ROW_RADIUS))
        .flex()
        .items_center()
        .gap(px(ROW_PAD))
        .when(selected, |this| this.bg(p.row_selected))
        .when(!selected, |this| this.hover(move |s| s.bg(p.row_hover)))
        .on_hover(select(key, index))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| {
            close(&click_key);
            emit.send(msg.clone(), window, cx);
            window.refresh();
        })
        .child(row_icon(c, row))
        .child(
            div()
                .ml(px(TITLE_LEAD))
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .child(
                    div()
                        .flex_grow(3.0)
                        .flex_basis(px(0.0))
                        .min_w_0()
                        .h(px(19.0))
                        .flex()
                        .child(fade_label(row.title.clone(), p.text, TITLE_SIZE)),
                )
                .when_some(url, |this, url| {
                    this.child(
                        div()
                            .flex_grow(2.0)
                            .flex_basis(px(0.0))
                            .min_w_0()
                            .ml(px(URL_GAP))
                            .h(px(19.0))
                            .flex()
                            .child(fade_label(url, p.text_secondary, TITLE_SIZE)),
                    )
                }),
        )
        .when_some(row.detail(), |this, detail| {
            this.child(
                div()
                    .flex_none()
                    .text_size(px(12.0))
                    .text_color(p.text_tertiary)
                    .child(SharedString::from(detail)),
            )
        })
        .when(matches!(row.kind, RowKind::Closed { .. }), |this| {
            this.child(
                div()
                    .flex_none()
                    .size(px(16.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon(Icon::History, 12.0, p.text_tertiary)),
            )
        })
        .into_any_element()
}

pub fn panel(c: &Chrome) -> Option<AnyElement> {
    let key = c.window.id.as_str().to_owned();
    let (input, query, selected, scroll) = OPEN.with(|o| {
        o.borrow()
            .get(&key)
            .map(|s| (s.input.clone(), s.query.clone(), s.selected, s.scroll))
    })?;
    let p = *c.p;
    let width = c.layout.width;
    let sections = sections(c.state, &key, &query);
    let total: usize = sections.iter().map(|(_, rows)| rows.len()).sum();
    let mut index = 0usize;
    let mut body: Vec<AnyElement> = Vec::new();
    if total == 0 {
        body.push(
            div()
                .p(px(NO_MATCH_PAD))
                .text_size(px(13.0))
                .text_color(p.text_tertiary)
                .child(SharedString::from(format!(
                    "No tabs match “{}”",
                    query.trim()
                )))
                .into_any_element(),
        );
    }
    for (title, rows) in &sections {
        if rows.is_empty() {
            continue;
        }
        let mut section = div()
            .px(px(SECTION_PAD))
            .pt(px(SECTION_PAD))
            .flex()
            .flex_col()
            .child(section_label(c, title));
        for row in rows {
            section = section.child(result_row(c, row, index, index == selected));
            index += 1;
        }
        body.push(section.into_any_element());
    }
    let close_key = key.clone();
    Some(
        div()
            .id("search-tabs-layer")
            .absolute()
            .inset_0()
            .occlude()
            .on_mouse_down(MouseButton::Left, move |_, window, _| {
                close(&close_key);
                window.refresh();
            })
            .child(
                div()
                    .id("search-tabs")
                    .debug_selector(|| "search-tabs".into())
                    .absolute()
                    .top(px(TOP))
                    .left(px(EDGE.max((width - WIDTH) / 2.0)))
                    .w(px(WIDTH.min(width - 2.0 * EDGE)))
                    .pb(px(SECTION_PAD))
                    .rounded(px(PANEL_RADIUS))
                    .bg(p.panel)
                    .border(px(0.5))
                    .border_color(p.panel_border)
                    .shadow(crate::primitives::controls::panel_shadows(c.p))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .h(px(FIELD_ROW))
                            .px(px(FIELD_PAD))
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .flex_none()
                                    .size(px(16.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(icon(Icon::Search, 13.0, p.text_secondary)),
                            )
                            .child(div().flex_1().min_w_0().child(input)),
                    )
                    .child(div().h(px(0.5)).bg(p.divider))
                    .child(
                        div()
                            .id("search-tabs-results")
                            .max_h(px(ROW * MAX_ROWS + 60.0))
                            .overflow_hidden()
                            .child(div().relative().top(px(-scroll)).children(body)),
                    ),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(title: &str, url: &str) -> Row {
        Row {
            kind: RowKind::Tab {
                id: TabId::new(title),
                where_: None,
                current: false,
            },
            title: title.to_owned(),
            url: url.to_owned(),
            favicon: None,
            icon: None,
        }
    }

    #[test]
    fn ranking_prefers_titles_then_hosts_then_urls() {
        let rows = vec![
            row("Inbox", "https://mail.google.com/"),
            row("GitHub", "https://github.com/"),
            row("Docs", "https://example.com/github-notes"),
        ];
        let ranked = rank("git", rows);
        assert_eq!(ranked[0].title, "GitHub");
        assert_eq!(ranked.len(), 2);
    }

    #[test]
    fn the_list_scrolls_to_keep_the_selection_two_rows_from_the_bottom() {
        assert_eq!(scroll_for(0), 0.0);
        assert_eq!(scroll_for(8), 0.0);
        assert_eq!(scroll_for(9), ROW);
        assert_eq!(scroll_for(12), 4.0 * ROW);
    }

    #[test]
    fn details_name_the_window_or_the_current_tab() {
        let mut r = row("A", "");
        r.kind = RowKind::Tab {
            id: TabId::new("a"),
            where_: None,
            current: true,
        };
        assert_eq!(r.detail().as_deref(), Some("Current Tab"));
        r.kind = RowKind::Tab {
            id: TabId::new("a"),
            where_: Some("Window 2".to_owned()),
            current: true,
        };
        assert_eq!(r.detail().as_deref(), Some("Window 2"));
    }
}
