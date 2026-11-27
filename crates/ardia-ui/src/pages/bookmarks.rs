pub mod edits;
pub mod model;
pub mod open;

use std::cell::OnceCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use crate::scale::px;
use ardia_state::bookmarks::{BookmarkNode, BookmarkTree};
use ardia_state::omnibox::url::resolve_input;
use ardia_state::{BookmarkId, ProfileId, TabId, WindowId};
use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, App, ElementId, Entity, FocusHandle, FontWeight, Hsla, IntoElement, MouseButton,
    ParentElement, Pixels, Point, Render, RenderOnce, SharedString, Styled, Window, div,
    prelude::*,
};

use self::edits::RemovedBookmarks;
use self::model::{Drop, SearchIndex, Selection, Target};
use self::open::{OpenAll, OpenMode};
use super::shell::search_field;
use crate::bookmarks_bar::native::{self, RowTarget};
use crate::bookmarks_bar::{BarCtx, popup};
use crate::host::{UiHost, UtilityWindowKind};
use crate::look::Palette;
use crate::msg::Emit;
use crate::primitives::controls::{ButtonKind, IconButton, PushButton};
use crate::primitives::favicon::render_favicon;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::text_input::TextInput;
use crate::primitives::virtual_list::{self, VirtualItem, virtual_list};
use crate::window::chrome::Chrome;

pub const PAGE_TOOLBAR_HEIGHT: f32 = 64.0;
pub const PAGE_TOOLBAR_PAD: f32 = space::XXXL;
pub const PAGE_SIDE_WIDTH: f32 = 200.0;
pub const SEARCH_MAX_WIDTH: f32 = 480.0;
pub const MENU_WIDTH: f32 = 240.0;
const ROW_SELECTED_DARK: f32 = 0x59 as f32 / 255.0;
const ROW_SELECTED_LIGHT: f32 = 0x33 as f32 / 255.0;
const DROP_TARGET_ALPHA: f32 = 0x40 as f32 / 255.0;
const SELECTED_CHEVRON: f32 = 0xCC as f32 / 255.0;

pub fn row_selected(p: &Palette) -> Hsla {
    p.form_accent.opacity(if p.dark {
        ROW_SELECTED_DARK
    } else {
        ROW_SELECTED_LIGHT
    })
}

pub fn drop_target(p: &Palette) -> Hsla {
    p.form_accent.opacity(DROP_TARGET_ALPHA)
}

#[derive(Clone, Debug, PartialEq)]
pub enum MenuKind {
    Organize,
    Rows {
        node: BookmarkId,
        ids: Vec<BookmarkId>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct PageMenu {
    pub at: Point<Pixels>,
    pub kind: MenuKind,
    pub open_in: bool,
}

pub struct Undo {
    pub removed: RemovedBookmarks,
    pub count: usize,
    pub generation: u64,
}

pub struct BookmarksUi {
    pub folder: Option<BookmarkId>,
    pub query_seen: String,
    pub selection: Selection,
    pub expanded: HashSet<BookmarkId>,
    pub seeded: bool,
    pub menu: Option<PageMenu>,
    pub list_width: f32,
    pub drop: Option<Drop>,
    pub undo: Option<Undo>,
    pub generation: u64,
    pub focus: FocusHandle,
    listing: Option<Rc<Listing>>,
    search_index: Option<Rc<SearchIndex>>,
    tree_rows: Option<Rc<TreeRows>>,
}

pub struct Listing {
    tree: Option<Arc<BookmarkTree>>,
    folder: Option<BookmarkId>,
    query: String,
    pub ids: Rc<Vec<BookmarkId>>,
    items: Vec<VirtualItem>,
    members: HashSet<BookmarkId>,
}

impl Listing {
    fn is_for(
        &self,
        tree: Option<&Arc<BookmarkTree>>,
        folder: Option<&BookmarkId>,
        query: &str,
    ) -> bool {
        same_tree(self.tree.as_ref(), tree) && self.folder.as_ref() == folder && self.query == query
    }

    fn selected_count(&self, selection: &Selection) -> usize {
        selection
            .selected
            .iter()
            .filter(|id| self.members.contains(*id))
            .count()
    }
}

pub struct TreeRows {
    tree: Option<Arc<BookmarkTree>>,
    expanded: HashSet<BookmarkId>,
    rows: Vec<model::FolderRow>,
    items: Vec<VirtualItem>,
}

fn same_tree(a: Option<&Arc<BookmarkTree>>, b: Option<&Arc<BookmarkTree>>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => Arc::ptr_eq(a, b),
        (None, None) => true,
        _ => false,
    }
}

fn item_key(id: &BookmarkId) -> SharedString {
    SharedString::from(id.as_str().to_owned())
}

impl BookmarksUi {
    fn new(cx: &mut gpui::Context<Self>) -> Self {
        BookmarksUi {
            folder: None,
            query_seen: String::new(),
            selection: Selection::default(),
            expanded: HashSet::new(),
            seeded: false,
            menu: None,
            list_width: 0.0,
            drop: None,
            undo: None,
            generation: 0,
            focus: cx.focus_handle(),
            listing: None,
            search_index: None,
            tree_rows: None,
        }
    }

