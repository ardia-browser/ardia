use serde::{Deserialize, Serialize};

pub const CARD_INSET: f32 = 9.0;
pub const CARD_RADIUS: f32 = 10.0;
pub const DIA_CARD_INSET: f32 = 6.0;
pub const DEFAULT_WINDOW_CORNER_RADIUS: f32 = CARD_INSET + CARD_RADIUS;
pub const PAGE_FRAME_MIN: u8 = 0;
pub const PAGE_FRAME_MAX: u8 = 12;
pub const PAGE_FRAME_DEFAULT: u8 = 9;
pub const SPLIT_MIN_GAP: f32 = 2.0;
pub const MIN_PEEK_GAP: f32 = 1.0;
pub const PEEK_EDGE_STRIP: f32 = 3.0;
pub const TAB_DRAG_EDGE_STRIP: f32 = 8.0;
pub const PEEK_HOLD_SLACK: f32 = 40.0;
pub const DEFAULT_SIDEBAR_WIDTH: f32 = 190.0;
pub const SIDEBAR_MIN_WIDTH: f32 = 160.0;
pub const SIDEBAR_MAX_WIDTH: f32 = 400.0;
pub const MIN_WINDOW_WIDTH: f32 = 500.0;
pub const LITTLE_ARDIA_DEFAULT_SIZE: [f32; 2] = [900.0, 640.0];
pub const LITTLE_ARDIA_MIN_SIZE: [f32; 2] = [420.0, 300.0];
pub const LITTLE_ARDIA_MAX_SHARE: f32 = 0.8;
pub const LITTLE_ARDIA_BAR_HEIGHT: f32 = 38.0;

const SIDEBAR_PAGE_ROOM: f32 = MIN_WINDOW_WIDTH - DEFAULT_SIDEBAR_WIDTH;

