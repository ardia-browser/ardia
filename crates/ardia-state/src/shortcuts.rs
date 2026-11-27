use crate::commands::{COMMANDS, Command, DESKTOP_KEYS};
use crate::ids::ProfileId;
use indexmap::IndexMap;
use std::collections::HashMap;
use std::fmt::Write as _;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Mac
        } else if cfg!(target_os = "windows") {
            Platform::Windows
        } else {
            Platform::Linux
        }
    }

    pub const fn is_mac(self) -> bool {
        matches!(self, Platform::Mac)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Modifiers {
    pub control: bool,
    pub option: bool,
    pub shift: bool,
    pub command: bool,
    pub function: bool,
}

impl Modifiers {
    pub const NONE: Modifiers = Modifiers {
        control: false,
        option: false,
        shift: false,
        command: false,
        function: false,
    };
    pub const COMMAND: Modifiers = Modifiers {
        command: true,
        ..Modifiers::NONE
    };

    fn names(self) -> Vec<&'static str> {
        [
            (self.control, "control"),
            (self.option, "option"),
            (self.shift, "shift"),
            (self.command, "command"),
            (self.function, "function"),
        ]
        .into_iter()
        .filter_map(|(on, name)| on.then_some(name))
        .collect()
    }

    fn set(&mut self, name: &str) -> bool {
        match name {
            "control" => self.control = true,
            "option" => self.option = true,
            "shift" => self.shift = true,
            "command" => self.command = true,
            "function" => self.function = true,
            _ => return false,
        }
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Key {
    Char(char),
    Up,
    Down,
    Left,
    Right,
    PageUp,
    PageDown,
    Home,
    End,
    ForwardDelete,
    Backspace,
    Tab,
    Enter,
    Escape,
    Space,
    Function(u8),
}

const APPKIT_FIRST_FUNCTION: u32 = 0xF704;

impl Key {
    fn from_glyph(name: &str) -> Option<Key> {
        let key = match name {
            "⇥" => Key::Tab,
            "↩" | "⌤" => Key::Enter,
            "⌫" => Key::Backspace,
            "⌦" => Key::ForwardDelete,
            "⎋" => Key::Escape,
            "Space" => Key::Space,
            "↑" => Key::Up,
            "↓" => Key::Down,
            "←" => Key::Left,
            "→" => Key::Right,
            "↖" => Key::Home,
            "↘" => Key::End,
            "⇞" => Key::PageUp,
            "⇟" => Key::PageDown,
            _ => {
                if let Some(n) = name
                    .strip_prefix('F')
                    .and_then(|n| n.parse::<u8>().ok())
                    .filter(|n| (1..=35).contains(n))
                {
                    return Some(Key::Function(n));
                }
                let mut chars = name.chars();
                let c = chars.next()?;
                return chars.next().is_none().then_some(Key::Char(c));
            }
        };
        Some(key)
    }

    fn from_appkit(text: &str) -> Option<Key> {
        let mut chars = text.chars();
        let c = chars.next()?;
        if chars.next().is_some() {
            return None;
        }
        let key = match c as u32 {
            0xF700 => Key::Up,
            0xF701 => Key::Down,
            0xF702 => Key::Left,
            0xF703 => Key::Right,
            0xF729 => Key::Home,
            0xF72B => Key::End,
            0xF72C => Key::PageUp,
            0xF72D => Key::PageDown,
            0xF728 => Key::ForwardDelete,
            0x08 | 0x7F => Key::Backspace,
            0x09 => Key::Tab,
            0x0D | 0x03 => Key::Enter,
            0x1B => Key::Escape,
            0x20 => Key::Space,
            n @ APPKIT_FIRST_FUNCTION..=0xF726 => {
                Key::Function((n - APPKIT_FIRST_FUNCTION + 1) as u8)
            }
            _ => Key::Char(c),
        };
        Some(key)
    }

    fn from_layout_code(text: &str) -> Option<Key> {
        match text {
            "\u{1c}" => Some(Key::Left),
            "\u{1d}" => Some(Key::Right),
            "\u{1e}" => Some(Key::Up),
            "\u{1f}" => Some(Key::Down),
            "\u{1}" => Some(Key::Home),
            "\u{4}" => Some(Key::End),
            "\u{b}" => Some(Key::PageUp),
            "\u{c}" => Some(Key::PageDown),
            "\u{7f}" => Some(Key::ForwardDelete),
            _ => None,
        }
    }

    fn appkit(self) -> String {
        let code = match self {
            Key::Char(c) => return c.to_string(),
            Key::Up => 0xF700,
            Key::Down => 0xF701,
            Key::Left => 0xF702,
            Key::Right => 0xF703,
            Key::Home => 0xF729,
            Key::End => 0xF72B,
            Key::PageUp => 0xF72C,
            Key::PageDown => 0xF72D,
            Key::ForwardDelete => 0xF728,
            Key::Backspace => 0x08,
            Key::Tab => 0x09,
            Key::Enter => 0x0D,
            Key::Escape => 0x1B,
            Key::Space => 0x20,
            Key::Function(n) => APPKIT_FIRST_FUNCTION + u32::from(n) - 1,
        };
        char::from_u32(code).map(String::from).unwrap_or_default()
    }

    fn mac_name(self) -> String {
        match self {
            Key::Char(c) => c.to_uppercase().collect(),
            Key::Up => "↑".into(),
            Key::Down => "↓".into(),
            Key::Left => "←".into(),
            Key::Right => "→".into(),
            Key::PageUp => "⇞".into(),
            Key::PageDown => "⇟".into(),
            Key::Home => "↖".into(),
            Key::End => "↘".into(),
            Key::ForwardDelete => "⌦".into(),
            Key::Backspace => "⌫".into(),
            Key::Tab => "⇥".into(),
            Key::Enter => "↩".into(),
            Key::Escape => "⎋".into(),
            Key::Space => "Space".into(),
            Key::Function(n) => format!("F{n}"),
        }
    }

    fn desktop_name(self) -> String {
        match self {
            Key::Char('+') => "Plus".into(),
            Key::Char(c) => c.to_uppercase().collect(),
            Key::Up => "Up".into(),
            Key::Down => "Down".into(),
            Key::Left => "Left".into(),
            Key::Right => "Right".into(),
            Key::PageUp => "PgUp".into(),
            Key::PageDown => "PgDn".into(),
            Key::Home => "Home".into(),
            Key::End => "End".into(),
            Key::ForwardDelete => "Del".into(),
            Key::Backspace => "Backspace".into(),
            Key::Tab => "Tab".into(),
            Key::Enter => "Enter".into(),
            Key::Escape => "Esc".into(),
            Key::Space => "Space".into(),
            Key::Function(n) => format!("F{n}"),
        }
    }

    fn from_word(word: &str) -> Option<Key> {
        let lower = word.to_lowercase();
        let named = match lower.as_str() {
            "left" => Some(Key::Left),
            "right" => Some(Key::Right),
            "up" => Some(Key::Up),
            "down" => Some(Key::Down),
            "pgup" | "pageup" => Some(Key::PageUp),
            "pgdn" | "pagedown" => Some(Key::PageDown),
            "home" => Some(Key::Home),
            "end" => Some(Key::End),
            "del" | "delete" => Some(Key::ForwardDelete),
            "backspace" => Some(Key::Backspace),
            "tab" => Some(Key::Tab),
            "enter" | "return" => Some(Key::Enter),
            "esc" | "escape" => Some(Key::Escape),
            "space" => Some(Key::Space),
            "plus" => Some(Key::Char('+')),
            _ => None,
        };
        named
            .or_else(|| {
                lower
                    .strip_prefix('f')
                    .and_then(|n| n.parse::<u8>().ok())
                    .filter(|n| (1..=24).contains(n))
                    .map(Key::Function)
            })
            .or_else(|| match Key::from_glyph(word)? {
                Key::Char(c) => Some(Key::Char(c.to_lowercase().next().unwrap_or(c))),
                other => Some(other),
            })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Shortcut {
    pub key: Key,
    pub modifiers: Modifiers,
}

impl Shortcut {
    pub fn new(key: Key, modifiers: Modifiers) -> Self {
        Shortcut { key, modifiers }.normalized()
    }

    fn normalized(mut self) -> Self {
        if let Key::Char(c) = self.key
            && c.is_uppercase()
        {
            self.key = Key::Char(c.to_lowercase().next().unwrap_or(c));
            self.modifiers.shift = true;
        }
        self
    }

    pub fn parse_glyphs(text: &str) -> Option<Shortcut> {
        let glyphs: Vec<char> = text.chars().collect();
        let mut modifiers = Modifiers::NONE;
        let mut at = 0;
        while at + 1 < glyphs.len() {
            match glyphs[at] {
                '⌃' => modifiers.control = true,
                '⌥' => modifiers.option = true,
                '⇧' => modifiers.shift = true,
                '⌘' => modifiers.command = true,
                '🌐' => modifiers.function = true,
                _ => break,
            }
            at += 1;
        }
        let name: String = glyphs[at..].iter().collect();
        let key = Key::from_glyph(&name)?;
        let key = match key {
            Key::Char(c) => Key::Char(c.to_lowercase().next().unwrap_or(c)),
            other => other,
        };
        Some(Shortcut { key, modifiers })
    }

    pub fn from_stored(stored: &[String]) -> Option<Shortcut> {
        let (key_text, names) = stored.split_first()?;
        let mut modifiers = Modifiers::NONE;
        for name in names {
            modifiers.set(name);
        }
        let layout = if modifiers.function {
            Key::from_layout_code(key_text)
        } else {
            None
        };
        if layout.is_some() {
            modifiers.function = false;
        }
        let key = layout.or_else(|| Key::from_appkit(key_text))?;
        Some(Shortcut::new(key, modifiers))
    }

    pub fn to_stored(&self) -> Vec<String> {
        std::iter::once(self.key.appkit())
            .chain(self.modifiers.names().into_iter().map(str::to_owned))
            .collect()
    }

    pub fn parse_combo(text: &str, platform: Platform) -> Option<Shortcut> {
        let parts: Vec<&str> = if let Some(head) = text.strip_suffix("++") {
            head.split('+').chain(["+"]).collect()
        } else {
            text.split('+').collect()
        };
        let (name, words) = parts.split_last()?;
        let mut modifiers = Modifiers::NONE;
        for word in words {
            let lower = word.trim().to_lowercase();
            let role = match (lower.as_str(), platform.is_mac()) {
                ("cmd" | "command" | "meta" | "super" | "win", true) => "command",
                ("ctrl" | "ctl" | "control", true) => "control",
                ("ctrl" | "ctl" | "control" | "cmd" | "command", false) => "command",
                ("super" | "win" | "meta", false) => "control",
                ("opt" | "option" | "alt", _) => "option",
                ("shift", _) => "shift",
                ("fn" | "function", true) => "function",
                _ => return None,
            };
            modifiers.set(role);
        }
        Some(Shortcut::new(Key::from_word(name.trim())?, modifiers))
    }

    pub fn format(&self, platform: Platform) -> String {
        if platform.is_mac() {
            let mut out = String::new();
            for (on, glyph) in [
                (self.modifiers.control, '⌃'),
                (self.modifiers.option, '⌥'),
                (self.modifiers.shift, '⇧'),
                (self.modifiers.command, '⌘'),
                (self.modifiers.function, '🌐'),
            ] {
                if on {
                    out.push(glyph);
                }
            }
            out.push_str(&self.key.mac_name());
            return out;
        }
        let mut out = String::new();
        let windows = platform == Platform::Windows;
        for (on, name) in [
            (self.modifiers.command, "Ctrl"),
            (
                self.modifiers.control,
                if windows { "Win" } else { "Super" },
            ),
            (self.modifiers.option, "Alt"),
            (self.modifiers.shift, "Shift"),
        ] {
            if on {
                let _ = write!(out, "{name}+");
            }
        }
        out.push_str(&self.key.desktop_name());
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShortcutSource {
    pub id: String,
    pub keys: Vec<Shortcut>,
    pub fixed: bool,
}

fn parsed(keys: &[&str]) -> Vec<Shortcut> {
    keys.iter()
        .filter_map(|k| Shortcut::parse_glyphs(k))
        .collect()
}

fn platform_keys(id: &str, mac: &'static [&'static str], platform: Platform) -> Vec<Shortcut> {
    if !platform.is_mac()
        && let Some((_, keys)) = DESKTOP_KEYS.iter().find(|(desktop, _)| *desktop == id)
    {
        return parsed(keys);
    }
    parsed(mac)
}

pub const PROFILE_SHORTCUTS: usize = 9;

pub fn default_sources(platform: Platform, profiles: &[ProfileId]) -> Vec<ShortcutSource> {
    let mut sources = Vec::with_capacity(COMMANDS.len() + profiles.len() * 2);
    for spec in COMMANDS {
        let id = spec.command.id();
        sources.push(ShortcutSource {
            id: id.to_owned(),
            keys: platform_keys(id, spec.keys, platform),
            fixed: false,
        });
        for variant in spec.variants {
            let id = format!("{}:{}", spec.command.id(), variant.arg);
            let keys = platform_keys(&id, variant.keys, platform);
            sources.push(ShortcutSource {
                id,
                keys,
                fixed: false,
            });
        }
    }
    for (i, profile) in profiles.iter().enumerate() {
        let keys = if i < PROFILE_SHORTCUTS {
            let digit = char::from_digit((i + 1) as u32, 10).unwrap_or('1');
            let modifiers = if platform.is_mac() {
                Modifiers {
                    control: true,
                    ..Modifiers::NONE
                }
            } else {
                Modifiers {
                    option: true,
                    ..Modifiers::NONE
                }
            };
            vec![Shortcut::new(Key::Char(digit), modifiers)]
        } else {
            Vec::new()
        };
        sources.push(ShortcutSource {
            id: format!("{}:{profile}", Command::SwitchProfile.id()),
            keys,
            fixed: false,
        });
        sources.push(ShortcutSource {
            id: format!("{}:{profile}", Command::NewLittleArdia.id()),
            keys: Vec::new(),
            fixed: false,
        });
    }
    sources
}

#[derive(Clone, Debug, Default)]
pub struct ShortcutMap {
    bindings: IndexMap<String, Vec<Shortcut>>,
    defaults: HashMap<String, Vec<Shortcut>>,
    holders: HashMap<Shortcut, Vec<String>>,
}

impl ShortcutMap {
    pub fn resolve(sources: &[ShortcutSource], overrides: &IndexMap<String, Vec<String>>) -> Self {
        let rebindable = |id: &str| sources.iter().any(|s| s.id == id && !s.fixed);
        let taken: Vec<Shortcut> = overrides
            .iter()
            .filter(|(id, stored)| rebindable(id) && stored.first().is_some_and(|k| !k.is_empty()))
            .filter_map(|(_, stored)| Shortcut::from_stored(stored))
            .collect();
        let mut map = ShortcutMap::default();
        for source in sources {
            let keys: Vec<Shortcut> = match overrides.get(&source.id).filter(|_| !source.fixed) {
                Some(stored) => Shortcut::from_stored(stored).into_iter().collect(),
                None => source
                    .keys
                    .iter()
                    .filter(|k| source.fixed || !taken.contains(k))
                    .copied()
                    .collect(),
            };
            let mut unique: Vec<Shortcut> = Vec::with_capacity(keys.len());
            for key in keys {
                if !unique.contains(&key) {
                    unique.push(key);
                }
            }
            for key in &unique {
                map.holders.entry(*key).or_default().push(source.id.clone());
            }
            map.defaults.insert(source.id.clone(), source.keys.clone());
            map.bindings.insert(source.id.clone(), unique);
        }
        map
    }

    pub fn bindings(&self, id: &str) -> &[Shortcut] {
        self.bindings.get(id).map_or(&[], Vec::as_slice)
    }

    pub fn primary(&self, id: &str) -> Option<&Shortcut> {
        self.bindings(id).first()
    }

    pub fn defaults(&self, id: &str) -> &[Shortcut] {
        self.defaults.get(id).map_or(&[], Vec::as_slice)
    }

    pub fn holders(&self, shortcut: &Shortcut) -> &[String] {
        self.holders.get(shortcut).map_or(&[], Vec::as_slice)
    }

    pub fn command_for(&self, shortcut: &Shortcut) -> Option<&str> {
        self.holders(shortcut).first().map(String::as_str)
    }

    pub fn conflicts(&self, id: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for key in self.bindings(id) {
            for holder in self.holders(key) {
                if holder != id && !out.contains(holder) {
                    out.push(holder.clone());
                }
            }
        }
        out
    }

    pub fn hint(&self, id: &str, platform: Platform) -> Option<String> {
        self.primary(id).map(|s| s.format(platform))
    }
}

pub fn set_override(
    overrides: &mut IndexMap<String, Vec<String>>,
    id: &str,
    shortcut: Option<&Shortcut>,
) {
    overrides.insert(
        id.to_owned(),
        shortcut.map_or_else(|| vec![String::new()], Shortcut::to_stored),
    );
}

pub fn reset_override(overrides: &mut IndexMap<String, Vec<String>>, id: &str) {
    overrides.shift_remove(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glyph(text: &str) -> Shortcut {
        Shortcut::parse_glyphs(text).unwrap()
    }

    #[test]
    fn glyph_notation_round_trips_through_storage() {
        let reopen = glyph("⇧⌘T");
        assert_eq!(
            reopen,
            Shortcut::new(
                Key::Char('t'),
                Modifiers {
                    shift: true,
                    command: true,
                    ..Modifiers::NONE
                }
            )
        );
        assert_eq!(reopen.to_stored(), vec!["t", "shift", "command"]);
        assert_eq!(Shortcut::from_stored(&reopen.to_stored()), Some(reopen));
        assert_eq!(glyph("⌃⌥←").key, Key::Left);
        assert_eq!(glyph("F12").key, Key::Function(12));
        assert_eq!(glyph("⌘↩").key, Key::Enter);
        assert_eq!(
            Shortcut::from_stored(&["T".into(), "command".into()]),
            Some(glyph("⇧⌘T"))
        );
        assert_eq!(
            Shortcut::from_stored(&["\u{1c}".into(), "function".into(), "command".into()])
                .unwrap()
                .key,
            Key::Left
        );
        assert_eq!(
            Shortcut::from_stored(&["\u{F702}".into(), "control".into()])
                .unwrap()
                .key,
            Key::Left
        );
        assert_eq!(Shortcut::from_stored(&[]), None);
        assert_eq!(Shortcut::from_stored(&["".into()]), None);
    }

    #[test]
    fn formatting_follows_the_platform() {
        let s = glyph("⇧⌘T");
        assert_eq!(s.format(Platform::Mac), "⇧⌘T");
        assert_eq!(s.format(Platform::Windows), "Ctrl+Shift+T");
        assert_eq!(glyph("⌃⇧=").format(Platform::Linux), "Super+Shift+=");
        assert_eq!(glyph("⌘+").format(Platform::Windows), "Ctrl+Plus");
        assert_eq!(glyph("⌥⌘↓").format(Platform::Mac), "⌥⌘↓");
    }

    #[test]
    fn combo_words_map_primary_keys_per_platform() {
        assert_eq!(
            Shortcut::parse_combo("cmd+shift+n", Platform::Mac),
            Some(glyph("⇧⌘N"))
        );
        assert_eq!(
            Shortcut::parse_combo("ctrl+shift+n", Platform::Windows),
            Some(glyph("⇧⌘N"))
        );
        assert_eq!(
            Shortcut::parse_combo("ctrl+n", Platform::Mac),
            Some(glyph("⌃N"))
        );
        assert_eq!(
            Shortcut::parse_combo("ctrl++", Platform::Linux),
            Some(glyph("⌘+"))
        );
        assert_eq!(
            Shortcut::parse_combo("alt+left", Platform::Linux),
            Some(glyph("⌥←"))
        );
        assert_eq!(Shortcut::parse_combo("hyper+x", Platform::Mac), None);
        assert_eq!(Shortcut::parse_combo("", Platform::Mac), None);
    }

    #[test]
    fn overrides_take_keys_from_defaults_and_report_conflicts() {
        let profiles = vec![ProfileId::new("default"), ProfileId::new("p-2")];
        let sources = default_sources(Platform::Mac, &profiles);
        let defaults = ShortcutMap::resolve(&sources, &IndexMap::new());
        assert_eq!(defaults.command_for(&glyph("⌘T")), Some("newTab"));
        assert_eq!(
            defaults.command_for(&glyph("⌃2")),
            Some("switchProfile:p-2")
        );
        assert_eq!(
            defaults.hint("reopenClosedTab", Platform::Mac).as_deref(),
            Some("⇧⌘T")
        );
        let mut overrides = IndexMap::new();
        set_override(&mut overrides, "newWindow", Some(&glyph("⌘T")));
        let map = ShortcutMap::resolve(&sources, &overrides);
        assert_eq!(map.command_for(&glyph("⌘T")), Some("newWindow"));
        assert!(map.bindings("newTab").is_empty());
        assert!(map.conflicts("newWindow").is_empty());
        set_override(&mut overrides, "closeTab", Some(&glyph("⌘T")));
        let clash = ShortcutMap::resolve(&sources, &overrides);
        assert_eq!(clash.conflicts("closeTab"), vec!["newWindow"]);
        set_override(&mut overrides, "reopenClosedTab", None);
        let cleared = ShortcutMap::resolve(&sources, &overrides);
        assert!(cleared.bindings("reopenClosedTab").is_empty());
        assert_eq!(cleared.defaults("reopenClosedTab"), &[glyph("⇧⌘T")]);
        reset_override(&mut overrides, "reopenClosedTab");
        assert_eq!(
            ShortcutMap::resolve(&sources, &overrides).primary("reopenClosedTab"),
            Some(&glyph("⇧⌘T"))
        );
    }

    #[test]
    fn desktop_defaults_use_ctrl_and_function_keys() {
        let sources = default_sources(Platform::Linux, &[ProfileId::new("default")]);
        let map = ShortcutMap::resolve(&sources, &IndexMap::new());
        assert_eq!(
            map.hint("newTab", Platform::Linux).as_deref(),
            Some("Ctrl+T")
        );
        assert_eq!(
            map.command_for(&Shortcut::new(Key::Function(5), Modifiers::NONE)),
            Some("reload")
        );
        assert_eq!(
            map.command_for(&Shortcut::new(Key::Function(11), Modifiers::NONE)),
            Some("std:toggleFullScreen:")
        );
        assert_eq!(
            map.hint("switchProfile:default", Platform::Linux)
                .as_deref(),
            Some("Alt+1")
        );
        assert!(map.bindings("std:hide:").is_empty());
    }

    #[test]
    fn every_default_glyph_parses() {
        for spec in COMMANDS {
            for key in spec
                .keys
                .iter()
                .chain(spec.variants.iter().flat_map(|v| v.keys.iter()))
            {
                assert!(Shortcut::parse_glyphs(key).is_some(), "{key}");
            }
        }
        for (_, keys) in DESKTOP_KEYS {
            for key in *keys {
                assert!(Shortcut::parse_glyphs(key).is_some(), "{key}");
            }
        }
    }
}
