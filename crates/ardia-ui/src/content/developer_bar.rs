use std::sync::{Arc, LazyLock};

use crate::scale::px;
use ardia_state::BrowserState;
use ardia_state::tabs::Tab;
use base64::Engine;
use gpui::{
    AnyElement, ElementId, Hsla, IntoElement, MouseButton, ParentElement, SharedString, Styled,
    div, prelude::*, svg,
};

use crate::content::toolbar::{ToolbarInk, ink_for};
use crate::look::Palette;
use crate::msg::{Emit, Msg};
use crate::primitives::controls::tooltip;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DevIcon {
    Info,
    Link,
    Console,
    Inspect,
    Network,
    Extensions,
    Split,
}

fn png(icon: DevIcon) -> &'static [u8] {
    match icon {
        DevIcon::Info => include_bytes!("../../assets/developer-bar/info.png"),
        DevIcon::Link => include_bytes!("../../assets/developer-bar/link.png"),
        DevIcon::Console => include_bytes!("../../assets/developer-bar/console.png"),
        DevIcon::Inspect => include_bytes!("../../assets/developer-bar/inspect.png"),
        DevIcon::Network => include_bytes!("../../assets/developer-bar/network.png"),
        DevIcon::Extensions => include_bytes!("../../assets/developer-bar/extensions.png"),
        DevIcon::Split => include_bytes!("../../assets/developer-bar/split.png"),
    }
}

const ALL: [DevIcon; 7] = [
    DevIcon::Info,
    DevIcon::Link,
    DevIcon::Console,
    DevIcon::Inspect,
    DevIcon::Network,
    DevIcon::Extensions,
    DevIcon::Split,
];

static MASKS: LazyLock<Vec<Arc<[u8]>>> = LazyLock::new(|| {
    ALL.iter()
        .map(|icon| {
            let data = base64::engine::general_purpose::STANDARD.encode(png(*icon));
            Arc::from(
                format!(
                    "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 45 45\"><image width=\"45\" height=\"45\" xlink:href=\"data:image/png;base64,{data}\"/></svg>"
                )
                .into_bytes(),
            )
        })
        .collect()
});

pub fn mask(icon: DevIcon) -> Arc<[u8]> {
    let at = ALL.iter().position(|i| *i == icon).unwrap_or(0);
    Arc::clone(&MASKS[at])
}

pub fn developer_host(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = if host.starts_with('[') {
        host.split(']').next().map(|h| format!("{h}]"))?
    } else {
        host.split(':').next()?.to_owned()
    };
    let host = host.trim_end_matches('.').to_owned();
    (!host.is_empty()).then_some(host)
}

pub fn developer_mode_on(state: &BrowserState, url: &str) -> bool {
    developer_host(url).is_some_and(|host| {
        state
            .settings
            .developer_mode_sites
            .get(&host)
            .copied()
            .unwrap_or(false)
    })
}

pub fn without_user_info(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_owned();
    };
    let valid = url[..scheme_end].chars().enumerate().all(|(i, ch)| {
        if i == 0 {
            ch.is_ascii_alphabetic()
        } else {
            ch.is_ascii_alphanumeric() || "+.-".contains(ch)
        }
    });
    if !valid || scheme_end == 0 {
        return url.to_owned();
    }
    let rest = &url[scheme_end + 3..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    match rest[..end].rfind('@') {
        Some(at) => format!("{}{}", &url[..scheme_end + 3], &rest[at + 1..]),
        None => url.to_owned(),
    }
}

pub fn middle_ellipsis(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars || max_chars < 3 {
        return text.to_owned();
    }
    let keep = max_chars - 1;
    let head = keep.div_ceil(2);
    let tail = keep - head;
    let start: String = text.chars().take(head).collect();
    let end: String = text.chars().skip(count - tail).collect();
    format!("{start}…{end}")
}

pub struct DevButton {
    pub id: ElementId,
    pub icon: DevIcon,
    pub glyph: f32,
    pub square: f32,
    pub radius: f32,
    pub ink: ToolbarInk,
    pub toggled: bool,
    pub tip: SharedString,
    pub p: Palette,
    pub msgs: Vec<Msg>,
    pub emit: Emit,
}

