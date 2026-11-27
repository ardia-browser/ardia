use crate::color::RgbaColor;
use crate::tokens::{self, ColorRoles};

pub const MAX_THEME_SIDE: usize = 32;
pub const OPAQUE_ALPHA: f32 = 0.975;
pub const COLORFUL_DISTANCE: f32 = 0.055;
pub const NEAR_WHITE_LUMINANCE: f32 = 0.88;
pub const NEAR_BLACK_LUMINANCE: f32 = 0.01;
pub const RING_WIDTH: f32 = 3.0;
pub const BLUR_RADIUS: f32 = 5.0;
pub const BLUR_FILL_SCALE: f32 = 2.5;
pub const BLUR_IMAGE_OPACITY: f32 = 0.22;
pub const EMOJI_POINTS: f32 = 16.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum IconTheme {
    Blur { mean: RgbaColor, spread: f32 },
    Template { mean: RgbaColor, spread: f32 },
    Default,
}

#[derive(Clone, Copy, Debug)]
pub struct IconPixels<'a> {
    pub width: usize,
    pub height: usize,
    pub rgba: &'a [u8],
}

impl IconPixels<'_> {
    fn valid(&self) -> bool {
        self.width > 0
            && self.height > 0
            && self
                .width
                .checked_mul(self.height)
                .and_then(|n| n.checked_mul(4))
                .is_some_and(|n| self.rgba.len() >= n)
    }

    fn sample(&self, x: usize, y: usize) -> [f32; 4] {
        let i = (y * self.width + x) * 4;
        let px = &self.rgba[i..i + 4];
        [
            f32::from(px[0]) / 255.0,
            f32::from(px[1]) / 255.0,
            f32::from(px[2]) / 255.0,
            f32::from(px[3]) / 255.0,
        ]
    }
}

