use std::hash::{DefaultHasher, Hash, Hasher};
use std::rc::Rc;

use ardia_state::BrowserState;
use ardia_state::commands::Command;
use ardia_state::shortcuts::{
    Key, Platform, Shortcut, ShortcutMap, ShortcutSource, default_sources,
};
use gpui::{Action, App, Global, KeyBinding, KeyBindingContextPredicate, SharedString, actions};

use crate::primitives::text_input;

#[derive(Clone, PartialEq, Eq, Debug, gpui::Action)]
#[action(namespace = ardia_ui, no_json)]
pub struct RunCommand {
    pub id: SharedString,
}

#[derive(Clone, PartialEq, Eq, Debug, gpui::Action)]
#[action(namespace = ardia_ui, no_json)]
pub struct RunReservedCommand {
    pub id: SharedString,
}

actions!(ardia_ui, [Dismiss]);

pub const APP_CONTEXT: &str = "ArdiaWindow";
pub const BROWSER_CONTEXT: &str = "BrowserWindow";
pub const LITTLE_CONTEXT: &str = "LittleArdia";
pub const SETTINGS_CONTEXT: &str = "SettingsWindow";
pub const PAGE_FULL_SCREEN_CONTEXT: &str = "PageFullScreen";

const RESERVED_OVER_A_FULL_SCREEN_PAGE: &[&str] = &["std:toggleFullScreen:"];

const RESERVED: &[&str] = &[
    "newTab",
    "closeTab",
    "newWindow",
    "newIncognitoWindow",
    "newLittleArdia",
    "reopenClosedTab",
    "focusCommandBar",
    "nextTab",
    "previousTab",
    "selectTab",
    "selectLastTab",
    "switchProfile",
    "nextProfile",
    "previousProfile",
    "openSettings",
    "std:closeWindow:",
];

const LEFT_TO_THE_PLATFORM: &[&str] = &[
    "std:undo:",
    "std:redo:",
    "std:cut:",
    "std:copy:",
    "std:paste:",
    "std:pasteAndMatchStyle:",
    "std:selectAll:",
    "std:quit:",
    "std:hide:",
    "std:hideOtherApplications:",
    "std:unhideAllApplications:",
    "std:miniaturizeAll:",
];

impl RunCommand {
    pub fn new(id: impl Into<SharedString>) -> Self {
        RunCommand { id: id.into() }
    }
}

impl RunReservedCommand {
    pub fn new(id: impl Into<SharedString>) -> Self {
        RunReservedCommand { id: id.into() }
    }
}

pub const MOUSE_BUTTON_KEYS: [(i64, &str); 3] =
    [(2, "mouse:middle"), (3, "mouse:4"), (4, "mouse:5")];
pub const MOUSE_MODIFIER_FLAGS: [(&str, u64); 4] = [
    ("shift", 1 << 17),
    ("control", 1 << 18),
    ("option", 1 << 19),
    ("command", 1 << 20),
];
const MOUSE_MODIFIER_MASK: u64 = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MouseShortcutTable {
    commands: std::collections::HashMap<(i64, u64), String>,
}

impl MouseShortcutTable {
    pub fn new<'a>(
        bindings: impl IntoIterator<Item = (&'a String, &'a Vec<String>)>,
        bindable: impl Fn(&str) -> bool,
    ) -> Self {
        let mut commands = std::collections::HashMap::new();
        for (id, stored) in bindings {
            if !bindable(id) {
                continue;
            }
            let Some(button) = stored.first().and_then(|key| {
                MOUSE_BUTTON_KEYS
                    .iter()
                    .find(|(_, name)| name == key)
                    .map(|(button, _)| *button)
            }) else {
                continue;
            };
            let flags = stored.iter().skip(1).fold(0u64, |flags, name| {
                flags
                    | MOUSE_MODIFIER_FLAGS
                        .iter()
                        .find(|(known, _)| known == name)
                        .map_or(0, |(_, bit)| *bit)
            });
            commands.insert((button, flags), id.clone());
        }
        MouseShortcutTable { commands }
    }

    pub fn of(state: &BrowserState) -> Self {
        Self::new(state.settings.mouse_shortcuts.iter(), |id| {
            id != "tabSwitcher"
                && ardia_state::commands::COMMANDS
                    .iter()
                    .any(|spec| spec.command.id() == id)
        })
    }

    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }

    pub fn command(&self, button: i64, modifier_flags: u64) -> Option<&str> {
        MOUSE_BUTTON_KEYS
            .iter()
            .find(|(known, _)| *known == button)?;
        self.commands
            .get(&(button, modifier_flags & MOUSE_MODIFIER_MASK))
            .map(String::as_str)
    }
}

