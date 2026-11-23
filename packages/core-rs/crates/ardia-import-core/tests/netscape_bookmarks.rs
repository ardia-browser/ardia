mod support;

use ardia_import_core::{
    netscape_bookmarks, netscape_bookmarks_with, BookmarkNode, ImportError, Limits, ProfileFile, MAX_FOLDER_DEPTH,
    MAX_INPUT_BYTES, MAX_NODES,
};
use serde_json::{json, Value};

fn parse(html: &str) -> Result<BookmarkNode, ImportError> {
    netscape_bookmarks(ProfileFile::Bytes(html.as_bytes()))
}

fn parse_with(html: &str, limits: &Limits) -> Result<BookmarkNode, ImportError> {
    netscape_bookmarks_with(ProfileFile::Bytes(html.as_bytes()), limits)
}

fn tree(node: &BookmarkNode) -> Value {
    support::unbounded(&node.to_json())
}

fn node_count(node: &Value) -> usize {
    node["children"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|child| 1 + node_count(child))
        .sum()
}

fn limited(max_nodes: usize, max_folder_depth: usize) -> Limits {
    Limits {
        max_nodes,
        max_folder_depth,
        ..Limits::default()
    }
}

#[test]
fn the_vector_limits_are_the_crate_limits() {
    let limits = &support::netscape_vectors()["limits"];
    assert_eq!(limits["maxInputBytes"], MAX_INPUT_BYTES);
    assert_eq!(limits["maxFolderDepth"], MAX_FOLDER_DEPTH);
    assert_eq!(limits["maxNodes"], MAX_NODES);
}

#[test]
fn every_shared_vector_gives_the_expected_answer() {
    let cases = support::netscape_cases();
    assert!(cases.len() >= 50, "{} cases", cases.len());
    for case in cases {
        let data = support::netscape_file(&case["file"]);
        let result = netscape_bookmarks(ProfileFile::Bytes(&data));
        let expected = &case["expect"];
        let got = support::outcome(result.as_ref().map(tree).map_err(|error| error.code()), expected);
        assert!(
            support::same(&got, expected),
            "{}: got {got}, expected {expected}",
            case["name"]
        );
        if let Ok(node) = result {
            assert!(node_count(&tree(&node)) <= MAX_NODES, "{}", case["name"]);
            assert!(support::shape(&tree(&node))["depth"].as_u64().unwrap() <= MAX_FOLDER_DEPTH as u64);
        }
    }
}

#[test]
fn the_output_uses_the_import_result_field_names() {
    let node = parse(concat!(
        "<DL><p><DT><H3 ADD_DATE=\"1655526400\" PERSONAL_TOOLBAR_FOLDER=\"true\">Bar</H3><DL><p>",
        "<DT><A HREF=\"https://a.example/\" ADD_DATE=\"1655526400\">A</A></DL><p></DL><p>"
    ))
    .unwrap();
    assert_eq!(
        String::from_utf8(node.to_json()).unwrap(),
        concat!(
            r#"{"type":"folder","title":"Bookmarks","children":[{"type":"folder","title":"Bar","#,
            r#""dateAdded":1655526400000.0,"children":[{"type":"url","title":"A","url":"https://a.example/","#,
            r#""dateAdded":1655526400000.0}],"role":"toolbar"}]}"#
        )
    );
}

#[test]
fn the_node_budget_reserves_each_folder_before_its_contents() {
    let html = concat!(
        "<DL><p><DT><H3>F</H3><DL><p>",
        "<DT><A HREF=\"https://1/\">1</A><DT><A HREF=\"https://2/\">2</A><DT><A HREF=\"https://3/\">3</A>",
        "</DL><p><DT><A HREF=\"https://4/\">4</A><DT><H3>G</H3><DL><p><DT><A HREF=\"https://5/\">5</A></DL><p></DL><p>"
    );
    let node = parse_with(html, &limited(3, MAX_FOLDER_DEPTH)).unwrap();
    assert_eq!(
        tree(&node),
        json!({"type":"folder","title":"Bookmarks","children":[{"type":"folder","title":"F","children":[
            {"type":"url","title":"1","url":"https://1/"},{"type":"url","title":"2","url":"https://2/"}]}]})
    );
}

#[test]
fn the_node_budget_is_a_hard_ceiling_under_nested_folders_and_lists() {
    let mut html = String::from("<DL><p>");
    for level in 0..10 {
        for link in 0..5 {
            html.push_str(&format!("<DT><A HREF=\"https://{level}/{link}\">x</A>"));
        }
        html.push_str(if level % 2 == 0 {
            "<DT><H3>F</H3><DL><p>"
        } else {
            "<DL><p>"
        });
    }
    html.push_str("<DT><A HREF=\"https://deepest/\">deepest</A>");
    for max_nodes in [1, 2, 5, 6, 7, 13, 30, 60, 61, 62, 63, 100] {
        let node = parse_with(&html, &limited(max_nodes, MAX_FOLDER_DEPTH)).unwrap();
        assert_eq!(node_count(&tree(&node)), max_nodes.min(61), "max_nodes {max_nodes}");
    }
    assert_eq!(
        parse_with(&html, &limited(0, MAX_FOLDER_DEPTH)),
        Err(ImportError::Unreadable)
    );
}

