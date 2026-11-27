#![expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "every onboarding scene takes its Tracker and Shape by reference; changing all scene signatures is its own change"
)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::settings::Settings;
use ardia_theme::layout::{CARD_INSET, DEFAULT_WINDOW_CORNER_RADIUS};
use ardia_theme::tokens::{radius, site_toolbar_roles, space};
use ardia_theme::{
    BackdropTint, ColorRoles, NEUTRAL_FILL, ProfileColor, ProfileTheme, RgbaColor, Theme,
    ThemeFamily, nearest_preset, profile_theme::tint_for_hue,
};
use gpui::{
    AnyElement, Div, FontWeight, Hsla, IntoElement, ParentElement, SharedString, Styled, div,
    prelude::*,
};

use crate::host::UiHost;
use crate::icon_picker::symbols::{SymbolWeight, symbol};
use crate::look::UI_FONT;
use crate::primitives::controls::shadow;
use crate::primitives::theme_bridge::hsla;
use crate::scale::px;
use crate::window::motion::{Curve, Motion};

pub const DESIGN_W: f32 = 860.0;
pub const DESIGN_H: f32 = 600.0;
pub const SIDEBAR_W: f32 = 190.0;
pub const ROW_X: f32 = 6.0;
pub const ROW_W: f32 = 178.0;
pub const ROW_H: f32 = 34.0;
pub const ROW_PITCH: f32 = 37.0;
pub const ROW_TOP: f32 = 62.0;
pub const ROW_TOP_WITH_FIELD: f32 = 94.0;
pub const FIELD: Rect = Rect::new(6.0, 46.0, 178.0, 34.0);
pub const TOOLBAR_H: f32 = 41.0;
pub const CRUMB_X: f32 = 153.0;
pub const CRUMB_TRAILING: f32 = 20.0;
pub const FIELD_CRUMB: Rect = Rect::new(12.0, 8.0, FIELD.w - 24.0, 18.0);
pub const STRIP_H: f32 = 42.0;
pub const CHIP_X: f32 = 76.0;
pub const CHIP_W: f32 = 173.0;
pub const CHIP_GAP: f32 = space::XS;
pub const CHIP_TOP: f32 = 5.0;
pub const CHIP_STEP: f32 = CHIP_W + CHIP_GAP;
pub const LIGHTS_TOOLBAR: f32 = CARD_INSET + 21.0;
pub const LIGHTS_FIELD: f32 = 24.0;
pub const LIGHTS_STRIP: f32 = 20.75;
pub const TOOLBAR_ICONS: [f32; 4] = [21.0, 56.0, 92.0, 127.0];
pub const SIDEBAR_ICONS: [f32; 3] = [98.0, 133.0, 168.0];
pub const INSET_X: f32 = 8.0;
pub const INSET_TOP: f32 = 5.0;
pub const INSET_BOTTOM: f32 = 13.0;
pub const TAB_CONTENT_LEFT: f32 = 9.0;
pub const TAB_TRAILING: f32 = 6.0;
pub const TAB_TITLE_GAP: f32 = 5.0;
pub const SUGGESTION_H: f32 = 36.0;
pub const SUGGESTION_LIST_X: f32 = 8.0;
pub const SUGGESTION_PAD_X: f32 = 13.0;
pub const SUGGESTION_GAP: f32 = 11.0;
pub const SUGGESTION_ICON: f32 = 13.0;
pub const SUGGESTION_ICON_BOX: f32 = 16.0;
pub const PANEL_H: f32 = 52.0 + 3.0 * SUGGESTION_H + 14.0;
pub const PILL_H: f32 = 32.0;
pub const MOVE: Duration = Duration::from_millis(400);
pub const FADE: Duration = Duration::from_millis(400);
pub const FOCUS: Duration = Duration::from_millis(250);
pub const MINI_SIDE: f32 = 150.0;

