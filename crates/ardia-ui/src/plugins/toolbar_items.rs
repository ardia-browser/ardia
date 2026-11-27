use std::sync::Arc;

use ardia_state::WindowId;
use ardia_theme::tokens::TypeSize;
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, ParentElement, SharedString, Styled, div, prelude::*,
};

use super::model::{Anchor, PluginHost, Tone, ToolbarBadge, ToolbarEntry};
use super::shortcuts::{toolbar_badge_text, toolbar_badge_text_number};
use super::tokens::{icon_named, toolbar_item};
use crate::look::Palette;
use crate::primitives::controls::IconButton;
use crate::scale::px;

pub fn label_of(entry: &ToolbarEntry) -> Option<String> {
    entry
        .state
        .label
        .clone()
        .flatten()
        .filter(|label| !label.is_empty())
}

pub fn label_width(label: &str) -> f32 {
    toolbar_item::LABEL_MAX.min(
        (label.encode_utf16().count() as f32 * toolbar_item::LABEL_CHAR).ceil()
            + toolbar_item::LABEL_PAD * 2.0,
    )
}

fn item_width(entry: &ToolbarEntry, button: f32) -> f32 {
    button + label_of(entry).map_or(0.0, |label| label_width(&label) + toolbar_item::GAP * 2.0)
}

pub fn items_width(items: &[ToolbarEntry], button: f32) -> f32 {
    if items.is_empty() {
        return 0.0;
    }
    let total: f32 = items
        .iter()
        .map(|entry| item_width(entry, button) + toolbar_item::GAP)
        .sum();
    total - toolbar_item::GAP + toolbar_item::EDGE
}

fn tone_color(tone: Option<Tone>, p: &Palette) -> Option<Hsla> {
    match tone? {
        Tone::Accent => Some(p.accent),
        Tone::Success => Some(p.success),
        Tone::Warning => Some(p.warning),
        Tone::Destructive => Some(p.destructive),
        Tone::Default | Tone::Secondary | Tone::Tertiary => None,
    }
}

pub fn badge_text(badge: &ToolbarBadge) -> Option<String> {
    match badge {
        ToolbarBadge::Dot => None,
        ToolbarBadge::Count(0) => None,
        ToolbarBadge::Count(n) => Some(toolbar_badge_text_number(*n)),
        ToolbarBadge::Text(text) if text.is_empty() => None,
        ToolbarBadge::Text(text) => Some(toolbar_badge_text(text)),
    }
}

pub struct ToolbarPlace {
    pub top: f32,
    pub right: f32,
    pub viewport_width: f32,
    pub top_offset: f32,
    pub button: f32,
    pub pill: Hsla,
    pub ink: Hsla,
}

pub fn anchors(items: &[ToolbarEntry], place: &ToolbarPlace) -> Vec<Anchor> {
    let mut x =
        place.viewport_width - place.right - items_width(items, place.button) + toolbar_item::EDGE;
    items
        .iter()
        .map(|entry| {
            let anchor = Anchor {
                x,
                y: place.top + place.top_offset,
                width: place.button,
                height: place.button,
            };
            x += item_width(entry, place.button) + toolbar_item::GAP;
            anchor
        })
        .collect()
}

pub fn toolbar_items(
    plugins: &Arc<dyn PluginHost>,
    window: &WindowId,
    place: &ToolbarPlace,
    p: &Palette,
) -> Option<AnyElement> {
    if !plugins.window_eligible(window) {
        return None;
    }
    let items = plugins.toolbar_items();
    if items.is_empty() {
        return None;
    }
    let open = plugins.popover(window);
    let anchors = anchors(&items, place);
    Some(
        div()
            .debug_selector(|| "plugin-toolbar-items".into())
            .absolute()
            .top(px(place.top))
            .right(px(place.right))
            .flex()
            .items_center()
            .gap(px(toolbar_item::GAP))
            .children(items.iter().zip(anchors).map(|(entry, anchor)| {
                let active = open
                    .as_ref()
                    .is_some_and(|o| o.plugin == entry.plugin && o.item == entry.id);
                item_button(plugins, window, entry, anchor, active, place, p)
            }))
            .into_any_element(),
    )
}