impl DevButton {
    pub fn render(self) -> AnyElement {
        let (hover, pressed) = (self.ink.hover, self.ink.pressed);
        let emit = self.emit;
        let msgs = self.msgs;
        div()
            .id(self.id)
            .flex_none()
            .size(px(self.square))
            .rounded(px(self.radius))
            .flex()
            .items_center()
            .justify_center()
            .when(self.toggled, move |this| this.bg(pressed))
            .hover(move |style| style.bg(hover))
            .active(move |style| style.bg(pressed))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(move |_, window, cx| {
                cx.stop_propagation();
                for msg in msgs.clone() {
                    emit.send(msg, window, cx);
                }
            })
            .tooltip(tooltip(self.tip, &self.p))
            .child(
                svg()
                    .data(&mask(self.icon))
                    .size(px(self.glyph))
                    .flex_none()
                    .text_color(self.ink.icon),
            )
            .into_any_element()
    }
}

pub fn tools_buttons(
    c: &Chrome,
    tab: &Tab,
    ink: ToolbarInk,
    square: f32,
    radius: f32,
    glyph: f32,
    focus: Option<Msg>,
) -> Vec<AnyElement> {
    let panel = |key: &'static str,
                 icon: DevIcon,
                 title: &str,
                 hint: Option<&str>,
                 command: &'static str| {
        let tip = crate::content::find_bar::with_shortcut(
            title,
            hint.and_then(|id| crate::keybindings::hint(c.state, id)),
        );
        DevButton {
            id: ElementId::Name(SharedString::from(format!("dev-{key}:{}", tab.id))),
            icon,
            glyph,
            square,
            radius,
            ink,
            toggled: false,
            tip,
            p: *c.p,
            msgs: focus
                .clone()
                .into_iter()
                .chain([
                    Msg::Count(match key {
                        "console" => "developer_bar_console_opens",
                        "network" => "developer_bar_network_opens",
                        _ => "developer_bar_inspects",
                    }),
                    Msg::Store(ardia_state::Action::ActivateTab {
                        tab: tab.id.clone(),
                    }),
                    Msg::command(command),
                ])
                .collect(),
            emit: c.emit.clone(),
        }
        .render()
    };
    vec![
        panel(
            "console",
            DevIcon::Console,
            "Toggle Console",
            Some("javaScriptConsole"),
            "javaScriptConsole",
        ),
        panel(
            "network",
            DevIcon::Network,
            "Toggle Network Panel",
            None,
            "devTools",
        ),
        panel(
            "inspect",
            DevIcon::Inspect,
            "Inspect Element",
            Some("inspectElements"),
            "inspectElements",
        ),
    ]
}

fn divider(color: Hsla) -> AnyElement {
    div()
        .flex_none()
        .mx(px(GROUP_GAP))
        .w(px(0.5))
        .h(px(DIVIDER_LENGTH))
        .bg(color)
        .into_any_element()
}

pub fn shows(
    state: &BrowserState,
    window: &ardia_state::WindowId,
    layout: &crate::window::layout::ChromeLayout,
    full_screen: bool,
) -> bool {
    layout.toolbar <= 0.0
        && !full_screen
        && state
            .active_tab(window.as_str())
            .is_some_and(|tab| developer_mode_on(state, &tab.url))
}

