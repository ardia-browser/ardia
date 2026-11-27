use crate::scale::px;
use ardia_theme::layout::panel;
use gpui::{
    AnyElement, App, ElementId, Hsla, IntoElement, ParentElement, Pixels, Point, RenderOnce,
    SharedString, Styled, Window, anchored, deferred, div, prelude::*,
};

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::host::{NativeMenuItem, UiHost};
use crate::look::Palette;
use crate::msg::{Emit, MenuTarget, Msg};
use crate::popovers::menu_items;
use crate::primitives::controls::{MenuRow, popover, section_label, separator};
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;

pub const MENU_WIDTH: f32 = 240.0;
const SUBMENU_OVERLAP: f32 = 4.0;
const SWATCH: f32 = 8.0;
const HEADER_HEIGHT: f32 = 24.0;

#[derive(Clone, Debug, PartialEq)]
pub struct MenuItem {
    pub key: SharedString,
    pub title: SharedString,
    pub icon: Option<Icon>,
    pub symbol: Option<SharedString>,
    pub shortcut: Option<String>,
    pub enabled: bool,
    pub checked: bool,
    pub destructive: bool,
    pub swatch: Option<Hsla>,
    pub msgs: Vec<Msg>,
    pub alternate: Option<Box<MenuItem>>,
}

impl MenuItem {
    pub fn new(key: impl Into<SharedString>, title: impl Into<SharedString>) -> Self {
        MenuItem {
            key: key.into(),
            title: title.into(),
            icon: None,
            symbol: None,
            shortcut: None,
            enabled: true,
            checked: false,
            destructive: false,
            swatch: None,
            msgs: Vec::new(),
            alternate: None,
        }
    }

    pub fn icon(mut self, glyph: Icon) -> Self {
        self.icon = Some(glyph);
        self
    }

    pub fn symbol(mut self, name: &'static str) -> Self {
        self.symbol = Some(SharedString::new_static(name));
        self.icon = self.icon.or_else(|| Icon::from_symbol(name));
        self
    }

    pub fn symbol_name(&self) -> Option<SharedString> {
        self.symbol.clone().or_else(|| {
            self.icon
                .map(|glyph| SharedString::new_static(glyph.symbol_name()))
        })
    }

    pub fn shortcut(mut self, shortcut: Option<String>) -> Self {
        self.shortcut = shortcut.filter(|s| !s.is_empty());
        self
    }

    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    pub fn destructive(mut self, destructive: bool) -> Self {
        self.destructive = destructive;
        self
    }

    pub fn swatch(mut self, swatch: Option<Hsla>) -> Self {
        self.swatch = swatch;
        self
    }

    pub fn msg(mut self, msg: Msg) -> Self {
        self.msgs.push(msg);
        self
    }

    pub fn alternate(mut self, alternate: MenuItem) -> Self {
        self.alternate = Some(Box::new(alternate));
        self
    }

