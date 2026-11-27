use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Value, json};

use super::documents::{map_bitbucket, map_confluence, map_drive, map_notion};
use super::github::{
    CheckTone, PrBadge, detail_nodes, listing_of, parse_rfc3339, pr_badge, pr_item, sectioned,
    summarize_checks, with_stacks,
};
use super::*;

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/browser/src/state/live/fixtures/"
);

fn fixture(name: &str) -> Option<Value> {
    let text = std::fs::read_to_string(format!("{FIXTURES}{name}")).ok()?;
    serde_json::from_str(&text).ok()
}

fn item(id: &str, source: LiveSourceId) -> LiveItem {
    LiveItem {
        id: id.into(),
        source,
        url: format!("https://x.test/{id}"),
        title: id.into(),
        subtitle: String::new(),
        icon: None,
        updated_at: 0,
        section: None,
        pr: None,
        doc: None,
    }
}

fn pr(id: &str, repo: &str, head: &str, base: &str, number: u64) -> LiveItem {
    LiveItem {
        pr: Some(PullRequestInfo {
            number,
            repo: repo.into(),
            author: "me".into(),
            author_avatar: None,
            draft: false,
            head_ref: head.into(),
            base_ref: base.into(),
            review: None,
            mergeable: Mergeable::Unknown,
            checks: Vec::new(),
            comments: 0,
            unresolved_threads: 0,
            additions: 0,
            deletions: 0,
            changed_files: 0,
            stack: None,
        }),
        ..item(id, LiveSourceId::Github)
    }
}

#[test]
fn saved_payload_round_trips_with_defaults() {
    let saved = json!({
        "folders": {"lf-1": {"id": "lf-1", "profileId": "default", "kind": "pullRequests", "name": "PRs", "sources": ["github"], "filters": {"authored": true, "reviewRequests": false}, "createdAt": 5}},
        "folderOrder": ["lf-1", "gone"],
        "calendar": {"countdownLead": 15},
        "dismissedNow": {"old": 1, "new": 9_999_999_999_999i64},
        "version": 1
    });
    let state = LiveState::from_saved(saved, 1000);
    assert_eq!(state.folder_order, vec!["lf-1".to_owned()]);
    let folder = &state.folders["lf-1"];
    assert!(folder.show_new_repos && folder.group_stacks && folder.show_completed);
    assert!(!folder.filters.review_requests);
    assert_eq!(state.calendar.countdown_lead, 15);
    assert!(state.calendar.show_preview);
    assert_eq!(state.dismissed_now.len(), 1);
    let back = state.saved();
    assert_eq!(back["version"], 2);
    assert_eq!(back["folders"]["lf-1"]["filters"]["reviewRequests"], false);
    assert!(back.get("status").is_none());
}

#[test]
fn real_profile_canonical_payload_loads() {
    let payload = json!({"accounts": {}, "calendar": {"alertCondition": "always", "alertLead": "1", "countdownLead": 60, "hiddenCalendarIds": [], "prompted": false, "showPreview": true, "showTimeToNext": true}, "completed": {}, "config": {"bitbucketUser": "", "confluenceEmail": "", "confluenceSite": "", "githubClientId": "", "googleClientId": ""}, "dismissedAlerts": [], "dismissedNow": {}, "expandedStacks": {}, "folderOrder": [], "folders": {}, "hidden": {}, "items": {}, "known": {}, "meetingGroups": {}, "repoHidden": {}, "unread": {}, "version": 1});
    let state = LiveState::from_saved(payload, 0);
    assert_eq!(state.calendar.alert_minutes(), Some(1));
    assert!(state.folders.is_empty());
}

