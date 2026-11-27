use crate::scale::px;
use ardia_state::engines::{
    PROTECTED_VIDEO_SITES, RECOMMENDED_ENGINE, default_engine, engine_mode_footer, engine_name,
    rule_site_from_input, site_label, streaming_sites_description, with_website_engine,
};
use ardia_state::model::PageEngine;
use ardia_state::settings::{EngineMode, Settings, SettingsPatch};
use gpui::{
    AnyElement, Context, FontWeight, IntoElement, ParentElement, SharedString, Styled, Window, div,
    prelude::*,
};

use crate::msg::Msg;
use crate::primitives::controls::{
    ButtonKind, IconButton, MenuRow, PushButton, Segmented, popover,
};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::list::{Row, group};
use crate::primitives::tokens::{line_height, space, type_size};
use crate::settings::SettingsWindowView;
use crate::settings::panes::{self, POPUP_HEIGHT, PopupItem};
use crate::settings::subpages::{self, COMMAND, Sheet};

pub const PREFIX: &str = "engines:";
pub const ABOUT_ENGINES_TITLE: &str = "About Engines";
pub const AUTOMATIC: &str = "Automatic opens most sites in Chromium, where every extension and the full ad blocker run. Netflix and other sites whose video needs FairPlay (Apple's DRM) open in WebKit.";
pub const PASSKEYS_WAITING: &str = "WebKit pages can't use passkeys until Apple grants Ardia its browser passkey entitlement. Sign in with a passkey in Chromium meanwhile.";
pub const PASSKEYS_AUTHORIZED: &str =
    "Websites can use the passkeys saved on this Mac, in WebKit and Chromium pages.";
pub const RULE_ERROR: &str = "Enter a website address, like netflix.com.";
pub const RULE_SUBTITLE: &str = "A rule matches the site's address exactly: its scheme, host and port. Subdomains need their own rule.";
pub const SHOWN_STREAMING_SITES: usize = 5;
pub const LIMIT_LABEL_WIDTH: f32 = 176.0;
pub const PAGE_ENGINE_MIN_WIDTH: f32 = 190.0;
pub const RULE_ENGINE_MIN_WIDTH: f32 = 110.0;
pub const SHEET_POPUP_MIN_WIDTH: f32 = 120.0;
pub const STREAMING_ICON: f32 = 14.0;
pub const STREAMING_ICON_BOX: f32 = 20.0;

pub const MODES: [(EngineMode, &str); 3] = [
    (EngineMode::Automatic, "Automatic"),
    (EngineMode::Chromium, "Chromium"),
    (EngineMode::Webkit, "WebKit"),
];

pub const ENGINES: [PageEngine; 2] = [PageEngine::Chromium, PageEngine::Webkit];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limit {
    pub label: &'static str,
    pub detail: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LimitGroup {
    pub title: &'static str,
    pub limits: &'static [Limit],
    pub only_while_blocking: bool,
}

pub const PASSKEYS: Limit = Limit {
    label: "Passkeys",
    detail: "No passkeys or security keys",
};

pub const WEBKIT_LIMITS: [LimitGroup; 3] = [
    LimitGroup {
        title: "WebKit Pages",
        limits: &[
            Limit {
                label: "Picture in Picture",
                detail: "Videos only",
            },
            PASSKEYS,
            Limit {
                label: "Client Hints",
                detail: "Sites see Safari's browser details",
            },
            Limit {
                label: "Web MIDI and Casting",
                detail: "Not supported",
            },
            Limit {
                label: "Offline Data",
                detail: "Kept per engine, so some apps sign out",
            },
        ],
        only_while_blocking: false,
    },
    LimitGroup {
        title: "WebKit Extensions",
        limits: &[Limit {
            label: "Extensions",
            detail: "Not supported",
        }],
        only_while_blocking: false,
    },
    LimitGroup {
        title: "WebKit Ad Blocking",
        limits: &[Limit {
            label: "uBlock Filters",
            detail: "No stand-ins, removeparam, headers",
        }],
        only_while_blocking: true,
    },
];

pub fn shown_limits(passkeys_work: bool, blocking_off: bool) -> Vec<(&'static str, Vec<Limit>)> {
    WEBKIT_LIMITS
        .iter()
        .filter(|group| !(group.only_while_blocking && blocking_off))
        .map(|group| {
            let limits = group
                .limits
                .iter()
                .copied()
                .filter(|limit| !(passkeys_work && *limit == PASSKEYS))
                .collect();
            (group.title, limits)
        })
        .collect()
}

pub fn engine_options(recommended: bool) -> Vec<(PageEngine, String)> {
    ENGINES
        .iter()
        .map(|engine| {
            let name = engine_name(*engine);
            let title = if recommended && *engine == RECOMMENDED_ENGINE {
                format!("{name} (recommended)")
            } else {
                name.to_owned()
            };
            (*engine, title)
        })
        .collect()
}

pub fn engine_key(engine: PageEngine) -> &'static str {
    match engine {
        PageEngine::Chromium => "chromium",
        PageEngine::Webkit => "webkit",
    }
}

