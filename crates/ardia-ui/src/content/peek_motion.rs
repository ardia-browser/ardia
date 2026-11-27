use std::time::Instant;

use ardia_state::TabId;
use ardia_state::settings::PeekButtons;

use crate::content::peek_overlay::peek_geometry;
use crate::window::layout::Rect;

pub const OPEN_AT: f64 = 0.3;
pub const CLOSE_AT: f64 = -0.25;
pub const SPREAD_TO_TAB: f64 = 0.4;
pub const FULL_AT: f64 = 1.2;
pub const PROMOTED: f64 = SPREAD_TO_TAB * FULL_AT;
pub const READY_TIMEOUT: f64 = 0.15;
pub const FADE_SECONDS: f64 = 0.15;
pub const SCRIM_RESPONSE: f64 = 0.26;
pub const CLOSE_RESPONSE: f64 = 0.2;
pub const PROMOTE_RESPONSE: f64 = 0.22;
pub const SETTLE_RESPONSE: f64 = 0.2;
pub const START_SCALE: f64 = 0.12;
pub const SMALLEST_SCALE: f64 = 0.5;
pub const SOURCE_WIDTH: f32 = 28.0;
pub const SOURCE_HEIGHT: f32 = 18.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PeekSpring {
    pub value: f64,
    pub velocity: f64,
    pub target: f64,
    pub response: f64,
}

impl PeekSpring {
    pub const fn new(value: f64, response: f64) -> Self {
        PeekSpring {
            value,
            velocity: 0.0,
            target: value,
            response,
        }
    }

    pub fn aim(&mut self, target: f64, response: Option<f64>) {
        self.target = target;
        if let Some(response) = response {
            self.response = response;
        }
    }

    pub fn jump(&mut self, value: f64) {
        self.value = value;
        self.target = value;
        self.velocity = 0.0;
    }

    pub fn step(&mut self, dt: f64) {
        if dt <= 0.0 || self.response <= 0.0 {
            return;
        }
        let w = 2.0 * std::f64::consts::PI / self.response;
        let d0 = self.value - self.target;
        let v0 = self.velocity;
        let decay = (-w * dt).exp();
        let d = (d0 + (v0 + w * d0) * dt) * decay;
        self.velocity = (v0 - w * (v0 + w * d0) * dt) * decay;
        self.value = self.target + d;
    }