    fn listing(&mut self, tree: Option<&Arc<BookmarkTree>>, query: &str) -> Rc<Listing> {
        if let Some(listing) = &self.listing
            && listing.is_for(tree, self.folder.as_ref(), query)
        {
            return Rc::clone(listing);
        }
        let ids = match tree {
            Some(tree) if !query.trim().is_empty() => {
                let index = match &self.search_index {
                    Some(index) if index.is_for(tree) => Rc::clone(index),
                    _ => {
                        let index = Rc::new(SearchIndex::build(tree));
                        self.search_index = Some(Rc::clone(&index));
                        index
                    }
                };
                index.matching(query)
            }
            Some(tree) => model::listed(tree, self.folder.as_ref(), query),
            None => Vec::new(),
        };
        let listing = Rc::new(Listing {
            tree: tree.cloned(),
            folder: self.folder.clone(),
            query: query.to_owned(),
            items: ids
                .iter()
                .map(|id| VirtualItem::new(item_key(id), model::ROW))
                .collect(),
            members: ids.iter().cloned().collect(),
            ids: Rc::new(ids),
        });
        self.listing = Some(Rc::clone(&listing));
        listing
    }

    fn tree_rows(&mut self, tree: Option<&Arc<BookmarkTree>>) -> Rc<TreeRows> {
        if let Some(rows) = &self.tree_rows
            && same_tree(rows.tree.as_ref(), tree)
            && rows.expanded == self.expanded
        {
            return Rc::clone(rows);
        }
        let rows = tree
            .map(|tree| model::folder_rows(tree, &self.expanded))
            .unwrap_or_default();
        let built = Rc::new(TreeRows {
            tree: tree.cloned(),
            expanded: self.expanded.clone(),
            items: rows
                .iter()
                .map(|row| VirtualItem::new(item_key(&row.id), model::TREE_ROW))
                .collect(),
            rows,
        });
        self.tree_rows = Some(Rc::clone(&built));
        built
    }

    pub fn set_folder(&mut self, tree: &BookmarkTree, folder: BookmarkId) {
        for ancestor in tree.ancestors(folder.as_str()) {
            self.expanded.insert(ancestor);
        }
        if self.folder.as_ref() != Some(&folder) {
            self.selection.clear();
        }
        self.folder = Some(folder);
    }
}

#[derive(Clone)]
pub struct DragIds {
    row: BookmarkId,
    selection: Option<(Entity<BookmarksUi>, Rc<Vec<BookmarkId>>)>,
    resolved: Rc<OnceCell<Vec<BookmarkId>>>,
}

impl DragIds {
    pub fn get(&self, cx: &App) -> &[BookmarkId] {
        self.resolved.get_or_init(|| match &self.selection {
            Some((ui, listed)) => ui.read(cx).selection.in_order(listed),
            None => vec![self.row.clone()],
        })
    }
}

#[derive(Clone)]
pub struct BookmarkDrag {
    pub ids: DragIds,
    pub label: SharedString,
    pub detail: SharedString,
    pub favicon: Option<crate::primitives::favicon::Favicon>,
    pub width: f32,
    pub p: Palette,
    pub host: Arc<dyn UiHost>,
}

impl Render for BookmarkDrag {
    fn render(&mut self, _: &mut Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
        let p = self.p;
        let glyph = match self.favicon.as_ref() {
            Some(shown) => render_favicon(shown, 16., &p),
            None => crate::bookmarks_bar::sf(
                self.host.as_ref(),
                "folder",
                model::FOLDER_ICON,
                model::FOLDER_ICON_BOX,
                p.icon,
            ),
        };
        div()
            .w(px(self.width.max(model::ROW * 4.)))
            .h(px(model::ROW))
            .px(px(space::ML))
            .gap(px(space::ML))
            .rounded(px(radius::TILE))
            .bg(row_selected(&p))
            .opacity(model::DRAG_OPACITY)
            .flex()
            .items_center()
            .child(glyph)
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(13.))
                    .text_color(p.text)
                    .child(self.label.clone()),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.))
                    .text_color(p.text_tertiary)
                    .child(self.detail.clone()),
            )
    }
}

#[derive(Clone)]
pub struct PageCtx {
    pub ui: Entity<BookmarksUi>,
    pub search: Entity<TextInput>,
    pub host: Arc<dyn UiHost>,
    pub emit: Emit,
    pub profile: ProfileId,
    pub window: WindowId,
    pub tab: TabId,
    pub p: Palette,
    pub glass: bool,
}

impl PageCtx {
    pub fn tree(&self) -> Option<Arc<BookmarkTree>> {
        self.host
            .store()
            .snapshot()
            .bookmarks_of(&self.profile)
            .cloned()
    }

    fn close_menu(&self, cx: &mut App) {
        self.ui.update(cx, |ui, cx| {
            ui.menu = None;
            cx.notify();
        });
    }

