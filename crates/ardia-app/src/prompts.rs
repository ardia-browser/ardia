use std::collections::HashMap;

use ardia_engine::{
    AutofillPrompt, BlockedPopup, EngineEvent, PasswordPrompt, PermissionRequest, PromptKey,
};
use ardia_state::TabId;
use ardia_state::tabs::{AutofillKind, PermissionKind, SitePrompt};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum PromptEntry {
    Permission {
        request_id: String,
        kind: PermissionKind,
        origin: String,
        permissions: Vec<String>,
    },
    ExternalApp {
        request_id: String,
        origin: String,
        request: Value,
    },
    Password {
        origin: String,
        username: String,
        prompt: PasswordPrompt,
    },
    Autofill {
        id: i64,
        kind: AutofillKind,
        prompt: AutofillPrompt,
    },
}

impl PromptEntry {
    pub fn site_prompt(&self) -> SitePrompt {
        match self {
            Self::Permission { kind, origin, .. } => SitePrompt::Permission {
                kind: *kind,
                origin: origin.clone(),
            },
            Self::ExternalApp { origin, .. } => SitePrompt::Permission {
                kind: PermissionKind::ExternalApp,
                origin: origin.clone(),
            },
            Self::Password {
                origin, username, ..
            } => SitePrompt::SavePassword {
                origin: origin.clone(),
                username: username.clone(),
            },
            Self::Autofill { kind, .. } => SitePrompt::Autofill { kind: *kind },
        }
    }

    fn request_id(&self) -> Option<&str> {
        match self {
            Self::Permission { request_id, .. } | Self::ExternalApp { request_id, .. } => {
                Some(request_id)
            }
            _ => None,
        }
    }

