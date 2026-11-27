use crate::host::NativeMenuItem;

fn sections(groups: Vec<Vec<NativeMenuItem>>) -> Vec<NativeMenuItem> {
    let mut out: Vec<NativeMenuItem> = Vec::new();
    for group in groups.into_iter().filter(|g| !g.is_empty()) {
        if !out.is_empty() {
            out.push(NativeMenuItem::separator());
        }
        out.extend(group);
    }
    out
}

pub fn open_link_items(split: bool) -> Vec<NativeMenuItem> {
    let mut items = vec![NativeMenuItem::new("tab", "Open in New Tab", "plus.app")];
    if split {
        items.push(NativeMenuItem::new(
            "split",
            "Open in Split View",
            "rectangle.split.2x1",
        ));
    }
    items.push(
        NativeMenuItem::new("openIn", "Open in", "macwindow").children(vec![
            NativeMenuItem::new("window", "New Window", "macwindow.badge.plus"),
            NativeMenuItem::new("incognito", "Incognito Window", "eyeglasses"),
        ]),
    );
    items
}

pub fn open_all_items(links: usize, label: Option<usize>, elsewhere: bool) -> Vec<NativeMenuItem> {
    let what = label.map_or_else(|| "All".to_owned(), |n| n.to_string());
    let tabs = if label == Some(1) { "Tab" } else { "Tabs" };
    let mut items = vec![
        NativeMenuItem::new("openAll", format!("Open {what} in New {tabs}"), "plus.app")
            .enabled(links > 0),
    ];
    if elsewhere {
        items.push(
            NativeMenuItem::new(
                "openAllWindow",
                format!("Open {what} in New Window"),
                "macwindow.badge.plus",
            )
            .enabled(links > 0),
        );
        items.push(
            NativeMenuItem::new(
                "openAllIncognito",
                format!("Open {what} in Incognito Window"),
                "eyeglasses",
            )
            .enabled(links > 0),
        );
    }
    items
}

