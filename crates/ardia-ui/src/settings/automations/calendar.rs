use ardia_state::Action;
use ardia_state::live::{AlertCondition, CalendarPatch};
use ardia_state::settings::SettingsPatch;
use gpui::{AnyElement, IntoElement, ParentElement, SharedString, Styled, div, prelude::*};

use crate::live::{CalendarAccess, CalendarCommand, CalendarView, SystemCalendar};
use crate::msg::Msg;
use crate::primitives::controls::{ButtonKind, Checkbox, PushButton, Toggle};
use crate::primitives::icons::{Icon, symbol_icon};
use crate::scale::px;
use crate::settings::SettingsWindowView;
use crate::settings::panes::Block;

use super::parts::{Choice, RowSpec, block, command, group, popup, section_header};

pub const ALERT_LEADS: &[(&str, &str)] = &[
    ("never", "Never"),
    ("start", "At Meeting Start"),
    ("1", "One Minute Before"),
    ("2", "Two Minutes Before"),
    ("3", "Three Minutes Before"),
    ("5", "Five Minutes Before"),
    ("10", "Ten Minutes Before"),
];
pub const COUNTDOWN_OFF: &str = "off";
pub const DEFAULT_DENIED: &str = "Ardia isn't allowed to read your calendars. Allow it in System Settings \u{203a} Privacy & Security \u{203a} Calendars.";

pub fn access_line(calendar: &CalendarView) -> String {
    let count = calendar.calendars.len();
    match calendar.access {
        CalendarAccess::Fixture => "Development build: using calendar-fixture.json".into(),
        access if access.connected() => format!(
            "Connected \u{b7} {}",
            if count == 1 {
                "1 calendar".to_owned()
            } else {
                format!("{count} calendars")
            }
        ),
        access if access.blocked() => calendar
            .request_error
            .clone()
            .unwrap_or_else(|| DEFAULT_DENIED.into()),
        _ => calendar
            .request_error
            .clone()
            .unwrap_or_else(|| "Not connected".into()),
    }
}

pub fn countdown_value(settings: &ardia_state::live::CalendarSettings) -> String {
    if settings.show_time_to_next {
        settings.countdown_lead.to_string()
    } else {
        COUNTDOWN_OFF.into()
    }
}

pub fn countdown_patch(value: &str) -> CalendarPatch {
    match value.parse::<i64>() {
        Ok(minutes) if value != COUNTDOWN_OFF => CalendarPatch {
            show_time_to_next: Some(true),
            countdown_lead: Some(minutes),
            ..CalendarPatch::default()
        },
        _ => CalendarPatch {
            show_time_to_next: Some(false),
            ..CalendarPatch::default()
        },
    }
}

fn patch_msg(key: &str, value: &str) -> Msg {
    command("calendarPatch", &format!("{key}={value}"))
}

pub fn patch(view: &SettingsWindowView, argument: &str) {
    let Some((key, value)) = argument.split_once('=') else {
        return;
    };
    let patch = match key {
        "alertLead" => CalendarPatch {
            alert_lead: Some(value.to_owned()),
            ..CalendarPatch::default()
        },
        "alertCondition" => CalendarPatch {
            alert_condition: Some(if value == "activeOnly" {
                AlertCondition::ActiveOnly
            } else {
                AlertCondition::Always
            }),
            ..CalendarPatch::default()
        },
        "showPreview" => CalendarPatch {
            show_preview: Some(value == "true"),
            ..CalendarPatch::default()
        },
        "countdown" => countdown_patch(value),
        _ => return,
    };
    view.host
        .live_command(ardia_state::live::LiveCommand::UpdateCalendar { patch });
}

pub fn connect(view: &SettingsWindowView) {
    view.host.calendar_command(CalendarCommand::Connect);
}

pub fn open_privacy(view: &SettingsWindowView) {
    view.host
        .calendar_command(CalendarCommand::OpenPrivacySettings);
}

pub fn set_hidden(view: &SettingsWindowView, argument: &str) {
    let Some((calendar, shown)) = argument.rsplit_once('=') else {
        return;
    };
    view.host.calendar_command(CalendarCommand::SetHidden {
        calendar: calendar.to_owned(),
        hidden: shown != "true",
    });
}

fn privacy_button(view: &SettingsWindowView) -> AnyElement {
    PushButton::new("calendar-privacy", "Open System Settings", &view.look.p)
        .on_click(view.emit.click(command("calendarPrivacy", "")))
        .into_any_element()
}

