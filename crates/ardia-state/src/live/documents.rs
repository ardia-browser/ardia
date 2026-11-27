use serde_json::{Value, json};

use super::github::parse_time;
use super::{
    CheckState, DocumentInfo, LiveItem, LiveSourceId, Mergeable, PullRequestCheck, PullRequestInfo,
    PullRequestSection, ReviewState,
};

pub const CONFLUENCE_CQL: &str = "type=page AND (contributor=currentUser() OR creator=currentUser() OR watcher=currentUser()) ORDER BY lastmodified DESC";

pub const DRIVE_QUERY: [(&str, &str); 4] = [
    (
        "q",
        "trashed = false and mimeType != 'application/vnd.google-apps.folder' and (viewedByMeTime > '1970-01-01T00:00:00Z' or 'me' in owners)",
    ),
    ("orderBy", "modifiedTime desc"),
    ("pageSize", "30"),
    (
        "fields",
        "files(id,name,mimeType,webViewLink,iconLink,modifiedTime,lastModifyingUser(displayName))",
    ),
];

pub fn notion_search_body() -> Value {
    json!({ "sort": { "direction": "descending", "timestamp": "last_edited_time" }, "page_size": 30 })
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn rich(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| text(p, "plain_text"))
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn notion_title(page: &Value) -> String {
    let title = match page.get("title") {
        Some(title) => rich(Some(title)),
        None => page
            .get("properties")
            .and_then(Value::as_object)
            .and_then(|props| props.values().find(|v| text(v, "type") == Some("title")))
            .map(|v| rich(v.get("title")))
            .unwrap_or_default(),
    };
    let title = title.trim();
    if title.is_empty() {
        "Untitled".into()
    } else {
        title.to_owned()
    }
}

pub fn map_notion(search: &Value, users: Option<&Value>, workspace: Option<&str>) -> Vec<LiveItem> {
    let names: Vec<(String, Option<String>)> = users
        .and_then(|u| u.get("results"))
        .and_then(Value::as_array)
        .map(|r| {
            r.iter()
                .filter_map(|u| {
                    Some((
                        text(u, "id")?.to_owned(),
                        text(u, "name").map(str::to_owned),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let name_of = |id: &str| {
        names
            .iter()
            .find(|(k, _)| k == id)
            .and_then(|(_, n)| n.clone())
    };
    search
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|p| {
            p.get("archived").and_then(Value::as_bool) != Some(true)
                && p.get("in_trash").and_then(Value::as_bool) != Some(true)
        })
        .filter_map(|p| {
            let icon = p.get("icon").and_then(|i| match text(i, "type") {
                Some("emoji") => text(i, "emoji").map(str::to_owned),
                Some("external") => i
                    .pointer("/external/url")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                Some("file") => i
                    .pointer("/file/url")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                _ => None,
            });
            Some(LiveItem {
                id: format!("notion:{}", text(p, "id")?),
                source: LiveSourceId::Notion,
                url: text(p, "url").unwrap_or_default().to_owned(),
                title: notion_title(p),
                subtitle: workspace.unwrap_or("Notion").to_owned(),
                icon,
                updated_at: parse_time(text(p, "last_edited_time").unwrap_or_default()),
                section: None,
                pr: None,
                doc: Some(DocumentInfo {
                    kind: if text(p, "object") == Some("database") {
                        "Database".into()
                    } else {
                        "Page".into()
                    },
                    edited_by: p
                        .pointer("/last_edited_by/id")
                        .and_then(Value::as_str)
                        .and_then(name_of),
                    place: workspace.map(str::to_owned),
                }),
            })
        })
        .collect()
}

pub fn map_confluence(search: &Value, site: &str) -> Vec<LiveItem> {
    let base = search
        .pointer("/_links/base")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{}/wiki", site.trim_end_matches('/')));
    search
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let space = r
                .pointer("/space/name")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let title = text(r, "title")
                .filter(|t| !t.is_empty())
                .unwrap_or("Untitled");
            Some(LiveItem {
                id: format!("confluence:{}", text(r, "id")?),
                source: LiveSourceId::Confluence,
                url: format!(
                    "{base}{}",
                    r.pointer("/_links/webui")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                ),
                title: title.to_owned(),
                subtitle: space.clone().unwrap_or_else(|| "Confluence".into()),
                icon: None,
                updated_at: parse_time(
                    r.pointer("/history/lastUpdated/when")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ),
                section: None,
                pr: None,
                doc: Some(DocumentInfo {
                    kind: "Page".into(),
                    edited_by: r
                        .pointer("/history/lastUpdated/by/displayName")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    place: space,
                }),
            })
        })
        .collect()
}

fn drive_kind(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "application/vnd.google-apps.document" => "Document",
        "application/vnd.google-apps.spreadsheet" => "Spreadsheet",
        "application/vnd.google-apps.presentation" => "Presentation",
        "application/vnd.google-apps.form" => "Form",
        "application/vnd.google-apps.drawing" => "Drawing",
        "application/pdf" => "PDF",
        _ => return None,
    })
}

pub fn map_drive(files: &Value) -> Vec<LiveItem> {
    files
        .get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let kind = drive_kind(text(f, "mimeType").unwrap_or_default());
            Some(LiveItem {
                id: format!("gdrive:{}", text(f, "id")?),
                source: LiveSourceId::Gdrive,
                url: text(f, "webViewLink").unwrap_or_default().to_owned(),
                title: text(f, "name")
                    .filter(|n| !n.is_empty())
                    .unwrap_or("Untitled")
                    .to_owned(),
                subtitle: kind.unwrap_or("Google Drive").to_owned(),
                icon: None,
                updated_at: parse_time(text(f, "modifiedTime").unwrap_or_default()),
                section: None,
                pr: None,
                doc: Some(DocumentInfo {
                    kind: kind.unwrap_or("File").to_owned(),
                    edited_by: f
                        .pointer("/lastModifyingUser/displayName")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    place: None,
                }),
            })
        })
        .collect()
}