pub fn sidebar_width_limit(window_width: Option<f32>) -> f32 {
    match window_width {
        Some(width) if width.is_finite() && width > 0.0 => (width - SIDEBAR_PAGE_ROOM)
            .floor()
            .clamp(SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
        _ => SIDEBAR_MAX_WIDTH,
    }
}

pub fn shown_sidebar_width(saved: f32, window_width: Option<f32>) -> f32 {
    saved.min(sidebar_width_limit(window_width))
}

pub const fn valid_page_frame(value: i64) -> bool {
    value >= PAGE_FRAME_MIN as i64 && value <= PAGE_FRAME_MAX as i64
}

pub fn little_ardia_size(saved: [f32; 2], visible: [f32; 2]) -> [f32; 2] {
    let fit = |i: usize| {
        let cap = (visible[i] * LITTLE_ARDIA_MAX_SHARE).max(LITTLE_ARDIA_MIN_SIZE[i]);
        saved[i].clamp(LITTLE_ARDIA_MIN_SIZE[i], cap)
    };
    [fit(0), fit(1)]
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameRules {
    pub borderless_mode: bool,
    pub zero_in_full_screen: bool,
    pub full_screen: bool,
    pub zero_when_tabs_hidden: bool,
    pub tabs_hidden: bool,
}

pub fn page_frame_inset(page_frame: f32, rules: FrameRules) -> f32 {
    if rules.borderless_mode
        || (rules.full_screen && rules.zero_in_full_screen)
        || (rules.full_screen && rules.tabs_hidden && rules.zero_when_tabs_hidden)
    {
        0.0
    } else {
        page_frame.clamp(f32::from(PAGE_FRAME_MIN), f32::from(PAGE_FRAME_MAX))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PeekFrame {
    pub left: f32,
    pub top: f32,
    pub bottom: f32,
    pub radius: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageFrame {
    pub inset: f32,
    pub radius: f32,
    pub split_gap: f32,
    pub dock_gap: f32,
    pub peek: PeekFrame,
}

impl PageFrame {
    pub fn concentric(inset: f32, window_radius: f32, drawn_window_radius: f32) -> Self {
        let inset = inset.max(0.0);
        let settled = (inset / CARD_INSET).min(1.0);
        let corner = (drawn_window_radius + (window_radius - drawn_window_radius) * settled
            - inset)
            .max(2.0);
        Self::with_corner(inset, if inset <= 0.0 { 0.0 } else { corner }, corner)
    }

    pub fn default_window(inset: f32) -> Self {
        Self::concentric(
            inset,
            DEFAULT_WINDOW_CORNER_RADIUS,
            DEFAULT_WINDOW_CORNER_RADIUS,
        )
    }

    pub fn scaled(inset: f32) -> Self {
        let radius = scaled_card_radius(inset);
        Self::with_corner(inset.max(0.0), radius, radius)
    }

    fn with_corner(inset: f32, radius: f32, corner: f32) -> Self {
        let peek_gap = inset.max(MIN_PEEK_GAP);
        PageFrame {
            inset,
            radius,
            split_gap: inset.max(SPLIT_MIN_GAP),
            dock_gap: (inset - sidebar::INSET).max(0.0),
            peek: PeekFrame {
                left: peek_gap,
                top: peek_gap,
                bottom: peek_gap,
                radius: (corner + inset - peek_gap).max(0.0),
            },
        }
    }

    pub fn docked_card_left(&self, sidebar_width: f32) -> f32 {
        sidebar_width + self.dock_gap
    }

    pub fn card_left_at(&self, dock_progress: f32, sidebar_width: f32) -> f32 {
        self.inset
            + (self.docked_card_left(sidebar_width) - self.inset) * dock_progress.clamp(0.0, 1.0)
    }

    pub fn edge_watch_band(&self) -> f32 {
        PEEK_EDGE_STRIP
    }

    pub fn peek_hold_width(&self, sidebar_width: f32) -> f32 {
        self.peek.left + sidebar_width + PEEK_HOLD_SLACK
    }
}

pub fn scaled_card_radius(frame: f32) -> f32 {
    if frame <= 0.0 {
        return 0.0;
    }
    (CARD_RADIUS * (frame / CARD_INSET).min(1.0) * 2.0).round() / 2.0
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidebarTextSize {
    #[default]
    Default,
    Large,
    Larger,
}

impl SidebarTextSize {
    pub const ALL: [SidebarTextSize; 3] = [
        SidebarTextSize::Default,
        SidebarTextSize::Large,
        SidebarTextSize::Larger,
    ];

    pub const fn scale(self) -> f32 {
        match self {
            SidebarTextSize::Default => 1.0,
            SidebarTextSize::Large => 15.0 / 13.0,
            SidebarTextSize::Larger => 17.0 / 13.0,
        }
    }

    pub fn points(self, value: f32) -> f32 {
        if self == SidebarTextSize::Default {
            value
        } else {
            (value * self.scale()).round()
        }
    }

    pub fn icon_points(self, value: f32) -> f32 {
        if self == SidebarTextSize::Default {
            value
        } else {
            (value * self.scale() / 2.0).round() * 2.0
        }
    }

    pub const fn clear_divider_height(self) -> f32 {
        match self {
            SidebarTextSize::Default => 21.0,
            SidebarTextSize::Large => 23.0,
            SidebarTextSize::Larger => 25.0,
        }
    }
}

pub mod sidebar {
    pub const HEADER: f32 = 46.0;
    pub const INSET: f32 = super::CARD_INSET;
    pub const DIA_INSET: f32 = 6.0;
    pub const PINNED_TOP: f32 = 54.0;
    pub const PINNED_TILE_HEIGHT: f32 = 41.0;
    pub const PINNED_TILE_GAP: f32 = 6.0;
    pub const PINNED_TILE_RADIUS: f32 = 10.0;
    pub const PINNED_RESTING_HAIRLINE: f32 = 0.5;
    pub const SELECTED_RING_WIDTH: f32 = 3.0;
    pub const ROW_HEIGHT: f32 = 34.0;
    pub const ROW_GAP: f32 = 3.0;
    pub const ROW_PITCH: f32 = ROW_HEIGHT + ROW_GAP;
    pub const ROW_CONTENT_LEFT: f32 = 9.0;
    pub const ROW_TRAILING: f32 = 6.0;
    pub const ROW_FAVICON: f32 = 16.0;
    pub const ROW_TITLE_GAP: f32 = 5.0;
    pub const DIA_ROW_TITLE_GAP: f32 = 7.0;
    pub const ROW_CLOSE_SLOT: f32 = 22.0;
    pub const ROW_SELECTED_HAIRLINE: f32 = 0.5;
    pub const GROUP_INDENT: f32 = 16.0;
    pub const GROUP_BORDER: f32 = 0.5;
    pub const GROUP_RADIUS: f32 = 12.0;
    pub const GROUP_INSET: f32 = 3.0;
    pub const PINNED_DIVIDER_BAND: f32 = 14.0;
    pub const SCROLL_EDGE_LINE: f32 = 1.0;
    pub const FOOTER_HEIGHT: f32 = 41.0;
    pub const SWITCHER_BAND_HEIGHT: f32 = 28.0;
    pub const SWITCHER_SIDE_INSET: f32 = 31.0;
    pub const SWITCHER_DOT: f32 = 6.0;
    pub const SWITCHER_ITEM: f32 = 12.0;
    pub const SWITCHER_MAX_WIDTH: f32 = 84.0;
    pub const SWITCHER_ALPHA_SELECTED: f32 = 0.85;
    pub const SWITCHER_ALPHA_HOVERED: f32 = 0.4;
    pub const SWITCHER_ALPHA_REST: f32 = 0.2;
    pub const PROFILE_NAME_MIN_TRUNCATED: f32 = 52.0;
    pub const DOWNLOADS_BUTTON_CENTER: [f32; 2] = [166.0, 26.0];
    pub const SPINNER_SIZE: f32 = 12.0;
    pub const SPINNER_LINE: f32 = 1.5;
    pub const SPINNER_STROKE_END: f32 = 0.72;
    pub const SPINNER_TRACK_ALPHA: f32 = 0.18;
    pub const SPINNER_MIN_ROW_WIDTH: f32 = 48.0;

    pub const MINIMALISM_ROW_HEIGHT: f32 = 28.0;
    pub const MINIMALISM_ROW_GAP: f32 = 2.0;
    pub const MINIMALISM_PINNED_TILE_HEIGHT: f32 = 34.0;

    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct RowMetrics {
        pub row_height: f32,
        pub row_gap: f32,
        pub pinned_height: f32,
    }

    impl RowMetrics {
        pub const BASE: RowMetrics = RowMetrics {
            row_height: ROW_HEIGHT,
            row_gap: ROW_GAP,
            pinned_height: PINNED_TILE_HEIGHT,
        };

        pub const MINIMALISM: RowMetrics = RowMetrics {
            row_height: MINIMALISM_ROW_HEIGHT,
            row_gap: MINIMALISM_ROW_GAP,
            pinned_height: MINIMALISM_PINNED_TILE_HEIGHT,
        };

        pub fn of(minimalism: bool, text_size: super::SidebarTextSize) -> RowMetrics {
            let base = if minimalism {
                RowMetrics::MINIMALISM
            } else {
                RowMetrics::BASE
            };
            let scale = text_size.scale();
            if scale == 1.0 {
                return base;
            }
            RowMetrics {
                row_height: (base.row_height * scale).round(),
                row_gap: (base.row_gap * scale).round(),
                pinned_height: (base.pinned_height * scale).round(),
            }
        }
    }

    thread_local! {
        static METRICS: std::cell::Cell<RowMetrics> = const { std::cell::Cell::new(RowMetrics::BASE) };
    }

    pub fn set_row_metrics(metrics: RowMetrics) -> bool {
        METRICS.with(|cell| cell.replace(metrics) != metrics)
    }

    pub fn row_metrics() -> RowMetrics {
        METRICS.with(std::cell::Cell::get)
    }

    pub fn row_height() -> f32 {
        row_metrics().row_height
    }

    pub fn row_gap() -> f32 {
        row_metrics().row_gap
    }

    pub fn row_pitch() -> f32 {
        let m = row_metrics();
        m.row_height + m.row_gap
    }

    pub fn pinned_tile_height() -> f32 {
        row_metrics().pinned_height
    }

    pub fn row_radius(height: f32) -> f32 {
        (height / 3.0).min(10.0)
    }

    pub fn header_of(address_bar_in_sidebar: bool, lights_y: f32) -> f32 {
        if address_bar_in_sidebar {
            HEADER
        } else {
            HEADER - (super::lights::CENTER[1] - lights_y)
        }
    }

    pub fn first_row_top(address_bar_in_sidebar: bool, lights_y: f32) -> f32 {
        header_of(address_bar_in_sidebar, lights_y) + (PINNED_TOP - HEADER)
    }

    pub fn row_top(index: usize, first_row_top: f32) -> f32 {
        first_row_top + index as f32 * ROW_PITCH
    }
}

pub mod lights {
    use super::{CARD_INSET, LITTLE_ARDIA_BAR_HEIGHT};

    pub const X: f32 = 25.0;
    pub const BELOW_CARD_TOP: f32 = 21.0;
    pub const CENTER: [f32; 2] = [X, CARD_INSET + BELOW_CARD_TOP];
    pub const SETTINGS_CENTER: [f32; 2] = [25.0, 26.0];
    pub const ARC_CENTER: [f32; 2] = [25.0, 24.0];
    pub const TOP_STRIP_CENTER: [f32; 2] = [20.75, 20.75];
    pub const DIA_SIDEBAR_CENTERS: [[f32; 2]; 3] = [[24.75, 26.75], [47.75, 26.75], [70.75, 26.75]];
    pub const LITTLE_ARDIA_CENTER: [f32; 2] = [20.0, LITTLE_ARDIA_BAR_HEIGHT / 2.0];
    pub const SPACING: f32 = 23.0;
    pub const REACH: f32 = 80.0;

    pub fn center(frame: f32, compact: bool) -> [f32; 2] {
        let lift = if compact {
            super::toolbar::compact_lift(&super::toolbar::COMPACT)
        } else {
            0.0
        };
        [X, frame + BELOW_CARD_TOP - lift]
    }

    pub fn sidebar_center(trailing: bool, window_width: f32, offset: f32, frame: f32) -> [f32; 2] {
        let [x, y] = center(frame, false);
        if trailing {
            [window_width - (x + offset), y]
        } else {
            [x - offset, y]
        }
    }

    pub fn off_window(x: f32, trailing: bool) -> bool {
        if trailing {
            x <= -REACH / 4.0
        } else {
            x + REACH <= 0.0
        }
    }
}

pub mod toolbar {
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct ToolbarRow {
        pub height: f32,
        pub center: f32,
        pub button: f32,
        pub button_radius: f32,
        pub field: f32,
        pub field_radius: f32,
        pub field_button: f32,
        pub field_button_radius: f32,
        pub extension_button: f32,
    }

    pub const REGULAR: ToolbarRow = ToolbarRow {
        height: 41.0,
        center: 21.2,
        button: 30.0,
        button_radius: 7.0,
        field: 30.0,
        field_radius: 8.0,
        field_button: 24.0,
        field_button_radius: 5.0,
        extension_button: 28.0,
    };

    pub const COMPACT: ToolbarRow = ToolbarRow {
        height: 28.0,
        center: 14.0,
        button: 22.0,
        button_radius: 4.0,
        field: 22.0,
        field_radius: 4.0,
        field_button: 18.0,
        field_button_radius: 2.0,
        extension_button: 22.0,
    };

    pub const ICON_CENTERS: [f32; 4] = [21.0, 56.0, 92.0, 127.0];
    pub const GLYPH: f32 = 13.0;
    pub const BREADCRUMB_X: f32 = 153.0;
    pub const HOVER_SQUARE: f32 = 30.0;
    pub const HOVER_RADIUS: f32 = 7.0;
    pub const URL_PILL_RADIUS: f32 = 8.0;
    pub const EXTENSION_ICON: f32 = 16.0;
    pub const EXTENSION_PITCH: f32 = 30.25;
    pub const ITEM_GAP: f32 = 2.0;

    pub const fn row(compact: bool) -> &'static ToolbarRow {
        if compact { &COMPACT } else { &REGULAR }
    }

    pub fn compact_lift(row: &ToolbarRow) -> f32 {
        ((REGULAR.center - row.center) * 2.0).round() / 2.0
    }

    pub fn url_field_top(row: &ToolbarRow) -> f32 {
        row.center - row.field / 2.0
    }
}

pub mod panel {
    pub const INSET: f32 = 16.0;
    pub const RADIUS: f32 = 12.0;
    pub const ROW_INSET: f32 = 6.0;
    pub const ROW_PADDING: f32 = INSET - ROW_INSET;
    pub const ROW_RADIUS: f32 = RADIUS - ROW_INSET;
    pub const ROW_HEIGHT: f32 = 32.0;
    pub const ICON_SLOT: f32 = 20.0;
    pub const ICON_SIZE: f32 = 13.0;
    pub const ICON_GAP: f32 = 10.0;
    pub const TEXT_COLUMN: f32 = INSET + ICON_SLOT + ICON_GAP;
    pub const LIST_PADDING: f32 = INSET - (ROW_HEIGHT - ICON_SLOT) / 2.0;
    pub const HEADER_GAP: f32 = 8.0;
    pub const SEPARATOR_GAP: f32 = 5.0;
    pub const POPOVER_MARGIN: f32 = 8.0;
}

pub mod command_bar {
    pub const NTP_RADIUS: f32 = 20.0;
    pub const NTP_HEIGHT: f32 = 112.0;
    pub const NTP_MIN_X: f32 = 14.0;
    pub const NTP_LOGO_SIZE: f32 = 76.0;
    pub const NTP_LOGO_ABOVE_BAR: f32 = 48.6;
    pub const NTP_LOGO_VIEW: f32 = 84.0;
    pub const URL_PANEL_RADIUS: f32 = 16.0;
    pub const URL_INPUT_ROW: f32 = 54.0;
    pub const URL_SUGGESTION_ROW: f32 = 36.0;
    pub const URL_FOOTER_ROW: f32 = 53.0;
    pub const URL_SELECTED_RADIUS: f32 = 10.0;
    pub const URL_SELECTED_INSET: f32 = 4.0;
    pub const URL_TEXT_LEFT: f32 = 48.0;
    pub const URL_ICON_CENTER: f32 = 30.0;
    pub const URL_PANEL_OUTSET: f32 = 41.0;

    pub fn ntp_width(view_width: f32) -> f32 {
        if view_width < 708.0 {
            (view_width - 20.0).min(616.0)
        } else if view_width <= 1700.0 {
            652.0
        } else {
            774.0
        }
    }

    pub fn ntp_x(mid_x: f32, width: f32) -> f32 {
        (mid_x - width / 2.0).max(NTP_MIN_X)
    }

    pub fn ntp_top(content_height: f32, reserves_upsell: bool) -> f32 {
        (content_height / 2.0 - 158.0).max(100.0) + 38.0 - if reserves_upsell { 80.0 } else { 0.0 }
    }
}

pub mod tab_strip {
    pub const CARD_TOP: f32 = 42.0;
    pub const SIDE_INSET: f32 = 6.0;
    pub const CENTER_Y: f32 = 21.0;
    pub const PINNED_GROUP_X: f32 = 86.0;
    pub const PINNED_ITEM: f32 = 34.0;
    pub const PINNED_ITEM_GAP: f32 = 2.0;
    pub const ITEM_HEIGHT: f32 = 32.0;
    pub const ITEM_RADIUS: f32 = 10.0;
    pub const TAB_WIDTH: f32 = 173.0;
    pub const TAB_PITCH: f32 = 177.0;
    pub const TAB_MIN_WITH_FAVICON: f32 = 32.0;
    pub const TAB_MIN_SHARED_FAVICON: f32 = 64.0;
    pub const TAB_MIN_SELECTED: f32 = 128.0;
    pub const TAB_FAVICON_ONLY_BELOW: f32 = 52.0;
    pub const TAB_CLOSE_MIN_WIDTH: f32 = 84.0;
    pub const SELECTED_TOP: f32 = 3.0;
    pub const SELECTED_FLARE: f32 = 15.0;
    pub const PLUS_BUTTON: f32 = 32.0;
    pub const EDGE_FADE: f32 = 88.0;
    pub const EDGE_FADE_OPACITY: f32 = 0.25;
    pub const GROUP_GAP: f32 = 8.0;

    pub fn pinned_group_width(count: usize) -> f32 {
        if count == 0 {
            0.0
        } else {
            count as f32 * PINNED_ITEM + (count - 1) as f32 * PINNED_ITEM_GAP
        }
    }

    pub fn tab_widths(room: f32, minimums: &[f32]) -> Vec<f32> {
        let count = minimums.len();
        if count == 0 {
            return Vec::new();
        }
        let free_room = room - (TAB_PITCH - TAB_WIDTH) * (count - 1) as f32;
        let mut fixed = vec![false; count];
        let mut share = TAB_WIDTH;
        loop {
            let held: f32 = minimums
                .iter()
                .zip(&fixed)
                .filter(|(_, f)| **f)
                .map(|(m, _)| m.min(TAB_WIDTH))
                .sum();
            let free = fixed.iter().filter(|f| !**f).count();
            if free == 0 {
                break;
            }
            share = ((free_room - held) / free as f32).clamp(0.0, TAB_WIDTH);
            let mut grew = false;
            for (i, &min) in minimums.iter().enumerate() {
                if !fixed[i] && min > share {
                    fixed[i] = true;
                    grew = true;
                }
            }
            if !grew {
                break;
            }
        }
        minimums
            .iter()
            .zip(&fixed)
            .map(|(&min, &f)| if f { min.min(TAB_WIDTH) } else { share })
            .collect()
    }
}

pub mod split_target {
    pub const REST: [f32; 2] = [0.132, 0.383];
    pub const GROWN: [f32; 2] = [0.215, 0.611];
    pub const HOVERED: [f32; 2] = [0.241, 0.69];
    pub const REST_SIDE: f32 = 37.5;
    pub const GROWN_SIDE: f32 = 30.0;
    pub const LEAN: f32 = 0.43;
    pub const RADIUS: f32 = 20.0;
    pub const DASH_INSET: f32 = 9.5;
    pub const SHOW_DISTANCE: f32 = 26.0;
    pub const DRAG_CARD: [f32; 2] = [209.0, 110.0];
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_rules_follow_borderless_and_full_screen_flags() {
        let off = FrameRules::default();
        assert_eq!(page_frame_inset(9.0, off), 9.0);
        assert_eq!(
            page_frame_inset(
                9.0,
                FrameRules {
                    borderless_mode: true,
                    ..off
                }
            ),
            0.0
        );
        assert_eq!(
            page_frame_inset(
                9.0,
                FrameRules {
                    zero_in_full_screen: true,
                    full_screen: true,
                    ..off
                }
            ),
            0.0
        );
        assert_eq!(
            page_frame_inset(
                9.0,
                FrameRules {
                    zero_in_full_screen: true,
                    ..off
                }
            ),
            9.0
        );
        assert_eq!(
            page_frame_inset(
                5.0,
                FrameRules {
                    zero_when_tabs_hidden: true,
                    tabs_hidden: true,
                    ..off
                }
            ),
            5.0
        );
        assert_eq!(
            page_frame_inset(
                5.0,
                FrameRules {
                    zero_when_tabs_hidden: true,
                    full_screen: true,
                    ..off
                }
            ),
            5.0
        );
        assert_eq!(
            page_frame_inset(
                5.0,
                FrameRules {
                    zero_when_tabs_hidden: true,
                    full_screen: true,
                    tabs_hidden: true,
                    ..off
                }
            ),
            0.0
        );
        assert_eq!(page_frame_inset(40.0, off), 12.0);
    }

    #[test]
    fn concentric_radius_matches_the_shell_tests() {
        assert_eq!(PageFrame::concentric(0.0, 19.0, 19.0).radius, 0.0);
        assert_eq!(PageFrame::concentric(9.0, 19.0, 19.0).radius, 10.0);
        assert_eq!(PageFrame::concentric(12.0, 19.0, 19.0).radius, 7.0);
        assert_eq!(PageFrame::concentric(18.0, 19.0, 19.0).radius, 2.0);
        assert_eq!(PageFrame::concentric(0.0, 19.0, 19.0).peek.radius, 18.0);
        assert_eq!(PageFrame::concentric(0.0, 19.0, 16.0).peek.radius, 15.0);
        assert!((PageFrame::concentric(1.0, 19.0, 16.0).radius - 46.0 / 3.0).abs() < 1e-5);
        for inset in [9.0, 12.0] {
            assert_eq!(
                PageFrame::concentric(inset, 19.0, 16.0).radius,
                PageFrame::concentric(inset, 19.0, 19.0).radius
            );
        }
    }

    #[test]
    fn scaled_radius_matches_the_dia_spec_measurements() {
        let radii: Vec<f32> = [0.0, 5.0, 9.0, 12.0]
            .iter()
            .map(|&f| PageFrame::scaled(f).radius)
            .collect();
        assert_eq!(radii, vec![0.0, 5.5, 10.0, 10.0]);
    }

    #[test]
    fn peek_and_split_gaps_never_collapse() {
        let zero = PageFrame::default_window(0.0);
        assert_eq!(
            (zero.peek.left, zero.peek.top, zero.peek.bottom),
            (1.0, 1.0, 1.0)
        );
        assert_eq!(zero.split_gap, 2.0);
        let wide = PageFrame::default_window(12.0);
        assert_eq!(wide.split_gap, 12.0);
        assert_eq!(wide.dock_gap, 3.0);
        assert_eq!(wide.docked_card_left(190.0), 193.0);
        assert_eq!(
            PageFrame::default_window(9.0).docked_card_left(190.0),
            190.0
        );
        assert_eq!(PageFrame::default_window(4.0).edge_watch_band(), 3.0);
        assert_eq!(PageFrame::default_window(12.0).edge_watch_band(), 3.0);
        assert_eq!(PageFrame::default_window(9.0).peek_hold_width(190.0), 239.0);
    }

    #[test]
    fn row_metrics_follow_minimalism_and_sidebar_text_size() {
        use sidebar::RowMetrics;
        let m = |min, size| {
            let r = RowMetrics::of(min, size);
            (r.row_height, r.row_gap, r.pinned_height)
        };
        assert_eq!(m(false, SidebarTextSize::Default), (34.0, 3.0, 41.0));
        assert_eq!(m(false, SidebarTextSize::Large), (39.0, 3.0, 47.0));
        assert_eq!(m(false, SidebarTextSize::Larger), (44.0, 4.0, 54.0));
        assert_eq!(m(true, SidebarTextSize::Default), (28.0, 2.0, 34.0));
        assert_eq!(m(true, SidebarTextSize::Large), (32.0, 2.0, 39.0));
        assert_eq!(m(true, SidebarTextSize::Larger), (37.0, 3.0, 44.0));
        assert!(sidebar::set_row_metrics(RowMetrics::of(
            true,
            SidebarTextSize::Default
        )));
        assert_eq!(sidebar::row_pitch(), 30.0);
        assert!(!sidebar::set_row_metrics(RowMetrics::MINIMALISM));
        sidebar::set_row_metrics(RowMetrics::BASE);
        assert_eq!(sidebar::row_height(), sidebar::ROW_HEIGHT);
    }

    #[test]
    fn sidebar_metrics_follow_the_dia_measurements() {
        assert_eq!(sidebar::ROW_PITCH, 37.0);
        assert_eq!(sidebar::row_radius(34.0), 10.0);
        assert_eq!(sidebar::row_radius(24.0), 8.0);
        assert_eq!(lights::CENTER, [25.0, 30.0]);
        assert_eq!(lights::center(9.0, false), [25.0, 30.0]);
        assert_eq!(lights::center(0.0, false), [25.0, 21.0]);
        assert_eq!(lights::center(9.0, true), [25.0, 23.0]);
        assert_eq!(sidebar::header_of(false, 30.0), 46.0);
        assert_eq!(sidebar::header_of(false, 21.0), 37.0);
        assert_eq!(sidebar::first_row_top(false, 30.0), 54.0);
        assert_eq!(SidebarTextSize::Large.clear_divider_height(), 23.0);
        assert_eq!(SidebarTextSize::Larger.points(13.0), 17.0);
        assert_eq!(SidebarTextSize::Large.icon_points(16.0), 18.0);
    }

    #[test]
    fn panel_grid_lands_titles_on_one_column() {
        assert_eq!(panel::TEXT_COLUMN, 46.0);
        assert_eq!(panel::LIST_PADDING, 10.0);
        assert_eq!(panel::ROW_RADIUS, 6.0);
        assert_eq!(panel::ROW_PADDING, 10.0);
    }

    #[test]
    fn new_tab_bar_geometry_follows_the_binary() {
        assert_eq!(command_bar::ntp_width(1315.0), 652.0);
        assert_eq!(command_bar::ntp_width(1800.0), 774.0);
        assert_eq!(command_bar::ntp_width(600.0), 580.0);
        assert_eq!(command_bar::ntp_width(700.0), 616.0);
        assert_eq!(command_bar::ntp_x(657.5, 652.0), 331.5);
        assert_eq!(command_bar::ntp_top(895.0, false), 327.5);
        assert_eq!(command_bar::ntp_top(200.0, false), 138.0);
        assert_eq!(command_bar::ntp_top(895.0, true), 247.5);
    }

    #[test]
    fn sidebar_width_limits_keep_page_room() {
        assert_eq!(sidebar_width_limit(None), 400.0);
        assert_eq!(sidebar_width_limit(Some(500.0)), 190.0);
        assert_eq!(sidebar_width_limit(Some(300.0)), 160.0);
        assert_eq!(sidebar_width_limit(Some(f32::NAN)), 400.0);
        assert_eq!(shown_sidebar_width(233.3, Some(1512.0)), 233.3);
        assert!(
            valid_page_frame(0)
                && valid_page_frame(12)
                && !valid_page_frame(13)
                && !valid_page_frame(-1)
        );
    }

    #[test]
    fn little_ardia_fits_inside_eighty_percent_of_the_screen() {
        assert_eq!(
            little_ardia_size([2400.0, 1300.0], [1512.0, 949.0]),
            [1209.6, 759.2]
        );
        assert_eq!(
            little_ardia_size([900.0, 640.0], [1512.0, 949.0]),
            [900.0, 640.0]
        );
        assert_eq!(
            little_ardia_size([100.0, 100.0], [1512.0, 949.0]),
            [420.0, 300.0]
        );
    }

    #[test]
    fn strip_widths_share_room_down_to_each_minimum() {
        assert_eq!(tab_strip::pinned_group_width(2), 70.0);
        assert_eq!(
            tab_strip::tab_widths(1000.0, &[32.0, 128.0]),
            vec![173.0, 173.0]
        );
        let tight = tab_strip::tab_widths(200.0, &[32.0, 128.0, 64.0]);
        assert_eq!(tight, vec![32.0, 128.0, 64.0]);
        let roomy = tab_strip::tab_widths(400.0, &[32.0, 128.0, 64.0]);
        assert!(
            roomy.iter().all(|&w| (w - 392.0 / 3.0).abs() < 1e-3),
            "{roomy:?}"
        );
        let mixed = tab_strip::tab_widths(300.0, &[32.0, 128.0, 32.0]);
        assert_eq!(mixed, vec![82.0, 128.0, 82.0]);
    }
}
