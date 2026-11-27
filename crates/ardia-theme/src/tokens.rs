use crate::color::RgbaColor;
use serde::{Deserialize, Serialize};

const fn white(a: f32) -> RgbaColor {
    RgbaColor::white(a)
}

const fn black(a: f32) -> RgbaColor {
    RgbaColor::black(a)
}

const fn hex(v: u32) -> RgbaColor {
    RgbaColor::hex(v)
}

const fn hexa(v: u32) -> RgbaColor {
    RgbaColor::hexa(v)
}

const fn rgba(r: u8, g: u8, b: u8, a: f32) -> RgbaColor {
    RgbaColor::rgba8(r, g, b, a)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorRoles {
    pub dark: bool,
    pub grain: f32,
    pub card: RgbaColor,
    pub card_edge: RgbaColor,
    pub divider: RgbaColor,
    pub text_primary: RgbaColor,
    pub text_tab: RgbaColor,
    pub text_secondary: RgbaColor,
    pub text_tertiary: RgbaColor,
    pub icon: RgbaColor,
    pub icon_disabled: RgbaColor,
    pub mark: RgbaColor,
    pub tab_hover: RgbaColor,
    pub tab_pressed: RgbaColor,
    pub tab_selected: RgbaColor,
    pub tab_selected_text: RgbaColor,
    pub tab_selected_border: [RgbaColor; 2],
    pub tab_selected_shadow: RgbaColor,
    pub tab_selected_shadow_radius: f32,
    pub pinned_resting: RgbaColor,
    pub pinned_resting_stroke: RgbaColor,
    pub pinned_selected_fill: RgbaColor,
    pub pinned_selected_rim: RgbaColor,
    pub pinned_selected_outline: RgbaColor,
    pub toolbar_hover: RgbaColor,
    pub toolbar_pressed: RgbaColor,
    pub url_pill: RgbaColor,
    pub panel: RgbaColor,
    pub panel_border: RgbaColor,
    pub panel_shadow_opacity: f32,
    pub scrim: RgbaColor,
    pub row_selected: RgbaColor,
    pub row_hover: RgbaColor,
    pub command_bar_selected: RgbaColor,
    pub command_bar_hover: RgbaColor,
    pub selection: RgbaColor,
    pub placeholder: RgbaColor,
    pub chip_border: RgbaColor,
    pub chip_text: RgbaColor,
    pub go_button: RgbaColor,
    pub go_button_hover: RgbaColor,
    pub go_button_pressed: RgbaColor,
    pub go_button_idle: RgbaColor,
    pub ntp_bar_solid: RgbaColor,
    pub ntp_bar_border: RgbaColor,
    pub accent: RgbaColor,
    pub favicon_tile: RgbaColor,
    pub drop_zone_fill: RgbaColor,
    pub popover_fill: RgbaColor,
    pub popover_tint: RgbaColor,
    pub popover_border: RgbaColor,
    pub popover_row_pressed: RgbaColor,
    pub prompt_fill: RgbaColor,
    pub prompt_fill_hover: RgbaColor,
    pub prompt_fill_pressed: RgbaColor,
    pub toggle_off: RgbaColor,
    pub tooltip_fill: RgbaColor,
    pub tooltip_ring: RgbaColor,
    pub tooltip_text: RgbaColor,
    pub on_primary: RgbaColor,
    pub ring_radio_fill: RgbaColor,
    pub ring_radio_border: RgbaColor,
    pub ring_radio_on: RgbaColor,
    pub hud_close_fill: RgbaColor,
    pub hud_close_hover: RgbaColor,
    pub hud_close_border: RgbaColor,
    pub hud_close_glyph: RgbaColor,
    pub group_fill: RgbaColor,
    pub group_border: RgbaColor,
    pub control: RgbaColor,
    pub control_hover: RgbaColor,
    pub control_pressed: RgbaColor,
    pub control_border: RgbaColor,
    pub field: RgbaColor,
    pub field_border: RgbaColor,
    pub switch_off: RgbaColor,
    pub knob_border: RgbaColor,
    pub form_accent: RgbaColor,
    pub form_accent_pressed: RgbaColor,
    pub on_accent: RgbaColor,
    pub destructive: RgbaColor,
    pub warning: RgbaColor,
    pub success: RgbaColor,
    pub search_flash: RgbaColor,
    pub badge_fill: RgbaColor,
    pub chip_fill: RgbaColor,
    pub progress_track: RgbaColor,
    pub toast_fill: RgbaColor,
}

pub const DARK: ColorRoles = ColorRoles {
    dark: true,
    grain: 0.006,
    card: rgba(18, 18, 18, 0.5),
    card_edge: black(0.35),
    divider: white(0.09),
    text_primary: RgbaColor::WHITE,
    text_tab: hexa(0xFFFFFFC7),
    text_secondary: hexa(0xFFFFFF80),
    text_tertiary: hexa(0xFFFFFF59),
    icon: hexa(0xF7F5FFC6),
    icon_disabled: hexa(0xF7F5FF4D),
    mark: RgbaColor::WHITE,
    tab_hover: white(0.16),
    tab_pressed: white(0.31),
    tab_selected: rgba(18, 18, 18, 0.5),
    tab_selected_text: RgbaColor::WHITE,
    tab_selected_border: [white(0.15), white(0.15)],
    tab_selected_shadow: white(0.15),
    tab_selected_shadow_radius: 15.0,
    pinned_resting: white(0.1),
    pinned_resting_stroke: white(0.14),
    pinned_selected_fill: white(0.25),
    pinned_selected_rim: black(0.85),
    pinned_selected_outline: white(0.2),
    toolbar_hover: white(0.1),
    toolbar_pressed: white(0.18),
    url_pill: white(0.07),
    panel: hex(0x2A2A2A),
    panel_border: white(0.1),
    panel_shadow_opacity: 0.5,
    scrim: black(0.35),
    row_selected: white(0.22),
    row_hover: white(0.07),
    command_bar_selected: white(0.145),
    command_bar_hover: rgba(120, 125, 134, 0.32),
    selection: rgba(120, 125, 134, 0.7),
    placeholder: hexa(0xFFFFFF87),
    chip_border: white(0.15),
    chip_text: hexa(0xFFFFFF99),
    go_button: hex(0xDCCBD8),
    go_button_hover: hex(0xE6D8E2),
    go_button_pressed: hex(0xC9B8C5),
    go_button_idle: white(0.08),
    ntp_bar_solid: hex(0x2D2D2D),
    ntp_bar_border: rgba(120, 125, 134, 0.32),
    accent: hex(0x4A77D4),
    favicon_tile: rgba(247, 245, 255, 0.2),
    drop_zone_fill: white(0.06),
    popover_fill: rgba(38, 38, 38, 0.94),
    popover_tint: rgba(38, 38, 38, 0.72),
    popover_border: white(0.14),
    popover_row_pressed: white(0.12),
    prompt_fill: white(0.1),
    prompt_fill_hover: white(0.14),
    prompt_fill_pressed: white(0.18),
    toggle_off: white(0.16),
    tooltip_fill: hex(0x262626),
    tooltip_ring: black(0.4),
    tooltip_text: white(0.85),
    on_primary: RgbaColor::BLACK,
    ring_radio_fill: white(0.1),
    ring_radio_border: white(0.25),
    ring_radio_on: RgbaColor::WHITE,
    hud_close_fill: hexa(0xFFFFFF14),
    hud_close_hover: hexa(0xFFFFFF4D),
    hud_close_border: hexa(0xFFFFFF1F),
    hud_close_glyph: hexa(0xFFFFFFE6),
    group_fill: white(0.045),
    group_border: white(0.07),
    control: white(0.1),
    control_hover: white(0.14),
    control_pressed: white(0.2),
    control_border: white(0.08),
    field: black(0.25),
    field_border: white(0.12),
    switch_off: white(0.14),
    knob_border: black(0.12),
    form_accent: hex(0x0A84FF),
    form_accent_pressed: hex(0x0060D0),
    on_accent: RgbaColor::WHITE,
    destructive: hex(0xFF453A),
    warning: hex(0xFF9F0A),
    success: hex(0x30D158),
    search_flash: rgba(10, 132, 255, 0.22),
    badge_fill: white(0.15),
    chip_fill: white(0.1),
    progress_track: hex(0x717782),
    toast_fill: rgba(44, 42, 43, 0.9),
};

pub const LIGHT: ColorRoles = ColorRoles {
    dark: false,
    grain: 0.05,
    card: white(0.7),
    card_edge: black(0.08),
    divider: black(0.09),
    text_primary: RgbaColor::BLACK,
    text_tab: hexa(0x000000AD),
    text_secondary: hexa(0x00000080),
    text_tertiary: hexa(0x00000059),
    icon: hexa(0x000000C6),
    icon_disabled: hexa(0x0000004D),
    mark: RgbaColor::BLACK,
    tab_hover: white(0.55),
    tab_pressed: white(0.7),
    tab_selected: white(0.7),
    tab_selected_text: RgbaColor::BLACK,
    tab_selected_border: [white(0.98), black(0.06)],
    tab_selected_shadow: black(0.12),
    tab_selected_shadow_radius: 12.5,
    pinned_resting: black(0.05),
    pinned_resting_stroke: black(0.2),
    pinned_selected_fill: white(0.7),
    pinned_selected_rim: black(0.12),
    pinned_selected_outline: white(0.98),
    toolbar_hover: black(0.06),
    toolbar_pressed: black(0.1),
    url_pill: black(0.05),
    panel: RgbaColor::WHITE,
    panel_border: black(0.1),
    panel_shadow_opacity: 0.18,
    scrim: black(0.15),
    row_selected: rgba(15, 24, 44, 0.08),
    row_hover: black(0.07),
    command_bar_selected: rgba(15, 24, 44, 0.08),
    command_bar_hover: rgba(15, 24, 44, 0.05),
    selection: rgba(120, 125, 134, 0.4),
    placeholder: hexa(0x00000066),
    chip_border: black(0.12),
    chip_text: hexa(0x00000099),
    go_button: hex(0x0F182C),
    go_button_hover: hex(0x1B2640),
    go_button_pressed: hex(0x26314A),
    go_button_idle: black(0.06),
    ntp_bar_solid: hex(0xFEFFFF),
    ntp_bar_border: black(0.07),
    accent: hex(0x6395FC),
    favicon_tile: black(0.13),
    drop_zone_fill: black(0.04),
    popover_fill: white(0.96),
    popover_tint: white(0.7),
    popover_border: black(0.12),
    popover_row_pressed: black(0.1),
    prompt_fill: black(0.06),
    prompt_fill_hover: black(0.09),
    prompt_fill_pressed: black(0.12),
    toggle_off: black(0.12),
    tooltip_fill: RgbaColor::WHITE,
    tooltip_ring: black(0.12),
    tooltip_text: black(0.85),
    on_primary: RgbaColor::WHITE,
    ring_radio_fill: RgbaColor::WHITE,
    ring_radio_border: black(0.2),
    ring_radio_on: RgbaColor::BLACK,
    hud_close_fill: hexa(0x00000033),
    hud_close_hover: hexa(0x0000004D),
    hud_close_border: hexa(0x00000014),
    hud_close_glyph: hexa(0xFFFFFFE6),
    group_fill: black(0.028),
    group_border: black(0.07),
    control: RgbaColor::WHITE,
    control_hover: hex(0xF7F7F7),
    control_pressed: hex(0xEBEBEB),
    control_border: black(0.14),
    field: RgbaColor::WHITE,
    field_border: black(0.14),
    switch_off: black(0.1),
    knob_border: black(0.12),
    form_accent: hex(0x007AFF),
    form_accent_pressed: hex(0x0060D0),
    on_accent: RgbaColor::WHITE,
    destructive: hex(0xFF3B30),
    warning: hex(0xFF9500),
    success: hex(0x34C759),
    search_flash: rgba(0, 122, 255, 0.16),
    badge_fill: black(0.15),
    chip_fill: black(0.06),
    progress_track: hex(0xCED7E7),
    toast_fill: white(0.92),
};

pub const fn roles(dark: bool) -> &'static ColorRoles {
    if dark { &DARK } else { &LIGHT }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HighContrastInk {
    pub tab: f32,
    pub icon: f32,
    pub placeholder: f32,
    pub secondary: f32,
    pub tertiary: f32,
}

pub const HIGH_CONTRAST_INK: HighContrastInk = HighContrastInk {
    tab: 1.0,
    icon: 1.0,
    placeholder: 0.82,
    secondary: 0.82,
    tertiary: 0.7,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DiaTokens {
    pub tab_background_hovered: RgbaColor,
    pub tab_background_pressed: RgbaColor,
    pub tab_background_selected_primary: RgbaColor,
    pub tab_background_selected_secondary: RgbaColor,
    pub tab_background_unselected: RgbaColor,
    pub tab_outline: RgbaColor,
    pub tab_selected_shadow: RgbaColor,
    pub tab_title_selected: RgbaColor,
    pub tab_title_unselected: RgbaColor,
    pub dock_item_resting_background: RgbaColor,
    pub dock_item_resting_stroke: RgbaColor,
    pub dock_item_default_selection_stroke: RgbaColor,
    pub window_content_base_tint: RgbaColor,
    pub window_content_rebrand_tint: RgbaColor,
    pub window_background_base_tint: RgbaColor,
    pub menu_item_background_hovered: RgbaColor,
    pub menu_hairline_border: RgbaColor,
    pub command_bar_hover_go: RgbaColor,
    pub command_bar_placeholder: RgbaColor,
    pub command_bar_primary_text: RgbaColor,
    pub command_bar_secondary_text: RgbaColor,
    pub command_bar_cursor_search: RgbaColor,
    pub command_bar_border: RgbaColor,
    pub command_bar_panel_background: RgbaColor,
    pub command_bar_transparent_background: RgbaColor,
    pub downloads_button_tint: RgbaColor,
    pub primary_600: RgbaColor,
    pub primary_1100: RgbaColor,
    pub primary_1200: RgbaColor,
    pub tab_group_neutral_background: RgbaColor,
    pub tab_group_neutral_background_hovered: RgbaColor,
    pub tab_group_sidebar_stroke: RgbaColor,
    pub secondary_label: RgbaColor,
    pub tertiary_label: RgbaColor,
}

pub const DIA_DARK: DiaTokens = DiaTokens {
    tab_background_hovered: white(0.16),
    tab_background_pressed: white(0.31),
    tab_background_selected_primary: RgbaColor::BLACK,
    tab_background_selected_secondary: white(0.25),
    tab_background_unselected: white(0.06),
    tab_outline: white(0.2),
    tab_selected_shadow: white(0.15),
    tab_title_selected: RgbaColor::WHITE,
    tab_title_unselected: white(0.78),
    dock_item_resting_background: white(0.1),
    dock_item_resting_stroke: white(0.14),
    dock_item_default_selection_stroke: white(0.45),
    window_content_base_tint: rgba(18, 18, 18, 0.6),
    window_content_rebrand_tint: rgba(18, 18, 18, 0.5),
    window_background_base_tint: black(0.4),
    menu_item_background_hovered: white(0.07),
    menu_hairline_border: white(0.3),
    command_bar_hover_go: rgba(120, 125, 134, 0.32),
    command_bar_placeholder: white(0.53),
    command_bar_primary_text: RgbaColor::WHITE,
    command_bar_secondary_text: rgba(239, 244, 255, 0.6),
    command_bar_cursor_search: hex(0x4A77D4),
    command_bar_border: rgba(120, 125, 134, 0.32),
    command_bar_panel_background: hex(0x2D2D2D),
    command_bar_transparent_background: rgba(24, 24, 24, 0.8),
    downloads_button_tint: rgba(247, 245, 255, 0.78),
    primary_600: white(0.6),
    primary_1100: white(0.12),
    primary_1200: white(0.09),
    tab_group_neutral_background: white(0.1),
    tab_group_neutral_background_hovered: white(0.12),
    tab_group_sidebar_stroke: white(0.1),
    secondary_label: white(0.55),
    tertiary_label: white(0.25),
};

pub const DIA_LIGHT: DiaTokens = DiaTokens {
    tab_background_hovered: white(0.55),
    tab_background_pressed: white(0.7),
    tab_background_selected_primary: RgbaColor::WHITE,
    tab_background_selected_secondary: white(0.7),
    tab_background_unselected: black(0.06),
    tab_outline: white(0.98),
    tab_selected_shadow: black(0.12),
    tab_title_selected: RgbaColor::BLACK,
    tab_title_unselected: black(0.68),
    dock_item_resting_background: black(0.05),
    dock_item_resting_stroke: black(0.18),
    dock_item_default_selection_stroke: black(0.48),
    window_content_base_tint: white(0.8),
    window_content_rebrand_tint: white(0.7),
    window_background_base_tint: white(0.8),
    menu_item_background_hovered: black(0.07),
    menu_hairline_border: black(0.25),
    command_bar_hover_go: rgba(15, 24, 44, 0.08),
    command_bar_placeholder: black(0.4),
    command_bar_primary_text: hex(0x0F182C),
    command_bar_secondary_text: rgba(15, 24, 44, 0.6),
    command_bar_cursor_search: hex(0x6395FC),
    command_bar_border: black(0.07),
    command_bar_panel_background: RgbaColor::new(0.996, 1.0, 1.0, 1.0),
    command_bar_transparent_background: white(0.85),
    downloads_button_tint: black(0.78),
    primary_600: black(0.6),
    primary_1100: black(0.12),
    primary_1200: black(0.09),
    tab_group_neutral_background: black(0.05),
    tab_group_neutral_background_hovered: white(0.4),
    tab_group_sidebar_stroke: black(0.1),
    secondary_label: black(0.5),
    tertiary_label: black(0.26),
};

pub const fn dia(dark: bool) -> &'static DiaTokens {
    if dark { &DIA_DARK } else { &DIA_LIGHT }
}

pub const BRAND_SPECTRUM: [RgbaColor; 6] = [
    hex(0x0358F7),
    hex(0x5092C7),
    hex(0xE1E1FE),
    hex(0xFFD400),
    hex(0xFA3D1D),
    hex(0xFD02F5),
];

pub const NEUTRAL_GREY: RgbaColor = hexa(0x808080A6);
pub const INCOGNITO_TINT: RgbaColor = hex(0x3A3A3C);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileColor {
    Plum,
    Blue,
    Purple,
    Pink,
    Red,
    Orange,
    Yellow,
    Green,
    Neutral,
}

impl ProfileColor {
    pub const ALL: [ProfileColor; 9] = [
        ProfileColor::Plum,
        ProfileColor::Blue,
        ProfileColor::Purple,
        ProfileColor::Pink,
        ProfileColor::Red,
        ProfileColor::Orange,
        ProfileColor::Yellow,
        ProfileColor::Green,
        ProfileColor::Neutral,
    ];

    pub const NEW_PROFILE_CYCLE: [ProfileColor; 7] = [
        ProfileColor::Blue,
        ProfileColor::Green,
        ProfileColor::Orange,
        ProfileColor::Purple,
        ProfileColor::Red,
        ProfileColor::Yellow,
        ProfileColor::Pink,
    ];

    pub const fn key(self) -> &'static str {
        match self {
            ProfileColor::Plum => "plum",
            ProfileColor::Blue => "blue",
            ProfileColor::Purple => "purple",
            ProfileColor::Pink => "pink",
            ProfileColor::Red => "red",
            ProfileColor::Orange => "orange",
            ProfileColor::Yellow => "yellow",
            ProfileColor::Green => "green",
            ProfileColor::Neutral => "neutral",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.key() == key)
    }

    pub const fn spec(self) -> &'static ProfileColorSpec {
        match self {
            ProfileColor::Plum => &PLUM,
            ProfileColor::Blue => &BLUE,
            ProfileColor::Purple => &PURPLE,
            ProfileColor::Pink => &PINK,
            ProfileColor::Red => &RED,
            ProfileColor::Orange => &ORANGE,
            ProfileColor::Yellow => &YELLOW,
            ProfileColor::Green => &GREEN,
            ProfileColor::Neutral => &NEUTRAL,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AreaLightPalette {
    Blue,
    Red,
    Pink,
    Orange,
    Yellow,
    Green,
    Purple,
}

impl AreaLightPalette {
    pub const fn key(self) -> &'static str {
        match self {
            AreaLightPalette::Blue => "blue",
            AreaLightPalette::Red => "red",
            AreaLightPalette::Pink => "pink",
            AreaLightPalette::Orange => "orange",
            AreaLightPalette::Yellow => "yellow",
            AreaLightPalette::Green => "green",
            AreaLightPalette::Purple => "purple",
        }
    }

    pub const fn area_light(self) -> [RgbaColor; 5] {
        match self {
            AreaLightPalette::Blue => [
                hex(0x4691C3),
                hex(0x4BA5B9),
                hex(0x418CBE),
                hex(0x48B6DA),
                hex(0x55A2E4),
            ],
            AreaLightPalette::Red => [
                hex(0xC1575C),
                hex(0xC35F4B),
                hex(0xB95058),
                hex(0xDB463C),
                hex(0xE16070),
            ],
            AreaLightPalette::Pink => [
                hex(0xD37B8B),
                hex(0xC387A0),
                hex(0xC3738C),
                hex(0xD27DA8),
                hex(0xE37C94),
            ],
            AreaLightPalette::Orange => [
                hex(0xD87249),
                hex(0xD08C64),
                hex(0xD26941),
                hex(0xDA965A),
                hex(0xDE7034),
            ],
            AreaLightPalette::Yellow => [
                hex(0xE3AC38),
                hex(0xF0BE55),
                hex(0xEBB441),
                hex(0xEEBB26),
                hex(0xF3C93B),
            ],
            AreaLightPalette::Green => [
                hex(0x3EB489),
                hex(0x73B982),
                hex(0x4BAA82),
                hex(0x84C978),
                hex(0x45BE74),
            ],
            AreaLightPalette::Purple => [
                hex(0x7873AF),
                hex(0x8C69AF),
                hex(0x7D78B4),
                hex(0x877ECB),
                hex(0x856BD0),
            ],
        }
    }

    pub const fn power_up(self) -> [RgbaColor; 5] {
        match self {
            AreaLightPalette::Pink => [
                hex(0xFF6AFF),
                hex(0xFE8097),
                hex(0xFF9966),
                hex(0xFCE0FF),
                hex(0xFA62B1),
            ],
            AreaLightPalette::Purple => [
                hex(0x7293FF),
                hex(0x7D5DFF),
                hex(0xE263FF),
                hex(0xFF81EE),
                hex(0xA585FF),
            ],
            AreaLightPalette::Red => [
                hex(0xFD3131),
                hex(0xFA607C),
                hex(0xFDA733),
                hex(0xFFEBC9),
                hex(0xF55F5D),
            ],
            AreaLightPalette::Orange => [
                hex(0xFFBB62),
                hex(0xFE8026),
                hex(0xFF7C5F),
                hex(0xFFFCBE),
                hex(0xFF9D00),
            ],
            AreaLightPalette::Yellow => [
                hex(0xFFD11A),
                hex(0xFFE23E),
                hex(0xFFA144),
                hex(0xF8FFB5),
                hex(0xFFE30A),
            ],
            AreaLightPalette::Green => [
                hex(0x90CE01),
                hex(0x43CC60),
                hex(0x0CD9EB),
                hex(0xC3EEAF),
                hex(0x9EDD73),
            ],
            AreaLightPalette::Blue => [
                hex(0x4ACCFF),
                hex(0x5FADFF),
                hex(0x60F0CF),
                hex(0x9CEEFF),
                hex(0x72C1FF),
            ],
        }
    }
}

pub const DEFAULT_POWER_UP: [RgbaColor; 7] = [
    hex(0x7E1731),
    hex(0x334CB4),
    hex(0x2D81FF),
    hex(0x2D81FF),
    hex(0xFFF268),
    hex(0xF70305),
    hex(0xFE64CD),
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProfileColorSpec {
    pub color: ProfileColor,
    pub name: &'static str,
    pub swatch: RgbaColor,
    pub palette: Option<AreaLightPalette>,
    pub power_up: Option<RgbaColor>,
    pub tint: Option<RgbaColor>,
    pub action: Option<RgbaColor>,
}

impl ProfileColorSpec {
    pub fn power_up_color(&self) -> RgbaColor {
        match self.palette {
            Some(_) => self.power_up.unwrap_or(self.swatch),
            None => NEUTRAL_GREY,
        }
    }

    pub fn action_color(&self) -> RgbaColor {
        self.action.unwrap_or(self.swatch)
    }

    pub fn is_neutral(&self) -> bool {
        self.palette.is_none()
    }
}

const fn spec(
    color: ProfileColor,
    name: &'static str,
    swatch: u32,
    palette: Option<AreaLightPalette>,
) -> ProfileColorSpec {
    ProfileColorSpec {
        color,
        name,
        swatch: hex(swatch),
        palette,
        power_up: None,
        tint: None,
        action: None,
    }
}

const PLUM: ProfileColorSpec = ProfileColorSpec {
    color: ProfileColor::Plum,
    name: "Plum",
    swatch: hex(0xC07A98),
    palette: Some(AreaLightPalette::Pink),
    power_up: Some(hex(0xB5556B)),
    tint: Some(hex(0xB25B6B)),
    action: Some(hex(0xDD899B)),
};
const BLUE: ProfileColorSpec = spec(
    ProfileColor::Blue,
    "Blue",
    0x4691C3,
    Some(AreaLightPalette::Blue),
);
const PURPLE: ProfileColorSpec = spec(
    ProfileColor::Purple,
    "Purple",
    0x7873AF,
    Some(AreaLightPalette::Purple),
);
const PINK: ProfileColorSpec = spec(
    ProfileColor::Pink,
    "Pink",
    0xD37B8B,
    Some(AreaLightPalette::Pink),
);
const RED: ProfileColorSpec = spec(
    ProfileColor::Red,
    "Red",
    0xC1575C,
    Some(AreaLightPalette::Red),
);
const ORANGE: ProfileColorSpec = spec(
    ProfileColor::Orange,
    "Orange",
    0xD87249,
    Some(AreaLightPalette::Orange),
);
const YELLOW: ProfileColorSpec = spec(
    ProfileColor::Yellow,
    "Yellow",
    0xE3AC38,
    Some(AreaLightPalette::Yellow),
);
const GREEN: ProfileColorSpec = spec(
    ProfileColor::Green,
    "Green",
    0x3EB489,
    Some(AreaLightPalette::Green),
);
const NEUTRAL: ProfileColorSpec = spec(ProfileColor::Neutral, "Neutral", 0x8E8E93, None);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SiteToolbarRoles {
    pub text: RgbaColor,
    pub secondary: RgbaColor,
    pub icon: RgbaColor,
    pub icon_disabled: RgbaColor,
    pub hover: RgbaColor,
    pub pressed: RgbaColor,
    pub pill: RgbaColor,
    pub divider: RgbaColor,
}

pub const SITE_TOOLBAR_ON_LIGHT: SiteToolbarRoles = SiteToolbarRoles {
    text: hexa(0x000000E6),
    secondary: hexa(0x00000080),
    icon: hexa(0x000000C6),
    icon_disabled: hexa(0x00000040),
    hover: black(0.07),
    pressed: black(0.12),
    pill: black(0.06),
    divider: black(0.1),
};

pub const SITE_TOOLBAR_ON_DARK: SiteToolbarRoles = SiteToolbarRoles {
    text: RgbaColor::WHITE,
    secondary: hexa(0xFFFFFF99),
    icon: hexa(0xFFFFFFD9),
    icon_disabled: hexa(0xFFFFFF4D),
    hover: white(0.14),
    pressed: white(0.22),
    pill: white(0.1),
    divider: white(0.12),
};

pub fn site_toolbar_roles(site_color: RgbaColor) -> &'static SiteToolbarRoles {
    if site_color.is_light() {
        &SITE_TOOLBAR_ON_LIGHT
    } else {
        &SITE_TOOLBAR_ON_DARK
    }
}

pub const CARET_DARK: RgbaColor = RgbaColor::WHITE;
pub const CARET_LIGHT: RgbaColor = hex(0x787D86);
pub const QUIET_GLYPH_LIGHT: RgbaColor = hexa(0x0000007A);
pub const POPOVER_MENU_MATERIAL_LIGHT: RgbaColor = rgba(246, 246, 246, 0.72);
pub const POPOVER_MENU_MATERIAL_DARK: RgbaColor = rgba(40, 40, 42, 0.72);
pub const ARC_SELECTED_FILL_DARK: RgbaColor = white(0.24);
pub const ARC_SELECTED_FILL_LIGHT: RgbaColor = white(0.8);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CloseOnArt {
    pub rest: RgbaColor,
    pub hover: RgbaColor,
    pub pressed: RgbaColor,
    pub glyph: RgbaColor,
}

pub const CLOSE_ON_ART: CloseOnArt = CloseOnArt {
    rest: white(0.1),
    hover: white(0.2),
    pressed: white(0.3),
    glyph: hexa(0xFFFFFF8C),
};

pub mod space {
    pub const NONE: f32 = 0.0;
    pub const XXS: f32 = 2.0;
    pub const XS: f32 = 4.0;
    pub const S: f32 = 6.0;
    pub const M: f32 = 8.0;
    pub const ML: f32 = 10.0;
    pub const L: f32 = 12.0;
    pub const XL: f32 = 16.0;
    pub const XXL: f32 = 20.0;
    pub const XXXL: f32 = 24.0;
    pub const HUGE: f32 = 32.0;
}

pub mod radius {
    pub const NONE: f32 = 0.0;
    pub const HAIR: f32 = 2.0;
    pub const CONTROL: f32 = 4.0;
    pub const TILE: f32 = 8.0;
    pub const PANEL: f32 = 12.0;
    pub const SHEET: f32 = 16.0;
    pub const HERO: f32 = 20.0;
    pub const CHROME: f32 = 10.0;
    pub const TOOLBAR: f32 = 7.0;
    pub const PINNED: f32 = 10.0;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TypeSize {
    Badge,
    Tiny,
    Caption,
    Small,
    Body,
    Title,
    Large,
}

impl TypeSize {
    pub const fn points(self) -> f32 {
        match self {
            TypeSize::Badge => 9.0,
            TypeSize::Tiny => 10.0,
            TypeSize::Caption => 11.0,
            TypeSize::Small => 12.0,
            TypeSize::Body => 13.0,
            TypeSize::Title => 15.0,
            TypeSize::Large => 17.0,
        }
    }

    pub const fn line_height(self) -> f32 {
        match self {
            TypeSize::Badge => 11.0,
            TypeSize::Tiny => 13.0,
            TypeSize::Caption => 14.0,
            TypeSize::Small => 15.0,
            TypeSize::Body => 16.0,
            TypeSize::Title => 20.0,
            TypeSize::Large => 22.0,
        }
    }
}

pub const DISPLAY_LINE_HEIGHT: f32 = 32.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FontWeight {
    Regular,
    Medium,
    Semibold,
    Bold,
}

impl FontWeight {
    pub const fn value(self) -> u16 {
        match self {
            FontWeight::Regular => 400,
            FontWeight::Medium => 500,
            FontWeight::Semibold => 600,
            FontWeight::Bold => 700,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShadowLevel {
    pub opacity_dark: f32,
    pub opacity_light: f32,
    pub radius: f32,
    pub offset: [f32; 2],
}

impl ShadowLevel {
    pub const fn opacity(&self, dark: bool) -> f32 {
        if dark {
            self.opacity_dark
        } else {
            self.opacity_light
        }
    }
}

pub mod shadow {
    use super::{DARK, LIGHT, ShadowLevel};

    const fn panel_share(share: f32, radius: f32, offset: [f32; 2]) -> ShadowLevel {
        ShadowLevel {
            opacity_dark: DARK.panel_shadow_opacity * share,
            opacity_light: LIGHT.panel_shadow_opacity * share,
            radius,
            offset,
        }
    }

    pub const TOOLTIP: ShadowLevel = ShadowLevel {
        opacity_dark: 0.15,
        opacity_light: 0.08,
        radius: 4.0,
        offset: [0.0, 1.0],
    };
    pub const POPOVER: ShadowLevel = ShadowLevel {
        opacity_dark: 0.45,
        opacity_light: 0.16,
        radius: 18.0,
        offset: [0.0, 8.0],
    };
    pub const DIALOG: ShadowLevel = panel_share(1.0, 24.0, [0.0, 10.0]);
    pub const CARD: ShadowLevel = panel_share(0.8, 16.0, [0.0, 6.0]);
    pub const SHEET: ShadowLevel = panel_share(1.0, 20.0, [0.0, 8.0]);
    pub const PEEK: ShadowLevel = panel_share(1.0, 20.0, [0.0, 6.0]);
    pub const COMMAND_BAR_NEAR: ShadowLevel = ShadowLevel {
        opacity_dark: 0.08,
        opacity_light: 0.08,
        radius: 2.0,
        offset: [0.0, 0.5],
    };
    pub const COMMAND_BAR_FAR: ShadowLevel = ShadowLevel {
        opacity_dark: 0.04,
        opacity_light: 0.04,
        radius: 1.0,
        offset: [0.0, 2.0],
    };
}

pub mod hairline {
    pub const PANEL: f32 = 0.5;
    pub const RING: f32 = 0.5;
}

pub mod swatch {
    pub const SIZE: f32 = 20.0;
    pub const INSET: f32 = 2.0;
    pub const RING: f32 = 2.0;
    pub const GAP: f32 = super::space::M;
}

pub const DISABLED_OPACITY: f32 = 0.45;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IconButtonSize {
    pub box_size: f32,
    pub glyph: f32,
}

pub mod icon_button {
    use super::IconButtonSize;
    pub const XS: IconButtonSize = IconButtonSize {
        box_size: 20.0,
        glyph: 9.0,
    };
    pub const S: IconButtonSize = IconButtonSize {
        box_size: 22.0,
        glyph: 10.0,
    };
    pub const M: IconButtonSize = IconButtonSize {
        box_size: 24.0,
        glyph: 11.0,
    };
    pub const L: IconButtonSize = IconButtonSize {
        box_size: 26.0,
        glyph: 12.0,
    };
    pub const TOOLBAR: IconButtonSize = IconButtonSize {
        box_size: 30.0,
        glyph: 15.0,
    };
}

pub mod pill_height {
    pub const PROMPT: f32 = 28.0;
    pub const M: f32 = 24.0;
    pub const L: f32 = 30.0;
    pub const XL: f32 = 36.0;
}

pub mod sheet_width {
    pub const XS: f32 = 320.0;
    pub const S: f32 = 420.0;
    pub const M: f32 = 440.0;
    pub const L: f32 = 480.0;
    pub const XL: f32 = 560.0;
}

pub mod popover_width {
    pub const S: f32 = 300.0;
    pub const M: f32 = 340.0;
    pub const L: f32 = 360.0;
}

pub mod toast_layout {
    pub const BOTTOM: f32 = super::space::XXXL;
    pub const EDGE: f32 = super::space::L;
    pub const MAX_WIDTH: f32 = 420.0;
    pub const TWO_ACTION_MAX_WIDTH: f32 = 600.0;
}

pub mod tooltip {
    pub const PAD_X: f32 = 6.5;
    pub const PAD_Y: f32 = 5.0;
    pub const RADIUS: f32 = super::radius::CONTROL;
}

pub const fn concentric(outer: f32, inset: f32) -> f32 {
    let r = outer - inset;
    if r > 0.0 { r } else { 0.0 }
}

pub const fn capsule(height: f32) -> f32 {
    height / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_and_light_roles_mirror_the_shell_tokens() {
        assert_eq!(DARK.text_tab.to_hex(), "#FFFFFFC7");
        assert_eq!(LIGHT.text_tab.to_hex(), "#000000AD");
        assert_eq!(DARK.card.to_hex(), "#12121280");
        assert_eq!(LIGHT.card.to_u8()[3], 178);
        assert_eq!(DARK.panel.to_hex(), "#2A2A2A");
        assert_eq!(LIGHT.ntp_bar_solid.to_hex(), "#FEFFFF");
        const { assert!(DARK.dark && !LIGHT.dark) };
        assert_eq!(roles(true), &DARK);
        assert_eq!(roles(false), &LIGHT);
    }

    #[test]
    fn profile_colors_round_trip_their_keys() {
        for color in ProfileColor::ALL {
            assert_eq!(ProfileColor::from_key(color.key()), Some(color));
            assert_eq!(color.spec().color, color);
            let json = serde_json::to_string(&color).unwrap();
            assert_eq!(json, format!("\"{}\"", color.key()));
        }
        assert_eq!(ProfileColor::from_key("teal"), None);
    }

    #[test]
    fn plum_carries_the_measured_dia_tint_and_power_up() {
        let plum = ProfileColor::Plum.spec();
        assert_eq!(plum.tint.unwrap().to_hex(), "#B25B6B");
        assert_eq!(plum.power_up_color().to_hex(), "#B5556B");
        assert_eq!(
            ProfileColor::Neutral.spec().power_up_color().to_hex(),
            "#808080A6"
        );
        assert_eq!(
            ProfileColor::Blue.spec().power_up_color().to_hex(),
            "#4691C3"
        );
    }

    #[test]
    fn site_toolbar_picks_ink_by_page_color() {
        assert_eq!(site_toolbar_roles(RgbaColor::WHITE), &SITE_TOOLBAR_ON_LIGHT);
        assert_eq!(
            site_toolbar_roles(RgbaColor::hex(0x0F1113)),
            &SITE_TOOLBAR_ON_DARK
        );
    }

    #[test]
    fn shadows_follow_the_panel_share() {
        assert!((shadow::CARD.opacity(true) - 0.4).abs() < 1e-6);
        assert!((shadow::DIALOG.opacity(false) - 0.18).abs() < 1e-6);
        assert_eq!(concentric(12.0, 6.0), 6.0);
        assert_eq!(concentric(4.0, 6.0), 0.0);
    }
}
