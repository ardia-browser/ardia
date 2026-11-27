pub mod drain;
pub mod native;
pub mod page;

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use ardia_state::omnibox::url::host_of;
use ardia_state::settings::SettingsPatch;
use ardia_state::windows::{Toast, ToastKind};
use ardia_state::{Action, ProfileId, TabId, WindowId};
use ardia_ui::host_data::HostTopics;
use ardia_ui::site::model::{TranslateLanguage, TranslateView};
use futures::channel::oneshot;
use futures::future::LocalBoxFuture;
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;
use ardia_ui::UiHost as _;
use drain::{DrainPort, DrainStage, PageBatch, Passage, Translated};
use native::{LanguageStatus, Translator};
use page::{PageOp, page_answer, translator_call};

pub const FOLLOW_MS: u64 = 600;
pub const DOCUMENT_POLL_MS: u64 = 250;
pub const PROGRESS_AFTER_MS: u64 = 1200;
const PAGE_CALL_DEADLINE: Duration = Duration::from_secs(10);
const SAMPLE_CHARS: usize = 3000;
const TOAST_MS: i64 = 4000;
const PROGRESS_TOAST_ID: u64 = u64::MAX - 0x7472;
const TRANSLATE_ICON: &str = "translate";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TranslateState {
    Idle {
        source: Option<String>,
    },
    Translating {
        source: String,
        target: String,
        token: String,
    },
    Translated {
        source: String,
        target: String,
        token: String,
    },
}

impl Default for TranslateState {
    fn default() -> Self {
        TranslateState::Idle { source: None }
    }
}

impl TranslateState {
    pub fn token(&self) -> Option<&str> {
        match self {
            TranslateState::Idle { .. } => None,
            TranslateState::Translating { token, .. }
            | TranslateState::Translated { token, .. } => Some(token),
        }
    }

    pub fn source(&self) -> Option<&str> {
        match self {
            TranslateState::Idle { source } => source.as_deref(),
            TranslateState::Translating { source, .. }
            | TranslateState::Translated { source, .. } => Some(source),
        }
    }

    pub fn target(&self) -> Option<&str> {
        match self {
            TranslateState::Idle { .. } => None,
            TranslateState::Translating { target, .. }
            | TranslateState::Translated { target, .. } => Some(target),
        }
    }

    pub fn is_idle(&self) -> bool {
        matches!(self, TranslateState::Idle { .. })
    }

