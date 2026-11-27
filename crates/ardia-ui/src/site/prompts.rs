use std::rc::Rc;

use ardia_engine::PermissionResult;
use ardia_state::TabId;
use ardia_state::tabs::Tab;
use ardia_theme::layout::panel;
use ardia_theme::tokens::{popover_width, space};
use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*,
};

use crate::icon_picker::symbols::SymbolWeight;
use crate::msg::Msg;
use crate::primitives::controls::{TextButton, TextLook, spinner};
use crate::primitives::tokens::{line_height, type_size};
use crate::scale::px;
use crate::site::model::{
    self, AutofillAsk, BlockedPopupItem, DeviceAsk, EngineOfferAsk, ExternalAppAsk, PasswordAsk,
    PermissionAsk, PopupsAnswer, SiteAnswer, SitePage, VerificationAsk,
};
use crate::site::parts::{
    self, BLOCKED_POPUPS_WIDTH, Click, DEVICE_CHOOSER_WIDTH, ENGINE_OFFER_WIDTH,
    EXTERNAL_APP_WIDTH, PERMISSION_WIDTH, PanelRow, PromptBody, UNAVAILABLE_OPACITY, appear,
    check_row, panel_separator, pill, prompt_body, prompt_popover, sym, sym_weight, well,
};
use crate::site::{PageAnchor, PageSurface, SiteMsg, SiteUi, page_surface_left};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub struct PromptPlace {
    pub page: Rect,
    pub anchor: PageAnchor,
    pub new_tab_shown: bool,
}

impl PromptPlace {
    fn at(&self, surface: PageSurface, width: f32) -> (f32, f32) {
        (
            self.page.x + page_surface_left(self.anchor, surface, self.page.w, width),
            self.page.y + panel::POPOVER_MARGIN,
        )
    }

    fn right(&self, width: f32) -> (f32, f32) {
        (
            self.page.right() - width - panel::POPOVER_MARGIN,
            self.page.y + panel::POPOVER_MARGIN,
        )
    }
}

fn guarded(c: &Chrome, key: &str, then: Vec<Msg>) -> Click {
    parts::emit_click(
        c,
        vec![Msg::Site(SiteMsg::Guarded {
            key: key.to_owned(),
            then,
        })],
    )
}

fn answer(tab: &TabId, answer: SiteAnswer) -> Msg {
    Msg::Site(SiteMsg::Answer(tab.clone(), answer))
}

fn placed(id: &'static str, key: String, at: (f32, f32), body: AnyElement) -> AnyElement {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .absolute()
        .left(px(at.0))
        .top(px(at.1))
        .child(appear(gpui::ElementId::Name(key.into()), body, false))
        .into_any_element()
}

pub fn permission_key(ask: &PermissionAsk) -> String {
    format!("permission:{}", ask.id)
}

pub fn permission_prompt(
    c: &Chrome,
    ui: &SiteUi,
    place: &PromptPlace,
    ask: &PermissionAsk,
) -> AnyElement {
    let key = permission_key(ask);
    ui.note_visible(&key);
    let copy = model::describe_permission(ask);
    let resolve = |result: PermissionResult| Msg::Permission {
        request: ask.id.clone(),
        result,
        remember: result != PermissionResult::Dismiss,
    };
    let body = prompt_body(
        c,
        PromptBody {
            icons: copy.icons,
            image: None,
            title: copy.question.into(),
            message: Some("Click the lock to change this any time".into()),
            detail: Vec::new(),
            buttons: vec![
                pill(
                    c,
                    "prompt-block",
                    "Don't Allow",
                    false,
                    guarded(c, &key, vec![resolve(PermissionResult::Deny)]),
                ),
                pill(
                    c,
                    "prompt-allow",
                    "Allow",
                    true,
                    guarded(c, &key, vec![resolve(PermissionResult::Accept)]),
                ),
            ],
        },
    );
    let popover = prompt_popover(
        c,
        "permission-prompt",
        PERMISSION_WIDTH,
        body,
        Some(guarded(c, &key, vec![resolve(PermissionResult::Dismiss)])),
    );
    placed(
        "site-permission-prompt",
        key,
        place.at(PageSurface::Prompt, PERMISSION_WIDTH),
        popover.into_any_element(),
    )
}

