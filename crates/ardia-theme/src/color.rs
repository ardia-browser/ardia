use std::fmt;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct RgbaColor {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hsl {
    pub h: f32,
    pub s: f32,
    pub l: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklab {
    pub l: f32,
    pub a: f32,
    pub b: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ColorSpace {
    Srgb,
    DisplayP3,
}

const LINEAR_P3_TO_SRGB: [[f64; 3]; 3] = [
    [1.224_940_176_280_559_8, -0.224_940_176_280_559_96, 0.0],
    [-0.042_056_954_709_688_16, 1.042_056_954_709_688, 0.0],
    [
        -0.019_637_554_590_334_432,
        -0.078_636_045_550_631_89,
        1.098_273_600_140_966_3,
    ],
];

const LINEAR_SRGB_TO_P3: [[f64; 3]; 3] = [
    [0.822_461_968_714_362_3, 0.177_538_031_285_637_75, 0.0],
    [0.033_194_198_850_778_32, 0.966_805_801_149_221_7, 0.0],
    [
        0.017_082_630_745_242_983,
        0.072_397_440_179_199_88,
        0.910_519_929_075_557_1,
    ],
];

const FARTHEST_RGB: f64 = 1.732_050_807_568_877_2;

impl RgbaColor {
    pub const TRANSPARENT: Self = Self::new(0.0, 0.0, 0.0, 0.0);
    pub const BLACK: Self = Self::new(0.0, 0.0, 0.0, 1.0);
    pub const WHITE: Self = Self::new(1.0, 1.0, 1.0, 1.0);

    pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }

    pub const fn rgb8(r: u8, g: u8, b: u8) -> Self {
        Self::new(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0)
    }

    pub const fn rgba8(r: u8, g: u8, b: u8, alpha: f32) -> Self {
        Self::new(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, alpha)
    }

    pub const fn hex(rgb: u32) -> Self {
        Self::rgb8((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
    }

    pub const fn hexa(rgba: u32) -> Self {
        Self::new(
            ((rgba >> 24) & 0xFF) as f32 / 255.0,
            ((rgba >> 16) & 0xFF) as f32 / 255.0,
            ((rgba >> 8) & 0xFF) as f32 / 255.0,
            (rgba & 0xFF) as f32 / 255.0,
        )
    }

    pub const fn white(alpha: f32) -> Self {
        Self::new(1.0, 1.0, 1.0, alpha)
    }

    pub const fn black(alpha: f32) -> Self {
        Self::new(0.0, 0.0, 0.0, alpha)
    }

    pub const fn gray(level: f32) -> Self {
        Self::new(level, level, level, 1.0)
    }

    pub const fn with_alpha(self, a: f32) -> Self {
        Self::new(self.r, self.g, self.b, a)
    }

    pub const fn opaque(self) -> Self {
        self.with_alpha(1.0)
    }

    pub fn is_opaque(self) -> bool {
        self.a >= 1.0
    }

    pub fn is_finite(self) -> bool {
        self.r.is_finite() && self.g.is_finite() && self.b.is_finite() && self.a.is_finite()
    }

    pub fn clamped(self) -> Self {
        Self::new(unit(self.r), unit(self.g), unit(self.b), unit(self.a))
    }

    pub fn quantized(self) -> Self {
        Self::from(self.to_u8())
    }

    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        if let Some(hex) = text.strip_prefix('#') {
            return parse_hex(hex);
        }
        let lower = text.get(..4).map(str::to_ascii_lowercase);
        match lower.as_deref() {
            Some("rgba") | Some("rgb(") => parse_function(text),
            _ => None,
        }
    }

    pub fn to_u8(self) -> [u8; 4] {
        [byte(self.r), byte(self.g), byte(self.b), byte(self.a)]
    }

    pub fn to_u32(self) -> u32 {
        u32::from_be_bytes(self.to_u8())
    }

    pub fn to_hex(self) -> String {
        let [r, g, b, a] = self.to_u8();
        if a == 255 {
            format!("#{r:02X}{g:02X}{b:02X}")
        } else {
            format!("#{r:02X}{g:02X}{b:02X}{a:02X}")
        }
    }

    pub fn to_hex_rgb(self) -> String {
        let [r, g, b, _] = self.to_u8();
        format!("#{r:02X}{g:02X}{b:02X}")
    }

    pub fn to_css(self) -> String {
        let [r, g, b, _] = self.to_u8();
        format!("rgba({r},{g},{b},{})", trim_float(self.a))
    }

    pub fn premultiplied(self) -> Self {
        Self::new(self.r * self.a, self.g * self.a, self.b * self.a, self.a)
    }

    pub fn over(self, under: Self) -> Self {
        let top_a = f64::from(unit(self.a));
        let under_a = f64::from(unit(under.a));
        let a = top_a + under_a * (1.0 - top_a);
        if a <= 0.0 {
            return Self::TRANSPARENT;
        }
        let mix = |t: f32, u: f32| {
            ((f64::from(t) * top_a + f64::from(u) * under_a * (1.0 - top_a)) / a) as f32
        };
        Self::new(
            mix(self.r, under.r),
            mix(self.g, under.g),
            mix(self.b, under.b),
            a as f32,
        )
    }

    pub fn mix(self, other: Self, t: f32) -> Self {
        let lerp =
            |a: f32, b: f32| (f64::from(a) + (f64::from(b) - f64::from(a)) * f64::from(t)) as f32;
        Self::new(
            lerp(self.r, other.r),
            lerp(self.g, other.g),
            lerp(self.b, other.b),
            lerp(self.a, other.a),
        )
    }

    pub fn distance(self, other: Self) -> f32 {
        let d = |a: f32, b: f32| f64::from(a) - f64::from(b);
        ((d(self.r, other.r).powi(2) + d(self.g, other.g).powi(2) + d(self.b, other.b).powi(2))
            .sqrt()
            / FARTHEST_RGB) as f32
    }

    pub fn luminance(self) -> f32 {
        let channel = |v: f32| {
            let s = f64::from(unit(v));
            if s <= 0.039_28 {
                s / 12.92
            } else {
                ((s + 0.055) / 1.055).powf(2.4)
            }
        };
        (0.2126 * channel(self.r) + 0.7152 * channel(self.g) + 0.0722 * channel(self.b)) as f32
    }

    pub fn contrast_ratio(self, other: Self) -> f32 {
        contrast_of_luminances(self.luminance(), other.luminance())
    }

    pub fn is_light(self) -> bool {
        let l = f64::from(self.luminance());
        1.05 / (l + 0.05) < (l + 0.05) / 0.05
    }

    pub fn to_hsl(self) -> Hsl {
        let (h, s, l) = rgb_to_hsl(f64::from(self.r), f64::from(self.g), f64::from(self.b));
        Hsl {
            h: h as f32,
            s: s as f32,
            l: l as f32,
        }
    }

    pub fn from_hsl(hsl: Hsl, alpha: f32) -> Self {
        let (r, g, b) = hsl_to_rgb(f64::from(hsl.h), f64::from(hsl.s), f64::from(hsl.l));
        Self::new(r as f32, g as f32, b as f32, alpha)
    }

    pub fn lightened(self, delta: f32) -> Self {
        let (h, s, l) = rgb_to_hsl(f64::from(self.r), f64::from(self.g), f64::from(self.b));
        let (r, g, b) = hsl_to_rgb(h, s, (l + f64::from(delta)).clamp(0.0, 1.0));
        Self::new(r as f32, g as f32, b as f32, self.a)
    }

    pub fn to_oklab(self) -> Oklab {
        let [l, a, b] = oklab([f64::from(self.r), f64::from(self.g), f64::from(self.b)]);
        Oklab {
            l: l as f32,
            a: a as f32,
            b: b as f32,
        }
    }

    pub fn from_oklab(lab: Oklab, alpha: f32) -> Self {
        let [r, g, b] = from_oklab([f64::from(lab.l), f64::from(lab.a), f64::from(lab.b)]);
        Self::new(r as f32, g as f32, b as f32, alpha)
    }

    pub fn mix_oklab(self, other: Self, t: f32) -> Self {
        let [r, g, b] = mix_oklab(
            [f64::from(self.r), f64::from(self.g), f64::from(self.b)],
            [f64::from(other.r), f64::from(other.g), f64::from(other.b)],
            f64::from(t),
        );
        let a = f64::from(self.a) + (f64::from(other.a) - f64::from(self.a)) * f64::from(t);
        Self::new(r as f32, g as f32, b as f32, a as f32)
    }

    pub fn convert(self, from: ColorSpace, to: ColorSpace) -> Self {
        match (from, to) {
            (ColorSpace::Srgb, ColorSpace::DisplayP3) => self.srgb_to_display_p3(),
            (ColorSpace::DisplayP3, ColorSpace::Srgb) => self.display_p3_to_srgb(),
            _ => self,
        }
    }

    pub fn srgb_to_display_p3(self) -> Self {
        self.through(&LINEAR_SRGB_TO_P3)
    }

    pub fn display_p3_to_srgb(self) -> Self {
        self.through(&LINEAR_P3_TO_SRGB)
    }

    fn through(self, matrix: &[[f64; 3]; 3]) -> Self {
        let linear = [
            decode(f64::from(self.r)),
            decode(f64::from(self.g)),
            decode(f64::from(self.b)),
        ];
        let row =
            |m: &[f64; 3]| encode(m[0] * linear[0] + m[1] * linear[1] + m[2] * linear[2]) as f32;
        Self::new(row(&matrix[0]), row(&matrix[1]), row(&matrix[2]), self.a)
    }
}

impl fmt::Display for RgbaColor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl From<[u8; 4]> for RgbaColor {
    fn from([r, g, b, a]: [u8; 4]) -> Self {
        Self::new(
            r as f32 / 255.0,
            g as f32 / 255.0,
            b as f32 / 255.0,
            a as f32 / 255.0,
        )
    }
}

impl From<RgbaColor> for [u8; 4] {
    fn from(color: RgbaColor) -> Self {
        color.to_u8()
    }
}

impl From<RgbaColor> for u32 {
    fn from(color: RgbaColor) -> Self {
        color.to_u32()
    }
}

impl From<RgbaColor> for [f32; 4] {
    fn from(c: RgbaColor) -> Self {
        [c.r, c.g, c.b, c.a]
    }
}

pub fn contrast_of_luminances(a: f32, b: f32) -> f32 {
    let (a, b) = (f64::from(a), f64::from(b));
    ((a.max(b) + 0.05) / (a.min(b) + 0.05)) as f32
}

pub fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d == 0.0 {
        return (0.0, 0.0, l);
    }
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h / 6.0, s, l)
}

pub fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
    if s == 0.0 {
        return (l, l, l);
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let channel = |t: f64| {
        let t = if t < 0.0 {
            t + 1.0
        } else if t > 1.0 {
            t - 1.0
        } else {
            t
        };
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    (channel(h + 1.0 / 3.0), channel(h), channel(h - 1.0 / 3.0))
}

pub fn decode(v: f64) -> f64 {
    let a = v.abs();
    let linear = if a <= 0.040_45 {
        a / 12.92
    } else {
        ((a + 0.055) / 1.055).powf(2.4)
    };
    linear.copysign(v)
}

pub fn encode(v: f64) -> f64 {
    let a = v.abs();
    let gamma = if a <= 0.003_130_8 {
        a * 12.92
    } else {
        1.055 * a.powf(1.0 / 2.4) - 0.055
    };
    gamma.copysign(v)
}

pub fn oklab([r, g, b]: [f64; 3]) -> [f64; 3] {
    let (r, g, b) = (decode(r), decode(g), decode(b));
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
    [
        0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
        1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s,
        0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s,
    ]
}

pub fn from_oklab([big_l, big_a, big_b]: [f64; 3]) -> [f64; 3] {
    let l = (big_l + 0.396_337_777_4 * big_a + 0.215_803_757_3 * big_b).powi(3);
    let m = (big_l - 0.105_561_345_8 * big_a - 0.063_854_172_8 * big_b).powi(3);
    let s = (big_l - 0.089_484_177_5 * big_a - 1.291_485_548 * big_b).powi(3);
    [
        encode(4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s),
        encode(-1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s),
        encode(-0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s),
    ]
}

pub fn mix_oklab(a: [f64; 3], b: [f64; 3], t: f64) -> [f64; 3] {
    let (la, lb) = (oklab(a), oklab(b));
    from_oklab([
        la[0] + (lb[0] - la[0]) * t,
        la[1] + (lb[1] - la[1]) * t,
        la[2] + (lb[2] - la[2]) * t,
    ])
}

pub fn unit_relative_luminance([r, g, b]: [f64; 3]) -> f64 {
    0.2126 * decode(r.clamp(0.0, 1.0))
        + 0.7152 * decode(g.clamp(0.0, 1.0))
        + 0.0722 * decode(b.clamp(0.0, 1.0))
}

fn unit(v: f32) -> f32 {
    if v.is_nan() { 0.0 } else { v.clamp(0.0, 1.0) }
}

fn byte(v: f32) -> u8 {
    (f64::from(unit(v)) * 255.0).round() as u8
}

fn trim_float(v: f32) -> String {
    let text = format!("{:.3}", unit(v));
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text.is_empty() {
        "0".to_owned()
    } else {
        text.to_owned()
    }
}

fn parse_hex(hex: &str) -> Option<RgbaColor> {
    if !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let nibble = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let bytes = hex.as_bytes();
    let channels: Vec<u8> = match bytes.len() {
        3 | 4 => bytes
            .iter()
            .map(|&c| nibble(c).map(|n| n * 17))
            .collect::<Option<_>>()?,
        6 | 8 => bytes
            .chunks(2)
            .map(|pair| Some(nibble(pair[0])? * 16 + nibble(pair[1])?))
            .collect::<Option<_>>()?,
        _ => return None,
    };
    let alpha = channels.get(3).map_or(1.0, |&a| a as f32 / 255.0);
    Some(RgbaColor::rgba8(
        channels[0],
        channels[1],
        channels[2],
        alpha,
    ))
}

fn parse_function(text: &str) -> Option<RgbaColor> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    if close <= open || !text[close + 1..].trim().is_empty() {
        return None;
    }
    let parts: Vec<f32> = text[open + 1..close]
        .split(',')
        .map(|part| part.trim().parse::<f32>().ok().filter(|v| v.is_finite()))
        .collect::<Option<_>>()?;
    let (r, g, b, a) = match parts[..] {
        [r, g, b] => (r, g, b, 1.0),
        [r, g, b, a] => (r, g, b, a),
        _ => return None,
    };
    Some(RgbaColor::new(
        r / 255.0,
        g / 255.0,
        b / 255.0,
        a.clamp(0.0, 1.0),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn close(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() <= eps
    }

    #[test]
    fn parses_every_hex_form_and_css_functions() {
        assert_eq!(RgbaColor::parse("#fff"), Some(RgbaColor::WHITE));
        assert_eq!(
            RgbaColor::parse("#000F").map(RgbaColor::to_u8),
            Some([0, 0, 0, 255])
        );
        assert_eq!(
            RgbaColor::parse("#B25B6B").map(RgbaColor::to_u8),
            Some([0xB2, 0x5B, 0x6B, 255])
        );
        assert_eq!(
            RgbaColor::parse("#FFFFFFC7").map(RgbaColor::to_u8),
            Some([255, 255, 255, 0xC7])
        );
        assert_eq!(
            RgbaColor::parse("rgba(18,18,18,0.5)").map(RgbaColor::to_u8),
            Some([18, 18, 18, 128])
        );
        assert_eq!(
            RgbaColor::parse(" rgb(255, 0, 0) ").map(RgbaColor::to_u8),
            Some([255, 0, 0, 255])
        );
    }

    #[test]
    fn rejects_hostile_color_text() {
        for bad in [
            "",
            "#",
            "#12",
            "#12345",
            "#GGGGGG",
            "rgba(1,2)",
            "rgba(1,2,3,4,5)",
            "rgb(a,b,c)",
            "rgba(1,2,3,NaN)",
            "rgba(1,2,3) x",
            "#ffffff\u{0}",
            "rgb((1,2,3)",
            "😀",
        ] {
            assert_eq!(RgbaColor::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn hex_round_trips_and_formats_like_the_js_layer() {
        assert_eq!(RgbaColor::hex(0x2A191F).to_hex(), "#2A191F");
        assert_eq!(RgbaColor::hexa(0x12121280).to_hex(), "#12121280");
        assert_eq!(RgbaColor::hex(0x123456).to_u32(), 0x123456FF);
        assert_eq!(
            RgbaColor::rgba8(120, 125, 134, 0.7).to_css(),
            "rgba(120,125,134,0.7)"
        );
    }

    #[test]
    fn over_matches_opaque_compositing_used_by_the_shell() {
        let card = RgbaColor::rgba8(18, 18, 18, 0.5);
        let tint = RgbaColor::rgb8(66, 52, 54);
        assert_eq!(card.over(tint).to_u8(), [42, 35, 36, 255]);
        let half = RgbaColor::white(0.5).over(RgbaColor::TRANSPARENT);
        assert!(close(half.a, 0.5, 1e-6) && close(half.r, 1.0, 1e-6));
        assert_eq!(
            RgbaColor::TRANSPARENT.over(RgbaColor::TRANSPARENT),
            RgbaColor::TRANSPARENT
        );
    }

    #[test]
    fn wcag_luminance_and_contrast_bounds() {
        assert!(close(RgbaColor::WHITE.luminance(), 1.0, 1e-6));
        assert!(close(RgbaColor::BLACK.luminance(), 0.0, 1e-6));
        assert!(close(
            RgbaColor::WHITE.contrast_ratio(RgbaColor::BLACK),
            21.0,
            1e-4
        ));
        assert!(RgbaColor::WHITE.is_light());
        assert!(!RgbaColor::hex(0x2A191F).is_light());
    }

    #[test]
    fn display_p3_tint_from_the_spec_maps_to_its_srgb_value() {
        let p3 = RgbaColor::new(177.6 / 255.0, 91.1 / 255.0, 106.8 / 255.0, 1.0);
        let srgb = p3.display_p3_to_srgb().to_u8();
        assert!(
            (i32::from(srgb[0]) - 0xBF).abs() <= 1
                && (i32::from(srgb[1]) - 0x55).abs() <= 1
                && (i32::from(srgb[2]) - 0x6A).abs() <= 1,
            "{srgb:?}"
        );
    }

    #[test]
    fn lightening_in_hsl_is_clamped() {
        let tint = RgbaColor::hex(0xB25B6B);
        assert!(close(
            tint.lightened(0.25).to_hsl().l,
            (tint.to_hsl().l + 0.25).min(1.0),
            1e-5
        ));
        assert_eq!(
            RgbaColor::WHITE.lightened(0.5).to_u8(),
            [255, 255, 255, 255]
        );
        assert_eq!(RgbaColor::BLACK.lightened(-0.5).to_u8(), [0, 0, 0, 255]);
    }

    proptest! {
        #[test]
        fn oklab_round_trips(r in 0f32..=1.0, g in 0f32..=1.0, b in 0f32..=1.0) {
            let c = RgbaColor::new(r, g, b, 1.0);
            let back = RgbaColor::from_oklab(c.to_oklab(), 1.0);
            prop_assert!(close(back.r, r, 2e-4) && close(back.g, g, 2e-4) && close(back.b, b, 2e-4));
        }

        #[test]
        fn hsl_round_trips(r in 0f32..=1.0, g in 0f32..=1.0, b in 0f32..=1.0) {
            let c = RgbaColor::new(r, g, b, 1.0);
            let back = RgbaColor::from_hsl(c.to_hsl(), 1.0);
            prop_assert!(close(back.r, r, 1e-5) && close(back.g, g, 1e-5) && close(back.b, b, 1e-5));
        }

        #[test]
        fn p3_round_trips(r in 0f32..=1.0, g in 0f32..=1.0, b in 0f32..=1.0) {
            let c = RgbaColor::new(r, g, b, 1.0);
            let back = c.srgb_to_display_p3().display_p3_to_srgb();
            prop_assert!(close(back.r, r, 1e-4) && close(back.g, g, 1e-4) && close(back.b, b, 1e-4));
        }

        #[test]
        fn contrast_is_symmetric_and_at_least_one(a in any::<u32>(), b in any::<u32>()) {
            let (x, y) = (RgbaColor::hex(a & 0xFFFFFF), RgbaColor::hex(b & 0xFFFFFF));
            let c = x.contrast_ratio(y);
            prop_assert!((1.0..=21.0 + 1e-3).contains(&c));
            prop_assert!(close(c, y.contrast_ratio(x), 1e-6));
        }

        #[test]
        fn over_an_opaque_backdrop_stays_opaque(t in any::<u32>(), u in any::<u32>()) {
            let top = RgbaColor::hexa(t);
            let under = RgbaColor::hex(u & 0xFFFFFF);
            prop_assert!(close(top.over(under).a, 1.0, 1e-6));
        }

        #[test]
        fn parse_never_panics(text in ".{0,24}") {
            let _ = RgbaColor::parse(&text);
        }

        #[test]
        fn hex_text_round_trips(v in any::<u32>()) {
            let c = RgbaColor::hexa(v);
            prop_assert_eq!(RgbaColor::parse(&c.to_hex()).map(RgbaColor::to_u32), Some(v));
        }
    }
}
