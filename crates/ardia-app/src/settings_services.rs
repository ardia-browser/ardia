use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use ardia_state::ProfileId;
use ardia_ui::host_data::HostTopics;
use ardia_ui::settings::data::{CallReply, SettingsCall, SettingsQuery};
use futures::channel::oneshot;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::coordinator::AppCoordinator;

pub const UNLOCK_FOR: Duration = Duration::from_secs(5 * 60);
pub const PASSWORDS_FILE_NAME: &str = "Ardia Passwords.csv";

#[derive(Default)]
pub struct SettingsValues {
    entries: HashMap<SettingsQuery, (Value, u64)>,
    next_revision: u64,
}

impl SettingsValues {
    pub fn get(&self, query: &SettingsQuery) -> Option<&Value> {
        self.entries.get(query).map(|(value, _)| value)
    }

    pub fn revision_of(&self, query: &SettingsQuery) -> Option<u64> {
        self.entries.get(query).map(|(_, revision)| *revision)
    }

    pub fn keys(&self) -> impl Iterator<Item = &SettingsQuery> {
        self.entries.keys()
    }

    pub fn contains_key(&self, query: &SettingsQuery) -> bool {
        self.entries.contains_key(query)
    }

    pub fn insert(&mut self, query: SettingsQuery, value: Value) {
        self.next_revision += 1;
        self.entries.insert(query, (value, self.next_revision));
    }

    pub fn remove(&mut self, query: &SettingsQuery) {
        self.entries.remove(query);
    }
}

#[derive(Default)]
pub struct SettingsServices {
    values: SettingsValues,
    asked: HashSet<SettingsQuery>,
    unlocked: HashMap<ProfileId, Instant>,
}

impl SettingsServices {
    pub fn unlocked(&self, profile: &ProfileId, now: Instant) -> bool {
        self.unlocked
            .get(profile)
            .is_some_and(|at| now.saturating_duration_since(*at) < UNLOCK_FOR)
    }

    pub fn forget(&mut self, queries: &[SettingsQuery]) {
        for query in queries {
            self.values.remove(query);
            self.asked.remove(query);
        }
    }
}

pub fn origin_of_login(url: &str) -> String {
    let trimmed = url.trim();
    let has_scheme = trimmed.split_once("://").is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let absolute = if has_scheme {
        trimmed.to_owned()
    } else if let Some(rest) = trimmed.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        format!("https://{trimmed}")
    };
    let Some((scheme, rest)) = absolute.split_once("://") else {
        return String::new();
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() {
        return String::new();
    }
    format!("{scheme}://{host}")
}

fn answered(value: Value) -> CallReply {
    let (answer, reply) = oneshot::channel();
    let _ = answer.send(Ok(value));
    reply
}

fn refused(message: &str) -> CallReply {
    let (answer, reply) = oneshot::channel();
    let _ = answer.send(Err(message.to_owned()));
    reply
}

impl AppCoordinator {
    pub(crate) fn settings_value_of(&self, query: &SettingsQuery) -> Option<Value> {
        if let SettingsQuery::PasswordsUnlocked(profile) = query {
            let open = self
                .bridge
                .lock()
                .settings_services
                .unlocked(profile, Instant::now());
            return Some(Value::Bool(open));
        }
        if query == &SettingsQuery::ControlApprovals {
            self.note_approvals_seen();
        }
        let (cached, ask) = {
            let mut bridge = self.bridge.lock();
            let services = &mut bridge.settings_services;
            (
                services.values.get(query).cloned(),
                services.asked.insert(query.clone()),
            )
        };
        if ask {
            self.fetch_settings_value(query.clone());
        }
        cached
    }

    pub(crate) fn settings_revision_of(&self, query: &SettingsQuery) -> Option<u64> {
        if matches!(
            query,
            SettingsQuery::PasswordsUnlocked(_) | SettingsQuery::ControlApprovals
        ) {
            return None;
        }
        self.bridge
            .lock()
            .settings_services
            .values
            .revision_of(query)
    }

