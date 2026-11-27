use std::collections::HashSet;

use ardia_state::actions::{Action, NewTab};
use ardia_state::sync::SyncDoc;
use ardia_state::sync_engine::scope::{Adapter, ApplyRecords, ExtractContext, Extraction};
use ardia_state::sync_engine::{IndexMap, IndexSet};
use ardia_state::windows::{Toast, ToastKind, WindowKind};
use ardia_state::{BrowserState, ProfileId, TabId, WindowId};
use serde_json::{Map, Value, json};

use super::{CycleContext, DEVICE, DEVICE_TABS, SEND};
use crate::sync_engine::files::{Scopes, profile_scope};
use crate::sync_engine::summary;
use ardia_ui::sync_api::{DeviceKind, device_label, device_symbol};

pub const MAX_DEVICE_TABS: usize = 30;
pub const SEND_KEPT_MS: i64 = 7 * 86_400_000;
pub const RECEIVED_KEPT_MS: i64 = 90 * 86_400_000;
pub const MAX_SENT_URL: usize = 8_192;
pub const MAX_SENT_TITLE: usize = 500;
pub const SHOW_TAB_ACTION: &str = "showSyncedTab:";

pub fn is_web_page_url(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("file:")
}

pub fn sendable_url(url: &str) -> bool {
    if url.len() > MAX_SENT_URL {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    rest.and_then(|r| r.chars().next())
        .is_some_and(|c| !c.is_whitespace())
}

#[derive(Clone, Debug, PartialEq)]
pub struct SendRecord {
    pub u: String,
    pub t: String,
    pub to: String,
    pub from: String,
    pub at: i64,
}

impl SendRecord {
    pub fn to_value(&self) -> Value {
        json!({ "u": self.u, "t": self.t, "to": self.to, "from": self.from, "at": self.at })
    }
}

pub fn send_record(value: Option<&Value>) -> Option<SendRecord> {
    let v = value?.as_object()?;
    let to = v.get("to")?.as_str()?.to_owned();
    let from = v.get("from")?.as_str()?.to_owned();
    let u = v
        .get("u")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let t: String = v
        .get("t")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .encode_utf16()
        .take(MAX_SENT_TITLE)
        .collect::<Vec<u16>>()
        .pipe_utf16();
    let at = v
        .get("at")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map_or(0, |n| n as i64);
    Some(SendRecord { u, t, to, from, at })
}

trait PipeUtf16 {
    fn pipe_utf16(self) -> String;
}

impl PipeUtf16 for Vec<u16> {
    fn pipe_utf16(self) -> String {
        String::from_utf16_lossy(&self)
    }
}

pub struct DeviceTabsAdapter {
    cx: CycleContext,
    profile: ProfileId,
    key: String,
    retired: bool,
}

impl DeviceTabsAdapter {
    pub fn new(cx: &CycleContext, profile: &ProfileId, retired: bool) -> Self {
        DeviceTabsAdapter {
            cx: cx.clone(),
            profile: profile.clone(),
            key: format!("{DEVICE_TABS}{}", cx.device_id),
            retired,
        }
    }
}

pub fn device_tabs_value(state: &BrowserState, profile: &ProfileId, name: &str) -> Value {
    let mut open: Vec<&std::sync::Arc<ardia_state::tabs::Tab>> = state
        .tabs
        .values()
        .filter(|t| {
            t.profile_id == *profile
                && t.pin.is_none()
                && !t.page.is_asleep()
                && is_web_page_url(&t.url)
                && state
                    .windows
                    .get(&t.window_id)
                    .is_some_and(|w| w.kind != WindowKind::Incognito)
                && !t.live.peek
        })
        .collect();
    open.sort_by_key(|t| std::cmp::Reverse(t.last_active_at));
    let tabs: Vec<Value> = open
        .into_iter()
        .take(MAX_DEVICE_TABS)
        .map(|t| json!({ "u": t.url, "t": t.custom_title.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| t.title.clone()) }))
        .collect();
    json!({ "n": name, "tabs": tabs })
}

impl Adapter for DeviceTabsAdapter {
    fn prefix(&self) -> &str {
        DEVICE_TABS
    }

    fn extract(&mut self, _cx: &ExtractContext) -> Option<Extraction> {
        let mine = self.key.clone();
        let mut values = IndexMap::new();
        if !self.retired {
            values.insert(
                self.key.clone(),
                device_tabs_value(&self.cx.host.state(), &self.profile, &self.cx.device_name),
            );
        }
        Some(Extraction::of(values).ignoring(move |key| key != mine))
    }

