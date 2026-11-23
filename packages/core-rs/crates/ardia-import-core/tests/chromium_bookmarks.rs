mod support;

use ardia_import_core::{
    chromium_bookmarks, chromium_bookmarks_with, from_webkit, BookmarkNode, ImportError, Limits, NodeType, ProfileFile,
    MAX_FOLDER_DEPTH, MAX_INPUT_BYTES, MAX_JSON_DEPTH, MAX_NODES,
};
use serde_json::{json, Value};

fn file(data: &Option<Vec<u8>>) -> ProfileFile<'_> {
    data.as_deref().map_or(ProfileFile::Missing, ProfileFile::Bytes)
}

fn parse(bookmarks: &str) -> Result<BookmarkNode, ImportError> {
    chromium_bookmarks(ProfileFile::Bytes(bookmarks.as_bytes()), ProfileFile::Missing)
}

fn tree(node: &BookmarkNode) -> Value {
    support::unbounded(&node.to_json())
}

#[test]
fn the_vector_limits_are_the_crate_limits() {
    let limits = &support::vectors()["limits"];
    assert_eq!(limits["maxInputBytes"], MAX_INPUT_BYTES);
    assert_eq!(limits["maxFolderDepth"], MAX_FOLDER_DEPTH);
    assert_eq!(limits["maxNodes"], MAX_NODES);
    assert_eq!(limits["maxJsonDepth"], MAX_JSON_DEPTH);
}

#[test]
fn every_shared_vector_gives_the_expected_answer() {
    let cases = support::cases();
    assert!(cases.len() >= 40, "{} cases", cases.len());
    for case in cases {
        let [local, account] = support::files(&case);
        let result = chromium_bookmarks(file(&local), file(&account));
        let expected = &case["expect"];
        let got = support::outcome(result.as_ref().map(tree).map_err(|error| error.code()), expected);
        assert!(
            support::same(&got, expected),
            "{}: got {got}, expected {expected}",
            case["name"]
        );
        if let Ok(node) = result {
            assert_eq!(
                node.link_count() as u64,
                support::shape(&tree(&node))["links"].as_u64().unwrap()
            );
        }
    }
}

#[test]
fn the_output_uses_the_import_result_field_names() {
    let node = parse(
        r#"{"roots":{"bookmark_bar":{"type":"folder","date_added":"13300000000000000","children":[
            {"type":"url","name":"A","url":"https://a.example/","date_added":"13300000000000000"}]}}}"#,
    )
    .unwrap();
    assert_eq!(
        String::from_utf8(node.to_json()).unwrap(),
        concat!(
            r#"{"type":"folder","title":"Bookmarks","children":[{"type":"folder","title":"Bookmarks Bar","#,
            r#""dateAdded":1655526400000.0,"children":[{"type":"url","title":"A","url":"https://a.example/","#,
            r#""dateAdded":1655526400000.0}],"role":"toolbar"}]}"#
        )
    );
    assert_eq!(node.node_type, NodeType::Folder);
}

#[test]
fn webkit_dates_follow_swift_parsing_and_linux_range() {
    assert_eq!(from_webkit("13300000000000000"), Some(1_655_526_400_000.0));
    assert_eq!(from_webkit("+13300000000000000"), Some(1_655_526_400_000.0));
    assert_eq!(from_webkit("11644473600000001"), Some(0.001));
    for text in [
        "11644473600000000",
        "5",
        "0",
        "-5",
        " 13300000000000000",
        "13300000000000000 ",
        "1e16",
        "0x10",
        "",
        "+",
        "9223372036854775808",
    ] {
        assert_eq!(from_webkit(text), None, "{text:?}");
    }
    assert_eq!(
        from_webkit("9223372036854775807"),
        Some((i64::MAX - 11_644_473_600_000_000) as f64 / 1000.0)
    );
}

fn node_count(node: &Value) -> usize {
    node["children"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|child| 1 + node_count(child))
        .sum()
}

#[test]
fn the_node_budget_reserves_each_node_before_its_children() {
    let limits = Limits {
        max_nodes: 3,
        ..Limits::default()
    };
    let text = r#"{"roots":{"bookmark_bar":{"type":"folder","children":[
        {"type":"folder","name":"F","children":[
            {"type":"url","url":"https://1/"},{"type":"url","url":"https://2/"},{"type":"url","url":"https://3/"}]},
        {"type":"url","url":"https://4/"}]},
        "other":{"type":"folder","children":[{"type":"url","url":"https://5/"}]}}}"#;
    let node = chromium_bookmarks_with(ProfileFile::Bytes(text.as_bytes()), ProfileFile::Missing, &limits).unwrap();
    assert_eq!(
        tree(&node),
        json!({"type":"folder","title":"Bookmarks","children":[{"type":"folder","title":"Bookmarks Bar","role":"toolbar",
            "children":[{"type":"folder","title":"F","children":[{"type":"url","title":"","url":"https://1/"}]}]}]})
    );
}

