use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use ardia_engine::{BrowserEngine, EngineEvent, PageMessage, PipKind, Services, TabCommand};
use ardia_state::{ProfileId, TabId, WindowId};
use ardia_ui::host_data::HostTopics;
use ardia_ui::media::mini_player::now_ms;
use ardia_ui::media::session::{
    FrameReports, MediaAction, MediaBook, MediaCommand, NowPlaying, Playback, Session,
    resume_commands,
};

use serde_json::Value;

use crate::coordinator::AppCoordinator;

fn url_origin(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .map(|u| u.origin().ascii_serialization())
        .filter(|o| o != "null")
        .unwrap_or_default()
}

pub fn autoplay_blocked(settings: &Value, everywhere: bool) -> bool {
    let settings = settings
        .get("settings")
        .filter(|inner| inner.is_object())
        .unwrap_or(settings);
    let autoplay = settings.get("autoplay").filter(|entry| entry.is_object());
    let blocked = autoplay
        .and_then(|entry| entry.get("value"))
        .and_then(Value::as_str)
        == Some("block");
    let default = autoplay.is_none_or(|entry| {
        entry
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    blocked || (everywhere && default)
}

const WAKE_TO_PLAY: Duration = Duration::from_secs(20);
const LOADED_WITHOUT_SESSION: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug)]
pub struct Wake {
    before: Option<Session>,
    saw_loading: bool,
    generation: u64,
}

#[derive(Debug, Default)]
pub struct MediaState {
    pub book: MediaBook,
    pub frames: HashMap<TabId, FrameReports>,
    pub waking: HashMap<TabId, Wake>,
    pub pip_kinds: HashMap<TabId, PipKind>,
    pub auto_pip_applied: Option<bool>,
    pub video_upscaling_applied: Option<bool>,
    generation: u64,
}

pub const CLOSE_DOCUMENT_PIP: &str = "window.documentPictureInPicture?.window?.close()";

impl AppCoordinator {
    pub(crate) fn note_media_event(&self, event: &EngineEvent) {
        match event {
            EngineEvent::PageMessage { tab, message } => {
                if let Some(tab) = self.state_tab(*tab) {
                    self.media_page_message(&tab, message);
                }
            }
            EngineEvent::RendererGone { tab, .. } => {
                if let Some(tab) = self.state_tab(*tab) {
                    self.reset_page_media(&tab);
                }
            }
            EngineEvent::PipChanged { tab, state } => {
                if let Some(tab) = self.state_tab(*tab) {
                    let changed = {
                        let mut bridge = self.bridge.lock();
                        if state.active {
                            bridge.media.pip_kinds.insert(tab.clone(), state.kind);
                        } else {
                            bridge.media.pip_kinds.remove(&tab);
                        }
                        bridge.media.book.set_pip(&tab, state.active)
                    };
                    if changed {
                        self.signal.emit(HostTopics::PAGE);
                    }
                }
            }
            EngineEvent::LoadingChanged { tab, loading } => {
                if let Some(tab) = self.state_tab(*tab) {
                    self.waking_load_changed(&tab, *loading);
                }
            }
            _ => {}
        }
    }

    pub(crate) fn media_page_message(&self, tab: &TabId, message: &PageMessage) {
        match message.kind.as_str() {
            "nowPlaying" => {
                let report = message.data().as_ref().and_then(NowPlaying::sanitized);
                let selected = {
                    let mut bridge = self.bridge.lock();
                    bridge.media.frames.entry(tab.clone()).or_default().note(
                        &message.frame_id,
                        report,
                        message.main_frame,
                    )
                };
                self.set_now_playing(tab, selected);
            }
            "hello" => {
                let discarded = self
                    .store
                    .snapshot()
                    .tab(tab.as_str())
                    .is_some_and(|t| t.page.is_asleep());
                if message.main_frame && !discarded {
                    self.reset_page_media(tab);
                }
                self.answer_autoplay(tab, message);
            }
            _ => {}
        }
    }

    fn answer_autoplay(&self, tab: &TabId, message: &PageMessage) {
        let state = self.store.snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        let origin = message
            .origin
            .clone()
            .filter(|origin| message.main_frame && !origin.is_empty())
            .unwrap_or_else(|| url_origin(&listed.url));
        if !origin.starts_with("http") {
            return;
        }
        let (Some(engine), Some(dir)) =
            (self.engine(), self.service_profile_dir(&listed.profile_id))
        else {
            return;
        };
        let everywhere = state.settings.block_autoplay_everywhere;
        let reply = Services::new(engine.as_ref(), &dir)
            .sites()
            .settings(&origin);
        let me = self.weak();
        let tab = tab.clone();
        let frame = message.frame_id.clone();
        self.spawn(async move {
            let settings = match reply.await {
                Ok(value) => value,
                Err(problem) => {
                    log::debug!("autoplay settings didn't load: {problem}");
                    Value::Null
                }
            };
            if !autoplay_blocked(&settings, everywhere) {
                return;
            }
            if let Some(me) = me.upgrade() {
                me.send_page_config(&tab, &frame);
            }
        });
    }