pub fn key_name(key: Key) -> Option<String> {
    Some(match key {
        Key::Char(' ') | Key::Space => "space".to_owned(),
        Key::Char(c) => c.to_lowercase().collect(),
        Key::Up => "up".to_owned(),
        Key::Down => "down".to_owned(),
        Key::Left => "left".to_owned(),
        Key::Right => "right".to_owned(),
        Key::PageUp => "pageup".to_owned(),
        Key::PageDown => "pagedown".to_owned(),
        Key::Home => "home".to_owned(),
        Key::End => "end".to_owned(),
        Key::ForwardDelete => "delete".to_owned(),
        Key::Backspace => "backspace".to_owned(),
        Key::Tab => "tab".to_owned(),
        Key::Enter => "enter".to_owned(),
        Key::Escape => "escape".to_owned(),
        Key::Function(n) if (1..=24).contains(&n) => format!("f{n}"),
        Key::Function(_) => return None,
    })
}

pub fn keystroke(shortcut: &Shortcut) -> Option<String> {
    let key = key_name(shortcut.key)?;
    let modifiers = shortcut.modifiers;
    let mut out = String::with_capacity(24);
    for (on, name) in [
        (modifiers.control, "ctrl-"),
        (modifiers.option, "alt-"),
        (modifiers.shift, "shift-"),
        (modifiers.command, "cmd-"),
        (modifiers.function, "fn-"),
    ] {
        if on {
            out.push_str(name);
        }
    }
    out.push_str(&key);
    Some(out)
}

pub fn is_reserved(id: &str) -> bool {
    let base = id.split_once(':').map_or(id, |(base, _)| base);
    RESERVED.contains(&id) || RESERVED.contains(&base)
}

pub fn handled_by_platform(id: &str) -> bool {
    LEFT_TO_THE_PLATFORM.contains(&id)
}

pub fn action_for(id: &str) -> Box<dyn Action> {
    let id = SharedString::from(id.to_owned());
    if is_reserved(&id) {
        Box::new(RunReservedCommand { id })
    } else {
        Box::new(RunCommand { id })
    }
}

fn contexts_for(id: &str) -> &'static [&'static str] {
    match Command::parse_id(id) {
        Some((command, _)) if command.is_app_wide() => &[APP_CONTEXT],
        Some((command, _)) if command.allowed_in_little_ardia() => {
            &[BROWSER_CONTEXT, LITTLE_CONTEXT]
        }
        Some(_) => &[BROWSER_CONTEXT],
        None => &[],
    }
}

fn predicates() -> Vec<(&'static str, Rc<KeyBindingContextPredicate>)> {
    [APP_CONTEXT, BROWSER_CONTEXT, LITTLE_CONTEXT]
        .into_iter()
        .filter_map(|name| {
            KeyBindingContextPredicate::parse(name)
                .ok()
                .map(|predicate| (name, Rc::new(predicate)))
        })
        .collect()
}

pub fn command_bindings(
    sources: &[ShortcutSource],
    map: &ShortcutMap,
    cx: &App,
) -> Vec<KeyBinding> {
    let predicates = predicates();
    let mut out = Vec::with_capacity(sources.len() * 2);
    let mut late = Vec::new();
    for source in sources {
        if handled_by_platform(&source.id) {
            continue;
        }
        for name in contexts_for(&source.id) {
            let Some((_, predicate)) = predicates.iter().find(|(known, _)| known == name) else {
                continue;
            };
            let page_scoped = *name != APP_CONTEXT;
            let reserved = is_reserved(&source.id);
            let over_full_page = RESERVED_OVER_A_FULL_SCREEN_PAGE.contains(&source.id.as_str());
            for shortcut in map.bindings(&source.id) {
                let Some(keys) = keystroke(shortcut) else {
                    continue;
                };
                let load = |action: Box<dyn Action>,
                            predicate: Rc<KeyBindingContextPredicate>,
                            into: &mut Vec<KeyBinding>| {
                    match KeyBinding::load(&keys, action, Some(predicate), false, None, cx) {
                        Ok(binding) => into.push(binding),
                        Err(error) => {
                            log::debug!("skipped shortcut {keys} for {}: {error}", source.id)
                        }
                    }
                };
                match (page_scoped && reserved, page_scoped && over_full_page) {
                    (true, _) => {
                        if let Some(clear) = scoped(name, false) {
                            load(action_for(&source.id), clear, &mut out);
                        }
                        if let Some(full) = scoped(name, true) {
                            load(Box::new(RunCommand::new(source.id.clone())), full, &mut out);
                        }
                    }
                    (false, true) => {
                        load(action_for(&source.id), Rc::clone(predicate), &mut out);
                        if let Some(full) = scoped(name, true) {
                            load(
                                Box::new(RunReservedCommand::new(source.id.clone())),
                                full,
                                &mut late,
                            );
                        }
                    }
                    (false, false) => load(action_for(&source.id), Rc::clone(predicate), &mut out),
                }
            }
        }
    }
    out.extend(late);
    out
}

