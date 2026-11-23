mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use ardia_crypto::{Backend, Crypto};
use ardia_sync_core::{phrase, vault, wordlist, Error, SyncKeys, SyncKeysWith, LOCAL_SCOPE_TAG};
use serde_json::{json, Map, Value};
use support::*;

const VAULT_PAYLOADS: [&str; 5] = ["log-line", "pattern-1019", "pattern-1020", "pattern-1021", "empty"];

struct Inputs(Value);

impl Inputs {
    fn load() -> Self {
        Inputs(json(&vectors().join("inputs.json")))
    }

    fn entropy(&self, name: &str) -> Vec<u8> {
        hex(self.0["entropies"][name].as_str().unwrap())
    }

    fn keys(&self, name: &str) -> FixtureKeys {
        FixtureKeys::new(&self.entropy(name))
    }

    fn payload(&self, name: &str) -> Vec<u8> {
        base64_decode(self.0["payloads"][name].as_str().unwrap())
    }

    fn entropy_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.0["entropies"].as_object().unwrap().keys().cloned().collect();
        names.sort();
        names
    }

    fn scopes(&self) -> Vec<String> {
        self.0["scopes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|scope| scope.as_str().unwrap().to_owned())
            .collect()
    }

    fn list(&self, key: &str) -> &Vec<Value> {
        self.0[key].as_array().unwrap()
    }
}

fn nonce(text: &str) -> [u8; 12] {
    hex(text).try_into().unwrap()
}

fn path<C: Crypto>(keys: &SyncKeysWith<C>, scope: &str, name: &str) -> String {
    format!("vault/{}/{}/{name}", keys.chain_tag(), keys.scope_tag(scope))
}

fn wordlist_digest() -> String {
    hex_string(&Backend::sha256(wordlist::ENGLISH.join("\n").as_bytes()))
}

fn build(inputs: &Inputs) -> (Value, BTreeMap<String, Vec<u8>>) {
    let mut tree = BTreeMap::new();
    let mut chains = Map::new();
    for name in inputs.entropy_names() {
        let entropy = inputs.entropy(&name);
        let keys = SyncKeys::new(&entropy);
        let scope_tags: Map<String, Value> = inputs
            .scopes()
            .iter()
            .map(|scope| (scope.clone(), json!(keys.scope_tag(scope))))
            .collect();
        chains.insert(
            name.clone(),
            json!({
                "phrase": phrase::phrase(&entropy.clone().try_into().unwrap()).as_str(),
                "chainTag": keys.chain_tag(),
                "scopeTags": scope_tags,
            }),
        );
    }
    let mut passwords = Vec::new();
    for name in inputs.entropy_names() {
        let keys = inputs.keys(&name);
        for login in inputs.list("passwords") {
            let sealed = keys
                .seal_password(str(login, "password"), str(login, "origin"), str(login, "username"))
                .unwrap();
            passwords.push(json!({
                "entropy": name,
                "origin": login["origin"],
                "username": login["username"],
                "password": login["password"],
                "sealed": sealed,
            }));
        }
    }
    let local_states: Vec<Value> = inputs
        .list("localStates")
        .iter()
        .map(|state| {
            let keys = inputs.keys(str(state, "entropy"));
            let sealed = seal_fixed(
                &keys,
                &inputs.payload(str(state, "payload")),
                LOCAL_SCOPE_TAG,
                str(state, "fileId"),
                &nonce(str(state, "nonce")),
            )
            .unwrap();
            json!({
                "entropy": state["entropy"],
                "fileId": state["fileId"],
                "payload": state["payload"],
                "sealed": base64_encode(&sealed),
            })
        })
        .collect();
    let mut files = Vec::new();
    for file in inputs.list("vaultFiles") {
        let keys = inputs.keys(str(file, "entropy"));
        let (scope, id) = (str(file, "scope"), str(file, "id"));
        let sealed = seal_fixed(
            &keys,
            &inputs.payload(str(file, "payload")),
            &keys.scope_tag(scope),
            id,
            &nonce(str(file, "nonce")),
        )
        .unwrap();
        let path = path(&keys, scope, &vault::file_name(id));
        tree.insert(path.trim_start_matches("vault/").to_owned(), sealed);
        files.push(
            json!({"entropy": file["entropy"], "scope": scope, "payload": file["payload"], "id": id, "path": path}),
        );
    }
    let mut damaged = Vec::new();
    for file in inputs.list("damaged") {
        let keys = inputs.keys(str(file, "entropy"));
        let (scope, id) = (str(file, "scope"), str(file, "id"));
        let mut sealed = seal_fixed(
            &keys,
            &inputs.payload(str(file, "payload")),
            &keys.scope_tag(scope),
            id,
            &nonce(str(file, "nonce")),
        )
        .unwrap();
        sealed[file["flipByte"].as_u64().unwrap() as usize] ^= 1;
        let path = path(&keys, scope, &vault::file_name(id));
        tree.insert(path.trim_start_matches("vault/").to_owned(), sealed);
        damaged.push(
            json!({"entropy": file["entropy"], "scope": scope, "payload": file["payload"], "id": id, "path": path}),
        );
    }
    let mut pending = Vec::new();
    for file in inputs.list("pending") {
        let keys = inputs.keys(str(file, "entropy"));
        let (scope, id) = (str(file, "scope"), str(file, "id"));
        let path = path(&keys, scope, &format!(".{id}.nns.icloud"));
        tree.insert(path.trim_start_matches("vault/").to_owned(), Vec::new());
        pending.push(json!({"entropy": file["entropy"], "scope": scope, "id": id, "path": path}));
    }
    let expected = json!({
        "wordlistSha256": wordlist_digest(),
        "chains": chains,
        "passwords": passwords,
        "localStates": local_states,
        "vault": {"files": files, "damaged": damaged, "pending": pending},
    });
    (expected, tree)
}

