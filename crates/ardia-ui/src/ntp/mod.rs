pub mod extras;
pub mod motion;
pub mod personalize;
pub mod power_up;

use std::sync::{Arc, OnceLock};

use crate::scale::px;
use ardia_state::TabId;
use ardia_state::tabs::Tab;
use ardia_state::windows::WindowKind;
use ardia_theme::ProfileColor;
use ardia_theme::layout::command_bar;
use ardia_theme::motion::Spring;
use ardia_theme::profile_theme::ThemeFamily;
use gpui::{
    AnyElement, Image, ImageFormat, IntoElement, ParentElement, RenderOnce, Styled, div, img,
    prelude::*,
};

use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const MARK_SIZE: f32 = 100.0;
pub const MARK_ABOVE_BAR: f32 = 84.1;
pub const DIA_OFFSET: f32 = 1.0;
pub const BAR_EDGE_ROOM: f32 = 28.0;
pub const CENTRE_LIFT: f32 = 158.0;
pub const MIN_CENTRED_TOP: f32 = 100.0;
pub const BAR_DROP: f32 = 38.0;
pub const HEADING_GAP_ABOVE_MARK: f32 = 12.0;
pub const HEADING_EDGE: f32 = 16.0;
pub const HEADING_HEIGHT: f32 = 74.0;
pub const HEADING_GAP: f32 = 6.0;
pub const HEADING_ROW_GAP: f32 = 10.0;
pub const HEADING_ICON: f32 = 24.0;
pub const HEADING_ICON_WIDTH: f32 = 32.0;
pub const HEADING_ICON_HEIGHT: f32 = 28.0;
pub const HEADING_TITLE: f32 = 26.0;
pub const HEADING_BLURB_WIDTH: f32 = 460.0;
pub const HEADING_BLURB_LINE: f32 = 18.0;
pub const INCOGNITO_BLURB: &str = "Pages you visit here aren't saved to your history. Cookies and site data are deleted when you close all Incognito windows.";

