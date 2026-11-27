pub mod dialog;
pub mod fit;
pub mod groups;
pub mod menus;
pub mod native;
pub mod popup;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::bookmarks::{BookmarkNode, BookmarkTree};
use ardia_state::settings::{BookmarksBar as BarMode, SettingsPatch};
use ardia_state::windows::{BrowserWindow, Popover, WindowKind};
use ardia_state::{Action, BookmarkId, BrowserState, ProfileId, TabId, WindowId};
use gpui::{
    AnyElement, AnyWindowHandle, App, AsyncApp, Bounds, ClickEvent, Entity, Global, Hsla,
    IntoElement, Modifiers, MouseButton, ParentElement, Pixels, Render, RenderOnce, SharedString,
    Styled, Window, canvas, div, prelude::*,
};

use self::fit::{ItemHit, Spot, ZoneItem};
use crate::content::toolbar::{ToolbarInk, ink};
use crate::host::{NativeMenuItem, UiHost, UtilityWindowKind};
use crate::look::Palette;
use crate::msg::{Emit, Msg};
use crate::pages::bookmarks::edits;
use crate::pages::bookmarks::open::{self, OpenAll, OpenMode};
use crate::primitives::controls::tooltip;
use crate::primitives::favicon::{Favicon, favicon_of, render_favicon, resolve_favicon};
use crate::window::chrome::{Chrome, TabDrag};

pub const MANY_LINKS: usize = 15;
pub const FOLDER_MANY: &str = "This folder has a lot of bookmarks.";
pub const LINKS_MANY: &str = "That's a lot of pages.";
pub const BAR_HINT: &str = "For quick access, place your bookmarks here on the bookmarks bar.";

#[derive(Clone, Debug, PartialEq)]
pub struct Panel {
    pub key: String,
    pub parent: BookmarkId,
    pub from: usize,
    pub anchor: fit::Rect,
    pub level: usize,
}

pub fn panel_key(parent: &BookmarkId, from: usize) -> String {
    if from == 0 {
        parent.to_string()
    } else {
        format!("{parent}+{from}")
    }
}

pub struct BarUi {
    pub panels: Vec<Panel>,
    pub sprung: bool,
    pub last_closed: Option<(String, Instant)>,
    pub hover_generation: u64,
    pub spot: Option<Spot>,
    pub dragging: Option<BookmarkId>,
    pub spring: Option<(BookmarkId, u64)>,
    pub spring_generation: u64,
    pub dialog: Option<dialog::Dialog>,
    pub prompt: Option<dialog::FolderPrompt>,
    pub active_tab: Option<TabId>,
    pub bounds: HashMap<String, Bounds<Pixels>>,
    pub slides: HashMap<String, fit::Slide>,
    pub line_x: Option<fit::Slide>,
    pub line_fade: crate::primitives::tokens::Tween,
    pub drag_x: Option<f32>,
    pub sidebar_edge: SidebarEdge,
    pub appear: HashMap<String, Instant>,
    pub closing: Vec<(Panel, Instant)>,
}

