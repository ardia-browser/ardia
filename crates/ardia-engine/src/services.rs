use std::ffi::CString;

use serde_json::{Value, json};
use zeroize::{Zeroize, Zeroizing};

use crate::BrowserEngine;
use crate::commands::GlobalCommand;
use crate::error::{EngineError, EngineResult};
use crate::reply::Reply;
use crate::types::{DevicePickerAction, EngineProfileId, EngineTabId};

pub const MAX_SERVICE_NAME: usize = 96;
pub const SECRET_SERVICES: &[&str] = &[
    "ac_autofill_card_number",
    "ac_autofill_import",
    "ac_autofill_save_card",
    "ac_passwords_add",
    "ac_passwords_export",
    "ac_passwords_logins",
    "ac_passwords_page_fill",
    "ac_passwords_page_submitted",
    "ac_passwords_page_update",
    "ac_passwords_replace",
    "ac_passwords_reveal",
    "ac_passwords_update",
];
pub const SECRET_REPLY_ERRORS: &[&str] = &[
    "Chrome didn't save the change",
    "Could not change the password",
    "No such address",
    "No such card",
    "No such password",
    "Not authenticated",
    "OS authentication is unavailable on this platform",
    "The password store didn't take the change",
    "address required",
    "an absolute path required",
    "bad arguments",
    "card required",
    "closed",
    "invalid number",
    "no autofill in this profile",
    "no password manager",
    "no password store",
    "not a web page",
    "origin and password required",
    "profile closed",
    "too many items in one call",
    "unreadable",
];
pub const SECRET_ERROR_FALLBACK: &str = "the engine refused the request";

include!(concat!(env!("OUT_DIR"), "/engine_services.rs"));

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ServiceName(String);

impl ServiceName {
    pub fn new(name: &str) -> EngineResult<Self> {
        let body = name.strip_prefix("ac_").filter(|body| !body.is_empty());
        let valid = name.len() <= MAX_SERVICE_NAME
            && !name.starts_with("ac_engine_")
            && body.is_some_and(|body| {
                body.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                    && !body.starts_with('_')
                    && !body.ends_with('_')
                    && !body.contains("__")
            });
        if valid {
            Ok(Self(name.to_owned()))
        } else {
            Err(EngineError::bad_argument(format!(
                "{name:?} isn't an engine service name"
            )))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_secret(&self) -> bool {
        SECRET_SERVICES.contains(&self.0.as_str())
    }

    pub fn is_registered(&self) -> bool {
        ENGINE_SERVICES.binary_search(&self.0.as_str()).is_ok()
    }
}

pub struct ServiceArgs {
    text: Zeroizing<String>,
    secret: bool,
}

impl ServiceArgs {
    pub fn empty() -> Self {
        Self {
            text: Zeroizing::new("{}".into()),
            secret: false,
        }
    }

    pub fn object(args: &Value) -> EngineResult<Self> {
        if !args.is_object() {
            return Err(EngineError::bad_argument(
                "engine service arguments must be a JSON object",
            ));
        }
        Ok(Self {
            text: Zeroizing::new(args.to_string()),
            secret: false,
        })
    }

    pub fn json(text: &str) -> EngineResult<Self> {
        Self::checked(Zeroizing::new(text.to_owned()), false)
    }

    pub fn secret(text: Zeroizing<String>) -> EngineResult<Self> {
        Self::checked(text, true)
    }

    fn checked(text: Zeroizing<String>, secret: bool) -> EngineResult<Self> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(Self {
                text: Zeroizing::new("{}".into()),
                secret,
            });
        }
        if !(trimmed.starts_with('{') && trimmed.ends_with('}')) {
            return Err(EngineError::bad_argument(
                "engine service arguments must be a JSON object",
            ));
        }
        Ok(Self { text, secret })
    }

