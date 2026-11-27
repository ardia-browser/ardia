use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod documents;
pub mod github;

pub const MAX_KNOWN: usize = 600;
pub const MAX_COMPLETED: usize = 20;
pub const PAGE_SIZE: usize = 8;
pub const COMPLETION_MS: i64 = 2600;
pub const STALE_ON_FOCUS_MS: i64 = 60_000;
pub const DEFAULT_COUNTDOWN_LEAD: i64 = 60;
pub const DOC_VERSION: u64 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveSourceId {
    Github,
    Bitbucket,
    Notion,
    Confluence,
    Gdrive,
}

impl LiveSourceId {
    pub const ALL: [LiveSourceId; 5] = [
        LiveSourceId::Github,
        LiveSourceId::Bitbucket,
        LiveSourceId::Notion,
        LiveSourceId::Confluence,
        LiveSourceId::Gdrive,
    ];

    pub const fn key(self) -> &'static str {
        match self {
            LiveSourceId::Github => "github",
            LiveSourceId::Bitbucket => "bitbucket",
            LiveSourceId::Notion => "notion",
            LiveSourceId::Confluence => "confluence",
            LiveSourceId::Gdrive => "gdrive",
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            LiveSourceId::Github => "GitHub",
            LiveSourceId::Bitbucket => "Bitbucket",
            LiveSourceId::Notion => "Notion",
            LiveSourceId::Confluence => "Confluence",
            LiveSourceId::Gdrive => "Google Drive",
        }
    }

    pub const fn site(self) -> &'static str {
        match self {
            LiveSourceId::Github => "https://github.com",
            LiveSourceId::Bitbucket => "https://bitbucket.org",
            LiveSourceId::Notion => "https://www.notion.so",
            LiveSourceId::Confluence => "https://www.atlassian.com",
            LiveSourceId::Gdrive => "https://drive.google.com",
        }
    }

    pub const fn kind(self) -> LiveFolderKind {
        match self {
            LiveSourceId::Github | LiveSourceId::Bitbucket => LiveFolderKind::PullRequests,
            _ => LiveFolderKind::Documents,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveFolderKind {
    PullRequests,
    Documents,
}

impl LiveFolderKind {
    pub const fn interval_ms(self) -> i64 {
        match self {
            LiveFolderKind::PullRequests => 3 * 60_000,
            LiveFolderKind::Documents => 10 * 60_000,
        }
    }

    pub const fn default_name(self) -> &'static str {
        match self {
            LiveFolderKind::PullRequests => "Pull Requests",
            LiveFolderKind::Documents => "Documents",
        }
    }

    pub const fn default_source(self) -> LiveSourceId {
        match self {
            LiveFolderKind::PullRequests => LiveSourceId::Github,
            LiveFolderKind::Documents => LiveSourceId::Notion,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveFilters {
    pub authored: bool,
    pub review_requests: bool,
}

impl Default for LiveFilters {
    fn default() -> Self {
        LiveFilters {
            authored: true,
            review_requests: true,
        }
    }
}

fn yes() -> bool {
    true
}

fn present_or_null<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<String>::deserialize(deserializer)?))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveFolder {
    pub id: String,
    pub profile_id: String,
    pub kind: LiveFolderKind,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub sources: Vec<LiveSourceId>,
    #[serde(default)]
    pub filters: LiveFilters,
    #[serde(default = "yes")]
    pub group_stacks: bool,
    #[serde(default = "yes")]
    pub show_completed: bool,
    #[serde(default)]
    pub hidden_repos: Vec<String>,
    #[serde(default = "yes")]
    pub show_new_repos: bool,
    #[serde(default)]
    pub shown_repos: Vec<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_or_null"
    )]
    pub after: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestSection {
    Authored,
    Review,
    Team,
}

impl PullRequestSection {
    pub const fn order(self) -> u8 {
        match self {
            PullRequestSection::Authored => 0,
            PullRequestSection::Review => 1,
            PullRequestSection::Team => 2,
        }
    }

    pub const fn key(self) -> &'static str {
        match self {
            PullRequestSection::Authored => "authored",
            PullRequestSection::Review => "review",
            PullRequestSection::Team => "team",
        }
    }

    pub const fn title(self) -> Option<&'static str> {
        match self {
            PullRequestSection::Authored => None,
            PullRequestSection::Review => Some("Review Requests"),
            PullRequestSection::Team => Some("Team Review Requests"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Success,
    Failure,
    Pending,
    Queued,
    Neutral,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheck {
    pub name: String,
    pub state: CheckState,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    Required,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mergeable {
    Mergeable,
    Conflicting,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackInfo {
    pub id: String,
    pub position: u32,
    pub size: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestInfo {
    pub number: u64,
    pub repo: String,
    pub author: String,
    #[serde(default)]
    pub author_avatar: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub head_ref: String,
    #[serde(default)]
    pub base_ref: String,
    #[serde(default)]
    pub review: Option<ReviewState>,
    #[serde(default)]
    pub mergeable: Mergeable,
    #[serde(default)]
    pub checks: Vec<PullRequestCheck>,
    #[serde(default)]
    pub comments: u64,
    #[serde(default)]
    pub unresolved_threads: u64,
    #[serde(default)]
    pub additions: u64,
    #[serde(default)]
    pub deletions: u64,
    #[serde(default)]
    pub changed_files: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<StackInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub kind: String,
    #[serde(default)]
    pub edited_by: Option<String>,
    #[serde(default)]
    pub place: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveItem {
    pub id: String,
    pub source: LiveSourceId,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<PullRequestSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<PullRequestInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc: Option<DocumentInfo>,
}

impl LiveItem {
    pub fn section_or_authored(&self) -> PullRequestSection {
        self.section.unwrap_or(PullRequestSection::Authored)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionState {
    Merged,
    Closed,
    Reviewed,
}

impl CompletionState {
    pub const fn ended(self) -> bool {
        matches!(self, CompletionState::Merged | CompletionState::Closed)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedItem {
    pub item: LiveItem,
    pub state: CompletionState,
    pub at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveErrorKind {
    SignedOut,
    Sso,
    TokenBlocked,
    RateLimited,
    Network,
    NotConfigured,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveError {
    pub kind: LiveErrorKind,
    pub message: String,
}

impl LiveError {
    pub fn new(kind: LiveErrorKind, message: impl Into<String>) -> Self {
        LiveError {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderState {
    #[default]
    Initializing,
    Idle,
    Updating,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderError {
    pub kind: LiveErrorKind,
    pub message: String,
    pub source: LiveSourceId,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FolderStatus {
    pub state: FolderState,
    pub last_fetch: Option<i64>,
    pub error: Option<FolderError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAccount {
    pub login: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub connected_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveConfig {
    pub github_client_id: String,
    pub bitbucket_user: String,
    pub confluence_site: String,
    pub confluence_email: String,
    pub google_client_id: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlertCondition {
    #[default]
    Always,
    ActiveOnly,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CalendarSettings {
    pub alert_lead: String,
    pub alert_condition: AlertCondition,
    pub show_preview: bool,
    pub show_time_to_next: bool,
    pub countdown_lead: i64,
    pub hidden_calendar_ids: Vec<String>,
    pub prompted: bool,
}

impl Default for CalendarSettings {
    fn default() -> Self {
        CalendarSettings {
            alert_lead: "1".into(),
            alert_condition: AlertCondition::Always,
            show_preview: true,
            show_time_to_next: true,
            countdown_lead: DEFAULT_COUNTDOWN_LEAD,
            hidden_calendar_ids: Vec::new(),
            prompted: false,
        }
    }
}

impl CalendarSettings {
    pub fn alert_minutes(&self) -> Option<i64> {
        match self.alert_lead.as_str() {
            "never" => None,
            "start" => Some(0),
            other => other.parse().ok(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingGroup {
    pub group_id: String,
    pub call_tab_id: String,
    #[serde(default)]
    pub occurrence: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub start: Option<i64>,
    #[serde(default)]
    pub end: Option<i64>,
    #[serde(default)]
    pub ended_at: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveState {
    pub folders: BTreeMap<String, LiveFolder>,
    pub folder_order: Vec<String>,
    pub items: BTreeMap<String, Vec<LiveItem>>,
    pub known: BTreeMap<String, Vec<String>>,
    pub unread: BTreeMap<String, Vec<String>>,
    pub hidden: BTreeMap<String, Vec<LiveItem>>,
    pub repo_hidden: BTreeMap<String, Vec<LiveItem>>,
    pub completed: BTreeMap<String, Vec<CompletedItem>>,
    pub expanded_stacks: BTreeMap<String, bool>,
    pub accounts: BTreeMap<LiveSourceId, LiveAccount>,
    pub config: LiveConfig,
    pub calendar: CalendarSettings,
    pub meeting_groups: BTreeMap<String, MeetingGroup>,
    pub dismissed_alerts: Vec<String>,
    pub dismissed_now: BTreeMap<String, i64>,
    #[serde(skip)]
    pub completing: BTreeMap<String, Vec<String>>,
    #[serde(skip)]
    pub status: BTreeMap<String, FolderStatus>,
    #[serde(skip)]
    pub show_all: BTreeMap<String, bool>,
}

pub fn show_all_key(folder: &str, section: &str) -> String {
    format!("{folder}:{section}")
}

pub fn repo_key(item: &LiveItem) -> Option<String> {
    item.pr
        .as_ref()
        .map(|pr| format!("{}:{}", item.source.key(), pr.repo))
}

pub fn stack_members<'a>(items: &'a [LiveItem], stack: &str) -> Vec<&'a LiveItem> {
    items
        .iter()
        .filter(|it| {
            it.pr
                .as_ref()
                .and_then(|p| p.stack.as_ref())
                .is_some_and(|s| s.id == stack)
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub enum FolderRow {
    Item {
        key: String,
        item: Box<LiveItem>,
    },
    Stack {
        key: String,
        id: String,
        repo: String,
        items: Vec<LiveItem>,
    },
    Header {
        key: String,
        title: String,
    },
    More {
        key: String,
        section: String,
        count: usize,
    },
}

pub fn folder_rows(
    folder: &LiveFolder,
    items: &[LiveItem],
    show_all: &BTreeMap<String, bool>,
    page: usize,
) -> Vec<FolderRow> {
    let sections: Vec<(&str, Option<&str>, Vec<&LiveItem>)> = match folder.kind {
        LiveFolderKind::PullRequests => [
            PullRequestSection::Authored,
            PullRequestSection::Review,
            PullRequestSection::Team,
        ]
        .into_iter()
        .map(|s| {
            (
                s.key(),
                s.title(),
                items
                    .iter()
                    .filter(|it| it.section_or_authored() == s)
                    .collect(),
            )
        })
        .collect(),
        LiveFolderKind::Documents => vec![("documents", None, items.iter().collect())],
    };
    let mut rows = Vec::new();
    for (section, title, members) in sections {
        if members.is_empty() {
            continue;
        }
        if let Some(title) = title {
            rows.push(FolderRow::Header {
                key: format!("h:{section}"),
                title: title.to_owned(),
            });
        }
        let mut entries = Vec::new();
        let mut stacked: HashSet<String> = HashSet::new();
        for it in &members {
            let stack = if folder.group_stacks {
                it.pr.as_ref().and_then(|p| p.stack.as_ref())
            } else {
                None
            };
            let Some(stack) = stack else {
                entries.push(FolderRow::Item {
                    key: it.id.clone(),
                    item: Box::new((*it).clone()),
                });
                continue;
            };
            if !stacked.insert(stack.id.clone()) {
                continue;
            }
            let mut in_stack: Vec<LiveItem> = members
                .iter()
                .filter(|m| {
                    m.pr.as_ref()
                        .and_then(|p| p.stack.as_ref())
                        .is_some_and(|s| s.id == stack.id)
                })
                .map(|m| (*m).clone())
                .collect();
            in_stack.sort_by_key(|m| {
                m.pr.as_ref()
                    .and_then(|p| p.stack.as_ref())
                    .map_or(0, |s| s.position)
            });
            entries.push(FolderRow::Stack {
                key: stack.id.clone(),
                id: stack.id.clone(),
                repo: it.pr.as_ref().map(|p| p.repo.clone()).unwrap_or_default(),
                items: in_stack,
            });
        }
        let all = show_all
            .get(&show_all_key(&folder.id, section))
            .copied()
            .unwrap_or(false);
        let total = entries.len();
        if all {
            rows.extend(entries);
        } else {
            rows.extend(entries.into_iter().take(page));
            if total > page {
                rows.push(FolderRow::More {
                    key: format!("m:{section}"),
                    section: section.to_owned(),
                    count: total - page,
                });
            }
        }
    }
    rows
}

pub fn order_items(items: &mut [LiveItem]) {
    items.sort_by(|a, b| {
        a.section_or_authored()
            .order()
            .cmp(&b.section_or_authored().order())
            .then(b.updated_at.cmp(&a.updated_at))
    });
}

fn without<T>(map: &mut BTreeMap<String, T>, key: &str) {
    map.remove(key);
}

fn same_ids(a: &[LiveItem], b: &[LiveItem]) -> bool {
    a == b
}

pub fn keep_dismissed_now(saved: &BTreeMap<String, i64>, now: i64) -> BTreeMap<String, i64> {
    let live: Vec<(&String, &i64)> = saved.iter().filter(|(_, end)| **end > now).collect();
    let skip = live.len().saturating_sub(50);
    live.into_iter()
        .skip(skip)
        .map(|(k, v)| (k.clone(), *v))
        .collect()
}

impl LiveState {
    pub fn from_saved(saved: Value, now: i64) -> LiveState {
        let mut state: LiveState = serde_json::from_value(migrate(saved)).unwrap_or_default();
        state.dismissed_now = keep_dismissed_now(&state.dismissed_now, now);
        state
            .folder_order
            .retain(|id| state.folders.contains_key(id));
        state
    }

    pub fn saved(&self) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(object) = value.as_object_mut() {
            object.insert("version".into(), Value::from(DOC_VERSION));
        }
        value
    }

    pub fn create_folder(
        &mut self,
        id: String,
        profile_id: &str,
        kind: LiveFolderKind,
        sources: Option<Vec<LiveSourceId>>,
        now: i64,
    ) -> String {
        let folder = LiveFolder {
            id: id.clone(),
            profile_id: profile_id.to_owned(),
            kind,
            name: kind.default_name().to_owned(),
            icon: None,
            collapsed: false,
            sources: sources.unwrap_or_else(|| vec![kind.default_source()]),
            filters: LiveFilters::default(),
            group_stacks: true,
            show_completed: true,
            hidden_repos: Vec::new(),
            show_new_repos: true,
            shown_repos: Vec::new(),
            created_at: now,
            after: None,
            color: None,
        };
        self.folders.insert(id.clone(), folder);
        self.folder_order.push(id.clone());
        self.status.insert(id.clone(), FolderStatus::default());
        id
    }

    pub fn update_folder(&mut self, id: &str, patch: impl FnOnce(&mut LiveFolder)) {
        if let Some(folder) = self.folders.get_mut(id) {
            let (keep_id, keep_profile, keep_kind) =
                (folder.id.clone(), folder.profile_id.clone(), folder.kind);
            patch(folder);
            folder.id = keep_id;
            folder.profile_id = keep_profile;
            folder.kind = keep_kind;
        }
    }

    fn stack_ids(items: Option<&Vec<LiveItem>>) -> Vec<String> {
        items
            .map(|items| {
                items
                    .iter()
                    .filter_map(|it| {
                        it.pr
                            .as_ref()
                            .and_then(|p| p.stack.as_ref())
                            .map(|s| s.id.clone())
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn remove_folder(&mut self, id: &str) {
        let listed_in = |s: &LiveState, f: &str| {
            let mut ids = Self::stack_ids(s.items.get(f));
            ids.extend(Self::stack_ids(s.hidden.get(f)));
            ids.extend(Self::stack_ids(s.repo_hidden.get(f)));
            ids
        };
        let elsewhere: HashSet<String> = self
            .folder_order
            .iter()
            .filter(|f| *f != id)
            .flat_map(|f| listed_in(self, f))
            .collect();
        let stacks: HashSet<String> = listed_in(self, id)
            .into_iter()
            .filter(|s| !elsewhere.contains(s))
            .collect();
        self.folders.remove(id);
        self.folder_order.retain(|f| f != id);
        for map in [&mut self.items, &mut self.hidden, &mut self.repo_hidden] {
            without(map, id);
        }
        for map in [&mut self.known, &mut self.unread, &mut self.completing] {
            without(map, id);
        }
        without(&mut self.completed, id);
        without(&mut self.status, id);
        let prefix = show_all_key(id, "");
        self.show_all.retain(|k, _| !k.starts_with(&prefix));
        self.expanded_stacks.retain(|s, _| !stacks.contains(s));
    }

    pub fn show_all_in(&mut self, folder: &str, section: &str) {
        self.show_all.insert(show_all_key(folder, section), true);
    }

    pub fn toggle_stack(&mut self, stack: &str) {
        let expanded = self.expanded_stacks.get(stack).copied() == Some(false);
        self.expanded_stacks.insert(stack.to_owned(), expanded);
    }

    pub fn stack_expanded(&self, stack: &str) -> bool {
        self.expanded_stacks.get(stack).copied() != Some(false)
    }

    pub fn mark_unread(&mut self, folder: &str, item: &str) {
        let unread = self.unread.entry(folder.to_owned()).or_default();
        if !unread.iter().any(|id| id == item) {
            unread.push(item.to_owned());
        }
    }

    pub fn arrange_folders(&mut self, placed: &[(String, Option<String>)]) -> bool {
        let ids: Vec<String> = placed
            .iter()
            .map(|(id, _)| id.clone())
            .filter(|id| self.folders.contains_key(id))
            .collect();
        if ids.is_empty() {
            return false;
        }
        let mut moved = false;
        for (id, after) in placed {
            if let Some(folder) = self.folders.get_mut(id)
                && folder.after.clone().flatten() != *after
            {
                folder.after = Some(after.clone());
                moved = true;
            }
        }
        let slots: Vec<usize> = self
            .folder_order
            .iter()
            .enumerate()
            .filter(|(_, id)| ids.contains(id))
            .map(|(i, _)| i)
            .collect();
        let before = self.folder_order.clone();
        for (slot, id) in slots.iter().zip(ids.iter()) {
            self.folder_order[*slot] = id.clone();
        }
        moved || before != self.folder_order
    }

    fn shown_repos_released(&mut self, folder: &str, fetched_sources: &HashSet<LiveSourceId>) {
        let Some(kept_out) = self.repo_hidden.get(folder) else {
            return;
        };
        let Some(f) = self.folders.get(folder) else {
            return;
        };
        let still: Vec<LiveItem> = kept_out
            .iter()
            .filter(|it| {
                f.hidden_repos.contains(&repo_key(it).unwrap_or_default())
                    || (f.sources.contains(&it.source) && !fetched_sources.contains(&it.source))
            })
            .cloned()
            .collect();
        if still.len() != kept_out.len() {
            self.repo_hidden.insert(folder.to_owned(), still);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn apply_fetch(
        &mut self,
        folder: &str,
        fetched: Vec<LiveItem>,
        gone: &HashMap<String, CompletionState>,
        now: i64,
        quiet: &HashSet<String>,
        fetched_sources: &HashSet<LiveSourceId>,
    ) -> Vec<String> {
        if !self.folders.contains_key(folder) {
            return Vec::new();
        }
        let closed = |id: &str| gone.get(id).is_some_and(|s| s.ended());
        let fetched_by_id: HashMap<&str, &LiveItem> =
            fetched.iter().map(|it| (it.id.as_str(), it)).collect();
        let was_hidden = self.hidden.get(folder).cloned().unwrap_or_default();
        let still_hidden: Vec<LiveItem> = was_hidden
            .iter()
            .filter(|it| !closed(&it.id))
            .map(|it| {
                fetched_by_id
                    .get(it.id.as_str())
                    .map_or_else(|| it.clone(), |f| (*f).clone())
            })
            .collect();
        let hidden_ids: HashSet<&str> = still_hidden.iter().map(|it| it.id.as_str()).collect();
        let next: Vec<LiveItem> = fetched
            .iter()
            .filter(|it| !hidden_ids.contains(it.id.as_str()))
            .cloned()
            .collect();
        let known: Vec<String> = self.known.get(folder).cloned().unwrap_or_default();
        let known_set: HashSet<&str> = known.iter().map(String::as_str).collect();
        let first =
            known.is_empty() && self.status.get(folder).and_then(|s| s.last_fetch).is_none();
        let fresh: Vec<String> = next
            .iter()
            .filter(|it| !known_set.contains(it.id.as_str()))
            .map(|it| it.id.clone())
            .collect();
        let kept_out: HashSet<String> = self
            .repo_hidden
            .get(folder)
            .map(|v| v.iter().map(|it| it.id.clone()).collect())
            .unwrap_or_default();
        let unread_fresh: Vec<String> = fresh
            .iter()
            .filter(|id| !quiet.contains(*id) && !kept_out.contains(*id))
            .cloned()
            .collect();
        let ids: HashSet<&str> = next.iter().map(|it| it.id.as_str()).collect();
        let prev = self.items.get(folder).cloned().unwrap_or_default();
        let animating: HashSet<String> = self
            .completing
            .get(folder)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let leaving: Vec<LiveItem> = prev
            .iter()
            .filter(|it| {
                !ids.contains(it.id.as_str())
                    && gone.contains_key(&it.id)
                    && !animating.contains(&it.id)
            })
            .cloned()
            .collect();
        let mut merged = next.clone();
        for (index, it) in prev.iter().enumerate() {
            if !ids.contains(it.id.as_str())
                && (animating.contains(&it.id) || leaving.iter().any(|l| l.id == it.id))
            {
                let at = index.min(merged.len());
                merged.insert(at, it.clone());
            }
        }
        let mut completed: Vec<CompletedItem> = leaving
            .iter()
            .map(|item| CompletedItem {
                item: item.clone(),
                state: gone[&item.id],
                at: now,
            })
            .collect();
        let previous_completed = self.completed.get(folder).cloned().unwrap_or_default();
        completed.extend(
            previous_completed
                .iter()
                .filter(|c| {
                    !ids.contains(c.item.id.as_str()) && !leaving.iter().any(|l| l.id == c.item.id)
                })
                .cloned(),
        );
        completed.truncate(MAX_COMPLETED);
        let still_there: HashSet<&str> = merged.iter().map(|it| it.id.as_str()).collect();
        let unread: Vec<String> = if first {
            Vec::new()
        } else {
            let mut all = self.unread.get(folder).cloned().unwrap_or_default();
            for id in unread_fresh {
                if !all.contains(&id) {
                    all.push(id);
                }
            }
            all.into_iter()
                .filter(|id| still_there.contains(id.as_str()))
                .collect()
        };
        if !same_ids(&merged, &prev) {
            self.items.insert(folder.to_owned(), merged);
        }
        if still_hidden != was_hidden {
            self.hidden.insert(folder.to_owned(), still_hidden);
        }
        if !fresh.is_empty() || !self.known.contains_key(folder) {
            let mut all = known.clone();
            all.extend(fresh);
            let skip = all.len().saturating_sub(MAX_KNOWN);
            self.known
                .insert(folder.to_owned(), all.into_iter().skip(skip).collect());
        }
        self.unread.insert(folder.to_owned(), unread);
        if !leaving.is_empty() || previous_completed.len() != completed.len() {
            self.completed.insert(folder.to_owned(), completed);
        }
        if !leaving.is_empty() {
            self.completing
                .entry(folder.to_owned())
                .or_default()
                .extend(leaving.iter().map(|l| l.id.clone()));
        }
        self.status.insert(
            folder.to_owned(),
            FolderStatus {
                state: FolderState::Idle,
                last_fetch: Some(now),
                error: None,
            },
        );
        self.shown_repos_released(folder, fetched_sources);
        leaving.into_iter().map(|l| l.id).collect()
    }

    pub fn finish_completing(&mut self, folder: &str, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        let gone = |id: &String| ids.contains(id);
        if let Some(items) = self.items.get_mut(folder) {
            items.retain(|it| !gone(&it.id));
        }
        if let Some(completing) = self.completing.get_mut(folder) {
            completing.retain(|id| !gone(id));
        }
        if let Some(unread) = self.unread.get_mut(folder) {
            unread.retain(|id| !gone(id));
        }
    }

    pub fn set_status(&mut self, folder: &str, patch: impl FnOnce(&mut FolderStatus)) {
        let status = self
            .status
            .entry(folder.to_owned())
            .or_insert(FolderStatus {
                state: FolderState::Idle,
                last_fetch: None,
                error: None,
            });
        patch(status);
    }

    pub fn mark_read(&mut self, folder: &str, items: Option<&[String]>) -> bool {
        let Some(unread) = self.unread.get_mut(folder) else {
            return false;
        };
        let before = unread.len();
        match items {
            Some(items) => unread.retain(|id| !items.contains(id)),
            None => unread.clear(),
        }
        unread.len() != before
    }

    pub fn hide_items(&mut self, folder: &str, hiding: Vec<LiveItem>) {
        let ids: HashSet<String> = hiding.iter().map(|it| it.id.clone()).collect();
        let hidden = self.hidden.entry(folder.to_owned()).or_default();
        hidden.retain(|it| !ids.contains(&it.id));
        hidden.extend(hiding);
        if let Some(items) = self.items.get_mut(folder) {
            items.retain(|it| !ids.contains(&it.id));
        }
        if let Some(unread) = self.unread.get_mut(folder) {
            unread.retain(|id| !ids.contains(id));
        }
        if let Some(completing) = self.completing.get_mut(folder) {
            completing.retain(|id| !ids.contains(id));
        }
        if let Some(completed) = self.completed.get_mut(folder) {
            completed.retain(|c| !ids.contains(&c.item.id));
        }
    }

    pub fn hide_stack(&mut self, folder: &str, stack: &str) {
        let members: Vec<LiveItem> =
            stack_members(self.items.get(folder).map_or(&[], Vec::as_slice), stack)
                .into_iter()
                .cloned()
                .collect();
        self.hide_items(folder, members);
    }

    pub fn set_repo_hidden(&mut self, folder_id: &str, repo: &str, hidden: bool) {
        let Some(folder) = self.folders.get(folder_id).cloned() else {
            return;
        };
        let hidden_repos: Vec<String> = folder
            .hidden_repos
            .iter()
            .filter(|r| *r != repo)
            .cloned()
            .collect();
        let shown_repos: Vec<String> = folder
            .shown_repos
            .iter()
            .filter(|r| *r != repo)
            .cloned()
            .collect();
        if !hidden {
            let shown_repos = if folder.show_new_repos {
                shown_repos
            } else {
                let mut s = shown_repos;
                s.push(repo.to_owned());
                s
            };
            self.update_folder(folder_id, |f| {
                f.hidden_repos = hidden_repos;
                f.shown_repos = shown_repos;
            });
            return;
        }
        let shown = |it: &LiveItem| repo_key(it).as_deref() != Some(repo);
        let kept_out = self.repo_hidden.get(folder_id).cloned().unwrap_or_default();
        let kept: HashSet<&str> = kept_out.iter().map(|it| it.id.as_str()).collect();
        let mut leaving: Vec<LiveItem> = self.items.get(folder_id).cloned().unwrap_or_default();
        leaving.extend(
            self.completed
                .get(folder_id)
                .map(|c| c.iter().map(|c| c.item.clone()).collect::<Vec<_>>())
                .unwrap_or_default(),
        );
        let leaving: Vec<LiveItem> = leaving
            .into_iter()
            .filter(|it| !shown(it) && !kept.contains(it.id.as_str()))
            .collect();
        let removed: HashSet<String> = leaving.iter().map(|it| it.id.clone()).collect();
        let mut repos = hidden_repos;
        repos.push(repo.to_owned());
        self.update_folder(folder_id, |f| {
            f.hidden_repos = repos;
            f.shown_repos = shown_repos;
        });
        let mut all_kept = kept_out.clone();
        all_kept.extend(leaving);
        self.repo_hidden.insert(folder_id.to_owned(), all_kept);
        if let Some(items) = self.items.get_mut(folder_id) {
            items.retain(shown);
        }
        if let Some(unread) = self.unread.get_mut(folder_id) {
            unread.retain(|id| !removed.contains(id));
        }
        if let Some(completing) = self.completing.get_mut(folder_id) {
            completing.retain(|id| !removed.contains(id));
        }
        if let Some(completed) = self.completed.get_mut(folder_id) {
            completed.retain(|c| shown(&c.item));
        }
    }

    pub fn unhide(&mut self, folder: &str) {
        let Some(hidden) = self.hidden.remove(folder) else {
            return;
        };
        if hidden.is_empty() {
            return;
        }
        let hidden_repos = self
            .folders
            .get(folder)
            .map(|f| f.hidden_repos.clone())
            .unwrap_or_default();
        let in_hidden_repo =
            |it: &LiveItem| hidden_repos.contains(&repo_key(it).unwrap_or_default());
        let (repo, back): (Vec<LiveItem>, Vec<LiveItem>) =
            hidden.into_iter().partition(|it| in_hidden_repo(it));
        self.items
            .entry(folder.to_owned())
            .or_default()
            .extend(back);
        self.repo_hidden
            .entry(folder.to_owned())
            .or_default()
            .extend(repo);
    }

    pub fn folder_repos(&self, folder: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut push = |repo: String| {
            if !out.contains(&repo) {
                out.push(repo);
            }
        };
        for list in [&self.items, &self.hidden, &self.repo_hidden] {
            for it in list.get(folder).into_iter().flatten() {
                if let Some(repo) = repo_key(it) {
                    push(repo);
                }
            }
        }
        if let Some(f) = self.folders.get(folder) {
            for repo in f.hidden_repos.iter().chain(f.shown_repos.iter()) {
                push(repo.clone());
            }
        }
        out
    }

    pub fn show_all_repos(&mut self, folder: &str) {
        let shown = if self.folders.get(folder).is_some_and(|f| f.show_new_repos) {
            Vec::new()
        } else {
            self.folder_repos(folder)
        };
        self.update_folder(folder, |f| {
            f.hidden_repos.clear();
            f.shown_repos = shown;
        });
    }

    pub fn set_show_new_repos(&mut self, folder: &str, show: bool) {
        let Some(f) = self.folders.get(folder) else {
            return;
        };
        let hidden = f.hidden_repos.clone();
        let shown = if show {
            Vec::new()
        } else {
            self.folder_repos(folder)
                .into_iter()
                .filter(|r| !hidden.contains(r))
                .collect()
        };
        self.update_folder(folder, |f| {
            f.show_new_repos = show;
            f.shown_repos = shown;
        });
    }

    pub fn hide_new_repos(&mut self, folder: &str, fetched: &[LiveItem]) {
        let Some(f) = self.folders.get(folder) else {
            return;
        };
        if f.show_new_repos {
            return;
        }
        let known: HashSet<String> = f
            .shown_repos
            .iter()
            .chain(f.hidden_repos.iter())
            .cloned()
            .collect();
        let mut fresh: Vec<String> = Vec::new();
        for repo in fetched.iter().filter_map(repo_key) {
            if !known.contains(&repo) && !fresh.contains(&repo) {
                fresh.push(repo);
            }
        }
        for repo in fresh {
            self.set_repo_hidden(folder, &repo, true);
        }
    }

    pub fn set_account(&mut self, source: LiveSourceId, account: Option<LiveAccount>) {
        match account {
            Some(account) => {
                self.accounts.insert(source, account);
            }
            None => {
                self.accounts.remove(&source);
            }
        }
    }

    pub fn connected_sources(&self, kind: LiveFolderKind) -> Vec<LiveSourceId> {
        let wanted: &[LiveSourceId] = match kind {
            LiveFolderKind::PullRequests => &[LiveSourceId::Github, LiveSourceId::Bitbucket],
            LiveFolderKind::Documents => &[
                LiveSourceId::Notion,
                LiveSourceId::Confluence,
                LiveSourceId::Gdrive,
            ],
        };
        wanted
            .iter()
            .copied()
            .filter(|s| self.accounts.contains_key(s))
            .collect()
    }

    pub fn dismiss_alert(&mut self, occurrence: &str) {
        if !self.dismissed_alerts.iter().any(|o| o == occurrence) {
            self.dismissed_alerts.push(occurrence.to_owned());
            let skip = self.dismissed_alerts.len().saturating_sub(200);
            self.dismissed_alerts.drain(..skip);
        }
    }

    pub fn dismiss_now_badge(&mut self, occurrence: &str, end: i64, now: i64) {
        if self.dismissed_now.contains_key(occurrence) {
            return;
        }
        self.dismissed_now.insert(occurrence.to_owned(), end);
        self.dismissed_now = keep_dismissed_now(&self.dismissed_now, now);
    }

    pub fn set_meeting_group(&mut self, group: Option<MeetingGroup>, group_id: Option<&str>) {
        match (group, group_id) {
            (Some(group), _) => {
                self.meeting_groups.insert(group.group_id.clone(), group);
            }
            (None, Some(id)) => {
                self.meeting_groups.remove(id);
            }
            _ => {}
        }
    }

    pub fn folder_item(&self, folder: &str, item: &str) -> Option<&LiveItem> {
        self.items
            .get(folder)
            .and_then(|v| v.iter().find(|i| i.id == item))
            .or_else(|| {
                self.hidden
                    .get(folder)
                    .and_then(|v| v.iter().find(|i| i.id == item))
            })
            .or_else(|| {
                self.completed
                    .get(folder)
                    .and_then(|v| v.iter().find(|c| c.item.id == item))
                    .map(|c| &c.item)
            })
    }

    pub fn due(&self, folder: &str, max_age: i64, now: i64) -> bool {
        self.folders.contains_key(folder)
            && self
                .status
                .get(folder)
                .and_then(|s| s.last_fetch)
                .is_none_or(|last| now - last >= max_age)
    }

    pub fn status_text(&self, folder: &str, now: i64, paused_until: Option<i64>) -> String {
        let hidden = self.hidden.get(folder).map_or(0, Vec::len);
        let text = self.fetch_text(folder, now, paused_until);
        if hidden > 0 {
            format!("{text} · {hidden} hidden until you refresh")
        } else {
            text
        }
    }

    fn fetch_text(&self, folder: &str, now: i64, paused_until: Option<i64>) -> String {
        let Some(status) = self.status.get(folder) else {
            return "Loading…".into();
        };
        match status.state {
            FolderState::Initializing => return "Loading…".into(),
            FolderState::Updating => return "Updating…".into(),
            _ => {}
        }
        if let Some(error) = &status.error {
            return error_text(error.kind, error.source, now, paused_until);
        }
        let Some(last) = status.last_fetch else {
            return "Not updated yet".into();
        };
        let min = (now - last).div_euclid(60_000);
        if min < 1 {
            "Updated just now".into()
        } else if min < 60 {
            format!("Updated {min} min ago")
        } else {
            format!("Updated {} hr ago", min / 60)
        }
    }
}

pub fn error_text(
    kind: LiveErrorKind,
    source: LiveSourceId,
    now: i64,
    paused_until: Option<i64>,
) -> String {
    let name = source.name();
    match kind {
        LiveErrorKind::NotConfigured => format!("Connect {name} in Settings"),
        LiveErrorKind::SignedOut => format!("Sign back in to {name}"),
        LiveErrorKind::Sso => format!("{name} needs Single Sign-On for this organization"),
        LiveErrorKind::TokenBlocked => format!(
            "An organization's token policy hides its pull requests. Update your {name} token."
        ),
        LiveErrorKind::RateLimited => {
            let minutes = paused_until.map_or(0, |until| (until - now + 59_999).div_euclid(60_000));
            if minutes <= 0 {
                format!("{name} rate limit exceeded. Try again in a few minutes.")
            } else if minutes == 1 {
                format!("{name} rate limit reached. Updating again in a minute.")
            } else {
                format!("{name} rate limit reached. Updating again in {minutes} minutes.")
            }
        }
        LiveErrorKind::Network => format!("Couldn't connect to {name}"),
        LiveErrorKind::Other => format!("We're having trouble connecting to {name}"),
    }
}

fn migrate(mut saved: Value) -> Value {
    let version = saved.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version < 2
        && let Some(folders) = saved.get_mut("folders").and_then(Value::as_object_mut)
    {
        for folder in folders.values_mut() {
            if let Some(folder) = folder.as_object_mut() {
                folder.entry("showNewRepos").or_insert(Value::Bool(true));
                folder
                    .entry("shownRepos")
                    .or_insert(Value::Array(Vec::new()));
            }
        }
    }
    saved
}

#[derive(Clone, Debug, PartialEq)]
pub enum LiveCommand {
    Refresh {
        folder: String,
        manual: bool,
    },
    CreateFolder {
        window: crate::WindowId,
        kind: LiveFolderKind,
        sources: Option<Vec<LiveSourceId>>,
        name: Option<String>,
    },
    RemoveFolder {
        folder: String,
    },
    Rename {
        folder: String,
        name: String,
    },
    SetCollapsed {
        folder: String,
        collapsed: bool,
    },
    SetIcon {
        folder: String,
        icon: Option<String>,
    },
    SetColor {
        folder: String,
        color: Option<Value>,
    },
    SetOptions {
        folder: String,
        group_stacks: Option<bool>,
        show_completed: Option<bool>,
        filters: Option<LiveFilters>,
        sources: Option<Vec<LiveSourceId>>,
    },
    MarkRead {
        folder: String,
        items: Option<Vec<String>>,
    },
    MarkUnread {
        folder: String,
        item: String,
    },
    HideItems {
        folder: String,
        items: Vec<String>,
    },
    HideStack {
        folder: String,
        stack: String,
    },
    SetRepoHidden {
        folder: String,
        repo: String,
        hidden: bool,
    },
    ShowAllRepos {
        folder: String,
    },
    SetShowNewRepos {
        folder: String,
        show: bool,
    },
    ShowAllIn {
        folder: String,
        section: String,
    },
    ToggleStack {
        stack: String,
    },
    Arrange {
        placed: Vec<(String, Option<String>)>,
    },
    OpenItem {
        window: crate::WindowId,
        folder: String,
        item: String,
        background: bool,
    },
    Connect {
        source: LiveSourceId,
        token: String,
        user: Option<String>,
        site: Option<String>,
    },
    Disconnect {
        source: LiveSourceId,
    },
    UpdateCalendar {
        patch: CalendarPatch,
    },
    DismissAlert {
        occurrence: String,
    },
    DismissNowBadge {
        occurrence: String,
        end: i64,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CalendarPatch {
    pub alert_lead: Option<String>,
    pub alert_condition: Option<AlertCondition>,
    pub show_preview: Option<bool>,
    pub show_time_to_next: Option<bool>,
    pub countdown_lead: Option<i64>,
    pub hidden_calendar_ids: Option<Vec<String>>,
    pub prompted: Option<bool>,
}

impl CalendarSettings {
    pub fn apply(&mut self, patch: CalendarPatch) {
        if let Some(v) = patch.alert_lead {
            self.alert_lead = v;
        }
        if let Some(v) = patch.alert_condition {
            self.alert_condition = v;
        }
        if let Some(v) = patch.show_preview {
            self.show_preview = v;
        }
        if let Some(v) = patch.show_time_to_next {
            self.show_time_to_next = v;
        }
        if let Some(v) = patch.countdown_lead {
            self.countdown_lead = v;
        }
        if let Some(v) = patch.hidden_calendar_ids {
            self.hidden_calendar_ids = v;
        }
        if let Some(v) = patch.prompted {
            self.prompted = v;
        }
    }
}

impl LiveState {
    pub fn apply_local(&mut self, command: &LiveCommand, now: i64) -> bool {
        match command.clone() {
            LiveCommand::Rename { folder, name } => self.update_folder(&folder, |f| f.name = name),
            LiveCommand::SetCollapsed { folder, collapsed } => {
                self.update_folder(&folder, |f| f.collapsed = collapsed)
            }
            LiveCommand::SetIcon { folder, icon } => self.update_folder(&folder, |f| f.icon = icon),
            LiveCommand::SetColor { folder, color } => {
                self.update_folder(&folder, |f| f.color = color)
            }
            LiveCommand::SetOptions {
                folder,
                group_stacks,
                show_completed,
                filters,
                sources,
            } => self.update_folder(&folder, |f| {
                if let Some(v) = group_stacks {
                    f.group_stacks = v;
                }
                if let Some(v) = show_completed {
                    f.show_completed = v;
                }
                if let Some(v) = filters {
                    f.filters = v;
                }
                if let Some(v) = sources {
                    f.sources = v;
                }
            }),
            LiveCommand::MarkRead { folder, items } => {
                self.mark_read(&folder, items.as_deref());
            }
            LiveCommand::MarkUnread { folder, item } => self.mark_unread(&folder, &item),
            LiveCommand::HideItems { folder, items } => {
                let hiding: Vec<LiveItem> = self
                    .items
                    .get(&folder)
                    .into_iter()
                    .flatten()
                    .filter(|it| items.contains(&it.id))
                    .cloned()
                    .collect();
                self.hide_items(&folder, hiding);
            }
            LiveCommand::HideStack { folder, stack } => self.hide_stack(&folder, &stack),
            LiveCommand::SetRepoHidden {
                folder,
                repo,
                hidden,
            } => self.set_repo_hidden(&folder, &repo, hidden),
            LiveCommand::ShowAllRepos { folder } => self.show_all_repos(&folder),
            LiveCommand::SetShowNewRepos { folder, show } => self.set_show_new_repos(&folder, show),
            LiveCommand::ShowAllIn { folder, section } => self.show_all_in(&folder, &section),
            LiveCommand::ToggleStack { stack } => self.toggle_stack(&stack),
            LiveCommand::Arrange { placed } => {
                self.arrange_folders(&placed);
            }
            LiveCommand::UpdateCalendar { patch } => self.calendar.apply(patch),
            LiveCommand::DismissAlert { occurrence } => self.dismiss_alert(&occurrence),
            LiveCommand::DismissNowBadge { occurrence, end } => {
                self.dismiss_now_badge(&occurrence, end, now)
            }
            LiveCommand::RemoveFolder { folder } => self.remove_folder(&folder),
            _ => return false,
        }
        true
    }
}

pub fn folder_icon(folder: &LiveFolder) -> (&'static str, Option<String>) {
    let site = folder
        .sources
        .first()
        .copied()
        .unwrap_or(LiveSourceId::Github)
        .site();
    let icon = folder.icon.clone().or_else(|| {
        (folder.sources.len() > 1 && folder.kind == LiveFolderKind::Documents)
            .then(|| "symbol:doc.text".to_owned())
    });
    (site, icon)
}

#[cfg(test)]
mod tests;
