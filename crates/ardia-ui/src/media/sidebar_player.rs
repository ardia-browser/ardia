use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use ardia_state::tabs::Tab;
use ardia_state::{ProfileId, TabId};
use ardia_theme::motion::CubicBezier;
use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, App, FontWeight, Hsla, InteractiveElement, IntoElement, MouseButton, ObjectFit,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, StyledImage, Window, div, img,
    prelude::*,
};

use crate::icon_picker::symbols::{SymbolWeight, symbol};
use crate::media::marquee::marquee;
use crate::media::mini_player::{
    TICK_MS, animating, artwork, media_tokens, mute_title, muted, now_ms, seek_dragging,
    tabular_label, ticker, time_bar, toggle_mute,
};
use crate::media::session::{MediaAction, Session, format_time, transport_icons};
use crate::msg::Msg;
use crate::primitives::controls::tooltip;
use crate::primitives::favicon::render_favicon;
use crate::scale::px;
use crate::window::chrome::Chrome;

pub const ROW_HEIGHT: f32 = 40.0;
const ROW_INSET: f32 = space::S;
const TRAILING_INSET: f32 = space::XS;
const ART: f32 = 28.0;
const LIVE_DOT: f32 = 6.0;
const BUTTON: f32 = 24.0;
const TITLE_HEIGHT: f32 = 16.0;
const ARTIST_HEIGHT: f32 = 14.0;
const TITLE_DROP: f32 = ARTIST_HEIGHT / 2.0;
const SEEK_ROW: f32 = 18.0;
const CONTROLS_ROW: f32 = 32.0;
const CONTROLS_GAP: f32 = space::S;
const CONTROLS_LIFT: f32 = space::S;
const EXPANDED_BOTTOM: f32 = space::XS;
pub const EXPANDED_HEIGHT: f32 = ROW_HEIGHT + SEEK_ROW + CONTROLS_ROW + EXPANDED_BOTTOM;
pub const GROWTH: f32 = EXPANDED_HEIGHT - ROW_HEIGHT;
const HOVER_SLOP: f32 = space::M;
pub const EXPAND_MS: f32 = 220.0;
pub const COLLAPSE_MS: f32 = 180.0;
pub const COLLAPSE_DELAY_MS: f32 = 160.0;
pub const UNPIN_MS: f32 = 150.0;
const MARQUEE_PASSES_AT_REST: i32 = 1;
pub const SLOT_PAD: f32 = space::M;
pub const SIDEBAR_PLAYER_HEIGHT: f32 = ROW_HEIGHT + SLOT_PAD;

#[derive(Clone, Debug)]
pub struct Motion {
    hovered: bool,
    trailing_hovered: bool,
    expanded: bool,
    slot_expanded: bool,
    collapse_from: Option<Instant>,
    from: f32,
    to: f32,
    started: Option<Instant>,
    span_ms: f32,
    pinned: bool,
    unpinned_at: Option<Instant>,
}

impl Default for Motion {
    fn default() -> Self {
        Motion {
            hovered: false,
            trailing_hovered: false,
            expanded: false,
            slot_expanded: false,
            collapse_from: None,
            from: 0.0,
            to: 0.0,
            started: None,
            span_ms: 0.0,
            pinned: false,
            unpinned_at: None,
        }
    }
}

fn fade(t: f32) -> f32 {
    CubicBezier::HOVER_CARD.ease(f64::from(t.clamp(0.0, 1.0))) as f32
}

fn elapsed_ms(since: Instant, now: Instant) -> f32 {
    now.saturating_duration_since(since).as_secs_f32() * 1000.0
}

impl Motion {
    pub fn progress(&self, now: Instant) -> f32 {
        let Some(started) = self.started else {
            return self.to;
        };
        let t = if self.span_ms <= 0.0 {
            1.0
        } else {
            elapsed_ms(started, now) / self.span_ms
        };
        self.from + (self.to - self.from) * fade(t)
    }

    fn settled(&self, now: Instant) -> bool {
        self.started
            .is_none_or(|s| self.span_ms <= 0.0 || elapsed_ms(s, now) >= self.span_ms)
    }

