use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::omnibox::url::{to_app_url, url_for_display};
use ardia_state::{Action, BrowserState, TabId, WindowId};
use ardia_theme::layout::panel;
use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, App, ClickEvent, FontWeight, Hsla, IntoElement, MouseButton, ParentElement, Rgba,
    ScrollDelta, ScrollEvent, SharedString, Styled, TouchPhase, Window, div, prelude::*,
};

use crate::host::UiHost;
use crate::msg::{Emit, Msg};
use crate::pages::links::{OpenMode, open_mode_for, open_url};
use crate::primitives::controls::{ButtonKind, MenuRow, PushButton, popover, separator, shadow};
use crate::primitives::favicon::{favicon_of, render_favicon, resolve_favicon};
use crate::primitives::glass_states::{
    GLASS_CONTROL_GROUP, GlassBacking, GlassStates, stateful_glass,
};
use crate::primitives::icons::{Icon, icon};
use crate::scale::px;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;
use crate::window::motion::{Curve, Motion};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PageOverlay {
    pub status: Option<String>,
    pub status_at_top: bool,
    pub crashed: bool,
    pub unresponsive: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlCaller {
    pub name: String,
    pub app: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProgramControl {
    pub connected: bool,
    pub runs: u64,
    pub caller: Option<ControlCaller>,
    pub compact: bool,
    pub hidden: bool,
}

pub fn control_line(caller: Option<&ControlCaller>) -> (String, String, String) {
    match caller {
        None => (
            "A program".to_owned(),
            String::new(),
            " is controlling Ardia".to_owned(),
        ),
        Some(caller) => (
            String::new(),
            caller.name.clone(),
            " is controlling Ardia".to_owned(),
        ),
    }
}

pub const CONTROL_HOLD: Duration = Duration::from_millis(3000);
pub const CONTROL_PILL_MOTION: Duration = Duration::from_millis(150);
pub const CONTROL_PILL_HEIGHT: f32 = 32.0;
pub const CONTROL_PILL_BOTTOM: f32 = 12.0;
pub const CONTROL_DOT: f32 = 20.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NavigationStep {
    pub url: String,
    pub title: String,
    pub current: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewTabNotice {
    pub id: u64,
    pub tab: TabId,
    pub source: TabId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryDirection {
    Back,
    Forward,
}

impl HistoryDirection {
    pub const fn step(self) -> i32 {
        match self {
            HistoryDirection::Back => -1,
            HistoryDirection::Forward => 1,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryItem {
    pub title: String,
    pub url: String,
    pub offset: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryMenu {
    pub tab: TabId,
    pub direction: HistoryDirection,
    pub items: Vec<HistoryItem>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwipeSurface {
    Toolbar,
    SidebarField,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PaneOverlayMsg {
    HoldNotice(bool),
    GoToNotice,
    ToggleHistory {
        tab: TabId,
        direction: HistoryDirection,
    },
    PickHistory {
        index: usize,
        mode: OpenMode,
    },
    ShowFullHistory,
    Reload(TabId),
    Unresponsive {
        tab: TabId,
        exit: bool,
    },
    StopProgramControl,
    DismissControlPill,
    Pager {
        phase: TouchPhase,
        dx: f32,
        dy: f32,
        precise: bool,
    },
    Swipe {
        phase: TouchPhase,
        dx: f32,
        dy: f32,
    },
    DropOnNewTab {
        tab: TabId,
        inputs: Vec<String>,
    },
}

pub const HISTORY_MAX: usize = 15;
pub const HISTORY_MENU_WIDTH: f32 = 300.0;
pub const STATUS_HEIGHT: f32 = 22.0;
pub const STATUS_MIN_WIDTH: f32 = 160.0;
pub const STATUS_FLIP_BAND: f64 = 48.0;

pub fn status_at_top(from_bottom: Option<f64>) -> bool {
    from_bottom.is_some_and(|distance| distance < STATUS_FLIP_BAND)
}
pub const STATUS_SHOW: Duration = Duration::from_millis(100);
pub const STATUS_HIDE: Duration = Duration::from_millis(250);
pub const STATUS_HIDE_DELAY: Duration = Duration::from_millis(180);
pub const LOADING_SHOW_AFTER: Duration = Duration::from_millis(150);
pub const LOADING_WIDTH: f32 = 140.0;
pub const LOADING_HEIGHT: f32 = 10.0;
pub const LOADING_TOP: f32 = 4.0;
pub const LOADING_LEAVE_SCALE: f32 = 0.55;
pub const LOADING_TRACK_WIDTH: f32 = 128.0;
pub const LOADING_TRACK_HEIGHT: f32 = 3.0;
pub const LOADING_SWEEP: Duration = Duration::from_millis(330);
pub const LOADING_REST: Duration = Duration::from_millis(330);
pub const LOADING_SHOW: Duration = Duration::from_millis(150);
pub const LOADING_HIDE: Duration = Duration::from_millis(250);
pub const NOTICE_HEIGHT: f32 = 28.0;
pub const NOTICE_RISE: f32 = 6.0;
pub const NOTICE_PRESSED_OPACITY: f32 = 0.7;
pub const NOTICE_REST_SCALE: f32 = 0.96;

pub fn notice_scale(appear: f32) -> f32 {
    NOTICE_REST_SCALE + (1.0 - NOTICE_REST_SCALE) * appear
}
pub const NOTICE_MOTION: Duration = Duration::from_millis(150);
pub const NOTICE_LASTS: Duration = Duration::from_millis(3500);
pub const TAB_SWIPE_DISTANCE: f32 = 16.0;
pub const HAIRLINE: f32 = 0.5;
const UNRESPONSIVE_WIDTH: f32 = 320.0;
const SAD_TAB_TEXT_WIDTH: f32 = 340.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowColors {
    pub status_fill: Hsla,
    pub status_border: Hsla,
    pub status_text: Hsla,
    pub notice_hover: Hsla,
    pub crashed_background: Hsla,
    pub frozen_wash: Hsla,
    pub status_shadow: Hsla,
}

fn rgb(r: u8, g: u8, b: u8, a: f32) -> Hsla {
    Hsla::from(Rgba {
        r: f32::from(r) / 255.0,
        g: f32::from(g) / 255.0,
        b: f32::from(b) / 255.0,
        a,
    })
}

pub fn window_colors(dark: bool) -> WindowColors {
    if dark {
        WindowColors {
            status_fill: rgb(40, 38, 39, 0.96),
            status_border: rgb(255, 255, 255, 0.12),
            status_text: rgb(255, 255, 255, f32::from(0xD9u8) / 255.0),
            notice_hover: rgb(255, 255, 255, 0.08),
            crashed_background: rgb(0x1C, 0x1A, 0x1B, 1.0),
            frozen_wash: rgb(0, 0, 0, 0.25),
            status_shadow: rgb(0, 0, 0, 0.3),
        }
    } else {
        WindowColors {
            status_fill: rgb(250, 249, 250, 0.97),
            status_border: rgb(0, 0, 0, 0.12),
            status_text: rgb(0, 0, 0, f32::from(0xC7u8) / 255.0),
            notice_hover: rgb(0, 0, 0, 0.05),
            crashed_background: rgb(0xF6, 0xF5, 0xF6, 1.0),
            frozen_wash: rgb(255, 255, 255, 0.4),
            status_shadow: rgb(0, 0, 0, 0.1),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HudShape {
    Capsule,
    Tile,
}

pub fn hud_radius(shape: HudShape, height: f32) -> f32 {
    match shape {
        HudShape::Capsule => height / 2.0,
        HudShape::Tile => radius::TILE,
    }
}

pub fn hud_plate(shape: HudShape, height: f32, dark: bool) -> gpui::Div {
    let colors = window_colors(dark);
    div()
        .rounded(px(hud_radius(shape, height)))
        .bg(colors.status_fill)
        .border(px(HAIRLINE))
        .border_color(colors.status_border)
        .shadow(vec![shadow(colors.status_shadow, 2.0, 12.0)])
}

pub fn hud(shape: HudShape, height: f32, dark: bool) -> gpui::Div {
    hud_plate(shape, height, dark).child(
        div()
            .h(px(height))
            .flex()
            .flex_row()
            .items_center()
            .when(shape == HudShape::Tile, |this| this.px(px(space::M))),
    )
}

pub fn hover_status(text: &str) -> String {
    let trimmed = text.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    for scheme in ["otpauth-migration:", "otpauth:"] {
        if lower.starts_with(scheme) {
            return scheme.to_owned();
        }
    }
    text.to_owned()
}

fn decode_uri(text: &str) -> String {
    const RESERVED: &[u8] = b";/?:@&=+$,#";
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if byte == b'%'
            && let Some(decoded) = bytes
                .get(at + 1..at + 3)
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            && !RESERVED.contains(&decoded)
        {
            out.push(decoded);
            at += 3;
            continue;
        }
        out.push(byte);
        at += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_owned())
}

pub fn status_display(url: &str) -> String {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    let shown = if lower.starts_with("http://") || lower.starts_with("https://") {
        url_for_display(url)
    } else {
        to_app_url(url)
    };
    decode_uri(&shown)
}

pub fn history_items(
    steps: &[NavigationStep],
    direction: HistoryDirection,
    max: usize,
) -> Vec<HistoryItem> {
    let Some(current) = steps.iter().position(|step| step.current) else {
        return Vec::new();
    };
    let step = direction.step();
    let mut items = Vec::new();
    let mut at = current as i64 + i64::from(step);
    while at >= 0 && (at as usize) < steps.len() && items.len() < max {
        let entry = &steps[at as usize];
        items.push(HistoryItem {
            title: if entry.title.is_empty() {
                entry.url.clone()
            } else {
                entry.title.clone()
            },
            url: entry.url.clone(),
            offset: (at - current as i64) as i32,
        });
        at += i64::from(step);
    }
    items
}

pub fn under_button(button_center: f32) -> f32 {
    let favicon_x = panel::INSET + (panel::ICON_SLOT - 16.0) / 2.0;
    (button_center - favicon_x - 2.0).max(panel::POPOVER_MARGIN)
}

pub fn fit_left(want: f32, room: f32, width: f32) -> f32 {
    want.min(room - width - space::M).max(space::M)
}

pub const MAX_DROPPED_TABS: usize = 50;

pub fn file_url(path: &std::path::Path) -> Option<String> {
    let text = path.to_str()?;
    if !text.starts_with('/') || text.starts_with("//") {
        return None;
    }
    let mut out = String::from("file://");
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~!$&'()*+,;=:@".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    Some(out)
}

pub fn dropped_urls(paths: &[std::path::PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| file_url(path))
        .take(MAX_DROPPED_TABS)
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DroppedEntry {
    File(String),
    Url(String),
    Text(String),
}

pub const MAX_SEARCH_TEXT: usize = 2048;
pub const MAX_LINK_FILE_SIZE: u64 = 64 * 1024;
const LINK_FILE_EXTENSIONS: [&str; 3] = ["webloc", "inetloc", "url"];

pub fn web_url(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.chars().count() >= 8192 || text.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (scheme, rest) = text.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or_default();
    let host = match host.strip_prefix('[') {
        Some(bracketed) => bracketed.split(']').next().unwrap_or_default(),
        None => host.split(':').next().unwrap_or_default(),
    };
    (!host.is_empty()).then(|| text.to_owned())
}

pub fn host_like(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() || text.chars().count() >= 2048 || text.chars().any(char::is_whitespace) {
        return None;
    }
    if let Some((scheme, _)) = text.split_once(':')
        && !scheme.is_empty()
        && !scheme.contains('.')
        && scheme
            .chars()
            .all(|c| c.is_alphanumeric() || "+.-".contains(c))
    {
        return web_url(text);
    }
    text.contains('.').then(|| text.to_owned())
}

pub fn link_file_target(name: &str, contents: &str) -> Option<String> {
    if name.to_ascii_lowercase().ends_with(".url") {
        return contents
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("url="))
            .and_then(|line| web_url(&line[4..]));
    }
    let after_key = contents.split("<key>URL</key>").nth(1)?;
    let value = after_key
        .trim_start()
        .strip_prefix("<string>")?
        .split("</string>")
        .next()?;
    web_url(&value.replace("&amp;", "&"))
}

fn is_link_file(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            LINK_FILE_EXTENSIONS
                .iter()
                .any(|l| ext.eq_ignore_ascii_case(l))
        })
}

fn read_link_file(path: &std::path::Path) -> Option<String> {
    let size = std::fs::metadata(path).ok()?.len();
    if size > MAX_LINK_FILE_SIZE {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let contents = String::from_utf8_lossy(&bytes);
    link_file_target(path.file_name()?.to_str()?, &contents)
}

pub fn dropped_file_entries(paths: &[std::path::PathBuf]) -> Vec<DroppedEntry> {
    paths
        .iter()
        .take(MAX_DROPPED_TABS)
        .filter_map(|path| {
            if is_link_file(path) {
                return read_link_file(path).map(DroppedEntry::Url);
            }
            path.exists()
                .then(|| file_url(path))
                .flatten()
                .map(DroppedEntry::File)
        })
        .collect()
}

pub fn dropped_entries(items: &gpui::ExternalItems, any_text: bool) -> Vec<DroppedEntry> {
    if !items.paths().is_empty() {
        return dropped_file_entries(items.paths());
    }
    let links: Vec<DroppedEntry> = items
        .urls()
        .iter()
        .filter_map(|url| web_url(url))
        .take(MAX_DROPPED_TABS)
        .map(DroppedEntry::Url)
        .collect();
    if !links.is_empty() {
        return links;
    }
    let Some(text) = items.text() else {
        return Vec::new();
    };
    if let Some(candidate) = host_like(text) {
        return vec![match web_url(&candidate) {
            Some(url) => DroppedEntry::Url(url),
            None => DroppedEntry::Text(candidate),
        }];
    }
    let words = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if any_text && !words.is_empty() {
        vec![DroppedEntry::Text(
            words.chars().take(MAX_SEARCH_TEXT).collect(),
        )]
    } else {
        Vec::new()
    }
}

pub fn dropped_inputs(entries: &[DroppedEntry]) -> Vec<String> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            DroppedEntry::File(url) => is_local_file_url(url).then(|| url.clone()),
            DroppedEntry::Url(raw) | DroppedEntry::Text(raw) => {
                let input = raw.trim();
                (!input.is_empty()).then(|| input.to_owned())
            }
        })
        .collect()
}

fn is_local_file_url(url: &str) -> bool {
    url.get(..8)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:///"))
        && url[8..].chars().next().is_some_and(|c| c != '/')
}

pub fn is_crx_input(input: &str) -> bool {
    is_local_file_url(input) && input.to_ascii_lowercase().ends_with(".crx")
}

pub fn new_tab_drop_area(body: AnyElement, tab: &TabId, emit: &Emit) -> AnyElement {
    let files_emit = emit.clone();
    let files_tab = tab.clone();
    let items_emit = emit.clone();
    let items_tab = tab.clone();
    div()
        .size_full()
        .on_drop(move |paths: &gpui::ExternalPaths, window, cx| {
            let inputs = dropped_inputs(&dropped_file_entries(paths.paths()));
            files_emit.send(
                Msg::PaneOverlay(PaneOverlayMsg::DropOnNewTab {
                    tab: files_tab.clone(),
                    inputs,
                }),
                window,
                cx,
            )
        })
        .on_drop(move |items: &gpui::ExternalItems, window, cx| {
            let inputs = dropped_inputs(&dropped_entries(items, true));
            items_emit.send(
                Msg::PaneOverlay(PaneOverlayMsg::DropOnNewTab {
                    tab: items_tab.clone(),
                    inputs,
                }),
                window,
                cx,
            )
        })
        .child(body)
        .into_any_element()
}

pub fn neighbour_tab(order: &[TabId], active: Option<&TabId>, delta: i32) -> Option<TabId> {
    let at = order.iter().position(|tab| Some(tab) == active)? as i64;
    let target = at + i64::from(delta);
    (target >= 0)
        .then(|| order.get(target as usize).cloned())
        .flatten()
}

#[derive(Clone, Debug, Default)]
struct StatusPresence {
    text: Option<String>,
    at_top: bool,
    appear: Option<Motion>,
    hide_at: Option<Instant>,
}

impl StatusPresence {
    fn sync(&mut self, status: Option<&str>, at_top: bool, now: Instant) -> bool {
        let appear = self.appear.get_or_insert(Motion::rest(0.0));
        match status.filter(|text| !text.is_empty()) {
            Some(text) => {
                self.hide_at = None;
                self.at_top = at_top;
                if self.text.as_deref() != Some(text) {
                    self.text = Some(text.to_owned());
                }
                if appear.target() < 1.0 {
                    appear.go(1.0, STATUS_SHOW, Curve::EaseOut, now);
                }
            }
            None if self.text.is_some() => {
                if appear.target() > 0.0 {
                    let hide_at = *self.hide_at.get_or_insert(now + STATUS_HIDE_DELAY);
                    if now >= hide_at {
                        appear.go(0.0, STATUS_HIDE, Curve::EaseInQuad, now);
                        self.hide_at = None;
                    }
                } else if !appear.running(now) {
                    self.text = None;
                }
            }
            None => {}
        }
        self.hide_at.is_some()
            || appear.running(now)
            || (self.text.is_some() && appear.target() == 0.0)
    }

    fn opacity(&self, now: Instant) -> f32 {
        self.appear.map_or(0.0, |appear| appear.value(now))
    }
}

#[derive(Clone, Debug, Default)]
struct LoadingPresence {
    loading_since: Option<Instant>,
    cycle_start: Option<Instant>,
    opacity: Option<Motion>,
    scale: Option<Motion>,
    leave_at: Option<Instant>,
    leaving: bool,
    reduce_motion: bool,
}

pub fn sweep_at(elapsed: Duration, reduce_motion: bool) -> f32 {
    let sweep = LOADING_SWEEP.as_secs_f32();
    let t = elapsed.as_secs_f32();
    if reduce_motion {
        return Curve::EaseInOutQuad.apply(t / sweep);
    }
    let period = 2.0 * sweep + LOADING_REST.as_secs_f32();
    let phase = t % period;
    if phase < sweep {
        Curve::EaseInOutQuad.apply(phase / sweep)
    } else if phase < 2.0 * sweep {
        1.0 + Curve::EaseInOutQuad.apply((phase - sweep) / sweep)
    } else {
        2.0
    }
}

pub fn sweep_offset(sweep: f32) -> f32 {
    (sweep - 1.0) * LOADING_TRACK_WIDTH
}

impl LoadingPresence {
    fn mounted(&self) -> bool {
        self.cycle_start.is_some()
    }

    fn sync(&mut self, loading: bool, reduce_motion: bool, now: Instant) -> bool {
        self.reduce_motion = reduce_motion;
        if loading {
            let since = *self.loading_since.get_or_insert(now);
            let lasting = now.saturating_duration_since(since) >= LOADING_SHOW_AFTER;
            if lasting && (!self.mounted() || self.leaving) {
                self.cycle_start = Some(now);
                self.leaving = false;
                self.leave_at = None;
                self.scale = Some(Motion::rest(1.0));
                let opacity = self.opacity.get_or_insert(Motion::rest(0.0));
                opacity.go(1.0, LOADING_SHOW, Curve::EaseOut, now);
            }
            return !lasting || self.mounted();
        }
        self.loading_since = None;
        let Some(start) = self.cycle_start else {
            return false;
        };
        if !self.leaving {
            let elapsed = now.saturating_duration_since(start);
            let period = 2 * LOADING_SWEEP + LOADING_REST;
            let into = if reduce_motion {
                elapsed.min(LOADING_SWEEP)
            } else {
                Duration::from_secs_f64(elapsed.as_secs_f64() % period.as_secs_f64())
            };
            let grows_for = LOADING_SWEEP.saturating_sub(into);
            self.leave_at = Some(
                now + if into < LOADING_SWEEP {
                    grows_for
                } else {
                    Duration::ZERO
                },
            );
            self.leaving = true;
        }
        if let Some(leave_at) = self.leave_at
            && now >= leave_at
        {
            self.leave_at = None;
            if let Some(opacity) = self.opacity.as_mut() {
                opacity.go(0.0, LOADING_HIDE, Curve::EaseInQuad, now);
            }
            if let Some(scale) = self.scale.as_mut() {
                scale.go(LOADING_LEAVE_SCALE, LOADING_HIDE, Curve::EaseInQuad, now);
            }
        }
        let fading = self.opacity.is_some_and(|opacity| opacity.running(now));
        if self.leave_at.is_none() && !fading {
            self.cycle_start = None;
            self.leaving = false;
            self.opacity = None;
            self.scale = None;
            return false;
        }
        true
    }

    fn sweep(&self, now: Instant) -> f32 {
        match self.cycle_start {
            Some(_) if self.leaving && self.leave_at.is_none() => 1.0,
            Some(start) => sweep_at(now.saturating_duration_since(start), self.reduce_motion),
            None => 0.0,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct NoticePresence {
    shown: Option<NewTabNotice>,
    live: bool,
    appear: Option<Motion>,
    deadline: Option<Instant>,
    held: bool,
    ended: HashSet<u64>,
}

impl NoticePresence {
    fn sync(&mut self, notice: Option<NewTabNotice>, now: Instant) -> bool {
        let notice = notice.filter(|notice| !self.ended.contains(&notice.id));
        if let (Some(deadline), Some(shown)) = (self.deadline, self.shown.as_ref())
            && !self.held
            && now >= deadline
            && self.live
        {
            self.ended.insert(shown.id);
        }
        let notice = notice.filter(|notice| !self.ended.contains(&notice.id));
        let appear = self.appear.get_or_insert(Motion::rest(0.0));
        match notice {
            Some(notice) => {
                if self.shown.as_ref().map(|shown| shown.id) != Some(notice.id) {
                    self.deadline = Some(now + NOTICE_LASTS);
                    self.held = false;
                }
                self.shown = Some(notice);
                self.live = true;
                if appear.target() < 1.0 {
                    appear.go(1.0, NOTICE_MOTION, Curve::EaseOut, now);
                }
            }
            None => {
                self.live = false;
                self.deadline = None;
                if appear.target() > 0.0 {
                    appear.go(0.0, NOTICE_MOTION, Curve::EaseInQuad, now);
                } else if !appear.running(now) {
                    self.shown = None;
                }
            }
        }
        appear.running(now) || (self.live && !self.held) || (!self.live && self.shown.is_some())
    }

    fn hold(&mut self, held: bool, now: Instant) {
        if !self.live || self.held == held {
            return;
        }
        self.held = held;
        if !held {
            self.deadline = Some(now + NOTICE_LASTS);
        }
    }
}

#[derive(Clone, Debug, Default)]
struct ControlPresence {
    shown: Option<ProgramControl>,
    seen_runs: Option<u64>,
    live: bool,
    hide_at: Option<Instant>,
    appear: Option<Motion>,
}

impl ControlPresence {
    fn sync(&mut self, control: &ProgramControl, now: Instant) -> bool {
        let appear = self.appear.get_or_insert(Motion::rest(0.0));
        let ran = self.seen_runs.is_some_and(|seen| seen != control.runs);
        self.seen_runs = Some(control.runs);
        if control.connected || ran {
            self.hide_at = (!control.connected).then_some(now + CONTROL_HOLD);
            self.live = true;
            let keep_caller = self
                .shown
                .as_ref()
                .and_then(|shown| shown.caller.clone())
                .filter(|_| control.caller.is_none());
            self.shown = Some(ProgramControl {
                caller: control.caller.clone().or(keep_caller),
                ..control.clone()
            });
        } else if self.live {
            let hide_at = *self.hide_at.get_or_insert(now + CONTROL_HOLD);
            if now >= hide_at {
                self.live = false;
                self.hide_at = None;
            }
        }
        let wanted = self.live && !control.hidden;
        if wanted && appear.target() < 1.0 {
            appear.go(1.0, CONTROL_PILL_MOTION, Curve::EaseOut, now);
        } else if !wanted && appear.target() > 0.0 {
            appear.go(0.0, CONTROL_PILL_MOTION, Curve::EaseInQuad, now);
        } else if !self.live && self.shown.is_some() && !appear.running(now) {
            self.shown = None;
        }
        if let Some(shown) = self.shown.as_mut() {
            shown.compact = control.compact;
            shown.hidden = control.hidden;
        }
        self.hide_at.is_some() || appear.running(now) || (!self.live && self.shown.is_some())
    }

    fn dismissed(&mut self, now: Instant) {
        if self.hide_at.is_some() {
            self.live = false;
            self.hide_at = None;
        }
        if let Some(appear) = self.appear.as_mut()
            && appear.target() > 0.0
        {
            appear.go(0.0, CONTROL_PILL_MOTION, Curve::EaseInQuad, now);
        }
    }

    fn interactive(&self) -> bool {
        self.live && self.shown.as_ref().is_some_and(|shown| !shown.hidden)
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct SwipeTrack {
    distance: f32,
    stepped: bool,
}

#[derive(Clone, Debug, Default)]
pub struct PaneOverlays {
    status: StatusPresence,
    loading: LoadingPresence,
    notice: NoticePresence,
    history: Option<HistoryMenu>,
    swipe: SwipeTrack,
    empty_cards: HashSet<TabId>,
    control: ControlPresence,
}

pub fn shows_empty_card(state: &BrowserState, tab: &ardia_state::tabs::Tab) -> bool {
    state.hidden_empty_card(tab)
}

#[derive(Clone, Debug, PartialEq)]
pub struct OverlayInput<'a> {
    pub overlay: &'a PageOverlay,
    pub loading: bool,
    pub reduce_motion: bool,
    pub notice: Option<NewTabNotice>,
    pub control: ProgramControl,
}

pub fn shown_notice(
    state: &BrowserState,
    window: &str,
    active: Option<&TabId>,
    notice: Option<NewTabNotice>,
) -> Option<NewTabNotice> {
    notice.filter(|notice| {
        Some(&notice.source) == active
            && Some(&notice.tab) != active
            && state
                .tab(notice.tab.as_str())
                .is_some_and(|tab| tab.window_id.as_str() == window)
    })
}

impl PaneOverlays {
    pub fn sync(&mut self, input: OverlayInput<'_>, now: Instant) -> bool {
        let status = self.status.sync(
            input.overlay.status.as_deref(),
            input.overlay.status_at_top,
            now,
        );
        let loading = self.loading.sync(input.loading, input.reduce_motion, now);
        let notice = self.notice.sync(input.notice, now);
        let control = self.control.sync(&input.control, now);
        status || loading || notice || control
    }

    pub fn first_time_over_empty_card(&mut self, tab: &TabId) -> bool {
        self.empty_cards.insert(tab.clone())
    }

    pub fn history_open(&self) -> bool {
        self.history.is_some()
    }

    pub fn history(&self) -> Option<&HistoryMenu> {
        self.history.as_ref()
    }

    pub fn close_history(&mut self) -> bool {
        self.history.take().is_some()
    }

    pub fn close_history_of(&mut self, tab: Option<&TabId>) -> bool {
        if self
            .history
            .as_ref()
            .is_some_and(|menu| Some(&menu.tab) != tab)
        {
            self.history = None;
            return true;
        }
        false
    }

    pub fn handle(
        &mut self,
        msg: PaneOverlayMsg,
        host: &Arc<dyn UiHost>,
        state: &BrowserState,
        window: &WindowId,
        order: &[TabId],
        now: Instant,
    ) -> Option<&'static str> {
        match msg {
            PaneOverlayMsg::HoldNotice(held) => self.notice.hold(held, now),
            PaneOverlayMsg::GoToNotice => {
                if let Some(notice) = self.notice.shown.clone().filter(|_| self.notice.live) {
                    self.notice.ended.insert(notice.id);
                    if state.tab(notice.tab.as_str()).is_some() {
                        host.dispatch(Action::ActivateTab { tab: notice.tab });
                    }
                }
            }
            PaneOverlayMsg::ToggleHistory { tab, direction } => {
                if self
                    .history
                    .as_ref()
                    .is_some_and(|menu| menu.tab == tab && menu.direction == direction)
                {
                    self.history = None;
                } else {
                    let items = history_items(&host.navigation_steps(&tab), direction, HISTORY_MAX);
                    self.history = (!items.is_empty()).then_some(HistoryMenu {
                        tab,
                        direction,
                        items,
                    });
                }
            }
            PaneOverlayMsg::PickHistory { index, mode } => {
                let menu = self.history.clone()?;
                let item = menu.items.get(index)?;
                if matches!(mode, OpenMode::Current | OpenMode::Split) || item.url.is_empty() {
                    self.history = None;
                    match item.offset {
                        -1 => host.go_back(menu.tab.clone()),
                        1 => host.go_forward(menu.tab.clone()),
                        0 => {}
                        offset => host.go_to_offset(menu.tab.clone(), offset),
                    }
                } else {
                    if mode != OpenMode::Background {
                        self.history = None;
                    }
                    open_url(host, window, &menu.tab, &item.url, mode);
                }
            }
            PaneOverlayMsg::ShowFullHistory => {
                self.history = None;
                return Some("showHistory");
            }
            PaneOverlayMsg::Reload(tab) => host.recover_crashed_page(tab),
            PaneOverlayMsg::StopProgramControl => host.stop_program_control(),
            PaneOverlayMsg::DismissControlPill => {
                self.control.dismissed(now);
                host.dismiss_control_pill();
            }
            PaneOverlayMsg::Pager { .. } => {}
            PaneOverlayMsg::Unresponsive { tab, exit } => host.resolve_unresponsive(tab, exit),
            PaneOverlayMsg::DropOnNewTab { tab, inputs } => {
                let listed = state
                    .tab(tab.as_str())
                    .filter(|listed| listed.url.is_empty())?;
                let mut urls = inputs.into_iter().filter(|input| !is_crx_input(input));
                let first = urls.next()?;
                host.navigate(window.clone(), tab.clone(), first);
                let mut previous = tab.clone();
                for url in urls {
                    let after = host
                        .store()
                        .snapshot()
                        .window(listed.window_id.as_str())
                        .and_then(|w| w.tab_ids.iter().position(|id| *id == previous))
                        .map(|at| at + 1);
                    let outcome = host.store().dispatch(Action::NewTab {
                        window: listed.window_id.clone(),
                        tab: ardia_state::NewTab {
                            url: Some(url),
                            profile: Some(listed.profile_id.clone()),
                            background: true,
                            index: after,
                            ..ardia_state::NewTab::default()
                        },
                    });
                    if let Some(created) = outcome.ok().and_then(|outcome| outcome.tab) {
                        previous = created;
                    }
                }
            }
            PaneOverlayMsg::Swipe { phase, dx, dy } => {
                if phase == TouchPhase::Started {
                    self.swipe = SwipeTrack::default();
                }
                if self.swipe.stepped || dx.abs() <= dy.abs() {
                    return None;
                }
                self.swipe.distance += dx;
                if self.swipe.distance.abs() >= TAB_SWIPE_DISTANCE {
                    self.swipe.stepped = true;
                    let delta = if self.swipe.distance > 0.0 { -1 } else { 1 };
                    let active = state.active_tab(window.as_str()).map(|tab| tab.id.clone());
                    if let Some(tab) = neighbour_tab(order, active.as_ref(), delta) {
                        host.dispatch(Action::ActivateTab { tab });
                    }
                }
            }
        }
        None
    }

    pub fn render(
        &self,
        c: &Chrome,
        page: Rect,
        tab: &TabId,
        overlay: &PageOverlay,
        now: Instant,
    ) -> Vec<AnyElement> {
        let mut out = Vec::new();
        if let Some(text) = self.status.text.as_ref() {
            out.push(status_bubble(
                c,
                page,
                text,
                self.status.at_top,
                self.status.opacity(now),
            ));
        }
        if overlay.crashed {
            out.push(crashed_page(c, page, tab));
        } else if overlay.unresponsive {
            out.push(unresponsive_dialog(c, page, tab));
        }
        if self.loading.mounted() {
            let opacity = self.loading.opacity.map_or(1.0, |o| o.value(now));
            let scale = self.loading.scale.map_or(1.0, |s| s.value(now));
            out.push(loading_pill(
                c,
                page,
                opacity,
                scale,
                self.loading.sweep(now),
            ));
        }
        if let Some(control) = self.control.shown.as_ref() {
            let appear = self.control.appear.map_or(0.0, |a| a.value(now));
            if appear > 0.0 {
                out.push(control_pill(
                    c,
                    page,
                    control,
                    appear,
                    self.control.interactive(),
                ));
            }
        }
        if let Some(notice) = self.notice.shown.as_ref() {
            let appear = self.notice.appear.map_or(0.0, |a| a.value(now));
            out.push(new_tab_notice(
                c,
                page,
                notice,
                appear,
                self.notice.live,
                self.notice.live && self.notice.held,
            ));
        }
        out
    }

    pub fn render_history(
        &self,
        c: &Chrome,
        page: Rect,
        back: f32,
        forward: f32,
    ) -> Option<AnyElement> {
        let menu = self.history.as_ref()?;
        let want = if c.layout.toolbar > 0.0 {
            under_button(match menu.direction {
                HistoryDirection::Back => back,
                HistoryDirection::Forward => forward,
            })
        } else if c.layout.trailing {
            f32::INFINITY
        } else {
            f32::NEG_INFINITY
        };
        let left = fit_left(want, page.w, HISTORY_MENU_WIDTH);
        Some(history_popover(
            c,
            menu,
            page.x + left,
            page.y + panel::POPOVER_MARGIN,
        ))
    }
}

fn status_bubble(c: &Chrome, page: Rect, text: &str, at_top: bool, opacity: f32) -> AnyElement {
    let colors = window_colors(c.look.dark);
    let max_width = STATUS_MIN_WIDTH.max(page.w / 2.0);
    div()
        .id("status-bubble")
        .debug_selector(|| "status-bubble".into())
        .absolute()
        .left(px(page.x + space::S))
        .top(px(if at_top {
            page.y + space::S
        } else {
            page.y + page.h - space::S - STATUS_HEIGHT - 2.0 * HAIRLINE
        }))
        .max_w(px(max_width))
        .opacity(opacity)
        .child(
            hud_plate(HudShape::Tile, STATUS_HEIGHT, c.look.dark).child(
                div()
                    .h(px(STATUS_HEIGHT))
                    .px(px(space::M))
                    .flex()
                    .items_center()
                    .text_size(px(12.0))
                    .text_color(colors.status_text)
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis_middle()
                    .child(SharedString::from(status_display(text))),
            ),
        )
        .into_any_element()
}

fn pane_corners(div: gpui::Div, c: &Chrome) -> gpui::Div {
    let corner = px(c.layout.frame.radius);
    if c.layout.toolbar > 0.0 {
        div.rounded_bl(corner).rounded_br(corner)
    } else {
        div.rounded(corner)
    }
}

fn crashed_page(c: &Chrome, page: Rect, tab: &TabId) -> AnyElement {
    let p = c.p;
    let colors = window_colors(c.look.dark);
    pane_corners(
        div()
            .absolute()
            .left(px(page.x))
            .top(px(page.y))
            .w(px(page.w))
            .h(px(page.h))
            .bg(colors.crashed_background)
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .p(px(space::XXXL)),
        c,
    )
    .debug_selector(|| "sad-tab".into())
    .child(
        div()
            .w(px(44.0))
            .h(px(40.0))
            .mb(px(space::XL))
            .flex()
            .items_center()
            .justify_center()
            .child(icon(Icon::Warning, 30.0, p.text_secondary)),
    )
    .child(
        div()
            .mb(px(space::S))
            .text_size(px(17.0))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(p.text)
            .child("This tab needs to reload"),
    )
    .child(
        div()
            .max_w(px(SAD_TAB_TEXT_WIDTH))
            .mb(px(space::XL))
            .text_size(px(13.0))
            .text_center()
            .text_color(p.text_secondary)
            .child("Something went wrong with this tab. Reloading often fixes it."),
    )
    .child(
        PushButton::new("sad-tab-reload", "Reload", p)
            .kind(ButtonKind::Primary)
            .on_click(
                c.emit
                    .click(Msg::PaneOverlay(PaneOverlayMsg::Reload(tab.clone()))),
            ),
    )
    .into_any_element()
}

fn unresponsive_dialog(c: &Chrome, page: Rect, tab: &TabId) -> AnyElement {
    let p = c.p;
    div()
        .id("unresponsive")
        .debug_selector(|| "page-unresponsive".into())
        .absolute()
        .left(px(page.x))
        .top(px(page.y))
        .w(px(page.w))
        .h(px(page.h))
        .occlude()
        .bg(p.scrim)
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .w(px(UNRESPONSIVE_WIDTH))
                .p(px(space::XL))
                .rounded(px(radius::SHEET))
                .bg(p.popover_fill)
                .border(px(HAIRLINE))
                .border_color(p.popover_border)
                .shadow(vec![shadow(p.shadow, 10.0, 48.0)])
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(15.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.text)
                        .child("Page Unresponsive"),
                )
                .child(
                    div()
                        .mt(px(space::S))
                        .text_size(px(12.0))
                        .text_color(p.text_secondary)
                        .child("You can wait for it to become responsive or exit the page."),
                )
                .child(
                    div()
                        .mt(px(space::XL))
                        .flex()
                        .justify_end()
                        .gap(px(space::M))
                        .child(
                            PushButton::new("unresponsive-exit", "Exit Page", p).on_click(
                                c.emit.click(Msg::PaneOverlay(PaneOverlayMsg::Unresponsive {
                                    tab: tab.clone(),
                                    exit: true,
                                })),
                            ),
                        )
                        .child(
                            PushButton::new("unresponsive-wait", "Wait", p)
                                .kind(ButtonKind::Primary)
                                .on_click(c.emit.click(Msg::PaneOverlay(
                                    PaneOverlayMsg::Unresponsive {
                                        tab: tab.clone(),
                                        exit: false,
                                    },
                                ))),
                        ),
                ),
        )
        .into_any_element()
}

fn loading_pill(c: &Chrome, page: Rect, opacity: f32, scale: f32, sweep: f32) -> AnyElement {
    let p = c.p;
    let width = (LOADING_WIDTH + 2.0 * HAIRLINE) * scale;
    let height = (LOADING_HEIGHT + 2.0 * HAIRLINE) * scale;
    let track = LOADING_TRACK_WIDTH * scale;
    let thickness = LOADING_TRACK_HEIGHT * scale;
    let top = page.y + LOADING_TOP + (LOADING_HEIGHT + 2.0 * HAIRLINE - height) / 2.0;
    div()
        .absolute()
        .debug_selector(|| "loading-pill".into())
        .left(px(page.x + (page.w - width) / 2.0))
        .top(px(top))
        .opacity(opacity)
        .child(
            hud_plate(HudShape::Capsule, height, c.look.dark)
                .w(px(width))
                .h(px(height))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .relative()
                        .w(px(track))
                        .h(px(thickness))
                        .rounded(px(thickness / 2.0))
                        .overflow_hidden()
                        .child(div().absolute().inset_0().bg(p.progress_track.opacity(0.4)))
                        .child(
                            div()
                                .absolute()
                                .top_0()
                                .left(px(sweep_offset(sweep) * scale))
                                .w(px(track))
                                .h(px(thickness))
                                .bg(p.text.opacity(0.8)),
                        ),
                ),
        )
        .into_any_element()
}

fn new_tab_notice(
    c: &Chrome,
    page: Rect,
    notice: &NewTabNotice,
    appear: f32,
    live: bool,
    hovered: bool,
) -> AnyElement {
    let p = c.p;
    let colors = window_colors(c.look.dark);
    let hold = c.emit.clone();
    let id = SharedString::from(format!("new-tab-notice-{}", notice.id));
    div()
        .absolute()
        .right(px(c.layout.width - page.x - page.w + panel::POPOVER_MARGIN))
        .top(px(
            page.y + panel::POPOVER_MARGIN - NOTICE_RISE * (1.0 - appear)
        ))
        .opacity(appear)
        .when(appear < 1.0, |this| this.scale(notice_scale(appear)))
        .child(
            hud_plate(HudShape::Capsule, NOTICE_HEIGHT, c.look.dark).child(
                div()
                    .id(id)
                    .debug_selector(|| "new-tab-notice".into())
                    .h(px(NOTICE_HEIGHT))
                    .px(px(space::L))
                    .rounded(px(NOTICE_HEIGHT / 2.0))
                    .flex()
                    .items_center()
                    .gap(px(space::S))
                    .text_size(px(12.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.text)
                    .when(live, |this| {
                        this.cursor_pointer()
                            .hover(move |style| style.bg(colors.notice_hover))
                            .active(|style| style.opacity(NOTICE_PRESSED_OPACITY))
                            .on_hover(move |hovered, window, cx| {
                                hold.send(
                                    Msg::PaneOverlay(PaneOverlayMsg::HoldNotice(*hovered)),
                                    window,
                                    cx,
                                )
                            })
                            .on_click(c.emit.click(Msg::PaneOverlay(PaneOverlayMsg::GoToNotice)))
                    })
                    .child(
                        div()
                            .size(px(14.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(Icon::PlusSquareOnSquare, 12.0, p.icon)),
                    )
                    .child(div().whitespace_nowrap().child("New tab opened"))
                    .child(
                        div()
                            .size(px(14.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(
                                Icon::ArrowRight,
                                10.0,
                                if hovered { p.text } else { p.text_secondary },
                            )),
                    ),
            ),
        )
        .into_any_element()
}

fn control_pill(
    c: &Chrome,
    page: Rect,
    control: &ProgramControl,
    appear: f32,
    live: bool,
) -> AnyElement {
    let p = *c.p;
    let (lead, name, rest) = control_line(control.caller.as_ref());
    let line = format!("{lead}{name}{rest}");
    let row =
        div()
            .id("control-pill-row")
            .h(px(CONTROL_PILL_HEIGHT))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(if control.compact { space::S } else { space::M }))
            .pl(px(space::S))
            .pr(px(space::XS))
            .child(
                div()
                    .id("control-pill-icon")
                    .size(px(CONTROL_DOT))
                    .flex_none()
                    .rounded_full()
                    .bg(p.text)
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(control.compact, |this| {
                        this.tooltip(crate::primitives::controls::tooltip(
                            SharedString::from(line.clone()),
                            &p,
                        ))
                    })
                    .child(icon(Icon::Command, 9.0, p.on_go)),
            )
            .when(!control.compact, |this| {
                this.child(
                    div()
                        .flex_none()
                        .max_w(px((page.w - 120.0).max(0.0)))
                        .overflow_hidden()
                        .flex()
                        .flex_row()
                        .whitespace_nowrap()
                        .text_size(px(12.0))
                        .text_color(p.text_secondary)
                        .child(SharedString::from(lead))
                        .child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(p.text_secondary)
                                .child(SharedString::from(name)),
                        )
                        .child(SharedString::from(rest)),
                )
            })
            .child(
                div()
                    .flex_none()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(space::S))
                    .child(
                        div()
                            .id("control-pill-stop")
                            .debug_selector(|| "control-pill-stop".into())
                            .h(px(24.0))
                            .px(px(space::ML))
                            .rounded(px(12.0))
                            .flex()
                            .items_center()
                            .bg(p.chip_fill)
                            .border(px(HAIRLINE))
                            .border_color(p.chip_border)
                            .text_size(px(12.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(p.chip_text)
                            .when(live, |this| {
                                this.cursor_pointer()
                                    .hover(move |style| style.bg(p.control_hover))
                                    .active(move |style| style.bg(p.control_pressed))
                                    .on_click(c.emit.click(Msg::PaneOverlay(
                                        PaneOverlayMsg::StopProgramControl,
                                    )))
                            })
                            .child("Stop"),
                    )
                    .child(
                        div().debug_selector(|| "control-pill-hide".into()).child(
                            crate::primitives::controls::IconButton::new(
                                "control-pill-hide",
                                Icon::XMark,
                                c.p,
                            )
                            .size(ardia_theme::tokens::icon_button::M)
                            .capsule()
                            .color(p.text_secondary)
                            .disabled(!live)
                            .tooltip("Hide control pill", c.p)
                            .on_click({
                                let emit = c.emit.clone();
                                move |_, window, cx| {
                                    emit.send(
                                        Msg::PaneOverlay(PaneOverlayMsg::DismissControlPill),
                                        window,
                                        cx,
                                    )
                                }
                            }),
                        ),
                    ),
            );
    div()
        .absolute()
        .debug_selector(|| "control-pill".into())
        .left(px(page.x + space::L))
        .w(px((page.w - 2.0 * space::L).max(0.0)))
        .top(px(page.y + page.h
            - CONTROL_PILL_BOTTOM
            - CONTROL_PILL_HEIGHT
            + 8.0 * (1.0 - appear)))
        .flex()
        .justify_center()
        .opacity(appear)
        .child(
            hud_plate(HudShape::Capsule, CONTROL_PILL_HEIGHT, c.look.dark)
                .max_w_full()
                .child(row),
        )
        .into_any_element()
}

fn history_open_mode(event: &ClickEvent) -> OpenMode {
    let modifiers = event.modifiers();
    open_mode_for(modifiers.platform, modifiers.shift, modifiers.alt, false)
}

fn history_popover(c: &Chrome, menu: &HistoryMenu, left: f32, top: f32) -> AnyElement {
    let p = *c.p;
    let profile = c.window.profile_id.clone();
    let history = c.state.history_of(&profile).cloned();
    let rows = menu.items.iter().enumerate().map(|(index, item)| {
        let favicon_url = history
            .as_ref()
            .and_then(|history| history.get(&item.url))
            .and_then(|entry| entry.favicon.clone());
        let favicon = resolve_favicon(
            favicon_of(&item.url, favicon_url.as_deref(), None, &item.title),
            c.host.as_ref(),
            &profile,
        );
        let emit = c.emit.clone();
        let middle = c.emit.clone();
        div()
            .px(px(panel::ROW_INSET))
            .child(
                div()
                    .id(SharedString::from(format!("history-item-{index}")))
                    .debug_selector(move || format!("history-item-{index}"))
                    .h(px(panel::ROW_HEIGHT))
                    .px(px(panel::ROW_PADDING))
                    .rounded(px(panel::ROW_RADIUS))
                    .flex()
                    .items_center()
                    .gap(px(panel::ICON_GAP))
                    .text_size(px(13.0))
                    .text_color(p.text)
                    .cursor_pointer()
                    .map(|this| {
                        if c.look.glass {
                            this.relative()
                                .group(GLASS_CONTROL_GROUP)
                                .child(stateful_glass(
                                    c.look,
                                    panel::ROW_RADIUS,
                                    GlassStates::ROW,
                                    GlassBacking::Surface,
                                ))
                        } else {
                            this.hover(move |style| style.bg(p.menu_hover))
                                .active(move |style| style.bg(p.popover_row_pressed))
                        }
                    })
                    .when(!item.url.is_empty(), |this| {
                        this.tooltip(crate::primitives::controls::tooltip(
                            SharedString::from(item.url.clone()),
                            &p,
                        ))
                    })
                    .on_click(move |event, window, cx| {
                        cx.stop_propagation();
                        emit.send(
                            Msg::PaneOverlay(PaneOverlayMsg::PickHistory {
                                index,
                                mode: history_open_mode(event),
                            }),
                            window,
                            cx,
                        );
                    })
                    .on_mouse_down(MouseButton::Middle, move |event, window, cx| {
                        cx.stop_propagation();
                        let modifiers = event.modifiers;
                        middle.send(
                            Msg::PaneOverlay(PaneOverlayMsg::PickHistory {
                                index,
                                mode: open_mode_for(
                                    modifiers.platform,
                                    modifiers.shift,
                                    modifiers.alt,
                                    true,
                                ),
                            }),
                            window,
                            cx,
                        );
                    })
                    .child(
                        div()
                            .w(px(panel::ICON_SLOT))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(render_favicon(&favicon, 16.0, &p)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .child(SharedString::from(item.title.clone())),
                    ),
            )
            .into_any_element()
    });
    div()
        .absolute()
        .left(px(left))
        .top(px(top))
        .child(crate::primitives::appear::rise(
            "history-menu-in",
            popover("history-menu", false, HISTORY_MENU_WIDTH, &p)
                .debug_selector(|| "history-menu".into())
                .children(rows)
                .child(separator(&p))
                .child(
                    MenuRow::new("history-show-all", "Show Full History", &p)
                        .icon(Icon::Clock)
                        .when(c.look.glass, |row| {
                            row.glass_fill(stateful_glass(
                                c.look,
                                panel::ROW_RADIUS,
                                GlassStates::ROW,
                                GlassBacking::Surface,
                            ))
                        })
                        .on_click(
                            c.emit
                                .click(Msg::PaneOverlay(PaneOverlayMsg::ShowFullHistory)),
                        ),
                ),
            crate::primitives::appear::Rise::popover(
                crate::primitives::appear::OriginX::Left,
                false,
            ),
        ))
        .into_any_element()
}

pub fn pager_handler(emit: &Emit) -> impl Fn(&ScrollEvent, &mut Window, &mut App) + 'static {
    let emit = emit.clone();
    move |event, window, cx| {
        let (dx, dy, precise) = match event.delta {
            ScrollDelta::Pixels(delta) => (
                crate::scale::points(delta.x),
                crate::scale::points(delta.y),
                true,
            ),
            ScrollDelta::Lines(lines) => (lines.x, lines.y, false),
        };
        if !precise && dx.abs() <= dy.abs() {
            return;
        }
        emit.send(
            Msg::PaneOverlay(PaneOverlayMsg::Pager {
                phase: event.touch_phase,
                dx,
                dy,
                precise,
            }),
            window,
            cx,
        );
    }
}

pub fn tab_swipe_handler(
    emit: &Emit,
    enabled: bool,
) -> impl Fn(&ScrollEvent, &mut Window, &mut App) + 'static {
    let emit = emit.clone();
    move |event, window, cx| {
        if !enabled {
            return;
        }
        let ScrollDelta::Pixels(delta) = event.delta else {
            return;
        };
        emit.send(
            Msg::PaneOverlay(PaneOverlayMsg::Swipe {
                phase: event.touch_phase,
                dx: crate::scale::points(delta.x),
                dy: crate::scale::points(delta.y),
            }),
            window,
            cx,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(url: &str, title: &str, current: bool) -> NavigationStep {
        NavigationStep {
            url: url.to_owned(),
            title: title.to_owned(),
            current,
        }
    }

    #[test]
    fn history_items_walk_away_from_the_current_entry_and_stop_at_the_cap() {
        let steps = vec![
            step("https://a.test/", "A", false),
            step("https://b.test/", "", false),
            step("https://c.test/", "C", true),
            step("https://d.test/", "D", false),
        ];
        let back = history_items(&steps, HistoryDirection::Back, HISTORY_MAX);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].title, "https://b.test/");
        assert_eq!(back[0].offset, -1);
        assert_eq!(back[1].offset, -2);
        let forward = history_items(&steps, HistoryDirection::Forward, HISTORY_MAX);
        assert_eq!(forward.len(), 1);
        assert_eq!(forward[0].offset, 1);
        assert_eq!(history_items(&steps, HistoryDirection::Back, 1).len(), 1);
        assert!(history_items(&[step("x", "x", false)], HistoryDirection::Back, 5).is_empty());
    }

    #[test]
    fn the_history_menu_sits_under_its_button_and_inside_the_pane() {
        assert_eq!(under_button(60.0), 40.0);
        assert_eq!(under_button(10.0), panel::POPOVER_MARGIN);
        assert_eq!(fit_left(f32::NEG_INFINITY, 800.0, 300.0), 8.0);
        assert_eq!(fit_left(f32::INFINITY, 800.0, 300.0), 492.0);
    }

    #[test]
    fn the_status_flips_up_within_48pt_of_the_page_bottom() {
        assert!(status_at_top(Some(10.0)));
        assert!(!status_at_top(Some(48.0)));
        assert!(!status_at_top(None));
    }

    #[test]
    fn hover_status_hides_secret_links() {
        assert_eq!(hover_status("otpauth://totp/Site:me?secret=JB"), "otpauth:");
        assert_eq!(
            hover_status("OTPAUTH-MIGRATION://offline?data=AB"),
            "otpauth-migration:"
        );
        assert_eq!(
            hover_status("https://site.example/otpauth://x"),
            "https://site.example/otpauth://x"
        );
        assert_eq!(hover_status(""), "");
    }

    #[test]
    fn status_text_reads_like_the_address_bar() {
        assert_eq!(
            status_display("https://www.example.com/a%20b"),
            "example.com/a b"
        );
        assert_eq!(
            status_display("https://example.com/a%2Fb"),
            "example.com/a%2Fb"
        );
        assert_eq!(
            status_display("https://example.com/%E0%A4"),
            "example.com/%E0%A4"
        );
    }

    #[test]
    fn status_appears_fast_and_lingers_before_fading() {
        let start = Instant::now();
        let mut status = StatusPresence::default();
        assert!(status.sync(Some("https://a.test/"), false, start));
        assert_eq!(status.opacity(start + STATUS_SHOW), 1.0);
        let gone = start + Duration::from_secs(1);
        assert!(status.sync(None, false, gone));
        assert_eq!(status.opacity(gone), 1.0);
        let fading = gone + STATUS_HIDE_DELAY;
        status.sync(None, false, fading);
        assert!(status.opacity(fading + STATUS_HIDE / 2) < 1.0);
        let done = fading + STATUS_HIDE;
        status.sync(None, false, done);
        assert!(!status.sync(None, false, done + Duration::from_millis(1)));
        assert!(status.text.is_none());
    }

    #[test]
    fn short_loads_never_show_the_pill() {
        let start = Instant::now();
        let mut pill = LoadingPresence::default();
        assert!(pill.sync(true, false, start));
        assert!(!pill.mounted());
        assert!(!pill.sync(false, false, start + Duration::from_millis(100)));
        assert!(!pill.mounted());
    }

    #[test]
    fn a_lasting_load_sweeps_then_finishes_its_grow_before_shrinking() {
        let start = Instant::now();
        let mut pill = LoadingPresence::default();
        pill.sync(true, false, start);
        let shown = start + LOADING_SHOW_AFTER;
        pill.sync(true, false, shown);
        assert!(pill.mounted());
        assert_eq!(pill.sweep(shown), 0.0);
        let mid_grow = shown + Duration::from_millis(165);
        pill.sync(true, false, mid_grow);
        let stopped = mid_grow;
        assert!(pill.sync(false, false, stopped));
        assert!(pill.leave_at.is_some());
        let left = stopped + Duration::from_millis(165);
        pill.sync(false, false, left);
        assert_eq!(pill.sweep(left), 1.0);
        let scale = pill
            .scale
            .map(|s| s.value(left + LOADING_HIDE))
            .unwrap_or(1.0);
        assert!((scale - LOADING_LEAVE_SCALE).abs() < 1e-4);
        pill.sync(false, false, left + LOADING_HIDE);
        assert!(!pill.mounted());
    }

    #[test]
    fn the_sweep_grows_wipes_and_rests() {
        assert_eq!(sweep_at(Duration::ZERO, false), 0.0);
        assert!((sweep_at(LOADING_SWEEP, false) - 1.0).abs() < 1e-3);
        assert!((sweep_at(LOADING_SWEEP * 2 - Duration::from_millis(1), false) - 2.0).abs() < 1e-2);
        assert_eq!(
            sweep_at(LOADING_SWEEP * 2 + Duration::from_millis(100), false),
            2.0
        );
        assert_eq!(sweep_at(Duration::from_secs(5), true), 1.0);
        assert_eq!(sweep_offset(0.0), -LOADING_TRACK_WIDTH);
        assert_eq!(sweep_offset(2.0), LOADING_TRACK_WIDTH);
    }

    #[test]
    fn the_control_pill_holds_three_seconds_after_the_last_run() {
        let start = Instant::now();
        let mut pill = ControlPresence::default();
        let on = ProgramControl {
            connected: true,
            runs: 0,
            caller: Some(ControlCaller {
                name: "Agent".into(),
                app: None,
            }),
            compact: false,
            hidden: false,
        };
        pill.sync(&on, start);
        assert!(pill.live);
        let off = ProgramControl::default();
        pill.sync(&off, start + Duration::from_secs(1));
        assert!(pill.live);
        pill.sync(&off, start + Duration::from_secs(1) + CONTROL_HOLD);
        assert!(!pill.live);
        assert_eq!(
            pill.shown
                .as_ref()
                .and_then(|s| s.caller.as_ref())
                .map(|c| c.name.as_str()),
            Some("Agent")
        );
        pill.sync(&off, start + Duration::from_secs(5));
        assert!(pill.shown.is_none());
        assert_eq!(control_line(None).0, "A program");
    }

    #[test]
    fn hiding_the_pill_fades_it_without_ending_control_and_it_comes_back_when_allowed() {
        let start = Instant::now();
        let mut pill = ControlPresence::default();
        let on = ProgramControl {
            connected: true,
            ..ProgramControl::default()
        };
        pill.sync(&on, start);
        assert!(pill.interactive());
        let hidden = ProgramControl {
            hidden: true,
            ..on.clone()
        };
        pill.sync(&hidden, start + Duration::from_millis(10));
        assert!(pill.live);
        assert!(!pill.interactive());
        assert_eq!(pill.appear.map(|a| a.target()), Some(0.0));
        pill.sync(&on, start + Duration::from_secs(1));
        assert!(pill.interactive());
        assert_eq!(pill.appear.map(|a| a.target()), Some(1.0));
    }

    #[test]
    fn dismissing_during_the_hold_ends_the_session() {
        let start = Instant::now();
        let mut pill = ControlPresence::default();
        pill.sync(
            &ProgramControl {
                connected: true,
                ..ProgramControl::default()
            },
            start,
        );
        pill.sync(
            &ProgramControl::default(),
            start + Duration::from_millis(100),
        );
        assert!(pill.live && pill.hide_at.is_some());
        pill.dismissed(start + Duration::from_millis(200));
        assert!(!pill.live);
        assert!(!pill.interactive());
    }

    #[test]
    fn the_new_tab_notice_lasts_unless_held() {
        let start = Instant::now();
        let notice = NewTabNotice {
            id: 1,
            tab: TabId::new("b"),
            source: TabId::new("a"),
        };
        let mut presence = NoticePresence::default();
        presence.sync(Some(notice.clone()), start);
        assert!(presence.live);
        presence.hold(true, start + Duration::from_secs(1));
        presence.sync(Some(notice.clone()), start + Duration::from_secs(10));
        assert!(presence.live);
        let released = start + Duration::from_secs(10);
        presence.hold(false, released);
        presence.sync(Some(notice.clone()), released + NOTICE_LASTS);
        assert!(!presence.live);
        presence.sync(Some(notice), released + NOTICE_LASTS + NOTICE_MOTION);
        assert!(presence.shown.is_none());
    }

    #[test]
    fn the_new_tab_notice_grows_from_ninety_six_percent() {
        assert_eq!(notice_scale(0.0), 0.96);
        assert_eq!(notice_scale(1.0), 1.0);
    }

    #[test]
    fn dropped_links_and_text_follow_the_old_pasteboard_rules() {
        let items = |urls: &[&str], text: Option<&str>| gpui::ExternalItems {
            paths: Vec::new(),
            urls: urls.iter().map(|u| (*u).to_owned()).collect(),
            text: text.map(str::to_owned),
        };
        assert_eq!(
            dropped_entries(
                &items(&[" https://a.com/x ", "ftp://b", "http://"], None),
                false
            ),
            vec![DroppedEntry::Url("https://a.com/x".into())]
        );
        assert_eq!(
            dropped_entries(&items(&[], Some("example.com")), false),
            vec![DroppedEntry::Text("example.com".into())]
        );
        assert_eq!(
            dropped_entries(&items(&[], Some(" https://x.org/a?b ")), false),
            vec![DroppedEntry::Url("https://x.org/a?b".into())]
        );
        assert_eq!(
            dropped_entries(&items(&[], Some("mailto:a@b.c")), true),
            vec![DroppedEntry::Text("mailto:a@b.c".into())]
        );
        assert!(dropped_entries(&items(&[], Some("mailto:a@b.c")), false).is_empty());
        assert!(dropped_entries(&items(&[], Some("two words")), false).is_empty());
        assert_eq!(
            dropped_entries(&items(&[], Some("  two \n words ")), true),
            vec![DroppedEntry::Text("two words".into())]
        );
        let long = "w ".repeat(3000);
        match &dropped_entries(&items(&[], Some(&long)), true)[0] {
            DroppedEntry::Text(text) => assert_eq!(text.chars().count(), MAX_SEARCH_TEXT),
            other => panic!("{other:?}"),
        }
        assert!(dropped_entries(&items(&[], None), true).is_empty());
    }

    #[test]
    fn new_tab_drops_keep_local_files_and_trimmed_input() {
        let inputs = dropped_inputs(&[
            DroppedEntry::File("file:///Users/a.html".into()),
            DroppedEntry::File("file:////server/x".into()),
            DroppedEntry::Url(" https://a.com ".into()),
            DroppedEntry::Text("  ".into()),
            DroppedEntry::Text("cats".into()),
        ]);
        assert_eq!(
            inputs,
            vec!["file:///Users/a.html", "https://a.com", "cats"]
        );
        assert!(is_crx_input("file:///tmp/Ext.CRX"));
        assert!(!is_crx_input("https://a.com/x.crx"));
    }

    #[test]
    fn link_files_open_their_target() {
        assert_eq!(
            link_file_target("A.url", "[InternetShortcut]\nURL=https://a.com/\n"),
            Some("https://a.com/".into())
        );
        let webloc = "<plist><dict><key>URL</key>\n\t<string>https://b.com/?a=1&amp;b=2</string></dict></plist>";
        assert_eq!(
            link_file_target("B.webloc", webloc),
            Some("https://b.com/?a=1&b=2".into())
        );
        assert_eq!(link_file_target("C.url", "URL=file:///etc"), None);
        assert_eq!(
            web_url("https://user@[::1]:8080/x"),
            Some("https://user@[::1]:8080/x".into())
        );
        assert_eq!(web_url("https://a b.com"), None);
    }

    #[test]
    fn dropped_files_become_file_urls() {
        let paths = vec![
            std::path::PathBuf::from("/Users/me/My File#1.html"),
            std::path::PathBuf::from("relative.txt"),
        ];
        assert_eq!(
            dropped_urls(&paths),
            vec!["file:///Users/me/My%20File%231.html".to_owned()]
        );
        let many: Vec<_> = (0..60)
            .map(|i| std::path::PathBuf::from(format!("/f{i}")))
            .collect();
        assert_eq!(dropped_urls(&many).len(), MAX_DROPPED_TABS);
    }

    #[test]
    fn the_command_bar_shows_once_over_each_empty_card() {
        let mut overlays = PaneOverlays::default();
        assert!(overlays.first_time_over_empty_card(&TabId::new("a")));
        assert!(!overlays.first_time_over_empty_card(&TabId::new("a")));
        assert!(overlays.first_time_over_empty_card(&TabId::new("b")));
    }

    #[test]
    fn swipes_step_one_neighbour_without_wrapping() {
        let order = vec![TabId::new("a"), TabId::new("b"), TabId::new("c")];
        assert_eq!(
            neighbour_tab(&order, Some(&TabId::new("b")), 1),
            Some(TabId::new("c"))
        );
        assert_eq!(
            neighbour_tab(&order, Some(&TabId::new("b")), -1),
            Some(TabId::new("a"))
        );
        assert_eq!(neighbour_tab(&order, Some(&TabId::new("c")), 1), None);
        assert_eq!(neighbour_tab(&order, Some(&TabId::new("a")), -1), None);
        assert_eq!(neighbour_tab(&order, None, 1), None);
    }

    #[test]
    fn window_colors_match_the_old_tokens() {
        let dark = window_colors(true);
        assert!((dark.status_fill.a - 0.96).abs() < 1e-4);
        assert!((dark.frozen_wash.a - 0.25).abs() < 1e-4);
        let light = window_colors(false);
        assert!((light.status_fill.a - 0.97).abs() < 1e-4);
        assert!((light.status_text.a - 0xC7 as f32 / 255.0).abs() < 1e-4);
        assert_eq!(hud_radius(HudShape::Capsule, 28.0), 14.0);
        assert_eq!(hud_radius(HudShape::Tile, 22.0), radius::TILE);
    }
}
