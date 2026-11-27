use crate::scale::px;
use gpui::{
    AnyElement, Context, Entity, FontWeight, Hsla, IntoElement, ParentElement, SharedString,
    Styled, Window, div, linear_color_stop, linear_gradient, prelude::*,
};
use serde_json::Value;

use crate::look::Palette;
use crate::msg::Msg;
use crate::primitives::controls::{
    ButtonKind, Checkbox, IconButton, PushButton, Toggle, field_box,
};
use crate::primitives::icons::Icon;
use crate::primitives::list::{Row, group};
use crate::primitives::text_input::{InputEvent, TextInput, text_field_style};
use crate::primitives::virtual_list::{VirtualItem, virtual_list};
use crate::settings::SettingsWindowView;
use crate::settings::data::{self, SettingsCall, SettingsQuery};
use crate::settings::memo::{
    DESCRIBED_ROW_ESTIMATE, Listed, ROW_ESTIMATE, group_piece, grouped_list, wrapped,
};
use crate::settings::panes;
use crate::settings::subpages::{COMMAND, TitleLine, header};
use crate::site::model::{
    BlockerList, ContentBlockerCommand, ContentBlockerView, HiddenElement, hidden_element_title,
    parse_hiding_filter,
};
use ardia_state::ProfileId;

pub const OPEN_FILTER_LISTS: &str = "settings:sub:open:filterLists";
pub const OPEN_CRASH_DETAILS: &str = "settings:sub:open:crashDetails";
pub const AVATAR_SIZE: f32 = 28.0;
pub const LIST_ADDRESS_LIMIT: usize = 2048;

pub const CATEGORIES: [(&str, &str, Option<&str>); 6] = [
    ("ads", "Ad blockers", Some("general.blockAds")),
    ("trackers", "Trackers", Some("general.blockTrackers")),
    (
        "cookies",
        "Cookie banners",
        Some("general.blockCookieBanners"),
    ),
    ("annoyances", "Annoyances", None),
    ("security", "Malware and scams", None),
    ("regional", "Regional blockers", None),
];

pub fn category_of_row(row: &str) -> Option<&'static str> {
    CATEGORIES
        .iter()
        .find(|(_, _, anchor)| *anchor == Some(row))
        .map(|(id, _, _)| *id)
}

pub fn blocker_available(view: Option<&ContentBlockerView>) -> Option<&ContentBlockerView> {
    view.filter(|v| v.stats.ready && !v.lists.is_empty())
}

pub fn category_on(blocker: &ContentBlockerView, category: &str) -> bool {
    blocker.enabled
        && blocker
            .lists
            .iter()
            .any(|l| l.category == category && l.enabled)
}

fn set_lists(blocker: &ContentBlockerView, ids: &[String], on: bool) -> Vec<ContentBlockerCommand> {
    let mut out: Vec<ContentBlockerCommand> = ids
        .iter()
        .map(|id| ContentBlockerCommand::SetListEnabled {
            id: id.clone(),
            enabled: on,
        })
        .collect();
    let any_on = blocker.lists.iter().any(|l| {
        if ids.contains(&l.id) {
            on
        } else {
            blocker.enabled && l.enabled
        }
    });
    if any_on != blocker.enabled {
        out.push(ContentBlockerCommand::SetEnabled(any_on));
    }
    out
}

pub fn blocking_category_commands(
    blocker: &ContentBlockerView,
    category: &str,
    on: bool,
) -> Vec<ContentBlockerCommand> {
    let lists: Vec<&BlockerList> = blocker
        .lists
        .iter()
        .filter(|l| l.category == category)
        .collect();
    let usual: Vec<&BlockerList> = lists
        .iter()
        .copied()
        .filter(|l| l.default_on || l.enabled)
        .collect();
    let starters: Vec<&BlockerList> = if usual.is_empty() {
        lists
            .iter()
            .copied()
            .filter(|l| l.id.contains("easylist") || l.id.contains("fanboy"))
            .collect()
    } else {
        usual
    };
    let changed: Vec<String> = if on {
        if starters.is_empty() {
            &lists
        } else {
            &starters
        }
        .iter()
        .map(|l| l.id.clone())
        .collect()
    } else {
        lists
            .iter()
            .filter(|l| l.enabled)
            .map(|l| l.id.clone())
            .collect()
    };
    set_lists(blocker, &changed, on)
}

pub fn list_commands(
    blocker: &ContentBlockerView,
    id: &str,
    on: bool,
) -> Vec<ContentBlockerCommand> {
    set_lists(blocker, &[id.to_owned()], on)
}

