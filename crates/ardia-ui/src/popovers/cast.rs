use ardia_state::{Action, TabId};
use ardia_theme::layout::panel;
use ardia_theme::tokens::{TypeSize, space};
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, ParentElement, Pixels, Point, SharedString, Styled,
    div, prelude::*, rgba,
};

use crate::host_data::{CastDevice, CastDeviceKind, CastPanel};
use crate::msg::{MenuTarget, Msg};
use crate::popovers::panel::{header, icon_tile, pill, surface, value_button};
use crate::primitives::controls::spinner;
use crate::primitives::icons::{Icon, icon};
use crate::scale::px;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const WIDTH: f32 = 340.0;
pub const LIST_MAX_HEIGHT: f32 = 280.0;
pub const ROW_MIN_HEIGHT: f32 = 42.0;
pub const LOCAL_NETWORK_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork";
pub const LOCAL_NETWORK_MESSAGE: &str = "Ardia needs Local Network access to find Cast devices.";
pub const LOCAL_NETWORK_LINK: &str = "Open Local Network Settings";
pub const LOOKING_MESSAGE: &str =
    "Looking for devices… Cast devices need to be on the same Wi\u{2011}Fi network as this Mac.";

pub fn device_icon(kind: CastDeviceKind) -> Icon {
    match kind {
        CastDeviceKind::Tv => Icon::Tv,
        CastDeviceKind::Display => Icon::Display,
        CastDeviceKind::SpeakerGroup => Icon::HifiSpeakers,
        CastDeviceKind::Speaker => Icon::HifiSpeaker,
    }
}

fn tile_fill(c: &Chrome) -> Hsla {
    if c.look.dark {
        rgba(0xFFFFFF14).into()
    } else {
        rgba(0x0000000D).into()
    }
}

pub fn width_in(page_width: f32) -> f32 {
    WIDTH.min(page_width - 24.0).max(0.0)
}

pub fn placement(c: &Chrome) -> Rect {
    let page = c.layout.page();
    let width = width_in(page.w);
    Rect::new(
        page.right() - width - panel::POPOVER_MARGIN,
        page.y + panel::POPOVER_MARGIN,
        width,
        0.0,
    )
}

fn device_row(c: &Chrome, tab: &TabId, device: &CastDevice) -> AnyElement {
    let p = c.p;
    let active = device.casting();
    let busy = device.state.busy();
    let detail = device.detail().to_owned();
    let alarming = !device.issue.is_empty();
    let id = device.id.clone();
    let hover = p.row_hover;
    div()
        .id(SharedString::from(format!("cast-device:{id}")))
        .debug_selector({
            let id = id.clone();
            move || format!("cast-device:{id}")
        })
        .min_h(px(ROW_MIN_HEIGHT))
        .rounded(px(panel::ROW_RADIUS))
        .flex()
        .items_center()
        .gap(px(panel::ICON_GAP))
        .px(px(panel::ROW_PADDING))
        .py(px(space::XS))
        .when(!active, |this| this.hover(move |style| style.bg(hover)))
        .when(!active && !busy, |this| {
            this.cursor_pointer()
                .on_click(c.emit.click(Msg::StartCasting {
                    tab: tab.clone(),
                    device: id.clone(),
                }))
        })
        .child(icon_tile(
            device_icon(device.kind),
            if active { p.accent } else { tile_fill(c) },
            if active { gpui::white() } else { p.icon },
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .truncate()
                        .text_size(px(TypeSize::Body.points()))
                        .line_height(px(TypeSize::Body.line_height()))
                        .child(SharedString::from(device.name.clone())),
                )
                .when(!detail.is_empty(), |this| {
                    this.child(
                        div()
                            .truncate()
                            .text_size(px(TypeSize::Caption.points()))
                            .line_height(px(TypeSize::Caption.line_height()))
                            .text_color(if alarming {
                                p.destructive
                            } else {
                                p.text_secondary
                            })
                            .child(SharedString::from(detail)),
                    )
                }),
        )
        .when(busy, |this| this.child(spinner(16., p.text_secondary)))
        .when(active, |this| {
            this.child(
                div()
                    .debug_selector({
                        let id = id.clone();
                        move || format!("cast-stop:{id}")
                    })
                    .child(pill(
                        SharedString::from(format!("cast-stop:{id}")),
                        "Stop",
                        p,
                        {
                            let emit = c.emit.clone();
                            let msg = Msg::StopCasting {
                                tab: tab.clone(),
                                device: id.clone(),
                            };
                            move |_, window, cx| emit.send(msg.clone(), window, cx)
                        },
                    )),
            )
        })
        .into_any_element()
}

