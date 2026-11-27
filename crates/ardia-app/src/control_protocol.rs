use serde_json::{Map, Value, json};

use crate::ipc::ControlError;

pub const SOCKET_NAME: &str = "ArdiaControl.sock";
pub const PROTOCOL: u64 = 4;
pub const MIN_CLIENT_PROTOCOL: u64 = 4;
pub const MAX_ID_BYTES: usize = 256;
pub const CONTROL_OFF: &str = "Control is off.";
pub const NO_ANSWER_IN_TIME: &str = "Ardia didn't answer in time; the request may still run.";

#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

fn usable_id(id: &Value) -> bool {
    match id {
        Value::String(text) => text.len() <= MAX_ID_BYTES,
        Value::Number(number) => {
            number
                .as_i64()
                .is_some_and(|n| n.unsigned_abs() < (1 << 53))
                || number.as_u64().is_some_and(|n| n < (1 << 53))
        }
        _ => false,
    }
}

pub fn parse_request(line: &[u8]) -> Result<Request, (Value, ControlError)> {
    let Ok(doc) = serde_json::from_slice::<Value>(line) else {
        return Err((
            Value::Null,
            ControlError::new("bad_request", "The line isn't JSON."),
        ));
    };
    let Value::Object(doc) = doc else {
        return Err((
            Value::Null,
            ControlError::new("bad_request", "A request is a JSON object."),
        ));
    };
    let id = doc.get("id").cloned().unwrap_or(Value::Null);
    if !usable_id(&id) {
        return Err((
            Value::Null,
            ControlError::new(
                "bad_request",
                format!(
                    "A request needs an id: a safe integer, or a well-formed string of at most {MAX_ID_BYTES} UTF-8 bytes."
                ),
            ),
        ));
    }
    let Some(method) = doc.get("method").and_then(Value::as_str) else {
        return Err((
            id,
            ControlError::new("bad_request", "A request needs a method."),
        ));
    };
    let params = match doc.get("params") {
        None => Value::Object(Map::new()),
        Some(params @ Value::Object(_)) => params.clone(),
        Some(_) => {
            return Err((
                id,
                ControlError::new("bad_request", "params must be an object."),
            ));
        }
    };
    Ok(Request {
        id,
        method: method.to_owned(),
        params,
    })
}

pub fn hello(version: &str) -> Value {
    json!({
        "app": "Ardia",
        "version": version,
        "protocol": PROTOCOL,
        "minClientProtocol": MIN_CLIENT_PROTOCOL,
    })
}

pub fn client_protocol_problem(params: &Value, version: &str) -> Option<ControlError> {
    let asked = match params.get("protocol") {
        None | Some(Value::Null) => return None,
        Some(asked) => asked.as_u64().filter(|n| *n >= 1 && *n < (1 << 53)),
    };
    let Some(asked) = asked else {
        return Some(ControlError::new(
            "bad_request",
            "protocol must be a whole number.",
        ));
    };
    (asked < MIN_CLIENT_PROTOCOL).then(|| {
        ControlError::new(
            "unsupported_protocol",
            format!(
                "This ardia command speaks control protocol {asked}, and Ardia {version} needs {MIN_CLIENT_PROTOCOL} or later: update the command (Settings › Plugins, or its install.sh)."
            ),
        )
    })
}

pub fn unknown_method(method: &str) -> ControlError {
    ControlError::new("unknown_method", format!("There's no method {method}."))
}

pub struct MethodSpec {
    pub name: &'static str,
    pub area: &'static str,
    pub mutates: bool,
    pub description: &'static str,
    pub params: fn() -> Value,
    pub result: &'static str,
}

fn none() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

fn tab_only() -> Value {
    json!({ "type": "object", "properties": { "tab": { "type": "string" } }, "required": ["tab"], "additionalProperties": false })
}

