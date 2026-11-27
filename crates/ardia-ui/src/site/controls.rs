use std::rc::Rc;

use ardia_state::omnibox::url::display_host;
use ardia_state::settings::SettingsPatch;
use ardia_state::tabs::Tab;
use ardia_state::{Action, TabId};
use ardia_theme::layout::panel;
use ardia_theme::tokens::{radius, space};
use gpui::{AnyElement, Hsla, IntoElement, ParentElement, SharedString, Styled, div, prelude::*};

use crate::msg::{FindMsg, MenuTarget, Msg};
use crate::popovers::site_controls::reader_rows;
use crate::primitives::appear::OriginX;
use crate::primitives::controls::{
    PillButton, StepperButton, TextButton, TextLook, Toggle, glass_panel, tooltip,
};
use crate::primitives::favicon::render_favicon;
use crate::primitives::icons::Icon;
use crate::primitives::tokens::{line_height, type_size};
use crate::scale::px;
use crate::settings::rows::Pane;
use crate::site::menus::SiteMenu;
use crate::site::model::{
    self, CertificateView, SecurityLevel, SecurityView, SiteAnswer, SitePanel, SiteSound,
    TranslateView,
};
use crate::site::parts::{
    self, Chip, Click, ExtensionCell, HIDDEN_ELEMENTS_WIDTH, PanelRow, SECTION_GAP, SECTION_TOP,
    SETTING_BADGE, SETTING_HEIGHT, SITE_PANEL_WIDTH, ZOOM_WIDTH, action_tile, appear_from, caution,
    chip_button, emit_click, extension_tile, grid_columns, more_button, panel_header,
    panel_separator, section_label, setting_row, site_tokens, tile_grid, tile_row, well,
};
use crate::site::prompts::PromptPlace;
use crate::site::{Expanded, PageSurface, SiteMsg, SiteUi, page_surface_left};
use crate::window::chrome::Chrome;

pub struct ConnectionLook {
    pub chip: &'static str,
    pub icon: &'static str,
    pub color: Option<Hsla>,
}

pub fn connection_look(level: SecurityLevel, destructive: Hsla) -> ConnectionLook {
    match level {
        SecurityLevel::Secure => ConnectionLook {
            chip: "Secure",
            icon: "lock.fill",
            color: None,
        },
        SecurityLevel::Local | SecurityLevel::None => ConnectionLook {
            chip: "Local Page",
            icon: "info.circle",
            color: None,
        },
        SecurityLevel::Mixed => ConnectionLook {
            chip: "Not Fully Secure",
            icon: "lock.open.trianglebadge.exclamationmark.fill",
            color: Some(caution()),
        },
        SecurityLevel::Insecure | SecurityLevel::CertificateError => ConnectionLook {
            chip: "Not Secure",
            icon: "lock.open.trianglebadge.exclamationmark.fill",
            color: Some(destructive),
        },
    }
}

pub fn connection_copy(security: Option<&SecurityView>) -> (&'static str, Option<String>) {
    let level = security.map_or(SecurityLevel::None, |s| s.level);
    let secure = level == SecurityLevel::Secure;
    let local = matches!(level, SecurityLevel::Local | SecurityLevel::None);
    let title = if secure {
        "Connection is secure"
    } else if local {
        "This is a local or internal page"
    } else {
        "Connection is not secure"
    };
    let detail = match level {
        SecurityLevel::CertificateError => Some(
            "The site's certificate isn't valid. Don't enter passwords or payment details."
                .to_owned(),
        ),
        SecurityLevel::Mixed => {
            Some("Parts of this page aren't secure (such as images).".to_owned())
        }
        SecurityLevel::Insecure => {
            Some("Don't enter sensitive information on this site.".to_owned())
        }
        SecurityLevel::Secure => security.and_then(|s| s.certificate.as_ref()).map(|cert| {
            format!(
                "Certificate issued by {}",
                cert.issuer_organizations
                    .first()
                    .filter(|o| !o.is_empty())
                    .cloned()
                    .unwrap_or_else(|| cert.issuer_common_name.clone())
            )
        }),
        _ => None,
    };
    (title, detail)
}

