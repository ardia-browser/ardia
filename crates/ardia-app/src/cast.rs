use ardia_engine::{CastDialog, CastSink, EngineEvent, EngineTabId, GlobalCommand, PromptKey};
use ardia_state::windows::Popover;
use ardia_state::{TabId, WindowId};
use ardia_ui::host_data::{
    CastDevice, CastDeviceKind, CastDeviceState, CastPanel, HostTopics, cast_mode,
};

use crate::coordinator::AppCoordinator;

pub fn device_of(sink: &CastSink) -> CastDevice {
    CastDevice {
        id: sink.id.clone(),
        name: sink.name.clone(),
        status: sink.status.clone(),
        issue: sink.issue.clone(),
        state: CastDeviceState::parse(&sink.state),
        kind: CastDeviceKind::from_icon(sink.icon),
        modes: sink.modes,
        route_id: sink.route_id.clone(),
    }
}

pub fn panel_of(tab: &TabId, dialog: &CastDialog, screen: bool) -> CastPanel {
    CastPanel {
        tab: Some(tab.clone()),
        dialog_id: dialog.id,
        header: dialog.header.clone(),
        devices: dialog.sinks.iter().map(device_of).collect(),
        permission_rejected: dialog.permission_rejected,
        screen,
    }
}

impl AppCoordinator {
    fn open_cast_dialogs(&self) -> Vec<(Option<EngineTabId>, CastDialog)> {
        self.bridge
            .lock()
            .prompts
            .held()
            .into_iter()
            .filter_map(|event| match event {
                EngineEvent::CastDialog { tab, dialog } if dialog.open => Some((tab, dialog)),
                _ => None,
            })
            .collect()
    }

    fn cast_dialog_for(&self, tab: &TabId) -> Option<CastDialog> {
        let engine_tab = self.engine_tab(tab)?;
        self.open_cast_dialogs()
            .into_iter()
            .find(|(owner, _)| *owner == Some(engine_tab))
            .map(|(_, dialog)| dialog)
    }

    pub(crate) fn cast_panel_for(&self, tab: &TabId) -> Option<CastPanel> {
        let dialog = self.cast_dialog_for(tab)?;
        let screen = self.bridge.lock().cast_screens.contains(&dialog.id);
        Some(panel_of(tab, &dialog, screen))
    }

    pub(crate) fn choose_cast_source(&self, tab: &TabId, screen: bool) {
        let Some(dialog) = self.cast_dialog_for(tab) else {
            return;
        };
        let open: Vec<i32> = self
            .open_cast_dialogs()
            .into_iter()
            .map(|(_, dialog)| dialog.id)
            .collect();
        let changed = {
            let mut bridge = self.bridge.lock();
            bridge.cast_screens.retain(|id| open.contains(id));
            if screen {
                bridge.cast_screens.insert(dialog.id)
            } else {
                bridge.cast_screens.remove(&dialog.id)
            }
        };
        if changed {
            self.signal.emit(HostTopics::CAST);
        }
    }

    pub(crate) fn cast_to(&self, tab: &TabId, device: &str) {
        let Some(dialog) = self.cast_dialog_for(tab) else {
            log::debug!("{tab} has no open Cast dialog");
            return;
        };
        let Some(sink) = dialog.sinks.iter().find(|sink| sink.id == device) else {
            log::debug!("{device} isn't in the Cast dialog anymore");
            return;
        };
        let screen = self.bridge.lock().cast_screens.contains(&dialog.id);
        let mode = match cast_mode::click(sink.modes, screen) {
            cast_mode::CastClick::Start(mode) => mode,
            cast_mode::CastClick::ShowScreenSource => {
                self.choose_cast_source(tab, true);
                return;
            }
            cast_mode::CastClick::Nothing => {
                log::debug!("{device} offers no way to cast");
                return;
            }
        };
        let Some(engine) = self.engine() else {
            return;
        };
        if let Err(problem) = engine.start_casting(dialog.id, &sink.id, mode) {
            log::warn!("casting to {device} didn't start: {problem}");
        }
    }

    pub(crate) fn stop_cast(&self, tab: &TabId, device: &str) {
        let Some(dialog) = self.cast_dialog_for(tab) else {
            return;
        };
        let Some(route) = dialog
            .sinks
            .iter()
            .find(|sink| sink.id == device)
            .map(|sink| sink.route_id.clone())
            .filter(|route| !route.is_empty())
        else {
            return;
        };
        let Some(engine) = self.engine() else {
            return;
        };
        if let Err(problem) = engine.stop_casting(dialog.id, &route) {
            log::warn!("casting to {device} didn't stop: {problem}");
        }
    }

    pub(crate) fn close_cast_dialogs_of(&self, window: &WindowId) {
        let Some(engine) = self.engine() else {
            return;
        };
        let mut closed = false;
        for (tab, dialog) in self.open_cast_dialogs() {
            let owned = tab
                .and_then(|tab| self.state_tab(tab))
                .and_then(|tab| self.window_of(&tab))
                .is_none_or(|owner| owner == *window);
            if !owned {
                continue;
            }
            if let Err(problem) = engine.global(GlobalCommand::CloseCastDialog {
                dialog_id: dialog.id,
            }) {
                log::debug!("the Cast dialog was already closed: {problem}");
            }
            self.bridge
                .lock()
                .prompts
                .release(&PromptKey::CastDialog(dialog.id));
            closed = true;
        }
        if closed {
            self.signal.emit(HostTopics::CAST);
        }
    }

    pub(crate) fn note_popover_change(&self, window: &WindowId, next: Option<&Popover>) {
        let current = self
            .store
            .snapshot()
            .window(window.as_str())
            .and_then(|w| w.chrome.popover.clone());
        if current == Some(Popover::Cast) && next != Some(&Popover::Cast) {
            self.close_cast_dialogs_of(window);
        }
        if next.is_some() {
            self.close_popup(window);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sinks_become_devices() {
        let sink = CastSink {
            id: "tv".into(),
            name: "Den".into(),
            state: "connected".into(),
            icon: 6,
            modes: 2,
            route_id: "r1".into(),
            issue: "Busy".into(),
            ..CastSink::default()
        };
        let device = device_of(&sink);
        assert_eq!(device.name, "Den");
        assert!(device.casting());
        assert_eq!(device.kind, CastDeviceKind::Display);
        assert_eq!(device.detail(), "Busy");
    }
}
