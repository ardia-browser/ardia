use ardia_state::tabs::Tab;
use gpui::{
    AnyElement, ElementId, IntoElement, MouseButton, ParentElement, SharedString, Styled, canvas,
    div, point, prelude::*,
};

use super::model::{HostAction, PageBarButton, PageBarMatch};
use crate::content::developer_bar::{DevButton, DevIcon};
use crate::content::toolbar::{ToolbarInk, ink_for};
use crate::msg::Msg;
use crate::scale::px;
use crate::window::chrome::Chrome;

pub const HEIGHT: f32 = 34.0;
pub const BUTTON: f32 = 24.0;
pub const BUTTON_RADIUS: f32 = 6.0;
pub const URL_SIZE: f32 = 11.0;
pub const DIVIDER_LENGTH: f32 = 14.0;
pub const LEADING_EDGE: f32 = 7.0;
pub const TRAILING_EDGE: f32 = 5.0;
pub const URL_GAP: f32 = 6.0;
pub const GROUP_GAP: f32 = 7.5;
pub const GLYPH: f32 = 15.0;
pub const EXTENSIONS_GLYPH: f32 = 14.0;
pub const FIELD_GLYPH: f32 = 13.0;
pub const STRIPE_PERIOD: f32 = 28.0;
pub const STRIPE_BAND: f32 = 14.0;
pub const LIGHT_INK_OPACITY: f32 = 0.025;
pub const DARK_INK_OPACITY: f32 = 0.035;
pub const FIELD_ACTIONS: [HostAction; 3] = [
    HostAction::Console,
    HostAction::Network,
    HostAction::Inspect,
];

pub fn usable(action: HostAction, webkit: bool, split_available: bool) -> bool {
    match action {
        HostAction::Console | HostAction::Inspect => !webkit,
        HostAction::Network => !webkit,
        HostAction::Split => split_available,
        HostAction::Address => false,
        _ => true,
    }
}

pub fn trimmed(buttons: &[PageBarButton]) -> Vec<PageBarButton> {
    let mut out: Vec<PageBarButton> = Vec::new();
    for button in buttons {
        if *button != PageBarButton::Divider
            || (!out.is_empty() && out.last() != Some(&PageBarButton::Divider))
        {
            out.push(*button);
        }
    }
    while out.last() == Some(&PageBarButton::Divider) {
        out.pop();
    }
    out
}

pub fn shown_buttons(
    buttons: &[PageBarButton],
    webkit: bool,
    split_available: bool,
) -> Vec<PageBarButton> {
    let kept: Vec<PageBarButton> = buttons
        .iter()
        .copied()
        .filter(|b| match b {
            PageBarButton::Divider => true,
            PageBarButton::Action(action) => usable(*action, webkit, split_available),
        })
        .collect();
    trimmed(&kept)
}

pub fn split_at_address(
    buttons: &[PageBarButton],
) -> (Vec<PageBarButton>, bool, Vec<PageBarButton>) {
    match buttons
        .iter()
        .position(|b| *b == PageBarButton::Action(HostAction::Address))
    {
        None => (Vec::new(), false, buttons.to_vec()),
        Some(at) => (buttons[..at].to_vec(), true, buttons[at + 1..].to_vec()),
    }
}

pub fn without_user_info(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_owned();
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    match rest[..end].rfind('@') {
        Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
        None => url.to_owned(),
    }
}

fn action_icon(action: HostAction) -> (DevIcon, f32) {
    match action {
        HostAction::SiteControls => (DevIcon::Info, GLYPH),
        HostAction::CopyLink | HostAction::Address => (DevIcon::Link, GLYPH),
        HostAction::Console => (DevIcon::Console, GLYPH),
        HostAction::Network => (DevIcon::Network, GLYPH),
        HostAction::Inspect => (DevIcon::Inspect, GLYPH),
        HostAction::Split => (DevIcon::Split, GLYPH),
        HostAction::Extensions => (DevIcon::Extensions, EXTENSIONS_GLYPH),
    }
}

pub fn stripes(light_ink: bool) -> AnyElement {
    let color = if light_ink {
        gpui::white().opacity(LIGHT_INK_OPACITY)
    } else {
        gpui::black().opacity(DARK_INK_OPACITY)
    };
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let width = f32::from(bounds.size.width);
            let height = f32::from(bounds.size.height);
            let mut x0 = -height - STRIPE_PERIOD;
            while x0 < width {
                let mut builder = gpui::PathBuilder::fill();
                let at = |x: f32, y: f32| point(bounds.origin.x + px(x), bounds.origin.y + px(y));
                builder.move_to(at(x0, 0.0));
                builder.line_to(at(x0 + STRIPE_BAND, 0.0));
                builder.line_to(at(x0 + STRIPE_BAND + height, height));
                builder.line_to(at(x0 + height, height));
                builder.close();
                if let Ok(path) = builder.build() {
                    window.paint_path(path, color);
                }
                x0 += STRIPE_PERIOD;
            }
        },
    )
    .absolute()
    .inset_0()
    .into_any_element()
}

