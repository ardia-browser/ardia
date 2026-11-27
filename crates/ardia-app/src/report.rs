use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use ardia_engine::{BrowserEngine, EngineQuery, Reply as EngineReply};
use ardia_state::windows::WindowKind;
use ardia_state::{Action, BrowserStore, NewTab, WindowId};
use ardia_ui::report::identity::anonymous_identity;
use ardia_ui::report::state::{
    APP_INGEST_KEY, AttachmentKey, Created, FEEDBACK_URL, FailedStage, INGEST_KEY_HEADER,
    RECORD_FAILED, RECORDING_SAVE_FAILED, RETRY_DELAYS_MS, Recorded, RecordingState, ReportCommand,
    ReportView, Sent, SentReport, TraceState, UploadState, failure_class, failure_message,
    issue_number_of, report_path, restart_reason, upload_urls_from,
};
use ardia_ui::report::{
    PayloadContext, ReportFile, ReportKind, TRACE_MAX_SECONDS, build_payload, clamp_contact,
    clamp_description, clamp_title, draft_problems, watch_days, watch_end_date,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::live::now_ms;
use crate::net::{NetError, Reply, Transport};

pub const ENDPOINT_ENV: &str = "ARDIA_FEEDBACK_URL";

pub fn endpoint() -> String {
    std::env::var(ENDPOINT_ENV)
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| FEEDBACK_URL.to_owned())
}

struct JsonReply {
    status: u16,
    json: Value,
}

fn reply_of(result: Result<Reply, NetError>) -> JsonReply {
    match result {
        Ok(reply) => JsonReply {
            status: reply.status,
            json: reply.json().unwrap_or(Value::Null),
        },
        Err(_) => JsonReply {
            status: 0,
            json: Value::Null,
        },
    }
}

fn succeeded(status: u16) -> bool {
    (200..300).contains(&status)
}

pub struct Uploader<'a> {
    pub transport: &'a dyn Transport,
    pub endpoint: String,
    pub sleep: &'a dyn Fn(Duration),
    pub cancelled: &'a dyn Fn() -> bool,
    pub on_state: &'a dyn Fn(UploadState),
}

impl Uploader<'_> {
    fn post(&self, url: &str, body: &Value, headers: &[(&str, String)]) -> JsonReply {
        let mut all: Vec<(&str, String)> = vec![("Content-Type", "application/json".into())];
        all.extend(headers.iter().cloned());
        reply_of(
            self.transport
                .send("POST", url, &all, Some(body.to_string().into_bytes())),
        )
    }

    fn put(&self, url: &str, headers: &[(&str, String)], file: &ReportFile) -> JsonReply {
        let Ok(bytes) = std::fs::read(&file.path) else {
            return JsonReply {
                status: 0,
                json: Value::Null,
            };
        };
        let mut all: Vec<(&str, String)> = vec![("Content-Type", file.kind.clone())];
        all.extend(headers.iter().cloned());
        reply_of(self.transport.send("PUT", url, &all, Some(bytes)))
    }

    fn retrying(&self, retries: &mut u32, call: &dyn Fn() -> JsonReply) -> (JsonReply, u32) {
        let mut attempts = 1;
        loop {
            let reply = call();
            let delay = RETRY_DELAYS_MS.get(attempts as usize - 1).copied();
            if succeeded(reply.status)
                || delay.is_none()
                || (self.cancelled)()
                || !failure_class(reply.status, &reply.json).retryable()
            {
                return (reply, attempts);
            }
            *retries += 1;
            (self.sleep)(Duration::from_millis(delay.unwrap_or(0)));
            if (self.cancelled)() {
                return (reply, attempts);
            }
            attempts += 1;
        }
    }

    fn failure(
        stage: FailedStage,
        reply: &JsonReply,
        attempts: u32,
        created: Option<Created>,
    ) -> UploadState {
        let class = failure_class(reply.status, &reply.json);
        UploadState::Failed {
            stage,
            message: failure_message(class, reply.status, &reply.json),
            created,
            class,
            status: reply.status,
            attempts,
        }
    }

    pub fn send(
        &self,
        payload: &Value,
        files: &[ReportFile],
        resume: Option<Created>,
    ) -> UploadState {
        let started = now_ms();
        let total: u64 = files.iter().map(|f| f.bytes).sum();
        let finish = |state: UploadState| {
            (self.on_state)(state.clone());
            state
        };
        let mut retries = 0;
        let key = (INGEST_KEY_HEADER, APP_INGEST_KEY.to_owned());
        let mut created = match resume {
            Some(created) => created,
            None => {
                (self.on_state)(UploadState::Creating);
                let (reply, attempts) = self.retrying(&mut retries, &|| {
                    self.post(&self.endpoint, payload, std::slice::from_ref(&key))
                });
                if (self.cancelled)() {
                    return finish(UploadState::Idle);
                }
                let id = reply
                    .json
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                let token = reply
                    .json
                    .get("upload_token")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                let (Some(id), true) = (
                    id,
                    succeeded(reply.status) && (files.is_empty() || token.is_some()),
                ) else {
                    return finish(Self::failure(FailedStage::Create, &reply, attempts, None));
                };
                Created {
                    upload_urls: upload_urls_from(&reply.json, &self.endpoint, &id, files),
                    name: reply
                        .json
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    token: token.unwrap_or_default(),
                    uploaded: Vec::new(),
                    declared: files
                        .iter()
                        .map(|f| (f.name.clone(), f.bytes))
                        .collect::<BTreeMap<_, _>>(),
                    id,
                }
            }
        };
        let auth = [
            ("Authorization", format!("Bearer {}", created.token)),
            key.clone(),
        ];
        let mut done: u64 = files
            .iter()
            .filter(|f| created.uploaded.contains(&f.name))
            .map(|f| f.bytes)
            .sum();
        for file in files {
            if created.uploaded.contains(&file.name) {
                continue;
            }
            let url = created
                .upload_urls
                .get(&file.name)
                .cloned()
                .unwrap_or_else(|| {
                    report_path(&self.endpoint, &created.id, &format!("files/{}", file.name))
                });
            (self.on_state)(UploadState::Uploading {
                created: created.clone(),
                file: file.name.clone(),
                sent: done,
                total,
            });
            let (reply, attempts) = self.retrying(&mut retries, &|| self.put(&url, &auth, file));
            if (self.cancelled)() {
                return finish(UploadState::Idle);
            }
            if !succeeded(reply.status) {
                return finish(Self::failure(
                    FailedStage::Upload,
                    &reply,
                    attempts,
                    Some(created),
                ));
            }
            done += file.bytes;
            created.uploaded.push(file.name.clone());
        }
        (self.on_state)(UploadState::Completing {
            created: created.clone(),
        });
        let complete = report_path(&self.endpoint, &created.id, "complete");
        let (reply, attempts) =
            self.retrying(&mut retries, &|| self.post(&complete, &json!({}), &auth));
        if (self.cancelled)() {
            return finish(UploadState::Idle);
        }
        if !succeeded(reply.status) {
            return finish(Self::failure(
                FailedStage::Complete,
                &reply,
                attempts,
                Some(created),
            ));
        }
        let issue_url = reply
            .json
            .get("issue_url")
            .and_then(Value::as_str)
            .map(str::to_owned);
        finish(UploadState::Sent(Sent {
            id: reply
                .json
                .get("id")
                .and_then(Value::as_str)
                .map_or_else(|| created.id.clone(), str::to_owned),
            name: reply
                .json
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(created.name),
            issue_number: reply
                .json
                .get("issue_number")
                .and_then(Value::as_u64)
                .or_else(|| issue_number_of(issue_url.as_deref())),
            issue_url,
            upload_ms: now_ms() - started,
            bytes: total,
            retries,
        }))
    }
}

