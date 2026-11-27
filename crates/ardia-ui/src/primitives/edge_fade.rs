use gpui::{
    AnyElement, App, Bounds, Element, ElementId, FadeEdge, FadeMask, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, Pixels, Window, point, size,
};

use crate::scale::px;

pub const EDGE_FADE_WIDTH: f32 = 88.0;
pub const EDGE_FADE_FLOOR: f32 = 0.25;
pub const EDGE_FADE_ONSET: f32 = 24.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EdgeFadeLook {
    pub width: f32,
    pub floor: f32,
    pub onset: f32,
}

impl Default for EdgeFadeLook {
    fn default() -> Self {
        EdgeFadeLook {
            width: EDGE_FADE_WIDTH,
            floor: EDGE_FADE_FLOOR,
            onset: EDGE_FADE_ONSET,
        }
    }
}

impl EdgeFadeLook {
    pub fn strengths(&self, offset: f32, viewport: f32, content: f32) -> (f32, f32) {
        if self.onset <= 0.0 {
            return (0.0, 0.0);
        }
        let last = (content - viewport).max(0.0);
        (
            (offset / self.onset).clamp(0.0, 1.0),
            ((last - offset) / self.onset).clamp(0.0, 1.0),
        )
    }

    pub fn edge_alpha(&self, strength: f32) -> f32 {
        1.0 - (1.0 - self.floor) * strength.clamp(0.0, 1.0)
    }

    pub fn mask(&self, bounds: Bounds<Pixels>, edge: FadeEdge, strength: f32) -> Option<FadeMask> {
        let extent = f32::from(match edge {
            FadeEdge::Leading | FadeEdge::Trailing => bounds.size.width,
            FadeEdge::Top | FadeEdge::Bottom => bounds.size.height,
        });
        ramp_mask(
            bounds,
            edge,
            self.width.min(extent / 2.0),
            self.edge_alpha(strength),
        )
    }
}

pub fn ramp_mask(
    bounds: Bounds<Pixels>,
    edge: FadeEdge,
    ramp: f32,
    edge_alpha: f32,
) -> Option<FadeMask> {
    let extent = f32::from(match edge {
        FadeEdge::Leading | FadeEdge::Trailing => bounds.size.width,
        FadeEdge::Top | FadeEdge::Bottom => bounds.size.height,
    });
    if edge_alpha >= 1.0 || extent <= 0.0 || ramp <= 0.0 {
        return None;
    }
    let edge_alpha = edge_alpha.max(0.0);
    let length = ramp / (1.0 - edge_alpha);
    let beyond = px(edge_alpha * length);
    let (origin, grown) = match edge {
        FadeEdge::Leading => (
            point(bounds.origin.x - beyond, bounds.origin.y),
            size(bounds.size.width + beyond, bounds.size.height),
        ),
        FadeEdge::Trailing => (
            bounds.origin,
            size(bounds.size.width + beyond, bounds.size.height),
        ),
        FadeEdge::Top => (
            point(bounds.origin.x, bounds.origin.y - beyond),
            size(bounds.size.width, bounds.size.height + beyond),
        ),
        FadeEdge::Bottom => (
            bounds.origin,
            size(bounds.size.width, bounds.size.height + beyond),
        ),
    };
    Some(FadeMask {
        bounds: Bounds::new(origin, grown),
        edge,
        length: px(length),
    })
}

pub struct EdgeFade {
    child: AnyElement,
    look: EdgeFadeLook,
    vertical: bool,
    start: f32,
    end: f32,
}

pub fn edge_fade(child: impl IntoElement, start: f32, end: f32) -> EdgeFade {
    EdgeFade {
        child: child.into_any_element(),
        look: EdgeFadeLook::default(),
        vertical: false,
        start,
        end,
    }
}

impl EdgeFade {
    pub fn look(mut self, look: EdgeFadeLook) -> Self {
        self.look = look;
        self
    }

    pub fn vertical(mut self) -> Self {
        self.vertical = true;
        self
    }

    fn edges(&self) -> (FadeEdge, FadeEdge) {
        if self.vertical {
            (FadeEdge::Top, FadeEdge::Bottom)
        } else {
            (FadeEdge::Leading, FadeEdge::Trailing)
        }
    }
}

impl Element for EdgeFade {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let (lead, trail) = self.edges();
        let lead = self.look.mask(bounds, lead, self.start);
        let trail = self.look.mask(bounds, trail, self.end);
        let child = &mut self.child;
        let mut paint_trail = |window: &mut Window, cx: &mut App| match trail {
            Some(mask) => window.with_fade_mask(mask, |window| child.paint(window, cx)),
            None => child.paint(window, cx),
        };
        match lead {
            Some(mask) => window.with_fade_mask(mask, |window| paint_trail(window, cx)),
            None => paint_trail(window, cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp_alpha(mask: &FadeMask, x: f32) -> f32 {
        let end = f32::from(match mask.edge {
            FadeEdge::Trailing => mask.bounds.right(),
            _ => mask.bounds.left(),
        });
        let remaining = match mask.edge {
            FadeEdge::Trailing => end - x,
            _ => x - end,
        };
        (remaining / f32::from(mask.length)).clamp(0.0, 1.0)
    }

    fn strip() -> Bounds<Pixels> {
        Bounds::new(point(px(10.), px(0.)), size(px(400.), px(30.)))
    }

    #[test]
    fn strengths_ramp_in_over_the_onset_like_the_old_strip() {
        let look = EdgeFadeLook::default();
        assert_eq!(look.strengths(0.0, 500.0, 500.0), (0.0, 0.0));
        assert_eq!(look.strengths(12.0, 500.0, 1000.0), (0.5, 1.0));
        assert_eq!(look.strengths(500.0, 500.0, 1000.0), (1.0, 0.0));
    }

    #[test]
    fn full_strength_edges_sink_to_the_floor_and_reach_full_ink_after_the_fade_width() {
        let look = EdgeFadeLook::default();
        let trail = look.mask(strip(), FadeEdge::Trailing, 1.0).unwrap();
        assert!((ramp_alpha(&trail, 410.0) - EDGE_FADE_FLOOR).abs() < 1e-4);
        assert!((ramp_alpha(&trail, 410.0 - EDGE_FADE_WIDTH) - 1.0).abs() < 1e-4);
        let mid = ramp_alpha(&trail, 410.0 - EDGE_FADE_WIDTH / 2.0);
        assert!((mid - (1.0 + EDGE_FADE_FLOOR) / 2.0).abs() < 1e-4);
        let lead = look.mask(strip(), FadeEdge::Leading, 0.5).unwrap();
        assert!((ramp_alpha(&lead, 10.0) - look.edge_alpha(0.5)).abs() < 1e-4);
        assert!((ramp_alpha(&lead, 98.0) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn quiet_edges_and_narrow_views_follow_the_gradient_stops() {
        let look = EdgeFadeLook::default();
        assert!(look.mask(strip(), FadeEdge::Leading, 0.0).is_none());
        let narrow = Bounds::new(point(px(0.), px(0.)), size(px(100.), px(30.)));
        let trail = look.mask(narrow, FadeEdge::Trailing, 1.0).unwrap();
        assert!((ramp_alpha(&trail, 50.0) - 1.0).abs() < 1e-4);
        assert!((ramp_alpha(&trail, 100.0) - EDGE_FADE_FLOOR).abs() < 1e-4);
    }
}
