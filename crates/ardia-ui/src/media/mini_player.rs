use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::TabId;
use ardia_state::tabs::Tab;
use ardia_theme::tokens::radius;
use gpui::{
    AnyElement, App, Bounds, FontWeight, Hsla, InteractiveElement, IntoElement, MouseButton,
    MouseMoveEvent, MouseUpEvent, ObjectFit, ParentElement, Pixels, StatefulInteractiveElement,
    Styled, StyledImage, Window, canvas, div, img, prelude::*, relative, rgba,
};

use crate::host::UiHost;
use crate::icon_picker::symbols::{SymbolWeight, symbol};
use crate::media::marquee::marquee;
use crate::media::session::{MediaAction, Session, format_time, transport_icons};
use crate::primitives::controls::tooltip;
use crate::primitives::favicon::render_favicon;
use crate::primitives::theme_bridge::hsla;
use crate::scale::px;
use crate::window::chrome::Chrome;

pub const WIDTH: f32 = 320.0;
pub const HEIGHT: f32 = 76.0;
const INSET: f32 = 10.0;
const ART: f32 = 56.0;
const TEXT_X: f32 = INSET + ART + 12.0;
const CONTROLS_WIDTH: f32 = 88.0;
const HOVER_SEGMENTS: f32 = 40.0;
const ART_FADE_MS: f32 = 150.0;
pub const TICK_MS: u64 = 500;
pub const ART_HOVER_SCRIM: u32 = 0x0000_0080;

#[derive(Clone, Copy, Debug)]
pub struct MediaTokens {
    pub label: Hsla,
    pub secondary: Hsla,
    pub track: Hsla,
    pub fill: Hsla,
    pub hover_fill: Hsla,
    pub art_placeholder: Hsla,
    pub background: Hsla,
}

