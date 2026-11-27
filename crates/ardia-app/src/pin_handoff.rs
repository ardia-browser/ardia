use std::sync::Arc;
use std::time::Duration;

use ardia_engine::{BrowserEngine, EngineTabId};
use ardia_state::pin_handoff::{CAPTURE_DEADLINE, HandoffRequest, PAINT_DEADLINE, PinHandoffs};
use ardia_state::{Action, BrowserState, TabId, WindowId};
use ardia_ui::host_data::HostTopics;
use base64::Engine as _;
use gpui::{Image, ImageFormat};
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;

pub type Handoffs = PinHandoffs<Arc<Image>>;

pub const STILL_QUALITY: u8 = 80;

pub fn still_from_reply(reply: &Value) -> Option<Arc<Image>> {
    let data = reply.get("data")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()
        .filter(|b| !b.is_empty())?;
    Some(Arc::new(Image::from_bytes(ImageFormat::Jpeg, bytes)))
}

async fn capture_still(engine: Arc<dyn BrowserEngine>, tab: EngineTabId) -> Option<Arc<Image>> {
    let reply = engine
        .devtools_call(
            tab,
            "Page.captureScreenshot",
            Some(json!({ "format": "jpeg", "quality": STILL_QUALITY, "captureBeyondViewport": false })),
            CAPTURE_DEADLINE,
        )
        .await;
    match reply {
        Ok(answer) => still_from_reply(&answer),
        Err(problem) => {
            log::debug!("the pinned page's picture wasn't taken: {problem}");
            None
        }
    }
}

impl AppCoordinator {
    pub(crate) fn hands_off_pin(&self, tab: &TabId) -> bool {
        let state = self.store.snapshot();
        let request = {
            let mut bridge = self.bridge.lock();
            if bridge.pin_handoffs.is_committing(tab) || !Handoffs::needs_handoff(&state, tab) {
                return false;
            }
            bridge.pin_handoffs.begin(&state, tab)
        };
        let Some(request) = request else {
            return false;
        };
        let capture = if request.on_screen {
            self.engine().zip(self.engine_tab(&request.holder))
        } else {
            None
        };
        let me = self.weak();
        self.spawn(async move {
            let picture = match capture {
                Some((engine, engine_tab)) => capture_still(engine, engine_tab).await,
                None => None,
            };
            if let Some(me) = me.upgrade() {
                me.picture_taken(request, state, picture);
            }
        });
        true
    }

    fn still_current(&self, request: &HandoffRequest, begun: &BrowserState) -> bool {
        let now = self.store.snapshot();
        let mut bridge = self.bridge.lock();
        bridge.pin_handoffs.note_windows(&now, begun);
        bridge.pin_handoffs.is_current(request, &now)
    }

    fn picture_taken(
        &self,
        request: HandoffRequest,
        begun: Arc<BrowserState>,
        picture: Option<Arc<Image>>,
    ) {
        if !self.still_current(&request, &begun) {
            self.bridge.lock().pin_handoffs.settle(&request);
            return;
        }
        if let Some(picture) = picture {
            let now = self.store.snapshot();
            let holder_stays = now
                .tab(request.holder.as_str())
                .is_some_and(|t| t.window_id == request.source);
            {
                let mut bridge = self.bridge.lock();
                bridge
                    .pin_handoffs
                    .keep_frame(&request.copy, Arc::clone(&picture));
                if request.on_screen && holder_stays {
                    bridge
                        .pin_handoffs
                        .bridge(&request.source, &request.copy, picture);
                }
            }
            if request.on_screen && holder_stays {
                self.signal.emit(HostTopics::PAGE);
                let me = self.weak();
                let spawned = std::thread::Builder::new()
                    .name("ardia-pin-handoff".into())
                    .spawn(move || {
                        std::thread::sleep(paint_wait());
                        if let Some(me) = me.upgrade() {
                            me.post(move |me| me.commit_handoff(request, begun));
                        }
                    });
                if let Err(problem) = spawned {
                    log::debug!("the pinned page handoff timer didn't start: {problem}");
                }
                return;
            }
        }
        self.commit_handoff(request, begun);
    }

    fn commit_handoff(&self, request: HandoffRequest, begun: Arc<BrowserState>) {
        let still = self.still_current(&request, &begun);
        self.bridge.lock().pin_handoffs.settle(&request);
        if still {
            self.bridge
                .lock()
                .pin_handoffs
                .committing(Some(request.copy.clone()));
            let done = self.dispatch_action(Action::ActivateTab {
                tab: request.copy.clone(),
            });
            self.bridge.lock().pin_handoffs.committing(None);
            if let Err(problem) = done {
                log::debug!("the pinned page didn't move: {problem}");
            }
        }
        let unbridged = self
            .bridge
            .lock()
            .pin_handoffs
            .unbridge(&request.source, &request.copy);
        if unbridged {
            self.signal.emit(HostTopics::PAGE);
        }
    }

    pub(crate) fn note_page_opened(&self, tab: &ardia_state::tabs::Tab) {
        if tab.page.has_page() || tab.url.is_empty() {
            return;
        }
        let update = ardia_state::PageUpdate {
            url: Some(tab.url.clone()),
            ..ardia_state::PageUpdate::default()
        };
        let id = tab.id.clone();
        self.post(move |me| {
            me.dispatch_quietly(Action::UpdatePage { tab: id, update });
        });
    }

    pub fn frozen_picture_in(&self, window: &WindowId) -> Option<Arc<Image>> {
        let state = self.store.snapshot();
        let mut bridge = self.bridge.lock();
        bridge.pin_handoffs.forget_stale(&state);
        bridge.pin_handoffs.picture_in(&state, window)
    }
}

fn paint_wait() -> Duration {
    PAINT_DEADLINE.min(Duration::from_millis(34))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshots_decode_from_devtools_replies() {
        let jpeg = base64::engine::general_purpose::STANDARD.encode([0xFF, 0xD8, 0xFF, 0xD9]);
        let still = still_from_reply(&json!({ "data": jpeg })).unwrap();
        assert_eq!(still.format(), ImageFormat::Jpeg);
        assert!(still_from_reply(&json!({ "data": "%%%" })).is_none());
        assert!(still_from_reply(&json!({ "data": "" })).is_none());
        assert!(still_from_reply(&json!({})).is_none());
        assert!(paint_wait() <= PAINT_DEADLINE);
    }
}
