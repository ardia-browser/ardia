mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use ardia_shell_migration::{migrate, names, Faults, Outcome, Sealer};
use common::*;

fn corpus() -> Vec<String> {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../scripts/security/hostile-inputs.mjs");
    let script = fs::canonicalize(&script).expect("the shared hostile corpus is in the repository");
    let program = "const { pathToFileURL } = await import('node:url'); \
        const corpus = await import(pathToFileURL(process.argv[1]).href); \
        process.stdout.write(JSON.stringify(corpus.HOSTILE_STRINGS.map((entry) => [...Buffer.from(String(entry.value), 'utf8')])));";
    let output = Command::new("node")
        .args(["--input-type=module", "-e", program])
        .arg(&script)
        .output()
        .expect("node reads the shared hostile corpus");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let bytes: Vec<Vec<u8>> = serde_json::from_slice(&output.stdout).unwrap();
    let values: Vec<String> = bytes
        .into_iter()
        .map(|value| String::from_utf8(value).unwrap())
        .collect();
    assert!(values.len() > 20, "the corpus came back with {} values", values.len());
    values
}

fn plantable(name: &str) -> bool {
    names::plain_file_name(name)
        && !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() < 200
        && !name.contains(['/', '\\', '\0', ':', '*', '?', '"', '<', '>', '|'])
        && !name.chars().any(|c| (c as u32) < 32)
}

fn plant(path: PathBuf, bytes: &[u8]) {
    let _ = fs::write(path, bytes);
}

fn hex_name(name: &str, prefix: &str, suffix: &str) -> bool {
    name.strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix(suffix))
        .is_some_and(|hex| {
            !hex.is_empty()
                && hex.len() % 2 == 0
                && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

#[test]
fn the_shared_hostile_corpus_never_lands_outside_the_webui_layout() {
    let hostile = corpus();
    let scratch = Scratch::new("hostile");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    write(&layout.rnw_data.join("session.json"), b"{\"positive\":true}");
    write(&layout.rnw_config.join("config.json"), b"{}");
    fs::create_dir_all(layout.rnw_config.join("themes")).unwrap();
    fs::create_dir_all(layout.rnw_data.join("Sync")).unwrap();
    let mut vault = FakeVault::empty();
    vault.add_rnw(PREFIX, "github", b"control token", 1);
    for value in &hostile {
        vault.add_rnw(PREFIX, value, b"hostile secret", 1);
        if plantable(value) {
            plant(layout.rnw_data.join(value), b"hostile document");
            plant(layout.rnw_config.join("themes").join(format!("{value}.json")), b"{}");
            let key = sealer.seal(&[4u8; 32], &names::sync_purpose(value, false)).unwrap();
            plant(
                layout.rnw_data.join("Sync").join(format!("sync-key-{value}.dpapi")),
                &key,
            );
        }
    }
    let outside_before: Vec<String> = tree(&scratch.0)
        .into_keys()
        .filter(|path| !path.starts_with("Local/Ardia WebUI"))
        .collect();
    let rnw_before = tree(&layout.rnw_data);

    let report = migrate(&layout, &sealer, &vault, &Faults::default());
    assert!(
        matches!(report.outcome, Outcome::Migrated | Outcome::MigratedWithSkips),
        "{report:?}"
    );

    let outside_after: Vec<String> = tree(&scratch.0)
        .into_keys()
        .filter(|path| !path.starts_with("Local/Ardia WebUI"))
        .collect();
    assert_eq!(
        outside_after, outside_before,
        "nothing appeared or vanished outside the WebUI folder"
    );
    assert_eq!(tree(&layout.rnw_data), rnw_before, "the RNW folder is untouched");

    let webui = tree(&layout.webui_data);
    for path in webui.keys() {
        let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
        let allowed = match parts.as_slice() {
            [name] if path.ends_with('/') => {
                [names::CONFIG_FOLDER, names::SYNC_FOLDER, names::SECRETS_FOLDER].contains(name)
            }
            [name] => {
                [names::MARKER_NAME, names::ATTEMPT_NAME, names::LOCK_NAME].contains(name) || names::document_name(name)
            }
            ["config", "themes"] => path.ends_with('/'),
            ["config", name] => names::CONFIG_FILES.contains(name),
            ["config", "themes", name] => names::theme_file_name(name),
            ["Sync", name] => hex_name(name, "sync-key-x", ".dpapi"),
            ["Secrets", name] => hex_name(name, "account-x", ".dpapi"),
            _ => false,
        };
        assert!(allowed, "an unexpected file landed in the WebUI folder: {path:?}");
        assert!(parts.iter().all(|part| part.encode_utf16().count() <= 255), "{path:?}");
    }

    assert_eq!(
        webui.get("session.json").map(Vec::as_slice),
        Some(b"{\"positive\":true}".as_slice()),
        "positive control"
    );
    let control = fs::read(layout.webui_data.join("Secrets").join(names::secret_file("github"))).unwrap();
    assert_eq!(
        sealer
            .open(&control, &names::secret_purpose("github", false))
            .unwrap()
            .as_slice(),
        b"control token"
    );
    for value in &hostile {
        if !names::secret_account(value) {
            continue;
        }
        let file = layout.webui_data.join("Secrets").join(names::secret_file(value));
        let Ok(sealed) = fs::read(&file) else {
            continue;
        };
        assert_eq!(
            sealer
                .open(&sealed, &names::secret_purpose(value, false))
                .unwrap()
                .as_slice(),
            b"hostile secret",
            "{value:?} was sealed for its own account"
        );
    }
}
