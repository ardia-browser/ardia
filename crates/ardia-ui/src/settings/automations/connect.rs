use ardia_state::live::LiveSourceId;
use futures::StreamExt;
use gpui::{
    AnyElement, Context, IntoElement, ParentElement, SharedString, Styled, Window, div, prelude::*,
};

use crate::primitives::controls::{ButtonKind, PushButton};
use crate::primitives::sheets::{Dialog, dialog_actions, dialog_title};
use crate::primitives::text_input::focus_input;
use crate::primitives::tokens::SheetSize;
use crate::scale::px;
use crate::settings::SettingsWindowView;

use super::live_folders::{source_icon, source_of};
use super::parts::{command, field, form_field};
use super::{ConnectProgress, DeviceCode, Field, LiveConnect, text};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectSheet {
    pub source: LiveSourceId,
    pub busy: bool,
    pub error: Option<String>,
    pub device: Option<DeviceCode>,
}

pub const GITHUB_HELP: &str = "Paste a personal access token (classic: \"repo\" and \"read:org\" scopes; fine-grained: read access to pull requests, checks and metadata).";
pub const GITHUB_OAUTH_HELP: &str = "Or sign in with your own GitHub OAuth app (Settings \u{203a} Developer settings \u{203a} OAuth Apps, with Device Flow enabled).";
pub const DEVICE_HELP: &str = "Enter this code on GitHub (it's on your clipboard), then approve Ardia. This sheet closes when you're signed in.";
pub const BITBUCKET_HELP: &str = "Create an API token (bitbucket.org \u{203a} Personal settings \u{203a} API tokens, with read access to pull requests and repositories), then enter your Atlassian account email with it. Bitbucket can't search review requests across repositories, so the folder lists your own pull requests.";
pub const NOTION_HELP: &str = "Create an internal integration at notion.so/my-integrations (read content; read user information for editor names), copy its secret, and share the pages or teamspaces you want with it (\u{2022}\u{2022}\u{2022} \u{203a} Connections).";
pub const CONFLUENCE_HELP: &str = "Create an API token at id.atlassian.com \u{203a} Security \u{203a} API tokens, then enter your Confluence Cloud site and account email.";
pub const GOOGLE_HELP: &str = "In Google Cloud Console, enable the Drive API and create an OAuth client of type \"Desktop app\" (add yourself as a test user). Ardia opens Google's consent page in a tab and reads the result from its redirect; it asks only to see your files' names and dates.";

pub fn fields_of(source: LiveSourceId) -> &'static [(Field, &'static str, &'static str, bool)] {
    match source {
        LiveSourceId::Github => &[
            (Field::Token, "Personal access token", "ghp_\u{2026}", true),
            (
                Field::ClientId,
                "OAuth app client ID",
                "Iv1.\u{2026}",
                false,
            ),
        ],
        LiveSourceId::Bitbucket => &[
            (Field::User, "Email or username", "you@example.com", false),
            (Field::Token, "API token", "", true),
        ],
        LiveSourceId::Notion => &[(
            Field::Token,
            "Internal integration secret",
            "ntn_\u{2026}",
            true,
        )],
        LiveSourceId::Confluence => &[
            (
                Field::Site,
                "Site",
                "https://your-team.atlassian.net",
                false,
            ),
            (Field::User, "Email", "you@example.com", false),
            (Field::Token, "API token", "", true),
        ],
        LiveSourceId::Gdrive => &[
            (
                Field::ClientId,
                "Client ID",
                "\u{2026}apps.googleusercontent.com",
                false,
            ),
            (Field::Secret, "Client secret", "", true),
        ],
    }
}

fn required(source: LiveSourceId) -> &'static [Field] {
    match source {
        LiveSourceId::Github | LiveSourceId::Notion => &[Field::Token],
        LiveSourceId::Bitbucket => &[Field::User, Field::Token],
        LiveSourceId::Confluence => &[Field::Site, Field::User, Field::Token],
        LiveSourceId::Gdrive => &[Field::ClientId, Field::Secret],
    }
}

