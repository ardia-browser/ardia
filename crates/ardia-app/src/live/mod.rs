pub mod oauth;
pub mod sources;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use ardia_state::live::{
    CompletionState, FolderError, FolderState, LiveCommand, LiveError, LiveErrorKind, LiveFolder,
    LiveItem, LiveSourceId, LiveState, order_items, repo_key,
};
use ardia_state::model::LiveItem as TabLiveItem;
use ardia_state::{Action, BrowserStore, NewTab, TabId, WindowId};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::net::Transport;
use crate::secrets::SecretStore;
use sources::{Endpoints, GithubClient, Net};

pub const CANONICAL_DOC: &str = "live.canonical.json";
pub const LEGACY_DOC: &str = "live.json";
const TICK: Duration = Duration::from_secs(30);
const STARTUP_DELAY_MS: i64 = 2500;
const SAVE_DELAY_MS: i64 = 800;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub type Notify = Arc<dyn Fn() + Send + Sync>;
pub type MainWork = Box<dyn FnOnce(&LiveHub) + Send>;
pub type MainRunner = Arc<dyn Fn(MainWork) + Send + Sync>;

enum Job {
    Refresh { folder: String, interactive: bool },
    Focus,
    Wake,
}

pub struct LiveHub {
    state: Mutex<Arc<LiveState>>,
    envelope: Mutex<Map<String, Value>>,
    dir: Option<PathBuf>,
    secrets: SecretStore,
    transport: Option<Arc<dyn Transport>>,
    endpoints: Endpoints,
    github: Mutex<GithubClient>,
    jobs: Mutex<Option<Sender<Job>>>,
    timers: Mutex<Vec<(i64, Timer)>>,
    notify: Mutex<Vec<Notify>>,
    store: Option<Arc<BrowserStore>>,
    counter: AtomicU64,
    inflight: Mutex<HashSet<String>>,
    main: Mutex<Option<MainRunner>>,
}

#[derive(Clone, Debug, PartialEq)]
enum Timer {
    Finish { folder: String, ids: Vec<String> },
    Save,
    Startup,
}

fn read_doc(dir: &std::path::Path) -> (Map<String, Value>, Value) {
    if let Ok(bytes) = std::fs::read(dir.join(CANONICAL_DOC))
        && let Ok(Value::Object(envelope)) = serde_json::from_slice::<Value>(&bytes)
    {
        let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);
        return (envelope, payload);
    }
    let legacy = std::fs::read(dir.join(LEGACY_DOC))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or(Value::Null);
    (Map::new(), legacy)
}

impl LiveHub {
    pub fn new(
        dir: Option<PathBuf>,
        secrets: SecretStore,
        transport: Option<Arc<dyn Transport>>,
        endpoints: Endpoints,
        store: Option<Arc<BrowserStore>>,
    ) -> Arc<LiveHub> {
        let (envelope, payload) = dir.as_deref().map(read_doc).unwrap_or_default();
        let state = LiveState::from_saved(payload, now_ms());
        Arc::new(LiveHub {
            state: Mutex::new(Arc::new(state)),
            envelope: Mutex::new(envelope),
            dir,
            secrets,
            transport,
            endpoints,
            github: Mutex::new(GithubClient::default()),
            jobs: Mutex::new(None),
            timers: Mutex::new(Vec::new()),
            notify: Mutex::new(Vec::new()),
            store,
            counter: AtomicU64::new(0),
            inflight: Mutex::new(HashSet::new()),
            main: Mutex::new(None),
        })
    }

    pub fn set_main_runner(&self, runner: MainRunner) {
        *self.main.lock() = Some(runner);
    }

    pub(crate) fn on_main(&self, work: MainWork) {
        let runner = self.main.lock().clone();
        match runner {
            Some(runner) => runner(work),
            None => work(self),
        }
    }

    pub fn snapshot(&self) -> Arc<LiveState> {
        Arc::clone(&self.state.lock())
    }