fn permission_message(c: &Chrome) -> AnyElement {
    let p = c.p;
    let accent = p.accent;
    div()
        .px(px(panel::INSET))
        .pt(px(space::XS))
        .flex()
        .flex_col()
        .gap(px(space::XS))
        .child(
            div()
                .text_size(px(TypeSize::Small.points()))
                .text_color(p.text_secondary)
                .child(LOCAL_NETWORK_MESSAGE),
        )
        .child(
            div()
                .id("cast-network-settings")
                .debug_selector(|| "cast-network-settings".into())
                .text_size(px(TypeSize::Small.points()))
                .font_weight(FontWeight::MEDIUM)
                .text_color(accent)
                .cursor_pointer()
                .hover(|style| style.underline())
                .on_click(|_, _, cx| cx.open_url(LOCAL_NETWORK_SETTINGS))
                .child(LOCAL_NETWORK_LINK),
        )
        .into_any_element()
}

fn looking(c: &Chrome) -> AnyElement {
    let p = c.p;
    div()
        .debug_selector(|| "cast-looking".into())
        .flex()
        .items_center()
        .gap(px(space::M))
        .px(px(panel::INSET))
        .pt(px(space::XS))
        .pb(px(space::XS))
        .child(spinner(14., p.text_secondary))
        .child(
            div()
                .flex_1()
                .text_size(px(TypeSize::Small.points()))
                .text_color(p.text_secondary)
                .child(LOOKING_MESSAGE),
        )
        .into_any_element()
}

pub fn sources_anchor(c: &Chrome) -> Point<Pixels> {
    let at = placement(c);
    gpui::point(
        gpui::px(crate::scale::current() * (at.x + at.w - panel::INSET)),
        gpui::px(crate::scale::current() * (at.y + panel::INSET + panel::ICON_SLOT)),
    )
}

pub fn cast_popover(c: &Chrome, tab: &TabId, data: Option<&CastPanel>) -> Option<AnyElement> {
    let data = data?;
    let p = c.p;
    let at = placement(c);
    let close = Msg::Store(Action::SetPopover {
        window: c.window.id.clone(),
        popover: None,
    });
    let available: Vec<&CastDevice> = data.shown_devices().collect();
    let sources = data.can_screen().then(|| {
        let emit = c.emit.clone();
        let menu = Msg::Menu(Some((
            MenuTarget::CastSource(tab.clone()),
            sources_anchor(c),
        )));
        div()
            .debug_selector(|| "cast-sources".into())
            .child(value_button(
                "cast-sources",
                "Sources",
                Icon::ChevronDown,
                p,
                move |_, window, cx| emit.send(menu.clone(), window, cx),
            ))
            .into_any_element()
    });
    let body = if data.permission_rejected {
        permission_message(c)
    } else if available.is_empty() {
        looking(c)
    } else {
        div()
            .id("cast-devices")
            .max_h(px(LIST_MAX_HEIGHT))
            .overflow_y_scroll()
            .px(px(panel::ROW_INSET))
            .flex()
            .flex_col()
            .gap(px(space::XXS))
            .children(
                available
                    .into_iter()
                    .map(|device| device_row(c, tab, device)),
            )
            .into_any_element()
    };
    let card = surface("cast-popover", at.w, p)
        .debug_selector(|| "cast-popover".into())
        .pb(px(panel::INSET))
        .child(header(
            icon(Icon::TvAndMediabox, 14., p.icon).into_any_element(),
            data.title().to_owned(),
            sources,
            p,
        ))
        .child(body)
        .child(
            div()
                .flex()
                .justify_end()
                .px(px(panel::INSET))
                .mt(px(space::ML))
                .child(div().debug_selector(|| "cast-done".into()).child(pill(
                    "cast-done",
                    "Done",
                    p,
                    {
                        let emit = c.emit.clone();
                        move |_, window, cx| emit.send(close.clone(), window, cx)
                    },
                ))),
        );
    Some(
        div()
            .absolute()
            .left(px(at.x))
            .top(px(at.y))
            .child(crate::primitives::appear::rise(
                "cast-popover-in",
                card,
                crate::primitives::appear::Rise::popover(
                    crate::primitives::appear::OriginX::Right,
                    false,
                ),
            ))
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_use_the_old_sink_icons() {
        assert_eq!(device_icon(CastDeviceKind::from_icon(0)), Icon::Tv);
        assert_eq!(
            device_icon(CastDeviceKind::from_icon(1)),
            Icon::HifiSpeakers
        );
        assert_eq!(device_icon(CastDeviceKind::from_icon(2)), Icon::HifiSpeaker);
        assert_eq!(device_icon(CastDeviceKind::from_icon(6)), Icon::Display);
        assert_eq!(device_icon(CastDeviceKind::from_icon(7)), Icon::Tv);
        assert_eq!(device_icon(CastDeviceKind::from_icon(99)), Icon::Tv);
    }

    #[test]
    fn the_picker_is_as_wide_as_the_old_one_and_fits_a_narrow_pane() {
        assert_eq!(width_in(1200.0), WIDTH);
        assert_eq!(width_in(300.0), 276.0);
    }
}