pub fn ready(source: LiveSourceId, value: impl Fn(Field) -> String) -> bool {
    required(source)
        .iter()
        .all(|f| !value(*f).trim().is_empty())
}

pub fn open(
    view: &mut SettingsWindowView,
    key: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(source) = source_of(key) else {
        return;
    };
    let config = view
        .host
        .live()
        .map(|l| l.config.clone())
        .unwrap_or_default();
    let initial = |field: Field| match (source, field) {
        (LiveSourceId::Github, Field::ClientId) => config.github_client_id.clone(),
        (LiveSourceId::Bitbucket, Field::User) => config.bitbucket_user.clone(),
        (LiveSourceId::Confluence, Field::Site) => config.confluence_site.clone(),
        (LiveSourceId::Confluence, Field::User) => config.confluence_email.clone(),
        (LiveSourceId::Gdrive, Field::ClientId) => config.google_client_id.clone(),
        _ => String::new(),
    };
    for (field, _, placeholder, secure) in fields_of(source) {
        let value = initial(*field);
        view.automations.fields.get(*field).update(cx, |input, cx| {
            input.set_secure(*secure, cx);
            input.set_placeholder(*placeholder, cx);
            input.set_text(value, false, cx);
        });
    }
    view.automations.connect_sheet = Some(ConnectSheet {
        source,
        busy: false,
        error: None,
        device: None,
    });
    view.menu = None;
    let first = view.automations.fields.get(fields_of(source)[0].0).clone();
    cx.defer_in(window, move |_, window, cx| focus_input(&first, window, cx));
}

fn request_for(
    view: &SettingsWindowView,
    sheet: &ConnectSheet,
    cx: &gpui::App,
) -> Option<LiveConnect> {
    let value = |field| text(view, field, cx);
    if !ready(sheet.source, value) {
        return None;
    }
    Some(match sheet.source {
        LiveSourceId::Gdrive => LiveConnect::Google {
            window: view.state.main_window_for(None).cloned()?,
            client_id: value(Field::ClientId).trim().to_owned(),
            secret: value(Field::Secret).trim().to_owned(),
        },
        source => LiveConnect::Token {
            source,
            token: value(Field::Token),
            user: matches!(source, LiveSourceId::Bitbucket | LiveSourceId::Confluence)
                .then(|| value(Field::User)),
            site: (source == LiveSourceId::Confluence).then(|| value(Field::Site)),
        },
    })
}

fn start(
    view: &mut SettingsWindowView,
    request: LiveConnect,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(sheet) = view.automations.connect_sheet.as_mut() else {
        return;
    };
    sheet.busy = true;
    sheet.error = None;
    let source = sheet.source;
    let mut progress = view.host.live_connect(request);
    cx.spawn_in(window, async move |this, cx| {
        while let Some(step) = progress.next().await {
            let finished = matches!(step, ConnectProgress::Done(_));
            let alive = this.update(cx, |view, cx| {
                apply(view, source, step, cx);
                cx.notify();
            });
            if alive.is_err() || finished {
                break;
            }
        }
    })
    .detach();
}

pub fn apply(
    view: &mut SettingsWindowView,
    source: LiveSourceId,
    step: ConnectProgress,
    cx: &mut gpui::App,
) {
    let Some(sheet) = view
        .automations
        .connect_sheet
        .as_mut()
        .filter(|sheet| sheet.source == source)
    else {
        return;
    };
    match step {
        ConnectProgress::Code(code) => {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(code.user_code.clone()));
            sheet.device = Some(code);
        }
        ConnectProgress::Done(Ok(())) => view.automations.connect_sheet = None,
        ConnectProgress::Done(Err(error)) => {
            sheet.busy = false;
            sheet.device = None;
            sheet.error = Some(error);
        }
    }
}

