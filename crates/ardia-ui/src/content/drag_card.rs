use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::TabId;
use gpui::{Hsla, Image, ImageSource, ObjectFit, ParentElement, Styled, StyledImage, div, img};

use crate::host::UiHost;
use crate::look::Palette;
use crate::primitives::controls::shadow;
use crate::primitives::favicon::{Favicon, render_favicon};
use crate::scale::px;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const CARD_WIDTH: f32 = 209.0;
pub const CARD_HEIGHT: f32 = 110.0;
pub const CARD_RADIUS: f32 = 4.0;
pub const PILL_RADIUS: f32 = 10.0;
pub const CARD_RIM: f32 = 0.5;
pub const CARD_RIM_ALPHA: f32 = 0.3;
pub const PILL_HOLD: Duration = Duration::from_millis(30);
pub const CARD_MORPH: Duration = Duration::from_millis(60);
const CARD_SHADOW: (f32, f32, f32) = (0.35, 16.0, 6.0);
const PLACEHOLDER_ICON: f32 = 64.0;
const PLACEHOLDER_TOP: f32 = 42.0;

#[derive(Clone)]
pub struct DragCard {
    pub host: Arc<dyn UiHost>,
    pub shown: Option<TabId>,
    pub window: [f32; 2],
    pub page: Rect,
    pub backdrop: Hsla,
    pub dark: bool,
    pub favicon: Option<Favicon>,
    pub p: Palette,
    pub window_picture: Option<Arc<gpui::RenderImage>>,
}

pub const WINDOW_SNAPSHOT_SCALE: f32 = 0.5;

pub fn bgra_from_rgba(mut image: image::RgbaImage) -> image::RgbaImage {
    for pixel in image.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    image
}

pub fn snapshot_window(window: &gpui::Window) -> Option<Arc<gpui::RenderImage>> {
    let image = window.render_to_image(WINDOW_SNAPSHOT_SCALE).ok()?;
    if image.width() == 0 || image.height() == 0 {
        return None;
    }
    Some(Arc::new(gpui::RenderImage::new([image::Frame::new(
        bgra_from_rgba(image),
    )])))
}

impl DragCard {
    pub fn snapped(mut self, window: &gpui::Window) -> Self {
        self.window_picture = snapshot_window(window);
        self
    }
}

impl std::fmt::Debug for DragCard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DragCard")
            .field("shown", &self.shown)
            .finish()
    }
}

impl DragCard {
    pub fn new(c: &Chrome, dragged: &TabId) -> Self {
        let on_screen = c.is_active(dragged)
            || c.active.is_some_and(|active| {
                c.state
                    .split_of(active.id.as_str())
                    .is_some_and(|split| split.tab_ids().contains(dragged))
            });
        let shown = if on_screen {
            Some(dragged.clone())
        } else {
            c.active.map(|t| t.id.clone())
        };
        let favicon = shown
            .as_ref()
            .and_then(|id| c.state.tab(id.as_str()))
            .map(|tab| c.favicon(tab));
        DragCard {
            host: Arc::clone(c.host),
            shown,
            window: [c.layout.width, c.layout.height],
            page: c.layout.page(),
            backdrop: crate::primitives::theme_bridge::hsla(c.look.theme.window_tint[0]),
            dark: c.p.dark,
            favicon,
            p: *c.p,
            window_picture: None,
        }
    }

    fn picture(&self) -> Option<Arc<Image>> {
        self.shown
            .as_ref()
            .and_then(|tab| self.host.tab_preview(tab))
    }
}