pub fn password_prompt(
    c: &Chrome,
    ui: &SiteUi,
    place: &PromptPlace,
    tab: &TabId,
    ask: &PasswordAsk,
) -> AnyElement {
    let p = c.p;
    let key = format!("password:{}", ask.key());
    ui.note_visible(&key);
    let username = ui
        .chosen_username(&ask.key())
        .map(str::to_owned)
        .unwrap_or_else(|| ask.username.clone());
    let resolve = |action: &str| Msg::Password {
        tab: tab.clone(),
        action: action.to_owned(),
        username: Some(username.clone()),
    };
    let choices = model::password_choices(ask);
    let detail = if !choices.is_empty() {
        well(
            c,
            true,
            0.0,
            None,
            choices
                .iter()
                .enumerate()
                .map(|(index, name)| {
                    let selected = *name == username;
                    PanelRow::new(
                        format!("password-choice:{index}"),
                        if name.is_empty() {
                            "No username".to_owned()
                        } else {
                            name.clone()
                        },
                    )
                    .on_surface()
                    .leading(if selected {
                        sym_weight(c, "checkmark", 10., 14., SymbolWeight::Semibold, p.text)
                    } else {
                        div().size(px(14.)).into_any_element()
                    })
                    .on_click(parts::emit_click(
                        c,
                        vec![Msg::Site(SiteMsg::ChooseUsername {
                            key: ask.key(),
                            name: name.clone(),
                        })],
                    ))
                    .render(c)
                })
                .collect(),
        )
    } else {
        let mut lines = vec![
            div()
                .truncate()
                .text_size(px(type_size::SMALL))
                .line_height(px(line_height::SMALL))
                .font_weight(FontWeight::MEDIUM)
                .text_color(p.text)
                .child(model::password_username_line(ask, &username))
                .into_any_element(),
        ];
        if ask.password_length > 0 {
            lines.push(
                div()
                    .truncate()
                    .text_size(px(type_size::SMALL))
                    .line_height(px(line_height::SMALL))
                    .text_color(p.text_secondary)
                    .child(model::password_dots(ask.password_length))
                    .into_any_element(),
            );
        }
        well(c, false, space::XS, None, lines)
    };
    let mut buttons = Vec::new();
    if !ask.update {
        buttons.push(pill(
            c,
            "password-never",
            "Never on This Site",
            false,
            guarded(c, &key, vec![resolve("never")]),
        ));
    }
    buttons.push(pill(
        c,
        "password-not-now",
        "Not Now",
        false,
        guarded(
            c,
            &key,
            vec![resolve(if ask.update { "nope" } else { "dismiss" })],
        ),
    ));
    buttons.push(pill(
        c,
        "password-save",
        if ask.update { "Update" } else { "Save" },
        true,
        guarded(
            c,
            &key,
            vec![resolve(if ask.update { "update" } else { "save" })],
        ),
    ));
    let width = if ask.update {
        popover_width::S
    } else {
        popover_width::M
    };
    let body = prompt_body(
        c,
        PromptBody {
            icons: vec!["key.fill"],
            image: None,
            title: model::password_title(ask).into(),
            message: Some(model::password_message(ask).into()),
            detail: vec![detail],
            buttons,
        },
    );
    let popover = prompt_popover(
        c,
        "password-prompt",
        width,
        body,
        Some(guarded(c, &key, vec![resolve("dismiss")])),
    );
    placed(
        "site-password-prompt",
        key,
        place.right(width),
        popover.into_any_element(),
    )
}