pub fn certificate_date(ms: f64) -> String {
    use chrono::{DateTime, Local};
    let Some(at) = DateTime::from_timestamp_millis(ms as i64) else {
        return "—".to_owned();
    };
    at.with_timezone(&Local).format("%b %-d, %Y").to_string()
}

pub fn certificate_rows(
    cert: &CertificateView,
    protocol: Option<&str>,
) -> Vec<(&'static str, String)> {
    let first = |a: &str, b: &str| {
        if a.is_empty() {
            b.to_owned()
        } else {
            a.to_owned()
        }
    };
    let mut rows = vec![
        (
            "Issued to",
            first(&cert.subject_common_name, &cert.subject_display_name),
        ),
        (
            "Organization",
            if cert.subject_organizations.is_empty() {
                "—".to_owned()
            } else {
                cert.subject_organizations.join(", ")
            },
        ),
        (
            "Issued by",
            first(&cert.issuer_common_name, &cert.issuer_display_name),
        ),
        ("Valid from", certificate_date(cert.valid_from)),
        ("Expires", certificate_date(cert.valid_until)),
    ];
    if let Some(protocol) = protocol.filter(|p| !p.is_empty()) {
        rows.push(("Protocol", protocol.to_owned()));
    }
    if let Some(sha) = cert.sha256.as_deref().filter(|s| !s.is_empty()) {
        rows.push(("SHA-256", model::certificate_fingerprint(sha)));
    }
    rows
}

fn close_then(c: &Chrome, msgs: Vec<Msg>) -> Click {
    let mut all = vec![Msg::CloseOverlays];
    all.extend(msgs);
    emit_click(c, all)
}

fn answer(tab: &TabId, answer: SiteAnswer) -> Msg {
    Msg::Site(SiteMsg::Answer(tab.clone(), answer))
}

fn connection_row(c: &Chrome, security: Option<&SecurityView>) -> AnyElement {
    let p = c.p;
    let level = security.map_or(SecurityLevel::None, |s| s.level);
    let look = connection_look(level, p.destructive);
    let (title, detail) = connection_copy(security);
    PanelRow::new("site-connection-row", title)
        .icon(look.icon)
        .icon_color(look.color.unwrap_or(p.icon))
        .detail(detail)
        .render(c)
}

fn certificate_details(c: &Chrome, security: &SecurityView) -> Option<AnyElement> {
    let cert = security.certificate.as_ref()?;
    let p = c.p;
    let rows = certificate_rows(cert, security.protocol.as_deref())
        .into_iter()
        .map(|(key, value)| {
            div()
                .flex()
                .flex_row()
                .gap(px(space::M))
                .child(
                    div()
                        .w(px(82.))
                        .flex_none()
                        .text_size(px(type_size::CAPTION))
                        .line_height(px(line_height::CAPTION))
                        .text_color(p.text_secondary)
                        .child(key),
                )
                .child(
                    div()
                        .flex_1()
                        .line_clamp(2)
                        .text_size(px(type_size::CAPTION))
                        .line_height(px(line_height::CAPTION))
                        .text_color(p.text)
                        .child(value),
                )
                .into_any_element()
        })
        .collect();
    Some(
        div()
            .mx(px(panel::INSET))
            .mt(px(space::XXS))
            .mb(px(space::XS))
            .child(well(
                c,
                false,
                space::XS,
                Some(site_tokens(p.dark).certificate_well),
                rows,
            ))
            .into_any_element(),
    )
}

