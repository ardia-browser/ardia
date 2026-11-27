use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value, json};

pub const MANIFEST_UNREADABLE: &str = "Manifest file is missing or unreadable";
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const ICON_SIZE: i64 = 128;
const ICON_TYPES: [&str; 8] = ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"];

fn strip_relaxed_json(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut quote: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            quote = Some(c);
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        if c == ',' {
            let next = chars[i + 1..].iter().find(|n| !n.is_whitespace());
            if matches!(next, Some('}') | Some(']')) {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

fn load_object(path: &Path) -> Option<Map<String, Value>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim_start_matches('\u{feff}');
    let value: Value = serde_json::from_str(text)
        .or_else(|_| serde_json::from_str(&strip_relaxed_json(text)))
        .ok()?;
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn valid_messages(messages: &Map<String, Value>) -> bool {
    messages
        .values()
        .all(|entry| entry.get("message").is_some_and(Value::is_string))
}

fn messages(folder: &Path, manifest: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let locales = folder.join("_locales");
    let mut candidates: Vec<String> = vec!["en_US".into(), "en".into()];
    if let Some(default) = manifest.get("default_locale").and_then(Value::as_str) {
        candidates.push(default.to_owned());
    }
    candidates.extend(["en".to_owned(), "en_US".to_owned()]);
    let mut merged = Map::new();
    let mut loaded: Vec<String> = Vec::new();
    for locale in candidates {
        if loaded.contains(&locale) || locale.contains(['/', '\\']) || locale.contains("..") {
            continue;
        }
        loaded.push(locale.clone());
        let Some(found) = load_object(&locales.join(&locale).join("messages.json")) else {
            continue;
        };
        if !valid_messages(&found) {
            return Err(format!(
                "The localization file _locales/{locale}/messages.json is invalid"
            ));
        }
        for (key, entry) in found {
            merged.entry(key).or_insert(entry);
        }
    }
    Ok(merged)
}

fn localize(value: Option<&Value>, messages: &Map<String, Value>) -> Option<String> {
    let text = value?.as_str()?;
    let Some(key) = text
        .strip_prefix("__MSG_")
        .and_then(|rest| rest.strip_suffix("__"))
        .filter(|key| !key.is_empty())
    else {
        return Some(text.to_owned());
    };
    let key = key.to_lowercase();
    let found = messages
        .iter()
        .find(|(k, _)| k.to_lowercase() == key)
        .and_then(|(_, entry)| entry.get("message"))
        .and_then(Value::as_str);
    Some(found.unwrap_or(text).to_owned())
}

fn icon_path(icons: Option<&Value>, size: i64) -> Option<String> {
    match icons? {
        Value::String(path) => Some(path.clone()),
        Value::Object(map) => {
            let mut best: Option<(&str, i64)> = None;
            for (key, value) in map {
                let (Ok(s), Some(path)) = (key.parse::<i64>(), value.as_str()) else {
                    continue;
                };
                if s <= 0 {
                    continue;
                }
                let better = match best {
                    None => true,
                    Some((_, b)) if b < size => s > b,
                    Some((_, b)) => s >= size && s < b,
                };
                if better {
                    best = Some((path, s));
                }
            }
            best.map(|(path, _)| path.to_owned())
        }
        _ => None,
    }
}

pub fn contained_icon(folder: &Path, relative: &str) -> Option<PathBuf> {
    let relative = relative.trim_start_matches('/');
    if relative.is_empty() {
        return None;
    }
    let rel = Path::new(relative);
    if rel
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return None;
    }
    let extension = rel.extension()?.to_str()?.to_ascii_lowercase();
    if !ICON_TYPES.contains(&extension.as_str()) {
        return None;
    }
    let path = folder.join(rel);
    std::fs::metadata(&path)
        .ok()
        .filter(|m| m.is_file() && m.len() > 0)
        .map(|_| path)
}

fn strings(list: Option<&Value>) -> Vec<String> {
    list.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn host_pattern(text: &str) -> bool {
    text == "<all_urls>" || text.contains("://")
}

pub fn inspect_unpacked(folder: &Path) -> Value {
    let Some(manifest) = load_object(&folder.join("manifest.json")) else {
        return json!({ "error": MANIFEST_UNREADABLE });
    };
    let messages = match messages(folder, &manifest) {
        Ok(messages) => messages,
        Err(error) => return json!({ "error": error }),
    };
    let mut hosts: Vec<String> = Vec::new();
    let mut permissions: Vec<String> = Vec::new();
    for permission in strings(manifest.get("permissions")) {
        if host_pattern(&permission) {
            if !hosts.contains(&permission) {
                hosts.push(permission);
            }
        } else {
            permissions.push(permission);
        }
    }
    let mut add_hosts = |list: Vec<String>| {
        for host in list {
            if !hosts.contains(&host) {
                hosts.push(host);
            }
        }
    };
    add_hosts(strings(manifest.get("host_permissions")));
    if let Some(scripts) = manifest.get("content_scripts").and_then(Value::as_array) {
        for script in scripts {
            add_hosts(strings(script.get("matches")));
        }
    }
    let icon = icon_path(manifest.get("icons"), ICON_SIZE)
        .and_then(|relative| contained_icon(folder, &relative))
        .map(|path| path.to_string_lossy().into_owned());
    let warnings = ardia_state::extension_rules::permission_warnings(&permissions, &hosts);
    json!({
        "name": localize(manifest.get("name"), &messages).unwrap_or_default(),
        "version": manifest.get("version").and_then(Value::as_str).unwrap_or_default(),
        "icon": icon,
        "permissions": permissions,
        "hostPermissions": hosts,
        "warnings": warnings,
        "path": folder.to_string_lossy(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ardia-extension-package-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_name_hosts_permissions_and_icon_like_the_old_reader() {
        let dir = folder("full");
        std::fs::create_dir_all(dir.join("_locales/en")).unwrap();
        std::fs::write(
            dir.join("_locales/en/messages.json"),
            r#"{ "appName": { "message": "Tidy Tabs" } }"#,
        )
        .unwrap();
        std::fs::write(dir.join("icon128.png"), [1u8, 2, 3]).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"{
              // a comment
              "name": "__MSG_appName__",
              "version": "1.2",
              "icons": { "16": "nope.png", "128": "icon128.png", },
              "permissions": ["tabs", "https://a.com/*"],
              "host_permissions": ["https://a.com/*", "https://b.com/*"],
              "content_scripts": [{ "matches": ["https://c.com/*"] }],
            }"#,
        )
        .unwrap();
        let info = inspect_unpacked(&dir);
        assert_eq!(info["name"], "Tidy Tabs");
        assert_eq!(info["version"], "1.2");
        assert_eq!(info["permissions"], json!(["tabs"]));
        assert_eq!(
            info["hostPermissions"],
            json!(["https://a.com/*", "https://b.com/*", "https://c.com/*"])
        );
        assert_eq!(
            info["warnings"],
            json!([
                "Read and change your data on a.com, b.com, and c.com",
                "Read your browsing history"
            ])
        );
        assert!(info["icon"].as_str().unwrap().ends_with("icon128.png"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_manifest_and_bad_locales_answer_the_old_errors() {
        let dir = folder("bad");
        assert_eq!(inspect_unpacked(&dir)["error"], MANIFEST_UNREADABLE);
        std::fs::create_dir_all(dir.join("_locales/en")).unwrap();
        std::fs::write(dir.join("_locales/en/messages.json"), r#"{ "x": 3 }"#).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{ "name": "x" }"#).unwrap();
        assert_eq!(
            inspect_unpacked(&dir)["error"],
            "The localization file _locales/en/messages.json is invalid"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn icons_outside_the_folder_or_of_other_types_are_refused() {
        let dir = folder("icons");
        std::fs::write(dir.join("a.txt"), [1u8]).unwrap();
        assert_eq!(contained_icon(&dir, "../x.png"), None);
        assert_eq!(contained_icon(&dir, "a.txt"), None);
        assert_eq!(contained_icon(&dir, "missing.png"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
