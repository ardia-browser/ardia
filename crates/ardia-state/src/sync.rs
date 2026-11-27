use crate::json::{self, Fields};
use crate::model::Millis;
use ardia_sync_core::{SyncKeys, phrase, vault};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

pub const DOCUMENT: &str = "sync.json";
pub const DOCUMENT_VERSION: u64 = 1;
pub const DATA_TYPES: [&str; 7] = [
    "bookmarks",
    "history",
    "tabs",
    "pinned",
    "passwords",
    "extensions",
    "settings",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileLink {
    pub sync_id: String,
    #[serde(default, deserialize_with = "json::lenient")]
    pub enabled: bool,
    #[serde(flatten)]
    pub extra: Fields,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDoc {
    #[serde(default, deserialize_with = "json::lenient")]
    pub enabled: bool,
    #[serde(default, deserialize_with = "json::lenient")]
    pub folder: Option<String>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub device_id: Option<String>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub clock: Option<String>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub types: IndexMap<String, bool>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub profiles: IndexMap<String, ProfileLink>,
    #[serde(default, deserialize_with = "json::option_millis")]
    pub last_synced_at: Option<Millis>,
    #[serde(default, deserialize_with = "json::option_millis")]
    pub setup_at: Option<Millis>,
    #[serde(default, deserialize_with = "json::lenient")]
    pub joining: bool,
    #[serde(flatten)]
    pub extra: Fields,
}

impl Default for SyncDoc {
    fn default() -> Self {
        SyncDoc {
            enabled: false,
            folder: None,
            device_id: None,
            clock: None,
            types: DATA_TYPES.iter().map(|t| ((*t).to_owned(), true)).collect(),
            profiles: IndexMap::new(),
            last_synced_at: None,
            setup_at: None,
            joining: false,
            extra: Fields::new(),
        }
    }
}

impl SyncDoc {
    pub fn from_value(value: &Value) -> SyncDoc {
        let mut doc: SyncDoc = SyncDoc::deserialize(value).unwrap_or_default();
        doc.extra.shift_remove("v");
        for t in DATA_TYPES {
            doc.types.entry(t.to_owned()).or_insert(true);
        }
        doc
    }

    pub fn to_value(&self) -> Value {
        let mut out = Fields::new();
        out.insert("v".into(), DOCUMENT_VERSION.into());
        if let Ok(Value::Object(fields)) = serde_json::to_value(self) {
            out.extend(fields);
        }
        Value::Object(out)
    }

    pub fn syncs(&self, data_type: &str) -> bool {
        self.enabled && self.types.get(data_type).copied().unwrap_or(false)
    }

    pub fn profile_synced(&self, profile: &str) -> bool {
        self.enabled && self.profiles.get(profile).is_some_and(|link| link.enabled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SyncError {
    #[error("the recovery phrase isn't valid: {0}")]
    Phrase(String),
    #[error("sync crypto failed: {0}")]
    Crypto(&'static str),
}

pub struct SyncSession {
    keys: SyncKeys,
}

impl std::fmt::Debug for SyncSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncSession")
            .field("chain", &self.keys.chain_tag())
            .finish()
    }
}

impl SyncSession {
    pub fn create() -> Result<(SyncSession, Zeroizing<String>), SyncError> {
        let entropy = phrase::generate_entropy().map_err(|e| SyncError::Crypto(e.code()))?;
        let words = phrase::phrase(&entropy);
        Ok((
            SyncSession {
                keys: SyncKeys::new(&*entropy),
            },
            words,
        ))
    }

    pub fn join(recovery_phrase: &str) -> Result<SyncSession, SyncError> {
        let entropy =
            phrase::entropy(recovery_phrase).map_err(|e| SyncError::Phrase(e.code().to_owned()))?;
        Ok(SyncSession {
            keys: SyncKeys::new(&*entropy),
        })
    }

    pub fn chain_tag(&self) -> &str {
        self.keys.chain_tag()
    }

    pub fn scope_tag(&self, scope: &str) -> String {
        self.keys.scope_tag(scope)
    }

    pub fn record_path(&self, scope: &str, file_id: &str) -> String {
        vault::relative_path(self.keys.chain_tag(), &self.keys.scope_tag(scope), file_id)
    }

    pub fn new_file_id() -> Result<String, SyncError> {
        ardia_sync_core::new_file_id().map_err(|e| SyncError::Crypto(e.code()))
    }

    pub fn seal(&self, payload: &[u8], scope: &str, file_id: &str) -> Result<Vec<u8>, SyncError> {
        self.keys
            .seal(payload, &self.keys.scope_tag(scope), file_id)
            .map_err(|e| SyncError::Crypto(e.code()))
    }

    pub fn open(&self, sealed: &[u8], scope: &str, file_id: &str) -> Result<Vec<u8>, SyncError> {
        self.keys
            .open(sealed, &self.keys.scope_tag(scope), file_id)
            .map(|plain| plain.to_vec())
            .map_err(|e| SyncError::Crypto(e.code()))
    }

    pub fn list_records<'a>(
        &self,
        names: impl IntoIterator<Item = &'a str>,
        known: &[&str],
    ) -> vault::Listing {
        vault::list(names, known)
    }
}

pub fn phrase_words() -> usize {
    phrase::WORD_COUNT
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn real_sync_documents_round_trip() {
        let raw = json!({"v": 1, "enabled": true, "folder": "/Users/me/Sync", "deviceId": "dev", "clock": "0mwwsalis.0000.dev",
            "types": {"bookmarks": true, "history": false}, "profiles": {"default": {"syncId": "s1", "enabled": true, "themeAdopting": true}},
            "lastSyncedAt": 1795651086229u64, "setupAt": 1795528130334u64, "joining": false, "seqs": {"app": 4}, "sends": {}, "tabCloses": {}});
        let doc = SyncDoc::from_value(&raw);
        assert!(doc.syncs("bookmarks") && !doc.syncs("history") && doc.syncs("settings"));
        assert!(doc.profile_synced("default") && !doc.profile_synced("p-2"));
        let out = doc.to_value();
        assert_eq!(out["v"], json!(1));
        assert_eq!(out["seqs"], json!({"app": 4}));
        assert_eq!(out["profiles"]["default"]["themeAdopting"], json!(true));
        assert!(SyncDoc::from_value(&json!("garbage")).types.len() == DATA_TYPES.len());
    }

    #[test]
    fn sessions_seal_and_open_records_for_their_scope() {
        let (session, words) = SyncSession::create().unwrap();
        assert_eq!(words.split_whitespace().count(), phrase_words());
        let joined = SyncSession::join(&words).unwrap();
        assert_eq!(joined.chain_tag(), session.chain_tag());
        let id = SyncSession::new_file_id().unwrap();
        let sealed = session.seal(b"{\"tabs\":[]}", "app", &id).unwrap();
        assert_eq!(joined.open(&sealed, "app", &id).unwrap(), b"{\"tabs\":[]}");
        assert!(joined.open(&sealed, "other", &id).is_err());
        assert!(SyncSession::join("not a phrase").is_err());
        assert!(session.record_path("app", &id).ends_with(".nns"));
    }
}
