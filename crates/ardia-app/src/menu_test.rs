use std::collections::HashSet;
use std::path::{Path, PathBuf};

use ardia_ui::NativeMenuItem;
use serde_json::{Map, Value, json};

pub const APP_MENU_TEST_KEY: &str = "appMenu";
pub const MENU_FILE: &str = "menu.json";

pub fn test_file(scratch: bool, data_dir: Option<&Path>, test: Option<&str>) -> Option<PathBuf> {
    let test_instance = scratch && !crate::control_peer::signed_for_distribution();
    let wanted = test
        .filter(|_| test_instance)
        .and_then(|text| crate::control_peer::test_value(text, APP_MENU_TEST_KEY))?;
    crate::control_peer::truthy(&wanted).then(|| data_dir.map(|dir| dir.join(MENU_FILE)))?
}

pub const APP_DIALOG_TEST_KEY: &str = "appDialog";
pub const DIALOG_FILE: &str = "dialog.json";

pub fn dialog_test_file(
    scratch: bool,
    data_dir: Option<&Path>,
    test: Option<&str>,
) -> Option<PathBuf> {
    let test_instance = scratch && !crate::control_peer::signed_for_distribution();
    let wanted = test
        .filter(|_| test_instance)
        .and_then(|text| crate::control_peer::test_value(text, APP_DIALOG_TEST_KEY))?;
    crate::control_peer::truthy(&wanted).then(|| data_dir.map(|dir| dir.join(DIALOG_FILE)))?
}

pub fn prompt_answer(prompt: &ardia_ui::TextPrompt, file: &Path) -> Option<String> {
    let dump = json!({
        "kind": "prompt",
        "title": prompt.title,
        "message": prompt.message,
        "value": prompt.value,
        "placeholder": prompt.placeholder,
        "confirmTitle": prompt.confirm,
    });
    if let Ok(bytes) = serde_json::to_vec_pretty(&dump) {
        let staged = file.with_extension("json.tmp");
        if std::fs::write(&staged, bytes).is_ok() {
            let _ = std::fs::rename(&staged, file);
        }
    }
    let mut pick_name = file.as_os_str().to_owned();
    pick_name.push(".pick");
    let pick_file = PathBuf::from(pick_name);
    let pick = std::fs::read_to_string(&pick_file).ok();
    let _ = std::fs::remove_file(&pick_file);
    pick.map(|p| p.trim().to_owned()).filter(|p| !p.is_empty())
}

pub fn item_json(item: &NativeMenuItem) -> Value {
    if item.separator {
        return json!({ "separator": true });
    }
    let mut out = Map::new();
    out.insert("id".into(), json!(item.id));
    out.insert("title".into(), json!(item.title));
    if let Some(symbol) = &item.symbol {
        out.insert("symbol".into(), json!(symbol));
    }
    if let Some(rgb) = item.swatch {
        out.insert("swatch".into(), json!(format!("#{rgb:06X}")));
    }
    out.insert("key".into(), json!(item.key));
    out.insert("modifiers".into(), json!(item.modifiers));
    out.insert("enabled".into(), json!(item.enabled));
    out.insert("checked".into(), json!(item.checked));
    out.insert("alternate".into(), json!(item.alternate));
    if !item.children.is_empty() {
        out.insert(
            "children".into(),
            Value::Array(item.children.iter().map(item_json).collect()),
        );
    }
    Value::Object(out)
}

pub fn enabled_ids(items: &[NativeMenuItem]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for item in items.iter().filter(|i| i.enabled && !i.separator) {
        if item.children.is_empty() {
            ids.insert(item.id.clone());
        } else {
            ids.extend(enabled_ids(&item.children));
        }
    }
    ids
}

pub fn answer(items: &[NativeMenuItem], file: &Path) -> Option<String> {
    let dump = Value::Array(items.iter().map(item_json).collect());
    match serde_json::to_vec_pretty(&dump) {
        Ok(bytes) => {
            let staged = file.with_extension("json.tmp");
            if std::fs::write(&staged, bytes).is_ok() {
                let _ = std::fs::rename(&staged, file);
            }
        }
        Err(error) => log::warn!("menu test dump failed: {error}"),
    }
    let mut pick_name = file.as_os_str().to_owned();
    pick_name.push(".pick");
    let pick_file = PathBuf::from(pick_name);
    let pick = std::fs::read_to_string(&pick_file).ok();
    let _ = std::fs::remove_file(&pick_file);
    let pick = pick?.trim().to_owned();
    enabled_ids(items).contains(&pick).then_some(pick)
}