fn downscaled(icon: &IconPixels<'_>) -> Vec<[f32; 4]> {
    let long = icon.width.max(icon.height);
    if long <= MAX_THEME_SIDE {
        return (0..icon.height)
            .flat_map(|y| (0..icon.width).map(move |x| (x, y)))
            .map(|(x, y)| icon.sample(x, y))
            .collect();
    }
    let scale = MAX_THEME_SIDE as f64 / long as f64;
    let tw = ((icon.width as f64 * scale).round() as usize).max(1);
    let th = ((icon.height as f64 * scale).round() as usize).max(1);
    let mut out = Vec::with_capacity(tw * th);
    for ty in 0..th {
        let y0 = ty * icon.height / th;
        let y1 = ((ty + 1) * icon.height / th).max(y0 + 1);
        for tx in 0..tw {
            let x0 = tx * icon.width / tw;
            let x1 = ((tx + 1) * icon.width / tw).max(x0 + 1);
            let mut sum = [0f64; 4];
            for y in y0..y1 {
                for x in x0..x1 {
                    let [r, g, b, a] = icon.sample(x, y);
                    let a = f64::from(a);
                    sum[0] += f64::from(r) * a;
                    sum[1] += f64::from(g) * a;
                    sum[2] += f64::from(b) * a;
                    sum[3] += a;
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f64;
            let alpha = sum[3] / n;
            let straight = |c: f64| {
                if sum[3] > 0.0 {
                    (c / sum[3]) as f32
                } else {
                    0.0
                }
            };
            out.push([
                straight(sum[0]),
                straight(sum[1]),
                straight(sum[2]),
                alpha as f32,
            ]);
        }
    }
    out
}

pub fn classify_icon(icon: IconPixels<'_>) -> IconTheme {
    if !icon.valid() {
        return IconTheme::Default;
    }
    let pixels = downscaled(&icon);
    let opaque: Vec<[f64; 3]> = pixels
        .iter()
        .filter(|p| p[3] >= OPAQUE_ALPHA)
        .map(|p| [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])])
        .collect();
    if opaque.is_empty() {
        return IconTheme::Default;
    }
    let n = opaque.len() as f64;
    let mean = opaque.iter().fold([0.0; 3], |acc, p| {
        [acc[0] + p[0] / n, acc[1] + p[1] / n, acc[2] + p[2] / n]
    });
    let spread = opaque
        .iter()
        .map(|p| {
            ((p[0] - mean[0]).powi(2) + (p[1] - mean[1]).powi(2) + (p[2] - mean[2]).powi(2)).sqrt()
        })
        .sum::<f64>()
        / n;
    let mean = RgbaColor::new(mean[0] as f32, mean[1] as f32, mean[2] as f32, 1.0);
    let spread = spread as f32;
    if spread >= COLORFUL_DISTANCE {
        IconTheme::Blur { mean, spread }
    } else {
        IconTheme::Template { mean, spread }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DockFill {
    BlurredIcon {
        base: RgbaColor,
        image_opacity: f32,
        image_scale: f32,
        blur_radius: f32,
    },
    Solid(RgbaColor),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DockRing {
    BlurredIcon {
        width: f32,
        backing: RgbaColor,
        image_opacity: f32,
        saturation: f32,
        brightness: f32,
    },
    SoftLight {
        color: RgbaColor,
        width: f32,
    },
    Solid {
        color: RgbaColor,
        width: f32,
    },
    Rim {
        rim: RgbaColor,
        outline: RgbaColor,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DockGlyph {
    Icon,
    WhiteTemplate,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DockSelection {
    pub fill: DockFill,
    pub ring: DockRing,
    pub glyph: DockGlyph,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum SelectionStyle {
    #[default]
    Classic,
    Glass,
}

pub fn dock_selection(
    theme: IconTheme,
    roles: &ColorRoles,
    style: SelectionStyle,
) -> DockSelection {
    let dark = roles.dark;
    match theme {
        IconTheme::Blur { .. } => DockSelection {
            fill: DockFill::BlurredIcon {
                base: if dark {
                    RgbaColor::white(0.2)
                } else {
                    RgbaColor::WHITE
                },
                image_opacity: BLUR_IMAGE_OPACITY,
                image_scale: BLUR_FILL_SCALE,
                blur_radius: BLUR_RADIUS,
            },
            ring: if dark {
                DockRing::BlurredIcon {
                    width: RING_WIDTH,
                    backing: RgbaColor::BLACK,
                    image_opacity: 0.75,
                    saturation: 2.0,
                    brightness: -0.1,
                }
            } else {
                DockRing::BlurredIcon {
                    width: RING_WIDTH,
                    backing: RgbaColor::WHITE,
                    image_opacity: 1.0,
                    saturation: 1.0,
                    brightness: 0.0,
                }
            },
            glyph: DockGlyph::Icon,
        },
        IconTheme::Template { mean, .. } => {
            let luminance = mean.luminance();
            if luminance > NEAR_WHITE_LUMINANCE {
                DockSelection {
                    fill: DockFill::Solid(RgbaColor::BLACK),
                    ring: DockRing::Solid {
                        color: RgbaColor::white(0.3),
                        width: RING_WIDTH,
                    },
                    glyph: DockGlyph::WhiteTemplate,
                }
            } else if luminance < NEAR_BLACK_LUMINANCE && style == SelectionStyle::Classic {
                DockSelection {
                    fill: DockFill::Solid(mean),
                    ring: DockRing::Solid {
                        color: RgbaColor::white(0.3),
                        width: RING_WIDTH,
                    },
                    glyph: DockGlyph::WhiteTemplate,
                }
            } else {
                DockSelection {
                    fill: DockFill::Solid(mean),
                    ring: DockRing::SoftLight {
                        color: RgbaColor::WHITE,
                        width: RING_WIDTH,
                    },
                    glyph: DockGlyph::WhiteTemplate,
                }
            }
        }
        IconTheme::Default => DockSelection {
            fill: DockFill::Solid(roles.pinned_selected_fill),
            ring: DockRing::Rim {
                rim: roles.pinned_selected_rim,
                outline: roles.pinned_selected_outline,
            },
            glyph: DockGlyph::Icon,
        },
    }
}

pub fn dia_default_selection(dark: bool) -> DockSelection {
    let dia = tokens::dia(dark);
    DockSelection {
        fill: DockFill::Solid(dia.tab_background_selected_primary),
        ring: DockRing::Solid {
            color: dia.dock_item_default_selection_stroke,
            width: RING_WIDTH,
        },
        glyph: DockGlyph::Icon,
    }
}

pub fn secondary_selection_fill(dark: bool) -> RgbaColor {
    tokens::dia(dark).tab_background_selected_secondary
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: usize, height: usize, px: [u8; 4]) -> Vec<u8> {
        std::iter::repeat_n(px, width * height).flatten().collect()
    }

    #[test]
    fn one_colour_icons_become_templates() {
        let red = solid(16, 16, [230, 30, 40, 255]);
        let theme = classify_icon(IconPixels {
            width: 16,
            height: 16,
            rgba: &red,
        });
        let IconTheme::Template { mean, spread } = theme else {
            panic!("{theme:?}")
        };
        assert_eq!(mean.to_u8(), [230, 30, 40, 255]);
        assert!(spread < 1e-6);
        let selection = dock_selection(theme, &tokens::DARK, SelectionStyle::Classic);
        assert_eq!(selection.glyph, DockGlyph::WhiteTemplate);
        assert!(matches!(selection.ring, DockRing::SoftLight { .. }));
    }

    #[test]
    fn colourful_icons_blur_into_the_tile() {
        let mut halves = solid(16, 16, [255, 0, 0, 255]);
        for px in halves.chunks_mut(4).skip(128) {
            px.copy_from_slice(&[0, 0, 255, 255]);
        }
        let theme = classify_icon(IconPixels {
            width: 16,
            height: 16,
            rgba: &halves,
        });
        assert!(matches!(theme, IconTheme::Blur { spread, .. } if spread >= COLORFUL_DISTANCE));
        let dark = dock_selection(theme, &tokens::DARK, SelectionStyle::Classic);
        assert!(
            matches!(dark.ring, DockRing::BlurredIcon { backing, saturation, .. } if backing == RgbaColor::BLACK && saturation == 2.0)
        );
        let light = dock_selection(theme, &tokens::LIGHT, SelectionStyle::Classic);
        assert!(
            matches!(light.fill, DockFill::BlurredIcon { base, .. } if base == RgbaColor::WHITE)
        );
    }

    #[test]
    fn near_white_and_near_black_guards() {
        let white = solid(8, 8, [252, 252, 252, 255]);
        let theme = classify_icon(IconPixels {
            width: 8,
            height: 8,
            rgba: &white,
        });
        let selection = dock_selection(theme, &tokens::DARK, SelectionStyle::Classic);
        assert_eq!(selection.fill, DockFill::Solid(RgbaColor::BLACK));
        assert_eq!(
            selection.ring,
            DockRing::Solid {
                color: RgbaColor::white(0.3),
                width: RING_WIDTH
            }
        );
        let black = solid(8, 8, [0, 0, 0, 255]);
        let theme = classify_icon(IconPixels {
            width: 8,
            height: 8,
            rgba: &black,
        });
        assert!(matches!(
            dock_selection(theme, &tokens::DARK, SelectionStyle::Classic).ring,
            DockRing::Solid { .. }
        ));
        assert!(matches!(
            dock_selection(theme, &tokens::DARK, SelectionStyle::Glass).ring,
            DockRing::SoftLight { .. }
        ));
    }

    #[test]
    fn translucent_or_broken_icons_fall_back_to_default() {
        let faint = solid(8, 8, [200, 10, 10, 200]);
        assert_eq!(
            classify_icon(IconPixels {
                width: 8,
                height: 8,
                rgba: &faint
            }),
            IconTheme::Default
        );
        assert_eq!(
            classify_icon(IconPixels {
                width: 8,
                height: 8,
                rgba: &faint[..10]
            }),
            IconTheme::Default
        );
        assert_eq!(
            classify_icon(IconPixels {
                width: 0,
                height: 8,
                rgba: &faint
            }),
            IconTheme::Default
        );
        assert_eq!(
            classify_icon(IconPixels {
                width: usize::MAX,
                height: 3,
                rgba: &faint
            }),
            IconTheme::Default
        );
        let selection = dock_selection(IconTheme::Default, &tokens::DARK, SelectionStyle::Classic);
        assert_eq!(
            selection.fill,
            DockFill::Solid(tokens::DARK.pinned_selected_fill)
        );
        assert_eq!(
            dia_default_selection(true).fill,
            DockFill::Solid(RgbaColor::BLACK)
        );
    }

    #[test]
    fn large_icons_are_box_filtered_to_thirty_two_pixels() {
        let mut big = solid(128, 64, [10, 200, 90, 255]);
        for (i, px) in big.chunks_mut(4).enumerate() {
            if i % 128 < 2 {
                px[3] = 0;
            }
        }
        let theme = classify_icon(IconPixels {
            width: 128,
            height: 64,
            rgba: &big,
        });
        let IconTheme::Template { mean, .. } = theme else {
            panic!("{theme:?}")
        };
        assert_eq!(mean.to_u8(), [10, 200, 90, 255]);
    }
}
