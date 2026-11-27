use ardia_state::tabs::Tab;
use ardia_theme::layout::panel;
use ardia_theme::tokens::popover_width;
use gpui::{AnyElement, IntoElement, ParentElement, SharedString, Styled, div};

use crate::msg::Msg;
use crate::scale::px;
use crate::site::parts::{PromptBody, emit_click, pill, prompt_body, prompt_popover};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const WIDTH: f32 = popover_width::M;

pub fn request_id(tab: &Tab, index: usize) -> String {
    format!("{}#{index}", tab.id)
}

pub fn close_with_downloads(c: &Chrome, page: Rect, count: usize) -> AnyElement {
    let body = prompt_body(
        c,
        PromptBody {
            icons: vec!["arrow.down.circle"],
            image: None,
            title: if count == 1 {
                SharedString::new_static("A download is still in progress")
            } else {
                format!("{count} downloads are still in progress").into()
            },
            message: Some("Closing this window cancels them.".into()),
            detail: Vec::new(),
            buttons: vec![
                pill(
                    c,
                    "close-downloads-cancel",
                    "Keep Window",
                    false,
                    emit_click(c, vec![Msg::ConfirmClose(false)]),
                ),
                pill(
                    c,
                    "close-downloads-confirm",
                    "Close Window",
                    true,
                    emit_click(c, vec![Msg::ConfirmClose(true)]),
                ),
            ],
        },
    );
    div()
        .absolute()
        .left(px(page.x + (page.w - WIDTH) / 2.0))
        .top(px(page.y + panel::POPOVER_MARGIN))
        .child(prompt_popover(
            c,
            "close-downloads",
            WIDTH,
            body,
            Some(emit_click(c, vec![Msg::ConfirmClose(false)])),
        ))
        .into_any_element()
}
