use std::collections::HashMap;
use std::sync::Arc;

use ardia_state::model::{TabPin, TileFolder};
use ardia_state::tabs::Tab;
use ardia_state::{Action, TabId, WindowId};
use ardia_theme::layout::sidebar;
use gpui::{
    AnyElement, App, FontWeight, Global, IntoElement, MouseButton, ParentElement, RenderOnce,
    Styled, Window, div, prelude::*,
};

use crate::msg::Msg;
use crate::primitives::controls::panel_shadows;
use crate::primitives::fade_label::fade_label;
use crate::primitives::favicon::render_favicon;
use crate::primitives::icons::{Icon, icon};
use crate::scale::px;
use crate::sidebar::model::grid_columns;
use crate::sidebar::tab_row::row_id;
use crate::window::chrome::Chrome;

pub const PANEL_GAP: f32 = 6.0;
pub const PANEL_PAD: f32 = 6.0;
pub const MOSAIC_CELL: f32 = 14.0;
pub const MOSAIC_MAX: usize = 4;
pub const BADGE_INSET: (f32, f32) = (5.0, 4.0);
pub const BADGE_BOX: (f32, f32) = (14.0, 12.0);
pub const BADGE_GLYPH: f32 = 9.5;

#[derive(Clone, Debug)]
pub enum TileCell {
    Tab(Arc<Tab>),
    Folder {
        folder: TileFolder,
        members: Vec<Arc<Tab>>,
    },
}

impl TileCell {
    pub fn key(&self) -> String {
        match self {
            TileCell::Tab(tab) => tab.id.to_string(),
            TileCell::Folder { folder, .. } => format!("folder:{}", folder.id),
        }
    }
}

pub fn folder_label(folder: &TileFolder) -> String {
    let name = folder.name.trim();
    if name.is_empty() {
        "Folder".to_owned()
    } else {
        name.to_owned()
    }
}

pub fn plural_tabs(count: usize) -> String {
    if count == 1 {
        "1 tab".to_owned()
    } else {
        format!("{count} tabs")
    }
}

pub fn tile_cells(tiles: &[Arc<Tab>]) -> Vec<TileCell> {
    let mut out: Vec<TileCell> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for tab in tiles {
        match tab.pin.as_ref().and_then(TabPin::folder) {
            None => out.push(TileCell::Tab(Arc::clone(tab))),
            Some(folder) => match at.get(&folder.id) {
                Some(index) => {
                    if let TileCell::Folder { members, .. } = &mut out[*index] {
                        members.push(Arc::clone(tab));
                    }
                }
                None => {
                    at.insert(folder.id.clone(), out.len());
                    out.push(TileCell::Folder {
                        folder: folder.clone(),
                        members: vec![Arc::clone(tab)],
                    });
                }
            },
        }
    }
    out
}

pub fn mosaic_rows(members: &[Arc<Tab>]) -> Vec<Vec<Arc<Tab>>> {
    let shown: Vec<Arc<Tab>> = members.iter().take(MOSAIC_MAX).cloned().collect();
    if shown.len() > 2 {
        vec![shown[..2].to_vec(), shown[2..].to_vec()]
    } else {
        vec![shown]
    }
}

pub fn shown_folder_tab(c: &Chrome, members: &[Arc<Tab>]) -> Option<Arc<Tab>> {
    let active = c.window.active_tab()?;
    members.iter().find(|t| &t.id == active).cloned()
}

pub fn folder_mosaic(c: &Chrome, members: &[Arc<Tab>], width: f32) -> AnyElement {
    div()
        .w(px(width))
        .h(px(sidebar::pinned_tile_height()))
        .flex()
        .flex_col()
        .justify_around()
        .children(mosaic_rows(members).into_iter().map(|row| {
            div()
                .flex()
                .items_center()
                .justify_around()
                .children(row.into_iter().map(|tab| {
                    div()
                        .flex_none()
                        .size(px(MOSAIC_CELL))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(render_favicon(&c.favicon(&tab), MOSAIC_CELL, c.p))
                }))
        }))
        .into_any_element()
}

pub fn folder_badge(c: &Chrome) -> AnyElement {
    div()
        .absolute()
        .right(px(BADGE_INSET.0))
        .bottom(px(BADGE_INSET.1))
        .w(px(BADGE_BOX.0))
        .h(px(BADGE_BOX.1))
        .flex()
        .items_center()
        .justify_center()
        .child(icon(Icon::Folder, BADGE_GLYPH, c.p.text_secondary))
        .into_any_element()
}