    pub fn entry(self) -> MenuEntry {
        MenuEntry::Item(self)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Submenu {
    pub key: SharedString,
    pub title: SharedString,
    pub icon: Option<Icon>,
    pub symbol: Option<SharedString>,
    pub enabled: bool,
    pub children: Vec<MenuEntry>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum MenuEntry {
    Item(MenuItem),
    Submenu(Submenu),
    Header(SharedString),
    Separator,
}

impl MenuEntry {
    pub fn submenu(
        key: impl Into<SharedString>,
        title: impl Into<SharedString>,
        icon: Option<Icon>,
        children: Vec<MenuEntry>,
    ) -> MenuEntry {
        MenuEntry::Submenu(Submenu {
            key: key.into(),
            title: title.into(),
            icon,
            symbol: None,
            enabled: true,
            children,
        })
    }

    pub fn symbol(self, name: &'static str) -> MenuEntry {
        match self {
            MenuEntry::Item(item) => MenuEntry::Item(item.symbol(name)),
            MenuEntry::Submenu(mut sub) => {
                sub.symbol = Some(SharedString::new_static(name));
                sub.icon = sub.icon.or_else(|| Icon::from_symbol(name));
                MenuEntry::Submenu(sub)
            }
            other => other,
        }
    }

    pub fn enabled(self, enabled: bool) -> MenuEntry {
        match self {
            MenuEntry::Item(item) => MenuEntry::Item(item.enabled(enabled)),
            MenuEntry::Submenu(mut sub) => {
                sub.enabled = enabled;
                MenuEntry::Submenu(sub)
            }
            other => other,
        }
    }

    pub fn title(&self) -> Option<&str> {
        match self {
            MenuEntry::Item(item) => Some(&item.title),
            MenuEntry::Submenu(sub) => Some(&sub.title),
            MenuEntry::Header(title) => Some(title),
            MenuEntry::Separator => None,
        }
    }
}

pub fn sections(groups: Vec<Vec<MenuEntry>>) -> Vec<MenuEntry> {
    let mut out = Vec::new();
    for group in groups.into_iter().filter(|g| !g.is_empty()) {
        if !out.is_empty() {
            out.push(MenuEntry::Separator);
        }
        out.extend(group);
    }
    out
}

pub fn find<'a>(entries: &'a [MenuEntry], path: &[&str]) -> Option<&'a MenuEntry> {
    let (first, rest) = path.split_first()?;
    let found = entries.iter().find(|entry| entry.title() == Some(*first))?;
    if rest.is_empty() {
        return Some(found);
    }
    match found {
        MenuEntry::Submenu(sub) => find(&sub.children, rest),
        _ => None,
    }
}

pub fn titles(entries: &[MenuEntry]) -> Vec<String> {
    entries
        .iter()
        .map(|entry| entry.title().map_or_else(|| "-".to_owned(), str::to_owned))
        .collect()
}

pub fn tab_extras(
    c: &Chrome,
    tab: &ardia_state::tabs::Tab,
) -> crate::popovers::tab_menu_extras::TabExtras {
    use crate::popovers::tab_menu_extras as extras;
    let active = c.active.is_some_and(|a| a.id == tab.id);
    let calendar = match (c.host.calendar(), c.host.live()) {
        (Some(calendar), Some(live)) if extras::is_calendar_tab(tab) => {
            let dismissed: crate::live::DismissedNow = live
                .dismissed_now
                .iter()
                .map(|(k, v)| (k.clone(), *v))
                .collect();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as i64);
            extras::calendar_entries(tab, &live.calendar, &calendar, &dismissed, now)
        }
        _ => Vec::new(),
    };
    let plugins = match c.host.plugins() {
        Some(host) if !tab.profile_id.is_incognito() => extras::plugin_entries(
            "tab",
            &host.menu_entries("tab"),
            &extras::when_context(c.state, c.window.id.as_str(), tab, active),
            &extras::tab_context_data(c.window.id.as_str(), tab),
        ),
        _ => Vec::new(),
    };
    extras::TabExtras {
        pip_open: c.host.media_pip_open(&tab.id),
        page_unread: ardia_state::unread::page_unread(tab).is_some(),
        calendar,
        plugins,
    }
}

pub fn tile_folder_menu(c: &Chrome, folder: &str) -> Vec<MenuEntry> {
    let active = c.window.active_tab();
    let mut entries: Vec<MenuEntry> = crate::sidebar::tab_strip::folder_members(c, folder)
        .iter()
        .map(|tab| {
            MenuItem::new(
                SharedString::from(format!("tile-folder-tab:{}", tab.id)),
                crate::window::chrome::tab_title(tab),
            )
            .checked(active == Some(&tab.id))
            .msg(Msg::Store(ardia_state::Action::ActivateTab {
                tab: tab.id.clone(),
            }))
            .entry()
        })
        .collect();
    entries.push(MenuEntry::Separator);
    entries.push(rename_folder_item(folder));
    entries
}

fn rename_folder_item(folder: &str) -> MenuEntry {
    MenuItem::new("tile-folder-rename", "Rename\u{2026}")
        .symbol("pencil")
        .msg(Msg::RenameTileFolder(folder.to_owned()))
        .entry()
}