pub const CATALOG: &[MethodSpec] = &[
    MethodSpec {
        name: "hello",
        area: "control",
        mutates: false,
        description: "Say which control protocol the client speaks and who it is; answers Ardia's version and protocol.",
        params: || {
            json!({ "type": "object", "properties": {
                "protocol": { "type": "integer", "minimum": 1 },
                "caller": { "type": "object", "properties": { "name": { "type": "string" }, "app": { "type": "string" } } }
            }, "additionalProperties": false })
        },
        result: "{ app, version, protocol, minClientProtocol }",
    },
    MethodSpec {
        name: "caller",
        area: "control",
        mutates: false,
        description: "Show this connection's caller in the control pill.",
        params: none,
        result: "{ ok }",
    },
    MethodSpec {
        name: "methods",
        area: "control",
        mutates: false,
        description: "Every method this Ardia answers, with its params and result.",
        params: none,
        result: "[{ name, area, mutates, description, params, result }]",
    },
    MethodSpec {
        name: "run",
        area: "commands",
        mutates: true,
        description: "Run a menu command by id, as the menu does.",
        params: || {
            json!({ "type": "object", "properties": {
                "command": { "type": "string" }, "arg": { "type": "string" }
            }, "required": ["command"], "additionalProperties": false })
        },
        result: "{ ok }",
    },
    MethodSpec {
        name: "status",
        area: "app",
        mutates: false,
        description: "The app's version, engine and window and tab counts.",
        params: none,
        result: "{ version, engine, started, shuttingDown, windows, tabs, liveTabs, profiles, focusedWindow, activeTab }",
    },
    MethodSpec {
        name: "open_url",
        area: "tabs",
        mutates: true,
        description: "Open a link as if another app had opened it.",
        params: || json!({ "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"], "additionalProperties": false }),
        result: "{ opened }",
    },
    MethodSpec {
        name: "new_tab",
        area: "tabs",
        mutates: true,
        description: "Open a new tab in a window.",
        params: || {
            json!({ "type": "object", "properties": {
                "window": { "type": "string" }, "url": { "type": "string" }, "background": { "type": "boolean" }
            }, "additionalProperties": false })
        },
        result: "{ tab, window }",
    },
    MethodSpec {
        name: "list_tabs",
        area: "tabs",
        mutates: false,
        description: "Every tab in the regular windows.",
        params: none,
        result: "[{ id, window, profile, url, title, active, pinned, loading, canGoBack, live }]",
    },
    MethodSpec {
        name: "navigate",
        area: "tabs",
        mutates: true,
        description: "Load a URL or search in a tab.",
        params: || {
            json!({ "type": "object", "properties": {
                "tab": { "type": "string" }, "url": { "type": "string" }
            }, "required": ["tab", "url"], "additionalProperties": false })
        },
        result: "{ tab }",
    },
    MethodSpec {
        name: "activate_tab",
        area: "tabs",
        mutates: true,
        description: "Switch to a tab.",
        params: tab_only,
        result: "{ tab }",
    },
    MethodSpec {
        name: "close_tab",
        area: "tabs",
        mutates: true,
        description: "Close a tab.",
        params: tab_only,
        result: "{ closed } or { tab, closed: false, asking: true }",
    },
    MethodSpec {
        name: "eval_command",
        area: "commands",
        mutates: true,
        description: "Run a menu command by id and say whether the app or the UI ran it.",
        params: || {
            json!({ "type": "object", "properties": {
                "command": { "type": "string" }, "arg": { "type": "string" }
            }, "required": ["command"], "additionalProperties": false })
        },
        result: "{ ran, by }",
    },
    MethodSpec {
        name: "input",
        area: "test",
        mutates: true,
        description: "Send synthetic mouse and key input to a window (only with ARDIA_TEST_INPUT=1).",
        params: || json!({ "type": "object" }),
        result: "{ queued, window }",
    },
    MethodSpec {
        name: "profile",
        area: "app",
        mutates: false,
        description: "Read the built-in profiler: span, frame and main-thread timings with p50/p90/p99, recent hangs with what was running, and the slowest actions.",
        params: none,
        result: "{ enabled, mode, spans: { <name>: { count, mean_ms, p50_ms, p90_ms, p99_ms, max_ms, total_ms } }, frames: { main|settings|onboarding|little: { frames, late, dropped, layout, prepaint, paint, frame, input_to_frame } }, main_thread, hangs, actions, trace, memory_bytes }",
    },
    MethodSpec {
        name: "quit",
        area: "app",
        mutates: true,
        description: "Quit Ardia.",
        params: none,
        result: "{ quitting }",
    },
];