pub fn media_tokens(c: &Chrome) -> MediaTokens {
    let shade = |a: f32| {
        if c.p.dark {
            Hsla::white().opacity(a)
        } else {
            Hsla::black().opacity(a)
        }
    };
    let dark = c.p.dark;
    MediaTokens {
        label: shade(0.85),
        secondary: shade(if dark { 0.55 } else { 0.5 }),
        track: shade(if dark { 0.2 } else { 0.1 }),
        fill: shade(if dark { 0.5 } else { 0.35 }),
        hover_fill: shade(if dark { 0.8 } else { 0.6 }),
        art_placeholder: shade(if dark { 0.08 } else { 0.06 }),
        background: hsla(c.look.theme.roles.panel),
    }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

thread_local! {
    static TICKS: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    static SEEKS: RefCell<HashMap<String, SeekState>> = RefCell::new(HashMap::new());
    static ART_SEEN: RefCell<HashMap<String, Instant>> = RefCell::new(HashMap::new());
}

pub fn ticker(key: String, every: u64) -> AnyElement {
    canvas(
        |_, _, _| {},
        move |_, _, window, cx| {
            let fresh = TICKS.with(|t| t.borrow_mut().insert(key.clone()));
            if !fresh {
                return;
            }
            let key = key.clone();
            window
                .spawn(cx, async move |cx| {
                    cx.background_executor()
                        .timer(Duration::from_millis(every))
                        .await;
                    TICKS.with(|t| t.borrow_mut().remove(&key));
                    let _ = cx.update(|window, _| window.refresh());
                })
                .detach();
        },
    )
    .absolute()
    .size_0()
    .into_any_element()
}

pub fn animating(on: bool) -> AnyElement {
    canvas(
        move |_, window, _| {
            if on {
                window.request_animation_frame();
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_0()
    .into_any_element()
}

#[derive(Clone, Copy, Debug, Default)]
struct SeekState {
    bounds: Bounds<Pixels>,
    hover: Option<f32>,
    drag: Option<f32>,
}

fn seek_state(key: &str) -> SeekState {
    SEEKS.with(|s| s.borrow().get(key).copied().unwrap_or_default())
}

fn update_seek(key: &str, change: impl FnOnce(&mut SeekState)) {
    SEEKS.with(|s| change(s.borrow_mut().entry(key.to_owned()).or_default()));
}

pub fn seek_dragging(key: &str) -> bool {
    seek_state(key).drag.is_some()
}

fn fraction_at(bounds: Bounds<Pixels>, x: Pixels) -> f32 {
    let width = f32::from(bounds.size.width).max(1.0);
    ((f32::from(x) - f32::from(bounds.origin.x)) / width).clamp(0.0, 1.0)
}

pub fn hover_segment(fraction: f32) -> f32 {
    ((fraction * HOVER_SEGMENTS)
        .floor()
        .min(HOVER_SEGMENTS - 1.0)
        + 0.5)
        / HOVER_SEGMENTS
}

fn seek_bar(
    host: &Arc<dyn UiHost>,
    key: String,
    tab: &TabId,
    session: &Session,
    tokens: MediaTokens,
    now: f64,
) -> AnyElement {
    let state = seek_state(&key);
    let duration = session.now.duration.unwrap_or(0.0);
    let progress = state.drag.unwrap_or(if duration > 0.0 {
        (session.now.position_at(now) / duration) as f32
    } else {
        0.0
    });
    let (height, bar) = (18.0, 6.0);
    let record = key.clone();
    let hover_key = key.clone();
    let leave_key = key.clone();
    let press_key = key.clone();
    let drag_key = key.clone();
    let commit_host = Arc::clone(host);
    let commit_tab = tab.clone();
    div()
        .id(gpui::SharedString::from(format!("seek:{key}")))
        .relative()
        .flex_1()
        .h(px(height))
        .child(
            canvas(
                move |bounds, _, _| update_seek(&record, |s| s.bounds = bounds),
                move |_, _, window, _| {
                    if seek_state(&drag_key).drag.is_none() {
                        return;
                    }
                    let move_key = drag_key.clone();
                    window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, _| {
                        if phase != gpui::DispatchPhase::Capture {
                            return;
                        }
                        let bounds = seek_state(&move_key).bounds;
                        update_seek(&move_key, |s| {
                            if s.drag.is_some() {
                                s.drag = Some(fraction_at(bounds, event.position.x));
                            }
                        });
                        window.refresh();
                    });
                    let up_key = drag_key.clone();
                    let host = Arc::clone(&commit_host);
                    let tab = commit_tab.clone();
                    window.on_mouse_event(move |event: &MouseUpEvent, phase, window, _| {
                        if phase != gpui::DispatchPhase::Capture {
                            return;
                        }
                        let state = seek_state(&up_key);
                        if state.drag.is_none() {
                            return;
                        }
                        let p = fraction_at(state.bounds, event.position.x);
                        update_seek(&up_key, |s| s.drag = None);
                        host.media_action(
                            tab.clone(),
                            MediaAction::SeekTo(f64::from(p) * duration),
                        );
                        window.refresh();
                    });
                },
            )
            .absolute()
            .size_full(),
        )
        .child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .top(px((height - bar) / 2.0))
                .h(px(bar))
                .rounded(px(bar / 2.0))
                .bg(tokens.track)
                .overflow_hidden()
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .top_0()
                        .bottom_0()
                        .w(relative(progress.clamp(0.0, 1.0)))
                        .rounded(px(bar / 2.0))
                        .bg(tokens.fill),
                )
                .when_some(
                    state.hover.filter(|_| state.drag.is_none()),
                    |this, hover| {
                        this.child(
                            div()
                                .absolute()
                                .left_0()
                                .top_0()
                                .bottom_0()
                                .w(relative(hover))
                                .rounded(px(bar / 2.0))
                                .bg(tokens.hover_fill),
                        )
                    },
                ),
        )
        .on_mouse_move(move |event: &MouseMoveEvent, window, _| {
            let state = seek_state(&hover_key);
            let hover = Some(hover_segment(fraction_at(state.bounds, event.position.x)));
            if state.hover != hover {
                update_seek(&hover_key, |s| s.hover = hover);
                window.refresh();
            }
        })
        .on_hover(move |hovered, window, _| {
            if !*hovered {
                update_seek(&leave_key, |s| s.hover = None);
                window.refresh();
            }
        })
        .on_mouse_down(MouseButton::Left, move |event, window, cx| {
            cx.stop_propagation();
            if duration <= 0.0 {
                return;
            }
            let bounds = seek_state(&press_key).bounds;
            update_seek(&press_key, |s| {
                s.drag = Some(fraction_at(bounds, event.position.x))
            });
            window.refresh();
        })
        .into_any_element()
}

pub fn tabular_label(text: String, size: f32, line_height: f32, color: Hsla) -> AnyElement {
    div()
        .flex_none()
        .text_size(px(size))
        .line_height(px(line_height))
        .text_color(color)
        .font_features(gpui::FontFeatures(Arc::new(vec![("tnum".into(), 1)])))
        .whitespace_nowrap()
        .child(text)
        .into_any_element()
}

pub fn time_bar(
    host: &Arc<dyn UiHost>,
    key: String,
    tab: &TabId,
    session: &Session,
    tokens: MediaTokens,
    total: bool,
) -> AnyElement {
    let now = now_ms();
    let drag = seek_state(&key).drag;
    let duration = session.now.duration;
    let shown = match (drag, duration) {
        (Some(p), Some(d)) => f64::from(p) * d,
        _ => session.now.position_at(now),
    };
    let tiny = |text: String| tabular_label(text, 10.0, 13.0, tokens.secondary);
    div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .child(tiny(format_time(shown)))
        .map(|this| match duration {
            Some(d) => this
                .child(seek_bar(host, key, tab, session, tokens, now))
                .child(tiny(if total {
                    format_time(d)
                } else {
                    format!("-{}", format_time(d - shown))
                })),
            None => this.child(div().flex_1()),
        })
        .into_any_element()
}

pub fn artwork(c: &Chrome, tab: &Tab, session: &Session) -> Option<Arc<gpui::Image>> {
    let url = session.now.artwork.as_deref()?;
    c.host.favicon_image(&tab.profile_id, url)
}

fn art_fade(url: &str) -> f32 {
    let started = ART_SEEN.with(|seen| {
        let mut seen = seen.borrow_mut();
        if seen.len() > 64 {
            seen.clear();
        }
        *seen.entry(url.to_owned()).or_insert_with(Instant::now)
    });
    crate::primitives::appear::timing_default(
        (started.elapsed().as_secs_f32() * 1000.0 / ART_FADE_MS).clamp(0.0, 1.0),
    )
}

pub fn muted(c: &Chrome, tab: &Tab) -> bool {
    ardia_state::mute::silenced(c.state, tab)
}

pub fn toggle_mute(host: &Arc<dyn UiHost>, tab: &Tab) {
    for action in ardia_state::mute::toggle(&host.store().snapshot(), &tab.id, false) {
        host.dispatch(action);
    }
}

pub fn mute_title(c: &Chrome, tab: &Tab) -> &'static str {
    ardia_state::mute::mute_title(ardia_state::mute::mute_state(c.state, tab))
}