    fn idle(&self) -> TranslateState {
        TranslateState::Idle {
            source: self.source().map(str::to_owned),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranslateStage {
    Detect,
    Start,
    Collect,
    Model,
    Apply,
    Follow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranslateOrigin {
    Button,
    ButtonMenu,
    SiteControls,
    PageMenu,
}

pub struct TranslateBook {
    translator: Arc<dyn Translator>,
    tabs: HashMap<TabId, TranslateState>,
    stages: HashMap<TabId, TranslateStage>,
    watching: HashMap<TabId, u64>,
    generations: u64,
    tokens: u64,
    user_languages: Option<Vec<String>>,
    supported: Option<Vec<String>>,
    loading_supported: bool,
    worlds: HashMap<TabId, i64>,
}

impl Default for TranslateBook {
    fn default() -> Self {
        TranslateBook::with(native::system_translator())
    }
}

impl TranslateBook {
    pub fn with(translator: Arc<dyn Translator>) -> Self {
        TranslateBook {
            translator,
            tabs: HashMap::new(),
            stages: HashMap::new(),
            watching: HashMap::new(),
            generations: 0,
            tokens: 0,
            user_languages: None,
            supported: None,
            loading_supported: false,
            worlds: HashMap::new(),
        }
    }

    pub fn state(&self, tab: &TabId) -> TranslateState {
        self.tabs.get(tab).cloned().unwrap_or_default()
    }

    pub fn holds(&self, tab: &TabId, token: &str) -> bool {
        self.tabs.get(tab).and_then(TranslateState::token) == Some(token)
    }

    fn set(&mut self, tab: &TabId, next: TranslateState) -> Option<String> {
        let ended = self
            .tabs
            .get(tab)
            .and_then(TranslateState::token)
            .filter(|token| next.token() != Some(*token))
            .map(str::to_owned);
        self.tabs.insert(tab.clone(), next);
        ended
    }

    pub fn forget(&mut self, tab: &TabId) -> Option<String> {
        self.stages.remove(tab);
        self.worlds.remove(tab);
        self.watching.remove(tab);
        self.tabs
            .remove(tab)
            .and_then(|state| state.token().map(str::to_owned))
    }

    pub fn forget_missing(&mut self, exists: impl Fn(&TabId) -> bool) -> Vec<String> {
        let gone: Vec<TabId> = self
            .tabs
            .keys()
            .filter(|tab| !exists(tab))
            .cloned()
            .collect();
        gone.iter().filter_map(|tab| self.forget(tab)).collect()
    }

    fn languages(&mut self) -> Vec<String> {
        self.user_languages
            .get_or_insert_with(|| self.translator.user_languages())
            .clone()
    }

    pub fn default_target(&mut self) -> String {
        base_language(self.languages().first().map(String::as_str).unwrap_or("en"))
    }

    fn new_token(&mut self) -> String {
        self.tokens += 1;
        format!(
            "{}-{}",
            ardia_state::ids::to_base36(ardia_state::store::now_ms().max(0) as u64),
            self.tokens
        )
    }
}

pub fn base_language(language: &str) -> String {
    let mut parts = language.split(['-', '_']);
    let lang = parts.next().unwrap_or_default().to_ascii_lowercase();
    if lang == "zh" {
        let second = parts.next().unwrap_or_default().to_ascii_lowercase();
        return if matches!(second.as_str(), "hant" | "tw" | "hk" | "mo") {
            "zh-Hant".to_owned()
        } else {
            "zh-Hans".to_owned()
        };
    }
    lang
}

pub fn translatable_host(url: &str) -> String {
    let lower = url
        .trim_start()
        .get(..8)
        .unwrap_or(url)
        .to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        host_of(url)
    } else {
        String::new()
    }
}

fn list_owner(profile: &ProfileId) -> ProfileId {
    if profile.is_incognito() {
        profile.incognito_original()
    } else {
        profile.clone()
    }
}

pub fn never_translated(
    settings: &ardia_state::settings::Settings,
    profile: &ProfileId,
    url: &str,
) -> bool {
    let host = translatable_host(url);
    !host.is_empty()
        && settings
            .never_translate_sites
            .get(list_owner(profile).as_str())
            .is_some_and(|list| list.contains(&host))
}

pub fn other_languages(
    supported: &[String],
    name: impl Fn(&str) -> String,
    current: Option<&str>,
) -> Vec<TranslateLanguage> {
    let mut best: Vec<(String, String)> = Vec::new();
    for id in supported {
        let key = base_language(id);
        match best.iter_mut().find(|(known, _)| *known == key) {
            Some((_, kept)) if id.len() < kept.len() => *kept = id.clone(),
            Some(_) => {}
            None => best.push((key, id.clone())),
        }
    }
    let mut out: Vec<TranslateLanguage> = best
        .into_iter()
        .map(|(_, id)| TranslateLanguage {
            name: name(&id),
            current: current == Some(id.as_str()),
            id,
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub struct Sample {
    pub lang: String,
    pub text: String,
    pub active: bool,
}

pub fn sample_of(value: &Value) -> Option<Sample> {
    let object = value.as_object()?;
    Some(Sample {
        lang: object
            .get("lang")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        text: object
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(SAMPLE_CHARS)
            .collect(),
        active: object.get("active").and_then(Value::as_bool) == Some(true),
    })
}

pub const TRANSLATE_WORLD: &str = "Ardia Translate";

async fn open_world(
    engine: &dyn ardia_engine::BrowserEngine,
    engine_tab: ardia_engine::EngineTabId,
) -> Option<i64> {
    let tree = engine
        .devtools_call(
            engine_tab,
            "Page.getFrameTree",
            Some(json!({})),
            PAGE_CALL_DEADLINE,
        )
        .await
        .ok()?;
    let frame = tree.pointer("/frameTree/frame/id")?.as_str()?.to_owned();
    let world = engine
        .devtools_call(
            engine_tab,
            "Page.createIsolatedWorld",
            Some(json!({ "frameId": frame, "worldName": TRANSLATE_WORLD, "grantUniveralAccess": false })),
            PAGE_CALL_DEADLINE,
        )
        .await
        .ok()?;
    world.get("executionContextId")?.as_i64()
}

pub fn sleep(duration: Duration) -> oneshot::Receiver<()> {
    let (done, wait) = oneshot::channel();
    let started = std::thread::Builder::new()
        .name("ardia-translate-timer".into())
        .spawn(move || {
            std::thread::sleep(duration);
            let _ = done.send(());
        });
    if let Err(problem) = started {
        log::debug!("a translation timer didn't start: {problem}");
    }
    wait
}

pub fn error_text(error: &str) -> String {
    error.trim_end_matches(['.', ' ', '\n']).to_owned()
}

#[derive(Default)]
struct Progress {
    applied: usize,
    unlinked: usize,
    failed: usize,
    packs: usize,
}

fn on_last_try(passages: &[Passage]) -> usize {
    passages
        .iter()
        .filter(|passage| passage.attempt >= drain::PASSAGE_RETRIES)
        .count()
}

pub async fn translate_pack(
    model: Arc<dyn Translator>,
    source: String,
    target: String,
    pack: Vec<Passage>,
    token: String,
    live: impl Fn() -> bool,
) -> Result<(Vec<Translated>, usize, usize), String> {
    let mut failed = 0;
    let blocks: Vec<Vec<String>> = pack
        .iter()
        .map(|passage| {
            passage
                .pieces
                .iter()
                .map(|(_, text)| text.clone())
                .collect()
        })
        .collect();
    let answers = match model
        .translate_blocks(&source, &target, blocks, &token)
        .await
    {
        Ok(answers) => answers,
        Err(error) => return Err(error),
    };
    let mut out: Vec<Translated> = Vec::new();
    let mut unlinked: Vec<&Passage> = Vec::new();
    for (i, passage) in pack.iter().enumerate() {
        match answers.get(i).cloned().flatten() {
            Some(parts) if parts.len() == passage.pieces.len() => out.extend(
                passage
                    .pieces
                    .iter()
                    .zip(parts)
                    .map(|((id, _), text)| (*id, Some(text))),
            ),
            _ if passage.pieces.len() > 1 && live() => unlinked.push(passage),
            _ => out.extend(passage.pieces.iter().map(|(id, _)| (*id, None))),
        }
    }
    let unlinked_count = unlinked.len();
    if !unlinked.is_empty() {
        let pieces: Vec<&(i64, String)> = unlinked.iter().flat_map(|p| p.pieces.iter()).collect();
        let single = model
            .translate_blocks(
                &source,
                &target,
                pieces.iter().map(|(_, text)| vec![text.clone()]).collect(),
                &token,
            )
            .await;
        let single = match single {
            Ok(single) => single,
            Err(error) => {
                if !out.iter().any(|(_, text)| text.is_some()) {
                    return Err(error);
                }
                pieces.iter().map(|_| None).collect()
            }
        };
        out.extend(pieces.iter().enumerate().map(|(i, (id, _))| {
            (
                *id,
                single
                    .get(i)
                    .cloned()
                    .flatten()
                    .and_then(|parts| parts.into_iter().next()),
            )
        }));
    }
    let answered: HashSet<i64> = out
        .iter()
        .filter(|(_, text)| text.is_some())
        .map(|(id, _)| *id)
        .collect();
    let unanswered: Vec<Passage> = pack
        .iter()
        .filter(|passage| !passage.pieces.iter().any(|(id, _)| answered.contains(id)))
        .cloned()
        .collect();
    if live() {
        failed += on_last_try(&unanswered);
    }
    if live() && unanswered.len() == pack.len() {
        return Err("the Mac's translation model didn't answer".to_owned());
    }
    Ok((out, unlinked_count, failed))
}

struct PageDrain {
    app: Weak<AppCoordinator>,
    tab: TabId,
    token: String,
    source: String,
    target: String,
    progress: Rc<RefCell<Progress>>,
    on_progress: Option<Box<dyn Fn(usize, usize)>>,
}

impl PageDrain {
    fn app(&self) -> Option<Arc<AppCoordinator>> {
        self.app.upgrade()
    }
}

impl DrainPort for PageDrain {
    fn holds(&self) -> bool {
        self.app().is_some_and(|app| {
            app.engine_tab(&self.tab).is_some()
                && app.bridge.lock().translate.holds(&self.tab, &self.token)
        })
    }

    fn next(&self, max_chars: usize) -> LocalBoxFuture<'static, Option<PageBatch>> {
        let call = self.app().map(|app| {
            app.page_call(
                &self.tab,
                PageOp::Next,
                &[
                    json!(self.token),
                    json!(drain::PACK_PASSAGES),
                    json!(max_chars),
                ],
            )
        });
        Box::pin(async move {
            let value = call?.await.ok()??;
            PageBatch::parse(&value)
        })
    }

    fn translate(
        &self,
        pack: Vec<Passage>,
    ) -> LocalBoxFuture<'static, Result<Vec<Translated>, String>> {
        self.progress.borrow_mut().packs += 1;
        let Some(app) = self.app() else {
            return Box::pin(async { Err("the window closed".to_owned()) });
        };
        let model = Arc::clone(&app.bridge.lock().translate.translator);
        let weak = self.app.clone();
        let (tab, token) = (self.tab.clone(), self.token.clone());
        let (source, target) = (self.source.clone(), self.target.clone());
        let progress = Rc::clone(&self.progress);
        Box::pin(async move {
            let live = || {
                weak.upgrade()
                    .is_some_and(|app| app.bridge.lock().translate.holds(&tab, &token))
            };
            let outcome =
                translate_pack(model, source, target, pack.clone(), token.clone(), live).await;
            match outcome {
                Ok((out, unlinked, failed)) => {
                    let mut progress = progress.borrow_mut();
                    progress.unlinked += unlinked;
                    progress.failed += failed;
                    Ok(out)
                }
                Err(error) => {
                    if live() {
                        progress.borrow_mut().failed += on_last_try(&pack);
                    }
                    Err(error)
                }
            }
        })
    }

    fn apply(&self, results: Vec<Translated>) -> LocalBoxFuture<'static, Result<(), String>> {
        let call = self.app().map(|app| {
            app.page_call(
                &self.tab,
                PageOp::Apply,
                &[json!(self.token), drain::results_json(&results)],
            )
        });
        Box::pin(async move {
            match call {
                Some(call) => call.await.map(|_| ()),
                None => Err("the tab closed".to_owned()),
            }
        })
    }

    fn on_stage(&self, stage: DrainStage) {
        if let Some(app) = self.app() {
            app.bridge.lock().translate.stages.insert(
                self.tab.clone(),
                match stage {
                    DrainStage::Collect => TranslateStage::Collect,
                    DrainStage::Model => TranslateStage::Model,
                    DrainStage::Apply => TranslateStage::Apply,
                },
            );
        }
    }

    fn on_applied(&self, passages: usize, total: usize) {
        let applied = {
            let mut progress = self.progress.borrow_mut();
            progress.applied += passages;
            progress.applied
        };
        if let Some(report) = &self.on_progress {
            report(applied, total);
        }
    }

    fn on_abandoned(&self, passages: usize) {
        self.progress.borrow_mut().failed += passages;
    }
}

impl AppCoordinator {
    pub fn set_translator(&self, translator: Arc<dyn Translator>) {
        self.bridge.lock().translate = TranslateBook::with(translator);
    }

    fn translator(&self) -> Arc<dyn Translator> {
        Arc::clone(&self.bridge.lock().translate.translator)
    }

    fn translate_state(&self, tab: &TabId) -> TranslateState {
        self.bridge.lock().translate.state(tab)
    }

    fn set_translate_state(&self, tab: &TabId, next: TranslateState) {
        let ended = self.bridge.lock().translate.set(tab, next);
        if let Some(token) = ended {
            self.translator().cancel(&token);
        }
        self.signal.emit(HostTopics::SITE);
    }

    fn translate_to_idle(&self, tab: &TabId) {
        let idle = self.translate_state(tab).idle();
        self.set_translate_state(tab, idle);
    }

    fn set_translate_source(&self, tab: &TabId, source: Option<String>) {
        if self.translate_state(tab).is_idle() {
            self.set_translate_state(tab, TranslateState::Idle { source });
        }
    }

    fn translate_holds(&self, tab: &TabId, token: &str) -> bool {
        self.bridge.lock().translate.holds(tab, token)
    }

    fn translate_stage(&self, tab: &TabId, stage: TranslateStage) {
        self.bridge
            .lock()
            .translate
            .stages
            .insert(tab.clone(), stage);
    }

    pub(crate) fn page_call(
        &self,
        tab: &TabId,
        op: PageOp,
        args: &[Value],
    ) -> LocalBoxFuture<'static, Result<Option<Value>, String>> {
        let (Some(engine), Some(engine_tab)) = (self.engine(), self.engine_tab(tab)) else {
            return Box::pin(async { Err("the tab closed".to_owned()) });
        };
        let expression = translator_call(op, args);
        let cached = self.bridge.lock().translate.worlds.get(tab).copied();
        let me = self.weak();
        let tab = tab.clone();
        Box::pin(async move {
            let mut world = cached;
            let mut last = "the page isn't ready".to_owned();
            for _ in 0..2 {
                let context = match world.take() {
                    Some(context) => context,
                    None => match open_world(engine.as_ref(), engine_tab).await {
                        Some(context) => {
                            if let Some(me) = me.upgrade() {
                                me.bridge
                                    .lock()
                                    .translate
                                    .worlds
                                    .insert(tab.clone(), context);
                            }
                            context
                        }
                        None => return Err(last),
                    },
                };
                let answer = engine
                    .devtools_call(
                        engine_tab,
                        "Runtime.evaluate",
                        Some(json!({
                            "expression": expression,
                            "contextId": context,
                            "returnByValue": true,
                        })),
                        PAGE_CALL_DEADLINE,
                    )
                    .await;
                match answer {
                    Ok(answer) => {
                        if let Some(details) = answer.get("exceptionDetails") {
                            let text = details
                                .pointer("/exception/description")
                                .or_else(|| details.get("text"))
                                .and_then(Value::as_str)
                                .unwrap_or("the page script failed");
                            return Err(text.lines().next().unwrap_or_default().to_owned());
                        }
                        return Ok(page_answer(answer.pointer("/result/value").cloned()));
                    }
                    Err(problem) => {
                        last = problem.to_string();
                        if let Some(me) = me.upgrade() {
                            me.bridge.lock().translate.worlds.remove(&tab);
                        }
                    }
                }
            }
            Err(last)
        })
    }

    fn translate_toast(&self, tab: &TabId, title: &str, detail: Option<&str>, progress: bool) {
        let Some(window) = self.window_of(tab) else {
            return;
        };
        let now = ardia_state::store::now_ms();
        let id = if progress {
            PROGRESS_TOAST_ID
        } else {
            now.max(0) as u64
        };
        if progress {
            self.dispatch_quietly(Action::DismissToast {
                window: window.clone(),
                id,
            });
        }
        self.dispatch_quietly(Action::PushToast {
            window,
            toast: Toast {
                id,
                kind: ToastKind::Info,
                message: match detail {
                    Some(detail) => format!("{title}\n{detail}"),
                    None => title.to_owned(),
                },
                action: None,
                icon: Some(TRANSLATE_ICON.to_owned()),
                created_at: now,
                expires_at: (!progress).then_some(now + TOAST_MS),
            },
        });
    }

    fn hide_progress_toast(&self, window: &WindowId) {
        self.dispatch_quietly(Action::DismissToast {
            window: window.clone(),
            id: PROGRESS_TOAST_ID,
        });
    }

    pub(crate) fn language_name(&self, language: &str) -> String {
        self.translator().language_name(language)
    }

    pub(crate) fn default_target(&self) -> String {
        self.bridge.lock().translate.default_target()
    }

    pub(crate) fn tab_never_translated(&self, tab: &TabId) -> bool {
        let state = self.store.snapshot();
        state
            .tab(tab.as_str())
            .is_some_and(|t| never_translated(&state.settings, &t.profile_id, &t.url))
    }

    pub(crate) fn translate_view_for(&self, tab: &TabId) -> TranslateView {
        let translator = self.translator();
        if !translator.available() {
            return TranslateView::default();
        }
        let current = self.translate_state(tab);
        let target = self.default_target();
        TranslateView {
            available: true,
            source: current.source().map(str::to_owned),
            translated: !current.is_idle(),
            never: self.tab_never_translated(tab),
            source_name: current
                .source()
                .map(|source| translator.language_name(source))
                .unwrap_or_default(),
            target_name: translator.language_name(&target),
        }
    }

    pub(crate) fn translate_languages_for(&self, tab: &TabId) -> Vec<TranslateLanguage> {
        let (supported, loading) = {
            let book = &self.bridge.lock().translate;
            (book.supported.clone(), book.loading_supported)
        };
        let translator = self.translator();
        let Some(supported) = supported else {
            if !loading && translator.available() {
                self.bridge.lock().translate.loading_supported = true;
                let reply = translator.supported_languages();
                let me = self.weak();
                self.spawn(async move {
                    let list = reply.await.unwrap_or_default();
                    if let Some(me) = me.upgrade() {
                        let mut bridge = me.bridge.lock();
                        bridge.translate.supported = Some(list);
                        bridge.translate.loading_supported = false;
                        drop(bridge);
                        me.signal.emit(HostTopics::SITE);
                    }
                });
            }
            return Vec::new();
        };
        let current = self.translate_state(tab);
        other_languages(
            &supported,
            |id| translator.language_name(id),
            current.target(),
        )
    }

    async fn page_language(self: &Arc<Self>, tab: &TabId) -> Option<(Option<String>, bool)> {
        if !self.translate_state(tab).is_idle() {
            self.translate_stage(tab, TranslateStage::Detect);
        }
        let value = self.page_call(tab, PageOp::Sample, &[]).await.ok()??;
        let sample = sample_of(&value)?;
        let translator = self.translator();
        if !translator.available() {
            return None;
        }
        let detected = (sample.text.chars().count() >= 40)
            .then(|| translator.detect(&sample.text))
            .flatten();
        let language = detected
            .or_else(|| (!sample.lang.is_empty()).then(|| sample.lang.chars().take(20).collect()));
        Some((language, sample.active))
    }

    pub(crate) fn detect_page_language(self: &Arc<Self>, tab: TabId) {
        let me = Arc::clone(self);
        self.spawn(async move { me.detect(&tab).await });
    }

    async fn detect(self: &Arc<Self>, tab: &TabId) {
        let url = self
            .store
            .snapshot()
            .tab(tab.as_str())
            .map(|t| t.url.clone());
        let translator = self.translator();
        if !url.is_some_and(|url| translator.available() && !translatable_host(&url).is_empty()) {
            self.set_translate_state(tab, TranslateState::default());
            return;
        }
        let before = self.translate_state(tab);
        let Some((language, active)) = self.page_language(tab).await else {
            return;
        };
        if !active
            && let Some(token) = before.token()
            && self.translate_holds(tab, token)
        {
            self.translate_to_idle(tab);
        }
        if self.tab_never_translated(tab) {
            self.set_translate_source(tab, None);
            return;
        }
        let mine: HashSet<String> = self
            .bridge
            .lock()
            .translate
            .languages()
            .iter()
            .map(|language| base_language(language))
            .collect();
        let source = language.filter(|language| !mine.contains(&base_language(language)));
        if let Some(source) = &source {
            let target = self.default_target();
            if translator
                .status(source, &target)
                .await
                .unwrap_or(LanguageStatus::Unsupported)
                == LanguageStatus::Unsupported
            {
                self.set_translate_source(tab, None);
                return;
            }
        }
        self.set_translate_source(tab, source);
    }

    pub(crate) fn translate_page_to(
        self: &Arc<Self>,
        tab: TabId,
        target: Option<String>,
        origin: TranslateOrigin,
    ) {
        let me = Arc::clone(self);
        self.spawn(async move {
            let target = target.unwrap_or_else(|| me.default_target());
            me.translate_page(&tab, target, origin).await;
        });
    }

    async fn translate_page(
        self: &Arc<Self>,
        tab: &TabId,
        target: String,
        _origin: TranslateOrigin,
    ) {
        let translator = self.translator();
        let window = self.window_of(tab);
        let (Some(window), true, Some(_)) = (window, translator.available(), self.engine_tab(tab))
        else {
            return;
        };
        self.revert_page(tab, true).await;
        let known = self.translate_state(tab).source().map(str::to_owned);
        let source = match known {
            Some(source) => Some(source),
            None => self
                .page_language(tab)
                .await
                .and_then(|(language, _)| language),
        };
        let Some(source) = source else {
            return self.translate_toast(
                tab,
                "Translation error (can't tell the page's language)",
                None,
                false,
            );
        };
        if base_language(&source) == base_language(&target) {
            let name = translator.language_name(&target);
            return self.translate_toast(
                tab,
                &format!("Translation error (the page is already in {name})"),
                None,
                false,
            );
        }
        let shown = Rc::new(Cell::new(false));
        let mut token: Option<String> = None;
        let outcome = self
            .run_translation(tab, &source, &target, &mut token, Rc::clone(&shown))
            .await;
        match outcome {
            Ok(true) => {
                let mine = token.unwrap_or_default();
                if self.translate_holds(tab, &mine) {
                    self.set_translate_state(
                        tab,
                        TranslateState::Translated {
                            source: source.clone(),
                            target: target.clone(),
                            token: mine.clone(),
                        },
                    );
                }
                let name = translator.language_name(&target);
                self.translate_toast(tab, &format!("Translated to {name}"), None, false);
                let me = Arc::clone(self);
                let tab = tab.clone();
                self.spawn(async move { me.follow(&tab, &mine).await });
            }
            Ok(false) => {
                if let Some(mine) = &token
                    && self.translate_holds(tab, mine)
                {
                    self.translate_to_idle(tab);
                }
                if shown.get() && self.translate_state(tab).is_idle() {
                    self.hide_progress_toast(&window);
                }
            }
            Err(error) => {
                let replaced = token
                    .as_deref()
                    .is_some_and(|mine| !self.translate_holds(tab, mine));
                if shown.get() && (!replaced || self.translate_state(tab).is_idle()) {
                    self.hide_progress_toast(&window);
                }
                if replaced {
                    return;
                }
                if token.is_some() {
                    self.revert_page(tab, true).await;
                }
                self.translate_toast(
                    tab,
                    &format!("Translation error ({})", error_text(&error)),
                    None,
                    false,
                );
            }
        }
    }

    async fn run_translation(
        self: &Arc<Self>,
        tab: &TabId,
        source: &str,
        target: &str,
        token: &mut Option<String>,
        shown: Rc<Cell<bool>>,
    ) -> Result<bool, String> {
        let translator = self.translator();
        let status = translator.status(source, target).await?;
        if status == LanguageStatus::Unsupported {
            return Err(format!(
                "{} to {} isn't available",
                translator.language_name(source),
                translator.language_name(target)
            ));
        }
        if status == LanguageStatus::Supported {
            translator.prepare(source, target).await?;
        }
        let mine = self.bridge.lock().translate.new_token();
        *token = Some(mine.clone());
        translator.open(&mine).await?;
        ardia_telemetry::capture("translate_used", serde_json::Map::new());
        self.set_translate_state(
            tab,
            TranslateState::Translating {
                source: source.to_owned(),
                target: target.to_owned(),
                token: mine.clone(),
            },
        );
        self.translate_stage(tab, TranslateStage::Start);
        let started = self
            .page_call(tab, PageOp::Start, &[json!(mine)])
            .await?
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if !started {
            return Err("the page isn't ready".to_owned());
        }
        let started_at = Instant::now();
        let weak = self.weak();
        let progress_tab = tab.clone();
        let target_name = translator.language_name(target);
        let reporter: Box<dyn Fn(usize, usize)> = Box::new(move |done, total| {
            if started_at.elapsed() < Duration::from_millis(PROGRESS_AFTER_MS) || total == 0 {
                return;
            }
            shown.set(true);
            if let Some(app) = weak.upgrade() {
                let percent = ((done as f64 / total as f64) * 100.0).round().min(99.0) as u32;
                app.translate_toast(
                    &progress_tab,
                    &format!("Translating to {target_name}…"),
                    Some(&format!("{percent}%")),
                    true,
                );
            }
        });
        let port = Rc::new(PageDrain {
            app: self.weak(),
            tab: tab.clone(),
            token: mine,
            source: source.to_owned(),
            target: target.to_owned(),
            progress: Rc::new(RefCell::new(Progress::default())),
            on_progress: Some(reporter),
        });
        drain::drain_passages(port).await
    }

    async fn follow(self: &Arc<Self>, tab: &TabId, token: &str) {
        loop {
            let _ = sleep(Duration::from_millis(FOLLOW_MS)).await;
            let current = self.translate_state(tab);
            if !matches!(current, TranslateState::Translated { .. })
                || current.token() != Some(token)
            {
                return;
            }
            self.translate_stage(tab, TranslateStage::Follow);
            let (source, target) = (
                current.source().unwrap_or_default().to_owned(),
                current.target().unwrap_or_default().to_owned(),
            );
            let port = Rc::new(PageDrain {
                app: self.weak(),
                tab: tab.clone(),
                token: token.to_owned(),
                source,
                target,
                progress: Rc::new(RefCell::new(Progress::default())),
                on_progress: None,
            });
            if drain::drain_passages(port).await == Ok(true) {
                continue;
            }
            if !self.translate_holds(tab, token) {
                return;
            }
            if self
                .page_language(tab)
                .await
                .is_some_and(|(_, active)| active)
            {
                continue;
            }
            if self.translate_holds(tab, token) {
                self.translate_to_idle(tab);
            }
            return;
        }
    }

    async fn revert_page(self: &Arc<Self>, tab: &TabId, quiet: bool) {
        let before = self.translate_state(tab);
        self.translate_to_idle(tab);
        let _ = self.page_call(tab, PageOp::Revert, &[]).await;
        if !quiet
            && !before.is_idle()
            && let Some(source) = before.source()
        {
            let name = self.language_name(source);
            self.translate_toast(tab, &format!("Translated back to {name}"), None, false);
        }
    }

    pub(crate) fn show_original(self: &Arc<Self>, tab: TabId) {
        let me = Arc::clone(self);
        self.spawn(async move { me.revert_page(&tab, false).await });
    }

    pub(crate) fn toggle_translation(self: &Arc<Self>, tab: TabId, origin: TranslateOrigin) {
        if self.translate_state(&tab).is_idle() {
            self.translate_page_to(tab, None, origin);
        } else {
            self.show_original(tab);
        }
    }

    pub(crate) fn set_never_translate(self: &Arc<Self>, tab: &TabId, never: bool) {
        let state = self.store.snapshot();
        let Some(current) = state.tab(tab.as_str()) else {
            return;
        };
        let host = translatable_host(&current.url);
        if host.is_empty() || current.profile_id.is_incognito() {
            return;
        }
        let mut all = state.settings.never_translate_sites.clone();
        let list = all.entry(current.profile_id.to_string()).or_default();
        list.retain(|known| *known != host);
        if never {
            list.push(host);
        }
        self.dispatch(Action::UpdateSettings {
            patch: SettingsPatch::new().set(
                "neverTranslateSites",
                serde_json::to_value(all).unwrap_or_default(),
            ),
            from_sync: false,
        });
        if !never {
            self.detect_page_language(tab.clone());
            return;
        }
        if !self.translate_state(tab).is_idle() {
            let me = Arc::clone(self);
            let tab = tab.clone();
            self.spawn(async move {
                me.revert_page(&tab, true).await;
                me.set_translate_source(&tab, None);
            });
        } else {
            self.set_translate_source(tab, None);
        }
    }

    pub(crate) fn note_translate_event(&self, event: &ardia_engine::EngineEvent) {
        let ardia_engine::EngineEvent::LoadingChanged { tab, loading } = event else {
            return;
        };
        if let (Some(tab), Some(me)) = (self.state_tab(*tab), self.weak().upgrade()) {
            me.translate_loading_changed(&tab, *loading);
        }
    }

    pub(crate) fn translate_loading_changed(self: &Arc<Self>, tab: &TabId, loading: bool) {
        if loading {
            self.watch_translated_document(tab.clone());
            return;
        }
        self.bridge.lock().translate.watching.remove(tab);
        self.detect_page_language(tab.clone());
    }

    fn watch_translated_document(self: &Arc<Self>, tab: TabId) {
        let Some(token) = self.translate_state(&tab).token().map(str::to_owned) else {
            self.bridge.lock().translate.watching.remove(&tab);
            return;
        };
        let generation = {
            let mut bridge = self.bridge.lock();
            bridge.translate.generations += 1;
            let generation = bridge.translate.generations;
            bridge.translate.watching.insert(tab.clone(), generation);
            generation
        };
        let me = Arc::clone(self);
        self.spawn(async move {
            let current = |me: &AppCoordinator| {
                me.bridge.lock().translate.watching.get(&tab) == Some(&generation)
            };
            let loading = |me: &AppCoordinator| {
                me.store
                    .snapshot()
                    .tab(tab.as_str())
                    .is_some_and(|t| t.live.loading)
            };
            while current(&me) && me.translate_holds(&tab, &token) && loading(&me) {
                let same = me
                    .page_call(&tab, PageOp::Holds, &[json!(token)])
                    .await
                    .ok()
                    .flatten()
                    .and_then(|value| value.as_bool());
                if !current(&me) {
                    return;
                }
                if same == Some(false) && me.translate_holds(&tab, &token) {
                    me.translate_to_idle(&tab);
                    break;
                }
                let _ = sleep(Duration::from_millis(DOCUMENT_POLL_MS)).await;
            }
            if current(&me) {
                me.bridge.lock().translate.watching.remove(&tab);
            }
        });
    }

    pub(crate) fn cancel_translations(&self, tokens: Vec<String>) {
        let translator = self.translator();
        for token in tokens {
            translator.cancel(&token);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base_languages_fold_regions_and_chinese_scripts() {
        assert_eq!(base_language("en-GB"), "en");
        assert_eq!(base_language("zh-Hant-TW"), "zh-Hant");
        assert_eq!(base_language("zh_TW"), "zh-Hant");
        assert_eq!(base_language("zh-CN"), "zh-Hans");
        assert_eq!(base_language("pt_BR"), "pt");
    }

    #[test]
    fn never_translate_lists_follow_the_original_profile() {
        let sites = ardia_state::settings::Settings {
            never_translate_sites: serde_json::from_value(json!({"default": ["lemonde.fr"]}))
                .expect("sites"),
            ..ardia_state::settings::Settings::default()
        };
        let window = WindowId::new("w1");
        let private = ProfileId::incognito(&window, &ProfileId::default_profile());
        assert!(never_translated(
            &sites,
            &ProfileId::default_profile(),
            "https://lemonde.fr/a"
        ));
        assert!(never_translated(&sites, &private, "https://lemonde.fr/b"));
        assert!(!never_translated(
            &sites,
            &ProfileId::default_profile(),
            "ardia://settings"
        ));
    }

    #[test]
    fn other_languages_keep_the_shortest_id_per_language_sorted_by_name() {
        let supported = vec![
            "fr-CA".to_owned(),
            "fr".to_owned(),
            "de".to_owned(),
            "zh-Hant".to_owned(),
        ];
        let names = |id: &str| match id {
            "fr" => "French".to_owned(),
            "de" => "German".to_owned(),
            "zh-Hant" => "Chinese, Traditional".to_owned(),
            other => other.to_owned(),
        };
        let list = other_languages(&supported, names, Some("de"));
        assert_eq!(
            list.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            vec!["zh-Hant", "fr", "de"]
        );
        assert!(list[2].current);
    }

    #[test]
    fn book_cancels_tokens_that_end() {
        let mut book = TranslateBook::with(Arc::new(native::NoTranslator));
        let tab = TabId::new("t");
        assert_eq!(
            book.set(
                &tab,
                TranslateState::Translating {
                    source: "fr".into(),
                    target: "en".into(),
                    token: "a".into()
                }
            ),
            None
        );
        assert!(book.holds(&tab, "a"));
        assert_eq!(
            book.set(
                &tab,
                TranslateState::Idle {
                    source: Some("fr".into())
                }
            ),
            Some("a".to_owned())
        );
        assert_eq!(book.state(&tab).source(), Some("fr"));
        assert_eq!(error_text("the page isn't ready. "), "the page isn't ready");
    }
}