const BODY: f32 = 13.0;
const CAPTION: f32 = 11.0;
const SMALL: f32 = 12.0;
const TITLE: f32 = 15.0;
const LARGE: f32 = 17.0;
const TINY: f32 = 10.0;
const DISPLAY_TITLE: f32 = 22.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub const fn new(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geo {
    pub s: f32,
    pub w: f32,
    pub h: f32,
}

impl Geo {
    pub fn of(width: f32, height: f32) -> Geo {
        let s = (width / DESIGN_W).min(height / DESIGN_H).max(0.0001);
        Geo {
            s,
            w: width / s,
            h: height / s,
        }
    }

    fn scaled(self, k: f32) -> Geo {
        Geo {
            s: self.s * k,
            ..self
        }
    }
}

pub fn row_y(i: usize, top: f32) -> f32 {
    top + i as f32 * ROW_PITCH
}

pub fn chip_x(i: usize) -> f32 {
    CHIP_X + i as f32 * CHIP_STEP
}

pub fn rest_row_count(g: Geo) -> usize {
    (((g.h - ROW_TOP_WITH_FIELD - ROW_PITCH - 20.0) / ROW_PITCH).floor()).clamp(1.0, 6.0) as usize
}

pub fn rest_chip_count(g: Geo) -> usize {
    (((g.w - CHIP_X - 40.0) / CHIP_STEP).floor()).clamp(1.0, 4.0) as usize
}

pub fn rest_card(g: Geo, top: bool, frame: f32) -> Rect {
    if top {
        return Rect::new(frame, STRIP_H, g.w - 2.0 * frame, g.h - STRIP_H - frame);
    }
    let x = SIDEBAR_W + (frame - ROW_X).max(0.0);
    Rect::new(x, frame, g.w - x - frame, g.h - 2.0 * frame)
}

pub fn card_radius(frame: f32) -> f32 {
    if frame <= 0.0 {
        0.0
    } else {
        (DEFAULT_WINDOW_CORNER_RADIUS - frame).max(2.0)
    }
}

fn at(g: Geo, x: f32, y: f32, w: f32, h: f32) -> Div {
    div()
        .absolute()
        .left(px(x * g.s))
        .top(px(y * g.s))
        .w(px(w * g.s))
        .h(px(h * g.s))
}

fn fill() -> Div {
    div().absolute().inset_0()
}

fn c(color: RgbaColor) -> Hsla {
    hsla(color)
}

#[derive(Clone, Copy, Debug)]
pub struct Tab {
    pub title: &'static str,
    pub host: &'static str,
    pub color: u32,
    pub icon: &'static str,
}

pub const TABS: [Tab; 7] = [
    Tab {
        title: "Field Notes",
        host: "fieldnotes.blog",
        color: 0x4E8A5B,
        icon: "leaf.fill",
    },
    Tab {
        title: "Inbox",
        host: "mail.fastmail.com",
        color: 0x3A7BEA,
        icon: "envelope.fill",
    },
    Tab {
        title: "Weekend in Lisbon",
        host: "maps.apple.com",
        color: 0xE8664A,
        icon: "map.fill",
    },
    Tab {
        title: "Q4 roadmap",
        host: "docs.new",
        color: 0x7C6BD6,
        icon: "doc.text.fill",
    },
    Tab {
        title: "Focus mix",
        host: "music.apple.com",
        color: 0xE0457B,
        icon: "music.note",
    },
    Tab {
        title: "Sourdough, day 2",
        host: "cooking.nytimes.com",
        color: 0xE3A21A,
        icon: "fork.knife",
    },
    Tab {
        title: "Pull requests",
        host: "github.com",
        color: 0x24292F,
        icon: "arrow.triangle.pull",
    },
];
pub const NEW_TAB: Tab = Tab {
    title: "New Tab",
    host: "",
    color: 0x8E8E93,
    icon: "plus",
};
pub const BLANK: Tab = Tab {
    title: "New Tab",
    host: "",
    color: 0xA1A1A6,
    icon: "globe",
};

pub fn tab(i: usize) -> Tab {
    TABS[i % TABS.len()]
}

#[derive(Clone, Copy, Debug)]
pub struct Hero {
    pub sky: [u32; 2],
    pub sun: [u32; 2],
    pub far: [u32; 2],
    pub near: [u32; 2],
    pub sea: [u32; 2],
}

#[derive(Clone, Copy, Debug)]
pub struct Article {
    pub site: &'static str,
    pub band: [u32; 2],
    pub title: &'static str,
    pub byline: &'static str,
    pub body: &'static str,
    pub hero: Hero,
}

pub const NOTES: Article = Article {
    site: "Field Notes",
    band: [0xE6EEE3, 0x1E2722],
    title: "A slow morning on the coast trail",
    byline: "Mara Lindqvist · 6 min read",
    body: "We left before the fog lifted, coffee in the side pocket, and walked until the cliffs ran out. Nobody else was there, just gulls and the sound of the tide coming back in.",
    hero: Hero {
        sky: [0xCFE2EC, 0x2A3946],
        sun: [0xF6D58C, 0xCDAE63],
        far: [0xA8C8A2, 0x3E5A45],
        near: [0x7DAA83, 0x2F4839],
        sea: [0x9CC3D4, 0x2D4A59],
    },
};

pub const TRIP: Article = Article {
    site: "Wanderlog",
    band: [0xE5ECF6, 0x1C2330],
    title: "Three days in Lisbon",
    byline: "Itinerary · 12 places · shared with 2",
    body: "Day one starts in Alfama with pastéis de nata at the corner bakery, then the 28 tram up to the castle before the crowds arrive.",
    hero: Hero {
        sky: [0xF4D9C2, 0x4A3439],
        sun: [0xF2A86A, 0xC77F4B],
        far: [0xE7B9A0, 0x5B4044],
        near: [0xC98F7A, 0x43303A],
        sea: [0xB7CFE0, 0x2C3E52],
    },
};

#[derive(Clone, Copy, Debug)]
pub struct Suggestion {
    pub icon: Option<&'static str>,
    pub fav: Option<Tab>,
    pub title: &'static str,
    pub detail: Option<&'static str>,
    pub hint: Option<&'static str>,
}

const fn sug(
    fav: Option<Tab>,
    icon: Option<&'static str>,
    title: &'static str,
    detail: Option<&'static str>,
    hint: Option<&'static str>,
) -> Suggestion {
    Suggestion {
        icon,
        fav,
        title,
        detail,
        hint,
    }
}

pub const CURRENT: [Suggestion; 3] = [
    sug(
        Some(TABS[0]),
        None,
        "A slow morning on the coast trail",
        Some("fieldnotes.blog"),
        None,
    ),
    sug(
        Some(TABS[2]),
        None,
        "Weekend in Lisbon",
        None,
        Some("Switch to Tab"),
    ),
    sug(
        None,
        Some("magnifyingglass"),
        "coast trail walks",
        None,
        None,
    ),
];

pub const FRESH: [Suggestion; 3] = [
    sug(Some(TABS[1]), None, "Inbox", None, Some("Switch to Tab")),
    sug(Some(TABS[3]), None, "Q4 roadmap", Some("docs.new"), None),
    sug(None, Some("clock"), "coast trail walks", None, None),
];

#[derive(Clone, Copy, Debug)]
pub struct ToolbarInk {
    pub background: Option<RgbaColor>,
    pub text: RgbaColor,
    pub secondary: RgbaColor,
    pub icon: RgbaColor,
    pub divider: RgbaColor,
}

#[derive(Clone, Debug)]
pub struct MockLook {
    pub dark: bool,
    pub t: ColorRoles,
    pub tint: [RgbaColor; 2],
    pub card: RgbaColor,
    pub page: RgbaColor,
    pub ink: RgbaColor,
    pub ink_dim: RgbaColor,
    pub ink_faint: RgbaColor,
    pub site: ToolbarInk,
    pub plain: ToolbarInk,
}

fn opaque_card(card: RgbaColor, tint: [RgbaColor; 2]) -> RgbaColor {
    let mix = |v: f32, top: f32, bottom: f32| card.a * v + (1.0 - card.a) * (top + bottom) / 2.0;
    RgbaColor::new(
        mix(card.r, tint[0].r, tint[1].r),
        mix(card.g, tint[0].g, tint[1].g),
        mix(card.b, tint[0].b, tint[1].b),
        1.0,
    )
}

impl MockLook {
    pub fn new(dark: bool, accent: RgbaColor) -> MockLook {
        let exact = ProfileColor::ALL
            .into_iter()
            .find(|color| color.spec().swatch.to_hex_rgb() == accent.to_hex_rgb());
        let preset = exact.unwrap_or_else(|| nearest_preset(accent));
        let theme = Theme::preset(ThemeFamily::Preset(preset), dark);
        let tint = if exact.is_some() {
            theme.backdrop.tint.opaque(dark, NEUTRAL_FILL)
        } else {
            BackdropTint::new(tint_for_hue(accent, false), false).opaque(dark, NEUTRAL_FILL)
        };
        let t = theme.roles;
        let card = opaque_card(t.card, tint);
        let site_color = RgbaColor::hex(if dark { NOTES.band[1] } else { NOTES.band[0] });
        let roles = site_toolbar_roles(site_color);
        let (page, ink, ink_dim, ink_faint) = if dark {
            (
                RgbaColor::hex(0x161718),
                RgbaColor::hex(0xECECEE),
                RgbaColor::new(0.925490, 0.925490, 0.933333, 0.62),
                RgbaColor::new(0.925490, 0.925490, 0.933333, 0.4),
            )
        } else {
            (
                RgbaColor::WHITE,
                RgbaColor::hex(0x1D1D1F),
                RgbaColor::new(0.113725, 0.113725, 0.121569, 0.62),
                RgbaColor::new(0.113725, 0.113725, 0.121569, 0.42),
            )
        };
        MockLook {
            dark,
            tint,
            card,
            page,
            ink,
            ink_dim,
            ink_faint,
            site: ToolbarInk {
                background: Some(site_color),
                text: roles.text,
                secondary: roles.secondary,
                icon: roles.icon,
                divider: roles.divider,
            },
            plain: ToolbarInk {
                background: None,
                text: t.text_primary,
                secondary: t.text_secondary,
                icon: t.icon,
                divider: t.divider,
            },
            t,
        }
    }

    fn pick(&self, pair: [u32; 2]) -> Hsla {
        c(RgbaColor::hex(if self.dark { pair[1] } else { pair[0] }))
    }
}

pub fn ease_out_cubic(x: f32) -> f32 {
    1.0 - (1.0 - x).powi(3)
}

pub fn linear(x: f32) -> f32 {
    x
}

const SAMPLES: f32 = 8.0;

fn sampled(u: f32, ease: fn(f32) -> f32) -> f32 {
    let k = (u.clamp(0.0, 1.0) * SAMPLES).min(SAMPLES);
    let lo = k.floor();
    if lo >= SAMPLES {
        return ease(1.0);
    }
    let a = ease(lo / SAMPLES);
    let b = ease((lo + 1.0) / SAMPLES);
    a + (b - a) * (k - lo)
}

pub fn track(ms: f32, stops: &[(f32, f32)], ease: fn(f32) -> f32) -> f32 {
    let Some(first) = stops.first() else {
        return 0.0;
    };
    if ms <= first.0 {
        return first.1;
    }
    for pair in stops.windows(2) {
        let (from, start) = pair[0];
        let (to, end) = pair[1];
        if ms <= to {
            if (end - start).abs() < f32::EPSILON || to <= from {
                return end;
            }
            return start + (end - start) * sampled((ms - from) / (to - from), ease);
        }
    }
    stops.last().map_or(0.0, |s| s.1)
}

#[derive(Clone, Copy, Debug)]
pub struct Tracker {
    pub ms: f32,
    pub offset: f32,
}

impl Tracker {
    pub fn new(phase: f32, duration: f32, offset: f32) -> Tracker {
        Tracker {
            ms: phase * duration,
            offset,
        }
    }

    pub fn t(&self, stops: &[(f32, f32)]) -> f32 {
        self.with(stops, ease_out_cubic)
    }

    pub fn with(&self, stops: &[(f32, f32)], ease: fn(f32) -> f32) -> f32 {
        track(self.ms - self.offset, stops, ease)
    }

    pub fn fade_in(&self, ms: f32, dur: f32) -> f32 {
        self.t(&[(ms, 0.0), (ms + dur, 1.0)])
    }

    pub fn fade_out(&self, ms: f32, dur: f32) -> f32 {
        self.t(&[(ms, 1.0), (ms + dur, 0.0)])
    }

    pub fn trip(&self, from: f32, to: f32, at: f32, back: f32, dur: f32, back_dur: f32) -> f32 {
        self.t(&[
            (at, from),
            (at + dur, to),
            (back, to),
            (back + back_dur, from),
        ])
    }

    pub fn pulse(&self, at: f32, back: f32, dur: f32, back_dur: f32) -> f32 {
        self.trip(0.0, 1.0, at, back, dur, back_dur)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PreviewId {
    TabsSidebar,
    TabsTop,
    AddressToolbar,
    AddressSidebar,
    CmdlField,
    CmdlCentred,
    NewtabPage,
    NewtabCommandbar,
    NewtabposBottom,
    NewtabposTop,
    NewtabposNext,
    CtrltabStep,
    CtrltabSwitcher,
    TidyKeep,
    TidyAuto,
    QuitRestore,
    QuitFresh,
    WindowsSeparate,
    WindowsShared,
    AppearanceAuto,
    AppearanceLight,
    AppearanceDark,
    StyleGlass,
    StyleClassic,
    SitecolorOn,
    SitecolorOff,
    BlockOn,
    BlockOff,
    LinksLittle,
    LinksTab,
}

impl PreviewId {
    pub const ALL: [PreviewId; 30] = [
        PreviewId::TabsSidebar,
        PreviewId::TabsTop,
        PreviewId::AddressToolbar,
        PreviewId::AddressSidebar,
        PreviewId::CmdlField,
        PreviewId::CmdlCentred,
        PreviewId::NewtabPage,
        PreviewId::NewtabCommandbar,
        PreviewId::NewtabposBottom,
        PreviewId::NewtabposTop,
        PreviewId::NewtabposNext,
        PreviewId::CtrltabStep,
        PreviewId::CtrltabSwitcher,
        PreviewId::TidyKeep,
        PreviewId::TidyAuto,
        PreviewId::QuitRestore,
        PreviewId::QuitFresh,
        PreviewId::WindowsSeparate,
        PreviewId::WindowsShared,
        PreviewId::AppearanceAuto,
        PreviewId::AppearanceLight,
        PreviewId::AppearanceDark,
        PreviewId::StyleGlass,
        PreviewId::StyleClassic,
        PreviewId::SitecolorOn,
        PreviewId::SitecolorOff,
        PreviewId::BlockOn,
        PreviewId::BlockOff,
        PreviewId::LinksLittle,
        PreviewId::LinksTab,
    ];

    pub const fn key(self) -> &'static str {
        match self {
            PreviewId::TabsSidebar => "tabs-sidebar",
            PreviewId::TabsTop => "tabs-top",
            PreviewId::AddressToolbar => "address-toolbar",
            PreviewId::AddressSidebar => "address-sidebar",
            PreviewId::CmdlField => "cmdl-field",
            PreviewId::CmdlCentred => "cmdl-centred",
            PreviewId::NewtabPage => "newtab-page",
            PreviewId::NewtabCommandbar => "newtab-commandbar",
            PreviewId::NewtabposBottom => "newtabpos-bottom",
            PreviewId::NewtabposTop => "newtabpos-top",
            PreviewId::NewtabposNext => "newtabpos-next",
            PreviewId::CtrltabStep => "ctrltab-step",
            PreviewId::CtrltabSwitcher => "ctrltab-switcher",
            PreviewId::TidyKeep => "tidy-keep",
            PreviewId::TidyAuto => "tidy-auto",
            PreviewId::QuitRestore => "quit-restore",
            PreviewId::QuitFresh => "quit-fresh",
            PreviewId::WindowsSeparate => "windows-separate",
            PreviewId::WindowsShared => "windows-shared",
            PreviewId::AppearanceAuto => "appearance-auto",
            PreviewId::AppearanceLight => "appearance-light",
            PreviewId::AppearanceDark => "appearance-dark",
            PreviewId::StyleGlass => "style-glass",
            PreviewId::StyleClassic => "style-classic",
            PreviewId::SitecolorOn => "sitecolor-on",
            PreviewId::SitecolorOff => "sitecolor-off",
            PreviewId::BlockOn => "block-on",
            PreviewId::BlockOff => "block-off",
            PreviewId::LinksLittle => "links-little",
            PreviewId::LinksTab => "links-tab",
        }
    }

    pub const fn duration_ms(self) -> f32 {
        match self {
            PreviewId::TabsSidebar
            | PreviewId::TabsTop
            | PreviewId::AddressToolbar
            | PreviewId::AddressSidebar => 2800.0,
            PreviewId::CmdlField | PreviewId::CmdlCentred => 3000.0,
            PreviewId::NewtabPage | PreviewId::NewtabCommandbar => 3000.0,
            PreviewId::NewtabposBottom | PreviewId::NewtabposTop | PreviewId::NewtabposNext => {
                2800.0
            }
            PreviewId::CtrltabStep | PreviewId::CtrltabSwitcher => 3200.0,
            PreviewId::TidyKeep | PreviewId::TidyAuto => 3600.0,
            PreviewId::QuitRestore | PreviewId::QuitFresh => 3400.0,
            PreviewId::WindowsSeparate | PreviewId::WindowsShared => 3800.0,
            PreviewId::AppearanceAuto | PreviewId::AppearanceLight | PreviewId::AppearanceDark => {
                3000.0
            }
            PreviewId::StyleGlass | PreviewId::StyleClassic => 1300.0,
            PreviewId::SitecolorOn | PreviewId::SitecolorOff => 2800.0,
            PreviewId::BlockOn | PreviewId::BlockOff => 3200.0,
            PreviewId::LinksLittle | PreviewId::LinksTab => 4000.0,
        }
    }

    pub fn settings_patch(self) -> &'static [(&'static str, &'static str)] {
        match self {
            PreviewId::TabsSidebar => &[("tabLayout", "sidebar")],
            PreviewId::TabsTop => &[("tabLayout", "top")],
            PreviewId::AddressToolbar => &[("addressBar", "toolbar")],
            PreviewId::AddressSidebar => &[("addressBar", "sidebar")],
            PreviewId::AppearanceAuto => &[("appearance", "auto")],
            PreviewId::AppearanceLight => &[("appearance", "light")],
            PreviewId::AppearanceDark => &[("appearance", "dark")],
            PreviewId::SitecolorOn => &[("extendWebsiteColor", "true")],
            PreviewId::SitecolorOff => &[("extendWebsiteColor", "false")],
            _ => &[],
        }
    }
}

pub fn preview_for(prefix: &str, value: &str) -> Option<PreviewId> {
    Some(match (prefix, value) {
        ("tabs", "sidebar") => PreviewId::TabsSidebar,
        ("tabs", "top") => PreviewId::TabsTop,
        ("address", "toolbar") => PreviewId::AddressToolbar,
        ("address", "sidebar") => PreviewId::AddressSidebar,
        ("cmdl", "field") => PreviewId::CmdlField,
        ("cmdl", "centred") => PreviewId::CmdlCentred,
        ("newtab", "page") => PreviewId::NewtabPage,
        ("newtab", "commandBar") => PreviewId::NewtabCommandbar,
        ("newtabpos", "bottom") => PreviewId::NewtabposBottom,
        ("newtabpos", "top") => PreviewId::NewtabposTop,
        ("newtabpos", "nextToCurrent") => PreviewId::NewtabposNext,
        ("ctrltab", "step") => PreviewId::CtrltabStep,
        ("ctrltab", "switcher") => PreviewId::CtrltabSwitcher,
        ("tidy", "keep") => PreviewId::TidyKeep,
        ("tidy", "tidy") => PreviewId::TidyAuto,
        ("quit", "true") => PreviewId::QuitRestore,
        ("quit", "false") => PreviewId::QuitFresh,
        ("windows", "false") => PreviewId::WindowsSeparate,
        ("windows", "true") => PreviewId::WindowsShared,
        ("appearance", "auto") => PreviewId::AppearanceAuto,
        ("appearance", "light") => PreviewId::AppearanceLight,
        ("appearance", "dark") => PreviewId::AppearanceDark,
        ("style", "glass") => PreviewId::StyleGlass,
        ("style", "classic") => PreviewId::StyleClassic,
        ("sitecolor", "true") => PreviewId::SitecolorOn,
        ("sitecolor", "false") => PreviewId::SitecolorOff,
        ("links", "true") => PreviewId::LinksLittle,
        ("links", "false") => PreviewId::LinksTab,
        _ => return None,
    })
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct MockFocus {
    section: Option<String>,
    hovered: Option<PreviewId>,
    settled: Option<(String, Option<PreviewId>)>,
}

impl MockFocus {
    pub fn hover(&mut self, id: PreviewId, on: bool) {
        if on {
            self.hovered = Some(id);
        }
    }

    pub fn choose(&mut self, key: &str, id: Option<PreviewId>) {
        self.hovered = None;
        self.settled = Some((key.to_owned(), id));
    }

    pub fn settle(&mut self, key: &str, id: Option<PreviewId>) {
        self.settled = Some((key.to_owned(), id));
    }

    pub fn show(&mut self, section: Option<String>) {
        if self.section != section {
            self.section = section;
            self.hovered = None;
        }
    }

    pub fn current(&self) -> Option<PreviewId> {
        self.hovered
            .or_else(|| match (&self.settled, &self.section) {
                (Some((key, id)), Some(section)) if key == section => *id,
                _ => None,
            })
    }
}

pub fn with_preview(settings: &Settings, id: Option<PreviewId>) -> Settings {
    let mut out = settings.clone();
    if let Some(id) = id {
        for (key, value) in id.settings_patch() {
            let json = match *value {
                "true" => serde_json::Value::Bool(true),
                "false" => serde_json::Value::Bool(false),
                text => serde_json::Value::from(text),
            };
            let _ = out.set(key, &json);
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shape {
    pub top: bool,
    pub address_in_sidebar: bool,
    pub dark_mode: Option<bool>,
    pub site_color: bool,
    pub frame: f32,
}

impl Shape {
    pub fn of(settings: &Settings) -> Shape {
        use ardia_state::model::TabLayout;
        use ardia_state::settings::{AddressBar, Appearance};
        let top = settings.tab_layout == TabLayout::Top;
        Shape {
            top,
            address_in_sidebar: !top && settings.address_bar == AddressBar::Sidebar,
            dark_mode: match settings.appearance {
                Appearance::Auto => None,
                Appearance::Light => Some(false),
                Appearance::Dark => Some(true),
            },
            site_color: settings.extend_website_color,
            frame: settings.page_frame_inset(false, false),
        }
    }

    fn same_layout(&self, other: &Shape) -> bool {
        self.top == other.top
            && self.address_in_sidebar == other.address_in_sidebar
            && self.dark_mode == other.dark_mode
            && self.site_color == other.site_color
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum DirectorStage {
    Settle { morph_from: Option<PreviewId> },
    Show,
}

#[derive(Clone, Debug)]
pub struct SceneDirector {
    shown_settings: Option<PreviewId>,
    shown_scene: Option<PreviewId>,
    wanted: Option<PreviewId>,
    wanted_group: String,
    pending: Option<(Instant, DirectorStage, u64)>,
    arriving: bool,
}

impl SceneDirector {
    pub fn new(want: Option<PreviewId>) -> SceneDirector {
        SceneDirector {
            shown_settings: want,
            shown_scene: None,
            wanted: None,
            wanted_group: String::new(),
            pending: None,
            arriving: false,
        }
    }

    pub fn update(
        &mut self,
        want: Option<PreviewId>,
        settings: &Settings,
        group: &str,
        settle_ms: u64,
        now: Instant,
    ) -> (Settings, Option<PreviewId>, bool) {
        if want != self.wanted {
            self.arriving = self.wanted.is_none() || self.wanted_group != group;
            self.wanted = want;
            self.wanted_group = group.to_owned();
            self.pending = None;
            if !(self.shown_scene == want && self.shown_settings == want) {
                let leaving = self.shown_scene.is_some() && self.shown_scene != want;
                if leaving {
                    self.shown_scene = None;
                }
                let wait = if leaving { FOCUS } else { Duration::ZERO };
                self.pending = Some((
                    now + wait,
                    DirectorStage::Settle { morph_from: None },
                    settle_ms,
                ));
            }
        }
        while let Some((due, stage, settle)) = self.pending {
            if now < due {
                break;
            }
            match stage {
                DirectorStage::Settle { .. } => {
                    let morph = !Shape::of(&with_preview(settings, self.shown_settings))
                        .same_layout(&Shape::of(&with_preview(settings, self.wanted)));
                    self.shown_settings = self.wanted;
                    let wait = Duration::from_millis(
                        if morph { MOVE.as_millis() as u64 } else { 0 }.max(if self.arriving {
                            settle
                        } else {
                            0
                        }),
                    );
                    self.pending = Some((due + wait, DirectorStage::Show, settle));
                }
                DirectorStage::Show => {
                    self.shown_settings = self.wanted;
                    self.shown_scene = self.wanted;
                    self.pending = None;
                }
            }
        }
        (
            with_preview(settings, self.shown_settings),
            self.shown_scene,
            self.pending.is_some(),
        )
    }
}

#[derive(Clone, Debug)]
struct SceneLayer {
    id: PreviewId,
    live: bool,
    started: Instant,
    opacity: Motion,
}

#[derive(Clone, Debug)]
pub struct MockInputs<'a> {
    pub settings: &'a Settings,
    pub accent: RgbaColor,
    pub custom: Option<Arc<ProfileTheme>>,
    pub system_dark: bool,
}

#[derive(Clone, Debug)]
pub struct MockWindow {
    lay: Motion,
    addr: Motion,
    site: Motion,
    dark: Option<bool>,
    dark_fade: Option<(bool, Instant)>,
    accent: Option<RgbaColor>,
    accent_fade: Option<(RgbaColor, Instant)>,
    layers: Vec<SceneLayer>,
    looks: Vec<(bool, RgbaColor, MockLook)>,
}

impl Default for MockWindow {
    fn default() -> Self {
        MockWindow::new()
    }
}

impl MockWindow {
    pub fn new() -> MockWindow {
        MockWindow {
            lay: Motion::rest(0.0),
            addr: Motion::rest(0.0),
            site: Motion::rest(1.0),
            dark: None,
            dark_fade: None,
            accent: None,
            accent_fade: None,
            layers: Vec::new(),
            looks: Vec::new(),
        }
    }

    fn look(&mut self, dark: bool, accent: RgbaColor) -> MockLook {
        if let Some((_, _, look)) = self
            .looks
            .iter()
            .find(|(d, a, _)| *d == dark && *a == accent)
        {
            return look.clone();
        }
        let look = MockLook::new(dark, accent);
        if self.looks.len() > 8 {
            self.looks.remove(0);
        }
        self.looks.push((dark, accent, look.clone()));
        look
    }

    fn aim(
        &mut self,
        shape: &Shape,
        dark: bool,
        accent: RgbaColor,
        focus: Option<PreviewId>,
        now: Instant,
    ) {
        let first = self.dark.is_none();
        let target = |motion: &mut Motion, value: f32, duration: Duration| {
            if first {
                motion.snap(value);
            } else if (motion.target() - value).abs() > f32::EPSILON {
                motion.go(value, duration, Curve::EaseOut, now);
            }
        };
        target(&mut self.lay, if shape.top { 1.0 } else { 0.0 }, MOVE);
        target(
            &mut self.addr,
            if shape.address_in_sidebar { 1.0 } else { 0.0 },
            MOVE,
        );
        target(
            &mut self.site,
            if shape.site_color { 1.0 } else { 0.0 },
            FADE,
        );
        if let Some(previous) = self.dark
            && previous != dark
        {
            self.dark_fade = Some((previous, now));
        }
        self.dark = Some(dark);
        if let Some(previous) = self.accent
            && previous != accent
        {
            self.accent_fade = Some((previous, now));
        }
        self.accent = Some(accent);
        if self.layers.iter().find(|l| l.live).map(|l| l.id) != focus {
            for layer in &mut self.layers {
                if layer.live {
                    layer.live = false;
                    layer.opacity.go(0.0, FOCUS, Curve::EaseOut, now);
                }
            }
            self.layers.retain(|l| l.live || Some(l.id) != focus);
            while self.layers.len() > 1 {
                self.layers.remove(0);
            }
            if let Some(id) = focus {
                let mut opacity = Motion::rest(0.0);
                opacity.go(1.0, FOCUS, Curve::EaseOut, now);
                self.layers.push(SceneLayer {
                    id,
                    live: true,
                    started: now,
                    opacity,
                });
            }
        }
        self.layers.retain(|l| l.live || l.opacity.running(now));
        if self
            .dark_fade
            .is_some_and(|(_, at)| now.duration_since(at) >= FADE)
        {
            self.dark_fade = None;
        }
        if self
            .accent_fade
            .is_some_and(|(_, at)| now.duration_since(at) >= FADE)
        {
            self.accent_fade = None;
        }
    }

    pub fn render(
        &mut self,
        host: &dyn UiHost,
        inputs: &MockInputs,
        focus: Option<PreviewId>,
        width: f32,
        height: f32,
        now: Instant,
    ) -> (AnyElement, bool) {
        let shape = Shape::of(inputs.settings);
        let dark = shape.dark_mode.unwrap_or(inputs.system_dark);
        self.aim(&shape, dark, inputs.accent, focus, now);
        let inner_w = (width - INSET_X * 2.0).max(1.0);
        let inner_h = (height - INSET_TOP - INSET_BOTTOM).max(1.0);
        let g = Geo::of(inner_w, inner_h);
        let look = self.look(dark, inputs.accent);
        let motion = Values {
            lay: self.lay.value(now),
            addr: self.addr.value(now),
            site: self.site.value(now),
        };
        let mut running = self.lay.running(now)
            || self.addr.running(now)
            || self.site.running(now)
            || self.dark_fade.is_some()
            || self.accent_fade.is_some();
        let custom = inputs.custom.clone();
        let base = |this: &mut MockWindow, d: bool, accent: RgbaColor| {
            let l = this.look(d, accent);
            window_state(
                Kit { g, look: &l, host },
                &motion,
                shape.frame,
                Slots::default(),
                custom.is_some(),
            )
        };
        let mut window = fill();
        if let Some((previous, at)) = self.dark_fade {
            let t = ease_out_cubic(
                (now.duration_since(at).as_secs_f32() / FADE.as_secs_f32()).min(1.0),
            );
            let accent = inputs.accent;
            window = window
                .child(base(self, previous, accent))
                .child(fill().opacity(t).child(base(self, dark, accent)));
        } else if let Some((previous, at)) = self.accent_fade {
            let t = ease_out_cubic(
                (now.duration_since(at).as_secs_f32() / FADE.as_secs_f32()).min(1.0),
            );
            window = window
                .child(base(self, dark, previous))
                .child(fill().opacity(t).child(base(self, dark, inputs.accent)));
        } else {
            window = window.child(base(self, dark, inputs.accent));
        }
        let opts = SceneOpts {
            top: shape.top,
            address_in_sidebar: shape.address_in_sidebar,
            site_color: shape.site_color,
            frame: shape.frame,
            accent: inputs.accent,
            system_dark: inputs.system_dark,
        };
        for layer in &self.layers {
            running = true;
            let duration = layer.id.duration_ms();
            let phase =
                (now.duration_since(layer.started).as_secs_f32() * 1000.0 % duration) / duration;
            let k = Kit {
                g,
                look: &look,
                host,
            };
            window = window.child(
                fill()
                    .opacity(layer.opacity.value(now))
                    .child(scene(layer.id, k, phase, &opts)),
            );
        }
        let frame = Kit {
            g,
            look: &look,
            host,
        };
        let edge = RgbaColor::hexa(if dark { 0xFFFFFF2E } else { 0x0000002A });
        let element = div()
            .relative()
            .w(px(width))
            .h(px(height))
            .child(
                window_frame(frame, edge, DEFAULT_WINDOW_CORNER_RADIUS)
                    .left(px(INSET_X))
                    .top(px(INSET_TOP))
                    .w(px(inner_w))
                    .h(px(inner_h))
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .rounded(px(DEFAULT_WINDOW_CORNER_RADIUS * g.s))
                            .overflow_hidden()
                            .child(window),
                    ),
            )
            .into_any_element();
        (element, running)
    }
}

#[derive(Clone, Copy)]
struct Kit<'a> {
    g: Geo,
    look: &'a MockLook,
    host: &'a dyn UiHost,
}

impl<'a> Kit<'a> {
    fn with_look(self, look: &'a MockLook) -> Kit<'a> {
        Kit { look, ..self }
    }

    fn scaled(self, k: f32) -> Kit<'a> {
        Kit {
            g: self.g.scaled(k),
            ..self
        }
    }

    fn glyph(
        &self,
        name: &str,
        size: f32,
        color: RgbaColor,
        weight: SymbolWeight,
        boxed: f32,
    ) -> AnyElement {
        symbol(
            self.host,
            name,
            size * self.g.s,
            boxed * self.g.s,
            weight,
            c(color),
        )
    }

    fn turning_glyph(
        &self,
        name: &str,
        size: f32,
        color: RgbaColor,
        weight: SymbolWeight,
        boxed: f32,
        degrees: f32,
    ) -> AnyElement {
        let name = crate::primitives::symbol_glyphs::drawn_symbol_name(name);
        let point = size * self.g.s;
        let tint = c(color);
        let fallback = self.glyph(&name, size, color, weight, boxed);
        if !crate::primitives::symbol_glyphs::has_symbol_renderer() {
            return fallback;
        }
        div()
            .flex_none()
            .size(px(boxed * self.g.s))
            .rotate(gpui::radians(degrees.to_radians()))
            .child(
                gpui::canvas(
                    |_, _, _| {},
                    move |bounds, _, window, _| {
                        let raster = crate::primitives::symbol_glyphs::SymbolRaster {
                            name: &name,
                            point_size: point,
                            weight,
                            scale: window.scale_factor(),
                        };
                        if let Some(glyph) =
                            crate::primitives::symbol_glyphs::symbol_glyph(&raster, gpui::white())
                        {
                            let placed = crate::primitives::symbol_glyphs::glyph_bounds(
                                bounds,
                                &glyph,
                                window.scale_factor(),
                                false,
                            );
                            let _ = window.paint_image_mask(
                                placed,
                                glyph.image,
                                0,
                                gpui::TransformationMatrix::unit(),
                                tint,
                            );
                        }
                    },
                )
                .size_full(),
            )
            .into_any_element()
    }

    fn label(
        &self,
        size: f32,
        color: RgbaColor,
        weight: FontWeight,
        text: impl Into<SharedString>,
    ) -> Div {
        div()
            .flex_none()
            .whitespace_nowrap()
            .overflow_hidden()
            .text_ellipsis()
            .font_family(UI_FONT)
            .text_size(px(size * self.g.s))
            .line_height(px(size * 1.3 * self.g.s))
            .font_weight(weight)
            .text_color(c(color))
            .child(text.into())
    }
}

#[derive(Clone, Copy, Debug)]
struct Values {
    lay: f32,
    addr: f32,
    site: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct SceneOpts {
    pub top: bool,
    pub address_in_sidebar: bool,
    pub site_color: bool,
    pub frame: f32,
    pub accent: RgbaColor,
    pub system_dark: bool,
}

#[derive(Default)]
struct Slots {
    rows: Option<AnyElement>,
    chips: Option<AnyElement>,
    page: Option<AnyElement>,
    crumb: Option<Option<AnyElement>>,
    card: Option<AnyElement>,
    over: Option<AnyElement>,
}

fn window_frame(k: Kit, edge: RgbaColor, corner: f32) -> Div {
    let s = k.g.s;
    let opacity = if k.look.dark { 0.55 } else { 0.22 };
    div()
        .absolute()
        .rounded(px(corner * s))
        .bg(c(k.look.tint[1]))
        .border(px(0.5))
        .border_color(c(edge))
        .shadow(vec![shadow(
            c(RgbaColor::black(opacity)),
            10.0 * s,
            22.0 * s,
        )])
}

fn backdrop(look: &MockLook) -> Div {
    let bands = 10;
    let mut out = fill().bg(c(look.tint[0]));
    for i in 0..bands - 1 {
        let top = (i + 1) as f32 / bands as f32;
        out = out.child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .top(gpui::relative(top))
                .bg(c(
                    look.tint[0].mix(look.tint[1], (i + 1) as f32 / (bands - 1) as f32)
                )),
        );
    }
    out
}

fn lights(k: Kit, x: f32, y: f32) -> Div {
    const COLORS: [u32; 3] = [0xFF5F57, 0xFEBC2E, 0x28C840];
    let g = k.g;
    at(g, x - 6.0, y - 6.0, 52.0, 12.0).children(COLORS.iter().enumerate().map(|(i, color)| {
        at(g, i as f32 * 20.0, 0.0, 12.0, 12.0)
            .rounded_full()
            .bg(c(RgbaColor::hex(*color)))
            .border(px(0.5))
            .border_color(c(RgbaColor::black(0.14)))
    }))
}

fn favicon(k: Kit, t: Tab, size: f32) -> AnyElement {
    let s = k.g.s;
    if t.icon == "plus" {
        return div()
            .flex_none()
            .size(px(size * s))
            .flex()
            .items_center()
            .justify_center()
            .child(k.glyph(
                "plus",
                size * 0.8,
                RgbaColor::hex(t.color),
                SymbolWeight::Regular,
                size,
            ))
            .into_any_element();
    }
    div()
        .flex_none()
        .size(px(size * s))
        .rounded(px(size * 0.25 * s))
        .bg(c(RgbaColor::hex(t.color)))
        .flex()
        .items_center()
        .justify_center()
        .child(k.glyph(
            t.icon,
            size * 0.58,
            RgbaColor::WHITE,
            SymbolWeight::Semibold,
            size,
        ))
        .into_any_element()
}

fn highlight(k: Kit, x: f32, y: f32, w: f32, h: f32) -> Div {
    let t = &k.look.t;
    let s = k.g.s;
    at(k.g, x, y, w, h)
        .rounded(px(radius::CHROME * s))
        .bg(c(t.tab_selected))
        .child(crate::primitives::outer_glow::outer_glow(
            px(radius::CHROME * s),
            vec![shadow(
                c(t.tab_selected_shadow),
                0.5 * s,
                t.tab_selected_shadow_radius * s,
            )],
        ))
        .child(crate::primitives::hairline::gradient_hairline(
            c(t.tab_selected_border[0]),
            c(t.tab_selected_border[1]),
            px(0.5),
            px(radius::CHROME * s),
        ))
}

#[derive(Clone, Copy, Debug, Default)]
struct Fx {
    dx: f32,
    dy: f32,
    opacity: Option<f32>,
    scale: Option<f32>,
}

impl Fx {
    fn along(top: bool, value: f32) -> Fx {
        if top {
            Fx {
                dx: value,
                ..Fx::default()
            }
        } else {
            Fx {
                dy: value,
                ..Fx::default()
            }
        }
    }

    fn fade(opacity: f32) -> Fx {
        Fx {
            opacity: Some(opacity),
            ..Fx::default()
        }
    }

    fn and(self, other: Fx) -> Fx {
        Fx {
            dx: self.dx + other.dx,
            dy: self.dy + other.dy,
            opacity: match (self.opacity, other.opacity) {
                (Some(a), Some(b)) => Some(a * b),
                (a, b) => a.or(b),
            },
            scale: match (self.scale, other.scale) {
                (Some(a), Some(b)) => Some(a * b),
                (a, b) => a.or(b),
            },
        }
    }

    fn apply(self, el: Div) -> Div {
        el.when_some(self.opacity, |this, o| this.opacity(o.clamp(0.0, 1.0)))
    }
}

#[allow(clippy::too_many_arguments)]
fn tab_row(
    k: Kit,
    t: Tab,
    x: f32,
    y: f32,
    w: f32,
    selected: bool,
    lit: Option<f32>,
    dim: bool,
    fx: Fx,
) -> AnyElement {
    let g = k.g;
    let s = g.s;
    let roles = &k.look.t;
    let base = if t.title == NEW_TAB.title && t.icon == "plus" {
        roles.text_secondary
    } else if selected {
        roles.tab_selected_text
    } else {
        roles.text_tab
    };
    let scale = fx.scale.unwrap_or(1.0);
    let rk = k.scaled(scale);
    let cw = w * scale;
    let ch = ROW_H * scale;
    let ox = x + (w - cw) / 2.0 + fx.dx / s;
    let oy = y + (ROW_H - ch) / 2.0 + fx.dy / s;
    let label = |color: RgbaColor| rk.label(BODY, color, FontWeight::NORMAL, t.title);
    let row = at(g, ox, oy, cw, ch)
        .when(selected, |this| {
            this.child(highlight(rk, 0.0, 0.0, w, ROW_H))
        })
        .child(
            fill()
                .flex()
                .flex_row()
                .items_center()
                .pl(px(TAB_CONTENT_LEFT * rk.g.s))
                .pr(px(TAB_TRAILING * rk.g.s))
                .gap(px(TAB_TITLE_GAP * rk.g.s))
                .when(dim, |this| this.opacity(0.4))
                .child(favicon(rk, t, 16.0))
                .child(
                    div()
                        .relative()
                        .flex_1()
                        .min_w_0()
                        .child(label(base))
                        .when_some(lit, |this, lit| {
                            this.child(
                                div()
                                    .absolute()
                                    .inset_0()
                                    .opacity(lit.clamp(0.0, 1.0))
                                    .child(label(roles.tab_selected_text)),
                            )
                        }),
                ),
        );
    fx.apply(row).into_any_element()
}

fn rows(k: Kit, from: usize, n: usize, sel: Option<usize>, top: f32) -> AnyElement {
    fill()
        .children((0..n).map(|i| {
            tab_row(
                k,
                tab(from + i),
                ROW_X,
                row_y(i, top),
                ROW_W,
                sel == Some(i),
                None,
                false,
                Fx::default(),
            )
        }))
        .child(tab_row(
            k,
            NEW_TAB,
            ROW_X,
            row_y(n, top),
            ROW_W,
            false,
            None,
            false,
            Fx::default(),
        ))
        .into_any_element()
}

fn nav_icons(k: Kit, color: RgbaColor, xs: &[f32], y: f32, names: &[&str]) -> Div {
    let g = k.g;
    fill().children(xs.iter().enumerate().map(|(i, x)| {
        at(g, x - 10.0, y - 10.0, 20.0, 20.0)
            .flex()
            .items_center()
            .justify_center()
            .child(k.glyph(
                names.get(i).copied().unwrap_or("circle"),
                14.0,
                color,
                SymbolWeight::Medium,
                20.0,
            ))
    }))
}

fn crumb(k: Kit, t: Tab, palette: &ToolbarInk) -> Div {
    let host = t.host.strip_prefix("www.").unwrap_or(t.host);
    div()
        .flex()
        .flex_row()
        .items_center()
        .overflow_hidden()
        .child(k.label(BODY, palette.text, FontWeight::MEDIUM, host))
        .child(
            k.label(
                BODY,
                palette.secondary,
                FontWeight::NORMAL,
                format!("  /  {}", t.title),
            )
            .flex_shrink(1.),
        )
}

fn toolbar_band(
    k: Kit,
    h: f32,
    background: Option<RgbaColor>,
    divider: Option<(RgbaColor, f32)>,
) -> Div {
    div()
        .absolute()
        .left_0()
        .right_0()
        .top_0()
        .h(px(h * k.g.s))
        .when_some(background, |this, bg| this.bg(c(bg)))
        .when_some(divider, |this, (color, opacity)| {
            this.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .h(px(0.5))
                    .bg(c(color))
                    .opacity(opacity),
            )
        })
}

fn site_band(look: &MockLook, site: f32) -> Div {
    fill()
        .opacity(site.clamp(0.0, 1.0))
        .bg(c(look.site.background.unwrap_or(look.card)))
}

fn top_tab_plate(k: Kit, x: f32, site: f32, fx: Fx) -> AnyElement {
    let s = k.g.s;
    fx.apply(
        at(k.g, x + fx.dx / s, 3.0 + fx.dy / s, CHIP_W, STRIP_H - 2.0)
            .rounded_t(px(radius::CHROME * s))
            .overflow_hidden()
            .bg(c(k.look.card))
            .child(site_band(k.look, site)),
    )
    .into_any_element()
}

fn rest_chips(k: Kit, site: f32, from: usize) -> AnyElement {
    fill()
        .child(top_tab_plate(k, CHIP_X, site, Fx::default()))
        .children((0..rest_chip_count(k.g)).map(|i| {
            tab_row(
                k,
                tab(from + i),
                CHIP_X + i as f32 * CHIP_STEP,
                CHIP_TOP - 1.0,
                CHIP_W,
                false,
                None,
                false,
                Fx::default(),
            )
        }))
        .into_any_element()
}

fn hero(k: Kit, a: &Article, width: f32, height: f32) -> Div {
    let s = k.g.s;
    let h = a.hero;
    let look = k.look;
    div()
        .relative()
        .w(px(width * s))
        .h(px(height * s))
        .rounded(px(radius::PANEL * s))
        .overflow_hidden()
        .bg(look.pick(h.sky))
        .child(
            div()
                .absolute()
                .left(px((width * 0.82 - height * 0.26) * s))
                .top(px(height * 0.16 * s))
                .size(px(height * 0.26 * s))
                .rounded_full()
                .bg(look.pick(h.sun)),
        )
        .child(
            div()
                .absolute()
                .left(px(-0.2 * width * s))
                .w(px(0.9 * width * s))
                .top(px(height * 0.42 * s))
                .h(px(height * 1.4 * s))
                .rounded(px(height * 0.9 * s))
                .bg(look.pick(h.far)),
        )
        .child(
            div()
                .absolute()
                .left(px(0.35 * width * s))
                .w(px(0.95 * width * s))
                .top(px(height * 0.52 * s))
                .h(px(height * 1.4 * s))
                .rounded(px(height * 0.9 * s))
                .bg(look.pick(h.near)),
        )
        .child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .h(px(height * 0.2 * s))
                .bg(look.pick(h.sea)),
        )
}

fn page(k: Kit, a: &Article, top: f32, width: f32, extra: Option<AnyElement>) -> AnyElement {
    let s = k.g.s;
    let look = k.look;
    let column = (width * 0.84).min(600.0);
    div()
        .absolute()
        .left_0()
        .right_0()
        .bottom_0()
        .top(px(top * s))
        .bg(c(look.page))
        .overflow_hidden()
        .child(
            div()
                .h(px(58.0 * s))
                .bg(look.pick(a.band))
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .px(px(space::HUGE * s))
                .child(
                    k.label(LARGE, look.ink, FontWeight::BOLD, a.site)
                        .font_family("Georgia"),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .justify_end()
                        .flex_shrink(1.)
                        .overflow_hidden()
                        .h(px(CAPTION * 1.3 * s))
                        .ml(px(space::XL * s))
                        .gap(px(space::XL * s))
                        .children(
                            ["Journal", "Maps", "About"]
                                .map(|n| k.label(CAPTION, look.ink_dim, FontWeight::NORMAL, n)),
                        ),
                ),
        )
        .child(
            div()
                .w(px(column * s))
                .mx_auto()
                .pt(px(space::XXXL * s))
                .flex()
                .flex_col()
                .gap(px(space::L * s))
                .child(hero(k, a, column, 168.0))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(space::XS * s))
                        .child(
                            div()
                                .font_family("Georgia")
                                .text_size(px(DISPLAY_TITLE * s))
                                .line_height(px(DISPLAY_TITLE * 1.3 * s))
                                .font_weight(FontWeight::BOLD)
                                .text_color(c(look.ink))
                                .line_clamp(2)
                                .child(a.title),
                        )
                        .child(k.label(CAPTION, look.ink_faint, FontWeight::NORMAL, a.byline)),
                )
                .child(
                    div()
                        .font_family(UI_FONT)
                        .text_size(px(SMALL * s))
                        .line_height(px(18.0 * s))
                        .text_color(c(look.ink_dim))
                        .line_clamp(4)
                        .child(a.body),
                )
                .children(extra),
        )
        .into_any_element()
}