#[test]
fn fixed_nonces_reproduce_every_committed_byte() {
    let inputs = Inputs::load();
    let (built, tree) = build(&inputs);
    let committed = json(&vectors().join("expected.json"));
    for key in ["wordlistSha256", "chains", "passwords", "localStates", "vault"] {
        assert_eq!(built[key], committed[key], "{key}");
    }
    assert_eq!(built, committed);
    let committed_tree = tree_of_vault();
    assert_eq!(
        tree.keys().collect::<Vec<_>>(),
        committed_tree.keys().collect::<Vec<_>>()
    );
    for (path, bytes) in &committed_tree {
        assert_eq!(&tree[path], bytes, "{path}");
    }
    assert_eq!(committed_tree.len(), 23);
    assert_eq!(committed["passwords"].as_array().unwrap().len(), 6);
    assert_eq!(committed["localStates"].as_array().unwrap().len(), 2);
}

fn tree_of_vault() -> BTreeMap<String, Vec<u8>> {
    support::tree(&vectors().join("vault"))
}

#[test]
fn the_wordlist_matches_every_platform_copy() {
    let committed = json(&vectors().join("expected.json"));
    assert_eq!(wordlist_digest(), committed["wordlistSha256"].as_str().unwrap());
    let mut sorted = wordlist::ENGLISH.to_vec();
    sorted.sort_unstable();
    assert_eq!(sorted, wordlist::ENGLISH.to_vec());
    let prefixes: BTreeSet<&str> = wordlist::ENGLISH
        .iter()
        .map(|word| &word[..word.len().min(4)])
        .collect();
    assert_eq!(prefixes.len(), 2048);
    for copy in [
        "packages/sync/ios/Core/Wordlist.swift",
        "packages/phone/android/src/main/java/com/ardia/sync/core/Wordlist.kt",
        "apps/browser/windows/Ardia/SyncWordlist.h",
    ] {
        let source = fs::read_to_string(repo().join(copy)).unwrap();
        let list = &source[source.find("abandon").unwrap()..source.rfind("zoo").unwrap() + 3];
        let words: Vec<&str> = list
            .split(|letter: char| !letter.is_ascii_lowercase())
            .filter(|word| !word.is_empty())
            .collect();
        assert_eq!(words, wordlist::ENGLISH.to_vec(), "{copy}");
    }
}

