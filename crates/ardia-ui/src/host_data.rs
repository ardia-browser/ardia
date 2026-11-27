use std::collections::BTreeMap;
use std::ops::{BitOr, BitOrAssign};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use ardia_engine::NativeViewHandle;
use ardia_state::model::Millis;
use ardia_state::{ProfileId, TabId};
use futures::StreamExt as _;
use futures::channel::mpsc;
use gpui::{Context, Image, Task, Window};
use parking_lot::Mutex;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct HostTopics(u8);

impl HostTopics {
    pub const NONE: HostTopics = HostTopics(0);
    pub const EXTENSIONS: HostTopics = HostTopics(1);
    pub const CAST: HostTopics = HostTopics(1 << 1);
    pub const IMPORT: HostTopics = HostTopics(1 << 2);
    pub const SYNC: HostTopics = HostTopics(1 << 3);
    pub const SITE: HostTopics = HostTopics(1 << 4);
    pub const PLUGINS: HostTopics = HostTopics(1 << 5);
    pub const PEOPLE: HostTopics = HostTopics(1 << 6);
    pub const PAGE: HostTopics = HostTopics(1 << 7);
    pub const ALL: HostTopics = HostTopics(u8::MAX);

    pub fn contains(self, other: HostTopics) -> bool {
        self.0 & other.0 == other.0
    }

    pub fn intersects(self, other: HostTopics) -> bool {
        self.0 & other.0 != 0
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }
}

impl BitOr for HostTopics {
    type Output = HostTopics;

    fn bitor(self, other: HostTopics) -> HostTopics {
        HostTopics(self.0 | other.0)
    }
}

