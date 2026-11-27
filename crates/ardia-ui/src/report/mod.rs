pub mod identity;
pub mod pill;
pub mod record;
pub mod sheet;
pub mod state;

use serde_json::{Map, Value, json};
use unicode_segmentation::UnicodeSegmentation;

pub mod tokens {
    pub const THUMBNAIL: [f32; 2] = [112.0, 70.0];
    pub const PLAYER_HEIGHT: f32 = 300.0;
    pub const AVATAR: f32 = 40.0;
    pub const SENT_ICON: f32 = 44.0;
    pub const SENT_GLYPH: f32 = 20.0;
    pub const LABEL_WIDTH: f32 = 60.0;
    pub const PREVIEW_HEIGHT: f32 = 520.0;
    pub const RECORD_DOT: f32 = 8.0;
}

pub const TITLE_MAX: usize = 67;
pub const DESCRIPTION_MAX: usize = 4000;
pub const CONTACT_MAX: usize = 200;
pub const PAGE_ADDRESS_MAX: usize = 2048;
pub const DIAGNOSTICS_MAX_BYTES: usize = 64 * 1024;
pub const WATCH_DAYS: i64 = 14;
pub const LOCAL_EVENTS_DAYS: i64 = 7;
pub const RECORDING_MAX_SECONDS: u32 = 60;
pub const TRACE_MAX_SECONDS: u32 = 30;
pub const FOOTER_NOTE: &str = "Your title and description become a public GitHub issue. Recordings, contact and details stay private.";
pub const RECORD_HINT: &str = "Records this window, its Picture in Picture and the menus and prompts it opens. Never your other windows. Reports with a recording get fixed first.";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ReportKind {
    #[default]
    Bug,
    Slow,
    Idea,
    Other,
}

impl ReportKind {
    pub const ALL: [ReportKind; 4] = [
        ReportKind::Bug,
        ReportKind::Slow,
        ReportKind::Idea,
        ReportKind::Other,
    ];