fn new_tab_page(k: Kit, top: f32, width: f32) -> AnyElement {
    let s = k.g.s;
    let t = &k.look.t;
    let bar_w = 520.0f32.min(width - 60.0);
    div()
        .absolute()
        .left_0()
        .right_0()
        .bottom_0()
        .top(px(top * s))
        .bg(c(k.look.card))
        .flex()
        .flex_col()
        .items_center()
        .child(
            div()
                .mt(px(120.0 * s))
                .w(px(bar_w * s))
                .h(px(43.0 * s))
                .rounded(px(20.0 * s))
                .bg(c(t.ntp_bar_solid))
                .border(px(0.5))
                .border_color(c(t.ntp_bar_border))
                .flex()
                .flex_row()
                .items_center()
                .pl(px(13.0 * s))
                .pr(px(15.0 * s))
                .gap(px(space::M * s))
                .child(k.glyph(
                    "magnifyingglass",
                    14.0,
                    t.text_secondary,
                    SymbolWeight::Medium,
                    18.0,
                ))
                .child(k.label(
                    TITLE,
                    t.placeholder,
                    FontWeight::NORMAL,
                    "Search or enter address",
                )),
        )
        .child(
            div()
                .mt(px(space::HUGE * s))
                .flex()
                .flex_row()
                .gap(px(space::XL * s))
                .children(TABS.iter().take(6).map(|tb| {
                    div()
                        .size(px(46.0 * s))
                        .rounded(px(radius::PANEL * s))
                        .bg(c(t.pinned_resting))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(favicon(k, *tb, 22.0))
                })),
        )
        .into_any_element()
}

