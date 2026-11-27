use std::collections::HashMap;

use ardia_engine::ServiceEvent;
use ardia_ui::host_data::HostTopics;
use ardia_ui::window::page_overlays::{ControlCaller, ProgramControl as ProgramControlView};
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;

const MAX_NAME: usize = 40;
const MAX_APP_PATH: usize = 1024;

fn clean_name(raw: &str) -> Option<String> {
    let visible: String = raw
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !c.is_control() && !is_format(*c))
        .collect();
    let flat = visible.split_whitespace().collect::<Vec<_>>().join(" ");
    let name: String = flat.chars().take(MAX_NAME).collect();
    let name = name.trim().to_owned();
    (!name.is_empty()).then_some(name)
}

fn is_format(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}')
}

fn clean_app(raw: &str) -> Option<String> {
    if raw.len() > MAX_APP_PATH || !raw.starts_with('/') || !raw.ends_with(".app") || raw.len() < 6
    {
        return None;
    }
    let parts: Vec<&str> = raw.split('/').collect();
    if parts.iter().any(|part| *part == ".." || *part == ".") {
        return None;
    }
    let (_, parents) = parts.split_last()?;
    (!parents.iter().any(|part| part.ends_with(".app"))).then(|| raw.to_owned())
}

pub fn parse_control_caller(raw: &Value) -> Option<ControlCaller> {
    let name = clean_name(raw.get("name")?.as_str()?)?;
    let app = raw.get("app").and_then(Value::as_str).and_then(clean_app);
    Some(ControlCaller { name, app })
}

#[derive(Debug, Default)]
pub struct ProgramControlBook {
    callers: HashMap<u64, ControlCaller>,
    caller: Option<ControlCaller>,
    runs: u32,
    finished_runs: u64,
    cdp_on: bool,
    cdp_connections: u32,
    sent_on: Option<bool>,
    dismissed: bool,
    seen_control: Option<bool>,
    seen_show_pill: Option<bool>,
}

impl ProgramControlBook {
    pub fn view(&self, compact: bool, show_pill: bool) -> ProgramControlView {
        ProgramControlView {
            connected: self.runs + if self.cdp_on { self.cdp_connections } else { 0 } > 0,
            runs: self.finished_runs,
            caller: self.caller.clone(),
            compact,
            hidden: self.dismissed || !show_pill,
        }
    }

    pub fn dismiss(&mut self) -> bool {
        !std::mem::replace(&mut self.dismissed, true)
    }

    pub fn settings_seen(&mut self, control_on: bool, show_pill: bool) {
        if self.seen_control == Some(true) && !control_on {
            self.dismissed = false;
        }
        if self.seen_show_pill == Some(false) && show_pill {
            self.dismissed = false;
        }
        self.seen_control = Some(control_on);
        self.seen_show_pill = Some(show_pill);
    }

    pub fn hello(&mut self, connection: u64, caller: Option<ControlCaller>) {
        if let Some(caller) = caller {
            self.callers.insert(connection, caller);
        }
    }

    pub fn note_caller(&mut self, connection: u64) -> bool {
        match self.callers.get(&connection) {
            Some(caller) => {
                self.caller = Some(caller.clone());
                true
            }
            None => false,
        }
    }

    pub fn begin_run(&mut self, connection: u64) {
        self.note_caller(connection);
        self.runs += 1;
    }

    pub fn end_run(&mut self) {
        self.runs = self.runs.saturating_sub(1);
        self.finished_runs += 1;
    }

    pub fn closed(&mut self, connection: u64) {
        self.callers.remove(&connection);
    }

    pub fn server_changed(&mut self, payload: &Value) -> bool {
        let on = payload.get("state").and_then(Value::as_str) == Some("on");
        let connections = payload
            .get("connections")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u64::from(u32::MAX)) as u32;
        let changed = on != self.cdp_on || connections != self.cdp_connections;
        self.cdp_on = on;
        self.cdp_connections = connections;
        changed
    }

    pub fn wants_send(&mut self, on: bool) -> bool {
        if self.sent_on == Some(on) {
            return false;
        }
        self.sent_on = Some(on);
        true
    }
}

fn pill_shown(view: &ProgramControlView) -> bool {
    view.connected && !view.hidden
}

fn note_pill_shown(before: &ProgramControlView, after: &ProgramControlView) {
    if !pill_shown(before) && pill_shown(after) {
        ardia_telemetry::counts::count("cli_pill_shows");
        if after.compact {
            ardia_telemetry::counts::count("cli_pill_compact_shows");
        }
    }
}

impl AppCoordinator {
    pub(crate) fn program_control_view(&self) -> ProgramControlView {
        let settings = &self.store().snapshot().settings;
        let (compact, show_pill) = (settings.compact_cli_pill, settings.show_cli_pill);
        self.bridge.lock().program_control.view(compact, show_pill)
    }

