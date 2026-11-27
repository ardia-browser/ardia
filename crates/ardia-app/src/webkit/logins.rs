use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ardia_engine::PasswordPrompt;
use ardia_state::TabId;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::dropdown::Row;
use super::services::{self, PageMessage, js_string, later, url_origin};
use crate::coordinator::AppCoordinator;

pub const LISTING_LIFETIME: Duration = Duration::from_secs(30);
pub const LANDING: Duration = Duration::from_secs(15);
pub const NAVIGATION_GRACE: Duration = Duration::from_millis(400);
pub const LANDING_CHECK: Duration = Duration::from_millis(250);
pub const MISSING_CALL: &str = "the engine has no";
pub const SECRET_DOTS: &str = "••••••••";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Login {
    pub username: String,
    pub realm: String,
    pub matched: String,
}

#[derive(Clone, Debug)]
struct Pending {
    url: String,
    origin: String,
    username: String,
    password: Zeroizing<String>,
    update: bool,
    field: Value,
    usernames: Vec<String>,
}

#[derive(Clone, Debug)]
struct Field {
    tab: TabId,
    origin: String,
    url: String,
}

#[derive(Default)]
struct Book {
    listings: HashMap<String, (Instant, Vec<Login>)>,
    field: Option<Field>,
    shown: HashMap<String, Login>,
    ticket: u64,
    pending: HashMap<TabId, Pending>,
    landings: HashMap<TabId, u64>,
    turns: u64,
    never: HashSet<String>,
}

static BOOK: Mutex<Option<Book>> = Mutex::new(None);

fn with_book<R>(run: impl FnOnce(&mut Book) -> R) -> R {
    let mut slot = BOOK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    run(slot.get_or_insert_with(Book::default))
}

pub fn normalized(origin: &str) -> String {
    origin.strip_suffix('/').unwrap_or(origin).to_lowercase()
}

pub fn row_id(login: &Login) -> String {
    format!("{}\n{}", login.realm, login.username)
}

pub fn row_of(login: &Login) -> Row {
    let title = if login.username.is_empty() {
        "No username".to_owned()
    } else {
        login.username.clone()
    };
    let detail = if login.matched == "exact" {
        SECRET_DOTS.to_owned()
    } else {
        url::Url::parse(&login.realm)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_else(|| login.realm.clone())
    };
    let mut row = Row::new(&row_id(login), &title, &detail, "key.fill");
    row.muted = login.username.is_empty();
    row
}

pub fn shown_logins(logins: &[Login], typed: &str) -> Vec<Login> {
    let typed = typed.to_lowercase();
    logins
        .iter()
        .filter(|login| typed.is_empty() || login.username.to_lowercase().starts_with(&typed))
        .cloned()
        .collect()
}