fn window_state(k: Kit, v: &Values, frame: f32, slots: Slots, custom: bool) -> AnyElement {
    let g = k.g;
    let s = g.s;
    let look = k.look;
    let side_card_x = SIDEBAR_W + (frame - ROW_X).max(0.0);
    let lights_y = LIGHTS_TOOLBAR - CARD_INSET + frame;
    let lerp = |t: f32, a: f32, b: f32| a + (b - a) * t;
    let side_card_w = g.w - side_card_x - frame;
    let crumb_left = lerp(v.lay, side_card_x + CRUMB_X, frame + 118.0)
        + lerp(
            v.addr,
            0.0,
            FIELD.x + FIELD_CRUMB.x - (side_card_x + CRUMB_X),
        );
    let crumb_top = lerp(v.lay, frame + 12.0, STRIP_H + 12.0)
        + lerp(v.addr, 0.0, FIELD.y + FIELD_CRUMB.y - (frame + 12.0));
    let lights_dx = lerp(v.lay, 0.0, 20.75 - 25.0);
    let lights_dy = lerp(
        v.lay,
        lights_y - LIGHTS_TOOLBAR,
        LIGHTS_STRIP - LIGHTS_TOOLBAR,
    ) + lerp(v.addr, 0.0, LIGHTS_FIELD - lights_y);
    let card = Rect::new(
        lerp(v.lay, side_card_x, frame),
        lerp(v.lay, frame, STRIP_H),
        lerp(v.lay, side_card_w, g.w - 2.0 * frame),
        lerp(v.lay, g.h - 2.0 * frame, g.h - STRIP_H - frame),
    );
    let cg = Geo {
        s,
        w: card.w,
        h: card.h,
    };
    let ck = Kit { g: cg, ..k };
    let rows_el = slots
        .rows
        .unwrap_or_else(|| rows(k, 0, rest_row_count(g), Some(0), ROW_TOP));
    let chips_el = slots.chips.unwrap_or_else(|| rest_chips(k, v.site, 0));
    let page_el = slots
        .page
        .unwrap_or_else(|| page(ck, &NOTES, TOOLBAR_H, card.w, None));
    let crumb_el = slots
        .crumb
        .unwrap_or_else(|| Some(crumb(k, tab(0), &look.plain).into_any_element()));
    let _ = custom;
    fill()
        .child(backdrop(look))
        .child(lights(k, 25.0 + lights_dx, LIGHTS_TOOLBAR + lights_dy))
        .child(
            fill()
                .opacity(1.0 - v.lay)
                .left(px(lerp(v.lay, 0.0, -60.0) * s))
                .child(
                    nav_icons(
                        k,
                        look.t.icon,
                        &SIDEBAR_ICONS,
                        LIGHTS_FIELD,
                        &["sidebar.left", "chevron.left", "chevron.right"],
                    )
                    .opacity(v.addr),
                )
                .child(
                    fill()
                        .top(px(lerp(v.addr, 0.0, ROW_TOP_WITH_FIELD - ROW_TOP) * s))
                        .child(rows_el),
                )
                .child(
                    div()
                        .absolute()
                        .left(px((crumb_left - FIELD_CRUMB.x) * s))
                        .top(px((crumb_top - FIELD_CRUMB.y) * s))
                        .w(px(lerp(v.addr, 320.0, FIELD.w) * s))
                        .h(px(FIELD.h * s))
                        .rounded(px(radius::CHROME * s))
                        .bg(c(look.t.pinned_resting))
                        .opacity(v.addr),
                ),
        )
        .child(
            fill()
                .opacity(v.lay)
                .top(px(lerp(v.lay, -8.0, 0.0) * s))
                .child(chips_el),
        )
        .child(
            at(g, card.x, card.y, card.w, card.h)
                .rounded(px(card_radius(frame) * s))
                .bg(c(look.page))
                .border(px(0.5))
                .border_color(c(look.t.card_edge))
                .overflow_hidden()
                .child(
                    fill()
                        .top(px(lerp(v.addr, 0.0, -TOOLBAR_H) * s))
                        .child(page_el),
                )
                .child(
                    toolbar_band(
                        ck,
                        TOOLBAR_H,
                        Some(look.card),
                        Some((look.plain.divider, 1.0 - v.site)),
                    )
                    .opacity(1.0 - v.addr)
                    .child(site_band(look, v.site))
                    .child(
                        nav_icons(
                            ck,
                            look.plain.icon,
                            &TOOLBAR_ICONS,
                            21.2,
                            &[
                                "sidebar.left",
                                "chevron.left",
                                "chevron.right",
                                "arrow.clockwise",
                            ],
                        )
                        .opacity(1.0 - v.lay),
                    )
                    .child(
                        nav_icons(
                            ck,
                            look.plain.icon,
                            &[21.0, 56.0, 92.0],
                            21.2,
                            &["chevron.left", "chevron.right", "arrow.clockwise"],
                        )
                        .opacity(v.lay),
                    ),
                )
                .children(slots.card),
        )
        .child(
            div()
                .absolute()
                .left(px(crumb_left * s))
                .top(px(crumb_top * s))
                .w(px(lerp(v.addr, 300.0, FIELD_CRUMB.w) * s))
                .h(px(FIELD_CRUMB.h * s))
                .overflow_hidden()
                .children(crumb_el),
        )
        .children(slots.over)
        .into_any_element()
}

fn rest(k: Kit, opts: &SceneOpts, site: Option<f32>, slots: Slots) -> AnyElement {
    let v = Values {
        lay: if opts.top { 1.0 } else { 0.0 },
        addr: if opts.address_in_sidebar { 1.0 } else { 0.0 },
        site: site.unwrap_or(if opts.site_color { 1.0 } else { 0.0 }),
    };
    window_state(k, &v, opts.frame, slots, false)
}

fn card_of(g: Geo, opts: &SceneOpts) -> Rect {
    rest_card(g, opts.top, opts.frame)
}

fn tab_count(g: Geo, opts: &SceneOpts) -> usize {
    if opts.top {
        rest_chip_count(g)
    } else {
        rest_row_count(g)
    }
}

fn pitch_of(opts: &SceneOpts) -> f32 {
    if opts.top { CHIP_STEP } else { ROW_PITCH }
}

fn tabs_slot(opts: &SceneOpts, node: AnyElement) -> Slots {
    if opts.top {
        Slots {
            chips: Some(node),
            ..Slots::default()
        }
    } else {
        Slots {
            rows: Some(node),
            ..Slots::default()
        }
    }
}

fn list_item(
    k: Kit,
    opts: &SceneOpts,
    t: Tab,
    i: usize,
    lit: Option<f32>,
    selected: bool,
    fx: Fx,
) -> AnyElement {
    if opts.top {
        return tab_row(
            k,
            t,
            chip_x(i),
            CHIP_TOP - 1.0,
            CHIP_W,
            false,
            None,
            false,
            fx,
        );
    }
    tab_row(
        k,
        t,
        ROW_X,
        row_y(i, ROW_TOP),
        ROW_W,
        selected,
        lit,
        false,
        fx,
    )
}

fn selected(k: Kit, opts: &SceneOpts, i: usize, fx: Fx) -> AnyElement {
    let s = k.g.s;
    if opts.top {
        return top_tab_plate(k, chip_x(i), if opts.site_color { 1.0 } else { 0.0 }, fx);
    }
    fx.apply(highlight(
        k,
        ROW_X + fx.dx / s,
        row_y(i, ROW_TOP) + fx.dy / s,
        ROW_W,
        ROW_H,
    ))
    .into_any_element()
}

fn new_tab_row(k: Kit, opts: &SceneOpts, i: usize, fx: Fx) -> Option<AnyElement> {
    (!opts.top).then(|| {
        tab_row(
            k,
            NEW_TAB,
            ROW_X,
            row_y(i, ROW_TOP),
            ROW_W,
            false,
            None,
            false,
            fx,
        )
    })
}

fn keycap(k: Kit, x: f32, y: f32, label: &str, opacity: f32, scale: f32) -> AnyElement {
    let t = &k.look.t;
    let s = k.g.s * scale;
    div()
        .absolute()
        .right(px((k.g.w - x) * k.g.s))
        .top(px(y * k.g.s))
        .opacity(opacity.clamp(0.0, 1.0))
        .child(
            div()
                .min_w(px(38.0 * s))
                .h(px(24.0 * s))
                .px(px(space::M * s))
                .rounded(px(radius::CONTROL * s))
                .bg(c(t.control))
                .border(px(1.0))
                .border_color(c(t.control_border))
                .flex()
                .items_center()
                .justify_center()
                .font_family(UI_FONT)
                .text_size(px(SMALL * s))
                .font_weight(FontWeight::MEDIUM)
                .text_color(c(t.text_primary))
                .child(SharedString::from(label.to_owned())),
        )
        .into_any_element()
}

fn key_press(k: Kit, t: &Tracker, label: &str, ms: f32, back: f32) -> AnyElement {
    let opacity = t.pulse(ms, back, 160.0, 200.0);
    let scale = t.t(&[
        (ms, 0.82),
        (ms + 260.0, 1.0),
        (back, 1.0),
        (back + 200.0, 0.92),
    ]);
    keycap(k, k.g.w - 22.0, k.g.h - 50.0, label, opacity, scale)
}

fn crumb_swap(k: Kit, t: &Tracker, a: Tab, b: Tab, ms: f32, back: f32) -> AnyElement {
    let s = k.g.s;
    let (leave, arrive, slide) = (120.0, 200.0, 8.0);
    let first_o = t.t(&[
        (ms, 1.0),
        (ms + leave, 0.0),
        (back + leave, 0.0),
        (back + leave + arrive, 1.0),
    ]);
    let first_x = t.t(&[
        (ms, 0.0),
        (ms + leave, -slide),
        (back + leave, slide),
        (back + leave + arrive, 0.0),
    ]);
    let second_o = t.t(&[
        (ms + leave, 0.0),
        (ms + leave + arrive, 1.0),
        (back, 1.0),
        (back + leave, 0.0),
    ]);
    let second_x = t.t(&[
        (ms + leave, slide),
        (ms + leave + arrive, 0.0),
        (back, 0.0),
        (back + leave, -slide),
        (back + leave + arrive, slide),
    ]);
    fill()
        .child(
            fill()
                .left(px(first_x * s))
                .opacity(first_o)
                .child(crumb(k, a, &k.look.plain)),
        )
        .child(
            fill()
                .left(px(second_x * s))
                .opacity(second_o)
                .child(crumb(k, b, &k.look.plain)),
        )
        .into_any_element()
}