fn access_row(view: &SettingsWindowView, calendar: &CalendarView) -> AnyElement {
    let p = view.look.p;
    let mut row = RowSpec::new("setting:automations.calendarAccess")
        .anchor("automations.calendarAccess")
        .title("Calendar access")
        .description(Some(access_line(calendar)));
    if calendar.access.blocked() {
        row = row.control(privacy_button(view));
    } else if !calendar.access.connected() {
        if calendar.request_error.is_some() {
            row = row.control(privacy_button(view));
        }
        row = row.control(
            div().debug_selector(|| "calendar-connect".into()).child(
                PushButton::new(
                    "calendar-connect",
                    if calendar.requesting {
                        "Connecting\u{2026}"
                    } else {
                        "Connect Calendar\u{2026}"
                    },
                    &p,
                )
                .kind(ButtonKind::Primary)
                .disabled(calendar.requesting)
                .on_click(view.emit.click(command("calendarConnect", ""))),
            ),
        );
    }
    row.render(view)
}

fn toggle(
    view: &SettingsWindowView,
    id: &'static str,
    on: bool,
    msg: impl Fn(bool) -> Msg + 'static,
) -> AnyElement {
    let emit = view.emit.clone();
    div()
        .debug_selector(move || format!("toggle:{id}"))
        .child(
            Toggle::new(SharedString::from(format!("toggle:{id}")), on, &view.look.p)
                .native(true)
                .on_toggle(move |value, window, cx| emit.send(msg(value), window, cx)),
        )
        .into_any_element()
}

fn calendar_rows(view: &SettingsWindowView, calendar: &CalendarView) -> Vec<AnyElement> {
    let mut rows = vec![access_row(view, calendar)];
    if !calendar.access.connected() {
        return rows;
    }
    let live = view
        .host
        .live()
        .map(|l| l.calendar.clone())
        .unwrap_or_default();
    let alert_items = ALERT_LEADS
        .iter()
        .map(|(value, title)| {
            Choice::new(
                *title,
                live.alert_lead == *value,
                patch_msg("alertLead", value),
            )
            .after_separator(*value == "start")
        })
        .collect();
    rows.push(
        RowSpec::new("setting:automations.meetingAlert")
            .anchor("automations.meetingAlert")
            .title("Meeting alert")
            .control(popup(view, "auto:meetingAlert", 170., false, alert_items))
            .render(view),
    );
    let active = live.alert_condition == AlertCondition::ActiveOnly;
    rows.push(
        RowSpec::new("setting:automations.meetingAlertCondition")
            .anchor("automations.meetingAlertCondition")
            .title("Show alerts")
            .description(Some(
                "With Always, alerts also show while you're in another app.",
            ))
            .control(popup(
                view,
                "auto:meetingAlertCondition",
                170.,
                live.alert_lead == "never",
                vec![
                    Choice::new("Always", !active, patch_msg("alertCondition", "always")),
                    Choice::new(
                        "Only When Active",
                        active,
                        patch_msg("alertCondition", "activeOnly"),
                    ),
                ],
            ))
            .render(view),
    );
    rows.push(
        RowSpec::new("setting:automations.calendarPreview")
            .anchor("automations.calendarPreview")
            .title("Show calendar preview")
            .control(toggle(view, "calendarPreview", live.show_preview, |on| {
                patch_msg("showPreview", if on { "true" } else { "false" })
            }))
            .render(view),
    );
    let countdown = countdown_value(&live);
    let mut countdown_items = vec![Choice::new(
        "Off",
        countdown == COUNTDOWN_OFF,
        patch_msg("countdown", COUNTDOWN_OFF),
    )];
    countdown_items.extend(crate::live::COUNTDOWN_LEADS.iter().enumerate().map(
        |(index, minutes)| {
            Choice::new(
                crate::live::countdown_lead_title(*minutes),
                countdown == minutes.to_string(),
                patch_msg("countdown", &minutes.to_string()),
            )
            .after_separator(index == 0)
        },
    ));
    rows.push(
        RowSpec::new("setting:automations.countdown")
            .anchor("automations.countdown")
            .title("Countdown to next meeting")
            .control(popup(view, "auto:countdown", 170., false, countdown_items))
            .render(view),
    );
    let grouped = view.state.settings.auto_group_meeting_tabs;
    rows.push(
        RowSpec::new("setting:automations.groupMeetingTabs")
            .anchor("automations.groupMeetingTabs")
            .title("Group tabs for meetings")
            .control(toggle(view, "groupMeetingTabs", grouped, |on| {
                Msg::Store(Action::UpdateSettings {
                    patch: SettingsPatch::new().set("autoGroupMeetingTabs", on),
                    from_sync: false,
                })
            }))
            .render(view),
    );
    rows
}

