use std::f64::consts::PI;

pub const SAMPLE_RATE: f64 = 44_100.0;
pub const VOLUME: f32 = 0.55;
pub const LARGE_HALL: isize = 4;
pub const WET_DRY: f32 = 32.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cues {
    pub icon: f64,
    pub letters: f64,
    pub letter_step: f64,
    pub letter_count: usize,
    pub tagline: f64,
    pub exit: f64,
    pub end: f64,
}

impl Cues {
    pub fn intro() -> Cues {
        let letter = 0.52;
        let tagline_in = 0.6;
        let exit_len = 0.65;
        let icon = 0.25;
        let letters = 1.15;
        let letter_step = 0.055;
        let letter_count = 5;
        let tagline = letters + (letter_count as f64 - 1.0) * letter_step + letter + 0.15;
        let exit = tagline + tagline_in + 1.1;
        Cues {
            icon,
            letters,
            letter_step,
            letter_count,
            tagline,
            exit,
            end: exit + exit_len,
        }
    }
}

pub struct Mix {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    sr: f64,
    table: Vec<f32>,
    seed: u64,
}

fn envelope(t: f64, length: f64, attack: f64, release: f64) -> f32 {
    let s = |x: f64| (0.5 - 0.5 * (PI * x.clamp(0.0, 1.0)).cos()) as f32;
    if t < attack {
        return s(t / attack);
    }
    if t > length {
        return 1.0 - s((t - length) / release);
    }
    1.0
}

fn pan(p: f32) -> (f32, f32) {
    let angle = f64::from(p + 1.0) * PI / 4.0;
    (angle.cos() as f32, angle.sin() as f32)
}

impl Mix {
    pub fn new(seconds: f64, sr: f64) -> Mix {
        let n = (seconds * sr) as usize;
        let size = 4096;
        let table = (0..=size)
            .map(|i| {
                let x = 2.0 * PI * i as f64 / size as f64;
                let v: f64 = (1..=8)
                    .map(|k| (k as f64 * x).sin() / (k as f64).powf(1.7))
                    .sum();
                (v / 1.5) as f32
            })
            .collect();
        Mix {
            left: vec![0.0; n],
            right: vec![0.0; n],
            sr,
            table,
            seed: 0x2545_F491_4F6C_DD1D,
        }
    }

    fn range(&self, from: f64, to: f64) -> std::ops::Range<usize> {
        let a = ((from * self.sr) as isize).max(0) as usize;
        let b = ((to * self.sr) as usize).min(self.left.len());
        a..b.max(a)
    }

    fn random(&mut self) -> f64 {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        (self.seed >> 11) as f64 / (1u64 << 53) as f64
    }

    #[allow(clippy::too_many_arguments)]
    pub fn pad(&mut self, freq: f64, from: f64, to: f64, attack: f64, release: f64, gain: f32) {
        let detune = 2f64.powf(4.0 / 1200.0);
        let mut phase = (self.random(), self.random());
        let inc = (freq / detune / self.sr, freq * detune / self.sr);
        let cutoff = (freq * 5.0).min(1600.0);
        let a = (1.0 - (-2.0 * PI * cutoff / self.sr).exp()) as f32;
        let mut lp = (0f32, 0f32);
        let length = to - from;
        let size = (self.table.len() - 1) as f64;
        for i in self.range(from, to + release) {
            let lookup = |x: f64| {
                let j = x as usize;
                let f = (x - j as f64) as f32;
                self.table[j] + (self.table[j + 1] - self.table[j]) * f
            };
            let t = i as f64 / self.sr - from;
            let env = envelope(t, length, attack, release) * gain;
            let shimmer = (1.0 + 0.04 * (2.0 * PI * 0.23 * t + freq).sin()) as f32;
            let l = lookup(phase.0 * size);
            let r = lookup(phase.1 * size);
            lp.0 += a * (l - lp.0);
            lp.1 += a * (r - lp.1);
            self.left[i] += lp.0 * env * shimmer;
            self.right[i] += lp.1 * env * (2.0 - shimmer);
            phase.0 += inc.0;
            if phase.0 >= 1.0 {
                phase.0 -= 1.0;
            }
            phase.1 += inc.1;
            if phase.1 >= 1.0 {
                phase.1 -= 1.0;
            }
        }
    }

    pub fn sine(&mut self, freq: f64, from: f64, to: f64, attack: f64, release: f64, gain: f32) {
        let length = to - from;
        for i in self.range(from, to + release) {
            let t = i as f64 / self.sr - from;
            let v =
                (2.0 * PI * freq * t).sin() as f32 * envelope(t, length, attack, release) * gain;
            self.left[i] += v;
            self.right[i] += v;
        }
    }