#[derive(Clone, Debug, PartialEq)]
struct OpenFolder {
    window: WindowId,
    folder: String,
    active: Option<TabId>,
}

#[derive(Default)]
pub struct FolderPanelUi {
    open: Option<OpenFolder>,
}

impl Global for FolderPanelUi {}

pub fn toggle_folder_panel(window: WindowId, folder: String, active: Option<TabId>, cx: &mut App) {
    let ui = cx.default_global::<FolderPanelUi>();
    let next = OpenFolder {
        window,
        folder,
        active,
    };
    let same = ui
        .open
        .as_ref()
        .is_some_and(|open| open.window == next.window && open.folder == next.folder);
    ui.open = (!same).then_some(next);
}

pub fn close_folder_panel(cx: &mut App) {
    cx.default_global::<FolderPanelUi>().open = None;
}

pub fn folder_open(window: &WindowId, folder: &str, cx: &mut App) -> bool {
    cx.default_global::<FolderPanelUi>()
        .open
        .as_ref()
        .is_some_and(|open| &open.window == window && open.folder == folder)
}

pub fn folder_tile_click(
    c: &Chrome,
    folder: &TileFolder,
) -> impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static {
    let window = c.window.id.clone();
    let folder = folder.id.clone();
    let active = c.window.active_tab().cloned();
    move |_, window_handle, cx| {
        toggle_folder_panel(window.clone(), folder.clone(), active.clone(), cx);
        window_handle.refresh();
    }
}

fn member_row(c: &Chrome, tab: &Arc<Tab>) -> AnyElement {
    let p = *c.p;
    let active = c.is_active(&tab.id);
    let emit = c.emit.clone();
    let menu_emit = c.emit.clone();
    let id = tab.id.clone();
    let menu_id = tab.id.clone();
    div()
        .id(row_id("folder-member", tab.id.as_str()))
        .flex_none()
        .h(px(sidebar::row_height()))
        .pl(px(sidebar::ROW_CONTENT_LEFT))
        .pr(px(sidebar::ROW_CONTENT_LEFT))
        .rounded(px(8.))
        .flex()
        .items_center()
        .gap(px(sidebar::DIA_ROW_TITLE_GAP))
        .when(active, |this| this.bg(p.pinned_selected_fill))
        .when(!active, |this| {
            this.hover(move |style| style.bg(p.tab_hover))
                .active(move |style| style.bg(p.tab_pressed))
        })
        .on_click(move |_, window, cx| {
            close_folder_panel(cx);
            emit.send(
                Msg::PickTab {
                    tab: id.clone(),
                    toggle: false,
                    range: false,
                },
                window,
                cx,
            );
        })
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            cx.stop_propagation();
            menu_emit.send(
                Msg::Menu(Some((
                    crate::msg::MenuTarget::Tab(menu_id.clone()),
                    event.position,
                ))),
                window,
                cx,
            );
        })
        .child(render_favicon(
            &c.favicon(tab),
            c.look.icon_points(sidebar::ROW_FAVICON),
            c.p,
        ))
        .child(fade_label(
            crate::window::chrome::tab_title(tab),
            if active { p.text } else { p.text_tab },
            c.points(13.),
        ))
        .into_any_element()
}

fn panel_body(c: &Chrome, folder: &TileFolder, members: &[Arc<Tab>], width: f32) -> AnyElement {
    let p = *c.p;
    div()
        .w(px(width))
        .p(px(PANEL_PAD))
        .rounded(px(12.))
        .bg(p.popover_fill)
        .border(px(0.5))
        .border_color(p.popover_border)
        .shadow(panel_shadows(&p))
        .flex()
        .flex_col()
        .child(
            div()
                .px(px(6.))
                .pt(px(2.))
                .pb(px(6.))
                .text_size(px(c.points(11.)))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text_secondary)
                .truncate()
                .child(format!(
                    "{} \u{00B7} {}",
                    folder_label(folder),
                    plural_tabs(members.len())
                )),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(sidebar::row_gap()))
                .children(members.iter().map(|tab| member_row(c, tab))),
        )
        .into_any_element()
}

pub fn panel_top(index: usize, count: usize, inner: f32, grid_top: f32) -> f32 {
    let (columns, _) = grid_columns(count, inner);
    let row = index / columns.max(1);
    grid_top
        + (row + 1) as f32 * sidebar::pinned_tile_height()
        + row as f32 * sidebar::PINNED_TILE_GAP
        + PANEL_GAP
}