    pub fn is_secret(&self) -> bool {
        self.secret
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn into_c_string(self) -> EngineResult<CString> {
        if self.text.as_bytes().contains(&0) {
            return Err(EngineError::bad_argument(
                "engine service arguments hold a NUL byte",
            ));
        }
        let mut bytes = Vec::with_capacity(self.text.len() + 1);
        bytes.extend_from_slice(self.text.as_bytes());
        Ok(CString::new(bytes).expect("NUL bytes were refused above"))
    }
}

pub fn reply_error(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    object.get("error")?.as_str()
}

pub fn parse_service_reply(service: &str, json: Option<&str>) -> EngineResult<Value> {
    decode_reply(service, json, false)
}

pub(crate) fn decode_reply(service: &str, json: Option<&str>, secret: bool) -> EngineResult<Value> {
    let json =
        json.ok_or_else(|| EngineError::BadReply(format!("{service} answered with nothing")))?;
    let mut value: Value =
        serde_json::from_str(json).map_err(|e| EngineError::BadReply(format!("{service}: {e}")))?;
    let failure = match reply_error(&value) {
        Some(message) if message == "unknown engine service" || message == "unknown call" => {
            EngineError::MissingService(service.to_owned())
        }
        Some(message) => EngineError::Service {
            service: service.to_owned(),
            message: if !secret || SECRET_REPLY_ERRORS.contains(&message) {
                message.to_owned()
            } else {
                SECRET_ERROR_FALLBACK.to_owned()
            },
        },
        None => return Ok(value),
    };
    if secret {
        wipe_value(&mut value);
    }
    Err(failure)
}

pub struct Services<'a, E: BrowserEngine + ?Sized> {
    engine: &'a E,
    profile_dir: &'a str,
}

impl<E: BrowserEngine + ?Sized> Clone for Services<'_, E> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<E: BrowserEngine + ?Sized> Copy for Services<'_, E> {}

macro_rules! domain {
    ($name:ident, $method:ident) => {
        pub struct $name<'a, E: BrowserEngine + ?Sized>(Services<'a, E>);

        impl<'a, E: BrowserEngine + ?Sized> Services<'a, E> {
            pub fn $method(self) -> $name<'a, E> {
                $name(self)
            }
        }
    };
}

domain!(Bookmarks, bookmarks);
domain!(History, history);
domain!(Passwords, passwords);
domain!(Autofill, autofill);
domain!(Downloads, downloads);
domain!(Extensions, extensions);
domain!(Search, search);
domain!(Permissions, permissions);
domain!(Sites, sites);
domain!(ContentBlocker, content_blocker);
domain!(Media, media);
domain!(EngineServices, engine);

impl<'a, E: BrowserEngine + ?Sized> Services<'a, E> {
    pub fn new(engine: &'a E, profile_dir: &'a str) -> Self {
        Self {
            engine,
            profile_dir,
        }
    }

    pub fn profile_dir(&self) -> &'a str {
        self.profile_dir
    }

    pub fn call(&self, name: &str, args: Value) -> Reply<Value> {
        match ServiceArgs::object(&args) {
            Ok(args) => self
                .engine
                .call_service(name, self.profile_dir, args.as_str()),
            Err(error) => Reply::err(error),
        }
    }

    pub fn call_secret(&self, name: &str, args: Value) -> Reply<SecretValue> {
        if !args.is_object() {
            return Reply::err(EngineError::bad_argument(
                "engine service arguments must be a JSON object",
            ));
        }
        let mut args = args;
        let text = Zeroizing::new(args.to_string());
        wipe_value(&mut args);
        self.engine
            .call_service_secret(name, self.profile_dir, text)
    }
}

pub struct SecretValue(Value);

impl SecretValue {
    pub fn new(value: Value) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &Value {
        &self.0
    }
}

impl std::ops::Deref for SecretValue {
    type Target = Value;

    fn deref(&self) -> &Value {
        &self.0
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        wipe_value(&mut self.0);
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretValue(…)")
    }
}

impl PartialEq for SecretValue {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

pub(crate) fn wipe_value(value: &mut Value) {
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(items) => items.iter_mut().for_each(wipe_value),
        Value::Object(map) => map.values_mut().for_each(wipe_value),
        _ => {}
    }
}

