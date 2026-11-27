use std::collections::HashSet;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::client::{CaptureOptions, Client};
use crate::consent::Consent;
use crate::sanitize::scrub_text;

pub const MAX_PER_SESSION: usize = 25;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mechanism {
    Panic,
    NativeCrash,
    HelperCrash,
}

impl Mechanism {
    pub fn as_str(self) -> &'static str {
        match self {
            Mechanism::Panic => "onerror",
            Mechanism::NativeCrash => "native_crash",
            Mechanism::HelperCrash => "helper_crash",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub function: String,
    pub module: Option<String>,
    pub in_app: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Exception {
    pub kind: String,
    pub value: String,
    pub frames: Vec<Frame>,
}

static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn identifier(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '<' | '>' | '$'))
        .take(120)
        .collect();
    if cleaned.is_empty() {
        "<unknown>".into()
    } else {
        cleaned
    }
}

pub fn exception_properties(
    entries: &[Exception],
    mechanism: Mechanism,
    handled: bool,
) -> Map<String, Value> {
    let mut raw = Map::new();
    raw.insert(
        "$exception_types".into(),
        json!(
            entries
                .iter()
                .map(|e| identifier(&e.kind))
                .collect::<Vec<_>>()
        ),
    );
    raw.insert(
        "$exception_values".into(),
        json!(
            entries
                .iter()
                .map(|e| scrub_text(&e.value, 200))
                .collect::<Vec<_>>()
        ),
    );
    raw.insert(
        "$exception_list".into(),
        json!(entries.iter().map(|e| json!({
            "type": identifier(&e.kind),
            "value": scrub_text(&e.value, 200),
            "mechanism": { "type": mechanism.as_str(), "handled": handled, "synthetic": false },
            "stacktrace": { "type": "raw", "frames": e.frames.iter().take(64).map(|f| json!({
                "function": identifier(&f.function),
                "module": f.module.as_deref().map(identifier),
                "in_app": f.in_app,
                "platform": "rust",
            })).collect::<Vec<_>>() },
        })).collect::<Vec<_>>()),
    );
    raw
}

pub fn capture_exception(
    client: &Client,
    entries: &[Exception],
    mechanism: Mechanism,
    fatal: bool,
    props: Map<String, Value>,
    consent: Option<&Consent>,
) -> bool {
    let Some(first) = entries.first() else {
        return false;
    };
    let key = format!(
        "{}\u{1}{}\u{1}{}",
        first.kind,
        first.value,
        first
            .frames
            .last()
            .map(|f| f.function.as_str())
            .unwrap_or("")
    );
    {
        let mut seen = SEEN.lock();
        let seen = seen.get_or_insert_with(HashSet::new);
        if seen.contains(&key) || seen.len() >= MAX_PER_SESSION {
            return false;
        }
        seen.insert(key);
    }
    let mut fields = Map::new();
    fields.insert(
        "$exception_level".into(),
        json!(if fatal { "fatal" } else { "error" }),
    );
    fields.insert("source".into(), json!(mechanism.as_str()));
    for (key, value) in props {
        fields.insert(key, value);
    }
    client.capture(
        "$exception",
        &fields,
        consent,
        CaptureOptions {
            urgent: true,
            persist: true,
            raw: Some(exception_properties(entries, mechanism, false)),
            ..CaptureOptions::default()
        },
    )
}

pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(client) = crate::client::client() {
            let message = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| (*s).to_owned())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_default();
            let module = info.location().map(|l| {
                l.file()
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .trim_end_matches(".rs")
                    .to_owned()
            });
            let entry = Exception {
                kind: "panic".into(),
                value: message,
                frames: vec![Frame {
                    function: module.clone().unwrap_or_default(),
                    module,
                    in_app: true,
                }],
            };
            let consent = crate::consent::consent_now();
            capture_exception(
                &client,
                &[entry],
                Mechanism::Panic,
                true,
                Map::new(),
                consent.as_ref(),
            );
            client.persist_now(std::time::Duration::from_millis(500));
        }
        previous(info);
    }));
}
