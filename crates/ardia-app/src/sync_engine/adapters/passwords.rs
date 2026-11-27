use std::collections::{HashMap, HashSet};
use std::time::Duration;

use ardia_state::ProfileId;
use ardia_state::sync_engine::scope::{Adapter, ApplyRecords, ExtractContext, Extraction};
use ardia_state::sync_engine::{IndexMap, IndexSet};
use serde_json::{Value, json};
use zeroize::{Zeroize, Zeroizing};

use super::{CycleContext, data_engine};

pub const PASSWORD: &str = "pws:";
pub const LEGACY_PASSWORD: &str = "pw:";
pub const READ_INTERVAL_MS: i64 = 30_000;
pub const QUIET_MS: i64 = 30_000;
const SETTLE_TRIES: usize = 20;
const SETTLE_PAUSE: Duration = Duration::from_millis(250);

pub fn key_of(origin: &str, username: &str) -> String {
    format!("{PASSWORD}{origin}\n{username}")
}

#[derive(Clone, Debug, PartialEq)]
pub struct SealedLogin {
    pub origin: String,
    pub username: String,
    pub sealed: Option<String>,
    pub created: i64,
}

pub fn login_origin(realm: &str) -> Option<String> {
    let origin = realm.strip_suffix('/').unwrap_or(realm);
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))?;
    (!rest.is_empty() && !rest.chars().any(|c| c == '/' || c.is_whitespace()))
        .then(|| origin.to_owned())
}

fn wipe(value: &mut Value) {
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(items) => items.iter_mut().for_each(wipe),
        Value::Object(map) => map.values_mut().for_each(wipe),
        _ => {}
    }
}

pub fn sealed_logins(
    reply: &str,
    seal: &dyn Fn(&str, &str, &str) -> Option<String>,
) -> Option<Vec<SealedLogin>> {
    let mut parsed: Value = serde_json::from_str(reply).ok()?;
    let result = (|| {
        let logins = parsed.get("logins")?.as_array()?;
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for login in logins {
            let realm = login.get("realm")?.as_str()?;
            let username = login.get("username")?.as_str()?;
            let password = login.get("password")?.as_str()?;
            let created = login.get("created")?.as_f64()?;
            if !seen.insert(format!("{realm}\0{username}")) {
                continue;
            }
            let Some(origin) = login_origin(realm) else {
                continue;
            };
            let sealed = seal(password, &origin, username);
            out.push(SealedLogin {
                origin,
                username: username.to_owned(),
                sealed,
                created: created as i64,
            });
        }
        Some(out)
    })();
    wipe(&mut parsed);
    result
}

#[derive(Default)]
struct Memory {
    last_read: i64,
    quiet_until: i64,
    created: HashMap<String, i64>,
    passwordless: HashSet<String>,
}

#[derive(Clone)]
struct Local {
    origin: String,
    username: String,
    sealed: String,
    created: i64,
}

pub struct PasswordsAdapter {
    cx: CycleContext,
    profile: ProfileId,
    forced: bool,
    slot: String,
}

pub fn adapter(cx: &CycleContext, profile: &ProfileId, forced: bool) -> Box<dyn Adapter> {
    Box::new(PasswordsAdapter {
        cx: cx.clone(),
        profile: profile.clone(),
        forced,
        slot: format!("passwords:{profile}"),
    })
}

fn password_value(value: Option<&Value>) -> Option<(String, String, String)> {
    let v = value?.as_object()?;
    Some((
        v.get("o")?.as_str()?.to_owned(),
        v.get("u")?.as_str()?.to_owned(),
        v.get("s")?.as_str()?.to_owned(),
    ))
}

impl PasswordsAdapter {
    fn with_memory<T>(&self, f: impl FnOnce(&mut Memory) -> T) -> T {
        let mut memory = self.cx.memory.lock();
        f(memory.slot::<Memory>(&self.slot))
    }

    fn read(&self) -> Option<IndexMap<String, Local>> {
        let keys = self.cx.keys.clone()?;
        let reply =
            data_engine::call_secret(&self.cx, &self.profile, "ac_passwords_logins", json!({}))?;
        let seal = |password: &str, origin: &str, username: &str| {
            keys.seal_password(password, origin, username).ok()
        };
        let list = sealed_logins(&reply, &seal)?;
        let passwordless: HashSet<String> = list
            .iter()
            .filter(|l| l.sealed.is_none())
            .map(|l| key_of(&l.origin, &l.username))
            .collect();
        self.with_memory(|m| m.passwordless = passwordless);
        Some(
            list.into_iter()
                .filter_map(|l| {
                    let sealed = l.sealed?;
                    Some((
                        key_of(&l.origin, &l.username),
                        Local {
                            origin: l.origin,
                            username: l.username,
                            sealed,
                            created: l.created,
                        },
                    ))
                })
                .collect(),
        )
    }

