use crate::color::RgbaColor;
use crate::profile_theme::ThemeTexture;
use std::sync::OnceLock;

pub const TILE_SIDE: usize = 128;
pub const THEME_TILE_POINTS: f32 = (TILE_SIDE / 2) as f32;
pub const FILM_TILE_POINTS: f32 = TILE_SIDE as f32;
const SEED: u32 = 0x9E37_79B9;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GrainTexture {
    Grain,
    Sand,
    Denim,
    Tweed,
    Film,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Darkening {
    pub gain: f32,
    pub floor: f32,
}

impl GrainTexture {
    pub const ALL: [GrainTexture; 5] = [
        GrainTexture::Grain,
        GrainTexture::Sand,
        GrainTexture::Denim,
        GrainTexture::Tweed,
        GrainTexture::Film,
    ];

    pub const fn index(self) -> usize {
        match self {
            GrainTexture::Grain => 0,
            GrainTexture::Sand => 1,
            GrainTexture::Denim => 2,
            GrainTexture::Tweed => 3,
            GrainTexture::Film => 4,
        }
    }

    pub fn from_index(index: usize) -> Option<Self> {
        Self::ALL.get(index).copied()
    }

    pub const fn from_theme(texture: ThemeTexture) -> Self {
        match texture {
            ThemeTexture::Grain => GrainTexture::Grain,
            ThemeTexture::Sand => GrainTexture::Sand,
            ThemeTexture::Denim => GrainTexture::Denim,
            ThemeTexture::Tweed => GrainTexture::Tweed,
        }
    }

    pub const fn darkening(self) -> Darkening {
        match self {
            GrainTexture::Grain | GrainTexture::Film => Darkening {
                gain: 0.211,
                floor: 0.0,
            },
            GrainTexture::Sand => Darkening {
                gain: 0.937,
                floor: 0.132,
            },
            GrainTexture::Denim => Darkening {
                gain: 0.226,
                floor: 0.068,
            },
            GrainTexture::Tweed => Darkening {
                gain: 0.23,
                floor: 0.261,
            },
        }
    }

    pub const fn points(self) -> f32 {
        match self {
            GrainTexture::Film => FILM_TILE_POINTS,
            _ => THEME_TILE_POINTS,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct GrainTile {
    pub texture: GrainTexture,
    pub side: usize,
    pub alpha: Box<[u8]>,
}

impl GrainTile {
    pub fn get(texture: GrainTexture) -> &'static GrainTile {
        static TILES: [OnceLock<GrainTile>; 5] = [
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
        ];
        TILES[texture.index()].get_or_init(|| GrainTile::generate(texture))
    }

    pub fn generate(texture: GrainTexture) -> GrainTile {
        let alpha = match texture {
            GrainTexture::Film => film_alpha(),
            _ => theme_alpha(texture),
        };
        GrainTile {
            texture,
            side: TILE_SIDE,
            alpha,
        }
    }

    pub fn points(&self) -> f32 {
        self.texture.points()
    }

    pub fn alpha_at(&self, x: i64, y: i64) -> u8 {
        let n = self.side as i64;
        self.alpha[(y.rem_euclid(n) * n + x.rem_euclid(n)) as usize]
    }

    pub fn mean_alpha(&self) -> f32 {
        let total: u64 = self.alpha.iter().map(|&a| u64::from(a)).sum();
        (total as f64 / (self.alpha.len().max(1) as f64 * 255.0)) as f32
    }

    pub fn premultiplied_black_rgba(&self) -> Vec<u8> {
        self.alpha.iter().flat_map(|&a| [0, 0, 0, a]).collect()
    }

    pub fn checksum(&self) -> u64 {
        self.alpha.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        })
    }
}

struct XorShift(u32);

impl XorShift {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 % 10_000) as f32 / 10_000.0
    }
}

