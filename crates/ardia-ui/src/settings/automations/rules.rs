use ardia_state::air_traffic::{
    AirTrafficConfig, LinkCondition, MAX_RULES, OpenAs, Rule, SourceApp, Target, link_text_problem,
    pattern_problem, site_host,
};
use ardia_state::link_routing::{
    CLOSED_GROUP, CONDITION_CHOICES, ConditionKind, OPEN_CHOICES, USED_LAST, condition_label,
    condition_text, from_label, open_from_key, pickable_apps, routable_profiles, route_groups,
    rule_problem, source_app_key, target_label, typed_app,
};
use ardia_state::{Action, ProfileId, RuleId};
use gpui::{
    AnyElement, Context, IntoElement, ParentElement, SharedString, Styled, Window, div, prelude::*,
};

use crate::msg::Msg;
use crate::primitives::controls::{ButtonKind, IconButton, PushButton, Toggle};
use crate::primitives::icons::Icon;
use crate::primitives::sheets::{Dialog, dialog_actions, dialog_title};
use crate::primitives::text_input::focus_input;
use crate::primitives::tokens::SheetSize;
use crate::scale::px;
use crate::settings::SettingsWindowView;

use super::parts::{Choice, RowSpec, anchored_menu, command, field, sheet_popup};
use super::{Field, text};

pub const ANY_APP: &str = "any";
pub const OTHER_APP: &str = "other";
pub const UNSAVED: &str = "Ardia couldn't save the rule. Your changes are still here; try again.";
const LABEL_WIDTH: f32 = 52.;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleSheet {
    pub editing: Option<RuleId>,
    pub enabled: bool,
    pub from: Option<SourceApp>,
    pub typing: bool,
    pub kind: ConditionKind,
    pub profile: Option<ProfileId>,
    pub open: OpenAs,
    pub group: Option<String>,
    pub error: Option<String>,
}

impl RuleSheet {
    pub fn grouped(&self) -> bool {
        self.profile.is_some() && self.open == OpenAs::Tab
    }
}

fn new_rule_id() -> RuleId {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let salt = base36(u128::from(since.subsec_nanos()) * 7919 + u128::from(count) * 104_729);
    let salt: String = format!("{salt:0>5}").chars().rev().take(5).collect();
    RuleId::new(format!("r{}{}", base36(since.as_millis()), salt))
}

fn base36(mut value: u128) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn config(view: &SettingsWindowView) -> AirTrafficConfig {
    (*view.state.air_traffic).clone()
}

fn store(view: &SettingsWindowView, config: AirTrafficConfig) {
    view.host.dispatch(Action::SetAirTraffic { config });
}

pub fn open(
    view: &mut SettingsWindowView,
    rule: Option<&str>,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let existing = rule.and_then(|id| {
        view.state
            .air_traffic
            .rules
            .iter()
            .find(|r| r.id == id)
            .cloned()
    });
    if rule.is_some() && existing.is_none() {
        return;
    }
    let first_profile = routable_profiles(&view.state)
        .first()
        .map(|(id, _)| id.clone());
    let sheet = match &existing {
        Some(rule) => RuleSheet {
            editing: Some(rule.id.clone()),
            enabled: rule.enabled,
            from: rule.from.clone(),
            typing: false,
            kind: ConditionKind::of(&rule.when),
            profile: rule.target.profile_id.clone(),
            open: rule.target.open,
            group: rule.target.group_key.clone(),
            error: None,
        },
        None => RuleSheet {
            editing: None,
            enabled: true,
            from: None,
            typing: false,
            kind: ConditionKind::Any,
            profile: first_profile,
            open: OpenAs::Tab,
            group: None,
            error: None,
        },
    };
    let condition = existing
        .as_ref()
        .map(|r| condition_text(&r.when).to_owned())
        .unwrap_or_default();
    let kind = sheet.kind;
    view.automations.fields.rule_text.update(cx, |input, cx| {
        input.set_placeholder(kind.placeholder(), cx);
        input.set_text(condition, false, cx);
    });
    view.automations
        .fields
        .rule_app
        .update(cx, |input, cx| input.set_text("", false, cx));
    view.automations.rule_sheet = Some(sheet);
    view.menu = None;
    let _ = window;
    cx.notify();
}

