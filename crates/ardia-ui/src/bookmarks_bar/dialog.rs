use std::collections::HashSet;

use crate::scale::px;
use ardia_state::BookmarkId;
use ardia_state::bookmarks::{BookmarkNode, BookmarkTree};
use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, App, Entity, FontWeight, Hsla, IntoElement, ParentElement, SharedString, Styled,
    Subscription, Window, anchored, deferred, div, point, prelude::*,
};

use super::BarCtx;
use crate::pages::bookmarks::{edits, model, resolved_url, tree_row};
use crate::primitives::controls::{ButtonKind, PushButton};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput, focus_input};
use crate::window::chrome::Chrome;

pub const EDITOR_WIDTH: f32 = 420.0;
pub const ADDED_WIDTH: f32 = 320.0;
pub const BELOW_FIELD: f32 = space::XS;
pub const BELOW_TOOLBAR: f32 = space::XXS;
pub const RIGHT_INSET: f32 = space::ML;
pub const SIDEBAR_INSET: f32 = 8.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Anchor {
    Right { top: f32, right: f32 },
    Left { top: f32, left: f32 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Place {
    pub anchor: Anchor,
    pub width: f32,
    pub height: f32,
}

impl Place {
    pub fn of(c: &Chrome, bookmarks_bar: f32) -> Place {
        let layout = c.layout;
        let address_in_sidebar = layout.sidebar_field && layout.sidebar.is_some();
        let anchor = match (address_in_sidebar, layout.sidebar) {
            (true, Some(sidebar)) if layout.trailing => Anchor::Right {
                top: layout.header + BELOW_FIELD,
                right: (layout.width - (sidebar.x + sidebar.w)) + SIDEBAR_INSET,
            },
            (true, Some(sidebar)) => Anchor::Left {
                top: layout.header + BELOW_FIELD,
                left: sidebar.x + SIDEBAR_INSET,
            },
            _ => Anchor::Right {
                top: layout.card.y + layout.toolbar - bookmarks_bar - BELOW_TOOLBAR,
                right: (layout.width - (layout.card.x + layout.card.w)) + RIGHT_INSET,
            },
        };
        Place {
            anchor,
            width: layout.width,
            height: layout.height,
        }
    }
}

pub struct Fields {
    pub name: Entity<TextInput>,
    pub url: Entity<TextInput>,
    pub folder: Option<BookmarkId>,
    pub expanded: HashSet<BookmarkId>,
    _subscriptions: Vec<Subscription>,
}

pub enum Dialog {
    Added {
        bookmark: BookmarkId,
        fields: Fields,
    },
    AllTabs {
        tabs: Vec<(String, String)>,
        fields: Fields,
    },
    Editor {
        bookmark: Option<BookmarkId>,
        folder_kind: bool,
        index: Option<usize>,
        picker: bool,
        fields: Fields,
    },
}

impl Dialog {
    fn fields(&self) -> &Fields {
        match self {
            Dialog::Added { fields, .. }
            | Dialog::AllTabs { fields, .. }
            | Dialog::Editor { fields, .. } => fields,
        }
    }

    fn fields_mut(&mut self) -> &mut Fields {
        match self {
            Dialog::Added { fields, .. }
            | Dialog::AllTabs { fields, .. }
            | Dialog::Editor { fields, .. } => fields,
        }
    }
}

fn input(placeholder: &'static str, text: &str, ctx: &BarCtx, cx: &mut App) -> Entity<TextInput> {
    let p = ctx.p;
    let style = InputStyle {
        text: p.text,
        placeholder: p.placeholder,
        caret: p.caret,
        selection: p.selection,
        font_size: 13.0,
        weight: FontWeight::NORMAL,
    };
    let text = text.to_owned();
    cx.new(|cx| {
        let mut field = TextInput::new(placeholder, cx);
        field.set_style(style, cx);
        if !text.is_empty() {
            field.set_text(text, true, cx);
        }
        field
    })
}

fn expanded_for(tree: Option<&BookmarkTree>, folder: Option<&BookmarkId>) -> HashSet<BookmarkId> {
    let mut expanded = HashSet::new();
    if let Some(tree) = tree {
        expanded.insert(tree.bar());
        expanded.insert(tree.other());
        if let Some(folder) = folder {
            expanded.extend(tree.ancestors(folder.as_str()));
        }
    }
    expanded
}

fn listen(
    ctx: &BarCtx,
    field: &Entity<TextInput>,
    submit: fn(&BarCtx, &mut App),
    cancel: fn(&BarCtx, &mut App),
    cx: &mut App,
) -> Subscription {
    let ctx = ctx.clone();
    cx.subscribe(field, move |_, event: &InputEvent, cx| match event {
        InputEvent::Submit(_) => submit(&ctx, cx),
        InputEvent::Cancel => cancel(&ctx, cx),
        _ => {}
    })
}

fn set_dialog(
    ctx: &BarCtx,
    dialog: Dialog,
    focus: &Entity<TextInput>,
    window: &mut Window,
    cx: &mut App,
) {
    focus_input(focus, window, cx);
    ctx.ui.update(cx, |ui, cx| {
        ui.close_all(false);
        ui.dialog = Some(dialog);
        cx.notify();
    });
}

pub fn close(ctx: &BarCtx, cx: &mut App) {
    ctx.ui.update(cx, |ui, cx| {
        ui.dialog = None;
        cx.notify();
    });
}

pub fn open_editor(
    ctx: &BarCtx,
    bookmark: Option<BookmarkId>,
    folder: bool,
    parent: Option<BookmarkId>,
    index: Option<usize>,
    window: &mut Window,
    cx: &mut App,
) {
    let tree = ctx.tree();
    let node = bookmark
        .as_ref()
        .and_then(|id| tree.as_deref().and_then(|t| t.get(id.as_str())).cloned());
    if bookmark.is_some() && node.is_none() {
        return;
    }
    let (title, address) = match &node {
        Some(BookmarkNode::Url { title, url, .. }) => (title.clone(), url.clone()),
        Some(BookmarkNode::Folder { title, .. }) => (title.clone(), String::new()),
        None => (String::new(), String::new()),
    };
    let folder_kind = node
        .as_ref()
        .map_or(folder, |n| matches!(n, BookmarkNode::Folder { .. }));
    let chosen = node
        .as_ref()
        .and_then(BookmarkNode::parent)
        .cloned()
        .or(parent)
        .or_else(|| tree.as_deref().map(BookmarkTree::bar));
    let name = input("", &title, ctx, cx);
    let url = input("https://", &address, ctx, cx);
    let subscriptions = vec![
        listen(ctx, &name, save, close, cx),
        listen(ctx, &url, save, close, cx),
    ];
    let dialog = Dialog::Editor {
        bookmark: node.as_ref().map(|n| n.id().clone()),
        folder_kind,
        index,
        picker: !folder_kind || node.is_none(),
        fields: Fields {
            expanded: expanded_for(tree.as_deref(), chosen.as_ref()),
            name: name.clone(),
            url,
            folder: chosen,
            _subscriptions: subscriptions,
        },
    };
    set_dialog(ctx, dialog, &name, window, cx);
}

pub fn open_added(ctx: &BarCtx, bookmark: BookmarkId, window: &mut Window, cx: &mut App) {
    let tree = ctx.tree();
    let node = tree
        .as_deref()
        .and_then(|t| t.get(bookmark.as_str()))
        .cloned();
    let name = input("Name", node.as_ref().map_or("", |n| n.title()), ctx, cx);
    let url = input("", "", ctx, cx);
    let folder = node.as_ref().and_then(BookmarkNode::parent).cloned();
    let subscriptions = vec![listen(ctx, &name, done, done, cx)];
    let dialog = Dialog::Added {
        bookmark,
        fields: Fields {
            expanded: expanded_for(tree.as_deref(), folder.as_ref()),
            name: name.clone(),
            url,
            folder,
            _subscriptions: subscriptions,
        },
    };
    set_dialog(ctx, dialog, &name, window, cx);
}

pub fn open_all_tabs(ctx: &BarCtx, tabs: Vec<(String, String)>, window: &mut Window, cx: &mut App) {
    let tree = ctx.tree();
    let name = input("Tabs", "", ctx, cx);
    let url = input("", "", ctx, cx);
    let folder = tree.as_deref().map(BookmarkTree::bar);
    let subscriptions = vec![listen(ctx, &name, done, done, cx)];
    let dialog = Dialog::AllTabs {
        tabs,
        fields: Fields {
            expanded: expanded_for(tree.as_deref(), folder.as_ref()),
            name: name.clone(),
            url,
            folder,
            _subscriptions: subscriptions,
        },
    };
    set_dialog(ctx, dialog, &name, window, cx);
}

fn template(ctx: &BarCtx) -> String {
    ctx.host.store().snapshot().default_search_engine().url
}

pub fn valid(folder: bool, title: &str, url: &str, template: &str) -> bool {
    if folder {
        !title.trim().is_empty()
    } else {
        !resolved_url(url, template).is_empty()
    }
}

pub fn save(ctx: &BarCtx, cx: &mut App) {
    let template = template(ctx);
    let wanted = match ctx.ui.read(cx).dialog.as_ref() {
        Some(Dialog::Editor {
            bookmark,
            folder_kind,
            index,
            fields,
            ..
        }) => Some((
            bookmark.clone(),
            *folder_kind,
            *index,
            fields.folder.clone(),
            fields.name.read(cx).text().trim().to_owned(),
            resolved_url(fields.url.read(cx).text(), &template),
        )),
        _ => None,
    };
    let Some((bookmark, folder, index, parent, title, url)) = wanted else {
        return;
    };
    if (folder && title.is_empty()) || (!folder && url.is_empty()) {
        return;
    }
    let store = ctx.host.store();
    let profile = &ctx.profile;
    match bookmark.as_ref() {
        Some(id) => {
            let address = (!folder).then_some(url.as_str());
            if edits::update(store, profile, id, &title, address) {
                let current = ctx.tree().and_then(|tree| {
                    tree.get(id.as_str())
                        .and_then(BookmarkNode::parent)
                        .cloned()
                });
                if let Some(parent) = parent.as_ref().filter(|p| Some(*p) != current.as_ref()) {
                    edits::move_many(store, profile, std::slice::from_ref(id), parent, None);
                }
            }
        }
        None => {
            let shown = if title.is_empty() {
                url.clone()
            } else {
                title.clone()
            };
            match (parent.as_ref(), folder) {
                (Some(into), true) => {
                    edits::add_folder(store, profile, into, index, &title);
                }
                (None, true) => {
                    edits::add_folder_to_bar(store, profile, &title);
                }
                (Some(into), false) => {
                    edits::add_url(store, profile, into, index, &shown, &url);
                }
                (None, false) => {
                    edits::add_url_to_bar(store, profile, &shown, &url);
                }
            }
        }
    }
    close(ctx, cx);
}

pub fn done(ctx: &BarCtx, cx: &mut App) {
    let taken = ctx.ui.update(cx, |ui, cx| {
        cx.notify();
        ui.dialog.take()
    });
    match taken {
        Some(Dialog::Added { bookmark, fields }) => {
            let name = fields.name.read(cx).text().trim().to_owned();
            let folder = fields.folder;
            let node = ctx
                .tree()
                .and_then(|tree| tree.get(bookmark.as_str()).cloned());
            if let Some(node) = node {
                if !name.is_empty() && name != node.title() {
                    edits::rename(ctx.host.store(), &ctx.profile, &bookmark, &name);
                }
                if let Some(folder) = folder.filter(|f| Some(f) != node.parent()) {
                    edits::move_many(
                        ctx.host.store(),
                        &ctx.profile,
                        std::slice::from_ref(&bookmark),
                        &folder,
                        None,
                    );
                }
            }
        }
        Some(Dialog::AllTabs { tabs, fields }) => {
            let typed = fields.name.read(cx).text().trim().to_owned();
            let name = if typed.is_empty() {
                "Tabs".to_owned()
            } else {
                typed
            };
            let folder = fields.folder;
            let store = ctx.host.store();
            let made = match folder.as_ref() {
                Some(parent) => edits::add_folder(store, &ctx.profile, parent, None, &name),
                None => edits::add_folder_to_bar(store, &ctx.profile, &name),
            };
            if let Some(made) = made {
                for (url, title) in &tabs {
                    edits::add_url(store, &ctx.profile, &made, None, title, url);
                }
            }
        }
        Some(other) => {
            ctx.ui.update(cx, |ui, _| ui.dialog = Some(other));
        }
        None => {}
    }
}

fn remove_added(ctx: &BarCtx, cx: &mut App) {
    let taken = ctx.ui.update(cx, |ui, cx| {
        cx.notify();
        ui.dialog.take()
    });
    if let Some(Dialog::Added { bookmark, .. }) = taken {
        edits::remove_many(
            ctx.host.store(),
            &ctx.profile,
            std::slice::from_ref(&bookmark),
        );
    }
}

pub struct FolderPrompt {
    pub parent: BookmarkId,
    pub index: Option<usize>,
    pub select: bool,
    pub field: Entity<TextInput>,
    pub focused: bool,
    pub adds: Vec<(String, String)>,
    _subscription: Subscription,
}

pub fn prompt_new_folder(
    ctx: &BarCtx,
    parent: BookmarkId,
    index: Option<usize>,
    then_select: Option<()>,
    cx: &mut App,
) {
    let field = input("Folder name", "", ctx, cx);
    let subscription = listen(ctx, &field, submit_prompt, cancel_prompt, cx);
    ctx.ui.update(cx, |ui, cx| {
        ui.close_all(false);
        ui.prompt = Some(FolderPrompt {
            parent,
            index,
            select: then_select.is_some(),
            field,
            focused: false,
            adds: Vec::new(),
            _subscription: subscription,
        });
        cx.notify();
    });
}

pub fn prompt_new_folder_for(
    ctx: &BarCtx,
    parent: BookmarkId,
    adds: Vec<(String, String)>,
    cx: &mut App,
) {
    prompt_new_folder(ctx, parent, None, None, cx);
    ctx.ui.update(cx, |ui, _| {
        if let Some(prompt) = ui.prompt.as_mut() {
            prompt.adds = adds;
        }
    });
}

pub fn cancel_prompt(ctx: &BarCtx, cx: &mut App) {
    ctx.ui.update(cx, |ui, cx| {
        ui.prompt = None;
        cx.notify();
    });
}

pub fn submit_prompt(ctx: &BarCtx, cx: &mut App) {
    let Some(prompt) = ctx.ui.update(cx, |ui, cx| {
        cx.notify();
        ui.prompt.take()
    }) else {
        return;
    };
    let title = prompt.field.read(cx).text().trim().to_owned();
    if title.is_empty() {
        return;
    }
    let (parent, index, adds) = (prompt.parent, prompt.index, prompt.adds);
    let made = edits::add_folder(ctx.host.store(), &ctx.profile, &parent, index, &title);
    if let Some(made) = made.as_ref() {
        for (url, title) in &adds {
            edits::add_url(ctx.host.store(), &ctx.profile, made, None, title, url);
        }
    }
    if prompt.select
        && let Some(made) = made
    {
        ctx.ui.update(cx, |ui, cx| {
            if let Some(dialog) = ui.dialog.as_mut() {
                dialog.fields_mut().folder = Some(made);
            }
            cx.notify();
        });
    }
}

pub const PROMPT_WIDTH: f32 = 292.;
pub const PROMPT_HEIGHT: f32 = 136.;
pub const PROMPT_RADIUS: f32 = 18.;
pub const PROMPT_TITLE_TOP: f32 = 19.5;
pub const PROMPT_TITLE_LEFT: f32 = 23.;
pub const PROMPT_FIELD_TOP: f32 = 52.;
pub const PROMPT_FIELD_LEFT: f32 = 16.5;
pub const PROMPT_FIELD_WIDTH: f32 = 259.;
pub const PROMPT_FIELD_HEIGHT: f32 = 24.;
pub const PROMPT_FIELD_INSET: f32 = 4.5;
pub const PROMPT_RING: f32 = 3.;
pub const PROMPT_BUTTON_TOP: f32 = 92.;
pub const PROMPT_BUTTON_LEFT: f32 = 32.;
pub const PROMPT_BUTTON_WIDTH: f32 = 110.;
pub const PROMPT_BUTTON_HEIGHT: f32 = 28.;
pub const PROMPT_BUTTON_GAP: f32 = 8.;
pub const PROMPT_DIM: f32 = 0.2;
pub const PROMPT_TINT: f32 = 0.88;

struct SheetInk {
    panel: Hsla,
    field: Hsla,
    button: Hsla,
    text: Hsla,
    default_button: Hsla,
    ring: Hsla,
}

fn sheet_ink(p: &crate::look::Palette) -> SheetInk {
    let gray = |v: f32| gpui::hsla(0., 0., v / 255., 1.);
    if p.dark {
        SheetInk {
            panel: gray(54.),
            field: gray(27.),
            button: gray(69.),
            text: gpui::white(),
            default_button: gpui::rgb(0x3478f6).into(),
            ring: gpui::rgb(0x48749c).into(),
        }
    } else {
        SheetInk {
            panel: gray(236.),
            field: gray(255.),
            button: gray(222.),
            text: gpui::black(),
            default_button: gpui::rgb(0x3478f6).into(),
            ring: Hsla::from(gpui::rgb(0x3478f6)).opacity(0.5),
        }
    }
}

fn prompt_button(
    id: &'static str,
    title: &'static str,
    left: f32,
    fill: Hsla,
    ink: Hsla,
    run: impl Fn(&mut App) + 'static,
) -> AnyElement {
    div()
        .id(id)
        .debug_selector(move || format!("bookmark-prompt-button:{title}"))
        .absolute()
        .left(px(left))
        .top(px(PROMPT_BUTTON_TOP))
        .w(px(PROMPT_BUTTON_WIDTH))
        .h(px(PROMPT_BUTTON_HEIGHT))
        .rounded(px(PROMPT_BUTTON_HEIGHT / 2.))
        .bg(fill)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(13.))
        .text_color(ink)
        .active(|style| style.opacity(0.8))
        .on_click(move |_, _, cx| run(cx))
        .child(title)
        .into_any_element()
}

pub fn render_prompt(
    ctx: &BarCtx,
    place: Place,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let (field, focus_now) = ctx.ui.update(cx, |ui, _| {
        let prompt = ui.prompt.as_mut()?;
        let focus_now = !prompt.focused;
        prompt.focused = true;
        Some((prompt.field.clone(), focus_now))
    })?;
    if focus_now {
        focus_input(&field, window, cx);
    }
    let p = ctx.p;
    let ink = sheet_ink(&p);
    let (cancel, create) = (ctx.clone(), ctx.clone());
    let panel = gpui::visual_effect(gpui::VisualEffectMaterial::Sheet)
        .blending(gpui::VisualEffectBlending::WithinWindow)
        .id("bookmark-prompt")
        .debug_selector(|| "bookmark-prompt".into())
        .occlude()
        .relative()
        .w(px(PROMPT_WIDTH))
        .h(px(PROMPT_HEIGHT))
        .rounded(px(PROMPT_RADIUS))
        .bg(ink.panel)
        .border(px(0.5))
        .border_color(p.panel_border)
        .shadow(crate::primitives::tokens::shadows(
            &crate::primitives::tokens::shadow::DIALOG,
            p.dark,
        ))
        .on_click(|_, _, cx| cx.stop_propagation())
        .child(
            div()
                .absolute()
                .inset_0()
                .rounded(px(PROMPT_RADIUS))
                .bg(ink.panel.opacity(PROMPT_TINT)),
        )
        .child(
            div()
                .absolute()
                .left(px(PROMPT_TITLE_LEFT))
                .top(px(PROMPT_TITLE_TOP))
                .text_size(px(13.))
                .line_height(px(16.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(ink.text)
                .child("New Folder"),
        )
        .child(
            div()
                .absolute()
                .left(px(PROMPT_FIELD_LEFT - PROMPT_RING))
                .top(px(PROMPT_FIELD_TOP - PROMPT_RING))
                .w(px(PROMPT_FIELD_WIDTH + PROMPT_RING * 2.))
                .h(px(PROMPT_FIELD_HEIGHT + PROMPT_RING * 2.))
                .rounded(px(radius::CONTROL + PROMPT_RING))
                .border(px(PROMPT_RING))
                .border_color(ink.ring)
                .child(
                    div()
                        .size_full()
                        .rounded(px(radius::CONTROL))
                        .bg(ink.field)
                        .px(px(PROMPT_FIELD_INSET))
                        .flex()
                        .items_center()
                        .child(div().flex_1().min_w_0().child(field)),
                ),
        )
        .child(prompt_button(
            "bookmark-prompt-cancel",
            "Cancel",
            PROMPT_BUTTON_LEFT,
            ink.button,
            ink.text,
            move |cx| cancel_prompt(&cancel, cx),
        ))
        .child(prompt_button(
            "bookmark-prompt-create",
            "Create",
            PROMPT_BUTTON_LEFT + PROMPT_BUTTON_WIDTH + PROMPT_BUTTON_GAP,
            ink.default_button,
            gpui::white(),
            move |cx| submit_prompt(&create, cx),
        ));
    Some(
        deferred(
            anchored().position(point(px(0.), px(0.))).child(
                div()
                    .id("bookmark-prompt-dim")
                    .occlude()
                    .w(px(place.width))
                    .h(px(place.height))
                    .bg(gpui::black().opacity(PROMPT_DIM))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(panel),
            ),
        )
        .with_priority(9)
        .into_any_element(),
    )
}

fn label(text: &'static str, ctx: &BarCtx) -> AnyElement {
    div()
        .mb(px(space::XS))
        .text_size(px(11.))
        .line_height(px(14.))
        .text_color(ctx.p.text_secondary)
        .child(text)
        .into_any_element()
}

fn field_box(field: &Entity<TextInput>, ctx: &BarCtx) -> AnyElement {
    crate::primitives::controls::text_field_box(&ctx.p, false)
        .child(div().flex_1().min_w_0().child(field.clone()))
        .into_any_element()
}

fn picker(ctx: &BarCtx, tree: &BookmarkTree, fields: &Fields) -> AnyElement {
    let p = ctx.p;
    let rows = model::folder_rows(tree, &fields.expanded);
    div()
        .id("bookmark-folder-picker")
        .debug_selector(|| "bookmark-folder-picker".into())
        .h(px(model::PICKER_HEIGHT))
        .rounded(px(radius::TILE))
        .bg(p.field)
        .border(px(0.5))
        .border_color(p.field_border)
        .overflow_y_scroll()
        .p(px(space::XS))
        .children(rows.iter().enumerate().map(|(index, row)| {
            let pick = ctx.clone();
            let toggle = ctx.clone();
            let picked = row.id.clone();
            let toggled = row.id.clone();
            tree_row(
                ctx.host.as_ref(),
                ("bookmark-picker-row", index),
                row,
                model::PICKER_ROW,
                fields.folder.as_ref() == Some(&row.id),
                fields.expanded.contains(&row.id),
                &p,
                move |_, cx| {
                    pick.ui.update(cx, |ui, cx| {
                        if let Some(dialog) = ui.dialog.as_mut() {
                            dialog.fields_mut().folder = Some(picked.clone());
                        }
                        cx.notify();
                    })
                },
                move |_, cx| {
                    toggle.ui.update(cx, |ui, cx| {
                        if let Some(dialog) = ui.dialog.as_mut() {
                            let expanded = &mut dialog.fields_mut().expanded;
                            if !expanded.remove(&toggled) {
                                expanded.insert(toggled.clone());
                            }
                        }
                        cx.notify();
                    })
                },
            )
        }))
        .into_any_element()
}

fn button(
    id: &'static str,
    title: &'static str,
    kind: ButtonKind,
    enabled: bool,
    ctx: &BarCtx,
    run: fn(&BarCtx, &mut App),
) -> AnyElement {
    let target = ctx.clone();
    div()
        .debug_selector(move || format!("bookmark-dialog-button:{title}"))
        .child(
            PushButton::new(id, title, &ctx.p)
                .kind(kind)
                .disabled(!enabled)
                .on_click(move |_, _, cx| run(&target, cx)),
        )
        .into_any_element()
}

fn new_folder_from_dialog(ctx: &BarCtx, cx: &mut App) {
    let parent = ctx
        .ui
        .read(cx)
        .dialog
        .as_ref()
        .and_then(|d| d.fields().folder.clone())
        .or_else(|| ctx.tree().map(|t| t.bar()));
    if let Some(parent) = parent {
        prompt_new_folder(ctx, parent, None, Some(()), cx);
    }
}

pub fn render(
    ctx: &BarCtx,
    tree: Option<&BookmarkTree>,
    place: Place,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = window;
    let p = ctx.p;
    let ui = ctx.ui.read(cx);
    let dialog = ui.dialog.as_ref()?;
    let fields = dialog.fields();
    let tree = tree?;
    let template = template(ctx);
    let mut body: Vec<AnyElement> = Vec::new();
    let (title, width, placed): (SharedString, f32, bool) = match dialog {
        Dialog::Added { .. } => ("Bookmark Added".into(), ADDED_WIDTH, true),
        Dialog::AllTabs { tabs, .. } => (
            format!("Bookmark {} Tabs", tabs.len()).into(),
            ADDED_WIDTH,
            true,
        ),
        Dialog::Editor {
            bookmark,
            folder_kind,
            ..
        } => (
            match (*folder_kind, bookmark.is_some()) {
                (true, true) => "Rename Folder",
                (true, false) => "New Folder",
                (false, true) => "Edit Bookmark",
                (false, false) => "Add Bookmark",
            }
            .into(),
            EDITOR_WIDTH,
            false,
        ),
    };
    let name_label = match dialog {
        Dialog::AllTabs { .. } => "Folder name",
        _ => "Name",
    };
    body.push(
        div()
            .mt(px(space::L))
            .child(label(name_label, ctx))
            .child(field_box(&fields.name, ctx))
            .into_any_element(),
    );
    let show_url = matches!(
        dialog,
        Dialog::Editor {
            folder_kind: false,
            ..
        }
    );
    if show_url {
        body.push(
            div()
                .mt(px(space::L))
                .child(label("URL", ctx))
                .child(field_box(&fields.url, ctx))
                .into_any_element(),
        );
    }
    let show_picker = match dialog {
        Dialog::Editor { picker, .. } => *picker,
        _ => true,
    };
    if show_picker {
        body.push(
            div()
                .mt(px(space::L))
                .child(label("Folder", ctx))
                .child(picker(ctx, tree, fields))
                .into_any_element(),
        );
    }
    let actions = match dialog {
        Dialog::Added { .. } => div()
            .mt(px(space::XL))
            .flex()
            .items_center()
            .gap(px(space::M))
            .child(button(
                "bookmark-dialog-new-folder",
                "New Folder",
                ButtonKind::Plain,
                true,
                ctx,
                new_folder_from_dialog,
            ))
            .child(div().flex_1())
            .child(button(
                "bookmark-dialog-remove",
                "Remove",
                ButtonKind::Plain,
                true,
                ctx,
                remove_added,
            ))
            .child(button(
                "bookmark-dialog-done",
                "Done",
                ButtonKind::Primary,
                true,
                ctx,
                done,
            )),
        Dialog::AllTabs { .. } => div()
            .mt(px(space::XL))
            .flex()
            .items_center()
            .gap(px(space::M))
            .child(button(
                "bookmark-dialog-new-folder",
                "New Folder",
                ButtonKind::Plain,
                true,
                ctx,
                new_folder_from_dialog,
            ))
            .child(div().flex_1())
            .child(button(
                "bookmark-dialog-cancel",
                "Cancel",
                ButtonKind::Plain,
                true,
                ctx,
                close,
            ))
            .child(button(
                "bookmark-dialog-save",
                "Save",
                ButtonKind::Primary,
                true,
                ctx,
                done,
            )),
        Dialog::Editor { folder_kind, .. } => {
            let ok = valid(
                *folder_kind,
                fields.name.read(cx).text(),
                fields.url.read(cx).text(),
                &template,
            );
            div()
                .mt(px(space::XL))
                .flex()
                .items_center()
                .gap(px(space::M))
                .child(div().flex_1())
                .child(button(
                    "bookmark-dialog-cancel",
                    "Cancel",
                    ButtonKind::Plain,
                    true,
                    ctx,
                    close,
                ))
                .child(button(
                    "bookmark-dialog-save",
                    "Save",
                    ButtonKind::Primary,
                    ok,
                    ctx,
                    save,
                ))
        }
    };
    body.push(actions.into_any_element());
    let title_size = if placed { 13. } else { 15. };
    let panel = crate::primitives::sheets::panel_surface(
        &p,
        radius::SHEET,
        crate::primitives::tokens::shadow::DIALOG,
    )
    .id("bookmark-dialog")
    .debug_selector(|| "bookmark-dialog".into())
    .occlude()
    .w(px(width))
    .p(px(space::XL))
    .on_click(|_, _, cx| cx.stop_propagation())
    .child(
        div()
            .text_size(px(title_size))
            .line_height(px(if title_size > 13. { 20. } else { 16. }))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(p.text)
            .child(title),
    )
    .children(body);
    let dismiss = ctx.clone();
    let dismiss_placed = placed;
    let backdrop = div()
        .id("bookmark-dialog-scrim")
        .w(px(place.width))
        .h(px(place.height))
        .when(!placed, |this| this.bg(p.scrim))
        .on_click(move |_, _, cx| {
            if dismiss_placed {
                done(&dismiss, cx);
            } else {
                close(&dismiss, cx);
            }
        });
    let backdrop = if placed {
        let mut holder = div().size_full().relative();
        holder = match place.anchor {
            Anchor::Right { top, right } => holder.child(
                div()
                    .absolute()
                    .top(px(top))
                    .left(px(place.width - right - width))
                    .child(panel),
            ),
            Anchor::Left { top, left } => {
                holder.child(div().absolute().top(px(top)).left(px(left)).child(panel))
            }
        };
        backdrop.child(holder)
    } else {
        backdrop.flex().items_center().justify_center().child(panel)
    };
    Some(
        deferred(anchored().position(point(px(0.), px(0.))).child(backdrop))
            .with_priority(8)
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editors_need_a_name_or_an_address() {
        let template = "https://search.example/?q=%s";
        assert!(!valid(true, "  ", "", template));
        assert!(valid(true, "Work", "", template));
        assert!(!valid(false, "Title", " ", template));
        assert!(valid(false, "", "example.com", template));
    }
}