#[test]
fn phrases_and_tags_match() {
    let inputs = Inputs::load();
    let committed = json(&vectors().join("expected.json"));
    for (name, chain) in committed["chains"].as_object().unwrap() {
        let entropy = inputs.entropy(name);
        let fixed: [u8; 32] = entropy.clone().try_into().unwrap();
        assert_eq!(phrase::phrase(&fixed).as_str(), str(chain, "phrase"));
        assert_eq!(phrase::entropy(str(chain, "phrase")).unwrap().to_vec(), entropy);
        let keys = SyncKeys::new(&entropy);
        assert_eq!(keys.chain_tag(), str(chain, "chainTag"));
        for (scope, tag) in chain["scopeTags"].as_object().unwrap() {
            assert_eq!(keys.scope_tag(scope), tag.as_str().unwrap());
        }
    }
}

#[test]
fn committed_seals_open_to_their_plaintext() {
    let inputs = Inputs::load();
    let committed = json(&vectors().join("expected.json"));
    let mut opened = 0;
    for file in committed["vault"]["files"].as_array().unwrap() {
        let keys = inputs.keys(str(file, "entropy"));
        let sealed = fs::read(vectors().join(str(file, "path"))).unwrap();
        let payload = keys
            .open(&sealed, &keys.scope_tag(str(file, "scope")), str(file, "id"))
            .unwrap();
        assert_eq!(
            payload.to_vec(),
            inputs.payload(str(file, "payload")),
            "{}",
            str(file, "path")
        );
        opened += 1;
    }
    assert_eq!(opened, 20);
    for state in committed["localStates"].as_array().unwrap() {
        let keys = inputs.keys(str(state, "entropy"));
        let sealed = base64_decode(str(state, "sealed"));
        assert_eq!(
            keys.open_local(&sealed, str(state, "fileId")).unwrap().to_vec(),
            inputs.payload(str(state, "payload"))
        );
    }
    for login in committed["passwords"].as_array().unwrap() {
        let keys = inputs.keys(str(login, "entropy"));
        let password = keys
            .open_password(str(login, "sealed"), str(login, "origin"), str(login, "username"))
            .unwrap();
        assert_eq!(password.as_str(), str(login, "password"));
    }
}

#[test]
fn the_vault_reads_the_exact_inventory() {
    let inputs = Inputs::load();
    let committed = json(&vectors().join("expected.json"));
    let entries = |kind: &str, entropy: &str, scope: &str| -> Vec<Value> {
        committed["vault"][kind]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| str(entry, "entropy") == entropy && str(entry, "scope") == scope)
            .cloned()
            .collect()
    };
    let ids = |entries: &[Value]| -> Vec<String> {
        let mut ids: Vec<String> = entries.iter().map(|entry| str(entry, "id").to_owned()).collect();
        ids.sort();
        ids
    };
    for entropy in inputs.entropy_names() {
        let keys = inputs.keys(&entropy);
        assert!(vectors().join("vault").join(keys.chain_tag()).is_dir());
        for scope in inputs.scopes() {
            let read = read_scope(&vectors().join("vault"), &keys, &scope);
            let files = entries("files", &entropy, &scope);
            let mut read_ids: Vec<String> = read.files.iter().map(|(id, _)| id.clone()).collect();
            read_ids.sort();
            assert_eq!(read_ids, ids(&files));
            for (id, payload) in &read.files {
                let file = files.iter().find(|file| str(file, "id") == id).unwrap();
                assert_eq!(payload, &inputs.payload(str(file, "payload")));
            }
            let mut damaged = read.damaged.clone();
            damaged.sort();
            assert_eq!(damaged, ids(&entries("damaged", &entropy, &scope)));
            let mut pending = read.pending.clone();
            pending.sort();
            assert_eq!(pending, ids(&entries("pending", &entropy, &scope)));
            let mut present = read.present.clone();
            present.sort();
            let mut all = [
                files,
                entries("damaged", &entropy, &scope),
                entries("pending", &entropy, &scope),
            ]
            .concat();
            all.sort_by(|a, b| str(a, "id").cmp(str(b, "id")));
            assert_eq!(present, ids(&all));
        }
    }
}