fn scoped(name: &str, page_full_screen: bool) -> Option<Rc<KeyBindingContextPredicate>> {
    let not = if page_full_screen { "" } else { "!" };
    KeyBindingContextPredicate::parse(&format!("{name} && {not}{PAGE_FULL_SCREEN_CONTEXT}"))
        .ok()
        .map(Rc::new)
}

pub fn fixed_bindings() -> Vec<KeyBinding> {
    let mut list = text_input::bindings();
    list.push(KeyBinding::new("escape", Dismiss, Some(BROWSER_CONTEXT)));
    list.push(KeyBinding::new("escape", Dismiss, Some(LITTLE_CONTEXT)));
    list.push(KeyBinding::new("escape", Dismiss, Some(APP_CONTEXT)));
    list.push(KeyBinding::new(
        if cfg!(target_os = "macos") {
            "cmd-f"
        } else {
            "ctrl-f"
        },
        RunCommand {
            id: SharedString::new_static("findInPage"),
        },
        Some(SETTINGS_CONTEXT),
    ));
    list
}

fn is_ours(binding: &KeyBinding) -> bool {
    let name = binding.action().name();
    name.starts_with("ardia_ui::") || name.starts_with("ardia_input::")
}

#[derive(Default)]
struct BoundKeys {
    signature: Option<u64>,
}

impl Global for BoundKeys {}

fn install(sources: &[ShortcutSource], map: &ShortcutMap, signature: u64, cx: &mut App) {
    let mut bindings = fixed_bindings();
    bindings.extend(command_bindings(sources, map, cx));
    let kept: Vec<KeyBinding> = cx
        .key_bindings()
        .borrow()
        .bindings()
        .filter(|binding| !is_ours(binding))
        .cloned()
        .collect();
    cx.clear_key_bindings();
    cx.bind_keys(kept);
    cx.bind_keys(bindings);
    cx.set_global(BoundKeys {
        signature: Some(signature),
    });
}

pub fn bind_defaults(cx: &mut App) {
    let platform = Platform::current();
    let sources = default_sources(platform, &[]);
    let map = ShortcutMap::resolve(&sources, &Default::default());
    install(&sources, &map, 0, cx);
}

pub fn signature(state: &BrowserState) -> u64 {
    let mut hasher = DefaultHasher::new();
    1u8.hash(&mut hasher);
    if let Some(shortcuts) = state.settings.get("shortcuts") {
        shortcuts.to_string().hash(&mut hasher);
    }
    for profile in state.profile_order.iter() {
        profile.as_str().hash(&mut hasher);
    }
    hasher.finish()
}

pub fn sync(state: &BrowserState, cx: &mut App) -> bool {
    let signature = signature(state);
    if cx
        .try_global::<BoundKeys>()
        .is_some_and(|bound| bound.signature == Some(signature))
    {
        return false;
    }
    let platform = Platform::current();
    let sources = default_sources(platform, &state.profile_order);
    let map = state.shortcut_map(platform);
    install(&sources, &map, signature, cx);
    true
}

pub fn hint(state: &BrowserState, id: &str) -> Option<String> {
    thread_local! {
        static RESOLVED: std::cell::RefCell<Option<(u64, ShortcutMap)>> =
            const { std::cell::RefCell::new(None) };
    }
    let platform = Platform::current();
    let key = hint_key(state, platform);
    RESOLVED.with_borrow_mut(|resolved| {
        if resolved.as_ref().is_none_or(|(held, _)| *held != key) {
            *resolved = Some((key, state.shortcut_map(platform)));
        }
        resolved
            .as_ref()
            .and_then(|(_, map)| map.hint(id, platform))
    })
}

