use ardia_state::splits::SplitSide;
use ardia_state::{Action, TabId, WindowId};
use ardia_ui::plugins::bar_actions::PAGE_ACTION;
use ardia_ui::plugins::model::{PluginBarAction, SettingKind, SettingRow, SettingValue};
use serde_json::{Value, json};

use super::super::manifest::{PanelMode, PluginManifest, RowKind, RowSpec};
use super::super::records::write_records;
use super::super::secrets::{MAX_VALUE_BYTES, is_secret_key};
use super::PluginService;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub fn json_of(value: &SettingValue) -> Value {
    match value {
        SettingValue::Bool(on) => Value::Bool(*on),
        SettingValue::Text(text) => Value::String(text.clone()),
        SettingValue::Number(n) if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER => {
            json!(*n as i64)
        }
        SettingValue::Number(n) => json!(n),
    }
}

pub fn setting_of(value: &Value) -> SettingValue {
    match value {
        Value::Bool(on) => SettingValue::Bool(*on),
        Value::Number(n) => SettingValue::Number(n.as_f64().unwrap_or_default()),
        Value::String(text) => SettingValue::Text(text.clone()),
        _ => SettingValue::Text(String::new()),
    }
}

pub fn kind_of(row: &RowSpec) -> SettingKind {
    match &row.kind {
        RowKind::Toggle(_) => SettingKind::Toggle,
        RowKind::Text(_) => SettingKind::Text,
        RowKind::Number { min, max, step, .. } => SettingKind::Number {
            min: *min,
            max: *max,
            step: *step,
        },
        RowKind::Choice { choices, .. } => SettingKind::Choice {
            choices: choices.clone(),
        },
        RowKind::Secret { placeholder } => SettingKind::Secret {
            placeholder: placeholder.clone(),
        },
    }
}

pub fn accepted(row: &RowSpec, value: &Value) -> bool {
    !matches!(row.kind, RowKind::Secret { .. }) && row.value_of(Some(value)) == *value
}

fn secret_row(manifest: Option<&PluginManifest>, key: &str) -> bool {
    manifest.is_some_and(|m| {
        m.contributes
            .settings
            .rows
            .iter()
            .any(|r| r.key == key && matches!(r.kind, RowKind::Secret { .. }))
    })
}

impl PluginService {
    pub fn setting_rows_of(&self, name: &str) -> Vec<SettingRow> {
        let state = self.state.lock();
        let Some(manifest) = state.active(name) else {
            return Vec::new();
        };
        let record = state.records.get(name);
        manifest
            .contributes
            .settings
            .rows
            .iter()
            .map(|row| SettingRow {
                key: row.key.clone(),
                title: row.title.clone(),
                description: row.description.clone(),
                kind: kind_of(row),
                value: setting_of(&row.value_of(record.and_then(|r| r.values.get(&row.key)))),
            })
            .collect()
    }

    pub fn set_setting_value(&self, name: &str, key: &str, value: &SettingValue) -> bool {
        let value = json_of(value);
        let send = {
            let mut state = self.state.lock();
            let Some(row) = state
                .listings
                .get(name)
                .and_then(|l| l.read.manifest.as_ref())
                .and_then(|m| m.contributes.settings.rows.iter().find(|r| r.key == key))
            else {
                return false;
            };
            if !accepted(row, &value) {
                return false;
            }
            let record = state.records.entry(name.to_owned()).or_default();
            let before = record.values.insert(key.to_owned(), value);
            if let Err(error) = write_records(&self.folders.data_dir, &state.records) {
                log::warn!("[plugins] couldn't save plugins.json: {error}");
                if let Some(record) = state.records.get_mut(name) {
                    match before {
                        Some(before) => record.values.insert(key.to_owned(), before),
                        None => record.values.remove(key),
                    };
                }
                return false;
            }
            state.active(name).is_some().then(|| state.values_for(name))
        };
        if let Some(values) = send {
            let event = json!({
                "event": "plugin.values",
                "time": ardia_state::store::now_ms(),
                "data": { "values": values },
            });
            self.send_ready(name, &event);
        }
        self.env.notify();
        true
    }

