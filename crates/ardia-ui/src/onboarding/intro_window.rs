use std::ptr::NonNull;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use gpui::{
    AnyWindowHandle, App, AppContext, Context, FocusHandle, Focusable, Image, ImageFormat,
    IntoElement, KeyDownEvent, NativeView, ParentElement, Render, Styled, TitlebarOptions, Window,
    WindowBackgroundAppearance, WindowBounds, WindowKind, WindowOptions, div, img, prelude::*,
};

use super::intro;
use crate::host::{OnboardingRecord, UiHost, UtilityWindowKind};
use crate::look::system_dark;

pub const APPEAR_IN: f32 = 0.5;
pub const BOOM_FADE: f32 = 0.45;
pub const READY_LIMIT: Duration = Duration::from_millis(2500);
pub const BOOM_LIMIT: Duration = Duration::from_millis(9000);
pub const CARD_AFTER_WINDOW: Duration = Duration::from_millis(300);
pub const HANDOFF: f32 = 0.4;
pub const SKIP_FADE: f32 = 0.25;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Exit {
    Timed,
    Skipped(Instant),
    Boom(Instant),
}

pub struct Poster {
    pub aspect: f32,
    pub horizon: f32,
    pub bytes: &'static [u8],
}

pub const DAWN: [Poster; 4] = [
    Poster {
        aspect: 2.4,
        horizon: 0.65,
        bytes: include_bytes!("../../assets/meadow/dawn-wider-2400.webp"),
    },
    Poster {
        aspect: 1.777_777_8,
        horizon: 0.65,
        bytes: include_bytes!("../../assets/meadow/dawn-wide-1920.webp"),
    },
    Poster {
        aspect: 1.6,
        horizon: 0.65,
        bytes: include_bytes!("../../assets/meadow/dawn-laptop-1920.webp"),
    },
    Poster {
        aspect: 1.299_484_9,
        horizon: 0.65,
        bytes: include_bytes!("../../assets/meadow/dawn-mid-1600.webp"),
    },
];

pub fn nearest_poster(aspect: f32) -> usize {
    let score = |p: &Poster| (p.aspect / aspect.max(0.01)).ln().abs();
    (0..DAWN.len())
        .min_by(|a, b| score(&DAWN[*a]).total_cmp(&score(&DAWN[*b])))
        .unwrap_or(0)
}

fn poster_image(index: usize) -> Arc<Image> {
    static CACHE: OnceLock<Vec<Arc<Image>>> = OnceLock::new();
    let all = CACHE.get_or_init(|| {
        DAWN.iter()
            .map(|p| Arc::new(Image::from_bytes(ImageFormat::Webp, p.bytes.to_vec())))
            .collect()
    });
    Arc::clone(&all[index.min(all.len() - 1)])
}

pub fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}

pub fn ease_in_out_quad(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 {
        2.0 * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
    }
}

pub fn ease_in_quad(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t
}

pub fn handoff_curve(t: f32) -> f32 {
    ardia_theme::motion::CubicBezier::new(0.37, 0.0, 0.63, 1.0).ease(f64::from(t.clamp(0.0, 1.0)))
        as f32
}

pub struct IntroWindowView {
    host: Arc<dyn UiHost>,
    focus: FocusHandle,
    night: bool,
    creeper: bool,
    view: Option<NativeView>,
    created: Instant,
    began: Option<Instant>,
    ready_at: Option<Instant>,
    exit: Option<Exit>,
    exit_started: bool,
    handed_off: Option<Instant>,
    finished: Option<Instant>,
    was_active: bool,
}

impl Focusable for IntroWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl IntroWindowView {
    pub fn new(host: Arc<dyn UiHost>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        host.cover_screen(window);
        let night = system_dark(window.appearance());
        let creeper = night;
        let view = host.open_meadow(night, creeper).and_then(|handle| {
            let raw = NonNull::new(handle.0)?;
            unsafe { NativeView::new(raw, window, cx) }.ok()
        });
        if !night {
            host.set_meadow_alpha(0.0);
        }
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let host_active = host.app_active();
        IntroWindowView {
            host,
            focus,
            night,
            creeper,
            view,
            created: Instant::now(),
            began: None,
            ready_at: None,
            exit: None,
            exit_started: false,
            handed_off: None,
            finished: None,
            was_active: host_active,
        }
    }

    pub fn exit(&self) -> Option<Exit> {
        self.exit
    }

    fn begin(&mut self, now: Instant) {
        if self.began.is_some() {
            return;
        }
        self.began = Some(now);
        let muted = self.host.intro_music_muted();
        ardia_telemetry::counts::count("intros_shown");
        if muted {
            ardia_telemetry::counts::count("intros_music_muted");
        }
        self.host.play_intro_music(muted);
    }

    pub fn skip(&mut self, now: Instant) {
        if self.exit.is_some() || self.finished.is_some() {
            return;
        }
        self.exit = Some(Exit::Skipped(now));
        ardia_telemetry::counts::count("intros_skipped");
        self.host.stop_intro_music(0.35);
        self.start_exit(now);
    }

    fn boom(&mut self, now: Instant) {
        if self.exit.is_some() || self.finished.is_some() {
            return;
        }
        self.exit = Some(Exit::Boom(now));
        self.start_exit(now);
    }

    fn start_exit(&mut self, now: Instant) {
        if self.exit_started {
            return;
        }
        self.exit_started = true;
        self.handed_off = Some(now);
    }

