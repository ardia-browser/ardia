use std::time::{Duration, Instant};

use ardia_state::{BrowserState, TabId, WindowId};
use ardia_theme::motion::Spring;
use ardia_theme::tokens::{radius, space};
use gpui::{AnyElement, BoxShadow, FontWeight, Hsla, Rgba, SharedString, div, point, prelude::*};

use crate::content::nav_buttons::{back_msgs, history_of};
use crate::host::UiHost;
use crate::icon_picker::symbols::SymbolWeight;
use crate::msg::Msg;
use crate::primitives::favicon::{favicon_of, render_favicon, resolve_favicon};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::tokens::{Curve, Tween, duration};
use crate::scale::px;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;
use crate::window::page_overlays::{HistoryDirection, HistoryItem, NavigationStep, history_items};

pub const SWIPE_UNIT: f32 = 75.0;
pub const CAPSULE_SIZE: f32 = 72.0;
pub const CAPSULE_SIZE_CONFIRMED: f32 = 82.0;
pub const CAPSULE_INSET: f32 = 14.0;
pub const RUBBER_COEFFICIENT: f32 = 0.15;
pub const LIST_ROW: f32 = 38.0;
pub const LIST_FOLD_PROGRESS: f32 = 0.75;
pub const ICON: f32 = 28.0;
pub const ICON_CONFIRMED: f32 = 34.0;
pub const LIST_WIDTH: f32 = 200.0;
pub const LIST_PAD: f32 = space::M;
pub const LIST_IDLE: Duration = Duration::from_millis(300);
pub const SWIPE_DISMISS_DELAY: Duration = Duration::from_millis(120);
pub const LIST_MAX: usize = 15;
pub const SNAPPY: Spring = Spring::new(0.2, 0.9);
pub const PILL_SPRING: Spring = Spring::new(0.27, 0.9);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwipePhase {
    Began,
    Changed,
    Ended,
    Cancelled,
    Swipe,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PageSwipe {
    pub tab: TabId,
    pub phase: SwipePhase,
    pub direction: HistoryDirection,
    pub distance: f32,
    pub dy: f32,
    pub velocity: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwipeHaptic {
    LevelChange,
    Generic,
    Alignment,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwipeItem {
    pub title: String,
    pub url: String,
    pub offset: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwipeCommit {
    Step(HistoryDirection),
    Offset(i32),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SwipeEffects {
    pub haptics: Vec<SwipeHaptic>,
    pub commit: Option<(TabId, SwipeCommit)>,
    pub list_open: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SwipeColors {
    pub chevron: Hsla,
    pub rim: Hsla,
    pub selection: Hsla,
    pub confirmed_wash: Hsla,
    pub shadow: Hsla,
}

fn rgba(r: u8, g: u8, b: u8, a: f32) -> Hsla {
    Hsla::from(Rgba {
        r: f32::from(r) / 255.0,
        g: f32::from(g) / 255.0,
        b: f32::from(b) / 255.0,
        a,
    })
}

pub fn swipe_colors(dark: bool) -> SwipeColors {
    if dark {
        SwipeColors {
            chevron: rgba(255, 255, 255, 217.0 / 255.0),
            rim: rgba(255, 255, 255, 0.15),
            selection: rgba(255, 255, 255, 0.1),
            confirmed_wash: rgba(255, 255, 255, 0.4),
            shadow: rgba(0, 0, 0, 0.25),
        }
    } else {
        SwipeColors {
            chevron: rgba(0, 0, 0, 217.0 / 255.0),
            rim: rgba(0, 0, 0, 0.125),
            selection: rgba(0, 0, 0, 0.1),
            confirmed_wash: rgba(255, 255, 255, 0.4),
            shadow: rgba(0, 0, 0, 0.2),
        }
    }
}

fn rubber_band(value: f32, limit: f32, dimension: f32) -> f32 {
    if value <= limit {
        return value;
    }
    limit + (1.0 - 1.0 / (((value - limit) * RUBBER_COEFFICIENT) / dimension + 1.0)) * dimension
}

pub fn swipe_progress(distance: f32) -> f32 {
    (distance / SWIPE_UNIT).max(0.0)
}

pub fn capsule_offset(progress: f32, width: f32) -> f32 {
    let limit = width + CAPSULE_INSET;
    rubber_band(progress * limit, limit, limit) - width
}

pub fn list_selection(dy_since_shown: f32, count: usize) -> (usize, f32) {
    let last = count.saturating_sub(1) as f32;
    let rows = dy_since_shown / SWIPE_UNIT;
    let index = rows.round().clamp(0.0, last) as usize;
    let past = if rows < 0.0 {
        rows
    } else if rows > last {
        rows - last
    } else {
        0.0
    };
    let overshoot = past.abs() * SWIPE_UNIT;
    let nudge = if past != 0.0 {
        past.signum() * LIST_ROW * (1.0 - 1.0 / (0.1 * overshoot + 1.0)) * 0.5
    } else {
        0.0
    };
    (index, nudge)
}

fn rows_above_selected(count: usize, selected: usize) -> f32 {
    count.saturating_sub(1).saturating_sub(selected) as f32
}

pub fn list_top(height: f32, count: usize, selected: usize) -> f32 {
    height / 2.0 - LIST_ROW / 2.0 - LIST_PAD - rows_above_selected(count, selected) * LIST_ROW
}

pub fn list_fit(height: f32) -> usize {
    (((height / 2.0 + LIST_ROW / 2.0 - LIST_PAD - 8.0) / LIST_ROW).floor() as usize).max(2)
}

pub fn swipe_items(
    steps: &[NavigationStep],
    direction: HistoryDirection,
    back_to_new_tab: bool,
) -> Vec<SwipeItem> {
    let items: Vec<HistoryItem> = history_items(steps, direction, LIST_MAX);
    let mut out: Vec<SwipeItem> = items
        .into_iter()
        .map(|item| SwipeItem {
            title: item.title,
            url: item.url,
            offset: Some(item.offset),
        })
        .collect();
    if direction == HistoryDirection::Back && back_to_new_tab && out.len() < LIST_MAX {
        out.push(SwipeItem {
            title: "New Tab".into(),
            url: String::new(),
            offset: None,
        });
    }
    out
}

pub fn commit_of(item: &SwipeItem) -> SwipeCommit {
    match item.offset {
        Some(-1) | None => SwipeCommit::Step(HistoryDirection::Back),
        Some(1) => SwipeCommit::Step(HistoryDirection::Forward),
        Some(offset) => SwipeCommit::Offset(offset),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Sprung {
    from: f32,
    to: f32,
    started: Option<Instant>,
    spring: Spring,
}

impl Sprung {
    fn at(value: f32) -> Self {
        Sprung {
            from: value,
            to: value,
            started: None,
            spring: SNAPPY,
        }
    }

    fn progress(&self, now: Instant) -> Option<f32> {
        let started = self.started?;
        let seconds = now.saturating_duration_since(started).as_secs_f64();
        (seconds < self.spring.settling_time(0.001)).then(|| self.spring.value(seconds, 0.0) as f32)
    }

    fn value(&self, now: Instant) -> f32 {
        match self.progress(now) {
            Some(t) => self.from + (self.to - self.from) * t,
            None => self.to,
        }
    }

    fn running(&self, now: Instant) -> bool {
        self.progress(now).is_some()
    }

    fn go(&mut self, to: f32, spring: Spring, now: Instant) {
        if (self.to - to).abs() < f32::EPSILON {
            return;
        }
        self.from = self.value(now);
        self.to = to;
        self.spring = spring;
        self.started = Some(now);
    }
}

fn delayed(from: f32, to: f32, delay: Duration, now: Instant) -> Tween {
    Tween {
        from,
        to,
        started: Some(now + delay),
        duration: duration::BASE,
        curve: Curve::Exit,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Shown {
    pub tab: TabId,
    pub direction: HistoryDirection,
    pub confirmed: bool,
    pub list: Option<Vec<SwipeItem>>,
    pub selected: usize,
}

#[derive(Clone, Debug)]
pub struct SwipeOverlay {
    shown: Option<Shown>,
    active: bool,
    pane_height: f32,
    height: f32,
    width: f32,
    items: Vec<SwipeItem>,
    list_y: f32,
    last_dy: f32,
    idle_at: Option<Instant>,
    gone_at: Option<Instant>,
    x: f32,
    w: Sprung,
    h: Sprung,
    top: Sprung,
    corner: Sprung,
    icon: Sprung,
    pill: Sprung,
    nudge: f32,
    confirm: Tween,
    list: Tween,
    fade: Tween,
    scale: Tween,
}

impl Default for SwipeOverlay {
    fn default() -> Self {
        SwipeOverlay {
            shown: None,
            active: false,
            pane_height: 0.0,
            height: 0.0,
            width: CAPSULE_SIZE,
            items: Vec::new(),
            list_y: 0.0,
            last_dy: 0.0,
            idle_at: None,
            gone_at: None,
            x: -CAPSULE_SIZE,
            w: Sprung::at(CAPSULE_SIZE),
            h: Sprung::at(CAPSULE_SIZE),
            top: Sprung::at(0.0),
            corner: Sprung::at(CAPSULE_SIZE / 2.0),
            icon: Sprung::at(1.0),
            pill: Sprung::at(0.0),
            nudge: 0.0,
            confirm: Tween::at(0.0),
            list: Tween::at(0.0),
            fade: Tween::at(1.0),
            scale: Tween::at(1.0),
        }
    }
}

impl SwipeOverlay {
    pub fn shown(&self) -> Option<&Shown> {
        self.shown.as_ref()
    }

    pub fn note_pane(&mut self, pane: Rect) {
        self.pane_height = pane.h;
    }

    pub fn pane_height(&self) -> f32 {
        self.pane_height
    }

    pub fn list_open(&self) -> bool {
        self.shown.as_ref().is_some_and(|s| s.list.is_some())
    }

    fn reset(&mut self, tab: &TabId, direction: HistoryDirection, items: Vec<SwipeItem>) {
        let height = self.height;
        let pane_height = self.pane_height;
        *self = SwipeOverlay {
            height,
            pane_height,
            items,
            active: true,
            top: Sprung::at(height / 2.0 - CAPSULE_SIZE / 2.0),
            shown: Some(Shown {
                tab: tab.clone(),
                direction,
                confirmed: false,
                list: None,
                selected: 0,
            }),
            ..SwipeOverlay::default()
        };
    }

    fn confirmed(&self) -> bool {
        self.shown.as_ref().is_some_and(|s| s.confirmed)
    }

    fn layout_to(&mut self, width: f32, height: f32, top: f32, corner: f32, now: Instant) {
        self.width = width;
        self.w.go(width, SNAPPY, now);
        self.h.go(height, SNAPPY, now);
        self.top.go(top, SNAPPY, now);
        self.corner.go(corner, SNAPPY, now);
    }

    fn set_confirmed(&mut self, confirmed: bool, out: &mut SwipeEffects, now: Instant) {
        if self.confirmed() == confirmed {
            return;
        }
        if confirmed {
            out.haptics.push(SwipeHaptic::LevelChange);
        }
        if !self.list_open() {
            let side = if confirmed {
                CAPSULE_SIZE_CONFIRMED
            } else {
                CAPSULE_SIZE
            };
            let height = self.height;
            self.layout_to(side, side, height / 2.0 - side / 2.0, side / 2.0, now);
            let scale = if confirmed {
                ICON_CONFIRMED / ICON
            } else {
                1.0
            };
            self.icon.go(scale, SNAPPY, now);
        }
        self.confirm.retarget(
            if confirmed { 1.0 } else { 0.0 },
            duration::BASE,
            Curve::Fade,
            now,
        );
        if let Some(shown) = self.shown.as_mut() {
            shown.confirmed = confirmed;
        }
    }

    fn present_list(&mut self, out: &mut SwipeEffects, now: Instant) {
        if !self.active || self.list_open() || !self.confirmed() || self.items.len() < 2 {
            return;
        }
        let fit = list_fit(self.height);
        let list: Vec<SwipeItem> = self.items.iter().take(fit).cloned().collect();
        let count = list.len();
        self.list_y = self.last_dy;
        out.haptics.push(SwipeHaptic::Generic);
        self.pill = Sprung::at(rows_above_selected(count, 0) * LIST_ROW);
        let height = self.height;
        self.layout_to(
            LIST_WIDTH,
            count as f32 * LIST_ROW + LIST_PAD * 2.0,
            list_top(height, count, 0),
            radius::SHEET,
            now,
        );
        self.list.retarget(1.0, duration::SLOW, Curve::Fade, now);
        if let Some(shown) = self.shown.as_mut() {
            shown.list = Some(list);
            shown.selected = 0;
        }
        ardia_telemetry::counts::count("swipe_history_list_opens");
        out.list_open = Some(true);
    }

    fn fold_list(&mut self, out: &mut SwipeEffects, now: Instant) {
        self.nudge = 0.0;
        self.list.retarget(0.0, duration::SLOW, Curve::Fade, now);
        if let Some(shown) = self.shown.as_mut() {
            shown.list = None;
            shown.selected = 0;
        }
        ardia_telemetry::counts::count("swipe_history_list_folds");
        out.list_open = Some(false);
    }

    fn select(&mut self, dy: f32, out: &mut SwipeEffects, now: Instant) {
        let Some(shown) = self.shown.as_mut() else {
            return;
        };
        let Some(count) = shown.list.as_ref().map(Vec::len) else {
            return;
        };
        let (index, nudge) = list_selection(dy - self.list_y, count);
        self.nudge = nudge;
        if index == shown.selected {
            return;
        }
        shown.selected = index;
        out.haptics.push(SwipeHaptic::Alignment);
        self.top
            .go(list_top(self.height, count, index), PILL_SPRING, now);
        self.pill.go(
            rows_above_selected(count, index) * LIST_ROW,
            PILL_SPRING,
            now,
        );
    }

    fn dismiss(&mut self, delay: Duration, out: &mut SwipeEffects, now: Instant) {
        self.idle_at = None;
        self.active = false;
        let fade = self.fade.value(now);
        let scale = self.scale.value(now);
        self.fade = delayed(fade, 0.0, delay, now);
        self.scale = delayed(scale, 0.01, delay, now);
        self.gone_at = Some(now + delay + duration::BASE);
        if self.list_open() {
            out.list_open = Some(false);
        }
    }

    fn commit(
        &self,
        tab: &TabId,
        direction: HistoryDirection,
        item: Option<&SwipeItem>,
    ) -> (TabId, SwipeCommit) {
        (
            tab.clone(),
            item.map_or(SwipeCommit::Step(direction), commit_of),
        )
    }

    pub fn on_swipe(
        &mut self,
        event: &PageSwipe,
        height: f32,
        items_for: impl FnOnce(HistoryDirection) -> Vec<SwipeItem>,
        now: Instant,
    ) -> SwipeEffects {
        let mut out = SwipeEffects::default();
        self.height = height;
        self.last_dy = event.dy;
        if matches!(event.phase, SwipePhase::Began | SwipePhase::Swipe) {
            let was_open = self.list_open();
            self.reset(&event.tab, event.direction, items_for(event.direction));
            if was_open {
                out.list_open = Some(false);
            }
        }
        if !self.active || self.shown.as_ref().is_none_or(|s| s.tab != event.tab) {
            return out;
        }
        let direction = event.direction;
        match event.phase {
            SwipePhase::Swipe => {
                self.x = CAPSULE_INSET;
                self.set_confirmed(true, &mut out, now);
                out.commit = Some(self.commit(&event.tab, direction, None));
                self.dismiss(SWIPE_DISMISS_DELAY, &mut out, now);
                return out;
            }
            SwipePhase::Cancelled => {
                self.dismiss(Duration::ZERO, &mut out, now);
                return out;
            }
            SwipePhase::Ended => {
                let target = self
                    .shown
                    .as_ref()
                    .and_then(|s| s.list.as_ref().and_then(|l| l.get(s.selected)))
                    .cloned();
                if target.is_some() || self.confirmed() {
                    out.commit = Some(self.commit(&event.tab, direction, target.as_ref()));
                }
                self.dismiss(Duration::ZERO, &mut out, now);
                return out;
            }
            SwipePhase::Began | SwipePhase::Changed => {}
        }
        let progress = swipe_progress(event.distance);
        if self.list_open() && progress < LIST_FOLD_PROGRESS {
            self.fold_list(&mut out, now);
        }
        if self.list_open() {
            self.select(event.dy, &mut out, now);
        } else {
            self.set_confirmed(progress >= 1.0, &mut out, now);
        }
        self.x = capsule_offset(progress, self.width);
        self.idle_at = (self.confirmed() && !self.list_open()).then(|| now + LIST_IDLE);
        out
    }

    pub fn tick(&mut self, now: Instant) -> SwipeEffects {
        let mut out = SwipeEffects::default();
        if self.idle_at.is_some_and(|at| now >= at) {
            self.idle_at = None;
            self.present_list(&mut out, now);
        }
        if self.gone_at.is_some_and(|at| now >= at) {
            self.gone_at = None;
            self.shown = None;
        }
        out
    }

    pub fn animating(&self, now: Instant) -> bool {
        self.shown.is_some()
            && (self.idle_at.is_some()
                || self.gone_at.is_some()
                || self.w.running(now)
                || self.h.running(now)
                || self.top.running(now)
                || self.corner.running(now)
                || self.icon.running(now)
                || self.pill.running(now)
                || self.confirm.running(now)
                || self.list.running(now)
                || self.fade.running(now)
                || self.scale.running(now))
    }

    pub fn render(
        &self,
        c: &Chrome,
        pane: Rect,
        back_closes: bool,
        now: Instant,
    ) -> Option<AnyElement> {
        let shown = self.shown.as_ref()?;
        let colors = swipe_colors(c.look.dark);
        let back = shown.direction != HistoryDirection::Forward;
        let glyph = match (back, back_closes) {
            (true, true) => Icon::XMark,
            (true, false) => Icon::ChevronLeft,
            (false, _) => Icon::ChevronRight,
        };
        let w = self.w.value(now);
        let h = self.h.value(now);
        let top = self.top.value(now) + self.nudge;
        let corner = self.corner.value(now);
        let confirm = self.confirm.value(now);
        let list = self.list.value(now);
        let fade = self.fade.value(now).clamp(0.0, 1.0);
        let scale = self.scale.value(now).max(0.0);
        let left = if back { self.x } else { pane.w - self.x - w };
        let (sw, sh) = (w * scale, h * scale);
        let icon_opacity = (0.5 + 0.5 * confirm) * (1.0 - list);
        let icon_side = ICON * self.icon.value(now) * scale;
        let p = *c.p;
        let surface = div()
            .absolute()
            .left(px((w - sw) / 2.0))
            .top(px((h - sh) / 2.0))
            .w(px(sw))
            .h(px(sh))
            .opacity(fade)
            .rounded(px(corner * scale))
            .bg(p.popover_fill)
            .shadow(vec![BoxShadow {
                color: colors.shadow,
                offset: point(px(0.0), px(2.0)),
                blur_radius: px(8.0),
                spread_radius: px(0.0),
                inset: false,
            }])
            .overflow_hidden()
            .when(!c.look.dark && confirm > 0.0, |this| {
                this.child(
                    div()
                        .absolute()
                        .inset_0()
                        .bg(colors.confirmed_wash)
                        .opacity(confirm),
                )
            })
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .opacity(icon_opacity)
                    .child(
                        div()
                            .size(px(icon_side + 6.0 * scale))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                icon(glyph, icon_side, colors.chevron).weight(SymbolWeight::Bold),
                            ),
                    ),
            )
            .when_some(shown.list.as_ref(), |this, items| {
                this.child(self.destination_list(c, items, shown.selected, list, scale, now))
            })
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(corner * scale))
                    .border(px(1.0))
                    .border_color(colors.rim),
            );
        let clip = pane_clip(left, top, w, h, pane.w, pane.h)?;
        Some(
            div()
                .absolute()
                .left(px(pane.x + clip.x))
                .top(px(pane.y + clip.y))
                .w(px(clip.w))
                .h(px(clip.h))
                .overflow_hidden()
                .debug_selector(|| "swipe-capsule".into())
                .child(
                    div()
                        .absolute()
                        .left(px(left - clip.x))
                        .top(px(top - clip.y))
                        .w(px(w))
                        .h(px(h))
                        .child(surface),
                )
                .into_any_element(),
        )
    }

    fn destination_list(
        &self,
        c: &Chrome,
        items: &[SwipeItem],
        selected: usize,
        appear: f32,
        outer: f32,
        now: Instant,
    ) -> AnyElement {
        let colors = swipe_colors(c.look.dark);
        let p = *c.p;
        let k = (0.9 + 0.1 * appear) * outer;
        let count = items.len();
        let full_h = count as f32 * LIST_ROW + LIST_PAD * 2.0;
        let profile = c.window.profile_id.clone();
        let history = c.state.history_of(&profile).cloned();
        let rows = items.iter().enumerate().rev().map(|(i, item)| {
            let favicon_url = history
                .as_ref()
                .and_then(|h| h.get(&item.url))
                .and_then(|entry| entry.favicon.clone());
            let favicon = resolve_favicon(
                favicon_of(&item.url, favicon_url.as_deref(), None, &item.title),
                c.host.as_ref(),
                &profile,
            );
            div()
                .h(px(LIST_ROW * k))
                .flex()
                .flex_row()
                .items_center()
                .px(px(space::XL * k))
                .gap(px(space::ML * k))
                .child(
                    div()
                        .size(px(16.0 * k))
                        .flex_none()
                        .rounded(px(radius::CONTROL * k))
                        .overflow_hidden()
                        .child(render_favicon(&favicon, 16.0 * k, &p)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(13.0 * k))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(if i == selected {
                            p.text
                        } else {
                            p.text_secondary
                        })
                        .child(SharedString::from(item.title.clone())),
                )
        });
        let width = LIST_WIDTH * k;
        let height = full_h * k;
        div()
            .absolute()
            .left(px((LIST_WIDTH * outer - width) / 2.0))
            .top(px((full_h * outer - height) / 2.0))
            .w(px(width))
            .h(px(height))
            .opacity(appear)
            .child(
                div()
                    .absolute()
                    .left(px(space::M * k))
                    .right(px(space::M * k))
                    .top(px((LIST_PAD + self.pill.value(now)) * k))
                    .h(px(LIST_ROW * k))
                    .rounded(px((radius::SHEET - space::M).max(0.0) * k))
                    .bg(colors.selection),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .top(px(LIST_PAD * k))
                    .w(px(width))
                    .flex()
                    .flex_col()
                    .children(rows),
            )
            .into_any_element()
    }
}

pub fn pane_clip(left: f32, top: f32, w: f32, h: f32, pane_w: f32, pane_h: f32) -> Option<Rect> {
    let x = left.max(0.0);
    let y = top.max(0.0);
    let right = (left + w).min(pane_w);
    let bottom = (top + h).min(pane_h);
    (right > x && bottom > y).then(|| Rect::new(x, y, right - x, bottom - y))
}

pub fn items_for<'a>(
    host: &'a dyn UiHost,
    tab: &'a TabId,
) -> impl FnOnce(HistoryDirection) -> Vec<SwipeItem> + 'a {
    move |direction| {
        swipe_items(
            &host.navigation_steps(tab),
            direction,
            host.back_to_new_tab(tab),
        )
    }
}

pub fn back_closes(state: &BrowserState, host: &dyn UiHost, tab: Option<&TabId>) -> bool {
    tab.and_then(|t| state.tab(t.as_str()))
        .is_some_and(|t| history_of(state, t, host).back_closes)
}

pub fn effects_msgs(
    state: &BrowserState,
    host: &dyn UiHost,
    window: &WindowId,
    out: SwipeEffects,
) -> Vec<Msg> {
    for haptic in out.haptics {
        host.swipe_haptic(haptic);
    }
    if let Some(open) = out.list_open {
        host.note_swipe_list(window, open);
    }
    let Some((tab, commit)) = out.commit else {
        return Vec::new();
    };
    match commit {
        SwipeCommit::Step(HistoryDirection::Back) => state
            .tab(tab.as_str())
            .map(|t| back_msgs(state, t, host.back_to_new_tab(&tab)))
            .unwrap_or_default(),
        SwipeCommit::Step(HistoryDirection::Forward) => vec![Msg::Forward(tab)],
        SwipeCommit::Offset(offset) => {
            host.go_to_offset(tab, offset);
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn swipe(phase: SwipePhase, distance: f32, dy: f32) -> PageSwipe {
        PageSwipe {
            tab: TabId::new("t"),
            phase,
            direction: HistoryDirection::Back,
            distance,
            dy,
            velocity: 0.0,
        }
    }

    fn items(n: usize) -> Vec<SwipeItem> {
        (0..n)
            .map(|i| SwipeItem {
                title: format!("Page {i}"),
                url: format!("https://e.com/{i}"),
                offset: Some(-(i as i32) - 1),
            })
            .collect()
    }

    #[test]
    fn the_capsule_follows_the_fingers_then_rubber_bands() {
        assert_eq!(swipe_progress(-5.0), 0.0);
        assert_eq!(swipe_progress(75.0), 1.0);
        assert_eq!(capsule_offset(0.0, CAPSULE_SIZE), -CAPSULE_SIZE);
        assert!((capsule_offset(1.0, CAPSULE_SIZE) - CAPSULE_INSET).abs() < 1e-4);
        let far = capsule_offset(4.0, CAPSULE_SIZE);
        assert!(far > CAPSULE_INSET && far < CAPSULE_INSET + 86.0 * 0.5);
    }

    #[test]
    fn the_list_selection_rounds_rows_and_nudges_past_the_ends() {
        assert_eq!(list_selection(0.0, 3), (0, 0.0));
        assert_eq!(list_selection(80.0, 3).0, 1);
        assert_eq!(list_selection(400.0, 3).0, 2);
        assert!(list_selection(400.0, 3).1 > 0.0);
        assert!(list_selection(-60.0, 3).1 < 0.0);
        assert!(list_selection(-6000.0, 3).1 > -LIST_ROW / 2.0);
        assert_eq!(list_fit(100.0), 2);
        assert_eq!(list_fit(800.0), 10);
        assert_eq!(list_top(800.0, 1, 0), 400.0 - 19.0 - 8.0);
    }

    #[test]
    fn a_swipe_past_one_unit_confirms_and_commits_on_release() {
        let now = Instant::now();
        let mut o = SwipeOverlay::default();
        o.on_swipe(
            &swipe(SwipePhase::Began, 5.0, 0.0),
            600.0,
            |_| items(1),
            now,
        );
        assert!(o.shown().is_some_and(|s| !s.confirmed));
        let out = o.on_swipe(
            &swipe(SwipePhase::Changed, 80.0, 0.0),
            600.0,
            |_| items(1),
            now,
        );
        assert_eq!(out.haptics, vec![SwipeHaptic::LevelChange]);
        assert!(o.shown().unwrap().confirmed);
        let out = o.on_swipe(
            &swipe(SwipePhase::Ended, 80.0, 0.0),
            600.0,
            |_| items(1),
            now,
        );
        assert_eq!(
            out.commit,
            Some((TabId::new("t"), SwipeCommit::Step(HistoryDirection::Back)))
        );
        assert!(o.shown().is_some());
        o.tick(now + Duration::from_millis(200));
        assert!(o.shown().is_none());
    }

    #[test]
    fn a_short_swipe_goes_nowhere() {
        let now = Instant::now();
        let mut o = SwipeOverlay::default();
        o.on_swipe(
            &swipe(SwipePhase::Began, 5.0, 0.0),
            600.0,
            |_| items(3),
            now,
        );
        o.on_swipe(
            &swipe(SwipePhase::Changed, 60.0, 0.0),
            600.0,
            |_| items(3),
            now,
        );
        let out = o.on_swipe(
            &swipe(SwipePhase::Ended, 60.0, 0.0),
            600.0,
            |_| items(3),
            now,
        );
        assert_eq!(out.commit, None);
    }

    #[test]
    fn holding_a_confirmed_swipe_opens_the_list_and_scrolling_picks_a_row() {
        let now = Instant::now();
        let mut o = SwipeOverlay::default();
        o.on_swipe(
            &swipe(SwipePhase::Began, 5.0, 0.0),
            600.0,
            |_| items(4),
            now,
        );
        o.on_swipe(
            &swipe(SwipePhase::Changed, 90.0, 0.0),
            600.0,
            |_| items(4),
            now,
        );
        assert!(o.tick(now + Duration::from_millis(299)).list_open.is_none());
        let later = now + LIST_IDLE;
        let out = o.tick(later);
        assert_eq!(out.list_open, Some(true));
        assert_eq!(out.haptics, vec![SwipeHaptic::Generic]);
        let out = o.on_swipe(
            &swipe(SwipePhase::Changed, 90.0, 160.0),
            600.0,
            |_| items(4),
            later,
        );
        assert_eq!(out.haptics, vec![SwipeHaptic::Alignment]);
        assert_eq!(o.shown().unwrap().selected, 2);
        let out = o.on_swipe(
            &swipe(SwipePhase::Ended, 90.0, 160.0),
            600.0,
            |_| items(4),
            later,
        );
        assert_eq!(out.commit, Some((TabId::new("t"), SwipeCommit::Offset(-3))));
        assert_eq!(out.list_open, Some(false));
    }

    #[test]
    fn backing_off_folds_the_list() {
        let now = Instant::now();
        let mut o = SwipeOverlay::default();
        o.on_swipe(
            &swipe(SwipePhase::Began, 5.0, 0.0),
            600.0,
            |_| items(4),
            now,
        );
        o.on_swipe(
            &swipe(SwipePhase::Changed, 90.0, 0.0),
            600.0,
            |_| items(4),
            now,
        );
        o.tick(now + LIST_IDLE);
        let out = o.on_swipe(
            &swipe(SwipePhase::Changed, 40.0, 0.0),
            600.0,
            |_| items(4),
            now + LIST_IDLE,
        );
        assert_eq!(out.list_open, Some(false));
        assert!(!o.list_open());
    }

    #[test]
    fn a_discrete_swipe_commits_at_once() {
        let now = Instant::now();
        let mut o = SwipeOverlay::default();
        let out = o.on_swipe(
            &swipe(SwipePhase::Swipe, 0.0, 0.0),
            600.0,
            |_| items(2),
            now,
        );
        assert_eq!(
            out.commit,
            Some((TabId::new("t"), SwipeCommit::Step(HistoryDirection::Back)))
        );
        assert!(o.animating(now));
    }

    #[test]
    fn history_rows_end_with_the_new_tab_behind() {
        let steps = vec![
            NavigationStep {
                url: "https://a.com/".into(),
                title: "A".into(),
                current: false,
            },
            NavigationStep {
                url: "https://b.com/".into(),
                title: String::new(),
                current: true,
            },
        ];
        let rows = swipe_items(&steps, HistoryDirection::Back, true);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].offset, Some(-1));
        assert_eq!(rows[1].offset, None);
        assert_eq!(
            commit_of(&rows[1]),
            SwipeCommit::Step(HistoryDirection::Back)
        );
        assert!(swipe_items(&steps, HistoryDirection::Forward, true).is_empty());
    }

    #[test]
    fn the_capsule_is_clipped_to_its_pane_like_the_old_tab_pane() {
        let clip = pane_clip(-30.0, 100.0, 72.0, 72.0, 800.0, 600.0).unwrap();
        assert_eq!((clip.x, clip.y, clip.w, clip.h), (0.0, 100.0, 42.0, 72.0));
        let right = pane_clip(760.0, 100.0, 72.0, 72.0, 800.0, 600.0).unwrap();
        assert_eq!(right.w, 40.0);
        assert!(pane_clip(-80.0, 100.0, 72.0, 72.0, 800.0, 600.0).is_none());
        let inside = pane_clip(14.0, 100.0, 82.0, 82.0, 800.0, 600.0).unwrap();
        assert_eq!((inside.x, inside.w), (14.0, 82.0));
    }

    #[test]
    fn colors_match_the_old_window_tokens() {
        let dark = swipe_colors(true);
        assert!((dark.rim.a - 0.15).abs() < 1e-4);
        assert!((swipe_colors(false).rim.a - 0.125).abs() < 1e-4);
        assert!((swipe_colors(false).shadow.a - 0.2).abs() < 1e-4);
    }
}
