#![cfg(windows)]

mod common;

use std::fs;
use std::process::Command;

use ardia_shell_migration::credentials::{self, assemble, Assembled};
use ardia_shell_migration::windows::{delete_generic, write_generic, CredentialManager, Dpapi};
use ardia_shell_migration::{migrate, names, Faults, Layout, Outcome, Sealer, Vault};
use common::*;

const NO_LOGON_SESSION: i32 = 1312;

#[test]
fn dpapi_binds_secrets_to_their_purpose() {
    let sealed = Dpapi.seal(b"secret bytes", "ardia-connected-account/v1/a").unwrap();
    assert!(!sealed.windows(12).any(|w| w == b"secret bytes"));
    assert_eq!(
        Dpapi.open(&sealed, "ardia-connected-account/v1/a").unwrap().as_slice(),
        b"secret bytes"
    );
    assert!(Dpapi.open(&sealed, "ardia-connected-account/v1/b").is_none());
    assert!(Dpapi
        .open(&sealed[..sealed.len() - 1], "ardia-connected-account/v1/a")
        .is_none());
    assert_ne!(
        Dpapi.seal(b"secret bytes", "p").unwrap(),
        Dpapi.seal(b"secret bytes", "p").unwrap()
    );
}

struct Cleanup(Vec<String>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        for target in &self.0 {
            delete_generic(target);
        }
    }
}

fn write_rnw(prefix: &str, account: &str, secret: &[u8], generation: usize, cleanup: &mut Cleanup) -> bool {
    for part in credentials::rnw_layout(prefix, account, secret, generation) {
        cleanup.0.push(part.target.clone());
        if let Err(error) = write_generic(&part.target, part.comment.as_deref(), account, &part.blob) {
            assert_eq!(error.raw_os_error(), Some(NO_LOGON_SESSION), "{error}");
            eprintln!("Credential Manager has no logon session here: skipped");
            return false;
        }
    }
    true
}

#[test]
fn credential_manager_chunks_assemble_from_the_real_vault() {
    let scratch = Scratch::new("vault");
    let rnw = scratch.0.join("rnw");
    let prefix = names::credential_prefix(Some(&rnw.to_string_lossy()));
    let mut cleanup = Cleanup(Vec::new());
    let big = big_secret(credentials::CHUNK_BYTES * 3 + 11, 4);
    if !write_rnw(&prefix, "github", b"short", 1, &mut cleanup) || !write_rnw(&prefix, "google", &big, 2, &mut cleanup)
    {
        return;
    }
    let listed = CredentialManager.list(&prefix).unwrap();
    assert_eq!(listed.len(), 5);
    let mut found: Vec<(String, Vec<u8>)> = assemble(&prefix, listed)
        .into_iter()
        .filter_map(|a| match a {
            Assembled::Secret { account, secret } => Some((account, secret.to_vec())),
            _ => None,
        })
        .collect();
    found.sort();
    assert_eq!(
        found,
        vec![("github".into(), b"short".to_vec()), ("google".into(), big.clone())]
    );

    let webui = scratch.0.join("webui");
    let layout = Layout::custom(&rnw.to_string_lossy(), &webui, false);
    fs::create_dir_all(&rnw).unwrap();
    let report = migrate(&layout, &Dpapi, &CredentialManager, &Faults::default());
    assert_eq!(report.outcome, Outcome::Migrated, "{report:?}");
    let sealed = fs::read(webui.join("Secrets").join(names::secret_file("google"))).unwrap();
    assert_eq!(
        Dpapi
            .open(&sealed, &names::secret_purpose("google", false))
            .unwrap()
            .as_slice(),
        big.as_slice()
    );
    assert_eq!(
        CredentialManager.list(&prefix).unwrap().len(),
        5,
        "the RNW items are still there for a rollback"
    );
}

#[test]
fn an_empty_vault_lists_nothing() {
    match CredentialManager.list("Ardia Shell Migration Test That Does Not Exist/") {
        Ok(listed) => assert!(listed.is_empty()),
        Err(error) if error.raw_os_error() == Some(NO_LOGON_SESSION) => {
            eprintln!("Credential Manager has no logon session here: skipped")
        }
        Err(error) => panic!("{error}"),
    }
}

fn junction(link: &std::path::Path, target: &std::path::Path) {
    let status = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stderr));
}