    fn hand_off(&mut self, cx: &mut Context<Self>) {
        self.host.save_onboarding(OnboardingRecord {
            completed: false,
            step: Some("source".to_owned()),
            source: None,
            preset: Some("dia".to_owned()),
        });
        self.host.open_utility_window(UtilityWindowKind::Onboarding);
        cx.notify();
    }

    fn presence(
        &mut self,
        now: Instant,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<f32> {
        for event in self.host.meadow_events() {
            match event.as_str() {
                "ready" => {
                    self.ready_at.get_or_insert(now);
                    self.begin(now);
                }
                "boom" if self.creeper => self.boom(now),
                _ => {}
            }
        }
        if self.began.is_none() && now.duration_since(self.created) >= READY_LIMIT {
            self.begin(now);
        }
        let began = self.began?;
        let elapsed = now.duration_since(began).as_secs_f32();
        if self.exit.is_none() {
            if self.creeper {
                if now.duration_since(began) >= BOOM_LIMIT {
                    self.boom(now);
                }
            } else if elapsed >= intro::exit_at() {
                self.exit = Some(Exit::Timed);
                self.start_exit(now);
            }
        }
        let appear = ease_out_cubic(elapsed / APPEAR_IN);
        let (fade, done) = match self.exit {
            Some(Exit::Timed) => {
                let t = (elapsed - intro::exit_at()) / intro::EXIT;
                (ease_in_out_quad(t), t >= 1.0)
            }
            Some(Exit::Skipped(at)) => {
                let t = now.duration_since(at).as_secs_f32() / SKIP_FADE;
                (ease_out_cubic(t), t >= 1.0)
            }
            Some(Exit::Boom(at)) => {
                let t = now.duration_since(at).as_secs_f32() / BOOM_FADE;
                (ease_in_quad(t), t >= 1.0)
            }
            None => (0.0, false),
        };
        if let Some(at) = self.handed_off
            && now.duration_since(at) >= CARD_AFTER_WINDOW
        {
            self.handed_off = None;
            self.hand_off(cx);
        }
        if done && self.finished.is_none() {
            if !matches!(self.exit, Some(Exit::Skipped(_))) {
                ardia_telemetry::counts::count("intros_finished");
            }
            self.finished = Some(now);
        }
        if self.finished.is_some() && self.handed_off.is_none() {
            self.host.close_meadow();
            window.remove_window();
            return None;
        }
        let ready = self.ready_at.map_or(0.0, |at| {
            handoff_curve(now.duration_since(at).as_secs_f32() / HANDOFF)
        });
        let opacity = appear * (1.0 - fade);
        self.host.set_meadow_alpha(f64::from(ready * opacity));
        Some(opacity)
    }

    fn on_key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape" {
            self.skip(Instant::now());
            cx.notify();
        }
    }
}

impl Render for IntroWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        let active = self.host.app_active();
        if self.was_active && !active {
            self.skip(now);
        }
        self.was_active |= active;
        window.request_animation_frame();
        let opacity = self.presence(now, window, cx).unwrap_or(0.0);
        let size = window.viewport_size();
        let aspect = f32::from(size.width) / f32::from(size.height).max(1.0);
        let background = if self.night {
            gpui::black()
        } else {
            gpui::white()
        };
        let poster = (!self.night).then(|| {
            let index = nearest_poster(aspect);
            let p = &DAWN[index];
            let width = f32::from(size.width).max(f32::from(size.height) * p.aspect);
            let height = width / p.aspect;
            let top = (f32::from(size.height) - height) * p.horizon;
            img(poster_image(index))
                .absolute()
                .left(gpui::px((f32::from(size.width) - width) / 2.0))
                .top(gpui::px(top))
                .w(gpui::px(width))
                .h(gpui::px(height))
        });
        div()
            .id("intro-window")
            .debug_selector(|| "intro-window".into())
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            .size_full()
            .relative()
            .bg(background)
            .opacity(opacity)
            .children(poster)
            .children(
                self.view
                    .clone()
                    .map(|view| div().absolute().inset_0().child(view)),
            )
    }
}

pub fn intro_options(cx: &App) -> WindowOptions {
    let bounds = cx
        .primary_display()
        .map(|display| display.bounds())
        .unwrap_or_else(|| {
            gpui::Bounds::centered(None, gpui::size(gpui::px(1440.), gpui::px(900.)), cx)
        });
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some("Ardia".into()),
            appears_transparent: true,
            traffic_light_position: Some(gpui::point(gpui::px(-200.), gpui::px(-200.))),
        }),
        window_background: WindowBackgroundAppearance::Opaque,
        focus: true,
        show: true,
        kind: WindowKind::PopUp,
        is_movable: false,
        is_resizable: false,
        ..WindowOptions::default()
    }
}

pub fn open(host: Arc<dyn UiHost>, cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    let handle = cx.open_window(intro_options(cx), move |window, cx| {
        cx.new(|cx| IntroWindowView::new(host, window, cx))
    })?;
    Ok(handle.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posters_follow_the_screen_shape() {
        assert_eq!(nearest_poster(16.0 / 9.0), 1);
        assert_eq!(nearest_poster(1512.0 / 982.0), 2);
        assert_eq!(nearest_poster(21.0 / 9.0), 0);
        assert_eq!(nearest_poster(4.0 / 3.0), 3);
    }

    #[test]
    fn exit_curves_end_where_they_should() {
        assert_eq!(ease_out_cubic(1.0), 1.0);
        assert_eq!(ease_in_out_quad(0.5), 0.5);
        assert_eq!(ease_in_quad(1.0), 1.0);
        assert!((handoff_curve(1.0) - 1.0).abs() < 1e-4);
    }
}
