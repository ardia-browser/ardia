use gpui::{
    AnyElement, Bounds, BoxShadow, ContentMask, Corners, IntoElement, Pixels, Styled, Window,
    canvas, point, px, size,
};

pub const MAX_CORNER_BANDS: usize = 64;

pub fn outer_glow(radius: Pixels, shadows: Vec<BoxShadow>) -> AnyElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| paint_outer_glow(window, bounds, radius, &shadows),
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}

pub fn paint_outer_glow(
    window: &mut Window,
    bounds: Bounds<Pixels>,
    radius: Pixels,
    shadows: &[BoxShadow],
) {
    let outset = shadows
        .iter()
        .filter(|s| !s.inset)
        .map(|s| {
            f32::from(s.blur_radius) * 3.0
                + f32::from(s.spread_radius).abs()
                + f32::from(s.offset.x).abs()
                + f32::from(s.offset.y).abs()
                + 4.0
        })
        .fold(0.0_f32, f32::max);
    if outset <= 0.0 {
        return;
    }
    let bands = corner_bands(f32::from(radius), window.scale_factor());
    for region in outside_regions(bounds, f32::from(radius), outset, bands) {
        window.with_content_mask(Some(ContentMask { bounds: region }), |window| {
            window.paint_drop_shadows(bounds, Corners::all(radius), shadows);
        });
    }
}

pub fn corner_bands(radius: f32, scale_factor: f32) -> usize {
    if !radius.is_finite() || !scale_factor.is_finite() || radius <= 0.0 || scale_factor <= 0.0 {
        return 0;
    }
    ((radius * scale_factor).ceil() as usize).clamp(1, MAX_CORNER_BANDS)
}

pub fn outside_regions(
    bounds: Bounds<Pixels>,
    radius: f32,
    outset: f32,
    bands: usize,
) -> Vec<Bounds<Pixels>> {
    let left = f32::from(bounds.origin.x);
    let top = f32::from(bounds.origin.y);
    let width = f32::from(bounds.size.width);
    let height = f32::from(bounds.size.height);
    if !(width > 0.0 && height > 0.0 && outset > 0.0) {
        return Vec::new();
    }
    let right = left + width;
    let bottom = top + height;
    let r = radius.clamp(0.0, width.min(height) / 2.0);
    let rect = |x0: f32, y0: f32, x1: f32, y1: f32| {
        Bounds::new(point(px(x0), px(y0)), size(px(x1 - x0), px(y1 - y0)))
    };
    let mut regions = vec![
        rect(left - outset, top - outset, right + outset, top),
        rect(left - outset, bottom, right + outset, bottom + outset),
        rect(left - outset, top, left, bottom),
        rect(right, top, right + outset, bottom),
    ];
    if r <= 0.0 || bands == 0 {
        return regions;
    }
    let band = r / bands as f32;
    for k in 0..bands {
        let near = k as f32 * band;
        let far = near + band;
        let rise = r - far;
        let notch = r - (r * r - rise * rise).max(0.0).sqrt();
        if notch <= 0.0 {
            continue;
        }
        regions.push(rect(left, top + near, left + notch, top + far));
        regions.push(rect(right - notch, top + near, right, top + far));
        regions.push(rect(left, bottom - far, left + notch, bottom - near));
        regions.push(rect(right - notch, bottom - far, right, bottom - near));
    }
    regions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inside_rounded(x: f32, y: f32, b: (f32, f32, f32, f32), r: f32) -> bool {
        let (l, t, w, h) = b;
        if x <= l || y <= t || x >= l + w || y >= t + h {
            return false;
        }
        let cx = x.clamp(l + r, l + w - r);
        let cy = y.clamp(t + r, t + h - r);
        (x - cx).powi(2) + (y - cy).powi(2) < r * r
    }

    fn covered(regions: &[Bounds<Pixels>], x: f32, y: f32) -> bool {
        regions.iter().any(|b| {
            let x0 = f32::from(b.origin.x);
            let y0 = f32::from(b.origin.y);
            x > x0
                && y > y0
                && x < x0 + f32::from(b.size.width)
                && y < y0 + f32::from(b.size.height)
        })
    }

    #[test]
    fn the_glow_never_lights_the_row_it_surrounds_and_reaches_all_around_it() {
        let shape = (9.0, 100.0, 222.0, 34.0);
        let bounds = Bounds::new(point(px(9.0), px(100.0)), size(px(222.0), px(34.0)));
        let regions = outside_regions(bounds, 10.0, 49.0, corner_bands(10.0, 2.0));
        let mut step = 0;
        for yi in 0..400 {
            for xi in 0..700 {
                let x = -40.0 + xi as f32 * 0.5 + 0.13;
                let y = 50.0 + yi as f32 * 0.35 + 0.07;
                let inside = inside_rounded(x, y, shape, 10.0);
                let lit = covered(&regions, x, y);
                assert!(!(inside && lit), "lit inside the row at {x},{y}");
                step += 1;
            }
        }
        assert!(step > 0);
        for (x, y) in [(0.0, 117.0), (240.0, 117.0), (100.0, 90.0), (100.0, 140.0)] {
            assert!(covered(&regions, x, y), "dark outside the row at {x},{y}");
        }
        assert!(
            covered(&regions, 9.6, 100.6),
            "the corner outside the curve still glows"
        );
    }

    #[test]
    fn a_square_or_empty_shape_needs_no_corner_bands() {
        let bounds = Bounds::new(point(px(0.0), px(0.0)), size(px(10.0), px(10.0)));
        assert_eq!(outside_regions(bounds, 0.0, 5.0, 8).len(), 4);
        let empty = Bounds::new(point(px(0.0), px(0.0)), size(px(0.0), px(10.0)));
        assert!(outside_regions(empty, 4.0, 5.0, 8).is_empty());
        assert_eq!(corner_bands(f32::NAN, 2.0), 0);
        assert_eq!(corner_bands(10.0, 2.0), 20);
        assert_eq!(corner_bands(1000.0, 2.0), MAX_CORNER_BANDS);
    }
}