pub fn zoom_stepper(c: &Chrome, tab: &Tab, percent: bool) -> AnyElement {
    let p = c.p;
    let hint = |command: &str| crate::keybindings::hint(c.state, command);
    let with_hint = |title: &str, command: &str| match hint(command) {
        Some(keys) => format!("{title} ({keys})"),
        None => title.to_owned(),
    };
    let step = |step: i32| {
        c.emit.click(Msg::Zoom {
            tab: tab.id.clone(),
            step,
        })
    };
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(if percent { space::XXS } else { space::XS }))
        .child(
            StepperButton::new(
                "site-zoom-out",
                Icon::Minus,
                with_hint("Zoom Out", "zoomOut"),
                p,
            )
            .on_click(step(-1)),
        )
        .when(percent, |this| {
            this.child(
                div()
                    .id("site-zoom-reset")
                    .w(px(44.))
                    .text_center()
                    .text_size(px(type_size::SMALL))
                    .text_color(if (tab.zoom - 1.0).abs() < f64::EPSILON {
                        p.text_secondary
                    } else {
                        p.text
                    })
                    .cursor_pointer()
                    .tooltip(tooltip("Reset to 100%".into(), p))
                    .on_click(step(0))
                    .child(model::zoom_percent(tab.zoom)),
            )
        })
        .child(
            StepperButton::new(
                "site-zoom-in",
                Icon::Plus,
                with_hint("Zoom In", "zoomIn"),
                p,
            )
            .on_click(step(1)),
        )
        .into_any_element()
}

fn popover_value(c: &Chrome, id: SharedString, title: &'static str, on_click: Click) -> AnyElement {
    let p = *c.p;
    let selector = id.to_string();
    div()
        .mr(px(-4.))
        .child(
            div()
                .id(gpui::ElementId::Name(id))
                .debug_selector(move || selector)
                .h(px(22.))
                .pl(px(space::M))
                .pr(px(4.))
                .rounded(px(radius::CONTROL))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(space::XS))
                .cursor_pointer()
                .hover(move |s| s.bg(p.toolbar_hover))
                .on_click(move |event, window, cx| {
                    cx.stop_propagation();
                    on_click(event, window, cx)
                })
                .child(
                    div()
                        .text_size(px(type_size::SMALL))
                        .text_color(p.text_secondary)
                        .child(title),
                )
                .child(parts::sym(
                    c,
                    "chevron.up.chevron.down",
                    9.,
                    8.,
                    p.text_secondary,
                )),
        )
        .into_any_element()
}

pub fn translate_rows(c: &Chrome, tab: &Tab, view: &TranslateView) -> Vec<AnyElement> {
    if !view.available || (view.source.is_none() && !view.translated && !view.never) {
        return Vec::new();
    }
    let mut rows = Vec::new();
    if !view.never {
        rows.push(
            PanelRow::new(
                "site-translate",
                if view.translated {
                    format!("Show Original ({})", view.source_name)
                } else {
                    format!("Translate to {}", view.target_name)
                },
            )
            .icon(if view.translated {
                "arrow.uturn.backward"
            } else {
                "translate"
            })
            .on_click(close_then(
                c,
                vec![answer(
                    &tab.id,
                    if view.translated {
                        SiteAnswer::ShowOriginal
                    } else {
                        SiteAnswer::Translate
                    },
                )],
            ))
            .render(c),
        );
        rows.push(
            PanelRow::new("site-translate-other", "Choose Another Language…")
                .icon("globe")
                .on_click(language_menu(c, &tab.id))
                .render(c),
        );
    }
    if !tab.profile_id.is_incognito() {
        let emit = c.emit.clone();
        let id = tab.id.clone();
        rows.push(
            PanelRow::new("site-never-translate", "Never Translate This Site")
                .icon("nosign")
                .accessory(
                    Toggle::new("site-never-translate-toggle", view.never, c.p)
                        .panel()
                        .on_toggle(move |on, window, cx| {
                            emit.send(answer(&id, SiteAnswer::NeverTranslate(on)), window, cx)
                        })
                        .into_any_element(),
                )
                .render(c),
        );
    }
    rows.push(panel_separator(c));
    rows
}