    pub fn subscribe(&self, notify: Notify) {
        self.notify.lock().push(notify);
    }

    fn changed(&self, persist: bool) {
        if persist {
            self.schedule(now_ms() + SAVE_DELAY_MS, Timer::Save);
        }
        let listeners: Vec<Notify> = self.notify.lock().clone();
        for listener in listeners {
            listener();
        }
    }

    pub fn update<R>(&self, persist: bool, change: impl FnOnce(&mut LiveState) -> R) -> R {
        let out = {
            let mut guard = self.state.lock();
            let state = Arc::make_mut(&mut guard);
            change(state)
        };
        self.changed(persist);
        out
    }

    fn schedule(&self, at: i64, timer: Timer) {
        let mut timers = self.timers.lock();
        if timer == Timer::Save && timers.iter().any(|(_, t)| *t == Timer::Save) {
            timers.retain(|(_, t)| *t != Timer::Save);
        }
        timers.push((at, timer));
        drop(timers);
        self.send(Job::Wake);
    }

    fn send(&self, job: Job) {
        if let Some(jobs) = self.jobs.lock().as_ref() {
            let _ = jobs.send(job);
        }
    }

    pub fn save_now(&self) -> bool {
        let Some(dir) = &self.dir else {
            return false;
        };
        let payload = self.snapshot().saved();
        let mut envelope = self.envelope.lock();
        let revision = envelope
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        envelope.entry("format").or_insert(json!(1));
        envelope.insert("revision".into(), json!(revision));
        envelope.insert("payload".into(), payload);
        for key in [
            "clients",
            "generations",
            "incarnations",
            "owners",
            "tombstones",
        ] {
            envelope.entry(key).or_insert(json!({}));
        }
        envelope
            .entry("epoch")
            .or_insert_with(|| json!(uuid::Uuid::new_v4().to_string()));
        let Ok(bytes) = serde_json::to_vec(&Value::Object(envelope.clone())) else {
            return false;
        };
        let temp = dir.join(format!("{CANONICAL_DOC}.tmp"));
        let written = std::fs::write(&temp, bytes).is_ok()
            && std::fs::rename(&temp, dir.join(CANONICAL_DOC)).is_ok();
        if written {
            ardia_telemetry::counts::count("live_saves_written");
        }
        written
    }

    pub fn start(self: &Arc<Self>) {
        let (sender, receiver) = channel();
        *self.jobs.lock() = Some(sender);
        self.schedule(now_ms() + STARTUP_DELAY_MS, Timer::Startup);
        let hub = Arc::downgrade(self);
        let spawned = std::thread::Builder::new()
            .name("ardia-live".into())
            .spawn(move || worker(hub, receiver));
        if let Err(problem) = spawned {
            log::warn!("live folders couldn't start: {problem}");
        }
        self.sync_tabs();
    }

    pub fn stop(&self) {
        self.jobs.lock().take();
        self.save_now();
    }

    pub fn note_focus(&self) {
        self.send(Job::Focus);
    }

    pub fn paused_until(&self, source: LiveSourceId) -> Option<i64> {
        (source == LiveSourceId::Github)
            .then(|| self.github.lock().paused_until(now_ms()))
            .flatten()
    }

    pub fn status_text(&self, folder: &str) -> String {
        let now = now_ms();
        let source = self
            .snapshot()
            .status
            .get(folder)
            .and_then(|s| s.error.as_ref().map(|e| e.source));
        self.snapshot()
            .status_text(folder, now, source.and_then(|s| self.paused_until(s)))
    }

    fn new_folder_id(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("lf-{}-{}", radix36(now_ms() as u64), radix36(n))
    }

