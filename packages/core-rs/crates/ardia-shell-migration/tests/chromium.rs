mod common;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use ardia_shell_migration::chromium::{
    base64_decode, chromium_key_opens, merged_local_state, read_chromium_attempt, read_chromium_marker,
    valid_chromium_marker, LOCAL_STATE_LIMIT,
};
use ardia_shell_migration::{migrate_chromium, names, ChromiumReport, Faults, Layout, Outcome, Sealer};
use common::*;
use serde_json::{json, Value};
use zeroize::Zeroizing;

const RNW_KEY: [u8; 32] = [7; 32];
const WEBUI_KEY: [u8; 32] = [9; 32];

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let word = chunk
            .iter()
            .enumerate()
            .fold(0u32, |w, (i, b)| w | (u32::from(*b) << (16 - 8 * i)));
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(ALPHABET[(word >> (18 - 6 * index) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn chromium_key(sealer: &FakeDpapi, key: &[u8]) -> String {
    let mut wrapped = b"DPAPI".to_vec();
    wrapped.extend(sealer.seal(key, "").unwrap());
    base64(&wrapped)
}

fn run(layout: &Layout, sealer: &dyn Sealer) -> ChromiumReport {
    migrate_chromium(layout, sealer, &Faults::default())
}

fn webui_chromium(layout: &Layout) -> PathBuf {
    layout.webui_data.join(names::CHROMIUM_FOLDER)
}

fn cookie(key: &str, value: &str) -> Vec<u8> {
    format!("{key}|{value}\n").into_bytes()
}

struct Seeded {
    rnw_key: String,
    webui_key: String,
}

fn seed_rnw(layout: &Layout, sealer: &FakeDpapi) -> String {
    let user_data = &layout.rnw_chromium;
    let key = chromium_key(sealer, &RNW_KEY);
    let state = json!({
        "os_crypt": { "encrypted_key": key, "audit_enabled": true, "app_bound_encrypted_key": "QVBQQnJudw==" },
        "profile": { "info_cache": { "Default": { "name": "Me" } } },
    });
    write(
        &user_data.join(names::LOCAL_STATE),
        &serde_json::to_vec(&state).unwrap(),
    );
    let default = user_data.join("Default");
    for (path, bytes) in [
        ("History", b"rnw history".to_vec()),
        ("Network/Cookies", cookie(&key, "rnw-cookie")),
        ("Login Data", b"v10 rnw logins".to_vec()),
        ("Preferences", b"{\"extensions\":{}}".to_vec()),
        ("Bookmarks", b"{}".to_vec()),
        ("Extensions/abcdef/1.0_0/manifest.json", b"{\"name\":\"ext\"}".to_vec()),
        ("Local Extension Settings/abcdef/000003.log", b"ext state".to_vec()),
        ("Local Extension Settings/abcdef/LOCK", Vec::new()),
        ("IndexedDB/https_site_0.indexeddb.leveldb/000005.ldb", b"idb".to_vec()),
        ("Service Worker/Database/000001.log", b"sw db".to_vec()),
        ("Service Worker/CacheStorage/abc/index", b"sw cache".to_vec()),
        ("Cache/Cache_Data/data_0", b"http cache".to_vec()),
        ("Code Cache/js/index", b"code cache".to_vec()),
        ("GPUCache/data_1", b"gpu".to_vec()),
        ("DawnGraphiteCache/data_0", b"dawn".to_vec()),
        ("DawnWebGPUCache/data_0", b"dawn".to_vec()),
        ("GrShaderCache/data_0", b"shader".to_vec()),
        ("ShaderCache/data_0", b"shader".to_vec()),
        ("Sessions/Session_1", b"session".to_vec()),
        ("Sessions_Encrypted/Session_1", b"session".to_vec()),
    ] {
        write(&default.join(path), &bytes);
    }
    write(&user_data.join("Ardia p-work/History"), b"work history");
    write(&user_data.join("Ardia p-work/Preferences"), b"{}");
    write(
        &user_data.join("Ardia p-work/Network/Cookies"),
        &cookie(&key, "work-cookie"),
    );
    write(&user_data.join("System Profile/Preferences"), b"system");
    write(&user_data.join("Guest Profile/Preferences"), b"guest");
    write(&user_data.join("Ardia Upper/History"), b"not an Ardia profile name");
    write(&user_data.join("Crashpad/settings.dat"), b"crash");
    write(&user_data.join("First Run"), b"");
    key
}

fn webui_state_with(key: &str) -> Vec<u8> {
    let state = json!({
        "os_crypt": { "encrypted_key": key, "audit_enabled": true },
        "browser": { "last_redirect_origin": "" },
        "profile": { "info_cache": { "Ardia default": { "name": "default" } } },
    });
    serde_json::to_vec(&state).unwrap()
}

fn seed_webui_049(layout: &Layout, sealer: &FakeDpapi) -> String {
    let chromium = webui_chromium(layout);
    let key = chromium_key(sealer, &WEBUI_KEY);
    write(&chromium.join(names::LOCAL_STATE), &webui_state_with(&key));
    write(&chromium.join("Ardia default/History"), b"webui history");
    write(&chromium.join("Ardia default/Preferences"), b"{}");
    write(
        &chromium.join("Ardia default/Network/Cookies"),
        &cookie(&key, "webui-cookie"),
    );
    write(&chromium.join("Ardia p-new/History"), b"made on 0.2.49");
    write(&chromium.join("Ardia p-new/Preferences"), b"{}");
    write(
        &chromium.join("Ardia p-new/Network/Cookies"),
        &cookie(&key, "new-cookie"),
    );
    write(&chromium.join("Ardia p-new/Cache/data_0"), b"cache");
    write(
        &layout.webui_data.join(names::MARKER_NAME),
        b"{\"outcome\":\"migrated\"}",
    );
    key
}

fn seed_both(layout: &Layout, sealer: &FakeDpapi) -> Seeded {
    Seeded {
        rnw_key: seed_rnw(layout, sealer),
        webui_key: seed_webui_049(layout, sealer),
    }
}

fn live_key(chromium: &Path) -> Option<String> {
    let state: Value = serde_json::from_slice(&fs::read(chromium.join(names::LOCAL_STATE)).ok()?).ok()?;
    state["os_crypt"]["encrypted_key"].as_str().map(str::to_string)
}

fn launch_chromium(layout: &Layout, fresh: &mut u32) {
    let chromium = webui_chromium(layout);
    fs::create_dir_all(&chromium).unwrap();
    assert!(
        !chromium.join(names::CHROMIUM_LOCK_FILE).exists(),
        "Chromium launched while the migrator still held its lockfile"
    );
    let key = live_key(&chromium).unwrap_or_else(|| {
        *fresh += 1;
        let key = format!("FRESH-{fresh}");
        write(&chromium.join(names::LOCAL_STATE), &webui_state_with(&key));
        key
    });
    for entry in fs::read_dir(&chromium).unwrap() {
        let profile = entry.unwrap().path();
        let cookies = profile.join("Network/Cookies");
        if let Ok(text) = fs::read_to_string(&cookies) {
            let kept: String = text
                .lines()
                .filter(|line| line.starts_with(&format!("{key}|")))
                .map(|line| format!("{line}\n"))
                .collect();
            fs::write(&cookies, kept).unwrap();
        }
    }
    let default = chromium.join(names::WEBUI_DEFAULT_PROFILE);
    if !default.exists() {
        write(&default.join("Preferences"), b"{}");
        write(&default.join("Network/Cookies"), &cookie(&key, "made-after-a-crash"));
    }
}

type Snapshot = BTreeMap<String, (Vec<u8>, Option<SystemTime>)>;

fn snapshot(root: &Path) -> Snapshot {
    let mut found = Snapshot::new();
    fn walk(root: &Path, dir: &Path, found: &mut Snapshot) {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if dir == root && error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => panic!("{dir:?}: {error}"),
        };
        for entry in entries {
            let path = entry.unwrap().path();
            let meta = fs::symlink_metadata(&path).unwrap();
            let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if meta.is_dir() {
                found.insert(format!("{relative}/"), (Vec::new(), None));
                walk(root, &path, found);
            } else {
                found.insert(relative, (fs::read(&path).unwrap(), meta.modified().ok()));
            }
        }
    }
    walk(root, root, &mut found);
    found
}

fn files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    tree(root)
        .into_iter()
        .filter(|(path, _)| !path.ends_with('/'))
        .collect()
}

fn local_state(layout: &Layout) -> Value {
    serde_json::from_slice(&fs::read(webui_chromium(layout).join(names::LOCAL_STATE)).unwrap()).unwrap()
}

fn kept_folders(layout: &Layout) -> Vec<PathBuf> {
    let kept = layout.webui_data.join(names::KEPT_FOLDER);
    let Ok(entries) = fs::read_dir(kept) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("Chromium-"))
        .collect();
    found.sort();
    found
}

fn kept_snapshot(layout: &Layout) -> Snapshot {
    snapshot(&layout.webui_data.join(names::KEPT_FOLDER))
}