pub fn mark_image() -> Arc<Image> {
    static MARK: OnceLock<Arc<Image>> = OnceLock::new();
    Arc::clone(MARK.get_or_init(|| {
        Arc::new(Image::from_bytes(
            ImageFormat::Svg,
            include_bytes!("../../assets/ardia-mark.svg").to_vec(),
        ))
    }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkLayer {
    Sun,
    Back,
    Front,
}

impl MarkLayer {
    pub const PAINT_ORDER: [MarkLayer; 3] = [MarkLayer::Sun, MarkLayer::Back, MarkLayer::Front];
}

macro_rules! mark_bytes {
    ($($color:ident => $name:literal),+ $(,)?) => {
        fn mark_bytes(color: ProfileColor, layer: MarkLayer) -> &'static [u8] {
            match (color, layer) {
                $(
                    (ProfileColor::$color, MarkLayer::Sun) => include_bytes!(concat!("../../assets/ntp-mark/", $name, "-sun.png")),
                    (ProfileColor::$color, MarkLayer::Back) => include_bytes!(concat!("../../assets/ntp-mark/", $name, "-back.png")),
                    (ProfileColor::$color, MarkLayer::Front) => include_bytes!(concat!("../../assets/ntp-mark/", $name, "-front.png")),
                )+
            }
        }
    };
}

mark_bytes! {
    Plum => "plum",
    Blue => "blue",
    Purple => "purple",
    Pink => "pink",
    Red => "red",
    Orange => "orange",
    Yellow => "yellow",
    Green => "green",
    Neutral => "neutral",
}

pub fn mark_layer(color: ProfileColor, layer: MarkLayer) -> Arc<Image> {
    static LAYERS: OnceLock<Vec<(ProfileColor, MarkLayer, Arc<Image>)>> = OnceLock::new();
    let layers = LAYERS.get_or_init(|| {
        ProfileColor::ALL
            .iter()
            .flat_map(|&color| {
                MarkLayer::PAINT_ORDER.iter().map(move |&layer| {
                    (
                        color,
                        layer,
                        Arc::new(Image::from_bytes(
                            ImageFormat::Png,
                            mark_bytes(color, layer).to_vec(),
                        )),
                    )
                })
            })
            .collect()
    });
    layers
        .iter()
        .find(|(c, l, _)| *c == color && *l == layer)
        .map_or_else(mark_image, |(_, _, image)| Arc::clone(image))
}

pub fn mark_color(family: ThemeFamily, incognito: bool) -> ProfileColor {
    match family {
        _ if incognito => ProfileColor::Neutral,
        ThemeFamily::Preset(color) => color,
        ThemeFamily::Incognito => ProfileColor::Neutral,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NtpGeometry {
    pub bar: Rect,
    pub mark: Rect,
}

pub fn bar_width(view_width: f32) -> f32 {
    crate::omnibox::frame::bar_width(view_width)
}

pub fn bar_top(height: f32, heading_height: f32) -> f32 {
    let centred = (height / 2.0 - CENTRE_LIFT).max(MIN_CENTRED_TOP) + BAR_DROP + DIA_OFFSET;
    let reserve = if heading_height > 0.0 {
        HEADING_EDGE + heading_height + HEADING_GAP_ABOVE_MARK + MARK_ABOVE_BAR
    } else {
        0.0
    };
    centred.max(reserve)
}

pub fn heading_top(bar_top: f32, heading_height: f32) -> f32 {
    bar_top - MARK_ABOVE_BAR - HEADING_GAP_ABOVE_MARK - heading_height
}

pub fn geometry(page: Rect) -> NtpGeometry {
    geometry_with_heading(page, false)
}

pub fn geometry_with_heading(page: Rect, heading: bool) -> NtpGeometry {
    let width = bar_width(page.w).max(0.0);
    let x = page.x + (page.w / 2.0 - width / 2.0).max(command_bar::NTP_MIN_X) + DIA_OFFSET;
    let top = page.y + bar_top(page.h, if heading { HEADING_HEIGHT } else { 0.0 });
    NtpGeometry {
        bar: Rect::new(x, top, width, command_bar::NTP_HEIGHT),
        mark: Rect::new(
            page.x + page.w / 2.0 + DIA_OFFSET - MARK_SIZE / 2.0,
            top - MARK_ABOVE_BAR,
            MARK_SIZE,
            MARK_ABOVE_BAR,
        ),
    }
}

pub const SUN_DRIFT: f32 = 6.0;
pub const INTRO_SPRING: Spring = Spring::new(0.4, 0.85);
pub const INTRO_LENGTH: f64 = 1.6;

pub fn intro_layer(layer: MarkLayer) -> (f32, f64) {
    match layer {
        MarkLayer::Sun => (80.0, 0.25),
        MarkLayer::Back => (46.0, 0.17),
        MarkLayer::Front => (48.0, 0.08),
    }
}

pub fn intro_offsets(layer: MarkLayer, seconds: f64) -> (f32, f32) {
    let (hidden, delay) = intro_layer(layer);
    let rise = 1.0 - INTRO_SPRING.value(seconds - delay, 0.0) as f32;
    let drift = if layer == MarkLayer::Sun {
        SUN_DRIFT * (1.0 - INTRO_SPRING.value(seconds - 0.25, 0.0) as f32)
    } else {
        0.0
    };
    (drift, hidden * rise)
}

thread_local! {
    static INTRO_STARTS: std::cell::RefCell<std::collections::HashMap<TabId, std::time::Instant>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

fn intro_seconds(tab: &TabId) -> f64 {
    INTRO_STARTS.with(|starts| {
        let mut starts = starts.borrow_mut();
        let start = *starts
            .entry(tab.clone())
            .or_insert_with(std::time::Instant::now);
        start.elapsed().as_secs_f64()
    })
}

#[derive(IntoElement)]
struct Mark {
    tab: TabId,
    color: ProfileColor,
    at: Rect,
}

impl RenderOnce for Mark {
    fn render(self, window: &mut gpui::Window, cx: &mut gpui::App) -> impl IntoElement {
        let seconds = if cx.reduce_motion() {
            INTRO_LENGTH
        } else {
            intro_seconds(&self.tab)
        };
        if seconds < INTRO_LENGTH {
            window.request_animation_frame();
        }
        let color = self.color;
        div()
            .id("ntp-mark")
            .debug_selector(|| "ntp-mark".into())
            .absolute()
            .left(px(self.at.x))
            .top(px(self.at.y))
            .w(px(self.at.w))
            .h(px(self.at.h))
            .overflow_hidden()
            .children(MarkLayer::PAINT_ORDER.iter().map(move |&layer| {
                let (x, y) = if seconds < INTRO_LENGTH {
                    intro_offsets(layer, seconds)
                } else {
                    (0.0, 0.0)
                };
                img(mark_layer(color, layer))
                    .absolute()
                    .left(px(x))
                    .top(px(y))
                    .size(px(MARK_SIZE))
            }))
    }
}

fn power_up(c: &Chrome, tab: &Tab, page: Rect, bar: Rect) -> Option<AnyElement> {
    let palette = &c.look.theme.power_up_palette;
    if palette.is_empty() || intro_seconds(&tab.id) >= f64::from(power_up::PAGE_SECONDS) {
        return None;
    }
    let request = power_up::PowerUpRequest {
        key: tab.id.as_str().to_owned(),
        page: [page.w, page.h],
        halo: [bar.x, bar.y, bar.w, bar.h],
        palette: palette.iter().map(|c| [c.r, c.g, c.b, c.a]).collect(),
        dark: c.look.dark,
        corner_radius: command_bar::NTP_RADIUS + power_up::HALO_CORNER_EXTRA,
        speed: power_up::SPEED,
        origin: power_up::ORIGIN,
    };
    Some(power_up::PowerUpLayer::new(&tab.id, request, Arc::clone(c.host)).into_any_element())
}

fn mark(c: &Chrome, tab: &Tab, at: Rect, page: Rect) -> AnyElement {
    Mark {
        tab: tab.id.clone(),
        color: mark_color(c.look.theme.nearest, c.window.kind == WindowKind::Incognito),
        at: Rect::new(at.x - page.x, at.y - page.y, at.w, at.h),
    }
    .into_any_element()
}

fn incognito_heading(c: &Chrome, bar: Rect, page: Rect) -> AnyElement {
    let top = heading_top(bar.y - page.y, HEADING_HEIGHT);
    div()
        .id("ntp-incognito-heading")
        .debug_selector(|| "ntp-incognito-heading".into())
        .absolute()
        .left(px(bar.x - page.x))
        .top(px(top))
        .w(px(bar.w))
        .h(px(HEADING_HEIGHT))
        .flex()
        .flex_col()
        .items_center()
        .justify_end()
        .gap(px(HEADING_GAP))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(HEADING_ROW_GAP))
                .child(
                    div()
                        .w(px(HEADING_ICON_WIDTH))
                        .h(px(HEADING_ICON_HEIGHT))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon(Icon::Incognito, HEADING_ICON, c.p.text)),
                )
                .child(
                    div()
                        .text_size(px(HEADING_TITLE))
                        .line_height(px(ardia_theme::tokens::DISPLAY_LINE_HEIGHT))
                        .font_weight(gpui::FontWeight::BOLD)
                        .text_color(c.p.text)
                        .child("Incognito"),
                ),
        )
        .child(
            div()
                .max_w(px(HEADING_BLURB_WIDTH))
                .text_center()
                .text_size(px(13.))
                .line_height(px(HEADING_BLURB_LINE))
                .text_color(c.p.text_secondary)
                .child(INCOGNITO_BLURB),
        )
        .into_any_element()
}

pub fn new_tab_page(c: &Chrome, page: Rect, tab: &Tab) -> AnyElement {
    let incognito = c.window.kind == WindowKind::Incognito;
    let geometry = geometry_with_heading(page, incognito);
    let bar = geometry.bar;
    let local = Rect::new(bar.x - page.x, bar.y - page.y, bar.w, bar.h);
    div()
        .id("new-tab-page")
        .debug_selector(|| "new-tab-page".into())
        .absolute()
        .left(px(page.x))
        .top(px(page.y))
        .w(px(page.w))
        .h(px(page.h))
        .when_some(power_up(c, tab, page, local), |this, layer| {
            this.child(layer)
        })
        .when(incognito, |this| {
            this.child(incognito_heading(c, bar, page))
        })
        .child(mark(c, tab, geometry.mark, page))
        .child(crate::omnibox::view::hero_bar(c, local))
        .child(extras::NtpExtrasLayer::new(
            c,
            page,
            local,
            if incognito {
                div().into_any_element()
            } else {
                personalize::PersonalizeCorner::new(c).into_any_element()
            },
        ))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bar_and_mark_follow_the_legacy_new_tab_layout() {
        let page = Rect::new(190.0, 50.0, 1315.0, 895.0);
        let geometry = geometry(page);
        assert_eq!(geometry.bar.w, 652.0);
        assert_eq!(geometry.bar.h, 112.0);
        assert_eq!(geometry.bar.x, 190.0 + 331.5 + 1.0);
        assert_eq!(geometry.bar.y, 50.0 + 327.5 + 1.0);
        assert_eq!(geometry.mark.w, MARK_SIZE);
        assert!((geometry.mark.h - MARK_ABOVE_BAR).abs() < 1e-4);
        assert!((geometry.mark.bottom() - geometry.bar.y).abs() < 1e-4);
        assert_eq!(
            geometry.mark.x + MARK_SIZE / 2.0,
            190.0 + 1315.0 / 2.0 + 1.0
        );
    }

    #[test]
    fn narrow_pages_keep_room_beside_the_bar() {
        assert_eq!(bar_width(600.0), 572.0);
        assert_eq!(bar_width(700.0), 616.0);
        assert_eq!(bar_width(1800.0), 774.0);
    }

    #[test]
    fn every_profile_colour_has_all_three_mark_layers() {
        for color in ProfileColor::ALL {
            for layer in MarkLayer::PAINT_ORDER {
                let bytes = mark_bytes(color, layer);
                assert!(bytes.starts_with(b"\x89PNG"), "{color:?} {layer:?}");
            }
        }
        assert!(!mark_image().bytes().is_empty());
    }

    #[test]
    fn the_mark_layers_rise_in_order_and_settle() {
        let (_, sun_start) = intro_offsets(MarkLayer::Sun, 0.0);
        assert_eq!(sun_start, 80.0);
        let (drift, _) = intro_offsets(MarkLayer::Sun, 0.0);
        assert_eq!(drift, SUN_DRIFT);
        let (_, front) = intro_offsets(MarkLayer::Front, 0.2);
        let (_, back) = intro_offsets(MarkLayer::Back, 0.2);
        assert!(front < 48.0 && back > front * 0.5);
        for layer in MarkLayer::PAINT_ORDER {
            let (x, y) = intro_offsets(layer, INTRO_LENGTH);
            assert!(x.abs() < 0.5 && y.abs() < 0.5, "{layer:?}");
        }
    }

    #[test]
    fn private_windows_get_the_neutral_mark() {
        assert_eq!(
            mark_color(ThemeFamily::Preset(ProfileColor::Pink), true),
            ProfileColor::Neutral
        );
        assert_eq!(
            mark_color(ThemeFamily::Preset(ProfileColor::Pink), false),
            ProfileColor::Pink
        );
        assert_eq!(
            mark_color(ThemeFamily::Incognito, false),
            ProfileColor::Neutral
        );
    }
}