#[test]
fn a_heading_refused_by_the_budget_does_not_open_or_close_a_folder() {
    let html = concat!(
        "<DL><p><DT><H3>A</H3><DL><p><DT><A HREF=\"https://1/\">1</A>",
        "<DT><H3>B</H3><DL><p><DT><A HREF=\"https://2/\">2</A></DL><p>",
        "<DT><A HREF=\"https://3/\">3</A></DL><p><DT><A HREF=\"https://4/\">4</A></DL><p>"
    );
    let node = parse_with(html, &limited(2, MAX_FOLDER_DEPTH)).unwrap();
    assert_eq!(
        tree(&node),
        json!({"type":"folder","title":"Bookmarks","children":[{"type":"folder","title":"A","children":[
            {"type":"url","title":"1","url":"https://1/"}]}]})
    );
}

#[test]
fn folders_past_the_depth_cap_hand_their_links_to_the_deepest_folder() {
    let html = concat!(
        "<DL><p><DT><H3>One</H3><DL><p><DT><H3>Two</H3><DL><p>",
        "<DT><A HREF=\"https://a/\">a</A><DT><H3>Three</H3><DL><p><DT><A HREF=\"https://b/\">b</A>",
        "<DL><p><DT><A HREF=\"https://c/\">c</A></DL><p></DL><p>",
        "<DT><A HREF=\"https://d/\">d</A></DL><p><DT><A HREF=\"https://e/\">e</A></DL><p></DL><p>"
    );
    let node = parse_with(html, &limited(MAX_NODES, 2)).unwrap();
    let link = |url: &str| json!({"type":"url","title":url,"url":format!("https://{url}/")});
    assert_eq!(
        tree(&node),
        json!({"type":"folder","title":"Bookmarks","children":[{"type":"folder","title":"One","children":[
            {"type":"folder","title":"Two","children":[link("a"),link("b"),link("c"),link("d")]},link("e")]}]})
    );
    assert_eq!(node_count(&tree(&node)), 7);
}

#[test]
fn a_heading_without_a_list_past_the_depth_cap_is_not_kept() {
    let html = concat!(
        "<DL><p><DT><H3>One</H3><DL><p><DT><H3>Lonely</H3><DT><A HREF=\"https://a/\">a</A>",
        "<DT><H3>Last</H3></DL><p><DT><H3>Sibling</H3></DL><p>"
    );
    let node = parse_with(html, &limited(MAX_NODES, 1)).unwrap();
    assert_eq!(
        tree(&node),
        json!({"type":"folder","title":"Bookmarks","children":[
            {"type":"folder","title":"One","children":[{"type":"url","title":"a","url":"https://a/"}]},
            {"type":"folder","title":"Sibling","children":[]}]})
    );
    let mut deep = String::from("<DL><p>");
    for level in 1..=MAX_FOLDER_DEPTH {
        deep.push_str(&format!("<DT><H3>F{level}</H3><DL><p>"));
    }
    deep.push_str("<DT><H3>Too deep</H3><DT><A HREF=\"https://deep/\">deep</A><DT><H3>Also too deep</H3>");
    let node = parse(&deep).unwrap();
    assert_eq!(
        support::shape(&tree(&node)),
        json!({"links": 1, "folders": MAX_FOLDER_DEPTH, "depth": MAX_FOLDER_DEPTH})
    );
    assert_eq!(node_count(&tree(&node)), MAX_FOLDER_DEPTH + 1);
    let budget = parse_with(&deep, &limited(MAX_FOLDER_DEPTH + 1, MAX_FOLDER_DEPTH)).unwrap();
    assert_eq!(support::shape(&tree(&budget))["links"], 1);
}

#[test]
fn a_million_unclosed_lists_parse_without_recursion() {
    let mut html = "<DL>".repeat(1_000_000);
    html.push_str("<DT><A HREF=\"https://deep/\">deep</A>");
    let node = parse(&html).unwrap();
    assert_eq!(
        support::shape(&tree(&node)),
        json!({"links": 1, "folders": MAX_FOLDER_DEPTH, "depth": MAX_FOLDER_DEPTH})
    );
    let closed = "<DL>".repeat(500_000) + "<DT><A HREF=\"https://x/\">x</A>" + &"</DL>".repeat(500_000);
    assert_eq!(
        support::shape(&tree(&parse(&closed).unwrap()))["depth"],
        MAX_FOLDER_DEPTH
    );
}

#[test]
fn input_size_is_checked_before_parsing() {
    let small = "<DL><p><DT><A HREF=\"https://a/\">a</A></DL><p>";
    let limits = Limits {
        max_input_bytes: small.len() - 1,
        ..Limits::default()
    };
    assert_eq!(parse_with(small, &limits), Err(ImportError::TooLarge));
    let limits = Limits {
        max_input_bytes: small.len(),
        ..Limits::default()
    };
    assert!(parse_with(small, &limits).is_ok());
    assert_eq!(netscape_bookmarks(ProfileFile::Oversized), Err(ImportError::TooLarge));
    assert_eq!(netscape_bookmarks(ProfileFile::Missing), Err(ImportError::NotFound));
    assert_eq!(
        netscape_bookmarks(ProfileFile::Bytes(b"")),
        Err(ImportError::Unreadable)
    );
}

#[test]
fn titles_and_urls_reach_the_tree_verbatim_after_entities() {
    let node = parse(concat!(
        "<DT><A HREF=\"javascript:alert(&quot;&lt;x&gt;&quot;)\">\u{0}\u{202E}&#x1F98A;&amp;amp;</A>",
        "<DT><A HREF=\"https://b/\">\u{FEFF}</A>"
    ))
    .unwrap();
    assert_eq!(
        tree(&node)["children"],
        json!([
            {"type":"url","title":"\u{0}\u{202E}\u{1F98A}&amp;","url":"javascript:alert(\"<x>\")"},
            {"type":"url","title":"\u{FEFF}","url":"https://b/"}
        ])
    );
}
