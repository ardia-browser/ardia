use std::sync::Arc;

use gpui::StyledImage;
use gpui::{AnyElement, Hsla, IntoElement, ObjectFit, ParentElement, Rgba, Styled, div, img};

use crate::host::UiHost;
use crate::primitives::icons::{Icon, icon};
use crate::scale::px;

const SYMBOL_PREFIX: &str = "symbol:";

pub fn symbol_icon(name: &str) -> String {
    format!("{SYMBOL_PREFIX}{name}")
}

pub fn icon_symbol(icon: Option<&str>) -> Option<&str> {
    icon.and_then(|icon| icon.strip_prefix(SYMBOL_PREFIX))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SymbolWeight {
    Regular,
    Medium,
    Semibold,
    Bold,
}

impl SymbolWeight {
    pub const fn value(self) -> u16 {
        match self {
            SymbolWeight::Regular => 400,
            SymbolWeight::Medium => 500,
            SymbolWeight::Semibold => 600,
            SymbolWeight::Bold => 700,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SymbolRequest<'a> {
    pub name: &'a str,
    pub point_size: f32,
    pub box_size: f32,
    pub weight: SymbolWeight,
    pub rgba: u32,
}

pub fn packed_rgba(color: Hsla) -> u32 {
    let rgba: Rgba = color.into();
    let channel = |v: f32| ((v.clamp(0.0, 1.0) * 255.0).round() as u32) & 0xff;
    (channel(rgba.r) << 24) | (channel(rgba.g) << 16) | (channel(rgba.b) << 8) | channel(rgba.a)
}

pub fn fallback_icon(name: &str) -> Option<Icon> {
    let wanted = |key: &str| {
        Icon::ALL
            .iter()
            .copied()
            .find(|icon| icon.key().strip_prefix("ardia-icon:") == Some(key))
    };
    wanted(name).or_else(|| name.strip_suffix(".fill").and_then(wanted))
}

pub fn symbol(
    host: &dyn UiHost,
    name: &str,
    point_size: f32,
    box_size: f32,
    weight: SymbolWeight,
    color: Hsla,
) -> AnyElement {
    let frame = div()
        .flex_none()
        .size(px(box_size))
        .flex()
        .items_center()
        .justify_center();
    let request = SymbolRequest {
        name,
        point_size,
        box_size,
        weight,
        rgba: packed_rgba(color),
    };
    if let Some(image) = host.symbol_image(request) {
        return frame
            .child(
                img(Arc::clone(&image))
                    .size(px(box_size))
                    .object_fit(ObjectFit::Contain),
            )
            .into_any_element();
    }
    match fallback_icon(name) {
        Some(glyph) => frame
            .child(icon(glyph, point_size, color))
            .into_any_element(),
        None => frame.into_any_element(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbol_icons_round_trip() {
        assert_eq!(symbol_icon("house.fill"), "symbol:house.fill");
        assert_eq!(icon_symbol(Some("symbol:house.fill")), Some("house.fill"));
        assert_eq!(icon_symbol(Some("🏠")), None);
        assert_eq!(icon_symbol(None), None);
    }

    #[test]
    fn fallback_finds_bundled_glyphs() {
        assert_eq!(fallback_icon("star.fill"), Some(Icon::Star));
        assert_eq!(fallback_icon("sparkles"), Some(Icon::Sparkles));
        assert_eq!(fallback_icon("server.rack"), None);
    }

    #[test]
    fn colors_pack_as_rgba() {
        assert_eq!(packed_rgba(gpui::white()), 0xffff_ffff);
        assert_eq!(packed_rgba(gpui::black().opacity(0.0)), 0x0000_0000);
    }
}
