use std::collections::{HashMap, HashSet};

use crate::scale::px;
use ardia_state::omnibox::suggest::Suggestion;
use ardia_state::tabs::Tab;
use ardia_state::windows::CommandBarPlacementState;
use ardia_state::{Action, BrowserState, TabId};
use ardia_theme::FieldSurface;
use gpui::{
    AnyElement, Context, FontWeight, Hsla, IntoElement, MouseButton, ParentElement, SharedString,
    Styled, Subscription, Window, div, prelude::*,
};

use crate::msg::Msg;
use crate::omnibox::{CommandPanel, PanelRequest};
use crate::primitives::favicon::render_favicon;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::{InputEvent, InputStyle};
use crate::primitives::theme_bridge::hsla;
use crate::window::browser_window::BrowserWindowView;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const EMPTY_STATE_WIDTH: f32 = 420.0;
pub const SPLIT_ROW_HEIGHT: f32 = 36.0;
pub const SPLIT_ROW_RADIUS: f32 = 10.0;
pub const EMPTY_STATE_RADIUS: f32 = 16.0;
pub const PANE_PADDING: f32 = 16.0;
pub const PANEL_PADDING_Y: f32 = 10.0;
pub const HEADER_HEIGHT: f32 = 4.0 + 16.0 + 10.0 + SPLIT_ROW_HEIGHT;
pub const LIST_GAP: f32 = 6.0;
pub const SUGGESTED_TABS: usize = 5;
pub const TITLE: &str = "Add a tab to this Split View";
pub const SEARCH_PLACEHOLDER: &str = "Search or Ask a Question";

#[derive(Clone, Debug, PartialEq)]
pub enum SplitEmptyMsg {
    StartTyping,
    HoverTab(TabId),
    HoverItem(String),
    PickTab(TabId),
    PickItem(usize),
}

pub struct SplitEmptyPane {
    pub panel: CommandPanel,
    pub typing: bool,
    pub selected: Option<TabId>,
    pub picked: Option<String>,
    pub focused: bool,
    pub text: String,
    _input: Subscription,
}

impl SplitEmptyPane {
    pub fn typed(&self) -> String {
        self.text.trim().to_owned()
    }
}

#[derive(Default)]
pub struct SplitEmptyPanes {
    pub panes: HashMap<TabId, SplitEmptyPane>,
}

pub fn empty_state_fill(dark: bool) -> Hsla {
    if dark {
        gpui::Rgba {
            r: 34.0 / 255.0,
            g: 32.0 / 255.0,
            b: 33.0 / 255.0,
            a: 0.92,
        }
        .into()
    } else {
        gpui::white().opacity(0.92)
    }
}

pub fn split_suggestions(state: &BrowserState, tab: &TabId) -> Vec<TabId> {
    let Some(pane) = state.tab(tab.as_str()) else {
        return Vec::new();
    };
    let Some(window) = state.window(pane.window_id.as_str()) else {
        return Vec::new();
    };
    let in_split: HashSet<TabId> = state
        .split_of(tab.as_str())
        .map(|split| split.tab_ids().into_iter().collect())
        .unwrap_or_else(|| HashSet::from([tab.clone()]));
    let mut others: Vec<&std::sync::Arc<Tab>> = window
        .tab_ids
        .iter()
        .filter_map(|id| state.tab(id.as_str()))
        .filter(|t| {
            !t.url.is_empty() && t.profile_id == pane.profile_id && !in_split.contains(&t.id)
        })
        .collect();
    others.sort_by_key(|t| std::cmp::Reverse(t.last_active_at));
    others
        .into_iter()
        .take(SUGGESTED_TABS)
        .map(|t| t.id.clone())
        .collect()
}

fn trimmed(url: &str) -> &str {
    url.strip_suffix('/').unwrap_or(url)
}

