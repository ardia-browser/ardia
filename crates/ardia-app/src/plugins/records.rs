use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::manifest::{is_key, is_name, is_version};

pub const PLUGINS_DOC: &str = "plugins.json";
const VERSION: i64 = 1;
pub const MAX_UPDATE_LINES: usize = 24;
const MAX_UPDATE_LINE: usize = 600;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AutoUpdate {
    pub from: Option<String>,
    pub to: Option<String>,
    pub added: Vec<String>,
    pub runtime: bool,
}

impl AutoUpdate {
    fn from_raw(raw: &Value) -> Option<AutoUpdate> {
        let fields = raw.as_object()?;
        let added = fields.get("added")?.as_array()?;
        let version = |key: &str| {
            fields
                .get(key)
                .and_then(Value::as_str)
                .filter(|v| is_version(v))
                .map(str::to_owned)
        };
        Some(AutoUpdate {
            from: version("from"),
            to: version("to"),
            added: added
                .iter()
                .filter_map(Value::as_str)
                .filter(|line| !line.is_empty() && line.encode_utf16().count() <= MAX_UPDATE_LINE)
                .take(MAX_UPDATE_LINES)
                .map(str::to_owned)
                .collect(),
            runtime: fields.get("runtime") == Some(&Value::Bool(true)),
        })
    }

