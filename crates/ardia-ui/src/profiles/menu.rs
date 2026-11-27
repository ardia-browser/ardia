use ardia_state::{Action, BrowserState, ProfileId, ProfilePatch};
use ardia_theme::ProfileColor;

use crate::icon_picker::Anchor;
use crate::msg::Msg;
use crate::popovers::context_menu::{MenuEntry, MenuItem, sections};
use crate::primitives::icons::Icon;
use crate::primitives::theme_bridge::hsla;
use crate::profiles::layer::{PeopleMsg, ProfilePlace};
use crate::settings::rows::Pane;

pub fn icon_title(has_icon: bool) -> &'static str {
    if has_icon {
        "Change Icon…"
    } else {
        "Add Icon…"
    }
}

pub fn profile_item_menu(
    state: &BrowserState,
    profile: &ProfileId,
    anchor: Option<Anchor>,
) -> Vec<MenuEntry> {
    let Some(found) = state.profile(profile.as_str()) else {
        return Vec::new();
    };
    let current = found.color.preset();
    let colors = ProfileColor::ALL
        .into_iter()
        .map(|color| {
            MenuItem::new(format!("profile-color:{}", color.key()), color.spec().name)
                .swatch(Some(hsla(color.spec().swatch)))
                .checked(color == current && found.theme.is_none())
                .msg(Msg::Store(Action::UpdateProfile {
                    profile: profile.clone(),
                    patch: ProfilePatch {
                        color: Some(color),
                        ..ProfilePatch::default()
                    },
                }))
                .entry()
        })
        .collect();
    sections(vec![
        vec![
            MenuItem::new("profile-rename", "Rename…")
                .icon(Icon::Pencil)
                .msg(Msg::People(PeopleMsg::Rename(profile.clone())))
                .entry(),
            MenuItem::new("profile-icon", icon_title(found.icon.is_some()))
                .icon(Icon::Photo)
                .msg(Msg::People(PeopleMsg::AnchorAt(anchor)))
                .msg(Msg::People(PeopleMsg::OpenIconPicker {
                    profile: profile.clone(),
                    place: ProfilePlace::Sidebar,
                }))
                .entry(),
            MenuEntry::submenu("profile-color", "Color", Some(Icon::Palette), colors),
        ],
        vec![
            MenuItem::new("profile-settings", "Profile Settings…")
                .icon(Icon::Gear)
                .msg(Msg::SettingsAt(Pane::Profiles))
                .entry(),
        ],
    ])
}

pub fn anchor_at(at: Option<gpui::Point<gpui::Pixels>>) -> Option<Anchor> {
    at.map(|at| Anchor {
        x: crate::scale::points(at.x),
        y: crate::scale::points(at.y),
        width: 0.0,
        height: 0.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::popovers::context_menu::{find, titles};
    use ardia_state::profiles::Profile;
    use std::sync::Arc;

    #[test]
    fn sidebar_item_menu_matches_the_old_order() {
        let mut state = BrowserState::default();
        let id = ProfileId::new("work");
        let mut profile = Profile::new(id.clone(), "Work", ProfileColor::Blue, Default::default());
        Arc::make_mut(&mut state.profiles).insert(id.clone(), Arc::new(profile.clone()));
        let menu = profile_item_menu(&state, &id, None);
        assert_eq!(
            titles(&menu),
            vec!["Rename…", "Add Icon…", "Color", "-", "Profile Settings…"]
        );
        let Some(MenuEntry::Submenu(colors)) = find(&menu, &["Color"]) else {
            panic!("no color submenu");
        };
        assert_eq!(colors.children.len(), 9);
        assert!(matches!(
            find(&menu, &["Color", "Blue"]),
            Some(MenuEntry::Item(item)) if item.checked
        ));
        profile.icon = Some("🏠".into());
        Arc::make_mut(&mut state.profiles).insert(id.clone(), Arc::new(profile));
        assert_eq!(
            titles(&profile_item_menu(&state, &id, None))[1],
            "Change Icon…"
        );
        assert!(profile_item_menu(&state, &ProfileId::new("gone"), None).is_empty());
    }
}