impl<E: BrowserEngine + ?Sized> Bookmarks<'_, E> {
    pub fn tree(&self) -> Reply<Value> {
        self.0.call("ac_bookmarks_tree", json!({}))
    }

    pub fn apply(&self, ops: Value) -> Reply<Value> {
        self.0.call("ac_bookmarks_apply", json!({ "ops": ops }))
    }

    pub fn watch(&self) -> Reply<Value> {
        self.0.call("ac_bookmarks_watch", json!({}))
    }

    pub fn export_html(&self, path: &str) -> Reply<Value> {
        self.0
            .call("ac_bookmarks_export_html", json!({ "path": path }))
    }
}

impl<E: BrowserEngine + ?Sized> History<'_, E> {
    pub fn query(&self, max_urls: u32, max_visits: u32) -> Reply<Value> {
        self.0.call(
            "ac_history_query",
            json!({ "maxUrls": max_urls, "maxVisits": max_visits }),
        )
    }

    pub fn add(&self, pages: Value, tolerance_ms: f64) -> Reply<Value> {
        self.0.call(
            "ac_history_add",
            json!({ "pages": pages, "toleranceMs": tolerance_ms }),
        )
    }

    pub fn import(&self, rows: Value) -> Reply<Value> {
        self.0.call("ac_history_import", json!({ "rows": rows }))
    }

    pub fn delete_urls(&self, urls: &[String]) -> Reply<Value> {
        self.0
            .call("ac_history_delete_urls", json!({ "urls": urls }))
    }

    pub fn watch(&self) -> Reply<Value> {
        self.0.call("ac_history_watch", json!({}))
    }
}

impl<E: BrowserEngine + ?Sized> Passwords<'_, E> {
    pub fn list(&self) -> Reply<Value> {
        self.0.call("ac_passwords_list", json!({}))
    }

    pub fn unlock(&self) -> Reply<Value> {
        self.0.call("ac_passwords_unlock", json!({}))
    }

    pub fn reveal(&self, origin: &str, username: &str) -> Reply<SecretValue> {
        self.0.call_secret(
            "ac_passwords_reveal",
            json!({ "origin": origin, "username": username }),
        )
    }

    pub fn add(
        &self,
        origin: &str,
        username: &str,
        password: Zeroizing<String>,
    ) -> Reply<SecretValue> {
        self.0.call_secret(
            "ac_passwords_add",
            json!({ "origin": origin, "username": username, "password": password.as_str() }),
        )
    }

    pub fn update(
        &self,
        origin: &str,
        username: &str,
        new_username: Option<&str>,
        password: Zeroizing<String>,
    ) -> Reply<SecretValue> {
        let mut args =
            json!({ "origin": origin, "username": username, "password": password.as_str() });
        if let Some(new_username) = new_username {
            args["newUsername"] = json!(new_username);
        }
        self.0.call_secret("ac_passwords_update", args)
    }

    pub fn remove(&self, origin: &str, username: &str) -> Reply<Value> {
        self.0.call(
            "ac_passwords_remove",
            json!({ "origin": origin, "username": username }),
        )
    }

    pub fn exceptions(&self) -> Reply<Value> {
        self.0.call("ac_passwords_exceptions", json!({}))
    }

    pub fn allow(&self, origin: &str) -> Reply<Value> {
        self.0
            .call("ac_passwords_allow", json!({ "origin": origin }))
    }

    pub fn export(&self, path: &str) -> Reply<SecretValue> {
        self.0
            .call_secret("ac_passwords_export", json!({ "path": path }))
    }
}

impl<E: BrowserEngine + ?Sized> Autofill<'_, E> {
    pub fn addresses(&self) -> Reply<Value> {
        self.0.call("ac_autofill_addresses", json!({}))
    }

    pub fn cards(&self) -> Reply<Value> {
        self.0.call("ac_autofill_cards", json!({}))
    }

    pub fn card_number(&self, id: &str) -> Reply<SecretValue> {
        self.0
            .call_secret("ac_autofill_card_number", json!({ "id": id }))
    }

    pub fn save_address(&self, address: Value) -> Reply<Value> {
        self.0
            .call("ac_autofill_save_address", json!({ "address": address }))
    }

    pub fn save_card(&self, card: Value) -> Reply<SecretValue> {
        self.0
            .call_secret("ac_autofill_save_card", json!({ "card": card }))
    }

    pub fn remove(&self, id: &str) -> Reply<Value> {
        self.0.call("ac_autofill_remove", json!({ "id": id }))
    }

    pub fn import(&self, data: Value) -> Reply<SecretValue> {
        self.0.call_secret("ac_autofill_import", data)
    }
}