pub fn autofill_prompt(
    c: &Chrome,
    ui: &SiteUi,
    place: &PromptPlace,
    tab: &TabId,
    ask: &AutofillAsk,
) -> AnyElement {
    let p = c.p;
    let key = format!("autofill:{}", ask.id);
    ui.note_visible(&key);
    let resolve = |action: &str| Msg::Autofill {
        tab: tab.clone(),
        prompt: ask.id,
        action: action.to_owned(),
    };
    let sections: Vec<AnyElement> = model::autofill_sections(ask)
        .into_iter()
        .map(|section| {
            let labelled = section.label.is_some();
            div()
                .flex()
                .flex_col()
                .gap(px(space::XS))
                .when_some(section.label, |this, label| {
                    this.child(
                        div()
                            .text_size(px(type_size::CAPTION))
                            .line_height(px(line_height::CAPTION))
                            .text_color(p.text_secondary)
                            .child(label),
                    )
                })
                .children(section.lines.into_iter().enumerate().map(|(index, line)| {
                    let first = index == 0;
                    div()
                        .line_clamp(2)
                        .text_size(px(type_size::SMALL))
                        .line_height(px(line_height::SMALL))
                        .font_weight(if first && !labelled {
                            FontWeight::MEDIUM
                        } else {
                            FontWeight::NORMAL
                        })
                        .text_color(if first || labelled {
                            p.text
                        } else {
                            p.text_secondary
                        })
                        .child(line)
                }))
                .into_any_element()
        })
        .collect();
    let mut detail = vec![well(c, false, space::M, None, sections)];
    if let Some(footer) = ask.footer.clone().filter(|f| !f.is_empty()) {
        detail.push(
            div()
                .text_size(px(type_size::CAPTION))
                .line_height(px(line_height::CAPTION))
                .text_color(p.text_secondary)
                .child(footer)
                .into_any_element(),
        );
    }
    let body = prompt_body(
        c,
        PromptBody {
            icons: vec![model::autofill_icon(ask)],
            image: None,
            title: ask.title.clone().into(),
            message: (!ask.message.is_empty()).then(|| ask.message.clone().into()),
            detail,
            buttons: vec![
                pill(
                    c,
                    "autofill-skip",
                    ask.decline.clone(),
                    false,
                    guarded(c, &key, vec![resolve("decline")]),
                ),
                pill(
                    c,
                    "autofill-fill",
                    ask.accept.clone(),
                    true,
                    guarded(c, &key, vec![resolve("accept")]),
                ),
            ],
        },
    );
    let popover = prompt_popover(
        c,
        "autofill-prompt",
        popover_width::M,
        body,
        Some(guarded(c, &key, vec![resolve("dismiss")])),
    );
    placed(
        "site-autofill-prompt",
        key,
        place.right(popover_width::M),
        popover.into_any_element(),
    )
}

pub fn verification_prompt(
    c: &Chrome,
    ui: &SiteUi,
    place: &PromptPlace,
    tab: &TabId,
    ask: &VerificationAsk,
) -> AnyElement {
    let key = format!("verification:{}", ask.token);
    ui.note_visible(&key);
    let (title, message) = model::verification_copy(&ask.app, &ask.host);
    let close = guarded(
        c,
        &key,
        vec![answer(tab, SiteAnswer::Verification { accept: false })],
    );
    let body = prompt_body(
        c,
        PromptBody {
            icons: vec!["key.fill"],
            image: None,
            title: title.into(),
            message: Some(message.into()),
            detail: Vec::new(),
            buttons: vec![
                pill(c, "verification-not-now", "Not Now", false, close.clone()),
                pill(
                    c,
                    "verification-set-up",
                    "Set Up",
                    true,
                    guarded(
                        c,
                        &key,
                        vec![answer(tab, SiteAnswer::Verification { accept: true })],
                    ),
                ),
            ],
        },
    );
    let popover = prompt_popover(
        c,
        "verification-prompt",
        popover_width::S,
        body,
        Some(close),
    );
    placed(
        "site-verification-prompt",
        key,
        place.right(popover_width::S),
        popover.into_any_element(),
    )
}

