use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_theme::layout::sidebar;
use gpui::{
    AnyElement, App, IntoElement, ParentElement, SharedString, Styled, Window, div, prelude::*,
};

use crate::icon_picker::symbols::SymbolWeight;
use crate::primitives::fade_label::fade_label;
use crate::primitives::icons::Icon;
use crate::sidebar::group_list::motion::group_ui;
use crate::sidebar::live_folders::rows::Completion;
use crate::sidebar::live_folders::{completion_glyph, glyph, live_colors, sf};
use crate::window::chrome::Chrome;
use ardia_state::GroupId;
use gpui::RenderOnce;

pub const HEADER_HEIGHT: f32 = 24.0;
pub const ROW_HEIGHT: f32 = 28.0;
pub const MAX_SHOWN: usize = 8;
pub const SHOWN_FOR: i64 = 24 * 3_600_000;
pub const LEAVE_DELAY: Duration = Duration::from_millis(250);
pub const DONE_OPACITY: f32 = 0.75;
pub const ROW_PAD_RIGHT: f32 = 8.0;
pub const ROW_RADIUS: f32 = 8.0;
pub const TITLE_GAP: f32 = sidebar::DIA_ROW_TITLE_GAP;

#[derive(Clone, Debug, PartialEq)]
pub struct CompletedRow {
    pub item: String,
    pub title: String,
    pub state: Completion,
    pub at: i64,
}

pub type OpenItem = Rc<dyn Fn(&str, &mut Window, &mut App)>;

pub fn shown_rows(rows: &[CompletedRow], completing: &[String], now: i64) -> Vec<CompletedRow> {
    rows.iter()
        .filter(|r| now - r.at < SHOWN_FOR && !completing.contains(&r.item))
        .cloned()
        .collect()
}

#[derive(Clone, Copy, Debug, Default)]
struct Hover {
    open: bool,
    left_at: Option<Instant>,
}

thread_local! {
    static HOVER: RefCell<HashMap<String, Hover>> = RefCell::new(HashMap::new());
}

pub fn is_open(key: &str, now: Instant) -> bool {
    HOVER.with(|h| {
        let mut h = h.borrow_mut();
        let Some(state) = h.get_mut(key) else {
            return false;
        };
        if let Some(left) = state.left_at
            && now.saturating_duration_since(left) >= LEAVE_DELAY
        {
            state.open = false;
            state.left_at = None;
        }
        state.open
    })
}

fn set_hover(key: &str, hovered: bool) {
    HOVER.with(|h| {
        let mut h = h.borrow_mut();
        let state = h.entry(key.to_owned()).or_default();
        if hovered {
            state.open = true;
            state.left_at = None;
        } else if state.open {
            state.left_at = Some(Instant::now());
        }
    });
}

pub fn footer(
    c: &Chrome,
    folder: &str,
    rows: &[CompletedRow],
    open_item: OpenItem,
) -> Option<AnyElement> {
    if rows.is_empty() {
        return None;
    }
    let p = *c.p;
    let key = format!("{}:{folder}", c.window.id);
    let open = is_open(&key, Instant::now());
    let leaving = HOVER.with(|h| h.borrow().get(&key).and_then(|s| s.left_at).is_some());
    let colors = live_colors(c);
    let hover_key = key.clone();
    let shown: Vec<&CompletedRow> = rows.iter().take(MAX_SHOWN).collect();
    let items: Vec<AnyElement> = shown
        .iter()
        .map(|row| {
            let (data, color) = completion_glyph(row.state, &colors);
            let item = row.item.clone();
            let open_item = Rc::clone(&open_item);
            div()
                .id(SharedString::from(format!(
                    "completed:{folder}:{}",
                    row.item
                )))
                .flex_none()
                .h(px(ROW_HEIGHT))
                .pl(px(sidebar::ROW_CONTENT_LEFT))
                .pr(px(ROW_PAD_RIGHT))
                .rounded(px(ROW_RADIUS))
                .flex()
                .items_center()
                .opacity(DONE_OPACITY)
                .active(move |s| s.bg(p.tab_pressed))
                .on_click(move |_, window, cx| open_item(&item, window, cx))
                .child(glyph(data, 12.0, 16.0, color, SymbolWeight::Regular))
                .child(
                    div()
                        .ml(px(TITLE_GAP))
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .child(fade_label(
                            row.title.clone(),
                            p.text_secondary,
                            c.points(12.0),
                        )),
                )
                .into_any_element()
        })
        .collect();
    let fold_height = sidebar::row_gap()
        + items.len() as f32 * ROW_HEIGHT
        + items.len().saturating_sub(1) as f32 * sidebar::row_gap();
    Some(
        div()
            .id(SharedString::from(format!("completed-footer:{folder}")))
            .debug_selector(|| "completed-footer".into())
            .flex()
            .flex_col()
            .on_hover(move |hovered, window, _| {
                set_hover(&hover_key, *hovered);
                window.refresh();
            })
            .child(
                div()
                    .h(px(HEADER_HEIGHT))
                    .pl(px(sidebar::ROW_CONTENT_LEFT))
                    .rounded(px(ROW_RADIUS))
                    .flex()
                    .items_center()
                    .when(open, |this| this.bg(p.row_hover))
                    .child(glyph(
                        sf("checkmark.circle", Icon::CheckCircleFill),
                        11.0,
                        16.0,
                        p.text_secondary,
                        SymbolWeight::Regular,
                    ))
                    .child(
                        div()
                            .ml(px(crate::sidebar::live_folders::TEXT_GAP))
                            .text_size(px(c.points(12.0)))
                            .text_color(p.text_secondary)
                            .child(SharedString::from(format!("{} Completed", rows.len()))),
                    ),
            )
            .child(CompletedFold {
                key: GroupId::new(format!("completed-fold:{key}")),
                open,
                height: fold_height,
                items,
            })
            .when(leaving, |this| this.child(crate::sidebar::Frames(true)))
            .into_any_element(),
    )
}

#[derive(IntoElement)]
struct CompletedFold {
    key: GroupId,
    open: bool,
    height: f32,
    items: Vec<AnyElement>,
}

impl RenderOnce for CompletedFold {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (open, moving) = group_ui(cx).open(&self.key, self.open);
        if moving {
            window.request_animation_frame();
        }
        div().when(open > 0.0, |this| {
            this.child(
                div()
                    .h(px(self.height * open))
                    .opacity(open)
                    .overflow_hidden()
                    .child(
                        div()
                            .pt(px(sidebar::row_gap()))
                            .flex()
                            .flex_col()
                            .gap(px(sidebar::row_gap()))
                            .children(self.items),
                    ),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(item: &str, at: i64) -> CompletedRow {
        CompletedRow {
            item: item.to_owned(),
            title: item.to_owned(),
            state: Completion::Merged,
            at,
        }
    }

    #[test]
    fn only_the_last_day_and_not_still_completing_items_show() {
        let now = 10 * SHOWN_FOR;
        let rows = vec![
            row("a", now - 1000),
            row("b", now - SHOWN_FOR),
            row("c", now),
        ];
        let shown = shown_rows(&rows, &["c".to_owned()], now);
        assert_eq!(shown, vec![row("a", now - 1000)]);
    }

    #[test]
    fn the_fold_closes_a_quarter_second_after_the_pointer_leaves() {
        let key = "w:folder";
        set_hover(key, true);
        assert!(is_open(key, Instant::now()));
        set_hover(key, false);
        assert!(is_open(key, Instant::now()));
        assert!(!is_open(key, Instant::now() + LEAVE_DELAY));
    }
}
