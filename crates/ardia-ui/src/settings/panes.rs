use std::collections::HashMap;
use std::rc::Rc;
use std::sync::OnceLock;

use crate::scale::px;
use ardia_state::commands::COMMANDS;
use ardia_state::model::TabLayout;
use ardia_state::settings::{Settings, SettingsPatch};
use ardia_state::shortcuts::Platform;
use ardia_state::{Action, NewTab, ProfileId};
use ardia_theme::ProfileTheme;
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, ParentElement, SharedString, Styled, div,
    prelude::*, rgb,
};
use serde_json::Value;

use crate::look::Palette;
use crate::msg::Msg;
use crate::primitives::controls::{
    ButtonKind, Checkbox, IconButton, MenuRow, PushButton, Segmented, Slider, Toggle, popover,
};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::pop_up_menu::{self, PopUpChoice};
use crate::settings::SettingsWindowView;
use crate::settings::memo::{Listed, Memos, Same, SameArc, group_piece, wrapped};
use crate::primitives::virtual_list::{VirtualItem, virtual_list};
use crate::settings::rows::{self, Act, Control, Custom, Pane, Row, rows_for};

pub const ROW_MIN_HEIGHT: f32 = 34.0;
pub const ROW_PAD_X: f32 = 12.0;
pub const ROW_PAD_Y: f32 = 6.0;
pub const GROUP_RADIUS: f32 = 12.0;
pub const SECTION_TOP: f32 = 20.0;
pub const COLUMN_MAX_WIDTH: f32 = 600.0;
pub const COLUMN_PAD_X: f32 = 24.0;
pub const PANE_BOTTOM: f32 = 40.0;
pub const PICTURE_LARGE: f32 = 104.0;
pub const PICTURE_MEDIUM: f32 = 84.0;
pub const PICTURE_PRESS_SCALE: f32 = 0.985;
pub const PILL_HEIGHT: f32 = 28.0;
pub const POPUP_HEIGHT: f32 = 22.0;
pub const TAB_CORNERS_DEFAULT: f64 = 10.0;
const MENU_COMMAND: &str = "settings:menu:";

pub fn bool_value(settings: &Settings, key: &str) -> bool {
    settings.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

pub fn text_value(settings: &Settings, key: &str) -> String {
    settings
        .get(key)
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

pub fn number_value(settings: &Settings, key: &str) -> f64 {
    settings.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

pub fn set(key: &'static str, value: impl Into<Value>) -> Msg {
    patch(SettingsPatch::new().set(key, value.into()))
}

pub fn note_settings_picks(patch: &SettingsPatch) {
    let text = |key: &str| patch.get(key).and_then(Value::as_str);
    let field = |key: &str| -> Option<&'static str> {
        Some(match key {
            "addressBar" => match text(key)? {
                "sidebar" => "address_bar_picks_sidebar",
                "toolbar" => "address_bar_picks_toolbar",
                _ => return None,
            },
            "hideToolbarWhileScrolling" => match patch.get(key)?.as_bool()? {
                true => "scroll_toolbar_picks_hide",
                false => "scroll_toolbar_picks_keep",
            },
            "commandBarPlacement" => match text(key)? {
                "field" => "command_bar_picks_field",
                _ => "command_bar_picks_centred",
            },
            "afterClosingTab" => match text(key)? {
                "tabAbove" => "after_closing_tab_picks_above",
                "tabBelow" => "after_closing_tab_picks_below",
                "previouslyActive" => "after_closing_tab_picks_recent",
                _ => return None,
            },
            "tabSwitcherOrder" => match text(key)? {
                "recent" => "tab_switcher_order_picks_recent",
                _ => "tab_switcher_order_picks_in_order",
            },
            "tabSwitcherView" => match text(key)? {
                "thumbnails" => "tab_switcher_view_picks_thumbnails",
                "compactList" => "tab_switcher_view_picks_compact_list",
                "none" => "tab_switcher_view_picks_none",
                _ => return None,
            },
            _ => return None,
        })
    };
    for key in patch.keys() {
        if let Some(field) = field(key) {
            ardia_telemetry::counts::count(field);
        }
    }
}

pub fn patch(patch: SettingsPatch) -> Msg {
    Msg::Store(Action::UpdateSettings {
        patch,
        from_sync: false,
    })
}

pub fn snap(value: f64, min: f64, max: f64, step: f64) -> f64 {
    let stepped = if step > 0.0 {
        ((value - min) / step).round() * step + min
    } else {
        value
    };
    (stepped.clamp(min, max) * 1000.0).round() / 1000.0
}

pub fn menu_command(id: &str) -> SharedString {
    SharedString::from(format!("{MENU_COMMAND}{id}"))
}

pub fn menu_of(command: &str) -> Option<&str> {
    command.strip_prefix(MENU_COMMAND)
}

fn search_flash(p: &Palette) -> Hsla {
    if p.dark {
        gpui::hsla(211.0 / 360.0, 1.0, 0.52, 0.22)
    } else {
        gpui::hsla(211.0 / 360.0, 1.0, 0.5, 0.16)
    }
}

pub fn window_fill(dark: bool) -> Hsla {
    if dark {
        rgb(0x1E1E1E).into()
    } else {
        rgb(0xF2F2F2).into()
    }
}

pub fn sidebar_divider(dark: bool) -> Hsla {
    if dark {
        gpui::hsla(0.0, 0.0, 0.0, 0.6)
    } else {
        gpui::hsla(0.0, 0.0, 0.0, 0.1)
    }
}

pub fn selected_profile(view: &SettingsWindowView) -> Option<ProfileId> {
    let state = &view.state;
    view.profile
        .clone()
        .filter(|p| state.profile(p.as_str()).is_some())
        .or_else(|| {
            state
                .main_window_for(None)
                .and_then(|w| state.window(w.as_str()))
                .map(|w| {
                    if w.profile_id.is_incognito() {
                        w.profile_id.incognito_original()
                    } else {
                        w.profile_id.clone()
                    }
                })
        })
        .or_else(|| Some(state.last_active_profile()))
        .filter(|p| state.profile(p.as_str()).is_some())
}

pub fn flag_key(flag: crate::host::ProfileFlagKind) -> &'static str {
    match flag {
        crate::host::ProfileFlagKind::PasswordsOffered => "passwordsOffered",
        crate::host::ProfileFlagKind::AddressesAutofilled => "addressesAutofilled",
        crate::host::ProfileFlagKind::CardsAutofilled => "cardsAutofilled",
        crate::host::ProfileFlagKind::PreloadPages => "preloadPages",
    }
}

pub fn default_profile(view: &SettingsWindowView) -> ProfileId {
    let id = &view.state.settings.default_profile_id;
    if view.state.profile(id).is_some() {
        ProfileId::from(id.clone())
    } else {
        view.state.last_active_profile()
    }
}

pub fn home_relative(path: &str, home: Option<&str>) -> String {
    match home.filter(|home| !home.is_empty()) {
        Some(home) if path == home => "~".to_owned(),
        Some(home) => match path.strip_prefix(home).filter(|rest| rest.starts_with('/')) {
            Some(rest) => format!("~{rest}"),
            None => path.to_owned(),
        },
        None => path.to_owned(),
    }
}

pub fn downloads_line(current: &crate::host::DownloadSettings) -> String {
    let home = std::env::var("HOME").ok();
    let folder = home_relative(&current.folder, home.as_deref());
    if current.managed {
        format!("{folder}, set by your organization.")
    } else {
        folder
    }
}

fn top_tabs(settings: &Settings) -> bool {
    settings.tab_layout == TabLayout::Top
}

pub fn sleeping_look(settings: &Settings) -> &'static str {
    match (settings.fade_unloaded_tabs, settings.strike_sleeping_tabs) {
        (true, true) => "both",
        (true, false) => "fade",
        (false, true) => "strike",
        (false, false) => "normal",
    }
}

pub fn full_screen_frame(settings: &Settings) -> &'static str {
    if settings.page_frame_zero_in_full_screen {
        "remove"
    } else if settings.page_frame_zero_when_tabs_hidden {
        "tabsHidden"
    } else {
        "keep"
    }
}

pub fn full_screen_patch(choice: &str) -> SettingsPatch {
    let (in_full_screen, when_tabs_hidden) = match choice {
        "remove" => (true, true),
        "tabsHidden" => (false, true),
        _ => (false, false),
    };
    SettingsPatch::new()
        .set("pageFrameZeroInFullScreen", in_full_screen)
        .set("pageFrameZeroWhenTabsHidden", when_tabs_hidden)
}

pub fn memory_saver_level(settings: &Settings) -> &'static str {
    use ardia_state::settings::{MemorySaverMode, UnloadProfilesAfter};
    if !settings.memory_saver {
        return "off";
    }
    let unload = if settings.memory_saver_mode == MemorySaverMode::Maximum {
        UnloadProfilesAfter::FifteenMinutes
    } else {
        UnloadProfilesAfter::Never
    };
    if !settings.load_profiles_when_opened || settings.unload_profiles_after != unload {
        return "custom";
    }
    match settings.memory_saver_mode {
        MemorySaverMode::Moderate => "moderate",
        MemorySaverMode::Balanced => "balanced",
        MemorySaverMode::Maximum => "maximum",
    }
}

pub fn memory_saver_patch(level: &str) -> Option<SettingsPatch> {
    let unload = match level {
        "off" => return Some(SettingsPatch::new().set("memorySaver", false)),
        "moderate" | "balanced" => "never",
        "maximum" => "15m",
        _ => return None,
    };
    Some(
        SettingsPatch::new()
            .set("memorySaver", true)
            .set("memorySaverMode", level)
            .set("loadProfilesWhenOpened", true)
            .set("unloadProfilesAfter", unload),
    )
}

fn memory_saver_custom_description(settings: &Settings) -> String {
    use ardia_state::settings::{MemorySaverMode, UnloadProfilesAfter};
    let tabs = match settings.memory_saver_mode {
        MemorySaverMode::Moderate => "Sleeps tabs slowly",
        MemorySaverMode::Balanced => "Sleeps idle tabs automatically",
        MemorySaverMode::Maximum => "Sleeps tabs aggressively",
    };
    let load = if settings.load_profiles_when_opened {
        " Profiles load on open."
    } else {
        " Every profile loads at launch."
    };
    let unload = match settings.unload_profiles_after {
        UnloadProfilesAfter::Never => "",
        UnloadProfilesAfter::FiveMinutes => " Idle profiles unload after 5 minutes.",
        UnloadProfilesAfter::FifteenMinutes => " Idle profiles unload after 15 minutes.",
        UnloadProfilesAfter::OneHour => " Idle profiles unload after an hour.",
        UnloadProfilesAfter::TwoHours => " Idle profiles unload after 2 hours.",
    };
    format!("{tabs}.{load}{unload}")
}

pub fn clean_up_value(settings: &Settings) -> String {
    match settings.clean_up_inactive_tabs_after_minutes {
        None => "never".to_owned(),
        Some(minutes) => format!("{}", minutes.round() as i64),
    }
}

fn duration_title(minutes: i64) -> String {
    let (amount, unit) = if minutes % (24 * 60) == 0 {
        (minutes / (24 * 60), "days")
    } else if minutes % 60 == 0 {
        (minutes / 60, "hours")
    } else {
        (minutes, "minutes")
    };
    let unit = if amount == 1 {
        &unit[..unit.len() - 1]
    } else {
        unit
    };
    format!("{amount} {unit}")
}

pub const MAX_DURATION_MINUTES: i64 = 365 * 1440;
pub const DURATION_UNITS: [(&str, &str, i64); 3] = [
    ("minutes", "Minutes", 1),
    ("hours", "Hours", 60),
    ("days", "Days", 1440),
];

pub fn duration_parts(minutes: i64) -> (i64, &'static str) {
    if minutes % 1440 == 0 {
        (minutes / 1440, "days")
    } else if minutes % 60 == 0 {
        (minutes / 60, "hours")
    } else {
        (minutes, "minutes")
    }
}

pub fn duration_minutes(amount: &str, unit: &str) -> Option<i64> {
    let text = amount.trim();
    let mut parts = text.splitn(2, '.');
    let whole = parts.next()?;
    let fraction = parts.next();
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    if !digits(whole) || fraction.is_some_and(|f| !digits(f)) {
        return None;
    }
    let per = DURATION_UNITS.iter().find(|(key, _, _)| *key == unit)?.2;
    let value: f64 = text.parse().ok()?;
    let minutes = (value * per as f64).round();
    (minutes >= 1.0 && minutes <= MAX_DURATION_MINUTES as f64).then_some(minutes as i64)
}

pub fn clean_up_choices(settings: &Settings) -> Vec<(String, String)> {
    let mut choices: Vec<(String, String)> = rows::CLEAN_UP
        .iter()
        .map(|(value, title)| ((*value).to_owned(), (*title).to_owned()))
        .collect();
    let current = clean_up_value(settings);
    if !choices.iter().any(|(value, _)| *value == current) {
        let minutes = current.parse::<i64>().unwrap_or(0).max(1);
        let at = choices
            .iter()
            .skip(1)
            .position(|(value, _)| value.parse::<i64>().unwrap_or(0) > minutes)
            .map_or(choices.len(), |index| index + 1);
        choices.insert(at, (current, duration_title(minutes)));
    }
    let custom_at = choices
        .iter()
        .position(|(value, _)| value == "720")
        .map_or(choices.len(), |index| index + 1);
    choices.insert(
        custom_at,
        (CUSTOM_CLEAN_UP.to_owned(), "Custom…".to_owned()),
    );
    choices
}

pub const CUSTOM_CLEAN_UP: &str = "custom";

