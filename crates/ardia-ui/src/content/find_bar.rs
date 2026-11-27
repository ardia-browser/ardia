use std::time::Duration;

use crate::scale::px;
use ardia_state::TabId;
use ardia_state::tabs::FindState;
use gpui::{
    Animation, AnimationExt, AnyElement, Entity, FontWeight, Hsla, IntoElement, ParentElement,
    SharedString, Styled, div, prelude::*,
};

use crate::host::ReplaceNote;
use crate::msg::{FindMsg, Msg};
use crate::primitives::controls::{IconButton, shadow};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::TextInput;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const FIND_WIDTH: f32 = 340.0;
pub const FIND_HEIGHT: f32 = 40.0;
pub const FIND_TOP: f32 = 10.0;
pub const FIND_RIGHT: f32 = 12.0;
pub const FIND_RADIUS: f32 = 12.0;
pub const FIND_FONT: f32 = 15.0;
pub const FIND_PLACEHOLDER: &str = "Find on Page";
pub const FIND_APPEAR: Duration = Duration::from_millis(150);
pub const FIND_APPEAR_RISE: f32 = 6.0;
const BUTTON_BOX: f32 = 26.0;
const BUTTON_GLYPH: f32 = 14.0;
const BUTTON_RADIUS: f32 = 4.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MatchCount {
    Hidden,
    NoResults,
    Counted { active: u32, count: u32 },
}

pub fn match_count(find: &FindState) -> MatchCount {
    match find.count {
        _ if find.query.is_empty() => MatchCount::Hidden,
        None => MatchCount::Hidden,
        Some(0) => MatchCount::NoResults,
        Some(count) => MatchCount::Counted {
            active: find.active.min(count),
            count,
        },
    }
}

pub fn appear_offset(progress: f32) -> f32 {
    -FIND_APPEAR_RISE * (1.0 - progress.clamp(0.0, 1.0))
}

fn divider(length: f32, color: Hsla) -> impl IntoElement {
    div().flex_none().w(px(1.)).h(px(length)).bg(color)
}

fn counter(find: &FindState, c: &Chrome) -> Option<AnyElement> {
    let p = c.p;
    match match_count(find) {
        MatchCount::Hidden => None,
        MatchCount::NoResults => Some(
            div()
                .flex_none()
                .mr(px(6.))
                .text_size(px(12.))
                .text_color(p.destructive)
                .child("No results")
                .into_any_element(),
        ),
        MatchCount::Counted { active, count } => Some(
            div()
                .flex_none()
                .mr(px(6.))
                .flex()
                .items_center()
                .gap(px(6.))
                .text_size(px(12.))
                .child(div().text_color(p.text).child(active.to_string()))
                .child(divider(12., p.divider))
                .child(div().text_color(p.text_secondary).child(count.to_string()))
                .into_any_element(),
        ),
    }
}

pub fn with_shortcut(title: &str, hint: Option<String>) -> SharedString {
    match hint {
        Some(hint) if !hint.is_empty() => SharedString::from(format!("{title} ({hint})")),
        _ => SharedString::from(title.to_owned()),
    }
}

fn find_button(id: &'static str, glyph: Icon, c: &Chrome) -> IconButton {
    IconButton::new(id, glyph, c.p)
        .square(BUTTON_BOX, BUTTON_RADIUS)
        .glyph(BUTTON_GLYPH)
}

pub const REPLACE_HEIGHT: f32 = 38.0;
pub const REPLACE_PLACEHOLDER: &str = "Replace";

pub struct ReplaceRow<'a> {
    pub input: &'a Entity<TextInput>,
    pub note: Option<ReplaceNote>,
}