fn unread_rows(c: &Chrome, tab: &Tab) -> Option<AnyElement> {
    let host = ardia_state::omnibox::url::host_of(&tab.url);
    if tab.url.is_empty() || host.is_empty() || tab.profile_id.is_incognito() {
        return None;
    }
    let settings = &c.state.settings;
    let patch = |patch: SettingsPatch| {
        Msg::Store(Action::UpdateSettings {
            patch,
            from_sync: false,
        })
    };
    let emit = c.emit.clone();
    if settings.show_unread_counts {
        let hidden = settings.unread_hidden_sites.clone();
        let shown = !hidden.contains(&host);
        Some(
            PanelRow::new("site-unread", "Show Unread Count")
                .icon("app.badge")
                .accessory(
                    Toggle::new("site-unread-toggle", shown, c.p)
                        .panel()
                        .on_toggle(move |on, window, cx| {
                            let mut sites = hidden.clone();
                            sites.retain(|site| *site != host);
                            if !on {
                                sites.push(host.clone());
                            }
                            emit.send(
                                patch(SettingsPatch::new().set(
                                    "unreadHiddenSites",
                                    serde_json::to_value(sites).unwrap_or_default(),
                                )),
                                window,
                                cx,
                            )
                        })
                        .into_any_element(),
                )
                .render(c),
        )
    } else {
        Some(
            PanelRow::new("site-unread-all", "Show Unread Counts")
                .icon("app.badge")
                .detail(Some("All sites"))
                .accessory(
                    Toggle::new("site-unread-all-toggle", false, c.p)
                        .panel()
                        .on_toggle(move |on, window, cx| {
                            emit.send(
                                patch(
                                    SettingsPatch::new()
                                        .set("showUnreadCounts", serde_json::Value::Bool(on)),
                                ),
                                window,
                                cx,
                            )
                        })
                        .into_any_element(),
                )
                .render(c),
        )
    }
}

fn site_extensions(c: &Chrome, tab: &Tab, columns: usize) -> Vec<AnyElement> {
    let list = c.host.extensions(&c.window.id);
    let mut cells: Vec<AnyElement> = list
        .items
        .iter()
        .filter(|item| item.enabled)
        .map(|item| {
            let title = if item.action_title.is_empty() {
                item.name.clone()
            } else {
                item.action_title.clone()
            };
            let name = if item.pinned {
                format!("{title} (pinned)")
            } else {
                title
            };
            extension_tile(
                c,
                ExtensionCell {
                    id: format!("site-extension:{}", item.id).into(),
                    name: name.into(),
                    icon: item.icon.clone(),
                    symbol: "puzzlepiece.extension",
                    dimmed: false,
                    menu: Some(MenuTarget::Extension(item.id.clone())),
                },
                close_then(
                    c,
                    vec![Msg::Extension {
                        tab: tab.id.clone(),
                        extension: item.id.clone(),
                    }],
                ),
            )
        })
        .collect();
    cells.push(extension_tile(
        c,
        ExtensionCell {
            id: "site-extension-add".into(),
            name: "Add Extension".into(),
            icon: None,
            symbol: "plus",
            dimmed: false,
            menu: Some(MenuTarget::Site(SiteMenu::AddExtension)),
        },
        close_then(c, vec![Msg::command("addExtension")]),
    ));
    let manage = TextButton::new("site-extensions-manage", "Manage", c.p)
        .look(TextLook::Link)
        .pad(0.)
        .pad_y(0.)
        .height(crate::primitives::tokens::line_height::CAPTION)
        .text_size(ardia_theme::tokens::TypeSize::Caption)
        .on_click({
            let emit = c.emit.clone();
            move |_, window, cx| {
                emit.send(Msg::CloseOverlays, window, cx);
                ardia_telemetry::counts::count("extensions_manage_opens_from_site_controls");
                emit.send(Msg::command("manageExtensions"), window, cx);
            }
        })
        .into_any_element();
    vec![
        section_label(c, "Extensions", SECTION_TOP, SECTION_GAP, Some(manage)),
        tile_grid(columns, cells),
    ]
}

pub struct PanelPlace {
    pub left: f32,
    pub top: f32,
    pub from_right: bool,
}