pub fn ctrl_tab_summary(settings: &Settings) -> String {
    use ardia_state::settings::{TabSwitcherOrder, TabSwitcherView};
    let order = match settings.tab_switcher_order {
        TabSwitcherOrder::Recent => "Goes to your recent tabs",
        TabSwitcherOrder::InOrder => "Steps through your tabs in order",
    };
    let view = match settings.tab_switcher_view {
        TabSwitcherView::Thumbnails => ", with page previews.",
        TabSwitcherView::CompactList => ", with a compact list.",
        TabSwitcherView::None => ".",
    };
    format!("{order}{view}")
}

pub fn description(view: &SettingsWindowView, row: &Row) -> Option<SharedString> {
    let settings = &view.state.settings;
    let dynamic: Option<String> = match row.id {
        "profiles.passwordManager" => {
            let profile = selected_profile(view).unwrap_or_else(|| default_profile(view));
            return crate::settings::extras::password_manager_description(view, &profile)
                .map(SharedString::from);
        }
        "profiles.offerToSavePasswords" => {
            let profile = selected_profile(view).unwrap_or_else(|| default_profile(view));
            crate::settings::extras::handed_over(view, &profile)
        }
        "tabs.openLinksInLittleArdia" => Some(if settings.open_links_in_little_ardia {
            "A link from Discord, Slack or Mail opens in Little Ardia, a small window of its own. ⌘O moves it into Ardia; closing it throws it away.".to_owned()
        } else {
            "A link from Discord, Slack or Mail opens as a new tab in the Ardia window you used last.".to_owned()
        }),
        "tabs.autoHideTabs" => {
            let platform = Platform::current();
            let keys = view
                .state
                .shortcut_map(platform)
                .primary("toggleSidebar")
                .map(|shortcut| format!(" {} toggles.", shortcut.format(platform)))
                .unwrap_or_default();
            Some(format!(
                "Tabs slide away until you point at the {}.{keys}",
                if top_tabs(settings) { "top edge" } else { "edge" }
            ))
        }
        "tabs.buttons" if top_tabs(settings) => Some("Hide Tabs in the toolbar.".to_owned()),
        "tabs.newTabOpens" if settings.minimalism_mode => Some(
            "Minimalism mode opens the command bar. Your choice here comes back when you turn it off."
                .to_owned(),
        ),
        "advanced.memorySaver" => {
            let level = memory_saver_level(settings);
            Some(match rows::MEMORY_SAVER.iter().find(|(value, _, _)| *value == level) {
                Some((_, _, text)) => (*text).to_owned(),
                None => memory_saver_custom_description(settings),
            })
        }
        "advanced.batterySaver" => {
            let current = text_value(settings, "batterySaverWhen");
            rows::BATTERY_SAVER
                .iter()
                .find(|(value, _, _)| *value == current)
                .map(|(_, _, text)| (*text).to_owned())
        }
        "shortcuts.ctrlTab" => Some(ctrl_tab_summary(settings)),
        "shortcuts.peekModifier" if text_value(settings, "splitLinkModifier") == "alt" => Some(format!(
            "{} ⌥-click opens a split now: choosing it here moves split view back to ⌥⇧-click.",
            row.description
        )),
        "shortcuts.splitLinkModifier" if text_value(settings, "peekModifier") == "alt" => Some(format!(
            "{} ⌥-click peeks now: choosing it here moves Peek back to ⇧-click.",
            row.description
        )),
        "general.downloadsFolder" => view
            .host
            .download_settings(&default_profile(view))
            .map(|current| downloads_line(&current)),
        "profiles.profileDownloadsFolder" => selected_profile(view)
            .and_then(|profile| view.host.download_settings(&profile))
            .map(|current| downloads_line(&current)),
        "profiles.exportBookmarks" => view.sub.bookmarks_status.clone(),
        "advanced.allowedPrograms" => Some(crate::settings::general_subpages::allowed_programs_description(view)),
        "profiles.extensions" => selected_profile(view)
            .and_then(|profile| {
                crate::settings::subpages::installed_extensions(view, &profile)
                    .as_ref()
                    .as_ref()
                    .map(|list| list.rows.is_empty())
            })
            .filter(|empty| *empty)
            .map(|_| {
                "Extensions you add appear here and in the Extensions menu. Each profile has its own."
                    .to_owned()
            }),
        "general.shareDiagnostics" => Some(
            "Crashes and anonymous usage stats. Never sites, searches, or tabs.".to_owned(),
        ),
        "advanced.programs" => Some(programs_description(view)),
        "general.engineMode" => Some(crate::settings::engines::mode_footer(view)),
        "general.openAtLogin" if view.login.is_some_and(|login| login.needs_approval) => Some(
            "Allow it in System Settings › General › Login Items.".to_owned(),
        ),
        "profiles.icon"
        | "profiles.syncThisProfile"
        | "profiles.clearBrowsingData"
        | "profiles.deleteProfile"
        | "profiles.shareTopApps" => crate::settings::profiles::description(view, row.id),
        _ => None,
    };
    match dynamic {
        Some(text) => Some(SharedString::from(text)),
        None if row.explained => Some(SharedString::new_static(row.description)),
        None => None,
    }
}

pub fn title_of(view: &SettingsWindowView, row: &Row) -> SharedString {
    match row.id {
        "general.version" => crate::settings::updates::version_title(view),
        _ => SharedString::new_static(row.title),
    }
}

fn version_details(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let chromium = view
        .host
        .about()
        .and_then(|about| about.chromium_version)
        .unwrap_or_else(|| "…".to_owned());
    let version = view
        .host
        .about()
        .map(|about| about.app_version)
        .unwrap_or_default();
    let link = |id: &'static str, label: &'static str, msg: Msg| {
        div()
            .id(id)
            .debug_selector(move || id.into())
            .text_size(px(11.))
            .text_color(p.form_accent)
            .cursor_pointer()
            .on_click(view.emit.click(msg))
            .child(label)
    };
    div()
        .flex()
        .flex_col()
        .children(crate::settings::updates::status_element(view))
        .child(
            div()
                .mt(px(2.))
                .text_size(px(11.))
                .text_color(p.text_secondary)
                .child(format!("Chromium {chromium}")),
        )
        .child(
            div()
                .mt(px(4.))
                .flex()
                .gap(px(10.))
                .child(link(
                    "version-source",
                    "Source code",
                    open_page_owned(
                        view,
                        format!("https://github.com/ardia-browser/ardia/tree/v{version}"),
                    ),
                ))
                .child(link(
                    "version-licenses",
                    "Licenses",
                    open_page(view, "chrome://credits"),
                )),
        )
        .into_any_element()
}

fn row_shell(
    view: &SettingsWindowView,
    row: &'static Row,
    control: Option<AnyElement>,
    below: Option<AnyElement>,
    link: Option<Msg>,
) -> AnyElement {
    let p = view.look.p;
    let flashing = view.flashing(row.id);
    let hover = p.row_hover;
    div()
        .id(SharedString::from(format!("setting:{}", row.id)))
        .debug_selector(move || format!("setting:{}", row.id))
        .min_h(px(ROW_MIN_HEIGHT))
        .px(px(ROW_PAD_X))
        .py(px(ROW_PAD_Y))
        .flex()
        .items_center()
        .gap(px(12.))
        .when(flashing, |this| this.bg(search_flash(&p).opacity(view.flash_glow(row.id))))
        .when_some(link, |this, msg| {
            this.cursor_pointer()
                .hover(move |style| style.bg(hover))
                .on_click(view.emit.click(msg))
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(16.))
                        .child(title_of(view, row)),
                )
                .when_some(description(view, row), |this, text| {
                    this.child(
                        div()
                            .mt(px(2.))
                            .text_size(px(11.))
                            .line_height(px(14.))
                            .text_color(p.text_secondary)
                            .child(text),
                    )
                })
                .children(below),
        )
        .children(control.map(|control| div().flex_none().child(control)))
        .when(matches!(row.control, Control::Link(_)), |this| {
            this.child(icon(Icon::ChevronRight, 11., p.text_tertiary))
        })
        .into_any_element()
}

fn group(p: &Palette, rows: Vec<AnyElement>) -> AnyElement {
    crate::primitives::list::group(p, rows).into_any_element()
}