pub fn tile_folder_actions(c: &Chrome, folder: &str) -> Vec<MenuEntry> {
    let members: Vec<ardia_state::TabId> = crate::sidebar::tab_strip::folder_members(c, folder)
        .iter()
        .map(|t| t.id.clone())
        .collect();
    let count = members.len();
    let unpin = Msg::Stores(
        members
            .iter()
            .map(|tab| ardia_state::Action::SetPin {
                tab: tab.clone(),
                pin: None,
            })
            .collect(),
    );
    vec![
        rename_folder_item(folder),
        MenuEntry::Separator,
        MenuItem::new(
            "tile-folder-unpin",
            format!("Unpin {count} {}", if count == 1 { "Tab" } else { "Tabs" }),
        )
        .symbol("pin.slash")
        .msg(unpin)
        .entry(),
        MenuItem::new("tile-folder-remove", "Remove Folder")
            .symbol("folder.badge.minus")
            .msg(Msg::Stores(
                members
                    .iter()
                    .map(|tab| ardia_state::Action::SetPin {
                        tab: tab.clone(),
                        pin: Some(ardia_state::model::TabPin::TILE),
                    })
                    .collect(),
            ))
            .entry(),
    ]
}

pub fn menu_entries(c: &Chrome, target: &MenuTarget) -> Option<Vec<MenuEntry>> {
    let (state, window) = (c.state, c.window);
    Some(match target {
        MenuTarget::Tab(tab) => {
            let targets = state
                .tab(tab.as_str())
                .and_then(|t| {
                    c.host
                        .sync_status()
                        .engine
                        .send_targets
                        .get(&t.profile_id)
                        .cloned()
                })
                .unwrap_or_default();
            let extras = state
                .tab(tab.as_str())
                .map(|t| tab_extras(c, t))
                .unwrap_or_default();
            menu_items::tab_or_selection_full(state, window, tab, &targets, &extras)
        }
        MenuTarget::Group(group) => {
            let shared = shared_folder_menu(c, state, group);
            let plugins = c
                .host
                .plugins()
                .map(|host| {
                    crate::plugins::bar_actions::group_menu_entries(
                        host.as_ref(),
                        state,
                        window.id.as_str(),
                        group,
                    )
                })
                .unwrap_or_default();
            menu_items::with_symbols(
                menu_items::group_menu_full(state, window, group, c.look.dark, &shared, plugins),
                menu_items::GROUP_SYMBOLS,
            )
        }
        MenuTarget::Profile => menu_items::profile_menu(state, window),
        MenuTarget::LittleProfile => menu_items::profile_menu(state, window)
            .into_iter()
            .take_while(|entry| !matches!(entry, MenuEntry::Separator))
            .collect(),
        MenuTarget::TileFolder(folder) => tile_folder_menu(c, folder),
        MenuTarget::TileFolderActions(folder) => tile_folder_actions(c, folder),
        MenuTarget::LiveFolder(folder) => c
            .host
            .live()
            .map(|live| crate::live::menus::live_folder_menu(&live, folder, c.look.dark))
            .unwrap_or_default(),
        MenuTarget::LiveItem { folder, item, tab } => c
            .host
            .live()
            .map(|live| {
                crate::live::menus::live_item_menu(
                    &live,
                    state,
                    &window.id,
                    folder,
                    item,
                    tab.as_ref(),
                )
            })
            .unwrap_or_default(),
        MenuTarget::ProfileItem(profile) => crate::profiles::menu::profile_item_menu(
            state,
            profile,
            crate::profiles::menu::anchor_at(c.ui.menu.as_ref().map(|menu| menu.1)),
        ),
        MenuTarget::NewTab => menu_items::with_symbols(
            menu_items::sidebar_menu_with(
                state,
                window,
                cfg!(target_os = "macos") && !window.profile_id.is_incognito(),
            ),
            menu_items::SIDEBAR_SYMBOLS,
        ),
        MenuTarget::SidebarOverflow => {
            let devices = c
                .host
                .sync_status()
                .engine
                .remote_tabs
                .get(&window.profile_id)
                .cloned()
                .unwrap_or_default();
            crate::sidebar::overflow_menu::overflow_menu_with(state, window, &devices)
        }
        MenuTarget::Reload(tab) => crate::content::toolbar_menus::reload_menu(
            state,
            tab,
            crate::site::menus::reload_blocker(c, tab),
        ),
        MenuTarget::SplitPane(tab) => {
            crate::content::toolbar_menus::split_menu(state, &window.id, tab)
        }
        MenuTarget::UrlBar(tab, paste) => {
            crate::content::toolbar_menus::url_bar_menu(state, tab, paste.as_ref())
        }
        MenuTarget::DownloadsButton => {
            crate::popovers::downloads::downloads_button_menu(state, &window.id)
        }
        MenuTarget::Download(id) => state
            .downloads
            .items()
            .iter()
            .find(|d| d.id.to_string() == *id)
            .map(|d| crate::popovers::downloads::download_menu(d, c.host.opens_when_done(id)))
            .unwrap_or_default(),
        MenuTarget::Site(menu) => crate::site::menus::site_menu(c, menu)?,
        _ => return None,
    })
}

