use ardia_state::ProfileId;
use ardia_state::live::{LiveAccount, LiveCommand, LiveFolder, LiveFolderKind, LiveSourceId};
use gpui::{AnyElement, IntoElement, ParentElement, SharedString, Styled, div, prelude::*};

use crate::primitives::controls::{ButtonKind, PushButton, Toggle};
use crate::scale::px;
use crate::settings::SettingsWindowView;
use crate::settings::panes::Block;

use super::parts::{RowSpec, block, command, group, section_header};

pub const ACCOUNTS: [LiveSourceId; 5] = [
    LiveSourceId::Github,
    LiveSourceId::Bitbucket,
    LiveSourceId::Notion,
    LiveSourceId::Confluence,
    LiveSourceId::Gdrive,
];

pub const PR_OPTIONS: [(&str, &str, &str); 2] = [
    (
        "groupStacks",
        "Group stacked pull requests",
        "Pull requests based on each other's branches sit together under one row.",
    ),
    (
        "showCompleted",
        "Show completed pull requests",
        "Merged, closed and reviewed pull requests stay listed for a day under Completed.",
    ),
];

pub fn source_of(key: &str) -> Option<LiveSourceId> {
    ACCOUNTS.into_iter().find(|source| source.key() == key)
}

pub fn connected_as(source: LiveSourceId, account: &LiveAccount) -> String {
    match account.name.as_deref() {
        Some(name) if !name.is_empty() && name != account.login => match source {
            LiveSourceId::Github | LiveSourceId::Gdrive => format!("{name} ({})", account.login),
            _ => name.to_owned(),
        },
        _ => account.login.clone(),
    }
}

pub fn folder_line(view: &SettingsWindowView, folder: &LiveFolder) -> String {
    let profile = view
        .state
        .profile(&folder.profile_id)
        .map_or_else(|| "Profile".to_owned(), |p| p.name.clone());
    let sources: Vec<&str> = folder.sources.iter().map(|s| s.name()).collect();
    format!(
        "{profile} \u{b7} {} \u{b7} {}",
        sources.join(", "),
        view.host.live_status_text(&folder.id)
    )
}

pub fn refresh(view: &SettingsWindowView, folder: &str) {
    view.host.live_command(LiveCommand::Refresh {
        folder: folder.to_owned(),
        manual: true,
    });
}

pub fn delete(view: &SettingsWindowView, folder: &str) {
    view.host.live_command(LiveCommand::RemoveFolder {
        folder: folder.to_owned(),
    });
}

pub fn set_option(view: &SettingsWindowView, argument: &str) {
    let mut parts = argument.rsplitn(3, '=');
    let (Some(on), Some(option), Some(folder)) = (parts.next(), parts.next(), parts.next()) else {
        return;
    };
    let on = on == "true";
    let (group_stacks, show_completed) = match option {
        "groupStacks" => (Some(on), None),
        "showCompleted" => (None, Some(on)),
        _ => return,
    };
    view.host.live_command(LiveCommand::SetOptions {
        folder: folder.to_owned(),
        group_stacks,
        show_completed,
        filters: None,
        sources: None,
    });
}

pub fn disconnect(view: &SettingsWindowView, source: &str) {
    if let Some(source) = source_of(source) {
        view.host.live_command(LiveCommand::Disconnect { source });
    }
}

pub fn source_icon(view: &SettingsWindowView, source: LiveSourceId, side: f32) -> AnyElement {
    let p = view.look.p;
    let site = source.site();
    let profile = view
        .state
        .profile_order
        .first()
        .cloned()
        .unwrap_or_else(|| ProfileId::from("default".to_owned()));
    let found = crate::primitives::site_icons::site_icon(site)
        .is_none()
        .then(|| view.host.page_favicon(&profile, site))
        .flatten();
    match found {
        Some(image) => gpui::img(image)
            .size(px(side))
            .rounded(px(crate::primitives::favicon::favicon_radius(side)))
            .into_any_element(),
        None => crate::primitives::favicon::render_favicon(
            &crate::primitives::favicon::favicon_of(site, None, None, source.name()),
            side,
            &p,
        ),
    }
}