    fn run_to(&mut self, to: f32, span_ms: f32, now: Instant) {
        self.from = self.progress(now);
        self.to = to;
        self.started = Some(now);
        self.span_ms = span_ms;
    }

    pub fn step(&mut self, want: bool, now: Instant) {
        if want {
            self.collapse_from = None;
            if !self.expanded {
                ardia_telemetry::counts::count("sidebar_player_expands");
                if self.to == 0.0 && !self.settled(now) {
                    ardia_telemetry::counts::count("sidebar_player_reopens");
                }
                self.expanded = true;
                self.run_to(1.0, EXPAND_MS, now);
            }
        } else if self.expanded {
            let since = *self.collapse_from.get_or_insert(now);
            if elapsed_ms(since, now) >= COLLAPSE_DELAY_MS {
                self.collapse_from = None;
                self.expanded = false;
                self.slot_expanded = false;
                self.run_to(0.0, COLLAPSE_MS, now);
            }
        }
        if self.expanded && self.settled(now) {
            self.slot_expanded = true;
        }
        if self.trailing_hovered && !self.slot_expanded && !self.pinned {
            self.pinned = true;
            self.unpinned_at = None;
        } else if !self.trailing_hovered && self.pinned {
            self.pinned = false;
            self.unpinned_at = Some(now);
        }
    }

    pub fn pin(&self, now: Instant) -> f32 {
        if self.pinned {
            return 1.0;
        }
        self.unpinned_at
            .map_or(0.0, |at| 1.0 - fade(elapsed_ms(at, now) / UNPIN_MS))
    }

    pub fn moving(&self, now: Instant) -> bool {
        !self.settled(now)
            || self.collapse_from.is_some()
            || self
                .unpinned_at
                .is_some_and(|at| elapsed_ms(at, now) < UNPIN_MS)
    }

    pub fn slot_expanded(&self) -> bool {
        self.slot_expanded
    }

    pub fn expanded(&self) -> bool {
        self.expanded
    }