pub fn press_field(action: HostAction) -> &'static str {
    match action {
        HostAction::SiteControls => "plugin_page_bar_press_site_controls",
        HostAction::Address => "plugin_page_bar_press_address",
        HostAction::CopyLink => "plugin_page_bar_press_copy_link",
        HostAction::Console => "plugin_page_bar_press_console",
        HostAction::Network => "plugin_page_bar_press_network",
        HostAction::Inspect => "plugin_page_bar_press_inspect",
        HostAction::Extensions => "plugin_page_bar_press_extensions",
        HostAction::Split => "plugin_page_bar_press_split",
    }
}

pub fn action_msgs(c: &Chrome, tab: &Tab, action: HostAction) -> Vec<Msg> {
    let activate = Msg::Store(ardia_state::Action::ActivateTab {
        tab: tab.id.clone(),
    });
    match action {
        HostAction::SiteControls => vec![Msg::TogglePopover(
            ardia_state::windows::Popover::SiteControls,
        )],
        HostAction::Address => vec![Msg::OpenCommandPanel {
            new_tab: false,
            text: None,
        }],
        HostAction::CopyLink => vec![Msg::command("copyUrl")],
        HostAction::Console => vec![activate, Msg::command("javaScriptConsole")],
        HostAction::Network => vec![activate, Msg::command("devTools")],
        HostAction::Inspect => vec![activate, Msg::command("inspectElements")],
        HostAction::Extensions => vec![Msg::TogglePopover(
            ardia_state::windows::Popover::Extensions,
        )],
        HostAction::Split => vec![Msg::Store(ardia_state::Action::OpenSplitPane {
            window: c.window.id.clone(),
            side: ardia_state::splits::SplitSide::Right,
            url: None,
        })],
    }
}

fn hint_of(c: &Chrome, action: HostAction) -> Option<String> {
    let id = match action {
        HostAction::CopyLink => "copyUrl",
        HostAction::Console => "javaScriptConsole",
        HostAction::Inspect => "inspectElements",
        _ => return None,
    };
    crate::keybindings::hint(c.state, id)
}

pub fn buttons_row(
    c: &Chrome,
    tab: &Tab,
    buttons: &[PageBarButton],
    ink: ToolbarInk,
    field: Option<(f32, f32)>,
) -> AnyElement {
    let p = *c.p;
    let webkit = false;
    let split_available = true;
    let site_open =
        c.window.chrome.popover.as_ref() == Some(&ardia_state::windows::Popover::SiteControls);
    let shown = shown_buttons(buttons, webkit, split_available);
    div()
        .flex()
        .items_center()
        .children(shown.into_iter().enumerate().filter_map(|(index, button)| {
            match button {
                PageBarButton::Divider => Some(
                    div()
                        .flex_none()
                        .mx(px(GROUP_GAP))
                        .w(px(0.5))
                        .h(px(DIVIDER_LENGTH))
                        .bg(ink.divider)
                        .into_any_element(),
                ),
                PageBarButton::Action(HostAction::Address) => None,
                PageBarButton::Action(action) => {
                    let (icon, glyph) = action_icon(action);
                    Some(
                        DevButton {
                            id: ElementId::Name(SharedString::from(format!(
                                "page-bar-{index}-{}",
                                action.name()
                            ))),
                            icon,
                            glyph: if field.is_some() { FIELD_GLYPH } else { glyph },
                            square: field.map_or(BUTTON, |(square, _)| square),
                            radius: field.map_or(BUTTON_RADIUS, |(_, radius)| radius),
                            ink,
                            toggled: action == HostAction::SiteControls && site_open,
                            tip: crate::content::find_bar::with_shortcut(
                                action.title(),
                                hint_of(c, action),
                            ),
                            p,
                            msgs: std::iter::once(Msg::Count(press_field(action)))
                                .chain(action_msgs(c, tab, action))
                                .collect(),
                            emit: c.emit.clone(),
                        }
                        .render(),
                    )
                }
            }
        }))
        .into_any_element()
}