fn section_header(
    p: &Palette,
    title: impl Into<SharedString>,
    detail: Option<&'static str>,
) -> AnyElement {
    div()
        .mt(px(SECTION_TOP))
        .mb(px(6.))
        .px(px(6.))
        .flex()
        .flex_col()
        .child(
            div()
                .text_size(px(13.))
                .line_height(px(16.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(title.into()),
        )
        .when_some(detail, |this, detail| {
            this.child(
                div()
                    .mt(px(4.))
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(p.text_secondary)
                    .child(detail),
            )
        })
        .into_any_element()
}

fn form_field(view: &SettingsWindowView, row: &'static Row, body: AnyElement) -> AnyElement {
    let p = view.look.p;
    div()
        .id(SharedString::from(format!("setting:{}", row.id)))
        .debug_selector(move || format!("setting:{}", row.id))
        .rounded(px(GROUP_RADIUS))
        .when(view.flashing(row.id), |this| this.bg(search_flash(&p).opacity(view.flash_glow(row.id))))
        .child(
            div()
                .mt(px(12.))
                .mb(px(4.))
                .text_size(px(11.))
                .text_color(p.text_secondary)
                .child(row.title),
        )
        .child(body)
        .into_any_element()
}

pub struct PopupItem {
    pub value: Option<SharedString>,
    pub label: SharedString,
    pub checked: bool,
    pub msgs: Vec<Msg>,
}

pub fn pop_up_choices(items: &[PopupItem]) -> Vec<PopUpChoice> {
    items
        .iter()
        .map(|item| {
            let choice = PopUpChoice::new(item.label.clone(), item.checked, item.msgs.clone());
            match &item.value {
                Some(value) => choice.value(value.clone()),
                None => choice,
            }
        })
        .collect()
}

pub fn popup(
    view: &SettingsWindowView,
    id: &'static str,
    label: impl Into<SharedString>,
    min_width: f32,
    disabled: bool,
    items: Vec<PopupItem>,
) -> AnyElement {
    let p = view.look.p;
    let open = view.menu.as_deref() == Some(id) && !disabled;
    div()
        .relative()
        .child(
            div().debug_selector(move || format!("popup:{id}")).child(
                crate::primitives::controls::PopUp::new(
                    SharedString::from(format!("popup:{id}")),
                    label,
                    &p,
                )
                .min_width(min_width)
                .native(true)
                .disabled(disabled)
                .on_click(pop_up_menu::opener(
                    &view.host,
                    &view.emit,
                    pop_up_choices(&items),
                    Msg::Command(menu_command(id)),
                )),
            ),
        )
        .when(open, |this| {
            let width = min_width.max(160.);
            this.child(
                gpui::deferred(
                    popover(
                        SharedString::from(format!("popup-menu:{id}")),
                        false,
                        width,
                        &p,
                    )
                    .debug_selector(move || format!("popup-menu:{id}"))
                    .absolute()
                    .top(px(POPUP_HEIGHT + 2.))
                    .right_0()
                    .children(items.into_iter().enumerate().map(|(index, item)| {
                        let emit = view.emit.clone();
                        let msgs = item.msgs;
                        MenuRow::new(
                            SharedString::from(format!("popup-item:{id}:{index}")),
                            item.label,
                            &p,
                        )
                        .checked(item.checked)
                        .on_click(move |_, window, cx| {
                            emit.send(Msg::CloseOverlays, window, cx);
                            for msg in &msgs {
                                emit.send(msg.clone(), window, cx);
                            }
                        })
                    })),
                )
                .with_priority(2),
            )
        })
        .into_any_element()
}

fn choice_popup(
    view: &SettingsWindowView,
    id: &'static str,
    current: &str,
    options: Vec<(String, String)>,
    min_width: f32,
    disabled: bool,
    pick: impl Fn(&str) -> Vec<Msg>,
) -> AnyElement {
    let label = options
        .iter()
        .find(|(value, _)| value == current)
        .map(|(_, label)| label.clone())
        .unwrap_or_default();
    let items = options
        .iter()
        .map(|(value, title)| PopupItem {
            value: Some(SharedString::from(value.clone())),
            label: SharedString::from(title.clone()),
            checked: value == current,
            msgs: pick(value),
        })
        .collect();
    popup(view, id, label, min_width, disabled, items)
}

fn owned(options: rows::Options) -> Vec<(String, String)> {
    options
        .iter()
        .map(|(value, title)| ((*value).to_owned(), (*title).to_owned()))
        .collect()
}

fn setting_popup(
    view: &SettingsWindowView,
    id: &'static str,
    key: &'static str,
    options: rows::Options,
) -> AnyElement {
    let current = text_value(&view.state.settings, key);
    choice_popup(view, id, &current, owned(options), 120., false, |value| {
        vec![set(key, value.to_owned())]
    })
}

fn toggle(
    view: &SettingsWindowView,
    key: &'static str,
    on: bool,
    msg: impl Fn(bool) -> Msg + 'static,
) -> AnyElement {
    toggle_in(view, key, on, false, msg)
}

fn toggle_in(
    view: &SettingsWindowView,
    key: &'static str,
    on: bool,
    disabled: bool,
    msg: impl Fn(bool) -> Msg + 'static,
) -> AnyElement {
    let emit = view.emit.clone();
    div()
        .debug_selector(move || format!("toggle:{key}"))
        .child(
            Toggle::new(
                SharedString::from(format!("toggle:{key}")),
                on,
                &view.look.p,
            )
            .native(true)
            .disabled(disabled)
            .on_toggle(move |value, window, cx| emit.send(msg(value), window, cx)),
        )
        .into_any_element()
}

pub fn toggle_disabled(settings: &Settings, key: &str) -> bool {
    key == "compactCliPill" && !settings.show_cli_pill
}

fn setting_toggle(view: &SettingsWindowView, key: &'static str) -> AnyElement {
    let on = bool_value(&view.state.settings, key);
    let disabled = toggle_disabled(&view.state.settings, key);
    toggle_in(view, key, on, disabled, move |value| set(key, value))
}

fn checklist(
    view: &SettingsWindowView,
    items: Vec<(&'static str, &'static str, bool, Msg)>,
) -> AnyElement {
    let p = view.look.p;
    div()
        .mt(px(8.))
        .flex()
        .flex_col()
        .gap(px(6.))
        .children(items.into_iter().map(|(key, label, on, msg)| {
            let emit = view.emit.clone();
            div().debug_selector(move || format!("check:{key}")).line_height(px(16.)).child(
                Checkbox::new(SharedString::from(format!("check:{key}")), on, label, &p)
                    .on_toggle(move |_, window, cx| emit.send(msg.clone(), window, cx)),
            )
        }))
        .into_any_element()
}

struct Card {
    id: SharedString,
    title: &'static str,
    caption: &'static str,
    selected: bool,
    height: f32,
    picture: AnyElement,
    msg: Msg,
}

fn picture_card(view: &SettingsWindowView, card: Card) -> AnyElement {
    let hover_fill = view.look.p.row_hover;
    let Card {
        id,
        title,
        caption,
        selected,
        height,
        picture,
        msg,
    } = card;
    let p = view.look.p;
    let selector = id.clone();
    let group_name = SharedString::from(format!("picture:{id}"));
    div()
        .id(id)
        .group(group_name.clone())
        .debug_selector(move || selector.to_string())
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(8.))
        .cursor_pointer()
        .on_click(view.emit.click(msg))
        .child(
            div()
                .id("picture")
                .w_full()
                .h(px(height))
                .rounded(px(GROUP_RADIUS))
                .overflow_hidden()
                .flex()
                .border(px(if selected { 2. } else { 1. }))
                .border_color(if selected {
                    p.form_accent
                } else {
                    p.group_stroke
                })
                .when(!selected, |this| {
                    this.group_hover(group_name.clone(), move |style| style.bg(hover_fill))
                })
                .group_active(group_name, |style| style.scale(PICTURE_PRESS_SCALE))
                .child(picture),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(2.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .when(selected, |this| {
                            this.child(icon(Icon::CheckCircleFill, 12., p.form_accent))
                        })
                        .child(
                            div()
                                .text_size(px(12.))
                                .line_height(px(15.))
                                .text_color(if selected { p.text } else { p.text_secondary })
                                .child(title),
                        ),
                )
                .when(!caption.is_empty(), |this| {
                    this.child(
                        div()
                            .text_size(px(11.))
                            .line_height(px(14.))
                            .text_color(p.text_tertiary)
                            .text_center()
                            .child(caption),
                    )
                }),
        )
        .into_any_element()
}

fn card_picture(
    view: &SettingsWindowView,
    id: &str,
    value: &str,
    top: bool,
    right: bool,
) -> AnyElement {
    use crate::settings::mini_window as mw;
    let p = &view.look.p;
    let settings = &view.state.settings;
    match id {
        "tabs.layout" => mw::tab_layout(p, value == "top", right),
        "tabs.hideToolbarWhileScrolling" => mw::scroll_toolbar(p, value == "true"),
        "appearance.theme" => match value {
            "auto" => div()
                .size_full()
                .flex()
                .child(div().flex_1().h_full().child(mw::mode(false, (mw::CARD_INNER_RADIUS, 0.))))
                .child(div().flex_1().h_full().child(mw::mode(true, (0., mw::CARD_INNER_RADIUS))))
                .into_any_element(),
            other => mw::mode(other == "dark", (mw::CARD_INNER_RADIUS, mw::CARD_INNER_RADIUS)),
        },
        "appearance.interfaceStyle" => mw::style(&view.look, value == "glass"),
        "appearance.ctrlTab" => mw::switcher_order(p, value),
        "appearance.tabSwitcherView" => mw::switcher_view(p, value),
        "appearance.afterClosingTab" => mw::after_closing(p, value, top, right),
        "appearance.addressBar" => mw::address_bar(p, value),
        "appearance.commandBarPlacement" => {
            let address = if top {
                "toolbar".to_owned()
            } else {
                text_value(settings, "addressBar")
            };
            mw::command_bar(p, value, &address)
        }
        _ => mw::tab_layout(p, top, right),
    }
}

fn cards(
    view: &SettingsWindowView,
    row: &'static Row,
    labelled: bool,
    current: &str,
    options: rows::Cards,
    pick: impl Fn(&str) -> Msg,
) -> AnyElement {
    let settings = &view.state.settings;
    let height = if matches!(row.id, "appearance.theme" | "appearance.interfaceStyle") {
        PICTURE_MEDIUM
    } else {
        PICTURE_LARGE
    };
    let top = top_tabs(settings);
    let right = text_value(settings, "sidebarSide") == "right";
    let body = div()
        .flex()
        .gap(px(16.))
        .children(options.iter().map(|(value, title, caption)| {
            let picture = card_picture(view, row.id, value, top, right);
            picture_card(
                view,
                Card {
                    id: SharedString::from(format!("card:{}:{value}", row.id)),
                    title,
                    caption,
                    selected: *value == current,
                    height,
                    picture,
                    msg: pick(value),
                },
            )
        }))
        .into_any_element();
    if labelled {
        form_field(view, row, body)
    } else {
        div()
            .id(SharedString::from(format!("setting:{}", row.id)))
            .debug_selector(move || format!("setting:{}", row.id))
            .rounded(px(GROUP_RADIUS))
            .when(view.flashing(row.id), |this| {
                this.bg(search_flash(&view.look.p).opacity(view.flash_glow(row.id)))
            })
            .child(body)
            .into_any_element()
    }
}

fn profile_colour(view: &SettingsWindowView, row: &'static Row) -> AnyElement {
    use crate::settings::theme_section as te;
    let p = view.look.p;
    let Some(profile_id) = selected_profile(view) else {
        return div().into_any_element();
    };
    let Some(profile) = view.state.profile(profile_id.as_str()) else {
        return div().into_any_element();
    };
    let preset = profile.color.preset();
    let target = te::ThemeTarget {
        profile: profile_id.clone(),
        stored: profile.theme.clone(),
        original: ProfileTheme::starting(preset.spec().swatch),
        preset,
        follows_app: view.state.settings.spaces_follow_appearance,
        app_dark: p.dark,
    };
    let detail = target.detail();
    let chosen = Some(preset);
    let edited = target
        .stored
        .as_deref()
        .map(|theme| crate::primitives::theme_bridge::hsla(theme.accent()));
    let swatch_row = div()
        .id(SharedString::from(format!("setting:{}", row.id)))
        .debug_selector(move || format!("setting:{}", row.id))
        .min_h(px(ROW_MIN_HEIGHT))
        .px(px(ROW_PAD_X))
        .py(px(ROW_PAD_Y))
        .flex()
        .items_center()
        .gap(px(12.))
        .when(view.flashing(row.id), |this| this.bg(search_flash(&p).opacity(view.flash_glow(row.id))))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().text_size(px(13.)).line_height(px(16.)).child(row.title))
                .child(
                    div()
                        .mt(px(2.))
                        .text_size(px(11.))
                        .line_height(px(14.))
                        .text_color(p.text_secondary)
                        .child(detail),
                ),
        )
        .child(te::swatches(&view.emit, &profile_id, chosen, edited, view.swatch_hover))
        .into_any_element();
    let editor = div()
        .p(px(12.))
        .child(te::editor(&view.emit, &view.host, target, view.theme_stop, &p))
        .into_any_element();
    div()
        .child(
            div()
                .mt(px(SECTION_TOP))
                .mb(px(6.))
                .px(px(6.))
                .flex()
                .items_end()
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(13.))
                                .line_height(px(16.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Theme"),
                        )
                        .child(
                            div()
                                .mt(px(4.))
                                .text_size(px(12.))
                                .line_height(px(16.))
                                .text_color(p.text_secondary)
                                .child("Tints this profile's windows, New Tab page and highlights."),
                        ),
                )
                .child({
                    let emit = view.emit.clone();
                    let host = view.host.clone();
                    let profile = profile_id.clone();
                    PushButton::new("theme-import-arc", "Import from Arc…", &p).on_click(
                        move |_, window, cx| {
                            te::import_from_arc(emit.clone(), host.clone(), profile.clone(), window, cx)
                        },
                    )
                }),
        )
        .child(group(&p, vec![swatch_row, editor]))
        .into_any_element()
}

pub fn reordered(order: &[ProfileId], moving: &str, before: &str) -> Option<Vec<ProfileId>> {
    let from = order.iter().position(|id| id.as_str() == moving)?;
    let to = order.iter().position(|id| id.as_str() == before)?;
    if from == to {
        return None;
    }
    let mut next = order.to_vec();
    let item = next.remove(from);
    next.insert(to, item);
    Some(next)
}

fn profile_bar(view: &SettingsWindowView) -> AnyElement {
    crate::settings::profiles::profile_bar(view)
}

fn plural(count: usize, word: &str) -> String {
    if count == 1 {
        format!("1 {word}")
    } else {
        format!("{count} {word}s")
    }
}

pub fn profile_stats(state: &ardia_state::BrowserState, profile: &ProfileId) -> String {
    let history = match state.history_of(profile) {
        Some(history) => format!("{} in history", plural(history.len(), "page")),
        None => "History not loaded yet".to_owned(),
    };
    let bookmarks = state
        .bookmarks_of(profile)
        .map(bookmark_count)
        .unwrap_or(0);
    format!("{history} · {}", plural(bookmarks, "bookmark"))
}

fn bookmark_count(tree: &std::sync::Arc<ardia_state::bookmarks::BookmarkTree>) -> usize {
    thread_local! {
        static COUNTED: std::cell::RefCell<Option<(std::sync::Weak<ardia_state::bookmarks::BookmarkTree>, usize)>> =
            const { std::cell::RefCell::new(None) };
    }
    COUNTED.with(|counted| {
        let mut counted = counted.borrow_mut();
        if let Some((seen, count)) = counted.as_ref()
            && std::ptr::eq(seen.as_ptr(), std::sync::Arc::as_ptr(tree))
        {
            return *count;
        }
        let count = tree.rows().count();
        *counted = Some((std::sync::Arc::downgrade(tree), count));
        count
    })
}

fn tab_layout(view: &SettingsWindowView, row: &'static Row) -> AnyElement {
    const LAYOUTS: rows::Cards = &[
        ("sidebar", "Vertical sidebar", ""),
        ("top", "Horizontal row", ""),
    ];
    let current = if top_tabs(&view.state.settings) {
        "top"
    } else {
        "sidebar"
    };
    cards(view, row, false, current, LAYOUTS, |value| {
        set("tabLayout", value.to_owned())
    })
}

fn after_closing(view: &SettingsWindowView, row: &'static Row) -> AnyElement {
    let options = if top_tabs(&view.state.settings) {
        rows::AFTER_CLOSING_ACROSS
    } else {
        rows::AFTER_CLOSING_DOWN
    };
    let current = text_value(&view.state.settings, "afterClosingTab");
    cards(view, row, true, &current, options, |value| {
        set("afterClosingTab", value.to_owned())
    })
}

fn command_bar_placement(view: &SettingsWindowView, row: &'static Row) -> AnyElement {
    let settings = &view.state.settings;
    let current = if text_value(settings, "commandBarPlacement") == "field" {
        "field"
    } else {
        "centred"
    };
    let body = cards(
        view,
        row,
        true,
        current,
        rows::COMMAND_BAR_PLACES,
        |value| set("commandBarPlacement", value.to_owned()),
    );
    let p = view.look.p;
    div()
        .child(body)
        .when(settings.minimalism_mode, |this| {
            this.child(
                div()
                    .mt(px(8.))
                    .text_center()
                    .text_size(px(11.))
                    .text_color(p.text_tertiary)
                    .child("Minimalism mode hides the address, so ⌘L opens in the center while it’s on."),
            )
        })
        .into_any_element()
}

fn amount_slider(
    view: &SettingsWindowView,
    id: &'static str,
    fraction: f32,
    label: String,
    reset: Option<Msg>,
    change: impl Fn(f32) -> Msg + 'static,
) -> AnyElement {
    let p = view.look.p;
    let emit = view.emit.clone();
    div()
        .debug_selector(move || format!("slider:{id}"))
        .flex()
        .items_center()
        .gap(px(8.))
        .children(reset.map(|msg| {
            IconButton::new(SharedString::from(format!("reset:{id}")), Icon::Undo, &p)
                .square(22., 5.)
                .glyph(12.)
                .tooltip("Follow the Theme", &p)
                .on_click(view.emit.click(msg))
        }))
        .child(
            div().w(px(160.)).px(px(7.)).child(
                Slider::new(SharedString::from(format!("slider:{id}")), fraction, &p)
                    .on_change(move |fraction, window, cx| emit.send(change(fraction), window, cx)),
            ),
        )
        .child(
            div()
                .w(px(36.))
                .text_right()
                .text_size(px(12.))
                .text_color(p.text_secondary)
                .child(label),
        )
        .into_any_element()
}

fn page_frame(view: &SettingsWindowView) -> AnyElement {
    use ardia_theme::layout::PAGE_FRAME_MAX;
    let settings = &view.state.settings;
    let max = f64::from(PAGE_FRAME_MAX);
    let shown = if settings.borderless_mode {
        0.0
    } else {
        settings.page_frame
    };
    let label = if shown <= 0.0 {
        "None".to_owned()
    } else {
        format!("{shown:.0} pt")
    };
    amount_slider(
        view,
        "pageFrame",
        (shown / max) as f32,
        label,
        None,
        move |fraction| {
            let next = (f64::from(fraction) * max).round();
            if next <= 0.0 {
                set("borderlessMode", true)
            } else {
                patch(
                    SettingsPatch::new()
                        .set("borderlessMode", false)
                        .set("pageFrame", next),
                )
            }
        },
    )
}