    pub fn bell(&mut self, freq: f64, start: f64, gain: f32, p: f32) {
        let (gl, gr) = pan(p);
        for i in self.range(start, start + 4.5) {
            let t = i as f64 / self.sr - start;
            let index = 2.6 * (-t / 0.35).exp();
            let v = (2.0 * PI * freq * t + index * (2.0 * PI * freq * 1.4 * t).sin()).sin();
            let env = ((t / 0.004).min(1.0) * (-t / 1.4).exp()) as f32 * gain;
            self.left[i] += v as f32 * env * gl;
            self.right[i] += v as f32 * env * gr;
        }
    }

    pub fn pluck(&mut self, freq: f64, start: f64, gain: f32, p: f32) {
        let (gl, gr) = pan(p);
        for i in self.range(start, start + 2.0) {
            let t = i as f64 / self.sr - start;
            let x = 2.0 * PI * freq * t;
            let v = x.sin()
                + 0.25 * (2.0 * x).sin() * (-t / 0.12).exp()
                + 0.08 * (3.0 * x).sin() * (-t / 0.06).exp();
            let env = ((t / 0.005).min(1.0) * (-t / 0.42).exp()) as f32 * gain;
            self.left[i] += v as f32 * env * gl;
            self.right[i] += v as f32 * env * gr;
        }
    }

    pub fn air(&mut self, from: f64, peak: f64, to: f64, gain: f32) {
        let mut seed: u32 = 0x9E37_79B9;
        let mut noise = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / (1u32 << 23) as f32 - 1.0
        };
        let mut lp = (0f32, 0f32);
        for i in self.range(from, to) {
            let t = i as f64 / self.sr;
            let rise = if t < peak {
                (t - from) / (peak - from)
            } else {
                1.0 - (t - peak) / (to - peak)
            };
            let shape = (rise.max(0.0) * rise.max(0.0)) as f32;
            let cutoff = 250.0 + 2800.0 * f64::from(shape);
            let a = (1.0 - (-2.0 * PI * cutoff / self.sr).exp()) as f32;
            lp.0 += a * (noise() - lp.0);
            lp.1 += a * (noise() - lp.1);
            self.left[i] += lp.0 * shape * gain;
            self.right[i] += lp.1 * shape * gain;
        }
    }

    pub fn normalize(&mut self, target: f32) {
        let peak = self
            .left
            .iter()
            .chain(&self.right)
            .fold(0f32, |m, v| m.max(v.abs()));
        if peak <= 0.0 {
            return;
        }
        let k = target / peak;
        self.left
            .iter_mut()
            .chain(self.right.iter_mut())
            .for_each(|v| *v *= k);
    }

    pub fn fade_out(&mut self, seconds: f64) {
        let count = self.left.len();
        let frames = ((seconds * self.sr) as usize).min(count);
        for j in 0..frames {
            let i = count - frames + j;
            let g = (0.5 + 0.5 * (PI * j as f64 / frames as f64).cos()) as f32;
            self.left[i] *= g;
            self.right[i] *= g;
        }
    }
}