pub fn pick_from(
    view: &mut SettingsWindowView,
    key: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let recent = view.host.recent_source_apps();
    let Some(sheet) = view.automations.rule_sheet.as_mut() else {
        return;
    };
    sheet.error = None;
    match key {
        OTHER_APP => {
            sheet.typing = true;
            let input = view.automations.fields.rule_app.clone();
            cx.defer_in(window, move |_, window, cx| focus_input(&input, window, cx));
        }
        ANY_APP => {
            sheet.typing = false;
            sheet.from = None;
        }
        key => {
            let lists = pickable_apps(&recent, std::slice::from_ref(&sheet.from));
            if let Some(app) = lists
                .recent
                .iter()
                .chain(lists.common.iter())
                .find(|app| source_app_key(app) == key)
            {
                sheet.typing = false;
                sheet.from = Some(app.clone());
            }
        }
    }
}

pub fn pick_kind(
    view: &mut SettingsWindowView,
    key: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(kind) = ConditionKind::from_key(key) else {
        return;
    };
    let Some(sheet) = view.automations.rule_sheet.as_mut() else {
        return;
    };
    sheet.kind = kind;
    sheet.error = None;
    view.automations.fields.rule_text.update(cx, |input, cx| {
        input.set_placeholder(kind.placeholder(), cx)
    });
    let _ = window;
}

pub fn pick_profile(
    view: &mut SettingsWindowView,
    key: &str,
    cx: &mut Context<SettingsWindowView>,
) {
    let profile = (!key.is_empty()).then(|| ProfileId::from(key.to_owned()));
    if let Some(sheet) = view.automations.rule_sheet.as_mut() {
        sheet.profile = profile;
        sheet.group = None;
    }
    cx.notify();
}

pub fn pick_open(view: &mut SettingsWindowView, key: &str, cx: &mut Context<SettingsWindowView>) {
    if let (Some(open), Some(sheet)) = (open_from_key(key), view.automations.rule_sheet.as_mut()) {
        sheet.open = open;
    }
    cx.notify();
}

pub fn pick_group(view: &mut SettingsWindowView, key: &str, cx: &mut Context<SettingsWindowView>) {
    if let Some(sheet) = view.automations.rule_sheet.as_mut() {
        sheet.group = (!key.is_empty()).then(|| key.to_owned());
    }
    cx.notify();
}

pub fn condition_from(kind: ConditionKind, typed: &str) -> Result<LinkCondition, String> {
    match kind {
        ConditionKind::Any => Ok(LinkCondition::Any),
        ConditionKind::Site => site_host(typed)
            .map(LinkCondition::Site)
            .ok_or_else(|| "Enter a site, like github.com. Its subdomains count too.".to_owned()),
        ConditionKind::Pattern => match pattern_problem(typed) {
            Some(problem) => Err(format!("That pattern doesn't work: {problem}.")),
            None => Ok(LinkCondition::Pattern(typed.trim().to_owned())),
        },
        ConditionKind::Contains | ConditionKind::Equals => {
            let equals = kind == ConditionKind::Equals;
            match link_text_problem(equals, typed) {
                Some(problem) => Err(format!("That doesn't work: {problem}.")),
                None if equals => Ok(LinkCondition::Equals(typed.trim().to_owned())),
                None => Ok(LinkCondition::Contains(typed.trim().to_owned())),
            }
        }
    }
}

pub fn saved_config(
    current: &AirTrafficConfig,
    sheet: &RuleSheet,
    typed_app_text: &str,
    condition: &str,
    new_id: impl FnOnce() -> RuleId,
) -> Result<AirTrafficConfig, String> {
    let app = if sheet.typing {
        Some(typed_app(typed_app_text).ok_or_else(|| {
            "Type the app's name or bundle ID, like com.tinyspeck.slackmacgap.".to_owned()
        })?)
    } else {
        sheet.from.clone()
    };
    let when = condition_from(sheet.kind, condition)?;
    let target = Target {
        profile_id: sheet.profile.clone(),
        open: sheet.open,
        group_key: sheet.group.clone().filter(|_| sheet.grouped()),
    };
    let mut config = current.clone();
    match &sheet.editing {
        Some(id) => {
            let rule = config
                .rules
                .iter_mut()
                .find(|r| &r.id == id)
                .ok_or_else(|| UNSAVED.to_owned())?;
            rule.from = app;
            rule.when = when;
            rule.target = target;
        }
        None => {
            if config.rules.len() >= MAX_RULES {
                return Err("That's the most rules Ardia keeps. Remove one first.".into());
            }
            config
                .add(Rule {
                    id: new_id(),
                    enabled: sheet.enabled,
                    from: app,
                    when,
                    target,
                })
                .map_err(|refused| {
                    if refused == "full" {
                        "That's the most rules Ardia keeps. Remove one first.".to_owned()
                    } else {
                        UNSAVED.to_owned()
                    }
                })?;
        }
    }
    Ok(config)
}

