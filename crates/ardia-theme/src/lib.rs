#![forbid(unsafe_code)]

pub mod color;
pub mod grain;
pub mod icon_theme;
pub mod json;
pub mod layout;
pub mod motion;
pub mod profile_theme;
pub mod tokens;

pub use color::{ColorSpace, Hsl, Oklab, RgbaColor};
pub use grain::{GrainTexture, GrainTile};
pub use icon_theme::{
    DockFill, DockGlyph, DockRing, DockSelection, IconPixels, IconTheme, SelectionStyle,
    classify_icon, dock_selection,
};
pub use layout::{FrameRules, PageFrame, PeekFrame, SidebarTextSize};
pub use motion::{CubicBezier, Spring};
pub use profile_theme::{
    Backdrop, BackdropTint, BlurFill, CustomBackdrop, FieldSurface, Glow, INACTIVE_FILL,
    LookSource, NEUTRAL_FILL, ProfileLook, ProfileTheme, SelectedTabGlow, ShownLook, Theme,
    ThemeColor, ThemeFamily, ThemeLook, ThemeMode, ThemeStop, ThemeTexture, VibrancyMaterial,
    WindowTreatment, ink_on, nearest_preset, profile_accent, profile_name_color, visible_line,
    visible_selection,
};
pub use tokens::{
    AreaLightPalette, ColorRoles, DARK, DiaTokens, LIGHT, ProfileColor, ProfileColorSpec,
};

pub const fn theme_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
