use super::*;

pub struct Scratch {
    pub dir: tempfile::TempDir,
    pub root: PathBuf,
    pub places: Places,
}

pub fn scratch() -> Scratch {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let mut places = Places::new(root.join("Programs"), root.join("bin"));
    places.shadowable = vec![root.join("system")];
    places.confined = Some(root.clone());
    Scratch { dir, root, places }
}

pub fn plugin_folder(
    root: &Path,
    name: &str,
    version: &str,
    programs: &[&str],
) -> (PathBuf, String) {
    let folder = root.join("plugins").join(format!("{name}-{version}"));
    std::fs::create_dir_all(folder.join("bin")).unwrap();
    let listed: Vec<String> = programs
        .iter()
        .map(|p| format!(r#"{{"name":"{p}","path":"bin/{p}"}}"#))
        .collect();
    let text = format!(
        r#"{{"manifest":2,"name":"{name}","title":"{name}","version":"{version}","contributes":{{"programs":[{}]}}}}"#,
        listed.join(",")
    );
    std::fs::write(folder.join(MANIFEST_FILE), &text).unwrap();
    for program in programs {
        let path = folder.join("bin").join(program);
        std::fs::write(&path, format!("#!/bin/sh\necho {program} {version}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    (folder, text)
}

fn programs_of(names: &[&str]) -> Vec<Program> {
    names
        .iter()
        .map(|n| Program {
            name: (*n).to_owned(),
            path: format!("bin/{n}"),
        })
        .collect()
}

fn install_version(
    s: &Scratch,
    name: &str,
    version: &str,
    programs: &[&str],
) -> Result<Linked, String> {
    let (folder, text) = plugin_folder(&s.root, name, version, programs);
    let id = format!("id-{name}-{version}");
    install(
        name,
        &folder,
        &id,
        &approval_hash(&text, &id),
        Some(version),
        &programs_of(programs),
        &s.places,
    )
}

fn bin_target(s: &Scratch, program: &str) -> Option<String> {
    link_target(&s.places.bin_dir.join(program))
}

#[test]
fn installing_copies_seals_and_links_into_the_bin_folder() {
    let s = scratch();
    let linked = install_version(&s, "kit", "1.0.0", &["kit"]).unwrap();
    assert_eq!(linked.linked, vec!["kit".to_owned()]);
    assert!(linked.refused.is_empty());
    let current = s.places.plugin_store("kit").join(CURRENT);
    assert_eq!(link_target(&current), Some(linked.version.clone()));
    assert!(linked.version.starts_with("1.0.0-"));
    assert_eq!(
        bin_target(&s, "kit"),
        Some(
            s.places
                .plugin_store("kit")
                .join("current/bin/kit")
                .display()
                .to_string()
        )
    );
    let via_link = std::fs::read_to_string(s.places.bin_dir.join("kit")).unwrap();
    assert!(via_link.contains("kit 1.0.0"));
    let copied = s
        .places
        .plugin_store("kit")
        .join(&linked.version)
        .join("bin/kit");
    assert_eq!(std::fs::metadata(&copied).unwrap().mode() & 0o777, 0o555);
    assert!(
        s.places
            .plugin_store("kit")
            .join(&linked.version)
            .join(LEASES)
            .is_dir()
    );
    let again = install_version(&s, "kit", "1.0.0", &["kit"]).unwrap();
    assert_eq!(again.version, linked.version);
    drop(s.dir);
}

#[test]
fn conflicts_are_refused_with_the_old_copy() {
    let s = scratch();
    std::fs::create_dir_all(&s.places.bin_dir).unwrap();
    std::fs::write(s.places.bin_dir.join("taken"), b"mine").unwrap();
    std::fs::create_dir_all(s.root.join("system")).unwrap();
    let hidden = s.root.join("system/ls");
    std::fs::write(&hidden, b"").unwrap();
    std::fs::set_permissions(&hidden, std::fs::Permissions::from_mode(0o755)).unwrap();
    let linked = install_version(&s, "kit", "1.0.0", &["kit", "taken", "ls"]).unwrap();
    assert_eq!(linked.linked, vec!["kit".to_owned()]);
    assert_eq!(linked.refused["taken"].cause, Cause::Taken);
    assert_eq!(
        linked.refused["taken"].reason,
        format!(
            "{} is someone else's; remove it to use this one",
            s.places.bin_dir.join("taken").display()
        )
    );
    assert_eq!(linked.refused["ls"].cause, Cause::Shadowed);
    assert_eq!(
        linked.refused["ls"].reason,
        format!(
            "ls would hide {}, so it isn't put on PATH",
            hidden.display()
        )
    );
    assert_eq!(
        std::fs::read(s.places.bin_dir.join("taken")).unwrap(),
        b"mine"
    );
    let other = install_version(&s, "other", "1.0.0", &["kit"]).unwrap();
    assert!(other.linked.is_empty());
    assert_eq!(other.refused["kit"].cause, Cause::OtherPlugin);
    assert_eq!(
        other.refused["kit"].reason,
        "kit comes from the kit plugin; turn that one off to use this one"
    );
}

#[test]
fn updates_keep_the_previous_version_and_a_refused_update_keeps_the_old_one() {
    let s = scratch();
    let first = install_version(&s, "kit", "1.0.0", &["kit"]).unwrap();
    let second = install_version(&s, "kit", "1.1.0", &["kit"]).unwrap();
    let store = s.places.plugin_store("kit");
    assert_eq!(
        link_target(&store.join(CURRENT)),
        Some(second.version.clone())
    );
    assert_eq!(
        link_target(&store.join(PREVIOUS)),
        Some(first.version.clone())
    );
    assert!(
        std::fs::read_to_string(s.places.bin_dir.join("kit"))
            .unwrap()
            .contains("1.1.0")
    );
    let third = install_version(&s, "kit", "1.2.0", &["kit"]).unwrap();
    assert!(!store.join(&first.version).exists());
    assert_eq!(link_target(&store.join(PREVIOUS)), Some(second.version));

    std::fs::write(s.places.bin_dir.join("extra"), b"mine").unwrap();
    let held = install_version(&s, "kit", "2.0.0", &["kit", "extra"]).unwrap();
    assert!(held.linked.is_empty());
    assert_eq!(held.kept, Some(third.version.clone()));
    assert_eq!(held.refused["extra"].cause, Cause::Taken);
    assert_eq!(link_target(&store.join(CURRENT)), Some(third.version));
    assert!(
        std::fs::read_to_string(s.places.bin_dir.join("kit"))
            .unwrap()
            .contains("1.2.0")
    );
}

#[test]
fn programs_that_go_away_are_unlinked_and_withdraw_and_remove_clean_up() {
    let s = scratch();
    install_version(&s, "kit", "1.0.0", &["kit", "kit-helper"]).unwrap();
    assert!(bin_target(&s, "kit-helper").is_some());
    install_version(&s, "kit", "1.1.0", &["kit"]).unwrap();
    assert!(bin_target(&s, "kit-helper").is_none());
    install_version(&s, "tool", "1.0.0", &["tool"]).unwrap();
    withdraw("kit", &s.places, false);
    assert!(bin_target(&s, "kit").is_none());
    assert!(link_target(&s.places.plugin_store("kit").join(CURRENT)).is_none());
    assert!(bin_target(&s, "tool").is_some());
    assert!(remove("kit", &s.places));
    assert!(!s.places.plugin_store("kit").exists());
    withdraw_all_but(
        &BTreeSet::new(),
        &s.places,
        &BTreeSet::from(["tool".to_owned()]),
    );
    assert!(bin_target(&s, "tool").is_none());
    assert!(link_target(&s.places.plugin_store("tool").join(CURRENT)).is_some());
}

#[test]
fn links_and_reserved_names_in_a_plugin_are_refused() {
    let s = scratch();
    let (folder, text) = plugin_folder(&s.root, "kit", "1.0.0", &["kit"]);
    std::os::unix::fs::symlink("/etc/hosts", folder.join("hosts")).unwrap();
    let error = install(
        "kit",
        &folder,
        "id",
        &approval_hash(&text, "id"),
        Some("1.0.0"),
        &programs_of(&["kit"]),
        &s.places,
    )
    .err()
    .unwrap();
    assert_eq!(
        error,
        "hosts is a link; a plugin's programs may not contain links"
    );
    std::fs::remove_file(folder.join("hosts")).unwrap();
    std::fs::create_dir(folder.join(LEASES)).unwrap();
    let error = install(
        "kit",
        &folder,
        "id",
        &approval_hash(&text, "id"),
        Some("1.0.0"),
        &programs_of(&["kit"]),
        &s.places,
    )
    .err()
    .unwrap();
    assert_eq!(error, ".leases is reserved for Ardia");
    std::fs::remove_dir(folder.join(LEASES)).unwrap();
    let error = install(
        "kit",
        &folder,
        "id",
        "not-the-approval",
        Some("1.0.0"),
        &programs_of(&["kit"]),
        &s.places,
    )
    .err()
    .unwrap();
    assert_eq!(error, "its plugin.json changed since you approved it");
    let error = install(
        "kit",
        &folder,
        "id",
        &approval_hash(&text, "id"),
        Some("1.0.0"),
        &programs_of(&["missing"]),
        &s.places,
    )
    .err()
    .unwrap();
    assert_eq!(
        error,
        "its program bin/missing isn't an executable file in its folder"
    );
}

#[test]
fn scratch_instances_only_link_inside_their_data_folder() {
    let s = scratch();
    let data = s.root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    assert_eq!(
        places_for(&data, true, None, None).err().unwrap(),
        SCRATCH_NEEDS_BIN
    );
    assert_eq!(
        places_for(&data, true, None, Some("cliHome=/x"))
            .err()
            .unwrap(),
        SCRATCH_NEEDS_BIN
    );
    let outside = format!("cliBinDir={}", s.root.join("elsewhere").display());
    assert_eq!(
        places_for(&data, true, None, Some(&outside)).err().unwrap(),
        SCRATCH_OUTSIDE
    );
    let climbing = format!("cliBinDir={}/bin/../../escape", data.display());
    assert_eq!(
        places_for(&data, true, None, Some(&climbing))
            .err()
            .unwrap(),
        SCRATCH_OUTSIDE
    );
    std::fs::create_dir_all(s.root.join("real-bin")).unwrap();
    std::os::unix::fs::symlink(s.root.join("real-bin"), data.join("sneaky")).unwrap();
    let sneaky = format!("cliBinDir={}/sneaky/bin", data.display());
    assert_eq!(
        places_for(&data, true, None, Some(&sneaky)).err().unwrap(),
        SCRATCH_OUTSIDE
    );
    let inside = format!("cliBinDir={}/bin", data.display());
    let places = places_for(&data, true, None, Some(&inside)).unwrap();
    assert_eq!(places.bin_dir, data.join("bin"));
    assert_eq!(places.store, data.join("Programs"));
    assert_eq!(places.confined, Some(data.clone()));
    std::fs::create_dir_all(data.join("bin")).unwrap();
    std::fs::remove_dir(data.join("bin")).unwrap();
    std::os::unix::fs::symlink(s.root.join("real-bin"), data.join("bin")).unwrap();
    let refused = Bin::open(&places, true).err().unwrap();
    assert_eq!(refused.reason, SCRATCH_OUTSIDE);
    let home = Path::new("/Users/nobody");
    let real = places_for(&data, false, Some(home), None).unwrap();
    assert_eq!(real.bin_dir, home.join(".local/bin"));
    assert_eq!(
        real.store,
        home.join("Library/Application Support/Ardia/Programs")
    );
    assert_eq!(real.confined, None);
}

#[test]
fn a_shared_bin_folder_is_refused() {
    let s = scratch();
    std::fs::create_dir_all(&s.places.bin_dir).unwrap();
    std::fs::set_permissions(&s.places.bin_dir, std::fs::Permissions::from_mode(0o777)).unwrap();
    let linked = install_version(&s, "kit", "1.0.0", &["kit"]).unwrap();
    assert!(linked.linked.is_empty());
    assert_eq!(linked.refused["kit"].cause, Cause::BinShared);
}

#[test]
fn registry_claims_and_names() {
    let claims = BTreeMap::from([("ardia".to_owned(), "cli".to_owned())]);
    assert_eq!(registry_refusal(&claims, "ardia", "cli", true), None);
    assert_eq!(
        registry_refusal(&claims, "ardia", "cli", false).as_deref(),
        Some("ardia belongs to Ardia's official cli plugin")
    );
    assert_eq!(
        registry_refusal(&claims, "ardia", "other", true).as_deref(),
        Some("ardia belongs to Ardia's official cli plugin")
    );
    assert_eq!(registry_refusal(&claims, "kit", "other", false), None);
    assert_eq!(
        version_folder_name(Some("1.2.3"), "abcdef0123456789"),
        "1.2.3-abcdef012345"
    );
    assert_eq!(version_folder_name(Some("../x y"), "ab"), "xy-ab");
    assert_eq!(version_folder_name(None, "ab"), "0.0.0-ab");
    let store = Path::new("/s/Programs");
    assert_eq!(
        launcher_owner(b"/s/Programs/kit/current/bin/kit", store).as_deref(),
        Some("kit")
    );
    assert_eq!(launcher_owner(b"/s/Programs/kit/1.0/bin/kit", store), None);
    assert_eq!(launcher_owner(b"/s/Programs/kit/current/../x", store), None);
    assert_eq!(
        launcher_owner(b"/elsewhere/kit/current/bin/kit", store),
        None
    );
}
