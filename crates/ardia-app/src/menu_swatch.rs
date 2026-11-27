pub const SWATCH_POINTS: f64 = 12.0;
const SCALE: u32 = 2;
const STROKE_ALPHA: f64 = 0.15;

fn coverage(distance: f64, radius: f64) -> f64 {
    (radius - distance + 0.5).clamp(0.0, 1.0)
}

pub fn png(rgb: u32) -> Vec<u8> {
    let side = SWATCH_POINTS as u32 * SCALE;
    let scale = f64::from(SCALE);
    let centre = f64::from(side) / 2.0;
    let outer = centre - 0.5 * scale;
    let half_stroke = 0.5 * scale;
    let fill = [
        f64::from((rgb >> 16) & 0xff),
        f64::from((rgb >> 8) & 0xff),
        f64::from(rgb & 0xff),
    ];
    let mut pixels = image::RgbaImage::new(side, side);
    for (x, y, pixel) in pixels.enumerate_pixels_mut() {
        let dx = f64::from(x) + 0.5 - centre;
        let dy = f64::from(y) + 0.5 - centre;
        let distance = dx.hypot(dy);
        let fill_alpha = coverage(distance, outer);
        let ring =
            coverage(distance, outer + half_stroke) - coverage(distance, outer - half_stroke);
        let stroke_alpha = ring.clamp(0.0, 1.0) * STROKE_ALPHA;
        let alpha = stroke_alpha + fill_alpha * (1.0 - stroke_alpha);
        if alpha <= 0.0 {
            continue;
        }
        let mixed = |channel: f64| (channel * fill_alpha * (1.0 - stroke_alpha)) / alpha;
        *pixel = image::Rgba([
            mixed(fill[0]).round() as u8,
            mixed(fill[1]).round() as u8,
            mixed(fill[2]).round() as u8,
            (alpha * 255.0).round() as u8,
        ]);
    }
    let mut out = Vec::new();
    let encoded = image::DynamicImage::ImageRgba8(pixels)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png);
    if encoded.is_err() {
        return Vec::new();
    }
    out
}

#[cfg(target_os = "macos")]
pub fn image(rgb: u32) -> Option<objc2::rc::Retained<objc2_app_kit::NSImage>> {
    use objc2::AllocAnyThread;
    use objc2_app_kit::NSImage;
    use objc2_foundation::{NSData, NSSize};
    let bytes = png(rgb);
    if bytes.is_empty() {
        return None;
    }
    let data = NSData::with_bytes(&bytes);
    let image = NSImage::initWithData(NSImage::alloc(), &data)?;
    image.setSize(NSSize::new(SWATCH_POINTS, SWATCH_POINTS));
    Some(image)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_swatch_is_a_filled_circle_with_clear_corners() {
        let bytes = png(0x3366cc);
        let decoded = image::load_from_memory(&bytes).expect("png").to_rgba8();
        assert_eq!(decoded.dimensions(), (24, 24));
        assert_eq!(decoded.get_pixel(0, 0)[3], 0);
        let centre = decoded.get_pixel(12, 12);
        assert_eq!(
            [centre[0], centre[1], centre[2], centre[3]],
            [0x33, 0x66, 0xcc, 255]
        );
        let edge = decoded.get_pixel(12, 0);
        assert!(edge[3] > 0 && edge[3] < 255);
    }
}