#[test]
fn damaged_tampered_and_wrong_context_seals_are_rejected() {
    let inputs = Inputs::load();
    let committed = json(&vectors().join("expected.json"));
    for file in committed["vault"]["damaged"].as_array().unwrap() {
        let keys = inputs.keys(str(file, "entropy"));
        let sealed = fs::read(vectors().join(str(file, "path"))).unwrap();
        assert_eq!(
            keys.open(&sealed, &keys.scope_tag(str(file, "scope")), str(file, "id")),
            Err(Error::Authentication)
        );
    }
    for file in committed["vault"]["pending"].as_array().unwrap() {
        assert!(fs::read(vectors().join(str(file, "path"))).unwrap().is_empty());
    }
    let names = inputs.entropy_names();
    let scopes = inputs.scopes();
    for file in committed["vault"]["files"].as_array().unwrap() {
        let entropy = str(file, "entropy");
        let keys = inputs.keys(entropy);
        let other = inputs.keys(names.iter().find(|name| *name != entropy).unwrap());
        let scope = str(file, "scope");
        let other_scope = scopes.iter().find(|candidate| *candidate != scope).unwrap();
        let id = str(file, "id");
        let sealed = fs::read(vectors().join(str(file, "path"))).unwrap();
        assert_eq!(
            keys.open(&sealed, &keys.scope_tag(other_scope), id),
            Err(Error::Authentication)
        );
        assert_eq!(
            keys.open(&sealed, &keys.scope_tag(scope), "state"),
            Err(Error::Authentication)
        );
        assert_eq!(
            other.open(&sealed, &other.scope_tag(scope), id),
            Err(Error::Authentication)
        );
        for index in [4, 15, 16, 40, sealed.len() - 1] {
            let mut tampered = sealed.clone();
            tampered[index] ^= 0x80;
            assert_eq!(
                keys.open(&tampered, &keys.scope_tag(scope), id),
                Err(Error::Authentication),
                "byte {index}"
            );
        }
        for index in 0..4 {
            let mut tampered = sealed.clone();
            tampered[index] ^= 0x80;
            assert_eq!(keys.open(&tampered, &keys.scope_tag(scope), id), Err(Error::Format));
        }
        assert_eq!(keys.open(&sealed[..35], &keys.scope_tag(scope), id), Err(Error::Format));
    }
    for state in committed["localStates"].as_array().unwrap() {
        let keys = inputs.keys(str(state, "entropy"));
        let sealed = base64_decode(str(state, "sealed"));
        assert_eq!(keys.open_local(&sealed, "other"), Err(Error::Authentication));
        assert_eq!(
            keys.open(&sealed, &keys.scope_tag("app"), str(state, "fileId")),
            Err(Error::Authentication)
        );
    }
    for login in committed["passwords"].as_array().unwrap() {
        let keys = inputs.keys(str(login, "entropy"));
        let (sealed, origin, username) = (str(login, "sealed"), str(login, "origin"), str(login, "username"));
        assert_eq!(
            keys.open_password(sealed, &format!("{origin}x"), username),
            Err(Error::Authentication)
        );
        assert_eq!(
            keys.open_password(sealed, origin, &format!("{username}x")),
            Err(Error::Authentication)
        );
        let mut tampered = base64_decode(sealed);
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert_eq!(
            keys.open_password(&base64_encode(&tampered), origin, username),
            Err(Error::Authentication)
        );
        let mut versioned = base64_decode(sealed);
        versioned[0] = 2;
        assert_eq!(
            keys.open_password(&base64_encode(&versioned), origin, username),
            Err(Error::Format)
        );
        assert_eq!(
            keys.open_password(&format!("{sealed}\n"), origin, username),
            Err(Error::Format)
        );
        assert_eq!(
            keys.open_password(sealed.trim_end_matches('='), origin, username)
                .is_ok(),
            !sealed.ends_with('=')
        );
    }
}

