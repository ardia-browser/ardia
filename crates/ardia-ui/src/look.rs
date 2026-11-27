use std::sync::Arc;

use ardia_state::BrowserState;
use ardia_state::profiles::Profile;
use ardia_state::settings::{Appearance, Settings};
use ardia_theme::tokens::{self, DiaTokens};
use ardia_theme::{
    ColorRoles, FieldSurface, RgbaColor, SidebarTextSize, Theme, WindowTreatment,
    profile_name_color,
};
use gpui::{BackdropLayerSpec, Hsla, WindowAppearance};

use crate::primitives::glass::{GlassLook, panel_glass_tint};
use crate::primitives::theme_bridge::{backdrop_spec, backdrop_spec_sized, hsla};

pub const UI_FONT: &str = ".SystemUIFont";

thread_local! {
    static LIQUID_GLASS_AVAILABLE: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
}

pub fn note_liquid_glass_available(available: bool) {
    LIQUID_GLASS_AVAILABLE.with(|cell| cell.set(available));
}

pub fn note_window_glass(window: &gpui::Window) {
    note_liquid_glass_available(window.liquid_glass_available());
}

pub fn liquid_glass_available() -> bool {
    LIQUID_GLASS_AVAILABLE.with(std::cell::Cell::get)
}

pub fn glass_shown(settings: &Settings, available: bool) -> bool {
    available && settings.liquid_glass_enabled()
}
pub const POPOVER_SHADOW_DARK: f32 = 0.45;
pub const POPOVER_SHADOW_LIGHT: f32 = 0.16;
pub const CARD_SHADOW_SHARE: f32 = 0.8;
pub const TOOLTIP_SHADOW_DARK: f32 = 0.15;
pub const TOOLTIP_SHADOW_LIGHT: f32 = 0.08;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub text: Hsla,
    pub text_tab: Hsla,
    pub text_selected: Hsla,
    pub text_secondary: Hsla,
    pub text_tertiary: Hsla,
    pub placeholder: Hsla,
    pub icon: Hsla,
    pub icon_disabled: Hsla,
    pub tab_hover: Hsla,
    pub tab_pressed: Hsla,
    pub tab_selected: Hsla,
    pub tab_selected_border: Hsla,
    pub tab_selected_border_bottom: Hsla,
    pub tab_secondary: Hsla,
    pub pinned_resting: Hsla,
    pub pinned_resting_stroke: Hsla,
    pub pinned_selected_fill: Hsla,
    pub pinned_selected_rim: Hsla,
    pub pinned_selected_outline: Hsla,
    pub toolbar_hover: Hsla,
    pub toolbar_pressed: Hsla,
    pub url_pill: Hsla,
    pub card: Hsla,
    pub card_edge: Hsla,
    pub divider: Hsla,
    pub hairline: Hsla,
    pub popover_fill: Hsla,
    pub popover_border: Hsla,
    pub popover_row_pressed: Hsla,
    pub menu_hover: Hsla,
    pub row_hover: Hsla,
    pub row_selected: Hsla,
    pub command_panel: Hsla,
    pub command_border: Hsla,
    pub command_selected: Hsla,
    pub command_hover: Hsla,
    pub command_text: Hsla,
    pub command_secondary: Hsla,
    pub command_placeholder: Hsla,
    pub selection: Hsla,
    pub caret: Hsla,
    pub chip_border: Hsla,
    pub chip_text: Hsla,
    pub chip_fill: Hsla,
    pub favicon_tile: Hsla,
    pub dark: bool,
    pub go: Hsla,
    pub go_hover: Hsla,
    pub go_pressed: Hsla,
    pub on_go: Hsla,
    pub toggle_off: Hsla,
    pub ring_radio_fill: Hsla,
    pub ring_radio_border: Hsla,
    pub ring_radio_on: Hsla,
    pub group_fill: Hsla,
    pub group_border: Hsla,
    pub panel: Hsla,
    pub panel_border: Hsla,
    pub card_shadow: Hsla,
    pub form_accent_pressed: Hsla,
    pub hud_close_fill: Hsla,
    pub hud_close_hover: Hsla,
    pub hud_close_border: Hsla,
    pub hud_close_glyph: Hsla,
    pub accent: Hsla,
    pub form_accent: Hsla,
    pub on_accent: Hsla,
    pub field: Hsla,
    pub field_border: Hsla,
    pub control: Hsla,
    pub control_hover: Hsla,
    pub control_pressed: Hsla,
    pub control_border: Hsla,
    pub switch_off: Hsla,
    pub knob: Hsla,
    pub knob_border: Hsla,
    pub destructive: Hsla,
    pub warning: Hsla,
    pub success: Hsla,
    pub toast_fill: Hsla,
    pub badge_fill: Hsla,
    pub progress_track: Hsla,
    pub scrim: Hsla,
    pub group_box: Hsla,
    pub group_stroke: Hsla,
    pub secondary_label: Hsla,
    pub tertiary_label: Hsla,
    pub downloads_tint: Hsla,
    pub prompt_fill: Hsla,
    pub prompt_fill_hover: Hsla,
    pub prompt_fill_pressed: Hsla,
    pub tooltip_fill: Hsla,
    pub tooltip_text: Hsla,
    pub tooltip_ring: Hsla,
    pub ntp_bar: Hsla,
    pub ntp_bar_border: Hsla,
    pub mark: Hsla,
    pub shadow: Hsla,
    pub profile_name: Hsla,
    pub popover_shadow: Hsla,
    pub tooltip_shadow: Hsla,
    pub glass_panel_tint: Hsla,
}