    pub fn command(&self, command: LiveCommand) {
        let now = now_ms();
        match command {
            LiveCommand::Refresh { folder, manual } => {
                if manual {
                    self.update(true, |s| s.unhide(&folder));
                }
                self.send(Job::Refresh {
                    folder,
                    interactive: manual,
                });
            }
            LiveCommand::CreateFolder {
                window,
                kind,
                sources,
                name,
            } => {
                let Some(profile) = self.window_profile(&window) else {
                    return;
                };
                let id = self.new_folder_id();
                let id = self.update(true, |s| {
                    let connected = s.connected_sources(kind);
                    let sources = sources.or((!connected.is_empty()).then_some(connected));
                    let id = s.create_folder(id, &profile, kind, sources, now);
                    if let Some(name) = name {
                        s.update_folder(&id, |f| f.name = name);
                    }
                    id
                });
                self.send(Job::Refresh {
                    folder: id,
                    interactive: true,
                });
            }
            LiveCommand::RemoveFolder { folder } => {
                self.close_folder_tabs(&folder);
                self.update(true, |s| s.remove_folder(&folder));
            }
            LiveCommand::OpenItem {
                window,
                folder,
                item,
                background,
            } => self.open_item(&window, &folder, &item, background),
            LiveCommand::Connect {
                source,
                token,
                user,
                site,
            } => {
                if let Err(error) = self.connect(source, &token, user.as_deref(), site.as_deref()) {
                    log::debug!("couldn't connect {}: {}", source.key(), error.message);
                }
            }
            LiveCommand::Disconnect { source } => {
                if source == LiveSourceId::Github {
                    self.github.lock().forget();
                }
                if self.secrets.delete(&self.endpoints.account(source)) {
                    self.update(true, |s| s.set_account(source, None));
                }
            }
            other => {
                let options_changed = matches!(other, LiveCommand::SetOptions { .. });
                let folder = match &other {
                    LiveCommand::SetOptions { folder, .. } => Some(folder.clone()),
                    _ => None,
                };
                self.update(true, |s| s.apply_local(&other, now));
                if let (true, Some(folder)) = (options_changed, folder) {
                    self.send(Job::Refresh {
                        folder,
                        interactive: false,
                    });
                }
                self.sync_tabs();
            }
        }
    }

    fn window_profile(&self, window: &WindowId) -> Option<String> {
        let store = self.store.as_ref()?;
        let state = store.snapshot();
        let w = state.window(window.as_str())?;
        (w.kind != ardia_state::windows::WindowKind::Incognito)
            .then(|| w.profile_id.as_str().to_owned())
    }