pub fn external_app_prompt(
    c: &Chrome,
    ui: &SiteUi,
    place: &PromptPlace,
    tab: &TabId,
    ask: &ExternalAppAsk,
) -> AnyElement {
    let key = format!("external:{}", ask.id);
    ui.note_visible(&key);
    let always = ui.external_always(&ask.id);
    let resolve = |open: bool| {
        answer(
            tab,
            SiteAnswer::ExternalApp {
                open,
                remember: open && always,
            },
        )
    };
    let detail = ask
        .remember
        .clone()
        .map(|label| {
            let emit = c.emit.clone();
            let id = ask.id.clone();
            check_row(
                c,
                "external-app-remember",
                always,
                label,
                Rc::new(move |on, window, cx| {
                    emit.send(
                        Msg::Site(SiteMsg::ExternalAlways { id: id.clone(), on }),
                        window,
                        cx,
                    )
                }),
            )
        })
        .into_iter()
        .collect();
    let body = prompt_body(
        c,
        PromptBody {
            icons: if ask.icon.is_some() {
                Vec::new()
            } else {
                vec!["app"]
            },
            image: ask.icon.clone(),
            title: ask.title.clone().into(),
            message: ask.message.clone().map(SharedString::from),
            detail,
            buttons: vec![
                pill(
                    c,
                    "external-app-cancel",
                    "Cancel",
                    false,
                    guarded(c, &key, vec![resolve(false)]),
                ),
                pill(
                    c,
                    "external-app-open",
                    "Open",
                    true,
                    guarded(c, &key, vec![resolve(true)]),
                ),
            ],
        },
    );
    let popover = prompt_popover(
        c,
        "external-app-prompt",
        EXTERNAL_APP_WIDTH,
        body,
        Some(guarded(c, &key, vec![resolve(false)])),
    );
    placed(
        "site-external-app-prompt",
        key,
        place.at(PageSurface::Prompt, EXTERNAL_APP_WIDTH),
        popover.into_any_element(),
    )
}

pub fn engine_offer_prompt(
    c: &Chrome,
    ui: &SiteUi,
    place: &PromptPlace,
    tab: &TabId,
    offer: &EngineOfferAsk,
) -> AnyElement {
    let key = format!("engine:{}", offer.site);
    let remember = ui.offer_remember;
    let detail = offer
        .can_remember
        .then(|| {
            let emit = c.emit.clone();
            check_row(
                c,
                "engine-offer-remember",
                remember,
                "Don't ask again for this site",
                Rc::new(move |on, window, cx| {
                    emit.send(Msg::Site(SiteMsg::OfferRemember(on)), window, cx)
                }),
            )
        })
        .into_iter()
        .collect();
    let body = prompt_body(
        c,
        PromptBody {
            icons: vec!["play.circle.fill", "safari"],
            image: None,
            title: format!("Play {} in WebKit?", offer.host).into(),
            message: Some(
                "This site's protected video doesn't play in Chromium. It plays in WebKit.".into(),
            ),
            detail,
            buttons: vec![
                pill(
                    c,
                    "engine-offer-stay",
                    "Stay on Page",
                    false,
                    parts::emit_click(
                        c,
                        vec![answer(
                            tab,
                            SiteAnswer::EngineOffer {
                                accept: false,
                                remember,
                            },
                        )],
                    ),
                ),
                pill(
                    c,
                    "engine-offer-open",
                    "Open in WebKit",
                    true,
                    parts::emit_click(
                        c,
                        vec![answer(
                            tab,
                            SiteAnswer::EngineOffer {
                                accept: true,
                                remember: false,
                            },
                        )],
                    ),
                ),
            ],
        },
    );
    let popover = prompt_popover(
        c,
        "engine-offer-prompt",
        ENGINE_OFFER_WIDTH,
        body,
        Some(parts::emit_click(
            c,
            vec![answer(
                tab,
                SiteAnswer::EngineOffer {
                    accept: false,
                    remember: false,
                },
            )],
        )),
    );
    placed(
        "site-engine-offer-prompt",
        key,
        place.at(PageSurface::Prompt, ENGINE_OFFER_WIDTH),
        popover.into_any_element(),
    )
}

