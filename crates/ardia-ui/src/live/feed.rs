use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

use ardia_state::live::{
    CheckState as StateCheck, CompletionState, FolderState, LiveCommand as StateCommand,
    LiveErrorKind, LiveFolder, LiveFolderKind, LiveItem, LiveSourceId, LiveState,
    Mergeable as StateMergeable, PullRequestSection, ReviewState,
};
use ardia_state::{ProfileId, WindowId};

use crate::host::UiHost;
use crate::msg::Msg;
use crate::settings::rows::Pane;
use crate::sidebar::completed_footer::CompletedRow;
use crate::sidebar::live_folders::rows::{
    CheckState, Completion, ErrorKind, FetchState, Folder, FolderData, FolderKind, Item,
    LiveSource, Mergeable, PullRequest, Review, Section, Stack, Status,
};
use crate::sidebar::live_folders::{LiveCommand, LiveFeed, LiveSink, publish};

pub fn source(id: LiveSourceId) -> LiveSource {
    match id {
        LiveSourceId::Github => LiveSource::Github,
        LiveSourceId::Bitbucket => LiveSource::Bitbucket,
        LiveSourceId::Notion => LiveSource::Notion,
        LiveSourceId::Confluence => LiveSource::Confluence,
        LiveSourceId::Gdrive => LiveSource::Gdrive,
    }
}

fn section(section: Option<PullRequestSection>, kind: LiveFolderKind) -> Option<Section> {
    match (kind, section) {
        (LiveFolderKind::Documents, _) => Some(Section::Documents),
        (_, Some(PullRequestSection::Review)) => Some(Section::Review),
        (_, Some(PullRequestSection::Team)) => Some(Section::Team),
        _ => Some(Section::Authored),
    }
}

fn completion(state: CompletionState) -> Completion {
    match state {
        CompletionState::Merged => Completion::Merged,
        CompletionState::Closed => Completion::Closed,
        CompletionState::Reviewed => Completion::Reviewed,
    }
}

pub fn item(it: &LiveItem, kind: LiveFolderKind) -> Item {
    Item {
        id: it.id.clone(),
        source: source(it.source),
        url: it.url.clone(),
        title: it.title.clone(),
        icon: it.icon.clone(),
        section: section(it.section, kind),
        pr: it.pr.as_ref().map(|pr| PullRequest {
            repo: pr.repo.clone(),
            draft: pr.draft,
            review: pr.review.map(|r| match r {
                ReviewState::Approved => Review::Approved,
                ReviewState::ChangesRequested => Review::ChangesRequested,
                ReviewState::Required => Review::Required,
            }),
            mergeable: match pr.mergeable {
                StateMergeable::Mergeable => Mergeable::Mergeable,
                StateMergeable::Conflicting => Mergeable::Conflicting,
                StateMergeable::Unknown => Mergeable::Unknown,
            },
            checks: pr
                .checks
                .iter()
                .map(|c| match c.state {
                    StateCheck::Success => CheckState::Success,
                    StateCheck::Failure => CheckState::Failure,
                    StateCheck::Pending => CheckState::Pending,
                    StateCheck::Queued => CheckState::Queued,
                    StateCheck::Neutral => CheckState::Neutral,
                })
                .collect(),
            stack: pr.stack.as_ref().map(|s| Stack {
                id: s.id.clone(),
                position: s.position,
                size: s.size,
            }),
        }),
    }
}

pub fn folder(f: &LiveFolder) -> Folder {
    Folder {
        id: f.id.clone(),
        profile_id: ProfileId::new(&f.profile_id),
        after: f.after.clone(),
        name: f.name.clone(),
        icon: f.icon.clone(),
        color: f.color.clone().and_then(|c| serde_json::from_value(c).ok()),
        kind: match f.kind {
            LiveFolderKind::PullRequests => FolderKind::PullRequests,
            LiveFolderKind::Documents => FolderKind::Documents,
        },
        sources: f.sources.iter().map(|s| source(*s)).collect(),
        collapsed: f.collapsed,
        group_stacks: f.group_stacks,
    }
}

