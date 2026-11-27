use std::collections::BTreeMap;

use ardia_state::WindowId;
use serde_json::{Map, Value};

use super::{ReportDraft, ReportFile, ReportKind};

pub const RETRY_DELAYS_MS: [u64; 2] = [2_000, 8_000];
pub const FEEDBACK_URL: &str = "https://ardia.dev/api/feedback";
pub const APP_INGEST_KEY: &str = "ak_app_41b5d0762fd8ade6949ac2ac";
pub const INGEST_KEY_HEADER: &str = "X-Ardia-Key";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailedStage {
    Create,
    Upload,
    Complete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureClass {
    Offline,
    Storage,
    Server,
    RateLimited,
    Expired,
    Rejected,
}

impl FailureClass {
    pub fn retryable(self) -> bool {
        matches!(
            self,
            FailureClass::Offline | FailureClass::Storage | FailureClass::Server
        )
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Created {
    pub id: String,
    pub name: Option<String>,
    pub token: String,
    pub upload_urls: BTreeMap<String, String>,
    pub uploaded: Vec<String>,
    pub declared: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sent {
    pub id: String,
    pub name: Option<String>,
    pub issue_url: Option<String>,
    pub issue_number: Option<u64>,
    pub upload_ms: i64,
    pub bytes: u64,
    pub retries: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum UploadState {
    #[default]
    Idle,
    Creating,
    Uploading {
        created: Created,
        file: String,
        sent: u64,
        total: u64,
    },
    Completing {
        created: Created,
    },
    Sent(Sent),
    Failed {
        stage: FailedStage,
        message: String,
        created: Option<Created>,
        class: FailureClass,
        status: u16,
        attempts: u32,
    },
}

impl UploadState {
    pub fn busy(&self) -> bool {
        matches!(
            self,
            UploadState::Creating | UploadState::Uploading { .. } | UploadState::Completing { .. }
        )
    }

    pub fn fraction(&self) -> f32 {
        match self {
            UploadState::Uploading { sent, total, .. } if *total > 0 => {
                *sent as f32 / *total as f32
            }
            UploadState::Uploading { .. }
            | UploadState::Completing { .. }
            | UploadState::Sent(_) => 1.0,
            _ => 0.0,
        }
    }

    pub fn progress_text(&self) -> String {
        match self {
            UploadState::Creating => "Sending…".into(),
            UploadState::Completing { .. } => "Finishing…".into(),
            _ => format!("Uploading… {}%", (self.fraction() * 100.0).round() as i64),
        }
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

pub fn failure_class(status: u16, json: &Value) -> FailureClass {
    let error = text(json, "error").unwrap_or_default();
    match status {
        0 => FailureClass::Offline,
        429 => FailureClass::RateLimited,
        401 if error.starts_with("token_") => FailureClass::Expired,
        400..=499 => FailureClass::Rejected,
        _ if error == "upstream" || error == "upstream:storage" => FailureClass::Storage,
        _ => FailureClass::Server,
    }
}

fn sentence(value: String) -> String {
    if value.ends_with(['.', '!', '?']) {
        value
    } else {
        format!("{value}.")
    }
}

pub fn failure_message(class: FailureClass, status: u16, json: &Value) -> String {
    match class {
        FailureClass::Offline => "Couldn't reach Ardia's report server. Check your connection; your draft is kept.".into(),
        FailureClass::Storage => "Ardia's report server couldn't store this right now. Your draft is kept; try again in a minute.".into(),
        FailureClass::Server => "Ardia's report server ran into a problem. Your draft is kept; try again in a minute.".into(),
        FailureClass::RateLimited => "Ardia's report server has had too many reports from your network. Your draft is kept; try again in an hour.".into(),
        FailureClass::Expired => "This report waited too long to finish sending. Your draft is kept; Try Again sends it fresh.".into(),
        FailureClass::Rejected => {
            let reason = text(json, "message").or_else(|| text(json, "error")).unwrap_or_else(|| format!("error {status}"));
            sentence(format!("Ardia's report server couldn't accept this report ({reason}). Your draft is kept"))
        }
    }
}

pub fn resolve_url(base: &str, path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return path.to_owned();
    }
    let origin_end = base
        .find("://")
        .map(|i| i + 3)
        .and_then(|start| base[start..].find(['/', '?', '#']).map(|e| start + e))
        .unwrap_or(base.len());
    let origin = &base[..origin_end];
    if path.starts_with('/') {
        return format!("{origin}{path}");
    }
    let clean = base.split(['?', '#']).next().unwrap_or(base);
    let dir = clean
        .rfind('/')
        .filter(|i| *i >= origin_end)
        .map_or(clean, |i| &clean[..i]);
    format!("{dir}/{path}")
}

pub fn report_path(endpoint: &str, id: &str, suffix: &str) -> String {
    format!(
        "{}/{}/{suffix}",
        endpoint.trim_end_matches('/'),
        crate::report::encode_component(id)
    )
}

pub fn upload_urls_from(
    json: &Value,
    endpoint: &str,
    id: &str,
    files: &[ReportFile],
) -> BTreeMap<String, String> {
    let mut urls = BTreeMap::new();
    match json.get("upload_urls") {
        Some(Value::Array(entries)) => {
            for (i, entry) in entries.iter().enumerate() {
                if let (Some(url), Some(file)) =
                    (entry.as_str().filter(|s| !s.is_empty()), files.get(i))
                {
                    urls.insert(file.name.clone(), resolve_url(endpoint, url));
                }
                if let (Some(name), Some(url)) = (text(entry, "name"), text(entry, "url")) {
                    urls.insert(name, resolve_url(endpoint, &url));
                }
            }
        }
        Some(Value::Object(map)) => {
            for (name, url) in map {
                if let Some(url) = url.as_str().filter(|s| !s.is_empty()) {
                    urls.insert(name.clone(), resolve_url(endpoint, url));
                }
            }
        }
        _ => {}
    }
    for file in files {
        urls.entry(file.name.clone()).or_insert_with(|| {
            report_path(
                endpoint,
                id,
                &format!("files/{}", crate::report::encode_component(&file.name)),
            )
        });
    }
    urls
}

pub fn issue_number_of(url: Option<&str>) -> Option<u64> {
    let url = url?;
    for marker in ["/issues/", "/pull/"] {
        if let Some(at) = url.find(marker) {
            let digits: String = url[at + marker.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if let Ok(n) = digits.parse() {
                return Some(n);
            }
        }
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestartReason {
    Expired,
    Rejected,
    FilesChanged,
}

pub fn restart_reason(failed: &UploadState, files: &[ReportFile]) -> Option<RestartReason> {
    let UploadState::Failed {
        created: Some(created),
        class,
        ..
    } = failed
    else {
        return None;
    };
    match class {
        FailureClass::Expired => return Some(RestartReason::Expired),
        FailureClass::Rejected => return Some(RestartReason::Rejected),
        _ => {}
    }
    let unchanged = !created.declared.is_empty()
        && created.declared.len() == files.len()
        && files
            .iter()
            .all(|f| created.declared.get(&f.name) == Some(&f.bytes));
    (!unchanged).then_some(RestartReason::FilesChanged)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SentReport {
    pub id: String,
    pub issue_url: Option<String>,
    pub issue_number: Option<u64>,
    pub name: String,
    pub colors: [String; 3],
    pub angle: u32,
    pub watch_until: Option<i64>,
    pub watch_turns_off: bool,
}

pub const RECORD_FAILED: &str = "Ardia couldn't record this window.";
pub const RECORDING_SAVE_FAILED: &str = "The recording couldn't be saved.";

#[derive(Clone, Debug, PartialEq)]
pub struct Recorded {
    pub path: String,
    pub thumbnail: Option<String>,
    pub seconds: f64,
    pub bytes: u64,
    pub include_pages: bool,
    pub picture_in_picture: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum RecordingState {
    #[default]
    None,
    Starting,
    Recording {
        seconds: f64,
        include_pages: bool,
    },
    Saving {
        include_pages: bool,
    },
    Ready(Recorded),
    Failed {
        message: String,
    },
}

impl RecordingState {
    pub fn hides_sheet(&self) -> bool {
        matches!(
            self,
            RecordingState::Starting | RecordingState::Recording { .. }
        )
    }

    pub fn busy(&self) -> bool {
        self.hides_sheet() || matches!(self, RecordingState::Saving { .. })
    }

    pub fn recorded(&self) -> Option<&Recorded> {
        match self {
            RecordingState::Ready(recorded) => Some(recorded),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum TraceState {
    #[default]
    None,
    Tracing,
    Saving,
    Ready {
        path: String,
        bytes: u64,
        seconds: f64,
    },
    Failed,
}

impl TraceState {
    pub fn status_text(&self) -> String {
        match self {
            TraceState::Ready { bytes, seconds, .. } => format!(
                "Trace attached · {} s · {}",
                seconds.round() as i64,
                super::format_bytes(*bytes)
            ),
            TraceState::Tracing => "Recording a trace…".into(),
            TraceState::Saving => "Saving the trace…".into(),
            TraceState::Failed => "The trace couldn't be recorded.".into(),
            TraceState::None => format!(
                "Records what the engine does for up to {} seconds while you record.",
                super::TRACE_MAX_SECONDS
            ),
        }
    }
}

pub fn recording_summary(recorded: &Recorded) -> String {
    format!(
        "Recording · {} · {}{}",
        super::format_duration(recorded.seconds),
        if recorded.include_pages {
            "pages included"
        } else {
            "pages hidden"
        },
        if recorded.picture_in_picture {
            " · with Picture in Picture"
        } else {
            ""
        }
    )
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReportView {
    pub window: Option<WindowId>,
    pub draft: ReportDraft,
    pub page_address: Option<String>,
    pub system_line: String,
    pub local_events: Option<usize>,
    pub upload: UploadState,
    pub sent: Option<SentReport>,
    pub preview: bool,
    pub attached_open: bool,
    pub show_problems: bool,
    pub sharing: bool,
    pub can_record: bool,
    pub private_window: bool,
    pub recording: RecordingState,
    pub trace: TraceState,
    pub watching: bool,
    pub payload_preview: Option<String>,
    pub files: Vec<ReportFile>,
}

impl ReportView {
    pub fn may_start_sending(&self) -> bool {
        !self.upload.busy()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachmentKey {
    System,
    Errors,
    Settings,
    Page,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ReportCommand {
    Open { window: WindowId },
    Close,
    SetKind(ReportKind),
    SetTitle(String),
    SetDescription(String),
    SetContact(String),
    SetWatch(bool),
    SetAttach { key: AttachmentKey, on: bool },
    SetAttachedOpen(bool),
    SetPreview(bool),
    StopRecording,
    DiscardRecording,
    SetIncludePages(bool),
    SetTrace(bool),
    SetWatching(bool),
    Send,
    ViewIssue,
    Finish,
}

pub fn diagnostics_note(map: &mut Map<String, Value>, key: &str, value: Value) {
    map.insert(key.to_owned(), value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failures_classify_like_the_old_client() {
        assert_eq!(failure_class(0, &Value::Null), FailureClass::Offline);
        assert_eq!(
            failure_class(401, &json!({"error": "token_expired"})),
            FailureClass::Expired
        );
        assert_eq!(failure_class(422, &json!({})), FailureClass::Rejected);
        assert_eq!(
            failure_class(502, &json!({"error": "upstream"})),
            FailureClass::Storage
        );
        assert_eq!(failure_class(500, &json!({})), FailureClass::Server);
        assert_eq!(
            failure_message(FailureClass::Rejected, 422, &json!({"message": "Too long"})),
            "Ardia's report server couldn't accept this report (Too long). Your draft is kept."
        );
    }

    #[test]
    fn urls_resolve_against_the_endpoint() {
        assert_eq!(
            resolve_url("https://a.dev/api/feedback", "/x/y"),
            "https://a.dev/x/y"
        );
        assert_eq!(
            resolve_url("https://a.dev/api/feedback", "files/z"),
            "https://a.dev/api/files/z"
        );
        assert_eq!(
            resolve_url("https://a.dev/api/feedback", "https://s3/x"),
            "https://s3/x"
        );
        let files = vec![ReportFile {
            name: "recording.mp4".into(),
            ..ReportFile::default()
        }];
        let urls = upload_urls_from(
            &json!({"upload_urls": [{"name": "recording.mp4", "url": "/up/1"}]}),
            "https://a.dev/api/feedback",
            "r1",
            &files,
        );
        assert_eq!(urls["recording.mp4"], "https://a.dev/up/1");
        let fallback = upload_urls_from(&json!({}), "https://a.dev/api/feedback", "r 1", &files);
        assert_eq!(
            fallback["recording.mp4"],
            "https://a.dev/api/feedback/r%201/files/recording.mp4"
        );
        assert_eq!(
            issue_number_of(Some("https://github.com/a/b/issues/42")),
            Some(42)
        );
    }

    #[test]
    fn progress_and_restart() {
        let up = UploadState::Uploading {
            created: Created::default(),
            file: "f".into(),
            sent: 50,
            total: 200,
        };
        assert_eq!(up.progress_text(), "Uploading… 25%");
        assert!(up.busy());
        let failed = UploadState::Failed {
            stage: FailedStage::Upload,
            message: String::new(),
            created: Some(Created {
                declared: BTreeMap::from([("a".into(), 3)]),
                ..Created::default()
            }),
            class: FailureClass::Server,
            status: 500,
            attempts: 3,
        };
        let same = vec![ReportFile {
            name: "a".into(),
            bytes: 3,
            ..ReportFile::default()
        }];
        assert_eq!(restart_reason(&failed, &same), None);
        assert_eq!(
            restart_reason(&failed, &[]),
            Some(RestartReason::FilesChanged)
        );
    }
}
