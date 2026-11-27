use std::collections::HashMap;

use ardia_engine::services::Services;
use ardia_state::ProfileId;
use parking_lot::Mutex;
use serde_json::Value;

use super::site_settings;
use crate::coordinator::AppCoordinator;

pub const POPUPS: &str = "popups";
pub const NOTIFICATIONS: &str = "notifications";
pub const TRACKED: [&str; 2] = [POPUPS, NOTIFICATIONS];

type Key = (String, String, String);

#[derive(Default)]
struct Book {
    answers: HashMap<Key, bool>,
}

static BOOK: Mutex<Option<Book>> = Mutex::new(None);

fn with_book<T>(run: impl FnOnce(&mut Book) -> T) -> T {
    let mut guard = BOOK.lock();
    run(guard.get_or_insert_with(Book::default))
}

pub fn rule_answer(rules: &Value, kind: &str) -> Option<bool> {
    match rules.get(kind)?.get("value")?.as_str()? {
        "allow" => Some(true),
        "block" => Some(false),
        _ => None,
    }
}

pub fn note_rules(profile: &str, origin: &str, rules: &Value) {
    let rules = rules.get("settings").unwrap_or(rules);
    if site_settings::is_private(profile) || !rules.is_object() {
        return;
    }
    with_book(|book| {
        for kind in TRACKED {
            let key = (profile.to_owned(), origin.to_owned(), kind.to_owned());
            match rule_answer(rules, kind) {
                Some(answer) => {
                    book.answers.insert(key, answer);
                }
                None => {
                    book.answers.remove(&key);
                }
            }
        }
    });
}

pub fn note(profile: &str, origin: &str, kind: &str, answer: Option<bool>) {
    if site_settings::is_private(profile) {
        let value = match answer {
            Some(true) => "allow",
            Some(false) => "block",
            None => "default",
        };
        site_settings::set_private_choice(profile, origin, kind, value);
        return;
    }
    with_book(|book| {
        let key = (profile.to_owned(), origin.to_owned(), kind.to_owned());
        match answer {
            Some(answer) => {
                book.answers.insert(key, answer);
            }
            None => {
                book.answers.remove(&key);
            }
        }
    });
}

pub fn answer(profile: &str, origin: &str, kind: &str) -> Option<bool> {
    if site_settings::is_private(profile) {
        let rules = Value::Object(site_settings::private_rules(profile, origin, &[kind]));
        let chosen = rules
            .get(kind)
            .and_then(|rule| rule.get("isDefault"))
            .and_then(Value::as_bool)
            == Some(false);
        return chosen.then(|| rule_answer(&rules, kind)).flatten();
    }
    with_book(|book| {
        book.answers
            .get(&(profile.to_owned(), origin.to_owned(), kind.to_owned()))
            .copied()
    })
}

pub fn answers_for(profile: &str, kind: &str) -> Vec<(String, bool)> {
    with_book(|book| {
        book.answers
            .iter()
            .filter(|((owner, _, k), _)| owner == profile && k == kind)
            .map(|((_, origin, _), allowed)| (origin.clone(), *allowed))
            .collect()
    })
}

pub fn all_origins(kind: &str) -> std::collections::HashSet<String> {
    with_book(|book| {
        book.answers
            .keys()
            .filter(|(_, _, k)| k == kind)
            .map(|(_, origin, _)| origin.clone())
            .collect()
    })
}

pub fn forget_profile(profile: &str) {
    with_book(|book| book.answers.retain(|(owner, _, _), _| owner != profile));
}

impl AppCoordinator {
    pub(crate) fn webkit_engine_profile_dir(&self, engine_profile: &str) -> Option<String> {
        let state = self.store().snapshot();
        let profile: ProfileId = state
            .profiles
            .keys()
            .find(|id| state.engine_profile(id) == engine_profile)
            .cloned()
            .or_else(|| {
                engine_profile
                    .is_empty()
                    .then(|| ProfileId::from(ardia_state::ids::DEFAULT_PROFILE_ID))
            })?;
        self.service_profile_dir(&profile)
    }

    pub(crate) fn load_webkit_answers(
        &self,
        profile: &str,
        origin: &str,
        then: impl FnOnce(&AppCoordinator) + 'static,
    ) {
        if site_settings::is_private(profile) {
            then(self);
            return;
        }
        let (Some(engine), Some(dir)) = (self.engine(), self.webkit_engine_profile_dir(profile))
        else {
            log::debug!("WebKit site answers for {origin} have no Chromium profile to read");
            then(self);
            return;
        };
        let reply = Services::new(engine.as_ref(), &dir)
            .sites()
            .settings(origin);
        let me = self.weak();
        let profile = profile.to_owned();
        let origin = origin.to_owned();
        self.spawn(async move {
            match reply.await {
                Ok(rules) => note_rules(&profile, &origin, &rules),
                Err(problem) => log::debug!("WebKit site answers didn't load: {problem}"),
            }
            if let Some(me) = me.upgrade() {
                then(&me);
            }
        });
    }

