use std::collections::HashMap;
use std::time::{Duration, Instant};

use ardia_state::model::TabPin;
use ardia_state::omnibox::url::host_of;
use ardia_state::settings::SettingsPatch;
use ardia_state::{Action, BrowserState, NewTab, ProfileId, WindowId};
use gpui::{
    AnyElement, ClipboardItem, Context, Entity, FontWeight, IntoElement, ParentElement,
    SharedString, Styled, Subscription, Window, div, prelude::*,
};

use crate::host::{OfficialPlugin, OfficialPluginState, PluginCommand, PluginDetail, UiHost};
use crate::msg::Msg;
use crate::onboarding::setup_code::{self, SetupChoices};
use crate::plugins::model::{ConsentOwner, PluginPrograms, ProgramsStatus};
use crate::primitives::controls::{
    ButtonKind, MenuRow, PopUp, PushButton, TextButton, TextLook, Toggle, field_box, popover,
    separator, spinner,
};
use crate::primitives::icons::{Icon, symbol_icon};
use crate::primitives::list::{Row, group};
use crate::primitives::shapes::{IconTile, IconTileSize};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput};
use crate::scale::px;
use crate::settings::SettingsWindowView;
use crate::settings::panes::{POPUP_HEIGHT, menu_command};
use crate::settings::rows::Pane;
use crate::settings::subpages::{self, Detail};

pub const COMMAND: &str = "settings:extras:";
pub const SETUP_CODE_HINT: &str = "Paste the code from the demo on ardia.dev to bring over the layout, look and pinned apps you picked there.";
pub const FULL_CONTROL_SUMMARY: &str = "Can fully control Ardia";
pub const UNSAVED: &str = "plugins.json couldn't be saved. Try again.";
pub const COPIED_FOR: Duration = Duration::from_millis(2000);
pub const SETUP_FIELD_WIDTH: f32 = 170.0;
pub const MANAGER_POPUP_WIDTH: f32 = 210.0;
pub const PLUGIN_ICON: f32 = 14.0;
pub const PLUGIN_ICON_BOX: f32 = 18.0;
const PASSWORD_MANAGER_MENU: &str = "passwordManager";

pub struct Extras {
    pub setup_input: Entity<TextInput>,
    pub setup_typed: String,
    pub setup_result: Option<Result<Vec<String>, &'static str>>,
    pub how_to_add: bool,
    pub official_failures: HashMap<String, String>,
    pub official_busy: Vec<String>,
    pub copied: Option<(String, Instant)>,
    pub plugin_values: crate::settings::plugin_values::PluginValues,
    _subscriptions: Vec<Subscription>,
}

impl Extras {
    pub fn new(
        style: InputStyle,
        window: &mut Window,
        cx: &mut Context<SettingsWindowView>,
    ) -> Extras {
        let placeholder = format!("{}…", setup_code::SETUP_CODE_PREFIX);
        let setup_input = cx.new(|cx| TextInput::new(placeholder, cx));
        setup_input.update(cx, |input, cx| input.set_style(style, cx));
        let subscription = cx.subscribe_in(
            &setup_input,
            window,
            |view: &mut SettingsWindowView, input, event: &InputEvent, window, cx| match event {
                InputEvent::Changed { .. } => {
                    view.extras.setup_typed = input.read(cx).text().to_owned();
                    view.extras.setup_result = None;
                    cx.notify();
                }
                InputEvent::Submit(_) => {
                    apply_setup_code(view, cx);
                    window.focus(&view.focus, cx);
                }
                _ => {}
            },
        );
        Extras {
            setup_input,
            setup_typed: String::new(),
            setup_result: None,
            how_to_add: false,
            official_failures: HashMap::new(),
            official_busy: Vec::new(),
            copied: None,
            plugin_values: crate::settings::plugin_values::PluginValues::default(),
            _subscriptions: vec![subscription],
        }
    }
}

fn cmd(text: impl Into<String>) -> Msg {
    Msg::Command(SharedString::from(format!("{COMMAND}{}", text.into())))
}

fn row(id: impl Into<SharedString>, p: &crate::look::Palette) -> Row {
    let id: SharedString = id.into();
    Row::new(gpui::ElementId::Name(id), p).native(true)
}

fn tagged(selector: String, element: impl IntoElement) -> AnyElement {
    div()
        .debug_selector(move || selector)
        .child(element)
        .into_any_element()
}

pub fn setup_code_description(result: Option<&Result<Vec<String>, &'static str>>) -> String {
    match result {
        Some(Ok(lines)) => format!("Applied: {}.", lines.join(", ")),
        Some(Err(problem)) => (*problem).to_owned(),
        None => SETUP_CODE_HINT.to_owned(),
    }
}

pub fn setup_code_row(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let empty = view.extras.setup_typed.trim().is_empty();
    let failed = matches!(view.extras.setup_result, Some(Err(_)));
    tagged(
        "setup-code".into(),
        row("setup-code", &p)
            .title("Apply a setup code")
            .description_element(
                crate::primitives::list::row_description(
                    setup_code_description(view.extras.setup_result.as_ref()),
                    &p,
                )
                .when(failed, |this| this.text_color(p.text_secondary)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        field_box(&p)
                            .debug_selector(|| "setup-code-field".into())
                            .w(px(SETUP_FIELD_WIDTH))
                            .h(px(24.))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(view.extras.setup_input.clone()),
                            ),
                    )
                    .child(
                        PushButton::new("setup-code-apply", "Apply", &p)
                            .disabled(empty)
                            .on_click(view.emit.click(cmd("setupCode:apply"))),
                    ),
            ),
    )
}

pub fn apply_choices(host: &dyn UiHost, state: &BrowserState, choices: &SetupChoices) {
    if !choices.settings.is_empty() {
        host.dispatch(Action::UpdateSettings {
            patch: SettingsPatch(choices.settings.clone().into_iter().collect()),
            from_sync: false,
        });
    }
    let window = state.main_window_for(None).cloned();
    let profile = window
        .as_ref()
        .and_then(|id| state.window(id.as_str()))
        .map(|w| w.profile_id.clone());
    if let (Some(profile), Some(color)) = (
        profile,
        choices.color.as_deref().and_then(|key| {
            ardia_theme::ProfileColor::ALL
                .into_iter()
                .find(|c| c.key() == key)
        }),
    ) && state.profiles.contains_key(&profile)
    {
        host.dispatch(Action::UpdateProfile {
            profile,
            patch: ardia_state::ProfilePatch {
                color: Some(color),
                theme: Some(None),
                ..ardia_state::ProfilePatch::default()
            },
        });
    }
    let Some(window) = window else {
        return;
    };
    let pins = choices.pins.clone().unwrap_or_default();
    pin_sites(host, state, &window, &pins);
}