pub fn parse_engine(key: &str) -> Option<PageEngine> {
    match key {
        "chromium" => Some(PageEngine::Chromium),
        "webkit" => Some(PageEngine::Webkit),
        _ => None,
    }
}

pub fn mode_key(mode: EngineMode) -> &'static str {
    match mode {
        EngineMode::Automatic => "automatic",
        EngineMode::Chromium => "chromium",
        EngineMode::Webkit => "webkit",
    }
}

fn parse_mode(key: &str) -> Option<EngineMode> {
    MODES
        .iter()
        .map(|(mode, _)| *mode)
        .find(|mode| mode_key(*mode) == key)
}

pub fn command(rest: impl AsRef<str>) -> String {
    format!("{COMMAND}{PREFIX}{}", rest.as_ref())
}

fn msg(rest: impl AsRef<str>) -> Msg {
    Msg::Command(SharedString::from(command(rest)))
}

pub fn sorted_sites(settings: &Settings) -> Vec<(String, PageEngine)> {
    let mut sites: Vec<(String, PageEngine)> = settings
        .website_engines
        .iter()
        .map(|(site, engine)| (site.clone(), *engine))
        .collect();
    sites.sort_by(|(a, _), (b, _)| site_label(a).cmp(site_label(b)));
    sites
}

pub fn website_engines_patch(
    settings: &Settings,
    url: &str,
    engine: Option<PageEngine>,
) -> Option<SettingsPatch> {
    let rules = with_website_engine(&settings.website_engines, url, engine)?;
    let value = serde_json::to_value(rules).ok()?;
    Some(SettingsPatch::new().set("websiteEngines", value))
}

pub fn rule_save_patch(
    settings: &Settings,
    editing: Option<&str>,
    typed: &str,
    engine: PageEngine,
) -> Result<SettingsPatch, &'static str> {
    let target = rule_site_from_input(typed).ok_or(RULE_ERROR)?;
    let mut rules = settings.website_engines.clone();
    if let Some(site) = editing.filter(|site| *site != target) {
        rules.shift_remove(site);
    }
    rules.insert(target, engine);
    let value = serde_json::to_value(rules).map_err(|_| RULE_ERROR)?;
    Ok(SettingsPatch::new().set("websiteEngines", value))
}

pub fn shown_mode(view: &SettingsWindowView) -> EngineMode {
    if view.host.engine_mode_switching() {
        view.sub
            .engine_pending
            .unwrap_or(view.state.settings.engine_mode)
    } else {
        view.state.settings.engine_mode
    }
}

pub fn mode_footer(view: &SettingsWindowView) -> String {
    let settings = &view.state.settings;
    engine_mode_footer(
        shown_mode(view),
        view.host.engine_mode_switching(),
        default_engine(settings),
        settings.protected_video_in_webkit,
    )
}

fn icon_button(
    view: &SettingsWindowView,
    id: impl Into<SharedString>,
    glyph: Icon,
    tooltip: &'static str,
    on: Msg,
) -> AnyElement {
    let p = view.look.p;
    let id: SharedString = id.into();
    let selector = id.clone();
    div()
        .debug_selector(move || selector.to_string())
        .child(
            IconButton::new(gpui::ElementId::Name(id), glyph, &p)
                .square(22., 5.)
                .glyph(12.)
                .tooltip(tooltip, &p)
                .on_click(view.emit.click(on)),
        )
        .into_any_element()
}

