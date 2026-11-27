use std::sync::Arc;
use std::time::Instant;

use ardia_state::{ProfileId, TabId};
use ardia_theme::IconTheme;
use gpui::Image;

use crate::coordinator::AppCoordinator;
use crate::favicons::{self, DiskJob, DiskResult, IconEntry, IconRequest};

impl AppCoordinator {
    pub fn favicon_image(&self, profile: &ProfileId, url: &str) -> Option<Arc<Image>> {
        if !favicons::is_remote(url) {
            return None;
        }
        {
            let bridge = self.bridge.lock();
            if let Some(entry) = bridge.icons.get(url) {
                return Some(Arc::clone(&entry.image));
            }
            if profile.is_incognito() || bridge.icons.status(url, Instant::now()).is_some() {
                return None;
            }
        }
        let (profile, url) = (profile.clone(), url.to_owned());
        self.post(move |coordinator| {
            coordinator.request_icon(&profile, &url);
        });
        None
    }

    pub fn favicon_inker(&self, url: &str) -> Option<ardia_ui::primitives::favicon::FaviconInker> {
        self.bridge.lock().icons.get(url)?.template.as_ref()?;
        let me = self.weak();
        let url = url.to_owned();
        Some(ardia_ui::primitives::favicon::FaviconInker::new(
            move |color| me.upgrade()?.bridge.lock().icons.inked(&url, color),
        ))
    }

    pub(crate) fn cached_icon_theme(&self, url: &str) -> Option<IconTheme> {
        self.bridge.lock().icons.get(url).map(|entry| entry.theme)
    }

    pub(crate) fn request_icon(&self, profile: &ProfileId, url: &str) -> IconRequest {
        if profile.is_incognito() || !favicons::is_remote(url) {
            return IconRequest::FailedRecently;
        }
        let request = self.bridge.lock().icons.begin(url, Instant::now());
        if request != IconRequest::Started {
            return request;
        }
        self.load_stored_icon(profile, url);
        IconRequest::Started
    }

    fn load_stored_icon(&self, profile: &ProfileId, url: &str) {
        let queued = self.icon_disk.as_ref().is_some_and(|disk| {
            disk.send(DiskJob::Load {
                url: url.to_owned(),
                profile: profile.as_str().to_owned(),
            })
        });
        if !queued {
            self.fetch_remote_icon(profile, url);
        }
    }

    fn fetch_remote_icon(&self, profile: &ProfileId, url: &str) {
        let claimed = self
            .bridge
            .lock()
            .icons
            .claim_fetch(profile.as_str().to_owned(), url.to_owned());
        if claimed {
            self.run_icon_fetch(profile, url);
        }
    }

    fn run_icon_fetch(&self, profile: &ProfileId, url: &str) {
        let (Some(engine), Some(engine_profile)) = (self.engine(), self.engine_profile(profile))
        else {
            self.bridge.lock().icons.abandon(url);
            self.next_icon_fetch();
            return;
        };
        let reply = engine.fetch_icon(engine_profile, url, favicons::MAX_ICON_BYTES);
        let me = self.weak();
        let url = url.to_owned();
        self.spawn(async move {
            let bytes = reply.await.ok().flatten();
            if let Some(me) = me.upgrade() {
                me.icon_bytes_arrived(url, bytes);
                me.next_icon_fetch();
            }
        });
    }

    fn next_icon_fetch(&self) {
        let next = self.bridge.lock().icons.release_fetch();
        if let Some((profile, url)) = next {
            self.run_icon_fetch(&ProfileId::new(profile), &url);
        }
    }

    fn icon_bytes_arrived(&self, url: String, bytes: Option<Vec<u8>>) {
        ardia_telemetry::counts::count("page_favicon_downloads");
        let Some(bytes) = bytes.filter(|bytes| !bytes.is_empty()) else {
            ardia_telemetry::counts::count("page_favicon_downloads_empty");
            self.icon_settled(&url, None);
            return;
        };
        match self.icon_disk.as_ref() {
            Some(disk) => {
                if !disk.send(DiskJob::Store {
                    url: url.clone(),
                    bytes,
                }) {
                    self.icon_settled(&url, None);
                }
            }
            None => self.icon_settled(&url, favicons::prepare(&bytes)),
        }
    }

    pub(crate) fn disk_icon_result(&self, result: DiskResult) {
        match result {
            DiskResult::Hit { url, entry } => self.icon_settled(&url, Some(entry)),
            DiskResult::Miss { url, profile } => {
                self.fetch_remote_icon(&ProfileId::new(profile), &url)
            }
            DiskResult::Stored { url, entry } => self.icon_settled(&url, entry),
        }
    }

    fn icon_settled(&self, url: &str, entry: Option<IconEntry>) {
        let theme = entry
            .as_ref()
            .map_or(IconTheme::Default, |entry| entry.theme);
        let tabs: Vec<TabId> = {
            let mut bridge = self.bridge.lock();
            bridge.icons.settle(url, entry, Instant::now());
            bridge
                .icon_urls
                .iter()
                .filter(|(_, wanted)| wanted.as_str() == url)
                .map(|(tab, _)| tab.clone())
                .collect()
        };
        for tab in &tabs {
            self.set_icon_theme(tab, Some(theme));
        }
        for window in self.store.snapshot().window_order.iter() {
            self.touch(window.clone());
        }
        self.wake();
    }
}