fn hint_key(state: &BrowserState, platform: Platform) -> u64 {
    let mut hasher = DefaultHasher::new();
    platform.hash(&mut hasher);
    for (command, keys) in &state.settings.shortcuts {
        command.hash(&mut hasher);
        keys.hash(&mut hasher);
    }
    for profile in state.profile_order.iter() {
        profile.as_str().hash(&mut hasher);
    }
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouse_shortcuts_match_buttons_and_modifiers_like_the_old_table() {
        let mut bindings = std::collections::BTreeMap::new();
        bindings.insert("newTab".to_owned(), vec!["mouse:middle".to_owned()]);
        bindings.insert(
            "closeTab".to_owned(),
            vec!["mouse:4".to_owned(), "command".to_owned()],
        );
        bindings.insert("tabSwitcher".to_owned(), vec!["mouse:5".to_owned()]);
        bindings.insert("nope".to_owned(), vec!["t".to_owned()]);
        let table = MouseShortcutTable::new(bindings.iter(), |id| id != "tabSwitcher");
        assert_eq!(table.command(2, 0), Some("newTab"));
        assert_eq!(table.command(2, 1 << 20), None);
        assert_eq!(table.command(3, (1 << 20) | (1 << 8)), Some("closeTab"));
        assert_eq!(table.command(3, 0), None);
        assert_eq!(table.command(4, 0), None);
        assert_eq!(table.command(0, 0), None);
    }
    use ardia_state::shortcuts::Modifiers;

    #[test]
    fn shortcuts_become_gpui_keystrokes() {
        let new_tab = Shortcut::parse_glyphs("⌘T").expect("parses");
        assert_eq!(keystroke(&new_tab).as_deref(), Some("cmd-t"));
        let reopen = Shortcut::parse_glyphs("⇧⌘T").expect("parses");
        assert_eq!(keystroke(&reopen).as_deref(), Some("shift-cmd-t"));
        let profile = Shortcut::new(
            Key::Char('2'),
            Modifiers {
                control: true,
                ..Modifiers::NONE
            },
        );
        assert_eq!(keystroke(&profile).as_deref(), Some("ctrl-2"));
        let tab = Shortcut::parse_glyphs("⌃⇧⇥").expect("parses");
        assert_eq!(keystroke(&tab).as_deref(), Some("ctrl-shift-tab"));
        assert_eq!(key_name(Key::Function(12)).as_deref(), Some("f12"));
        assert_eq!(key_name(Key::Function(30)), None);
    }

    #[test]
    fn browser_chrome_shortcuts_are_reserved_from_the_page() {
        assert!(is_reserved("newTab"));
        assert!(is_reserved("selectTab:3"));
        assert!(is_reserved("switchProfile:p-1"));
        assert!(!is_reserved("back"));
        assert!(!is_reserved("toggleSidebar"));
        assert!(handled_by_platform("std:copy:"));
        assert!(!handled_by_platform("std:closeWindow:"));
    }

    #[test]
    fn only_the_catalog_switches_profiles_from_the_keyboard() {
        let fixed = fixed_bindings();
        assert!(fixed.iter().all(|binding| {
            binding
                .action()
                .as_any()
                .downcast_ref::<RunCommand>()
                .is_none_or(|run| run.id != "previousProfile" && run.id != "nextProfile")
        }));
    }

    #[test]
    fn a_full_screen_page_gets_the_reserved_keys_first() {
        let window = gpui::KeyContext::parse("ArdiaWindow BrowserWindow").expect("parses");
        let full =
            gpui::KeyContext::parse("ArdiaWindow BrowserWindow PageFullScreen").expect("parses");
        let clear = scoped(BROWSER_CONTEXT, false).expect("parses");
        let page = scoped(BROWSER_CONTEXT, true).expect("parses");
        assert!(clear.eval(std::slice::from_ref(&window)));
        assert!(!clear.eval(std::slice::from_ref(&full)));
        assert!(page.eval(std::slice::from_ref(&full)));
        assert!(!page.eval(std::slice::from_ref(&window)));
        assert!(RESERVED_OVER_A_FULL_SCREEN_PAGE.contains(&"std:toggleFullScreen:"));
    }

    #[test]
    fn commands_bind_in_the_windows_that_allow_them() {
        assert_eq!(contexts_for("openSettings"), &[APP_CONTEXT]);
        assert_eq!(contexts_for("closeAllTabs"), &[BROWSER_CONTEXT]);
        assert_eq!(contexts_for("reload"), &[BROWSER_CONTEXT, LITTLE_CONTEXT]);
        assert!(contexts_for("nope").is_empty());
    }

    #[test]
    fn a_changed_shortcut_shows_in_hints_without_a_stale_cache() {
        let mut state = BrowserState::default();
        let before = hint(&state, "closeTab");
        assert!(before.is_some());
        std::sync::Arc::make_mut(&mut state.settings)
            .shortcuts
            .insert("closeTab".to_owned(), vec!["cmd+shift+k".to_owned()]);
        let after = hint(&state, "closeTab");
        assert_ne!(after, before);
        assert_eq!(hint(&state, "closeTab"), after);
    }
}