fn tagged(id: impl Into<SharedString>, child: impl IntoElement) -> AnyElement {
    let id: SharedString = id.into();
    div()
        .debug_selector(move || id.to_string())
        .child(child)
        .into_any_element()
}

fn engine_popup(
    view: &SettingsWindowView,
    id: SharedString,
    current: PageEngine,
    options: Vec<(PageEngine, String)>,
    min_width: f32,
    pick: impl Fn(PageEngine) -> Msg,
) -> AnyElement {
    let p = view.look.p;
    let label = options
        .iter()
        .find(|(engine, _)| *engine == current)
        .map(|(_, title)| title.clone())
        .unwrap_or_default();
    let items: Vec<PopupItem> = options
        .iter()
        .map(|(engine, title)| PopupItem {
            value: Some(SharedString::new_static(engine_key(*engine))),
            label: SharedString::from(title.clone()),
            checked: *engine == current,
            msgs: vec![pick(*engine)],
        })
        .collect();
    let open = view.menu.as_ref() == Some(&id);
    let selector = id.clone();
    let menu_selector = id.clone();
    div()
        .relative()
        .child(
            div()
                .debug_selector(move || format!("popup:{selector}"))
                .child(
                    crate::primitives::controls::PopUp::new(
                        SharedString::from(format!("popup:{id}")),
                        label,
                        &p,
                    )
                    .min_width(min_width)
                    .native(true)
                    .on_click(crate::primitives::pop_up_menu::opener(
                        &view.host,
                        &view.emit,
                        panes::pop_up_choices(&items),
                        Msg::Command(panes::menu_command(&id)),
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
                    .debug_selector(move || format!("popup-menu:{menu_selector}"))
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

fn controls(children: Vec<AnyElement>) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::L))
        .children(children)
        .into_any_element()
}

pub fn engine_mode_control(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let switching = view.host.engine_mode_switching();
    let current = shown_mode(view);
    let selected = MODES
        .iter()
        .position(|(mode, _)| *mode == current)
        .unwrap_or(0);
    let emit = view.emit.clone();
    let segmented = MODES
        .iter()
        .fold(
            Segmented::new("choice:engineMode", selected, &p),
            |control, (_, label)| control.option(*label, None),
        )
        .on_select(move |index, window, cx| {
            if switching {
                return;
            }
            if let Some((mode, _)) = MODES.get(index) {
                emit.send(msg(format!("mode:{}", mode_key(*mode))), window, cx);
            }
        });
    controls(vec![
        tagged("engine-mode", segmented),
        icon_button(
            view,
            "engine-mode-about",
            Icon::Info,
            ABOUT_ENGINES_TITLE,
            msg("limits"),
        ),
    ])
}

pub fn page_engine_control(view: &SettingsWindowView) -> AnyElement {
    let current = default_engine(&view.state.settings);
    engine_popup(
        view,
        SharedString::new_static("pageEngine"),
        current,
        engine_options(true),
        PAGE_ENGINE_MIN_WIDTH,
        |engine| panes::set("pageEngine", engine_key(engine)),
    )
}

pub fn website_engines_control(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let mut children = Vec::new();
    if !view.state.settings.protected_video_in_webkit {
        children.push(tagged(
            "engine-add-streaming",
            PushButton::new("engine-add-streaming", "Add Streaming Sites", &p)
                .on_click(view.emit.click(panes::set("protectedVideoInWebKit", true))),
        ));
    }
    children.push(tagged(
        "engine-add-rule",
        PushButton::new("engine-add-rule", "Add Rule…", &p)
            .icon(Icon::Plus)
            .on_click(view.emit.click(msg("ruleNew"))),
    ));
    controls(children)
}

pub fn extra_rows(view: &SettingsWindowView) -> Vec<AnyElement> {
    let settings = &view.state.settings;
    if settings.engine_mode != EngineMode::Automatic {
        return Vec::new();
    }
    let p = view.look.p;
    let mut rows = Vec::new();
    if settings.protected_video_in_webkit {
        rows.push(
            Row::new("engine-streaming-sites", &p)
                .native(true)
                .icon(
                    div()
                        .flex_none()
                        .size(px(STREAMING_ICON_BOX))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon(Icon::PlayTv, STREAMING_ICON, p.icon)),
                )
                .title("Streaming sites")
                .description(streaming_sites_description(SHOWN_STREAMING_SITES))
                .child(
                    div()
                        .text_size(px(type_size::BODY))
                        .text_color(p.text_secondary)
                        .child(engine_name(PageEngine::Webkit)),
                )
                .child(icon_button(
                    view,
                    "engine-streaming-remove",
                    Icon::Trash,
                    "Remove",
                    panes::set("protectedVideoInWebKit", false),
                ))
                .into_any_element(),
        );
    }
    for (site, engine) in sorted_sites(settings) {
        let popup_site = site.clone();
        rows.push(
            Row::new(SharedString::from(format!("engine-rule:{site}")), &p)
                .native(true)
                .icon(site_icon(view, &site))
                .title(site_label(&site).to_owned())
                .child(engine_popup(
                    view,
                    SharedString::from(format!("engineRule:{site}")),
                    engine,
                    engine_options(false),
                    RULE_ENGINE_MIN_WIDTH,
                    move |engine| msg(format!("siteEngine:{}:{popup_site}", engine_key(engine))),
                ))
                .child(icon_button(
                    view,
                    format!("engine-rule-edit:{site}"),
                    Icon::Pencil,
                    "Edit",
                    msg(format!("ruleEdit:{site}")),
                ))
                .child(icon_button(
                    view,
                    format!("engine-rule-remove:{site}"),
                    Icon::Trash,
                    "Remove",
                    msg(format!("siteRemove:{site}")),
                ))
                .into_any_element(),
        );
    }
    rows
}

fn site_icon(view: &SettingsWindowView, site: &str) -> AnyElement {
    let p = view.look.p;
    let profile = panes::default_profile(view);
    let favicon = match view.host.page_favicon(&profile, site) {
        Some(image) => crate::primitives::favicon::Favicon::Image(image),
        None => crate::primitives::favicon::favicon_of(site, None, None, ""),
    };
    div()
        .flex_none()
        .size(px(16.))
        .flex()
        .items_center()
        .justify_center()
        .child(crate::primitives::favicon::render_favicon(
            &favicon, 16., &p,
        ))
        .into_any_element()
}

fn set_site(view: &SettingsWindowView, site: &str, engine: Option<PageEngine>) {
    if let Some(patch) = website_engines_patch(&view.state.settings, site, engine) {
        view.host.dispatch(ardia_state::Action::UpdateSettings {
            patch,
            from_sync: false,
        });
    }
}

pub fn open_rule_sheet(
    view: &mut SettingsWindowView,
    site: Option<String>,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let engine = site
        .as_ref()
        .and_then(|site| view.state.settings.website_engines.get(site).copied())
        .unwrap_or(PageEngine::Webkit);
    let text = site
        .as_deref()
        .map(|site| site_label(site).to_owned())
        .unwrap_or_default();
    subpages::open_sheet(
        view,
        Sheet::EngineRule {
            site,
            engine,
            error: None,
        },
        &[("netflix.com", text)],
        window,
        cx,
    );
}

pub fn save_rule(
    view: &mut SettingsWindowView,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(Sheet::EngineRule { site, engine, .. }) = view.sub.sheet.clone() else {
        return;
    };
    let typed = subpages::field_text(view, 0, cx);
    match rule_save_patch(&view.state.settings, site.as_deref(), &typed, engine) {
        Ok(patch) => {
            view.host.dispatch(ardia_state::Action::UpdateSettings {
                patch,
                from_sync: false,
            });
            subpages::close_sheet(view, window, cx);
        }
        Err(message) => {
            if let Some(Sheet::EngineRule { error, .. }) = view.sub.sheet.as_mut() {
                *error = Some(message);
            }
            cx.notify();
        }
    }
}

fn open_info_sheet(
    view: &mut SettingsWindowView,
    sheet: Sheet,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    subpages::open_sheet(view, sheet, &[], window, cx);
}

pub fn run(
    view: &mut SettingsWindowView,
    rest: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) -> bool {
    let Some(rest) = rest.strip_prefix(PREFIX) else {
        return false;
    };
    if let Some(mode) = rest.strip_prefix("mode:").and_then(parse_mode) {
        if !view.host.engine_mode_switching() && mode != view.state.settings.engine_mode {
            view.sub.engine_pending = Some(mode);
            view.host.set_engine_mode(mode);
        }
    } else if rest == "passkeysAllow" {
        view.host.request_webkit_passkey_access();
    } else if rest == "passkeysSettings" {
        cx.open_url(PASSKEYS_SETTINGS_URL);
    } else if rest == "limits" || rest == "limitsPane" {
        ardia_telemetry::counts::count(if rest == "limits" {
            "webkit_limits_opens_engine_row"
        } else {
            "webkit_limits_opens_engines_pane"
        });
        open_info_sheet(view, Sheet::WebKitLimits, window, cx);
    } else if rest == "differ" {
        open_info_sheet(view, Sheet::EnginesDiffer, window, cx);
    } else if rest == "ruleNew" {
        open_rule_sheet(view, None, window, cx);
    } else if let Some(site) = rest.strip_prefix("ruleEdit:") {
        open_rule_sheet(view, Some(site.to_owned()), window, cx);
    } else if let Some(engine) = rest.strip_prefix("ruleEngine:").and_then(parse_engine) {
        if let Some(Sheet::EngineRule { engine: chosen, .. }) = view.sub.sheet.as_mut() {
            *chosen = engine;
        }
    } else if rest == "ruleSave" {
        save_rule(view, window, cx);
    } else if rest == "ruleRemove" {
        if let Some(Sheet::EngineRule {
            site: Some(site), ..
        }) = view.sub.sheet.clone()
        {
            set_site(view, &site, None);
        }
        subpages::close_sheet(view, window, cx);
    } else if let Some(rest) = rest.strip_prefix("siteEngine:") {
        if let Some((engine, site)) = rest.split_once(':')
            && let Some(engine) = parse_engine(engine)
        {
            set_site(view, site, Some(engine));
        }
    } else if let Some(site) = rest.strip_prefix("siteRemove:") {
        set_site(view, site, None);
    } else {
        return false;
    }
    cx.notify();
    true
}

fn close_msg() -> Msg {
    Msg::Command(SharedString::from(format!("{COMMAND}sheetClose")))
}

fn done_button(view: &SettingsWindowView, id: &'static str) -> AnyElement {
    tagged(
        id,
        PushButton::new(id, "Done", &view.look.p)
            .kind(ButtonKind::Primary)
            .on_click(view.emit.click(close_msg())),
    )
}

fn dismiss(view: &SettingsWindowView) -> impl Fn(&mut Window, &mut gpui::App) + 'static {
    let close = view.emit.clone();
    move |window, cx| close.send(close_msg(), window, cx)
}