    pub fn pinned(&self) -> bool {
        self.pinned
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reveal {
    pub trailing: f32,
    pub unpinned: f32,
    pub title_drop: f32,
    pub artist: f32,
    pub seek: f32,
    pub controls: f32,
    pub controls_lift: f32,
    pub closing: f32,
}

fn ramp(p: f32, from: f32, to: f32) -> f32 {
    ((p - from) / (to - from)).clamp(0.0, 1.0)
}

pub fn reveal(p: f32, pin: f32) -> Reveal {
    Reveal {
        trailing: ((1.0 - ramp(p, 0.0, 0.5)) + pin).clamp(0.0, 1.0),
        unpinned: 1.0 - pin,
        title_drop: TITLE_DROP * (1.0 - p),
        artist: ramp(p, 0.3, 1.0),
        seek: ramp(p, 0.7, 1.0),
        controls: ramp(p, 0.45, 1.0),
        controls_lift: (-GROWTH + CONTROLS_LIFT) * (1.0 - p),
        closing: ramp(p, 0.5, 1.0),
    }
}

thread_local! {
    static MOTIONS: RefCell<HashMap<String, Motion>> = RefCell::new(HashMap::new());
}

fn with_motion<R>(key: &str, f: impl FnOnce(&mut Motion) -> R) -> R {
    MOTIONS.with(|m| f(m.borrow_mut().entry(key.to_owned()).or_default()))
}

pub fn player_height(c: &Chrome, profile: &ProfileId) -> f32 {
    if c.host.sidebar_player_tab(&c.window.id, profile).is_some() {
        SIDEBAR_PLAYER_HEIGHT
    } else {
        0.0
    }
}

fn group_fill(dark: bool, emphasized: bool) -> Hsla {
    match (dark, emphasized) {
        (true, false) => Hsla::white().opacity(0.1),
        (true, true) => Hsla::white().opacity(0.12),
        (false, false) => Hsla::black().opacity(0.05),
        (false, true) => Hsla::black().opacity(0.07),
    }
}

fn group_stroke(dark: bool) -> Hsla {
    if dark {
        Hsla::white().opacity(0.1)
    } else {
        Hsla::black().opacity(0.1)
    }
}

fn glass_fill(c: &Chrome, lit: bool) -> AnyElement {
    use crate::primitives::glass::{GlassState, control_glass};
    control_glass(
        c.look,
        radius::PANEL,
        if lit {
            GlassState::Lit
        } else {
            GlassState::Rest
        },
    )
    .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn icon_button(
    c: &Chrome,
    id: String,
    name: &'static str,
    side: f32,
    glyph: f32,
    tip: &'static str,
    enabled: bool,
    run: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let (hover, pressed) = (c.p.toolbar_hover, c.p.toolbar_pressed);
    div()
        .id(gpui::SharedString::from(id))
        .flex_none()
        .size(px(side))
        .rounded(px(radius::CONTROL))
        .flex()
        .items_center()
        .justify_center()
        .when(enabled, |this| {
            this.hover(move |s| s.bg(hover))
                .active(move |s| s.bg(pressed))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(move |_, window, cx| {
                    cx.stop_propagation();
                    run(window, cx);
                })
        })
        .tooltip(tooltip(tip.into(), c.p))
        .child(symbol(
            c.host.as_ref(),
            name,
            glyph,
            side,
            SymbolWeight::Regular,
            c.p.icon,
        ))
        .into_any_element()
}

fn act(c: &Chrome, tab: &TabId, action: MediaAction) -> impl Fn(&mut Window, &mut App) + 'static {
    let host = Arc::clone(c.host);
    let tab = tab.clone();
    move |_, _| host.media_action(tab.clone(), action)
}

fn play_button(
    c: &Chrome,
    key: &str,
    tab: &TabId,
    playing: bool,
    large: bool,
    enabled: bool,
) -> AnyElement {
    let (side, glyph) = if large { (26.0, 12.0) } else { (BUTTON, 11.0) };
    icon_button(
        c,
        format!("{key}:play:{large}"),
        if playing { "pause.fill" } else { "play.fill" },
        side,
        glyph,
        if playing { "Pause" } else { "Play" },
        enabled,
        act(c, tab, MediaAction::Toggle),
    )
}

fn controls(
    c: &Chrome,
    key: &str,
    tab: &Tab,
    session: &Session,
    r: Reveal,
    pinned: bool,
    enabled: bool,
) -> AnyElement {
    let tokens = media_tokens(c);
    let icons = transport_icons(&session.now);
    let playing = session.now.is_playing();
    let video = session.now.has_video || c.host.media_pip_open(&tab.id);
    let pip = c.host.media_pip_open(&tab.id);
    let mute_host = Arc::clone(c.host);
    let mute_tab = tab.clone();
    let pip_host = Arc::clone(c.host);
    let pip_tab = tab.id.clone();
    div()
        .px(px(ROW_INSET + 2.0))
        .flex()
        .flex_col()
        .child(div().h(px(SEEK_ROW)).flex().opacity(r.seek).child(time_bar(
            c.host,
            format!("{key}:seek"),
            &tab.id,
            session,
            tokens,
            true,
        )))
        .child(
            div()
                .h(px(CONTROLS_ROW))
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .opacity(r.controls)
                .child(icon_button(
                    c,
                    format!("{key}:mute"),
                    if muted(c, tab) {
                        "speaker.slash.fill"
                    } else {
                        "speaker.wave.2.fill"
                    },
                    BUTTON,
                    11.0,
                    mute_title(c, tab),
                    enabled,
                    move |_, _| toggle_mute(&mute_host, &mute_tab),
                ))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(CONTROLS_GAP))
                        .child(icon_button(
                            c,
                            format!("{key}:back"),
                            icons.back,
                            BUTTON,
                            11.0,
                            icons.back_tip,
                            enabled,
                            act(c, &tab.id, MediaAction::Back),
                        ))
                        .child(play_button(c, key, &tab.id, playing, true, enabled))
                        .child(icon_button(
                            c,
                            format!("{key}:ahead"),
                            icons.ahead,
                            BUTTON,
                            11.0,
                            icons.ahead_tip,
                            enabled,
                            act(c, &tab.id, MediaAction::Ahead),
                        )),
                )
                .child(div().opacity(r.unpinned).map(|this| {
                    if video {
                        this.child(icon_button(
                            c,
                            format!("{key}:pip"),
                            if pip { "pip.exit" } else { "pip.enter" },
                            BUTTON,
                            11.0,
                            if pip {
                                "Exit Picture in Picture"
                            } else {
                                "Picture in Picture"
                            },
                            enabled && !pinned,
                            move |_, _| pip_host.toggle_media_pip(pip_tab.clone()),
                        ))
                    } else {
                        this.child(div().w(px(BUTTON)))
                    }
                })),
        )
        .into_any_element()
}

