use std::collections::HashMap;

use gpui::{
    AnyElement, Context, Entity, Focusable, IntoElement, ParentElement, SharedString, Styled,
    Subscription, Window, div, prelude::*,
};

use crate::msg::Msg;
use crate::plugins::model::{SettingKind, SettingRow, SettingValue};
use crate::primitives::controls::{PopUp, PushButton, Toggle, text_field_box};
use crate::primitives::list::Row;
use crate::primitives::pop_up_menu::{self, PopUpChoice};
use crate::primitives::text_input::{InputEvent, TextInput, text_field_style};
use crate::scale::px;
use crate::settings::SettingsWindowView;
use crate::settings::extras::{self, COMMAND};
use crate::settings::rows::Pane;
use crate::settings::subpages::Detail;

pub const TEXT_WIDTH: f32 = 200.0;
pub const NUMBER_WIDTH: f32 = 120.0;
pub const SECRET_WIDTH: f32 = 180.0;
pub const CHOICE_MIN_WIDTH: f32 = 120.0;
pub const SECRET_DOTS: &str = "••••••••";
pub const SECRET_STORE: &str = "your Keychain";
pub const VERBS: &[&str] = &[
    "value",
    "saveField",
    "resetField",
    "saveSecret",
    "clearSecret",
];
const SEPARATOR: char = '\u{1f}';

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FieldKind {
    Text,
    Number,
    Secret,
}

pub struct ValueField {
    pub input: Entity<TextInput>,
    shown: String,
    pub draft: String,
    placeholder: String,
    kind: FieldKind,
    _subscriptions: Vec<Subscription>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SecretStatus {
    pub saved: Option<bool>,
    pub problem: Option<String>,
    pub busy: bool,
}

#[derive(Default)]
pub struct PluginValues {
    plugin: Option<String>,
    pub fields: HashMap<String, ValueField>,
    pub secrets: HashMap<String, SecretStatus>,
}

pub fn number_text(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    format!("{value}")
}

pub fn shown_text(row: &SettingRow) -> String {
    match (&row.kind, &row.value) {
        (SettingKind::Secret { .. }, _) => String::new(),
        (_, SettingValue::Text(text)) => text.clone(),
        (_, SettingValue::Number(n)) => number_text(*n),
        (_, SettingValue::Bool(on)) => on.to_string(),
    }
}

pub fn parse_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.contains("inf") || lowered.contains("nan") {
        return None;
    }
    let radix = [("0x", 16), ("0o", 8), ("0b", 2)]
        .into_iter()
        .find_map(|(prefix, radix)| lowered.strip_prefix(prefix).map(|digits| (digits, radix)));
    let parsed = match radix {
        Some((digits, radix)) if !digits.is_empty() => {
            u64::from_str_radix(digits, radix).ok().map(|n| n as f64)
        }
        Some(_) => None,
        None => lowered.parse::<f64>().ok(),
    };
    parsed.filter(|n| n.is_finite())
}

pub fn number_problem(
    min: Option<f64>,
    max: Option<f64>,
    step: Option<f64>,
    text: &str,
) -> Option<String> {
    let Some(n) = parse_number(text) else {
        return Some("Enter a number.".to_owned());
    };
    if let Some(min) = min
        && n < min
    {
        return Some(format!("At least {}.", number_text(min)));
    }
    if let Some(max) = max
        && n > max
    {
        return Some(format!("At most {}.", number_text(max)));
    }
    if let Some(step) = step.filter(|s| *s > 0.0) {
        let steps = (n - min.unwrap_or(0.0)) / step;
        if (steps - steps.round()).abs() > 1e-9 {
            return Some(format!("In steps of {}.", number_text(step)));
        }
    }
    None
}