pub fn developer_bar(c: &Chrome, tab: &Tab, width: f32) -> AnyElement {
    let ink = ink_for(c, Some(tab));
    let p = *c.p;
    let site_open =
        c.window.chrome.popover.as_ref() == Some(&ardia_state::windows::Popover::SiteControls);
    let button =
        |key: &str, icon: DevIcon, glyph: f32, tip: SharedString, toggled: bool, msgs: Vec<Msg>| {
            DevButton {
                id: ElementId::Name(SharedString::from(format!("devbar-{key}"))),
                icon,
                glyph,
                square: BUTTON,
                radius: BUTTON_RADIUS,
                ink,
                toggled,
                tip,
                p,
                msgs,
                emit: c.emit.clone(),
            }
            .render()
        };
    let menu_emit = c.emit.clone();
    let menu_tab = tab.id.clone();
    let stripes = if ink.text.l > 0.5 { 0.025 } else { 0.035 };
    div()
        .id("developer-bar")
        .debug_selector(|| "developer-bar".into())
        .absolute()
        .left_0()
        .top_0()
        .w(px(width))
        .h(px(HEIGHT))
        .when_some(ink.fill, |this, fill| this.bg(fill))
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count >= 2 {
                window.titlebar_double_click();
            } else {
                window.start_window_move();
            }
        })
        .child(div().absolute().inset_0().bg(gpui::pattern_slash(
            ink.text.opacity(stripes),
            1.0,
            5.0,
        )))
        .child(
            div()
                .absolute()
                .inset_0()
                .pl(px(LEADING_EDGE))
                .pr(px(TRAILING_EDGE))
                .flex()
                .items_center()
                .child(button(
                    "info",
                    DevIcon::Info,
                    GLYPH,
                    "Site Controls".into(),
                    site_open,
                    vec![
                        Msg::Count("developer_bar_site_controls"),
                        Msg::TogglePopover(ardia_state::windows::Popover::SiteControls),
                    ],
                ))
                .child(
                    div()
                        .id("developer-bar-url")
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
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click({
                            let emit = c.emit.clone();
                            move |_, window, cx| {
                                emit.send(Msg::Count("developer_bar_address_opens"), window, cx);
                                emit.send(
                                    Msg::OpenCommandPanel {
                                        new_tab: false,
                                        text: None,
                                    },
                                    window,
                                    cx,
                                );
                            }
                        })
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
                        .child(
                            div()
                                .truncate()
                                .child(SharedString::from(without_user_info(&tab.url))),
                        ),
                )
                .child(button(
                    "link",
                    DevIcon::Link,
                    GLYPH,
                    crate::content::find_bar::with_shortcut(
                        "Copy URL",
                        crate::keybindings::hint(c.state, "copyUrl"),
                    ),
                    false,
                    vec![
                        Msg::Count("developer_bar_link_copies"),
                        Msg::command("copyUrl"),
                    ],
                ))
                .child(divider(ink.divider))
                .children(tools_buttons(
                    c,
                    tab,
                    ink,
                    BUTTON,
                    BUTTON_RADIUS,
                    GLYPH,
                    None,
                ))
                .child(divider(ink.divider))
                .child(button(
                    "extensions",
                    DevIcon::Extensions,
                    EXTENSIONS_GLYPH,
                    "Extensions".into(),
                    false,
                    vec![
                        Msg::Count("developer_bar_extension_runs"),
                        Msg::TogglePopover(ardia_state::windows::Popover::Extensions),
                    ],
                ))
                .child(button(
                    "split",
                    DevIcon::Split,
                    GLYPH,
                    "Split View Options".into(),
                    false,
                    vec![
                        Msg::Count("developer_bar_split_menus"),
                        Msg::Store(ardia_state::Action::OpenSplitPane {
                            window: c.window.id.clone(),
                            side: ardia_state::splits::SplitSide::Right,
                            url: None,
                        }),
                    ],
                )),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn developer_hosts_come_from_web_urls_only() {
        assert_eq!(
            developer_host("http://user@LocalHost:3000/x").as_deref(),
            Some("localhost")
        );
        assert_eq!(
            developer_host("https://[::1]:8080/").as_deref(),
            Some("[::1]")
        );
        assert_eq!(
            developer_host("https://example.com./a").as_deref(),
            Some("example.com")
        );
        assert_eq!(developer_host("file:///tmp/a"), None);
        let mut state = BrowserState::default();
        std::sync::Arc::make_mut(&mut state.settings)
            .developer_mode_sites
            .insert("localhost".into(), true);
        assert!(developer_mode_on(&state, "http://localhost:3000/"));
        assert!(!developer_mode_on(&state, "http://example.com/"));
    }

    #[test]
    fn user_info_is_dropped_from_shown_urls() {
        assert_eq!(
            without_user_info("https://a:b@site.test/p@q"),
            "https://site.test/p@q"
        );
        assert_eq!(
            without_user_info("https://site.test/"),
            "https://site.test/"
        );
        assert_eq!(middle_ellipsis("abcdefghij", 5), "ab…ij");
        assert_eq!(middle_ellipsis("abc", 5), "abc");
    }

    #[test]
    fn every_developer_icon_is_an_image_mask() {
        for icon in ALL {
            let svg = String::from_utf8(mask(icon).to_vec()).unwrap_or_default();
            assert!(svg.contains("data:image/png;base64,iVBOR"));
        }
    }
}