fn theme_alpha(texture: GrainTexture) -> Box<[u8]> {
    let n = TILE_SIDE;
    let mut alpha = vec![0f32; n * n];
    let mut random = XorShift(SEED);
    let add = |alpha: &mut [f32], x: i64, y: i64, v: f32| {
        let side = n as i64;
        let i = (y.rem_euclid(side) * side + x.rem_euclid(side)) as usize;
        alpha[i] = (alpha[i] + v).min(1.0);
    };
    match texture {
        GrainTexture::Sand => {
            for a in alpha.iter_mut() {
                *a = random.next() * 0.25;
            }
            for _ in 0..(n * n / 18) {
                let x = (random.next() * n as f32) as i64;
                let y = (random.next() * n as f32) as i64;
                let v = 0.5 + random.next() * 0.5;
                add(&mut alpha, x, y, v);
                add(&mut alpha, x + 1, y, v * 0.6);
                add(&mut alpha, x, y + 1, v * 0.6);
                add(&mut alpha, x + 1, y + 1, v * 0.4);
            }
        }
        GrainTexture::Denim => {
            for y in 0..n {
                for x in 0..n {
                    let twill: f32 = if (x + y) % 4 < 2 { 0.75 } else { 0.15 };
                    let weft: f32 = if y % 2 == 0 { 0.08 } else { 0.0 };
                    alpha[y * n + x] = (twill * (0.6 + random.next() * 0.4) + weft).min(1.0);
                }
            }
        }
        GrainTexture::Tweed => {
            for a in alpha.iter_mut() {
                *a = random.next() * 0.15;
            }
            for _ in 0..(n * n / 40) {
                let x = (random.next() * n as f32) as i64;
                let y = (random.next() * n as f32) as i64;
                let v = 0.4 + random.next() * 0.6;
                let horizontal = random.next() < 0.5;
                let run = 3 + (random.next() * 4.0) as i64;
                for k in 0..run {
                    if horizontal {
                        add(&mut alpha, x + k, y, v)
                    } else {
                        add(&mut alpha, x, y + k, v)
                    }
                }
            }
        }
        GrainTexture::Grain | GrainTexture::Film => {
            for a in alpha.iter_mut() {
                let u = random.next();
                *a = u * u;
            }
        }
    }
    let Darkening { gain, floor } = texture.darkening();
    alpha
        .iter()
        .map(|&a| ((floor + gain * a).max(0.0) * 255.0).min(255.0) as u8)
        .collect()
}

fn fract(v: f32) -> f32 {
    v - v.floor()
}

pub fn film_grain_hash(x: f32, y: f32) -> f32 {
    let mut p = [fract(x * 0.1031), fract(y * 0.1031), fract(x * 0.1031)];
    let d = p[0] * (p[1] + 33.33) + p[1] * (p[2] + 33.33) + p[2] * (p[0] + 33.33);
    p[0] += d;
    p[1] += d;
    p[2] += d;
    fract((p[0] + p[1]) * p[2])
}

fn film_alpha() -> Box<[u8]> {
    let n = TILE_SIDE;
    (0..n * n)
        .map(|i| {
            ((1.0 - film_grain_hash((i % n) as f32, (i / n) as f32)) * 255.0)
                .round()
                .clamp(0.0, 255.0) as u8
        })
        .collect()
}