pub struct NativeMenu {
    pub items: Vec<NativeMenuItem>,
    pub picks: HashMap<String, Vec<Msg>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyEquivalent {
    pub key: String,
    pub modifiers: Vec<&'static str>,
}

pub fn key_equivalent(shortcut: Option<&str>) -> Option<KeyEquivalent> {
    use ardia_state::shortcuts::{Key, Shortcut};
    let parsed = Shortcut::parse_glyphs(shortcut?)?;
    if parsed.modifiers.function {
        return None;
    }
    let key = match parsed.key {
        Key::Char(c) => c.to_lowercase().collect(),
        Key::Up => '\u{F700}'.to_string(),
        Key::Down => '\u{F701}'.to_string(),
        Key::Left => '\u{F702}'.to_string(),
        Key::Right => '\u{F703}'.to_string(),
        Key::Function(n) => char::from_u32(0xF704 + u32::from(n.saturating_sub(1)))?.to_string(),
        Key::ForwardDelete => '\u{F728}'.to_string(),
        Key::Home => '\u{F729}'.to_string(),
        Key::End => '\u{F72B}'.to_string(),
        Key::PageUp => '\u{F72C}'.to_string(),
        Key::PageDown => '\u{F72D}'.to_string(),
        Key::Backspace => '\u{8}'.to_string(),
        Key::Tab => '\t'.to_string(),
        Key::Enter => '\r'.to_string(),
        Key::Escape => '\u{1B}'.to_string(),
        Key::Space => " ".to_owned(),
    };
    let m = parsed.modifiers;
    let modifiers = [
        (m.control, "control"),
        (m.option, "option"),
        (m.shift, "shift"),
        (m.command, "command"),
    ]
    .into_iter()
    .filter_map(|(on, name)| on.then_some(name))
    .collect();
    Some(KeyEquivalent { key, modifiers })
}

fn swatch_rgb(color: Hsla) -> u32 {
    let rgba = color.to_rgb();
    let channel = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u32;
    (channel(rgba.r) << 16) | (channel(rgba.g) << 8) | channel(rgba.b)
}

struct NativeBuilder {
    used: HashSet<String>,
    picks: HashMap<String, Vec<Msg>>,
}

impl NativeBuilder {
    fn id(&mut self, key: &str) -> String {
        let mut id = key.to_owned();
        let mut n = 2;
        while !self.used.insert(id.clone()) {
            id = format!("{key}#{n}");
            n += 1;
        }
        id
    }

    fn item(&mut self, item: &MenuItem, keys: Option<&KeyEquivalent>) -> NativeMenuItem {
        let id = self.id(&item.key);
        let enabled = item.enabled && !item.msgs.is_empty();
        if enabled {
            self.picks.insert(id.clone(), item.msgs.clone());
        }
        let symbol = item.symbol_name();
        let mut native =
            NativeMenuItem::new(&id, item.title.to_string(), symbol.as_deref().unwrap_or(""))
                .enabled(enabled)
                .checked(item.checked);
        if symbol.is_none()
            && let Some(color) = item.swatch
        {
            native = native.swatch(swatch_rgb(color));
        }
        if let Some(keys) = keys {
            native = native.key_equivalent(keys.key.clone(), &keys.modifiers);
        }
        native
    }