fn counts(report: &ChromiumReport) -> BTreeMap<&'static str, u64> {
    report.counts.fields().into_iter().collect()
}

fn profiles(chromium: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(chromium) else {
        return Vec::new();
    };
    let mut found: Vec<String> = entries
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir())
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    found.sort();
    found
}

fn has_line(path: &Path, line: &str) -> bool {
    fs::read_to_string(path).is_ok_and(|text| text.lines().any(|l| l == line))
}

fn kept_holds(layout: &Layout, profile: &str, key: &str, value: &str) -> bool {
    let line = format!("{key}|{value}");
    kept_folders(layout).iter().any(|folder| {
        has_line(&folder.join(profile).join("Network/Cookies"), &line)
            && kept_folders(layout)
                .iter()
                .any(|other| live_key(other).as_deref() == Some(key))
    })
}

fn assert_nothing_lost(layout: &Layout, seeded: &Seeded, label: &str) {
    let chromium = webui_chromium(layout);
    assert_eq!(
        live_key(&chromium).as_deref(),
        Some(seeded.rnw_key.as_str()),
        "{label}: live key"
    );
    assert!(
        has_line(
            &chromium.join("Ardia default/Network/Cookies"),
            &format!("{}|rnw-cookie", seeded.rnw_key)
        ),
        "{label}: the RNW default profile's cookie is live and decrypts"
    );
    assert!(
        has_line(
            &chromium.join("Ardia p-work/Network/Cookies"),
            &format!("{}|work-cookie", seeded.rnw_key)
        ),
        "{label}: the RNW work profile's cookie is live and decrypts"
    );
    assert!(
        kept_holds(layout, "Ardia default", &seeded.webui_key, "webui-cookie"),
        "{label}: 0.2.49's default profile cookie is kept beside its key"
    );
    assert!(
        kept_holds(layout, "Ardia p-new", &seeded.webui_key, "new-cookie"),
        "{label}: the profile made only on 0.2.49 keeps its cookie beside its key"
    );
    assert_backups_open_with_their_own_key(layout, label);
    assert!(
        !chromium.join(names::CHROMIUM_LOCK_FILE).exists(),
        "{label}: lockfile released"
    );
    assert!(
        !layout.rnw_chromium.join(names::CHROMIUM_LOCK_FILE).exists(),
        "{label}: RNW lockfile released"
    );
}

fn assert_backups_open_with_their_own_key(layout: &Layout, label: &str) {
    for folder in kept_folders(layout) {
        let key = live_key(&folder);
        for profile in profiles(&folder) {
            assert!(
                key.is_some(),
                "{label}: {folder:?} keeps {profile} without the Local State that opens it"
            );
            let path = folder.join(&profile).join("Network/Cookies");
            let text = match fs::read_to_string(&path) {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => panic!("{label}: {path:?} can't be read: {error}"),
            };
            for line in text.lines() {
                assert!(
                    line.starts_with(&format!("{}|", key.as_deref().unwrap())),
                    "{label}: {folder:?}/{profile} holds {line:?}, which its kept key can't open"
                );
            }
        }
    }
}

fn assert_write_once(before: &Snapshot, after: &Snapshot, label: &str) {
    for (path, entry) in before {
        assert_eq!(
            after.get(path),
            Some(entry),
            "{label}: {path} in the backups changed or vanished"
        );
    }
}

#[test]
fn a_fresh_upgrade_copies_every_profile_without_caches_and_carries_only_the_dpapi_key() {
    let scratch = Scratch::new("chromium-fresh");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_key = seed_rnw(&layout, &sealer);
    let before = snapshot(&layout.rnw_data);

    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(report.exit_code(), 0);

    let chromium = webui_chromium(&layout);
    let default = files(&chromium.join("Ardia default"));
    let expected: Vec<&str> = vec![
        "Bookmarks",
        "Extensions/abcdef/1.0_0/manifest.json",
        "History",
        "IndexedDB/https_site_0.indexeddb.leveldb/000005.ldb",
        "Local Extension Settings/abcdef/000003.log",
        "Login Data",
        "Network/Cookies",
        "Preferences",
        "Service Worker/Database/000001.log",
    ];
    assert_eq!(default.keys().map(String::as_str).collect::<Vec<_>>(), expected);
    assert_eq!(default["History"], b"rnw history");
    assert_eq!(default["Network/Cookies"], cookie(&rnw_key, "rnw-cookie"));
    assert_eq!(
        files(&chromium.join("Ardia p-work"))["Network/Cookies"],
        cookie(&rnw_key, "work-cookie")
    );
    assert_eq!(profiles(&chromium), ["Ardia default", "Ardia p-work"]);
    assert_eq!(
        local_state(&layout),
        json!({ "os_crypt": { "encrypted_key": rnw_key } })
    );
    assert!(chromium_key_opens(&sealer, &rnw_key));

    let counted = counts(&report);
    assert_eq!(counted["profiles"], 2);
    assert_eq!(counted["profiles_replaced"], 0);
    assert_eq!(counted["webui_profiles_backed_up"], 0);
    assert_eq!(counted["key_carried"], 1);
    assert_eq!(counted["files"], 12);
    assert_eq!(counted["local_state_kept"], 0);

    assert_eq!(
        snapshot(&layout.rnw_data),
        before,
        "the React Native profile is only read"
    );
    assert!(read_chromium_marker(&layout.webui_data).is_some());
    assert!(!layout.webui_data.join(names::CHROMIUM_PROGRESS_NAME).exists());
    assert!(!layout.webui_data.join(names::CHROMIUM_STAGING_FOLDER).exists());
    assert!(!chromium.join(names::CHROMIUM_LOCK_FILE).exists());
    assert!(kept_folders(&layout).is_empty());
    let attempt = read_chromium_attempt(&layout.webui_data).unwrap();
    assert_eq!(attempt["step"], "chromium");
    assert_eq!(attempt["outcome"], "migrated");
}

#[test]
fn a_second_run_answers_already_migrated_and_touches_nothing() {
    let scratch = Scratch::new("chromium-again");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    assert_eq!(run(&layout, &sealer).outcome, Outcome::Migrated);
    write(&webui_chromium(&layout).join("Ardia default/History"), b"browsed since");
    let after_first = snapshot(&layout.webui_data);

    let again = run(&layout, &sealer);
    assert_eq!(again.outcome, Outcome::AlreadyMigrated);
    assert_eq!(again.exit_code(), 0);
    assert_eq!(snapshot(&layout.webui_data), after_first);
}

#[test]
fn a_user_who_already_ran_0_2_49_gets_the_old_profiles_back_and_every_new_one_kept_with_its_key() {
    let scratch = Scratch::new("chromium-049");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let seeded = seed_both(&layout, &sealer);
    let webui_state = fs::read(webui_chromium(&layout).join(names::LOCAL_STATE)).unwrap();
    let before = snapshot(&layout.rnw_data);

    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    let chromium = webui_chromium(&layout);
    assert_eq!(
        fs::read(chromium.join("Ardia default/History")).unwrap(),
        b"rnw history"
    );
    assert!(!chromium.join("Ardia default/Cache").exists());
    assert_eq!(
        fs::read(chromium.join("Ardia p-work/History")).unwrap(),
        b"work history"
    );
    assert_eq!(
        fs::read(chromium.join("Ardia p-new/History")).unwrap(),
        b"made on 0.2.49"
    );

    let state = local_state(&layout);
    assert_eq!(
        state["os_crypt"],
        json!({ "encrypted_key": seeded.rnw_key, "audit_enabled": true }),
        "only the DPAPI key changes; the app-bound key a per-user install never uses stays behind"
    );
    assert_eq!(state["browser"], json!({ "last_redirect_origin": "" }));
    assert_eq!(state["profile"]["info_cache"]["Ardia default"]["name"], "default");

    assert_eq!(kept_folders(&layout).len(), 1);
    let kept = &kept_folders(&layout)[0];
    assert_eq!(fs::read(kept.join(names::LOCAL_STATE)).unwrap(), webui_state);
    assert_eq!(fs::read(kept.join("Ardia default/History")).unwrap(), b"webui history");
    assert_eq!(fs::read(kept.join("Ardia p-new/History")).unwrap(), b"made on 0.2.49");
    assert!(!kept.join("Ardia p-new/Cache").exists());
    let mut fresh = 0;
    launch_chromium(&layout, &mut fresh);
    assert_nothing_lost(&layout, &seeded, "one run");

    let counted = counts(&report);
    assert_eq!(counted["profiles"], 2);
    assert_eq!(counted["profiles_replaced"], 1);
    assert_eq!(counted["webui_profiles_backed_up"], 1);
    assert_eq!(counted["webui_profiles_left"], 1);
    assert_eq!(counted["local_state_kept"], 1);
    assert_eq!(counted["key_carried"], 1);
    assert_eq!(counted["key_shared"], 0);
    assert_eq!(counted["swap_rolled_back"], 0);
    assert_eq!(snapshot(&layout.rnw_data), before);
    assert_eq!(
        fs::read(layout.webui_data.join(names::MARKER_NAME)).unwrap(),
        b"{\"outcome\":\"migrated\"}",
        "the documents step keeps its own marker"
    );
}