pub const RECORDING_FILE: &str = "recording.mp4";
pub const TRACE_FILE: &str = "trace.json.gz";
pub const DRAFTS_FOLDER: &str = "Report Drafts";

#[derive(Clone, Debug, PartialEq)]
pub struct RecordPlan {
    pub path: PathBuf,
    pub thumbnail: PathBuf,
    pub include_pages: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Finished {
    pub path: String,
    pub seconds: f64,
    pub bytes: u64,
    pub thumbnail: Option<String>,
    pub picture_in_picture: bool,
}

pub type StopDone = Box<dyn FnOnce(Option<Finished>) + Send>;

pub trait RecorderBackend: Send + Sync {
    fn stop(&self, done: StopDone);
    fn cancel(&self);
}

pub type TraceBegun = Box<dyn FnOnce(bool) + Send>;
pub type TraceEnded = Box<dyn FnOnce(Option<String>) + Send>;

pub trait EngineTracer: Send + Sync {
    fn begin(&self, done: TraceBegun);
    fn end(&self, keep: bool, done: TraceEnded);
}

pub fn begin_reply(engine: &dyn BrowserEngine) -> Option<EngineReply<bool>> {
    let busy = engine
        .query(EngineQuery::IsTracing)
        .map_or(true, |v| v.as_bool().unwrap_or(false));
    (!busy).then(|| engine.begin_tracing())
}

pub struct MainThreadTracer {
    pub coordinator: std::sync::Weak<crate::coordinator::AppCoordinator>,
}

impl EngineTracer for MainThreadTracer {
    fn begin(&self, done: TraceBegun) {
        let Some(coordinator) = self.coordinator.upgrade() else {
            return done(false);
        };
        coordinator.post(
            move |c| match c.engine().and_then(|e| begin_reply(e.as_ref())) {
                None => done(false),
                Some(reply) => c.spawn(async move { done(reply.await.unwrap_or(false)) }),
            },
        );
    }

