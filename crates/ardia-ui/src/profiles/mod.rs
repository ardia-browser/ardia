pub mod create;
pub mod layer;
pub mod menu;

use ardia_state::profiles::Profile;
use ardia_state::{BrowserState, ProfileId};
use ardia_theme::ProfileColor;

use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, rgba,
};

use crate::host::UiHost;
use crate::icon_picker::PickerSymbol;
use crate::icon_picker::symbols::{SymbolWeight, icon_symbol, symbol};
use crate::primitives::theme_bridge::hsla;
use crate::scale::px;

pub mod tokens {
    pub const STACK_RING_DARK: u32 = 0x0000_0059;
    pub const STACK_RING_LIGHT: u32 = 0xFFFF_FFFF;
    pub const BADGE_EDGE: u32 = 0x0000_001F;
    pub const UNKNOWN_SWATCH: u32 = 0x8888_88FF;
    pub const SHARE_ROW_HEIGHT: f32 = 32.0;
    pub const BADGE_INITIAL_SCALE: f32 = 0.425;
    pub const BADGE_EMOJI_SCALE: f32 = 0.55;
    pub const BADGE_SYMBOL_SCALE: f32 = 0.5;
    pub const BADGE_EDGE_MIN: f32 = 22.0;
    pub const HOLD_PLATE_DOT: f32 = 16.0;
    pub const HOLD_PLATE_ICON: f32 = 22.0;
    pub const HOLD_PLATE_RADIUS: f32 = 6.0;
}

pub const PROFILE_SYMBOLS: &[PickerSymbol] = &[
    PickerSymbol::new("house.fill", "Home"),
    PickerSymbol::new("briefcase.fill", "Work"),
    PickerSymbol::new("graduationcap.fill", "School"),
    PickerSymbol::new("chevron.left.forwardslash.chevron.right", "Code"),
    PickerSymbol::new("paintpalette.fill", "Art"),
    PickerSymbol::new("hammer.fill", "Projects"),
    PickerSymbol::new("book.closed.fill", "Reading"),
    PickerSymbol::new("music.note", "Music"),
    PickerSymbol::new("camera.fill", "Photos"),
    PickerSymbol::new("gamecontroller.fill", "Games"),
    PickerSymbol::new("cart.fill", "Shopping"),
    PickerSymbol::new("banknote.fill", "Finance"),
    PickerSymbol::new("airplane", "Travel"),
    PickerSymbol::new("figure.run", "Fitness"),
    PickerSymbol::new("cup.and.saucer.fill", "Café"),
    PickerSymbol::new("leaf.fill", "Nature"),
    PickerSymbol::new("pawprint.fill", "Pets"),
    PickerSymbol::new("heart.fill", "Personal"),
    PickerSymbol::new("star.fill", "Favorites"),
    PickerSymbol::new("moon.stars.fill", "Evenings"),
    PickerSymbol::new("person.fill", "Me"),
    PickerSymbol::new("person.2.fill", "Family"),
    PickerSymbol::new("building.2.fill", "Office"),
    PickerSymbol::new("terminal.fill", "Terminal"),
    PickerSymbol::new("server.rack", "Servers"),
    PickerSymbol::new("flask.fill", "Lab"),
    PickerSymbol::new("lightbulb.fill", "Ideas"),
    PickerSymbol::new("sparkles", "Side Projects"),
    PickerSymbol::new("newspaper.fill", "News"),
    PickerSymbol::new("film.fill", "Movies"),
    PickerSymbol::new("headphones", "Podcasts"),
    PickerSymbol::new("sportscourt.fill", "Sports"),
    PickerSymbol::new("bicycle", "Cycling"),
    PickerSymbol::new("fork.knife", "Food"),
    PickerSymbol::new("gift.fill", "Gifts"),
    PickerSymbol::new("stethoscope", "Health"),
    PickerSymbol::new("chart.line.uptrend.xyaxis", "Stocks"),
    PickerSymbol::new("envelope.fill", "Mail"),
    PickerSymbol::new("bubble.left.and.bubble.right.fill", "Chat"),
    PickerSymbol::new("calendar", "Calendar"),
    PickerSymbol::new("mountain.2.fill", "Outdoors"),
    PickerSymbol::new("beach.umbrella.fill", "Holiday"),
    PickerSymbol::new("lock.fill", "Private"),
    PickerSymbol::new("flame.fill", "Hot"),
    PickerSymbol::new("bolt.fill", "Energy"),
];

pub fn unused_profile_color(state: &BrowserState) -> ProfileColor {
    ProfileColor::NEW_PROFILE_CYCLE
        .into_iter()
        .find(|color| {
            !state
                .profiles
                .values()
                .any(|profile| profile.color.preset() == *color)
        })
        .unwrap_or(ProfileColor::Blue)
}

pub fn data_id_of(profile: &Profile) -> &str {
    profile.data_id.as_deref().unwrap_or(profile.id.as_str())
}

#[derive(Clone, Debug, PartialEq)]
pub struct DataGroup {
    pub data_id: String,
    pub profile_ids: Vec<ProfileId>,
}

