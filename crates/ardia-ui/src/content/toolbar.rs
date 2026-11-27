use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::scale::px;
use ardia_state::omnibox::url::{breadcrumb_host, display_url};
use ardia_state::settings::AddressBarButtons;
use ardia_state::tabs::{SecurityState, Tab};
use ardia_state::windows::Popover;
use ardia_state::{ProfileId, TabId};
use ardia_theme::layout::toolbar;
use ardia_theme::tokens::site_toolbar_roles;
use gpui::{
    AnyElement, ElementId, FontWeight, Hsla, Image, IntoElement, MouseButton, ObjectFit,
    ParentElement, SharedString, Styled, div, img, prelude::*,
};

use crate::msg::Msg;
use crate::primitives::controls::IconButton;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::theme_bridge::hsla;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const FIELD_TEXT_LEFT: f32 = 8.0;
pub const FIELD_TRAILING_INSET: f32 = 4.0;
pub const FIELD_GLYPH: f32 = 13.0;
pub const LOCK_LEFT: f32 = 7.0;
pub const LOCK_WIDTH: f32 = 18.0;
pub const LOCK_GAP: f32 = 4.0;
pub const EXTENSION_GLYPH: f32 = 14.0;
pub const SPLIT_GLYPH: f32 = 15.0;
pub const FIELD_MIN_WIDTH: f32 = 160.0;
pub const DIVIDER: f32 = 0.5;