pub fn site_controls_panel(
    c: &Chrome,
    ui: &SiteUi,
    tab: &Tab,
    data: &SitePanel,
    place: PanelPlace,
) -> AnyElement {
    let p = c.p;
    let url = &tab.url;
    let origin = model::site_origin(url);
    let expanded = ui.expanded_for(&tab.id);
    let settings = &c.state.settings;
    let pip = data.pip || c.host.media_pip_open(&tab.id);
    let video = data.video
        || pip
        || c.host
            .media_session(&tab.id)
            .is_some_and(|session| session.now.has_video);
    let web = model::site_origin(url).is_some();
    let engine_choice = c.host.offers_engine_choice();
    let webkit_page = engine_choice
        && ardia_state::engines::tab_engine(c.state, tab.id.as_str())
            == ardia_state::model::PageEngine::Webkit;
    let switchable = ardia_state::engines::switchable_engine(settings, url);
    let page_engine = ardia_state::engines::tab_engine(c.state, tab.id.as_str());
    let cast_tile = !video && origin.is_some();
    let mut tiles = Vec::new();
    if web {
        tiles.push(action_tile(
            c,
            "site-share",
            "square.and.arrow.up",
            "Share…",
            false,
            close_then(c, vec![Msg::Share(tab.id.clone())]),
        ));
    }
    tiles.push(action_tile(
        c,
        "site-copy",
        "link",
        "Copy Clean Link",
        false,
        close_then(c, vec![Msg::command("copyUrl")]),
    ));
    if web {
        tiles.push(action_tile(
            c,
            "site-find",
            "text.magnifyingglass",
            "Find on Page",
            false,
            close_then(c, vec![Msg::Find(FindMsg::Open)]),
        ));
    }
    if video {
        tiles.push(action_tile(
            c,
            "site-pip",
            if pip { "pip.exit" } else { "pip.enter" },
            if pip {
                "Exit Picture in Picture"
            } else {
                "Picture in Picture"
            },
            pip,
            emit_click(c, vec![Msg::Pip(tab.id.clone()), Msg::CloseOverlays]),
        ));
    } else if cast_tile {
        tiles.push(action_tile(
            c,
            "site-cast",
            "tv.and.mediabox",
            "Cast…",
            false,
            close_then(c, vec![Msg::Cast(tab.id.clone())]),
        ));
    }
    let columns = grid_columns(tiles.len());
    let mut body: Vec<AnyElement> = vec![tile_row(tiles)];
    body.extend(site_extensions(c, tab, columns));
    let sound = SiteSound {
        site_muted: ardia_state::mute::site_muted(c.state, tab),
        sound_blocked: data
            .settings
            .as_ref()
            .and_then(|s| s.get("sound"))
            .is_some_and(|s| s.value == model::SettingValue::Block),
    };
    let everywhere = settings.block_autoplay_everywhere;
    let value_of = |kind: &str| permission_value_title(kind, data, sound, everywhere);
    let capture = c.host.media_access(&tab.id);
    let featured: Vec<&'static str> = ui.featured(&tab.id, || {
        data.settings.as_ref().map(|s| {
            model::featured_permissions(
                s,
                model::InUse {
                    camera: capture.camera,
                    microphone: capture.microphone,
                    sound: ardia_state::mute::mute_state(c.state, tab).is_some()
                        || tab.live.audible,
                    autoplay: everywhere,
                },
            )
        })
    });
    if origin.is_some() {
        body.push(section_label(
            c,
            "Settings",
            SECTION_TOP,
            SECTION_GAP - (SETTING_HEIGHT - SETTING_BADGE) / 2.0,
            None,
        ));
        let blocker = data.blocker;
        let blocker_click = match blocker {
            None => None,
            Some(b) if b.enabled => Some(emit_click(
                c,
                vec![answer(&tab.id, SiteAnswer::SetBlocking(b.allowed))],
            )),
            Some(_) => Some(close_then(c, vec![Msg::SettingsAt(Pane::General)])),
        };
        body.push(setting_row(
            c,
            "site-blocker",
            "shield.lefthalf.filled",
            "Block Ads & Trackers",
            model::blocker_label(blocker, tab.live.blocked_requests),
            blocker.is_some_and(|b| b.enabled && !b.allowed),
            blocker_click,
        ));
        if let Some(plugins) = c.host.plugins() {
            body.extend(crate::plugins::site_switches::site_switch_rows(
                &plugins, &tab.id, url, p,
            ));
        }
        if engine_choice && switchable {
            let choice = crate::site::menus::EngineChoice::of(c.state, tab);
            body.push(setting_row(
                c,
                "site-engine",
                ardia_state::engines::engine_symbol(choice.page_engine),
                "Opens in",
                choice.opens_in(),
                choice.rule.is_some(),
                Some(engine_menu(c, &tab.id)),
            ));
        }
        for permission in
            model::site_permissions_for(webkit_page).filter(|p| featured.contains(&p.kind))
        {
            body.push(setting_row(
                c,
                format!("site-permission:{}", permission.kind),
                permission.badge,
                permission.title,
                value_of(permission.kind),
                model::permission_value(permission.kind, data.settings.as_ref(), sound, everywhere)
                    == Some(model::SettingValue::Allow),
                Some(permission_menu(c, tab, permission.kind)),
            ));
        }
    }
    if expanded == Expanded::Connection {
        let host = ardia_state::omnibox::url::host_of(url);
        body.push(panel_separator(c));
        body.push(panel_header(
            c,
            render_favicon(&c.favicon(tab), panel::ICON_SLOT, p),
            if host.is_empty() {
                tab.label()
            } else {
                display_host(&host)
            },
            Some(SharedString::from(tab.title.clone())),
        ));
        body.push(connection_row(c, data.security.as_ref()));
        if let Some(details) = data
            .security
            .as_ref()
            .and_then(|security| certificate_details(c, security))
        {
            body.push(details);
        }
    }
    if expanded == Expanded::More {
        body.push(panel_separator(c));
        body.push(
            PanelRow::new("site-zoom", "Zoom")
                .icon("plus.magnifyingglass")
                .accessory(zoom_stepper(c, tab, true))
                .render(c),
        );
        if origin.is_some() && !cast_tile {
            body.push(
                PanelRow::new("site-cast-row", "Cast…")
                    .icon("tv.and.mediabox")
                    .on_click(close_then(c, vec![Msg::Cast(tab.id.clone())]))
                    .render(c),
            );
        }
        if engine_choice && origin.is_some() && switchable {
            let other = ardia_state::engines::other_engine(page_engine);
            body.push(
                PanelRow::new(
                    "site-other-engine",
                    format!("Open Page in {}", ardia_state::engines::engine_name(other)),
                )
                .icon(ardia_state::engines::engine_symbol(other))
                .on_click(close_then(
                    c,
                    vec![Msg::Site(SiteMsg::TogglePageEngine(tab.id.clone()))],
                ))
                .render(c),
            );
        }
        if origin.is_some() {
            body.push(panel_separator(c));
            body.extend(reader_rows(c, tab).into_iter().skip(1));
            body.extend(translate_rows(c, tab, &data.translate));
            for permission in
                model::site_permissions_for(webkit_page).filter(|p| !featured.contains(&p.kind))
            {
                body.push(
                    PanelRow::new(format!("site-other:{}", permission.kind), permission.title)
                        .icon(permission.icon)
                        .accessory(popover_value(
                            c,
                            format!("site-other-value:{}", permission.kind).into(),
                            value_of(permission.kind),
                            permission_menu(c, tab, permission.kind),
                        ))
                        .render(c),
                );
            }
            if page_engine == ardia_state::model::PageEngine::Chromium {
                body.push(
                    PanelRow::new("site-settings", "Site Settings…")
                        .icon("slider.horizontal.3")
                        .on_click(close_then(
                            c,
                            vec![
                                Msg::Count("site_settings_opens_from_site_controls"),
                                Msg::SettingsAt(Pane::SiteSettings),
                            ],
                        ))
                        .render(c),
                );
            }
            body.push(panel_separator(c));
            body.push(
                PanelRow::new("site-clear", "Clear Cookies and Site Data…")
                    .icon("trash")
                    .detail(data.cleared.clone())
                    .on_click(emit_click(c, vec![answer(&tab.id, SiteAnswer::ClearData)]))
                    .render(c),
            );
        }
        if origin.is_some() {
            body.extend(unread_rows(c, tab));
        }
    }
    let look = connection_look(
        data.security
            .as_ref()
            .map_or(SecurityLevel::None, |s| s.level),
        p.destructive,
    );
    let connection_open = expanded == Expanded::Connection;
    body.push(
        div()
            .mx(px(space::XL))
            .mt(px(if origin.is_some() {
                space::M
            } else {
                space::XL
            }))
            .h(px(0.5))
            .bg(p.divider)
            .into_any_element(),
    );
    body.push(
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .px(px(panel::INSET))
            .pt(px(space::ML))
            .pb(px(space::L))
            .child(chip_button(
                c,
                Chip {
                    id: "site-connection",
                    icon: look.icon,
                    title: look.chip.into(),
                    color: look.color,
                    open: connection_open,
                    quiet: false,
                    tooltip: Some(
                        if connection_open {
                            "Hide Connection Details"
                        } else {
                            "Connection Details"
                        }
                        .into(),
                    ),
                },
                Some(emit_click(
                    c,
                    vec![Msg::Site(SiteMsg::Expand(Expanded::Connection))],
                )),
            ))
            .child(more_button(
                c,
                expanded == Expanded::More,
                emit_click(c, vec![Msg::Site(SiteMsg::Expand(Expanded::More))]),
            ))
            .into_any_element(),
    );
    let panel = glass_panel("site-controls", c.look.glass, panel::RADIUS, p)
        .debug_selector(|| "site-controls".into())
        .w(px(SITE_PANEL_WIDTH))
        .flex()
        .flex_col()
        .pt(px(panel::INSET))
        .text_color(p.text)
        .children(body);
    div()
        .absolute()
        .left(px(place.left))
        .top(px(place.top))
        .child(appear_from(
            gpui::ElementId::Name(format!("site-controls-in:{}", tab.id).into()),
            panel,
            origin_of(&place),
            false,
        ))
        .into_any_element()
}