    fn save(&self, origin: &str, username: &str, sealed: &str, replacing: bool) -> bool {
        let Some(keys) = self.cx.keys.clone() else {
            return false;
        };
        let Ok(password) = keys.open_password(sealed, origin, username) else {
            log::warn!("[sync] a synced password didn't open for its login; not saving it");
            return false;
        };
        if replacing
            && data_engine::call(
                &self.cx,
                &self.profile,
                "ac_passwords_remove",
                json!({ "origin": origin, "username": username }),
            )
            .is_none()
        {
            log::warn!("[sync] replacing a saved password failed");
            return false;
        }
        let args = json!({ "origin": origin, "username": username, "password": password.as_str() });
        let saved: Option<Zeroizing<String>> =
            data_engine::call_secret(&self.cx, &self.profile, "ac_passwords_add", args);
        saved.is_some()
    }
}

impl Adapter for PasswordsAdapter {
    fn prefix(&self) -> &str {
        PASSWORD
    }

    fn extract(&mut self, _cx: &ExtractContext) -> Option<Extraction> {
        let now = ardia_state::store::now_ms();
        let (quiet_until, last_read) = self.with_memory(|m| (m.quiet_until, m.last_read));
        if now < quiet_until || (now - last_read < READ_INTERVAL_MS && !self.forced) {
            return None;
        }
        let local = self.read()?;
        let blank = self.with_memory(|m| {
            m.last_read = now;
            m.created = local.iter().map(|(k, l)| (k.clone(), l.created)).collect();
            m.passwordless.clone()
        });
        let values: IndexMap<String, Value> = local
            .into_iter()
            .map(|(k, l)| (k, json!({ "o": l.origin, "u": l.username, "s": l.sealed })))
            .collect();
        Some(Extraction::of(values).ignoring(move |key| blank.contains(key)))
    }