pub fn go(
    view: &mut SettingsWindowView,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(sheet) = view.automations.connect_sheet.clone() else {
        return;
    };
    if sheet.busy {
        return;
    }
    if sheet.source == LiveSourceId::Gdrive && view.state.main_window_for(None).is_none() {
        if let Some(sheet) = view.automations.connect_sheet.as_mut() {
            sheet.error = Some("Open a browser window first".into());
        }
        return;
    }
    if let Some(request) = request_for(view, &sheet, cx) {
        start(view, request, window, cx);
    }
}

pub fn device_go(
    view: &mut SettingsWindowView,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(sheet) = view.automations.connect_sheet.clone() else {
        return;
    };
    let client_id = text(view, Field::ClientId, cx).trim().to_owned();
    if sheet.busy || client_id.is_empty() {
        return;
    }
    start(view, LiveConnect::GithubDevice { client_id }, window, cx);
}

pub fn device_cancel(view: &mut SettingsWindowView, cx: &mut Context<SettingsWindowView>) {
    view.host.cancel_live_connect();
    if let Some(sheet) = view.automations.connect_sheet.as_mut() {
        sheet.device = None;
        sheet.busy = false;
    }
    cx.notify();
}

pub fn device_open(view: &mut SettingsWindowView, cx: &mut Context<SettingsWindowView>) {
    let Some(uri) = view
        .automations
        .connect_sheet
        .as_ref()
        .and_then(|s| s.device.as_ref())
        .map(|d| d.verification_uri.clone())
    else {
        return;
    };
    if let Some(window) = view.state.main_window_for(None).cloned() {
        view.host.dispatch(ardia_state::Action::NewTab {
            window,
            tab: ardia_state::NewTab {
                url: Some(uri),
                ..ardia_state::NewTab::default()
            },
        });
    }
    cx.notify();
}

pub fn submit(
    view: &mut SettingsWindowView,
    field: Field,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(sheet) = view.automations.connect_sheet.clone() else {
        return;
    };
    let submits = match sheet.source {
        LiveSourceId::Github => field == Field::Token,
        LiveSourceId::Gdrive => false,
        _ => field == Field::Token,
    };
    if submits && !sheet.busy {
        go(view, window, cx);
    }
}

fn help(view: &SettingsWindowView, text: &'static str) -> AnyElement {
    div()
        .text_size(px(12.))
        .line_height(px(17.))
        .text_color(view.look.p.text_secondary)
        .child(text)
        .into_any_element()
}

fn button(
    view: &SettingsWindowView,
    id: &'static str,
    label: &'static str,
    primary: bool,
    disabled: bool,
    verb: &'static str,
) -> AnyElement {
    let p = view.look.p;
    div()
        .debug_selector(move || id.into())
        .child(
            PushButton::new(id, label, &p)
                .kind(if primary {
                    ButtonKind::Primary
                } else {
                    ButtonKind::Plain
                })
                .disabled(disabled)
                .on_click(view.emit.click(command(verb, ""))),
        )
        .into_any_element()
}

fn fields(view: &SettingsWindowView, source: LiveSourceId, which: &[Field]) -> Vec<AnyElement> {
    fields_of(source)
        .iter()
        .filter(|(field, ..)| which.contains(field))
        .map(|(field, label, ..)| form_field(view, label, field_of(view, *field)))
        .collect()
}

fn field_of(view: &SettingsWindowView, which: Field) -> AnyElement {
    let selector = match which {
        Field::Token => "connect-token",
        Field::User => "connect-user",
        Field::Site => "connect-site",
        Field::ClientId => "connect-client-id",
        Field::Secret => "connect-secret",
        Field::TestLink | Field::RuleApp | Field::RuleText => "connect-field",
    };
    field(view, view.automations.fields.get(which), selector)
}