fn item_button(
    plugins: &Arc<dyn PluginHost>,
    window: &WindowId,
    entry: &ToolbarEntry,
    anchor: Anchor,
    active: bool,
    place: &ToolbarPlace,
    p: &Palette,
) -> AnyElement {
    let state = &entry.state;
    let role = tone_color(state.tone, p);
    let glyph = state
        .icon
        .clone()
        .or_else(|| entry.icon.clone())
        .unwrap_or_else(|| "puzzlepiece".into());
    let tooltip = state
        .tooltip
        .clone()
        .flatten()
        .or_else(|| entry.tooltip.clone())
        .unwrap_or_else(|| entry.title.clone());
    let press = {
        let plugins = Arc::clone(plugins);
        let window = window.clone();
        let plugin = entry.plugin.clone();
        let item = entry.id.clone();
        move || plugins.run_toolbar_item(&window, &plugin, &item, anchor)
    };
    let press_label = press.clone();
    let badge_fill = role.unwrap_or(p.destructive);
    let badge = state.badge.clone().flatten();
    let label = label_of(entry);
    let key = format!("plugin-toolbar:{}", entry.key);
    div()
        .flex()
        .items_center()
        .child(
            div()
                .relative()
                .child(
                    IconButton::new(SharedString::from(key.clone()), icon_named(&glyph), p)
                        .square(place.button, ardia_theme::tokens::radius::TOOLBAR)
                        .glyph(toolbar_item::GLYPH)
                        .color(role.unwrap_or(p.icon))
                        .fills(p.toolbar_hover, p.toolbar_pressed)
                        .toggled(active.then_some(p.toolbar_pressed))
                        .tooltip(tooltip, p)
                        .on_click(move |_, _, _| press()),
                )
                .when_some(badge, |this, badge| match badge_text(&badge) {
                    None if badge == ToolbarBadge::Dot => this.child(
                        div()
                            .absolute()
                            .right(px(toolbar_item::LABEL_PAD))
                            .top(px(toolbar_item::LABEL_PAD))
                            .size(px(toolbar_item::DOT))
                            .rounded_full()
                            .bg(badge_fill),
                    ),
                    None => this,
                    Some(text) => this.child(
                        div()
                            .absolute()
                            .right(px(toolbar_item::BADGE_RIGHT))
                            .bottom(px(toolbar_item::BADGE_BOTTOM))
                            .child(super::surface::badge(text, badge_fill, p.on_accent, true)),
                    ),
                }),
        )
        .when_some(label, |this, label| {
            this.child(
                div()
                    .id(SharedString::from(format!("{key}:label")))
                    .ml(px(toolbar_item::GAP * 2.0))
                    .w(px(label_width(&label)))
                    .h(px(toolbar_item::GLYPH_BOX))
                    .px(px(toolbar_item::LABEL_PAD))
                    .rounded(px(toolbar_item::LABEL_PILL_RADIUS))
                    .bg(place.pill)
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .text_size(px(TypeSize::Caption.points()))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(role.unwrap_or(place.ink))
                    .on_click(move |_, _, _| press_label())
                    .child(div().truncate().child(label)),
            )
        })
        .into_any_element()
}

pub fn mount(
    c: &crate::window::chrome::Chrome,
    row: &ardia_theme::layout::toolbar::ToolbarRow,
    ink: &crate::content::toolbar::ToolbarInk,
    right: f32,
    pane_right: f32,
) -> Option<(AnyElement, f32)> {
    let plugins = c.host.plugins()?;
    let items = plugins.toolbar_items();
    if items.is_empty() || !plugins.window_eligible(&c.window.id) {
        return None;
    }
    let button = row.extension_button;
    let card = c.layout.card;
    let place = ToolbarPlace {
        top: row.center - button / 2.0,
        right,
        viewport_width: card.x + pane_right,
        top_offset: card.y,
        button,
        pill: ink.pill,
        ink: ink.text,
    };
    let width = items_width(&items, button);
    let element = toolbar_items(&plugins, &c.window.id, &place, c.p)?;
    Some((element, width))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::model::ToolbarUpdate;

    fn entry(label: Option<&str>) -> ToolbarEntry {
        ToolbarEntry {
            key: "p:i".into(),
            plugin: "p".into(),
            id: "i".into(),
            title: "Item".into(),
            icon: None,
            tooltip: None,
            state: ToolbarUpdate {
                label: Some(label.map(str::to_owned)),
                ..ToolbarUpdate::default()
            },
        }
    }

    #[test]
    fn widths_follow_the_old_toolbar_math() {
        assert_eq!(items_width(&[], 28.0), 0.0);
        assert_eq!(items_width(&[entry(None)], 28.0), 34.0);
        assert_eq!(label_width("abc"), 32.0);
        assert_eq!(label_width(&"x".repeat(40)), 96.0);
        assert_eq!(
            items_width(&[entry(Some("abc")), entry(None)], 28.0),
            28.0 + 36.0 + 2.0 + 28.0 + 6.0
        );
        assert_eq!(badge_text(&ToolbarBadge::Count(0)), None);
        assert_eq!(badge_text(&ToolbarBadge::Count(1200)), Some("999+".into()));
        assert_eq!(badge_text(&ToolbarBadge::Dot), None);
        let place = ToolbarPlace {
            top: 10.0,
            right: 100.0,
            viewport_width: 1000.0,
            top_offset: 0.0,
            button: 28.0,
            pill: gpui::transparent_black(),
            ink: gpui::transparent_black(),
        };
        let anchors = anchors(&[entry(None), entry(None)], &place);
        assert_eq!(anchors[0].x, 1000.0 - 100.0 - 64.0 + 6.0);
        assert_eq!(anchors[1].x, anchors[0].x + 30.0);
    }
}