    pub(crate) fn cached_settings_value(&self, query: &SettingsQuery) -> Option<Value> {
        self.bridge
            .lock()
            .settings_services
            .values
            .get(query)
            .cloned()
    }

    fn fetch_settings_value(&self, query: SettingsQuery) {
        if query == SettingsQuery::SavedInstallId {
            self.fetch_saved_install_id();
            return;
        }
        if query == SettingsQuery::ControlApprovals {
            self.fetch_control_approvals();
            return;
        }
        if let SettingsQuery::HiddenElements(profile) = &query {
            self.fetch_hidden_elements(profile.clone());
            return;
        }
        let me = self.weak();
        let asked = std::time::Instant::now();
        self.spawn(async move {
            let Some(me) = me.upgrade() else {
                return;
            };
            let Some(profile) = query.profile().cloned() else {
                return;
            };
            let (Some(engine), Some(dir)) = (me.engine(), me.service_profile_dir(&profile)) else {
                me.bridge.lock().settings_services.asked.remove(&query);
                let _ = me.resolve_profile(&profile);
                return;
            };
            let services = ardia_engine::Services::new(engine.as_ref(), &dir);
            let asked_at = Instant::now();
            let reply = match &query {
                SettingsQuery::Passwords(_) => services.passwords().list().await,
                SettingsQuery::NeverSaved(_) => services.passwords().exceptions().await,
                SettingsQuery::Addresses(_) => services.autofill().addresses().await,
                SettingsQuery::Cards(_) => services.autofill().cards().await,
                SettingsQuery::SiteOrigins(_) => services.sites().origins().await,
                SettingsQuery::Site(_, origin) => services.sites().settings(origin).await,
                SettingsQuery::Zooms(_) => services.sites().zoom_levels().await,
                SettingsQuery::Extensions(_) => services.extensions().list().await,
                SettingsQuery::PasswordsUnlocked(_)
                | SettingsQuery::SavedInstallId
                | SettingsQuery::ControlApprovals
                | SettingsQuery::HiddenElements(_) => return,
            };
            ardia_profile::record_since(ardia_profile::Span::SettingsQuery, asked);
            {
                let mut bridge = me.bridge.lock();
                let services = &mut bridge.settings_services;
                match reply {
                    Ok(value) => {
                        if matches!(query, SettingsQuery::Passwords(_)) {
                            note_password_list_shown(&value, asked_at.elapsed());
                        }
                        let value = shaped_reply(&query, value);
                        services.values.insert(query, value);
                    }
                    Err(problem) => {
                        log::debug!("settings data {query:?} wasn't read: {problem}");
                        services.asked.remove(&query);
                        return;
                    }
                }
            }
            me.signal.emit(HostTopics::SYNC);
        });
    }

    pub(crate) fn refresh_settings_values(&self, queries: Vec<SettingsQuery>) {
        self.bridge.lock().settings_services.forget(&queries);
        for query in queries {
            if !matches!(query, SettingsQuery::PasswordsUnlocked(_)) {
                self.bridge
                    .lock()
                    .settings_services
                    .asked
                    .insert(query.clone());
                self.fetch_settings_value(query);
            }
        }
        self.signal.emit(HostTopics::SYNC);
    }

    fn fetch_saved_install_id(&self) {
        let Some(dir) = self.config.data_dir.clone() else {
            return;
        };
        let (found, read) = oneshot::channel();
        std::thread::spawn(move || {
            let _ = found.send(crate::sharing_doc::install_id(&dir));
        });
        let me = self.weak();
        self.spawn(async move {
            let id = read.await.ok().flatten();
            if let Some(me) = me.upgrade() {
                me.bridge
                    .lock()
                    .settings_services
                    .values
                    .insert(SettingsQuery::SavedInstallId, json!({ "installId": id }));
                me.signal.emit(HostTopics::SYNC);
            }
        });
    }

