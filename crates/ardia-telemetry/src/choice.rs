use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::ids::uuidv4;
use crate::store;

pub const STATE_DOC: &str = "telemetry.json";
pub const STATE_VERSION: u64 = 2;

pub const WATCH_FIELDS: [&str; 6] = [
    "watchReport",
    "watchStartedAt",
    "watchUntil",
    "sharingUntil",
    "watchCountedMs",
    "watchCheckedAt",
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Saved {
    doc: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Shown {
    pub sharing: bool,
    pub epoch: Option<String>,
    pub decided: bool,
    pub ask_done: bool,
    pub install_id: Option<String>,
    pub watch_report: Option<String>,
    pub watch_until: Option<i64>,
    pub sharing_until: Option<i64>,
}

fn number(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    number.is_finite().then_some(number as i64)
}

fn text(value: Option<&Value>) -> Option<String> {
    value?.as_str().map(str::to_owned)
}

impl Saved {
    pub fn read(dir: &Path) -> Saved {
        let doc = store::read_json(&dir.join(STATE_DOC))
            .and_then(|value| match value {
                Value::Object(doc) => Some(doc),
                _ => None,
            })
            .unwrap_or_default();
        Saved::from_doc(doc)
    }

    pub fn from_doc(mut doc: Map<String, Value>) -> Saved {
        doc.shift_remove("version");
        let install_id = text(doc.get("installId")).filter(|id| !id.is_empty());
        let sharing =
            doc.get("sharing").and_then(Value::as_bool) == Some(true) && install_id.is_some();
        doc.insert("sharing".into(), json!(sharing));
        doc.insert(
            "installId".into(),
            install_id.clone().map_or(Value::Null, Value::String),
        );
        let watch_valid = {
            let report = text(doc.get("watchReport")).filter(|r| !r.is_empty());
            let started = number(doc.get("watchStartedAt"));
            let until = number(doc.get("watchUntil"));
            matches!((report, started, until), (Some(_), Some(s), Some(u)) if u > s)
        };
        if !watch_valid {
            for field in WATCH_FIELDS {
                doc.insert(
                    field.into(),
                    if field == "watchCountedMs" {
                        json!(0)
                    } else {
                        Value::Null
                    },
                );
            }
        }
        if text(doc.get("epoch")).filter(|e| !e.is_empty()).is_none() {
            let legacy = sharing.then(|| {
                format!(
                    "legacy:{}:{}",
                    install_id.clone().unwrap_or_default(),
                    number(doc.get("decidedAt")).unwrap_or(0)
                )
            });
            doc.insert("epoch".into(), legacy.map_or(Value::Null, Value::String));
        }
        Saved { doc }
    }

    pub fn doc(&self) -> &Map<String, Value> {
        &self.doc
    }

    pub fn sharing(&self) -> bool {
        self.doc.get("sharing").and_then(Value::as_bool) == Some(true)
    }

    pub fn install_id(&self) -> Option<String> {
        text(self.doc.get("installId")).filter(|id| !id.is_empty())
    }

    pub fn epoch(&self) -> Option<String> {
        text(self.doc.get("epoch")).filter(|epoch| !epoch.is_empty())
    }

    pub fn number(&self, field: &str) -> Option<i64> {
        number(self.doc.get(field))
    }

    pub fn text(&self, field: &str) -> Option<String> {
        text(self.doc.get(field))
    }

    pub fn flag(&self, field: &str) -> bool {
        self.doc.get(field).and_then(Value::as_bool) == Some(true)
    }

    pub fn shown(&self) -> Shown {
        Shown {
            sharing: self.sharing(),
            epoch: self.sharing().then(|| self.epoch()).flatten(),
            decided: self.number("decidedAt").is_some(),
            ask_done: self.number("askDoneAt").is_some(),
            install_id: self.install_id(),
            watch_report: self.text("watchReport"),
            watch_until: self.number("watchUntil"),
            sharing_until: self.number("sharingUntil"),
        }
    }

    pub fn watch_report_now(&self, now: i64) -> Option<String> {
        let report = self.text("watchReport")?;
        let until = self.number("watchUntil")?;
        (now < until).then_some(report)
    }

    pub fn apply(&mut self, patch: Map<String, Value>) -> bool {
        let was_sharing = self.sharing();
        let was_id = self.install_id();
        for (key, value) in patch {
            self.doc.insert(key, value);
        }
        let rotated =
            self.sharing() != was_sharing || self.install_id() != was_id || self.epoch().is_none();
        if rotated {
            self.doc.insert("epoch".into(), Value::String(uuidv4()));
        }
        rotated
    }

    pub fn to_json(&self) -> Vec<u8> {
        let mut doc = self.doc.clone();
        doc.insert("version".into(), json!(STATE_VERSION));
        serde_json::to_vec(&Value::Object(doc)).unwrap_or_default()
    }

    pub fn path(dir: &Path) -> PathBuf {
        dir.join(STATE_DOC)
    }
}

pub fn no_watch(notice: Option<String>) -> Map<String, Value> {
    let mut patch = Map::new();
    for field in WATCH_FIELDS {
        patch.insert(
            field.into(),
            if field == "watchCountedMs" {
                json!(0)
            } else {
                Value::Null
            },
        );
    }
    patch.insert(
        "watchEndedNotice".into(),
        notice.map_or(Value::Null, Value::String),
    );
    patch
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sharing_needs_an_install_id_and_legacy_docs_get_an_epoch() {
        let saved = Saved::from_doc(
            json!({"sharing": true, "installId": ""})
                .as_object()
                .cloned()
                .unwrap_or_default(),
        );
        assert!(!saved.sharing());
        assert_eq!(saved.epoch(), None);
        let legacy = Saved::from_doc(
            json!({"sharing": true, "installId": "abc", "decidedAt": 5, "version": 1})
                .as_object()
                .cloned()
                .unwrap_or_default(),
        );
        assert!(legacy.sharing());
        assert_eq!(legacy.epoch().as_deref(), Some("legacy:abc:5"));
        assert_eq!(legacy.shown().epoch.as_deref(), Some("legacy:abc:5"));
    }

    #[test]
    fn a_broken_watch_is_cleared_and_unknown_fields_survive() {
        let saved = Saved::from_doc(
            json!({"sharing": false, "installId": "x", "watchReport": "FB-1", "watchStartedAt": 10, "watchUntil": 5, "futureField": 7})
                .as_object()
                .cloned()
                .unwrap_or_default(),
        );
        assert_eq!(saved.text("watchReport"), None);
        assert_eq!(saved.number("futureField"), Some(7));
    }

    #[test]
    fn turning_sharing_on_or_changing_the_id_starts_a_new_period() {
        let mut saved = Saved::from_doc(
            json!({"sharing": false, "installId": "a"})
                .as_object()
                .cloned()
                .unwrap_or_default(),
        );
        assert!(saved.apply(Map::from_iter([("decidedAt".to_owned(), json!(1))])));
        let first = saved.epoch();
        assert!(!saved.apply(Map::from_iter([("askDoneAt".to_owned(), json!(1))])));
        assert_eq!(saved.epoch(), first);
        assert!(saved.apply(Map::from_iter([("sharing".to_owned(), json!(true))])));
        assert_ne!(saved.epoch(), first);
        let written: Value = serde_json::from_slice(&saved.to_json()).unwrap_or(Value::Null);
        assert_eq!(written["version"], 2);
        assert_eq!(written["sharing"], true);
    }
}