pub fn logins_from(reply: &Value) -> Vec<Login> {
    reply
        .get("logins")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    Some(Login {
                        username: entry.get("username")?.as_str()?.to_owned(),
                        realm: entry.get("realm")?.as_str()?.to_owned(),
                        matched: entry
                            .get("match")
                            .and_then(Value::as_str)
                            .unwrap_or("exact")
                            .to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn submitted_field(raw: Option<&Value>) -> Value {
    let pick = |key: &str| -> String {
        raw.and_then(|r| r.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect()
    };
    json!({ "name": pick("name"), "id": pick("id"), "autocomplete": pick("autocomplete") })
}

fn lacks_call(reply: &Value) -> bool {
    reply
        .get("error")
        .and_then(Value::as_str)
        .is_some_and(|e| e.starts_with(MISSING_CALL))
}

fn number(data: &Value, key: &str) -> f64 {
    data.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

impl AppCoordinator {
    pub(super) fn webkit_page_origin(&self, tab: &TabId) -> Option<String> {
        services::page_url(tab).and_then(|url| url_origin(&url))
    }

    pub(super) fn webkit_profile_dir(&self, tab: &TabId) -> Option<String> {
        let state = self.store().snapshot();
        let listed = state.tab(tab.as_str())?;
        self.service_profile_dir(&listed.profile_id)
    }

    fn webkit_passwords_offered(&self, tab: &TabId) -> bool {
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return false;
        };
        if listed.is_incognito() {
            return false;
        }
        self.engine_profile_flags(&listed.profile_id)
            .is_some_and(|flags| flags.passwords_offered)
    }

    pub(super) fn webkit_call(
        &self,
        tab: &TabId,
        name: &'static str,
        args: Value,
        done: impl FnOnce(&AppCoordinator, Value) + 'static,
    ) {
        let (Some(engine), Some(dir)) = (self.engine(), self.webkit_profile_dir(tab)) else {
            return;
        };
        let reply = engine.call_service(name, &dir, &args.to_string());
        let me = self.weak();
        self.spawn(async move {
            let value = reply
                .await
                .unwrap_or_else(|problem| json!({ "error": problem.to_string() }));
            if let Some(coordinator) = me.upgrade() {
                done(&coordinator, value);
            }
        });
    }

    pub(super) fn webkit_secret_call(
        &self,
        tab: &TabId,
        name: &'static str,
        args: Zeroizing<String>,
        done: impl FnOnce(&AppCoordinator, Value) + 'static,
    ) {
        let (Some(engine), Some(dir)) = (self.engine(), self.webkit_profile_dir(tab)) else {
            return;
        };
        let reply = engine.call_service_secret(name, &dir, args);
        let me = self.weak();
        self.spawn(async move {
            let value = match reply.await {
                Ok(secret) => secret.expose().clone(),
                Err(problem) => json!({ "error": problem.to_string() }),
            };
            if let Some(coordinator) = me.upgrade() {
                done(&coordinator, value);
            }
        });
    }

    pub(crate) fn webkit_login_field(&self, tab: &TabId, message: &PageMessage) {
        let data = &message.data;
        let claimed = data.get("origin").and_then(Value::as_str).map(normalized);
        let Some(origin) = message
            .origin
            .as_deref()
            .map(normalized)
            .filter(|o| Some(o) == claimed.as_ref())
        else {
            return self.webkit_close_logins(tab);
        };
        match data.get("event").and_then(Value::as_str).unwrap_or("show") {
            "show" | "input" => self.webkit_show_logins(tab, data, &origin),
            "key" => self.webkit_login_key(
                tab,
                data.get("key").and_then(Value::as_str).unwrap_or_default(),
            ),
            _ => self.webkit_close_logins(tab),
        }
    }

    fn webkit_show_logins(&self, tab: &TabId, data: &Value, origin: &str) {
        let page = self.webkit_page_origin(tab).map(|o| normalized(&o));
        let Some(url) = services::page_url(tab).filter(|_| page.as_deref() == Some(origin)) else {
            return self.webkit_close_logins(tab);
        };
        let password = data.get("password").and_then(Value::as_bool) == Some(true);
        let typed = if password {
            String::new()
        } else {
            data.get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let rect = (
            number(data, "x"),
            number(data, "y"),
            number(data, "width"),
            number(data, "height"),
        );
        let ticket = with_book(|book| {
            book.ticket += 1;
            book.field = Some(Field {
                tab: tab.clone(),
                origin: origin.to_owned(),
                url: url.clone(),
            });
            book.ticket
        });
        let key = format!("{tab}|{origin}");
        let cached = with_book(|book| {
            book.listings
                .get(&key)
                .filter(|(at, _)| at.elapsed() < LISTING_LIFETIME)
                .map(|(_, logins)| logins.clone())
        });
        let call_tab = tab.clone();
        let tab = tab.clone();
        let origin = origin.to_owned();
        let present = move |c: &AppCoordinator, logins: Vec<Login>| {
            let current = with_book(|book| {
                book.ticket == ticket && book.field.as_ref().is_some_and(|f| f.tab == tab)
            });
            if !current
                || c.webkit_page_origin(&tab)
                    .map(|o| normalized(&o))
                    .as_deref()
                    != Some(origin.as_str())
            {
                return;
            }
            c.webkit_present_logins(&tab, shown_logins(&logins, &typed), rect);
        };
        if let Some(logins) = cached {
            present(self, logins);
            return;
        }
        let listing = key;
        self.webkit_call(
            &call_tab,
            "ac_passwords_page_logins",
            json!({ "url": url }),
            move |c, reply| {
                let logins = logins_from(&reply);
                if reply.get("error").is_none() {
                    with_book(|book| {
                        book.listings
                            .insert(listing, (Instant::now(), logins.clone()));
                    });
                }
                present(c, logins);
            },
        );
    }

    fn webkit_present_logins(&self, tab: &TabId, logins: Vec<Login>, rect: (f64, f64, f64, f64)) {
        if logins.is_empty() {
            return self.webkit_close_logins(tab);
        }
        with_book(|book| {
            book.shown = logins.iter().map(|l| (row_id(l), l.clone())).collect();
        });
        let rows: Vec<Row> = logins.iter().map(row_of).collect();
        #[cfg(target_os = "macos")]
        {
            let Some((web, field)) = services::web_rect(tab, rect.0, rect.1, rect.2, rect.3) else {
                return self.webkit_close_logins(tab);
            };
            let me = self.weak();
            let pick_tab = tab.clone();
            let pick = std::rc::Rc::new(move |row: Row| {
                if let Some(c) = me.upgrade() {
                    c.webkit_login_picked(&pick_tab, &row.id);
                }
            });
            let sync_tab = tab.clone();
            let select = std::rc::Rc::new(move || sync_logins_page(&sync_tab));
            let dismiss_tab = tab.clone();
            let dismiss = std::rc::Rc::new(move || {
                sync_logins_page(&dismiss_tab);
                with_book(|book| book.field = None);
            });
            let shown = super::dropdown::show(
                rows,
                field,
                &web,
                super::dropdown::Handlers {
                    on_pick: pick,
                    on_select: select,
                    on_dismiss: dismiss,
                },
            );
            if !shown {
                return self.webkit_close_logins(tab);
            }
            sync_logins_page(tab);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (rows, rect);
        }
    }

    fn webkit_login_key(&self, tab: &TabId, key: &str) {
        #[cfg(target_os = "macos")]
        {
            let ours = with_book(|book| book.field.as_ref().is_some_and(|f| &f.tab == tab));
            if !super::dropdown::is_shown() || !ours {
                return;
            }
            match key {
                "down" => super::dropdown::move_selection(1),
                "up" => super::dropdown::move_selection(-1),
                "enter" => match super::dropdown::selected_row() {
                    Some(row) => self.webkit_login_picked(tab, &row.id),
                    None => self.webkit_close_logins(tab),
                },
                _ => self.webkit_close_logins(tab),
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (tab, key);
    }

    pub(crate) fn webkit_close_logins(&self, tab: &TabId) {
        let ours = with_book(|book| {
            let ours = book.field.as_ref().is_none_or(|f| &f.tab == tab);
            if ours {
                book.ticket += 1;
                book.field = None;
                book.shown.clear();
            }
            ours
        });
        if !ours {
            return;
        }
        #[cfg(target_os = "macos")]
        super::dropdown::close();
        sync_logins_page(tab);
    }

    fn webkit_login_picked(&self, tab: &TabId, id: &str) {
        let Some((field, login)) = with_book(|book| {
            let field = book.field.clone()?;
            let login = book.shown.get(id).cloned()?;
            Some((field, login))
        }) else {
            return;
        };
        self.webkit_close_logins(tab);
        let args = Zeroizing::new(
            json!({ "url": field.url, "realm": login.realm, "username": login.username })
                .to_string(),
        );
        let tab = tab.clone();
        self.webkit_secret_call(
            &tab.clone(),
            "ac_passwords_page_fill",
            args,
            move |c, reply| {
                if lacks_call(&reply) {
                    let args = Zeroizing::new(
                        json!({ "origin": field.origin, "username": login.username }).to_string(),
                    );
                    let username = login.username.clone();
                    let origin = field.origin.clone();
                    c.webkit_secret_call(
                        &tab.clone(),
                        "ac_passwords_reveal",
                        args,
                        move |c, reply| {
                            if let Some(password) = reply.get("password").and_then(Value::as_str) {
                                c.webkit_fill_login(&tab, &origin, &username, password);
                            }
                        },
                    );
                    return;
                }
                let Some(password) = reply.get("password").and_then(Value::as_str) else {
                    return;
                };
                let username = reply
                    .get("username")
                    .and_then(Value::as_str)
                    .unwrap_or(&login.username)
                    .to_owned();
                c.webkit_fill_login(&tab, &field.origin, &username, password);
            },
        );
    }

    fn webkit_fill_login(&self, tab: &TabId, origin: &str, username: &str, password: &str) {
        if self
            .webkit_page_origin(tab)
            .map(|o| normalized(&o))
            .as_deref()
            != Some(origin)
        {
            return;
        }
        let code = Zeroizing::new(format!(
            "window.__ardiaLogins ? window.__ardiaLogins.fill({}, {}, {}) : false",
            js_string(username),
            js_string(password),
            js_string(origin)
        ));
        services::run(tab, None, &code, None);
        self.webkit_service_count("autofillFill");
    }

    pub(crate) fn webkit_login_submitted(&self, tab: &TabId, message: &PageMessage) {
        let data = &message.data;
        let claimed = data.get("origin").and_then(Value::as_str).map(normalized);
        let Some(origin) = message
            .origin
            .as_deref()
            .map(normalized)
            .filter(|o| Some(o) == claimed.as_ref())
        else {
            return;
        };
        if !self.webkit_passwords_offered(tab) {
            return;
        }
        let Some(password) = data
            .get("password")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            .map(|p| Zeroizing::new(p.to_owned()))
        else {
            return;
        };
        if !(origin.starts_with("https://") || origin.starts_with("http://"))
            || with_book(|book| book.never.contains(&origin))
        {
            return;
        }
        let username = data
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let field = submitted_field(data.get("field"));
        let url = if self
            .webkit_page_origin(tab)
            .map(|o| normalized(&o))
            .as_deref()
            == Some(origin.as_str())
        {
            services::page_url(tab).unwrap_or_else(|| format!("{origin}/"))
        } else {
            format!("{origin}/")
        };
        let args = Zeroizing::new(
            json!({ "url": url, "username": username, "password": password.as_str() }).to_string(),
        );
        let tab = tab.clone();
        self.webkit_secret_call(
            &tab.clone(),
            "ac_passwords_page_submitted",
            args,
            move |c, reply| {
                let state = reply
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let pending = |update: bool, username: String, usernames: Vec<String>| Pending {
                    url: url.clone(),
                    origin: origin.clone(),
                    username,
                    password: password.clone(),
                    update,
                    field: field.clone(),
                    usernames,
                };
                match state {
                    "save" => c.webkit_offer_save(
                        &tab,
                        pending(false, username.clone(), vec![username.clone()]),
                    ),
                    "update" => {
                        let saved = reply
                            .get("username")
                            .and_then(Value::as_str)
                            .unwrap_or(&username)
                            .to_owned();
                        let usernames = reply
                            .get("usernames")
                            .and_then(Value::as_array)
                            .map(|list| {
                                list.iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_owned)
                                    .collect()
                            })
                            .unwrap_or_else(|| vec![saved.clone()]);
                        c.webkit_offer_save(&tab, pending(true, saved, usernames));
                    }
                    _ => {}
                }
            },
        );
    }

    fn webkit_offer_save(&self, tab: &TabId, pending: Pending) {
        let turn = with_book(|book| {
            book.turns += 1;
            book.pending.insert(tab.clone(), pending);
            book.landings.insert(tab.clone(), book.turns);
            book.turns
        });
        let deadline = Instant::now() + LANDING;
        let tab = tab.clone();
        later(self, NAVIGATION_GRACE, move |c| {
            c.webkit_land_save(&tab, turn, deadline)
        });
    }

    fn webkit_land_save(&self, tab: &TabId, turn: u64, deadline: Instant) {
        if with_book(|book| book.landings.get(tab) != Some(&turn)) {
            return;
        }
        let Some(pending) = with_book(|book| book.pending.get(tab).cloned()) else {
            with_book(|book| book.landings.remove(tab));
            return;
        };
        if !crate::webkit::page::has(tab) {
            with_book(|book| book.landings.remove(tab));
            return;
        }
        let last = Instant::now() >= deadline;
        if services::page_loading(tab) && !last {
            let tab = tab.clone();
            later(self, LANDING_CHECK, move |c| {
                c.webkit_land_save(&tab, turn, deadline)
            });
            return;
        }
        let code = format!(
            "window.__ardiaLogins ? window.__ardiaLogins.formShown({}, {}) : false",
            js_string(&pending.origin),
            pending.field
        );
        let me = self.weak();
        let tab = tab.clone();
        services::run(
            &tab.clone(),
            None,
            &code,
            Some(Box::new(move |shown| {
                let Some(c) = me.upgrade() else {
                    return;
                };
                if with_book(|book| book.landings.get(&tab) != Some(&turn)) {
                    return;
                }
                let shown = shown
                    .as_ref()
                    .and_then(Value::as_f64)
                    .is_some_and(|v| v != 0.0);
                if !shown {
                    with_book(|book| book.landings.remove(&tab));
                    c.webkit_service_count(if pending.update {
                        "autofillUpdateOffer"
                    } else {
                        "autofillSaveOffer"
                    });
                    c.webkit_raise_password_prompt(&tab, &pending);
                    return;
                }
                if !last {
                    let tab = tab.clone();
                    later(&c, LANDING_CHECK, move |c| {
                        c.webkit_land_save(&tab, turn, deadline)
                    });
                    return;
                }
                with_book(|book| {
                    book.landings.remove(&tab);
                    book.pending.remove(&tab);
                });
                c.webkit_service_count("autofillSaveSuppressed");
            })),
        );
    }

    fn webkit_raise_password_prompt(&self, tab: &TabId, pending: &Pending) {
        let prompt = PasswordPrompt {
            state: if pending.update { "update" } else { "save" }.into(),
            origin: pending.origin.clone(),
            username: pending.username.clone(),
            usernames: pending.usernames.clone(),
            password_length: Some(pending.password.chars().count() as u32),
            federation: Some(String::new()),
            extra: Default::default(),
        };
        let changed = self.bridge.lock().prompts.password(tab, &prompt);
        if changed {
            self.publish_prompts(tab);
        }
    }

    pub(crate) fn webkit_resolve_password(
        &self,
        tab: &TabId,
        action: &str,
        username: Option<&str>,
        password: Option<&str>,
    ) -> bool {
        if !crate::webkit::page::has(tab) {
            return false;
        }
        let Some(login) = with_book(|book| book.pending.remove(tab)) else {
            return true;
        };
        let name = username
            .map(str::to_owned)
            .unwrap_or(login.username.clone());
        let secret = Zeroizing::new(
            password
                .map(str::to_owned)
                .unwrap_or_else(|| login.password.to_string()),
        );
        with_book(|book| {
            book.listings.remove(&format!("{tab}|{}", login.origin));
        });
        match action {
            "save" => {
                let args = Zeroizing::new(
                    json!({ "origin": login.origin, "username": name, "password": secret.as_str() })
                        .to_string(),
                );
                self.webkit_secret_call(tab, "ac_passwords_add", args, |c, reply| {
                    if reply.get("error").is_none() {
                        c.webkit_service_count("autofillSave");
                    }
                });
            }
            "update" if login.update => {
                let args = Zeroizing::new(
                    json!({ "url": login.url, "username": name, "password": secret.as_str() })
                        .to_string(),
                );
                let tab_again = tab.clone();
                let origin = login.origin;
                self.webkit_secret_call(tab, "ac_passwords_page_update", args, move |c, reply| {
                    if reply.get("error").is_none() {
                        return c.webkit_service_count("autofillUpdate");
                    }
                    if !lacks_call(&reply) {
                        return;
                    }
                    let args = Zeroizing::new(
                        json!({ "origin": origin, "username": name, "password": secret.as_str() })
                            .to_string(),
                    );
                    c.webkit_secret_call(&tab_again, "ac_passwords_update", args, |c, reply| {
                        if reply.get("error").is_none() {
                            c.webkit_service_count("autofillUpdate");
                        }
                    });
                });
            }
            "never" => {
                self.webkit_service_count("autofillNever");
                let origin = login.origin.clone();
                self.webkit_call(
                    tab,
                    "ac_passwords_page_never",
                    json!({ "url": login.url }),
                    move |_, reply| {
                        if lacks_call(&reply) {
                            with_book(|book| book.never.insert(origin));
                        }
                    },
                );
            }
            _ => {}
        }
        true
    }

    pub(crate) fn webkit_logins_committed(&self, tab: &TabId) {
        let ours = with_book(|book| book.field.as_ref().is_some_and(|f| &f.tab == tab));
        if ours {
            self.webkit_close_logins(tab);
        }
    }

    pub(crate) fn webkit_logins_closed(&self, tab: &TabId) {
        with_book(|book| {
            book.pending.remove(tab);
            book.landings.remove(tab);
        });
        self.webkit_close_logins(tab);
        self.webkit_close_autofill(tab);
    }

    pub(crate) fn webkit_service_count(&self, name: &str) {
        super::telemetry::note_webkit_count(name);
    }
}

fn sync_logins_page(tab: &TabId) {
    #[cfg(target_os = "macos")]
    let (open, picking) = (
        super::dropdown::is_shown(),
        super::dropdown::selected_row().is_some(),
    );
    #[cfg(not(target_os = "macos"))]
    let (open, picking) = (false, false);
    let code = format!("window.__ardiaLogins && window.__ardiaLogins.dropdown({open}, {picking})");
    services::run(tab, None, &code, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_match_the_old_dropdown() {
        let exact = Login {
            username: "ann".into(),
            realm: "https://a.com/".into(),
            matched: "exact".into(),
        };
        let row = row_of(&exact);
        assert_eq!(row.title, "ann");
        assert_eq!(row.detail, SECRET_DOTS);
        assert_eq!(row.symbol, "key.fill");
        let blank = Login {
            username: String::new(),
            realm: "https://login.b.com/".into(),
            matched: "psl".into(),
        };
        let row = row_of(&blank);
        assert_eq!(row.title, "No username");
        assert_eq!(row.detail, "login.b.com");
        assert!(row.muted);
        assert_eq!(shown_logins(&[exact.clone(), blank], "AN"), vec![exact]);
    }

    #[test]
    fn replies_and_fields_are_cleaned() {
        let reply = json!({ "logins": [{ "username": "u", "realm": "r" }, { "realm": "x" }] });
        let logins = logins_from(&reply);
        assert_eq!(logins.len(), 1);
        assert_eq!(logins[0].matched, "exact");
        assert_eq!(normalized("HTTPS://A.com/"), "https://a.com");
        let field = submitted_field(Some(&json!({ "name": "p", "id": 3 })));
        assert_eq!(field, json!({ "name": "p", "id": "", "autocomplete": "" }));
        assert!(lacks_call(&json!({ "error": "the engine has no ac_x" })));
    }
}