pub fn map_bitbucket(pr: &Value, statuses: Option<&Value>) -> Option<LiveItem> {
    let id = pr.get("id").and_then(Value::as_u64)?;
    let repo = pr
        .pointer("/destination/repository/full_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let reviewers: Vec<&Value> = pr
        .get("participants")
        .and_then(Value::as_array)
        .map(|p| {
            p.iter()
                .filter(|p| text(p, "role") == Some("REVIEWER"))
                .collect()
        })
        .unwrap_or_default();
    let review = if reviewers
        .iter()
        .any(|p| text(p, "state") == Some("changes_requested"))
    {
        Some(ReviewState::ChangesRequested)
    } else if reviewers
        .iter()
        .any(|p| text(p, "state") == Some("approved"))
    {
        Some(ReviewState::Approved)
    } else if !reviewers.is_empty() {
        Some(ReviewState::Required)
    } else {
        None
    };
    let checks = statuses
        .and_then(|s| s.get("values"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|s| PullRequestCheck {
                    name: text(s, "name").unwrap_or_default().to_owned(),
                    state: match text(s, "state") {
                        Some("SUCCESSFUL") => CheckState::Success,
                        Some("FAILED") => CheckState::Failure,
                        Some("STOPPED") => CheckState::Neutral,
                        _ => CheckState::Pending,
                    },
                    url: text(s, "url").map(str::to_owned),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(LiveItem {
        id: format!("bitbucket:{repo}#{id}"),
        source: LiveSourceId::Bitbucket,
        url: pr
            .pointer("/links/html/href")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        title: text(pr, "title").unwrap_or_default().to_owned(),
        subtitle: format!("{repo} #{id}"),
        icon: None,
        updated_at: parse_time(text(pr, "updated_on").unwrap_or_default()),
        section: Some(PullRequestSection::Authored),
        pr: Some(PullRequestInfo {
            number: id,
            repo: repo.to_owned(),
            author: pr
                .pointer("/author/display_name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            author_avatar: pr
                .pointer("/author/links/avatar/href")
                .and_then(Value::as_str)
                .map(str::to_owned),
            draft: pr.get("draft").and_then(Value::as_bool).unwrap_or(false),
            head_ref: pr
                .pointer("/source/branch/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            base_ref: pr
                .pointer("/destination/branch/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            review,
            mergeable: Mergeable::Unknown,
            checks,
            comments: pr.get("comment_count").and_then(Value::as_u64).unwrap_or(0),
            unresolved_threads: 0,
            additions: 0,
            deletions: 0,
            changed_files: 0,
            stack: None,
        }),
        doc: None,
    })
}