#[allow(clippy::too_many_arguments)]
fn transport(
    c: &Chrome,
    id: String,
    left: f32,
    width: f32,
    name: &'static str,
    size: f32,
    tip: &'static str,
    tokens: MediaTokens,
    run: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let side = width.max(size + 4.0);
    div()
        .id(gpui::SharedString::from(id))
        .absolute()
        .left(px(left - (side - width) / 2.0))
        .top(px(9.0))
        .w(px(side))
        .h(px(38.0))
        .flex()
        .items_center()
        .justify_center()
        .opacity(0.6)
        .hover(|s| s.opacity(1.0))
        .active(|s| {
            s.opacity(0.82)
                .scale(crate::primitives::tokens::press_scale::ICON)
        })
        .tooltip(tooltip(tip.into(), c.p))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            run(window, cx);
        })
        .child(symbol(
            c.host.as_ref(),
            name,
            size,
            side,
            SymbolWeight::Regular,
            tokens.label,
        ))
        .into_any_element()
}

pub fn mini_player(
    c: &Chrome,
    tab: &Tab,
    on_back: impl Fn(&mut Window, &mut App) + 'static,
) -> Option<AnyElement> {
    let session = c.host.media_session(&tab.id)?;
    let tokens = media_tokens(c);
    let key = format!("mini:{}:{}", c.window.id, tab.id);
    let playing = session.now.is_playing();
    let text_width = WIDTH - TEXT_X - CONTROLS_WIDTH - 8.0 - INSET;
    let controls_x = WIDTH - INSET - CONTROLS_WIDTH;
    let tracks = session.now.has_track_controls();
    let icons = transport_icons(&session.now);
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
    let reset = format!("{}|{}", session.now.title, session.now.artist);
    let side_size = if tracks { 14.0 } else { 15.0 };
    let act = |action: MediaAction| {
        let host = Arc::clone(c.host);
        let id = tab.id.clone();
        move |_: &mut Window, _: &mut App| host.media_action(id.clone(), action)
    };
    Some(
        div()
            .debug_selector(|| "mini-player".into())
            .relative()
            .w(px(WIDTH))
            .h(px(HEIGHT))
            .when(playing, |this| this.child(ticker(key.clone(), TICK_MS)))
            .child(album_art(c, tab, &session, tokens, on_back))
            .child(
                div()
                    .absolute()
                    .left(px(TEXT_X))
                    .top(px(10.0))
                    .w(px(text_width))
                    .flex()
                    .child(
                        marquee(&key, &reset, -1, "title", title)
                            .size(13.0, 18.0)
                            .weight(FontWeight::SEMIBOLD)
                            .color(tokens.label),
                    ),
            )
            .child(
                div()
                    .absolute()
                    .left(px(TEXT_X))
                    .top(px(30.0))
                    .w(px(text_width))
                    .flex()
                    .child(
                        marquee(&key, &reset, -1, "artist", artist)
                            .size(11.0, 14.0)
                            .color(tokens.secondary),
                    ),
            )
            .child(transport(
                c,
                format!("{key}:back"),
                controls_x,
                16.0,
                icons.back,
                side_size,
                icons.back_tip,
                tokens,
                act(MediaAction::Back),
            ))
            .child(transport(
                c,
                format!("{key}:play"),
                controls_x + 32.0,
                24.0,
                if playing { "pause.fill" } else { "play.fill" },
                24.0,
                if playing { "Pause" } else { "Play" },
                tokens,
                act(MediaAction::Toggle),
            ))
            .child(transport(
                c,
                format!("{key}:ahead"),
                controls_x + 72.0,
                16.0,
                icons.ahead,
                side_size,
                icons.ahead_tip,
                tokens,
                act(MediaAction::Ahead),
            ))
            .child(
                div()
                    .absolute()
                    .left(px(TEXT_X))
                    .right(px(INSET))
                    .top(px(50.0))
                    .h(px(18.0))
                    .flex()
                    .child(time_bar(
                        c.host,
                        format!("{key}:seek"),
                        &tab.id,
                        &session,
                        tokens,
                        false,
                    )),
            )
            .into_any_element(),
    )
}