    fn end(&self, keep: bool, done: TraceEnded) {
        let Some(coordinator) = self.coordinator.upgrade() else {
            return done(None);
        };
        coordinator.post(move |c| match c.engine() {
            None => done(None),
            Some(engine) => {
                let reply = engine.end_tracing(keep);
                c.spawn(async move { done(reply.await.ok().flatten()) });
            }
        });
    }
}

pub fn gzip_file(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<u64> {
    use std::io::Write;
    let raw = std::fs::read(source)?;
    let file = std::fs::File::create(destination)?;
    let mut encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    encoder.write_all(&raw)?;
    encoder.finish()?.sync_all()?;
    Ok(std::fs::metadata(destination)?.len())
}

pub struct ReportHub {
    view: Mutex<Arc<ReportView>>,
    tracer: Option<Arc<dyn EngineTracer>>,
    backend: Mutex<Option<Arc<dyn RecorderBackend>>>,
    draft_dir: Mutex<Option<PathBuf>>,
    trace_started: Mutex<Option<Instant>>,
    transport: Option<Arc<dyn Transport>>,
    store: Option<Arc<BrowserStore>>,
    notify: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
    cancelled: Arc<AtomicBool>,
    identity: Mutex<Option<String>>,
    local: Mutex<Option<crate::report_local::Exported>>,
    data_dir: Option<PathBuf>,
}

pub fn system_line() -> String {
    let arch = if cfg!(target_arch = "aarch64") {
        "Apple silicon"
    } else {
        "Intel"
    };
    format!("Ardia {} · macOS · {arch}", env!("CARGO_PKG_VERSION"))
}

impl ReportHub {
    pub fn new(
        transport: Option<Arc<dyn Transport>>,
        store: Option<Arc<BrowserStore>>,
        data_dir: Option<PathBuf>,
        tracer: Option<Arc<dyn EngineTracer>>,
    ) -> Arc<ReportHub> {
        Arc::new(ReportHub {
            view: Mutex::new(Arc::new(ReportView::default())),
            tracer,
            backend: Mutex::new(None),
            draft_dir: Mutex::new(None),
            trace_started: Mutex::new(None),
            transport,
            store,
            notify: Mutex::new(Vec::new()),
            cancelled: Arc::new(AtomicBool::new(false)),
            identity: Mutex::new(None),
            local: Mutex::new(None),
            data_dir,
        })
    }

    pub fn view(&self) -> Arc<ReportView> {
        Arc::clone(&self.view.lock())
    }

    pub fn subscribe(&self, notify: Arc<dyn Fn() + Send + Sync>) {
        self.notify.lock().push(notify);
    }

    fn set(&self, change: impl FnOnce(&mut ReportView)) {
        {
            let mut view = self.view.lock();
            change(Arc::make_mut(&mut view));
        }
        for listener in self.notify.lock().clone() {
            listener();
        }
    }

    fn page_address(&self, window: &WindowId) -> Option<String> {
        let state = self.store.as_ref()?.snapshot();
        let tab = state.active_tab(window.as_str())?;
        (tab.url.starts_with("http://") || tab.url.starts_with("https://")).then(|| tab.url.clone())
    }

    fn files(&self) -> Vec<ReportFile> {
        let view = self.view();
        let mut files = Vec::new();
        let measured = |path: &str, bytes: u64| {
            std::fs::metadata(path)
                .map(|m| m.len())
                .ok()
                .filter(|n| *n > 0)
                .unwrap_or(bytes)
        };
        if let Some(recorded) = view.recording.recorded() {
            files.push(ReportFile {
                name: RECORDING_FILE.into(),
                path: recorded.path.clone(),
                bytes: measured(&recorded.path, recorded.bytes),
                kind: "video/mp4".into(),
            });
        }
        if let (ReportKind::Slow, TraceState::Ready { path, bytes, .. }) =
            (view.draft.kind, &view.trace)
        {
            files.push(ReportFile {
                name: TRACE_FILE.into(),
                path: path.clone(),
                bytes: measured(path, *bytes),
                kind: "application/gzip".into(),
            });
        }
        if view.draft.attach.errors
            && let Some(local) = self.local.lock().clone().filter(|l| l.lines > 0)
        {
            files.push(ReportFile {
                name: "local-events.jsonl.gz".into(),
                path: local.path.to_string_lossy().into_owned(),
                bytes: std::fs::metadata(&local.path).map_or(local.bytes, |m| m.len()),
                kind: "application/gzip".into(),
            });
        }
        files
    }

    fn refresh_local_events(self: &Arc<Self>) {
        let Some(dir) = self.data_dir.clone() else {
            return;
        };
        let hub = Arc::clone(self);
        let since = now_ms() - ardia_ui::report::LOCAL_EVENTS_DAYS * 86_400_000;
        let spawned = std::thread::Builder::new()
            .name("ardia-report-local".into())
            .spawn(move || {
                let exported = crate::report_local::export_for_report(&dir, since);
                let lines = exported.as_ref().map(|e| e.lines);
                *hub.local.lock() = exported;
                hub.set(|v| {
                    if v.window.is_some() {
                        v.local_events = lines;
                    }
                });
            });
        if let Err(problem) = spawned {
            log::debug!("local events couldn't be read: {problem}");
        }
    }

    fn context(
        &self,
        view: &ReportView,
        install_id: &str,
        files: Vec<ReportFile>,
    ) -> PayloadContext {
        let mut diagnostics = Map::new();
        diagnostics.insert("kind".into(), Value::from(view.draft.kind.value()));
        PayloadContext {
            install_id: install_id.to_owned(),
            session_id: None,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            app_build: env!("CARGO_PKG_VERSION").to_owned(),
            channel: None,
            os_version: "macOS".to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            page_address: view.page_address.clone(),
            sharing: view.sharing,
            diagnostics,
            files,
        }
    }

    fn install_id(&self) -> Option<String> {
        let bytes = std::fs::read(self.data_dir.as_ref()?.join("telemetry.json")).ok()?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        value.get("installId")?.as_str().map(str::to_owned)
    }

    pub fn preview_payload(&self) -> String {
        let view = self.view();
        let id = self
            .identity
            .lock()
            .clone()
            .unwrap_or_else(|| "<anonymous id, made when you send>".into());
        serde_json::to_string_pretty(&build_payload(
            &view.draft,
            &self.context(&view, &id, self.files()),
        ))
        .unwrap_or_default()
    }

    pub fn command(self: &Arc<Self>, command: ReportCommand) {
        match command {
            ReportCommand::Open { window } => {
                if self.view().sent.is_some() {
                    self.reset();
                }
                let page = self.page_address(&window);
                let private_window = self.window_is_private(&window);
                let sharing = self
                    .data_dir
                    .as_deref()
                    .is_some_and(crate::ntp_extras::sharing);
                self.set(|v| {
                    v.sharing = sharing;
                    v.window = Some(window);
                    v.page_address = page;
                    v.system_line = system_line();
                    v.preview = false;
                    v.attached_open = false;
                    v.can_record = crate::recorder::can_record();
                    v.private_window = private_window;
                });
                self.refresh_local_events();
            }
            ReportCommand::Close => {
                if self.view().upload.busy() {
                    self.cancelled.store(true, Ordering::Release);
                    self.set(|v| v.upload = UploadState::Idle);
                }
                if self.view().sent.is_some() {
                    self.reset();
                    return;
                }
                self.set(|v| {
                    v.window = None;
                    v.attached_open = false;
                    v.preview = false;
                });
            }
            ReportCommand::SetKind(kind) => self.set(|v| {
                v.draft.kind = kind;
                if kind != ardia_ui::report::ReportKind::Slow {
                    v.draft.trace = false;
                }
            }),
            ReportCommand::SetTitle(t) => self.set(|v| v.draft.title = clamp_title(&t)),
            ReportCommand::SetDescription(t) => {
                self.set(|v| v.draft.description = clamp_description(&t))
            }
            ReportCommand::SetContact(t) => self.set(|v| v.draft.contact = clamp_contact(&t)),
            ReportCommand::SetWatch(on) => self.set(|v| v.draft.watch = on),
            ReportCommand::SetAttach { key, on } => self.set(|v| match key {
                AttachmentKey::System => v.draft.attach.system = on,
                AttachmentKey::Errors => v.draft.attach.errors = on,
                AttachmentKey::Settings => v.draft.attach.settings = on,
                AttachmentKey::Page => v.draft.attach.page = on,
            }),
            ReportCommand::SetAttachedOpen(open) => self.set(|v| {
                v.attached_open = open;
                if open {
                    v.watching = false;
                }
            }),
            ReportCommand::StopRecording => self.stop_recording(),
            ReportCommand::DiscardRecording => self.discard_recording(),
            ReportCommand::SetIncludePages(on) => self.set(|v| {
                if v.recording.recorded().is_none() && !v.private_window {
                    v.draft.include_pages = on;
                }
            }),
            ReportCommand::SetTrace(on) => self.set(|v| {
                if v.recording.recorded().is_none() && v.draft.kind == ReportKind::Slow {
                    v.draft.trace = on;
                }
            }),
            ReportCommand::SetWatching(on) => self.set(|v| {
                v.watching = on && v.recording.recorded().is_some();
                if v.watching {
                    v.attached_open = false;
                }
            }),
            ReportCommand::SetPreview(preview) => {
                let text = preview.then(|| self.preview_payload());
                self.set(|v| {
                    v.preview = preview;
                    v.attached_open = false;
                    v.payload_preview = text;
                });
            }
            ReportCommand::Send => self.send(),
            ReportCommand::ViewIssue => {
                let view = self.view();
                if let (Some(url), Some(window), Some(store)) = (
                    view.sent.as_ref().and_then(|s| s.issue_url.clone()),
                    view.window.clone(),
                    &self.store,
                ) {
                    let _ = store.dispatch(Action::NewTab {
                        window,
                        tab: NewTab {
                            url: Some(url),
                            ..NewTab::default()
                        },
                    });
                }
            }
            ReportCommand::Finish => self.reset(),
        }
    }

    fn reset(self: &Arc<Self>) {
        *self.identity.lock() = None;
        if self.view().recording.hides_sheet()
            && let Some(backend) = self.backend.lock().take()
        {
            backend.cancel();
        }
        self.discard_trace();
        if let Some(dir) = self.draft_dir.lock().take() {
            let _ = std::fs::remove_dir_all(dir);
        }
        self.set(|v| *v = ReportView::default());
    }

    fn window_is_private(&self, window: &WindowId) -> bool {
        self.store.as_ref().is_some_and(|store| {
            store
                .snapshot()
                .window(window.as_str())
                .is_some_and(|w| w.kind == WindowKind::Incognito || w.profile_id.is_incognito())
        })
    }

    fn ensure_draft_dir(&self) -> PathBuf {
        let mut slot = self.draft_dir.lock();
        if let Some(dir) = slot.as_ref().filter(|d| d.is_dir()) {
            return dir.clone();
        }
        let base = self.data_dir.as_ref().map_or_else(
            || std::env::temp_dir().join("ArdiaReport"),
            |d| d.join(DRAFTS_FOLDER),
        );
        let dir = base.join(uuid::Uuid::new_v4().to_string());
        if let Err(problem) = std::fs::create_dir_all(&dir) {
            log::warn!("report draft folder couldn't be made: {problem}");
        }
        *slot = Some(dir.clone());
        dir
    }

    pub fn plan_recording(self: &Arc<Self>) -> Option<RecordPlan> {
        let view = self.view();
        if view.window.is_none() || view.recording.busy() {
            return None;
        }
        self.discard_recording();
        let include_pages = view.draft.include_pages && !view.private_window;
        self.set(|v| {
            v.recording = RecordingState::Starting;
            v.attached_open = false;
            v.preview = false;
            v.watching = false;
        });
        let dir = self.ensure_draft_dir();
        if view.draft.kind == ReportKind::Slow && view.draft.trace {
            self.start_trace();
        }
        Some(RecordPlan {
            path: dir.join(RECORDING_FILE),
            thumbnail: dir.join(format!("recording-{}.png", now_ms())),
            include_pages,
        })
    }

    pub fn recording_started(&self, include_pages: bool, backend: Arc<dyn RecorderBackend>) {
        if !matches!(self.view().recording, RecordingState::Starting) {
            backend.cancel();
            return;
        }
        *self.backend.lock() = Some(backend);
        self.set(|v| {
            v.recording = RecordingState::Recording {
                seconds: 0.0,
                include_pages,
            }
        });
    }

    pub fn recording_start_failed(self: &Arc<Self>) {
        self.finish_trace();
        self.set(|v| {
            v.recording = RecordingState::Failed {
                message: RECORD_FAILED.into(),
            }
        });
    }

    pub fn recording_tick(self: &Arc<Self>, seconds: f64) {
        let view = self.view();
        if let RecordingState::Recording {
            seconds: shown,
            include_pages,
        } = view.recording
            && seconds.floor() != shown.floor()
        {
            self.set(|v| {
                v.recording = RecordingState::Recording {
                    seconds,
                    include_pages,
                }
            });
        }
        if view.trace == TraceState::Tracing && seconds >= f64::from(TRACE_MAX_SECONDS) {
            self.finish_trace();
        }
    }

    fn stop_recording(self: &Arc<Self>) {
        let RecordingState::Recording { include_pages, .. } = self.view().recording else {
            return;
        };
        self.set(|v| v.recording = RecordingState::Saving { include_pages });
        let Some(backend) = self.backend.lock().take() else {
            self.recording_stopped(None);
            return;
        };
        let hub = Arc::clone(self);
        backend.stop(Box::new(move |result| hub.recording_stopped(result)));
    }

    pub fn recording_stopped(self: &Arc<Self>, result: Option<Finished>) {
        self.finish_trace();
        let RecordingState::Saving { include_pages } = self.view().recording else {
            if let Some(done) = result {
                remove_quietly(&done.path);
                if let Some(thumbnail) = done.thumbnail {
                    remove_quietly(&thumbnail);
                }
            }
            return;
        };
        self.set(|v| {
            v.recording = match result {
                Some(done) => RecordingState::Ready(Recorded {
                    path: done.path,
                    thumbnail: done.thumbnail,
                    seconds: done.seconds,
                    bytes: done.bytes,
                    include_pages,
                    picture_in_picture: done.picture_in_picture,
                }),
                None => RecordingState::Failed {
                    message: RECORDING_SAVE_FAILED.into(),
                },
            }
        });
    }

    fn discard_recording(&self) {
        let view = self.view();
        match &view.recording {
            RecordingState::Ready(recorded) => {
                remove_quietly(&recorded.path);
                if let Some(thumbnail) = &recorded.thumbnail {
                    remove_quietly(thumbnail);
                }
            }
            RecordingState::Starting | RecordingState::Recording { .. } => {
                if let Some(backend) = self.backend.lock().take() {
                    backend.cancel();
                }
            }
            _ => {}
        }
        self.set(|v| {
            v.recording = RecordingState::None;
            v.watching = false;
        });
    }

    fn start_trace(self: &Arc<Self>) {
        self.discard_trace();
        let Some(tracer) = self.tracer.clone() else {
            self.set(|v| v.trace = TraceState::Failed);
            return;
        };
        self.set(|v| v.trace = TraceState::Tracing);
        *self.trace_started.lock() = Some(Instant::now());
        let hub = Arc::clone(self);
        tracer.begin(Box::new(move |started| {
            if started {
                return;
            }
            *hub.trace_started.lock() = None;
            hub.set(|v| {
                if v.trace == TraceState::Tracing {
                    v.trace = TraceState::Failed;
                }
            });
        }));
    }

    fn finish_trace(self: &Arc<Self>) {
        if self.view().trace != TraceState::Tracing {
            return;
        }
        let Some(started) = self.trace_started.lock().take() else {
            return;
        };
        let seconds = started
            .elapsed()
            .as_secs_f64()
            .min(f64::from(TRACE_MAX_SECONDS));
        let Some(tracer) = self.tracer.clone() else {
            self.set(|v| v.trace = TraceState::Failed);
            return;
        };
        self.set(|v| v.trace = TraceState::Saving);
        let dir = self.ensure_draft_dir();
        let hub = Arc::clone(self);
        tracer.end(
            true,
            Box::new(move |raw| {
                let worker = Arc::clone(&hub);
                let spawned = std::thread::Builder::new()
                    .name("ardia-report-trace".into())
                    .spawn(move || worker.save_trace(raw, &dir, seconds));
                if spawned.is_err() {
                    hub.set(|v| v.trace = TraceState::Failed);
                }
            }),
        );
    }

    fn save_trace(&self, raw: Option<String>, dir: &std::path::Path, seconds: f64) {
        let saved = raw.and_then(|raw| {
            let path = dir.join(TRACE_FILE);
            let bytes = gzip_file(std::path::Path::new(&raw), &path);
            remove_quietly(&raw);
            bytes.ok().map(|bytes| (path, bytes))
        });
        let mut kept = false;
        self.set(|v| {
            if v.trace != TraceState::Saving {
                return;
            }
            v.trace = match &saved {
                Some((path, bytes)) => {
                    kept = true;
                    TraceState::Ready {
                        path: path.to_string_lossy().into_owned(),
                        bytes: *bytes,
                        seconds,
                    }
                }
                None => TraceState::Failed,
            };
        });
        if let (Some((path, _)), false) = (saved, kept) {
            remove_quietly(&path.to_string_lossy());
        }
    }

    fn discard_trace(&self) {
        let view = self.view();
        match &view.trace {
            TraceState::Ready { path, .. } => remove_quietly(path),
            TraceState::Tracing => {
                *self.trace_started.lock() = None;
                if let Some(tracer) = &self.tracer {
                    tracer.end(false, Box::new(|_| {}));
                }
            }
            _ => {}
        }
        self.set(|v| v.trace = TraceState::None);
    }

    fn send(self: &Arc<Self>) {
        let view = self.view();
        if !view.may_start_sending() {
            return;
        }
        let problems = draft_problems(&view.draft);
        if let Some(first) = problems.first() {
            let mut props = serde_json::Map::new();
            props.insert(
                "reason".into(),
                serde_json::json!(match first {
                    ardia_ui::report::DraftProblem::Title => "title",
                    ardia_ui::report::DraftProblem::Description => "description",
                    ardia_ui::report::DraftProblem::TitleTooLong => "titleTooLong",
                    ardia_ui::report::DraftProblem::DescriptionTooLong => "descriptionTooLong",
                    ardia_ui::report::DraftProblem::ContactTooLong => "contactTooLong",
                }),
            );
            props.insert("problems".into(), serde_json::json!(problems.len()));
            props.insert("kind".into(), serde_json::json!(view.draft.kind.value()));
            ardia_telemetry::capture("report_send_blocked", props);
            self.set(|v| v.show_problems = true);
            return;
        }
        let Some(transport) = self.transport.clone() else {
            return;
        };
        self.cancelled.store(false, Ordering::Release);
        let hub = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("ardia-report".into())
            .spawn(move || {
                let files = hub.files();
                let failed = hub.view().upload.clone();
                let restart = restart_reason(&failed, &files);
                let resume = match (&failed, restart) {
                    (UploadState::Failed { created, .. }, None) => created.clone(),
                    _ => None,
                };
                let id = {
                    let mut identity = hub.identity.lock();
                    if resume.is_none() || identity.is_none() {
                        let view = hub.view();
                        let install = (view.sharing || view.draft.watch)
                            .then(|| hub.install_id())
                            .flatten();
                        *identity =
                            Some(install.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
                    }
                    identity.clone().unwrap_or_default()
                };
                let view = hub.view();
                let payload = build_payload(&view.draft, &hub.context(&view, &id, files.clone()));
                let cancelled = Arc::clone(&hub.cancelled);
                let state_hub = Arc::clone(&hub);
                let uploader = Uploader {
                    transport: transport.as_ref(),
                    endpoint: endpoint(),
                    sleep: &|d| std::thread::sleep(d),
                    cancelled: &move || cancelled.load(Ordering::Acquire),
                    on_state: &move |state| {
                        if !state_hub.cancelled.load(Ordering::Acquire) {
                            state_hub.set(|v| v.upload = state);
                        }
                    },
                };
                let resumed = resume.is_some();
                let result = uploader.send(&payload, &files, resume);
                if let UploadState::Sent(sent) = &result {
                    let mut props = serde_json::Map::new();
                    props.insert("kind".into(), serde_json::json!(view.draft.kind.value()));
                    props.insert(
                        "has_recording".into(),
                        serde_json::json!(files.iter().any(|f| f.name == "recording.mp4")),
                    );
                    props.insert(
                        "has_trace".into(),
                        serde_json::json!(files.iter().any(|f| f.name == "trace.json.gz")),
                    );
                    props.insert("attachments".into(), serde_json::json!(files.len()));
                    props.insert(
                        "watch".into(),
                        serde_json::json!(watch_days(&view.draft, view.sharing) > 0),
                    );
                    props.insert("upload_ms".into(), serde_json::json!(sent.upload_ms));
                    props.insert("bytes".into(), serde_json::json!(sent.bytes));
                    props.insert("retries".into(), serde_json::json!(sent.retries));
                    props.insert("resumed".into(), serde_json::json!(resumed));
                    props.insert("restarted".into(), serde_json::json!(restart.is_some()));
                    props.insert(
                        "restart_reason".into(),
                        serde_json::json!(match restart {
                            Some(ardia_ui::report::state::RestartReason::Expired) => "expired",
                            Some(ardia_ui::report::state::RestartReason::Rejected) => "rejected",
                            Some(ardia_ui::report::state::RestartReason::FilesChanged) =>
                                "filesChanged",
                            None => "none",
                        }),
                    );
                    ardia_telemetry::capture("report_sent", props);
                }
                if let UploadState::Sent(sent) = result {
                    let shown = anonymous_identity(&id);
                    let days = watch_days(&view.draft, view.sharing);
                    hub.set(|v| {
                        v.sent = Some(SentReport {
                            id: sent.id,
                            issue_url: sent.issue_url,
                            issue_number: sent.issue_number,
                            name: sent.name.unwrap_or(shown.name),
                            colors: shown.colors,
                            angle: shown.angle,
                            watch_until: (days > 0).then(|| watch_end_date(now_ms())),
                            watch_turns_off: !view.sharing,
                        })
                    });
                }
            });
        if let Err(problem) = spawned {
            log::warn!("report couldn't send: {problem}");
        }
    }
}

fn remove_quietly(path: &str) {
    if let Err(problem) = std::fs::remove_file(path)
        && problem.kind() != std::io::ErrorKind::NotFound
    {
        log::debug!("report file couldn't be removed: {problem}");
    }
}

static HUB: OnceLock<Arc<ReportHub>> = OnceLock::new();

pub fn hub() -> Option<&'static Arc<ReportHub>> {
    HUB.get()
}

impl crate::coordinator::AppCoordinator {
    pub fn start_report(&self) -> &'static Arc<ReportHub> {
        HUB.get_or_init(|| {
            let hub = ReportHub::new(
                crate::net::shared(),
                Some(Arc::clone(&self.store)),
                self.data_dir(),
                Some(Arc::new(MainThreadTracer {
                    coordinator: self.weak(),
                })),
            );
            let weak = self.weak();
            hub.subscribe(Arc::new(move || {
                if let Some(coordinator) = weak.upgrade() {
                    coordinator
                        .signal
                        .emit(ardia_ui::host_data::HostTopics::PEOPLE);
                }
            }));
            hub
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::stub::{StubTransport, json as reply};
    use std::cell::RefCell;

    fn send_with(stub: &StubTransport, files: &[ReportFile]) -> (UploadState, Vec<UploadState>) {
        let states = RefCell::new(Vec::new());
        let uploader = Uploader {
            transport: stub,
            endpoint: "http://stub/api/feedback".into(),
            sleep: &|_| {},
            cancelled: &|| false,
            on_state: &|s| states.borrow_mut().push(s),
        };
        let result = uploader.send(&json!({"title": "t"}), files, None);
        (result, states.into_inner())
    }

    #[test]
    fn creates_uploads_and_completes_against_a_stub() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("recording.mp4");
        std::fs::write(&path, b"abc").expect("write");
        let files = vec![ReportFile {
            name: "recording.mp4".into(),
            path: path.to_string_lossy().into_owned(),
            bytes: 3,
            kind: "video/mp4".into(),
        }];
        let stub = StubTransport::new(Box::new(|method, url, _| match (method, url) {
            ("POST", "http://stub/api/feedback") => reply(
                201,
                json!({"id": "r1", "upload_token": "tok", "name": "Brave Otter"}),
            ),
            ("PUT", _) => reply(200, json!({})),
            _ => reply(
                200,
                json!({"id": "r1", "issue_url": "https://github.com/a/b/issues/9"}),
            ),
        }));
        let (result, states) = send_with(&stub, &files);
        let UploadState::Sent(sent) = result else {
            panic!("not sent");
        };
        assert_eq!(sent.issue_number, Some(9));
        assert_eq!(sent.name.as_deref(), Some("Brave Otter"));
        assert!(matches!(states[0], UploadState::Creating));
        let calls = stub.calls.lock();
        assert_eq!(calls.len(), 3);
        assert_eq!(
            calls[1].1,
            "http://stub/api/feedback/r1/files/recording.mp4"
        );
        assert!(
            calls[0]
                .2
                .iter()
                .any(|(k, v)| k == INGEST_KEY_HEADER && v == APP_INGEST_KEY)
        );
        assert!(
            calls[2]
                .2
                .iter()
                .any(|(k, v)| k == "Authorization" && v == "Bearer tok")
        );
        assert_eq!(calls[2].1, "http://stub/api/feedback/r1/complete");
    }

    #[test]
    fn server_errors_retry_then_fail_with_the_old_copy() {
        let stub = StubTransport::new(Box::new(|_, _, _| reply(500, json!({}))));
        let (result, _) = send_with(&stub, &[]);
        assert!(matches!(
            &result,
            UploadState::Failed {
                stage: FailedStage::Create,
                attempts: 3,
                ..
            }
        ));
        assert_eq!(stub.calls.lock().len(), 3);
        let rejected = StubTransport::new(Box::new(|_, _, _| {
            reply(422, json!({"message": "Bad title"}))
        }));
        let (result, _) = send_with(&rejected, &[]);
        let UploadState::Failed {
            message, attempts, ..
        } = result
        else {
            panic!("not failed");
        };
        assert_eq!(attempts, 1);
        assert!(message.contains("Bad title"));
    }

    struct MockBackend {
        stops: Mutex<Vec<StopDone>>,
        cancels: std::sync::atomic::AtomicUsize,
    }

    impl MockBackend {
        fn new() -> Arc<MockBackend> {
            Arc::new(MockBackend {
                stops: Mutex::new(Vec::new()),
                cancels: std::sync::atomic::AtomicUsize::new(0),
            })
        }
    }

    impl RecorderBackend for MockBackend {
        fn stop(&self, done: StopDone) {
            self.stops.lock().push(done);
        }

        fn cancel(&self) {
            self.cancels.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct DirectTracer(Arc<ardia_engine::MockBrowserEngine>);

    impl EngineTracer for DirectTracer {
        fn begin(&self, done: TraceBegun) {
            let started = begin_reply(self.0.as_ref())
                .and_then(|reply| futures::executor::block_on(reply).ok())
                .unwrap_or(false);
            done(started);
        }

        fn end(&self, keep: bool, done: TraceEnded) {
            done(
                futures::executor::block_on(self.0.end_tracing(keep))
                    .ok()
                    .flatten(),
            );
        }
    }

    fn opened(dir: &std::path::Path, tracer: Option<Arc<dyn EngineTracer>>) -> Arc<ReportHub> {
        let hub = ReportHub::new(None, None, Some(dir.to_path_buf()), tracer);
        hub.command(ReportCommand::Open {
            window: WindowId::new("w"),
        });
        hub
    }

    fn eventually(what: &str, check: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !check() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn recording_walks_the_old_state_machine() {
        let dir = tempfile::tempdir().expect("dir");
        let hub = opened(dir.path(), None);
        let plan = hub.plan_recording().expect("plan");
        assert!(plan.path.ends_with(RECORDING_FILE));
        assert!(plan.path.starts_with(dir.path().join(DRAFTS_FOLDER)));
        assert!(!plan.include_pages);
        assert_eq!(hub.view().recording, RecordingState::Starting);
        assert!(hub.view().recording.hides_sheet());
        assert!(hub.plan_recording().is_none());
        let backend = MockBackend::new();
        hub.recording_started(false, backend.clone());
        hub.recording_tick(1.2);
        hub.recording_tick(1.6);
        assert_eq!(
            hub.view().recording,
            RecordingState::Recording {
                seconds: 1.2,
                include_pages: false
            }
        );
        hub.command(ReportCommand::StopRecording);
        assert_eq!(
            hub.view().recording,
            RecordingState::Saving {
                include_pages: false
            }
        );
        std::fs::write(&plan.path, b"mp4").expect("write");
        let done = backend.stops.lock().pop().expect("stop asked");
        done(Some(Finished {
            path: plan.path.to_string_lossy().into_owned(),
            seconds: 2.0,
            bytes: 3,
            thumbnail: None,
            picture_in_picture: false,
        }));
        let view = hub.view();
        let recorded = view.recording.recorded().expect("ready");
        assert_eq!(recorded.bytes, 3);
        assert!(!view.recording.hides_sheet());
        let files = hub.files();
        assert_eq!(files[0].name, RECORDING_FILE);
        assert_eq!(files[0].kind, "video/mp4");
        hub.command(ReportCommand::SetIncludePages(true));
        assert!(!hub.view().draft.include_pages);
        hub.command(ReportCommand::SetWatching(true));
        assert!(hub.view().watching);
        hub.command(ReportCommand::SetAttachedOpen(true));
        assert!(!hub.view().watching);
        hub.command(ReportCommand::DiscardRecording);
        assert_eq!(hub.view().recording, RecordingState::None);
        assert!(!plan.path.exists());
        assert!(hub.files().is_empty());
    }

    #[test]
    fn recording_failures_use_the_old_copy() {
        let dir = tempfile::tempdir().expect("dir");
        let hub = opened(dir.path(), None);
        hub.plan_recording().expect("plan");
        hub.recording_start_failed();
        assert_eq!(
            hub.view().recording,
            RecordingState::Failed {
                message: RECORD_FAILED.into()
            }
        );
        hub.plan_recording().expect("plan again");
        let backend = MockBackend::new();
        hub.recording_started(true, backend.clone());
        hub.command(ReportCommand::StopRecording);
        let done = backend.stops.lock().pop().expect("stop asked");
        done(None);
        assert_eq!(
            hub.view().recording,
            RecordingState::Failed {
                message: RECORDING_SAVE_FAILED.into()
            }
        );
        hub.plan_recording().expect("plan third");
        hub.recording_started(false, backend.clone());
        hub.command(ReportCommand::DiscardRecording);
        assert_eq!(backend.cancels.load(Ordering::SeqCst), 1);
        assert_eq!(hub.view().recording, RecordingState::None);
        let late = MockBackend::new();
        hub.recording_started(false, late.clone());
        assert_eq!(late.cancels.load(Ordering::SeqCst), 1);
        assert_eq!(hub.view().recording, RecordingState::None);
    }

    #[test]
    fn private_windows_keep_pages_hidden() {
        let dir = tempfile::tempdir().expect("dir");
        let hub = opened(dir.path(), None);
        hub.command(ReportCommand::SetIncludePages(true));
        assert!(hub.plan_recording().expect("plan").include_pages);
        hub.command(ReportCommand::DiscardRecording);
        hub.set(|v| v.private_window = true);
        assert!(!hub.plan_recording().expect("plan").include_pages);
        hub.command(ReportCommand::DiscardRecording);
        hub.command(ReportCommand::SetIncludePages(false));
        assert!(hub.view().draft.include_pages);
    }

    #[test]
    fn slow_reports_trace_the_engine_while_recording() {
        let dir = tempfile::tempdir().expect("dir");
        let engine = Arc::new(ardia_engine::MockBrowserEngine::started());
        let hub = opened(
            dir.path(),
            Some(Arc::new(DirectTracer(Arc::clone(&engine)))),
        );
        hub.command(ReportCommand::SetTrace(true));
        assert!(!hub.view().draft.trace);
        hub.command(ReportCommand::SetKind(ReportKind::Slow));
        hub.command(ReportCommand::SetTrace(true));
        assert!(hub.view().draft.trace);
        hub.plan_recording().expect("plan");
        assert_eq!(hub.view().trace, TraceState::Tracing);
        let tracing = || {
            engine
                .query(EngineQuery::IsTracing)
                .ok()
                .and_then(|v| v.as_bool())
                == Some(true)
        };
        eventually("tracing to begin", tracing);
        let backend = MockBackend::new();
        hub.recording_started(false, backend);
        hub.recording_tick(5.0);
        assert_eq!(hub.view().trace, TraceState::Tracing);
        hub.recording_tick(f64::from(TRACE_MAX_SECONDS));
        eventually("the trace to settle", || {
            !matches!(hub.view().trace, TraceState::Tracing | TraceState::Saving)
        });
        assert_eq!(hub.view().trace, TraceState::Failed);
        assert!(!tracing());
        hub.command(ReportCommand::DiscardRecording);
        let _ = futures::executor::block_on(engine.begin_tracing());
        hub.plan_recording().expect("plan while busy");
        eventually("a busy engine to fail the trace", || {
            hub.view().trace == TraceState::Failed
        });
    }

    #[test]
    fn traces_attach_gzipped_only_for_slow_reports() {
        let dir = tempfile::tempdir().expect("dir");
        let raw = dir.path().join("raw.json");
        std::fs::write(&raw, br#"{"traceEvents":[]}"#).expect("raw");
        let gz = dir.path().join(TRACE_FILE);
        let bytes = gzip_file(&raw, &gz).expect("gzip");
        let mut text = String::new();
        std::io::Read::read_to_string(
            &mut flate2::read::GzDecoder::new(std::fs::File::open(&gz).expect("open")),
            &mut text,
        )
        .expect("gunzip");
        assert_eq!(text, r#"{"traceEvents":[]}"#);
        let hub = opened(dir.path(), None);
        hub.set(|v| {
            v.trace = TraceState::Ready {
                path: gz.to_string_lossy().into_owned(),
                bytes,
                seconds: 4.0,
            }
        });
        assert!(hub.files().is_empty());
        hub.command(ReportCommand::SetKind(ReportKind::Slow));
        let files = hub.files();
        assert_eq!(files[0].name, TRACE_FILE);
        assert_eq!(files[0].kind, "application/gzip");
        assert_eq!(
            hub.view().trace.status_text(),
            format!(
                "Trace attached · 4 s · {}",
                ardia_ui::report::format_bytes(bytes)
            )
        );
        hub.command(ReportCommand::Finish);
        assert!(!gz.exists());
    }

    #[test]
    fn hub_validates_before_sending() {
        let hub = ReportHub::new(None, None, None, None);
        hub.command(ReportCommand::Open {
            window: WindowId::new("w"),
        });
        hub.command(ReportCommand::Send);
        assert!(hub.view().show_problems);
        hub.command(ReportCommand::SetTitle("a\nb".into()));
        hub.command(ReportCommand::SetKind(ardia_ui::report::ReportKind::Idea));
        assert_eq!(hub.view().draft.kind, ardia_ui::report::ReportKind::Idea);
        hub.command(ReportCommand::SetPreview(true));
        assert!(
            hub.view()
                .payload_preview
                .as_deref()
                .is_some_and(|p| p.contains("\"kind\": \"idea\""))
        );
        hub.command(ReportCommand::Close);
        assert!(hub.view().window.is_none());
        let _: ardia_ui::report::ReportDraft = hub.view().draft.clone();
    }
}