pub fn pinned_hosts(state: &BrowserState, window: &WindowId) -> Vec<String> {
    let Some(w) = state.window(window.as_str()) else {
        return Vec::new();
    };
    let grouped: Vec<&str> = state
        .groups
        .values()
        .filter(|g| g.pinned && g.profile_id == w.profile_id)
        .flat_map(|g| g.tab_ids.iter().map(|id| id.as_str()))
        .collect();
    state
        .tabs
        .values()
        .filter(|t| {
            t.profile_id == w.profile_id && (t.pin.is_some() || grouped.contains(&t.id.as_str()))
        })
        .map(|t| host_of(t.pinned_url.as_deref().unwrap_or(&t.url)))
        .filter(|h| !h.is_empty())
        .collect()
}

fn pin_sites(host: &dyn UiHost, state: &BrowserState, window: &WindowId, ids: &[String]) {
    let pinned = pinned_hosts(state, window);
    let profile = state.window(window.as_str()).map(|w| w.profile_id.clone());
    for site in crate::onboarding::copy::PINNABLE_SITES {
        if ids.iter().any(|id| id == site.id) && !pinned.contains(&host_of(site.url)) {
            host.dispatch(Action::NewTab {
                window: window.clone(),
                tab: NewTab {
                    url: Some(site.url.to_owned()),
                    profile: profile.clone(),
                    background: true,
                    pin: Some(TabPin::TILE),
                    ..NewTab::default()
                },
            });
        }
    }
}

fn apply_setup_code(view: &mut SettingsWindowView, cx: &mut Context<SettingsWindowView>) {
    let code = view.extras.setup_typed.clone();
    if code.trim().is_empty() {
        return;
    }
    let result = match setup_code::decode(&code) {
        Ok(choices) => {
            apply_choices(view.host.as_ref(), &view.state, &choices);
            Ok(setup_code::describe(&choices))
        }
        Err(problem) => Err(problem),
    };
    if result.is_ok() {
        view.extras.setup_typed.clear();
        view.extras
            .setup_input
            .update(cx, |input, cx| input.set_text("", false, cx));
    }
    view.extras.setup_result = Some(result);
    cx.notify();
}

pub fn official_in_settings(plugins: &[OfficialPlugin]) -> bool {
    plugins
        .iter()
        .any(|p| p.state != OfficialPluginState::Unsupported)
}

pub fn official_plugins(view: &SettingsWindowView) -> Vec<OfficialPlugin> {
    view.host
        .official_plugins()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.state != OfficialPluginState::Unsupported)
        .collect()
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OfficialView {
    pub installed: bool,
    pub coming_soon: bool,
    pub status: Option<String>,
    pub failed: bool,
    pub busy: bool,
    pub action: Option<&'static str>,
    pub opens: bool,
    pub first_command: Option<String>,
}

pub fn installed_label(plugin: &OfficialPlugin) -> String {
    match &plugin.version {
        Some(version) => format!("Installed · {version}"),
        None => "Installed".to_owned(),
    }
}

pub fn official_view(
    plugin: &OfficialPlugin,
    programs: Option<&ProgramsStatus>,
    busy: bool,
    failure: Option<&str>,
    progress: Option<crate::host::OfficialInstallPhase>,
) -> OfficialView {
    let download = progress.and_then(|phase| match phase {
        crate::host::OfficialInstallPhase::Downloading { received, total } => {
            Some(match received.saturating_mul(100).checked_div(total) {
                Some(percent) => format!("Downloading… {}%", percent.min(100)),
                None => "Downloading…".to_owned(),
            })
        }
        crate::host::OfficialInstallPhase::Installing => Some("Installing…".to_owned()),
        crate::host::OfficialInstallPhase::Asking => None,
    });
    let asking = matches!(progress, Some(crate::host::OfficialInstallPhase::Asking));
    match plugin.state {
        OfficialPluginState::Unsupported => OfficialView::default(),
        OfficialPluginState::ComingSoon => OfficialView {
            coming_soon: true,
            ..OfficialView::default()
        },
        OfficialPluginState::Installed => {
            let base = OfficialView {
                installed: true,
                opens: true,
                ..OfficialView::default()
            };
            if let Some(status) = download {
                return OfficialView {
                    status: Some(status),
                    busy: true,
                    ..base
                };
            }
            if busy || matches!(programs, Some(ProgramsStatus::Linking)) {
                return OfficialView {
                    status: Some("Installing…".to_owned()),
                    busy: true,
                    ..base
                };
            }
            match programs {
                Some(ProgramsStatus::Failed { reason }) => {
                    return OfficialView {
                        status: Some(format!("Not on your PATH: {reason}")),
                        failed: true,
                        action: Some("again"),
                        ..base
                    };
                }
                _ if plugin.update.is_some() => {
                    return match failure {
                        Some(reason) => OfficialView {
                            status: Some(reason.to_owned()),
                            failed: true,
                            action: Some("update"),
                            ..base
                        },
                        None => OfficialView {
                            status: Some(format!(
                                "Version {} is ready. Review what it gets to update.",
                                plugin.update.as_deref().unwrap_or_default()
                            )),
                            action: Some("update"),
                            ..base
                        },
                    };
                }
                Some(ProgramsStatus::Linked {
                    linked, refused, ..
                }) => {
                    if !refused.is_empty() {
                        let reasons: Vec<&str> =
                            refused.iter().map(|(_, reason)| reason.as_str()).collect();
                        return OfficialView {
                            status: Some(format!("Not on your PATH: {}", reasons.join("; "))),
                            failed: true,
                            action: Some("again"),
                            ..base
                        };
                    }
                    if !linked.is_empty() {
                        return OfficialView {
                            first_command: plugin.example.clone(),
                            ..base
                        };
                    }
                }
                _ => {}
            }
            if let Some(reason) = failure {
                return OfficialView {
                    status: Some(reason.to_owned()),
                    failed: true,
                    action: Some("again"),
                    ..base
                };
            }
            base
        }
        OfficialPluginState::Available => {
            let base = OfficialView {
                opens: true,
                ..OfficialView::default()
            };
            if let Some(status) = download {
                return OfficialView {
                    status: Some(status),
                    busy: true,
                    ..base
                };
            }
            if asking {
                return OfficialView { busy: true, ..base };
            }
            if busy {
                return OfficialView {
                    status: Some("Installing…".to_owned()),
                    busy: true,
                    ..base
                };
            }
            if let Some(reason) = failure {
                return OfficialView {
                    status: Some(reason.to_owned()),
                    failed: true,
                    action: Some("again"),
                    ..base
                };
            }
            OfficialView {
                action: Some("install"),
                ..base
            }
        }
    }
}