fn page_swap(
    k: Kit,
    t: &Tracker,
    ms: f32,
    back: f32,
    a: &Article,
    b: &Article,
    width: f32,
) -> AnyElement {
    fill()
        .child(page(k, a, TOOLBAR_H, width, None))
        .child(
            fill()
                .opacity(t.pulse(ms, back, 280.0, 280.0))
                .child(page(k, b, TOOLBAR_H, width, None)),
        )
        .into_any_element()
}

fn mock_surface(
    k: Kit,
    rad: f32,
    opacity: (f32, f32),
    blur: f32,
    y: f32,
    fill_color: Option<RgbaColor>,
    edge: Option<RgbaColor>,
) -> Div {
    let s = k.g.s;
    let t = &k.look.t;
    let o = if k.look.dark { opacity.0 } else { opacity.1 };
    div()
        .rounded(px(rad * s))
        .bg(c(fill_color.unwrap_or(t.panel)))
        .border(px(0.5))
        .border_color(c(edge.unwrap_or(t.panel_border)))
        .shadow(vec![shadow(c(RgbaColor::black(o)), y * s, blur * s)])
}

fn dialog_shadow(k: Kit) -> (f32, f32) {
    let _ = k;
    (
        ardia_theme::DARK.panel_shadow_opacity,
        ardia_theme::LIGHT.panel_shadow_opacity,
    )
}

fn panel(k: Kit, rect: Rect, rad: f32, children: Vec<AnyElement>, opacity: f32) -> AnyElement {
    scaled_panel(k, rect, [1.0, 1.0], rad, children, opacity)
}

fn scaled_panel(
    k: Kit,
    rect: Rect,
    scale: [f32; 2],
    rad: f32,
    children: Vec<AnyElement>,
    opacity: f32,
) -> AnyElement {
    let s = k.g.s;
    at(k.g, rect.x, rect.y, rect.w, rect.h)
        .when(
            (scale[0] - 1.0).abs() > 1e-5 || (scale[1] - 1.0).abs() > 1e-5,
            |this| this.scale_xy(scale[0], scale[1]),
        )
        .opacity(opacity.clamp(0.0, 1.0))
        .child(
            mock_surface(k, rad, dialog_shadow(k), 24.0, 10.0, None, None)
                .absolute()
                .inset_0(),
        )
        .child(
            fill()
                .rounded(px(rad * s))
                .overflow_hidden()
                .flex()
                .flex_col()
                .children(children),
        )
        .into_any_element()
}

fn input_row(k: Kit, height: f32, children: Vec<AnyElement>) -> AnyElement {
    let s = k.g.s;
    div()
        .h(px(height * s))
        .flex_none()
        .flex()
        .flex_row()
        .items_center()
        .pl(px(space::XL * s))
        .pr(px(space::L * s))
        .gap(px(space::ML * s))
        .child(k.glyph(
            "magnifyingglass",
            15.0,
            k.look.t.text_primary,
            SymbolWeight::Medium,
            18.0,
        ))
        .child(
            div()
                .flex_1()
                .flex()
                .flex_row()
                .items_center()
                .children(children),
        )
        .into_any_element()
}

fn divider(k: Kit) -> AnyElement {
    div()
        .h(px(0.5))
        .mx(px(space::XL * k.g.s))
        .bg(c(k.look.t.divider))
        .into_any_element()
}

fn suggestion_row(k: Kit, sg: &Suggestion, sel: bool, opacity: f32, dy: f32) -> AnyElement {
    let s = k.g.s;
    let t = &k.look.t;
    div()
        .h(px(SUGGESTION_H * s))
        .mt(px(dy))
        .rounded(px(radius::TILE * s))
        .px(px(SUGGESTION_PAD_X * s))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(SUGGESTION_GAP * s))
        .opacity(opacity.clamp(0.0, 1.0))
        .when(sel, |this| this.bg(c(t.command_bar_selected)))
        .child(match sg.fav {
            Some(f) => favicon(k, f, 16.0),
            None => k.glyph(
                sg.icon.unwrap_or("magnifyingglass"),
                SUGGESTION_ICON,
                t.text_secondary,
                SymbolWeight::Medium,
                SUGGESTION_ICON_BOX,
            ),
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_row()
                .items_center()
                .child(k.label(TITLE, t.text_primary, FontWeight::NORMAL, sg.title))
                .children(sg.detail.map(|d| {
                    k.label(TITLE, t.text_tertiary, FontWeight::NORMAL, format!("  {d}"))
                })),
        )
        .children(
            sg.hint
                .map(|h| k.label(SMALL, t.text_tertiary, FontWeight::NORMAL, h)),
        )
        .into_any_element()
}

fn suggestion_list(k: Kit, t: &Tracker, rows: &[Suggestion], ms: f32) -> AnyElement {
    let s = k.g.s;
    div()
        .px(px(SUGGESTION_LIST_X * s))
        .pt(px(space::XS * s))
        .children(rows.iter().enumerate().map(|(i, sg)| {
            let at_ms = ms + i as f32 * 50.0;
            suggestion_row(
                k,
                sg,
                i == 0,
                t.fade_in(at_ms, 200.0),
                t.t(&[(at_ms, -3.0 * s), (at_ms + 220.0, 0.0)]),
            )
        }))
        .into_any_element()
}

fn selected_url(k: Kit) -> AnyElement {
    div()
        .flex_shrink(1.)
        .rounded(px(radius::HAIR * k.g.s))
        .bg(c(k.look.t.selection))
        .child(k.label(
            TITLE,
            k.look.t.text_primary,
            FontWeight::NORMAL,
            "fieldnotes.blog/coast-trail",
        ))
        .into_any_element()
}

fn centred_frame(g: Geo, opts: &SceneOpts) -> Rect {
    let card = card_of(g, opts);
    let content = if card.w < 708.0 {
        if card.w <= 636.0 {
            card.w - 20.0
        } else {
            616.0
        }
    } else {
        652.0
    };
    let w = content.min(card.w - 28.0).min(560.0);
    Rect::new(
        card.x + (card.w - w) / 2.0,
        card.y + 12.0f32.max((card.h * 0.22).round()),
        w,
        PANEL_H,
    )
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct GrowTrip {
    rect: Rect,
    scale: [f32; 2],
    opacity: f32,
}

fn grow_trip(t: &Tracker, from: Rect, to: Rect, ms: f32, back: f32, dur: f32) -> GrowTrip {
    let sx = from.w / to.w.max(1e-3);
    let sy = from.h / to.h.max(1e-3);
    let dx = from.x - to.x - (to.w * (1.0 - sx)) / 2.0;
    let dy = from.y - to.y - (to.h * (1.0 - sy)) / 2.0;
    let opacity = t.t(&[
        (ms, 0.0),
        (ms + 90.0, 1.0),
        (back + dur - 90.0, 1.0),
        (back + dur, 0.0),
    ]);
    GrowTrip {
        rect: Rect::new(
            to.x + t.trip(dx, 0.0, ms, back, dur, dur),
            to.y + t.trip(dy, 0.0, ms, back, dur, dur),
            to.w,
            to.h,
        ),
        scale: [
            t.trip(sx, 1.0, ms, back, dur, dur),
            t.trip(sy, 1.0, ms, back, dur, dur),
        ],
        opacity,
    }
}

fn drop_rect<'a>(t: &Tracker, k: Kit<'a>, rect: Rect, ms: f32, back: f32) -> (Kit<'a>, Rect, f32) {
    let opacity = t.pulse(ms, back, 200.0, 220.0);
    let dy = t.trip(-10.0, 0.0, ms, back, 300.0, 220.0);
    let scale = t.trip(0.97, 1.0, ms, back, 300.0, 220.0);
    let w = rect.w * scale;
    let h = rect.h * scale;
    (
        k,
        Rect::new(
            rect.x + (rect.w - w) / 2.0,
            rect.y + (rect.h - h) / 2.0 + dy,
            w,
            h,
        ),
        opacity,
    )
}

fn scene(id: PreviewId, k: Kit, phase: f32, opts: &SceneOpts) -> AnyElement {
    let t = Tracker::new(phase, id.duration_ms(), 0.0);
    match id {
        PreviewId::TabsSidebar
        | PreviewId::TabsTop
        | PreviewId::AddressToolbar
        | PreviewId::AddressSidebar => tab_switch(k, &t, opts),
        PreviewId::CmdlField => cmdl_field(k, &t, opts),
        PreviewId::CmdlCentred => cmdl_centred(k, &t, opts, false),
        PreviewId::NewtabCommandbar => cmdl_centred(k, &t, opts, true),
        PreviewId::NewtabPage => new_tab_opens_page(k, &t, opts),
        PreviewId::NewtabposBottom => new_tab_at(k, &t, opts, None),
        PreviewId::NewtabposTop => new_tab_at(k, &t, opts, Some(0)),
        PreviewId::NewtabposNext => new_tab_at(k, &t, opts, Some(1)),
        PreviewId::CtrltabStep => ctrl_tab_step(k, &t, opts),
        PreviewId::CtrltabSwitcher => ctrl_tab_switcher(k, &t, opts),
        PreviewId::TidyKeep => tidy(k, &t, opts, false),
        PreviewId::TidyAuto => tidy(k, &t, opts, true),
        PreviewId::QuitRestore => quit(k, &t, opts, false),
        PreviewId::QuitFresh => quit(k, &t, opts, true),
        PreviewId::WindowsSeparate => windows(k, &t, opts, false),
        PreviewId::WindowsShared => windows(k, &t, opts, true),
        PreviewId::AppearanceAuto => appearance(k, &t, opts, None),
        PreviewId::AppearanceLight => appearance(k, &t, opts, Some(false)),
        PreviewId::AppearanceDark => appearance(k, &t, opts, Some(true)),
        PreviewId::StyleGlass | PreviewId::StyleClassic => rest(k, opts, None, Slots::default()),
        PreviewId::SitecolorOn => site_color(k, &t, opts, true),
        PreviewId::SitecolorOff => site_color(k, &t, opts, false),
        PreviewId::BlockOn => block(k, &t, opts, true),
        PreviewId::BlockOff => block(k, &t, opts, false),
        PreviewId::LinksLittle => links(k, phase, opts, true),
        PreviewId::LinksTab => links(k, phase, opts, false),
    }
}

fn tab_switch(k: Kit, t: &Tracker, opts: &SceneOpts) -> AnyElement {
    const GO: f32 = 420.0;
    const BACK: f32 = 1760.0;
    const TO: usize = 2;
    let g = k.g;
    let n = tab_count(g, opts);
    let mv = t.trip(
        0.0,
        TO as f32 * pitch_of(opts) * g.s,
        GO,
        BACK,
        300.0,
        320.0,
    );
    let lit = |i: usize| match i {
        0 => Some(t.trip(1.0, 0.0, GO, BACK, 300.0, 320.0)),
        TO => Some(t.pulse(GO, BACK, 300.0, 320.0)),
        _ => None,
    };
    let list = fill()
        .child(selected(k, opts, 0, Fx::along(opts.top, mv)))
        .children((0..n).map(|i| list_item(k, opts, tab(i), i, lit(i), false, Fx::default())))
        .children(new_tab_row(k, opts, n, Fx::default()))
        .into_any_element();
    let cw = card_of(g, opts).w;
    let ck = Kit {
        g: Geo { w: cw, ..g },
        ..k
    };
    let mut slots = tabs_slot(opts, list);
    slots.crumb = Some(Some(crumb_swap(k, t, tab(0), tab(TO), GO + 40.0, BACK)));
    slots.page = Some(page_swap(ck, t, GO + 80.0, BACK, &NOTES, &TRIP, cw));
    rest(k, opts, None, slots)
}

fn field_panel(g: Geo, opts: &SceneOpts) -> (Rect, Rect) {
    if opts.address_in_sidebar {
        return (
            FIELD,
            Rect::new(
                FIELD.x,
                FIELD.y,
                FIELD.w + 137.0,
                40.0 + 3.0 * SUGGESTION_H + 14.0,
            ),
        );
    }
    let card = card_of(g, opts);
    let crumb_x = if opts.top { 118.0 } else { CRUMB_X };
    let top = if opts.top { STRIP_H } else { card.y };
    (
        Rect::new(card.x + crumb_x - 8.0, top + 6.0, 300.0, 30.0),
        Rect::new(
            card.x + crumb_x - 40.0,
            top + 0.5,
            480.0f32.min(card.w - crumb_x + 28.0),
            PANEL_H,
        ),
    )
}

const OPEN: f32 = 380.0;
const CLOSE: f32 = 1900.0;

fn cmdl_field(k: Kit, t: &Tracker, opts: &SceneOpts) -> AnyElement {
    let (from, to) = field_panel(k.g, opts);
    let field = opts.address_in_sidebar;
    let trip = grow_trip(t, from, to, OPEN, CLOSE, 260.0);
    let over = fill()
        .child(scaled_panel(
            k,
            trip.rect,
            trip.scale,
            if field { radius::PANEL } else { radius::HERO },
            vec![
                input_row(k, if field { 40.0 } else { 52.0 }, vec![selected_url(k)]),
                divider(k),
                suggestion_list(k, t, &CURRENT, OPEN + 160.0),
            ],
            trip.opacity,
        ))
        .child(key_press(k, t, "⌘L", OPEN - 240.0, CLOSE))
        .into_any_element();
    rest(
        k,
        opts,
        None,
        Slots {
            over: Some(over),
            ..Slots::default()
        },
    )
}

fn cmdl_centred(k: Kit, t: &Tracker, opts: &SceneOpts, fresh: bool) -> AnyElement {
    let (pk, rect, opacity) = drop_rect(t, k, centred_frame(k.g, opts), OPEN, CLOSE);
    let field: Vec<AnyElement> = if fresh {
        vec![
            div()
                .w(px(1.2 * k.g.s))
                .h(px(17.0 * k.g.s))
                .mr(px(space::XXS * k.g.s))
                .rounded(px(0.6 * k.g.s))
                .bg(c(k.look.t.accent))
                .into_any_element(),
            k.label(
                TITLE,
                k.look.t.placeholder,
                FontWeight::NORMAL,
                "Search or enter address",
            )
            .into_any_element(),
        ]
    } else {
        vec![selected_url(k)]
    };
    let over = fill()
        .child(panel(
            pk,
            rect,
            radius::HERO,
            vec![
                input_row(pk, 52.0, field),
                divider(pk),
                suggestion_list(pk, t, if fresh { &FRESH } else { &CURRENT }, OPEN + 160.0),
            ],
            opacity,
        ))
        .child(key_press(
            k,
            t,
            if fresh { "⌘T" } else { "⌘L" },
            OPEN - 240.0,
            CLOSE,
        ))
        .into_any_element();
    rest(
        k,
        opts,
        None,
        Slots {
            over: Some(over),
            ..Slots::default()
        },
    )
}

fn end_slot(g: Geo, opts: &SceneOpts) -> usize {
    if opts.top {
        tab_count(g, opts) - 1
    } else {
        tab_count(g, opts)
    }
}

fn inserted_list(
    k: Kit,
    t: &Tracker,
    opts: &SceneOpts,
    at_slot: usize,
    ms: f32,
    back: f32,
) -> AnyElement {
    let g = k.g;
    let n = tab_count(g, opts);
    let step = pitch_of(opts) * g.s;
    let push = t.trip(0.0, step, ms, back + 80.0, 300.0, 300.0);
    let arrive = t.pulse(ms + 100.0, back, 240.0, 200.0);
    let enter = if opts.top {
        Fx {
            dy: t.trip(-8.0 * g.s, 0.0, ms + 100.0, back, 300.0, 200.0),
            ..Fx::default()
        }
    } else {
        Fx {
            dx: t.trip(-12.0 * g.s, 0.0, ms + 100.0, back, 300.0, 200.0),
            ..Fx::default()
        }
    };
    let old_selected = t.trip(1.0, 0.0, ms + 100.0, back, 220.0, 220.0);
    let pushed_out = |i: usize| {
        if opts.top && i + 1 >= n {
            Fx::fade(t.trip(1.0, 0.0, ms, back + 80.0, 300.0, 300.0))
        } else {
            Fx::default()
        }
    };
    fill()
        .child(selected(
            k,
            opts,
            0,
            Fx::fade(old_selected).and(if at_slot == 0 {
                Fx::along(opts.top, push)
            } else {
                Fx::default()
            }),
        ))
        .child(selected(k, opts, at_slot, Fx::fade(arrive).and(enter)))
        .children((0..n).map(|i| {
            let fx = if i >= at_slot {
                Fx::along(opts.top, push)
            } else {
                Fx::default()
            };
            list_item(
                k,
                opts,
                tab(i),
                i,
                (i == 0).then_some(old_selected),
                false,
                fx.and(pushed_out(i)),
            )
        }))
        .child(list_item(
            k,
            opts,
            BLANK,
            at_slot,
            Some(arrive),
            false,
            Fx::fade(arrive).and(enter),
        ))
        .children(new_tab_row(k, opts, n, Fx::along(opts.top, push)))
        .into_any_element()
}