pub fn describe(items: &[NativeMenuItem]) -> String {
    items
        .iter()
        .filter(|item| !item.separator && !item.title.is_empty())
        .map(|item| item.title.as_str())
        .collect::<Vec<_>>()
        .join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn menu() -> Vec<NativeMenuItem> {
        vec![
            NativeMenuItem::new("copy", "Copy Link", "link")
                .key_equivalent("c", &["shift", "command"]),
            NativeMenuItem::new("copyMd", "Copy Link as Markdown", "link")
                .key_equivalent("c", &["option", "shift", "command"])
                .alternate(),
            NativeMenuItem::separator(),
            NativeMenuItem::new("closeTabs", "Close Tabs", "xmark.square").children(vec![
                NativeMenuItem::new("closeOthers", "Close Other Tabs", "").enabled(false),
                NativeMenuItem::new("closeBelow", "Close Tabs Below", ""),
            ]),
        ]
    }

    #[test]
    fn the_dump_matches_the_old_menu_json_shape() {
        let dumped = item_json(&menu()[0]);
        assert_eq!(dumped["id"], "copy");
        assert_eq!(dumped["symbol"], "link");
        assert_eq!(dumped["key"], "c");
        assert_eq!(dumped["modifiers"], json!(["shift", "command"]));
        assert_eq!(item_json(&menu()[2]), json!({ "separator": true }));
        assert_eq!(item_json(&menu()[3])["children"][1]["id"], "closeBelow");
    }

    #[test]
    fn a_pick_file_chooses_an_enabled_leaf_once_and_is_consumed() {
        let dir = std::env::temp_dir().join(format!("ardia-menu-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(MENU_FILE);
        let pick = dir.join("menu.json.pick");
        std::fs::write(&pick, "closeBelow\n").unwrap();
        assert_eq!(answer(&menu(), &file).as_deref(), Some("closeBelow"));
        assert!(!pick.exists());
        assert!(
            std::fs::read_to_string(&file)
                .unwrap()
                .contains("Copy Link as Markdown")
        );
        assert_eq!(answer(&menu(), &file), None);
        std::fs::write(&pick, "closeOthers").unwrap();
        assert_eq!(answer(&menu(), &file), None);
        std::fs::write(&pick, "closeTabs").unwrap();
        assert_eq!(answer(&menu(), &file), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_scratch_test_instances_with_the_flag_use_the_file() {
        let dir = Path::new("/tmp/ardia-scratch");
        let signed = crate::control_peer::signed_for_distribution();
        assert_eq!(
            test_file(true, Some(dir), Some("appMenu")),
            (!signed).then(|| dir.join(MENU_FILE))
        );
        assert_eq!(test_file(false, Some(dir), Some("appMenu")), None);
        assert_eq!(test_file(true, Some(dir), Some("contextMenu")), None);
        assert_eq!(test_file(true, Some(dir), Some("appMenu=0")), None);
        assert_eq!(test_file(true, None, Some("appMenu")), None);
    }

    #[test]
    fn the_background_log_lists_titles_without_separators() {
        assert_eq!(
            describe(&menu()),
            "Copy Link | Copy Link as Markdown | Close Tabs"
        );
    }

    #[test]
    fn plugin_menu_context_follows_the_plugins_permissions() {
        use crate::plugins::manifest::Permissions;
        use crate::plugins::service::shown_command_context;
        let mut data = serde_json::Map::new();
        data.insert("from".into(), json!("menu"));
        data.insert("url".into(), json!("https://example.com/private/path?q=1"));
        data.insert("title".into(), json!("Secret"));
        data.insert("tabId".into(), json!("t1"));
        data.insert("selection".into(), json!("words"));
        data.insert("nested".into(), json!({ "a": 1 }));
        let none = shown_command_context(&Permissions::default(), &data);
        assert_eq!(none.get("from"), Some(&json!("menu")));
        assert_eq!(none.get("tabId"), Some(&json!("t1")));
        assert!(none.get("url").is_none() && none.get("title").is_none());
        assert!(none.get("selection").is_none() && none.get("nested").is_none());
        let tabs = Permissions {
            tabs: Some("read".into()),
            ..Permissions::default()
        };
        let shown = shown_command_context(&tabs, &data);
        assert_eq!(shown.get("title"), Some(&json!("Secret")));
        assert_ne!(
            shown.get("url"),
            Some(&json!("https://example.com/private/path?q=1"))
        );
        let full = Permissions {
            full_urls: true,
            ..tabs
        };
        assert_eq!(
            shown_command_context(&full, &data).get("url"),
            Some(&json!("https://example.com/private/path?q=1"))
        );
    }

    #[test]
    fn a_prompt_dumps_its_fields_and_takes_the_typed_answer_once() {
        let dir = std::env::temp_dir().join(format!("ardia-prompt-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(DIALOG_FILE);
        let prompt = ardia_ui::TextPrompt {
            title: "Edit Pinned Page".into(),
            message: String::new(),
            value: "https://a.com/".into(),
            placeholder: "Enter Pinned URL".into(),
            confirm: "Save".into(),
        };
        std::fs::write(dir.join("dialog.json.pick"), "b.com\n").unwrap();
        assert_eq!(prompt_answer(&prompt, &file).as_deref(), Some("b.com"));
        let dumped: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(dumped["kind"], "prompt");
        assert_eq!(dumped["confirmTitle"], "Save");
        assert_eq!(prompt_answer(&prompt, &file), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
