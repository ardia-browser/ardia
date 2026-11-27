use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ardia_state::ProfileId;
use ardia_state::air_traffic::SourceApp;
use ardia_ui::host_data::HostTopics;
use ardia_ui::settings::automations::{AppLink, ConnectProgress, DeviceCode, LiveConnect};
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use parking_lot::Mutex;
use serde_json::Value;

use crate::coordinator::AppCoordinator;

#[derive(Default)]
struct AppLinks {
    loaded: HashMap<ProfileId, Vec<AppLink>>,
    asked: HashSet<ProfileId>,
}

static APP_LINKS: Mutex<Option<AppLinks>> = Mutex::new(None);
static CONNECTING: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);
static RECENT_APPS: Mutex<Option<RecentApps>> = Mutex::new(None);

struct RecentApps {
    root: std::path::PathBuf,
    stamp: Option<(Option<std::time::SystemTime>, u64)>,
    apps: Vec<SourceApp>,
}

pub fn app_links_of(reply: &Value) -> Vec<AppLink> {
    reply
        .get("allowances")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
            Some(AppLink {
                origin: text("origin")?,
                scheme: text("scheme")?,
                app: text("app").filter(|a| !a.is_empty()),
                icon: text("icon").filter(|i| i.starts_with("data:")),
            })
        })
        .collect()
}

fn send(progress: &UnboundedSender<ConnectProgress>, step: ConnectProgress) {
    let _ = progress.unbounded_send(step);
}

fn begin_connecting() -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(previous) = CONNECTING.lock().replace(cancel.clone()) {
        previous.store(true, Ordering::Relaxed);
    }
    cancel
}

impl AppCoordinator {
    pub(crate) fn app_links_for(&self, profile: &ProfileId) -> Option<Vec<AppLink>> {
        let (cached, ask) = {
            let mut links = APP_LINKS.lock();
            let links = links.get_or_insert_with(AppLinks::default);
            (
                links.loaded.get(profile).cloned(),
                links.asked.insert(profile.clone()),
            )
        };
        if ask {
            self.fetch_app_links(profile.clone());
        }
        cached
    }

    fn fetch_app_links(&self, profile: ProfileId) {
        let me = self.weak();
        self.spawn(async move {
            let Some(me) = me.upgrade() else {
                return;
            };
            let (Some(engine), Some(dir)) = (me.engine(), me.service_profile_dir(&profile)) else {
                if let Some(links) = APP_LINKS.lock().as_mut() {
                    links.asked.remove(&profile);
                }
                return;
            };
            let reply = ardia_engine::Services::new(engine.as_ref(), &dir)
                .permissions()
                .external_app_allowances()
                .await;
            let found = match reply {
                Ok(value) => app_links_of(&value),
                Err(problem) => {
                    log::debug!("apps that open links for {profile} weren't read: {problem}");
                    Vec::new()
                }
            };
            if let Some(links) = APP_LINKS.lock().as_mut() {
                links.loaded.insert(profile, found);
            }
            me.signal.emit(HostTopics::PEOPLE);
        });
    }

    pub(crate) fn drop_app_link(&self, profile: ProfileId, origin: String, scheme: String) {
        let me = self.weak();
        self.spawn(async move {
            let Some(me) = me.upgrade() else {
                return;
            };
            let (Some(engine), Some(dir)) = (me.engine(), me.service_profile_dir(&profile)) else {
                return;
            };
            if let Err(problem) = ardia_engine::Services::new(engine.as_ref(), &dir)
                .permissions()
                .remove_external_app_allowance(&origin, &scheme)
                .await
            {
                log::warn!("an app link wasn't removed: {problem}");
            }
            if let Some(links) = APP_LINKS.lock().as_mut() {
                links.asked.remove(&profile);
            }
            me.fetch_app_links(profile);
        });
    }

    pub(crate) fn recent_link_apps(&self) -> Vec<SourceApp> {
        let Some(dir) = self.config.data_dir.as_deref() else {
            return Vec::new();
        };
        let dir = ardia_state::DataDir::new(dir.to_path_buf());
        let stamp = dir
            .path(ardia_state::persistence::documents::LINK_SOURCES)
            .ok()
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|meta| (meta.modified().ok(), meta.len()));
        let mut cached = RECENT_APPS.lock();
        if let Some(found) = cached.as_ref()
            && found.root == dir.root()
            && found.stamp == stamp
        {
            return found.apps.clone();
        }
        let apps = ardia_state::persistence::documents::load_recent_apps(&dir);
        *cached = Some(RecentApps {
            root: dir.root().to_path_buf(),
            stamp,
            apps: apps.clone(),
        });
        apps
    }

    pub(crate) fn start_live_connect(
        &self,
        request: LiveConnect,
    ) -> UnboundedReceiver<ConnectProgress> {
        let (progress, receiver) = unbounded();
        let Some(hub) = crate::live::hub().cloned() else {
            send(
                &progress,
                ConnectProgress::Done(Err("Couldn't connect".into())),
            );
            return receiver;
        };
        let cancel = begin_connecting();
        let spawned = std::thread::Builder::new()
            .name("live-connect".into())
            .spawn(move || {
                let result = match request {
                    LiveConnect::Token {
                        source,
                        token,
                        user,
                        site,
                    } => hub.connect(source, &token, user.as_deref(), site.as_deref()),
                    LiveConnect::GithubDevice { client_id } => {
                        hub.start_github_device(&client_id).and_then(|start| {
                            send(
                                &progress,
                                ConnectProgress::Code(DeviceCode {
                                    user_code: start.user_code.clone(),
                                    verification_uri: start.verification_uri.clone(),
                                }),
                            );
                            hub.finish_github_device(&client_id, &start, &cancel)
                        })
                    }
                    LiveConnect::Google {
                        window,
                        client_id,
                        secret,
                    } => hub.connect_google(&window, &client_id, &secret, &cancel),
                };
                send(
                    &progress,
                    ConnectProgress::Done(result.map_err(|error| error.message)),
                );
            });
        if let Err(problem) = spawned {
            log::warn!("couldn't start connecting an account: {problem}");
        }
        receiver
    }

    pub(crate) fn stop_live_connect(&self) {
        if let Some(cancel) = CONNECTING.lock().take() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn allowances_read_like_the_engine_reply() {
        let links = app_links_of(&json!({"allowances": [
            {"origin": "https://zoom.us", "scheme": "zoommtg", "app": "zoom.us", "icon": "data:image/png;base64,AA"},
            {"origin": "https://x.com", "scheme": "x", "app": null, "icon": null},
            {"scheme": "broken"}
        ]}));
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].app.as_deref(), Some("zoom.us"));
        assert_eq!(links[1].app, None);
        assert_eq!(links[1].icon, None);
    }
}
