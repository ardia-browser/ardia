use ardia_state::BrowserState;
use ardia_state::tabs::Tab;
use ardia_theme::layout::sidebar;
use gpui::{BoxShadow, Hsla, Rgba};

use crate::primitives::controls::shadow;
use crate::primitives::theme_bridge::hsla;
use crate::window::chrome::Chrome;

pub const SLEEPING_ICON_OPACITY: f32 = 0.45;
pub const SLEEPING_TITLE_OPACITY: f32 = 0.6;
pub const CLOSE_BOX: f32 = 22.0;
pub const CLOSE_GLYPH: f32 = 13.0;
pub const SPACE_XXS: f32 = 2.0;
pub const SPACE_XS: f32 = 4.0;
pub const SPACE_S: f32 = 6.0;
pub const SPACE_M: f32 = 8.0;
pub const SPACE_ML: f32 = 10.0;
pub const TILE_STATUS_SPEAKER: f32 = 9.5;
pub const TILE_STATUS_PIP: f32 = 8.0;
pub const TILE_STATUS_BOX: (f32, f32) = (14.0, 12.0);
pub const TILE_STATUS_INSET: (f32, f32) = (5.0, 4.0);
pub const TILE_SELECTION_STROKE: f32 = 3.0;
pub const TILE_RIM: f32 = 1.0;
pub const SELECTED_ROW_SHADOW_Y: f32 = 0.5;

fn rgba(r: u8, g: u8, b: u8, a: f32) -> Hsla {
    Rgba {
        r: f32::from(r) / 255.0,
        g: f32::from(g) / 255.0,
        b: f32::from(b) / 255.0,
        a,
    }
    .into()
}

fn white(a: f32) -> Hsla {
    rgba(255, 255, 255, a)
}