    fn entries(&mut self, entries: &[MenuEntry]) -> Vec<NativeMenuItem> {
        let mut out = Vec::new();
        for entry in entries {
            match entry {
                MenuEntry::Separator => out.push(NativeMenuItem::separator()),
                MenuEntry::Header(title) => {
                    let id = self.id("header");
                    out.push(NativeMenuItem::new(&id, title.to_string(), "").enabled(false));
                }
                MenuEntry::Item(item) => match &item.alternate {
                    None => {
                        let keys = key_equivalent(item.shortcut.as_deref());
                        out.push(self.item(item, keys.as_ref()));
                    }
                    Some(alternate) => {
                        let primary_keys = key_equivalent(item.shortcut.as_deref());
                        let alternate_keys = key_equivalent(alternate.shortcut.as_deref());
                        let paired = match (&primary_keys, &alternate_keys) {
                            (Some(a), Some(b)) => {
                                let mut with_option = a.modifiers.clone();
                                with_option.push("option");
                                with_option.sort_unstable();
                                let mut theirs = b.modifiers.clone();
                                theirs.sort_unstable();
                                a.key == b.key && with_option == theirs
                            }
                            _ => false,
                        };
                        let (first, second) = if paired {
                            (primary_keys, alternate_keys)
                        } else {
                            (
                                None,
                                Some(KeyEquivalent {
                                    key: String::new(),
                                    modifiers: vec!["option"],
                                }),
                            )
                        };
                        out.push(self.item(item, first.as_ref()));
                        out.push(self.item(alternate, second.as_ref()).alternate());
                    }
                },
                MenuEntry::Submenu(sub) => {
                    let id = self.id(&sub.key);
                    let children = self.entries(&sub.children);
                    let symbol = sub.symbol.clone().or_else(|| {
                        sub.icon
                            .map(|glyph| SharedString::new_static(glyph.symbol_name()))
                    });
                    out.push(
                        NativeMenuItem::new(
                            &id,
                            sub.title.to_string(),
                            symbol.as_deref().unwrap_or(""),
                        )
                        .enabled(sub.enabled && !sub.children.is_empty())
                        .children(children),
                    );
                }
            }
        }
        out
    }
}

pub fn native_menu(entries: &[MenuEntry]) -> NativeMenu {
    let mut builder = NativeBuilder {
        used: HashSet::new(),
        picks: HashMap::new(),
    };
    let items = builder.entries(entries);
    NativeMenu {
        items,
        picks: builder.picks,
    }
}

pub fn show_native(
    host: &Arc<dyn UiHost>,
    emit: &Emit,
    entries: &[MenuEntry],
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let NativeMenu { items, picks } = native_menu(entries);
    let Some(reply) = host.show_menu(items) else {
        return false;
    };
    crate::window::hover_hold::native_menu_opened();
    let emit = emit.clone();
    window
        .spawn(cx, async move |cx| {
            let answer = reply.await;
            crate::window::hover_hold::native_menu_closed();
            let Ok(Some(chosen)) = answer else {
                return;
            };
            let Some(msgs) = picks.get(&chosen).cloned() else {
                return;
            };
            crate::press_telemetry::note_menu_pick(&chosen);
            let _ = cx.update(|window, cx| {
                for msg in msgs {
                    emit.send(msg, window, cx);
                }
            });
        })
        .detach();
    true
}

pub fn target_entries(c: &Chrome, target: &MenuTarget) -> Option<Vec<MenuEntry>> {
    menu_entries(c, target).or_else(|| match target {
        MenuTarget::CastSource(tab) => Some(crate::popovers::extension_menus::cast_source_entries(
            c, tab,
        )),
        MenuTarget::Extensions => Some(crate::popovers::extension_menus::overflow_entries(c)),
        MenuTarget::Extension(id) => {
            Some(crate::popovers::extension_menus::extension_entries(c, id))
        }
        MenuTarget::CastRoutes => Some(crate::popovers::extension_menus::cast_routes_entries(c)),
        _ => None,
    })
}

pub fn present_native(c: &Chrome, target: &MenuTarget, window: &mut Window, cx: &mut App) -> bool {
    match target_entries(c, target) {
        Some(entries) => show_native(c.host, c.emit, &entries, window, cx),
        None => false,
    }
}

pub fn entries_menu(
    c: &Chrome,
    id: impl Into<SharedString>,
    entries: impl Into<std::rc::Rc<Vec<MenuEntry>>>,
    at: Point<Pixels>,
) -> AnyElement {
    deferred(
        anchored()
            .position(at)
            .snap_to_window_with_margin(px(8.))
            .child(MenuList {
                id: id.into(),
                entries: entries.into(),
                p: *c.p,
                emit: c.emit.clone(),
            }),
    )
    .with_priority(3)
    .into_any_element()
}

struct CachedMenu {
    window: ardia_state::WindowId,
    target: MenuTarget,
    at: Point<Pixels>,
    state: std::sync::Arc<ardia_state::BrowserState>,
    live: Option<std::sync::Arc<ardia_state::live::LiveState>>,
    sync: Option<SyncInput>,
    dark: bool,
    entries: std::rc::Rc<Vec<MenuEntry>>,
}

#[derive(Clone, PartialEq)]
enum SyncInput {
    SendTargets(Vec<crate::sync_api::SendTarget>),
    RemoteTabs(Vec<crate::sync_api::RemoteTabs>),
}

fn sync_input(c: &Chrome, target: &MenuTarget) -> Option<SyncInput> {
    match target {
        MenuTarget::Tab(tab) => {
            let profile = c.state.tab(tab.as_str())?.profile_id.clone();
            Some(SyncInput::SendTargets(
                c.host
                    .sync_status()
                    .engine
                    .send_targets
                    .get(&profile)
                    .cloned()
                    .unwrap_or_default(),
            ))
        }
        MenuTarget::SidebarOverflow => Some(SyncInput::RemoteTabs(
            c.host
                .sync_status()
                .engine
                .remote_tabs
                .get(&c.window.profile_id)
                .cloned()
                .unwrap_or_default(),
        )),
        _ => None,
    }
}

thread_local! {
    static CACHED_MENUS: std::cell::RefCell<Vec<CachedMenu>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn reads_outside_state(target: &MenuTarget) -> bool {
    matches!(
        target,
        MenuTarget::Site(_)
            | MenuTarget::CastSource(_)
            | MenuTarget::CastRoutes
            | MenuTarget::Extensions
            | MenuTarget::Extension(_)
    )
}

pub fn context_menu_cached(
    c: &Chrome,
    state: &std::sync::Arc<ardia_state::BrowserState>,
    target: &MenuTarget,
    at: Point<Pixels>,
) -> AnyElement {
    if reads_outside_state(target) {
        return context_menu(c, target, at);
    }
    let live = match target {
        MenuTarget::LiveFolder(_) | MenuTarget::LiveItem { .. } => c.host.live(),
        _ => None,
    };
    let sync = sync_input(c, target);
    let same_live =
        |cached: &Option<std::sync::Arc<ardia_state::live::LiveState>>| match (cached, &live) {
            (None, None) => true,
            (Some(a), Some(b)) => std::sync::Arc::ptr_eq(a, b),
            _ => false,
        };
    let found = CACHED_MENUS.with(|cell| {
        cell.borrow()
            .iter()
            .find(|cached| {
                cached.window == c.window.id
                    && cached.target == *target
                    && cached.at == at
                    && cached.dark == c.look.dark
                    && std::sync::Arc::ptr_eq(&cached.state, state)
                    && same_live(&cached.live)
                    && cached.sync == sync
            })
            .map(|cached| cached.entries.clone())
    });
    let entries = found.unwrap_or_else(|| {
        let entries = std::rc::Rc::new(target_entries(c, target).unwrap_or_default());
        CACHED_MENUS.with(|cell| {
            let mut cached = cell.borrow_mut();
            cached.retain(|menu| menu.window != c.window.id);
            cached.push(CachedMenu {
                window: c.window.id.clone(),
                target: target.clone(),
                at,
                state: std::sync::Arc::clone(state),
                live,
                sync,
                dark: c.look.dark,
                entries: entries.clone(),
            });
        });
        entries
    });
    entries_menu(c, format!("menu:{:?}:{:?}", target, at), entries, at)
}

pub fn forget_cached_menu(window: &ardia_state::WindowId) {
    CACHED_MENUS.with(|cell| cell.borrow_mut().retain(|menu| &menu.window != window));
}

pub fn context_menu(c: &Chrome, target: &MenuTarget, at: Point<Pixels>) -> AnyElement {
    let entries = target_entries(c, target).unwrap_or_default();
    entries_menu(c, format!("menu:{:?}:{:?}", target, at), entries, at)
}

#[derive(IntoElement)]
struct MenuList {
    id: SharedString,
    entries: std::rc::Rc<Vec<MenuEntry>>,
    p: Palette,
    emit: Emit,
}

#[derive(Default)]
struct OpenPath(Vec<SharedString>);

impl RenderOnce for MenuList {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let open = window.use_keyed_state(ElementId::Name(self.id.clone()), cx, |_, _| {
            OpenPath::default()
        });
        let path = open.read(cx).0.clone();
        let alternates = window.modifiers().alt;
        let ctx = MenuCtx {
            p: self.p,
            emit: self.emit,
            open,
            path,
            alternates,
        };
        let mut root = div()
            .relative()
            .on_modifiers_changed(|_, window, _| window.refresh())
            .child(level(&ctx, &self.entries, 0, "context-menu"));
        let mut entries: &[MenuEntry] = &self.entries;
        let mut top = 0.0;
        for (depth, key) in ctx.path.iter().enumerate() {
            let Some((offset, sub)) = submenu_at(entries, key) else {
                break;
            };
            if !sub.enabled || sub.children.is_empty() {
                break;
            }
            top += offset;
            root = root.child(
                div()
                    .absolute()
                    .left(px(
                        (depth + 1) as f32 * (MENU_WIDTH - panel::ROW_INSET - SUBMENU_OVERLAP)
                    ))
                    .top(px(top))
                    .child(level(&ctx, &sub.children, depth + 1, "context-submenu")),
            );
            entries = &sub.children;
        }
        root
    }
}

fn entry_height(entry: &MenuEntry) -> f32 {
    match entry {
        MenuEntry::Separator => panel::SEPARATOR_GAP * 2.0 + 0.5,
        MenuEntry::Header(_) => HEADER_HEIGHT,
        MenuEntry::Item(_) | MenuEntry::Submenu(_) => panel::ROW_HEIGHT,
    }
}

fn submenu_at<'a>(entries: &'a [MenuEntry], key: &SharedString) -> Option<(f32, &'a Submenu)> {
    let mut offset = 0.0;
    for entry in entries {
        if let MenuEntry::Submenu(sub) = entry
            && &sub.key == key
        {
            return Some((offset, sub));
        }
        offset += entry_height(entry);
    }
    None
}

