use crate::ids::DownloadId;
use crate::json::{self, Fields};
use crate::macros::string_enum;
use serde::{Deserialize, Serialize};
use serde_json::Value;

string_enum!(DownloadState { Downloading = "downloading", Finished = "finished", Failed = "failed", Cancelled = "cancelled" } default Downloading);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: DownloadId,
    #[serde(default, deserialize_with = "json::lenient")]
    pub url: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub filename: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub path: String,
    pub state: DownloadState,
    #[serde(default, deserialize_with = "json::lenient")]
    pub paused: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub dangerous: Option<bool>,
    #[serde(
        default,
        deserialize_with = "json::finite_f64",
        serialize_with = "json::serialize_f64"
    )]
    pub received: f64,
    #[serde(
        default,
        deserialize_with = "json::finite_f64",
        serialize_with = "json::serialize_f64"
    )]
    pub total: f64,
    #[serde(
        default,
        deserialize_with = "json::finite_f64",
        serialize_with = "json::serialize_f64"
    )]
    pub speed: f64,
    #[serde(default, deserialize_with = "json::lenient")]
    pub mime_type: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub profile: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub off_the_record: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub staging: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient",
        serialize_with = "json::serialize_option_f64"
    )]
    pub start_time: Option<f64>,
    #[serde(flatten)]
    pub extra: Fields,
}

impl Download {
    pub fn row_is_valid(row: &Value) -> bool {
        row.as_object().is_some_and(|f| {
            json::string(f.get("id"))
                && json::string(f.get("state"))
                && DownloadState::from_key(f["state"].as_str().unwrap_or("")).is_some()
                && f.get("profile")
                    .is_none_or(|p| p.is_null() || p.is_string())
        })
    }

    pub fn progress(&self) -> Option<f64> {
        (self.total > 0.0).then(|| (self.received / self.total).clamp(0.0, 1.0))
    }

    pub fn is_private(&self) -> bool {
        self.off_the_record == Some(true)
            || self
                .profile
                .as_deref()
                .is_some_and(|p| p.starts_with(crate::ids::INCOGNITO_PREFIX))
    }

    pub fn is_active(&self) -> bool {
        self.state == DownloadState::Downloading
    }

    pub fn saved(&self) -> Download {
        let mut out = self.clone();
        if out.state == DownloadState::Downloading {
            out.state = DownloadState::Failed;
        }
        out.extra.shift_remove("stagingId");
        out.extra.shift_remove("destination");
        out
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DownloadList {
    items: Vec<Download>,
}

impl DownloadList {
    pub fn from_saved(rows: Vec<Download>) -> Self {
        let mut seen = std::collections::HashSet::new();
        let items = rows
            .into_iter()
            .filter(|d| !d.is_private())
            .filter(|d| {
                seen.insert((
                    d.url.clone(),
                    d.path.clone(),
                    d.start_time.map(f64::to_bits),
                ))
            })
            .enumerate()
            .map(|(i, mut d)| {
                d.id = DownloadId::from(format!("saved-{i}"));
                if d.state == DownloadState::Downloading {
                    d.state = DownloadState::Failed;
                    d.staging = None;
                }
                d
            })
            .collect();
        DownloadList { items }
    }

    pub fn items(&self) -> &[Download] {
        &self.items
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn get(&self, id: &str) -> Option<&Download> {
        self.items.iter().find(|d| d.id == id)
    }

    pub fn upsert(&mut self, download: Download) {
        match self.items.iter_mut().find(|d| d.id == download.id) {
            Some(existing) => *existing = download,
            None => self.items.insert(0, download),
        }
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|d| d.id != id);
        before != self.items.len()
    }

    pub fn clear_inactive(&mut self) -> usize {
        let before = self.items.len();
        self.items.retain(Download::is_active);
        before - self.items.len()
    }

    pub fn active_progress(&self) -> Option<f64> {
        let active: Vec<&Download> = self
            .items
            .iter()
            .filter(|d| d.is_active() && !d.paused)
            .collect();
        let total: f64 = active.iter().map(|d| d.total).sum();
        (total > 0.0).then(|| active.iter().map(|d| d.received).sum::<f64>() / total)
    }

    pub fn saved(&self) -> Vec<Download> {
        self.items
            .iter()
            .filter(|d| !d.is_private())
            .map(Download::saved)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn real_row() -> Value {
        json!({"offTheRecord": false, "id": "saved-0", "startTime": 1795614276481.391, "filename": "clip.mp4", "dangerous": false, "total": 6315552, "sha256": "dd6b", "mimeType": "video/mp4", "path": "/Users/me/Downloads/clip.mp4", "paused": false, "state": "finished", "url": "https://x.example/clip.mp4", "error": null, "profile": "", "speed": 0, "received": 6315552})
    }

    #[test]
    fn real_download_rows_round_trip_with_extra_fields() {
        assert!(Download::row_is_valid(&real_row()));
        let d: Download = serde_json::from_value(real_row()).unwrap();
        assert_eq!(d.progress(), Some(1.0));
        let out = serde_json::to_value(&d).unwrap();
        assert_eq!(out["sha256"], json!("dd6b"));
        assert_eq!(out["total"], json!(6315552));
        assert_eq!(out["startTime"], json!(1795614276481.391));
        assert!(!Download::row_is_valid(
            &json!({"id": "x", "state": "exploded"})
        ));
        assert!(!Download::row_is_valid(
            &json!({"id": "x", "state": "failed", "profile": 3})
        ));
    }

    #[test]
    fn saved_lists_drop_private_rows_and_fail_unfinished_ones() {
        let mut active: Download = serde_json::from_value(real_row()).unwrap();
        active.state = DownloadState::Downloading;
        active.url = "https://x.example/b".into();
        let mut private = active.clone();
        private.off_the_record = Some(true);
        private.url = "https://x.example/c".into();
        let finished: Download = serde_json::from_value(real_row()).unwrap();
        let list = DownloadList::from_saved(vec![finished.clone(), finished, active, private]);
        assert_eq!(list.len(), 2);
        assert_eq!(list.items()[1].state, DownloadState::Failed);
        assert_eq!(list.items()[1].id.as_str(), "saved-1");
        let mut list = list;
        let mut live: Download = serde_json::from_value(real_row()).unwrap();
        live.id = DownloadId::new("live");
        live.state = DownloadState::Downloading;
        live.received = 1.0;
        live.total = 4.0;
        list.upsert(live);
        assert_eq!(list.active_progress(), Some(0.25));
        assert_eq!(list.saved()[0].state, DownloadState::Failed);
        assert_eq!(list.clear_inactive(), 2);
        assert!(list.remove("live"));
        assert!(list.is_empty());
    }
}