fn fading_crumb(k: Kit, t: &Tracker, ms: f32, back: f32) -> AnyElement {
    fill()
        .opacity(t.trip(1.0, 0.0, ms, back, 160.0, 240.0))
        .child(crumb(k, tab(0), &k.look.plain))
        .into_any_element()
}

fn new_tab_opens_page(k: Kit, t: &Tracker, opts: &SceneOpts) -> AnyElement {
    let cw = card_of(k.g, opts).w;
    let ck = Kit {
        g: Geo { w: cw, ..k.g },
        ..k
    };
    let mut slots = tabs_slot(
        opts,
        inserted_list(k, t, opts, end_slot(k.g, opts), OPEN, CLOSE),
    );
    slots.crumb = Some(Some(fading_crumb(k, t, OPEN + 100.0, CLOSE)));
    slots.page = Some(
        fill()
            .child(page(ck, &NOTES, TOOLBAR_H, cw, None))
            .child(
                fill()
                    .opacity(t.pulse(OPEN + 160.0, CLOSE, 300.0, 240.0))
                    .child(new_tab_page(ck, TOOLBAR_H, cw)),
            )
            .into_any_element(),
    );
    slots.over = Some(key_press(k, t, "⌘T", OPEN - 240.0, CLOSE));
    rest(k, opts, None, slots)
}

fn new_tab_at(k: Kit, t: &Tracker, opts: &SceneOpts, slot: Option<usize>) -> AnyElement {
    let at_slot = slot.unwrap_or_else(|| end_slot(k.g, opts));
    let back = CLOSE - 300.0;
    let mut slots = tabs_slot(opts, inserted_list(k, t, opts, at_slot, OPEN, back));
    slots.crumb = Some(Some(fading_crumb(k, t, OPEN + 100.0, back)));
    slots.over = Some(key_press(k, t, "⌘T", OPEN - 240.0, back));
    rest(k, opts, None, slots)
}

const SWITCH_BACK: f32 = 2100.0;

fn switching_window(
    k: Kit,
    t: &Tracker,
    opts: &SceneOpts,
    stops: &[(f32, f32)],
    lit: &dyn Fn(usize) -> Option<f32>,
    crumb_el: AnyElement,
    page_at: f32,
) -> AnyElement {
    let g = k.g;
    let n = tab_count(g, opts);
    let pitch = pitch_of(opts) * g.s;
    let moved: Vec<(f32, f32)> = stops.iter().map(|(ms, i)| (*ms, i * pitch)).collect();
    let list = fill()
        .child(selected(k, opts, 0, Fx::along(opts.top, t.t(&moved))))
        .children((0..n).map(|i| list_item(k, opts, tab(i), i, lit(i), false, Fx::default())))
        .children(new_tab_row(k, opts, n, Fx::default()))
        .into_any_element();
    let cw = card_of(g, opts).w;
    let ck = Kit {
        g: Geo { w: cw, ..g },
        ..k
    };
    let mut slots = tabs_slot(opts, list);
    slots.crumb = Some(Some(crumb_el));
    slots.page = Some(page_swap(ck, t, page_at, SWITCH_BACK, &NOTES, &TRIP, cw));
    rest(k, opts, None, slots)
}

fn ctrl_tab_step(k: Kit, t: &Tracker, opts: &SceneOpts) -> AnyElement {
    let first = 420.0;
    let second = 860.0;
    let lit = |i: usize| match i {
        0 => Some(t.trip(1.0, 0.0, first, SWITCH_BACK, 180.0, 320.0)),
        1 => Some(t.t(&[
            (first, 0.0),
            (first + 180.0, 1.0),
            (second, 1.0),
            (second + 180.0, 0.0),
        ])),
        2 => Some(t.pulse(second, SWITCH_BACK, 180.0, 320.0)),
        _ => None,
    };
    let crumb_at = |tb: Tab, stops: &[(f32, f32)]| {
        fill()
            .opacity(t.t(stops))
            .child(crumb(k, tb, &k.look.plain))
    };
    let crumbs = fill()
        .child(crumb_at(
            tab(0),
            &[
                (first, 1.0),
                (first + 120.0, 0.0),
                (SWITCH_BACK + 120.0, 0.0),
                (SWITCH_BACK + 320.0, 1.0),
            ],
        ))
        .child(crumb_at(
            tab(1),
            &[
                (first + 120.0, 0.0),
                (first + 300.0, 1.0),
                (second, 1.0),
                (second + 120.0, 0.0),
            ],
        ))
        .child(crumb_at(
            tab(2),
            &[
                (second + 120.0, 0.0),
                (second + 300.0, 1.0),
                (SWITCH_BACK, 1.0),
                (SWITCH_BACK + 120.0, 0.0),
            ],
        ))
        .into_any_element();
    let window = switching_window(
        k,
        t,
        opts,
        &[
            (first, 0.0),
            (first + 180.0, 1.0),
            (second, 1.0),
            (second + 180.0, 2.0),
            (SWITCH_BACK, 2.0),
            (SWITCH_BACK + 320.0, 0.0),
        ],
        &lit,
        crumbs,
        second + 40.0,
    );
    let key_scale = t.t(&[
        (first - 200.0, 0.82),
        (first, 1.0),
        (second - 80.0, 1.0),
        (second - 20.0, 0.92),
        (second + 80.0, 1.0),
    ]);
    fill()
        .child(window)
        .child(keycap(
            k,
            k.g.w - 22.0,
            k.g.h - 50.0,
            "⌃Tab",
            t.pulse(first - 200.0, second + 400.0, 160.0, 200.0),
            key_scale,
        ))
        .into_any_element()
}

fn ctrl_tab_switcher(k: Kit, t: &Tracker, opts: &SceneOpts) -> AnyElement {
    let shown = 320.0;
    let released = 1080.0;
    let lit = |i: usize| match i {
        0 => Some(t.trip(1.0, 0.0, released, SWITCH_BACK, 1.0, 320.0)),
        2 => Some(t.pulse(released, SWITCH_BACK, 1.0, 320.0)),
        _ => None,
    };
    let window = switching_window(
        k,
        t,
        opts,
        &[
            (released, 0.0),
            (released + 1.0, 2.0),
            (SWITCH_BACK, 2.0),
            (SWITCH_BACK + 320.0, 0.0),
        ],
        &lit,
        crumb_swap(k, t, tab(0), tab(2), released, SWITCH_BACK),
        released,
    );
    fill()
        .child(window)
        .child(switcher(
            k,
            opts.accent,
            t.t(&[
                (shown, 0.0),
                (shown + 120.0, 1.0),
                (released, 1.0),
                (released + 120.0, 0.0),
            ]),
        ))
        .child(keycap(
            k,
            k.g.w - 22.0,
            k.g.h - 50.0,
            "⌃Tab",
            t.pulse(shown - 200.0, released, 160.0, 160.0),
            1.0,
        ))
        .into_any_element()
}

fn switcher(k: Kit, accent: RgbaColor, opacity: f32) -> AnyElement {
    const CARD: f32 = 124.0;
    const SHOT: f32 = 76.0;
    const LABEL: f32 = 24.0;
    let recent = [tab(0), tab(2), tab(1), tab(3)];
    let s = k.g.s;
    let w = 2.0 * space::M + recent.len() as f32 * CARD + (recent.len() as f32 - 1.0) * space::XS;
    let h = 2.0 * space::M + 2.0 * space::XS + SHOT + LABEL;
    let rect = Rect::new((k.g.w - w) / 2.0, (k.g.h - h) / 2.0, w, h);
    let cards = div()
        .flex()
        .flex_row()
        .p(px(space::M * s))
        .gap(px(space::XS * s))
        .children(recent.iter().enumerate().map(|(i, tb)| {
            let focused = i == 1;
            div()
                .w(px(CARD * s))
                .p(px(space::XS * s))
                .rounded(px(radius::PANEL * s))
                .when(focused, |this| this.bg(c(k.look.t.command_bar_selected)))
                .child(
                    div()
                        .h(px(SHOT * s))
                        .rounded(px(radius::TILE * s))
                        .bg(c(k.look.page))
                        .border(px(if focused { 2.0 * s } else { (1.0 * s).max(0.5) }))
                        .border_color(c(if focused { accent } else { k.look.t.divider }))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(favicon(k, *tb, 22.0)),
                )
                .child(
                    div()
                        .h(px(LABEL * s))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(space::S * s))
                        .px(px(space::XXS * s))
                        .child(favicon(k, *tb, 12.0))
                        .child(div().flex_1().min_w_0().child(k.label(
                            SMALL,
                            k.look.t.text_primary,
                            FontWeight::SEMIBOLD,
                            tb.title,
                        ))),
                )
        }))
        .into_any_element();
    panel(k, rect, radius::SHEET, vec![cards], opacity)
}

#[allow(clippy::too_many_arguments)]
fn pill(
    k: Kit,
    left: Option<f32>,
    right: Option<f32>,
    top: Option<f32>,
    bottom: Option<f32>,
    opacity: f32,
    dy: f32,
    children: Vec<AnyElement>,
) -> AnyElement {
    let s = k.g.s;
    let pos = div()
        .absolute()
        .when_some(left, |this, v| this.left(px(v)))
        .when_some(right, |this, v| this.right(px(v)))
        .when_some(top, |this, v| this.top(px(v + dy)))
        .when_some(bottom, |this, v| this.bottom(px(v - dy)))
        .opacity(opacity.clamp(0.0, 1.0));
    pos.child(
        mock_surface(k, PILL_H / 2.0, (0.45, 0.16), 18.0, 8.0, None, None)
            .h(px(PILL_H * s))
            .px(px(space::L * s))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(space::M * s))
            .children(children),
    )
    .into_any_element()
}

fn tidy(k: Kit, t: &Tracker, opts: &SceneOpts, auto: bool) -> AnyElement {
    const STALE: [usize; 3] = [1, 3, 4];
    let g = k.g;
    let s = g.s;
    let card = card_of(g, opts);
    let n = tab_count(g, opts);
    let pitch = pitch_of(opts) * s;
    let back = 2500.0;
    let stale = |i: usize| STALE.contains(&i) && i < n;
    let above = |i: usize| STALE.iter().filter(|o| **o < i && **o < n).count();
    let gone = if auto {
        Fx {
            opacity: Some(t.t(&[
                (850.0, 1.0),
                (1000.0, 0.4),
                (1060.0, 0.4),
                (1300.0, 0.0),
                (back, 0.0),
                (back + 400.0, 1.0),
            ])),
            scale: Some(t.t(&[
                (1060.0, 1.0),
                (1300.0, 0.92),
                (back, 0.92),
                (back + 400.0, 1.0),
            ])),
            ..Fx::default()
        }
    } else {
        Fx::default()
    };
    let rise = |kk: usize| {
        if auto && kk > 0 {
            let v = -(kk as f32) * pitch;
            Fx::along(
                opts.top,
                t.t(&[(1140.0, 0.0), (1460.0, v), (back, v), (back + 400.0, 0.0)]),
            )
        } else {
            Fx::default()
        }
    };
    let list = fill()
        .children(opts.top.then(|| selected(k, opts, 0, Fx::default())))
        .children((0..n).map(|i| {
            list_item(
                k,
                opts,
                tab(i),
                i,
                None,
                i == 0,
                if stale(i) { gone } else { rise(above(i)) },
            )
        }))
        .children(new_tab_row(k, opts, n, rise(above(n))))
        .into_any_element();
    let mut slots = tabs_slot(opts, list);
    slots.over = Some(pill(
        k,
        None,
        Some((g.w - card.x - card.w + 16.0) * s),
        Some((card.y + 54.0) * s),
        None,
        t.pulse(120.0, back + 200.0, 220.0, 260.0),
        t.trip(-6.0 * s, 0.0, 120.0, back + 200.0, 280.0, 260.0),
        vec![
            k.turning_glyph(
                "clock",
                13.0,
                k.look.t.text_primary,
                SymbolWeight::Medium,
                16.0,
                t.t(&[(200.0, 0.0), (900.0, 360.0)]),
            ),
            k.label(
                BODY,
                k.look.t.text_primary,
                FontWeight::MEDIUM,
                "12 hours later",
            )
            .into_any_element(),
        ],
    ));
    rest(k, opts, None, slots)
}

fn quit(k: Kit, t: &Tracker, opts: &SceneOpts, fresh: bool) -> AnyElement {
    let card = card_of(k.g, opts);
    let leave = 360.0;
    let arrive = 900.0;
    let leave_again = 2100.0;
    let return_at = if fresh { 2600.0 } else { arrive };
    let window_o = t.t(&[
        (leave, 1.0),
        (leave + 240.0, 0.0),
        (return_at, 0.0),
        (return_at + 320.0, 1.0),
    ]);
    let window_s = t.t(&[
        (leave, 1.0),
        (leave + 240.0, 0.97),
        (return_at, 0.97),
        (return_at + 320.0, 1.0),
    ]);
    let blank_o = t.t(&[
        (arrive, 0.0),
        (arrive + 320.0, 1.0),
        (leave_again, 1.0),
        (leave_again + 240.0, 0.0),
    ]);
    let blank_s = t.t(&[
        (arrive, 0.97),
        (arrive + 320.0, 1.0),
        (leave_again, 1.0),
        (leave_again + 240.0, 0.97),
    ]);
    let scaled = |scale: f32, opacity: f32, body: AnyElement| {
        centred_scale(k.g, scale)
            .opacity(opacity.clamp(0.0, 1.0))
            .child(body)
            .into_any_element()
    };
    let mut out = fill().child(backdrop(k.look)).child(scaled(
        window_s,
        window_o,
        rest(k.scaled(window_s), opts, None, Slots::default()),
    ));
    if fresh {
        let bk = k.scaled(blank_s);
        let ck = Kit {
            g: Geo { w: card.w, ..bk.g },
            ..bk
        };
        let list = fill()
            .children(opts.top.then(|| selected(bk, opts, 0, Fx::default())))
            .child(list_item(bk, opts, BLANK, 0, None, true, Fx::default()))
            .children(new_tab_row(bk, opts, 1, Fx::default()))
            .into_any_element();
        let mut slots = tabs_slot(opts, list);
        slots.crumb = Some(None);
        slots.page = Some(new_tab_page(ck, TOOLBAR_H, card.w));
        out = out.child(scaled(blank_s, blank_o, rest(bk, opts, None, slots)));
    }
    out.child(key_press(k, t, "⌘Q", leave - 260.0, leave + 300.0))
        .into_any_element()
}

fn centred_scale(g: Geo, scale: f32) -> Div {
    let w = g.w * g.s;
    let h = g.h * g.s;
    div()
        .absolute()
        .left(px(w * (1.0 - scale) / 2.0))
        .top(px(h * (1.0 - scale) / 2.0))
        .w(px(w * scale))
        .h(px(h * scale))
}

fn desktop(look: &MockLook) -> Div {
    let pair = if look.dark {
        [0x1C1D22, 0x2B2D35]
    } else {
        [0xD9DCE4, 0xC4C9D6]
    };
    let mut l = look.clone();
    l.tint = [RgbaColor::hex(pair[0]), RgbaColor::hex(pair[1])];
    backdrop(&l)
}

