use serde_json::{Map, Value, json};

pub const SETUP_CODE_VERSION: u32 = 1;
pub const SETUP_CODE_PREFIX: &str = "ardia1-";
pub const SETUP_CODE_MAX_LENGTH: usize = 160;
pub const SETUP_CODE_MAX_INPUT: usize = SETUP_CODE_MAX_LENGTH * 8;
const MAX_ENUM_DIGITS: usize = 2;
const MAX_MASK_DIGITS: usize = 9;
const CHECK_DIGITS: usize = 2;
const CHECK_SPACE: u32 = 36 * 36;

pub const ERROR_EMPTY: &str = "Paste a setup code first.";
pub const ERROR_SHAPE: &str = "That doesn't look like a setup code. It starts with ardia1-";
pub const ERROR_NEWER: &str = "That code is from a newer Ardia. Update Ardia, then paste it again.";
pub const ERROR_DAMAGED: &str =
    "That code looks cut off or mistyped. Copy it again from ardia.dev.";
pub const ERROR_NOTHING: &str = "That code has nothing this version of Ardia can apply.";

pub const PIN_SITES: [&str; 12] = [
    "gmail", "calendar", "slack", "notion", "figma", "github", "linear", "docs", "drive",
    "outlook", "youtube", "spotify",
];

pub const PRESETS: [&str; 13] = [
    "arc", "dia", "chrome", "safari", "firefox", "zen", "brave", "edge", "fresh", "helium",
    "chromium", "vivaldi", "opera",
];

pub const COLORS: [&str; 9] = [
    "plum", "blue", "purple", "pink", "red", "orange", "yellow", "green", "neutral",
];

fn values(key: &str) -> Vec<Value> {
    let strings = |list: &[&str]| list.iter().map(|v| json!(v)).collect();
    let bools = || vec![json!(false), json!(true)];
    match key {
        "tabLayout" => strings(&["sidebar", "top"]),
        "sidebarSide" => strings(&["left", "right"]),
        "addressBar" => strings(&["toolbar", "sidebar"]),
        "commandBarPlacement" => strings(&["field", "centred", "centredOnClick"]),
        "newTabOpens" => strings(&["page", "commandBar"]),
        "newTabPosition" => strings(&["top", "bottom", "nextToCurrent"]),
        "newTabButtonPosition" => strings(&["top", "bottom"]),
        "cleanUpInactiveTabsAfterMinutes" => {
            vec![Value::Null, json!(720), json!(1440), json!(10080)]
        }
        "peekModifier" => strings(&["alt", "shift", "off"]),
        "appearance" => strings(&["auto", "light", "dark"]),
        "bookmarksBar" => strings(&["always", "newTab", "never"]),
        _ => bools(),
    }
}

