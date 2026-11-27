use std::sync::Arc;

use ardia_engine::{BrowsingDataKind, Services};
use ardia_state::actions::Action;
use ardia_state::downloads::{Download, DownloadState};
use ardia_state::{ProfileId, WindowId};
use ardia_ui::{ClearBrowsingData, Confirmation, NativeMenuItem};
use futures::channel::oneshot;

use crate::coordinator::AppCoordinator;

pub fn browsing_data_kinds(request: &ClearBrowsingData) -> Vec<BrowsingDataKind> {
    let mut kinds = Vec::new();
    if request.history {
        kinds.push(BrowsingDataKind::History);
    }
    if request.site_data {
        kinds.push(BrowsingDataKind::SiteData);
        kinds.push(BrowsingDataKind::Cache);
    }
    kinds
}

pub const MAX_FILE_ICONS: usize = 256;

impl AppCoordinator {
    pub fn native_menu(&self, items: Vec<NativeMenuItem>) -> oneshot::Receiver<Option<String>> {
        let (answer, reply) = oneshot::channel();
        let test = std::env::var(crate::control_peer::TEST_ENV).ok();
        let test_file = crate::menu_test::test_file(
            self.config.scratch,
            self.config.data_dir.as_deref(),
            test.as_deref(),
        );
        if let Some(file) = test_file {
            let _ = answer.send(crate::menu_test::answer(&items, &file));
            return reply;
        }
        if self.config.background {
            log::info!(
                "pop-up menu (not shown): {}",
                crate::menu_test::describe(&items)
            );
        }
        self.spawn(async move {
            let _ = answer.send(crate::native_ui::popup_menu(&items));
        });
        reply
    }