    fn edited_at(&self, value: &Value) -> Option<i64> {
        let (o, u, _) = password_value(Some(value))?;
        self.with_memory(|m| m.created.get(&key_of(&o, &u)).copied())
            .filter(|c| *c != 0)
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        records: &ApplyRecords,
    ) -> bool {
        let Some(local) = self.read() else {
            return false;
        };
        let passwordless = self.with_memory(|m| m.passwordless.clone());
        let mut ok = true;
        for key in changed {
            if records.held() {
                return false;
            }
            if passwordless.contains(key) {
                records.defer(key);
                continue;
            }
            let value = password_value(visible.get(key));
            if visible.contains_key(key) && value.is_none() {
                return false;
            }
            let have = local.get(key);
            let known = password_value(records.base(key).as_ref()).map(|(_, _, s)| s);
            if let Some(have) = have
                && known.as_deref() != Some(have.sealed.as_str())
            {
                continue;
            }
            match (value, have) {
                (Some((o, u, s)), have) => {
                    if have.is_some_and(|h| h.sealed == s) {
                        continue;
                    }
                    let saved = self.save(&o, &u, &s, have.is_some());
                    if saved {
                        records.landed(key);
                    }
                    ok = saved && ok;
                }
                (None, Some(have)) => {
                    let deleted = data_engine::call(
                        &self.cx,
                        &self.profile,
                        "ac_passwords_remove",
                        json!({ "origin": have.origin, "username": have.username }),
                    )
                    .is_some();
                    if deleted {
                        records.landed(key);
                    }
                    ok = deleted && ok;
                }
                (None, None) => {}
            }
        }
        let landed = |now: &IndexMap<String, Local>, key: &str| match visible.get(key) {
            None => !now.contains_key(key),
            Some(value) => password_value(Some(value))
                .is_none_or(|(_, _, s)| now.get(key).is_some_and(|l| l.sealed == s)),
        };
        let mut settled = false;
        for attempt in 0..SETTLE_TRIES {
            if records.held() {
                return false;
            }
            let passwordless = self.with_memory(|m| m.passwordless.clone());
            settled = self.read().is_some_and(|now| {
                changed
                    .iter()
                    .all(|k| passwordless.contains(k) || landed(&now, k))
            });
            if settled {
                break;
            }
            if attempt + 1 < SETTLE_TRIES {
                std::thread::sleep(SETTLE_PAUSE);
            }
        }
        if !settled {
            self.with_memory(|m| m.quiet_until = ardia_state::store::now_ms() + QUIET_MS);
        }
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::adapters::data_engine::fake;
    use crate::sync_engine::adapters::tests_support::{MemoryTransport, run_cycle};
    use ardia_state::BrowserState;
    use ardia_state::sync_engine::scope::ScopeState;
    use parking_lot::Mutex;
    use std::sync::Arc;

    type Logins = Arc<Mutex<Vec<(String, String, String)>>>;

    fn serve(engine: &fake::FakeEngine, logins: Logins) {
        engine.answer(move |name, args| match name {
            "ac_passwords_logins" => {
                let list: Vec<Value> = logins.lock().iter().map(|(o, u, p)| json!({ "realm": format!("{o}/"), "username": u, "password": p, "created": 1000.0 })).collect();
                Some(json!({ "logins": list }))
            }
            "ac_passwords_add" => {
                let entry = (args["origin"].as_str()?.to_owned(), args["username"].as_str()?.to_owned(), args["password"].as_str()?.to_owned());
                logins.lock().retain(|(o, u, _)| (o, u) != (&entry.0, &entry.1));
                logins.lock().push(entry);
                Some(json!({ "ok": true }))
            }
            "ac_passwords_remove" => {
                let (o, u) = (args["origin"].as_str()?.to_owned(), args["username"].as_str()?.to_owned());
                logins.lock().retain(|(lo, lu, _)| (lo, lu) != (&o, &u));
                Some(json!({ "ok": true }))
            }
            _ => None,
        });
    }

    #[test]
    fn origins_and_malformed_replies_match_sealed_logins() {
        assert_eq!(login_origin("https://a.com/"), Some("https://a.com".into()));
        assert_eq!(login_origin("https://a.com/path"), None);
        assert_eq!(login_origin("android://x"), None);
        let seal = |p: &str, _: &str, _: &str| Some(format!("sealed-{p}"));
        assert!(
            sealed_logins(
                r#"{"logins":[{"realm":"https://a.com/","username":"u"}]}"#,
                &seal
            )
            .is_none()
        );
        assert!(sealed_logins(r#"{"error":"busy"}"#, &seal).is_none());
        let list = sealed_logins(r#"{"logins":[{"realm":"https://a.com/","username":"u","password":"p","created":5},{"realm":"https://a.com/","username":"u","password":"q","created":6}]}"#, &seal).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].sealed.as_deref(), Some("sealed-p"));
    }

    #[test]
    fn passwords_go_both_ways_sealed_and_old_records_stay_untouched() {
        let transport = MemoryTransport::default();
        let (a, ea) = fake::context(BrowserState::default(), "AAAA");
        let (b, eb) = fake::context(BrowserState::default(), "BBBB");
        let la: Logins = Arc::new(Mutex::new(vec![(
            "https://a.com".into(),
            "ann".into(),
            "secret-a".into(),
        )]));
        let lb: Logins = Arc::new(Mutex::new(vec![(
            "https://b.com".into(),
            "bob".into(),
            "secret-b".into(),
        )]));
        serve(&ea, la.clone());
        serve(&eb, lb.clone());
        transport.inject(
            "p:x",
            "OLD1",
            vec![(
                "pw:https://c.com\ncat",
                json!({ "o": "https://c.com", "u": "cat", "p": "plain" }),
            )],
        );
        let profile = ProfileId::default_profile();
        let mut sa = ScopeState {
            joined: true,
            ..ScopeState::default()
        };
        let mut sb = ScopeState {
            joined: true,
            ..ScopeState::default()
        };
        run_cycle(
            &transport,
            "p:x",
            &mut sa,
            "AAAA",
            vec![adapter(&a, &profile, true)],
        );
        run_cycle(
            &transport,
            "p:x",
            &mut sb,
            "BBBB",
            vec![adapter(&b, &profile, true)],
        );
        run_cycle(
            &transport,
            "p:x",
            &mut sa,
            "AAAA",
            vec![adapter(&a, &profile, true)],
        );
        assert!(
            la.lock()
                .iter()
                .any(|(o, u, p)| o == "https://b.com" && u == "bob" && p == "secret-b")
        );
        assert!(
            lb.lock()
                .iter()
                .any(|(o, u, p)| o == "https://a.com" && u == "ann" && p == "secret-a")
        );
        let record = &sa.records["pws:https://a.com\nann"].v;
        assert!(record["s"].as_str().is_some() && record.get("p").is_none());
        assert!(
            !transport
                .all_ops()
                .iter()
                .any(|(_, v)| v.to_string().contains("secret-"))
        );
        lb.lock().retain(|(o, _, _)| o != "https://a.com");
        run_cycle(
            &transport,
            "p:x",
            &mut sb,
            "BBBB",
            vec![adapter(&b, &profile, true)],
        );
        run_cycle(
            &transport,
            "p:x",
            &mut sa,
            "AAAA",
            vec![adapter(&a, &profile, true)],
        );
        assert!(!la.lock().iter().any(|(o, _, _)| o == "https://a.com"));
        assert_eq!(sa.records["pw:https://c.com\ncat"].v["p"], json!("plain"));
        assert!(
            transport
                .all_ops()
                .iter()
                .all(|(k, v)| !k.starts_with("pw:") || !v.is_null())
        );
    }

    #[test]
    fn a_failed_read_publishes_and_deletes_nothing() {
        let (a, ea) = fake::context(BrowserState::default(), "AAAA");
        ea.answer(|name, _| {
            (name == "ac_passwords_logins").then(|| json!({ "error": "undecryptable" }))
        });
        let mut state = ScopeState::default();
        state.put_base("pws:https://a.com\nann", "{}".into());
        let mut adapter = adapter(&a, &ProfileId::default_profile(), true);
        assert!(adapter.extract(&ExtractContext::new(&state, 0)).is_none());
    }
}