pub fn hover_player(c: &Chrome, tab: &Tab) -> Option<AnyElement> {
    let theme = &c.look.theme;
    let shadow_alpha = theme.roles.panel_shadow_opacity * 0.8;
    let emit = c.emit.clone();
    let window_key = c.window.id.as_str().to_owned();
    let id = tab.id.clone();
    let body = mini_player(c, tab, move |window, cx| {
        crate::sidebar::hover_card::dismiss(&window_key, window, cx);
        emit.send(
            crate::msg::Msg::Store(ardia_state::Action::ActivateTab { tab: id.clone() }),
            window,
            cx,
        );
    })?;
    Some(
        div()
            .w(px(WIDTH))
            .h(px(HEIGHT))
            .rounded(px(radius::PANEL))
            .bg(hsla(theme.roles.panel))
            .shadow(vec![crate::primitives::controls::shadow(
                Hsla::black().opacity(shadow_alpha),
                6.,
                32.,
            )])
            .relative()
            .child(body)
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(radius::PANEL))
                    .border(px(0.5))
                    .border_color(hsla(theme.roles.panel_border)),
            )
            .into_any_element(),
    )
}

fn album_art(
    c: &Chrome,
    tab: &Tab,
    session: &Session,
    tokens: MediaTokens,
    on_back: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let art = artwork(c, tab, session);
    let fade = session
        .now
        .artwork
        .as_deref()
        .filter(|_| art.is_some())
        .map(art_fade);
    let group = gpui::SharedString::from(format!("mini-art:{}", tab.id));
    let is_muted = muted(c, tab);
    let unmute_host = Arc::clone(c.host);
    let unmute_tab = tab.clone();
    div()
        .absolute()
        .left(px(INSET))
        .top(px(INSET))
        .size(px(ART))
        .child(
            div()
                .id(gpui::SharedString::from(format!(
                    "mini-art-button:{}",
                    tab.id
                )))
                .group(group.clone())
                .size(px(ART))
                .rounded(px(radius::TILE))
                .overflow_hidden()
                .bg(tokens.art_placeholder)
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .active(|s| s.scale(crate::primitives::tokens::press_scale::CONTROL))
                .tooltip(tooltip("Back to Tab".into(), c.p))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(move |_, window, cx| {
                    cx.stop_propagation();
                    on_back(window, cx);
                })
                .map(|this| match art {
                    Some(image) => this.child(animating(fade.is_some_and(|f| f < 1.0))).child(
                        img(image)
                            .absolute()
                            .left_0()
                            .top_0()
                            .size(px(ART))
                            .rounded(px(radius::TILE))
                            .object_fit(ObjectFit::Cover)
                            .opacity(fade.unwrap_or(1.0)),
                    ),
                    None => this.child(div().opacity(0.5).child(render_favicon(
                        &c.favicon(tab),
                        24.0,
                        c.p,
                    ))),
                })
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .top_0()
                        .size(px(ART))
                        .bg(rgba(ART_HOVER_SCRIM))
                        .flex()
                        .items_center()
                        .justify_center()
                        .opacity(0.0)
                        .group_hover(group, |s| s.opacity(1.0))
                        .child(symbol(
                            c.host.as_ref(),
                            "arrow.up.left",
                            16.0,
                            22.0,
                            SymbolWeight::Semibold,
                            gpui::white(),
                        )),
                ),
        )
        .when(is_muted, |this| {
            this.child(
                div()
                    .id(gpui::SharedString::from(format!("mini-unmute:{}", tab.id)))
                    .absolute()
                    .right(px(-5.0))
                    .bottom(px(-5.0))
                    .size(px(20.0))
                    .rounded_full()
                    .bg(tokens.background)
                    .flex()
                    .items_center()
                    .justify_center()
                    .active(|s| s.scale(crate::primitives::tokens::press_scale::ICON))
                    .tooltip(tooltip("Unmute Site".into(), c.p))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        toggle_mute(&unmute_host, &unmute_tab);
                    })
                    .child(symbol(
                        c.host.as_ref(),
                        "speaker.slash.fill",
                        10.0,
                        16.0,
                        SymbolWeight::Regular,
                        tokens.label,
                    )),
            )
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layout_matches_the_old_mini_player() {
        assert_eq!(TEXT_X, 78.0);
        assert_eq!(WIDTH - TEXT_X - CONTROLS_WIDTH - 8.0 - INSET, 136.0);
        assert_eq!(WIDTH - INSET - CONTROLS_WIDTH, 222.0);
    }

    #[test]
    fn hover_snaps_to_one_of_forty_segment_centers() {
        assert_eq!(hover_segment(0.0), 0.0125);
        assert_eq!(hover_segment(1.0), 0.9875);
        assert_eq!(hover_segment(0.5), 0.5125);
    }
}
