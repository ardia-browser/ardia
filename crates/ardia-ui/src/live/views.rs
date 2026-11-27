use std::time::Duration;

use ardia_state::live::LiveState;
use ardia_state::tabs::Tab;
use ardia_state::{Action, TabId, WindowId};
use chrono::{Local, TimeZone, Timelike};
use gpui::{
    Animation, AnimationExt, AnyElement, FontWeight, Hsla, IntoElement, ParentElement,
    SharedString, Styled, div, prelude::*, rgba,
};

use crate::host::UiHost;
use crate::icon_picker::symbols::{SymbolWeight, symbol};
use crate::look::Palette;
use crate::msg::{Emit, Msg};
use crate::scale::px;

use super::card::{AVATAR_SIZE, initials, live_colors};
use super::{
    CalendarCommand, CalendarEvent, CalendarView, Participant, attendees_label, badge_text,
    guests_label, is_calendar_url, is_meeting, join_link, join_title, meeting_countdown,
    related_links, related_links_tooltip, relative_time, tokens,
};

pub const PREVIEW_WIDTH: f32 = 300.0;
pub const JOINABLE_BEFORE_MS: i64 = 10 * 60_000;
pub const ALL_DAY_ROW: f32 = 22.0;
pub const EVENT_BAR: f32 = 3.0;
pub const BADGE_BOTTOM: f32 = -5.0;
pub const BADGE_SPRING_MS: u64 = 300;
pub const ALERT_APPEAR_MS: u64 = 300;

pub fn clock_time(ms: i64) -> String {
    match Local.timestamp_millis_opt(ms).single() {
        Some(t) => {
            let (pm, hour) = t.hour12();
            format!("{hour}:{:02} {}", t.minute(), if pm { "PM" } else { "AM" })
        }
        None => String::new(),
    }
}

pub fn time_range(event: &CalendarEvent) -> String {
    format!("{} – {}", clock_time(event.start), clock_time(event.end))
}

pub fn preview_date(now: i64) -> String {
    Local
        .timestamp_millis_opt(now)
        .single()
        .map(|t| t.format("%a, %b %-d").to_string())
        .unwrap_or_default()
}

fn day_bounds(now: i64) -> (i64, i64) {
    let Some(t) = Local.timestamp_millis_opt(now).single() else {
        return (now, now);
    };
    let midnight = t
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|d| Local.from_local_datetime(&d).single())
        .map_or(now, |d| d.timestamp_millis());
    (midnight, midnight + 86_400_000 - 1)
}

