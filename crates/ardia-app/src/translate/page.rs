use serde_json::Value;

pub const INSTALL: &str = include_str!("page_translator.js");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageOp {
    Sample,
    Holds,
    Start,
    Next,
    Apply,
    Revert,
}

impl PageOp {
    pub fn name(self) -> &'static str {
        match self {
            PageOp::Sample => "sample",
            PageOp::Holds => "holds",
            PageOp::Start => "start",
            PageOp::Next => "next",
            PageOp::Apply => "apply",
            PageOp::Revert => "revert",
        }
    }
}

pub fn translator_call(op: PageOp, args: &[Value]) -> String {
    let args = Value::Array(args.to_vec()).to_string();
    format!(
        "(() => {{\n{INSTALL}\nreturn JSON.stringify(window[Symbol.for(\"ardia.translator\")].{}(...{args}));\n}})()",
        op.name()
    )
}

pub fn op_of(expression: &str) -> Option<PageOp> {
    let at = expression.find(MARKER)?;
    let rest = &expression[at + MARKER.len()..];
    let name = rest.split('(').next()?;
    [
        PageOp::Sample,
        PageOp::Holds,
        PageOp::Start,
        PageOp::Next,
        PageOp::Apply,
        PageOp::Revert,
    ]
    .into_iter()
    .find(|op| op.name() == name)
}

const MARKER: &str = "return JSON.stringify(window[Symbol.for(\"ardia.translator\")].";

pub fn args_of(expression: &str) -> Vec<Value> {
    let Some(marker) = expression.find(MARKER) else {
        return Vec::new();
    };
    let after = &expression[marker..];
    let Some(at) = after.find("(...") else {
        return Vec::new();
    };
    let rest = &after[at + 4..];
    let Some(end) = rest.rfind("));") else {
        return Vec::new();
    };
    serde_json::from_str(&rest[..end]).unwrap_or_default()
}

pub fn page_answer(value: Option<Value>) -> Option<Value> {
    match value? {
        Value::String(text) => serde_json::from_str(&text).ok(),
        Value::Null => None,
        other => Some(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn calls_carry_the_op_and_its_arguments() {
        let call = translator_call(PageOp::Next, &[json!("t-1"), json!(24), json!(60)]);
        assert!(call.contains("const KEY = Symbol.for(\"ardia.translator\")"));
        assert!(call.contains("const MAX_RETRIES = 2;"));
        assert_eq!(op_of(&call), Some(PageOp::Next));
        assert_eq!(args_of(&call), vec![json!("t-1"), json!(24), json!(60)]);
        assert_eq!(page_answer(Some(json!("{\"a\":1}"))), Some(json!({"a": 1})));
        assert_eq!(page_answer(Some(Value::Null)), None);
    }
}
