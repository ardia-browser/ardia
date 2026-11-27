pub mod emoji;
mod emoji_data;
pub mod symbols;

use std::sync::Arc;
use std::time::Duration;

use ardia_theme::tokens::{radius, space};
use gpui::{
    Animation, AnimationExt, App, Context, Entity, EventEmitter, FocusHandle, Focusable,
    FontWeight, Hsla, IntoElement, MouseButton, ParentElement, Render, ScrollHandle, SharedString,
    Styled, Subscription, Window, div, point, prelude::*, rgba,
};

use crate::host::UiHost;
use crate::look::Palette;
use crate::primitives::controls::tooltip;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput, focus_input};
use crate::scale::px;

use emoji::{emoji_sections, matches_terms, same_icon, search_emoji, search_terms};
use symbols::{SymbolWeight, icon_symbol, symbol, symbol_icon};

pub mod tokens {
    pub const COLUMNS: usize = 9;
    pub const CELL: f32 = 32.0;
    pub const ROWS: usize = 7;
    pub const HEADER: f32 = 26.0;
    pub const EMOJI: f32 = 20.0;
    pub const SYMBOL: f32 = 15.0;
    pub const SYMBOL_BOX: f32 = 20.0;
    pub const PAD: f32 = 8.0;
    pub const ANCHOR_GAP: f32 = 6.0;
    pub const WINDOW_MARGIN: f32 = 8.0;
    pub const SIDEBAR_GAP: f32 = 6.0;
    pub const HAIRLINE: f32 = 0.5;
    pub const WIDTH: f32 = COLUMNS as f32 * CELL + PAD * 2.0 + HAIRLINE * 2.0;
    pub const GRID_WIDTH: f32 = COLUMNS as f32 * CELL;
    pub const GRID_HEIGHT: f32 = ROWS as f32 * CELL;
    pub const TOP_ROW: f32 = 30.0;
    pub const SEARCH_HEIGHT: f32 = 28.0;
    pub const JUMP_BOX: f32 = 24.0;
    pub const ACTION_HEIGHT: f32 = 24.0;
    pub const GAP: f32 = 8.0;
    pub const CELL_HOVER_DARK: u32 = 0xFFFF_FF40;
    pub const CELL_HOVER_LIGHT: u32 = 0x8688_8D40;
    pub const APPEAR_MS: u64 = 150;

