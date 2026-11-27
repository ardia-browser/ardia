use std::path::{Path, PathBuf};

use ardia_theme::profile_theme::{ThemeColor, pad_position};
use ardia_theme::{ProfileTheme, ThemeTexture};
use serde_json::{Map, Value, json};

pub const MAX_SIDEBAR_BYTES: u64 = 64 * 1024 * 1024;
const MAX_THEME_BYTES: usize = 64 * 1024;
const MAX_THEME_DEPTH: usize = 12;
const MAX_THEME_ARRAY: usize = 4;
const MAX_THEME_KEYS: usize = 32;
const MAX_THEME_STRING: usize = 256;
const MAX_THEME_NODES: i64 = 2_048;

#[derive(Clone, Debug, PartialEq)]
pub struct ArcThemeSpace {
    pub id: String,
    pub name: String,
    pub emoji: Option<String>,
    pub theme: ProfileTheme,
}

impl ArcThemeSpace {
    pub fn title(&self) -> String {
        match &self.emoji {
            Some(emoji) => format!("{emoji}  {}", self.name),
            None => self.name.clone(),
        }
    }
}

pub fn sidebar_path(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Arc/StorableSidebar.json")
}

pub fn read_spaces(home: &Path) -> Vec<ArcThemeSpace> {
    let path = sidebar_path(home);
    let fits = std::fs::metadata(&path)
        .is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_SIDEBAR_BYTES);
    if !fits {
        return Vec::new();
    }
    std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|sidebar| themed_spaces(&sidebar))
        .unwrap_or_default()
}

pub fn themed_spaces(top: &Value) -> Vec<ArcThemeSpace> {
    let Some(containers) = top
        .get("sidebar")
        .and_then(|sidebar| sidebar.get("containers"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let Some(main) = main_container(containers) else {
        return Vec::new();
    };
    let mut untitled = 0;
    let mut out = Vec::new();
    for space in objects(main.get("spaces")) {
        let Some(id) = space.get("id").and_then(Value::as_str) else {
            continue;
        };
        let name = match space.get("title").and_then(Value::as_str) {
            Some(title) if !title.is_empty() => title.to_owned(),
            _ => {
                untitled += 1;
                format!("Space {untitled}")
            }
        };
        let info = space.get("customInfo");
        let emoji = emoji(info.and_then(|info| info.get("iconType")));
        let theme = info
            .and_then(|info| info.get("windowTheme"))
            .and_then(bounded)
            .filter(|theme| {
                serde_json::to_vec(theme).is_ok_and(|bytes| bytes.len() <= MAX_THEME_BYTES)
            })
            .and_then(|theme| parse_arc_theme(&theme));
        if let Some(theme) = theme {
            out.push(ArcThemeSpace {
                id: id.to_owned(),
                name,
                emoji,
                theme,
            });
        }
    }
    out
}

fn objects(value: Option<&Value>) -> impl Iterator<Item = &Map<String, Value>> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
}

fn main_container(containers: &[Value]) -> Option<&Map<String, Value>> {
    let empty = Map::new();
    let boxes: Vec<&Map<String, Value>> = containers
        .iter()
        .map(|container| container.as_object().unwrap_or(&empty))
        .collect();
    let holds_sidebar =
        |i: usize| boxes[i].contains_key("spaces") || boxes[i].contains_key("items");
    let after = |i: usize, marker: &str| i > 0 && boxes[i - 1].contains_key(marker);
    let index = (0..boxes.len())
        .find(|&i| holds_sidebar(i) && after(i, "global"))
        .or_else(|| (0..boxes.len()).find(|&i| holds_sidebar(i) && !after(i, "littleBrowser")))?;
    containers.get(index).and_then(Value::as_object)
}

fn emoji(icon: Option<&Value>) -> Option<String> {
    let icon = icon?.as_object()?;
    for key in ["emoji_v2", "emoji"] {
        if let Some(text) = icon
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            return Some(text.to_owned());
        }
    }
    icon.get("emoji")
        .and_then(Value::as_u64)
        .and_then(|code| u32::try_from(code).ok())
        .and_then(char::from_u32)
        .map(String::from)
}

