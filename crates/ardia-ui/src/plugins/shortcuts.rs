use std::collections::HashSet;

use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PluginShortcut {
    pub key: String,
    pub control: bool,
    pub option: bool,
    pub shift: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Modifier {
    Command,
    Control,
    Option,
    Shift,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyPress {
    pub key: String,
    pub command: bool,
    pub control: bool,
    pub option: bool,
    pub shift: bool,
}

const PUNCTUATION: &str = "-=[]\\;',./`";
const LIFECYCLE_KEYS: [&str; 6] = ["q", "w", "t", "n", "h", "m"];
const RESERVED: [&str; 16] = [
    "cmd+a",
    "cmd+c",
    "cmd+v",
    "cmd+x",
    "cmd+z",
    "cmd+shift+z",
    "cmd+shift+v",
    "cmd+opt+shift+v",
    "cmd+,",
    "cmd+`",
    "cmd+shift+`",
    "cmd+space",
    "cmd+ctrl+space",
    "cmd+opt+space",
    "cmd+ctrl+f",
    "cmd+ctrl+q",
];
const MAX_TEXT: usize = 40;

fn modifier_word(word: &str) -> Option<Modifier> {
    match word.to_lowercase().as_str() {
        "cmd" | "command" => Some(Modifier::Command),
        "ctrl" | "control" => Some(Modifier::Control),
        "opt" | "option" | "alt" => Some(Modifier::Option),
        "shift" => Some(Modifier::Shift),
        _ => None,
    }
}

fn modifier_glyph(glyph: char) -> Option<Modifier> {
    match glyph {
        '⌘' => Some(Modifier::Command),
        '⌃' => Some(Modifier::Control),
        '⌥' => Some(Modifier::Option),
        '⇧' => Some(Modifier::Shift),
        _ => None,
    }
}

fn is_function_key(lower: &str) -> bool {
    lower
        .strip_prefix('f')
        .and_then(|n| n.parse::<u8>().ok().filter(|_| !n.starts_with('0')))
        .is_some_and(|n| (1..=12).contains(&n))
}

fn key_of(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    if lower == "space" || is_function_key(&lower) {
        return Some(lower);
    }
    let mut chars = lower.chars();
    let only = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    (only.is_ascii_lowercase() || only.is_ascii_digit() || PUNCTUATION.contains(only))
        .then_some(lower)
}

fn parts_of(text: &str) -> Option<(Vec<Modifier>, String)> {
    if text.contains('+') {
        let mut words: Vec<&str> = text.split('+').map(str::trim).collect();
        let name = words.pop().unwrap_or_default();
        if name.is_empty() && text.ends_with('+') {
            return None;
        }
        let modifiers: Option<Vec<Modifier>> = words.into_iter().map(modifier_word).collect();
        return modifiers.map(|modifiers| (modifiers, name.to_owned()));
    }
    let chars: Vec<char> = text.chars().collect();
    let mut at = 0;
    let mut modifiers = Vec::new();
    while at + 1 < chars.len() {
        let Some(modifier) = modifier_glyph(chars[at]) else {
            break;
        };
        modifiers.push(modifier);
        at += 1;
    }
    Some((modifiers, chars[at..].iter().collect()))
}

pub fn parse_plugin_shortcut(raw: &Value) -> Option<(PluginShortcut, bool)> {
    let text = raw.as_str()?.trim();
    if text.is_empty() || text.len() > MAX_TEXT {
        return None;
    }
    let (modifiers, name) = parts_of(text)?;
    let unique: HashSet<_> = modifiers.iter().map(|m| *m as u8).collect();
    if unique.len() != modifiers.len() {
        return None;
    }
    let key = key_of(&name)?;
    let has = |m: Modifier| modifiers.contains(&m);
    Some((
        PluginShortcut {
            key,
            control: has(Modifier::Control),
            option: has(Modifier::Option),
            shift: has(Modifier::Shift),
        },
        has(Modifier::Command),
    ))
}

pub fn shortcut_text(s: &PluginShortcut) -> String {
    let mut parts = vec!["cmd"];
    if s.control {
        parts.push("ctrl");
    }
    if s.option {
        parts.push("opt");
    }
    if s.shift {
        parts.push("shift");
    }
    parts.push(&s.key);
    parts.join("+")
}

fn is_refused(s: &PluginShortcut, command: bool) -> bool {
    if !command {
        return true;
    }
    let single = s.key.chars().count() == 1;
    if s.shift && single && !s.key.chars().all(|c| c.is_ascii_lowercase()) {
        return true;
    }
    LIFECYCLE_KEYS.contains(&s.key.as_str()) || RESERVED.contains(&shortcut_text(s).as_str())
}

pub fn plugin_shortcut_of(raw: &Value) -> Option<PluginShortcut> {
    let (shortcut, command) = parse_plugin_shortcut(raw)?;
    (!is_refused(&shortcut, command)).then_some(shortcut)
}

fn event_keys_of(s: &PluginShortcut) -> Vec<String> {
    if s.key == "space" {
        return vec![" ".into()];
    }
    if is_function_key(&s.key) {
        return vec![s.key.to_uppercase()];
    }
    if s.key.len() == 1 && s.key.chars().all(|c| c.is_ascii_lowercase()) {
        return vec![s.key.clone(), s.key.to_uppercase()];
    }
    vec![s.key.clone()]
}

fn normalized(key: &str) -> String {
    if key.chars().count() == 1 {
        key.to_lowercase()
    } else {
        key.to_owned()
    }
}

pub fn shortcut_matches(s: &PluginShortcut, press: &KeyPress) -> bool {
    if press.key.is_empty() {
        return false;
    }
    if !press.command
        || press.control != s.control
        || press.option != s.option
        || press.shift != s.shift
    {
        return false;
    }
    let pressed = normalized(&press.key);
    event_keys_of(s).iter().any(|k| normalized(k) == pressed)
}

pub fn gpui_key_press(keystroke: &gpui::Keystroke) -> KeyPress {
    let key = match keystroke.key.as_str() {
        "space" => " ".to_owned(),
        key if is_function_key(key) => key.to_uppercase(),
        key => key.to_owned(),
    };
    KeyPress {
        key,
        command: keystroke.modifiers.platform,
        control: keystroke.modifiers.control,
        option: keystroke.modifiers.alt,
        shift: keystroke.modifiers.shift,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Binding<A> {
    pub shortcut: PluginShortcut,
    pub action: A,
}

pub fn bindings_of<'a, A: Clone + 'a>(
    actions: impl IntoIterator<Item = (&'a Value, A)>,
) -> Vec<Binding<A>> {
    actions
        .into_iter()
        .filter_map(|(raw, action)| {
            plugin_shortcut_of(raw).map(|shortcut| Binding { shortcut, action })
        })
        .collect()
}

pub fn merge_bindings<A: Clone>(
    registrations: &[(usize, usize, Vec<Binding<A>>)],
    held_elsewhere: impl Fn(&PluginShortcut) -> bool,
) -> Vec<Binding<A>> {
    let mut ordered: Vec<&(usize, usize, Vec<Binding<A>>)> = registrations.iter().collect();
    ordered.sort_by_key(|(depth, seq, _)| (*depth, *seq));
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (_, _, bindings) in ordered {
        for binding in bindings {
            if !seen.insert(shortcut_text(&binding.shortcut)) {
                continue;
            }
            if !held_elsewhere(&binding.shortcut) {
                out.push(binding.clone());
            }
        }
    }
    out
}

pub fn pressed_binding<'a, A>(
    bindings: &'a [Binding<A>],
    press: &KeyPress,
) -> Option<&'a Binding<A>> {
    bindings
        .iter()
        .find(|b| shortcut_matches(&b.shortcut, press))
}

pub fn shortcut_hint(s: &PluginShortcut) -> String {
    let mut out = String::new();
    if s.control {
        out.push('⌃');
    }
    if s.option {
        out.push('⌥');
    }
    if s.shift {
        out.push('⇧');
    }
    out.push('⌘');
    if s.key == "space" {
        out.push_str("Space");
    } else {
        out.push_str(&s.key.to_uppercase());
    }
    out
}

const BADGE_CHARS: usize = 4;
const UNITS: [&str; 4] = ["", "k", "m", "b"];

pub fn toolbar_badge_text_number(value: i64) -> String {
    let text = if value.abs() > 999 {
        format!("{}999+", if value < 0 { "-" } else { "" })
    } else {
        value.to_string()
    };
    text.chars().take(BADGE_CHARS).collect()
}

pub fn toolbar_badge_text(value: &str) -> String {
    if value.chars().count() <= BADGE_CHARS {
        return value.to_owned();
    }
    rounded_count(value).unwrap_or_else(|| value.chars().take(BADGE_CHARS).collect())
}

fn rounded_to(value: f64, decimals: i32) -> String {
    let factor = 10f64.powi(decimals);
    let rounded = (value * factor).round() / factor;
    let text = format!("{rounded:.*}", decimals as usize);
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        text
    }
}

fn rounded_count(text: &str) -> Option<String> {
    let (sign, rest) = match text.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", text),
    };
    let suffix_at = rest
        .char_indices()
        .last()
        .filter(|(_, c)| matches!(c.to_ascii_lowercase(), 'k' | 'm' | 'b'))
        .map(|(at, _)| at);
    let (digits, suffix) = match suffix_at {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    let well_formed = !digits.is_empty()
        && !digits.starts_with('.')
        && !digits.ends_with('.')
        && digits.chars().all(|c| c.is_ascii_digit() || c == '.')
        && digits.matches('.').count() <= 1;
    if !well_formed {
        return None;
    }
    let upper = suffix != suffix.to_lowercase();
    let mut amount: f64 = digits.parse().ok()?;
    let start = UNITS.iter().position(|u| *u == suffix.to_lowercase())?;
    for unit in &UNITS[start..] {
        let name = if upper {
            unit.to_uppercase()
        } else {
            (*unit).to_owned()
        };
        for decimals in [1, 0] {
            let shown = format!("{sign}{}{name}", rounded_to(amount, decimals));
            if shown.chars().count() <= BADGE_CHARS {
                return Some(shown);
            }
        }
        amount /= 1000.0;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn press(key: &str, shift: bool) -> KeyPress {
        KeyPress {
            key: key.into(),
            command: true,
            shift,
            ..KeyPress::default()
        }
    }

    #[test]
    fn parses_words_and_glyphs_and_refuses_reserved_combos() {
        let s = plugin_shortcut_of(&json!("cmd+shift+k")).unwrap();
        assert_eq!(shortcut_text(&s), "cmd+shift+k");
        assert_eq!(plugin_shortcut_of(&json!("⌘⇧K")), Some(s));
        assert!(plugin_shortcut_of(&json!("k")).is_none());
        assert!(plugin_shortcut_of(&json!("cmd+c")).is_none());
        assert!(plugin_shortcut_of(&json!("cmd+w")).is_none());
        assert!(plugin_shortcut_of(&json!("cmd+shift+1")).is_none());
        assert!(plugin_shortcut_of(&json!("cmd+cmd+k")).is_none());
        assert!(plugin_shortcut_of(&json!("cmd+")).is_none());
        assert_eq!(
            shortcut_text(&plugin_shortcut_of(&json!("Command+Option+F5")).unwrap()),
            "cmd+opt+f5"
        );
        assert!(plugin_shortcut_of(&json!(5)).is_none());
    }

    #[test]
    fn matches_presses_case_blind_and_merges_shallowest_first() {
        let s = plugin_shortcut_of(&json!("cmd+shift+k")).unwrap();
        assert!(shortcut_matches(&s, &press("K", true)));
        assert!(!shortcut_matches(&s, &press("k", false)));
        let outer = vec![Binding {
            shortcut: s.clone(),
            action: "outer",
        }];
        let inner = vec![Binding {
            shortcut: s.clone(),
            action: "inner",
        }];
        let merged = merge_bindings(&[(1, 0, inner), (0, 1, outer)], |_| false);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].action, "outer");
        assert!(merge_bindings(&[(0, 0, merged.clone())], |_| true).is_empty());
        assert_eq!(
            pressed_binding(&merged, &press("k", true)).map(|b| b.action),
            Some("outer")
        );
        assert_eq!(shortcut_hint(&s), "⇧⌘K");
    }

    #[test]
    fn badge_text_rounds_long_counts() {
        assert_eq!(toolbar_badge_text_number(12), "12");
        assert_eq!(toolbar_badge_text_number(1500), "999+");
        assert_eq!(toolbar_badge_text_number(-1500), "-999");
        assert_eq!(toolbar_badge_text("new"), "new");
        assert_eq!(toolbar_badge_text("12345"), "12k");
        assert_eq!(toolbar_badge_text("1250"), "1250");
        assert_eq!(toolbar_badge_text("1500K"), "1.5M");
        assert_eq!(toolbar_badge_text("hello"), "hell");
    }
}