#[test]
fn random_nonces_keep_the_format_and_open() {
    let inputs = Inputs::load();
    let keys = inputs.keys("ordinary");
    let scope_tag = keys.scope_tag("app");
    for name in VAULT_PAYLOADS {
        let plain = inputs.payload(name);
        let sealed = keys.seal(&plain, &scope_tag, "f").unwrap();
        let padded = (4 + plain.len()).div_ceil(1024) * 1024;
        assert_eq!(sealed.len(), 4 + 12 + padded + 16, "{name}");
        assert_eq!(&sealed[..4], b"NNS1");
        assert_eq!(keys.open(&sealed, &scope_tag, "f").unwrap().to_vec(), plain);
        assert_ne!(keys.seal(&plain, &scope_tag, "f").unwrap(), sealed);
    }
    let id = ardia_sync_core::new_file_id().unwrap();
    assert!(ardia_sync_core::is_tag(&id));
    assert_ne!(ardia_sync_core::new_file_id().unwrap(), id);
}

#[test]
fn swift_and_kotlin_random_sets_open() {
    let inputs = Inputs::load();
    let mut checked = 0;
    for writer in ["swift", "kotlin"] {
        let folder = vectors().join(writer);
        let set = json(&folder.join("manifest.json"));
        assert_eq!(str(&set, "writer"), writer);
        let entropy = hex(str(&set, "entropy"));
        assert_eq!(entropy.len(), 32);
        assert_eq!(
            phrase::phrase(&entropy.clone().try_into().unwrap()).as_str(),
            str(&set, "phrase")
        );
        assert_eq!(phrase::entropy(str(&set, "phrase")).unwrap().to_vec(), entropy);
        let keys = SyncKeys::new(&entropy);
        assert_eq!(keys.chain_tag(), str(&set, "chainTag"));
        let tags = set["scopeTags"].as_object().unwrap();
        assert_eq!(
            tags.keys().cloned().collect::<BTreeSet<_>>(),
            inputs.scopes().into_iter().collect::<BTreeSet<_>>()
        );
        for (scope, tag) in tags {
            assert_eq!(keys.scope_tag(scope), tag.as_str().unwrap());
        }
        let files = set["files"].as_array().unwrap();
        for scope in inputs.scopes() {
            let mine: Vec<&Value> = files.iter().filter(|file| str(file, "scope") == scope).collect();
            let mut payloads: Vec<&str> = mine.iter().map(|file| str(file, "payload")).collect();
            payloads.sort_unstable();
            let mut expected = VAULT_PAYLOADS.to_vec();
            expected.sort_unstable();
            assert_eq!(payloads, expected);
            let read = read_scope(&folder.join("vault"), &keys, &scope);
            assert!(read.damaged.is_empty() && read.pending.is_empty());
            assert_eq!(read.files.len(), mine.len());
            for file in mine {
                let id = str(file, "id");
                assert_eq!(str(file, "path"), path(&keys, &scope, &vault::file_name(id)));
                let sealed = fs::read(folder.join(str(file, "path"))).unwrap();
                assert_eq!(&sealed[..4], b"NNS1");
                let payload = keys.open(&sealed, &keys.scope_tag(&scope), id).unwrap();
                assert_eq!(payload.to_vec(), inputs.payload(str(file, "payload")));
                assert_eq!(
                    keys.open(&sealed, &keys.scope_tag(&scope), "state"),
                    Err(Error::Authentication)
                );
                checked += 1;
            }
        }
        let on_disk: BTreeSet<String> = support::tree(&folder.join("vault")).into_keys().collect();
        let listed: BTreeSet<String> = files
            .iter()
            .map(|file| str(file, "path").trim_start_matches("vault/").to_owned())
            .collect();
        assert_eq!(on_disk, listed);
        let login = &set["password"];
        let (origin, username, password) = (str(login, "origin"), str(login, "username"), str(login, "password"));
        assert_eq!(
            keys.open_password(str(&set, "sealedPassword"), origin, username)
                .unwrap()
                .as_str(),
            password
        );
        assert_eq!(
            keys.seal_password(password, origin, username).unwrap(),
            str(&set, "sealedPassword")
        );
        let local = &set["localState"];
        let sealed = base64_decode(str(local, "sealed"));
        assert_eq!(
            keys.open_local(&sealed, str(local, "fileId")).unwrap().to_vec(),
            inputs.payload(str(local, "payload"))
        );
        assert_eq!(keys.open_local(&sealed, "other"), Err(Error::Authentication));
    }
    assert_eq!(checked, 20);
}