struct MenuCtx {
    p: Palette,
    emit: Emit,
    open: gpui::Entity<OpenPath>,
    path: Vec<SharedString>,
    alternates: bool,
}

fn level(
    ctx: &MenuCtx,
    entries: &[MenuEntry],
    depth: usize,
    selector: &'static str,
) -> gpui::Stateful<gpui::Div> {
    let p = &ctx.p;
    popover(
        SharedString::from(format!("{selector}:{depth}")),
        false,
        MENU_WIDTH,
        p,
    )
    .debug_selector(move || selector.into())
    .children(entries.iter().map(|entry| {
        match entry {
            MenuEntry::Separator => separator(p).into_any_element(),
            MenuEntry::Header(title) => div()
                .h(px(HEADER_HEIGHT))
                .flex()
                .items_end()
                .child(section_label(title.clone(), p))
                .into_any_element(),
            MenuEntry::Item(item) => {
                let shown = match (&item.alternate, ctx.alternates) {
                    (Some(alternate), true) => alternate.as_ref(),
                    _ => item,
                };
                item_row(ctx, shown, depth).into_any_element()
            }
            MenuEntry::Submenu(sub) => submenu_row(ctx, sub, depth).into_any_element(),
        }
    }))
}

fn hover_closes(ctx: &MenuCtx, depth: usize) -> impl Fn(&bool, &mut Window, &mut App) + 'static {
    let open = ctx.open.clone();
    move |hovered, _, cx| {
        if *hovered {
            open.update(cx, |open, cx| {
                if open.0.len() > depth {
                    open.0.truncate(depth);
                    cx.notify();
                }
            });
        }
    }
}