pub fn save(view: &mut SettingsWindowView, cx: &mut Context<SettingsWindowView>) {
    let Some(sheet) = view.automations.rule_sheet.clone() else {
        return;
    };
    let typed = text(view, Field::RuleApp, cx);
    let condition = text(view, Field::RuleText, cx);
    match saved_config(&config(view), &sheet, &typed, &condition, new_rule_id) {
        Ok(config) => {
            store(view, config);
            view.automations.rule_sheet = None;
            view.menu = None;
        }
        Err(error) => {
            if let Some(sheet) = view.automations.rule_sheet.as_mut() {
                sheet.error = Some(error);
            }
        }
    }
    cx.notify();
}

pub fn remove_from_sheet(view: &mut SettingsWindowView, cx: &mut Context<SettingsWindowView>) {
    if let Some(id) = view
        .automations
        .rule_sheet
        .as_ref()
        .and_then(|s| s.editing.clone())
    {
        delete(view, id.as_str());
    }
    view.automations.rule_sheet = None;
    view.menu = None;
    cx.notify();
}

pub fn set_enabled(view: &SettingsWindowView, argument: &str) {
    let Some((id, on)) = argument.rsplit_once('=') else {
        return;
    };
    let mut config = config(view);
    if let Some(rule) = config.rules.iter_mut().find(|r| r.id == id) {
        rule.enabled = on == "true";
        store(view, config);
    }
}

pub fn moved(config: &AirTrafficConfig, id: &str, up: bool) -> Option<AirTrafficConfig> {
    let from = config.rules.iter().position(|r| r.id == id)?;
    let to = if up { from.checked_sub(1)? } else { from + 1 };
    if to >= config.rules.len() {
        return None;
    }
    let mut next = config.clone();
    next.rules.swap(from, to);
    Some(next)
}

pub fn move_rule(view: &SettingsWindowView, argument: &str) {
    let Some((id, direction)) = argument.rsplit_once('=') else {
        return;
    };
    if let Some(config) = moved(&config(view), id, direction == "up") {
        store(view, config);
    }
}

pub fn delete(view: &SettingsWindowView, id: &str) {
    let mut config = config(view);
    if config.remove(id) {
        store(view, config);
    }
}

pub fn rule_title(view: &SettingsWindowView, rule: &Rule) -> String {
    format!(
        "{} \u{b7} {} \u{2192} {}",
        from_label(rule.from.as_ref()),
        condition_label(&rule.when),
        target_label(&view.state, &rule.target).unwrap_or_else(|| "a deleted profile".into())
    )
}

pub fn rule_row(view: &SettingsWindowView, rule: &Rule, index: usize, last: bool) -> AnyElement {
    let p = view.look.p;
    let id = rule.id.as_str().to_owned();
    let emit = view.emit.clone();
    let toggle_id = id.clone();
    let menu = format!("auto:rule:{id}");
    let trigger = div()
        .debug_selector({
            let id = id.clone();
            move || format!("rule-more:{id}")
        })
        .child(
            IconButton::new(
                SharedString::from(format!("rule-more:{id}")),
                Icon::Ellipsis,
                &p,
            )
            .symbol(view.host.clone(), "ellipsis.circle")
            .tooltip("Edit, Move or Delete", &p)
            .on_click(
                view.emit
                    .click(Msg::Command(crate::settings::panes::menu_command(&menu))),
            ),
        )
        .into_any_element();
    let items = vec![
        Choice::new("Edit\u{2026}", false, command("editRule", &id)).icon(Icon::Pencil),
        Choice::new("Move Up", false, command("ruleMove", &format!("{id}=up")))
            .icon(Icon::ArrowUp)
            .after_separator(true)
            .enabled(index > 0),
        Choice::new(
            "Move Down",
            false,
            command("ruleMove", &format!("{id}=down")),
        )
        .icon(Icon::ArrowDown)
        .enabled(!last),
        Choice::new("Delete", false, command("ruleDelete", &id))
            .icon(Icon::Trash)
            .after_separator(true),
    ];
    RowSpec::new(SharedString::from(format!("rule:{id}")))
        .title(rule_title(view, rule))
        .description(rule_problem(&view.state, &rule.target))
        .control(
            div()
                .debug_selector({
                    let id = id.clone();
                    move || format!("rule-enabled:{id}")
                })
                .child(
                    Toggle::new(
                        SharedString::from(format!("rule-enabled:{id}")),
                        rule.enabled,
                        &p,
                    )
                    .native(true)
                    .on_toggle(move |on, window, cx| {
                        emit.send(
                            command("ruleEnabled", &format!("{toggle_id}={on}")),
                            window,
                            cx,
                        )
                    }),
                ),
        )
        .control(anchored_menu(view, &menu, trigger, 160., items))
        .render(view)
}