#[test]
fn junctions_are_never_followed_on_either_side() {
    let scratch = Scratch::new("junction");
    let layout = Layout::custom(
        &scratch.0.join("rnw").to_string_lossy(),
        &scratch.0.join("webui"),
        false,
    );
    let outside = scratch.0.join("outside");
    write(
        &outside.join("sync-key-abc.dpapi"),
        &Dpapi.seal(&[1u8; 32], &names::sync_purpose("abc", false)).unwrap(),
    );
    write(&outside.join("session.json"), b"outside");
    write(&layout.rnw_data.join("session.json"), b"{}");
    junction(&layout.rnw_data.join("Sync"), &outside);
    junction(&layout.rnw_data.join("linked.json"), &outside);
    let report = migrate(&layout, &Dpapi, &CredentialManager, &Faults::default());
    assert_eq!(report.outcome, Outcome::MigratedWithSkips, "{report:?}");
    assert_eq!(report.counts.skipped_links, 2);
    assert!(!layout.webui_data.join("Sync").exists());

    let second = Layout::custom(
        &scratch.0.join("rnw2").to_string_lossy(),
        &scratch.0.join("webui2"),
        false,
    );
    write(&second.rnw_data.join("session.json"), b"{}");
    write(
        &second.rnw_data.join("Sync").join("sync-key-abc.dpapi"),
        &fs::read(outside.join("sync-key-abc.dpapi")).unwrap(),
    );
    fs::create_dir_all(&second.webui_data).unwrap();
    junction(&second.webui_data.join("Sync"), &outside);
    let before = tree(&outside);
    let report = migrate(&second, &Dpapi, &CredentialManager, &Faults::default());
    assert_eq!(report.outcome, Outcome::Failed);
    assert_eq!(tree(&outside), before, "nothing was written through the junction");
}

#[test]
fn a_junction_root_is_refused() {
    let scratch = Scratch::new("junction-root");
    let outside = scratch.0.join("outside");
    fs::create_dir_all(&outside).unwrap();
    let rnw = scratch.0.join("rnw");
    junction(&rnw, &outside);
    let layout = Layout::custom(&rnw.to_string_lossy(), &scratch.0.join("webui"), false);
    assert_eq!(
        migrate(&layout, &Dpapi, &CredentialManager, &Faults::default()).outcome,
        Outcome::Refused
    );
}

#[test]
fn hard_links_are_skipped_on_windows_too() {
    let scratch = Scratch::new("hard-link");
    let layout = Layout::custom(
        &scratch.0.join("rnw").to_string_lossy(),
        &scratch.0.join("webui"),
        false,
    );
    let outside = scratch.0.join("outside.txt");
    write(&outside, b"private");
    write(&layout.rnw_data.join("session.json"), b"{}");
    fs::hard_link(&outside, layout.rnw_data.join("hard.json")).unwrap();
    let report = migrate(&layout, &Dpapi, &CredentialManager, &Faults::default());
    assert_eq!(report.outcome, Outcome::MigratedWithSkips, "{report:?}");
    assert_eq!(report.counts.skipped_invalid, 1);
    assert!(!layout.webui_data.join("hard.json").exists());
}

#[test]
fn a_junction_above_any_root_is_refused() {
    let scratch = Scratch::new("junction-ancestor");
    let real = scratch.0.join("real");
    write(&real.join("rnw").join("session.json"), b"{}");
    let linked = scratch.0.join("linked");
    junction(&linked, &real);
    let through = Layout::custom(&linked.join("rnw").to_string_lossy(), &scratch.0.join("webui"), false);
    assert_eq!(
        migrate(&through, &Dpapi, &CredentialManager, &Faults::default()).outcome,
        Outcome::Refused
    );
    let into = Layout::custom(&real.join("rnw").to_string_lossy(), &linked.join("webui"), false);
    assert_eq!(
        migrate(&into, &Dpapi, &CredentialManager, &Faults::default()).outcome,
        Outcome::Refused
    );
    assert!(!real.join("webui").exists(), "nothing was created through the junction");
}

#[test]
fn the_webui_sync_key_name_and_entropy_match_the_webui_store() {
    let scratch = Scratch::new("webui-name");
    let layout = Layout::custom(&scratch.0.join("rnw").to_string_lossy(), &scratch.0.join("webui"), true);
    let key = [5u8; 32];
    write(
        &layout.rnw_data.join("Sync").join("sync-key-caseTest.dpapi"),
        &Dpapi.seal(&key, "ardia-sync-key/v1/test-instance/caseTest").unwrap(),
    );
    let report = migrate(&layout, &Dpapi, &CredentialManager, &Faults::default());
    assert_eq!(report.outcome, Outcome::Migrated, "{report:?}");
    let sealed = fs::read(layout.webui_data.join("Sync").join("sync-key-x6361736554657374.dpapi")).unwrap();
    assert_eq!(
        Dpapi
            .open(&sealed, "ardia-sync-key/v1/test-instance/caseTest")
            .unwrap()
            .as_slice(),
        &key
    );
}