pub fn rule_sheet(
    view: &SettingsWindowView,
    site: Option<&str>,
    engine: PageEngine,
    error: Option<&'static str>,
) -> AnyElement {
    use crate::primitives::sheets::{Dialog, dialog_actions, dialog_title};
    use crate::primitives::tokens::SheetSize;
    let p = view.look.p;
    let field = view.sub.fields.first().cloned();
    let remove = site.map(|_| {
        tagged(
            "engine-rule-sheet-remove",
            PushButton::new("engine-rule-sheet-remove", "Remove", &p)
                .kind(ButtonKind::Destructive)
                .on_click(view.emit.click(msg("ruleRemove"))),
        )
    });
    Dialog::sheet("engine-rule-sheet", SheetSize::M, &p)
        .on_dismiss(dismiss(view))
        .child(dialog_title(
            if site.is_some() {
                "Edit Rule"
            } else {
                "Add Rule"
            },
            Some(SharedString::new_static(RULE_SUBTITLE)),
            None,
            &p,
        ))
        .child(
            div()
                .mt(px(space::L))
                .child(
                    div()
                        .mb(px(space::XS))
                        .text_size(px(type_size::CAPTION))
                        .line_height(px(line_height::CAPTION))
                        .text_color(p.text_secondary)
                        .child("Website"),
                )
                .child(
                    crate::primitives::controls::field_box(&p)
                        .debug_selector(|| "engine-rule-field".into())
                        .h(px(22.))
                        .child(div().flex_1().min_w_0().children(field)),
                ),
        )
        .child(
            div()
                .mt(px(space::L))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(space::ML))
                .child(
                    div()
                        .text_size(px(type_size::CAPTION))
                        .line_height(px(line_height::CAPTION))
                        .text_color(p.text_secondary)
                        .child("Opens in"),
                )
                .child(engine_popup(
                    view,
                    SharedString::new_static("engineRuleSheet"),
                    engine,
                    engine_options(false),
                    SHEET_POPUP_MIN_WIDTH,
                    |engine| msg(format!("ruleEngine:{}", engine_key(engine))),
                )),
        )
        .when_some(error, |this, error| {
            this.child(
                div()
                    .debug_selector(|| "engine-rule-error".into())
                    .mt(px(space::ML))
                    .text_size(px(type_size::CAPTION))
                    .line_height(px(line_height::CAPTION))
                    .text_color(p.destructive)
                    .child(error),
            )
        })
        .child(dialog_actions(
            remove,
            None,
            [
                tagged(
                    "engine-rule-sheet-cancel",
                    PushButton::new("engine-rule-sheet-cancel", "Cancel", &p)
                        .on_click(view.emit.click(close_msg())),
                ),
                tagged(
                    "engine-rule-sheet-save",
                    PushButton::new(
                        "engine-rule-sheet-save",
                        if site.is_some() { "Save" } else { "Add" },
                        &p,
                    )
                    .kind(ButtonKind::Primary)
                    .on_click(view.emit.click(msg("ruleSave"))),
                ),
            ],
            &p,
        ))
        .into_any_element()
}