    pub fn remove(&self, ids: Vec<BookmarkId>, cx: &mut App) {
        if ids.is_empty() {
            return;
        }
        let removed = edits::remove_many(self.host.store(), &self.profile, &ids);
        let Some(removed) = removed else {
            return;
        };
        let generation = self.ui.update(cx, |ui, cx| {
            ui.selection.clear();
            ui.generation += 1;
            ui.undo = Some(Undo {
                count: removed.places.len(),
                removed,
                generation: ui.generation,
            });
            cx.notify();
            ui.generation
        });
        self.ui.update(cx, |_, cx| {
            cx.spawn(async move |ui, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(model::UNDO_VISIBLE_MS))
                    .await;
                let _ = ui.update(cx, |ui, cx| {
                    if ui.undo.as_ref().is_some_and(|u| u.generation == generation) {
                        ui.undo = None;
                        cx.notify();
                    }
                });
            })
            .detach();
        });
    }

    pub fn undo(&self, cx: &mut App) {
        let undo = self.ui.update(cx, |ui, cx| {
            cx.notify();
            ui.undo.take()
        });
        if let Some(undo) = undo {
            edits::restore(self.host.store(), &self.profile, undo.removed);
        }
    }

    pub fn open_folder(&self, folder: BookmarkId, cx: &mut App) {
        self.search
            .update(cx, |input, cx| input.set_text("", false, cx));
        if let Some(tree) = self.tree() {
            self.ui.update(cx, |ui, cx| {
                ui.set_folder(&tree, folder);
                ui.query_seen.clear();
                cx.notify();
            });
        }
    }

    fn select(
        &self,
        ids: &[BookmarkId],
        id: &BookmarkId,
        command: bool,
        shift: bool,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.ui.update(cx, |ui, cx| {
            ui.selection.click(ids, id, command, shift);
            ui.menu = None;
            window.focus(&ui.focus, cx);
            cx.notify();
        });
    }

    fn move_to(&self, moving: &[BookmarkId], drop: &Drop, listed: &[BookmarkId]) {
        let (parent, index) = match drop {
            Drop::Into(folder) => (folder.clone(), None),
            Drop::At { parent, index } => (
                parent.clone(),
                Some(model::drop_index(listed, moving, *index)),
            ),
        };
        let moving = moving.to_vec();
        edits::move_many(self.host.store(), &self.profile, &moving, &parent, index);
    }

    pub fn open(&self, url: &str, mode: OpenMode) {
        crate::bookmarks_bar::open_bookmark_url(&self.host, &self.window, url, mode);
    }

    pub fn bar(&self, cx: &mut App) -> Option<BarCtx> {
        BarCtx::for_window(
            &self.host,
            &self.emit,
            &self.window,
            &self.p,
            self.glass,
            cx,
        )
    }

    pub fn open_links(&self, links: Vec<String>, mode: OpenAll, many: &'static str, cx: &mut App) {
        crate::bookmarks_bar::open_links_checked(
            Arc::clone(&self.host),
            self.window.clone(),
            links,
            mode,
            many,
            cx,
        );
    }

    pub fn open_editor(
        &self,
        bookmark: Option<BookmarkId>,
        folder: bool,
        parent: Option<BookmarkId>,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.close_menu(cx);
        if let Some(bar) = self.bar(cx) {
            crate::bookmarks_bar::dialog::open_editor(
                &bar, bookmark, folder, parent, None, window, cx,
            );
        }
    }

    fn run_choice(
        &self,
        choice: &str,
        node: &BookmarkId,
        ids: &[BookmarkId],
        window: &mut Window,
        cx: &mut App,
    ) {
        self.close_menu(cx);
        let Some(tree) = self.tree() else {
            return;
        };
        let links = edits::links_of(&tree, ids);
        let is_folder =
            ids.len() == 1 && matches!(tree.get(node.as_str()), Some(BookmarkNode::Folder { .. }));
        let many = if is_folder {
            model::FOLDER_MANY
        } else {
            model::LINKS_MANY
        };
        if crate::bookmarks_bar::run_link_choice(&self.host, &self.window, choice, &links, many, cx)
        {
            return;
        }
        match choice {
            "edit" => self.open_editor(Some(node.clone()), is_folder, None, window, cx),
            "addGroup" => crate::bookmarks_bar::add_folder_to_sidebar(
                &self.host,
                node,
                &self.window,
                &self.profile,
            ),
            "restoreArc" => {
                crate::bookmarks_bar::restore_arc(&self.host, node, &self.window, &self.profile)
            }
            "show" => {
                if let Some(parent) = tree
                    .get(node.as_str())
                    .and_then(BookmarkNode::parent)
                    .cloned()
                {
                    self.open_folder(parent, cx);
                }
            }
            "delete" => self.remove(ids.to_vec(), cx),
            "bookmark" | "folder" => {
                let folder = self.ui.read(cx).folder.clone();
                self.open_editor(None, choice == "folder", folder, window, cx);
            }
            "import" => self.host.open_utility_window(UtilityWindowKind::Import),
            "export" => crate::bookmarks_bar::export_bookmarks(&self.host, &self.window),
            _ => {}
        }
    }

    fn menu_items(
        &self,
        kind: &MenuKind,
        searching: bool,
        cx: &App,
    ) -> Vec<crate::host::NativeMenuItem> {
        match kind {
            MenuKind::Organize => native::organize_menu(crate::bookmarks_bar::exports_bookmarks()),
            MenuKind::Rows { node, ids } => {
                let _ = cx;
                self.tree()
                    .and_then(|tree| row_target(&tree, node, ids, searching))
                    .map(|target| native::page_row_menu(&target, true))
                    .unwrap_or_default()
            }
        }
    }

    fn show_menu(&self, menu: PageMenu, searching: bool, window: &mut Window, cx: &mut App) {
        let items = self.menu_items(&menu.kind, searching, cx);
        let (node, ids) = match &menu.kind {
            MenuKind::Rows { node, ids } => (node.clone(), ids.clone()),
            MenuKind::Organize => (BookmarkId::new(""), Vec::new()),
        };
        let handle = window.window_handle();
        let runner = self.clone();
        let shown = crate::bookmarks_bar::show_native(&self.host, items, cx, move |choice, cx| {
            let _ = handle.update(cx, |_, window, cx| {
                runner.run_choice(&choice, &node, &ids, window, cx)
            });
        });
        if !shown {
            self.ui.update(cx, |ui, cx| {
                ui.menu = Some(menu);
                cx.notify();
            });
        }
    }

    fn open_row_menu(
        &self,
        node: &BookmarkId,
        selected: bool,
        listed: &[BookmarkId],
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let ids = self.ui.update(cx, |ui, cx| {
            if !selected {
                ui.selection.click(listed, node, false, false);
            }
            cx.notify();
            let chosen = ui.selection.in_order(listed);
            if chosen.contains(node) && chosen.len() > 1 {
                chosen
            } else {
                vec![node.clone()]
            }
        });
        let searching = !self.search.read(cx).text().trim().is_empty();
        self.show_menu(
            PageMenu {
                at,
                kind: MenuKind::Rows {
                    node: node.clone(),
                    ids,
                },
                open_in: false,
            },
            searching,
            window,
            cx,
        );
    }
}