pub fn ranked(items: &[Suggestion], pane_ids: &[TabId], typed: &str) -> Vec<Suggestion> {
    let typed_url =
        ardia_state::omnibox::url::fixup_url(typed.trim()).map(|u| trimmed(&u).to_owned());
    let mut seen = HashSet::new();
    items
        .iter()
        .filter_map(|s| {
            let row = match s {
                Suggestion::Page {
                    url,
                    tab_id: Some(id),
                    ..
                } if pane_ids.contains(id) => {
                    if typed_url.as_deref() == Some(trimmed(url)) {
                        let mut copy = s.clone();
                        if let Suggestion::Page { tab_id, .. } = &mut copy {
                            *tab_id = None;
                        }
                        copy
                    } else {
                        return None;
                    }
                }
                _ => s.clone(),
            };
            seen.insert(row.key()).then_some(row)
        })
        .collect()
}

pub fn rows_that_fit(pane_height: f32) -> usize {
    let room = pane_height - 2.0 * (PANE_PADDING + PANEL_PADDING_Y) - HEADER_HEIGHT - LIST_GAP;
    (room / SPLIT_ROW_HEIGHT).floor().max(0.0) as usize
}

pub fn tab_label(tab: &Tab) -> String {
    if let Some(custom) = tab.custom_title.as_deref().filter(|t| !t.is_empty()) {
        return custom.to_owned();
    }
    if tab.url.is_empty() {
        return "New Tab".to_owned();
    }
    if tab.url.starts_with("file:") {
        return if tab.title.is_empty() {
            tab.url.rsplit('/').next().unwrap_or_default().to_owned()
        } else {
            tab.title.clone()
        };
    }
    let host = ardia_state::omnibox::url::breadcrumb_host(&tab.url);
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    if host.is_empty() {
        if tab.title.is_empty() {
            tab.url.clone()
        } else {
            tab.title.clone()
        }
    } else {
        host
    }
}

pub fn moves_into_pane(state: &BrowserState, pane: &TabId, tab: &TabId) -> bool {
    let (Some(split), Some(p), Some(t)) = (
        state.split_of(pane.as_str()),
        state.tab(pane.as_str()),
        state.tab(tab.as_str()),
    ) else {
        return false;
    };
    !split.contains(tab.as_str()) && t.window_id == p.window_id && t.profile_id == p.profile_id
}

pub fn shows_split_empty(state: &BrowserState, tab: &Tab) -> bool {
    (tab.url.is_empty() || tab.url.starts_with("ardia://newtab"))
        && state.split_of(tab.id.as_str()).is_some()
}

impl BrowserWindowView {
    pub(crate) fn sync_split_empty(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let chrome_style = InputStyle {
            text: self.look.p.text,
            placeholder: self.look.p.placeholder,
            caret: hsla(self.look.theme.caret_color(FieldSurface::Field)),
            selection: self.look.p.selection,
            font_size: 15.0,
            weight: FontWeight::NORMAL,
        };
        let state = std::sync::Arc::clone(&self.state);
        let wanted: Vec<TabId> = self
            .active_tab()
            .and_then(|tab| state.split_of(tab.id.as_str()))
            .map(|split| split.tab_ids())
            .unwrap_or_default()
            .into_iter()
            .filter(|id| {
                state
                    .tab(id.as_str())
                    .is_some_and(|t| shows_split_empty(&state, t))
            })
            .collect();
        self.split_empty.panes.retain(|id, _| wanted.contains(id));
        let active = self.active_tab().map(|t| t.id.clone());
        for id in wanted {
            let focused = active.as_ref() == Some(&id);
            if !self.split_empty.panes.contains_key(&id) {
                let before = window.focused(cx);
                let mut panel = CommandPanel::new(cx);
                panel.prepare(
                    &state,
                    PanelRequest {
                        text: "",
                        new_tab: None,
                        placement: CommandBarPlacementState::Field,
                        style: chrome_style,
                    },
                    window,
                    cx,
                );
                panel.input.update(cx, |input, cx| {
                    input.set_placeholder(SEARCH_PLACEHOLDER, cx)
                });
                let tab = id.clone();
                let sub =
                    cx.subscribe_in(&panel.input, window, move |this, _, event, window, cx| {
                        this.on_split_empty_input(tab.clone(), event, window, cx)
                    });
                if !focused && let Some(before) = before {
                    window.focus(&before, cx);
                }
                self.split_empty.panes.insert(
                    id.clone(),
                    SplitEmptyPane {
                        panel,
                        typing: focused,
                        selected: None,
                        picked: None,
                        focused,
                        text: String::new(),
                        _input: sub,
                    },
                );
                continue;
            }
            let Some(pane) = self.split_empty.panes.get_mut(&id) else {
                continue;
            };
            let activated = focused && !pane.focused;
            pane.focused = focused;
            if activated {
                pane.typing = true;
                crate::primitives::text_input::focus_input(&pane.panel.input, window, cx);
            }
        }
    }