fn glass_tint(view: &SettingsWindowView) -> AnyElement {
    let settings = &view.state.settings;
    let shown = if settings.glass_tint_with_theme {
        settings.glass_tint_amount
    } else {
        0.0
    };
    let percent = (shown * 100.0).round();
    let label = if percent <= 0.0 {
        "Off".to_owned()
    } else {
        format!("{percent:.0} %")
    };
    amount_slider(view, "glassTint", shown as f32, label, None, |fraction| {
        let next = (f64::from(fraction) * 100.0).round() / 100.0;
        if next <= 0.0 {
            set("glassTintWithTheme", false)
        } else {
            patch(
                SettingsPatch::new()
                    .set("glassTintWithTheme", true)
                    .set("glassTintAmount", next),
            )
        }
    })
}

fn tab_corners(view: &SettingsWindowView) -> AnyElement {
    use ardia_state::settings::TAB_CORNERS_MAX;
    let in_force = TAB_CORNERS_DEFAULT;
    let chosen = view.state.settings.tab_corner_radius;
    let value = chosen.unwrap_or(in_force);
    let reset = chosen.map(|_| set("tabCornerRadius", Value::Null));
    amount_slider(
        view,
        "tabCornerRadius",
        (value / TAB_CORNERS_MAX).clamp(0.0, 1.0) as f32,
        format!("{value:.0} pt"),
        reset,
        |fraction| {
            set(
                "tabCornerRadius",
                (f64::from(fraction) * TAB_CORNERS_MAX).round(),
            )
        },
    )
}

pub fn menu_paths() -> &'static HashMap<String, Vec<String>> {
    &menu_layout().0
}

pub fn menu_order() -> &'static [String] {
    &menu_layout().1
}

pub fn menu_position(id: &str) -> usize {
    menu_layout().2.get(id).copied().unwrap_or(usize::MAX)
}

type MenuLayout = (HashMap<String, Vec<String>>, Vec<String>, HashMap<String, usize>);

fn menu_layout() -> &'static MenuLayout {
    static LAYOUT: OnceLock<MenuLayout> = OnceLock::new();
    LAYOUT.get_or_init(build_menu_paths)
}

#[cfg(target_os = "macos")]
fn build_menu_paths() -> MenuLayout {
    use ardia_engine::macos::menu::{Menu, MenuContext, MenuItem, dia_menu_bar};
    fn walk(menu: &Menu, path: &mut Vec<String>, out: &mut HashMap<String, Vec<String>>) {
        path.push(menu.title.clone());
        for item in &menu.items {
            match item {
                MenuItem::Command(command) if !command.hidden && command.arg.is_none() => {
                    let id = if command.command == "quit" {
                        "std:quit:".to_owned()
                    } else {
                        command.command.clone()
                    };
                    out.entry(id).or_insert_with(|| path.clone());
                }
                MenuItem::Standard(standard) if !standard.hidden && !standard.alternate => {
                    out.entry(format!("std:{}", standard.action))
                        .or_insert_with(|| path.clone());
                }
                MenuItem::Submenu(menu) => walk(menu, path, out),
                _ => {}
            }
        }
        path.pop();
    }
    let bar = dia_menu_bar(&MenuContext {
        app_name: "Ardia".to_owned(),
        ..MenuContext::default()
    });
    let mut out = HashMap::new();
    for menu in &bar.menus {
        walk(menu, &mut Vec::new(), &mut out);
    }
    let order = bar.menus.iter().map(|menu| menu.title.clone()).collect();
    let mut positions = HashMap::new();
    fn standards(items: &[MenuItem], positions: &mut HashMap<String, usize>, at: &mut usize) {
        for item in items {
            match item {
                MenuItem::Command(command) => {
                    let id = if command.command == "quit" {
                        "std:quit:".to_owned()
                    } else {
                        command.command.clone()
                    };
                    positions.entry(id).or_insert(*at);
                    *at += 1;
                }
                MenuItem::Standard(standard) => {
                    positions.entry(format!("std:{}", standard.action)).or_insert(*at);
                    *at += 1;
                }
                MenuItem::Submenu(menu) => standards(&menu.items, positions, at),
                MenuItem::Separator => {}
            }
        }
    }
    let mut at = 0;
    for menu in &bar.menus {
        standards(&menu.items, &mut positions, &mut at);
    }
    (out, order, positions)
}

#[cfg(not(target_os = "macos"))]
fn build_menu_paths() -> MenuLayout {
    (HashMap::new(), Vec::new(), HashMap::new())
}

#[derive(Clone)]
pub struct ShortcutEntry {
    pub id: &'static str,
    pub title: &'static str,
    pub menu: String,
    pub submenu: String,
    pub shown: String,
    pub changed: bool,
    pub conflicts: Vec<&'static str>,
    pub mouse: Option<String>,
}

pub const MOUSE_BUTTONS: [(&str, &str); 3] = [
    ("mouse:middle", "Middle Click"),
    ("mouse:4", "Mouse Button 4"),
    ("mouse:5", "Mouse Button 5"),
];

pub fn mouse_title(stored: &[String], platform: Platform) -> Option<String> {
    let button = stored.first()?;
    let (_, title) = MOUSE_BUTTONS.iter().find(|(key, _)| key == button)?;
    let mut mods = ardia_state::shortcuts::Modifiers::NONE;
    for name in &stored[1..] {
        match name.as_str() {
            "command" => mods.command = true,
            "option" => mods.option = true,
            "shift" => mods.shift = true,
            "control" => mods.control = true,
            _ => {}
        }
    }
    let text = ardia_state::shortcuts::Shortcut::new(
        ardia_state::shortcuts::Key::Char('x'),
        mods,
    )
    .format(platform);
    let modifiers = text.trim_end_matches(['x', 'X']);
    Some(if modifiers.is_empty() {
        (*title).to_owned()
    } else if modifiers.ends_with('+') {
        format!("{modifiers}{title}")
    } else {
        format!("{modifiers} {title}")
    })
}

pub(crate) struct ResolvedShortcut {
    entry: ShortcutEntry,
    title_lower: String,
    menu_lower: String,
    shown_lower: String,
}

pub(crate) enum ShortcutPiece {
    Menu(String),
    Entry { index: usize, first: bool, last: bool },
}

pub(crate) struct ShortcutSections {
    indices: Vec<usize>,
    pieces: Vec<ShortcutPiece>,
    items: Vec<VirtualItem>,
}

const SHORTCUT_MENU_ESTIMATE: f32 = 42.0;
const SHORTCUT_ROW_ESTIMATE: f32 = 45.0;

pub fn shortcut_entries(view: &SettingsWindowView) -> Vec<ShortcutEntry> {
    let (resolved, shown) = shortcut_state(view);
    shown
        .indices
        .iter()
        .map(|&index| resolved[index].entry.clone())
        .collect()
}

fn shortcut_state(
    view: &SettingsWindowView,
) -> (Rc<Vec<ResolvedShortcut>>, Rc<ShortcutSections>) {
    let resolved = view
        .sub
        .memo
        .shortcuts
        .get(Memos::shortcut_inputs(&view.state), |_| resolve_shortcuts(view));
    let shown = view.sub.memo.shortcuts_shown.get(
        (
            Same(resolved.clone()),
            view.shortcut_query.clone(),
            view.shortcut_filter,
        ),
        |(resolved, query, filter)| shortcut_sections(&resolved.0, query, *filter),
    );
    (resolved, shown)
}

fn shortcut_sections(
    resolved: &[ResolvedShortcut],
    query: &str,
    filter: ShortcutFilter,
) -> ShortcutSections {
    let platform = Platform::current();
    let filter_query = query.trim().to_lowercase();
    let combo_keys = ardia_state::shortcuts::Shortcut::parse_glyphs(query.trim())
        .map(|combo| combo.format(platform));
    let indices: Vec<usize> = resolved
        .iter()
        .enumerate()
        .filter(|(_, found)| match filter {
            ShortcutFilter::All => true,
            ShortcutFilter::Customized => found.entry.changed,
            ShortcutFilter::Conflicts => !found.entry.conflicts.is_empty(),
        })
        .filter(|(_, found)| match &combo_keys {
            Some(keys) => found.entry.shown == *keys,
            None => {
                filter_query.is_empty()
                    || filter_query.split_whitespace().all(|word| {
                        found.title_lower.contains(word)
                            || found.menu_lower.contains(word)
                            || found.shown_lower.contains(word)
                    })
            }
        })
        .map(|(index, _)| index)
        .collect();
    let mut menus: Vec<&str> = Vec::new();
    for &index in &indices {
        let menu = resolved[index].entry.menu.as_str();
        if !menus.contains(&menu) {
            menus.push(menu);
        }
    }
    let order = menu_order();
    menus.sort_by_key(|menu| {
        order
            .iter()
            .position(|title| title == menu)
            .unwrap_or(usize::MAX)
    });
    let mut pieces = Vec::new();
    let mut items = Vec::new();
    for menu in menus {
        pieces.push(ShortcutPiece::Menu(menu.to_owned()));
        items.push(VirtualItem::header(
            format!("shortcut-menu:{menu}"),
            SHORTCUT_MENU_ESTIMATE,
        ));
        let members: Vec<usize> = indices
            .iter()
            .copied()
            .filter(|&index| resolved[index].entry.menu == menu)
            .collect();
        for (at, &index) in members.iter().enumerate() {
            pieces.push(ShortcutPiece::Entry {
                index,
                first: at == 0,
                last: at + 1 == members.len(),
            });
            items.push(VirtualItem::new(
                format!("shortcut-row:{}", resolved[index].entry.id),
                SHORTCUT_ROW_ESTIMATE,
            ));
        }
    }
    ShortcutSections {
        indices,
        pieces,
        items,
    }
}

fn resolve_shortcuts(view: &SettingsWindowView) -> Vec<ResolvedShortcut> {
    let platform = Platform::current();
    let map = view.state.shortcut_map(platform);
    let overrides = &view.state.settings.shortcuts;
    let paths = menu_paths();
    let listed: Vec<(&'static str, &'static str, Option<String>)> = COMMANDS
        .iter()
        .filter(|spec| {
            if paths.is_empty() {
                !spec.command.id().starts_with("std:")
            } else {
                paths.contains_key(spec.command.id())
            }
        })
        .map(|spec| {
            let id = spec.command.id();
            (id, spec.title, map.primary(id).map(|s| s.format(platform)))
        })
        .collect();
    let mut listed = listed;
    listed.sort_by_key(|(id, _, _)| menu_position(id));
    listed
        .iter()
        .map(|(id, title, shown)| {
            let path = paths.get(*id).cloned().unwrap_or_default();
            let conflicts = listed
                .iter()
                .filter(|(other, _, keys)| other != id && keys.is_some() && *keys == *shown)
                .map(|(_, title, _)| *title)
                .collect();
            ShortcutEntry {
                id,
                title,
                menu: path
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "Commands".to_owned()),
                submenu: path.iter().skip(1).cloned().collect::<Vec<_>>().join(" › "),
                shown: shown.clone().unwrap_or_default(),
                changed: overrides.contains_key(*id)
                    || view.state.settings.mouse_shortcuts.contains_key(*id),
                conflicts,
                mouse: view
                    .state
                    .settings
                    .mouse_shortcuts
                    .get(*id)
                    .and_then(|stored| mouse_title(stored, platform)),
            }
        })
        .map(|entry| ResolvedShortcut {
            title_lower: entry.title.to_lowercase(),
            menu_lower: entry.menu.to_lowercase(),
            shown_lower: entry.shown.to_lowercase(),
            entry,
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ShortcutFilter {
    #[default]
    All,
    Customized,
    Conflicts,
}

impl ShortcutFilter {
    pub const ALL: [(ShortcutFilter, &'static str); 3] = [
        (ShortcutFilter::All, "All Shortcuts"),
        (ShortcutFilter::Customized, "Customized Shortcuts"),
        (ShortcutFilter::Conflicts, "Conflicting Shortcuts"),
    ];

    pub fn key(self) -> &'static str {
        match self {
            ShortcutFilter::All => "all",
            ShortcutFilter::Customized => "customized",
            ShortcutFilter::Conflicts => "conflicts",
        }
    }
}

fn shortcut_row(view: &SettingsWindowView, entry: &ShortcutEntry) -> AnyElement {
    let p = view.look.p;
    let id = entry.id;
    let recording = view.recording.as_deref() == Some(id);
    let detail = if entry.conflicts.is_empty() {
        (!entry.submenu.is_empty()).then(|| entry.submenu.clone())
    } else {
        Some(format!("Also used by {}", entry.conflicts.join(", ")))
    };
    let warn = !entry.conflicts.is_empty();
    div()
        .min_h(px(ROW_MIN_HEIGHT))
        .px(px(ROW_PAD_X))
        .py(px(ROW_PAD_Y))
        .flex()
        .items_center()
        .gap(px(12.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().text_size(px(13.)).truncate().child(entry.title))
                .when_some(detail, |this, detail| {
                    this.child(
                        div()
                            .mt(px(2.))
                            .text_size(px(11.))
                            .text_color(if warn {
                                p.destructive
                            } else {
                                p.text_secondary
                            })
                            .child(detail),
                    )
                }),
        )
        .when(entry.changed, |this| {
            this.child(
                IconButton::new(
                    SharedString::from(format!("shortcut-reset:{id}")),
                    Icon::Undo,
                    &p,
                )
                .square(22., 5.)
                .glyph(12.)
                .tooltip("Reset to Default", &p)
                .on_click(
                    view.emit
                        .click(Msg::Store(Action::ResetShortcut { id: id.to_owned() })),
                ),
            )
        })
        .child(
            div()
                .id(SharedString::from(format!("shortcut:{id}")))
                .debug_selector(move || format!("shortcut:{id}"))
                .min_w(px(110.))
                .flex()
                .flex_col()
                .items_stretch()
                .cursor_pointer()
                .on_click(
                    view.emit
                        .click(Msg::Recording(Some(SharedString::new_static(id)))),
                )
                .on_hover({
                    let emit = view.emit.clone();
                    move |hovered, window, cx| {
                        emit.send(
                            Msg::Command(SharedString::from(format!(
                                "settings:hoverShortcut:{}:{id}",
                                if *hovered { "in" } else { "out" }
                            ))),
                            window,
                            cx,
                        )
                    }
                })
                .child({
                    let empty = !recording && entry.shown.is_empty();
                    let text = if recording {
                        SharedString::new_static("Type Shortcut")
                    } else if empty {
                        SharedString::new_static("None")
                    } else {
                        SharedString::from(entry.shown.clone())
                    };
                    crate::primitives::controls::KeyCap::new(text, &p)
                        .empty(empty)
                        .editing(recording)
                        .hovered(view.hovered_shortcut == Some(id))
                })
                .when(
                    !recording && !entry.shown.is_empty() && view.hovered_shortcut == Some(id),
                    |this| {
                        this.relative().child(clear_button(
                            view,
                            SharedString::from(format!("shortcut-clear:{id}")),
                            "Remove Shortcut",
                            Msg::Command(SharedString::from(format!("settings:clearShortcut:{id}"))),
                            None,
                        ))
                    },
                ),
        )
        .when_some(entry.mouse.clone(), |this, title| {
            let hover_key = SharedString::from(format!("mouse:{id}"));
            this.child(
                div()
                    .id(SharedString::from(format!("shortcut-mouse:{id}")))
                    .debug_selector(move || format!("shortcut-mouse:{id}"))
                    .relative()
                    .min_w(px(110.))
                    .flex()
                    .flex_col()
                    .items_stretch()
                    .group(hover_key.clone())
                    .child(crate::primitives::controls::KeyCap::new(title, &p))
                    .child(clear_button(
                        view,
                        SharedString::from(format!("shortcut-mouse-clear:{id}")),
                        "Remove Mouse Shortcut",
                        Msg::Command(SharedString::from(format!(
                            "settings:clearMouseShortcut:{id}"
                        ))),
                        Some(hover_key),
                    )),
            )
        })
        .into_any_element()
}

fn clear_button(
    view: &SettingsWindowView,
    id: SharedString,
    label: &'static str,
    msg: Msg,
    reveal_with: Option<SharedString>,
) -> AnyElement {
    let p = view.look.p;
    let selector = id.clone();
    let emit = view.emit.clone();
    div()
        .id(id)
        .when_some(reveal_with, |this, group| {
            this.opacity(0.).group_hover(group, |style| style.opacity(1.))
        })
        .debug_selector(move || selector.to_string())
        .absolute()
        .right(px(4.))
        .top_0()
        .bottom_0()
        .flex()
        .items_center()
        .cursor_pointer()
        .tooltip(crate::primitives::controls::tooltip(
            SharedString::new_static(label),
            &p,
        ))
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            emit.send(msg.clone(), window, cx);
        })
        .child(icon(Icon::XMark, 11., p.text_tertiary))
        .into_any_element()
}

