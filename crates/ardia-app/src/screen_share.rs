use std::collections::{HashMap, HashSet};

use ardia_engine::{EngineEvent, EngineQuery, GlobalCommand, PageMessage, TabAction, TabCommand};
use ardia_state::TabId;
use ardia_ui::host_data::HostTopics;
use ardia_ui::media::share::{AudioOffer, DisplayRequest, TabShare};
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;

const MAX_PENDING: usize = 16;

#[derive(Clone, Debug)]
struct Pending {
    view: DisplayRequest,
    frame: String,
    page_id: u32,
    page_url: String,
}

#[derive(Debug, Default)]
pub struct ShareState {
    requests: HashMap<TabId, Pending>,
    pub shares: HashMap<TabId, TabShare>,
    picker_set: bool,
    capturing: HashSet<TabId>,
    previews: HashMap<TabId, (std::sync::Arc<gpui::Image>, std::time::Instant)>,
    previewing: HashSet<TabId>,
}

pub const TAB_PREVIEW_REFRESH: std::time::Duration = std::time::Duration::from_millis(5000);
pub const TAB_PREVIEW_DEADLINE: std::time::Duration = std::time::Duration::from_millis(4000);

pub fn audio_offer(message: &Value, support: &Value) -> Option<AudioOffer> {
    if message.get("audio").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let flag = |v: &Value, key: &str| v.get(key).and_then(Value::as_bool).unwrap_or(false);
    let system = flag(support, "system");
    let application = flag(support, "application");
    let window = match message.get("windowAudio").and_then(Value::as_str) {
        Some("window") if application => Some("application"),
        Some("window") if system => Some("system"),
        Some("system") if system => Some("system"),
        _ => None,
    };
    Some(AudioOffer {
        tab: true,
        screen: system && flag(message, "systemAudio"),
        window: window.map(str::to_owned),
    })
}

pub fn audio_for(offer: Option<&AudioOffer>, source: &str) -> Option<String> {
    let offer = offer?;
    if source.starts_with("screen:") {
        return offer.screen.then(|| "system".to_owned());
    }
    if source.starts_with("window:") {
        return offer.window.clone();
    }
    if source.starts_with("web-contents-media-stream://") {
        return offer.tab.then(|| "tab".to_owned());
    }
    None
}

fn origin_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .map(|u| u.origin().ascii_serialization())
        .filter(|o| o != "null")
        .unwrap_or_default()
}

fn without_fragment(url: &str) -> &str {
    url.split('#').next().unwrap_or(url)
}

impl AppCoordinator {
    pub(crate) fn note_share_event(&self, event: &EngineEvent) {
        match event {
            EngineEvent::PageMessage { tab, message } => {
                if let Some(tab) = self.state_tab(*tab) {
                    self.share_page_message(&tab, message);
                }
            }
            EngineEvent::MediaAccessChanged { tab, access } => {
                if let Some(tab) = self.state_tab(*tab) {
                    self.capture_changed(&tab, access.screen);
                }
            }
            EngineEvent::UrlChanged { tab, .. } => {
                if let Some(tab) = self.state_tab(*tab) {
                    self.cancel_on_navigation(&tab);
                }
            }
            _ => {}
        }
    }

    fn ensure_page_picker(&self) {
        if std::mem::replace(&mut self.bridge.lock().share.picker_set, true) {
            return;
        }
        if let Some(engine) = self.engine()
            && let Err(problem) =
                engine.global(GlobalCommand::SetPagesPickDisplayMedia { enabled: true })
        {
            log::debug!("pages couldn't take over the screen share picker: {problem}");
        }
    }