    fn split_empty_go(&mut self, tab: &TabId, window: &mut Window, cx: &mut Context<Self>) {
        let state = std::sync::Arc::clone(&self.state);
        let Some(pane) = self.split_empty.panes.get(tab) else {
            return;
        };
        let typed = pane.typed();
        let pane_ids = state
            .split_of(tab.as_str())
            .map(|s| s.tab_ids())
            .unwrap_or_default();
        let items = ranked(&pane.panel.result.items, &pane_ids, &typed);
        let index = pane
            .picked
            .as_ref()
            .and_then(|key| items.iter().position(|s| s.key() == *key))
            .unwrap_or(0);
        if !typed.is_empty() {
            if let Some(pick) = items.get(index).cloned() {
                self.split_empty_choose(tab, pick, window, cx);
            } else {
                self.host
                    .navigate(self.window_id.clone(), tab.clone(), typed);
            }
            return;
        }
        let suggestions = split_suggestions(&state, tab);
        if let Some(selected) = pane.selected.clone().filter(|s| suggestions.contains(s)) {
            ardia_telemetry::counts::count("split_suggestion_key_picks");
            self.host.dispatch(Action::ReplaceSplitPane {
                pane: tab.clone(),
                tab: selected,
            });
        }
    }

    fn split_empty_choose(
        &mut self,
        tab: &TabId,
        pick: Suggestion,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        ardia_telemetry::counts::count("split_pane_suggestion_picks");
        match pick {
            Suggestion::Page {
                tab_id: Some(target),
                url,
                ..
            } => {
                if moves_into_pane(&self.state, tab, &target) {
                    self.host.dispatch(Action::ReplaceSplitPane {
                        pane: tab.clone(),
                        tab: target,
                    });
                } else if self.state.tab(target.as_str()).is_some() {
                    self.host.dispatch(Action::ActivateTab { tab: target });
                } else {
                    self.host.navigate(self.window_id.clone(), tab.clone(), url);
                }
            }
            Suggestion::Calc { value, .. } => {
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(value.clone()));
                if let Some(pane) = self.split_empty.panes.get_mut(tab) {
                    pane.picked = None;
                    pane.text = value.clone();
                    pane.panel
                        .input
                        .update(cx, |input, cx| input.set_text(value, false, cx));
                }
            }
            Suggestion::Action { id, .. } => {
                self.handle(Msg::Command(SharedString::from(id)), window, cx);
            }
            other => {
                if let Some(url) = other.url() {
                    self.host
                        .navigate(self.window_id.clone(), tab.clone(), url.to_owned());
                }
            }
        }
        cx.notify();
    }

    fn split_empty_move(&mut self, tab: &TabId, step: i32) {
        let state = std::sync::Arc::clone(&self.state);
        let Some(pane) = self.split_empty.panes.get_mut(tab) else {
            return;
        };
        let typed = pane.typed();
        if !typed.is_empty() {
            let pane_ids = state
                .split_of(tab.as_str())
                .map(|s| s.tab_ids())
                .unwrap_or_default();
            let items = ranked(&pane.panel.result.items, &pane_ids, &typed);
            if items.is_empty() {
                pane.picked = None;
                return;
            }
            let at = pane
                .picked
                .as_ref()
                .and_then(|key| items.iter().position(|s| s.key() == *key))
                .unwrap_or(0) as i32;
            let next = (at + step).rem_euclid(items.len() as i32) as usize;
            pane.picked = Some(items[next].key());
            return;
        }
        let suggestions = split_suggestions(&state, tab);
        let stops = suggestions.len() as i32 + 1;
        let at = pane
            .selected
            .as_ref()
            .and_then(|s| suggestions.iter().position(|t| t == s))
            .map_or(-1, |i| i as i32);
        let next = (at + 1 + step).rem_euclid(stops) - 1;
        pane.selected = usize::try_from(next)
            .ok()
            .and_then(|i| suggestions.get(i).cloned());
    }

    pub(crate) fn on_split_empty_input(
        &mut self,
        tab: TabId,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Changed { deleting } => {
                let state = std::sync::Arc::clone(&self.state);
                let window_id = self.window_id.clone();
                if let Some(pane) = self.split_empty.panes.get_mut(&tab) {
                    pane.selected = None;
                    pane.picked = None;
                    pane.text = pane.panel.input.read(cx).text().to_owned();
                    pane.panel.refresh(
                        &state,
                        &window_id,
                        *deleting,
                        ardia_state::store::now_ms(),
                        cx,
                    );
                }
            }
            InputEvent::Submit(_) => self.split_empty_go(&tab, window, cx),
            InputEvent::Up => self.split_empty_move(&tab, -1),
            InputEvent::Down | InputEvent::Tab => self.split_empty_move(&tab, 1),
            InputEvent::Cancel => {
                let has_text = self
                    .split_empty
                    .panes
                    .get(&tab)
                    .is_some_and(|pane| !pane.typed().is_empty() || pane.selected.is_some());
                if has_text {
                    if let Some(pane) = self.split_empty.panes.get_mut(&tab) {
                        pane.selected = None;
                        pane.picked = None;
                        pane.text.clear();
                        pane.panel
                            .input
                            .update(cx, |input, cx| input.set_text("", false, cx));
                    }
                } else if self.state.split_of(tab.as_str()).is_some() {
                    ardia_telemetry::counts::count("split_empty_pane_escape_closes");
                    self.host
                        .dispatch(Action::RemoveEmptySplitPane { tab: tab.clone() });
                } else if let Some(pane) = self.split_empty.panes.get_mut(&tab) {
                    pane.typing = false;
                }
            }
        }
        cx.notify();
    }

    pub(crate) fn split_empty_msg(
        &mut self,
        tab: TabId,
        msg: SplitEmptyMsg,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match msg {
            SplitEmptyMsg::StartTyping => {
                if let Some(pane) = self.split_empty.panes.get_mut(&tab) {
                    pane.typing = true;
                    crate::primitives::text_input::focus_input(&pane.panel.input, window, cx);
                }
            }
            SplitEmptyMsg::HoverTab(id) => {
                if let Some(pane) = self.split_empty.panes.get_mut(&tab) {
                    pane.selected = Some(id);
                }
            }
            SplitEmptyMsg::HoverItem(key) => {
                if let Some(pane) = self.split_empty.panes.get_mut(&tab) {
                    pane.picked = Some(key);
                }
            }
            SplitEmptyMsg::PickTab(id) => {
                self.host
                    .dispatch(Action::ReplaceSplitPane { pane: tab, tab: id });
            }
            SplitEmptyMsg::PickItem(index) => {
                let state = std::sync::Arc::clone(&self.state);
                let pick = self.split_empty.panes.get(&tab).and_then(|pane| {
                    let pane_ids = state
                        .split_of(tab.as_str())
                        .map(|s| s.tab_ids())
                        .unwrap_or_default();
                    ranked(&pane.panel.result.items, &pane_ids, &pane.typed())
                        .get(index)
                        .cloned()
                });
                if let Some(pick) = pick {
                    self.split_empty_choose(&tab, pick, window, cx);
                }
            }
        }
        cx.notify();
    }
}