#[test]
fn a_profile_restored_by_hand_is_left_alone_and_only_missing_profiles_are_copied() {
    let scratch = Scratch::new("chromium-manual");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_key = seed_rnw(&layout, &sealer);
    let chromium = webui_chromium(&layout);
    let restored = webui_state_with(&rnw_key);
    write(&chromium.join(names::LOCAL_STATE), &restored);
    write(
        &chromium.join("Ardia default/History"),
        b"restored by hand, then browsed",
    );
    write(&chromium.join("Ardia default/Preferences"), b"{}");

    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(
        fs::read(chromium.join("Ardia default/History")).unwrap(),
        b"restored by hand, then browsed"
    );
    assert_eq!(
        fs::read(chromium.join("Ardia p-work/History")).unwrap(),
        b"work history"
    );
    assert_eq!(fs::read(chromium.join(names::LOCAL_STATE)).unwrap(), restored);
    assert!(kept_folders(&layout).is_empty());
    let counted = counts(&report);
    assert_eq!(counted["key_shared"], 1);
    assert_eq!(counted["key_carried"], 0);
    assert_eq!(counted["profiles"], 1);
    assert_eq!(counted["webui_profiles_left"], 1);
}

#[derive(Clone, Copy, Debug)]
enum Stop {
    Fail(usize),
    Crash(usize),
    FailThenCrashRollingBack(usize, usize),
}

fn faults(stop: Option<Stop>) -> Faults {
    match stop {
        None => Faults::default(),
        Some(Stop::FailThenCrashRollingBack(at, step)) => Faults {
            fail_at_commit: Some(at),
            crash_in_rollback_at: Some(step),
            ..Faults::default()
        },
        Some(Stop::Fail(at)) => Faults {
            fail_at_commit: Some(at),
            ..Faults::default()
        },
        Some(Stop::Crash(at)) => Faults {
            crash_at_commit: Some(at),
            ..Faults::default()
        },
    }
}

fn after_the_swap(report: &ChromiumReport) -> bool {
    matches!(report.failed_stage.map(|s| s.as_str()), Some("report" | "marker"))
}

fn live_files_without_lock(layout: &Layout) -> BTreeMap<String, Vec<u8>> {
    let mut live = files(&webui_chromium(layout));
    live.remove(names::CHROMIUM_LOCK_FILE);
    live
}

#[test]
fn every_stop_and_relaunch_between_tries_loses_nothing_and_never_rewrites_a_backup() {
    let mut scenarios = 0;
    for first_at in 1..=12 {
        let mut stops = vec![Stop::Fail(first_at), Stop::Crash(first_at)];
        stops.extend((1..=7).map(|step| Stop::FailThenCrashRollingBack(first_at, step)));
        for stop in stops {
            let seconds = if matches!(stop, Stop::FailThenCrashRollingBack(..)) {
                vec![None]
            } else {
                vec![
                    None,
                    Some(Stop::Crash(1)),
                    Some(Stop::Crash(2)),
                    Some(Stop::Crash(3)),
                    Some(Stop::Fail(2)),
                ]
            };
            for second in seconds {
                let label = format!("{stop:?} then {second:?}");
                let scratch = Scratch::new("chromium-interleave");
                let sealer = FakeDpapi::new();
                let layout = layout(&scratch.0);
                let seeded = seed_both(&layout, &sealer);
                let rnw_before = snapshot(&layout.rnw_data);
                let live_before = live_files_without_lock(&layout);
                let mut fresh = 0;

                let first = migrate_chromium(&layout, &sealer, &faults(Some(stop)));
                if first.outcome != Outcome::Failed {
                    assert_eq!(first.outcome, Outcome::Migrated, "{label}");
                    continue;
                }
                scenarios += 1;
                assert!(read_chromium_marker(&layout.webui_data).is_none(), "{label}");
                if matches!(stop, Stop::Fail(_)) && !after_the_swap(&first) {
                    assert_eq!(
                        live_files_without_lock(&layout),
                        live_before,
                        "{label}: a failed try leaves 0.2.49 exactly as it was"
                    );
                }
                launch_chromium(&layout, &mut fresh);
                let mut kept = kept_snapshot(&layout);

                for stopped in second.into_iter() {
                    let outcome = migrate_chromium(&layout, &sealer, &faults(Some(stopped))).outcome;
                    assert_write_once(&kept, &kept_snapshot(&layout), &label);
                    if outcome == Outcome::Migrated {
                        break;
                    }
                    launch_chromium(&layout, &mut fresh);
                    kept = kept_snapshot(&layout);
                }

                if read_chromium_marker(&layout.webui_data).is_none() {
                    let last = run(&layout, &sealer);
                    assert_eq!(last.outcome, Outcome::Migrated, "{label}: {}", last.to_json());
                    assert_write_once(&kept, &kept_snapshot(&layout), &label);
                }
                launch_chromium(&layout, &mut fresh);
                assert_nothing_lost(&layout, &seeded, &label);
                assert_eq!(snapshot(&layout.rnw_data), rnw_before, "{label}: RNW untouched");
                assert!(
                    !layout.webui_data.join(names::CHROMIUM_STAGING_FOLDER).exists(),
                    "{label}"
                );
            }
        }
    }
    assert!(
        scenarios >= 60,
        "the run stops at every commit in both ways: {scenarios}"
    );
}

#[test]
fn a_failure_after_the_key_swap_rolls_everything_back() {
    let scratch = Scratch::new("chromium-rollback");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let seeded = seed_both(&layout, &sealer);
    let live_before = live_files_without_lock(&layout);
    let mut rolled = 0;
    for at in 1..=12 {
        let report = migrate_chromium(&layout, &sealer, &faults(Some(Stop::Fail(at))));
        if report.outcome != Outcome::Failed {
            break;
        }
        if after_the_swap(&report) {
            assert_eq!(
                fs::read(webui_chromium(&layout).join("Ardia default/History")).unwrap(),
                b"rnw history",
                "stop at {at}: a failed report after a whole swap leaves the swap in place"
            );
            continue;
        }
        assert_eq!(live_files_without_lock(&layout), live_before, "stop at {at}");
        rolled += counts(&report)["swap_rolled_back"];
    }
    assert!(rolled >= 3, "rollbacks: {rolled}");
    assert_eq!(
        read_chromium_marker(&layout.webui_data).map(|m| m["outcome"].clone()),
        Some(json!("migrated"))
    );
    let mut fresh = 0;
    launch_chromium(&layout, &mut fresh);
    assert_nothing_lost(&layout, &seeded, "after the rollbacks");
}

#[test]
fn an_oversized_webui_local_state_is_copied_aside_whole_and_survives_a_crash_and_relaunch() {
    let mut stopped = 0;
    for at in 1.. {
        let scratch = Scratch::new("chromium-huge-webui-state");
        let sealer = FakeDpapi::new();
        let layout = layout(&scratch.0);
        let seeded = seed_both(&layout, &sealer);
        let mut huge = webui_state_with(&seeded.webui_key);
        huge.pop();
        huge.extend(format!(",\"pad\":\"{}\"}}", "x".repeat(LOCAL_STATE_LIMIT as usize)).into_bytes());
        let state_path = webui_chromium(&layout).join(names::LOCAL_STATE);
        fs::write(&state_path, &huge).unwrap();
        let first = migrate_chromium(&layout, &sealer, &faults(Some(Stop::Crash(at))));
        let mut fresh = 0;
        if first.outcome == Outcome::Failed {
            stopped += 1;
            launch_chromium(&layout, &mut fresh);
            let kept = kept_snapshot(&layout);
            let report = run(&layout, &sealer);
            assert_eq!(report.outcome, Outcome::Migrated, "crash at {at}");
            assert_write_once(&kept, &kept_snapshot(&layout), &format!("crash at {at}"));
        } else {
            assert_eq!(counts(&first)["local_state_malformed"], 1);
        }
        let originals = kept_folders(&layout)
            .iter()
            .filter(|folder| fs::read(folder.join(names::LOCAL_STATE)).is_ok_and(|bytes| bytes == huge))
            .count();
        assert!(originals >= 1, "crash at {at}: the original Local State is kept whole");
        assert_eq!(
            local_state(&layout)["os_crypt"]["encrypted_key"],
            json!(seeded.rnw_key),
            "crash at {at}"
        );
        if first.outcome != Outcome::Failed {
            break;
        }
    }
    assert!(stopped >= 4, "{stopped}");
}

