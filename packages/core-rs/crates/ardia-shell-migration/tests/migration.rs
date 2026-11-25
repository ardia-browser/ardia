mod common;

use std::fs;
use std::path::Path;

use ardia_shell_migration::{migrate, migrate::read_marker, names, Faults, Layout, Outcome, Stage};
use common::*;
use serde_json::Value;

fn run(layout: &Layout, sealer: &FakeDpapi, vault: &FakeVault) -> ardia_shell_migration::Report {
    migrate(layout, sealer, vault, &Faults::default())
}

fn opened(sealer: &FakeDpapi, webui: &Path, account: &str) -> Option<Vec<u8>> {
    use ardia_shell_migration::Sealer;
    let sealed = fs::read(webui.join(names::SECRETS_FOLDER).join(names::secret_file(account))).ok()?;
    sealer
        .open(&sealed, &names::secret_purpose(account, false))
        .map(|plain| plain.to_vec())
}

fn assert_no_partials(root: &Path) {
    for path in tree(root).keys() {
        assert!(
            !path.ends_with(names::PARTIAL_SUFFIX),
            "a staged file was left behind: {path}"
        );
    }
}

fn webui_sync_account(file: &str) -> Option<String> {
    let hex = file.strip_prefix("sync-key-x")?.strip_suffix(".dpapi")?;
    let bytes: Option<Vec<u8>> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

fn comparable(webui: &Path, sealer: &FakeDpapi, accounts: &[&str]) -> Vec<(String, Vec<u8>)> {
    use ardia_shell_migration::Sealer;
    let mut files: Vec<(String, Vec<u8>)> = tree(webui)
        .into_iter()
        .map(
            |(path, bytes)| match path.strip_prefix("Sync/").and_then(webui_sync_account) {
                Some(account) => {
                    let plain = sealer
                        .open(&bytes, &names::sync_purpose(&account, false))
                        .map(|p| p.to_vec());
                    (path.clone(), plain.unwrap_or_default())
                }
                None => (path, bytes),
            },
        )
        .filter(|(path, _)| {
            !path.starts_with(names::SECRETS_FOLDER)
                && path != names::MARKER_NAME
                && path != names::ATTEMPT_NAME
                && path != names::LOCK_NAME
        })
        .collect();
    for account in accounts {
        files.push((
            format!("secret:{account}"),
            opened(sealer, webui, account).unwrap_or_default(),
        ));
    }
    files
}

#[test]
fn every_rnw_item_lands_in_the_webui_layout() {
    let scratch = Scratch::new("every");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    let layout = &populated.layout;
    let report = run(layout, &sealer, &populated.vault);
    assert_eq!(report.outcome, Outcome::MigratedWithSkips, "{:?}", report);
    let webui = &layout.webui_data;
    let rnw = &layout.rnw_data;
    for name in ["session.json", "history-index.json", names::PLACEMENT_NAME] {
        assert_eq!(
            fs::read(webui.join(name)).unwrap(),
            fs::read(rnw.join(name)).unwrap(),
            "{name}"
        );
    }
    for skipped in [
        "dialog.json",
        "menu.json",
        "activation.log",
        "Ardia.png",
        ".hidden.json",
        "Logs",
        "Telemetry",
        "User Data",
    ] {
        assert!(!webui.join(skipped).exists(), "{skipped} should stay behind");
    }
    let config = webui.join(names::CONFIG_FOLDER);
    assert_eq!(fs::read(config.join("config.json")).unwrap(), b"{\"theme\":\"dusk\"}");
    assert_eq!(fs::read(config.join("hooks.json")).unwrap(), b"{\"hooks\":[]}");
    assert_eq!(
        fs::read(config.join("themes").join("dusk.json")).unwrap(),
        b"{\"name\":\"dusk\"}"
    );
    assert!(!config.join("config.schema.json").exists());
    assert!(!config.join("themes").join("Loud.json").exists());
    assert!(!config.join("themes").join("notes.txt").exists());
    let sync = webui.join(names::SYNC_FOLDER);
    assert_eq!(
        fs::read(sync.join("sync-key-x4162635f31.dpapi")).unwrap(),
        fs::read(rnw.join("Sync").join("sync-key-Abc_1.dpapi")).unwrap()
    );
    assert!(
        !sync.join("sync-key-zzz.dpapi").exists(),
        "a key sealed for another account is not copied"
    );
    assert!(
        !sync.join("sync-key-short.dpapi").exists(),
        "a key of the wrong length is not copied"
    );
    assert!(!sync.join("vault.nns").exists());
    assert!(
        !sync.join("sync-key-Abc_1.dpapi").exists(),
        "the WebUI store names keys by the hex of the account"
    );
    assert_eq!(tree(&sync).len(), 1);
    for (account, secret) in &populated.secrets {
        assert_eq!(
            opened(&sealer, webui, account).as_deref(),
            Some(secret.as_slice()),
            "{account}"
        );
    }
    assert!(
        opened(&sealer, webui, "torn").is_none(),
        "a secret with a missing chunk is not half copied"
    );
    let secrets: Vec<String> = tree(&webui.join(names::SECRETS_FOLDER)).into_keys().collect();
    assert_eq!(secrets.len(), populated.secrets.len(), "{secrets:?}");
    let counts = &report.counts;
    assert_eq!(counts.documents, 2);
    assert_eq!(counts.placement, 1);
    assert_eq!(counts.config_files, 3);
    assert_eq!(counts.sync_keys, 1);
    assert_eq!(counts.sync_keys_unreadable, 2);
    assert_eq!(counts.credentials, 4);
    assert_eq!(counts.credentials_incomplete, 1);
    assert_eq!(counts.credential_chunks_orphaned, 1);
    assert!(
        opened(&sealer, webui, "half-written#g1#1").is_none(),
        "an orphan chunk never becomes an account"
    );
    assert_eq!(counts.unchanged, 0);
    assert_eq!(counts.kept_aside, 0);
    assert_eq!(read_marker(webui).unwrap()["outcome"], "migrated_with_skips");
    assert_no_partials(webui);
}

#[test]
fn the_rnw_data_and_credentials_are_never_changed() {
    let scratch = Scratch::new("rollback");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    let layout = &populated.layout;
    let local = tree(&layout.rnw_data);
    let roaming = tree(&layout.rnw_config);
    let vault = populated.vault.snapshot();
    let modified = fs::metadata(layout.rnw_data.join("session.json"))
        .unwrap()
        .modified()
        .unwrap();
    for fail_at in [Some(3), None, None] {
        migrate(
            layout,
            &sealer,
            &populated.vault,
            &Faults {
                fail_at_commit: fail_at,
            },
        );
    }
    assert_eq!(
        tree(&layout.rnw_data),
        local,
        "the RNW local folder a rollback opens is byte for byte the same"
    );
    assert_eq!(tree(&layout.rnw_config), roaming);
    assert_eq!(populated.vault.snapshot(), vault);
    assert_eq!(
        fs::metadata(layout.rnw_data.join("session.json"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
}

#[test]
fn a_crash_before_any_rename_resumes_to_the_same_result() {
    let reference_root = Scratch::new("reference");
    let sealer = FakeDpapi::new();
    let reference = populate(&reference_root.0, &sealer);
    let clean = run(&reference.layout, &sealer, &reference.vault);
    let accounts: Vec<&str> = reference.secrets.keys().map(String::as_str).collect();
    let expected = comparable(&reference.layout.webui_data, &sealer, &accounts);
    let mut fail_at = 1;
    loop {
        let scratch = Scratch::new("crash");
        let populated = populate(&scratch.0, &sealer);
        let layout = &populated.layout;
        let crashed = migrate(
            layout,
            &sealer,
            &populated.vault,
            &Faults {
                fail_at_commit: Some(fail_at),
            },
        );
        if crashed.outcome != Outcome::Failed {
            assert_eq!(crashed.outcome, clean.outcome);
            break;
        }
        assert!(
            read_marker(&layout.webui_data).is_none(),
            "commit {fail_at}: no marker before every step is done"
        );
        let resumed = run(layout, &sealer, &populated.vault);
        assert_eq!(resumed.outcome, clean.outcome, "commit {fail_at}: {resumed:?}");
        assert_eq!(
            comparable(&layout.webui_data, &sealer, &accounts),
            expected,
            "commit {fail_at}"
        );
        assert_eq!(
            resumed.counts.kept_aside, 0,
            "commit {fail_at}: a resumed run never keeps its own copies aside"
        );
        assert!(resumed.counts.partials_swept <= 1);
        assert_no_partials(&layout.webui_data);
        let attempt = ardia_shell_migration::migrate::read_attempt(&layout.webui_data).unwrap();
        let marker = read_marker(&layout.webui_data).unwrap();
        assert_eq!(
            attempt["run"], marker["run"],
            "commit {fail_at}: the report and the marker describe the same run"
        );
        assert_eq!(attempt["outcome"], marker["outcome"]);
        let again = run(layout, &sealer, &populated.vault);
        assert_eq!(again.outcome, Outcome::AlreadyMigrated);
        fail_at += 1;
        assert!(fail_at < 100, "the crash loop never finished");
    }
    assert!(
        fail_at > 10,
        "every item and the marker are separate commits, got {fail_at}"
    );
}

#[test]
fn a_finished_migration_runs_once() {
    let scratch = Scratch::new("once");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    let layout = &populated.layout;
    run(layout, &sealer, &populated.vault);
    fs::write(layout.rnw_data.join("session.json"), b"{\"after\":\"rollback\"}").unwrap();
    fs::write(layout.webui_data.join("session.json"), b"{\"webui\":\"edited\"}").unwrap();
    let seals = *sealer.seals.borrow();
    let second = run(layout, &sealer, &populated.vault);
    assert_eq!(second.outcome, Outcome::AlreadyMigrated);
    assert_eq!(second.exit_code(), 0);
    assert_eq!(
        fs::read(layout.webui_data.join("session.json")).unwrap(),
        b"{\"webui\":\"edited\"}"
    );
    assert_eq!(
        *sealer.seals.borrow(),
        seals,
        "an already migrated profile seals nothing"
    );
}

#[test]
fn webui_data_already_there_is_kept_aside_once() {
    let scratch = Scratch::new("kept");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    let layout = &populated.layout;
    write(&layout.webui_data.join("session.json"), b"pilot session");
    write(&layout.webui_data.join("config").join("hooks.json"), b"pilot hooks");
    let crashed = migrate(
        layout,
        &sealer,
        &populated.vault,
        &Faults {
            fail_at_commit: Some(4),
        },
    );
    assert_eq!(crashed.outcome, Outcome::Failed);
    let report = run(layout, &sealer, &populated.vault);
    assert_eq!(report.outcome, Outcome::MigratedWithSkips);
    let kept = layout.webui_data.join(names::KEPT_FOLDER);
    assert_eq!(fs::read(kept.join("session.json")).unwrap(), b"pilot session");
    assert_eq!(
        fs::read(kept.join("config").join("hooks.json")).unwrap(),
        b"pilot hooks"
    );
    assert_eq!(
        fs::read(layout.webui_data.join("session.json")).unwrap(),
        fs::read(layout.rnw_data.join("session.json")).unwrap()
    );
    assert_eq!(crashed.counts.kept_aside + report.counts.kept_aside, 2);
}

#[test]
fn nothing_to_migrate_still_marks_the_profile() {
    let scratch = Scratch::new("nothing");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let report = run(&layout, &sealer, &FakeVault::empty());
    assert_eq!(report.outcome, Outcome::NothingToMigrate);
    assert!(read_marker(&layout.webui_data).is_some());
    assert!(!layout.rnw_data.exists(), "the RNW folder is never created");
    assert_eq!(
        run(&layout, &sealer, &FakeVault::empty()).outcome,
        Outcome::AlreadyMigrated
    );
}

#[test]
fn engine_launch_files_are_not_migrated_or_overwritten() {
    let scratch = Scratch::new("launch-files");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    write(
        &populated.layout.rnw_data.join("launch-guard.json"),
        b"{\"unfinishedStartsBefore\":3}\n",
    );
    write(&populated.layout.rnw_data.join("launch-starts.txt"), b"3\n");
    write(
        &populated.layout.webui_data.join("launch-guard.json"),
        b"{\"unfinishedStartsBefore\":0}\n",
    );
    let report = run(&populated.layout, &sealer, &populated.vault);
    assert_eq!(report.outcome, Outcome::MigratedWithSkips);
    assert_eq!(
        fs::read_to_string(populated.layout.webui_data.join("launch-guard.json")).unwrap(),
        "{\"unfinishedStartsBefore\":0}\n"
    );
    assert!(!populated.layout.webui_data.join("launch-starts.txt").exists());
}

#[test]
fn credentials_alone_are_migrated() {
    let scratch = Scratch::new("vault-only");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let mut vault = FakeVault::empty();
    vault.add_rnw(PREFIX, "github", b"token", 1);
    let report = run(&layout, &sealer, &vault);
    assert_eq!(report.outcome, Outcome::Migrated);
    assert_eq!(opened(&sealer, &layout.webui_data, "github").unwrap(), b"token");
}

#[test]
fn a_vault_that_cannot_be_read_fails_and_retries() {
    let scratch = Scratch::new("vault-fail");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    let mut vault = populated.vault;
    vault.fail = true;
    let failed = run(&populated.layout, &sealer, &vault);
    assert_eq!(failed.outcome, Outcome::Failed);
    assert_eq!(failed.failed_stage, Some(Stage::Credentials));
    assert_eq!(failed.exit_code(), 1);
    assert!(read_marker(&populated.layout.webui_data).is_none());
    let attempt = ardia_shell_migration::migrate::read_attempt(&populated.layout.webui_data).unwrap();
    assert_eq!(attempt["outcome"], "failed");
    assert_eq!(attempt["failed_stage"], "credentials");
    assert_eq!(attempt["attempt"], 1);
    assert!(attempt.get("prior_failed_stage").is_none());
    let again = run(&populated.layout, &sealer, &vault);
    assert_eq!(again.attempt, 2);
    assert_eq!(again.prior_failed_stage, Some(Stage::Credentials));
    vault.fail = false;
    let resumed = run(&populated.layout, &sealer, &vault);
    assert_eq!(resumed.outcome, Outcome::MigratedWithSkips);
    assert_eq!(resumed.attempt, 3);
    assert_eq!(resumed.prior_failed_stage, Some(Stage::Credentials));
    let reported = ardia_shell_migration::migrate::read_attempt(&populated.layout.webui_data).unwrap();
    assert_eq!(reported["outcome"], "migrated_with_skips");
    assert_eq!(reported["attempt"], 3);
    assert_eq!(reported["prior_failed_stage"], "credentials");
    assert_eq!(
        read_marker(&populated.layout.webui_data).unwrap()["prior_failed_stage"],
        "credentials"
    );
}

#[test]
fn a_prior_stage_comes_only_from_a_failed_attempt_report() {
    let sealer = FakeDpapi::new();
    let prior = |outcome: &str, stage: &str| {
        format!(
            "{{\"version\":1,\"run\":\"{}\",\"outcome\":\"{outcome}\",\"failed_stage\":\"{stage}\",\"attempt\":4,\"counts\":{{}}}}",
            "0123456789abcdef".repeat(2)
        )
    };
    let carried = |name: &str, text: &str| {
        let scratch = Scratch::new(name);
        let populated = populate(&scratch.0, &sealer);
        write(&populated.layout.webui_data.join(names::ATTEMPT_NAME), text.as_bytes());
        run(&populated.layout, &sealer, &populated.vault)
    };
    let failed = carried("prior-failed", &prior("failed", "documents"));
    assert_eq!(failed.attempt, 5);
    assert_eq!(failed.prior_failed_stage, Some(Stage::Documents));
    let migrated = carried("prior-migrated", &prior("migrated", "documents"));
    assert_eq!(migrated.attempt, 5);
    assert_eq!(migrated.prior_failed_stage, None);
    let unknown_stage = carried("prior-unknown-stage", &prior("failed", "C:\\\\Users"));
    assert_eq!(unknown_stage.attempt, 5);
    assert_eq!(unknown_stage.prior_failed_stage, None);
    assert!(unknown_stage.to_json().get("prior_failed_stage").is_none());
}

#[test]
fn a_previous_report_that_does_not_validate_carries_nothing() {
    let sealer = FakeDpapi::new();
    let run_id = "0123456789abcdef".repeat(2);
    let cases = [
        ("prior-version", format!("{{\"version\":2,\"run\":\"{run_id}\",\"outcome\":\"failed\",\"failed_stage\":\"lock\",\"attempt\":7,\"counts\":{{}}}}")),
        ("prior-no-version", format!("{{\"run\":\"{run_id}\",\"outcome\":\"failed\",\"failed_stage\":\"lock\",\"attempt\":7,\"counts\":{{}}}}")),
        ("prior-no-run", "{\"version\":1,\"outcome\":\"failed\",\"failed_stage\":\"lock\",\"attempt\":7,\"counts\":{}}".to_string()),
        ("prior-empty-run", "{\"version\":1,\"run\":\"\",\"outcome\":\"failed\",\"failed_stage\":\"lock\",\"attempt\":7,\"counts\":{}}".to_string()),
        ("prior-bad-run", format!("{{\"version\":1,\"run\":\"{}\",\"outcome\":\"failed\",\"failed_stage\":\"lock\",\"attempt\":7,\"counts\":{{}}}}", run_id.to_uppercase())),
        ("prior-bad-outcome", format!("{{\"version\":1,\"run\":\"{run_id}\",\"outcome\":\"exploded\",\"failed_stage\":\"lock\",\"attempt\":7,\"counts\":{{}}}}")),
        ("prior-busy", format!("{{\"version\":1,\"run\":\"{run_id}\",\"outcome\":\"busy\",\"failed_stage\":\"lock\",\"attempt\":7,\"counts\":{{}}}}")),
        ("prior-outcome-number", format!("{{\"version\":1,\"run\":\"{run_id}\",\"outcome\":3,\"failed_stage\":\"lock\",\"attempt\":7,\"counts\":{{}}}}")),
        ("prior-attempt-text", format!("{{\"version\":1,\"run\":\"{run_id}\",\"outcome\":\"failed\",\"failed_stage\":\"lock\",\"attempt\":\"7\",\"counts\":{{}}}}")),
    ];
    for (name, text) in cases {
        let scratch = Scratch::new(name);
        let populated = populate(&scratch.0, &sealer);
        write(&populated.layout.webui_data.join(names::ATTEMPT_NAME), text.as_bytes());
        let report = run(&populated.layout, &sealer, &populated.vault);
        assert_eq!(report.attempt, 1, "{name}");
        assert_eq!(report.prior_failed_stage, None, "{name}");
        assert!(
            !ardia_shell_migration::migrate::valid_attempt_report(&serde_json::from_str(&text).unwrap()),
            "{name}"
        );
    }
}

#[test]
fn a_corrupt_marker_is_not_trusted() {
    let scratch = Scratch::new("corrupt-marker");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    write(&populated.layout.webui_data.join(names::MARKER_NAME), b"{\"version\":1");
    let report = run(&populated.layout, &sealer, &populated.vault);
    assert_eq!(report.outcome, Outcome::MigratedWithSkips);
    write(
        &populated.layout.webui_data.join(names::MARKER_NAME),
        b"{\"version\":99}",
    );
    assert_eq!(
        run(&populated.layout, &sealer, &populated.vault).outcome,
        Outcome::MigratedWithSkips
    );
}

#[test]
fn the_report_carries_only_enums_and_counts() {
    let scratch = Scratch::new("report");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    let report = run(&populated.layout, &sealer, &populated.vault);
    let json = report.to_json();
    let object = json.as_object().unwrap();
    let keys: Vec<&str> = object.keys().map(String::as_str).collect();
    assert_eq!(keys, ["attempt", "counts", "duration_ms", "outcome", "run", "version"]);
    assert!(json["run"].as_str().unwrap().bytes().all(|b| b.is_ascii_hexdigit()));
    for (_, value) in json["counts"].as_object().unwrap() {
        assert!(value.is_u64());
    }
    let text = fs::read_to_string(populated.layout.webui_data.join(names::MARKER_NAME)).unwrap();
    for leak in ["github", "Local", "Roaming", "token", "session", "\\", "/"] {
        assert!(!text.contains(leak), "the marker names {leak}");
    }
    assert!(matches!(json["outcome"], Value::String(_)));
}

#[test]
fn overlapping_or_relative_folders_are_refused() {
    let scratch = Scratch::new("overlap");
    let sealer = FakeDpapi::new();
    let base = layout(&scratch.0);
    let inside = Layout {
        webui_data: base.rnw_data.join("WebUI"),
        ..base.clone()
    };
    let user_data = Layout {
        webui_data: base.rnw_data.join("User Data"),
        ..base.clone()
    };
    let config = Layout {
        webui_data: base.rnw_config.clone(),
        ..base.clone()
    };
    let parent = Layout {
        webui_data: scratch.0.join("Local"),
        ..base.clone()
    };
    let relative = Layout {
        webui_data: "Ardia WebUI".into(),
        ..base.clone()
    };
    let dotted = Layout {
        webui_data: base.rnw_data.join("..").join("Ardia"),
        ..base.clone()
    };
    let cased = Layout {
        webui_data: scratch.0.join("LOCAL").join("ARDIA"),
        ..base.clone()
    };
    for layout in [inside, user_data, config, parent, relative, dotted, cased] {
        let report = run(&layout, &sealer, &FakeVault::empty());
        assert_eq!(report.outcome, Outcome::Refused, "{layout:?}");
        assert_eq!(report.exit_code(), 2);
    }
}

#[test]
fn a_second_run_waits_for_the_lock() {
    let scratch = Scratch::new("lock");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    fs::create_dir_all(&populated.layout.webui_data).unwrap();
    let held = fs::File::create(populated.layout.webui_data.join(names::LOCK_NAME)).unwrap();
    held.lock().unwrap();
    let report = run(&populated.layout, &sealer, &populated.vault);
    assert_eq!(report.outcome, Outcome::Busy);
    assert_eq!(report.exit_code(), 3);
    assert!(!populated.layout.webui_data.join("session.json").exists());
    held.unlock().unwrap();
    assert_eq!(
        run(&populated.layout, &sealer, &populated.vault).outcome,
        Outcome::MigratedWithSkips
    );
}

#[test]
fn oversized_documents_are_skipped_not_truncated() {
    let scratch = Scratch::new("large");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    write(&layout.rnw_data.join("session.json"), b"{}");
    let big = fs::File::create(layout.rnw_data.join("huge.json")).unwrap();
    big.set_len(ardia_shell_migration::migrate::DOCUMENT_LIMIT + 1).unwrap();
    drop(big);
    let report = run(&layout, &sealer, &FakeVault::empty());
    assert_eq!(report.outcome, Outcome::MigratedWithSkips);
    assert_eq!(report.counts.skipped_too_large, 1);
    assert!(!layout.webui_data.join("huge.json").exists());
}

#[test]
fn names_that_differ_only_in_case_are_not_both_copied() {
    let scratch = Scratch::new("case");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    write(&layout.rnw_data.join("session.json"), b"lower");
    fs::write(layout.rnw_data.join("Session.json"), b"upper").unwrap();
    let distinct = fs::read_dir(&layout.rnw_data).unwrap().count() == 2;
    let report = run(&layout, &sealer, &FakeVault::empty());
    if distinct {
        assert_eq!(report.counts.skipped_case_clash, 1);
        assert_eq!(report.counts.documents, 1);
    } else {
        assert_eq!(report.counts.skipped_case_clash, 0);
    }
}

#[test]
fn a_custom_data_directory_reads_its_own_credentials() {
    let scratch = Scratch::new("custom");
    let sealer = FakeDpapi::new();
    let rnw = scratch.0.join("rnw-scratch");
    let webui = scratch.0.join("webui-scratch");
    let rnw_text = rnw.to_string_lossy().to_string();
    let layout = Layout::custom(&rnw_text, &webui, true);
    write(&rnw.join("session.json"), b"scratch session");
    write(&rnw.join("config").join("config.json"), b"{}");
    let sealed = sealer.seal_key("acct", true);
    write(&rnw.join("Sync").join("sync-key-acct.dpapi"), &sealed);
    let mut vault = FakeVault::empty();
    vault.add_rnw(&layout.credential_prefix, "github", b"scratch token", 2);
    vault.add_rnw(PREFIX, "github", b"real token", 2);
    let report = run(&layout, &sealer, &vault);
    assert_eq!(report.outcome, Outcome::Migrated, "{report:?}");
    assert_eq!(report.counts.sync_keys, 1);
    use ardia_shell_migration::Sealer;
    let sealed = fs::read(webui.join("Secrets").join(names::secret_file("github"))).unwrap();
    assert_eq!(
        sealer
            .open(&sealed, &names::secret_purpose("github", true))
            .unwrap()
            .as_slice(),
        b"scratch token"
    );
    assert!(sealer.open(&sealed, &names::secret_purpose("github", false)).is_none());
    assert_eq!(fs::read(webui.join("config").join("config.json")).unwrap(), b"{}");
}

trait SealKey {
    fn seal_key(&self, account: &str, test_instance: bool) -> Vec<u8>;
}

impl SealKey for FakeDpapi {
    fn seal_key(&self, account: &str, test_instance: bool) -> Vec<u8> {
        use ardia_shell_migration::Sealer;
        self.seal(&[3u8; 32], &names::sync_purpose(account, test_instance))
            .unwrap()
    }
}

#[cfg(unix)]
mod links {
    use std::os::unix::fs::symlink;

    use super::*;

    #[test]
    fn links_in_the_rnw_data_are_never_followed() {
        let scratch = Scratch::new("links");
        let sealer = FakeDpapi::new();
        let layout = layout(&scratch.0);
        let outside = scratch.0.join("outside");
        write(&outside.join("secret.txt"), b"private");
        write(&outside.join("sync-key-abc.dpapi"), &sealer.seal_key("abc", false));
        write(&layout.rnw_data.join("session.json"), b"{}");
        symlink(outside.join("secret.txt"), layout.rnw_data.join("stolen.json")).unwrap();
        symlink(&outside, layout.rnw_data.join("Sync")).unwrap();
        write(&layout.rnw_config.join("config.json"), b"{}");
        symlink(&outside, layout.rnw_config.join("themes")).unwrap();
        fs::hard_link(outside.join("secret.txt"), layout.rnw_data.join("hard.json")).unwrap();
        let report = run(&layout, &sealer, &FakeVault::empty());
        assert_eq!(report.outcome, Outcome::MigratedWithSkips, "{report:?}");
        assert_eq!(report.counts.skipped_links, 3);
        assert_eq!(report.counts.skipped_invalid, 1);
        assert_eq!(report.counts.documents, 1);
        for leaked in ["stolen.json", "hard.json", "Sync", "config/themes"] {
            assert!(!layout.webui_data.join(leaked).exists(), "{leaked}");
        }
    }

    #[test]
    fn a_linked_rnw_or_webui_root_is_refused() {
        let scratch = Scratch::new("root-links");
        let sealer = FakeDpapi::new();
        let layout = layout(&scratch.0);
        let elsewhere = scratch.0.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir_all(layout.rnw_data.parent().unwrap()).unwrap();
        symlink(&elsewhere, &layout.rnw_data).unwrap();
        assert_eq!(run(&layout, &sealer, &FakeVault::empty()).outcome, Outcome::Refused);
        fs::remove_file(&layout.rnw_data).unwrap();
        write(&layout.rnw_data.join("session.json"), b"{}");
        symlink(&elsewhere, &layout.webui_data).unwrap();
        assert_eq!(run(&layout, &sealer, &FakeVault::empty()).outcome, Outcome::Refused);
        assert_eq!(
            fs::read_dir(&elsewhere).unwrap().count(),
            0,
            "nothing was written through the link"
        );
    }

    #[test]
    fn links_inside_the_webui_data_are_never_written_through() {
        let scratch = Scratch::new("webui-links");
        let sealer = FakeDpapi::new();
        let populated = populate(&scratch.0, &sealer);
        let layout = &populated.layout;
        let outside = scratch.0.join("outside");
        write(&outside.join("keep.txt"), b"keep");
        fs::create_dir_all(&layout.webui_data).unwrap();
        symlink(&outside, layout.webui_data.join(names::SECRETS_FOLDER)).unwrap();
        symlink(outside.join("keep.txt"), layout.webui_data.join("history-index.json")).unwrap();
        let report = run(layout, &sealer, &populated.vault);
        assert_eq!(report.outcome, Outcome::Failed);
        assert_eq!(report.failed_stage, Some(Stage::Credentials));
        assert_eq!(
            tree(&outside).len(),
            1,
            "nothing landed outside: {:?}",
            tree(&outside).keys()
        );
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
        assert!(read_marker(&layout.webui_data).is_none());
        fs::remove_file(layout.webui_data.join(names::SECRETS_FOLDER)).unwrap();
        let resumed = run(layout, &sealer, &populated.vault);
        assert_eq!(resumed.outcome, Outcome::MigratedWithSkips);
        assert!(resumed.counts.skipped_links >= 1);
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
    }

    #[test]
    fn a_linked_marker_or_lock_is_refused() {
        let scratch = Scratch::new("marker-link");
        let sealer = FakeDpapi::new();
        let layout = layout(&scratch.0);
        write(&layout.rnw_data.join("session.json"), b"{}");
        let outside = scratch.0.join("outside.json");
        write(&outside, b"{\"version\":1}");
        fs::create_dir_all(&layout.webui_data).unwrap();
        symlink(&outside, layout.webui_data.join(names::MARKER_NAME)).unwrap();
        assert_eq!(run(&layout, &sealer, &FakeVault::empty()).outcome, Outcome::Refused);
        fs::remove_file(layout.webui_data.join(names::MARKER_NAME)).unwrap();
        let _ = fs::remove_file(layout.webui_data.join(names::LOCK_NAME));
        symlink(&outside, layout.webui_data.join(names::LOCK_NAME)).unwrap();
        assert_eq!(run(&layout, &sealer, &FakeVault::empty()).outcome, Outcome::Refused);
        assert_eq!(fs::read(&outside).unwrap(), b"{\"version\":1}");
    }
}

#[test]
fn a_stop_between_the_report_and_the_marker_resumes_with_both() {
    let sealer = FakeDpapi::new();
    let mut total = 0;
    for fail_at in 1..100 {
        let scratch = Scratch::new("report-marker");
        let populated = populate(&scratch.0, &sealer);
        let faults = Faults {
            fail_at_commit: Some(fail_at),
        };
        if migrate(&populated.layout, &sealer, &populated.vault, &faults).outcome != Outcome::Failed {
            total = fail_at - 1;
            break;
        }
    }
    assert!(total > 2);
    let stopped_root = Scratch::new("report-marker-stop");
    let stopped = populate(&stopped_root.0, &sealer);
    let before_report = Scratch::new("report-marker-before");
    let early = populate(&before_report.0, &sealer);
    let report = migrate(
        &early.layout,
        &sealer,
        &early.vault,
        &Faults {
            fail_at_commit: Some(total - 1),
        },
    );
    assert_eq!(report.failed_stage, Some(Stage::Report));
    let failed = ardia_shell_migration::migrate::read_attempt(&early.layout.webui_data).unwrap();
    assert_eq!(failed["outcome"], "failed");
    assert_eq!(failed["failed_stage"], "report");
    assert!(read_marker(&early.layout.webui_data).is_none());
    let report = migrate(
        &stopped.layout,
        &sealer,
        &stopped.vault,
        &Faults {
            fail_at_commit: Some(total),
        },
    );
    assert_eq!(report.outcome, Outcome::Failed);
    assert_eq!(report.failed_stage, Some(Stage::Marker));
    let written = ardia_shell_migration::migrate::read_attempt(&stopped.layout.webui_data).unwrap();
    assert_eq!(
        written["outcome"], "failed",
        "a marker that couldn't be written replaces the success report"
    );
    assert_eq!(written["failed_stage"], "marker");
    assert_eq!(written["counts"]["documents"], 2);
    assert!(read_marker(&stopped.layout.webui_data).is_none());
    let resumed = run(&stopped.layout, &sealer, &stopped.vault);
    assert_eq!(resumed.outcome, Outcome::MigratedWithSkips);
    assert_eq!(resumed.attempt, 2);
    let attempt = ardia_shell_migration::migrate::read_attempt(&stopped.layout.webui_data).unwrap();
    assert_eq!(attempt["run"], read_marker(&stopped.layout.webui_data).unwrap()["run"]);
    assert_eq!(attempt["attempt"], 2);
}

#[cfg(unix)]
mod ancestors {
    use std::os::unix::fs::symlink;

    use super::*;

    #[test]
    fn a_linked_folder_above_any_root_is_refused() {
        let scratch = Scratch::new("ancestor");
        let sealer = FakeDpapi::new();
        let real = scratch.0.join("real");
        write(&real.join("Local").join("Ardia").join("session.json"), b"{}");
        fs::create_dir_all(real.join("Roaming")).unwrap();
        let linked = scratch.0.join("linked");
        symlink(&real, &linked).unwrap();
        let through = Layout::standard(&linked.join("Local"), &linked.join("Roaming"), false);
        assert_eq!(run(&through, &sealer, &FakeVault::empty()).outcome, Outcome::Refused);
        assert!(
            !real.join("Local").join("Ardia WebUI").exists(),
            "nothing was created through the link"
        );

        let plain = Layout::standard(&real.join("Local"), &real.join("Roaming"), false);
        let elsewhere = scratch.0.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let webui_parent = scratch.0.join("webui-parent");
        symlink(&elsewhere, &webui_parent).unwrap();
        let linked_webui = Layout {
            webui_data: webui_parent.join("Ardia WebUI"),
            ..plain.clone()
        };
        assert_eq!(
            run(&linked_webui, &sealer, &FakeVault::empty()).outcome,
            Outcome::Refused
        );
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);

        let config_parent = scratch.0.join("config-parent");
        symlink(real.join("Roaming"), &config_parent).unwrap();
        let linked_config = Layout {
            rnw_config: config_parent.join("Ardia"),
            ..plain.clone()
        };
        assert_eq!(
            run(&linked_config, &sealer, &FakeVault::empty()).outcome,
            Outcome::Refused
        );
        assert_eq!(run(&plain, &sealer, &FakeVault::empty()).outcome, Outcome::Migrated);
    }

    #[test]
    fn the_sweep_never_reaches_through_a_link() {
        let scratch = Scratch::new("sweep");
        let sealer = FakeDpapi::new();
        let populated = populate(&scratch.0, &sealer);
        let layout = &populated.layout;
        let outside = scratch.0.join("outside");
        let planted = format!(".config.json.abc{}", names::PARTIAL_SUFFIX);
        write(&outside.join(&planted), b"not ours");
        write(&outside.join("themes").join(&planted), b"not ours");
        fs::create_dir_all(layout.webui_data.join(names::KEPT_FOLDER)).unwrap();
        symlink(
            &outside,
            layout.webui_data.join(names::KEPT_FOLDER).join(names::CONFIG_FOLDER),
        )
        .unwrap();
        symlink(&outside, layout.webui_data.join(names::CONFIG_FOLDER)).unwrap();
        let report = run(layout, &sealer, &populated.vault);
        assert_eq!(report.outcome, Outcome::Failed);
        assert_eq!(report.counts.partials_swept, 0);
        assert_eq!(fs::read(outside.join(&planted)).unwrap(), b"not ours");
        assert_eq!(fs::read(outside.join("themes").join(&planted)).unwrap(), b"not ours");
        assert_eq!(tree(&outside).len(), 3, "{:?}", tree(&outside).keys());
    }

    #[test]
    fn a_folder_swapped_for_a_link_mid_run_is_not_written_through() {
        let scratch = Scratch::new("swap");
        let outside = scratch.0.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let webui = scratch.0.join("webui");
        let root = ardia_shell_migration::fsafe::Root::open_or_create(&webui).unwrap();
        let held = root.folder(&[names::SYNC_FOLDER], true).unwrap().unwrap();
        let sync = webui.join(names::SYNC_FOLDER);
        fs::rename(&sync, webui.join("moved")).unwrap();
        symlink(&outside, &sync).unwrap();
        held.write("x.dpapi", b"secret").unwrap();
        assert_eq!(
            fs::read(webui.join("moved").join("x.dpapi")).unwrap(),
            b"secret",
            "the write stays on the held folder"
        );
        assert_eq!(
            fs::read_dir(&outside).unwrap().count(),
            0,
            "nothing went through the link"
        );
        assert!(
            root.folder(&[names::SYNC_FOLDER], false).is_err(),
            "opening the swapped name again is refused"
        );
        let staged = root.folder(&["moved"], false).unwrap().unwrap();
        fs::remove_dir_all(webui.join("moved")).unwrap();
        assert!(
            staged.write("y.dpapi", b"secret").is_err(),
            "a removed folder takes no writes"
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }
}

#[test]
fn a_newer_pilot_copy_is_kept_beside_the_older_one() {
    let scratch = Scratch::new("kept-newer");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    let layout = &populated.layout;
    write(&layout.webui_data.join("session.json"), b"pilot one");
    let first = migrate(
        layout,
        &sealer,
        &populated.vault,
        &Faults {
            fail_at_commit: Some(3),
        },
    );
    assert_eq!(first.outcome, Outcome::Failed);
    let kept = layout.webui_data.join(names::KEPT_FOLDER);
    assert_eq!(fs::read(kept.join("session.json")).unwrap(), b"pilot one");
    write(
        &layout.webui_data.join("session.json"),
        b"pilot two, written after the first try",
    );
    let second = run(layout, &sealer, &populated.vault);
    assert_eq!(second.outcome, Outcome::MigratedWithSkips);
    assert_eq!(fs::read(kept.join("session.json")).unwrap(), b"pilot one");
    let newer: Vec<String> = tree(&kept)
        .into_iter()
        .filter(|(name, bytes)| name.starts_with("session.json.") && bytes == b"pilot two, written after the first try")
        .map(|(name, _)| name)
        .collect();
    assert_eq!(newer.len(), 1, "{:?}", tree(&kept).keys());
    assert!(newer[0].ends_with(".kept"));
    assert_eq!(
        fs::read(layout.webui_data.join("session.json")).unwrap(),
        fs::read(layout.rnw_data.join("session.json")).unwrap()
    );
}

#[test]
fn a_destination_name_of_255_characters_stages_and_lands() {
    let scratch = Scratch::new("long-name");
    let root = ardia_shell_migration::fsafe::Root::open_or_create(&scratch.0.join("webui")).unwrap();
    let name = names::secret_file(&"a".repeat(120));
    assert_eq!(name.len(), 255);
    root.dir().write(&name, b"sealed").unwrap();
    assert_eq!(
        fs::read(long_path(&scratch.0.join("webui").join(&name))).unwrap(),
        b"sealed"
    );
    root.dir().write(&name, b"sealed again").unwrap();
    assert_eq!(
        fs::read(long_path(&scratch.0.join("webui").join(&name))).unwrap(),
        b"sealed again"
    );
}

#[test]
fn a_255_character_secret_conflicting_twice_is_kept_twice() {
    let scratch = Scratch::new("long-kept");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let account = "a".repeat(120);
    let mut vault = FakeVault::empty();
    vault.add_rnw(PREFIX, &account, b"real token", 1);
    let target = layout
        .webui_data
        .join(names::SECRETS_FOLDER)
        .join(names::secret_file(&account));
    let pilot = |bytes: &[u8]| {
        fs::create_dir_all(layout.webui_data.join(names::SECRETS_FOLDER)).unwrap();
        fs::write(long_path(&target), bytes).unwrap();
    };
    pilot(b"pilot one");
    let first = migrate(
        &layout,
        &sealer,
        &vault,
        &Faults {
            fail_at_commit: Some(2),
        },
    );
    assert_eq!(first.outcome, Outcome::Failed, "{first:?}");
    pilot(b"pilot two");
    let second = run(&layout, &sealer, &vault);
    assert_eq!(second.outcome, Outcome::Migrated, "{second:?}");
    let kept = tree(&long_path(
        &layout.webui_data.join(names::KEPT_FOLDER).join(names::SECRETS_FOLDER),
    ));
    let mut found: Vec<&[u8]> = kept.values().map(Vec::as_slice).collect();
    found.sort();
    assert_eq!(found, vec![b"pilot one".as_slice(), b"pilot two".as_slice()]);
    assert!(kept.keys().all(|name| name.encode_utf16().count() <= 255));
    assert_eq!(opened(&sealer, &layout.webui_data, &account).unwrap(), b"real token");
}

#[test]
fn an_empty_run_still_sweeps_its_staged_files() {
    let scratch = Scratch::new("empty-sweep");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let leftover = format!(".ardia-mig-1-1-abcd{}", names::PARTIAL_SUFFIX);
    write(&layout.webui_data.join(&leftover), b"half");
    let report = run(&layout, &sealer, &FakeVault::empty());
    assert_eq!(report.outcome, Outcome::NothingToMigrate);
    assert_eq!(report.counts.partials_swept, 1);
    assert!(!layout.webui_data.join(&leftover).exists());
}

#[test]
fn a_one_character_destination_stages_and_lands() {
    let scratch = Scratch::new("one-char");
    let root = ardia_shell_migration::fsafe::Root::open_or_create(&scratch.0.join("webui")).unwrap();
    for (name, bytes) in [
        ("a", b"first".as_slice()),
        ("a", b"replaced".as_slice()),
        ("ab", b"two".as_slice()),
    ] {
        root.dir().write(name, bytes).unwrap();
        assert_eq!(fs::read(scratch.0.join("webui").join(name)).unwrap(), bytes);
    }
    write(&scratch.0.join("rnw").join("b"), b"one letter document");
    let layout = Layout::custom(
        &scratch.0.join("rnw").to_string_lossy(),
        &scratch.0.join("webui2"),
        false,
    );
    let report = run(&layout, &FakeDpapi::new(), &FakeVault::empty());
    assert_eq!(report.outcome, Outcome::Migrated, "{report:?}");
    assert_eq!(
        fs::read(scratch.0.join("webui2").join("b")).unwrap(),
        b"one letter document"
    );
}

#[test]
fn a_prior_attempt_at_the_top_of_u64_does_not_overflow() {
    let scratch = Scratch::new("attempt-max");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    let prior = format!(
        "{{\"version\":1,\"run\":\"{}\",\"outcome\":\"failed\",\"attempt\":{},\"counts\":{{}}}}",
        "0".repeat(32),
        u64::MAX
    );
    write(&populated.layout.webui_data.join(names::ATTEMPT_NAME), prior.as_bytes());
    let report = run(&populated.layout, &sealer, &populated.vault);
    assert_eq!(report.outcome, Outcome::MigratedWithSkips);
    assert_eq!(report.attempt, 1_000_000);
}

#[test]
fn the_sweep_removes_only_the_migrators_own_staged_files() {
    let scratch = Scratch::new("own-partials");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let own = format!(".ardia-mig-1-2-abcd{}", names::PARTIAL_SUFFIX);
    let theirs = [".draft.partial".to_string(), format!(".draft{}", names::PARTIAL_SUFFIX)];
    write(&layout.webui_data.join(&own), b"ours");
    for name in &theirs {
        write(&layout.webui_data.join(name), b"someone else's");
    }
    let report = run(&layout, &sealer, &FakeVault::empty());
    assert_eq!(report.counts.partials_swept, 1);
    assert!(!layout.webui_data.join(&own).exists());
    for name in &theirs {
        assert_eq!(
            fs::read(layout.webui_data.join(name)).unwrap(),
            b"someone else's",
            "{name}"
        );
    }
}

#[test]
fn an_unchanged_pilot_copy_reuses_its_backup_and_a_changed_one_gets_its_own() {
    let scratch = Scratch::new("kept-reuse");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    let layout = &populated.layout;
    let session = layout.webui_data.join("session.json");
    let kept = layout.webui_data.join(names::KEPT_FOLDER);
    let stop = |at| {
        migrate(
            layout,
            &sealer,
            &populated.vault,
            &Faults {
                fail_at_commit: Some(at),
            },
        )
    };
    write(&session, b"pilot A");
    assert_eq!(stop(3).outcome, Outcome::Failed);
    write(&session, b"pilot B");
    assert_eq!(stop(3).outcome, Outcome::Failed);
    write(&session, b"pilot B");
    assert_eq!(stop(2).outcome, Outcome::Failed);
    let backups = |tree: std::collections::BTreeMap<String, Vec<u8>>| {
        let mut found: Vec<Vec<u8>> = tree
            .into_iter()
            .filter(|(name, _)| name.starts_with("session.json"))
            .map(|(_, bytes)| bytes)
            .collect();
        found.sort();
        found
    };
    assert_eq!(
        backups(tree(&kept)),
        vec![b"pilot A".to_vec(), b"pilot B".to_vec()],
        "B is kept once across retries"
    );
    write(&session, b"pilot C");
    let done = run(layout, &sealer, &populated.vault);
    assert_eq!(done.outcome, Outcome::MigratedWithSkips);
    assert_eq!(
        backups(tree(&kept)),
        vec![b"pilot A".to_vec(), b"pilot B".to_vec(), b"pilot C".to_vec()]
    );
    assert!(tree(&kept).keys().all(|name| name.encode_utf16().count() <= 255));
}

#[test]
fn a_different_file_already_at_the_backup_name_is_never_overwritten() {
    let scratch = Scratch::new("kept-collision");
    let sealer = FakeDpapi::new();
    let populated = populate(&scratch.0, &sealer);
    let layout = &populated.layout;
    let kept = layout.webui_data.join(names::KEPT_FOLDER);
    write(&kept.join("session.json"), b"pilot A");
    let tagged = ardia_shell_migration::migrate::kept_name(
        "session.json",
        &ardia_shell_migration::migrate::content_tag(b"pilot B"),
    );
    write(&kept.join(&tagged), b"something else that got this name");
    write(&layout.webui_data.join("session.json"), b"pilot B");
    let report = run(layout, &sealer, &populated.vault);
    assert_eq!(report.outcome, Outcome::MigratedWithSkips);
    assert_eq!(
        fs::read(kept.join(&tagged)).unwrap(),
        b"something else that got this name"
    );
    assert_eq!(fs::read(kept.join("session.json")).unwrap(), b"pilot A");
    let holders: Vec<String> = tree(&kept)
        .into_iter()
        .filter(|(_, bytes)| bytes == b"pilot B")
        .map(|(name, _)| name)
        .collect();
    assert_eq!(holders.len(), 1, "{:?}", tree(&kept).keys());
    assert_ne!(holders[0], tagged);
    assert!(holders[0].encode_utf16().count() <= 255);
    let again = layout.webui_data.join("session.json");
    write(&again, b"pilot B");
    fs::remove_file(layout.webui_data.join(names::MARKER_NAME)).unwrap();
    run(layout, &sealer, &populated.vault);
    assert_eq!(
        tree(&kept)
            .values()
            .filter(|bytes| bytes.as_slice() == b"pilot B")
            .count(),
        1,
        "the second backup is reused"
    );
}
