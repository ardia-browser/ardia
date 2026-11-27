use std::cell::RefCell;
use std::collections::HashMap;

use crate::scale::px;
use ardia_state::tabs::Tab;
use ardia_state::{BrowserState, TabId};
use gpui::{
    AnchoredPositionMode, AnyElement, App, Bounds, Context, Entity, FontWeight, Hsla, IntoElement,
    MouseButton, ParentElement, Pixels, Render, RenderOnce, Styled, Window, anchored, canvas,
    deferred, div, point, prelude::*,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::look::Palette;
use crate::msg::{Emit, Msg};
use crate::primitives::controls::{shadow, text_field_box};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput};
use crate::primitives::theme_bridge::hsla;
use crate::window::chrome::Chrome;

pub const MAX: usize = 2;
pub const MAX_LENGTH: usize = 24;
pub const WIDTH: f32 = 236.0;
pub const PAD: f32 = 8.0;
pub const GAP: f32 = 8.0;
pub const ANCHOR_GAP: f32 = 6.0;
pub const WINDOW_MARGIN: f32 = 8.0;
pub const RADIUS: f32 = 16.0;
const SECOND_LEVEL: [&str; 9] = ["co", "com", "net", "org", "gov", "edu", "ac", "ne", "or"];
const SECOND_LEVEL_GO: &str = "go";

fn is_invisible(ch: char) -> bool {
    matches!(ch as u32,
        0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F | 0x2800 | 0x3164
        | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFF8 | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0000..=0xE0FFF)
}

fn is_unseen(ch: char) -> bool {
    ch.is_whitespace()
        || ch.is_control()
        || matches!(ch as u32, 0x180E | 0xFEFF | 0xE000..=0xF8FF | 0xF0000..=0x10FFFF)
}

fn is_letter(ch: char) -> bool {
    ch.is_alphabetic() && !matches!(ch as u32, 0x115F | 0x1160 | 0x3164 | 0xFFA0)
}

fn first_letter(text: &str) -> Option<String> {
    text.chars()
        .find(|c| is_letter(*c))
        .map(|c| c.to_uppercase().collect())
}

fn site_name(host: &str) -> String {
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() < 2 {
        return host.to_owned();
    }
    let second = labels[labels.len() - 2];
    let suffix =
        if labels.len() > 2 && (SECOND_LEVEL.contains(&second) || second == SECOND_LEVEL_GO) {
            2
        } else {
            1
        };
    labels
        .get(labels.len() - 1 - suffix)
        .map_or_else(|| host.to_owned(), |l| (*l).to_owned())
}

pub fn tile_letter_of(url: &str, title: &str) -> String {
    let host = if url.is_empty() {
        String::new()
    } else {
        site_name(&ardia_state::omnibox::url::display_host(
            &ardia_state::omnibox::url::host_of(url),
        ))
    };
    let from_host = host
        .chars()
        .next()
        .filter(|c| is_letter(*c))
        .and_then(|_| first_letter(&host));
    from_host
        .or_else(|| first_letter(title))
        .unwrap_or_else(|| "•".to_owned())
}

fn clean_once(text: &str) -> String {
    let shown: String = text
        .chars()
        .filter(|c| !is_unseen(*c))
        .collect::<String>()
        .to_uppercase()
        .chars()
        .filter(|c| !is_unseen(*c))
        .collect();
    let mut kept = String::new();
    let mut count = 0;
    for cluster in shown.graphemes(true) {
        if count == MAX {
            break;
        }
        let Some(first) = cluster.chars().next() else {
            continue;
        };
        if first.is_control() || (is_invisible(first) && cluster.chars().count() == 1) {
            continue;
        }
        if !cluster.chars().any(|c| !is_invisible(c)) {
            continue;
        }
        if kept.encode_utf16().count() + cluster.encode_utf16().count() > MAX_LENGTH {
            break;
        }
        kept.push_str(cluster);
        count += 1;
    }
    kept
}