pub fn appear_key(panel: &Panel) -> String {
    format!("{}:{}", panel.level, panel.key)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SidebarEdge {
    pub trailing: bool,
    pub x: f32,
}

impl SidebarEdge {
    pub fn of(c: &Chrome) -> SidebarEdge {
        match c.layout.sidebar {
            Some(rect) if c.layout.trailing => SidebarEdge {
                trailing: true,
                x: rect.x,
            },
            Some(rect) => SidebarEdge {
                trailing: false,
                x: rect.x + rect.w,
            },
            None => SidebarEdge::default(),
        }
    }

    pub fn holds(self, x: f32) -> bool {
        if self.trailing {
            x > self.x
        } else {
            x < self.x
        }
    }
}

impl BarUi {
    fn new() -> Self {
        BarUi {
            panels: Vec::new(),
            sprung: false,
            last_closed: None,
            hover_generation: 0,
            spot: None,
            dragging: None,
            spring: None,
            spring_generation: 0,
            dialog: None,
            prompt: None,
            active_tab: None,
            bounds: HashMap::new(),
            slides: HashMap::new(),
            line_x: None,
            line_fade: crate::primitives::tokens::Tween::at(0.0),
            drag_x: None,
            sidebar_edge: SidebarEdge::default(),
            appear: HashMap::new(),
            closing: Vec::new(),
        }
    }

    fn retire(&mut self, keep: impl Fn(&Panel) -> bool) {
        let now = Instant::now();
        let (kept, gone): (Vec<Panel>, Vec<Panel>) = std::mem::take(&mut self.panels)
            .into_iter()
            .partition(|p| keep(p));
        for panel in gone {
            self.appear.remove(&appear_key(&panel));
            self.closing.push((panel, now));
        }
        self.panels = kept;
    }

    pub fn folder_over_sidebar(&self, folder: bool) -> bool {
        folder && self.spot.is_none() && self.drag_x.is_some_and(|x| self.sidebar_edge.holds(x))
    }

    pub fn menu_open(&self) -> bool {
        !self.panels.is_empty()
    }

    pub fn open_panel(&mut self, panel: Panel, sprung: bool) {
        if self
            .panels
            .iter()
            .any(|p| p.level == panel.level && p.key == panel.key)
        {
            return;
        }
        let level = panel.level;
        self.retire(|p| p.level < level);
        self.sprung = if level == 0 {
            sprung
        } else {
            self.sprung || sprung
        };
        let now = Instant::now();
        self.closing
            .retain(|(gone, _)| appear_key(gone) != appear_key(&panel));
        self.appear.insert(appear_key(&panel), now);
        self.panels.push(panel);
    }

    pub fn toggle_panel(&mut self, panel: Panel) {
        let open = self
            .panels
            .iter()
            .find(|p| p.level == 0)
            .map(|p| p.key.clone());
        if open.as_ref() == Some(&panel.key) {
            self.close_all(false);
            return;
        }
        if self.last_closed.as_ref().is_some_and(|(key, at)| {
            key == &panel.key && at.elapsed() < Duration::from_millis(fit::TOGGLE_CLOSE_MS)
        }) {
            return;
        }
        self.open_panel(Panel { level: 0, ..panel }, false);
    }

    pub fn close_above(&mut self, level: usize) {
        self.retire(|p| p.level <= level);
    }

    pub fn close_all(&mut self, outside: bool) {
        if outside && let Some(root) = self.panels.iter().find(|p| p.level == 0) {
            self.last_closed = Some((root.key.clone(), Instant::now()));
        }
        self.retire(|_| false);
        self.sprung = false;
    }

    pub fn rect(&self, key: &str) -> Option<fit::Rect> {
        self.bounds.get(key).map(|b| fit::Rect {
            x: crate::scale::points(b.origin.x),
            y: crate::scale::points(b.origin.y),
            w: crate::scale::points(b.size.width),
            h: crate::scale::points(b.size.height),
        })
    }
}

#[derive(Default)]
struct BarWindows(HashMap<WindowId, Entity<BarUi>>);

impl Global for BarWindows {}

pub fn escape(window: &WindowId, cx: &mut App) -> bool {
    let Some(ui) = cx
        .try_global::<BarWindows>()
        .and_then(|all| all.0.get(window).cloned())
    else {
        return false;
    };
    ui.update(cx, |ui, cx| {
        if ui.panels.is_empty() {
            return false;
        }
        ui.close_all(false);
        cx.notify();
        true
    })
}

pub fn ui_for(window: &WindowId, cx: &mut App) -> Entity<BarUi> {
    if let Some(found) = cx
        .try_global::<BarWindows>()
        .and_then(|all| all.0.get(window).cloned())
    {
        return found;
    }
    let made = cx.new(|_| BarUi::new());
    cx.default_global::<BarWindows>()
        .0
        .insert(window.clone(), made.clone());
    made
}

pub fn bookmark_profile(profile: &ProfileId) -> ProfileId {
    if profile.is_incognito() {
        profile.incognito_original()
    } else {
        profile.clone()
    }
}

pub fn shown_in(state: &BrowserState, window: &BrowserWindow) -> bool {
    match state.settings.bookmarks_bar {
        BarMode::Always => true,
        BarMode::Never => false,
        BarMode::NewTab => state
            .active_tab(window.id.as_str())
            .is_none_or(|t| t.url.is_empty()),
    }
}

pub fn bar_height(state: &BrowserState, window: &BrowserWindow, full_screen: bool) -> f32 {
    let active = state.active_tab(window.id.as_str());
    let in_split = active.is_some_and(|t| state.split_of(t.id.as_str()).is_some());
    let shown = active.is_some()
        && shown_in(state, window)
        && !full_screen
        && !in_split
        && window.kind != WindowKind::LittleArdia;
    if shown { fit::HEIGHT } else { 0.0 }
}

pub fn open_mode_for(modifiers: Modifiers, middle: bool) -> OpenMode {
    if modifiers.platform || middle {
        return if modifiers.shift {
            OpenMode::Foreground
        } else {
            OpenMode::Background
        };
    }
    if modifiers.alt {
        return OpenMode::Split;
    }
    if modifiers.shift {
        return OpenMode::Window;
    }
    OpenMode::Current
}

#[derive(Clone)]
pub struct BarCtx {
    pub ui: Entity<BarUi>,
    pub host: Arc<dyn UiHost>,
    pub emit: Emit,
    pub window: WindowId,
    pub profile: ProfileId,
    pub p: Palette,
    pub glass: bool,
    pub split: bool,
}

impl BarCtx {
    pub fn for_window(
        host: &Arc<dyn UiHost>,
        emit: &Emit,
        window: &WindowId,
        p: &Palette,
        glass: bool,
        cx: &mut App,
    ) -> Option<Self> {
        let profile = host
            .store()
            .snapshot()
            .window(window.as_str())
            .map(|w| bookmark_profile(&w.profile_id))?;
        Some(BarCtx {
            ui: ui_for(window, cx),
            host: Arc::clone(host),
            emit: emit.clone(),
            window: window.clone(),
            profile,
            p: *p,
            glass,
            split: true,
        })
    }

    pub fn of(c: &Chrome, cx: &mut App) -> Self {
        BarCtx {
            ui: ui_for(&c.window.id, cx),
            host: Arc::clone(c.host),
            emit: c.emit.clone(),
            window: c.window.id.clone(),
            profile: bookmark_profile(&c.window.profile_id),
            p: *c.p,
            glass: c.look.glass,
            split: true,
        }
    }

    pub fn tree(&self) -> Option<Arc<BookmarkTree>> {
        self.host
            .store()
            .snapshot()
            .bookmarks_of(&self.profile)
            .cloned()
    }

    pub fn open(&self, url: &str, mode: OpenMode) {
        open::open_url(&self.host, &self.window, url, mode);
    }

    pub fn open_links(&self, urls: Vec<String>, mode: OpenAll, many: &'static str, cx: &mut App) {
        open_links_checked(
            Arc::clone(&self.host),
            self.window.clone(),
            urls,
            mode,
            many,
            cx,
        );
    }
}

pub fn open_links_checked(
    host: Arc<dyn UiHost>,
    window: WindowId,
    urls: Vec<String>,
    mode: OpenAll,
    many: &'static str,
    cx: &mut App,
) {
    let urls: Vec<String> = urls
        .into_iter()
        .filter(|url| !is_bookmarklet(url))
        .collect();
    if urls.is_empty() {
        return;
    }
    if urls.len() <= MANY_LINKS {
        open::open_links(&host, &window, &urls, mode);
        return;
    }
    let answer = host.confirm_in_window(
        window.clone(),
        crate::host::Confirmation {
            title: format!("Open {} tabs?", urls.len()),
            message: many.to_owned(),
            confirm: "Open All".to_owned(),
            destructive: false,
        },
    );
    cx.spawn(async move |_: &mut AsyncApp| {
        if answer.await.unwrap_or(false) {
            open::open_links(&host, &window, &urls, mode);
        }
    })
    .detach();
}

pub fn is_bookmarklet(url: &str) -> bool {
    url.trim_start()
        .get(..11)
        .is_some_and(|head| head.eq_ignore_ascii_case("javascript:"))
}

pub fn open_bookmark_url(host: &Arc<dyn UiHost>, window: &WindowId, url: &str, mode: OpenMode) {
    if is_bookmarklet(url) {
        let active = host
            .store()
            .snapshot()
            .active_tab(window.as_str())
            .map(|t| t.id.clone());
        if let Some(tab) = active {
            host.run_bookmarklet(tab, url.trim().to_owned());
        }
        return;
    }
    open::open_url(host, window, url, mode);
}

pub fn copy_links(links: &[(String, String)], markdown: bool, cx: &mut App) {
    if links.is_empty() {
        return;
    }
    let text = open::copy_text(links, markdown);
    cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
}

pub fn run_link_choice(
    host: &Arc<dyn UiHost>,
    window: &WindowId,
    choice: &str,
    links: &[(String, String)],
    many: &'static str,
    cx: &mut App,
) -> bool {
    let one = (links.len() == 1).then(|| links[0].0.clone());
    let mode = match choice {
        "tab" => Some(OpenMode::Foreground),
        "window" => Some(OpenMode::Window),
        "incognito" => Some(OpenMode::Incognito),
        "split" => Some(OpenMode::Split),
        _ => None,
    };
    if let (Some(url), Some(mode)) = (one.as_ref(), mode) {
        open_bookmark_url(host, window, url, mode);
        return true;
    }
    let all = match choice {
        "openAll" => Some(OpenAll::Tabs),
        "openAllWindow" => Some(OpenAll::Window),
        "openAllIncognito" => Some(OpenAll::Incognito),
        _ => None,
    };
    if let Some(mode) = all {
        let urls = links.iter().map(|(url, _)| url.clone()).collect();
        open_links_checked(Arc::clone(host), window.clone(), urls, mode, many, cx);
        return true;
    }
    if choice == "copy" || choice == "copyMarkdown" {
        copy_links(links, choice == "copyMarkdown", cx);
        return true;
    }
    false
}

pub fn exports_bookmarks() -> bool {
    true
}

pub fn add_folder_to_sidebar(
    host: &Arc<dyn UiHost>,
    folder: &BookmarkId,
    window: &WindowId,
    profile: &ProfileId,
) {
    let made = groups::add_folder_groups(
        host,
        Some(window),
        profile,
        std::slice::from_ref(folder),
        false,
    );
    groups::note_left_out(host, &made);
}

pub fn restore_arc(
    host: &Arc<dyn UiHost>,
    holder: &BookmarkId,
    window: &WindowId,
    profile: &ProfileId,
) {
    groups::restore_arc_folders(host, holder, Some(window), profile);
}

pub fn menu_alternate(window: &Window) -> bool {
    window.modifiers().alt
}

pub fn show_native(
    host: &Arc<dyn UiHost>,
    items: Vec<NativeMenuItem>,
    cx: &mut App,
    run: impl FnOnce(String, &mut App) + 'static,
) -> bool {
    let Some(answer) = host.show_menu(items) else {
        return false;
    };
    cx.spawn(async move |cx: &mut AsyncApp| {
        if let Ok(Some(choice)) = answer.await {
            cx.update(|cx| run(choice, cx));
        }
    })
    .detach();
    true
}

pub fn bar_target(tree: &BookmarkTree, node: &BookmarkId) -> native::BarTarget {
    match tree.get(node.as_str()) {
        Some(BookmarkNode::Folder { .. }) => native::BarTarget::Folder {
            links: edits::folder_links(tree, node.as_str()).len(),
            makes_group: groups::makes_group(tree, node),
            restores_arc: groups::restorable_arc_holder(tree, node),
        },
        Some(BookmarkNode::Url { .. }) => native::BarTarget::Url,
        None => native::BarTarget::Bar,
    }
}

pub fn open_bar_menu(
    ctx: &BarCtx,
    node: Option<BookmarkId>,
    window_handle: AnyWindowHandle,
    cx: &mut App,
) {
    let Some(tree) = ctx.tree() else {
        return;
    };
    let state = ctx.host.store().snapshot();
    let shown = state
        .window(ctx.window.as_str())
        .is_some_and(|w| shown_in(&state, w));
    let target = node
        .as_ref()
        .map_or(native::BarTarget::Bar, |id| bar_target(&tree, id));
    let items = native::bar_menu(&target, shown, ctx.split);
    let run_ctx = ctx.clone();
    show_native(&ctx.host, items, cx, move |choice, cx| {
        run_bar_choice(&run_ctx, node, &choice, window_handle, cx)
    });
}

fn run_bar_choice(
    ctx: &BarCtx,
    node: Option<BookmarkId>,
    choice: &str,
    window_handle: AnyWindowHandle,
    cx: &mut App,
) {
    let Some(tree) = ctx.tree() else {
        return;
    };
    let found = node.as_ref().and_then(|id| tree.get(id.as_str()).cloned());
    match &found {
        Some(BookmarkNode::Url { url, title, .. }) => {
            if run_link_choice(
                &ctx.host,
                &ctx.window,
                choice,
                &[(url.clone(), title.clone())],
                LINKS_MANY,
                cx,
            ) {
                return;
            }
        }
        Some(BookmarkNode::Folder { id, .. }) => {
            let links = edits::folder_links(&tree, id.as_str());
            if run_link_choice(&ctx.host, &ctx.window, choice, &links, FOLDER_MANY, cx) {
                return;
            }
            match choice {
                "addGroup" => add_folder_to_sidebar(&ctx.host, id, &ctx.window, &ctx.profile),
                "restoreArc" => restore_arc(&ctx.host, id, &ctx.window, &ctx.profile),
                _ => {}
            }
        }
        None => {}
    }
    let node_id = found.as_ref().map(|n| n.id().clone());
    let parent = found
        .as_ref()
        .and_then(BookmarkNode::parent)
        .cloned()
        .unwrap_or_else(|| tree.bar());
    let index = node_id
        .as_ref()
        .and_then(|id| tree.children(parent.as_str()).iter().position(|c| c == id))
        .map(|at| at + 1);
    match choice {
        "edit" | "rename" => {
            if let Some(id) = node_id {
                let _ = window_handle.update(cx, |_, window, cx| {
                    dialog::open_editor(ctx, Some(id), false, None, None, window, cx)
                });
            }
        }
        "delete" => {
            if let Some(id) = node_id {
                edits::remove_many(ctx.host.store(), &ctx.profile, std::slice::from_ref(&id));
            }
        }
        "addPage" => {
            let _ = window_handle.update(cx, |_, window, cx| {
                dialog::open_editor(ctx, None, false, Some(parent.clone()), index, window, cx)
            });
        }
        "addFolder" => dialog::prompt_new_folder(ctx, parent, index, None, cx),
        "manage" => ctx.host.dispatch(Action::SetPopover {
            window: ctx.window.clone(),
            popover: Some(Popover::Custom("command:manageBookmarks".into())),
        }),
        "toggleBar" => {
            let state = ctx.host.store().snapshot();
            let shown = state
                .window(ctx.window.as_str())
                .is_some_and(|w| shown_in(&state, w));
            ctx.host.dispatch(Action::UpdateSettings {
                patch: SettingsPatch::new()
                    .set("bookmarksBar", if shown { "never" } else { "always" }),
                from_sync: false,
            });
        }
        _ => {}
    }
}

impl BarDrag {
    pub fn restarted(&self) -> BarDrag {
        BarDrag {
            since: Instant::now(),
            ..self.clone()
        }
    }
}

pub fn ghost_shown(since: Instant, now: Instant) -> f32 {
    let progress = now.saturating_duration_since(since).as_secs_f32()
        / Duration::from_millis(fit::HOVER_IN_MS).as_secs_f32();
    crate::primitives::tokens::Curve::Enter.ease(progress.min(1.0))
}

#[derive(Clone)]
pub struct BarDrag {
    pub ui: Entity<BarUi>,
    pub since: Instant,
    pub id: BookmarkId,
    pub title: SharedString,
    pub favicon: Option<Favicon>,
    pub folder: bool,
    pub host: Arc<dyn UiHost>,
    pub width: f32,
    pub p: Palette,
}

impl Render for BarDrag {
    fn render(&mut self, window: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let p = self.p;
        let shown = ghost_shown(self.since, Instant::now());
        if shown < 1.0 {
            window.request_animation_frame();
        }
        let to_sidebar = self.ui.read(cx).folder_over_sidebar(self.folder);
        div()
            .w(px(self.width.max(fit::ITEM)))
            .h(px(fit::ITEM))
            .px(px(fit::PADDING))
            .rounded(px(fit::RADIUS))
            .bg(p.panel)
            .border(px(if to_sidebar { fit::DROP_RING } else { 0.5 }))
            .border_color(if to_sidebar {
                p.accent
            } else {
                p.popover_border
            })
            .shadow(crate::primitives::tokens::shadows(
                &crate::primitives::tokens::shadow::POPOVER,
                p.dark,
            ))
            .opacity(fit::GHOST_OPACITY * shown)
            .flex()
            .items_center()
            .gap(px(fit::TITLE_GAP))
            .child(match self.favicon.as_ref() {
                Some(shown) => render_favicon(shown, fit::FAVICON, &p),
                None if self.folder => sf(
                    self.host.as_ref(),
                    "folder",
                    fit::ICON,
                    fit::ICON_BOX,
                    p.icon,
                ),
                None => div().into_any_element(),
            })
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(fit::TEXT))
                    .text_color(p.text)
                    .child(self.title.clone()),
            )
    }
}