fn item_row(ctx: &MenuCtx, item: &MenuItem, depth: usize) -> impl IntoElement {
    let p = &ctx.p;
    let mut row = MenuRow::new(
        ElementId::Name(SharedString::from(format!("menu-{}", item.key))),
        item.title.clone(),
        p,
    )
    .checked(item.checked)
    .destructive(item.destructive)
    .disabled(!item.enabled || item.msgs.is_empty());
    if let Some(glyph) = item.icon {
        row = row.icon(glyph);
    }
    if let Some(shortcut) = &item.shortcut {
        row = row.trailing(shortcut.clone());
    }
    let emit = ctx.emit.clone();
    let msgs = item.msgs.clone();
    let picked = item.key.clone();
    let row = row.on_click(move |_, window, cx| {
        crate::press_telemetry::note_menu_pick(&picked);
        emit.send(Msg::Menu(None), window, cx);
        for msg in msgs.iter().cloned() {
            emit.send(msg, window, cx);
        }
    });
    div()
        .id(SharedString::from(format!("menu-item-wrap:{}", item.key)))
        .relative()
        .on_hover(hover_closes(ctx, depth))
        .child(row)
        .when_some(
            item.swatch.filter(|_| !item.checked || item.icon.is_some()),
            |this, swatch| this.child(swatch_dot(swatch, p)),
        )
}