pub fn folder_data(live: &LiveState, f: &LiveFolder, paused_minutes: Option<i64>) -> FolderData {
    let items: Vec<Item> = live
        .items
        .get(&f.id)
        .into_iter()
        .flatten()
        .map(|it| item(it, f.kind))
        .collect();
    let completing: HashSet<&String> = live.completing.get(&f.id).into_iter().flatten().collect();
    let completed_by_id: HashMap<&str, CompletionState> = live
        .completed
        .get(&f.id)
        .into_iter()
        .flatten()
        .map(|c| (c.item.id.as_str(), c.state))
        .collect();
    let completed: Vec<CompletedRow> = if f.show_completed {
        live.completed
            .get(&f.id)
            .into_iter()
            .flatten()
            .filter(|c| !completing.contains(&c.item.id))
            .map(|c| CompletedRow {
                item: c.item.id.clone(),
                title: c.item.title.clone(),
                state: completion(c.state),
                at: c.at,
            })
            .collect()
    } else {
        Vec::new()
    };
    let status = live.status.get(&f.id).map(|s| Status {
        state: match s.state {
            FolderState::Initializing => FetchState::Initializing,
            FolderState::Idle => FetchState::Idle,
            FolderState::Updating => FetchState::Updating,
            FolderState::Error => FetchState::Error,
        },
        last_fetch: s.last_fetch,
        error: s.error.as_ref().map(|e| {
            (
                match e.kind {
                    LiveErrorKind::SignedOut => ErrorKind::SignedOut,
                    LiveErrorKind::Sso => ErrorKind::Sso,
                    LiveErrorKind::TokenBlocked => ErrorKind::TokenBlocked,
                    LiveErrorKind::RateLimited => ErrorKind::RateLimited {
                        minutes_left: paused_minutes,
                    },
                    LiveErrorKind::Network => ErrorKind::Network,
                    LiveErrorKind::NotConfigured => ErrorKind::NotConfigured,
                    LiveErrorKind::Other => ErrorKind::Other,
                },
                source(e.source),
            )
        }),
    });
    FolderData {
        items,
        unread: live
            .unread
            .get(&f.id)
            .into_iter()
            .flatten()
            .cloned()
            .collect(),
        hidden: live
            .hidden
            .get(&f.id)
            .into_iter()
            .flatten()
            .map(|it| it.id.clone())
            .collect(),
        show_all: [
            Section::Authored,
            Section::Review,
            Section::Team,
            Section::Documents,
        ]
        .into_iter()
        .filter(|s| {
            live.show_all
                .get(&ardia_state::live::show_all_key(&f.id, s.key()))
                .copied()
                .unwrap_or(false)
        })
        .collect(),
        collapsed_stacks: live
            .expanded_stacks
            .iter()
            .filter(|(_, open)| !**open)
            .map(|(s, _)| s.clone())
            .collect(),
        completing: live
            .completing
            .get(&f.id)
            .into_iter()
            .flatten()
            .filter_map(|id| {
                completed_by_id
                    .get(id.as_str())
                    .map(|s| (id.clone(), completion(*s)))
            })
            .collect(),
        completed_shown: completed.len(),
        completed,
        status,
    }
}

pub fn command(window: &WindowId, command: LiveCommand) -> Option<Msg> {
    Some(match command {
        LiveCommand::ToggleFolder { folder, collapsed } => {
            Msg::Live(StateCommand::SetCollapsed { folder, collapsed })
        }
        LiveCommand::Refresh { folder } => Msg::Live(StateCommand::Refresh {
            folder,
            manual: true,
        }),
        LiveCommand::FixError { .. } => Msg::SettingsAt(Pane::General),
        LiveCommand::ShowAll { folder, section } => Msg::Live(StateCommand::ShowAllIn {
            folder,
            section: section.key().to_owned(),
        }),
        LiveCommand::ToggleStack { stack } => Msg::Live(StateCommand::ToggleStack { stack }),
        LiveCommand::HideStack { folder, stack } => {
            ardia_telemetry::counts::count("live_stack_hides");
            Msg::Live(StateCommand::HideStack { folder, stack })
        }
        LiveCommand::HideItems { folder, items } => {
            ardia_telemetry::counts::count("live_row_hides");
            Msg::Live(StateCommand::HideItems { folder, items })
        }
        LiveCommand::OpenItem {
            folder,
            item,
            background,
        } => Msg::Live(StateCommand::OpenItem {
            window: window.clone(),
            folder,
            item,
            background,
        }),
        LiveCommand::FolderMenu { folder, at } => {
            Msg::Menu(Some((crate::msg::MenuTarget::LiveFolder(folder), at)))
        }
        LiveCommand::ItemMenu {
            folder,
            item,
            tab,
            at,
        } => Msg::Menu(Some((
            crate::msg::MenuTarget::LiveItem { folder, item, tab },
            at,
        ))),
    })
}

