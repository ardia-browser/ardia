use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::{
    CheckState, LiveError, LiveErrorKind, LiveItem, LiveSourceId, Mergeable, PullRequestCheck,
    PullRequestInfo, PullRequestSection, ReviewState, StackInfo,
};

const PR_FIELDS: &str = "
  ... on PullRequest {
    id number title url isDraft updatedAt createdAt
    headRefName baseRefName mergeable reviewDecision
    additions deletions changedFiles
    repository { nameWithOwner }
    author { login avatarUrl(size: 64) }
    comments { totalCount }
    reviewThreads(first: 50) { nodes { isResolved } }
    commits(last: 1) {
      nodes { commit { statusCheckRollup { state contexts(first: 60) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } }
    }
  }";

const CHANGE_FIELDS: &str = "id updatedAt headRefOid mergeable commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";
const RATE_LIMIT: &str = "rateLimit { limit remaining resetAt }";

pub const DETAILS_PAGE: usize = 10;
pub const SEARCH_AUTHORED: &str = "is:pr is:open author:@me archived:false sort:updated-desc";
pub const SEARCH_REVIEW: &str =
    "is:pr is:open review-requested:@me archived:false sort:updated-desc";
pub const SEARCH_DIRECT: &str = "is:pr is:open user-review-requested:@me archived:false";
pub const STATE_QUERY: &str = "query LiveFolderGone($ids: [ID!]!) {\n  nodes(ids: $ids) { ... on PullRequest { id state } }\n}";
pub const VIEWER_QUERY: &str = "query { viewer { login name avatarUrl(size: 64) } }";

pub fn search_query() -> String {
    format!(
        "query LiveFolderSearch($q: String!) {{ {RATE_LIMIT} search(query: $q, type: ISSUE, first: 50) {{ nodes {{ ... on PullRequest {{ {CHANGE_FIELDS} }} }} }} }}"
    )
}

pub fn direct_query() -> String {
    format!(
        "query LiveFolderDirect($q: String!) {{ {RATE_LIMIT} search(query: $q, type: ISSUE, first: 50) {{ nodes {{ ... on PullRequest {{ id }} }} }} }}"
    )
}

pub fn details_query() -> String {
    format!(
        "query LiveFolderDetails($ids: [ID!]!) {{ {RATE_LIMIT} nodes(ids: $ids) {{ {PR_FIELDS} ... on PullRequest {{ state }} }} }}"
    )
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

pub fn parse_time(text: &str) -> i64 {
    parse_rfc3339(text).unwrap_or(0)
}

pub fn parse_rfc3339(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, rest) = text.split_once(['T', ' '])?;
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    let (clock, offset_minutes) =
        if let Some(clock) = rest.strip_suffix('Z').or_else(|| rest.strip_suffix('z')) {
            (clock, 0)
        } else if let Some(at) = rest.rfind(['+', '-']).filter(|at| *at >= 5) {
            let (clock, zone) = rest.split_at(at);
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let mut z = zone[1..].split(':');
            let hours: i64 = z.next()?.parse().ok()?;
            let minutes: i64 = z.next().unwrap_or("0").parse().ok()?;
            (clock, sign * (hours * 60 + minutes))
        } else {
            (rest, 0)
        };
    let mut c = clock.split(':');
    let hour: i64 = c.next()?.parse().ok()?;
    let minute: i64 = c.next()?.parse().ok()?;
    let seconds: f64 = c.next().unwrap_or("0").parse().ok()?;
    let days = days_from_civil(year, month, day);
    let ms = ((days * 24 + hour) * 60 + minute - offset_minutes) * 60_000
        + (seconds * 1000.0).round() as i64;
    Some(ms)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn check_state(check: &Value) -> CheckState {
    if text(check, "__typename") == Some("StatusContext") {
        return match text(check, "state") {
            Some("SUCCESS") => CheckState::Success,
            Some("FAILURE" | "ERROR") => CheckState::Failure,
            _ => CheckState::Pending,
        };
    }
    let status = text(check, "status").unwrap_or_default();
    if status != "COMPLETED" {
        return if status == "IN_PROGRESS" {
            CheckState::Pending
        } else {
            CheckState::Queued
        };
    }
    match text(check, "conclusion") {
        Some("SUCCESS") => CheckState::Success,
        Some("NEUTRAL" | "SKIPPED" | "STALE") => CheckState::Neutral,
        _ => CheckState::Failure,
    }
}

pub fn pr_item(raw: &Value, section: Option<PullRequestSection>) -> Option<LiveItem> {
    let id = text(raw, "id")?;
    let repo = raw
        .pointer("/repository/nameWithOwner")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let num = number(raw, "number");
    let rollup = raw.pointer("/commits/nodes/0/commit/statusCheckRollup");
    let checks = rollup
        .and_then(|r| r.pointer("/contexts/nodes"))
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .map(|c| {
                    let run = text(c, "__typename") == Some("CheckRun");
                    PullRequestCheck {
                        name: text(c, if run { "name" } else { "context" })
                            .unwrap_or_default()
                            .to_owned(),
                        state: check_state(c),
                        url: text(c, if run { "detailsUrl" } else { "targetUrl" })
                            .map(str::to_owned),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let pr = PullRequestInfo {
        number: num,
        repo: repo.to_owned(),
        author: raw
            .pointer("/author/login")
            .and_then(Value::as_str)
            .unwrap_or("ghost")
            .to_owned(),
        author_avatar: raw
            .pointer("/author/avatarUrl")
            .and_then(Value::as_str)
            .map(str::to_owned),
        draft: raw.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        head_ref: text(raw, "headRefName").unwrap_or_default().to_owned(),
        base_ref: text(raw, "baseRefName").unwrap_or_default().to_owned(),
        review: match text(raw, "reviewDecision") {
            Some("APPROVED") => Some(ReviewState::Approved),
            Some("CHANGES_REQUESTED") => Some(ReviewState::ChangesRequested),
            Some("REVIEW_REQUIRED") => Some(ReviewState::Required),
            _ => None,
        },
        mergeable: match text(raw, "mergeable") {
            Some("CONFLICTING") => Mergeable::Conflicting,
            Some("MERGEABLE") => Mergeable::Mergeable,
            _ => Mergeable::Unknown,
        },
        checks,
        comments: raw
            .pointer("/comments/totalCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        unresolved_threads: raw
            .pointer("/reviewThreads/nodes")
            .and_then(Value::as_array)
            .map_or(0, |n| {
                n.iter()
                    .filter(|t| t.get("isResolved") == Some(&Value::Bool(false)))
                    .count() as u64
            }),
        additions: number(raw, "additions"),
        deletions: number(raw, "deletions"),
        changed_files: number(raw, "changedFiles"),
        stack: None,
    };
    Some(LiveItem {
        id: format!("github:{id}"),
        source: LiveSourceId::Github,
        url: text(raw, "url").unwrap_or_default().to_owned(),
        title: text(raw, "title").unwrap_or_default().to_owned(),
        subtitle: format!("{repo} #{num}"),
        icon: None,
        updated_at: parse_time(text(raw, "updatedAt").unwrap_or_default()),
        section,
        pr: Some(pr),
        doc: None,
    })
}

pub fn change_key(listed: &Value) -> Option<String> {
    let updated = text(listed, "updatedAt")?;
    Some(
        serde_json::json!([
            updated,
            listed.get("headRefOid").cloned().unwrap_or(Value::Null),
            listed.get("mergeable").cloned().unwrap_or(Value::Null),
            listed
                .pointer("/commits/nodes/0/commit/statusCheckRollup/state")
                .cloned()
                .unwrap_or(Value::Null),
        ])
        .to_string(),
    )
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Listing {
    pub authored: Vec<String>,
    pub review: Vec<String>,
    pub direct: HashSet<String>,
    pub keys: HashMap<String, Option<String>>,
    pub blocked: Option<LiveError>,
}

fn ids_of(nodes: &[Value]) -> Vec<String> {
    nodes
        .iter()
        .filter_map(|n| text(n, "id").filter(|id| !id.is_empty()).map(str::to_owned))
        .collect()
}

fn search_nodes(response: &Value) -> Vec<Value> {
    response
        .pointer("/data/search/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub fn listing_of(authored: &Value, review: &Value, direct: &Value) -> Listing {
    let (a, r, d) = (
        search_nodes(authored),
        search_nodes(review),
        search_nodes(direct),
    );
    let mut keys = HashMap::new();
    for n in a.iter().chain(r.iter()) {
        if let Some(id) = text(n, "id").filter(|id| !id.is_empty()) {
            keys.entry(id.to_owned()).or_insert_with(|| change_key(n));
        }
    }
    let blocked: Vec<Value> = [authored, review, direct]
        .iter()
        .flat_map(|res| blocked_nodes(res))
        .collect();
    Listing {
        authored: ids_of(&a),
        review: ids_of(&r),
        direct: ids_of(&d).into_iter().collect(),
        keys,
        blocked: blocked_error(&blocked),
    }
}

pub fn blocked_nodes(response: &Value) -> Vec<Value> {
    response
        .get("errors")
        .and_then(Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .filter(|e| {
                    let path = e.get("path").and_then(Value::as_array);
                    text(e, "type") == Some("FORBIDDEN")
                        && path.is_some_and(|p| {
                            p.len() == 3 && p.get(1).and_then(Value::as_str) == Some("nodes")
                        })
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

pub fn blocked_link(message: &str) -> Option<String> {
    let start = message.find("https://github.com/")?;
    let rest = &message[start + "https://github.com/".len()..];
    if !(rest.starts_with("settings") || rest.starts_with("orgs")) {
        return None;
    }
    let end = message[start..]
        .find(|c: char| !(c.is_ascii_alphanumeric() || "_./-:".contains(c)))
        .map_or(message.len(), |e| start + e);
    Some(message[start..end].trim_end_matches(['.', ',']).to_owned())
}

pub fn blocked_error(blocked: &[Value]) -> Option<LiveError> {
    let first = blocked.first()?;
    let message = |e: &Value| text(e, "message").unwrap_or_default().to_owned();
    let with_link = |base: &str, provider: &str| match blocked_link(provider) {
        Some(link) => format!("{base}: {link}"),
        None => base.to_owned(),
    };
    let sso = blocked.iter().find(|e| {
        let m = message(e).to_lowercase();
        m.contains("saml") || m.contains("single sign-on")
    });
    Some(match sso {
        Some(e) => LiveError::new(
            LiveErrorKind::Sso,
            with_link(
                "An organization needs single sign-on for this token",
                &message(e),
            ),
        ),
        None => LiveError::new(
            LiveErrorKind::TokenBlocked,
            with_link("This token can't read some pull requests", &message(first)),
        ),
    })
}

pub fn sectioned(
    listing: &Listing,
    authored: bool,
    review_requests: bool,
) -> Vec<(String, PullRequestSection)> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if authored {
        for id in &listing.authored {
            if seen.insert(id.clone()) {
                out.push((id.clone(), PullRequestSection::Authored));
            }
        }
    }
    if review_requests {
        for id in &listing.review {
            if seen.insert(id.clone()) {
                let section = if listing.direct.contains(id) {
                    PullRequestSection::Review
                } else {
                    PullRequestSection::Team
                };
                out.push((id.clone(), section));
            }
        }
    }
    out
}

pub fn detail_nodes(ids: &[String], response: &Value) -> Result<Vec<Value>, LiveError> {
    let errors = response
        .get("errors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if errors
        .iter()
        .any(|e| text(e, "type") == Some("RATE_LIMITED"))
    {
        return Err(LiveError::new(
            LiveErrorKind::RateLimited,
            "Rate Limit Exceeded",
        ));
    }
    let fail = || {
        LiveError::new(
            LiveErrorKind::Other,
            "GitHub couldn't read the pull request details",
        )
    };
    let nodes = response
        .pointer("/data/nodes")
        .and_then(Value::as_array)
        .ok_or_else(fail)?;
    if nodes.len() != ids.len() {
        return Err(fail());
    }
    let mut out = Vec::new();
    for (i, node) in nodes.iter().enumerate() {
        if !node.is_null() {
            out.push(node.clone());
            continue;
        }
        let error = errors.iter().find(|e| {
            let path = e.get("path").and_then(Value::as_array);
            path.is_some_and(|p| {
                p.first().and_then(Value::as_str) == Some("nodes")
                    && p.get(1).and_then(Value::as_u64) == Some(i as u64)
            })
        });
        match error.and_then(|e| text(e, "type")) {
            Some("NOT_FOUND" | "FORBIDDEN") => {}
            _ => return Err(fail()),
        }
    }
    Ok(out)
}

pub fn graphql_rate_limited(response: &Value, remaining_header: Option<&str>) -> bool {
    let Some(errors) = response
        .get("errors")
        .and_then(Value::as_array)
        .filter(|e| !e.is_empty())
    else {
        return false;
    };
    remaining_header == Some("0")
        || errors.iter().any(|e| {
            text(e, "type") == Some("RATE_LIMITED")
                || text(e, "message").is_some_and(|m| {
                    let m = m.to_lowercase();
                    m.contains("rate limit exceeded") || m.contains("rate limit already exceeded")
                })
        })
}

pub fn names_rate_limit(body: &str) -> bool {
    let b = body.to_lowercase();
    b.contains("rate limit") || b.contains("abuse detection mechanism")
}

pub fn with_stacks(items: Vec<LiveItem>) -> Vec<LiveItem> {
    let key = |repo: &str, branch: &str| format!("{repo}:{branch}");
    let mut by_head: HashMap<String, usize> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        if let Some(pr) = &it.pr {
            by_head.insert(key(&pr.repo, &pr.head_ref), i);
        }
    }
    let parent = |i: usize| -> Option<usize> {
        let pr = items[i].pr.as_ref()?;
        by_head.get(&key(&pr.repo, &pr.base_ref)).copied()
    };
    let bottom_of = |i: usize| {
        let mut cur = i;
        let mut visited = HashSet::new();
        while let Some(p) = parent(cur) {
            if visited.contains(&items[p].id) {
                break;
            }
            visited.insert(items[cur].id.clone());
            cur = p;
        }
        cur
    };
    let mut stacks: Vec<(usize, Vec<usize>)> = Vec::new();
    for (i, it) in items.iter().enumerate() {
        if it.pr.is_none() {
            continue;
        }
        let bottom = bottom_of(i);
        match stacks.iter_mut().find(|(b, _)| *b == bottom) {
            Some((_, members)) => members.push(i),
            None => stacks.push((bottom, vec![i])),
        }
    }
    let mut info: HashMap<usize, StackInfo> = HashMap::new();
    for (bottom, members) in stacks {
        if members.len() < 2 {
            continue;
        }
        let depth = |i: usize| {
            let mut d = 1;
            let mut p = parent(i);
            while let Some(at) = p {
                if d > members.len() {
                    break;
                }
                d += 1;
                p = parent(at);
            }
            d
        };
        let mut ordered = members.clone();
        ordered.sort_by(|a, b| {
            depth(*a).cmp(&depth(*b)).then(
                items[*a]
                    .pr
                    .as_ref()
                    .map_or(0, |p| p.number)
                    .cmp(&items[*b].pr.as_ref().map_or(0, |p| p.number)),
            )
        });
        let size = ordered.len() as u32;
        for (position, i) in ordered.into_iter().enumerate() {
            info.insert(
                i,
                StackInfo {
                    id: format!("stack:{}", items[bottom].id),
                    position: position as u32 + 1,
                    size,
                },
            );
        }
    }
    items
        .into_iter()
        .enumerate()
        .map(|(i, mut it)| {
            if let (Some(stack), Some(pr)) = (info.remove(&i), it.pr.as_mut()) {
                pr.stack = Some(stack);
            }
            it
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckTone {
    Success,
    Failure,
    Pending,
    Neutral,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckSummary {
    pub text: String,
    pub tone: CheckTone,
    pub success: usize,
    pub failure: usize,
    pub pending: usize,
}

pub fn summarize_checks(checks: &[PullRequestCheck]) -> Option<CheckSummary> {
    if checks.is_empty() {
        return None;
    }
    let failure = checks
        .iter()
        .filter(|c| c.state == CheckState::Failure)
        .count();
    let pending = checks
        .iter()
        .filter(|c| matches!(c.state, CheckState::Pending | CheckState::Queued))
        .count();
    let queued = checks
        .iter()
        .filter(|c| c.state == CheckState::Queued)
        .count();
    let success = checks.len() - failure - pending;
    let summary = |text: String, tone| CheckSummary {
        text,
        tone,
        success,
        failure,
        pending,
    };
    if failure > 0 {
        return Some(summary(
            if failure == 1 {
                "1 check is failing".into()
            } else {
                format!("{failure} checks are failing")
            },
            CheckTone::Failure,
        ));
    }
    if queued > 0 && queued == pending && !checks.iter().any(|c| c.state == CheckState::Success) {
        return Some(summary("Checks are queued".into(), CheckTone::Pending));
    }
    if pending > 0 {
        return Some(summary(
            "Some checks haven't completed yet".into(),
            CheckTone::Pending,
        ));
    }
    Some(summary("All checks have passed".into(), CheckTone::Success))
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

pub fn pr_badge(pr: &PullRequestInfo) -> Option<PrBadge> {
    if pr.mergeable == Mergeable::Conflicting {
        return Some(PrBadge::Conflict);
    }
    let summary = summarize_checks(&pr.checks);
    let tone = summary.as_ref().map(|s| s.tone);
    if tone == Some(CheckTone::Failure) {
        return Some(PrBadge::Failing);
    }
    if pr.review == Some(ReviewState::ChangesRequested) {
        return Some(PrBadge::ChangesRequested);
    }
    if tone == Some(CheckTone::Pending) {
        return Some(PrBadge::Pending);
    }
    if pr.review == Some(ReviewState::Approved) {
        return Some(PrBadge::Approved);
    }
    if tone == Some(CheckTone::Success) {
        return Some(PrBadge::Passed);
    }
    None
}