fn bounded(value: &Value) -> Option<Value> {
    let mut nodes = MAX_THEME_NODES;
    let mut bytes = MAX_THEME_BYTES as i64;
    let out = bounded_at(value, 0, &mut nodes, &mut bytes)?;
    (nodes >= 0 && bytes >= 0).then_some(out)
}

fn bounded_at(value: &Value, depth: usize, nodes: &mut i64, bytes: &mut i64) -> Option<Value> {
    if depth >= MAX_THEME_DEPTH || value.is_null() {
        return None;
    }
    *nodes -= 1;
    *bytes -= 8;
    if *nodes < 0 || *bytes < 0 {
        return None;
    }
    match value {
        Value::Object(fields) => {
            if fields.len() > MAX_THEME_KEYS {
                return None;
            }
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                if key.len() > MAX_THEME_STRING {
                    return None;
                }
                *bytes -= key.len() as i64;
                if *bytes < 0 {
                    return None;
                }
                if let Some(inner) = bounded_at(&fields[key], depth + 1, nodes, bytes) {
                    out.insert(key.clone(), inner);
                }
                if *nodes < 0 || *bytes < 0 {
                    return None;
                }
            }
            Some(Value::Object(out))
        }
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items.iter().take(MAX_THEME_ARRAY) {
                if let Some(inner) = bounded_at(item, depth + 1, nodes, bytes) {
                    out.push(inner);
                }
                if *nodes < 0 || *bytes < 0 {
                    return None;
                }
            }
            Some(Value::Array(out))
        }
        Value::String(text) => {
            let mut end = text.len().min(MAX_THEME_STRING);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            *bytes -= end as i64;
            (*bytes >= 0).then(|| Value::String(text[..end].to_owned()))
        }
        Value::Number(_) | Value::Bool(_) => Some(value.clone()),
        Value::Null => None,
    }
}

fn payload(value: Option<&Value>) -> Option<&Value> {
    value?.as_object()?.get("_0")
}

fn number(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite())
}

fn arc_color(value: &Value) -> Option<ThemeColor> {
    let fields = value.as_object()?;
    let r = number(fields.get("red"))?;
    let g = number(fields.get("green"))?;
    let b = number(fields.get("blue"))?;
    Some(ThemeColor::new(
        r,
        g,
        b,
        number(fields.get("alpha")).unwrap_or(1.0),
    ))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Appearance {
    Light,
    Dark,
}

fn appearance(value: Option<&Value>) -> Option<Appearance> {
    match value?.as_str()? {
        "light" => Some(Appearance::Light),
        "dark" => Some(Appearance::Dark),
        _ => None,
    }
}

fn mode_name(appearance: Appearance) -> &'static str {
    match appearance {
        Appearance::Light => "light",
        Appearance::Dark => "dark",
    }
}

fn window_mode(value: Option<&Value>) -> Option<&'static str> {
    let wrapper = value?.as_object()?;
    if let Some(single) = appearance(payload(wrapper.get("single"))) {
        return Some(mode_name(single));
    }
    let based = wrapper.get("appearanceBased")?.as_object()?;
    let light = appearance(based.get("light"))?;
    let dark = appearance(based.get("dark"))?;
    Some(if light == dark {
        mode_name(light)
    } else {
        "auto"
    })
}

struct ParsedLook {
    look: Map<String, Value>,
    style: Option<Appearance>,
}

fn stop(color: ThemeColor) -> Value {
    let (x, y) = pad_position(color);
    json!({
        "color": { "r": color.r, "g": color.g, "b": color.b, "a": color.a },
        "x": x,
        "y": y,
    })
}

fn colors_of(list: Option<&Value>) -> Vec<ThemeColor> {
    list.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(2)
        .filter_map(arc_color)
        .collect()
}