fn shortcut_list(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let (resolved, shown) = shortcut_state(view);
    let customized =
        view.state.settings.shortcuts.len() + view.state.settings.mouse_shortcuts.len();
    let filter_label = ShortcutFilter::ALL
        .iter()
        .find(|(filter, _)| *filter == view.shortcut_filter)
        .map(|(_, label)| *label)
        .unwrap_or("All Shortcuts");
    let filters = ShortcutFilter::ALL
        .iter()
        .map(|(filter, label)| PopupItem {
            value: Some(SharedString::new_static(filter.key())),
            label: SharedString::new_static(label),
            checked: *filter == view.shortcut_filter,
            msgs: vec![Msg::Command(SharedString::from(format!(
                "settings:shortcutFilter:{}",
                filter.key()
            )))],
        })
        .collect();
    let toolbar = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(
            crate::primitives::controls::field_box(&p)
                .flex_1()
                .gap(px(6.))
                .child(icon(Icon::Search, 11., p.text_tertiary))
                .child(div().flex_1().min_w_0().child(if view.key_searching {
                    div()
                        .text_size(px(13.))
                        .text_color(p.placeholder)
                        .child("Type Shortcut")
                        .into_any_element()
                } else {
                    view.shortcut_search.clone().into_any_element()
                })),
        )
        .child(
            div().debug_selector(|| "shortcuts-key-search".into()).child(
                IconButton::new("shortcuts-key-search", Icon::Keyboard, &p)
                    .square(24., 5.)
                    .glyph(13.)
                    .toggled(view.key_searching.then_some(p.toolbar_pressed))
                    .tooltip("Search by Keys", &p)
                    .on_click(view.emit.click(Msg::Command(SharedString::new_static(
                        "settings:keySearch",
                    )))),
            ),
        )
        .child(popup(
            view,
            "shortcutFilter",
            filter_label,
            170.,
            false,
            filters,
        ))
        .child(
            PushButton::new("shortcuts-reset-all", "Reset All Shortcuts", &p)
                .disabled(customized == 0)
                .on_click(view.emit.click(patch(
                    SettingsPatch::new()
                        .set("shortcuts", serde_json::json!({}))
                        .set("mouseShortcuts", serde_json::json!({})),
                ))),
        );
    div()
        .debug_selector(|| "setting:shortcuts.menuCommands".into())
        .child(toolbar)
        .child(
            div()
                .mt(px(16.))
                .text_size(px(11.))
                .text_color(p.text_tertiary)
                .child("To use a mouse button, click a shortcut, then press the middle button or a side button."),
        )
        .when(shown.indices.is_empty(), |this| {
            this.child(
                div()
                    .mt(px(32.))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(6.))
                    .text_color(p.text_secondary)
                    .child(icon(Icon::Search, 22., p.text_tertiary))
                    .child(div().text_size(px(13.)).child("No matching commands")),
            )
        })
        .child(
            virtual_list("settings:shortcuts", &view.scroll)
                .items(shown.items.clone())
                .render(|ix, _| match &shown.pieces[ix] {
                    ShortcutPiece::Menu(menu) => wrapped(section_header(&p, menu.clone(), None)),
                    ShortcutPiece::Entry { index, first, last } => group_piece(
                        &p,
                        *first,
                        *last,
                        shortcut_row(view, &resolved[*index].entry),
                    ),
                }),
        )
        .into_any_element()
}

fn plugin_list(view: &SettingsWindowView, row: &'static Row) -> AnyElement {
    let p = view.look.p;
    let rows = crate::settings::extras::plugin_list_rows(view);
    div()
        .id(SharedString::from(format!("setting:{}", row.id)))
        .debug_selector(move || format!("setting:{}", row.id))
        .child(
            div()
                .mt(px(SECTION_TOP))
                .mb(px(6.))
                .px(px(6.))
                .flex()
                .items_end()
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(row.section),
                        )
                        .child(
                            div()
                                .mt(px(4.))
                                .text_size(px(12.))
                                .text_color(p.text_secondary)
                                .child(row.description),
                        ),
                )
                .child(
                    PushButton::new("plugins-show-folder", "Show in Finder", &p)
                        .disabled(view.host.plugin_folder().is_none())
                        .on_click(view.emit.click(Msg::Command(SharedString::new_static(
                            "settings:showPluginsFolder",
                        )))),
                ),
        )
        .child(group(&p, rows))
        .into_any_element()
}

pub(crate) fn open_page_owned(view: &SettingsWindowView, url: String) -> Msg {
    match view.state.main_window_for(None).cloned() {
        Some(window) => Msg::Store(Action::NewTab {
            window,
            tab: NewTab {
                url: Some(url),
                ..NewTab::default()
            },
        }),
        None => Msg::Noop,
    }
}

pub const APP_ICON_SIZE: f32 = 56.0;
pub const APP_ICON_CARD: f32 = 70.0;
pub const APP_ICON_COLUMN: f32 = 72.0;

fn app_icon_picker(view: &SettingsWindowView, row: &'static Row) -> AnyElement {
    let p = view.look.p;
    let current = view.host.current_app_icon();
    let hover_fill = p.row_hover;
    let grid = div()
        .flex()
        .flex_wrap()
        .gap_x(px(6.))
        .gap_y(px(10.))
        .children(view.host.app_icons().into_iter().map(|choice| {
            let selected = current.as_deref() == Some(choice.id.as_str());
            let label = SharedString::from(if choice.flat {
                format!("{}, flat", choice.name)
            } else {
                choice.name.clone()
            });
            let id = choice.id.clone();
            div()
                .id(SharedString::from(format!("app-icon:{id}")))
                .debug_selector({
                    let id = id.clone();
                    move || format!("app-icon:{id}")
                })
                .w(px(APP_ICON_COLUMN))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(8.))
                .cursor_pointer()
                .tooltip(crate::primitives::controls::tooltip(label, &p))
                .on_click(view.emit.click(Msg::Command(SharedString::from(format!(
                    "settings:appIcon:{id}"
                )))))
                .child(
                    div()
                        .size(px(APP_ICON_CARD))
                        .rounded(px(16.))
                        .overflow_hidden()
                        .flex()
                        .items_center()
                        .justify_center()
                        .border(px(if selected { 2. } else { 1. }))
                        .border_color(if selected { p.form_accent } else { p.group_stroke })
                        .when(!selected, |this| this.hover(move |style| style.bg(hover_fill)))
                        .children(choice.preview.map(|image| gpui::img(image).size(px(APP_ICON_SIZE)))),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .when(selected, |this| {
                            this.child(icon(Icon::CheckCircleFill, 12., p.form_accent))
                        })
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(if selected { p.text } else { p.text_secondary })
                                .truncate()
                                .child(choice.name),
                        ),
                )
        }))
        .into_any_element();
    form_field(view, row, grid)
}

fn open_page(view: &SettingsWindowView, url: &'static str) -> Msg {
    match view.state.main_window_for(None).cloned() {
        Some(window) => Msg::Store(Action::NewTab {
            window,
            tab: NewTab {
                url: Some(url.to_owned()),
                ..NewTab::default()
            },
        }),
        None => Msg::Noop,
    }
}

fn act(view: &SettingsWindowView, act: Act) -> Msg {
    match act {
        Act::Url(url) => open_page(view, url),
        Act::Utility(kind) => Msg::Utility(kind),
        Act::Command(command) => Msg::Command(SharedString::new_static(command)),
        Act::DeleteProfile => Msg::Command(SharedString::new_static("settings:deleteProfile")),
    }
}

