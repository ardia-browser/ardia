use ardia_theme::RgbaColor;
use ardia_theme::color::{hsl_to_rgb, rgb_to_hsl};

pub const FILL_DARK: f32 = 0.28;
pub const FILL_LIGHT: f32 = 0.2;
pub const RING_DARK: f32 = 0.55;
pub const RING_LIGHT: f32 = 0.45;
pub const RING_WIDTH: f32 = 1.0;
pub const REST: f32 = 0.25;
pub const RISE_MS: u64 = 100;
pub const SETTLE_MS: u64 = 400;
pub const NEUTRAL_BELOW_SATURATION: f64 = 0.16;
const LUMINANCE_DARK: (f32, f32) = (0.16, 0.6);
const LUMINANCE_LIGHT: (f32, f32) = (0.06, 0.3);

const SITE_BRAND_COLORS: &[(&str, &str)] = &[
    ("youtube.com", "#FF0000"),
    ("google.com", "#4285F4"),
    ("maps.google.com", "#34A853"),
    ("drive.google.com", "#1FA463"),
    ("mail.google.com", "#EA4335"),
    ("translate.google.com", "#4285F4"),
    ("bing.com", "#008373"),
    ("duckduckgo.com", "#DE5833"),
    ("perplexity.ai", "#20808D"),
    ("chatgpt.com", "#10A37F"),
    ("ecosia.org", "#36ACB8"),
    ("search.brave.com", "#FB542B"),
    ("kagi.com", "#FFB319"),
    ("startpage.com", "#6573FF"),
    ("search.yahoo.com", "#6001D2"),
    ("baidu.com", "#2932E1"),
    ("yandex.com", "#FC3F1D"),
    ("wikipedia.org", "#000000"),
    ("github.com", "#181717"),
    ("amazon.com", "#FF9900"),
    ("reddit.com", "#FF4500"),
    ("x.com", "#000000"),
    ("twitter.com", "#000000"),
    ("stackoverflow.com", "#F48024"),
    ("npmjs.com", "#CB3837"),
    ("imdb.com", "#F5C518"),
    ("open.spotify.com", "#1DB954"),
    ("linkedin.com", "#0A66C2"),
    ("ebay.com", "#E53238"),
    ("pinterest.com", "#E60023"),
    ("news.ycombinator.com", "#FF6600"),
    ("developer.mozilla.org", "#000000"),
    ("figma.com", "#A259FF"),
    ("notion.so", "#000000"),
    ("apps.apple.com", "#0D96F6"),
];

pub fn brand_color_for(host: &str) -> Option<RgbaColor> {
    let lower = host.trim().to_lowercase();
    let mut h = lower.strip_prefix("www.").unwrap_or(&lower);
    while h.contains('.') {
        if let Some((_, hex)) = SITE_BRAND_COLORS.iter().find(|(site, _)| *site == h) {
            return RgbaColor::parse(hex);
        }
        h = &h[h.find('.').map_or(h.len(), |at| at + 1)..];
    }
    None
}

fn at_lightness(h: f64, s: f64, l: f64) -> RgbaColor {
    let (r, g, b) = hsl_to_rgb(h, s, l);
    RgbaColor::new(r as f32, g as f32, b as f32, 1.0).quantized()
}

pub fn pulse_ink(
    color: Option<RgbaColor>,
    dark: bool,
    neutral: RgbaColor,
    fallback: RgbaColor,
) -> RgbaColor {
    let Some(color) = color else {
        return fallback;
    };
    let (h, s, l) = rgb_to_hsl(f64::from(color.r), f64::from(color.g), f64::from(color.b));
    if s < NEUTRAL_BELOW_SATURATION {
        return neutral;
    }
    let (low, high) = if dark {
        LUMINANCE_DARK
    } else {
        LUMINANCE_LIGHT
    };
    let own = color.luminance();
    if own >= low && own <= high {
        return at_lightness(h, s, l);
    }
    let target = if own < low { low } else { high };
    let (mut from, mut to) = if own < low { (l, 1.0) } else { (0.0, l) };
    for _ in 0..16 {
        let mid = (from + to) / 2.0;
        if at_lightness(h, s, mid).luminance() < target {
            from = mid;
        } else {
            to = mid;
        }
    }
    at_lightness(h, s, if own < low { to } else { from })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brand_colors_match_the_host_or_a_parent() {
        assert_eq!(
            brand_color_for("www.youtube.com"),
            RgbaColor::parse("#FF0000")
        );
        assert_eq!(
            brand_color_for("music.youtube.com"),
            RgbaColor::parse("#FF0000")
        );
        assert_eq!(brand_color_for("example.com"), None);
    }

    #[test]
    fn grey_brands_use_the_neutral_ink_and_dim_brands_are_lifted() {
        let neutral = RgbaColor::new(1.0, 1.0, 1.0, 1.0);
        let fallback = RgbaColor::new(0.5, 0.2, 0.9, 1.0);
        assert_eq!(
            pulse_ink(RgbaColor::parse("#181717"), true, neutral, fallback),
            neutral
        );
        assert_eq!(pulse_ink(None, true, neutral, fallback), fallback);
        let lifted = pulse_ink(RgbaColor::parse("#2932E1"), true, neutral, fallback);
        assert!(lifted.luminance() >= 0.15);
    }
}
