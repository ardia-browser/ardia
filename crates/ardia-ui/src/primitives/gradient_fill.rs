use gpui::{
    App, Bounds, ContentMask, Element, ElementId, FadeEdge, GlobalElementId, Hsla,
    InspectorElementId, LayoutId, Pixels, Style, Window, fill, linear_color_stop, linear_gradient,
    point, size,
};
use smallvec::SmallVec;

use crate::primitives::edge_fade::ramp_mask;
use crate::scale::px;

pub type GradientStop = (f32, f32);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Segment {
    pub from: f32,
    pub to: f32,
    pub from_alpha: f32,
    pub to_alpha: f32,
}

pub fn segments(stops: &[GradientStop]) -> SmallVec<[Segment; 6]> {
    let mut sorted: SmallVec<[GradientStop; 6]> = stops
        .iter()
        .filter(|(at, alpha)| at.is_finite() && alpha.is_finite())
        .map(|(at, alpha)| (at.clamp(0.0, 1.0), alpha.clamp(0.0, 1.0)))
        .collect();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (Some(first), Some(last)) = (sorted.first().copied(), sorted.last().copied()) else {
        return smallvec::smallvec![Segment {
            from: 0.0,
            to: 1.0,
            from_alpha: 1.0,
            to_alpha: 1.0,
        }];
    };
    let mut out = SmallVec::new();
    let mut push = |from: f32, to: f32, from_alpha: f32, to_alpha: f32| {
        if to > from {
            out.push(Segment {
                from,
                to,
                from_alpha,
                to_alpha,
            });
        }
    };
    push(0.0, first.0, first.1, first.1);
    for pair in sorted.windows(2) {
        push(pair[0].0, pair[1].0, pair[0].1, pair[1].1);
    }
    push(last.0, 1.0, last.1, last.1);
    out
}

pub struct GradientFill {
    color: Hsla,
    stops: SmallVec<[Segment; 6]>,
    fade: SmallVec<[Segment; 6]>,
}

pub fn gradient_fill(color: impl Into<Hsla>, stops: &[GradientStop]) -> GradientFill {
    GradientFill {
        color: color.into(),
        stops: segments(stops),
        fade: segments(&[]),
    }
}

impl GradientFill {
    pub fn fade(mut self, fade: &[GradientStop]) -> Self {
        self.fade = segments(fade);
        self
    }
}

impl Element for GradientFill {
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
        let style = Style {
            position: gpui::Position::Absolute,
            inset: gpui::Edges {
                top: px(0.).into(),
                right: px(0.).into(),
                bottom: px(0.).into(),
                left: px(0.).into(),
            },
            ..Style::default()
        };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        _cx: &mut App,
    ) {
        let width = f32::from(bounds.size.width);
        let height = f32::from(bounds.size.height);
        if width <= 0.0 || height <= 0.0 {
            return;
        }
        for column in &self.fade {
            let peak = column.from_alpha.max(column.to_alpha);
            if peak <= 0.0 {
                continue;
            }
            let left = bounds.origin.x + px(column.from * width);
            let right = bounds.origin.x + px(column.to * width);
            let strip = Bounds::new(
                point(left, bounds.origin.y),
                size(right - left, bounds.size.height),
            );
            let low = column.from_alpha.min(column.to_alpha) / peak;
            let edge = if column.to_alpha < column.from_alpha {
                FadeEdge::Trailing
            } else {
                FadeEdge::Leading
            };
            let mask = ramp_mask(strip, edge, f32::from(strip.size.width), low);
            let color = self.color;
            let rows = self.stops.clone();
            let paint_rows = |window: &mut Window| {
                window.with_content_mask(Some(ContentMask { bounds: strip }), |window| {
                    for row in &rows {
                        let top = bounds.origin.y + px(row.from * height);
                        let bottom = bounds.origin.y + px(row.to * height);
                        let cell = Bounds::new(point(left, top), size(right - left, bottom - top));
                        let ink = |alpha: f32| color.opacity(alpha * peak);
                        window.paint_quad(fill(
                            cell,
                            linear_gradient(
                                180.,
                                linear_color_stop(ink(row.from_alpha), 0.),
                                linear_color_stop(ink(row.to_alpha), 1.),
                            ),
                        ));
                    }
                });
            };
            match mask {
                Some(mask) => window.with_fade_mask(mask, paint_rows),
                None => paint_rows(window),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stops_extend_their_end_colours_to_the_edges() {
        let parts = segments(&[(0.25, 0.0), (0.75, 1.0)]);
        assert_eq!(parts.len(), 3);
        assert_eq!(
            parts[0],
            Segment {
                from: 0.0,
                to: 0.25,
                from_alpha: 0.0,
                to_alpha: 0.0
            }
        );
        assert_eq!(
            parts[1],
            Segment {
                from: 0.25,
                to: 0.75,
                from_alpha: 0.0,
                to_alpha: 1.0
            }
        );
        assert_eq!(
            parts[2],
            Segment {
                from: 0.75,
                to: 1.0,
                from_alpha: 1.0,
                to_alpha: 1.0
            }
        );
    }

    #[test]
    fn no_stops_paint_solid_and_bad_stops_are_ignored() {
        let solid = segments(&[]);
        assert_eq!(solid.len(), 1);
        assert_eq!(solid[0].from_alpha, 1.0);
        let parts = segments(&[(1.0, 0.5), (f32::NAN, 1.0), (0.0, 2.0)]);
        assert_eq!(parts.len(), 1);
        assert_eq!(
            parts[0],
            Segment {
                from: 0.0,
                to: 1.0,
                from_alpha: 1.0,
                to_alpha: 0.5
            }
        );
    }
}