pub fn film_grain_opacity(opacity: f32) -> f32 {
    if opacity.is_finite() {
        opacity.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

pub fn film_grain_points(scale: f32) -> f32 {
    FILM_TILE_POINTS
        * if scale.is_finite() {
            scale.max(0.25)
        } else {
            1.0
        }
}

pub fn apply_film_grain(base: RgbaColor, opacity: f32, hash: f32) -> RgbaColor {
    let k = 1.0 - film_grain_opacity(opacity) * (1.0 - hash.clamp(0.0, 1.0));
    RgbaColor::new(
        (base.r * k).clamp(0.0, 1.0),
        (base.g * k).clamp(0.0, 1.0),
        (base.b * k).clamp(0.0, 1.0),
        base.a,
    )
}

pub fn multiply_grain(base: RgbaColor, tile_alpha: u8, opacity: f32) -> RgbaColor {
    let k = 1.0 - film_grain_opacity(opacity) * f32::from(tile_alpha) / 255.0;
    RgbaColor::new(base.r * k, base.g * k, base.b * k, base.a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_texture_is_a_full_deterministic_tile() {
        for texture in GrainTexture::ALL {
            let tile = GrainTile::get(texture);
            assert_eq!(tile.alpha.len(), TILE_SIDE * TILE_SIDE);
            assert_eq!(tile, &GrainTile::generate(texture));
            assert!(std::ptr::eq(tile, GrainTile::get(texture)));
            assert_eq!(GrainTexture::from_index(texture.index()), Some(texture));
        }
        assert_eq!(GrainTexture::from_index(5), None);
    }

    #[test]
    fn darkening_bounds_hold_per_texture() {
        for texture in GrainTexture::ALL {
            let tile = GrainTile::get(texture);
            let Darkening { gain, floor } = texture.darkening();
            let low = (floor * 255.0) as u8;
            let high = (((floor + gain) * 255.0).min(255.0)) as u8;
            if texture != GrainTexture::Film {
                assert!(
                    tile.alpha.iter().all(|&a| a >= low && a <= high),
                    "{texture:?}"
                );
            }
        }
        let tweed = GrainTile::get(GrainTexture::Tweed);
        assert!(tweed.alpha.iter().all(|&a| a >= 66));
    }

    #[test]
    fn textures_differ_from_each_other() {
        let sums: Vec<u64> = GrainTexture::ALL
            .iter()
            .map(|&t| GrainTile::get(t).checksum())
            .collect();
        for (i, a) in sums.iter().enumerate() {
            for b in &sums[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn theme_textures_match_the_swift_grain_layer_bytes() {
        let expected = [
            (GrainTexture::Grain, 0xdc94_3905_589e_af3d),
            (GrainTexture::Sand, 0x3d97_d8ac_4a24_fdd9),
            (GrainTexture::Denim, 0xccf9_2f28_21ea_abb6),
            (GrainTexture::Tweed, 0xd716_9350_ff1b_fcc1),
            (GrainTexture::Film, 0xdaff_7f3d_b39d_5c08),
        ];
        for (texture, sum) in expected {
            assert_eq!(GrainTile::get(texture).checksum(), sum, "{texture:?}");
        }
    }

    #[test]
    fn xorshift_matches_the_swift_generator() {
        let mut random = XorShift(SEED);
        let mut state: u32 = 0x9E37_79B9;
        for _ in 0..1000 {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            assert_eq!(random.next(), (state % 10_000) as f32 / 10_000.0);
        }
    }

    #[test]
    fn denim_twill_alternates_every_two_columns() {
        let denim = GrainTile::get(GrainTexture::Denim);
        let mean = |pred: &dyn Fn(usize, usize) -> bool| {
            let mut sum = 0u64;
            let mut count = 0u64;
            for y in 0..TILE_SIDE {
                for x in 0..TILE_SIDE {
                    if pred(x, y) {
                        sum += u64::from(denim.alpha[y * TILE_SIDE + x]);
                        count += 1;
                    }
                }
            }
            sum as f64 / count as f64
        };
        assert!(mean(&|x, y| (x + y) % 4 < 2) > mean(&|x, y| (x + y) % 4 >= 2) + 10.0);
    }

    #[test]
    fn film_grain_hash_is_unit_and_multiplies_down() {
        for y in 0..64 {
            for x in 0..64 {
                let h = film_grain_hash(x as f32, y as f32);
                assert!((0.0..1.0).contains(&h));
            }
        }
        let base = RgbaColor::gray(0.5);
        assert_eq!(apply_film_grain(base, 0.0, 0.3), base);
        assert!(apply_film_grain(base, 1.0, 0.0).r == 0.0);
        assert_eq!(film_grain_points(0.1), 32.0);
        assert_eq!(film_grain_points(f32::NAN), 128.0);
        assert_eq!(film_grain_opacity(f32::INFINITY), 0.0);
        let tile = GrainTile::get(GrainTexture::Film);
        assert_eq!(tile.alpha_at(-1, -1), tile.alpha[TILE_SIDE * TILE_SIDE - 1]);
        assert_eq!(
            tile.premultiplied_black_rgba().len(),
            TILE_SIDE * TILE_SIDE * 4
        );
        assert_eq!(multiply_grain(base, 0, 1.0), base);
    }
}
