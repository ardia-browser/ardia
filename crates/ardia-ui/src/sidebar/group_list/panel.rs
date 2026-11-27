use ardia_state::group_panel::{PanelTab, by_recent_use, group_tab_ids, matching_rows};
use ardia_state::{BrowserState, TabId};
use ardia_theme::layout::panel;
use gpui::{
    AnyView, App, AppContext, Context, Entity, FontWeight, IntoElement, ParentElement, Render,
    ScrollHandle, SharedString, Styled, Subscription, Window, div, prelude::*,
};

use crate::host_data::ago;
use crate::look::{Look, Palette};
use crate::msg::{Emit, Msg};
use crate::primitives::controls::{panel_shadows, popover_material};
use crate::primitives::favicon::{Favicon, render_favicon};
use crate::primitives::glass_states::{
    GLASS_CONTROL_GROUP, GlassBacking, GlassStates, stateful_glass,
};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput, focus_input};
use crate::scale::px;

pub const WIDTH: f32 = 264.0;
pub const SEARCH_GLYPH: f32 = 13.0;
pub const SEARCH_GLYPH_BOX: f32 = 16.0;
pub const SEARCH_GAP: f32 = 6.0;
pub const SEARCH_TEXT_INSET: f32 = 2.0;
pub const SEARCH_FONT: f32 = ardia_theme::tokens::TypeSize::Title.points();
pub const TITLE_SIZE: f32 = ardia_theme::tokens::TypeSize::Body.points();
pub const TITLE_LINE: f32 = ardia_theme::tokens::TypeSize::Body.line_height();
pub const DETAIL_SIZE: f32 = ardia_theme::tokens::TypeSize::Caption.points();
pub const DETAIL_LINE: f32 = ardia_theme::tokens::TypeSize::Caption.line_height();
pub const TEXT_PAD: f32 = 6.0;
pub const SEARCH_ROW: f32 = 44.0;
pub const ROW: f32 = 44.0;
pub const MAX_ROWS: usize = 7;
pub const LIST_PAD: f32 = panel::INSET - (ROW - panel::ICON_SLOT) / 2.0;
pub const SEPARATOR: f32 = 0.5 + panel::SEPARATOR_GAP * 2.0;

pub fn list_height(count: usize) -> f32 {
    LIST_PAD * 2.0 + count.clamp(1, MAX_ROWS) as f32 * ROW
}

pub fn panel_height(count: usize) -> f32 {
    SEARCH_ROW + SEPARATOR + list_height(count)
}

pub fn empty_line(query: &str) -> String {
    let q = query.trim();
    if q.is_empty() {
        "No tabs".to_owned()
    } else {
        format!("No tabs match \u{201C}{q}\u{201D}")
    }
}

pub fn panel_rows(state: &BrowserState, group: &str) -> Vec<PanelTab> {
    let shared = state
        .group(group)
        .and_then(|g| ardia_state::tab_share::shared_view(state, &g.window_id));
    by_recent_use(
        group_tab_ids(&state.groups, group)
            .into_iter()
            .filter_map(|id| state.tab(id.as_str()))
            .map(|t| PanelTab {
                id: t.id.clone(),
                title: t.display_title(),
                url: t.url.clone(),
                used_at: shared.as_ref().map_or(t.last_active_at, |v| v.last_used(t)),
            })
            .collect(),
    )
}

pub struct GroupPanel {
    all: Vec<PanelTab>,
    favicons: Vec<(TabId, Favicon)>,
    input: Entity<TextInput>,
    query: String,
    selected: usize,
    scroll: ScrollHandle,
    emit: Emit,
    p: Palette,
    glass: Option<Look>,
    now: i64,
    _input_events: Subscription,
}