#[test]
fn a_copy_stopped_part_way_copies_every_file_again() {
    let scratch = Scratch::new("chromium-partway");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let faults = Faults {
        fail_at_file: Some(4),
        ..Faults::default()
    };
    let first = migrate_chromium(&layout, &sealer, &faults);
    assert_eq!(first.outcome, Outcome::Failed);
    assert_eq!(first.failed_stage.map(|s| s.as_str()), Some("staging"));
    assert!(
        profiles(&webui_chromium(&layout)).is_empty(),
        "nothing reaches the live profile folder before the copy is whole"
    );
    assert!(!webui_chromium(&layout).join(names::LOCAL_STATE).exists());
    let second = run(&layout, &sealer);
    assert_eq!(second.outcome, Outcome::Migrated);
    assert_eq!(counts(&second)["files"], 12);
    assert_eq!(
        fs::read(webui_chromium(&layout).join("Ardia default/History")).unwrap(),
        b"rnw history"
    );
}

#[test]
fn a_torn_or_stale_staged_file_never_reaches_the_live_profile() {
    let scratch = Scratch::new("chromium-torn");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let staging = layout.webui_data.join(names::CHROMIUM_STAGING_FOLDER);
    write(&staging.join("Ardia default/History"), b"rnw hist");
    write(&staging.join("Ardia default/Login Data"), b"v10 rnw XXXXXX");
    let long_ago = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
    fs::File::options()
        .write(true)
        .open(staging.join("Ardia default/Login Data"))
        .unwrap()
        .set_modified(long_ago)
        .unwrap();
    write(
        &staging.join("Ardia default/.ardia-mig-1-0-dead.rnw-migration.partial"),
        b"a copy that never finished",
    );
    write(&staging.join("Ardia default/Login Data-wal"), b"stale sidecar");
    write(
        &staging.join("Ardia default/Extensions/removed/1.0/manifest.json"),
        b"uninstalled",
    );
    write(&staging.join("Ardia default/Cache/data_0"), b"cache");
    write(&staging.join("Ardia p-gone/History"), b"a profile RNW no longer has");
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated);
    let chromium = webui_chromium(&layout);
    let default = chromium.join("Ardia default");
    assert_eq!(fs::read(default.join("History")).unwrap(), b"rnw history");
    assert_eq!(fs::read(default.join("Login Data")).unwrap(), b"v10 rnw logins");
    assert!(!default.join("Login Data-wal").exists());
    assert!(!default.join("Extensions/removed").exists());
    assert!(!default.join("Cache").exists());
    assert_eq!(profiles(&chromium), ["Ardia default", "Ardia p-work"]);
}

#[cfg(unix)]
#[test]
fn a_file_that_cannot_be_read_fails_the_try_instead_of_being_left_out() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("chromium-unreadable");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let login = layout.rnw_chromium.join("Default/Login Data");
    fs::set_permissions(&login, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::File::open(&login).is_ok() {
        fs::set_permissions(&login, fs::Permissions::from_mode(0o644)).unwrap();
        return;
    }
    let report = run(&layout, &sealer);
    fs::set_permissions(&login, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(report.outcome, Outcome::Failed, "{}", report.to_json());
    assert!(read_chromium_marker(&layout.webui_data).is_none());
    assert!(profiles(&webui_chromium(&layout)).is_empty());
    let retried = run(&layout, &sealer);
    assert_eq!(retried.outcome, Outcome::Migrated);
    assert_eq!(
        fs::read(webui_chromium(&layout).join("Ardia default/Login Data")).unwrap(),
        b"v10 rnw logins"
    );
}

struct LockSpy {
    inner: FakeDpapi,
    lockfiles: Vec<PathBuf>,
    seen: RefCell<Vec<bool>>,
}

impl Sealer for LockSpy {
    fn seal(&self, plain: &[u8], purpose: &str) -> std::io::Result<Vec<u8>> {
        self.inner.seal(plain, purpose)
    }

    fn open(&self, sealed: &[u8], purpose: &str) -> Option<Zeroizing<Vec<u8>>> {
        self.inner.open(sealed, purpose)
    }

    fn open_unbound(&self, sealed: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
        self.seen
            .borrow_mut()
            .push(self.lockfiles.iter().all(|path| path.is_file()));
        self.inner.open_unbound(sealed)
    }
}

#[test]
fn both_lockfiles_are_held_while_the_profiles_move_and_released_after() {
    let scratch = Scratch::new("chromium-holds");
    let layout = layout(&scratch.0);
    let spy = LockSpy {
        inner: FakeDpapi::new(),
        lockfiles: vec![
            layout.rnw_chromium.join(names::CHROMIUM_LOCK_FILE),
            webui_chromium(&layout).join(names::CHROMIUM_LOCK_FILE),
        ],
        seen: RefCell::new(Vec::new()),
    };
    seed_both(&layout, &spy.inner);
    let before = snapshot(&layout.rnw_data);
    assert_eq!(run(&layout, &spy).outcome, Outcome::Migrated);
    assert_eq!(*spy.seen.borrow(), [true]);
    for path in &spy.lockfiles {
        assert!(!path.exists(), "{path:?} released");
    }
    assert_eq!(snapshot(&layout.rnw_data), before);
}

#[test]
fn a_missing_or_unreadable_rnw_key_still_copies_the_profiles_but_never_writes_a_key() {
    for (label, state) in [
        ("missing", None),
        ("malformed", Some(b"{not json".to_vec())),
        ("no key", Some(b"{\"os_crypt\":{}}".to_vec())),
        (
            "not base64",
            Some(b"{\"os_crypt\":{\"encrypted_key\":\"***\"}}".to_vec()),
        ),
        (
            "not dpapi",
            Some(format!("{{\"os_crypt\":{{\"encrypted_key\":\"{}\"}}}}", base64(b"XXXXXsealed")).into_bytes()),
        ),
    ] {
        let scratch = Scratch::new("chromium-key");
        let sealer = FakeDpapi::new();
        let layout = layout(&scratch.0);
        seed_rnw(&layout, &sealer);
        let rnw_state = layout.rnw_chromium.join(names::LOCAL_STATE);
        match &state {
            None => fs::remove_file(&rnw_state).unwrap(),
            Some(bytes) => fs::write(&rnw_state, bytes).unwrap(),
        }
        let report = run(&layout, &sealer);
        let counted = counts(&report);
        if state.is_none() {
            assert_eq!(report.outcome, Outcome::Migrated, "{label}");
            assert_eq!(counted["key_missing"], 1, "{label}");
        } else {
            assert_eq!(report.outcome, Outcome::MigratedWithSkips, "{label}");
            assert_eq!(counted["key_unreadable"], 1, "{label}");
        }
        assert_eq!(counted["key_carried"], 0, "{label}");
        assert!(!webui_chromium(&layout).join(names::LOCAL_STATE).exists(), "{label}");
        assert_eq!(
            fs::read(webui_chromium(&layout).join("Ardia default/History")).unwrap(),
            b"rnw history",
            "{label}"
        );
    }
}

#[test]
fn a_key_sealed_for_another_purpose_does_not_count_as_readable() {
    let scratch = Scratch::new("chromium-wrong-seal");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let mut wrapped = b"DPAPI".to_vec();
    wrapped.extend(sealer.seal(&RNW_KEY, "elsewhere").unwrap());
    let state = json!({ "os_crypt": { "encrypted_key": base64(&wrapped) } });
    fs::write(
        layout.rnw_chromium.join(names::LOCAL_STATE),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    let report = run(&layout, &sealer);
    assert_eq!(counts(&report)["key_unreadable"], 1);
    assert!(!chromium_key_opens(&sealer, &chromium_key(&sealer, &[1; 16])));
}

#[test]
fn a_malformed_webui_local_state_is_kept_aside_and_replaced() {
    let scratch = Scratch::new("chromium-bad-webui-state");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_key = seed_rnw(&layout, &sealer);
    write(&webui_chromium(&layout).join(names::LOCAL_STATE), b"[1,2");
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated);
    assert_eq!(
        local_state(&layout),
        json!({ "os_crypt": { "encrypted_key": rnw_key } })
    );
    assert_eq!(
        fs::read(kept_folders(&layout)[0].join(names::LOCAL_STATE)).unwrap(),
        b"[1,2"
    );
    assert_eq!(counts(&report)["local_state_malformed"], 1);
    assert_eq!(counts(&report)["local_state_kept"], 1);
}

#[cfg(unix)]
#[test]
fn a_running_shell_makes_the_run_wait_without_writing_anything() {
    for side in ["rnw", "webui"] {
        let scratch = Scratch::new("chromium-busy");
        let sealer = FakeDpapi::new();
        let layout = layout(&scratch.0);
        seed_rnw(&layout, &sealer);
        let held = match side {
            "rnw" => layout.rnw_chromium.join(names::CHROMIUM_LOCK_FILE),
            _ => webui_chromium(&layout).join(names::CHROMIUM_LOCK_FILE),
        };
        write(&held, b"");
        let mut before = snapshot(&layout.webui_data);
        let report = run(&layout, &sealer);
        assert_eq!(report.outcome, Outcome::Busy, "{side}");
        assert_eq!(report.exit_code(), 3);
        assert_eq!(report.failed_stage.map(|s| s.as_str()), Some("in_use"));
        let mut after = snapshot(&layout.webui_data);
        after.remove(names::CHROMIUM_ATTEMPT_NAME);
        after.remove(names::LOCK_NAME);
        before.remove(names::LOCK_NAME);
        assert_eq!(after, before, "{side}");
        assert_eq!(
            read_chromium_attempt(&layout.webui_data).unwrap()["failed_stage"],
            "in_use"
        );
        fs::remove_file(&held).unwrap();
        assert_eq!(run(&layout, &sealer).outcome, Outcome::Migrated, "{side}");
    }
}

#[test]
fn too_little_free_space_fails_before_copying_and_clears_the_staging_folder() {
    let scratch = Scratch::new("chromium-space");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_both(&layout, &sealer);
    let before = live_files_without_lock(&layout);
    let faults = Faults {
        free_space: Some(1024),
        ..Faults::default()
    };
    let report = migrate_chromium(&layout, &sealer, &faults);
    assert_eq!(report.outcome, Outcome::Failed);
    assert_eq!(report.failed_stage.map(|s| s.as_str()), Some("space"));
    assert_eq!(counts(&report)["staging_cleared"], 1);
    assert_eq!(
        live_files_without_lock(&layout),
        before,
        "the 0.2.49 profile is untouched"
    );
    assert!(!layout.webui_data.join(names::CHROMIUM_STAGING_FOLDER).exists());
    assert_eq!(run(&layout, &sealer).outcome, Outcome::Migrated);
}

#[test]
fn no_rnw_profile_means_nothing_to_migrate_and_no_chromium_folder() {
    let scratch = Scratch::new("chromium-none");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::NothingToMigrate);
    assert_eq!(report.exit_code(), 0);
    assert!(
        !layout.webui_data.exists(),
        "a machine that never ran the React Native shell gets no WebUI folder from setup"
    );

    let scratch = Scratch::new("chromium-empty");
    let layout = self::layout(&scratch.0);
    write(&layout.rnw_chromium.join("System Profile/Preferences"), b"{}");
    assert_eq!(run(&layout, &sealer).outcome, Outcome::NothingToMigrate);
    assert!(!webui_chromium(&layout).exists());
    assert!(!layout.rnw_chromium.join(names::CHROMIUM_LOCK_FILE).exists());
    let marker = read_chromium_marker(&layout.webui_data).unwrap();
    assert!(valid_chromium_marker(&marker));
    assert_eq!(run(&layout, &sealer).outcome, Outcome::AlreadyMigrated);
}

