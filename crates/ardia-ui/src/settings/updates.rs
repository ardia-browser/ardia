use std::time::{Duration, Instant};

use gpui::{
    AnyElement, Context, IntoElement, ParentElement, SharedString, Styled, div, prelude::*,
};

use crate::host::{SwitchPhase, UpdateChannel, UpdaterState};
use crate::msg::Msg;
use crate::primitives::controls::{PushButton, Segmented, Toggle, spinner};
use crate::scale::px;
use crate::settings::SettingsWindowView;

pub const COMMAND: &str = "settings:updates:";
pub const APP: &str = "Ardia";
pub const NOT_SET_UP: &str = "Updates aren't set up for this build.";
pub const FOLLOW_EVERY: Duration = Duration::from_millis(400);
pub const FOLLOW_FOR: Duration = Duration::from_secs(120);
pub const FOLLOW_UPDATE_EVERY: Duration = Duration::from_millis(2_000);
pub const FOLLOW_UPDATE_FOR: Duration = Duration::from_secs(75 * 60);
const CHECK_SPINNER: f32 = 14.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckNow {
    pub title: &'static str,
    pub checking: bool,
    pub disabled: bool,
    pub pressable: bool,
}

pub fn channel_title(channel: UpdateChannel) -> &'static str {
    match channel {
        UpdateChannel::Stable => "Stable",
        UpdateChannel::Nightly => "Nightly",
    }
}

pub fn busy(state: Option<&UpdaterState>) -> bool {
    let Some(state) = state else {
        return false;
    };
    let phase = state.switch_check.as_ref().map(|check| check.phase);
    state.session_in_progress
        || matches!(
            phase,
            Some(
                SwitchPhase::Waiting
                    | SwitchPhase::Checking
                    | SwitchPhase::Downloading
                    | SwitchPhase::Installing
            )
        )
}

pub fn under_way(state: Option<&UpdaterState>) -> bool {
    matches!(
        state
            .and_then(|state| state.switch_check.as_ref())
            .map(|check| check.phase),
        Some(SwitchPhase::Downloading | SwitchPhase::Installing)
    )
}

pub fn check_now(state: Option<&UpdaterState>) -> CheckNow {
    let idle = CheckNow {
        title: "Check Now",
        checking: false,
        disabled: false,
        pressable: true,
    };
    let Some(state) = state.filter(|state| state.configured) else {
        return idle;
    };
    match state.switch_check.as_ref().map(|check| check.phase) {
        Some(SwitchPhase::Ready) => CheckNow {
            title: "Restart to Update",
            ..idle
        },
        Some(SwitchPhase::Downloading | SwitchPhase::Installing) => CheckNow {
            title: "Updating…",
            checking: true,
            disabled: false,
            pressable: false,
        },
        Some(SwitchPhase::Waiting | SwitchPhase::Checking) => CheckNow {
            title: "Checking…",
            checking: true,
            ..idle
        },
        _ if !state.can_check && state.session_in_progress => CheckNow {
            title: "Checking…",
            checking: true,
            disabled: false,
            pressable: false,
        },
        _ if state.can_check => idle,
        _ => CheckNow {
            disabled: true,
            pressable: false,
            ..idle
        },
    }
}

pub fn switch_check_line(state: Option<&UpdaterState>, app: &str) -> Option<String> {
    let state = state?;
    let check = state.switch_check.as_ref()?;
    let name = channel_title(check.channel);
    let current = &state.display_version;
    let version = check.version.as_deref();
    Some(match check.phase {
        SwitchPhase::Waiting => format!("Checking {name} once the current update finishes…"),
        SwitchPhase::Checking => format!("Checking {name}…"),
        SwitchPhase::Found => match version {
            Some(version) => format!("{app} {version} is available on {name}."),
            None => format!("An update is available on {name}."),
        },
        SwitchPhase::UpToDate => format!("You're up to date on {name}."),
        SwitchPhase::NewerThanLatest => match check.channel {
            UpdateChannel::Stable => format!(
                "{current} is newer than the latest Stable, so {app} stays on it until a newer Stable ships."
            ),
            UpdateChannel::Nightly => format!("You're up to date on {name}."),
        },
        SwitchPhase::Failed => format!("Couldn't check {name}. Try Check Now."),
        SwitchPhase::Downloading => match version {
            Some(version) => format!("Downloading {app} {version}…"),
            None => "Downloading the update…".to_owned(),
        },
        SwitchPhase::Installing => match version {
            Some(version) => format!("Installing {app} {version}…"),
            None => "Installing the update…".to_owned(),
        },
        SwitchPhase::Ready => match version {
            Some(version) => format!("{app} {version} is ready. Restart to finish updating."),
            None => "Restart to finish updating.".to_owned(),
        },
    })
}