fn calendar_list(
    view: &SettingsWindowView,
    title: &'static str,
    calendars: &[&SystemCalendar],
    hidden: &[String],
) -> AnyElement {
    let p = view.look.p;
    div()
        .py(px(6.))
        .child(
            div()
                .ml(px(12.))
                .mb(px(2.))
                .text_size(px(11.))
                .line_height(px(14.))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(p.text_secondary)
                .child(title),
        )
        .children(calendars.iter().map(|calendar| {
            let shown = !hidden.contains(&calendar.id);
            let id = calendar.id.clone();
            let emit = view.emit.clone();
            RowSpec::new(SharedString::from(format!("calendar:{}", calendar.id)))
                .icon(
                    div()
                        .size(px(10.))
                        .rounded(px(2.))
                        .bg(color_of(&calendar.color, p.text_tertiary)),
                )
                .title_element(
                    Checkbox::new(
                        SharedString::from(format!("calendar-check:{}", calendar.id)),
                        shown,
                        SharedString::from(calendar.title.clone()),
                        &p,
                    )
                    .on_toggle(move |on, window, cx| {
                        emit.send(command("calendarHidden", &format!("{id}={on}")), window, cx)
                    }),
                )
                .description(Some(calendar.account.clone()))
                .render(view)
        }))
        .into_any_element()
}

pub fn color_of(text: &str, fallback: gpui::Hsla) -> gpui::Hsla {
    let hex = text.trim().trim_start_matches('#');
    if hex.len() != 6 {
        return fallback;
    }
    u32::from_str_radix(hex, 16)
        .map(|value| gpui::rgb(value).into())
        .unwrap_or(fallback)
}

pub fn blocks(view: &SettingsWindowView) -> Vec<Block> {
    let p = view.look.p;
    let calendar = view
        .host
        .calendar()
        .map(|c| (*c).clone())
        .unwrap_or_default();
    let mut blocks = vec![
        block(
            vec![],
            section_header(
                view,
                None,
                "Calendar",
                Some(
                    "Pin a calendar to see your day, a countdown and meeting alerts. Uses the Calendar app's accounts.",
                ),
            ),
        ),
        block(
            vec![
                "automations.calendarAccess",
                "automations.meetingAlert",
                "automations.meetingAlertCondition",
                "automations.calendarPreview",
                "automations.countdown",
                "automations.groupMeetingTabs",
            ],
            group(&p, calendar_rows(view, &calendar)),
        ),
    ];
    let hidden = view
        .host
        .live()
        .map(|l| l.calendar.hidden_calendar_ids.clone())
        .unwrap_or_default();
    let connected = calendar.access.connected();
    let owned: Vec<&SystemCalendar> = calendar.calendars.iter().filter(|c| c.owned).collect();
    let others: Vec<&SystemCalendar> = calendar.calendars.iter().filter(|c| !c.owned).collect();
    let active = if connected && !calendar.calendars.is_empty() {
        let mut lists = Vec::new();
        if !owned.is_empty() {
            lists.push(calendar_list(view, "My Calendars", &owned, &hidden));
        }
        if !others.is_empty() {
            lists.push(calendar_list(view, "Other Calendars", &others, &hidden));
        }
        div()
            .child(section_header(
                view,
                None,
                "Active calendars",
                Some("Meetings from unchecked calendars don't show or alert."),
            ))
            .child(group(&p, lists))
            .into_any_element()
    } else if connected {
        div()
            .debug_selector(|| "calendar-none".into())
            .mt(px(16.))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(6.))
            .child(symbol_icon("calendar", Icon::Clock, 24., p.text_tertiary))
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .child("No calendars found"),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(p.text_secondary)
                    .child("Add accounts in the Calendar app."),
            )
            .into_any_element()
    } else {
        div().into_any_element()
    };
    blocks.push(block(vec![], active));
    blocks
}