    fn call_frame(&self, tab: &TabId, frame: &str, kind: &str, json: String) {
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            return;
        };
        let command = if frame.is_empty() {
            TabCommand::CallPage {
                kind: kind.into(),
                json,
            }
        } else {
            TabCommand::CallFrame {
                frame: frame.into(),
                kind: kind.into(),
                json,
            }
        };
        if let Err(problem) = engine.tab_command(engine_tab, command) {
            log::debug!("{tab} didn't take {kind}: {problem}");
        }
    }

    fn share_page_message(&self, tab: &TabId, message: &PageMessage) {
        match message.kind.as_str() {
            "displayMediaHello" => {
                self.ensure_page_picker();
                self.call_frame(
                    tab,
                    &message.frame_id,
                    "config",
                    json!({ "displayMediaPicker": true }).to_string(),
                );
            }
            "displayMedia" => {
                self.ensure_page_picker();
                let Some(data) = message.data() else {
                    return;
                };
                let Some(page_id) = data.get("id").and_then(Value::as_f64).filter(|id| {
                    id.is_finite() && *id >= 1.0 && *id <= f64::from(i32::MAX) && id.fract() == 0.0
                }) else {
                    return;
                };
                let Some(sender) = message.origin.clone().filter(|o| !o.is_empty()) else {
                    return;
                };
                let support = self
                    .engine()
                    .and_then(|engine| engine.query(EngineQuery::DesktopCaptureAudio).ok())
                    .unwrap_or(Value::Null);
                let page_url = self
                    .store
                    .snapshot()
                    .tab(tab.as_str())
                    .map(|t| t.url.clone())
                    .unwrap_or_default();
                let page_origin = Some(origin_of(&page_url))
                    .filter(|o| !o.is_empty())
                    .unwrap_or_else(|| sender.clone());
                let stale = {
                    let mut bridge = self.bridge.lock();
                    if bridge.share.requests.len() >= MAX_PENDING
                        && !bridge.share.requests.contains_key(tab)
                    {
                        return;
                    }
                    let request = Pending {
                        view: DisplayRequest {
                            id: uuid::Uuid::new_v4().to_string(),
                            origin: page_origin,
                            frame_origin: sender,
                            audio: audio_offer(&data, &support),
                            controller: data.get("controller").and_then(Value::as_bool)
                                == Some(true),
                        },
                        frame: message.frame_id.clone(),
                        page_id: page_id as u32,
                        page_url,
                    };
                    bridge.share.requests.insert(tab.clone(), request)
                };
                if let Some(stale) = stale {
                    self.answer_page(tab, &stale, None, false);
                }
                self.signal.emit(HostTopics::PAGE);
            }
            _ => {}
        }
    }

    fn answer_page(&self, tab: &TabId, request: &Pending, source: Option<&str>, audio: bool) {
        self.call_frame(
            tab,
            &request.frame,
            "displayMedia",
            json!({ "id": request.page_id, "sourceId": source, "audio": audio }).to_string(),
        );
    }

    pub(crate) fn tab_preview_for(&self, tab: &TabId) -> Option<std::sync::Arc<gpui::Image>> {
        let (known, stale) = {
            let mut bridge = self.bridge.lock();
            let share = &mut bridge.share;
            let known = share.previews.get(tab).cloned();
            let stale = !share.previewing.contains(tab)
                && known
                    .as_ref()
                    .is_none_or(|(_, at)| at.elapsed() >= TAB_PREVIEW_REFRESH);
            if stale {
                share.previewing.insert(tab.clone());
            }
            (known.map(|(image, _)| image), stale)
        };
        if stale {
            self.capture_tab_preview(tab.clone());
        }
        known
    }

    fn capture_tab_preview(&self, tab: TabId) {
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(&tab), self.engine()) else {
            self.bridge.lock().share.previewing.remove(&tab);
            return;
        };
        let reply = engine.devtools_call(
            engine_tab,
            "Page.captureScreenshot",
            Some(json!({ "format": "jpeg", "quality": 70, "optimizeForSpeed": true })),
            TAB_PREVIEW_DEADLINE,
        );
        let me = self.weak();
        self.spawn(async move {
            let answer = reply.await;
            let Some(me) = me.upgrade() else {
                return;
            };
            let image = answer
                .ok()
                .and_then(|value| value.get("data").and_then(Value::as_str).map(str::to_owned))
                .and_then(|data| {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD.decode(data).ok()
                })
                .map(|bytes| {
                    std::sync::Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes))
                });
            {
                let mut bridge = me.bridge.lock();
                bridge.share.previewing.remove(&tab);
                if let Some(image) = image {
                    bridge
                        .share
                        .previews
                        .insert(tab, (image, std::time::Instant::now()));
                }
            }
            me.signal.emit(HostTopics::PAGE);
        });
    }

    pub(crate) fn display_request_for(&self, tab: &TabId) -> Option<DisplayRequest> {
        self.bridge
            .lock()
            .share
            .requests
            .get(tab)
            .map(|p| p.view.clone())
    }

    pub(crate) fn answer_display_request(
        &self,
        tab: &TabId,
        source: Option<String>,
        share_audio: bool,
    ) {
        let Some(request) = self.bridge.lock().share.requests.remove(tab) else {
            return;
        };
        let source = source
            .filter(|s| !s.is_empty())
            .filter(|s| crate::screen_capture::may_capture(s));
        let audio = source
            .as_deref()
            .filter(|_| share_audio)
            .and_then(|s| audio_for(request.view.audio.as_ref(), s));
        if let (Some(source), Some(engine_tab), Some(engine)) =
            (source.as_deref(), self.engine_tab(tab), self.engine())
        {
            let frame = (!request.frame.is_empty()).then_some(request.frame.as_str());
            if let Err(problem) = engine.allow_desktop_capture(
                source,
                engine_tab,
                frame,
                Some(&request.view.frame_origin),
                audio.as_deref(),
            ) {
                log::warn!("{tab} couldn't capture {source}: {problem}");
            }
        }
        self.answer_page(tab, &request, source.as_deref(), audio.is_some());
        self.signal.emit(HostTopics::PAGE);
    }

    pub(crate) fn share_tab_with(&self, tab: &TabId, shared: &TabId, audio: bool) {
        let Some(origin) = self
            .bridge
            .lock()
            .share
            .requests
            .get(tab)
            .map(|p| p.view.origin.clone())
        else {
            return;
        };
        let source = self
            .engine_tab(shared)
            .and_then(|engine_tab| self.engine()?.tab_info(engine_tab).ok())
            .and_then(|info| info.media_capture_source_id);
        if source.is_some() {
            self.bridge.lock().share.shares.insert(
                tab.clone(),
                TabShare {
                    captured: shared.clone(),
                    origin,
                    dismissed: HashSet::new(),
                },
            );
        }
        self.answer_display_request(tab, source, audio);
    }

    fn cancel_on_navigation(&self, tab: &TabId) {
        let url = self
            .store
            .snapshot()
            .tab(tab.as_str())
            .map(|t| t.url.clone());
        let moved = self.bridge.lock().share.requests.get(tab).is_some_and(|p| {
            url.as_deref()
                .is_some_and(|u| without_fragment(u) != without_fragment(&p.page_url))
        });
        if moved {
            self.answer_display_request(tab, None, false);
        }
    }

    fn capture_changed(&self, tab: &TabId, screen: bool) {
        let ended = {
            let mut bridge = self.bridge.lock();
            if screen {
                bridge.share.capturing.insert(tab.clone());
                false
            } else {
                bridge.share.capturing.remove(tab) && bridge.share.shares.contains_key(tab)
            }
        };
        if ended {
            let tab = tab.clone();
            self.share_after(std::time::Duration::from_millis(1500), move |me| {
                let gone = {
                    let mut bridge = me.bridge.lock();
                    let still = bridge.share.capturing.contains(&tab);
                    !still && bridge.share.shares.remove(&tab).is_some()
                };
                if gone {
                    me.signal.emit(HostTopics::PAGE);
                }
            });
        }
        self.signal.emit(HostTopics::PAGE);
    }

    fn share_after(
        &self,
        delay: std::time::Duration,
        job: impl FnOnce(&AppCoordinator) + Send + 'static,
    ) {
        let me = self.weak();
        let spawned = std::thread::Builder::new()
            .name("ardia-share-timer".into())
            .spawn(move || {
                std::thread::sleep(delay);
                if let Some(coordinator) = me.upgrade() {
                    coordinator.post(job);
                }
            });
        if let Err(problem) = spawned {
            log::debug!("a share timer didn't start: {problem}");
        }
    }

    pub(crate) fn share_bar_for(&self, tab: &TabId) -> Option<(TabId, TabShare)> {
        let state = self.store.snapshot();
        let viewed = state.tab(tab.as_str())?;
        let shareable = viewed.url.starts_with("http:")
            || viewed.url.starts_with("https:")
            || viewed.url.starts_with("file:");
        if !shareable {
            return None;
        }
        let engine_profile = |profile: &ardia_state::ProfileId| state.engine_profile(profile);
        let bridge = self.bridge.lock();
        bridge
            .share
            .shares
            .iter()
            .filter(|(capturer, share)| {
                bridge.share.capturing.contains(*capturer) && !share.dismissed.contains(tab)
            })
            .find(|(capturer, _)| {
                state.tab(capturer.as_str()).is_some_and(|owner| {
                    engine_profile(&owner.profile_id) == engine_profile(&viewed.profile_id)
                })
            })
            .map(|(capturer, share)| (capturer.clone(), share.clone()))
    }

    pub(crate) fn stop_sharing(&self, capturer: &TabId) {
        if let (Some(engine_tab), Some(engine)) = (self.engine_tab(capturer), self.engine())
            && let Err(problem) = engine.tab_action(engine_tab, TabAction::StopCapture)
        {
            log::debug!("{capturer} didn't stop capturing: {problem}");
        }
    }

    pub(crate) fn share_instead(&self, capturer: &TabId, tab: &TabId) {
        let (Some(target), Some(capturing), Some(engine)) = (
            self.engine_tab(tab),
            self.engine_tab(capturer),
            self.engine(),
        ) else {
            return;
        };
        if engine.share_tab_instead(target, capturing).unwrap_or(false) {
            if let Some(share) = self.bridge.lock().share.shares.get_mut(capturer) {
                share.captured = tab.clone();
                share.dismissed.clear();
            }
            self.signal.emit(HostTopics::PAGE);
        }
    }

    pub(crate) fn dismiss_share_bar(&self, capturer: &TabId, tab: &TabId) {
        if let Some(share) = self.bridge.lock().share.shares.get_mut(capturer) {
            share.dismissed.insert(tab.clone());
        }
        self.signal.emit(HostTopics::PAGE);
    }

    pub(crate) fn shared_tab(&self, tab: &TabId) -> bool {
        let bridge = self.bridge.lock();
        bridge.share.shares.iter().any(|(capturer, share)| {
            &share.captured == tab && bridge.share.capturing.contains(capturer)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_offers_follow_what_the_engine_can_capture() {
        let support = json!({ "system": true, "application": false });
        let offer = audio_offer(
            &json!({ "audio": true, "systemAudio": true, "windowAudio": "window" }),
            &support,
        )
        .unwrap();
        assert!(offer.tab && offer.screen);
        assert_eq!(offer.window.as_deref(), Some("system"));
        assert!(audio_offer(&json!({ "audio": false }), &support).is_none());
        let no_system =
            audio_offer(&json!({ "audio": true, "systemAudio": true }), &json!({})).unwrap();
        assert!(!no_system.screen && no_system.window.is_none());
        assert_eq!(
            audio_for(Some(&offer), "screen:1:0").as_deref(),
            Some("system")
        );
        assert_eq!(
            audio_for(Some(&offer), "web-contents-media-stream://1:2").as_deref(),
            Some("tab")
        );
        assert_eq!(audio_for(None, "screen:1:0"), None);
    }
}