impl GroupPanel {
    pub fn build(
        rows: Vec<PanelTab>,
        favicons: Vec<(TabId, Favicon)>,
        emit: Emit,
        p: Palette,
        glass: Option<Look>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyView {
        cx.new(|cx| {
            let input = cx.new(|cx| {
                let mut input = TextInput::new("Search Tabs", cx);
                input.set_style(
                    InputStyle {
                        text: p.text,
                        placeholder: p.placeholder,
                        caret: p.text,
                        selection: p.row_selected,
                        font_size: SEARCH_FONT,
                        weight: FontWeight::NORMAL,
                    },
                    cx,
                );
                input
            });
            let events = cx.subscribe_in(
                &input,
                window,
                |panel: &mut GroupPanel, input, event, window, cx| {
                    panel.on_input(input.read(cx).text().to_owned(), event, window, cx);
                },
            );
            GroupPanel {
                all: rows,
                favicons,
                input,
                query: String::new(),
                selected: 0,
                scroll: ScrollHandle::new(),
                emit,
                p,
                glass,
                now: now_millis(),
                _input_events: events,
            }
        })
        .into()
    }

    fn shown(&self) -> Vec<PanelTab> {
        matching_rows(&self.query, &self.all)
    }

    fn on_input(
        &mut self,
        text: String,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Changed { .. } => {
                self.query = text;
                self.selected = 0;
                self.scroll.scroll_to_item(0);
            }
            InputEvent::Up => self.step(-1),
            InputEvent::Down => self.step(1),
            InputEvent::Submit(_) => {
                if let Some(row) = self.shown().get(self.selected).cloned() {
                    self.choose(row.id, window, cx);
                }
            }
            InputEvent::Cancel => {
                cx.stop_propagation();
                window.blur(cx);
            }
            InputEvent::Tab => {}
        }
        cx.notify();
    }

    fn step(&mut self, delta: i32) {
        let count = self.shown().len();
        if count == 0 {
            return;
        }
        let next = (self.selected as i32 + delta).clamp(0, count as i32 - 1) as usize;
        self.selected = next;
        self.scroll.scroll_to_item(next);
    }

    fn choose(&mut self, tab: TabId, window: &mut Window, cx: &mut Context<Self>) {
        self.emit.send(
            Msg::PickTab {
                tab,
                toggle: false,
                range: false,
            },
            window,
            cx,
        );
    }