pub struct SplitEmptyView<'a> {
    pub pane: &'a SplitEmptyPane,
}

struct RowSpec {
    id: SharedString,
    leading: AnyElement,
    label: String,
    detail: Option<String>,
    secondary: bool,
    highlighted: bool,
    hover: Option<Msg>,
    press: Msg,
}

fn row(c: &Chrome, spec: RowSpec) -> AnyElement {
    let RowSpec {
        id,
        leading,
        label,
        detail,
        secondary,
        highlighted,
        hover,
        press,
    } = spec;
    let p = c.p;
    let (hover_fill, pressed_fill) = (p.row_hover, p.row_selected);
    let hover_emit = c.emit.clone();
    div()
        .id(id.clone())
        .debug_selector(move || id.to_string())
        .h(px(SPLIT_ROW_HEIGHT))
        .mx(px(6.))
        .px(px(10.))
        .rounded(px(SPLIT_ROW_RADIUS))
        .flex()
        .items_center()
        .gap(px(8.))
        .when(highlighted, |this| this.bg(hover_fill))
        .when(hover.is_none(), |this| {
            this.hover(move |s| s.bg(hover_fill))
        })
        .active(move |s| s.bg(pressed_fill))
        .when_some(hover, |this, msg| {
            this.on_hover(move |hovered, window, cx| {
                if *hovered {
                    hover_emit.send(msg.clone(), window, cx);
                }
            })
        })
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(c.emit.click(press))
        .child(leading)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_size(px(13.))
                .child(
                    div()
                        .flex_none()
                        .max_w_full()
                        .truncate()
                        .text_color(if secondary { p.text_secondary } else { p.text })
                        .child(label),
                )
                .when_some(detail, |this, detail| {
                    this.child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(p.text_tertiary)
                            .child(format!("\u{a0}\u{a0}{detail}")),
                    )
                }),
        )
        .into_any_element()
}