fn permission_value_title(
    kind: &str,
    data: &SitePanel,
    sound: SiteSound,
    everywhere: bool,
) -> &'static str {
    if data.settings.is_none() && kind != "sound" {
        return "…";
    }
    model::choice_title(
        kind,
        model::permission_value(kind, data.settings.as_ref(), sound, everywhere)
            .unwrap_or(model::SettingValue::Ask),
    )
}

fn language_menu(c: &Chrome, tab: &TabId) -> Click {
    let emit = c.emit.clone();
    let tab = tab.clone();
    Rc::new(move |event, window, cx| {
        emit.send(Msg::CloseOverlays, window, cx);
        emit.send(
            Msg::Menu(Some((
                MenuTarget::Site(SiteMenu::Languages(tab.clone())),
                event.position(),
            ))),
            window,
            cx,
        )
    })
}

fn engine_menu(c: &Chrome, tab: &TabId) -> Click {
    let emit = c.emit.clone();
    let tab = tab.clone();
    Rc::new(move |event, window, cx| {
        emit.send(
            Msg::Menu(Some((
                MenuTarget::Site(SiteMenu::Engine(tab.clone())),
                event.position(),
            ))),
            window,
            cx,
        )
    })
}

fn permission_menu(c: &Chrome, tab: &Tab, kind: &'static str) -> Click {
    let emit = c.emit.clone();
    let tab = tab.id.clone();
    Rc::new(move |event, window, cx| {
        emit.send(
            Msg::Menu(Some((
                MenuTarget::Site(SiteMenu::Permission {
                    tab: tab.clone(),
                    kind,
                }),
                event.position(),
            ))),
            window,
            cx,
        )
    })
}