fn away_to_desktop(
    k: Kit,
    opts: &SceneOpts,
    t: &Tracker,
    out: f32,
    back: f32,
    children: Vec<AnyElement>,
) -> AnyElement {
    let scale = t.trip(1.0, 0.96, out, back + 260.0, 240.0, 300.0);
    let opacity = t.trip(1.0, 0.0, out, back + 260.0, 240.0, 300.0);
    fill()
        .child(desktop(k.look))
        .child(centred_scale(k.g, scale).opacity(opacity).child(rest(
            k.scaled(scale),
            opts,
            None,
            Slots::default(),
        )))
        .child(
            fill()
                .opacity(t.pulse(out + 200.0, back, 300.0, 240.0))
                .children(children),
        )
        .into_any_element()
}

fn app_window(k: Kit, rect: Rect, children: Vec<AnyElement>) -> AnyElement {
    let edge = RgbaColor::hexa(if k.look.dark { 0xFFFFFF26 } else { 0x0000001F });
    let s = k.g.s;
    window_frame(k, edge, radius::PANEL)
        .left(px(rect.x * s))
        .top(px(rect.y * s))
        .w(px(rect.w * s))
        .h(px(rect.h * s))
        .child(
            fill()
                .rounded(px(radius::PANEL * s))
                .overflow_hidden()
                .children(children),
        )
        .into_any_element()
}

fn mini_ardia(
    k: Kit,
    rect: Rect,
    tabs: &[Tab],
    sel: usize,
    row_fx: &dyn Fn(usize) -> Fx,
    extra: Option<AnyElement>,
    card_content: Option<AnyElement>,
) -> AnyElement {
    let card = Rect::new(
        MINI_SIDE + CARD_INSET - ROW_X,
        CARD_INSET,
        rect.w - MINI_SIDE - 2.0 * CARD_INSET + ROW_X,
        rect.h - 2.0 * CARD_INSET,
    );
    let ck = Kit {
        g: Geo {
            w: card.w,
            h: card.h,
            ..k.g
        },
        ..k
    };
    let t = tabs.get(sel).copied().unwrap_or(tab(0));
    let toolbar = toolbar_band(ck, TOOLBAR_H, None, Some((k.look.plain.divider, 1.0)))
        .child(nav_icons(
            ck,
            k.look.plain.icon,
            &[21.0, 56.0],
            21.2,
            &["chevron.left", "chevron.right", "arrow.clockwise"],
        ))
        .child(
            at(ck.g, 84.0, 12.0, card.w - 84.0 - CRUMB_TRAILING, 18.0).child(crumb(
                ck,
                t,
                &k.look.plain,
            )),
        );
    let body = card_content.unwrap_or_else(|| page(ck, &NOTES, TOOLBAR_H, card.w, None));
    let mut children: Vec<AnyElement> = vec![
        backdrop(k.look).into_any_element(),
        lights(k, 25.0, LIGHTS_TOOLBAR).into_any_element(),
    ];
    children.extend(extra);
    for (i, tb) in tabs.iter().enumerate() {
        children.push(tab_row(
            k,
            *tb,
            ROW_X,
            row_y(i, ROW_TOP),
            MINI_SIDE - 12.0,
            i == sel,
            None,
            false,
            row_fx(i),
        ));
    }
    children.push(
        at(k.g, card.x, card.y, card.w, card.h)
            .rounded(px(radius::CHROME * k.g.s))
            .bg(c(k.look.page))
            .border(px(0.5))
            .border_color(c(k.look.t.card_edge))
            .overflow_hidden()
            .child(body)
            .child(toolbar)
            .into_any_element(),
    );
    app_window(k, rect, children)
}

fn cursor(k: Kit, x: f32, y: f32, opacity: f32, scale: f32) -> AnyElement {
    let s = k.g.s;
    let ck = k.scaled(scale);
    div()
        .absolute()
        .left(px(x))
        .top(px(y))
        .w(px(18.0 * s))
        .h(px(18.0 * s))
        .opacity(opacity.clamp(0.0, 1.0))
        .child(
            div()
                .absolute()
                .left(px(0.8 * s))
                .top(px(0.8 * s))
                .child(ck.glyph(
                    "cursorarrow",
                    15.0,
                    RgbaColor::WHITE,
                    SymbolWeight::Bold,
                    18.0,
                )),
        )
        .child(div().absolute().left_0().top_0().child(ck.glyph(
            "cursorarrow",
            15.0,
            RgbaColor::hex(0x111111),
            SymbolWeight::Regular,
            18.0,
        )))
        .into_any_element()
}

fn windows(k: Kit, t: &Tracker, opts: &SceneOpts, shared: bool) -> AnyElement {
    let g = k.g;
    let s = g.s;
    let w = (g.w - 50.0) / 2.0;
    let h = g.h - 56.0;
    let a = Rect::new(18.0, 26.0, w, h);
    let b = Rect::new(32.0 + w, 30.0, w, h);
    let list = [tab(0), tab(1), tab(2), tab(3)];
    let other: Vec<Tab> = if shared {
        list.to_vec()
    } else {
        vec![tab(4), tab(5), tab(6)]
    };
    let from = (a.x + w * 0.62, a.y + h * 0.78);
    let to = (a.x + 70.0, a.y + row_y(2, ROW_TOP) + 14.0);
    let click = 1100.0;
    let back = 3000.0;
    let ak = k;
    let card_w = w - MINI_SIDE - 2.0 * CARD_INSET + ROW_X;
    let ck = Kit {
        g: Geo { w: card_w, ..g },
        ..k
    };
    let first_card = fill()
        .child(
            fill()
                .opacity(t.fade_out(click + 40.0, 200.0))
                .child(page(ck, &NOTES, TOOLBAR_H, card_w, None)),
        )
        .child(
            fill()
                .opacity(t.fade_in(click + 80.0, 260.0))
                .child(page(ck, &TRIP, TOOLBAR_H, card_w, None)),
        )
        .into_any_element();
    let slide = t.t(&[(click, 0.0), (click + 300.0, 2.0 * ROW_PITCH * s)]);
    let extra = highlight(
        ak,
        ROW_X,
        row_y(0, ROW_TOP) + slide / s,
        MINI_SIDE - 12.0,
        ROW_H,
    )
    .into_any_element();
    let dim_a = move |i: usize| {
        if shared && i == 1 {
            Fx::fade(0.4)
        } else {
            Fx::default()
        }
    };
    let dim_b = move |i: usize| {
        if !shared {
            return Fx::default();
        }
        match i {
            0 => Fx::fade(t.t(&[(click + 40.0, 0.4), (click + 300.0, 1.0)])),
            2 => Fx::fade(t.t(&[(click + 40.0, 1.0), (click + 300.0, 0.4)])),
            _ => Fx::default(),
        }
    };
    let cx_ = t.t(&[(600.0, from.0 * s), (click - 40.0, to.0 * s)]);
    let cy_ = t.t(&[(600.0, from.1 * s), (click - 40.0, to.1 * s)]);
    let cscale = t.with(
        &[
            (click - 20.0, 1.0),
            (click + 20.0, 0.85),
            (click + 140.0, 1.0),
        ],
        linear,
    );
    let copacity = t.t(&[
        (600.0, 0.0),
        (760.0, 1.0),
        (back - 400.0, 1.0),
        (back - 160.0, 0.0),
    ]);
    away_to_desktop(
        k,
        opts,
        t,
        300.0,
        back,
        vec![
            mini_ardia_with_highlight(ak, a, &list, &dim_a, extra, first_card),
            mini_ardia(k, b, &other, if shared { 1 } else { 0 }, &dim_b, None, None),
            cursor(k, cx_, cy_, copacity, cscale),
        ],
    )
}

fn mini_ardia_with_highlight(
    k: Kit,
    rect: Rect,
    tabs: &[Tab],
    row_fx: &dyn Fn(usize) -> Fx,
    highlight_el: AnyElement,
    card_content: AnyElement,
) -> AnyElement {
    let card = Rect::new(
        MINI_SIDE + CARD_INSET - ROW_X,
        CARD_INSET,
        rect.w - MINI_SIDE - 2.0 * CARD_INSET + ROW_X,
        rect.h - 2.0 * CARD_INSET,
    );
    let ck = Kit {
        g: Geo {
            w: card.w,
            h: card.h,
            ..k.g
        },
        ..k
    };
    let toolbar = toolbar_band(ck, TOOLBAR_H, None, Some((k.look.plain.divider, 1.0)))
        .child(nav_icons(
            ck,
            k.look.plain.icon,
            &[21.0, 56.0],
            21.2,
            &["chevron.left", "chevron.right", "arrow.clockwise"],
        ))
        .child(
            at(ck.g, 84.0, 12.0, card.w - 84.0 - CRUMB_TRAILING, 18.0).child(crumb(
                ck,
                tab(0),
                &k.look.plain,
            )),
        );
    let mut children: Vec<AnyElement> = vec![
        backdrop(k.look).into_any_element(),
        lights(k, 25.0, LIGHTS_TOOLBAR).into_any_element(),
        highlight_el,
    ];
    for (i, tb) in tabs.iter().enumerate() {
        children.push(tab_row(
            k,
            *tb,
            ROW_X,
            row_y(i, ROW_TOP),
            MINI_SIDE - 12.0,
            false,
            None,
            false,
            row_fx(i),
        ));
    }
    children.push(
        at(k.g, card.x, card.y, card.w, card.h)
            .rounded(px(radius::CHROME * k.g.s))
            .bg(c(k.look.page))
            .border(px(0.5))
            .border_color(c(k.look.t.card_edge))
            .overflow_hidden()
            .child(card_content)
            .child(toolbar)
            .into_any_element(),
    );
    app_window(k, rect, children)
}

fn appearance(k: Kit, t: &Tracker, opts: &SceneOpts, mode: Option<bool>) -> AnyElement {
    let dark = k.look.dark;
    let flip = MockLook::new(!dark, opts.accent);
    let turn = 700.0;
    let back = 2000.0;
    let s = k.g.s;
    let shown = |is_dark: bool| match mode {
        None => format!(
            "Auto · {} like your Mac",
            if is_dark { "Dark" } else { "Light" }
        ),
        Some(_) => (if is_dark { "Dark" } else { "Light" }).to_owned(),
    };
    let make_pill = |l: &MockLook, opacity: f32| {
        let pk = k.with_look(l);
        pill(
            pk,
            Some(space::XL * s),
            None,
            None,
            Some(space::XL * s),
            opacity,
            t.trip(6.0 * s, 0.0, 300.0, back + 300.0, 280.0, 240.0),
            vec![
                pk.turning_glyph(
                    if l.dark { "moon.fill" } else { "sun.max.fill" },
                    14.0,
                    RgbaColor::hex(if l.dark { 0xC7CCE6 } else { 0xE3A21A }),
                    SymbolWeight::Medium,
                    18.0,
                    t.t(&[(340.0, -90.0), (780.0, 0.0)]),
                ),
                pk.label(BODY, l.t.text_primary, FontWeight::MEDIUM, shown(l.dark))
                    .into_any_element(),
            ],
        )
    };
    if mode.is_some() {
        let over = make_pill(k.look, t.pulse(300.0, back + 300.0, 220.0, 240.0));
        return rest(
            k,
            opts,
            None,
            Slots {
                over: Some(over),
                ..Slots::default()
            },
        );
    }
    let fk = k.with_look(&flip);
    fill()
        .child(rest(k, opts, None, Slots::default()))
        .child(
            fill()
                .opacity(t.pulse(turn, back, 420.0, 420.0))
                .child(rest(fk, opts, None, Slots::default())),
        )
        .child(make_pill(
            k.look,
            t.t(&[
                (300.0, 0.0),
                (520.0, 1.0),
                (turn, 1.0),
                (turn + 200.0, 0.0),
                (back + 200.0, 0.0),
                (back + 420.0, 1.0),
                (back + 600.0, 1.0),
                (back + 800.0, 0.0),
            ]),
        ))
        .child(make_pill(
            &flip,
            t.t(&[
                (turn + 200.0, 0.0),
                (turn + 420.0, 1.0),
                (back, 1.0),
                (back + 200.0, 0.0),
            ]),
        ))
        .into_any_element()
}

fn site_color(k: Kit, t: &Tracker, opts: &SceneOpts, on: bool) -> AnyElement {
    let load = 500.0;
    let loaded = 1100.0;
    let s = k.g.s;
    let tint = if on {
        t.t(&[
            (load, 1.0),
            (load + 200.0, 0.0),
            (loaded + 120.0, 0.0),
            (loaded + 520.0, 1.0),
        ])
    } else {
        0.0
    };
    let cw = card_of(k.g, opts).w;
    let ck = Kit {
        g: Geo { w: cw, ..k.g },
        ..k
    };
    let page_el = fill()
        .child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .top(px(TOOLBAR_H * s))
                .bg(c(k.look.page)),
        )
        .child(
            fill()
                .opacity(t.t(&[
                    (load, 1.0),
                    (load + 200.0, 0.0),
                    (loaded, 0.0),
                    (loaded + 320.0, 1.0),
                ]))
                .top(px(t.t(&[
                    (load + 200.0, 0.0),
                    (loaded, 6.0 * s),
                    (loaded + 340.0, 0.0),
                ])))
                .child(page(ck, &NOTES, TOOLBAR_H, cw, None)),
        )
        .into_any_element();
    let o = SceneOpts {
        site_color: on,
        ..*opts
    };
    rest(
        k,
        &o,
        Some(tint),
        Slots {
            page: Some(page_el),
            ..Slots::default()
        },
    )
}

fn ad_box(k: Kit, h: f32, opacity: f32, scale: f32) -> Div {
    let s = k.g.s;
    let l = k.look;
    div()
        .h(px(h * s * scale))
        .rounded(px(radius::TILE * s))
        .bg(l.pick([0xF6F1DE, 0x2A2719]))
        .border(px(0.5))
        .border_color(l.pick([0xE2D6A8, 0x5A5130]))
        .flex()
        .items_center()
        .justify_center()
        .opacity(opacity.clamp(0.0, 1.0))
        .child(k.label(
            TINY,
            RgbaColor::hex(if l.dark { 0xB9A867 } else { 0x9C8A45 }),
            FontWeight::SEMIBOLD,
            "AD",
        ))
}

