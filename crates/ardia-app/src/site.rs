use std::collections::HashMap;
use std::sync::Arc;

use ardia_engine::{
    DeviceChooser, DevicePickerAction, EngineEvent, PermissionResult, SecurityInfo, SecurityLevel,
    Services,
};
use ardia_state::TabId;
use ardia_state::windows::Popover;
use ardia_ui::host_data::HostTopics;
use ardia_ui::site::model::{
    self, AutofillAsk, AutofillChange, BlockedPopupItem, CertificateView, DeviceAsk,
    DeviceOptionView, ExternalAppAsk, PageSelection, PasswordAsk, PermissionAsk, PopupsAnswer,
    SecurityView, SelectionRect, SettingValue, SiteSettings,
};
use ardia_ui::site::{SiteAnswer, SitePage, SitePanel};
use ardia_ui::{Confirmation, UiHost as _};
use serde_json::Value;

use crate::coordinator::AppCoordinator;
use crate::prompts::PromptEntry;

#[derive(Default)]
pub struct SiteBook {
    panels: HashMap<TabId, SitePanel>,
    selections: HashMap<TabId, PageSelection>,
}

impl SiteBook {
    pub fn forget_tab(&mut self, tab: &TabId) {
        self.panels.remove(tab);
        self.selections.remove(tab);
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn flag(value: &Value, key: &str) -> bool {
    match value.get(key) {
        Some(Value::Bool(on)) => *on,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => false,
    }
}

fn optional_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

pub fn image_from_data_url(url: &str) -> Option<Arc<gpui::Image>> {
    let bytes = crate::favicons::data_url_bytes(url)?;
    let format = image::guess_format(&bytes).ok()?;
    let format = match format {
        image::ImageFormat::Png => gpui::ImageFormat::Png,
        image::ImageFormat::Jpeg => gpui::ImageFormat::Jpeg,
        image::ImageFormat::Gif => gpui::ImageFormat::Gif,
        image::ImageFormat::WebP => gpui::ImageFormat::Webp,
        image::ImageFormat::Bmp => gpui::ImageFormat::Bmp,
        _ => return None,
    };
    Some(Arc::new(gpui::Image::from_bytes(format, bytes)))
}

pub fn external_app_ask(request: &Value) -> Option<ExternalAppAsk> {
    let id = optional_text(request, "id")?;
    optional_text(request, "app")?;
    Some(ExternalAppAsk {
        id,
        title: text(request, "title"),
        message: optional_text(request, "message"),
        icon: optional_text(request, "icon").and_then(|icon| image_from_data_url(&icon)),
        remember: optional_text(request, "remember"),
    })
}

pub fn autofill_ask(prompt: &ardia_engine::AutofillPrompt) -> AutofillAsk {
    let line = |value: &Value| match value {
        Value::String(text) => Some(text.clone()),
        other => other.get("text").and_then(Value::as_str).map(str::to_owned),
    };
    AutofillAsk {
        id: prompt.id,
        kind: prompt.kind.clone(),
        title: prompt.title.clone(),
        message: prompt.message.clone(),
        accept: prompt.accept.clone(),
        decline: prompt.decline.clone(),
        footer: prompt.footer.clone(),
        lines: prompt.lines.iter().filter_map(line).collect(),
        changes: prompt
            .changes
            .iter()
            .map(|change| AutofillChange {
                from: text(change, "from"),
                to: text(change, "to"),
            })
            .collect(),
        new_label: prompt
            .extra
            .get("newLabel")
            .and_then(Value::as_str)
            .map(str::to_owned),
        old_label: prompt
            .extra
            .get("oldLabel")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

pub fn password_ask(prompt: &ardia_engine::PasswordPrompt) -> PasswordAsk {
    PasswordAsk {
        origin: prompt.origin.clone(),
        username: prompt.username.clone(),
        usernames: prompt.usernames.clone(),
        password_length: prompt.password_length.unwrap_or_default(),
        federation: prompt.federation.clone().filter(|f| !f.is_empty()),
        update: prompt.state == "update",
    }
}

pub fn device_ask(chooser: &DeviceChooser) -> DeviceAsk {
    let extra = Value::Object(chooser.extra.clone());
    DeviceAsk {
        id: chooser.id,
        title: text(&extra, "title"),
        ok_label: text(&extra, "okLabel"),
        cancel_label: text(&extra, "cancelLabel"),
        no_options_text: text(&extra, "noOptionsText"),
        scanning_text: text(&extra, "scanningText"),
        refreshing: flag(&extra, "refreshing"),
        can_refresh: flag(&extra, "canRefresh"),
        adapter_off: flag(&extra, "adapterOff"),
        unauthorized: flag(&extra, "unauthorized"),
        both_buttons_enabled: flag(&extra, "bothButtonsEnabled"),
        show_signal: flag(&extra, "showSignal"),
        options: chooser
            .options
            .iter()
            .map(|option| DeviceOptionView {
                name: option.name.clone(),
                connected: option.connected,
                paired: option.paired,
                signal: option.signal.unwrap_or(-1),
            })
            .collect(),
    }
}

pub fn security_view(info: &SecurityInfo) -> SecurityView {
    let level = match info.level {
        SecurityLevel::Secure => model::SecurityLevel::Secure,
        SecurityLevel::Mixed => model::SecurityLevel::Mixed,
        SecurityLevel::Insecure => model::SecurityLevel::Insecure,
        SecurityLevel::CertificateError => model::SecurityLevel::CertificateError,
        SecurityLevel::Local => model::SecurityLevel::Local,
        SecurityLevel::None | SecurityLevel::Unknown => model::SecurityLevel::None,
    };
    let names = |value: Option<&Value>| -> Vec<String> {
        value
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let certificate = info.certificate.as_ref().map(|cert| {
        let subject = cert.get("subject").cloned().unwrap_or(Value::Null);
        let issuer = cert.get("issuer").cloned().unwrap_or(Value::Null);
        CertificateView {
            subject_common_name: text(&subject, "commonName"),
            subject_display_name: text(&subject, "displayName"),
            subject_organizations: names(subject.get("organizations")),
            issuer_common_name: text(&issuer, "commonName"),
            issuer_display_name: text(&issuer, "displayName"),
            issuer_organizations: names(issuer.get("organizations")),
            valid_from: cert
                .get("validFrom")
                .and_then(Value::as_f64)
                .unwrap_or_default(),
            valid_until: cert
                .get("validUntil")
                .and_then(Value::as_f64)
                .unwrap_or_default(),
            sha256: optional_text(cert, "sha256"),
        }
    });
    SecurityView {
        level,
        protocol: info.protocol.clone().filter(|p| !p.is_empty()),
        certificate,
    }
}

pub fn parse_selection(json: &str) -> Option<PageSelection> {
    let value: Value = serde_json::from_str(json).ok()?;
    let text = value.get("text")?.as_str()?.trim().to_owned();
    if text.is_empty() {
        return None;
    }
    let rect = value.get("rect")?;
    let number = |key: &str| rect.get(key).and_then(Value::as_f64).unwrap_or_default() as f32;
    let rect = SelectionRect {
        x: number("x"),
        y: number("y"),
        width: number("width"),
        height: number("height"),
    };
    (rect.x.is_finite() && rect.y.is_finite()).then_some(PageSelection {
        text: text.chars().take(2000).collect(),
        rect,
    })
}

impl AppCoordinator {
    fn chooser_for(&self, tab: &TabId) -> Option<DeviceChooser> {
        let held = self.bridge.lock().prompts.held();
        held.into_iter().rev().find_map(|event| match event {
            EngineEvent::DeviceChooser {
                tab: Some(engine_tab),
                chooser,
            } if chooser.open && self.state_tab(engine_tab).as_ref() == Some(tab) => Some(chooser),
            _ => None,
        })
    }

    pub(crate) fn site_page_for(&self, tab: &TabId) -> Option<SitePage> {
        let (entries, popups) = {
            let bridge = self.bridge.lock();
            (
                bridge.prompts.entries(tab).to_vec(),
                bridge.prompts.blocked_popups(tab).to_vec(),
            )
        };
        let mut page = SitePage::default();
        for entry in entries {
            match entry {
                PromptEntry::Permission {
                    request_id,
                    origin,
                    permissions,
                    ..
                } if page.permission.is_none() => {
                    page.permission = Some(PermissionAsk {
                        id: request_id,
                        origin,
                        permissions,
                    })
                }
                PromptEntry::ExternalApp { request, .. } => {
                    page.external_app = external_app_ask(&request)
                }
                PromptEntry::Password { prompt, .. } => page.password = Some(password_ask(&prompt)),
                PromptEntry::Autofill { prompt, .. } => page.autofill = Some(autofill_ask(&prompt)),
                PromptEntry::Permission { .. } => {}
            }
        }
        page.device = self.chooser_for(tab).map(|chooser| device_ask(&chooser));
        page.engine_offer = self
            .engine_offer_of(tab)
            .map(|offer| ardia_ui::site::model::EngineOfferAsk {
                site: offer.site,
                host: offer.host,
                can_remember: offer.can_remember,
            });
        page.popups = popups
            .into_iter()
            .map(|popup| BlockedPopupItem {
                id: popup.id,
                url: popup.url,
                origin: popup.origin,
            })
            .collect();
        Some(page)
    }

    pub(crate) fn site_panel_for(&self, tab: &TabId) -> SitePanel {
        let mut panel = self
            .bridge
            .lock()
            .site
            .panels
            .get(tab)
            .cloned()
            .unwrap_or_default();
        let host = self
            .store
            .snapshot()
            .tab(tab.as_str())
            .map(|t| ardia_state::omnibox::url::host_of(&t.url))
            .unwrap_or_default();
        panel.blocker = self
            .content_blocker_view()
            .map(|view| view.site_blocker(&host));
        panel.translate = self.translate_view_for(tab);
        panel
    }

    fn with_arc(&self, run: impl FnOnce(Arc<AppCoordinator>)) {
        if let Some(me) = self.weak().upgrade() {
            run(me);
        }
    }

    pub(crate) fn store_hidden(&self, tab: &TabId, hidden: Option<ardia_ui::site::model::HiddenList>) {
        self.store_panel(tab, |panel| panel.hidden = hidden);
    }

    fn store_panel(&self, tab: &TabId, change: impl FnOnce(&mut SitePanel)) {
        {
            let mut bridge = self.bridge.lock();
            let panel = bridge.site.panels.entry(tab.clone()).or_default();
            change(panel);
        }
        self.signal.emit(HostTopics::SITE);
    }

    fn origin_and_dir(&self, tab: &TabId) -> Option<(String, String)> {
        let state = self.store.snapshot();
        let tab = state.tab(tab.as_str())?;
        let origin = model::site_origin(&tab.url)?;
        let dir = self.service_profile_dir(&tab.profile_id)?;
        Some((origin, dir))
    }

    pub(crate) fn refresh_site_panel_for(&self, tab: TabId) {
        let security = self
            .engine_tab(&tab)
            .zip(self.engine())
            .and_then(|(engine_tab, engine)| engine.security_info(engine_tab).ok())
            .or_else(|| self.webkit_security_info(&tab))
            .map(|info| security_view(&info));
        self.store_panel(&tab, |panel| {
            panel.security = security;
            panel.cleared = None;
        });
        self.reload_site_settings(&tab);
        self.refresh_content_blocker();
        self.refresh_hidden_elements(&tab);
    }

    fn reload_site_settings(&self, tab: &TabId) {
        if let Some(value) = self.webkit_private_site_settings(tab) {
            self.store_panel(tab, |panel| panel.settings = Some(SiteSettings::from_json(&value)));
            return;
        }
        let (Some(engine), Some((origin, dir))) = (self.engine(), self.origin_and_dir(tab)) else {
            return;
        };
        let reply = Services::new(engine.as_ref(), &dir)
            .sites()
            .settings(&origin);
        let me = self.weak();
        let tab = tab.clone();
        self.spawn(async move {
            let value = match reply.await {
                Ok(value) => value,
                Err(problem) => {
                    log::debug!("site settings didn't load: {problem}");
                    serde_json::Value::Null
                }
            };
            let value = value
                .get("settings")
                .filter(|settings| settings.is_object())
                .cloned()
                .unwrap_or(value);
            let settings = SiteSettings::from_json(&value);
            if let Some(me) = me.upgrade() {
                me.remember_webkit_policy(&tab, &value);
                me.note_webkit_answers(&tab, &value);
                me.store_panel(&tab, |panel| panel.settings = Some(settings));
            }
        });
    }

    pub(crate) fn turned_down_unasked(
        &self,
        request: &ardia_engine::PermissionRequest,
    ) -> bool {
        let blocks = self.store.snapshot().settings.block_notification_requests;
        if !blocks
            || request.permissions.is_empty()
            || request.permissions.iter().any(|kind| kind != "notifications")
        {
            return false;
        }
        ardia_telemetry::counts::count("notification_requests_auto_denied");
        self.resolve_permission(request.id.clone(), PermissionResult::Deny, true);
        true
    }

    fn set_site_setting(&self, tab: &TabId, kind: &str, value: &str) {
        if self.set_webkit_private_site_setting(tab, kind, value) {
            self.reload_site_settings(tab);
            return;
        }
        let (Some(engine), Some((origin, dir))) = (self.engine(), self.origin_and_dir(tab)) else {
            return;
        };
        let reply = Services::new(engine.as_ref(), &dir)
            .sites()
            .set_setting(&origin, kind, value);
        let me = self.weak();
        let tab = tab.clone();
        self.spawn(async move {
            if let Err(problem) = reply.await {
                log::warn!("the site setting wasn't saved: {problem}");
            }
            if let Some(me) = me.upgrade() {
                me.reload_site_settings(&tab);
            }
        });
    }

    fn clear_site_data(&self, tab: &TabId) {
        let state = self.store.snapshot();
        let Some(current) = state.tab(tab.as_str()).cloned() else {
            return;
        };
        let (Some(engine), Some((origin, dir))) = (self.engine(), self.origin_and_dir(tab)) else {
            return;
        };
        let host = ardia_state::omnibox::url::host_of(&origin);
        let asked = self.ask_in_window(
            &current.window_id,
            Confirmation {
                title: format!("Clear cookies and site data for {host}?"),
                message: "You'll be signed out of this site, and its offline data will be deleted."
                    .to_owned(),
                confirm: "Clear".to_owned(),
                destructive: true,
            },
        );
        let me = self.weak();
        let tab = tab.clone();
        self.spawn(async move {
            if !asked.await.unwrap_or(false) {
                return;
            }
            let reply = Services::new(engine.as_ref(), &dir)
                .sites()
                .clear_data(&origin);
            let cookies = reply
                .await
                .ok()
                .and_then(|value| value.get("cookies").and_then(Value::as_u64))
                .unwrap_or(0);
            let Some(me) = me.upgrade() else {
                return;
            };
            let still_there = me
                .store
                .snapshot()
                .tab(tab.as_str())
                .is_some_and(|now| model::site_origin(&now.url).as_deref() == Some(&origin));
            if still_there {
                me.reload(tab.clone(), false);
            }
            let note = if cookies > 0 {
                format!(
                    "Cleared {cookies} cookie{} and site data",
                    if cookies == 1 { "" } else { "s" }
                )
            } else {
                "Cleared site data".to_owned()
            };
            me.store_panel(&tab, |panel| panel.cleared = Some(note));
        });
    }

    fn answer_popups(&self, tab: &TabId, answer: PopupsAnswer) {
        let popups = self.bridge.lock().prompts.blocked_popups(tab).to_vec();
        match answer {
            PopupsAnswer::AlwaysDeny => {
                if let Some(first) = popups.first() {
                    let origin = first.origin.clone();
                    if let (Some(engine), Some(dir)) = (
                        self.engine(),
                        self.store
                            .snapshot()
                            .tab(tab.as_str())
                            .and_then(|t| self.service_profile_dir(&t.profile_id)),
                    ) {
                        let reply = Services::new(engine.as_ref(), &dir)
                            .sites()
                            .set_setting(&origin, "popups", "block");
                        self.spawn(async move {
                            if let Err(problem) = reply.await {
                                log::warn!("pop-ups weren't blocked: {problem}");
                            }
                        });
                    }
                }
            }
            PopupsAnswer::OnlyOnce | PopupsAnswer::AlwaysAllow => {
                let always = answer == PopupsAnswer::AlwaysAllow;
                for popup in &popups {
                    self.open_blocked_popup(tab, &popup.id, always);
                }
            }
        }
        let mut bridge = self.bridge.lock();
        for popup in popups {
            bridge.prompts.take_popup(tab, &popup.id);
        }
        drop(bridge);
        self.signal.emit(HostTopics::SITE);
    }

    pub(crate) fn popup_was_blocked(&self, tab: &TabId, origin: &str, first: bool) {
        self.signal.emit(HostTopics::SITE);
        if !first {
            return;
        }
        let Some(window) = self.window_of(tab) else {
            return;
        };
        let (Some(engine), Some(dir)) = (
            self.engine(),
            self.store
                .snapshot()
                .tab(tab.as_str())
                .and_then(|t| self.service_profile_dir(&t.profile_id)),
        ) else {
            return;
        };
        let reply = Services::new(engine.as_ref(), &dir)
            .sites()
            .settings(origin);
        let me = self.weak();
        let tab = tab.clone();
        self.spawn(async move {
            let ask = reply.await.map_or(true, |value| {
                value
                    .get("popups")
                    .and_then(|popups| popups.get("isDefault"))
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
            });
            let Some(me) = me.upgrade() else {
                return;
            };
            let state = me.store.snapshot();
            let active = state
                .window(window.as_str())
                .is_some_and(|w| w.active_tab() == Some(&tab) && w.chrome.popover.is_none());
            if ask && active {
                me.dispatch_quietly(ardia_state::Action::SetPopover {
                    window,
                    popover: Some(Popover::BlockedPopups),
                });
            }
        });
    }

    pub(crate) fn note_page_selection(&self, tab: &TabId, json: &str) {
        let selection = parse_selection(json);
        let changed = {
            let mut bridge = self.bridge.lock();
            let before = bridge.site.selections.get(tab).cloned();
            match &selection {
                Some(selection) => {
                    bridge
                        .site
                        .selections
                        .insert(tab.clone(), selection.clone());
                }
                None => {
                    bridge.site.selections.remove(tab);
                }
            }
            before != selection
        };
        if changed {
            self.signal.emit(HostTopics::SITE);
        }
    }

    pub(crate) fn page_selection_for(&self, tab: &TabId) -> Option<PageSelection> {
        self.bridge.lock().site.selections.get(tab).cloned()
    }

    fn external_request_id(&self, tab: &TabId) -> Option<String> {
        self.bridge
            .lock()
            .prompts
            .entries(tab)
            .iter()
            .find_map(|entry| match entry {
                PromptEntry::ExternalApp { request_id, .. } => Some(request_id.clone()),
                _ => None,
            })
    }

    pub(crate) fn site_answer_for(&self, tab: TabId, answer: SiteAnswer) {
        match answer {
            SiteAnswer::ExternalApp { open, remember } => {
                if let Some(id) = self.external_request_id(&tab) {
                    self.resolve_external(&id, open, remember);
                }
            }
            SiteAnswer::Verification { .. } => {}
            SiteAnswer::Popups(answer) => self.answer_popups(&tab, answer),
            SiteAnswer::OpenPopup(id) => {
                self.open_blocked_popup(&tab, &id, false);
                self.signal.emit(HostTopics::SITE);
            }
            SiteAnswer::ChooseDevice { chooser, index } => {
                self.device_action(chooser, |media| media.select_device(chooser, index))
            }
            SiteAnswer::CancelDevice(chooser) => self.device_action(chooser, |media| {
                media.device_chooser(chooser, DevicePickerAction::Cancel)
            }),
            SiteAnswer::RescanDevices(chooser) => self.device_action(chooser, |media| {
                media.device_chooser(chooser, DevicePickerAction::Refresh)
            }),
            SiteAnswer::BluetoothSettings(chooser) => self.device_action(chooser, |media| {
                media.device_chooser(chooser, DevicePickerAction::Settings)
            }),
            SiteAnswer::EngineOffer { accept, remember } => {
                self.answer_engine_offer(&tab, accept, remember)
            }
            SiteAnswer::SetPermission { kind, value } => {
                if kind == "sound" {
                    if let Err(problem) = self.dispatch_action(ardia_state::Action::SetSiteMuted {
                        tab: tab.clone(),
                        muted: value == SettingValue::Block,
                    }) {
                        log::debug!("the site's sound didn't change: {problem}");
                    }
                    let blocked = self
                        .site_panel_for(&tab)
                        .settings
                        .and_then(|s| s.get("sound"))
                        .is_some_and(|s| s.value == SettingValue::Block);
                    if value != SettingValue::Block && blocked {
                        self.set_site_setting(&tab, "sound", "default");
                    }
                } else {
                    self.set_site_setting(&tab, &kind, value.as_str());
                    if kind == "autoplay" {
                        match value {
                            SettingValue::Block => {
                                ardia_telemetry::counts::count("site_autoplay_blocks")
                            }
                            SettingValue::Allow => {
                                ardia_telemetry::counts::count("site_autoplay_allows")
                            }
                            _ => {}
                        }
                    }
                    if kind == "location" && value == SettingValue::Allow {
                        let window = self
                            .store
                            .snapshot()
                            .tab(tab.as_str())
                            .map(|t| t.window_id.clone());
                        self.ensure_location_permission(window);
                    }
                }
            }
            SiteAnswer::SetBlocking(on) => self.set_site_blocking(&tab, on),
            SiteAnswer::ClearData => self.clear_site_data(&tab),
            SiteAnswer::RestoreHidden(filters) => self.restore_hidden(&tab, filters),
            SiteAnswer::HideElement => self.start_hiding_element(&tab),
            SiteAnswer::Translate => self.with_arc(|me| {
                me.translate_page_to(tab, None, crate::translate::TranslateOrigin::SiteControls)
            }),
            SiteAnswer::TranslateTo(language) => self.with_arc(|me| {
                me.translate_page_to(
                    tab,
                    Some(language),
                    crate::translate::TranslateOrigin::ButtonMenu,
                )
            }),
            SiteAnswer::ShowOriginal => self.with_arc(|me| me.show_original(tab)),
            SiteAnswer::ToggleTranslation => self.with_arc(|me| {
                me.toggle_translation(tab, crate::translate::TranslateOrigin::Button)
            }),
            SiteAnswer::NeverTranslate(never) => {
                self.with_arc(|me| me.set_never_translate(&tab, never))
            }
            SiteAnswer::SearchSelection { .. } | SiteAnswer::DismissSelection => {
                self.bridge.lock().site.selections.remove(&tab);
            }
        }
    }

    fn device_action(
        &self,
        chooser: i32,
        run: impl FnOnce(
            ardia_engine::services::Media<'_, dyn ardia_engine::BrowserEngine>,
        ) -> ardia_engine::EngineResult<()>,
    ) {
        let Some(engine) = self.engine() else {
            return;
        };
        if let Err(problem) = run(Services::new(engine.as_ref(), "").media()) {
            log::warn!("device chooser {chooser} didn't take the answer: {problem}");
        }
    }

    fn resolve_external(&self, request_id: &str, open: bool, remember: bool) {
        if request_id.starts_with("wk-external-") {
            crate::webkit::page::resolve_external(request_id, open, remember);
            let tab = self.bridge.lock().prompts.settle_request(request_id);
            if let Some(tab) = tab {
                self.publish_prompts(&tab);
            }
            return;
        }
        self.resolve_permission(
            request_id.to_owned(),
            if open {
                PermissionResult::Accept
            } else {
                PermissionResult::Deny
            },
            remember,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selections_parse_from_the_page_script_message() {
        let selection = parse_selection(
            &json!({"text": "  hello  ", "rect": {"x": 1, "y": 2, "width": 3, "height": 4}})
                .to_string(),
        )
        .expect("a selection");
        assert_eq!(selection.text, "hello");
        assert_eq!(selection.rect.height, 4.0);
        assert!(parse_selection("null").is_none());
        assert!(parse_selection(&json!({"text": "", "rect": {}}).to_string()).is_none());
    }

    #[test]
    fn engine_prompts_map_to_site_page_asks() {
        let chooser: DeviceChooser = serde_json::from_value(json!({
            "id": 3, "open": true, "title": "Pick a device", "canRefresh": true,
            "showSignal": 1, "options": [{"name": "Pen", "paired": true, "signal": 2}]
        }))
        .expect("chooser");
        let ask = device_ask(&chooser);
        assert_eq!(ask.title, "Pick a device");
        assert!(ask.can_refresh && ask.show_signal);
        assert_eq!(ask.options[0].signal, 2);
        assert!(external_app_ask(&json!({"id": "x", "title": "Open Zoom?"})).is_none());
        let external = external_app_ask(
            &json!({"id": "x", "app": "Zoom", "title": "Open Zoom?", "remember": "Always"}),
        )
        .expect("an app");
        assert_eq!(external.remember.as_deref(), Some("Always"));
        let password = password_ask(&ardia_engine::PasswordPrompt {
            state: "update".into(),
            origin: "https://a".into(),
            password_length: Some(8),
            ..ardia_engine::PasswordPrompt::default()
        });
        assert!(password.update);
        assert_eq!(password.password_length, 8);
        let info: SecurityInfo = serde_json::from_value(json!({
            "level": "secure", "url": "https://a", "protocol": "TLS 1.3",
            "certificate": {"subject": {"commonName": "a"}, "issuer": {"commonName": "CA", "organizations": ["Let's Encrypt"]}, "validFrom": 0, "validUntil": 1}
        }))
        .expect("info");
        let view = security_view(&info);
        assert_eq!(view.level, model::SecurityLevel::Secure);
        assert_eq!(
            view.certificate.map(|c| c.issuer_organizations),
            Some(vec!["Let's Encrypt".to_owned()])
        );
    }
}