impl<E: BrowserEngine + ?Sized> Downloads<'_, E> {
    pub fn list(&self) -> Reply<Value> {
        self.0.call("ac_downloads_list", json!({}))
    }

    pub fn settings(&self) -> Reply<Value> {
        self.0.call("ac_downloads_settings", json!({}))
    }

    pub fn set_settings(
        &self,
        folder: Option<&str>,
        ask_where_to_save: Option<bool>,
    ) -> Reply<Value> {
        let mut args = json!({});
        if let Some(folder) = folder {
            args["folder"] = json!(folder);
        }
        if let Some(ask) = ask_where_to_save {
            args["askWhereToSave"] = json!(ask);
        }
        self.0.call("ac_downloads_set_settings", args)
    }

    pub fn command(&self, id: &str, command: DownloadCommand) -> Reply<Value> {
        self.0.call(
            "ac_downloads_command",
            json!({ "id": id, "command": command.as_str() }),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DownloadCommand {
    Cancel,
    Pause,
    Resume,
    Keep,
}

impl DownloadCommand {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cancel => "cancel",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::Keep => "keep",
        }
    }
}

impl<E: BrowserEngine + ?Sized> Extensions<'_, E> {
    pub fn list(&self) -> Reply<Value> {
        self.0.call("ac_extensions_list", json!({}))
    }

    pub fn install(&self, path: &str) -> Reply<Value> {
        self.0
            .call("ac_extensions_install", json!({ "path": path }))
    }

    pub fn install_crx(&self, path: &str) -> Reply<Value> {
        self.0
            .call("ac_extensions_install_crx", json!({ "path": path }))
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Reply<Value> {
        self.0.call(
            "ac_extensions_set_enabled",
            json!({ "id": id, "enabled": enabled }),
        )
    }

    pub fn uninstall(&self, id: &str) -> Reply<Value> {
        self.0.call("ac_extensions_uninstall", json!({ "id": id }))
    }

    pub fn reload(&self, id: &str) -> Reply<Value> {
        self.0.call("ac_extensions_reload", json!({ "id": id }))
    }

    pub fn configure(&self, id: &str, options: Value) -> Reply<Value> {
        self.0.call(
            "ac_extensions_configure",
            json!({ "id": id, "options": options }),
        )
    }

    pub fn watch_actions(&self) -> Reply<Value> {
        self.0.call("ac_extensions_watch_actions", json!({}))
    }

    pub fn sync_state(&self) -> Reply<Value> {
        self.0.call("ac_extensions_sync_state", json!({}))
    }

    pub fn sync_apply(&self, plan: Value) -> Reply<Value> {
        self.0.call("ac_extensions_sync_apply", plan)
    }

    pub fn load_health(&self) -> Reply<Value> {
        self.0.call("ac_extensions_load_health", json!({}))
    }
}

impl<E: BrowserEngine + ?Sized> Search<'_, E> {
    pub fn engines(&self) -> Reply<Value> {
        self.0.call("ac_search_engines_list", json!({}))
    }

    pub fn suggest(&self, url: &str, id: u32) -> Reply<Value> {
        self.0
            .call("ac_search_suggest", json!({ "url": url, "id": id }))
    }

    pub fn stop_suggest(&self, id: u32) -> Reply<Value> {
        self.0.call("ac_search_suggest_stop", json!({ "id": id }))
    }
}

impl<E: BrowserEngine + ?Sized> Permissions<'_, E> {
    pub fn external_app_allowances(&self) -> Reply<Value> {
        self.0.call("ac_external_apps_allowances", json!({}))
    }

    pub fn remove_external_app_allowance(&self, origin: &str, scheme: &str) -> Reply<Value> {
        self.0.call(
            "ac_external_apps_remove",
            json!({ "origin": origin, "scheme": scheme }),
        )
    }
}

