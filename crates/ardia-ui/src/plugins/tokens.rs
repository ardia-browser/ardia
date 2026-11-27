use ardia_theme::tokens::{TypeSize, space};
use gpui::Hsla;

use crate::look::Palette;
use crate::primitives::icons::{Icon, IconElement, symbol_icon};

pub mod side_panel {
    pub const MIN: f32 = 320.0;
    pub const MAX: f32 = 600.0;
    pub const INITIAL: f32 = 380.0;
    pub const HEADER: f32 = 40.0;
    pub const HANDLE: f32 = 7.0;
    pub const HANDLE_OFFSET: f32 = -3.0;
}

pub mod toolbar_item {
    pub const BUTTON: f32 = 28.0;
    pub const GAP: f32 = 2.0;
    pub const GLYPH: f32 = 14.0;
    pub const GLYPH_BOX: f32 = 18.0;
    pub const LABEL_PAD: f32 = 6.0;
    pub const LABEL_MAX: f32 = 96.0;
    pub const LABEL_CHAR: f32 = 6.5;
    pub const EDGE: f32 = 6.0;
    pub const DOT: f32 = 7.0;
    pub const BADGE_RIGHT: f32 = 1.0;
    pub const BADGE_BOTTOM: f32 = 3.0;
    pub const LABEL_PILL_RADIUS: f32 = 6.0;
}

pub mod surface {
    pub const ICON: f32 = 14.0;
    pub const ICON_BOX: f32 = 18.0;
    pub const ROW_HEIGHT: f32 = 28.0;
    pub const ITEM_HEIGHT: f32 = 36.0;
    pub const SMALL_ICON: f32 = 12.0;
    pub const SPINNER: f32 = 12.0;
    pub const LIST_MAX_HEIGHT: f32 = 420.0;
    pub const DETAIL_WIDTH: f32 = 0.55;
    pub const META_LABEL: f32 = 96.0;
    pub const CHEVRON: f32 = 9.0;
    pub const INDENT: f32 = 16.0;
}

pub mod overlay {
    pub const QUICK_PICK_HEIGHT: f32 = 360.0;
    pub const COMMAND_HEIGHT: f32 = 520.0;
    pub const COMMAND_ICON: f32 = 16.0;
    pub const POPOVER_WIDTH: f32 = 320.0;
    pub const POPOVER_MAX_HEIGHT: f32 = 480.0;
    pub const POPOVER_GAP: f32 = 6.0;
}

pub mod dialog {
    pub const WIDTH_S: f32 = 420.0;
    pub const WIDTH_M: f32 = 440.0;
    pub const WIDTH_L: f32 = 480.0;
    pub const RADIUS: f32 = 16.0;
    pub const PAD: f32 = 20.0;
    pub const ACTIONS_TOP: f32 = 16.0;
    pub const TITLE_GAP: f32 = 12.0;
    pub const SUBTITLE_TOP: f32 = 6.0;
    pub const RING: f32 = 2.0;
    pub const CONSENT_TITLE_ICON: f32 = 28.0;
    pub const CONSENT_TITLE_GLYPH: f32 = 22.0;
    pub const CONSENT_LINE_ICON: f32 = 18.0;
    pub const CONSENT_LINE_GLYPH: f32 = 13.0;
    pub const POPOVER_MARGIN: f32 = 8.0;
}

pub const LIST_ROW_RADIUS: f32 = 8.0;
pub const LIST_ROW_PAD: f32 = 8.0;
pub const ROW_HEIGHT: f32 = 34.0;

pub fn space_of(name: Option<&str>) -> Option<f32> {
    Some(match name? {
        "none" => space::NONE,
        "xxs" => space::XXS,
        "xs" => space::XS,
        "s" => space::S,
        "m" => space::M,
        "l" => space::L,
        "xl" => space::XL,
        _ => return None,
    })
}

pub fn size_of(name: Option<&str>) -> TypeSize {
    match name.unwrap_or_default() {
        "caption" => TypeSize::Caption,
        "small" => TypeSize::Small,
        "heading" => TypeSize::Title,
        "title" => TypeSize::Large,
        _ => TypeSize::Body,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Text,
    Secondary,
    Tertiary,
    Accent,
    Success,
    Warning,
    Destructive,
    Icon,
}

impl Role {
    pub fn color(self, p: &Palette) -> Hsla {
        match self {
            Role::Text => p.text,
            Role::Secondary => p.text_secondary,
            Role::Tertiary => p.text_tertiary,
            Role::Accent => p.accent,
            Role::Success => p.success,
            Role::Warning => p.warning,
            Role::Destructive => p.destructive,
            Role::Icon => p.icon,
        }
    }
}

pub fn tone_of(name: Option<&str>, fallback: Role) -> Role {
    match name.unwrap_or_default() {
        "default" | "neutral" => Role::Text,
        "secondary" => Role::Secondary,
        "tertiary" => Role::Tertiary,
        "accent" => Role::Accent,
        "success" => Role::Success,
        "warning" => Role::Warning,
        "destructive" | "danger" => Role::Destructive,
        _ => fallback,
    }
}

pub fn fill_tone_of(name: Option<&str>) -> Option<Role> {
    match name.unwrap_or_default() {
        "accent" => Some(Role::Accent),
        "success" => Some(Role::Success),
        "warning" => Some(Role::Warning),
        "destructive" | "danger" => Some(Role::Destructive),
        _ => None,
    }
}

pub fn symbol(name: &str, side: f32, color: impl Into<Hsla>) -> IconElement {
    symbol_icon(name.to_owned(), icon_named(name), side, color)
}

pub fn icon_named(name: &str) -> Icon {
    let aliases: &[(&str, Icon)] = &[
        ("puzzlepiece.fill", Icon::Puzzle),
        ("key.fill", Icon::Key),
        ("archivebox", Icon::Folder),
        ("circle", Icon::Dot),
        ("xmark.circle", Icon::XMark),
        ("hand.raised.slash", Icon::Warning),
        ("list.bullet", Icon::Reader),
        ("wrench.and.screwdriver", Icon::Wrench),
        ("arrow.up.forward.app", Icon::Window),
        ("gear", Icon::Gear),
        ("bell.fill", Icon::Bell),
        ("star.fill", Icon::Star),
        ("app", Icon::Window),
        ("app.badge", Icon::Window),
        ("hammer", Icon::Wrench),
        ("network", Icon::Globe),
        ("terminal", Icon::DevTools),
        ("doc.text", Icon::Reader),
        ("lock.fill", Icon::Lock),
        ("info.circle.fill", Icon::Info),
    ];
    if let Some((_, icon)) = aliases.iter().find(|(alias, _)| *alias == name) {
        return *icon;
    }
    Icon::ALL
        .iter()
        .copied()
        .find(|icon| icon.key().strip_prefix("ardia-icon:") == Some(name))
        .unwrap_or(Icon::Puzzle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_symbols_spaces_and_tones() {
        assert_eq!(icon_named("magnifyingglass"), Icon::Search);
        assert_eq!(icon_named("key.fill"), Icon::Key);
        assert_eq!(icon_named("not.a.symbol"), Icon::Puzzle);
        assert_eq!(space_of(Some("m")), Some(8.0));
        assert_eq!(space_of(Some("ml")), None);
        assert_eq!(size_of(Some("title")), TypeSize::Large);
        assert_eq!(tone_of(Some("danger"), Role::Text), Role::Destructive);
        assert_eq!(fill_tone_of(Some("secondary")), None);
    }
}