    fn to_raw(&self) -> Value {
        let mut out = serde_json::json!({
            "from": self.from,
            "to": self.to,
            "added": self.added,
        });
        if self.runtime {
            out["runtime"] = Value::Bool(true);
        }
        out
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AppliedStep {
    pub value: Value,
    pub previous: Value,
    pub order: i64,
    pub over: Option<String>,
}

fn applied_of(raw: Option<&Value>) -> BTreeMap<String, AppliedStep> {
    let Some(fields) = raw.and_then(Value::as_object) else {
        return BTreeMap::new();
    };
    fields
        .iter()
        .filter_map(|(key, entry)| {
            let entry = entry.as_object()?;
            let value = entry.get("value")?.clone();
            Some((
                key.clone(),
                AppliedStep {
                    value,
                    previous: entry.get("previous").cloned().unwrap_or(Value::Null),
                    order: entry
                        .get("order")
                        .and_then(Value::as_i64)
                        .filter(|n| n.abs() <= 9_007_199_254_740_991)
                        .unwrap_or(0),
                    over: entry
                        .get("over")
                        .and_then(Value::as_str)
                        .filter(|n| is_name(n))
                        .map(str::to_owned),
                },
            ))
        })
        .collect()
}

fn applied_raw(applied: &BTreeMap<String, AppliedStep>) -> Value {
    Value::Object(
        applied
            .iter()
            .map(|(key, step)| {
                (
                    key.clone(),
                    serde_json::json!({
                        "value": step.value,
                        "previous": step.previous,
                        "order": step.order,
                        "over": step.over,
                    }),
                )
            })
            .collect(),
    )
}

pub fn approval_hash(text: &str, folder_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hasher.update([0u8]);
    hasher.update(folder_id.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn is_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

pub fn switch_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let (host, port) = if authority.starts_with('[') {
        let close = authority.find(']')?;
        let port = authority[close + 1..].strip_prefix(':');
        (&authority[..=close], port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let default_port = if scheme == "http" { "80" } else { "443" };
    let port = port.filter(|p| !p.is_empty() && *p != default_port);
    Some(match port {
        Some(port) if port.chars().all(|c| c.is_ascii_digit()) => {
            format!("{scheme}://{host}:{port}")
        }
        Some(_) => return None,
        None => format!("{scheme}://{host}"),
    })
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PluginRecord {
    pub enabled: bool,
    pub approved: Option<String>,
    pub previous: Option<String>,
    pub installed: bool,
    pub values: Map<String, Value>,
    pub sites: BTreeMap<String, BTreeMap<String, bool>>,
    pub updated: Option<AutoUpdate>,
    pub applied: BTreeMap<String, AppliedStep>,
    pub raw: Map<String, Value>,
}

impl PluginRecord {
    fn from_raw(raw: &Map<String, Value>) -> PluginRecord {
        let approved = raw
            .get("approved")
            .and_then(Value::as_str)
            .filter(|h| is_hash(h))
            .map(str::to_owned);
        let values = raw
            .get("values")
            .and_then(Value::as_object)
            .map(|values| {
                values
                    .iter()
                    .filter(|(_, v)| {
                        v.is_string() || v.is_boolean() || v.as_f64().is_some_and(f64::is_finite)
                    })
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut sites = BTreeMap::new();
        if let Some(raw_sites) = raw.get("sites").and_then(Value::as_object) {
            for (key, origins) in raw_sites {
                let Some(origins) = origins.as_object().filter(|_| is_key(key)) else {
                    continue;
                };
                let kept: BTreeMap<String, bool> = origins
                    .iter()
                    .filter_map(|(origin, on)| {
                        let on = on.as_bool()?;
                        (switch_origin(origin).as_deref() == Some(origin.as_str()))
                            .then(|| (origin.clone(), on))
                    })
                    .collect();
                if !kept.is_empty() {
                    sites.insert(key.clone(), kept);
                }
            }
        }
        PluginRecord {
            enabled: raw.get("enabled") == Some(&Value::Bool(true)) && approved.is_some(),
            approved,
            previous: raw
                .get("previous")
                .and_then(Value::as_str)
                .filter(|h| is_hash(h))
                .map(str::to_owned),
            installed: raw.get("installed") == Some(&Value::Bool(true)),
            values,
            sites,
            updated: raw.get("updated").and_then(AutoUpdate::from_raw),
            applied: applied_of(raw.get("applied")),
            raw: raw.clone(),
        }
    }

    fn to_raw(&self) -> Value {
        let mut out = self.raw.clone();
        out.insert("enabled".into(), Value::Bool(self.enabled));
        out.insert(
            "approved".into(),
            self.approved.clone().map_or(Value::Null, Value::String),
        );
        out.insert("values".into(), Value::Object(self.values.clone()));
        out.insert("applied".into(), applied_raw(&self.applied));
        match &self.updated {
            Some(updated) => out.insert("updated".into(), updated.to_raw()),
            None => out.remove("updated"),
        };
        if self.installed {
            out.insert("installed".into(), Value::Bool(true));
        }
        match &self.previous {
            Some(previous) => out.insert("previous".into(), Value::String(previous.clone())),
            None => out.remove("previous"),
        };
        if self.sites.is_empty() {
            out.remove("sites");
        } else {
            out.insert("sites".into(), serde_json::json!(self.sites));
        }
        Value::Object(out)
    }

    pub fn site_switch(&self, key: &str, origin: &str) -> bool {
        self.sites
            .get(key)
            .and_then(|origins| origins.get(origin))
            .copied()
            .unwrap_or(false)
    }

    pub fn set_site_switch(&mut self, key: &str, origin: &str, on: bool) {
        let origins = self.sites.entry(key.to_owned()).or_default();
        if on {
            origins.insert(origin.to_owned(), true);
        } else {
            origins.remove(origin);
        }
        if origins.is_empty() {
            self.sites.remove(key);
        }
    }
}

pub fn parse_records(json: Option<&str>) -> BTreeMap<String, PluginRecord> {
    let Some(doc) = json.and_then(|text| serde_json::from_str::<Value>(text).ok()) else {
        return BTreeMap::new();
    };
    if doc
        .get("version")
        .and_then(Value::as_i64)
        .is_some_and(|v| v > VERSION)
    {
        return BTreeMap::new();
    }
    let Some(plugins) = doc.get("plugins").and_then(Value::as_object) else {
        return BTreeMap::new();
    };
    plugins
        .iter()
        .filter(|(name, _)| is_name(name))
        .filter_map(|(name, raw)| {
            raw.as_object()
                .map(|raw| (name.clone(), PluginRecord::from_raw(raw)))
        })
        .collect()
}

pub fn records_json(records: &BTreeMap<String, PluginRecord>) -> String {
    let plugins: Map<String, Value> = records
        .iter()
        .map(|(name, record)| (name.clone(), record.to_raw()))
        .collect();
    serde_json::json!({ "plugins": plugins, "version": VERSION }).to_string()
}

pub fn records_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PLUGINS_DOC)
}

pub fn read_records(data_dir: &Path) -> BTreeMap<String, PluginRecord> {
    parse_records(
        std::fs::read_to_string(records_path(data_dir))
            .ok()
            .as_deref(),
    )
}

pub fn write_records(
    data_dir: &Path,
    records: &BTreeMap<String, PluginRecord>,
) -> std::io::Result<()> {
    let path = records_path(data_dir);
    let staged = path.with_extension("json.saving");
    std::fs::write(&staged, records_json(records))?;
    std::fs::rename(staged, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_match_the_swift_approval_formula() {
        assert_eq!(
            approval_hash("{}", "official-abc"),
            "245ca8165ef6b474984174a25d828daeda0563980cb68cf043c90867594aebac"
        );
        assert_eq!(approval_hash("a", "b").len(), 64);
        assert_ne!(approval_hash("a", "b"), approval_hash("a", "c"));
    }

    #[test]
    fn records_round_trip_and_drop_bad_entries() {
        let hash = "a".repeat(64);
        let text = format!(
            r#"{{"plugins":{{"cli":{{"enabled":true,"approved":"{hash}","values":{{"x":1,"bad":{{}}}},"applied":{{}},"installed":true,"extra":7,
            "sites":{{"dev":{{"https://a.test":true,"nope":true}}}}}},"Bad Name":{{}},"off":{{"enabled":true,"approved":"short"}}}},"version":1}}"#
        );
        let records = parse_records(Some(&text));
        assert_eq!(records.len(), 2);
        let cli = &records["cli"];
        assert!(cli.enabled && cli.installed);
        assert_eq!(cli.values.len(), 1);
        assert!(cli.site_switch("dev", "https://a.test"));
        assert!(!records["off"].enabled);
        let again = parse_records(Some(&records_json(&records)));
        assert_eq!(again["cli"].raw["extra"], serde_json::json!(7));
        assert_eq!(again["cli"].approved, cli.approved);
        assert_eq!(
            switch_origin("https://User@Example.COM.:443/x"),
            Some("https://example.com".into())
        );
        assert_eq!(
            switch_origin("http://localhost:3000/"),
            Some("http://localhost:3000".into())
        );
        assert_eq!(switch_origin("file:///x"), None);
    }
}
