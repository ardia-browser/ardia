use ardia_state::{BrowserState, ProfileId};
use ardia_theme::ProfileColor;
use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, Entity, FontWeight, Hsla, IntoElement, ParentElement, SharedString, Styled, div,
    prelude::*, rgba,
};

use crate::look::Palette;
use crate::primitives::text_input::TextInput;
use crate::primitives::theme_bridge::hsla;
use crate::profiles::{DataGroup, data_groups, profile_names, tokens};
use crate::scale::px;

pub const SHEET_WIDTH: f32 = 420.0;
pub const SWATCH_SIZE: f32 = 20.0;
pub const SWATCH_INSET: f32 = 2.0;
pub const SWATCH_RING: f32 = 2.0;
pub const SWATCH_GAP: f32 = 8.0;
pub const FIELD_HEIGHT: f32 = 24.0;
pub const RADIO_BOX: f32 = 14.0;
pub const RADIO_GLYPH: f32 = 6.0;
pub const STACK_DOT: f32 = 12.0;
pub const TITLE: &str = "Create a Profile";
pub const SUBTITLE: &str =
    "Profiles separate your logins, cookies, passwords, extensions, history and bookmarks.";

#[derive(Clone, Debug, PartialEq)]
pub struct CreateForm {
    pub color: ProfileColor,
    pub share: bool,
    pub share_with: Option<ProfileId>,
}

pub fn share_title(single: bool) -> &'static str {
    if single {
        "Share data with current profile"
    } else {
        "Share data with another profile"
    }
}

pub fn share_description(single: bool) -> &'static str {
    if single {
        "This profile will share your cookies, logins, passwords, extensions, bookmarks and history with your current profile. Tabs stay separate."
    } else {
        "This profile will share your cookies, logins, passwords, extensions, bookmarks and history with another profile you choose. Tabs stay separate."
    }
}

pub fn chosen_name(typed: &str, profile_count: usize) -> String {
    let name = typed.trim();
    if name.is_empty() {
        format!("Profile {}", profile_count + 1)
    } else {
        name.to_owned()
    }
}

pub fn selected_group<'a>(
    groups: &'a [DataGroup],
    share_with: Option<&ProfileId>,
) -> Option<&'a DataGroup> {
    share_with
        .and_then(|id| groups.iter().find(|g| g.profile_ids.contains(id)))
        .or_else(|| groups.first())
}

pub fn field(input: &Entity<TextInput>, p: &Palette) -> AnyElement {
    div()
        .h(px(FIELD_HEIGHT))
        .px(px(space::M))
        .rounded(px(radius::CONTROL))
        .bg(p.field)
        .border(px(1.))
        .border_color(p.field_border)
        .flex()
        .items_center()
        .child(div().flex_1().min_w_0().child(input.clone()))
        .into_any_element()
}

pub fn title_block(title: &'static str, subtitle: Option<&'static str>, p: &Palette) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .child(
            div()
                .text_size(px(15.))
                .line_height(px(20.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text)
                .child(title),
        )
        .when_some(subtitle, |this, subtitle| {
            this.child(
                div()
                    .mt(px(space::S))
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(p.text_secondary)
                    .child(subtitle),
            )
        })
        .into_any_element()
}

pub fn swatch(color: ProfileColor, selected: bool) -> gpui::Div {
    let fill = hsla(color.spec().swatch);
    div()
        .size(px(SWATCH_SIZE))
        .rounded_full()
        .p(px(SWATCH_INSET))
        .border(px(SWATCH_RING))
        .border_color(if selected { fill } else { fill.opacity(0.0) })
        .child(div().size_full().rounded_full().bg(fill))
}

pub fn radio(on: bool, p: &Palette) -> AnyElement {
    div()
        .flex_none()
        .size(px(RADIO_BOX))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .when(on, |this| this.bg(p.form_accent))
        .when(!on, |this| {
            this.bg(p.control)
                .border(px(1.))
                .border_color(p.field_border)
        })
        .when(on, |this| {
            this.child(div().size(px(RADIO_GLYPH)).rounded_full().bg(p.on_accent))
        })
        .into_any_element()
}

pub fn color_stack(colors: &[Hsla], dark: bool) -> AnyElement {
    let shown = &colors[..colors.len().min(4)];
    let ring: Hsla = rgba(if dark {
        tokens::STACK_RING_DARK
    } else {
        tokens::STACK_RING_LIGHT
    })
    .into();
    div()
        .flex_none()
        .flex()
        .w(px(
            STACK_DOT + shown.len().saturating_sub(1) as f32 * STACK_DOT * 0.6
        ))
        .children(shown.iter().enumerate().map(|(i, color)| {
            div()
                .flex_none()
                .size(px(STACK_DOT))
                .rounded_full()
                .bg(*color)
                .border(px(1.))
                .border_color(ring)
                .when(i > 0, |this| this.ml(px(-STACK_DOT * 0.4)))
        }))
        .into_any_element()
}

pub fn group_swatches(state: &BrowserState, group: &DataGroup) -> Vec<Hsla> {
    group
        .profile_ids
        .iter()
        .map(|id| {
            state.profile(id.as_str()).map_or_else(
                || rgba(tokens::UNKNOWN_SWATCH).into(),
                |profile| hsla(profile.color.preset().spec().swatch),
            )
        })
        .collect()
}

pub fn group_label(state: &BrowserState, group: &DataGroup) -> SharedString {
    let names: Vec<String> = group
        .profile_ids
        .iter()
        .filter_map(|id| state.profile(id.as_str()).map(|p| p.name.clone()))
        .collect();
    SharedString::from(profile_names(&names))
}

pub fn groups(state: &BrowserState) -> Vec<DataGroup> {
    data_groups(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_fall_back_like_the_store() {
        assert_eq!(chosen_name("  Work ", 2), "Work");
        assert_eq!(chosen_name("   ", 2), "Profile 3");
    }

    #[test]
    fn share_copy_depends_on_group_count() {
        assert_eq!(share_title(true), "Share data with current profile");
        assert!(share_description(false).contains("another profile you choose"));
    }

    #[test]
    fn selected_group_defaults_to_the_first() {
        let groups = vec![
            DataGroup {
                data_id: "a".into(),
                profile_ids: vec![ProfileId::new("a")],
            },
            DataGroup {
                data_id: "b".into(),
                profile_ids: vec![ProfileId::new("b"), ProfileId::new("c")],
            },
        ];
        assert_eq!(
            selected_group(&groups, Some(&ProfileId::new("c"))).map(|g| g.data_id.as_str()),
            Some("b")
        );
        assert_eq!(
            selected_group(&groups, None).map(|g| g.data_id.as_str()),
            Some("a")
        );
    }
}
