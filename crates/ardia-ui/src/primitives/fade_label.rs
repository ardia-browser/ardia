use std::sync::{Arc, LazyLock};

use crate::scale::px;
use gpui::{
    App, Bounds, ContentMask, Element, ElementId, FadeEdge, FadeMask, FontFeatures, FontWeight,
    GlobalElementId, Hsla, InspectorElementId, LayoutId, Length, Pixels, ShapedLine, SharedString,
    Style, TextAlign, TextRun, Window,
};

pub const TITLE_FADE: f32 = 24.0;
pub const LABEL_CELL_INSET: f32 = 2.0;

static TABULAR_DIGITS: LazyLock<FontFeatures> =
    LazyLock::new(|| FontFeatures(Arc::new(vec![("tnum".into(), 1)])));

pub struct FadeLabel {
    text: SharedString,
    color: Hsla,
    font_size: Pixels,
    line_height: Pixels,
    weight: FontWeight,
    fade: Pixels,
    grow: bool,
    text_inset: Pixels,
}

pub fn fade_label(
    text: impl Into<SharedString>,
    color: impl Into<Hsla>,
    font_size: f32,
) -> FadeLabel {
    FadeLabel {
        text: single_line(text.into()),
        color: color.into(),
        font_size: px(font_size),
        line_height: px((font_size * 1.3).round()),
        weight: FontWeight::NORMAL,
        fade: px(TITLE_FADE),
        grow: true,
        text_inset: gpui::px(0.),
    }
}

impl FadeLabel {
    pub fn weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }

    pub fn line_height(mut self, line_height: f32) -> Self {
        self.line_height = px(line_height);
        self
    }

    pub fn fade_width(mut self, fade: f32) -> Self {
        self.fade = px(fade.max(1.0));
        self
    }

    pub fn cell_inset(mut self) -> Self {
        self.text_inset = px(LABEL_CELL_INSET);
        self
    }

    pub fn hug(mut self) -> Self {
        self.grow = false;
        self
    }
}

pub fn single_line(text: SharedString) -> SharedString {
    if !text.contains([
        '\n', '\r', '\u{2028}', '\u{2029}', '\u{85}', '\u{0B}', '\u{0C}',
    ]) {
        return text;
    }
    let parts: Vec<&str> = text
        .split([
            '\n', '\r', '\u{2028}', '\u{2029}', '\u{85}', '\u{0B}', '\u{0C}',
        ])
        .map(|part| part.trim_matches([' ', '\t']))
        .filter(|part| !part.is_empty())
        .collect();
    SharedString::from(parts.join(" "))
}

pub fn ceil_to_pixel_grid(width: Pixels, scale: f32) -> Pixels {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    gpui::px((f32::from(width) * scale).ceil() / scale)
}

pub fn overflows(line_width: f32, room: f32) -> bool {
    line_width > room + 0.5
}

pub fn fade_length(room: f32, fade: f32) -> f32 {
    fade.min(room).max(0.0)
}

pub struct ShapedLabel {
    line: ShapedLine,
    fades: bool,
}

impl Element for FadeLabel {
    type RequestLayoutState = ();
    type PrepaintState = Option<ShapedLabel>;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.height = self.line_height.into();
        style.min_size.width = px(0.).into();
        if self.grow {
            style.flex_grow = 1.0;
            style.flex_shrink = 1.0;
            style.flex_basis = Length::Definite(px(0.).into());
        } else {
            let measured = self
                .shape(None, window)
                .map_or(px(0.), |label| label.line.width);
            style.size.width = ceil_to_pixel_grid(measured, window.scale_factor()).into();
            style.flex_shrink = 1.0;
        }
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        self.shape(Some(bounds.size.width - self.text_inset * 2.), window)
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        line: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(ShapedLabel { line, fades }) = line.take() else {
            return;
        };
        let line_height = self.line_height;
        let text_inset = self.text_inset;
        let draw = |window: &mut Window, cx: &mut App| {
            window.with_content_mask(Some(ContentMask { bounds }), |window| {
                let painted = line.paint(
                    bounds.origin + gpui::point(text_inset, gpui::px(0.)),
                    line_height,
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
                if let Err(error) = painted {
                    log::debug!("label failed to paint: {error}");
                }
            });
        };
        if fades {
            let mask = FadeMask {
                bounds,
                edge: FadeEdge::Trailing,
                length: px(fade_length(
                    f32::from(bounds.size.width),
                    f32::from(self.fade),
                )),
            };
            window.with_fade_mask(mask, |window| draw(window, cx));
        } else {
            draw(window, cx);
        }
    }
}

impl FadeLabel {
    fn template(&self, window: &Window) -> TextRun {
        let mut font = window.text_style().font();
        font.weight = self.weight;
        font.features = TABULAR_DIGITS.clone();
        TextRun {
            len: self.text.len(),
            font,
            color: self.color,
            background_color: None,
            underline: None,
            strikethrough: None,
        }
    }

    fn shape(&self, width: Option<Pixels>, window: &mut Window) -> Option<ShapedLabel> {
        if self.text.is_empty() {
            return None;
        }
        let template = self.template(window);
        let line = window.text_system().shape_line(
            self.text.clone(),
            self.font_size,
            std::slice::from_ref(&template),
            None,
        );
        let fades = width.is_some_and(|room| overflows(f32::from(line.width), f32::from(room)));
        Some(ShapedLabel { line, fades })
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn hugged_labels_round_up_to_the_pixel_grid_like_yoga() {
        assert_eq!(ceil_to_pixel_grid(gpui::px(36.2), 2.0), gpui::px(36.5));
        assert_eq!(ceil_to_pixel_grid(gpui::px(36.5), 2.0), gpui::px(36.5));
        assert_eq!(ceil_to_pixel_grid(gpui::px(36.2), 1.0), gpui::px(37.0));
        assert_eq!(ceil_to_pixel_grid(gpui::px(36.2), 0.0), gpui::px(37.0));
    }

    use super::*;

    #[test]
    fn the_cell_inset_is_the_two_points_an_appkit_label_draws_its_text_in() {
        assert_eq!(LABEL_CELL_INSET, 2.0);
    }

    #[test]
    fn only_text_wider_than_the_room_by_half_a_point_fades() {
        assert!(!overflows(100.0, 100.0));
        assert!(!overflows(100.5, 100.0));
        assert!(overflows(100.6, 100.0));
    }

    #[test]
    fn the_fade_spans_the_last_twenty_four_points_or_the_whole_label() {
        assert_eq!(TITLE_FADE, 24.0);
        assert_eq!(fade_length(200.0, TITLE_FADE), 24.0);
        assert_eq!(fade_length(10.0, TITLE_FADE), 10.0);
        assert_eq!(fade_length(-4.0, TITLE_FADE), 0.0);
    }

    #[test]
    fn labels_are_always_one_line() {
        assert_eq!(single_line("Work\nReading".into()), "Work Reading");
        assert_eq!(
            single_line("  Work \r\n\n  Reading  ".into()),
            "Work Reading"
        );
        assert_eq!(single_line("Line\u{2028}Two".into()), "Line Two");
        assert_eq!(single_line("Plain".into()), "Plain");
    }
}