    pub(crate) fn dismiss_control_pill_now(&self) {
        if self.with_program_control(ProgramControlBook::dismiss) {
            ardia_telemetry::counts::count("cli_pill_dismissals");
        }
    }

    pub(crate) fn program_control_on(&self) -> bool {
        self.store().snapshot().settings.cli_control
    }

    pub(crate) fn with_program_control<T>(
        &self,
        edit: impl FnOnce(&mut ProgramControlBook) -> T,
    ) -> T {
        let before = self.program_control_view();
        let out = edit(&mut self.bridge.lock().program_control);
        let after = self.program_control_view();
        if after != before {
            note_pill_shown(&before, &after);
            self.signal.emit(HostTopics::PAGE);
        }
        out
    }

    pub(crate) fn control_server_changed(&self, service: &ServiceEvent) {
        let before = self.program_control_view();
        let changed = self
            .bridge
            .lock()
            .program_control
            .server_changed(&service.payload);
        if changed {
            let after = self.program_control_view();
            note_pill_shown(&before, &after);
            self.signal.emit(HostTopics::PAGE);
        }
    }

    pub(crate) fn sync_control_server(&self) {
        let on = self.program_control_on();
        let show_pill = self.store().snapshot().settings.show_cli_pill;
        self.with_program_control(|book| book.settings_seen(on, show_pill));
        if !self.bridge.lock().program_control.wants_send(on) {
            return;
        }
        let Some(engine) = self.engine() else {
            return;
        };
        let call = engine.call_service("ac_cli_control", "", &json!({ "on": on }).to_string());
        let weak = self.weak();
        self.spawn(async move {
            let Ok(status) = call.await else {
                return;
            };
            if let Some(coordinator) = weak.upgrade()
                && coordinator
                    .bridge
                    .lock()
                    .program_control
                    .server_changed(&status)
            {
                coordinator.signal.emit(HostTopics::PAGE);
            }
        });
    }

    pub(crate) fn stop_program_control_now(&self) {
        let _ = self.dispatch_action(ardia_state::Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new().set("cliControl", false),
            from_sync: false,
        });
        self.sync_control_server();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callers_are_cleaned_like_the_old_app() {
        let caller = parse_control_caller(
            &json!({ "name": "  Claude\u{200B}  Code\n", "app": "/Applications/Claude.app" }),
        )
        .expect("a caller");
        assert_eq!(caller.name, "Claude Code");
        assert_eq!(caller.app.as_deref(), Some("/Applications/Claude.app"));
        let nested = parse_control_caller(&json!({ "name": "x", "app": "/A.app/Contents/B.app" }))
            .expect("a caller");
        assert_eq!(nested.app, None);
        assert_eq!(
            parse_control_caller(&json!({ "name": "x", "app": "/a/../b.app" })).and_then(|c| c.app),
            None
        );
        assert!(parse_control_caller(&json!({ "name": "   " })).is_none());
        let long = "a".repeat(60);
        assert_eq!(
            parse_control_caller(&json!({ "name": long }))
                .expect("a caller")
                .name
                .len(),
            MAX_NAME
        );
    }

    #[test]
    fn the_pill_counts_runs_and_live_devtools_connections() {
        let mut book = ProgramControlBook::default();
        assert!(!book.view(false, true).connected);
        book.hello(1, parse_control_caller(&json!({ "name": "Agent" })));
        book.begin_run(1);
        let view = book.view(true, true);
        assert!(view.connected && view.compact);
        assert_eq!(view.caller.expect("caller").name, "Agent");
        book.end_run();
        assert!(!book.view(false, true).connected);
        assert!(book.server_changed(&json!({ "state": "on", "connections": 2 })));
        assert!(book.view(false, true).connected);
        assert!(book.server_changed(&json!({ "state": "off", "connections": 2 })));
        assert!(!book.view(false, true).connected);
        assert!(book.wants_send(true));
        assert!(!book.wants_send(true));
        book.closed(1);
        assert!(!book.note_caller(1));
    }

    #[test]
    fn dismissing_hides_the_pill_until_control_or_the_setting_turns_it_back() {
        let mut book = ProgramControlBook::default();
        book.settings_seen(true, true);
        assert!(!book.view(false, true).hidden);
        assert!(book.dismiss());
        assert!(!book.dismiss());
        assert!(book.view(false, true).hidden);
        book.settings_seen(true, true);
        assert!(book.view(false, true).hidden);
        book.settings_seen(false, true);
        assert!(!book.view(false, true).hidden);
        book.settings_seen(true, true);
        book.dismiss();
        book.settings_seen(true, false);
        assert!(book.view(false, false).hidden);
        book.settings_seen(true, true);
        assert!(!book.view(false, true).hidden);
        assert!(book.view(false, false).hidden);
    }
}
