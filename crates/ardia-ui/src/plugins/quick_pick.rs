use std::sync::Arc;

use ardia_theme::tokens::{TypeSize, space};
use gpui::{
    AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString,
    Styled, Subscription, Window, div, prelude::*,
};

use super::dialog::dialog_frame;
use super::model::{PluginHost, QuickPickItem, QuickPickRequest};
use super::nodes::fuzzy_rank;
use super::surface::{badge, body, caption, empty_state, list_row, search_field, small};
use super::tokens::{dialog, overlay, surface, symbol};
use crate::look::Palette;
use crate::primitives::controls::{ButtonKind, PushButton};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput, focus_input};
use crate::primitives::virtual_list::{self, Align, VirtualItem, virtual_list};
use crate::scale::px;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuickPickModel {
    pub request: QuickPickRequest,
    pub query: String,
    pub highlight: usize,
    pub picked: Vec<String>,
    shown: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuickPickOutcome {
    Pending,
    Resolve(Option<Vec<String>>),
}

impl QuickPickModel {
    pub fn new(request: QuickPickRequest) -> Self {
        let picked = request
            .items
            .iter()
            .filter(|item| item.picked)
            .map(|item| item.id.clone())
            .collect();
        let shown = (0..request.items.len()).collect();
        QuickPickModel {
            request,
            query: String::new(),
            highlight: 0,
            picked,
            shown,
        }
    }

    pub fn many(&self) -> bool {
        self.request.options.can_pick_many
    }

    pub fn shown(&self) -> &[usize] {
        &self.shown
    }

    pub fn shown_item(&self, shown: usize) -> Option<&QuickPickItem> {
        self.shown
            .get(shown)
            .and_then(|&index| self.request.items.get(index))
    }

    fn rank(&mut self) {
        self.shown = fuzzy_rank(&self.request.items, &self.query, |item| {
            let mut fields = vec![Some(item.title.as_str()), item.subtitle.as_deref()];
            fields.extend(item.keywords.iter().map(|k| Some(k.as_str())));
            fields
        });
    }

    pub fn at(&self, shown: usize) -> usize {
        self.highlight.min(shown.saturating_sub(1))
    }

    pub fn set_query(&mut self, query: String) {
        self.query = query;
        self.highlight = 0;
        self.rank();
    }

    pub fn arrow(&mut self, step: i32) {
        let count = self.shown.len();
        if count == 0 {
            return;
        }
        let at = self.at(count) as i32;
        self.highlight = (at + step + count as i32).rem_euclid(count as i32) as usize;
    }

    pub fn confirm(&self) -> QuickPickOutcome {
        QuickPickOutcome::Resolve(Some(self.picked.clone()))
    }

    pub fn choose(&mut self, id: &str) -> QuickPickOutcome {
        if self.many() {
            match self.picked.iter().position(|known| known == id) {
                Some(at) => {
                    self.picked.remove(at);
                }
                None => self.picked.push(id.to_owned()),
            }
            QuickPickOutcome::Pending
        } else {
            QuickPickOutcome::Resolve(Some(vec![id.to_owned()]))
        }
    }

    pub fn submit(&mut self) -> QuickPickOutcome {
        if self.many() {
            return self.confirm();
        }
        match self.shown_item(self.at(self.shown.len())) {
            Some(item) => {
                let id = item.id.clone();
                self.choose(&id)
            }
            None => QuickPickOutcome::Pending,
        }
    }

    pub fn title(&self) -> Option<(String, Option<String>)> {
        let options = &self.request.options;
        let plugin = self.request.plugin_title.clone();
        match (&options.title, plugin) {
            (Some(title), plugin) => Some((title.clone(), plugin)),
            (None, Some(plugin)) => Some((plugin, None)),
            (None, None) => None,
        }
    }
}

pub struct QuickPickView {
    plugins: Arc<dyn PluginHost>,
    pub model: QuickPickModel,
    search: Entity<TextInput>,
    done: bool,
    p: Palette,
    list_key: SharedString,
    rows: Vec<VirtualItem>,
    revealed: Option<SharedString>,
    _subscription: Subscription,
}

fn rows_of(model: &QuickPickModel) -> Vec<VirtualItem> {
    model
        .shown()
        .iter()
        .map(|index| VirtualItem::new(index.to_string(), surface::ITEM_HEIGHT))
        .collect()
}

impl Drop for QuickPickView {
    fn drop(&mut self) {
        virtual_list::forget(&self.list_key);
    }
}

impl QuickPickView {
    pub fn new(
        plugins: Arc<dyn PluginHost>,
        request: QuickPickRequest,
        p: Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let placeholder = request
            .options
            .placeholder
            .clone()
            .unwrap_or_else(|| "Search".into());
        let style = InputStyle {
            text: p.text,
            placeholder: p.placeholder,
            caret: p.caret,
            selection: p.selection,
            font_size: TypeSize::Body.points(),
            weight: FontWeight::NORMAL,
        };
        let search = cx.new(|cx| {
            let mut input = TextInput::new(placeholder, cx);
            input.set_style(style, cx);
            input
        });
        focus_input(&search, window, cx);
        let subscription = cx.subscribe_in(&search, window, |view, input, event, _, cx| {
            let text = input.read(cx).text().to_owned();
            view.on_input(event, text, cx);
        });
        let list_key = SharedString::from(format!("quick-pick-list:{}", request.id));
        let model = QuickPickModel::new(request);
        let rows = rows_of(&model);
        QuickPickView {
            plugins,
            model,
            search,
            done: false,
            p,
            list_key,
            rows,
            revealed: None,
            _subscription: subscription,
        }
    }

    fn settle(&mut self, outcome: QuickPickOutcome, cx: &mut Context<Self>) {
        if let QuickPickOutcome::Resolve(picked) = outcome
            && !self.done
        {
            self.done = true;
            self.plugins
                .resolve_quick_pick(self.model.request.id, picked);
        }
        cx.notify();
    }

    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        self.settle(QuickPickOutcome::Resolve(None), cx);
    }

    fn on_input(&mut self, event: &InputEvent, text: String, cx: &mut Context<Self>) {
        match event {
            InputEvent::Changed { .. } => {
                if text != self.model.query {
                    self.model.set_query(text);
                    self.rows = rows_of(&self.model);
                } else {
                    self.model.highlight = 0;
                }
            }
            InputEvent::Up => self.model.arrow(-1),
            InputEvent::Down => self.model.arrow(1),
            InputEvent::Submit(_) => {
                let outcome = self.model.submit();
                return self.settle(outcome, cx);
            }
            InputEvent::Cancel => return self.cancel(cx),
            InputEvent::Tab => {}
        }
        cx.notify();
    }

    fn row(&self, item: &QuickPickItem, highlighted: bool, cx: &mut Context<Self>) -> AnyElement {
        let p = self.p;
        let checked = self
            .model
            .many()
            .then(|| self.model.picked.contains(&item.id));
        let id = item.id.clone();
        list_row(
            SharedString::from(format!("quick-pick:{}", item.id)),
            highlighted,
            surface::ITEM_HEIGHT,
            &p,
        )
        .on_click(cx.listener(move |view, _, _, cx| {
            let outcome = view.model.choose(&id);
            view.settle(outcome, cx);
        }))
        .when_some(checked, |this, checked| {
            this.child(if checked {
                glyph_box(Icon::CheckCircleFill, p.form_accent)
            } else {
                div()
                    .size(px(surface::ICON_BOX))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(crate::primitives::icons::symbol_icon(
                        "circle",
                        Icon::Dot,
                        surface::ICON,
                        p.text_tertiary,
                    ))
                    .into_any_element()
            })
        })
        .when_some(item.icon.clone(), |this, name| {
            this.child(
                div()
                    .size(px(surface::ICON_BOX))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(symbol(&name, surface::ICON, p.icon)),
            )
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(space::S))
                .child(body(item.title.clone(), p.text).truncate())
                .when_some(item.subtitle.clone(), |this, subtitle| {
                    this.child(small(subtitle, p.text_secondary).truncate())
                }),
        )
        .when_some(item.badge.clone(), |this, text| {
            this.child(badge(text, p.chip_fill, p.chip_text, false))
        })
        .into_any_element()
    }
}