impl BitOrAssign for HostTopics {
    fn bitor_assign(&mut self, other: HostTopics) {
        self.0 |= other.0;
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MediaCapture {
    pub camera: bool,
    pub microphone: bool,
    pub screen: bool,
}

impl MediaCapture {
    pub fn any(self) -> bool {
        self.camera || self.microphone || self.screen
    }
}

type Listener = Arc<dyn Fn(HostTopics) + Send + Sync>;

#[derive(Default)]
struct Listeners {
    next: u64,
    entries: Vec<(u64, HostTopics, Listener)>,
}

#[derive(Default)]
pub struct HostSignal {
    listeners: Arc<Mutex<Listeners>>,
    revision: AtomicU64,
}

#[must_use = "the listener stops when this is dropped"]
pub struct HostSubscription {
    listeners: Weak<Mutex<Listeners>>,
    id: u64,
}

impl Drop for HostSubscription {
    fn drop(&mut self) {
        if let Some(listeners) = self.listeners.upgrade() {
            listeners.lock().entries.retain(|(id, _, _)| *id != self.id);
        }
    }
}

impl HostSignal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(
        &self,
        interest: HostTopics,
        listener: impl Fn(HostTopics) + Send + Sync + 'static,
    ) -> HostSubscription {
        let mut listeners = self.listeners.lock();
        listeners.next += 1;
        let id = listeners.next;
        listeners.entries.push((id, interest, Arc::new(listener)));
        HostSubscription {
            listeners: Arc::downgrade(&self.listeners),
            id,
        }
    }

    pub fn emit(&self, topics: HostTopics) {
        if topics.is_empty() {
            return;
        }
        self.revision.fetch_add(1, Ordering::AcqRel);
        let wanted: Vec<Listener> = self
            .listeners
            .lock()
            .entries
            .iter()
            .filter(|(_, interest, _)| interest.intersects(topics))
            .map(|(_, _, listener)| Arc::clone(listener))
            .collect();
        for listener in wanted {
            listener(topics);
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    pub fn listener_count(&self) -> usize {
        self.listeners.lock().entries.len()
    }
}

pub struct HostLink {
    _subscription: Option<HostSubscription>,
    _task: Option<Task<()>>,
}

impl HostLink {
    pub fn new<V: 'static>(
        signal: Option<&HostSignal>,
        interest: HostTopics,
        window: &Window,
        cx: &mut Context<V>,
        on_change: fn(&mut V, HostTopics, &mut Window, &mut Context<V>),
    ) -> Self {
        let Some(signal) = signal else {
            return HostLink {
                _subscription: None,
                _task: None,
            };
        };
        let (sender, mut receiver) = mpsc::unbounded::<HostTopics>();
        let subscription = signal.subscribe(interest, move |topics| {
            let _ = sender.unbounded_send(topics);
        });
        let task = cx.spawn_in(window, async move |view, cx| {
            while let Some(mut topics) = receiver.next().await {
                while let Ok(more) = receiver.try_recv() {
                    topics |= more;
                }
                if view
                    .update_in(cx, |view, window, cx| on_change(view, topics, window, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        HostLink {
            _subscription: Some(subscription),
            _task: Some(task),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExtensionItem {
    pub id: String,
    pub name: String,
    pub icon: Option<Arc<Image>>,
    pub enabled: bool,
    pub pinned: bool,
    pub pinned_index: Option<u32>,
    pub has_action: bool,
    pub action_title: String,
    pub badge: String,
    pub badge_color: Option<String>,
    pub badge_text_color: Option<String>,
    pub action_enabled: bool,
    pub may_modify: bool,
    pub options_url: Option<String>,
    pub from_web_store: bool,
    pub side_panel: bool,
}

impl ExtensionItem {
    pub fn tooltip(&self) -> &str {
        if self.action_title.is_empty() {
            &self.name
        } else {
            &self.action_title
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExtensionList {
    pub profile: Option<ProfileId>,
    pub loaded: bool,
    pub items: Arc<Vec<ExtensionItem>>,
}

impl ExtensionList {
    pub fn toolbar(&self) -> Vec<&ExtensionItem> {
        let mut pinned: Vec<&ExtensionItem> = self
            .items
            .iter()
            .filter(|item| item.enabled && item.pinned)
            .collect();
        pinned.sort_by_key(|item| item.pinned_index.unwrap_or(u32::MAX));
        pinned
    }

    pub fn menu(&self) -> Vec<&ExtensionItem> {
        self.items.iter().filter(|item| item.enabled).collect()
    }

    pub fn find(&self, id: &str) -> Option<&ExtensionItem> {
        self.items.iter().find(|item| item.id == id)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExtensionPopupView {
    pub extension_id: String,
    pub name: String,
    pub view: Option<NativeViewHandle>,
    pub size: (f32, f32),
    pub sized: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum CastDeviceState {
    #[default]
    Available,
    Connecting,
    Connected,
    Disconnecting,
    Unavailable,
}

impl CastDeviceState {
    pub fn parse(text: &str) -> CastDeviceState {
        match text {
            "connecting" => CastDeviceState::Connecting,
            "connected" => CastDeviceState::Connected,
            "disconnecting" => CastDeviceState::Disconnecting,
            "unavailable" => CastDeviceState::Unavailable,
            _ => CastDeviceState::Available,
        }
    }

    pub fn busy(self) -> bool {
        matches!(
            self,
            CastDeviceState::Connecting | CastDeviceState::Disconnecting
        )
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum CastDeviceKind {
    #[default]
    Tv,
    SpeakerGroup,
    Speaker,
    Display,
}

impl CastDeviceKind {
    pub fn from_icon(icon: i32) -> CastDeviceKind {
        match icon {
            1 => CastDeviceKind::SpeakerGroup,
            2 => CastDeviceKind::Speaker,
            6 => CastDeviceKind::Display,
            _ => CastDeviceKind::Tv,
        }
    }
}

pub mod cast_mode {
    pub const PRESENTATION: i32 = 1;
    pub const TAB: i32 = 2;
    pub const SCREEN: i32 = 4;
    pub const REMOTE_PLAYBACK: i32 = 8;

    pub fn preferred(modes: i32) -> i32 {
        [PRESENTATION, TAB, SCREEN, REMOTE_PLAYBACK]
            .into_iter()
            .find(|mode| modes & mode != 0)
            .unwrap_or(0)
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum CastClick {
        Start(i32),
        ShowScreenSource,
        Nothing,
    }

    pub fn click(modes: i32, screen: bool) -> CastClick {
        if screen && modes & SCREEN != 0 {
            return CastClick::Start(SCREEN);
        }
        match preferred(modes & !SCREEN) {
            0 if !screen && modes & SCREEN != 0 => CastClick::ShowScreenSource,
            0 => match preferred(modes) {
                0 => CastClick::Nothing,
                mode => CastClick::Start(mode),
            },
            mode => CastClick::Start(mode),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CastDevice {
    pub id: String,
    pub name: String,
    pub status: String,
    pub issue: String,
    pub state: CastDeviceState,
    pub kind: CastDeviceKind,
    pub modes: i32,
    pub route_id: String,
}

impl CastDevice {
    pub fn casting(&self) -> bool {
        self.state == CastDeviceState::Connected && !self.route_id.is_empty()
    }

    pub fn detail(&self) -> &str {
        if self.issue.is_empty() {
            &self.status
        } else {
            &self.issue
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CastRouteInfo {
    pub id: String,
    pub sink: String,
    pub description: String,
}

pub fn cast_routes_tooltip(routes: &[CastRouteInfo]) -> String {
    routes
        .iter()
        .map(|route| {
            if route.description.is_empty() {
                format!("Casting to {}", route.sink)
            } else {
                format!("{} on {}", route.description, route.sink)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn drop_index(from: usize, dx: f32, pitch: f32, count: usize) -> usize {
    if count == 0 || pitch <= 0.0 || !dx.is_finite() {
        return from;
    }
    let moved = from as f32 + (dx / pitch).round();
    moved.clamp(0.0, (count - 1) as f32) as usize
}

pub fn make_room_shift(index: usize, drag: Option<(usize, f32)>, pitch: f32, count: usize) -> f32 {
    let Some((from, dx)) = drag else {
        return 0.0;
    };
    if index == from {
        return 0.0;
    }
    let to = drop_index(from, dx, pitch, count);
    if from < index && index <= to {
        -pitch
    } else if to <= index && index < from {
        pitch
    } else {
        0.0
    }
}

pub fn moved_toolbar_order(
    shown: &[(String, Option<u32>)],
    id: &str,
    to: usize,
) -> Option<(Vec<(String, u32)>, u32)> {
    let from = shown.iter().position(|(known, _)| known == id)?;
    let target = shown.get(to)?;
    let pinned_index = target.1?;
    if from == to {
        return None;
    }
    let mut order: Vec<&str> = shown.iter().map(|(known, _)| known.as_str()).collect();
    order.remove(from);
    order.insert(to, id);
    let mut slots: Vec<u32> = shown
        .iter()
        .map(|(_, index)| index.unwrap_or(u32::MAX))
        .collect();
    slots.sort_unstable();
    Some((
        order
            .into_iter()
            .zip(slots)
            .map(|(id, slot)| (id.to_owned(), slot))
            .collect(),
        pinned_index,
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureBadge {
    Recording,
    Screen,
}

pub fn capture_badge(camera: bool, microphone: bool, screen: bool) -> Option<CaptureBadge> {
    if screen {
        Some(CaptureBadge::Screen)
    } else if camera || microphone {
        Some(CaptureBadge::Recording)
    } else {
        None
    }
}

pub fn crx_paths(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter(|path| {
            std::path::Path::new(path)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("crx"))
        })
        .cloned()
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExtensionInstallView {
    pub request_id: String,
    pub name: String,
    pub kind: String,
    pub icon: Option<Arc<Image>>,
    pub permissions: Vec<String>,
}

impl ExtensionInstallView {
    pub fn title(&self) -> String {
        let name = if self.name.is_empty() {
            "Extension"
        } else {
            &self.name
        };
        match self.kind.as_str() {
            "re-enable" => format!("Turn “{name}” back on?"),
            "permissions" => format!("“{name}” needs new permissions"),
            _ => format!("Add “{name}”?"),
        }
    }

    pub fn action(&self) -> &'static str {
        match self.kind.as_str() {
            "re-enable" => "Turn On",
            "permissions" => "Allow",
            _ => "Add Extension",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SidePanelView {
    pub extension_id: String,
    pub title: String,
    pub icon: Option<Arc<Image>>,
    pub view: Option<NativeViewHandle>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CastPanel {
    pub tab: Option<TabId>,
    pub dialog_id: i32,
    pub header: String,
    pub devices: Vec<CastDevice>,
    pub permission_rejected: bool,
    pub screen: bool,
}

impl CastPanel {
    pub fn shown_devices(&self) -> impl Iterator<Item = &CastDevice> {
        self.devices
            .iter()
            .filter(|device| device.state != CastDeviceState::Unavailable)
    }

    pub fn title(&self) -> &str {
        if self.screen {
            "Cast screen"
        } else if self.header.is_empty() {
            "Cast tab"
        } else {
            &self.header
        }
    }

    pub fn can_screen(&self) -> bool {
        self.devices
            .iter()
            .any(|device| device.modes & cast_mode::SCREEN != 0)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportBrowserProfile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub email: Option<String>,
    pub is_default: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportBrowser {
    pub id: String,
    pub name: String,
    pub profiles: Vec<ImportBrowserProfile>,
    pub kinds: Vec<String>,
}

impl ImportBrowser {
    pub fn detail(&self) -> String {
        if self.profiles.len() > 1 {
            format!("{} profiles", self.profiles.len())
        } else {
            String::new()
        }
    }

    pub fn default_profiles(&self) -> Vec<String> {
        let defaults: Vec<String> = self
            .profiles
            .iter()
            .filter(|profile| profile.is_default)
            .map(|profile| profile.id.clone())
            .collect();
        if defaults.is_empty() {
            self.profiles.iter().take(1).map(|p| p.id.clone()).collect()
        } else {
            defaults
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportPlan {
    pub source_id: String,
    pub source_name: String,
    pub profiles: Vec<ImportBrowserProfile>,
    pub kinds: Vec<String>,
    pub target: Option<ProfileId>,
    pub file: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StageState {
    Waiting,
    Running,
    Done,
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportStage {
    pub key: String,
    pub label: String,
    pub state: StageState,
    pub done: usize,
    pub total: Option<usize>,
}

impl ImportStage {
    pub fn new(key: &str, label: &str) -> ImportStage {
        ImportStage {
            key: key.to_owned(),
            label: label.to_owned(),
            state: StageState::Waiting,
            done: 0,
            total: None,
        }
    }

    pub fn fraction(&self) -> Option<f32> {
        match (&self.state, self.total) {
            (StageState::Done, _) => Some(1.0),
            (_, Some(total)) if total > 0 => Some((self.done.min(total) as f32) / total as f32),
            _ => None,
        }
    }

    pub fn summary(&self) -> String {
        match &self.state {
            StageState::Waiting => "Waiting".to_owned(),
            StageState::Running => match self.total {
                Some(total) => format!("{} of {}", self.done.min(total), total),
                None if self.done > 0 => format!("{} found", self.done),
                None => "Reading…".to_owned(),
            },
            StageState::Done => match self.done {
                1 => "1 item".to_owned(),
                count => format!("{count} items"),
            },
            StageState::Failed(reason) => reason.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListedExtension {
    pub id: String,
    pub name: String,
    pub web_store_url: String,
    pub off_in_source: bool,
    pub pinned_in_source: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionTarget {
    pub profile_id: ProfileId,
    pub profile_name: String,
    pub extensions: Vec<ListedExtension>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LeftOutReason {
    Installed,
    ManifestV2,
    Unpacked,
    Policy,
    External,
    NotWebStore,
}

impl LeftOutReason {
    pub fn words(self) -> &'static str {
        match self {
            LeftOutReason::Installed => "already in Ardia",
            LeftOutReason::ManifestV2 => "uses Manifest V2, which Chrome no longer runs",
            LeftOutReason::Unpacked => "loaded unpacked in developer mode",
            LeftOutReason::Policy => "installed by your organization's policy",
            LeftOutReason::External => "added by another app",
            LeftOutReason::NotWebStore => "not from the Chrome Web Store",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeftOutExtension {
    pub name: String,
    pub reason: LeftOutReason,
}

impl LeftOutExtension {
    pub fn text(&self) -> String {
        format!("{} ({})", self.name, self.reason.words())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExtensionListing {
    pub source_name: String,
    pub targets: Vec<ExtensionTarget>,
    pub left_out: Vec<LeftOutExtension>,
    pub store_opened: bool,
}

impl ExtensionListing {
    pub fn listed_count(&self) -> usize {
        self.targets.iter().map(|t| t.extensions.len()).sum()
    }
}

pub fn source_notes(extension: &ListedExtension, source_name: &str) -> String {
    let notes: Vec<&str> = [
        extension.off_in_source.then_some("off"),
        extension.pinned_in_source.then_some("pinned"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if notes.is_empty() {
        String::new()
    } else {
        format!("{} in {source_name}", notes.join(" and "))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportProgress {
    pub run: u64,
    pub source: String,
    pub preparing: usize,
    pub stages: Vec<ImportStage>,
    pub finished: bool,
    pub error: Option<String>,
    pub extensions: Option<ExtensionListing>,
}

impl ImportProgress {
    pub fn new(run: u64, source: &str, stages: Vec<ImportStage>) -> ImportProgress {
        ImportProgress {
            run,
            source: source.to_owned(),
            preparing: 1,
            stages,
            finished: false,
            error: None,
            extensions: None,
        }
    }

    pub fn stage_mut(&mut self, key: &str) -> Option<&mut ImportStage> {
        self.stages.iter_mut().find(|stage| stage.key == key)
    }

    pub fn stage(&self, key: &str) -> Option<&ImportStage> {
        self.stages.iter().find(|stage| stage.key == key)
    }

    pub fn imported(&self) -> usize {
        self.stages
            .iter()
            .filter(|stage| stage.state == StageState::Done)
            .map(|stage| stage.done)
            .sum()
    }

    pub fn fail(&mut self, problem: String) {
        for stage in &mut self.stages {
            if matches!(stage.state, StageState::Waiting | StageState::Running) {
                stage.state = StageState::Failed(problem.clone());
            }
        }
        self.error = Some(problem);
        self.finished = true;
    }

    pub fn succeeded(&self) -> bool {
        self.finished && self.error.is_none()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SyncFolderState {
    #[default]
    Unset,
    Reachable,
    Missing,
    Unreadable(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncedProfile {
    pub profile_id: ProfileId,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SharedFolderStatus {
    pub profile_id: ProfileId,
    pub group_key: String,
    pub path: String,
    pub reachable: bool,
    pub added_at: Option<Millis>,
    pub state: SharedFolderState,
    pub status_text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SharedFolderState {
    #[default]
    Syncing,
    Synced,
    Waiting(u32),
    Paused,
    Missing,
    Error(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncDevice {
    pub id: String,
    pub name: String,
    pub current: bool,
    pub last_seen: Option<Millis>,
    pub kind: crate::sync_api::DeviceKind,
    pub receives_tabs: bool,
    pub version: Option<String>,
    pub os: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncStatus {
    pub loaded: bool,
    pub enabled: bool,
    pub joining: bool,
    pub folder: Option<String>,
    pub folder_state: SyncFolderState,
    pub device_id: Option<String>,
    pub last_synced_at: Option<Millis>,
    pub setup_at: Option<Millis>,
    pub data_types: BTreeMap<String, bool>,
    pub profiles: Vec<SyncedProfile>,
    pub shared_folders: Vec<SharedFolderStatus>,
    pub devices: Vec<SyncDevice>,
    pub errors: Vec<String>,
    pub folder_exists: bool,
    pub engine: crate::sync_api::SyncEngineView,
}

impl SyncStatus {
    pub fn status_line(&self, now: Millis) -> String {
        let since = self.last_synced_at.map(|at| ago(now, at));
        if self.joining {
            return "Updating".to_owned();
        }
        if !self.errors.is_empty() {
            return match since {
                Some(since) => format!("Not syncing · last synced {since}"),
                None => "Not syncing".to_owned(),
            };
        }
        match since {
            Some(since) if since != "just now" => format!("Updated {since}"),
            _ => "Updated just now".to_owned(),
        }
    }
}

fn units(count: Millis, unit: &str) -> String {
    if count == 1 {
        format!("1 {unit} ago")
    } else {
        format!("{count} {unit}s ago")
    }
}

pub fn ago(now: Millis, then: Millis) -> String {
    let seconds = (now - then).max(0) as f64 / 1000.0;
    if seconds < 60.0 {
        return "just now".to_owned();
    }
    let minutes = (seconds / 60.0).floor() as Millis;
    if minutes < 60 {
        return units(minutes, "minute");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return units(hours, "hour");
    }
    let days = hours / 24;
    match days {
        1 => "yesterday".to_owned(),
        2..=6 => format!("{days} days ago"),
        7..=29 => units(days / 7, "week"),
        30..=364 => units(days / 30, "month"),
        _ => units(days / 365, "year"),
    }
}

pub fn folder_label(path: &str, home: Option<&str>) -> String {
    if let Some((_, rest)) = path.split_once("com~apple~CloudDocs") {
        let parts: Vec<&str> = std::iter::once("iCloud Drive")
            .chain(rest.split('/').filter(|part| !part.is_empty()))
            .collect();
        return parts.join(" › ");
    }
    match home.and_then(|home| path.strip_prefix(home)) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
        _ => path.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn signals_reach_only_interested_listeners_until_dropped() {
        let signal = HostSignal::new();
        let cast_hits = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&cast_hits);
        let subscription = signal.subscribe(HostTopics::CAST, move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        signal.emit(HostTopics::IMPORT);
        signal.emit(HostTopics::CAST | HostTopics::SYNC);
        assert_eq!(cast_hits.load(Ordering::SeqCst), 1);
        assert_eq!(signal.revision(), 2);
        drop(subscription);
        signal.emit(HostTopics::CAST);
        assert_eq!(cast_hits.load(Ordering::SeqCst), 1);
        assert_eq!(signal.listener_count(), 0);
    }

    #[test]
    fn the_toolbar_shows_enabled_pinned_extensions_in_their_slots() {
        let item = |id: &str, pinned: bool, index: Option<u32>, enabled: bool| ExtensionItem {
            id: id.into(),
            name: id.to_uppercase(),
            pinned,
            pinned_index: index,
            enabled,
            ..ExtensionItem::default()
        };
        let list = ExtensionList {
            profile: None,
            loaded: true,
            items: Arc::new(vec![
                item("b", true, Some(2), true),
                item("a", true, Some(1), true),
                item("c", false, None, true),
                item("d", true, Some(0), false),
            ]),
        };
        let toolbar: Vec<&str> = list.toolbar().iter().map(|x| x.id.as_str()).collect();
        assert_eq!(toolbar, ["a", "b"]);
        let menu: Vec<&str> = list.menu().iter().map(|x| x.id.as_str()).collect();
        assert_eq!(menu, ["b", "a", "c"]);
    }

    #[test]
    fn a_click_picks_the_cast_mode_the_old_picker_picked_but_never_mirrors_the_screen_from_tab_mode()
     {
        use cast_mode::{CastClick, PRESENTATION, REMOTE_PLAYBACK, SCREEN, TAB, click};
        assert_eq!(click(TAB | SCREEN, false), CastClick::Start(TAB));
        assert_eq!(
            click(PRESENTATION | TAB, false),
            CastClick::Start(PRESENTATION)
        );
        assert_eq!(
            click(REMOTE_PLAYBACK, false),
            CastClick::Start(REMOTE_PLAYBACK)
        );
        assert_eq!(click(SCREEN, false), CastClick::ShowScreenSource);
        assert_eq!(click(SCREEN, true), CastClick::Start(SCREEN));
        assert_eq!(click(TAB | SCREEN, true), CastClick::Start(SCREEN));
        assert_eq!(click(TAB, true), CastClick::Start(TAB));
        assert_eq!(click(0, false), CastClick::Nothing);
        assert_eq!(click(0, true), CastClick::Nothing);
        let panel = CastPanel {
            header: "Cast tab".into(),
            screen: true,
            ..CastPanel::default()
        };
        assert_eq!(panel.title(), "Cast screen");
        assert_eq!(
            CastDeviceState::parse("connected"),
            CastDeviceState::Connected
        );
        assert_eq!(
            CastDeviceState::parse("garbage"),
            CastDeviceState::Available
        );
    }

    #[test]
    fn import_stages_report_counts_and_failures() {
        let mut progress = ImportProgress::new(
            1,
            "Chrome",
            vec![
                ImportStage::new("bookmarks", "Bookmarks"),
                ImportStage::new("history", "History"),
            ],
        );
        let bookmarks = progress.stage_mut("bookmarks").unwrap();
        bookmarks.state = StageState::Running;
        bookmarks.done = 5;
        bookmarks.total = Some(20);
        assert_eq!(bookmarks.fraction(), Some(0.25));
        assert_eq!(bookmarks.summary(), "5 of 20");
        bookmarks.state = StageState::Done;
        bookmarks.done = 20;
        progress.fail("disk full".into());
        assert_eq!(progress.stage("bookmarks").unwrap().state, StageState::Done);
        assert_eq!(
            progress.stage("history").unwrap().state,
            StageState::Failed("disk full".into())
        );
        assert_eq!(progress.imported(), 20);
        assert!(progress.finished && !progress.succeeded());
    }

    #[test]
    fn sync_lines_read_like_the_old_settings() {
        let now = 100 * 86_400_000;
        let mut status = SyncStatus {
            loaded: true,
            enabled: true,
            ..SyncStatus::default()
        };
        assert_eq!(status.status_line(now), "Updated just now");
        status.last_synced_at = Some(now - 120_000);
        assert_eq!(status.status_line(now), "Updated 2 minutes ago");
        status.errors.push("folder missing".into());
        assert_eq!(
            status.status_line(now),
            "Not syncing · last synced 2 minutes ago"
        );
        assert_eq!(ago(now, now - 86_400_000), "yesterday");
        assert_eq!(ago(now, now - 3 * 86_400_000), "3 days ago");
        assert_eq!(ago(now, now - 14 * 86_400_000), "2 weeks ago");
        assert_eq!(ago(now, now - 3_600_000), "1 hour ago");
        assert_eq!(
            folder_label(
                "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Ardia Sync",
                Some("/Users/me")
            ),
            "iCloud Drive › Ardia Sync"
        );
        assert_eq!(
            folder_label("/Users/me/Dropbox/Sync", Some("/Users/me")),
            "~/Dropbox/Sync"
        );
        assert_eq!(folder_label("/Volumes/X", Some("/Users/me")), "/Volumes/X");
    }
}