pub fn page_bar(c: &Chrome, tab: &Tab, bar: &PageBarMatch, width: f32) -> AnyElement {
    let ink = ink_for(c, Some(tab));
    let (leading, has_address, trailing) = split_at_address(&bar.buttons);
    let light_ink = ink.text.l > 0.5;
    let menu_emit = c.emit.clone();
    let menu_tab = tab.id.clone();
    let label = div()
        .id("plugin-page-bar-address")
        .flex_1()
        .min_w_0()
        .h(px(BUTTON))
        .pl(px(URL_GAP))
        .pr(px(GROUP_GAP))
        .flex()
        .items_center()
        .overflow_hidden()
        .whitespace_nowrap()
        .font_family("Menlo")
        .text_size(px(URL_SIZE))
        .text_color(ink.text)
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            cx.stop_propagation();
            let paste = cx
                .read_from_clipboard()
                .and_then(|item| item.text())
                .and_then(|text| ardia_state::omnibox::classify_paste(&text));
            menu_emit.send(
                Msg::Menu(Some((
                    crate::msg::MenuTarget::UrlBar(menu_tab.clone(), paste),
                    event.position,
                ))),
                window,
                cx,
            );
        })
        .when(has_address, |this| {
            this.cursor_pointer()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(c.emit.click(Msg::OpenCommandPanel {
                    new_tab: false,
                    text: None,
                }))
        })
        .child(
            div()
                .truncate()
                .child(SharedString::from(without_user_info(&bar.url))),
        );
    div()
        .id("plugin-page-bar")
        .debug_selector(|| "plugin-page-bar".into())
        .absolute()
        .left_0()
        .top_0()
        .w(px(width))
        .h(px(HEIGHT))
        .overflow_hidden()
        .when_some(ink.fill, |this, fill| this.bg(fill))
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count >= 2 {
                window.titlebar_double_click();
            } else {
                window.start_window_move();
            }
        })
        .child(stripes(light_ink))
        .child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .pl(px(LEADING_EDGE))
                .pr(px(TRAILING_EDGE))
                .when(!leading.is_empty(), |this| {
                    this.child(buttons_row(c, tab, &leading, ink, None))
                })
                .child(label)
                .child(buttons_row(c, tab, &trailing, ink, None)),
        )
        .child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .h(px(crate::content::toolbar::DIVIDER))
                .bg(ink.divider),
        )
        .into_any_element()
}

pub fn field_buttons_row(
    c: &Chrome,
    tab: &Tab,
    bar: &PageBarMatch,
    ink: ToolbarInk,
    square: f32,
    radius: f32,
) -> AnyElement {
    buttons_row(c, tab, &field_buttons(bar), ink, Some((square, radius)))
}

pub fn matched(c: &Chrome, tab: &Tab) -> Option<PageBarMatch> {
    c.host.plugins()?.page_bar(&c.window.id, &tab.id)
}

pub fn field_buttons(bar: &PageBarMatch) -> Vec<PageBarButton> {
    bar.buttons
        .iter()
        .copied()
        .filter(|b| matches!(b, PageBarButton::Action(a) if FIELD_ACTIONS.contains(a)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: PageBarButton = PageBarButton::Divider;
    fn a(action: HostAction) -> PageBarButton {
        PageBarButton::Action(action)
    }

    #[test]
    fn trims_dividers_and_hides_unusable_actions() {
        let buttons = vec![
            D,
            a(HostAction::SiteControls),
            D,
            D,
            a(HostAction::Console),
            D,
            a(HostAction::Address),
            D,
        ];
        assert_eq!(
            shown_buttons(&buttons, false, true),
            vec![a(HostAction::SiteControls), D, a(HostAction::Console)]
        );
        assert_eq!(
            shown_buttons(&buttons, true, true),
            vec![a(HostAction::SiteControls)]
        );
        let (lead, has, trail) = split_at_address(&[
            a(HostAction::CopyLink),
            a(HostAction::Address),
            a(HostAction::Split),
        ]);
        assert!(has);
        assert_eq!(lead, vec![a(HostAction::CopyLink)]);
        assert_eq!(trail, vec![a(HostAction::Split)]);
        assert_eq!(
            without_user_info("http://u:p@local:3000/x@y"),
            "http://local:3000/x@y"
        );
        assert_eq!(without_user_info("about:blank"), "about:blank");
        let bar = PageBarMatch {
            plugin: "dev".into(),
            url: "http://localhost".into(),
            at: 0,
            buttons: vec![
                a(HostAction::Console),
                a(HostAction::CopyLink),
                a(HostAction::Inspect),
            ],
        };
        assert_eq!(
            field_buttons(&bar),
            vec![a(HostAction::Console), a(HostAction::Inspect)]
        );
    }
}
