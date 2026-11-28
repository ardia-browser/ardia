#![cfg(windows)]

mod common;

use std::fs;
use std::process::Command;

use ardia_shell_migration::credentials::{self, assemble, Assembled};
use ardia_shell_migration::windows::{delete_generic, write_generic, CredentialManager, Dpapi};
use ardia_shell_migration::{migrate, migrate_chromium, names, Faults, Layout, Outcome, Sealer, Vault};
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
    let report = migrate(&layout, &Dpapi, &FakeVault::empty(), &Faults::default());
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
    let report = migrate(&second, &Dpapi, &FakeVault::empty(), &Faults::default());
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
        migrate(&layout, &Dpapi, &FakeVault::empty(), &Faults::default()).outcome,
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
    let report = migrate(&layout, &Dpapi, &FakeVault::empty(), &Faults::default());
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
        migrate(&through, &Dpapi, &FakeVault::empty(), &Faults::default()).outcome,
        Outcome::Refused
    );
    let into = Layout::custom(&real.join("rnw").to_string_lossy(), &linked.join("webui"), false);
    assert_eq!(
        migrate(&into, &Dpapi, &FakeVault::empty(), &Faults::default()).outcome,
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
    let report = migrate(&layout, &Dpapi, &FakeVault::empty(), &Faults::default());
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

fn chromium_key_text(plain_key: &[u8]) -> String {
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: plain_key.len() as u32,
        pbData: plain_key.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let sealed = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    assert_ne!(sealed, 0, "{}", std::io::Error::last_os_error());
    let mut wrapped = b"DPAPI".to_vec();
    wrapped.extend_from_slice(unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) });
    unsafe { LocalFree(output.pbData as HLOCAL) };
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::new();
    for chunk in wrapped.chunks(3) {
        let word = chunk
            .iter()
            .enumerate()
            .fold(0u32, |w, (i, b)| w | (u32::from(*b) << (16 - 8 * i)));
        for index in 0..4 {
            text.push(if index <= chunk.len() {
                ALPHABET[(word >> (18 - 6 * index) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    text
}

#[test]
fn a_chromium_key_sealed_by_real_dpapi_without_entropy_is_carried() {
    let scratch = Scratch::new("chromium-dpapi");
    let rnw = scratch.0.join("rnw");
    let layout = Layout::custom(rnw.to_str().unwrap(), &scratch.0.join("webui"), true);
    let key = chromium_key_text(&[3u8; 32]);
    assert!(ardia_shell_migration::chromium::chromium_key_opens(&Dpapi, &key));
    assert!(!ardia_shell_migration::chromium::chromium_key_opens(
        &Dpapi,
        &chromium_key_text(&[3u8; 16])
    ));
    let state = format!("{{\"os_crypt\":{{\"encrypted_key\":\"{key}\"}}}}");
    write(&layout.rnw_chromium.join("Local State"), state.as_bytes());
    write(&layout.rnw_chromium.join("Default/Network/Cookies"), b"v10 cookies");
    let report = migrate_chromium(&layout, &Dpapi, &Faults::default());
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(report.counts.key_carried, 1);
    let carried = fs::read_to_string(scratch.0.join("webui/Chromium/Local State")).unwrap();
    assert!(carried.contains(&key));
    assert_eq!(
        fs::read(scratch.0.join("webui/Chromium/Ardia default/Network/Cookies")).unwrap(),
        b"v10 cookies"
    );
}

#[test]
fn a_lockfile_chromium_holds_open_means_busy_and_a_stale_one_does_not() {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 1;
    const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;
    let scratch = Scratch::new("chromium-lockfile");
    let sealer = FakeDpapi::new();
    let rnw = scratch.0.join("rnw");
    let layout = Layout::custom(rnw.to_str().unwrap(), &scratch.0.join("webui"), true);
    write(&layout.rnw_chromium.join("Default/History"), b"history");
    let held = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
        .open(layout.rnw_chromium.join("lockfile"))
        .unwrap();
    let busy = migrate_chromium(&layout, &sealer, &Faults::default());
    assert_eq!(busy.outcome, Outcome::Busy, "{}", busy.to_json());
    assert!(!scratch.0.join("webui/Chromium").exists());
    drop(held);
    write(&layout.rnw_chromium.join("lockfile"), b"");
    let report = migrate_chromium(&layout, &sealer, &Faults::default());
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
}

#[test]
fn a_profile_folder_moves_on_ntfs_while_its_siblings_stay() {
    let scratch = Scratch::new("chromium-ntfs");
    let sealer = FakeDpapi::new();
    let rnw = scratch.0.join("rnw");
    let layout = Layout::custom(rnw.to_str().unwrap(), &scratch.0.join("webui"), true);
    write(&layout.rnw_chromium.join("Default/History"), b"rnw");
    write(&layout.rnw_chromium.join("Ardia p-a/History"), b"rnw a");
    write(&scratch.0.join("webui/Chromium/Ardia default/History"), b"webui");
    write(&scratch.0.join("webui/Chromium/Ardia default/Deep/Er/file"), b"deep");
    let report = migrate_chromium(&layout, &sealer, &Faults::default());
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(
        fs::read(scratch.0.join("webui/Chromium/Ardia default/History")).unwrap(),
        b"rnw"
    );
    let kept: Vec<_> = fs::read_dir(scratch.0.join("webui").join(names::KEPT_FOLDER))
        .unwrap()
        .collect();
    assert_eq!(kept.len(), 1);
    let kept = kept[0].as_ref().unwrap().path();
    assert_eq!(fs::read(kept.join("Ardia default/Deep/Er/file")).unwrap(), b"deep");
    assert!(!scratch.0.join("webui").join(names::CHROMIUM_STAGING_FOLDER).exists());
}

#[test]
fn a_held_lockfile_keeps_chromium_from_starting_and_goes_away_with_its_holder() {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 1;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    let scratch = Scratch::new("chromium-hold");
    let root = ardia_shell_migration::fsafe::Root::new(&scratch.0).unwrap();
    let held = root.dir().hold_lockfile("lockfile").unwrap();
    let chromium = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .share_mode(FILE_SHARE_READ)
        .open(scratch.0.join("lockfile"));
    assert_eq!(
        chromium.err().and_then(|e| e.raw_os_error()),
        Some(ERROR_SHARING_VIOLATION),
        "Chromium's own lockfile open fails while the migrator holds it"
    );
    assert!(root.dir().held_open("lockfile").unwrap());
    drop(held);
    assert!(!scratch.0.join("lockfile").exists());

    fs::write(scratch.0.join("elsewhere"), b"not a lockfile").unwrap();
    fs::hard_link(scratch.0.join("elsewhere"), scratch.0.join("linked")).unwrap();
    assert!(root.dir().hold_lockfile("linked").is_err());
    assert!(
        scratch.0.join("linked").exists(),
        "a refused lockfile is left where it was"
    );
    assert_eq!(fs::read(scratch.0.join("elsewhere")).unwrap(), b"not a lockfile");
}