pub fn blocked_popups_prompt(
    c: &Chrome,
    place: &PromptPlace,
    tab: &TabId,
    popups: &[BlockedPopupItem],
) -> Option<AnyElement> {
    let first = popups.first()?;
    let p = c.p;
    let site = model::host_or_origin(&first.origin);
    let popup =
        |which: PopupsAnswer| parts::emit_click(c, vec![answer(tab, SiteAnswer::Popups(which))]);
    let body = prompt_body(
        c,
        PromptBody {
            icons: vec!["macwindow.badge.plus"],
            image: None,
            title: format!("Always allow pop-ups from {site}?").into(),
            message: Some(
                format!(
                    "Allow {site} to always open pop-up windows, choose every time, or always deny pop-ups."
                )
                .into(),
            ),
            detail: Vec::new(),
            buttons: vec![
                pill(c, "popups-deny", "Always Deny", false, popup(PopupsAnswer::AlwaysDeny)),
                pill(c, "popups-once", "Only Once", false, popup(PopupsAnswer::OnlyOnce)),
                pill(c, "popups-allow", "Always Allow", true, popup(PopupsAnswer::AlwaysAllow)),
            ],
        },
    );
    let start = popups.len().saturating_sub(5);
    let rows: Vec<AnyElement> = popups[start..]
        .iter()
        .map(|item| {
            PanelRow::new(format!("popup:{}", item.id), model::popup_title(&item.url))
                .on_surface()
                .icon("arrow.up.forward.app")
                .on_click(parts::emit_click(
                    c,
                    vec![answer(tab, SiteAnswer::OpenPopup(item.id.clone()))],
                ))
                .render(c)
        })
        .collect();
    let more = (popups.len() > 5).then(|| {
        div()
            .pl(px(panel::TEXT_COLUMN))
            .pt(px(space::XXS))
            .text_size(px(type_size::CAPTION))
            .line_height(px(line_height::CAPTION))
            .text_color(p.text_secondary)
            .child(format!("and {} more", popups.len() - 5))
            .into_any_element()
    });
    let content = div()
        .pb(px(panel::LIST_PADDING))
        .child(body)
        .child(panel_separator(c))
        .children(rows)
        .children(more)
        .into_any_element();
    let popover = prompt_popover(c, "blocked-popups", BLOCKED_POPUPS_WIDTH, content, None);
    Some(placed(
        "site-blocked-popups",
        format!("popups:{}", first.id),
        place.at(PageSurface::SiteButton, BLOCKED_POPUPS_WIDTH),
        popover.into_any_element(),
    ))
}

fn signal(c: &Chrome, level: i32) -> AnyElement {
    let bar = 2.5;
    div()
        .h(px(11.))
        .flex()
        .flex_row()
        .items_end()
        .gap(px(space::XXS))
        .children((0..4).map(|i| {
            div()
                .w(px(bar))
                .h(px(3.0 + i as f32 * bar))
                .rounded(px(bar / 2.0))
                .bg(c.p.icon)
                .opacity(if i < level { 1.0 } else { 0.25 })
        }))
        .into_any_element()
}

fn notice(
    c: &Chrome,
    icon: &'static str,
    text: &'static str,
    link: Option<(&'static str, Msg)>,
) -> AnyElement {
    let p = c.p;
    div()
        .flex()
        .flex_row()
        .gap(px(space::M))
        .py(px(space::S))
        .child(sym(c, icon, 13., 18., p.text_secondary))
        .child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .gap(px(space::XS))
                .child(
                    div()
                        .text_size(px(type_size::SMALL))
                        .line_height(px(line_height::SMALL))
                        .text_color(p.text_secondary)
                        .child(text),
                )
                .when_some(link, |this, (title, msg)| {
                    this.child(
                        TextButton::new("device-notice-link", title, p)
                            .look(TextLook::Link)
                            .on_click(c.emit.click(msg)),
                    )
                }),
        )
        .into_any_element()
}