pub fn synthesize(c: Cues, sr: f64) -> Mix {
    let mut mix = Mix::new(c.end + 4.5, sr);
    let (d2, g2, d3, g3, a3, b3, d4) = (73.416, 97.999, 146.832, 195.998, 220.0, 246.942, 293.665);
    let (e4, fs4, a4, cs5, e5) = (329.628, 369.994, 440.0, 554.365, 659.255);
    let first = c.tagline + 0.35;
    let second = c.exit + 0.25;
    for f in [d3, a3, e4, a4] {
        mix.pad(f, 0.0, first, 1.8, 1.2, 0.15);
    }
    for f in [g3, b3, d4, fs4] {
        mix.pad(f, c.tagline - 0.2, second, 1.1, 1.0, 0.14);
    }
    for f in [d3, a3, fs4, cs5, e5] {
        mix.pad(f, c.exit - 0.1, c.end + 1.2, 0.6, 2.8, 0.13);
    }
    mix.sine(d2, 0.0, first, 2.0, 1.2, 0.08);
    mix.sine(g2, c.tagline - 0.2, second, 1.0, 1.0, 0.07);
    mix.sine(d2, c.exit - 0.1, c.end + 1.2, 0.6, 2.8, 0.08);
    let land = c.icon + 0.35;
    mix.bell(587.33, land, 0.10, -0.15);
    mix.bell(880.0, land + 0.012, 0.07, 0.2);
    let mut midi = 69i32;
    let pentatonic = [2, 4, 6, 9, 11];
    let count = c.letter_count;
    for i in 0..count {
        let freq = 440.0 * 2f64.powf(f64::from(midi - 69) / 12.0);
        let side = if i % 2 == 0 { -0.35 } else { 0.35 };
        let p = side * (0.4 + 0.6 * i as f32 / (count.max(2) - 1) as f32);
        mix.pluck(
            freq,
            c.letters + i as f64 * c.letter_step + 0.03,
            0.075 - 0.003 * i as f32,
            p,
        );
        loop {
            midi += 1;
            if pentatonic.contains(&midi.rem_euclid(12)) {
                break;
            }
        }
    }
    mix.air(c.exit - 0.35, c.end, c.end + 1.4, 0.035);
    mix.bell(739.99, c.end - 0.05, 0.06, 0.25);
    mix.bell(1174.66, c.end + 0.03, 0.04, -0.25);
    mix.normalize(0.5);
    mix.fade_out(1.5);
    mix
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    #[link(name = "AVFoundation", kind = "framework")]
    unsafe extern "C" {}

    struct Playing {
        engine: usize,
        mixer: usize,
        session: u64,
        muted: bool,
    }

    static PLAYING: Mutex<Option<Playing>> = Mutex::new(None);
    static SESSION: Mutex<u64> = Mutex::new(0);

    fn new(class: &std::ffi::CStr) -> *mut AnyObject {
        let Some(class) = AnyClass::get(class) else {
            return std::ptr::null_mut();
        };
        unsafe {
            let allocated: *mut AnyObject = msg_send![class, alloc];
            msg_send![allocated, init]
        }
    }

    fn set_volume(mixer: usize, volume: f32) {
        let mixer = mixer as *mut AnyObject;
        if !mixer.is_null() {
            let _: () = unsafe { msg_send![mixer, setOutputVolume: volume] };
        }
    }

    fn ramp(mixer: usize, from: f32, to: f32, seconds: f64) {
        let start = Instant::now();
        loop {
            let t = if seconds > 0.0 {
                (start.elapsed().as_secs_f64() / seconds).min(1.0)
            } else {
                1.0
            };
            let eased = (t * t * (3.0 - 2.0 * t)) as f32;
            set_volume(mixer, from + (to - from) * eased);
            if t >= 1.0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    }

    fn stop_engine(engine: usize) {
        let engine = engine as *mut AnyObject;
        if !engine.is_null() {
            unsafe {
                let _: () = msg_send![engine, stop];
                let _: () = msg_send![engine, release];
            }
        }
    }

    pub fn play(cues: super::Cues, muted: bool) {
        stop_now();
        let session = {
            let mut s = SESSION.lock().unwrap_or_else(|e| e.into_inner());
            *s += 1;
            *s
        };
        let requested = Instant::now();
        std::thread::spawn(move || {
            let mix = super::synthesize(cues, super::SAMPLE_RATE);
            let frames = mix.left.len();
            let offset = (requested.elapsed().as_secs_f64() * super::SAMPLE_RATE) as usize;
            if offset >= frames {
                return;
            }
            unsafe {
                let engine = new(c"AVAudioEngine");
                let player = new(c"AVAudioPlayerNode");
                let reverb = new(c"AVAudioUnitReverb");
                let Some(format_class) = AnyClass::get(c"AVAudioFormat") else {
                    return;
                };
                let Some(buffer_class) = AnyClass::get(c"AVAudioPCMBuffer") else {
                    return;
                };
                if engine.is_null() || player.is_null() || reverb.is_null() {
                    return;
                }
                let format_alloc: *mut AnyObject = msg_send![format_class, alloc];
                let format: *mut AnyObject = msg_send![format_alloc, initStandardFormatWithSampleRate: super::SAMPLE_RATE, channels: 2u32];
                let count = (frames - offset) as u32;
                let buffer_alloc: *mut AnyObject = msg_send![buffer_class, alloc];
                let buffer: *mut AnyObject =
                    msg_send![buffer_alloc, initWithPCMFormat: format, frameCapacity: count];
                if format.is_null() || buffer.is_null() {
                    return;
                }
                let _: () = msg_send![buffer, setFrameLength: count];
                let channels: *const *mut f32 = msg_send![buffer, floatChannelData];
                if channels.is_null() {
                    return;
                }
                let fade_in = ((0.06 * super::SAMPLE_RATE) as usize).min(count as usize);
                for (ch, source) in [&mix.left, &mix.right].into_iter().enumerate() {
                    let out = std::slice::from_raw_parts_mut(*channels.add(ch), count as usize);
                    out.copy_from_slice(&source[offset..]);
                    if offset > 0 {
                        for (i, v) in out.iter_mut().take(fade_in).enumerate() {
                            *v *= i as f32 / fade_in as f32;
                        }
                    }
                }
                let _: () = msg_send![reverb, loadFactoryPreset: super::LARGE_HALL];
                let _: () = msg_send![reverb, setWetDryMix: super::WET_DRY];
                let _: () = msg_send![engine, attachNode: player];
                let _: () = msg_send![engine, attachNode: reverb];
                let mixer: *mut AnyObject = msg_send![engine, mainMixerNode];
                let _: () = msg_send![engine, connect: player, to: reverb, format: format];
                let _: () = msg_send![engine, connect: reverb, to: mixer, format: format];
                let _: () =
                    msg_send![mixer, setOutputVolume: if muted { 0.0f32 } else { super::VOLUME }];
                let mut error: *mut AnyObject = std::ptr::null_mut();
                let started: bool = msg_send![engine, startAndReturnError: &mut error];
                if !started {
                    log::info!("intro music couldn't start the audio engine");
                    stop_engine(engine as usize);
                    return;
                }
                let none: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![player, scheduleBuffer: buffer, atTime: none, options: 0usize, completionHandler: none];
                let _: () = msg_send![player, play];
                let mut playing = PLAYING.lock().unwrap_or_else(|e| e.into_inner());
                if *SESSION.lock().unwrap_or_else(|e| e.into_inner()) != session {
                    stop_engine(engine as usize);
                    return;
                }
                *playing = Some(Playing {
                    engine: engine as usize,
                    mixer: mixer as usize,
                    session,
                    muted,
                });
            }
            let total = Duration::from_secs_f64(count_seconds(frames - offset) + 2.5);
            std::thread::sleep(total);
            let mut playing = PLAYING.lock().unwrap_or_else(|e| e.into_inner());
            if playing.as_ref().is_some_and(|p| p.session == session)
                && let Some(done) = playing.take()
            {
                stop_engine(done.engine);
            }
        });
    }

    fn count_seconds(frames: usize) -> f64 {
        frames as f64 / super::SAMPLE_RATE
    }

    pub fn set_muted(muted: bool) {
        let mixer = {
            let mut playing = PLAYING.lock().unwrap_or_else(|e| e.into_inner());
            let Some(p) = playing.as_mut() else {
                return;
            };
            p.muted = muted;
            p.mixer
        };
        std::thread::spawn(move || {
            ramp(
                mixer,
                if muted { super::VOLUME } else { 0.0 },
                if muted { 0.0 } else { super::VOLUME },
                0.25,
            )
        });
    }

    pub fn stop(fade: f64) {
        let taken = PLAYING.lock().unwrap_or_else(|e| e.into_inner()).take();
        *SESSION.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        if let Some(p) = taken {
            std::thread::spawn(move || {
                ramp(
                    p.mixer,
                    if p.muted { 0.0 } else { super::VOLUME },
                    0.0,
                    fade,
                );
                stop_engine(p.engine);
            });
        }
    }

    fn stop_now() {
        if let Some(p) = PLAYING.lock().unwrap_or_else(|e| e.into_inner()).take() {
            stop_engine(p.engine);
        }
    }
}

pub fn play(muted: bool, silent: bool) {
    if silent {
        return;
    }
    #[cfg(target_os = "macos")]
    mac::play(Cues::intro(), muted);
    #[cfg(not(target_os = "macos"))]
    let _ = muted;
}

pub fn set_muted(muted: bool) {
    #[cfg(target_os = "macos")]
    mac::set_muted(muted);
    #[cfg(not(target_os = "macos"))]
    let _ = muted;
}

pub fn stop(fade: f64) {
    #[cfg(target_os = "macos")]
    mac::stop(fade);
    #[cfg(not(target_os = "macos"))]
    let _ = fade;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_intro_cues_match_the_old_timeline() {
        let c = Cues::intro();
        assert!((c.tagline - 2.04).abs() < 1e-9);
        assert!((c.exit - 3.74).abs() < 1e-9);
        assert!((c.end - 4.39).abs() < 1e-9);
    }

    #[test]
    fn the_mix_is_normalised_and_fades_to_silence() {
        let mix = synthesize(Cues::intro(), 8_000.0);
        let peak = mix
            .left
            .iter()
            .chain(&mix.right)
            .fold(0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.5).abs() < 1e-3 || peak < 0.5);
        assert!(mix.left.last().is_some_and(|v| v.abs() < 1e-4));
        assert_eq!(
            mix.left.len(),
            ((Cues::intro().end + 4.5) * 8_000.0) as usize
        );
    }
}