impl<E: BrowserEngine + ?Sized> Sites<'_, E> {
    pub fn settings(&self, origin: &str) -> Reply<Value> {
        self.0
            .call("ac_site_settings_get", json!({ "origin": origin }))
    }

    pub fn set_setting(&self, origin: &str, kind: &str, value: &str) -> Reply<Value> {
        self.0.call(
            "ac_site_settings_set",
            json!({ "origin": origin, "type": kind, "value": value }),
        )
    }

    pub fn origins(&self) -> Reply<Value> {
        self.0.call("ac_site_settings_origins", json!({}))
    }

    pub fn reset(&self, origin: &str) -> Reply<Value> {
        self.0
            .call("ac_site_settings_reset", json!({ "origin": origin }))
    }

    pub fn clear_data(&self, origin: &str) -> Reply<Value> {
        self.0
            .call("ac_site_data_clear", json!({ "origin": origin }))
    }

    pub fn zoom_levels(&self) -> Reply<Value> {
        self.0.call("ac_zoom_list", json!({}))
    }

    pub fn set_zoom(&self, host: &str, level: f64) -> Reply<Value> {
        self.0
            .call("ac_zoom_set", json!({ "host": host, "level": level }))
    }

    pub fn read_storage(&self, origin: &str) -> Reply<Value> {
        self.0
            .call("ac_local_storage_read", json!({ "origin": origin }))
    }

    pub fn write_storage(&self, origin: &str, set: Value, remove: &[String]) -> Reply<Value> {
        self.0.call(
            "ac_local_storage_write",
            json!({ "origin": origin, "set": set, "remove": remove }),
        )
    }

    pub fn registrable_domains(&self, hosts: &[String]) -> Reply<Value> {
        self.0
            .call("ac_registrable_domains", json!({ "hosts": hosts }))
    }
}

impl<E: BrowserEngine + ?Sized> ContentBlocker<'_, E> {
    pub fn dynamic_rules(&self, extension_id: &str) -> Reply<Value> {
        self.0.call(
            "ac_extension_dnr_get_dynamic_rules",
            json!({ "id": extension_id }),
        )
    }

    pub fn session_rules(&self, extension_id: &str) -> Reply<Value> {
        self.0.call(
            "ac_extension_dnr_get_session_rules",
            json!({ "id": extension_id }),
        )
    }

    pub fn enabled_rulesets(&self, extension_id: &str) -> Reply<Value> {
        self.0.call(
            "ac_extension_dnr_get_enabled_rulesets",
            json!({ "id": extension_id }),
        )
    }

    pub fn disabled_rule_ids(&self, extension_id: &str, options: Value) -> Reply<Value> {
        self.0.call(
            "ac_extension_dnr_get_disabled_rule_ids",
            json!({ "id": extension_id, "options": options }),
        )
    }

    pub fn update_dynamic_rules(&self, extension_id: &str, options: Value) -> Reply<Value> {
        self.0.call(
            "ac_extension_dnr_update_dynamic_rules",
            json!({ "id": extension_id, "options": options }),
        )
    }

    pub fn update_session_rules(&self, extension_id: &str, options: Value) -> Reply<Value> {
        self.0.call(
            "ac_extension_dnr_update_session_rules",
            json!({ "id": extension_id, "options": options }),
        )
    }

    pub fn update_enabled_rulesets(&self, extension_id: &str, options: Value) -> Reply<Value> {
        self.0.call(
            "ac_extension_dnr_update_enabled_rulesets",
            json!({ "id": extension_id, "options": options }),
        )
    }

    pub fn update_static_rules(&self, extension_id: &str, options: Value) -> Reply<Value> {
        self.0.call(
            "ac_extension_dnr_update_static_rules",
            json!({ "id": extension_id, "options": options }),
        )
    }

    pub fn watch(&self, extension_id: &str, on: bool) -> Reply<Value> {
        self.0.call(
            "ac_extension_dnr_watch",
            json!({ "id": extension_id, "on": on }),
        )
    }
}

