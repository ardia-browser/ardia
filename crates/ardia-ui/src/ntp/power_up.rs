use std::sync::Arc;

use crate::scale::px;
use ardia_state::TabId;
use gpui::{
    App, ElementId, IntoElement, ObjectFit, ParentElement, RenderImage, RenderOnce, SharedString,
    Styled, StyledImage, Window, div, img, prelude::*,
};

use crate::host::UiHost;
use crate::window::layout::Rect;

pub const PAGE_SECONDS: f32 = 3.75;
pub const HALO_SECONDS: f32 = 2.0;
pub const HALO_INSET: f32 = 50.0;
pub const HALO_CORNER_EXTRA: f32 = 2.0;
pub const SPEED: f32 = 1.0;
pub const ORIGIN: f32 = 0.5;

#[derive(Clone, Debug, PartialEq)]
pub struct PowerUpRequest {
    pub key: String,
    pub page: [f32; 2],
    pub halo: [f32; 4],
    pub palette: Vec<[f32; 4]>,
    pub dark: bool,
    pub corner_radius: f32,
    pub speed: f32,
    pub origin: f32,
}

impl PowerUpRequest {
    pub fn halo_frame(&self) -> Rect {
        Rect::new(
            self.halo[0] - HALO_INSET,
            self.halo[1] - HALO_INSET,
            self.halo[2] + 2.0 * HALO_INSET,
            self.halo[3] + 2.0 * HALO_INSET,
        )
    }
}

#[derive(Clone, Default)]
pub struct PowerUpFrame {
    pub page: Option<Arc<RenderImage>>,
    pub halo: Option<Arc<RenderImage>>,
    pub done: bool,
}

#[derive(Default)]
struct Shown {
    images: Vec<Arc<RenderImage>>,
}

#[derive(IntoElement)]
pub struct PowerUpLayer {
    tab: TabId,
    request: PowerUpRequest,
    host: Arc<dyn UiHost>,
}

impl PowerUpLayer {
    pub fn new(tab: &TabId, request: PowerUpRequest, host: Arc<dyn UiHost>) -> Self {
        PowerUpLayer {
            tab: tab.clone(),
            request,
            host,
        }
    }
}

impl RenderOnce for PowerUpLayer {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let shown = window.use_keyed_state(
            ElementId::Name(SharedString::from(format!(
                "power-up:{}",
                self.tab.as_str()
            ))),
            cx,
            |_, _| Shown::default(),
        );
        let frame = self.host.power_up_frame(&self.request).unwrap_or_default();
        let current: Vec<Arc<RenderImage>> = frame
            .page
            .iter()
            .chain(frame.halo.iter())
            .cloned()
            .collect();
        let stale: Vec<Arc<RenderImage>> = shown.update(cx, |shown, _| {
            let old = std::mem::take(&mut shown.images);
            shown.images = current.clone();
            old.into_iter()
                .filter(|image| !current.iter().any(|c| Arc::ptr_eq(c, image)))
                .collect()
        });
        for image in stale {
            let _ = window.drop_image(image);
        }
        if !frame.done {
            window.request_animation_frame();
        }
        let halo = self.request.halo_frame();
        div()
            .absolute()
            .inset_0()
            .when_some(frame.page, |this, page| {
                this.child(
                    img(page)
                        .absolute()
                        .left_0()
                        .top_0()
                        .w(px(self.request.page[0]))
                        .h(px(self.request.page[1]))
                        .object_fit(ObjectFit::Fill),
                )
            })
            .when_some(frame.halo, |this, image| {
                this.child(
                    img(image)
                        .absolute()
                        .left(px(halo.x))
                        .top(px(halo.y))
                        .w(px(halo.w))
                        .h(px(halo.h))
                        .object_fit(ObjectFit::Fill),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_halo_extends_fifty_points_around_the_bar() {
        let request = PowerUpRequest {
            key: "t".into(),
            page: [1200.0, 800.0],
            halo: [300.0, 330.0, 652.0, 112.0],
            palette: vec![[1.0, 0.4, 1.0, 1.0]],
            dark: true,
            corner_radius: 20.0 + HALO_CORNER_EXTRA,
            speed: SPEED,
            origin: ORIGIN,
        };
        assert_eq!(request.halo_frame(), Rect::new(250.0, 280.0, 752.0, 212.0));
    }
}