fn bookmark_profile(profile: &ProfileId) -> ProfileId {
    if profile.is_incognito() {
        profile.incognito_original()
    } else {
        profile.clone()
    }
}

#[derive(Clone, Debug, PartialEq)]
struct RowData {
    id: BookmarkId,
    index: usize,
    folder: bool,
    title: SharedString,
    detail: SharedString,
    url: Option<String>,
    favicon: Option<String>,
    selected: bool,
    highlighted: bool,
    line_above: bool,
    line_below: bool,
}

fn row_data(
    tree: &BookmarkTree,
    id: &BookmarkId,
    index: usize,
    count: usize,
    selection: &Selection,
    drop: Option<&Drop>,
    searching: bool,
) -> Option<RowData> {
    let node = tree.get(id.as_str())?;
    let (title, url, favicon, folder) = match node {
        BookmarkNode::Url {
            title,
            url,
            favicon,
            ..
        } => {
            let shown = if title.is_empty() { url } else { title };
            (shown.clone(), Some(url.clone()), favicon.clone(), false)
        }
        BookmarkNode::Folder { title, .. } => (title.clone(), None, None, true),
    };
    let detail = if searching {
        let mut path = edits::ancestor_titles(tree, id.as_str());
        path.reverse();
        path.join(" › ")
    } else {
        match node {
            BookmarkNode::Url { url, .. } => model::host_label(url),
            BookmarkNode::Folder { children, .. } => model::plural(children.len(), "item"),
        }
    };
    let (line, into) = match drop {
        Some(Drop::At { index, .. }) => (Some(*index), None),
        Some(Drop::Into(id)) => (None, Some(id)),
        None => (None, None),
    };
    Some(RowData {
        id: id.clone(),
        index,
        folder,
        title: title.into(),
        detail: detail.into(),
        url,
        favicon,
        selected: selection.contains(id),
        highlighted: into == Some(id),
        line_above: line == Some(index),
        line_below: line == Some(index + 1) && index + 1 == count,
    })
}

#[derive(IntoElement)]
pub struct BookmarksPage {
    tab: TabId,
    window: WindowId,
    profile: ProfileId,
    tree: Option<Arc<BookmarkTree>>,
    initial_query: String,
    emit: Emit,
    host: Arc<dyn UiHost>,
    p: Palette,
    glass: bool,
}

impl BookmarksPage {
    pub fn new(c: &Chrome, tab: &ardia_state::tabs::Tab, initial_query: &str) -> Self {
        let profile = bookmark_profile(&tab.profile_id);
        BookmarksPage {
            tab: tab.id.clone(),
            window: tab.window_id.clone(),
            tree: c.state.bookmarks_of(&profile).cloned(),
            profile,
            initial_query: initial_query.to_owned(),
            emit: c.emit.clone(),
            host: Arc::clone(c.host),
            p: *c.p,
            glass: c.look.glass,
        }
    }
}

impl RenderOnce for BookmarksPage {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let p = self.p;
        let search = search_field(
            format!("bookmarks-search:{}", self.tab),
            "Search bookmarks",
            &self.initial_query,
            &p,
            window,
            cx,
        );
        let ui = window.use_keyed_state(
            ElementId::Name(format!("bookmarks-ui:{}", self.tab).into()),
            cx,
            |_, cx| BookmarksUi::new(cx),
        );
        let query = search.read(cx).text().to_owned();
        let tree = self.tree.clone();
        if let Some(tree) = tree.as_deref() {
            ui.update(cx, |ui, _| {
                if !ui.seeded {
                    ui.seeded = true;
                    ui.expanded.insert(tree.bar());
                    ui.expanded.insert(tree.other());
                }
                let exists = ui.folder.as_ref().is_some_and(|f| {
                    matches!(tree.get(f.as_str()), Some(BookmarkNode::Folder { .. }))
                });
                if !exists {
                    ui.folder = Some(tree.bar());
                    ui.selection.clear();
                }
                if ui.query_seen != query {
                    ui.query_seen = query.clone();
                    ui.selection.clear();
                }
            });
        }
        let ctx = PageCtx {
            ui: ui.clone(),
            search: search.clone(),
            host: self.host.clone(),
            emit: self.emit.clone(),
            profile: self.profile.clone(),
            window: self.window.clone(),
            tab: self.tab.clone(),
            p,
            glass: self.glass,
        };
        let (listing, tree_rows) = ui.update(cx, |ui, _| {
            (
                ui.listing(tree.as_ref(), &query),
                ui.tree_rows(tree.as_ref()),
            )
        });
        let state = ui.read(cx);
        let searching = !query.trim().is_empty();
        let folder = state.folder.clone();
        let selected_count = listing.selected_count(&state.selection);
        let folder_title = tree
            .as_deref()
            .zip(folder.as_ref())
            .and_then(|(tree, f)| tree.get(f.as_str()).map(|n| n.title().to_owned()))
            .unwrap_or_default();
        let into_folder = match &state.drop {
            Some(Drop::Into(id)) => Some(id.clone()),
            _ => None,
        };
        let menu = state.menu.clone();
        let undo_count = state.undo.as_ref().map(|u| u.count);