fn text_button(
    id: &'static str,
    title: &'static str,
    enabled: bool,
    msg: Msg,
    c: &Chrome,
) -> AnyElement {
    let p = c.p;
    let hover = p.toolbar_hover;
    let pressed = p.toolbar_pressed;
    div()
        .id(id)
        .debug_selector(move || id.to_owned())
        .flex_none()
        .h(px(24.))
        .px(px(8.))
        .rounded(px(4.))
        .flex()
        .items_center()
        .text_size(px(13.))
        .text_color(if enabled {
            p.text
        } else {
            p.text.opacity(0.45)
        })
        .when(enabled, |this| {
            this.hover(move |style| style.bg(hover))
                .active(move |style| style.bg(pressed))
                .on_click(c.emit.click(msg))
        })
        .child(title)
        .into_any_element()
}

fn replace_row(c: &Chrome, row: ReplaceRow<'_>, has_query: bool, live: bool) -> AnyElement {
    let p = c.p;
    let note = row
        .note
        .filter(|note| note.shown_at(ardia_state::store::now_ms()));
    div()
        .h(px(REPLACE_HEIGHT))
        .pl(px(12.))
        .pr(px(6.))
        .flex()
        .items_center()
        .gap(px(4.))
        .child(
            div()
                .flex_none()
                .size(px(16.))
                .mr(px(4.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(Icon::SwapVertical, 14., p.text_secondary)),
        )
        .child(div().flex_1().min_w_0().child(if live {
            row.input.clone().into_any_element()
        } else {
            div()
                .text_size(px(FIND_FONT))
                .text_color(p.placeholder)
                .child(REPLACE_PLACEHOLDER)
                .into_any_element()
        }))
        .when_some(note, |this, note| {
            let remaining = (crate::host::REPLACE_NOTE_MS
                - (ardia_state::store::now_ms() - note.at_ms))
                .max(1) as u64;
            this.child(
                div()
                    .id(SharedString::from(format!(
                        "find-replace-note:{}",
                        note.at_ms
                    )))
                    .debug_selector(|| "find-replace-note".into())
                    .flex_none()
                    .mr(px(2.))
                    .text_size(px(12.))
                    .text_color(if note.error {
                        p.destructive
                    } else {
                        p.text_secondary
                    })
                    .child(note.text)
                    .with_animation(
                        SharedString::from(format!("find-replace-note-life:{}", note.at_ms)),
                        Animation::new(Duration::from_millis(remaining)),
                        |this, progress| {
                            if progress >= 1.0 {
                                this.opacity(0.).w(px(0.)).overflow_hidden()
                            } else {
                                this
                            }
                        },
                    ),
            )
        })
        .child(text_button(
            if live {
                "find-replace-one"
            } else {
                "find-replace-one-pane"
            },
            "Replace",
            has_query && live,
            Msg::Find(FindMsg::Replace { all: false }),
            c,
        ))
        .child(text_button(
            if live {
                "find-replace-all"
            } else {
                "find-replace-all-pane"
            },
            "All",
            has_query && live,
            Msg::Find(FindMsg::Replace { all: true }),
            c,
        ))
        .into_any_element()
}

pub struct FindPane<'a> {
    pub tab: &'a TabId,
    pub rect: Rect,
    pub input: Option<&'a Entity<TextInput>>,
}

fn shown_query(find: &FindState, p: &crate::look::Palette) -> AnyElement {
    let empty = find.query.is_empty();
    div()
        .text_size(px(FIND_FONT))
        .text_color(if empty { p.placeholder } else { p.text })
        .truncate()
        .child(if empty {
            SharedString::new_static(FIND_PLACEHOLDER)
        } else {
            SharedString::from(find.query.clone())
        })
        .into_any_element()
}