fn programs_of(view: &SettingsWindowView, name: &str) -> Option<ProgramsStatus> {
    view.host
        .plugins()?
        .plugin_programs()
        .into_iter()
        .find(|entry| entry.plugin == name)
        .map(|entry: PluginPrograms| entry.status)
}

pub fn official_rows(view: &SettingsWindowView) -> Vec<AnyElement> {
    official_plugins(view)
        .into_iter()
        .map(|plugin| official_row(view, &plugin))
        .collect()
}

fn official_row(view: &SettingsWindowView, plugin: &OfficialPlugin) -> AnyElement {
    let p = view.look.p;
    let name = plugin.name.clone();
    let programs = programs_of(view, &name);
    let busy = view.extras.official_busy.contains(&name);
    let unsaved = view.host.plugin_detail(&name).is_some_and(|d| d.unsaved);
    let failure = view
        .extras
        .official_failures
        .get(&name)
        .map(String::as_str)
        .or(unsaved.then_some(UNSAVED));
    let progress = view.host.official_install_progress(name.clone());
    let shown = official_view(plugin, programs.as_ref(), busy, failure, progress);
    let full_control = view
        .host
        .plugin_detail(&name)
        .is_some_and(|d| d.full_control);
    let line: Vec<String> = full_control
        .then(|| FULL_CONTROL_SUMMARY.to_owned())
        .into_iter()
        .chain(shown.status.clone().or_else(|| Some(plugin.blurb.clone())))
        .filter(|text| !text.is_empty())
        .collect();
    let title = div()
        .flex()
        .items_baseline()
        .gap(px(6.))
        .child(
            div()
                .text_size(px(13.))
                .line_height(px(16.))
                .text_color(p.text)
                .child(if plugin.title.is_empty() {
                    plugin.name.clone()
                } else {
                    plugin.title.clone()
                }),
        )
        .when(shown.installed, |this| {
            this.child(
                div()
                    .text_size(px(11.))
                    .text_color(p.text_secondary)
                    .child(installed_label(plugin)),
            )
        });
    let description = (!shown.coming_soon).then(|| {
        div()
            .mt(px(2.))
            .text_size(px(11.))
            .line_height(px(14.))
            .text_color(if shown.failed {
                p.destructive
            } else {
                p.text_secondary
            })
            .when(!shown.failed, |this| this.line_clamp(2))
            .child(line.join(" · "))
    });
    let mut built = row(format!("official:{name}"), &p)
        .title_element(title)
        .icon(
            IconTile::holding(
                symbol_icon(plugin.icon.clone(), Icon::Puzzle, 18., p.icon),
                &p,
            )
            .size(IconTileSize::L),
        );
    if let Some(description) = description {
        built = built.description_element(description);
    }
    if shown.opens {
        let emit = view.emit.clone();
        let open = name.clone();
        built =
            built.on_click(move |_, window, cx| emit.send(cmd(format!("open:{open}")), window, cx));
    }
    let controls = div()
        .flex()
        .items_center()
        .gap(px(12.))
        .when(shown.busy && shown.status.is_some(), |this| {
            this.child(spinner(14., p.text_secondary))
        })
        .when(shown.coming_soon, |this| {
            this.child(
                div()
                    .text_size(px(12.))
                    .text_color(p.text_tertiary)
                    .child("Coming soon"),
            )
        })
        .when_some(shown.first_command.clone(), |this, command| {
            let copied = view
                .extras
                .copied
                .as_ref()
                .is_some_and(|(text, at)| *text == command && at.elapsed() < COPIED_FOR);
            this.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(p.text_secondary)
                            .font_family("Menlo")
                            .child(command.clone()),
                    )
                    .child(
                        PushButton::new(
                            SharedString::from(format!("official-copy:{name}")),
                            if copied { "Copied" } else { "Copy" },
                            &p,
                        )
                        .on_click(view.emit.click(cmd(format!("copy:{command}")))),
                    ),
            )
        })
        .when(
            shown.action == Some("install") || (shown.busy && shown.status.is_none()),
            |this| {
                this.child(
                    PushButton::new(
                        SharedString::from(format!("official-install:{name}")),
                        "Install…",
                        &p,
                    )
                    .disabled(shown.busy)
                    .on_click(view.emit.click(cmd(format!("install:{name}")))),
                )
            },
        )
        .when(shown.action == Some("again"), |this| {
            this.child(
                PushButton::new(
                    SharedString::from(format!("official-again:{name}")),
                    "Try Again",
                    &p,
                )
                .on_click(view.emit.click(cmd(format!("again:{name}")))),
            )
        })
        .when(shown.action == Some("update"), |this| {
            this.child(
                PushButton::new(
                    SharedString::from(format!("official-update:{name}")),
                    "Update…",
                    &p,
                )
                .on_click(view.emit.click(cmd(format!("install:{name}")))),
            )
        });
    tagged(format!("official:{name}"), built.child(controls))
}

pub fn user_plugin_names(view: &SettingsWindowView) -> Vec<String> {
    let official: Vec<String> = official_plugins(view).into_iter().map(|p| p.name).collect();
    view.host
        .plugin_rows()
        .into_iter()
        .map(|row| row.name)
        .filter(|name| !official.contains(name))
        .collect()
}

pub fn origin_text(detail: &PluginDetail) -> Option<String> {
    if detail.ignores_user_folder {
        return Some(format!(
            "Official (the folder of the same name in {} is ignored)",
            detail.plugins_folder
        ));
    }
    detail.official.then(|| "Official".to_owned())
}