#[test]
fn a_scratch_data_dir_reads_the_rnw_profile_from_its_chromium_folder() {
    let scratch = Scratch::new("chromium-custom");
    let sealer = FakeDpapi::new();
    let rnw = scratch.0.join("rnw");
    let layout = Layout::custom(rnw.to_str().unwrap(), &scratch.0.join("webui"), true);
    assert_eq!(layout.rnw_chromium, rnw.join("Chromium"));
    seed_rnw(&layout, &sealer);
    assert_eq!(run(&layout, &sealer).outcome, Outcome::Migrated);
    assert_eq!(
        fs::read(webui_chromium(&layout).join("Ardia default/History")).unwrap(),
        b"rnw history"
    );
}

#[test]
fn the_documents_step_still_leaves_chromium_to_this_one() {
    let scratch = Scratch::new("chromium-documents");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    write(&layout.rnw_data.join("session.json"), b"{}");
    let report = ardia_shell_migration::migrate(&layout, &sealer, &FakeVault::empty(), &Faults::default());
    assert_eq!(report.outcome, Outcome::Migrated);
    assert!(!webui_chromium(&layout).exists());
    assert_eq!(run(&layout, &sealer).outcome, Outcome::Migrated);
}

#[test]
fn a_failed_run_counts_attempts_and_says_where_it_stopped() {
    let scratch = Scratch::new("chromium-attempts");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let tight = Faults {
        free_space: Some(0),
        ..Faults::default()
    };
    assert_eq!(migrate_chromium(&layout, &sealer, &tight).attempt, 1);
    let second = migrate_chromium(&layout, &sealer, &tight);
    assert_eq!(second.attempt, 2);
    assert_eq!(second.prior_failed_stage.map(|s| s.as_str()), Some("space"));
    let third = run(&layout, &sealer);
    assert_eq!(third.outcome, Outcome::Migrated);
    assert_eq!(third.attempt, 3);
    let json = third.to_json();
    assert_eq!(json["prior_failed_stage"], "space");
    assert!(json.get("failed_stage").is_none());
}

#[test]
fn overlapping_folders_are_refused() {
    let scratch = Scratch::new("chromium-overlap");
    let sealer = FakeDpapi::new();
    let base = layout(&scratch.0);
    let inside = Layout {
        webui_data: base.rnw_chromium.join("WebUI"),
        ..base.clone()
    };
    let around = Layout {
        rnw_chromium: base.webui_data.join("Chromium"),
        ..base.clone()
    };
    let relative = Layout {
        rnw_chromium: "User Data".into(),
        ..base.clone()
    };
    for layout in [inside, around, relative] {
        let report = run(&layout, &sealer);
        assert_eq!(report.outcome, Outcome::Refused, "{layout:?}");
        assert_eq!(report.exit_code(), 2);
    }
}

#[cfg(unix)]
#[test]
fn links_in_the_rnw_profile_are_skipped() {
    use std::os::unix::fs::symlink;
    let scratch = Scratch::new("chromium-links");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let secret = scratch.0.join("secret");
    write(&secret.join("passwords.txt"), b"elsewhere");
    symlink(&secret, layout.rnw_chromium.join("Default/Linked")).unwrap();
    symlink(
        secret.join("passwords.txt"),
        layout.rnw_chromium.join("Default/linked.txt"),
    )
    .unwrap();
    symlink(&secret, layout.rnw_chromium.join("Ardia p-linked")).unwrap();
    fs::hard_link(
        secret.join("passwords.txt"),
        layout.rnw_chromium.join("Default/hard.txt"),
    )
    .unwrap();
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::MigratedWithSkips);
    let counted = counts(&report);
    assert_eq!(counted["skipped_links"], 3);
    assert_eq!(counted["skipped_invalid"], 1);
    let chromium = webui_chromium(&layout);
    assert!(!chromium.join("Ardia p-linked").exists());
    for path in files(&chromium).keys() {
        assert!(!path.contains("inked") && !path.contains("hard"), "{path}");
    }
}

#[test]
fn merging_a_local_state_changes_only_the_dpapi_key() {
    let existing = json!({
        "a": 1,
        "os_crypt": { "encrypted_key": "old", "app_bound_encrypted_key": "webui", "audit_enabled": true }
    });
    let merged: Value = serde_json::from_slice(&merged_local_state(existing.as_object(), "new")).unwrap();
    assert_eq!(
        merged,
        json!({ "a": 1, "os_crypt": { "encrypted_key": "new", "app_bound_encrypted_key": "webui", "audit_enabled": true } })
    );
    let fresh: Value = serde_json::from_slice(&merged_local_state(None, "new")).unwrap();
    assert_eq!(fresh, json!({ "os_crypt": { "encrypted_key": "new" } }));
    let odd = json!({ "os_crypt": "not an object" });
    let fixed: Value = serde_json::from_slice(&merged_local_state(odd.as_object(), "new")).unwrap();
    assert_eq!(fixed, json!({ "os_crypt": { "encrypted_key": "new" } }));
}

#[test]
fn base64_round_trips_and_rejects_junk() {
    for length in 0..40 {
        let bytes: Vec<u8> = (0..length).map(|i| (i * 37 + 11) as u8).collect();
        assert_eq!(base64_decode(&base64(&bytes)).unwrap(), bytes, "{length}");
    }
    for junk in ["***", "A", "AB=C", "ABC===", "AB\nC", "ABCD=", "ABC"] {
        assert!(base64_decode(junk).is_none(), "{junk}");
    }
}

#[test]
fn profile_folders_map_the_way_both_shells_name_them() {
    assert_eq!(names::webui_profile_folder("Default").as_deref(), Some("Ardia default"));
    assert_eq!(
        names::webui_profile_folder("Ardia p-1a2b").as_deref(),
        Some("Ardia p-1a2b")
    );
    for refused in [
        "default",
        "Ardia ",
        "Ardia P-1",
        "Ardia a b",
        "Ardia a_b",
        "Profile 1",
        "System Profile",
        "Ardia ü",
    ] {
        assert_eq!(names::webui_profile_folder(refused), None, "{refused}");
    }
    assert!(names::profile_transient(&[], "Cache"));
    assert!(names::profile_transient(&[], "code cache"));
    assert!(names::profile_transient(&["Service Worker".into()], "CacheStorage"));
    assert!(!names::profile_transient(&["Service Worker".into()], "Database"));
    assert!(!names::profile_transient(&["Network".into()], "Cache"));
    assert!(names::profile_transient(&["IndexedDB".into(), "x".into()], "LOCK"));
    assert!(!names::profile_transient(&[], "History"));
    let package: Vec<String> = vec!["Extensions".into(), "abc".into(), "1.0_0".into()];
    assert!(!names::profile_transient(&package, "singleton.js"));
    assert!(!names::profile_transient(&package, "LOCK"));
    assert!(!names::profile_transient(&package, "lockfile"));
    assert!(names::profile_transient(&[], "SingletonLock"));
}