#[test]
fn the_node_budget_is_a_hard_ceiling_under_nested_folders() {
    let mut text = String::from(r#"{"roots":{"bookmark_bar":{"type":"folder","children":["#);
    let mut tail = String::from("]}}}");
    for level in 0..10 {
        for link in 0..5 {
            text.push_str(&format!(r#"{{"type":"url","url":"https://{level}/{link}"}},"#));
        }
        text.push_str(r#"{"type":"folder","children":["#);
        tail.insert_str(0, "]}");
    }
    text.push_str(r#"{"type":"url","url":"https://deepest/"}"#);
    text.push_str(&tail);
    for max_nodes in [2, 5, 6, 7, 13, 30, 60, 61, 62, 63, 100] {
        let limits = Limits {
            max_nodes,
            ..Limits::default()
        };
        let node = chromium_bookmarks_with(ProfileFile::Bytes(text.as_bytes()), ProfileFile::Missing, &limits).unwrap();
        let count = node_count(&tree(&node));
        assert_eq!(count, max_nodes.min(62), "max_nodes {max_nodes}");
    }
    let lone_root = Limits {
        max_nodes: 1,
        ..Limits::default()
    };
    let node = chromium_bookmarks_with(ProfileFile::Bytes(text.as_bytes()), ProfileFile::Missing, &lone_root).unwrap();
    assert_eq!(node_count(&tree(&node)), 0);
}

#[test]
fn folders_at_the_depth_cap_are_kept_empty() {
    let limits = Limits {
        max_folder_depth: 1,
        ..Limits::default()
    };
    let text = r#"{"roots":{"other":{"type":"folder","children":[
        {"type":"url","url":"https://kept/"},
        {"type":"folder","name":"Cap","children":[{"type":"url","url":"https://dropped/"}]}]}}}"#;
    let node = chromium_bookmarks_with(ProfileFile::Bytes(text.as_bytes()), ProfileFile::Missing, &limits).unwrap();
    assert_eq!(
        tree(&node)["children"][0]["children"],
        json!([{"type":"url","title":"","url":"https://kept/"},{"type":"folder","title":"Cap","children":[]}])
    );
}

#[test]
fn json_nesting_is_capped_before_parsing() {
    let limits = Limits {
        max_json_depth: 4,
        ..Limits::default()
    };
    let four = br#"{"roots":{"other":{"type":"folder","children":[]}}}"#;
    let five = br#"{"roots":{"other":{"type":"folder","children":[{}]}}}"#;
    assert!(chromium_bookmarks_with(ProfileFile::Bytes(four), ProfileFile::Missing, &limits).is_ok());
    assert_eq!(
        chromium_bookmarks_with(ProfileFile::Bytes(five), ProfileFile::Missing, &limits),
        Err(ImportError::Unreadable)
    );
}

#[test]
fn input_size_is_checked_before_parsing() {
    let limits = Limits {
        max_input_bytes: 8,
        ..Limits::default()
    };
    let small = br#"{"roots":{}}"#;
    assert_eq!(
        chromium_bookmarks_with(ProfileFile::Bytes(small), ProfileFile::Missing, &limits),
        Err(ImportError::TooLarge)
    );
    assert_eq!(
        chromium_bookmarks_with(ProfileFile::Oversized, ProfileFile::Missing, &Limits::default()),
        Err(ImportError::TooLarge)
    );
    let empty = chromium_bookmarks_with(ProfileFile::Missing, ProfileFile::Oversized, &Limits::default()).unwrap();
    assert_eq!(empty, BookmarkNode::folder("Bookmarks", Vec::new(), None));
    assert_eq!(
        chromium_bookmarks(ProfileFile::Missing, ProfileFile::Missing),
        Err(ImportError::NotFound)
    );
}

#[test]
fn error_codes_match_the_import_result_codes() {
    assert_eq!(ImportError::NotFound.code(), "notFound");
    assert_eq!(ImportError::Unreadable.code(), "unreadable");
    assert_eq!(ImportError::TooLarge.to_string(), "tooLarge");
}
