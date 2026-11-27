use std::path::PathBuf;

use ardia_shell_migration::cli::{parse, Command, Environment};
use ardia_shell_migration::credentials::{
    self, assemble, chunk_count, chunk_target, generation_of, layout_of, rnw_layout, Assembled, Layout,
    StoredCredential, CHUNK_BYTES, MAX_CHUNKS,
};
use ardia_shell_migration::migrate::overlapping;
use ardia_shell_migration::names;
use zeroize::Zeroizing;

const PREFIX: &str = "Ardia Connected Accounts/";

fn stored(target: &str, comment: Option<&str>, blob: &[u8]) -> StoredCredential {
    let account = target.rsplit('/').next().unwrap_or("");
    let owner = match account.rsplit_once('#') {
        Some((head, index)) if !index.is_empty() && index.bytes().all(|b| b.is_ascii_digit()) => head
            .strip_suffix("#g1")
            .or_else(|| head.strip_suffix("#g2"))
            .unwrap_or(head),
        _ => account,
    };
    owned(target, comment, owner, blob)
}

fn owned(target: &str, comment: Option<&str>, user: &str, blob: &[u8]) -> StoredCredential {
    StoredCredential {
        user: Some(user.to_string()),
        target: target.into(),
        comment: comment.map(Into::into),
        blob: Zeroizing::new(blob.to_vec()),
    }
}

fn secrets(assembled: Vec<Assembled>) -> Vec<(String, Vec<u8>)> {
    assembled
        .into_iter()
        .filter_map(|item| match item {
            Assembled::Secret { account, secret } => Some((account, secret.to_vec())),
            _ => None,
        })
        .collect()
}

#[test]
fn the_comment_says_the_generation_and_chunk_count_as_keychain_module_writes_it() {
    assert_eq!(
        layout_of(Some("Ardia g1 3")),
        Layout {
            chunks: 3,
            generation: 1
        }
    );
    assert_eq!(
        layout_of(Some("Ardia g2 64")),
        Layout {
            chunks: 64,
            generation: 2
        }
    );
    assert_eq!(
        layout_of(Some("Ardia 2")),
        Layout {
            chunks: 2,
            generation: 0
        }
    );
    assert_eq!(
        layout_of(None),
        Layout {
            chunks: 1,
            generation: 0
        }
    );
    assert_eq!(chunk_count(Some("Ardia g1 65")), 1);
    assert_eq!(chunk_count(Some("Ardia g1 0")), 1);
    assert_eq!(chunk_count(Some("Ardia g1 3x")), 1);
    assert_eq!(chunk_count(Some("Ardia")), 1);
    assert_eq!(generation_of(Some("Ardia g3 2")), 0);
    assert_eq!(generation_of(Some("Ardia g12 2")), 0);
    assert_eq!(generation_of(Some("Ardia g1")), 0);
    assert_eq!(chunk_target("A/x", 0, 2), "A/x#2");
    assert_eq!(chunk_target("A/x", 2, 5), "A/x#g2#5");
}

#[test]
fn chunked_secrets_assemble_byte_for_byte_at_every_size() {
    for length in [
        0,
        1,
        CHUNK_BYTES - 1,
        CHUNK_BYTES,
        CHUNK_BYTES + 1,
        CHUNK_BYTES * 7 + 3,
        CHUNK_BYTES * MAX_CHUNKS,
    ] {
        for generation in [0, 1, 2] {
            let secret: Vec<u8> = (0..length).map(|i| (i * 7 + generation) as u8).collect();
            let parts = rnw_layout(PREFIX, "acct", &secret, generation);
            assert_eq!(parts.len(), length.div_ceil(CHUNK_BYTES).max(1));
            assert_eq!(
                secrets(assemble(PREFIX, parts)),
                vec![("acct".to_string(), secret)],
                "{length} g{generation}"
            );
        }
    }
}