        let header = header(&ctx, &search, selected_count, &listing.ids);
        let tree_view = folder_tree(
            &ctx,
            &tree_rows,
            folder.as_ref().filter(|_| !searching),
            into_folder.as_ref(),
            &state.expanded,
        );
        let list = list_card(
            &ctx,
            ListView {
                tree: tree.as_deref(),
                listing: &listing,
                state,
                searching,
            },
            &query,
            &folder_title,
            folder,
        );
        div()
            .id("bookmarks-page")
            .debug_selector(|| "bookmarks-page".into())
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .overflow_hidden()
            .on_drop::<BookmarkDrag>({
                let ctx = ctx.clone();
                move |drag, _, cx| {
                    let drop = ctx.ui.update(cx, |ui, cx| {
                        cx.notify();
                        ui.drop.take()
                    });
                    let Some(drop) = drop else {
                        return;
                    };
                    let query = ctx.search.read(cx).text().to_owned();
                    let folder = ctx.ui.read(cx).folder.clone();
                    let listed = ctx
                        .tree()
                        .map(|tree| model::listed(&tree, folder.as_ref(), &query))
                        .unwrap_or_default();
                    let moving = drag.ids.get(cx).to_vec();
                    ctx.move_to(&moving, &drop, &listed);
                }
            })
            .child(header)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .px(px(space::XL))
                    .pb(px(space::XL))
                    .gap(px(space::XL))
                    .child(tree_view)
                    .child(list),
            )
            .when_some(undo_count, |this, count| {
                this.child(undo_toast(&ctx, count))
            })
            .when_some(menu, |this, menu| {
                this.child(menu_view(
                    &ctx,
                    &menu,
                    searching,
                    window.modifiers().alt,
                    cx,
                ))
            })
    }
}

fn header(
    ctx: &PageCtx,
    search: &Entity<TextInput>,
    selected_count: usize,
    listed: &Rc<Vec<BookmarkId>>,
) -> AnyElement {
    let p = ctx.p;
    let actions = if selected_count == 0 {
        let organize = ctx.clone();
        div()
            .debug_selector(|| "bookmarks-organize".into())
            .child(
                IconButton::new("bookmarks-organize", Icon::Ellipsis, &p)
                    .symbol(ctx.host.clone(), "ellipsis.circle")
                    .tooltip("Organize", &p)
                    .on_click(move |_, window, cx| {
                        let at = window.mouse_position();
                        organize.show_menu(
                            PageMenu {
                                at,
                                kind: MenuKind::Organize,
                                open_in: false,
                            },
                            false,
                            window,
                            cx,
                        );
                    }),
            )
            .into_any_element()
    } else {
        let listed = Rc::clone(listed);
        let remove = ctx.clone();
        div()
            .flex()
            .items_center()
            .gap(px(space::M))
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(p.text_secondary)
                    .child(format!("{selected_count} selected")),
            )
            .child(
                PushButton::new("bookmarks-delete", "Delete", &p)
                    .kind(ButtonKind::Primary)
                    .on_click(move |_, _, cx| {
                        let doomed = remove.ui.read(cx).selection.in_order(&listed);
                        remove.remove(doomed, cx)
                    }),
            )
            .into_any_element()
    };
    div()
        .flex_none()
        .h(px(PAGE_TOOLBAR_HEIGHT))
        .px(px(PAGE_TOOLBAR_PAD))
        .flex()
        .items_center()
        .gap(px(space::XL))
        .child(
            div()
                .w(px(PAGE_SIDE_WIDTH))
                .flex_none()
                .text_size(px(22.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text)
                .child("Bookmarks"),
        )
        .child(
            div().flex_1().flex().justify_center().child(
                div()
                    .w_full()
                    .max_w(px(SEARCH_MAX_WIDTH))
                    .h(px(30.))
                    .px(px(space::ML))
                    .rounded(px(radius::TILE))
                    .bg(p.field)
                    .border(px(0.5))
                    .border_color(p.field_border)
                    .flex()
                    .items_center()
                    .gap(px(space::M))
                    .child(icon(Icon::Search, 12., p.text_tertiary))
                    .child(div().flex_1().min_w_0().child(search.clone())),
            ),
        )
        .child(
            div()
                .w(px(PAGE_SIDE_WIDTH))
                .flex_none()
                .flex()
                .justify_end()
                .items_center()
                .gap(px(space::M))
                .child(actions),
        )
        .into_any_element()
}

