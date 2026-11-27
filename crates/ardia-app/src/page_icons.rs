use std::collections::HashMap;
use std::sync::Arc;

use ardia_engine::Services;
use ardia_state::ProfileId;
use base64::Engine as _;
use gpui::Image;
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;
use crate::favicons;

pub const PAGE_ICON_BATCH: usize = 100;
pub const PAGE_ICON_SIZE: u32 = 32;
pub const MAX_PAGE_ICONS: usize = 4096;

pub fn page_key(url: &str) -> &str {
    url.split_once('#').map_or(url, |(page, _)| page)
}

pub fn page_icons_from(answer: &Value) -> HashMap<String, Vec<u8>> {
    let Some(pages) = answer.get("pages").and_then(Value::as_object) else {
        return HashMap::new();
    };
    pages
        .iter()
        .filter_map(|(page, found)| {
            let png = found.get("png").and_then(Value::as_str)?;
            if png.len() > favicons::MAX_ICON_BYTES * 4 / 3 + 4 {
                return None;
            }
            let bytes = base64::engine::general_purpose::STANDARD.decode(png).ok()?;
            Some((page.clone(), bytes))
        })
        .collect()
}

pub fn page_icon_key(profile: &ProfileId, url: &str) -> String {
    format!("{profile}|{}", page_key(url))
}

pub fn inked_page_icon_key(key: &str) -> String {
    format!("page|{key}")
}

impl AppCoordinator {
    pub fn page_favicon(&self, profile: &ProfileId, url: &str) -> Option<Arc<Image>> {
        if profile.is_incognito() || url.is_empty() {
            return None;
        }
        let page = page_key(url).to_owned();
        let key = page_icon_key(profile, url);
        {
            let mut bridge = self.bridge.lock();
            if let Some(found) = bridge.page_icons.get(&key) {
                return found.clone();
            }
            if bridge.page_icons.len() >= MAX_PAGE_ICONS {
                bridge.page_icons.clear();
            }
            bridge.page_icons.insert(key, None);
            let first = bridge.page_icon_queue.is_empty();
            bridge
                .page_icon_queue
                .entry(profile.clone())
                .or_default()
                .push(page);
            if !first {
                return None;
            }
        }
        self.post(|coordinator| coordinator.look_up_page_icons());
        None
    }

    pub fn page_favicon_inker(
        &self,
        profile: &ProfileId,
        url: &str,
    ) -> Option<ardia_ui::primitives::favicon::FaviconInker> {
        let inked = inked_page_icon_key(&page_icon_key(profile, url));
        self.bridge.lock().icons.get(&inked)?.template.as_ref()?;
        let me = self.weak();
        Some(ardia_ui::primitives::favicon::FaviconInker::new(
            move |color| me.upgrade()?.bridge.lock().icons.inked(&inked, color),
        ))
    }

    fn look_up_page_icons(&self) {
        let queued: Vec<(ProfileId, Vec<String>)> =
            self.bridge.lock().page_icon_queue.drain().collect();
        let Some(engine) = self.engine() else {
            return;
        };
        for (profile, pages) in queued {
            let Some(profile_dir) = self.service_profile_dir(&profile) else {
                continue;
            };
            for batch in pages.chunks(PAGE_ICON_BATCH) {
                let reply = Services::new(engine.as_ref(), &profile_dir).call(
                    "ac_favicons_get",
                    json!({ "pages": batch, "icons": [], "size": PAGE_ICON_SIZE }),
                );
                let me = self.weak();
                let profile = profile.clone();
                self.spawn(async move {
                    let answer = match reply.await {
                        Ok(answer) => answer,
                        Err(problem) => {
                            log::debug!("page icons weren't read: {problem}");
                            return;
                        }
                    };
                    let Some(me) = me.upgrade() else {
                        return;
                    };
                    let found = page_icons_from(&answer);
                    if found.is_empty() {
                        return;
                    }
                    {
                        let mut bridge = me.bridge.lock();
                        for (page, bytes) in found {
                            let key = page_icon_key(&profile, &page);
                            let entry = favicons::prepare(&bytes);
                            let image = entry.as_ref().map(|entry| Arc::clone(&entry.image));
                            if let Some(entry) = entry.filter(|entry| entry.template.is_some()) {
                                bridge.icons.settle(
                                    &inked_page_icon_key(&key),
                                    Some(entry),
                                    std::time::Instant::now(),
                                );
                            }
                            bridge.page_icons.insert(key, image);
                        }
                    }
                    for window in me.store.snapshot().window_order.iter() {
                        me.touch(window.clone());
                    }
                    me.wake();
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_icon_replies_decode_and_skip_garbage() {
        let png = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        let answer = json!({ "pages": {
            "https://a.example/": { "png": png, "icon": "https://a.example/i.png" },
            "https://b.example/": { "png": "@@@" },
            "https://c.example/": {}
        }});
        let found = page_icons_from(&answer);
        assert_eq!(found.len(), 1);
        assert_eq!(found["https://a.example/"], vec![1, 2, 3]);
        assert!(page_icons_from(&json!({})).is_empty());
        assert_eq!(page_key("https://a.example/x#top"), "https://a.example/x");
    }

    #[test]
    fn page_icon_keys_drop_the_fragment_and_name_the_profile() {
        let profile = ProfileId::new("p1");
        assert_eq!(
            page_icon_key(&profile, "https://a.example/x#top"),
            "p1|https://a.example/x"
        );
        assert_eq!(
            inked_page_icon_key("p1|https://a.example/x"),
            "page|p1|https://a.example/x"
        );
    }
}