pub const PASSKEYS_NOT_CONFIGURED: &str = "Passkeys aren't set up on this Mac. Set up iCloud Keychain or another passkey app in System Settings, then reopen Ardia.";
pub const PASSKEYS_NOT_DETERMINED: &str = "Allow Ardia to use the passkeys saved on this Mac, from the Passwords app and other passkey apps, in WebKit and Chromium pages.";
pub const PASSKEYS_DENIED: &str = "Off. Turn Ardia on in System Settings › Privacy & Security › Passkeys Access for Web Browsers.";
pub const PASSKEYS_ALLOW: &str = "Allow Passkeys…";
pub const PASSKEYS_OPEN_SETTINGS: &str = "Open System Settings";
pub const PASSKEYS_SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.preference.security";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PasskeyStatus {
    #[default]
    EntitlementRequired,
    DeviceNotConfigured,
    NotDetermined,
    Authorized,
    Denied,
}

impl PasskeyStatus {
    pub fn wire(self) -> &'static str {
        match self {
            PasskeyStatus::EntitlementRequired => "entitlementRequired",
            PasskeyStatus::DeviceNotConfigured => "deviceNotConfigured",
            PasskeyStatus::NotDetermined => "notDetermined",
            PasskeyStatus::Authorized => "authorized",
            PasskeyStatus::Denied => "denied",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PasskeyAccess {
    pub entitled: bool,
    pub status: PasskeyStatus,
}

impl PasskeyAccess {
    pub const AUTHORIZED: PasskeyAccess = PasskeyAccess {
        entitled: true,
        status: PasskeyStatus::Authorized,
    };
}

pub fn passkey_status_description(access: PasskeyAccess, waiting: &'static str) -> &'static str {
    if !access.entitled {
        return waiting;
    }
    match access.status {
        PasskeyStatus::DeviceNotConfigured => PASSKEYS_NOT_CONFIGURED,
        PasskeyStatus::NotDetermined => PASSKEYS_NOT_DETERMINED,
        PasskeyStatus::Authorized => PASSKEYS_AUTHORIZED,
        PasskeyStatus::Denied => PASSKEYS_DENIED,
        PasskeyStatus::EntitlementRequired => waiting,
    }
}

pub fn passkey_button(access: PasskeyAccess) -> Option<&'static str> {
    if !access.entitled {
        return None;
    }
    match access.status {
        PasskeyStatus::NotDetermined => Some(PASSKEYS_ALLOW),
        PasskeyStatus::Denied => Some(PASSKEYS_OPEN_SETTINGS),
        _ => None,
    }
}

pub fn passkey_description(entitled: bool) -> &'static str {
    if entitled {
        PASSKEYS_AUTHORIZED
    } else {
        PASSKEYS_WAITING
    }
}

pub fn passkey_row(
    view: &SettingsWindowView,
    id: &'static str,
    title: &'static str,
    waiting: &'static str,
) -> AnyElement {
    let p = view.look.p;
    let access = view.host.webkit_passkey_access();
    let mut row = Row::new(id, &p)
        .native(true)
        .title(title)
        .description(passkey_status_description(access, waiting));
    if let Some(label) = passkey_button(access) {
        let (button_id, command) = if label == PASSKEYS_ALLOW {
            ("passkeys-allow", "passkeysAllow")
        } else {
            ("passkeys-settings", "passkeysSettings")
        };
        row = row.child(tagged(
            button_id,
            PushButton::new(button_id, label, &p)
                .disabled(label == PASSKEYS_ALLOW && view.host.webkit_passkey_requesting())
                .on_click(view.emit.click(msg(command))),
        ));
    }
    row.into_any_element()
}

pub fn differ_sheet(view: &SettingsWindowView) -> AnyElement {
    use crate::primitives::sheets::{Dialog, dialog_actions, dialog_title};
    use crate::primitives::tokens::SheetSize;
    let p = view.look.p;
    let rows =
        vec![
        Row::new("engines-differ-sign-ins", &p)
            .native(true)
            .title("Separate sign-ins")
            .description(
                "Each engine keeps its own cookies; Bring sign-ins along copies them on switch.",
            )
            .into_any_element(),
        passkey_row(view, "engines-differ-passkeys", "Passkeys", PASSKEYS_WAITING),
        tagged(
            "engines-differ-about",
            Row::new("engines-differ-about", &p)
                .native(true)
                .title(ABOUT_ENGINES_TITLE)
                .description("How Automatic picks an engine, and what WebKit pages can't do.")
                .on_click(view.emit.click(msg("limitsPane"))),
        ),
    ];
    Dialog::sheet("engines-differ-sheet", SheetSize::L, &p)
        .on_dismiss(dismiss(view))
        .child(dialog_title(
            "How engines differ",
            Some(SharedString::new_static(
                "Every page opens in Chromium or WebKit. Here's what changes between them.",
            )),
            None,
            &p,
        ))
        .child(div().mt(px(space::M)).child(group(&p, rows)))
        .child(dialog_actions(
            None,
            None,
            [done_button(view, "engines-differ-done")],
            &p,
        ))
        .into_any_element()
}

pub fn blocking_off(view: &SettingsWindowView) -> bool {
    view.host
        .content_blocker()
        .is_some_and(|blocker| !blocker.enabled)
}

pub fn limits_sheet(view: &SettingsWindowView) -> AnyElement {
    use crate::primitives::sheets::{Dialog, dialog_actions, dialog_title};
    use crate::primitives::tokens::SheetSize;
    let p = view.look.p;
    let groups = shown_limits(
        view.host.webkit_passkey_access().entitled,
        blocking_off(view),
    );
    let sections = groups.into_iter().map(|(title, limits)| {
        div()
            .debug_selector(move || format!("webkit-limits:{title}"))
            .child(
                div()
                    .mb(px(space::S))
                    .text_size(px(type_size::SMALL))
                    .line_height(px(line_height::SMALL))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.text_secondary)
                    .child(title),
            )
            .children(limits.into_iter().map(|limit| {
                div()
                    .flex()
                    .flex_row()
                    .py(px(space::XS))
                    .child(
                        div()
                            .flex_none()
                            .w(px(LIMIT_LABEL_WIDTH))
                            .text_size(px(type_size::BODY))
                            .line_height(px(line_height::BODY))
                            .text_color(p.text)
                            .child(limit.label),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(type_size::BODY))
                            .line_height(px(line_height::BODY))
                            .text_color(p.text_secondary)
                            .child(limit.detail),
                    )
            }))
    });
    Dialog::sheet("webkit-limits-sheet", SheetSize::L, &p)
        .on_dismiss(dismiss(view))
        .child(dialog_title(ABOUT_ENGINES_TITLE, None, None, &p))
        .child(
            div()
                .id("webkit-limits-list")
                .mt(px(space::L))
                .flex_shrink(1.)
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(space::XXL))
                .pb(px(space::XS))
                .child(
                    div()
                        .text_size(px(type_size::BODY))
                        .line_height(px(line_height::PROSE_BODY))
                        .text_color(p.text)
                        .child(AUTOMATIC),
                )
                .children(sections),
        )
        .child(dialog_actions(
            None,
            None,
            [done_button(view, "webkit-limits-done")],
            &p,
        ))
        .into_any_element()
}