#[derive(IntoElement)]
pub struct FolderPanelSlot {
    window: WindowId,
    active: Option<TabId>,
    panels: Vec<(String, f32, AnyElement)>,
    left: f32,
}

pub fn folder_panel(c: &Chrome, tiles: &[Arc<Tab>], grid_top: f32) -> FolderPanelSlot {
    let inner = (c.layout.sidebar_width - 2.0 * sidebar::INSET).max(0.0);
    let cells = tile_cells(tiles);
    let count = cells.len();
    let panels = cells
        .iter()
        .enumerate()
        .filter_map(|(index, cell)| match cell {
            TileCell::Folder { folder, members } => Some((
                folder.id.clone(),
                panel_top(index, count, inner, grid_top),
                panel_body(c, folder, members, inner),
            )),
            TileCell::Tab(_) => None,
        })
        .collect();
    FolderPanelSlot {
        window: c.window.id.clone(),
        active: c.window.active_tab().cloned(),
        panels,
        left: sidebar::INSET,
    }
}

impl RenderOnce for FolderPanelSlot {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ui = cx.default_global::<FolderPanelUi>();
        let open = ui.open.clone().filter(|open| open.window == self.window);
        if let Some(open) = &open
            && (open.active != self.active
                || !self.panels.iter().any(|(id, _, _)| *id == open.folder))
        {
            ui.open = None;
        }
        let shown = ui.open.clone().filter(|open| open.window == self.window);
        let left = self.left;
        div().children(shown.and_then(|open| {
            self.panels
                .into_iter()
                .find(|(id, _, _)| *id == open.folder)
                .map(|(_, top, body)| {
                    div()
                        .id("folder-panel")
                        .debug_selector(|| "folder-panel".into())
                        .absolute()
                        .left(px(left))
                        .top(px(top))
                        .occlude()
                        .on_mouse_down_out(|_, window, cx| {
                            close_folder_panel(cx);
                            window.refresh();
                        })
                        .child(body)
                })
        }))
    }
}

pub fn dissolve_folder(members: &[Arc<Tab>]) -> Vec<Msg> {
    members
        .iter()
        .map(|tab| {
            Msg::Store(Action::SetPin {
                tab: tab.id.clone(),
                pin: Some(TabPin::TILE),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::{ProfileId, WindowId};

    fn tile(id: &str, folder: Option<&str>) -> Arc<Tab> {
        let mut tab = Tab::new(
            TabId::new(id),
            WindowId::new("w"),
            ProfileId::default_profile(),
            "https://a.test/",
            0,
        );
        tab.pin = Some(TabPin::Tile {
            folder: folder.map(|f| TileFolder {
                id: f.into(),
                name: String::new(),
                renamed_at: None,
            }),
        });
        Arc::new(tab)
    }

    #[test]
    fn folder_members_share_one_cell_where_the_first_sits() {
        let cells = tile_cells(&[
            tile("a", None),
            tile("b", Some("f")),
            tile("c", None),
            tile("d", Some("f")),
        ]);
        assert_eq!(cells.len(), 3);
        assert_eq!(cells[1].key(), "folder:f");
        match &cells[1] {
            TileCell::Folder { members, folder } => {
                assert_eq!(members.len(), 2);
                assert_eq!(folder_label(folder), "Folder");
            }
            TileCell::Tab(_) => panic!("expected a folder"),
        }
    }

    #[test]
    fn the_mosaic_shows_four_icons_in_two_rows() {
        let members: Vec<Arc<Tab>> = (0..6).map(|i| tile(&i.to_string(), Some("f"))).collect();
        let rows = mosaic_rows(&members);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].len() + rows[1].len(), 4);
        assert_eq!(mosaic_rows(&members[..2]).len(), 1);
        assert_eq!(plural_tabs(1), "1 tab");
        assert_eq!(plural_tabs(3), "3 tabs");
    }

    #[test]
    fn the_panel_opens_under_its_tile_row() {
        let first_row = panel_top(0, 5, 172.0, 100.0);
        let second_row = panel_top(4, 5, 172.0, 100.0);
        assert_eq!(first_row, 100.0 + sidebar::pinned_tile_height() + PANEL_GAP);
        assert!(second_row > first_row);
    }
}