#[test]
fn mac_and_windows_interop_vaults_open() {
    let root = fixtures().join("windows-interop");
    for writer in ["mac", "windows"] {
        let manifest = json(&root.join(format!("{writer}.json")));
        let entropy = hex(str(&manifest, "entropy"));
        assert_eq!(entropy, (1..=32).collect::<Vec<u8>>());
        let words: Vec<&str> = manifest["words"]
            .as_array()
            .unwrap()
            .iter()
            .map(|word| word.as_str().unwrap())
            .collect();
        assert_eq!(phrase::words(&entropy.clone().try_into().unwrap()).to_vec(), words);
        assert_eq!(phrase::entropy(&words.join(" ")).unwrap().to_vec(), entropy);
        let keys = SyncKeys::new(&entropy);
        assert_eq!(keys.chain_tag(), str(&manifest, "chainTag"));
        for (scope, tag) in manifest["scopeTags"].as_object().unwrap() {
            assert_eq!(keys.scope_tag(scope), tag.as_str().unwrap());
        }
        let files = manifest["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        for file in files {
            let read = read_scope(&root.join(writer), &keys, str(file, "scope"));
            assert!(read.damaged.is_empty(), "{writer}");
            let (_, payload) = read.files.iter().find(|(id, _)| id == str(file, "id")).unwrap();
            let read_json: Value = serde_json::from_slice(payload).unwrap();
            let expected_json: Value = serde_json::from_str(str(file, "payload")).unwrap();
            assert_eq!(read_json, expected_json, "{writer}");
        }
        let local = &manifest["local"];
        let sealed = base64_decode(str(local, "sealed"));
        assert_eq!(
            String::from_utf8(keys.open_local(&sealed, "state").unwrap().to_vec()).unwrap(),
            str(local, "plain")
        );
        let login = &manifest["password"];
        let (origin, username, password) = (str(login, "origin"), str(login, "username"), str(login, "password"));
        assert_eq!(
            keys.open_password(str(login, "sealed"), origin, username)
                .unwrap()
                .as_str(),
            password
        );
        assert_eq!(
            keys.seal_password(password, origin, username).unwrap(),
            str(login, "sealed")
        );
    }
}

#[test]
fn a_vault_file_from_0_2_32_still_opens() {
    let keys = SyncKeys::new(&[0u8; 32]);
    assert_eq!(keys.chain_tag(), "gbcx4r55mk3rlaegbggknyx4ta");
    assert_eq!(keys.scope_tag("app"), "nr4ncp5iyqzqgjn6ol4zksqtne");
    let sealed = base64_decode(fs::read_to_string(fixtures().join("sealed-0.2.32.b64")).unwrap().trim());
    assert_eq!(
        keys.open(&sealed, &keys.scope_tag("app"), "f1").unwrap().as_slice(),
        b"from 0.2.32"
    );
}

#[test]
fn password_nonces_come_from_the_padded_plaintext() {
    let inputs = Inputs::load();
    let keys = inputs.keys("ordinary");
    let committed = json(&vectors().join("expected.json"));
    for login in committed["passwords"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|login| str(login, "entropy") == "ordinary")
    {
        let data = base64_decode(str(login, "sealed"));
        let password = str(login, "password");
        assert_eq!(data.len(), 1 + 12 + (4 + password.len()).div_ceil(32) * 32 + 16);
        assert_eq!(
            keys.seal_password(password, str(login, "origin"), str(login, "username"))
                .unwrap(),
            str(login, "sealed")
        );
        assert_ne!(
            keys.seal_password(password, str(login, "origin"), &format!("{}x", str(login, "username")))
                .unwrap()[..18],
            str(login, "sealed")[..18]
        );
    }
}