thread_local! {
    static PUBLISHED: std::cell::RefCell<Option<(Arc<LiveState>, WindowId)>> =
        const { std::cell::RefCell::new(None) };
}

pub fn publish_for(host: &Arc<dyn UiHost>, window: &WindowId, emit: &crate::msg::Emit) {
    let Some(live) = host.live() else {
        return;
    };
    let unchanged = PUBLISHED.with(|cell| {
        cell.borrow()
            .as_ref()
            .is_some_and(|(seen, shown)| Arc::ptr_eq(seen, &live) && shown == window)
    });
    if unchanged {
        return;
    }
    PUBLISHED.with(|cell| *cell.borrow_mut() = Some((Arc::clone(&live), window.clone())));
    let folders = live
        .folder_order
        .iter()
        .filter_map(|id| live.folders.get(id))
        .map(|f| (folder(f), folder_data(&live, f, None)))
        .collect();
    let window = window.clone();
    let emit = emit.clone();
    let sink: LiveSink = Rc::new(move |cmd, w, cx| {
        if let Some(msg) = command(&window, cmd) {
            emit.send(msg, w, cx);
        }
    });
    publish(LiveFeed {
        folders,
        sink: Some(sink),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::live::LiveFolderKind;
    use std::collections::HashMap;

    #[test]
    fn state_maps_into_the_sidebar_feed() {
        let mut live = LiveState::default();
        let id = live.create_folder(
            "lf".into(),
            "default",
            LiveFolderKind::PullRequests,
            None,
            0,
        );
        let a = LiveItem {
            id: "a".into(),
            source: LiveSourceId::Github,
            url: "https://x".into(),
            title: "A".into(),
            subtitle: String::new(),
            icon: None,
            updated_at: 0,
            section: Some(PullRequestSection::Review),
            pr: None,
            doc: None,
        };
        live.apply_fetch(
            &id,
            vec![a],
            &HashMap::new(),
            1,
            &HashSet::new(),
            &HashSet::new(),
        );
        let gone = HashMap::from([("a".to_owned(), CompletionState::Merged)]);
        live.apply_fetch(&id, vec![], &gone, 2, &HashSet::new(), &HashSet::new());
        let f = live.folders[&id].clone();
        let data = folder_data(&live, &f, None);
        assert_eq!(data.items[0].section, Some(Section::Review));
        assert_eq!(data.completing.get("a"), Some(&Completion::Merged));
        live.finish_completing(&id, &["a".to_owned()]);
        let data = folder_data(&live, &f, None);
        assert_eq!(data.completed.len(), 1);
        assert_eq!(data.completed[0].state, Completion::Merged);
        assert_eq!(folder(&f).name, "Pull Requests");
        let w = WindowId::new("w");
        assert!(matches!(
            command(&w, LiveCommand::Refresh { folder: id.clone() }),
            Some(Msg::Live(StateCommand::Refresh { manual: true, .. }))
        ));
        assert!(
            command(
                &w,
                LiveCommand::FolderMenu {
                    folder: id,
                    at: gpui::point(gpui::px(0.), gpui::px(0.))
                }
            )
            .is_some_and(|m| matches!(m, Msg::Menu(Some(_))))
        );
    }
}
