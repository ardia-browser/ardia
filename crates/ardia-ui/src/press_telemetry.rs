use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use ardia_state::windows::{BrowserWindow, WindowKind};
use ardia_telemetry::consent::{self, Consent};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

pub const TAB_PRESSES_EVENT: &str = "tab_presses";
pub const PROFILE_SWITCHED_EVENT: &str = "profile_switched";

const MAX_SAMPLES: usize = 500;
const PAGE_CLICK_WINDOW: Duration = Duration::from_secs(60);
const CORRECTION_WINDOW: Duration = Duration::from_millis(2000);
const SWITCH_MATCH: Duration = Duration::from_millis(3000);
const KEPT_SWITCHER_PRESSES: usize = 4;

pub const TALLY_FIELDS: [&str; 18] = [
    "presses",
    "down_switches",
    "clicks",
    "drag_clicks",
    "drags_without_drop",
    "drops_gap",
    "drops_split_left",
    "drops_split_right",
    "drops_tile",
    "drops_other_profile",
    "unanswered",
    "unfocused_presses",
    "range_selects",
    "range_from_shown",
    "tile_double_returns",
    "tile_double_reloads",
    "tile_double_fresh",
    "tile_double_missed",
];

pub const HOVER_FIELDS: [&str; 4] = [
    "tab_hover_cards_shown",
    "tab_hover_card_presses",
    "tab_hover_card_resets",
    "tab_menu_pinned_resets",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SidebarDrop {
    Gap,
    SplitLeft,
    SplitRight,
    Tile,
    OtherProfile,
}

impl SidebarDrop {
    pub const fn field(self) -> &'static str {
        match self {
            SidebarDrop::Gap => "drops_gap",
            SidebarDrop::SplitLeft => "drops_split_left",
            SidebarDrop::SplitRight => "drops_split_right",
            SidebarDrop::Tile => "drops_tile",
            SidebarDrop::OtherProfile => "drops_other_profile",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileDoubleClick {
    Return,
    Reload,
    Fresh,
    Missed,
}

impl TileDoubleClick {
    pub const fn field(self) -> &'static str {
        match self {
            TileDoubleClick::Return => "tile_double_returns",
            TileDoubleClick::Reload => "tile_double_reloads",
            TileDoubleClick::Fresh => "tile_double_fresh",
            TileDoubleClick::Missed => "tile_double_missed",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Presses {
    counts: Vec<(&'static str, u64)>,
    pending: bool,
    dragging: bool,
    pressed_at: Option<Instant>,
    held_ms: Vec<u32>,
}

impl Presses {
    fn bump(&mut self, field: &'static str, by: u64) {
        if let Some(slot) = self.counts.iter_mut().find(|(name, _)| *name == field) {
            slot.1 += by;
        } else {
            self.counts.push((field, by));
        }
    }

    pub fn count(&self, field: &str) -> u64 {
        self.counts
            .iter()
            .find(|(name, _)| *name == field)
            .map_or(0, |(_, n)| *n)
    }

    pub fn started(&mut self, switched_on_press: bool, window_key: bool, now: Instant) {
        if self.pending {
            self.bump("unanswered", 1);
        }
        self.pending = true;
        self.dragging = false;
        self.bump("presses", 1);
        if switched_on_press {
            self.bump("down_switches", 1);
        }
        if !window_key {
            self.bump("unfocused_presses", 1);
        }
        self.pressed_at = switched_on_press.then_some(now);
    }

    pub fn released(&mut self, now: Instant) {
        if !self.pending || self.dragging {
            return;
        }
        self.pending = false;
        if let Some(at) = self.pressed_at.take() {
            let held = now.saturating_duration_since(at);
            if held < PAGE_CLICK_WINDOW && self.held_ms.len() < MAX_SAMPLES {
                self.held_ms.push(held.as_millis() as u32);
            }
        }
        self.bump("clicks", 1);
    }

    pub fn drag_began(&mut self) {
        if self.pending {
            self.dragging = true;
        }
    }

    pub fn drag_ended(&mut self, dropped: Option<SidebarDrop>, landed: bool, lifted: bool) {
        if self.pending {
            self.pending = false;
            self.pressed_at = None;
            self.bump("drag_clicks", 1);
        }
        self.dragging = false;
        if !lifted {
            return;
        }
        if !landed {
            self.bump("drags_without_drop", 1);
        } else if let Some(kind) = dropped {
            self.bump(kind.field(), 1);
        }
    }

    pub fn take(&mut self) -> Option<Map<String, Value>> {
        let counts = std::mem::take(&mut self.counts);
        let mut held = std::mem::take(&mut self.held_ms);
        if counts.iter().all(|(_, n)| *n == 0) && held.is_empty() {
            return None;
        }
        held.sort_unstable();
        let at = |p: f64| {
            if held.is_empty() {
                Value::Null
            } else {
                json!(ardia_telemetry::perf::percentile(&held, p))
            }
        };
        let mut props = Map::new();
        for field in TALLY_FIELDS.iter().chain(HOVER_FIELDS.iter()) {
            if let Some((_, n)) = counts.iter().find(|(name, _)| name == field) {
                props.insert((*field).to_owned(), json!(n));
            }
        }
        props.insert("held_ms_p50".into(), at(0.5));
        props.insert("held_ms_p75".into(), at(0.75));
        props.insert("held_n".into(), json!(held.len()));
        Some(props)
    }
}

#[derive(Clone, Debug)]
struct SwitcherPress {
    window: String,
    profile: String,
    icons: bool,
    corrected: bool,
    at: Instant,
    matched: bool,
}

static PRESSES: Mutex<Option<Presses>> = Mutex::new(None);
static SWITCHER: Mutex<VecDeque<SwitcherPress>> = Mutex::new(VecDeque::new());
static WATCHING: AtomicBool = AtomicBool::new(false);

fn sharing() -> Option<Consent> {
    consent::consent_now()
}

fn with_presses(f: impl FnOnce(&mut Presses)) {
    if sharing().is_none() {
        return;
    }
    f(PRESSES.lock().get_or_insert_with(Presses::default));
}

pub fn start() {
    if WATCHING.swap(true, Ordering::Relaxed) {
        return;
    }
    consent::on_period_change(|| {
        *PRESSES.lock() = None;
        SWITCHER.lock().clear();
    });
}

pub fn note_press_started(switched_on_press: bool, window_key: bool) {
    with_presses(|p| p.started(switched_on_press, window_key, Instant::now()));
}

pub fn note_press_released() {
    with_presses(|p| p.released(Instant::now()));
}

pub fn note_drag_began() {
    with_presses(Presses::drag_began);
}

pub fn note_drag_ended(dropped: Option<SidebarDrop>, landed: bool, lifted: bool) {
    with_presses(|p| p.drag_ended(dropped, landed, lifted));
}

pub fn note_range_select(from_shown_tab: bool) {
    with_presses(|p| {
        p.bump("range_selects", 1);
        if from_shown_tab {
            p.bump("range_from_shown", 1);
        }
    });
}

pub fn note_tile_double_click(what: TileDoubleClick) {
    with_presses(|p| p.bump(what.field(), 1));
}

pub fn note_hover_card_shown() {
    with_presses(|p| p.bump("tab_hover_cards_shown", 1));
}

pub fn note_hover_card_press(reset: bool) {
    with_presses(|p| {
        p.bump("tab_hover_card_presses", 1);
        if reset {
            p.bump("tab_hover_card_resets", 1);
        }
    });
}

pub fn note_menu_pick(key: &str) {
    if key.split('#').next() == Some("backToPin") {
        with_presses(|p| p.bump("tab_menu_pinned_resets", 1));
    }
}

pub fn take_tab_presses() -> Option<Map<String, Value>> {
    PRESSES.lock().take().and_then(|mut p| p.take())
}

pub fn emit_tab_presses() {
    let consent = sharing();
    let Some(props) = take_tab_presses() else {
        return;
    };
    ardia_telemetry::capture_for(TAB_PRESSES_EVENT, props, consent.as_ref());
}

pub fn note_switcher_press(window: &str, profile: &str, icons: bool) {
    if sharing().is_none() {
        return;
    }
    remember_switcher_press(&mut SWITCHER.lock(), window, profile, icons, Instant::now());
}

fn remember_switcher_press(
    presses: &mut VecDeque<SwitcherPress>,
    window: &str,
    profile: &str,
    icons: bool,
    now: Instant,
) {
    let corrected = presses.back().is_some_and(|previous| {
        previous.window == window
            && previous.profile != profile
            && now.saturating_duration_since(previous.at) < CORRECTION_WINDOW
    });
    presses.push_back(SwitcherPress {
        window: window.to_owned(),
        profile: profile.to_owned(),
        icons,
        corrected,
        at: now,
        matched: false,
    });
    while presses.len() > KEPT_SWITCHER_PRESSES {
        presses.pop_front();
    }
}

fn switch_properties(
    presses: &mut VecDeque<SwitcherPress>,
    window: &str,
    profile: &str,
    now: Instant,
) -> Map<String, Value> {
    let mut props = Map::new();
    let press = presses.iter_mut().rev().find(|p| {
        !p.matched
            && p.window == window
            && p.profile == profile
            && now.saturating_duration_since(p.at) < SWITCH_MATCH
    });
    match press {
        Some(press) => {
            press.matched = true;
            props.insert("via_switcher".into(), json!(true));
            props.insert("switcher_icons".into(), json!(press.icons));
            props.insert("switcher_corrected".into(), json!(press.corrected));
        }
        None => {
            props.insert("via_switcher".into(), json!(false));
        }
    }
    props
}

pub fn profile_switched(browser: &BrowserWindow, profiles: usize, window: &mut gpui::Window) {
    if browser.kind == WindowKind::Incognito {
        return;
    }
    let consent = sharing();
    let start = Instant::now();
    let via = switch_properties(
        &mut SWITCHER.lock(),
        browser.id.as_str(),
        browser.profile_id.as_str(),
        start,
    );
    window.on_next_frame(move |window, _| {
        window.on_next_frame(move |_, _| {
            let mut props = Map::new();
            props.insert(
                "switch_ms".into(),
                json!(start.elapsed().as_millis() as u64),
            );
            props.insert("profiles".into(), json!(profiles));
            for (key, value) in via {
                props.insert(key, value);
            }
            ardia_telemetry::capture_for(PROFILE_SWITCHED_EVENT, props, consent.as_ref());
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_a_drag_and_an_abandoned_press_are_tallied_like_the_old_app() {
        let t0 = Instant::now();
        let mut p = Presses::default();
        p.started(true, true, t0);
        p.released(t0 + Duration::from_millis(80));
        p.started(false, false, t0);
        p.drag_began();
        p.released(t0);
        p.drag_ended(Some(SidebarDrop::SplitLeft), true, true);
        p.started(false, true, t0);
        p.started(false, true, t0);
        p.drag_began();
        p.drag_ended(None, false, true);
        assert_eq!(p.count("presses"), 4);
        assert_eq!(p.count("down_switches"), 1);
        assert_eq!(p.count("clicks"), 1);
        assert_eq!(p.count("drag_clicks"), 2);
        assert_eq!(p.count("drops_split_left"), 1);
        assert_eq!(p.count("drags_without_drop"), 1);
        assert_eq!(p.count("unanswered"), 1);
        assert_eq!(p.count("unfocused_presses"), 1);
        let props = p.take().expect("props");
        assert_eq!(props["held_ms_p50"], 80);
        assert_eq!(props["held_n"], 1);
        assert_eq!(props["clicks"], 1);
        assert!(!props.contains_key("drops_tile"));
        assert!(p.take().is_none());
    }

    #[test]
    fn an_unlifted_drag_is_a_click_without_a_drop_count() {
        let mut p = Presses::default();
        p.started(false, true, Instant::now());
        p.drag_began();
        p.drag_ended(None, false, false);
        assert_eq!(p.count("drag_clicks"), 1);
        assert_eq!(p.count("drags_without_drop"), 0);
    }

    #[test]
    fn switcher_presses_match_the_switch_once_and_flag_corrections() {
        let t0 = Instant::now();
        let mut presses = VecDeque::new();
        remember_switcher_press(&mut presses, "w", "a", false, t0);
        remember_switcher_press(
            &mut presses,
            "w",
            "b",
            true,
            t0 + Duration::from_millis(500),
        );
        let props = switch_properties(&mut presses, "w", "b", t0 + Duration::from_millis(600));
        assert_eq!(props["via_switcher"], true);
        assert_eq!(props["switcher_icons"], true);
        assert_eq!(props["switcher_corrected"], true);
        let again = switch_properties(&mut presses, "w", "b", t0 + Duration::from_millis(700));
        assert_eq!(again["via_switcher"], false);
        assert!(!again.contains_key("switcher_icons"));
        let late = switch_properties(&mut presses, "w", "a", t0 + Duration::from_secs(10));
        assert_eq!(late["via_switcher"], false);
    }
}