fn glyph_box(glyph: Icon, size: f32, tint: Hsla) -> AnyElement {
    div()
        .flex_none()
        .size(px(16.))
        .flex()
        .items_center()
        .justify_center()
        .child(icon(glyph, size, tint))
        .into_any_element()
}

pub fn split_empty_state(
    c: &Chrome,
    tab: &Tab,
    rect: Rect,
    view: SplitEmptyView<'_>,
) -> AnyElement {
    let p = c.p;
    let pane = view.pane;
    let typed_text = pane.typed();
    let typed = !typed_text.is_empty();
    let pane_ids = c
        .state
        .split_of(tab.id.as_str())
        .map(|s| s.tab_ids())
        .unwrap_or_default();
    let fits = rows_that_fit(rect.h);
    let items: Vec<Suggestion> = ranked(&pane.panel.result.items, &pane_ids, &typed_text)
        .into_iter()
        .take(fits)
        .collect();
    let suggestions = split_suggestions(c.state, &tab.id);
    let picked = pane
        .picked
        .as_ref()
        .and_then(|key| items.iter().position(|s| s.key() == *key))
        .unwrap_or(0);
    let selected = pane.selected.clone().filter(|s| suggestions.contains(s));
    let me = tab.id.clone();
    let msg = |m: SplitEmptyMsg| Msg::SplitEmpty {
        tab: me.clone(),
        msg: m,
    };
    let search = if pane.typing {
        div()
            .id("split-empty-field")
            .debug_selector(|| "split-empty-field".into())
            .h(px(SPLIT_ROW_HEIGHT))
            .mx(px(6.))
            .px(px(10.))
            .rounded(px(SPLIT_ROW_RADIUS))
            .bg(p.row_hover)
            .flex()
            .items_center()
            .gap(px(8.))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(glyph_box(Icon::Search, 13., p.text_secondary))
            .child(div().flex_1().min_w_0().child(pane.panel.input.clone()))
            .into_any_element()
    } else {
        row(
            c,
            RowSpec {
                id: "split-empty-search".into(),
                leading: glyph_box(Icon::Search, 13., p.text_secondary),
                label: SEARCH_PLACEHOLDER.to_owned(),
                detail: None,
                secondary: true,
                highlighted: false,
                hover: None,
                press: msg(SplitEmptyMsg::StartTyping),
            },
        )
    };
    let list: Vec<AnyElement> = if typed {
        items
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let (label, detail) = crate::omnibox::labels::suggestion_labels(s);
                row(
                    c,
                    RowSpec {
                        id: SharedString::from(format!("split-empty-item-{i}")),
                        leading: crate::omnibox::view::suggestion_icon(c, s, p.icon),
                        label,
                        detail,
                        secondary: false,
                        highlighted: i == picked,
                        hover: Some(msg(SplitEmptyMsg::HoverItem(s.key()))),
                        press: msg(SplitEmptyMsg::PickItem(i)),
                    },
                )
            })
            .collect()
    } else {
        suggestions
            .iter()
            .filter_map(|id| c.state.tab(id.as_str()))
            .map(|t| {
                let label = tab_label(t);
                let detail = (!t.title.is_empty() && t.title != label).then(|| t.title.clone());
                row(
                    c,
                    RowSpec {
                        id: SharedString::from(format!("split-empty-tab-{}", t.id)),
                        leading: render_favicon(&c.favicon(t), 16., p),
                        label,
                        detail,
                        secondary: false,
                        highlighted: selected.as_ref() == Some(&t.id),
                        hover: Some(msg(SplitEmptyMsg::HoverTab(t.id.clone()))),
                        press: msg(SplitEmptyMsg::PickTab(t.id.clone())),
                    },
                )
            })
            .collect()
    };
    let has_rows = !list.is_empty();
    div()
        .id(SharedString::from(format!("split-empty:{}", tab.id)))
        .debug_selector(|| "split-empty".into())
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .p(px(PANE_PADDING))
        .child(
            div()
                .id("split-empty-panel")
                .w_full()
                .max_w(px(EMPTY_STATE_WIDTH))
                .py(px(PANEL_PADDING_Y))
                .rounded(px(EMPTY_STATE_RADIUS))
                .bg(empty_state_fill(p.dark))
                .border(px(0.5))
                .border_color(p.ntp_bar_border)
                .shadow(vec![crate::primitives::controls::shadow(p.shadow, 6., 16.)])
                .text_color(p.text)
                .flex()
                .flex_col()
                .child(
                    div()
                        .px(px(16.))
                        .pt(px(4.))
                        .pb(px(10.))
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(TITLE),
                )
                .child(search)
                .when(has_rows, |this| this.child(div().h(px(LIST_GAP))))
                .children(list),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_fit_the_pane_height() {
        assert_eq!(rows_that_fit(100.0), 0);
        let tall = rows_that_fit(600.0);
        assert_eq!(tall, ((600.0 - 52.0 - HEADER_HEIGHT - 6.0) / 36.0) as usize);
    }

    #[test]
    fn panes_already_split_drop_out_unless_typed_exactly() {
        let page = |url: &str, tab: Option<&str>| Suggestion::Page {
            url: url.into(),
            title: String::new(),
            favicon: None,
            tab_id: tab.map(TabId::new),
            bookmarked: false,
            visited: false,
        };
        let items = vec![
            page("https://a.test/", Some("a")),
            page("https://b.test/", Some("b")),
            page("https://b.test/", Some("b")),
        ];
        let panes = vec![TabId::new("a")];
        let shown = ranked(&items, &panes, "b");
        assert_eq!(shown.len(), 1);
        let exact = ranked(&items, &panes, "https://a.test");
        assert!(matches!(&exact[0], Suggestion::Page { tab_id: None, .. }));
    }
}