pub fn find_bar(
    c: &Chrome,
    pane: FindPane<'_>,
    find: &FindState,
    replace: Option<ReplaceRow<'_>>,
) -> AnyElement {
    let page = pane.rect;
    let live = pane.input.is_some();
    let p = c.p;
    let none = find.count.unwrap_or(0) == 0;
    let left = page.right() - FIND_RIGHT - FIND_WIDTH;
    let top = page.y + FIND_TOP;
    let has_query = !find.query.is_empty();
    let search = div()
        .h(px(FIND_HEIGHT))
        .pl(px(12.))
        .pr(px(4.))
        .flex()
        .items_center()
        .gap(px(2.))
        .child(
            div()
                .flex_none()
                .size(px(16.))
                .mr(px(4.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(Icon::Search, 15., p.text_secondary)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .font_weight(FontWeight::NORMAL)
                .child(match pane.input {
                    Some(input) => input.clone().into_any_element(),
                    None => shown_query(find, p),
                }),
        )
        .children(counter(find, c))
        .child(
            find_button("find-previous", Icon::ChevronUp, c)
                .disabled(none)
                .tooltip(
                    with_shortcut(
                        "Previous",
                        crate::keybindings::hint(c.state, "findPrevious"),
                    ),
                    p,
                )
                .on_click(c.emit.click(Msg::Find(FindMsg::Previous))),
        )
        .child(
            find_button("find-next", Icon::ChevronDown, c)
                .disabled(none)
                .tooltip(
                    with_shortcut("Next", crate::keybindings::hint(c.state, "findNext")),
                    p,
                )
                .on_click(c.emit.click(Msg::Find(FindMsg::Next))),
        )
        .child(div().mx(px(4.)).child(divider(18., p.divider)))
        .child(
            find_button("find-close", Icon::XMark, c)
                .tooltip("Done (Esc)", p)
                .on_click(c.emit.click(Msg::Find(FindMsg::Close))),
        );
    div()
        .id(SharedString::from(format!("find-bar:{}", pane.tab)))
        .relative()
        .occlude()
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down(gpui::MouseButton::Right, |_, _, cx| cx.stop_propagation())
        .rounded(px(FIND_RADIUS))
        .bg(p.panel)
        .border(px(0.5))
        .border_color(p.panel_border)
        .shadow(vec![shadow(p.shadow.opacity(0.8), 6., 16.)])
        .debug_selector(move || if live { "find-bar" } else { "find-bar-pane" }.into())
        .absolute()
        .top(px(top))
        .left(px(left))
        .w(px(FIND_WIDTH))
        .flex()
        .flex_col()
        .overflow_hidden()
        .text_color(p.text)
        .child(search)
        .when_some(replace.filter(|_| find.replace), |this, row| {
            this.child(div().w_full().h(px(1.)).bg(p.divider))
                .child(replace_row(c, row, has_query, live))
        })
        .with_animation(
            SharedString::from(format!("find-bar-appear:{}", pane.tab)),
            Animation::new(FIND_APPEAR)
                .with_easing(|t| ardia_theme::motion::ease_out_cubic(f64::from(t)) as f32),
            move |bar, progress| bar.opacity(progress).top(px(top + appear_offset(progress))),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(query: &str, count: Option<u32>, active: u32) -> FindState {
        FindState {
            open: true,
            query: query.into(),
            count,
            active,
            replace: false,
        }
    }

    #[test]
    fn the_counter_shows_active_and_count_or_no_results() {
        assert_eq!(
            match_count(&find("ardia", Some(12), 3)),
            MatchCount::Counted {
                active: 3,
                count: 12
            }
        );
        assert_eq!(
            match_count(&find("ardia", Some(0), 0)),
            MatchCount::NoResults
        );
        assert_eq!(match_count(&find("ardia", None, 0)), MatchCount::Hidden);
        assert_eq!(match_count(&find("", Some(4), 1)), MatchCount::Hidden);
    }

    #[test]
    fn the_bar_drops_in_six_points_while_it_fades() {
        assert_eq!(appear_offset(0.0), -6.0);
        assert_eq!(appear_offset(1.0), 0.0);
        assert!(appear_offset(0.5) < 0.0 && appear_offset(0.5) > -6.0);
    }
}