impl<E: BrowserEngine + ?Sized> Media<'_, E> {
    pub fn select_device(&self, chooser_id: i32, index: i32) -> EngineResult<()> {
        self.0
            .engine
            .global(GlobalCommand::SelectDevice { chooser_id, index })
    }

    pub fn device_chooser(&self, chooser_id: i32, action: DevicePickerAction) -> EngineResult<()> {
        self.0
            .engine
            .global(GlobalCommand::DeviceChooserAction { chooser_id, action })
    }

    pub fn start_casting(&self, dialog_id: i32, sink_id: &str, mode: i32) -> EngineResult<()> {
        self.0.engine.global(GlobalCommand::StartCasting {
            dialog_id,
            sink_id: sink_id.to_owned(),
            mode,
        })
    }

    pub fn stop_casting(&self, dialog_id: i32, route_id: &str) -> EngineResult<()> {
        self.0.engine.global(GlobalCommand::StopCasting {
            dialog_id,
            route_id: route_id.to_owned(),
        })
    }

    pub fn close_cast_dialog(&self, dialog_id: i32) -> EngineResult<()> {
        self.0
            .engine
            .global(GlobalCommand::CloseCastDialog { dialog_id })
    }

    pub fn terminate_cast_route(&self, route_id: &str) -> EngineResult<()> {
        self.0.engine.global(GlobalCommand::TerminateCastRoute {
            route_id: route_id.to_owned(),
        })
    }

    pub fn watch_cast_routes(&self, profile: EngineProfileId) -> EngineResult<()> {
        self.0
            .engine
            .profile_command(profile, crate::commands::ProfileCommand::WatchCastRoutes)
    }

    pub fn allow_desktop_capture(
        &self,
        source_id: &str,
        tab: EngineTabId,
        frame: Option<&str>,
        origin: Option<&str>,
        audio: Option<&str>,
    ) -> EngineResult<()> {
        self.0.engine.global(GlobalCommand::AllowDesktopCapture {
            source_id: source_id.to_owned(),
            tab,
            frame: frame.map(str::to_owned),
            origin: origin.map(str::to_owned),
            audio: audio.map(str::to_owned),
        })
    }
}