#[allow(clippy::too_many_arguments)]
pub fn chip_icon(
    host: &dyn UiHost,
    favicon: Option<&Favicon>,
    folder: bool,
    p: &Palette,
    tint: Hsla,
    favicon_size: f32,
    icon_size: f32,
    icon_box: f32,
) -> AnyElement {
    match favicon {
        Some(shown) => render_favicon(shown, favicon_size, p),
        None if folder => sf(host, "folder", icon_size, icon_box, tint),
        None => div().into_any_element(),
    }
}

pub fn bookmark_favicon(
    host: &dyn UiHost,
    profile: &ProfileId,
    url: &str,
    favicon: Option<&str>,
    title: &str,
) -> Favicon {
    let page = favicon
        .filter(|f| !f.trim().is_empty())
        .is_none()
        .then(|| host.page_favicon(profile, url))
        .flatten();
    match page {
        Some(image) => Favicon::Image(image),
        None => resolve_favicon(favicon_of(url, favicon, None, title), host, profile),
    }
}

pub fn sf(host: &dyn UiHost, name: &str, size: f32, frame: f32, color: Hsla) -> AnyElement {
    crate::icon_picker::symbols::symbol(
        host,
        name,
        size,
        frame,
        crate::icon_picker::symbols::SymbolWeight::Regular,
        color,
    )
}