fn swatch_dot(swatch: Hsla, p: &Palette) -> impl IntoElement {
    div()
        .absolute()
        .left(px(panel::ROW_INSET
            + panel::ROW_PADDING
            + (panel::ICON_SLOT - SWATCH) / 2.0))
        .top(px((panel::ROW_HEIGHT - SWATCH) / 2.0))
        .size(px(SWATCH))
        .rounded_full()
        .bg(swatch)
        .border(px(0.5))
        .border_color(p.chip_border)
}

fn submenu_row(ctx: &MenuCtx, sub: &Submenu, depth: usize) -> impl IntoElement {
    let p = &ctx.p;
    let enabled = sub.enabled && !sub.children.is_empty();
    let mut row = MenuRow::new(
        ElementId::Name(SharedString::from(format!("menu-{}", sub.key))),
        sub.title.clone(),
        p,
    )
    .disabled(!enabled);
    if let Some(glyph) = sub.icon {
        row = row.icon(glyph);
    }
    let open = ctx.open.clone();
    let key = sub.key.clone();
    let open_on_click = ctx.open.clone();
    let key_on_click = sub.key.clone();
    let row = row.on_click(move |_, _, cx| {
        open_on_click.update(cx, |open, cx| {
            open.0.truncate(depth);
            open.0.push(key_on_click.clone());
            cx.notify();
        });
    });
    div()
        .id(SharedString::from(format!("menu-sub-wrap:{}", sub.key)))
        .relative()
        .on_hover(move |hovered, _, cx| {
            if *hovered && enabled {
                open.update(cx, |open, cx| {
                    if open.0.get(depth) != Some(&key) || open.0.len() != depth + 1 {
                        open.0.truncate(depth);
                        open.0.push(key.clone());
                        cx.notify();
                    }
                });
            }
        })
        .child(row)
        .child(
            div()
                .absolute()
                .right(px(panel::ROW_INSET + panel::ROW_PADDING))
                .top(px((panel::ROW_HEIGHT - panel::ICON_SIZE) / 2.0))
                .child(icon(
                    Icon::ChevronRight,
                    panel::ICON_SIZE,
                    if enabled {
                        p.text_tertiary
                    } else {
                        p.text_tertiary.opacity(0.4)
                    },
                )),
        )
}

fn shared_folder_menu(
    c: &Chrome,
    state: &ardia_state::BrowserState,
    group: &ardia_state::GroupId,
) -> menu_items::SharedFolderMenu {
    let Some(g) = state.group(group.as_str()) else {
        return menu_items::SharedFolderMenu::Unavailable;
    };
    if !cfg!(target_os = "macos")
        || !g.pinned
        || g.parent_id.is_some()
        || g.profile_id.is_incognito()
    {
        return menu_items::SharedFolderMenu::Unavailable;
    }
    let status = c.host.sync_status();
    match status
        .shared_folders
        .iter()
        .find(|f| f.profile_id == g.profile_id && f.group_key == g.pin_key())
    {
        Some(folder) => menu_items::SharedFolderMenu::Shared {
            status: if folder.status_text.is_empty() {
                "Syncing…".to_owned()
            } else {
                folder.status_text.clone()
            },
        },
        None => menu_items::SharedFolderMenu::Share,
    }
}