impl Palette {
    pub fn new(theme: &Theme, treatment: &WindowTreatment, profile_name: RgbaColor) -> Self {
        let roles: &ColorRoles = &theme.roles;
        let dia: &DiaTokens = tokens::dia(roles.dark);
        let c = hsla;
        Palette {
            text: c(roles.text_primary),
            text_tab: c(roles.text_tab),
            text_selected: c(theme.row_selected_text),
            text_secondary: c(roles.text_secondary),
            text_tertiary: c(roles.text_tertiary),
            placeholder: c(roles.placeholder),
            icon: c(roles.icon),
            icon_disabled: c(roles.icon_disabled),
            tab_hover: c(roles.tab_hover),
            tab_pressed: c(roles.tab_pressed),
            tab_selected: c(roles.tab_selected),
            tab_selected_border: c(roles.tab_selected_border[0]),
            tab_selected_border_bottom: c(roles.tab_selected_border[1]),
            tab_secondary: c(dia.tab_background_selected_secondary),
            pinned_resting: c(roles.pinned_resting),
            pinned_resting_stroke: c(roles.pinned_resting_stroke),
            pinned_selected_fill: c(roles.pinned_selected_fill),
            pinned_selected_rim: c(roles.pinned_selected_rim),
            pinned_selected_outline: c(roles.pinned_selected_outline),
            toolbar_hover: c(roles.toolbar_hover),
            toolbar_pressed: c(roles.toolbar_pressed),
            url_pill: c(roles.url_pill),
            card: c(treatment.content_fill),
            card_edge: c(roles.card_edge),
            divider: c(theme.pinned_divider),
            hairline: c(dia.primary_1200),
            popover_fill: c(roles.popover_fill),
            popover_border: c(roles.popover_border),
            popover_row_pressed: c(roles.popover_row_pressed),
            menu_hover: c(dia.menu_item_background_hovered),
            row_hover: c(roles.row_hover),
            row_selected: c(roles.row_selected),
            command_panel: c(dia.command_bar_panel_background),
            command_border: c(dia.command_bar_border),
            command_selected: c(roles.command_bar_selected),
            command_hover: c(roles.command_bar_hover),
            command_text: c(dia.command_bar_primary_text),
            command_secondary: c(dia.command_bar_secondary_text),
            command_placeholder: c(dia.command_bar_placeholder),
            selection: c(roles.selection),
            caret: c(theme.caret_color(FieldSurface::PopoverField)),
            chip_border: c(roles.chip_border),
            chip_text: c(roles.chip_text),
            chip_fill: c(roles.chip_fill),
            favicon_tile: c(roles.favicon_tile),
            dark: roles.dark,
            go: c(roles.go_button),
            go_hover: c(roles.go_button_hover),
            go_pressed: c(roles.go_button_pressed),
            on_go: c(roles.on_primary),
            toggle_off: c(roles.toggle_off),
            ring_radio_fill: c(roles.ring_radio_fill),
            ring_radio_border: c(roles.ring_radio_border),
            ring_radio_on: c(roles.ring_radio_on),
            group_fill: c(roles.group_fill),
            group_border: c(roles.group_border),
            panel: c(roles.panel),
            panel_border: c(roles.panel_border),
            card_shadow: c(RgbaColor::black(
                roles.panel_shadow_opacity * CARD_SHADOW_SHARE,
            )),
            form_accent_pressed: c(roles.form_accent_pressed),
            hud_close_fill: c(roles.hud_close_fill),
            hud_close_hover: c(roles.hud_close_hover),
            hud_close_border: c(roles.hud_close_border),
            hud_close_glyph: c(roles.hud_close_glyph),
            accent: c(roles.accent),
            form_accent: c(roles.form_accent),
            on_accent: c(roles.on_accent),
            field: c(roles.field),
            field_border: c(roles.field_border),
            control: c(roles.control),
            control_hover: c(roles.control_hover),
            control_pressed: c(roles.control_pressed),
            control_border: c(roles.control_border),
            switch_off: c(roles.switch_off),
            knob: c(RgbaColor::WHITE),
            knob_border: c(roles.knob_border),
            destructive: c(roles.destructive),
            warning: c(roles.warning),
            success: c(roles.success),
            toast_fill: c(roles.toast_fill),
            badge_fill: c(roles.badge_fill),
            progress_track: c(roles.progress_track),
            scrim: c(roles.scrim),
            group_box: c(dia.tab_group_neutral_background),
            group_stroke: c(dia.tab_group_sidebar_stroke),
            secondary_label: c(dia.secondary_label),
            tertiary_label: c(dia.tertiary_label),
            downloads_tint: c(dia.downloads_button_tint),
            prompt_fill: c(roles.prompt_fill),
            prompt_fill_hover: c(roles.prompt_fill_hover),
            prompt_fill_pressed: c(roles.prompt_fill_pressed),
            tooltip_fill: c(roles.tooltip_fill),
            tooltip_text: c(roles.tooltip_text),
            tooltip_ring: c(roles.tooltip_ring),
            ntp_bar: c(roles.ntp_bar_solid),
            ntp_bar_border: c(roles.ntp_bar_border),
            mark: c(roles.mark),
            shadow: c(RgbaColor::black(if roles.dark { 0.35 } else { 0.12 })),
            profile_name: c(profile_name),
            popover_shadow: c(RgbaColor::black(if roles.dark {
                POPOVER_SHADOW_DARK
            } else {
                POPOVER_SHADOW_LIGHT
            })),
            glass_panel_tint: c(panel_glass_tint(theme, roles.panel, 0.0)),
            tooltip_shadow: c(RgbaColor::black(if roles.dark {
                TOOLTIP_SHADOW_DARK
            } else {
                TOOLTIP_SHADOW_LIGHT
            })),
        }
    }
}