#[test]
fn chunks_come_back_in_index_order_whatever_order_the_vault_lists_them() {
    let secret: Vec<u8> = (0..CHUNK_BYTES * 4).map(|i| (i / CHUNK_BYTES) as u8).collect();
    let mut parts = rnw_layout(PREFIX, "acct", &secret, 1);
    parts.reverse();
    parts.swap(0, 2);
    assert_eq!(secrets(assemble(PREFIX, parts)), vec![("acct".to_string(), secret)]);
}

#[test]
fn stale_generations_and_extra_chunks_are_ignored() {
    let secret = vec![1u8; CHUNK_BYTES + 5];
    let mut parts = rnw_layout(PREFIX, "acct", &secret, 2);
    parts.push(stored(&format!("{PREFIX}acct#g1#1"), None, b"old"));
    parts.push(stored(&format!("{PREFIX}acct#g1#2"), None, b"old"));
    parts.push(stored(&format!("{PREFIX}acct#g2#2"), None, b"beyond the count"));
    parts.push(stored(&format!("{PREFIX}acct#1"), None, b"legacy"));
    assert_eq!(secrets(assemble(PREFIX, parts)), vec![("acct".to_string(), secret)]);
}

#[test]
fn a_missing_chunk_makes_the_secret_incomplete() {
    let mut parts = rnw_layout(PREFIX, "acct", &vec![2u8; CHUNK_BYTES * 3], 1);
    parts.retain(|part| part.target != format!("{PREFIX}acct#g1#1"));
    let assembled = assemble(PREFIX, parts);
    assert_eq!(assembled.len(), 1);
    assert!(matches!(assembled[0], Assembled::Incomplete));
}

#[test]
fn a_chunk_in_the_wrong_generation_does_not_complete_a_secret() {
    let mut parts = rnw_layout(PREFIX, "acct", &vec![2u8; CHUNK_BYTES * 2], 1);
    parts.retain(|part| part.target != format!("{PREFIX}acct#g1#1"));
    parts.push(stored(&format!("{PREFIX}acct#g2#1"), None, &[2u8; CHUNK_BYTES]));
    assert!(matches!(assemble(PREFIX, parts)[0], Assembled::Incomplete));
}

#[test]
fn orphan_continuation_chunks_are_never_sealed_as_accounts() {
    let parts = vec![
        stored(&format!("{PREFIX}work#1"), None, b"half of a secret"),
        stored(&format!("{PREFIX}home#g2#3"), None, b"another half"),
        stored(&format!("{PREFIX}plain"), Some("Ardia g1 1"), b"real"),
    ];
    let assembled = assemble(PREFIX, parts);
    assert_eq!(assembled.iter().filter(|a| matches!(a, Assembled::Orphan)).count(), 2);
    assert_eq!(secrets(assembled), vec![("plain".to_string(), b"real".to_vec())]);
}

#[test]
fn an_interrupted_first_write_leaves_only_orphans() {
    let mut parts = rnw_layout(PREFIX, "fresh", &vec![4u8; CHUNK_BYTES * 3], 1);
    parts.retain(|part| part.comment.is_none());
    let assembled = assemble(PREFIX, parts);
    assert_eq!(assembled.len(), 2);
    assert!(assembled.iter().all(|a| matches!(a, Assembled::Orphan)));
}

#[test]
fn a_chunk_shaped_account_with_its_own_metadata_is_kept_beside_its_namesake() {
    let mut parts = rnw_layout(PREFIX, "work", b"work token", 1);
    parts.extend(rnw_layout(PREFIX, "work#1", b"its own token", 2));
    parts.extend(rnw_layout(PREFIX, "home#g2#3", &vec![6u8; CHUNK_BYTES + 3], 1));
    let mut found = secrets(assemble(PREFIX, parts));
    found.sort();
    assert_eq!(
        found,
        vec![
            ("home#g2#3".to_string(), vec![6u8; CHUNK_BYTES + 3]),
            ("work".to_string(), b"work token".to_vec()),
            ("work#1".to_string(), b"its own token".to_vec()),
        ]
    );
}