pub fn app_choices(
    view: &SettingsWindowView,
    value: Option<&SourceApp>,
    any_title: &'static str,
    other: bool,
    extras: &[Option<SourceApp>],
    verb: &'static str,
) -> Vec<Choice> {
    let mut wanted = vec![value.cloned()];
    wanted.extend(extras.iter().cloned());
    let lists = pickable_apps(&view.host.recent_source_apps(), &wanted);
    let selected = value.map(source_app_key);
    let mut items = vec![Choice::new(
        any_title,
        selected.is_none(),
        command(verb, ANY_APP),
    )];
    for list in [&lists.recent, &lists.common] {
        items.extend(list.iter().enumerate().map(|(index, app)| {
            let key = source_app_key(app);
            Choice::new(
                app.name.clone(),
                selected.as_deref() == Some(key.as_str()),
                command(verb, &key),
            )
            .after_separator(index == 0)
        }));
    }
    if other {
        items.push(
            Choice::new("Other\u{2026}", false, command(verb, OTHER_APP)).after_separator(true),
        );
    }
    items
}

pub fn profile_choices(
    view: &SettingsWindowView,
    value: Option<&ProfileId>,
    verb: &'static str,
    used_last: &'static str,
    separated_first: bool,
) -> Vec<Choice> {
    let mut items = vec![
        Choice::new(used_last, value.is_none(), command(verb, "")).after_separator(separated_first),
    ];
    items.extend(routable_profiles(&view.state).into_iter().enumerate().map(
        |(index, (id, name))| {
            Choice::new(name, value == Some(&id), command(verb, id.as_str()))
                .after_separator(index == 0)
        },
    ));
    items
}

pub fn group_choices(
    view: &SettingsWindowView,
    profile: &ProfileId,
    value: Option<&str>,
    verb: &'static str,
) -> Vec<Choice> {
    let groups = route_groups(&view.state, profile);
    let known = value.is_none_or(|key| groups.iter().any(|g| g.key == key));
    let mut items = vec![Choice::new("None", value.is_none(), command(verb, ""))];
    if let (false, Some(key)) = (known, value) {
        items.push(Choice::new(CLOSED_GROUP, true, command(verb, key)));
    }
    items.extend(groups.into_iter().enumerate().map(|(index, group)| {
        Choice::new(
            group.name,
            value == Some(group.key.as_str()),
            command(verb, &group.key),
        )
        .after_separator(index == 0)
    }));
    items
}

fn line(view: &SettingsWindowView, label: &'static str, control: AnyElement) -> AnyElement {
    let p = view.look.p;
    div()
        .mt(px(12.))
        .flex()
        .items_center()
        .gap(px(10.))
        .child(
            div()
                .w(px(LABEL_WIDTH))
                .text_right()
                .text_size(px(11.))
                .text_color(p.text_secondary)
                .child(label),
        )
        .child(control)
        .into_any_element()
}

fn below(control: AnyElement) -> AnyElement {
    div()
        .mt(px(6.))
        .ml(px(LABEL_WIDTH + 10.))
        .child(control)
        .into_any_element()
}

