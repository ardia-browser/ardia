use gpui::{Hsla, IntoElement, Styled, Transformation, radians, svg};

use crate::scale::px;

pub const CHEVRON_DOWN: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\" fill=\"none\" stroke=\"#000\" stroke-width=\"1.35\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M1.7 3.4 5 6.7l3.3-3.3\"/></svg>";

pub fn glyph(data: &'static str, width: f32, height: f32, color: Hsla) -> gpui::Svg {
    svg()
        .data(data.as_bytes())
        .flex_none()
        .w(px(width))
        .h(px(height))
        .text_color(color)
}

pub fn turned(data: &'static str, side: f32, color: Hsla, angle: f32) -> impl IntoElement {
    glyph(data, side, side, color).with_transformation(Transformation::rotate(radians(angle)))
}