fn folder_tree(
    ctx: &PageCtx,
    rows: &TreeRows,
    selected: Option<&BookmarkId>,
    into: Option<&BookmarkId>,
    expanded: &HashSet<BookmarkId>,
) -> AnyElement {
    let p = ctx.p;
    let key = format!("bookmarks-tree:{}", ctx.tab);
    let scroll = virtual_list::scroll_handle(key.clone());
    div()
        .id("bookmarks-tree")
        .debug_selector(|| "bookmarks-tree".into())
        .w(px(model::TREE_WIDTH))
        .flex_none()
        .h_full()
        .overflow_y_scroll()
        .track_scroll(&scroll)
        .py(px(space::XS))
        .child(
            virtual_list(key, &scroll)
                .items(rows.items.iter().cloned())
                .render(|index, _| {
                    let row = &rows.rows[index];
                    let id = row.id.clone();
                    let chosen = selected == Some(&row.id);
                    let highlighted = into == Some(&row.id);
                    let open = expanded.contains(&row.id);
                    let select = ctx.clone();
                    let toggle = ctx.clone();
                    let mover = ctx.clone();
                    let target = Target::Folder(id.clone());
                    let toggled = id.clone();
                    let picked = id;
                    div()
                        .flex_none()
                        .rounded(px(radius::CONTROL))
                        .when(highlighted, |this| this.bg(drop_target(&p)))
                        .child(tree_row(
                            ctx.host.as_ref(),
                            ("bookmarks-tree-row", index),
                            row,
                            model::TREE_ROW,
                            chosen,
                            open,
                            &p,
                            move |_, cx| select.open_folder(picked.clone(), cx),
                            move |_, cx| {
                                toggle.ui.update(cx, |ui, cx| {
                                    if !ui.expanded.remove(&toggled) {
                                        ui.expanded.insert(toggled.clone());
                                    }
                                    cx.notify();
                                })
                            },
                        ))
                        .id(("bookmarks-tree-target", index))
                        .on_drag_move::<BookmarkDrag>(move |event, _, cx| {
                            track_drop(&mover, &target, event, cx);
                        })
                        .into_any_element()
                }),
        )
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
pub fn tree_row(
    host: &dyn UiHost,
    id: impl Into<ElementId>,
    row: &model::FolderRow,
    height: f32,
    selected: bool,
    expanded: bool,
    p: &Palette,
    on_select: impl Fn(&mut Window, &mut App) + 'static,
    on_toggle: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let p = *p;
    let id: ElementId = id.into();
    let chevron_ink = if selected {
        gpui::white().opacity(SELECTED_CHEVRON)
    } else {
        p.text_secondary
    };
    div()
        .id(id.clone())
        .h(px(height))
        .rounded(px(radius::CONTROL))
        .flex()
        .items_center()
        .pl(px(space::XS + row.depth as f32 * model::TREE_INDENT))
        .pr(px(space::M))
        .cursor_pointer()
        .when(selected, |this| this.bg(p.form_accent))
        .when(!selected, |this| {
            this.hover(move |style| style.bg(p.row_hover))
        })
        .on_click(move |_, window, cx| on_select(window, cx))
        .child(
            div()
                .id(ElementId::NamedChild(Arc::new(id), "chevron".into()))
                .w(px(model::TREE_CHEVRON_BOX))
                .h(px(height))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .when(row.has_children, |this| {
                    this.on_click(move |_, window, cx| {
                        cx.stop_propagation();
                        on_toggle(window, cx);
                    })
                    .child(crate::bookmarks_bar::sf_semibold(
                        host,
                        if expanded {
                            "chevron.down"
                        } else {
                            "chevron.right"
                        },
                        model::TREE_CHEVRON,
                        model::TREE_CHEVRON_BOX,
                        chevron_ink,
                    ))
                }),
        )
        .child(
            div()
                .size(px(model::TREE_FOLDER_BOX))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .child(crate::bookmarks_bar::sf(
                    host,
                    "folder",
                    model::TREE_FOLDER_ICON,
                    model::TREE_FOLDER_BOX,
                    if selected { p.on_accent } else { p.icon },
                )),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .ml(px(space::S))
                .truncate()
                .text_size(px(13.))
                .text_color(if selected { p.on_accent } else { p.text })
                .child(SharedString::from(row.title.clone())),
        )
        .into_any_element()
}

fn track_drop(
    ctx: &PageCtx,
    target: &Target,
    event: &gpui::DragMoveEvent<BookmarkDrag>,
    cx: &mut App,
) {
    let inside = event.bounds.contains(&event.event.position);
    let height = f32::from(event.bounds.size.height).max(1.0);
    let fraction =
        (f32::from(event.event.position.y - event.bounds.origin.y) / height).clamp(0.0, 1.0);
    let dragging = event.drag(cx).ids.get(cx).to_vec();
    let query = ctx.search.read(cx).text().to_owned();
    ctx.ui.update(cx, |ui, cx| {
        let mine = |drop: &Drop| match (drop, target) {
            (Drop::Into(into), Target::Folder(id)) => into == id,
            (Drop::Into(into), Target::Row { id, .. }) => into == id,
            (Drop::At { index, .. }, Target::Row { index: at, .. }) => {
                *index == *at || *index == at + 1
            }
            _ => false,
        };
        let next = if inside {
            model::drop_for(
                target,
                fraction,
                &dragging,
                ui.folder.as_ref(),
                !query.trim().is_empty(),
            )
        } else if ui.drop.as_ref().is_some_and(mine) {
            None
        } else {
            return;
        };
        if ui.drop != next {
            ui.drop = next;
            cx.notify();
        }
    });
}

struct ListView<'a> {
    tree: Option<&'a BookmarkTree>,
    listing: &'a Rc<Listing>,
    state: &'a BookmarksUi,
    searching: bool,
}

fn list_card(
    ctx: &PageCtx,
    view: ListView,
    query: &str,
    folder_title: &str,
    folder: Option<BookmarkId>,
) -> AnyElement {
    let p = ctx.p;
    let searching = view.searching;
    let empty = view.listing.ids.is_empty();
    let title = if searching {
        format!("Results for “{}”", query.trim())
    } else {
        folder_title.to_owned()
    };
    let open_all = (!searching)
        .then_some(folder)
        .flatten()
        .map(|folder| {
            let opener = ctx.clone();
            PushButton::new("bookmarks-open-all", "Open All", &p)
                .disabled(empty)
                .on_click(move |_, window, cx| {
                    let links: Vec<String> = opener
                        .tree()
                        .map(|tree| {
                            edits::folder_links(&tree, folder.as_str())
                                .into_iter()
                                .map(|(url, _)| url)
                                .collect()
                        })
                        .unwrap_or_default();
                    let _ = window;
                    opener.open_links(links, OpenAll::Tabs, model::FOLDER_MANY, cx);
                })
        });
    let body = match view.tree.filter(|_| !empty) {
        None => {
            let (glyph, text) = if searching {
                ("magnifyingglass", "No search results found")
            } else {
                ("bookmark", "This folder is empty")
            };
            empty_state(ctx.host.as_ref(), glyph, text, &p)
        }
        Some(tree) => rows_view(ctx, tree, &view),
    };
    div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .rounded(px(radius::PANEL))
        .bg(p.group_box)
        .border(px(0.5))
        .border_color(p.group_stroke)
        .overflow_hidden()
        .child(
            div()
                .flex_none()
                .h(px(model::HEADER_HEIGHT))
                .px(px(space::XL))
                .flex()
                .items_center()
                .gap(px(space::M))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.text)
                        .child(title),
                )
                .children(open_all),
        )
        .child(div().flex_none().h(px(1.)).bg(p.divider))
        .child(div().flex_1().min_h_0().child(body))
        .into_any_element()
}

