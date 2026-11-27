use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use ardia_engine::{PermissionRequest, PermissionResult};
use ardia_state::windows::WindowKind;
use ardia_state::{Action, TabId};
use serde_json::{Value, json};

use super::services::{self, PageMessage, js_string, url_origin};
use super::site_answers::{self, NOTIFICATIONS};
use crate::coordinator::{AppCoordinator, ShellEffect};
use crate::notifications::{NotificationResponse, Notifier, RichNotification};

pub const REQUEST_PREFIX: &str = "wk-notify-";
pub const SHOWN_PER_SCOPE: usize = 50;
pub const POSTED_KEPT: usize = 400;
pub const ICON_TIMEOUT: Duration = Duration::from_secs(3);
pub const MAX_ICON_DATA_URI: usize = 1_049_600;

#[derive(Clone, Debug)]
struct Asked {
    tab: TabId,
    page_id: String,
    origin: String,
    profile: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ShownEntry {
    pub wire: String,
    pub profile: String,
    pub tag: String,
    pub scope: String,
    pub origin: String,
    pub entry: Value,
}

#[derive(Clone, Debug, PartialEq)]
struct Posted {
    engine: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkerNote {
    pub profile: String,
    pub origin: String,
    pub title: String,
    pub body: String,
    pub tag: String,
    pub silent: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WebNote {
    pub wire: String,
    pub title: String,
    pub body: String,
    pub icon: Option<String>,
    pub tag: String,
    pub silent: bool,
    pub origin: String,
}

#[derive(Default)]
struct Book {
    asked: HashMap<String, Asked>,
    shown: HashMap<String, Vec<ShownEntry>>,
    posted: HashMap<String, Posted>,
    sequence: u64,
    next_request: u64,
}

static BOOK: Mutex<Option<Book>> = Mutex::new(None);
static NOTIFIER: OnceLock<Arc<dyn Notifier>> = OnceLock::new();
static COORDINATOR: Mutex<Option<Weak<AppCoordinator>>> = Mutex::new(None);
static LAUNCH: OnceLock<String> = OnceLock::new();

fn with_book<R>(run: impl FnOnce(&mut Book) -> R) -> R {
    let mut slot = BOOK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    run(slot.get_or_insert_with(Book::default))
}

fn notifier() -> &'static Arc<dyn Notifier> {
    NOTIFIER.get_or_init(crate::notifications::system)
}

pub(crate) fn coordinator() -> Option<Arc<AppCoordinator>> {
    COORDINATOR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .and_then(Weak::upgrade)
}

fn launch() -> &'static str {
    LAUNCH.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let seed = format!("{nanos}-{}", std::process::id());
        use sha2::Digest as _;
        let digest = sha2::Sha256::digest(seed.as_bytes());
        digest[..4].iter().map(|b| format!("{b:02x}")).collect()
    })
}