pub fn last_check_line(last_check_ms: Option<f64>) -> String {
    let Some(ms) = last_check_ms.filter(|ms| ms.is_finite() && *ms > 0.0) else {
        return "Not checked yet.".to_owned();
    };
    let Some(when) = chrono::DateTime::from_timestamp_millis(ms as i64) else {
        return "Not checked yet.".to_owned();
    };
    let local = when.with_timezone(&chrono::Local);
    format!(
        "Last checked {}.",
        local.format("%b %-d, %Y, %-I:%M\u{202f}%p")
    )
}

pub fn status_line(state: Option<&UpdaterState>) -> Option<String> {
    let state = state.filter(|state| state.configured)?;
    Some(
        switch_check_line(Some(state), APP).unwrap_or_else(|| last_check_line(state.last_check_ms)),
    )
}

pub fn header_detail(view: &SettingsWindowView, title: &str) -> Option<&'static str> {
    if title != "Updates" {
        return None;
    }
    view.host
        .updater()
        .filter(|state| !state.configured)
        .map(|_| NOT_SET_UP)
}

pub fn version_title(view: &SettingsWindowView) -> SharedString {
    let version = match view.host.updater() {
        Some(state) => state.display_version,
        None => view
            .host
            .about()
            .map(|about| about.app_version)
            .unwrap_or_default(),
    };
    SharedString::from(format!("{APP} {version}"))
}

pub fn auto_update(view: &SettingsWindowView) -> AnyElement {
    let state = view.host.updater();
    let ready = state.as_ref().is_some_and(|state| state.configured);
    let on = ready
        && state
            .as_ref()
            .is_some_and(|state| state.automatic_checks && state.automatic_downloads);
    let emit = view.emit.clone();
    div()
        .debug_selector(|| "toggle:autoUpdate".into())
        .child(
            Toggle::new("toggle:autoUpdate", on, &view.look.p)
                .native(true)
                .disabled(!ready)
                .on_toggle(move |on, window, cx| {
                    emit.send(command(&format!("auto:{on}")), window, cx)
                }),
        )
        .into_any_element()
}

pub fn channel_picker(view: &SettingsWindowView) -> AnyElement {
    let channel = view
        .host
        .updater()
        .map_or(UpdateChannel::Stable, |state| state.channel);
    let selected = match channel {
        UpdateChannel::Stable => 0,
        UpdateChannel::Nightly => 1,
    };
    let emit = view.emit.clone();
    div()
        .debug_selector(|| "choice:updateChannel".into())
        .child(
            Segmented::new("choice:updateChannel", selected, &view.look.p)
                .option("Stable", None)
                .option("Nightly", None)
                .on_select(move |index, window, cx| {
                    let name = if index == 1 { "nightly" } else { "stable" };
                    emit.send(command(&format!("channel:{name}")), window, cx);
                }),
        )
        .into_any_element()
}

pub fn check_now_control(view: &SettingsWindowView) -> Option<AnyElement> {
    let state = view.host.updater()?;
    let control = check_now(Some(&state));
    let p = view.look.p;
    Some(
        div()
            .flex()
            .items_center()
            .gap(px(12.))
            .when(control.checking, |this| {
                this.child(spinner(CHECK_SPINNER, p.text_secondary))
            })
            .child(
                PushButton::new("updates-check-now", control.title, &p)
                    .disabled(control.disabled)
                    .when(control.pressable, |button| {
                        button.on_click(view.emit.click(command("check")))
                    }),
            )
            .into_any_element(),
    )
}

pub fn status_element(view: &SettingsWindowView) -> Option<AnyElement> {
    let line = status_line(view.host.updater().as_ref())?;
    Some(
        div()
            .mt(px(2.))
            .text_size(px(11.))
            .line_height(px(14.))
            .text_color(view.look.p.text_secondary)
            .child(line)
            .into_any_element(),
    )
}

fn command(action: &str) -> Msg {
    Msg::Command(SharedString::from(format!("{COMMAND}{action}")))
}

pub fn run(view: &mut SettingsWindowView, command: &str, cx: &mut Context<SettingsWindowView>) {
    let Some(action) = command.strip_prefix(COMMAND) else {
        return;
    };
    let Some(state) = view.host.updater() else {
        return;
    };
    match action {
        "auto:true" | "auto:false" => {
            if state.configured {
                view.host.set_automatic_updates(action == "auto:true");
            }
        }
        "channel:stable" | "channel:nightly" => {
            if state.configured {
                let channel = if action == "channel:nightly" {
                    UpdateChannel::Nightly
                } else {
                    UpdateChannel::Stable
                };
                view.host.set_update_channel(channel);
                follow(cx, true);
            }
        }
        "check" if check_now(Some(&state)).pressable => {
            view.host.check_for_updates();
            follow(cx, false);
        }
        _ => {}
    }
    cx.notify();
}

pub fn follow(cx: &mut Context<SettingsWindowView>, switched: bool) {
    cx.spawn(async move |this, cx| {
        let started = Instant::now();
        loop {
            let Ok(state) = this.update(cx, |view, cx| {
                cx.notify();
                view.host.updater()
            }) else {
                return;
            };
            let updating = under_way(state.as_ref());
            let limit = if updating {
                FOLLOW_UPDATE_FOR
            } else {
                FOLLOW_FOR
            };
            if !busy(state.as_ref()) || started.elapsed() > limit {
                if switched {
                    note_channel_switch(state.as_ref());
                }
                return;
            }
            let every = if updating {
                FOLLOW_UPDATE_EVERY
            } else {
                FOLLOW_EVERY
            };
            cx.background_executor().timer(every).await;
        }
    })
    .detach();
}