#[derive(Clone, Debug)]
struct LookKey {
    profile: Option<Arc<Profile>>,
    settings: Arc<Settings>,
    incognito: bool,
    system_dark: bool,
}

impl LookKey {
    fn of(state: &BrowserState, window: &str, appearance: WindowAppearance) -> Self {
        LookKey {
            profile: shown_profile(state, window),
            settings: Arc::clone(&state.settings),
            incognito: state
                .window(window)
                .is_some_and(|w| w.profile_id.is_incognito()),
            system_dark: system_dark(appearance),
        }
    }

    fn same(&self, other: &LookKey) -> bool {
        let profiles = match (&self.profile, &other.profile) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        };
        profiles
            && Arc::ptr_eq(&self.settings, &other.settings)
            && self.incognito == other.incognito
            && self.system_dark == other.system_dark
    }
}

#[derive(Clone, Debug)]
pub struct Look {
    key: LookKey,
    pub theme: Theme,
    pub treatment: WindowTreatment,
    pub p: Palette,
    pub dark: bool,
    pub glass: bool,
    pub glass_tint: f32,
    pub text_size: SidebarTextSize,
    pub high_contrast: bool,
}

pub fn app_appearance(setting: Appearance) -> Option<WindowAppearance> {
    match setting {
        Appearance::Auto => None,
        Appearance::Light => Some(WindowAppearance::Light),
        Appearance::Dark => Some(WindowAppearance::Dark),
    }
}

pub fn system_dark(appearance: WindowAppearance) -> bool {
    matches!(
        appearance,
        WindowAppearance::Dark | WindowAppearance::VibrantDark
    )
}

fn shown_profile(state: &BrowserState, window: &str) -> Option<Arc<Profile>> {
    let id = state.window(window).map_or_else(
        || state.last_active_profile(),
        |w| {
            if w.profile_id.is_incognito() {
                w.profile_id.incognito_original()
            } else {
                w.profile_id.clone()
            }
        },
    );
    state.profile(id.as_str()).cloned()
}

