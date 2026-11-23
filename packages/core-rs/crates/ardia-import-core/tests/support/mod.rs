#![allow(dead_code)]

use std::fs;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

pub const PROFILE_FILES: [&str; 2] = ["Bookmarks", "AccountBookmarks"];

pub fn vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/import-bookmarks-vectors.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

pub fn cases() -> Vec<Value> {
    vectors()["cases"].as_array().unwrap().clone()
}

fn link_text(index: usize) -> String {
    format!("{{\"type\":\"url\",\"name\":\"L{index}\",\"url\":\"https://example.com/{index}\"}}")
}

fn nested_folders(count: usize) -> String {
    let mut head = String::from("{\"roots\":{\"bookmark_bar\":{\"type\":\"folder\",\"children\":[") + &link_text(0);
    let mut tail = String::from("]}}}");
    for index in 1..=count {
        head.push_str(&format!(",{{\"type\":\"folder\",\"name\":\"F{index}\",\"children\":["));
        head.push_str(&link_text(index));
        tail.insert_str(0, "]}");
    }
    head + &tail
}

fn links(count: usize) -> String {
    let body: Vec<String> = (0..count).map(link_text).collect();
    format!(
        "{{\"roots\":{{\"bookmark_bar\":{{\"type\":\"folder\",\"children\":[{}]}}}}}}",
        body.join(",")
    )
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

pub fn materialize(spec: &Value) -> Vec<u8> {
    let mut data = if let Some(value) = spec.get("json") {
        serde_json::to_vec(value).unwrap()
    } else if let Some(text) = spec.get("text") {
        text.as_str().unwrap().as_bytes().to_vec()
    } else if let Some(text) = spec.get("hex") {
        hex(text.as_str().unwrap())
    } else if let Some(count) = spec.get("nestedFolders") {
        nested_folders(count.as_u64().unwrap() as usize).into_bytes()
    } else if let Some(count) = spec.get("links") {
        links(count.as_u64().unwrap() as usize).into_bytes()
    } else {
        panic!("unknown input {spec}");
    };
    let boms = match spec.get("bom") {
        Some(Value::Bool(true)) => 1,
        Some(count) => count.as_u64().unwrap_or(0) as usize,
        None => 0,
    };
    data.splice(0..0, b"\xEF\xBB\xBF".repeat(boms));
    if let Some(size) = spec.get("padTo").and_then(Value::as_u64) {
        let size = size as usize;
        assert!(
            data.len() <= size,
            "input is already {} bytes, over padTo {size}",
            data.len()
        );
        data.resize(size, b' ');
    }
    data
}

pub fn netscape_vectors() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/import-netscape-vectors.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

pub fn netscape_cases() -> Vec<Value> {
    netscape_vectors()["cases"].as_array().unwrap().clone()
}

const NETSCAPE_HEADER: &str = "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n";

fn netscape_link(index: usize) -> String {
    format!(
        "<DT><A HREF=\"https://example.com/{index}\" ADD_DATE=\"{}\">L{index}</A>\n",
        1_700_000_000 + index
    )
}

fn netscape_generated(spec: &Value) -> String {
    let number = |key: &str| spec.get(key).and_then(Value::as_u64).map(|count| count as usize);
    let deep_link = "<DT><A HREF=\"https://deep.example/\">Deep</A>\n";
    if let Some(count) = number("nestedFolders") {
        let mut text = format!("{NETSCAPE_HEADER}<DL><p>\n{}", netscape_link(0));
        for index in 1..=count {
            text.push_str(&format!("<DT><H3>F{index}</H3>\n<DL><p>\n{}", netscape_link(index)));
        }
        text + &"</DL><p>\n".repeat(count + 1)
    } else if let Some(count) = number("nestedLists") {
        format!(
            "{NETSCAPE_HEADER}{}{deep_link}{}",
            "<DL><p>\n".repeat(count),
            "</DL><p>\n".repeat(count)
        )
    } else if let Some(count) = number("unclosedLists") {
        format!("{NETSCAPE_HEADER}{}{deep_link}", "<DL><p>\n".repeat(count))
    } else if let Some(count) = number("links") {
        let inside = number("insideFolders").unwrap_or(0);
        let opened: String = (1..=inside)
            .map(|index| format!("<DT><H3>F{index}</H3>\n<DL><p>\n"))
            .collect();
        let body: String = (0..count).map(netscape_link).collect();
        format!(
            "{NETSCAPE_HEADER}<DL><p>\n{opened}{body}{}",
            "</DL><p>\n".repeat(inside + 1)
        )
    } else {
        panic!("unknown input {spec}");
    }
}

pub fn netscape_file(spec: &Value) -> Vec<u8> {
    let mut data = if let Some(text) = spec.get("text") {
        text.as_str().unwrap().as_bytes().to_vec()
    } else if let Some(text) = spec.get("hex") {
        hex(text.as_str().unwrap())
    } else {
        netscape_generated(spec).into_bytes()
    };
    let boms = spec.get("bom").and_then(Value::as_u64).unwrap_or(0) as usize;
    data.splice(0..0, b"\xEF\xBB\xBF".repeat(boms));
    if let Some(size) = spec.get("padTo").and_then(Value::as_u64) {
        let size = size as usize;
        assert!(
            data.len() <= size,
            "input is already {} bytes, over padTo {size}",
            data.len()
        );
        data.resize(size, b' ');
    }
    data
}

pub fn files(case: &Value) -> [Option<Vec<u8>>; 2] {
    PROFILE_FILES.map(|name| case["files"].get(name).map(materialize))
}

pub fn shape(top: &Value) -> Value {
    let (mut links, mut folders, mut deepest) = (0u64, 0u64, 0u64);
    let mut stack: Vec<(&Value, u64)> = top["children"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|child| (child, 1))
        .collect();
    while let Some((node, depth)) = stack.pop() {
        if node["type"] == "url" {
            links += 1;
            continue;
        }
        folders += 1;
        deepest = deepest.max(depth);
        stack.extend(
            node["children"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|child| (child, depth + 1)),
        );
    }
    json!({ "links": links, "folders": folders, "depth": deepest })
}

pub fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| same(value, other)))
        }
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y)),
        _ => left == right,
    }
}

pub fn unbounded(data: &[u8]) -> Value {
    let mut deserializer = serde_json::Deserializer::from_slice(data);
    deserializer.disable_recursion_limit();
    let value = Value::deserialize(&mut deserializer).unwrap();
    deserializer.end().unwrap();
    value
}

pub fn outcome(result: Result<Value, &str>, expected: &Value) -> Value {
    match result {
        Ok(tree) if expected.get("shape").is_some() => json!({ "shape": shape(&tree) }),
        Ok(tree) => json!({ "ok": tree }),
        Err(code) => json!({ "error": code }),
    }
}