    fn fetch_hidden_elements(&self, profile: ProfileId) {
        let query = SettingsQuery::HiddenElements(profile.clone());
        let Some(read) = self.profile_hidden_filters(&profile) else {
            self.bridge.lock().settings_services.asked.remove(&query);
            let _ = self.resolve_profile(&profile);
            return;
        };
        let me = self.weak();
        self.spawn(async move {
            let found = read.await;
            let Some(me) = me.upgrade() else {
                return;
            };
            let filters = match found {
                Ok(filters) => filters,
                Err(problem) => {
                    log::debug!("hidden elements weren't read: {problem}");
                    Vec::new()
                }
            };
            me.bridge
                .lock()
                .settings_services
                .values
                .insert(query, json!(filters));
            me.signal.emit(HostTopics::SYNC);
        });
    }

    pub(crate) fn hidden_elements_changed_for_settings(&self) {
        let stale: Vec<SettingsQuery> = self
            .bridge
            .lock()
            .settings_services
            .values
            .keys()
            .filter(|query| matches!(query, SettingsQuery::HiddenElements(_)))
            .cloned()
            .collect();
        if !stale.is_empty() {
            self.refresh_settings_values(stale);
        }
    }

    fn restore_hidden_for_settings(&self, profile: &ProfileId, filters: Vec<String>) -> CallReply {
        let Some(restore) = self.restore_profile_hidden(profile, filters) else {
            return refused("the profile isn't open");
        };
        let (answer, reply) = oneshot::channel();
        let me = self.weak();
        self.spawn(async move {
            let result = restore.await;
            if let Some(me) = me.upgrade() {
                me.hidden_elements_changed_for_settings();
            }
            let _ = answer.send(result.map(|()| json!({})));
        });
        reply
    }

    fn add_extension_from_link(&self, profile: &ProfileId) -> CallReply {
        #[cfg(target_os = "macos")]
        {
            use ardia_engine::macos::dialogs::Alert;
            let asked = Alert::prompt(
                "Add Extension from a Link",
                "Paste a Chrome Web Store link or extension ID.",
                "",
                "chromewebstore.google.com/detail/…",
                "Add",
            )
            .show(None);
            let (answer, reply) = oneshot::channel();
            let me = self.weak();
            let profile = profile.clone();
            self.spawn(async move {
                let typed = asked
                    .await
                    .ok()
                    .filter(|response| response.chose(0))
                    .and_then(|response| response.entered_text().map(str::to_owned))
                    .map(|text| text.trim().to_owned())
                    .filter(|text| !text.is_empty());
                let Some(typed) = typed else {
                    let _ = answer.send(Ok(json!({})));
                    return;
                };
                let result = match ardia_state::extension_rules::web_store_extension_id(&typed) {
                    None => Err(ardia_state::extension_rules::NOT_A_STORE_LINK.to_owned()),
                    Some(id) => {
                        if let Some(me) = me.upgrade() {
                            ardia_ui::UiHost::open_extension_store_pages(
                                me.as_ref(),
                                profile,
                                vec![ardia_state::extension_rules::web_store_detail_url(&id)],
                            );
                        }
                        Ok(json!({ "opened": id }))
                    }
                };
                let _ = answer.send(result);
            });
            reply
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = profile;
            refused("adding extensions from a link isn't supported here yet")
        }
    }

    fn choose_unpacked_extension(&self) -> CallReply {
        #[cfg(target_os = "macos")]
        {
            use ardia_engine::macos::dialogs::FilePanel;
            let chosen = FilePanel::open_folder(None, None).show(None);
            let (answer, reply) = oneshot::channel();
            self.spawn(async move {
                let folder = chosen.await.ok().and_then(|paths| paths.into_iter().next());
                let Some(folder) = folder else {
                    let _ = answer.send(Ok(json!({})));
                    return;
                };
                let (found, read) = oneshot::channel();
                std::thread::spawn(move || {
                    let _ = found.send(crate::extension_package::inspect_unpacked(&folder));
                });
                let info = read
                    .await
                    .unwrap_or_else(|_| json!({ "error": "the folder couldn't be read" }));
                let _ = answer.send(Ok(info));
            });
            reply
        }
        #[cfg(not(target_os = "macos"))]
        {
            refused("loading unpacked extensions isn't supported here yet")
        }
    }