    pub(crate) fn prime_webkit_answers(&self, profile: &str) {
        if site_settings::is_private(profile) {
            return;
        }
        let (Some(engine), Some(dir)) = (self.engine(), self.webkit_engine_profile_dir(profile))
        else {
            return;
        };
        let reply = Services::new(engine.as_ref(), &dir).sites().origins();
        let me = self.weak();
        let profile = profile.to_owned();
        self.spawn(async move {
            let Ok(value) = reply.await else {
                return;
            };
            let Some(me) = me.upgrade() else {
                return;
            };
            let mut seen = std::collections::HashSet::new();
            for origin in site_settings::origins_from(&value)
                .into_iter()
                .filter_map(|origin| site_settings::origin_of(&origin))
            {
                if seen.insert(origin.clone()) {
                    let profile_name = profile.clone();
                    let announced = origin.clone();
                    me.load_webkit_answers(&profile, &origin, move |c| {
                        c.webkit_answers_changed(&profile_name, &announced)
                    });
                }
            }
        });
    }

    pub(crate) fn set_webkit_answer(
        &self,
        profile: &str,
        origin: &str,
        kind: &str,
        answer: Option<bool>,
    ) {
        note(profile, origin, kind, answer);
        self.webkit_answers_changed(profile, origin);
        if site_settings::is_private(profile) {
            return;
        }
        let (Some(engine), Some(dir)) = (self.engine(), self.webkit_engine_profile_dir(profile))
        else {
            return;
        };
        let value = match answer {
            Some(true) => "allow",
            Some(false) => "block",
            None => "default",
        };
        let reply = Services::new(engine.as_ref(), &dir)
            .sites()
            .set_setting(origin, kind, value);
        self.spawn(async move {
            if let Err(problem) = reply.await {
                log::warn!("the WebKit site choice wasn't saved: {problem}");
            }
        });
    }

    pub(crate) fn note_webkit_answers(&self, tab: &ardia_state::TabId, rules: &Value) {
        let Some(profile) = super::page::profile_of(tab) else {
            return;
        };
        let Some(origin) =
            super::services::page_url(tab).and_then(|url| site_settings::origin_of(&url))
        else {
            return;
        };
        note_rules(&profile, &origin, rules);
        self.webkit_answers_changed(&profile, &origin);
    }

    pub(crate) fn webkit_answers_changed(&self, profile: &str, origin: &str) {
        super::notification_workers::announce_policy(profile, origin);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chromium_rules_become_answers() {
        let rules = json!({
            "popups": { "value": "allow", "isDefault": false },
            "notifications": { "value": "ask", "isDefault": true },
        });
        assert_eq!(rule_answer(&rules, POPUPS), Some(true));
        assert_eq!(rule_answer(&rules, NOTIFICATIONS), None);
        note_rules("w10-test-a", "https://a.com", &rules);
        assert_eq!(answer("w10-test-a", "https://a.com", POPUPS), Some(true));
        assert_eq!(answer("w10-test-a", "https://a.com", NOTIFICATIONS), None);
        note_rules(
            "w10-test-a",
            "https://wrapped.com",
            &json!({ "settings": { "notifications": { "value": "block", "isDefault": false } } }),
        );
        assert_eq!(
            answer("w10-test-a", "https://wrapped.com", NOTIFICATIONS),
            Some(false)
        );
        note("w10-test-a", "https://a.com", NOTIFICATIONS, Some(false));
        let mut decided = answers_for("w10-test-a", NOTIFICATIONS);
        decided.sort();
        assert_eq!(
            decided,
            vec![
                ("https://a.com".to_owned(), false),
                ("https://wrapped.com".to_owned(), false)
            ]
        );
        forget_profile("w10-test-a");
        assert_eq!(answer("w10-test-a", "https://a.com", POPUPS), None);
    }

    #[test]
    fn private_answers_live_in_the_private_choices() {
        note("w10-p@Default", "https://b.com", POPUPS, Some(true));
        assert_eq!(answer("w10-p@Default", "https://b.com", POPUPS), Some(true));
        assert_eq!(answer("w10-p@Default", "https://c.com", POPUPS), None);
        note("w10-p@Default", "https://b.com", POPUPS, None);
        assert_eq!(answer("w10-p@Default", "https://b.com", POPUPS), None);
    }
}