pub fn clean_tile_letters(input: &str) -> Option<String> {
    let window: String = input.graphemes(true).take(MAX_LENGTH * 64).collect();
    let mut kept = clean_once(&window);
    for _ in 0..4 {
        let again = clean_once(&kept);
        if again == kept {
            break;
        }
        kept = again;
    }
    (!kept.is_empty()).then_some(kept)
}

pub fn tile_letters_of(tab: &Tab) -> String {
    tab.tile_letters
        .as_deref()
        .and_then(clean_tile_letters)
        .unwrap_or_else(|| {
            tile_letter_of(&tab.url, tab.custom_title.as_deref().unwrap_or(&tab.title))
        })
}

pub fn shows_tile_letters(state: &BrowserState, tab: &Tab) -> bool {
    state.settings.minimalism_mode
        && state.settings.minimalism_pinned_icons
            == ardia_state::settings::MinimalismPinnedIcons::Letters
        && tab.pin.as_ref().is_some_and(|p| p.is_tile())
}

pub fn menu_items(
    state: &BrowserState,
    tab: &Tab,
) -> Vec<crate::popovers::context_menu::MenuEntry> {
    use crate::popovers::context_menu::MenuItem;
    use crate::primitives::icons::Icon;
    if !shows_tile_letters(state, tab) {
        return Vec::new();
    }
    let mut out = vec![
        MenuItem::new("letters", "Change Letters…")
            .icon(Icon::TextFormat)
            .msg(Msg::TileLetters(Some(tab.id.clone())))
            .entry(),
    ];
    if tab.tile_letters.is_some() {
        out.push(
            MenuItem::new("resetLetters", "Reset Letters")
                .icon(Icon::Undo)
                .msg(Msg::Count("tile_letters_reset"))
                .msg(Msg::Store(ardia_state::Action::SetTileLetters {
                    tab: tab.id.clone(),
                    letters: None,
                }))
                .entry(),
        );
    }
    out
}

pub fn letters_hint(draft: &str, site_letter: &str) -> String {
    match (!draft.trim().is_empty())
        .then(|| clean_tile_letters(draft))
        .flatten()
    {
        Some(shown) => format!("The tile shows “{shown}”."),
        None if site_letter.is_empty() => {
            format!("Up to {MAX}. Leave it empty for the site’s letter.")
        }
        None => format!("Up to {MAX}. Leave it empty for the site’s letter, “{site_letter}”."),
    }
}

pub fn place(anchor: Option<(f32, f32, f32, f32)>, room: (f32, f32), height: f32) -> (f32, f32) {
    let (x, y, w, h) = anchor.unwrap_or((room.0 / 2.0, WINDOW_MARGIN, 0.0, 0.0));
    let left = (x + w / 2.0 - WIDTH / 2.0)
        .min(room.0 - WINDOW_MARGIN - WIDTH)
        .max(WINDOW_MARGIN);
    let below = y + h + ANCHOR_GAP;
    let above = y - ANCHOR_GAP - height;
    let preferred = if below + height > room.1 - WINDOW_MARGIN && above >= WINDOW_MARGIN {
        above
    } else {
        below
    };
    let top = preferred
        .min(room.1 - WINDOW_MARGIN - height)
        .max(WINDOW_MARGIN);
    (top, left)
}

thread_local! {
    static OPEN: RefCell<HashMap<String, TabId>> = RefCell::new(HashMap::new());
    static ANCHORS: RefCell<HashMap<(String, TabId), Bounds<Pixels>>> = RefCell::new(HashMap::new());
}

pub fn open(window: &str, tab: Option<TabId>) {
    OPEN.with(|o| {
        let mut o = o.borrow_mut();
        match tab {
            Some(tab) => {
                o.insert(window.to_owned(), tab);
            }
            None => {
                o.remove(window);
            }
        }
    });
}

pub fn open_tab(window: &str) -> Option<TabId> {
    OPEN.with(|o| o.borrow().get(window).cloned())
}