pub fn zoom_panel(c: &Chrome, ui: &SiteUi, tab: &Tab, place: PanelPlace) -> AnyElement {
    let p = c.p;
    let bar = 48.0;
    let emit_in = c.emit.clone();
    let row = div()
        .id("site-zoom-panel-row")
        .h(px(bar))
        .pl(px(panel::INSET))
        .pr(px((bar - 28.0) / 2.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::M))
        .on_hover(move |over, window, cx| {
            emit_in.send(Msg::Site(SiteMsg::ZoomHover(*over)), window, cx)
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(type_size::BODY))
                .text_color(p.text)
                .child(format!("Zoom: {}", model::zoom_percent(tab.zoom))),
        )
        .child(zoom_stepper(c, tab, false))
        .child(
            PillButton::new("site-zoom-panel-reset", "Reset", p).on_click(c.emit.click(
                Msg::Zoom {
                    tab: tab.id.clone(),
                    step: 0,
                },
            )),
        );
    let panel = glass_panel("site-zoom-panel", false, panel::RADIUS, p)
        .debug_selector(|| "site-zoom-panel".into())
        .w(px(ZOOM_WIDTH))
        .text_color(p.text)
        .child(row);
    let _ = ui;
    div()
        .absolute()
        .left(px(place.left))
        .top(px(place.top))
        .child(appear_from("site-zoom-in", panel, origin_of(&place), false))
        .into_any_element()
}