#[test]
fn a_base_never_borrows_another_accounts_base_as_a_chunk() {
    let mut parts = rnw_layout(PREFIX, "acct", &vec![1u8; CHUNK_BYTES + 1], 1);
    parts.retain(|part| part.comment.is_some());
    parts.extend(rnw_layout(PREFIX, "acct#g1#1", b"standalone", 1));
    let assembled = assemble(PREFIX, parts);
    assert_eq!(
        assembled.iter().filter(|a| matches!(a, Assembled::Incomplete)).count(),
        1
    );
    assert_eq!(
        secrets(assembled),
        vec![("acct#g1#1".to_string(), b"standalone".to_vec())]
    );
}

#[test]
fn other_prefixes_and_bad_account_names_are_left_out() {
    let parts = vec![
        stored("Other/acct", None, b"x"),
        stored("Ardia Connected Accounts [C:\\d]/acct", None, b"x"),
        stored(PREFIX, None, b"empty account"),
        stored(&format!("{PREFIX}bad\nname"), None, b"x"),
        stored(&format!("{PREFIX}ok"), Some("Ardia g1 1"), b"yes"),
    ];
    let assembled = assemble(PREFIX, parts);
    assert_eq!(assembled.iter().filter(|a| matches!(a, Assembled::Invalid)).count(), 2);
    assert_eq!(secrets(assembled), vec![("ok".to_string(), b"yes".to_vec())]);
}

#[test]
fn document_names_follow_the_rnw_document_store_and_skip_its_scratch_files() {
    for good in [
        "session.json",
        "history-index.json",
        "window-placement.txt",
        "a b.json",
        "über.json",
    ] {
        assert!(names::document_name(good), "{good}");
    }
    for bad in [
        "",
        ".",
        "..",
        ".hidden",
        "trailing.",
        "trailing ",
        "a:b",
        "a/b",
        "a\\b",
        "a*b",
        "a?b",
        "a|b",
        "a\"b",
        "a<b",
        "a>b",
        "tab\tname",
        "CON",
        "con.json",
        "LPT1.txt",
        "COM9",
        "COM¹.json",
        "dialog.json",
        "MENU.JSON",
        "activation.log",
        "file-chooser.txt",
        "Ardia.png",
        "User Data",
        "x.partial",
        "x.tmp",
        names::MARKER_NAME,
        names::ATTEMPT_NAME,
        names::LOCK_NAME,
    ] {
        assert!(!names::document_name(bad), "{bad:?}");
    }
    assert!(names::document_name("console.json"));
    assert!(names::document_name("COM10.json"));
    assert!(!names::document_name(&"x".repeat(201)));
}

#[test]
fn theme_and_sync_key_names_match_the_rnw_rules() {
    assert!(names::theme_file_name("dusk.json"));
    assert!(names::theme_file_name("a_b-9.json"));
    for bad in [
        "Dusk.json",
        "-x.json",
        ".json",
        "dusk.JSON",
        "dusk",
        "a b.json",
        "../x.json",
    ] {
        assert!(!names::theme_file_name(bad), "{bad}");
    }
    assert_eq!(names::sync_key_account("sync-key-Abc_1.dpapi"), Some("Abc_1"));
    for bad in [
        "sync-key-.dpapi",
        "sync-key-a b.dpapi",
        "sync-key-../x.dpapi",
        "Sync-Key-a.dpapi",
        "sync-key-a.DPAPI",
    ] {
        assert_eq!(names::sync_key_account(bad), None, "{bad}");
    }
    assert_eq!(
        names::sync_key_account(&format!("sync-key-{}.dpapi", "a".repeat(65))),
        None
    );
    assert_eq!(names::sync_purpose("abc", false), "ardia-sync-key/v1/abc");
    assert_eq!(names::sync_purpose("abc", true), "ardia-sync-key/v1/test-instance/abc");
}