    fn send_page_config(&self, tab: &TabId, frame: &str) {
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            return;
        };
        let state = self.store.snapshot();
        let peek: Value =
            serde_json::from_str(&crate::peek_links::peek_config(&state, tab)).unwrap_or_default();
        let json = serde_json::json!({
            "blockAutoplay": true,
            "displayMediaPicker": true,
            "peek": peek.get("modifier"),
            "split": peek.get("split"),
            "peekTrace": peek.get("trace"),
            "peekOtherSites": peek.get("otherSites"),
        })
        .to_string();
        let command = if frame.is_empty() {
            TabCommand::CallPage {
                kind: "config".into(),
                json,
            }
        } else {
            TabCommand::CallFrame {
                frame: frame.into(),
                kind: "config".into(),
                json,
            }
        };
        if let Err(problem) = engine.tab_command(engine_tab, command) {
            log::debug!("{tab} didn't take the page config: {problem}");
        }
    }

    pub(crate) fn reset_page_media(&self, tab: &TabId) {
        let had = self
            .bridge
            .lock()
            .media
            .frames
            .get_mut(tab)
            .is_some_and(FrameReports::reset);
        if had {
            self.set_now_playing(tab, None);
        }
    }

    fn set_now_playing(&self, tab: &TabId, report: Option<NowPlaying>) {
        let state = self.store.snapshot();
        let now = now_ms();
        let (changed, resume) = {
            let mut bridge = self.bridge.lock();
            let media = &mut bridge.media;
            let resume = media
                .waking
                .get(tab)
                .filter(|_| {
                    report
                        .as_ref()
                        .is_some_and(|r| r.playback != Playback::None)
                })
                .map(|wake| resume_commands(wake.before.as_ref(), report.as_ref(), now));
            if resume.is_some() {
                media.waking.remove(tab);
            }
            let changed = media.book.apply(&state, tab, report, now);
            media.book.prune(&state);
            (changed, resume)
        };
        for command in resume.unwrap_or_default() {
            self.send_media_command(tab, command);
        }
        if changed {
            self.signal.emit(HostTopics::PAGE);
        }
    }

    pub(crate) fn send_media_command(&self, tab: &TabId, command: MediaCommand) {
        if self.webkit_media_command(tab, command) {
            return;
        }
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            return;
        };
        let frame = self
            .bridge
            .lock()
            .media
            .frames
            .get(tab)
            .map(|f| f.selected_frame().to_owned())
            .unwrap_or_default();
        if command.starts_playback()
            && let Err(problem) = engine.tab_command(
                engine_tab,
                TabCommand::GrantUserActivation {
                    frame: frame.clone(),
                },
            )
        {
            log::debug!("{tab} didn't get user activation for media: {problem}");
        }
        let (action, seconds) = command.wire();
        let json = serde_json::json!({ "action": action, "seconds": seconds }).to_string();
        let call = if frame.is_empty() {
            TabCommand::CallPage {
                kind: "media".into(),
                json,
            }
        } else {
            TabCommand::CallFrame {
                frame,
                kind: "media".into(),
                json,
            }
        };
        if let Err(problem) = engine.tab_command(engine_tab, call) {
            log::debug!("{tab} didn't take the media command {action}: {problem}");
        }
    }

    pub(crate) fn run_media_action(&self, tab: TabId, action: MediaAction) {
        let asleep = self
            .store
            .snapshot()
            .tab(tab.as_str())
            .is_some_and(|t| t.page.is_asleep());
        let (command, before) = {
            let mut bridge = self.bridge.lock();
            let before = bridge.media.book.session(&tab).cloned();
            (bridge.media.book.action(&tab, action, now_ms()), before)
        };
        let Some(command) = command else {
            return;
        };
        self.signal.emit(HostTopics::PAGE);
        if !asleep {
            self.send_media_command(&tab, command);
        } else if command.starts_playback() {
            self.wake_to_play(tab, before);
        }
    }

    fn wake_to_play(&self, tab: TabId, before: Option<Session>) {
        let generation = {
            let mut bridge = self.bridge.lock();
            let media = &mut bridge.media;
            if media.waking.contains_key(&tab) {
                return;
            }
            media.generation += 1;
            let generation = media.generation;
            media.waking.insert(
                tab.clone(),
                Wake {
                    before,
                    saw_loading: false,
                    generation,
                },
            );
            generation
        };
        ardia_ui::UiHost::reload(self, tab.clone(), false);
        self.media_after(WAKE_TO_PLAY, move |me| {
            let mut bridge = me.bridge.lock();
            if bridge
                .media
                .waking
                .get(&tab)
                .is_some_and(|w| w.generation == generation)
            {
                bridge.media.waking.remove(&tab);
            }
        });
    }

    fn waking_load_changed(&self, tab: &TabId, loading: bool) {
        let generation = {
            let mut bridge = self.bridge.lock();
            let Some(wake) = bridge.media.waking.get_mut(tab) else {
                return;
            };
            if loading {
                wake.saw_loading = true;
                return;
            }
            if !wake.saw_loading {
                return;
            }
            wake.generation
        };
        let tab = tab.clone();
        self.media_after(LOADED_WITHOUT_SESSION, move |me| {
            let wake = {
                let mut bridge = me.bridge.lock();
                let current = bridge
                    .media
                    .waking
                    .get(&tab)
                    .is_some_and(|w| w.generation == generation);
                if current {
                    bridge.media.waking.remove(&tab)
                } else {
                    None
                }
            };
            if let Some(wake) = wake {
                for command in resume_commands(wake.before.as_ref(), None, now_ms()) {
                    me.send_media_command(&tab, command);
                }
            }
        });
    }

    fn media_after(&self, delay: Duration, job: impl FnOnce(&AppCoordinator) + Send + 'static) {
        let me = self.weak();
        let spawned = std::thread::Builder::new()
            .name("ardia-media-timer".into())
            .spawn(move || {
                std::thread::sleep(delay);
                if let Some(coordinator) = me.upgrade() {
                    coordinator.post(job);
                }
            });
        if let Err(problem) = spawned {
            log::debug!("a media timer didn't start: {problem}");
        }
    }

    pub(crate) fn media_session_of(&self, tab: &TabId) -> Option<Session> {
        self.bridge.lock().media.book.session(tab).cloned()
    }

    pub(crate) fn dismiss_media_player(&self, tab: &TabId) {
        if self.bridge.lock().media.book.dismiss(tab) {
            self.signal.emit(HostTopics::PAGE);
        }
    }

    pub(crate) fn shows_mini_player_for(&self, tab: &TabId) -> bool {
        let state = self.store.snapshot();
        self.bridge.lock().media.book.shows_mini_player(&state, tab)
    }

    pub(crate) fn sidebar_player_for(
        &self,
        window: &WindowId,
        profile: &ProfileId,
    ) -> Option<TabId> {
        let state = self.store.snapshot();
        let mut bridge = self.bridge.lock();
        if bridge.media.book.sessions.is_empty() {
            return None;
        }
        bridge.media.book.prune(&state);
        bridge
            .media
            .book
            .sidebar_player_tab(&state, window, profile)
    }

    pub(crate) fn media_pip_open_for(&self, tab: &TabId) -> bool {
        self.bridge.lock().media.book.pip_open.contains(tab)
    }

    pub(crate) fn toggle_pip_for(&self, tab: TabId) {
        if !self.media_pip_open_for(&tab) {
            ardia_ui::UiHost::enter_pip(self, tab);
            return;
        }
        if self.webkit_set_pip(&tab, false, false) {
            return;
        }
        let document =
            self.bridge.lock().media.pip_kinds.get(&tab).copied() == Some(PipKind::Document);
        let exit = if document {
            TabCommand::ExecuteJavaScript {
                code: CLOSE_DOCUMENT_PIP.into(),
                frame: None,
            }
        } else {
            TabCommand::ExitPictureInPicture
        };
        self.with_media_tab(&tab, exit);
        let changed = {
            let mut bridge = self.bridge.lock();
            bridge.media.pip_kinds.remove(&tab);
            bridge.media.book.set_pip(&tab, false)
        };
        if changed {
            self.signal.emit(HostTopics::PAGE);
        }
    }

    pub(crate) fn apply_auto_pip(&self, enabled: bool, engine: &Arc<dyn BrowserEngine>) {
        if self.bridge.lock().media.auto_pip_applied == Some(enabled) {
            return;
        }
        match engine.set_auto_pip(enabled) {
            Ok(()) => self.bridge.lock().media.auto_pip_applied = Some(enabled),
            Err(problem) => log::debug!("the engine didn't take the auto PiP setting: {problem}"),
        }
    }

    pub(crate) fn apply_video_upscaling(&self, enabled: bool, engine: &Arc<dyn BrowserEngine>) {
        if self.bridge.lock().media.video_upscaling_applied == Some(enabled) {
            return;
        }
        match engine.set_video_upscaling(enabled) {
            Ok(()) => self.bridge.lock().media.video_upscaling_applied = Some(enabled),
            Err(problem) => {
                log::debug!("the engine didn't take the video upscaling setting: {problem}")
            }
        }
    }

    fn with_media_tab(&self, tab: &TabId, command: TabCommand) {
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            return;
        };
        if let Err(problem) = engine.tab_command(engine_tab, command) {
            log::debug!("{tab} didn't take a picture-in-picture command: {problem}");
        }
    }
}

#[cfg(test)]
mod autoplay_tests {
    use super::autoplay_blocked;
    use serde_json::json;

    #[test]
    fn a_blocked_site_blocks_autoplay_like_the_old_hello_answer() {
        let blocked =
            json!({ "settings": { "autoplay": { "value": "block", "isDefault": false } } });
        assert!(autoplay_blocked(&blocked, false));
        let allowed = json!({ "autoplay": { "value": "allow", "isDefault": false } });
        assert!(!autoplay_blocked(&allowed, true));
        let default = json!({ "autoplay": { "value": "allow", "isDefault": true } });
        assert!(autoplay_blocked(&default, true));
        assert!(!autoplay_blocked(&default, false));
        assert!(autoplay_blocked(&json!(null), true));
        assert!(!autoplay_blocked(&json!(null), false));
    }
}
