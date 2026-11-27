use ardia_state::Action;
use ardia_state::ProfileId;
use ardia_state::air_traffic::{AirTrafficConfig, LinkSource, OpenAs, Target};
use ardia_state::link_routing::{
    OPEN_CHOICES, open_from_key, pickable_apps, preview_link, route_group_name, source_app_key,
};
use gpui::{
    AnyElement, Context, IntoElement, ParentElement, SharedString, Styled, div, prelude::*,
};

use crate::primitives::controls::PushButton;
use crate::primitives::icons::{Icon, symbol_icon};
use crate::scale::px;
use crate::settings::SettingsWindowView;
use crate::settings::panes::Block;

use super::parts::{
    Choice, RowSpec, block, command, field, group, popup, section_header, section_header_with,
};
use super::rules::{ANY_APP, app_choices, group_choices, profile_choices, rule_row};

pub const USUAL: &str = "usual";
pub const FALLBACK_GROUP_CLOSED: &str =
    "That tab group isn't open, so these links open as a plain tab in this profile. Pick another.";
pub const NO_FALLBACK: &str =
    "They open as Settings \u{203a} Tabs says, in the profile you used last.";

pub fn pick_test_app(
    view: &mut SettingsWindowView,
    key: &str,
    cx: &mut Context<SettingsWindowView>,
) {
    view.automations.test_app = if key == ANY_APP {
        None
    } else {
        let extras: Vec<_> = view
            .state
            .air_traffic
            .rules
            .iter()
            .map(|r| r.from.clone())
            .collect();
        let lists = pickable_apps(&view.host.recent_source_apps(), &extras);
        lists
            .recent
            .into_iter()
            .chain(lists.common)
            .find(|app| source_app_key(app) == key)
    };
    cx.notify();
}

fn store(view: &SettingsWindowView, config: AirTrafficConfig) {
    view.host.dispatch(Action::SetAirTraffic { config });
}

pub fn with_fallback(current: &AirTrafficConfig, fallback: Option<Target>) -> AirTrafficConfig {
    let fallback = fallback.map(|t| {
        let keeps = t.group_key.is_some() && t.profile_id.is_some() && t.open == OpenAs::Tab;
        Target {
            group_key: t.group_key.filter(|_| keeps),
            ..t
        }
    });
    AirTrafficConfig {
        fallback,
        fallback_chosen: true,
        ..current.clone()
    }
}

pub fn fallback_after_pick(current: Option<&Target>, choice: &str) -> Option<Target> {
    if choice == USUAL {
        return None;
    }
    let profile_id = (!choice.is_empty()).then(|| ProfileId::from(choice.to_owned()));
    let keeps_group = current.is_some_and(|f| f.profile_id == profile_id);
    Some(Target {
        open: current.map_or(OpenAs::Tab, |f| f.open),
        group_key: current
            .filter(|_| keeps_group)
            .and_then(|f| f.group_key.clone()),
        profile_id,
    })
}

pub fn set_fallback(view: &SettingsWindowView, choice: &str) {
    let config = &view.state.air_traffic;
    let next = fallback_after_pick(config.fallback.as_ref(), choice);
    store(view, with_fallback(config, next));
}

pub fn set_fallback_open(view: &SettingsWindowView, key: &str) {
    let config = &view.state.air_traffic;
    let (Some(open), Some(current)) = (open_from_key(key), config.fallback.clone()) else {
        return;
    };
    store(
        view,
        with_fallback(config, Some(Target { open, ..current })),
    );
}

pub fn set_fallback_group(view: &SettingsWindowView, key: &str) {
    let config = &view.state.air_traffic;
    let Some(current) = config.fallback.clone() else {
        return;
    };
    let group_key = (!key.is_empty()).then(|| key.to_owned());
    store(
        view,
        with_fallback(
            config,
            Some(Target {
                group_key,
                ..current
            }),
        ),
    );
}

pub fn app_links_profile(view: &SettingsWindowView) -> ProfileId {
    view.automations
        .app_links_profile
        .clone()
        .filter(|p| view.state.profiles.contains_key(p))
        .unwrap_or_else(|| crate::settings::panes::default_profile(view))
}

pub fn pick_app_links_profile(
    view: &mut SettingsWindowView,
    key: &str,
    cx: &mut Context<SettingsWindowView>,
) {
    let profile = ProfileId::from(key.to_owned());
    if view.state.profiles.contains_key(&profile) {
        view.automations.app_links_profile = Some(profile);
    }
    cx.notify();
}