pub fn anchor_probe(window: &str, tab: &TabId) -> AnyElement {
    let key = (window.to_owned(), tab.clone());
    canvas(
        move |bounds, _, _| {
            ANCHORS.with(|a| a.borrow_mut().insert(key.clone(), bounds));
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
    .into_any_element()
}

pub struct LettersView {
    window_key: String,
    tab: TabId,
    site_letter: String,
    input: Entity<TextInput>,
    emit: Emit,
    p: Palette,
    panel: Hsla,
    panel_border: Hsla,
    shadow_alpha: f32,
    _events: gpui::Subscription,
}

impl LettersView {
    fn close(&self, window: &mut Window) {
        open(&self.window_key, None);
        window.refresh();
    }

    fn commit(&self, window: &mut Window, cx: &mut App) {
        let text = self.input.read(cx).text().to_owned();
        let letters = clean_tile_letters(&text);
        ardia_telemetry::counts::count(if letters.is_some() {
            "tile_letters_set"
        } else {
            "tile_letters_reset"
        });
        self.emit.send(
            Msg::Store(ardia_state::Action::SetTileLetters {
                tab: self.tab.clone(),
                letters,
            }),
            window,
            cx,
        );
        self.close(window);
    }
}

impl Render for LettersView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.p;
        let draft = self.input.read(cx).text().to_owned();
        let pill = |id: &'static str, title: &'static str, primary: bool| {
            let fill: Hsla = if primary { p.accent } else { p.control };
            let ink: Hsla = if primary { p.on_accent } else { p.text };
            div()
                .id(id)
                .debug_selector(move || format!("tile-letters-{id}"))
                .h(px(24.))
                .px(px(12.))
                .rounded(px(12.))
                .bg(fill)
                .text_color(ink)
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .flex()
                .items_center()
                .cursor_pointer()
                .child(title)
        };
        div()
            .id("tile-letters")
            .debug_selector(|| "tile-letters".into())
            .occlude()
            .w(px(WIDTH))
            .p(px(PAD))
            .rounded(px(RADIUS))
            .bg(self.panel)
            .border(px(0.5))
            .border_color(self.panel_border)
            .shadow(vec![shadow(
                Hsla::black().opacity(self.shadow_alpha),
                8.,
                40.,
            )])
            .flex()
            .flex_col()
            .gap(px(GAP))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .text_size(px(12.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.text)
                    .child("Tile Letters"),
            )
            .child(text_field_box(&p, false).child(self.input.clone()))
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(p.text_tertiary)
                    .child(letters_hint(&draft, &self.site_letter)),
            )
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(6.))
                    .child(
                        pill("cancel", "Cancel", false)
                            .on_click(cx.listener(|view, _, window, _| view.close(window))),
                    )
                    .child(
                        pill("done", "Done", true)
                            .on_click(cx.listener(|view, _, window, cx| view.commit(window, cx))),
                    ),
            )
    }
}

pub fn tile_letters_panel(c: &Chrome) -> Option<AnyElement> {
    let key = c.window.id.as_str().to_owned();
    let tab_id = open_tab(&key)?;
    let tab = c.state.tab(tab_id.as_str())?.clone();
    let anchor = ANCHORS.with(|a| a.borrow().get(&(key.clone(), tab.id.clone())).copied());
    Some(
        LettersSlot {
            key,
            site_letter: tile_letter_of(
                &tab.url,
                tab.custom_title.as_deref().unwrap_or(&tab.title),
            ),
            own: tab.tile_letters.clone().unwrap_or_default(),
            tab: tab.id.clone(),
            anchor,
            emit: c.emit.clone(),
            p: *c.p,
            panel: hsla(c.look.theme.roles.panel),
            panel_border: hsla(c.look.theme.roles.panel_border),
            shadow_alpha: c.look.theme.roles.panel_shadow_opacity,
        }
        .into_any_element(),
    )
}

#[derive(IntoElement)]
struct LettersSlot {
    key: String,
    tab: TabId,
    site_letter: String,
    own: String,
    anchor: Option<Bounds<Pixels>>,
    emit: Emit,
    p: Palette,
    panel: Hsla,
    panel_border: Hsla,
    shadow_alpha: f32,
}