pub fn status_of(detail: &PluginDetail, describe: bool) -> String {
    if !detail.loads {
        let problems: Vec<&str> = detail.problems.iter().take(2).map(String::as_str).collect();
        return if problems.is_empty() {
            "This plugin can't load".to_owned()
        } else {
            problems.join("; ")
        };
    }
    if detail.unsaved && !detail.active {
        return UNSAVED.to_owned();
    }
    if detail.needs_review {
        return "Its plugin.json changed. Review it to turn it back on.".to_owned();
    }
    let running = if detail.active {
        detail.status.clone()
    } else {
        None
    };
    [describe.then(|| detail.description.clone()), running]
        .into_iter()
        .flatten()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

pub fn plugin_row_line(detail: &PluginDetail) -> String {
    [
        origin_text(detail),
        detail.full_control.then(|| FULL_CONTROL_SUMMARY.to_owned()),
        Some(status_of(detail, true)),
    ]
    .into_iter()
    .flatten()
    .filter(|text| !text.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

fn plugin_toggle(view: &SettingsWindowView, detail: &PluginDetail) -> AnyElement {
    let emit = view.emit.clone();
    let name = detail.name.clone();
    let selector = format!("toggle:plugin:{name}");
    div()
        .debug_selector(move || selector)
        .child(
            Toggle::new(
                SharedString::from(format!("toggle:plugin:{name}")),
                detail.active,
                &view.look.p,
            )
            .native(true)
            .disabled(!detail.loads)
            .asks_first(!detail.active)
            .on_toggle(move |on, window, cx| {
                let action = if on { "on" } else { "off" };
                emit.send(cmd(format!("{action}:{name}")), window, cx)
            }),
        )
        .into_any_element()
}

fn plugin_row(view: &SettingsWindowView, name: &str) -> AnyElement {
    let p = view.look.p;
    let detail = view
        .host
        .plugin_detail(name)
        .unwrap_or_else(|| PluginDetail {
            name: name.to_owned(),
            title: name.to_owned(),
            ..PluginDetail::default()
        });
    let title = match &detail.version {
        Some(version) if detail.loads => format!("{} {version}", detail.title),
        _ => detail.title.clone(),
    };
    let emit = view.emit.clone();
    let open = name.to_owned();
    tagged(
        format!("plugin:{name}"),
        row(format!("plugin:{name}"), &p)
            .title(title)
            .description(plugin_row_line(&detail))
            .icon(
                div()
                    .size(px(PLUGIN_ICON_BOX))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(symbol_icon(
                        detail
                            .icon
                            .clone()
                            .unwrap_or_else(|| "puzzlepiece".to_owned()),
                        Icon::Puzzle,
                        PLUGIN_ICON,
                        p.icon,
                    )),
            )
            .on_click(move |_, window, cx| emit.send(cmd(format!("open:{open}")), window, cx))
            .child(plugin_toggle(view, &detail)),
    )
}

pub fn plugin_list_rows(view: &SettingsWindowView) -> Vec<AnyElement> {
    let p = view.look.p;
    let names = user_plugin_names(view);
    if !names.is_empty() {
        return names.iter().map(|name| plugin_row(view, name)).collect();
    }
    let folder = view.host.plugin_folder().unwrap_or_default();
    let mut none = row("plugins-none", &p).title("None yet");
    if view.extras.how_to_add {
        none = none.description(format!(
            "Put a plugin's folder in {folder}, or run ardia plugins install <folder>."
        ));
    } else {
        none = none.child(
            TextButton::new("plugins-how-to-add", "How to add one", &p)
                .look(TextLook::Link)
                .on_click(view.emit.click(cmd("howToAdd"))),
        );
    }
    vec![tagged("plugins-none".into(), none)]
}

pub fn plugin_title(view: &SettingsWindowView) -> Option<SharedString> {
    let Some(Detail::Plugin(name)) = view.sub.detail.as_ref() else {
        return None;
    };
    if view.pane != Pane::Plugins {
        return None;
    }
    let detail = view.host.plugin_detail(name)?;
    Some(SharedString::from(detail.title))
}

pub(crate) fn section(_: &crate::look::Palette, title: &'static str) -> AnyElement {
    div()
        .mt(px(subpages::SECTION_TOP))
        .mb(px(6.))
        .px(px(6.))
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .child(title)
        .into_any_element()
}

pub(crate) fn rows_group(p: &crate::look::Palette, rows: Vec<AnyElement>) -> AnyElement {
    group(p, rows).into_any_element()
}

pub fn plugin_page(view: &SettingsWindowView, name: &str) -> AnyElement {
    let p = view.look.p;
    let Some(detail) = view.host.plugin_detail(name) else {
        return div()
            .child(intro(&p, "This plugin isn't installed any more."))
            .into_any_element();
    };
    let mut blocks: Vec<AnyElement> = Vec::new();
    if !detail.description.is_empty() {
        blocks.push(intro(&p, &detail.description));
    }
    let mut top: Vec<AnyElement> = Vec::new();
    let state_title = if detail.active {
        "On"
    } else if detail.needs_review {
        "Changed since you turned it on"
    } else {
        "Off"
    };
    let state_line: Vec<String> = [origin_text(&detail), Some(status_of(&detail, false))]
        .into_iter()
        .flatten()
        .filter(|text| !text.is_empty())
        .collect();
    let mut state_row = row("plugin-state", &p).title(state_title);
    if !state_line.is_empty() {
        state_row = state_row.description(state_line.join(" · "));
    }
    top.push(tagged(
        "plugin-state".into(),
        state_row.child(plugin_toggle(view, &detail)),
    ));
    if let Some((title, description)) = detail.auto_update.clone() {
        top.push(tagged(
            "plugin-auto-update".into(),
            row("plugin-auto-update", &p)
                .title(title)
                .description(description),
        ));
    }
    if let Some((title, run)) = detail.program.clone() {
        top.push(tagged(
            "plugin-program".into(),
            row("plugin-program", &p)
                .title(title)
                .description(run)
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            PushButton::new("plugin-show-log", "Show Log", &p)
                                .on_click(view.emit.click(cmd(format!("log:{name}")))),
                        )
                        .child(
                            PushButton::new("plugin-restart", "Restart", &p)
                                .on_click(view.emit.click(cmd(format!("restart:{name}")))),
                        ),
                ),
        ));
    }
    if detail.active && !detail.programs.is_empty() {
        let entry = view.host.plugins().and_then(|plugins| {
            plugins
                .plugin_programs()
                .into_iter()
                .find(|e| e.plugin == name)
        });
        let line = entry
            .as_ref()
            .map(programs_text)
            .unwrap_or_else(|| detail.programs.join(", "));
        let mut programs = row("plugin-programs", &p)
            .title(if detail.programs.len() == 1 {
                "Its command"
            } else {
                "Its commands"
            })
            .description(line);
        if entry.as_ref().is_some_and(PluginPrograms::can_relink) {
            programs = programs.child(
                PushButton::new("plugin-programs-again", "Try Again", &p).on_click(
                    view.emit.click(Msg::Command(SharedString::from(format!(
                        "settings:relinkPrograms:{name}"
                    )))),
                ),
            );
        }
        top.push(tagged("plugin-programs".into(), programs));
    }
    blocks.push(rows_group(&p, top));
    if detail.active {
        blocks.extend(crate::settings::plugin_values::section(view, name));
    }
    if detail.password_manager && detail.active {
        blocks.push(section(&p, "Password manager"));
        let using = profiles_using(view, name);
        let line = if using.is_empty() {
            "No profile uses it yet. Pick it in Settings › Profiles › Passwords.".to_owned()
        } else {
            format!("Used in {}.", using.join(", "))
        };
        blocks.push(rows_group(
            &p,
            vec![tagged(
                "plugin-manager-profiles".into(),
                row("plugin-manager-profiles", &p)
                    .title("Profiles")
                    .description(line)
                    .child(
                        PushButton::new("plugin-manager-profiles-button", "Profiles…", &p)
                            .on_click(view.emit.click(Msg::SettingsPane(Pane::Profiles.index()))),
                    ),
            )],
        ));
    }
    if detail.loads {
        blocks.push(section(&p, "What it gets"));
        let lines = detail
            .consent
            .iter()
            .enumerate()
            .map(|(index, line)| {
                tagged(
                    format!("plugin-gets:{index}"),
                    row(format!("plugin-gets:{index}"), &p)
                        .title(line.text.clone())
                        .icon(
                            div()
                                .size(px(PLUGIN_ICON_BOX))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(symbol_icon(line.icon.clone(), Icon::Puzzle, 13., p.icon)),
                        ),
                )
            })
            .collect();
        blocks.push(rows_group(&p, lines));
    } else {
        blocks.push(section(&p, "Problems"));
        let lines = detail
            .problems
            .iter()
            .enumerate()
            .map(|(index, problem)| {
                tagged(
                    format!("plugin-problem:{index}"),
                    row(format!("plugin-problem:{index}"), &p).title(problem.clone()),
                )
            })
            .collect();
        blocks.push(rows_group(&p, lines));
    }
    let remove_line = if detail.official {
        "Removes its download and its commands on your PATH. Its data stays.".to_owned()
    } else {
        "Moves the plugin to the Trash.".to_owned()
    };
    blocks.push(
        div()
            .mt(px(subpages::SECTION_TOP))
            .child(rows_group(
                &p,
                vec![tagged(
                    "plugin-remove".into(),
                    row("plugin-remove", &p)
                        .title("Remove")
                        .description(remove_line)
                        .child(
                            PushButton::new("plugin-remove-button", "Remove…", &p)
                                .kind(ButtonKind::Destructive)
                                .on_click(view.emit.click(cmd(format!("remove:{name}")))),
                        ),
                )],
            ))
            .into_any_element(),
    );
    div().flex().flex_col().children(blocks).into_any_element()
}

fn intro(p: &crate::look::Palette, text: &str) -> AnyElement {
    div()
        .px(px(6.))
        .mb(px(4.))
        .text_size(px(12.))
        .line_height(px(17.))
        .text_color(p.text_secondary)
        .child(text.to_owned())
        .into_any_element()
}

pub fn programs_text(entry: &PluginPrograms) -> String {
    match &entry.status {
        ProgramsStatus::Linking => "Putting its commands on PATH…".to_owned(),
        ProgramsStatus::Failed { reason } => format!("Its commands couldn't go on PATH: {reason}"),
        ProgramsStatus::Linked {
            linked,
            refused,
            bin_dir,
        } => {
            if !refused.is_empty() {
                refused
                    .iter()
                    .map(|(_, reason)| reason.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            } else if linked.is_empty() {
                entry.programs.join(", ")
            } else {
                format!("{} is on PATH ({bin_dir})", linked.join(", "))
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagerPlugin {
    pub name: String,
    pub title: String,
    pub built_in: bool,
}

pub fn manager_plugins(view: &SettingsWindowView) -> Vec<ManagerPlugin> {
    view.host
        .plugin_rows()
        .into_iter()
        .filter_map(|row| view.host.plugin_detail(&row.name))
        .filter(|detail| detail.active && detail.password_manager)
        .map(|detail| ManagerPlugin {
            name: detail.name,
            title: detail.title,
            built_in: detail.official,
        })
        .collect()
}

pub fn choice_plugin(choice: &str) -> Option<&str> {
    choice.strip_prefix("plugin:")
}

pub fn is_choice(value: &str) -> bool {
    value == "ardia"
        || value == "none"
        || choice_plugin(value).is_some_and(|name| {
            let mut chars = name.chars();
            chars
                .next()
                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                && name.len() <= 40
                && name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
}

pub fn sharing_data(state: &BrowserState, profile: &ProfileId) -> Vec<ProfileId> {
    let own = if profile.is_incognito() {
        profile.incognito_original()
    } else {
        profile.clone()
    };
    let Some(owner) = state.profiles.get(&own) else {
        return Vec::new();
    };
    let data_of = |p: &ardia_state::profiles::Profile| {
        p.data_id
            .clone()
            .unwrap_or_else(|| p.id.as_str().to_owned())
    };
    let data = data_of(owner);
    let mut order: Vec<ProfileId> = vec![ProfileId::new(&data)];
    let mut ids: Vec<&ProfileId> = state.profiles.keys().collect();
    ids.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    for id in ids {
        if !order.contains(id) {
            order.push(id.clone());
        }
    }
    order
        .into_iter()
        .filter(|id| state.profiles.get(id).is_some_and(|p| data_of(p) == data))
        .collect()
}

pub fn stored_choice(state: &BrowserState, profile: &ProfileId) -> Option<String> {
    sharing_data(state, profile)
        .into_iter()
        .filter_map(|id| {
            state
                .profiles
                .get(&id)
                .and_then(|p| p.password_manager.clone())
        })
        .find(|choice| is_choice(choice))
}

pub fn effective_choice(stored: Option<&str>, plugins: &[ManagerPlugin]) -> String {
    match stored {
        None => plugins
            .iter()
            .find(|p| p.built_in)
            .map_or_else(|| "ardia".to_owned(), |p| format!("plugin:{}", p.name)),
        Some(stored) => match choice_plugin(stored) {
            Some(name) if !plugins.iter().any(|p| p.name == name) => "ardia".to_owned(),
            _ => stored.to_owned(),
        },
    }
}

pub fn handed_over_note(effective: &str, plugins: &[ManagerPlugin]) -> Option<String> {
    if effective == "ardia" {
        return None;
    }
    if effective == "none" {
        return Some("Your password manager extension handles logins in this profile, so Ardia doesn't offer to save them.".to_owned());
    }
    let title = plugins
        .iter()
        .find(|p| format!("plugin:{}", p.name) == effective)
        .map_or("Another password manager", |p| p.title.as_str());
    Some(format!(
        "{title} handles logins in this profile, so Ardia doesn't offer to save them. Logins already saved in Ardia still fill."
    ))
}

pub fn shared_choice_note(names: &[String]) -> Option<String> {
    let others = match names {
        [] => return None,
        [one] => one.clone(),
        [one, two] => format!("{one} and {two}"),
        [first, rest @ ..] => format!("{first} and {} others", rest.len()),
    };
    let verb = if names.len() == 1 { "shares" } else { "share" };
    Some(format!(
        "Also applies to {others}, which {verb} this profile's browser data."
    ))
}

pub struct StoredPlugin {
    pub title: String,
    pub installed: bool,
}

pub fn unavailable_note(
    stored: Option<&str>,
    effective: &str,
    plugin: Option<&StoredPlugin>,
) -> Option<String> {
    let stored = stored?;
    choice_plugin(stored)?;
    if stored == effective {
        return None;
    }
    let plugin = plugin?;
    Some(if plugin.installed {
        format!(
            "{} is off, so this profile uses Ardia until you turn it back on in Plugins or pick another password manager.",
            plugin.title
        )
    } else {
        format!(
            "{} isn't installed, so this profile uses Ardia. Pick another password manager, or install it again.",
            plugin.title
        )
    })
}

pub fn manager_options(
    plugins: &[ManagerPlugin],
    stored: Option<&str>,
    effective: &str,
    stored_plugin: Option<&StoredPlugin>,
) -> (String, Vec<(String, String, bool)>) {
    let off_plugin = stored
        .filter(|stored| *stored != effective && choice_plugin(stored).is_some())
        .map(str::to_owned);
    let mut options = vec![("ardia".to_owned(), "Ardia".to_owned(), false)];
    options.extend(
        plugins
            .iter()
            .map(|p| (format!("plugin:{}", p.name), p.title.clone(), false)),
    );
    if let Some(off) = &off_plugin {
        let title = stored_plugin.map_or_else(
            || choice_plugin(off).unwrap_or_default().to_owned(),
            |p| p.title.clone(),
        );
        let state = if stored_plugin.is_some_and(|p| !p.installed) {
            "not installed"
        } else {
            "off"
        };
        options.push((off.clone(), format!("{title} ({state})"), false));
    }
    options.push((
        "none".to_owned(),
        "None (an extension handles logins)".to_owned(),
        true,
    ));
    (off_plugin.unwrap_or_else(|| effective.to_owned()), options)
}

fn stored_plugin(view: &SettingsWindowView, stored: Option<&str>) -> Option<StoredPlugin> {
    let name = choice_plugin(stored?)?;
    let detail = view.host.plugin_detail(name);
    Some(StoredPlugin {
        title: detail
            .as_ref()
            .map_or_else(|| name.to_owned(), |d| d.title.clone()),
        installed: detail.is_some(),
    })
}

pub fn profiles_using(view: &SettingsWindowView, name: &str) -> Vec<String> {
    let plugins = manager_plugins(view);
    let wanted = format!("plugin:{name}");
    view.state
        .profile_order
        .iter()
        .filter_map(|id| {
            let profile = view.state.profiles.get(id)?;
            let stored = stored_choice(&view.state, id);
            (effective_choice(stored.as_deref(), &plugins) == wanted).then(|| profile.name.clone())
        })
        .collect()
}

pub fn password_manager_description(
    view: &SettingsWindowView,
    profile: &ProfileId,
) -> Option<String> {
    let plugins = manager_plugins(view);
    let stored = stored_choice(&view.state, profile);
    let effective = effective_choice(stored.as_deref(), &plugins);
    let stored_plugin = stored_plugin(view, stored.as_deref());
    let sharing: Vec<String> = sharing_data(&view.state, profile)
        .into_iter()
        .filter(|id| id != profile)
        .filter_map(|id| view.state.profiles.get(&id).map(|p| p.name.clone()))
        .collect();
    let parts: Vec<String> = [
        unavailable_note(stored.as_deref(), &effective, stored_plugin.as_ref()),
        shared_choice_note(&sharing),
    ]
    .into_iter()
    .flatten()
    .collect();
    (!parts.is_empty()).then(|| parts.join(" "))
}

pub fn handed_over(view: &SettingsWindowView, profile: &ProfileId) -> Option<String> {
    let plugins = manager_plugins(view);
    let stored = stored_choice(&view.state, profile);
    handed_over_note(&effective_choice(stored.as_deref(), &plugins), &plugins)
}

pub fn password_manager_popup(view: &SettingsWindowView, profile: &ProfileId) -> AnyElement {
    let p = view.look.p;
    let plugins = manager_plugins(view);
    let stored = stored_choice(&view.state, profile);
    let effective = effective_choice(stored.as_deref(), &plugins);
    let stored_plugin = stored_plugin(view, stored.as_deref());
    let (value, options) = manager_options(
        &plugins,
        stored.as_deref(),
        &effective,
        stored_plugin.as_ref(),
    );
    let label = options
        .iter()
        .find(|(choice, _, _)| *choice == value)
        .map(|(_, title, _)| title.clone())
        .unwrap_or_default();
    let open = view.menu.as_deref() == Some(PASSWORD_MANAGER_MENU);
    let id = profile.clone();
    div()
        .relative()
        .child(
            div()
                .debug_selector(|| "popup:passwordManager".into())
                .child(
                    PopUp::new("popup:passwordManager", label, &p)
                        .min_width(MANAGER_POPUP_WIDTH)
                        .native(true)
                        .on_click(crate::primitives::pop_up_menu::opener(
                            &view.host,
                            &view.emit,
                            options
                                .iter()
                                .map(|(choice, title, split)| {
                                    crate::primitives::pop_up_menu::PopUpChoice::new(
                                        title.clone(),
                                        *choice == value,
                                        vec![cmd(format!("manager:{}:{choice}", id.as_str()))],
                                    )
                                    .separated(*split)
                                    .value(choice.to_string())
                                })
                                .collect(),
                            Msg::Command(menu_command(PASSWORD_MANAGER_MENU)),
                        )),
                ),
        )
        .when(open, |this| {
            this.child(
                gpui::deferred(
                    popover("popup-menu:passwordManager", false, MANAGER_POPUP_WIDTH, &p)
                        .debug_selector(|| "popup-menu:passwordManager".into())
                        .absolute()
                        .top(px(POPUP_HEIGHT + 2.))
                        .right_0()
                        .children(options.into_iter().enumerate().flat_map(
                            |(index, (choice, title, split))| {
                                let emit = view.emit.clone();
                                let msg = cmd(format!("manager:{}:{choice}", id.as_str()));
                                let item = MenuRow::new(
                                    SharedString::from(format!(
                                        "popup-item:passwordManager:{index}"
                                    )),
                                    title,
                                    &p,
                                )
                                .checked(choice == value)
                                .on_click(move |_, window, cx| {
                                    emit.send(Msg::CloseOverlays, window, cx);
                                    emit.send(msg.clone(), window, cx);
                                })
                                .into_any_element();
                                let mut out: Vec<AnyElement> = Vec::new();
                                if split {
                                    out.push(separator(&p).into_any_element());
                                }
                                out.push(item);
                                out
                            },
                        )),
                )
                .with_priority(2),
            )
        })
        .into_any_element()
}

pub const ONE_PASSWORD_EXTENSIONS: &[&str] = &[
    "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
    "khgocmkkpikpnmmkgmdnfckapcdkgfaf",
    "gejiddohjgogedgjnonbofjigllpkmbf",
    "hjlinigoblmkhjejkmbegnoaljkphmgo",
    "dppgmdbiimibapkepcbdbmkaabgiofem",
];
pub const ONE_PASSWORD_APP: &str = "/Applications/1Password.app";
pub const PAIRING_TITLE: &str = "Connect to the 1Password app";

pub fn pairing_steps(in_applications: bool) -> String {
    let trust = "The 1Password app unlocks its extension only in browsers it trusts. Until it trusts Ardia, the extension locks itself on its own timer.";
    if in_applications {
        format!(
            "{trust} In the 1Password app, open Settings › Browser › Add Browser and choose Ardia."
        )
    } else {
        format!(
            "{trust} Move Ardia to your Applications folder and reopen it (1Password only connects to browsers there), then in the 1Password app open Settings › Browser › Add Browser and choose Ardia."
        )
    }
}

fn in_applications_folder() -> bool {
    std::env::current_exe()
        .map(|path| path.starts_with("/Applications"))
        .unwrap_or(true)
}

pub fn pairing_rows(view: &SettingsWindowView, extension_id: &str) -> Vec<AnyElement> {
    let p = view.look.p;
    if !ONE_PASSWORD_EXTENSIONS.contains(&extension_id)
        || !std::path::Path::new(ONE_PASSWORD_APP).exists()
    {
        return Vec::new();
    }
    vec![
        section(&p, "Desktop app"),
        rows_group(
            &p,
            vec![tagged(
                "pairing".into(),
                row("pairing", &p)
                    .title(PAIRING_TITLE)
                    .description(pairing_steps(in_applications_folder()))
                    .child(
                        PushButton::new("pairing-open", "Open 1Password", &p)
                            .on_click(view.emit.click(cmd(format!("openApp:{ONE_PASSWORD_APP}")))),
                    ),
            )],
        ),
    ]
}

pub fn run(
    view: &mut SettingsWindowView,
    command: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(rest) = command.strip_prefix(COMMAND) else {
        return;
    };
    let (verb, argument) = rest.split_once(':').unwrap_or((rest, ""));
    match verb {
        "setupCode" => apply_setup_code(view, cx),
        "howToAdd" => {
            view.extras.how_to_add = true;
        }
        "open" => {
            if !argument.is_empty() {
                subpages::open_detail(view, Some(Detail::Plugin(argument.to_owned())), window, cx);
            }
        }
        "on" => {
            if let Some(plugins) = view.host.plugins()
                && !plugins.turn_on_approved(argument)
            {
                plugins.ask_consent(argument, ConsentOwner::Settings);
            }
        }
        "off" => view.host.turn_plugin_off(argument.to_owned()),
        "log" => view.host.plugin_command(argument, PluginCommand::ShowLog),
        "restart" => view.host.plugin_command(argument, PluginCommand::Restart),
        "remove" => remove_plugin(view, argument.to_owned(), window, cx),
        "install" | "again" => install_official(view, argument.to_owned(), cx),
        "copy" => {
            cx.write_to_clipboard(ClipboardItem::new_string(argument.to_owned()));
            view.extras.copied = Some((argument.to_owned(), Instant::now()));
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(COPIED_FOR).await;
                let _ = this.update(cx, |_, cx| cx.notify());
            })
            .detach();
        }
        "manager" => {
            if let Some((profile, choice)) = argument.split_once(':')
                && is_choice(choice)
            {
                ardia_telemetry::counts::count(match choice {
                    "ardia" => "password_manager_chose_ardia",
                    "none" => "password_manager_chose_none",
                    _ => "password_manager_chose_plugin",
                });
                let profile = ProfileId::new(profile);
                for id in sharing_data(&view.state, &profile) {
                    view.host.dispatch(Action::UpdateProfile {
                        profile: id,
                        patch: ardia_state::ProfilePatch {
                            password_manager: Some(Some(choice.to_owned())),
                            ..ardia_state::ProfilePatch::default()
                        },
                    });
                }
            }
        }
        "openApp" => {
            ardia_telemetry::counts::count("password_app_pairing_opened");
            view.host.open_path(argument.to_owned())
        }
        verb if crate::settings::plugin_values::VERBS.contains(&verb) => {
            crate::settings::plugin_values::run(view, verb, argument, window, cx);
        }
        _ => {}
    }
    cx.notify();
}

fn install_official(
    view: &mut SettingsWindowView,
    name: String,
    cx: &mut Context<SettingsWindowView>,
) {
    if view.extras.official_busy.contains(&name) {
        return;
    }
    let programs = programs_of(view, &name);
    let installed = official_plugins(view)
        .iter()
        .any(|p| p.name == name && p.state == OfficialPluginState::Installed && p.update.is_none());
    if installed
        && programs
            .as_ref()
            .is_some_and(|status| !matches!(status, ProgramsStatus::Linking))
    {
        let _ = view
            .host
            .plugins()
            .map(|plugins| plugins.relink_programs(&name));
        return;
    }
    let Some(reply) = view.host.install_official_plugin(name.clone()) else {
        return;
    };
    view.extras.official_busy.push(name.clone());
    view.extras.official_failures.remove(&name);
    cx.spawn(async move |this, cx| {
        let outcome = reply.await.unwrap_or_else(|_| Err(String::new()));
        let _ = this.update(cx, |view, cx| {
            view.extras.official_busy.retain(|busy| *busy != name);
            match outcome {
                Ok(()) => {
                    crate::onboarding::plugins_step::note_official_plugin(
                        "settings",
                        "installed",
                        &name,
                    );
                    view.extras.official_failures.remove(&name);
                }
                Err(reason) if !reason.is_empty() && reason != "Cancelled" => {
                    crate::onboarding::plugins_step::note_official_plugin(
                        "settings", "failed", &name,
                    );
                    view.extras.official_failures.insert(name.clone(), reason);
                }
                Err(_) => {}
            }
            cx.notify();
        });
    })
    .detach();
}

fn remove_plugin(
    view: &mut SettingsWindowView,
    name: String,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(detail) = view.host.plugin_detail(&name) else {
        return;
    };
    let answer = view
        .host
        .confirm_attached(window, removal_question(&detail));
    cx.spawn(async move |this, cx| {
        if !answer.await.unwrap_or(false) {
            ardia_telemetry::counts::count("plugin_removals_cancelled");
            return;
        }
        let _ = this.update(cx, |view, cx| {
            let removed = match view.host.plugins() {
                Some(plugins) => plugins.remove_plugin(&name),
                None => {
                    view.host.plugin_command(&name, PluginCommand::Remove);
                    true
                }
            };
            if removed {
                view.leave_detail(cx);
            }
            cx.notify();
        });
    })
    .detach();
}

pub fn removal_question(detail: &PluginDetail) -> crate::host::Confirmation {
    crate::host::Confirmation {
        title: format!("Remove {}?", detail.title),
        message: if detail.official {
            "Its download and its commands on your PATH are removed. Its data and secrets stay, so installing it again picks up where you left off.".to_owned()
        } else {
            "Its folder moves to the Trash, and its data and its panel's website data are deleted."
                .to_owned()
        },
        confirm: "Remove".to_owned(),
        destructive: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn official(state: OfficialPluginState) -> OfficialPlugin {
        OfficialPlugin {
            name: "cli".into(),
            title: "Command Line".into(),
            blurb: "Drive Ardia".into(),
            icon: "terminal.fill".into(),
            state,
            version: Some("0.6.0".into()),
            update: None,
            example: Some("ardia tabs".into()),
        }
    }

    #[test]
    fn official_rows_follow_the_old_official_view() {
        assert_eq!(
            installed_label(&official(OfficialPluginState::Installed)),
            "Installed · 0.6.0"
        );
        let available = official_view(
            &official(OfficialPluginState::Available),
            None,
            false,
            None,
            None,
        );
        assert_eq!(available.action, Some("install"));
        assert!(available.opens);
        let failed = official_view(
            &official(OfficialPluginState::Installed),
            Some(&ProgramsStatus::Failed {
                reason: "no PATH".into(),
            }),
            false,
            None,
            None,
        );
        assert_eq!(failed.status.as_deref(), Some("Not on your PATH: no PATH"));
        assert_eq!(failed.action, Some("again"));
        assert!(failed.failed && failed.installed);
        let linked = official_view(
            &official(OfficialPluginState::Installed),
            Some(&ProgramsStatus::Linked {
                linked: vec!["ardia".into()],
                refused: vec![],
                bin_dir: "/bin".into(),
            }),
            false,
            None,
            None,
        );
        assert_eq!(linked.first_command.as_deref(), Some("ardia tabs"));
        let update = OfficialPlugin {
            update: Some("0.7.0".into()),
            ..official(OfficialPluginState::Installed)
        };
        let ready = official_view(&update, None, false, None, None);
        assert_eq!(
            ready.status.as_deref(),
            Some("Version 0.7.0 is ready. Review what it gets to update.")
        );
        assert_eq!(ready.action, Some("update"));
        let refused = official_view(&update, None, false, Some("Cancelled."), None);
        assert_eq!(refused.action, Some("update"));
        assert!(refused.failed);
        let downloading = official_view(
            &official(OfficialPluginState::Available),
            None,
            true,
            None,
            Some(crate::host::OfficialInstallPhase::Downloading {
                received: 50,
                total: 200,
            }),
        );
        assert_eq!(downloading.status.as_deref(), Some("Downloading… 25%"));
        let soon = official_view(
            &official(OfficialPluginState::ComingSoon),
            None,
            false,
            None,
            None,
        );
        assert!(soon.coming_soon && !soon.opens);
        assert_eq!(
            official_view(
                &official(OfficialPluginState::Unsupported),
                None,
                false,
                None,
                None
            ),
            OfficialView::default()
        );
    }

    #[test]
    fn setup_code_lines_read_like_the_old_row() {
        assert_eq!(setup_code_description(None), SETUP_CODE_HINT);
        assert_eq!(
            setup_code_description(Some(&Ok(vec!["Sidebar".into(), "Dark".into()]))),
            "Applied: Sidebar, Dark."
        );
        assert_eq!(
            setup_code_description(Some(&Err(setup_code::ERROR_SHAPE))),
            setup_code::ERROR_SHAPE
        );
    }

    #[test]
    fn password_manager_choices_match_the_old_row() {
        let plugins = vec![ManagerPlugin {
            name: "vault".into(),
            title: "Vault".into(),
            built_in: false,
        }];
        assert_eq!(effective_choice(None, &plugins), "ardia");
        let built_in = vec![ManagerPlugin {
            built_in: true,
            ..plugins[0].clone()
        }];
        assert_eq!(effective_choice(None, &built_in), "plugin:vault");
        assert_eq!(effective_choice(Some("plugin:gone"), &plugins), "ardia");
        assert_eq!(effective_choice(Some("none"), &plugins), "none");
        assert!(is_choice("plugin:vault-2"));
        assert!(!is_choice("plugin:Vault"));
        assert!(!is_choice("other"));
        let (value, options) = manager_options(
            &plugins,
            Some("plugin:gone"),
            "ardia",
            Some(&StoredPlugin {
                title: "Gone".into(),
                installed: false,
            }),
        );
        assert_eq!(value, "plugin:gone");
        let titles: Vec<&str> = options.iter().map(|(_, t, _)| t.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "Ardia",
                "Vault",
                "Gone (not installed)",
                "None (an extension handles logins)"
            ]
        );
        assert!(options.last().is_some_and(|(_, _, split)| *split));
        assert_eq!(
            unavailable_note(
                Some("plugin:gone"),
                "ardia",
                Some(&StoredPlugin {
                    title: "Gone".into(),
                    installed: true
                })
            )
            .as_deref(),
            Some(
                "Gone is off, so this profile uses Ardia until you turn it back on in Plugins or pick another password manager."
            )
        );
        assert_eq!(handed_over_note("ardia", &plugins), None);
        assert!(
            handed_over_note("plugin:vault", &plugins)
                .is_some_and(|n| n.starts_with("Vault handles logins"))
        );
        assert_eq!(shared_choice_note(&[]), None);
        assert_eq!(
            shared_choice_note(&["Work".into()]).as_deref(),
            Some("Also applies to Work, which shares this profile's browser data.")
        );
        assert_eq!(
            shared_choice_note(&["A".into(), "B".into(), "C".into()]).as_deref(),
            Some("Also applies to A and 2 others, which share this profile's browser data.")
        );
    }

    #[test]
    fn plugin_lines_follow_the_old_plugins_pane() {
        let detail = PluginDetail {
            name: "demo".into(),
            title: "Demo".into(),
            description: "Does things".into(),
            loads: true,
            official: true,
            active: true,
            full_control: true,
            status: Some("Running".into()),
            ..PluginDetail::default()
        };
        assert_eq!(
            plugin_row_line(&detail),
            "Official · Can fully control Ardia · Does things · Running"
        );
        assert_eq!(status_of(&detail, false), "Running");
        let broken = PluginDetail {
            name: "broken".into(),
            problems: vec!["a".into(), "b".into(), "c".into()],
            ..PluginDetail::default()
        };
        assert_eq!(status_of(&broken, true), "a; b");
        let review = PluginDetail {
            loads: true,
            needs_review: true,
            ..PluginDetail::default()
        };
        assert_eq!(
            status_of(&review, true),
            "Its plugin.json changed. Review it to turn it back on."
        );
    }
}