impl<E: BrowserEngine + ?Sized> EngineServices<'_, E> {
    pub fn tasks(&self) -> Reply<Value> {
        self.0.call("ac_tasks_list", json!({}))
    }

    pub fn components(&self) -> Reply<Value> {
        self.0.call("ac_components_list", json!({}))
    }

    pub fn trim_memory(&self) -> Reply<Value> {
        self.0.call("ac_memory_trim", json!({}))
    }

    pub fn memory_saver(&self, request: Value) -> Reply<Value> {
        self.0.call("ac_memory_saver", request)
    }

    pub fn battery_saver(&self, mode: &str) -> Reply<Value> {
        self.0.call("ac_battery_saver", json!({ "mode": mode }))
    }

    pub fn open_task_manager(&self) -> Reply<Value> {
        self.0.call("ac_task_manager_open", json!({}))
    }

    pub fn tab_history_generation(&self) -> Reply<Value> {
        self.0.call("ac_tab_history_generation", json!({}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_services_are_real_and_their_errors_stay_generic() {
        for name in SECRET_SERVICES {
            let name = ServiceName::new(name).unwrap();
            assert!(
                name.is_registered(),
                "{} isn't an engine service",
                name.as_str()
            );
            assert!(name.is_secret());
        }
        assert!(!ServiceName::new("ac_passwords_list").unwrap().is_secret());
        let known = decode_reply(
            "ac_passwords_reveal",
            Some("{\"error\":\"Not authenticated\"}"),
            true,
        );
        assert_eq!(
            known,
            Err(EngineError::Service {
                service: "ac_passwords_reveal".into(),
                message: "Not authenticated".into()
            })
        );
        let echoed = decode_reply(
            "ac_passwords_reveal",
            Some("{\"error\":\"hunter2 is wrong\"}"),
            true,
        );
        assert_eq!(
            echoed,
            Err(EngineError::Service {
                service: "ac_passwords_reveal".into(),
                message: SECRET_ERROR_FALLBACK.into()
            })
        );
        assert_eq!(
            decode_reply("ac_tasks_list", Some("{\"error\":\"busy now\"}"), false),
            Err(EngineError::Service {
                service: "ac_tasks_list".into(),
                message: "busy now".into()
            })
        );
    }

    #[test]
    fn service_names_are_strictly_engine_symbols() {
        for good in [
            "ac_bookmarks_tree",
            "ac_tasks_list",
            "ac_x",
            "ac_extension_dnr_get_dynamic_rules",
            "ac_a1_b2",
        ] {
            assert!(ServiceName::new(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "ac_",
            "system",
            "dlopen",
            "ac_Bookmarks",
            "ac__x",
            "ac_x_",
            "ac_x__y",
            "ac_../x",
            "ac_x\0",
            "AC_X",
            " ac_x",
            &format!("ac_{}", "a".repeat(MAX_SERVICE_NAME)),
        ] {
            assert!(ServiceName::new(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_registry_holds_exactly_the_engine_services() {
        assert!(ENGINE_SERVICES.len() > 100);
        assert!(ENGINE_SERVICES.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(
            ENGINE_SERVICES
                .iter()
                .all(|name| ServiceName::new(name).is_ok())
        );
        for known in [
            "ac_bookmarks_tree",
            "ac_history_query",
            "ac_passwords_reveal",
            "ac_tab_diagnostics",
            "ac_tasks_list",
        ] {
            assert!(ServiceName::new(known).unwrap().is_registered(), "{known}");
        }
        assert!(
            !ServiceName::new("ac_not_a_service")
                .unwrap()
                .is_registered()
        );
        for entry_point in ["ac_engine_set_event_sink", "ac_engine_call"] {
            assert!(ServiceName::new(entry_point).is_err(), "{entry_point}");
            assert!(!ENGINE_SERVICES.contains(&entry_point));
        }
    }

    #[test]
    fn args_must_be_objects_without_nul() {
        assert_eq!(ServiceArgs::json("").unwrap().as_str(), "{}");
        assert_eq!(ServiceArgs::json("  ").unwrap().as_str(), "{}");
        assert!(ServiceArgs::json("[1]").is_err());
        assert!(ServiceArgs::json("1").is_err());
        assert!(ServiceArgs::object(&json!([1])).is_err());
        assert!(
            ServiceArgs::json("{\"a\":\"\0\"}")
                .unwrap()
                .into_c_string()
                .is_err()
        );
        let secret = ServiceArgs::secret(Zeroizing::new("{\"password\":\"p\"}".into())).unwrap();
        assert!(secret.is_secret());
        assert_eq!(
            secret.into_c_string().unwrap().to_str().unwrap(),
            "{\"password\":\"p\"}"
        );
    }

    #[test]
    fn replies_split_errors_from_results() {
        assert_eq!(
            parse_service_reply("ac_a", Some("{\"ok\":true}")),
            Ok(json!({"ok": true}))
        );
        assert_eq!(
            parse_service_reply("ac_a", Some("{\"error\":\"profile went away\"}")),
            Err(EngineError::Service {
                service: "ac_a".into(),
                message: "profile went away".into()
            })
        );
        assert_eq!(
            parse_service_reply("ac_a", Some("{\"error\":\"unknown engine service\"}")),
            Err(EngineError::MissingService("ac_a".into()))
        );
        assert_eq!(
            parse_service_reply("ac_a", Some("{\"error\":\"x\",\"items\":[]}")),
            Ok(json!({"error": "x", "items": []}))
        );
        assert_eq!(parse_service_reply("ac_a", Some("[]")), Ok(json!([])));
        assert!(matches!(
            parse_service_reply("ac_a", None),
            Err(EngineError::BadReply(_))
        ));
        assert!(matches!(
            parse_service_reply("ac_a", Some("{")),
            Err(EngineError::BadReply(_))
        ));
    }

    #[test]
    fn wiping_clears_nested_strings() {
        let mut value = json!({"password": "hunter2", "list": ["a", {"b": "c"}], "n": 1});
        wipe_value(&mut value);
        assert_eq!(
            value,
            json!({"password": "", "list": ["", {"b": ""}], "n": 1})
        );
    }
}