fn parse_look(background: Option<&Value>) -> Option<ParsedLook> {
    let style = background?.as_object()?.get("style")?.as_object()?;
    let kind = payload(style.get("color"))?.as_object()?;
    let gradient = payload(kind.get("blendedGradient")).and_then(Value::as_object);
    let single = payload(kind.get("blendedSingleColor")).and_then(Value::as_object);
    let basic = payload(kind.get("basicColor")).and_then(Value::as_object);
    let config = gradient.or(single).or(basic)?;
    let colors = if let Some(gradient) = gradient {
        let base = colors_of(gradient.get("baseColors"));
        let overlay = colors_of(gradient.get("overlayColors"));
        match (overlay.get(1), base.as_slice()) {
            (Some(third), [only]) => vec![*only, *only, *third],
            (Some(third), [first, second, ..]) => vec![*first, *second, *third],
            _ => base,
        }
    } else {
        config
            .get("color")
            .and_then(arc_color)
            .into_iter()
            .collect()
    };
    if colors.is_empty() {
        return None;
    }
    let modifiers = config.get("modifiers").and_then(Value::as_object);
    let modifier = |key: &str| number(modifiers.and_then(|m| m.get(key)));
    let texture = modifiers
        .and_then(|m| m.get("overlay"))
        .and_then(Value::as_str)
        .and_then(ThemeTexture::from_key)
        .unwrap_or_default();
    let is_basic = basic.is_some();
    let mut look = Map::new();
    look.insert(
        "stops".into(),
        Value::Array(colors.into_iter().map(stop).collect()),
    );
    look.insert(
        "intensity".into(),
        json!(modifier("intensityFactor").unwrap_or(1.0)),
    );
    look.insert(
        "grain".into(),
        json!(if is_basic {
            0.0
        } else {
            modifier("noiseFactor").unwrap_or(0.0)
        }),
    );
    look.insert("texture".into(), Value::from(texture.key()));
    look.insert(
        "translucency".into(),
        json!(if is_basic { 0.0 } else { 1.0 }),
    );
    Some(ParsedLook {
        look,
        style: appearance(config.get("translucencyStyle")),
    })
}

pub fn parse_arc_theme(theme: &Value) -> Option<ProfileTheme> {
    let theme = theme.as_object()?;
    let background = theme.get("background")?.as_object()?;
    let single = parse_look(payload(background.get("single")));
    let based = background.get("appearanceBased").and_then(Value::as_object);
    let single_found = single.is_some();
    let light = single.or_else(|| parse_look(based.and_then(|b| b.get("light"))));
    let dark = if single_found {
        None
    } else {
        parse_look(based.and_then(|b| b.get("dark")))
    };
    let both = light.is_some() && dark.is_some();
    let main = light.as_ref().or(dark.as_ref())?;
    let mode = window_mode(theme.get("windowAppearance")).unwrap_or(if both {
        "auto"
    } else {
        main.style.map_or("auto", mode_name)
    });
    let base = match (&dark, mode) {
        (Some(dark), "dark") => dark,
        _ => main,
    };
    let mut out = base.look.clone();
    out.insert("mode".into(), Value::from(mode));
    if both
        && mode == "auto"
        && let Some(dark) = &dark
    {
        out.insert("dark".into(), Value::Object(dark.look.clone()));
    }
    ProfileTheme::sanitize(&Value::Object(out))
}