fn note_channel_switch(state: Option<&UpdaterState>) {
    ardia_telemetry::counts::count("update_channel_switches");
    let outcome = state
        .and_then(|state| state.switch_check.as_ref())
        .and_then(|check| match check.phase {
            SwitchPhase::Found
            | SwitchPhase::Downloading
            | SwitchPhase::Installing
            | SwitchPhase::Ready => Some("update_channel_switch_offers"),
            SwitchPhase::UpToDate | SwitchPhase::NewerThanLatest => {
                Some("update_channel_switch_up_to_date")
            }
            SwitchPhase::Failed => Some("update_channel_switch_check_failures"),
            SwitchPhase::Waiting | SwitchPhase::Checking => None,
        });
    if let Some(field) = outcome {
        ardia_telemetry::counts::count(field);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::UpdaterReport;

    fn state() -> UpdaterState {
        UpdaterState {
            configured: true,
            automatic_checks: true,
            automatic_downloads: true,
            can_check: true,
            session_in_progress: false,
            last_check_ms: None,
            version: "0.3.0".into(),
            display_version: "0.3.0".into(),
            channel: UpdateChannel::Stable,
            switch_check: None,
        }
    }

    fn with_phase(phase: SwitchPhase, version: Option<&str>) -> UpdaterState {
        UpdaterState {
            switch_check: Some(UpdaterReport {
                phase,
                channel: UpdateChannel::Stable,
                version: version.map(str::to_owned),
            }),
            ..state()
        }
    }

    #[test]
    fn check_now_titles_follow_the_old_update_status() {
        assert_eq!(check_now(None).title, "Check Now");
        let unset = UpdaterState {
            configured: false,
            ..state()
        };
        assert_eq!(check_now(Some(&unset)), check_now(None));
        assert_eq!(
            check_now(Some(&with_phase(SwitchPhase::Ready, None))).title,
            "Restart to Update"
        );
        let updating = check_now(Some(&with_phase(SwitchPhase::Downloading, None)));
        assert_eq!(
            (updating.title, updating.checking, updating.pressable),
            ("Updating…", true, false)
        );
        let checking = check_now(Some(&with_phase(SwitchPhase::Checking, None)));
        assert_eq!((checking.title, checking.pressable), ("Checking…", true));
        let session = UpdaterState {
            can_check: false,
            session_in_progress: true,
            ..state()
        };
        assert!(!check_now(Some(&session)).pressable);
        let blocked = UpdaterState {
            can_check: false,
            ..state()
        };
        let blocked = check_now(Some(&blocked));
        assert_eq!((blocked.title, blocked.disabled), ("Check Now", true));
    }

    #[test]
    fn switch_lines_match_the_old_copy() {
        let line = |phase, version| switch_check_line(Some(&with_phase(phase, version)), APP);
        assert_eq!(
            line(SwitchPhase::Waiting, None).as_deref(),
            Some("Checking Stable once the current update finishes…")
        );
        assert_eq!(
            line(SwitchPhase::Found, Some("0.4.0")).as_deref(),
            Some("Ardia 0.4.0 is available on Stable.")
        );
        assert_eq!(
            line(SwitchPhase::Found, None).as_deref(),
            Some("An update is available on Stable.")
        );
        assert_eq!(
            line(SwitchPhase::UpToDate, None).as_deref(),
            Some("You're up to date on Stable.")
        );
        assert_eq!(
            line(SwitchPhase::NewerThanLatest, None).as_deref(),
            Some(
                "0.3.0 is newer than the latest Stable, so Ardia stays on it until a newer Stable ships."
            )
        );
        assert_eq!(
            line(SwitchPhase::Failed, None).as_deref(),
            Some("Couldn't check Stable. Try Check Now.")
        );
        assert_eq!(
            line(SwitchPhase::Ready, Some("0.4.0")).as_deref(),
            Some("Ardia 0.4.0 is ready. Restart to finish updating.")
        );
        assert_eq!(switch_check_line(Some(&state()), APP), None);
    }

    #[test]
    fn status_shows_only_when_updates_are_set_up() {
        assert_eq!(
            status_line(Some(&state())).as_deref(),
            Some("Not checked yet.")
        );
        let unset = UpdaterState {
            configured: false,
            ..state()
        };
        assert_eq!(status_line(Some(&unset)), None);
        assert!(last_check_line(Some(1_700_000_000_000.0)).starts_with("Last checked "));
        assert!(busy(Some(&with_phase(SwitchPhase::Checking, None))));
        assert!(!busy(Some(&state())));
        assert!(under_way(Some(&with_phase(SwitchPhase::Installing, None))));
    }
}