pub fn device_chooser(
    c: &Chrome,
    ui: &SiteUi,
    place: &PromptPlace,
    tab: &TabId,
    chooser: &DeviceAsk,
) -> AnyElement {
    let p = c.p;
    let key = format!("device:{}", chooser.id);
    ui.note_visible(&key);
    let selected = ui.device_selected(chooser.id);
    let scanning = chooser.both_buttons_enabled;
    let blocked = chooser.adapter_off || chooser.unauthorized;
    let valid = scanning || selected.is_some_and(|i| i < chooser.options.len());
    let choose = |index: Option<usize>| -> Vec<Msg> {
        if scanning {
            return vec![answer(
                tab,
                SiteAnswer::ChooseDevice {
                    chooser: chooser.id,
                    index: -1,
                },
            )];
        }
        index
            .map(|index| {
                vec![answer(
                    tab,
                    SiteAnswer::ChooseDevice {
                        chooser: chooser.id,
                        index: index as i32,
                    },
                )]
            })
            .unwrap_or_default()
    };
    let cancel = answer(tab, SiteAnswer::CancelDevice(chooser.id));
    let detail: Vec<AnyElement> = if chooser.unauthorized {
        vec![notice(
            c,
            "lock",
            "Ardia needs access to Bluetooth to find devices.",
            Some((
                "Open Bluetooth Settings",
                answer(tab, SiteAnswer::BluetoothSettings(chooser.id)),
            )),
        )]
    } else if chooser.adapter_off {
        vec![notice(
            c,
            "antenna.radiowaves.left.and.right.slash",
            "Bluetooth is turned off. Turn it on to find devices.",
            None,
        )]
    } else if scanning {
        Vec::new()
    } else {
        let rows: Vec<AnyElement> = chooser
            .options
            .iter()
            .enumerate()
            .map(|(index, option)| {
                let is_selected = selected == Some(index);
                let detail = if option.connected {
                    Some("Connected")
                } else if option.paired {
                    Some("Paired")
                } else {
                    None
                };
                let mut row = PanelRow::new(format!("device:{index}"), option.name.clone())
                    .on_surface()
                    .selected(is_selected)
                    .on_click(parts::emit_click(
                        c,
                        vec![Msg::Site(SiteMsg::SelectDevice {
                            chooser: chooser.id,
                            index,
                        })],
                    ))
                    .on_double_click(guarded(c, &key, choose(Some(index))));
                if chooser.show_signal {
                    row = row.leading(signal(c, option.signal));
                }
                if let Some(detail) = detail {
                    row = row.accessory(
                        div()
                            .text_size(px(type_size::CAPTION))
                            .text_color(p.text_secondary)
                            .child(detail)
                            .into_any_element(),
                    );
                }
                if is_selected {
                    row = row.accessory(sym_weight(
                        c,
                        "checkmark",
                        11.,
                        16.,
                        SymbolWeight::Semibold,
                        p.accent,
                    ));
                }
                row.render(c)
            })
            .collect();
        let status = if chooser.refreshing {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(space::M))
                .min_h(px(22.))
                .child(spinner(14., p.text_secondary))
                .child(
                    div()
                        .text_size(px(type_size::SMALL))
                        .text_color(p.text_secondary)
                        .child(chooser.scanning_text.clone()),
                )
        } else {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(space::M))
                .min_h(px(22.))
                .when(chooser.options.is_empty(), |this| {
                    this.child(
                        div()
                            .text_size(px(type_size::SMALL))
                            .text_color(p.text_secondary)
                            .child(chooser.no_options_text.clone()),
                    )
                })
                .when(chooser.can_refresh, |this| {
                    this.child(
                        div().debug_selector(|| "device-rescan".into()).child(
                            TextButton::new("device-rescan", "Scan Again", p)
                                .look(TextLook::Link)
                                .on_click(
                                    c.emit
                                        .click(answer(tab, SiteAnswer::RescanDevices(chooser.id))),
                                ),
                        ),
                    )
                })
        };
        vec![
            div()
                .id("device-options")
                .max_h(px(200.))
                .mx(px(-panel::INSET))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(space::XXS))
                .children(rows)
                .into_any_element(),
            status.into_any_element(),
        ]
    };
    let enabled = valid && !blocked;
    let connect = div()
        .when(!enabled, |this| this.opacity(UNAVAILABLE_OPACITY))
        .child(pill(
            c,
            "device-connect",
            if chooser.ok_label.is_empty() {
                "Connect".to_owned()
            } else {
                chooser.ok_label.clone()
            },
            true,
            if enabled {
                guarded(c, &key, choose(selected))
            } else {
                parts::click(|_, _, _| {})
            },
        ))
        .into_any_element();
    let body = prompt_body(
        c,
        PromptBody {
            icons: vec![if chooser.show_signal || scanning {
                "dot.radiowaves.left.and.right"
            } else {
                "cable.connector"
            }],
            image: None,
            title: chooser.title.clone().into(),
            message: None,
            detail,
            buttons: vec![
                pill(
                    c,
                    "device-cancel",
                    if chooser.cancel_label.is_empty() {
                        "Cancel".to_owned()
                    } else {
                        chooser.cancel_label.clone()
                    },
                    false,
                    parts::emit_click(c, vec![cancel.clone()]),
                ),
                connect,
            ],
        },
    );
    let escape = c.emit.clone();
    let enter = c.emit.clone();
    let enter_msgs = if enabled {
        vec![Msg::Site(SiteMsg::Guarded {
            key: key.clone(),
            then: choose(selected),
        })]
    } else {
        Vec::new()
    };
    let popover = prompt_popover(c, "device-chooser", DEVICE_CHOOSER_WIDTH, body, None)
        .on_key_down(
            move |event, window, cx| match event.keystroke.key.as_str() {
                "escape" => {
                    cx.stop_propagation();
                    escape.send(cancel.clone(), window, cx)
                }
                "enter" => {
                    cx.stop_propagation();
                    for msg in enter_msgs.iter().cloned() {
                        enter.send(msg, window, cx)
                    }
                }
                _ => {}
            },
        );
    placed(
        "site-device-chooser",
        key,
        place.at(PageSurface::Prompt, DEVICE_CHOOSER_WIDTH),
        popover.into_any_element(),
    )
}