    fn fetch_control_approvals(&self) {
        let Some(dir) = self.config.data_dir.clone() else {
            self.bridge.lock().settings_services.values.insert(
                SettingsQuery::ControlApprovals,
                json!({ "approvals": [], "problem": "Ardia has no data folder." }),
            );
            return;
        };
        let (found, read) = oneshot::channel();
        let doorbell = self.control_doorbell_on();
        std::thread::spawn(move || {
            let now = ardia_state::store::now_ms() as f64 / 1000.0;
            let _ = found.send(crate::control_approvals::read_wire(&dir, now, doorbell));
        });
        let me = self.weak();
        self.spawn(async move {
            let Ok(value) = read.await else {
                return;
            };
            if let Some(me) = me.upgrade() {
                me.arm_approvals_recheck(&value);
                me.bridge
                    .lock()
                    .settings_services
                    .values
                    .insert(SettingsQuery::ControlApprovals, value);
                me.signal.emit(HostTopics::SYNC);
            }
        });
    }

    fn run_off_thread(
        &self,
        work: impl FnOnce() -> Result<Value, String> + Send + 'static,
        stale: Vec<SettingsQuery>,
    ) -> CallReply {
        let (answer, reply) = oneshot::channel();
        let (done, finished) = oneshot::channel();
        std::thread::spawn(move || {
            let _ = done.send(work());
        });
        let me = self.weak();
        self.spawn(async move {
            let result = finished
                .await
                .unwrap_or_else(|_| Err("the work stopped".to_owned()));
            if result.is_ok()
                && !stale.is_empty()
                && let Some(me) = me.upgrade()
            {
                me.refresh_settings_values(stale);
            }
            let _ = answer.send(result);
        });
        reply
    }

