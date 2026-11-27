pub mod card;
pub mod feed;
pub mod menus;
pub mod views;

use std::collections::{BTreeSet, HashMap};

pub mod tokens {
    pub const PENDING_DARK: u32 = 0xD299_22FF;
    pub const MERGED_DARK: u32 = 0xA371_F7FF;
    pub const DRAFT_DARK: u32 = 0x8B94_9EFF;
    pub const CONFLICT_DARK: u32 = 0xDB6D_28FF;
    pub const CI_TRACK_DARK: u32 = 0xFFFF_FF1A;
    pub const CHIP_DARK: u32 = 0xFFFF_FF1A;
    pub const BADGE_RING_DARK: u32 = 0x0000_0059;
    pub const AVATAR_FILL_DARK: u32 = 0x4A4A_4FFF;
    pub const PENDING_LIGHT: u32 = 0x9A67_00FF;
    pub const MERGED_LIGHT: u32 = 0x8250_DFFF;
    pub const DRAFT_LIGHT: u32 = 0x6E77_81FF;
    pub const CONFLICT_LIGHT: u32 = 0xBC4C_00FF;
    pub const CI_TRACK_LIGHT: u32 = 0x0000_0014;
    pub const CHIP_LIGHT: u32 = 0x0000_000F;
    pub const BADGE_RING_LIGHT: u32 = 0xFFFF_FFCC;
    pub const AVATAR_FILL_LIGHT: u32 = 0xD5D5_DAFF;
    pub const AVATAR_SCALE: f32 = 0.42;
    pub const WIGGLE_STEP_MS: u64 = 100;
    pub const WIGGLE: [f32; 6] = [1.0, -1.0, 0.8, -0.6, 0.3, 0.0];
    pub const WIGGLE_DEGREES: f32 = 4.0;
    pub const ALERT_WIDTH: f32 = 300.0;
    pub const ALERT_EDGE: f32 = 8.0;
    pub const CALENDAR_DOT: f32 = 8.0;
}

