use ardia_state::settings::{ReaderFont, ReaderTextSize};
use ardia_theme::RgbaColor;

pub const READER_SIZE_ORDER: [ReaderTextSize; 5] = [
    ReaderTextSize::Small,
    ReaderTextSize::Medium,
    ReaderTextSize::Large,
    ReaderTextSize::Larger,
    ReaderTextSize::Largest,
];

pub fn reader_size_index(size: ReaderTextSize) -> usize {
    READER_SIZE_ORDER
        .iter()
        .position(|known| *known == size)
        .unwrap_or(1)
}

pub fn stepped_reader_size(size: ReaderTextSize, delta: i32) -> Option<ReaderTextSize> {
    let at = reader_size_index(size) as i32;
    let next = (at + delta).clamp(0, READER_SIZE_ORDER.len() as i32 - 1) as usize;
    (next as i32 != at).then_some(READER_SIZE_ORDER[next])
}

pub fn other_reader_font(font: ReaderFont) -> ReaderFont {
    match font {
        ReaderFont::Serif => ReaderFont::Sans,
        ReaderFont::Sans => ReaderFont::Serif,
    }
}

pub fn font_switch_title(font: ReaderFont) -> &'static str {
    match font {
        ReaderFont::Serif => "Sans-Serif",
        ReaderFont::Sans => "Serif",
    }
}

pub const READER_GROUND_LIGHT: RgbaColor = RgbaColor::rgb8(0xFF, 0xFF, 0xFF);
pub const READER_GROUND_DARK: RgbaColor = RgbaColor::rgb8(0x1C, 0x1C, 0x1E);

pub fn has_origin(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("file:")
}

pub fn reader_ground(dark: bool) -> RgbaColor {
    if dark {
        READER_GROUND_DARK
    } else {
        READER_GROUND_LIGHT
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReaderStatus {
    pub available: bool,
    pub active: bool,
}

impl ReaderStatus {
    pub fn button_shown(self, quiet: bool) -> bool {
        self.active || (self.available && !quiet)
    }

    pub fn row_shown(self) -> bool {
        self.active || self.available
    }

    pub fn toggle_title(self) -> &'static str {
        if self.active {
            "Hide Reader"
        } else {
            "Show Reader"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reader_button_follows_the_old_rules() {
        let none = ReaderStatus::default();
        let available = ReaderStatus {
            available: true,
            active: false,
        };
        let active = ReaderStatus {
            available: false,
            active: true,
        };
        assert!(!none.button_shown(false) && !none.row_shown());
        assert!(available.button_shown(false) && !available.button_shown(true));
        assert!(active.button_shown(true) && active.row_shown());
        assert_eq!(available.toggle_title(), "Show Reader");
        assert_eq!(active.toggle_title(), "Hide Reader");
    }

    #[test]
    fn text_size_steps_stop_at_the_ends() {
        assert_eq!(
            stepped_reader_size(ReaderTextSize::Medium, 1),
            Some(ReaderTextSize::Large)
        );
        assert_eq!(stepped_reader_size(ReaderTextSize::Small, -1), None);
        assert_eq!(stepped_reader_size(ReaderTextSize::Largest, 1), None);
        assert_eq!(other_reader_font(ReaderFont::Serif), ReaderFont::Sans);
        assert_eq!(font_switch_title(ReaderFont::Serif), "Sans-Serif");
    }
}