pub fn remove_app_link(view: &SettingsWindowView, argument: &str) {
    let Some((origin, scheme)) = argument.rsplit_once('|') else {
        return;
    };
    view.host.remove_app_link(
        app_links_profile(view),
        origin.to_owned(),
        scheme.to_owned(),
    );
}

fn rules_group(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let rules = &view.state.air_traffic.rules;
    let hooks = view.host.automation_rules().link_hooks;
    let mut header = RowSpec::new("setting:automations.linkRules")
        .anchor("automations.linkRules")
        .title("Rules")
        .description(Some(
            "The first rule that matches a link decides where it opens.",
        ));
    if !hooks.is_empty() {
        header = header.control(
            div().debug_selector(|| "automation-pane".into()).child(
                PushButton::new("automation-pane", "Automation\u{2026}", &p)
                    .on_click(view.emit.click(command("automationPane", ""))),
            ),
        );
    }
    let mut rows = vec![
        header
            .control(
                div().debug_selector(|| "add-rule".into()).child(
                    PushButton::new("add-rule", "Add Rule\u{2026}", &p)
                        .icon(Icon::Plus)
                        .on_click(view.emit.click(command("addRule", ""))),
                ),
            )
            .render(view),
    ];
    rows.extend(hooks.into_iter().map(|hook| {
        RowSpec::new(SharedString::from(format!("link-hook:{}", hook.name)))
            .icon(symbol_icon("lock.fill", Icon::LockFill, 13., p.icon))
            .title(hook.name.clone())
            .description(Some(hook.summary()))
            .control(
                div()
                    .text_size(px(11.))
                    .text_color(p.text_secondary)
                    .child("hooks.json"),
            )
            .render(view)
    }));
    if rules.is_empty() {
        rows.push(
            RowSpec::new("rules-none")
                .title("No rules yet")
                .description(Some(
                    "Add one to send links from an app, or links to a site, to a profile.",
                ))
                .render(view),
        );
    } else {
        let count = rules.len();
        rows.extend(
            rules
                .iter()
                .enumerate()
                .map(|(index, rule)| rule_row(view, rule, index, index + 1 == count)),
        );
    }
    group(&p, rows)
}