    pub const fn height(with_actions: bool) -> f32 {
        let actions = if with_actions {
            GAP + ACTION_HEIGHT
        } else {
            0.0
        };
        PAD * 2.0 + HAIRLINE * 2.0 + TOP_ROW + GAP + GRID_HEIGHT + GAP + JUMP_BOX + actions
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PickerSymbol {
    pub name: &'static str,
    pub title: &'static str,
}

impl PickerSymbol {
    pub const fn new(name: &'static str, title: &'static str) -> Self {
        PickerSymbol { name, title }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PickerAction {
    pub title: SharedString,
    pub icon: Option<&'static str>,
    pub primary: bool,
    pub choice: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PickerTab {
    Emoji,
    Symbols,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GridIcon {
    pub icon: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GridSection {
    pub title: Option<&'static str>,
    pub symbol: Option<&'static str>,
    pub icons: Vec<GridIcon>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum GridRow {
    Title(&'static str),
    Icons(Vec<GridIcon>),
}

impl GridRow {
    pub fn height(&self) -> f32 {
        match self {
            GridRow::Title(_) => tokens::HEADER,
            GridRow::Icons(_) => tokens::CELL,
        }
    }
}

fn section_symbol(title: &str) -> Option<&'static str> {
    Some(match title {
        "Smileys" => "face.smiling",
        "People" => "person",
        "Animals & Nature" => "pawprint",
        "Food & Drink" => "fork.knife",
        "Activities" => "soccerball",
        "Travel & Places" => "car",
        "Objects" => "lightbulb",
        "Symbols" => "heart",
        "Flags" => "flag",
        _ => return None,
    })
}

pub fn picker_sections(
    tab: PickerTab,
    terms: &[String],
    symbols: &[PickerSymbol],
) -> Vec<GridSection> {
    match tab {
        PickerTab::Symbols => vec![GridSection {
            title: None,
            symbol: None,
            icons: symbols
                .iter()
                .filter(|s| {
                    terms.is_empty() || matches_terms(&format!("{} {}", s.name, s.title), terms)
                })
                .map(|s| GridIcon {
                    icon: symbol_icon(s.name),
                    label: s.title.to_owned(),
                })
                .collect(),
        }],
        PickerTab::Emoji if !terms.is_empty() => vec![GridSection {
            title: None,
            symbol: None,
            icons: search_emoji(terms)
                .into_iter()
                .map(|e| GridIcon {
                    icon: e.emoji.to_owned(),
                    label: e.name.to_owned(),
                })
                .collect(),
        }],
        PickerTab::Emoji => emoji_sections()
            .iter()
            .map(|s| GridSection {
                title: Some(s.title),
                symbol: section_symbol(s.title),
                icons: s
                    .emoji
                    .iter()
                    .map(|e| GridIcon {
                        icon: e.emoji.to_owned(),
                        label: e.name.to_owned(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

pub fn grid_rows(sections: &[GridSection]) -> Vec<GridRow> {
    let mut rows = Vec::new();
    for section in sections {
        if let Some(title) = section.title {
            rows.push(GridRow::Title(title));
        }
        for chunk in section.icons.chunks(tokens::COLUMNS) {
            rows.push(GridRow::Icons(chunk.to_vec()));
        }
    }
    rows
}

pub fn row_offsets(rows: &[GridRow]) -> Vec<f32> {
    let mut y = 0.0;
    rows.iter()
        .map(|row| {
            let at = y;
            y += row.height();
            at
        })
        .collect()
}

pub fn shown_section(headers: &[f32], y: f32) -> usize {
    headers.iter().enumerate().fold(
        0,
        |last, (i, offset)| if *offset <= y + 1.0 { i } else { last },
    )
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Anchor {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Room {
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PickerPlace {
    pub top: f32,
    pub left: f32,
    pub upward: bool,
}

pub fn clamp_left(left: f32, room: Room) -> f32 {
    left.min(room.width - tokens::WINDOW_MARGIN - tokens::WIDTH)
        .max(tokens::WINDOW_MARGIN)
}

pub fn clamp_top(top: f32, height: f32, room: Room) -> f32 {
    top.min(room.height - tokens::WINDOW_MARGIN - height)
        .max(tokens::WINDOW_MARGIN)
}

pub fn near_anchor(anchor: Option<Anchor>, height: f32, room: Room) -> PickerPlace {
    let margin = tokens::WINDOW_MARGIN;
    let gap = tokens::ANCHOR_GAP;
    let anchor = anchor.unwrap_or(Anchor {
        x: room.width / 2.0,
        y: margin,
        width: 0.0,
        height: 0.0,
    });
    let below = anchor.y + anchor.height + gap;
    let above = anchor.y - gap - height;
    let upward = below + height > room.height - margin && above >= margin;
    let top = if upward {
        above
    } else {
        below.min(room.height - margin - height).max(margin)
    };
    PickerPlace {
        top,
        left: clamp_left(anchor.x + anchor.width / 2.0 - tokens::WIDTH / 2.0, room),
        upward,
    }
}

pub fn first_match(sections: &[GridSection]) -> Option<&GridIcon> {
    sections.iter().find_map(|s| s.icons.first())
}

pub fn initial_scroll(rows: &[GridRow], offsets: &[f32], current: Option<&str>) -> f32 {
    let found = rows.iter().position(|row| match row {
        GridRow::Icons(icons) => icons.iter().any(|i| same_icon(Some(&i.icon), current)),
        GridRow::Title(_) => false,
    });
    match found {
        Some(index) if index > 1 => offsets.get(index - 1).copied().unwrap_or(0.0),
        _ => 0.0,
    }
}

pub struct PickerSetup {
    pub current: Option<String>,
    pub symbols: &'static [PickerSymbol],
    pub actions: Vec<PickerAction>,
    pub place: PickerPlace,
    pub p: Palette,
}

#[derive(Clone, Debug, PartialEq)]
pub enum IconPickerEvent {
    Choose(Option<String>),
    Close,
}

pub struct IconPickerView {
    host: Arc<dyn UiHost>,
    current: Option<String>,
    symbols: &'static [PickerSymbol],
    actions: Vec<PickerAction>,
    tab: PickerTab,
    terms: Vec<String>,
    sections: Vec<GridSection>,
    rows: Vec<GridRow>,
    offsets: Vec<f32>,
    headers: Vec<f32>,
    search: Entity<TextInput>,
    scroll: ScrollHandle,
    focus: FocusHandle,
    pub place: PickerPlace,
    p: Palette,
    _input: Subscription,
}

impl EventEmitter<IconPickerEvent> for IconPickerView {}

impl Focusable for IconPickerView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl IconPickerView {
    pub fn new(
        host: Arc<dyn UiHost>,
        setup: PickerSetup,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let PickerSetup {
            current,
            symbols,
            actions,
            place,
            p,
        } = setup;
        let tab = if icon_symbol(current.as_deref()).is_some() {
            PickerTab::Symbols
        } else {
            PickerTab::Emoji
        };
        let search = cx.new(|cx| TextInput::new(placeholder(tab), cx));
        search.update(cx, |input, cx| input.set_style(input_style(&p), cx));
        let input = cx.subscribe_in(&search, window, Self::on_input);
        focus_input(&search, window, cx);
        let mut view = IconPickerView {
            host,
            current,
            symbols,
            actions,
            tab,
            terms: Vec::new(),
            sections: Vec::new(),
            rows: Vec::new(),
            offsets: Vec::new(),
            headers: Vec::new(),
            search,
            scroll: ScrollHandle::new(),
            focus: cx.focus_handle(),
            place,
            p,
            _input: input,
        };
        view.rebuild();
        let start = initial_scroll(&view.rows, &view.offsets, view.current.as_deref());
        view.scroll.set_offset(point(px(0.), px(-start)));
        view
    }

    pub fn tab(&self) -> PickerTab {
        self.tab
    }

    pub fn sections(&self) -> &[GridSection] {
        &self.sections
    }

    pub fn set_palette(&mut self, p: Palette, cx: &mut Context<Self>) {
        if self.p != p {
            self.p = p;
            self.search
                .update(cx, |input, cx| input.set_style(input_style(&p), cx));
            cx.notify();
        }
    }

    fn rebuild(&mut self) {
        self.sections = picker_sections(self.tab, &self.terms, self.symbols);
        self.rows = grid_rows(&self.sections);
        self.offsets = row_offsets(&self.rows);
        self.headers = self
            .rows
            .iter()
            .zip(&self.offsets)
            .filter_map(|(row, y)| matches!(row, GridRow::Title(_)).then_some(*y))
            .collect();
    }

    pub fn set_tab(&mut self, tab: PickerTab, cx: &mut Context<Self>) {
        if self.tab == tab {
            return;
        }
        self.tab = tab;
        self.search
            .update(cx, |input, cx| input.set_placeholder(placeholder(tab), cx));
        self.rebuild();
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }

    pub fn set_query(&mut self, query: &str, cx: &mut Context<Self>) {
        let terms = search_terms(query);
        if terms == self.terms {
            return;
        }
        self.terms = terms;
        self.rebuild();
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }

    fn on_input(
        &mut self,
        input: &Entity<TextInput>,
        event: &InputEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Changed { .. } => {
                let query = input.read(cx).text().to_owned();
                self.set_query(&query, cx);
            }
            InputEvent::Cancel => cx.emit(IconPickerEvent::Close),
            InputEvent::Submit(_) => {
                if self.terms.is_empty() {
                    return;
                }
                if let Some(first) = first_match(&self.sections) {
                    cx.emit(IconPickerEvent::Choose(Some(first.icon.clone())));
                }
            }
            _ => {}
        }
    }

    fn scroll_y(&self) -> f32 {
        -crate::scale::points(self.scroll.offset().y)
    }

    fn cell(&self, item: &GridIcon, cx: &mut Context<Self>) -> gpui::AnyElement {
        let p = self.p;
        let selected = same_icon(Some(&item.icon), self.current.as_deref());
        let hover = cell_hover(p.dark);
        let chosen = item.icon.clone();
        let body = match icon_symbol(Some(&item.icon)) {
            Some(name) => symbol(
                self.host.as_ref(),
                name,
                tokens::SYMBOL,
                tokens::SYMBOL_BOX,
                SymbolWeight::Regular,
                p.icon,
            ),
            None => div()
                .w(px(tokens::CELL))
                .text_center()
                .text_size(px(tokens::EMOJI))
                .line_height(px(tokens::CELL))
                .child(SharedString::from(item.icon.clone()))
                .into_any_element(),
        };
        div()
            .id(SharedString::from(format!("icon-cell:{}", item.icon)))
            .size(px(tokens::CELL))
            .flex_none()
            .rounded(px(radius::TILE))
            .flex()
            .items_center()
            .justify_center()
            .when(selected, |this| this.bg(hover))
            .hover(move |style| style.bg(hover))
            .tooltip(tooltip(SharedString::from(item.label.clone()), &p))
            .on_click(cx.listener(move |_, _, _, cx| {
                cx.emit(IconPickerEvent::Choose(Some(chosen.clone())))
            }))
            .child(body)
            .into_any_element()
    }

    fn grid(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let p = self.p;
        let jumps = self.sections.len() > 1;
        let height = if jumps {
            tokens::GRID_HEIGHT
        } else {
            tokens::GRID_HEIGHT + tokens::JUMP_BOX + space::M
        };
        let total: f32 = self.rows.iter().map(GridRow::height).sum();
        let y = self.scroll_y();
        let visible: Vec<gpui::AnyElement> = self
            .rows
            .iter()
            .zip(&self.offsets)
            .filter(|(row, top)| {
                **top + row.height() >= y - tokens::CELL && **top <= y + height + tokens::CELL
            })
            .map(|(row, top)| {
                let placed = div()
                    .absolute()
                    .left_0()
                    .top(px(*top))
                    .w(px(tokens::GRID_WIDTH));
                match row {
                    GridRow::Title(title) => placed
                        .h(px(tokens::HEADER))
                        .pt(px(space::ML))
                        .pl(px(space::XS))
                        .text_size(px(11.))
                        .line_height(px(14.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.text_secondary)
                        .child(*title)
                        .into_any_element(),
                    GridRow::Icons(icons) => placed
                        .h(px(tokens::CELL))
                        .flex()
                        .children(icons.iter().map(|item| self.cell(item, cx)))
                        .into_any_element(),
                }
            })
            .collect();
        let empty = self.rows.is_empty();
        div()
            .id("icon-grid")
            .debug_selector(|| "icon-grid".into())
            .w(px(tokens::GRID_WIDTH))
            .h(px(height))
            .flex_none()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .on_scroll(cx.listener(|_, _, _, cx| cx.notify()))
            .child(
                div()
                    .relative()
                    .w(px(tokens::GRID_WIDTH))
                    .h(px(total.max(height)))
                    .children(visible)
                    .when(empty, |this| {
                        this.child(
                            div()
                                .p(px(space::M))
                                .text_size(px(12.))
                                .text_color(p.text_tertiary)
                                .child("No matches"),
                        )
                    }),
            )
            .into_any_element()
    }

    fn jumps(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if self.sections.len() <= 1 {
            return None;
        }
        let p = self.p;
        let at = shown_section(&self.headers, self.scroll_y());
        Some(
            div()
                .w(px(tokens::GRID_WIDTH))
                .flex()
                .justify_between()
                .children(self.sections.iter().enumerate().map(|(i, section)| {
                    let offset = self.headers.get(i).copied().unwrap_or(0.0);
                    let name = section.symbol.unwrap_or("circle.fill");
                    let active = i == at;
                    div()
                        .id(SharedString::from(format!("icon-jump:{i}")))
                        .size(px(tokens::JUMP_BOX))
                        .rounded(px(radius::CONTROL))
                        .flex()
                        .items_center()
                        .justify_center()
                        .when(active, |this| this.bg(p.toolbar_pressed))
                        .hover(move |style| style.bg(p.toolbar_hover))
                        .active(move |style| style.bg(p.toolbar_pressed))
                        .tooltip(tooltip(
                            SharedString::from(section.title.unwrap_or_default()),
                            &p,
                        ))
                        .on_click(cx.listener(move |view, _, _, cx| {
                            view.scroll.set_offset(point(px(0.), px(-offset)));
                            cx.notify();
                        }))
                        .child(symbol(
                            self.host.as_ref(),
                            name,
                            11.,
                            tokens::JUMP_BOX,
                            SymbolWeight::Regular,
                            if active { p.text } else { p.icon },
                        ))
                }))
                .into_any_element(),
        )
    }

    fn action_row(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if self.actions.is_empty() {
            return None;
        }
        let p = self.p;
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(space::S))
                .children(self.actions.iter().map(|action| {
                    let choice = action.choice.clone();
                    let primary = action.primary;
                    let (fill, hover, pressed, ink) = if primary {
                        (p.text, p.text, p.text, p.on_go)
                    } else {
                        (p.url_pill, p.toolbar_hover, p.toolbar_pressed, p.text)
                    };
                    div()
                        .id(SharedString::from(format!("icon-action:{}", action.title)))
                        .flex_1()
                        .h(px(tokens::ACTION_HEIGHT))
                        .rounded(px(tokens::ACTION_HEIGHT / 2.0))
                        .px(px(space::M))
                        .bg(fill)
                        .hover(move |style| {
                            let style = style.bg(hover);
                            if primary {
                                style.opacity(CHIP_DIM)
                            } else {
                                style
                            }
                        })
                        .active(move |style| {
                            let style = style.bg(pressed);
                            if primary {
                                style.opacity(CHIP_DIM)
                            } else {
                                style
                            }
                        })
                        .flex()
                        .items_center()
                        .justify_center()
                        .gap(px(space::XS))
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(IconPickerEvent::Choose(choice.clone()))
                        }))
                        .when_some(action.icon, |this, name| {
                            this.child(symbol(
                                self.host.as_ref(),
                                name,
                                10.5,
                                14.,
                                SymbolWeight::Semibold,
                                ink,
                            ))
                        })
                        .child(
                            div()
                                .text_size(px(12.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(ink)
                                .child(action.title.clone()),
                        )
                }))
                .into_any_element(),
        )
    }
}

const CHIP_DIM: f32 = 0.85;

fn placeholder(tab: PickerTab) -> &'static str {
    match tab {
        PickerTab::Emoji => "Search emoji",
        PickerTab::Symbols => "Search symbols",
    }
}

fn input_style(p: &Palette) -> InputStyle {
    InputStyle {
        text: p.text,
        placeholder: p.placeholder,
        caret: p.caret,
        selection: p.selection,
        font_size: 13.0,
        weight: FontWeight::NORMAL,
    }
}

pub fn cell_hover(dark: bool) -> Hsla {
    rgba(if dark {
        tokens::CELL_HOVER_DARK
    } else {
        tokens::CELL_HOVER_LIGHT
    })
    .into()
}

impl Render for IconPickerView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.p;
        let place = self.place;
        let tabs = [
            (PickerTab::Emoji, "face.smiling", "Emoji"),
            (PickerTab::Symbols, "star.square.on.square", "Symbols"),
        ];
        let grid = self.grid(cx);
        let jumps = self.jumps(cx);
        let actions = self.action_row(cx);
        div()
            .id("icon-picker")
            .debug_selector(|| "icon-picker".into())
            .track_focus(&self.focus)
            .absolute()
            .top(px(place.top))
            .left(px(place.left))
            .w(px(tokens::WIDTH))
            .p(px(tokens::PAD))
            .flex()
            .flex_col()
            .gap(px(tokens::GAP))
            .rounded(px(radius::SHEET))
            .bg(p.popover_fill)
            .border(px(tokens::HAIRLINE))
            .border_color(p.popover_border)
            .shadow(crate::primitives::controls::panel_shadows(&p))
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .h(px(tokens::TOP_ROW))
                    .flex()
                    .items_center()
                    .gap(px(space::S))
                    .child(
                        div()
                            .flex_1()
                            .h(px(tokens::SEARCH_HEIGHT))
                            .rounded(px(radius::TILE))
                            .px(px(space::M))
                            .bg(p.field)
                            .flex()
                            .items_center()
                            .gap(px(space::XS))
                            .child(icon(Icon::Search, 12., p.text_secondary))
                            .child(div().flex_1().child(self.search.clone())),
                    )
                    .children(tabs.into_iter().map(|(tab, name, title)| {
                        let active = self.tab == tab;
                        div()
                            .id(SharedString::from(format!("icon-tab:{title}")))
                            .size(px(30.))
                            .rounded(px(radius::TOOLBAR))
                            .flex()
                            .items_center()
                            .justify_center()
                            .when(active, |this| this.bg(p.toolbar_pressed))
                            .hover(move |style| style.bg(p.toolbar_hover))
                            .active(move |style| style.bg(p.toolbar_pressed))
                            .tooltip(tooltip(SharedString::new_static(title), &p))
                            .on_click(cx.listener(move |view, _, _, cx| view.set_tab(tab, cx)))
                            .child(symbol(
                                self.host.as_ref(),
                                name,
                                15.,
                                20.,
                                SymbolWeight::Regular,
                                p.icon,
                            ))
                    })),
            )
            .child(grid)
            .children(jumps)
            .children(actions)
            .with_animation(
                "icon-picker-appear",
                Animation::new(Duration::from_millis(tokens::APPEAR_MS))
                    .with_easing(|t| ardia_theme::motion::ease_out_cubic(f64::from(t)) as f32),
                move |panel, t| {
                    let rise = if place.upward { 4.0 } else { -4.0 };
                    panel.opacity(t).top(px(place.top + rise * (1.0 - t)))
                },
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn symbols() -> &'static [PickerSymbol] {
        crate::profiles::PROFILE_SYMBOLS
    }

    #[test]
    fn width_and_height_match_the_old_tokens() {
        assert_eq!(tokens::WIDTH, 305.0);
        assert_eq!(tokens::height(true), 343.0);
        assert_eq!(tokens::height(false), 311.0);
    }

    #[test]
    fn symbols_filter_by_name_and_title() {
        let all = picker_sections(PickerTab::Symbols, &[], symbols());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].icons.len(), 45);
        assert_eq!(all[0].icons[0].icon, "symbol:house.fill");
        let work = picker_sections(PickerTab::Symbols, &search_terms("work"), symbols());
        assert_eq!(work[0].icons.len(), 1);
        assert_eq!(work[0].icons[0].label, "Work");
        let none = picker_sections(PickerTab::Symbols, &search_terms("qqq"), symbols());
        assert!(grid_rows(&none).is_empty());
    }

    #[test]
    fn emoji_sections_and_rows() {
        let sections = picker_sections(PickerTab::Emoji, &[], symbols());
        assert_eq!(sections.len(), 9);
        assert_eq!(sections[0].symbol, Some("face.smiling"));
        let rows = grid_rows(&sections);
        assert_eq!(rows[0], GridRow::Title("Smileys"));
        assert!(matches!(&rows[1], GridRow::Icons(icons) if icons.len() == 9));
        let offsets = row_offsets(&rows);
        assert_eq!(offsets[1], 26.0);
        assert_eq!(offsets[2], 58.0);
        let found = picker_sections(PickerTab::Emoji, &search_terms("cat"), symbols());
        assert_eq!(found.len(), 1);
        assert!(first_match(&found).is_some());
    }

    #[test]
    fn scroll_starts_a_row_above_the_current_icon() {
        let sections = picker_sections(PickerTab::Symbols, &[], symbols());
        let rows = grid_rows(&sections);
        let offsets = row_offsets(&rows);
        assert_eq!(
            initial_scroll(&rows, &offsets, Some("symbol:house.fill")),
            0.0
        );
        assert_eq!(
            initial_scroll(&rows, &offsets, Some("symbol:bolt.fill")),
            96.0
        );
        assert_eq!(shown_section(&[0.0, 100.0, 300.0], 99.5), 1);
        assert_eq!(shown_section(&[0.0, 100.0, 300.0], 5.0), 0);
    }

    #[test]
    fn placement_prefers_below_then_flips_up() {
        let room = Room {
            width: 1000.0,
            height: 800.0,
        };
        let anchor = Anchor {
            x: 100.0,
            y: 700.0,
            width: 20.0,
            height: 20.0,
        };
        let place = near_anchor(Some(anchor), 343.0, room);
        assert!(place.upward);
        assert_eq!(place.top, 700.0 - 6.0 - 343.0);
        assert_eq!(place.left, 8.0);
        let below = near_anchor(Some(Anchor { y: 40.0, ..anchor }), 343.0, room);
        assert!(!below.upward);
        assert_eq!(below.top, 66.0);
        let centered = near_anchor(None, 343.0, room);
        assert_eq!(centered.top, 14.0);
        assert_eq!(centered.left, 500.0 - 152.5);
        assert_eq!(clamp_top(700.0, 343.0, room), 449.0);
    }
}
