use crate::scale::px;
use ardia_state::tabs::Tab;
use ardia_theme::layout::panel;
use gpui::{AnyElement, IntoElement, ParentElement, Styled, div, prelude::*};

use ardia_state::Action;
use ardia_state::settings::SettingsPatch;
use serde_json::Value;

use crate::msg::Msg;
use crate::pages::reader;
use crate::primitives::controls::{IconButton, MenuRow, PushButton, separator};
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;

pub fn reader_rows(c: &Chrome, tab: &Tab) -> Vec<AnyElement> {
    let p = c.p;
    let status = c.host.reader_status(&tab.id);
    if !status.row_shown() || !reader::has_origin(&tab.url) {
        return Vec::new();
    }
    let emit = c.emit.clone();
    let mut rows = vec![
        separator(p).into_any_element(),
        MenuRow::new("site-reader", status.toggle_title(), p)
            .icon(Icon::DocPlaintext)
            .on_click(move |_, window, cx| {
                emit.send(Msg::CloseOverlays, window, cx);
                emit.send(Msg::command("toggleReader"), window, cx);
            })
            .into_any_element(),
    ];
    if status.active {
        rows.push(reader_text_row(c));
    }
    rows
}

fn reader_text_row(c: &Chrome) -> AnyElement {
    let p = c.p;
    let settings = &c.state.settings;
    let size = settings.reader_text_size;
    let font = settings.reader_font;
    let patch = |key: &str, value: Value| {
        Msg::Store(Action::UpdateSettings {
            patch: SettingsPatch::new().set(key, value),
            from_sync: false,
        })
    };
    let step = |delta: i32| {
        reader::stepped_reader_size(size, delta).map(|next| {
            patch(
                "readerTextSize",
                serde_json::to_value(next).unwrap_or_default(),
            )
        })
    };
    let (smaller, larger) = (step(-1), step(1));
    let look_change = |msg: Msg| {
        let send = c.emit.click(msg);
        move |event: &gpui::ClickEvent, window: &mut gpui::Window, cx: &mut gpui::App| {
            ardia_telemetry::counts::count("reader_look_changes");
            send(event, window, cx)
        }
    };
    div()
        .mx(px(panel::ROW_INSET))
        .px(px(panel::ROW_PADDING))
        .h(px(panel::ROW_HEIGHT))
        .flex()
        .items_center()
        .gap(px(panel::ICON_GAP))
        .text_size(px(13.))
        .child(
            div()
                .w(px(panel::ICON_SLOT))
                .flex()
                .justify_center()
                .child(icon(Icon::TextFormat, panel::ICON_SIZE, p.icon)),
        )
        .child(div().flex_1().child("Reader Text"))
        .child(
            IconButton::new("site-reader-smaller", Icon::Minus, p)
                .square(24., 6.)
                .glyph(10.)
                .tooltip("Smaller Text", p)
                .disabled(smaller.is_none())
                .when_some(smaller, |button, msg| button.on_click(look_change(msg))),
        )
        .child(
            IconButton::new("site-reader-larger", Icon::Plus, p)
                .square(24., 6.)
                .glyph(10.)
                .tooltip("Larger Text", p)
                .disabled(larger.is_none())
                .when_some(larger, |button, msg| button.on_click(look_change(msg))),
        )
        .child(
            PushButton::new("site-reader-font", reader::font_switch_title(font), p)
                .height(24.)
                .on_click(look_change(patch(
                    "readerFont",
                    serde_json::to_value(reader::other_reader_font(font)).unwrap_or_default(),
                ))),
        )
        .into_any_element()
}