    pub(crate) fn run_settings_call(&self, call: SettingsCall) -> CallReply {
        match &call {
            SettingsCall::ExportBookmarks(profile) => {
                return self.export_bookmarks_for_settings(profile);
            }
            SettingsCall::ResetAnonymousId => {
                let Some(dir) = self.config.data_dir.clone() else {
                    return refused("no data folder");
                };
                return self.run_off_thread(move || reset_install_id(&dir), call.stale());
            }
            SettingsCall::RevokeApproval(key) => {
                let Some(dir) = self.config.data_dir.clone() else {
                    return refused("no data folder");
                };
                let key = key.clone();
                self.retire_control_key(&key);
                return self.run_off_thread(
                    move || {
                        let now = ardia_state::store::now_ms() as f64 / 1000.0;
                        crate::control_approvals::revoke(&dir, &key, now)
                            .map(|removed| json!({ "removed": removed }))
                    },
                    call.stale(),
                );
            }
            SettingsCall::RestoreHiddenElements { profile, filters } => {
                return self.restore_hidden_for_settings(profile, filters.clone());
            }
            SettingsCall::AddExtensionFromLink(profile) => {
                return self.add_extension_from_link(profile);
            }
            SettingsCall::ChooseUnpackedExtension(_) => {
                return self.choose_unpacked_extension();
            }
            SettingsCall::ViewMyData => {
                let Some(dir) = self.config.data_dir.clone() else {
                    return refused("no data folder");
                };
                let downloads = local_copy_folder(&dir, self.config.scratch);
                let reveal = !self.config.background;
                return self.run_off_thread(
                    move || {
                        export_local_copy(&dir, &downloads, ardia_state::store::now_ms(), reveal)
                    },
                    Vec::new(),
                );
            }
            _ => {}
        }
        let Some(profile) = call.profile().cloned() else {
            return refused("no profile");
        };
        let (Some(engine), Some(dir)) = (self.engine(), self.service_profile_dir(&profile)) else {
            return refused("the profile isn't open");
        };
        if let SettingsCall::RevealPassword { .. } = &call
            && !self
                .bridge
                .lock()
                .settings_services
                .unlocked(&profile, Instant::now())
        {
            return refused("Not authenticated");
        }
        let (answer, reply) = oneshot::channel();
        let me = self.weak();
        self.spawn(async move {
            let services = ardia_engine::Services::new(engine.as_ref(), &dir);
            let stale = call.stale();
            let installs = matches!(call, SettingsCall::InstallUnpackedExtension { .. });
            let result: Result<Value, String> = match call {
                SettingsCall::UnlockPasswords(_) => {
                    let reply = services.passwords().unlock().await;
                    let open = reply
                        .as_ref()
                        .ok()
                        .and_then(|v| v.get("unlocked").and_then(Value::as_bool))
                        .unwrap_or(false);
                    if open && let Some(me) = me.upgrade() {
                        me.bridge
                            .lock()
                            .settings_services
                            .unlocked
                            .insert(profile.clone(), Instant::now());
                        me.relock_later(profile.clone());
                    }
                    reply.map_err(|e| e.to_string())
                }
                SettingsCall::RevealPassword {
                    origin, username, ..
                } => services
                    .passwords()
                    .reveal(&origin, &username)
                    .await
                    .map(|secret| json!({ "password": secret.expose().get("password").cloned() }))
                    .map_err(|e| e.to_string()),
                SettingsCall::UpdatePassword {
                    origin,
                    username,
                    new_username,
                    password,
                    ..
                } => services
                    .passwords()
                    .update(
                        &origin,
                        &username,
                        new_username.as_deref(),
                        Zeroizing::new(password.0),
                    )
                    .await
                    .map(|_| json!({ "ok": true }))
                    .map_err(|e| e.to_string()),
                SettingsCall::RemovePassword {
                    origin, username, ..
                } => services
                    .passwords()
                    .remove(&origin, &username)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::AllowSaving { origin, .. } => services
                    .passwords()
                    .allow(&origin)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::ImportPasswords(_) => import_passwords_csv(services).await,
                SettingsCall::ExportPasswords(_) => export_passwords_csv(services).await,
                SettingsCall::SaveAddress { address, .. } => services
                    .autofill()
                    .save_address(address)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::SaveCard { card, number, .. } => services
                    .call_secret(
                        "ac_autofill_save_card",
                        json!({ "card": card, "number": number.map(|n| n.0).unwrap_or_default() }),
                    )
                    .await
                    .map(|secret| json!({ "id": secret.expose().get("id").cloned() }))
                    .map_err(|e| e.to_string()),
                SettingsCall::RemoveAutofill { id, .. } => services
                    .autofill()
                    .remove(&id)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::CardNumber { id, .. } => services
                    .autofill()
                    .card_number(&id)
                    .await
                    .map(|secret| json!({ "number": secret.expose().get("number").cloned() }))
                    .map_err(|e| e.to_string()),
                SettingsCall::SetSiteSetting {
                    origin,
                    kind,
                    value,
                    ..
                } => services
                    .sites()
                    .set_setting(&origin, &kind, &value)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::ResetSite { origin, .. } => services
                    .sites()
                    .reset(&origin)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::ClearSiteData { origin, .. } => services
                    .sites()
                    .clear_data(&origin)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::SetZoom { host, level, .. } => services
                    .sites()
                    .set_zoom(&host, level)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::SetExtensionEnabled { id, enabled, .. } => services
                    .extensions()
                    .set_enabled(&id, enabled)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::ConfigureExtension { id, options, .. } => services
                    .extensions()
                    .configure(&id, options)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::ReloadExtension { id, .. } => services
                    .extensions()
                    .reload(&id)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::UninstallExtension { id, .. } => services
                    .extensions()
                    .uninstall(&id)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::InstallUnpackedExtension { path, .. } => services
                    .extensions()
                    .install(&path)
                    .await
                    .map_err(|e| e.to_string()),
                SettingsCall::ExportBookmarks(_)
                | SettingsCall::ResetAnonymousId
                | SettingsCall::ViewMyData
                | SettingsCall::RevokeApproval(_)
                | SettingsCall::RestoreHiddenElements { .. }
                | SettingsCall::AddExtensionFromLink(_)
                | SettingsCall::ChooseUnpackedExtension(_) => Err("unreachable".to_owned()),
            };
            if let Some(me) = me.upgrade() {
                if result.is_ok() && !stale.is_empty() {
                    me.refresh_settings_values(stale);
                }
                if result.is_ok() {
                    me.signal.emit(HostTopics::EXTENSIONS);
                }
                if result.is_ok() && installs {
                    ardia_telemetry::counts::count("unpacked_extension_installs");
                    me.extensions_changed();
                }
            }
            let _ = answer.send(result);
        });
        reply
    }