fn folder_group(view: &SettingsWindowView, folder: &LiveFolder) -> AnyElement {
    let p = view.look.p;
    let id = folder.id.clone();
    let mut rows = vec![
        RowSpec::new(SharedString::from(format!("live-folder:{id}")))
            .title(folder.name.clone())
            .description(Some(folder_line(view, folder)))
            .control(
                div()
                    .debug_selector({
                        let id = id.clone();
                        move || format!("live-refresh:{id}")
                    })
                    .child(
                        PushButton::new(
                            SharedString::from(format!("live-refresh:{id}")),
                            "Refresh",
                            &p,
                        )
                        .on_click(view.emit.click(command("refresh", &id))),
                    ),
            )
            .control(
                div()
                    .debug_selector({
                        let id = id.clone();
                        move || format!("live-delete:{id}")
                    })
                    .child(
                        PushButton::new(
                            SharedString::from(format!("live-delete:{id}")),
                            "Delete",
                            &p,
                        )
                        .kind(ButtonKind::Destructive)
                        .on_click(view.emit.click(command("deleteFolder", &id))),
                    ),
            )
            .render(view),
    ];
    if folder.kind == LiveFolderKind::PullRequests {
        for (key, title, description) in PR_OPTIONS {
            let on = if key == "groupStacks" {
                folder.group_stacks
            } else {
                folder.show_completed
            };
            let emit = view.emit.clone();
            let folder_id = id.clone();
            rows.push(
                RowSpec::new(SharedString::from(format!("live-option:{id}:{key}")))
                    .title(title)
                    .description(Some(description))
                    .control(
                        div()
                            .debug_selector({
                                let id = id.clone();
                                move || format!("toggle:{id}:{key}")
                            })
                            .child(
                                Toggle::new(
                                    SharedString::from(format!("toggle:{id}:{key}")),
                                    on,
                                    &p,
                                )
                                .native(true)
                                .on_toggle(
                                    move |on, window, cx| {
                                        emit.send(
                                            command(
                                                "folderOption",
                                                &format!("{folder_id}={key}={on}"),
                                            ),
                                            window,
                                            cx,
                                        )
                                    },
                                ),
                            ),
                    )
                    .render(view),
            );
        }
    }
    group(&p, rows)
}

fn account_row(
    view: &SettingsWindowView,
    source: LiveSourceId,
    account: Option<&LiveAccount>,
) -> AnyElement {
    let p = view.look.p;
    let key = source.key();
    let anchor: &'static str = match source {
        LiveSourceId::Github => "automations.github",
        LiveSourceId::Bitbucket => "automations.bitbucket",
        LiveSourceId::Notion => "automations.notion",
        LiveSourceId::Confluence => "automations.confluence",
        LiveSourceId::Gdrive => "automations.gdrive",
    };
    let button = match account {
        Some(_) => PushButton::new(
            SharedString::from(format!("account:{key}")),
            "Disconnect",
            &p,
        )
        .on_click(view.emit.click(command("disconnect", key))),
        None => PushButton::new(
            SharedString::from(format!("account:{key}")),
            "Connect\u{2026}",
            &p,
        )
        .on_click(view.emit.click(command("connect", key))),
    };
    RowSpec::new(SharedString::from(format!("setting:{anchor}")))
        .anchor(anchor)
        .icon(source_icon(view, source, 18.))
        .title(source.name())
        .description(account.map(|a| format!("Connected as {}", connected_as(source, a))))
        .control(
            div()
                .debug_selector(move || format!("account:{key}"))
                .child(button),
        )
        .render(view)
}

pub fn blocks(view: &SettingsWindowView) -> Vec<Block> {
    let p = view.look.p;
    let live = view.host.live();
    let folders: Vec<LiveFolder> = live
        .as_ref()
        .map(|l| {
            l.folder_order
                .iter()
                .filter_map(|id| l.folders.get(id).cloned())
                .collect()
        })
        .unwrap_or_default();
    let folders_element = if folders.is_empty() {
        group(
            &p,
            vec![
                RowSpec::new("live-folders-none")
                    .title("No live folders yet")
                    .render(view),
            ],
        )
    } else {
        div()
            .flex()
            .flex_col()
            .gap(px(20.))
            .children(folders.iter().map(|folder| folder_group(view, folder)))
            .into_any_element()
    };
    let accounts = ACCOUNTS
        .iter()
        .map(|source| {
            account_row(
                view,
                *source,
                live.as_ref().and_then(|l| l.accounts.get(source)),
            )
        })
        .collect();
    vec![
        block(
            vec!["automations.liveFolders"],
            section_header(
                view,
                Some("automations.liveFolders"),
                "Live folders",
                Some("Right-click the sidebar and choose New Live Folder."),
            ),
        ),
        block(vec![], folders_element),
        block(
            vec![],
            section_header(
                view,
                None,
                "Connected accounts",
                Some("Live folders read from these accounts."),
            ),
        ),
        block(
            vec![
                "automations.github",
                "automations.bitbucket",
                "automations.notion",
                "automations.confluence",
                "automations.gdrive",
            ],
            group(&p, accounts),
        ),
    ]
}