pub fn protected_video_sites() -> &'static [&'static str] {
    PROTECTED_VIDEO_SITES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_drop_passkeys_and_ad_blocking_like_the_old_sheet() {
        let all = shown_limits(false, false);
        assert_eq!(
            all.iter().map(|(title, _)| *title).collect::<Vec<_>>(),
            ["WebKit Pages", "WebKit Extensions", "WebKit Ad Blocking"]
        );
        assert!(all[0].1.contains(&PASSKEYS));
        let entitled = shown_limits(true, false);
        assert!(!entitled[0].1.contains(&PASSKEYS));
        assert_eq!(entitled[0].1.len(), 4);
        let off = shown_limits(false, true);
        assert_eq!(off.len(), 2);
        assert!(off.iter().all(|(title, _)| *title != "WebKit Ad Blocking"));
    }

    #[test]
    fn rule_sheet_saves_renames_and_rejects_like_the_old_one() {
        let mut settings = Settings::default();
        assert_eq!(
            rule_save_patch(&settings, None, "not a site", PageEngine::Webkit).err(),
            Some(RULE_ERROR)
        );
        assert_eq!(
            rule_save_patch(&settings, None, "  ", PageEngine::Webkit).err(),
            Some(RULE_ERROR)
        );
        let patch = rule_save_patch(&settings, None, "netflix.com", PageEngine::Webkit).unwrap();
        assert_eq!(
            patch.0,
            vec![(
                "websiteEngines".to_owned(),
                serde_json::json!({"https://netflix.com": "webkit"})
            )]
        );
        settings
            .website_engines
            .insert("https://a.com".into(), PageEngine::Webkit);
        settings
            .website_engines
            .insert("https://z.com".into(), PageEngine::Chromium);
        let renamed = rule_save_patch(
            &settings,
            Some("https://a.com"),
            "b.com",
            PageEngine::Chromium,
        )
        .unwrap();
        assert_eq!(
            renamed.0[0].1,
            serde_json::json!({"https://z.com": "chromium", "https://b.com": "chromium"})
        );
        let removed = website_engines_patch(&settings, "https://a.com", None).unwrap();
        assert_eq!(
            removed.0[0].1,
            serde_json::json!({"https://z.com": "chromium"})
        );
    }

    #[test]
    fn sites_sort_by_their_label_and_options_name_the_recommended_engine() {
        let mut settings = Settings::default();
        settings
            .website_engines
            .insert("https://zed.dev".into(), PageEngine::Webkit);
        settings
            .website_engines
            .insert("http://apple.com".into(), PageEngine::Chromium);
        settings
            .website_engines
            .insert("https://b.com".into(), PageEngine::Chromium);
        let order: Vec<String> = sorted_sites(&settings)
            .into_iter()
            .map(|(s, _)| s)
            .collect();
        assert_eq!(
            order,
            ["https://b.com", "http://apple.com", "https://zed.dev"]
        );
        assert_eq!(
            engine_options(true)
                .into_iter()
                .map(|(_, t)| t)
                .collect::<Vec<_>>(),
            ["Chromium (recommended)", "WebKit"]
        );
        assert_eq!(passkey_description(false), PASSKEYS_WAITING);
        let access = |status| PasskeyAccess {
            entitled: true,
            status,
        };
        assert_eq!(
            passkey_status_description(PasskeyAccess::default(), PASSKEYS_WAITING),
            PASSKEYS_WAITING
        );
        assert_eq!(
            passkey_status_description(access(PasskeyStatus::Denied), PASSKEYS_WAITING),
            PASSKEYS_DENIED
        );
        assert_eq!(
            passkey_status_description(
                access(PasskeyStatus::DeviceNotConfigured),
                PASSKEYS_WAITING
            ),
            PASSKEYS_NOT_CONFIGURED
        );
        assert_eq!(
            passkey_button(access(PasskeyStatus::NotDetermined)),
            Some(PASSKEYS_ALLOW)
        );
        assert_eq!(
            passkey_button(access(PasskeyStatus::Denied)),
            Some(PASSKEYS_OPEN_SETTINGS)
        );
        assert_eq!(passkey_button(access(PasskeyStatus::Authorized)), None);
        assert_eq!(passkey_button(PasskeyAccess::default()), None);
        assert_eq!(protected_video_sites().len(), 31);
    }
}