    pub const fn value(self) -> &'static str {
        match self {
            ReportKind::Bug => "bug",
            ReportKind::Slow => "slow",
            ReportKind::Idea => "idea",
            ReportKind::Other => "other",
        }
    }

    pub const fn title(self) -> &'static str {
        match self {
            ReportKind::Bug => "Bug",
            ReportKind::Slow => "Slow",
            ReportKind::Idea => "Idea",
            ReportKind::Other => "Other",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Attach {
    pub system: bool,
    pub errors: bool,
    pub settings: bool,
    pub page: bool,
}

pub const DEFAULT_ATTACH: Attach = Attach {
    system: true,
    errors: true,
    settings: true,
    page: false,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportDraft {
    pub kind: ReportKind,
    pub title: String,
    pub description: String,
    pub contact: String,
    pub include_pages: bool,
    pub trace: bool,
    pub attach: Attach,
    pub watch: bool,
}

impl Default for ReportDraft {
    fn default() -> Self {
        ReportDraft {
            kind: ReportKind::Bug,
            title: String::new(),
            description: String::new(),
            contact: String::new(),
            include_pages: false,
            trace: false,
            attach: DEFAULT_ATTACH,
            watch: false,
        }
    }
}

pub fn character_count(text: &str) -> usize {
    text.graphemes(true).count()
}

fn fits_limit(text: &str, max: usize) -> bool {
    text.encode_utf16().count() <= max
        || (text.chars().count() <= max && character_count(text) <= max)
}

fn clamp_characters(text: &str, max: usize) -> String {
    if fits_limit(text, max) {
        return text.to_owned();
    }
    let mut kept = String::new();
    let (mut points, mut count) = (0, 0);
    for part in text.graphemes(true) {
        let size = part.chars().count();
        if count + 1 > max || points + size > max {
            break;
        }
        kept.push_str(part);
        points += size;
        count += 1;
    }
    kept
}

fn is_line_control(c: char) -> bool {
    matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}' | '\u{2028}' | '\u{2029}')
}

fn collapse_controls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if is_line_control(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

pub fn clamp_title(text: &str) -> String {
    clamp_characters(&collapse_controls(text), TITLE_MAX)
}

pub fn clamp_description(text: &str) -> String {
    clamp_characters(text, DESCRIPTION_MAX)
}

pub fn clamp_contact(text: &str) -> String {
    clamp_characters(&collapse_controls(text), CONTACT_MAX)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TitleCounter {
    pub count: usize,
    pub max: usize,
    pub full: bool,
    pub near: bool,
}

pub fn title_counter(title: &str) -> TitleCounter {
    let count = character_count(title);
    TitleCounter {
        count,
        max: TITLE_MAX,
        full: count >= TITLE_MAX,
        near: count >= TITLE_MAX - 10,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftProblem {
    Title,
    Description,
    TitleTooLong,
    DescriptionTooLong,
    ContactTooLong,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftField {
    Title,
    Description,
    Contact,
}

impl DraftProblem {
    pub const fn field(self) -> DraftField {
        match self {
            DraftProblem::Title | DraftProblem::TitleTooLong => DraftField::Title,
            DraftProblem::Description | DraftProblem::DescriptionTooLong => DraftField::Description,
            DraftProblem::ContactTooLong => DraftField::Contact,
        }
    }

    pub fn hint(self) -> String {
        match self {
            DraftProblem::Title => "Add a title to send".to_owned(),
            DraftProblem::TitleTooLong => format!("Shorten the title to {TITLE_MAX} characters"),
            DraftProblem::Description => "Say what happened to send".to_owned(),
            DraftProblem::DescriptionTooLong => "Shorten this to 4,000 characters".to_owned(),
            DraftProblem::ContactTooLong => format!("Shorten this to {CONTACT_MAX} characters"),
        }
    }
}

pub fn draft_problems(draft: &ReportDraft) -> Vec<DraftProblem> {
    let mut problems = Vec::new();
    let title = draft.title.trim();
    let description = draft.description.trim();
    if title.is_empty() {
        problems.push(DraftProblem::Title);
    } else if !fits_limit(title, TITLE_MAX) {
        problems.push(DraftProblem::TitleTooLong);
    }
    if description.is_empty() {
        problems.push(DraftProblem::Description);
    } else if !fits_limit(description, DESCRIPTION_MAX) {
        problems.push(DraftProblem::DescriptionTooLong);
    }
    if !fits_limit(draft.contact.trim(), CONTACT_MAX) {
        problems.push(DraftProblem::ContactTooLong);
    }
    problems
}

pub fn can_send(draft: &ReportDraft) -> bool {
    draft_problems(draft).is_empty()
}

pub fn field_problem(
    problems: &[DraftProblem],
    field: DraftField,
) -> Option<(DraftProblem, String)> {
    problems
        .iter()
        .find(|p| p.field() == field)
        .map(|p| (*p, p.hint()))
}

pub fn watch_days(draft: &ReportDraft, sharing: bool) -> i64 {
    if sharing || draft.watch {
        WATCH_DAYS
    } else {
        0
    }
}

pub fn watch_end_date(from: i64) -> i64 {
    from + WATCH_DAYS * 86_400_000
}

pub fn cap_diagnostics(diagnostics: &Map<String, Value>) -> Map<String, Value> {
    let mut capped = Map::new();
    let mut bytes = 2;
    for (key, value) in diagnostics {
        let entry = json!({ key: value }).to_string().len();
        if bytes + entry > DIAGNOSTICS_MAX_BYTES {
            continue;
        }
        capped.insert(key.clone(), value.clone());
        bytes += entry;
    }
    capped
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReportFile {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub kind: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PayloadContext {
    pub install_id: String,
    pub session_id: Option<String>,
    pub app_version: String,
    pub app_build: String,
    pub channel: Option<String>,
    pub os_version: String,
    pub arch: String,
    pub page_address: Option<String>,
    pub sharing: bool,
    pub diagnostics: Map<String, Value>,
    pub files: Vec<ReportFile>,
}

fn clean_description(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| !matches!(c, '\u{0000}'..='\u{0008}' | '\u{000b}'..='\u{001f}' | '\u{007f}'..='\u{009f}' | '\u{2028}' | '\u{2029}'))
        .collect::<String>()
        .trim()
        .to_owned()
}

pub fn build_payload(draft: &ReportDraft, ctx: &PayloadContext) -> Value {
    let contact = clamp_contact(draft.contact.trim());
    let page = ctx
        .page_address
        .as_deref()
        .filter(|_| draft.attach.page)
        .map(|page| page.chars().take(PAGE_ADDRESS_MAX).collect::<String>());
    let mut payload = json!({
        "kind": draft.kind.value(),
        "title": clamp_title(draft.title.trim()).trim(),
        "description": clamp_description(&clean_description(&draft.description)),
        "source": "app",
        "install_id": ctx.install_id,
        "session_id": ctx.session_id,
        "app_version": ctx.app_version,
        "app_build": ctx.app_build,
        "channel": ctx.channel,
        "os_version": ctx.os_version,
        "arch": ctx.arch,
        "watch_days": watch_days(draft, ctx.sharing),
        "diagnostics": Value::Object(cap_diagnostics(&ctx.diagnostics)),
        "attachments": ctx.files.iter().map(|f| json!({"name": f.name, "bytes": f.bytes, "type": f.kind})).collect::<Vec<_>>(),
    });
    if let Some(object) = payload.as_object_mut() {
        if !contact.is_empty() {
            object.insert("contact".into(), Value::String(contact));
        }
        if let Some(page) = page.filter(|p| !p.is_empty()) {
            object.insert("page_address".into(), Value::String(page));
        }
    }
    payload
}

pub fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn format_duration(seconds: f64) -> String {
    let whole = seconds.max(0.0).floor() as u64;
    format!("{}:{:02}", whole / 60, whole % 60)
}

pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    if bytes < 1024 * 1024 {
        return format!("{} KB", (bytes as f64 / 1024.0).round() as u64);
    }
    format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
}

pub fn short_address(url: &str) -> String {
    let lower = url.to_ascii_lowercase();
    let mut rest = url;
    for prefix in ["https://www.", "http://www.", "https://", "http://"] {
        if lower.starts_with(prefix) {
            rest = &url[prefix.len()..];
            break;
        }
    }
    rest.split(['?', '#']).next().unwrap_or_default().to_owned()
}

pub fn events_label(count: usize) -> String {
    format!("{count} {}", if count == 1 { "event" } else { "events" })
}

pub fn attached_summary(attach: Attach, events: usize, page: bool) -> String {
    let parts: Vec<String> = [
        attach.system.then(|| "System info".to_owned()),
        (attach.errors && events > 0).then(|| events_label(events)),
        attach.settings.then(|| "settings".to_owned()),
        (attach.page && page).then(|| "page address".to_owned()),
    ]
    .into_iter()
    .flatten()
    .collect();
    if parts.is_empty() {
        "Nothing".to_owned()
    } else {
        parts.join(", ")
    }
}

pub fn sent_link_title(issue_number: Option<u64>) -> String {
    match issue_number {
        Some(n) => format!("View on GitHub · #{n}"),
        None => "View on GitHub".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_graphemes_not_code_units() {
        assert_eq!(character_count("👍🏽a"), 2);
        let counter = title_counter(&"x".repeat(57));
        assert!(counter.near && !counter.full);
        assert!(title_counter(&"x".repeat(67)).full);
    }

    #[test]
    fn problems_point_at_their_fields() {
        let mut draft = ReportDraft::default();
        let problems = draft_problems(&draft);
        assert_eq!(
            problems,
            vec![DraftProblem::Title, DraftProblem::Description]
        );
        assert_eq!(
            field_problem(&problems, DraftField::Title).map(|p| p.1),
            Some("Add a title to send".to_owned())
        );
        draft.title = "Tabs flicker".into();
        draft.description = "After sleep".into();
        assert!(can_send(&draft));
        draft.title = "y".repeat(68);
        assert_eq!(draft_problems(&draft), vec![DraftProblem::TitleTooLong]);
        assert_eq!(
            DraftProblem::DescriptionTooLong.hint(),
            "Shorten this to 4,000 characters"
        );
    }

    #[test]
    fn titles_collapse_controls_and_clamp() {
        assert_eq!(clamp_title("a\n\n\tb"), "a b");
        assert_eq!(character_count(&clamp_title(&"z".repeat(100))), 67);
    }

    #[test]
    fn payload_matches_the_old_shape() {
        let draft = ReportDraft {
            title: " Hi ".into(),
            description: "a\r\nb\u{0007}".into(),
            contact: "@me".into(),
            attach: Attach {
                page: true,
                ..DEFAULT_ATTACH
            },
            ..ReportDraft::default()
        };
        let ctx = PayloadContext {
            install_id: "i".into(),
            page_address: Some("https://x.test/a".into()),
            files: vec![ReportFile {
                name: "r.mp4".into(),
                bytes: 3,
                kind: "video/mp4".into(),
                ..ReportFile::default()
            }],
            ..PayloadContext::default()
        };
        let payload = build_payload(&draft, &ctx);
        assert_eq!(payload["title"], "Hi");
        assert_eq!(payload["description"], "a\nb");
        assert_eq!(payload["contact"], "@me");
        assert_eq!(payload["page_address"], "https://x.test/a");
        assert_eq!(payload["watch_days"], 0);
        assert_eq!(payload["attachments"][0]["type"], "video/mp4");
        assert_eq!(payload["source"], "app");
    }

    #[test]
    fn formatters() {
        assert_eq!(format_duration(65.9), "1:05");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2 KB");
        assert_eq!(format_bytes(3 * 1024 * 1024 / 2), "1.5 MB");
        assert_eq!(
            short_address("https://www.example.com/a?b#c"),
            "example.com/a"
        );
        assert_eq!(
            attached_summary(DEFAULT_ATTACH, 1, false),
            "System info, 1 event, settings"
        );
        assert_eq!(
            attached_summary(
                Attach {
                    system: false,
                    errors: false,
                    settings: false,
                    page: true
                },
                0,
                false
            ),
            "Nothing"
        );
        assert_eq!(sent_link_title(Some(12)), "View on GitHub · #12");
        assert_eq!(watch_end_date(0), 14 * 86_400_000);
    }

    #[test]
    fn diagnostics_are_capped() {
        let mut big = Map::new();
        big.insert("a".into(), Value::String("x".repeat(DIAGNOSTICS_MAX_BYTES)));
        big.insert("b".into(), Value::from(1));
        let capped = cap_diagnostics(&big);
        assert!(!capped.contains_key("a"));
        assert!(capped.contains_key("b"));
    }
}
