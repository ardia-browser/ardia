use ardia_state::TabId;
use ardia_theme::tokens::space;
use gpui::{
    AnimationExt, AnyElement, App, FontWeight, IntoElement, ParentElement, RenderOnce,
    SharedString, Styled, TextRun, Window, div, font, prelude::*,
};

use crate::look::UI_FONT;
use crate::msg::Msg;
use crate::primitives::controls::glass_panel;
use crate::primitives::tokens::type_size;
use crate::scale::px;
use crate::site::SiteMsg;
use crate::site::model::{self, PageSelection, SiteAnswer, selection_place};
use crate::site::parts::{self, Chip, chip_button};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub fn search_label_width(window: &mut Window) -> f32 {
    let text = SharedString::new_static("Search");
    let mut style = font(UI_FONT);
    style.weight = FontWeight::MEDIUM;
    let run = TextRun {
        len: text.len(),
        font: style,
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    f32::from(
        window
            .text_system()
            .shape_line(text, px(type_size::BODY), std::slice::from_ref(&run), None)
            .width,
    )
}

pub fn bar_width(label: f32) -> f32 {
    space::XS * 2.0 + space::M * 2.0 + 16.0 + space::XS + label
}

#[derive(IntoElement)]
pub struct SelectionBar {
    body: AnyElement,
    selection: PageSelection,
    zoom: f32,
    page: Rect,
    key: SharedString,
}

impl RenderOnce for SelectionBar {
    fn render(self, window: &mut Window, _: &mut App) -> impl IntoElement {
        let width = bar_width(search_label_width(window));
        let Some(place) = selection_place(
            self.selection.rect,
            self.zoom,
            (self.page.w, self.page.h),
            width,
        ) else {
            return div().into_any_element();
        };
        let lift = if place.above { 3.0 } else { -3.0 };
        div()
            .absolute()
            .left(px(self.page.x + place.x))
            .top(px(self.page.y + place.y))
            .child(
                div().child(self.body).with_animation(
                    gpui::ElementId::Name(self.key),
                    gpui::Animation::new(crate::primitives::tokens::duration::BASE)
                        .with_easing(|t| crate::primitives::tokens::Curve::Enter.ease(t)),
                    move |el, t| el.opacity(t).mt(px(lift * (1.0 - t))),
                ),
            )
            .into_any_element()
    }
}

pub fn selection_popover(
    c: &Chrome,
    tab: &TabId,
    zoom: f64,
    page: Rect,
    shown: Option<&(TabId, PageSelection)>,
) -> Option<AnyElement> {
    let (owner, selection) = shown?;
    if owner != tab || !c.state.settings.show_selection_search {
        return None;
    }
    let engine = c.state.default_search_engine().name;
    let quoted = model::quoted_selection(&selection.text);
    let text = selection.text.clone();
    let emit = c.emit.clone();
    let tab_id = tab.clone();
    let click: parts::Click = std::rc::Rc::new(move |event, window, cx| {
        let modifiers = event.modifiers();
        emit.send(
            Msg::Site(SiteMsg::Answer(
                tab_id.clone(),
                SiteAnswer::SearchSelection {
                    text: text.clone(),
                    platform: modifiers.platform,
                    shift: modifiers.shift,
                    alt: modifiers.alt,
                },
            )),
            window,
            cx,
        )
    });
    let chip = chip_button(
        c,
        Chip {
            id: "selection-search",
            icon: "magnifyingglass",
            title: "Search".into(),
            color: None,
            open: false,
            quiet: true,
            tooltip: Some(format!("Search {engine} for “{quoted}”").into()),
        },
        Some(click),
    );
    let body = glass_panel(
        "selection-bar",
        c.look.glass,
        ardia_theme::layout::panel::RADIUS,
        c.p,
    )
    .debug_selector(|| "selection-bar".into())
    .h(px(model::SELECTION_BAR_HEIGHT))
    .p(px(space::XS))
    .flex()
    .flex_row()
    .items_center()
    .child(chip)
    .into_any_element();
    Some(
        SelectionBar {
            body,
            selection: selection.clone(),
            zoom: zoom as f32,
            page,
            key: format!("selection-bar:{}:{}", selection.rect.x, selection.rect.y).into(),
        }
        .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bar_is_padded_around_the_chip() {
        assert_eq!(bar_width(40.0), 4.0 * 2.0 + 8.0 * 2.0 + 16.0 + 4.0 + 40.0);
    }
}
