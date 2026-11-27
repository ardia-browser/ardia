use serde_json::{Map, Value};
use std::cmp::Ordering;

pub fn utf16_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

pub fn js_json(value: &Value) -> String {
    let mut out = String::new();
    write_js(value, &mut out);
    out
}

fn write_number(n: &serde_json::Number, out: &mut String) {
    if n.is_i64() || n.is_u64() {
        out.push_str(&n.to_string());
        return;
    }
    let Some(f) = n.as_f64() else {
        out.push_str("null");
        return;
    };
    if !f.is_finite() {
        out.push_str("null");
    } else if f.fract() == 0.0 && f.abs() < 1e21 {
        out.push_str(&format!("{f:.0}"));
    } else {
        let text =
            serde_json::Number::from_f64(f).map_or_else(|| "null".to_owned(), |n| n.to_string());
        if let Some((mantissa, exponent)) = text.split_once('e') {
            out.push_str(mantissa.strip_suffix(".0").unwrap_or(mantissa));
            out.push('e');
            if !exponent.starts_with('-') && !exponent.starts_with('+') {
                out.push('+');
            }
            out.push_str(exponent);
        } else {
            out.push_str(&text);
        }
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned()));
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| utf16_order(a, b));
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_canonical(&map[key.as_str()], out);
            }
            out.push('}');
        }
        Value::Array(list) => write_list(list, out, write_canonical),
        other => write_scalar(other, out),
    }
}

fn write_list(list: &[Value], out: &mut String, item: fn(&Value, &mut String)) {
    out.push('[');
    for (i, entry) in list.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        item(entry, out);
    }
    out.push(']');
}

fn write_scalar(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(n, out),
        Value::String(s) => write_string(s, out),
        Value::Array(list) => write_list(list, out, write_js),
        Value::Object(map) => write_object(map, out),
    }
}

fn write_object(map: &Map<String, Value>, out: &mut String) {
    out.push('{');
    for (i, (key, entry)) in map.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_string(key, out);
        out.push(':');
        write_js(entry, out);
    }
    out.push('}');
}

fn write_js(value: &Value, out: &mut String) {
    write_scalar(value, out);
}

pub fn utf16_len(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_sorts_keys_like_the_old_merge() {
        let value =
            json!({"b": 1, "a": {"z": [3, {"y": true, "x": null}], "c": "é"}, "10": 2, "2": 1.5});
        assert_eq!(
            canonical(&value),
            r#"{"10":2,"2":1.5,"a":{"c":"é","z":[3,{"x":null,"y":true}]},"b":1}"#
        );
        assert_eq!(canonical(&json!(1e21)), "1e+21");
        assert_eq!(canonical(&json!(2.0)), "2");
        assert_eq!(canonical(&json!(1.0e-7)), "1e-7");
        assert_eq!(js_json(&json!({"b": 1, "a": 2})), r#"{"b":1,"a":2}"#);
        assert_eq!(utf16_order("\u{FFFF}", "\u{10000}"), Ordering::Greater);
    }
}