fn body(view: &SettingsWindowView, sheet: &ConnectSheet, cx: &gpui::App) -> Vec<AnyElement> {
    let p = view.look.p;
    let value = |field| text(view, field, cx);
    let filled = ready(sheet.source, value);
    let checking = if sheet.busy {
        "Checking\u{2026}"
    } else {
        "Connect"
    };
    let actions = |primary: AnyElement| {
        dialog_actions(
            None,
            None,
            [
                button(
                    view,
                    "connect-cancel",
                    "Cancel",
                    false,
                    false,
                    "connectCancel",
                ),
                primary,
            ],
            &p,
        )
        .into_any_element()
    };
    match sheet.source {
        LiveSourceId::Github => {
            if let Some(device) = &sheet.device {
                return vec![
                    help(view, DEVICE_HELP),
                    div()
                        .debug_selector(|| "device-code".into())
                        .mt(px(16.))
                        .text_center()
                        .font_family("Menlo")
                        .text_size(px(22.))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .child(SharedString::from(device.user_code.clone()))
                        .into_any_element(),
                    dialog_actions(
                        None,
                        None,
                        [
                            button(
                                view,
                                "device-cancel",
                                "Cancel",
                                false,
                                false,
                                "deviceCancel",
                            ),
                            button(
                                view,
                                "device-open",
                                "Open GitHub",
                                true,
                                false,
                                "deviceOpen",
                            ),
                        ],
                        &p,
                    )
                    .into_any_element(),
                ];
            }
            let mut out = vec![help(view, GITHUB_HELP)];
            out.extend(fields(view, sheet.source, &[Field::Token]));
            out.push(actions(button(
                view,
                "connect-go",
                checking,
                true,
                !filled || sheet.busy,
                "connectGo",
            )));
            out.push(div().my(px(16.)).h(px(1.)).bg(p.divider).into_any_element());
            out.push(help(view, GITHUB_OAUTH_HELP));
            out.extend(fields(view, sheet.source, &[Field::ClientId]));
            let has_client = !value(Field::ClientId).trim().is_empty();
            out.push(
                dialog_actions(
                    None,
                    None,
                    [button(
                        view,
                        "device-go",
                        "Sign In with GitHub\u{2026}",
                        false,
                        !has_client || sheet.busy,
                        "deviceGo",
                    )],
                    &p,
                )
                .into_any_element(),
            );
            out
        }
        LiveSourceId::Gdrive => {
            let mut out = vec![help(view, GOOGLE_HELP)];
            out.extend(fields(
                view,
                sheet.source,
                &[Field::ClientId, Field::Secret],
            ));
            out.push(actions(button(
                view,
                "connect-go",
                if sheet.busy {
                    "Waiting for Google\u{2026}"
                } else {
                    "Sign In with Google\u{2026}"
                },
                true,
                !filled || sheet.busy,
                "connectGo",
            )));
            out
        }
        source => {
            let text = match source {
                LiveSourceId::Bitbucket => BITBUCKET_HELP,
                LiveSourceId::Notion => NOTION_HELP,
                _ => CONFLUENCE_HELP,
            };
            let mut out = vec![help(view, text)];
            out.extend(fields(
                view,
                source,
                &[Field::Site, Field::User, Field::Token],
            ));
            out.push(actions(button(
                view,
                "connect-go",
                checking,
                true,
                !filled || sheet.busy,
                "connectGo",
            )));
            out
        }
    }
}

pub fn sheet(view: &SettingsWindowView, sheet: &ConnectSheet, cx: &gpui::App) -> AnyElement {
    let p = view.look.p;
    let cancel = view.emit.clone();
    Dialog::sheet("connect-sheet", SheetSize::L, &p)
        .on_dismiss(move |window, cx| cancel.send(command("connectCancel", ""), window, cx))
        .child(dialog_title(
            format!("Connect {}", sheet.source.name()),
            None,
            Some(source_icon(view, sheet.source, 20.)),
            &p,
        ))
        .child(
            div()
                .mt(px(12.))
                .flex()
                .flex_col()
                .children(body(view, sheet, cx)),
        )
        .when_some(sheet.error.clone(), |this, error| {
            this.child(
                div()
                    .debug_selector(|| "connect-error".into())
                    .mt(px(10.))
                    .text_size(px(11.))
                    .text_color(p.destructive)
                    .child(error),
            )
        })
        .into_any_element()
}