fn empty_state(host: &dyn UiHost, glyph: &str, title: &'static str, p: &Palette) -> AnyElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(space::M))
        .pb(px(80.))
        .child(
            div()
                .size(px(40.))
                .flex()
                .items_center()
                .justify_center()
                .child(crate::bookmarks_bar::sf(
                    host,
                    glyph,
                    30.,
                    40.,
                    p.text_tertiary,
                )),
        )
        .child(
            div()
                .text_size(px(15.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(p.text_secondary)
                .child(title),
        )
        .into_any_element()
}

fn rows_view(ctx: &PageCtx, tree: &BookmarkTree, view: &ListView) -> AnyElement {
    let listing = view.listing;
    let state = view.state;
    let listed = &listing.ids;
    let count = listed.len();
    let width = state.list_width;
    let keys = ctx.clone();
    let key_list = Rc::clone(listed);
    let key = format!("bookmarks-rows:{}", ctx.tab);
    let scroll = virtual_list::scroll_handle(key.clone());
    div()
        .id("bookmarks-list")
        .debug_selector(|| "bookmarks-list".into())
        .size_full()
        .track_focus(&state.focus)
        .child(measure_width(&keys.ui))
        .on_key_down(move |event, _, cx| {
            let key = event.keystroke.key.as_str();
            let command = event.keystroke.modifiers.platform;
            if key == "backspace" || key == "delete" {
                let doomed = keys.ui.read(cx).selection.in_order(&key_list);
                keys.remove(doomed, cx);
            } else if key == "a" && command {
                let all = key_list.to_vec();
                keys.ui.update(cx, |ui, cx| {
                    ui.selection.select_all(&all);
                    cx.notify();
                });
            }
        })
        .child(
            div()
                .id("bookmark-rows")
                .size_full()
                .overflow_y_scroll()
                .track_scroll(&scroll)
                .p(px(space::S))
                .child(
                    virtual_list(key, &scroll)
                        .items(listing.items.iter().cloned())
                        .small_list_rows(0)
                        .render(|index, _| {
                            let row = row_data(
                                tree,
                                &listed[index],
                                index,
                                count,
                                &state.selection,
                                state.drop.as_ref(),
                                view.searching,
                            );
                            match row {
                                Some(row) => bookmark_row(ctx, &row, listed, width),
                                None => div().flex_none().h(px(model::ROW)).into_any_element(),
                            }
                        }),
                ),
        )
        .into_any_element()
}

fn bookmark_row(
    ctx: &PageCtx,
    row: &RowData,
    listed: &Rc<Vec<BookmarkId>>,
    width: f32,
) -> AnyElement {
    let p = ctx.p;
    let group: SharedString = format!("bookmark-row-{}", row.index).into();
    let favicon = row.url.as_ref().map(|url| {
        crate::bookmarks_bar::bookmark_favicon(
            ctx.host.as_ref(),
            &ctx.profile,
            url,
            row.favicon.as_deref(),
            &row.title,
        )
    });
    let ghost_favicon = favicon.clone();
    let glyph = match favicon {
        Some(shown) => render_favicon(&shown, 16., &p),
        None => crate::bookmarks_bar::sf(
            ctx.host.as_ref(),
            "folder",
            model::FOLDER_ICON,
            model::FOLDER_ICON_BOX,
            p.icon,
        ),
    };
    let drag = BookmarkDrag {
        ids: DragIds {
            row: row.id.clone(),
            selection: row.selected.then(|| (ctx.ui.clone(), Rc::clone(listed))),
            resolved: Rc::new(OnceCell::new()),
        },
        label: row.title.clone(),
        detail: row.detail.clone(),
        favicon: ghost_favicon,
        width,
        p,
        host: ctx.host.clone(),
    };
    let target = Target::Row {
        id: row.id.clone(),
        index: row.index,
        folder: row.folder,
    };
    let fill = if row.selected {
        Some(row_selected(&p))
    } else if row.highlighted {
        Some(drop_target(&p))
    } else {
        None
    };
    let click = ctx.clone();
    let middle = ctx.clone();
    let right = ctx.clone();
    let more = ctx.clone();
    let mover = ctx.clone();
    let (id, folder, url, selected) = (row.id.clone(), row.folder, row.url.clone(), row.selected);
    let (middle_url, more_id, right_id) = (row.url.clone(), row.id.clone(), row.id.clone());
    let (click_list, right_list, more_list) =
        (Rc::clone(listed), Rc::clone(listed), Rc::clone(listed));
    let line = |top: bool| {
        div()
            .absolute()
            .left(px(space::M))
            .right(px(space::M))
            .h(px(model::DROP_LINE))
            .rounded(px(model::DROP_LINE / 2.))
            .bg(p.form_accent)
            .when(top, |this| this.top(px(-model::DROP_LINE / 2.)))
            .when(!top, |this| this.bottom(px(-model::DROP_LINE / 2.)))
    };
    div()
        .id(("bookmark-row", row.index))
        .debug_selector({
            let title = row.title.clone();
            move || format!("bookmark-row:{title}")
        })
        .group(group.clone())
        .relative()
        .flex_none()
        .h(px(model::ROW))
        .rounded(px(radius::TILE))
        .flex()
        .items_center()
        .px(px(space::ML))
        .gap(px(space::ML))
        .when_some(fill, |this, fill| this.bg(fill))
        .when(fill.is_none(), |this| {
            this.hover(move |style| style.bg(p.row_hover))
        })
        .on_click(move |event, window, cx| {
            if event.click_count() >= 2 {
                if folder {
                    click.open_folder(id.clone(), cx);
                } else if let Some(url) = url.as_deref() {
                    click.open(url, OpenMode::Current);
                }
                return;
            }
            let modifiers = event.modifiers();
            click.select(
                &click_list,
                &id,
                modifiers.platform || modifiers.control,
                modifiers.shift,
                window,
                cx,
            );
        })
        .on_mouse_down(MouseButton::Middle, move |_, _, _| {
            if let Some(url) = middle_url.as_deref() {
                middle.open(url, OpenMode::Background);
            }
        })
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            cx.stop_propagation();
            right.open_row_menu(&right_id, selected, &right_list, event.position, window, cx);
        })
        .on_drag(drag, |drag, _, _, cx| cx.new(|_| drag.clone()))
        .on_drag_move::<BookmarkDrag>(move |event, _, cx| track_drop(&mover, &target, event, cx))
        .child(glyph)
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_size(px(13.))
                .text_color(p.text)
                .child(row.title.clone()),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(12.))
                .text_color(p.text_tertiary)
                .child(row.detail.clone()),
        )
        .child(
            div()
                .flex_none()
                .opacity(0.)
                .group_hover(group, |style| style.opacity(1.))
                .child(
                    IconButton::new(("bookmark-more", row.index), Icon::Ellipsis, &p)
                        .symbol(ctx.host.clone(), "ellipsis")
                        .tooltip("More actions", &p)
                        .on_click(move |_, window, cx| {
                            let at = window.mouse_position();
                            more.open_row_menu(&more_id, selected, &more_list, at, window, cx);
                        }),
                ),
        )
        .when(row.line_above, |this| this.child(line(true)))
        .when(row.line_below, |this| this.child(line(false)))
        .into_any_element()
}