pub fn sf_semibold(
    host: &dyn UiHost,
    name: &str,
    size: f32,
    frame: f32,
    color: Hsla,
) -> AnyElement {
    crate::icon_picker::symbols::symbol(
        host,
        name,
        size,
        frame,
        crate::icon_picker::symbols::SymbolWeight::Semibold,
        color,
    )
}

pub fn measure(ui: &Entity<BarUi>, key: String) -> impl IntoElement {
    let ui = ui.clone();
    canvas(
        move |bounds, _, cx| {
            ui.update(cx, |ui, _| {
                ui.bounds.insert(key, bounds);
            });
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
}

struct Item {
    id: BookmarkId,
    title: String,
    url: Option<String>,
    favicon: Option<Favicon>,
    folder: bool,
    width: f32,
}

fn text_width(text: &str, window: &mut Window) -> f32 {
    if text.is_empty() {
        return 0.0;
    }
    let font = window.text_style().font();
    let run = gpui::TextRun {
        len: text.len(),
        font,
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let shaped = window.text_system().shape_line(
        SharedString::from(text.to_owned()),
        px(fit::TEXT),
        std::slice::from_ref(&run),
        None,
    );
    crate::scale::points(shaped.width).ceil()
}

#[derive(IntoElement)]
pub struct BarView {
    ctx: BarCtx,
    tree: Option<Arc<BookmarkTree>>,
    width: f32,
    ink: ToolbarInk,
    import_dismissed: bool,
    window_handle: AnyWindowHandle,
}

pub fn bookmarks_bar(c: &Chrome, width: f32, window: &Window, cx: &mut App) -> AnyElement {
    let ctx = BarCtx::of(c, cx);
    let edge = SidebarEdge::of(c);
    ctx.ui.update(cx, |ui, _| ui.sidebar_edge = edge);
    BarView {
        tree: c.state.bookmarks_of(&ctx.profile).cloned(),
        import_dismissed: c.state.settings.bookmarks_import_dismissed,
        ink: ink(c),
        width,
        window_handle: window.window_handle(),
        ctx,
    }
    .into_any_element()
}

impl RenderOnce for BarView {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ctx = self.ctx.clone();
        let ink = self.ink;
        let p = ctx.p;
        let Some(tree) = self.tree.clone() else {
            return div().into_any_element();
        };
        let bar_root = tree.bar();
        let other_root = tree.other();
        let has_other = !tree.children(other_root.as_str()).is_empty();
        if !cx.has_active_drag() && ctx.ui.read(cx).dragging.is_some() {
            finish_stray_drag(&ctx, &tree, cx);
        }
        let ui = ctx.ui.read(cx);
        let open_root = ui
            .panels
            .iter()
            .find(|p| p.level == 0)
            .map(|p| p.parent.clone());
        let spot = ui.spot.clone();
        let dragging = ui.dragging.clone();
        let other_width = if has_other {
            1.0 + 12.0 + fit::chip_width(Some(text_width("Other Bookmarks", window)), fit::ICON_BOX)
        } else {
            0.0
        };
        let room = (self.width - fit::PADDING * 2.0 - other_width).max(0.0);
        let children: Vec<BookmarkId> = tree.children(bar_root.as_str()).to_vec();
        let mut items: Vec<Item> = Vec::new();
        let mut used = 0.0;
        for id in &children {
            if used >= room {
                break;
            }
            let Some(node) = tree.get(id.as_str()) else {
                continue;
            };
            let title = node.title().trim().to_owned();
            let (url, favicon, folder) = match node {
                BookmarkNode::Url { url, favicon, .. } => (
                    Some(url.clone()),
                    Some(bookmark_favicon(
                        ctx.host.as_ref(),
                        &ctx.profile,
                        url,
                        favicon.as_deref(),
                        &title,
                    )),
                    false,
                ),
                BookmarkNode::Folder { .. } => (None, None, true),
            };
            let icon_width = if folder { fit::ICON_BOX } else { fit::FAVICON };
            let width = fit::chip_width(
                (!title.is_empty()).then(|| text_width(&title, window)),
                icon_width,
            );
            used += width + fit::ITEM_GAP;
            items.push(Item {
                id: id.clone(),
                title,
                url,
                favicon,
                folder,
                width,
            });
        }
        let widths: Vec<f32> = items.iter().map(|i| i.width).collect();
        let (shown_fit, _) = fit::bar_fit(&widths, room, fit::OVERFLOW_WIDTH, fit::ITEM_GAP);
        let hidden_from = shown_fit.shown;
        let overflow = room > 0.0 && hidden_from < children.len();
        let line_slot = match &spot {
            Some(Spot::Slot { parent, slot }) if parent == &bar_root => Some(*slot),
            _ => None,
        };
        let into = match &spot {
            Some(Spot::Into(id)) => Some(id.clone()),
            _ => None,
        };
        let now = Instant::now();
        let shown_ids: Vec<BookmarkId> = items
            .iter()
            .take(hidden_from)
            .map(|i| i.id.clone())
            .collect();
        let dragged_at = dragging
            .as_ref()
            .and_then(|d| shown_ids.iter().position(|id| id == d));
        let room_width = match dragged_at {
            Some(at) => items[at].width + fit::ITEM_GAP,
            None => fit::ITEM * 2.0,
        };
        let offsets = if cx.has_active_drag() {
            fit::room_offsets(shown_ids.len(), dragged_at, line_slot, room_width)
        } else {
            vec![0.0; shown_ids.len()]
        };
        let bar_x = ctx.ui.read(cx).rect("bar").map(|b| b.x);
        let frames: Vec<Option<(f32, f32)>> = shown_ids
            .iter()
            .map(|id| {
                let rect = ctx.ui.read(cx).rect(&format!("bar:{id}"))?;
                Some((rect.x - bar_x? - fit::PADDING, rect.w))
            })
            .collect();
        let target_line = line_slot.and_then(|slot| {
            bar_x?;
            Some(fit::drop_line_x(
                &frames, &offsets, dragged_at, slot, room_width,
            ))
        });
        let (slid, line, line_opacity, moving) = ctx.ui.update(cx, |ui, _| {
            let mut moving = false;
            let slid: Vec<f32> = shown_ids
                .iter()
                .zip(&offsets)
                .map(|(id, offset)| {
                    let slide = ui
                        .slides
                        .entry(format!("bar:{id}"))
                        .or_insert_with(|| fit::Slide::at(*offset, now));
                    slide.retarget(*offset, now);
                    moving |= slide.running(now);
                    slide.value(now)
                })
                .collect();
            ui.slides.retain(|key, slide| {
                shown_ids.iter().any(|id| key == &format!("bar:{id}")) || slide.running(now)
            });
            let shown = target_line.is_some();
            let fade_to = if shown { 1.0 } else { 0.0 };
            {
                let ms = if shown {
                    fit::HOVER_IN_MS
                } else {
                    fit::HOVER_OUT_MS
                };
                ui.line_fade.retarget(
                    fade_to,
                    Duration::from_millis(ms),
                    crate::primitives::tokens::Curve::Enter,
                    now,
                );
            }
            if let Some(x) = target_line {
                match ui.line_x.as_mut() {
                    Some(line) if ui.line_fade.value(now) > 0.0 => line.retarget(x, now),
                    _ => ui.line_x = Some(fit::Slide::at(x, now)),
                }
            }
            moving |= ui.line_fade.running(now) || ui.line_x.is_some_and(|line| line.running(now));
            (
                slid,
                ui.line_x.map(|line| line.value(now)),
                ui.line_fade.value(now),
                moving,
            )
        });
        if moving {
            window.request_animation_frame();
        }
        let line_x = line.filter(|_| line_opacity > 0.0);
        let shown_items = items.iter().take(hidden_from);
        let mut row = div()
            .flex_1()
            .min_w_0()
            .h(px(fit::ITEM))
            .flex()
            .items_center()
            .overflow_hidden();
        if children.is_empty() && !self.import_dismissed {
            row = row.child(import_button(&ctx, ink, self.window_handle));
        } else if children.is_empty() {
            row = row.child(
                div()
                    .ml(px(4.))
                    .text_size(px(fit::TEXT))
                    .text_color(ink.secondary.opacity(0.75))
                    .child(BAR_HINT),
            );
        } else {
            for (index, item) in shown_items.enumerate() {
                let active = open_root.as_ref() == Some(&item.id);
                let ring = into.as_ref() == Some(&item.id);
                let hidden = dragging.as_ref() == Some(&item.id) && cx.has_active_drag();
                row = row.child(bar_item(
                    &ctx,
                    item,
                    ink,
                    active,
                    ring,
                    hidden,
                    slid.get(index).copied().unwrap_or(0.0),
                    self.window_handle,
                ));
            }
        }
        let overflow_button = overflow.then(|| {
            let opener = ctx.clone();
            let root = bar_root.clone();
            div()
                .relative()
                .child(measure(&ctx.ui, "overflow".into()))
                .child(chip(
                    ctx.host.as_ref(),
                    "bookmarks-bar-overflow",
                    None,
                    Some("chevron.right.2"),
                    None,
                    Some(fit::OVERFLOW_WIDTH),
                    ink,
                    false,
                    false,
                    &p,
                    Some("More bookmarks".into()),
                    move |_, _, cx| {
                        let Some(anchor) = opener.ui.read(cx).rect("overflow") else {
                            return;
                        };
                        let key = panel_key(&root, hidden_from);
                        opener.ui.update(cx, |ui, cx| {
                            ui.toggle_panel(Panel {
                                key,
                                parent: root.clone(),
                                from: hidden_from,
                                anchor,
                                level: 0,
                            });
                            cx.notify();
                        });
                    },
                ))
        });
        let other = has_other.then(|| {
            let opener = ctx.clone();
            let root = other_root.clone();
            let active = open_root.as_ref() == Some(&other_root);
            let ring = into.as_ref() == Some(&other_root);
            div()
                .flex()
                .items_center()
                .child(
                    div()
                        .w(px(1.))
                        .h(px(fit::DIVIDER_HEIGHT))
                        .mx(px(6.))
                        .bg(ink.divider),
                )
                .child(
                    div()
                        .relative()
                        .child(measure(&ctx.ui, "other".into()))
                        .child(chip(
                            ctx.host.as_ref(),
                            "bookmarks-bar-other",
                            None,
                            Some("folder"),
                            Some("Other Bookmarks".into()),
                            None,
                            ink,
                            active,
                            ring,
                            &p,
                            None,
                            move |_, _, cx| {
                                let Some(anchor) = opener.ui.read(cx).rect("other") else {
                                    return;
                                };
                                opener.ui.update(cx, |ui, cx| {
                                    ui.toggle_panel(Panel {
                                        key: panel_key(&root, 0),
                                        parent: root.clone(),
                                        from: 0,
                                        anchor,
                                        level: 0,
                                    });
                                    cx.notify();
                                });
                            },
                        )),
                )
        });
        let menu_ctx = ctx.clone();
        let menu_handle = self.window_handle;
        let mover = ctx.clone();
        let tab_mover = ctx.clone();
        let dropper = ctx.clone();
        let tab_dropper = ctx.clone();
        let link_mover = ctx.clone();
        let link_dropper = ctx.clone();
        let ink_accent = p.accent;
        div()
            .id("bookmarks-bar")
            .debug_selector(|| "bookmarks-bar".into())
            .relative()
            .size_full()
            .when_some(ink.fill, |this, fill| this.bg(fill))
            .flex()
            .items_center()
            .px(px(fit::PADDING))
            .child(measure(&ctx.ui, "bar".into()))
            .on_mouse_down(MouseButton::Right, move |_, _, cx| {
                cx.stop_propagation();
                open_bar_menu(&menu_ctx, None, menu_handle, cx);
            })
            .on_drag_move::<BarDrag>(move |event, _, cx| {
                let x = crate::scale::points(event.event.position.x);
                mover.ui.update(cx, |ui, _| ui.drag_x = Some(x));
                let inside = event.bounds.contains(&event.event.position);
                let dragged = event.drag(cx).id.clone();
                track_bar(&mover, inside, event.event.position, Some(&dragged), cx);
            })
            .on_drag_move::<TabDrag>(move |event, _, cx| {
                let inside = event.bounds.contains(&event.event.position);
                track_bar(&tab_mover, inside, event.event.position, None, cx);
            })
            .on_drag_move::<gpui::ExternalItems>(move |event, _, cx| {
                let inside = event.bounds.contains(&event.event.position);
                track_bar(&link_mover, inside, event.event.position, None, cx);
            })
            .on_drop::<gpui::ExternalItems>(move |items, _, cx| {
                drop_links(&link_dropper, items, cx)
            })
            .on_drop::<BarDrag>(move |drag, _, cx| drop_bookmark(&dropper, &drag.id, cx))
            .on_drop::<TabDrag>(move |drag, _, cx| drop_tab(&tab_dropper, &drag.tab, cx))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h(px(fit::ITEM))
                    .flex()
                    .items_center()
                    .relative()
                    .child(row)
                    .children(overflow_button)
                    .when_some(line_x, |this, x| {
                        this.child(
                            div()
                                .absolute()
                                .opacity(line_opacity)
                                .left(px(x - fit::DROP_LINE / 2.))
                                .top(px(fit::DROP_LINE_INSET))
                                .w(px(fit::DROP_LINE))
                                .h(px(fit::ITEM - fit::DROP_LINE_INSET * 2.))
                                .rounded(px(1.))
                                .bg(ink_accent),
                        )
                    }),
            )
            .children(other)
            .into_any_element()
    }
}

#[allow(clippy::too_many_arguments)]
fn chip(
    host: &dyn UiHost,
    id: impl Into<gpui::ElementId>,
    favicon: Option<&Favicon>,
    glyph: Option<&'static str>,
    title: Option<SharedString>,
    width: Option<f32>,
    ink: ToolbarInk,
    active: bool,
    ring: bool,
    p: &Palette,
    tip: Option<SharedString>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> gpui::Stateful<gpui::Div> {
    let p = *p;
    let titled = title.is_some();
    let base = div()
        .id(id)
        .h(px(fit::ITEM))
        .flex_none()
        .max_w(px(fit::ITEM_MAX_WIDTH))
        .rounded(px(fit::RADIUS))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(fit::TITLE_GAP))
        .cursor_pointer();
    let base = match width {
        Some(width) => base.w(px(width)),
        None if titled => base.px(px(fit::PADDING)),
        None => base.min_w(px(fit::ITEM)),
    };
    let icon_el = match (favicon, glyph) {
        (Some(f), _) => Some(render_favicon(f, fit::FAVICON, &p)),
        (None, Some(g)) => Some(sf(host, g, fit::ICON, fit::ICON_BOX, ink.icon)),
        _ => None,
    };
    base.when(active, |this| this.bg(ink.pressed))
        .when(!active, |this| {
            this.hover(move |style| style.bg(ink.hover))
                .active(move |style| style.bg(ink.pressed))
        })
        .when(ring, |this| {
            this.bg(ink.hover)
                .border(px(fit::DROP_RING))
                .border_color(p.accent)
        })
        .children(icon_el)
        .when_some(title, |this, title| {
            this.child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(fit::TEXT))
                    .text_color(if ink.fill.is_some() {
                        ink.text
                    } else {
                        p.text_tab
                    })
                    .child(title),
            )
        })
        .when_some(tip, |this, tip| this.tooltip(tooltip(tip, &p)))
        .on_click(on_click)
}

