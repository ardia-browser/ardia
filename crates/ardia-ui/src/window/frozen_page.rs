use std::sync::Arc;

use ardia_state::model::PageKind;
use ardia_state::tabs::Tab;
use ardia_state::{Action, TabId};
use gpui::{AnyElement, Image, ObjectFit, div, img, prelude::*};

use crate::msg::Msg;
use crate::scale::px;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;
use crate::window::page_overlays::window_colors;

pub const BRING_HERE_LABEL: &str = "Bring this tab to this window";

pub fn is_frozen(tab: &Tab) -> bool {
    matches!(tab.page.kind, PageKind::Frozen { .. })
}

fn still(picture: Option<Arc<Image>>) -> Option<AnyElement> {
    picture.map(|image| {
        img(image)
            .absolute()
            .inset_0()
            .size_full()
            .object_fit(ObjectFit::Cover)
            .debug_selector(|| "ardia.pagePicture".into())
            .into_any_element()
    })
}

pub fn frozen_page(c: &Chrome, tab: &TabId, picture: Option<Arc<Image>>) -> AnyElement {
    let wash = window_colors(c.look.dark).frozen_wash;
    let tab = tab.clone();
    div()
        .id("frozen-page")
        .debug_selector(|| "frozen-page".into())
        .absolute()
        .inset_0()
        .size_full()
        .overflow_hidden()
        .on_click(c.emit.click(Msg::Store(Action::ActivateTab { tab })))
        .children(still(picture))
        .child(div().absolute().inset_0().bg(wash))
        .into_any_element()
}

pub fn bridge_layer(c: &Chrome, page: Rect, picture: Arc<Image>) -> AnyElement {
    let wash = window_colors(c.look.dark).frozen_wash;
    div()
        .absolute()
        .left(px(page.x))
        .top(px(page.y))
        .w(px(page.w))
        .h(px(page.h))
        .overflow_hidden()
        .debug_selector(|| "frozen-bridge".into())
        .children(still(Some(picture)))
        .child(div().absolute().inset_0().bg(wash))
        .into_any_element()
}