fn row(c: &Chrome, key: &str, tab: &Tab, session: &Session, r: Reveal, want: bool) -> AnyElement {
    let tokens = media_tokens(c);
    let title = if session.now.title.is_empty() {
        tab.display_title()
    } else {
        session.now.title.clone()
    };
    let artist = if session.now.artist.is_empty() {
        ardia_state::omnibox::url::host_of(&tab.url)
    } else {
        session.now.artist.clone()
    };
    let reset = format!("{title}|{artist}");
    let iterations = if want { -1 } else { MARQUEE_PASSES_AT_REST };
    let art = artwork(c, tab, session);
    let has_artist = !artist.is_empty();
    div()
        .id(gpui::SharedString::from(format!("{key}:row")))
        .debug_selector(|| "sidebar-player-row".into())
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_row()
        .items_center()
        .mr(px(TRAILING_INSET))
        .cursor_pointer()
        .group(SharedString::from(format!("{key}:row-press")))
        .on_click(c.emit.click(Msg::Store(ardia_state::Action::ActivateTab {
            tab: tab.id.clone(),
        })))
        .child(
            div()
                .id(gpui::SharedString::from(format!("{key}:art")))
                .flex_none()
                .size(px(ART))
                .rounded(px(radius::CONTROL))
                .overflow_hidden()
                .bg(tokens.art_placeholder)
                .flex()
                .items_center()
                .justify_center()
                .tooltip(tooltip("Back to Tab".into(), c.p))
                .group_active(SharedString::from(format!("{key}:row-press")), |s| {
                    s.scale(crate::primitives::tokens::press_scale::CONTROL)
                })
                .map(|this| match art {
                    Some(image) => this.child(
                        img(image)
                            .size(px(ART))
                            .rounded(px(radius::CONTROL))
                            .object_fit(ObjectFit::Cover),
                    ),
                    None => this.child(render_favicon(&c.favicon(tab), 16.0, c.p)),
                }),
        )
        .when(session.now.is_live(), |this| {
            this.child(
                div()
                    .flex_none()
                    .ml(px(space::M))
                    .size(px(LIVE_DOT))
                    .rounded_full()
                    .bg(c.p.destructive),
            )
        })
        .when(muted(c, tab), |this| {
            this.child(
                div()
                    .flex_none()
                    .ml(px(space::S))
                    .w(px(13.0))
                    .h(px(12.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(symbol(
                        c.host.as_ref(),
                        "speaker.slash.fill",
                        9.0,
                        12.0,
                        SymbolWeight::Regular,
                        c.p.text_secondary,
                    )),
            )
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .ml(px(space::S))
                .flex()
                .flex_col()
                .when(has_artist, |this| this.relative().top(px(r.title_drop)))
                .child(
                    div().h(px(TITLE_HEIGHT)).flex().child(
                        marquee(key, &reset, iterations, "title", title)
                            .size(12.0, TITLE_HEIGHT - 1.0)
                            .weight(FontWeight::SEMIBOLD)
                            .color(c.p.text),
                    ),
                )
                .when(has_artist, |this| {
                    this.child(
                        div().h(px(ARTIST_HEIGHT)).flex().opacity(r.artist).child(
                            marquee(key, &reset, iterations, "artist", artist)
                                .size(11.0, ARTIST_HEIGHT)
                                .color(c.p.text_secondary),
                        ),
                    )
                }),
        )
        .into_any_element()
}

fn time_left(c: &Chrome, key: &str, tab: &TabId, session: &Session, enabled: bool) -> AnyElement {
    let tokens = media_tokens(c);
    let left = format_time(session.now.duration.unwrap_or(0.0) - session.now.position_at(now_ms()));
    div()
        .id(gpui::SharedString::from(format!("{key}:left")))
        .h(px(BUTTON))
        .min_w(px(BUTTON))
        .px(px(space::XS))
        .flex()
        .items_center()
        .justify_end()
        .child(ticker(format!("{key}:left"), TICK_MS))
        .child(tabular_label(
            format!("-{left}"),
            11.0,
            14.0,
            tokens.secondary,
        ))
        .when(enabled, |this| {
            let run = act(c, tab, MediaAction::Toggle);
            this.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(move |_, window, cx| {
                    cx.stop_propagation();
                    run(window, cx);
                })
        })
        .into_any_element()
}

pub fn sidebar_player(c: &Chrome, profile: &ProfileId, docked: bool) -> Option<AnyElement> {
    let tab_id = c.host.sidebar_player_tab(&c.window.id, profile)?;
    let tab = c.state.tab(tab_id.as_str())?.clone();
    let session = c.host.media_session(&tab_id)?;
    let key = format!("sidebar-player:{}:{}", c.window.id, profile);
    let now = Instant::now();
    let seeking = seek_dragging(&format!("{key}:seek"));
    let (p, pin, expanded, slot_expanded, pinned, moving, want) = with_motion(&key, |m| {
        let want = m.hovered || seeking;
        m.step(want, now);
        (
            m.progress(now),
            m.pin(now),
            m.expanded(),
            m.slot_expanded(),
            m.pinned(),
            m.moving(now),
            want,
        )
    });
    let r = reveal(p, pin);
    let settled = expanded && slot_expanded;
    let playing = session.now.is_playing();
    let below = if docked { 0.0 } else { HOVER_SLOP };
    let height = if slot_expanded {
        EXPANDED_HEIGHT
    } else {
        ROW_HEIGHT + GROWTH * p
    };
    let hover_key = key.clone();
    let trailing_key = key.clone();
    let fill = if c.look.glass {
        glass_fill(c, want)
    } else {
        div()
            .absolute()
            .inset_0()
            .rounded(px(radius::PANEL))
            .bg(group_fill(c.p.dark, want))
            .border(px(0.5))
            .border_color(group_stroke(c.p.dark))
            .into_any_element()
    };
    let close_host = Arc::clone(c.host);
    let close_tab = tab_id.clone();
    let room = if playing && session.now.duration.is_some() {
        div()
            .px(px(space::XS))
            .child(tabular_label(
                format!("-{}", format_time(session.now.duration.unwrap_or(0.0))),
                11.0,
                14.0,
                gpui::transparent_black(),
            ))
            .into_any_element()
    } else {
        div().w(px(BUTTON)).into_any_element()
    };
    let body = div()
        .debug_selector(|| "sidebar-player".into())
        .relative()
        .w_full()
        .h(px(height))
        .child(animating(moving))
        .child(
            div()
                .id(gpui::SharedString::from(format!("{key}:hover")))
                .absolute()
                .left(px(-HOVER_SLOP))
                .right(px(-HOVER_SLOP))
                .bottom(px(-below))
                .h(px(if expanded {
                    EXPANDED_HEIGHT
                } else {
                    ROW_HEIGHT
                } + HOVER_SLOP
                    + below))
                .on_hover(move |hovered, window, _| {
                    with_motion(&hover_key, |m| m.hovered = *hovered);
                    window.refresh();
                }),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .rounded(px(radius::PANEL))
                .overflow_hidden()
                .child(fill)
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .top(px(ROW_HEIGHT + r.controls_lift))
                        .child(controls(c, &key, &tab, &session, r, pinned, settled)),
                )
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .top_0()
                        .h(px(ROW_HEIGHT))
                        .pl(px(ROW_INSET))
                        .pr(px(TRAILING_INSET))
                        .flex()
                        .flex_row()
                        .items_center()
                        .child(row(c, &key, &tab, &session, r, want))
                        .child(
                            div()
                                .relative()
                                .min_w(px(BUTTON))
                                .h(px(BUTTON))
                                .flex()
                                .items_center()
                                .justify_end()
                                .child(div().invisible().child(room))
                                .child(
                                    div().absolute().top_0().right_0().opacity(r.closing).child(
                                        icon_button(
                                            c,
                                            format!("{key}:close"),
                                            "xmark",
                                            BUTTON,
                                            11.0,
                                            "Close Player",
                                            settled,
                                            move |_, _| {
                                                close_host.dismiss_player(close_tab.clone())
                                            },
                                        ),
                                    ),
                                ),
                        ),
                ),
        )
        .child(
            div()
                .id(gpui::SharedString::from(format!("{key}:trailing")))
                .absolute()
                .right_0()
                .bottom_0()
                .h(px(ROW_HEIGHT))
                .pr(px(TRAILING_INSET))
                .flex()
                .items_center()
                .justify_end()
                .opacity(r.trailing)
                .on_hover(move |hovered, window, _| {
                    with_motion(&trailing_key, |m| m.trailing_hovered = *hovered);
                    window.refresh();
                })
                .map(|this| {
                    let enabled = pinned || !settled;
                    if playing && session.now.duration.is_some() {
                        this.child(time_left(c, &key, &tab_id, &session, enabled))
                    } else {
                        this.child(play_button(c, &key, &tab_id, playing, false, enabled))
                    }
                }),
        );
    Some(
        div()
            .flex_none()
            .when(docked, |this| this.pt(px(SLOT_PAD)))
            .when(!docked, |this| this.pb(px(SLOT_PAD)))
            .child(body)
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn the_player_grows_by_the_seek_and_control_rows() {
        assert_eq!(EXPANDED_HEIGHT, 94.0);
        assert_eq!(GROWTH, 54.0);
        assert_eq!(SIDEBAR_PLAYER_HEIGHT, 48.0);
    }

    #[test]
    fn hovering_expands_at_once_and_leaving_waits_before_collapsing() {
        let t0 = Instant::now();
        let mut m = Motion::default();
        m.step(true, t0);
        assert!(m.expanded());
        assert_eq!(m.progress(t0), 0.0);
        let done = t0 + Duration::from_millis(221);
        m.step(true, done);
        assert_eq!(m.progress(done), 1.0);
        assert!(m.slot_expanded());
        m.step(false, done);
        assert!(m.expanded());
        let later = done + Duration::from_millis(159);
        m.step(false, later);
        assert!(m.expanded());
        let past = done + Duration::from_millis(161);
        m.step(false, past);
        assert!(!m.expanded());
        assert!(!m.slot_expanded());
        let closed = past + Duration::from_millis(181);
        assert_eq!(m.progress(closed), 0.0);
        assert!(!m.moving(closed));
    }

    #[test]
    fn coming_back_before_the_delay_keeps_it_open() {
        let t0 = Instant::now();
        let mut m = Motion::default();
        m.step(true, t0);
        m.step(true, t0 + Duration::from_millis(300));
        m.step(false, t0 + Duration::from_millis(310));
        m.step(true, t0 + Duration::from_millis(400));
        m.step(false, t0 + Duration::from_millis(500));
        assert!(m.expanded());
    }

    #[test]
    fn the_trailing_control_stays_while_pinned_and_fades_after() {
        let t0 = Instant::now();
        let mut m = Motion {
            trailing_hovered: true,
            ..Motion::default()
        };
        m.step(true, t0);
        assert!(m.pinned());
        assert_eq!(m.pin(t0), 1.0);
        assert_eq!(reveal(1.0, 1.0).trailing, 1.0);
        assert_eq!(reveal(1.0, 1.0).unpinned, 0.0);
        m.trailing_hovered = false;
        m.step(true, t0);
        assert!(!m.pinned());
        assert_eq!(m.pin(t0 + Duration::from_millis(151)), 0.0);
    }

    #[test]
    fn reveals_follow_the_old_interpolations() {
        let rest = reveal(0.0, 0.0);
        assert_eq!(rest.trailing, 1.0);
        assert_eq!(rest.title_drop, 7.0);
        assert_eq!(rest.controls_lift, -48.0);
        assert_eq!(rest.closing, 0.0);
        let open = reveal(1.0, 0.0);
        assert_eq!(open.trailing, 0.0);
        assert_eq!(open.seek, 1.0);
        assert_eq!(open.controls_lift, 0.0);
        assert!((reveal(0.85, 0.0).seek - 0.5).abs() < 1e-6);
    }
}