#[test]
fn apply_fetch_marks_unread_after_the_first_fetch_and_completes_gone_items() {
    let mut s = LiveState::default();
    let f = s.create_folder(
        "lf-1".into(),
        "default",
        LiveFolderKind::PullRequests,
        None,
        0,
    );
    let none = HashMap::new();
    let sources = HashSet::from([LiveSourceId::Github]);
    s.apply_fetch(
        &f,
        vec![item("a", LiveSourceId::Github)],
        &none,
        10,
        &HashSet::new(),
        &sources,
    );
    assert!(s.unread[&f].is_empty());
    s.apply_fetch(
        &f,
        vec![
            item("a", LiveSourceId::Github),
            item("b", LiveSourceId::Github),
        ],
        &none,
        20,
        &HashSet::new(),
        &sources,
    );
    assert_eq!(s.unread[&f], vec!["b".to_owned()]);
    let gone = HashMap::from([("a".to_owned(), CompletionState::Merged)]);
    let leaving = s.apply_fetch(
        &f,
        vec![item("b", LiveSourceId::Github)],
        &gone,
        30,
        &HashSet::new(),
        &sources,
    );
    assert_eq!(leaving, vec!["a".to_owned()]);
    assert_eq!(s.items[&f].len(), 2);
    assert_eq!(s.completed[&f][0].state, CompletionState::Merged);
    s.finish_completing(&f, &leaving);
    assert_eq!(
        s.items[&f]
            .iter()
            .map(|i| i.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b"]
    );
    assert_eq!(s.status[&f].last_fetch, Some(30));
}

#[test]
fn hiding_unhiding_and_repo_filters() {
    let mut s = LiveState::default();
    let f = s.create_folder("lf".into(), "p", LiveFolderKind::PullRequests, None, 0);
    let a = pr("a", "acme/one", "x", "main", 1);
    let b = pr("b", "acme/two", "y", "main", 2);
    s.items.insert(f.clone(), vec![a.clone(), b]);
    s.hide_items(&f, vec![a]);
    assert_eq!(s.items[&f].len(), 1);
    s.unhide(&f);
    assert_eq!(s.items[&f].len(), 2);
    s.set_repo_hidden(&f, "github:acme/two", true);
    assert_eq!(s.items[&f].len(), 1);
    assert_eq!(s.repo_hidden[&f].len(), 1);
    assert_eq!(
        s.folder_repos(&f),
        vec!["github:acme/one".to_owned(), "github:acme/two".to_owned()]
    );
    s.set_show_new_repos(&f, false);
    s.hide_new_repos(&f, &[pr("c", "acme/three", "z", "main", 3)]);
    assert!(
        s.folders[&f]
            .hidden_repos
            .contains(&"github:acme/three".to_owned())
    );
    s.show_all_repos(&f);
    assert!(s.folders[&f].hidden_repos.is_empty());
}

#[test]
fn rows_page_sections_and_stacks() {
    let mut s = LiveState::default();
    let f = s.create_folder("lf".into(), "p", LiveFolderKind::PullRequests, None, 0);
    let mut items: Vec<LiveItem> = (0..10)
        .map(|i| pr(&format!("p{i}"), "acme/a", &format!("h{i}"), "main", i))
        .collect();
    items.push(LiveItem {
        section: Some(PullRequestSection::Review),
        ..pr("r", "acme/a", "rh", "main", 99)
    });
    let folder = s.folders[&f].clone();
    let rows = folder_rows(&folder, &items, &s.show_all, PAGE_SIZE);
    assert!(matches!(
        rows.get(8),
        Some(FolderRow::More { count: 2, .. })
    ));
    assert!(matches!(&rows[9], FolderRow::Header { title, .. } if title == "Review Requests"));
    s.show_all_in(&f, "authored");
    assert_eq!(
        folder_rows(&folder, &items, &s.show_all, PAGE_SIZE).len(),
        12
    );
    let stacked = with_stacks(vec![
        pr("base", "r/r", "b1", "main", 1),
        pr("top", "r/r", "b2", "b1", 2),
    ]);
    let stack = stacked[0]
        .pr
        .as_ref()
        .and_then(|p| p.stack.clone())
        .expect("stacked");
    assert_eq!((stack.position, stack.size), (1, 2));
    let rows = folder_rows(&folder, &stacked, &BTreeMap::new(), PAGE_SIZE);
    assert!(matches!(&rows[0], FolderRow::Stack { items, .. } if items.len() == 2));
}

#[test]
fn checks_and_badges() {
    let check = |state| PullRequestCheck {
        name: "ci".into(),
        state,
        url: None,
    };
    assert_eq!(
        summarize_checks(&[check(CheckState::Failure)]).map(|s| s.text),
        Some("1 check is failing".into())
    );
    assert_eq!(
        summarize_checks(&[check(CheckState::Queued)]).map(|s| s.text),
        Some("Checks are queued".into())
    );
    assert_eq!(
        summarize_checks(&[check(CheckState::Success), check(CheckState::Pending)]).map(|s| s.tone),
        Some(CheckTone::Pending)
    );
    let mut info = pr("x", "r", "h", "b", 1).pr.expect("pr");
    info.review = Some(ReviewState::Approved);
    assert_eq!(pr_badge(&info), Some(PrBadge::Approved));
    info.mergeable = Mergeable::Conflicting;
    assert_eq!(pr_badge(&info), Some(PrBadge::Conflict));
}

#[test]
fn github_fixture_maps_like_the_old_app() {
    let Some(github) = fixture("github.json") else {
        return;
    };
    let authored = json!({"data": {"search": {"nodes": github["data"]["authored"]["nodes"]}}});
    let review = json!({"data": {"search": {"nodes": github["data"]["review"]["nodes"]}}});
    let direct = json!({"data": {"search": {"nodes": github["data"]["direct"]["nodes"]}}});
    let listing = listing_of(&authored, &review, &direct);
    let sections = sectioned(&listing, true, true);
    assert!(!sections.is_empty());
    let raw = &github["data"]["authored"]["nodes"][0];
    let mapped = pr_item(raw, Some(PullRequestSection::Authored)).expect("a pr");
    assert_eq!(mapped.id, "github:PR_101");
    assert_eq!(mapped.subtitle, "acme/browser #101");
    assert!(mapped.updated_at > 0);
    let ids = vec!["PR_101".to_owned()];
    assert_eq!(
        detail_nodes(&ids, &json!({"data": {"nodes": [raw]}})).map(|n| n.len()),
        Ok(1)
    );
    assert!(detail_nodes(&ids, &json!({"data": {"nodes": [null]}})).is_err());
}

#[test]
fn document_fixtures_map() {
    if let Some(notion) = fixture("notion-search.json") {
        let users = fixture("notion-users.json");
        let items = map_notion(&notion, users.as_ref(), Some("Acme"));
        assert_eq!(items[0].title, "Q4 Roadmap");
        assert_eq!(items[0].icon.as_deref(), Some("🗺️"));
        assert_eq!(items[0].subtitle, "Acme");
    }
    if let Some(drive) = fixture("drive-files.json") {
        let items = map_drive(&drive);
        assert_eq!(items[0].subtitle, "Document");
        assert_eq!(
            items[0].doc.as_ref().and_then(|d| d.edited_by.as_deref()),
            Some("Mira Chen")
        );
    }
    if let Some(confluence) = fixture("confluence-search.json") {
        let items = map_confluence(&confluence, "https://acme.atlassian.net");
        assert_eq!(items[0].subtitle, "Engineering");
        assert!(
            items[0]
                .url
                .starts_with("https://acme.atlassian.net/wiki/spaces/ENG")
        );
    }
    let bb = map_bitbucket(&json!({"id": 7, "title": "Fix", "updated_on": "2026-01-01T00:00:00Z", "comment_count": 2, "author": {"display_name": "Ann"}, "source": {"branch": {"name": "fix"}}, "destination": {"branch": {"name": "main"}, "repository": {"full_name": "acme/app"}}, "links": {"html": {"href": "https://bitbucket.org/acme/app/pull-requests/7"}}, "participants": [{"role": "REVIEWER", "state": "approved"}]}), None).expect("bitbucket");
    assert_eq!(bb.id, "bitbucket:acme/app#7");
    assert_eq!(bb.pr.and_then(|p| p.review), Some(ReviewState::Approved));
}

#[test]
fn status_and_error_copy() {
    let mut s = LiveState::default();
    let f = s.create_folder("lf".into(), "p", LiveFolderKind::Documents, None, 0);
    assert_eq!(s.status_text(&f, 0, None), "Loading…");
    s.set_status(&f, |st| {
        st.state = FolderState::Idle;
        st.last_fetch = Some(0);
    });
    assert_eq!(s.status_text(&f, 30_000, None), "Updated just now");
    assert_eq!(s.status_text(&f, 5 * 60_000, None), "Updated 5 min ago");
    assert_eq!(s.status_text(&f, 125 * 60_000, None), "Updated 2 hr ago");
    assert_eq!(
        error_text(
            LiveErrorKind::RateLimited,
            LiveSourceId::Github,
            0,
            Some(60_000)
        ),
        "GitHub rate limit reached. Updating again in a minute."
    );
    assert_eq!(
        error_text(LiveErrorKind::NotConfigured, LiveSourceId::Gdrive, 0, None),
        "Connect Google Drive in Settings"
    );
    assert_eq!(
        parse_rfc3339("2026-09-25T09:00:00Z"),
        Some(1_790_326_800_000)
    );
    assert_eq!(
        parse_rfc3339("2026-09-25T11:00:00+02:00"),
        Some(1_790_326_800_000)
    );
}

#[test]
fn removing_a_folder_drops_its_state() {
    let mut s = LiveState::default();
    let f = s.create_folder("lf".into(), "p", LiveFolderKind::PullRequests, None, 0);
    s.mark_unread(&f, "x");
    s.toggle_stack("stack:a");
    s.remove_folder(&f);
    assert!(s.folders.is_empty() && s.unread.is_empty() && s.folder_order.is_empty());
    assert!(!s.arrange_folders(&[]));
}

#[test]
fn folder_after_keeps_missing_null_and_string_apart() {
    let base = json!({"id": "f", "profileId": "p", "kind": "documents", "name": "D"});
    let read = |extra: Value| -> LiveFolder {
        let mut v = base.clone();
        if let (Some(obj), Value::Object(more)) = (v.as_object_mut(), extra) {
            obj.extend(more);
        }
        serde_json::from_value(v).expect("folder")
    };
    let missing = read(json!({}));
    let top = read(json!({"after": null}));
    let after = read(json!({"after": "lf-2"}));
    assert_eq!(missing.after, None);
    assert_eq!(top.after, Some(None));
    assert_eq!(after.after, Some(Some("lf-2".to_owned())));
    let written = |f: &LiveFolder| serde_json::to_value(f).expect("json");
    assert!(written(&missing).get("after").is_none());
    assert_eq!(written(&top)["after"], Value::Null);
    assert_eq!(written(&after)["after"], "lf-2");
    let round: LiveFolder = serde_json::from_value(written(&top)).expect("round");
    assert_eq!(round.after, Some(None));
}