#[allow(clippy::too_many_arguments)]
fn bar_item(
    ctx: &BarCtx,
    item: &Item,
    ink: ToolbarInk,
    active: bool,
    ring: bool,
    hidden: bool,
    offset: f32,
    window_handle: AnyWindowHandle,
) -> AnyElement {
    let p = ctx.p;
    let key = format!("bar:{}", item.id);
    let tip: SharedString = match &item.url {
        Some(url) if !item.title.is_empty() => format!("{}\n{url}", item.title).into(),
        Some(url) => url.clone().into(),
        None => item.title.clone().into(),
    };
    let clicker = ctx.clone();
    let hover = ctx.clone();
    let middle = ctx.clone();
    let menu = ctx.clone();
    let (id, url, folder) = (item.id.clone(), item.url.clone(), item.folder);
    let (hover_id, middle_url, menu_id) = (item.id.clone(), item.url.clone(), item.id.clone());
    let drag = BarDrag {
        ui: ctx.ui.clone(),
        since: Instant::now(),
        id: item.id.clone(),
        title: item.title.clone().into(),
        favicon: item.favicon.clone(),
        folder: item.folder,
        host: ctx.host.clone(),
        width: item.width,
        p,
    };
    let title = (!item.title.is_empty()).then(|| SharedString::from(item.title.clone()));
    let glyph = folder.then_some("folder");
    let selector = format!("bookmarks-bar-item:{}", item.title);
    div()
        .id(gpui::ElementId::Name(
            format!("bookmarks-bar-item:{}", item.id).into(),
        ))
        .relative()
        .flex_none()
        .debug_selector(move || selector)
        .when(hidden, |this| this.opacity(0.))
        .child(measure(&ctx.ui, key))
        .on_hover(move |hovered, _, cx| {
            if !*hovered || !folder {
                return;
            }
            let open = hover.ui.read(cx).menu_open() && hover.ui.read(cx).dragging.is_none();
            if !open {
                return;
            }
            let Some(anchor) = hover.ui.read(cx).rect(&format!("bar:{hover_id}")) else {
                return;
            };
            let parent = hover_id.clone();
            hover.ui.update(cx, |ui, cx| {
                ui.open_panel(
                    Panel {
                        key: panel_key(&parent, 0),
                        parent,
                        from: 0,
                        anchor,
                        level: 0,
                    },
                    false,
                );
                cx.notify();
            });
        })
        .on_mouse_down(MouseButton::Middle, move |event, _, _| {
            if let Some(url) = middle_url.as_deref() {
                open_bookmark_url(
                    &middle.host,
                    &middle.window,
                    url,
                    open_mode_for(event.modifiers, true),
                );
            }
        })
        .on_mouse_down(MouseButton::Right, move |_, _, cx| {
            cx.stop_propagation();
            open_bar_menu(&menu, Some(menu_id.clone()), window_handle, cx);
        })
        .child(
            div().relative().left(px(offset)).child(
                chip(
                    ctx.host.as_ref(),
                    gpui::ElementId::Name(format!("bookmarks-bar-chip:{}", item.id).into()),
                    item.favicon.as_ref(),
                    glyph,
                    title,
                    None,
                    ink,
                    active,
                    ring,
                    &p,
                    Some(tip),
                    move |event, _, cx| {
                        if folder {
                            let Some(anchor) = clicker.ui.read(cx).rect(&format!("bar:{id}"))
                            else {
                                return;
                            };
                            let parent = id.clone();
                            clicker.ui.update(cx, |ui, cx| {
                                ui.toggle_panel(Panel {
                                    key: panel_key(&parent, 0),
                                    parent,
                                    from: 0,
                                    anchor,
                                    level: 0,
                                });
                                cx.notify();
                            });
                            return;
                        }
                        if let Some(url) = url.as_deref() {
                            open_bookmark_url(
                                &clicker.host,
                                &clicker.window,
                                url,
                                open_mode_for(event.modifiers(), false),
                            );
                        }
                    },
                )
                .on_drag(drag, |drag, _, _, cx| cx.new(|_| drag.restarted())),
            ),
        )
        .into_any_element()
}