fn custom_control(view: &SettingsWindowView, row: &'static Row, which: Custom) -> AnyElement {
    let settings = &view.state.settings;
    let id = row.id;
    match which {
        Custom::DownloadsFolder | Custom::ProfileDownloadsFolder => {
            let (profile, target) = if which == Custom::DownloadsFolder {
                (default_profile(view), "all")
            } else {
                (
                    selected_profile(view).unwrap_or_else(|| default_profile(view)),
                    "profile",
                )
            };
            let locked = view
                .host
                .download_settings(&profile)
                .is_none_or(|current| current.managed);
            PushButton::new(
                SharedString::from(format!("button:{id}")),
                "Change…",
                &view.look.p,
            )
            .disabled(locked)
            .on_click(view.emit.click(Msg::Command(SharedString::from(format!(
                "settings:pickDownloads:{target}"
            )))))
            .into_any_element()
        }
        Custom::SeparateDownloads => toggle(
            view,
            "separateDownloadFolders",
            settings.separate_download_folders,
            |on| {
                Msg::Command(SharedString::from(format!(
                    "settings:separateDownloads:{on}"
                )))
            },
        ),
        Custom::AskWhereToSave => {
            let on = view
                .host
                .download_settings(&default_profile(view))
                .is_some_and(|current| current.ask_where_to_save);
            toggle(view, "askWhereToSave", on, |on| {
                Msg::Command(SharedString::from(format!("settings:askWhereToSave:{on}")))
            })
        }
        Custom::Programs => div().into_any_element(),
        Custom::KeptSites => PushButton::new("kept-sites-add", "Add Site…", &view.look.p)
            .icon(Icon::Plus)
            .on_click(view.emit.click(Msg::Command(SharedString::new_static(
                "settings:keptSiteSheet",
            ))))
            .into_any_element(),
        Custom::ShareDiagnostics => {
            let on = view.host.sharing();
            toggle(view, "shareDiagnostics", on, |on| {
                Msg::Command(SharedString::from(format!("settings:sharing:{on}")))
            })
        }
        Custom::Version => div().into_any_element(),
        Custom::OfficialPlugins => div().into_any_element(),
        Custom::PasswordManager => {
            let profile = selected_profile(view).unwrap_or_else(|| default_profile(view));
            crate::settings::extras::password_manager_popup(view, &profile)
        }
        Custom::AutoUpdate => crate::settings::updates::auto_update(view),
        Custom::UpdateChannel => crate::settings::updates::channel_picker(view),
        Custom::ProfileFlag(flag) => {
            let profile = selected_profile(view).unwrap_or_else(|| default_profile(view));
            let flags = view.host.profile_flags(&profile).unwrap_or_default();
            let on = match flag {
                crate::host::ProfileFlagKind::PasswordsOffered => flags.passwords_offered,
                crate::host::ProfileFlagKind::AddressesAutofilled => flags.addresses_autofilled,
                crate::host::ProfileFlagKind::CardsAutofilled => flags.cards_autofilled,
                crate::host::ProfileFlagKind::PreloadPages => flags.preload_pages,
            };
            if flag == crate::host::ProfileFlagKind::PasswordsOffered
                && crate::settings::extras::handed_over(view, &profile).is_some()
            {
                return div()
                    .debug_selector(|| "toggle:passwordsOffered".into())
                    .child(
                        Toggle::new("toggle:passwordsOffered", false, &view.look.p)
                            .native(true)
                            .disabled(true),
                    )
                    .into_any_element();
            }
            let command = format!("settings:profileFlag:{}", flag_key(flag));
            toggle(view, flag_key(flag), on, move |on| {
                Msg::Command(SharedString::from(format!("{command}:{on}")))
            })
        }
        Custom::NewTabUrl => {
            let typed = view.new_tab_typed.clone();
            let invalid = !typed.trim().is_empty() && rows::custom_new_tab_url(&typed).is_none();
            crate::primitives::controls::field_box(&view.look.p)
                .debug_selector(|| "new-tab-url".into())
                .w(px(220.))
                .h(px(24.))
                .when(invalid, |this| this.border_color(view.look.p.destructive))
                .child(div().flex_1().min_w_0().child(view.new_tab_url.clone()))
                .into_any_element()
        }
        Custom::ProfileIcon => crate::settings::profiles::icon_control(view),
        Custom::ProfileSync => crate::settings::profiles::sync_toggle(view),
        Custom::ProfileName => crate::primitives::controls::field_box(&view.look.p)
            .debug_selector(|| "profile-name".into())
            .w(px(220.))
            .h(px(24.))
            .child(div().flex_1().min_w_0().child(view.profile_name.clone()))
            .into_any_element(),
        Custom::OpenAtLogin => {
            let on = view.login.is_some_and(|login| login.on);
            toggle(view, "openAtLogin", on, |on| {
                Msg::Command(SharedString::from(format!("settings:openAtLogin:{on}")))
            })
        }
        Custom::RestoreSession => {
            let current = if settings.restore_session {
                "keep"
            } else {
                "close"
            };
            choice_popup(
                view,
                id,
                current,
                owned(rows::WINDOWS_AND_TABS),
                190.,
                false,
                |value| vec![set("restoreSession", value == "keep")],
            )
        }
        Custom::EngineMode => crate::settings::engines::engine_mode_control(view),
        Custom::PageEngine => crate::settings::engines::page_engine_control(view),
        Custom::WebsiteEngines => crate::settings::engines::website_engines_control(view),
        Custom::SearchEngine => {
            let engines = view.state.search_engines();
            let current = view.state.default_search_engine().id;
            let options = engines
                .iter()
                .map(|e| (e.id.clone(), e.name.clone()))
                .collect();
            let locked = crate::settings::subpages::controlling_extension(view).is_some();
            choice_popup(view, id, &current, options, 160., locked, |value| {
                vec![set("searchEngine", value.to_owned())]
            })
        }
        Custom::DefaultProfile => {
            let current = settings.default_profile_id.clone();
            let options = view
                .state
                .profile_order
                .iter()
                .filter_map(|id| view.state.profile(id.as_str()))
                .map(|profile| (profile.id.to_string(), profile.name.clone()))
                .collect();
            choice_popup(view, id, &current, options, 160., false, |value| {
                vec![set("defaultProfileId", value.to_owned())]
            })
        }
        Custom::Badges => {
            let on = settings.show_unread_counts || settings.show_top_app_badges;
            toggle(view, "badges", on, |on| {
                patch(
                    SettingsPatch::new()
                        .set("showUnreadCounts", on)
                        .set("showTopAppBadges", on),
                )
            })
        }
        Custom::SleepingTabs => choice_popup(
            view,
            id,
            sleeping_look(settings),
            owned(rows::SLEEPING_LOOKS),
            150.,
            false,
            |value| {
                let fade = value == "fade" || value == "both";
                let strike = value == "strike" || value == "both";
                vec![patch(
                    SettingsPatch::new()
                        .set("fadeUnloadedTabs", fade)
                        .set("strikeSleepingTabs", strike),
                )]
            },
        ),
        Custom::NewTabOpens => {
            let minimal = settings.minimalism_mode;
            let current = if minimal {
                "commandBar".to_owned()
            } else {
                text_value(settings, "newTabOpens")
            };
            choice_popup(
                view,
                id,
                &current,
                owned(rows::NEW_TAB_OPENS),
                160.,
                minimal,
                |value| vec![set("newTabOpens", value.to_owned())],
            )
        }
        Custom::NewTabPosition => {
            let options = if top_tabs(settings) {
                rows::NEW_TABS_ACROSS
            } else {
                rows::NEW_TABS_DOWN
            };
            let current = text_value(settings, "newTabPosition");
            choice_popup(view, id, &current, owned(options), 190., false, |value| {
                let next = SettingsPatch::new().set("newTabPosition", value.to_owned());
                vec![patch(if value == "nextToCurrent" {
                    next
                } else {
                    next.set("newTabButtonPosition", value.to_owned())
                })]
            })
        }
        Custom::LinksInLittleArdia => setting_toggle(view, "openLinksInLittleArdia"),
        Custom::PeekOtherSites => {
            let current = if settings.peek_links_to_other_sites {
                "peek"
            } else {
                "same"
            };
            choice_popup(
                view,
                id,
                current,
                owned(rows::OTHER_SITE_LINKS),
                120.,
                false,
                |value| vec![set("peekLinksToOtherSites", value == "peek")],
            )
        }
        Custom::CleanUp => {
            let current = clean_up_value(settings);
            choice_popup(
                view,
                id,
                &current,
                clean_up_choices(settings),
                130.,
                false,
                |value| {
                    vec![match (value, value.parse::<f64>()) {
                        (CUSTOM_CLEAN_UP, _) => {
                            Msg::Command(SharedString::new_static("settings:cleanUpCustom"))
                        }
                        (_, Ok(minutes)) => set("cleanUpInactiveTabsAfterMinutes", minutes),
                        (_, Err(_)) => set("cleanUpInactiveTabsAfterMinutes", Value::Null),
                    }]
                },
            )
        }
        Custom::GlassTint => glass_tint(view),
        Custom::HighContrast => {
            use ardia_state::settings::SidebarTextContrast;
            let on = match settings.sidebar_text_contrast {
                SidebarTextContrast::High => true,
                SidebarTextContrast::Standard => false,
                SidebarTextContrast::Auto => false,
            };
            toggle(view, "sidebarTextContrast", on, |on| {
                set("sidebarTextContrast", if on { "high" } else { "standard" })
            })
        }
        Custom::CommandBarOnClick => {
            let on = text_value(settings, "commandBarPlacement") == "centredOnClick";
            toggle(view, "commandBarOnClick", on, |on| {
                set(
                    "commandBarPlacement",
                    if on { "centredOnClick" } else { "centred" },
                )
            })
        }
        Custom::BookmarksBar => {
            let current = if settings.show_bookmarks {
                text_value(settings, "bookmarksBar")
            } else {
                "hidden".to_owned()
            };
            choice_popup(
                view,
                id,
                &current,
                owned(rows::BOOKMARKS_BAR),
                190.,
                false,
                |value| {
                    vec![if value == "hidden" {
                        set("showBookmarks", false)
                    } else {
                        patch(
                            SettingsPatch::new()
                                .set("showBookmarks", true)
                                .set("bookmarksBar", value.to_owned()),
                        )
                    }]
                },
            )
        }
        Custom::PageFrame => page_frame(view),
        Custom::FullScreenFrame => choice_popup(
            view,
            id,
            full_screen_frame(settings),
            owned(rows::FULL_SCREEN_FRAME),
            220.,
            false,
            |value| vec![patch(full_screen_patch(value))],
        ),
        Custom::TabCorners => tab_corners(view),
        Custom::CtrlTab => PushButton::new("ctrl-tab-choose", "Choose…", &view.look.p)
            .on_click(view.emit.click(Msg::Command(SharedString::new_static(
                "settings:reveal:appearance.ctrlTab",
            ))))
            .into_any_element(),
        Custom::MemorySaver => {
            let level = memory_saver_level(settings);
            let mut options: Vec<(String, String)> = rows::MEMORY_SAVER
                .iter()
                .map(|(value, title, _)| ((*value).to_owned(), (*title).to_owned()))
                .collect();
            if level == "custom" {
                options.push(("custom".to_owned(), "Custom".to_owned()));
            }
            choice_popup(view, id, level, options, 190., false, |value| {
                memory_saver_patch(value).map(patch).into_iter().collect()
            })
        }
        Custom::BatterySaver => {
            let current = text_value(settings, "batterySaverWhen");
            let options = rows::BATTERY_SAVER
                .iter()
                .map(|(value, title, _)| ((*value).to_owned(), (*title).to_owned()))
                .collect();
            choice_popup(view, id, &current, options, 190., false, |value| {
                vec![set("batterySaverWhen", value.to_owned())]
            })
        }
        Custom::InterfaceSize => interface_size(view),
        Custom::SyncSection
        | Custom::ProfileBar
        | Custom::ProfileColour
        | Custom::TabLayout
        | Custom::Buttons
        | Custom::AfterClosing
        | Custom::CommandBarPlacement
        | Custom::ShortcutList
        | Custom::PluginList
        | Custom::AppIcon
        | Custom::AllowedPrograms
        | Custom::SearchControlled
        | Custom::InstalledExtensions => div().into_any_element(),
        Custom::ExportBookmarks => crate::settings::subpages::export_bookmarks_control(view),
        Custom::BlockCategory => crate::settings::general_subpages::content_blocking_control(view, id),
    }
}

fn buttons_checklist(view: &SettingsWindowView) -> AnyElement {
    let settings = &view.state.settings;
    let p = view.look.p;
    let sidebar_button = settings.show_sidebar_button;
    let clear_button = settings.show_clear_button;
    let top = top_tabs(settings);
    let emit = view.emit.clone();
    let clear_emit = view.emit.clone();
    div()
        .flex()
        .items_center()
        .gap(px(12.))
        .child(
            div()
                .debug_selector(|| "check:showSidebarButton".into())
                .child(
                    Checkbox::new("check:showSidebarButton", sidebar_button, "Hide Tabs", &p)
                        .on_toggle(move |on, window, cx| {
                            emit.send(set("showSidebarButton", on), window, cx)
                        }),
                ),
        )
        .when(!top, |this| {
            this.child(
                div()
                    .debug_selector(|| "check:showClearButton".into())
                    .child(
                        Checkbox::new("check:showClearButton", clear_button, "Clear", &p)
                            .on_toggle(move |on, window, cx| {
                                clear_emit.send(set("showClearButton", on), window, cx)
                            }),
                    ),
            )
        })
        .into_any_element()
}

fn programs_description(view: &SettingsWindowView) -> String {
    let host = view.host.plugins();
    let any = host
        .as_ref()
        .is_some_and(|plugins| !plugins.plugin_programs().is_empty());
    let mut text = if any {
        "Commands your plugins put in your terminal.".to_owned()
    } else {
        "None of your plugins add commands to your terminal.".to_owned()
    };
    if host.is_some_and(|plugins| plugins.programs_registry_unreadable()) {
        text.push_str(" Ardia's list of program names kept for its built-in plugins is missing or damaged, so no program goes on PATH. Reinstall Ardia from ardia.dev.");
    }
    text
}

pub fn plugin_program_rows(view: &SettingsWindowView) -> Vec<AnyElement> {
    let p = view.look.p;
    let Some(plugins) = view.host.plugins() else {
        return Vec::new();
    };
    let hover = p.row_hover;
    plugins
        .plugin_programs()
        .into_iter()
        .map(|entry| {
            let failed = entry.can_relink();
            let plugin = entry.plugin.clone();
            let selector = plugin.clone();
            div()
                .id(SharedString::from(format!("plugin-programs:{plugin}")))
                .debug_selector(move || format!("plugin-programs:{selector}"))
                .min_h(px(ROW_MIN_HEIGHT))
                .px(px(ROW_PAD_X))
                .py(px(ROW_PAD_Y))
                .flex()
                .items_center()
                .gap(px(12.))
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .on_click(view.emit.click(Msg::SettingsPane(Pane::Plugins.index())))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(13.))
                                .line_height(px(16.))
                                .child(entry.title.clone()),
                        )
                        .child(
                            div()
                                .mt(px(2.))
                                .text_size(px(11.))
                                .line_height(px(14.))
                                .text_color(if failed { p.destructive } else { p.text_secondary })
                                .child(entry.line()),
                        ),
                )
                .when(failed, |this| {
                    this.child(
                        PushButton::new(
                            SharedString::from(format!("programs-retry:{plugin}")),
                            "Try Again",
                            &p,
                        )
                        .on_click(view.emit.click(Msg::Command(SharedString::from(format!(
                            "settings:relinkPrograms:{plugin}"
                        ))))),
                    )
                })
                .child(icon(Icon::ChevronRight, 11., p.text_tertiary))
                .into_any_element()
        })
        .collect()
}

pub fn kept_site_rows(view: &SettingsWindowView) -> Vec<AnyElement> {
    let p = view.look.p;
    let mut sites = view.state.settings.keep_active_sites.clone();
    sites.sort();
    sites
        .into_iter()
        .map(|site| {
            let label = site.clone();
            div()
                .min_h(px(ROW_MIN_HEIGHT))
                .px(px(ROW_PAD_X))
                .py(px(ROW_PAD_Y))
                .flex()
                .items_center()
                .gap(px(12.))
                .child(icon(Icon::Globe, 14., p.icon))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(13.))
                        .child(label),
                )
                .child(
                    div()
                        .debug_selector({
                            let site = site.clone();
                            move || format!("kept-site-remove:{site}")
                        })
                        .child(
                            IconButton::new(
                                SharedString::from(format!("kept-site-remove:{site}")),
                                Icon::Trash,
                                &p,
                            )
                            .square(22., 5.)
                            .glyph(12.)
                            .tooltip("Remove", &p)
                            .on_click(view.emit.click(Msg::Command(SharedString::from(format!(
                                "settings:keptSiteRemove:{site}"
                            ))))),
                        ),
                )
                .into_any_element()
        })
        .collect()
}