pub fn data_groups(state: &BrowserState) -> Vec<DataGroup> {
    let mut groups: Vec<DataGroup> = Vec::new();
    for id in state.profile_order.iter() {
        let Some(profile) = state.profile(id.as_str()) else {
            continue;
        };
        let key = data_id_of(profile);
        match groups.iter_mut().find(|g| g.data_id == key) {
            Some(group) => group.profile_ids.push(id.clone()),
            None => groups.push(DataGroup {
                data_id: key.to_owned(),
                profile_ids: vec![id.clone()],
            }),
        }
    }
    groups
}

pub fn sharing_profiles(state: &BrowserState, id: &ProfileId) -> Vec<ProfileId> {
    let Some(profile) = state.profile(id.as_str()) else {
        return Vec::new();
    };
    let key = data_id_of(profile);
    state
        .profile_order
        .iter()
        .filter(|other| *other != id)
        .filter(|other| {
            state
                .profile(other.as_str())
                .is_some_and(|p| data_id_of(p) == key)
        })
        .cloned()
        .collect()
}

pub fn profile_names(names: &[String]) -> String {
    if names.len() <= 2 {
        return names.join(" & ");
    }
    format!("{}, & {} more", names[..2].join(", "), names.len() - 2)
}

pub fn badge_initial(name: &str) -> String {
    name.trim()
        .chars()
        .next()
        .map_or_else(|| "?".to_owned(), |c| c.to_uppercase().collect())
}

pub fn hold_plate(icon: bool, cell: f32, dark: bool) -> AnyElement {
    let fill: gpui::Hsla = if dark {
        gpui::white().opacity(0.1)
    } else {
        gpui::black().opacity(0.1)
    };
    let (width, height, corner) = if icon {
        (cell, tokens::HOLD_PLATE_ICON, tokens::HOLD_PLATE_RADIUS)
    } else {
        (
            tokens::HOLD_PLATE_DOT,
            tokens::HOLD_PLATE_DOT,
            tokens::HOLD_PLATE_DOT / 2.0,
        )
    };
    div()
        .absolute()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .w(px(width))
                .h(px(height))
                .rounded(px(corner))
                .bg(fill),
        )
        .into_any_element()
}

pub fn badge_edge(size: f32) -> f32 {
    if size >= tokens::BADGE_EDGE_MIN {
        0.5
    } else {
        0.0
    }
}

pub fn profile_badge(host: &dyn UiHost, profile: &Profile, size: f32) -> AnyElement {
    let swatch = hsla(ardia_theme::profile_accent(profile.look()));
    let edge = badge_edge(size);
    let white = gpui::white();
    let body = match (
        icon_symbol(profile.icon.as_deref()),
        profile.icon.as_deref(),
    ) {
        (Some(name), _) => symbol(
            host,
            name,
            size * tokens::BADGE_SYMBOL_SCALE,
            size,
            SymbolWeight::Semibold,
            white,
        ),
        (None, Some(emoji)) => div()
            .text_size(px(size * tokens::BADGE_EMOJI_SCALE))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(white)
            .child(SharedString::from(emoji.to_owned()))
            .into_any_element(),
        (None, None) => div()
            .text_size(px(size * tokens::BADGE_INITIAL_SCALE))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(white)
            .child(SharedString::from(badge_initial(&profile.name)))
            .into_any_element(),
    };
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .bg(swatch)
        .when(edge > 0.0, |this| {
            this.border(px(edge))
                .border_color(gpui::Hsla::from(rgba(tokens::BADGE_EDGE)))
        })
        .flex()
        .items_center()
        .justify_center()
        .child(body)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badge_edge_starts_at_twenty_two_points() {
        assert_eq!(badge_edge(21.0), 0.0);
        assert_eq!(badge_edge(26.0), 0.5);
    }

    #[test]
    fn unused_color_and_data_groups() {
        use std::sync::Arc;
        let mut state = BrowserState::default();
        let a = ProfileId::new("a");
        let b = ProfileId::new("b");
        let mut pb = Profile::new(b.clone(), "B", ProfileColor::Green, Default::default());
        pb.data_id = Some("a".into());
        let pa = Profile::new(a.clone(), "A", ProfileColor::Blue, Default::default());
        Arc::make_mut(&mut state.profiles).insert(a.clone(), Arc::new(pa));
        Arc::make_mut(&mut state.profiles).insert(b.clone(), Arc::new(pb));
        state.profile_order = Arc::new(vec![a.clone(), b.clone()]);
        assert_eq!(unused_profile_color(&state), ProfileColor::Orange);
        let groups = data_groups(&state);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].profile_ids, vec![a.clone(), b.clone()]);
        assert_eq!(sharing_profiles(&state, &a), vec![b]);
    }

    #[test]
    fn names_and_initials() {
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(profile_names(&names(&["A", "B"])), "A & B");
        assert_eq!(
            profile_names(&names(&["A", "B", "C", "D"])),
            "A, B, & 2 more"
        );
        assert_eq!(badge_initial("  work"), "W");
        assert_eq!(badge_initial(""), "?");
    }
}