pub fn catalog() -> Value {
    Value::Array(
        CATALOG
            .iter()
            .map(|spec| {
                json!({
                    "name": spec.name,
                    "area": spec.area,
                    "mutates": spec.mutates,
                    "description": spec.description,
                    "params": (spec.params)(),
                    "result": spec.result,
                })
            })
            .collect(),
    )
}

pub fn is_method(name: &str) -> bool {
    CATALOG.iter().any(|spec| spec.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(line: &str) -> (Value, ControlError) {
        parse_request(line.as_bytes()).expect_err("refused")
    }

    #[test]
    fn requests_are_checked_like_the_old_socket() {
        assert_eq!(refused("{nope").1.message, "The line isn't JSON.");
        assert_eq!(refused("[1]").1.message, "A request is a JSON object.");
        let (id, error) = refused(r#"{"method":"status"}"#);
        assert_eq!(id, Value::Null);
        assert_eq!(error.code, "bad_request");
        assert!(error.message.starts_with("A request needs an id"));
        assert_eq!(refused(r#"{"id":1.5,"method":"status"}"#).0, Value::Null);
        assert_eq!(
            refused(r#"{"id":9007199254740992,"method":"status"}"#).0,
            Value::Null
        );
        let long = "x".repeat(MAX_ID_BYTES + 1);
        assert_eq!(
            refused(&json!({"id": long, "method": "status"}).to_string()).0,
            Value::Null
        );
        let (id, error) = refused(r#"{"id":"a","params":{}}"#);
        assert_eq!(id, json!("a"));
        assert_eq!(error.message, "A request needs a method.");
        assert_eq!(
            refused(r#"{"id":2,"method":"status","params":[1]}"#)
                .1
                .message,
            "params must be an object."
        );
        let ok = parse_request(br#"{"id":9007199254740991,"method":"status"}"#).expect("ok");
        assert_eq!(ok.params, json!({}));
    }

    #[test]
    fn hello_speaks_protocol_4() {
        assert_eq!(
            hello("1.0"),
            json!({"app": "Ardia", "version": "1.0", "protocol": 4, "minClientProtocol": 4})
        );
        assert!(client_protocol_problem(&json!({}), "1.0").is_none());
        assert!(client_protocol_problem(&json!({"protocol": 4}), "1.0").is_none());
        assert!(client_protocol_problem(&json!({"protocol": 9}), "1.0").is_none());
        let old = client_protocol_problem(&json!({"protocol": 3}), "1.0").expect("too old");
        assert_eq!(old.code, "unsupported_protocol");
        assert_eq!(
            old.message,
            "This ardia command speaks control protocol 3, and Ardia 1.0 needs 4 or later: update the command (Settings › Plugins, or its install.sh)."
        );
        assert_eq!(
            client_protocol_problem(&json!({"protocol": "4"}), "1.0")
                .expect("bad")
                .code,
            "bad_request"
        );
        assert_eq!(
            unknown_method("teleport").message,
            "There's no method teleport."
        );
    }

    #[test]
    fn the_catalog_lists_every_method_with_a_schema() {
        let listed = catalog();
        let names: Vec<&str> = listed
            .as_array()
            .expect("list")
            .iter()
            .filter_map(|m| m["name"].as_str())
            .collect();
        for name in [
            "hello", "caller", "methods", "run", "status", "input", "open_url", "profile",
        ] {
            assert!(names.contains(&name), "{name} is listed");
        }
        assert!(
            listed
                .as_array()
                .expect("list")
                .iter()
                .all(|m| m["params"]["type"] == "object" && m["mutates"].is_boolean())
        );
    }
}