    fn relock_later(&self, profile: ProfileId) {
        let me = self.weak();
        let wait = crate::content_blocker::delay(UNLOCK_FOR);
        self.spawn(async move {
            let _ = wait.await;
            if let Some(me) = me.upgrade() {
                let now = Instant::now();
                let locked = {
                    let mut bridge = me.bridge.lock();
                    let services = &mut bridge.settings_services;
                    let expired = !services.unlocked(&profile, now);
                    if expired {
                        services.unlocked.remove(&profile);
                    }
                    expired
                };
                if locked {
                    me.signal.emit(HostTopics::SYNC);
                }
            }
        });
    }

    fn export_bookmarks_for_settings(&self, profile: &ProfileId) -> CallReply {
        let html = self
            .store
            .snapshot()
            .bookmarks_of(profile)
            .map(|tree| crate::bookmark_actions::bookmarks_html(tree));
        let Some(html) = html else {
            return answered(json!({}));
        };
        #[cfg(target_os = "macos")]
        {
            use ardia_engine::macos::dialogs::FilePanel;
            let chosen =
                FilePanel::save(crate::bookmark_actions::EXPORT_FILE_NAME, &["html"]).show(None);
            let (answer, reply) = oneshot::channel();
            self.spawn(async move {
                let path = chosen.await.ok().and_then(|paths| paths.into_iter().next());
                let result = match path {
                    None => Ok(json!({})),
                    Some(path) => std::fs::write(&path, html.as_bytes())
                        .map(|()| json!({ "path": path.to_string_lossy() }))
                        .map_err(|problem| problem.to_string()),
                };
                let _ = answer.send(result);
            });
            reply
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = html;
            refused("exporting bookmarks isn't supported here yet")
        }
    }
}

pub const LOCAL_KEEP_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub fn local_copy_folder(data_dir: &std::path::Path, isolated: bool) -> std::path::PathBuf {
    if isolated {
        return data_dir.join("Downloads");
    }
    std::env::var_os("HOME")
        .map(|home| std::path::PathBuf::from(home).join("Downloads"))
        .unwrap_or_else(|| data_dir.join("Downloads"))
}

pub fn local_copy_path(folder: &std::path::Path, day: &str) -> std::path::PathBuf {
    let base = format!("Ardia data {day}");
    let mut path = folder.join(format!("{base}.jsonl"));
    let mut n = 2;
    while path.exists() {
        path = folder.join(format!("{base} {n}.jsonl"));
        n += 1;
    }
    path
}