fn menu_view(
    ctx: &PageCtx,
    menu: &PageMenu,
    searching: bool,
    alternate: bool,
    cx: &App,
) -> AnyElement {
    let items = ctx.menu_items(&menu.kind, searching, cx);
    let (node, ids) = match &menu.kind {
        MenuKind::Rows { node, ids } => (node.clone(), ids.clone()),
        MenuKind::Organize => (BookmarkId::new(""), Vec::new()),
    };
    let chooser = ctx.clone();
    let closer = ctx.clone();
    let toggler = ctx.clone();
    popup::render(
        "bookmark-menu",
        &items,
        menu.at,
        false,
        &ctx.p,
        alternate,
        menu.open_in,
        Rc::new(move |choice: String, window: &mut Window, cx: &mut App| {
            chooser.run_choice(&choice, &node, &ids, window, cx)
        }),
        Rc::new(move |cx: &mut App| closer.close_menu(cx)),
        Rc::new(move |cx: &mut App| {
            toggler.ui.update(cx, |ui, cx| {
                if let Some(menu) = ui.menu.as_mut() {
                    menu.open_in = !menu.open_in;
                }
                cx.notify();
            })
        }),
    )
}

fn row_target(
    tree: &BookmarkTree,
    node: &BookmarkId,
    ids: &[BookmarkId],
    searching: bool,
) -> Option<RowTarget> {
    let nodes: Vec<&BookmarkNode> = ids.iter().filter_map(|id| tree.get(id.as_str())).collect();
    let first = tree.get(node.as_str())?;
    if nodes.len() > 1 {
        let urls = nodes
            .iter()
            .filter(|n| matches!(n, BookmarkNode::Url { .. }))
            .count();
        return Some(RowTarget::Several {
            links: edits::links_of(tree, ids).len(),
            items: nodes.len(),
            noun: match (urls, nodes.len() - urls) {
                (_, 0) => "Bookmarks",
                (0, _) => "Folders",
                _ => "Items",
            },
        });
    }
    Some(match first {
        BookmarkNode::Url { .. } => RowTarget::Url {
            show_path: searching,
        },
        BookmarkNode::Folder { .. } => {
            let links = edits::folder_links(tree, node.as_str()).len();
            RowTarget::Folder {
                links,
                makes_group: crate::bookmarks_bar::groups::makes_group(tree, node),
                restores_arc: crate::bookmarks_bar::groups::restorable_arc_holder(tree, node),
                show_path: searching,
            }
        }
    })
}

fn undo_toast(ctx: &PageCtx, count: usize) -> AnyElement {
    let p = ctx.p;
    let undo = ctx.clone();
    div()
        .absolute()
        .left_0()
        .right_0()
        .bottom(px(space::XXXL))
        .flex()
        .justify_center()
        .child(
            div()
                .id("bookmarks-undo")
                .debug_selector(|| "bookmarks-undo".into())
                .max_w(px(420.))
                .px(px(space::XL))
                .py(px(space::ML))
                .rounded(px(radius::PANEL))
                .bg(p.toast_fill)
                .border(px(0.5))
                .border_color(p.popover_border)
                .flex()
                .items_center()
                .gap(px(space::ML))
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.text)
                        .child(format!("{} deleted", model::plural(count, "item"))),
                )
                .child(
                    div()
                        .debug_selector(|| "bookmarks-undo-action".into())
                        .child(
                            PushButton::new("bookmarks-undo-action", "Undo", &p)
                                .on_click(move |_, _, cx| undo.undo(cx)),
                        ),
                ),
        )
        .into_any_element()
}

fn measure_width(ui: &Entity<BookmarksUi>) -> impl IntoElement {
    let ui = ui.clone();
    gpui::canvas(
        move |bounds, _, cx| {
            let width = crate::scale::points(bounds.size.width) - space::S * 2.0;
            ui.update(cx, |ui, _| ui.list_width = width);
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
}

pub fn resolved_url(text: &str, template: &str) -> String {
    let typed = text.trim();
    if typed
        .get(..11)
        .is_some_and(|head| head.eq_ignore_ascii_case("javascript:"))
    {
        return typed.to_owned();
    }
    resolve_input(typed, template)
}