    pub fn settled(&self, tolerance: f64) -> bool {
        (self.value - self.target).abs() <= tolerance && self.velocity.abs() <= tolerance * 20.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Affine {
    pub s: f32,
    pub tx: f32,
    pub ty: f32,
}

impl Affine {
    pub const IDENTITY: Affine = Affine {
        s: 1.0,
        tx: 0.0,
        ty: 0.0,
    };

    pub fn mapping(from: Rect, to: Rect) -> Affine {
        let s = if from.w > 0.0 { to.w / from.w } else { 1.0 };
        Affine {
            s,
            tx: to.x - s * from.x,
            ty: to.y - s * from.y,
        }
    }

    pub fn scale_about(s: f32, c: [f32; 2]) -> Affine {
        Affine {
            s,
            tx: c[0] - s * c[0],
            ty: c[1] - s * c[1],
        }
    }

    pub fn apply(&self, r: Rect) -> Rect {
        Rect::new(
            self.s * r.x + self.tx,
            self.s * r.y + self.ty,
            self.s * r.w,
            self.s * r.h,
        )
    }

    pub fn then(&self, next: Affine) -> Affine {
        Affine {
            s: next.s * self.s,
            tx: next.s * self.tx + next.tx,
            ty: next.s * self.ty + next.ty,
        }
    }

    pub fn is_identity(&self) -> bool {
        (self.s - 1.0).abs() < 1e-6 && self.tx.abs() < 1e-4 && self.ty.abs() < 1e-4
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StageGeometry {
    pub width: f32,
    pub height: f32,
    pub page: Rect,
    pub tab: Rect,
    pub rest: Rect,
    pub card: Rect,
    pub source: Rect,
    pub rest_radius: f32,
    pub tab_top_radius: f32,
    pub tab_bottom_radius: f32,
}

impl StageGeometry {
    pub fn valid(&self) -> bool {
        let finite =
            |r: Rect| r.x.is_finite() && r.y.is_finite() && r.w.is_finite() && r.h.is_finite();
        [self.page, self.tab, self.rest, self.card, self.source]
            .into_iter()
            .all(finite)
            && self.width > 0.0
            && self.height > 0.0
            && self.page.w > 0.0
            && self.page.h > 0.0
            && self.tab.w > 0.0
            && self.tab.h > 0.0
            && self.rest.w > 0.0
            && self.card.w > 0.0
            && self.card.h > 0.0
    }

    fn same_placement(&self, other: &StageGeometry) -> bool {
        let mut moved = *other;
        moved.page = self.page;
        moved == *self
    }
}

pub struct StageInput {
    pub width: f32,
    pub height: f32,
    pub page_top: f32,
    pub inset: f32,
    pub radius: f32,
    pub buttons: PeekButtons,
    pub from: Option<[f32; 2]>,
    pub at_tab_size: bool,
}

fn clamp_low_first(v: f32, lo: f32, hi: f32) -> f32 {
    v.min(hi.max(lo)).max(lo)
}

pub fn stage_geometry(o: StageInput) -> StageGeometry {
    let fitted = peek_geometry(o.width, o.height, o.page_top, o.inset, o.buttons);
    let tab = Rect::new(0.0, o.page_top, o.width, (o.height - o.page_top).max(1.0));
    let card = fitted.card;
    let at = o
        .from
        .unwrap_or([card.x + card.w / 2.0, card.y + card.h / 2.0]);
    let source = Rect::new(
        clamp_low_first(at[0] - SOURCE_WIDTH / 2.0, 0.0, o.width - SOURCE_WIDTH),
        clamp_low_first(at[1] - SOURCE_HEIGHT / 2.0, 0.0, o.height - SOURCE_HEIGHT),
        SOURCE_WIDTH,
        SOURCE_HEIGHT,
    );
    StageGeometry {
        width: o.width,
        height: o.height,
        page: if o.at_tab_size { tab } else { fitted.rest },
        tab,
        rest: fitted.rest,
        card,
        source,
        rest_radius: o.radius,
        tab_top_radius: if o.page_top > 0.0 { 0.0 } else { o.radius },
        tab_bottom_radius: o.radius,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PeekFrame {
    pub card: Affine,
    pub page: Affine,
    pub card_alpha: f32,
    pub chrome_alpha: f32,
    pub scrim_alpha: f32,
    pub top_radius: f32,
    pub bottom_radius: f32,
    pub shown_page: Rect,
}

impl Default for PeekFrame {
    fn default() -> Self {
        PeekFrame {
            card: Affine::IDENTITY,
            page: Affine::IDENTITY,
            card_alpha: 0.0,
            chrome_alpha: 1.0,
            scrim_alpha: 0.0,
            top_radius: 0.0,
            bottom_radius: 0.0,
            shown_page: Rect::default(),
        }
    }
}

impl PeekFrame {
    pub fn at_rest(g: &StageGeometry) -> PeekFrame {
        let page = Affine::mapping(g.page, g.rest);
        PeekFrame {
            card: Affine::IDENTITY,
            page,
            card_alpha: 1.0,
            chrome_alpha: 1.0,
            scrim_alpha: 1.0,
            top_radius: g.rest_radius,
            bottom_radius: g.rest_radius,
            shown_page: g.rest,
        }
    }

    pub fn shown_card(&self, g: &StageGeometry) -> Rect {
        self.card.apply(g.card)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeekPhase {
    Idle,
    Waiting,
    Entering,
    Open,
    Gesture,
    Settling,
    Closing,
    Promoting,
    Finished,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeekEntrance {
    Affine,
    Fade,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeekOutcome {
    Closed,
    Promoted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PinchResult {
    Open,
    Close,
    Stay,
}

#[derive(Clone, Copy, Debug)]
struct Fade {
    from: f64,
    to: f64,
    start: f64,
}

#[derive(Clone, Debug)]
pub struct PeekMotion {
    phase: PeekPhase,
    entrance: PeekEntrance,
    pub reduce: bool,
    animated_entrance: bool,
    geometry: Option<StageGeometry>,
    m: PeekSpring,
    presence: PeekSpring,
    fade: Fade,
    clock: f64,
    waiting_since: f64,
    gesture_base: f64,
    gesture_sample: (f64, f64),
    outcome: Option<PeekOutcome>,
    reported: bool,
}

impl Default for PeekMotion {
    fn default() -> Self {
        PeekMotion {
            phase: PeekPhase::Idle,
            entrance: PeekEntrance::Affine,
            reduce: false,
            animated_entrance: true,
            geometry: None,
            m: PeekSpring::new(0.0, 0.2),
            presence: PeekSpring::new(1.0, SCRIM_RESPONSE),
            fade: Fade {
                from: 1.0,
                to: 1.0,
                start: 0.0,
            },
            clock: 0.0,
            waiting_since: 0.0,
            gesture_base: 0.0,
            gesture_sample: (0.0, 0.0),
            outcome: None,
            reported: false,
        }
    }
}

fn unit(v: f64) -> f64 {
    if v.is_nan() { 0.0 } else { v.clamp(0.0, 1.0) }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn lerp_rect(a: Rect, b: Rect, t: f32) -> Rect {
    let l = |x: f32, y: f32| x + (y - x) * t;
    Rect::new(l(a.x, b.x), l(a.y, b.y), l(a.w, b.w), l(a.h, b.h))
}

fn centre(r: Rect) -> [f32; 2] {
    [r.x + r.w / 2.0, r.y + r.h / 2.0]
}

pub fn rubber(e: f64) -> f64 {
    let knee = 2.0 - FULL_AT;
    if e <= knee {
        return e;
    }
    let u = unit((e - knee) / (2.0 * (FULL_AT - 1.0)));
    knee + (1.0 - knee) * (2.0 * u - u * u)
}

impl PeekMotion {
    pub fn phase(&self) -> PeekPhase {
        self.phase
    }

    pub fn entrance(&self) -> PeekEntrance {
        self.entrance
    }

    pub fn geometry(&self) -> Option<&StageGeometry> {
        self.geometry.as_ref()
    }

    pub fn animating(&self) -> bool {
        matches!(
            self.phase,
            PeekPhase::Waiting
                | PeekPhase::Entering
                | PeekPhase::Gesture
                | PeekPhase::Settling
                | PeekPhase::Closing
                | PeekPhase::Promoting
        )
    }

    pub fn terminal(&self) -> bool {
        matches!(
            self.phase,
            PeekPhase::Idle | PeekPhase::Closing | PeekPhase::Promoting | PeekPhase::Finished
        )
    }

    pub fn begin(&mut self, now: f64, animated: bool) {
        let reduce = self.reduce;
        *self = PeekMotion {
            reduce,
            ..PeekMotion::default()
        };
        self.animated_entrance = animated;
        self.phase = PeekPhase::Waiting;
        self.entrance = if reduce {
            PeekEntrance::Fade
        } else {
            PeekEntrance::Affine
        };
        self.fade = Fade {
            from: 1.0,
            to: 1.0,
            start: now,
        };
        self.waiting_since = now;
        self.clock = now;
    }

    pub fn set_geometry(&mut self, next: StageGeometry, now: f64) {
        if !next.valid() || self.geometry == Some(next) {
            return;
        }
        let previous = self.geometry.replace(next);
        let Some(previous) = previous else {
            return;
        };
        if next.same_placement(&previous) {
            return;
        }
        if self.phase == PeekPhase::Entering {
            ardia_telemetry::counts::count("peek_entrance_interrupts");
        }
        match self.phase {
            PeekPhase::Entering | PeekPhase::Gesture | PeekPhase::Settling => self.snap_open(now),
            PeekPhase::Closing => self.finish(PeekOutcome::Closed),
            PeekPhase::Promoting => self.finish(PeekOutcome::Promoted),
            _ => {}
        }
    }

    pub fn mark_ready(&mut self, now: f64) {
        if self.phase == PeekPhase::Waiting && self.geometry.is_some() {
            self.start_entrance(now);
        }
    }

    pub fn take_outcome(&mut self) -> Option<PeekOutcome> {
        if self.reported {
            return None;
        }
        let outcome = self.outcome?;
        self.reported = true;
        ardia_telemetry::counts::count(match outcome {
            PeekOutcome::Closed => "peek_closes",
            PeekOutcome::Promoted => "peek_promotes",
        });
        Some(outcome)
    }

    pub fn close(&mut self, now: f64) -> bool {
        if self.terminal() {
            return false;
        }
        self.clock = now;
        if self.phase == PeekPhase::Waiting {
            self.finish(PeekOutcome::Closed);
            return true;
        }
        self.phase = PeekPhase::Closing;
        if self.reduce {
            self.fade = Fade {
                from: self.fade_value(now),
                to: 0.0,
                start: now,
            };
        } else {
            self.presence.aim(0.0, Some(CLOSE_RESPONSE));
            self.m.aim(self.m.value.min(0.0), Some(CLOSE_RESPONSE));
        }
        true
    }

    pub fn promote(&mut self, now: f64) -> bool {
        if self.terminal() {
            return false;
        }
        self.clock = now;
        if self.phase == PeekPhase::Waiting {
            self.entrance = PeekEntrance::Affine;
            self.presence.jump(if self.reduce { 1.0 } else { 0.0 });
        }
        self.phase = PeekPhase::Promoting;
        if self.reduce {
            self.m.jump(PROMOTED);
            self.presence.jump(1.0);
            self.fade = Fade {
                from: 1.0,
                to: 1.0,
                start: now,
            };
        } else {
            self.m.aim(PROMOTED, Some(PROMOTE_RESPONSE));
            self.presence.aim(1.0, Some(PROMOTE_RESPONSE));
        }
        true
    }

    pub fn gesture_began(&mut self, now: f64) -> bool {
        match self.phase {
            PeekPhase::Entering | PeekPhase::Open | PeekPhase::Settling => self.clock = now,
            PeekPhase::Gesture => {}
            _ => return false,
        }
        self.phase = PeekPhase::Gesture;
        self.gesture_base = self.m.value;
        self.m.aim(self.m.value, None);
        self.m.velocity = 0.0;
        self.gesture_sample = (now, self.m.value);
        true
    }

    pub fn gesture_changed(&mut self, total: f64, now: f64) {
        if self.phase != PeekPhase::Gesture || self.reduce {
            return;
        }
        let value = (self.gesture_base + total).clamp(-1.0, 1.2);
        let dt = now - self.gesture_sample.0;
        if dt > 0.001 {
            self.m.velocity = 0.6 * self.m.velocity + 0.4 * (value - self.gesture_sample.1) / dt;
        }
        self.m.value = value;
        self.m.target = value;
        self.gesture_sample = (now, value);
    }

    pub fn gesture_ended(&mut self, total: f64, cancelled: bool, now: f64) -> PinchResult {
        if self.phase != PeekPhase::Gesture {
            return PinchResult::Stay;
        }
        let value = self.gesture_base + total;
        let result = if cancelled {
            PinchResult::Stay
        } else if value >= OPEN_AT {
            PinchResult::Open
        } else if value <= CLOSE_AT {
            PinchResult::Close
        } else {
            PinchResult::Stay
        };
        match result {
            PinchResult::Open => {
                self.promote(now);
            }
            PinchResult::Close => {
                self.close(now);
            }
            PinchResult::Stay => {
                self.phase = PeekPhase::Settling;
                self.m.aim(0.0, Some(SETTLE_RESPONSE));
            }
        }
        result
    }

    pub fn advance(&mut self, now: f64) {
        let dt = (now - self.clock).max(0.0);
        self.clock = now;
        match self.phase {
            PeekPhase::Waiting => {
                if self.geometry.is_some() && now - self.waiting_since >= READY_TIMEOUT {
                    ardia_telemetry::counts::count("peek_ready_timeouts");
                    self.start_entrance(now);
                }
            }
            PeekPhase::Entering => match self.entrance {
                PeekEntrance::Affine => {
                    self.presence.step(dt);
                    if self.presence.settled(1e-3) {
                        self.snap_open(now);
                    }
                }
                PeekEntrance::Fade => {
                    if self.fade_value(now) >= 1.0 {
                        self.snap_open(now);
                    }
                }
            },
            PeekPhase::Gesture => self.presence.step(dt),
            PeekPhase::Settling => {
                self.presence.step(dt);
                self.m.step(dt);
                if self.m.settled(5e-4) && self.presence.settled(1e-3) {
                    self.snap_open(now);
                }
            }
            PeekPhase::Closing => {
                self.m.step(dt);
                self.presence.step(dt);
                let done = if self.reduce {
                    self.fade_value(now) <= 0.0
                } else {
                    self.presence.value <= 0.02
                };
                if done {
                    self.finish(PeekOutcome::Closed);
                }
            }
            PeekPhase::Promoting => {
                if self.reduce {
                    if now - self.fade.start >= FADE_SECONDS {
                        self.finish(PeekOutcome::Promoted);
                    }
                } else {
                    self.m.step(dt);
                    self.presence.step(dt);
                    if self.m.settled(4e-4) && self.presence.settled(1e-3) {
                        self.m.jump(PROMOTED);
                        self.presence.jump(1.0);
                        self.finish(PeekOutcome::Promoted);
                    }
                }
            }
            _ => {}
        }
    }

    pub fn frame(&self, now: f64) -> PeekFrame {
        let Some(g) = self.geometry else {
            return PeekFrame::default();
        };
        let base = Affine::mapping(g.page, g.rest);
        let mut f = PeekFrame {
            top_radius: g.rest_radius,
            bottom_radius: g.rest_radius,
            ..PeekFrame::default()
        };
        if self.phase == PeekPhase::Finished && self.outcome == Some(PeekOutcome::Promoted) {
            f.card_alpha = 1.0;
            f.chrome_alpha = 0.0;
            f.top_radius = g.tab_top_radius;
            f.bottom_radius = g.tab_bottom_radius;
            f.page = Affine::mapping(g.page, g.tab);
            f.shown_page = g.tab;
            return f;
        }
        if matches!(self.phase, PeekPhase::Waiting | PeekPhase::Idle)
            || self.phase == PeekPhase::Finished
        {
            f.page = base;
            f.shown_page = g.rest;
            return f;
        }
        let mv = self.m.value;
        let e = if mv >= 0.0 {
            rubber(mv / SPREAD_TO_TAB)
        } else {
            0.0
        };
        let expand = if mv >= 0.0 {
            Affine::mapping(g.rest, lerp_rect(g.rest, g.tab, e as f32))
        } else {
            Affine::scale_about(SMALLEST_SCALE.max(1.0 + mv) as f32, centre(g.card))
        };
        let a = self.presence.value;
        let cs = centre(g.card);
        let ss = centre(g.source);
        let gs = lerp(START_SCALE, 1.0, a) as f32;
        let a32 = a as f32;
        let to = [ss[0] + (cs[0] - ss[0]) * a32, ss[1] + (cs[1] - ss[1]) * a32];
        let card = expand.then(Affine {
            s: gs,
            tx: to[0] - gs * cs[0],
            ty: to[1] - gs * cs[1],
        });
        f.card = card;
        f.page = base.then(card);
        f.shown_page = f.page.apply(g.page);
        let ec = unit(e);
        let presence_alpha = if a < 0.35 { a.max(0.0) / 0.35 } else { 1.0 };
        let pinch_alpha = if mv < 0.0 { unit(1.0 + 1.6 * mv) } else { 1.0 };
        let fv = self.fade_value(now);
        f.card_alpha = unit(presence_alpha * pinch_alpha * fv) as f32;
        f.chrome_alpha = unit(1.0 - 1.6 * ec) as f32;
        let scrim_pinch = if mv >= 0.0 {
            1.0 - ec
        } else {
            unit(1.0 + 2.0 * mv)
        };
        f.scrim_alpha = unit(unit(a) * scrim_pinch * fv) as f32;
        if self.reduce && self.phase == PeekPhase::Promoting {
            let p = unit((now - self.fade.start) / FADE_SECONDS);
            f.card_alpha = 1.0;
            f.chrome_alpha = 0.0;
            f.scrim_alpha = (1.0 - p) as f32;
        }
        f.top_radius = lerp(f64::from(g.rest_radius), f64::from(g.tab_top_radius), ec) as f32;
        f.bottom_radius = lerp(f64::from(g.rest_radius), f64::from(g.tab_bottom_radius), ec) as f32;
        f
    }

    fn start_entrance(&mut self, now: f64) {
        if !self.animated_entrance {
            self.snap_open(now);
            return;
        }
        self.phase = PeekPhase::Entering;
        ardia_telemetry::counts::count(if self.reduce {
            "peek_entrances_fade"
        } else {
            "peek_entrances_affine"
        });
        if self.reduce {
            self.entrance = PeekEntrance::Fade;
            self.fade = Fade {
                from: 0.0,
                to: 1.0,
                start: now,
            };
        } else {
            self.entrance = PeekEntrance::Affine;
            self.presence.jump(0.0);
            self.presence.aim(1.0, Some(SCRIM_RESPONSE));
        }
    }

    fn snap_open(&mut self, now: f64) {
        self.phase = PeekPhase::Open;
        self.m.jump(0.0);
        self.presence.jump(1.0);
        self.fade = Fade {
            from: 1.0,
            to: 1.0,
            start: now,
        };
    }

    fn finish(&mut self, outcome: PeekOutcome) {
        self.phase = PeekPhase::Finished;
        self.outcome = Some(outcome);
    }

    fn fade_value(&self, now: f64) -> f64 {
        let p = unit((now - self.fade.start) / FADE_SECONDS);
        lerp(self.fade.from, self.fade.to, p)
    }
}

pub struct PeekDriver {
    epoch: Instant,
    motion: PeekMotion,
    tab: Option<TabId>,
    unshown: Option<TabId>,
    to_tab: bool,
    pinch_total: f64,
    pinching: bool,
    frame: Option<PeekFrame>,
}

impl Default for PeekDriver {
    fn default() -> Self {
        PeekDriver {
            epoch: Instant::now(),
            motion: PeekMotion::default(),
            tab: None,
            unshown: None,
            to_tab: false,
            pinch_total: 0.0,
            pinching: false,
            frame: None,
        }
    }
}

pub struct DriveInput<'a> {
    pub peek: Option<&'a TabId>,
    pub hidden_peek: Option<&'a TabId>,
    pub ready: bool,
    pub reduce: bool,
    pub stage: Option<StageInput>,
}

impl PeekDriver {
    pub fn secs(&self, now: Instant) -> f64 {
        now.saturating_duration_since(self.epoch).as_secs_f64()
    }

    pub fn motion(&self) -> &PeekMotion {
        &self.motion
    }

    pub fn tab(&self) -> Option<&TabId> {
        self.tab.as_ref()
    }

    pub fn to_tab(&self) -> bool {
        self.to_tab
    }

    pub fn frame(&self) -> Option<PeekFrame> {
        self.frame
    }

    pub fn claims_pinch(&self) -> bool {
        self.pinching
    }

    pub fn owns(&self, tab: &TabId) -> bool {
        self.tab.as_ref() == Some(tab) && self.motion.phase != PeekPhase::Finished
    }

    pub fn drive(&mut self, input: DriveInput<'_>, now: Instant) -> Option<PeekOutcome> {
        let t = self.secs(now);
        self.motion.reduce = input.reduce;
        if let Some(hidden) = input.hidden_peek
            && self.tab.as_ref() != Some(hidden)
        {
            self.unshown = Some(hidden.clone());
        }
        let Some(peek) = input.peek else {
            if input.hidden_peek.is_none() {
                self.tab = None;
                self.unshown = None;
                self.to_tab = false;
                self.frame = None;
                self.pinching = false;
            }
            self.frame = None;
            return None;
        };
        if self.tab.as_ref() != Some(peek) {
            let animated = self.unshown.as_ref() != Some(peek);
            self.tab = Some(peek.clone());
            self.unshown = None;
            self.to_tab = false;
            self.pinching = false;
            self.motion.begin(t, animated);
        }
        if let Some(mut stage) = input.stage {
            stage.at_tab_size = self.to_tab;
            self.motion.set_geometry(stage_geometry(stage), t);
        }
        if input.ready {
            self.motion.mark_ready(t);
        }
        self.motion.advance(t);
        self.frame = self.motion.geometry().map(|_| self.motion.frame(t));
        self.motion.take_outcome()
    }

    pub fn take_outcome(&mut self) -> Option<PeekOutcome> {
        self.motion.take_outcome()
    }

    pub fn close(&mut self, now: Instant) -> bool {
        let t = self.secs(now);
        self.motion.advance(t);
        self.motion.close(t)
    }

    pub fn promote(&mut self, now: Instant) -> bool {
        let t = self.secs(now);
        self.motion.advance(t);
        let started = self.motion.promote(t);
        if started {
            self.to_tab = true;
        }
        started
    }

    pub fn pinch(
        &mut self,
        phase: gpui::TouchPhase,
        delta: f32,
        at: [f32; 2],
        now: Instant,
    ) -> Option<PinchResult> {
        let t = self.secs(now);
        if phase == gpui::TouchPhase::Started {
            let over_card = self
                .frame
                .zip(self.motion.geometry().copied())
                .is_some_and(|(f, g)| f.shown_card(&g).contains(at[0], at[1]));
            self.pinching =
                over_card && !self.motion.terminal() && self.motion.phase != PeekPhase::Waiting;
            self.pinch_total = 0.0;
        }
        if !self.pinching {
            return None;
        }
        if delta.is_finite() {
            self.pinch_total += f64::from(delta);
        }
        self.motion.advance(t);
        match phase {
            gpui::TouchPhase::Started => {
                if !self.motion.gesture_began(t) {
                    self.pinching = false;
                    return None;
                }
                self.motion.gesture_changed(self.pinch_total, t);
                None
            }
            gpui::TouchPhase::Moved => {
                self.motion.gesture_changed(self.pinch_total, t);
                None
            }
            gpui::TouchPhase::Ended | gpui::TouchPhase::Cancelled => {
                self.pinching = false;
                let cancelled = phase == gpui::TouchPhase::Cancelled;
                let result = self.motion.gesture_ended(self.pinch_total, cancelled, t);
                match result {
                    PinchResult::Open => {
                        self.to_tab = true;
                        ardia_telemetry::counts::count("peek_pinch_opens");
                    }
                    PinchResult::Close => ardia_telemetry::counts::count("peek_pinch_closes"),
                    PinchResult::Stay => {}
                }
                Some(result)
            }
        }
    }
}

pub fn stage_input(
    area: Rect,
    page: Rect,
    inset: f32,
    radius: f32,
    buttons: PeekButtons,
    click: Option<[f32; 2]>,
) -> StageInput {
    StageInput {
        width: area.w,
        height: area.h,
        page_top: (page.y - area.y).max(0.0),
        inset,
        radius,
        buttons,
        from: click.map(|[x, y]| [x - area.x, y - area.y]),
        at_tab_size: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage() -> StageGeometry {
        stage_geometry(StageInput {
            width: 1200.0,
            height: 800.0,
            page_top: 40.0,
            inset: 9.0,
            radius: 10.0,
            buttons: PeekButtons::Top,
            from: Some([200.0, 150.0]),
            at_tab_size: false,
        })
    }

    fn run_until(m: &mut PeekMotion, from: f64, to: f64) -> f64 {
        let mut t = from;
        while t < to {
            t += 1.0 / 120.0;
            m.advance(t);
        }
        t
    }

    #[test]
    fn the_spring_matches_the_old_critically_damped_step() {
        let mut s = PeekSpring::new(0.0, 0.26);
        s.aim(1.0, None);
        s.step(0.26);
        let w = 2.0 * std::f64::consts::PI / 0.26;
        let expected = 1.0 - (1.0 + w * 0.26) * (-w * 0.26_f64).exp();
        assert!((s.value - expected).abs() < 1e-9);
    }

    #[test]
    fn a_peek_waits_then_zooms_from_the_link_and_settles_open() {
        let mut m = PeekMotion::default();
        m.begin(0.0, true);
        m.set_geometry(stage(), 0.0);
        assert_eq!(m.frame(0.0).card_alpha, 0.0);
        m.advance(0.1);
        assert_eq!(m.phase(), PeekPhase::Waiting);
        m.advance(0.15);
        assert_eq!(m.phase(), PeekPhase::Entering);
        let start = m.frame(0.15);
        assert!((start.card.s - START_SCALE as f32).abs() < 1e-3);
        let shown = start.shown_card(&stage());
        let source = stage().source;
        assert!((shown.x + shown.w / 2.0 - (source.x + source.w / 2.0)).abs() < 0.5);
        let t = run_until(&mut m, 0.15, 0.4);
        let mid = m.frame(t);
        assert!(mid.card.s > 0.9 && mid.card.s < 1.0);
        run_until(&mut m, t, 1.5);
        assert_eq!(m.phase(), PeekPhase::Open);
        let open = m.frame(1.5);
        assert!(open.card.is_identity());
        assert_eq!(open.scrim_alpha, 1.0);
    }

    #[test]
    fn closing_shrinks_back_to_the_link_and_reports_closed_once() {
        let mut m = PeekMotion::default();
        m.begin(0.0, false);
        m.set_geometry(stage(), 0.0);
        m.mark_ready(0.0);
        assert_eq!(m.phase(), PeekPhase::Open);
        assert!(m.close(1.0));
        assert!(!m.close(1.01));
        let t = run_until(&mut m, 1.0, 1.1);
        let f = m.frame(t);
        assert!(f.card.s < 1.0 && f.scrim_alpha < 1.0);
        run_until(&mut m, t, 2.0);
        assert_eq!(m.take_outcome(), Some(PeekOutcome::Closed));
        assert_eq!(m.take_outcome(), None);
    }

    #[test]
    fn promoting_grows_the_card_onto_the_tab() {
        let g = stage();
        let mut m = PeekMotion::default();
        m.begin(0.0, false);
        m.set_geometry(g, 0.0);
        m.mark_ready(0.0);
        assert!(m.promote(1.0));
        run_until(&mut m, 1.0, 3.0);
        assert_eq!(m.take_outcome(), Some(PeekOutcome::Promoted));
        let f = m.frame(3.0);
        let page = f.page.apply(g.page);
        assert!((page.w - g.tab.w).abs() < 0.5 && (page.y - g.tab.y).abs() < 0.5);
    }

    #[test]
    fn a_pinch_follows_and_commits_past_the_old_thresholds() {
        let g = stage();
        let mut m = PeekMotion::default();
        m.begin(0.0, false);
        m.set_geometry(g, 0.0);
        m.mark_ready(0.0);
        assert!(m.gesture_began(1.0));
        m.gesture_changed(-0.2, 1.05);
        let f = m.frame(1.05);
        assert!((f.card.s - 0.8).abs() < 1e-3);
        assert!(f.card_alpha < 1.0);
        assert_eq!(m.gesture_ended(-0.1, false, 1.1), PinchResult::Stay);
        assert_eq!(m.phase(), PeekPhase::Settling);
        run_until(&mut m, 1.1, 2.0);
        assert_eq!(m.phase(), PeekPhase::Open);
        assert!(m.gesture_began(2.0));
        assert_eq!(m.gesture_ended(0.35, false, 2.1), PinchResult::Open);
        assert_eq!(m.phase(), PeekPhase::Promoting);
    }

    #[test]
    fn reduced_motion_fades_instead_of_zooming() {
        let mut m = PeekMotion {
            reduce: true,
            ..PeekMotion::default()
        };
        m.begin(0.0, true);
        m.set_geometry(stage(), 0.0);
        m.mark_ready(0.0);
        assert_eq!(m.entrance(), PeekEntrance::Fade);
        let half = m.frame(0.075);
        assert!(half.card.is_identity());
        assert!((half.card_alpha - 0.5).abs() < 0.01);
        m.advance(0.2);
        assert_eq!(m.phase(), PeekPhase::Open);
        assert!(m.close(1.0));
        m.advance(1.2);
        assert_eq!(m.take_outcome(), Some(PeekOutcome::Closed));
    }

    #[test]
    fn closing_while_waiting_finishes_at_once() {
        let mut m = PeekMotion::default();
        m.begin(0.0, true);
        m.set_geometry(stage(), 0.0);
        assert!(m.close(0.05));
        assert_eq!(m.take_outcome(), Some(PeekOutcome::Closed));
    }

    #[test]
    fn the_rubber_band_reaches_the_tab_at_full_spread() {
        assert_eq!(rubber(0.5), 0.5);
        assert!((rubber(PROMOTED / SPREAD_TO_TAB) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn the_driver_skips_the_entrance_for_a_peek_opened_out_of_sight() {
        let mut d = PeekDriver::default();
        let now = d.epoch;
        let peek = TabId::new("p");
        fn input<'a>(peek: Option<&'a TabId>, hidden: Option<&'a TabId>) -> DriveInput<'a> {
            DriveInput {
                peek,
                hidden_peek: hidden,
                ready: false,
                reduce: false,
                stage: Some(StageInput {
                    width: 1200.0,
                    height: 800.0,
                    page_top: 0.0,
                    inset: 9.0,
                    radius: 10.0,
                    buttons: PeekButtons::Top,
                    from: None,
                    at_tab_size: false,
                }),
            }
        }
        d.drive(input(None, Some(&peek)), now);
        d.drive(input(Some(&peek), None), now);
        d.drive(
            input(Some(&peek), None),
            now + std::time::Duration::from_millis(200),
        );
        assert_eq!(d.motion().phase(), PeekPhase::Open);
    }
}