pub fn page_prompts(
    c: &Chrome,
    ui: &SiteUi,
    place: &PromptPlace,
    tab: &Tab,
    page: &SitePage,
) -> Option<AnyElement> {
    let mut layers: Vec<AnyElement> = Vec::new();
    if !place.new_tab_shown
        && let Some(ask) = &page.permission
    {
        layers.push(permission_prompt(c, ui, place, ask));
    }
    if let Some(ask) = &page.password {
        layers.push(password_prompt(c, ui, place, &tab.id, ask));
    }
    if let Some(ask) = &page.autofill {
        layers.push(autofill_prompt(c, ui, place, &tab.id, ask));
    }
    if let Some(ask) = &page.verification {
        layers.push(verification_prompt(c, ui, place, &tab.id, ask));
    }
    if !place.new_tab_shown {
        if let Some(ask) = &page.external_app {
            layers.push(external_app_prompt(c, ui, place, &tab.id, ask));
        }
        if let Some(offer) = &page.engine_offer {
            layers.push(engine_offer_prompt(c, ui, place, &tab.id, offer));
        }
        if let Some(chooser) = &page.device {
            layers.push(device_chooser(c, ui, place, &tab.id, chooser));
        }
    }
    if layers.is_empty() {
        return None;
    }
    Some(
        div()
            .id("site-prompts")
            .debug_selector(|| "site-prompts".into())
            .absolute()
            .size_full()
            .children(layers)
            .into_any_element(),
    )
}
