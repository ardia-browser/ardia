mod support;

use ardia_sync_core::phrase::{self, ENTROPY_BYTES};
use ardia_sync_core::PhraseError;
use serde_json::{json, Value};
use support::*;

fn outcome(text: &str) -> Value {
    match phrase::entropy(text) {
        Ok(entropy) => json!({ "entropy": hex_string(entropy.as_ref()) }),
        Err(PhraseError::WordCount(count)) => json!({ "problem": "wordCount", "count": count }),
        Err(PhraseError::UnknownWord(index)) => {
            json!({ "problem": "unknownWord", "word": phrase::tokens(text)[index].as_str() })
        }
        Err(PhraseError::Checksum) => json!({ "problem": "checksum" }),
    }
}

#[test]
fn every_case_matches_what_swift_does() {
    let table = json(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/phrase-cases.json"));
    let cases = table["cases"].as_array().unwrap();
    assert!(cases.len() >= 30);
    let mut divergent = 0;
    for case in cases {
        let input = str(case, "input");
        let name = str(case, "name");
        let tokens: Vec<String> = phrase::tokens(input).iter().map(|token| token.to_string()).collect();
        let expected: Vec<&str> = case["tokens"]
            .as_array()
            .unwrap()
            .iter()
            .map(|token| token.as_str().unwrap())
            .collect();
        assert_eq!(tokens, expected, "{name}");
        let outcomes = &case["outcomes"];
        assert_eq!(outcome(input), outcomes["swift"], "{name}");
        assert!(outcomes["kotlin"].is_object() && outcomes["windows"].is_object() && outcomes["linux"].is_object());
        if ["kotlin", "windows", "linux"]
            .iter()
            .any(|platform| outcomes[*platform] != outcomes["swift"])
        {
            divergent += 1;
        }
    }
    assert!(divergent >= 8);
}

#[test]
fn words_round_trip_for_edge_entropies() {
    for fill in [0x00u8, 0xff, 0x5a, 0xa5] {
        let entropy = [fill; ENTROPY_BYTES];
        let words = phrase::words(&entropy);
        assert_eq!(words.len(), 24);
        assert_eq!(phrase::entropy(&words.join(" ")).unwrap().as_ref(), &entropy);
        let prefixes: Vec<String> = words.iter().map(|word| word.chars().take(4).collect()).collect();
        assert_eq!(phrase::entropy(&prefixes.join(" ")).unwrap().as_ref(), &entropy);
        assert_eq!(
            phrase::entropy(&words.join(" ").to_uppercase()).unwrap().as_ref(),
            &entropy
        );
    }
    let generated = phrase::generate_entropy().unwrap();
    assert_eq!(
        phrase::entropy(&phrase::phrase(&generated)).unwrap().as_ref(),
        generated.as_ref()
    );
    assert_ne!(phrase::generate_entropy().unwrap().as_ref(), generated.as_ref());
}

#[test]
fn prefixes_need_four_letters_and_must_match_the_whole_abbreviation() {
    assert_eq!(phrase::index_of("abandon"), Some(0));
    assert_eq!(phrase::index_of("aban"), Some(0));
    assert_eq!(phrase::index_of("abandonx"), None);
    assert_eq!(phrase::index_of("aba"), None);
    assert_eq!(phrase::index_of("act"), Some(19));
    assert_eq!(phrase::index_of("acti"), Some(20));
    assert_eq!(phrase::index_of("zoo"), Some(2047));
    assert_eq!(phrase::index_of("zooo"), None);
    assert_eq!(phrase::index_of("zzzz"), None);
    assert_eq!(phrase::index_of(""), None);
    assert_eq!(phrase::index_of("ａｗｆｕｌ"), None);
}