fn block(k: Kit, t: &Tracker, opts: &SceneOpts, on: bool) -> AnyElement {
    let g = k.g;
    let s = g.s;
    let card = card_of(g, opts);
    let back = 2500.0;
    let ad = |ms: f32, gone: f32| {
        let opacity = if on {
            t.t(&[
                (ms, 0.0),
                (ms + 200.0, 1.0),
                (gone, 1.0),
                (gone + 220.0, 0.0),
            ])
        } else {
            t.pulse(ms, back, 200.0, 240.0)
        };
        let scale = if on {
            t.t(&[
                (ms, 0.94),
                (ms + 260.0, 1.0),
                (gone, 1.0),
                (gone + 260.0, 0.86),
            ])
        } else {
            t.trip(0.94, 1.0, ms, back, 260.0, 240.0)
        };
        (opacity, scale)
    };
    let top = if opts.address_in_sidebar {
        0.0
    } else {
        TOOLBAR_H
    };
    let ck = Kit {
        g: Geo { w: card.w, ..g },
        ..k
    };
    let (inline_o, inline_s) = ad(300.0, 1000.0);
    let (side_o, side_s) = ad(220.0, 920.0);
    let side_w = 130.0 * side_s;
    let side_h = 150.0 * side_s;
    let page_el = fill()
        .child(page(
            ck,
            &NOTES,
            TOOLBAR_H,
            card.w,
            Some(ad_box(ck, 64.0, inline_o, inline_s).into_any_element()),
        ))
        .child(
            at(
                g,
                card.w - 150.0 + (130.0 - side_w) / 2.0,
                TOOLBAR_H + 80.0 + (150.0 - side_h) / 2.0,
                side_w,
                side_h,
            )
            .child(ad_box(ck, 150.0, side_o, side_s)),
        )
        .into_any_element();
    let banner_o = if on {
        t.t(&[(380.0, 0.0), (520.0, 1.0), (1080.0, 1.0), (1320.0, 0.0)])
    } else {
        t.pulse(380.0, back, 160.0, 240.0)
    };
    let banner_y = if on {
        t.t(&[
            (380.0, 40.0 * s),
            (680.0, 0.0),
            (1080.0, 0.0),
            (1320.0, 40.0 * s),
        ])
    } else {
        t.trip(40.0 * s, 0.0, 380.0, back, 300.0, 240.0)
    };
    let banner = div()
        .absolute()
        .left(px(20.0 * s))
        .right(px(20.0 * s))
        .bottom(px(18.0 * s - banner_y))
        .opacity(banner_o.clamp(0.0, 1.0))
        .child(
            mock_surface(k, radius::PANEL, (0.5, 0.14), 16.0, 4.0, None, None)
                .h(px(52.0 * s))
                .flex()
                .flex_row()
                .items_center()
                .px(px(space::XL * s))
                .gap(px(space::L * s))
                .child(div().flex_1().min_w_0().child(k.label(
                    SMALL,
                    k.look.t.text_primary,
                    FontWeight::NORMAL,
                    "We use cookies to personalise ads and measure traffic.",
                )))
                .child(
                    div()
                        .h(px(28.0 * s))
                        .px(px(space::L * s))
                        .rounded(px(radius::TILE * s))
                        .bg(c(k.look.t.go_button))
                        .flex()
                        .items_center()
                        .child(k.label(
                            SMALL,
                            k.look.t.on_primary,
                            FontWeight::SEMIBOLD,
                            "Accept all",
                        )),
                ),
        );
    let badge_scale = t.trip(0.6, 1.0, 800.0, back, 260.0, 240.0);
    let badge = on.then(|| {
        at(g, card.w - 64.0, top + 8.0, 52.0, 26.0)
            .opacity(t.pulse(800.0, back, 200.0, 240.0).clamp(0.0, 1.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(space::XS * s))
            .child(k.scaled(badge_scale).glyph(
                "checkmark.shield.fill",
                14.0,
                k.look.t.accent,
                SymbolWeight::Medium,
                18.0,
            ))
            .child(k.scaled(badge_scale).label(
                CAPTION,
                k.look.t.text_secondary,
                FontWeight::SEMIBOLD,
                "3",
            ))
    });
    let card_el = fill().child(banner).children(badge).into_any_element();
    rest(
        k,
        opts,
        None,
        Slots {
            page: Some(page_el),
            card: Some(card_el),
            ..Slots::default()
        },
    )
}

fn bubble(k: Kit, mine: bool, text: &str) -> AnyElement {
    let s = k.g.s;
    let l = k.look;
    div()
        .flex()
        .when(mine, |this| this.justify_end())
        .child(
            div()
                .max_w(gpui::relative(0.82))
                .rounded(px(radius::SHEET * s))
                .px(px(space::L * s))
                .py(px(space::M * s))
                .bg(if mine {
                    c(RgbaColor::hex(0x2F7BF6))
                } else {
                    l.pick([0xE9E9EB, 0x3A3A3C])
                })
                .font_family(UI_FONT)
                .text_size(px(SMALL * s))
                .line_height(px(SMALL * 1.3 * s))
                .text_color(c(if mine {
                    RgbaColor::WHITE
                } else {
                    l.t.text_primary
                }))
                .line_clamp(3)
                .child(SharedString::from(text.to_owned())),
        )
        .into_any_element()
}

fn links(k: Kit, phase: f32, opts: &SceneOpts, little: bool) -> AnyElement {
    let duration = PreviewId::LinksLittle.duration_ms();
    let away = Tracker::new(phase, duration, 0.0);
    let t = Tracker::new(phase, duration, 520.0);
    let g = k.g;
    let s = g.s;
    let l = k.look;
    let chat = Rect::new(18.0, 40.0, 300.0, g.h - 80.0);
    let ardia = Rect::new(300.0, 22.0, g.w - 318.0, g.h - 44.0);
    let from = (chat.x + 250.0, chat.y + chat.h - 40.0);
    let to = (chat.x + 120.0, chat.y + 228.0);
    let float = Rect::new(ardia.x + 70.0, 70.0, 430.0, g.h - 120.0);
    let arrived = Fx {
        dx: t.t(&[(560.0, -12.0 * s), (860.0, 0.0)]),
        opacity: Some(t.fade_in(560.0, 240.0)),
        ..Fx::default()
    };
    let tabs: Vec<Tab> = if little {
        vec![tab(1), tab(3), tab(4)]
    } else {
        vec![tab(1), tab(3), tab(4), tab(0)]
    };
    let card_w = ardia.w - MINI_SIDE - 2.0 * CARD_INSET + ROW_X;
    let ck = Kit {
        g: Geo { w: card_w, ..g },
        ..k
    };
    let card_content = if little {
        page(ck, &TRIP, TOOLBAR_H, card_w, None)
    } else {
        fill()
            .child(page(ck, &TRIP, TOOLBAR_H, card_w, None))
            .child(
                fill()
                    .opacity(t.fade_in(640.0, 300.0))
                    .child(page(ck, &NOTES, TOOLBAR_H, card_w, None)),
            )
            .into_any_element()
    };
    let row_fx = move |i: usize| {
        if !little && i == 3 {
            arrived
        } else {
            Fx::default()
        }
    };
    let extra = (!little).then(|| {
        highlight(k, ROW_X, row_y(0, ROW_TOP), MINI_SIDE - 12.0, ROW_H)
            .opacity(t.fade_out(560.0, 200.0))
            .into_any_element()
    });
    let ardia_el = mini_ardia(
        k,
        ardia,
        &tabs,
        if little { 0 } else { 3 },
        &row_fx,
        extra,
        Some(card_content),
    );
    let link_card = div()
        .w(px(210.0 * s))
        .rounded(px(radius::SHEET * s))
        .overflow_hidden()
        .relative()
        .bg(l.pick([0xE9E9EB, 0x3A3A3C]))
        .child(
            div()
                .relative()
                .h(px(70.0 * s))
                .overflow_hidden()
                .bg(l.pick(NOTES.hero.far))
                .child(
                    div()
                        .absolute()
                        .left(px(63.0 * s))
                        .w(px(189.0 * s))
                        .top(px(28.0 * s))
                        .h(px(120.0 * s))
                        .rounded(px(80.0 * s))
                        .bg(l.pick(NOTES.hero.near)),
                ),
        )
        .child(
            div()
                .p(px(space::M * s))
                .flex()
                .flex_col()
                .gap(px(space::XXS * s))
                .child(k.label(
                    SMALL,
                    l.t.text_primary,
                    FontWeight::SEMIBOLD,
                    "A slow morning on the coast trail",
                ))
                .child(k.label(
                    CAPTION,
                    l.t.text_secondary,
                    FontWeight::NORMAL,
                    "fieldnotes.blog",
                )),
        )
        .child(
            fill()
                .bg(c(RgbaColor::black(0.12)))
                .opacity(t.with(&[(470.0, 0.0), (510.0, 1.0), (700.0, 0.0)], linear)),
        );
    let chat_el = app_window(
        k,
        chat,
        vec![
            fill().bg(l.pick([0xFFFFFF, 0x1E1E1E])).into_any_element(),
            lights(k, 20.0, 20.0).into_any_element(),
            at(g, 0.0, 38.0, chat.w, 1.0)
                .h(px(0.5))
                .bg(c(l.t.divider))
                .into_any_element(),
            div()
                .absolute()
                .top(px(13.0 * s))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(k.label(BODY, l.t.text_primary, FontWeight::SEMIBOLD, "Sam"))
                .into_any_element(),
            div()
                .absolute()
                .left(px(14.0 * s))
                .right(px(14.0 * s))
                .top(px(54.0 * s))
                .flex()
                .flex_col()
                .gap(px(space::M * s))
                .child(bubble(k, false, "Found the trail we talked about"))
                .child(bubble(k, true, "Send it!"))
                .child(link_card)
                .into_any_element(),
        ],
    );
    let float_el = little.then(|| {
        let scale = t.t(&[(560.0, 0.9), (900.0, 1.0)]);
        let dy = t.t(&[(560.0, 14.0 * s), (900.0, 0.0)]);
        let fw = float.w * scale;
        let fh = float.h * scale;
        let fk = k.scaled(scale);
        let fck = Kit {
            g: Geo {
                w: float.w,
                h: float.h,
                ..fk.g
            },
            ..fk
        };
        div()
            .absolute()
            .left(px((float.x + (float.w - fw) / 2.0) * s))
            .top(px((float.y + (float.h - fh) / 2.0) * s + dy))
            .w(px(fw * s))
            .h(px(fh * s))
            .opacity(t.fade_in(560.0, 220.0))
            .child(app_window(
                fk,
                Rect::new(0.0, 0.0, float.w, float.h),
                vec![
                    fill().bg(c(l.page)).into_any_element(),
                    page(fck, &NOTES, 38.0, float.w, None),
                    toolbar_band(fck, 38.0, Some(l.card), Some((l.t.divider, 1.0)))
                        .child(lights(fck, 19.0, 19.0))
                        .child(at(fck.g, 84.0, 10.0, float.w - 100.0, 18.0).child(crumb(
                            fck,
                            tab(0),
                            &l.plain,
                        )))
                        .into_any_element(),
                ],
            ))
            .into_any_element()
    });
    let cx_ = t.t(&[(60.0, from.0 * s), (440.0, to.0 * s)]);
    let cy_ = t.t(&[(60.0, from.1 * s), (440.0, to.1 * s)]);
    let cscale = t.with(&[(460.0, 1.0), (500.0, 0.85), (620.0, 1.0)], linear);
    let copacity = t.t(&[(60.0, 0.0), (200.0, 1.0), (2300.0, 1.0), (2500.0, 0.0)]);
    let mut children = vec![ardia_el, chat_el];
    children.extend(float_el);
    children.push(cursor(k, cx_, cy_, copacity, cscale));
    away_to_desktop(k, opts, &away, 300.0, 3400.0, children)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_field_panel_grows_its_content_from_the_crumb() {
        let from = Rect::new(100.0, 40.0, 300.0, 30.0);
        let to = Rect::new(70.0, 34.0, 480.0, PANEL_H);
        let shown = |trip: GrowTrip| {
            let w = trip.rect.w * trip.scale[0];
            let h = trip.rect.h * trip.scale[1];
            Rect::new(
                trip.rect.x + (trip.rect.w - w) / 2.0,
                trip.rect.y + (trip.rect.h - h) / 2.0,
                w,
                h,
            )
        };
        let start = shown(grow_trip(
            &Tracker::new(0.0, 1.0, 0.0),
            from,
            to,
            380.0,
            1900.0,
            260.0,
        ));
        assert!((start.x - from.x).abs() < 1e-3 && (start.w - from.w).abs() < 1e-3);
        assert!((start.y - from.y).abs() < 1e-3 && (start.h - from.h).abs() < 1e-3);
        let open = grow_trip(
            &Tracker::new(1000.0, 1.0, 0.0),
            from,
            to,
            380.0,
            1900.0,
            260.0,
        );
        assert_eq!(open.scale, [1.0, 1.0]);
        assert_eq!(open.rect, to);
        let mid = grow_trip(
            &Tracker::new(450.0, 1.0, 0.0),
            from,
            to,
            380.0,
            1900.0,
            260.0,
        );
        assert!(mid.scale[0] != mid.scale[1]);
    }

    #[test]
    fn geometry_matches_the_old_design_space() {
        let g = Geo::of(744.0, 506.0);
        assert!((g.s - 744.0 / 860.0).abs() < 1e-6 || (g.s - 506.0 / 600.0).abs() < 1e-6);
        let g = Geo::of(860.0, 600.0);
        assert_eq!(rest_row_count(g), 6);
        assert_eq!(rest_chip_count(g), 4);
        let small = Geo::of(430.0, 300.0);
        assert_eq!((small.w, small.h), (860.0, 600.0));
        assert_eq!(
            rest_card(g, true, 9.0),
            Rect::new(9.0, STRIP_H, 842.0, 549.0)
        );
        assert_eq!(rest_card(g, false, 9.0).x, 193.0);
        assert_eq!(card_radius(9.0), 10.0);
        assert_eq!(card_radius(0.0), 0.0);
        assert_eq!(PANEL_H, 174.0);
    }

    #[test]
    fn tracks_sample_eased_stops_and_clamp_outside_them() {
        let stops = [(100.0, 0.0), (500.0, 1.0)];
        assert_eq!(track(0.0, &stops, ease_out_cubic), 0.0);
        assert_eq!(track(900.0, &stops, ease_out_cubic), 1.0);
        let half = track(300.0, &stops, ease_out_cubic);
        assert!((half - 0.875).abs() < 1e-4);
        assert_eq!(track(300.0, &stops, linear), 0.5);
        let held = [(0.0, 1.0), (200.0, 1.0), (400.0, 0.0)];
        assert_eq!(track(100.0, &held, ease_out_cubic), 1.0);
        let t = Tracker::new(0.5, 1000.0, 0.0);
        assert_eq!(t.pulse(100.0, 300.0, 100.0, 100.0), 0.0);
        assert_eq!(
            Tracker::new(0.25, 1000.0, 0.0).pulse(100.0, 300.0, 100.0, 100.0),
            1.0
        );
    }

    #[test]
    fn previews_keep_the_old_keys_and_durations() {
        assert_eq!(PreviewId::ALL.len(), 30);
        assert_eq!(PreviewId::CmdlCentred.key(), "cmdl-centred");
        assert_eq!(PreviewId::StyleGlass.duration_ms(), 1300.0);
        assert_eq!(PreviewId::LinksTab.duration_ms(), 4000.0);
        let mut keys: Vec<&str> = PreviewId::ALL.iter().map(|p| p.key()).collect();
        keys.dedup();
        assert_eq!(keys.len(), 30);
    }

    #[test]
    fn the_director_waits_for_the_morph_and_the_settle() {
        let settings = Settings::default();
        let start = Instant::now();
        let mut director = SceneDirector::new(None);
        let (_, scene, waiting) =
            director.update(Some(PreviewId::TabsTop), &settings, "layout.0", 600, start);
        assert_eq!(scene, None);
        assert!(waiting);
        let (shown, scene, _) = director.update(
            Some(PreviewId::TabsTop),
            &settings,
            "layout.0",
            600,
            start + Duration::from_millis(10),
        );
        assert_eq!(shown.tab_layout, ardia_state::model::TabLayout::Top);
        assert_eq!(scene, None);
        let (_, scene, waiting) = director.update(
            Some(PreviewId::TabsTop),
            &settings,
            "layout.0",
            600,
            start + Duration::from_millis(610),
        );
        assert_eq!(scene, Some(PreviewId::TabsTop));
        assert!(!waiting);
        let (_, scene, _) = director.update(
            Some(PreviewId::TabsSidebar),
            &settings,
            "layout.0",
            600,
            start + Duration::from_millis(700),
        );
        assert_eq!(scene, None);
        let (_, scene, _) = director.update(
            Some(PreviewId::TabsSidebar),
            &settings,
            "layout.0",
            600,
            start + Duration::from_millis(700 + 250 + 400),
        );
        assert_eq!(scene, Some(PreviewId::TabsSidebar));
    }

    #[test]
    fn hover_wins_until_a_choice_or_a_new_section_clears_it() {
        let mut focus = MockFocus::default();
        focus.show(Some("layout.tabs".into()));
        focus.settle("layout.tabs", Some(PreviewId::TabsSidebar));
        assert_eq!(focus.current(), Some(PreviewId::TabsSidebar));
        focus.hover(PreviewId::TabsTop, true);
        focus.hover(PreviewId::TabsTop, false);
        assert_eq!(focus.current(), Some(PreviewId::TabsTop));
        focus.choose("layout.tabs", Some(PreviewId::TabsSidebar));
        assert_eq!(focus.current(), Some(PreviewId::TabsSidebar));
        focus.hover(PreviewId::TabsTop, true);
        focus.show(Some("layout.color".into()));
        assert_eq!(focus.current(), None);
        assert_eq!(preview_for("quit", "false"), Some(PreviewId::QuitFresh));
    }

    #[test]
    fn the_look_matches_the_preset_swatch() {
        let plum = ProfileColor::Plum.spec().swatch;
        let look = MockLook::new(false, plum);
        assert!(!look.dark);
        assert_eq!(look.page, RgbaColor::WHITE);
        assert_eq!(look.card.a, 1.0);
        let dark = MockLook::new(true, plum);
        assert_eq!(dark.page, RgbaColor::hex(0x161718));
    }
}
