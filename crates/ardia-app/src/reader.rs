use std::collections::{HashMap, HashSet};
use std::time::Duration;

use ardia_engine::{BrowserEngine, EngineEvent, EngineTabId};
use ardia_state::settings::ReaderFont;
use ardia_state::windows::{Toast, ToastKind};
use ardia_state::{Action, BrowserState, TabId};
use ardia_ui::ReaderStatus;
use ardia_ui::pages::reader::reader_size_index;
use serde::Serialize;
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;

pub const INSTALL: &str = include_str!("../assets/reader/install.js");
pub const READABILITY: &str = include_str!("../assets/reader/readability.js");
pub const READERABLE: &str = include_str!("../assets/reader/readerable.js");

pub const READER_WORLD: &str = "ardia-reader";
pub const CHECK_DELAY: Duration = Duration::from_millis(250);
pub const RECHECK_AFTER: Duration = Duration::from_millis(1500);
pub const SYNC_EVERY: Duration = Duration::from_millis(1000);
pub const CALL_DEADLINE: Duration = Duration::from_millis(4000);
pub const MAX_REPORT_BYTES: usize = 4096;
pub const NO_ARTICLE: &str = "No article found on this page";
pub const NO_ARTICLE_ICON: &str = "doc.plaintext";

const READER_OBJECT: &str = "window[Symbol.for(\"ardia.reader\")]";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ReaderLook {
    pub dark: bool,
    pub size: usize,
    pub font: &'static str,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReaderReport {
    pub active: bool,
    pub readerable: bool,
    pub no_article: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReaderTab {
    pub url: String,
    pub available: bool,
    pub active: bool,
}

#[derive(Default)]
pub struct ReaderBook {
    tabs: HashMap<TabId, ReaderTab>,
    seen: HashMap<TabId, String>,
    documents: HashMap<TabId, u64>,
    next_document: u64,
    pending: HashSet<TabId>,
    rechecks: HashSet<TabId>,
    counted: HashMap<TabId, String>,
    worlds: HashMap<EngineTabId, i64>,
    system_dark: bool,
    pushed: Option<ReaderLook>,
    syncing: bool,
}

impl ReaderBook {
    pub fn remove(&mut self, tab: &TabId) -> Option<ReaderTab> {
        self.seen.remove(tab);
        self.documents.remove(tab);
        self.pending.remove(tab);
        self.rechecks.remove(tab);
        self.counted.remove(tab);
        self.tabs.remove(tab)
    }

    pub fn status(&self, tab: &TabId) -> ReaderStatus {
        self.tabs
            .get(tab)
            .map_or_else(ReaderStatus::default, |state| ReaderStatus {
                available: state.available,
                active: state.active,
            })
    }

    fn document(&self, tab: &TabId) -> u64 {
        self.documents.get(tab).copied().unwrap_or(0)
    }

    fn replace_document(&mut self, tab: &TabId) {
        self.next_document += 1;
        self.documents.insert(tab.clone(), self.next_document);
    }

    fn any_active(&self) -> bool {
        self.tabs.values().any(|state| state.active)
    }
}

pub fn readable(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("https:") || lower.starts_with("http:") || lower.starts_with("file:")
}

fn without_hash(url: &str) -> &str {
    url.split_once('#').map_or(url, |(page, _)| page)
}

fn wrap(expression: &str) -> String {
    format!("(() => {{\n{INSTALL}\nreturn JSON.stringify({expression});\n}})()")
}

pub fn check_call() -> String {
    wrap(&format!("{READER_OBJECT}.check({READERABLE})"))
}

pub fn toggle_call(look: &ReaderLook) -> String {
    let look = serde_json::to_string(look).unwrap_or_else(|_| "{}".into());
    wrap(&format!("{READER_OBJECT}.toggle({READABILITY}, {look})"))
}

pub fn state_call() -> String {
    wrap(&format!("{READER_OBJECT}.state()"))
}

pub fn hide_call() -> String {
    wrap(&format!("{READER_OBJECT}.hide()"))
}

pub fn look_call(look: &ReaderLook) -> String {
    let look = serde_json::to_string(look).unwrap_or_else(|_| "{}".into());
    wrap(&format!("{READER_OBJECT}.setLook({look})"))
}

pub fn report_of(value: &Value) -> Option<ReaderReport> {
    let text = value.as_str()?;
    if text.len() > MAX_REPORT_BYTES {
        return None;
    }
    let raw: Value = serde_json::from_str(text).ok()?;
    let flag = |key: &str| raw.get(key).and_then(Value::as_bool) == Some(true);
    raw.is_object().then(|| ReaderReport {
        active: flag("active"),
        readerable: flag("readerable"),
        no_article: flag("noArticle"),
    })
}

pub fn look_of(state: &BrowserState, system_dark: bool) -> ReaderLook {
    ReaderLook {
        dark: state.app_dark(system_dark),
        size: reader_size_index(state.settings.reader_text_size),
        font: match state.settings.reader_font {
            ReaderFont::Serif => "serif",
            ReaderFont::Sans => "sans",
        },
    }
}

pub fn shown_tabs(state: &BrowserState) -> HashSet<TabId> {
    let mut shown = HashSet::new();
    for window in state.window_order.iter() {
        if let Some(active) = state.active_tab(window.as_str()) {
            shown.insert(active.id.clone());
        }
        if let Some(peek) = state.shown_peek(window.as_str()) {
            shown.insert(peek.tab_id.clone());
        }
    }
    shown
}

async fn open_world(engine: &dyn BrowserEngine, engine_tab: EngineTabId) -> Option<i64> {
    let tree = engine
        .devtools_call(
            engine_tab,
            "Page.getFrameTree",
            Some(json!({})),
            CALL_DEADLINE,
        )
        .await
        .ok()?;
    let frame = tree.pointer("/frameTree/frame/id")?.as_str()?.to_owned();
    let world = engine
        .devtools_call(
            engine_tab,
            "Page.createIsolatedWorld",
            Some(json!({ "frameId": frame, "worldName": READER_WORLD, "grantUniveralAccess": false })),
            CALL_DEADLINE,
        )
        .await
        .ok()?;
    world.get("executionContextId")?.as_i64()
}

async fn evaluate_in_world(
    engine: &dyn BrowserEngine,
    engine_tab: EngineTabId,
    mut world: Option<i64>,
    code: &str,
) -> (Option<Value>, Option<i64>) {
    for _ in 0..2 {
        let context = match world.take() {
            Some(context) => context,
            None => match open_world(engine, engine_tab).await {
                Some(context) => context,
                None => return (None, None),
            },
        };
        let answer = engine
            .devtools_call(
                engine_tab,
                "Runtime.evaluate",
                Some(json!({ "expression": code, "contextId": context, "returnByValue": true })),
                CALL_DEADLINE,
            )
            .await;
        match answer {
            Ok(answer) if answer.get("exceptionDetails").is_none() => {
                return (answer.pointer("/result/value").cloned(), Some(context));
            }
            Ok(_) => return (None, Some(context)),
            Err(_) => {}
        }
    }
    (None, None)
}

impl AppCoordinator {
    pub fn reader_status_of(&self, tab: &TabId) -> ReaderStatus {
        self.bridge.lock().readers.status(tab)
    }

    pub fn menu_titles(&self, state: &BrowserState) -> Vec<(&'static str, &'static str)> {
        let active = self
            .command_window(state)
            .and_then(|window| state.active_tab(window.as_str()).map(|tab| tab.id.clone()));
        let reading = active
            .as_ref()
            .is_some_and(|tab| self.reader_status_of(tab).active);
        let mut titles = Vec::new();
        if reading {
            titles.push(("toggleReader", "Hide Reader"));
        }
        let webkit = active.as_ref().is_some_and(|tab| {
            ardia_state::engines::tab_engine(state, tab.as_str())
                == ardia_state::model::PageEngine::Webkit
        });
        if webkit {
            titles.push(("togglePageEngine", "Open Page in Chromium"));
        }
        if let Some(tab) = active.as_ref().and_then(|tab| state.tab(tab.as_str())) {
            let mute = ardia_state::mute::mute_state(state, tab);
            if mute.is_some() {
                titles.push(("toggleMute", ardia_state::mute::mute_title(mute)));
            }
        }
        titles
    }

    pub fn note_reader_system_dark(&self, dark: bool) {
        let changed = {
            let mut bridge = self.bridge.lock();
            let changed = bridge.readers.system_dark != dark;
            bridge.readers.system_dark = dark;
            changed
        };
        if changed {
            self.mark_dirty();
        }
    }

    fn reader_look(&self) -> ReaderLook {
        let dark = self.bridge.lock().readers.system_dark;
        look_of(&self.store.snapshot(), dark)
    }

    fn call_reader(
        &self,
        tab: &TabId,
        code: String,
        then: impl FnOnce(&AppCoordinator, Option<ReaderReport>) + 'static,
    ) {
        let (Some(engine), Some(engine_tab)) = (self.engine(), self.engine_tab(tab)) else {
            return;
        };
        let world = self.bridge.lock().readers.worlds.get(&engine_tab).copied();
        let me = self.weak();
        self.spawn(async move {
            let (value, world) = evaluate_in_world(engine.as_ref(), engine_tab, world, &code).await;
            let Some(me) = me.upgrade() else {
                return;
            };
            {
                let mut bridge = me.bridge.lock();
                match world {
                    Some(world) => bridge.readers.worlds.insert(engine_tab, world),
                    None => bridge.readers.worlds.remove(&engine_tab),
                };
            }
            then(&me, value.as_ref().and_then(report_of));
        });
    }

    fn redraw_tab(&self, tab: &TabId) {
        if let Some(window) = self.window_of(tab) {
            self.touch(window);
        }
        self.wake();
    }

    fn settle_reader(
        &self,
        tab: &TabId,
        url: &str,
        report: ReaderReport,
        available: Option<bool>,
        document: u64,
    ) {
        let current = self
            .store
            .snapshot()
            .tab(tab.as_str())
            .is_some_and(|listed| listed.url == url);
        {
            let mut bridge = self.bridge.lock();
            let book = &mut bridge.readers;
            if !current || book.document(tab) != document {
                return;
            }
            let before = book.tabs.get(tab).cloned().unwrap_or_default();
            book.tabs.insert(
                tab.clone(),
                ReaderTab {
                    url: url.to_owned(),
                    available: available.unwrap_or(before.available),
                    active: report.active,
                },
            );
            book.seen
                .entry(tab.clone())
                .or_insert_with(|| url.to_owned());
        }
        self.redraw_tab(tab);
        self.keep_readers_in_sync();
    }

    pub fn toggle_reader_in(&self, tab: &TabId) {
        let state = self.store.snapshot();
        let Some(listed) = state.tab(tab.as_str()).filter(|t| readable(&t.url)) else {
            return;
        };
        let url = listed.url.clone();
        let window = listed.window_id.clone();
        let document = self.bridge.lock().readers.document(tab);
        let code = toggle_call(&self.reader_look());
        let tab = tab.clone();
        self.call_reader(&tab.clone(), code, move |me, report| {
            let Some(report) = report else {
                return;
            };
            if report.no_article {
                ardia_telemetry::counts::count("reader_no_article");
                me.settle_reader(&tab, &url, report, Some(false), document);
                let now = ardia_state::store::now_ms();
                me.dispatch_quietly(Action::PushToast {
                    window,
                    toast: Toast {
                        id: now.max(0) as u64,
                        kind: ToastKind::Info,
                        message: NO_ARTICLE.to_owned(),
                        action: None,
                        icon: Some(NO_ARTICLE_ICON.to_owned()),
                        created_at: now,
                        expires_at: Some(now + 6_000),
                    },
                });
                return;
            }
            if report.active {
                ardia_telemetry::counts::count("reader_opens");
            }
            me.settle_reader(&tab, &url, report, Some(true), document);
        });
    }

    fn check_reader(&self, tab: &TabId) {
        let state = self.store.snapshot();
        let Some(url) = state
            .tab(tab.as_str())
            .filter(|t| readable(&t.url))
            .map(|t| t.url.clone())
        else {
            return;
        };
        let document = self.bridge.lock().readers.document(tab);
        let tab = tab.clone();
        self.call_reader(&tab.clone(), check_call(), move |me, report| {
            let Some(report) = report else {
                return;
            };
            let available = report.readerable;
            let first = {
                let mut bridge = me.bridge.lock();
                let first = bridge.readers.counted.get(&tab) != Some(&url);
                if first {
                    bridge.readers.counted.insert(tab.clone(), url.clone());
                    ardia_telemetry::counts::count("reader_pages_checked");
                    if !available {
                        ardia_telemetry::counts::count("reader_pages_without_article");
                    }
                }
                first
            };
            me.settle_reader(&tab, &url, report, Some(available), document);
            let still_here = me
                .store
                .snapshot()
                .tab(tab.as_str())
                .is_some_and(|t| t.url == url);
            if first && !available && still_here {
                me.recheck_reader_later(&tab, &url);
            }
        });
    }

    fn after(&self, delay: Duration, job: impl FnOnce(&AppCoordinator) + Send + 'static) {
        let me = self.weak();
        let spawned = std::thread::Builder::new()
            .name("ardia-reader-timer".into())
            .spawn(move || {
                std::thread::sleep(delay);
                if let Some(coordinator) = me.upgrade() {
                    coordinator.post(job);
                }
            });
        if let Err(problem) = spawned {
            log::debug!("a Reader timer didn't start: {problem}");
        }
    }

    fn recheck_reader_later(&self, tab: &TabId, url: &str) {
        if !self.bridge.lock().readers.rechecks.insert(tab.clone()) {
            return;
        }
        let (tab, url) = (tab.clone(), url.to_owned());
        self.after(RECHECK_AFTER, move |me| {
            me.bridge.lock().readers.rechecks.remove(&tab);
            let state = me.store.snapshot();
            let ready = state
                .tab(tab.as_str())
                .is_some_and(|t| t.url == url && !t.live.loading);
            if ready && !me.reader_status_of(&tab).available {
                me.check_reader(&tab);
            }
        });
    }

    fn schedule_reader_check(&self, tab: &TabId) {
        if !self.bridge.lock().readers.pending.insert(tab.clone()) {
            return;
        }
        let tab = tab.clone();
        self.after(CHECK_DELAY, move |me| {
            me.bridge.lock().readers.pending.remove(&tab);
            if me.wants_reader_check(&me.store.snapshot(), &tab) {
                me.check_reader(&tab);
            }
        });
    }

    fn wants_reader_check(&self, state: &BrowserState, tab: &TabId) -> bool {
        let Some(listed) = state.tab(tab.as_str()) else {
            return false;
        };
        let known = self
            .bridge
            .lock()
            .readers
            .tabs
            .get(tab)
            .map(|t| t.url.clone())
            .unwrap_or_default();
        readable(&listed.url) && !listed.live.loading && known != listed.url
    }

    pub(crate) fn note_reader_event(&self, event: &EngineEvent) {
        let EngineEvent::LoadingChanged { tab, loading } = event else {
            return;
        };
        let Some(state_tab) = self.state_tab(*tab) else {
            return;
        };
        let mut bridge = self.bridge.lock();
        let book = &mut bridge.readers;
        if *loading {
            book.replace_document(&state_tab);
            book.worlds.remove(tab);
        } else if let Some(known) = book.tabs.get_mut(&state_tab)
            && !known.url.is_empty()
        {
            known.url.clear();
        }
    }

    fn reader_navigated(&self, tab: &TabId, from: &str, to: &str) {
        let before = {
            let mut bridge = self.bridge.lock();
            let Some(before) = bridge.readers.tabs.get(tab).cloned() else {
                return;
            };
            if before.active && without_hash(from) == without_hash(to) {
                if let Some(known) = bridge.readers.tabs.get_mut(tab) {
                    known.url = to.to_owned();
                }
                return;
            }
            bridge.readers.replace_document(tab);
            bridge.readers.tabs.remove(tab);
            before
        };
        if before.active {
            self.call_reader(tab, hide_call(), |_, _| {});
        }
        self.redraw_tab(tab);
    }

    pub(crate) fn tend_readers(&self) {
        let state = self.store.snapshot();
        let tracked: Vec<(TabId, Option<String>)> = {
            let bridge = self.bridge.lock();
            bridge
                .readers
                .tabs
                .keys()
                .map(|tab| (tab.clone(), bridge.readers.seen.get(tab).cloned()))
                .collect()
        };
        for (tab, seen) in tracked {
            match state.tab(tab.as_str()) {
                None => {
                    self.bridge.lock().readers.remove(&tab);
                }
                Some(listed) => {
                    let seen = seen.unwrap_or_else(|| listed.url.clone());
                    self.bridge
                        .lock()
                        .readers
                        .seen
                        .insert(tab.clone(), listed.url.clone());
                    if seen != listed.url {
                        self.reader_navigated(&tab, &seen, &listed.url);
                    }
                }
            }
        }
        self.push_reader_look();
        for tab in shown_tabs(&state) {
            if self.wants_reader_check(&state, &tab) {
                self.schedule_reader_check(&tab);
            }
        }
    }

    fn push_reader_look(&self) {
        let look = self.reader_look();
        let active: Vec<TabId> = {
            let mut bridge = self.bridge.lock();
            let book = &mut bridge.readers;
            if !book.any_active() || book.pushed == Some(look) {
                if !book.any_active() {
                    book.pushed = None;
                }
                return;
            }
            book.pushed = Some(look);
            book.tabs
                .iter()
                .filter(|(_, state)| state.active)
                .map(|(tab, _)| tab.clone())
                .collect()
        };
        for tab in active {
            self.call_reader(&tab, look_call(&look), |_, _| {});
        }
    }

    fn keep_readers_in_sync(&self) {
        {
            let mut bridge = self.bridge.lock();
            let book = &mut bridge.readers;
            if book.syncing || !book.any_active() {
                return;
            }
            book.syncing = true;
            if book.pushed.is_none() {
                drop(bridge);
                let look = self.reader_look();
                self.bridge.lock().readers.pushed = Some(look);
            }
        }
        self.after(SYNC_EVERY, |me| me.sync_readers());
    }

    fn sync_readers(&self) {
        let state = self.store.snapshot();
        let shown = shown_tabs(&state);
        let active: Vec<(TabId, String)> = {
            let mut bridge = self.bridge.lock();
            let book = &mut bridge.readers;
            if !book.any_active() {
                book.syncing = false;
                return;
            }
            book.tabs
                .iter()
                .filter(|(tab, known)| known.active && shown.contains(*tab))
                .map(|(tab, known)| (tab.clone(), known.url.clone()))
                .collect()
        };
        for (tab, url) in active {
            let document = self.bridge.lock().readers.document(&tab);
            let settled_tab = tab.clone();
            self.call_reader(&tab, state_call(), move |me, report| {
                if let Some(report) = report {
                    me.settle_reader(&settled_tab, &url, report, None, document);
                }
            });
        }
        self.after(SYNC_EVERY, |me| me.sync_readers());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_wrap_the_old_apps_reader_script() {
        let toggle = toggle_call(&ReaderLook {
            dark: true,
            size: 2,
            font: "sans",
        });
        assert!(toggle.starts_with("(() => {"));
        assert!(toggle.contains("Symbol.for(\"ardia.reader\")"));
        assert!(toggle.contains("{\"dark\":true,\"size\":2,\"font\":\"sans\"}"));
        assert!(!toggle.contains("post(\"result\""));
        assert!(check_call().contains(".check("));
        assert!(state_call().ends_with(".state());\n})()"));
        assert!(hide_call().contains(".hide()"));
    }

    #[test]
    fn reports_are_small_strings_with_flags() {
        let ok = Value::String("{\"active\":true,\"readerable\":true}".into());
        assert_eq!(
            report_of(&ok),
            Some(ReaderReport {
                active: true,
                readerable: true,
                no_article: false
            })
        );
        assert_eq!(
            report_of(&Value::String(
                "{\"active\":false,\"noArticle\":true}".into()
            ))
            .map(|r| r.no_article),
            Some(true)
        );
        assert_eq!(report_of(&json!({ "active": true })), None);
        assert_eq!(report_of(&Value::String("[]".into())), None);
        let padded = format!("{{\"active\":true{}}}", " ".repeat(MAX_REPORT_BYTES));
        assert_eq!(report_of(&Value::String(padded)), None);
    }

    #[test]
    fn readable_pages_match_the_old_app() {
        assert!(readable("https://a.example/") && readable("HTTP://a") && readable("file:///x"));
        assert!(!readable("ardia://history") && !readable("") && !readable("about:blank"));
    }
}
