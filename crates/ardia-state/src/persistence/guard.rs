use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_bytes: usize,
    pub max_depth: usize,
}

impl Limits {
    pub const SESSION: Limits = Limits {
        max_bytes: 64 * 1024 * 1024,
        max_depth: 64,
    };
    pub const DOCUMENT: Limits = Limits {
        max_bytes: 16 * 1024 * 1024,
        max_depth: 64,
    };
    pub const CONFIG: Limits = Limits {
        max_bytes: 4 * 1024 * 1024,
        max_depth: 32,
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum JsonProblem {
    Empty,
    TooLarge,
    TooDeep,
    NotUtf8,
    Invalid,
}

impl JsonProblem {
    pub const fn code(self) -> &'static str {
        match self {
            JsonProblem::Empty => "empty",
            JsonProblem::TooLarge => "tooLarge",
            JsonProblem::TooDeep => "tooDeep",
            JsonProblem::NotUtf8 => "notUtf8",
            JsonProblem::Invalid => "invalid",
        }
    }
}

fn depth_within(bytes: &[u8], max_depth: usize) -> bool {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for &b in bytes {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
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

pub fn parse(bytes: &[u8], limits: Limits) -> Result<Value, JsonProblem> {
    if bytes.len() > limits.max_bytes {
        return Err(JsonProblem::TooLarge);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| JsonProblem::NotUtf8)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.trim().is_empty() {
        return Err(JsonProblem::Empty);
    }
    if !depth_within(text.as_bytes(), limits.max_depth) {
        return Err(JsonProblem::TooDeep);
    }
    serde_json::from_str(text).map_err(|_| JsonProblem::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn hostile_documents_are_refused_before_parsing() {
        let deep = "[".repeat(100_000);
        assert_eq!(
            parse(deep.as_bytes(), Limits::SESSION),
            Err(JsonProblem::TooDeep)
        );
        assert_eq!(parse(b"", Limits::SESSION), Err(JsonProblem::Empty));
        assert_eq!(parse(b"   \n", Limits::SESSION), Err(JsonProblem::Empty));
        assert_eq!(
            parse(&[0xff, 0xfe, b'{'], Limits::SESSION),
            Err(JsonProblem::NotUtf8)
        );
        assert_eq!(
            parse(b"{\"a\":", Limits::SESSION),
            Err(JsonProblem::Invalid)
        );
        assert_eq!(
            parse(
                &[b' '; 100],
                Limits {
                    max_bytes: 10,
                    max_depth: 4
                }
            ),
            Err(JsonProblem::TooLarge)
        );
        assert_eq!(
            parse(b"\xef\xbb\xbf{\"version\":11}", Limits::SESSION).unwrap()["version"],
            11
        );
    }

    #[test]
    fn brackets_inside_strings_do_not_count_as_depth() {
        let text = format!(
            "{{\"title\":\"{}\\\"{}\"}}",
            "[".repeat(500),
            "{".repeat(500)
        );
        assert!(parse(text.as_bytes(), Limits::SESSION).is_ok());
        let nested = format!("{}{}", "[".repeat(64), "]".repeat(64));
        assert!(parse(nested.as_bytes(), Limits::SESSION).is_ok());
        let over = format!("{}{}", "[".repeat(65), "]".repeat(65));
        assert_eq!(
            parse(over.as_bytes(), Limits::SESSION),
            Err(JsonProblem::TooDeep)
        );
    }

    proptest! {
        #[test]
        fn arbitrary_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..512)) {
            let _ = parse(&bytes, Limits::DOCUMENT);
        }
    }
}
