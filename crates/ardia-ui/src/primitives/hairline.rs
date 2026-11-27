use gpui::{
    AnyElement, BorderStyle, Bounds, ContentMask, Hsla, IntoElement, Pixels, Rgba, Styled, canvas,
    point, px, quad, size, transparent_black,
};

pub const MAX_HAIRLINE_BANDS: usize = 256;

pub fn gradient_hairline(top: Hsla, bottom: Hsla, width: Pixels, radius: Pixels) -> AnyElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let bands = hairline_bands(f32::from(bounds.size.height), window.scale_factor());
            for (band, color) in hairline_strips(bounds, top, bottom, bands) {
                window.with_content_mask(Some(ContentMask { bounds: band }), |window| {
                    window.paint_quad(quad(
                        bounds,
                        radius,
                        transparent_black(),
                        width,
                        color,
                        BorderStyle::Solid,
                    ));
                });
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}

pub fn hairline_bands(height: f32, scale_factor: f32) -> usize {
    if !(height.is_finite() && scale_factor.is_finite() && height > 0.0 && scale_factor > 0.0) {
        return 0;
    }
    ((height * scale_factor).ceil() as usize).clamp(1, MAX_HAIRLINE_BANDS)
}

pub fn mix(top: Hsla, bottom: Hsla, t: f32) -> Hsla {
    let t = if t.is_finite() {
        t.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let a = Rgba::from(top);
    let b = Rgba::from(bottom);
    let lerp = |x: f32, y: f32| x + (y - x) * t;
    Hsla::from(Rgba {
        r: lerp(a.r, b.r),
        g: lerp(a.g, b.g),
        b: lerp(a.b, b.b),
        a: lerp(a.a, b.a),
    })
}

pub fn hairline_strips(
    bounds: Bounds<Pixels>,
    top: Hsla,
    bottom: Hsla,
    bands: usize,
) -> Vec<(Bounds<Pixels>, Hsla)> {
    let left = f32::from(bounds.origin.x) - 1.0;
    let width = f32::from(bounds.size.width) + 2.0;
    let y = f32::from(bounds.origin.y);
    let height = f32::from(bounds.size.height);
    if bands == 0 || height.is_nan() || height <= 0.0 {
        return Vec::new();
    }
    let step = height / bands as f32;
    (0..bands)
        .map(|i| {
            let y0 = y + i as f32 * step;
            let t = (i as f32 + 0.5) / bands as f32;
            (
                Bounds::new(point(px(left), px(y0)), size(px(width), px(step))),
                mix(top, bottom, t),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hairline_runs_from_its_top_colour_to_its_bottom_colour_down_the_row() {
        let white = Hsla::from(Rgba {
            r: 1.0,
            g: 1.0,
            b: 1.0,
            a: 0.98,
        });
        let black = Hsla::from(Rgba {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 0.06,
        });
        let bounds = Bounds::new(point(px(9.0), px(100.0)), size(px(200.0), px(34.0)));
        let strips = hairline_strips(bounds, white, black, hairline_bands(34.0, 2.0));
        assert_eq!(strips.len(), 68);
        let first = Rgba::from(strips[0].1);
        let last = Rgba::from(strips[67].1);
        assert!(first.r > 0.99 && (first.a - 0.973).abs() < 0.01);
        assert!(last.r < 0.01 && (last.a - 0.067).abs() < 0.01);
        let covered: f32 = strips.iter().map(|(b, _)| f32::from(b.size.height)).sum();
        assert!((covered - 34.0).abs() < 0.001);
        assert!(f32::from(strips[0].0.origin.x) < 9.0);
    }

    #[test]
    fn a_broken_size_draws_nothing() {
        assert_eq!(hairline_bands(f32::NAN, 2.0), 0);
        assert_eq!(hairline_bands(34.0, 0.0), 0);
        assert_eq!(hairline_bands(5000.0, 2.0), MAX_HAIRLINE_BANDS);
        let empty = Bounds::new(point(px(0.0), px(0.0)), size(px(10.0), px(0.0)));
        assert!(hairline_strips(empty, Hsla::white(), Hsla::black(), 4).is_empty());
    }
}