fn import_button(ctx: &BarCtx, ink: ToolbarInk, window_handle: AnyWindowHandle) -> AnyElement {
    let host = Arc::clone(&ctx.host);
    let menu_host = Arc::clone(&ctx.host);
    let _ = window_handle;
    div()
        .debug_selector(|| "bookmarks-bar-import".into())
        .on_mouse_down(MouseButton::Right, move |_, _, cx| {
            cx.stop_propagation();
            let host = Arc::clone(&menu_host);
            show_native(
                &menu_host,
                native::import_button_menu(),
                cx,
                move |choice, _| {
                    if choice == "hide" {
                        host.dispatch(Action::UpdateSettings {
                            patch: SettingsPatch::new().set("bookmarksImportDismissed", true),
                            from_sync: false,
                        });
                    }
                },
            );
        })
        .child(chip(
            ctx.host.as_ref(),
            "bookmarks-bar-import",
            None,
            Some("rectangle.portrait.and.arrow.right"),
            Some("Import bookmarks".into()),
            None,
            ink,
            false,
            false,
            &ctx.p,
            Some("Add bookmarks from another browser".into()),
            move |_, _, _| host.open_utility_window(UtilityWindowKind::Import),
        ))
        .into_any_element()
}

fn bar_zone_items(ctx: &BarCtx, tree: &BookmarkTree, cx: &App) -> Vec<ZoneItem> {
    let ui = ctx.ui.read(cx);
    tree.children(tree.bar().as_str())
        .iter()
        .filter_map(|id| {
            let rect = ui.rect(&format!("bar:{id}"))?;
            Some(ZoneItem {
                id: id.clone(),
                start: rect.x,
                size: rect.w,
                folder: matches!(tree.get(id.as_str()), Some(BookmarkNode::Folder { .. })),
            })
        })
        .collect()
}

fn track_bar(
    ctx: &BarCtx,
    inside: bool,
    at: gpui::Point<Pixels>,
    dragged: Option<&BookmarkId>,
    cx: &mut App,
) {
    let Some(tree) = ctx.tree() else {
        return;
    };
    let x = crate::scale::points(at.x);
    let next = if inside {
        let other = ctx.ui.read(cx).rect("other");
        if let Some(other) = other.filter(|o| x >= o.x - 6.0) {
            let _ = other;
            Some(Spot::Into(tree.other()))
        } else {
            let items = bar_zone_items(ctx, &tree, cx);
            match fit::zone_hit(&items, x, dragged, fit::ITEM_GAP) {
                ItemHit::Into(id) => Some(Spot::Into(id)),
                ItemHit::Slot(slot) => Some(Spot::Slot {
                    parent: tree.bar(),
                    slot: slot.min(items.len()),
                }),
            }
        }
    } else {
        let mine = matches!(&ctx.ui.read(cx).spot, Some(Spot::Slot { parent, .. }) if parent == &tree.bar())
            || matches!(&ctx.ui.read(cx).spot, Some(Spot::Into(id)) if tree.get(id.as_str()).and_then(BookmarkNode::parent) == Some(&tree.bar()) || id == &tree.other());
        if !mine {
            return;
        }
        None
    };
    let next = next.filter(|spot| match (spot, dragged) {
        (Spot::Into(target), Some(dragged)) => !fit::is_within(&tree, target, dragged),
        _ => true,
    });
    set_spot(ctx, next, dragged.cloned(), 0, cx);
}