pub fn rename_sheet(view: &SettingsWindowView) -> AnyElement {
    use crate::primitives::sheets::{Dialog, dialog_actions, dialog_title};
    use crate::primitives::tokens::SheetSize;
    let p = view.look.p;
    let cancel = view.emit.clone();
    Dialog::sheet("rename-sheet", SheetSize::S, &p)
        .on_dismiss(move |window, cx| {
            cancel.send(Msg::Command(SharedString::new_static("settings:sheetClose")), window, cx)
        })
        .child(dialog_title("Rename Profile", None, None, &p))
        .child(
            crate::primitives::controls::field_box(&p)
                .debug_selector(|| "rename-field".into())
                .mt(px(12.))
                .h(px(22.))
                .child(div().flex_1().min_w_0().child(view.rename_input.clone())),
        )
        .child(dialog_actions(
            None,
            None,
            [
                PushButton::new("rename-cancel", "Cancel", &p)
                    .on_click(view.emit.click(Msg::Command(SharedString::new_static(
                        "settings:sheetClose",
                    ))))
                    .into_any_element(),
                div()
                    .debug_selector(|| "rename-save".into())
                    .child(
                        PushButton::new("rename-save", "Rename", &p)
                            .kind(ButtonKind::Primary)
                            .on_click(view.emit.click(Msg::Command(SharedString::new_static(
                                "settings:renameSave",
                            )))),
                    )
                    .into_any_element(),
            ],
            &p,
        ))
        .into_any_element()
}

pub fn kept_site_sheet(view: &SettingsWindowView, error: Option<&'static str>) -> AnyElement {
    use crate::primitives::sheets::{Dialog, dialog_actions, dialog_title};
    use crate::primitives::tokens::SheetSize;
    let p = view.look.p;
    let cancel = view.emit.clone();
    Dialog::sheet("kept-site-sheet", SheetSize::M, &p)
        .on_dismiss(move |window, cx| {
            cancel.send(
                Msg::Command(SharedString::new_static("settings:sheetClose")),
                window,
                cx,
            )
        })
        .child(dialog_title(
            "Add Site",
            Some(SharedString::new_static(
                "Sites you add will always stay active and memory won't be freed up from them.",
            )),
            None,
            &p,
        ))
        .child(
            div()
                .mt(px(12.))
                .mb(px(4.))
                .text_size(px(11.))
                .text_color(p.text_secondary)
                .child("Site"),
        )
        .child(
            crate::primitives::controls::field_box(&p)
                .debug_selector(|| "kept-site-field".into())
                .h(px(22.))
                .child(div().flex_1().min_w_0().child(view.site_input.clone())),
        )
        .when_some(error, |this, error| {
            this.child(
                div()
                    .debug_selector(|| "kept-site-error".into())
                    .mt(px(10.))
                    .text_size(px(11.))
                    .text_color(p.destructive)
                    .child(error),
            )
        })
        .child(dialog_actions(
            None,
            None,
            [
                PushButton::new("kept-site-cancel", "Cancel", &p)
                    .on_click(view.emit.click(Msg::Command(SharedString::new_static(
                        "settings:sheetClose",
                    ))))
                    .into_any_element(),
                div()
                    .debug_selector(|| "kept-site-add".into())
                    .child(
                        PushButton::new("kept-site-add", "Add", &p)
                            .kind(ButtonKind::Primary)
                            .disabled(view.site_typed.trim().is_empty())
                            .on_click(view.emit.click(Msg::Command(SharedString::new_static(
                                "settings:keptSiteAdd",
                            )))),
                    )
                    .into_any_element(),
            ],
            &p,
        ))
        .into_any_element()
}

fn inline_row(view: &SettingsWindowView, row: &'static Row) -> AnyElement {
    let settings = &view.state.settings;
    let p = &view.look.p;
    match row.control {
        Control::Toggle(key) => row_shell(view, row, Some(setting_toggle(view, key)), None, None),
        Control::Popup(key, options) => row_shell(
            view,
            row,
            Some(setting_popup(view, row.id, key, options)),
            None,
            None,
        ),
        Control::Segmented(key, options) => {
            let current = text_value(settings, key);
            let selected = options
                .iter()
                .position(|(value, _)| *value == current)
                .unwrap_or(0);
            let emit = view.emit.clone();
            let control = options
                .iter()
                .fold(
                    Segmented::new(SharedString::from(format!("choice:{key}")), selected, p),
                    |control, (_, label)| control.option(*label, None),
                )
                .on_select(move |index, window, cx| {
                    if let Some((value, _)) = options.get(index) {
                        emit.send(set(key, *value), window, cx);
                    }
                })
                .into_any_element();
            row_shell(view, row, Some(control), None, None)
        }
        Control::Checklist(items) => {
            let items = items
                .iter()
                .map(|(key, label)| {
                    let on = bool_value(settings, key);
                    (*key, *label, on, set(key, !on))
                })
                .collect();
            row_shell(view, row, None, Some(checklist(view, items)), None)
        }
        Control::Button(label, action) => {
            let destructive = matches!(action, Act::DeleteProfile);
            let disabled = destructive && view.state.profile_order.len() <= 1;
            let primary = row.id == "general.defaultBrowser";
            let button =
                PushButton::new(SharedString::from(format!("button:{}", row.id)), label, p)
                    .when(destructive, |button| button.kind(ButtonKind::Destructive))
                    .when(primary, |button| button.kind(ButtonKind::Primary))
                    .disabled(disabled)
                    .on_click(view.emit.click(act(view, action)))
                    .into_any_element();
            row_shell(view, row, Some(button), None, None)
        }
        Control::Link(action) => row_shell(view, row, None, None, Some(act(view, action))),
        Control::Note => row_shell(view, row, None, None, None),
        Control::Custom(Custom::SearchControlled) => {
            crate::settings::general_subpages::search_controlled_row(view)
        }
        Control::Custom(Custom::AllowedPrograms) => {
            let shell = row_shell(view, row, None, None, None);
            div()
                .child(shell)
                .children(
                    crate::settings::general_subpages::approval_rows(view)
                        .into_iter()
                        .map(|approval| {
                            div()
                                .child(crate::primitives::list::divider(p, true, 12.))
                                .child(approval)
                        }),
                )
                .into_any_element()
        }
        Control::Custom(Custom::InstalledExtensions) => {
            let shell = row_shell(view, row, None, None, None);
            div()
                .child(shell)
                .children(selected_profile(view).map(|profile| {
                    crate::settings::subpages::installed_extensions_list(view, &profile)
                }))
                .into_any_element()
        }
        Control::Custom(Custom::Version) => row_shell(
            view,
            row,
            crate::settings::updates::check_now_control(view),
            Some(version_details(view)),
            None,
        ),
        Control::Custom(Custom::Buttons) => {
            row_shell(view, row, Some(buttons_checklist(view)), None, None)
        }
        Control::Custom(which) => row_shell(
            view,
            row,
            Some(custom_control(view, row, which)),
            None,
            None,
        ),
        Control::Cards(..) => div().into_any_element(),
    }
}

fn standalone(view: &SettingsWindowView, row: &'static Row) -> AnyElement {
    let settings = &view.state.settings;
    match row.control {
        Control::Cards(key, options) => {
            let current = match settings.get(key) {
                Some(Value::Bool(on)) => on.to_string(),
                Some(Value::String(text)) => text,
                _ => String::new(),
            };
            let is_bool = matches!(settings.get(key), Some(Value::Bool(_)));
            cards(view, row, true, &current, options, move |value| {
                if is_bool {
                    set(key, value == "true")
                } else {
                    set(key, value.to_owned())
                }
            })
        }
        Control::Custom(Custom::SyncSection) => div()
            .mt(px(SECTION_TOP))
            .child(sync_section(view))
            .into_any_element(),
        Control::Custom(Custom::ProfileBar) => profile_bar(view),
        Control::Custom(Custom::ProfileColour) => profile_colour(view, row),
        Control::Custom(Custom::TabLayout) => tab_layout(view, row),
        Control::Custom(Custom::AfterClosing) => after_closing(view, row),
        Control::Custom(Custom::CommandBarPlacement) => command_bar_placement(view, row),
        Control::Custom(Custom::ShortcutList) => shortcut_list(view),
        Control::Custom(Custom::PluginList) => plugin_list(view, row),
        Control::Custom(Custom::AppIcon) => app_icon_picker(view, row),
        _ => inline_row(view, row),
    }
}

pub fn clean_up_sheet(view: &SettingsWindowView, unit: &'static str, invalid: bool) -> AnyElement {
    use crate::primitives::sheets::{Dialog, dialog_actions, dialog_title};
    use crate::primitives::tokens::SheetSize;
    let p = view.look.p;
    let unit_label = DURATION_UNITS
        .iter()
        .find(|(key, _, _)| *key == unit)
        .map(|(_, label, _)| *label)
        .unwrap_or("Days");
    let units = DURATION_UNITS
        .iter()
        .map(|(key, label, _)| PopupItem {
            value: Some(SharedString::new_static(key)),
            label: SharedString::new_static(label),
            checked: *key == unit,
            msgs: vec![Msg::Command(SharedString::from(format!(
                "settings:cleanUpUnit:{key}"
            )))],
        })
        .collect();
    let cancel = view.emit.clone();
    Dialog::sheet("clean-up-sheet", SheetSize::S, &p)
        .on_dismiss(move |window, cx| {
            cancel.send(
                Msg::Command(SharedString::new_static("settings:sheetClose")),
                window,
                cx,
            )
        })
        .child(dialog_title(
            "Custom Clean Up Time",
            Some(SharedString::new_static("Close unused tabs after:")),
            None,
            &p,
        ))
        .child(
            div()
                .mt(px(12.))
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    crate::primitives::controls::field_box(&p)
                        .debug_selector(|| "clean-up-amount".into())
                        .h(px(22.))
                        .w(px(80.))
                        .child(div().flex_1().min_w_0().child(view.sheet_amount.clone())),
                )
                .child(popup(view, "cleanUpUnit", unit_label, 110., false, units)),
        )
        .when(invalid, |this| {
            this.child(
                div()
                    .debug_selector(|| "clean-up-invalid".into())
                    .mt(px(10.))
                    .text_size(px(11.))
                    .text_color(p.destructive)
                    .child("Enter a number above zero, up to 365 days."),
            )
        })
        .child(dialog_actions(
            None,
            None,
            [
                div()
                    .debug_selector(|| "clean-up-cancel".into())
                    .child(PushButton::new("clean-up-cancel", "Cancel", &p).on_click(
                        view.emit.click(Msg::Command(SharedString::new_static(
                            "settings:sheetClose",
                        ))),
                    ))
                    .into_any_element(),
                div()
                    .debug_selector(|| "clean-up-save".into())
                    .child(
                        PushButton::new("clean-up-save", "Save", &p)
                            .kind(ButtonKind::Primary)
                            .on_click(view.emit.click(Msg::Command(SharedString::new_static(
                                "settings:cleanUpSave",
                            )))),
                    )
                    .into_any_element(),
            ],
            &p,
        ))
        .into_any_element()
}