    pub fn connect(
        &self,
        source: LiveSourceId,
        typed: &str,
        user: Option<&str>,
        site: Option<&str>,
    ) -> Result<(), LiveError> {
        let transport = self
            .transport
            .as_deref()
            .ok_or_else(|| LiveError::new(LiveErrorKind::Network, "Couldn't connect"))?;
        let net = Net {
            transport,
            endpoints: &self.endpoints,
            secrets: &self.secrets,
        };
        let token = typed.trim();
        let now = now_ms();
        let account = match source {
            LiveSourceId::Github => {
                let viewer = self.github.lock().viewer(&net, token, now)?;
                let (login, name, avatar) = viewer.ok_or_else(|| {
                    LiveError::new(LiveErrorKind::SignedOut, "GitHub didn't accept the token")
                })?;
                sources::account(login, name, avatar, now)
            }
            LiveSourceId::Bitbucket => {
                let user = user.unwrap_or_default().trim().to_owned();
                let (me, _) = net.request(
                    "GET",
                    &format!("{}/user", self.endpoints.bitbucket()),
                    &[("Authorization", sources::basic(&user, token))],
                    None,
                )?;
                self.update(true, |s| s.config.bitbucket_user = user.clone());
                sources::account(
                    me.get("account_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    me.get("display_name")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    me.pointer("/links/avatar/href")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    now,
                )
            }
            LiveSourceId::Notion => {
                let headers = [
                    ("Authorization", sources::bearer(token)),
                    ("Notion-Version", "2022-06-28".to_owned()),
                ];
                let (me, _) = net.request(
                    "GET",
                    &format!("{}/users/me", self.endpoints.notion()),
                    &headers,
                    None,
                )?;
                let workspace = me
                    .pointer("/bot/workspace_name")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let login = workspace
                    .clone()
                    .or_else(|| me.get("name").and_then(Value::as_str).map(str::to_owned))
                    .unwrap_or_else(|| "Notion".into());
                sources::account(login, workspace, None, now)
            }
            LiveSourceId::Confluence => {
                let email = user.unwrap_or_default().trim().to_owned();
                let base = site
                    .unwrap_or_default()
                    .trim()
                    .trim_end_matches('/')
                    .to_owned();
                let base = if base.starts_with("http://") || base.starts_with("https://") {
                    base
                } else {
                    format!("https://{base}")
                };
                let (me, _) = net.request(
                    "GET",
                    &format!(
                        "{}/wiki/rest/api/user/current",
                        self.endpoints.confluence(&base)
                    ),
                    &[("Authorization", sources::basic(&email, token))],
                    None,
                )?;
                self.update(true, |s| {
                    s.config.confluence_site = base.clone();
                    s.config.confluence_email = email.clone();
                });
                sources::account(
                    me.get("accountId")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    me.get("displayName")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    None,
                    now,
                )
            }
            LiveSourceId::Gdrive => {
                return Err(LiveError::new(
                    LiveErrorKind::Other,
                    "Google Drive connects through its sign-in page",
                ));
            }
        };
        if !self.secrets.set(&self.endpoints.account(source), token) {
            return Err(LiveError::new(
                LiveErrorKind::Other,
                "The Keychain didn't save the sign-in",
            ));
        }
        if source == LiveSourceId::Github {
            self.github.lock().forget();
        }
        self.update(true, |s| s.set_account(source, Some(account)));
        Ok(())
    }

    fn fetch_source(
        &self,
        net: &Net,
        state: &LiveState,
        source: LiveSourceId,
        folder: &LiveFolder,
        interactive: bool,
    ) -> Result<Vec<LiveItem>, LiveError> {
        let now = now_ms();
        match source {
            LiveSourceId::Github => {
                let token = net.secret(state, source)?;
                self.github
                    .lock()
                    .fetch_folder(net, &token, folder, interactive, now)
            }
            LiveSourceId::Bitbucket => sources::fetch_bitbucket(net, state, folder),
            LiveSourceId::Notion => sources::fetch_notion(net, state),
            LiveSourceId::Confluence => sources::fetch_confluence(net, state),
            LiveSourceId::Gdrive => sources::fetch_drive(net, state, now),
        }
    }

    fn resolve_gone(
        &self,
        net: &Net,
        state: &LiveState,
        source: LiveSourceId,
        items: &[LiveItem],
        interactive: bool,
    ) -> HashMap<String, CompletionState> {
        let found = match source {
            LiveSourceId::Github => net.secret(state, source).and_then(|token| {
                self.github
                    .lock()
                    .resolve_gone(net, &token, items, interactive, now_ms())
            }),
            LiveSourceId::Bitbucket => sources::resolve_bitbucket(net, state, items),
            _ => Ok(HashMap::new()),
        };
        found.unwrap_or_default()
    }

    pub fn refresh_folder(&self, folder_id: &str, interactive: bool) {
        if !self.inflight.lock().insert(folder_id.to_owned()) {
            return;
        }
        self.run(folder_id, interactive);
        self.inflight.lock().remove(folder_id);
    }

    fn run(&self, folder_id: &str, interactive: bool) {
        let before = self.snapshot();
        let Some(folder) = before.folders.get(folder_id).cloned() else {
            return;
        };
        let Some(transport) = self.transport.as_deref() else {
            return;
        };
        let net = Net {
            transport,
            endpoints: &self.endpoints,
            secrets: &self.secrets,
        };
        let had_fetch = before
            .status
            .get(folder_id)
            .and_then(|s| s.last_fetch)
            .is_some();
        self.update(false, |s| {
            s.set_status(folder_id, |st| {
                st.state = if had_fetch {
                    FolderState::Updating
                } else {
                    FolderState::Initializing
                }
            })
        });
        let mut fetched: Vec<LiveItem> = Vec::new();
        let mut failed: Vec<(LiveSourceId, LiveError)> = Vec::new();
        for source in &folder.sources {
            match self.fetch_source(&net, &before, *source, &folder, interactive) {
                Ok(items) => fetched.extend(items),
                Err(error) => failed.push((*source, error)),
            }
        }
        let landed = self.snapshot();
        let Some(current) = landed.folders.get(folder_id) else {
            return;
        };
        if current.sources != folder.sources || current.filters != folder.filters {
            self.update(false, |s| {
                s.set_status(folder_id, |st| st.state = FolderState::Idle)
            });
            self.send(Job::Refresh {
                folder: folder_id.to_owned(),
                interactive,
            });
            return;
        }
        let from_failed = |it: &LiveItem| failed.iter().any(|(s, _)| *s == it.source);
        let listed_by_filters = |it: &LiveItem| match it.section {
            Some(
                ardia_state::live::PullRequestSection::Review
                | ardia_state::live::PullRequestSection::Team,
            ) => folder.filters.review_requests,
            _ => folder.filters.authored,
        };
        let repo_shown = |s: &LiveState, it: &LiveItem| {
            repo_key(it).is_none_or(|repo| {
                !s.folders
                    .get(folder_id)
                    .is_some_and(|f| f.hidden_repos.contains(&repo))
            })
        };
        let ids: HashSet<&str> = fetched.iter().map(|it| it.id.as_str()).collect();
        let animating: HashSet<String> = landed
            .completing
            .get(folder_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let missing: Vec<LiveItem> = landed
            .items
            .get(folder_id)
            .into_iter()
            .flatten()
            .chain(landed.hidden.get(folder_id).into_iter().flatten())
            .filter(|it| {
                !ids.contains(it.id.as_str())
                    && !animating.contains(&it.id)
                    && folder.sources.contains(&it.source)
                    && !from_failed(it)
                    && listed_by_filters(it)
                    && repo_shown(&landed, it)
            })
            .cloned()
            .collect();
        let mut gone = HashMap::new();
        let mut seen = HashSet::new();
        for source in missing.iter().map(|it| it.source) {
            if seen.insert(source) {
                let of_source: Vec<LiveItem> = missing
                    .iter()
                    .filter(|it| it.source == source)
                    .cloned()
                    .collect();
                gone.extend(self.resolve_gone(&net, &landed, source, &of_source, interactive));
            }
        }
        let fetched_ids: HashSet<String> = fetched.iter().map(|it| it.id.clone()).collect();
        let warning = if failed.is_empty() {
            folder
                .sources
                .contains(&LiveSourceId::Github)
                .then(|| self.github.lock().warning())
                .flatten()
                .map(|w| (LiveSourceId::Github, w))
        } else {
            None
        };
        let leaving = self.update(true, |s| {
            s.hide_new_repos(folder_id, &fetched);
            let prev = s.items.get(folder_id).cloned().unwrap_or_default();
            let animating: HashSet<String> = s
                .completing
                .get(folder_id)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect();
            let mut next: Vec<LiveItem> = fetched
                .iter()
                .filter(|it| repo_shown(s, it))
                .cloned()
                .collect();
            next.extend(
                prev.iter()
                    .filter(|it| from_failed(it) && !animating.contains(&it.id))
                    .cloned(),
            );
            if let Some((source, error)) = failed.first()
                && failed.len() == folder.sources.len()
                && prev.is_empty()
                && !had_fetch
            {
                s.set_status(folder_id, |st| {
                    st.state = FolderState::Error;
                    st.error = Some(FolderError {
                        kind: error.kind,
                        message: error.message.clone(),
                        source: *source,
                    });
                });
                return Vec::new();
            }
            order_items(&mut next);
            let succeeded: HashSet<LiveSourceId> = folder
                .sources
                .iter()
                .copied()
                .filter(|id| !failed.iter().any(|(s, _)| s == id))
                .collect();
            let leaving = s.apply_fetch(
                folder_id,
                next,
                &gone,
                now_ms(),
                &HashSet::new(),
                &succeeded,
            );
            if let Some((source, error)) = failed.first().cloned().or(warning.clone()) {
                s.set_status(folder_id, |st| {
                    st.state = FolderState::Error;
                    st.error = Some(FolderError {
                        kind: error.kind,
                        message: error.message,
                        source,
                    });
                });
            }
            leaving
        });
        let folder = folder_id.to_owned();
        self.on_main(Box::new(move |hub: &LiveHub| {
            hub.mark_completed_tabs(&folder, &gone, &fetched_ids);
            hub.sync_tabs();
        }));
        if !leaving.is_empty() {
            self.schedule(
                now_ms() + ardia_state::live::COMPLETION_MS,
                Timer::Finish {
                    folder: folder_id.to_owned(),
                    ids: leaving,
                },
            );
        }
    }

    fn open_item(&self, window: &WindowId, folder: &str, item_id: &str, background: bool) {
        let Some(store) = &self.store else {
            return;
        };
        let live = self.snapshot();
        let Some(item) = live.folder_item(folder, item_id).cloned() else {
            return;
        };
        self.update(true, |s| {
            s.mark_read(folder, Some(&[item_id.to_owned()]));
        });
        let state = store.snapshot();
        let existing = state
            .view_tabs(window.as_str(), None)
            .into_iter()
            .find(|t| {
                t.live_item
                    .as_ref()
                    .is_some_and(|l| l.item_id == item_id && l.folder_id == folder)
            });
        if let Some(tab) = existing {
            let id = tab.id.clone();
            if tab.pinned_url.as_deref() != Some(item.url.as_str()) {
                let _ = store.dispatch(Action::SetTabLiveItem {
                    tab: id.clone(),
                    live_item: tab.live_item.clone(),
                    home: Some(Some(item.url)),
                });
            }
            if !background {
                let _ = store.dispatch(Action::ActivateTab { tab: id });
            }
            return;
        }
        let Ok(outcome) = store.dispatch(Action::NewTab {
            window: window.clone(),
            tab: NewTab {
                url: Some(item.url.clone()),
                background,
                ..NewTab::default()
            },
        }) else {
            return;
        };
        let completed = live
            .completed
            .get(folder)
            .is_some_and(|c| c.iter().any(|c| c.item.id == item_id && c.state.ended()));
        if let Some(tab) = outcome.tab {
            let _ = store.dispatch(Action::SetTabLiveItem {
                tab,
                live_item: Some(TabLiveItem {
                    folder_id: folder.to_owned(),
                    item_id: item_id.to_owned(),
                    completed,
                }),
                home: Some(Some(item.url)),
            });
        }
    }

    fn close_folder_tabs(&self, folder: &str) {
        let Some(store) = &self.store else {
            return;
        };
        let tabs: Vec<TabId> = store
            .snapshot()
            .tabs
            .values()
            .filter(|t| t.live_item.as_ref().is_some_and(|l| l.folder_id == folder))
            .map(|t| t.id.clone())
            .collect();
        if !tabs.is_empty() {
            let _ = store.dispatch(Action::CloseTabs {
                tabs,
                last_closes_window: false,
            });
        }
    }

    fn mark_completed_tabs(
        &self,
        folder: &str,
        gone: &HashMap<String, CompletionState>,
        listed: &HashSet<String>,
    ) {
        let Some(store) = &self.store else {
            return;
        };
        let hidden: HashSet<String> = self
            .snapshot()
            .hidden
            .get(folder)
            .map(|h| h.iter().map(|it| it.id.clone()).collect())
            .unwrap_or_default();
        let state = store.snapshot();
        for tab in state.tabs.values() {
            let Some(r) = tab.live_item.as_ref().filter(|l| l.folder_id == folder) else {
                continue;
            };
            let ended = gone.get(&r.item_id).is_some_and(|g| g.ended());
            let next = if ended && !hidden.contains(&r.item_id) && !r.completed {
                Some(true)
            } else if r.completed && listed.contains(&r.item_id) {
                Some(false)
            } else {
                None
            };
            if let Some(completed) = next {
                let _ = store.dispatch(Action::SetTabLiveItem {
                    tab: tab.id.clone(),
                    live_item: Some(TabLiveItem {
                        completed,
                        ..r.clone()
                    }),
                    home: None,
                });
            }
        }
        self.close_completed_tabs();
    }

    pub fn close_completed_tabs(&self) {
        let Some(store) = &self.store else {
            return;
        };
        let live = self.snapshot();
        let state = store.snapshot();
        let shown: HashSet<TabId> = state
            .windows
            .values()
            .filter_map(|w| state.active_tab(w.id.as_str()).map(|t| t.id.clone()))
            .collect();
        let tabs: Vec<TabId> = state
            .tabs
            .values()
            .filter(|t| {
                let Some(r) = &t.live_item else {
                    return false;
                };
                r.completed
                    && live
                        .folders
                        .get(&r.folder_id)
                        .is_some_and(|f| !f.show_completed)
                    && !shown.contains(&t.id)
                    && t.pin.is_none()
                    && !t.live.audible
                    && !live
                        .items
                        .get(&r.folder_id)
                        .is_some_and(|i| i.iter().any(|it| it.id == r.item_id))
            })
            .map(|t| t.id.clone())
            .collect();
        if !tabs.is_empty() {
            ardia_telemetry::counts::add("live_completed_tabs_closed", tabs.len() as u64);
            let _ = store.dispatch(Action::CloseTabs {
                tabs,
                last_closes_window: false,
            });
        }
    }

    pub fn sync_tabs(&self) {
        let Some(store) = &self.store else {
            return;
        };
        let live = self.snapshot();
        let state = store.snapshot();
        for tab in state.tabs.values() {
            let Some(r) = &tab.live_item else {
                continue;
            };
            if !live.folders.contains_key(&r.folder_id) {
                let _ = store.dispatch(Action::SetTabLiveItem {
                    tab: tab.id.clone(),
                    live_item: None,
                    home: None,
                });
                continue;
            }
            if tab.pin.is_some() || !live.items.contains_key(&r.folder_id) {
                continue;
            }
            let home = live
                .folder_item(&r.folder_id, &r.item_id)
                .map(|i| i.url.clone());
            if home != tab.pinned_url {
                let _ = store.dispatch(Action::SetTabLiveItem {
                    tab: tab.id.clone(),
                    live_item: Some(r.clone()),
                    home: Some(home),
                });
            }
        }
        let profiles: HashSet<String> = state
            .profiles
            .keys()
            .map(|p| p.as_str().to_owned())
            .collect();
        let orphaned: Vec<String> = live
            .folders
            .values()
            .filter(|f| !profiles.contains(&f.profile_id))
            .map(|f| f.id.clone())
            .collect();
        if !orphaned.is_empty() && !profiles.is_empty() {
            self.update(true, |s| {
                for id in &orphaned {
                    s.remove_folder(id);
                }
            });
        }
    }

    fn take_due(&self, now: i64) -> (Vec<Timer>, Option<i64>) {
        let mut timers = self.timers.lock();
        let (due, later): (Vec<_>, Vec<_>) = timers.drain(..).partition(|(at, _)| *at <= now);
        *timers = later;
        let next = timers.iter().map(|(at, _)| *at).min();
        (due.into_iter().map(|(_, t)| t).collect(), next)
    }

    fn due_folders(&self, max_age: Option<i64>) -> Vec<String> {
        let now = now_ms();
        let live = self.snapshot();
        live.folder_order
            .iter()
            .filter(|id| {
                let age = max_age.unwrap_or_else(|| {
                    live.folders
                        .get(*id)
                        .map_or(i64::MAX, |f| f.kind.interval_ms())
                });
                live.due(id, age, now)
            })
            .cloned()
            .collect()
    }
}

fn radix36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn worker(hub: std::sync::Weak<LiveHub>, jobs: Receiver<Job>) {
    let mut next_tick = now_ms() + TICK.as_millis() as i64;
    loop {
        let Some(live) = hub.upgrade() else {
            return;
        };
        let now = now_ms();
        let (due, next_timer) = live.take_due(now);
        for timer in due {
            match timer {
                Timer::Finish { folder, ids } => {
                    live.update(true, |s| s.finish_completing(&folder, &ids));
                    live.on_main(Box::new(|hub: &LiveHub| hub.close_completed_tabs()));
                }
                Timer::Save => {
                    live.save_now();
                }
                Timer::Startup => {
                    for folder in live.snapshot().folder_order.clone() {
                        live.refresh_folder(&folder, false);
                    }
                }
            }
        }
        if now >= next_tick {
            next_tick = now + TICK.as_millis() as i64;
            for folder in live.due_folders(None) {
                live.refresh_folder(&folder, false);
            }
        }
        let wait_until = next_timer.unwrap_or(next_tick).min(next_tick);
        drop(live);
        let wait =
            Duration::from_millis((wait_until - now_ms()).clamp(1, TICK.as_millis() as i64) as u64);
        match jobs.recv_timeout(wait) {
            Ok(Job::Refresh {
                folder,
                interactive,
            }) => {
                if let Some(live) = hub.upgrade() {
                    live.refresh_folder(&folder, interactive);
                }
            }
            Ok(Job::Focus) => {
                if let Some(live) = hub.upgrade() {
                    for folder in live.due_folders(Some(ardia_state::live::STALE_ON_FOCUS_MS)) {
                        live.refresh_folder(&folder, false);
                    }
                }
            }
            Ok(Job::Wake) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

static HUB: OnceLock<Arc<LiveHub>> = OnceLock::new();

pub fn hub() -> Option<&'static Arc<LiveHub>> {
    HUB.get()
}

pub fn install(hub: Arc<LiveHub>) -> &'static Arc<LiveHub> {
    HUB.get_or_init(|| hub)
}

#[cfg(test)]
mod tests;

impl crate::coordinator::AppCoordinator {
    pub fn start_live(&self) -> &'static Arc<LiveHub> {
        if let Some(hub) = hub() {
            return hub;
        }
        let created = LiveHub::new(
            self.data_dir(),
            SecretStore::for_launch(),
            crate::net::shared(),
            Endpoints::from_env(),
            Some(Arc::clone(&self.store)),
        );
        let weak = self.weak();
        created.set_main_runner(Arc::new(move |work: MainWork| {
            if let Some(coordinator) = weak.upgrade() {
                coordinator.post(move |_| {
                    if let Some(hub) = hub() {
                        work(hub);
                    }
                });
            }
        }));
        let signal = self.weak();
        created.subscribe(Arc::new(move || {
            if let Some(coordinator) = signal.upgrade() {
                coordinator
                    .signal
                    .emit(ardia_ui::host_data::HostTopics::PEOPLE);
            }
        }));
        let hub = install(created);
        hub.start();
        self.start_calendar(Arc::clone(hub));
        self.start_report();
        hub
    }
}