#[test]
fn secret_file_names_are_case_safe_and_cannot_escape() {
    assert_eq!(names::secret_file("Ab"), "account-x4162.dpapi");
    assert_eq!(
        names::webui_sync_key_file("caseTest"),
        "sync-key-x6361736554657374.dpapi"
    );
    assert_ne!(
        names::webui_sync_key_file("caseTest"),
        names::webui_sync_key_file("CaseTest")
    );
    assert_ne!(names::secret_file("Ab"), names::secret_file("aB"));
    for account in ["../../evil", "a\\b", "CON", "x:y", "名前"] {
        let file = names::secret_file(account);
        assert!(names::plain_file_name(&file), "{file}");
        assert!(file
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.'));
    }
}

#[test]
fn the_credential_prefix_matches_keychain_module() {
    assert_eq!(names::credential_prefix(None), "Ardia Connected Accounts/");
    assert_eq!(names::credential_prefix(Some("")), "Ardia Connected Accounts/");
    assert_eq!(
        names::credential_prefix(Some("C:/Scratch/Ardia/")),
        "Ardia Connected Accounts [C:\\Scratch\\Ardia]/"
    );
    assert_eq!(
        names::credential_prefix(Some("C:\\")),
        "Ardia Connected Accounts [C:\\]/"
    );
    assert_eq!(
        names::credential_prefix(Some("D:\\a\\\\")),
        "Ardia Connected Accounts [D:\\a]/"
    );
}

#[test]
fn overlap_is_component_wise_and_case_insensitive() {
    let p = |s: &str| PathBuf::from(s);
    assert!(overlapping(&p("/x/Local/Ardia"), &p("/x/local/ardia/User Data")));
    assert!(overlapping(&p("/x/Local"), &p("/x/Local/Ardia")));
    assert!(!overlapping(&p("/x/Local/Ardia WebUI"), &p("/x/Local/Ardia")));
    assert!(!overlapping(&p("/x/Local/Ardia2"), &p("/x/Local/Ardia")));
}

fn environment(local: Option<&str>, roaming: Option<&str>, data: Option<&str>) -> Environment {
    Environment {
        local_app_data: local.map(Into::into),
        roaming_app_data: roaming.map(Into::into),
        ardia_data_dir: data.map(Into::into),
    }
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn the_command_line_needs_an_explicit_request() {
    let env = environment(Some("/L"), Some("/R"), None);
    assert_eq!(parse(&args(&["--help"]), &env), Ok(Command::Help));
    assert!(parse(&args(&[]), &env).is_err());
    let Ok(Command::Migrate(layout)) = parse(&args(&["--from-rnw"]), &env) else {
        panic!("standard layout");
    };
    assert_eq!(layout.rnw_data, PathBuf::from("/L").join("Ardia"));
    assert_eq!(layout.rnw_config, PathBuf::from("/R").join("Ardia"));
    assert_eq!(layout.webui_data, PathBuf::from("/L").join("Ardia WebUI"));
    assert!(!layout.test_instance);
    assert!(parse(
        &args(&["--from-rnw"]),
        &environment(Some("/L"), Some("/R"), Some("/scratch"))
    )
    .is_err());
    assert!(parse(&args(&["--from-rnw"]), &environment(None, Some("/R"), None)).is_err());
    assert!(parse(&args(&["--from-rnw", "--rnw-data", "/a"]), &env).is_err());
    assert!(parse(&args(&["--from-rnw", "--rnw-data"]), &env).is_err());
    assert!(parse(
        &args(&[
            "--from-rnw",
            "--rnw-data",
            "/a",
            "--rnw-data",
            "/b",
            "--webui-data",
            "/c"
        ]),
        &env
    )
    .is_err());
    assert!(parse(&args(&["--from-rnw", "--force"]), &env).is_err());
    let Ok(Command::Migrate(custom)) = parse(
        &args(&[
            "--from-rnw",
            "--rnw-data",
            "C:/s/rnw",
            "--webui-data",
            "C:/s/webui",
            "--test-instance",
        ]),
        &environment(None, None, Some("C:/s/webui")),
    ) else {
        panic!("custom layout");
    };
    assert_eq!(custom.credential_prefix, "Ardia Connected Accounts [C:\\s\\rnw]/");
    assert_eq!(custom.rnw_config, PathBuf::from("C:/s/rnw").join("config"));
    assert!(custom.test_instance);
}

#[test]
fn hostile_names_never_become_files_or_purposes_that_escape() {
    let hostile = [
        "..",
        "../x",
        "..\\x",
        "a\nb",
        "a\rb",
        "a\u{0}b",
        "a\u{2028}b",
        "C:\\Windows",
        "\\\\?\\C:\\x",
        "//server/share",
        "__proto__",
        "javascript:alert(1)",
        "file:///C:/x",
        "x\u{202e}gnp.exe",
        "NUL",
        "aux.json",
        "x ",
        "x.",
    ];
    for name in hostile {
        let accepted =
            names::document_name(name) || names::theme_file_name(name) || names::sync_key_account(name).is_some();
        if accepted {
            assert!(
                !name.contains(['/', '\\', ':', '\n', '\r', '\0']) && name != ".." && !name.ends_with(['.', ' ']),
                "{name:?}"
            );
        }
        let file = names::secret_file(name);
        assert!(names::plain_file_name(&file), "{name:?} -> {file}");
        assert!(file
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.'));
    }
}

#[test]
fn a_chunk_two_bases_both_claim_fails_both() {
    let shared = format!("{PREFIX}a#g1#1");
    let parts = vec![
        owned(&format!("{PREFIX}a"), Some("Ardia g1 2"), "a", &[1u8; CHUNK_BYTES]),
        owned(&format!("{PREFIX}a#g1"), Some("Ardia 2"), "a#g1", &[2u8; CHUNK_BYTES]),
        owned(&shared, None, "a#g1", b"which account is this?"),
    ];
    let assembled = assemble(PREFIX, parts);
    assert_eq!(
        assembled.iter().filter(|a| matches!(a, Assembled::Incomplete)).count(),
        2
    );
    assert_eq!(assembled.iter().filter(|a| matches!(a, Assembled::Orphan)).count(), 0);
    assert!(secrets(assembled).is_empty());
}

#[test]
fn owners_must_be_the_exact_account_and_never_two_blanks() {
    let mut blank = rnw_layout(PREFIX, "acct", &vec![1u8; CHUNK_BYTES + 1], 1);
    for part in &mut blank {
        part.user = None;
    }
    assert!(secrets(assemble(PREFIX, blank)).is_empty());
    let mut borrowed = rnw_layout(PREFIX, "acct", &vec![1u8; CHUNK_BYTES + 1], 1);
    for part in &mut borrowed {
        part.user = Some("other".into());
    }
    assert!(secrets(assemble(PREFIX, borrowed)).is_empty());
    let single = vec![owned(&format!("{PREFIX}solo"), Some("Ardia g1 1"), "SOLO", b"x")];
    assert!(matches!(assemble(PREFIX, single)[0], Assembled::Incomplete));
}

#[test]
fn the_namespace_matches_without_case_but_the_account_keeps_its_case() {
    let written = names::credential_prefix(Some("C:\\Scratch\\RNW"));
    let asked = names::credential_prefix(Some("c:\\scratch\\rnw"));
    let parts = rnw_layout(&written, "GitHub", b"token", 1);
    assert_eq!(
        secrets(assemble(&asked, parts)),
        vec![("GitHub".to_string(), b"token".to_vec())]
    );
    assert_eq!(
        credentials::account_in(&asked, &format!("{written}MixedCase")),
        Some("MixedCase")
    );
    assert_eq!(
        credentials::account_in(&asked, "Ardia Connected Accounts [d:\\other]/x"),
        None
    );
    assert_eq!(credentials::account_in("Ärdia/", "ärdia/Ä"), Some("Ä"));
    assert_eq!(credentials::account_in("abc/", "ab"), None);
}

#[test]
fn kept_names_stay_within_255_and_apart() {
    let long = names::secret_file(&"a".repeat(120));
    let other = names::secret_file(&format!("{}b", "a".repeat(119)));
    let run = "0123456789abcdef0123456789abcdef";
    for name in [&long, &other] {
        assert!(
            ardia_shell_migration::migrate::kept_name(name, run)
                .encode_utf16()
                .count()
                <= 255
        );
    }
    assert_ne!(
        ardia_shell_migration::migrate::kept_name(&long, run),
        ardia_shell_migration::migrate::kept_name(&other, run)
    );
    assert_eq!(
        ardia_shell_migration::migrate::kept_name("session.json", run),
        "session.json.0123456789abcdef.kept"
    );
}

#[test]
fn a_marker_must_be_a_whole_finished_report() {
    use ardia_shell_migration::migrate::valid_marker;
    let counts: serde_json::Map<String, serde_json::Value> = [
        "documents",
        "placement",
        "config_files",
        "sync_keys",
        "credentials",
        "unchanged",
        "kept_aside",
        "skipped_links",
        "skipped_invalid",
        "skipped_too_large",
        "skipped_case_clash",
        "sync_keys_unreadable",
        "credentials_incomplete",
        "credential_chunks_orphaned",
        "partials_swept",
    ]
    .iter()
    .map(|name| (name.to_string(), serde_json::json!(0)))
    .collect();
    let good = serde_json::json!({"version": 1, "run": "0123456789abcdef0123456789abcdef", "outcome": "migrated", "attempt": 1, "duration_ms": 3, "counts": counts});
    assert!(valid_marker(&good));
    for broken in [
        serde_json::json!({"version": 1}),
        serde_json::json!({"version": 1, "run": "0123456789abcdef0123456789abcdef", "outcome": "migrated", "attempt": 1, "counts": counts}),
        serde_json::json!({"version": 1, "run": "x", "outcome": "migrated", "attempt": 1, "counts": counts}),
        serde_json::json!({"version": 1, "run": "0123456789abcdef0123456789abcdef", "outcome": "failed", "attempt": 1, "counts": counts}),
        serde_json::json!({"version": 1, "run": "0123456789abcdef0123456789abcdef", "outcome": "migrated", "attempt": 1, "counts": {}}),
        serde_json::json!({"version": 1, "run": "0123456789abcdef0123456789abcdef", "outcome": "migrated", "failed_stage": "marker", "attempt": 1, "counts": counts}),
        serde_json::json!({"version": 2, "run": "0123456789abcdef0123456789abcdef", "outcome": "migrated", "attempt": 1, "counts": counts}),
    ] {
        assert!(!valid_marker(&broken), "{broken}");
    }
}

#[test]
fn migrator_folders_are_never_documents() {
    for name in [
        "Secrets",
        "SECRETS",
        "rnw-migration-kept",
        "RNW-Migration-Kept",
        "Sync",
        "config",
    ] {
        assert!(!names::document_name(name), "{name}");
    }
}

#[test]
fn a_chunk_owned_by_someone_else_never_completes_a_secret() {
    let mut parts = rnw_layout(PREFIX, "acct", &vec![3u8; CHUNK_BYTES + 9], 1);
    for part in parts.iter_mut().filter(|part| part.comment.is_none()) {
        part.user = Some("intruder".into());
    }
    let assembled = assemble(PREFIX, parts);
    assert!(matches!(assembled[0], Assembled::Incomplete));
    assert_eq!(assembled.iter().filter(|a| matches!(a, Assembled::Orphan)).count(), 1);
    assert!(secrets(assembled).is_empty());
}

#[test]
fn rnw_writes_the_account_as_the_owner_of_every_chunk() {
    let parts = rnw_layout(PREFIX, "acct", &vec![1u8; CHUNK_BYTES * 3], 2);
    assert!(parts.iter().all(|part| part.user.as_deref() == Some("acct")));
    assert_eq!(credentials::rnw_user(&"x".repeat(300)).len(), 256);
}

#[test]
fn the_longest_account_still_names_a_file_ntfs_accepts() {
    let longest = "a".repeat(120);
    assert!(names::secret_account(&longest));
    assert_eq!(names::secret_file(&longest).len(), 255);
    assert!(!names::secret_account(&"a".repeat(121)));
    assert!(ardia_shell_migration::fsafe::partial_name().len() < 64);
}