pub const SETTING_FIELDS: [(&str, char); 18] = [
    ("tabLayout", 't'),
    ("sidebarSide", 'd'),
    ("addressBar", 'a'),
    ("commandBarPlacement", 'c'),
    ("newTabOpens", 'n'),
    ("newTabPosition", 'o'),
    ("newTabButtonPosition", 'b'),
    ("cleanUpInactiveTabsAfterMinutes", 'i'),
    ("restoreSession", 'r'),
    ("shareTabsAcrossWindows", 'w'),
    ("balancedTopApps", 'g'),
    ("peekModifier", 'k'),
    ("undoReopensClosedTab", 'u'),
    ("cmdClickCreatesTabGroup", 'm'),
    ("appearance", 'e'),
    ("extendWebsiteColor", 's'),
    ("hideToolbarWhileScrolling", 'h'),
    ("bookmarksBar", 'v'),
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SetupChoices {
    pub preset: Option<String>,
    pub settings: Map<String, Value>,
    pub color: Option<String>,
    pub pins: Option<Vec<String>>,
}

pub fn checksum(body: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in body.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    let mut n = hash % CHECK_SPACE;
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    while out.len() < CHECK_DIGITS {
        out.push(b'0');
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn same(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => (x - y).abs() < f64::EPSILON,
        _ => a == b,
    }
}

pub fn encode(choices: &SetupChoices) -> String {
    let mut body = String::new();
    if let Some(i) = choices
        .preset
        .as_deref()
        .and_then(|p| PRESETS.iter().position(|v| *v == p))
    {
        body.push_str(&format!("p{i}"));
    }
    for (key, letter) in SETTING_FIELDS {
        if let Some(value) = choices.settings.get(key)
            && let Some(i) = values(key).iter().position(|v| same(v, value))
        {
            body.push_str(&format!("{letter}{i}"));
        }
    }
    if let Some(i) = choices
        .color
        .as_deref()
        .and_then(|c| COLORS.iter().position(|v| *v == c))
    {
        body.push_str(&format!("x{i}"));
    }
    if let Some(pins) = &choices.pins {
        let mask: u32 = PIN_SITES
            .iter()
            .enumerate()
            .filter(|(_, id)| pins.iter().any(|p| p == *id))
            .map(|(bit, _)| 1 << bit)
            .sum();
        body.push_str(&format!("f{mask}"));
    }
    format!("{SETUP_CODE_PREFIX}{body}-{}", checksum(&body))
}

fn entries(body: &str) -> Option<Vec<(char, String)>> {
    let mut out: Vec<(char, String)> = Vec::new();
    let mut chars = body.chars().peekable();
    while let Some(key) = chars.next() {
        if !key.is_ascii_lowercase() {
            return None;
        }
        let mut digits = String::new();
        while let Some(d) = chars.peek().copied().filter(char::is_ascii_digit) {
            digits.push(d);
            chars.next();
        }
        if digits.is_empty() || digits.len() > 9 || out.iter().any(|(k, _)| *k == key) {
            return None;
        }
        out.push((key, digits));
    }
    Some(out)
}

pub fn decode(input: &str) -> Result<SetupChoices, &'static str> {
    if input.len() > SETUP_CODE_MAX_INPUT {
        return Err(ERROR_SHAPE);
    }
    let code: String = input
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    if code.is_empty() {
        return Err(ERROR_EMPTY);
    }
    if code.len() > SETUP_CODE_MAX_LENGTH {
        return Err(ERROR_SHAPE);
    }
    let Some(after) = code.strip_prefix("ardia") else {
        return Err(ERROR_SHAPE);
    };
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 3 || !after[digits.len()..].starts_with('-') {
        return Err(ERROR_SHAPE);
    }
    if digits.parse::<u32>().unwrap_or(0) > SETUP_CODE_VERSION {
        return Err(ERROR_NEWER);
    }
    let Some(rest) = code.strip_prefix(SETUP_CODE_PREFIX) else {
        return Err(ERROR_SHAPE);
    };
    let Some(dash) = rest.rfind('-') else {
        return Err(ERROR_DAMAGED);
    };
    if rest.len() - dash - 1 != CHECK_DIGITS {
        return Err(ERROR_DAMAGED);
    }
    let body = &rest[..dash];
    if checksum(body) != rest[dash + 1..] {
        return Err(ERROR_DAMAGED);
    }
    let found = entries(body).ok_or(ERROR_DAMAGED)?;
    let number = |key: char, max: usize| -> Option<usize> {
        let digits = &found.iter().find(|(k, _)| *k == key)?.1;
        let n: usize = digits.parse().ok()?;
        (digits.len() <= max && n.to_string() == *digits).then_some(n)
    };
    let mut choices = SetupChoices::default();
    for (key, letter) in SETTING_FIELDS {
        if let Some(value) =
            number(letter, MAX_ENUM_DIGITS).and_then(|i| values(key).get(i).cloned())
        {
            choices.settings.insert(key.to_owned(), value);
        }
    }
    choices.preset = number('p', MAX_ENUM_DIGITS)
        .and_then(|i| PRESETS.get(i))
        .map(|s| (*s).to_owned());
    choices.color = number('x', MAX_ENUM_DIGITS)
        .and_then(|i| COLORS.get(i))
        .map(|s| (*s).to_owned());
    choices.pins = number('f', MAX_MASK_DIGITS).map(|mask| {
        PIN_SITES
            .iter()
            .enumerate()
            .filter(|(bit, _)| mask & (1 << bit) != 0)
            .map(|(_, id)| (*id).to_owned())
            .collect()
    });
    if choices.settings.is_empty()
        && choices.preset.is_none()
        && choices.color.is_none()
        && choices.pins.is_none()
    {
        return Err(ERROR_NOTHING);
    }
    Ok(choices)
}

pub fn describe(choices: &SetupChoices) -> Vec<String> {
    let s = &choices.settings;
    let text = |key: &str| s.get(key).and_then(Value::as_str);
    let mut lines = Vec::new();
    let top = text("tabLayout") == Some("top");
    if let Some(layout) = text("tabLayout") {
        lines.push(
            if layout == "top" {
                "Tabs along the top"
            } else {
                "Tabs in the sidebar"
            }
            .to_owned(),
        );
    }
    if text("sidebarSide") == Some("right") && !top {
        lines.push("Sidebar on the right".to_owned());
    }
    if let Some(address) = text("addressBar")
        && !top
    {
        lines.push(
            if address == "sidebar" {
                "Address in the sidebar"
            } else {
                "Address in the toolbar"
            }
            .to_owned(),
        );
    }
    if let Some(opens) = text("newTabOpens") {
        lines.push(
            if opens == "commandBar" {
                "⌘T opens the command bar"
            } else {
                "⌘T opens the New Tab page"
            }
            .to_owned(),
        );
    }
    if let Some(appearance) = text("appearance") {
        lines.push(
            match appearance {
                "light" => "Always light",
                "dark" => "Always dark",
                _ => "Appearance follows your Mac",
            }
            .to_owned(),
        );
    }
    if let Some(color) = &choices.color {
        let mut name = color.clone();
        if let Some(first) = name.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        lines.push(format!("{name} theme"));
    }
    if let Some(pins) = choices.pins.as_ref().filter(|p| !p.is_empty()) {
        lines.push(format!(
            "{} {} pinned",
            pins.len(),
            if pins.len() == 1 { "app" } else { "apps" }
        ));
    }
    lines
}

pub const BRINGS: [&str; 4] = [
    "Where your tabs and address bar go",
    "What ⌘T and ⌘L open",
    "Light or dark, and your color",
    "The apps you pinned",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_round_trip_and_match_the_old_checksum() {
        let mut settings = Map::new();
        settings.insert("tabLayout".into(), json!("top"));
        settings.insert("appearance".into(), json!("dark"));
        settings.insert("cleanUpInactiveTabsAfterMinutes".into(), json!(1440));
        let choices = SetupChoices {
            preset: Some("arc".into()),
            settings,
            color: Some("blue".into()),
            pins: Some(vec!["gmail".into(), "github".into()]),
        };
        let code = encode(&choices);
        assert_eq!(code, "ardia1-p0t1i2e2x1f33-qr");
        assert_eq!(decode(&code), Ok(choices.clone()));
        assert_eq!(decode(&code.to_uppercase()), Ok(choices));
        assert_eq!(checksum(""), "fp");
    }

    #[test]
    fn bad_codes_get_the_old_messages() {
        assert_eq!(decode("  "), Err(ERROR_EMPTY));
        assert_eq!(decode("hello"), Err(ERROR_SHAPE));
        assert_eq!(decode("ardia2-t1-00"), Err(ERROR_NEWER));
        assert_eq!(decode("ardia1-t1-zz"), Err(ERROR_DAMAGED));
        let empty = format!("ardia1--{}", checksum(""));
        assert_eq!(decode(&empty), Err(ERROR_NOTHING));
    }

    #[test]
    fn lines_describe_what_a_code_brings() {
        let choices = decode(&encode(&SetupChoices {
            settings: [
                ("tabLayout".to_owned(), json!("sidebar")),
                ("addressBar".to_owned(), json!("sidebar")),
            ]
            .into_iter()
            .collect(),
            color: Some("plum".into()),
            pins: Some(vec!["slack".into()]),
            ..SetupChoices::default()
        }))
        .expect("decodes");
        assert_eq!(
            describe(&choices),
            [
                "Tabs in the sidebar",
                "Address in the sidebar",
                "Plum theme",
                "1 app pinned"
            ]
        );
    }
}
