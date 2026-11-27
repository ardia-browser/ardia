use crate::ids::is_own_id;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serializer};
use serde_json::{Map, Value};

pub use ardia_theme::json::{is_integral, js_number, serialize_f64, serialize_option_f64};

pub type Fields = Map<String, Value>;

pub fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let value = Value::deserialize(deserializer)?;
    Ok(T::deserialize(value).unwrap_or_default())
}

pub fn lenient_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    Ok(T::deserialize(value).ok())
}

pub fn millis<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(as_millis(&value).unwrap_or(0))
}

pub fn option_millis<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(as_millis(&value))
}

pub fn as_millis(value: &Value) -> Option<i64> {
    let n = value.as_f64()?;
    if n.is_finite() && n.abs() < 9.0e15 {
        Some(n as i64)
    } else {
        None
    }
}

pub fn true_flag<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    Ok(Value::deserialize(deserializer)? == Value::Bool(true))
}

pub fn is_false(v: &bool) -> bool {
    !*v
}

pub fn serialize_true<S: Serializer>(_: &bool, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_bool(true)
}

pub fn finite_f64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(value.as_f64().filter(|n| n.is_finite()).unwrap_or(0.0))
}

pub fn own_id(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(is_own_id)
}

pub fn string(value: Option<&Value>) -> bool {
    value.is_some_and(Value::is_string)
}

pub fn string_list(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().all(Value::is_string))
}

pub fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

pub fn fields(value: Option<&Value>) -> Option<&Fields> {
    value.and_then(Value::as_object)
}

pub fn take_rows(value: Option<Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(rows)) => rows,
        _ => Vec::new(),
    }
}

pub fn is_size(value: &Value) -> bool {
    value.as_f64().is_some_and(|n| n.is_finite() && n > 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Deserialize, Default)]
    struct Probe {
        #[serde(default, deserialize_with = "lenient")]
        title: String,
        #[serde(default, deserialize_with = "millis")]
        at: i64,
        #[serde(default, deserialize_with = "true_flag")]
        on: bool,
        #[serde(default, deserialize_with = "lenient_option")]
        maybe: Option<u32>,
    }

    #[test]
    fn lenient_fields_fall_back_instead_of_failing_the_row() {
        let probe: Probe = serde_json::from_value(
            json!({"title": 5, "at": 1795614276481.391, "on": "yes", "maybe": -1}),
        )
        .unwrap();
        assert_eq!(probe.title, "");
        assert_eq!(probe.at, 1_795_614_276_481);
        assert!(!probe.on);
        assert_eq!(probe.maybe, None);
        let probe: Probe =
            serde_json::from_value(json!({"title": "x", "at": "soon", "on": true, "maybe": 4}))
                .unwrap();
        assert_eq!(
            (probe.title.as_str(), probe.at, probe.on, probe.maybe),
            ("x", 0, true, Some(4))
        );
        let empty: Probe = serde_json::from_value(json!({})).unwrap();
        assert_eq!(empty.at, 0);
    }

    #[test]
    fn row_checks_mirror_the_shell_decoders() {
        assert!(own_id(Some(&json!("tab-1"))));
        assert!(!own_id(Some(&json!("__proto__"))));
        assert!(!own_id(Some(&json!(1))));
        assert!(string_list(Some(&json!(["a", "b"]))));
        assert!(!string_list(Some(&json!(["a", 1]))));
        assert_eq!(strings(Some(&json!(["a", 1, "b"]))), vec!["a", "b"]);
        assert!(is_size(&json!(0.5)) && !is_size(&json!(0)) && !is_size(&json!("1")));
        assert_eq!(as_millis(&json!(1e300)), None);
    }
}