    fn manifest_has_secret(&self, name: &str, key: &str) -> bool {
        let state = self.state.lock();
        secret_row(
            state
                .listings
                .get(name)
                .and_then(|l| l.read.manifest.as_ref()),
            key,
        )
    }

    pub fn secret_row_set(&self, name: &str, key: &str) -> bool {
        is_secret_key(key)
            && self.manifest_has_secret(name, key)
            && self
                .secrets
                .keys(name)
                .is_ok_and(|keys| keys.iter().any(|k| k == key))
    }

    pub fn write_secret_row(
        &self,
        name: &str,
        key: &str,
        value: Option<&str>,
    ) -> Result<(), String> {
        if !is_secret_key(key) || !self.manifest_has_secret(name, key) {
            return Err(format!("{name} has no secret row {key}."));
        }
        match value.filter(|v| !v.is_empty()) {
            None => self.secrets.delete(name, key),
            Some(value) if value.len() > MAX_VALUE_BYTES => Err(format!(
                "value is text of at most {} KB.",
                MAX_VALUE_BYTES / 1024
            )),
            Some(value) => {
                let written = self.secrets.set(name, key, value);
                if written.is_ok() {
                    ardia_telemetry::counts::count("plugin_secret_writes");
                }
                written
            }
        }
    }

    pub fn plugin_bar_actions(&self) -> Vec<PluginBarAction> {
        let state = self.state.lock();
        let mut out = Vec::new();
        for name in state.active_names() {
            let Some(m) = state.active(&name) else {
                continue;
            };
            if let Some(page) = &m.page {
                out.push(PluginBarAction {
                    plugin: name.clone(),
                    action: PAGE_ACTION.to_owned(),
                    title: format!("Open {}", page.title),
                    icon: Some(page.icon.clone()).filter(|i| !i.is_empty()),
                    keywords: vec![m.title.clone(), "plugin".to_owned()],
                    when: None,
                });
            }
            for command in &m.contributes.commands {
                let mut keywords = command.keywords.clone();
                keywords.push(m.title.clone());
                out.push(PluginBarAction {
                    plugin: name.clone(),
                    action: command.name.clone(),
                    title: command.title.clone(),
                    icon: Some(command.icon.clone()).filter(|i| !i.is_empty()),
                    keywords,
                    when: command.when.clone(),
                });
            }
        }
        out
    }

    pub fn open_page_of(&self, window: &WindowId, name: &str) {
        self.open_page_with(window, name, "", None, false);
    }

    pub fn chosen_side(&self, name: &str, side: &str, setting: Option<&str>) -> SplitSide {
        let chosen = setting.and_then(|key| {
            self.state
                .lock()
                .values_for(name)
                .get(key)
                .and_then(Value::as_str)
                .and_then(SplitSide::from_key)
        });
        chosen
            .or_else(|| SplitSide::from_key(side))
            .unwrap_or(SplitSide::Right)
    }

    pub fn open_page_with(
        &self,
        window: &WindowId,
        name: &str,
        path: &str,
        split: Option<SplitSide>,
        context: bool,
    ) -> Option<TabId> {
        let has_pages = self.state.lock().active(name).is_some_and(|m| {
            m.page.is_some()
                || m.contributes
                    .panels
                    .iter()
                    .any(|p| p.mode == PanelMode::Tab)
        });
        if !has_pages || !self.env.window_eligible(window) {
            return None;
        }
        let url = format!("ardia://{name}{path}");
        let Some(browser) = self.env.state() else {
            let opened = self.env.open_url(window, &url, true);
            if let Some(tab) = &opened {
                ardia_telemetry::counts::count("plugin_page_opens");
                self.hand_context(tab, name, &url, None);
            }
            return opened;
        };
        let anchor = browser.active_tab(window.as_str()).map(|t| t.id.clone());
        let existing = browser
            .view_tabs(window.as_str(), None)
            .into_iter()
            .find(|t| t.url == url)
            .map(|t| t.id.clone());
        let handed = if context {
            let window_eligible = anchor
                .as_ref()
                .and_then(|tab| browser.tab(tab.as_str()))
                .is_some_and(|tab| self.env.window_eligible(&tab.window_id));
            let state = self.state.lock();
            Self::context_of(&state, &browser, name, anchor.as_ref(), window_eligible)
        } else {
            None
        };
        let opened = match (split, anchor) {
            (Some(side), Some(anchor)) if existing.as_ref() != Some(&anchor) => {
                let action = match existing.clone() {
                    Some(tab) => Action::DropIntoSplit { tab, anchor, side },
                    None => Action::OpenSplitPane {
                        window: window.clone(),
                        side,
                        url: Some(url.clone()),
                    },
                };
                let opened = self.env.dispatch(action).ok().flatten().or(existing);
                if opened.is_some() {
                    ardia_telemetry::counts::count("plugin_split_opens");
                }
                opened
            }
            _ => match existing {
                Some(tab) => {
                    let _ = self.env.dispatch(Action::ActivateTab { tab: tab.clone() });
                    Some(tab)
                }
                None => self.env.open_url(window, &url, true),
            },
        };
        if let Some(tab) = &opened {
            ardia_telemetry::counts::count("plugin_page_opens");
            self.hand_context(tab, name, &url, handed);
        }
        opened
    }