pub fn filter_list_address(typed: &str) -> Option<String> {
    let text = typed.trim();
    if text.is_empty() || text.len() > LIST_ADDRESS_LIMIT || text.chars().any(char::is_whitespace) {
        return None;
    }
    let has_scheme = text.split_once(':').is_some_and(|(scheme, _)| {
        scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let with_scheme = if has_scheme {
        text.to_owned()
    } else {
        format!("https://{text}")
    };
    let (scheme, rest) = with_scheme.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if host.is_empty() || (!host.contains('.') && host != "localhost") {
        return None;
    }
    let path = &rest[authority.len()..];
    Some(format!(
        "{scheme}://{}{}",
        authority.to_ascii_lowercase(),
        if path.is_empty() { "/" } else { path }
    ))
}

pub fn filter_list_label(id: &str, title: &str) -> String {
    if !title.is_empty() && title != id {
        return title.to_owned();
    }
    match id.split_once("://") {
        Some((_, rest)) => {
            let (host, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
            if path.is_empty() || path == "/" {
                host.to_owned()
            } else {
                format!("{host}{path}")
            }
        }
        None => id.to_owned(),
    }
}

pub fn filters_text(n: u64) -> String {
    format!(
        "{} {}",
        grouped(n),
        if n == 1 { "filter" } else { "filters" }
    )
}

fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (index, c) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn custom_list_text(list: &BlockerList) -> String {
    if list.failed {
        "Couldn't download. uBlock Origin tries again at the next update.".to_owned()
    } else if list.filters > 0 {
        filters_text(list.filters)
    } else {
        "Downloading…".to_owned()
    }
}

pub fn version_note(blocker: &ContentBlockerView) -> String {
    if blocker.version.is_empty() {
        String::new()
    } else {
        format!(
            "Blocking by uBlock Origin {}, included with Ardia. Its lists update on their own.",
            blocker.version
        )
    }
}

pub fn rules_footnote(blocker: &ContentBlockerView) -> String {
    format!(
        "{} network and {} cosmetic rules loaded. {}",
        grouped(blocker.stats.network_filters),
        grouped(blocker.stats.cosmetic_filters),
        version_note(blocker)
    )
}

fn cmd(text: impl Into<String>) -> Msg {
    Msg::Command(SharedString::from(text.into()))
}

fn tagged(selector: String, element: impl IntoElement) -> AnyElement {
    div()
        .debug_selector(move || selector)
        .child(element)
        .into_any_element()
}

fn row(id: impl Into<SharedString>, p: &Palette) -> Row {
    let id: SharedString = id.into();
    Row::new(gpui::ElementId::Name(id), p).native(true)
}

fn button(view: &SettingsWindowView, id: String, label: &'static str, msg: Msg) -> PushButton {
    PushButton::new(gpui::ElementId::Name(id.into()), label, &view.look.p)
        .on_click(view.emit.click(msg))
}

pub fn control_approvals(view: &SettingsWindowView) -> Option<data::ControlApprovals> {
    view.host
        .settings_value(&SettingsQuery::ControlApprovals)
        .map(|value| data::control_approvals_of(&value))
}

pub fn allowed_programs_description(view: &SettingsWindowView) -> String {
    control_approvals(view)
        .and_then(|approvals| data::allowed_programs_note(&approvals))
        .unwrap_or_else(|| data::ALLOWED_PROGRAMS_BASE.to_owned())
}

pub fn approval_rows(view: &SettingsWindowView) -> Vec<AnyElement> {
    let p = view.look.p;
    let now = ardia_state::store::now_ms() as f64;
    control_approvals(view)
        .map(|approvals| approvals.approvals)
        .unwrap_or_default()
        .into_iter()
        .map(|approval| {
            tagged(
                format!("approval:{}", approval.key),
                row(format!("approval:{}", approval.key), &p)
                    .title_line(approval.name.clone())
                    .description(data::approval_line(&approval, now))
                    .child(
                        IconButton::new(
                            SharedString::from(format!("approval-remove:{}", approval.key)),
                            Icon::Trash,
                            &p,
                        )
                        .square(24., 5.)
                        .glyph(13.)
                        .tooltip("Remove", &p)
                        .on_click(
                            view.emit
                                .click(cmd(format!("{COMMAND}approval:revoke:{}", approval.key))),
                        ),
                    ),
            )
        })
        .collect()
}

pub fn search_controlled_row(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let Some(engine) = crate::settings::subpages::controlling_extension(view) else {
        return div().into_any_element();
    };
    let name = if engine.extension_name.is_empty() {
        "An extension".to_owned()
    } else {
        engine.extension_name.clone()
    };
    let id = engine.extension_id.clone();
    tagged(
        "setting:profiles.searchControlled".into(),
        row("search-controlled", &p)
            .icon(
                div()
                    .flex_none()
                    .size(px(18.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(crate::primitives::icons::icon(
                        Icon::PuzzleExtension,
                        13.,
                        p.form_accent,
                    )),
            )
            .title_line(format!("{name} is controlling this setting"))
            .description(
                "To change your default search engine, disable the extension or manage its settings.",
            )
            .child(button(
                view,
                "search-controlled-manage".into(),
                "Manage",
                cmd(format!("{COMMAND}open:extension:{id}")),
            ))
            .child(button(
                view,
                "search-controlled-disable".into(),
                "Disable",
                cmd(format!("{COMMAND}ext:enable:false:{id}")),
            )),
    )
}

pub fn content_blocking_control(view: &SettingsWindowView, row_id: &'static str) -> AnyElement {
    let category = category_of_row(row_id).unwrap_or("ads");
    let blocker = frame_blocker(view);
    if blocker.is_none() && !view.sub.blocker_asked.replace(true) {
        view.host
            .content_blocker_command(ContentBlockerCommand::Refresh);
    }
    let available = blocker_available(blocker);
    let on = available.is_some_and(|b| category_on(b, category));
    let emit = view.emit.clone();
    let selector = format!("toggle:{row_id}");
    div()
        .debug_selector(move || selector)
        .child(
            Toggle::new(
                SharedString::from(format!("toggle:{row_id}")),
                on,
                &view.look.p,
            )
            .native(true)
            .disabled(available.is_none())
            .on_toggle(move |value, window, cx| {
                emit.send(
                    cmd(format!("{COMMAND}blocker:category:{category}:{value}")),
                    window,
                    cx,
                )
            }),
        )
        .into_any_element()
}

pub fn blocker_unavailable(view: &SettingsWindowView) -> bool {
    frame_blocker(view).is_some_and(|b| blocker_available(Some(b)).is_none())
}

fn frame_blocker(view: &SettingsWindowView) -> Option<&ContentBlockerView> {
    view.sub
        .memo
        .frame
        .blocker
        .get_or_init(|| view.host.content_blocker())
        .as_ref()
}

pub fn retry_row(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    row("blocker-retry", &p)
        .title_line("uBlock Origin isn't answering")
        .description("Its settings show here once it responds. Pages keep the blocking they had.")
        .child(button(
            view,
            "blocker-retry-button".into(),
            "Try Again",
            cmd(format!("{COMMAND}blocker:retry")),
        ))
        .into_any_element()
}

fn checkbox_title(
    view: &SettingsWindowView,
    id: String,
    on: bool,
    label: String,
    command: String,
) -> AnyElement {
    let emit = view.emit.clone();
    let selector = id.clone();
    div()
        .debug_selector(move || selector)
        .h(px(16.))
        .flex()
        .items_center()
        .child(
            Checkbox::new(SharedString::from(id), on, label, &view.look.p)
                .on_toggle(move |_, window, cx| emit.send(cmd(command.clone()), window, cx)),
        )
        .into_any_element()
}

pub fn filter_lists_page(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let blocker = frame_blocker(view);
    let available = blocker_available(blocker);
    let mut out: Vec<AnyElement> = vec![
        div()
            .mt(px(16.))
            .text_size(px(12.))
            .line_height(px(17.))
            .text_color(p.text_secondary)
            .child("Extra filter lists for the blocker.")
            .into_any_element(),
    ];
    if blocker.is_some() && available.is_none() {
        out.push(header(&p, "uBlock Origin", None, None));
        out.push(group(&p, [retry_row(view)]).into_any_element());
    }
    let lists: &[BlockerList] = available.map(|b| b.lists.as_slice()).unwrap_or_default();
    let custom: Vec<&BlockerList> = lists.iter().filter(|l| l.category == "custom").collect();
    out.push(header(
        &p,
        "Your lists",
        Some(SharedString::new_static(
            "Filter lists you add by address, in Adblock Plus or uBlock Origin format.",
        )),
        None,
    ));
    let mut custom_rows: Vec<AnyElement> = custom
        .iter()
        .map(|list| {
            row(format!("custom-list:{}", list.id), &p)
                .title_element(checkbox_title(
                    view,
                    format!("check:list:{}", list.id),
                    list.enabled,
                    filter_list_label(&list.id, &list.title),
                    format!("{COMMAND}blocker:list:{}:{}", !list.enabled, list.id),
                ))
                .description(custom_list_text(list))
                .child(
                    IconButton::new(
                        SharedString::from(format!("custom-list-remove:{}", list.id)),
                        Icon::Trash,
                        &p,
                    )
                    .square(24., 5.)
                    .glyph(13.)
                    .tooltip("Remove", &p)
                    .on_click(
                        view.emit
                            .click(cmd(format!("{COMMAND}blocker:removeList:{}", list.id))),
                    ),
                )
                .into_any_element()
        })
        .collect();
    let typed = view.sub.list_typed.trim().to_owned();
    let invalid = view.sub.list_tried && filter_list_address(&typed).is_none();
    custom_rows.push(
        row("custom-list-add", &p)
            .title_element(
                field_box(&p)
                    .debug_selector(|| "custom-list-field".into())
                    .h(px(22.))
                    .when(invalid, |this| this.border_color(p.destructive))
                    .children(
                        view.sub
                            .list_input
                            .clone()
                            .map(|input| div().flex_1().min_w_0().child(input)),
                    ),
            )
            .child(
                button(
                    view,
                    "custom-list-add-button".into(),
                    "Add",
                    cmd(format!("{COMMAND}blocker:addList")),
                )
                .disabled(available.is_none() || typed.is_empty()),
            )
            .into_any_element(),
    );
    out.push(group(&p, custom_rows).into_any_element());
    if let Some((text, error)) = view.sub.list_note.clone() {
        out.push(
            div()
                .mt(px(6.))
                .text_size(px(11.))
                .text_color(if error {
                    p.destructive
                } else {
                    p.text_tertiary
                })
                .child(text)
                .into_any_element(),
        );
    }
    for (category, section, _) in CATEGORIES {
        let shown: Vec<&BlockerList> = lists.iter().filter(|l| l.category == category).collect();
        if shown.is_empty() {
            continue;
        }
        out.push(header(&p, section, None, None));
        out.push(
            group(
                &p,
                shown.iter().map(|list| {
                    let description = if list.default_on {
                        format!("{} · On by default", filters_text(list.filters))
                    } else {
                        filters_text(list.filters)
                    };
                    row(format!("list:{}", list.id), &p)
                        .title_element(checkbox_title(
                            view,
                            format!("check:list:{}", list.id),
                            list.enabled,
                            list.title.clone(),
                            format!("{COMMAND}blocker:list:{}:{}", !list.enabled, list.id),
                        ))
                        .description(description)
                        .into_any_element()
                }),
            )
            .into_any_element(),
        );
    }
    if let Some(blocker) = available
        && !blocker.allowed_hosts.is_empty()
    {
        out.push(header(
            &p,
            "Sites without blocking",
            Some(SharedString::new_static(
                "Turned off from a site's controls. Blocking applies to subdomains too.",
            )),
            None,
        ));
        out.push(
            group(
                &p,
                blocker.allowed_hosts.iter().map(|host| {
                    let mut line = row(format!("allowed:{host}"), &p);
                    if let Some(profile) = crate::settings::panes::selected_profile(view) {
                        line = line.icon(crate::settings::subpages::site_icon(
                            view,
                            &profile,
                            &format!("https://{host}"),
                            16.,
                        ));
                    }
                    line.title_line(host.clone())
                        .child(button(
                            view,
                            format!("allowed-block:{host}"),
                            "Block Again",
                            cmd(format!("{COMMAND}blocker:blockAgain:{host}")),
                        ))
                        .into_any_element()
                }),
            )
            .into_any_element(),
        );
    }
    out.extend(hidden_elements_section(view));
    if let Some(blocker) = available {
        out.push(
            div()
                .mt(px(20.))
                .text_size(px(11.))
                .line_height(px(14.))
                .text_color(p.text_tertiary)
                .child(rules_footnote(blocker))
                .into_any_element(),
        );
    }
    div().children(out).into_any_element()
}

pub const SHOWN_TITLES: usize = 3;
pub const HIDDEN_ELEMENTS_NOTE: &str =
    "Hidden with View › Hide Element… (⇧⌘H). They stay hidden on every visit, subdomains included.";
pub const NOTHING_HIDDEN: &str = "Nothing hidden in this profile.";

pub fn hidden_by_host(filters: &[String]) -> Vec<(String, Vec<HiddenElement>)> {
    let mut hosts: std::collections::BTreeMap<String, Vec<HiddenElement>> =
        std::collections::BTreeMap::new();
    for element in filters
        .iter()
        .filter_map(|filter| parse_hiding_filter(filter, false))
    {
        hosts.entry(element.host.clone()).or_default().push(element);
    }
    hosts.into_iter().collect()
}

pub fn hidden_host_description(elements: &[HiddenElement]) -> String {
    let titles: Vec<String> = elements
        .iter()
        .take(SHOWN_TITLES)
        .map(|e| hidden_element_title(&e.selector))
        .collect();
    let more = elements.len() - titles.len();
    let plural = if elements.len() == 1 { "" } else { "s" };
    let tail = if more > 0 {
        format!(" and {more} more")
    } else {
        String::new()
    };
    format!(
        "{} element{plural}: {}{tail}",
        elements.len(),
        titles.join(", ")
    )
}

pub fn hidden_profile(view: &SettingsWindowView) -> ProfileId {
    let state = &view.state;
    view.sub
        .hidden_profile
        .clone()
        .filter(|p| state.profile(p.as_str()).is_some())
        .unwrap_or_else(|| ProfileId::new(&state.settings.default_profile_id))
}

fn hidden_elements_section(view: &SettingsWindowView) -> Vec<AnyElement> {
    let p = view.look.p;
    let profile = hidden_profile(view);
    let hosts = view.sub.memo.hidden.get(
        view.host.as_ref(),
        SettingsQuery::HiddenElements(profile.clone()),
        |value| {
            let filters: Vec<String> = value
                .clone()
                .and_then(|value| serde_json::from_value(value).ok())
                .unwrap_or_default();
            Listed::new(
                hidden_by_host(&filters)
                    .into_iter()
                    .map(|(host, elements)| HiddenHost {
                        description: hidden_host_description(&elements),
                        host,
                    })
                    .collect(),
                |row| format!("hidden:{}", row.host),
                |_| DESCRIBED_ROW_ESTIMATE,
            )
        },
    );
    let several = view.state.profile_order.len() > 1;
    if hosts.rows.is_empty() && !several {
        return Vec::new();
    }
    let picker = several.then(|| {
        let label = view
            .state
            .profile(profile.as_str())
            .map(|found| found.name.clone())
            .unwrap_or_default();
        let items = view
            .state
            .profile_order
            .iter()
            .filter_map(|id| view.state.profile(id.as_str()))
            .map(|found| panes::PopupItem {
                value: Some(SharedString::from(found.id.to_string())),
                label: SharedString::from(found.name.clone()),
                checked: found.id == profile,
                msgs: vec![cmd(format!("{COMMAND}hidden:profile:{}", found.id))],
            })
            .collect();
        panes::popup(view, "hiddenElementsProfile", label, 0., false, items)
    });
    let note = if hosts.rows.is_empty() {
        NOTHING_HIDDEN
    } else {
        HIDDEN_ELEMENTS_NOTE
    };
    let mut out = vec![header(
        &p,
        "Hidden elements",
        Some(SharedString::new_static(note)),
        picker,
    )];
    if !hosts.rows.is_empty() {
        out.push(grouped_list(
            &p,
            format!("settings:hidden:{profile}"),
            &view.scroll,
            hosts.items.clone(),
            |ix| {
                let HiddenHost { host, description } = &hosts.rows[ix];
                row(format!("hidden:{host}"), &p)
                    .icon(crate::settings::subpages::site_icon(
                        view,
                        &profile,
                        &format!("https://{host}"),
                        16.,
                    ))
                    .title_line(host.clone())
                    .description(description.clone())
                    .child(tagged(
                        format!("hidden-show:{host}"),
                        button(
                            view,
                            format!("hidden-show:{host}"),
                            "Show Again",
                            cmd(format!("{COMMAND}hidden:restore:{host}")),
                        ),
                    ))
                    .into_any_element()
            },
        ));
    }
    out
}

pub(crate) struct HiddenHost {
    host: String,
    description: String,
}

fn run_hidden(
    view: &mut SettingsWindowView,
    rest: &str,
    cx: &mut Context<SettingsWindowView>,
) -> bool {
    if let Some(id) = rest.strip_prefix("hidden:profile:") {
        view.sub.hidden_profile = Some(ProfileId::new(id));
        return true;
    }
    let Some(host) = rest.strip_prefix("hidden:restore:") else {
        return false;
    };
    let profile = hidden_profile(view);
    let filters: Vec<String> = view
        .host
        .settings_value(&SettingsQuery::HiddenElements(profile.clone()))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let restored: Vec<String> = hidden_by_host(&filters)
        .into_iter()
        .find(|(found, _)| found == host)
        .map(|(_, elements)| elements.into_iter().map(|e| e.filter).collect())
        .unwrap_or_default();
    if restored.is_empty() {
        return true;
    }
    let reply = view
        .host
        .settings_call(SettingsCall::RestoreHiddenElements {
            profile,
            filters: restored,
        });
    cx.spawn(async move |_, _| {
        if let Ok(Err(problem)) = reply.await {
            log::warn!("hidden elements weren't restored: {problem}");
        }
    })
    .detach();
    true
}

fn hex_color(hex: &str) -> Option<Hsla> {
    let value = u32::from_str_radix(hex.trim_start_matches('#'), 16).ok()?;
    Some(gpui::rgb(value).into())
}

pub const ARC_REACH: f32 = 0.75;

pub fn arc_base_stops(angle: f32) -> (f32, f32) {
    let r = angle.to_radians();
    let half = (r.sin().abs() + r.cos().abs()) / 2.0;
    let length = std::f32::consts::FRAC_1_SQRT_2;
    let start = (half - length) / (2.0 * half);
    let end = (half + length * (2.0 * ARC_REACH - 1.0)) / (2.0 * half);
    (start, end)
}

pub fn anonymous_avatar(install_id: &str, size: f32) -> AnyElement {
    let identity = crate::report::identity::anonymous_identity(install_id);
    let colors: Vec<Hsla> = identity
        .colors
        .iter()
        .filter_map(|c| hex_color(c))
        .collect();
    let (Some(first), Some(second), Some(third)) = (colors.first(), colors.get(1), colors.get(2))
    else {
        return div().size(px(size)).into_any_element();
    };
    let angle = identity.angle as f32;
    let (start, end) = arc_base_stops(angle);
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .overflow_hidden()
        .relative()
        .bg(linear_gradient(
            angle,
            linear_color_stop(*first, start),
            linear_color_stop(*second, end),
        ))
        .child(div().absolute().inset_0().bg(linear_gradient(
            angle + 45.0,
            linear_color_stop(third.opacity(0.0), 0.0),
            linear_color_stop(*third, 1.0),
        )))
        .into_any_element()
}

pub fn crash_details_page(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let saved = view
        .host
        .settings_value(&SettingsQuery::SavedInstallId)
        .and_then(|v| {
            v.get("installId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|id| !id.is_empty());
    let identity = match &saved {
        None => row("identity", &p)
            .title_line(data::NO_ID)
            .description(data::NO_ID_DETAIL)
            .into_any_element(),
        Some(id) => {
            let name = crate::report::identity::anonymous_identity(id).name;
            row("identity", &p)
                .icon(anonymous_avatar(id, AVATAR_SIZE))
                .title_line(data::appear_as(&name))
                .description(data::id_detail(id))
                .child(tagged(
                    "identity-reset".into(),
                    button(
                        view,
                        "identity-reset".into(),
                        data::RESET_ID,
                        cmd(format!("{COMMAND}crash:resetSheet")),
                    ),
                ))
                .into_any_element()
        }
    };
    let mut out: Vec<AnyElement> = vec![
        div()
            .child(header(
                &p,
                "Your anonymous ID",
                Some(SharedString::new_static(data::DAILY_COUNT_SHORT)),
                None,
            ))
            .into_any_element(),
        group(&p, [identity]).into_any_element(),
        header(
            &p,
            data::KEPT_ON_THIS_MAC,
            Some(SharedString::new_static(data::LOCAL_SUMMARY)),
            None,
        ),
        group(
            &p,
            [row("view-data", &p)
                .title_line(data::VIEW_DATA)
                .description(
                    view.sub
                        .data_status
                        .clone()
                        .unwrap_or_else(|| data::VIEW_DATA_DETAIL.to_owned()),
                )
                .child(tagged(
                    "view-data".into(),
                    button(
                        view,
                        "view-data-button".into(),
                        data::VIEW_DATA,
                        cmd(format!("{COMMAND}crash:viewData")),
                    )
                    .disabled(view.sub.data_busy),
                ))
                .into_any_element()],
        )
        .into_any_element(),
        header(
            &p,
            "What's Sent",
            Some(SharedString::from(data::whats_sent_intro())),
            None,
        ),
    ];
    let sent = view.sub.memo.whats_sent.get((), |_| whats_sent_pieces());
    out.push(
        virtual_list("settings:whatsSent", &view.scroll)
            .items(sent.items.clone())
            .render(|ix, _| match sent.rows[ix] {
                SentPiece::Title(title) => wrapped(
                    div().mt(px(14.)).child(
                        div()
                            .mb(px(6.))
                            .px(px(2.))
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(p.text_secondary)
                            .child(title),
                    ),
                ),
                SentPiece::Item {
                    title,
                    index,
                    text,
                    first,
                    last,
                } => group_piece(
                    &p,
                    first,
                    last,
                    row(format!("sent:{title}:{index}"), &p)
                        .title_element(
                            div()
                                .text_size(px(12.))
                                .line_height(px(17.))
                                .child(SharedString::new_static(text.as_str())),
                        )
                        .into_any_element(),
                ),
            }),
    );
    out.push(
        div()
            .mt(px(14.))
            .text_size(px(11.))
            .line_height(px(14.))
            .text_color(p.text_tertiary)
            .child(data::SHARING_FOOTNOTE)
            .into_any_element(),
    );
    div().children(out).into_any_element()
}

#[derive(Clone, Copy)]
pub(crate) enum SentPiece {
    Title(&'static str),
    Item {
        title: &'static str,
        index: usize,
        text: &'static String,
        first: bool,
        last: bool,
    },
}

const SENT_TITLE_ESTIMATE: f32 = 35.0;

fn whats_sent_pieces() -> Listed<SentPiece> {
    let mut rows = Vec::new();
    let mut items = Vec::new();
    for (title, texts) in data::whats_sent_groups() {
        rows.push(SentPiece::Title(title));
        items.push(VirtualItem::header(
            format!("sent-title:{title}"),
            SENT_TITLE_ESTIMATE,
        ));
        for (index, text) in texts.iter().enumerate() {
            rows.push(SentPiece::Item {
                title,
                index,
                text,
                first: index == 0,
                last: index + 1 == texts.len(),
            });
            items.push(VirtualItem::new(
                format!("sent:{title}:{index}"),
                ROW_ESTIMATE,
            ));
        }
    }
    Listed { rows, items }
}

pub fn reset_sheet(view: &SettingsWindowView, done: Option<String>) -> AnyElement {
    use crate::primitives::sheets::{Dialog, dialog_actions, dialog_title};
    use crate::primitives::tokens::SheetSize;
    let p = view.look.p;
    let close = view.emit.clone();
    let subtitle = match &done {
        Some(name) => data::reset_done(name),
        None => data::RESET_BODY.to_owned(),
    };
    let buttons = match done {
        Some(_) => vec![
            button(
                view,
                "reset-done".into(),
                "Done",
                cmd(format!("{COMMAND}sheetClose")),
            )
            .kind(ButtonKind::Primary)
            .into_any_element(),
        ],
        None => vec![
            button(
                view,
                "reset-cancel".into(),
                "Cancel",
                cmd(format!("{COMMAND}sheetClose")),
            )
            .into_any_element(),
            tagged(
                "reset-confirm".into(),
                button(
                    view,
                    "reset-confirm".into(),
                    "Reset",
                    cmd(format!("{COMMAND}crash:reset")),
                )
                .kind(ButtonKind::Destructive),
            ),
        ],
    };
    Dialog::sheet("reset-id-sheet", SheetSize::S, &p)
        .on_dismiss(move |window, cx| close.send(cmd(format!("{COMMAND}sheetClose")), window, cx))
        .child(dialog_title(
            data::RESET_TITLE,
            Some(SharedString::from(subtitle)),
            None,
            &p,
        ))
        .child(dialog_actions(None, None, buttons, &p))
        .into_any_element()
}

pub fn prepare_list_input(
    view: &mut SettingsWindowView,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let style = text_field_style(&view.look);
    let input: Entity<TextInput> = view
        .sub
        .list_input
        .get_or_insert_with(|| cx.new(|cx| TextInput::new("https://example.com/filters.txt", cx)))
        .clone();
    input.update(cx, |input, cx| {
        input.set_style(style, cx);
        input.set_text("", false, cx);
    });
    view.sub.list_typed.clear();
    view.sub.list_tried = false;
    view.sub.list_note = None;
    view.sub.list_watch = Some(cx.subscribe_in(
        &input,
        window,
        |view, input, event: &InputEvent, window, cx| match event {
            InputEvent::Submit(_) => {
                run(view, "blocker:addList", window, cx);
                cx.notify();
            }
            InputEvent::Changed { .. } => {
                view.sub.list_typed = input.read(cx).text().to_owned();
                view.sub.list_tried = false;
                view.sub.list_note = None;
                cx.notify();
            }
            _ => {}
        },
    ));
}

pub fn run(
    view: &mut SettingsWindowView,
    rest: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) -> bool {
    if run_hidden(view, rest, cx) {
        return true;
    }
    let blocker = view.host.content_blocker();
    let available = blocker_available(blocker.as_ref()).cloned();
    if let Some(rest) = rest.strip_prefix("blocker:category:") {
        let (Some((category, on)), Some(blocker)) = (rest.rsplit_once(':'), available) else {
            return true;
        };
        let on = on == "true";
        let commands = blocking_category_commands(&blocker, category, on);
        if !on && category == "ads" {
            let Some(main) = view.state.main_window_for(None).cloned() else {
                return true;
            };
            let answer = view.host.confirm_in_window(
                main,
                crate::host::Confirmation {
                    title: "Turn Off Ad Blocker?".to_owned(),
                    message: "Ardia's Ad Blocker hides ads so pages load faster and feel cleaner."
                        .to_owned(),
                    confirm: "Turn Off".to_owned(),
                    destructive: false,
                },
            );
            let host = view.host.clone();
            cx.spawn(async move |_, _| {
                if answer.await.unwrap_or(false) {
                    for command in commands {
                        host.content_blocker_command(command);
                    }
                }
                host.content_blocker_command(ContentBlockerCommand::Refresh);
            })
            .detach();
        } else {
            for command in commands {
                view.host.content_blocker_command(command);
            }
        }
        return true;
    }
    if let Some(rest) = rest.strip_prefix("blocker:list:") {
        if let (Some((on, id)), Some(blocker)) = (rest.split_once(':'), available) {
            for command in list_commands(&blocker, id, on == "true") {
                view.host.content_blocker_command(command);
            }
        }
        return true;
    }
    if let Some(id) = rest.strip_prefix("blocker:removeList:") {
        view.host
            .content_blocker_command(ContentBlockerCommand::RemoveList(id.to_owned()));
        return true;
    }
    if let Some(key) = rest.strip_prefix("approval:revoke:") {
        let reply = view
            .host
            .settings_call(SettingsCall::RevokeApproval(key.to_owned()));
        cx.spawn(async move |this, cx| {
            let _ = reply.await;
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
        return true;
    }
    if let Some(host) = rest.strip_prefix("blocker:blockAgain:") {
        view.host
            .content_blocker_command(ContentBlockerCommand::SetAllowed {
                host: host.to_owned(),
                allowed: false,
            });
        return true;
    }
    match rest {
        "blocker:retry" => view
            .host
            .content_blocker_command(ContentBlockerCommand::Refresh),
        "blocker:addList" => {
            let Some(blocker) = available else {
                return true;
            };
            let typed = view.sub.list_typed.clone();
            match filter_list_address(&typed) {
                None => {
                    view.sub.list_tried = true;
                    view.sub.list_note =
                        Some(("That doesn't look like a web address.".to_owned(), true));
                }
                Some(address) => {
                    let existing = blocker.lists.iter().find(|l| l.id == address).cloned();
                    view.host
                        .content_blocker_command(ContentBlockerCommand::AddList(address));
                    if !blocker.enabled {
                        view.host
                            .content_blocker_command(ContentBlockerCommand::SetEnabled(true));
                    }
                    view.sub.list_note = existing.map(|list| {
                        let title = filter_list_label(&list.id, &list.title);
                        if list.category == "custom" || list.enabled {
                            (format!("{title} is already on."), false)
                        } else {
                            (
                                format!("That's {title}, one of the lists below. It's on now."),
                                false,
                            )
                        }
                    });
                    if let Some(input) = view.sub.list_input.clone() {
                        input.update(cx, |input, cx| input.set_text("", false, cx));
                    }
                    view.sub.list_typed.clear();
                }
            }
        }
        "crash:resetSheet" => {
            view.sub.sheet = Some(crate::settings::subpages::Sheet::ResetId { done: None });
        }
        "crash:reset" => {
            let reply = view.host.settings_call(SettingsCall::ResetAnonymousId);
            cx.spawn(async move |this, cx| {
                let id = reply.await.ok().and_then(Result::ok).and_then(|v| {
                    v.get("installId")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
                let _ = this.update(cx, |view, cx| {
                    if let Some(id) = id {
                        let name = crate::report::identity::anonymous_identity(&id).name;
                        view.sub.sheet =
                            Some(crate::settings::subpages::Sheet::ResetId { done: Some(name) });
                    }
                    cx.notify();
                });
            })
            .detach();
        }
        "crash:viewData" => {
            view.sub.data_busy = true;
            let reply = view.host.settings_call(SettingsCall::ViewMyData);
            cx.spawn(async move |this, cx| {
                let result = reply.await.ok().and_then(Result::ok);
                let _ = this.update(cx, |view, cx| {
                    view.sub.data_busy = false;
                    view.sub.data_status = Some(match result {
                        Some(reply) => data::exported_lines(
                            reply.get("lines").and_then(Value::as_u64).unwrap_or(0),
                        ),
                        None => data::EXPORT_FAILED.to_owned(),
                    });
                    cx.notify();
                });
            })
            .detach();
        }
        _ => return false,
    }
    let _ = window;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(id: &str, category: &str, enabled: bool, default_on: bool) -> BlockerList {
        BlockerList {
            id: id.into(),
            title: id.into(),
            category: category.into(),
            enabled,
            default_on,
            filters: 10,
            failed: false,
        }
    }

    #[test]
    fn turning_a_category_on_picks_its_usual_lists_like_the_old_toggle() {
        let blocker = ContentBlockerView {
            enabled: false,
            lists: vec![
                list("easylist", "ads", false, true),
                list("adguard", "ads", false, false),
                list("easyprivacy", "trackers", false, true),
            ],
            ..ContentBlockerView::default()
        };
        assert_eq!(
            blocking_category_commands(&blocker, "ads", true),
            vec![
                ContentBlockerCommand::SetListEnabled {
                    id: "easylist".into(),
                    enabled: true
                },
                ContentBlockerCommand::SetEnabled(true),
            ]
        );
        let on = ContentBlockerView {
            enabled: true,
            lists: vec![list("easylist", "ads", true, true)],
            ..ContentBlockerView::default()
        };
        assert!(category_on(&on, "ads"));
        assert_eq!(
            blocking_category_commands(&on, "ads", false),
            vec![
                ContentBlockerCommand::SetListEnabled {
                    id: "easylist".into(),
                    enabled: false
                },
                ContentBlockerCommand::SetEnabled(false),
            ]
        );
    }

    #[test]
    fn avatar_base_stops_follow_the_arc_layer() {
        let (start, end) = arc_base_stops(135.0);
        assert!(start.abs() < 1e-4);
        assert!((end - 0.75).abs() < 1e-4);
        let (start, end) = arc_base_stops(90.0);
        assert!((start - (0.5 - std::f32::consts::FRAC_1_SQRT_2) / 1.0).abs() < 1e-4);
        assert!(end > 0.5);
    }

    #[test]
    fn list_addresses_and_labels_read_like_the_old_sheet() {
        assert_eq!(
            filter_list_address("example.com/filters.txt").as_deref(),
            Some("https://example.com/filters.txt")
        );
        assert_eq!(filter_list_address("ftp://x.com/a"), None);
        assert_eq!(filter_list_address("not a url"), None);
        assert_eq!(filter_list_address("intranet"), None);
        assert_eq!(
            filter_list_label("https://lists.dev/a.txt", "https://lists.dev/a.txt"),
            "lists.dev/a.txt"
        );
        assert_eq!(filters_text(12345), "12,345 filters");
        assert_eq!(filters_text(1), "1 filter");
        assert_eq!(category_of_row("general.blockTrackers"), Some("trackers"));
    }
}