    fn apply(
        &mut self,
        _visible: &IndexMap<String, Value>,
        _changed: &IndexSet<String>,
        _records: &ApplyRecords,
    ) -> bool {
        true
    }
}

fn ledger_of(doc: &SyncDoc, scope: &str) -> (Map<String, Value>, Map<String, Value>) {
    let ledger = doc.extra.get("sends").and_then(|s| s.get(scope));
    let outgoing = ledger
        .and_then(|l| l.get("outgoing"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let received = ledger
        .and_then(|l| l.get("received"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    (outgoing, received)
}

fn store_ledger(
    doc: &mut SyncDoc,
    scope: &str,
    outgoing: Map<String, Value>,
    received: Map<String, Value>,
) {
    let mut sends = doc
        .extra
        .get("sends")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    sends.insert(
        scope.to_owned(),
        json!({ "outgoing": outgoing, "received": received }),
    );
    doc.extra.insert("sends".into(), Value::Object(sends));
}

pub fn queue_send(
    doc: &mut SyncDoc,
    scopes: &Scopes,
    state: &BrowserState,
    tab: &TabId,
    device: &str,
    now: i64,
) -> bool {
    let Some(tab) = state.tab(tab.as_str()) else {
        return false;
    };
    let Some(link) = doc.profiles.get(tab.profile_id.as_str()).cloned() else {
        return false;
    };
    let Some(me) = doc.device_id.clone() else {
        return false;
    };
    if !sendable_url(&tab.url)
        || !summary::send_targets(doc, scopes, &tab.profile_id, now)
            .iter()
            .any(|d| d.id == device)
    {
        return false;
    }
    let title = tab
        .custom_title
        .clone()
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| tab.title.clone());
    let send = SendRecord {
        u: tab.url.clone(),
        t: title,
        to: device.to_owned(),
        from: me,
        at: now,
    };
    let scope = profile_scope(&link.sync_id);
    let (mut outgoing, received) = ledger_of(doc, &scope);
    outgoing.insert(
        format!("{SEND}{}", uuid::Uuid::new_v4().hyphenated()),
        send.to_value(),
    );
    store_ledger(doc, &scope, outgoing, received);
    true
}

pub fn record_open_tab_closes(doc: &mut SyncDoc, closes: &[(ProfileId, String)]) -> bool {
    let mut all = doc
        .extra
        .get("tabCloses")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut changed = false;
    for (profile, key) in closes {
        let Some(link) = doc.profiles.get(profile.as_str()) else {
            continue;
        };
        let scope = profile_scope(&link.sync_id);
        let list = all.entry(scope).or_insert_with(|| json!([]));
        if let Some(list) = list.as_array_mut()
            && !list.iter().any(|k| k.as_str() == Some(key))
        {
            list.push(Value::String(key.clone()));
            changed = true;
        }
    }
    if changed {
        doc.extra.insert("tabCloses".into(), Value::Object(all));
    }
    changed
}

pub struct SentTabsAdapter {
    cx: CycleContext,
    profile: ProfileId,
    scope: String,
}

impl SentTabsAdapter {
    pub fn new(cx: &CycleContext, profile: &ProfileId) -> Self {
        let scope = cx
            .doc
            .lock()
            .profiles
            .get(profile.as_str())
            .map(|l| profile_scope(&l.sync_id))
            .unwrap_or_default();
        SentTabsAdapter {
            cx: cx.clone(),
            profile: profile.clone(),
            scope,
        }
    }

    fn deliver(&self, arrived: &[(String, SendRecord)]) -> bool {
        deliver_sent_tabs(&self.cx, &self.profile, arrived)
    }
}

impl Adapter for SentTabsAdapter {
    fn prefix(&self) -> &str {
        SEND
    }

    fn extract(&mut self, cx: &ExtractContext) -> Option<Extraction> {
        let device = self.cx.device_id.clone();
        let now = cx.now;
        let (mut outgoing, mut received) = ledger_of(&self.cx.doc.lock(), &self.scope);
        let mut values = IndexMap::new();
        for (key, send) in outgoing.clone() {
            let at = send_record(Some(&send)).map_or(0, |s| s.at);
            if cx.known(&key) {
                if !cx.queued(&key) {
                    outgoing.shift_remove(&key);
                }
            } else if now - at >= SEND_KEPT_MS {
                outgoing.shift_remove(&key);
            } else {
                values.insert(key, send);
            }
        }
        let awaits_receipt = |key: &str| {
            !cx.known(key)
                || [cx.base(key), cx.remote(key).cloned()]
                    .iter()
                    .any(|v| send_record(v.as_ref()).is_some_and(|s| s.to == device))
        };
        for (key, at) in received.clone() {
            let at = at.as_i64().unwrap_or(0);
            if (cx.known(&key) && cx.remote(&key).is_some_and(Value::is_null) && !cx.queued(&key))
                || (now - at > RECEIVED_KEPT_MS && !awaits_receipt(&key))
            {
                received.shift_remove(&key);
            }
        }
        let mut ignored: HashSet<String> = HashSet::new();
        for key in cx.base_keys(SEND) {
            let ignore = match send_record(cx.base(&key).as_ref()) {
                None => true,
                Some(send) if send.to == device && send.from != device => {
                    if received.contains_key(&key) {
                        false
                    } else if sendable_url(&send.u) && !self.deliver(&[(key.clone(), send)]) {
                        true
                    } else {
                        received.insert(key.clone(), Value::from(now));
                        false
                    }
                }
                Some(send) if send.to == device => !received.contains_key(&key),
                Some(send) if send.from == device => now - send.at < SEND_KEPT_MS,
                Some(_) => true,
            };
            if ignore {
                ignored.insert(key);
            }
        }
        store_ledger(&mut self.cx.doc.lock(), &self.scope, outgoing, received);
        let doc = self.cx.doc.clone();
        let scope = self.scope.clone();
        Some(
            Extraction::of(values)
                .ignoring(move |key| ignored.contains(key))
                .on_published(move |keys| {
                    let mut doc = doc.lock();
                    let (mut outgoing, received) = ledger_of(&doc, &scope);
                    for key in keys {
                        outgoing.shift_remove(key);
                    }
                    store_ledger(&mut doc, &scope, outgoing, received);
                }),
        )
    }

    fn apply(
        &mut self,
        visible: &IndexMap<String, Value>,
        changed: &IndexSet<String>,
        records: &ApplyRecords,
    ) -> bool {
        let device = self.cx.device_id.clone();
        let (outgoing, mut received) = ledger_of(&self.cx.doc.lock(), &self.scope);
        let mut arrived: Vec<(String, SendRecord)> = Vec::new();
        let mut unusable = Vec::new();
        for key in changed {
            let Some(send) = send_record(visible.get(key)) else {
                continue;
            };
            if send.to != device || send.from == device || received.contains_key(key) {
                continue;
            }
            if sendable_url(&send.u) {
                arrived.push((key.clone(), send));
            } else {
                unusable.push(key.clone());
            }
        }
        arrived.sort_by(|a, b| a.1.at.cmp(&b.1.at).then(a.0.cmp(&b.0)));
        if !arrived.is_empty() && !self.deliver(&arrived) {
            return false;
        }
        for (key, _) in &arrived {
            received.insert(key.clone(), Value::from(records.now));
        }
        for key in unusable {
            received.insert(key, Value::from(records.now));
        }
        store_ledger(&mut self.cx.doc.lock(), &self.scope, outgoing, received);
        true
    }
}

fn front_window_showing(state: &BrowserState, profile: &ProfileId) -> Option<WindowId> {
    let mut order: Vec<&WindowId> = state.focus_order.iter().collect();
    for id in state.window_order.iter() {
        if !order.contains(&id) {
            order.push(id);
        }
    }
    order
        .into_iter()
        .find(|id| {
            state
                .windows
                .get(*id)
                .is_some_and(|w| w.kind == WindowKind::Main && w.profile_id == *profile)
        })
        .cloned()
}

fn host_of(url: &str) -> String {
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .map(|_| &url[url.find("://").map_or(0, |i| i + 3)..]);
    let Some(rest) = rest else {
        return url.to_owned();
    };
    let rest = rest
        .strip_prefix("www.")
        .or_else(|| rest.strip_prefix("WWW."))
        .unwrap_or(rest);
    let end = rest.find(['/', '?', '#', ':']).unwrap_or(rest.len());
    if end == 0 {
        url.to_owned()
    } else {
        rest[..end].to_owned()
    }
}

pub fn plural(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

pub fn received_toast_text(
    senders: &[(DeviceKind, String)],
    last: &SendRecord,
    count: usize,
) -> (String, Option<String>, &'static str) {
    let labels: Vec<String> = senders
        .iter()
        .map(|(kind, name)| device_label(*kind, name))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let from = if labels.len() == 1 {
        labels[0].clone()
    } else {
        "Your Devices".to_owned()
    };
    let title = if count == 1 {
        format!("Tab from {from}")
    } else {
        format!("{} from {from}", plural(count, "Tab"))
    };
    let message = (count == 1).then(|| {
        if last.t.is_empty() {
            host_of(&last.u)
        } else {
            last.t.clone()
        }
    });
    let icon = match (labels.len(), senders.last()) {
        (1, Some((kind, name))) => device_symbol(*kind, name),
        _ => "macbook.and.iphone",
    };
    (title, message, icon)
}

type Opened = (WindowId, TabId, SendRecord, DeviceKind, String);

pub fn deliver_sent_tabs(
    cx: &CycleContext,
    profile: &ProfileId,
    arrived: &[(String, SendRecord)],
) -> bool {
    if cx.host.quitting() || !cx.host.state().profiles.contains_key(profile) {
        return false;
    }
    let devices: std::collections::HashMap<String, Value> = cx
        .app_records
        .iter()
        .filter(|(k, r)| k.starts_with(DEVICE) && !r.v.is_null())
        .map(|(k, r)| (k[DEVICE.len()..].to_owned(), r.v.clone()))
        .collect();
    let mut opened: Vec<Opened> = Vec::new();
    for (_, send) in arrived {
        let state = cx.host.state();
        let tab = match front_window_showing(&state, profile) {
            Some(window) => {
                let outcome = cx.host.dispatch(Action::NewTab {
                    window: window.clone(),
                    tab: NewTab {
                        url: Some(send.u.clone()),
                        profile: Some(profile.clone()),
                        background: true,
                        ..NewTab::default()
                    },
                });
                outcome.ok().and_then(|o| o.tab).map(|t| (window, t))
            }
            None => {
                let outcome = cx.host.dispatch(Action::OpenWindow {
                    kind: WindowKind::Main,
                    profile: Some(profile.clone()),
                    url: Some(send.u.clone()),
                    frame: None,
                });
                outcome.ok().and_then(|o| {
                    let window = o.window?;
                    let tab = o.tab.or_else(|| {
                        cx.host
                            .state()
                            .windows
                            .get(&window)
                            .and_then(|w| w.active_tab_ids.get(profile).cloned())
                    })?;
                    Some((window, tab))
                })
            }
        };
        let sender = devices.get(&send.from);
        let name = sender
            .and_then(|s| s.get("n"))
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
            .unwrap_or("Unknown Device")
            .to_owned();
        if let Some((window, tab)) = tab {
            opened.push((
                window,
                tab,
                send.clone(),
                summary::device_kind_of(sender),
                name,
            ));
        }
    }
    let mut by_window: IndexMap<WindowId, Vec<&Opened>> = IndexMap::new();
    for entry in &opened {
        by_window.entry(entry.0.clone()).or_default().push(entry);
    }
    let now = ardia_state::store::now_ms();
    for (window, tabs) in by_window {
        let Some(last) = tabs.last() else { continue };
        let senders: Vec<(DeviceKind, String)> = tabs.iter().map(|t| (t.3, t.4.clone())).collect();
        let (title, message, icon) = received_toast_text(&senders, &last.2, tabs.len());
        let text = match message {
            Some(message) => format!("{title}\n{message}"),
            None => title,
        };
        let toast = Toast {
            id: ardia_ui::popovers::toast::next_toast_id(),
            kind: ToastKind::Info,
            message: text,
            action: Some(format!("{SHOW_TAB_ACTION}{}", last.1)),
            icon: Some(icon.to_owned()),
            created_at: now,
            expires_at: Some(now + ardia_ui::popovers::toast::TOAST_ACTION_MS),
        };
        let _ = cx.host.dispatch(Action::PushToast { window, toast });
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_and_toasts_read_like_the_old_app() {
        assert!(sendable_url("https://example.com"));
        assert!(!sendable_url("https:// x"));
        assert!(!sendable_url("file:///etc"));
        let send = SendRecord {
            u: "https://www.example.com/a".into(),
            t: String::new(),
            to: "A".into(),
            from: "B".into(),
            at: 1,
        };
        assert_eq!(send_record(Some(&send.to_value())), Some(send.clone()));
        assert_eq!(
            received_toast_text(&[(DeviceKind::Phone, "x".into())], &send, 1),
            (
                "Tab from iPhone".into(),
                Some("example.com".into()),
                "iphone"
            )
        );
        let two = [
            (DeviceKind::Phone, "x".into()),
            (DeviceKind::Mac, "Ann’s MacBook Air".into()),
        ];
        assert_eq!(
            received_toast_text(&two, &send, 2),
            (
                "2 Tabs from Your Devices".into(),
                None,
                "macbook.and.iphone"
            )
        );
    }
}