    pub fn turn_on_approved_plugin(&self, name: &str) -> bool {
        let settings = self.env.state().map(|b| b.settings.clone());
        let file_keys = super::super::defaults::file_keys(&self.folders.config_dir);
        let patch = {
            let mut state = self.state.lock();
            if state.consent.is_some() {
                return false;
            }
            let Some(listing) = state.listings.get(name) else {
                return false;
            };
            let Some(manifest) = listing.read.manifest.as_ref() else {
                return false;
            };
            let Some(hash) = listing.hash.clone() else {
                return false;
            };
            let keeps_installed = listing.official && manifest.always_on;
            let defaults = manifest.contributes.settings.defaults.clone();
            let Some(record) = state.records.get_mut(name) else {
                return false;
            };
            let approves = |h: &Option<String>| h.as_deref() == Some(hash.as_str());
            if record.enabled || !(approves(&record.approved) || approves(&record.previous)) {
                return false;
            }
            let applied_before = record.applied.clone();
            let records_before = state.records.clone();
            let plan = settings.as_ref().map(|settings| {
                super::super::defaults::plan_enable(
                    &defaults,
                    &state.records,
                    name,
                    &applied_before,
                    settings,
                    &file_keys,
                )
            });
            let Some(record) = state.records.get_mut(name) else {
                return false;
            };
            record.enabled = true;
            if keeps_installed {
                record.installed = true;
            }
            if let Some(plan) = &plan {
                record.applied = plan.applied.clone();
            }
            if let Err(error) = write_records(&self.folders.data_dir, &state.records) {
                log::warn!("[plugins] couldn't save plugins.json: {error}");
                state.records = records_before;
                state.unsaved = Some(name.to_owned());
                drop(state);
                self.env.notify();
                return false;
            }
            if state.unsaved.as_deref() == Some(name) {
                state.unsaved = None;
            }
            plan.map(|p| p.patch).unwrap_or_default()
        };
        self.apply_settings_patch(patch);
        let eager = self
            .state
            .lock()
            .active(name)
            .is_some_and(PluginManifest::runs_eagerly);
        if eager {
            self.supervise(name);
        }
        self.reconcile_programs();
        self.env.notify();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::read_manifest;

    const HOSTILE_TEXT: &[&str] = &[
        "\n", "\r", "\r\n", "\u{000c}", "\u{000b}", "\u{0085}", "\u{0000}", "\u{001f}", "\u{007f}",
        "\u{202e}", "\u{2066}", "\u{061c}", "a\nb",
    ];

    const SEPARATORS_THE_OLD_CHECK_ALLOWS: &[&str] = &["\u{2028}", "\u{2029}"];

    const HOSTILE_KEYS: &[&str] = &[
        "__proto__x!",
        "constructor prototype",
        "../x",
        "a/b",
        "a\nb",
        "",
        "toString()",
    ];

    fn manifest(rows: &str) -> String {
        format!(
            r#"{{"manifest":2,"name":"knobs","title":"Knobs","permissions":{{"secrets":true}},"contributes":{{"settings":{{"rows":[{rows}]}}}}}}"#
        )
    }

    fn rows_of(rows: &str) -> Vec<RowSpec> {
        read_manifest(&manifest(rows))
            .manifest
            .map(|m| m.contributes.settings.rows)
            .unwrap_or_default()
    }

    #[test]
    fn hostile_values_never_reach_the_stored_record() {
        let rows = rows_of(
            r#"{"key":"name","title":"Name","type":"text","default":"Ada"},
            {"key":"side","title":"Side","type":"choice","default":"left","choices":[{"value":"left","title":"Left"},{"value":"right","title":"Right"}]},
            {"key":"count","title":"Count","type":"number","default":3,"min":1,"max":10},
            {"key":"loud","title":"Loud","type":"toggle","default":false},
            {"key":"token","title":"Token","type":"secret"}"#,
        );
        assert_eq!(rows.len(), 5);
        let (name, side, count, loud, token) = (&rows[0], &rows[1], &rows[2], &rows[3], &rows[4]);
        for text in HOSTILE_TEXT {
            assert!(!accepted(name, &json!(text)), "{text:?}");
            assert!(!accepted(name, &json!(format!("ok{text}"))), "{text:?}");
            assert!(!accepted(side, &json!(text)), "{text:?}");
        }
        for text in SEPARATORS_THE_OLD_CHECK_ALLOWS {
            assert!(accepted(name, &json!(format!("a{text}b"))), "{text:?}");
            assert!(!accepted(side, &json!(text)), "{text:?}");
        }
        assert!(!accepted(name, &json!("x".repeat(5000))));
        assert!(accepted(name, &json!("Grace Hopper")));
        for wrong in [json!(null), json!([]), json!({}), json!(1), json!(true)] {
            assert!(!accepted(name, &wrong), "{wrong}");
            assert!(!accepted(side, &wrong), "{wrong}");
        }
        for key in [
            "left ",
            " left",
            "LEFT",
            "__proto__",
            "constructor",
            "right\n",
        ] {
            assert!(!accepted(side, &json!(key)), "{key:?}");
        }
        assert!(accepted(side, &json!("right")));
        for wrong in [
            json!(0),
            json!(11),
            json!(1e13),
            json!(-1e300),
            json!("5"),
            json!(null),
            json!(true),
        ] {
            assert!(!accepted(count, &wrong), "{wrong}");
        }
        assert!(accepted(count, &json!(5)));
        assert!(!accepted(loud, &json!("true")));
        assert!(!accepted(loud, &json!(1)));
        assert!(accepted(loud, &json!(true)));
        for anything in [json!(""), json!("s3"), json!(true)] {
            assert!(!accepted(token, &anything), "{anything}");
        }
        assert_eq!(json_of(&SettingValue::Number(f64::NAN)), Value::Null);
        assert_eq!(json_of(&SettingValue::Number(7.0)), json!(7));
        assert_eq!(json_of(&SettingValue::Number(0.5)), json!(0.5));
        assert_eq!(count.default_value(), json!(3));
    }

    #[test]
    fn hostile_manifests_load_no_bad_rows() {
        for key in HOSTILE_KEYS {
            let rows = rows_of(&format!(
                r#"{{"key":{},"title":"T","type":"toggle","default":false}}"#,
                json!(key)
            ));
            assert!(rows.is_empty(), "{key:?}");
        }
        for text in HOSTILE_TEXT {
            let titled = rows_of(&format!(
                r#"{{"key":"k","title":{},"type":"toggle","default":false}}"#,
                json!(format!("T{text}"))
            ));
            assert!(titled.is_empty(), "title {text:?}");
            let defaulted = rows_of(&format!(
                r#"{{"key":"k","title":"T","type":"text","default":{}}}"#,
                json!(format!("d{text}"))
            ));
            assert!(defaulted.is_empty(), "default {text:?}");
            let choice = rows_of(&format!(
                r#"{{"key":"k","title":"T","type":"choice","default":"a","choices":[{{"value":"a","title":"A"}},{{"value":"b","title":{}}}]}}"#,
                json!(format!("B{text}"))
            ));
            assert!(
                choice.first().is_none_or(
                    |r| matches!(&r.kind, RowKind::Choice { choices, .. } if choices.len() < 2)
                ),
                "choice {text:?}"
            );
        }
        let read = read_manifest(&manifest(
            r#"{"key":"k","title":"T","type":"choice","default":"z","choices":[{"value":"a","title":"A"},{"value":"b","title":"B"}]}"#,
        ));
        assert!(
            read.problems
                .iter()
                .any(|p| p.contains("must be one of its choices"))
        );
        let read = read_manifest(&manifest(
            r#"{"key":"k","title":"T","type":"number","default":50,"min":1,"max":10}"#,
        ));
        assert!(
            read.problems
                .iter()
                .any(|p| p.contains("between its min and max"))
        );
        let read = read_manifest(&manifest(
            r#"{"key":"k","title":"T","type":"secret","default":"leak"}"#,
        ));
        assert!(
            read.problems
                .iter()
                .any(|p| p.contains("can't go with a secret"))
        );
        let read = read_manifest(
            r#"{"manifest":2,"name":"knobs","title":"Knobs","contributes":{"settings":{"rows":[{"key":"k","title":"T","type":"secret"}]}}}"#,
        );
        assert!(
            read.problems
                .iter()
                .any(|p| p.contains("needs the secrets permission"))
        );
        assert!(read.manifest.is_none());
    }

    fn corpus() -> Vec<String> {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/security/hostile-inputs.mjs");
        let script = std::fs::canonicalize(&script).expect("the shared hostile corpus is here");
        let program = "const { pathToFileURL } = await import('node:url'); \
            const corpus = await import(pathToFileURL(process.argv[1]).href); \
            process.stdout.write(JSON.stringify(corpus.HOSTILE_STRINGS.map((entry) => [...Buffer.from(String(entry.value), 'utf8')])));";
        let output = std::process::Command::new("node")
            .args(["--input-type=module", "-e", program])
            .arg(&script)
            .output()
            .expect("node reads the shared hostile corpus");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let bytes: Vec<Vec<u8>> = serde_json::from_slice(&output.stdout).expect("json");
        let values: Vec<String> = bytes
            .into_iter()
            .map(|value| String::from_utf8_lossy(&value).into_owned())
            .collect();
        assert!(
            values.len() > 20,
            "the corpus came back with {} values",
            values.len()
        );
        values
    }

    fn plain_key(key: &str) -> bool {
        (1..=40).contains(&key.len())
            && key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    }

    fn control_free(text: &str) -> bool {
        !text.chars().any(|c| {
            matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}' | '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    }

    #[test]
    fn the_shared_hostile_corpus_never_reaches_a_setting_unchecked() {
        let rows = rows_of(
            r#"{"key":"name","title":"Name","type":"text","default":"Ada"},
            {"key":"side","title":"Side","type":"choice","default":"left","choices":[{"value":"left","title":"Left"},{"value":"right","title":"Right"}]}"#,
        );
        let (name, side) = (&rows[0], &rows[1]);
        for value in corpus() {
            let given = json!(value);
            if accepted(name, &given) {
                assert!(
                    control_free(&value)
                        && value.encode_utf16().count()
                            <= crate::plugins::manifest::limits::ROW_TEXT,
                    "{value:?}"
                );
            }
            assert!(!accepted(side, &given), "{value:?}");
            let keyed = rows_of(&format!(
                r#"{{"key":{},"title":"T","type":"toggle","default":false}}"#,
                json!(value)
            ));
            assert!(keyed.iter().all(|r| plain_key(&r.key)), "key {value:?}");
            let titled = rows_of(&format!(
                r#"{{"key":"k","title":{},"type":"choice","default":"a","choices":[{{"value":"a","title":"A"}},{{"value":{},"title":"B"}}]}}"#,
                json!(value),
                json!(value)
            ));
            for row in &titled {
                assert!(control_free(&row.title), "title {value:?}");
                if let RowKind::Choice { choices, .. } = &row.kind {
                    assert!(
                        choices.iter().all(|(v, t)| plain_key(v) && control_free(t)),
                        "choice {value:?}"
                    );
                }
            }
        }
    }
}