pub fn set_spot(
    ctx: &BarCtx,
    next: Option<Spot>,
    dragged: Option<BookmarkId>,
    level: usize,
    cx: &mut App,
) {
    let spring_target = match &next {
        Some(Spot::Into(id)) => Some(id.clone()),
        _ => None,
    };
    let changed = ctx.ui.update(cx, |ui, cx| {
        let changed = ui.spot != next;
        ui.spot = next;
        ui.dragging = dragged;
        if changed {
            cx.notify();
        }
        let current = ui.spring.as_ref().map(|(id, _)| id.clone());
        if current != spring_target {
            ui.spring_generation += 1;
            ui.spring = spring_target.clone().map(|id| (id, ui.spring_generation));
            return ui.spring.clone();
        }
        None
    });
    if let Some((target, generation)) = changed {
        let ui = ctx.ui.clone();
        cx.spawn(async move |cx: &mut AsyncApp| {
            cx.background_executor()
                .timer(Duration::from_millis(fit::SPRING_OPEN_MS))
                .await;
            ui.update(cx, |ui, cx| {
                if ui.spring.as_ref().map(|(_, g)| *g) != Some(generation) {
                    return;
                }
                ui.spring = None;
                let key = if level == 0 {
                    format!("bar:{target}")
                } else {
                    format!("row:{target}")
                };
                let anchor = ui.rect(&key).or_else(|| ui.rect("other"));
                if let Some(anchor) = anchor {
                    let next_level = if level == 0 && ui.rect(&key).is_some() {
                        0
                    } else {
                        level
                    };
                    ui.open_panel(
                        Panel {
                            key: panel_key(&target, 0),
                            parent: target.clone(),
                            from: 0,
                            anchor,
                            level: next_level,
                        },
                        true,
                    );
                    cx.notify();
                }
            });
        })
        .detach();
    }
}

fn finish_stray_drag(ctx: &BarCtx, tree: &BookmarkTree, cx: &mut App) {
    let (dragged, to_sidebar) = ctx.ui.update(cx, |ui, _| {
        let dragged = ui.dragging.clone();
        let folder = dragged
            .as_ref()
            .is_some_and(|id| matches!(tree.get(id.as_str()), Some(BookmarkNode::Folder { .. })));
        (dragged, ui.folder_over_sidebar(folder))
    });
    ctx.ui.update(cx, |ui, _| ui.spot = None);
    end_drag(ctx, cx);
    if let Some(folder) = dragged.filter(|_| to_sidebar) {
        add_folder_to_sidebar(&ctx.host, &folder, &ctx.window, &ctx.profile);
    }
}

pub fn end_drag(ctx: &BarCtx, cx: &mut App) -> Option<Spot> {
    ctx.ui.update(cx, |ui, cx| {
        ui.dragging = None;
        ui.drag_x = None;
        ui.spring = None;
        if ui.sprung {
            ui.close_all(false);
        }
        cx.notify();
        ui.spot.take()
    })
}

pub fn drop_bookmark(ctx: &BarCtx, id: &BookmarkId, cx: &mut App) {
    let Some(spot) = end_drag(ctx, cx) else {
        return;
    };
    let id = id.clone();
    let Some((parent, index)) = ctx
        .tree()
        .and_then(|tree| fit::move_target(&tree, &id, &spot))
    else {
        return;
    };
    edits::move_many(
        ctx.host.store(),
        &ctx.profile,
        std::slice::from_ref(&id),
        &parent,
        Some(index),
    );
}

pub fn drop_tab(ctx: &BarCtx, tab: &TabId, cx: &mut App) {
    let Some(spot) = end_drag(ctx, cx) else {
        return;
    };
    let state = ctx.host.store().snapshot();
    let Some(found) = state.tab(tab.as_str()) else {
        return;
    };
    if found.url.is_empty() || crate::pages::InternalPage::of(&found.url).is_some() {
        return;
    }
    let (url, title, favicon) = (
        found.url.clone(),
        found.display_title(),
        found.favicon.clone(),
    );
    let _ = favicon;
    let Some((parent, index)) = ctx.tree().and_then(|tree| fit::insert_target(&tree, &spot)) else {
        return;
    };
    let title = fit::link_title(&url, Some(&title));
    edits::add_url(
        ctx.host.store(),
        &ctx.profile,
        &parent,
        Some(index),
        &title,
        &url,
    );
}

pub fn drop_links(ctx: &BarCtx, items: &gpui::ExternalItems, cx: &mut App) {
    let Some(spot) = end_drag(ctx, cx) else {
        return;
    };
    let usable: Vec<&String> = items
        .urls()
        .iter()
        .filter(|url| {
            let lower = url.to_ascii_lowercase();
            lower.starts_with("https://") || lower.starts_with("http://")
        })
        .collect();
    let text = items.text().filter(|_| usable.len() == 1);
    let links: Vec<(String, String)> = usable
        .into_iter()
        .map(|url| (url.clone(), fit::link_title(url, text)))
        .collect();
    if links.is_empty() {
        return;
    }
    let Some((parent, index)) = ctx.tree().and_then(|tree| fit::insert_target(&tree, &spot)) else {
        return;
    };
    for (offset, (url, title)) in links.iter().enumerate() {
        if edits::add_url(
            ctx.host.store(),
            &ctx.profile,
            &parent,
            Some(index + offset),
            title,
            url,
        )
        .is_none()
        {
            break;
        }
    }
}

#[derive(IntoElement)]
pub struct LayerView {
    ctx: BarCtx,
    tree: Option<Arc<BookmarkTree>>,
    active: Option<TabId>,
    popover: Option<Popover>,
    layer: fit::Rect,
    dialog_place: dialog::Place,
    window_handle: AnyWindowHandle,
}

pub fn bookmarks_layer(c: &Chrome, window: &Window, cx: &mut App) -> AnyElement {
    let ctx = BarCtx::of(c, cx);
    let layer = fit::Rect {
        x: 0.0,
        y: 0.0,
        w: c.layout.width,
        h: c.layout.height,
    };
    LayerView {
        tree: c.state.bookmarks_of(&ctx.profile).cloned(),
        active: c.active.map(|t| t.id.clone()),
        popover: c.window.chrome.popover.clone(),
        dialog_place: dialog::Place::of(c, bar_height(c.state, c.window, window.is_fullscreen())),
        layer,
        window_handle: window.window_handle(),
        ctx,
    }
    .into_any_element()
}

pub const LAYER_COMMANDS: &[&str] = &[
    "bookmarkPage",
    "bookmarkAllTabs",
    "exportBookmarks",
    "toggleBookmarksBar",
];

impl RenderOnce for LayerView {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ctx = self.ctx.clone();
        if let Some(Popover::Custom(name)) = self.popover.as_ref()
            && let Some(command) = name.strip_prefix("command:")
            && LAYER_COMMANDS.contains(&command)
        {
            ctx.host.dispatch(Action::SetPopover {
                window: ctx.window.clone(),
                popover: None,
            });
            ctx.emit
                .defer(Msg::Command(command.to_owned().into()), window, cx);
        }
        let active_changed = ctx.ui.update(cx, |ui, _| {
            let changed = ui.active_tab != self.active;
            ui.active_tab = self.active.clone();
            changed && ui.menu_open()
        });
        if active_changed {
            ctx.ui.update(cx, |ui, _| ui.close_all(false));
        }
        let menus = self.tree.as_deref().map(|tree| {
            menus::render_panels(&ctx, tree, self.layer, self.window_handle, window, cx)
        });
        let dialog_view = dialog::render(&ctx, self.tree.as_deref(), self.dialog_place, window, cx);
        let prompt_view = dialog::render_prompt(&ctx, self.dialog_place, window, cx);
        div()
            .children(menus.into_iter().flatten())
            .children(dialog_view)
            .children(prompt_view)
            .into_any_element()
    }
}