fn glyph_box(glyph: Icon, color: gpui::Hsla) -> AnyElement {
    div()
        .size(px(surface::ICON_BOX))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .child(icon(glyph, surface::ICON, color))
        .into_any_element()
}

impl Render for QuickPickView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.p;
        if self.done {
            return div().into_any_element();
        }
        let at = self.model.at(self.rows.len());
        let highlighted = self.rows.get(at).map(|row| row.key.clone());
        let scroll = virtual_list::scroll_handle(self.list_key.clone());
        let list = virtual_list(self.list_key.clone(), &scroll)
            .items(self.rows.iter().cloned())
            .keep(highlighted.clone())
            .empty(|| empty_state("magnifyingglass", "No matches", None, &p))
            .render(|index, _| match self.model.shown_item(index) {
                Some(item) => self.row(item, index == at, cx),
                None => div().into_any_element(),
            });
        if self.revealed != highlighted {
            if let (Some(_), Some(key)) = (&self.revealed, &highlighted) {
                virtual_list::scroll_to(&self.list_key, key, Align::Nearest);
            }
            self.revealed = highlighted;
        }
        let title = self.model.title();
        let many = self.model.many();
        let count = self.model.picked.len();
        let content = div()
            .flex()
            .flex_col()
            .gap(px(space::S))
            .when_some(title, |this, (title, plugin)| {
                this.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(space::S))
                        .px(px(space::XS))
                        .child(
                            body(title, p.text)
                                .font_weight(FontWeight::SEMIBOLD)
                                .flex_1()
                                .truncate(),
                        )
                        .when_some(plugin, |this, plugin| {
                            this.child(caption(plugin, p.text_tertiary))
                        }),
                )
            })
            .child(search_field(self.search.clone(), &p))
            .child(
                div()
                    .id("quick-pick-list")
                    .max_h(px(overlay::QUICK_PICK_HEIGHT))
                    .overflow_y_scroll()
                    .track_scroll(&scroll)
                    .child(list),
            )
            .when(many, |this| {
                this.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(space::S))
                        .child(caption(format!("{count} selected"), p.text_tertiary).flex_1())
                        .child(
                            PushButton::new("quick-pick-cancel", "Cancel", &p)
                                .on_click(cx.listener(|view, _, _, cx| view.cancel(cx))),
                        )
                        .child(
                            PushButton::new("quick-pick-done", "Done", &p)
                                .kind(ButtonKind::Primary)
                                .on_click(cx.listener(|view, _, _, cx| {
                                    let outcome = view.model.confirm();
                                    view.settle(outcome, cx);
                                })),
                        ),
                )
            });
        dialog_frame(
            "plugin-quick-pick",
            dialog::WIDTH_M,
            space::M,
            None,
            &p,
            content.into_any_element(),
            cx.listener(|view, _, _, cx| view.cancel(cx)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::model::QuickPickOptions;
    use ardia_state::WindowId;

    fn item(id: &str, title: &str, picked: bool) -> QuickPickItem {
        QuickPickItem {
            id: id.into(),
            title: title.into(),
            subtitle: None,
            icon: None,
            badge: None,
            keywords: Vec::new(),
            picked,
        }
    }

    fn request(many: bool) -> QuickPickRequest {
        QuickPickRequest {
            id: 7,
            plugin: "p".into(),
            plugin_title: Some("Plugin".into()),
            window: WindowId::new("w"),
            items: vec![
                item("a", "Apple", false),
                item("b", "Banana", true),
                item("c", "Cherry", false),
            ],
            options: QuickPickOptions {
                can_pick_many: many,
                ..QuickPickOptions::default()
            },
        }
    }

    #[test]
    fn single_pick_filters_wraps_and_resolves_the_highlight() {
        let mut model = QuickPickModel::new(request(false));
        assert_eq!(model.title(), Some(("Plugin".into(), None)));
        model.arrow(-1);
        assert_eq!(model.highlight, 2);
        model.set_query("an".into());
        assert_eq!(model.highlight, 0);
        assert_eq!(model.shown().len(), 1);
        assert_eq!(
            model.submit(),
            QuickPickOutcome::Resolve(Some(vec!["b".into()]))
        );
        model.set_query("zzz".into());
        assert_eq!(model.submit(), QuickPickOutcome::Pending);
    }

    #[test]
    fn many_pick_toggles_and_confirms_in_pick_order() {
        let mut model = QuickPickModel::new(request(true));
        assert_eq!(model.picked.len(), 1);
        assert_eq!(model.choose("c"), QuickPickOutcome::Pending);
        assert_eq!(model.choose("a"), QuickPickOutcome::Pending);
        assert_eq!(model.choose("b"), QuickPickOutcome::Pending);
        assert_eq!(
            model.submit(),
            QuickPickOutcome::Resolve(Some(vec!["c".into(), "a".into()]))
        );
    }
}