fn hex(text: &str) -> String {
    text.bytes().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<String> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

pub fn mac_id(origin: &str, tag: &str, wire: &str) -> String {
    if tag.is_empty() {
        format!("web:{wire}")
    } else {
        format!("web:{origin}#{tag}")
    }
}

pub fn page_wire_id(tab: &TabId, id: &str) -> String {
    format!("wk-n{}-t{}-{id}", launch(), hex(tab.as_str()))
}

pub fn live_page(wire: &str) -> Option<(TabId, String)> {
    let rest = wire.strip_prefix(&format!("wk-n{}-t", launch()))?;
    let (tab, id) = rest.split_once('-')?;
    Some((TabId::from(unhex(tab)?.as_str()), id.to_owned()))
}

fn next_wire() -> String {
    let next = with_book(|book| {
        book.sequence += 1;
        book.sequence
    });
    format!("wk-n{}-{next}", launch())
}

pub fn reply_script(detail: &Value) -> String {
    format!(
        "document.dispatchEvent(new CustomEvent(\"ardia:notification-reply\", {{ detail: {} }}))",
        js_string(&detail.to_string())
    )
}

fn text(data: &Value, key: &str) -> String {
    data.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

pub fn scope_of(data: &Value, origin: &str) -> Option<String> {
    let raw = data.get("scope")?.as_str()?;
    let url = url::Url::parse(raw).ok()?;
    (url_origin(url.as_str()).as_deref() == Some(origin)).then(|| url.to_string())
}

fn shown_key(profile: &str, scope: &str) -> String {
    let store = if profile.contains('@') {
        format!("private@{}", profile.split('@').next().unwrap_or_default())
    } else {
        profile.to_owned()
    };
    format!("{store}|{scope}")
}

pub fn remember_shown(entry: ShownEntry) -> Option<String> {
    with_book(|book| {
        let key = shown_key(&entry.profile, &entry.scope);
        let mut replaced = None;
        if !entry.tag.is_empty()
            && let Some(old) = book
                .shown
                .get(&key)
                .and_then(|list| list.iter().find(|e| e.tag == entry.tag))
                .map(|e| e.wire.clone())
        {
            forget_in(book, &old);
            replaced = Some(old);
        }
        let list = book.shown.entry(key).or_default();
        list.retain(|e| e.wire != entry.wire);
        list.push(entry);
        if list.len() > SHOWN_PER_SCOPE {
            let extra = list.len() - SHOWN_PER_SCOPE;
            list.drain(..extra);
        }
        replaced
    })
}

fn forget_in(book: &mut Book, wire: &str) -> Option<ShownEntry> {
    let mut found = None;
    book.shown.retain(|_, list| {
        if let Some(at) = list.iter().position(|e| e.wire == wire) {
            found = Some(list.remove(at));
        }
        !list.is_empty()
    });
    found
}

pub fn forget_shown(wire: &str) -> Option<ShownEntry> {
    with_book(|book| forget_in(book, wire))
}

pub fn shows(wire: &str, profile: &str, origin: &str) -> bool {
    let site = format!("{}/", shown_key(profile, origin));
    with_book(|book| {
        book.shown
            .iter()
            .any(|(key, list)| key.starts_with(&site) && list.iter().any(|e| e.wire == wire))
    })
}

pub fn listed(profile: &str, scope: &str, tag: &str) -> Vec<Value> {
    with_book(|book| {
        book.shown
            .get(&shown_key(profile, scope))
            .map(|list| {
                list.iter()
                    .filter(|e| tag.is_empty() || e.tag == tag)
                    .map(|e| {
                        let mut entry = e.entry.clone();
                        if let Some(map) = entry.as_object_mut() {
                            map.insert("id".into(), Value::String(e.wire.clone()));
                        }
                        entry
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

fn note_posted(mac: &str, engine: &str) {
    with_book(|book| {
        if book.posted.len() >= POSTED_KEPT {
            book.posted.clear();
        }
        book.posted.insert(
            mac.to_owned(),
            Posted {
                engine: engine.to_owned(),
            },
        );
    });
}

fn posted_engine(mac: &str) -> Option<String> {
    with_book(|book| book.posted.get(mac).map(|p| p.engine.clone()))
}

pub fn count(name: &str) {
    super::telemetry::note_webkit_count(name);
}

pub fn prime(profile: &str) {
    if let Some(c) = coordinator() {
        let profile = profile.to_owned();
        c.post(move |c| c.prime_webkit_answers(&profile));
    }
}

pub fn site_label(origin: &str) -> String {
    url::Url::parse(origin)
        .ok()
        .and_then(|u| {
            let host = u.host_str()?.to_owned();
            Some(match u.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            })
        })
        .unwrap_or_else(|| origin.to_owned())
}

fn icon_bytes(icon: &str) -> Option<(Vec<u8>, &'static str)> {
    if let Some(rest) = icon.strip_prefix("data:image/") {
        if icon.len() > MAX_ICON_DATA_URI {
            return None;
        }
        let (header, payload) = rest.split_once(',')?;
        let subtype = header.split(';').next().unwrap_or_default();
        let bytes = if header.to_ascii_lowercase().ends_with(";base64") {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .decode(payload.trim())
                .ok()?
        } else {
            percent_decode(payload)
        };
        return Some((
            bytes,
            super::notification_hub::icon_extension(&format!("image/{subtype}"), ""),
        ));
    }
    None
}

pub const ICON_SIDE: u32 = 64;
pub const MAX_FETCHED_ICON_BYTES: usize = 2 * 1024 * 1024;

pub fn is_remote_icon(icon: &str) -> bool {
    icon.starts_with("https://") || icon.starts_with("http://")
}

pub fn icon_png(bytes: &[u8]) -> Option<Vec<u8>> {
    let source = image::load_from_memory(bytes).ok()?.to_rgba8();
    let (width, height) = source.dimensions();
    let longest = width.max(height);
    if longest == 0 {
        return None;
    }
    let side = ICON_SIDE.min(longest);
    let scale = side as f64 / longest as f64;
    let fitted_width = ((width as f64 * scale).round() as u32).clamp(1, side);
    let fitted_height = ((height as f64 * scale).round() as u32).clamp(1, side);
    let fitted = image::imageops::resize(
        &source,
        fitted_width,
        fitted_height,
        image::imageops::FilterType::CatmullRom,
    );
    let mut square = image::RgbaImage::new(side, side);
    image::imageops::overlay(
        &mut square,
        &fitted,
        i64::from((side - fitted_width) / 2),
        i64::from((side - fitted_height) / 2),
    );
    let mut png = std::io::Cursor::new(Vec::new());
    square.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(png.into_inner())
}

pub fn write_icon_file(id: &str, png: &[u8]) -> Option<PathBuf> {
    if png.is_empty() {
        return None;
    }
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let file = std::env::temp_dir().join(format!("ac-notification-{safe}.png"));
    std::fs::write(&file, png).ok()?;
    Some(file)
}

fn percent_decode(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%'
            && let Some(value) = text
                .get(at + 1..at + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(value);
            at += 3;
            continue;
        }
        out.push(bytes[at]);
        at += 1;
    }
    out
}

pub fn icon_file(id: &str, icon: &str) -> Option<PathBuf> {
    let (bytes, _) = icon_bytes(icon)?;
    if bytes.is_empty() || bytes.len() > super::notification_hub::MAX_ICON_BYTES {
        return None;
    }
    write_icon_file(id, &icon_png(&bytes)?)
}

pub fn fetched_icon_file(id: &str, bytes: Option<Vec<u8>>) -> Option<PathBuf> {
    let bytes = bytes.filter(|bytes| !bytes.is_empty() && bytes.len() <= MAX_FETCHED_ICON_BYTES)?;
    write_icon_file(id, &icon_png(&bytes)?)
}

pub fn worker_notification(
    note: WorkerNote,
    register: impl FnOnce(&WorkerNote, &str) -> Option<String> + 'static,
) {
    let Some(c) = coordinator() else {
        return;
    };
    let profile = note.profile.clone();
    let origin = note.origin.clone();
    c.load_webkit_answers(&profile, &origin, move |c| {
        if site_answers::answer(&note.profile, &note.origin, NOTIFICATIONS) != Some(true) {
            return;
        }
        let tab = c.webkit_notification_tab(&note.profile, &note.origin);
        let wire = next_wire();
        if let Some(replaced) = register(&note, &wire) {
            c.close_web_notification(&replaced);
        }
        count("workerShownNotification");
        if let Some(tab) = tab {
            c.show_web_notification(
                &tab,
                WebNote {
                    wire,
                    title: note.title,
                    body: note.body,
                    icon: None,
                    tag: note.tag,
                    silent: note.silent,
                    origin: note.origin,
                },
            );
        }
    });
}

pub fn open_worker_window(profile: &str, origin: Option<&str>, held: &str, url: &str) -> bool {
    let opener = origin
        .and_then(|origin| super::page::live_tab_for(profile, Some(origin)))
        .or_else(|| super::page::live_tab_for(profile, None));
    let Some((tab, sink)) = opener else {
        let Some(c) = coordinator() else {
            return false;
        };
        let (profile, held, url) = (profile.to_owned(), held.to_owned(), url.to_owned());
        c.post(move |c| c.open_worker_window_in_profile(&profile, &held, &url));
        return true;
    };
    sink(
        tab,
        super::WebKitEvent::OpenPopup {
            held: held.to_owned(),
            url: url.to_owned(),
            background: false,
        },
    );
    true
}

pub fn worker_window_for(
    state: &ardia_state::BrowserState,
    profile: &str,
) -> Option<(ardia_state::WindowId, ardia_state::ProfileId)> {
    let ordered = state.window_order.iter().chain(
        state
            .windows
            .keys()
            .filter(|id| !state.window_order.contains(id)),
    );
    for id in ordered {
        let Some(window) = state.window(id.as_str()) else {
            continue;
        };
        if window.kind == WindowKind::Main && state.engine_profile(&window.profile_id) == profile {
            return Some((id.clone(), window.profile_id.clone()));
        }
    }
    None
}

impl AppCoordinator {
    pub(crate) fn open_worker_window_in_profile(&self, profile: &str, held: &str, url: &str) {
        let state = self.store().snapshot();
        match worker_window_for(&state, profile) {
            Some((window, profile_id)) => {
                self.adopt_held_tab(window, profile_id, None, held, url.to_owned(), false)
            }
            None => super::page::drop_held(held),
        }
    }

    pub(crate) fn install_webkit_notifications(&self) {
        *COORDINATOR
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(self.weak());
        let me = self.weak();
        crate::notifications::install_responder(Arc::new(move |response| {
            if let Some(c) = me.upgrade() {
                c.post(move |c| {
                    c.handle_notification_response(&response);
                });
            }
        }));
    }

    fn webkit_notify_reply(&self, tab: &TabId, detail: Value) {
        services::run(tab, None, &reply_script(&detail), None);
    }

    fn webkit_tab_profile(&self, tab: &TabId) -> Option<(String, bool)> {
        let state = self.store().snapshot();
        let listed = state.tab(tab.as_str())?;
        Some((
            state.engine_profile(&listed.profile_id),
            listed.is_incognito(),
        ))
    }

    fn webkit_page_site(&self, tab: &TabId) -> Option<String> {
        services::page_url(tab).and_then(|url| url_origin(&url))
    }

    fn webkit_notification_tab(&self, profile: &str, origin: &str) -> Option<TabId> {
        let state = self.store().snapshot();
        let matching: Vec<&Arc<ardia_state::tabs::Tab>> = state
            .tabs
            .values()
            .filter(|tab| {
                state
                    .window(tab.window_id.as_str())
                    .is_some_and(|w| w.kind != WindowKind::Incognito)
                    && state.engine_profile(&tab.profile_id) == profile
                    && url_origin(&tab.url).as_deref() == Some(origin)
            })
            .collect();
        let active = matching.iter().find(|tab| {
            state
                .window(tab.window_id.as_str())
                .and_then(|w| w.active_tab())
                .is_some_and(|active| active == &tab.id)
        });
        active.or(matching.first()).map(|tab| tab.id.clone())
    }

    pub(crate) fn webkit_share_notification_permission(&self, tab: &TabId) {
        let Some(origin) = self.webkit_page_site(tab) else {
            return;
        };
        let Some((profile, _)) = self.webkit_tab_profile(tab) else {
            return;
        };
        let tab = tab.clone();
        self.load_webkit_answers(&profile.clone(), &origin.clone(), move |c| {
            if c.webkit_page_site(&tab).as_deref() != Some(origin.as_str()) {
                return;
            }
            let value = match site_answers::answer(&profile, &origin, NOTIFICATIONS) {
                Some(true) => "granted",
                Some(false) => "denied",
                None => "default",
            };
            log::debug!("{tab} shares notification permission {value} for {origin}");
            c.webkit_answers_changed(&profile, &origin);
            c.webkit_notify_reply(&tab, json!({ "type": "permission", "value": value }));
        });
    }

    pub(crate) fn webkit_notification(&self, tab: &TabId, message: &PageMessage) {
        let data = message.data.clone();
        let (Some(kind), Some(id)) = (
            data.get("type").and_then(Value::as_str).map(str::to_owned),
            data.get("id").and_then(Value::as_str).map(str::to_owned),
        ) else {
            return;
        };
        let page = self.webkit_page_site(tab);
        let Some(origin) = message.origin.clone().filter(|o| Some(o) == page.as_ref()) else {
            return;
        };
        let Some((profile, private)) = self.webkit_tab_profile(tab) else {
            return;
        };
        match kind.as_str() {
            "list" => {
                let items = scope_of(&data, &origin)
                    .map(|scope| listed(&profile, &scope, &text(&data, "tag")))
                    .unwrap_or_default();
                self.webkit_notify_reply(tab, json!({ "type": "list", "id": id, "items": items }));
            }
            "request" => self.request_webkit_notifications(tab, &id, &origin, &profile),
            "show" => {
                if private {
                    return;
                }
                let persistent = data.get("persistent").and_then(Value::as_bool) == Some(true);
                let scope = scope_of(&data, &origin);
                if persistent && scope.is_none() {
                    return;
                }
                let tab = tab.clone();
                self.load_webkit_answers(&profile.clone(), &origin.clone(), move |c| {
                    if site_answers::answer(&profile, &origin, NOTIFICATIONS) != Some(true)
                        || c.webkit_page_site(&tab).as_deref() != Some(origin.as_str())
                    {
                        return;
                    }
                    let wire = if persistent {
                        next_wire()
                    } else {
                        page_wire_id(&tab, &id)
                    };
                    if persistent && let Some(scope) = scope {
                        let entry = json!({
                            "title": text(&data, "title"),
                            "body": text(&data, "body"),
                            "icon": text(&data, "icon"),
                            "tag": text(&data, "tag"),
                            "data": data.get("data").cloned().unwrap_or(Value::Null),
                            "silent": data.get("silent").and_then(Value::as_bool).unwrap_or(false),
                            "requireInteraction": data.get("requireInteraction").and_then(Value::as_bool).unwrap_or(false),
                            "timestamp": data.get("timestamp").cloned().unwrap_or_else(|| json!(now_ms())),
                        });
                        let replaced = remember_shown(ShownEntry {
                            wire: wire.clone(),
                            profile: profile.clone(),
                            tag: text(&data, "tag"),
                            scope,
                            origin: origin.clone(),
                            entry,
                        });
                        if let Some(replaced) = replaced {
                            c.close_web_notification(&replaced);
                        }
                    }
                    let icon = Some(text(&data, "icon")).filter(|icon| !icon.is_empty());
                    c.show_web_notification(
                        &tab,
                        WebNote {
                            wire,
                            title: text(&data, "title"),
                            body: text(&data, "body"),
                            icon,
                            tag: text(&data, "tag"),
                            silent: data.get("silent").and_then(Value::as_bool).unwrap_or(false),
                            origin,
                        },
                    );
                    count(if persistent {
                        "workerNotification"
                    } else {
                        "notification"
                    });
                });
            }
            "close" => {
                let wire = if id.starts_with("wk-n") {
                    id.clone()
                } else {
                    page_wire_id(tab, &id)
                };
                if id.starts_with("wk-n") && !shows(&wire, &profile, &origin) {
                    return;
                }
                forget_shown(&wire);
                self.close_web_notification(&wire);
            }
            _ => {}
        }
    }

    fn request_webkit_notifications(&self, tab: &TabId, id: &str, origin: &str, profile: &str) {
        let tab = tab.clone();
        let id = id.to_owned();
        let origin = origin.to_owned();
        let profile = profile.to_owned();
        self.load_webkit_answers(&profile.clone(), &origin.clone(), move |c| {
            if let Some(decided) = site_answers::answer(&profile, &origin, NOTIFICATIONS) {
                c.webkit_answers_changed(&profile, &origin);
                let value = if decided { "granted" } else { "denied" };
                c.webkit_notify_reply(&tab, json!({ "type": "answer", "id": id, "value": value }));
                return;
            }
            let request_id = with_book(|book| {
                book.next_request += 1;
                let request_id = format!("{REQUEST_PREFIX}{}", book.next_request);
                book.asked.insert(
                    request_id.clone(),
                    Asked {
                        tab: tab.clone(),
                        page_id: id.clone(),
                        origin: origin.clone(),
                        profile: profile.clone(),
                    },
                );
                request_id
            });
            let request = PermissionRequest {
                id: request_id,
                origin,
                permissions: vec![NOTIFICATIONS.into()],
                extra: Default::default(),
            };
            if c.turned_down_unasked(&request) {
                return;
            }
            if c.bridge.lock().prompts.permission(&tab, &request) {
                c.publish_prompts(&tab);
            }
        });
    }

    pub(crate) fn webkit_resolve_notification_permission(
        &self,
        request_id: &str,
        result: PermissionResult,
        remember: bool,
    ) -> bool {
        if !request_id.starts_with(REQUEST_PREFIX) {
            return false;
        }
        let Some(asked) = with_book(|book| book.asked.remove(request_id)) else {
            return true;
        };
        let allowed = result == PermissionResult::Accept;
        if remember && result != PermissionResult::Dismiss {
            self.set_webkit_answer(&asked.profile, &asked.origin, NOTIFICATIONS, Some(allowed));
        }
        if self.webkit_page_site(&asked.tab).as_deref() == Some(asked.origin.as_str()) {
            let value = if allowed { "granted" } else { "denied" };
            self.webkit_notify_reply(
                &asked.tab,
                json!({ "type": "answer", "id": asked.page_id, "value": value }),
            );
        }
        true
    }

    pub(crate) fn show_web_notification(&self, tab: &TabId, note: WebNote) {
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        let private_window = state
            .window(listed.window_id.as_str())
            .is_none_or(|w| w.kind == WindowKind::Incognito);
        if private_window {
            self.act_on_web_notification(&note.wire, "close");
            return;
        }
        let mac = mac_id(&note.origin, &note.tag, &note.wire);
        note_posted(&mac, &note.wire);
        let rich = RichNotification {
            id: mac,
            title: note.title.clone(),
            body: note.body.clone(),
            subtitle: Some(site_label(&note.origin)),
            silent: note.silent || ardia_state::mute::silenced(&state, listed),
            icon: None,
            thread: Some(note.origin.clone()),
            dismissible: true,
            info: vec![
                ("tabId".into(), tab.to_string()),
                ("windowId".into(), listed.window_id.to_string()),
                ("origin".into(), note.origin.clone()),
                ("engineId".into(), note.wire.clone()),
            ],
        };
        let Some(icon) = note.icon else {
            notifier().post_rich(&rich);
            return;
        };
        let done = Arc::new(AtomicBool::new(false));
        let me = self.weak();
        let fetched_done = Arc::clone(&done);
        let fetched_rich = rich.clone();
        let fetched_me = me.clone();
        let fetch = if is_remote_icon(&icon) {
            match (self.engine(), self.engine_profile(&listed.profile_id)) {
                (Some(engine), Some(profile)) => {
                    Some(engine.fetch_icon(profile, &icon, MAX_FETCHED_ICON_BYTES))
                }
                _ => {
                    notifier().post_rich(&rich);
                    return;
                }
            }
        } else {
            None
        };
        let (bytes_sent, bytes_arrived) = std::sync::mpsc::channel::<Option<Vec<u8>>>();
        if let Some(reply) = fetch {
            self.spawn(async move {
                let _ = bytes_sent.send(reply.await.ok().flatten());
            });
        } else {
            drop(bytes_sent);
        }
        let spawned = std::thread::Builder::new()
            .name("ardia-notification-icon".into())
            .spawn(move || {
                let file = if is_remote_icon(&icon) {
                    let bytes = bytes_arrived.recv_timeout(ICON_TIMEOUT).ok().flatten();
                    fetched_icon_file(&fetched_rich.id, bytes)
                } else {
                    icon_file(&fetched_rich.id, &icon)
                };
                if fetched_done.swap(true, Ordering::AcqRel) {
                    return;
                }
                if let Some(c) = fetched_me.upgrade() {
                    c.post(move |_| {
                        if posted_engine(&fetched_rich.id).as_deref()
                            == fetched_rich
                                .info
                                .iter()
                                .find(|(k, _)| k == "engineId")
                                .map(|(_, v)| v.as_str())
                        {
                            notifier().post_rich(&RichNotification {
                                icon: file,
                                ..fetched_rich
                            });
                        }
                    });
                }
            });
        if spawned.is_err() {
            done.store(true, Ordering::Release);
            notifier().post_rich(&rich);
            return;
        }
        let _ = std::thread::Builder::new()
            .name("ardia-notification-icon-deadline".into())
            .spawn(move || {
                std::thread::sleep(ICON_TIMEOUT);
                if done.swap(true, Ordering::AcqRel) {
                    return;
                }
                if let Some(c) = me.upgrade() {
                    c.post(move |_| {
                        if posted_engine(&rich.id).is_some() {
                            notifier().post_rich(&rich);
                        }
                    });
                }
            });
    }

    pub(crate) fn close_web_notification(&self, engine: &str) {
        let macs: Vec<String> = with_book(|book| {
            let macs: Vec<String> = book
                .posted
                .iter()
                .filter(|(_, p)| p.engine == engine)
                .map(|(mac, _)| mac.clone())
                .collect();
            for mac in &macs {
                book.posted.remove(mac);
            }
            macs
        });
        if !macs.is_empty() {
            notifier().remove(&macs);
        }
    }

    pub(crate) fn handle_notification_response(&self, response: &NotificationResponse) -> bool {
        if !response.id.starts_with("web:") {
            return false;
        }
        let info: HashMap<&str, &str> = response
            .info
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let engine = info.get("engineId").map(|e| (*e).to_owned());
        if let Some(engine) = &engine
            && posted_engine(&response.id).as_deref() == Some(engine.as_str())
        {
            with_book(|book| book.posted.remove(&response.id));
        }
        let state = self.store().snapshot();
        let tab = info
            .get("tabId")
            .and_then(|tab| state.tab(tab))
            .map(|tab| (tab.id.clone(), tab.window_id.clone()));
        if let Some((tab, window)) = &tab
            && response.action == "click"
        {
            count("notificationClicked");
            ardia_telemetry::counts::count("web_notification_clicks");
            self.dispatch_quietly(Action::ActivateTab { tab: tab.clone() });
            self.effect(ShellEffect::FocusWindow {
                window: window.clone(),
            });
            self.mark_dirty();
        }
        if let Some(engine) = engine {
            self.act_on_web_notification(&engine, &response.action);
        }
        true
    }

    pub(crate) fn act_on_web_notification(&self, wire: &str, action: &str) {
        if super::notification_workers::act_worker(wire, action) {
            return;
        }
        if let Some(page) = forget_shown(wire) {
            super::notification_workers::act_persistent_page(
                &page.profile,
                &page.origin,
                &page.scope,
                page.entry
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                page.entry
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                &page.tag,
                action,
            );
            return;
        }
        if let Some((tab, id)) = live_page(wire) {
            let kind = if action == "click" { "click" } else { "close" };
            self.webkit_notify_reply(&tab, json!({ "type": kind, "id": id }));
        }
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_follow_the_old_scheme() {
        assert_eq!(mac_id("https://a.com", "t", "w"), "web:https://a.com#t");
        assert_eq!(mac_id("https://a.com", "", "w"), "web:w");
        let tab = TabId::from("tab-mw-1");
        let wire = page_wire_id(&tab, "3");
        assert!(wire.starts_with("wk-n"));
        assert_eq!(live_page(&wire), Some((tab, "3".to_owned())));
        assert_eq!(live_page("wk-n0000-7"), None);
        assert!(
            reply_script(&json!({ "type": "permission" })).contains("ardia:notification-reply")
        );
        assert_eq!(site_label("https://a.com:8443"), "a.com:8443");
    }

    #[test]
    fn persistent_page_notifications_are_listed_and_replaced_by_tag() {
        let entry = |wire: &str, tag: &str| ShownEntry {
            wire: wire.into(),
            profile: "w10-notify".into(),
            tag: tag.into(),
            scope: "https://a.com/app/".into(),
            origin: "https://a.com".into(),
            entry: json!({ "title": wire }),
        };
        assert_eq!(remember_shown(entry("wk-n1", "x")), None);
        assert_eq!(remember_shown(entry("wk-n2", "y")), None);
        assert_eq!(
            remember_shown(entry("wk-n3", "x")).as_deref(),
            Some("wk-n1")
        );
        let items = listed("w10-notify", "https://a.com/app/", "");
        assert_eq!(items.len(), 2);
        assert_eq!(items[1]["id"], "wk-n3");
        assert_eq!(listed("w10-notify", "https://a.com/app/", "y").len(), 1);
        assert!(shows("wk-n2", "w10-notify", "https://a.com"));
        assert!(!shows("wk-n2", "w10-notify", "https://b.com"));
        assert_eq!(forget_shown("wk-n2").map(|e| e.tag).as_deref(), Some("y"));
        assert!(!shows("wk-n2", "w10-notify", "https://a.com"));
        assert_eq!(
            scope_of(&json!({ "scope": "https://a.com/app/" }), "https://a.com").as_deref(),
            Some("https://a.com/app/")
        );
        assert_eq!(
            scope_of(&json!({ "scope": "https://b.com/" }), "https://a.com"),
            None
        );
    }

    #[test]
    fn data_uri_icons_become_files() {
        use base64::Engine as _;
        let wide = png_of(200, 100);
        let uri = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&wide)
        );
        let file = icon_file("web:x", &uri).unwrap();
        assert!(file.to_string_lossy().ends_with(".png"));
        let made = image::load_from_memory(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!((made.width(), made.height()), (ICON_SIDE, ICON_SIDE));
        let _ = std::fs::remove_file(file);
        assert!(icon_file("web:z", "data:image/png;base64,iVBORw0KGgo=").is_none());
        assert!(icon_file("web:y", "javascript:alert(1)").is_none());
        assert_eq!(percent_decode("a%20b"), b"a b");
    }

    fn png_of(width: u32, height: u32) -> Vec<u8> {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(width, height, image::Rgba([10, 20, 30, 255]))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        png.into_inner()
    }

    #[test]
    fn fetched_icons_are_fitted_like_the_old_favicon_store() {
        let small = image::load_from_memory(&icon_png(&png_of(16, 16)).unwrap()).unwrap();
        assert_eq!((small.width(), small.height()), (16, 16));
        let tall = image::load_from_memory(&icon_png(&png_of(50, 300)).unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!(tall.dimensions(), (64, 64));
        assert_eq!(tall.get_pixel(0, 32)[3], 0);
        assert_eq!(tall.get_pixel(32, 32)[3], 255);
        assert!(icon_png(b"not an image").is_none());
        assert!(fetched_icon_file("web:a", None).is_none());
        assert!(fetched_icon_file("web:b", Some(Vec::new())).is_none());
        assert!(fetched_icon_file("web:c", Some(vec![0; MAX_FETCHED_ICON_BYTES + 1])).is_none());
        let file = fetched_icon_file("web:d", Some(png_of(128, 128))).unwrap();
        let _ = std::fs::remove_file(file);
        assert!(is_remote_icon("https://a.example/i.png"));
        assert!(!is_remote_icon("data:image/png;base64,"));
    }

    #[test]
    fn worker_windows_open_in_the_first_main_window_of_the_profile() {
        use ardia_state::ids::IdGen;
        use ardia_state::persistence::session::{LoadOptions, SessionData};
        use ardia_state::{BrowserState, BrowserStore};
        let store = BrowserStore::in_memory(
            BrowserState::from_session(
                SessionData::fresh(LoadOptions::default()),
                1_795_000_000_000,
            ),
            IdGen::with_launch("w10n"),
        );
        let state = store.snapshot();
        assert!(worker_window_for(&state, "").is_none());
        let _ = store.dispatch(Action::OpenWindow {
            kind: WindowKind::Incognito,
            profile: None,
            url: None,
            frame: None,
        });
        let _ = store.dispatch(Action::OpenWindow {
            kind: WindowKind::Main,
            profile: None,
            url: None,
            frame: None,
        });
        let state = store.snapshot();
        let main = state
            .window_order
            .iter()
            .find(|id| {
                state
                    .window(id.as_str())
                    .is_some_and(|w| w.kind == WindowKind::Main)
            })
            .cloned()
            .unwrap();
        let profile = state.window(main.as_str()).unwrap().profile_id.clone();
        let engine = state.engine_profile(&profile);
        assert_eq!(worker_window_for(&state, &engine), Some((main, profile)));
        assert!(worker_window_for(&state, "someone-else").is_none());
    }
}
