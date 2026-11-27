use serde::Deserialize;
use serde_json::Value;

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

pub(crate) fn parse(bytes: &[u8], max_depth: usize) -> Option<Value> {
    let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
    if !nesting_within(body, max_depth) {
        return None;
    }
    let mut deserializer = serde_json::Deserializer::from_slice(body);
    deserializer.disable_recursion_limit();
    let value = Value::deserialize(&mut deserializer).ok()?;
    deserializer.end().ok()?;
    Some(value)
}

pub(crate) fn nesting_within(bytes: &[u8], max_depth: usize) -> bool {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for &byte in bytes {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                if depth > max_depth {
                    return false;
                }
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nested(depth: usize) -> Vec<u8> {
        let mut text = "[".repeat(depth);
        text.push_str(&"]".repeat(depth));
        text.into_bytes()
    }

    #[test]
    fn the_depth_cap_allows_exactly_max_depth_containers() {
        assert!(parse(&nested(200), 200).is_some());
        assert!(parse(&nested(201), 200).is_none());
        assert!(parse(&nested(400), 400).is_some());
    }

    #[test]
    fn brackets_inside_strings_do_not_count() {
        let text = format!("[\"{}\\\"{}\"]", "[".repeat(500), "{".repeat(500));
        assert!(parse(text.as_bytes(), 2).is_some());
    }

    #[test]
    fn one_leading_bom_is_skipped() {
        assert!(parse(b"\xEF\xBB\xBF{}", 1).is_some());
        assert!(parse(b"\xEF\xBB\xBF\xEF\xBB\xBF{}", 1).is_none());
        assert!(parse(b" \xEF\xBB\xBF{}", 1).is_none());
    }

    #[test]
    fn only_rfc_json_is_accepted() {
        for text in [
            &b""[..],
            b"{} x",
            b"{\"a\":1,}",
            b"{} // c",
            b"{\"a\":1e400}",
            b"{\"a\":\"\\ud800\"}",
            b"{\"a\":\"\xff\"}",
            b"{'a':1}",
        ] {
            assert!(parse(text, 200).is_none(), "{}", String::from_utf8_lossy(text));
        }
        assert!(parse(b" {\"a\":[1,2.5,-3e2,true,null]} \n", 200).is_some());
    }
}