pub fn card_fit(window: [f32; 2]) -> f32 {
    let [w, h] = window;
    if w <= 0.0 || h <= 0.0 {
        return 0.0;
    }
    (CARD_WIDTH / w).max(CARD_HEIGHT / h)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CardMotion {
    shown_at: Option<Instant>,
}

impl CardMotion {
    pub fn aim(&mut self, wanted: bool, now: Instant) {
        match (wanted, self.shown_at) {
            (true, None) => self.shown_at = Some(now),
            (false, Some(_)) => self.shown_at = None,
            _ => {}
        }
    }

    pub fn shown(&self) -> bool {
        self.shown_at.is_some()
    }

    pub fn progress(&self, now: Instant) -> Option<f32> {
        let at = self.shown_at?;
        let since = now.saturating_duration_since(at);
        if since < PILL_HOLD {
            return Some(0.0);
        }
        let t = ((since - PILL_HOLD).as_secs_f32() / CARD_MORPH.as_secs_f32()).clamp(0.0, 1.0);
        Some(if t <= 0.0 {
            f32::EPSILON
        } else {
            1.0 - (1.0 - t).powi(3)
        })
    }

    pub fn moving(&self, now: Instant) -> bool {
        self.shown_at
            .is_some_and(|at| now.saturating_duration_since(at) < PILL_HOLD + CARD_MORPH)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CardFrame {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

pub fn card_frame(pill: CardFrame, grab: [f32; 2], progress: f32) -> CardFrame {
    let card = CardFrame {
        x: grab[0] - CARD_WIDTH / 2.0,
        y: grab[1] - CARD_HEIGHT / 2.0,
        w: CARD_WIDTH,
        h: CARD_HEIGHT,
    };
    let mix = |a: f32, b: f32| a + (b - a) * progress;
    CardFrame {
        x: mix(pill.x, card.x),
        y: mix(pill.y, card.y),
        w: mix(pill.w, card.w),
        h: mix(pill.h, card.h),
    }
}

pub fn drag_card(card: &DragCard, frame: CardFrame) -> gpui::Div {
    let fit = card_fit(card.window);
    let ink = if card.dark {
        gpui::white().opacity(0.7)
    } else {
        gpui::black().opacity(0.6)
    };
    let picture = card.picture();
    let whole = card.window_picture.clone().map(|window| {
        div()
            .absolute()
            .left_0()
            .top_0()
            .w(px(card.window[0] * fit))
            .h(px(card.window[1] * fit))
            .child(
                img(ImageSource::Render(window))
                    .size_full()
                    .object_fit(ObjectFit::Fill),
            )
    });
    let page = if picture.is_some() || whole.is_some() {
        card.page
    } else {
        Rect::new(
            0.0,
            PLACEHOLDER_TOP,
            card.window[0],
            (card.window[1] - PLACEHOLDER_TOP).max(1.0),
        )
    };
    let placed = div()
        .absolute()
        .left(px(page.x * fit))
        .top(px(page.y * fit))
        .w(px(page.w * fit))
        .h(px(page.h * fit))
        .overflow_hidden();
    let content = match picture {
        None if whole.is_some() => placed,
        Some(picture) => placed.child(
            img(ImageSource::Image(picture))
                .size_full()
                .object_fit(ObjectFit::Fill),
        ),
        None => placed
            .bg(if card.dark {
                gpui::hsla(0.0, 0.0, 0.12, 1.0)
            } else {
                gpui::hsla(0.0, 0.0, 0.97, 1.0)
            })
            .flex()
            .items_center()
            .justify_center()
            .children(card.favicon.as_ref().map(|favicon| {
                div()
                    .opacity(ink.a)
                    .child(render_favicon(favicon, PLACEHOLDER_ICON * fit, &card.p))
            })),
    };
    let scale = if frame.w > 0.0 {
        frame.w / CARD_WIDTH
    } else {
        0.0
    };
    let (alpha, blur, y) = CARD_SHADOW;
    div()
        .absolute()
        .left(px(frame.x))
        .top(px(frame.y))
        .w(px(frame.w))
        .h(px(frame.h))
        .rounded(px(CARD_RADIUS))
        .shadow(vec![shadow(gpui::black().opacity(alpha), y, blur)])
        .child(
            div()
                .size_full()
                .rounded(px(CARD_RADIUS))
                .overflow_hidden()
                .bg(card.backdrop)
                .border(px(CARD_RIM))
                .border_color(gpui::white().opacity(CARD_RIM_ALPHA))
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .top_0()
                        .w(px(CARD_WIDTH * scale.max(1.0)))
                        .h(px(card.window[1] * fit * scale.max(1.0)))
                        .children(whole)
                        .child(content),
                ),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_card_fills_its_frame_with_the_window_from_the_top_left() {
        assert!((card_fit([1400.0, 900.0]) - 209.0 / 1400.0).abs() < 1e-6);
        assert!((card_fit([2000.0, 900.0]) - 110.0 / 900.0).abs() < 1e-6);
        assert_eq!(card_fit([0.0, 900.0]), 0.0);
    }

    #[test]
    fn the_pill_holds_thirty_ms_then_grows_into_the_card_in_sixty() {
        let now = Instant::now();
        let mut motion = CardMotion::default();
        assert_eq!(motion.progress(now), None);
        motion.aim(true, now);
        assert_eq!(motion.progress(now + Duration::from_millis(20)), Some(0.0));
        let mid = motion
            .progress(now + Duration::from_millis(60))
            .expect("showing");
        assert!(mid > 0.5 && mid < 1.0, "{mid}");
        assert_eq!(motion.progress(now + Duration::from_millis(95)), Some(1.0));
        assert!(!motion.moving(now + Duration::from_millis(95)));
        motion.aim(true, now + Duration::from_millis(200));
        assert_eq!(motion.progress(now + Duration::from_millis(200)), Some(1.0));
        motion.aim(false, now + Duration::from_millis(300));
        assert_eq!(motion.progress(now + Duration::from_millis(300)), None);
    }

    #[test]
    fn snapshots_are_handed_to_gpui_as_bgra() {
        let image = image::RgbaImage::from_raw(1, 1, vec![10, 20, 30, 255]).expect("a pixel");
        assert_eq!(bgra_from_rgba(image).into_raw(), vec![30, 20, 10, 255]);
    }

    #[test]
    fn the_card_centres_on_the_pointer() {
        let pill = CardFrame {
            x: 0.0,
            y: 0.0,
            w: 200.0,
            h: 32.0,
        };
        let card = card_frame(pill, [100.0, 16.0], 1.0);
        assert_eq!(card.x, 100.0 - CARD_WIDTH / 2.0);
        assert_eq!(card.y, 16.0 - CARD_HEIGHT / 2.0);
        assert_eq!(card_frame(pill, [100.0, 16.0], 0.0), pill);
    }
}
