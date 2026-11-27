use gpui::{Div, ElementId, SharedString, div, prelude::*};

use crate::look::Look;
use crate::primitives::glass::{GlassState, control_glass, control_glass_on_surface};

pub const GLASS_CONTROL_GROUP: &str = "glass-control";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlassBacking {
    Native,
    Surface,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GlassStates {
    pub rest: Option<GlassState>,
    pub lit: GlassState,
    pub pressed: Option<GlassState>,
}

impl GlassStates {
    pub const TILE: GlassStates = GlassStates {
        rest: Some(GlassState::Rest),
        lit: GlassState::Lit,
        pressed: Some(GlassState::Pressed),
    };
    pub const ROW: GlassStates = GlassStates {
        rest: None,
        lit: GlassState::Lit,
        pressed: Some(GlassState::Pressed),
    };
    pub const HOVER_ONLY: GlassStates = GlassStates {
        rest: Some(GlassState::Rest),
        lit: GlassState::Lit,
        pressed: None,
    };
    pub const LIT_ROW: GlassStates = GlassStates {
        rest: None,
        lit: GlassState::Lit,
        pressed: None,
    };

    pub const fn held(state: GlassState) -> GlassStates {
        GlassStates {
            rest: Some(state),
            lit: state,
            pressed: None,
        }
    }
}

pub fn glass_layer(look: &Look, radius: f32, state: GlassState, backing: GlassBacking) -> Div {
    match backing {
        GlassBacking::Native => control_glass(look, radius, state),
        GlassBacking::Surface => control_glass_on_surface(look, radius, state),
    }
}

fn layer_id(name: &'static str) -> ElementId {
    ElementId::Name(SharedString::new_static(name))
}

pub fn stateful_glass(look: &Look, radius: f32, states: GlassStates, backing: GlassBacking) -> Div {
    stateful_glass_in(
        SharedString::new_static(GLASS_CONTROL_GROUP),
        look,
        radius,
        states,
        backing,
    )
}

pub fn stateful_glass_in(
    group: SharedString,
    look: &Look,
    radius: f32,
    states: GlassStates,
    backing: GlassBacking,
) -> Div {
    let pressable = states.pressed.is_some();
    if states.rest == Some(states.lit) && !pressable {
        return div()
            .absolute()
            .inset_0()
            .child(glass_layer(look, radius, states.lit, backing));
    }
    div()
        .absolute()
        .inset_0()
        .when_some(states.rest, |this, rest| {
            this.child(
                div()
                    .id(layer_id("glass-rest"))
                    .absolute()
                    .inset_0()
                    .group_hover(group.clone(), |s| s.opacity(0.))
                    .when(pressable, |this| {
                        this.group_active(group.clone(), |s| s.opacity(0.))
                    })
                    .child(glass_layer(look, radius, rest, backing)),
            )
        })
        .child(
            div()
                .id(layer_id("glass-lit"))
                .absolute()
                .inset_0()
                .opacity(0.)
                .group_hover(group.clone(), |s| s.opacity(1.))
                .when(pressable, |this| {
                    this.group_active(group.clone(), |s| s.opacity(0.))
                })
                .child(glass_layer(look, radius, states.lit, backing)),
        )
        .when_some(states.pressed, |this, pressed| {
            this.child(
                div()
                    .id(layer_id("glass-pressed"))
                    .absolute()
                    .inset_0()
                    .opacity(0.)
                    .group_hover(group.clone(), |s| s)
                    .group_active(group.clone(), |s| s.opacity(1.))
                    .child(glass_layer(look, radius, pressed, backing)),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tile_shows_rest_lit_and_pressed_glass() {
        let tile = GlassStates::TILE;
        assert_eq!(tile.rest, Some(GlassState::Rest));
        assert_eq!(tile.lit, GlassState::Lit);
        assert_eq!(tile.pressed, Some(GlassState::Pressed));
    }

    #[test]
    fn a_row_has_no_glass_until_it_is_lit() {
        assert_eq!(GlassStates::ROW.rest, None);
        assert_eq!(GlassStates::LIT_ROW.pressed, None);
    }

    #[test]
    fn an_open_control_holds_one_state() {
        let held = GlassStates::held(GlassState::Pressed);
        assert_eq!(held.rest, Some(GlassState::Pressed));
        assert_eq!(held.lit, GlassState::Pressed);
        assert_eq!(held.pressed, None);
    }
}