impl RenderOnce for LettersSlot {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state_key = gpui::ElementId::Name(
            format!("tile-letters:{}:{}", self.key, self.tab.as_str()).into(),
        );
        let LettersSlot {
            key,
            tab,
            site_letter,
            own,
            anchor,
            emit,
            p,
            panel,
            panel_border,
            shadow_alpha,
        } = self;
        let view: Entity<LettersView> = window.use_keyed_state(state_key, cx, {
            let key = key.clone();
            move |window, cx| {
                let input = cx.new(|cx| {
                    let mut input = TextInput::new(site_letter.clone(), cx);
                    input.set_style(
                        InputStyle {
                            text: p.text,
                            placeholder: p.placeholder,
                            caret: p.text,
                            selection: p.row_selected,
                            font_size: 13.0,
                            weight: FontWeight::NORMAL,
                        },
                        cx,
                    );
                    input.set_text(own, true, cx);
                    input
                });
                crate::primitives::text_input::focus_input(&input, window, cx);
                {
                    let events = cx.subscribe_in(
                        &input,
                        window,
                        |view: &mut LettersView, _, event: &InputEvent, window, cx| match event {
                            InputEvent::Submit(_) => view.commit(window, cx),
                            InputEvent::Cancel => view.close(window),
                            InputEvent::Changed { .. } => cx.notify(),
                            _ => {}
                        },
                    );
                    LettersView {
                        window_key: key,
                        tab,
                        site_letter,
                        input,
                        emit,
                        p,
                        panel,
                        panel_border,
                        shadow_alpha,
                        _events: events,
                    }
                }
            }
        });
        let room = (
            crate::scale::points(window.viewport_size().width),
            crate::scale::points(window.viewport_size().height),
        );
        let anchor_pts = anchor.map(|b| {
            (
                crate::scale::points(b.origin.x),
                crate::scale::points(b.origin.y),
                crate::scale::points(b.size.width),
                crate::scale::points(b.size.height),
            )
        });
        let (top, left) = place(anchor_pts, room, PANEL_HEIGHT);
        let scale = crate::scale::current();
        let scrim_key = key;
        deferred(
            div()
                .id("tile-letters-scrim")
                .absolute()
                .top_0()
                .left_0()
                .w(window.viewport_size().width)
                .h(window.viewport_size().height)
                .on_mouse_down(MouseButton::Left, move |_, w, _| {
                    open(&scrim_key, None);
                    w.refresh();
                })
                .child(
                    anchored()
                        .position_mode(AnchoredPositionMode::Window)
                        .position(point(gpui::px(left * scale), gpui::px(top * scale)))
                        .child(view),
                ),
        )
        .with_priority(3)
    }
}

pub const PANEL_HEIGHT: f32 = 132.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_site_letter_comes_from_the_registrable_name() {
        assert_eq!(tile_letter_of("https://mail.google.com/", "Inbox"), "G");
        assert_eq!(tile_letter_of("https://www.bbc.co.uk/news", "News"), "B");
        assert_eq!(tile_letter_of("", "hello"), "H");
        assert_eq!(tile_letter_of("", "123"), "•");
    }

    #[test]
    fn letters_are_cleaned_to_two_visible_uppercase_clusters() {
        assert_eq!(clean_tile_letters("ab c"), Some("AB".into()));
        assert_eq!(clean_tile_letters("  "), None);
        assert_eq!(clean_tile_letters("x\u{200B}y"), Some("XY".into()));
        assert_eq!(clean_tile_letters("👍🏽ok"), Some("👍🏽O".into()));
    }

    #[test]
    fn the_hint_names_what_the_tile_will_show() {
        assert_eq!(letters_hint("gh", "G"), "The tile shows “GH”.");
        assert_eq!(
            letters_hint("", "G"),
            "Up to 2. Leave it empty for the site’s letter, “G”."
        );
    }

    #[test]
    fn the_panel_sits_under_its_tile_and_flips_above_near_the_bottom() {
        assert_eq!(
            place(Some((10., 60., 55., 41.)), (800., 600.), 132.),
            (107., 8.)
        );
        let (top, _) = place(Some((10., 500., 55., 41.)), (800., 600.), 132.);
        assert_eq!(top, 500. - 6. - 132.);
    }
}