    pub fn cached_file_icon(&self, path: &str, points: f32) -> Option<Arc<gpui::Image>> {
        let key = format!("{path}@{points}");
        if let Some(found) = self.bridge.lock().file_icons.get(&key) {
            return found.clone();
        }
        let icon = crate::native_ui::file_icon_png(path, f64::from(points))
            .map(|png| Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png, png)));
        let mut bridge = self.bridge.lock();
        if bridge.file_icons.len() >= MAX_FILE_ICONS {
            bridge.file_icons.clear();
        }
        bridge.file_icons.insert(key, icon.clone());
        icon
    }

    pub fn open_file_path(&self, path: &str) {
        #[cfg(target_os = "macos")]
        if let Err(problem) = ardia_engine::macos::platform::open_path(std::path::Path::new(path)) {
            log::warn!("couldn't open a download: {problem}");
        }
        #[cfg(not(target_os = "macos"))]
        log::info!("opening {path} isn't supported here yet");
    }

    pub fn trash_path(&self, path: &str) -> oneshot::Receiver<bool> {
        let (answer, reply) = oneshot::channel();
        let _ = answer.send(crate::native_ui::move_to_trash(path));
        reply
    }

    pub fn toggle_opening_when_done(&self, id: String) {
        let mut bridge = self.bridge.lock();
        if !bridge.open_when_done.remove(&id) {
            bridge.open_when_done.insert(id);
        }
    }

    pub fn opening_when_done(&self, id: &str) -> bool {
        self.bridge.lock().open_when_done.contains(id)
    }

    pub(crate) fn open_if_done(&self, download: &Download) {
        note_download_flow(download);
        if download.state == DownloadState::Downloading {
            return;
        }
        let wanted = self
            .bridge
            .lock()
            .open_when_done
            .remove(download.id.as_str());
        if wanted && download.state == DownloadState::Finished && !download.path.is_empty() {
            self.open_file_path(&download.path);
        }
    }

    pub(crate) fn forget_history_in_engine(&self, profile: &ProfileId, urls: &[String]) {
        if urls.is_empty() || profile.is_incognito() {
            return;
        }
        let (Some(engine), Some(profile_dir)) = (self.engine(), self.service_profile_dir(profile))
        else {
            return;
        };
        let reply = Services::new(engine.as_ref(), &profile_dir)
            .history()
            .delete_urls(urls);
        self.spawn(async move {
            if let Err(problem) = reply.await {
                log::warn!("history pages weren't removed from the engine: {problem}");
            }
        });
    }

    pub fn prompt_in(
        &self,
        window: &WindowId,
        prompt: ardia_ui::TextPrompt,
    ) -> oneshot::Receiver<Option<String>> {
        let (answer, reply) = oneshot::channel();
        let test = std::env::var(crate::control_peer::TEST_ENV).ok();
        if let Some(file) = crate::menu_test::dialog_test_file(
            self.config.scratch,
            self.config.data_dir.as_deref(),
            test.as_deref(),
        ) {
            let _ = answer.send(crate::menu_test::prompt_answer(&prompt, &file));
            return reply;
        }
        #[cfg(target_os = "macos")]
        {
            use ardia_engine::macos::dialogs::Alert;
            let alert = Alert::prompt(
                &prompt.title,
                &prompt.message,
                &prompt.value,
                &prompt.placeholder,
                &prompt.confirm,
            );
            let parent = self
                .config
                .hosts_native_windows
                .then(|| self.engine_window(window))
                .flatten()
                .and_then(|engine_window| {
                    self.engine()
                        .and_then(|engine| engine.native_window_handle(engine_window).ok())
                });
            let shown = alert.show(parent.as_ref());
            self.spawn(async move {
                let typed = shown
                    .await
                    .ok()
                    .filter(|response| response.chose(0))
                    .and_then(|response| response.entered_text().map(str::to_owned));
                let _ = answer.send(typed);
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (window, prompt);
            let _ = answer.send(None);
        }
        reply
    }

    #[cfg(target_os = "macos")]
    pub fn ask_attached(
        &self,
        window: &mut gpui::Window,
        question: Confirmation,
    ) -> oneshot::Receiver<bool> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let parent = HasWindowHandle::window_handle(window)
            .ok()
            .and_then(|handle| match handle.as_raw() {
                RawWindowHandle::AppKit(appkit) => {
                    let view = appkit.ns_view.as_ptr().cast::<objc2::runtime::AnyObject>();
                    let ns_window: *mut objc2::runtime::AnyObject =
                        unsafe { objc2::msg_send![view, window] };
                    if ns_window.is_null() {
                        None
                    } else {
                        unsafe { ardia_engine::macos::retain_window(ns_window.cast()) }
                    }
                }
                _ => None,
            });
        self.ask_with_parent(parent, question)
    }

    #[cfg(target_os = "macos")]
    fn ask_with_parent(
        &self,
        parent: Option<ardia_engine::NativeWindow>,
        question: Confirmation,
    ) -> oneshot::Receiver<bool> {
        use ardia_engine::macos::dialogs::Alert;
        let (answer, reply) = oneshot::channel();
        let mut alert = Alert::confirm(
            &question.title,
            &question.message,
            &question.confirm,
            "Cancel",
        );
        if question.destructive {
            alert = alert.destructive();
        }
        let shown = alert.show(parent.as_ref());
        self.spawn(async move {
            let _ = answer.send(shown.await.is_ok_and(|choice| choice.chose(0)));
        });
        reply
    }

    pub fn ask_in_window(
        &self,
        window: &WindowId,
        question: Confirmation,
    ) -> oneshot::Receiver<bool> {
        let (answer, reply) = oneshot::channel();
        #[cfg(target_os = "macos")]
        {
            use ardia_engine::macos::dialogs::Alert;
            let mut alert = Alert::confirm(
                &question.title,
                &question.message,
                &question.confirm,
                "Cancel",
            );
            if question.destructive {
                alert = alert.destructive();
            }
            let parent = self
                .config
                .hosts_native_windows
                .then(|| self.engine_window(window))
                .flatten()
                .and_then(|engine_window| {
                    self.engine()
                        .and_then(|engine| engine.native_window_handle(engine_window).ok())
                });
            let shown = alert.show(parent.as_ref());
            self.spawn(async move {
                let _ = answer.send(shown.await.is_ok_and(|choice| choice.chose(0)));
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (window, question);
            log::warn!("there's no dialog to ask in on this platform");
            let _ = answer.send(false);
        }
        reply
    }

    pub fn clear_browsing_data_for(
        &self,
        profile: ProfileId,
        request: ClearBrowsingData,
    ) -> oneshot::Receiver<bool> {
        let (answer, reply) = oneshot::channel();
        let kinds = browsing_data_kinds(&request);
        if kinds.is_empty() {
            let _ = answer.send(false);
            return reply;
        }
        let engine_side = (!profile.is_incognito())
            .then(|| self.engine().zip(self.engine_profile(&profile)))
            .flatten();
        let cleared = match engine_side {
            Some((engine, engine_profile)) => Some(engine.clear_browsing_data(
                engine_profile,
                &kinds,
                request.since.map(|ms| ms as f64),
            )),
            None if profile.is_incognito() => None,
            None => {
                let _ = answer.send(false);
                return reply;
            }
        };
        let me = self.weak();
        let consent = ardia_telemetry::consent_now();
        self.spawn(async move {
            if let Some(cleared) = cleared {
                let ok = cleared.await;
                ardia_telemetry::counts::add_for(
                    consent.as_ref(),
                    if ok.is_ok() {
                        "browsing_data_clears"
                    } else {
                        "browsing_data_clear_failures"
                    },
                    1,
                );
                if let Err(problem) = ok {
                    log::warn!("browsing data wasn't cleared: {problem}");
                    let _ = answer.send(false);
                    return;
                }
            }
            if request.history
                && let Some(me) = me.upgrade()
            {
                me.dispatch_quietly(Action::ClearHistory {
                    profile,
                    since: request.since,
                    until: request.started_at,
                });
            }
            let _ = answer.send(true);
        });
        reply
    }
}

struct DownloadFlow {
    state: DownloadState,
    first_seen_ms: f64,
    interrupted: bool,
}

static DOWNLOAD_FLOWS: parking_lot::Mutex<Option<std::collections::HashMap<String, DownloadFlow>>> =
    parking_lot::Mutex::new(None);

fn download_speed_field(bytes: f64, ms: f64) -> Option<&'static str> {
    if bytes.is_nan() || ms.is_nan() || bytes < 1_048_576.0 || ms < 1_000.0 {
        return None;
    }
    let per_second = bytes / (ms / 1000.0);
    Some(if per_second < 100.0 * 1024.0 {
        "download_speeds_under_100kbs"
    } else if per_second < 1024.0 * 1024.0 {
        "download_speeds_under_1mbs"
    } else if per_second < 10.0 * 1024.0 * 1024.0 {
        "download_speeds_under_10mbs"
    } else {
        "download_speeds_10mbs_up"
    })
}

fn note_download_flow(download: &Download) {
    use ardia_telemetry::counts::count;
    let now = ardia_state::store::now_ms() as f64;
    let mut flows = DOWNLOAD_FLOWS.lock();
    let flows = flows.get_or_insert_with(std::collections::HashMap::new);
    let id = download.id.as_str();
    let Some(before) = flows.get_mut(id) else {
        if download.state != DownloadState::Downloading {
            return;
        }
        if flows.len() >= 200
            && let Some(oldest) = flows.keys().next().cloned()
        {
            flows.remove(&oldest);
        }
        flows.insert(
            id.to_owned(),
            DownloadFlow {
                state: download.state,
                first_seen_ms: now,
                interrupted: download.received > 0.0 || download.paused,
            },
        );
        count("downloads_started");
        return;
    };
    if download.paused {
        before.interrupted = true;
    }
    if before.state == download.state {
        return;
    }
    before.state = download.state;
    match download.state {
        DownloadState::Downloading => return,
        DownloadState::Failed => {
            before.interrupted = true;
            count("downloads_failed");
            return;
        }
        _ => {}
    }
    let Some(done) = flows.remove(id) else {
        return;
    };
    if download.state != DownloadState::Finished {
        return;
    }
    count("downloads_finished");
    if done.interrupted {
        return;
    }
    let started = download
        .start_time
        .filter(|at| at.is_finite() && *at > 1e12 && *at <= now)
        .unwrap_or(done.first_seen_ms);
    if let Some(speed) = download_speed_field(download.received, now - started) {
        count("downloads_timed");
        count(speed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_data_clears_cookies_and_cache() {
        let request = ClearBrowsingData {
            history: false,
            site_data: true,
            since: None,
            started_at: 0,
        };
        assert_eq!(
            browsing_data_kinds(&request),
            vec![BrowsingDataKind::SiteData, BrowsingDataKind::Cache]
        );
    }
}