    fn same_slot(&self, other: &PromptEntry) -> bool {
        match (self, other) {
            (Self::Password { .. }, Self::Password { .. }) => true,
            (Self::Autofill { .. }, Self::Autofill { .. }) => true,
            _ => self.request_id().is_some() && self.request_id() == other.request_id(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestKind {
    Permission,
    ExternalApp,
}

pub fn permission_kind(name: &str) -> PermissionKind {
    match name {
        "camera" | "cameraPanTiltZoom" | "videoCapture" => PermissionKind::Camera,
        "microphone" | "audioCapture" => PermissionKind::Microphone,
        "location" | "geolocation" => PermissionKind::Location,
        "notifications" => PermissionKind::Notifications,
        "clipboard" | "clipboardRead" => PermissionKind::Clipboard,
        "midi" | "midiSysex" => PermissionKind::Midi,
        "usb" => PermissionKind::Usb,
        "bluetooth" => PermissionKind::Bluetooth,
        "serial" => PermissionKind::Serial,
        "hid" => PermissionKind::Hid,
        "multipleDownloads" | "downloads" => PermissionKind::Downloads,
        _ => PermissionKind::Other,
    }
}

pub fn autofill_kind(kind: &str) -> AutofillKind {
    match kind {
        "creditCard" | "card" | "iban" => AutofillKind::CreditCard,
        "password" | "passwords" => AutofillKind::Password,
        _ => AutofillKind::Address,
    }
}

#[derive(Clone, Debug, Default)]
pub struct PromptBook {
    by_tab: HashMap<TabId, Vec<PromptEntry>>,
    requests: HashMap<String, (TabId, RequestKind)>,
    popups: HashMap<TabId, Vec<BlockedPopup>>,
    others: Vec<(PromptKey, EngineEvent)>,
}

impl PromptBook {
    pub fn site_prompts(&self, tab: &TabId) -> Vec<SitePrompt> {
        self.by_tab
            .get(tab)
            .map(|entries| entries.iter().map(PromptEntry::site_prompt).collect())
            .unwrap_or_default()
    }

    pub fn entries(&self, tab: &TabId) -> &[PromptEntry] {
        self.by_tab.get(tab).map_or(&[], Vec::as_slice)
    }

    pub fn tabs(&self) -> Vec<TabId> {
        self.by_tab.keys().cloned().collect()
    }

    fn put(&mut self, tab: &TabId, entry: PromptEntry) {
        if let Some(id) = entry.request_id() {
            let kind = match entry {
                PromptEntry::ExternalApp { .. } => RequestKind::ExternalApp,
                _ => RequestKind::Permission,
            };
            self.requests.insert(id.to_owned(), (tab.clone(), kind));
        }
        let entries = self.by_tab.entry(tab.clone()).or_default();
        entries.retain(|known| !known.same_slot(&entry));
        entries.push(entry);
    }

    pub fn permission(&mut self, tab: &TabId, request: &PermissionRequest) -> bool {
        if request.id.is_empty() {
            return false;
        }
        let kind = request
            .permissions
            .first()
            .map_or(PermissionKind::Other, |name| permission_kind(name));
        self.put(
            tab,
            PromptEntry::Permission {
                request_id: request.id.clone(),
                kind,
                origin: request.origin.clone(),
                permissions: request.permissions.clone(),
            },
        );
        true
    }

    pub fn external_app(&mut self, tab: &TabId, request: &Value) -> bool {
        let Some(id) = request
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return false;
        };
        let origin = request
            .get("origin")
            .and_then(Value::as_str)
            .or_else(|| request.get("scheme").and_then(Value::as_str))
            .unwrap_or_default()
            .to_owned();
        self.put(
            tab,
            PromptEntry::ExternalApp {
                request_id: id.to_owned(),
                origin,
                request: request.clone(),
            },
        );
        true
    }

    pub fn password(&mut self, tab: &TabId, prompt: &PasswordPrompt) -> bool {
        if !matches!(prompt.state.as_str(), "save" | "update") {
            return self.clear_password(tab);
        }
        self.put(
            tab,
            PromptEntry::Password {
                origin: prompt.origin.clone(),
                username: prompt.username.clone(),
                prompt: prompt.clone(),
            },
        );
        true
    }

    pub fn autofill(&mut self, tab: &TabId, prompt: &AutofillPrompt) -> bool {
        if prompt.closed {
            return self.clear_autofill(tab, Some(prompt.id));
        }
        self.put(
            tab,
            PromptEntry::Autofill {
                id: prompt.id,
                kind: autofill_kind(&prompt.kind),
                prompt: prompt.clone(),
            },
        );
        true
    }

    fn remove_where(&mut self, tab: &TabId, gone: impl Fn(&PromptEntry) -> bool) -> bool {
        let Some(entries) = self.by_tab.get_mut(tab) else {
            return false;
        };
        let before = entries.len();
        entries.retain(|entry| !gone(entry));
        let changed = entries.len() != before;
        if entries.is_empty() {
            self.by_tab.remove(tab);
        }
        changed
    }

    pub fn clear_password(&mut self, tab: &TabId) -> bool {
        self.remove_where(tab, |entry| matches!(entry, PromptEntry::Password { .. }))
    }

    pub fn clear_autofill(&mut self, tab: &TabId, id: Option<i64>) -> bool {
        self.remove_where(tab, |entry| {
            matches!(entry, PromptEntry::Autofill { id: known, .. } if id.is_none_or(|id| id == *known))
        })
    }

    pub fn request(&self, request_id: &str) -> Option<(TabId, RequestKind)> {
        self.requests.get(request_id).cloned()
    }

    pub fn permissions_of(&self, request_id: &str) -> Vec<String> {
        self.by_tab
            .values()
            .flatten()
            .find_map(|entry| match entry {
                PromptEntry::Permission {
                    request_id: id,
                    permissions,
                    ..
                } if id == request_id => Some(permissions.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub fn settle_request(&mut self, request_id: &str) -> Option<TabId> {
        let (tab, _) = self.requests.remove(request_id)?;
        self.remove_where(&tab, |entry| entry.request_id() == Some(request_id));
        Some(tab)
    }

    pub fn block_popup(&mut self, tab: &TabId, popup: BlockedPopup) {
        let popups = self.popups.entry(tab.clone()).or_default();
        popups.retain(|known| known.id != popup.id);
        popups.push(popup);
        if popups.len() > 20 {
            popups.remove(0);
        }
    }

    pub fn blocked_popups(&self, tab: &TabId) -> &[BlockedPopup] {
        self.popups.get(tab).map_or(&[], Vec::as_slice)
    }

    pub fn take_popup(&mut self, tab: &TabId, popup_id: &str) -> Option<BlockedPopup> {
        let popups = self.popups.get_mut(tab)?;
        let at = popups.iter().position(|popup| popup.id == popup_id)?;
        Some(popups.remove(at))
    }

    pub fn hold(&mut self, event: EngineEvent) {
        let Some(key) = event.prompt() else {
            return;
        };
        self.others.retain(|(known, _)| *known != key);
        self.others.push((key, event));
    }

    pub fn release(&mut self, key: &PromptKey) -> Option<EngineEvent> {
        let at = self.others.iter().position(|(known, _)| known == key)?;
        Some(self.others.remove(at).1)
    }

    pub fn held(&self) -> Vec<EngineEvent> {
        self.others.iter().map(|(_, event)| event.clone()).collect()
    }

    pub fn forget_tab(&mut self, tab: &TabId) -> bool {
        self.popups.remove(tab);
        self.requests.retain(|_, (owner, _)| owner != tab);
        self.by_tab.remove(tab).is_some()
    }

    pub fn clear_requests(&mut self) -> Vec<TabId> {
        let tabs: Vec<TabId> = self.requests.values().map(|(tab, _)| tab.clone()).collect();
        for tab in &tabs {
            self.remove_where(tab, |entry| entry.request_id().is_some());
        }
        self.requests.clear();
        self.others.clear();
        tabs
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tab() -> TabId {
        TabId::new("tab-1")
    }

    #[test]
    fn permissions_map_to_site_prompts_and_settle_by_id() {
        let mut book = PromptBook::default();
        let request = PermissionRequest {
            id: "p1".into(),
            origin: "https://meet.example".into(),
            permissions: vec!["camera".into(), "microphone".into()],
            ..PermissionRequest::default()
        };
        assert!(book.permission(&tab(), &request));
        assert!(!book.permission(&tab(), &PermissionRequest::default()));
        assert_eq!(
            book.site_prompts(&tab()),
            [SitePrompt::Permission {
                kind: PermissionKind::Camera,
                origin: "https://meet.example".into()
            }]
        );
        assert_eq!(book.request("p1"), Some((tab(), RequestKind::Permission)));
        assert_eq!(book.settle_request("p1"), Some(tab()));
        assert!(book.site_prompts(&tab()).is_empty());
        assert_eq!(book.settle_request("p1"), None);
    }

    #[test]
    fn password_and_autofill_prompts_replace_their_own_slot() {
        let mut book = PromptBook::default();
        let mut prompt = PasswordPrompt {
            state: "save".into(),
            origin: "https://a".into(),
            username: "me".into(),
            ..PasswordPrompt::default()
        };
        book.password(&tab(), &prompt);
        prompt.username = "you".into();
        book.password(&tab(), &prompt);
        book.autofill(
            &tab(),
            &AutofillPrompt {
                id: 4,
                kind: "creditCard".into(),
                ..AutofillPrompt::default()
            },
        );
        assert_eq!(
            book.site_prompts(&tab()),
            [
                SitePrompt::SavePassword {
                    origin: "https://a".into(),
                    username: "you".into()
                },
                SitePrompt::Autofill {
                    kind: AutofillKind::CreditCard
                }
            ]
        );
        assert!(book.autofill(
            &tab(),
            &AutofillPrompt {
                id: 4,
                closed: true,
                ..AutofillPrompt::default()
            }
        ));
        assert!(book.clear_password(&tab()));
        assert!(book.site_prompts(&tab()).is_empty());
    }

    #[test]
    fn external_apps_popups_and_held_prompts() {
        let mut book = PromptBook::default();
        assert!(book.external_app(
            &tab(),
            &json!({"id": "x1", "scheme": "zoommtg", "origin": "https://zoom.us"})
        ));
        assert!(!book.external_app(&tab(), &json!({"scheme": "zoommtg"})));
        assert_eq!(book.request("x1"), Some((tab(), RequestKind::ExternalApp)));
        book.block_popup(
            &tab(),
            BlockedPopup {
                id: "b1".into(),
                url: "https://ad".into(),
                origin: "https://a".into(),
            },
        );
        book.block_popup(
            &tab(),
            BlockedPopup {
                id: "b1".into(),
                url: "https://ad2".into(),
                origin: "https://a".into(),
            },
        );
        assert_eq!(book.blocked_popups(&tab()).len(), 1);
        assert_eq!(
            book.take_popup(&tab(), "b1").map(|p| p.url),
            Some("https://ad2".into())
        );
        book.hold(EngineEvent::ConfirmCloseWithDownloads {
            window: ardia_engine::EngineWindowId::from_raw(1).unwrap(),
            count: 2,
            request: 9,
        });
        assert_eq!(book.held().len(), 1);
        assert!(book.release(&PromptKey::CloseWithDownloads(9)).is_some());
        assert!(book.forget_tab(&tab()));
        assert_eq!(book.request("x1"), None);
        assert_eq!(permission_kind("weird"), PermissionKind::Other);
        assert_eq!(
            permission_kind("multipleDownloads"),
            PermissionKind::Downloads
        );
    }
}