pub fn bookmark_page(ctx: &BarCtx, window_ref: &mut Window, cx: &mut App) {
    let state = ctx.host.store().snapshot();
    let Some(tab) = state.active_tab(ctx.window.as_str()).cloned() else {
        return;
    };
    if tab.url.is_empty() {
        return;
    }
    let existing = state.bookmarks_of(&ctx.profile).and_then(|tree| {
        tree.nodes()
            .find(|n| {
                matches!(n, BookmarkNode::Url { url, .. } if url == &tab.url)
                    && within_roots(tree, n.id())
            })
            .map(|n| n.id().clone())
    });
    let title = tab.display_title();
    let url = tab.url.clone();
    let id =
        existing.or_else(|| edits::add_url_to_bar(ctx.host.store(), &ctx.profile, &title, &url));
    if let Some(id) = id {
        dialog::open_added(ctx, id, window_ref, cx);
    }
}

pub fn toggle_tab_bookmark(host: &Arc<dyn UiHost>, window: &WindowId) {
    let state = host.store().snapshot();
    let Some(shown) = state.window(window.as_str()) else {
        return;
    };
    let profile = bookmark_profile(&shown.profile_id);
    let Some(tab) = state.active_tab(window.as_str()).cloned() else {
        return;
    };
    if tab.url.is_empty() {
        return;
    }
    let (url, title, favicon) = (tab.url.clone(), tab.display_title(), tab.favicon.clone());
    let _ = favicon;
    let found: Vec<BookmarkId> = state
        .bookmarks_of(&profile)
        .map(|tree| {
            tree.nodes()
                .filter(|n| {
                    matches!(n, BookmarkNode::Url { url: u, .. } if u == &url)
                        && within_roots(tree, n.id())
                })
                .map(|n| n.id().clone())
                .collect()
        })
        .unwrap_or_default();
    if found.is_empty() {
        edits::add_url_to_bar(host.store(), &profile, &title, &url);
    } else {
        edits::remove_many(host.store(), &profile, &found);
    }
}

fn within_roots(tree: &BookmarkTree, id: &BookmarkId) -> bool {
    let ancestors = tree.ancestors(id.as_str());
    ancestors.contains(&tree.bar()) || ancestors.contains(&tree.other())
}

pub fn bookmark_all_tabs(ctx: &BarCtx, window_ref: &mut Window, cx: &mut App) {
    let state = ctx.host.store().snapshot();
    let tabs: Vec<(String, String)> = state
        .view_tabs(ctx.window.as_str(), None)
        .iter()
        .filter(|t| t.url.starts_with("http://") || t.url.starts_with("https://"))
        .map(|t| (t.url.clone(), t.display_title()))
        .collect();
    if tabs.is_empty() {
        return;
    }
    dialog::open_all_tabs(ctx, tabs, window_ref, cx);
}

pub fn export_bookmarks(host: &Arc<dyn UiHost>, window: &WindowId) {
    let state = host.store().snapshot();
    let Some(shown) = state.window(window.as_str()) else {
        return;
    };
    host.export_bookmarks(window.clone(), bookmark_profile(&shown.profile_id));
}

pub fn toggle_message(c: &Chrome, tab: &ardia_state::tabs::Tab) -> Msg {
    let profile = bookmark_profile(&tab.profile_id);
    let found = c.state.bookmarks_of(&profile).and_then(|tree| {
        tree.nodes()
            .find(|n| {
                matches!(n, BookmarkNode::Url { url, .. } if url == &tab.url)
                    && within_roots(tree, n.id())
            })
            .map(|n| n.id().clone())
    });
    match found {
        Some(id) => Msg::Store(Action::RemoveBookmark { profile, id }),
        None => Msg::Store(Action::AddBookmark {
            profile,
            parent: None,
            title: tab.display_title(),
            url: tab.url.clone(),
        }),
    }
}

pub fn run_command(
    ctx: &BarCtx,
    command: ardia_state::commands::Command,
    arg: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) {
    use ardia_state::commands::Command;
    match command {
        Command::BookmarkPage => bookmark_page(ctx, window, cx),
        Command::BookmarkAllTabs => bookmark_all_tabs(ctx, window, cx),
        Command::ExportBookmarks => export_bookmarks(&ctx.host, &ctx.window),
        Command::AddFolderToSidebar => {
            if let Some(folder) = arg {
                add_folder_to_sidebar(
                    &ctx.host,
                    &BookmarkId::new(folder),
                    &ctx.window,
                    &ctx.profile,
                );
            }
        }
        Command::RestoreArcFolders => {
            if let Some(holder) = arg {
                restore_arc(
                    &ctx.host,
                    &BookmarkId::new(holder),
                    &ctx.window,
                    &ctx.profile,
                );
            }
        }
        Command::OpenBookmark => {
            let Some(id) = arg else {
                return;
            };
            let state = ctx.host.store().snapshot();
            let url = ctx.tree().and_then(|tree| match tree.get(id) {
                Some(BookmarkNode::Url { url, .. }) => Some(url.clone()),
                _ => None,
            });
            let active = state.active_tab(ctx.window.as_str()).map(|t| t.id.clone());
            if let (Some(url), Some(tab)) = (url, active) {
                if is_bookmarklet(&url) {
                    ctx.host.run_bookmarklet(tab, url);
                } else {
                    ctx.host.navigate(ctx.window.clone(), tab, url);
                }
            }
        }
        Command::AddBookmarkToFolder => {
            let Some(folder) = arg.map(BookmarkId::new) else {
                return;
            };
            let state = ctx.host.store().snapshot();
            let Some(tab) = state.active_tab(ctx.window.as_str()).cloned() else {
                return;
            };
            if tab.url.is_empty() {
                return;
            }
            let (url, title) = (tab.url.clone(), tab.display_title());
            edits::add_url(ctx.host.store(), &ctx.profile, &folder, None, &title, &url);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panels_toggle_cascade_and_close_like_the_old_menus() {
        let mut ui = BarUi::new();
        let anchor = fit::Rect {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
        };
        let panel = |key: &str, level| Panel {
            key: key.into(),
            parent: BookmarkId::new(key),
            from: 0,
            anchor,
            level,
        };
        ui.toggle_panel(panel("a", 0));
        assert_eq!(ui.panels.len(), 1);
        ui.open_panel(panel("b", 1), false);
        ui.open_panel(panel("c", 2), false);
        ui.open_panel(panel("d", 1), false);
        assert_eq!(
            ui.panels.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(),
            ["a", "d"]
        );
        ui.toggle_panel(panel("a", 0));
        assert!(ui.panels.is_empty());
        ui.toggle_panel(panel("a", 0));
        ui.close_all(true);
        ui.toggle_panel(panel("a", 0));
        assert!(
            ui.panels.is_empty(),
            "a click right after an outside close doesn't reopen"
        );
        assert_eq!(panel_key(&BookmarkId::new("f"), 3), "f+3");
        assert_eq!(
            open_mode_for(Modifiers::command(), false),
            OpenMode::Background
        );
        assert_eq!(open_mode_for(Modifiers::none(), true), OpenMode::Background);
        assert_eq!(open_mode_for(Modifiers::shift(), false), OpenMode::Window);
        assert_eq!(open_mode_for(Modifiers::alt(), false), OpenMode::Split);
        assert_eq!(open_mode_for(Modifiers::none(), false), OpenMode::Current);
    }
}