pub fn hidden_elements_panel(
    c: &Chrome,
    tab: &Tab,
    data: &SitePanel,
    place: PanelPlace,
) -> AnyElement {
    let p = c.p;
    let list = data.hidden.as_ref();
    let host = list.map(|l| l.host.clone()).unwrap_or_default();
    let elements = list.map(|l| l.elements.clone()).unwrap_or_default();
    let count = elements.len();
    let rows: Vec<AnyElement> = elements
        .iter()
        .map(|element| {
            let tip = if element.session {
                format!("{} (this private session only)", element.selector)
            } else {
                element.selector.clone()
            };
            PanelRow::new(
                format!("hidden:{}", element.filter),
                model::hidden_element_title(&element.selector),
            )
            .icon("eye.slash")
            .tooltip(tip)
            .accessory(
                PillButton::new(
                    gpui::ElementId::Name(format!("hidden-show:{}", element.filter).into()),
                    "Show",
                    p,
                )
                .on_click(c.emit.click(answer(
                    &tab.id,
                    SiteAnswer::RestoreHidden(vec![element.filter.clone()]),
                )))
                .into_any_element(),
            )
            .render(c)
        })
        .collect();
    let all: Vec<String> = elements.iter().map(|e| e.filter.clone()).collect();
    let panel = glass_panel("site-hidden-elements", c.look.glass, panel::RADIUS, p)
        .debug_selector(|| "site-hidden-elements".into())
        .w(px(HIDDEN_ELEMENTS_WIDTH))
        .flex()
        .flex_col()
        .pt(px(panel::INSET))
        .pb(px(panel::ROW_INSET))
        .text_color(p.text)
        .child(panel_header(
            c,
            render_favicon(&c.favicon(tab), panel::ICON_SLOT, p),
            if host.is_empty() {
                "Hidden Elements".to_owned()
            } else {
                format!("Hidden on {}", display_host(&host))
            },
            Some(model::hidden_subtitle(list).into()),
        ))
        .when(count > 0, |this| {
            this.child(
                div()
                    .id("hidden-elements-list")
                    .max_h(px(300.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .children(rows),
            )
        })
        .child(panel_separator(c))
        .child(
            PanelRow::new(
                "hidden-hide-another",
                if count > 0 {
                    "Hide Another Element…"
                } else {
                    "Hide an Element…"
                },
            )
            .icon("eye.slash")
            .on_click(close_then(
                c,
                vec![answer(&tab.id, SiteAnswer::HideElement)],
            ))
            .render(c),
        )
        .when(count > 1, |this| {
            this.child(
                PanelRow::new("hidden-show-all", "Show All Again")
                    .icon("eye")
                    .on_click(emit_click(
                        c,
                        vec![answer(&tab.id, SiteAnswer::RestoreHidden(all))],
                    ))
                    .render(c),
            )
        });
    div()
        .absolute()
        .left(px(place.left))
        .top(px(place.top))
        .child(appear_from(
            "site-hidden-in",
            panel,
            origin_of(&place),
            false,
        ))
        .into_any_element()
}

fn origin_of(place: &PanelPlace) -> OriginX {
    if place.from_right {
        OriginX::Right
    } else {
        OriginX::Left
    }
}

pub fn site_button_place(place: &PromptPlace, width: f32) -> PanelPlace {
    PanelPlace {
        left: place.page.x
            + page_surface_left(place.anchor, PageSurface::SiteButton, place.page.w, width),
        top: place.page.y + panel::POPOVER_MARGIN,
        from_right: place.anchor.url_left.is_some() || place.anchor.sidebar_right,
    }
}