pub fn accent_rgb(theme: &ProfileTheme) -> u32 {
    let accent = theme.accent();
    let channel = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u32;
    (channel(accent.r) << 16) | (channel(accent.g) << 8) | channel(accent.b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn color(r: f64, g: f64, b: f64) -> Value {
        json!({ "red": r, "green": g, "blue": b, "alpha": 1.0 })
    }

    fn gradient_theme() -> Value {
        json!({
            "background": {
                "single": {
                    "_0": {
                        "style": {
                            "color": {
                                "_0": {
                                    "blendedGradient": {
                                        "_0": {
                                            "baseColors": [color(0.9, 0.2, 0.3), color(0.2, 0.3, 0.9)],
                                            "overlayColors": [color(0.1, 0.1, 0.1), color(0.2, 0.8, 0.4)],
                                            "modifiers": { "intensityFactor": 0.4, "noiseFactor": 0.3, "overlay": "sand" },
                                            "translucencyStyle": "dark"
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        })
    }

    fn sidebar(spaces: Value) -> Value {
        json!({
            "sidebar": {
                "containers": [
                    { "global": {} },
                    { "spaces": spaces, "items": [] }
                ]
            }
        })
    }

    #[test]
    fn a_gradient_theme_keeps_three_stops_its_modifiers_and_its_style() {
        let theme = parse_arc_theme(&gradient_theme()).expect("theme");
        assert_eq!(theme.look.stops.len(), 3);
        assert!((theme.look.intensity - 0.4).abs() < 1e-9);
        assert!((theme.look.grain - 0.3).abs() < 1e-9);
        assert_eq!(theme.look.texture, ThemeTexture::Sand);
        assert_eq!(theme.mode, ardia_theme::ThemeMode::Dark);
        assert!(theme.dark.is_none());
    }

    #[test]
    fn a_basic_colour_has_no_grain_or_blur_and_light_and_dark_looks_become_auto() {
        let basic = |c: Value| json!({ "style": { "color": { "_0": { "basicColor": { "_0": { "color": c, "modifiers": { "noiseFactor": 0.9 } } } } } } });
        let theme = json!({
            "background": {
                "appearanceBased": { "light": basic(color(1.0, 0.9, 0.8)), "dark": basic(color(0.1, 0.1, 0.2)) }
            }
        });
        let parsed = parse_arc_theme(&theme).expect("theme");
        assert_eq!(parsed.mode, ardia_theme::ThemeMode::Auto);
        assert_eq!(parsed.look.grain, 0.0);
        assert_eq!(parsed.look.translucency, 0.0);
        assert!(parsed.dark.is_some());
    }

    #[test]
    fn the_window_appearance_forces_the_mode() {
        let mut theme = gradient_theme();
        theme["windowAppearance"] = json!({ "single": { "_0": "light" } });
        assert_eq!(
            parse_arc_theme(&theme).expect("theme").mode,
            ardia_theme::ThemeMode::Light
        );
    }

    #[test]
    fn junk_is_not_a_theme() {
        assert!(parse_arc_theme(&json!({})).is_none());
        assert!(
            parse_arc_theme(&json!({ "background": { "single": { "_0": { "style": {} } } } }))
                .is_none()
        );
        assert!(parse_arc_theme(&json!("text")).is_none());
    }

    #[test]
    fn spaces_with_a_theme_are_listed_with_their_emoji_and_untitled_spaces_are_numbered() {
        let top = sidebar(json!([
            { "id": "a", "title": "Work", "customInfo": { "iconType": { "emoji_v2": "💼" }, "windowTheme": gradient_theme() } },
            { "id": "b", "title": "", "customInfo": { "windowTheme": gradient_theme() } },
            { "id": "c", "title": "Plain", "customInfo": {} },
            "not a space"
        ]));
        let spaces = themed_spaces(&top);
        let titles: Vec<String> = spaces.iter().map(ArcThemeSpace::title).collect();
        assert_eq!(titles, vec!["💼  Work".to_owned(), "Space 1".to_owned()]);
        assert_eq!(spaces[0].id, "a");
    }

    #[test]
    fn a_missing_or_foreign_sidebar_lists_nothing() {
        assert!(themed_spaces(&json!({ "sidebar": {} })).is_empty());
        assert!(read_spaces(Path::new("/nonexistent-ardia-home")).is_empty());
    }

    #[test]
    fn parts_nested_too_deep_are_dropped_but_the_theme_stays() {
        let mut theme = gradient_theme();
        let mut deep = json!(1);
        for _ in 0..20 {
            deep = json!({ "x": deep });
        }
        theme["background"]["single"]["_0"]["style"]["color"]["_0"]["blendedGradient"]["_0"]["modifiers"]
            ["deep"] = deep;
        let top = sidebar(
            json!([{ "id": "a", "title": "Deep", "customInfo": { "windowTheme": theme } }]),
        );
        assert_eq!(themed_spaces(&top).len(), 1);
    }
}