    fn favicon(&self, tab: &TabId) -> Option<&Favicon> {
        self.favicons
            .iter()
            .find(|(id, _)| id == tab)
            .map(|(_, f)| f)
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

impl Render for GroupPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.p;
        let rows = self.shown();
        let current = self.selected.min(rows.len().saturating_sub(1));
        let list = list_height(self.all.len());
        let input = self.input.clone();
        div()
            .id("group-panel")
            .debug_selector(|| "group-panel".into())
            .w(px(WIDTH))
            .h(px(panel_height(self.all.len())))
            .rounded(px(panel::RADIUS))
            .bg(p.popover_fill)
            .border(px(0.5))
            .border_color(p.popover_border)
            .shadow(panel_shadows(&p))
            .overflow_hidden()
            .flex()
            .flex_col()
            .text_color(p.text)
            .children(popover_material(panel::RADIUS, &p))
            .on_hover(cx.listener(move |_, hovered: &bool, window, cx| {
                if *hovered {
                    focus_input(&input, window, cx);
                }
            }))
            .child(
                div()
                    .flex_none()
                    .h(px(SEARCH_ROW))
                    .px(px(panel::INSET))
                    .flex()
                    .items_center()
                    .gap(px(SEARCH_GAP))
                    .child(
                        div()
                            .flex_none()
                            .size(px(SEARCH_GLYPH_BOX))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(Icon::Search, SEARCH_GLYPH, p.text_secondary)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .pl(px(SEARCH_TEXT_INSET))
                            .child(self.input.clone()),
                    ),
            )
            .child(
                div()
                    .flex_none()
                    .mx(px(panel::INSET))
                    .my(px(panel::SEPARATOR_GAP))
                    .h(px(0.5))
                    .bg(p.divider),
            )
            .child(
                div()
                    .id("group-panel-list")
                    .flex_none()
                    .h(px(list))
                    .py(px(LIST_PAD))
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .when(rows.is_empty(), |this| {
                        this.child(
                            div()
                                .px(px(panel::INSET))
                                .h(px(ROW))
                                .flex()
                                .items_center()
                                .text_size(px(13.))
                                .text_color(p.text_tertiary)
                                .truncate()
                                .child(empty_line(&self.query)),
                        )
                    })
                    .children(rows.into_iter().enumerate().map(|(i, row)| {
                        let selected = i == current;
                        let id = row.id.clone();
                        let favicon = self.favicon(&row.id).cloned();
                        div()
                            .id(SharedString::from(format!("group-panel-row:{}", row.id)))
                            .flex_none()
                            .min_h(px(ROW))
                            .mx(px(panel::ROW_INSET))
                            .px(px(panel::ROW_PADDING))
                            .rounded(px(panel::ROW_RADIUS))
                            .flex()
                            .items_center()
                            .gap(px(panel::ICON_GAP))
                            .when(selected, |this| this.bg(p.row_selected))
                            .map(|this| match &self.glass {
                                Some(look) => this
                                    .relative()
                                    .group(GLASS_CONTROL_GROUP)
                                    .hover(|style| style.bg(gpui::transparent_black()))
                                    .child(stateful_glass(
                                        look,
                                        panel::ROW_RADIUS,
                                        GlassStates::ROW,
                                        GlassBacking::Surface,
                                    )),
                                None => this.hover(move |style| style.bg(p.menu_hover)),
                            })
                            .on_hover(cx.listener(move |panel, hovered: &bool, _, cx| {
                                if *hovered && panel.selected != i {
                                    panel.selected = i;
                                    cx.notify();
                                }
                            }))
                            .on_click(cx.listener(move |panel, _, window, cx| {
                                panel.choose(id.clone(), window, cx);
                            }))
                            .child(
                                div()
                                    .flex_none()
                                    .size(px(panel::ICON_SLOT))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .children(favicon.map(|f| render_favicon(&f, 16., &p))),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .py(px(TEXT_PAD))
                                    .flex()
                                    .flex_col()
                                    .child(
                                        div()
                                            .text_size(px(TITLE_SIZE))
                                            .line_height(px(TITLE_LINE))
                                            .text_color(p.text)
                                            .truncate()
                                            .child(row.title.clone()),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(DETAIL_SIZE))
                                            .line_height(px(DETAIL_LINE))
                                            .text_color(p.text_secondary)
                                            .truncate()
                                            .child(ago(self.now, row.used_at)),
                                    ),
                            )
                    })),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_search_field_and_rows_use_the_old_bare_field_and_menu_row_metrics() {
        assert_eq!(
            (SEARCH_GLYPH, SEARCH_GLYPH_BOX, SEARCH_GAP),
            (13.0, 16.0, 6.0)
        );
        assert_eq!(SEARCH_FONT, 15.0);
        assert_eq!(SEARCH_TEXT_INSET, 2.0);
        assert_eq!((TITLE_SIZE, TITLE_LINE), (13.0, 16.0));
        assert_eq!((DETAIL_SIZE, DETAIL_LINE), (11.0, 14.0));
        assert_eq!(TEXT_PAD, 6.0);
    }

    #[test]
    fn the_panel_grows_to_seven_rows() {
        assert_eq!(LIST_PAD, 4.0);
        assert_eq!(list_height(0), 52.0);
        assert_eq!(list_height(3), 140.0);
        assert_eq!(list_height(40), 316.0);
        assert_eq!(panel_height(1), 44.0 + 10.5 + 52.0);
        assert_eq!(empty_line(" "), "No tabs");
        assert_eq!(empty_line("x"), "No tabs match \u{201C}x\u{201D}");
    }
}
