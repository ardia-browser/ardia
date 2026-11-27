use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::ids::{now_ms, parse_iso};

pub const EVENTS_SCOPE: &str = "ardia.analytics";
pub const LOGS_SCOPE: &str = "ardia.app";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueuedEvent {
    pub uuid: String,
    pub event: String,
    pub distinct_id: String,
    pub timestamp: String,
    pub properties: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    pub time_unix_nano: String,
    pub severity_number: u32,
    pub severity_text: String,
    pub body: Value,
    pub attributes: Vec<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Warn,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Sent,
    Drop,
    Split,
    Retry,
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn otlp_value(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => Some(json!({ "stringValue": text })),
        Value::Bool(flag) => Some(json!({ "boolValue": flag })),
        Value::Number(number) => {
            let float = number.as_f64()?;
            if !float.is_finite() {
                return None;
            }
            if float.fract() == 0.0 && float.abs() <= MAX_SAFE_INTEGER {
                let whole = number
                    .as_i64()
                    .map(|n| n.to_string())
                    .or_else(|| number.as_u64().map(|n| n.to_string()))
                    .unwrap_or_else(|| format!("{}", float as i64));
                Some(json!({ "intValue": whole }))
            } else {
                Some(json!({ "doubleValue": float }))
            }
        }
        Value::Null => None,
        Value::Array(_) | Value::Object(_) => Some(json!({ "stringValue": value.to_string() })),
    }
}

pub fn otlp_attributes(values: &Map<String, Value>) -> Vec<Value> {
    values
        .iter()
        .filter_map(|(key, value)| {
            otlp_value(value).map(|value| json!({ "key": key, "value": value }))
        })
        .collect()
}

fn nanos(ms: i64) -> String {
    format!("{ms}000000")
}

pub fn event_record(event: &QueuedEvent) -> LogRecord {
    let ms = parse_iso(&event.timestamp).unwrap_or_else(now_ms);
    let mut attributes = Map::new();
    attributes.insert("event".into(), Value::String(event.event.clone()));
    attributes.insert("uuid".into(), Value::String(event.uuid.clone()));
    attributes.insert(
        "distinct_id".into(),
        Value::String(event.distinct_id.clone()),
    );
    for (key, value) in &event.properties {
        attributes.insert(key.clone(), value.clone());
    }
    LogRecord {
        time_unix_nano: nanos(ms),
        severity_number: 9,
        severity_text: "INFO".into(),
        body: json!({ "stringValue": event.event }),
        attributes: otlp_attributes(&attributes),
    }
}

pub fn log_record(
    level: Level,
    message: &str,
    attributes: &Map<String, Value>,
    at: i64,
) -> LogRecord {
    let error = level == Level::Error;
    LogRecord {
        time_unix_nano: nanos(at),
        severity_number: if error { 17 } else { 13 },
        severity_text: if error { "ERROR" } else { "WARN" }.into(),
        body: json!({ "stringValue": message }),
        attributes: otlp_attributes(attributes),
    }
}

pub fn logs_request(resource: &Map<String, Value>, scope: &str, records: &[LogRecord]) -> String {
    json!({
        "resourceLogs": [{
            "resource": { "attributes": otlp_attributes(resource) },
            "scopeLogs": [{ "scope": { "name": scope }, "logRecords": records }],
        }]
    })
    .to_string()
}

pub fn outcome(status: u16, count: usize) -> Outcome {
    match status {
        200..=299 => Outcome::Sent,
        400 => Outcome::Drop,
        413 if count > 1 => Outcome::Split,
        413 => Outcome::Drop,
        _ => Outcome::Retry,
    }
}

pub fn is_event(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    ["uuid", "event", "distinct_id", "timestamp"]
        .iter()
        .all(|key| fields.get(*key).is_some_and(Value::is_string))
        && fields.get("properties").is_some_and(Value::is_object)
}

pub fn is_log(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    fields.get("timeUnixNano").is_some_and(Value::is_string)
        && fields.get("body").is_some_and(Value::is_object)
        && fields.get("attributes").is_some_and(Value::is_array)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_encode_like_the_old_wire() {
        let mut props = Map::new();
        props.insert("s".into(), json!("x"));
        props.insert("b".into(), json!(true));
        props.insert("i".into(), json!(3));
        props.insert("w".into(), json!(3.0));
        props.insert("f".into(), json!(1.5));
        props.insert("n".into(), Value::Null);
        props.insert("o".into(), json!({ "a": 1 }));
        let encoded = Value::Array(otlp_attributes(&props)).to_string();
        assert_eq!(
            encoded,
            r#"[{"key":"s","value":{"stringValue":"x"}},{"key":"b","value":{"boolValue":true}},{"key":"i","value":{"intValue":"3"}},{"key":"w","value":{"intValue":"3"}},{"key":"f","value":{"doubleValue":1.5}},{"key":"o","value":{"stringValue":"{\"a\":1}"}}]"#
        );
    }

    #[test]
    fn an_event_becomes_one_info_record() {
        let event = QueuedEvent {
            uuid: "u".into(),
            event: "usage_counts".into(),
            distinct_id: "d".into(),
            timestamp: "2026-11-24T12:44:55.184Z".into(),
            properties: Map::from_iter([("tabs_opened".to_owned(), json!(2))]),
        };
        let record = serde_json::to_value(event_record(&event)).expect("record");
        assert_eq!(record["timeUnixNano"], "1795524295184000000");
        assert_eq!(record["severityNumber"], 9);
        assert_eq!(record["body"]["stringValue"], "usage_counts");
        assert_eq!(record["attributes"][0]["key"], "event");
        assert_eq!(record["attributes"][3]["key"], "tabs_opened");
        let body = logs_request(&Map::new(), EVENTS_SCOPE, &[event_record(&event)]);
        let parsed: Value = serde_json::from_str(&body).expect("json");
        assert_eq!(
            parsed["resourceLogs"][0]["scopeLogs"][0]["scope"]["name"],
            "ardia.analytics"
        );
        assert!(is_event(&serde_json::to_value(&event).expect("event")));
    }

    #[test]
    fn statuses_map_to_outcomes() {
        assert_eq!(outcome(204, 3), Outcome::Sent);
        assert_eq!(outcome(400, 3), Outcome::Drop);
        assert_eq!(outcome(413, 3), Outcome::Split);
        assert_eq!(outcome(413, 1), Outcome::Drop);
        assert_eq!(outcome(0, 1), Outcome::Retry);
        assert_eq!(outcome(503, 1), Outcome::Retry);
        let warn = log_record(Level::Warn, "m", &Map::new(), 5);
        assert_eq!(
            (warn.severity_number, warn.severity_text.as_str()),
            (13, "WARN")
        );
    }
}