impl Look {
    pub fn new(state: &BrowserState, window: &str, appearance: WindowAppearance) -> Self {
        let key = LookKey::of(state, window, appearance);
        let theme = state.theme(window, key.system_dark, false);
        let treatment = theme.treatment();
        let dark = theme.dark();
        let name = key.profile.as_ref().map_or(RgbaColor::WHITE, |profile| {
            if key.incognito {
                theme.roles.text_primary
            } else {
                profile_name_color(profile.look(), dark)
            }
        });
        let mut p = Palette::new(&theme, &treatment, name);
        if !state.settings.element_outlines {
            p.pinned_resting_stroke = gpui::transparent_black();
        }
        let glass_tint = GlassLook::of(&state.settings).tint;
        p.glass_panel_tint = hsla(panel_glass_tint(&theme, theme.roles.panel, glass_tint));
        Look {
            glass_tint,
            key,
            high_contrast: theme.high_contrast_text,
            theme,
            treatment,
            p,
            dark,
            glass: glass_shown(&state.settings, liquid_glass_available()),
            text_size: state.settings.sidebar_text_size,
        }
    }

    pub fn is_current(
        &self,
        state: &BrowserState,
        window: &str,
        appearance: WindowAppearance,
    ) -> bool {
        self.key.same(&LookKey::of(state, window, appearance))
    }

    pub fn refresh(
        &mut self,
        state: &BrowserState,
        window: &str,
        appearance: WindowAppearance,
    ) -> bool {
        if self.is_current(state, window, appearance) {
            return false;
        }
        *self = Look::new(state, window, appearance);
        true
    }

    pub fn backdrop(&self, active: bool) -> BackdropLayerSpec {
        backdrop_spec(&self.treatment, active)
    }

    pub fn backdrop_gradients(&self, size: [f32; 2]) -> gpui::BackdropGradients {
        crate::primitives::theme_bridge::backdrop_gradients(&self.treatment, size)
    }

    pub fn backdrop_in(&self, active: bool, size: [f32; 2], focus: [f32; 2]) -> BackdropLayerSpec {
        backdrop_spec_sized(&self.treatment, active, size, focus)
    }

    pub fn points(&self, value: f32) -> f32 {
        self.text_size.points(value)
    }

    pub fn icon_points(&self, value: f32) -> f32 {
        self.text_size.icon_points(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::persistence::session::{LoadOptions, SessionData};

    fn state() -> BrowserState {
        BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 0)
    }

    #[test]
    fn the_look_follows_the_window_appearance_and_caches_by_identity() {
        let state = state();
        let dark = Look::new(&state, "missing", WindowAppearance::Dark);
        assert!(dark.dark);
        assert!(dark.is_current(&state, "missing", WindowAppearance::VibrantDark));
        assert!(!dark.is_current(&state, "missing", WindowAppearance::Light));
        let light = Look::new(&state, "missing", WindowAppearance::Light);
        assert!(!light.dark);
        assert_ne!(dark.p.text, light.p.text);
        assert!(dark.glass);
    }

    #[test]
    fn glass_falls_back_to_classic_where_liquid_glass_is_unavailable() {
        let mut settings = Settings::default();
        settings.interface_style = ardia_state::settings::InterfaceStyle::Glass;
        assert!(glass_shown(&settings, true));
        assert!(!glass_shown(&settings, false));
        settings.interface_style = ardia_state::settings::InterfaceStyle::Classic;
        assert!(!glass_shown(&settings, true));
        let state = state();
        note_liquid_glass_available(false);
        let classic = Look::new(&state, "missing", WindowAppearance::Dark);
        assert!(!classic.glass);
        assert!(!crate::primitives::glass::GlassLook::of(&state.settings).controls);
        note_liquid_glass_available(true);
        assert!(Look::new(&state, "missing", WindowAppearance::Dark).glass);
    }

    #[test]
    fn the_appearance_setting_forces_the_app_appearance_pages_follow() {
        assert_eq!(app_appearance(Appearance::Auto), None);
        assert_eq!(
            app_appearance(Appearance::Light),
            Some(WindowAppearance::Light)
        );
        assert_eq!(
            app_appearance(Appearance::Dark),
            Some(WindowAppearance::Dark)
        );
    }

    #[test]
    fn the_card_is_the_window_content_fill() {
        let state = state();
        let look = Look::new(&state, "missing", WindowAppearance::Dark);
        assert_eq!(look.p.card, hsla(look.treatment.content_fill));
        assert!((look.p.card.a - 0.5).abs() < 0.01);
    }
}
