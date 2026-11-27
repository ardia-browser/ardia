use std::collections::HashSet;

use ardia_state::shared_folders::{
    BaseEntry, FolderOp, LocalEntry, RemoteEntry, RemoteLevel, TargetEntry, TargetLevel,
    clean_base, merge_folder, plan_files, webloc_text,
};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/shared-folders-ts.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn local(list: &Value) -> Vec<LocalEntry> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|e| match e["kind"].as_str() {
            Some("dir") => LocalEntry::Dir {
                key: text(e, "key"),
                name: text(e, "name"),
                children: local(&e["children"]),
            },
            _ => LocalEntry::Link {
                key: text(e, "key"),
                name: text(e, "name"),
                url: text(e, "url"),
            },
        })
        .collect()
}

fn remote(level: &Value) -> RemoteLevel {
    RemoteLevel {
        entries: level["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| match e["kind"].as_str() {
                Some("dir") => RemoteEntry::Dir {
                    file: text(e, "file"),
                    level: remote(&e["level"]),
                },
                Some("held") => RemoteEntry::Held {
                    file: text(e, "file"),
                    waiting: e["waiting"].as_bool().unwrap_or(false),
                },
                _ => RemoteEntry::Link {
                    file: text(e, "file"),
                    url: text(e, "url"),
                    id: e.get("id").and_then(Value::as_str).map(str::to_owned),
                },
            })
            .collect(),
        manifest: level["manifest"].as_array().map(|m| {
            m.iter()
                .filter_map(|f| f.as_str().map(str::to_owned))
                .collect()
        }),
        manifest_pending: level["manifestPending"].as_bool().unwrap_or(false),
    }
}

fn assign_keys(level: &mut TargetLevel, n: &mut usize) {
    for e in &mut level.entries {
        match e {
            TargetEntry::Link(l) => {
                if l.key.is_none() {
                    *n += 1;
                    l.key = Some(format!("new{n}"));
                }
            }
            TargetEntry::Dir(d) => {
                if d.key.is_none() {
                    *n += 1;
                    d.key = Some(format!("new{n}"));
                }
                assign_keys(&mut d.level, n);
            }
        }
    }
}

fn op_value(op: &FolderOp) -> Value {
    match op {
        FolderOp::Write {
            path,
            text,
            create,
            expect,
        } => json!({"op": "write", "path": path, "text": text, "create": create, "expect": expect}),
        FolderOp::Move { path, to } => json!({"op": "move", "path": path, "to": to}),
        FolderOp::Delete { path, expect } => {
            json!({"op": "delete", "path": path, "expect": expect})
        }
        FolderOp::Mkdir { path } => json!({"op": "mkdir", "path": path}),
        FolderOp::Rmdir { path } => json!({"op": "rmdir", "path": path}),
    }
}

fn known_ids(input: &Value, into: &mut HashSet<String>) {
    match input {
        Value::Object(map) => {
            for (k, v) in map {
                if k == "id"
                    && let Some(id) = v.as_str()
                {
                    into.insert(id.to_owned());
                }
                known_ids(v, into);
            }
        }
        Value::Array(list) => list.iter().for_each(|v| known_ids(v, into)),
        _ => {}
    }
}

fn normalize(value: &mut Value, known: &HashSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(id)) = map.get_mut("id")
                && !known.contains(id.as_str())
            {
                *id = "<new>".into();
            }
            if let Some(Value::String(text)) = map.get_mut("text")
                && let Some(start) = text.find("<key>ArdiaLink</key>\n\t<string>")
            {
                let from = start + "<key>ArdiaLink</key>\n\t<string>".len();
                if let Some(len) = text[from..].find("</string>") {
                    let id = text[from..from + len].to_owned();
                    if !known.contains(&id) {
                        text.replace_range(from..from + len, "<new>");
                    }
                }
            }
            map.values_mut().for_each(|v| normalize(v, known));
        }
        Value::Array(list) => list.iter_mut().for_each(|v| normalize(v, known)),
        _ => {}
    }
}

#[test]
fn the_rust_merge_plans_the_same_files_as_the_old_typescript_merge() {
    let fixture = fixture();
    assert_eq!(
        webloc_text("https://a.example/?x=1&y=<2>", Some("abc")),
        fixture["webloc"].as_str().unwrap()
    );
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 200);
    let mut failures = Vec::new();
    let mut ops_seen = 0;
    let mut kinds: HashSet<String> = HashSet::new();
    for (i, case) in cases.iter().enumerate() {
        let input = &case["input"];
        let base: Vec<BaseEntry> = clean_base(input["base"].as_array().unwrap());
        let merged = merge_folder(&base, &local(&input["local"]), &remote(&input["remote"]));
        let mut level = merged.level;
        assign_keys(&mut level, &mut 0);
        let planned = plan_files(&level, &base, 1_795_000_000_000);
        let mut known = HashSet::new();
        known_ids(input, &mut known);
        let mut ours = json!({
            "waiting": merged.waiting,
            "ops": planned.ops.iter().map(op_value).collect::<Vec<_>>(),
            "base": serde_json::to_value(&planned.base).unwrap(),
        });
        ops_seen += planned.ops.len();
        for op in &planned.ops {
            kinds.insert(op_value(op)["op"].as_str().unwrap_or_default().to_owned());
        }
        let mut theirs = case["output"].clone();
        normalize(&mut ours, &known);
        normalize(&mut theirs, &known);
        if ours != theirs {
            failures.push((i, ours, theirs));
        }
    }
    assert!(ops_seen > cases.len(), "{ops_seen} ops");
    assert_eq!(kinds.len(), 5, "{kinds:?}");
    if let Some((i, ours, theirs)) = failures.first() {
        panic!(
            "{} of {} cases differ; first is case {i}\nrust: {ours}\nts:   {theirs}",
            failures.len(),
            cases.len()
        );
    }
}
