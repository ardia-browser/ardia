use std::collections::{HashMap, HashSet};

use ardia_state::{BrowserState, ProfileId, TabId, WindowId};
use serde_json::Value;

pub const SKIP_SECONDS: f64 = 15.0;
const RESUME_SEEK_MIN_SECONDS: f64 = 5.0;
const MAX_TEXT: usize = 1024;
const MAX_ARTWORK: usize = 1 << 20;
const MAX_ACTION: usize = 64;
const MAX_ACTIONS: usize = 32;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Playback {
    #[default]
    None,
    Paused,
    Playing,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork: Option<String>,
    pub playback: Playback,
    pub position: f64,
    pub duration: Option<f64>,
    pub rate: f64,
    pub timestamp: f64,
    pub has_video: bool,
    pub actions: Vec<String>,
    pub controllable: bool,
    pub looping: bool,
}

fn clipped(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    if text.chars().count() <= max {
        return Some(text.to_owned());
    }
    Some(text.chars().take(max).collect())
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite())
}

impl NowPlaying {
    pub fn sanitized(value: &Value) -> Option<NowPlaying> {
        let fields = value.as_object().filter(|map| !map.is_empty())?;
        let playback = match fields.get("playbackState").and_then(Value::as_str) {
            Some("playing") => Playback::Playing,
            Some("paused") => Playback::Paused,
            _ => Playback::None,
        };
        let actions = fields
            .get("actions")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .filter(|action| action.len() <= MAX_ACTION)
                    .take(MAX_ACTIONS)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Some(NowPlaying {
            title: clipped(fields.get("title"), MAX_TEXT).unwrap_or_default(),
            artist: clipped(fields.get("artist"), MAX_TEXT).unwrap_or_default(),
            album: clipped(fields.get("album"), MAX_TEXT).unwrap_or_default(),
            artwork: clipped(fields.get("artwork"), MAX_ARTWORK),
            playback,
            position: finite(fields.get("position")).unwrap_or(0.0).max(0.0),
            duration: finite(fields.get("duration")).filter(|d| *d >= 0.0),
            rate: finite(fields.get("playbackRate")).unwrap_or(1.0),
            timestamp: finite(fields.get("timestamp")).unwrap_or(0.0),
            has_video: fields
                .get("hasVideo")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            actions,
            controllable: fields
                .get("controllable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            looping: fields.get("loop").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    pub fn is_playing(&self) -> bool {
        self.playback == Playback::Playing
    }

    fn controllably_playing(&self) -> bool {
        self.controllable && self.is_playing()
    }

    pub fn has_track_controls(&self) -> bool {
        self.actions
            .iter()
            .any(|a| a == "nexttrack" || a == "previoustrack")
    }

    pub fn is_live(&self) -> bool {
        self.duration.is_none()
    }

    pub fn position_at(&self, now_ms: f64) -> f64 {
        let elapsed = if self.is_playing() {
            (now_ms - self.timestamp) / 1000.0 * if self.rate == 0.0 { 1.0 } else { self.rate }
        } else {
            0.0
        };
        let position = (self.position + elapsed).max(0.0);
        match self.duration {
            Some(duration) if duration > 0.0 => {
                if self.looping && position >= duration {
                    position % duration
                } else {
                    position.min(duration)
                }
            }
            _ => position,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransportIcons {
    pub back: &'static str,
    pub ahead: &'static str,
    pub back_tip: &'static str,
    pub ahead_tip: &'static str,
}

pub fn transport_icons(now: &NowPlaying) -> TransportIcons {
    if now.has_track_controls() {
        TransportIcons {
            back: "backward.end.fill",
            ahead: "forward.end.fill",
            back_tip: "Play Previous Track",
            ahead_tip: "Play Next Track",
        }
    } else {
        TransportIcons {
            back: "gobackward.15",
            ahead: "goforward.15",
            back_tip: "Skip back 15 seconds",
            ahead_tip: "Skip ahead 15 seconds",
        }
    }
}

pub fn format_time(seconds: f64) -> String {
    let total = if seconds.is_finite() {
        seconds.max(0.0).floor() as u64
    } else {
        0
    };
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

#[derive(Clone, Debug, Default)]
pub struct FrameReports {
    frames: HashMap<String, NowPlaying>,
    main_frames: HashSet<String>,
    selected: Option<String>,
}

impl FrameReports {
    fn rank(&self, frame: Option<&String>) -> i32 {
        let Some(state) = frame.and_then(|f| self.frames.get(f)) else {
            return -1;
        };
        let main = frame.is_some_and(|f| self.main_frames.contains(f));
        (if state.controllable { 4 } else { 0 })
            + (if state.is_playing() { 2 } else { 0 })
            + i32::from(main)
    }

    pub fn note(
        &mut self,
        frame: &str,
        page: Option<NowPlaying>,
        main: bool,
    ) -> Option<NowPlaying> {
        let reported = page.is_some();
        match page {
            Some(state) => {
                self.frames.insert(frame.to_owned(), state);
                if main {
                    self.main_frames.insert(frame.to_owned());
                } else {
                    self.main_frames.remove(frame);
                }
            }
            None => {
                self.frames.remove(frame);
                self.main_frames.remove(frame);
            }
        }
        let mut best = if reported {
            Some(frame.to_owned())
        } else {
            self.frames.keys().min().cloned()
        };
        let mut others: Vec<&String> = self.frames.keys().collect();
        others.sort();
        for other in others {
            if self.rank(Some(other)) > self.rank(best.as_ref()) {
                best = Some(other.clone());
            }
        }
        self.selected = best;
        self.selected().cloned()
    }

    pub fn selected(&self) -> Option<&NowPlaying> {
        self.selected.as_ref().and_then(|f| self.frames.get(f))
    }

    pub fn selected_frame(&self) -> &str {
        self.selected.as_deref().unwrap_or("")
    }

    pub fn reset(&mut self) -> bool {
        let had = !self.frames.is_empty();
        self.frames.clear();
        self.main_frames.clear();
        self.selected = None;
        had
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub now: NowPlaying,
    pub played_at: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MediaCommand {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    SeekBy(f64),
    SeekTo(f64),
}

impl MediaCommand {
    pub fn wire(self) -> (&'static str, f64) {
        match self {
            MediaCommand::Play => ("play", 0.0),
            MediaCommand::Pause => ("pause", 0.0),
            MediaCommand::Toggle => ("toggle", 0.0),
            MediaCommand::Next => ("next", 0.0),
            MediaCommand::Previous => ("previous", 0.0),
            MediaCommand::SeekBy(seconds) => ("seekBy", seconds),
            MediaCommand::SeekTo(seconds) => ("seekTo", seconds),
        }
    }

    pub fn starts_playback(self) -> bool {
        matches!(self, MediaCommand::Play | MediaCommand::Toggle)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MediaAction {
    Toggle,
    Back,
    Ahead,
    SeekTo(f64),
}

pub fn resume_commands(
    before: Option<&Session>,
    after: Option<&NowPlaying>,
    now_ms: f64,
) -> Vec<MediaCommand> {
    if after.is_some_and(NowPlaying::is_playing) {
        return Vec::new();
    }
    let at = before.map_or(0.0, |b| b.now.position_at(now_ms));
    let same_media = match after {
        None => true,
        Some(after) => {
            before.is_some_and(|b| !b.now.title.is_empty() && b.now.title == after.title)
        }
    };
    let moved = after.is_none_or(|after| (after.position - at).abs() > RESUME_SEEK_MIN_SECONDS);
    if same_media && at > RESUME_SEEK_MIN_SECONDS && moved {
        vec![MediaCommand::SeekTo(at), MediaCommand::Play]
    } else {
        vec![MediaCommand::Play]
    }
}

pub fn note_position_report(before: Option<&NowPlaying>, report: &NowPlaying) {
    let Some(before) = before.filter(|b| b.is_playing()) else {
        return;
    };
    let rate = if before.rate == 0.0 { 1.0 } else { before.rate };
    let extrapolated = before.position + (report.timestamp - before.timestamp) / 1000.0 * rate;
    if report.looping && report.position + 1.0 < extrapolated {
        ardia_telemetry::counts::count("now_playing_loop_restarts");
        return;
    }
    if report.position < extrapolated - 1.0 {
        ardia_telemetry::counts::count("media_position_rewinds");
    }
    if before
        .duration
        .is_some_and(|d| d > 0.0 && !before.looping && extrapolated > d + 2.0)
    {
        ardia_telemetry::counts::count("media_reports_past_end");
    }
}

#[derive(Clone, Debug, Default)]
pub struct MediaBook {
    pub sessions: HashMap<TabId, Session>,
    pub dismissed: HashSet<TabId>,
    pub left_paused: HashSet<TabId>,
    pub pip_open: HashSet<TabId>,
    hidden_before: HashSet<TabId>,
    shared_players: HashMap<WindowId, Option<TabId>>,
    own_players: HashMap<(WindowId, ProfileId), TabId>,
}

fn active_of(
    state: &BrowserState,
    window: &WindowId,
    profile: Option<&ProfileId>,
) -> Option<TabId> {
    let w = state.window(window.as_str())?;
    let id = w.active_tab_ids.get(profile.unwrap_or(&w.profile_id))?;
    state
        .tab(id.as_str())
        .filter(|t| &t.window_id == window)
        .map(|t| t.id.clone())
}

pub fn is_tab_shown(state: &BrowserState, tab: &TabId, profile: Option<&ProfileId>) -> bool {
    let Some(window) = state.tab(tab.as_str()).map(|t| t.window_id.clone()) else {
        return false;
    };
    let Some(active) = active_of(state, &window, profile) else {
        return false;
    };
    if &active == tab {
        return true;
    }
    let peeked = state.window(window.as_str()).is_some_and(|w| {
        w.chrome.peek.as_ref().is_some_and(|peek| {
            &peek.tab_id == tab
                && peek.source_tab_id.as_ref().is_none_or(|s| s == &active)
                && state
                    .tab(peek.tab_id.as_str())
                    .is_some_and(|t| t.window_id == window)
        })
    });
    peeked
        || state
            .split_of(active.as_str())
            .is_some_and(|split| split.contains(tab.as_str()))
}

fn is_hidden_player_tab(state: &BrowserState, tab: &TabId) -> bool {
    let Some(t) = state.tab(tab.as_str()) else {
        return false;
    };
    let Some(w) = state.window(t.window_id.as_str()) else {
        return false;
    };
    let profile = if state.settings.playing_now_across_profiles {
        &w.profile_id
    } else {
        &t.profile_id
    };
    state.settings.sidebar_media_controls && !is_tab_shown(state, tab, Some(profile))
}

impl MediaBook {
    pub fn session(&self, tab: &TabId) -> Option<&Session> {
        self.sessions.get(tab)
    }

    pub fn has_player(&self, tab: &TabId) -> bool {
        self.sessions.get(tab).is_some_and(|s| {
            s.now.controllable
                && !self.dismissed.contains(tab)
                && s.played_at > 0.0
                && s.now.playback != Playback::None
        })
    }

    pub fn shows_mini_player(&self, state: &BrowserState, tab: &TabId) -> bool {
        let pinned = state.tab(tab.as_str()).is_some_and(|t| t.pin.is_some())
            && state.settings.sidebar_media_controls;
        pinned
            && self.sessions.get(tab).is_some_and(|s| {
                s.now.controllable
                    && s.now.playback != Playback::None
                    && (!s.now.title.is_empty() || s.now.artwork.is_some())
            })
    }

    pub fn apply(
        &mut self,
        state: &BrowserState,
        tab: &TabId,
        report: Option<NowPlaying>,
        now_ms: f64,
    ) -> bool {
        let Some(report) = report else {
            return self.sessions.remove(tab).is_some();
        };
        let before = self.sessions.get(tab);
        note_position_report(before.map(|b| &b.now), &report);
        let started =
            report.controllably_playing() && !before.is_some_and(|b| b.now.controllably_playing());
        let played_at = if started {
            now_ms
        } else {
            before.map_or(0.0, |b| b.played_at)
        };
        let next = Session {
            now: report,
            played_at,
        };
        let changed = before != Some(&next);
        self.sessions.insert(tab.clone(), next);
        if started {
            for peer in self.paused_peers(state, tab) {
                self.left_paused.insert(peer);
            }
            self.dismissed.remove(tab);
        }
        changed || started
    }

    fn paused_peers(&self, state: &BrowserState, tab: &TabId) -> Vec<TabId> {
        let Some(t) = state.tab(tab.as_str()) else {
            return Vec::new();
        };
        let across = state.settings.playing_now_across_profiles;
        self.sessions
            .iter()
            .filter(|(id, session)| {
                *id != tab
                    && !session.now.is_playing()
                    && state.tab(id.as_str()).is_some_and(|other| {
                        other.window_id == t.window_id
                            && (across || other.profile_id == t.profile_id)
                    })
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn note_left_paused(&mut self, state: &BrowserState) {
        if self.hidden_before.is_empty() && self.sessions.is_empty() {
            return;
        }
        let hidden: HashSet<TabId> = self
            .sessions
            .keys()
            .filter(|id| is_hidden_player_tab(state, id))
            .cloned()
            .collect();
        let left: HashSet<TabId> = hidden
            .iter()
            .filter(|id| {
                !self.sessions.get(*id).is_some_and(|s| s.now.is_playing())
                    && (self.left_paused.contains(*id) || !self.hidden_before.contains(*id))
            })
            .cloned()
            .collect();
        self.hidden_before = hidden;
        self.left_paused = left;
    }

    fn hidden_player_tabs(
        &self,
        state: &BrowserState,
        window: &WindowId,
        profile: &ProfileId,
    ) -> Vec<TabId> {
        let Some(w) = state.window(window.as_str()) else {
            return Vec::new();
        };
        let across = state.settings.playing_now_across_profiles;
        let mut ids: Vec<TabId> =
            self.sessions
                .keys()
                .filter(|id| {
                    state.tab(id.as_str()).is_some_and(|t| {
                        &t.window_id == window && (across || &t.profile_id == profile)
                    }) && is_hidden_player_tab(state, id)
                })
                .cloned()
                .collect();
        let order = |id: &TabId| w.tab_ids.iter().position(|t| t == id).unwrap_or(usize::MAX);
        ids.sort_by_key(order);
        ids
    }

    pub fn player_tab_for(&self, tabs: &[TabId], current: Option<&TabId>) -> Option<TabId> {
        if let Some(current) = current.filter(|c| tabs.contains(c) && self.has_player(c)) {
            return Some(current.clone());
        }
        let rank = |s: &Session| i32::from(s.now.is_playing());
        let mut best: Option<(&TabId, &Session)> = None;
        for id in tabs {
            if !self.has_player(id) {
                continue;
            }
            let Some(session) = self.sessions.get(id) else {
                continue;
            };
            let better = match best {
                None => true,
                Some((_, b)) => {
                    rank(session) > rank(b)
                        || (rank(session) == rank(b) && session.played_at > b.played_at)
                }
            };
            if better {
                best = Some((id, session));
            }
        }
        best.map(|(id, _)| id.clone())
    }

    pub fn sidebar_player_tab(
        &mut self,
        state: &BrowserState,
        window: &WindowId,
        profile: &ProfileId,
    ) -> Option<TabId> {
        self.note_left_paused(state);
        let candidates: Vec<TabId> = self
            .hidden_player_tabs(state, window, profile)
            .into_iter()
            .filter(|id| !self.left_paused.contains(id))
            .collect();
        let across = state.settings.playing_now_across_profiles;
        let key = (window.clone(), profile.clone());
        let current = if across {
            self.shared_players.get(window).cloned().flatten()
        } else {
            self.own_players.get(&key).cloned()
        };
        let picked = self.player_tab_for(&candidates, current.as_ref());
        if across {
            self.shared_players.insert(window.clone(), picked.clone());
        } else {
            self.shared_players.remove(window);
        }
        match &picked {
            Some(tab) => {
                if self.own_players.get(&key) != Some(tab)
                    && state
                        .tab(tab.as_str())
                        .is_some_and(|t| &t.profile_id != profile)
                {
                    ardia_telemetry::counts::count("sidebar_player_from_other_profile");
                }
                self.own_players.insert(key, tab.clone());
            }
            None => {
                self.own_players.remove(&key);
            }
        }
        picked
    }

    pub fn dismiss(&mut self, tab: &TabId) -> bool {
        self.dismissed.insert(tab.clone())
    }

    pub fn set_pip(&mut self, tab: &TabId, open: bool) -> bool {
        if open {
            self.pip_open.insert(tab.clone())
        } else {
            self.pip_open.remove(tab)
        }
    }

    pub fn action(
        &mut self,
        tab: &TabId,
        action: MediaAction,
        now_ms: f64,
    ) -> Option<MediaCommand> {
        let session = self.sessions.get_mut(tab)?;
        Some(match action {
            MediaAction::Toggle => MediaCommand::Toggle,
            MediaAction::SeekTo(seconds) => {
                session.now.position = seconds;
                session.now.timestamp = now_ms;
                MediaCommand::SeekTo(seconds)
            }
            MediaAction::Back | MediaAction::Ahead if session.now.has_track_controls() => {
                if action == MediaAction::Back {
                    MediaCommand::Previous
                } else {
                    MediaCommand::Next
                }
            }
            MediaAction::Back | MediaAction::Ahead => {
                let seconds = if action == MediaAction::Back {
                    -SKIP_SECONDS
                } else {
                    SKIP_SECONDS
                };
                let limit = session.now.duration.unwrap_or(f64::INFINITY);
                session.now.position =
                    (session.now.position_at(now_ms) + seconds).clamp(0.0, limit.max(0.0));
                session.now.timestamp = now_ms;
                MediaCommand::SeekBy(seconds)
            }
        })
    }

    pub fn prune(&mut self, state: &BrowserState) -> bool {
        let gone = |id: &TabId| state.tab(id.as_str()).is_none();
        let before = self.sessions.len()
            + self.dismissed.len()
            + self.left_paused.len()
            + self.pip_open.len();
        self.sessions.retain(|id, _| !gone(id));
        self.dismissed.retain(|id| !gone(id));
        self.left_paused.retain(|id| !gone(id));
        self.pip_open.retain(|id| !gone(id));
        self.hidden_before.retain(|id| !gone(id));
        before
            != self.sessions.len()
                + self.dismissed.len()
                + self.left_paused.len()
                + self.pip_open.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report(state: &str, controllable: bool) -> NowPlaying {
        NowPlaying::sanitized(&json!({
            "title": "Song",
            "artist": "Band",
            "playbackState": state,
            "position": 10.0,
            "duration": 200.0,
            "playbackRate": 1.0,
            "timestamp": 1000.0,
            "actions": ["play", "pause"],
            "controllable": controllable,
        }))
        .unwrap()
    }

    #[test]
    fn reports_are_sanitized_like_the_native_reader() {
        let now = NowPlaying::sanitized(&json!({
            "playbackState": "weird",
            "position": -5,
            "duration": "x",
            "actions": ["nexttrack", 3, "a".repeat(80)],
            "artwork": "https://a/b.png",
        }))
        .unwrap();
        assert_eq!(now.playback, Playback::None);
        assert_eq!(now.position, 0.0);
        assert_eq!(now.duration, None);
        assert_eq!(now.actions, vec!["nexttrack".to_owned()]);
        assert_eq!(now.rate, 1.0);
        assert!(now.has_track_controls());
        assert!(NowPlaying::sanitized(&json!(null)).is_none());
        assert!(NowPlaying::sanitized(&json!({})).is_none());
    }

    #[test]
    fn the_playing_controllable_frame_wins() {
        let mut frames = FrameReports::default();
        frames.note("main", Some(report("paused", false)), true);
        frames.note("ad", Some(report("playing", true)), false);
        assert_eq!(frames.selected_frame(), "ad");
        frames.note("main", Some(report("paused", false)), true);
        assert_eq!(frames.selected_frame(), "ad");
        frames.note("ad", None, false);
        assert_eq!(frames.selected_frame(), "main");
        assert!(frames.reset());
        assert!(frames.selected().is_none());
        assert!(!frames.reset());
    }

    #[test]
    fn positions_advance_while_playing_and_wrap_when_looping() {
        let mut now = report("playing", true);
        assert_eq!(now.position_at(3000.0), 12.0);
        now.playback = Playback::Paused;
        assert_eq!(now.position_at(3000.0), 10.0);
        now.playback = Playback::Playing;
        now.looping = true;
        assert_eq!(now.position_at(1000.0 + 195_000.0), 5.0);
        now.looping = false;
        assert_eq!(now.position_at(1000.0 + 195_000.0), 200.0);
    }

    #[test]
    fn times_format_like_the_old_player() {
        assert_eq!(format_time(0.0), "0:00");
        assert_eq!(format_time(65.9), "1:05");
        assert_eq!(format_time(3725.0), "1:02:05");
        assert_eq!(format_time(-3.0), "0:00");
        assert_eq!(format_time(f64::NAN), "0:00");
    }

    #[test]
    fn transport_icons_follow_track_actions() {
        let mut now = report("playing", true);
        assert_eq!(transport_icons(&now).back, "gobackward.15");
        assert_eq!(transport_icons(&now).ahead_tip, "Skip ahead 15 seconds");
        now.actions.push("nexttrack".into());
        assert_eq!(transport_icons(&now).ahead, "forward.end.fill");
        assert_eq!(transport_icons(&now).back_tip, "Play Previous Track");
    }

    #[test]
    fn skipping_seeks_optimistically_and_tracks_use_next_previous() {
        let mut book = MediaBook::default();
        let state = BrowserState::default();
        let tab = TabId::from("t1");
        book.apply(&state, &tab, Some(report("paused", true)), 1000.0);
        assert_eq!(
            book.action(&tab, MediaAction::Ahead, 2000.0),
            Some(MediaCommand::SeekBy(15.0))
        );
        assert_eq!(book.session(&tab).unwrap().now.position, 25.0);
        assert_eq!(
            book.action(&tab, MediaAction::Back, 2000.0),
            Some(MediaCommand::SeekBy(-15.0))
        );
        assert_eq!(
            book.action(&tab, MediaAction::Back, 2000.0),
            Some(MediaCommand::SeekBy(-15.0))
        );
        assert_eq!(book.session(&tab).unwrap().now.position, 0.0);
        assert_eq!(
            book.action(&tab, MediaAction::SeekTo(50.0), 3000.0),
            Some(MediaCommand::SeekTo(50.0))
        );
        book.sessions
            .get_mut(&tab)
            .unwrap()
            .now
            .actions
            .push("previoustrack".into());
        assert_eq!(
            book.action(&tab, MediaAction::Back, 3000.0),
            Some(MediaCommand::Previous)
        );
        assert_eq!(
            book.action(&tab, MediaAction::Toggle, 3000.0),
            Some(MediaCommand::Toggle)
        );
        assert_eq!(
            book.action(&TabId::from("none"), MediaAction::Toggle, 0.0),
            None
        );
    }

    #[test]
    fn a_player_needs_a_controllable_session_that_has_played_and_is_not_dismissed() {
        let mut book = MediaBook::default();
        let state = BrowserState::default();
        let tab = TabId::from("t1");
        book.apply(&state, &tab, Some(report("paused", true)), 1000.0);
        assert!(!book.has_player(&tab));
        book.apply(&state, &tab, Some(report("playing", true)), 2000.0);
        assert!(book.has_player(&tab));
        book.dismiss(&tab);
        assert!(!book.has_player(&tab));
        book.apply(&state, &tab, Some(report("paused", true)), 3000.0);
        assert!(!book.has_player(&tab));
        book.apply(&state, &tab, Some(report("playing", true)), 4000.0);
        assert!(book.has_player(&tab));
        assert_eq!(book.session(&tab).unwrap().played_at, 4000.0);
        book.apply(&state, &tab, None, 5000.0);
        assert!(book.session(&tab).is_none());
    }

    #[test]
    fn the_playing_or_most_recent_tab_gets_the_player_and_the_current_one_sticks() {
        let mut book = MediaBook::default();
        let state = BrowserState::default();
        let (a, b) = (TabId::from("a"), TabId::from("b"));
        book.apply(&state, &a, Some(report("playing", true)), 1000.0);
        book.apply(&state, &b, Some(report("playing", true)), 2000.0);
        let tabs = vec![a.clone(), b.clone()];
        assert_eq!(book.player_tab_for(&tabs, None), Some(b.clone()));
        assert_eq!(book.player_tab_for(&tabs, Some(&a)), Some(a.clone()));
        book.apply(&state, &b, Some(report("paused", true)), 3000.0);
        assert_eq!(book.player_tab_for(&tabs, None), Some(a.clone()));
    }

    #[test]
    fn resuming_a_woken_tab_seeks_back_to_where_it_was() {
        let before = Session {
            now: NowPlaying {
                title: "Song".into(),
                position: 60.0,
                timestamp: 0.0,
                playback: Playback::Paused,
                ..NowPlaying::default()
            },
            played_at: 1.0,
        };
        assert_eq!(
            resume_commands(Some(&before), None, 0.0),
            vec![MediaCommand::SeekTo(60.0), MediaCommand::Play]
        );
        let mut after = before.now.clone();
        after.position = 0.0;
        assert_eq!(
            resume_commands(Some(&before), Some(&after), 0.0),
            vec![MediaCommand::SeekTo(60.0), MediaCommand::Play]
        );
        after.title = "Other".into();
        assert_eq!(
            resume_commands(Some(&before), Some(&after), 0.0),
            vec![MediaCommand::Play]
        );
        after.playback = Playback::Playing;
        assert!(resume_commands(Some(&before), Some(&after), 0.0).is_empty());
    }
}