#[derive(Clone, Debug, PartialEq)]
pub struct ToolbarAction {
    pub id: String,
    pub title: SharedString,
    pub icon: Option<Arc<Image>>,
    pub badge: Option<SharedString>,
    pub badge_fill: Option<Hsla>,
    pub badge_ink: Option<Hsla>,
    pub enabled: bool,
    pub open: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ToolbarFeed {
    pub actions: HashMap<ProfileId, Arc<[ToolbarAction]>>,
    pub casting: HashSet<TabId>,
    pub reader_available: HashSet<TabId>,
}

impl ToolbarFeed {
    pub fn actions_of(&self, profile: &ProfileId) -> &[ToolbarAction] {
        self.actions.get(profile).map_or(&[], |actions| actions)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToolbarInk {
    pub fill: Option<Hsla>,
    pub text: Hsla,
    pub secondary: Hsla,
    pub icon: Hsla,
    pub icon_disabled: Hsla,
    pub hover: Hsla,
    pub pressed: Hsla,
    pub pill: Hsla,
    pub divider: Hsla,
}

pub fn ink(c: &Chrome) -> ToolbarInk {
    ink_for(c, c.active.map(|tab| tab.as_ref()))
}

pub fn ink_for(c: &Chrome, tab: Option<&Tab>) -> ToolbarInk {
    let p = c.p;
    let site = tab
        .filter(|tab| c.state.settings.extend_website_color && !tab.url.is_empty())
        .and_then(|tab| {
            if c.host.reader_status(&tab.id).active {
                Some(crate::pages::reader::reader_ground(c.look.dark))
            } else {
                tab.live.theme_color
            }
        })
        .filter(|color| color.a > 0.5);
    match site {
        Some(color) => {
            let roles = site_toolbar_roles(color);
            ToolbarInk {
                fill: Some(hsla(color.opaque())),
                text: hsla(roles.text),
                secondary: hsla(roles.secondary),
                icon: hsla(roles.icon),
                icon_disabled: hsla(roles.icon_disabled),
                hover: hsla(roles.hover),
                pressed: hsla(roles.pressed),
                pill: hsla(roles.pill),
                divider: hsla(roles.divider),
            }
        }
        None => ToolbarInk {
            fill: None,
            text: p.text,
            secondary: p.text_secondary,
            icon: p.icon,
            icon_disabled: p.icon_disabled,
            hover: p.toolbar_hover,
            pressed: p.toolbar_pressed,
            pill: p.url_pill,
            divider: p.divider,
        },
    }
}

pub fn is_new_tab_page(tab: Option<&Tab>) -> bool {
    tab.is_none_or(|tab| tab.url.is_empty() || tab.url.starts_with("ardia://newtab"))
}

pub fn split_url(url: &str) -> (String, String) {
    let shown = display_url(url);
    let host = breadcrumb_host(url);
    match shown.find(host.as_str()) {
        Some(at) if !host.is_empty() => {
            let end = at + host.len();
            (shown[..end].to_owned(), shown[end..].to_owned())
        }
        _ => (shown, String::new()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Trailing {
    pub field_right: f32,
    pub items_right: f32,
    pub items_width: f32,
}

pub fn items_width(row: &toolbar::ToolbarRow, count: usize) -> f32 {
    if count == 0 {
        0.0
    } else {
        count as f32 * (row.extension_button + toolbar::ITEM_GAP) - toolbar::ITEM_GAP
    }
}

pub fn trailing_layout(row: &toolbar::ToolbarRow, items: usize, card_radius: f32) -> Trailing {
    let icon_inset = (row.extension_button - toolbar::EXTENSION_ICON) / 2.0;
    let ink_gap = toolbar::ITEM_GAP + 2.0 * icon_inset;
    let items_right = (ink_gap - icon_inset).max(0.0);
    let width = items_width(row, items);
    let field_right = if items > 0 {
        items_right + width + ink_gap - icon_inset
    } else {
        let top = toolbar::url_field_top(row);
        if top + row.field_radius >= card_radius {
            top
        } else {
            card_radius - row.field_radius
        }
    };
    Trailing {
        field_right,
        items_right,
        items_width: width,
    }
}

pub fn items_fitting(row: &toolbar::ToolbarRow, room: f32) -> usize {
    let pitch = row.extension_button + toolbar::ITEM_GAP;
    (((room + toolbar::ITEM_GAP) / pitch).floor().max(0.0)) as usize
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrailingItems {
    pub cast: bool,
    pub actions: usize,
    pub overflow: bool,
}

impl TrailingItems {
    pub fn count(self) -> usize {
        usize::from(self.cast) + self.actions + usize::from(self.overflow)
    }
}

pub fn trailing_items(casting: bool, actions: usize, room: usize) -> TrailingItems {
    let room = room.saturating_sub(usize::from(casting));
    let overflow = actions > room;
    TrailingItems {
        cast: casting,
        actions: if overflow {
            room.saturating_sub(1)
        } else {
            actions
        },
        overflow: overflow && room > 0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldButtons {
    pub page: bool,
    pub split: bool,
    pub site_controls: bool,
    pub reader: bool,
    pub zoom: bool,
    pub popups: bool,
    pub lock: bool,
}

pub struct FieldInputs {
    pub mode: AddressBarButtons,
    pub hovered: bool,
    pub in_split: bool,
    pub reader_active: bool,
    pub reader_available: bool,
    pub zoomed: bool,
    pub zoom_open: bool,
    pub popups: usize,
    pub insecure: bool,
}

pub fn field_buttons(inputs: &FieldInputs) -> FieldButtons {
    let shown = inputs.hovered || inputs.mode == AddressBarButtons::Always;
    let quiet = !shown;
    FieldButtons {
        page: shown,
        split: shown && !inputs.in_split,
        site_controls: shown,
        reader: inputs.reader_active || (inputs.reader_available && !quiet),
        zoom: (inputs.zoomed && !quiet) || inputs.zoom_open,
        popups: inputs.popups > 0,
        lock: inputs.insecure,
    }
}

struct Bar<'a> {
    c: &'a Chrome<'a>,
    ink: ToolbarInk,
    row: &'static toolbar::ToolbarRow,
}

impl Bar<'_> {
    fn reader_field(
        &self,
        reader: crate::pages::reader::ReaderStatus,
        msgs: Vec<Msg>,
    ) -> AnyElement {
        let row = self.row;
        let ink = &self.ink;
        let title = reader.toggle_title();
        let tip = match crate::keybindings::hint(self.c.state, "toggleReader") {
            Some(hint) => format!("{title} ({hint})"),
            None => title.to_owned(),
        };
        IconButton::new("url-reader", Icon::DocPlaintext, self.c.p)
            .square(row.field_button, row.field_button_radius)
            .glyph(FIELD_GLYPH)
            .color(if reader.active {
                self.c.p.accent
            } else {
                ink.icon
            })
            .fills(ink.hover, ink.pressed)
            .tooltip(tip, self.c.p)
            .on_click(send_all(self.c.emit, msgs))
            .into_any_element()
    }

    fn field(
        &self,
        id: &'static str,
        glyph: Icon,
        tip: impl Into<SharedString>,
        toggled: bool,
        msgs: Vec<Msg>,
    ) -> AnyElement {
        let row = self.row;
        let ink = &self.ink;
        IconButton::new(id, glyph, self.c.p)
            .square(row.field_button, row.field_button_radius)
            .glyph(FIELD_GLYPH)
            .color(ink.icon)
            .fills(ink.hover, ink.pressed)
            .toggled(toggled.then_some(ink.pressed))
            .tooltip(tip, self.c.p)
            .on_click(send_all(self.c.emit, msgs))
            .into_any_element()
    }
}

pub fn send_all(
    emit: &crate::msg::Emit,
    msgs: Vec<Msg>,
) -> impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static {
    let emit = emit.clone();
    move |_, window, cx| {
        for msg in msgs.clone() {
            emit.send(msg, window, cx);
        }
    }
}

fn popover_is(c: &Chrome, popover: &Popover) -> bool {
    c.window.chrome.popover.as_ref() == Some(popover)
}

fn page_button(bar: &Bar, tab: &Tab) -> AnyElement {
    let c = bar.c;
    if c.state.settings.show_bookmarks {
        let bookmarked = c
            .state
            .bookmarks_of(&tab.profile_id)
            .is_some_and(|tree| tree.find_url(&tab.url).is_some());
        bar.field(
            "url-bookmark",
            if bookmarked {
                Icon::BookmarkFill
            } else {
                Icon::Bookmark
            },
            if bookmarked {
                SharedString::new_static("Remove Bookmark")
            } else {
                crate::content::find_bar::with_shortcut(
                    "Bookmark This Page",
                    crate::keybindings::hint(c.state, "bookmarkPage"),
                )
            },
            false,
            vec![crate::bookmarks_bar::toggle_message(c, tab)],
        )
    } else {
        bar.field(
            "url-copy",
            Icon::Link,
            crate::content::find_bar::with_shortcut(
                "Copy URL",
                crate::keybindings::hint(c.state, "copyUrl"),
            ),
            false,
            vec![Msg::command("copyUrl")],
        )
    }
}

pub fn page_host_label(url: &str) -> String {
    if url.starts_with("file:") {
        "File".to_owned()
    } else {
        breadcrumb_host(url)
    }
}

fn percent_decoded(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match (bytes[at], bytes.get(at + 1), bytes.get(at + 2)) {
            (b'%', Some(&high), Some(&low)) if hex(high).is_some() && hex(low).is_some() => {
                out.push((hex(high).unwrap_or(0) * 16 + hex(low).unwrap_or(0)) as u8);
                at += 3;
            }
            (byte, _, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| raw.to_owned())
}

fn is_web_url(url: &str) -> bool {
    let lower = url.get(..6).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http:") || lower.starts_with("https:")
}

pub fn url_trail(url: &str, title: &str, hovered: bool, show_full_url: bool) -> String {
    let file = url.starts_with("file:");
    let host = page_host_label(url);
    let full = if file {
        let raw = url.strip_prefix("file://").unwrap_or(&url["file:".len()..]);
        format!(" {}", percent_decoded(raw))
    } else {
        ardia_state::omnibox::url::url_for_display(url)
    };
    let path = match full.strip_prefix(host.as_str()) {
        Some(rest) if !file => rest.to_owned(),
        _ => full,
    };
    if hovered {
        return path;
    }
    if show_full_url {
        return path.strip_suffix('/').map(str::to_owned).unwrap_or(path);
    }
    let shows_title = !is_web_url(url)
        && ardia_state::omnibox::url::app_url_origin(url).is_some()
        && !title.is_empty();
    if shows_title {
        format!(" / {title}")
    } else {
        String::new()
    }
}

fn field_text(c: &Chrome, ink: &ToolbarInk, tab: &Tab, hovered: bool) -> AnyElement {
    let lead = page_host_label(&tab.url);
    let title = if is_web_url(&tab.url) {
        ""
    } else {
        tab.title.as_str()
    };
    let trail = url_trail(&tab.url, title, hovered, c.state.settings.show_full_url);
    div()
        .flex_1()
        .min_w_0()
        .flex()
        .items_center()
        .overflow_hidden()
        .whitespace_nowrap()
        .text_size(px(13.))
        .child(
            div()
                .flex_none()
                .max_w_full()
                .truncate()
                .font_weight(FontWeight::MEDIUM)
                .text_color(ink.text)
                .child(SharedString::from(lead)),
        )
        .when(!trail.is_empty(), |this| {
            this.child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_color(ink.secondary)
                    .child(SharedString::from(trail)),
            )
        })
        .into_any_element()
}

fn capture_what(camera: bool, microphone: bool, screen: bool) -> String {
    let parts: Vec<&str> = [
        (camera, "camera"),
        (microphone, "microphone"),
        (screen, "screen"),
    ]
    .into_iter()
    .filter_map(|(on, name)| on.then_some(name))
    .collect();
    parts.join(" and ")
}

pub const DARK_SITE_GLASS_FILL: f32 = 0.135;

pub fn dark_site_glass(ink: &ToolbarInk) -> bool {
    ink.text.l > 0.5
}

pub fn glass_lit(ink: &ToolbarInk, look: &crate::look::Look) -> Hsla {
    let lift = crate::primitives::theme_bridge::hsla(crate::primitives::glass::painted_glass_lift(
        &look.theme,
        crate::primitives::glass::GlassState::Rest,
        crate::primitives::glass::GlassState::Lit,
        look.glass_tint,
    ));
    glass_rest(ink).blend(lift)
}

pub fn glass_rest(ink: &ToolbarInk) -> Hsla {
    if ink.text.l > 0.5 {
        gpui::Rgba {
            r: 118.0 / 255.0,
            g: 138.0 / 255.0,
            b: 170.0 / 255.0,
            a: DARK_SITE_GLASS_FILL,
        }
        .into()
    } else {
        gpui::transparent_black()
    }
}

pub fn capture_tooltip(camera: bool, microphone: bool, screen: bool) -> String {
    format!(
        "This page is using your {}",
        capture_what(camera, microphone, screen)
    )
}

pub fn capture_icon(camera: bool, screen: bool) -> Icon {
    if screen {
        Icon::Display
    } else if camera {
        Icon::Camera
    } else {
        Icon::Mic
    }
}

pub fn capture_symbol(camera: bool, screen: bool) -> &'static str {
    if screen {
        "rectangle.inset.filled.on.rectangle"
    } else if camera {
        "video.fill"
    } else {
        "mic.fill"
    }
}

#[allow(clippy::too_many_arguments)]
fn address(
    bar: &Bar,
    tab: &Tab,
    feed: &ToolbarFeed,
    left: f32,
    width: f32,
    in_split: bool,
    focus: Option<Msg>,
) -> AnyElement {
    let c = bar.c;
    let ink = &bar.ink;
    let row = bar.row;
    let site_open = popover_is(c, &Popover::SiteControls);
    let hovered = c.ui.url_hover || site_open;
    let insecure = matches!(
        tab.live.security,
        SecurityState::Insecure | SecurityState::Dangerous
    );
    let reader = c.host.reader_status(&tab.id);
    let shown = field_buttons(&FieldInputs {
        mode: c.state.settings.address_bar_buttons,
        hovered,
        in_split,
        reader_active: reader.active,
        reader_available: reader.available || feed.reader_available.contains(&tab.id),
        zoomed: (tab.zoom - 1.0).abs() > 0.001,
        zoom_open: popover_is(c, &Popover::Zoom),
        popups: tab.live.blocked_popups.len(),
        insecure,
    });
    let plugin_bar = crate::plugins::page_bar::matched(c, tab);
    let developer =
        plugin_bar.is_none() && crate::content::developer_bar::developer_mode_on(c.state, &tab.url);
    let capture = c.host.media_access(&tab.id);
    let emit = c.emit.clone();
    let window = c.window.id.clone();
    let lock_color = if tab.live.security == SecurityState::Dangerous {
        c.p.destructive
    } else {
        ink.secondary
    };
    let focus_first = |msg: Msg| -> Vec<Msg> { focus.clone().into_iter().chain([msg]).collect() };
    let menu_emit = c.emit.clone();
    let menu_tab = tab.id.clone();
    let text = if developer {
        div()
            .flex_1()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .font_family("Menlo")
            .text_size(px(13.))
            .text_color(ink.text)
            .child(div().truncate().child(SharedString::from(
                crate::content::developer_bar::without_user_info(&tab.url),
            )))
            .into_any_element()
    } else {
        field_text(c, ink, tab, hovered)
    };
    div()
        .id("url-field")
        .debug_selector(|| "url-field".into())
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(crate::onboarding::tour::probe(
            bar.c.window.id.clone(),
            crate::onboarding::tour::Anchor::CommandBar,
        ))
        .absolute()
        .left(px(left))
        .top(px(toolbar::url_field_top(row)))
        .w(px(width.max(0.0)))
        .h(px(row.field))
        .pr(px(FIELD_TRAILING_INSET))
        .rounded(px(row.field_radius))
        .flex()
        .items_center()
        .cursor_pointer()
        .when(hovered && !c.look.glass, |this| this.bg(ink.pill))
        .when(c.look.glass, |this| {
            this.bg(if hovered {
                glass_lit(ink, c.look)
            } else {
                glass_rest(ink)
            })
            .when(dark_site_glass(ink), |this| {
                this.shadow(crate::primitives::glass::surface_edge_glow())
                    .children(crate::primitives::glass::surface_rim(
                        true,
                        row.field_radius,
                        crate::primitives::glass::SURFACE_GLASS_RIM_DARK,
                    ))
            })
        })
        .on_hover(move |hovered, window, cx| emit.send(Msg::UrlHover(*hovered), window, cx))
        .on_click(send_all(
            c.emit,
            focus_first(Msg::OpenCommandPanel {
                new_tab: false,
                text: None,
            }),
        ))
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
        .child(crate::content::load_fill::FieldLoadFill {
            id: ElementId::Name(SharedString::from(format!("field-load:{}", tab.id))),
            loading: tab.live.loading,
            progress: tab.live.progress,
            width: width.max(0.0),
            height: row.field,
            color: field_load_color(c),
            radius: row.field_radius,
        })
        .when(shown.lock, |this| {
            this.child(
                div()
                    .id("url-lock")
                    .debug_selector(|| "url-lock".into())
                    .flex_none()
                    .ml(px(LOCK_LEFT))
                    .w(px(LOCK_WIDTH))
                    .h(px(row.field))
                    .flex()
                    .items_center()
                    .justify_center()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(send_all(
                        c.emit,
                        focus_first(Msg::TogglePopover(Popover::SiteControls)),
                    ))
                    .tooltip(crate::primitives::controls::tooltip(
                        "Connection is not secure".into(),
                        c.p,
                    ))
                    .child(icon(Icon::LockWarning, 12., lock_color)),
            )
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .h_full()
                .flex()
                .items_center()
                .pl(px(if shown.lock {
                    LOCK_GAP
                } else {
                    FIELD_TEXT_LEFT
                }))
                .child(text),
        )
        .child(
            div()
                .id("url-field-buttons")
                .flex_none()
                .flex()
                .items_center()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
                .when(shown.page, |this| this.child(page_button(bar, tab)))
                .when(shown.split, |this| {
                    this.child(bar.field(
                        "url-split",
                        Icon::Split,
                        crate::content::find_bar::with_shortcut(
                            "Open Split View",
                            crate::keybindings::hint(c.state, "openSplitPane"),
                        ),
                        false,
                        vec![Msg::Stores(vec![
                            ardia_state::Action::ActivateTab {
                                tab: tab.id.clone(),
                            },
                            ardia_state::Action::OpenSplitPane {
                                window: window.clone(),
                                side: ardia_state::splits::SplitSide::Right,
                                url: None,
                            },
                        ])],
                    ))
                })
                .when(shown.site_controls, |this| {
                    this.child(bar.field(
                        "url-site-controls",
                        Icon::Sliders,
                        "Site Controls",
                        site_open,
                        focus_first(Msg::TogglePopover(Popover::SiteControls)),
                    ))
                })
                .when_some(plugin_bar, |this, plugin_bar| {
                    this.child(crate::plugins::page_bar::field_buttons_row(
                        c,
                        tab,
                        &plugin_bar,
                        bar.ink,
                        row.field_button,
                        row.field_button_radius,
                    ))
                })
                .when(developer, |this| {
                    this.children(crate::content::developer_bar::tools_buttons(
                        c,
                        tab,
                        bar.ink,
                        row.field_button,
                        row.field_button_radius,
                        crate::content::developer_bar::FIELD_GLYPH,
                        focus.clone(),
                    ))
                })
                .when(capture.any(), |this| {
                    this.child(
                        IconButton::new(
                            "url-capture",
                            capture_icon(capture.camera, capture.screen),
                            c.p,
                        )
                        .symbol(
                            Arc::clone(c.host),
                            capture_symbol(capture.camera, capture.screen),
                        )
                        .square(row.field_button, row.field_button_radius)
                        .glyph(FIELD_GLYPH)
                        .color(c.p.destructive)
                        .fills(ink.hover, ink.pressed)
                        .tooltip(
                            capture_tooltip(capture.camera, capture.microphone, capture.screen),
                            c.p,
                        )
                        .on_click(send_all(
                            c.emit,
                            focus_first(Msg::TogglePopover(Popover::SiteControls)),
                        )),
                    )
                })
                .when(shown.reader, |this| {
                    this.child(bar.reader_field(reader, focus_first(Msg::command("toggleReader"))))
                })
                .when(shown.zoom, |this| {
                    this.child(bar.field(
                        "url-zoom",
                        if (tab.zoom - 1.0).abs() <= 0.001 {
                            Icon::Search
                        } else if tab.zoom > 1.0 {
                            Icon::ZoomIn
                        } else {
                            Icon::ZoomOut
                        },
                        format!("Zoom: {:.0}%", tab.zoom * 100.0),
                        popover_is(c, &Popover::Zoom),
                        focus_first(Msg::TogglePopover(Popover::Zoom)),
                    ))
                })
                .when(shown.popups, |this| {
                    this.child(bar.field(
                        "url-popups",
                        Icon::PopupBlocked,
                        "Pop-ups blocked on this page",
                        popover_is(c, &Popover::BlockedPopups),
                        focus_first(Msg::TogglePopover(Popover::BlockedPopups)),
                    ))
                }),
        )
        .into_any_element()
}

fn action_button(
    bar: &Bar,
    tab: &TabId,
    action: &ToolbarAction,
    slot: (usize, usize),
    reorderable: bool,
) -> AnyElement {
    let c = bar.c;
    let row = bar.row;
    let ink = bar.ink;
    let (index, count) = slot;
    let pitch = row.extension_button + toolbar::ITEM_GAP;
    let shift = crate::content::toolbar_extensions::slot_shift(&c.window.id, index, pitch, count);
    let dim = if action.enabled { 1.0 } else { 0.45 };
    let glyph = match &action.icon {
        Some(image) => img(Arc::clone(image))
            .size(px(toolbar::EXTENSION_ICON))
            .object_fit(ObjectFit::Contain)
            .opacity(dim)
            .into_any_element(),
        None => icon(
            Icon::PuzzleExtension,
            EXTENSION_GLYPH,
            ink.icon.opacity(dim),
        )
        .into_any_element(),
    };
    div()
        .id(SharedString::from(format!("toolbar-action:{}", action.id)))
        .relative()
        .flex_none()
        .size(px(row.extension_button))
        .rounded(px(row.button_radius))
        .flex()
        .items_center()
        .justify_center()
        .left(px(shift))
        .when(action.open, |this| this.bg(ink.pressed))
        .when(reorderable, |this| {
            let drag = crate::content::toolbar_extensions::ExtensionDrag {
                window: c.window.id.clone(),
                id: action.id.clone(),
                from: index,
            };
            this.on_drag(drag, |drag, _, _, cx| {
                crate::content::toolbar_extensions::drag_started(&drag.window, &drag.id, drag.from);
                cx.new(|_| crate::primitives::controls::EmptyDrag)
            })
            .on_drag_move(
                |event: &gpui::DragMoveEvent<crate::content::toolbar_extensions::ExtensionDrag>,
                 window,
                 _| {
                    crate::content::toolbar_extensions::drag_moved(crate::scale::points(
                        event.event.position.x,
                    ));
                    window.refresh();
                },
            )
        })
        .hover(move |style| style.bg(ink.hover))
        .active(move |style| style.bg(ink.pressed))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down(MouseButton::Right, {
            let emit = c.emit.clone();
            let id = action.id.clone();
            move |event, window, cx| {
                cx.stop_propagation();
                emit.send(
                    Msg::Menu(Some((
                        crate::msg::MenuTarget::Extension(id.clone()),
                        event.position,
                    ))),
                    window,
                    cx,
                );
            }
        })
        .tooltip(crate::primitives::controls::tooltip(
            action.title.clone(),
            c.p,
        ))
        .child(crate::popovers::extensions::anchor_probe(
            &c.window.id,
            &action.id,
        ))
        .on_click(c.emit.click(if action.open {
            Msg::CloseExtensionPopup
        } else {
            Msg::Extension {
                tab: tab.clone(),
                extension: action.id.clone(),
            }
        }))
        .child(glyph)
        .when_some(action.badge.clone(), |this, badge| {
            this.child(
                div()
                    .absolute()
                    .right(px(1.))
                    .bottom(px(3.))
                    .h(px(11.))
                    .px(px(2.5))
                    .rounded_full()
                    .bg(action.badge_fill.unwrap_or(c.p.badge_fill))
                    .text_size(px(8.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(action.badge_ink.unwrap_or(gpui::white()))
                    .flex()
                    .items_center()
                    .child(badge),
            )
        })
        .into_any_element()
}

fn trailing(
    bar: &Bar,
    tab: &Tab,
    actions: &[ToolbarAction],
    items: TrailingItems,
    layout: Trailing,
) -> AnyElement {
    let c = bar.c;
    let row = bar.row;
    let ink = bar.ink;
    div()
        .id("toolbar-trailing")
        .debug_selector(|| "toolbar-trailing".into())
        .absolute()
        .right(px(layout.items_right))
        .top(px(row.center - row.extension_button / 2.0))
        .h(px(row.extension_button))
        .flex()
        .items_center()
        .gap(px(toolbar::ITEM_GAP))
        .when(items.cast, |this| {
            this.child(
                div()
                    .id("toolbar-cast-area")
                    .on_mouse_down(MouseButton::Right, {
                        let emit = c.emit.clone();
                        move |event, window, cx| {
                            cx.stop_propagation();
                            emit.send(
                                Msg::Menu(Some((
                                    crate::msg::MenuTarget::CastRoutes,
                                    event.position,
                                ))),
                                window,
                                cx,
                            );
                        }
                    })
                    .child(
                        IconButton::new("toolbar-cast", Icon::TvMedia, c.p)
                            .square(row.extension_button, row.button_radius)
                            .glyph(EXTENSION_GLYPH)
                            .color(c.p.accent)
                            .fills(ink.hover, ink.pressed)
                            .toggled(popover_is(c, &Popover::Cast).then_some(ink.pressed))
                            .tooltip(
                                crate::host_data::cast_routes_tooltip(
                                    &c.host.cast_routes(&c.window.id),
                                ),
                                c.p,
                            )
                            .on_click(c.emit.click(Msg::Cast(tab.id.clone()))),
                    ),
            )
        })
        .children({
            let shown = items.actions.min(actions.len());
            let reorderable = !c.window.profile_id.is_incognito() && shown > 1;
            actions
                .iter()
                .take(items.actions)
                .enumerate()
                .map(move |(index, action)| {
                    action_button(bar, &tab.id, action, (index, shown), reorderable)
                })
        })
        .on_drop({
            let emit = c.emit.clone();
            let pitch = row.extension_button + toolbar::ITEM_GAP;
            let shown = items.actions.min(actions.len());
            move |_: &crate::content::toolbar_extensions::ExtensionDrag, window, cx| {
                if let Some((id, from, dx)) = crate::content::toolbar_extensions::drag_ended()
                    && let Some(to) =
                        crate::content::toolbar_extensions::drop_target(from, dx, pitch, shown)
                {
                    ardia_telemetry::counts::count("toolbar_extension_moves");
                    emit.send(Msg::MoveExtension { extension: id, to }, window, cx);
                }
                window.refresh();
            }
        })
        .on_mouse_up_out(MouseButton::Left, |_, window, _| {
            if crate::content::toolbar_extensions::drag_ended().is_some() {
                window.refresh();
            }
        })
        .when(items.overflow, |this| {
            this.child(
                IconButton::new("toolbar-extensions", Icon::PuzzleExtension, c.p)
                    .square(row.extension_button, row.button_radius)
                    .glyph(EXTENSION_GLYPH)
                    .color(ink.icon)
                    .fills(ink.hover, ink.pressed)
                    .tooltip("Extensions", c.p)
                    .on_click({
                        let emit = c.emit.clone();
                        move |event, window, cx| {
                            emit.send(
                                Msg::Menu(Some((
                                    crate::msg::MenuTarget::Extensions,
                                    event.position(),
                                ))),
                                window,
                                cx,
                            )
                        }
                    }),
            )
        })
        .into_any_element()
}

pub struct ToolbarPlan {
    pub items: TrailingItems,
    pub trailing: Trailing,
    pub field_left: f32,
    pub field_width: f32,
}

pub fn plan(
    row: &toolbar::ToolbarRow,
    card_width: f32,
    card_radius: f32,
    sidebar_toggle: bool,
    casting: bool,
    actions: usize,
) -> ToolbarPlan {
    let field_left = breadcrumb_x(sidebar_toggle) - FIELD_TEXT_LEFT;
    let alone = trailing_layout(row, 0, card_radius);
    let room = card_width - field_left - FIELD_MIN_WIDTH - alone.items_right - alone.field_right;
    let items = trailing_items(casting, actions, items_fitting(row, room.max(0.0)));
    let trailing = trailing_layout(row, items.count(), card_radius);
    ToolbarPlan {
        items,
        trailing,
        field_left,
        field_width: (card_width - field_left - trailing.field_right).max(0.0),
    }
}

pub fn icon_centers(sidebar_toggle: bool) -> [f32; 4] {
    let centers = toolbar::ICON_CENTERS;
    if sidebar_toggle {
        centers
    } else {
        let shift = centers[1] - centers[0];
        centers.map(|center| center - shift)
    }
}

pub fn breadcrumb_x(sidebar_toggle: bool) -> f32 {
    let centers = toolbar::ICON_CENTERS;
    if sidebar_toggle {
        toolbar::BREADCRUMB_X
    } else {
        toolbar::BREADCRUMB_X - (centers[1] - centers[0])
    }
}

pub fn tabs_toggle_icon(state: &ardia_state::BrowserState, window: &str) -> Icon {
    use ardia_state::model::{SidebarSide, TabLayout};
    if state.tab_layout(window) == TabLayout::Top {
        Icon::TopStrip
    } else if state.sidebar_side(window) == SidebarSide::Right {
        Icon::SidebarRight
    } else {
        Icon::SidebarLeft
    }
}

pub fn field_load_color(c: &Chrome) -> Hsla {
    if c.look.theme.custom.is_some()
        && let Some(color) = c.look.theme.power_up_color
    {
        return hsla(color);
    }
    if c.window.profile_id.is_incognito() {
        return c.p.accent;
    }
    let preset = c
        .state
        .profile(c.window.profile_id.as_str())
        .map_or(ardia_theme::ProfileColor::Plum, |profile| {
            profile.color.preset()
        });
    hsla(preset.spec().swatch)
}

pub const DIM: f32 = 0.5;
pub const DIM_MOTION: std::time::Duration = std::time::Duration::from_millis(150);
pub const BAND_MOTION: std::time::Duration = std::time::Duration::from_millis(150);

#[derive(Clone, Copy)]
struct Eased {
    from: Hsla,
    to: Hsla,
    start: Option<std::time::Instant>,
}

pub fn mix(from: Hsla, to: Hsla, t: f32) -> Hsla {
    let (a, b) = (from.to_rgb(), to.to_rgb());
    gpui::Rgba {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
        a: a.a + (b.a - a.a) * t,
    }
    .into()
}

#[derive(IntoElement)]
struct Band {
    key: SharedString,
    color: Option<Hsla>,
    top_left: f32,
    top_right: f32,
}

impl gpui::RenderOnce for Band {
    fn render(self, window: &mut gpui::Window, cx: &mut gpui::App) -> impl IntoElement {
        let now = std::time::Instant::now();
        let clear = Hsla::transparent_black();
        let target = self.color.unwrap_or(clear);
        let state = window.use_keyed_state(self.key, cx, |_, _| Eased {
            from: target,
            to: target,
            start: None,
        });
        let reduce = cx.reduce_motion();
        let shown = state.update(cx, |eased, _| {
            let want = match self.color {
                Some(color) => color,
                None => eased.to.opacity(0.0),
            };
            if want != eased.to {
                let t = eased.start.map_or(1.0, |start| {
                    crate::content::load_fill::ease_enter(
                        now.saturating_duration_since(start).as_secs_f32()
                            / BAND_MOTION.as_secs_f32(),
                    )
                });
                eased.from = mix(eased.from, eased.to, t);
                eased.to = want;
                eased.start = (!reduce).then_some(now);
            }
            match eased.start {
                Some(start) if now.saturating_duration_since(start) < BAND_MOTION => {
                    let t = now.saturating_duration_since(start).as_secs_f32()
                        / BAND_MOTION.as_secs_f32();
                    (
                        mix(
                            eased.from,
                            eased.to,
                            crate::content::load_fill::ease_enter(t),
                        ),
                        true,
                    )
                }
                _ => (eased.to, false),
            }
        });
        if shown.1 {
            window.request_animation_frame();
        }
        div()
            .absolute()
            .inset_0()
            .rounded_tl(px(self.top_left))
            .rounded_tr(px(self.top_right))
            .bg(shown.0)
    }
}

pub fn band_corners(radius: f32) -> (f32, f32) {
    (radius, radius)
}

#[derive(IntoElement)]
struct Dimmed {
    key: SharedString,
    focused: bool,
    body: AnyElement,
}

impl gpui::RenderOnce for Dimmed {
    fn render(self, window: &mut gpui::Window, cx: &mut gpui::App) -> impl IntoElement {
        let now = std::time::Instant::now();
        let reduce = cx.reduce_motion();
        let target = if self.focused { 1.0 } else { DIM };
        let state = window.use_keyed_state(self.key, cx, |_, _| {
            (target, target, None::<std::time::Instant>)
        });
        let (opacity, moving) = state.update(cx, |(from, to, start), _| {
            let value_at = |from: f32, to: f32, start: Option<std::time::Instant>| match start {
                Some(at) => {
                    let t =
                        now.saturating_duration_since(at).as_secs_f32() / DIM_MOTION.as_secs_f32();
                    from + (to - from) * crate::content::load_fill::ease_enter(t)
                }
                None => to,
            };
            if (*to - target).abs() > f32::EPSILON {
                *from = value_at(*from, *to, *start);
                *to = target;
                *start = (!reduce).then_some(now);
            }
            let moving = start.is_some_and(|at| now.saturating_duration_since(at) < DIM_MOTION);
            (value_at(*from, *to, *start), moving)
        });
        if moving {
            window.request_animation_frame();
        }
        div().absolute().inset_0().opacity(opacity).child(self.body)
    }
}

pub struct PaneBar<'a> {
    pub tab: Option<&'a Arc<Tab>>,
    pub left: f32,
    pub width: f32,
    pub leading: bool,
    pub in_split: bool,
    pub focused: bool,
}

fn pane_bar(c: &Chrome, pane: PaneBar, feed: &ToolbarFeed) -> AnyElement {
    let row = toolbar::row(c.state.settings.compact_toolbar);
    let ink = ink_for(c, pane.tab.map(|t| t.as_ref()));
    let bar = Bar { c, ink, row };
    let tab = pane.tab.map(|t| t.as_ref());
    let sidebar_toggle = pane.leading && c.state.settings.show_sidebar_button;
    let centers = icon_centers(sidebar_toggle);
    let actions = feed.actions_of(&c.window.profile_id);
    let casting = !pane.in_split && tab.is_some_and(|tab| feed.casting.contains(&tab.id));
    let shown_actions = if pane.in_split { 0 } else { actions.len() };
    let mut plan = plan(
        row,
        pane.width,
        c.layout.frame.radius,
        sidebar_toggle,
        casting,
        shown_actions,
    );
    if pane.in_split {
        let split_room = 2.0 * row.button + toolbar::ITEM_GAP;
        plan.field_width = (plan.field_width - split_room).max(0.0);
    }
    let plugin_items = (!pane.in_split)
        .then(|| {
            crate::plugins::toolbar_items::mount(
                c,
                bar.row,
                &bar.ink,
                plan.trailing.items_right
                    + plan.trailing.items_width
                    + if plan.trailing.items_width > 0.0 {
                        toolbar::ITEM_GAP
                    } else {
                        0.0
                    },
                pane.left + pane.width,
            )
        })
        .flatten();
    if let Some((_, width)) = &plugin_items {
        plan.field_width = (plan.field_width - width).max(0.0);
    }
    let new_tab = is_new_tab_page(tab);
    let tabs_shown = c.layout.sidebar.is_some() || c.layout.strip.is_some();
    let window_id = c.window.id.as_str();
    let key = pane
        .tab
        .map_or_else(|| c.window.id.to_string(), |t| t.id.to_string());
    let focus = (!pane.focused).then(|| {
        pane.tab
            .map(|t| Msg::Store(ardia_state::Action::ActivateTab { tab: t.id.clone() }))
    });
    let focus = focus.flatten();
    let mut controls = div().absolute().inset_0();
    if sidebar_toggle {
        let tip = crate::content::find_bar::with_shortcut(
            if tabs_shown { "Hide Tabs" } else { "Show Tabs" },
            crate::keybindings::hint(c.state, "toggleSidebar"),
        );
        controls = controls.child(
            div()
                .absolute()
                .left(px(centers[0] - row.button / 2.0))
                .top(px(row.center - row.button / 2.0))
                .child(crate::onboarding::tour::probe(
                    c.window.id.clone(),
                    crate::onboarding::tour::Anchor::SidebarButton,
                ))
                .child(
                    IconButton::new("toolbar-sidebar", tabs_toggle_icon(c.state, window_id), c.p)
                        .square(row.button, row.button_radius)
                        .glyph(toolbar::GLYPH)
                        .color(bar.ink.icon)
                        .fills(bar.ink.hover, bar.ink.pressed)
                        .tooltip(tip, c.p)
                        .on_click(c.emit.click(Msg::command("toggleSidebar"))),
                ),
        );
    }
    if let Some(shown) = pane.tab {
        let history = crate::content::nav_buttons::history_of(c.state, shown, c.host.as_ref());
        let back = crate::content::nav_buttons::back_msgs(
            c.state,
            shown,
            c.host.back_to_new_tab(&shown.id),
        );
        for (id, direction, center, hint) in [
            (
                "toolbar-back",
                crate::window::page_overlays::HistoryDirection::Back,
                centers[1],
                "back",
            ),
            (
                "toolbar-forward",
                crate::window::page_overlays::HistoryDirection::Forward,
                centers[2],
                "forward",
            ),
        ] {
            controls = controls.child(crate::content::nav_buttons::HistoryButton {
                id,
                direction,
                tab: Arc::clone(shown),
                history,
                place: crate::content::nav_buttons::NavPlace::centered(center, row),
                ink: bar.ink,
                hint: crate::keybindings::hint(c.state, hint),
                p: *c.p,
                emit: c.emit.clone(),
                host: Arc::clone(c.host),
                back: back.clone(),
                focus: focus.clone(),
            });
        }
    }
    controls = controls.child(crate::content::nav_buttons::ReloadButton {
        tab: pane.tab.cloned(),
        loading: tab.is_some_and(|t| t.live.loading),
        place: crate::content::nav_buttons::NavPlace::centered(centers[3], row),
        ink: bar.ink,
        hint: crate::keybindings::hint(c.state, "reload"),
        p: *c.p,
        emit: c.emit.clone(),
        window: c.window.id.clone(),
        focus: focus.clone(),
    });
    if let Some(shown) = tab.filter(|_| !new_tab) {
        controls = controls.child(address(
            &bar,
            shown,
            feed,
            plan.field_left,
            plan.field_width,
            pane.in_split,
            focus,
        ));
    }
    if let Some(shown) = tab.filter(|_| plan.items.count() > 0) {
        controls = controls.child(trailing(&bar, shown, actions, plan.items, plan.trailing));
    }
    if let Some(shown) = tab.filter(|_| pane.in_split) {
        controls = controls.child(pane_buttons(&bar, shown, plan.trailing.items_right));
    }
    if let Some((items, _)) = plugin_items {
        controls = controls.child(items);
    }
    div()
        .id(SharedString::from(format!("toolbar:{key}")))
        .debug_selector(|| "toolbar".into())
        .on_scroll(crate::window::page_overlays::tab_swipe_handler(
            c.emit,
            c.state.settings.swipe_between_tabs,
        ))
        .absolute()
        .left(px(pane.left))
        .top_0()
        .w(px(pane.width))
        .h(px(row.height))
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count >= 2 {
                window.titlebar_double_click();
            } else {
                window.start_window_move();
            }
        })
        .child({
            let (top_left, top_right) = band_corners(c.layout.frame.radius);
            Band {
                key: SharedString::from(format!("toolbar-band:{key}")),
                color: bar.ink.fill,
                top_left,
                top_right,
            }
        })
        .child(Dimmed {
            key: SharedString::from(format!("toolbar-dim:{key}")),
            focused: pane.focused,
            body: controls.into_any_element(),
        })
        .when(tab.is_some_and(|t| !t.url.is_empty()), |this| {
            this.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .h(px(DIVIDER))
                    .bg(bar.ink.divider),
            )
        })
        .into_any_element()
}

fn pane_buttons(bar: &Bar, tab: &Tab, right: f32) -> AnyElement {
    let c = bar.c;
    let row = bar.row;
    let ink = bar.ink;
    let vertical = c
        .state
        .split_of(tab.id.as_str())
        .is_some_and(|split| split.orientation == ardia_state::model::Orientation::Vertical);
    let split_emit = c.emit.clone();
    let split_tab = tab.id.clone();
    div()
        .id("toolbar-pane-buttons")
        .absolute()
        .right(px(right))
        .top(px(row.center - row.button / 2.0))
        .flex()
        .items_center()
        .gap(px(toolbar::ITEM_GAP))
        .child({
            let (hover, pressed) = (ink.hover, ink.pressed);
            div()
                .id("toolbar-pane-split")
                .flex_none()
                .size(px(row.button))
                .rounded(px(row.button_radius))
                .flex()
                .items_center()
                .justify_center()
                .hover(move |s| s.bg(hover))
                .active(move |s| s.bg(pressed))
                .tooltip(crate::primitives::controls::tooltip(
                    "Split View".into(),
                    c.p,
                ))
                .on_mouse_down(MouseButton::Left, {
                    let look = crate::content::pane_drag::PaneButtonLook {
                        size: row.button,
                        radius: row.button_radius,
                        glyph: if vertical {
                            Icon::SplitVertical
                        } else {
                            Icon::Split
                        },
                        glyph_size: toolbar::GLYPH,
                        fill: ink.pressed,
                        ink: ink.icon,
                    };
                    let tab = tab.id.clone();
                    move |event, window, cx| {
                        cx.stop_propagation();
                        crate::content::pane_drag::press(
                            tab.clone(),
                            look.clone(),
                            event,
                            window,
                            cx,
                        )
                    }
                })
                .on_click(move |event, window, cx| {
                    cx.stop_propagation();
                    if !crate::content::pane_drag::click_allowed(window, cx) {
                        return;
                    }
                    split_emit.send(
                        Msg::Menu(Some((
                            crate::msg::MenuTarget::SplitPane(split_tab.clone()),
                            event.position(),
                        ))),
                        window,
                        cx,
                    )
                })
                .child(icon(
                    if vertical {
                        Icon::SplitVertical
                    } else {
                        Icon::Split
                    },
                    toolbar::GLYPH,
                    ink.icon,
                ))
        })
        .child(
            IconButton::new("toolbar-pane-close", Icon::XMark, c.p)
                .square(row.button, row.button_radius)
                .glyph(toolbar::GLYPH)
                .color(ink.icon)
                .fills(ink.hover, ink.pressed)
                .tooltip("Close Pane", c.p)
                .on_click(c.emit.click(Msg::CloseTab(tab.id.clone()))),
        )
        .into_any_element()
}

pub fn lower_pane(c: &Chrome, tab: &TabId, rect: Rect, content: AnyElement) -> AnyElement {
    let shown = c
        .state
        .tab(tab.as_str())
        .filter(|_| rect.y > 0.5 && c.layout.toolbar > 0.0);
    let Some(shown) = shown else {
        return content;
    };
    let row = toolbar::row(c.state.settings.compact_toolbar);
    div()
        .size_full()
        .relative()
        .child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .top(px(row.height))
                .bottom_0()
                .child(content),
        )
        .child(pane_bar(
            c,
            PaneBar {
                tab: Some(shown),
                left: 0.0,
                width: rect.w,
                leading: false,
                in_split: true,
                focused: c.is_active(tab),
            },
            &ToolbarFeed::default(),
        ))
        .into_any_element()
}

pub fn toolbar(c: &Chrome, card: Rect, _sidebar_toggle: bool, feed: &ToolbarFeed) -> AnyElement {
    let Some(active) = c.active else {
        return pane_bar(
            c,
            PaneBar {
                tab: None,
                left: 0.0,
                width: card.w,
                leading: true,
                in_split: false,
                focused: true,
            },
            feed,
        );
    };
    let row = toolbar::row(c.state.settings.compact_toolbar);
    if c.layout.toolbar < row.height - 0.5 {
        let full = pane_bar(
            c,
            PaneBar {
                tab: Some(active),
                left: 0.0,
                width: card.w,
                leading: true,
                in_split: false,
                focused: true,
            },
            feed,
        );
        return crate::content::auto_hide::collapsed_bar(c, active, card.w, row.height, full);
    }
    let Some(split) = c.state.split_of(active.id.as_str()) else {
        return pane_bar(
            c,
            PaneBar {
                tab: Some(active),
                left: 0.0,
                width: card.w,
                leading: true,
                in_split: false,
                focused: true,
            },
            feed,
        );
    };
    let page = c.layout.page();
    let panes =
        crate::content::split_view::pane_rects(split, page.w, page.h, c.layout.frame.split_gap);
    div()
        .id("toolbar-panes")
        .absolute()
        .inset_0()
        .children(
            panes
                .into_iter()
                .filter(|(_, rect)| rect.y <= 0.5)
                .filter_map(|(id, rect)| {
                    let tab = c.state.tab(id.as_str())?;
                    Some(pane_bar(
                        c,
                        PaneBar {
                            tab: Some(tab),
                            left: rect.x,
                            width: rect.w,
                            leading: rect.x <= 0.5,
                            in_split: true,
                            focused: c.is_active(&id),
                        },
                        feed,
                    ))
                }),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_site_color_band_rounds_only_the_corners_that_touch_the_card() {
        assert_eq!(band_corners(8.5), (8.5, 8.5));
        assert_eq!(band_corners(0.0), (0.0, 0.0));
    }

    #[test]
    fn urls_split_into_a_bright_host_and_a_dim_path() {
        assert_eq!(
            split_url("https://www.example.com/docs/page?q=1"),
            ("example.com".to_owned(), "/docs/page?q=1".to_owned())
        );
        assert_eq!(
            split_url("https://news.ycombinator.com/"),
            ("news.ycombinator.com".to_owned(), String::new())
        );
    }

    #[test]
    fn the_field_trail_follows_the_old_url_trail() {
        assert_eq!(
            url_trail("ardia://bookmarks", "Bookmarks", false, false),
            " / Bookmarks"
        );
        assert_eq!(
            url_trail("https://github.com/a/b", "GitHub", false, false),
            ""
        );
        assert_eq!(
            url_trail("https://github.com/a/b/", "", false, true),
            "/a/b"
        );
        assert_eq!(
            url_trail("https://github.com/a/b/", "", true, false),
            "/a/b/"
        );
        assert_eq!(
            url_trail("file:///Users/me/My%20Notes.txt", "", true, false),
            " /Users/me/My Notes.txt"
        );
        assert_eq!(page_host_label("file:///x"), "File");
        assert_eq!(
            url_trail("file:///bad%E0%A4", "", true, false),
            " /bad%E0%A4"
        );
        assert_eq!(page_host_label("ardia://history"), "ardia://history");
    }

    #[test]
    fn empty_urls_are_the_new_tab_page() {
        assert!(is_new_tab_page(None));
    }

    #[test]
    fn the_field_runs_to_the_card_edge_when_nothing_trails_it() {
        let alone = trailing_layout(&toolbar::REGULAR, 0, 10.0);
        assert!((alone.field_right - 6.2).abs() < 1e-4);
        let round = trailing_layout(&toolbar::REGULAR, 0, 16.0);
        assert!((round.field_right - 8.0).abs() < 1e-4);
        let plan = plan(&toolbar::REGULAR, 1300.0, 10.0, true, false, 0);
        assert_eq!(plan.field_left, 145.0);
        assert!((plan.field_left + plan.field_width - (1300.0 - 6.2)).abs() < 1e-3);
    }

    #[test]
    fn trailing_items_sit_on_the_legacy_ink_grid() {
        let one = trailing_layout(&toolbar::REGULAR, 1, 10.0);
        assert_eq!(one.items_right, 8.0);
        assert_eq!(one.items_width, 28.0);
        assert_eq!(one.field_right, 8.0 + 28.0 + 14.0 - 6.0);
        let three = trailing_layout(&toolbar::REGULAR, 3, 10.0);
        assert_eq!(three.items_width, 3.0 * 30.0 - 2.0);
    }

    #[test]
    fn crowded_toolbars_fold_actions_into_an_overflow_button() {
        assert_eq!(
            trailing_items(false, 3, 10),
            TrailingItems {
                cast: false,
                actions: 3,
                overflow: false
            }
        );
        assert_eq!(
            trailing_items(true, 5, 4),
            TrailingItems {
                cast: true,
                actions: 2,
                overflow: true
            }
        );
        assert_eq!(trailing_items(false, 0, 0).count(), 0);
        assert_eq!(items_fitting(&toolbar::REGULAR, 88.0), 3);
        assert_eq!(items_fitting(&toolbar::REGULAR, 27.0), 0);
        let narrow = plan(&toolbar::REGULAR, 400.0, 10.0, true, false, 20);
        assert!(narrow.field_width >= FIELD_MIN_WIDTH - 1e-3);
        assert!(narrow.items.overflow);
    }

    #[test]
    fn field_buttons_follow_the_legacy_visibility_rules() {
        let base = FieldInputs {
            mode: AddressBarButtons::Hover,
            hovered: false,
            in_split: false,
            reader_active: false,
            reader_available: true,
            zoomed: true,
            zoom_open: false,
            popups: 0,
            insecure: false,
        };
        let rest = field_buttons(&base);
        assert!(!rest.page && !rest.split && !rest.site_controls);
        assert!(!rest.reader && !rest.zoom && !rest.popups && !rest.lock);
        let hovered = field_buttons(&FieldInputs {
            hovered: true,
            ..base
        });
        assert!(hovered.page && hovered.split && hovered.site_controls);
        assert!(hovered.reader && hovered.zoom);
        let always = field_buttons(&FieldInputs {
            mode: AddressBarButtons::Always,
            in_split: true,
            popups: 2,
            insecure: true,
            ..base
        });
        assert!(always.page && !always.split && always.popups && always.lock);
        let reading = field_buttons(&FieldInputs {
            reader_active: true,
            reader_available: false,
            ..base
        });
        assert!(reading.reader);
    }

    #[test]
    fn hiding_the_sidebar_button_shifts_the_nav_left_by_one_pitch() {
        assert_eq!(icon_centers(true), toolbar::ICON_CENTERS);
        assert_eq!(icon_centers(false), [-14.0, 21.0, 57.0, 92.0]);
        assert_eq!(breadcrumb_x(false), toolbar::BREADCRUMB_X - 35.0);
    }
}
