use std::collections::{HashMap, HashSet};

use ardia_state::TabId;
use ardia_state::groups::GroupColor;
use ardia_state::model::LiveItem as TabLiveItem;
use ardia_state::tabs::Tab;

pub const PAGE_SIZE: usize = 8;
pub const COMPLETION_MS: u64 = 2600;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LiveSource {
    Github,
    Bitbucket,
    Notion,
    Confluence,
    Gdrive,
}

impl LiveSource {
    pub fn name(self) -> &'static str {
        match self {
            LiveSource::Github => "GitHub",
            LiveSource::Bitbucket => "Bitbucket",
            LiveSource::Notion => "Notion",
            LiveSource::Confluence => "Confluence",
            LiveSource::Gdrive => "Google Drive",
        }
    }

    pub fn site(self) -> &'static str {
        match self {
            LiveSource::Github => "https://github.com",
            LiveSource::Bitbucket => "https://bitbucket.org",
            LiveSource::Notion => "https://www.notion.so",
            LiveSource::Confluence => "https://www.atlassian.com",
            LiveSource::Gdrive => "https://drive.google.com",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FolderKind {
    PullRequests,
    Documents,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Section {
    Authored,
    Review,
    Team,
    Documents,
}

impl Section {
    pub fn key(self) -> &'static str {
        match self {
            Section::Authored => "authored",
            Section::Review => "review",
            Section::Team => "team",
            Section::Documents => "documents",
        }
    }

    pub fn title(self) -> Option<&'static str> {
        match self {
            Section::Review => Some("Review Requests"),
            Section::Team => Some("Team Review Requests"),
            Section::Authored | Section::Documents => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckState {
    Success,
    Failure,
    Pending,
    Queued,
    Neutral,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Review {
    Approved,
    ChangesRequested,
    Required,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mergeable {
    Mergeable,
    Conflicting,
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stack {
    pub id: String,
    pub position: u32,
    pub size: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PullRequest {
    pub repo: String,
    pub draft: bool,
    pub review: Option<Review>,
    pub mergeable: Mergeable,
    pub checks: Vec<CheckState>,
    pub stack: Option<Stack>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id: String,
    pub source: LiveSource,
    pub url: String,
    pub title: String,
    pub icon: Option<String>,
    pub section: Option<Section>,
    pub pr: Option<PullRequest>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completion {
    Merged,
    Reviewed,
    Closed,
}

impl Completion {
    pub fn label(self) -> &'static str {
        match self {
            Completion::Merged => "Merged",
            Completion::Reviewed => "Reviewed",
            Completion::Closed => "Closed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    SignedOut,
    Sso,
    TokenBlocked,
    RateLimited { minutes_left: Option<i64> },
    Network,
    NotConfigured,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchState {
    Initializing,
    Idle,
    Updating,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Status {
    pub state: FetchState,
    pub last_fetch: Option<i64>,
    pub error: Option<(ErrorKind, LiveSource)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Folder {
    pub id: String,
    pub profile_id: ardia_state::ProfileId,
    pub after: Option<Option<String>>,
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<GroupColor>,
    pub kind: FolderKind,
    pub sources: Vec<LiveSource>,
    pub collapsed: bool,
    pub group_stacks: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FolderData {
    pub items: Vec<Item>,
    pub unread: HashSet<String>,
    pub hidden: HashSet<String>,
    pub show_all: HashSet<Section>,
    pub collapsed_stacks: HashSet<String>,
    pub completing: HashMap<String, Completion>,
    pub completed_shown: usize,
    pub completed: Vec<crate::sidebar::completed_footer::CompletedRow>,
    pub status: Option<Status>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Item(Item),
    Stack {
        id: String,
        repo: String,
        items: Vec<Item>,
    },
    Header {
        section: Section,
        title: &'static str,
    },
    More {
        section: Section,
        count: usize,
    },
}

impl Row {
    pub fn key(&self) -> String {
        match self {
            Row::Item(item) => item.id.clone(),
            Row::Stack { id, .. } => id.clone(),
            Row::Header { section, .. } => format!("h:{}", section.key()),
            Row::More { section, .. } => format!("m:{}", section.key()),
        }
    }
}

pub fn folder_rows(folder: &Folder, items: &[Item], show_all: &HashSet<Section>) -> Vec<Row> {
    let sections: Vec<Section> = match folder.kind {
        FolderKind::PullRequests => vec![Section::Authored, Section::Review, Section::Team],
        FolderKind::Documents => vec![Section::Documents],
    };
    let mut rows = Vec::new();
    for section in sections {
        let members: Vec<&Item> = items
            .iter()
            .filter(|it| {
                section == Section::Documents || it.section.unwrap_or(Section::Authored) == section
            })
            .collect();
        if members.is_empty() {
            continue;
        }
        if let Some(title) = section.title() {
            rows.push(Row::Header { section, title });
        }
        let mut entries: Vec<Row> = Vec::new();
        let mut stacked: HashSet<&str> = HashSet::new();
        for it in &members {
            let stack = folder
                .group_stacks
                .then(|| it.pr.as_ref().and_then(|pr| pr.stack.as_ref()))
                .flatten();
            let Some(stack) = stack else {
                entries.push(Row::Item((*it).clone()));
                continue;
            };
            if !stacked.insert(stack.id.as_str()) {
                continue;
            }
            let mut in_stack: Vec<Item> = members
                .iter()
                .filter(|m| {
                    m.pr.as_ref()
                        .and_then(|pr| pr.stack.as_ref())
                        .is_some_and(|s| s.id == stack.id)
                })
                .map(|m| (*m).clone())
                .collect();
            in_stack.sort_by_key(|m| {
                m.pr.as_ref()
                    .and_then(|pr| pr.stack.as_ref())
                    .map_or(0, |s| s.position)
            });
            entries.push(Row::Stack {
                id: stack.id.clone(),
                repo: it
                    .pr
                    .as_ref()
                    .map_or_else(String::new, |pr| pr.repo.clone()),
                items: in_stack,
            });
        }
        let all = show_all.contains(&section);
        let more = entries.len().saturating_sub(PAGE_SIZE);
        if all {
            rows.extend(entries);
        } else {
            rows.extend(entries.into_iter().take(PAGE_SIZE));
            if more > 0 {
                rows.push(Row::More {
                    section,
                    count: more,
                });
            }
        }
    }
    rows
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckTone {
    Success,
    Failure,
    Pending,
}

pub fn check_tone(checks: &[CheckState]) -> Option<CheckTone> {
    if checks.is_empty() {
        return None;
    }
    let failure = checks.iter().filter(|c| **c == CheckState::Failure).count();
    let pending = checks
        .iter()
        .filter(|c| matches!(c, CheckState::Pending | CheckState::Queued))
        .count();
    Some(if failure > 0 {
        CheckTone::Failure
    } else if pending > 0 {
        CheckTone::Pending
    } else {
        CheckTone::Success
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrBadge {
    Conflict,
    Failing,
    ChangesRequested,
    Pending,
    Approved,
    Passed,
}

impl PrBadge {
    pub fn tip(self) -> &'static str {
        match self {
            PrBadge::Conflict => "Merge conflicts",
            PrBadge::Failing => "Checks are failing",
            PrBadge::ChangesRequested => "Changes Requested",
            PrBadge::Pending => "Some checks haven't completed yet",
            PrBadge::Approved => "Approved",
            PrBadge::Passed => "All checks have passed",
        }
    }
}

pub fn pr_badge(pr: &PullRequest) -> Option<PrBadge> {
    if pr.mergeable == Mergeable::Conflicting {
        return Some(PrBadge::Conflict);
    }
    let tone = check_tone(&pr.checks);
    if tone == Some(CheckTone::Failure) {
        return Some(PrBadge::Failing);
    }
    if pr.review == Some(Review::ChangesRequested) {
        return Some(PrBadge::ChangesRequested);
    }
    if tone == Some(CheckTone::Pending) {
        return Some(PrBadge::Pending);
    }
    if pr.review == Some(Review::Approved) {
        return Some(PrBadge::Approved);
    }
    (tone == Some(CheckTone::Success)).then_some(PrBadge::Passed)
}

pub fn error_text(kind: ErrorKind, source: LiveSource) -> String {
    let name = source.name();
    match kind {
        ErrorKind::NotConfigured => format!("Connect {name} in Settings"),
        ErrorKind::SignedOut => format!("Sign back in to {name}"),
        ErrorKind::Sso => format!("{name} needs Single Sign-On for this organization"),
        ErrorKind::TokenBlocked => format!(
            "An organization's token policy hides its pull requests. Update your {name} token."
        ),
        ErrorKind::RateLimited { minutes_left } => match minutes_left.filter(|m| *m > 0) {
            None => format!("{name} rate limit exceeded. Try again in a few minutes."),
            Some(1) => format!("{name} rate limit reached. Updating again in a minute."),
            Some(m) => format!("{name} rate limit reached. Updating again in {m} minutes."),
        },
        ErrorKind::Network => format!("Couldn't connect to {name}"),
        ErrorKind::Other => format!("We're having trouble connecting to {name}"),
    }
}

fn fetch_text(status: Option<&Status>, now: i64) -> String {
    let Some(st) = status.filter(|s| s.state != FetchState::Initializing) else {
        return "Loading…".to_owned();
    };
    if st.state == FetchState::Updating {
        return "Updating…".to_owned();
    }
    if let Some((kind, source)) = st.error {
        return error_text(kind, source);
    }
    let Some(last) = st.last_fetch else {
        return "Not updated yet".to_owned();
    };
    let min = (now - last).max(0) / 60_000;
    if min < 1 {
        "Updated just now".to_owned()
    } else if min < 60 {
        format!("Updated {min} min ago")
    } else {
        format!("Updated {} hr ago", min / 60)
    }
}

pub fn status_text(status: Option<&Status>, hidden: usize, now: i64) -> String {
    let text = fetch_text(status, now);
    if hidden > 0 {
        format!("{text} · {hidden} hidden until you refresh")
    } else {
        text
    }
}

pub fn updating(status: Option<&Status>) -> bool {
    status.is_some_and(|s| matches!(s.state, FetchState::Updating | FetchState::Initializing))
}

#[derive(Clone, Debug, PartialEq)]
pub enum Note {
    Loading,
    Error(String),
    Hidden(usize),
    Empty(&'static str),
}

impl Note {
    pub fn text(&self) -> String {
        match self {
            Note::Loading => "Loading…".to_owned(),
            Note::Error(text) => text.clone(),
            Note::Hidden(n) => format!("{n} hidden until you refresh"),
            Note::Empty(text) => (*text).to_owned(),
        }
    }
}

pub fn folder_note(folder: &Folder, data: &FolderData) -> Note {
    match data.status {
        None => Note::Loading,
        Some(st)
            if st.state == FetchState::Initializing
                || (st.state == FetchState::Updating && st.last_fetch.is_none()) =>
        {
            Note::Loading
        }
        Some(Status {
            error: Some((kind, source)),
            ..
        }) => Note::Error(error_text(kind, source)),
        _ if !data.hidden.is_empty() => Note::Hidden(data.hidden.len()),
        _ => Note::Empty(if folder.kind == FolderKind::PullRequests {
            "No open pull requests"
        } else {
            "No recent documents"
        }),
    }
}

pub fn service_icon(folder: &Folder) -> (&'static str, Option<String>) {
    let site = folder
        .sources
        .first()
        .copied()
        .unwrap_or(LiveSource::Github)
        .site();
    let icon = folder.icon.clone().or_else(|| {
        (folder.sources.len() > 1 && folder.kind == FolderKind::Documents)
            .then(|| "symbol:doc.text".to_owned())
    });
    (site, icon)
}

fn live_of<'a>(tab: &'a Tab, folder: &str) -> Option<&'a TabLiveItem> {
    tab.live_item.as_ref().filter(|l| l.folder_id == folder)
}

pub fn item_tab(view: &[&Tab], folder: &str, item: &str) -> Option<TabId> {
    view.iter()
        .find(|t| live_of(t, folder).is_some_and(|l| l.item_id == item))
        .map(|t| t.id.clone())
}

pub fn stack_tab_open(view: &[&Tab], folder: &str, items: &[Item]) -> bool {
    view.iter()
        .any(|t| live_of(t, folder).is_some_and(|l| items.iter().any(|i| i.id == l.item_id)))
}

pub fn strays(
    view: &[&Tab],
    folder: &str,
    items: &HashSet<String>,
    hidden: &HashSet<String>,
) -> Vec<TabId> {
    view.iter()
        .filter(|t| {
            live_of(t, folder)
                .is_some_and(|l| !items.contains(&l.item_id) && !hidden.contains(&l.item_id))
        })
        .map(|t| t.id.clone())
        .collect()
}

pub fn active_live_tab(
    active: Option<&Tab>,
    folder: &str,
    hidden: &HashSet<String>,
) -> Option<(TabId, String)> {
    let tab = active?;
    let live = live_of(tab, folder)?;
    (!hidden.contains(&live.item_id)).then(|| (tab.id.clone(), live.item_id.clone()))
}

pub fn keep_key(
    rows: &[Row],
    strays: &[TabId],
    active: Option<&(TabId, String)>,
) -> Option<String> {
    let (tab, item) = active?;
    if strays.contains(tab) {
        return Some(format!("stray:{tab}"));
    }
    rows.iter()
        .find(|r| match r {
            Row::Item(it) => &it.id == item,
            Row::Stack { items, .. } => items.iter().any(|i| &i.id == item),
            _ => false,
        })
        .map(Row::key)
}

#[cfg(test)]
pub mod fixtures {
    use super::*;

    pub fn pr(id: &str, section: Section, stack: Option<(&str, u32)>) -> Item {
        Item {
            id: id.into(),
            source: LiveSource::Github,
            url: format!("https://github.com/o/r/pull/{id}"),
            title: format!("PR {id}"),
            icon: None,
            section: Some(section),
            pr: Some(PullRequest {
                repo: "o/repo".into(),
                draft: false,
                review: None,
                mergeable: Mergeable::Mergeable,
                checks: vec![CheckState::Success],
                stack: stack.map(|(s, position)| Stack {
                    id: s.into(),
                    position,
                    size: 2,
                }),
            }),
        }
    }

    pub fn folder(kind: FolderKind) -> Folder {
        Folder {
            id: "lf".into(),
            profile_id: ardia_state::ProfileId::default_profile(),
            after: None,
            name: "Reviews".into(),
            icon: None,
            color: None,
            kind,
            sources: vec![LiveSource::Github],
            collapsed: false,
            group_stacks: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn rows_page_at_eight_and_title_review_sections() {
        let mut items: Vec<Item> = (0..10)
            .map(|i| pr(&i.to_string(), Section::Authored, None))
            .collect();
        items.push(pr("r", Section::Review, None));
        let rows = folder_rows(&folder(FolderKind::PullRequests), &items, &HashSet::new());
        assert_eq!(rows.len(), 8 + 1 + 2);
        assert!(matches!(rows[8], Row::More { count: 2, .. }));
        assert!(matches!(
            rows[9],
            Row::Header {
                title: "Review Requests",
                ..
            }
        ));
        let all = folder_rows(
            &folder(FolderKind::PullRequests),
            &items,
            &HashSet::from([Section::Authored]),
        );
        assert_eq!(all.len(), 10 + 2);
    }

    #[test]
    fn stacks_gather_in_position_order() {
        let items = vec![
            pr("b", Section::Authored, Some(("s", 2))),
            pr("x", Section::Authored, None),
            pr("a", Section::Authored, Some(("s", 1))),
        ];
        let rows = folder_rows(&folder(FolderKind::PullRequests), &items, &HashSet::new());
        assert_eq!(rows.len(), 2);
        match &rows[0] {
            Row::Stack { items, repo, .. } => {
                assert_eq!(repo, "o/repo");
                assert_eq!(items[0].id, "a");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn badges_follow_the_github_precedence() {
        let mut p = pr("1", Section::Authored, None).pr.expect("pr");
        assert_eq!(pr_badge(&p), Some(PrBadge::Passed));
        p.review = Some(Review::Approved);
        p.checks = vec![CheckState::Queued];
        assert_eq!(pr_badge(&p), Some(PrBadge::Pending));
        p.checks.push(CheckState::Failure);
        assert_eq!(pr_badge(&p), Some(PrBadge::Failing));
        p.mergeable = Mergeable::Conflicting;
        assert_eq!(pr_badge(&p), Some(PrBadge::Conflict));
        p.checks.clear();
        p.mergeable = Mergeable::Unknown;
        assert_eq!(pr_badge(&p), Some(PrBadge::Approved));
    }

    #[test]
    fn status_and_notes_read_like_the_old_app() {
        let now = 10 * 60_000;
        let idle = Status {
            state: FetchState::Idle,
            last_fetch: Some(now - 3 * 60_000),
            error: None,
        };
        assert_eq!(status_text(Some(&idle), 0, now), "Updated 3 min ago");
        assert_eq!(
            status_text(Some(&idle), 2, now),
            "Updated 3 min ago · 2 hidden until you refresh"
        );
        assert_eq!(status_text(None, 0, now), "Loading…");
        assert_eq!(
            error_text(
                ErrorKind::RateLimited {
                    minutes_left: Some(1)
                },
                LiveSource::Github
            ),
            "GitHub rate limit reached. Updating again in a minute."
        );
        let f = folder(FolderKind::Documents);
        let data = FolderData {
            status: Some(idle),
            ..FolderData::default()
        };
        assert_eq!(folder_note(&f, &data).text(), "No recent documents");
        assert_eq!(folder_note(&f, &FolderData::default()), Note::Loading);
    }
}

pub fn entry_anchor(
    entry: &crate::sidebar::model::Entry,
    state: &ardia_state::BrowserState,
) -> String {
    use crate::sidebar::model::Entry;
    match entry {
        Entry::Tab { tab, .. } => format!("t:{}", tab.pin_key()),
        Entry::Group { group, .. } => format!("g:{}", group.pin_key()),
        Entry::Split { tabs, .. } => {
            let last = tabs.last();
            format!(
                "t:{}",
                last.map_or("", |t| state
                    .tab(t.id.as_str())
                    .map_or(t.id.as_str(), |t| t.pin_key()))
            )
        }
    }
}

pub fn place_live<T>(entries: Vec<(String, T)>, folders: &[(Folder, T)]) -> Vec<T>
where
    T: Clone,
{
    let known: HashSet<&String> = entries.iter().map(|(k, _)| k).collect();
    let at = |after: Option<&str>| -> Vec<T> {
        folders
            .iter()
            .filter(|(f, _)| match &f.after {
                Some(anchor) => anchor.as_deref() == after,
                None => false,
            })
            .map(|(_, v)| v.clone())
            .collect()
    };
    let mut out = at(None);
    let tail: Vec<T> = folders
        .iter()
        .filter(|(f, _)| match &f.after {
            None => true,
            Some(Some(anchor)) => !known.contains(anchor),
            Some(None) => false,
        })
        .map(|(_, v)| v.clone())
        .collect();
    for (key, value) in entries {
        out.push(value);
        out.extend(at(Some(key.as_str())));
    }
    out.extend(tail);
    out
}

#[cfg(test)]
mod place_tests {
    use super::fixtures::folder;
    use super::*;

    #[test]
    fn live_folders_sit_after_their_anchor() {
        let mut top = folder(FolderKind::PullRequests);
        top.after = Some(None);
        let mut after_a = folder(FolderKind::Documents);
        after_a.after = Some(Some("t:a".into()));
        let mut lost = folder(FolderKind::Documents);
        lost.after = Some(Some("t:gone".into()));
        let order = place_live(
            vec![("t:a".into(), "a"), ("t:b".into(), "b")],
            &[
                (top, "top"),
                (after_a, "after-a"),
                (lost, "lost"),
                (folder(FolderKind::Documents), "unset"),
            ],
        );
        assert_eq!(order, vec!["top", "a", "after-a", "b", "lost", "unset"]);
    }
}