pub const MINUTE: i64 = 60_000;
pub const COUNTDOWN_LEADS: [i64; 5] = [5, 10, 15, 30, 60];
pub const DEFAULT_COUNTDOWN_LEAD: i64 = 60;
pub const WIGGLE_MARKS_MIN: [i64; 2] = [5, 2];
pub const COUNTDOWN_SHOW_WITHIN_MIN: f64 = 10.0;
pub const COUNTDOWN_URGENT_MIN: f64 = 2.0;
const MAX_DISMISSED_NOW: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeetingProvider {
    Meet,
    Zoom,
    Teams,
    Webex,
    Other,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Participant {
    pub name: String,
    pub email: String,
    pub status: String,
    pub me: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SystemCalendar {
    pub id: String,
    pub title: String,
    pub color: String,
    pub account: String,
    pub account_type: String,
    pub owned: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CalendarAccess {
    #[default]
    NotDetermined,
    Restricted,
    Denied,
    FullAccess,
    WriteOnly,
    Fixture,
}

impl CalendarAccess {
    pub fn blocked(self) -> bool {
        matches!(
            self,
            CalendarAccess::Denied | CalendarAccess::Restricted | CalendarAccess::WriteOnly
        )
    }

    pub fn connected(self) -> bool {
        matches!(self, CalendarAccess::FullAccess | CalendarAccess::Fixture)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CalendarView {
    pub access: CalendarAccess,
    pub calendars: Vec<SystemCalendar>,
    pub events: Vec<CalendarEvent>,
    pub loading: bool,
    pub error: Option<String>,
    pub last_fetch: Option<i64>,
    pub requesting: bool,
    pub request_error: Option<String>,
    pub alert: Option<CalendarEvent>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CalendarCommand {
    Connect,
    Refresh,
    SetHidden {
        calendar: String,
        hidden: bool,
    },
    Join {
        occurrence: String,
        open_all: bool,
        window: Option<ardia_state::WindowId>,
    },
    Dismiss {
        occurrence: String,
    },
    OpenPrivacySettings,
}

pub const CALENDARS_PRIVACY: &str = "System Settings › Privacy & Security › Calendars";

pub fn request_failure(
    access: CalendarAccess,
    request_error: Option<&str>,
    responsible_other: bool,
) -> Option<String> {
    let hint = if responsible_other {
        " macOS may have checked the app that opened Ardia instead of Ardia: quit Ardia, open it from the Dock or Finder, then connect again."
    } else {
        ""
    };
    match access {
        CalendarAccess::FullAccess | CalendarAccess::Fixture => None,
        CalendarAccess::Restricted => Some(format!(
            "Calendar access is restricted on this Mac, by Screen Time or your organization. If you can change it, allow Ardia in {CALENDARS_PRIVACY}."
        )),
        CalendarAccess::WriteOnly => Some(format!(
            "Ardia can only add events to your calendars. Choose Full Access for Ardia in {CALENDARS_PRIVACY}."
        )),
        CalendarAccess::Denied => Some(format!(
            "Ardia isn't allowed to read your calendars. Turn on Ardia in {CALENDARS_PRIVACY}."
        )),
        CalendarAccess::NotDetermined => Some(match request_error {
            Some(error) => format!(
                "macOS couldn't give Ardia calendar access ({error}). Check {CALENDARS_PRIVACY}.{hint}"
            ),
            None if responsible_other => {
                format!("macOS didn't ask Ardia for calendar access.{hint}")
            }
            None => {
                format!("macOS didn't ask for calendar access. Allow Ardia in {CALENDARS_PRIVACY}.")
            }
        }),
    }
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CalendarEvent {
    pub id: String,
    pub occurrence: String,
    pub calendar_id: String,
    pub title: String,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    pub cancelled: bool,
    pub declined: bool,
    pub url: Option<String>,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub color: String,
    pub organizer: Option<Participant>,
    pub attendees: Vec<Participant>,
}

fn split_url(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.rsplit('@').next().unwrap_or_default();
    let host = host
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let tail = &rest[end..];
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let path = if tail[..path_end].is_empty() {
        "/".to_owned()
    } else {
        tail[..path_end].to_owned()
    };
    Some((host, path))
}

fn host(url: &str) -> String {
    split_url(url).map(|(h, _)| h).unwrap_or_default()
}

fn is_teams(h: &str) -> bool {
    matches!(
        h,
        "teams.microsoft.com" | "teams.cloud.microsoft" | "teams.live.com"
    )
}

pub fn is_calendar_url(url: &str) -> bool {
    let Some((h, p)) = split_url(url) else {
        return false;
    };
    match h.as_str() {
        "calendar.google.com"
        | "calendar.notion.so"
        | "calendar.proton.me"
        | "app.fantastical.com" => true,
        "outlook.live.com"
        | "outlook.office.com"
        | "outlook.office365.com"
        | "outlook.cloud.microsoft" => p.starts_with("/calendar"),
        "www.icloud.com" | "icloud.com" => p.starts_with("/calendar"),
        h if is_teams(h) => meeting_of(url).is_none(),
        _ => false,
    }
}

fn meet_code(segment: &str) -> Option<String> {
    let parts: Vec<&str> = segment.split('-').collect();
    let fits = parts.len() == 3
        && parts
            .iter()
            .all(|p| (3..=4).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphabetic()));
    fits.then(|| segment.to_ascii_lowercase())
}

fn word_id(segment: &str) -> Option<&str> {
    let end = segment
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'))
        .unwrap_or(segment.len());
    (end > 0).then(|| &segment[..end])
}

pub fn meeting_of(url: &str) -> Option<(MeetingProvider, String)> {
    let (h, p) = split_url(url)?;
    let segments: Vec<&str> = p.trim_start_matches('/').split('/').collect();
    if h == "meet.google.com" {
        let first = segments.first()?;
        let code = first
            .split(|c: char| !(c.is_ascii_alphabetic() || c == '-'))
            .next()?;
        return meet_code(code).map(|code| (MeetingProvider::Meet, format!("meet:{code}")));
    }
    if h == "zoom.us" || h.ends_with(".zoom.us") || h == "zoom.com" || h.ends_with(".zoom.com") {
        let id = match segments.as_slice() {
            ["wc", "join", id, ..] => word_id(id),
            ["wc", number, "join", ..]
                if number.chars().all(|c| c.is_ascii_digit()) && !number.is_empty() =>
            {
                Some(*number)
            }
            [kind, id, ..] if matches!(*kind, "j" | "s" | "w" | "wc" | "my") => word_id(id),
            _ => None,
        }?;
        return Some((
            MeetingProvider::Zoom,
            format!("zoom:{}", id.to_ascii_lowercase()),
        ));
    }
    if is_teams(&h) {
        let joins = p.starts_with("/l/meetup-join/")
            || p.starts_with("/meet/")
            || (p.starts_with("/v2/") && url.contains("meetup-join"));
        if joins {
            let key: String = percent_decoded(&p).chars().take(160).collect();
            return Some((MeetingProvider::Teams, format!("teams:{key}")));
        }
        return None;
    }
    if h.ends_with(".webex.com") {
        let first = segments.first().copied().unwrap_or_default();
        let ok = first.starts_with("meet")
            || first.starts_with("join")
            || segments.get(1).is_some_and(|s| s.starts_with("j.php"));
        if ok {
            return Some((MeetingProvider::Webex, format!("webex:{h}{p}")));
        }
    }
    None
}

fn percent_decoded(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&text[i + 1..i + 3], 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn links(text: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("http") {
        let tail = &rest[at..];
        let after = tail
            .strip_prefix("https://")
            .or_else(|| tail.strip_prefix("http://"));
        let Some(after) = after else {
            rest = &tail[4..];
            continue;
        };
        let scheme_len = tail.len() - after.len();
        let body_len = after
            .find(|c: char| c.is_whitespace() || "<>\"'`)]".contains(c))
            .unwrap_or(after.len());
        if body_len > 0 {
            let url = tail[..scheme_len + body_len].trim_end_matches(['.', ',', ';', ':']);
            if !found.iter().any(|known| known == url) {
                found.push(url.to_owned());
            }
        }
        rest = &tail[scheme_len + body_len..];
    }
    found
}

fn event_texts(event: &CalendarEvent) -> [&str; 3] {
    [
        event.url.as_deref().unwrap_or_default(),
        event.location.as_deref().unwrap_or_default(),
        event.notes.as_deref().unwrap_or_default(),
    ]
}

pub fn join_link(event: &CalendarEvent) -> Option<(String, MeetingProvider)> {
    event_texts(event).into_iter().find_map(|text| {
        links(text)
            .into_iter()
            .find_map(|url| meeting_of(&url).map(|(provider, _)| (url, provider)))
    })
}

fn noisy(h: &str) -> bool {
    let under = |domain: &str| h == domain || h.ends_with(&format!(".{domain}"));
    under("support.google.com")
        || under("accounts.google.com")
        || h.starts_with("tel.")
        || under("aka.ms")
        || under("go.microsoft.com")
        || under("microsoft.com")
        || under("zoom.us")
        || under("zoom.com")
        || under("apple.com")
        || h == "calendar.google.com"
        || h == "meet.google.com"
}

pub fn related_links(event: &CalendarEvent) -> Vec<String> {
    let join = join_link(event).map(|(url, _)| url);
    let [url, location, notes] = event_texts(event);
    links(&format!("{url} {location} {notes}"))
        .into_iter()
        .filter(|u| Some(u) != join.as_ref() && meeting_of(u).is_none())
        .filter(|u| {
            let h = host(u);
            !h.is_empty() && !noisy(&h)
        })
        .collect()
}

pub fn event_for_call(events: &[CalendarEvent], url: &str, now: i64) -> Option<CalendarEvent> {
    let (_, key) = meeting_of(url)?;
    events
        .iter()
        .filter(|e| is_meeting(e))
        .filter(|e| {
            join_link(e)
                .and_then(|(link, _)| meeting_of(&link))
                .is_some_and(|(_, k)| k == key)
        })
        .min_by_key(|e| (e.start - now).abs())
        .cloned()
}

pub fn is_meeting(event: &CalendarEvent) -> bool {
    !event.all_day && !event.cancelled && !event.declined
}

pub type DismissedNow = HashMap<String, i64>;

fn current_or_next<'a>(
    events: &'a [CalendarEvent],
    now: i64,
    dismissed: &DismissedNow,
) -> Option<&'a CalendarEvent> {
    let meetings: Vec<&CalendarEvent> = events
        .iter()
        .filter(|e| is_meeting(e) && e.end > now && !dismissed.contains_key(&e.occurrence))
        .collect();
    let current =
        meetings
            .iter()
            .filter(|e| e.start <= now)
            .fold(None::<&&CalendarEvent>, |best, e| match best {
                Some(b) if b.start >= e.start => Some(b),
                _ => Some(e),
            });
    current
        .or_else(|| {
            meetings
                .iter()
                .fold(None::<&&CalendarEvent>, |best, e| match best {
                    Some(b) if b.start <= e.start => Some(b),
                    _ => Some(e),
                })
        })
        .copied()
}

pub fn badge_text(
    events: &[CalendarEvent],
    now: i64,
    lead_minutes: i64,
    dismissed: &DismissedNow,
) -> Option<String> {
    let event = current_or_next(events, now, dismissed)?;
    if event.start <= now {
        return Some("Now".to_owned());
    }
    let ms = event.start - now;
    if ms > lead_minutes * MINUTE {
        return None;
    }
    let min = (ms + MINUTE - 1) / MINUTE;
    Some(if min >= 60 {
        format!("{}h", min / 60)
    } else {
        format!("{min}m")
    })
}

pub fn now_badge_event<'a>(
    events: &'a [CalendarEvent],
    now: i64,
    dismissed: &DismissedNow,
) -> Option<&'a CalendarEvent> {
    current_or_next(events, now, dismissed).filter(|e| e.start <= now)
}

pub fn keep_dismissed_now(saved: &[(String, i64)], now: i64) -> DismissedNow {
    let live: Vec<&(String, i64)> = saved.iter().filter(|(_, end)| *end > now).collect();
    let skip = live.len().saturating_sub(MAX_DISMISSED_NOW);
    live.into_iter().skip(skip).cloned().collect()
}

fn round_half_up(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

pub fn relative_time(at: i64, now: i64) -> String {
    let min = round_half_up((at - now) as f64 / MINUTE as f64);
    if min == 0 {
        return "Now".to_owned();
    }
    let abs = min.abs();
    let text = if abs >= 60 {
        if abs % 60 != 0 {
            format!("{} hr {} min", abs / 60, abs % 60)
        } else {
            format!("{} hr", abs / 60)
        }
    } else {
        format!("{abs} min")
    };
    if min > 0 {
        format!("in {text}")
    } else {
        format!("{text} ago")
    }
}

pub fn ago(at: i64, now: i64) -> String {
    let min = (now - at).max(0) / MINUTE;
    if min < 1 {
        return "just now".to_owned();
    }
    if min < 60 {
        return format!("{min} min ago");
    }
    let hr = min / 60;
    if hr < 24 {
        return format!("{hr} hr ago");
    }
    let days = hr / 24;
    if days == 1 {
        "yesterday".to_owned()
    } else {
        format!("{days} days ago")
    }
}

pub fn time_remaining(end: i64, now: i64) -> String {
    let min = ((end - now) as f64 / MINUTE as f64).ceil() as i64;
    if min <= 0 {
        return "Ending now".to_owned();
    }
    if min >= 60 {
        format!("{} hr {} min left", min / 60, min % 60)
    } else {
        format!("{min} min left")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Countdown {
    pub label: Option<String>,
    pub urgent: bool,
}

pub fn meeting_countdown(end: Option<i64>, now: i64) -> Countdown {
    let minutes_left = end.map(|end| (end - now) as f64 / MINUTE as f64);
    Countdown {
        label: match (end, minutes_left) {
            (Some(end), Some(left)) if left <= COUNTDOWN_SHOW_WITHIN_MIN => {
                Some(time_remaining(end, now))
            }
            _ => None,
        },
        urgent: minutes_left.is_some_and(|left| left <= COUNTDOWN_URGENT_MIN),
    }
}

#[derive(Debug, Default)]
pub struct WiggleMarks {
    wiggled: BTreeSet<(String, i64)>,
}

impl WiggleMarks {
    pub fn due(&mut self, group: &str, minutes_left: f64) -> bool {
        let due: Vec<i64> = WIGGLE_MARKS_MIN
            .into_iter()
            .filter(|m| {
                minutes_left <= *m as f64
                    && minutes_left > (*m - 1) as f64
                    && !self.wiggled.contains(&(group.to_owned(), *m))
            })
            .collect();
        for m in WIGGLE_MARKS_MIN {
            if minutes_left <= (m - 1) as f64 {
                self.wiggled.insert((group.to_owned(), m));
            }
        }
        for m in &due {
            self.wiggled.insert((group.to_owned(), *m));
        }
        !due.is_empty()
    }
}

fn display_name(p: &Participant) -> String {
    if !p.name.is_empty() {
        return p.name.clone();
    }
    match p.email.split('@').next() {
        Some(local) if !local.is_empty() => local.to_owned(),
        _ => "Guest".to_owned(),
    }
}

pub fn attendees_label(event: &CalendarEvent) -> String {
    let names: Vec<String> = event
        .attendees
        .iter()
        .filter(|p| !p.me)
        .map(display_name)
        .collect();
    match names.len() {
        0 => String::new(),
        1 => names[0].clone(),
        2 => format!("{} and {}", names[0], names[1]),
        n => format!("{}, {} and {} more", names[0], names[1], n - 2),
    }
}

pub fn guests_label(event: &CalendarEvent) -> String {
    match event.attendees.len() {
        1 => "1 guest".to_owned(),
        n => format!("{n} guests"),
    }
}

pub fn join_title(provider: Option<MeetingProvider>) -> &'static str {
    match provider {
        Some(MeetingProvider::Meet) => "Join with Google Meet",
        Some(MeetingProvider::Zoom) => "Join with Zoom",
        Some(MeetingProvider::Teams) => "Join Microsoft Teams Meeting",
        _ => "Join",
    }
}

pub fn countdown_lead_title(minutes: i64) -> String {
    if minutes == 60 {
        "1 Hour Before".to_owned()
    } else {
        format!("{minutes} Minutes Before")
    }
}

pub fn due_alerts<'a>(
    events: &'a [CalendarEvent],
    now: i64,
    lead_minutes: i64,
    dismissed: &BTreeSet<String>,
) -> Vec<&'a CalendarEvent> {
    let mut due: Vec<&CalendarEvent> = events
        .iter()
        .filter(|e| is_meeting(e))
        .filter(|e| {
            !dismissed.contains(&e.occurrence)
                && now >= e.start - lead_minutes * MINUTE
                && now < e.end.min(e.start + 5 * MINUTE)
        })
        .collect();
    due.sort_by_key(|e| e.start);
    due
}

pub fn alert_title(event: &CalendarEvent) -> &str {
    if event.title.is_empty() {
        "Untitled event"
    } else {
        &event.title
    }
}

pub fn related_links_tooltip(count: usize) -> String {
    let links = if count == 1 {
        "1 link".to_owned()
    } else {
        format!("{count} links")
    };
    format!("Opens {links} from the invitation, then joins")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(start: i64, end: i64) -> CalendarEvent {
        CalendarEvent {
            occurrence: format!("e{start}"),
            start,
            end,
            ..CalendarEvent::default()
        }
    }

    #[test]
    fn calendar_and_meeting_urls() {
        assert!(is_calendar_url(
            "https://calendar.google.com/calendar/u/0/r"
        ));
        assert!(is_calendar_url(
            "https://outlook.office.com/calendar/view/week"
        ));
        assert!(!is_calendar_url("https://outlook.office.com/mail"));
        assert!(is_calendar_url("https://teams.microsoft.com/_#/calendarv2"));
        assert!(!is_calendar_url(
            "https://teams.microsoft.com/l/meetup-join/19%3a"
        ));
        assert_eq!(
            meeting_of("https://meet.google.com/ABC-defg-hij?authuser=0"),
            Some((MeetingProvider::Meet, "meet:abc-defg-hij".into()))
        );
        assert_eq!(meeting_of("https://meet.google.com/landing"), None);
        assert_eq!(
            meeting_of("https://us02web.zoom.us/j/8123?pwd=x"),
            Some((MeetingProvider::Zoom, "zoom:8123".into()))
        );
        assert_eq!(
            meeting_of("https://zoom.us/wc/join/555"),
            Some((MeetingProvider::Zoom, "zoom:555".into()))
        );
        assert_eq!(meeting_of("https://zoom.us/pricing"), None);
        assert_eq!(
            meeting_of("https://acme.webex.com/meet/pat").map(|m| m.0),
            Some(MeetingProvider::Webex)
        );
    }

    #[test]
    fn join_and_related_links_come_from_the_invitation() {
        let mut e = event(0, 1);
        e.notes = Some("Join: https://meet.google.com/abc-defg-hij. Doc https://docs.example.com/x, help https://support.google.com/a".into());
        assert_eq!(
            join_link(&e),
            Some((
                "https://meet.google.com/abc-defg-hij".into(),
                MeetingProvider::Meet
            ))
        );
        assert_eq!(
            related_links(&e),
            vec!["https://docs.example.com/x".to_owned()]
        );
    }

    #[test]
    fn badge_counts_down_within_the_lead() {
        let none = DismissedNow::new();
        let events = vec![event(30 * MINUTE + 1, 90 * MINUTE)];
        assert_eq!(badge_text(&events, 0, 60, &none).as_deref(), Some("31m"));
        assert_eq!(badge_text(&events, 0, 15, &none), None);
        let later = vec![event(60 * MINUTE, 90 * MINUTE)];
        assert_eq!(badge_text(&later, 0, 60, &none).as_deref(), Some("1h"));
        assert_eq!(
            badge_text(&events, 31 * MINUTE, 60, &none).as_deref(),
            Some("Now")
        );
        let mut dismissed = DismissedNow::new();
        dismissed.insert(events[0].occurrence.clone(), 90 * MINUTE);
        assert_eq!(badge_text(&events, 31 * MINUTE, 60, &dismissed), None);
        let mut all_day = event(0, 10 * MINUTE);
        all_day.all_day = true;
        assert_eq!(badge_text(&[all_day], 0, 60, &none), None);
    }

    #[test]
    fn times_read_like_the_old_app() {
        assert_eq!(relative_time(0, 0), "Now");
        assert_eq!(relative_time(5 * MINUTE, 0), "in 5 min");
        assert_eq!(relative_time(0, 90 * MINUTE), "1 hr 30 min ago");
        assert_eq!(relative_time(120 * MINUTE, 0), "in 2 hr");
        assert_eq!(ago(0, 30_000), "just now");
        assert_eq!(ago(0, 5 * MINUTE), "5 min ago");
        assert_eq!(ago(0, 25 * 60 * MINUTE), "yesterday");
        assert_eq!(ago(0, 72 * 60 * MINUTE), "3 days ago");
        assert_eq!(time_remaining(0, 0), "Ending now");
        assert_eq!(time_remaining(90 * MINUTE, 1), "1 hr 30 min left");
        assert_eq!(time_remaining(3 * MINUTE, 0), "3 min left");
    }

    #[test]
    fn countdown_shows_in_the_last_ten_minutes() {
        assert_eq!(meeting_countdown(Some(11 * MINUTE), 0).label, None);
        let near = meeting_countdown(Some(10 * MINUTE), 0);
        assert_eq!(near.label.as_deref(), Some("10 min left"));
        assert!(!near.urgent);
        assert!(meeting_countdown(Some(2 * MINUTE), 0).urgent);
        assert_eq!(meeting_countdown(None, 0).label, None);
    }

    #[test]
    fn wiggles_once_per_mark() {
        let mut marks = WiggleMarks::default();
        assert!(!marks.due("g", 6.0));
        assert!(marks.due("g", 4.5));
        assert!(!marks.due("g", 4.2));
        assert!(marks.due("g", 1.5));
        let mut late = WiggleMarks::default();
        assert!(late.due("g", 1.5));
        assert!(!late.due("g", 4.5));
    }

    #[test]
    fn labels_and_alerts() {
        let mut e = event(10 * MINUTE, 40 * MINUTE);
        e.attendees = vec![
            Participant {
                name: "Me".into(),
                email: String::new(),
                me: true,
                ..Participant::default()
            },
            Participant {
                name: String::new(),
                email: "ana@x.com".into(),
                me: false,
                ..Participant::default()
            },
            Participant {
                name: "Bo".into(),
                email: String::new(),
                me: false,
                ..Participant::default()
            },
            Participant {
                name: "Cy".into(),
                email: String::new(),
                me: false,
                ..Participant::default()
            },
        ];
        assert_eq!(attendees_label(&e), "ana, Bo and 1 more");
        assert_eq!(guests_label(&e), "4 guests");
        assert_eq!(join_title(Some(MeetingProvider::Zoom)), "Join with Zoom");
        assert_eq!(join_title(None), "Join");
        assert_eq!(countdown_lead_title(60), "1 Hour Before");
        assert_eq!(countdown_lead_title(15), "15 Minutes Before");
        assert_eq!(alert_title(&e), "Untitled event");
        assert_eq!(
            related_links_tooltip(1),
            "Opens 1 link from the invitation, then joins"
        );
        let events = vec![e];
        assert_eq!(
            due_alerts(&events, 9 * MINUTE, 1, &BTreeSet::new()).len(),
            1
        );
        assert!(due_alerts(&events, 8 * MINUTE, 1, &BTreeSet::new()).is_empty());
        assert!(due_alerts(&events, 15 * MINUTE, 1, &BTreeSet::new()).is_empty());
        let kept = keep_dismissed_now(&[("a".into(), 5), ("b".into(), 50)], 10);
        assert_eq!(kept.len(), 1);
    }
}