pub fn export_local_copy(
    data_dir: &std::path::Path,
    folder: &std::path::Path,
    now: i64,
    reveal: bool,
) -> Result<Value, String> {
    let local = data_dir.join("Telemetry").join("local");
    let (data, lines) = crate::report_local::collect(&local, now - LOCAL_KEEP_MS);
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let path = local_copy_path(folder, &crate::report_local::utc_day(now));
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    if reveal {
        let _ = ardia_engine::macos::platform::reveal_in_finder(std::slice::from_ref(&path));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = reveal;
    Ok(json!({ "lines": lines, "path": path.to_string_lossy() }))
}

pub fn reset_install_id(data_dir: &std::path::Path) -> Result<Value, String> {
    if let Some(id) = crate::telemetry::replace_install_id(data_dir) {
        return Ok(json!({ "installId": id }));
    }
    use ardia_state::persistence::DataDir;
    use ardia_state::persistence::documents::{DocRead, read_versioned, write_versioned};
    let dir = DataDir::new(data_dir);
    let mut doc = match read_versioned(
        &dir,
        crate::sharing_doc::DOC,
        "version",
        crate::sharing_doc::VERSION,
    ) {
        DocRead::Usable { doc, .. } => Value::Object(doc.into_iter().collect()),
        _ => json!({}),
    };
    let id = uuid::Uuid::new_v4().to_string();
    if !doc.is_object() {
        doc = json!({});
    }
    doc["installId"] = Value::from(id.clone());
    write_versioned(
        &dir,
        crate::sharing_doc::DOC,
        "version",
        crate::sharing_doc::VERSION,
        doc,
    )
    .map_err(|e| e.to_string())?;
    let local = data_dir.join("Telemetry").join("local");
    if local.exists() {
        let _ = std::fs::remove_dir_all(&local);
    }
    Ok(json!({ "installId": id }))
}

async fn import_passwords_csv<E: ardia_engine::BrowserEngine + ?Sized>(
    services: ardia_engine::Services<'_, E>,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        use ardia_engine::macos::dialogs::FilePanel;
        let panel = FilePanel {
            extensions: vec!["csv".to_owned()],
            ..FilePanel::default()
        };
        let chosen = panel.show(None).await.map_err(|e| e.to_string())?;
        let Some(path) = chosen.into_iter().next() else {
            return Ok(json!({ "cancelled": true }));
        };
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let credentials = crate::import_readers::csv::passwords(&text)?;
        let total = credentials.len();
        let mut saved = 0usize;
        for credential in credentials {
            let origin = origin_of_login(&credential.url);
            if origin.is_empty() || credential.password.is_empty() {
                continue;
            }
            if services
                .passwords()
                .add(&origin, &credential.username, credential.password.clone())
                .await
                .is_ok()
            {
                saved += 1;
            }
        }
        Ok(json!({ "saved": saved, "skipped": total - saved }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = services;
        Err("importing passwords isn't supported here yet".to_owned())
    }
}

async fn export_passwords_csv<E: ardia_engine::BrowserEngine + ?Sized>(
    services: ardia_engine::Services<'_, E>,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        use ardia_engine::macos::dialogs::FilePanel;
        let consent = ardia_telemetry::consent_now();
        let chosen = FilePanel::save(PASSWORDS_FILE_NAME, &["csv"])
            .show(None)
            .await
            .map_err(|e| e.to_string())?;
        let Some(path) = chosen.into_iter().next() else {
            return Ok(json!({ "status": "cancelled" }));
        };
        let path = path.to_string_lossy().into_owned();
        let reply = services.passwords().export(&path).await.map_err(|e| {
            ardia_telemetry::counts::add_for(consent.as_ref(), "password_export_failures", 1);
            e.to_string()
        })?;
        let mut answer = reply.expose().clone();
        match answer.get("status").and_then(Value::as_str) {
            Some("succeeded") => {
                ardia_telemetry::counts::add_for(consent.as_ref(), "password_exports", 1)
            }
            Some("writeFailed") => {
                ardia_telemetry::counts::add_for(consent.as_ref(), "password_export_failures", 1)
            }
            _ => {}
        }
        if answer.get("path").is_none() {
            answer["path"] = Value::from(path);
        }
        Ok(answer)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = services;
        Err("exporting passwords isn't supported here yet".to_owned())
    }
}

fn note_password_list_shown(value: &Value, took: std::time::Duration) {
    let logins = value
        .as_array()
        .or_else(|| value.get("passwords").and_then(Value::as_array))
        .map_or(0, Vec::len);
    ardia_telemetry::counts::count("password_list_shows");
    if logins >= 1000 {
        ardia_telemetry::counts::count("password_list_large_shows");
    }
    if took.as_millis() >= 1000 {
        ardia_telemetry::counts::count("password_list_slow_shows");
    }
}

pub(crate) fn shaped_reply(query: &SettingsQuery, value: serde_json::Value) -> serde_json::Value {
    match query {
        SettingsQuery::Site(..) => match value.get("settings") {
            Some(settings) if settings.is_object() => settings.clone(),
            _ if value
                .as_object()
                .is_some_and(|fields| fields.contains_key("settings")) =>
            {
                serde_json::Value::Object(Default::default())
            }
            _ => value,
        },
        _ => value,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn site_replies_lose_their_settings_envelope() {
        let site = SettingsQuery::Site(
            ardia_state::ProfileId::from("p"),
            "https://a.example".into(),
        );
        let wrapped = serde_json::json!({ "settings": { "location": { "value": "ask", "isDefault": true } } });
        assert_eq!(
            super::shaped_reply(&site, wrapped),
            serde_json::json!({ "location": { "value": "ask", "isDefault": true } })
        );
        assert_eq!(
            super::shaped_reply(&site, serde_json::json!({ "settings": null })),
            serde_json::json!({})
        );
        let origins = SettingsQuery::SiteOrigins(ardia_state::ProfileId::from("p"));
        let listed = serde_json::json!({ "origins": ["https://a.example"] });
        assert_eq!(super::shaped_reply(&origins, listed.clone()), listed);
    }

    use super::*;

    #[test]
    fn logins_reduce_to_their_origin_like_the_old_import() {
        assert_eq!(origin_of_login("github.com/login"), "https://github.com");
        assert_eq!(
            origin_of_login("http://a.dev:8080/x?y"),
            "http://a.dev:8080"
        );
        assert_eq!(origin_of_login("//cdn.site"), "https://cdn.site");
        assert_eq!(origin_of_login("   "), "");
    }

    #[test]
    fn unlocking_lasts_five_minutes() {
        let mut services = SettingsServices::default();
        let profile = ProfileId::from("p".to_owned());
        let at = Instant::now();
        services.unlocked.insert(profile.clone(), at);
        assert!(services.unlocked(&profile, at + Duration::from_secs(60)));
        assert!(!services.unlocked(&profile, at + UNLOCK_FOR));
    }

    #[test]
    fn resetting_the_id_keeps_the_choice_and_drops_the_local_copy() {
        let dir = tempfile::tempdir().expect("dir");
        std::fs::write(
            dir.path().join(crate::sharing_doc::DOC),
            r#"{"version":2,"sharing":true,"installId":"old"}"#,
        )
        .expect("write");
        let local = dir.path().join("Telemetry").join("local");
        std::fs::create_dir_all(&local).expect("local");
        std::fs::write(local.join("app-2026-11-26.jsonl"), b"{}\n").expect("line");
        let reply = reset_install_id(dir.path()).expect("reset");
        let id = crate::sharing_doc::install_id(dir.path()).expect("an id");
        assert_ne!(id, "old");
        assert_eq!(reply["installId"], id);
        assert!(!local.exists());
        let doc: Value = serde_json::from_slice(
            &std::fs::read(dir.path().join(crate::sharing_doc::DOC)).expect("doc"),
        )
        .expect("json");
        assert_eq!(doc["sharing"], true);
    }

    #[test]
    fn local_copies_never_overwrite_an_earlier_one() {
        let dir = tempfile::tempdir().expect("dir");
        let first = local_copy_path(dir.path(), "2026-11-26");
        assert!(first.ends_with("Ardia data 2026-11-26.jsonl"));
        std::fs::write(&first, b"").expect("write");
        assert!(
            local_copy_path(dir.path(), "2026-11-26").ends_with("Ardia data 2026-11-26 2.jsonl")
        );
        let data = tempfile::tempdir().expect("data");
        let exported =
            export_local_copy(data.path(), dir.path(), 1_790_326_800_000, false).expect("export");
        assert_eq!(exported["lines"], 0);
    }

    #[test]
    fn forgetting_drops_cached_answers() {
        let mut services = SettingsServices::default();
        let query = SettingsQuery::Cards(ProfileId::from("p".to_owned()));
        services.values.insert(query.clone(), json!({"cards": []}));
        services.asked.insert(query.clone());
        services.forget(std::slice::from_ref(&query));
        assert!(!services.values.contains_key(&query));
        assert!(!services.asked.contains(&query));
    }
}