pub fn copy_link_items(count: usize) -> Vec<NativeMenuItem> {
    let noun = if count == 1 {
        "Link".to_owned()
    } else {
        format!("{count} Links")
    };
    vec![
        NativeMenuItem::new("copy", format!("Copy {noun}"), "link").enabled(count > 0),
        NativeMenuItem::new("copyMarkdown", format!("Copy {noun} as Markdown"), "link")
            .enabled(count > 0)
            .alternate(),
    ]
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RowTarget {
    Url {
        show_path: bool,
    },
    Folder {
        links: usize,
        makes_group: bool,
        restores_arc: bool,
        show_path: bool,
    },
    Several {
        links: usize,
        items: usize,
        noun: &'static str,
    },
}

fn show_in_folder(show_path: bool) -> Option<NativeMenuItem> {
    show_path.then(|| NativeMenuItem::new("show", "Show in Folder", "folder"))
}

pub fn page_row_menu(target: &RowTarget, split: bool) -> Vec<NativeMenuItem> {
    match target {
        RowTarget::Url { show_path } => {
            let mut open = open_link_items(split);
            open.extend(show_in_folder(*show_path));
            sections(vec![
                open,
                copy_link_items(1),
                vec![NativeMenuItem::new("edit", "Edit…", "pencil")],
                vec![NativeMenuItem::new("delete", "Delete", "trash")],
            ])
        }
        RowTarget::Folder {
            links,
            makes_group,
            restores_arc,
            show_path,
        } => {
            let mut open = open_all_items(*links, None, false);
            open.push(
                NativeMenuItem::new("addGroup", "Add to Sidebar as Group", "sidebar.left")
                    .enabled(*makes_group),
            );
            if *restores_arc {
                open.push(NativeMenuItem::new(
                    "restoreArc",
                    "Restore Arc Folders as Groups",
                    "arrow.uturn.backward",
                ));
            }
            open.extend(show_in_folder(*show_path));
            sections(vec![
                open,
                vec![NativeMenuItem::new("edit", "Rename…", "pencil")],
                vec![NativeMenuItem::new("delete", "Delete Folder", "trash")],
            ])
        }
        RowTarget::Several { links, items, noun } => sections(vec![
            open_all_items(*links, Some(*links), true),
            copy_link_items(*links),
            vec![NativeMenuItem::new(
                "delete",
                format!("Delete {items} {noun}"),
                "trash",
            )],
        ]),
    }
}

pub fn organize_menu(exports: bool) -> Vec<NativeMenuItem> {
    let mut io = vec![NativeMenuItem::new(
        "import",
        "Import Bookmarks…",
        "square.and.arrow.down",
    )];
    if exports {
        io.push(NativeMenuItem::new(
            "export",
            "Export Bookmarks…",
            "square.and.arrow.up",
        ));
    }
    sections(vec![
        vec![
            NativeMenuItem::new("bookmark", "Add Page…", "bookmark"),
            NativeMenuItem::new("folder", "New Folder…", "folder.badge.plus"),
        ],
        io,
    ])
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BarTarget {
    Url,
    Folder {
        links: usize,
        makes_group: bool,
        restores_arc: bool,
    },
    Bar,
}

pub fn bar_menu(target: &BarTarget, bar_shown: bool, split: bool) -> Vec<NativeMenuItem> {
    match target {
        BarTarget::Url => sections(vec![
            open_link_items(split),
            copy_link_items(1),
            vec![NativeMenuItem::new("edit", "Edit…", "pencil")],
            vec![NativeMenuItem::new("delete", "Delete", "trash")],
        ]),
        BarTarget::Folder {
            links,
            makes_group,
            restores_arc,
        } => {
            let mut open = open_all_items(*links, None, false);
            open.push(
                NativeMenuItem::new("addGroup", "Add to Sidebar as Group", "sidebar.left")
                    .enabled(*makes_group),
            );
            if *restores_arc {
                open.push(NativeMenuItem::new(
                    "restoreArc",
                    "Restore Arc Folders as Groups",
                    "arrow.uturn.backward",
                ));
            }
            sections(vec![
                open,
                vec![NativeMenuItem::new("rename", "Rename…", "pencil")],
                vec![NativeMenuItem::new("delete", "Delete Folder", "trash")],
            ])
        }
        BarTarget::Bar => sections(vec![
            vec![
                NativeMenuItem::new("addPage", "Add Page…", "bookmark"),
                NativeMenuItem::new("addFolder", "New Folder…", "folder.badge.plus"),
            ],
            vec![
                NativeMenuItem::new("manage", "Manage Bookmarks", "book"),
                NativeMenuItem::new("toggleBar", "Show Bookmarks Bar", "menubar.rectangle")
                    .checked(bar_shown),
            ],
        ]),
    }
}

pub fn import_button_menu() -> Vec<NativeMenuItem> {
    vec![NativeMenuItem::new(
        "hide",
        "Hide Import Bookmarks Button",
        "",
    )]
}

pub fn titles(items: &[NativeMenuItem]) -> Vec<String> {
    items
        .iter()
        .map(|item| {
            if item.separator {
                "—".to_owned()
            } else if item.alternate {
                format!("⌥ {}", item.title)
            } else {
                item.title.clone()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_and_bar_menus_read_like_the_old_app() {
        assert_eq!(
            titles(&page_row_menu(&RowTarget::Url { show_path: true }, true)),
            [
                "Open in New Tab",
                "Open in Split View",
                "Open in",
                "Show in Folder",
                "—",
                "Copy Link",
                "⌥ Copy Link as Markdown",
                "—",
                "Edit…",
                "—",
                "Delete"
            ]
        );
        let folder = page_row_menu(
            &RowTarget::Folder {
                links: 2,
                makes_group: true,
                restores_arc: true,
                show_path: false,
            },
            true,
        );
        assert_eq!(
            titles(&folder),
            [
                "Open All in New Tabs",
                "Add to Sidebar as Group",
                "Restore Arc Folders as Groups",
                "—",
                "Rename…",
                "—",
                "Delete Folder"
            ]
        );
        assert_eq!(
            titles(&page_row_menu(
                &RowTarget::Several {
                    links: 1,
                    items: 2,
                    noun: "Items"
                },
                true
            ))[..2],
            ["Open 1 in New Tab", "Open 1 in New Window"]
        );
        assert_eq!(
            titles(&organize_menu(true)),
            [
                "Add Page…",
                "New Folder…",
                "—",
                "Import Bookmarks…",
                "Export Bookmarks…"
            ]
        );
        let bar = bar_menu(&BarTarget::Bar, true, true);
        assert_eq!(
            titles(&bar),
            [
                "Add Page…",
                "New Folder…",
                "—",
                "Manage Bookmarks",
                "Show Bookmarks Bar"
            ]
        );
        assert!(bar[4].checked);
        let open_in = &open_link_items(true)[2];
        assert_eq!(open_in.children.len(), 2);
    }
}