pub fn range_text(min: Option<f64>, max: Option<f64>) -> String {
    [
        min.map(|m| format!("min {}", number_text(m))),
        max.map(|m| format!("max {}", number_text(m))),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ")
}

pub fn secret_status_text(status: &SecretStatus) -> Option<String> {
    if let Some(problem) = &status.problem {
        return Some(problem.clone());
    }
    status.saved.map(|saved| {
        if saved {
            format!("Saved in {SECRET_STORE}")
        } else {
            "Not set".to_owned()
        }
    })
}

fn joined(parts: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    let parts: Vec<String> = parts
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn command(verb: &str, plugin: &str, key: &str, extra: &str) -> Msg {
    Msg::Command(SharedString::from(format!(
        "{COMMAND}{verb}:{plugin}{SEPARATOR}{key}{SEPARATOR}{extra}"
    )))
}

pub fn value_command(plugin: &str, key: &str, value: &SettingValue) -> Msg {
    let json = match value {
        SettingValue::Bool(on) => serde_json::Value::Bool(*on),
        SettingValue::Text(text) => serde_json::Value::String(text.clone()),
        SettingValue::Number(n) => serde_json::json!(n),
    };
    command("value", plugin, key, &json.to_string())
}

fn value_of_json(text: &str) -> Option<SettingValue> {
    match serde_json::from_str::<serde_json::Value>(text).ok()? {
        serde_json::Value::Bool(on) => Some(SettingValue::Bool(on)),
        serde_json::Value::String(text) => Some(SettingValue::Text(text)),
        serde_json::Value::Number(n) => n.as_f64().map(SettingValue::Number),
        _ => None,
    }
}

fn shown_plugin(view: &SettingsWindowView) -> Option<String> {
    if view.pane != Pane::Plugins {
        return None;
    }
    match view.sub.detail.as_ref() {
        Some(Detail::Plugin(name)) => Some(name.clone()),
        _ => None,
    }
}

fn rows_of(view: &SettingsWindowView, plugin: &str) -> Vec<SettingRow> {
    view.host
        .plugins()
        .map(|plugins| plugins.setting_rows(plugin))
        .unwrap_or_default()
}

pub fn sync(
    view: &mut SettingsWindowView,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let plugin = shown_plugin(view);
    if view.extras.plugin_values.plugin != plugin {
        view.extras.plugin_values = PluginValues {
            plugin: plugin.clone(),
            ..PluginValues::default()
        };
    }
    let Some(plugin) = plugin else {
        return;
    };
    let rows = rows_of(view, &plugin);
    view.extras
        .plugin_values
        .fields
        .retain(|key, _| rows.iter().any(|row| &row.key == key));
    for row in &rows {
        let kind = match row.kind {
            SettingKind::Text => FieldKind::Text,
            SettingKind::Number { .. } => FieldKind::Number,
            SettingKind::Secret { .. } => FieldKind::Secret,
            SettingKind::Toggle | SettingKind::Choice { .. } => continue,
        };
        let shown = shown_text(row);
        let stale = view
            .extras
            .plugin_values
            .fields
            .get(&row.key)
            .is_none_or(|field| field.kind != kind);
        if stale {
            let field = new_field(view, &plugin, row, kind, &shown, window, cx);
            view.extras
                .plugin_values
                .fields
                .insert(row.key.clone(), field);
            if kind == FieldKind::Secret {
                check_secret(view, &plugin, &row.key, cx);
            }
        } else if let Some(field) = view.extras.plugin_values.fields.get_mut(&row.key)
            && kind != FieldKind::Secret
            && field.shown != shown
        {
            field.shown = shown.clone();
            put_text(field, shown, cx);
        }
        if kind == FieldKind::Secret {
            let saved = view
                .extras
                .plugin_values
                .secrets
                .get(&row.key)
                .is_some_and(|status| status.saved == Some(true));
            let placeholder = secret_placeholder(row, saved);
            if let Some(field) = view.extras.plugin_values.fields.get_mut(&row.key)
                && field.placeholder != placeholder
            {
                field.placeholder = placeholder.clone();
                field
                    .input
                    .update(cx, |input, cx| input.set_placeholder(placeholder, cx));
            }
        }
    }
}

pub fn secret_placeholder(row: &SettingRow, saved: bool) -> String {
    if saved {
        return SECRET_DOTS.to_owned();
    }
    match &row.kind {
        SettingKind::Secret { placeholder } => placeholder.clone().unwrap_or_default(),
        _ => String::new(),
    }
}

fn new_field(
    view: &SettingsWindowView,
    plugin: &str,
    row: &SettingRow,
    kind: FieldKind,
    shown: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) -> ValueField {
    let style = text_field_style(&view.look);
    let initial = shown.to_owned();
    let input = cx.new(|cx| {
        let mut input = TextInput::new("", cx);
        input.set_style(style, cx);
        input.set_secure(kind == FieldKind::Secret, cx);
        input.set_text(initial, false, cx);
        input
    });
    let (plugin, key) = (plugin.to_owned(), row.key.clone());
    let events = {
        let (plugin, key) = (plugin.clone(), key.clone());
        cx.subscribe_in(
            &input,
            window,
            move |view: &mut SettingsWindowView, input, event: &InputEvent, window, cx| match event
            {
                InputEvent::Changed { .. } => {
                    let text = input.read(cx).text().to_owned();
                    if let Some(field) = view.extras.plugin_values.fields.get_mut(&key) {
                        field.draft = text;
                    }
                    cx.notify();
                }
                InputEvent::Submit(_) => {
                    let verb = if kind == FieldKind::Secret {
                        "saveSecret"
                    } else {
                        "saveField"
                    };
                    run(
                        view,
                        verb,
                        &format!("{plugin}{SEPARATOR}{key}{SEPARATOR}"),
                        window,
                        cx,
                    );
                }
                InputEvent::Cancel if kind == FieldKind::Number => {
                    run(
                        view,
                        "resetField",
                        &format!("{plugin}{SEPARATOR}{key}{SEPARATOR}"),
                        window,
                        cx,
                    );
                }
                _ => {}
            },
        )
    };
    let mut subscriptions = vec![events];
    if kind != FieldKind::Secret {
        let handle = input.read(cx).focus_handle(cx);
        subscriptions.push(cx.on_blur(&handle, window, move |view, window, cx| {
            run(
                view,
                "saveField",
                &format!("{plugin}{SEPARATOR}{key}{SEPARATOR}"),
                window,
                cx,
            );
        }));
    }
    ValueField {
        input,
        shown: shown.to_owned(),
        draft: shown.to_owned(),
        placeholder: String::new(),
        kind,
        _subscriptions: subscriptions,
    }
}

fn check_secret(
    view: &mut SettingsWindowView,
    plugin: &str,
    key: &str,
    cx: &mut Context<SettingsWindowView>,
) {
    view.extras
        .plugin_values
        .secrets
        .insert(key.to_owned(), SecretStatus::default());
    let Some(plugins) = view.host.plugins() else {
        return;
    };
    let (plugin, key) = (plugin.to_owned(), key.to_owned());
    cx.spawn(async move |this, cx| {
        let (asked, asked_key) = (plugin.clone(), key.clone());
        let set = cx
            .background_spawn(async move { plugins.secret_row_is_set(&asked, &asked_key) })
            .await;
        let _ = this.update(cx, |view, cx| {
            if view.extras.plugin_values.plugin.as_deref() != Some(plugin.as_str()) {
                return;
            }
            if let Some(status) = view.extras.plugin_values.secrets.get_mut(&key)
                && status.saved.is_none()
            {
                status.saved = Some(set);
                cx.notify();
            }
        });
    })
    .detach();
}

fn write_secret(
    view: &mut SettingsWindowView,
    plugin: String,
    key: String,
    value: Option<String>,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(plugins) = view.host.plugins() else {
        return;
    };
    let status = view
        .extras
        .plugin_values
        .secrets
        .entry(key.clone())
        .or_default();
    if status.busy {
        return;
    }
    status.busy = true;
    cx.notify();
    cx.spawn(async move |this, cx| {
        let (asked, asked_key, written) = (plugin.clone(), key.clone(), value.clone());
        let outcome = cx
            .background_spawn(async move {
                plugins.set_secret_row(&asked, &asked_key, written.as_deref())
            })
            .await;
        let _ = this.update(cx, |view, cx| {
            if view.extras.plugin_values.plugin.as_deref() != Some(plugin.as_str()) {
                return;
            }
            let status = view
                .extras
                .plugin_values
                .secrets
                .entry(key.clone())
                .or_default();
            status.busy = false;
            match outcome {
                Err(problem) => status.problem = Some(problem),
                Ok(()) => {
                    status.problem = None;
                    status.saved = Some(value.as_deref().is_some_and(|v| !v.is_empty()));
                    if let Some(field) = view.extras.plugin_values.fields.get_mut(&key) {
                        put_text(field, String::new(), cx);
                    }
                }
            }
            cx.notify();
        });
    })
    .detach();
}

fn field_text(view: &SettingsWindowView, key: &str) -> Option<String> {
    view.extras
        .plugin_values
        .fields
        .get(key)
        .map(|field| field.draft.clone())
}

fn put_text(field: &mut ValueField, text: String, cx: &mut Context<SettingsWindowView>) {
    field.draft = text.clone();
    field
        .input
        .update(cx, |input, cx| input.set_text(text, false, cx));
}

fn reset_field(
    view: &mut SettingsWindowView,
    row: &SettingRow,
    cx: &mut Context<SettingsWindowView>,
) {
    let shown = shown_text(row);
    if let Some(field) = view.extras.plugin_values.fields.get_mut(&row.key) {
        field.shown = shown.clone();
        put_text(field, shown, cx);
    }
}

fn save_field(
    view: &mut SettingsWindowView,
    plugin: &str,
    row: &SettingRow,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(draft) = field_text(view, &row.key) else {
        return;
    };
    let Some(plugins) = view.host.plugins() else {
        return;
    };
    match &row.kind {
        SettingKind::Text => {
            if row.value != SettingValue::Text(draft.clone()) {
                plugins.set_setting(plugin, &row.key, SettingValue::Text(draft));
            }
        }
        SettingKind::Number { min, max, step } => {
            if number_problem(*min, *max, *step, &draft).is_some() {
                reset_field(view, row, cx);
                return;
            }
            if let Some(n) = parse_number(&draft)
                && row.value != SettingValue::Number(n)
                && !plugins.set_setting(plugin, &row.key, SettingValue::Number(n))
            {
                reset_field(view, row, cx);
            }
        }
        _ => {}
    }
}

pub fn run(
    view: &mut SettingsWindowView,
    verb: &str,
    argument: &str,
    _window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let mut parts = argument.splitn(3, SEPARATOR);
    let (Some(plugin), Some(key), extra) = (parts.next(), parts.next(), parts.next().unwrap_or(""))
    else {
        return;
    };
    if view.extras.plugin_values.plugin.as_deref() != Some(plugin) {
        return;
    }
    let Some(row) = rows_of(view, plugin).into_iter().find(|row| row.key == key) else {
        return;
    };
    let plugin = plugin.to_owned();
    match verb {
        "value" => {
            let Some(value) = value_of_json(extra) else {
                return;
            };
            let fits = matches!(
                (&row.kind, &value),
                (SettingKind::Toggle, SettingValue::Bool(_))
                    | (SettingKind::Choice { .. }, SettingValue::Text(_))
            );
            if fits
                && row.value != value
                && let Some(plugins) = view.host.plugins()
            {
                plugins.set_setting(&plugin, key, value);
            }
        }
        "saveField" => save_field(view, &plugin, &row, cx),
        "resetField" => reset_field(view, &row, cx),
        "saveSecret" => {
            let draft = field_text(view, key).unwrap_or_default();
            if matches!(row.kind, SettingKind::Secret { .. }) && !draft.is_empty() {
                write_secret(view, plugin, row.key.clone(), Some(draft), cx);
            }
        }
        "clearSecret" => {
            if matches!(row.kind, SettingKind::Secret { .. }) {
                write_secret(view, plugin, row.key.clone(), None, cx);
            }
        }
        _ => {}
    }
    cx.notify();
}

fn value_row(id: String, row: &SettingRow, p: &crate::look::Palette) -> Row {
    let built = Row::new(gpui::ElementId::Name(id.into()), p)
        .native(true)
        .title(row.title.clone());
    match &row.description {
        Some(description) if !description.is_empty() => built.description(description.clone()),
        _ => built,
    }
}

fn tagged(selector: String, element: impl IntoElement) -> AnyElement {
    div()
        .debug_selector(move || selector)
        .child(element)
        .into_any_element()
}

fn with_description(built: Row, line: Option<String>) -> Row {
    match line {
        Some(line) => built.description(line),
        None => built,
    }
}

fn field_box(view: &SettingsWindowView, key: &str, width: f32, invalid: bool) -> AnyElement {
    let p = view.look.p;
    let selector = format!("field:pluginValue:{key}");
    let input = view
        .extras
        .plugin_values
        .fields
        .get(key)
        .map(|field| field.input.clone());
    text_field_box(&p, invalid)
        .debug_selector(move || selector)
        .w(px(width))
        .children(input.map(|input| div().flex_1().min_w_0().child(input)))
        .into_any_element()
}

fn toggle_row(view: &SettingsWindowView, plugin: &str, row: &SettingRow) -> AnyElement {
    let p = view.look.p;
    let on = row.value == SettingValue::Bool(true);
    let emit = view.emit.clone();
    let (plugin, key) = (plugin.to_owned(), row.key.clone());
    let selector = format!("toggle:pluginValue:{key}");
    value_row(format!("plugin-value:{key}"), row, &p)
        .child(
            div().debug_selector(move || selector).child(
                Toggle::new(
                    SharedString::from(format!("toggle:pluginValue:{key}")),
                    on,
                    &p,
                )
                .native(true)
                .on_toggle(move |on, window, cx| {
                    emit.send(
                        value_command(&plugin, &key, &SettingValue::Bool(on)),
                        window,
                        cx,
                    )
                }),
            ),
        )
        .into_any_element()
}

pub fn choice_items(plugin: &str, row: &SettingRow) -> Vec<PopUpChoice> {
    let SettingKind::Choice { choices } = &row.kind else {
        return Vec::new();
    };
    choices
        .iter()
        .map(|(value, title)| {
            let picked = SettingValue::Text(value.clone());
            PopUpChoice::new(
                title.clone(),
                row.value == picked,
                vec![value_command(plugin, &row.key, &picked)],
            )
            .value(value.clone())
        })
        .collect()
}

fn choice_row(view: &SettingsWindowView, plugin: &str, row: &SettingRow) -> AnyElement {
    let p = view.look.p;
    let key = row.key.clone();
    let items = choice_items(plugin, row);
    let label = items
        .iter()
        .find(|item| item.checked)
        .map(|item| item.title.clone())
        .unwrap_or_default();
    let selector = format!("popup:pluginValue:{key}");
    value_row(format!("plugin-value:{key}"), row, &p)
        .child(
            div().debug_selector(move || selector).child(
                PopUp::new(
                    SharedString::from(format!("popup:pluginValue:{key}")),
                    label,
                    &p,
                )
                .min_width(CHOICE_MIN_WIDTH)
                .native(true)
                .on_click(pop_up_menu::opener(
                    &view.host,
                    &view.emit,
                    items,
                    Msg::Command(SharedString::new_static("settings:extras:noNativeMenu")),
                )),
            ),
        )
        .into_any_element()
}

fn text_row(view: &SettingsWindowView, row: &SettingRow) -> AnyElement {
    let p = view.look.p;
    value_row(format!("plugin-value:{}", row.key), row, &p)
        .child(field_box(view, &row.key, TEXT_WIDTH, false))
        .into_any_element()
}

fn number_row(view: &SettingsWindowView, row: &SettingRow) -> AnyElement {
    let p = view.look.p;
    let SettingKind::Number { min, max, step } = row.kind else {
        return div().into_any_element();
    };
    let shown = shown_text(row);
    let draft = field_text(view, &row.key).unwrap_or_else(|| shown.clone());
    let problem = number_problem(min, max, step, &draft);
    let range = range_text(min, max);
    let note = match &problem {
        Some(problem) if draft != shown => Some(problem.clone()),
        _ => Some(range).filter(|r| !r.is_empty()),
    };
    let built = Row::new(
        gpui::ElementId::Name(format!("plugin-value:{}", row.key).into()),
        &p,
    )
    .native(true)
    .title(row.title.clone());
    with_description(built, joined([row.description.clone(), note]))
        .child(field_box(view, &row.key, NUMBER_WIDTH, problem.is_some()))
        .into_any_element()
}

fn secret_row(view: &SettingsWindowView, plugin: &str, row: &SettingRow) -> AnyElement {
    let p = view.look.p;
    let key = row.key.clone();
    let status = view
        .extras
        .plugin_values
        .secrets
        .get(&key)
        .cloned()
        .unwrap_or_default();
    let draft = field_text(view, &key).unwrap_or_default();
    let built = Row::new(
        gpui::ElementId::Name(format!("plugin-value:{key}").into()),
        &p,
    )
    .native(true)
    .title(row.title.clone());
    let save = command("saveSecret", plugin, &key, "");
    let clear = command("clearSecret", plugin, &key, "");
    with_description(
        built,
        joined([row.description.clone(), secret_status_text(&status)]),
    )
    .child(
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(field_box(view, &key, SECRET_WIDTH, false))
            .child(tagged(
                format!("pluginSecret-save:{key}"),
                PushButton::new(
                    SharedString::from(format!("pluginSecret-save:{key}")),
                    "Save",
                    &p,
                )
                .disabled(draft.is_empty() || status.busy)
                .on_click(view.emit.click(save)),
            ))
            .when(status.saved == Some(true), |this| {
                this.child(tagged(
                    format!("pluginSecret-clear:{key}"),
                    PushButton::new(
                        SharedString::from(format!("pluginSecret-clear:{key}")),
                        "Clear",
                        &p,
                    )
                    .disabled(status.busy)
                    .on_click(view.emit.click(clear)),
                ))
            }),
    )
    .into_any_element()
}

pub fn section(view: &SettingsWindowView, plugin: &str) -> Vec<AnyElement> {
    let rows = rows_of(view, plugin);
    if rows.is_empty() {
        return Vec::new();
    }
    let p = view.look.p;
    let elements = rows
        .iter()
        .map(|row| {
            let element = match row.kind {
                SettingKind::Toggle => toggle_row(view, plugin, row),
                SettingKind::Choice { .. } => choice_row(view, plugin, row),
                SettingKind::Number { .. } => number_row(view, row),
                SettingKind::Secret { .. } => secret_row(view, plugin, row),
                SettingKind::Text => text_row(view, row),
            };
            let selector = format!("plugin-value:{}", row.key);
            div()
                .debug_selector(move || selector)
                .child(element)
                .into_any_element()
        })
        .collect();
    vec![
        extras::section(&p, "Settings"),
        extras::rows_group(&p, elements),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_anchor_aliases_follow_the_pin() {
        let pin: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../apps/browser/official-plugins.json"
        ))
        .expect("the pin parses");
        let mut wanted: Vec<(String, String)> = Vec::new();
        for plugin in pin["plugins"].as_array().into_iter().flatten() {
            let name = plugin["name"].as_str().unwrap_or_default();
            for alias in plugin["anchorAliases"].as_array().into_iter().flatten() {
                wanted.push((
                    format!("plugins.{}", alias.as_str().unwrap_or_default()),
                    format!("plugins.{name}"),
                ));
            }
        }
        let have: Vec<(String, String)> = crate::settings::rows::SETTING_ALIASES
            .iter()
            .map(|(a, t)| ((*a).to_owned(), (*t).to_owned()))
            .collect();
        assert_eq!(have, wanted);
        assert_eq!(
            crate::settings::rows::find("plugins.commandLine").map(|r| r.id),
            Some("plugins.cli")
        );
    }

    #[test]
    fn an_unsaved_turn_on_reads_like_the_old_status() {
        let detail = crate::host::PluginDetail {
            name: "demo".into(),
            loads: true,
            unsaved: true,
            description: "Does things".into(),
            ..crate::host::PluginDetail::default()
        };
        assert_eq!(extras::status_of(&detail, true), extras::UNSAVED);
        let on = crate::host::PluginDetail {
            active: true,
            ..detail
        };
        assert_eq!(extras::status_of(&on, true), "Does things");
    }

    #[test]
    fn numbers_print_like_javascript_strings() {
        assert_eq!(number_text(5.0), "5");
        assert_eq!(number_text(0.5), "0.5");
        assert_eq!(number_text(-0.0), "0");
        assert_eq!(number_text(-12.25), "-12.25");
    }

    #[test]
    fn number_problems_match_the_old_number_row() {
        assert_eq!(
            number_problem(None, None, None, "").as_deref(),
            Some("Enter a number.")
        );
        assert_eq!(
            number_problem(None, None, None, "  ").as_deref(),
            Some("Enter a number.")
        );
        assert_eq!(
            number_problem(None, None, None, "abc").as_deref(),
            Some("Enter a number.")
        );
        assert_eq!(
            number_problem(None, None, None, "Infinity").as_deref(),
            Some("Enter a number.")
        );
        assert_eq!(
            number_problem(None, None, None, "NaN").as_deref(),
            Some("Enter a number.")
        );
        assert_eq!(
            number_problem(Some(1.0), None, None, "0").as_deref(),
            Some("At least 1.")
        );
        assert_eq!(
            number_problem(None, Some(10.0), None, "11").as_deref(),
            Some("At most 10.")
        );
        assert_eq!(
            number_problem(Some(1.0), None, Some(2.0), "4").as_deref(),
            Some("In steps of 2.")
        );
        assert_eq!(number_problem(Some(1.0), None, Some(2.0), "5"), None);
        assert_eq!(number_problem(None, None, Some(0.1), "0.3"), None);
        assert_eq!(number_problem(None, None, None, " 42 "), None);
        assert_eq!(number_problem(None, None, None, "1e3"), None);
        assert_eq!(parse_number("0x10"), Some(16.0));
        assert_eq!(parse_number("0x"), None);
    }

    #[test]
    fn range_and_secret_lines_match_the_old_copy() {
        assert_eq!(range_text(Some(1.0), Some(5.0)), "min 1, max 5");
        assert_eq!(range_text(None, Some(5.0)), "max 5");
        assert_eq!(range_text(None, None), "");
        assert_eq!(secret_status_text(&SecretStatus::default()), None);
        assert_eq!(
            secret_status_text(&SecretStatus {
                saved: Some(true),
                ..SecretStatus::default()
            })
            .as_deref(),
            Some("Saved in your Keychain")
        );
        assert_eq!(
            secret_status_text(&SecretStatus {
                saved: Some(false),
                ..SecretStatus::default()
            })
            .as_deref(),
            Some("Not set")
        );
        assert_eq!(
            secret_status_text(&SecretStatus {
                saved: Some(true),
                problem: Some("The Keychain didn't save it.".into()),
                busy: false,
            })
            .as_deref(),
            Some("The Keychain didn't save it.")
        );
    }

    #[test]
    fn hostile_command_payloads_are_rejected() {
        assert_eq!(value_of_json("{\"a\":1}"), None);
        assert_eq!(value_of_json("[1]"), None);
        assert_eq!(value_of_json("null"), None);
        assert_eq!(value_of_json("not json"), None);
        assert_eq!(value_of_json("true"), Some(SettingValue::Bool(true)));
    }

    #[test]
    fn choices_check_the_current_value_and_carry_its_command() {
        let row = SettingRow {
            key: "side".into(),
            title: "Side".into(),
            description: None,
            kind: SettingKind::Choice {
                choices: vec![
                    ("left".into(), "Left".into()),
                    ("right".into(), "Right".into()),
                ],
            },
            value: SettingValue::Text("right".into()),
        };
        let items = choice_items("demo", &row);
        assert_eq!(items.len(), 2);
        assert!(!items[0].checked);
        assert!(items[1].checked);
        assert_eq!(items[0].value.as_deref(), Some("left"));
        assert_eq!(
            items[0].msgs,
            vec![value_command(
                "demo",
                "side",
                &SettingValue::Text("left".into())
            )]
        );
    }
}