#[derive(Clone, Debug, PartialEq)]
pub enum PreviewBody {
    SignIn {
        blocked: bool,
    },
    Empty(&'static str),
    Events {
        all_day: Vec<CalendarEvent>,
        timed: Vec<CalendarEvent>,
    },
}

pub fn preview_body(view: &CalendarView, now: i64) -> PreviewBody {
    if !view.access.connected() {
        return PreviewBody::SignIn {
            blocked: view.access.blocked(),
        };
    }
    let (start, end) = day_bounds(now);
    let today: Vec<&CalendarEvent> = view
        .events
        .iter()
        .filter(|e| !e.cancelled && !e.declined && e.start <= end && e.end > start)
        .collect();
    if view.last_fetch.is_none() && view.loading {
        return PreviewBody::Empty("Loading events");
    }
    if view.error.is_some() && view.last_fetch.is_none() {
        return PreviewBody::Empty("Couldn't load events");
    }
    if today.is_empty() {
        return PreviewBody::Empty("No events today");
    }
    let upcoming: Vec<CalendarEvent> = today.into_iter().filter(|e| e.end > now).cloned().collect();
    if upcoming.is_empty() {
        return PreviewBody::Empty("No more events today");
    }
    let (all_day, timed) = upcoming.into_iter().partition(|e| e.all_day);
    PreviewBody::Events { all_day, timed }
}

fn hex_color(text: &str) -> Hsla {
    let digits = text.trim_start_matches('#');
    u32::from_str_radix(digits, 16)
        .ok()
        .filter(|_| digits.len() == 6)
        .map_or_else(
            || rgba(0x8E8E_93FF).into(),
            |v| rgba((v << 8) | 0xFF).into(),
        )
}

fn person(
    p: &Palette,
    who: &Participant,
    colors: &super::card::LiveColors,
    first: bool,
) -> AnyElement {
    let name = if who.name.is_empty() {
        &who.email
    } else {
        &who.name
    };
    div()
        .flex_none()
        .when(!first, |d| d.ml(px(-AVATAR_SIZE * 0.35)))
        .rounded_full()
        .border(px(1.5))
        .border_color(p.popover_fill)
        .child(
            div()
                .size(px(AVATAR_SIZE))
                .rounded_full()
                .bg(colors.avatar_fill)
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(AVATAR_SIZE * tokens::AVATAR_SCALE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text)
                .child(initials(name)),
        )
        .into_any_element()
}

pub fn overlapping_avatars(p: &Palette, people: &[&Participant]) -> AnyElement {
    let colors = live_colors(p);
    let shown = people.len().min(3);
    div()
        .flex()
        .items_center()
        .children(
            people
                .iter()
                .take(3)
                .enumerate()
                .map(|(i, who)| person(p, who, &colors, i == 0)),
        )
        .when(people.len() > shown, |d| {
            d.child(
                div()
                    .ml(px(4.))
                    .text_size(px(10.))
                    .text_color(p.text_secondary)
                    .child(format!("+{}", people.len() - shown)),
            )
        })
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn join_chip(
    host: &dyn UiHost,
    p: &Palette,
    emit: &Emit,
    id: SharedString,
    title: &str,
    icon: &str,
    primary: bool,
    msg: Msg,
    height: f32,
) -> AnyElement {
    let (fill, ink) = if primary {
        (p.text, p.on_go)
    } else {
        (p.url_pill, p.text)
    };
    div()
        .id(id)
        .h(px(height))
        .px(px(8.))
        .rounded(px(height / 2.))
        .bg(fill)
        .when(primary, |d| {
            d.hover(|s| s.opacity(0.85)).active(|s| s.opacity(0.85))
        })
        .when(!primary, move |d| {
            d.hover(move |s| s.bg(p.toolbar_hover))
                .active(move |s| s.bg(p.toolbar_pressed))
        })
        .flex()
        .items_center()
        .justify_center()
        .gap(px(4.))
        .on_click(emit.click(msg))
        .child(symbol(host, icon, 10.5, 14., SymbolWeight::Semibold, ink))
        .child(
            div()
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(ink)
                .child(title.to_owned()),
        )
        .into_any_element()
}

pub fn calendar_preview(
    host: &dyn UiHost,
    p: &Palette,
    emit: &Emit,
    window: &WindowId,
    tab: &TabId,
    view: &CalendarView,
    now: i64,
) -> AnyElement {
    let colors = live_colors(p);
    let connected = view.access.connected();
    let header = div()
        .flex()
        .items_center()
        .mb(px(8.))
        .mt(px(-2.))
        .child(
            div()
                .text_size(px(13.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text)
                .child("Today"),
        )
        .child(
            div()
                .ml(px(6.))
                .text_size(px(12.))
                .text_color(p.text_secondary)
                .child(preview_date(now)),
        )
        .child(div().flex_1())
        .when(connected, |d| {
            let refresh = div()
                .id("calendar-refresh")
                .size(px(22.))
                .mr(px(-6.))
                .my(px(-4.))
                .rounded(px(4.))
                .flex()
                .items_center()
                .justify_center()
                .hover(move |s| s.bg(p.toolbar_hover))
                .active(move |s| s.bg(p.toolbar_pressed))
                .tooltip(crate::primitives::controls::tooltip("Refresh".into(), p))
                .on_click(emit.click(Msg::Calendar(CalendarCommand::Refresh)))
                .child(symbol(
                    host,
                    "arrow.clockwise",
                    10.,
                    14.,
                    SymbolWeight::Semibold,
                    p.icon,
                ));
            d.child(if view.loading {
                refresh
                    .with_animation(
                        "calendar-refresh-spin",
                        Animation::new(Duration::from_millis(
                            ardia_theme::motion::SPINNER_PERIOD_MS,
                        ))
                        .repeat(),
                        |d, t| d.opacity(0.6 + 0.4 * (1.0 - t)),
                    )
                    .into_any_element()
            } else {
                refresh.into_any_element()
            })
        });
    let note = |text: String| {
        div()
            .text_size(px(12.))
            .line_height(px(16.))
            .text_color(p.text_secondary)
            .child(text)
    };
    let settings_link = || {
        div()
            .id("calendar-open-settings")
            .text_size(px(12.))
            .text_color(p.accent)
            .cursor_pointer()
            .on_click(emit.click(Msg::Calendar(CalendarCommand::OpenPrivacySettings)))
            .child("Open System Settings")
    };
    let body: AnyElement = match preview_body(view, now) {
        PreviewBody::SignIn { blocked: true } => div()
            .py(px(4.))
            .child(note(view.request_error.clone().unwrap_or_else(|| "Allow Ardia in System Settings › Privacy & Security › Calendars to see your meetings here.".into())))
            .child(settings_link())
            .into_any_element(),
        PreviewBody::SignIn { blocked: false } => div()
            .py(px(4.))
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(p.text_secondary)
                    .child(
                        div()
                            .id("calendar-connect")
                            .text_color(p.accent)
                            .cursor_pointer()
                            .when(!view.requesting, |d| d.hover(|s| s.underline()).on_click(emit.click(Msg::Calendar(CalendarCommand::Connect))))
                            .child(if view.requesting { "Connecting…" } else { "Connect your calendar" }),
                    )
                    .child(" to see your meetings here and get alerts before they start."),
            )
            .when_some(view.request_error.clone(), |d, failure| d.child(note(failure)).child(settings_link()))
            .into_any_element(),
        PreviewBody::Empty(text) => div().py(px(6.)).text_size(px(12.)).text_color(p.text_secondary).child(text).into_any_element(),
        PreviewBody::Events { all_day, timed } => div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .children(all_day.iter().map(|e| {
                div()
                    .h(px(ALL_DAY_ROW))
                    .px(px(4.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(div().size(px(7.)).rounded(px(2.)).bg(hex_color(&e.color)))
                    .child(div().flex_1().min_w_0().truncate().text_size(px(12.)).text_color(p.text_secondary).child(super::alert_title(e).to_owned()))
                    .child(div().text_size(px(11.)).text_color(p.text_tertiary).child("All day"))
            }))
            .children(timed.iter().map(|e| {
                let link = join_link(e);
                let running = e.start <= now;
                let joinable = link.is_some() && is_meeting(e) && now >= e.start - JOINABLE_BEFORE_MS && now < e.end;
                let others: Vec<&Participant> = e.attendees.iter().filter(|a| !a.me).collect();
                div()
                    .id(SharedString::from(format!("calendar-event:{}", e.occurrence)))
                    .py(px(6.))
                    .px(px(4.))
                    .rounded(px(8.))
                    .hover(move |s| s.bg(p.row_hover))
                    .when(e.end <= now, |d| d.opacity(0.5))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .on_click(emit.click(Msg::Store(Action::ActivateTab { tab: tab.clone() })))
                    .child(div().w(px(EVENT_BAR)).self_stretch().rounded(px(EVENT_BAR / 2.)).bg(hex_color(&e.color)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(div().truncate().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(p.text).child(super::alert_title(e).to_owned()))
                            .child(
                                div()
                                    .truncate()
                                    .flex()
                                    .text_size(px(11.))
                                    .text_color(p.text_secondary)
                                    .child(time_range(e))
                                    .child(
                                        div()
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(if running { colors.now } else { p.text_secondary })
                                            .child(format!(" · {}", if running { "Now".to_owned() } else { relative_time(e.start, now) })),
                                    ),
                            ),
                    )
                    .when(!others.is_empty() && !joinable, |d| d.child(overlapping_avatars(p, &others)))
                    .when_some(link.filter(|_| joinable), |d, (_, provider)| {
                        d.child(
                            div()
                                .id(SharedString::from(format!("calendar-join-tip:{}", e.occurrence)))
                                .tooltip(crate::primitives::controls::tooltip(join_title(Some(provider)).into(), p))
                                .child(join_chip(
                                    host,
                                    p,
                                    emit,
                                    SharedString::from(format!("calendar-join:{}", e.occurrence)),
                                    "Join",
                                    "video.fill",
                                    true,
                                    Msg::Calendar(CalendarCommand::Join {
                                        occurrence: e.occurrence.clone(),
                                        open_all: false,
                                        window: Some(window.clone()),
                                    }),
                                    24.,
                                )),
                        )
                    })
            }))
            .into_any_element(),
    };
    div()
        .w(px(PREVIEW_WIDTH))
        .flex()
        .flex_col()
        .child(header)
        .child(body)
        .into_any_element()
}

pub fn calendar_tab(tab: &Tab) -> bool {
    tab.pin.is_some() && is_calendar_url(tab.pinned_url.as_deref().unwrap_or(&tab.url))
}

pub fn next_meeting_text(
    view: &CalendarView,
    live: &LiveState,
    tab: &Tab,
    now: i64,
) -> Option<String> {
    if !calendar_tab(tab) || !live.calendar.show_time_to_next {
        return None;
    }
    let dismissed: super::DismissedNow = live
        .dismissed_now
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    badge_text(&view.events, now, live.calendar.countdown_lead, &dismissed)
}

pub fn next_meeting_badge(p: &Palette, text: &str, key: &str) -> AnyElement {
    let colors = live_colors(p);
    let now_badge = text == "Now";
    let (fill, ink) = if now_badge {
        (colors.now, gpui::white())
    } else {
        (p.badge_fill, p.on_go)
    };
    div()
        .absolute()
        .bottom(px(BADGE_BOTTOM))
        .left_0()
        .right_0()
        .flex()
        .justify_center()
        .child(
            div()
                .h(px(14.))
                .px(px(4.))
                .rounded(px(7.))
                .bg(fill)
                .border(px(1.))
                .border_color(colors.badge_ring)
                .flex()
                .items_center()
                .text_size(px(9.))
                .font_weight(FontWeight::BOLD)
                .text_color(ink)
                .child(text.to_owned()),
        )
        .with_animation(
            SharedString::from(format!("meeting-badge:{key}:{text}")),
            Animation::new(Duration::from_millis(BADGE_SPRING_MS))
                .with_easing(|t| ardia_theme::motion::ease_out_cubic(f64::from(t)) as f32),
            |d, t| d.opacity(t),
        )
        .into_any_element()
}

pub fn meeting_time_label(
    p: &Palette,
    live: &LiveState,
    group: &str,
    now: i64,
) -> Option<AnyElement> {
    let meeting = live.meeting_groups.get(group)?;
    let end = meeting.end.filter(|_| meeting.ended_at.is_none());
    let countdown = meeting_countdown(end, now);
    let label = countdown.label?;
    let colors = live_colors(p);
    Some(
        div()
            .mr(px(4.))
            .text_size(px(11.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(if countdown.urgent {
                colors.now
            } else {
                p.text_secondary
            })
            .child(label)
            .into_any_element(),
    )
}

pub fn alert_position(window_width: f32, sidebar_right: Option<f32>) -> (f32, f32) {
    let left = (window_width - sidebar_right.unwrap_or(0.0) - tokens::ALERT_WIDTH - 14.0)
        .max(tokens::ALERT_EDGE);
    (left, 52.0)
}

#[allow(clippy::too_many_arguments)]
pub fn meeting_alert(
    host: &dyn UiHost,
    p: &Palette,
    emit: &Emit,
    window: &WindowId,
    view: &CalendarView,
    calendar_tab: Option<TabId>,
    origin: (f32, f32),
    now: i64,
) -> Option<AnyElement> {
    let event = view.alert.clone()?;
    let colors = live_colors(p);
    let running = event.start <= now;
    let calendar_name = view
        .calendars
        .iter()
        .find(|c| c.id == event.calendar_id)
        .map(|c| c.title.clone());
    let people: Vec<&Participant> = event.attendees.iter().filter(|a| !a.me).collect();
    let who = attendees_label(&event);
    let link = join_link(&event);
    let related = related_links(&event);
    let join = |open_all: bool| {
        Msg::Calendar(CalendarCommand::Join {
            occurrence: event.occurrence.clone(),
            open_all,
            window: Some(window.clone()),
        })
    };
    let dismiss = Msg::Calendar(CalendarCommand::Dismiss {
        occurrence: event.occurrence.clone(),
    });
    let actions = div()
        .mt(px(2.))
        .flex()
        .flex_col()
        .gap(px(6.))
        .map(|d| match (&link, &calendar_tab) {
            (Some((_, provider)), _) => d.child(join_chip(
                host,
                p,
                emit,
                "meeting-alert-join".into(),
                join_title(Some(*provider)),
                "video.fill",
                true,
                join(false),
                30.,
            )),
            (None, Some(tab)) => d.child(
                div()
                    .id("meeting-alert-view")
                    .on_click(emit.click(Msg::Store(Action::ActivateTab { tab: tab.clone() })))
                    .child(join_chip(
                        host,
                        p,
                        emit,
                        "meeting-alert-view-chip".into(),
                        "View Event",
                        "calendar",
                        false,
                        dismiss.clone(),
                        30.,
                    )),
            ),
            _ => d,
        })
        .when(link.is_some() && !related.is_empty(), |d| {
            d.child(
                div()
                    .id("meeting-alert-open-all-tip")
                    .tooltip(crate::primitives::controls::tooltip(
                        related_links_tooltip(related.len()).into(),
                        p,
                    ))
                    .child(join_chip(
                        host,
                        p,
                        emit,
                        "meeting-alert-open-all".into(),
                        "Open All and Join",
                        "square.stack",
                        false,
                        join(true),
                        30.,
                    )),
            )
        });
    Some(
        div()
            .id("meeting-alert")
            .debug_selector(|| "meeting-alert".into())
            .absolute()
            .left(px(origin.0))
            .top(px(origin.1))
            .w(px(tokens::ALERT_WIDTH))
            .p(px(12.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .rounded(px(16.))
            .bg(p.popover_fill)
            .border(px(0.5))
            .border_color(p.popover_border)
            .shadow(crate::primitives::controls::panel_shadows(p))
            .occlude()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .size(px(tokens::CALENDAR_DOT))
                            .rounded(px(2.))
                            .bg(hex_color(&event.color)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .flex()
                            .text_size(px(11.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(if running {
                                colors.now
                            } else {
                                p.text_secondary
                            })
                            .child(if running {
                                "Now".to_owned()
                            } else {
                                relative_time(event.start, now)
                            })
                            .when_some(calendar_name, |d, name| {
                                d.child(
                                    div()
                                        .font_weight(FontWeight::NORMAL)
                                        .text_color(p.text_secondary)
                                        .child(format!(" · {name}")),
                                )
                            }),
                    )
                    .child(
                        div()
                            .id("meeting-alert-ignore")
                            .size(px(20.))
                            .mr(px(-4.))
                            .mt(px(-2.))
                            .rounded(px(4.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .hover(move |s| s.bg(p.toolbar_hover))
                            .tooltip(crate::primitives::controls::tooltip("Ignore".into(), p))
                            .on_click(emit.click(dismiss))
                            .child(symbol(
                                host,
                                "xmark",
                                9.,
                                14.,
                                SymbolWeight::Semibold,
                                p.icon,
                            )),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .text_size(px(15.))
                            .line_height(px(20.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(p.text)
                            .line_clamp(2)
                            .child(super::alert_title(&event).to_owned()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(p.text_secondary)
                            .child(time_range(&event)),
                    ),
            )
            .when(!people.is_empty(), |d| {
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(overlapping_avatars(p, &people))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.))
                                .text_color(p.text_secondary)
                                .child(if who.is_empty() {
                                    guests_label(&event)
                                } else {
                                    who.clone()
                                }),
                        ),
                )
            })
            .child(actions)
            .with_animation(
                SharedString::from(format!("meeting-alert:{}", event.occurrence)),
                Animation::new(Duration::from_millis(ALERT_APPEAR_MS))
                    .with_easing(|t| ardia_theme::motion::ease_out_cubic(f64::from(t)) as f32),
                move |d, t| d.opacity(t).top(px(origin.1 - 10.0 * (1.0 - t))),
            )
            .into_any_element(),
    )
}

thread_local! {
    static CALENDAR_ANCHORS: std::cell::RefCell<std::collections::HashMap<String, (f32, f32, f32, f32)>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

pub fn calendar_anchor(window: &str) -> Option<(f32, f32, f32, f32)> {
    CALENDAR_ANCHORS.with(|a| a.borrow().get(window).copied())
}

pub fn alert_origin(
    anchor: Option<(f32, f32, f32, f32)>,
    sidebar_right: bool,
    window_width: f32,
    right_sidebar_width: Option<f32>,
) -> (f32, f32) {
    match anchor {
        Some((x, y, w, _)) => {
            let left = if sidebar_right {
                x - tokens::ALERT_EDGE - tokens::ALERT_WIDTH
            } else {
                x + w + tokens::ALERT_EDGE
            };
            (left, (y - 4.0).max(tokens::ALERT_EDGE))
        }
        None => alert_position(window_width, right_sidebar_width),
    }
}

pub fn tile_badge(c: &crate::window::chrome::Chrome, tab: &Tab) -> Option<AnyElement> {
    if !calendar_tab(tab) {
        return None;
    }
    let key = c.window.id.as_str().to_owned();
    let probe = gpui::canvas(
        move |bounds, _, _| {
            let rect = (
                crate::scale::points(bounds.origin.x),
                crate::scale::points(bounds.origin.y),
                crate::scale::points(bounds.size.width),
                crate::scale::points(bounds.size.height),
            );
            CALENDAR_ANCHORS.with(|a| a.borrow_mut().insert(key.clone(), rect));
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_full();
    let now = chrono::Utc::now().timestamp_millis();
    let badge = c
        .host
        .calendar()
        .zip(c.host.live())
        .and_then(|(view, live)| next_meeting_text(&view, &live, tab, now))
        .map(|text| next_meeting_badge(c.p, &text, tab.id.as_str()));
    Some(
        div()
            .absolute()
            .inset_0()
            .child(probe)
            .children(badge)
            .into_any_element(),
    )
}

pub fn calendar_card(c: &crate::window::chrome::Chrome, tab: &Tab) -> Option<AnyElement> {
    let live = c.host.live()?;
    if !calendar_tab(tab) || !live.calendar.show_preview {
        return None;
    }
    let view = c.host.calendar()?;
    let theme = &c.look.theme;
    let now = chrono::Utc::now().timestamp_millis();
    Some(
        div()
            .p(px(12.))
            .rounded(px(12.))
            .bg(crate::primitives::theme_bridge::hsla(theme.roles.panel))
            .border(px(0.5))
            .border_color(crate::primitives::theme_bridge::hsla(
                theme.roles.panel_border,
            ))
            .shadow(crate::primitives::controls::panel_shadows(c.p))
            .child(calendar_preview(
                c.host.as_ref(),
                c.p,
                c.emit,
                &c.window.id,
                &tab.id,
                &view,
                now,
            ))
            .into_any_element(),
    )
}

pub fn window_alert(
    c: &crate::window::chrome::Chrome,
    window_width: f32,
    front: bool,
) -> Option<AnyElement> {
    if !front {
        return None;
    }
    let view = c.host.calendar()?;
    view.alert.as_ref()?;
    let now = chrono::Utc::now().timestamp_millis();
    let calendar_tab = c
        .state
        .view_tabs(c.window.id.as_str(), None)
        .into_iter()
        .find(|t| calendar_tab(t))
        .map(|t| t.id.clone());
    let on_right = c.state.settings.sidebar_side == ardia_state::model::SidebarSide::Right;
    let right = (on_right && c.layout.sidebar.is_some()).then_some(c.layout.sidebar_width);
    let anchor = c
        .layout
        .sidebar
        .and(calendar_tab.as_ref())
        .and_then(|_| calendar_anchor(c.window.id.as_str()));
    meeting_alert(
        c.host.as_ref(),
        c.p,
        c.emit,
        &c.window.id,
        &view,
        calendar_tab,
        alert_origin(anchor, on_right, window_width, right),
        now,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::CalendarAccess;

    fn event(start: i64, end: i64) -> CalendarEvent {
        CalendarEvent {
            occurrence: format!("e@{start}"),
            start,
            end,
            ..CalendarEvent::default()
        }
    }

    #[test]
    fn preview_body_states() {
        let mut view = CalendarView::default();
        assert_eq!(
            preview_body(&view, 0),
            PreviewBody::SignIn { blocked: false }
        );
        view.access = CalendarAccess::Denied;
        assert_eq!(
            preview_body(&view, 0),
            PreviewBody::SignIn { blocked: true }
        );
        view.access = CalendarAccess::Fixture;
        view.loading = true;
        assert_eq!(preview_body(&view, 0), PreviewBody::Empty("Loading events"));
        let now = Local::now().timestamp_millis();
        view.loading = false;
        view.last_fetch = Some(now);
        assert_eq!(
            preview_body(&view, now),
            PreviewBody::Empty("No events today")
        );
        view.events = vec![event(now - 120_000, now - 60_000)];
        assert_eq!(
            preview_body(&view, now),
            PreviewBody::Empty("No more events today")
        );
        let mut all_day = event(now, now + 60_000);
        all_day.all_day = true;
        view.events = vec![all_day, event(now, now + 60_000)];
        assert!(
            matches!(preview_body(&view, now), PreviewBody::Events { all_day, timed } if all_day.len() == 1 && timed.len() == 1)
        );
    }

    #[test]
    fn clock_and_positions() {
        assert!(clock_time(0).ends_with("M"));
        assert_eq!(alert_position(1000.0, None), (1000.0 - 300.0 - 14.0, 52.0));
        assert_eq!(alert_position(200.0, Some(100.0)).0, 8.0);
        assert_eq!(
            alert_origin(Some((10.0, 100.0, 40.0, 40.0)), false, 1000.0, None),
            (58.0, 96.0)
        );
        assert_eq!(
            alert_origin(Some((700.0, 2.0, 40.0, 40.0)), true, 1000.0, None),
            (392.0, 8.0)
        );
        assert_eq!(hex_color("#1A73E8"), Hsla::from(rgba(0x1A73_E8FF)));
    }
}