fn black(a: f32) -> Hsla {
    rgba(0, 0, 0, a)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SidebarTokens {
    pub multi_selected: Hsla,
    pub multi_selected_stroke: Hsla,
    pub drag_border: Hsla,
    pub drag_silhouette: Hsla,
    pub drop_mark: Hsla,
    pub edge_glow: Hsla,
    pub folder_drop_fill: Hsla,
    pub split_drop_fill: Hsla,
    pub new_tab_label: Hsla,
    pub new_tab_icon: Hsla,
    pub tile_glow: Hsla,
    pub quiet_wash: Hsla,
    pub quiet_hover: Hsla,
    pub quiet_pressed: Hsla,
    pub quiet_tile: Hsla,
    pub quiet_tile_live: Hsla,
    pub quiet_active_text: f32,
    pub quiet_text: f32,
    pub quiet_faint_text: f32,
}

pub fn sidebar_tokens(dark: bool, high_contrast: bool) -> SidebarTokens {
    let mut tokens = if dark {
        SidebarTokens {
            multi_selected: white(0.1),
            multi_selected_stroke: white(0.14),
            drag_border: white(0.33),
            drag_silhouette: rgba(0x0F, 0x0F, 0x14, 1.0),
            drop_mark: white(0.93),
            edge_glow: white(0.105),
            folder_drop_fill: white(0.08),
            split_drop_fill: white(0.42),
            new_tab_label: white(0x8C as f32 / 255.0),
            new_tab_icon: white(0x40 as f32 / 255.0),
            tile_glow: white(1.0),
            quiet_wash: white(0.073),
            quiet_hover: white(0.045),
            quiet_pressed: white(0.1),
            quiet_tile: white(0.04),
            quiet_tile_live: white(0.112),
            quiet_active_text: 0.92,
            quiet_text: 0.53,
            quiet_faint_text: 0.24,
        }
    } else {
        SidebarTokens {
            multi_selected: black(0.1),
            multi_selected_stroke: black(0.08),
            drag_border: black(0.28),
            drag_silhouette: white(1.0),
            drop_mark: black(0.8),
            edge_glow: black(0.1),
            folder_drop_fill: black(0.05),
            split_drop_fill: black(0.08),
            new_tab_label: black(0x80 as f32 / 255.0),
            new_tab_icon: black(0x42 as f32 / 255.0),
            tile_glow: black(1.0),
            quiet_wash: black(0.063),
            quiet_hover: black(0.035),
            quiet_pressed: black(0.09),
            quiet_tile: black(0.035),
            quiet_tile_live: black(0.1),
            quiet_active_text: 0.9,
            quiet_text: 0.45,
            quiet_faint_text: 0.2,
        }
    };
    if high_contrast {
        if dark {
            tokens.new_tab_label = white(0xD1 as f32 / 255.0);
            tokens.new_tab_icon = white(0xB3 as f32 / 255.0);
        } else {
            tokens.new_tab_label = black(0xD1 as f32 / 255.0);
            tokens.new_tab_icon = black(0xB3 as f32 / 255.0);
        }
    }
    tokens
}

pub fn tokens_of(c: &Chrome) -> SidebarTokens {
    sidebar_tokens(c.p.dark, c.look.theme.high_contrast_text)
}

pub fn quiet(c: &Chrome) -> bool {
    c.state.minimalism_in(c.window.id.as_str())
}

pub const MINIMALISM_CHROME_RADIUS: f32 = 9.0;

thread_local! {
    static CHROME_RADIUS: std::cell::Cell<Option<f32>> = const { std::cell::Cell::new(None) };
}

pub fn chosen_chrome_radius(tab_corners: Option<f64>, minimalism: bool) -> Option<f32> {
    let chosen = tab_corners
        .filter(|v| v.is_finite())
        .map(|v| v.clamp(0.0, ardia_state::settings::TAB_CORNERS_MAX) as f32);
    chosen.or(minimalism.then_some(MINIMALISM_CHROME_RADIUS))
}

pub fn sync_chrome_radius(tab_corners: Option<f64>, minimalism: bool) -> bool {
    let next = chosen_chrome_radius(tab_corners, minimalism);
    CHROME_RADIUS.with(|cell| cell.replace(next) != next)
}

pub fn chrome_radius() -> f32 {
    CHROME_RADIUS
        .with(std::cell::Cell::get)
        .unwrap_or_else(|| sidebar::row_radius(sidebar::ROW_HEIGHT))
}

pub fn concentric(outer: f32, inset: f32) -> f32 {
    (outer - inset).max(0.0)
}

pub fn close_radius() -> f32 {
    concentric(chrome_radius(), (sidebar::row_height() - CLOSE_BOX) / 2.0)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RowMarks {
    pub faded: bool,
    pub sleeping: bool,
    pub struck: bool,
}

impl RowMarks {
    pub fn icon_dimmed(self) -> bool {
        self.faded
    }
}

pub fn closed_top_app(state: &BrowserState, tab: &Tab) -> bool {
    !state.settings.closed_top_app_tiles
        && tab.pin.as_ref().is_some_and(|pin| pin.is_tile())
        && ardia_state::pin_share::is_page_unloaded(state, &tab.id)
}

pub fn row_marks(state: &BrowserState, tab: &Tab) -> RowMarks {
    let unloaded = ardia_state::pin_share::is_page_unloaded(state, &tab.id);
    let faded = (state.settings.fade_unloaded_tabs && unloaded) || closed_top_app(state, tab);
    let sleeping = tab.page.is_asleep();
    let struck = state.settings.strike_sleeping_tabs && (sleeping || faded);
    RowMarks {
        faded,
        sleeping,
        struck,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RowFill {
    pub rest: Option<Hsla>,
    pub hover: Option<Hsla>,
    pub pressed: Option<Hsla>,
    pub border: Option<Hairline>,
    pub glow: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hairline {
    pub top: Hsla,
    pub bottom: Hsla,
    pub width: f32,
}

impl Hairline {
    pub const fn even(color: Hsla, width: f32) -> Self {
        Hairline {
            top: color,
            bottom: color,
            width,
        }
    }
}

pub fn row_fill(c: &Chrome, active: bool, selected: bool) -> RowFill {
    let p = c.p;
    let tokens = tokens_of(c);
    let quiet = quiet(c);
    let hover = if quiet {
        tokens.quiet_hover
    } else {
        p.tab_hover
    };
    let pressed = if quiet {
        tokens.quiet_pressed
    } else {
        p.tab_pressed
    };
    if active {
        return RowFill {
            rest: Some(if quiet {
                tokens.quiet_wash
            } else {
                p.tab_selected
            }),
            hover: None,
            pressed: None,
            border: (!quiet).then_some(Hairline {
                top: p.tab_selected_border,
                bottom: p.tab_selected_border_bottom,
                width: sidebar::ROW_SELECTED_HAIRLINE,
            }),
            glow: !quiet,
        };
    }
    if selected {
        return RowFill {
            rest: Some(tokens.multi_selected),
            hover: None,
            pressed: Some(pressed),
            border: Some(Hairline::even(
                tokens.multi_selected_stroke,
                sidebar::ROW_SELECTED_HAIRLINE,
            )),
            glow: false,
        };
    }
    RowFill {
        rest: None,
        hover: Some(hover),
        pressed: Some(pressed),
        border: None,
        glow: false,
    }
}

pub fn selected_glow(c: &Chrome) -> Vec<BoxShadow> {
    if quiet(c) {
        return Vec::new();
    }
    glow_shadows(
        c.look
            .theme
            .selected_tab_glow(c.state.settings.selected_tab_glow.glow()),
    )
}

pub fn glow_shadows(glow: ardia_theme::profile_theme::Glow) -> Vec<BoxShadow> {
    if glow.opacity.is_nan() || glow.opacity <= 0.0 || glow.radius.is_nan() || glow.radius < 0.0 {
        return Vec::new();
    }
    let color = hsla(glow.color);
    vec![shadow(
        color.opacity(glow.opacity),
        SELECTED_ROW_SHADOW_Y,
        glow.radius,
    )]
}

pub fn title_color(c: &Chrome, active: bool) -> Hsla {
    if quiet(c) {
        let tokens = tokens_of(c);
        let alpha = if active {
            tokens.quiet_active_text
        } else {
            tokens.quiet_text
        };
        c.p.text_tab.alpha(alpha)
    } else if active {
        c.p.text_selected
    } else {
        c.p.text_tab
    }
}

pub fn title_size(c: &Chrome) -> f32 {
    c.points(if quiet(c) { 12.0 } else { 13.0 })
}

pub fn icon_size(c: &Chrome) -> f32 {
    c.look
        .icon_points(if quiet(c) { 14.0 } else { sidebar::ROW_FAVICON })
}

pub fn plain_tooltip(tab: &Tab) -> String {
    let title = tab.display_title();
    let host = ardia_state::omnibox::url::breadcrumb_host(&tab.url);
    if host.is_empty() {
        title
    } else {
        format!("{title}\n{host}")
    }
}

thread_local! {
    static HOVERED: std::cell::RefCell<std::collections::HashMap<String, String>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

pub fn set_hovered(window_key: &str, item: &str, hovered: bool, window: &mut gpui::Window) {
    let changed = HOVERED.with(|cell| {
        let mut map = cell.borrow_mut();
        if hovered {
            map.insert(window_key.to_owned(), item.to_owned())
                .as_deref()
                != Some(item)
        } else if map.get(window_key).map(String::as_str) == Some(item) {
            map.remove(window_key);
            true
        } else {
            false
        }
    });
    if changed {
        window.refresh();
    }
}

thread_local! {
    static FADES: std::cell::RefCell<std::collections::HashMap<(String, String), crate::primitives::tokens::Tween>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

pub fn hover_fade(window_key: &str, item: &str) -> (f32, bool) {
    let shown = is_hovered(window_key, item);
    let now = std::time::Instant::now();
    FADES.with(|cell| {
        let mut fades = cell.borrow_mut();
        let key = (window_key.to_owned(), item.to_owned());
        let tween = fades
            .entry(key.clone())
            .or_insert_with(|| crate::primitives::tokens::Tween::at(0.0));
        let target = if shown { 1.0 } else { 0.0 };
        if (tween.to - target).abs() > f32::EPSILON {
            crate::primitives::controls::hover_fill_tween(tween, shown, false, now);
        }
        let value = tween.value(now);
        let running = tween.running(now);
        if !shown && !running {
            fades.remove(&key);
        }
        (value, running)
    })
}

pub fn mix(rest: Option<Hsla>, hover: Hsla, level: f32) -> Hsla {
    let from: Rgba = rest.unwrap_or(hover.opacity(0.0)).into();
    let to: Rgba = hover.into();
    let t = level.clamp(0.0, 1.0);
    let lerp = |a: f32, b: f32| a + (b - a) * t;
    Rgba {
        r: lerp(from.r, to.r),
        g: lerp(from.g, to.g),
        b: lerp(from.b, to.b),
        a: lerp(from.a, to.a),
    }
    .into()
}

pub fn drop_hover_fade(window_key: &str, item: &str) {
    FADES.with(|cell| {
        cell.borrow_mut()
            .remove(&(window_key.to_owned(), item.to_owned()))
    });
}

pub fn is_hovered(window_key: &str, item: &str) -> bool {
    HOVERED.with(|cell| cell.borrow().get(window_key).map(String::as_str) == Some(item))
}

pub const ENGINE_MARK_MIN_ICON: f32 = 14.0;

pub fn engine_mark_plate(dark: bool) -> Hsla {
    if dark {
        gpui::rgb(0x2C2C2E).into()
    } else {
        gpui::rgb(0xFFFFFF).into()
    }
}

pub fn engine_mark_box(size: f32) -> f32 {
    (size * 0.6).round()
}

pub fn marked_engine(c: &Chrome, tab: &Tab, size: f32) -> Option<ardia_state::model::PageEngine> {
    (size >= ENGINE_MARK_MIN_ICON && c.host.offers_engine_choice())
        .then(|| ardia_state::engines::engine_mark(c.state, tab.id.as_str()))
        .flatten()
}

pub fn engine_mark(
    c: &Chrome,
    engine: ardia_state::model::PageEngine,
    size: f32,
) -> gpui::AnyElement {
    use gpui::{InteractiveElement, IntoElement, ParentElement, Styled, div, px};
    let side = engine_mark_box(size);
    let name = ardia_state::engines::engine_symbol(engine);
    let key = format!("engine-mark:{name}");
    div()
        .absolute()
        .right(px(-side / 3.0))
        .bottom(px(-side / 3.0))
        .size(px(side))
        .rounded(px(side / 2.0))
        .flex()
        .items_center()
        .justify_center()
        .bg(engine_mark_plate(c.p.dark))
        .debug_selector(move || key)
        .child(
            crate::primitives::icons::symbol_icon(
                name,
                crate::primitives::icons::Icon::Globe,
                (side - 3.0).max(1.0),
                c.p.icon,
            )
            .weight(crate::icon_picker::symbols::SymbolWeight::Semibold)
            .centres_ink(),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_glow_setting_lights_the_selected_row_like_the_old_surface_shadow() {
        use ardia_theme::SelectedTabGlow;
        let plum = ardia_theme::profile_theme::ThemeFamily::Preset(
            ardia_theme::tokens::ProfileColor::Plum,
        );
        let dark = ardia_theme::Theme::preset(plum, true);
        let light = ardia_theme::Theme::preset(plum, false);
        let full = glow_shadows(dark.selected_tab_glow(SelectedTabGlow::Full));
        assert_eq!(full.len(), 1);
        assert!((full[0].color.a - 0.15).abs() < 1e-4);
        assert_eq!(f32::from(full[0].blur_radius), 15.0);
        assert_eq!(f32::from(full[0].offset.y), SELECTED_ROW_SHADOW_Y);
        let soft = glow_shadows(dark.selected_tab_glow(SelectedTabGlow::Soft));
        assert!((soft[0].color.a - 0.15 * 0.45).abs() < 1e-4);
        assert_eq!(f32::from(soft[0].blur_radius), 9.0);
        assert!(glow_shadows(dark.selected_tab_glow(SelectedTabGlow::Off)).is_empty());
        let light_full = glow_shadows(light.selected_tab_glow(SelectedTabGlow::Full));
        assert!((light_full[0].color.a - 0.12).abs() < 1e-4);
        assert!(light_full[0].color.l < 0.01);
        assert_eq!(f32::from(light_full[0].blur_radius), 12.5);
    }

    #[test]
    fn the_tab_corner_setting_and_minimalism_choose_the_row_radius() {
        assert_eq!(chosen_chrome_radius(None, false), None);
        assert_eq!(
            chosen_chrome_radius(None, true),
            Some(MINIMALISM_CHROME_RADIUS)
        );
        assert_eq!(chosen_chrome_radius(Some(4.0), true), Some(4.0));
        assert_eq!(chosen_chrome_radius(Some(0.0), false), Some(0.0));
        assert_eq!(chosen_chrome_radius(Some(99.0), false), Some(20.0));
        assert_eq!(chosen_chrome_radius(Some(f64::NAN), false), None);
        assert!(sync_chrome_radius(Some(6.0), false));
        assert_eq!(chrome_radius(), 6.0);
        assert!(!sync_chrome_radius(Some(6.0), false));
        assert!(sync_chrome_radius(None, false));
        assert_eq!(chrome_radius(), 10.0);
    }

    #[test]
    fn the_close_button_is_concentric_with_the_row() {
        assert_eq!(chrome_radius(), 10.0);
        assert_eq!(close_radius(), 4.0);
    }

    #[test]
    fn high_contrast_strengthens_the_new_tab_row_only() {
        let base = sidebar_tokens(true, false);
        let strong = sidebar_tokens(true, true);
        assert!(strong.new_tab_label.a > base.new_tab_label.a);
        assert!(strong.new_tab_icon.a > base.new_tab_icon.a);
        assert_eq!(strong.multi_selected, base.multi_selected);
    }

    #[test]
    fn multi_selection_uses_its_own_wash_in_both_appearances() {
        assert!((sidebar_tokens(true, false).multi_selected.a - 0.1).abs() < 1e-4);
        assert!((sidebar_tokens(false, false).multi_selected_stroke.a - 0.08).abs() < 1e-4);
    }
}