pub fn sheet(view: &SettingsWindowView, sheet: &RuleSheet) -> AnyElement {
    let p = view.look.p;
    let editing = sheet.editing.is_some();
    let kind_items = CONDITION_CHOICES
        .iter()
        .map(|(kind, title)| {
            Choice::new(*title, *kind == sheet.kind, command("ruleKind", kind.key()))
        })
        .collect();
    let open_items = OPEN_CHOICES
        .iter()
        .map(|(open, title)| {
            Choice::new(*title, *open == sheet.open, command("ruleOpen", open.key()))
        })
        .collect();
    let from = if sheet.typing {
        None
    } else {
        sheet.from.as_ref()
    };
    let mut from_items = app_choices(view, from, "Any app", true, &[], "ruleFrom");
    if sheet.typing {
        for item in &mut from_items {
            item.checked = false;
        }
    }
    let cancel = view.emit.clone();
    let mut dialog = Dialog::sheet("rule-sheet", SheetSize::M, &p)
        .on_dismiss(move |window, cx| cancel.send(command("sheetClose", ""), window, cx))
        .child(dialog_title(
            if editing { "Edit Rule" } else { "Add Rule" },
            Some(SharedString::new_static(
                "Links from other apps that fit this rule open where you choose.",
            )),
            None,
            &p,
        ))
        .child(line(
            view,
            "From",
            sheet_popup(view, "auto:ruleFrom", 180., from_items),
        ));
    if sheet.typing {
        dialog = dialog.child(below(field(
            view,
            &view.automations.fields.rule_app,
            "rule-app",
        )));
    }
    dialog = dialog.child(line(
        view,
        "Links",
        sheet_popup(view, "auto:ruleKind", 180., kind_items),
    ));
    if sheet.kind != ConditionKind::Any {
        dialog = dialog.child(below(field(
            view,
            &view.automations.fields.rule_text,
            "rule-text",
        )));
    }
    dialog = dialog
        .child(line(
            view,
            "Open in",
            sheet_popup(
                view,
                "auto:ruleProfile",
                180.,
                profile_choices(
                    view,
                    sheet.profile.as_ref(),
                    "ruleProfile",
                    USED_LAST,
                    false,
                ),
            ),
        ))
        .child(line(
            view,
            "As",
            sheet_popup(view, "auto:ruleOpen", 180., open_items),
        ));
    if let (true, Some(profile)) = (sheet.grouped(), sheet.profile.as_ref()) {
        dialog = dialog.child(line(
            view,
            "Group",
            sheet_popup(
                view,
                "auto:ruleGroup",
                180.,
                group_choices(view, profile, sheet.group.as_deref(), "ruleGroup"),
            ),
        ));
    }
    if let Some(error) = sheet.error.clone() {
        dialog = dialog.child(
            div()
                .debug_selector(|| "rule-error".into())
                .mt(px(10.))
                .text_size(px(11.))
                .text_color(p.destructive)
                .child(error),
        );
    }
    let leading = editing.then(|| {
        div()
            .debug_selector(|| "rule-remove".into())
            .child(
                PushButton::new("rule-remove", "Remove", &p)
                    .kind(ButtonKind::Destructive)
                    .on_click(view.emit.click(command("ruleRemove", ""))),
            )
            .into_any_element()
    });
    dialog
        .child(dialog_actions(
            leading,
            None,
            [
                div()
                    .debug_selector(|| "rule-cancel".into())
                    .child(
                        PushButton::new("rule-cancel", "Cancel", &p)
                            .on_click(view.emit.click(command("sheetClose", ""))),
                    )
                    .into_any_element(),
                div()
                    .debug_selector(|| "rule-save".into())
                    .child(
                        PushButton::new("rule-save", if editing { "Save" } else { "Add" }, &p)
                            .kind(ButtonKind::Primary)
                            .on_click(view.emit.click(command("ruleSave", ""))),
                    )
                    .into_any_element(),
            ],
            &p,
        ))
        .into_any_element()
}

pub fn approvals(view: &SettingsWindowView) -> Vec<AnyElement> {
    let p = view.look.p;
    let rules = view.host.automation_rules();
    let lead = "Rules from hooks.json and config.json stay off until you approve them.";
    let description = if rules.pending.is_empty() && rules.approved.is_empty() {
        format!("{lead} Nothing is waiting for approval.")
    } else {
        lead.to_owned()
    };
    let mut rows = vec![
        RowSpec::new("setting:advanced.automationRules")
            .anchor("advanced.automationRules")
            .title("Automation rules")
            .description(Some(description))
            .render(view),
    ];
    let listed = rules
        .pending
        .into_iter()
        .map(|rule| (rule, true))
        .chain(rules.approved.into_iter().map(|rule| (rule, false)));
    rows.extend(listed.map(|(rule, pending)| {
        let key = rule.key.clone();
        let mut row = RowSpec::new(SharedString::from(format!("automation-rule:{key}")))
            .title(rule.name)
            .description(Some(rule.summary));
        if pending {
            row = row.control(
                div()
                    .debug_selector({
                        let key = key.clone();
                        move || format!("approve:{key}")
                    })
                    .child(
                        PushButton::new(
                            SharedString::from(format!("approve:{key}")),
                            "Approve",
                            &p,
                        )
                        .on_click(view.emit.click(command("approveRule", &key))),
                    ),
            );
        }
        row.control(
            div()
                .debug_selector({
                    let key = key.clone();
                    move || format!("revoke:{key}")
                })
                .child(
                    IconButton::new(SharedString::from(format!("revoke:{key}")), Icon::Trash, &p)
                        .tooltip(if pending { "Remove" } else { "Revoke" }, &p)
                        .on_click(view.emit.click(command("revokeRule", &key))),
                ),
        )
        .render(view)
    }));
    rows
}