pub struct Block {
    pub rows: Vec<&'static str>,
    pub element: AnyElement,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Planned {
    Header(&'static str),
    Group(Vec<&'static Row>, bool),
    Alone(&'static Row, bool),
}

fn draws_own_header(row: &Row) -> bool {
    matches!(
        row.control,
        Control::Custom(
            Custom::SyncSection | Custom::ProfileBar | Custom::ProfileColour | Custom::PluginList
        )
    )
}

pub fn shown_rows(view: &SettingsWindowView, pane: Pane) -> Vec<&'static Row> {
    rows_for(pane)
        .filter(|row| row.shown_in(&view.state.settings, &view.system))
        .collect()
}

pub fn plan(settings: &Settings, system: &rows::System, pane: Pane) -> Vec<Planned> {
    let mut out = Vec::new();
    let mut section: Option<&'static str> = None;
    let mut pending: Vec<&'static Row> = Vec::new();
    let mut after_header = false;
    let flush =
        |pending: &mut Vec<&'static Row>, out: &mut Vec<Planned>, after_header: &mut bool| {
            if !pending.is_empty() {
                out.push(Planned::Group(std::mem::take(pending), !*after_header));
                *after_header = false;
            }
        };
    for row in rows_for(pane).filter(|row| row.shown_in(settings, system)) {
        if section != Some(row.section) {
            flush(&mut pending, &mut out, &mut after_header);
            section = Some(row.section);
            if !draws_own_header(row) {
                out.push(Planned::Header(row.section));
                after_header = true;
            }
        }
        if row.standalone() {
            flush(&mut pending, &mut out, &mut after_header);
            out.push(Planned::Alone(row, !after_header && !draws_own_header(row)));
            after_header = false;
        } else {
            pending.push(row);
        }
    }
    flush(&mut pending, &mut out, &mut after_header);
    out
}

fn section_detail(title: &str) -> Option<&'static str> {
    match title {
        "All profiles" => Some(
            "Each profile keeps its own history, logins, cookies and extensions, unless it was created to share another's data.",
        ),
        _ => None,
    }
}

pub fn block_index(
    settings: &Settings,
    system: &rows::System,
    pane: Pane,
    id: &str,
) -> Option<usize> {
    if pane == Pane::Automations {
        return crate::settings::automations::block_index(id);
    }
    plan(settings, system, pane)
        .iter()
        .position(|planned| match planned {
            Planned::Header(_) => false,
            Planned::Group(rows, _) => rows.iter().any(|row| row.id == id),
            Planned::Alone(row, _) => row.id == id,
        })
}

pub fn blocks(view: &SettingsWindowView, pane: Pane) -> Vec<Block> {
    if pane == Pane::Automations {
        return crate::settings::automations::blocks(view);
    }
    let p = view.look.p;
    let gap = |spaced: bool| px(if spaced { 16. } else { 0. });
    plan(&view.state.settings, &view.system, pane)
        .into_iter()
        .map(|planned| match planned {
            Planned::Header(title) => Block {
                rows: vec![],
                element: if pane == Pane::Profiles && title == "Extensions" {
                    crate::settings::subpages::extensions_header(view, title)
                } else {
                    section_header(
                        &p,
                        title,
                        section_detail(title)
                            .or_else(|| crate::settings::updates::header_detail(view, title)),
                    )
                },
            },
            Planned::Group(rows, spaced) => Block {
                rows: rows.iter().map(|row| row.id).collect(),
                element: div()
                    .mt(gap(spaced))
                    .child(group(
                        &p,
                        rows.into_iter()
                            .flat_map(|row| {
                                if row.id == "plugins.official" {
                                    return crate::settings::extras::official_rows(view);
                                }
                                if row.id == "plugins.cli" {
                                    return Vec::new();
                                }
                                if row.id == "advanced.automationRules" {
                                    return crate::settings::automations::automation_rule_rows(
                                        view,
                                    );
                                }
                                let mut shown = vec![inline_row(view, row)];
                                if row.id == "advanced.keepActiveSites" {
                                    shown.extend(kept_site_rows(view));
                                }
                                if row.id == "advanced.programs" {
                                    shown.extend(plugin_program_rows(view));
                                }
                                if row.id == "advanced.websiteEngines" {
                                    shown.extend(crate::settings::engines::extra_rows(view));
                                }
                                if row.id == "general.importBrowser" {
                                    shown.push(crate::settings::extras::setup_code_row(view));
                                }
                                match row.id {
                                    "profiles.icon" => shown
                                        .extend(crate::settings::profiles::shared_data_rows(view)),
                                    "profiles.syncThisProfile" => {
                                        shown.extend(crate::settings::profiles::sync_tab_rows(view))
                                    }
                                    "profiles.shareTopApps" => shown.extend(
                                        crate::settings::profiles::share_top_apps_rows(view),
                                    ),
                                    _ => {}
                                }
                                shown
                            })
                            .collect(),
                    ))
                    .into_any_element(),
            },
            Planned::Alone(row, spaced) => Block {
                rows: vec![row.id],
                element: div()
                    .mt(gap(spaced))
                    .child(standalone(view, row))
                    .into_any_element(),
            },
        })
        .collect()
}

pub fn content(view: &SettingsWindowView) -> Vec<Block> {
    if let Some(blocks) = crate::settings::subpages::blocks(view) {
        return blocks;
    }
    blocks(view, view.pane)
}

#[derive(Clone)]
pub struct KeyHit {
    pub id: &'static str,
    pub title: &'static str,
    pub keys: String,
    pub path: String,
}

pub fn key_hits(view: &SettingsWindowView) -> Vec<KeyHit> {
    key_hit_list(view).rows.clone()
}

pub(crate) fn key_hit_list(view: &SettingsWindowView) -> Rc<Listed<KeyHit>> {
    view.sub.memo.key_hits.get(
        (view.query.clone(), Memos::shortcut_inputs(&view.state)),
        |_| {
            Listed::new(
                resolve_key_hits(view),
                |hit| format!("settings-keys:{}", hit.id),
                |_| RESULT_ROW_ESTIMATE,
            )
        },
    )
}

const RESULT_ROW_ESTIMATE: f32 = 38.0;

fn resolve_key_hits(view: &SettingsWindowView) -> Vec<KeyHit> {
    let query = view.query.trim();
    let Some(combo) = ardia_state::shortcuts::Shortcut::parse_glyphs(query) else {
        return Vec::new();
    };
    let platform = Platform::current();
    let map = view.state.shortcut_map(platform);
    let keys = combo.format(platform);
    let paths = menu_paths();
    COMMANDS
        .iter()
        .filter(|spec| map.primary(spec.command.id()) == Some(&combo))
        .map(|spec| {
            let id = spec.command.id();
            let mut path = vec!["Shortcuts".to_owned()];
            path.extend(paths.get(id).cloned().unwrap_or_default());
            KeyHit {
                id,
                title: spec.title,
                keys: keys.clone(),
                path: path.join(" \u{203a} "),
            }
        })
        .collect()
}

pub fn result_rows(view: &SettingsWindowView) -> Vec<&'static Row> {
    result_list(view).rows.clone()
}

pub(crate) fn result_list(view: &SettingsWindowView) -> Rc<Listed<&'static Row>> {
    view.sub.memo.results.get(
        (
            view.query.clone(),
            SameArc(view.state.settings.clone()),
            view.system,
        ),
        |(query, settings, system)| {
            Listed::new(
                rows::search_in(query, &settings.0, system),
                |row| format!("settings-result:{}", row.id),
                |_| RESULT_ROW_ESTIMATE,
            )
        },
    )
}

pub fn all_open_tabs_state(synced: usize, all_tabs: usize) -> (bool, bool) {
    (synced > 0 && all_tabs == synced, all_tabs > 0 && all_tabs < synced)
}

pub fn what_syncs(view: &SettingsWindowView, synced: usize, all_tabs: usize) -> AnyElement {
    let p = view.look.p;
    let status = &view.sync_status;
    let tabs_on = status.data_types.get("tabs").copied().unwrap_or(false);
    let (on, mixed) = all_open_tabs_state(synced, all_tabs);
    let disabled = !tabs_on || synced == 0;
    let item = |key: &'static str, label: &'static str, checked: bool, mixed: bool, disabled: bool, command: String| {
        let emit = view.emit.clone();
        let command = SharedString::from(command);
        div()
            .debug_selector(move || format!("sync-type:{key}"))
            .line_height(px(16.))
            .child(
                crate::primitives::controls::Checkbox::new(
                    SharedString::from(format!("sync-type:{key}")),
                    checked,
                    label,
                    &p,
                )
                .mixed(mixed)
                .disabled(disabled)
                .on_toggle(move |_, window, cx| emit.send(Msg::Command(command.clone()), window, cx)),
            )
    };
    let items = SYNC_TYPES
        .iter()
        .map(|(key, label)| {
            let checked = status.data_types.get(*key).copied().unwrap_or(false);
            item(key, label, checked, false, false, format!("settings:syncType:{key}:{}", !checked))
        })
        .chain(std::iter::once(item(
            "allOpenTabs",
            "All open tabs, not just pinned ones",
            on,
            mixed,
            disabled,
            format!("settings:syncAllTabs:{}", !on),
        )));
    div()
        .min_h(px(ROW_MIN_HEIGHT))
        .px(px(ROW_PAD_X))
        .py(px(ROW_PAD_Y))
        .flex()
        .flex_col()
        .child(div().text_size(px(13.)).line_height(px(16.)).child("What syncs"))
        .child(div().mt(px(8.)).flex().flex_col().gap(px(6.)).children(items))
        .into_any_element()
}

pub const SYNC_TYPES: [(&str, &str); 7] = [
    ("bookmarks", "Bookmarks"),
    ("history", "History"),
    ("tabs", "Open Tabs"),
    ("pinned", "Pinned Tabs and Groups"),
    ("passwords", "Passwords"),
    ("extensions", "Extensions"),
    ("settings", "Settings"),
];

pub const INTERFACE_STEPS: [u32; 15] = [
    80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140, 145, 150,
];

pub fn interface_percent(scale: f64) -> u32 {
    if scale.is_finite() {
        (scale * 100.0).round().clamp(0.0, 1000.0) as u32
    } else {
        100
    }
}

fn interface_size(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let percent = interface_percent(view.state.settings.interface_scale);
    let open = view.scale_menu;
    div()
        .relative()
        .flex()
        .items_center()
        .gap(px(6.))
        .when(percent != 100, |this| {
            this.child(
                div()
                    .debug_selector(|| "interface-size-reset".into())
                    .child(
                        crate::primitives::controls::IconButton::new(
                            "interface-size-reset",
                            crate::primitives::icons::Icon::Undo,
                            &p,
                        )
                        .square(24., 6.)
                        .glyph(12.)
                        .tooltip("Back to 100%", &p)
                        .on_click(view.emit.click(set("interfaceScale", 1.0))),
                    ),
            )
        })
        .child(
            div().debug_selector(|| "interface-size".into()).child(
                crate::primitives::controls::PopUp::new(
                    "interface-size",
                    format!("{percent}%"),
                    &p,
                )
                .min_width(90.)
                .native(true)
                .on_click(pop_up_menu::opener(
                    &view.host,
                    &view.emit,
                    INTERFACE_STEPS
                        .iter()
                        .map(|step| {
                            PopUpChoice::new(
                                format!("{step}%"),
                                *step == percent,
                                vec![set("interfaceScale", f64::from(*step) / 100.0)],
                            )
                            .value(step.to_string())
                        })
                        .collect(),
                    Msg::Command(SharedString::new_static("settings:interfaceSizeMenu")),
                )),
            ),
        )
        .when(open, |this| {
            this.child(
                gpui::deferred(
                    crate::primitives::controls::popover("interface-size-menu", false, 110., &p)
                        .debug_selector(|| "interface-size-menu".into())
                        .absolute()
                        .top(px(24.))
                        .right_0()
                        .children(INTERFACE_STEPS.iter().map(|step| {
                            crate::primitives::controls::MenuRow::new(
                                SharedString::from(format!("interface-size:{step}")),
                                format!("{step}%"),
                                &p,
                            )
                            .checked(*step == percent)
                            .on_click({
                                let emit = view.emit.clone();
                                let step = *step;
                                move |_, window, cx| {
                                    emit.send(
                                        Msg::Command(SharedString::new_static(
                                            "settings:interfaceSizeMenu",
                                        )),
                                        window,
                                        cx,
                                    );
                                    emit.send(
                                        set("interfaceScale", f64::from(step) / 100.0),
                                        window,
                                        cx,
                                    );
                                }
                            })
                        })),
                )
                .with_priority(2),
            )
        })
        .into_any_element()
}

pub fn sync_section(view: &SettingsWindowView) -> AnyElement {
    crate::settings::sync_sheets::section(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_folders_read_from_home() {
        assert_eq!(
            home_relative("/Users/me/Downloads", Some("/Users/me")),
            "~/Downloads"
        );
        assert_eq!(home_relative("/Users/me", Some("/Users/me")), "~");
        assert_eq!(
            home_relative("/Users/meow/Downloads", Some("/Users/me")),
            "/Users/meow/Downloads"
        );
        let managed = crate::host::DownloadSettings {
            folder: "/Volumes/Work".into(),
            ask_where_to_save: false,
            managed: true,
        };
        assert_eq!(
            downloads_line(&managed),
            "/Volumes/Work, set by your organization."
        );
    }

    #[test]
    fn custom_clean_up_reads_like_the_old_sheet() {
        assert_eq!(duration_parts(1440), (1, "days"));
        assert_eq!(duration_parts(90), (90, "minutes"));
        assert_eq!(duration_parts(120), (2, "hours"));
        assert_eq!(duration_minutes("2", "hours"), Some(120));
        assert_eq!(duration_minutes("1.5", "hours"), Some(90));
        assert_eq!(duration_minutes("0", "days"), None);
        assert_eq!(duration_minutes("366", "days"), None);
        assert_eq!(duration_minutes("-1", "days"), None);
        assert_eq!(duration_minutes("1e3", "days"), None);
        let choices: Vec<String> = clean_up_choices(&Settings::default())
            .into_iter()
            .map(|(_, title)| title)
            .collect();
        assert_eq!(
            choices,
            [
                "Never",
                "12 hours",
                "Custom…",
                "24 hours",
                "7 days",
                "30 days"
            ]
        );
    }

    #[test]
    fn dropping_a_profile_moves_it_to_the_target_slot() {
        let order: Vec<ProfileId> = ["a", "b", "c"].iter().map(|id| ProfileId::new(*id)).collect();
        let names = |order: Vec<ProfileId>| order.iter().map(|id| id.to_string()).collect::<Vec<_>>();
        assert_eq!(names(reordered(&order, "c", "a").expect("moved")), ["c", "a", "b"]);
        assert_eq!(names(reordered(&order, "a", "c").expect("moved")), ["b", "c", "a"]);
        assert!(reordered(&order, "b", "b").is_none());
        assert!(reordered(&order, "x", "b").is_none());
    }

    #[test]
    fn mouse_shortcuts_read_like_the_old_titles() {
        let platform = Platform::Mac;
        let plain: Vec<String> = vec!["mouse:middle".into()];
        assert_eq!(mouse_title(&plain, platform).as_deref(), Some("Middle Click"));
        let with: Vec<String> = vec!["mouse:4".into(), "command".into()];
        assert_eq!(mouse_title(&with, platform).as_deref(), Some("⌘ Mouse Button 4"));
        assert!(mouse_title(&["t".to_owned()], platform).is_none());
    }

    #[test]
    fn sliders_snap_to_their_steps() {
        assert_eq!(snap(4.4, 0.0, 12.0, 1.0), 4.0);
        assert_eq!(snap(13.0, 0.0, 12.0, 1.0), 12.0);
        assert_eq!(snap(1.0333, 0.8, 1.5, 0.05), 1.05);
        assert_eq!(snap(-3.0, 0.8, 1.5, 0.05), 0.8);
    }

    #[test]
    fn all_open_tabs_is_mixed_when_some_profiles_sync_every_tab() {
        assert_eq!(all_open_tabs_state(0, 0), (false, false));
        assert_eq!(all_open_tabs_state(3, 0), (false, false));
        assert_eq!(all_open_tabs_state(3, 1), (false, true));
        assert_eq!(all_open_tabs_state(3, 3), (true, false));
    }

}