#[test]
fn a_staged_copy_is_bound_to_the_key_it_was_staged_with() {
    let scratch = Scratch::new("chromium-key-binding");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let first = migrate_chromium(&layout, &sealer, &faults(Some(Stop::Fail(2))));
    assert_eq!(first.outcome, Outcome::Failed);
    assert!(layout.webui_data.join(names::CHROMIUM_PROGRESS_NAME).exists());
    let newer = chromium_key(&sealer, &[5; 32]);
    let state = json!({ "os_crypt": { "encrypted_key": newer } });
    fs::write(
        layout.rnw_chromium.join(names::LOCAL_STATE),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    fs::write(
        layout.rnw_chromium.join("Default/Network/Cookies"),
        cookie(&newer, "after-rnw-ran-again"),
    )
    .unwrap();
    let second = run(&layout, &sealer);
    assert_eq!(second.outcome, Outcome::Migrated, "{}", second.to_json());
    let chromium = webui_chromium(&layout);
    assert_eq!(live_key(&chromium).as_deref(), Some(newer.as_str()));
    assert!(has_line(
        &chromium.join("Ardia default/Network/Cookies"),
        &format!("{newer}|after-rnw-ran-again")
    ));
}

#[cfg(unix)]
#[test]
fn skips_found_while_staging_still_count_after_a_resume() {
    let scratch = Scratch::new("chromium-skips-resume");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let elsewhere = scratch.0.join("elsewhere.txt");
    write(&elsewhere, b"linked");
    fs::hard_link(&elsewhere, layout.rnw_chromium.join("Default/hard.txt")).unwrap();
    assert_eq!(
        migrate_chromium(&layout, &sealer, &faults(Some(Stop::Fail(2)))).outcome,
        Outcome::Failed
    );
    let resumed = run(&layout, &sealer);
    assert_eq!(resumed.outcome, Outcome::MigratedWithSkips, "{}", resumed.to_json());
    assert_eq!(counts(&resumed)["skipped_invalid"], 1);
}

#[test]
fn a_profile_restored_by_hand_between_tries_is_still_left_alone() {
    let scratch = Scratch::new("chromium-restored-between");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_key = seed_rnw(&layout, &sealer);
    let chromium = webui_chromium(&layout);
    write(&chromium.join(names::LOCAL_STATE), &webui_state_with(&rnw_key));
    write(&chromium.join("Ardia default/Preferences"), b"{}");
    assert_eq!(
        migrate_chromium(&layout, &sealer, &faults(Some(Stop::Fail(2)))).outcome,
        Outcome::Failed
    );
    write(
        &chromium.join("Ardia p-work/History"),
        b"restored by hand between tries",
    );
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(
        fs::read(chromium.join("Ardia p-work/History")).unwrap(),
        b"restored by hand between tries"
    );
    assert!(kept_folders(&layout).is_empty());
}

#[test]
fn a_staged_entry_whose_kind_changed_is_replaced() {
    let scratch = Scratch::new("chromium-kind-changed");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let staged = layout
        .webui_data
        .join(names::CHROMIUM_STAGING_FOLDER)
        .join("Ardia default");
    write(&staged.join("Extensions"), b"a file where RNW now has a folder");
    write(&staged.join("History/inner"), b"a folder where RNW now has a file");
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    let live = webui_chromium(&layout).join("Ardia default");
    assert_eq!(fs::read(live.join("History")).unwrap(), b"rnw history");
    assert!(live.join("Extensions/abcdef/1.0_0/manifest.json").is_file());
}

fn progress(layout: &Layout) -> Option<Value> {
    serde_json::from_slice(&fs::read(layout.webui_data.join(names::CHROMIUM_PROGRESS_NAME)).ok()?).ok()
}

fn crash_until(layout: &Layout, sealer: &FakeDpapi, wanted: impl Fn(&Value) -> bool) -> usize {
    crash_until_on(layout, sealer, |progress, _| wanted(progress))
}

fn crash_until_on(layout: &Layout, sealer: &FakeDpapi, wanted: impl Fn(&Value, &Layout) -> bool) -> usize {
    for at in 1..=20 {
        let scratch = Scratch::new("chromium-probe");
        let probe = self::layout(&scratch.0);
        let _ = seed_both(&probe, sealer);
        let report = migrate_chromium(&probe, sealer, &faults(Some(Stop::Crash(at))));
        if report.outcome == Outcome::Failed && progress(&probe).is_some_and(|p| wanted(&p, &probe)) {
            let real = migrate_chromium(layout, sealer, &faults(Some(Stop::Crash(at))));
            assert_eq!(real.outcome, Outcome::Failed);
            return at;
        }
    }
    panic!("no crash point reached the wanted progress");
}

#[test]
fn a_progress_file_that_says_the_key_is_in_place_is_checked_against_the_live_key() {
    let scratch = Scratch::new("chromium-progress-lies-key");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let seeded = seed_both(&layout, &sealer);
    let chromium = webui_chromium(&layout);
    let original = fs::read(chromium.join(names::LOCAL_STATE)).unwrap();
    crash_until(&layout, &sealer, |p| {
        p["local_state"] == json!(true) && p["installed"] == json!([])
    });
    assert_eq!(progress(&layout).unwrap()["local_state"], json!(true));
    fs::write(chromium.join(names::LOCAL_STATE), &original).unwrap();
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    let mut fresh = 0;
    launch_chromium(&layout, &mut fresh);
    assert_eq!(live_key(&chromium).as_deref(), Some(seeded.rnw_key.as_str()));
    assert!(has_line(
        &chromium.join("Ardia default/Network/Cookies"),
        &format!("{}|rnw-cookie", seeded.rnw_key)
    ));
}

#[test]
fn a_profile_the_record_calls_installed_but_that_is_back_in_staging_is_installed_again() {
    let scratch = Scratch::new("chromium-progress-lies-installed");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let seeded = seed_both(&layout, &sealer);
    crash_until(&layout, &sealer, |p| {
        p["installed"]
            .as_array()
            .is_some_and(|i| i.iter().any(|n| n == "Ardia default"))
    });
    let staging = layout.webui_data.join(names::CHROMIUM_STAGING_FOLDER);
    fs::create_dir_all(&staging).unwrap();
    fs::rename(
        webui_chromium(&layout).join("Ardia default"),
        staging.join("Ardia default"),
    )
    .unwrap();
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    let mut fresh = 0;
    launch_chromium(&layout, &mut fresh);
    assert_nothing_lost(&layout, &seeded, "installed again");
}

#[test]
fn a_regular_file_where_a_restored_profile_should_be_is_moved_aside() {
    let scratch = Scratch::new("chromium-restored-file");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_key = seed_rnw(&layout, &sealer);
    let chromium = webui_chromium(&layout);
    write(&chromium.join(names::LOCAL_STATE), &webui_state_with(&rnw_key));
    write(&chromium.join("Ardia default"), b"not a profile");
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(
        fs::read(chromium.join("Ardia default/History")).unwrap(),
        b"rnw history"
    );
    assert_eq!(
        fs::read(kept_folders(&layout)[0].join("Ardia default")).unwrap(),
        b"not a profile"
    );
}

#[test]
fn everything_restored_by_hand_finishes_without_needing_disk_space() {
    let scratch = Scratch::new("chromium-restored-all");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_key = seed_rnw(&layout, &sealer);
    let chromium = webui_chromium(&layout);
    write(&chromium.join(names::LOCAL_STATE), &webui_state_with(&rnw_key));
    write(&chromium.join("Ardia default/Preferences"), b"{}");
    write(&chromium.join("Ardia p-work/Preferences"), b"{}");
    let tight = Faults {
        free_space: Some(1024),
        ..Faults::default()
    };
    let report = migrate_chromium(&layout, &sealer, &tight);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(counts(&report)["key_shared"], 1);
}

#[test]
fn a_profile_removed_from_rnw_after_its_key_changed_is_dropped_from_the_plan() {
    let scratch = Scratch::new("chromium-key-and-profile-change");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    assert_eq!(
        migrate_chromium(&layout, &sealer, &faults(Some(Stop::Fail(2)))).outcome,
        Outcome::Failed
    );
    let newer = chromium_key(&sealer, &[5; 32]);
    let state = json!({ "os_crypt": { "encrypted_key": newer } });
    fs::write(
        layout.rnw_chromium.join(names::LOCAL_STATE),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    fs::remove_dir_all(layout.rnw_chromium.join("Ardia p-work")).unwrap();
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(profiles(&webui_chromium(&layout)), ["Ardia default"]);
}

#[cfg(unix)]
#[test]
fn a_hard_linked_lockfile_is_refused_and_left_alone() {
    let scratch = Scratch::new("chromium-hard-lockfile");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let elsewhere = scratch.0.join("elsewhere");
    write(&elsewhere, b"not a lockfile");
    let root = ardia_shell_migration::fsafe::Root::new(&layout.rnw_chromium).unwrap();
    fs::hard_link(&elsewhere, layout.rnw_chromium.join("held")).unwrap();
    assert!(root.dir().hold_lockfile("held").is_err());
    assert_eq!(fs::read(&elsewhere).unwrap(), b"not a lockfile");
    assert!(layout.rnw_chromium.join("held").exists());
}

#[test]
fn a_cookie_added_in_rnw_after_a_rolled_back_try_is_migrated() {
    let scratch = Scratch::new("chromium-fresh-after-rollback");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let seeded = seed_both(&layout, &sealer);
    let live_before = live_files_without_lock(&layout);
    let at = (1..=12)
        .find(|at| {
            let probe_scratch = Scratch::new("chromium-rollback-probe");
            let probe = self::layout(&probe_scratch.0);
            seed_both(&probe, &sealer);
            let report = migrate_chromium(&probe, &sealer, &faults(Some(Stop::Fail(*at))));
            let counted = counts(&report);
            report.outcome == Outcome::Failed && counted["key_carried"] == 1 && counted["swap_rolled_back"] == 1
        })
        .expect("some failure lands after the key write and rolls it back");
    let rolled = migrate_chromium(&layout, &sealer, &faults(Some(Stop::Fail(at))));
    assert_eq!(counts(&rolled)["key_carried"], 1);
    assert_eq!(counts(&rolled)["swap_rolled_back"], 1);
    assert_eq!(
        live_files_without_lock(&layout),
        live_before,
        "the rollback put 0.2.49 back exactly"
    );
    let cookies = layout.rnw_chromium.join("Default/Network/Cookies");
    let mut text = fs::read(&cookies).unwrap();
    text.extend(cookie(&seeded.rnw_key, "signed-in-after-the-rollback"));
    fs::write(&cookies, text).unwrap();
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert!(has_line(
        &webui_chromium(&layout).join("Ardia default/Network/Cookies"),
        &format!("{}|signed-in-after-the-rollback", seeded.rnw_key)
    ));
    let mut fresh = 0;
    launch_chromium(&layout, &mut fresh);
    assert_nothing_lost(&layout, &seeded, "after the rollback");
}

#[test]
fn a_restored_plan_is_planned_again_when_the_webui_key_changed() {
    let scratch = Scratch::new("chromium-restored-key-moved");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_key = seed_rnw(&layout, &sealer);
    let chromium = webui_chromium(&layout);
    write(&chromium.join(names::LOCAL_STATE), &webui_state_with(&rnw_key));
    write(&chromium.join("Ardia default/Preferences"), b"{}");
    let mut crashed_after_plan = false;
    for at in 1..=8 {
        let report = migrate_chromium(&layout, &sealer, &faults(Some(Stop::Crash(at))));
        if report.outcome != Outcome::Failed {
            break;
        }
        let saved = progress(&layout);
        if saved
            .as_ref()
            .is_some_and(|p| p["mode"] == "restored" && p["local_state"] == json!(true) && p["installed"] == json!([]))
        {
            crashed_after_plan = true;
            break;
        }
    }
    assert!(crashed_after_plan, "a crash stops a restored plan before it installs");
    let other = "T1RIRVI=";
    write(&chromium.join(names::LOCAL_STATE), &webui_state_with(other));
    write(
        &chromium.join("Ardia default/Network/Cookies"),
        &cookie(other, "under-a-new-key"),
    );
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(counts(&report)["key_shared"], 0, "planned again as a replace");
    assert_eq!(live_key(&chromium).as_deref(), Some(rnw_key.as_str()));
    assert!(has_line(
        &chromium.join("Ardia p-work/Network/Cookies"),
        &format!("{rnw_key}|work-cookie")
    ));
    assert!(kept_holds(&layout, "Ardia default", other, "under-a-new-key"));
    assert_backups_open_with_their_own_key(&layout, "restored then rekeyed");
}

#[test]
fn a_profile_chromium_recreated_after_the_key_swap_is_kept_beside_the_key_that_opens_it() {
    let scratch = Scratch::new("chromium-recreated-after-swap");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let seeded = seed_both(&layout, &sealer);
    crash_until(&layout, &sealer, |p| {
        p["local_state"] == json!(true) && p["installed"] == json!([])
    });
    let mut fresh = 0;
    launch_chromium(&layout, &mut fresh);
    let recreated = webui_chromium(&layout).join("Ardia default/Network/Cookies");
    assert!(has_line(&recreated, &format!("{}|made-after-a-crash", seeded.rnw_key)));
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert!(kept_holds(
        &layout,
        "Ardia default",
        &seeded.rnw_key,
        "made-after-a-crash"
    ));
    launch_chromium(&layout, &mut fresh);
    assert_nothing_lost(&layout, &seeded, "recreated after the swap");
}

#[test]
fn a_rekeyed_webui_under_an_installed_profile_is_backed_up_before_the_key_is_written_again() {
    let scratch = Scratch::new("chromium-installed-rekeyed");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let seeded = seed_both(&layout, &sealer);
    crash_until(&layout, &sealer, |p| {
        p["local_state"] == json!(true)
            && p["installed"]
                .as_array()
                .is_some_and(|i| i.iter().any(|n| n == "Ardia default"))
    });
    let chromium = webui_chromium(&layout);
    let other = "UkVLRVlFRA==";
    write(&chromium.join(names::LOCAL_STATE), &webui_state_with(other));
    write(
        &chromium.join("Ardia default/Network/Cookies"),
        &cookie(other, "browsed-under-another-key"),
    );
    let mut fresh = 0;
    launch_chromium(&layout, &mut fresh);
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(live_key(&chromium).as_deref(), Some(seeded.rnw_key.as_str()));
    assert!(kept_holds(&layout, "Ardia default", other, "browsed-under-another-key"));
    assert_backups_open_with_their_own_key(&layout, "installed then rekeyed");
}

#[test]
fn an_unfinished_restored_plan_becomes_a_replace_when_rnw_changes_its_key() {
    let scratch = Scratch::new("chromium-restored-rnw-rekeyed");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_key = seed_rnw(&layout, &sealer);
    let chromium = webui_chromium(&layout);
    write(&chromium.join(names::LOCAL_STATE), &webui_state_with(&rnw_key));
    write(&chromium.join("Ardia default/Preferences"), b"{}");
    let mut stopped = false;
    for at in 1..=6 {
        let report = migrate_chromium(&layout, &sealer, &faults(Some(Stop::Crash(at))));
        if report.outcome != Outcome::Failed {
            break;
        }
        if progress(&layout).is_some_and(|p| p["mode"] == "restored" && p["local_state"] == json!(false)) {
            stopped = true;
            break;
        }
    }
    assert!(stopped, "a crash leaves an unfinished restored plan");
    let newer = chromium_key(&sealer, &[6; 32]);
    let state = json!({ "os_crypt": { "encrypted_key": newer } });
    fs::write(
        layout.rnw_chromium.join(names::LOCAL_STATE),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    fs::write(
        layout.rnw_chromium.join("Ardia p-work/Network/Cookies"),
        cookie(&newer, "after-rnw-rekeyed"),
    )
    .unwrap();
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(counts(&report)["key_shared"], 0);
    assert_eq!(live_key(&chromium).as_deref(), Some(newer.as_str()));
    assert!(has_line(
        &chromium.join("Ardia p-work/Network/Cookies"),
        &format!("{newer}|after-rnw-rekeyed")
    ));
}

#[test]
fn running_out_of_disk_after_the_key_swap_keeps_the_record_that_finishes_it() {
    let scratch = Scratch::new("chromium-space-after-swap");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let seeded = seed_both(&layout, &sealer);
    crash_until(&layout, &sealer, |p| {
        p["local_state"] == json!(true) && p["installed"] == json!([])
    });
    let mut fresh = 0;
    launch_chromium(&layout, &mut fresh);
    let tight = Faults {
        free_space: Some(1024),
        ..Faults::default()
    };
    let starved = migrate_chromium(&layout, &sealer, &tight);
    assert_eq!(starved.outcome, Outcome::Failed);
    assert_eq!(starved.failed_stage.map(|s| s.as_str()), Some("space"));
    assert_eq!(progress(&layout).unwrap()["local_state"], json!(true));
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    launch_chromium(&layout, &mut fresh);
    assert_nothing_lost(&layout, &seeded, "out of disk after the swap");
}

#[test]
fn running_out_of_disk_after_the_key_write_but_before_its_record_keeps_the_plan() {
    let scratch = Scratch::new("chromium-space-key-unrecorded");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let seeded = seed_both(&layout, &sealer);
    crash_until_on(&layout, &sealer, |p, probe| {
        let rnw: Value =
            serde_json::from_slice(&fs::read(probe.rnw_chromium.join(names::LOCAL_STATE)).unwrap()).unwrap();
        p["local_state"] == json!(false)
            && live_key(&webui_chromium(probe)).as_deref() == rnw["os_crypt"]["encrypted_key"].as_str()
    });
    let mut fresh = 0;
    launch_chromium(&layout, &mut fresh);
    let tight = Faults {
        free_space: Some(1024),
        ..Faults::default()
    };
    let starved = migrate_chromium(&layout, &sealer, &tight);
    assert_eq!(starved.failed_stage.map(|s| s.as_str()), Some("space"));
    assert!(progress(&layout).is_some(), "the plan survives the low-disk cleanup");
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(counts(&report)["key_shared"], 0, "still a replace");
    launch_chromium(&layout, &mut fresh);
    assert_nothing_lost(&layout, &seeded, "out of disk before the record");
}

#[test]
fn a_cleared_staging_and_a_new_rnw_key_still_finish_the_migration() {
    let scratch = Scratch::new("chromium-cleared-then-rekeyed");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_both(&layout, &sealer);
    crash_until(&layout, &sealer, |p| {
        p["local_state"] == json!(true) && p["installed"] == json!([])
    });
    let mut fresh = 0;
    launch_chromium(&layout, &mut fresh);
    let tight = Faults {
        free_space: Some(1024),
        ..Faults::default()
    };
    assert_eq!(migrate_chromium(&layout, &sealer, &tight).outcome, Outcome::Failed);
    assert!(!layout.webui_data.join(names::CHROMIUM_STAGING_FOLDER).exists());
    let newer = chromium_key(&sealer, &[8; 32]);
    let state = json!({ "os_crypt": { "encrypted_key": newer } });
    fs::write(
        layout.rnw_chromium.join(names::LOCAL_STATE),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    fs::write(
        layout.rnw_chromium.join("Default/Network/Cookies"),
        cookie(&newer, "rnw-under-a-new-key"),
    )
    .unwrap();
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    let chromium = webui_chromium(&layout);
    assert_eq!(live_key(&chromium).as_deref(), Some(newer.as_str()));
    assert!(has_line(
        &chromium.join("Ardia default/Network/Cookies"),
        &format!("{newer}|rnw-under-a-new-key")
    ));
    launch_chromium(&layout, &mut fresh);
    assert_backups_open_with_their_own_key(&layout, "cleared then rekeyed");
}

#[test]
fn a_profile_made_in_rnw_between_tries_is_migrated_too() {
    let scratch = Scratch::new("chromium-late-profile");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let seeded = seed_both(&layout, &sealer);
    crash_until(&layout, &sealer, |p| {
        p["local_state"] == json!(true) && p["installed"] == json!([])
    });
    write(&layout.rnw_chromium.join("Ardia p-late/Preferences"), b"{}");
    write(
        &layout.rnw_chromium.join("Ardia p-late/Network/Cookies"),
        &cookie(&seeded.rnw_key, "late-cookie"),
    );
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert!(has_line(
        &webui_chromium(&layout).join("Ardia p-late/Network/Cookies"),
        &format!("{}|late-cookie", seeded.rnw_key)
    ));
}

#[test]
fn a_profile_restored_by_hand_between_tries_is_not_staged_again() {
    let scratch = Scratch::new("chromium-restored-not-staged");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_key = seed_rnw(&layout, &sealer);
    let chromium = webui_chromium(&layout);
    write(&chromium.join(names::LOCAL_STATE), &webui_state_with(&rnw_key));
    write(&chromium.join("Ardia default/Preferences"), b"{}");
    assert_eq!(
        migrate_chromium(&layout, &sealer, &faults(Some(Stop::Fail(2)))).outcome,
        Outcome::Failed
    );
    assert_eq!(progress(&layout).unwrap()["mode"], "restored");
    write(&chromium.join("Ardia p-work/Preferences"), b"restored by hand");
    let tight = Faults {
        free_space: Some(1024),
        ..Faults::default()
    };
    let report = migrate_chromium(&layout, &sealer, &tight);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(
        fs::read(chromium.join("Ardia p-work/Preferences")).unwrap(),
        b"restored by hand"
    );
}

#[cfg(unix)]
#[test]
fn a_backup_that_stops_part_way_already_holds_the_key_beside_it() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("chromium-backup-stops");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let seeded = seed_both(&layout, &sealer);
    let locked = webui_chromium(&layout).join("Ardia p-new/History");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::File::open(&locked).is_ok() {
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
        return;
    }
    let report = run(&layout, &sealer);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(report.outcome, Outcome::Failed, "{}", report.to_json());
    assert_eq!(report.failed_stage.map(|s| s.as_str()), Some("backup"));
    assert_backups_open_with_their_own_key(&layout, "a backup that stopped");
    for folder in kept_folders(&layout) {
        if !profiles(&folder).is_empty() {
            assert_eq!(live_key(&folder).as_deref(), Some(seeded.webui_key.as_str()));
        }
    }
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    let mut fresh = 0;
    launch_chromium(&layout, &mut fresh);
    assert_nothing_lost(&layout, &seeded, "after a stopped backup");
}

#[test]
fn rnw_changing_its_key_after_a_profile_is_installed_moves_it_aside_and_installs_it_again() {
    let mut second_stops = 0;
    for second in 1..=10 {
        let scratch = Scratch::new("chromium-rekey-after-install");
        let sealer = FakeDpapi::new();
        let layout = layout(&scratch.0);
        let seeded = seed_both(&layout, &sealer);
        crash_until(&layout, &sealer, |p| {
            p["local_state"] == json!(true)
                && p["installed"]
                    .as_array()
                    .is_some_and(|i| i.iter().any(|n| n == "Ardia default"))
        });
        let mut fresh = 0;
        launch_chromium(&layout, &mut fresh);
        let newer = chromium_key(&sealer, &[4; 32]);
        let state = json!({ "os_crypt": { "encrypted_key": newer } });
        fs::write(
            layout.rnw_chromium.join(names::LOCAL_STATE),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        fs::write(
            layout.rnw_chromium.join("Default/Network/Cookies"),
            cookie(&newer, "rnw-rekeyed"),
        )
        .unwrap();
        let label = format!("second stop at {second}");
        let stopped = migrate_chromium(&layout, &sealer, &faults(Some(Stop::Crash(second))));
        if stopped.outcome == Outcome::Failed {
            second_stops += 1;
            if let Some(saved) = progress(&layout) {
                if saved["local_state"] == json!(false) {
                    assert_eq!(
                        saved["installed"],
                        json!([]),
                        "{label}: an unwritten key has nothing installed"
                    );
                }
            }
            launch_chromium(&layout, &mut fresh);
        }
        let report = run(&layout, &sealer);
        assert!(
            matches!(report.outcome, Outcome::Migrated | Outcome::AlreadyMigrated),
            "{label}: {}",
            report.to_json()
        );
        launch_chromium(&layout, &mut fresh);
        let chromium = webui_chromium(&layout);
        assert_eq!(live_key(&chromium).as_deref(), Some(newer.as_str()), "{label}");
        assert!(
            has_line(
                &chromium.join("Ardia default/Network/Cookies"),
                &format!("{newer}|rnw-rekeyed")
            ),
            "{label}: the default profile is installed again under the new key"
        );
        assert!(
            kept_holds(&layout, "Ardia default", &seeded.rnw_key, "rnw-cookie"),
            "{label}: the copy installed under the old key is kept beside it"
        );
        assert_backups_open_with_their_own_key(&layout, &label);
        if stopped.outcome != Outcome::Failed {
            break;
        }
    }
    assert!(second_stops >= 3, "{second_stops}");
}

#[test]
fn an_empty_saved_plan_still_picks_up_a_profile_made_in_rnw_since() {
    let scratch = Scratch::new("chromium-empty-plan-late");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_key = seed_rnw(&layout, &sealer);
    let chromium = webui_chromium(&layout);
    write(&chromium.join(names::LOCAL_STATE), &webui_state_with(&rnw_key));
    write(&chromium.join("Ardia default/Preferences"), b"{}");
    write(&chromium.join("Ardia p-work/Preferences"), b"{}");
    let mut saved_empty = false;
    for at in 1..=6 {
        let report = migrate_chromium(&layout, &sealer, &faults(Some(Stop::Crash(at))));
        if report.outcome != Outcome::Failed {
            break;
        }
        if progress(&layout).is_some_and(|p| p["profiles"] == json!([])) {
            saved_empty = true;
            break;
        }
    }
    assert!(saved_empty, "a crash saved an empty plan");
    write(&layout.rnw_chromium.join("Ardia p-late/Preferences"), b"{}");
    write(
        &layout.rnw_chromium.join("Ardia p-late/Network/Cookies"),
        &cookie(&rnw_key, "late-cookie"),
    );
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert!(has_line(
        &chromium.join("Ardia p-late/Network/Cookies"),
        &format!("{rnw_key}|late-cookie")
    ));
}