fn test_group(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let extras: Vec<_> = view
        .state
        .air_traffic
        .rules
        .iter()
        .map(|r| r.from.clone())
        .collect();
    let app = view.automations.test_app.clone();
    let items = app_choices(
        view,
        app.as_ref(),
        "An unknown app",
        false,
        &extras,
        "testApp",
    );
    let typed = view.automations.test_typed.trim().to_owned();
    let source = app.map_or_else(LinkSource::default, |app| LinkSource {
        bundle_id: app.bundle_id,
        app_name: Some(app.name),
    });
    let preview = (!typed.is_empty()).then(|| preview_link(&view.state, &typed, &source));
    let result = preview.clone().flatten();
    let title = match (&result, &preview) {
        (Some(result), _) => result.title.clone(),
        (None, Some(_)) => "That isn't a link Ardia can open.".into(),
        (None, None) => "Type a link to see where it lands.".into(),
    };
    let icon = if result.is_some() {
        symbol_icon("airplane", Icon::ArrowUpRight, 13., p.icon)
    } else {
        symbol_icon("link", Icon::Link, 13., p.icon)
    };
    let rows = vec![
        RowSpec::new("setting:automations.testLink")
            .anchor("automations.testLink")
            .title("Test a link")
            .description(Some("See where a link would open, without opening it."))
            .control(popup(view, "auto:testApp", 180., false, items))
            .render(view),
        RowSpec::new("test-link-row")
            .title_element(field(
                view,
                &view.automations.fields.test_link,
                "test-link-field",
            ))
            .render(view),
        RowSpec::new("test-link-result")
            .icon(
                div()
                    .size(px(20.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon),
            )
            .title(title)
            .description(result.map(|r| r.detail))
            .render(view),
    ];
    group(&p, rows)
}

fn fallback_group(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let fallback = view.state.air_traffic.fallback.clone();
    let value = match &fallback {
        None => USUAL.to_owned(),
        Some(target) => target
            .profile_id
            .as_ref()
            .map_or_else(String::new, |id| id.as_str().to_owned()),
    };
    let mut items = vec![Choice::new(
        "Ardia's usual routing",
        value == USUAL,
        command("fallback", USUAL),
    )];
    let mut profiles = profile_choices(
        view,
        fallback.as_ref().and_then(|f| f.profile_id.as_ref()),
        "fallback",
        "Profile you used last",
        true,
    );
    if fallback.is_none() {
        for item in &mut profiles {
            item.checked = false;
        }
    }
    items.extend(profiles);
    let mut fallback_row = RowSpec::new("setting:automations.linkFallback")
        .anchor("automations.linkFallback")
        .title("Links no rule catches")
        .description(Some(if fallback.is_some() {
            "Where links open when no rule decides."
        } else {
            NO_FALLBACK
        }))
        .control(popup(view, "auto:fallback", 180., false, items));
    if let Some(current) = &fallback {
        let open_items = OPEN_CHOICES
            .iter()
            .map(|(open, title)| {
                Choice::new(
                    *title,
                    *open == current.open,
                    command("fallbackOpen", open.key()),
                )
            })
            .collect();
        fallback_row =
            fallback_row.control(popup(view, "auto:fallbackOpen", 120., false, open_items));
    }
    let mut rows = vec![fallback_row.render(view)];
    if let Some(Target {
        profile_id: Some(profile),
        open: OpenAs::Tab,
        group_key,
    }) = &fallback
        && view.state.profiles.contains_key(profile)
    {
        let gone = group_key
            .as_deref()
            .is_some_and(|key| route_group_name(&view.state, profile, key).is_none());
        rows.push(
            RowSpec::new("setting:automations.linkFallbackGroup")
                .anchor("automations.linkFallbackGroup")
                .title("Tab group")
                .description(gone.then_some(FALLBACK_GROUP_CLOSED))
                .control(popup(
                    view,
                    "auto:fallbackGroup",
                    180.,
                    false,
                    group_choices(view, profile, group_key.as_deref(), "fallbackGroup"),
                ))
                .render(view),
        );
    }
    group(&p, rows)
}

fn app_links(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let profile = app_links_profile(view);
    let picker = (view.state.profile_order.len() >= 2).then(|| {
        popup(
            view,
            "auto:appLinksProfile",
            120.,
            false,
            view.state
                .profile_order
                .iter()
                .filter_map(|id| view.state.profiles.get(id).map(|p| (id, p)))
                .map(|(id, record)| {
                    Choice::new(
                        record.name.clone(),
                        *id == profile,
                        command("appLinksProfile", id.as_str()),
                    )
                })
                .collect(),
        )
    });
    let header = section_header_with(
        view,
        Some("automations.appLinks"),
        "Apps that open links",
        Some("Sites that open another app without asking first."),
        picker,
    );
    let rows: Vec<AnyElement> = match view.host.app_links(&profile) {
        None => vec![RowSpec::new("app-links-loading").title(" ").description(Some(" ")).render(view)],
        Some(links) if links.is_empty() => vec![
            RowSpec::new("app-links-none")
                .title("No apps yet")
                .description(Some(
                    "Check \u{201c}Always allow\u{201d} when a site opens an app, and it shows up here.",
                ))
                .render(view),
        ],
        Some(links) => links
            .into_iter()
            .map(|link| {
                let key = format!("{}|{}", link.origin, link.scheme);
                let icon = match link.icon.as_deref().and_then(crate::primitives::favicon::decode_data_uri) {
                    Some(image) => gpui::img(image).size(px(20.)).into_any_element(),
                    None => crate::primitives::favicon::render_favicon(
                        &crate::primitives::favicon::favicon_of(&link.origin, None, None, ""),
                        16.,
                        &p,
                    ),
                };
                let shown = link
                    .origin
                    .trim_start_matches("https://")
                    .trim_start_matches("http://")
                    .to_owned();
                RowSpec::new(SharedString::from(format!("app-link:{key}")))
                    .icon(icon)
                    .title(shown)
                    .description(Some(format!(
                        "Opens {}: links in {}",
                        link.scheme,
                        link.app
                            .unwrap_or_else(|| "an app that's no longer installed".into())
                    )))
                    .control(
                        PushButton::new(SharedString::from(format!("app-link-remove:{key}")), "Remove", &p)
                            .on_click(view.emit.click(command("removeAppLink", &key))),
                    )
                    .render(view)
            })
            .collect(),
    };
    div()
        .child(header)
        .child(group(&p, rows))
        .into_any_element()
}

pub fn blocks(view: &SettingsWindowView) -> Vec<Block> {
    vec![
        block(
            vec![],
            section_header(
                view,
                None,
                "Link routing",
                Some("Choose where links from other apps open."),
            ),
        ),
        block(vec!["automations.linkRules"], rules_group(view)),
        block(
            vec!["automations.testLink"],
            div().mt(px(16.)).child(test_group(view)).into_any_element(),
        ),
        block(
            vec!["automations.linkFallback", "automations.linkFallbackGroup"],
            div()
                .mt(px(16.))
                .child(fallback_group(view))
                .into_any_element(),
        ),
        block(vec!["automations.appLinks"], app_links(view)),
    ]
}
